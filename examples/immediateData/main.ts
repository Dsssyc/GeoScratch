import {
    ScratchRuntime,
    layoutCodec,
} from 'geoscratch'
import type {
    SubmittedWork,
    Surface,
} from 'geoscratch'

const languageFeature = 'immediate_address_space'
const canvas = document.getElementById('GPUFrame') as HTMLCanvasElement
const statusOutput = document.getElementById('example-status') as HTMLOutputElement
canvas.dataset.status = 'loading'
canvas.dataset.languageFeature = languageFeature
canvas.dataset.submissionCount = '0'
canvas.dataset.observedSubmissions = '0'
canvas.dataset.resizeGeneration = '0'
canvas.dataset.stableCommandIdentity = 'false'

const computeCodec = layoutCodec({
    name: 'ComputeImmediate',
    fields: [
        { name: 'color', type: 'vec4f' },
    ],
}, {
    usage: [ 'immediate' ],
})

const renderCodec = layoutCodec({
    name: 'RenderImmediate',
    fields: [
        { name: 'offset', type: 'vec2f' },
        { name: 'accent', type: 'vec2f' },
    ],
}, {
    usage: [ 'immediate' ],
})

const computeWgsl = `
requires immediate_address_space;

${computeCodec.wgslAccessors({ namespace: 'ComputeImmediateLayout' })}

var<immediate> computeImmediate: ComputeImmediate;

@group(0) @binding(0)
var<storage, read_write> computedColor: array<vec4f>;

@compute @workgroup_size(1)
fn csMain() {
    let previous = computedColor[0];
    computedColor[0] = mix(previous, computeImmediate.color, 1.0);
}
`

const renderWgsl = `
requires immediate_address_space;

${renderCodec.wgslAccessors({ namespace: 'RenderImmediateLayout' })}

var<immediate> renderImmediate: RenderImmediate;

@group(0) @binding(0)
var<storage, read> computedColor: array<vec4f>;

@vertex
fn vsMain(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4f {
    var positions = array<vec2f, 3>(
        vec2f( 0.0,  0.52),
        vec2f(-0.34, -0.46),
        vec2f( 0.34, -0.46)
    );
    return vec4f(positions[vertexIndex] + renderImmediate.offset, 0.0, 1.0);
}

@fragment
fn fsMain() -> @location(0) vec4f {
    let base = computedColor[0];
    let scaled = base.rgb * renderImmediate.accent.x;
    let lifted = scaled + vec3f(
        renderImmediate.accent.y * 0.16,
        renderImmediate.accent.y * 0.08,
        renderImmediate.accent.y * 0.20
    );
    return vec4f(min(lifted, vec3f(1.0)), 1.0);
}
`

void main().catch(reportFailure)

