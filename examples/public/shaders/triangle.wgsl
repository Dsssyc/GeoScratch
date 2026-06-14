struct VertexInput {
    @builtin(vertex_index) vertexIndex: u32,
    @location(0) position: vec2f,
    @location(1) color: vec3f,
    @location(2) size: f32,
}

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) @interpolate(perspective, center) color: vec3f,
}

@vertex
fn vMain(in: VertexInput) -> VertexOutput {
    
    var out: VertexOutput;
    out.position = vec4f(in.position * in.size, 0.0, 1.0);
    out.color = in.color;
    return out;
}

@fragment
fn fMain(in: VertexOutput) -> @location(0) vec4f {

    return vec4f(in.color, 1.0);
}