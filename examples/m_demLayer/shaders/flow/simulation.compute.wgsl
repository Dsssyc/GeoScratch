struct StaticUniformBlock {
    groupSize: vec2u,
    extent: vec4f,
};

struct FrameUniformBlock {
    randomSeed: f32,
    viewPort: vec2f,
    mapBounds: vec4f,
    zoomLevel: f32,
    progressRate: f32,
    maxSpeed: f32,
};

struct DynamicUniformBlock {
    far: f32,
    near: f32,
    uMatrix: mat4x4f,
    centerLow: vec3f,
    centerHigh: vec3f,
};

struct ControllerUniformBlock {
    particleNum: u32,
    dropRate: f32,
    dropRateBump: f32,
    speedFactor: f32,
}

// Uniform bindings
@group(0) @binding(0) var<uniform> controllerUniform: ControllerUniformBlock;
@group(0) @binding(1) var<uniform> frameUniform: FrameUniformBlock;
@group(0) @binding(2) var<uniform> staticUniform: StaticUniformBlock;
@group(0) @binding(3) var<uniform> dynamicUniform: DynamicUniformBlock;

// Storage bindings
@group(1) @binding(0) var<storage, read_write> particles: array<f32>;

// Texture bindings
@group(2) @binding(0) var fromTexture: texture_2d<f32>;
// @group(2) @binding(1) var toTexture: texture_2d<f32>;

// Constants
override blockSize: u32;

const FACTOR = 0.0;
const PI = 3.1415926535;
const PI2 = 1.5707963267949;
const PI4 = 0.78539816339745;
const EARTH_RADIUS = 6371000.0;

fn nan() -> f32 {

    let a = 0.0;
    let b = 0.0;
    return a / b;
}

fn uvCorrection(uv: vec2f, dim: vec2f) -> vec2f {

    return clamp(uv, vec2f(0.0), dim - vec2f(1.0));
}

fn linearSampling(texture: texture_2d<f32>, uv: vec2f, dim: vec2f) -> vec4f {

    let tl = textureLoad(texture, vec2i(uvCorrection(uv, dim).xy), 0);
    let tr = textureLoad(texture, vec2i(uvCorrection(uv + vec2f(1.0, 0.0), dim).xy), 0);
    let bl = textureLoad(texture, vec2i(uvCorrection(uv + vec2f(0.0, 1.0), dim).xy), 0);
    let br = textureLoad(texture, vec2i(uvCorrection(uv + vec2f(1.0, 1.0), dim).xy), 0);

    let mix_x = fract(uv.x);
    let mix_y = fract(uv.y);
    let top = mix(tl, tr, mix_x);
    let bottom = mix(bl, br, mix_x);
    // return mix(top, bottom, mix_y);
    return tl;
}

fn IDW(texture: texture_2d<f32>, uv: vec2f, dim: vec2f, step: i32, p: f32) -> vec4f {

    let steps = vec2i(step, i32(ceil(f32(step) * dim.y / dim.x)));
    var weightSum = 0.0;
    var value = vec4f(0.0);
    for (var i = -steps.x; i < steps.x; i++ ) {
        for (var j = -steps.y; j < steps.y; j++) {

            let offset = vec2f(f32(i), f32(j));
            let distance = length(offset);
            let w = 1.0 / pow(select(distance, 1.0, distance == 0.0), p);

            let texcoords = uv + offset;
            value += linearSampling(texture, texcoords, dim) * w;
            weightSum += w;
        }
    }

    return value / weightSum;
}

// pseudo-random generator
fn rand(co: vec2f) -> f32 {

    let rand_constants = vec3f(12.9898, 78.233, 4375.85453);
    let t = dot(rand_constants.xy, co);

    return abs(fract(sin(t) * (rand_constants.z + t)));
}

fn drop(velocity: vec2f, seed: vec2f) -> f32 {
    
    let speedRate = length(velocity) / frameUniform.maxSpeed;
    let drop_rate = controllerUniform.dropRate + speedRate * controllerUniform.dropRateBump;

    return step(1.0 - drop_rate, rand(seed));
}

fn calcWebMercatorCoord(coord: vec2f) -> vec2f {

    let lon = (180.0 + coord.x) / 360.0;
    let lat = (180.0 - (180.0 / PI * log(tan(PI / 4.0 + coord.y * PI / 360.0)))) / 360.0;

    return vec2f(lon, lat);
}

fn translateRelativeToEye(high: vec3f, low: vec3f) -> vec3f {

    let highDiff = high - dynamicUniform.centerHigh;
    let lowDiff = low - dynamicUniform.centerLow;

    return highDiff + lowDiff;
}

