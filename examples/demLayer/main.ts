import { GPURuntime } from 'geoscratch/scratch'
import type {
    GPUDiagnosticCapture,
    GPUDiagnosticCaptureReport,
    GPURuntimeDiagnosticsEvidence,
    Surface,
    SurfaceSize,
} from 'geoscratch/scratch'
import {
    DEM_STAGE_ORDER,
    createDemLayer,
} from './dem-layer.ts'
import { createDemLifecycle } from './dem-lifecycle.ts'
import { createDemMap, readDemCameraState, waitForDemMap } from './dem-map.ts'
import type { DemMap } from './dem-map.ts'
import {
    createDemVirtualRasterRuntime,
    fetchDemVirtualRasterManifest,
} from './dem-virtual-raster.ts'
import type { DemCachePolicy } from './dem-tile-protocol.ts'
import lodMapShader from './shaders/lod-map.wgsl?raw'
import terrainShader from './shaders/terrain-mesh.wgsl?raw'

type DemLayer = Awaited<ReturnType<typeof createDemLayer>>
type DemLifecycle = ReturnType<typeof createDemLifecycle>
type CleanupReport = Awaited<ReturnType<DemLifecycle['dispose']>>
type FrameProvenance = Awaited<ReturnType<DemLayer['renderFrame']>>['provenance']
type FailureConfiguration = Readonly<{ scenario?: string }>
type FailureProofController = ReturnType<typeof createFailureProofController>
type FailureProof = Exclude<ReturnType<FailureProofController['finalize']>, undefined>
type CleanupProof = Readonly<{
    report: ReturnType<typeof serializeCleanupReport>
    lifecycle: ReturnType<DemLifecycle['snapshot']>
    graphState?: ReturnType<DemLayer['state']>
    virtualRaster?: ReturnType<DemLayer['virtualRasterFacts']>
}>
type PageSettlement = Promise<FailureProof | CleanupProof | void | undefined>
type PageContext = { graph: DemLayer; runtime: GPURuntime }
type CameraMoveOptions = Parameters<DemMap['jumpTo']>[0]
type FrameWork = {
    scheduled: number
    completed: number
    cancelled: number
    active: number
}
type FailureDetails = Error & {
    code?: unknown
    scenario?: unknown
    diagnostic?: { code?: unknown }
    context?: { domain?: unknown, incident?: unknown }
}

declare global {
    interface Window {
        __DEM_LAYER_PROOF__: Readonly<{
            pauseAndDrain(): Promise<Readonly<DOMStringMap>>
            dispose(): Promise<FailureProof | CleanupProof | void | undefined>
            facts(): Readonly<DOMStringMap>
            moveCamera(options: CameraMoveOptions): void
        }>
        __DEM_LAYER_INIT_FAILURE_PROOF__: FailureProof
        __DEM_LAYER_CLEANUP_PROOF__: CleanupProof
    }
}

const canvas = document.getElementById('GPUFrame') as HTMLCanvasElement
const FAILURE_RUNTIME_EVIDENCE_MAX_BYTES = 512 * 1024
const FAILURE_CAPTURE_BOUNDS = Object.freeze({
    maxOperations: 1,
    maxDurationMs: 2_000,
    maxEvidenceBytes: 64 * 1024,
    includeStacks: true,
    includeDescriptors: true,
})
const FAILURE_SCENARIOS = Object.freeze([
    'after-map-acquisition',
    'invalid-terrain-shader-wgsl',
])
const parameters = new URLSearchParams(window.location.search)
const proofMode = parameters.get('proof') === '1'
const tileServerUrl = parameters.get('tileServer') ?? 'http://127.0.0.1:8787'
const cachePolicy = readCachePolicy(
    parameters.get('cache'),
    parameters.get('cacheNamespace')
)
const maxPhysicalPages = boundedIntegerParameter(
    parameters.get('atlasPages'),
    18,
    2,
    18
)
const requestedFailureScenario = parameters.get('fault')
const failureConfiguration = Object.freeze({
    scenario: proofMode && requestedFailureScenario !== null
        ? requestedFailureScenario
        : undefined,
})
const pageLifetime = createDemLifecycle()
const failureProof = createFailureProofController(failureConfiguration)
let pageSettlement: PageSettlement | undefined
let pageContext: PageContext | undefined
const handlePageHide = () => {
    void disposePage()
}

