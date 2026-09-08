override FLOW_CENTER_SMOOTH = false;

fn FlowCenter_support(global: vec2i, level: u32) -> vec2f {
    if (any(global < vec2i(FlowVelocityCurrent_minimum_texel[level])) ||
        any(global > vec2i(FlowVelocityCurrent_maximum_texel[level])) ||
        any(global < vec2i(FlowVelocityNext_minimum_texel[level])) ||
        any(global > vec2i(FlowVelocityNext_maximum_texel[level]))) { return vec2f(-1.0); }
    let lower = FlowVelocityCurrent_load_global(global, level);
    let upper = FlowVelocityNext_load_global(global, level);
    if (lower.status != 1u || upper.status != 1u ||
        lower.resolved_level != level || upper.resolved_level != level) { return vec2f(-1.0); }
    return vec2f(FlowBoundary_endpoint_support(length(lower.value.xy), boundaryUniform.activityKill),
        FlowBoundary_endpoint_support(length(upper.value.xy), boundaryUniform.activityKill));
}

fn FlowCenter_coverage(position: FlowVelocityAddressFixedPosition) -> f32 {
    let level = boundaryUniform.requestedLevel;
    if (!FlowVelocity_nearest_zero_gate || level >= FlowVelocityCurrent_level_count ||
        !FlowVelocity_source_contains(position)) { return FlowBoundary_hard_coverage(position, level); }
    if (!FlowBoundary_exact_residency(position, level)) { return FlowBoundary_hard_coverage(position, level); }
    let registered = FlowVelocityRegistration_position(position, level);
    let address = FlowVelocityAddress_address(registered, FlowVelocityCurrent_matrix[level]);
    let base = vec2i(address.tile * FlowVelocityCurrent_page_size + address.texel);
    var support: array<vec2f, 16>;
    var minimum = vec2f(1.0);
    var maximum = vec2f(0.0);
    for (var i = 0u; i < 4u; i++) {
        let offset = vec2u(i % 2u, i / 2u);
        let bits = FlowCenter_support(base + vec2i(offset), level);
        if (any(bits < vec2f(0.0))) { return FlowBoundary_hard_coverage(position, level); }
        support[(offset.y + 1u) * 4u + offset.x + 1u] = bits;
        minimum = min(minimum, bits);
        maximum = max(maximum, bits);
    }
    // All four distances have the same sign and magnitude >= .5, beyond the
    // display band. Distant samples cannot change the result in these interiors.
    if (all(minimum == vec2f(1.0))) { return 1.0; }
    if (all(maximum == vec2f(0.0))) { return 0.0; }
    for (var y = 0u; y < 4u; y++) {
        for (var x = 0u; x < 4u; x++) {
            if (x > 0u && x < 3u && y > 0u && y < 3u) { continue; }
            let bits = FlowCenter_support(base + vec2i(i32(x) - 1, i32(y) - 1), level);
            if (any(bits < vec2f(0.0))) { return FlowBoundary_hard_coverage(position, level); }
            support[y * 4u + x] = bits;
        }
    }
    var distances: vec4f;
    for (var i = 0u; i < 4u; i++) {
        let endpoints = FlowCenter_distance(vec2u(i % 2u + 1u, i / 2u + 1u), support);
        distances[i] = mix(endpoints.x, endpoints.y, boundaryUniform.progress);
    }
    let distance = FlowCenter_reconstruct(distances, address.sub_texel, FLOW_CENTER_SMOOTH);
    let width = boundaryUniform.presentationFeather;
    return smoothstep(-width, width, distance);
}

@fragment
fn fCenter(input: FlowBoundaryVertex) -> @location(0) vec4f {
    let dimensions = vec2i(textureDimensions(historyTexture, 0));
    let pixel = clamp(vec2i(vec2f(dimensions) * input.texcoords), vec2i(0), dimensions - vec2i(1));
    let color = textureLoad(historyTexture, pixel, 0);
    if (color.a == 0.0 || max(max(color.r, color.g), color.b) == 0.0) { return color; }
    let ground = FlowScreen_ground_position(input.texcoords, boundaryUniform.currentInverseMatrix,
        boundaryUniform.cameraX, boundaryUniform.cameraY, boundaryUniform.cameraZ);
    if (ground.valid == 0u) { return vec4f(0.0); }
    return vec4f(color.rgb, color.a * FlowCenter_coverage(ground.position));
}
