struct VertexInput {
    @builtin(vertex_index) vertexIndex: u32,
    @builtin(instance_index) instanceIndex: u32,
};

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) @interpolate(perspective, center) color: vec4f,
};

struct DynamicUniformBlock {
    projection: mat4x4f,
    view: mat4x4f,
    minDistance: f32,
};

struct StaticUniformBlock {
    minDistance: f32,
    cardinalColor: vec3f,
    evenColor: vec3f,
    rLink: f32,
    maxNodeIndex: f32,
};

// Uniform bindings
@group(0) @binding(0) var<uniform> dynamicUniform: DynamicUniformBlock;
@group(0) @binding(1) var<uniform> staticUniform: StaticUniformBlock;

// Storage bindings
@group(1) @binding(0) var<storage> particlePositions: array<f32>;
@group(1) @binding(1) var<storage> linkIndices: array<u32>;

fn getPosition(index: u32) -> vec3f {

    let x = particlePositions[index * 3 + 0];
    let y = particlePositions[index * 3 + 1];
    let z = particlePositions[index * 3 + 2];

    return vec3f(x, y, z);
}

@vertex
fn vMain(vsInput: VertexInput) -> VertexOutput {

    let aindex = linkIndices[0 + vsInput.instanceIndex * 2];
    let bIndex = linkIndices[1 + vsInput.instanceIndex * 2];

    let aPos = getPosition(aindex);
    let bPos = getPosition(bIndex);
    let nodePos = normalize(mix(aPos, bPos, f32(vsInput.vertexIndex) / staticUniform.maxNodeIndex)) * staticUniform.rLink;

    // let color = vec4f(mix(staticUniform.cardinalColor, staticUniform.evenColor, f32(vsInput.vertexIndex) / staticUniform.maxNodeIndex), 1.0) * (1.0 - distance(aPos, bPos) / staticUniform.minDistance);
    let color = vec4f(mix(staticUniform.cardinalColor, staticUniform.evenColor, f32(vsInput.vertexIndex) / staticUniform.maxNodeIndex), (1.0 - distance(aPos, bPos) / staticUniform.minDistance));

    var output: VertexOutput;
    output.position = dynamicUniform.projection * dynamicUniform.view * vec4f(nodePos, 1.0);
    output.color = color;
    return output;
}

@fragment
fn fMain(fsInput: VertexOutput) -> @location(0) vec4f {

    // return vec4f(vec3f(1.0), fsInput.color.w);
    if (fsInput.color.a < 0.01) {
        discard;
    }
    return vec4f(fsInput.color.rgb * fsInput.color.a, 1.0);
    // return fsInput.color;
    // return vec4f(1.0);
}