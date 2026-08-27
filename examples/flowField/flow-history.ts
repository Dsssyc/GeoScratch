import {
    GPURuntime,
    layoutCodec,
} from 'geoscratch/scratch'
import type { GeoViewSnapshot } from 'geoscratch/geo'
import type {
    BindLayout,
    BindSet,
    BufferResource,
    DrawCommand,
    LayoutCodec,
    LayoutFixedFieldDescriptor,
    Program,
    ProgramBufferLayoutRequirement,
    RenderPassSpec,
    RenderPipeline,
    ShaderModule,
    SubmissionBuilder,
    Surface,
    SurfaceSize,
    TextureResource,
    UploadCommand,
} from 'geoscratch/scratch'
import { mat4 } from 'wgpu-matrix'
import historyShader from './shaders/history.wgsl?raw'
import presentationShader from './shaders/presentation.wgsl?raw'


export type FlowHistoryMode = 'off' | 'clear' | 'reproject'

export type FlowHistoryOptions = Readonly<{
    runtime: GPURuntime
    surface: Surface
    size: SurfaceSize
    mode?: FlowHistoryMode
    trailDecay?: number
    trailCutoff?: number
    maxReprojectCenterDeltaMeters?: number
}>

export type FlowHistoryFrame = Readonly<{
    direction: 'B-to-A' | 'A-to-B'
    target: 'A' | 'B'
    cameraChanged: boolean
    historyValid: boolean
    cleared: boolean
    resizeGeneration: number
}>

export type FlowHistoryFacts = Readonly<{
    mode: FlowHistoryMode
    size: Readonly<{ width: number; height: number }>
    directionCount: 2
    nextDirection: 'B-to-A' | 'A-to-B'
    resizeGeneration: number
    hasPreviousView: boolean
    disposed: boolean
}>

export type FlowHistory = Readonly<{
    resize(size: SurfaceSize): Promise<void>
    encode(
        builder: SubmissionBuilder,
        view: GeoViewSnapshot,
        content?: readonly DrawCommand[]
    ): FlowHistoryFrame
    facts(): FlowHistoryFacts
    dispose(): void
}>

type HistoryUniformValues = {
    trailDecay: number
    trailCutoff: number
    historyMode: number
    historyValid: number
    historyReprojecting: number
    previousMatrix: readonly number[]
    currentMatrix: readonly number[]
    currentInverseMatrix: readonly number[]
    previousCenterHigh: readonly number[]
    previousCenterLow: readonly number[]
    currentCenterHigh: readonly number[]
    currentCenterLow: readonly number[]
    previousViewport: readonly number[]
    currentViewport: readonly number[]
}

type HistoryViewFacts = Readonly<{
    matrix: readonly number[]
    centerHigh: readonly number[]
    centerLow: readonly number[]
    viewport: readonly number[]
}>

type FlowHistoryDirection = Readonly<{
    label: string
    pass: RenderPassSpec
    compose: DrawCommand
    presentation: DrawCommand
    target: 'A' | 'B'
}>

type OwnedGraph = Readonly<{
    textures: readonly TextureResource[]
    uniformBuffer: BufferResource
    uniformUpload: UploadCommand
    bindLayouts: readonly BindLayout[]
    bindSets: readonly BindSet[]
    shaderModules: readonly ShaderModule[]
    programs: readonly Program[]
    pipelines: readonly RenderPipeline[]
    passes: readonly RenderPassSpec[]
    commands: readonly DrawCommand[]
}>

const IDENTITY_MATRIX = Object.freeze([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
])
const NORMAL_BLEND: Readonly<GPUBlendState> = Object.freeze({
    color: {
        operation: 'add' as const,
        srcFactor: 'src-alpha' as const,
        dstFactor: 'one-minus-src-alpha' as const,
    },
    alpha: {
        operation: 'add' as const,
        srcFactor: 'one' as const,
        dstFactor: 'one-minus-src-alpha' as const,
    },
})

