import type {
    GeoFrameResult,
    GeoFrameSettlement,
    GeoViewSnapshot,
    GeoViewSourceCapture,
    MapLibrePlanarCameraState,
    VirtualRasterRuntimePublication,
    VirtualRasterFeedbackReconciliation,
} from 'geoscratch/geo'
import {
    gpuWebMercatorQuadCoverPolicy,
} from 'geoscratch/geo'
import type {
    GPURuntime,
    SubmissionBuilder,
    SubmittedWork,
    Surface,
    SurfaceSize,
} from 'geoscratch/scratch'
import particleSimulationShader from './shaders/particle-simulation.compute.wgsl?raw'
import {
    packFlowCandidateCells,
} from './flow-candidate-packing.ts'
import {
    createFlowContour,
} from './flow-contour.ts'
import type {
    FlowContour,
} from './flow-contour.ts'
import {
    createFlowDemandCoordinator,
} from './flow-demand.ts'
import type {
    FlowDemandCoordinator,
    FlowDemandFrame,
    FlowDemandReconciliations,
} from './flow-demand.ts'
import {
    createFlowHistory,
} from './flow-history.ts'
import type {
    FlowHistory,
    FlowHistoryContent,
    FlowHistoryFrame,
} from './flow-history.ts'
import {
    assertFlowTemporalCapture,
    flowTemporalFrameSnapshot,
} from './flow-frame-provenance.ts'
import type {
    FlowTemporalFrameSnapshot,
} from './flow-frame-provenance.ts'
import {
    flowActivityThresholds,
} from './flow-particle-policy.ts'
import {
    createFlowParticleRender,
} from './flow-particle-render.ts'
import type {
    FlowParticleRender,
} from './flow-particle-render.ts'
import {
    createFlowParticles,
    prepareFlowParticleSpawnBindings,
} from './flow-particles.ts'
import type {
    FlowParticles,
    PreparedFlowParticleSpawnBindings,
} from './flow-particles.ts'
import {
    createFlowRenderView,
} from './flow-render-view.ts'
import type {
    FlowRenderView,
} from './flow-render-view.ts'
import {
    createFlowSpawnIndex,
    prepareFlowSpawnCandidates,
} from './flow-spawn-index.ts'
import type {
    FlowSpawnIndex,
    FlowSpawnCandidates,
} from './flow-spawn-index.ts'
import {
    FlowTemporalBindingSupersededError,
    createFlowTemporalBindings,
} from './flow-temporal-bindings.ts'
import type {
    FlowTemporalBindings,
    FlowTemporalReadyBindingFrame,
} from './flow-temporal-bindings.ts'
import type {
    FlowTemporalReadyCapture,
    FlowTemporalRuntimeWindow,
    FlowTemporalPrefetchCapture,
} from './flow-temporal-runtime-window.ts'
import type {
    FlowTimelineSnapshot,
} from './flow-timeline.ts'
import {
    createFlowViewDemandAdapter,
} from './flow-view-demand.ts'
import type {
    FlowViewDemandAdapter,
} from './flow-view-demand.ts'
import {
    flowFieldViewAdapter,
} from './map.ts'
import type {
    FlowVelocitySampleRuntime,
} from './velocity-source.ts'
import { FLOW_FIELD_PRESENTATION, flowFieldPresentation } from './flow-presentation.ts'
import type { FlowFieldPresentation } from './flow-presentation.ts'
import { FLOW_CENTER_CACHE_MAX_PAGES } from './flow-center-cache-plan.ts'
import { createFlowVisualClock } from './flow-visual-clock.ts'
import type { FlowVisualTime } from './flow-visual-clock.ts'
import { createFlowScreenInspector } from './flow-screen-inspector.ts'
import { flowPairViewReady, flowRuntimeViewReady } from './flow-pair-presentation.ts'

export type FlowFieldRendererOptions = Readonly<{
    runtime: GPURuntime
    surface: Surface
    size: SurfaceSize
    temporalWindow: FlowTemporalRuntimeWindow<FlowVelocitySampleRuntime>
    maximumSpeed: number
    presentation?: FlowFieldPresentation
    cellsPerPageEdge?: number
    particleCount?: number
}>

export type FlowFieldRendererFrame = Readonly<{
    state: 'rendered'
    submitted: SubmittedWork
    view: GeoViewSnapshot
    temporal: FlowTemporalFrameSnapshot
    demand: FlowDemandFrame
    history: FlowHistoryFrame | undefined
    presentationReady: boolean
    /** Local particle work may proceed while full-view presentation remains incomplete. */
    particlesAdvancing: boolean
    visualTime: FlowVisualTime
}>

