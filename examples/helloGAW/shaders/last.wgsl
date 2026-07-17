struct VertexInput {
    @builtin(vertex_index) vertexIndex: u32,
};

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) @interpolate(perspective, center) texcoords: vec2f,
};

struct StaticUniformBlock {
    gamma: f32,
    density: f32,
}

// Uniform bindings
@group(0) @binding(0) var<uniform> staticUniform: StaticUniformBlock;

// Texture bindings
@group(1) @binding(0) var lsampler: sampler;
@group(1) @binding(1) var sceneTexture: texture_2d<f32>;

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

@fragment
fn fMain(fsInput: VertexOutput) -> @location(0) vec4f {

    let color = textureSample(sceneTexture, lsampler, fsInput.texcoords);

    let dim = vec2f(textureDimensions(sceneTexture, 0).xy);
    let frequency = dim / staticUniform.density;
    let stripe = sin(fsInput.texcoords.y * frequency.y * 3.14159265 * 2.0) * cos(fsInput.texcoords.x * frequency.x * 3.14159265 * 2.0);
    let brightness = 0.5 + 0.5 * stripe;
    
    return vec4f(gammaCorrect(toneMapACES(color.rgb * brightness), staticUniform.gamma), color.a);
    // return vec4f(toneMapACES(color.rgb), color.a);
}