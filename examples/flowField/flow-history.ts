import {
    GPURuntime,
    layoutCodec,
} from 'geoscratch/scratch'
import type { GeoViewSnapshot, WebMercatorQuadAddressCodec } from 'geoscratch/geo'
import type { VirtualRasterAddressSpace } from 'geoscratch/geo'
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
    SubmittedWork,
    Surface,
    SurfaceSize,
    TextureResource,
    UploadCommand,
} from 'geoscratch/scratch'
import historyShader from './shaders/history.wgsl?raw'
import historySupportShader from './shaders/history-support.wgsl?raw'
import presentationSupportShader from './shaders/presentation-support.wgsl?raw'
import hardBoundaryShader from './shaders/hard-boundary.wgsl?raw'
import presentationShader from './shaders/presentation.wgsl?raw'
import boundaryDistanceShader from './shaders/boundary-distance.wgsl?raw'
import boundaryActivityShader from './shaders/boundary-activity.wgsl?raw'
import boundarySdfShader from './shaders/boundary-sdf.wgsl?raw'
import centerDistanceShader from './shaders/boundary-center-distance.wgsl?raw'
import centerBoundaryShader from './shaders/boundary-center.wgsl?raw'
import type { FlowFieldBoundaryMode } from './flow-presentation.ts'
import { FLOW_FIELD_SDF_FEATHER, flowFieldSdfFeatherTexels } from './flow-presentation.ts'
import { flowScreenProjectionWgsl, flowScreenViewValues } from './flow-screen-projection.ts'
import type { FlowScreenViewValues } from './flow-screen-projection.ts'
import type { FlowTemporalReadyBindingFrame } from './flow-temporal-bindings.ts'
import { createFlowCenterCache } from './flow-center-cache.ts'
import type { FlowCenterCache, FlowCenterCacheFacts, FlowCenterCacheInput } from './flow-center-cache.ts'


export type FlowHistoryMode = 'off' | 'clear' | 'reproject'

export type FlowHistoryOptions = Readonly<{
    runtime: GPURuntime
    surface: Surface
    size: SurfaceSize
    temporal: Readonly<{ wgsl: string; layout: BindLayout }>
    addressCodec: WebMercatorQuadAddressCodec
    activityKill: number
    mode?: FlowHistoryMode
    trailDecay?: number
    trailCutoff?: number
    maxReprojectCenterDeltaMeters?: number
    centerCache?: Readonly<{ addressSpace: VirtualRasterAddressSpace, capacity: number }>
}>

export type FlowHistoryFrame = Readonly<{
    direction: 'B-to-A' | 'A-to-B'
    target: 'A' | 'B'
    cameraChanged: boolean
    historyValid: boolean
    cleared: boolean
    resizeGeneration: number
    /** Boundary applied to visible ink; unavailable frames reuse the last visible result. */
    boundary: FlowFieldBoundaryMode
    /** Last encoded uniform; inactive for hard/retained presentation. */
    sdfFeatherTexels: number
}>

export type FlowHistoryFacts = Readonly<{
    mode: FlowHistoryMode
    size: Readonly<{ width: number; height: number }>
    directionCount: 2
    nextDirection: 'B-to-A' | 'A-to-B'
    resizeGeneration: number
    hasPreviousView: boolean
    disposed: boolean
    /** Last applied boundary, retained across unavailable frames; not a per-pixel guarantee. */
    boundary: FlowFieldBoundaryMode
    /** Encoded B draws, not a native-completion counter. */
    sdfPresentationCount: number
    sdfExtraTextureBytes: 0
    centerCache: FlowCenterCacheFacts | undefined
    decaySteps: number
    /** Last encoded uniform, not the application's retained selection. */
    sdfFeatherTexels: number
}>

