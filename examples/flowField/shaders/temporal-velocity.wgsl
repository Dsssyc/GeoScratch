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
    if (requested_level >= FlowVelocityCurrent_level_count) {
        return FlowVelocitySample(4u, vec2f(0.0), 0.0f, false, requested_level);
    }
    if (!FlowVelocity_source_contains(position)) {
        return FlowVelocitySample(0u, vec2f(0.0), 0.0f, false, requested_level);
    }
    var common_level = requested_level;
    for (var iteration = 0u; iteration < FlowVelocityCurrent_level_count; iteration++) {
        let registered_position = FlowVelocityRegistration_position(position, common_level);
        let current = FlowVelocityRegistration_sample_current(
            registered_position,
            common_level,
        );
        let next = FlowVelocityRegistration_sample_next(
            registered_position,
            common_level,
        );
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
            var current_velocity = current.value.xy;
            var next_velocity = next.value.xy;
            if (FlowVelocity_nearest_zero_gate) {
                // These nearest texels belong to the already-resolved common
                // footprint. Zero support occupies a whole texel, not just its center.
                let current_center = FlowVelocityCurrent_load_position(position, common_level);
                let next_center = FlowVelocityNext_load_position(position, common_level);
                if (all(current_center.value.xy == vec2f(0.0))) { current_velocity = vec2f(0.0); }
                if (all(next_center.value.xy == vec2f(0.0))) { next_velocity = vec2f(0.0); }
            }
            let velocity = mix(current_velocity, next_velocity, temporal.progress);
            let speed = length(velocity);
            let advectable = speed > 0.0 && speed >= temporal.activityKill;
            // A common-level retry changes where both pages are resident, not
            // the original request. Keep fallback provenance even for zero UV.
            let status = select(
                max(current.status, next.status),
                2u,
                common_level > requested_level,
            );
            return FlowVelocitySample(
                status,
                velocity,
                speed,
                advectable,
                common_level,
            );
        }
        let resolved_level = max(current.resolved_level, next.resolved_level);
        if (resolved_level <= common_level ||
            resolved_level >= FlowVelocityCurrent_level_count) {
            return FlowVelocitySample(4u, vec2f(0.0), 0.0f, false, common_level);
        }
        common_level = resolved_level;
    }
    return FlowVelocitySample(4u, vec2f(0.0), 0.0f, false, common_level);
}
