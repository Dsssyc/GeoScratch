// Signed distance samples at source centers, truncated to 1.5 source texels.
// A 3x3 neighborhood is sufficient: any more distant square starts at least
// 1.5 texels away. The two components describe independent time endpoints.
fn FlowCenter_distance(center: vec2u, support: array<vec2f, 16>) -> vec2f {
    let inside = support[center.y * 4u + center.x];
    var distance = vec2f(1.5);
    for (var y = 0u; y < 3u; y++) {
        for (var x = 0u; x < 3u; x++) {
            let offset = vec2i(i32(x) - 1, i32(y) - 1);
            let neighbor = vec2u(vec2i(center) + offset);
            let other = support[neighbor.y * 4u + neighbor.x];
            let separation = max(abs(vec2f(offset)) - vec2f(0.5), vec2f(0.0));
            distance = select(distance, min(distance, vec2f(length(separation))), other != inside);
        }
    }
    return select(-distance, distance, inside > vec2f(0.0));
}

// Both kernels interpolate the same four center values without overshoot.
// Smooth weights are a display reconstruction, not a metric-preserving SDF.
fn FlowCenter_reconstruct(distances: vec4f, p: vec2f, useSmooth: bool) -> f32 {
    let f = clamp(p, vec2f(0.0), vec2f(1.0));
    let w = select(f, f * f * (vec2f(3.0) - 2.0 * f), useSmooth);
    return mix(mix(distances.x, distances.y, w.x), mix(distances.z, distances.w, w.x), w.y);
}
