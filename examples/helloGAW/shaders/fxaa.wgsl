struct StaticUniformBlock {
    threshold: f32,
    searchStep: i32,
}

@group(0) @binding(0) var<uniform> staticUniform: StaticUniformBlock;

@group(1) @binding(0) var srcTexture: texture_2d<f32>;
@group(1) @binding(1) var dstTexture: texture_storage_2d<rgba16float, write>;

override blockSize: u32;

fn uvCorrection(uv: vec2f, dim: vec2f) -> vec2f {
    return clamp(uv, vec2f(0.0), dim - vec2f(1.0));
}

fn linearSampling(uv: vec2f, dim: vec2f) -> vec4f {
    let tl = textureLoad(srcTexture, vec2i(uvCorrection(uv, dim).xy), 0);
    let tr = textureLoad(srcTexture, vec2i(uvCorrection(uv + vec2f(1.0, 0.0), dim).xy), 0);
    let bl = textureLoad(srcTexture, vec2i(uvCorrection(uv + vec2f(0.0, 1.0), dim).xy), 0);
    let br = textureLoad(srcTexture, vec2i(uvCorrection(uv + vec2f(1.0, 1.0), dim).xy), 0);

    let mix_x = fract(uv.x);
    let mix_y = fract(uv.y);
    let top = mix(tl, tr, mix_x);
    let bottom = mix(bl, br, mix_x);
    return mix(top, bottom, mix_y);
}

fn IDW(uv: vec2f, dim: vec2f, step: i32, p: f32) -> vec4f {
    let steps = vec2i(step, i32(ceil(f32(step) * dim.y / dim.x)));
    var weightSum = 0.0;
    var value = vec4f(0.0);
    for (var i = -steps.x; i < steps.x; i++) {
        for (var j = -steps.y; j < steps.y; j++) {
            let offset = vec2f(f32(i), f32(j));
            let distance = length(offset);
            let w = 1.0 / pow(select(distance, 1.0, distance == 0.0), p);

            let texcoords = uv + offset;
            value += linearSampling(texcoords, dim) * w;
            weightSum += w;
        }
    }

    return value / weightSum;
}

fn getColor(uv: vec2f, dim: vec2f) -> vec4f {
    return linearSampling(uv, dim);
}

fn luminance(color: vec3f) -> f32 {
    return dot(color, vec3f(0.299, 0.587, 0.114));
}

fn saturate(x: f32) -> f32 {
    return clamp(x, 0.0, 1.0);
}

fn smoothstep(edge0: f32, edge1: f32, x: f32) -> f32 {
    let t = saturate((x - edge0) / (edge1 - edge0));
    return t * t * (3.0 - 2.0 * t);
}

fn smoothEdgeBlend(distance: f32, lumaDelta: f32, lumaEdge: f32) -> f32 {
    let blendFactor = 0.2;
    return blendFactor * smoothstep(0.0, 1.0, abs(lumaDelta) / lumaEdge);
}

