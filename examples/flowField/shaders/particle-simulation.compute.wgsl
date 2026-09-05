const FLOW_PARTICLE_DORMANT = 0u;
const FLOW_PARTICLE_ACTIVE = 1u;
const FLOW_PARTICLE_WORKGROUP_SIZE = 256u;
override FLOW_PARTICLES_REFILL_ENABLED = false;

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
    maximum_speed: f32,
    view_enabled: u32,
    refill_view: u32,
    reserved_3: u32,
    clip_from_relative_world: mat4x4f,
    camera_x: vec2u,
    camera_y: vec2u,
    camera_z: vec2f,
    meters_per_quantum: f32,
    reserved_view: vec3f,
    previous_clip_from_relative_world: mat4x4f,
    previous_camera_x: vec2u,
    previous_camera_y: vec2u,
    previous_camera_z: vec2f,
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
    return (sample.status == 1u || sample.status == 2u) && sample.advectable && sample.speed > 0.0;
}

fn FlowParticles_relative_meters(value: FlowVelocityAddressFixedAxis, origin: vec2u) -> f32 {
    let borrow = select(0u, 1u, value.low < origin.x);
    var low = value.low - origin.x;
    var high = value.high - origin.y - borrow;
    let negative = (high & 0x80000000u) != 0u;
    if (negative) {
        low = ~low + 1u;
        high = ~high + select(0u, 1u, low == 0u);
    }
    let meters = f32(high) * ldexp(flowParticleConfig.meters_per_quantum, 32) +
        f32(low) * flowParticleConfig.meters_per_quantum;
    return select(meters, -meters, negative);
}

fn FlowParticles_in_camera(position: FlowVelocityAddressFixedPosition,
    matrix: mat4x4f, camera_x: vec2u, camera_y: vec2u, camera_z: vec2f) -> bool {
    let relative = vec4f(
        FlowParticles_relative_meters(position.axes[0], camera_x),
        -FlowParticles_relative_meters(position.axes[1], camera_y),
        -(camera_z.x + camera_z.y),
        1.0,
    );
    let clip = matrix * relative;
    return clip.w > 0.0 && all(abs(clip.xy) <= vec2f(clip.w)) &&
        clip.z >= 0.0 && clip.z <= clip.w;
}

fn FlowParticles_in_view(position: FlowVelocityAddressFixedPosition) -> bool {
    // Keep the reference hot path specialized to its current-camera uniforms.
    if (flowParticleConfig.view_enabled == 0u) { return true; }
    let relative = vec4f(
        FlowParticles_relative_meters(position.axes[0], flowParticleConfig.camera_x),
        -FlowParticles_relative_meters(position.axes[1], flowParticleConfig.camera_y),
        -(flowParticleConfig.camera_z.x + flowParticleConfig.camera_z.y),
        1.0,
    );
    let clip = flowParticleConfig.clip_from_relative_world * relative;
    return clip.w > 0.0 && all(abs(clip.xy) <= vec2f(clip.w)) &&
        clip.z >= 0.0 && clip.z <= clip.w;
}

fn FlowParticles_in_previous_view(position: FlowVelocityAddressFixedPosition) -> bool {
    return FlowParticles_in_camera(position, flowParticleConfig.previous_clip_from_relative_world,
        flowParticleConfig.previous_camera_x, flowParticleConfig.previous_camera_y,
        flowParticleConfig.previous_camera_z);
}

@compute @workgroup_size(256)
fn FlowParticles_build_refill_index(@builtin(global_invocation_id) id: vec3u) {
    if (id.x >= FlowSpawnIndex_candidate_count()) { return; }
    let center = FlowSpawnIndex_candidate_center(id.x);
    if (center.north_south_valid == 0u || !FlowParticles_in_view(center.position)) { return; }
    let was_visible = FlowParticles_in_previous_view(center.position);
    FlowSpawnIndex_record_visible(id.x, !was_visible);
}

