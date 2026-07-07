export const bloomOutputComputeShader = `
struct StaticUniformBlock {
    strength: f32,
}

// Uniform bindings
@group(0) @binding(0) var<uniform> staticUniform: StaticUniformBlock;

// Texture bindings
@group(1) @binding(0) var srcTexture: texture_2d<f32>;
@group(1) @binding(1) var blurTexture: texture_2d<f32>;
@group(1) @binding(2) var dstTexture: texture_storage_2d<rgba16float, write>;

// Constants
override blockSize: u32;

fn getColor(uv: vec2i) -> vec4f {

    let srcColor = textureLoad(srcTexture, uv, 0);
    let blurColor = textureLoad(blurTexture, uv, 0);

    // return blurColor;
    return blurColor * staticUniform.strength + srcColor;
}

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

@compute @workgroup_size(blockSize, blockSize, 1)
fn cMain(@builtin(global_invocation_id) id: vec3<u32>) {

    let color = getColor(vec2i(id.xy));

    textureStore(dstTexture, vec2i(id.xy), color);
}
`

export const downsampleComputeShader = `
// Texture bindings
@group(0) @binding(0) var srcTexture: texture_2d<f32>;
@group(0) @binding(1) var dstTexture: texture_storage_2d<rgba16float, write>;

// Constants
override blockSize: u32;

fn isOut(uv: vec2i) -> bool {

    let size = textureDimensions(srcTexture, 0);
    if (uv.x < 0 || uv.x > i32(size.x) || uv.y < 0 || uv.y > i32(size.y)) {
        return true;
    }
    return false;
}

fn uvCorrection(uv: vec2f, dim: vec2f) -> vec2f {

    return clamp(uv, vec2f(0.0), dim);
}

fn linearSampling(uv: vec2f, dim: vec2f) -> vec4f {

    let tl = textureLoad(srcTexture, vec2i(uv), 0);
    let tr = textureLoad(srcTexture, vec2i(uvCorrection(uv + vec2f(1.0, 0.0), dim).xy), 0);
    let bl = textureLoad(srcTexture, vec2i(uvCorrection(uv + vec2f(0.0, 1.0), dim).xy), 0);
    let br = textureLoad(srcTexture, vec2i(uvCorrection(uv + vec2f(1.0, 1.0), dim).xy), 0);

    let mix_x = fract(uv.x);
    let mix_y = fract(uv.y);
    let top = mix(tl, tr, mix_x);
    let bottom = mix(bl, br, mix_x);
    return mix(top, bottom, mix_y);
}

@compute @workgroup_size(blockSize, blockSize, 1)
fn cMain(@builtin(global_invocation_id) id: vec3<u32>) {

    let srcSize = vec2f(textureDimensions(srcTexture, 0).xy);
    let dstSize = vec2f(textureDimensions(dstTexture).xy);

    let uv = (vec2f(id.xy) + 0.5) / dstSize;
    let srcCoords = uv * srcSize - 0.5;

    let color = linearSampling(srcCoords, srcSize);

    textureStore(dstTexture, vec2i(id.xy), color);
}
`

export const gaussianBlurComputeShader = `
struct StaticUniformBlock {
    steps: u32,
    direction: vec2f,
}

// Uniform bindings
@group(0) @binding(0) var<uniform> staticUniform: StaticUniformBlock;

// Storage bindings
@group(1) @binding(0) var<storage> gaussianKernel: array<f32>;

// Texture bindings
@group(2) @binding(0) var highLightTexture: texture_2d<f32>;
@group(2) @binding(1) var srcTexture: texture_2d<f32>;
@group(2) @binding(2) var dstTexture: texture_storage_2d<rgba16float, write>;

// Constants
override blockSize: u32;

fn gaussian(x: f32, sigma: f32) -> f32 {

    let a = 1.0 / (sigma * sqrt(2.0 * 3.141592653));
    return a * exp(-((x * x) / (2.0 * sigma * sigma)));
}

fn uvCorrection(uv: vec2f, dim: vec2f) -> vec2f {

    return clamp(uv, vec2f(0.0), dim);
}

fn linearSampling(uv: vec2f, dim: vec2f) -> vec4f {

    let tl = textureLoad(srcTexture, vec2i(uv), 0);
    let tr = textureLoad(srcTexture, vec2i(uvCorrection(uv + vec2f(1.0, 0.0), dim).xy), 0);
    let bl = textureLoad(srcTexture, vec2i(uvCorrection(uv + vec2f(0.0, 1.0), dim).xy), 0);
    let br = textureLoad(srcTexture, vec2i(uvCorrection(uv + vec2f(1.0, 1.0), dim).xy), 0);

    let mix_x = fract(uv.x);
    let mix_y = fract(uv.y);
    let top = mix(tl, tr, mix_x);
    let bottom = mix(bl, br, mix_x);
    return mix(top, bottom, mix_y);
}

@compute @workgroup_size(blockSize, blockSize, 1)
fn cMain(@builtin(global_invocation_id) id: vec3<u32>) {

    let srcSize = vec2f(textureDimensions(srcTexture, 0).xy);
    let dstSize = vec2f(textureDimensions(dstTexture).xy);

    let uv = (vec2f(id.xy) + 0.5) / dstSize;
    let srcCoords = uv * srcSize - 0.5;

    let sigma = 1.0;
    var weightSum = gaussian(0.0, sigma);
    var blurColor = linearSampling(srcCoords, srcSize).rgb * weightSum;

    for (var i: u32 = 1; i <= staticUniform.steps; i++) {
        let weight = gaussian(f32(i), sigma);

        let sample1 = linearSampling(srcCoords + staticUniform.direction, srcSize).rgb;
        let sample2 = linearSampling(srcCoords - staticUniform.direction, srcSize).rgb;

        weightSum += 2.0 * weight;
        blurColor += (sample1 + sample2) * weight;
    }

    var output = vec3f(blurColor / weightSum);
    output += select(vec3f(0.0), textureLoad(highLightTexture, vec2i(id.xy), 0).rgb, staticUniform.direction.y == 1.0);
    textureStore(dstTexture, vec2i(id.xy), vec4f(output, 1.0));
}
`