/** Creates an example-owned, two-direction viewport trail history. */
export async function createFlowHistory(options: FlowHistoryOptions): Promise<FlowHistory> {
    const runtime = options?.runtime
    const surface = options?.surface
    if (!(runtime instanceof GPURuntime) || surface?.runtime !== runtime) {
        throw new TypeError('Flow Field history requires one runtime-owned borrowed Surface')
    }
    let size = historySize(options.size)
    const mode = options.mode ?? 'reproject'
    if (mode !== 'off' && mode !== 'clear' && mode !== 'reproject') {
        throw new TypeError('Flow Field history mode must be off, clear, or reproject')
    }
    const trailDecay = unitInterval(options.trailDecay ?? 0.996, 'trailDecay')
    const trailCutoff = unitInterval(options.trailCutoff ?? 1 / 255, 'trailCutoff')
    const maxReprojectCenterDeltaMeters = finiteNonNegative(
        options.maxReprojectCenterDeltaMeters ?? 10_018_754.171394622,
        'maxReprojectCenterDeltaMeters'
    )
    const codec = historyUniformCodec()
    const initialUniforms = uniformValues(undefined, undefined, {
        mode,
        trailDecay,
        trailCutoff,
        historyValid: false,
        historyReprojecting: false,
    })
    const uniformBytes = codec.pack(initialUniforms)
    const uniformBuffer = await runtime.createBuffer({
        label: 'Flow Field history uniform',
        size: uniformBytes.byteLength,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.UNIFORM,
    })
    const uniformRegion = uniformBuffer.region({ layout: codec.artifact })
    const uniformUpload = runtime.createUploadCommand({
        label: 'Upload Flow Field history uniform',
        target: uniformRegion,
        data: uniformBytes,
    })
    const sampledTargetUsage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    const historyA = await runtime.createTexture({
        label: 'Flow Field history A',
        size,
        format: 'rgba8unorm',
        usage: sampledTargetUsage,
    })
    const historyB = await runtime.createTexture({
        label: 'Flow Field history B',
        size,
        format: 'rgba8unorm',
        usage: sampledTargetUsage,
    })
    const historyAView = historyA.view({ label: 'Flow Field history A view' })
    const historyBView = historyB.view({ label: 'Flow Field history B view' })
    const uniformLayout = await runtime.createBindLayout({
        label: 'Flow Field history uniform layout',
        group: 0,
        entries: [ {
            binding: 0,
            name: 'cleanupUniform',
            type: 'uniform',
            visibility: [ 'vertex', 'fragment' ],
            minBindingSize: codec.byteLength(),
        } ],
    })
    const historyLayout = await textureLayout(runtime, 1, 'Flow Field history source layout')
    const presentationLayout = await textureLayout(runtime, 0, 'Flow Field history presentation layout')
    const uniformSet = await runtime.createBindSet(uniformLayout, {
        cleanupUniform: uniformRegion,
    }, { label: 'Flow Field history uniforms' })
    const historyBToA = await runtime.createBindSet(historyLayout, {
        historyTexture: historyBView,
    }, { label: 'Flow Field history B to A source' })
    const historyAToB = await runtime.createBindSet(historyLayout, {
        historyTexture: historyAView,
    }, { label: 'Flow Field history A to B source' })
    const presentationA = await runtime.createBindSet(presentationLayout, {
        historyTexture: historyAView,
    }, { label: 'Flow Field history A presentation' })
    const presentationB = await runtime.createBindSet(presentationLayout, {
        historyTexture: historyBView,
    }, { label: 'Flow Field history B presentation' })
    const historyModule = await runtime.createShaderModule({
        label: 'Flow Field history shader',
        sourceParts: [ { code: historyShader } ],
    })
    const presentationModule = await runtime.createShaderModule({
        label: 'Flow Field history presentation shader',
        sourceParts: [ { code: presentationShader } ],
    })
    const requirement: ProgramBufferLayoutRequirement = {
        group: 0,
        binding: 0,
        type: 'uniform',
        hasDynamicOffset: false,
        layout: codec.artifact,
    }
    const historyProgram = runtime.createProgram({
        label: 'Flow Field history program',
        vertex: { module: historyModule, entryPoint: 'vMain' },
        fragment: { module: historyModule, entryPoint: 'fMain' },
        layoutRequirements: [ requirement ],
    })
    const presentationProgram = runtime.createProgram({
        label: 'Flow Field history presentation program',
        vertex: { module: presentationModule, entryPoint: 'vMain' },
        fragment: { module: presentationModule, entryPoint: 'fMain' },
    })
    const historyPipeline = await runtime.createRenderPipeline({
        label: 'Flow Field history pipeline',
        program: historyProgram,
        layout: { mode: 'explicit', bindLayouts: [ uniformLayout, historyLayout ] },
        targets: [ { format: historyA.format } ],
        primitive: { topology: 'triangle-strip' },
    })
    const presentationPipeline = await runtime.createRenderPipeline({
        label: 'Flow Field history presentation pipeline',
        program: presentationProgram,
        layout: { mode: 'explicit', bindLayouts: [ presentationLayout ] },
        targets: [ { format: surface.format, blend: NORMAL_BLEND } ],
        primitive: { topology: 'triangle-strip' },
    })
    const clearPass = runtime.createRenderPass({
        label: 'Flow Field history clear',
        color: [
            { target: historyAView, load: 'clear', store: 'store', clear: [ 0, 0, 0, 0 ] },
            { target: historyBView, load: 'clear', store: 'store', clear: [ 0, 0, 0, 0 ] },
        ],
    })
    const passBToA = runtime.createRenderPass({
        label: 'Flow Field history B to A',
        color: [ { target: historyAView, load: 'clear', store: 'store', clear: [ 0, 0, 0, 0 ] } ],
    })
    const passAToB = runtime.createRenderPass({
        label: 'Flow Field history A to B',
        color: [ { target: historyBView, load: 'clear', store: 'store', clear: [ 0, 0, 0, 0 ] } ],
    })
    const presentationPass = runtime.createRenderPass({
        label: 'Flow Field history presentation',
        color: [ { target: surface, load: 'load', store: 'store' } ],
    })
    const composeBToA = composeCommand(
        runtime, historyPipeline, uniformSet, historyBToA, uniformBuffer, historyB,
        'Compose Flow Field history B to A'
    )
    const composeAToB = composeCommand(
        runtime, historyPipeline, uniformSet, historyAToB, uniformBuffer, historyA,
        'Compose Flow Field history A to B'
    )
    const presentA = presentationCommand(
        runtime, presentationPipeline, presentationA, historyA,
        'Present Flow Field history A'
    )
    const presentB = presentationCommand(
        runtime, presentationPipeline, presentationB, historyB,
        'Present Flow Field history B'
    )
    const directionBToA: FlowHistoryDirection = Object.freeze({
        label: 'Flow Field history B to A',
        pass: passBToA,
        compose: composeBToA,
        presentation: presentA,
        target: 'A',
    })
    const directionAToB: FlowHistoryDirection = Object.freeze({
        label: 'Flow Field history A to B',
        pass: passAToB,
        compose: composeAToB,
        presentation: presentB,
        target: 'B',
    })
    const directions = Object.freeze([ directionBToA, directionAToB ])
    const historyBindSets = Object.freeze([
        uniformSet, historyBToA, historyAToB, presentationA, presentationB,
    ])
    const graph: OwnedGraph = Object.freeze({
        textures: Object.freeze([ historyA, historyB ]),
        uniformBuffer,
        uniformUpload,
        bindLayouts: Object.freeze([ uniformLayout, historyLayout, presentationLayout ]),
        bindSets: historyBindSets,
        shaderModules: Object.freeze([ historyModule, presentationModule ]),
        programs: Object.freeze([ historyProgram, presentationProgram ]),
        pipelines: Object.freeze([ historyPipeline, presentationPipeline ]),
        passes: Object.freeze([ clearPass, passBToA, passAToB, presentationPass ]),
        commands: Object.freeze([ composeBToA, composeAToB, presentA, presentB ]),
    })
    let directionIndex = 0
    let resizeGeneration = 0
    let previousView: HistoryViewFacts | undefined
    let clearPending = true
    let resizePending = false
    let disposed = false

    async function resize(nextSize: SurfaceSize): Promise<void> {
        assertActive()
        if (resizePending) throw new Error('Flow Field history resize is already pending')
        const normalized = historySize(nextSize)
        if (normalized.width === size.width && normalized.height === size.height) return
        resizePending = true
        try {
            await historyA.resize(normalized)
            await historyB.resize(normalized)
            await prepareStaleBindSets(historyBindSets)
            size = normalized
            resizeGeneration++
            previousView = undefined
            clearPending = true
        } finally {
            resizePending = false
        }
    }

    function encode(
        builder: SubmissionBuilder,
        view: GeoViewSnapshot,
        content: readonly DrawCommand[] = []
    ): FlowHistoryFrame {
        assertActive()
        if (resizePending) throw new Error('Flow Field history cannot encode during resize')
        if (builder?.runtime !== runtime) {
            throw new TypeError('Flow Field history requires a same-runtime SubmissionBuilder')
        }
        const currentView = historyViewFacts(view)
        const cameraChanged = previousView !== undefined && !sameView(previousView, currentView)
        if (mode === 'clear' && cameraChanged) clearPending = true
        const currentInverse = inverseOrIdentity(currentView.matrix)
        const centerDelta = previousView === undefined
            ? Infinity
            : viewCenterDelta(previousView, currentView)
        let historyValid = false
        const historyReprojecting = mode === 'reproject' && cameraChanged
        if (historyReprojecting && previousView !== undefined) {
            historyValid = sameArray(previousView.viewport, currentView.viewport) &&
                currentInverse.valid && centerDelta <= maxReprojectCenterDeltaMeters
        }
        codec.write(uniformBytes, uniformValues(previousView, currentView, {
            mode,
            trailDecay,
            trailCutoff,
            historyValid,
            historyReprojecting,
            currentInverseMatrix: currentInverse.matrix,
        }))
        const direction = directions[directionIndex]!
        builder.upload(uniformUpload)
        const cleared = clearPending
        if (clearPending) {
            builder.render(clearPass, [])
            clearPending = false
        }
        builder.render(direction.pass, [ direction.compose, ...content ])
        builder.render(presentationPass, [ direction.presentation ])
        previousView = currentView
        directionIndex = (directionIndex + 1) % directions.length
        return Object.freeze({
            direction: direction.target === 'A' ? 'B-to-A' : 'A-to-B',
            target: direction.target,
            cameraChanged,
            historyValid,
            cleared,
            resizeGeneration,
        })
    }

    function facts(): FlowHistoryFacts {
        return Object.freeze({
            mode,
            size: Object.freeze({ ...size }),
            directionCount: 2,
            nextDirection: directionIndex === 0 ? 'B-to-A' : 'A-to-B',
            resizeGeneration,
            hasPreviousView: previousView !== undefined,
            disposed,
        })
    }

    function dispose(): void {
        if (disposed) return
        disposed = true
        for (const command of graph.commands) command.dispose()
        graph.uniformUpload.dispose()
        for (const pass of graph.passes) pass.dispose()
        for (const pipeline of graph.pipelines) pipeline.dispose()
        for (const program of graph.programs) program.dispose()
        for (const shaderModule of graph.shaderModules) shaderModule.dispose()
        for (const bindSet of graph.bindSets) bindSet.dispose()
        for (const bindLayout of graph.bindLayouts) bindLayout.dispose()
        graph.uniformBuffer.dispose()
        for (const texture of graph.textures) texture.dispose()
        previousView = undefined
    }

    function assertActive(): void {
        if (disposed) throw new Error('Flow Field history is disposed')
    }

    return Object.freeze({ resize, encode, facts, dispose })
}