fn FlowParticles_canonical_displacement(
    position: FlowVelocityAddressFixedPosition,
    ground_meters: vec2f,
) -> vec2f {
    // Only latitude is reduced to a world fraction. Canonical position stays wide-fixed.
    let address = FlowVelocityAddress_address(position, 0u);
    let normalized_y = (f32(address.texel.y) + address.sub_texel.y) / 256.0;
    let latitude_mercator = 3.141592653589793 * (1.0 - 2.0 * normalized_y);
    let secant_latitude = (exp(latitude_mercator) + exp(-latitude_mercator)) * 0.5;
    // Flow Layer uses a 6371000m sphere for displacement; WebMercator uses 6378137m.
    let projected_scale = secant_latitude * (6378137.0 / 6371000.0);
    // U/V are east/north; canonical addresses grow east/south.
    return vec2f(ground_meters.x, -ground_meters.y) * projected_scale;
}

fn FlowParticles_dormant(particle: ptr<function, FlowParticle>) {
    (*particle).previous = (*particle).current;
    (*particle).velocity = vec2f(0.0);
    (*particle).age_steps = 0u;
    (*particle).stagnant_steps = 0u;
    (*particle).lifecycle_state = FLOW_PARTICLE_DORMANT;
    atomicAdd(&flowParticleCounters.dormant_count, 1u);
}

fn FlowParticles_rebirth(particle: ptr<function, FlowParticle>, refill: bool) -> bool {
    (*particle).random_state = FlowParticles_random(
        (*particle).random_state ^ flowParticleConfig.frame_seed
    );
    var selection = FlowSpawnIndex_select((*particle).random_state);
    if (FLOW_PARTICLES_REFILL_ENABLED && refill) {
        selection = FlowSpawnIndex_select_refill((*particle).random_state);
    }
    if (selection.available == 0u) {
        FlowParticles_dormant(particle);
        return false;
    }
    let sample = FlowVelocity_sample(
        selection.position,
        selection.requested_level,
        FlowParticles_temporal(),
    );
    if (!FlowParticles_available(sample) || sample.speed < flowParticleConfig.activity_spawn ||
        !FlowParticles_in_view(selection.position) ||
        (FLOW_PARTICLES_REFILL_ENABLED && refill && FlowParticles_in_previous_view(selection.position))) {
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
        !FlowParticles_in_view(particle.current) ||
        sample.speed < flowParticleConfig.activity_kill ||
        particle.age_steps >= flowParticleConfig.maximum_age_steps ||
        particle.stagnant_steps >= flowParticleConfig.maximum_stagnant_steps;

    particle.random_state = FlowParticles_random(particle.random_state ^ flowParticleConfig.frame_seed);
    let drop_probability = clamp(0.003 + 0.001 * sample.speed /
        flowParticleConfig.maximum_speed, 0.0, 1.0);
    let random_fraction = f32(particle.random_state >> 8u) / 16777216.0;
    retire = retire || random_fraction < drop_probability;
    var refill = false;
    if (FLOW_PARTICLES_REFILL_ENABLED && flowParticleConfig.refill_view != 0u) {
        let quota = FlowSpawnIndex_refill_quota(flowParticleConfig.particle_count);
        let cohort_offset = FlowParticles_random(flowParticleConfig.frame_seed * 0x9e3779b9u) %
            flowParticleConfig.particle_count;
        refill = (index + cohort_offset) % flowParticleConfig.particle_count < quota;
    }
    retire = retire || refill;

    if (!retire) {
        let old_position = particle.current;
        var candidate = particle.current;
        var displacement_meters = vec2f(0.0);
        for (var substep = 0u; substep < flowParticleConfig.substeps; substep++) {
            let delta_meters = sample.velocity * flowParticleConfig.time_step *
                flowParticleConfig.legacy_displacement_scale /
                f32(flowParticleConfig.substeps);
            let advanced = FlowScreen_advance_meters(
                candidate,
                FlowParticles_canonical_displacement(candidate, delta_meters),
            );
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
            if (!FlowParticles_available(sample) || !FlowParticles_in_view(candidate) ||
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
        _ = FlowParticles_rebirth(&particle, refill);
    }
    flowParticles[index] = particle;
}
