struct VertexInput {
    @builtin(vertex_index) vertexIndex: u32,
    @location(0) position: vec2f,
}

struct VertexOutput {
    @builtin(position) position: vec4f,
}

struct DynamicUniformBlock {
    uMatrix: mat4x4f,
}

// Uniform Binding
@group(0) @binding(0) var<uniform> dynamicUniform: DynamicUniformBlock;

@vertex
fn vMain(input: VertexInput) -> VertexOutput {

    // let pos = (dynamicUniform.uMatrix * vec3f(input.position, 1.)).xy;

    var output: VertexOutput;
    output.position = dynamicUniform.uMatrix * vec4f(input.position, 0.0, 1.0);

    return output;
}

@fragment
fn fMain() -> @location(0) vec4f {

    return vec4f(128., 218., 197., 255.) / 255.;
}