import { ScratchRuntime } from 'geoscratch'
import type { SubmittedWork } from 'geoscratch'

const expected = [ 3, 5, 8, 13 ]
const canvas = document.getElementById('GPUFrame') as HTMLCanvasElement
const resultElement = document.getElementById('mapping-result') as HTMLElement

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
        label: 'buffer mapping example runtime',
    })

    try {
        const { buffer: source, lease: writeLease } = await runtime.createMappedBuffer({
            label: 'mapped initial values',
            size: 16,
            usage: GPUBufferUsage.COPY_SRC,
        })
        const writeView = writeLease.view
        new Uint32Array(writeView).set(expected)
        writeLease.dispose()

        const target = await runtime.createBuffer({
            label: 'mapped copy result',
            size: 16,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        })
        const copy = runtime.createCopyCommand({
            label: 'copy mapped initial values',
            source: {
                region: source.region(),
                contentEpoch: source.contentEpoch,
            },
            target: target.region(),
            whenMissing: 'throw',
        })
        const submitted = runtime.createSubmission({ validation: 'throw' })
            .copy(copy)
            .submit()

        const readLease = await runtime.mapBuffer({
            region: target.region(),
            mode: 'read',
        })
        const readView = readLease.view
        const values = [ ...new Uint32Array(readView) ]
        readLease.dispose()
        await requireObservedSubmission(submitted)

        const writeViewDetached = writeView.byteLength === 0
        const readViewDetached = readView.byteLength === 0
        const passed = equalNumbers(values, expected) &&
            writeViewDetached &&
            readViewDetached &&
            source.contentEpoch === 1 &&
            target.contentEpoch === 1 &&
            runtime.diagnostics.snapshot().bufferMapping.currentMappings === 0

        document.body.dataset.status = passed ? 'passed' : 'failed'
        document.body.dataset.result = values.join(',')
        document.body.dataset.writeViewDetached = String(writeViewDetached)
        document.body.dataset.readViewDetached = String(readViewDetached)
        document.body.dataset.sourceEpoch = String(source.contentEpoch)
        document.body.dataset.targetEpoch = String(target.contentEpoch)
        resultElement.textContent = `${values.join(', ')} ${passed ? 'Passed' : 'Failed'}`
        renderResult(values.join('  '), passed ? 'passed' : 'failed')

        if (!passed) {
            throw new Error('Buffer mapping result or lifecycle facts did not match.')
        }
    } finally {
        runtime.dispose()
    }
}

function equalNumbers(actual: readonly number[], expectedValues: readonly number[]): boolean {

    return actual.length === expectedValues.length &&
        actual.every((value, index) => value === expectedValues[index])
}

function renderResult(value: string, status: string) {

    const context = canvas.getContext('2d') as CanvasRenderingContext2D
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
    context.font = `700 ${Math.max(44, Math.floor(height * 0.22))}px system-ui, sans-serif`
    context.fillText(value, width * 0.5, height * 0.48)
    context.fillStyle = 'rgba(238, 245, 242, 0.68)'
    context.font = `500 ${Math.max(14, Math.floor(16 * devicePixelRatio))}px system-ui, sans-serif`
    context.fillText('WRITE LEASE  /  GPU COPY  /  READ LEASE', width * 0.5, height * 0.74)
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