@compute @workgroup_size(blockSize, blockSize, 1)
fn cMain(@builtin(global_invocation_id) id: vec3<u32>) {
    let dstDim = textureDimensions(dstTexture);
    if (id.x >= dstDim.x || id.y >= dstDim.y) {
        return;
    }

    let uv = vec2f(id.xy);
    let dim = vec2f(textureDimensions(srcTexture).xy);

    let color = getColor(uv, dim);
    let colorN = getColor(uv + vec2f(0.0, -1.0), dim);
    let colorE = getColor(uv + vec2f(1.0, 0.0), dim);
    let colorS = getColor(uv + vec2f(0.0, 1.0), dim);
    let colorW = getColor(uv + vec2f(-1.0, 0.0), dim);
    let colorNW = getColor(uv + vec2f(-1.0, -1.0), dim);
    let colorNE = getColor(uv + vec2f(1.0, -1.0), dim);
    let colorSW = getColor(uv + vec2f(-1.0, 1.0), dim);
    let colorSE = getColor(uv + vec2f(1.0, 1.0), dim);

    let luma = luminance(color.rgb);
    let lumaN = luminance(colorN.rgb);
    let lumaE = luminance(colorE.rgb);
    let lumaS = luminance(colorS.rgb);
    let lumaW = luminance(colorW.rgb);
    let lumaNW = luminance(colorNW.rgb);
    let lumaNE = luminance(colorNE.rgb);
    let lumaSW = luminance(colorSW.rgb);
    let lumaSE = luminance(colorSE.rgb);

    let lumaMin = min(luma, min(min(lumaN, lumaS), min(lumaE, lumaW)));
    let lumaMax = max(luma, max(max(lumaN, lumaS), max(lumaE, lumaW)));
    let contrast = lumaMax - lumaMin;
    if (contrast < staticUniform.threshold) {
        textureStore(dstTexture, vec2i(id.xy), color);
        return;
    }

    var Filter = 2.0 * (lumaN + lumaS + lumaW + lumaE) + lumaNE + lumaNW + lumaSE + lumaSW;
    Filter /= 12.0;

    Filter = abs(Filter - luma);
    Filter = clamp(Filter / contrast, 0.0, 1.0);

    var pixelBlend = smoothstep(0.0, 1.0, Filter);
    pixelBlend *= pixelBlend;

    let horizontal = abs(1.0 * lumaNW + 1.0 * lumaNE - 2.0 * lumaN)
                    + abs(2.0 * lumaW + 2.0 * lumaE - 4.0 * luma)
                    + abs(1.0 * lumaSW + 1.0 * lumaSE - 2.0 * lumaS);
    let vertical = abs(1.0 * lumaNW + 1.0 * lumaSW - 2.0 * lumaW)
                    + abs(2.0 * lumaN + 2.0 * lumaS - 4.0 * luma)
                    + abs(1.0 * lumaNE + 1.0 * lumaSE - 2.0 * lumaE);

    let isHorizontal = vertical < horizontal;
    let positive = abs(select(lumaS, lumaE, isHorizontal) - luma);
    let negative = abs(select(lumaN, lumaW, isHorizontal) - luma);
    var offsetStep = select(vec2f(0.0, 1.0), vec2f(1.0, 0.0), isHorizontal);
    var lumaOpposite: f32;
    if (positive > negative) {
        lumaOpposite = select(lumaS, lumaE, isHorizontal);
    } else {
        offsetStep *= -1.0;
        lumaOpposite = select(lumaN, lumaW, isHorizontal);
    }

    let uvEdge = uv + offsetStep * 0.5;
    let stepLength = 10.0;
    let edgeStep = stepLength * select(vec2f(1.0, 0.0), vec2f(0.0, 1.0), isHorizontal);

    let lumaEdge = (luma + lumaOpposite) * 0.5;
    let gradientThreshold = lumaEdge * 0.25;
    var pLumaDelta: f32;
    var nLumaDelta: f32;
    var pDistance: f32;
    var nDistance: f32;
    var i: i32;

    var end = 0.0;
    var start = 0.0;
    var middle = 0.0;
    for (i = 1; i <= staticUniform.searchStep; i++) {
        pLumaDelta = luminance(getColor(uvEdge + f32(i) * edgeStep, dim).rgb) - lumaEdge;
        if (abs(pLumaDelta) > gradientThreshold) {
            break;
        }
    }
    end = f32(i) * stepLength;
    for (; i <= staticUniform.searchStep; i++) {
        middle = (start + end) * 0.5;
        pLumaDelta = luminance(getColor(uvEdge + middle * edgeStep / stepLength, dim).rgb) - lumaEdge;
        if (abs(pLumaDelta) > gradientThreshold) {
            start = middle;
        } else {
            end = middle;
        }

        if (floor(start) == floor(end)) {
            break;
        }
    }
    if (i == staticUniform.searchStep + 1) {
        pDistance = abs((start + end) * 0.5);
    } else {
        pDistance = abs(end);
    }

    end = 0.0;
    start = 0.0;
    middle = 0.0;
    for (i = 1; i <= staticUniform.searchStep; i++) {
        nLumaDelta = luminance(getColor(uvEdge - f32(i) * edgeStep, dim).rgb) - lumaEdge;
        if (abs(nLumaDelta) > gradientThreshold) {
            break;
        }
    }
    end = -f32(i) * stepLength;
    for (; i <= staticUniform.searchStep; i++) {
        middle = (start + end) * 0.5;
        nLumaDelta = luminance(getColor(uvEdge + middle * edgeStep / stepLength, dim).rgb) - lumaEdge;
        if (abs(nLumaDelta) > gradientThreshold) {
            start = middle;
        } else {
            end = middle;
        }

        if (floor(start) == floor(end)) {
            break;
        }
    }
    if (i == staticUniform.searchStep + 1) {
        nDistance = abs(middle);
    } else {
        nDistance = abs(end);
    }

    var edgeBlend: f32;
    if (pDistance < nDistance) {
        if (sign(pLumaDelta) == sign(luma - lumaEdge)) {
            edgeBlend = 0.0;
        } else {
            edgeBlend = smoothEdgeBlend(pDistance, pLumaDelta, lumaEdge);
        }
    } else {
        if (sign(nLumaDelta) == sign(luma - lumaEdge)) {
            edgeBlend = 0.0;
        } else {
            edgeBlend = smoothEdgeBlend(nDistance, nLumaDelta, lumaEdge);
        }
    }

    let finalBlend = max(pixelBlend, edgeBlend);
    let output = getColor(uv + offsetStep * finalBlend, dim);
    textureStore(dstTexture, vec2i(id.xy), output);
}
