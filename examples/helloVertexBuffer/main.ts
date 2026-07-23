import {
    ScratchRuntime,
} from 'geoscratch'
import type { SubmittedWork, Surface } from 'geoscratch'

const canvas = document.getElementById('GPUFrame') as HTMLCanvasElement
canvas.dataset.status = 'loading'

const vertexBufferWgsl = `
struct VertexInput {
    @location(0) position: vec2f,
    @location(1) color: vec3f,
    @location(2) size: f32,
};

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) @interpolate(perspective, center) color: vec3f,
};

@vertex
fn vsMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    output.position = vec4f(input.position * input.size, 0.0, 1.0);
    output.color = input.color;
    return output;
}

@fragment
fn fsMain(input: VertexOutput) -> @location(0) vec4f {
    return vec4f(input.color, 1.0);
}
`

const vertices = new Float32Array([
    // x,    y,     r,    g,    b
    -0.5, -0.5,   1.0,  0.0,  0.0,
     0.0,  0.5,   0.0,  1.0,  0.0,
     0.5, -0.5,   0.0,  0.0,  1.0,
])
const instanceSize = new Float32Array([ 1 ])

void main().catch((error) => {
    canvas.dataset.status = 'error'
    console.error(error)
})

async function main() {

    const runtime = await ScratchRuntime.create({
        label: 'hello vertex buffer runtime',
    })
    const surface = runtime.createSurface(canvas, {
        label: 'hello vertex buffer surface',
        format: 'preferred',
        alphaMode: 'opaque',
    })
    const vertexBuffer = await runtime.createBuffer({
        label: 'hello vertex attributes',
        size: vertices.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    })
    const instanceSizeBuffer = await runtime.createBuffer({
        label: 'hello vertex instance size',
        size: instanceSize.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    })
    const vertexRegion = vertexBuffer.region()
    const instanceSizeRegion = instanceSizeBuffer.region()
    const shaderModule = await runtime.createShaderModule({
        label: 'hello vertex buffer shader',
        sourceParts: [ { code: vertexBufferWgsl } ],
    })
    const program = runtime.createProgram({
        label: 'hello vertex buffer program',
        vertex: { module: shaderModule, entryPoint: 'vsMain' },
        fragment: { module: shaderModule, entryPoint: 'fsMain' },
    })
    const pipeline = await runtime.createRenderPipeline({
        label: 'hello vertex buffer pipeline',
        program,
        vertexBuffers: [
            {
                arrayStride: 20,
                stepMode: 'vertex',
                attributes: [
                    { shaderLocation: 0, offset: 0, format: 'float32x2' },
                    { shaderLocation: 1, offset: 8, format: 'float32x3' },
                ],
            },
            {
                arrayStride: 4,
                stepMode: 'instance',
                attributes: [
                    { shaderLocation: 2, offset: 0, format: 'float32' },
                ],
            },
        ],
        targets: [ { format: surface.format } ],
    })
    const pass = runtime.createRenderPass({
        label: 'hello vertex buffer pass',
        color: [
            {
                target: surface,
                load: 'clear',
                store: 'store',
                clear: [ 0.03, 0.05, 0.08, 1 ],
            },
        ],
    })
    const uploadVertices = runtime.createUploadCommand({
        label: 'upload hello vertex attributes',
        target: vertexRegion,
        data: vertices,
    })
    const uploadInstanceSize = runtime.createUploadCommand({
        label: 'upload hello vertex instance size',
        target: instanceSizeRegion,
        data: instanceSize,
    })
    let frame = 0
    let needsVertexUpload = true
    let firstFrameSettled = false

    function render() {

        resizeSurface(surface, canvas)
        instanceSize[0] = 0.75 + 0.2 * Math.cos(frame++ * 0.04)

        const expectedVertexEpoch = vertexBuffer.contentEpoch + (needsVertexUpload ? 1 : 0)
        const expectedInstanceSizeEpoch = instanceSizeBuffer.contentEpoch + 1
        const draw = runtime.createDrawCommand({
            label: 'draw hello vertex buffer',
            pipeline,
            vertexBuffers: [
                { slot: 0, region: vertexRegion },
                { slot: 1, region: instanceSizeRegion },
            ],
            count: { vertexCount: 3, instanceCount: 1 },
            resources: {
                read: [
                    { resource: vertexBuffer, contentEpoch: expectedVertexEpoch },
                    { resource: instanceSizeBuffer, contentEpoch: expectedInstanceSizeEpoch },
                ],
                write: [],
            },
            whenMissing: 'throw',
        })

        const submission = runtime.createSubmission({ validation: 'throw' })
        if (needsVertexUpload) {
            submission.upload(uploadVertices)
            needsVertexUpload = false
        }

        const submitted = submission
            .upload(uploadInstanceSize)
            .render(pass, [ draw ])
            .submit()
        if (!firstFrameSettled) {
            firstFrameSettled = true
            void requireObservedSubmission(submitted).then(() => {
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

function resizeSurface(surface: Surface, canvas: HTMLCanvasElement) {

    const devicePixelRatio = window.devicePixelRatio || 1
    const width = Math.max(1, Math.floor(canvas.clientWidth * devicePixelRatio))
    const height = Math.max(1, Math.floor(canvas.clientHeight * devicePixelRatio))

    if (surface.size.width !== width || surface.size.height !== height) {
        surface.resize({ width, height })
    }
}

async function requireObservedSubmission(submitted: SubmittedWork) {

    const [ nativeOutcome ] = await Promise.all([
        submitted.nativeOutcome,
        submitted.done,
    ])
    if (nativeOutcome.status !== 'observed-succeeded') {
        throw new Error(`Submission native outcome was ${nativeOutcome.status}.`)
    }
}
