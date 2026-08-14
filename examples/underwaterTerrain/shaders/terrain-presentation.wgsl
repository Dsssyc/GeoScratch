@fragment
fn fMain(input: WebMercatorTerrainVertexOutput) -> @location(0) vec4f {
    return vec4f(1.0f - input.normalizedElevation) * 0.5f;
}
