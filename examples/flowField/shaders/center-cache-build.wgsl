struct FlowCenterCacheConfig {
    level: u32,
    pageCount: u32,
    lookupCount: u32,
    kill: f32,
};

@group(0) @binding(0) var<uniform> flowCenterCacheBuildConfig: FlowCenterCacheConfig;
@group(2) @binding(0) var<storage, read> flowCenterCacheJobs: array<vec4u>;
@group(2) @binding(1) var<storage, read_write> flowCenterCacheOutput: array<u32>;

// Each endpoint byte: bit 4 dry, bit 5 unknown owner, bit 6 unknown halo.
// The low nibble stores 4*d*d: axis=1, diagonal=2, truncated interior=9.
fn FlowCenterCache_support(global: vec2i, level: u32) -> vec2u {
    var bits = vec2u(32u);
    if (all(global >= vec2i(FlowVelocityCurrent_minimum_texel[level])) &&
        all(global <= vec2i(FlowVelocityCurrent_maximum_texel[level]))) {
        let sample = FlowVelocityCurrent_load_global(global, level);
        if (sample.status == 1u && sample.resolved_level == level) {
            let speed = length(sample.value.xy);
            bits.x = select(0u, 1u, speed > 0.0 && speed >= flowCenterCacheBuildConfig.kill);
        }
    }
    if (all(global >= vec2i(FlowVelocityNext_minimum_texel[level])) &&
        all(global <= vec2i(FlowVelocityNext_maximum_texel[level]))) {
        let sample = FlowVelocityNext_load_global(global, level);
        if (sample.status == 1u && sample.resolved_level == level) {
            let speed = length(sample.value.xy);
            bits.y = select(0u, 1u, speed > 0.0 && speed >= flowCenterCacheBuildConfig.kill);
        }
    }
    return bits;
}

@compute @workgroup_size(8, 8)
fn FlowCenterCache_build(@builtin(global_invocation_id) id: vec3u) {
    if (id.x >= 257u || id.y >= 257u || id.z >= flowCenterCacheBuildConfig.pageCount ||
        id.z >= arrayLength(&flowCenterCacheJobs)) { return; }
    let level = flowCenterCacheBuildConfig.level;
    if (level >= FlowVelocityCurrent_level_count || level >= FlowVelocityNext_level_count) { return; }
    let job = flowCenterCacheJobs[id.z];
    if (job.z >= flowCenterCacheBuildConfig.pageCount) { return; }
    let outputIndex = job.z * 66049u + id.y * 257u + id.x;
    if (outputIndex >= arrayLength(&flowCenterCacheOutput)) { return; }
    let global = vec2i(job.xy * FlowVelocityCurrent_page_size + id.xy);
    let owner = FlowCenterCache_support(global, level);
    var squared = vec2u(9u);
    var haloUnknown = vec2u(0u);
    for (var y = -1; y <= 1; y++) {
        for (var x = -1; x <= 1; x++) {
            if (x == 0 && y == 0) { continue; }
            let other = FlowCenterCache_support(global + vec2i(x, y), level);
            haloUnknown |= select(vec2u(0u), vec2u(64u), other == vec2u(32u));
            let distanceSquared = select(0u, 1u, x != 0) + select(0u, 1u, y != 0);
            squared = select(squared, min(squared, vec2u(distanceSquared)),
                (other ^ owner) == vec2u(1u));
        }
    }
    let encoded = select(squared | haloUnknown | select(vec2u(0u), vec2u(16u), owner == vec2u(0u)),
        vec2u(32u), owner == vec2u(32u));
    flowCenterCacheOutput[outputIndex] = encoded.x | (encoded.y << 8u);
}
