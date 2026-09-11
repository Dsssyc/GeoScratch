// Existing ink can outlive a particle. Derive display support from stored source
// footprints, never reinterpret an interpolated cancellation as a dry interior.
fn FlowPresentation_endpoint_support(velocity: vec2f, kill: f32) -> f32 {
    let speed = length(velocity);
    return select(0.0, 1.0, speed > 0.0 && speed >= kill);
}

fn FlowPresentation_stationary_coverage(
    position: FlowVelocityAddressFixedPosition, level: u32, progress: f32, kill: f32,
) -> f32 {
    if (!FlowVelocity_nearest_zero_gate || level >= FlowVelocityCurrent_level_count_value() ||
        !FlowVelocity_source_contains(position)) { return 0.0; }
    // Use the sampler's wide-fixed half-texel registration. Subtracting .5 from
    // an already rounded f32 fraction can select the wrong lattice cell.
    let registered = FlowVelocityRegistration_position(position, level);
    let address = FlowVelocityAddress_address(registered, FlowVelocityCurrent_matrix_at(level));
    let base = vec2i(address.tile * FlowVelocityCurrent_page_size_value() + address.texel);
    let original = FlowVelocityAddress_address(position, FlowVelocityCurrent_matrix_at(level));
    let owner = vec2i(original.tile * FlowVelocityCurrent_page_size_value() + original.texel);
    // Validate the complete 2x2 rectangle once, before any clamping load.
    let minimum = max(vec2i(FlowVelocityCurrent_minimum_texel_at(level)), vec2i(FlowVelocityNext_minimum_texel_at(level)));
    let maximum = min(vec2i(FlowVelocityCurrent_maximum_texel_at(level)), vec2i(FlowVelocityNext_maximum_texel_at(level)));
    if (any(base < minimum) || any(base + vec2i(1) > maximum)) { return 0.0; }
    if (any(owner < base) || any(owner > base + vec2i(1))) { return 0.0; }
    let lower_owner = FlowVelocityCurrent_load_global(owner, level);
    let upper_owner = FlowVelocityNext_load_global(owner, level);
    if (lower_owner.status != 1u || upper_owner.status != 1u ||
        lower_owner.resolved_level != level || upper_owner.resolved_level != level) { return 0.0; }
    let owner_support = vec2f(FlowPresentation_endpoint_support(lower_owner.value.xy, kill),
        FlowPresentation_endpoint_support(upper_owner.value.xy, kill));
    // No neighboring proof can restore two unsupported owners. Test them first,
    // then reuse their bits so the successful path still reads only eight texels.
    if (all(owner_support == vec2f(0.0))) { return 0.0; }
    let p = address.sub_texel;
    var coverage = vec2f(0.0);
    var full_support = vec2f(1.0);
    for (var i = 0u; i < 4u; i++) {
        let global = base + vec2i(i32(i % 2u), i32(i / 2u));
        var bits = owner_support;
        if (any(global != owner)) {
            let lower = FlowVelocityCurrent_load_global(global, level);
            let upper = FlowVelocityNext_load_global(global, level);
            if (lower.status != 1u || upper.status != 1u ||
                lower.resolved_level != level || upper.resolved_level != level) { return 0.0; }
            bits = vec2f(FlowPresentation_endpoint_support(lower.value.xy, kill),
                FlowPresentation_endpoint_support(upper.value.xy, kill));
        }
        let weight = select(1.0 - p.x, p.x, i % 2u != 0u) * select(1.0 - p.y, p.y, i / 2u != 0u);
        coverage += bits * weight;
        full_support = min(full_support, bits);
    }
    // Avoid a dynamically indexed private array; guarantee full support is
    // exactly 1 despite the rounding of separately accumulated weights.
    let support = select(clamp(coverage, vec2f(0.0), vec2f(1.0)), vec2f(1.0), full_support == vec2f(1.0)) * owner_support;
    // Each shared time endpoint is independent of the other pair member. The
    // interior is 1, while partial/one-sided support has a continuous weight.
    if (progress <= 0.0) { return support.x; }
    if (progress >= 1.0) { return support.y; }
    return mix(support.x, support.y, progress);
}

fn FlowPresentation_coverage(
    position: FlowVelocityAddressFixedPosition, level: u32, progress: f32, kill: f32,
) -> f32 {
    if (!FlowVelocity_source_contains(position)) { return 0.0; }
    let flow = FlowVelocity_sample(position, level, FlowVelocityTemporal(progress, kill));
    if (flow.status == 4u) { return 0.0; }
    // Unavailable/fallback is unknown, not a new dry boundary.
    if (flow.status != 1u) { return 1.0; }
    if (flow.advectable && flow.speed > 0.0) { return 1.0; }
    return FlowPresentation_stationary_coverage(position, flow.resolved_level, progress, kill);
}
