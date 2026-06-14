struct VertexInput {
    @builtin(vertex_index) vertexIndex: u32,
    @location(0) position: vec3f,
    @location(1) color: vec4f,
};

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) @interpolate(perspective, center) color: vec4f,
    @location(1) @interpolate(perspective, center) uv: vec2f,
    @location(2) @interpolate(perspective, center) alpha: f32,
};

struct DynamicUniformBlock {
    projection: mat4x4f,
    view: mat4x4f,
    viewPort: vec2f,
};

struct StaticUniformBlock {
    size: f32,
};

// Uniform bindings
@group(0) @binding(0) var<uniform> dynamicUniform: DynamicUniformBlock;
@group(0) @binding(1) var<uniform> staticUniform: StaticUniformBlock;

@vertex
fn vMain(vsInput: VertexInput) -> VertexOutput {

    let box = array<vec2f, 4>(
        vec2f(-1.0, -1.0),
        vec2f(-1.0, 1.0),
        vec2f(1.0, -1.0),
        vec2f(1.0, 1.0)
    );

    let uvs = array<vec2f, 4>(
        vec2f(-1.0, -1.0),
        vec2f(-1.0, 1.0),
        vec2f(1.0, -1.0),
        vec2f(1.0, 1.0)
    );

    let position_CS = dynamicUniform.projection * dynamicUniform.view * vec4f(vsInput.position, 1.0);
    let position_SS = position_CS.xy / position_CS.w;
    let screenOffset = staticUniform.size * 2.0;
    let v_offset = screenOffset * box[vsInput.vertexIndex];
    let vertexPos_SS = position_SS + v_offset / dynamicUniform.viewPort;

    var output: VertexOutput;
    output.position = vec4f(vertexPos_SS * position_CS.w, position_CS.zw);
    output.color = vsInput.color;
    output.uv = uvs[vsInput.vertexIndex];
    output.alpha = position_CS.z;
    return output;
}

@fragment
fn fMain(fsInput: VertexOutput) -> @location(0) vec4f {

    var alpha = 0.8;
    if (length(fsInput.uv) > 1.0) {
        alpha = 0.0;
    }

    return vec4f(fsInput.color.xyz, alpha);
}