import { ScratchRuntime } from 'geoscratch'

const GPU_BUFFER_USAGE_COPY_DST = 0x08
const GPU_BUFFER_USAGE_INDEX = 0x10
const GPU_BUFFER_USAGE_STORAGE = 0x80
const GPU_BUFFER_USAGE_INDIRECT = 0x100

const canvas = document.getElementById('GPUFrame')

const argumentProgramWgsl = `
@group(0) @binding(0)
var<storage, read_write> drawArgs: array<u32>;

@group(0) @binding(1)
var<storage, read_write> indexedArgs: array<u32>;

@compute @workgroup_size(1)
fn makeArguments() {
    drawArgs[0] = 3u;
    drawArgs[1] = 1u;
    drawArgs[2] = 0u;
    drawArgs[3] = 0u;

    indexedArgs[0] = 3u;
    indexedArgs[1] = 1u;
    indexedArgs[2] = 0u;
    indexedArgs[3] = 0u;
    indexedArgs[4] = 0u;
}
`

const renderProgramWgsl = `
struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) color: vec3f,
}

@vertex
fn vsMain(
    @builtin(vertex_index) vertexIndex: u32,
) -> VertexOutput {
    var positions = array<vec2f, 6>(
        vec2f(-0.43, 0.5),
        vec2f(-0.73, -0.45),
        vec2f(-0.13, -0.45),
        vec2f(0.43, 0.5),
        vec2f(0.13, -0.45),
        vec2f(0.73, -0.45)
    );
    let isIndexed = vertexIndex >= 3u;

    var output: VertexOutput;
    output.position = vec4f(positions[vertexIndex], 0.0, 1.0);
    output.color = select(vec3f(0.12, 0.72, 0.58), vec3f(0.96, 0.42, 0.24), isIndexed);
    return output;
}

@fragment
fn fsMain(input: VertexOutput) -> @location(0) vec4f {
    return vec4f(input.color, 1.0);
}
`

void main().catch((error) => {
    canvas.dataset.status = 'error'
    console.error(error)
})

async function main() {

    const runtime = await ScratchRuntime.create({ label: 'indirect execution runtime' })
    const surface = runtime.createSurface(canvas, {
        label: 'indirect execution surface',
        format: 'preferred',
        alphaMode: 'opaque',
    })
    const dispatchArguments = await runtime.createBuffer({
        label: 'dispatch arguments',
        size: 12,
        usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_INDIRECT,
    })
    const drawArguments = await runtime.createBuffer({
        label: 'draw arguments',
        size: 16,
        usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_INDIRECT,
    })
    const indexedArguments = await runtime.createBuffer({
        label: 'indexed draw arguments',
        size: 20,
        usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_INDIRECT,
    })
    const indexBuffer = await runtime.createBuffer({
        label: 'triangle indices',
        size: 8,
        usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_INDEX,
    })
    const argumentLayout = await runtime.createBindLayout({
        label: 'argument writer layout',
        group: 0,
        entries: [
            {
                binding: 0,
                name: 'drawArgs',
                type: 'storage',
                visibility: [ 'compute' ],
            },
            {
                binding: 1,
                name: 'indexedArgs',
                type: 'storage',
                visibility: [ 'compute' ],
            },
        ],
    })
    const argumentSet = runtime.createBindSet(argumentLayout, {
        drawArgs: drawArguments,
        indexedArgs: indexedArguments,
    })
    const argumentProgram = runtime.createProgram({
        label: 'argument writer program',
        modules: [ argumentProgramWgsl ],
        entryPoints: { compute: 'makeArguments' },
    })
    const argumentPipeline = await runtime.createComputePipeline({
        label: 'argument writer pipeline',
        program: argumentProgram,
        compute: 'makeArguments',
        bindLayouts: [ argumentLayout ],
    })
    const renderProgram = runtime.createProgram({
        label: 'indirect render program',
        modules: [ renderProgramWgsl ],
        entryPoints: {
            vertex: 'vsMain',
            fragment: 'fsMain',
        },
    })
    const renderPipeline = await runtime.createRenderPipeline({
        label: 'indirect render pipeline',
        program: renderProgram,
        targets: [ { format: surface.format } ],
    })
    const computePass = runtime.createComputePass({ label: 'argument writer pass' })
    const renderPass = runtime.createRenderPass({
        label: 'indirect render pass',
        color: [ {
            target: surface,
            load: 'clear',
            store: 'store',
            clear: [ 0.025, 0.04, 0.065, 1 ],
        } ],
    })
    const uploadDispatchArguments = runtime.createUploadCommand({
        target: dispatchArguments,
        data: new Uint32Array([ 1, 1, 1 ]),
    })
    const uploadIndices = runtime.createUploadCommand({
        target: indexBuffer,
        data: new Uint16Array([ 3, 4, 5, 0 ]),
    })

    function render() {

        resizeSurface(surface, canvas)

        const dispatchEpoch = dispatchArguments.contentEpoch + 1
        const indexEpoch = indexBuffer.contentEpoch + 1
        const drawEpoch = drawArguments.contentEpoch + 1
        const indexedEpoch = indexedArguments.contentEpoch + 1
        const produceArguments = runtime.createDispatchCommand({
            label: 'write indirect draw arguments',
            pipeline: argumentPipeline,
            bindSets: [ { set: argumentSet } ],
            count: { indirect: dispatchArguments },
            resources: {
                read: [ { resource: dispatchArguments, contentEpoch: dispatchEpoch } ],
                write: [ drawArguments, indexedArguments ],
            },
            whenMissing: 'throw',
        })
        const draw = runtime.createDrawCommand({
            label: 'draw GPU-generated triangle',
            pipeline: renderPipeline,
            count: { indirect: drawArguments },
            resources: {
                read: [ { resource: drawArguments, contentEpoch: drawEpoch } ],
                write: [],
            },
            whenMissing: 'throw',
        })
        const drawIndexed = runtime.createDrawCommand({
            label: 'draw GPU-generated indexed triangle',
            pipeline: renderPipeline,
            indexBuffer: {
                buffer: indexBuffer,
                format: 'uint16',
                size: 6,
            },
            count: { indirect: indexedArguments },
            resources: {
                read: [
                    { resource: indexBuffer, contentEpoch: indexEpoch },
                    { resource: indexedArguments, contentEpoch: indexedEpoch },
                ],
                write: [],
            },
            whenMissing: 'throw',
        })

        const submitted = runtime.createSubmission({ validation: 'throw' })
            .upload(uploadDispatchArguments)
            .upload(uploadIndices)
            .compute(computePass, [ produceArguments ])
            .render(renderPass, [ draw, drawIndexed ])
            .submit()

        canvas.dataset.status = 'submitted'
        void requireObservedSubmission(submitted).then(() => {
            canvas.dataset.status = 'ready'
        }).catch((error) => {
            canvas.dataset.status = 'error'
            console.error(error)
        })
    }

    render()
    window.addEventListener('resize', render)
}

function resizeSurface(surface, target) {

    const devicePixelRatio = window.devicePixelRatio || 1
    const width = Math.max(1, Math.floor(target.clientWidth * devicePixelRatio))
    const height = Math.max(1, Math.floor(target.clientHeight * devicePixelRatio))

    if (surface.size.width !== width || surface.size.height !== height) {
        surface.resize({ width, height })
    }
}

async function requireObservedSubmission(submitted) {

    const [ nativeOutcome ] = await Promise.all([
        submitted.nativeOutcome,
        submitted.done,
    ])
    if (nativeOutcome.status !== 'observed-succeeded') {
        throw new Error(`Submission native outcome was ${nativeOutcome.status}.`)
    }
}
