struct StaticUniformBlock {
    rLink: f32,
    groupSize: vec2u,
    angle: f32,
}

// Uniform bindings
@group(0) @binding(0) var<uniform> staticUniform: StaticUniformBlock;

// Storage bindings
@group(1) @binding(0) var<storage> velocities: array<f32>;
@group(1) @binding(1) var<storage, read_write> positions: array<f32>;

// Constants
override blockSize: u32;

fn rotateVector(v: vec3f, axis: vec3f, angle: f32) -> vec3f {

    let cosTheta = cos(angle);
    let sinTheta = sin(angle);

    return v * cosTheta + cross(axis, v) * sinTheta + axis * dot(axis, v) * (1.0 - cosTheta);
}

@compute @workgroup_size(blockSize, blockSize, 1)
fn cMain(@builtin(global_invocation_id) id: vec3<u32>) {

    let index = id.y * staticUniform.groupSize.x * blockSize + id.x;
    let x = positions[index * 3 + 0];
    let y = positions[index * 3 + 1];
    let z = positions[index * 3 + 2];
    let vx = velocities[index * 3 + 0];
    let vy = velocities[index * 3 + 1];
    let vz = velocities[index * 3 + 2];
    let position = vec3f(x, y, z);
    let velocity = vec3f(vx, vy, vz);

    let newPos = rotateVector(normalize(position), normalize(velocity), staticUniform.angle) * staticUniform.rLink;
    positions[index * 3 + 0] = newPos.x;
    positions[index * 3 + 1] = newPos.y;
    positions[index * 3 + 2] = newPos.z;

}