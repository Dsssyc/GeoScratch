struct DemTerrainConfig {
    sourceMercatorBox: vec4f,
    elevationRange: vec2f,
    coordinateBits: u32,
    exaggeration: f32,
    renderMaximumMatrixLevel: u32,
    renderPatchLookupCapacity: u32,
    reserved: f32,
};

struct DemRenderPatchLookupEntry {
    key: u32,
    patchIndex: u32,
};

struct DemRenderPatchNeighbor {
    found: u32,
    matrixLevel: u32,
    samplingLevel: u32,
    patchIndex: u32,
};

struct VertexInput {
    @builtin(vertex_index) vertexIndex: u32,
    @builtin(instance_index) instanceIndex: u32,
};

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) depth: f32,
    @location(1) @interpolate(flat) level: f32,
    @location(2) uv: vec2f,
    @location(3) @interpolate(flat) sampleStatus: f32,
    @location(4) @interpolate(flat) resolvedHeightLevel: f32,
    @location(5) barycentric: vec3f,
    @location(6) @interpolate(flat) tileColor: vec3f,
};

@group(0) @binding(0) var<uniform> mapMeta: GpuTileFrontierMapMeta;
@group(0) @binding(1) var<uniform> terrainConfig: DemTerrainConfig;

@group(1) @binding(0) var<storage, read> indices: array<u32>;
@group(1) @binding(1) var<storage, read> gridPositions: array<u32>;
@group(1) @binding(2) var<storage, read> visibleInstances:
    array<DemRenderPatch>;
@group(1) @binding(3) var<storage, read> renderPatchLookupEntries:
    array<DemRenderPatchLookupEntry>;

const TERRAIN_SECTOR_SIZE: u32 = 64u;
const WEB_MERCATOR_WORLD_WIDTH_METERS: f32 = 40075016.0f;

fn nan() -> f32 {
    let zero = 0.0f;
    return zero / zero;
}

fn gridPosition(index: u32) -> vec2u {
    return vec2u(gridPositions[index * 2u], gridPositions[index * 2u + 1u]);
}

fn logicalTileColor(instance: DemRenderPatch) -> vec3f {
    var hash = instance.matrixLevel * 0x9e3779b9u;
    hash = hash ^ (instance.tileRow * 0x85ebca6bu);
    hash = hash ^ (instance.tileCol * 0xc2b2ae35u);
    hash = (hash ^ (hash >> 16u)) * 0x7feb352du;
    hash = (hash ^ (hash >> 15u)) * 0x846ca68bu;
    hash = hash ^ (hash >> 16u);
    return vec3f(
        0.35f + 0.65f * f32(hash & 255u) / 255.0f,
        0.35f + 0.65f * f32((hash >> 8u) & 255u) / 255.0f,
        0.35f + 0.65f * f32((hash >> 16u) & 255u) / 255.0f,
    );
}

fn barycentricForVertex(vertexIndex: u32) -> vec3f {
    let corner = vertexIndex % 3u;
    return vec3f(
        select(0.0f, 1.0f, corner == 0u),
        select(0.0f, 1.0f, corner == 1u),
        select(0.0f, 1.0f, corner == 2u),
    );
}

fn triangleCentroid(triangleId: u32) -> vec2f {
    let first = vec2f(gridPosition(indices[triangleId * 3u]));
    let second = vec2f(gridPosition(indices[triangleId * 3u + 1u]));
    let third = vec2f(gridPosition(indices[triangleId * 3u + 2u]));
    return (first + second + third) / (3.0f * f32(TERRAIN_SECTOR_SIZE));
}

fn fixedAxisFromShiftedNumerator(numerator: u32, shift: u32) -> DemAddressFixedAxis {
    if (shift == 0u) {
        return DemAddressFixedAxis(numerator, 0u);
    }
    if (shift < 32u) {
        return DemAddressFixedAxis(
            numerator << shift,
            numerator >> (32u - shift),
        );
    }
    return DemAddressFixedAxis(0u, numerator << (shift - 32u));
}

fn fixedMercatorPosition(
    instance: DemRenderPatch,
    grid: vec2u,
) -> DemAddressFixedPosition {
    let shift = terrainConfig.coordinateBits - instance.matrixLevel - 6u;
    let eastNumerator = instance.tileCol * TERRAIN_SECTOR_SIZE + grid.x;
    let southNumerator = instance.tileRow * TERRAIN_SECTOR_SIZE +
        (TERRAIN_SECTOR_SIZE - grid.y);
    return DemAddressFixedPosition(array<DemAddressFixedAxis, 2>(
        fixedAxisFromShiftedNumerator(eastNumerator, shift),
        fixedAxisFromShiftedNumerator(southNumerator, shift),
    ));
}

fn subtractFixedAxis(
    left: DemAddressFixedAxis,
    right: DemAddressFixedAxis,
) -> DemAddressFixedAxis {
    let borrow = select(0u, 1u, left.low < right.low);
    return DemAddressFixedAxis(
        left.low - right.low,
        left.high - right.high - borrow,
    );
}