export type FlowFieldRendererFacts = Readonly<{
    initialized: boolean
    disposed: boolean
    frameCount: number
    cellsPerPageEdge: number
    maximumCandidatePages: number
    maximumCandidateCount: number
    maximumSpeed: number
    visualTime: FlowVisualTime
    temporalWindow: ReturnType<FlowTemporalRuntimeWindow<FlowVelocitySampleRuntime>['snapshot']>
    temporal: ReturnType<FlowTemporalBindings['facts']>
    viewDemand: ReturnType<FlowViewDemandAdapter['facts']>
    spawn: ReturnType<FlowSpawnIndex['facts']>
    particles: ReturnType<FlowParticles['facts']>
    contour: ReturnType<FlowContour['facts']>
    history: ReturnType<FlowHistory['facts']>
    prefetch: Readonly<{ sampleKey: string, requestedPages: number, pagesResident: boolean }> | undefined
}>

export type FlowFieldRenderer = Readonly<{
    render(
        frameNumber: number,
        capture: GeoViewSourceCapture<MapLibrePlanarCameraState>,
        timeline: FlowTimelineSnapshot,
        wallTime: number
    ): Promise<GeoFrameResult<FlowFieldRendererFrame>>
    suspendTemporal(): Promise<void>
    presentRetained(
        frameNumber: number,
        capture: GeoViewSourceCapture<MapLibrePlanarCameraState>
    ): Promise<GeoFrameResult<undefined>>
    setPresentation(presentation: FlowFieldPresentation): void
    resetVisuals(): void
    /** Reanchors animation time without clearing the currently visible image. */
    resetVisualClock(): void
    flushResidency(): Promise<void>
    facts(): FlowFieldRendererFacts
    dispose(): Promise<void>
}>

type FlowFramePublication = Readonly<{
    runtime: FlowVelocitySampleRuntime
    publication: VirtualRasterRuntimePublication
}>

type FlowFramePublications = readonly FlowFramePublication[]

type Disposable = Readonly<{ dispose(): void | Promise<void> }>

const DEFAULT_CELLS_PER_PAGE_EDGE = 64
const DEFAULT_PARTICLE_COUNT = 262_144
const COVER_MAXIMUM_PATCHES = 512
const FLOW_DISPLACEMENT_SCALE = 50
const FLOW_PREDICTION_STEPS = 4

