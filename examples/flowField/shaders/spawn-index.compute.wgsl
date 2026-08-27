struct FlowSpawnCandidate {
    position: FlowVelocityAddressFixedPosition,
    requestedLevel: u32,
    identity: u32,
    reserved: vec2u,
};

struct FlowSpawnUniform {
    candidateCount: u32,
    capacity: u32,
    generation: u32,
    reservedU32: u32,
    progress: f32,
    activitySpawn: f32,
    activityKill: f32,
    reservedF32: f32,
};

struct FlowSpawnCandidates {
    values: array<FlowSpawnCandidate>,
};

struct FlowSpawnAtomic {
    value: atomic<u32>,
};

@group(0) @binding(0) var<uniform> spawnUniform: FlowSpawnUniform;
@group(0) @binding(1) var<storage, read> candidates: FlowSpawnCandidates;
@group(0) @binding(2) var<storage, read_write> counter: FlowSpawnAtomic;
@group(0) @binding(3) var<storage, read_write> output: FlowSpawnCandidates;
@group(0) @binding(4) var<storage, read_write> overflow: FlowSpawnAtomic;

@compute @workgroup_size(64)
fn compactSpawnIndex(@builtin(global_invocation_id) globalId: vec3u) {
    let candidateIndex = globalId.x;
    if (candidateIndex >= spawnUniform.candidateCount) {
        return;
    }
    let candidate = candidates.values[candidateIndex];
    let sample = FlowVelocity_sample(
        candidate.position,
        candidate.requestedLevel,
        FlowVelocityTemporal(spawnUniform.progress, spawnUniform.activityKill)
    );
    if (sample.status == 0u || sample.speed < spawnUniform.activitySpawn) {
        return;
    }
    let outputIndex = atomicAdd(&counter.value, 1u);
    if (outputIndex >= spawnUniform.capacity) {
        atomicStore(&overflow.value, 1u);
        return;
    }
    output.values[outputIndex] = candidate;
}
