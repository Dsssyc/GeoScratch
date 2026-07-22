import {
    ScratchRuntime,
} from 'geoscratch'
import type { SubmittedWork, Surface } from 'geoscratch'

const canvas = document.getElementById('GPUFrame') as HTMLCanvasElement
canvas.dataset.status = 'loading'

const uniformTriangleWgsl = `
struct TriangleUniforms {
    color: vec4f,
};

@group(0) @binding(0)
var<uniform> uniforms: TriangleUniforms;

@vertex
fn vsMain(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4f {
    var positions = array<vec2f, 3>(
        vec2f(0.0, 0.58),
        vec2f(-0.58, -0.48),
        vec2f(0.58, -0.48)
    );
    let p = positions[vertexIndex];
    return vec4f(p, 0.0, 1.0);
}

@fragment
fn fsMain() -> @location(0) vec4f {
    return uniforms.color;
}
`

void main().catch((error) => {
    canvas.dataset.status = 'error'
    console.error(error)
})

async function main() {

    const proofFrameCount = 120
    const runtime = await ScratchRuntime.create({
        label: 'scratch uniform triangle runtime',
    })
    let failed = false
    let uncapturedErrorCount = 0
    const fail = (error: unknown) => {
        if (failed) return
        failed = true
        canvas.dataset.status = 'error'
        console.error(error)
    }
    runtime.device.addEventListener('uncapturederror', (event) => {
        uncapturedErrorCount++
        canvas.dataset.uncapturedErrors = String(uncapturedErrorCount)
        fail(event.error)
    })
    const surface = runtime.createSurface(canvas, {
        label: 'scratch uniform triangle surface',
        format: 'preferred',
        alphaMode: 'opaque',
    })
    const uniformBuffer = await runtime.createBuffer({
        label: 'scratch uniform triangle color',
        size: 16,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.UNIFORM,
    })
    const bindLayout = await runtime.createBindLayout({
        label: 'scratch uniform triangle layout',
        group: 0,
        entries: [
            {
                binding: 0,
                name: 'uniforms',
                type: 'uniform',
                visibility: [ 'vertex', 'fragment' ],
            },
        ],
    })
    const bindSet = await runtime.createBindSet(bindLayout, {
        uniforms: uniformBuffer.region(),
    }, {
        label: 'scratch uniform triangle bindings',
    })
    const program = runtime.createProgram({
        label: 'scratch uniform triangle program',
        modules: [ uniformTriangleWgsl ],
        entryPoints: {
            vertex: 'vsMain',
            fragment: 'fsMain',
        },
    })
    const pipeline = await runtime.createRenderPipeline({
        label: 'scratch uniform triangle pipeline',
        program,
        bindLayouts: [ bindLayout ],
        targets: [ { format: surface.format } ],
    })
    const pass = runtime.createRenderPass({
        label: 'scratch uniform triangle pass',
        color: [
            {
                target: surface,
                load: 'clear',
                store: 'store',
                clear: [ 0.03, 0.05, 0.08, 1 ],
            },
        ],
    })
    const color = new Float32Array([ 0.86, 0.28, 0.12, 1 ])
    const upload = runtime.createUploadCommand({
        label: 'upload scratch uniform triangle color',
        target: uniformBuffer.region(),
        data: color,
    })
    const draw = runtime.createDrawCommand({
        label: 'draw scratch uniform triangle',
        pipeline,
        bindSets: [ { set: bindSet } ],
        count: { vertexCount: 3 },
        resources: {
            read: [
                { resource: uniformBuffer, contentEpoch: 'current-at-step' },
            ],
            write: [],
        },
        whenMissing: 'throw',
    })

    const persistentIds = Object.freeze({
        upload: upload.id,
        draw: draw.id,
        bindSet: bindSet.id,
        pipeline: pipeline.id,
        pass: pass.id,
    })
    let submittedFrames = 0
    let observedFrames = 0
    let lastResolvedEpoch = 0
    canvas.dataset.proofFrames = String(proofFrameCount)
    canvas.dataset.uncapturedErrors = '0'
    canvas.dataset.uploadCommandId = persistentIds.upload
    canvas.dataset.drawCommandId = persistentIds.draw
    canvas.dataset.bindSetId = persistentIds.bindSet
    canvas.dataset.pipelineId = persistentIds.pipeline
    canvas.dataset.passId = persistentIds.pass

    function render(timestamp: number) {

        if (failed) return

        try {
            resizeSurface(surface, canvas)
            updateColor(color, timestamp)

            const submitted = runtime.createSubmission({ validation: 'throw' })
                .upload(upload)
                .render(pass, [ draw ])
                .submit()
            submittedFrames++

            const read = submitted.resourceAccesses.find(access => (
                access.commandId === draw.id &&
                access.resourceId === uniformBuffer.id &&
                access.access === 'read'
            ))
            const producer = submitted.producerEpochs.find(epoch => (
                epoch.resourceId === uniformBuffer.id &&
                epoch.producedBy.commandId === upload.id
            ))
            const stableObjects =
                upload.id === persistentIds.upload &&
                draw.id === persistentIds.draw &&
                bindSet.id === persistentIds.bindSet &&
                pipeline.id === persistentIds.pipeline &&
                pass.id === persistentIds.pass
            const declarationStable =
                draw.resources.read[0]?.contentEpoch === 'current-at-step'
            const producerReadMatch =
                read?.declaredContentEpoch === 'current-at-step' &&
                read.contentEpochBefore === read.contentEpochAfter &&
                read.contentEpochBefore === producer?.contentEpoch
            const epochMonotonic =
                read !== undefined &&
                read.contentEpochBefore === lastResolvedEpoch + 1

            if (!stableObjects || !declarationStable || !producerReadMatch || !epochMonotonic) {
                throw new Error('Uniform triangle current-content reuse proof diverged.')
            }

            lastResolvedEpoch = read.contentEpochBefore
            canvas.dataset.frames = String(submittedFrames)
            canvas.dataset.observedFrames = String(observedFrames)
            canvas.dataset.stableObjects = String(stableObjects)
            canvas.dataset.declarationStable = String(declarationStable)
            canvas.dataset.producerReadMatch = String(producerReadMatch)
            canvas.dataset.epochMonotonic = String(epochMonotonic)
            canvas.dataset.declaredContentEpoch = read.declaredContentEpoch
            canvas.dataset.resolvedContentEpoch = String(read.contentEpochBefore)
            canvas.dataset.producerContentEpoch = String(producer.contentEpoch)
            canvas.dataset.resourceAccessFrozen = String(Object.isFrozen(read))
            canvas.dataset.resourceAccessSerializable = String(
                JSON.stringify(JSON.parse(JSON.stringify(read))) === JSON.stringify(read)
            )

            const frameNumber = submittedFrames
            void requireObservedSubmission(submitted).then(() => {
                observedFrames = Math.max(observedFrames, frameNumber)
                canvas.dataset.observedFrames = String(observedFrames)
                if (frameNumber === proofFrameCount && !failed) {
                    canvas.dataset.status = 'ready'
                }
            }).catch((error) => {
                fail(error)
            })
        } catch (error) {
            fail(error)
            return
        }

        requestAnimationFrame(render)
    }

    requestAnimationFrame(render)
}

function updateColor(color: Float32Array, timestamp: number) {

    const phase = timestamp * 0.002
    color[0] = 0.2 + 0.72 * (0.5 + 0.5 * Math.sin(phase))
    color[1] = 0.16 + 0.66 * (0.5 + 0.5 * Math.sin(phase + 2.1))
    color[2] = 0.18 + 0.7 * (0.5 + 0.5 * Math.sin(phase + 4.2))
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
