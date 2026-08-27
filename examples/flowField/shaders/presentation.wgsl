@group(0) @binding(0) var historyTexture: texture_2d<f32>;

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) @interpolate(perspective, center) texcoords: vec2f,
};

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
    let dimensions = vec2i(textureDimensions(historyTexture, 0));
    let pixel = clamp(
        vec2i(vec2f(dimensions) * input.texcoords),
        vec2i(0),
        dimensions - vec2i(1)
    );
    return textureLoad(historyTexture, pixel, 0);
}