export const gaussianBlurShader = `
struct VertexInput {
    @builtin(vertex_index) vertexIndex: u32,
};

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) @interpolate(perspective, center) texcoords: vec2f,
};

struct StaticUniformBlock {
    direction: vec2f,
    steps: u32,
    dimension: f32,
    weight: f32,
}

// Uniform bindings
@group(0) @binding(0) var<uniform> staticUniform: StaticUniformBlock;

// Storage bindings
@group(1) @binding(0) var<storage> gaussianKernel: array<f32>;

// Texture bindings
@group(2) @binding(0) var lsampler: sampler;
@group(2) @binding(1) var highlighTexture: texture_2d<f32>;
@group(2) @binding(2) var aforeTexture: texture_2d<f32>;

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
    var uv = uvs[vsInput.vertexIndex];
    uv.y = 1.0 - uv.y;

    var output: VertexOutput;
    output.position = vec4f(position, 0.0, 1.0);
    output.texcoords = uv;
    return output;
}

fn getBlur(uv: vec2f) -> vec4f {

    return  textureSample(aforeTexture, lsampler, uv) + textureSample(highlighTexture, lsampler, uv);
}

@fragment
fn fMain(fsInput: VertexOutput) -> @location(0) vec4f {

    let sigma = 1.0;
    var weightSum = gaussianKernel[0];
    let stepSize = 1.0 / staticUniform.dimension;
    var blurColor = getBlur(fsInput.texcoords).rgb * weightSum;

    for (var i: u32 = 1; i <= staticUniform.steps; i++) {
        let weight = gaussianKernel[i];
        let uvOffset = f32(i) * stepSize * staticUniform.direction;

        let sample1 = getBlur(fsInput.texcoords + uvOffset).rgb;
        let sample2 = getBlur(fsInput.texcoords - uvOffset).rgb;

        weightSum += 2.0 * weight;
        blurColor += (sample1 + sample2) * weight;
    }
    return vec4f(blurColor / weightSum, 1.0) * staticUniform.weight;
}
`

export const gaussianBlurXComputeShader = `
struct StaticUniformBlock {
    steps: u32,
}

// Uniform bindings
@group(0) @binding(0) var<uniform> staticUniform: StaticUniformBlock;

// Storage bindings
@group(1) @binding(0) var<storage> gaussianKernel: array<f32>;

// Texture bindings
@group(2) @binding(0) var highLightTexture: texture_2d<f32>;
@group(2) @binding(1) var srcTexture: texture_2d<f32>;
@group(2) @binding(2) var dstTexture: texture_storage_2d<rgba16float, write>;

// Constants
override blockSize: u32;

fn uvCorrection(uv: vec2f, dim: vec2f) -> vec2f {

    return clamp(uv, vec2f(0.0), dim);
}

fn linearSampling(uv: vec2f, dim: vec2f) -> vec4f {

    let tl = textureLoad(srcTexture, vec2i(uv), 0);
    let tr = textureLoad(srcTexture, vec2i(uvCorrection(uv + vec2f(1.0, 0.0), dim).xy), 0);
    let bl = textureLoad(srcTexture, vec2i(uvCorrection(uv + vec2f(0.0, 1.0), dim).xy), 0);
    let br = textureLoad(srcTexture, vec2i(uvCorrection(uv + vec2f(1.0, 1.0), dim).xy), 0);

    let mix_x = fract(uv.x);
    let mix_y = fract(uv.y);
    let top = mix(tl, tr, mix_x);
    let bottom = mix(bl, br, mix_x);
    return mix(top, bottom, mix_y);
}

fn srcCoording(uv: vec2i) -> vec2f {

    let srcSize = vec2f(textureDimensions(srcTexture, 0).xy);
    let dstSize = vec2f(textureDimensions(dstTexture).xy);

    let dstUV = (vec2f(uv.xy) + 0.5) / dstSize;
    return dstUV * srcSize - 0.5;
}

@compute @workgroup_size(blockSize, blockSize, 1)
fn cMain(@builtin(global_invocation_id) id: vec3<u32>) {

    let srcSize = vec2f(textureDimensions(srcTexture, 0).xy);
    let dstSize = vec2f(textureDimensions(dstTexture).xy);

    let uv = (vec2f(id.xy) + 0.5) / dstSize;
    let srcCoords = uv * srcSize - 0.5;

    var weightSum = gaussianKernel[0];
    var blurColor = linearSampling(srcCoords, srcSize).rgb * weightSum;

    for (var i: u32 = 1; i <= staticUniform.steps; i++) {
        let weight = gaussianKernel[i];

        let sample1 = linearSampling(srcCoords + vec2f(f32(i), 0.0), srcSize).rgb;
        let sample2 = linearSampling(srcCoords - vec2f(f32(i), 0.0), srcSize).rgb;

        weightSum += 2.0 * weight;
        blurColor += (sample1 + sample2) * weight;
    }

    let output = vec3f(blurColor / weightSum);
    textureStore(dstTexture, vec2i(id.xy), vec4f(output, 1.0));
}

`