/** Assembles the example-local temporal-raster, support, particle, contour, and history graph. */
export async function createFlowFieldRenderer(
    options: FlowFieldRendererOptions
): Promise<FlowFieldRenderer> {

    const { runtime, surface, temporalWindow } = options ?? {}
    if (runtime === undefined || surface?.runtime !== runtime ||
        typeof temporalWindow?.capture !== 'function' ||
        typeof temporalWindow.snapshot !== 'function' ||
        !Number.isFinite(options.maximumSpeed) || options.maximumSpeed <= 0) {
        throw new TypeError('Flow Field renderer requires one runtime, Surface, and temporal window')
    }
    let size = flowSurfaceSize(options.size)
    const cellsPerPageEdge = boundedCellEdge(
        options.cellsPerPageEdge ?? DEFAULT_CELLS_PER_PAGE_EDGE
    )
    const particleCount = boundedParticleCount(
        options.particleCount ?? DEFAULT_PARTICLE_COUNT
    )
    const thresholds = flowActivityThresholds({ maximumSpeed: options.maximumSpeed })
    const owned: Disposable[] = []
    const own = <Value extends Disposable>(value: Value): Value => {
        owned.push(value)
        return value
    }
    let initialized = false
    let disposed = false
    let disposePromise: Promise<void> | undefined
    let frameCount = 0
    let constructionInFlight: Promise<void> | undefined
    let frameInFlight: Promise<unknown> | undefined
    let constructionCapture: ReturnType<typeof temporalWindow.capture> | undefined
    let constructionCaptureReleased = false
    let presentation = flowFieldPresentation(options.presentation ?? FLOW_FIELD_PRESENTATION)
    let resetRevision = 0
    let appliedResetRevision = 0
    let presentationRevision = 0
    let clearedPresentationRevision = 0
    const visualClock = createFlowVisualClock()
    let visualTime: FlowVisualTime = Object.freeze({referenceSteps:0,wholeSteps:0,discardedSeconds:0})

    try {
        constructionCapture = temporalWindow.capture()
        if (constructionCapture.state !== 'ready') {
            throw new TypeError('Flow Field renderer requires an initially ready temporal pair')
        }
        const initialRuntimes = uniqueCaptureRuntimes(constructionCapture)
        if (initialRuntimes.some(candidate => candidate.gpu.runtime !== runtime)) {
            throw new TypeError('Flow Field temporal runtimes must share the renderer GPURuntime')
        }
        const model = constructionCapture.lower.runtime.model
        const maximumCandidatePages = Math.min(
            model.addressSpace.pageTableEntryCount,
            ...initialRuntimes.map(candidate => candidate.viewDemandProducer.maxDemands)
        )
        const maximumCandidateCount = maximumCandidatePages * cellsPerPageEdge ** 2
        if (!Number.isSafeInteger(maximumCandidateCount) || maximumCandidateCount <= 0) {
            throw new RangeError('Flow Field candidate capacity exceeds the safe integer range')
        }
        const temporalBindings = own(await createFlowTemporalBindings({
            window: temporalWindow,
        }))
        const renderView = own(await createFlowRenderView({
            runtime,
            addressCodec: model.addressCodec,
        }))
        const viewDemand = own(await createFlowViewDemandAdapter({
            runtime,
            spatialProfile: model.spatialProfile,
            sourceCoverage: model.coverage,
            policy: gpuWebMercatorQuadCoverPolicy({
                minimumMatrixLevel: Number(model.coverage.limits[0]!.matrixId),
                maximumMatrixLevel: 14,
                maximumPatches: COVER_MAXIMUM_PATCHES,
                cellsPerPatchEdge: 128,
                maximumCellSpanReferencePixels: 5,
                refinementTolerance: 0.005,
            }),
            maximumDemands: Math.min(COVER_MAXIMUM_PATCHES, maximumCandidatePages),
        }))
        const demand = own(createFlowDemandCoordinator({
            cover: viewDemand.cover,
            projection: viewDemand.projection,
            maximumDisplacementMeters:
                options.maximumSpeed * FLOW_DISPLACEMENT_SCALE * FLOW_PREDICTION_STEPS,
            maximumCandidatePages,
            cellsPerPageEdge,
            maximumCandidateCells: maximumCandidateCount,
        }))
        const spawn = own(await createFlowSpawnIndex({
            runtime,
            maximumCandidateCount,
            capacity: maximumCandidateCount,
            temporal: temporalBindings,
            subcellSide: (256 / cellsPerPageEdge) as 1 | 2 | 4,
        }))
        const particleSpawn = own(await prepareFlowParticleSpawnBindings(runtime, spawn))
        const particles = own(await createFlowParticles({
            runtime,
            maximumCount: particleCount,
            maximumSpeed: options.maximumSpeed,
            addressCodec: model.addressCodec,
            simulationShader: particleSimulationShader,
            temporal: temporalBindings,
            spawn: particleSpawn.module,
            activitySpawn: thresholds.spawn,
            activityKill: thresholds.kill,
            timeStep: 1,
            substeps: 1,
            maximumAgeSteps: 3600,
            maximumStagnantSteps: 30,
            minimumDisplacementMeters: 0.25,
        }))
        const particleRender = own(await createFlowParticleRender({
            runtime,
            particles,
            maximumSpeed: options.maximumSpeed,
            view: renderView,
            targetFormat: 'rgba8unorm',
        }))
        const contour = own(await createFlowContour({
            runtime,
            targetFormat: surface.format,
            maximumCandidateCount,
            segmentCapacity: maximumCandidateCount * 2,
            temporal: temporalBindings,
            view: renderView,
        }))
        const history = own(await createFlowHistory({
            runtime,
            surface,
            size,
            mode: 'reproject',
            temporal: temporalBindings,
            addressCodec: model.addressCodec,
            activityKill: thresholds.kill,
            centerCache: {addressSpace:model.addressSpace,capacity:Math.min(FLOW_CENTER_CACHE_MAX_PAGES,maximumCandidatePages)},
        }))
        const inspector = own(await createFlowScreenInspector({
            runtime, temporal: temporalBindings, model,
            maximumSpeed: options.maximumSpeed,
        }))
        const overlayPass = own(runtime.createRenderPass({
            label: 'Flow Field current contour overlay',
            color: [{ target: surface, load: 'load', store: 'store' }],
        }))
        constructionCapture.release()
        constructionCaptureReleased = true
        initialized = true

        let temporalResidencyEpoch = 0
        let lastTemporalSignature = ''
        let requestedLevel = 0
        let populatedParticleView: GeoViewSnapshot | undefined
        let prefetchFacts: FlowFieldRendererFacts['prefetch']
        let prefetchPlan: {
            runtime: FlowVelocitySampleRuntime
            pages: FlowDemandFrame['candidatePages']
            observedReady: boolean
        } | undefined
        let packedCells: FlowDemandFrame['candidateCells'] | undefined
        let packedCandidates = new Uint8Array(new ArrayBuffer(0))
        let preparedSpawnCandidates: FlowSpawnCandidates | undefined

        async function render(
            frameNumber: number,
            capture: GeoViewSourceCapture<MapLibrePlanarCameraState>,
            timeline: FlowTimelineSnapshot,
            wallTime: number
        ): Promise<GeoFrameResult<FlowFieldRendererFrame>> {

            assertActive()
            if (!Number.isSafeInteger(frameNumber) || frameNumber <= frameCount ||
                capture?.view === undefined || timeline?.readiness !== 'ready' || !Number.isFinite(wallTime) || wallTime < 0) {
                throw new TypeError(
                    'Flow Field render requires one monotonic view and admitted timeline'
                )
            }
            if (constructionInFlight !== undefined || frameInFlight !== undefined) {
                throw new Error('Flow Field renderer permits exactly one frame in flight')
            }
            let finishConstruction!: () => void
            constructionInFlight = new Promise(resolve => { finishConstruction = resolve })
            let temporalFrame: FlowTemporalReadyBindingFrame | undefined
            let prefetchFrame: FlowTemporalPrefetchCapture<FlowVelocitySampleRuntime> | undefined
            let frameOwnershipTransferred = false
            try {
                const framePresentation = presentation
                const frameResetRevision = resetRevision
                const framePresentationRevision = presentationRevision
                const nextSize = flowSurfaceSize(capture.presentationSize)
                if (!sameSize(size, nextSize)) {
                    surface.resize(nextSize)
                    await history.resize(nextSize)
                    size = nextSize
                }
                let prepared
                try {
                    prepared = await temporalBindings.prepareFrame(requestedLevel)
                } catch (error) {
                    if (error instanceof FlowTemporalBindingSupersededError) {
                        throw new FlowTemporalFrameUnavailableError(
                            'superseded',
                            { cause: error }
                        )
                    }
                    throw error
                }
                if (prepared.state !== 'ready') {
                    if (prepared.state === 'failed') throw prepared.error
                    throw new FlowTemporalFrameUnavailableError(prepared.state)
                }
                temporalFrame = prepared
                try {
                    assertFlowTemporalCapture(timeline, prepared.temporal)
                } catch (error) {
                    throw new FlowTemporalFrameUnavailableError('superseded', { cause: error })
                }
                prefetchFrame = temporalWindow.capturePrefetch()
                const publications = [...takeFramePublications(prepared)]
                const lowerSnapshotEpoch = publicationEpoch(
                    publications,
                    prepared.temporal.lower.runtime
                )
                const upperSnapshotEpoch = publicationEpoch(
                    publications,
                    prepared.temporal.upper.runtime
                )
                const signature = `${prepared.pairGeneration}:` +
                    `${lowerSnapshotEpoch}:${upperSnapshotEpoch}`
                if (signature !== lastTemporalSignature) {
                    temporalResidencyEpoch++
                    lastTemporalSignature = signature
                }
                const frameTemporal = flowTemporalFrameSnapshot(
                    timeline,
                    prepared.temporal,
                    {
                        temporalResidencyEpoch,
                        lowerSnapshotEpoch,
                        upperSnapshotEpoch,
                    }
                )
                const view = flowFieldViewAdapter.read(capture.view, {
                    frameEpoch: frameNumber,
                    residencySnapshotEpoch: frameTemporal.temporalResidencyEpoch,
                })
                const builder = runtime.createSubmission({ validation: 'throw' })
                encodePublications(builder, publications)

                const needsViewFollowUp = !viewDemand.hasFeedbackFor(view)
                const demandFrame = demand.encode(builder, view, prepared.temporal)
                requestedLevel = demandFrame.requestedLevel
                // Full-view completeness remains strict. Check failures even when
                // delayed camera feedback is pending; local work cannot hide them.
                const viewPagesReady = demandFrame.candidatePages.length === 0 ||
                    flowPairViewReady(prepared.temporal, demandFrame.candidatePages)
                const presentationReady = !needsViewFollowUp &&
                    prepared.requestedLevel === requestedLevel &&
                    viewPagesReady
                let prefetchReconciliation: VirtualRasterFeedbackReconciliation | undefined
                let observedPrefetchPlan: typeof prefetchPlan
                let prefetchPagesResident = false
                prefetchFacts = undefined
                if (prefetchFrame === undefined) prefetchPlan = undefined
                if (prefetchFrame !== undefined && viewDemand.facts().hasSettledFeedback) {
                    try {
                        if (prefetchPlan?.runtime !== prefetchFrame.runtime ||
                            prefetchPlan.pages !== demandFrame.candidatePages) {
                            prefetchPlan = {runtime:prefetchFrame.runtime,
                                pages:demandFrame.candidatePages, observedReady:false}
                            prefetchReconciliation = demand.reconcilePrefetch(demandFrame, prefetchFrame.runtime)
                        }
                        prefetchPagesResident = prefetchPlan.observedReady ||
                            flowRuntimeViewReady(prefetchFrame.runtime, demandFrame.candidatePages)
                        prefetchFacts = Object.freeze({
                            sampleKey: prefetchFrame.sample.sampleKey,
                            requestedPages: demandFrame.candidatePages.length,
                            pagesResident: prefetchPlan.observedReady,
                        })
                    } catch (error) {
                        temporalWindow.rejectPrefetch(prefetchFrame.runtime, error)
                        prefetchPlan = undefined
                    }
                    // An immutable completed lookahead has no other producer. Do not
                    // republish/reconcile its unchanged resident plan every display tick.
                    if (prefetchPlan !== undefined && !prefetchPlan.observedReady) {
                        observedPrefetchPlan = prefetchPlan
                        const warmRuntime = prefetchFrame.runtime
                        if (!publications.some(value=>value.runtime===warmRuntime)) {
                            const member = {runtime:warmRuntime, publication:warmRuntime.publish()}
                            member.runtime.gpu.encode(builder, member.publication.update)
                            publications.push(member)
                        }
                    }
                }
                if (clearedPresentationRevision !== framePresentationRevision) {
                    history.reset()
                    clearedPresentationRevision = framePresentationRevision
                }
                if (presentationReady && appliedResetRevision !== frameResetRevision) {
                    history.reset()
                    particles.reset()
                    populatedParticleView = undefined
                    appliedResetRevision = frameResetRevision
                    visualClock.reset()
                }
                // Sampling uses this capture's immutable publications at actual
                // particle positions, not camera-equality as a global permission.
                // An explicit seek/loop reset must still precede any new ink.
                const particlesEligible = framePresentation.view === 'particles' &&
                    appliedResetRevision === frameResetRevision
                visualTime = visualClock.tick(wallTime,particlesEligible && timeline.playing)
                const particlesAdvancing = particlesEligible && visualTime.referenceSteps > 0
                renderView.encode(builder, view)
                if (preparedSpawnCandidates === undefined || packedCells !== demandFrame.candidateCells) {
                    packedCandidates = packFlowCandidateCells(
                        demandFrame.candidateCells, model.addressCodec, cellsPerPageEdge
                    )
                    preparedSpawnCandidates = prepareFlowSpawnCandidates(packedCandidates)
                    packedCells = demandFrame.candidateCells
                }
                const candidates = packedCandidates
                const supportSnapshot = Object.freeze({
                    generation: frameTemporal.pairGeneration,
                    currentSnapshotEpoch: frameTemporal.lowerSnapshotEpoch,
                    nextSnapshotEpoch: frameTemporal.upperSnapshotEpoch,
                    progress: frameTemporal.alpha,
                    activitySpawn: thresholds.spawn,
                    activityKill: thresholds.kill,
                })
                const spawnFrame = spawn.encode(
                    builder,
                    preparedSpawnCandidates,
                    demandFrame.candidateCells.length,
                    supportSnapshot,
                    prepared
                )
                let refilledParticleView = false
                const encodeContour = (contentBuilder: SubmissionBuilder): void => {
                    if (presentationReady && framePresentation.contour) contour.encode(contentBuilder, candidates, demandFrame.candidateCells.length, {
                        generation: supportSnapshot.generation,
                        currentSnapshotEpoch: supportSnapshot.currentSnapshotEpoch,
                        nextSnapshotEpoch: supportSnapshot.nextSnapshotEpoch,
                        progress: supportSnapshot.progress,
                        activityKill: supportSnapshot.activityKill,
                    }, prepared)
                }
                let content: FlowHistoryContent
                if (framePresentation.view === 'particles') {
                    // History uploads its uniforms before this synchronous work,
                    // so stable frames place all hot uploads before simulation.
                    content = contentBuilder => {
                        if (particlesAdvancing) {
                            if (presentationReady) {
                                if (populatedParticleView === undefined) {
                                    populatedParticleView = view
                                } else if (!sameParticleView(populatedParticleView, view)) {
                                    // Only a complete view consumes the reveal baseline.
                                    // Partial work must not repeatedly reseed the same region.
                                    particles.refillView(populatedParticleView)
                                    populatedParticleView = view
                                    refilledParticleView = true
                                }
                            }
                            particles.encode(contentBuilder, particleSpawn.bindings, prepared, view,
                                framePresentation.boundary === 'sdf-center-linear' || framePresentation.boundary === 'sdf-center-smooth',
                                visualTime.referenceSteps,visualTime.wholeSteps)
                        }
                        encodeContour(contentBuilder)
                        // Zero visual time never replays the last particle segment.
                        return particlesAdvancing ? [particleRender.draw] : []
                    }
                } else {
                    encodeContour(builder)
                    content = presentationReady ? [inspector.encode(builder, view, prepared, framePresentation)] : []
                }
                const historyFrame = presentationReady || particlesAdvancing ? history.encode(builder, view,
                    content,
                    framePresentation.view === 'particles' && (framePresentation.trails || visualTime.referenceSteps === 0),
                    framePresentation.view === 'particles' ? prepared : undefined,
                    framePresentation.view === 'particles' ? framePresentation.boundary : 'hard',
                    framePresentation.sdfFeatherTexels,
                    {
                        pages: demandFrame.candidatePages,
                        lowerSnapshot: publications.find(value=>value.runtime===prepared.temporal.lower.runtime)!.publication.publication.snapshot,
                        upperSnapshot: publications.find(value=>value.runtime===prepared.temporal.upper.runtime)!.publication.publication.snapshot,
                    },
                    visualTime.wholeSteps
                ) : history.presentRetained(builder, view)
                if (presentationReady && framePresentation.contour) builder.render(overlayPass, [contour.draw])
                const submitted = builder.submit()
                const reconciliations = demand.reconcile(demandFrame).then(
                    requireFlowDemandReconciliations
                )
                const observing = settleFrameObservations(
                    submitted,
                    publications,
                    reconciliations,
                    viewDemand,
                    presentationReady && framePresentation.contour ? contour : undefined,
                    Promise.all([Promise.resolve().then(() => spawn.observe(spawnFrame, submitted)),history.observe(submitted)]).then(()=>undefined)
                )
                let observation: Promise<unknown>
                observation = observing.then(() => {
                    if (observedPrefetchPlan !== undefined && prefetchPlan === observedPrefetchPlan) {
                        observedPrefetchPlan.observedReady = prefetchPagesResident
                    }
                }).finally(() => {
                    prepared.release()
                    prefetchFrame?.release()
                    if (frameInFlight === observation) frameInFlight = undefined
                })
                frameOwnershipTransferred = true
                frameInFlight = observation
                const settlement = reconciliations.then(value => flowDemandSettlement(value, prefetchReconciliation))
                frameCount = frameNumber
                return Object.freeze({
                    observation,
                    settlement,
                    needsFollowUp: needsViewFollowUp || prepared.requestedLevel !== requestedLevel || refilledParticleView,
                    value: Object.freeze({
                        state: 'rendered' as const,
                        submitted,
                        view,
                        temporal: frameTemporal,
                        demand: demandFrame,
                        history: historyFrame,
                        presentationReady,
                        particlesAdvancing,
                        visualTime,
                    }),
                })
            } finally {
                if (temporalFrame !== undefined && !frameOwnershipTransferred) {
                    temporalFrame.release()
                }
                if (!frameOwnershipTransferred) prefetchFrame?.release()
                finishConstruction()
                constructionInFlight = undefined
            }
        }

        function takeFramePublications(
            temporal: FlowTemporalReadyBindingFrame
        ): FlowFramePublications {

            return Object.freeze(uniqueCaptureRuntimes(temporal.temporal).map(runtime =>
                Object.freeze({ runtime, publication: runtime.publish() })
            ))
        }

        function encodePublications(
            builder: ReturnType<GPURuntime['createSubmission']>,
            publications: FlowFramePublications
        ): void {

            for (const { runtime: active, publication } of publications) {
                active.gpu.encode(builder, publication.update)
            }
        }

        async function suspendTemporal(): Promise<void> {
            resetVisualClock()

            assertActive()
            if (constructionInFlight !== undefined) await constructionInFlight
            if (frameInFlight !== undefined) {
                const settlement = await Promise.allSettled([ frameInFlight ])
                if (settlement[0]?.status === 'rejected') throw settlement[0].reason
            }
            assertActive()
            if (constructionInFlight !== undefined || frameInFlight !== undefined) {
                throw new Error('Flow Field temporal suspension could not acquire the renderer')
            }
            let finishConstruction!: () => void
            constructionInFlight = new Promise(resolve => { finishConstruction = resolve })
            try {
                await temporalBindings.suspend()
            } finally {
                finishConstruction()
                constructionInFlight = undefined
            }
        }

        async function presentRetained(
            frameNumber: number,
            capture: GeoViewSourceCapture<MapLibrePlanarCameraState>
        ): Promise<GeoFrameResult<undefined>> {
            resetVisualClock()
            assertActive()
            if (constructionInFlight !== undefined || frameInFlight !== undefined) {
                throw new Error('Flow retained presentation requires an idle renderer')
            }
            let finishConstruction!: () => void
            constructionInFlight = new Promise(resolve => { finishConstruction = resolve })
            try {
                const nextSize = flowSurfaceSize(capture.presentationSize)
                if (!sameSize(size, nextSize)) {
                    surface.resize(nextSize)
                    await history.resize(nextSize)
                    size = nextSize
                }
                const view = flowFieldViewAdapter.read(capture.view, {
                    frameEpoch: frameNumber,
                    residencySnapshotEpoch: temporalResidencyEpoch,
                })
                const builder = runtime.createSubmission({ validation: 'throw' })
                if (clearedPresentationRevision !== presentationRevision) {
                    history.reset()
                    clearedPresentationRevision = presentationRevision
                }
                history.presentRetained(builder, view)
                const submitted = builder.submit()
                let observation: Promise<unknown>
                observation = observeFlowSubmittedWork(submitted).finally(() => {
                    if (frameInFlight === observation) frameInFlight = undefined
                })
                frameInFlight = observation
                frameCount = frameNumber
                return Object.freeze({
                    observation, needsFollowUp: false, value: undefined,
                    settlement: Promise.resolve({ residencyWorkCount: 0, needsFollowUp: false }),
                })
            } finally {
                finishConstruction()
                constructionInFlight = undefined
            }
        }

        async function flushResidency(): Promise<void> {

            assertActive()
            if (constructionInFlight !== undefined || frameInFlight !== undefined) {
                throw new Error('Flow Field residency flush requires an idle renderer')
            }
            let finishConstruction!: () => void
            constructionInFlight = new Promise(resolve => { finishConstruction = resolve })
            let prepared: FlowTemporalReadyBindingFrame | undefined
            let transferred = false
            try {
                const captured = await temporalBindings.prepareFrame(requestedLevel)
                if (captured.state !== 'ready') {
                    if (captured.state === 'failed') throw captured.error
                    throw new FlowTemporalFrameUnavailableError(captured.state)
                }
                prepared = captured
                const publications = takeFramePublications(captured)
                const builder = runtime.createSubmission({ validation: 'throw' })
                encodePublications(builder, publications)
                const submitted = builder.submit()
                const flushing = settlePublicationObservations(submitted, publications, true)
                let tracked: Promise<void>
                tracked = flushing.finally(() => {
                    captured.release()
                    if (frameInFlight === tracked) frameInFlight = undefined
                })
                transferred = true
                frameInFlight = tracked
                return await tracked
            } finally {
                if (!transferred) prepared?.release()
                finishConstruction()
                constructionInFlight = undefined
            }
        }

        function facts(): FlowFieldRendererFacts {

            return Object.freeze({
                initialized,
                disposed,
                frameCount,
                visualTime,
                cellsPerPageEdge,
                maximumCandidatePages,
                maximumCandidateCount,
                maximumSpeed: options.maximumSpeed,
                temporalWindow: temporalWindow.snapshot(),
                temporal: temporalBindings.facts(),
                viewDemand: viewDemand.facts(),
                spawn: spawn.facts(),
                particles: particles.facts(),
                contour: contour.facts(),
                history: history.facts(),
                prefetch: prefetchFacts,
            })
        }

        function dispose(): Promise<void> {

            if (disposePromise !== undefined) return disposePromise
            disposed = true
            prefetchPlan = undefined
            prefetchFacts = undefined
            disposePromise = (async() => {
                const failures: unknown[] = []
                if (constructionInFlight !== undefined) await constructionInFlight
                if (frameInFlight !== undefined) {
                    try {
                        await frameInFlight
                    } catch (error) {
                        failures.push(error)
                    }
                }
                preparedSpawnCandidates = undefined
                packedCandidates = new Uint8Array(new ArrayBuffer(0))
                packedCells = undefined
                try {
                    await disposeOwned(owned)
                } catch (error) {
                    failures.push(error)
                }
                if (failures.length > 0) {
                    throw new AggregateError(failures, 'Flow Field renderer disposal failed')
                }
            })()
            return disposePromise
        }

        function assertActive(): void {

            if (!initialized || disposed) throw new Error('Flow Field renderer is not active')
        }

        function resetVisuals(): void {
            assertActive()
            resetRevision++
            resetVisualClock()
        }

        function resetVisualClock(): void {
            visualClock.reset()
            visualTime = Object.freeze({referenceSteps:0,wholeSteps:0,discardedSeconds:0})
        }

        function setPresentation(value: FlowFieldPresentation): void {
            assertActive()
            const next = flowFieldPresentation(value)
            if (next.view !== presentation.view || next.trails !== presentation.trails ||
                next.sample !== presentation.sample) {
                resetRevision++
                presentationRevision++
                resetVisualClock()
            }
            presentation = next
        }

        return Object.freeze({
            render, suspendTemporal, presentRetained, setPresentation, resetVisuals, resetVisualClock,
            flushResidency, facts, dispose,
        })
    } catch (error) {
        if (constructionCapture?.state === 'ready' && !constructionCaptureReleased) {
            constructionCapture.release()
        }
        await disposeOwned(owned)
        throw error
    }
}

