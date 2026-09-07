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

fn FlowBoundary_hard_coverage(position: FlowVelocityAddressFixedPosition, level: u32) -> f32 {
    return FlowPresentation_coverage(position, level, boundaryUniform.progress, boundaryUniform.activityKill);
}

fn FlowBoundary_weight(global: vec2i, level: u32) -> f32 {
    // A clamped edge value or a missing page must not become invented dry data.
    if (any(global < vec2i(FlowVelocityCurrent_minimum_texel[level])) ||
        any(global > vec2i(FlowVelocityCurrent_maximum_texel[level])) ||
        any(global < vec2i(FlowVelocityNext_minimum_texel[level])) ||
        any(global > vec2i(FlowVelocityNext_maximum_texel[level]))) { return -1.0; }
    let current = FlowVelocityCurrent_load_global(global, level);
    let next = FlowVelocityNext_load_global(global, level);
    if (current.status != 1u || next.status != 1u ||
        current.resolved_level != level || next.resolved_level != level) { return -1.0; }
    return FlowBoundary_support_weight(current.value.xy, next.value.xy,
        boundaryUniform.progress, boundaryUniform.activityKill);
}

// Positive metadata proof for the existing pixel-center, no-NoData sampler.
// Reuse its public resolution/transition operations; do not fetch/interpolate
// velocities merely to learn whether both endpoints resolve at this level.
fn FlowBoundary_exact_residency(position: FlowVelocityAddressFixedPosition, level: u32) -> bool {
    let registered = FlowVelocityRegistration_position(position, level);
    let address = FlowVelocityAddress_address(registered, FlowVelocityCurrent_matrix[level]);
    let base = vec2i(address.tile * FlowVelocityCurrent_page_size + address.texel);
    for (var i = 0u; i < 4u; i++) {
        let global = base + vec2i(i32(i % 2u), i32(i / 2u));
        if (any(FlowVelocityCurrent_resolution_global(global, level) != vec2u(1u, level)) ||
            any(FlowVelocityNext_resolution_global(global, level) != vec2u(1u, level))) { return false; }
    }
    if (level + 1u < FlowVelocityCurrent_level_count &&
        FlowVelocityCurrent_edge_blend_weight(registered, level) < 1.0) { return false; }
    if (level + 1u < FlowVelocityNext_level_count &&
        FlowVelocityNext_edge_blend_weight(registered, level) < 1.0) { return false; }
    return true;
}

fn FlowBoundary_coverage(position: FlowVelocityAddressFixedPosition) -> f32 {
    let level = boundaryUniform.requestedLevel;
    if (!FlowVelocity_nearest_zero_gate || level >= FlowVelocityCurrent_level_count ||
        !FlowVelocity_source_contains(position)) { return FlowBoundary_hard_coverage(position, level); }
    // Honor the temporal sampler's common-level/transition decision before a
    // fine texel is allowed to define a boundary. Missing/fallback is not dry.
    if (!FlowBoundary_exact_residency(position, level)) { return FlowBoundary_hard_coverage(position, level); }
    let address = FlowVelocityAddress_address(position, FlowVelocityCurrent_matrix[level]);
    let owner = vec2i(address.tile * FlowVelocityCurrent_page_size + address.texel);
    let p = address.sub_texel;
    let weight = FlowBoundary_weight(owner, level);
    if (weight < 0.0) { return FlowBoundary_hard_coverage(position, level); }
    if (weight == 0.0) { return 0.0; }
    let feather = clamp(boundaryUniform.presentationFeather, 0.05, 0.35);
    var activity: array<f32, 9>;
    // Unqueried squares are at least feather away and cannot affect coverage.
    for (var i = 0u; i < 9u; i++) { activity[i] = 1.0; }
    activity[4] = weight;
    for (var i = 0u; i < 9u; i++) {
        if (i == 4u) { continue; }
        let offset = vec2i(i32(i % 3u) - 1, i32(i / 3u) - 1);
        let separation = max(max(vec2f(offset) - p, p - vec2f(offset) - vec2f(1.0)), vec2f(0.0));
        if (dot(separation, separation) >= feather * feather) { continue; }
        activity[i] = FlowBoundary_weight(owner + offset, level);
        if (activity[i] < 0.0) { return FlowBoundary_hard_coverage(position, level); }
    }
    // This basis already uses the original owner footprint. Multiplying by a
    // second owner/current-speed gate would reintroduce a conflicting boundary.
    return FlowBoundary_continuous_coverage(p, activity, feather);
}

@fragment
fn fMain(input: FlowBoundaryVertex) -> @location(0) vec4f {
    let dimensions = vec2i(textureDimensions(historyTexture, 0));
    let pixel = clamp(vec2i(vec2f(dimensions) * input.texcoords), vec2i(0), dimensions - vec2i(1));
    let color = textureLoad(historyTexture, pixel, 0);
    if (color.a == 0.0 || max(max(color.r, color.g), color.b) == 0.0) { return color; }
    let ground = FlowScreen_ground_position(input.texcoords, boundaryUniform.currentInverseMatrix,
        boundaryUniform.cameraX, boundaryUniform.cameraY, boundaryUniform.cameraZ);
    if (ground.valid == 0u) { return vec4f(0.0); }
    return vec4f(color.rgb, color.a * FlowBoundary_coverage(ground.position));
}
