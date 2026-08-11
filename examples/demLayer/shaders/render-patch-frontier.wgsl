struct DemRenderPatchState {
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
};

struct DemRenderPatchAtomicLookupEntry {
    key: atomic<u32>,
    patchIndex: u32,
};

struct DemRenderPatchLookupEntry {
    key: u32,
    patchIndex: u32,
};

struct DemRenderPatchBounds {
    minimum: vec3f,
    maximum: vec3f,
};

struct DemRenderPatchPlane {
    normal: vec3f,
    distance: f32,
};

struct DemRenderPatchQuanta {
    low: u32,
    high: u32,
};

@group(0) @binding(0) var<uniform> mapMeta: GpuTileFrontierMapMeta;
@group(0) @binding(1) var<uniform> renderPatchPolicy: DemRenderPatchPolicy;
@group(0) @binding(2) var<storage, read> sourceVisibleInstances:
    array<GpuTileFrontierVisibleInstance>;
@group(0) @binding(3) var<storage, read> sourceDrawArguments: array<u32>;
@group(0) @binding(4) var<storage, read_write> renderPatches: array<DemRenderPatch>;
@group(0) @binding(5) var<storage, read_write> renderPatchState: DemRenderPatchState;
@group(0) @binding(6) var<storage, read_write> drawArguments: array<u32>;
@group(0) @binding(7) var<storage, read_write> renderPatchLookup:
    array<DemRenderPatchAtomicLookupEntry>;
@group(0) @binding(8) var<storage, read_write> balancePatches: array<DemRenderPatch>;
@group(0) @binding(9) var<storage, read_write> balancePatchLookup:
    array<DemRenderPatchAtomicLookupEntry>;
@group(0) @binding(10) var<storage, read> previousRenderPatchLookup:
    array<DemRenderPatchLookupEntry>;

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

fn boundaryQuanta(index: u32, matrixLevel: u32) -> DemRenderPatchQuanta {
    let shift = renderPatchPolicy.coordinateBits - matrixLevel;
    if (shift >= 32u) {
        return DemRenderPatchQuanta(0u, index << (shift - 32u));
    }
    if (shift == 0u) {
        return DemRenderPatchQuanta(index, 0u);
    }
    return DemRenderPatchQuanta(index << shift, index >> (32u - shift));
}

fn subtractQuanta(
    left: DemRenderPatchQuanta,
    right: DemRenderPatchQuanta,
) -> DemRenderPatchQuanta {
    let borrow = select(0u, 1u, left.low < right.low);
    return DemRenderPatchQuanta(
        left.low - right.low,
        left.high - right.high - borrow,
    );
}

fn quantaMagnitude(value: DemRenderPatchQuanta) -> DemRenderPatchQuanta {
    if ((value.high & 0x80000000u) == 0u) {
        return value;
    }
    let low = ~value.low + 1u;
    let carry = select(0u, 1u, low == 0u);
    return DemRenderPatchQuanta(low, ~value.high + carry);
}