function historyUniformCodec(): LayoutCodec {
    const fields: LayoutFixedFieldDescriptor[] = [
        { name: 'trailDecay', type: 'f32' },
        { name: 'trailCutoff', type: 'f32' },
        { name: 'historyMode', type: 'f32' },
        { name: 'historyValid', type: 'f32' },
        { name: 'historyReprojecting', type: 'f32' },
        { name: 'previousMatrix', type: 'mat4x4f' },
        { name: 'currentMatrix', type: 'mat4x4f' },
        { name: 'currentInverseMatrix', type: 'mat4x4f' },
        { name: 'previousCenterHigh', type: 'vec3f' },
        { name: 'previousCenterLow', type: 'vec3f' },
        { name: 'currentCenterHigh', type: 'vec3f' },
        { name: 'currentCenterLow', type: 'vec3f' },
        { name: 'previousViewport', type: 'vec2f' },
        { name: 'currentViewport', type: 'vec2f' },
    ]
    return layoutCodec({ name: 'FlowFieldHistoryUniform', fields }, { usage: [ 'uniform' ] })
}

async function textureLayout(runtime: GPURuntime, group: number, label: string) {
    return runtime.createBindLayout({
        label,
        group,
        entries: [ {
            binding: 0,
            name: 'historyTexture',
            type: 'texture',
            visibility: [ 'fragment' ],
            sampleType: 'float',
            viewDimension: '2d',
        } ],
    })
}

