@group(0) @binding(0) var<uniform> cleanupUniform: FlowFieldHistoryUniform;
@group(2) @binding(0) var historyTexture: texture_2d<f32>;

struct FlowHardVertex {
    @builtin(position) position: vec4f,
    @location(0) texcoords: vec2f,
};

@vertex
fn vMain(@builtin(vertex_index) index: u32) -> FlowHardVertex {
    let positions = array<vec2f, 4>(vec2f(-1.0, -1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
    let p = positions[index];
    return FlowHardVertex(vec4f(p, 0.0, 1.0), vec2f(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5));
}

@fragment
fn fMain(input: FlowHardVertex) -> @location(0) vec4f {
    let dimensions = vec2i(textureDimensions(historyTexture, 0));
    let pixel = clamp(vec2i(vec2f(dimensions) * input.texcoords), vec2i(0), dimensions - vec2i(1));
    let color = textureLoad(historyTexture, pixel, 0);
    // Match B: no raster work for empty ink, and clip fresh segments as well as
    // old trails. The underlying history continues its bounded decay untouched.
    if (color.a == 0.0 || max(max(color.r, color.g), color.b) == 0.0) { return color; }
    if (!FlowHistory_supported(input.texcoords)) { return vec4f(0.0); }
    return color;
}
