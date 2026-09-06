// Local, truncated signed distance (positive inside) to the marching-squares
// contour reconstructed between four source texel centers. This is not the
// distance to the original union of square footprints: its convex corners are
// chamfered. Diagonal active cells stay disconnected instead of bridging dry cells.
fn FlowBoundary_segment_distance(p: vec2f, a: vec2f, b: vec2f) -> f32 {
    let edge = b - a;
    return length(p - a - edge * clamp(dot(p - a, edge) / dot(edge, edge), 0.0, 1.0));
}

// Corner bits run clockwise: top-left, top-right, bottom-right, bottom-left.
fn FlowBoundary_distance(p: vec2f, corners: u32) -> f32 {
    let tl = sign(0.5 - p.x - p.y) * FlowBoundary_segment_distance(p, vec2f(0.5, 0.0), vec2f(0.0, 0.5));
    let tr = sign(p.x - p.y - 0.5) * FlowBoundary_segment_distance(p, vec2f(0.5, 0.0), vec2f(1.0, 0.5));
    let br = sign(p.x + p.y - 1.5) * FlowBoundary_segment_distance(p, vec2f(1.0, 0.5), vec2f(0.5, 1.0));
    let bl = sign(p.y - p.x - 0.5) * FlowBoundary_segment_distance(p, vec2f(0.0, 0.5), vec2f(0.5, 1.0));
    switch corners {
        case 0u: { return -1.0; }
        case 1u: { return tl; }
        case 2u: { return tr; }
        case 3u: { return 0.5 - p.y; }
        case 4u: { return br; }
        case 5u: { return max(tl, br); }
        case 6u: { return p.x - 0.5; }
        case 7u: { return -bl; }
        case 8u: { return bl; }
        case 9u: { return 0.5 - p.x; }
        case 10u: { return max(tr, bl); }
        case 11u: { return -br; }
        case 12u: { return p.y - 0.5; }
        case 13u: { return -tr; }
        case 14u: { return -tl; }
        default: { return 1.0; }
    }
}

fn FlowBoundary_inner_coverage(distance: f32) -> f32 {
    // Fixed source-space quarter-texel band; it does not widen with DPR or pitch.
    return smoothstep(0.0, 0.25, distance);
}