function composeCommand(
    runtime: GPURuntime,
    pipeline: RenderPipeline,
    uniformSet: BindSet,
    historySet: BindSet,
    uniformBuffer: BufferResource,
    source: TextureResource,
    label: string
): DrawCommand {
    return runtime.createDrawCommand({
        label,
        pipeline,
        bindSets: [ { set: uniformSet }, { set: historySet } ],
        count: { vertexCount: 4 },
        resources: {
            read: [
                { resource: uniformBuffer, contentEpoch: 'current-at-step' },
                { resource: source, contentEpoch: 'current-at-step' },
            ],
            write: [],
        },
        whenMissing: 'throw',
    })
}

function presentationCommand(
    runtime: GPURuntime,
    pipeline: RenderPipeline,
    bindSet: BindSet,
    source: TextureResource,
    label: string
): DrawCommand {
    return runtime.createDrawCommand({
        label,
        pipeline,
        bindSets: [ { set: bindSet } ],
        count: { vertexCount: 4 },
        resources: {
            read: [ { resource: source, contentEpoch: 'current-at-step' } ],
            write: [],
        },
        whenMissing: 'throw',
    })
}

async function prepareStaleBindSets(bindSets: readonly BindSet[]): Promise<void> {
    for (const bindSet of bindSets) {
        if (bindSet.preparationState === 'stale') await bindSet.prepare()
    }
}

