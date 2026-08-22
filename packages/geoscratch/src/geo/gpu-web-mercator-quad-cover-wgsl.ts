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
var<storage, read_write> coverPatches: array<GpuWebMercatorQuadCoverPatch>;
@group(0) @binding(4)
var<storage, read_write> coverLookup: array<GpuWebMercatorQuadCoverLookupEntry>;
@group(0) @binding(5)
var<storage, read_write> coverState: GpuWebMercatorQuadCoverState;
@group(0) @binding(6)
var<storage, read_write> coverDemands: array<GpuWebMercatorQuadCoverDemand>;
@group(0) @binding(7)
var<storage, read_write> drawArguments: array<u32>;

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
    let minimumZ = coverSubtractExpansions(
        coverPolicy.minimumElevationMeters,
        0.0f,
        mapMeta.cameraHigh.z,
        mapMeta.cameraLow.z,
    );
    let maximumZ = coverSubtractExpansions(
        coverPolicy.maximumElevationMeters,
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
    switch plane {
        case 0u: { return point.z; }
        case 1u: { return point.w - point.z; }
        case 2u: { return point.x + point.w; }
        case 3u: { return point.w - point.x; }
        case 4u: { return point.y + point.w; }
        default: { return point.w - point.y; }
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

fn coverProjectedAxisCellDeltaPixels(clip: vec4f, delta: vec4f) -> vec2f {
    let reciprocalW = 1.0f / clip.w;
    let ndcDelta = (
        delta.xy - clip.xy * reciprocalW * delta.w
    ) * reciprocalW;
    return ndcDelta * mapMeta.referenceViewport * 0.5f;
}

fn coverProjectedCellAreaScalePixels(
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
    return sqrt(abs(xPixels.x * yPixels.y - xPixels.y * yPixels.x));
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
        polygon.vertices[index] = mapMeta.clipFromRelativeWorld * vec4f(point, 1.0f);
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
            coverProjectedCellAreaScalePixels(
                polygon.vertices[index],
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

fn coverAlignToParentGroups(
    value: GpuWebMercatorQuadCoverWindow,
) -> GpuWebMercatorQuadCoverWindow {
    return GpuWebMercatorQuadCoverWindow(
        value.minTileRow & -2i,
        value.maxTileRow | 1i,
        value.minTileCol & -2i,
        value.maxTileCol | 1i,
    );
}

fn coverFitStart(value: i32, span: i32, minimum: i32, maximum: i32) -> i32 {
    return clamp(value, minimum, maximum - span + 1i);
}

fn coverFitWindow(
    value: GpuWebMercatorQuadCoverWindow,
    limit: GpuWebMercatorQuadCoverWindow,
) -> GpuWebMercatorQuadCoverWindow {
    let height = min(
        value.maxTileRow - value.minTileRow + 1i,
        limit.maxTileRow - limit.minTileRow + 1i,
    );
    let width = min(
        value.maxTileCol - value.minTileCol + 1i,
        limit.maxTileCol - limit.minTileCol + 1i,
    );
    let minRow = coverFitStart(
        value.minTileRow,
        height,
        limit.minTileRow,
        limit.maxTileRow,
    );
    let minCol = coverFitStart(
        value.minTileCol,
        width,
        limit.minTileCol,
        limit.maxTileCol,
    );
    return GpuWebMercatorQuadCoverWindow(
        minRow,
        minRow + height - 1i,
        minCol,
        minCol + width - 1i,
    );
}

fn coverCameraTileIndex(low: u32, high: u32, matrixLevel: u32) -> u32 {
    let shift = coverPolicy.coordinateBits - matrixLevel;
    if (shift >= 32u) {
        return high >> (shift - 32u);
    }
    if (shift == 0u) {
        return low;
    }
    return (high << (32u - shift)) | (low >> shift);
}

fn coverWindowValid(value: GpuWebMercatorQuadCoverWindow) -> bool {
    return value.minTileRow <= value.maxTileRow &&
        value.minTileCol <= value.maxTileCol;
}

fn coverInvalidWindow() -> GpuWebMercatorQuadCoverWindow {
    return GpuWebMercatorQuadCoverWindow(1i, 0i, 1i, 0i);
}

fn coverProjectedSearchRadiusTiles() -> i32 {
    let focalPixels = mapMeta.referenceViewport.y * 0.5f /
        tan(mapMeta.verticalFovRadians * 0.5f);
    return max(2i, i32(ceil(
        focalPixels /
        (f32(coverPolicy.cellsPerPatchEdge) * coverEffectiveCellSpanThreshold())
    )) + 2i);
}

fn coverSidePlaneIntersection(
    first: GpuWebMercatorQuadCoverPlane,
    second: GpuWebMercatorQuadCoverPlane,
    elevation: f32,
) -> vec2f {
    let firstConstant = first.normal.z * elevation + first.distance;
    let secondConstant = second.normal.z * elevation + second.distance;
    let determinant = first.normal.x * second.normal.y -
        second.normal.x * first.normal.y;
    if (abs(determinant) <= 1e-8f) {
        return vec2f(WEB_MERCATOR_WORLD_WIDTH_METERS);
    }
    return vec2f(
        (first.normal.y * secondConstant -
            second.normal.y * firstConstant) / determinant,
        (second.normal.x * firstConstant -
            first.normal.x * secondConstant) / determinant,
    );
}

fn coverUniformFootprintBounds() -> vec4f {
    var bounds = vec4f(
        WEB_MERCATOR_WORLD_WIDTH_METERS,
        WEB_MERCATOR_WORLD_WIDTH_METERS,
        -WEB_MERCATOR_WORLD_WIDTH_METERS,
        -WEB_MERCATOR_WORLD_WIDTH_METERS,
    );
    let cameraElevation = mapMeta.cameraHigh.z + mapMeta.cameraLow.z;
    for (var elevationIndex = 0u; elevationIndex < 2u; elevationIndex += 1u) {
        let elevation = select(
            coverPolicy.minimumElevationMeters,
            coverPolicy.maximumElevationMeters,
            elevationIndex == 1u,
        ) - cameraElevation;
        for (var horizontal = 0u; horizontal < 2u; horizontal += 1u) {
            for (var vertical = 0u; vertical < 2u; vertical += 1u) {
                let point = coverSidePlaneIntersection(
                    coverFrustumPlane(horizontal),
                    coverFrustumPlane(2u + vertical),
                    elevation,
                );
                bounds = vec4f(
                    min(bounds.x, point.x),
                    min(bounds.y, point.y),
                    max(bounds.z, point.x),
                    max(bounds.w, point.y),
                );
            }
        }
    }
    return bounds;
}

fn coverUniformWindow(matrixLevel: u32) -> GpuWebMercatorQuadCoverWindow {
    let tileRow = i32(coverCameraTileIndex(
        mapMeta.cameraFixedLow.y,
        mapMeta.cameraFixedHigh.y,
        matrixLevel,
    ));
    let tileCol = i32(coverCameraTileIndex(
        mapMeta.cameraFixedLow.x,
        mapMeta.cameraFixedHigh.x,
        matrixLevel,
    ));
    let tileMeters = ldexp(WEB_MERCATOR_WORLD_WIDTH_METERS, -i32(matrixLevel));
    let cameraTile = coverPatchBounds(
        matrixLevel,
        u32(tileRow),
        u32(tileCol),
    );
    let footprint = coverUniformFootprintBounds();
    return coverAlignToParentGroups(GpuWebMercatorQuadCoverWindow(
        tileRow + i32(floor((cameraTile.maximum.y - footprint.w) / tileMeters)) - 1i,
        tileRow + i32(floor((cameraTile.maximum.y - footprint.y) / tileMeters)) + 1i,
        tileCol + i32(floor((footprint.x - cameraTile.minimum.x) / tileMeters)) - 1i,
        tileCol + i32(floor((footprint.z - cameraTile.minimum.x) / tileMeters)) + 1i,
    ));
}

fn coverVariableRefinementWindow(
    childLevel: u32,
) -> GpuWebMercatorQuadCoverWindow {
    let parentLevel = childLevel - 1u;
    let radius = coverProjectedSearchRadiusTiles();
    let parentRow = i32(coverCameraTileIndex(
        mapMeta.cameraFixedLow.y,
        mapMeta.cameraFixedHigh.y,
        parentLevel,
    ));
    let parentCol = i32(coverCameraTileIndex(
        mapMeta.cameraFixedLow.x,
        mapMeta.cameraFixedHigh.x,
        parentLevel,
    ));
    let search = coverFitWindow(GpuWebMercatorQuadCoverWindow(
        parentRow - radius,
        parentRow + radius,
        parentCol - radius,
        parentCol + radius,
    ), coverGeometryWindow(parentLevel));
    var output = coverInvalidWindow();
    for (var tileRow = search.minTileRow; tileRow <= search.maxTileRow; tileRow += 1i) {
        for (var tileCol = search.minTileCol; tileCol <= search.maxTileCol; tileCol += 1i) {
            coverState.candidateCount += 1u;
            let bounds = coverPatchBounds(parentLevel, u32(tileRow), u32(tileCol));
            if (!coverPatchVisible(bounds) ||
                coverProjectedCellSpanPixels(bounds) <=
                    coverEffectiveCellSpanThreshold()) {
                continue;
            }
            let children = GpuWebMercatorQuadCoverWindow(
                tileRow * 2i,
                tileRow * 2i + 1i,
                tileCol * 2i,
                tileCol * 2i + 1i,
            );
            if (coverWindowValid(output)) {
                output = coverUnionWindow(output, children);
            } else {
                output = children;
            }
        }
    }
    if (!coverWindowValid(output)) { return output; }
    return coverFitWindow(
        coverAlignToParentGroups(output),
        coverGeometryWindow(childLevel),
    );
}

fn coverUnionWindow(
    left: GpuWebMercatorQuadCoverWindow,
    right: GpuWebMercatorQuadCoverWindow,
) -> GpuWebMercatorQuadCoverWindow {
    return GpuWebMercatorQuadCoverWindow(
        min(left.minTileRow, right.minTileRow),
        max(left.maxTileRow, right.maxTileRow),
        min(left.minTileCol, right.minTileCol),
        max(left.maxTileCol, right.maxTileCol),
    );
}

fn coverFullyCoveredByFiner(
    tileRow: u32,
    tileCol: u32,
    finer: GpuWebMercatorQuadCoverWindow,
) -> bool {
    return i32(tileRow * 2u) >= finer.minTileRow &&
        i32(tileRow * 2u + 1u) <= finer.maxTileRow &&
        i32(tileCol * 2u) >= finer.minTileCol &&
        i32(tileCol * 2u + 1u) <= finer.maxTileCol;
}

fn coverLookupInsert(patchIndex: u32) -> bool {
    let candidate = coverPatches[patchIndex];
    for (var probe = 0u; probe < coverPolicy.lookupCapacity; probe += 1u) {
        let slot = GpuWebMercatorQuadCover_lookupSlot(
            candidate.matrixLevel,
            candidate.tileRow,
            candidate.tileCol,
            probe,
            coverPolicy.lookupCapacity,
        );
        if (coverLookup[slot].occupied == 0u) {
            coverLookup[slot] = GpuWebMercatorQuadCoverLookupEntry(
                1u,
                candidate.matrixLevel,
                candidate.tileRow,
                candidate.tileCol,
                patchIndex,
            );
            return true;
        }
    }
    return false;
}

fn coverCoverageContains(matrixLevel: u32, tileRow: u32, tileCol: u32) -> bool {
    if (matrixLevel < coverPolicy.minimumMatrixLevel ||
        matrixLevel > coverPolicy.sourceMaximumMatrixLevel) {
        return false;
    }
    let limit = coverLimit(matrixLevel);
    return tileRow >= limit.minTileRow && tileRow <= limit.maxTileRow &&
        tileCol >= limit.minTileCol && tileCol <= limit.maxTileCol;
}

fn coverDemandIndex(matrixLevel: u32, tileRow: u32, tileCol: u32) -> u32 {
    for (var index = 0u; index < coverState.demandCount; index += 1u) {
        let demand = coverDemands[index];
        if (demand.requestMatrixLevel == matrixLevel &&
            demand.tileRow == tileRow &&
            demand.tileCol == tileCol) {
            return index;
        }
    }
    return 0xffffffffu;
}

fn coverDemandPriority(
    desiredSampleLevel: u32,
    requestLevel: u32,
    tileRow: u32,
    tileCol: u32,
) -> u32 {
    let cameraRow = coverCameraTileIndex(
        mapMeta.cameraFixedLow.y,
        mapMeta.cameraFixedHigh.y,
        requestLevel,
    );
    let cameraCol = coverCameraTileIndex(
        mapMeta.cameraFixedLow.x,
        mapMeta.cameraFixedHigh.x,
        requestLevel,
    );
    let rowDistance = u32(abs(i32(tileRow) - i32(cameraRow)));
    let rawColDistance = u32(abs(i32(tileCol) - i32(cameraCol)));
    let matrixWidth = 1u << requestLevel;
    let colDistance = min(rawColDistance, matrixWidth - rawColDistance);
    let distance = min(rowDistance + colDistance, 999999u);
    return desiredSampleLevel * 1000000u + 999999u - distance;
}

fn coverEmitDemand(candidate: GpuWebMercatorQuadCoverPatch) {
    var requestLevel = min(
        candidate.matrixLevel,
        coverPolicy.sourceMaximumMatrixLevel,
    );
    var shift = candidate.matrixLevel - requestLevel;
    var tileRow = candidate.tileRow >> shift;
    var tileCol = candidate.tileCol >> shift;
    loop {
        if (coverCoverageContains(requestLevel, tileRow, tileCol)) { break; }
        if (requestLevel == coverPolicy.minimumMatrixLevel) { return; }
        requestLevel -= 1u;
        shift += 1u;
        tileRow = candidate.tileRow >> shift;
        tileCol = candidate.tileCol >> shift;
    }
    let priority = coverDemandPriority(
        candidate.matrixLevel,
        requestLevel,
        tileRow,
        tileCol,
    );
    let existing = coverDemandIndex(requestLevel, tileRow, tileCol);
    if (existing != 0xffffffffu) {
        coverDemands[existing].desiredSampleLevel = max(
            coverDemands[existing].desiredSampleLevel,
            candidate.matrixLevel,
        );
        coverDemands[existing].priority = max(
            coverDemands[existing].priority,
            priority,
        );
        return;
    }
    let demandIndex = coverState.demandCount;
    if (demandIndex >= coverPolicy.demandCapacity) {
        coverState.demandOverflowCount += 1u;
        return;
    }
    coverDemands[demandIndex] = GpuWebMercatorQuadCoverDemand(
        candidate.matrixLevel,
        coverPolicy.sourceMaximumMatrixLevel,
        requestLevel,
        tileRow,
        tileCol,
        priority,
        mapMeta.frameEpoch,
        mapMeta.residencySnapshotEpoch,
    );
    coverState.demandCount += 1u;
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

fn coverFinalizeLookupAndDemands() {
    coverState.minimumMatrixLevel = 0xffffffffu;
    coverState.maximumMatrixLevel = 0u;
    coverState.maximumAdjacentLevelDelta = 0u;
    coverState.minimumCellSpanQ8 = 0xffffffffu;
    coverState.maximumCellSpanQ8 = 0u;
    coverState.demandCount = 0u;
    for (var index = 0u; index < coverPolicy.lookupCapacity; index += 1u) {
        coverLookup[index].occupied = 0u;
    }
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
        coverEmitDemand(candidate);
        if (!coverLookupInsert(patchIndex)) {
            coverState.lookupOverflowCount += 1u;
        }
    }
    if (coverState.selectionMode == 1u) {
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
    drawArguments[0] = coverPolicy.vertexCount;
    drawArguments[1] = coverState.patchCount;
    drawArguments[2] = 0u;
    drawArguments[3] = 0u;
}

@compute @workgroup_size(1)
fn generateWebMercatorQuadCover() {
    coverState.frameEpoch = mapMeta.frameEpoch;
    coverState.candidateCount = 0u;
    coverState.patchCount = 0u;
    coverState.demandCount = 0u;
    coverState.descriptorOverflowCount = 0u;
    coverState.lookupOverflowCount = 0u;
    coverState.demandOverflowCount = 0u;
    coverState.minimumMatrixLevel = 0xffffffffu;
    coverState.maximumMatrixLevel = 0u;
    coverState.maximumAdjacentLevelDelta = 0u;
    coverState.sourceLevelCeiling = coverPolicy.sourceMaximumMatrixLevel;
    coverState.selectionMode = select(
        1u,
        0u,
        mapMeta.cameraPitchRadians < coverPolicy.variableLodPitchThresholdRadians,
    );
    coverState.minimumCellSpanQ8 = 0xffffffffu;
    coverState.maximumCellSpanQ8 = 0u;
    drawArguments[0] = coverPolicy.vertexCount;
    drawArguments[1] = 0u;
    drawArguments[2] = 0u;
    drawArguments[3] = 0u;

    var windows: array<GpuWebMercatorQuadCoverWindow, 25>;
    for (var index = 0u; index < 25u; index += 1u) {
        windows[index] = coverInvalidWindow();
    }
    var finestLevel = coverPolicy.minimumMatrixLevel;
    let uniformMode = coverState.selectionMode == 0u;
    if (uniformMode) {
        let zoomAnchor = mapMeta.zoomHint + log2(
            512.0f / coverPolicy.referenceTileSizePixels
        );
        let probeLevel = u32(clamp(
            i32(floor(zoomAnchor)),
            i32(coverPolicy.minimumMatrixLevel),
            i32(coverPolicy.maximumMatrixLevel),
        ));
        let probeWindow = coverFitWindow(
            coverUniformWindow(probeLevel),
            coverGeometryWindow(probeLevel),
        );
        var maximumSpan = 0.0f;
        var visibleCount = 0u;
        for (var tileRow = probeWindow.minTileRow;
            tileRow <= probeWindow.maxTileRow;
            tileRow += 1i) {
            for (var tileCol = probeWindow.minTileCol;
                tileCol <= probeWindow.maxTileCol;
                tileCol += 1i) {
                coverState.candidateCount += 1u;
                let bounds = coverPatchBounds(probeLevel, u32(tileRow), u32(tileCol));
                if (coverPatchVisible(bounds)) {
                    visibleCount += 1u;
                    maximumSpan = max(
                        maximumSpan,
                        coverProjectedCellSpanPixels(bounds),
                    );
                }
            }
        }
        var levelAdjustment = 0i;
        let effectiveThreshold = coverEffectiveCellSpanThreshold();
        if (visibleCount > 0u && maximumSpan > effectiveThreshold) {
            levelAdjustment = i32(ceil(log2(
                maximumSpan / effectiveThreshold
            )));
        }
        finestLevel = u32(clamp(
            i32(probeLevel) + levelAdjustment,
            i32(coverPolicy.minimumMatrixLevel),
            i32(coverPolicy.maximumMatrixLevel),
        ));
        windows[finestLevel] = coverFitWindow(
            coverUniformWindow(finestLevel),
            coverGeometryWindow(finestLevel),
        );
    } else {
        windows[coverPolicy.minimumMatrixLevel] = coverGeometryWindow(
            coverPolicy.minimumMatrixLevel,
        );
        for (var childLevel = coverPolicy.minimumMatrixLevel + 1u;
            childLevel <= coverPolicy.maximumMatrixLevel;
            childLevel += 1u) {
            windows[childLevel] = coverVariableRefinementWindow(childLevel);
        }
        var nestLevel = i32(coverPolicy.maximumMatrixLevel) - 1i;
        loop {
            if (nestLevel <= i32(coverPolicy.minimumMatrixLevel)) { break; }
            let finer = windows[u32(nestLevel + 1i)];
            if (coverWindowValid(finer)) {
                var parent = GpuWebMercatorQuadCoverWindow(
                    finer.minTileRow / 2i,
                    finer.maxTileRow / 2i,
                    finer.minTileCol / 2i,
                    finer.maxTileCol / 2i,
                );
                let current = windows[u32(nestLevel)];
                if (coverWindowValid(current)) {
                    parent = coverUnionWindow(current, parent);
                }
                windows[u32(nestLevel)] = coverFitWindow(
                    coverAlignToParentGroups(parent),
                    coverGeometryWindow(u32(nestLevel)),
                );
            }
            nestLevel -= 1i;
        }
        for (var observedLevel = coverPolicy.minimumMatrixLevel;
            observedLevel <= coverPolicy.maximumMatrixLevel;
            observedLevel += 1u) {
            if (coverWindowValid(windows[observedLevel])) {
                finestLevel = observedLevel;
            }
        }
    }
    coverState.finestMatrixLevel = finestLevel;

    var matrixLevel = i32(finestLevel);
    loop {
        if (matrixLevel < i32(coverPolicy.minimumMatrixLevel)) { break; }
        let window = windows[u32(matrixLevel)];
        if (!coverWindowValid(window)) {
            matrixLevel -= 1i;
            continue;
        }
        var tileRow = window.minTileRow;
        loop {
            if (tileRow > window.maxTileRow) { break; }
            var tileCol = window.minTileCol;
            loop {
                if (tileCol > window.maxTileCol) { break; }
                coverState.candidateCount += 1u;
                let coveredByFiner = matrixLevel < i32(finestLevel) &&
                    coverWindowValid(windows[u32(matrixLevel + 1i)]) &&
                    coverFullyCoveredByFiner(
                        u32(tileRow),
                        u32(tileCol),
                        windows[u32(matrixLevel + 1i)],
                    );
                if (!coveredByFiner) {
                    coverEmitPatch(u32(matrixLevel), u32(tileRow), u32(tileCol));
                }
                tileCol += 1i;
            }
            tileRow += 1i;
        }
        matrixLevel -= 1i;
    }
    if (!uniformMode) { coverBalancePatches(); }
    coverFinalizeLookupAndDemands();
}
`
