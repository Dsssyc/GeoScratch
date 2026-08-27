const FLOW_PARTICLE_DORMANT = 0u;
const FLOW_PARTICLE_ACTIVE = 1u;
const FLOW_PARTICLE_WORKGROUP_SIZE = 256u;

struct FlowParticle {
    current: FlowVelocityAddressFixedPosition,
    previous: FlowVelocityAddressFixedPosition,
    velocity: vec2f,
    age_steps: u32,
    stagnant_steps: u32,
    random_state: u32,
    lifecycle_state: u32,
}

struct FlowParticleConfig {
    particle_count: u32,
    requested_level: u32,
    substeps: u32,
    maximum_age_steps: u32,
    maximum_stagnant_steps: u32,
    frame_seed: u32,
    progress: f32,
    activity_spawn: f32,
    activity_kill: f32,
    time_step: f32,
    minimum_displacement_meters: f32,
    legacy_displacement_scale: f32,
    reserved_0: u32,
    reserved_1: u32,
    reserved_2: u32,
    reserved_3: u32,
}

struct FlowParticleCounters {
    active_count: atomic<u32>,
    dormant_count: atomic<u32>,
    retired_count: atomic<u32>,
    reserved_count: atomic<u32>,
}

@group(0) @binding(0) var<uniform> flowParticleConfig: FlowParticleConfig;
@group(0) @binding(1) var<storage, read_write> flowParticles: array<FlowParticle>;
@group(0) @binding(2) var<storage, read_write> flowParticleCounters: FlowParticleCounters;

fn FlowParticles_random(value: u32) -> u32 {
    var state = select(value, 0x9e3779b9u, value == 0u);
    state ^= state << 13u;
    state ^= state >> 17u;
    state ^= state << 5u;
    return state;
}

fn FlowParticles_temporal() -> FlowVelocityTemporal {
    return FlowVelocityTemporal(flowParticleConfig.progress, flowParticleConfig.activity_kill);
}

fn FlowParticles_available(sample: FlowVelocitySample) -> bool {
    return (sample.status == 1u || sample.status == 2u) && sample.advectable;
}

fn FlowParticles_dormant(particle: ptr<function, FlowParticle>) {
    (*particle).previous = (*particle).current;
    (*particle).velocity = vec2f(0.0);
    (*particle).age_steps = 0u;
    (*particle).stagnant_steps = 0u;
    (*particle).lifecycle_state = FLOW_PARTICLE_DORMANT;
    atomicAdd(&flowParticleCounters.dormant_count, 1u);
}

fn FlowParticles_rebirth(particle: ptr<function, FlowParticle>) -> bool {
    (*particle).random_state = FlowParticles_random(
        (*particle).random_state ^ flowParticleConfig.frame_seed
    );
    let selection = FlowSpawnIndex_select((*particle).random_state);
    if (selection.available == 0u) {
        FlowParticles_dormant(particle);
        return false;
    }
    let sample = FlowVelocity_sample(
        selection.position,
        selection.requested_level,
        FlowParticles_temporal(),
    );
    if (!FlowParticles_available(sample) || sample.speed < flowParticleConfig.activity_spawn) {
        FlowParticles_dormant(particle);
        return false;
    }
    (*particle).current = selection.position;
    (*particle).previous = selection.position;
    (*particle).velocity = vec2f(0.0);
    (*particle).age_steps = 0u;
    (*particle).stagnant_steps = 0u;
    (*particle).lifecycle_state = FLOW_PARTICLE_ACTIVE;
    atomicAdd(&flowParticleCounters.active_count, 1u);
    return true;
}

@compute @workgroup_size(256)
fn FlowParticles_simulate(@builtin(global_invocation_id) global_id: vec3u) {
    let index = global_id.x;
    if (index >= flowParticleConfig.particle_count) { return; }
    var particle = flowParticles[index];
    if (particle.random_state == 0u) {
        particle.random_state = FlowParticles_random(index + 1u);
    }

    var retire = particle.lifecycle_state != FLOW_PARTICLE_ACTIVE;
    var sample = FlowVelocity_sample(
        particle.current,
        flowParticleConfig.requested_level,
        FlowParticles_temporal(),
    );
    retire = retire || !FlowParticles_available(sample) ||
        sample.speed < flowParticleConfig.activity_kill ||
        particle.age_steps >= flowParticleConfig.maximum_age_steps ||
        particle.stagnant_steps >= flowParticleConfig.maximum_stagnant_steps;

    if (!retire) {
        let old_position = particle.current;
        var candidate = particle.current;
        var displacement_meters = vec2f(0.0);
        for (var substep = 0u; substep < flowParticleConfig.substeps; substep++) {
            let delta_meters = sample.velocity * flowParticleConfig.time_step *
                flowParticleConfig.legacy_displacement_scale /
                f32(flowParticleConfig.substeps);
            let advanced = FlowVelocityAddress_advance_meters(candidate, delta_meters);
            if (advanced.north_south_valid == 0u) {
                retire = true;
                break;
            }
            candidate = advanced.position;
            displacement_meters += delta_meters;
            sample = FlowVelocity_sample(
                candidate,
                flowParticleConfig.requested_level,
                FlowParticles_temporal(),
            );
            if (!FlowParticles_available(sample) ||
                sample.speed < flowParticleConfig.activity_kill) {
                retire = true;
                break;
            }
        }
        if (!retire) {
            particle.previous = old_position;
            particle.current = candidate;
            particle.velocity = sample.velocity;
            particle.age_steps = min(0xffffffffu, particle.age_steps + 1u);
            particle.stagnant_steps = select(
                min(0xffffffffu, particle.stagnant_steps + 1u),
                0u,
                length(displacement_meters) >= flowParticleConfig.minimum_displacement_meters,
            );
            atomicAdd(&flowParticleCounters.active_count, 1u);
        }
    }

    if (retire) {
        if (particle.lifecycle_state == FLOW_PARTICLE_ACTIVE) {
            atomicAdd(&flowParticleCounters.retired_count, 1u);
        }
        _ = FlowParticles_rebirth(&particle);
    }
    flowParticles[index] = particle;
}
