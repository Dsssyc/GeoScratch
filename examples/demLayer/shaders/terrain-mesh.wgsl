struct VertexInput {
    @builtin(vertex_index) vertexIndex: u32,
    @builtin(instance_index) instanceIndex: u32,
};

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) depth: f32,
    @location(1) level: f32,
    @location(2) uv: vec2f,
    @location(3) sampleStatus: f32,
    @location(4) resolvedHeightLevel: f32,
};

struct DynamicUniformBlock {
    far: f32,
    near: f32,
    cameraLatitude: f32,
    reserved: f32,
    uMatrix: mat4x4f,
    centerLow: vec3f,
    centerHigh: vec3f,
};

struct TileUniformBlock {
    tileBox: vec4f,
    levelRange: vec2f,
    sectorRange: vec2f,
    sectorSize: f32,
    exaggeration: f32,
};

struct CanonicalNode {
    minimum: DemAddressFixedPosition,
    maximum: DemAddressFixedPosition,
};

@group(0) @binding(0) var<uniform> tileUniform: TileUniformBlock;
@group(0) @binding(1) var<uniform> dynamicUniform: DynamicUniformBlock;

@group(1) @binding(0) var<storage, read> indices: array<u32>;
@group(1) @binding(1) var<storage, read> gridPositions: array<u32>;
@group(1) @binding(2) var<storage, read> geometryLevels: array<u32>;
@group(1) @binding(3) var<storage, read> geographicBoxes: array<f32>;
@group(1) @binding(4) var<storage, read> canonicalNodes: array<CanonicalNode>;
@group(1) @binding(5) var<storage, read> cameraCoordinate: array<DemAddressFixedPosition>;

@group(2) @binding(2) var lodMap: texture_2d<f32>;

const PI = 3.141592653;
const TERRAIN_SECTOR_SIZE = 64u;
const FINEST_HEIGHT_GEOMETRY_LEVEL = 12u;
const MAX_HEIGHT_LEVEL = 3u;
const EARTH_CIRCUMFERENCE = 40030228.88407185;

fn nan() -> f32 {

    let zero = 0.0;
    return zero / zero;
}

fn gridPosition(index: u32) -> vec2u {

    return vec2u(gridPositions[index * 2u], gridPositions[index * 2u + 1u]);
}

fn triangleCentroid(triangleID: u32) -> vec2f {

    let first = vec2f(gridPosition(indices[triangleID * 3u])) / f32(TERRAIN_SECTOR_SIZE);
    let second = vec2f(gridPosition(indices[triangleID * 3u + 1u])) / f32(TERRAIN_SECTOR_SIZE);
    let third = vec2f(gridPosition(indices[triangleID * 3u + 2u])) / f32(TERRAIN_SECTOR_SIZE);
    return (first + second + third) / 3.0;
}

fn geometryHeightLevel(geometryLevel: u32) -> u32 {

    if (geometryLevel >= FINEST_HEIGHT_GEOMETRY_LEVEL) { return 0u; }
    return min(MAX_HEIGHT_LEVEL, FINEST_HEIGHT_GEOMETRY_LEVEL - geometryLevel);
}

fn canonicalCoordinate(node: CanonicalNode, grid: vec2u) -> DemAddressFixedPosition {

    return DemCanonical_interpolate(node.minimum, node.maximum, grid);
}

fn stableAtanh(value: f32) -> f32 {

    let squared = value * value;
    return value * (1.0 + squared / 3.0 + squared * squared / 5.0 +
        squared * squared * squared / 7.0);
}

fn mercatorLatitudeDifference(cameraLatitude: f32, latitudeDifference: f32) -> f32 {

    let cameraRadians = cameraLatitude * PI / 180.0;
    let differenceRadians = latitudeDifference * PI / 180.0;
    let targetRadians = cameraRadians + differenceRadians;
    let numerator = 2.0 * cos(cameraRadians + differenceRadians * 0.5) *
        sin(differenceRadians * 0.5);
    let denominator = 1.0 - sin(targetRadians) * sin(cameraRadians);
    return -stableAtanh(numerator / denominator) / (2.0 * PI);
}

fn altitudeToMercator(latitude: f32, altitude: f32) -> f32 {

    return altitude / EARTH_CIRCUMFERENCE * cos(latitude * PI / 180.0);
}

fn positionCS(coordinate: DemAddressFixedPosition, elevation: f32) -> vec4f {

    let geographicDifference = DemCanonical_difference_degrees(coordinate, cameraCoordinate[0]);
    let relativeX = geographicDifference[0] / 360.0;
    let relativeY = mercatorLatitudeDifference(
        dynamicUniform.cameraLatitude,
        geographicDifference[1],
    );
    var height = tileUniform.exaggeration * altitudeToMercator(
        dynamicUniform.cameraLatitude + geographicDifference[1],
        elevation,
    );
    height = select(height, 0.0, height >= 0.0);
    let relativeZ = height - dynamicUniform.centerHigh.z - dynamicUniform.centerLow.z;
    return dynamicUniform.uMatrix * vec4f(relativeX, relativeY, relativeZ, 1.0);
}

