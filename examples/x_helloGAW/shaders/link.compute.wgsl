struct StaticUniformBlock {
    minDistance: f32,
    maxConnection: u32,
    groupSize: vec2u,
}

// Uniform bindings
@group(0) @binding(0) var<uniform> staticUniform: StaticUniformBlock;

// Storage bindings
@group(1) @binding(0) var<storage> particlePositions: array<f32>;
@group(1) @binding(1) var<storage, read_write> linkIndices: array<u32>;
@group(1) @binding(2) var<storage, read_write> connectionNums: array<atomic<u32>, 100>;
@group(1) @binding(3) var<storage, read_write> numConnected: array<atomic<u32>, 4>;

// Constants
override blockSize: u32;

fn getPosition(index: u32) -> vec3f {

    let x = particlePositions[index * 3 + 0];
    let y = particlePositions[index * 3 + 1];
    let z = particlePositions[index * 3 + 2];

    return vec3f(x, y, z);
}

@compute @workgroup_size(blockSize, blockSize, 1)
fn cMain(@builtin(global_invocation_id) id: vec3<u32>) {

    let aIndex = id.y * staticUniform.groupSize.x * blockSize + id.x;
    if (atomicLoad(&connectionNums[aIndex]) > staticUniform.maxConnection) {
        return;
    }

    let aPos = getPosition(aIndex);

    // for(var bIndex: u32 = aIndex + 1; bIndex < 100; bIndex++) {
    //     if (atomicLoad(&connectionNums[bIndex]) > staticUniform.maxConnection) {
    //         continue;
    //     }

    //     let bPos = getPosition(bIndex);
    //     let length = distance(aPos, bPos);

    //     if (aPos.z * bPos.z < 0) {
    //         continue;
    //     }
    //     if (length < staticUniform.minDistance) {
    //         atomicAdd(&connectionNums[aIndex], 1);
    //         atomicAdd(&connectionNums[bIndex], 1);

    //         let indexAddress = atomicAdd(&numConnected[1], 1);
    //         linkIndices[indexAddress * 2 + 0] = aIndex;
    //         linkIndices[indexAddress * 2 + 1] = bIndex;
            
    //     }
    // }

    var minPropDistance: f32 = 0.0;
    var minIndex: u32 = 0;
    for(var bIndex: u32 = aIndex + 1; bIndex < 100; bIndex++) {
        if (atomicLoad(&connectionNums[bIndex]) > staticUniform.maxConnection) {
            continue;
        }

        minPropDistance = distance(aPos, getPosition(bIndex));
        minIndex = bIndex;

        for (var cIndex: u32 = bIndex + 1; cIndex < 100; cIndex++) {
            if (atomicLoad(&connectionNums[cIndex]) > staticUniform.maxConnection) {
                continue;
            }
            let distance = distance(aPos, getPosition(cIndex));
            if (distance < minPropDistance) {
                minPropDistance = distance;
                minIndex = cIndex;
            }
        }

        if (minPropDistance < staticUniform.minDistance) {
            atomicAdd(&connectionNums[aIndex], 1);
            atomicAdd(&connectionNums[minIndex], 1);

            let indexAddress = atomicAdd(&numConnected[1], 1);
            linkIndices[indexAddress * 2 + 0] = aIndex;
            linkIndices[indexAddress * 2 + 1] = minIndex;
            
        } else {
            return;
        }
    }
}