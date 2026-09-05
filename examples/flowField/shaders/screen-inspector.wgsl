struct FlowScreenInspectorUniform {
    relativeWorldFromClip: mat4x4f,
    cameraX: vec2u,
    cameraY: vec2u,
    cameraZ: vec2f,
    requestedLevel: u32,
    viewMode: u32,
    progress: f32,
    maximumSpeed: f32,
    sampleMode: u32,
    reserved: u32,
}

struct FlowScreenInspectorVertex {
    @builtin(position) position: vec4f,
    @location(0) texcoords: vec2f,
}

@group(0) @binding(0) var<uniform> flowScreenInspector: FlowScreenInspectorUniform;

fn FlowScreenInspector_color_from_int(color: u32) -> vec3f {
    return vec3f(f32((color >> 16u) & 255u), f32((color >> 8u) & 255u), f32(color & 255u)) / 255.0f;
}

// Same eight-color bands, normalization and opacity as the frozen Flow Layer.
fn FlowScreenInspector_speed_color(normalized_speed: f32) -> vec3f {
    let palette = array<u32, 8>(
        0x3288bdu, 0x66c2a5u, 0xabdda4u, 0xe6f598u,
        0xfee08bu, 0xfdae61u, 0xf46d43u, 0xd53e4fu,
    );
    let position = clamp(normalized_speed * 8.0f, 0.0f, 7.0f);
    let lower = u32(floor(position));
    return mix(
        FlowScreenInspector_color_from_int(palette[lower]),
        FlowScreenInspector_color_from_int(palette[min(lower + 1u, 7u)]),
        position - f32(lower),
    );
}

fn FlowScreenInspector_signed_color(value: f32) -> vec3f {
    let center = vec3f(0.94f, 0.94f, 0.90f);
    let negative = vec3f(0.20f, 0.53f, 0.74f);
    let positive = vec3f(0.84f, 0.24f, 0.31f);
    return mix(center, select(negative, positive, value >= 0.0f), clamp(abs(value), 0.0f, 1.0f));
}

fn FlowScreenInspector_direction_color(velocity: vec2f) -> vec3f {
    let hue = fract(atan2(velocity.y, velocity.x) / 6.28318530718f + 1.0f);
    let ramp = abs(fract(vec3f(hue) + vec3f(0.0f, 2.0f / 3.0f, 1.0f / 3.0f)) * 6.0f - 3.0f);
    return mix(vec3f(1.0f), clamp(ramp - 1.0f, vec3f(0.0f), vec3f(1.0f)), 0.8f);
}

fn FlowScreenInspector_selected_sample(position: FlowVelocityAddressFixedPosition) -> FlowVelocitySample {
    var progress = flowScreenInspector.progress;
    if (flowScreenInspector.sampleMode == 1u) { progress = 0.0f; }
    if (flowScreenInspector.sampleMode == 2u) { progress = 1.0f; }
    if (flowScreenInspector.sampleMode == 3u) {
        let lower = FlowVelocity_sample(position, flowScreenInspector.requestedLevel, FlowVelocityTemporal(0.0f, 0.000001f));
        let upper = FlowVelocity_sample(position, flowScreenInspector.requestedLevel, FlowVelocityTemporal(1.0f, 0.000001f));
        let velocity = upper.velocity - lower.velocity;
        return FlowVelocitySample(max(lower.status, upper.status), velocity, length(velocity),
            any(velocity != vec2f(0.0f)), max(lower.resolved_level, upper.resolved_level));
    }
    return FlowVelocity_sample(position, flowScreenInspector.requestedLevel, FlowVelocityTemporal(progress, 0.000001f));
}

@vertex
fn FlowScreenInspector_vertex(@builtin(vertex_index) index: u32) -> FlowScreenInspectorVertex {
    let points = array<vec2f, 3>(vec2f(-1.0f, -1.0f), vec2f(3.0f, -1.0f), vec2f(-1.0f, 3.0f));
    let point = points[index];
    return FlowScreenInspectorVertex(vec4f(point, 0.0f, 1.0f), vec2f(point.x * 0.5f + 0.5f, 0.5f - point.y * 0.5f));
}

@fragment
fn FlowScreenInspector_fragment(input: FlowScreenInspectorVertex) -> @location(0) vec4f {
    let ground = FlowScreen_ground_position(input.texcoords,
        flowScreenInspector.relativeWorldFromClip, flowScreenInspector.cameraX,
        flowScreenInspector.cameraY, flowScreenInspector.cameraZ);
    if (ground.valid == 0u) { discard; }
    let sample = FlowScreenInspector_selected_sample(ground.position);
    if (sample.status == 0u) { discard; }
    if (flowScreenInspector.viewMode == 4u) {
        if (sample.status == 4u) { return vec4f(0.95f, 0.15f, 0.20f, 0.65f); }
        if (sample.status == 3u) { return vec4f(0.85f, 0.20f, 0.95f, 0.65f); }
        if (sample.status == 2u) { return vec4f(0.98f, 0.68f, 0.20f, 0.5f); }
        if (all(sample.velocity == vec2f(0.0f))) { return vec4f(0.30f, 0.36f, 0.43f, 0.5f); }
        return vec4f(0.18f, 0.80f, 0.63f, 0.5f);
    }
    if (sample.status != 1u && sample.status != 2u) { discard; }
    if (all(sample.velocity == vec2f(0.0f)) && flowScreenInspector.sampleMode != 3u) { discard; }
    let maximum = max(flowScreenInspector.maximumSpeed, 0.000001f);
    var color = FlowScreenInspector_speed_color(sample.speed / maximum);
    if (flowScreenInspector.viewMode == 1u) { color = FlowScreenInspector_direction_color(sample.velocity); }
    if (flowScreenInspector.viewMode == 2u) { color = FlowScreenInspector_signed_color(sample.velocity.x / maximum); }
    if (flowScreenInspector.viewMode == 3u) { color = FlowScreenInspector_signed_color(sample.velocity.y / maximum); }
    return vec4f(color, 0.5f);
}