fn currentExtent() -> vec4f {

    let lonMin = max(staticUniform.extent.x, frameUniform.mapBounds.x);
    let latMin = max(staticUniform.extent.y, frameUniform.mapBounds.y);
    let lonMax = min(staticUniform.extent.z, frameUniform.mapBounds.z);
    let latMax = min(staticUniform.extent.w, frameUniform.mapBounds.w);
    
    return vec4f(lonMin, latMin, lonMax, latMax);
}

fn calculateDisplacedLonLat(lon: f32, lat: f32, offsetX: f32, offsetY: f32) -> vec2f {

    let latRad = radians(lat);
    let lonRad = radians(lon);

    let newLatRad = latRad + (offsetY / EARTH_RADIUS);
    let newLat = degrees(newLatRad);

    let radiusAtLat = EARTH_RADIUS * cos(latRad);
    let newLonRad = lonRad + (offsetX / radiusAtLat);
    let newLon = degrees(newLonRad);

    return vec2f(newLon, newLat);
}

fn getVelocity(texture: texture_2d<f32>, uv: vec2f) -> vec2f {

    let dim = vec2f(textureDimensions(texture, 0).xy);
    return linearSampling(texture, uv * dim, dim).rg;
}

@compute @workgroup_size(blockSize, blockSize, 1)
fn cMain(@builtin(global_invocation_id) id: vec3<u32>) {

    let cExtent = currentExtent();
    let index = id.y * staticUniform.groupSize.x * blockSize + id.x;
    if (cExtent.z <= cExtent.x || cExtent.w <= cExtent.y || index >= controllerUniform.particleNum) {
        return;
    }

    var lastPos = vec2f(
        particles[index * 6 + 0],
        particles[index * 6 + 1],
    );
    let vPast = vec2f(
        particles[index * 6 + 4],
        particles[index * 6 + 5],
    );
    // let x = mix(cExtent.x, cExtent.z, lastPos.x);
    // let y = mix(cExtent.y, cExtent.w, lastPos.y);
    // let mercatorPos = calcWebMercatorCoord(vec2f(x, y));
    let mercatorPos = calcWebMercatorCoord(lastPos);

    let position_CS = dynamicUniform.uMatrix * vec4f(translateRelativeToEye(vec3f(mercatorPos, 0.0), vec3f(0.0, 0.0, 0.0)), 1.0);
    let position_SS = position_CS.xy / position_CS.w;
    var uv = (position_SS + 1.0) / 2.0;
    uv = vec2f(uv.x, 1.0 - uv.y);

    // let vLast = getVelocity(fromTexture, uv);
    // let vNext = getVelocity(toTexture, uv);
    // let vCurrent = mix(vLast, vNext, frameUniform.progressRate);
    let vCurrent = getVelocity(fromTexture, uv);
    var velocity = mix(vCurrent, vPast, FACTOR);
    let offset = velocity * 50.0 * controllerUniform.speedFactor;
    // let nextCoords = clamp(calculateDisplacedLonLat(x, y, offset.x, offset.y), cExtent.xy, cExtent.zw);
    let nextCoords = clamp(calculateDisplacedLonLat(lastPos.x, lastPos.y, offset.x, offset.y), cExtent.xy, cExtent.zw);

    // let nextPos = vec2f(
    //     (nextCoords.x - cExtent.x) / (cExtent.z - cExtent.x),
    //     (nextCoords.y - cExtent.y) / (cExtent.w - cExtent.y),
    // );
    let nextPos = nextCoords;

    let seed = frameUniform.randomSeed * (nextPos - uv + vec2f(f32(id.x), f32(id.y)));
    if (drop(velocity, seed) == 1.0 || all(velocity == vec2f(0.0)) || uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) {
    // if (drop(velocity, seed) == 1.0 || all(velocity == vec2f(0.0)) || lastPos.x * lastPos.y * uv.x * uv.y * nextPos.x * nextPos.y == 0.0 || any(nextPos <= vec2f(0.0)) || any(nextPos >= vec2f(1.0))) {

        let rebirth_x = mix(cExtent.x, cExtent.z, rand(seed + f32(id.x)));
        let rebirth_y = mix(cExtent.y, cExtent.w, rand(seed + f32(id.y)));
        // let rebirth_x = rand(seed + f32(id.x));
        // let rebirth_y = rand(seed + f32(id.y));

        particles[index * 6 + 0] = rebirth_x;
        particles[index * 6 + 1] = rebirth_y;
        particles[index * 6 + 2] = rebirth_x;
        particles[index * 6 + 3] = rebirth_y;
        particles[index * 6 + 4] = 0.0;
        particles[index * 6 + 5] = 0.0;

    } else {

        particles[index * 6 + 0] = nextPos.x;
        particles[index * 6 + 1] = nextPos.y;
        particles[index * 6 + 2] = lastPos.x;
        particles[index * 6 + 3] = lastPos.y;
        particles[index * 6 + 4] = velocity.x;
        particles[index * 6 + 5] = velocity.y;
    }
}