async function main() {

    if (navigator.gpu === undefined) {
        throw new ExampleCapabilityError(
            'SCRATCH_EXAMPLE_WEBGPU_UNAVAILABLE',
            'This browser does not expose navigator.gpu.'
        )
    }

    const runtime = await ScratchRuntime.create({
        label: 'immediate data runtime',
    })
    if (!runtime.wgslLanguageFeatures.includes(languageFeature)) {
        throw new ExampleCapabilityError(
            'SCRATCH_EXAMPLE_IMMEDIATE_LANGUAGE_UNAVAILABLE',
            `WGSL language feature ${languageFeature} is unavailable.`
        )
    }

    const maxImmediateSize = (
        runtime.deviceLimits as GPUSupportedLimits & {
            readonly maxImmediateSize?: number
        }
    ).maxImmediateSize
    canvas.dataset.maxImmediateSize = String(maxImmediateSize ?? 'unavailable')
    const requiredImmediateSize = Math.max(
        computeCodec.byteLength(),
        renderCodec.byteLength()
    )
    if (
        typeof maxImmediateSize !== 'number' ||
        maxImmediateSize < requiredImmediateSize
    ) {
        throw new ExampleCapabilityError(
            'SCRATCH_EXAMPLE_IMMEDIATE_LIMIT_UNAVAILABLE',
            `Adapter maxImmediateSize must be at least ${requiredImmediateSize}.`
        )
    }

    const surface = runtime.createSurface(canvas, {
        label: 'immediate data surface',
        format: 'preferred',
        alphaMode: 'opaque',
    })
    let resizeGeneration = resizeSurface(surface, canvas, 0)

    const colorBuffer = await runtime.createBuffer({
        label: 'compute-to-render color',
        size: 16,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE,
    })
    const computeLayout = await runtime.createBindLayout({
        label: 'immediate compute layout',
        group: 0,
        entries: [
            {
                binding: 0,
                name: 'computedColor',
                type: 'storage',
                visibility: [ 'compute' ],
            },
        ],
    })
    const renderLayout = await runtime.createBindLayout({
        label: 'immediate render layout',
        group: 0,
        entries: [
            {
                binding: 0,
                name: 'computedColor',
                type: 'read-storage',
                visibility: [ 'fragment' ],
            },
        ],
    })
    const computeSet = await runtime.createBindSet(computeLayout, {
        computedColor: colorBuffer.region(),
    }, {
        label: 'immediate compute bindings',
    })
    const renderSet = await runtime.createBindSet(renderLayout, {
        computedColor: colorBuffer.region(),
    }, {
        label: 'immediate render bindings',
    })

    const computeShader = await runtime.createShaderModule({
        label: 'immediate compute shader',
        sourceParts: [ { code: computeWgsl } ],
    })
    const renderShader = await runtime.createShaderModule({
        label: 'immediate render shader',
        sourceParts: [ { code: renderWgsl } ],
    })
    const computeProgram = runtime.createProgram({
        label: 'immediate compute program',
        compute: { module: computeShader, entryPoint: 'csMain' },
        requiredLanguageFeatures: [ languageFeature ],
    })
    const renderProgram = runtime.createProgram({
        label: 'immediate render program',
        vertex: { module: renderShader, entryPoint: 'vsMain' },
        fragment: { module: renderShader, entryPoint: 'fsMain' },
        requiredLanguageFeatures: [ languageFeature ],
    })
    const computePipeline = await runtime.createComputePipeline({
        label: 'immediate compute pipeline',
        program: computeProgram,
        layout: { mode: 'explicit', bindLayouts: [ computeLayout ] },
        immediateSize: computeCodec.byteLength(),
    })
    const renderPipeline = await runtime.createRenderPipeline({
        label: 'immediate render pipeline',
        program: renderProgram,
        layout: { mode: 'explicit', bindLayouts: [ renderLayout ] },
        targets: [ { format: surface.format } ],
        immediateSize: renderCodec.byteLength(),
    })
    const computePass = runtime.createComputePass({
        label: 'immediate compute pass',
    })
    const renderPass = runtime.createRenderPass({
        label: 'immediate render pass',
        color: [
            {
                target: surface,
                load: 'clear',
                store: 'store',
                clear: [ 0.025, 0.035, 0.055, 1 ],
            },
        ],
    })

    const initializeColor = runtime.createUploadCommand({
        label: 'initialize computed color',
        target: colorBuffer.region(),
        data: new Float32Array([ 0.12, 0.24, 0.36, 1 ]),
    })
    const computeImmediate = computeCodec.uploadView({
        color: [ 0.2, 0.7, 0.9, 1 ],
    })
    const leftImmediate = renderCodec.uploadView({
        offset: [ -0.48, 0 ],
        accent: [ 1, 0.2 ],
    })
    const rightImmediate = renderCodec.uploadView({
        offset: [ 0.48, 0 ],
        accent: [ 0.7, 0.9 ],
    })
    const dispatch = runtime.createDispatchCommand({
        label: 'update immediate color',
        pipeline: computePipeline,
        immediateData: computeImmediate,
        bindSets: [ { set: computeSet } ],
        count: { workgroups: [ 1 ] },
        resources: {
            read: [
                { resource: colorBuffer, contentEpoch: 'current-at-step' },
            ],
            write: [ colorBuffer ],
        },
        whenMissing: 'throw',
    })
    const leftDraw = runtime.createDrawCommand({
        label: 'draw left immediate triangle',
        pipeline: renderPipeline,
        immediateData: leftImmediate,
        bindSets: [ { set: renderSet } ],
        count: { vertexCount: 3 },
        resources: {
            read: [
                { resource: colorBuffer, contentEpoch: 'current-at-step' },
            ],
            write: [],
        },
        whenMissing: 'throw',
    })
    const rightDraw = runtime.createDrawCommand({
        label: 'draw right immediate triangle',
        pipeline: renderPipeline,
        immediateData: rightImmediate,
        bindSets: [ { set: renderSet } ],
        count: { vertexCount: 3 },
        resources: {
            read: [
                { resource: colorBuffer, contentEpoch: 'current-at-step' },
            ],
            write: [],
        },
        whenMissing: 'throw',
    })

    const stableIds = Object.freeze({
        computePipeline: computePipeline.id,
        renderPipeline: renderPipeline.id,
        computeSet: computeSet.id,
        renderSet: renderSet.id,
        computePass: computePass.id,
        renderPass: renderPass.id,
        dispatch: dispatch.id,
        leftDraw: leftDraw.id,
        rightDraw: rightDraw.id,
    })
    let initialized = false
    let submissionCount = 0
    let observedSubmissions = 0
    let previousComputeBytes = ''
    let sourceMutationVisible = false
    let failed = false

    async function render(timestamp: number) {

        if (failed) return
        try {
            resizeGeneration = resizeSurface(surface, canvas, resizeGeneration)
            const values = updateImmediateSources(
                timestamp,
                computeCodec,
                computeImmediate,
                renderCodec,
                leftImmediate,
                rightImmediate
            )
            const currentComputeBytes = JSON.stringify([ ...computeImmediate.bytes ])
            sourceMutationVisible ||= (
                previousComputeBytes !== '' &&
                previousComputeBytes !== currentComputeBytes
            )
            previousComputeBytes = currentComputeBytes

            const builder = runtime.createSubmission({ validation: 'throw' })
            if (!initialized) builder.upload(initializeColor)
            const submitted = builder
                .compute(computePass, [ dispatch ])
                .render(renderPass, [ leftDraw, rightDraw ])
                .submit()
            initialized = true
            submissionCount++

            const producer = submitted.producerEpochs.find(epoch => (
                epoch.resourceId === colorBuffer.id &&
                epoch.producedBy.commandId === dispatch.id
            ))
            const drawReads = submitted.resourceAccesses.filter(access => (
                access.resourceId === colorBuffer.id &&
                access.access === 'read' &&
                (
                    access.commandId === leftDraw.id ||
                    access.commandId === rightDraw.id
                )
            ))
            const dependencyResolved = producer !== undefined &&
                drawReads.length === 2 &&
                drawReads.every(read => (
                    read.declaredContentEpoch === 'current-at-step' &&
                    read.contentEpochBefore === producer.contentEpoch
                ))
            const stableCommandIdentity = (
                computePipeline.id === stableIds.computePipeline &&
                renderPipeline.id === stableIds.renderPipeline &&
                computeSet.id === stableIds.computeSet &&
                renderSet.id === stableIds.renderSet &&
                computePass.id === stableIds.computePass &&
                renderPass.id === stableIds.renderPass &&
                dispatch.id === stableIds.dispatch &&
                leftDraw.id === stableIds.leftDraw &&
                rightDraw.id === stableIds.rightDraw
            )
            if (!dependencyResolved || !stableCommandIdentity) {
                throw new Error('Immediate-data persistence or dependency proof diverged.')
            }

            publishFacts({
                values,
                stableCommandIdentity,
                dependencyResolved,
                submissionCount,
                observedSubmissions,
                resizeGeneration,
                sourceMutationVisible,
            })
            await requireObservedSubmission(submitted)
            observedSubmissions++
            publishFacts({
                values,
                stableCommandIdentity,
                dependencyResolved,
                submissionCount,
                observedSubmissions,
                resizeGeneration,
                sourceMutationVisible,
            })
            if (observedSubmissions >= 2 && sourceMutationVisible) {
                canvas.dataset.status = 'ready'
            }
        } catch (error) {
            failed = true
            reportFailure(error)
            return
        }

        requestAnimationFrame(timestamp => {
            void render(timestamp)
        })
    }

    requestAnimationFrame(timestamp => {
        void render(timestamp)
    })
}

