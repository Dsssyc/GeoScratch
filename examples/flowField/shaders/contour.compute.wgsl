struct FlowContourCandidateCell {
    origin: FlowVelocityAddressFixedPosition,
    texelStepQuanta: u32,
    requestedLevel: u32,
    reserved: vec2u,
};

struct FlowContourEndpoint {
    x: vec2u,
    y: vec2u,
};

struct FlowContourSegment {
    first: FlowContourEndpoint,
    second: FlowContourEndpoint,
};

struct FlowContourUniform {
    candidateCount: u32,
    segmentCapacity: u32,
    generation: u32,
    reservedU32: u32,
    progress: f32,
    activityKill: f32,
    currentSnapshotEpoch: u32,
    nextSnapshotEpoch: u32,
};

struct FlowContourCandidates {
    values: array<FlowContourCandidateCell>,
};

struct FlowContourSegments {
    values: array<FlowContourSegment>,
};

struct FlowContourIndirect {
    vertexCount: atomic<u32>,
    instanceCount: u32,
    firstVertex: u32,
    firstInstance: u32,
};

struct FlowContourAtomic {
    value: atomic<u32>,
};

struct FlowContourCornerSample {
    position: FlowVelocityAddressFixedPosition,
    value: f32,
    available: u32,
};

@group(0) @binding(0) var<uniform> contourUniform: FlowContourUniform;
@group(0) @binding(1) var<storage, read> candidateCells: FlowContourCandidates;
@group(0) @binding(2) var<storage, read_write> segments: FlowContourSegments;
@group(0) @binding(3) var<storage, read_write> indirect: FlowContourIndirect;
@group(0) @binding(4) var<storage, read_write> overflow: FlowContourAtomic;

fn contourCornerPosition(
    cell: FlowContourCandidateCell,
    corner: u32,
) -> FlowVelocityAddressFixedPosition {
    let offset = array<vec2u, 4>(
        vec2u(0u, 0u),
        vec2u(1u, 0u),
        vec2u(1u, 1u),
        vec2u(0u, 1u),
    )[corner] * cell.texelStepQuanta;
    return FlowVelocityAddress_advance_i32(
        cell.origin,
        vec2i(i32(offset.x), i32(offset.y)),
    ).position;
}

fn contourCornerSample(
    cell: FlowContourCandidateCell,
    corner: u32,
) -> FlowContourCornerSample {
    let position = contourCornerPosition(cell, corner);
    let sample = FlowVelocity_sample(
        position,
        cell.requestedLevel,
        FlowVelocityTemporal(contourUniform.progress, contourUniform.activityKill),
    );
    return FlowContourCornerSample(
        position,
        sample.speed - contourUniform.activityKill,
        select(0u, 1u, sample.status == 1u || sample.status == 2u),
    );
}

fn contourInterpolation(first: f32, second: f32) -> f32 {
    let denominator = first - second;
    if (denominator == 0.0) { return 0.5; }
    return clamp(first / denominator, 0.0, 1.0);
}

fn contourEdgePosition(
    cell: FlowContourCandidateCell,
    values: array<f32, 4>,
    edge: u32,
) -> FlowVelocityAddressFixedPosition {
    let step = cell.texelStepQuanta;
    var offset = vec2u(0u);
    switch edge {
        case 0u: {
            offset.x = u32(round(contourInterpolation(values[0], values[1]) * f32(step)));
        }
        case 1u: {
            offset = vec2u(
                step,
                u32(round(contourInterpolation(values[1], values[2]) * f32(step))),
            );
        }
        case 2u: {
            offset = vec2u(
                step - u32(round(contourInterpolation(values[2], values[3]) * f32(step))),
                step,
            );
        }
        default: {
            offset.y = step - u32(round(
                contourInterpolation(values[3], values[0]) * f32(step),
            ));
        }
    }
    return FlowVelocityAddress_advance_i32(
        cell.origin,
        vec2i(i32(offset.x), i32(offset.y)),
    ).position;
}

fn contourEndpoint(position: FlowVelocityAddressFixedPosition) -> FlowContourEndpoint {
    return FlowContourEndpoint(
        vec2u(position.axes[0].low, position.axes[0].high),
        vec2u(position.axes[1].low, position.axes[1].high),
    );
}