export const gaussianBlurYComputeShader = `
struct StaticUniformBlock {
    steps: u32,
}

// Uniform bindings
@group(0) @binding(0) var<uniform> staticUniform: StaticUniformBlock;

// Storage bindings
@group(1) @binding(0) var<storage> gaussianKernel: array<f32>;

// Texture bindings
@group(2) @binding(0) var highLightTexture: texture_2d<f32>;
@group(2) @binding(1) var srcTexture: texture_2d<f32>;
@group(2) @binding(2) var dstTexture: texture_storage_2d<rgba16float, write>;

// Constants
override blockSize: u32;

fn uvCorrection(uv: vec2f, dim: vec2f) -> vec2f {

    return clamp(uv, vec2f(0.0), dim);
}

fn linearSampling(uv: vec2f, dim: vec2f) -> vec4f {

    let tl = textureLoad(srcTexture, vec2i(uv), 0);
    let tr = textureLoad(srcTexture, vec2i(uvCorrection(uv + vec2f(1.0, 0.0), dim).xy), 0);
    let bl = textureLoad(srcTexture, vec2i(uvCorrection(uv + vec2f(0.0, 1.0), dim).xy), 0);
    let br = textureLoad(srcTexture, vec2i(uvCorrection(uv + vec2f(1.0, 1.0), dim).xy), 0);

    let mix_x = fract(uv.x);
    let mix_y = fract(uv.y);
    let top = mix(tl, tr, mix_x);
    let bottom = mix(bl, br, mix_x);
    return mix(top, bottom, mix_y);
}

@compute @workgroup_size(blockSize, blockSize, 1)
fn cMain(@builtin(global_invocation_id) id: vec3<u32>) {

    let srcSize = vec2f(textureDimensions(srcTexture, 0).xy);
    let dstSize = vec2f(textureDimensions(dstTexture).xy);

    let uv = (vec2f(id.xy) + 0.5) / dstSize;
    let srcCoords = uv * srcSize - 0.5;

    var weightSum = gaussianKernel[0];
    var blurColor = linearSampling(srcCoords, srcSize).rgb * weightSum;

    for (var i: u32 = 1; i <= staticUniform.steps; i++) {
        let weight = gaussianKernel[i];

        let sample1 = linearSampling(srcCoords + vec2f(0.0, f32(i)), srcSize).rgb;
        let sample2 = linearSampling(srcCoords - vec2f(0.0, f32(i)), srcSize).rgb;

        weightSum += 2.0 * weight;
        blurColor += (sample1 + sample2) * weight;
    }

    let output = vec3f(blurColor / weightSum) + textureLoad(highLightTexture, vec2i(id.xy), 0).rgb;
    textureStore(dstTexture, vec2i(id.xy), vec4f(output, 1.0));
}
`

export const highlightComputeShader = `
struct StaticUniformBlock {
    threshold: f32,
};

// Uniform bindings
@group(0) @binding(0) var<uniform> staticUniform: StaticUniformBlock;

// Texture bindings
@group(1) @binding(0) var inTexture: texture_2d<f32>;
@group(1) @binding(1) var outTexture: texture_storage_2d<rgba16float, write>;

// Constants
override blockSize: u32;

fn luminace(color: vec3f) -> f32 {

    return color.r * 0.2126 + color.g * 0.7152 + color.b * 0.0722;
}

fn isOut(uv: vec2i) -> bool {

    let size = textureDimensions(inTexture, 0);
    if (uv.x < 0 || uv.x > i32(size.x) || uv.y < 0 || uv.y > i32(size.y)) {
        return true;
    }
    return false;
}

@compute @workgroup_size(blockSize, blockSize, 1)
fn cMain(@builtin(global_invocation_id) id: vec3<u32>) {

    let uv = vec2i(id.xy);
    if(isOut(uv)) {

        return;
    }

    let color = textureLoad(inTexture, uv, 0);


    let brightness = luminace(color.rgb);
    let highLight = select(vec4f(0.0, 0.0, 0.0, 1.0), color, brightness > staticUniform.threshold);

    textureStore(outTexture, uv, highLight);
    // textureStore(outTexture, uv, color);
}
`
