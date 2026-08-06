struct DemTerrainConfig {
    sourceMercatorBox: vec4f,
    elevationRange: vec2f,
    lodMapDimensions: vec2f,
    sectorSize: u32,
    coordinateBits: u32,
    exaggeration: f32,
    reserved: f32,
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
};

@group(0) @binding(0) var<uniform> mapMeta: GpuTileFrontierMapMeta;
@group(0) @binding(1) var<uniform> terrainConfig: DemTerrainConfig;

@group(1) @binding(0) var<storage, read> indices: array<u32>;
@group(1) @binding(1) var<storage, read> gridPositions: array<u32>;
@group(1) @binding(2) var<storage, read> visibleInstances:
    array<GpuTileFrontierVisibleInstance>;

@group(2) @binding(2) var lodMap: texture_2d<f32>;

const TERRAIN_SECTOR_SIZE: u32 = 64u;
const WEB_MERCATOR_WORLD_WIDTH_METERS: f32 = 40075016.0f;

fn nan() -> f32 {
    let zero = 0.0f;
    return zero / zero;
}

fn gridPosition(index: u32) -> vec2u {
    return vec2u(gridPositions[index * 2u], gridPositions[index * 2u + 1u]);
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
    instance: GpuTileFrontierVisibleInstance,
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

fn lodMapUv(
    instance: GpuTileFrontierVisibleInstance,
    local: vec2f,
) -> vec2f {
    let inverseMatrixWidth = exp2(-f32(instance.matrixLevel));
    let normalized = vec2f(
        f32(instance.tileCol) + local.x,
        f32(instance.tileRow) + 1.0f - local.y,
    ) * inverseMatrixWidth;
    let extent = terrainConfig.sourceMercatorBox.zw -
        terrainConfig.sourceMercatorBox.xy;
    return (normalized - terrainConfig.sourceMercatorBox.xy) / extent;
}

fn lodMapTexel(uv: vec2f) -> vec2i {
    let dimensions = max(vec2i(terrainConfig.lodMapDimensions), vec2i(1));
    let bounded = clamp(uv, vec2f(0.0f), vec2f(0.99999994f));
    return clamp(
        vec2i(floor(bounded * vec2f(dimensions))),
        vec2i(0),
        dimensions - vec2i(1),
    );
}

fn lodMapTexelSize() -> vec2f {
    return 1.0f / max(terrainConfig.lodMapDimensions, vec2f(1.0f));
}

fn matrixLevelAt(coordinate: vec2i) -> u32 {
    let dimensions = max(vec2i(terrainConfig.lodMapDimensions), vec2i(1));
    let bounded = clamp(coordinate, vec2i(0), dimensions - vec2i(1));
    return u32(round(textureLoad(lodMap, bounded, 0).r * 255.0f));
}

fn coarserSamplingLevel(ownMatrixLevel: u32, neighborMatrixLevel: u32, own: u32) -> u32 {
    let levelDelta = ownMatrixLevel - min(ownMatrixLevel, neighborMatrixLevel);
    return min(own + levelDelta, DemHeight_level_count - 1u);
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
    let center = triangleCentroid(triangleId);
    let middleTexel = lodMapTexel(lodMapUv(instance, center));
    let texelSize = lodMapTexelSize();
    let middleLevel = matrixLevelAt(middleTexel);
    let leftLevel = matrixLevelAt(lodMapTexel(
        lodMapUv(instance, vec2f(0.0f, center.y)) - vec2f(texelSize.x, 0.0f),
    ));
    let rightLevel = matrixLevelAt(lodMapTexel(
        lodMapUv(instance, vec2f(1.0f, center.y)) + vec2f(texelSize.x, 0.0f),
    ));
    let topLevel = matrixLevelAt(lodMapTexel(
        lodMapUv(instance, vec2f(center.x, 1.0f)) - vec2f(0.0f, texelSize.y),
    ));
    let bottomLevel = matrixLevelAt(lodMapTexel(
        lodMapUv(instance, vec2f(center.x, 0.0f)) + vec2f(0.0f, texelSize.y),
    ));
    let ownMatrixLevel = instance.matrixLevel;
    var heightLevel = min(instance.samplingLevel, DemHeight_level_count - 1u);

    if (grid.x == 0u) {
        heightLevel = max(
            heightLevel,
            coarserSamplingLevel(ownMatrixLevel, leftLevel, instance.samplingLevel),
        );
        if (leftLevel < middleLevel && grid.y % 2u == 1u) {
            grid.y += 1u;
        }
    }
    if (grid.x == TERRAIN_SECTOR_SIZE) {
        heightLevel = max(
            heightLevel,
            coarserSamplingLevel(ownMatrixLevel, rightLevel, instance.samplingLevel),
        );
        if (rightLevel < middleLevel && grid.y % 2u == 1u) {
            grid.y += 1u;
        }
    }
    if (grid.y == 0u) {
        heightLevel = max(
            heightLevel,
            coarserSamplingLevel(ownMatrixLevel, bottomLevel, instance.samplingLevel),
        );
        if (bottomLevel < middleLevel && grid.x % 2u == 1u) {
            grid.x += 1u;
        }
    }
    if (grid.y == TERRAIN_SECTOR_SIZE) {
        heightLevel = max(
            heightLevel,
            coarserSamplingLevel(ownMatrixLevel, topLevel, instance.samplingLevel),
        );
        if (topLevel < middleLevel && grid.x % 2u == 1u) {
            grid.x += 1u;
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
    return output;
}

@fragment
fn fMain(input: VertexOutput) -> @location(0) vec4f {
    return vec4f(1.0f - input.depth) * 0.5f;
}
