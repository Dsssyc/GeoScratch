struct VertexInput {
    @builtin(vertex_index) vertexIndex: u32,
};

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) @interpolate(perspective, center) texcoords: vec2f,
};

struct CleanupUniformBlock {
    trailDecay: f32,
    trailCutoff: f32,
    useFlowMask: f32,
    historyMode: f32,
    historyValid: f32,
    historyReprojecting: f32,
    previousMatrix: mat4x4f,
    currentMatrix: mat4x4f,
    currentInverseMatrix: mat4x4f,
    previousCenterHigh: vec3f,
    previousCenterLow: vec3f,
    currentCenterHigh: vec3f,
    currentCenterLow: vec3f,
    previousViewport: vec2f,
    currentViewport: vec2f,
};

struct HistoryProjection {
    uv: vec2f,
    valid: f32,
};

// Uniform bindings
@group(0) @binding(0) var<uniform> cleanupUniform: CleanupUniformBlock;

// Texture bindings
@group(1) @binding(0) var bgTexture: texture_2d<f32>;
@group(1) @binding(1) var maskTexture: texture_2d<f32>;

fn toneMapACES(color: vec3f) -> vec3f {
    let a = 2.51;
    let b = 0.03;
    let c = 2.43;
    let d = 0.59;
    let e = 0.14;

    return clamp((color * (a * color + b)) / (color * (c * color + d) + e), vec3f(0.0), vec3f(1.0));
}

fn gammaCorrect(color: vec3f, gamma: f32) -> vec3f {
    return pow(color, vec3f(1.0 / gamma));
}

fn uvCorrection(uv: vec2f, dim: vec2f) -> vec2f {

    return clamp(uv, vec2f(0.0), dim - vec2f(1.0));
}

fn linearSampling(texture: texture_2d<f32>, uv: vec2f, dim: vec2f) -> vec4f {

    let tl = textureLoad(texture, vec2i(uv), 0);
    let tr = textureLoad(texture, vec2i(uvCorrection(uv + vec2f(1.0, 0.0), dim).xy), 0);
    let bl = textureLoad(texture, vec2i(uvCorrection(uv + vec2f(0.0, 1.0), dim).xy), 0);
    let br = textureLoad(texture, vec2i(uvCorrection(uv + vec2f(1.0, 1.0), dim).xy), 0);

    let mix_x = fract(uv.x);
    let mix_y = fract(uv.y);
    let top = mix(tl, tr, mix_x);
    let bottom = mix(bl, br, mix_x);
    return mix(top, bottom, mix_y);
}

fn invalidHistoryProjection() -> HistoryProjection {

    var output: HistoryProjection;
    output.uv = vec2f(0.0);
    output.valid = 0.0;
    return output;
}

fn reprojectHistoryUv(texcoords: vec2f) -> HistoryProjection {

    let ndc = vec2f(texcoords.x * 2.0 - 1.0, (1.0 - texcoords.y) * 2.0 - 1.0);
    let nearClip = vec4f(ndc, 0.0, 1.0);
    let farClip = vec4f(ndc, 1.0, 1.0);

    let nearRelativeH = cleanupUniform.currentInverseMatrix * nearClip;
    let farRelativeH = cleanupUniform.currentInverseMatrix * farClip;
    if (abs(nearRelativeH.w) < 0.000001 || abs(farRelativeH.w) < 0.000001) {
        return invalidHistoryProjection();
    }

    let nearWorld = nearRelativeH.xyz / nearRelativeH.w + cleanupUniform.currentCenterHigh + cleanupUniform.currentCenterLow;
    let farWorld = farRelativeH.xyz / farRelativeH.w + cleanupUniform.currentCenterHigh + cleanupUniform.currentCenterLow;
    let ray = farWorld - nearWorld;
    if (abs(ray.z) < 0.000001) {
        return invalidHistoryProjection();
    }

    let planeT = -nearWorld.z / ray.z;
    if (planeT < 0.0 || planeT > 1.0) {
        return invalidHistoryProjection();
    }

    let world = nearWorld + ray * planeT;
    let previousRelative = vec4f(world - cleanupUniform.previousCenterHigh - cleanupUniform.previousCenterLow, 1.0);
    let previousClip = cleanupUniform.previousMatrix * previousRelative;
    if (
        previousClip.w <= 0.0 ||
        abs(previousClip.x) > previousClip.w ||
        abs(previousClip.y) > previousClip.w ||
        previousClip.z < 0.0 || previousClip.z > previousClip.w
    ) {
        return invalidHistoryProjection();
    }

    let previousNdc = previousClip.xy / previousClip.w;

    var output: HistoryProjection;
    output.uv = vec2f(previousNdc.x * 0.5 + 0.5, 1.0 - (previousNdc.y * 0.5 + 0.5));
    output.valid = 1.0;
    return output;
}

@vertex
fn vMain(vsInput: VertexInput) -> VertexOutput {

    let vertices = array<vec2f, 4>(
        vec2f(-1.0, -1.0),
        vec2f(-1.0, 1.0),
        vec2f(1.0, -1.0),
        vec2f(1.0, 1.0)
    );

    let uvs = array<vec2f, 4>(
        vec2f(0.0, 0.0),
        vec2f(0.0, 1.0),
        vec2f(1.0, 0.0),
        vec2f(1.0, 1.0)
    );

    let position = vertices[vsInput.vertexIndex];
    let uv = uvs[vsInput.vertexIndex];

    var output: VertexOutput;
    output.position = vec4f(position, 0.0, 1.0);
    output.texcoords = vec2f(uv.x, 1.0 - uv.y);
    return output;
}

@fragment
fn fMain(fsInput: VertexOutput) -> @location(0) vec4f {

    let dim = vec2f(textureDimensions(bgTexture, 0).xy);
    let pixel = vec2i(clamp(dim * fsInput.texcoords.xy, vec2f(0.0), dim - vec2f(1.0)));
    let mask = textureLoad(maskTexture, pixel, 0).r;
    if (cleanupUniform.useFlowMask > 0.5 && mask < 0.5) {
        return vec4f(0.0);
    }

    var historyUv = fsInput.texcoords.xy;
    if (cleanupUniform.historyMode > 1.5 && cleanupUniform.historyReprojecting > 0.5) {
        if (cleanupUniform.historyValid < 0.5) {
            return vec4f(0.0);
        }

        let projection = reprojectHistoryUv(historyUv);
        if (projection.valid < 0.5) {
            return vec4f(0.0);
        }
        historyUv = projection.uv;
    }

    let historyPixel = clamp(historyUv * dim, vec2f(0.0), dim - vec2f(1.0));
    let color = linearSampling(bgTexture, historyPixel, dim);
    let faded = vec4f(floor(255.0 * color * cleanupUniform.trailDecay) / 255.0);
    let residual = max(max(faded.r, faded.g), faded.b);
    if (residual <= cleanupUniform.trailCutoff) {
        return vec4f(0.0);
    }
    return faded;
    // return color;
    // return vec4f(1.0);
}
