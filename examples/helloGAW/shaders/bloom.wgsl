struct StaticUniformBlock {
    threshold: f32,
};

@group(0) @binding(0) var<uniform> staticUniform: StaticUniformBlock;
@group(1) @binding(0) var inTexture: texture_2d<f32>;
@group(1) @binding(1) var outTexture: texture_storage_2d<rgba16float, write>;

override blockSize: u32;

fn luminance(color: vec3f) -> f32 {
    return dot(color, vec3f(0.2126, 0.7152, 0.0722));
}

@compute @workgroup_size(blockSize, blockSize, 1)
fn cMain(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(outTexture);
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }

    let color = textureLoad(inTexture, vec2i(id.xy), 0);
    let highlight = select(vec4f(0.0, 0.0, 0.0, 1.0), color, luminance(color.rgb) > staticUniform.threshold);
    textureStore(outTexture, vec2i(id.xy), highlight);
}