function historyViewFacts(view: GeoViewSnapshot): HistoryViewFacts {
    if (view?.kind !== 'geo-view-snapshot' || !finiteArray(view.clipFromRelativeWorld, 16) ||
        !finiteArray(view.cameraHigh, 3) || !finiteArray(view.cameraLow, 3) ||
        !finiteArray(view.referenceViewport, 2) || view.referenceViewport.some(value => value <= 0)) {
        throw new TypeError('Flow Field history requires a finite GeoViewSnapshot')
    }
    return Object.freeze({
        matrix: Object.freeze([ ...view.clipFromRelativeWorld ]),
        centerHigh: Object.freeze([ ...view.cameraHigh ]),
        centerLow: Object.freeze([ ...view.cameraLow ]),
        viewport: Object.freeze([ ...view.referenceViewport ]),
    })
}

function uniformValues(
    previous: HistoryViewFacts | undefined,
    current: HistoryViewFacts | undefined,
    options: Readonly<{
        mode: FlowHistoryMode
        trailDecay: number
        trailCutoff: number
        historyValid: boolean
        historyReprojecting: boolean
        currentInverseMatrix?: readonly number[]
    }>
): HistoryUniformValues {
    const currentView = current ?? {
        matrix: IDENTITY_MATRIX,
        centerHigh: [ 0, 0, 0 ],
        centerLow: [ 0, 0, 0 ],
        viewport: [ 1, 1 ],
    }
    const previousView = previous ?? currentView
    return {
        trailDecay: options.trailDecay,
        trailCutoff: options.trailCutoff,
        historyMode: historyModeValue(options.mode),
        historyValid: options.historyValid ? 1 : 0,
        historyReprojecting: options.historyReprojecting ? 1 : 0,
        previousMatrix: previousView.matrix,
        currentMatrix: currentView.matrix,
        currentInverseMatrix: options.currentInverseMatrix ?? IDENTITY_MATRIX,
        previousCenterHigh: previousView.centerHigh,
        previousCenterLow: previousView.centerLow,
        currentCenterHigh: currentView.centerHigh,
        currentCenterLow: currentView.centerLow,
        previousViewport: previousView.viewport,
        currentViewport: currentView.viewport,
    }
}

