import { ScratchRuntime } from 'geoscratch'

const canvas = document.getElementById('GPUFrame')
const statusElement = document.getElementById('proof-status')
const sourceSize = 4
const copySize = { width: 2, height: 2 }
const paddedBytesPerRow = 256
const readbackByteLength = paddedBytesPerRow + copySize.width * 4
const expectedRows = [
    [ 0, 0, 255, 255, 255, 255, 0, 255 ],
    [ 255, 0, 0, 255, 0, 255, 0, 255 ],
]

const sampleWgsl = `
@group(0) @binding(0)
var uploadedTexture: texture_2d<f32>;

@group(0) @binding(1)
var uploadedSampler: sampler;

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
};

@vertex
fn vsMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    var positions = array<vec2f, 6>(
        vec2f(-0.82, -0.82),
        vec2f( 0.82, -0.82),
        vec2f(-0.82,  0.82),
        vec2f(-0.82,  0.82),
        vec2f( 0.82, -0.82),
        vec2f( 0.82,  0.82)
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
    return textureSample(uploadedTexture, uploadedSampler, input.uv);
}
`

void main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    document.body.dataset.status = 'failed'
    document.body.dataset.actualBytes = 'error'
    statusElement.textContent = `Failed: ${message}`
    console.error(error)
})

async function main() {

    const runtime = await ScratchRuntime.create({
        label: 'external image upload example runtime',
    })
    const surface = runtime.createSurface(canvas, {
        label: 'external image upload surface',
        format: 'preferred',
        alphaMode: 'opaque',
    })
    resizeSurface(surface, canvas)

    const sourceCanvas = document.createElement('canvas')
    sourceCanvas.width = sourceSize
    sourceCanvas.height = sourceSize
    const sourceContext = sourceCanvas.getContext('2d', { alpha: false, colorSpace: 'srgb' })
    if (!sourceContext) throw new Error('2D canvas is unavailable')

    const uploadedTexture = await runtime.createTexture({
        label: 'external image uploaded texture',
        size: copySize,
        format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT |
            GPUTextureUsage.COPY_DST |
            GPUTextureUsage.COPY_SRC |
            GPUTextureUsage.TEXTURE_BINDING,
    })
    const externalUpload = runtime.createExternalImageUploadCommand({
        label: 'upload cropped and flipped source canvas',
        source: sourceCanvas,
        sourceOrigin: { x: 1, y: 1 },
        flipY: true,
        target: uploadedTexture,
        colorSpace: 'srgb',
        premultipliedAlpha: false,
        size: copySize,
    })

    drawFinalSourcePattern(sourceContext)

    const readbackBuffer = await runtime.createBuffer({
        label: 'external image padded readback buffer',
        size: readbackByteLength,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    })
    const copyToReadback = runtime.createCopyCommand({
        label: 'copy uploaded texture into padded readback rows',
        source: { resource: uploadedTexture, contentEpoch: 1 },
        target: readbackBuffer,
        targetLayout: {
            offset: 0,
            bytesPerRow: 256,
            rowsPerImage: copySize.height,
        },
        size: copySize,
        whenMissing: 'throw',
    })
    const readback = runtime.createReadbackCommand({
        label: 'read exact external upload bytes',
        source: { resource: readbackBuffer, contentEpoch: 1 },
        sourceOffset: 0,
        byteLength: readbackByteLength,
        whenMissing: 'throw',
    })
    const sampler = runtime.createSampler({
        label: 'external image nearest sampler',
        magFilter: 'nearest',
        minFilter: 'nearest',
    })
    const bindLayout = runtime.createBindLayout({
        label: 'external image sample layout',
        group: 0,
        entries: [
            {
                binding: 0,
                name: 'uploadedTexture',
                type: 'texture',
                sampleType: 'float',
                viewDimension: '2d',
                visibility: [ 'fragment' ],
            },
            {
                binding: 1,
                name: 'uploadedSampler',
                type: 'sampler',
                samplerType: 'filtering',
                visibility: [ 'fragment' ],
            },
        ],
    })
    const bindSet = runtime.createBindSet(bindLayout, {
        uploadedTexture,
        uploadedSampler: sampler,
    }, {
        label: 'external image sample set',
    })
    const program = runtime.createProgram({
        label: 'external image sample program',
        modules: [ sampleWgsl ],
        entryPoints: {
            vertex: 'vsMain',
            fragment: 'fsMain',
        },
    })
    const pipeline = runtime.createRenderPipeline({
        label: 'external image sample pipeline',
        program,
        bindLayouts: [ bindLayout ],
        targets: [ { format: surface.format } ],
    })
    const surfacePass = runtime.createRenderPass({
        label: 'external image presentation pass',
        color: [ {
            target: surface,
            load: 'clear',
            store: 'store',
            clear: [ 0.035, 0.035, 0.045, 1 ],
        } ],
    })
    const draw = runtime.createDrawCommand({
        label: 'draw sampled external upload',
        pipeline,
        bindSets: [ bindSet ],
        count: { vertexCount: 6 },
        resources: {
            read: [ { resource: uploadedTexture, contentEpoch: 1 } ],
            write: [],
        },
        whenMissing: 'throw',
    })

    const submitted = runtime.createSubmission({ validation: 'throw' })
        .upload(externalUpload)
        .copy(copyToReadback)
        .readback(readback)
        .render(surfacePass, [ draw ])
        .submit()
    const bytes = await readback.result({ after: submitted }).toBytes()
    const actualRows = [
        Array.from(bytes.slice(0, copySize.width * 4)),
        Array.from(bytes.slice(paddedBytesPerRow, paddedBytesPerRow + copySize.width * 4)),
    ]
    const passed = rowsEqual(actualRows, expectedRows)

    document.body.dataset.expectedBytes = JSON.stringify(expectedRows)
    document.body.dataset.actualBytes = JSON.stringify(actualRows)
    document.body.dataset.status = passed ? 'passed' : 'failed'
    statusElement.textContent = passed ? 'Passed' : 'Failed'

    if (!passed) {
        throw new Error(`readback mismatch: ${JSON.stringify(actualRows)}`)
    }
}

function drawFinalSourcePattern(context) {

    context.fillStyle = '#111114'
    context.fillRect(0, 0, sourceSize, sourceSize)
    context.fillStyle = '#ff0000'
    context.fillRect(1, 1, 1, 1)
    context.fillStyle = '#00ff00'
    context.fillRect(2, 1, 1, 1)
    context.fillStyle = '#0000ff'
    context.fillRect(1, 2, 1, 1)
    context.fillStyle = '#ffff00'
    context.fillRect(2, 2, 1, 1)
}

function rowsEqual(actual, expected) {

    return actual.length === expected.length && actual.every((row, rowIndex) => (
        row.length === expected[rowIndex].length &&
        row.every((value, valueIndex) => value === expected[rowIndex][valueIndex])
    ))
}

function resizeSurface(surface, targetCanvas) {

    const devicePixelRatio = window.devicePixelRatio || 1
    const width = Math.max(1, Math.floor(targetCanvas.clientWidth * devicePixelRatio))
    const height = Math.max(1, Math.floor(targetCanvas.clientHeight * devicePixelRatio))

    if (surface.size.width !== width || surface.size.height !== height) {
        surface.resize({ width, height })
    }
}
