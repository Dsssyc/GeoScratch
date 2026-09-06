// Local contour topology reconstructed between four source texel centers.
// Use this signed helper for inside/outside only, not cross-cell feather distance.
// Diagonal active cells stay disconnected instead of bridging dry cells.
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

// Unlike the signed local helper, this accepts points OUTSIDE the cell. Distances
// are to finite segments, not infinite lines or sign(0) on a segment's extension.
fn FlowBoundary_unsigned_distance(p: vec2f, corners: u32) -> f32 {
    let top = vec2f(0.5, 0.0);
    let right = vec2f(1.0, 0.5);
    let bottom = vec2f(0.5, 1.0);
    let left = vec2f(0.0, 0.5);
    switch corners {
        case 1u, 14u: { return FlowBoundary_segment_distance(p, top, left); }
        case 2u, 13u: { return FlowBoundary_segment_distance(p, top, right); }
        case 3u, 12u: { return FlowBoundary_segment_distance(p, left, right); }
        case 4u, 11u: { return FlowBoundary_segment_distance(p, right, bottom); }
        case 5u: { return min(FlowBoundary_segment_distance(p, top, left), FlowBoundary_segment_distance(p, right, bottom)); }
        case 6u, 9u: { return FlowBoundary_segment_distance(p, top, bottom); }
        case 7u, 8u: { return FlowBoundary_segment_distance(p, left, bottom); }
        case 10u: { return min(FlowBoundary_segment_distance(p, top, right), FlowBoundary_segment_distance(p, left, bottom)); }
        default: { return 1.0; } // No contour in a homogeneous cell.
    }
}

// Row-major 3x3 cells around the current cell, built from 4x4 source centers.
// A contour beyond these cells is at least one texel away, so this is the true
// nearest contour distance within the supported 0.35-texel display band.
fn FlowBoundary_neighborhood_distance(p: vec2f, masks: array<u32, 9>) -> f32 {
    var distance = 0.35;
    for (var i = 0u; i < 9u; i++) {
        let corners = masks[i];
        if (corners == 0u || corners == 15u) { continue; }
        let offset = vec2f(f32(i % 3u) - 1.0, f32(i / 3u) - 1.0);
        distance = min(distance, FlowBoundary_unsigned_distance(p - offset, corners));
    }
    return sign(FlowBoundary_distance(p, masks[4])) * distance;
}

fn FlowBoundary_inner_coverage(distance: f32) -> f32 {
    // Fixed source-space quarter-texel band; it does not widen with DPR or pitch.
    return smoothstep(0.0, 0.25, distance);
}