function requireFlowDemandReconciliations(value: unknown): FlowDemandReconciliations {

    const candidate = value as Partial<FlowDemandReconciliations> | null
    if (candidate?.kind !== 'flow-demand-reconciliations' ||
        !Number.isSafeInteger(candidate.generation) || candidate.generation! <= 0 ||
        !Number.isSafeInteger(candidate.requestedRevision) || candidate.requestedRevision! <= 0 ||
        !Number.isSafeInteger(candidate.pairGeneration) || candidate.pairGeneration! <= 0 ||
        !Array.isArray(candidate.members) || candidate.members.length < 1 ||
        candidate.members.length > 2) {
        throw new TypeError('Flow Field demand reconciliation facts are invalid')
    }
    for (const member of candidate.members) {
        if (typeof member?.sampleKey !== 'string' || member.sampleKey.length === 0 ||
            !Array.isArray(member.roles) || member.roles.length < 1 ||
            !Number.isSafeInteger(member.reconciliation?.requestedCount) ||
            member.reconciliation.requestedCount < 0 ||
            typeof member.reconciliation.settlement?.then !== 'function') {
            throw new TypeError('Flow Field demand reconciliation facts are invalid')
        }
    }
    return candidate as FlowDemandReconciliations
}

function flowDemandSettlement(
    reconciliations: FlowDemandReconciliations,
    prefetch?: VirtualRasterFeedbackReconciliation
): GeoFrameSettlement {

    const residencyWorkCount = reconciliations.members.reduce(
        (sum, member) => sum + member.reconciliation.requestedCount,
        prefetch?.requestedCount ?? 0
    )
    return Object.freeze({
        residencySettlement: Promise.all([...reconciliations.members.map(
            member => member.reconciliation.settlement
        ), ...(prefetch === undefined ? [] : [prefetch.settlement])]),
        residencyWorkCount,
        needsFollowUp: false,
    })
}

