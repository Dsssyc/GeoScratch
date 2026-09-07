@group(0) @binding(0) var<uniform> boundaryUniform: FlowFieldHistoryUniform;
@group(2) @binding(0) var historyTexture: texture_2d<f32>;

struct FlowBoundaryVertex {
    @builtin(position) position: vec4f,
    @location(0) texcoords: vec2f,
};

@vertex
fn vMain(@builtin(vertex_index) index: u32) -> FlowBoundaryVertex {
    let positions = array<vec2f, 4>(vec2f(-1.0, -1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
    let p = positions[index];
    return FlowBoundaryVertex(vec4f(p, 0.0, 1.0), vec2f(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5));
}

struct FlowBoundaryCenter {
    weight: f32,
    current: vec2f,
    next: vec2f,
};

// Interpolated support footprint with common endpoint support protected. This
// does not classify current motion; the original temporal sampler does that.
fn FlowBoundary_center(global: vec2i, level: u32) -> FlowBoundaryCenter {
    let unknown = FlowBoundaryCenter(-1.0, vec2f(0.0), vec2f(0.0));
    if (any(global < vec2i(FlowVelocityCurrent_minimum_texel[level])) ||
        any(global > vec2i(FlowVelocityCurrent_maximum_texel[level]))) { return unknown; }
    let current = FlowVelocityCurrent_load_global(global, level);
    let next = FlowVelocityNext_load_global(global, level);
    if (current.status != 1u || next.status != 1u ||
        current.resolved_level != level || next.resolved_level != level) { return unknown; }
    return FlowBoundaryCenter(FlowBoundary_support_weight(current.value.xy, next.value.xy,
        boundaryUniform.progress, boundaryUniform.activityKill), current.value.xy, next.value.xy);
}

fn FlowBoundary_coverage(position: FlowVelocityAddressFixedPosition) -> f32 {
    let level = boundaryUniform.requestedLevel;
    // B is specifically the v3 pixel-center/nearest-zero footprint experiment.
    if (!FlowVelocity_nearest_zero_gate || level >= FlowVelocityCurrent_level_count ||
        !FlowVelocity_source_contains(position)) { return 1.0; }
    let address = FlowVelocityAddress_address(position, FlowVelocityCurrent_matrix[level]);
    let offset = address.sub_texel - vec2f(0.5);
    let base = vec2i(address.tile * FlowVelocityCurrent_page_size + address.texel) + vec2i(floor(offset));
    let p = fract(offset);
    let tl = FlowBoundary_center(base, level);
    let tr = FlowBoundary_center(base + vec2i(1, 0), level);
    let br = FlowBoundary_center(base + vec2i(1, 1), level);
    let bl = FlowBoundary_center(base + vec2i(0, 1), level);
    // Unknown halo/fallback is not dry. Fall back to the unchanged A display.
    let q = vec4f(tl.weight, tr.weight, br.weight, bl.weight);
    let minimum = min(min(q.x, q.y), min(q.z, q.w));
    let maximum = max(max(q.x, q.y), max(q.z, q.w));
    if (minimum < 0.0) { return 1.0; }
    // Zero-k has no numerical margin: let the full sampler decide exact zero.
    if (minimum == 1.0 && boundaryUniform.activityKill > 0.0) {
        // Check cancellation using already loaded, pixel-center-aligned texels.
        // Keep the nearest-zero gate even when q rounds to 1 at tiny alpha.
        var lower = mix(mix(tl.current, tr.current, p.x), mix(bl.current, br.current, p.x), p.y);
        var upper = mix(mix(tl.next, tr.next, p.x), mix(bl.next, br.next, p.x), p.y);
        // Ownership is integer-address derived; fract can round to the other
        // half of a texel at wide-fixed positions infinitesimally below an edge.
        let owning = -vec2i(floor(offset));
        let lower_nearest = select(select(tl.current, tr.current, owning.x != 0),
            select(bl.current, br.current, owning.x != 0), owning.y != 0);
        let upper_nearest = select(select(tl.next, tr.next, owning.x != 0),
            select(bl.next, br.next, owning.x != 0), owning.y != 0);
        if (all(lower_nearest == vec2f(0.0))) { lower = vec2f(0.0); }
        if (all(upper_nearest == vec2f(0.0))) { upper = vec2f(0.0); }
        var velocity = mix(lower, upper, boundaryUniform.progress);
        if (boundaryUniform.progress <= 0.0) { velocity = lower; }
        if (boundaryUniform.progress >= 1.0) { velocity = upper; }
        if (length(velocity) >= 4.0 * boundaryUniform.activityKill && length(velocity) > 0.0) {
            return 1.0;
        }
    }
    // Respect the actual temporal sampler's common-level/transition decision.
    // A sparse LoD halo must not create a finer artificial boundary over fallback ink.
    let actual = FlowVelocity_sample(position, level,
        FlowVelocityTemporal(boundaryUniform.progress, boundaryUniform.activityKill));
    if (actual.status != 1u || actual.resolved_level != level) { return 1.0; }
    if (!actual.advectable || actual.speed <= 0.0) { return 0.0; }
    // Uniform support has integral q. There is no global low-speed alpha cap.
    if (minimum == maximum) { return minimum; }
    var centers: array<f32, 16>;
    for (var i = 0u; i < 16u; i++) { centers[i] = -2.0; }
    centers[5] = q.x; centers[6] = q.y; centers[10] = q.z; centers[9] = q.w;
    for (var i = 0u; i < 9u; i++) {
        let cell = vec2f(f32(i % 3u) - 1.0, f32(i / 3u) - 1.0);
        let separation = max(max(cell - p, p - cell - vec2f(1.0)), vec2f(0.0));
        // A farther cell cannot affect this bounded distance, even if missing.
        // Query the same geometric footprint on both sides of a shared edge.
        if (dot(separation, separation) >= 0.35 * 0.35) { continue; }
        let origin = i % 3u + (i / 3u) * 4u;
        let indices = array<u32, 4>(origin, origin + 1u, origin + 5u, origin + 4u);
        for (var corner = 0u; corner < 4u; corner++) {
            let index = indices[corner];
            if (centers[index] == -2.0) {
                centers[index] = FlowBoundary_center(base +
                    vec2i(i32(index % 4u) - 1, i32(index / 4u) - 1), level).weight;
            }
            // Only a relevant unknown halo disables B; it never seeds a dry edge.
            if (centers[index] < 0.0) { return 1.0; }
        }
    }
    // Unqueried centers belong only to irrelevant far cells; their values cannot
    // affect this narrow band. No missing *queried* center reaches the integral.
    for (var i = 0u; i < 16u; i++) { centers[i] = max(centers[i], 0.0); }
    return FlowBoundary_continuous_coverage(p, centers, boundaryUniform.presentationFeather);
}

@fragment
fn fMain(input: FlowBoundaryVertex) -> @location(0) vec4f {
    let dimensions = vec2i(textureDimensions(historyTexture, 0));
    let pixel = clamp(vec2i(vec2f(dimensions) * input.texcoords), vec2i(0), dimensions - vec2i(1));
    let color = textureLoad(historyTexture, pixel, 0);
    // No field work for empty ink, no color extrapolation into hard-empty pixels.
    if (color.a == 0.0 || max(max(color.r, color.g), color.b) == 0.0) { return color; }
    let ground = FlowScreen_ground_position(input.texcoords, boundaryUniform.currentInverseMatrix,
        boundaryUniform.cameraX, boundaryUniform.cameraY, boundaryUniform.cameraZ);
    if (ground.valid == 0u) { return color; }
    // Apply coverage once, only to Surface alpha; never feed it into raw history.
    return vec4f(color.rgb, color.a * FlowBoundary_coverage(ground.position));
}