fn fixedAxisMagnitude(value: DemAddressFixedAxis) -> DemAddressFixedAxis {
    if ((value.high & 0x80000000u) == 0u) {
        return value;
    }
    let low = ~value.low + 1u;
    let carry = select(0u, 1u, low == 0u);
    return DemAddressFixedAxis(low, ~value.high + carry);
}

fn relativeFixedMeters(
    left: DemAddressFixedAxis,
    right: DemAddressFixedAxis,
) -> f32 {
    let difference = subtractFixedAxis(left, right);
    let negative = (difference.high & 0x80000000u) != 0u;
    let magnitude = fixedAxisMagnitude(difference);
    let quantumMeters = ldexp(
        WEB_MERCATOR_WORLD_WIDTH_METERS,
        -i32(terrainConfig.coordinateBits),
    );
    let highLimbMeters = ldexp(quantumMeters, 32);
    let meters = f32(magnitude.high) * highLimbMeters +
        f32(magnitude.low) * quantumMeters;
    return select(meters, -meters, negative);
}

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

fn fixedAxisFraction(value: DemAddressFixedAxis) -> f32 {
    return ldexp(
        f32(value.high),
        32 - i32(terrainConfig.coordinateBits),
    ) + ldexp(f32(value.low), -i32(terrainConfig.coordinateBits));
}

fn sourceUv(position: DemAddressFixedPosition) -> vec2f {
    let normalized = vec2f(
        fixedAxisFraction(position.axes[0]),
        fixedAxisFraction(position.axes[1]),
    );
    let extent = terrainConfig.sourceMercatorBox.zw -
        terrainConfig.sourceMercatorBox.xy;
    return (normalized - terrainConfig.sourceMercatorBox.xy) / extent;
}

fn sourceContains(uv: vec2f) -> bool {
    return all(uv >= vec2f(0.0f)) && all(uv <= vec2f(1.0f));
}

fn missingNeighbor() -> DemRenderPatchNeighbor {
    return DemRenderPatchNeighbor(0u, 0u, 0u, 0xffffffffu);
}

fn renderPatchLookup(
    matrixLevel: u32,
    tileRow: u32,
    tileCol: u32,
) -> DemRenderPatchNeighbor {
    let key = DemRenderPatch_lookupKey(matrixLevel, tileRow, tileCol);
    for (var probe = 0u; probe < terrainConfig.renderPatchLookupCapacity; probe += 1u) {
        let slot = DemRenderPatch_lookupSlot(
            key,
            probe,
            terrainConfig.renderPatchLookupCapacity,
        );
        let entry = renderPatchLookupEntries[slot];
        if (entry.key == 0u) { return missingNeighbor(); }
        if (entry.key == key) {
            let resolvedPatch = visibleInstances[entry.patchIndex];
            return DemRenderPatchNeighbor(
                1u,
                resolvedPatch.matrixLevel,
                resolvedPatch.samplingLevel,
                entry.patchIndex,
            );
        }
    }
    return missingNeighbor();
}

fn patchCoveringRenderCell(renderRow: u32, renderCol: u32) -> DemRenderPatchNeighbor {
    var matrixLevel = terrainConfig.renderMaximumMatrixLevel;
    loop {
        let shift = terrainConfig.renderMaximumMatrixLevel - matrixLevel;
        let result = renderPatchLookup(matrixLevel, renderRow >> shift, renderCol >> shift);
        if (result.found != 0u) { return result; }
        if (matrixLevel == 0u) { break; }
        matrixLevel -= 1u;
    }
    return missingNeighbor();
}

fn neighboringPatch(
    instance: DemRenderPatch,
    edge: u32,
    local: vec2f,
) -> DemRenderPatchNeighbor {
    let levelDelta = terrainConfig.renderMaximumMatrixLevel - instance.matrixLevel;
    let scale = 1u << levelDelta;
    let matrixWidth = 1u << terrainConfig.renderMaximumMatrixLevel;
    let west = instance.tileCol * scale;
    let north = instance.tileRow * scale;
    let alongX = min(scale - 1u, u32(floor(clamp(local.x, 0.0f, 0.99999994f) * f32(scale))));
    let alongSouth = min(
        scale - 1u,
        u32(floor(clamp(1.0f - local.y, 0.0f, 0.99999994f) * f32(scale))),
    );
    var row = north + alongSouth;
    var column = west + alongX;
    switch edge {
        case 0u: {
            column = (west + matrixWidth - 1u) % matrixWidth;
        }
        case 1u: {
            column = (west + scale) % matrixWidth;
        }
        case 2u: {
            if (north == 0u) { return missingNeighbor(); }
            row = north - 1u;
        }
        default: {
            row = north + scale;
            if (row >= matrixWidth) { return missingNeighbor(); }
        }
    }
    return patchCoveringRenderCell(row, column);
}