function updateImmediateSources(
    timestamp: number,
    computeLayout: typeof computeCodec,
    computeView: ReturnType<typeof computeCodec.uploadView>,
    renderLayout: typeof renderCodec,
    leftView: ReturnType<typeof renderCodec.uploadView>,
    rightView: ReturnType<typeof renderCodec.uploadView>
) {

    const phase = timestamp * 0.0015
    const color = [
        0.25 + 0.55 * (0.5 + 0.5 * Math.sin(phase)),
        0.28 + 0.48 * (0.5 + 0.5 * Math.sin(phase + 2.1)),
        0.35 + 0.52 * (0.5 + 0.5 * Math.sin(phase + 4.2)),
        1,
    ]
    const left = {
        offset: [ -0.48, 0.035 * Math.sin(phase * 0.7) ],
        accent: [ 1, 0.2 ],
    }
    const right = {
        offset: [ 0.48, -0.035 * Math.sin(phase * 0.7) ],
        accent: [ 0.7, 0.9 ],
    }
    computeLayout.write(computeView.bytes, { color })
    renderLayout.write(leftView.bytes, left)
    renderLayout.write(rightView.bytes, right)

    return Object.freeze({
        compute: color.map(roundFact),
        render: [
            {
                offset: left.offset.map(roundFact),
                accent: left.accent.map(roundFact),
            },
            {
                offset: right.offset.map(roundFact),
                accent: right.accent.map(roundFact),
            },
        ],
    })
}

