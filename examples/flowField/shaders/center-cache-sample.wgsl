struct FlowCenterCacheConfig {
    level: u32,
    pageCount: u32,
    lookupCount: u32,
    kill: f32,
};

@group(3) @binding(0) var<uniform> flowCenterCacheConfig: FlowCenterCacheConfig;
@group(3) @binding(1) var<storage, read> flowCenterCacheLookup: array<u32>;
@group(3) @binding(2) var<storage, read> flowCenterCacheRecords: array<u32>;

fn FlowCenterCached_coverage(position: FlowVelocityAddressFixedPosition) -> f32 {
    let level = boundaryUniform.requestedLevel;
    if (flowCenterCacheConfig.pageCount == 0u || flowCenterCacheConfig.level != level ||
        flowCenterCacheConfig.kill != boundaryUniform.activityKill ||
        level >= FlowVelocityCurrent_level_count_value() || !FlowVelocity_nearest_zero_gate ||
        !FlowVelocity_source_contains(position)) { return FlowCenter_coverage(position); }
    let registered = FlowVelocityRegistration_position(position, level);
    let address = FlowVelocityAddress_address(registered, FlowVelocityCurrent_matrix_at(level));
    if (address.covered == 0u || address.compact_index >= flowCenterCacheConfig.lookupCount ||
        address.compact_index >= arrayLength(&flowCenterCacheLookup)) { return FlowCenter_coverage(position); }
    let encodedSlot = flowCenterCacheLookup[address.compact_index];
    if (encodedSlot == 0u || encodedSlot > flowCenterCacheConfig.pageCount) { return FlowCenter_coverage(position); }
    let base = (encodedSlot - 1u) * 66049u + address.texel.y * 257u + address.texel.x;
    if (base + 258u >= arrayLength(&flowCenterCacheRecords)) { return FlowCenter_coverage(position); }
    // Owner-known records already prove all four source texels are exact at the
    // cache's current publication epochs. Keep the sampler's spatial transition
    // checks, but do not repeat its eight resolution lookups at every fragment.
    if (level + 1u < FlowVelocityCurrent_level_count_value() &&
        FlowVelocityCurrent_edge_blend_weight(registered, level) < 1.0) { return FlowBoundary_hard_coverage(position, level); }
    if (level + 1u < FlowVelocityNext_level_count_value() &&
        FlowVelocityNext_edge_blend_weight(registered, level) < 1.0) { return FlowBoundary_hard_coverage(position, level); }
    var packedSamples: array<u32, 4>;
    var minimum = vec2u(1u);
    var maximum = vec2u(0u);
    var haloUnknown = false;
    for (var i = 0u; i < 4u; i++) {
        let packed = flowCenterCacheRecords[base + i % 2u + (i / 2u) * 257u];
        packedSamples[i] = packed;
        let code = vec2u(packed & 255u, (packed >> 8u) & 255u);
        if (any((code & vec2u(32u)) != vec2u(0u))) { return FlowBoundary_hard_coverage(position, level); }
        let bits = select(vec2u(1u), vec2u(0u), (code & vec2u(16u)) != vec2u(0u));
        minimum = min(minimum, bits);
        maximum = max(maximum, bits);
        haloUnknown = haloUnknown || any((code & vec2u(64u)) != vec2u(0u));
    }
    // Preserve the original same-sign four-center early exits, even when outer
    // halo bits are unknown. The mixed case requires the full original 4x4 union.
    if (all(minimum == vec2u(1u))) { return 1.0; }
    if (all(maximum == vec2u(0u))) { return 0.0; }
    if (haloUnknown) { return FlowBoundary_hard_coverage(position, level); }
    // Interior pixels need only signs. Decode the retained register values for
    // mixed boundaries, without new buffer reads or changing distance arithmetic.
    var lower: vec4f;
    var upper: vec4f;
    for (var i = 0u; i < 4u; i++) {
        let packed = packedSamples[i];
        let code = vec2u(packed & 255u, (packed >> 8u) & 255u);
        let bits = select(vec2u(1u), vec2u(0u), (code & vec2u(16u)) != vec2u(0u));
        let distance = sqrt(vec2f(code & vec2u(15u))) * 0.5;
        let signedDistance = select(-distance, distance, bits != vec2u(0u));
        lower[i] = signedDistance.x;
        upper[i] = signedDistance.y;
    }
    let distance = FlowCenter_reconstruct(mix(lower, upper, boundaryUniform.progress),
        address.sub_texel, FLOW_CENTER_SMOOTH);
    return smoothstep(-boundaryUniform.presentationFeather, boundaryUniform.presentationFeather, distance);
}
