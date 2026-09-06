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

// Each center uses the *current interpolated* U/V, not the endpoint support
// union or a mix of endpoint SDFs. Only exact same-level resident values may
// create a contour. The public logical loads cross physical atlas/page edges.
fn FlowBoundary_center(global: vec2i, level: u32) -> i32 {
    if (any(global < vec2i(FlowVelocityCurrent_minimum_texel[level])) ||
        any(global > vec2i(FlowVelocityCurrent_maximum_texel[level]))) { return -1; }
    let current = FlowVelocityCurrent_load_global(global, level);
    let next = FlowVelocityNext_load_global(global, level);
    if (current.status != 1u || next.status != 1u ||
        current.resolved_level != level || next.resolved_level != level) { return -1; }
    let speed = length(mix(current.value.xy, next.value.xy, boundaryUniform.progress));
    return select(0, 1, speed > 0.0 && speed >= boundaryUniform.activityKill);
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
    if (min(min(tl, tr), min(br, bl)) < 0) { return 1.0; }
    let corners = u32(tl) | (u32(tr) << 1u) | (u32(br) << 2u) | (u32(bl) << 3u);
    // For an all-active cell, any external contour is at least sqrt(1/8)
    // texels away. The entire allowed feather band (<= 0.35) is already opaque.
    if (corners == 15u) { return 1.0; }
    // Respect the actual temporal sampler's common-level/transition decision.
    // A sparse LoD halo must not create a finer artificial boundary over fallback ink.
    let actual = FlowVelocity_sample(position, level,
        FlowVelocityTemporal(boundaryUniform.progress, boundaryUniform.activityKill));
    if (actual.status != 1u || actual.resolved_level != level) { return 1.0; }
    if (!actual.advectable || actual.speed <= 0.0) { return 0.0; }
    if (corners == 0u) { return 0.0; }
    var centers: array<i32, 16>;
    for (var i = 0u; i < 16u; i++) { centers[i] = -2; }
    centers[5] = tl; centers[6] = tr; centers[10] = br; centers[9] = bl;
    var masks: array<u32, 9>;
    for (var i = 0u; i < 9u; i++) {
        let cell = vec2f(f32(i % 3u) - 1.0, f32(i / 3u) - 1.0);
        let separation = max(max(cell - p, p - cell - vec2f(1.0)), vec2f(0.0));
        // A farther cell cannot affect this bounded distance, even if missing.
        // Query the same geometric footprint on both sides of a shared edge.
        if (length(separation) >= 0.35) { masks[i] = 0u; continue; }
        let origin = i % 3u + (i / 3u) * 4u;
        let indices = array<u32, 4>(origin, origin + 1u, origin + 5u, origin + 4u);
        for (var corner = 0u; corner < 4u; corner++) {
            let index = indices[corner];
            if (centers[index] == -2) {
                centers[index] = FlowBoundary_center(base +
                    vec2i(i32(index % 4u) - 1, i32(index / 4u) - 1), level);
            }
            // Only a relevant unknown halo disables B; it never seeds a dry edge.
            if (centers[index] < 0) { return 1.0; }
        }
        masks[i] = u32(centers[origin]) | (u32(centers[origin + 1u]) << 1u) |
            (u32(centers[origin + 5u]) << 2u) | (u32(centers[origin + 4u]) << 3u);
    }
    return FlowBoundary_inner_coverage(FlowBoundary_neighborhood_distance(p, masks));
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
