import {
    ScratchRuntime,
} from 'geoscratch'

const canvas = document.getElementById('GPUFrame')
const result = document.getElementById('readback-result')
canvas.dataset.status = 'loading'

const computeWgsl = `
@group(0) @binding(0)
var<storage, read> inputValues: array<f32>;

@group(0) @binding(1)
var<storage, read_write> outputValues: array<f32>;

@compute @workgroup_size(4)
fn csMain(@builtin(global_invocation_id) id: vec3u) {
    outputValues[id.x] = inputValues[id.x] * 2.0;
}
`

void main().catch((error) => {
    canvas.dataset.status = 'error'
    result.textContent = `GPU result: ${error.message}`
    console.error(error)
})

async function main() {

    const runtime = await ScratchRuntime.create({
        label: 'scratch compute readback runtime',
    })
    const input = await runtime.createBuffer({
        label: 'scratch compute readback input',
        size: 16,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE,
    })
    const output = await runtime.createBuffer({
        label: 'scratch compute readback output',
        size: 16,
        usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.STORAGE,
    })
    const bindLayout = await runtime.createBindLayout({
        label: 'scratch compute readback layout',
        group: 0,
        entries: [
            {
                binding: 0,
                name: 'inputValues',
                type: 'read-storage',
                visibility: [ 'compute' ],
            },
            {
                binding: 1,
                name: 'outputValues',
                type: 'storage',
                visibility: [ 'compute' ],
            },
        ],
    })
    const bindSet = runtime.createBindSet(bindLayout, {
        inputValues: input,
        outputValues: output,
    }, {
        label: 'scratch compute readback bindings',
    })
    const program = runtime.createProgram({
        label: 'scratch compute readback program',
        modules: [ computeWgsl ],
        entryPoints: {
            compute: 'csMain',
        },
    })
    const pipeline = await runtime.createComputePipeline({
        label: 'scratch compute readback pipeline',
        program,
        bindLayouts: [ bindLayout ],
    })
    const pass = runtime.createComputePass({
        label: 'scratch compute readback pass',
    })
    const upload = runtime.createUploadCommand({
        label: 'upload scratch compute readback input',
        target: input,
        data: new Float32Array([ 1, 2, 3, 4 ]),
        offset: 0,
    })
    const dispatch = runtime.createDispatchCommand({
        label: 'dispatch scratch compute readback',
        pipeline,
        bindSets: [ { set: bindSet } ],
        count: { workgroups: [ 1 ] },
        resources: {
            read: [
                { resource: input, contentEpoch: 1 },
            ],
            write: [ output ],
        },
        whenMissing: 'throw',
    })

    const submitted = runtime.createSubmission({ validation: 'throw' })
        .upload(upload)
        .compute(pass, [ dispatch ])
        .submit()

    const readback = runtime.createReadback({
        label: 'read scratch compute output',
        source: output,
        after: submitted,
        range: { offset: 0, byteLength: 16 },
    })
    const values = await readback.toArray(Float32Array)
    await requireObservedSubmission(submitted)
    const numbers = [ ...values ].map(value => Number(value.toFixed(3)))

    canvas.dataset.status = 'ready'
    result.textContent = `GPU result: ${numbers.join(', ')}`
    renderBars(canvas, numbers)
}

function renderBars(canvas, values) {

    const context = canvas.getContext('2d')
    const devicePixelRatio = window.devicePixelRatio || 1
    const width = Math.max(1, Math.floor(canvas.clientWidth * devicePixelRatio))
    const height = Math.max(1, Math.floor(canvas.clientHeight * devicePixelRatio))
    canvas.width = width
    canvas.height = height

    context.fillStyle = '#080b10'
    context.fillRect(0, 0, width, height)

    const max = Math.max(...values)
    const gap = Math.max(12, width * 0.025)
    const barWidth = (width - gap * (values.length + 1)) / values.length
    const baseline = height * 0.72
    const scale = height * 0.46 / max

    context.fillStyle = '#79d6c0'
    for (let index = 0; index < values.length; index++) {
        const barHeight = values[index] * scale
        const x = gap + index * (barWidth + gap)
        const y = baseline - barHeight
        context.fillRect(x, y, barWidth, barHeight)
    }

    context.fillStyle = 'rgba(238, 245, 242, 0.72)'
    context.font = `${Math.max(12, Math.floor(14 * devicePixelRatio))}px system-ui, sans-serif`
    for (let index = 0; index < values.length; index++) {
        const text = String(values[index])
        const x = gap + index * (barWidth + gap) + barWidth * 0.5
        context.fillText(text, x - context.measureText(text).width * 0.5, baseline + 26 * devicePixelRatio)
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
