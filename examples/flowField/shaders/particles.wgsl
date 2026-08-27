const FLOW_PARTICLE_DORMANT = 0u;
const FLOW_PARTICLE_ACTIVE = 1u;

struct FlowParticleRenderRecord {
    current: FlowVelocityAddressFixedPosition,
    previous: FlowVelocityAddressFixedPosition,
    velocity: vec2f,
    age_steps: u32,
    stagnant_steps: u32,
    random_state: u32,
    lifecycle_state: u32,
}

struct FlowParticleSegment {
    previous: FlowVelocityAddressFixedPosition,
    current: FlowVelocityAddressFixedPosition,
    velocity: vec2f,
    visible: u32,
}

@group(0) @binding(0) var<storage, read> flowParticleRenderRecords:
    array<FlowParticleRenderRecord>;

fn FlowParticles_segment(index: u32) -> FlowParticleSegment {
    let particle = flowParticleRenderRecords[index];
    return FlowParticleSegment(
        particle.previous,
        particle.current,
        particle.velocity,
        select(0u, 1u, particle.lifecycle_state == FLOW_PARTICLE_ACTIVE),
    );
}
