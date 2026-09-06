// Display-only confidence. Particle activity, velocity and hard-history cleanup
// still use the original kill threshold. No wall-clock filter or retained mask.
fn FlowBoundary_speed_gain(speed: f32, kill: f32) -> f32 {
    if (speed <= kill || speed <= 0.0) { return 0.0; }
    if (kill <= 0.0) { return 1.0; }
    return smoothstep(kill, 4.0 * kill, speed);
}

fn FlowBoundary_activity(current: vec2f, next: vec2f, progress: f32, kill: f32) -> f32 {
    let lower_squared = dot(current, current);
    let upper_squared = dot(next, next);
    let full_squared = 16.0 * kill * kill;
    // Co-directed endpoints at >=4k have full gains and a cancellation ratio
    // >=0.609 for every alpha. Avoid three square roots in this common case.
    let full_endpoints = lower_squared > 0.0 && upper_squared > 0.0 &&
        lower_squared >= full_squared && upper_squared >= full_squared;
    if (full_endpoints && dot(current, next) >= 0.0) {
        return 1.0;
    }
    if (lower_squared <= kill * kill && upper_squared <= kill * kill) { return 0.0; }
    let interpolated = mix(current, next, progress);
    let lower_speed = length(current);
    let upper_speed = length(next);
    let lower_gain = FlowBoundary_speed_gain(lower_speed, kill);
    let upper_gain = FlowBoundary_speed_gain(upper_speed, kill);
    // A shared sample must have exactly the same weight on either side of a
    // pair handoff, independent of the other endpoint or cancellation rounding.
    if (progress <= 0.0) { return lower_gain; }
    if (progress >= 1.0) { return upper_gain; }
    let expected_excess = mix(max(lower_speed - kill, 0.0), max(upper_speed - kill, 0.0), progress);
    if (expected_excess <= 0.0) { return 0.0; }
    let excess = max(length(interpolated) - kill, 0.0);
    // Relative cancellation fade anticipates short interior dips as well as
    // endpoint extinction. Same-direction well-supported vectors stay opaque.
    let cancellation = smoothstep(0.0, 0.15, clamp(excess / expected_excess, 0.0, 1.0));
    return clamp(mix(lower_gain, upper_gain, progress) * cancellation, 0.0, 1.0);
}
