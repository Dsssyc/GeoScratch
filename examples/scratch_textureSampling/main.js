import {
    ScratchRuntime,
} from 'geoscratch'

const canvas = document.getElementById('GPUFrame')

const textureSamplingWgsl = `
@group(0) @binding(0)
var colorTexture: texture_2d<f32>;

@group(0) @binding(1)
var colorSampler: sampler;

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
    return textureSample(colorTexture, colorSampler, input.uv);
}
`

const checkerboard = new Uint8Array([
    237, 74, 54, 255,
    32, 177, 113, 255,
    52, 109, 229, 255,
    244, 204, 74, 255,
])

void main().catch((error) => {
    console.error(error)
})

async function main() {

    const runtime = await ScratchRuntime.create({
        label: 'texture sampling runtime',
    })
    const surface = runtime.createSurface(canvas, {
        label: 'texture sampling surface',
        format: 'preferred',
        alphaMode: 'opaque',
    })
    const texture = await runtime.createTexture({
        label: 'texture sampling checkerboard',
        size: { width: 2, height: 2 },
        format: 'rgba8unorm',
        usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
    })
    const sampler = runtime.createSampler({
        label: 'texture sampling nearest sampler',
        magFilter: 'nearest',
        minFilter: 'nearest',
    })
    const bindLayout = runtime.createBindLayout({
        label: 'texture sampling bind layout',
        group: 0,
        entries: [
            {
                binding: 0,
                name: 'colorTexture',
                type: 'texture',
                sampleType: 'float',
                viewDimension: '2d',
                visibility: [ 'fragment' ],
            },
            {
                binding: 1,
                name: 'colorSampler',
                type: 'sampler',
                samplerType: 'filtering',
                visibility: [ 'fragment' ],
            },
        ],
    })
    const bindSet = runtime.createBindSet(bindLayout, {
        colorTexture: texture,
        colorSampler: sampler,
    }, {
        label: 'texture sampling bind set',
    })
    const program = runtime.createProgram({
        label: 'texture sampling program',
        modules: [ textureSamplingWgsl ],
        entryPoints: {
            vertex: 'vsMain',
            fragment: 'fsMain',
        },
    })
    const pipeline = await runtime.createRenderPipeline({
        label: 'texture sampling pipeline',
        program,
        bindLayouts: [ bindLayout ],
        targets: [ { format: surface.format } ],
    })
    const pass = runtime.createRenderPass({
        label: 'texture sampling pass',
        color: [
            {
                target: surface,
                load: 'clear',
                store: 'store',
                clear: [ 0.03, 0.05, 0.08, 1 ],
            },
        ],
    })
    const upload = runtime.createTextureUploadCommand({
        label: 'upload texture sampling checkerboard',
        target: texture,
        data: checkerboard,
        layout: {
            bytesPerRow: 8,
            rowsPerImage: 2,
        },
        size: { width: 2, height: 2 },
    })
    const draw = runtime.createDrawCommand({
        label: 'draw texture sampling quad',
        pipeline,
        bindSets: [ bindSet ],
        count: { vertexCount: 6 },
        resources: {
            read: [
                { resource: texture, contentEpoch: 1 },
            ],
            write: [],
        },
        whenMissing: 'throw',
    })

    let needsUpload = true
    let firstFrameSettled = false
    canvas.dataset.status = 'loading'

    function render() {

        resizeSurface(surface, canvas)

        const submission = runtime.createSubmission({ validation: 'throw' })
        if (needsUpload) {
            submission.upload(upload)
            needsUpload = false
        }

        const submitted = submission
            .render(pass, [ draw ])
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
