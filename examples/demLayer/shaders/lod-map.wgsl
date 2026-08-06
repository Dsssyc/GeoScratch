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
    @location(0) @interpolate(flat) encodedMatrixLevel: f32,
};

@group(0) @binding(0) var<uniform> mapMeta: GpuTileFrontierMapMeta;
@group(0) @binding(1) var<uniform> terrainConfig: DemTerrainConfig;

@group(1) @binding(0) var<storage, read> visibleInstances:
    array<GpuTileFrontierVisibleInstance>;

fn normalizedTileBounds(instance: GpuTileFrontierVisibleInstance) -> vec4f {
    let inverseMatrixWidth = exp2(-f32(instance.matrixLevel));
    return vec4f(
        f32(instance.tileCol) * inverseMatrixWidth,
        f32(instance.tileRow) * inverseMatrixWidth,
        f32(instance.tileCol + 1u) * inverseMatrixWidth,
        f32(instance.tileRow + 1u) * inverseMatrixWidth,
    );
}

fn sourceUv(position: vec2f) -> vec2f {
    let extent = terrainConfig.sourceMercatorBox.zw -
        terrainConfig.sourceMercatorBox.xy;
    return (position - terrainConfig.sourceMercatorBox.xy) / extent;
}

@vertex
fn vMain(input: VertexInput) -> VertexOutput {
    let instance = visibleInstances[input.instanceIndex];
    let bounds = normalizedTileBounds(instance);
    let corners = array<vec2f, 4>(
        bounds.xy,
        vec2f(bounds.z, bounds.y),
        vec2f(bounds.x, bounds.w),
        bounds.zw,
    );
    let uv = sourceUv(corners[input.vertexIndex]);

    var output: VertexOutput;
    output.position = vec4f(uv.x * 2.0f - 1.0f, 1.0f - uv.y * 2.0f, 0.0f, 1.0f);
    output.encodedMatrixLevel = f32(instance.matrixLevel) / 255.0f;
    return output;
}

@fragment
fn fMain(input: VertexOutput) -> @location(0) vec4f {
    return vec4f(input.encodedMatrixLevel, 0.0f, 0.0f, 1.0f);
}