fn snapEdgeCoordinate(
    coordinate: u32,
    matrixLevel: u32,
    neighborMatrixLevel: u32,
) -> u32 {
    if (neighborMatrixLevel >= matrixLevel) { return coordinate; }
    let levelDelta = min(matrixLevel - neighborMatrixLevel, 6u);
    let step = 1u << levelDelta;
    return min(TERRAIN_SECTOR_SIZE, ((coordinate + step - 1u) / step) * step);
}

fn positionCs(position: DemAddressFixedPosition, elevation: f32) -> vec4f {
    let cameraX = DemAddressFixedAxis(
        mapMeta.cameraFixedLow.x,
        mapMeta.cameraFixedHigh.x,
    );
    let cameraSouth = DemAddressFixedAxis(
        mapMeta.cameraFixedLow.y,
        mapMeta.cameraFixedHigh.y,
    );
    let relativeX = relativeFixedMeters(position.axes[0], cameraX);
    let relativeY = relativeFixedMeters(cameraSouth, position.axes[1]);
    let relativeZ = subtractExpansions(
        elevation * terrainConfig.exaggeration,
        0.0f,
        mapMeta.cameraHigh.z,
        mapMeta.cameraLow.z,
    );
    return mapMeta.clipFromRelativeWorld * vec4f(
        relativeX,
        relativeY,
        relativeZ,
        1.0f,
    );
}

@vertex
fn vMain(input: VertexInput) -> VertexOutput {
    let instance = visibleInstances[input.instanceIndex];
    let triangleId = input.vertexIndex / 3u;
    var grid = gridPosition(indices[input.vertexIndex]);
    let ownMatrixLevel = instance.matrixLevel;
    var heightLevel = min(instance.samplingLevel, DemHeight_level_count - 1u);

    if (grid.x == 0u) {
        let left = neighboringPatch(instance, 0u, triangleCentroid(triangleId));
        if (left.found != 0u) {
            heightLevel = max(heightLevel, left.samplingLevel);
            grid.y = snapEdgeCoordinate(grid.y, ownMatrixLevel, left.matrixLevel);
        }
    }
    if (grid.x == TERRAIN_SECTOR_SIZE) {
        let right = neighboringPatch(instance, 1u, triangleCentroid(triangleId));
        if (right.found != 0u) {
            heightLevel = max(heightLevel, right.samplingLevel);
            grid.y = snapEdgeCoordinate(grid.y, ownMatrixLevel, right.matrixLevel);
        }
    }
    if (grid.y == 0u) {
        let bottom = neighboringPatch(instance, 3u, triangleCentroid(triangleId));
        if (bottom.found != 0u) {
            heightLevel = max(heightLevel, bottom.samplingLevel);
            grid.x = snapEdgeCoordinate(grid.x, ownMatrixLevel, bottom.matrixLevel);
        }
    }
    if (grid.y == TERRAIN_SECTOR_SIZE) {
        let top = neighboringPatch(instance, 2u, triangleCentroid(triangleId));
        if (top.found != 0u) {
            heightLevel = max(heightLevel, top.samplingLevel);
            grid.x = snapEdgeCoordinate(grid.x, ownMatrixLevel, top.matrixLevel);
        }
    }

    let position = fixedMercatorPosition(instance, grid);
    let uv = sourceUv(position);
    var output: VertexOutput;
    if (sourceContains(uv)) {
        let sample = DemHeight_sample_vertex_mercator(position, heightLevel);
        let available = sample.status != 0u && sample.status != 3u && sample.status != 4u;
        let elevation = select(terrainConfig.elevationRange.x, sample.value.x, available);
        output.position = positionCs(position, elevation);
        output.depth = (elevation - terrainConfig.elevationRange.x) /
            max(terrainConfig.elevationRange.y - terrainConfig.elevationRange.x, 1e-6f);
        output.uv = uv;
        output.sampleStatus = f32(sample.status);
        output.resolvedHeightLevel = f32(sample.resolved_level);
    } else {
        output.position = vec4f(nan());
        output.depth = 0.0f;
        output.uv = vec2f(0.0f);
        output.sampleStatus = 0.0f;
        output.resolvedHeightLevel = f32(heightLevel);
    }
    output.level = f32(ownMatrixLevel);
    output.barycentric = barycentricForVertex(input.vertexIndex);
    output.tileColor = logicalTileColor(instance);
    return output;
}

@fragment
fn fMain(input: VertexOutput) -> @location(0) vec4f {
    return vec4f(1.0f - input.depth) * 0.5f;
}

@fragment
fn fTileWireframe(input: VertexOutput) -> @location(0) vec4f {
    let width = max(fwidth(input.barycentric), vec3f(1e-5f));
    let interior = smoothstep(vec3f(0.0f), width * 1.35f, input.barycentric);
    let coverage = 1.0f - min(min(interior.x, interior.y), interior.z);
    if (coverage <= 0.01f) {
        discard;
    }
    return vec4f(input.tileColor * coverage, coverage);
}