function sameParticleView(first: GeoViewSnapshot, second: GeoViewSnapshot): boolean {
    return first.clipFromRelativeWorld.every((value, index) => value === second.clipFromRelativeWorld[index]) &&
        first.cameraHigh.every((value, index) => value === second.cameraHigh[index]) &&
        first.cameraLow.every((value, index) => value === second.cameraLow[index]) &&
        first.referenceViewport.every((value, index) => value === second.referenceViewport[index])
}

function uniqueCaptureRuntimes(
    capture: FlowTemporalReadyCapture<FlowVelocitySampleRuntime>
): readonly FlowVelocitySampleRuntime[] {

    return Object.freeze([ ...new Set([
        capture.lower.runtime,
        capture.upper.runtime,
    ]) ])
}

function publicationEpoch(
    publications: FlowFramePublications,
    runtime: FlowVelocitySampleRuntime
): number {

    const member = publications.find(candidate => candidate.runtime === runtime)
    if (member === undefined || !Number.isSafeInteger(member.publication.snapshotEpoch) ||
        member.publication.snapshotEpoch <= 0) {
        throw new Error('Flow Field publication is missing from its temporal capture')
    }
    return member.publication.snapshotEpoch
}

async function settlePublicationObservations(
    submitted: SubmittedWork,
    publications: FlowFramePublications,
    allowNoNativeWork = false
): Promise<void> {

    const settlements = await Promise.allSettled([
        observeFlowSubmittedWork(submitted, allowNoNativeWork),
        ...publications.map(({ runtime, publication }) =>
            runtime.acknowledge(publication, submitted)
        ),
    ])
    throwSettledFailures(settlements, 'Flow Field publication observation failed')
}

