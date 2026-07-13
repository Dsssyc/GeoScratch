import { ScratchRuntime } from 'geoscratch'

const canvas = document.getElementById('GPUFrame')
const resultElement = document.getElementById('submission-result')

const incrementWgsl = `
@group(0) @binding(0)
var<storage, read_write> value: array<u32>;

@compute @workgroup_size(1)
fn csMain() {
    value[0] = value[0] + 1u;
}
`

renderResult('...', 'pending')

void main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    document.body.dataset.status = 'failed'
    document.body.dataset.result = 'error'
    resultElement.textContent = `Error: ${message}`
    renderResult('!', 'failed')
    console.error(error)
})

async function main() {

    const runtime = await ScratchRuntime.create({
        label: 'submission order runtime',
    })
    const value = await runtime.createBuffer({
        label: 'submission order value',
        size: 4,
        usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE,
    })
    const bindLayout = await runtime.createBindLayout({
        label: 'submission order bind layout',
        group: 0,
        entries: [
            {
                binding: 0,
                name: 'value',
                type: 'storage',
                visibility: [ 'compute' ],
            },
        ],
    })
    const valueRegion = value.region()
    const bindSet = await runtime.createBindSet(bindLayout, { value: valueRegion }, {
        label: 'submission order bind set',
    })
    const program = runtime.createProgram({
        label: 'submission order increment program',
        modules: [ incrementWgsl ],
        entryPoints: { compute: 'csMain' },
    })
    const pipeline = await runtime.createComputePipeline({
        label: 'submission order increment pipeline',
        program,
        bindLayouts: [ bindLayout ],
    })
    const pass = runtime.createComputePass({
        label: 'submission order compute pass',
    })
    const uploadZero = runtime.createUploadCommand({
        label: 'upload zero',
        target: valueRegion,
        data: new Uint32Array([ 0 ]),
    })
    const incrementZero = runtime.createDispatchCommand({
        label: 'increment zero',
        pipeline,
        bindSets: [ { set: bindSet } ],
        count: { workgroups: [ 1 ] },
        resources: {
            read: [ { resource: value, contentEpoch: 1 } ],
            write: [ value ],
        },
        whenMissing: 'throw',
    })
    const uploadTen = runtime.createUploadCommand({
        label: 'upload ten',
        target: valueRegion,
        data: new Uint32Array([ 10 ]),
    })
    const incrementTen = runtime.createDispatchCommand({
        label: 'increment ten',
        pipeline,
        bindSets: [ { set: bindSet } ],
        count: { workgroups: [ 1 ] },
        resources: {
            read: [ { resource: value, contentEpoch: 3 } ],
            write: [ value ],
        },
        whenMissing: 'throw',
    })
    const readback = await runtime.createReadbackCommand({
        label: 'read ordered result',
        source: { region: valueRegion, contentEpoch: 4 },
        whenMissing: 'throw',
    })

    const submitted = runtime.createSubmission({ validation: 'throw' })
        .upload(uploadZero)
        .compute(pass, [ incrementZero ])
        .upload(uploadTen)
        .compute(pass, [ incrementTen ])
        .readback(readback)
        .submit()
    const operation = readback.result({ after: submitted })
    const [ result ] = await operation.toArray(Uint32Array)
    await requireObservedSubmission(submitted)
    const passed = result === 11

    document.body.dataset.status = passed ? 'passed' : 'failed'
    document.body.dataset.result = String(result)
    resultElement.textContent = `${result} ${passed ? 'Passed' : 'Failed'}`
    renderResult(String(result), passed ? 'passed' : 'failed')
}

function renderResult(value, status) {

    const context = canvas.getContext('2d')
    const devicePixelRatio = window.devicePixelRatio || 1
    const width = Math.max(1, Math.floor(canvas.clientWidth * devicePixelRatio))
    const height = Math.max(1, Math.floor(canvas.clientHeight * devicePixelRatio))
    canvas.width = width
    canvas.height = height

    context.fillStyle = status === 'failed' ? '#271014' : '#080b10'
    context.fillRect(0, 0, width, height)
    context.fillStyle = status === 'failed' ? '#ff8f94' : '#79d6c0'
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.font = `700 ${Math.max(72, Math.floor(height * 0.34))}px system-ui, sans-serif`
    context.fillText(value, width * 0.5, height * 0.48)
    context.fillStyle = 'rgba(238, 245, 242, 0.68)'
    context.font = `500 ${Math.max(14, Math.floor(16 * devicePixelRatio))}px system-ui, sans-serif`
    context.fillText('UPLOAD 0  /  +1  /  UPLOAD 10  /  +1', width * 0.5, height * 0.76)
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
