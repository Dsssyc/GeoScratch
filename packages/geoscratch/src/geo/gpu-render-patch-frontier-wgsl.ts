export const GPU_RENDER_PATCH_FRONTIER_WGSL = String.raw`
struct GpuRenderPatchState {
    count: atomic<u32>,
    overflowCount: atomic<u32>,
    lookupOverflowCount: atomic<u32>,
    minimumMatrixLevel: atomic<u32>,
    maximumMatrixLevel: atomic<u32>,
    minimumCellSpanQ8: atomic<u32>,
    maximumCellSpanQ8: atomic<u32>,
    frameEpoch: atomic<u32>,
    baselinePatchBudget: atomic<u32>,
    framePatchBudget: atomic<u32>,
    requestedPatchCount: atomic<u32>,
    selectedBiasStep: atomic<u32>,
    minimumTrialPatchCount: atomic<u32>,
    trialCounts: array<atomic<u32>, 17>,
    unbalancedPatchCount: atomic<u32>,
    balanceSplitCount: atomic<u32>,
    maximumAdjacentLevelDelta: atomic<u32>,
    balancePassCount: atomic<u32>,
    balanceScratchCount: atomic<u32>,
    budgetFillSplitCount: atomic<u32>,
    budgetLimitedRefinementCount: atomic<u32>,
};

struct GpuRenderPatchAtomicLookupEntry {
    key: atomic<u32>,
    patchIndex: u32,
};

struct GpuRenderPatchBounds {
    minimum: vec3f,
    maximum: vec3f,
};

struct GpuRenderPatchPlane {
    normal: vec3f,
    distance: f32,
};

struct GpuRenderPatchQuanta {
    low: u32,
    high: u32,
};

struct GpuRenderPatchClipPolygon {
    vertices: array<vec4f, 12>,
    count: u32,
};

@group(0) @binding(0) var<uniform> mapMeta: GpuTileFrontierMapMeta;
@group(0) @binding(1) var<uniform> renderPatchPolicy: GpuRenderPatchPolicy;
@group(0) @binding(2) var<storage, read> renderRoots: array<GpuRenderPatch>;
@group(0) @binding(4) var<storage, read_write> renderPatches: array<GpuRenderPatch>;
@group(0) @binding(5) var<storage, read_write> renderPatchState: GpuRenderPatchState;
@group(0) @binding(6) var<storage, read_write> drawArguments: array<u32>;
@group(0) @binding(7) var<storage, read_write> renderPatchLookup:
    array<GpuRenderPatchAtomicLookupEntry>;
@group(0) @binding(8) var<storage, read_write> balancePatches: array<GpuRenderPatch>;
@group(0) @binding(9) var<storage, read_write> balancePatchLookup:
    array<GpuRenderPatchAtomicLookupEntry>;
var<workgroup> balanceIterationSplitCount: atomic<u32>;

const WEB_MERCATOR_WORLD_WIDTH_METERS: f32 = 40075016.0f;

fn subtractExpansions(
    leftHigh: f32,
    leftLow: f32,
    rightHigh: f32,
    rightLow: f32,
) -> f32 {
    let lowDifference = leftLow - rightLow;
    if (leftHigh == rightHigh) {
        return lowDifference;
    }
    let difference = leftHigh - rightHigh;
    let bridge = difference - leftHigh;
    let roundoff = (leftHigh - (difference - bridge)) - (rightHigh + bridge);
    return difference + (roundoff + leftLow - rightLow);
}

fn boundaryQuanta(index: u32, matrixLevel: u32) -> GpuRenderPatchQuanta {
    let shift = renderPatchPolicy.coordinateBits - matrixLevel;
    if (shift >= 32u) {
        return GpuRenderPatchQuanta(0u, index << (shift - 32u));
    }
    if (shift == 0u) {
        return GpuRenderPatchQuanta(index, 0u);
    }
    return GpuRenderPatchQuanta(index << shift, index >> (32u - shift));
}

fn subtractQuanta(
    left: GpuRenderPatchQuanta,
    right: GpuRenderPatchQuanta,
) -> GpuRenderPatchQuanta {
    let borrow = select(0u, 1u, left.low < right.low);
    return GpuRenderPatchQuanta(
        left.low - right.low,
        left.high - right.high - borrow,
    );
}

fn quantaMagnitude(value: GpuRenderPatchQuanta) -> GpuRenderPatchQuanta {
    if ((value.high & 0x80000000u) == 0u) {
        return value;
    }
    let low = ~value.low + 1u;
    let carry = select(0u, 1u, low == 0u);
    return GpuRenderPatchQuanta(low, ~value.high + carry);
}

fn relativeQuantaMeters(
    left: GpuRenderPatchQuanta,
    right: GpuRenderPatchQuanta,
) -> f32 {
    let difference = subtractQuanta(left, right);
    let negative = (difference.high & 0x80000000u) != 0u;
    let magnitude = quantaMagnitude(difference);
    let quantumMeters = ldexp(
        WEB_MERCATOR_WORLD_WIDTH_METERS,
        -i32(renderPatchPolicy.coordinateBits),
    );
    let highLimbMeters = ldexp(quantumMeters, 32);
    let meters = f32(magnitude.high) * highLimbMeters +
        f32(magnitude.low) * quantumMeters;
    return select(meters, -meters, negative);
}

fn patchBounds(matrixLevel: u32, row: u32, column: u32) -> GpuRenderPatchBounds {
    let west = boundaryQuanta(column, matrixLevel);
    let east = boundaryQuanta(column + 1u, matrixLevel);
    let north = boundaryQuanta(row, matrixLevel);
    let south = boundaryQuanta(row + 1u, matrixLevel);
    let cameraX = GpuRenderPatchQuanta(
        mapMeta.cameraFixedLow.x,
        mapMeta.cameraFixedHigh.x,
    );
    let cameraY = GpuRenderPatchQuanta(
        mapMeta.cameraFixedLow.y,
        mapMeta.cameraFixedHigh.y,
    );
    let minimumX = relativeQuantaMeters(west, cameraX);
    let maximumX = relativeQuantaMeters(east, cameraX);
    let maximumY = relativeQuantaMeters(cameraY, north);
    let minimumY = relativeQuantaMeters(cameraY, south);
    let minimumZ = subtractExpansions(
        renderPatchPolicy.minimumElevationMeters,
        0.0f,
        mapMeta.cameraHigh.z,
        mapMeta.cameraLow.z,
    );
    let maximumZ = subtractExpansions(
        renderPatchPolicy.maximumElevationMeters,
        0.0f,
        mapMeta.cameraHigh.z,
        mapMeta.cameraLow.z,
    );
    return GpuRenderPatchBounds(
        vec3f(minimumX, minimumY, minimumZ),
        vec3f(maximumX, maximumY, maximumZ),
    );
}

fn normalizedPlane(equation: vec4f) -> GpuRenderPatchPlane {
    let magnitude = max(length(equation.xyz), 1e-20f);
    return GpuRenderPatchPlane(equation.xyz / magnitude, equation.w / magnitude);
}

fn frustumPlane(index: u32) -> GpuRenderPatchPlane {
    let matrix = mapMeta.clipFromRelativeWorld;
    let row0 = vec4f(matrix[0].x, matrix[1].x, matrix[2].x, matrix[3].x);
    let row1 = vec4f(matrix[0].y, matrix[1].y, matrix[2].y, matrix[3].y);
    let row2 = vec4f(matrix[0].z, matrix[1].z, matrix[2].z, matrix[3].z);
    let row3 = vec4f(matrix[0].w, matrix[1].w, matrix[2].w, matrix[3].w);
    switch index {
        case 0u: { return normalizedPlane(row3 + row0); }
        case 1u: { return normalizedPlane(row3 - row0); }
        case 2u: { return normalizedPlane(row3 + row1); }
        case 3u: { return normalizedPlane(row3 - row1); }
        case 4u: { return normalizedPlane(row2); }
        default: { return normalizedPlane(row3 - row2); }
    }
}

fn patchVisible(bounds: GpuRenderPatchBounds) -> bool {
    for (var index = 0u; index < 6u; index += 1u) {
        let plane = frustumPlane(index);
        let positive = vec3f(
            select(bounds.minimum.x, bounds.maximum.x, plane.normal.x >= 0.0f),
            select(bounds.minimum.y, bounds.maximum.y, plane.normal.y >= 0.0f),
            select(bounds.minimum.z, bounds.maximum.z, plane.normal.z >= 0.0f),
        );
        if (dot(plane.normal, positive) + plane.distance < 0.0f) {
            return false;
        }
    }
    return true;
}

fn clipPlaneDistance(point: vec4f, plane: u32) -> f32 {
    switch plane {
        case 0u: { return point.z; }
        case 1u: { return point.w - point.z; }
        case 2u: { return point.x + point.w; }
        case 3u: { return point.w - point.x; }
        case 4u: { return point.y + point.w; }
        default: { return point.w - point.y; }
    }
}

fn clipPolygonToPlane(
    input: GpuRenderPatchClipPolygon,
    plane: u32,
) -> GpuRenderPatchClipPolygon {
    var output: GpuRenderPatchClipPolygon;
    if (input.count == 0u) {
        return output;
    }
    var start = input.vertices[input.count - 1u];
    var startDistance = clipPlaneDistance(start, plane);
    for (var index = 0u; index < input.count; index += 1u) {
        let end = input.vertices[index];
        let endDistance = clipPlaneDistance(end, plane);
        let startInside = startDistance >= 0.0f;
        let endInside = endDistance >= 0.0f;
        if (startInside != endInside) {
            let ratio = startDistance / (startDistance - endDistance);
            output.vertices[output.count] = mix(start, end, ratio);
            output.count += 1u;
        }
        if (endInside) {
            output.vertices[output.count] = end;
            output.count += 1u;
        }
        start = end;
        startDistance = endDistance;
    }
    return output;
}

fn projectedAxisCellDeltaPixels(clip: vec4f, delta: vec4f) -> vec2f {
    let reciprocalW = 1.0f / clip.w;
    let ndcDelta = (
        delta.xy - clip.xy * reciprocalW * delta.w
    ) * reciprocalW;
    return ndcDelta * mapMeta.viewport * 0.5f;
}

fn projectedCellAreaScalePixels(
    clip: vec4f,
    xDelta: vec4f,
    yDelta: vec4f,
) -> f32 {
    let minimumCellW = clip.w - 0.5f * (
        abs(xDelta.w) + abs(yDelta.w)
    );
    if (minimumCellW <= 1e-5f) {
        return max(mapMeta.viewport.x, mapMeta.viewport.y);
    }
    let xPixels = projectedAxisCellDeltaPixels(clip, xDelta);
    let yPixels = projectedAxisCellDeltaPixels(clip, yDelta);
    let signedArea = xPixels.x * yPixels.y - xPixels.y * yPixels.x;
    return sqrt(abs(signedArea));
}

fn projectedPlaneCellSpanPixels(bounds: GpuRenderPatchBounds, elevation: f32) -> f32 {
    var polygon: GpuRenderPatchClipPolygon;
    polygon.count = 4u;
    for (var index = 0u; index < 4u; index += 1u) {
        let point = vec3f(
            select(
                bounds.minimum.x,
                bounds.maximum.x,
                index == 1u || index == 2u,
            ),
            select(bounds.minimum.y, bounds.maximum.y, index >= 2u),
            elevation,
        );
        polygon.vertices[index] = mapMeta.clipFromRelativeWorld * vec4f(point, 1.0f);
    }
    for (var plane = 0u; plane < 6u; plane += 1u) {
        polygon = clipPolygonToPlane(polygon, plane);
        if (polygon.count == 0u) {
            return 0.0f;
        }
    }

    let cellMeters = max(
        bounds.maximum.x - bounds.minimum.x,
        bounds.maximum.y - bounds.minimum.y,
    ) / f32(renderPatchPolicy.cellsPerPatchEdge);
    let xDelta = mapMeta.clipFromRelativeWorld[0] * cellMeters;
    let yDelta = mapMeta.clipFromRelativeWorld[1] * cellMeters;
    var maximumSpan = 0.0f;
    for (var index = 0u; index < polygon.count; index += 1u) {
        let clip = polygon.vertices[index];
        maximumSpan = max(
            maximumSpan,
            projectedCellAreaScalePixels(clip, xDelta, yDelta),
        );
    }
    return maximumSpan;
}

fn projectedCellSpanPixels(bounds: GpuRenderPatchBounds) -> f32 {
    return max(
        projectedPlaneCellSpanPixels(bounds, bounds.minimum.z),
        projectedPlaneCellSpanPixels(bounds, bounds.maximum.z),
    );
}

fn trialCellSpanThreshold(biasStep: u32) -> f32 {
    return renderPatchPolicy.maximumCellSpanPixels * exp2(
        f32(biasStep) / f32(renderPatchPolicy.biasStepsPerLevel),
    );
}

fn cellSpanQ8(cellSpanPixels: f32) -> u32 {
    return u32(round(clamp(cellSpanPixels, 0.0f, 65535.0f) * 256.0f));
}

fn insertRenderPatchLookup(
    matrixLevel: u32,
    tileRow: u32,
    tileCol: u32,
    patchIndex: u32,
) -> bool {
    let key = GpuRenderPatch_lookupKey(matrixLevel, tileRow, tileCol);
    for (var probe = 0u; probe < renderPatchPolicy.renderPatchLookupCapacity; probe += 1u) {
        let slot = GpuRenderPatch_lookupSlot(
            key,
            probe,
            renderPatchPolicy.renderPatchLookupCapacity,
        );
        loop {
            let claimed = atomicCompareExchangeWeak(&renderPatchLookup[slot].key, 0u, key);
            if (claimed.exchanged) {
                renderPatchLookup[slot].patchIndex = patchIndex;
                return true;
            }
            if (claimed.old_value == key) { return true; }
            if (claimed.old_value != 0u) { break; }
        }
    }
    return false;
}

fn insertBalancePatchLookup(
    matrixLevel: u32,
    tileRow: u32,
    tileCol: u32,
    patchIndex: u32,
) -> bool {
    let key = GpuRenderPatch_lookupKey(matrixLevel, tileRow, tileCol);
    for (var probe = 0u; probe < renderPatchPolicy.renderPatchLookupCapacity; probe += 1u) {
        let slot = GpuRenderPatch_lookupSlot(
            key,
            probe,
            renderPatchPolicy.renderPatchLookupCapacity,
        );
        loop {
            let claimed = atomicCompareExchangeWeak(&balancePatchLookup[slot].key, 0u, key);
            if (claimed.exchanged) {
                balancePatchLookup[slot].patchIndex = patchIndex;
                return true;
            }
            if (claimed.old_value == key) { return true; }
            if (claimed.old_value != 0u) { break; }
        }
    }
    return false;
}

fn primaryLookupContains(matrixLevel: u32, tileRow: u32, tileCol: u32) -> bool {
    let key = GpuRenderPatch_lookupKey(matrixLevel, tileRow, tileCol);
    for (var probe = 0u; probe < renderPatchPolicy.renderPatchLookupCapacity; probe += 1u) {
        let slot = GpuRenderPatch_lookupSlot(
            key,
            probe,
            renderPatchPolicy.renderPatchLookupCapacity,
        );
        let observed = atomicLoad(&renderPatchLookup[slot].key);
        if (observed == key) { return true; }
        if (observed == 0u) { return false; }
    }
    return false;
}

fn scratchLookupContains(matrixLevel: u32, tileRow: u32, tileCol: u32) -> bool {
    let key = GpuRenderPatch_lookupKey(matrixLevel, tileRow, tileCol);
    for (var probe = 0u; probe < renderPatchPolicy.renderPatchLookupCapacity; probe += 1u) {
        let slot = GpuRenderPatch_lookupSlot(
            key,
            probe,
            renderPatchPolicy.renderPatchLookupCapacity,
        );
        let observed = atomicLoad(&balancePatchLookup[slot].key);
        if (observed == key) { return true; }
        if (observed == 0u) { return false; }
    }
    return false;
}

fn inputLookupContains(
    fromScratch: bool,
    matrixLevel: u32,
    tileRow: u32,
    tileCol: u32,
) -> bool {
    if (fromScratch) {
        return scratchLookupContains(matrixLevel, tileRow, tileCol);
    }
    return primaryLookupContains(matrixLevel, tileRow, tileCol);
}

fn inputRenderPatch(fromScratch: bool, patchIndex: u32) -> GpuRenderPatch {
    if (fromScratch) {
        return balancePatches[patchIndex];
    }
    return renderPatches[patchIndex];
}

fn maximumFinerNeighborDelta(fromScratch: bool, candidate: GpuRenderPatch) -> u32 {
    let availableDelta = min(
        14u,
        renderPatchPolicy.renderMaximumMatrixLevel - candidate.matrixLevel,
    );
    var maximumDelta = 0u;
    for (var delta = 1u; delta <= 14u; delta += 1u) {
        if (delta > availableDelta) { break; }
        let scale = 1u << delta;
        let level = candidate.matrixLevel + delta;
        let levelWidth = 1u << level;
        let firstRow = candidate.tileRow * scale;
        let firstCol = candidate.tileCol * scale;
        let westCol = (firstCol + levelWidth - 1u) & (levelWidth - 1u);
        let eastCol = (firstCol + scale) & (levelWidth - 1u);
        for (var offset = 0u; offset < 16384u; offset += 1u) {
            if (offset >= scale) { break; }
            let row = firstRow + offset;
            let col = firstCol + offset;
            let north = firstRow > 0u && inputLookupContains(
                fromScratch,
                level,
                firstRow - 1u,
                col,
            );
            let south = firstRow + scale < levelWidth && inputLookupContains(
                fromScratch,
                level,
                firstRow + scale,
                col,
            );
            let west = inputLookupContains(fromScratch, level, row, westCol);
            let east = inputLookupContains(fromScratch, level, row, eastCol);
            if (north || south || west || east) {
                maximumDelta = delta;
                break;
            }
        }
    }
    return maximumDelta;
}

fn writeBalancedPatch(toScratch: bool, candidate: GpuRenderPatch) {
    var outputIndex = 0u;
    if (toScratch) {
        outputIndex = atomicAdd(&renderPatchState.balanceScratchCount, 1u);
    } else {
        outputIndex = atomicAdd(&renderPatchState.count, 1u);
    }
    if (outputIndex >= renderPatchPolicy.maximumRenderPatches) {
        atomicAdd(&renderPatchState.overflowCount, 1u);
        return;
    }
    var inserted = false;
    if (toScratch) {
        balancePatches[outputIndex] = candidate;
        inserted = insertBalancePatchLookup(
            candidate.matrixLevel,
            candidate.tileRow,
            candidate.tileCol,
            outputIndex,
        );
    } else {
        renderPatches[outputIndex] = candidate;
        inserted = insertRenderPatchLookup(
            candidate.matrixLevel,
            candidate.tileRow,
            candidate.tileCol,
            outputIndex,
        );
    }
    if (!inserted) {
        atomicAdd(&renderPatchState.lookupOverflowCount, 1u);
    }
}

fn writeBalancedChildren(toScratch: bool, candidate: GpuRenderPatch) {
    let childLevel = candidate.matrixLevel + 1u;
    let firstRow = candidate.tileRow * 2u;
    let firstCol = candidate.tileCol * 2u;
    for (var child = 0u; child < 4u; child += 1u) {
        writeBalancedPatch(toScratch, GpuRenderPatch(
            childLevel,
            firstRow + (child >> 1u),
            firstCol + (child & 1u),
        ));
    }
}

fn emitRenderPatch(
    matrixLevel: u32,
    tileRow: u32,
    tileCol: u32,
) {
    let outputIndex = atomicAdd(&renderPatchState.count, 1u);
    if (outputIndex >= renderPatchPolicy.maximumRenderPatches) {
        atomicAdd(&renderPatchState.overflowCount, 1u);
        return;
    }
    renderPatches[outputIndex] = GpuRenderPatch(
        matrixLevel,
        tileRow,
        tileCol,
    );
}

fn visibleChildCount(candidate: GpuRenderPatch) -> u32 {
    let childLevel = candidate.matrixLevel + 1u;
    let firstRow = candidate.tileRow * 2u;
    let firstCol = candidate.tileCol * 2u;
    var count = 0u;
    for (var child = 0u; child < 4u; child += 1u) {
        let row = firstRow + (child >> 1u);
        let col = firstCol + (child & 1u);
        if (patchVisible(patchBounds(childLevel, row, col))) {
            count += 1u;
        }
    }
    return count;
}

@compute @workgroup_size(1)
fn resetRenderPatches() {
    atomicStore(&renderPatchState.count, 0u);
    atomicStore(&renderPatchState.overflowCount, 0u);
    atomicStore(&renderPatchState.lookupOverflowCount, 0u);
    atomicStore(&renderPatchState.minimumMatrixLevel, 0xffffffffu);
    atomicStore(&renderPatchState.maximumMatrixLevel, 0u);
    atomicStore(&renderPatchState.minimumCellSpanQ8, 0xffffffffu);
    atomicStore(&renderPatchState.maximumCellSpanQ8, 0u);
    atomicStore(&renderPatchState.frameEpoch, mapMeta.frameEpoch);
    atomicStore(&renderPatchState.baselinePatchBudget, 0u);
    atomicStore(&renderPatchState.framePatchBudget, 0u);
    atomicStore(&renderPatchState.requestedPatchCount, 0u);
    atomicStore(&renderPatchState.minimumTrialPatchCount, 0u);
    for (var step = 0u; step < 17u; step += 1u) {
        atomicStore(&renderPatchState.trialCounts[step], 0u);
    }
    atomicStore(&renderPatchState.unbalancedPatchCount, 0u);
    atomicStore(&renderPatchState.balanceSplitCount, 0u);
    atomicStore(&renderPatchState.maximumAdjacentLevelDelta, 0u);
    atomicStore(&renderPatchState.balancePassCount, renderPatchPolicy.balancePassCount);
    atomicStore(&renderPatchState.balanceScratchCount, 0u);
    atomicStore(&renderPatchState.budgetFillSplitCount, 0u);
    atomicStore(&renderPatchState.budgetLimitedRefinementCount, 0u);
    atomicStore(&renderPatchState.selectedBiasStep, 0u);
    drawArguments[0] = renderPatchPolicy.vertexCount;
    drawArguments[1] = 0u;
    drawArguments[2] = 0u;
    drawArguments[3] = 0u;
}

@compute @workgroup_size(64)
fn countRenderPatchTrials(@builtin(global_invocation_id) globalId: vec3u) {
    let trialIndex = globalId.x % renderPatchPolicy.biasStepCount;
    let rootIndex = globalId.x / renderPatchPolicy.biasStepCount;
    if (rootIndex >= renderPatchPolicy.renderRootCount ||
        trialIndex >= renderPatchPolicy.biasStepCount) { return; }
    let root = renderRoots[rootIndex];
    let finalStep = renderPatchPolicy.biasStepCount - 1u;
    let nominalThreshold = trialCellSpanThreshold(trialIndex);
    var stack: array<GpuRenderPatch, 64>;
    var stackSize = 1u;
    stack[0] = root;
    loop {
        if (stackSize == 0u) { break; }
        stackSize -= 1u;
        let candidate = stack[stackSize];
        let bounds = patchBounds(
            candidate.matrixLevel,
            candidate.tileRow,
            candidate.tileCol,
        );
        if (!patchVisible(bounds)) { continue; }
        let cellSpanPixels = projectedCellSpanPixels(bounds);
        let refine = trialIndex < finalStep &&
            candidate.matrixLevel < renderPatchPolicy.renderMaximumMatrixLevel &&
            cellSpanPixels > nominalThreshold;
        if (!refine) {
            let previousTrialCount = atomicAdd(
                &renderPatchState.trialCounts[trialIndex],
                1u,
            );
            if (previousTrialCount >= renderPatchPolicy.maximumRenderPatches) {
                break;
            }
            continue;
        }
        let childLevel = candidate.matrixLevel + 1u;
        let firstRow = candidate.tileRow * 2u;
        let firstCol = candidate.tileCol * 2u;
        for (var child = 0u; child < 4u; child += 1u) {
            stack[stackSize] = GpuRenderPatch(
                childLevel,
                firstRow + (child >> 1u),
                firstCol + (child & 1u),
            );
            stackSize += 1u;
        }
    }
}

@compute @workgroup_size(1)
fn selectRenderPatchBudget() {
    let nominalPatchSpan = max(
        1.0f,
        f32(renderPatchPolicy.cellsPerPatchEdge) *
            renderPatchPolicy.maximumCellSpanPixels,
    );
    let viewportColumns = u32(ceil(mapMeta.viewport.x / nominalPatchSpan)) + 1u;
    let viewportRows = u32(ceil(mapMeta.viewport.y / nominalPatchSpan)) + 1u;
    let baselinePatchBudget = min(
        renderPatchPolicy.maximumRenderPatches,
        viewportColumns * viewportRows,
    );
    let pitchSine = sin(clamp(mapMeta.cameraPitchRadians, 0.0f, 1.57079632679f));
    let pitchWeight = pitchSine * pitchSine;
    let pitchRatio = 1.0f +
        (renderPatchPolicy.maximumPatchCountRatio - 1.0f) * pitchWeight;
    let framePatchBudget = min(
        renderPatchPolicy.maximumRenderPatches,
        u32(ceil(f32(baselinePatchBudget) * pitchRatio)),
    );
    var desiredBiasStep = 0u;
    var foundInBudget = false;
    var minimumTrialPatchCount = 0xffffffffu;
    var minimumTrialBiasStep = 0u;
    for (var step = 0u; step < 17u; step += 1u) {
        if (step >= renderPatchPolicy.biasStepCount) { break; }
        let trialPatchCount = atomicLoad(&renderPatchState.trialCounts[step]);
        if (trialPatchCount < minimumTrialPatchCount) {
            minimumTrialPatchCount = trialPatchCount;
            minimumTrialBiasStep = step;
        }
        if (!foundInBudget && trialPatchCount <= framePatchBudget) {
            desiredBiasStep = step;
            foundInBudget = true;
        }
    }
    if (!foundInBudget) {
        desiredBiasStep = minimumTrialBiasStep;
    }
    atomicStore(&renderPatchState.baselinePatchBudget, baselinePatchBudget);
    atomicStore(&renderPatchState.framePatchBudget, framePatchBudget);
    atomicStore(
        &renderPatchState.requestedPatchCount,
        atomicLoad(&renderPatchState.trialCounts[0]),
    );
    atomicStore(
        &renderPatchState.minimumTrialPatchCount,
        minimumTrialPatchCount,
    );
    atomicStore(&renderPatchState.selectedBiasStep, desiredBiasStep);
}

@compute @workgroup_size(64)
fn expandRenderPatches(@builtin(global_invocation_id) globalId: vec3u) {
    let rootIndex = globalId.x;
    if (rootIndex >= renderPatchPolicy.renderRootCount) { return; }
    let selectedBiasStep = atomicLoad(&renderPatchState.selectedBiasStep);
    let nominalThreshold = trialCellSpanThreshold(selectedBiasStep);
    var stack: array<GpuRenderPatch, 64>;
    var stackSize = 1u;
    stack[0] = renderRoots[rootIndex];
    loop {
        if (stackSize == 0u) { break; }
        stackSize -= 1u;
        let candidate = stack[stackSize];
        let bounds = patchBounds(
            candidate.matrixLevel,
            candidate.tileRow,
            candidate.tileCol,
        );
        if (!patchVisible(bounds)) { continue; }
        let cellSpanPixels = projectedCellSpanPixels(bounds);
        let refine = selectedBiasStep < renderPatchPolicy.biasStepCount - 1u &&
            candidate.matrixLevel < renderPatchPolicy.renderMaximumMatrixLevel &&
            cellSpanPixels > nominalThreshold;
        if (!refine) {
            emitRenderPatch(
                candidate.matrixLevel,
                candidate.tileRow,
                candidate.tileCol,
            );
            continue;
        }
        let childLevel = candidate.matrixLevel + 1u;
        let firstRow = candidate.tileRow * 2u;
        let firstCol = candidate.tileCol * 2u;
        for (var child = 0u; child < 4u; child += 1u) {
            stack[stackSize] = GpuRenderPatch(
                childLevel,
                firstRow + (child >> 1u),
                firstCol + (child & 1u),
            );
            stackSize += 1u;
        }
    }
}

@compute @workgroup_size(1)
fn fillRenderPatchBudget() {
    var patchCount = min(
        atomicLoad(&renderPatchState.count),
        renderPatchPolicy.maximumRenderPatches,
    );
    let framePatchBudget = atomicLoad(&renderPatchState.framePatchBudget);
    loop {
        var bestSpanQ8 = 0u;
        if (patchCount <= framePatchBudget) {
            for (var patchIndex = 0u; patchIndex < patchCount; patchIndex += 1u) {
                let candidate = renderPatches[patchIndex];
                if (candidate.matrixLevel >= renderPatchPolicy.renderMaximumMatrixLevel) {
                    continue;
                }
                let span = projectedCellSpanPixels(patchBounds(
                    candidate.matrixLevel,
                    candidate.tileRow,
                    candidate.tileCol,
                ));
                if (span <= renderPatchPolicy.maximumCellSpanPixels) {
                    continue;
                }
                let childCount = visibleChildCount(candidate);
                if (childCount == 0u) { continue; }
                let spanQ8 = cellSpanQ8(span);
                bestSpanQ8 = max(bestSpanQ8, spanQ8);
            }
        }
        if (bestSpanQ8 == 0u) { break; }

        var cohortIncrementalCost = 0u;
        for (var patchIndex = 0u; patchIndex < patchCount; patchIndex += 1u) {
            let candidate = renderPatches[patchIndex];
            if (candidate.matrixLevel >= renderPatchPolicy.renderMaximumMatrixLevel) {
                continue;
            }
            let span = projectedCellSpanPixels(patchBounds(
                candidate.matrixLevel,
                candidate.tileRow,
                candidate.tileCol,
            ));
            if (span <= renderPatchPolicy.maximumCellSpanPixels ||
                cellSpanQ8(span) != bestSpanQ8) {
                continue;
            }
            let childCount = visibleChildCount(candidate);
            if (childCount > 0u) {
                cohortIncrementalCost += childCount - 1u;
            }
        }
        if (cohortIncrementalCost > framePatchBudget - patchCount) { break; }

        let sourcePatchCount = patchCount;
        var appendedCount = 0u;
        for (var patchIndex = 0u; patchIndex < sourcePatchCount; patchIndex += 1u) {
            let selected = renderPatches[patchIndex];
            if (selected.matrixLevel >= renderPatchPolicy.renderMaximumMatrixLevel) {
                continue;
            }
            let span = projectedCellSpanPixels(patchBounds(
                selected.matrixLevel,
                selected.tileRow,
                selected.tileCol,
            ));
            if (span <= renderPatchPolicy.maximumCellSpanPixels ||
                cellSpanQ8(span) != bestSpanQ8) {
                continue;
            }
            let childLevel = selected.matrixLevel + 1u;
            let firstRow = selected.tileRow * 2u;
            let firstCol = selected.tileCol * 2u;
            var wroteFirst = false;
            for (var child = 0u; child < 4u; child += 1u) {
                let row = firstRow + (child >> 1u);
                let col = firstCol + (child & 1u);
                if (!patchVisible(patchBounds(childLevel, row, col))) { continue; }
                let childPatch = GpuRenderPatch(childLevel, row, col);
                if (!wroteFirst) {
                    renderPatches[patchIndex] = childPatch;
                    wroteFirst = true;
                } else {
                    renderPatches[sourcePatchCount + appendedCount] = childPatch;
                    appendedCount += 1u;
                }
            }
            if (wroteFirst) {
                atomicAdd(&renderPatchState.budgetFillSplitCount, 1u);
            }
        }
        patchCount = sourcePatchCount + appendedCount;
    }

    var limitedCount = 0u;
    for (var patchIndex = 0u; patchIndex < patchCount; patchIndex += 1u) {
        let candidate = renderPatches[patchIndex];
        if (candidate.matrixLevel >= renderPatchPolicy.renderMaximumMatrixLevel) {
            continue;
        }
        let span = projectedCellSpanPixels(patchBounds(
            candidate.matrixLevel,
            candidate.tileRow,
            candidate.tileCol,
        ));
        if (span <= renderPatchPolicy.maximumCellSpanPixels) { continue; }
        let childCount = visibleChildCount(candidate);
        if (childCount == 0u) { continue; }
        limitedCount += 1u;
    }
    atomicStore(&renderPatchState.budgetLimitedRefinementCount, limitedCount);
    atomicStore(&renderPatchState.count, patchCount);

    for (var patchIndex = 0u; patchIndex < patchCount; patchIndex += 1u) {
        let candidate = renderPatches[patchIndex];
        if (!insertRenderPatchLookup(
            candidate.matrixLevel,
            candidate.tileRow,
            candidate.tileCol,
            patchIndex,
        )) {
            atomicAdd(&renderPatchState.lookupOverflowCount, 1u);
        }
    }
}

@compute @workgroup_size(256)
fn balanceRenderPatches(@builtin(local_invocation_index) lane: u32) {
    if (lane == 0u) {
        atomicStore(
            &renderPatchState.unbalancedPatchCount,
            atomicLoad(&renderPatchState.count),
        );
        atomicStore(&renderPatchState.balanceSplitCount, 0u);
    }
    storageBarrier();

    for (var iteration = 0u; iteration < 14u; iteration += 1u) {
        if (lane == 0u) {
            atomicStore(&balanceIterationSplitCount, 0u);
        }
        workgroupBarrier();
        let fromScratch = (iteration & 1u) != 0u;
        let toScratch = !fromScratch;
        let inputCount = select(
            atomicLoad(&renderPatchState.count),
            atomicLoad(&renderPatchState.balanceScratchCount),
            fromScratch,
        );

        for (
            var slot = lane;
            slot < renderPatchPolicy.renderPatchLookupCapacity;
            slot += 256u
        ) {
            if (toScratch) {
                atomicStore(&balancePatchLookup[slot].key, 0u);
            } else {
                atomicStore(&renderPatchLookup[slot].key, 0u);
            }
        }
        if (lane == 0u) {
            if (toScratch) {
                atomicStore(&renderPatchState.balanceScratchCount, 0u);
            } else {
                atomicStore(&renderPatchState.count, 0u);
            }
        }
        storageBarrier();

        for (
            var patchIndex = lane;
            patchIndex < inputCount;
            patchIndex += 256u
        ) {
            let candidate = inputRenderPatch(fromScratch, patchIndex);
            let mustSplit = candidate.matrixLevel <
                renderPatchPolicy.renderMaximumMatrixLevel &&
                maximumFinerNeighborDelta(fromScratch, candidate) > 1u;
            if (mustSplit) {
                atomicAdd(&renderPatchState.balanceSplitCount, 1u);
                atomicAdd(&balanceIterationSplitCount, 1u);
                writeBalancedChildren(toScratch, candidate);
            } else {
                writeBalancedPatch(toScratch, candidate);
            }
        }
        storageBarrier();
        let iterationSplitCount = workgroupUniformLoad(&balanceIterationSplitCount);
        if ((iteration & 1u) == 1u &&
            iterationSplitCount == 0u) {
            break;
        }
    }
}

@compute @workgroup_size(1)
fn resetFinalRenderPatchDiagnostics() {
    atomicStore(&renderPatchState.minimumMatrixLevel, 0xffffffffu);
    atomicStore(&renderPatchState.maximumMatrixLevel, 0u);
    atomicStore(&renderPatchState.minimumCellSpanQ8, 0xffffffffu);
    atomicStore(&renderPatchState.maximumCellSpanQ8, 0u);
    atomicStore(&renderPatchState.maximumAdjacentLevelDelta, 0u);
}

@compute @workgroup_size(64)
fn validateFinalRenderPatchCut(@builtin(global_invocation_id) globalId: vec3u) {
    let patchCount = atomicLoad(&renderPatchState.count);
    if (globalId.x >= patchCount) { return; }
    let candidate = renderPatches[globalId.x];
    atomicMin(&renderPatchState.minimumMatrixLevel, candidate.matrixLevel);
    atomicMax(&renderPatchState.maximumMatrixLevel, candidate.matrixLevel);
    let cellSpan = cellSpanQ8(projectedCellSpanPixels(patchBounds(
        candidate.matrixLevel,
        candidate.tileRow,
        candidate.tileCol,
    )));
    atomicMin(&renderPatchState.minimumCellSpanQ8, cellSpan);
    atomicMax(&renderPatchState.maximumCellSpanQ8, cellSpan);
    atomicMax(
        &renderPatchState.maximumAdjacentLevelDelta,
        maximumFinerNeighborDelta(false, candidate),
    );
}

@compute @workgroup_size(1)
fn finalizeRenderPatches() {
    let renderPatchCount = min(
        atomicLoad(&renderPatchState.count),
        renderPatchPolicy.maximumRenderPatches,
    );
    drawArguments[1] = renderPatchCount;
}
`