fn relativeQuantaMeters(
    left: DemRenderPatchQuanta,
    right: DemRenderPatchQuanta,
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

fn patchBounds(matrixLevel: u32, row: u32, column: u32) -> DemRenderPatchBounds {
    let west = boundaryQuanta(column, matrixLevel);
    let east = boundaryQuanta(column + 1u, matrixLevel);
    let north = boundaryQuanta(row, matrixLevel);
    let south = boundaryQuanta(row + 1u, matrixLevel);
    let cameraX = DemRenderPatchQuanta(
        mapMeta.cameraFixedLow.x,
        mapMeta.cameraFixedHigh.x,
    );
    let cameraY = DemRenderPatchQuanta(
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
    return DemRenderPatchBounds(
        vec3f(minimumX, minimumY, minimumZ),
        vec3f(maximumX, maximumY, maximumZ),
    );
}

fn normalizedPlane(equation: vec4f) -> DemRenderPatchPlane {
    let magnitude = max(length(equation.xyz), 1e-20f);
    return DemRenderPatchPlane(equation.xyz / magnitude, equation.w / magnitude);
}

fn frustumPlane(index: u32) -> DemRenderPatchPlane {
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

fn patchVisible(bounds: DemRenderPatchBounds) -> bool {
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

fn projectedPlaneCellSpanPixels(bounds: DemRenderPatchBounds, elevation: f32) -> f32 {
    var clipCorners: array<vec4f, 4>;
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
        clipCorners[index] = mapMeta.clipFromRelativeWorld * vec4f(point, 1.0f);
    }

    var minimumNdc = vec2f(1e20f);
    var maximumNdc = vec2f(-1e20f);
    var clippedPointCount = 0u;
    for (var index = 0u; index < 4u; index += 1u) {
        let clip = clipCorners[index];
        if (clip.z >= 0.0f && clip.w > 1e-5f) {
            let ndc = clip.xy / clip.w;
            minimumNdc = min(minimumNdc, ndc);
            maximumNdc = max(maximumNdc, ndc);
            clippedPointCount += 1u;
        }
    }
    for (var index = 0u; index < 4u; index += 1u) {
        let start = clipCorners[index];
        let end = clipCorners[(index + 1u) & 3u];
        if ((start.z >= 0.0f) != (end.z >= 0.0f)) {
            let intersection = mix(start, end, start.z / (start.z - end.z));
            if (intersection.w > 1e-5f) {
                let ndc = intersection.xy / intersection.w;
                minimumNdc = min(minimumNdc, ndc);
                maximumNdc = max(maximumNdc, ndc);
                clippedPointCount += 1u;
            }
        }
    }
    if (clippedPointCount == 0u) {
        return 0.0f;
    }
    let clippedMinimum = clamp(minimumNdc, vec2f(-1.0f), vec2f(1.0f));
    let clippedMaximum = clamp(maximumNdc, vec2f(-1.0f), vec2f(1.0f));
    let projectedSize = max(
        (clippedMaximum - clippedMinimum) * mapMeta.viewport * 0.5f,
        vec2f(0.0f),
    );
    return sqrt(projectedSize.x * projectedSize.y) /
        f32(renderPatchPolicy.terrainSectorSize);
}

fn projectedCellSpanPixels(bounds: DemRenderPatchBounds) -> f32 {
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

fn previousLookupContains(matrixLevel: u32, tileRow: u32, tileCol: u32) -> bool {
    let key = DemRenderPatch_lookupKey(matrixLevel, tileRow, tileCol);
    for (var probe = 0u; probe < renderPatchPolicy.renderPatchLookupCapacity; probe += 1u) {
        let slot = DemRenderPatch_lookupSlot(
            key,
            probe,
            renderPatchPolicy.renderPatchLookupCapacity,
        );
        let observed = previousRenderPatchLookup[slot].key;
        if (observed == key) { return true; }
        if (observed == 0u) { return false; }
    }
    return false;
}

fn historyAwareRefinementThreshold(
    nominalThreshold: f32,
    matrixLevel: u32,
    tileRow: u32,
    tileCol: u32,
) -> f32 {
    if (!previousLookupContains(matrixLevel, tileRow, tileCol)) {
        return nominalThreshold;
    }
    return nominalThreshold * exp2(
        1.0f / f32(renderPatchPolicy.biasStepsPerLevel),
    );
}

fn canonicalTerminalForDepth(terminalRow: u32, terminalCol: u32, depth: u32) -> bool {
    let remainingBits = renderPatchPolicy.maximumExtraLevels - depth;
    let duplicateMask = (1u << remainingBits) - 1u;
    return (terminalRow & duplicateMask) == 0u &&
        (terminalCol & duplicateMask) == 0u;
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
    let key = DemRenderPatch_lookupKey(matrixLevel, tileRow, tileCol);
    for (var probe = 0u; probe < renderPatchPolicy.renderPatchLookupCapacity; probe += 1u) {
        let slot = DemRenderPatch_lookupSlot(
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
    let key = DemRenderPatch_lookupKey(matrixLevel, tileRow, tileCol);
    for (var probe = 0u; probe < renderPatchPolicy.renderPatchLookupCapacity; probe += 1u) {
        let slot = DemRenderPatch_lookupSlot(
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
    let key = DemRenderPatch_lookupKey(matrixLevel, tileRow, tileCol);
    for (var probe = 0u; probe < renderPatchPolicy.renderPatchLookupCapacity; probe += 1u) {
        let slot = DemRenderPatch_lookupSlot(
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
    let key = DemRenderPatch_lookupKey(matrixLevel, tileRow, tileCol);
    for (var probe = 0u; probe < renderPatchPolicy.renderPatchLookupCapacity; probe += 1u) {
        let slot = DemRenderPatch_lookupSlot(
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

fn inputRenderPatch(fromScratch: bool, patchIndex: u32) -> DemRenderPatch {
    if (fromScratch) {
        return balancePatches[patchIndex];
    }
    return renderPatches[patchIndex];
}

fn maximumFinerNeighborDelta(fromScratch: bool, candidate: DemRenderPatch) -> u32 {
    let availableDelta = min(
        renderPatchPolicy.maximumExtraLevels + 1u,
        renderPatchPolicy.renderMaximumMatrixLevel - candidate.matrixLevel,
    );
    var maximumDelta = 0u;
    for (var delta = 1u; delta <= 5u; delta += 1u) {
        if (delta > availableDelta) { break; }
        let scale = 1u << delta;
        let level = candidate.matrixLevel + delta;
        let levelWidth = 1u << level;
        let firstRow = candidate.tileRow * scale;
        let firstCol = candidate.tileCol * scale;
        let westCol = (firstCol + levelWidth - 1u) & (levelWidth - 1u);
        let eastCol = (firstCol + scale) & (levelWidth - 1u);
        for (var offset = 0u; offset < 32u; offset += 1u) {
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

fn writeBalancedPatch(toScratch: bool, candidate: DemRenderPatch) {
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

fn writeBalancedChildren(toScratch: bool, candidate: DemRenderPatch) {
    let childLevel = candidate.matrixLevel + 1u;
    let firstRow = candidate.tileRow * 2u;
    let firstCol = candidate.tileCol * 2u;
    for (var child = 0u; child < 4u; child += 1u) {
        writeBalancedPatch(toScratch, DemRenderPatch(
            childLevel,
            firstRow + (child >> 1u),
            firstCol + (child & 1u),
            candidate.samplingLevel,
            candidate.sourceMatrixLevel,
            candidate.sourceTileRow,
            candidate.sourceTileCol,
            candidate.sourceCompactIndex,
        ));
    }
}

fn emitRenderPatch(
    source: GpuTileFrontierVisibleInstance,
    matrixLevel: u32,
    tileRow: u32,
    tileCol: u32,
    cellSpanPixels: f32,
) {
    let outputIndex = atomicAdd(&renderPatchState.count, 1u);
    if (outputIndex >= renderPatchPolicy.maximumRenderPatches) {
        atomicAdd(&renderPatchState.overflowCount, 1u);
        return;
    }
    renderPatches[outputIndex] = DemRenderPatch(
        matrixLevel,
        tileRow,
        tileCol,
        source.samplingLevel,
        source.matrixLevel,
        source.tileRow,
        source.tileCol,
        source.compactIndex,
    );
    if (!insertRenderPatchLookup(matrixLevel, tileRow, tileCol, outputIndex)) {
        atomicAdd(&renderPatchState.lookupOverflowCount, 1u);
    }
    atomicMin(&renderPatchState.minimumMatrixLevel, matrixLevel);
    atomicMax(&renderPatchState.maximumMatrixLevel, matrixLevel);
    let quantizedCellSpan = cellSpanQ8(cellSpanPixels);
    atomicMin(&renderPatchState.minimumCellSpanQ8, quantizedCellSpan);
    atomicMax(&renderPatchState.maximumCellSpanQ8, quantizedCellSpan);
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
    drawArguments[0] = renderPatchPolicy.terrainVertexCount;
    drawArguments[1] = 0u;
    drawArguments[2] = 0u;
    drawArguments[3] = 0u;
}

@compute @workgroup_size(64)
fn countRenderPatchTrials(@builtin(global_invocation_id) globalId: vec3u) {
    let terminalWidth = 1u << renderPatchPolicy.maximumExtraLevels;
    let candidatesPerSource = terminalWidth * terminalWidth;
    let sourceIndex = globalId.x / candidatesPerSource;
    let terminalIndex = globalId.x % candidatesPerSource;
    let sourceCount = sourceDrawArguments[1];
    if (sourceIndex >= sourceCount) {
        return;
    }
    let source = sourceVisibleInstances[sourceIndex];
    let terminalRow = terminalIndex / terminalWidth;
    let terminalCol = terminalIndex % terminalWidth;
    let availableDepth = min(
        renderPatchPolicy.maximumExtraLevels,
        renderPatchPolicy.renderMaximumMatrixLevel - source.matrixLevel,
    );
    var visibleDepthMask = 0u;
    var cellSpans: array<f32, 5>;

    for (var depth = 0u; depth <= 4u; depth += 1u) {
        if (depth > availableDepth) { break; }
        let remainingBits = renderPatchPolicy.maximumExtraLevels - depth;
        let scale = 1u << depth;
        let matrixLevel = source.matrixLevel + depth;
        let tileRow = source.tileRow * scale + (terminalRow >> remainingBits);
        let tileCol = source.tileCol * scale + (terminalCol >> remainingBits);
        let bounds = patchBounds(matrixLevel, tileRow, tileCol);
        if (!patchVisible(bounds)) { break; }
        visibleDepthMask |= 1u << depth;
        cellSpans[depth] = projectedCellSpanPixels(bounds);
    }

    let finalStep = renderPatchPolicy.biasStepCount - 1u;
    for (var step = 0u; step < 17u; step += 1u) {
        let nominalThreshold = trialCellSpanThreshold(step);
        for (var depth = 0u; depth <= 4u; depth += 1u) {
            if (depth > availableDepth || (visibleDepthMask & (1u << depth)) == 0u) {
                break;
            }
            let remainingBits = renderPatchPolicy.maximumExtraLevels - depth;
            let scale = 1u << depth;
            let matrixLevel = source.matrixLevel + depth;
            let tileRow = source.tileRow * scale + (terminalRow >> remainingBits);
            let tileCol = source.tileCol * scale + (terminalCol >> remainingBits);
            let threshold = historyAwareRefinementThreshold(
                nominalThreshold,
                matrixLevel,
                tileRow,
                tileCol,
            );
            let refine = step < finalStep &&
                depth < availableDepth && cellSpans[depth] > threshold;
            if (refine) { continue; }
            if (canonicalTerminalForDepth(terminalRow, terminalCol, depth)) {
                atomicAdd(&renderPatchState.trialCounts[step], 1u);
            }
            break;
        }
    }
}

@compute @workgroup_size(1)
fn selectRenderPatchBudget() {
    let nominalPatchSpan = max(
        1.0f,
        f32(renderPatchPolicy.terrainSectorSize) *
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
    let finalStep = renderPatchPolicy.biasStepCount - 1u;
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
    let previousBiasStep = min(
        atomicLoad(&renderPatchState.selectedBiasStep),
        finalStep,
    );
    let previousCount = atomicLoad(&renderPatchState.trialCounts[previousBiasStep]);
    let retainPrevious = previousCount <= framePatchBudget &&
        f32(previousCount) >= f32(framePatchBudget) *
            renderPatchPolicy.budgetHysteresisRatio &&
        previousBiasStep <= desiredBiasStep + 1u;
    let selectedBiasStep = select(desiredBiasStep, previousBiasStep, retainPrevious);
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
    atomicStore(&renderPatchState.selectedBiasStep, selectedBiasStep);
}

@compute @workgroup_size(64)
fn expandRenderPatches(@builtin(global_invocation_id) globalId: vec3u) {
    let terminalWidth = 1u << renderPatchPolicy.maximumExtraLevels;
    let candidatesPerSource = terminalWidth * terminalWidth;
    let sourceIndex = globalId.x / candidatesPerSource;
    let terminalIndex = globalId.x % candidatesPerSource;
    let sourceCount = sourceDrawArguments[1];
    if (sourceIndex >= sourceCount) {
        return;
    }
    let source = sourceVisibleInstances[sourceIndex];
    let terminalRow = terminalIndex / terminalWidth;
    let terminalCol = terminalIndex % terminalWidth;
    let availableDepth = min(
        renderPatchPolicy.maximumExtraLevels,
        renderPatchPolicy.renderMaximumMatrixLevel - source.matrixLevel,
    );
    let selectedBiasStep = atomicLoad(&renderPatchState.selectedBiasStep);
    let nominalThreshold = trialCellSpanThreshold(selectedBiasStep);

    for (var depth = 0u; depth <= 4u; depth += 1u) {
        if (depth > availableDepth) { return; }
        let remainingBits = renderPatchPolicy.maximumExtraLevels - depth;
        let scale = 1u << depth;
        let matrixLevel = source.matrixLevel + depth;
        let tileRow = source.tileRow * scale + (terminalRow >> remainingBits);
        let tileCol = source.tileCol * scale + (terminalCol >> remainingBits);
        let bounds = patchBounds(matrixLevel, tileRow, tileCol);
        if (!patchVisible(bounds)) { return; }

        let cellSpanPixels = projectedCellSpanPixels(bounds);
        let selectedThreshold = historyAwareRefinementThreshold(
            nominalThreshold,
            matrixLevel,
            tileRow,
            tileCol,
        );
        let refine = selectedBiasStep < renderPatchPolicy.biasStepCount - 1u &&
            depth < availableDepth && cellSpanPixels > selectedThreshold;
        if (refine) { continue; }

        if (!canonicalTerminalForDepth(terminalRow, terminalCol, depth)) {
            return;
        }
        emitRenderPatch(source, matrixLevel, tileRow, tileCol, cellSpanPixels);
        return;
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
                writeBalancedChildren(toScratch, candidate);
            } else {
                writeBalancedPatch(toScratch, candidate);
            }
        }
        storageBarrier();
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