window.addEventListener('pagehide', handlePageHide, { once: true })
pageLifetime.deferStop({
    label: 'pagehide-listener',
    run: () => window.removeEventListener('pagehide', handlePageHide),
})

setStatus('loading')
const pageInitialization = pageLifetime.track(
    Promise.resolve().then(() => main(pageLifetime, failureProof)),
    'dem-page-initialization'
)
void pageInitialization.catch(error => {
    if (pageLifetime.isStopError(error)) return
    void failPage(error)
})

async function main(lifetime: DemLifecycle, proof: FailureProofController) {

    proof.assertConfiguration()
    const map = lifetime.ownMap(createDemMap(canvas, { proof: proofMode }))
    proof.mapAcquired()
    proof.reach(FAILURE_SCENARIOS[0])

    const mapReady = waitForDemMap(map, lifetime.signal)
    const runtimeReady = lifetime.acquireRuntime(GPURuntime.create({
        label: 'DEM Layer runtime',
        powerPreference: 'high-performance',
        diagnostics: {
            operationCapacity: 192,
            incidentCapacity: 32,
            evidenceByteCapacity: 256 * 1024,
            submissionScopes: 'summary',
            maxPendingNativeObservations: 8,
        },
    }))
    const manifestReady = lifetime.track(
        fetchDemVirtualRasterManifest(tileServerUrl, lifetime.signal),
        'dem-virtual-raster-manifest'
    )
    const [ runtime, , manifest ] = await Promise.all([
        runtimeReady,
        mapReady,
        manifestReady,
    ])
    proof.observeRuntime(runtime)
    lifetime.assertActive('continue DEM initialization')

    const initialSize = canvasPixelSize(canvas)
    const surface = runtime.createSurface(canvas, {
        label: 'DEM Layer surface',
        format: 'preferred',
        alphaMode: 'premultiplied',
        size: initialSize,
    })
    proof.observeSurface(surface)
    const virtualRaster = await createDemVirtualRasterRuntime({
        runtime,
        manifest,
        tileServerUrl,
        cachePolicy,
        requestPersistence: cachePolicy.mode === 'persistent',
        workerCount: 3,
        maxNetworkRequests: 2,
        maxDecodeTasks: 1,
        maxPhysicalPages,
    })
    proof.rasterAcquired()
    lifetime.deferStop({
        label: 'dem-virtual-raster-demand',
        run: virtualRaster.stopDemand,
    })
    lifetime.deferRelease({
        label: 'dem-virtual-raster-streaming',
        run: virtualRaster.stopStreaming,
    })
    const graph = await createDemLayer({
        runtime,
        surface,
        virtualRaster,
        size: initialSize,
        shaders: { lodMap: lodMapShader, terrain: terrainShader },
        failureProof: proof,
    })
    lifetime.deferRelease({ label: 'dem-gpu-frontier', run: graph.dispose })
    lifetime.assertActive('continue DEM initialization')

    const initialized = await graph.initialize()
    await lifetime.track(initialized.observation, 'dem-initial-submission')
    lifetime.assertActive('continue DEM initialization')

    let active = true
    let animationFrame: number | undefined
    let rendering = false
    let renderRequested = false
    let submittedFrames = 0
    let observedFrames = 0
    let latestProvenance: FrameProvenance = []
    let frameWorkScheduled = 0
    let frameWorkCompleted = 0
    let frameWorkCancelled = 0
    let convergenceFollowUps = 0
    const maximumConvergenceFollowUps = 8

    function stopScheduling() {

        active = false
        renderRequested = false
        if (animationFrame !== undefined) {
            cancelAnimationFrame(animationFrame)
            animationFrame = undefined
            frameWorkCancelled++
        }
    }

    function requestRender() {

        if (!active) return
        renderRequested = true
        if (animationFrame !== undefined || rendering) return
        animationFrame = requestAnimationFrame(render)
        frameWorkScheduled++
    }

    const handleMapRender = () => {
        convergenceFollowUps = 0
        requestRender()
    }
    const handleResize = () => {
        map.resize()
        requestRender()
    }
    map.on('render', handleMapRender)
    window.addEventListener('resize', handleResize)
    lifetime.deferStop({
        label: 'map-render-listener',
        run: () => map.off('render', handleMapRender),
    })
    lifetime.deferStop({
        label: 'window-resize-listener',
        run: () => window.removeEventListener('resize', handleResize),
    })
    lifetime.deferStop({ label: 'dem-frame-scheduler', run: stopScheduling })

    function publish() {

        publishFrameFacts({
            runtime,
            graph,
            lifetime,
            submittedFrames,
            observedFrames,
            latestProvenance,
            frameWork: {
                scheduled: frameWorkScheduled,
                completed: frameWorkCompleted,
                cancelled: frameWorkCancelled,
                active: frameWorkScheduled - frameWorkCompleted - frameWorkCancelled,
            },
        })
    }

    async function pauseAndDrain() {

        stopScheduling()
        await lifetime.drain()
        publish()
        setStatus('stopped')
        return readPublishedFacts()
    }

    function moveCamera(options: CameraMoveOptions) {

        if (!active) throw new Error('DEM proof scheduler is stopped')
        map.jumpTo(options)
        requestRender()
    }

    window.__DEM_LAYER_PROOF__ = Object.freeze({
        pauseAndDrain,
        dispose: disposePage,
        facts: readPublishedFacts,
        moveCamera,
    })
    pageContext = { graph, runtime }
    publishGraphFacts(runtime, graph)
    publish()

    function render() {

        animationFrame = undefined
        frameWorkCompleted++
        if (!active || rendering) return
        rendering = true
        const renderTask = Promise.resolve().then(renderOnce)
        void lifetime.track(renderTask, `dem-render-task-${frameWorkCompleted}`).catch(error => {
            if (lifetime.isStopError(error)) return
            active = false
            void failPage(error)
        })
    }

    async function renderOnce() {

        renderRequested = false

        try {
            const nextSize = canvasPixelSize(canvas)
            const state = graph.state()
            if (!sameSize(state.size, nextSize)) await graph.resize(nextSize)
            if (!active) return

            const camera = readDemCameraState(map, nextSize)
            const frame = await graph.renderFrame(camera)
            submittedFrames++
            latestProvenance = frame.provenance
            if (frame.requestedPageCount > 0) {
                const settlement = frame.residencySettlement.then(() => {
                    if (!active) return
                    convergenceFollowUps = 0
                    requestRender()
                })
                void lifetime.track(
                    settlement,
                    `dem-page-requests-${submittedFrames}`
                ).catch(error => {
                    if (lifetime.isStopError(error)) return
                    active = false
                    void failPage(error)
                })
            }
            publish()

            const frameNumber = submittedFrames
            await lifetime.track(frame.observation, `dem-frame-${frameNumber}`)
            observedFrames = Math.max(observedFrames, frameNumber)
            publish()
            if (active) setStatus('ready')
            if (frame.needsFollowUp &&
                convergenceFollowUps < maximumConvergenceFollowUps) {
                convergenceFollowUps++
                requestRender()
            } else if (!frame.needsFollowUp) {
                convergenceFollowUps = 0
            }
        } finally {
            rendering = false
        }

        if (renderRequested && active) requestRender()
    }

    requestRender()
}

