// Footprint support, not speed-to-opacity. Weak but legal motion is supported.
// Current motion and finite historical-ink visibility have separate authority.
fn FlowBoundary_endpoint_support(speed: f32, kill: f32) -> f32 {
    return select(0.0, 1.0, speed > 0.0 && speed >= kill);
}

fn FlowBoundary_support_weight(current: vec2f, next: vec2f, progress: f32, kill: f32) -> f32 {
    let lower_squared = dot(current, current);
    let upper_squared = dot(next, next);
    let full_squared = 16.0 * kill * kill;
    // Persistent support must not fade merely because the vectors cancel in
    // between. A generous squared-speed margin avoids threshold-rounding ties.
    let full_endpoints = lower_squared > 0.0 && upper_squared > 0.0 &&
        lower_squared >= full_squared && upper_squared >= full_squared;
    if (full_endpoints) { return 1.0; }
    let lower_speed = length(current);
    let upper_speed = length(next);
    let lower_support = FlowBoundary_endpoint_support(lower_speed, kill);
    let upper_support = FlowBoundary_endpoint_support(upper_speed, kill);
    if (lower_support == upper_support) { return lower_support; }
    // A shared sample must have exactly the same weight on either side of a
    // pair handoff, independent of the other endpoint or cancellation rounding.
    if (progress <= 0.0) { return lower_support; }
    if (progress >= 1.0) { return upper_support; }
    let expected_excess = mix(max(lower_speed - kill, 0.0), max(upper_speed - kill, 0.0), progress);
    if (expected_excess <= 0.0) { return 0.0; }
    let excess = max(length(mix(current, next, progress)) - kill, 0.0);
    // Only the changing-support fringe uses temporal fading. This is equivalent
    // to protecting the common endpoint footprint in the continuous weights.
    let cancellation = smoothstep(0.0, 0.15, clamp(excess / expected_excess, 0.0, 1.0));
    return clamp(mix(lower_support, upper_support, progress) * cancellation, 0.0, 1.0);
}
