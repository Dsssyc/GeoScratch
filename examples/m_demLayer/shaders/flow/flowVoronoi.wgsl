struct VertexInput {
    @builtin(vertex_index) vertexIndex: u32,
    @location(0) position: vec4f,
    @location(1) vFrom: vec2f,
    @location(2) vTo: vec2f,
};

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) velocity: vec2f,
    @location(1) uv: vec2f,
};

struct FrameUniformBlock {
    randomSeed: f32,
    viewPort: vec2f,
    mapBounds: vec4f,
    zoomLevel: f32,
    progressRate: f32,
    maxSpeed: f32,
};

struct StaticUniformBlock {
    groupSize: vec2u,
    extent: vec4f,
};

struct DynamicUniformBlock {
    far: f32,
    near: f32,
    uMatrix: mat4x4f,
    centerLow: vec3f,
    centerHigh: vec3f,
};

// Uniform Bindings
@group(0) @binding(0) var<uniform> frameUniform: FrameUniformBlock;
@group(0) @binding(1) var<uniform> staticUniform: StaticUniformBlock;
@group(0) @binding(2) var<uniform> dynamicUniform: DynamicUniformBlock;

const PI = 3.1415926535;

fn translateRelativeToEye(high: vec3f, low: vec3f) -> vec3f {

    let highDiff = high - dynamicUniform.centerHigh;
    let lowDiff = low - dynamicUniform.centerLow;

    return highDiff + lowDiff;
}

fn calcWebMercatorCoord(coord: vec2f) -> vec2f {

    let lon = (180.0 + coord.x) / 360.0;
    let lat = (180.0 - (180.0 / PI * log(tan(PI / 4.0 + coord.y * PI / 360.0)))) / 360.0;
    return vec2f(lon, lat);
}

@vertex
fn vMain(input: VertexInput) -> VertexOutput {

    let x = (input.position.x - staticUniform.extent[0]) / (staticUniform.extent[2] - staticUniform.extent[0]);
    let y = (input.position.y - staticUniform.extent[1]) / (staticUniform.extent[3] - staticUniform.extent[1]);

    var output: VertexOutput;
    output.position = dynamicUniform.uMatrix * vec4f(translateRelativeToEye(vec3f(input.position.xy, 0.0), vec3f(input.position.zw, 0.0)), 1.0);
    output.velocity = mix(input.vFrom, input.vTo, frameUniform.progressRate);
    return output;
}

@fragment
fn fMain(input: VertexOutput) -> @location(0) vec2f {

    // if (input.velocity.x == 0.0 &&  input.velocity.y == 0.0) {
    //     discard;
    // }
    return input.velocity;
}
