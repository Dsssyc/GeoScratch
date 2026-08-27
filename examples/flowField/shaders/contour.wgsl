struct FlowContourEndpoint {
    x: vec2u,
    y: vec2u,
};

struct FlowContourSegment {
    first: FlowContourEndpoint,
    second: FlowContourEndpoint,
};

struct FlowContourSegments {
    values: array<FlowContourSegment>,
};

struct FlowContourViewUniform {
    clipFromRelativeWorld: mat4x4f,
    cameraX: vec2u,
    cameraY: vec2u,
    cameraZ: vec2f,
    metersPerQuantum: f32,
    reserved: vec3f,
};

struct FlowContourVertexOutput {
    @builtin(position) position: vec4f,
};

@group(0) @binding(0) var<storage, read> segments: FlowContourSegments;
@group(1) @binding(0) var<uniform> contourView: FlowContourViewUniform;

fn fixedSubtract(left: vec2u, right: vec2u) -> vec2u {
    let borrow = select(0u, 1u, left.x < right.x);
    return vec2u(left.x - right.x, left.y - right.y - borrow);
}

fn fixedMagnitude(value: vec2u) -> vec2u {
    if ((value.y & 0x80000000u) == 0u) { return value; }
    let low = ~value.x + 1u;
    let carry = select(0u, 1u, low == 0u);
    return vec2u(low, ~value.y + carry);
}

fn fixedDifferenceMeters(value: vec2u, origin: vec2u) -> f32 {
    let difference = fixedSubtract(value, origin);
    let negative = (difference.y & 0x80000000u) != 0u;
    let magnitude = fixedMagnitude(difference);
    let meters = f32(magnitude.y) * ldexp(contourView.metersPerQuantum, 32) +
        f32(magnitude.x) * contourView.metersPerQuantum;
    return select(meters, -meters, negative);
}

@vertex
fn vContour(@builtin(vertex_index) vertexIndex: u32) -> FlowContourVertexOutput {
    let segment = segments.values[vertexIndex / 2u];
    var endpoint = segment.first;
    if ((vertexIndex & 1u) == 1u) { endpoint = segment.second; }
    let relative = vec4f(
        fixedDifferenceMeters(endpoint.x, contourView.cameraX),
        -fixedDifferenceMeters(endpoint.y, contourView.cameraY),
        -(contourView.cameraZ.x + contourView.cameraZ.y),
        1.0,
    );
    var output: FlowContourVertexOutput;
    output.position = contourView.clipFromRelativeWorld * relative;
    return output;
}

@fragment
fn fContour() -> @location(0) vec4f {
    return vec4f(0.18, 0.82, 0.96, 0.78);
}