function publishGraphFacts(runtime: GPURuntime, graph: DemLayer) {

    canvas.dataset.proofMode = String(proofMode)
    canvas.dataset.stageOrder = DEM_STAGE_ORDER.join('|')
    canvas.dataset.stageCount = String(DEM_STAGE_ORDER.length)
    canvas.dataset.stableIdentityCount = String(graph.stableIdentities.length)
    canvas.dataset.stableIdentityHash = graph.stableIdentityHash
    canvas.dataset.graphContract = JSON.stringify(graph.contractFacts())
    canvas.dataset.adapterAcquired = String(runtime.adapter !== undefined)
    canvas.dataset.adapter = JSON.stringify(adapterFacts(runtime))
    canvas.dataset.tileServer = tileServerUrl
    canvas.dataset.cacheMode = cachePolicy.mode
    canvas.dataset.maxPhysicalPages = String(maxPhysicalPages)
}

function readCachePolicy(value: string | null, namespace: string | null): DemCachePolicy {

    switch (value ?? 'none') {
        case 'none':
            return Object.freeze({ mode: 'none' })
        case 'persistent':
            return Object.freeze({
                mode: 'persistent',
                maxPayloadBytes: 128 * 1024 * 1024,
                maxEntries: 2048,
                namespace: namespace ?? 'geoscratch-dem-webmercator-raw-v2',
            })
        default:
            throw new TypeError(`Unsupported DEM cache mode: ${value}`)
    }
}