function historyModeValue(mode: FlowHistoryMode): number {
    switch (mode) {
        case 'off': return 0
        case 'clear': return 1
        case 'reproject': return 2
    }
}

function inverseOrIdentity(matrix: readonly number[]): Readonly<{
    matrix: readonly number[]
    valid: boolean
}> {
    const inverse = Array.from(mat4.inverse(Array.from(matrix)))
    const valid = finiteArray(inverse, 16)
    return Object.freeze({ matrix: valid ? inverse : IDENTITY_MATRIX, valid })
}

function sameView(first: HistoryViewFacts, second: HistoryViewFacts): boolean {
    return sameArray(first.matrix, second.matrix) &&
        sameArray(first.centerHigh, second.centerHigh) &&
        sameArray(first.centerLow, second.centerLow) &&
        sameArray(first.viewport, second.viewport)
}

function viewCenterDelta(first: HistoryViewFacts, second: HistoryViewFacts): number {
    const firstX = first.centerHigh[0]! + first.centerLow[0]!
    const firstY = first.centerHigh[1]! + first.centerLow[1]!
    const secondX = second.centerHigh[0]! + second.centerLow[0]!
    const secondY = second.centerHigh[1]! + second.centerLow[1]!
    return Math.hypot(secondX - firstX, secondY - firstY)
}

function sameArray(first: readonly number[], second: readonly number[]): boolean {
    return first.length === second.length && first.every((value, index) => value === second[index])
}

function finiteArray(value: ArrayLike<number>, length: number): boolean {
    return value.length === length && Array.from(value).every(Number.isFinite)
}

function historySize(value: SurfaceSize): { width: number; height: number } {
    if (!Number.isSafeInteger(value?.width) || value.width <= 0 ||
        !Number.isSafeInteger(value?.height) || value.height <= 0) {
        throw new RangeError('Flow Field history size must contain positive integer dimensions')
    }
    return { width: value.width, height: value.height }
}

function unitInterval(value: number, name: string): number {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw new RangeError(`Flow Field history ${name} must be finite within [0, 1]`)
    }
    return value
}

function finiteNonNegative(value: number, name: string): number {
    if (!Number.isFinite(value) || value < 0) {
        throw new RangeError(`Flow Field history ${name} must be finite and non-negative`)
    }
    return value
}
