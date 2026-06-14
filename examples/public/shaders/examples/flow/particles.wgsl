struct VertexInput {
    @builtin(vertex_index) vertexIndex: u32,
    @builtin(instance_index) instanceIndex: u32,
};

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
    @location(1) hide: f32,
    @location(2) coords: vec2f,
    @location(3) velocity: vec2f,
};

struct StaticUniformBlock {
    groupSize: vec2u,
    extent: vec4f,
}

struct DynamicUniformBlock {
    far: f32,
    near: f32,
    uMatrix: mat4x4f,
    centerLow: vec3f,
    centerHigh: vec3f,
};

struct FrameUniformBlock {
    randomSeed: f32,
    viewPort: vec2f,
    mapBounds: vec4f,
    zoomLevel: f32,
    progressRate: f32,
    maxSpeed: f32,
};

// Uniform bindings
@group(0) @binding(0) var<uniform> frameUniform: FrameUniformBlock;
@group(0) @binding(1) var<uniform> staticUniform: StaticUniformBlock;
@group(0) @binding(2) var<uniform> dynamicUniform: DynamicUniformBlock;

// Storage bindings
@group(1) @binding(0) var<storage> particles: array<f32>;

const PI = 3.141592653;

fn calcWebMercatorCoord(coord: vec2f) -> vec2f {

    let lon = (180.0 + coord.x) / 360.0;
    let lat = (180.0 - (180.0 / PI * log(tan(PI / 4.0 + coord.y * PI / 360.0)))) / 360.0;
    return vec2f(lon, lat);
}

fn translateRelativeToEye(high: vec3f, low: vec3f) -> vec3f {

    let highDiff = high - dynamicUniform.centerHigh;
    let lowDiff = low - dynamicUniform.centerLow;

    return highDiff + lowDiff;
}

fn currentExtent() -> vec4f {

    let lonMin = max(staticUniform.extent.x, frameUniform.mapBounds.x);
    let latMin = max(staticUniform.extent.y, frameUniform.mapBounds.y);
    let lonMax = min(staticUniform.extent.z, frameUniform.mapBounds.z);
    let latMax = min(staticUniform.extent.w, frameUniform.mapBounds.w);
    return vec4f(lonMin, latMin, lonMax, latMax);
}

fn colorFromInt(color: u32) -> vec3f {
    
    let b = f32(color & 0xFF) / 255.0;
    let g = f32((color >> 8) & 0xFF) / 255.0;
    let r = f32((color >> 16) & 0xFF) / 255.0;

    return vec3f(r, g, b);
}

fn velocityColor(speed: f32, rampColors: array<u32, 8>) -> vec3f {
    
    // let bottomIndex = floor(speed * 10.0);
    // let topIndex = mix(bottomIndex + 1.0, 7.0, step(6.0, bottomIndex));
    // let interval = mix(1.0, 4.0, step(6.0, bottomIndex));
    let bottomIndex = floor(speed * 8.0);
    let topIndex = ceil(speed * 8.0);
    let interval = speed * 8.0 - bottomIndex;

    let slowColor = colorFromInt(rampColors[u32(bottomIndex)]);
    let fastColor = colorFromInt(rampColors[u32(topIndex)]);

    // return mix(slowColor, fastColor, (speed * 10.0 - f32(bottomIndex)) / interval);
    return mix(slowColor, fastColor, interval);
}

@vertex
fn vMain(input: VertexInput) -> VertexOutput {

    let vertices = array<vec2f, 4>(
        vec2f(-1.0, -1.0),
        vec2f(-1.0, 1.0),
        vec2f(1.0, -1.0),
        vec2f(1.0, 1.0)
    );

    let currentPosition = vec2f(
        particles[input.instanceIndex * 6 + 0],
        particles[input.instanceIndex * 6 + 1],
    );

    let lastPosition = vec2f(
        particles[input.instanceIndex * 6 + 2],
        particles[input.instanceIndex * 6 + 3],
    );

    let position = select(currentPosition, lastPosition, input.vertexIndex % 2 == 0);

    let cExtent = currentExtent();
    // let x = mix(cExtent.x, cExtent.z, position.x);
    // let y = mix(cExtent.y, cExtent.w, position.y);
    // let mercatorPos = calcWebMercatorCoord(vec2f(x, y));
    let mercatorPos = calcWebMercatorCoord(position.xy);

    let position_CS = dynamicUniform.uMatrix * vec4f(translateRelativeToEye(vec3f(mercatorPos, 0.0), vec3f(0.0, 0.0, 0.0)), 1.0);
    let position_SS = position_CS.xy / position_CS.w;
    let uv = (position_SS + 1.0) / 2.0;
    let offset = vertices[input.vertexIndex];
    let vertexPos_SS = position_SS + 1.0 * offset * 2.0 / frameUniform.viewPort;
    let vertexPos_CS = vertexPos_SS * position_CS.w;

    var output: VertexOutput;
    // output.position = vec4f(vertexPos_CS, 0.0, position_CS.w);
    output.position = position_CS;
    // output.position = vec4f((position * 2.0 - 1.0) * 0.5, 0.0, 1.0);
    output.uv = vec2f(uv.x, 1.0 - uv.y);
    output.hide = select(0.0, 1.0, cExtent.z <= cExtent.x || cExtent.w <= cExtent.y);
    output.coords = offset;
    output.velocity = vec2f(particles[input.instanceIndex * 6 + 4], particles[input.instanceIndex * 6 + 5]);
    return output;
}

@fragment
fn fMain(input: VertexOutput) -> @location(0) vec4f {

    let rampColors0 = array<u32, 8>(
        0x3288bd,
        0x66c2a5,
        0xabdda4,
        0xe6f598,
        0xfee08b,
        0xfdae61,
        0xf46d43,
        0xd53e4f
    );

    let velocity = input.velocity;
    // if (input.hide == 1.0 || (velocity.x == 0.0 && velocity.y == 0.0) || length(input.coords) > 1.0) {
    if (input.hide == 1.0 || length(velocity) == 0.0) {
        discard;
    }

    let color = velocityColor(length(velocity) / frameUniform.maxSpeed, rampColors0);
    // return vec4f(color, 0.0, 1.0);
    return vec4f(color, 0.5);
    // return vec4f(0.5);
}