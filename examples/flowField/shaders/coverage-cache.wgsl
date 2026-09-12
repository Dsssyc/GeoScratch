struct FlowCenterCacheConfig {
    level: u32,
    pageCount: u32,
    lookupCount: u32,
    kill: f32,
};

@group(3) @binding(0) var<uniform> flowCenterCacheConfig: FlowCenterCacheConfig;
@group(3) @binding(1) var<storage, read> flowCenterCacheLookup: array<u32>;
@group(3) @binding(2) var<storage, read> flowCenterCacheRecords: array<u32>;

// A known wet 2x2 footprint at both endpoints proves coverage 1, even during
// temporal cancellation. The cache owner validates publication/producer epochs.
// Mixed/dry/unknown records retain the complete direct coverage authority.
fn FlowCoverageCached_fullSupport(
    position: FlowVelocityAddressFixedPosition, level: u32, kill: f32,
) -> bool {
    if (flowCenterCacheConfig.pageCount == 0u || flowCenterCacheConfig.level != level ||
        flowCenterCacheConfig.kill != kill || !FlowVelocity_nearest_zero_gate ||
        level >= FlowVelocityCurrent_level_count_value() ||
        level >= FlowVelocityNext_level_count_value() || !FlowVelocity_source_contains(position)) { return false; }
    let registered = FlowVelocityRegistration_position(position, level);
    let matrix = FlowVelocityCurrent_matrix_at(level);
    let address = FlowVelocityAddress_address(registered, matrix);
    if (address.covered == 0u || address.compact_index >= flowCenterCacheConfig.lookupCount ||
        address.compact_index >= arrayLength(&flowCenterCacheLookup)) { return false; }
    let slot = flowCenterCacheLookup[address.compact_index];
    if (slot == 0u || slot > flowCenterCacheConfig.pageCount) { return false; }
    let base = (slot - 1u) * 66049u + address.texel.y * 257u + address.texel.x;
    if (base + 258u >= arrayLength(&flowCenterCacheRecords)) { return false; }
    let owner = FlowVelocityAddress_address(position, matrix);
    let first = address.tile * FlowVelocityCurrent_page_size_value() + address.texel;
    let nearest = owner.tile * FlowVelocityCurrent_page_size_value() + owner.texel;
    if (any(nearest < first) || any(nearest > first + vec2u(1u))) { return false; }
    if (level + 1u < FlowVelocityCurrent_level_count_value() &&
        FlowVelocityCurrent_edge_blend_weight(registered, level) < 1.0) { return false; }
    if (level + 1u < FlowVelocityNext_level_count_value() &&
        FlowVelocityNext_edge_blend_weight(registered, level) < 1.0) { return false; }
    let flags = flowCenterCacheRecords[base] | flowCenterCacheRecords[base + 1u] |
        flowCenterCacheRecords[base + 257u] | flowCenterCacheRecords[base + 258u];
    // Bits 4/5 are dry/unknown owner in each endpoint byte. Outer halo distance
    // is irrelevant when all eight source centers have complete support.
    return (flags & 0x3030u) == 0u;
}

fn FlowPresentation_coverage(
    position: FlowVelocityAddressFixedPosition, level: u32, progress: f32, kill: f32,
) -> f32 {
    if (FlowCoverageCached_fullSupport(position, level, kill)) { return 1.0; }
    return FlowPresentation_coverage_direct(position, level, progress, kill);
}