function publishFrameFacts({
    runtime,
    graph,
    lifetime,
    submittedFrames,
    observedFrames,
    latestProvenance,
    frameWork,
}: {
    runtime: GPURuntime
    graph: DemLayer
    lifetime: DemLifecycle
    submittedFrames: number
    observedFrames: number
    latestProvenance: FrameProvenance
    frameWork: FrameWork
}) {

    const state = graph.state()
    const lifecycle = lifetime.snapshot()
    const diagnostics = runtime.diagnostics.snapshot()
    const bounded = diagnostics.recorder.retainedOperationCount <= diagnostics.recorder.operationCapacity &&
        diagnostics.recorder.retainedIncidentCount <= diagnostics.recorder.incidentCapacity &&
        diagnostics.recorder.retainedEvidenceBytes <= diagnostics.recorder.evidenceByteCapacity

    canvas.dataset.frames = String(submittedFrames)
    canvas.dataset.observedFrames = String(observedFrames)
    canvas.dataset.resizeGeneration = String(state.resizeGeneration)
    canvas.dataset.visibleNodeCount = String(state.visibleNodeCount)
    canvas.dataset.frontierCount = String(state.frontierCount)
    canvas.dataset.demandCount = String(state.demandCount)
    canvas.dataset.fallbackCount = String(state.fallbackCount)
    canvas.dataset.staleGenerationCount = String(state.staleGenerationCount)
    canvas.dataset.budgetLimitedCount = String(state.budgetLimitedCount)
    canvas.dataset.levelRange = JSON.stringify(state.levelRange)
    canvas.dataset.maximumObservedSse = String(state.maximumObservedSse)
    canvas.dataset.convergenceState = state.convergenceState
    canvas.dataset.readbackInFlightCount = String(state.readbackInFlightCount)
    canvas.dataset.staleFeedbackCount = String(state.staleFeedbackCount)
    canvas.dataset.virtualSnapshotEpoch = String(state.virtualSnapshotEpoch)
    canvas.dataset.virtualRequestedPageCount = String(state.virtualRequestedPageCount)
    canvas.dataset.virtualRaster = JSON.stringify(graph.virtualRasterFacts())
    canvas.dataset.stageActivity = JSON.stringify(state.stageActivity)
    canvas.dataset.provenance = JSON.stringify(latestProvenance)
    canvas.dataset.persistentFacts = JSON.stringify(graph.persistentFacts())
    const identityFacts = graph.currentIdentityFacts()
    canvas.dataset.currentStableIdentityHash = identityFacts.hash
    canvas.dataset.currentStableIdentityCount = String(identityFacts.count)
    canvas.dataset.currentIdentityFacts = JSON.stringify(identityFacts)
    canvas.dataset.staleBindSetPreparationCount = String(state.staleBindSetPreparationCount)
    canvas.dataset.lastResizeFacts = JSON.stringify(state.lastResizeFacts ?? null)
    canvas.dataset.pendingObservationCount = String(lifecycle.pendingObservationCount)
    canvas.dataset.frameWork = JSON.stringify(frameWork)
    canvas.dataset.diagnosticsBounded = String(bounded)
    canvas.dataset.diagnosticOperations = String(diagnostics.recorder.retainedOperationCount)
    canvas.dataset.diagnosticIncidents = String(diagnostics.recorder.retainedIncidentCount)
    canvas.dataset.diagnosticEvidenceBytes = String(diagnostics.recorder.retainedEvidenceBytes)
    canvas.dataset.currentPendingNativeObservations = String(
        diagnostics.submissionNative.currentPendingNativeObservations
    )
    canvas.dataset.currentEffectfulSubmittedWork = String(
        diagnostics.submissionNative.currentEffectfulSubmittedWork
    )
    canvas.dataset.uncapturedErrors = String(diagnostics.aggregates.uncapturedErrors)
    canvas.dataset.deviceLosses = String(diagnostics.aggregates.deviceLosses)
}

function adapterFacts(runtime: GPURuntime) {

    const info = runtime.adapter?.info
    return frozenJson({
        featureCount: Array.from(runtime.adapterFeatures).length,
        maxTextureDimension2D: runtime.adapterLimits.maxTextureDimension2D,
        ...(info === undefined ? {} : {
            vendor: info.vendor,
            architecture: info.architecture,
            device: info.device,
            description: info.description,
        }),
    })
}