async function settleFrameObservations(
    submitted: SubmittedWork,
    publications: FlowFramePublications,
    reconciliations: Promise<FlowDemandReconciliations>,
    viewDemand: FlowViewDemandAdapter,
    contour: FlowContour | undefined,
    spawnObservation: Promise<void>
): Promise<unknown> {

    const settlements = await Promise.allSettled([
        settlePublicationObservations(submitted, publications),
        viewDemand.observe(submitted),
        contour?.observeOverflow(submitted),
        reconciliations,
        spawnObservation,
    ])
    throwSettledFailures(settlements, 'Flow Field frame observation failed')
    return settlements[1]!.status === 'fulfilled' ? settlements[1]!.value : undefined
}

function throwSettledFailures(
    settlements: readonly PromiseSettledResult<unknown>[],
    message: string
): void {

    const failures = settlements.flatMap(result =>
        result.status === 'rejected' ? [ result.reason ] : []
    )
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, message)
}

export class FlowTemporalFrameUnavailableError extends Error {
    readonly state: 'loading' | 'gap' | 'superseded'

    constructor(
        state: 'loading' | 'gap' | 'superseded',
        options?: ErrorOptions
    ) {
        super(`Flow Field temporal frame is ${state}`, options)
        this.name = 'FlowTemporalFrameUnavailableError'
        this.state = state
    }
}

