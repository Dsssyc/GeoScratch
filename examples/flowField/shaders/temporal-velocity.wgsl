struct FlowVelocityTemporal {
    progress: f32,
    activityKill: f32,
}

struct FlowVelocitySample {
    status: u32,
    velocity: vec2f,
    speed: f32,
    advectable: bool,
    resolved_level: u32,
}

fn FlowVelocity_unavailable_status(current_status: u32, next_status: u32) -> u32 {
    if (current_status == 4u || next_status == 4u) { return 4u; }
    if (current_status == 3u || next_status == 3u) { return 3u; }
    return 0u;
}

fn FlowVelocity_sample(
    position: FlowVelocityAddressFixedPosition,
    requested_level: u32,
    temporal: FlowVelocityTemporal,
) -> FlowVelocitySample {
    if (!FlowVelocity_source_contains(position)) {
        return FlowVelocitySample(0u, vec2f(0.0), 0.0f, false, requested_level);
    }
    var common_level = requested_level;
    var current = FlowVelocityCurrent_sample_compute(position, common_level);
    var next = FlowVelocityNext_sample_compute(position, common_level);
    for (var iteration = 0u; iteration < FlowVelocityCurrent_level_count; iteration++) {
        if (current.status == 0u || current.status == 3u || current.status == 4u ||
            next.status == 0u || next.status == 3u || next.status == 4u) {
            return FlowVelocitySample(
                FlowVelocity_unavailable_status(current.status, next.status),
                vec2f(0.0),
                0.0f,
                false,
                common_level,
            );
        }
        if (current.resolved_level == common_level && next.resolved_level == common_level) {
            let velocity = mix(current.value.xy, next.value.xy, temporal.progress);
            let speed = length(velocity);
            let advectable = speed >= temporal.activityKill;
            return FlowVelocitySample(
                max(current.status, next.status),
                velocity,
                speed,
                advectable,
                common_level,
            );
        }
        common_level = max(current.resolved_level, next.resolved_level);
        current = FlowVelocityCurrent_sample_compute(position, common_level);
        next = FlowVelocityNext_sample_compute(position, common_level);
    }
    return FlowVelocitySample(0u, vec2f(0.0), 0.0f, false, common_level);
}