@vertex
fn vMain(input: VertexInput) -> VertexOutput {

    let triangleID = input.vertexIndex / 3u;
    let index = indices[input.vertexIndex];
    var grid = gridPosition(index);
    let center = triangleCentroid(triangleID);
    let boxOffset = input.instanceIndex * 4u;
    let nodeBox = vec4f(
        geographicBoxes[boxOffset],
        geographicBoxes[boxOffset + 1u],
        geographicBoxes[boxOffset + 2u],
        geographicBoxes[boxOffset + 3u],
    );
    let centroidCoordinate = vec2f(
        mix(nodeBox.x, nodeBox.z, center.x),
        mix(nodeBox.y, nodeBox.w, center.y),
    );
    let lodDimensions = vec2f(textureDimensions(lodMap, 0)) - vec2f(1.0);
    let lodCoordinate = vec2f(
        floor((centroidCoordinate.x - tileUniform.tileBox.x) / tileUniform.sectorRange.x),
        255.0 - floor((centroidCoordinate.y - tileUniform.tileBox.y) /
            tileUniform.sectorRange.y),
    );
    let middleLod = clamp(lodCoordinate, vec2f(0.0), lodDimensions);
    let leftLod = clamp(lodCoordinate + vec2f(-1.0, 0.0), vec2f(0.0), lodDimensions);
    let rightLod = clamp(lodCoordinate + vec2f(1.0, 0.0), vec2f(0.0), lodDimensions);
    let topLod = clamp(lodCoordinate + vec2f(0.0, -1.0), vec2f(0.0), lodDimensions);
    let bottomLod = clamp(lodCoordinate + vec2f(0.0, 1.0), vec2f(0.0), lodDimensions);
    let ownLevel = geometryLevels[input.instanceIndex];
    let middleLevel = u32(round(textureLoad(lodMap, vec2i(middleLod), 0).r * 255.0));
    let leftLevel = u32(round(textureLoad(lodMap, vec2i(leftLod), 0).r * 255.0));
    let rightLevel = u32(round(textureLoad(lodMap, vec2i(rightLod), 0).r * 255.0));
    let topLevel = u32(round(textureLoad(lodMap, vec2i(topLod), 0).r * 255.0));
    let bottomLevel = u32(round(textureLoad(lodMap, vec2i(bottomLod), 0).r * 255.0));
    var heightLevel = geometryHeightLevel(ownLevel);

    if (grid.x == 0u) {
        heightLevel = max(heightLevel, geometryHeightLevel(leftLevel));
        if (leftLevel < middleLevel && grid.y % 2u == 1u) { grid.y += 1u; }
    }
    if (grid.x == TERRAIN_SECTOR_SIZE) {
        heightLevel = max(heightLevel, geometryHeightLevel(rightLevel));
        if (rightLevel < middleLevel && grid.y % 2u == 1u) { grid.y += 1u; }
    }
    if (grid.y == 0u) {
        heightLevel = max(heightLevel, geometryHeightLevel(bottomLevel));
        if (bottomLevel < middleLevel && grid.x % 2u == 1u) { grid.x += 1u; }
    }
    if (grid.y == TERRAIN_SECTOR_SIZE) {
        heightLevel = max(heightLevel, geometryHeightLevel(topLevel));
        if (topLevel < middleLevel && grid.x % 2u == 1u) { grid.x += 1u; }
    }

    let coordinate = canonicalCoordinate(canonicalNodes[input.instanceIndex], grid);
    let uv = DemCanonical_uv(coordinate);
    let inside = DemCanonical_inside(coordinate);
    var output: VertexOutput;
    if (inside) {
        let sample = DemHeight_sample_vertex(coordinate, heightLevel);
        let available = sample.status != 0u && sample.status != 3u;
        let elevation = select(DemElevationRange.x, sample.value.x, available);
        output.position = positionCS(coordinate, elevation);
        output.depth = (elevation - DemElevationRange.x) /
            (DemElevationRange.y - DemElevationRange.x);
        output.uv = uv;
        output.sampleStatus = f32(sample.status);
        output.resolvedHeightLevel = f32(sample.resolved_level);
    } else {
        output.position = vec4f(nan());
        output.depth = 0.0;
        output.uv = vec2f(0.0);
        output.sampleStatus = 0.0;
        output.resolvedHeightLevel = f32(heightLevel);
    }
    output.level = f32(ownLevel);
    return output;
}

@fragment
fn fMain(input: VertexOutput) -> @location(0) vec4f {

    return vec4f(1.0 - input.depth) * 0.5;
}
