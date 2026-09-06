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
    if (corners == 15u) { return 1.0; }
    // Respect the actual temporal sampler's common-level/transition decision.
    // A sparse LoD halo must not create a finer artificial boundary over fallback ink.
    let actual = FlowVelocity_sample(position, level,
        FlowVelocityTemporal(boundaryUniform.progress, boundaryUniform.activityKill));
    if (actual.status != 1u || actual.resolved_level != level) { return 1.0; }
    if (!actual.advectable || actual.speed <= 0.0) { return 0.0; }
    return FlowBoundary_inner_coverage(FlowBoundary_distance(p, corners));
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