export type FlowHistory = Readonly<{
    resize(size: SurfaceSize): Promise<void>
    reset(): void
    presentRetained(builder: SubmissionBuilder, view: GeoViewSnapshot): FlowHistoryFrame
    /** Commits a derived cache only after its actual GPU build succeeds. */
    observe(submitted: SubmittedWork): Promise<void>
    encode(
        builder: SubmissionBuilder,
        view: GeoViewSnapshot,
        content: readonly DrawCommand[] | undefined,
        accumulate: boolean | undefined,
        prepared?: FlowTemporalReadyBindingFrame,
        boundary?: FlowFieldBoundaryMode,
        sdfFeatherTexels?: number,
        centerCacheInput?: FlowCenterCacheInput,
        decaySteps?: number
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
    cameraX: readonly number[]
    cameraY: readonly number[]
    cameraZ: readonly number[]
    requestedLevel: number
    progress: number
    activityKill: number
    presentationFeather: number
    decaySteps: number
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

/** Owns finite raw trails and a separately clipped visible image in two alternating textures. */
export async function createFlowHistory(options: FlowHistoryOptions): Promise<FlowHistory> {
    const runtime = options?.runtime
    const surface = options?.surface
    if (!(runtime instanceof GPURuntime) || surface?.runtime !== runtime) {
        throw new TypeError('Flow Field history requires one runtime-owned borrowed Surface')
    }
    const temporal = options.temporal
    if (temporal?.layout?.runtime !== runtime || temporal.layout.group !== 1 ||
        typeof temporal.wgsl !== 'string' || temporal.wgsl.length === 0) {
        throw new TypeError('Flow Field history requires a same-runtime temporal sampler at group 1')
    }
    const screenProjection = flowScreenProjectionWgsl(options.addressCodec)
    const activityKill = finiteNonNegative(options.activityKill, 'activityKill')
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
        activityKill,
    })
    const construction: { dispose(): void }[] = []
    function own<T extends { dispose(): void }>(resource: T): T {
        construction.push(resource)
        return resource
    }
    try {
        const centerCache = options.centerCache === undefined ? undefined : own(await createFlowCenterCache({
            runtime,temporal,activityKill,...options.centerCache,
        }))
        const uniformBytes = codec.pack(initialUniforms)
        const uniformBuffer = own(await runtime.createBuffer({
            label: 'Flow Field history uniform',
            size: uniformBytes.byteLength,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.UNIFORM,
        }))
        const uniformRegion = uniformBuffer.region({ layout: codec.artifact })
        const uniformUpload = own(runtime.createUploadCommand({
            label: 'Upload Flow Field history uniform',
            target: uniformRegion,
            data: uniformBytes,
        }))
        const sampledTargetUsage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
        const historyA = own(await runtime.createTexture({
            label: 'Flow Field history A',
            size,
            format: 'rgba8unorm',
            usage: sampledTargetUsage,
        }))
        const historyB = own(await runtime.createTexture({
            label: 'Flow Field history B',
            size,
            format: 'rgba8unorm',
            usage: sampledTargetUsage,
        }))
        const depth = own(await runtime.createTexture({
            label: 'Flow Field particle overlap depth',
            size,
            format: 'depth32float',
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        }))
        const depthAttachment = {
            target: depth.view(), depthLoad: 'clear' as const,
            depthStore: 'store' as const, depthClear: 1,
        }
        const historyAView = historyA.view({ label: 'Flow Field history A view' })
        const historyBView = historyB.view({ label: 'Flow Field history B view' })
        const uniformLayout = own(await runtime.createBindLayout({
            label: 'Flow Field history uniform layout',
            group: 0,
            entries: [ {
                binding: 0,
                name: 'cleanupUniform',
                type: 'uniform',
                visibility: [ 'vertex', 'fragment' ],
                minBindingSize: codec.byteLength(),
            } ],
        }))
        const historyLayout = own(await textureLayout(runtime, 2, 'Flow Field history source layout'))
        const presentationLayout = own(await textureLayout(runtime, 0, 'Flow Field history presentation layout'))
        const uniformSet = own(await runtime.createBindSet(uniformLayout, {
            cleanupUniform: uniformRegion,
        }, { label: 'Flow Field history uniforms' }))
        const historyBToA = own(await runtime.createBindSet(historyLayout, {
            historyTexture: historyBView,
        }, { label: 'Flow Field history B to A source' }))
        const historyAToB = own(await runtime.createBindSet(historyLayout, {
            historyTexture: historyAView,
        }, { label: 'Flow Field history A to B source' }))
        const presentationA = own(await runtime.createBindSet(presentationLayout, {
            historyTexture: historyAView,
        }, { label: 'Flow Field history A presentation' }))
        const presentationB = own(await runtime.createBindSet(presentationLayout, {
            historyTexture: historyBView,
        }, { label: 'Flow Field history B presentation' }))
        const historyModule = own(await runtime.createShaderModule({
            label: 'Flow Field history shader',
            sourceParts: [ { code: historyShader } ],
        }))
        const hardModule = own(await runtime.createShaderModule({
            label: 'Flow Field hard boundary presentation shader',
            sourceParts: [ { code: temporal.wgsl }, { code: screenProjection },
                { code: codec.wgslAccessors() }, { code: presentationSupportShader },
                { code: historySupportShader }, { code: hardBoundaryShader } ],
        }))
        const presentationModule = own(await runtime.createShaderModule({
            label: 'Flow Field history presentation shader',
            sourceParts: [ { code: presentationShader } ],
        }))
        const sdfModule = own(await runtime.createShaderModule({
            label: 'Flow Field inward SDF presentation shader',
            sourceParts: [ { code: temporal.wgsl }, { code: screenProjection },
                { code: codec.wgslAccessors() }, { code: presentationSupportShader },
                { code: boundaryDistanceShader }, { code: boundaryActivityShader },
                { code: boundarySdfShader } ],
        }))
        const centerModule = own(await runtime.createShaderModule({
            label: 'Flow Field center SDF presentation shader',
            sourceParts: [{ code: temporal.wgsl }, { code: screenProjection },
                { code: codec.wgslAccessors() }, { code: presentationSupportShader },
                { code: boundaryDistanceShader }, { code: boundaryActivityShader },
                { code: boundarySdfShader }, { code: centerDistanceShader },
                { code: centerCache ? centerBoundaryShader.replace('FlowCenter_coverage(ground.position)',
                    'FlowCenterCached_coverage(ground.position)') : centerBoundaryShader },
                ...(centerCache ? [{code:centerCache.wgsl}] : [])],
        }))
        const requirement: ProgramBufferLayoutRequirement = {
            group: 0,
            binding: 0,
            type: 'uniform',
            hasDynamicOffset: false,
            layout: codec.artifact,
        }
        const historyProgram = own(runtime.createProgram({
            label: 'Flow Field history program',
            vertex: { module: historyModule, entryPoint: 'vMain' },
            fragment: { module: historyModule, entryPoint: 'fMain' },
            layoutRequirements: [ requirement ],
        }))
        const hardProgram = own(runtime.createProgram({
            label: 'Flow Field hard boundary presentation program',
            vertex: { module: hardModule, entryPoint: 'vMain' },
            fragment: { module: hardModule, entryPoint: 'fMain' },
            layoutRequirements: [ requirement ],
        }))
        const presentationProgram = own(runtime.createProgram({
            label: 'Flow Field history presentation program',
            vertex: { module: presentationModule, entryPoint: 'vMain' },
            fragment: { module: presentationModule, entryPoint: 'fMain' },
        }))
        const sdfProgram = own(runtime.createProgram({
            label: 'Flow Field inward SDF presentation program',
            vertex: { module: sdfModule, entryPoint: 'vMain' },
            fragment: { module: sdfModule, entryPoint: 'fMain' },
            layoutRequirements: [ requirement ],
        }))
        const centerPrograms = [false, true].map(smooth => own(runtime.createProgram({
            label: `Flow Field center SDF ${smooth ? 'smooth' : 'linear'} program`,
            vertex: { module: centerModule, entryPoint: 'vMain' },
            fragment: { module: centerModule, entryPoint: 'fCenter', constants: { FLOW_CENTER_SMOOTH: smooth ? 1 : 0 } },
            layoutRequirements: [requirement],
        })))
        const historyPipeline = own(await runtime.createRenderPipeline({
            label: 'Flow Field history pipeline',
            program: historyProgram,
            layout: { mode: 'explicit', bindLayouts: [ uniformLayout, historyLayout ] },
            targets: [ { format: historyA.format } ],
            primitive: { topology: 'triangle-strip' },
            depthStencil: { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'less' },
        }))
        const hardPipeline = own(await runtime.createRenderPipeline({
            label: 'Flow Field hard boundary presentation pipeline', program: hardProgram,
            layout: { mode: 'explicit', bindLayouts: [ uniformLayout, temporal.layout, historyLayout ] },
            targets: [{ format: historyA.format }],
            primitive: { topology: 'triangle-strip' },
        }))
        const presentationPipeline = own(await runtime.createRenderPipeline({
            label: 'Flow Field history presentation pipeline',
            program: presentationProgram,
            layout: { mode: 'explicit', bindLayouts: [ presentationLayout ] },
            targets: [ { format: surface.format, blend: NORMAL_BLEND } ],
            primitive: { topology: 'triangle-strip' },
        }))
        const retainedPipeline = own(await runtime.createRenderPipeline({
            label: 'Flow Field retained visible presentation pipeline', program: historyProgram,
            layout: { mode: 'explicit', bindLayouts: [ uniformLayout, historyLayout ] },
            targets: [{ format: surface.format, blend: NORMAL_BLEND }],
            primitive: { topology: 'triangle-strip' },
        }))
        const sdfPipeline = own(await runtime.createRenderPipeline({
            label: 'Flow Field inward SDF presentation pipeline',
            program: sdfProgram,
            layout: { mode: 'explicit', bindLayouts: [ uniformLayout, temporal.layout, historyLayout ] },
            targets: [ { format: historyA.format } ],
            primitive: { topology: 'triangle-strip' },
        }))
        const centerPipelines: RenderPipeline[] = []
        for (const program of centerPrograms) centerPipelines.push(own(await runtime.createRenderPipeline({
            label: 'Flow Field center SDF presentation pipeline', program,
            layout: { mode: 'explicit', bindLayouts: [uniformLayout, temporal.layout, historyLayout,
                ...(centerCache ? [centerCache.layout] : [])] },
            targets: [{ format: historyA.format }],
            primitive: { topology: 'triangle-strip' },
        })))
        const clearPass = own(runtime.createRenderPass({
            label: 'Flow Field history clear',
            color: [
                { target: historyAView, load: 'clear', store: 'store', clear: [ 0, 0, 0, 0 ] },
                { target: historyBView, load: 'clear', store: 'store', clear: [ 0, 0, 0, 0 ] },
            ],
        }))
        const passBToA = own(runtime.createRenderPass({
            label: 'Flow Field history B to A',
            color: [ { target: historyAView, load: 'clear', store: 'store', clear: [ 0, 0, 0, 0 ] } ],
            depth: depthAttachment,
        }))
        const passAToB = own(runtime.createRenderPass({
            label: 'Flow Field history A to B',
            color: [ { target: historyBView, load: 'clear', store: 'store', clear: [ 0, 0, 0, 0 ] } ],
            depth: depthAttachment,
        }))
        const presentationPass = own(runtime.createRenderPass({
            label: 'Flow Field history presentation',
            color: [ {
                target: surface,
                load: 'clear',
                store: 'store',
                clear: [ 0, 0, 0, 0 ],
            } ],
        }))
        const visiblePasses = [
            own(runtime.createRenderPass({ label: 'Flow Field visible A',
                color: [{ target: historyAView, load: 'clear', store: 'store', clear: [0,0,0,0] }] })),
            own(runtime.createRenderPass({ label: 'Flow Field visible B',
                color: [{ target: historyBView, load: 'clear', store: 'store', clear: [0,0,0,0] }] })),
        ]
        const presentA = own(presentationCommand(
            runtime, presentationPipeline, presentationA, historyA,
            'Present Flow Field history A'
        ))
        const presentB = own(presentationCommand(
            runtime, presentationPipeline, presentationB, historyB,
            'Present Flow Field history B'
        ))
        const directionBToA: FlowHistoryDirection = Object.freeze({
            label: 'Flow Field history B to A',
            pass: passBToA,
            target: 'A',
        })
        const directionAToB: FlowHistoryDirection = Object.freeze({
            label: 'Flow Field history A to B',
            pass: passAToB,
            target: 'B',
        })
        const directions = Object.freeze([ directionBToA, directionAToB ])
        const historyCommands = [
            own(composeCommand(runtime, historyPipeline, uniformSet, historyBToA,
                uniformBuffer, historyB, undefined, 'Reproject Flow history B to A')),
            own(composeCommand(runtime, historyPipeline, uniformSet, historyAToB,
                uniformBuffer, historyA, undefined, 'Reproject Flow history A to B')),
        ]
        const retainedCommands = [
            own(composeCommand(runtime, retainedPipeline, uniformSet, historyAToB,
                uniformBuffer, historyA, undefined, 'Reproject visible Flow A to Surface')),
            own(composeCommand(runtime, retainedPipeline, uniformSet, historyBToA,
                uniformBuffer, historyB, undefined, 'Reproject visible Flow B to Surface')),
        ]
        const historyBindSets = Object.freeze([
            uniformSet, historyBToA, historyAToB, presentationA, presentationB,
        ])
        const graph: OwnedGraph = Object.freeze({
            textures: Object.freeze([ historyA, historyB, depth ]),
            uniformBuffer,
            uniformUpload,
            bindLayouts: Object.freeze([ uniformLayout, historyLayout, presentationLayout ]),
            bindSets: historyBindSets,
            shaderModules: Object.freeze([ historyModule, hardModule, presentationModule, sdfModule, centerModule ]),
            programs: Object.freeze([ historyProgram, hardProgram, presentationProgram, sdfProgram, ...centerPrograms ]),
            pipelines: Object.freeze([ historyPipeline, hardPipeline, presentationPipeline, sdfPipeline, retainedPipeline, ...centerPipelines ]),
            passes: Object.freeze([ clearPass, passBToA, passAToB, presentationPass, ...visiblePasses ]),
            commands: Object.freeze([ presentA, presentB, ...historyCommands, ...retainedCommands ]),
        })
        let presentationPair: Readonly<{
            bindSet: BindSet
            boundary: FlowFieldBoundaryMode
            commands: readonly [DrawCommand, DrawCommand]
        }> | undefined
        let boundary: FlowFieldBoundaryMode = 'hard'
        let sdfPresentationCount = 0
        let sdfFeatherTexels: number = FLOW_FIELD_SDF_FEATHER.default
        let decaySteps = 1
        let directionIndex = 0
        let resizeGeneration = 0
        let previousView: HistoryViewFacts | undefined
        // After a ready particle frame, one existing texture holds raw ink and
        // the other holds its clipped display. Only raw ink feeds the next step.
        let retainedTextureIndex: number | undefined
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
                await depth.resize(normalized)
                await prepareStaleBindSets(historyBindSets)
                size = normalized
                resizeGeneration++
                previousView = undefined
                retainedTextureIndex = undefined
                clearPending = true
            } finally {
                resizePending = false
            }
        }

        function encode(
            builder: SubmissionBuilder,
            view: GeoViewSnapshot,
            content: readonly DrawCommand[] = [],
            accumulate = true,
            prepared?: FlowTemporalReadyBindingFrame,
            requestedBoundary: FlowFieldBoundaryMode = 'hard',
            requestedFeatherTexels: number = FLOW_FIELD_SDF_FEATHER.default,
            centerCacheInput?: FlowCenterCacheInput,
            requestedDecaySteps = 1
        ): FlowHistoryFrame {
            assertActive()
            if (resizePending) throw new Error('Flow Field history cannot encode during resize')
            if (builder?.runtime !== runtime) {
                throw new TypeError('Flow Field history requires a same-runtime SubmissionBuilder')
            }
            if (prepared !== undefined && (prepared.state !== 'ready' || prepared.bindSet.runtime !== runtime)) {
                throw new TypeError('Flow Field history requires the current same-runtime temporal frame')
            }
            if (!['hard', 'sdf', 'sdf-center-linear', 'sdf-center-smooth'].includes(requestedBoundary)) {
                throw new TypeError('Flow Field history boundary must be hard, sdf, sdf-center-linear or sdf-center-smooth')
            }
            const feather = flowFieldSdfFeatherTexels(requestedFeatherTexels)
            if (!Number.isSafeInteger(requestedDecaySteps) || requestedDecaySteps < 0 || requestedDecaySteps > 3) {
                throw new RangeError('Flow history decay requires zero to three reference ticks')
            }
            if (prepared && (requestedBoundary === 'sdf-center-linear' || requestedBoundary === 'sdf-center-smooth')) {
                centerCache?.encode(builder,prepared,centerCacheInput)
            }
            // Temporal clipping owns visibility, never the next frame's raw ink.
            const presentation = prepared === undefined ? undefined
                : preparePresentationPair(prepared, requestedBoundary)[directionIndex]!
            if (presentation === undefined && presentationPair !== undefined) {
                for (const command of presentationPair.commands) command.dispose()
                presentationPair = undefined
            }
            const screenView = flowScreenViewValues(view, options.addressCodec)
            const compose = accumulate ? historyCommands[directionIndex]! : undefined
            if (!accumulate) clearPending = true
            const currentView = historyViewFacts(view)
            const cameraChanged = previousView !== undefined && !sameView(previousView, currentView)
            if (mode === 'clear' && cameraChanged) clearPending = true
            const centerDelta = previousView === undefined
                ? Infinity
                : viewCenterDelta(previousView, currentView)
            let historyValid = false
            const historyReprojecting = mode === 'reproject' && cameraChanged
            if (historyReprojecting && previousView !== undefined) {
                historyValid = sameArray(previousView.viewport, currentView.viewport) &&
                    centerDelta <= maxReprojectCenterDeltaMeters
            }
            codec.write(uniformBytes, uniformValues(previousView, currentView, {
                mode,
                trailDecay: prepared === undefined ? 1 : trailDecay,
                trailCutoff,
                historyValid,
                historyReprojecting,
                currentInverseMatrix: screenView.relativeWorldFromClip,
                activityKill,
                screenView,
                prepared,
                presentationFeather: feather,
                decaySteps: requestedDecaySteps,
            }))
            const direction = directions[directionIndex]!
            builder.upload(uniformUpload)
            const cleared = clearPending
            if (clearPending) {
                builder.render(clearPass, [])
                clearPending = false
            }
            builder.render(direction.pass, compose === undefined ? [ ...content ] : [ compose, ...content ])
            const rawIndex = direction.target === 'A' ? 0 : 1
            retainedTextureIndex = presentation === undefined ? rawIndex : 1 - rawIndex
            if (presentation !== undefined) {
                // The old raw source is consumed. Reuse it for the visible image;
                // the newly composed raw target remains intact for the next step.
                builder.render(visiblePasses[retainedTextureIndex]!, [presentation])
            }
            builder.render(presentationPass, [retainedTextureIndex === 0 ? presentA : presentB])
            boundary = prepared === undefined ? 'hard' : requestedBoundary
            sdfFeatherTexels = feather
            decaySteps = requestedDecaySteps
            if (boundary !== 'hard') sdfPresentationCount++
            previousView = currentView
            directionIndex = (directionIndex + 1) % directions.length
            return Object.freeze({
                direction: direction.target === 'A' ? 'B-to-A' : 'A-to-B',
                target: direction.target,
                cameraChanged,
                historyValid,
                cleared,
                resizeGeneration,
                boundary,
                sdfFeatherTexels,
            })
        }

        function preparePresentationPair(
            prepared: FlowTemporalReadyBindingFrame,
            boundary: FlowFieldBoundaryMode
        ): readonly [DrawCommand, DrawCommand] {
            if (presentationPair?.bindSet === prepared.bindSet && presentationPair.boundary === boundary) {
                return presentationPair.commands
            }
            const pipeline = boundary === 'sdf-center-linear' ? centerPipelines[0]!
                : boundary === 'sdf-center-smooth' ? centerPipelines[1]!
                : boundary === 'sdf' ? sdfPipeline : hardPipeline
            const cache = boundary === 'sdf-center-linear' || boundary === 'sdf-center-smooth' ? centerCache : undefined
            // Presentation reads the newly composed target, opposite to history's source.
            const presentA = composeCommand(runtime, pipeline, uniformSet, historyAToB,
                uniformBuffer, historyA, prepared, `Present Flow Field ${boundary} A`, cache)
            let presentB: DrawCommand
            try {
                presentB = composeCommand(runtime, pipeline, uniformSet, historyBToA,
                    uniformBuffer, historyB, prepared, `Present Flow Field ${boundary} B`, cache)
            } catch (error) {
                presentA.dispose()
                throw error
            }
            const previous = presentationPair
            presentationPair = Object.freeze({
                bindSet: prepared.bindSet,
                boundary,
                commands: Object.freeze([ presentA, presentB ]) as readonly [DrawCommand, DrawCommand],
            })
            // The renderer admits one native frame at a time and holds the borrowed
            // temporal frame until submission settles. Only our commands retire here.
            for (const command of previous?.commands ?? []) command.dispose()
            return presentationPair.commands
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
                boundary,
                sdfPresentationCount,
                sdfExtraTextureBytes: 0,
                sdfFeatherTexels,
                centerCache: centerCache?.facts(),
                decaySteps,
            })
        }

        function dispose(): void {
            if (disposed) return
            disposed = true
            for (const command of presentationPair?.commands ?? []) command.dispose()
            presentationPair = undefined
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
            centerCache?.dispose()
            previousView = undefined
            retainedTextureIndex = undefined
        }

        function assertActive(): void {
            if (disposed) throw new Error('Flow Field history is disposed')
        }

        function reset(): void {
            assertActive()
            previousView = undefined
            retainedTextureIndex = undefined
            clearPending = true
        }

        function presentRetained(builder: SubmissionBuilder, view: GeoViewSnapshot): FlowHistoryFrame {
            assertActive()
            if (resizePending) throw new Error('Flow Field history cannot encode during resize')
            if (builder?.runtime !== runtime) {
                throw new TypeError('Flow Field history requires a same-runtime SubmissionBuilder')
            }
            for (const command of presentationPair?.commands ?? []) command.dispose()
            presentationPair = undefined
            const currentView = historyViewFacts(view)
            const cameraChanged = previousView !== undefined && !sameView(previousView, currentView)
            const reprojecting = mode === 'reproject' && cameraChanged
            const valid = previousView !== undefined && sameArray(previousView.viewport, currentView.viewport) &&
                viewCenterDelta(previousView, currentView) <= maxReprojectCenterDeltaMeters
            const screenView = flowScreenViewValues(view, options.addressCodec)
            codec.write(uniformBytes, uniformValues(previousView, currentView, {
                mode, trailDecay: 1, trailCutoff, historyValid: valid, historyReprojecting: reprojecting,
                currentInverseMatrix: screenView.relativeWorldFromClip, activityKill, screenView,
                prepared: undefined, presentationFeather: sdfFeatherTexels,
                decaySteps: 0,
            }))
            builder.upload(uniformUpload)
            const display = retainedTextureIndex === undefined || clearPending || (mode === 'clear' && cameraChanged)
                ? undefined : retainedCommands[retainedTextureIndex]
            decaySteps = 0
            builder.render(presentationPass, display === undefined ? [] : [display])
            // No temporal lease, raw/display mutation, direction flip or change
            // of reference camera. Every unavailable frame gathers the last
            // actually visible image; hidden raw ink cannot reappear on loading.
            return Object.freeze({ direction: directionIndex === 0 ? 'B-to-A' : 'A-to-B',
                target: directionIndex === 0 ? 'A' : 'B', cameraChanged, historyValid: valid,
                cleared: display === undefined, resizeGeneration, boundary, sdfFeatherTexels })
        }

        return Object.freeze({ resize, reset, encode, presentRetained, facts, dispose,
            observe: (submitted: SubmittedWork) => centerCache?.observe(submitted) ?? Promise.resolve() })
    } catch (error) {
        const failures: unknown[] = [ error ]
        for (const resource of construction.reverse()) {
            try { resource.dispose() } catch (cleanupError) { failures.push(cleanupError) }
        }
        if (failures.length > 1) {
            throw new AggregateError(failures, 'Flow Field history construction and cleanup failed')
        }
        throw error
    }
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
        { name: 'cameraX', type: 'vec2u' },
        { name: 'cameraY', type: 'vec2u' },
        { name: 'cameraZ', type: 'vec2f' },
        { name: 'requestedLevel', type: 'u32' },
        { name: 'progress', type: 'f32' },
        { name: 'activityKill', type: 'f32' },
        { name: 'presentationFeather', type: 'f32' },
        { name: 'decaySteps', type: 'u32' },
    ]
    return layoutCodec({ name: 'FlowFieldHistoryUniform', fields }, { usage: [ 'uniform' ] })
}