function createFailureProofController(configuration: FailureConfiguration) {

    let runtime: GPURuntime | undefined
    let surface: Surface | undefined
    let capture: GPUDiagnosticCapture | undefined
    let captureReport: GPUDiagnosticCaptureReport | undefined
    let runtimeEvidence: GPURuntimeDiagnosticsEvidence | undefined
    let runtimeEvidenceByteLength: number | undefined
    let evidenceFailure: unknown
    let reachedCount = 0
    let mapAcquiredCount = 0
    let rasterAcquiredCount = 0

    function assertConfiguration() {

        if (configuration.scenario !== undefined && !FAILURE_SCENARIOS.includes(configuration.scenario)) {
            throw new Error(`Unsupported DEM Layer failure scenario: ${configuration.scenario}`)
        }
    }

    function reach(scenario: string) {

        if (configuration.scenario !== scenario) return
        reachedCount++
        const error = new Error(
            `Injected DEM Layer initialization failure: ${scenario}`
        ) as FailureDetails
        error.name = 'DemLayerInjectedFailure'
        error.code = 'DEM_LAYER_INJECTED_FAILURE'
        error.scenario = scenario
        throw error
    }

    function terrainShaderForProof(source: string) {

        if (configuration.scenario !== FAILURE_SCENARIOS[1]) return source
        return `${source}\n@vertex fn demInjectedFailure( {`
    }

    function beforeTerrainShaderModule(value: GPURuntime) {

        if (configuration.scenario !== FAILURE_SCENARIOS[1]) return
        reachedCount++
        runtime = value
        capture = runtime.diagnostics.capture(FAILURE_CAPTURE_BOUNDS)
    }

    function captureBeforeDisposal() {

        try {
            if (capture !== undefined) captureReport = capture.stop()
            if (runtime !== undefined) {
                runtimeEvidence = runtime.diagnostics.exportEvidence()
                runtimeEvidenceByteLength = new TextEncoder()
                    .encode(JSON.stringify(runtimeEvidence)).byteLength
                if (runtimeEvidenceByteLength > FAILURE_RUNTIME_EVIDENCE_MAX_BYTES) {
                    throw new Error(
                        `DEM runtime evidence exceeded ${FAILURE_RUNTIME_EVIDENCE_MAX_BYTES} bytes`
                    )
                }
            }
        } catch (error) {
            evidenceFailure = error
        }
    }

    function finalize(primaryFailure: unknown, cleanupReport: CleanupReport) {

        if (configuration.scenario === undefined) return undefined
        const diagnostic = (primaryFailure as FailureDetails | null | undefined)?.diagnostic
        const incident = (primaryFailure as FailureDetails | null | undefined)?.context?.incident
        const proof = {
            schemaVersion: 1,
            scenario: configuration.scenario,
            reachedCount,
            mapAcquiredCount,
            rasterAcquiredCount,
            primaryFailure: serializeFailure(primaryFailure),
            ...(diagnostic === undefined ? {} : { diagnostic }),
            ...(incident === undefined ? {} : { incident }),
            runtimeEvidence,
            runtimeEvidenceByteLength,
            runtimeEvidenceMaxBytes: FAILURE_RUNTIME_EVIDENCE_MAX_BYTES,
            ...(captureReport === undefined ? {} : {
                captureBounds: FAILURE_CAPTURE_BOUNDS,
                captureReport,
            }),
            ...(evidenceFailure === undefined
                ? {}
                : { evidenceFailure: serializeFailure(evidenceFailure) }),
            cleanup: serializeCleanupReport(cleanupReport),
        }
        const serialized = JSON.stringify(proof)
        runtime = undefined
        surface = undefined
        capture = undefined
        return frozenJson({
            ...proof,
            retainsWgslSource: serialized.includes('struct VertexInput') ||
                serialized.includes('@vertex fn vMain'),
        })
    }

    return Object.freeze({
        assertConfiguration,
        reach,
        terrainShader: terrainShaderForProof,
        beforeTerrainShaderModule,
        captureBeforeDisposal,
        finalize,
        observeRuntime: (value: GPURuntime) => { runtime = value },
        observeSurface: (value: Surface) => { surface = value },
        mapAcquired: () => { mapAcquiredCount++ },
        rasterAcquired: () => { rasterAcquiredCount++ },
    })
}