fn contourReserve(segmentCount: u32) -> u32 {
    let vertexCount = segmentCount * 2u;
    loop {
        let current = atomicLoad(&indirect.vertexCount);
        let maximumVertexCount = contourUniform.segmentCapacity * 2u;
        if (current > maximumVertexCount || vertexCount > maximumVertexCount - current) {
            atomicStore(&overflow.value, 1u);
            return 0xffffffffu;
        }
        let exchanged = atomicCompareExchangeWeak(
            &indirect.vertexCount,
            current,
            current + vertexCount,
        );
        if (exchanged.exchanged) { return current / 2u; }
    }
}

fn contourEmit(
    cell: FlowContourCandidateCell,
    values: array<f32, 4>,
    edgePairs: vec4u,
    segmentCount: u32,
) {
    let firstSegment = contourReserve(segmentCount);
    if (firstSegment == 0xffffffffu) { return; }
    segments.values[firstSegment] = FlowContourSegment(
        contourEndpoint(contourEdgePosition(cell, values, edgePairs.x)),
        contourEndpoint(contourEdgePosition(cell, values, edgePairs.y)),
    );
    if (segmentCount == 2u) {
        segments.values[firstSegment + 1u] = FlowContourSegment(
            contourEndpoint(contourEdgePosition(cell, values, edgePairs.z)),
            contourEndpoint(contourEdgePosition(cell, values, edgePairs.w)),
        );
    }
}

@compute @workgroup_size(64)
fn generateFlowContour(@builtin(global_invocation_id) globalId: vec3u) {
    let candidateIndex = globalId.x;
    if (candidateIndex >= contourUniform.candidateCount) { return; }
    let cell = candidateCells.values[candidateIndex];
    var corners: array<FlowContourCornerSample, 4>;
    var values: array<f32, 4>;
    var code = 0u;
    for (var corner = 0u; corner < 4u; corner++) {
        corners[corner] = contourCornerSample(cell, corner);
        if (corners[corner].available == 0u) { return; }
        values[corner] = corners[corner].value;
        if (values[corner] >= 0.0) { code |= 1u << corner; }
    }
    let determinant = values[0] * values[2] - values[1] * values[3];
    switch code {
        case 1u: { contourEmit(cell, values, vec4u(3u, 0u, 0u, 0u), 1u); }
        case 2u: { contourEmit(cell, values, vec4u(0u, 1u, 0u, 0u), 1u); }
        case 3u: { contourEmit(cell, values, vec4u(3u, 1u, 0u, 0u), 1u); }
        case 4u: { contourEmit(cell, values, vec4u(1u, 2u, 0u, 0u), 1u); }
        case 5u: {
            if (determinant >= 0.0) {
                contourEmit(cell, values, vec4u(0u, 1u, 2u, 3u), 2u);
            } else {
                contourEmit(cell, values, vec4u(3u, 0u, 1u, 2u), 2u);
            }
        }
        case 6u: { contourEmit(cell, values, vec4u(0u, 2u, 0u, 0u), 1u); }
        case 7u: { contourEmit(cell, values, vec4u(3u, 2u, 0u, 0u), 1u); }
        case 8u: { contourEmit(cell, values, vec4u(2u, 3u, 0u, 0u), 1u); }
        case 9u: { contourEmit(cell, values, vec4u(0u, 2u, 0u, 0u), 1u); }
        case 10u: {
            if (determinant >= 0.0) {
                contourEmit(cell, values, vec4u(3u, 0u, 1u, 2u), 2u);
            } else {
                contourEmit(cell, values, vec4u(0u, 1u, 2u, 3u), 2u);
            }
        }
        case 11u: { contourEmit(cell, values, vec4u(1u, 2u, 0u, 0u), 1u); }
        case 12u: { contourEmit(cell, values, vec4u(1u, 3u, 0u, 0u), 1u); }
        case 13u: { contourEmit(cell, values, vec4u(0u, 1u, 0u, 0u), 1u); }
        case 14u: { contourEmit(cell, values, vec4u(3u, 0u, 0u, 0u), 1u); }
        default: {}
    }
}
