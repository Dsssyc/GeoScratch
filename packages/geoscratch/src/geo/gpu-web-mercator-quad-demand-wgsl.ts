export const GPU_WEB_MERCATOR_QUAD_DEMAND_WGSL = String.raw`
@group(0) @binding(0)
var<uniform> mapMeta: GpuWebMercatorQuadCoverMapMeta;
@group(0) @binding(1)
var<uniform> demandPolicy: GpuWebMercatorQuadDemandPolicy;
@group(0) @binding(2)
var<storage, read> sourceLimits: array<GpuWebMercatorQuadDemandLimit>;
@group(0) @binding(3)
var<storage, read> coverPatches: array<GpuWebMercatorQuadCoverPatch>;
@group(0) @binding(4)
var<storage, read> coverState: GpuWebMercatorQuadCoverState;
@group(0) @binding(5)
var<storage, read_write> projectionState: GpuWebMercatorQuadDemandState;
@group(0) @binding(6)
var<storage, read_write> projectedDemands: array<GpuWebMercatorQuadDemand>;

fn demandSourceLimit(matrixLevel: u32) -> GpuWebMercatorQuadDemandLimit {
    return sourceLimits[matrixLevel - demandPolicy.minimumSourceMatrixLevel];
}

fn demandSourceContains(matrixLevel: u32, tileRow: u32, tileCol: u32) -> bool {
    if (matrixLevel < demandPolicy.minimumSourceMatrixLevel ||
        matrixLevel > demandPolicy.sourceMaximumMatrixLevel) {
        return false;
    }
    let limit = demandSourceLimit(matrixLevel);
    return tileRow >= limit.minTileRow && tileRow <= limit.maxTileRow &&
        tileCol >= limit.minTileCol && tileCol <= limit.maxTileCol;
}

fn demandCameraTileIndex(low: u32, high: u32, matrixLevel: u32) -> u32 {
    let shift = demandPolicy.coordinateBits - matrixLevel;
    if (shift >= 32u) {
        return high >> (shift - 32u);
    }
    if (shift == 0u) {
        return low;
    }
    return (high << (32u - shift)) | (low >> shift);
}

fn demandPriority(
    desiredSampleLevel: u32,
    requestLevel: u32,
    tileRow: u32,
    tileCol: u32,
) -> u32 {
    let cameraRow = demandCameraTileIndex(
        mapMeta.cameraFixedLow.y,
        mapMeta.cameraFixedHigh.y,
        requestLevel,
    );
    let cameraCol = demandCameraTileIndex(
        mapMeta.cameraFixedLow.x,
        mapMeta.cameraFixedHigh.x,
        requestLevel,
    );
    let rowDistance = u32(abs(i32(tileRow) - i32(cameraRow)));
    let rawColDistance = u32(abs(i32(tileCol) - i32(cameraCol)));
    let matrixWidth = 1u << requestLevel;
    let colDistance = min(rawColDistance, matrixWidth - rawColDistance);
    return desiredSampleLevel * 1000000u + 999999u -
        min(rowDistance + colDistance, 999999u);
}

fn demandExistingIndex(matrixLevel: u32, tileRow: u32, tileCol: u32) -> u32 {
    for (var index = 0u; index < projectionState.demandCount; index += 1u) {
        let demand = projectedDemands[index];
        if (demand.requestMatrixLevel == matrixLevel &&
            demand.tileRow == tileRow && demand.tileCol == tileCol) {
            return index;
        }
    }
    return 0xffffffffu;
}

fn demandEmit(candidate: GpuWebMercatorQuadCoverPatch) {
    var requestLevel = min(
        candidate.matrixLevel,
        demandPolicy.sourceMaximumMatrixLevel,
    );
    var shift = candidate.matrixLevel - requestLevel;
    var tileRow = candidate.tileRow >> shift;
    var tileCol = candidate.tileCol >> shift;
    loop {
        if (demandSourceContains(requestLevel, tileRow, tileCol)) { break; }
        if (requestLevel <= demandPolicy.minimumSourceMatrixLevel) { return; }
        requestLevel -= 1u;
        shift += 1u;
        tileRow = candidate.tileRow >> shift;
        tileCol = candidate.tileCol >> shift;
    }
    let priority = demandPriority(
        candidate.matrixLevel,
        requestLevel,
        tileRow,
        tileCol,
    );
    let existing = demandExistingIndex(requestLevel, tileRow, tileCol);
    if (existing != 0xffffffffu) {
        projectedDemands[existing].desiredSampleLevel = max(
            projectedDemands[existing].desiredSampleLevel,
            candidate.matrixLevel,
        );
        projectedDemands[existing].priority = max(
            projectedDemands[existing].priority,
            priority,
        );
        return;
    }
    let outputIndex = projectionState.demandCount;
    if (outputIndex >= demandPolicy.maximumDemands) {
        projectionState.overflowCount += 1u;
        return;
    }
    projectedDemands[outputIndex] = GpuWebMercatorQuadDemand(
        candidate.matrixLevel,
        demandPolicy.sourceMaximumMatrixLevel,
        requestLevel,
        tileRow,
        tileCol,
        priority,
        mapMeta.frameEpoch,
        mapMeta.residencySnapshotEpoch,
    );
    projectionState.demandCount += 1u;
}

@compute @workgroup_size(1)
fn projectWebMercatorQuadDemands() {
    projectionState.frameEpoch = mapMeta.frameEpoch;
    projectionState.demandCount = 0u;
    projectionState.overflowCount = 0u;
    projectionState.sourceLevelCeiling = demandPolicy.sourceMaximumMatrixLevel;
    if (coverState.frameEpoch != mapMeta.frameEpoch ||
        coverState.descriptorOverflowCount != 0u ||
        coverState.lookupOverflowCount != 0u ||
        coverState.maximumAdjacentLevelDelta > 1u) {
        // Preserve failure in feedback without projecting a partial geometry cut.
        projectionState.overflowCount = 1u;
        return;
    }
    for (var patchIndex = 0u; patchIndex < coverState.patchCount; patchIndex += 1u) {
        demandEmit(coverPatches[patchIndex]);
    }
}
`