async function failPage(error: unknown) {

    if (pageSettlement !== undefined) return pageSettlement
    reportFatalError(error)
    failureProof.captureBeforeDisposal()
    pageSettlement = pageLifetime.dispose(error).then(cleanupReport => {
        const proof = failureProof.finalize(error, cleanupReport)
        if (proof !== undefined) {
            window.__DEM_LAYER_INIT_FAILURE_PROOF__ = proof
            canvas.dataset.initFailureProof = JSON.stringify(proof)
            canvas.dataset.failureScenario = proof.scenario
        }
        return proof
    }).catch((cleanupFailure: unknown) => {
        console.error(cleanupFailure)
    })
    return pageSettlement
}

async function disposePage() {

    if (pageSettlement !== undefined) return pageSettlement
    pageSettlement = pageLifetime.dispose().then(report => {
        const cleanupProof = frozenJson({
            report: serializeCleanupReport(report),
            lifecycle: pageLifetime.snapshot(),
            graphState: pageContext?.graph.state(),
            virtualRaster: pageContext?.graph.virtualRasterFacts(),
        })
        window.__DEM_LAYER_CLEANUP_PROOF__ = cleanupProof
        canvas.dataset.cleanupProof = JSON.stringify(cleanupProof)
        setStatus(report.cleanupFailures.length === 0 ? 'disposed' : 'error')
        return cleanupProof
    })
    return pageSettlement
}

function serializeCleanupReport(report: CleanupReport) {

    return {
        primaryFailure: serializeFailure(report.primaryFailure),
        cleanupInvocationCount: report.cleanupInvocationCount,
        pendingObservationsBefore: report.pendingObservationsBefore,
        pendingObservationsAfter: report.pendingObservationsAfter,
        retainedActionCount: report.retainedActionCount,
        cleanupActions: report.cleanupActions,
        cleanupFailures: report.cleanupFailures.map(({ phase, label, error }) => ({
            phase,
            label,
            error: serializeFailure(error),
        })),
    }
}

function serializeFailure(error: unknown) {

    if (error === undefined) return undefined
    if (!(error instanceof Error)) return { name: 'NonErrorFailure', message: String(error) }
    return {
        name: error.name,
        message: error.message,
        ...(typeof (error as FailureDetails).code === 'string'
            ? { code: (error as FailureDetails).code as string }
            : {}),
        ...(typeof (error as FailureDetails).scenario === 'string'
            ? { scenario: (error as FailureDetails).scenario as string }
            : {}),
        ...((error as FailureDetails).diagnostic?.code === undefined
            ? {}
            : { diagnosticCode: (error as FailureDetails).diagnostic!.code }),
        ...(typeof error.stack === 'string' ? { stack: error.stack.slice(0, 8 * 1024) } : {}),
    }
}

function canvasPixelSize(target: HTMLElement): SurfaceSize {

    const ratio = window.devicePixelRatio || 1
    return {
        width: Math.max(1, Math.floor(target.clientWidth * ratio)),
        height: Math.max(1, Math.floor(target.clientHeight * ratio)),
    }
}

function sameSize(left: SurfaceSize, right: SurfaceSize) {

    return left.width === right.width && left.height === right.height
}

function boundedIntegerParameter(
    value: string | null,
    fallback: number,
    minimum: number,
    maximum: number
) {

    if (value === null) return fallback
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
        throw new RangeError(
            `DEM integer parameter must be between ${minimum} and ${maximum}`
        )
    }
    return parsed
}

function readPublishedFacts() {

    return Object.freeze({ ...canvas.dataset })
}

function setStatus(status: string) {

    canvas.dataset.status = status
    document.body.dataset.status = status
}

function reportFatalError(error: unknown) {

    setStatus('error')
    canvas.dataset.error = error instanceof Error ? error.message : String(error)
    if ((error as FailureDetails | null | undefined)?.diagnostic !== undefined) {
        canvas.dataset.diagnostic = JSON.stringify((error as FailureDetails).diagnostic)
    }
    console.error(error)
}

function frozenJson<T>(value: T): T {

    return deepFreeze(JSON.parse(JSON.stringify(value)) as unknown as T)
}

function deepFreeze<T>(value: T): T {

    if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
    for (const child of Object.values(value)) deepFreeze(child)
    return Object.freeze(value) as T
}
