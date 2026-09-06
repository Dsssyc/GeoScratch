struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) @interpolate(perspective, center) texcoords: vec2f,
};

struct FlowFieldHistoryUniform {
    trailDecay: f32,
    trailCutoff: f32,
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
    cameraX: vec2u,
    cameraY: vec2u,
    cameraZ: vec2f,
    requestedLevel: u32,
    progress: f32,
    activityKill: f32,
    presentationFeather: f32,
};

struct HistoryProjection {
    uv: vec2f,
    valid: f32,
};

@group(0) @binding(0) var<uniform> cleanupUniform: FlowFieldHistoryUniform;
@group(2) @binding(0) var historyTexture: texture_2d<f32>;

fn correctedPixel(pixel: vec2f, dim: vec2f) -> vec2f {
    return clamp(pixel, vec2f(0.0), dim - vec2f(1.0));
}

fn linearSampling(source: texture_2d<f32>, pixel: vec2f, dim: vec2f) -> vec4f {
    let topLeft = textureLoad(source, vec2i(correctedPixel(pixel, dim)), 0);
    let topRight = textureLoad(source, vec2i(correctedPixel(pixel + vec2f(1.0, 0.0), dim)), 0);
    let bottomLeft = textureLoad(source, vec2i(correctedPixel(pixel + vec2f(0.0, 1.0), dim)), 0);
    let bottomRight = textureLoad(source, vec2i(correctedPixel(pixel + vec2f(1.0, 1.0), dim)), 0);
    let top = mix(topLeft, topRight, fract(pixel.x));
    let bottom = mix(bottomLeft, bottomRight, fract(pixel.x));
    return mix(top, bottom, fract(pixel.y));
}

fn invalidHistoryProjection() -> HistoryProjection {
    var output: HistoryProjection;
    output.uv = vec2f(0.0);
    output.valid = 0.0;
    return output;
}

fn reprojectHistoryUv(texcoords: vec2f) -> HistoryProjection {
    if (any(cleanupUniform.previousViewport <= vec2f(0.0)) ||
        any(cleanupUniform.currentViewport <= vec2f(0.0))) {
        return invalidHistoryProjection();
    }
    let ndc = vec2f(texcoords.x * 2.0 - 1.0, (1.0 - texcoords.y) * 2.0 - 1.0);
    let nearClip = vec4f(ndc, 0.0, 1.0);
    let farClip = vec4f(ndc, 1.0, 1.0);
    let nearRelativeH = cleanupUniform.currentInverseMatrix * nearClip;
    let farRelativeH = cleanupUniform.currentInverseMatrix * farClip;
    if (abs(nearRelativeH.w) < 0.000001 || abs(farRelativeH.w) < 0.000001) {
        return invalidHistoryProjection();
    }
    let nearRelative = nearRelativeH.xyz / nearRelativeH.w;
    let farRelative = farRelativeH.xyz / farRelativeH.w;
    let ray = farRelative - nearRelative;
    if (abs(ray.z) < 0.000001) {
        return invalidHistoryProjection();
    }
    let groundRelativeZ = -(cleanupUniform.cameraZ.x + cleanupUniform.cameraZ.y);
    let planeT = (groundRelativeZ - nearRelative.z) / ray.z;
    if (planeT < 0.0 || planeT > 1.0) {
        return invalidHistoryProjection();
    }
    let currentRelative = nearRelative + ray * planeT;
    let centerDelta = (cleanupUniform.currentCenterHigh - cleanupUniform.previousCenterHigh) +
        (cleanupUniform.currentCenterLow - cleanupUniform.previousCenterLow);
    let previousRelative = vec4f(
        currentRelative + centerDelta,
        1.0
    );
    let previousClip = cleanupUniform.previousMatrix * previousRelative;
    if (previousClip.w <= 0.0 ||
        abs(previousClip.x) > previousClip.w ||
        abs(previousClip.y) > previousClip.w ||
        previousClip.z < 0.0 || previousClip.z > previousClip.w) {
        return invalidHistoryProjection();
    }
    let previousNdc = previousClip.xy / previousClip.w;
    var output: HistoryProjection;
    output.uv = vec2f(
        previousNdc.x * 0.5 + 0.5,
        1.0 - (previousNdc.y * 0.5 + 0.5)
    );
    output.valid = 1.0;
    return output;
}

@vertex
fn vMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
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
    var output: VertexOutput;
    output.position = vec4f(vertices[vertexIndex], 0.0, 1.0);
    output.texcoords = vec2f(uvs[vertexIndex].x, 1.0 - uvs[vertexIndex].y);
    return output;
}

@fragment
fn fMain(input: VertexOutput) -> @location(0) vec4f {
    let dim = vec2f(textureDimensions(historyTexture, 0));
    let pixel = vec2i(correctedPixel(dim * input.texcoords, dim));
    var color = textureLoad(historyTexture, pixel, 0);
    var historyUv = input.texcoords;
    if (cleanupUniform.historyMode > 1.5 && cleanupUniform.historyReprojecting > 0.5) {
        if (cleanupUniform.historyValid < 0.5) {
            return vec4f(0.0);
        }
        let projection = reprojectHistoryUv(historyUv);
        if (projection.valid < 0.5) {
            return vec4f(0.0);
        }
        historyUv = projection.uv;
        let historyPixel = clamp(historyUv * dim - vec2f(0.5), vec2f(0.0), dim - vec2f(1.0));
        color = linearSampling(historyTexture, historyPixel, dim);
    }
    let faded = floor(255.0 * color * cleanupUniform.trailDecay) / 255.0;
    let residual = max(max(faded.r, faded.g), faded.b);
    if (residual <= cleanupUniform.trailCutoff) {
        return vec4f(0.0);
    }
    // Only visible retained ink needs current-flow validation. Sampling the
    // temporal raster for every empty physical pixel can halve visual ticks.
    // Keep the check in current screen space, after any history reprojection.
    if (!FlowHistory_supported(input.texcoords)) { return vec4f(0.0); }
    return faded;
}
