struct VertexInput {
    @builtin(vertex_index) vertexIndex: u32,
    @location(0) index: u32,
};

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) @interpolate(perspective, center) texcoords: vec2f,
    @location(1) @interpolate(perspective, center) normal: vec3f,
    @location(2) @interpolate(perspective, center) fragPos: vec3f,
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
@group(2) @binding(1) var earthDayDiffuse: texture_2d<f32>;
@group(2) @binding(2) var earthNightDiffuse: texture_2d<f32>;
@group(2) @binding(3) var earthSpecular: texture_2d<f32>;
@group(2) @binding(4) var landMask: texture_2d<f32>;
@group(2) @binding(5) var earthEmssion: texture_2d<f32>;

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

    var output: VertexOutput;
    output.position = dynamicUniform.projection * dynamicUniform.view * dynamicUniform.model * vec4f(x, y, z, 1.0);
    output.texcoords = vec2f(u, v);
    output.normal = (dynamicUniform.normal * vec4f(normalX, normalY, normalZ, 1.0)).xyz;
    output.fragPos = (dynamicUniform.model * vec4f(x, y, z, 1.0)).xyz;
    return output;
}

@fragment
fn fMain(fsInput: VertexOutput) -> @location(0) vec4f {

    let offsetedUV = fsInput.texcoords + vec2f(dynamicUniform.delta, 0.0);
    let fastOffsetedUV = fsInput.texcoords + vec2f(dynamicUniform.delta * 2.0, 0.0);
    let lightDir = normalize(light.position - vec3f(0.0));
    var norm = normalize(fsInput.normal);
    let diff = max(dot(norm, lightDir), 0.0);

    let dEarthColor = textureSample(earthDayDiffuse, lsampler, offsetedUV).xyz;
    let nEarthColor = textureSample(earthNightDiffuse, lsampler, offsetedUV).xyz;
    let specularColor = textureSample(earthSpecular, lsampler, offsetedUV).xyz;
    let emissionColor = material.emissive * textureSample(earthEmssion, lsampler, offsetedUV).xyz;
    let mask = textureSample(landMask, lsampler, offsetedUV).r;

    let turnOnLight = 0.3;
    var earchColor = dEarthColor;
    if (diff <= turnOnLight) {
        earchColor = mix(nEarthColor, dEarthColor, diff / turnOnLight);
    }

    // Earth Ambient
    let eartAambient = light.color * material.ambient * earchColor;

    // Earch Diffuse
    let earthDiffuse = diff * light.color * earchColor;

    // Earth Specular
    let viewDir = normalize(light.viewPos - fsInput.fragPos);
    let reflectDir = reflect(-lightDir, norm);
    let spec = pow(max(dot(viewDir, reflectDir), 0.0), material.shininess);
    let specular = spec * light.color * specularColor;

    // Earth Emission
    var emission = vec3f(0.0);
    if (diff <= turnOnLight) {
        emission = mix(emissionColor, vec3f(0.0), diff / turnOnLight);
    }

    let ambient = eartAambient;
    let diffuse = earthDiffuse;
    let result = ambient + diffuse + specular + emission;
    if (mask < staticUniform.alphaTest) {
        discard;
    }
    
    return vec4(result, staticUniform.opacity);
}