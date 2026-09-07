// Distance to an original unit texel footprint, not a center-point contour.
// p is local to the owning square [0,1]^2; offset locates a neighboring square.
fn FlowBoundary_square_distance(p: vec2f, offset: vec2f) -> f32 {
    let separation = max(max(offset - p, p - offset - vec2f(1.0)), vec2f(0.0));
    return length(separation);
}

fn FlowBoundary_inner_coverage(distance: f32, featherTexels: f32) -> f32 {
    return smoothstep(0.0, clamp(featherTexels, 0.05, 0.35), distance);
}

// Row-major 3x3 original texel squares; index 4 is the owner. For each threshold
// the wet region is the union of supported squares. Inside that union, distance
// to its dry complement is distance to the nearest unsupported square.
// Integrate this binary coverage over threshold in [0, owner support].
fn FlowBoundary_continuous_coverage(p: vec2f, activity: array<f32, 9>, feather: f32) -> f32 {
    let owner = activity[4];
    if (owner <= 0.0) { return 0.0; }
    var minimum = owner;
    for (var i = 0u; i < 9u; i++) { minimum = min(minimum, activity[i]); }
    if (minimum == owner) { return owner; }
    var edge_coverage: array<f32, 9>;
    for (var i = 0u; i < 9u; i++) {
        edge_coverage[i] = 1.0;
        if (activity[i] < owner) {
            let offset = vec2f(f32(i % 3u) - 1.0, f32(i / 3u) - 1.0);
            edge_coverage[i] = FlowBoundary_inner_coverage(FlowBoundary_square_distance(p, offset), feather);
        }
    }
    var coverage = minimum;
    var previous = minimum;
    for (var iteration = 0u; iteration < 9u; iteration++) {
        var threshold = owner;
        for (var i = 0u; i < 9u; i++) {
            if (activity[i] > previous) { threshold = min(threshold, activity[i]); }
        }
        var inner = 1.0;
        for (var i = 0u; i < 9u; i++) {
            if (activity[i] < threshold) { inner = min(inner, edge_coverage[i]); }
        }
        coverage += (threshold - previous) * inner;
        previous = threshold;
        if (previous >= owner) { break; }
    }
    return clamp(coverage, 0.0, owner);
}
