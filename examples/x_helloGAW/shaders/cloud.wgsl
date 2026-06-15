struct VertexInput {
    @builtin(vertex_index) vertexIndex: u32,
    @location(0) index: u32,
};

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) @interpolate(perspective, center) texcoords: vec2f,
    @location(1) @interpolate(perspective, center) edgeRate: f32,
    @location(2) @interpolate(perspective, center) normal: vec3f,
    @location(3) @interpolate(perspective, center) fragPos: vec3f,
};

struct DynamicUniformBlock {
    projection: mat4x4f,
    view: mat4x4f,
    model: mat4x4f,
    normal: mat4x4f,
    delta: f32,
};

struct LightUniformBlock {
    position: vec3f,
    color: vec3f,
    intensity: f32,
    viewPos: vec3f,
}

struct MaterialUniformBlock {
    ambient: vec3f,
    diffuse: vec3f,
    specular: vec3f,
    shininess: f32,
    emissive: f32,
}

struct StaticUniformBlock {
    radius: f32,
    alphaTest: f32,
    opacity: f32,
};

// Uniform bindings
@group(0) @binding(0) var<uniform> dynamicUniform: DynamicUniformBlock;
@group(0) @binding(1) var<uniform> staticUniform: StaticUniformBlock;
@group(0) @binding(2) var<uniform> light: LightUniformBlock;
@group(0) @binding(3) var<uniform> material: MaterialUniformBlock;

// Storage bindings
@group(1) @binding(0) var<storage> vertices: array<f32>;
@group(1) @binding(1) var<storage> uvs: array<f32>;
@group(1) @binding(2) var<storage> normals: array<f32>;

// Texture bindings
@group(2) @binding(0) var lsampler: sampler;
@group(2) @binding(1) var cloudDayDiffuse: texture_2d<f32>;
@group(2) @binding(2) var cloudNightDiffuse: texture_2d<f32>;
@group(2) @binding(3) var cloudMask: texture_2d<f32>;


// const atmosphereHeight = 0.01;

@vertex
fn vMain(vsInput: VertexInput) -> VertexOutput {

    let x = vertices[vsInput.index * 3 + 0];
    let y = vertices[vsInput.index * 3 + 1];
    let z = vertices[vsInput.index * 3 + 2];
    let u = uvs[vsInput.index * 2 + 0];
    let v = uvs[vsInput.index * 2 + 1];
    let normalX = normals[vsInput.index * 3 + 0];
    let normalY = normals[vsInput.index * 3 + 1];
    let normalZ = normals[vsInput.index * 3 + 2];

    let landPos = vec3f(x, y, z);
    // let atmosPherePos = normalize(landPos) * staticUniform.radius * (1.0 + atmosphereHeight);
    let atmosPherePos = normalize(landPos) + landPos;

    var output: VertexOutput;
    output.position = dynamicUniform.projection * dynamicUniform.view * dynamicUniform.model * vec4f(atmosPherePos, 1.0);
    output.texcoords = vec2f(u, v);
    output.edgeRate = x / staticUniform.radius;
    output.normal = (dynamicUniform.normal * vec4f(normalX, normalY, normalZ, 1.0)).xyz;
    output.fragPos = (dynamicUniform.model * vec4f(atmosPherePos, 1.0)).xyz;
    return output;
}

@fragment
fn fMain(fsInput: VertexOutput) -> @location(0) vec4f {

    let fastOffsetedUV = fsInput.texcoords + vec2f(dynamicUniform.delta * 2.0, 0.0);
    let lightDir = normalize(light.position - vec3f(0.0));

    // let h = max(length(fsInput.fragPos) / (staticUniform.radius * 1.0 + atmosphereHeight) - 1.0, 0.0);
    // let scaleFactor = exp(-h / atmosphereHeight);

    var norm = normalize(fsInput.normal);
    let diff = max(dot(norm, lightDir), 0.0);

    let dCloudColor = textureSample(cloudDayDiffuse, lsampler, fastOffsetedUV).xyz;
    let nCloudColor = textureSample(cloudNightDiffuse, lsampler, fastOffsetedUV).xyz;
    let cloudMask = textureSample(cloudMask, lsampler, fastOffsetedUV).r;

    let turnOnLight = 0.3;
    var cloudColor = dCloudColor;
    if (diff <= turnOnLight) {
        cloudColor = mix(nCloudColor, dCloudColor, diff / turnOnLight);
    }

    // Cloud Ambient
    let cloudAambient = light.color * material.ambient * cloudColor;

    // Cloud Diffuse
    let cloudDiffuse = diff * light.color * cloudColor;

    let ambient = cloudAambient * cloudMask;
    let diffuse = cloudDiffuse * cloudMask;
    let result = ambient + diffuse;
    var alpha = select(0.0, 1.0, cloudMask >= staticUniform.alphaTest);

    // return vec4f(diff + 0.2, diff + 0.2, diff+0.2, 1.0);
    return vec4f(result , alpha * staticUniform.opacity);
    // return vec4f(vec3f(diff), 1.0);
}