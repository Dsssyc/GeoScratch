@group(0) @binding(0) var srcTexture: texture_2d<f32>;
@group(0) @binding(1) var dstTexture: texture_storage_2d<rgba16float, write>;

override blockSize: u32;

fn corrected(coords: vec2f, size: vec2f) -> vec2f {
    return clamp(coords, vec2f(0.0), size - vec2f(1.0));
}

fn linearLoad(coords: vec2f, size: vec2f) -> vec4f {
    let base = floor(coords);
    let mixAmount = fract(coords);
    let topLeft = textureLoad(srcTexture, vec2i(corrected(base, size)), 0);
    let topRight = textureLoad(srcTexture, vec2i(corrected(base + vec2f(1.0, 0.0), size)), 0);
    let bottomLeft = textureLoad(srcTexture, vec2i(corrected(base + vec2f(0.0, 1.0), size)), 0);
    let bottomRight = textureLoad(srcTexture, vec2i(corrected(base + vec2f(1.0, 1.0), size)), 0);
    return mix(mix(topLeft, topRight, mixAmount.x), mix(bottomLeft, bottomRight, mixAmount.x), mixAmount.y);
}

@compute @workgroup_size(blockSize, blockSize, 1)
fn cMain(@builtin(global_invocation_id) id: vec3u) {
    let dstSizeU = textureDimensions(dstTexture);
    if (id.x >= dstSizeU.x || id.y >= dstSizeU.y) {
        return;
    }

    let srcSize = vec2f(textureDimensions(srcTexture));
    let dstSize = vec2f(dstSizeU);
    let srcCoords = ((vec2f(id.xy) + 0.5) / dstSize) * srcSize - 0.5;
    textureStore(dstTexture, vec2i(id.xy), linearLoad(srcCoords, srcSize));
}
