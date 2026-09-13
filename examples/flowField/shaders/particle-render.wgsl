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
    @location(0) @interpolate(flat) velocity: vec2f,
    @location(1) @interpolate(flat) visible: u32,
    @location(2) @interpolate(linear) line_position: vec2f,
    @location(3) @interpolate(flat) line_length: f32,
    @location(4) @interpolate(flat) filter_width: f32,
};

@group(0) @binding(0) var<storage, read> flowParticleRenderRecords:
    array<FlowParticleRenderRecord>;
@group(1) @binding(0) var<uniform> contourView: FlowContourViewUniform;
// Target dimensions, reference-derived line width, and full-coverage opacity.
@group(2) @binding(0) var<uniform> flowParticleRaster: vec4f;

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

fn FlowParticle_project(endpoint: FlowParticleFixedPosition) -> vec4f {
    let x = vec2u(endpoint.axes[0].low, endpoint.axes[0].high);
    let y = vec2u(endpoint.axes[1].low, endpoint.axes[1].high);
    let relative = vec4f(
        fixedDifferenceMeters(x, contourView.cameraX),
        -fixedDifferenceMeters(y, contourView.cameraY),
        -(contourView.cameraZ.x + contourView.cameraZ.y),
        1.0,
    );
    return contourView.clipFromRelativeWorld * relative;
}

struct FlowParticleClipSegment {
    first: vec4f,
    last: vec4f,
    visible: bool,
};

fn FlowParticle_inside_clip(p: vec4f) -> bool {
    return p.w > 0.0 && all(abs(p.xy) <= vec2f(p.w)) && p.z >= 0.0 && p.z <= p.w;
}

fn FlowParticle_clip_segment(first: vec4f, last: vec4f) -> FlowParticleClipSegment {
    if (FlowParticle_inside_clip(first) && FlowParticle_inside_clip(last)) {
        return FlowParticleClipSegment(first, last, true);
    }
    // Clip before perspective division, including segments crossing the camera
    // plane. The normal simulation path's two in-view endpoints take the exit above.
    let planes = array<vec4f, 6>(vec4f(1,0,0,1), vec4f(-1,0,0,1),
        vec4f(0,1,0,1), vec4f(0,-1,0,1), vec4f(0,0,1,0), vec4f(0,0,-1,1));
    var lower = 0.0;
    var upper = 1.0;
    for (var i = 0u; i < 6u; i++) {
        let a = dot(first, planes[i]);
        let b = dot(last, planes[i]);
        if (a < 0.0 && b < 0.0) { return FlowParticleClipSegment(first, last, false); }
        if (a < 0.0) { lower = max(lower, a / (a - b)); }
        if (b < 0.0) { upper = min(upper, a / (a - b)); }
    }
    let a = mix(first, last, lower);
    let b = mix(first, last, upper);
    return FlowParticleClipSegment(a, b, lower <= upper && a.w > 0.0 && b.w > 0.0);
}

@vertex
fn vParticle(@builtin(vertex_index) vertexIndex: u32,
    @builtin(instance_index) instanceIndex: u32) -> FlowParticleVertexOutput {
    let particle = flowParticleRenderRecords[instanceIndex];
    var visible = particle.lifecycle_state == FLOW_PARTICLE_ACTIVE;
    visible = visible && !sameFixedPosition(particle.current, particle.previous);
    var output: FlowParticleVertexOutput;
    output.position = vec4f(2.0, 2.0, 2.0, 1.0);
    output.velocity = particle.velocity;
    output.visible = 0u;
    output.line_position = vec2f(0.0);
    output.line_length = 0.0;
    output.filter_width = 1.0;
    if (!visible) { return output; }
    let clipped = FlowParticle_clip_segment(FlowParticle_project(particle.previous), FlowParticle_project(particle.current));
    if (!clipped.visible || any(flowParticleRaster.xy <= vec2f(0.0))) { return output; }
    let previous = clipped.first;
    let current = clipped.last;
    let first_ndc = previous.xyz / previous.w;
    let last_ndc = current.xyz / current.w;
    let first = (first_ndc.xy * vec2f(0.5, -0.5) + vec2f(0.5)) * flowParticleRaster.xy;
    let last = (last_ndc.xy * vec2f(0.5, -0.5) + vec2f(0.5)) * flowParticleRaster.xy;
    let delta = last - first;
    let line_length = length(delta);
    if (line_length <= 0.0) { return output; }
    let tangent = delta / line_length;
    let normal = vec2f(-tangent.y, tangent.x);
    // Exact screen derivatives of either local axis have this L1 footprint.
    let filter_width = abs(tangent.x) + abs(tangent.y);
    let end = vertexIndex >= 2u;
    let along = select(-filter_width * 0.5, line_length + filter_width * 0.5, end);
    let across = select(-1.0, 1.0, (vertexIndex & 1u) != 0u) * (flowParticleRaster.z + filter_width) * 0.5;
    let pixel = first + along * tangent + across * normal;
    let ndc = (pixel / flowParticleRaster.xy - vec2f(0.5)) * vec2f(2.0, -2.0);
    output.position = vec4f(ndc, select(first_ndc.z, last_ndc.z, end), 1.0);
    output.visible = 1u;
    output.line_position = vec2f(along, across);
    output.line_length = line_length;
    output.filter_width = filter_width;
    return output;
}

fn FlowParticle_interval_coverage(position: f32, first: f32, last: f32, filter_width: f32) -> f32 {
    return clamp((position - first) / filter_width + 0.5, 0.0, 1.0) -
        clamp((position - last) / filter_width + 0.5, 0.0, 1.0);
}

@fragment
fn fParticle(input: FlowParticleVertexOutput) -> @location(0) vec4f {
    if (input.visible == FLOW_PARTICLE_DORMANT) { discard; }
    let half_width = flowParticleRaster.z * 0.5;
    let coverage = FlowParticle_interval_coverage(input.line_position.x, 0.0, input.line_length, input.filter_width) *
        FlowParticle_interval_coverage(input.line_position.y, -half_width, half_width, input.filter_width);
    if (coverage <= 0.0) { discard; }
    // Fractional segment coverage composes in optical density. Splitting a short
    // moving segment must not repeatedly stamp a full-opacity endpoint disc.
    let opacity = 1.0 - pow(1.0 - flowParticleRaster.w, coverage);
    let speed = length(input.velocity);
    return vec4f(FlowParticle_velocityColor(speed), opacity);
}
