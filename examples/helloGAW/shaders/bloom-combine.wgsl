struct StaticUniformBlock {
    strength: f32,
};

@group(0) @binding(0) var<uniform> staticUniform: StaticUniformBlock;
@group(1) @binding(0) var sceneTexture: texture_2d<f32>;
@group(1) @binding(1) var blurTexture: texture_2d<f32>;
@group(1) @binding(2) var dstTexture: texture_storage_2d<rgba16float, write>;

override blockSize: u32;

@compute @workgroup_size(blockSize, blockSize, 1)
fn cMain(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(dstTexture);
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }

    let coords = vec2i(id.xy);
    let scene = textureLoad(sceneTexture, coords, 0);
    let blur = textureLoad(blurTexture, coords, 0);
    textureStore(dstTexture, coords, scene + blur * staticUniform.strength);
}