function publishFacts(facts: {
    values: ReturnType<typeof updateImmediateSources>
    stableCommandIdentity: boolean
    dependencyResolved: boolean
    submissionCount: number
    observedSubmissions: number
    resizeGeneration: number
    sourceMutationVisible: boolean
}) {

    canvas.dataset.computeImmediate = JSON.stringify(facts.values.compute)
    canvas.dataset.renderImmediate = JSON.stringify(facts.values.render)
    canvas.dataset.stableCommandIdentity = String(facts.stableCommandIdentity)
    canvas.dataset.dependencyResolved = String(facts.dependencyResolved)
    canvas.dataset.submissionCount = String(facts.submissionCount)
    canvas.dataset.observedSubmissions = String(facts.observedSubmissions)
    canvas.dataset.resizeGeneration = String(facts.resizeGeneration)
    canvas.dataset.sourceMutationVisible = String(facts.sourceMutationVisible)
}

function resizeSurface(
    surface: Surface,
    target: HTMLCanvasElement,
    generation: number
): number {

    const scale = window.devicePixelRatio || 1
    const width = Math.max(1, Math.floor(target.clientWidth * scale))
    const height = Math.max(1, Math.floor(target.clientHeight * scale))
    if (surface.size.width === width && surface.size.height === height) {
        return generation
    }

    surface.resize({ width, height })
    return generation + 1
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

function roundFact(value: number): number {

    return Number(value.toFixed(4))
}

class ExampleCapabilityError extends Error {

    readonly code: string

    constructor(code: string, message: string) {

        super(message)
        this.name = 'ExampleCapabilityError'
        this.code = code
    }
}

function reportFailure(error: unknown) {

    const diagnostic = (
        typeof error === 'object' &&
        error !== null &&
        'diagnostic' in error &&
        typeof error.diagnostic === 'object' &&
        error.diagnostic !== null
    ) ? error.diagnostic as { code?: unknown, message?: unknown } : undefined
    const code = error instanceof ExampleCapabilityError
        ? error.code
        : typeof diagnostic?.code === 'string'
            ? diagnostic.code
            : 'SCRATCH_EXAMPLE_IMMEDIATE_FAILED'
    const message = error instanceof Error
        ? error.message
        : typeof diagnostic?.message === 'string'
            ? diagnostic.message
            : String(error)
    const status = error instanceof ExampleCapabilityError ? 'unsupported' : 'error'

    canvas.dataset.status = status
    canvas.dataset.errorCode = code
    canvas.dataset.errorMessage = message
    statusOutput.hidden = false
    statusOutput.textContent = `${code}: ${message}`
    console.error(error)
}
