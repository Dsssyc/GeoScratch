export const GPU_WEB_MERCATOR_QUAD_COVER_WGSL = String.raw`
struct GpuWebMercatorQuadCoverWindow {
    minTileRow: i32,
    maxTileRow: i32,
    minTileCol: i32,
    maxTileCol: i32,
};

struct GpuWebMercatorQuadCoverBounds {
    minimum: vec3f,
    maximum: vec3f,
};

struct GpuWebMercatorQuadCoverPlane {
    normal: vec3f,
    distance: f32,
};

struct GpuWebMercatorQuadCoverQuanta {
    low: u32,
    high: u32,
};

struct GpuWebMercatorQuadCoverClipPolygon {
    vertices: array<vec4f, 10>,
    count: u32,
};

@group(0) @binding(0)
var<uniform> mapMeta: GpuWebMercatorQuadCoverMapMeta;
@group(0) @binding(1)
var<uniform> coverPolicy: GpuWebMercatorQuadCoverPolicy;
@group(0) @binding(2)
var<storage, read> coverageLimits: array<GpuWebMercatorQuadCoverLimit>;
@group(0) @binding(3)
var<storage, read> verticalBounds: array<GpuWebMercatorQuadCoverVerticalBounds>;
@group(0) @binding(4)
var<storage, read_write> coverPatches: array<GpuWebMercatorQuadCoverPatch>;
@group(0) @binding(5)
var<storage, read_write> coverLookup: array<GpuWebMercatorQuadCoverLookupEntry>;
@group(0) @binding(6)
var<storage, read_write> coverState: GpuWebMercatorQuadCoverState;
const WEB_MERCATOR_WORLD_WIDTH_METERS: f32 = 40075016.0f;

fn coverEffectiveCellSpanThreshold() -> f32 {
    return coverPolicy.maximumCellSpanReferencePixels *
        (1.0f + coverPolicy.refinementTolerance);
}

fn coverSubtractExpansions(
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

fn coverBoundaryQuanta(index: u32, matrixLevel: u32) ->
    GpuWebMercatorQuadCoverQuanta {
    let shift = coverPolicy.coordinateBits - matrixLevel;
    if (shift >= 32u) {
        return GpuWebMercatorQuadCoverQuanta(0u, index << (shift - 32u));
    }
    if (shift == 0u) {
        return GpuWebMercatorQuadCoverQuanta(index, 0u);
    }
    return GpuWebMercatorQuadCoverQuanta(
        index << shift,
        index >> (32u - shift),
    );
}

fn coverSubtractQuanta(
    left: GpuWebMercatorQuadCoverQuanta,
    right: GpuWebMercatorQuadCoverQuanta,
) -> GpuWebMercatorQuadCoverQuanta {
    let borrow = select(0u, 1u, left.low < right.low);
    return GpuWebMercatorQuadCoverQuanta(
        left.low - right.low,
        left.high - right.high - borrow,
    );
}

fn coverQuantaMagnitude(
    value: GpuWebMercatorQuadCoverQuanta,
) -> GpuWebMercatorQuadCoverQuanta {
    if ((value.high & 0x80000000u) == 0u) {
        return value;
    }
    let low = ~value.low + 1u;
    let carry = select(0u, 1u, low == 0u);
    return GpuWebMercatorQuadCoverQuanta(low, ~value.high + carry);
}

fn coverRelativeQuantaMeters(
    left: GpuWebMercatorQuadCoverQuanta,
    right: GpuWebMercatorQuadCoverQuanta,
) -> f32 {
    let difference = coverSubtractQuanta(left, right);
    let negative = (difference.high & 0x80000000u) != 0u;
    let magnitude = coverQuantaMagnitude(difference);
    let quantumMeters = ldexp(
        WEB_MERCATOR_WORLD_WIDTH_METERS,
        -i32(coverPolicy.coordinateBits),
    );
    let highLimbMeters = ldexp(quantumMeters, 32);
    let meters = f32(magnitude.high) * highLimbMeters +
        f32(magnitude.low) * quantumMeters;
    return select(meters, -meters, negative);
}

fn coverPatchVerticalBounds(
    matrixLevel: u32,
    row: u32,
    column: u32,
) -> vec2f {
    if (coverPolicy.verticalBoundsMode == 0u) {
        return vec2f(
            coverPolicy.minimumVerticalMeters,
            coverPolicy.maximumVerticalMeters,
        );
    }
    let boundsLevel = min(matrixLevel, coverPolicy.boundsMaximumMatrixLevel);
    let shift = matrixLevel - boundsLevel;
    let boundsRow = row >> shift;
    let boundsColumn = column >> shift;
    let limit = coverLimit(boundsLevel);
    let width = limit.maxTileCol - limit.minTileCol + 1u;
    let index = limit.verticalBoundsOffset +
        (boundsRow - limit.minTileRow) * width +
        (boundsColumn - limit.minTileCol);
    let bounds = verticalBounds[index];
    return vec2f(bounds.minimumVerticalMeters, bounds.maximumVerticalMeters);
}

fn coverPatchBounds(
    matrixLevel: u32,
    row: u32,
    column: u32,
) -> GpuWebMercatorQuadCoverBounds {
    let west = coverBoundaryQuanta(column, matrixLevel);
    let east = coverBoundaryQuanta(column + 1u, matrixLevel);
    let north = coverBoundaryQuanta(row, matrixLevel);
    let south = coverBoundaryQuanta(row + 1u, matrixLevel);
    let cameraX = GpuWebMercatorQuadCoverQuanta(
        mapMeta.cameraFixedLow.x,
        mapMeta.cameraFixedHigh.x,
    );
    let cameraY = GpuWebMercatorQuadCoverQuanta(
        mapMeta.cameraFixedLow.y,
        mapMeta.cameraFixedHigh.y,
    );
    let minimumX = coverRelativeQuantaMeters(west, cameraX);
    let maximumX = coverRelativeQuantaMeters(east, cameraX);
    let maximumY = coverRelativeQuantaMeters(cameraY, north);
    let minimumY = coverRelativeQuantaMeters(cameraY, south);
    let vertical = coverPatchVerticalBounds(matrixLevel, row, column);
    let minimumZ = coverSubtractExpansions(
        vertical.x,
        0.0f,
        mapMeta.cameraHigh.z,
        mapMeta.cameraLow.z,
    );
    let maximumZ = coverSubtractExpansions(
        vertical.y,
        0.0f,
        mapMeta.cameraHigh.z,
        mapMeta.cameraLow.z,
    );
    return GpuWebMercatorQuadCoverBounds(
        vec3f(minimumX, minimumY, minimumZ),
        vec3f(maximumX, maximumY, maximumZ),
    );
}

fn coverNormalizedPlane(equation: vec4f) -> GpuWebMercatorQuadCoverPlane {
    let magnitude = max(length(equation.xyz), 1e-20f);
    return GpuWebMercatorQuadCoverPlane(
        equation.xyz / magnitude,
        equation.w / magnitude,
    );
}

fn coverFrustumPlane(index: u32) -> GpuWebMercatorQuadCoverPlane {
    let matrix = mapMeta.clipFromRelativeWorld;
    let row0 = vec4f(matrix[0].x, matrix[1].x, matrix[2].x, matrix[3].x);
    let row1 = vec4f(matrix[0].y, matrix[1].y, matrix[2].y, matrix[3].y);
    let row2 = vec4f(matrix[0].z, matrix[1].z, matrix[2].z, matrix[3].z);
    let row3 = vec4f(matrix[0].w, matrix[1].w, matrix[2].w, matrix[3].w);
    switch index {
        case 0u: { return coverNormalizedPlane(row3 + row0); }
        case 1u: { return coverNormalizedPlane(row3 - row0); }
        case 2u: { return coverNormalizedPlane(row3 + row1); }
        case 3u: { return coverNormalizedPlane(row3 - row1); }
        case 4u: { return coverNormalizedPlane(row2); }
        default: { return coverNormalizedPlane(row3 - row2); }
    }
}

fn coverPatchVisible(bounds: GpuWebMercatorQuadCoverBounds) -> bool {
    for (var index = 0u; index < 6u; index += 1u) {
        let plane = coverFrustumPlane(index);
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

fn coverClipPlaneDistance(point: vec4f, plane: u32) -> f32 {
    // Combine the plane before projection. Subtracting two large clip coordinates
    // loses the near/far depth constant on coarse patches at high pitch.
    let matrix = mapMeta.clipFromRelativeWorld;
    let row0 = vec4f(matrix[0].x, matrix[1].x, matrix[2].x, matrix[3].x);
    let row1 = vec4f(matrix[0].y, matrix[1].y, matrix[2].y, matrix[3].y);
    let row2 = vec4f(matrix[0].z, matrix[1].z, matrix[2].z, matrix[3].z);
    let row3 = vec4f(matrix[0].w, matrix[1].w, matrix[2].w, matrix[3].w);
    switch plane {
        case 0u: { return dot(row2, point); }
        case 1u: { return dot(row3 - row2, point); }
        case 2u: { return dot(row3 + row0, point); }
        case 3u: { return dot(row3 - row0, point); }
        case 4u: { return dot(row3 + row1, point); }
        default: { return dot(row3 - row1, point); }
    }
}

fn coverClipPolygonToPlane(
    input: GpuWebMercatorQuadCoverClipPolygon,
    plane: u32,
) -> GpuWebMercatorQuadCoverClipPolygon {
    var output: GpuWebMercatorQuadCoverClipPolygon;
    if (input.count == 0u) { return output; }
    var start = input.vertices[input.count - 1u];
    var startDistance = coverClipPlaneDistance(start, plane);
    for (var index = 0u; index < input.count; index += 1u) {
        let end = input.vertices[index];
        let endDistance = coverClipPlaneDistance(end, plane);
        let startInside = startDistance >= 0.0f;
        let endInside = endDistance >= 0.0f;
        if (startInside != endInside) {
            let denominator = startDistance - endDistance;
            var ratio = 0.5f;
            if (abs(denominator) >= 0x1p-120f) {
                ratio = clamp(startDistance / denominator, 0.0f, 1.0f);
            }
            output.vertices[output.count] = vec4f(mix(start.xyz, end.xyz, ratio), 1.0f);
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

fn coverProjectedAxisCellDeltaPixels(clip: vec4f, delta: vec4f) -> vec2f {
    let reciprocalW = 1.0f / clip.w;
    let ndcDelta = (
        delta.xy - clamp(clip.xy * reciprocalW, vec2f(-1.0f), vec2f(1.0f)) * delta.w
    ) * reciprocalW;
    return ndcDelta * mapMeta.referenceViewport * 0.5f;
}

fn coverProjectedCellMaximumStretchPixels(
    clip: vec4f,
    xDelta: vec4f,
    yDelta: vec4f,
) -> f32 {
    let minimumCellW = clip.w - 0.5f * (
        abs(xDelta.w) + abs(yDelta.w)
    );
    if (minimumCellW <= 1e-5f) {
        return max(mapMeta.referenceViewport.x, mapMeta.referenceViewport.y);
    }
    let xPixels = coverProjectedAxisCellDeltaPixels(clip, xDelta);
    let yPixels = coverProjectedAxisCellDeltaPixels(clip, yDelta);
    let xx = dot(xPixels, xPixels);
    let xy = dot(xPixels, yPixels);
    let yy = dot(yPixels, yPixels);
    let discriminant = sqrt(max(
        0.0f,
        (xx - yy) * (xx - yy) + 4.0f * xy * xy,
    ));
    let maximumStretch = sqrt(max(
        0.0f,
        0.5f * (xx + yy + discriminant),
    ));
    return maximumStretch;
}

fn coverProjectedPlaneCellSpanPixels(
    bounds: GpuWebMercatorQuadCoverBounds,
    elevation: f32,
) -> f32 {
    var polygon: GpuWebMercatorQuadCoverClipPolygon;
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
        polygon.vertices[index] = vec4f(point, 1.0f);
    }
    for (var plane = 0u; plane < 6u; plane += 1u) {
        polygon = coverClipPolygonToPlane(polygon, plane);
        if (polygon.count == 0u) { return 0.0f; }
    }

    let cellMeters = max(
        bounds.maximum.x - bounds.minimum.x,
        bounds.maximum.y - bounds.minimum.y,
    ) / f32(coverPolicy.cellsPerPatchEdge);
    let xDelta = mapMeta.clipFromRelativeWorld[0] * cellMeters;
    let yDelta = mapMeta.clipFromRelativeWorld[1] * cellMeters;
    var maximumSpan = 0.0f;
    for (var index = 0u; index < polygon.count; index += 1u) {
        maximumSpan = max(
            maximumSpan,
            coverProjectedCellMaximumStretchPixels(
                mapMeta.clipFromRelativeWorld * polygon.vertices[index],
                xDelta,
                yDelta,
            ),
        );
    }
    return maximumSpan;
}

fn coverProjectedCellSpanPixels(bounds: GpuWebMercatorQuadCoverBounds) -> f32 {
    return max(
        coverProjectedPlaneCellSpanPixels(bounds, bounds.minimum.z),
        coverProjectedPlaneCellSpanPixels(bounds, bounds.maximum.z),
    );
}

fn coverCellSpanQ8(value: f32) -> u32 {
    return u32(round(clamp(value, 0.0f, 65535.0f) * 256.0f));
}

fn coverLimit(matrixLevel: u32) -> GpuWebMercatorQuadCoverLimit {
    return coverageLimits[matrixLevel - coverPolicy.minimumMatrixLevel];
}

fn coverGeometryWindow(matrixLevel: u32) -> GpuWebMercatorQuadCoverWindow {
    let root = coverLimit(coverPolicy.minimumMatrixLevel);
    if (matrixLevel == coverPolicy.minimumMatrixLevel) {
        return GpuWebMercatorQuadCoverWindow(
            i32(root.minTileRow),
            i32(root.maxTileRow),
            i32(root.minTileCol),
            i32(root.maxTileCol),
        );
    }
    let shift = matrixLevel - coverPolicy.minimumMatrixLevel;
    let scale = 1u << shift;
    return GpuWebMercatorQuadCoverWindow(
        i32(root.minTileRow * scale),
        i32((root.maxTileRow + 1u) * scale - 1u),
        i32(root.minTileCol * scale),
        i32((root.maxTileCol + 1u) * scale - 1u),
    );
}

fn coverCandidateWindow(matrixLevel: u32) -> GpuWebMercatorQuadCoverWindow {
    let window = mapMeta.candidateWindows[matrixLevel];
    var start = 0u;
    if (matrixLevel > 0u) { start = mapMeta.candidateWindows[matrixLevel - 1u].w; }
    let count = window.w - start;
    if (count == 0u) { return GpuWebMercatorQuadCoverWindow(0, -1, 0, -1); }
    return GpuWebMercatorQuadCoverWindow(
        i32(window.x), i32(window.x + count / window.z - 1u),
        i32(window.y), i32(window.y + window.z - 1u),
    );
}

fn coverClearLookup() {
    for (var index = 0u; index < coverPolicy.lookupCapacity; index += 1u) {
        coverLookup[index].occupied = 0u;
    }
}

fn coverLookupContainsIdentity(
    matrixLevel: u32,
    tileRow: u32,
    tileCol: u32,
) -> bool {
    for (var probe = 0u; probe < coverPolicy.lookupCapacity; probe += 1u) {
        let slot = GpuWebMercatorQuadCover_lookupSlot(
            matrixLevel,
            tileRow,
            tileCol,
            probe,
            coverPolicy.lookupCapacity,
        );
        let entry = coverLookup[slot];
        if (entry.occupied == 0u) { return false; }
        if (entry.matrixLevel == matrixLevel &&
            entry.tileRow == tileRow &&
            entry.tileCol == tileCol) {
            return true;
        }
    }
    return false;
}

fn coverLookupInsertIdentity(
    matrixLevel: u32,
    tileRow: u32,
    tileCol: u32,
    patchIndex: u32,
) -> bool {
    for (var probe = 0u; probe < coverPolicy.lookupCapacity; probe += 1u) {
        let slot = GpuWebMercatorQuadCover_lookupSlot(
            matrixLevel,
            tileRow,
            tileCol,
            probe,
            coverPolicy.lookupCapacity,
        );
        let entry = coverLookup[slot];
        if (entry.occupied == 0u) {
            coverLookup[slot] = GpuWebMercatorQuadCoverLookupEntry(
                1u,
                matrixLevel,
                tileRow,
                tileCol,
                patchIndex,
            );
            return true;
        }
        if (entry.matrixLevel == matrixLevel &&
            entry.tileRow == tileRow &&
            entry.tileCol == tileCol) {
            return true;
        }
    }
    return false;
}

fn coverRefinementContains(
    matrixLevel: u32,
    tileRow: u32,
    tileCol: u32,
) -> bool {
    return coverLookupContainsIdentity(matrixLevel, tileRow, tileCol);
}

fn coverMarkSparseRefinements() {
    coverClearLookup();
    coverState.finestMatrixLevel = coverPolicy.minimumMatrixLevel;
    for (var parentLevel = coverPolicy.minimumMatrixLevel;
        parentLevel < coverPolicy.maximumMatrixLevel;
        parentLevel += 1u) {
        let search = coverCandidateWindow(parentLevel);
        for (var tileRow = search.minTileRow;
            tileRow <= search.maxTileRow;
            tileRow += 1i) {
            for (var tileCol = search.minTileCol;
                tileCol <= search.maxTileCol;
                tileCol += 1i) {
                coverState.candidateCount += 1u;
                if (parentLevel > coverPolicy.minimumMatrixLevel &&
                    !coverRefinementContains(
                        parentLevel - 1u,
                        u32(tileRow) >> 1u,
                        u32(tileCol) >> 1u,
                    )) {
                    continue;
                }
                let bounds = coverPatchBounds(
                    parentLevel,
                    u32(tileRow),
                    u32(tileCol),
                );
                if (!coverPatchVisible(bounds) ||
                    coverProjectedCellSpanPixels(bounds) <=
                        coverEffectiveCellSpanThreshold()) {
                    continue;
                }
                if (!coverLookupInsertIdentity(
                    parentLevel,
                    u32(tileRow),
                    u32(tileCol),
                    0xffffffffu,
                )) {
                    coverState.lookupOverflowCount += 1u;
                    return;
                }
                coverState.finestMatrixLevel = max(
                    coverState.finestMatrixLevel,
                    parentLevel + 1u,
                );
            }
        }
    }
}

fn coverLookupInsert(patchIndex: u32) -> bool {
    let candidate = coverPatches[patchIndex];
    return coverLookupInsertIdentity(
        candidate.matrixLevel,
        candidate.tileRow,
        candidate.tileCol,
        patchIndex,
    );
}

fn coverEmitPatch(matrixLevel: u32, tileRow: u32, tileCol: u32) {
    if (!coverPatchVisible(coverPatchBounds(matrixLevel, tileRow, tileCol))) {
        return;
    }
    let patchIndex = coverState.patchCount;
    if (patchIndex >= coverPolicy.maximumPatches) {
        coverState.descriptorOverflowCount += 1u;
        return;
    }
    let candidate = GpuWebMercatorQuadCoverPatch(matrixLevel, tileRow, tileCol);
    coverPatches[patchIndex] = candidate;
    coverState.patchCount += 1u;
}

fn coverScaledBounds(
    candidate: GpuWebMercatorQuadCoverPatch,
) -> vec4u {
    let scale = 1u << (coverPolicy.maximumMatrixLevel - candidate.matrixLevel);
    return vec4u(
        candidate.tileCol * scale,
        candidate.tileRow * scale,
        (candidate.tileCol + 1u) * scale,
        (candidate.tileRow + 1u) * scale,
    );
}

fn coverEdgeAdjacent(left: vec4u, right: vec4u) -> bool {
    let horizontal = (left.z == right.x || right.z == left.x) &&
        max(left.y, right.y) < min(left.w, right.w);
    let vertical = (left.w == right.y || right.w == left.y) &&
        max(left.x, right.x) < min(left.z, right.z);
    return horizontal || vertical;
}

fn coverMaximumFinerNeighborDelta(
    candidateIndex: u32,
) -> u32 {
    let candidate = coverPatches[candidateIndex];
    let candidateBounds = coverScaledBounds(candidate);
    var maximumDelta = 0u;
    for (var otherIndex = 0u; otherIndex < coverState.patchCount; otherIndex += 1u) {
        if (otherIndex == candidateIndex) { continue; }
        let other = coverPatches[otherIndex];
        if (other.matrixLevel <= candidate.matrixLevel + 1u) { continue; }
        if (coverEdgeAdjacent(candidateBounds, coverScaledBounds(other))) {
            maximumDelta = max(
                maximumDelta,
                other.matrixLevel - candidate.matrixLevel,
            );
        }
    }
    return maximumDelta;
}

fn coverSplitPatch(patchIndex: u32) -> bool {
    if (coverState.patchCount + 3u > coverPolicy.maximumPatches) {
        coverState.descriptorOverflowCount += 1u;
        return false;
    }
    let parent = coverPatches[patchIndex];
    let childLevel = parent.matrixLevel + 1u;
    let firstRow = parent.tileRow * 2u;
    let firstCol = parent.tileCol * 2u;
    let appendStart = coverState.patchCount;
    coverPatches[patchIndex] = GpuWebMercatorQuadCoverPatch(
        childLevel,
        firstRow,
        firstCol,
    );
    coverPatches[appendStart] = GpuWebMercatorQuadCoverPatch(
        childLevel,
        firstRow,
        firstCol + 1u,
    );
    coverPatches[appendStart + 1u] = GpuWebMercatorQuadCoverPatch(
        childLevel,
        firstRow + 1u,
        firstCol,
    );
    coverPatches[appendStart + 2u] = GpuWebMercatorQuadCoverPatch(
        childLevel,
        firstRow + 1u,
        firstCol + 1u,
    );
    coverState.patchCount += 3u;
    coverState.candidateCount += 4u;
    return true;
}

fn coverCompactVisiblePatches() {
    let inputCount = coverState.patchCount;
    var outputCount = 0u;
    for (var patchIndex = 0u; patchIndex < inputCount; patchIndex += 1u) {
        let candidate = coverPatches[patchIndex];
        if (!coverPatchVisible(coverPatchBounds(
            candidate.matrixLevel,
            candidate.tileRow,
            candidate.tileCol,
        ))) {
            continue;
        }
        if (outputCount != patchIndex) {
            coverPatches[outputCount] = candidate;
        }
        outputCount += 1u;
    }
    coverState.patchCount = outputCount;
}

fn coverSeedMinimumPatches() {
    let matrixLevel = coverPolicy.minimumMatrixLevel;
    let window = coverGeometryWindow(matrixLevel);
    for (var tileRow = window.minTileRow;
        tileRow <= window.maxTileRow;
        tileRow += 1i) {
        for (var tileCol = window.minTileCol;
            tileCol <= window.maxTileCol;
            tileCol += 1i) {
            coverState.candidateCount += 1u;
            coverEmitPatch(matrixLevel, u32(tileRow), u32(tileCol));
        }
    }
}

fn coverMaterializeSparseRefinements() {
    for (var matrixLevel = coverPolicy.minimumMatrixLevel;
        matrixLevel < coverPolicy.maximumMatrixLevel;
        matrixLevel += 1u) {
        let inputCount = coverState.patchCount;
        for (var patchIndex = 0u; patchIndex < inputCount; patchIndex += 1u) {
            let candidate = coverPatches[patchIndex];
            if (candidate.matrixLevel == matrixLevel &&
                coverRefinementContains(
                    candidate.matrixLevel,
                    candidate.tileRow,
                    candidate.tileCol,
                )) {
                coverSplitPatch(patchIndex);
            }
        }
        coverCompactVisiblePatches();
    }
}

fn coverBalancePatches() {
    for (var iteration = 0u; iteration < 24u; iteration += 1u) {
        let inputCount = coverState.patchCount;
        var changed = false;
        for (var patchIndex = 0u; patchIndex < inputCount; patchIndex += 1u) {
            if (coverMaximumFinerNeighborDelta(patchIndex) > 1u &&
                coverSplitPatch(patchIndex)) {
                changed = true;
            }
        }
        if (!changed) { break; }
    }
}

fn coverFinalizeLookup() {
    coverState.minimumMatrixLevel = 0xffffffffu;
    coverState.maximumMatrixLevel = 0u;
    coverState.maximumAdjacentLevelDelta = 0u;
    coverState.minimumCellSpanQ8 = 0xffffffffu;
    coverState.maximumCellSpanQ8 = 0u;
    coverClearLookup();
    for (var patchIndex = 0u; patchIndex < coverState.patchCount; patchIndex += 1u) {
        let candidate = coverPatches[patchIndex];
        coverState.minimumMatrixLevel = min(
            coverState.minimumMatrixLevel,
            candidate.matrixLevel,
        );
        coverState.maximumMatrixLevel = max(
            coverState.maximumMatrixLevel,
            candidate.matrixLevel,
        );
        let cellSpan = coverCellSpanQ8(coverProjectedCellSpanPixels(
            coverPatchBounds(
                candidate.matrixLevel,
                candidate.tileRow,
                candidate.tileCol,
            ),
        ));
        coverState.minimumCellSpanQ8 = min(
            coverState.minimumCellSpanQ8,
            cellSpan,
        );
        coverState.maximumCellSpanQ8 = max(
            coverState.maximumCellSpanQ8,
            cellSpan,
        );
        if (!coverLookupInsert(patchIndex)) {
            coverState.lookupOverflowCount += 1u;
        }
    }
    for (var leftIndex = 0u; leftIndex < coverState.patchCount; leftIndex += 1u) {
        let left = coverPatches[leftIndex];
        let leftBounds = coverScaledBounds(left);
        for (var rightIndex = leftIndex + 1u;
            rightIndex < coverState.patchCount;
            rightIndex += 1u) {
            let right = coverPatches[rightIndex];
            if (coverEdgeAdjacent(leftBounds, coverScaledBounds(right))) {
                coverState.maximumAdjacentLevelDelta = max(
                    coverState.maximumAdjacentLevelDelta,
                    u32(abs(i32(left.matrixLevel) - i32(right.matrixLevel))),
                );
            }
        }
    }
}

@compute @workgroup_size(1)
fn generateWebMercatorQuadCover() {
    coverState.frameEpoch = mapMeta.frameEpoch;
    coverState.candidateCount = 0u;
    coverState.patchCount = 0u;
    coverState.descriptorOverflowCount = 0u;
    coverState.lookupOverflowCount = 0u;
    coverState.minimumMatrixLevel = 0xffffffffu;
    coverState.maximumMatrixLevel = 0u;
    coverState.maximumAdjacentLevelDelta = 0u;
    coverState.minimumCellSpanQ8 = 0xffffffffu;
    coverState.maximumCellSpanQ8 = 0u;

    coverMarkSparseRefinements();
    coverSeedMinimumPatches();
    coverMaterializeSparseRefinements();
    coverBalancePatches();
    coverCompactVisiblePatches();
    coverFinalizeLookup();
    if (coverState.descriptorOverflowCount != 0u ||
        coverState.lookupOverflowCount != 0u ||
        coverState.maximumAdjacentLevelDelta > 1u) {
        // Preserve failure feedback, but revoke the partial cut before any consumer.
        coverState.patchCount = 0u;
        coverClearLookup();
    }
}
`
