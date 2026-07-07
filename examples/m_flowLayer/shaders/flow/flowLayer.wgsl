struct VertexInput {
    @builtin(vertex_index) vertexIndex: u32,
};

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) @interpolate(perspective, center) texcoords: vec2f,
};

// Texture bindings
@group(0) @binding(0) var layerTexture: texture_2d<f32>;

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

    let dim = vec2f(textureDimensions(layerTexture, 0).xy);
    let color = textureLoad(layerTexture, vec2i(dim * fsInput.texcoords.xy), 0);
    return color;
}