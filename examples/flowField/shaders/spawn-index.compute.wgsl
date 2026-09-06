struct FlowSpawnCellCandidate {
    origin: FlowVelocityAddressFixedPosition,
    texelStepQuanta: u32,
    requestedLevel: u32,
    reserved: vec2u,
};

struct FlowParticleSpawnCandidate {
    origin: FlowVelocityAddressFixedPosition,
    texelStepQuanta: u32,
    requestedLevel: u32,
    identity: u32,
    reserved: u32,
};

struct FlowSpawnUniform {
    candidateCount: u32,
    capacity: u32,
    generation: u32,
    subcellSide: u32,
    progress: f32,
    activitySpawn: f32,
    activityKill: f32,
    reservedF32: f32,
};

struct FlowSpawnCellCandidates {
    values: array<FlowSpawnCellCandidate>,
};

struct FlowParticleSpawnCandidates {
    values: array<FlowParticleSpawnCandidate>,
};

struct FlowSpawnAtomic {
    value: atomic<u32>,
};

@group(0) @binding(0) var<uniform> spawnUniform: FlowSpawnUniform;
@group(0) @binding(1) var<storage, read> candidates: FlowSpawnCellCandidates;
@group(0) @binding(2) var<storage, read_write> counter: FlowSpawnAtomic;
@group(0) @binding(3) var<storage, read_write> output: FlowParticleSpawnCandidates;
@group(0) @binding(4) var<storage, read_write> overflow: FlowSpawnAtomic;

fn FlowSpawn_identity(candidateIndex: u32) -> u32 {
    var value = candidateIndex + 0x9e3779b9u;
    value = (value ^ (value >> 16u)) * 0x85ebca6bu;
    value = (value ^ (value >> 13u)) * 0xc2b2ae35u;
    return value ^ (value >> 16u);
}

@compute @workgroup_size(64)
fn compactSpawnIndex(@builtin(global_invocation_id) globalId: vec3u) {
    let candidateIndex = globalId.x;
    if (candidateIndex >= spawnUniform.candidateCount) { return; }
    let candidate = candidates.values[candidateIndex];
    if (candidate.texelStepQuanta == 0u || candidate.texelStepQuanta > 0x7fffffffu) {
        return;
    }
    let side = spawnUniform.subcellSide;
    if (side != 1u && side != 2u && side != 4u) { return; }
    if (candidate.texelStepQuanta % side != 0u) { return; }
    let subcellStep = candidate.texelStepQuanta / side;
    if (subcellStep < 2u) { return; }
    var occupancy = 0u;
    for (var y = 0u; y < side; y++) {
        for (var x = 0u; x < side; x++) {
            let center = FlowVelocityAddress_advance_i32(candidate.origin, vec2i(
                i32(x * subcellStep + subcellStep / 2u),
                i32(y * subcellStep + subcellStep / 2u),
            ));
            if (center.north_south_valid != 0u &&
                FlowVelocity_spawn_possible(center.position, candidate.requestedLevel)) {
                occupancy |= 1u << (y * side + x);
            }
        }
    }
    if (occupancy == 0u) { return; }
    let outputIndex = atomicAdd(&counter.value, 1u);
    if (outputIndex >= spawnUniform.capacity) {
        atomicStore(&overflow.value, 1u);
        return;
    }
    output.values[outputIndex] = FlowParticleSpawnCandidate(
        candidate.origin,
        candidate.texelStepQuanta,
        candidate.requestedLevel,
        FlowSpawn_identity(candidateIndex),
        occupancy | (firstLeadingBit(side) << 16u),
    );
}
