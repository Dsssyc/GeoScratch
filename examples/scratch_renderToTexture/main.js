import {
    ScratchRuntime,
} from 'geoscratch'

const canvas = document.getElementById('GPUFrame')
const offscreenSize = { width: 512, height: 512 }
const offscreenFormat = 'rgba8unorm'

const offscreenWgsl = `
struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
};

@vertex
fn vsMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    var positions = array<vec2f, 6>(
        vec2f(-0.72, -0.72),
        vec2f( 0.72, -0.72),
        vec2f(-0.72,  0.72),
        vec2f(-0.72,  0.72),
        vec2f( 0.72, -0.72),
        vec2f( 0.72,  0.72)
    );
    var uvs = array<vec2f, 6>(
        vec2f(0.0, 1.0),
        vec2f(1.0, 1.0),
        vec2f(0.0, 0.0),
        vec2f(0.0, 0.0),
        vec2f(1.0, 1.0),
        vec2f(1.0, 0.0)
    );

    var output: VertexOutput;
    output.position = vec4f(positions[vertexIndex], 0.0, 1.0);
    output.uv = uvs[vertexIndex];
    return output;
}

@fragment
fn fsMain(input: VertexOutput) -> @location(0) vec4f {
    let stripe = select(0.25, 1.0, fract((input.uv.x + input.uv.y) * 7.0) > 0.5);
    let color = vec3f(
        0.12 + input.uv.x * 0.78,
        0.22 + (1.0 - input.uv.y) * 0.62,
        0.45 + stripe * 0.35
    );

    return vec4f(color, 1.0);
}
`

const sampleWgsl = `
@group(0) @binding(0)
var renderTexture: texture_2d<f32>;

@group(0) @binding(1)
var renderSampler: sampler;

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
};

@vertex
fn vsMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    var positions = array<vec2f, 6>(
        vec2f(-0.86, -0.86),
        vec2f( 0.86, -0.86),
        vec2f(-0.86,  0.86),
        vec2f(-0.86,  0.86),
        vec2f( 0.86, -0.86),
        vec2f( 0.86,  0.86)
    );
    var uvs = array<vec2f, 6>(
        vec2f(0.0, 1.0),
        vec2f(1.0, 1.0),
        vec2f(0.0, 0.0),
        vec2f(0.0, 0.0),
        vec2f(1.0, 1.0),
        vec2f(1.0, 0.0)
    );

    var output: VertexOutput;
    output.position = vec4f(positions[vertexIndex], 0.0, 1.0);
    output.uv = uvs[vertexIndex];
    return output;
}

@fragment
fn fsMain(input: VertexOutput) -> @location(0) vec4f {
    return textureSample(renderTexture, renderSampler, input.uv);
}
`

void main().catch((error) => {
    console.error(error)
})

async function main() {

    const runtime = await ScratchRuntime.create({
        label: 'render to texture runtime',
    })
    const surface = runtime.createSurface(canvas, {
        label: 'render to texture surface',
        format: 'preferred',
        alphaMode: 'opaque',
    })
    const offscreenTexture = await runtime.createTexture({
        label: 'render to texture offscreen color',
        size: offscreenSize,
        format: offscreenFormat,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    })
    const sampler = runtime.createSampler({
        label: 'render to texture sampler',
        magFilter: 'linear',
        minFilter: 'linear',
    })
    const sampleBindLayout = runtime.createBindLayout({
        label: 'render to texture sample layout',
        group: 0,
        entries: [
            {
                binding: 0,
                name: 'renderTexture',
                type: 'texture',
                sampleType: 'float',
                viewDimension: '2d',
                visibility: [ 'fragment' ],
            },
            {
                binding: 1,
                name: 'renderSampler',
                type: 'sampler',
                samplerType: 'filtering',
                visibility: [ 'fragment' ],
            },
        ],
    })
    const sampleBindSet = runtime.createBindSet(sampleBindLayout, {
        renderTexture: offscreenTexture,
        renderSampler: sampler,
    }, {
        label: 'render to texture sample set',
    })
    const offscreenProgram = runtime.createProgram({
        label: 'render to texture offscreen program',
        modules: [ offscreenWgsl ],
        entryPoints: {
            vertex: 'vsMain',
            fragment: 'fsMain',
        },
    })
    const sampleProgram = runtime.createProgram({
        label: 'render to texture sample program',
        modules: [ sampleWgsl ],
        entryPoints: {
            vertex: 'vsMain',
            fragment: 'fsMain',
        },
    })
    const offscreenPipeline = runtime.createRenderPipeline({
        label: 'render to texture offscreen pipeline',
        program: offscreenProgram,
        targets: [ { format: offscreenTexture.format } ],
    })
    const samplePipeline = runtime.createRenderPipeline({
        label: 'render to texture sample pipeline',
        program: sampleProgram,
        bindLayouts: [ sampleBindLayout ],
        targets: [ { format: surface.format } ],
    })
    const offscreenPass = runtime.createRenderPass({
        label: 'render to texture offscreen pass',
        color: [
            {
                target: offscreenTexture,
                load: 'clear',
                store: 'store',
                clear: [ 0.02, 0.04, 0.08, 1 ],
            },
        ],
    })
    const surfacePass = runtime.createRenderPass({
        label: 'render to texture surface pass',
        color: [
            {
                target: surface,
                load: 'clear',
                store: 'store',
                clear: [ 0.03, 0.05, 0.08, 1 ],
            },
        ],
    })
    const offscreenDraw = runtime.createDrawCommand({
        label: 'draw render to texture offscreen quad',
        pipeline: offscreenPipeline,
        count: { vertexCount: 6 },
        resources: {
            read: [],
            write: [],
        },
        whenMissing: 'throw',
    })
    let firstFrameSettled = false
    canvas.dataset.status = 'loading'

    function render() {

        resizeSurface(surface, canvas)

        const sampleDraw = runtime.createDrawCommand({
            label: 'draw render to texture sampled quad',
            pipeline: samplePipeline,
            bindSets: [ sampleBindSet ],
            count: { vertexCount: 6 },
            resources: {
                read: [
                    { resource: offscreenTexture, contentEpoch: offscreenTexture.contentEpoch + 1 },
                ],
                write: [],
            },
            whenMissing: 'throw',
        })

        const submitted = runtime.createSubmission({ validation: 'throw' })
            .render(offscreenPass, [ offscreenDraw ])
            .render(surfacePass, [ sampleDraw ])
            .submit()
        if (!firstFrameSettled) {
            firstFrameSettled = true
            void submitted.done.then(() => {
                canvas.dataset.status = 'ready'
            }).catch((error) => {
                canvas.dataset.status = 'error'
                console.error(error)
            })
        }

        requestAnimationFrame(render)
    }

    render()
}

function resizeSurface(surface, canvas) {

    const devicePixelRatio = window.devicePixelRatio || 1
    const width = Math.max(1, Math.floor(canvas.clientWidth * devicePixelRatio))
    const height = Math.max(1, Math.floor(canvas.clientHeight * devicePixelRatio))

    if (surface.size.width !== width || surface.size.height !== height) {
        surface.resize({ width, height })
    }
}
