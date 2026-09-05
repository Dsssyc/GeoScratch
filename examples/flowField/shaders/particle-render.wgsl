const FLOW_PARTICLE_DORMANT = 0u;
const FLOW_PARTICLE_ACTIVE = 1u;

struct FlowParticleFixedAxis {
    low: u32,
    high: u32,
};

struct FlowParticleFixedPosition {
    axes: array<FlowParticleFixedAxis, 2>,
};

struct FlowParticleRenderRecord {
    current: FlowParticleFixedPosition,
    previous: FlowParticleFixedPosition,
    velocity: vec2f,
    age_steps: u32,
    stagnant_steps: u32,
    random_state: u32,
    lifecycle_state: u32,
};

struct FlowContourViewUniform {
    clipFromRelativeWorld: mat4x4f,
    cameraX: vec2u,
    cameraY: vec2u,
    cameraZ: vec2f,
    metersPerQuantum: f32,
    reserved: vec3f,
};

struct FlowParticleVertexOutput {
    @builtin(position) position: vec4f,
    @location(0) velocity: vec2f,
    @location(1) @interpolate(flat) visible: u32,
};

@group(0) @binding(0) var<storage, read> flowParticleRenderRecords:
    array<FlowParticleRenderRecord>;
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

fn sameFixedPosition(
    left: FlowParticleFixedPosition,
    right: FlowParticleFixedPosition,
) -> bool {
    return all(vec2u(left.axes[0].low, left.axes[0].high) ==
        vec2u(right.axes[0].low, right.axes[0].high)) &&
        all(vec2u(left.axes[1].low, left.axes[1].high) ==
        vec2u(right.axes[1].low, right.axes[1].high));
}

fn FlowParticle_colorFromInt(color: u32) -> vec3f {
    return vec3f(f32((color >> 16u) & 255u), f32((color >> 8u) & 255u), f32(color & 255u)) / 255.0;
}

fn FlowParticle_velocityColor(speed: f32) -> vec3f {
    let colors = array<u32, 8>(
        0x3288bdu, 0x66c2a5u, 0xabdda4u, 0xe6f598u,
        0xfee08bu, 0xfdae61u, 0xf46d43u, 0xd53e4fu,
    );
    let position = clamp(speed / FLOW_PARTICLE_MAXIMUM_SPEED * 8.0, 0.0, 7.0);
    let lower = u32(floor(position));
    let upper = min(lower + 1u, 7u);
    return mix(
        FlowParticle_colorFromInt(colors[lower]),
        FlowParticle_colorFromInt(colors[upper]),
        position - f32(lower),
    );
}

@vertex
fn vParticle(@builtin(vertex_index) vertexIndex: u32) -> FlowParticleVertexOutput {
    let particle = flowParticleRenderRecords[vertexIndex / 2u];
    var visible = particle.lifecycle_state == FLOW_PARTICLE_ACTIVE;
    visible = visible && !sameFixedPosition(particle.current, particle.previous);
    var endpoint = particle.previous;
    if ((vertexIndex & 1u) == 1u) { endpoint = particle.current; }
    let x = vec2u(endpoint.axes[0].low, endpoint.axes[0].high);
    let y = vec2u(endpoint.axes[1].low, endpoint.axes[1].high);
    let relative = vec4f(
        fixedDifferenceMeters(x, contourView.cameraX),
        -fixedDifferenceMeters(y, contourView.cameraY),
        -(contourView.cameraZ.x + contourView.cameraZ.y),
        1.0,
    );
    var output: FlowParticleVertexOutput;
    output.position = select(
        vec4f(2.0, 2.0, 2.0, 1.0),
        contourView.clipFromRelativeWorld * relative,
        visible,
    );
    output.velocity = particle.velocity;
    output.visible = select(0u, 1u, visible);
    return output;
}

@fragment
fn fParticle(input: FlowParticleVertexOutput) -> @location(0) vec4f {
    if (input.visible == FLOW_PARTICLE_DORMANT) { return vec4f(0.0); }
    let speed = length(input.velocity);
    return vec4f(FlowParticle_velocityColor(speed), 0.5);
}