async function textureLayout(runtime: GPURuntime, group: number, label: string) {
    return await runtime.createBindLayout({
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
    prepared: FlowTemporalReadyBindingFrame | undefined,
    label: string,
    centerCache?: FlowCenterCache
): DrawCommand {
    return runtime.createDrawCommand({
        label,
        pipeline,
        bindSets: [ { set: uniformSet }, ...(prepared ? [{set: prepared.bindSet}] : []), { set: historySet },
            ...(centerCache ? [{set:centerCache.bindSet}] : []) ],
        count: { vertexCount: 4 },
        resources: {
            read: [
                { resource: uniformBuffer, contentEpoch: 'current-at-step' },
                { resource: source, contentEpoch: 'current-at-step' },
                ...Array.from(new Set(prepared?.resources ?? []), resource => ({
                    resource, contentEpoch: 'current-at-step' as const,
                })),
                ...(centerCache?.resources ?? []).map(resource=>({resource,contentEpoch:'current-at-step' as const})),
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
        activityKill: number
        screenView?: FlowScreenViewValues
        prepared?: FlowTemporalReadyBindingFrame
        presentationFeather?: number
        decaySteps?: number
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
        cameraX: options.screenView?.cameraX ?? [ 0, 0 ],
        cameraY: options.screenView?.cameraY ?? [ 0, 0 ],
        cameraZ: options.screenView?.cameraZ ?? [ 0, 0 ],
        requestedLevel: options.prepared?.requestedLevel ?? 0,
        progress: options.prepared?.progress ?? 0,
        activityKill: options.activityKill,
        presentationFeather: options.presentationFeather ?? FLOW_FIELD_SDF_FEATHER.default,
        decaySteps: options.decaySteps ?? 1,
    }
}

function historyModeValue(mode: FlowHistoryMode): number {
    switch (mode) {
        case 'off': return 0
        case 'clear': return 1
        case 'reproject': return 2
    }
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
