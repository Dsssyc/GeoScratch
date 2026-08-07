struct DemRenderPatchState {
    count: atomic<u32>,
    overflowCount: atomic<u32>,
    lookupOverflowCount: atomic<u32>,
    minimumMatrixLevel: atomic<u32>,
    maximumMatrixLevel: atomic<u32>,
    minimumCellSpanQ8: atomic<u32>,
    maximumCellSpanQ8: atomic<u32>,
    frameEpoch: atomic<u32>,
};

struct DemRenderPatchAtomicLookupEntry {
    key: atomic<u32>,
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

fn patchBoundsCorner(bounds: DemRenderPatchBounds, index: u32) -> vec3f {
    return vec3f(
        select(bounds.minimum.x, bounds.maximum.x, (index & 1u) != 0u),
        select(bounds.minimum.y, bounds.maximum.y, (index & 2u) != 0u),
        select(bounds.minimum.z, bounds.maximum.z, (index & 4u) != 0u),
    );
}

fn projectedCellSpanPixels(bounds: DemRenderPatchBounds) -> f32 {
    var minimumNdc = vec2f(1e20f);
    var maximumNdc = vec2f(-1e20f);
    for (var index = 0u; index < 8u; index += 1u) {
        let clip = mapMeta.clipFromRelativeWorld * vec4f(
            patchBoundsCorner(bounds, index),
            1.0f,
        );
        if (clip.w <= 1e-5f) {
            return 65535.0f;
        }
        let ndc = clip.xy / clip.w;
        minimumNdc = min(minimumNdc, ndc);
        maximumNdc = max(maximumNdc, ndc);
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
    drawArguments[0] = renderPatchPolicy.terrainVertexCount;
    drawArguments[1] = 0u;
    drawArguments[2] = 0u;
    drawArguments[3] = 0u;
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
        let refine = depth < availableDepth &&
            cellSpanPixels > renderPatchPolicy.maximumCellSpanPixels;
        if (refine) { continue; }

        let duplicateMask = (1u << remainingBits) - 1u;
        if ((terminalRow & duplicateMask) != 0u ||
            (terminalCol & duplicateMask) != 0u) {
            return;
        }
        emitRenderPatch(source, matrixLevel, tileRow, tileCol, cellSpanPixels);
        return;
    }
}

@compute @workgroup_size(1)
fn finalizeRenderPatches() {
    let renderPatchCount = min(
        atomicLoad(&renderPatchState.count),
        renderPatchPolicy.maximumRenderPatches,
    );
    drawArguments[1] = renderPatchCount;
}