async function observeFlowSubmittedWork(
    submitted: SubmittedWork,
    allowNoNativeWork = false
) {

    const [ nativeOutcome ] = await Promise.all([ submitted.nativeOutcome, submitted.done ])
    if (nativeOutcome.status !== 'observed-succeeded' &&
        !(allowNoNativeWork && nativeOutcome.status === 'no-native-work')) {
        throw new Error(`Flow Field submission native outcome was ${nativeOutcome.status}`)
    }
    return Object.freeze({ submissionId: submitted.id, nativeStatus: nativeOutcome.status })
}

async function disposeOwned(owned: Disposable[]): Promise<void> {

    const failures: unknown[] = []
    for (const value of owned.reverse()) {
        try {
            await value.dispose()
        } catch (error) {
            failures.push(error)
        }
    }
    owned.length = 0
    if (failures.length > 0) {
        throw new AggregateError(failures, 'Flow Field renderer disposal failed')
    }
}

function flowSurfaceSize(value: SurfaceSize): { width: number, height: number } {

    if (!Number.isSafeInteger(value?.width) || value.width <= 0 ||
        !Number.isSafeInteger(value?.height) || value.height <= 0) {
        throw new RangeError('Flow Field Surface size requires positive integer dimensions')
    }
    return { width: value.width, height: value.height }
}

function sameSize(
    first: Readonly<{ width: number, height: number }>,
    second: Readonly<{ width: number, height: number }>
): boolean {

    return first.width === second.width && first.height === second.height
}

function boundedCellEdge(value: number): number {

    if (!Number.isSafeInteger(value) || value < 64 || value > 256 || 256 % value !== 0) {
        throw new RangeError('Flow Field candidate grid must evenly divide 256 and be at least 64')
    }
    return value
}

function boundedParticleCount(value: number): number {

    if (!Number.isSafeInteger(value) || value <= 0 || value > DEFAULT_PARTICLE_COUNT) {
        throw new RangeError('Flow Field particle count must be within the canonical capacity')
    }
    return value
}
