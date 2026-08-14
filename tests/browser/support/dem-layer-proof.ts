import type {
    GPUDiagnosticCapture,
    GPUDiagnosticCaptureReport,
    GPURuntime,
    GPURuntimeDiagnosticsEvidence,
    LifetimeScope,
} from 'geoscratch/scratch'
import type {
    GeoFrameController,
    MapLibrePlanarCameraState,
    WebMercatorTerrainProvenanceFact,
    WebMercatorTerrainRenderer,
    VirtualRasterRuntimeFacts,
    VirtualRasterWorkerExecutorFacts,
} from 'geoscratch/geo'
import type { DemMap } from '../../../examples/demLayer/dem-map.ts'
import type { DemTileSourceFacts } from '../../../examples/demLayer/dem-source.ts'
import type {
    DemCachePolicy,
    DemTileCacheFacts,
    DemTileWorkerFacts,
} from '../../../examples/demLayer/dem-tile-protocol.ts'

type DemTerrainPresentation = 'shaded' | 'tile-wireframe'
type DemLayer = WebMercatorTerrainRenderer<
    MapLibrePlanarCameraState,
    DemTerrainPresentation
>
type DemVirtualRasterFacts = Readonly<{
    runtime: VirtualRasterRuntimeFacts
    source: DemTileSourceFacts
    worker: VirtualRasterWorkerExecutorFacts<DemTileWorkerFacts>
}>
type CleanupReport = Awaited<ReturnType<LifetimeScope['dispose']>>
type CameraMoveOptions = Parameters<DemMap['jumpTo']>[0]
type FailureDetails = Error & {
    code?: unknown
    scenario?: unknown
    diagnostic?: { code?: unknown }
    context?: { incident?: unknown }
}
type CleanupProof = Readonly<{
    report: ReturnType<typeof serializeCleanupReport>
    lifecycle: ReturnType<LifetimeScope['snapshot']>
    graphState?: ReturnType<DemLayer['state']>
    virtualRaster?: ReturnType<typeof demVirtualRasterProofFacts>
}>
type FailureProof = NonNullable<ReturnType<typeof finalizeFailureProof>>

type ProofConfiguration = Readonly<{
    canvas: HTMLCanvasElement
    lifetime: LifetimeScope
    scenario?: string
    tileServerUrl: string
    cachePolicy: DemCachePolicy
    maxPhysicalPages: number
    controlPanel: Readonly<{
        source: 'url' | 'storage' | 'default'
        storageStatus: 'missing' | 'valid' | 'invalid' | 'unavailable'
        renderingStorageStatus: 'missing' | 'valid' | 'invalid' | 'unavailable'
    }>
}>

type GraphBinding = Readonly<{
    runtime: GPURuntime
    graph: DemLayer
    lifetime: LifetimeScope
    frameController: GeoFrameController
    virtualRasterFacts(): DemVirtualRasterFacts
    dispose(): Promise<unknown>
    moveCamera(options: CameraMoveOptions): void
    setStatus(status: string): void
}>

declare global {
    interface Window {
        __DEM_LAYER_PROOF__: Readonly<{
            pauseAndDrain(): Promise<Readonly<DOMStringMap>>
            dispose(): Promise<unknown>
            facts(): Readonly<DOMStringMap>
            moveCamera(options: CameraMoveOptions): void
        }>
        __DEM_LAYER_INIT_FAILURE_PROOF__: FailureProof
        __DEM_LAYER_CLEANUP_PROOF__: CleanupProof
    }
}

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

export function createDemLayerProof(configuration: ProofConfiguration) {

    const { canvas } = configuration
    let runtime: GPURuntime | undefined
    let graphBinding: GraphBinding | undefined
    let capture: GPUDiagnosticCapture | undefined
    let captureReport: GPUDiagnosticCaptureReport | undefined
    let runtimeEvidence: GPURuntimeDiagnosticsEvidence | undefined
    let runtimeEvidenceByteLength: number | undefined
    let evidenceFailure: unknown
    let reachedCount = 0
    let mapAcquiredCount = 0
    let rasterAcquiredCount = 0
    let submittedFrames = 0
    let observedFrames = 0
    let latestProvenance: readonly WebMercatorTerrainProvenanceFact[] = []
    let latestCamera: MapLibrePlanarCameraState | undefined

    function assertConfiguration() {

        if (configuration.scenario !== undefined &&
            !FAILURE_SCENARIOS.includes(configuration.scenario)) {
            throw new Error(
                `Unsupported DEM Layer failure scenario: ${configuration.scenario}`
            )
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

    function terrainShader(source: string) {

        if (configuration.scenario !== FAILURE_SCENARIOS[1]) return source
        return `${source}\n@vertex fn demInjectedFailure( {`
    }

    function beforeTerrainShaderModule(value: GPURuntime) {

        if (configuration.scenario !== FAILURE_SCENARIOS[1]) return
        reachedCount++
        runtime = value
        capture = runtime.diagnostics.capture(FAILURE_CAPTURE_BOUNDS)
    }

    function bindGraph(binding: GraphBinding) {

        graphBinding = binding
        runtime = binding.runtime
        publishGraphFacts(configuration, binding.runtime, binding.graph)
        publish()
        window.__DEM_LAYER_PROOF__ = Object.freeze({
            async pauseAndDrain() {
                binding.frameController.stop()
                await binding.lifetime.drain()
                publish()
                binding.setStatus('stopped')
                return facts()
            },
            dispose: binding.dispose,
            facts,
            moveCamera: binding.moveCamera,
        })
    }

    function publish() {

        if (graphBinding === undefined) return
        publishFrameFacts({
            canvas,
            runtime: graphBinding.runtime,
            graph: graphBinding.graph,
            lifetime: graphBinding.lifetime,
            submittedFrames,
            observedFrames,
            latestProvenance,
            latestCamera,
            frameController: graphBinding.frameController,
            virtualRasterFacts: graphBinding.virtualRasterFacts,
            cachePolicy: configuration.cachePolicy,
        })
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

    function finalizeFailure(error: unknown, cleanupReport: CleanupReport) {

        const proof = finalizeFailureProof({
            configuration,
            primaryFailure: error,
            cleanupReport,
            reachedCount,
            mapAcquiredCount,
            rasterAcquiredCount,
            runtimeEvidence,
            runtimeEvidenceByteLength,
            captureReport,
            evidenceFailure,
        })
        runtime = undefined
        capture = undefined
        if (proof !== undefined) {
            window.__DEM_LAYER_INIT_FAILURE_PROOF__ = proof
            canvas.dataset.initFailureProof = JSON.stringify(proof)
            canvas.dataset.failureScenario = proof.scenario
        }
        return proof
    }

    function finalizeCleanup(report: CleanupReport) {

        const cleanupProof = frozenJson({
            report: serializeCleanupReport(report),
            lifecycle: configuration.lifetime.snapshot(),
            graphState: graphBinding?.graph.state(),
            virtualRaster: graphBinding === undefined
                ? undefined
                : demVirtualRasterProofFacts(
                    graphBinding.virtualRasterFacts(),
                    configuration.cachePolicy
                ),
        }) as CleanupProof
        window.__DEM_LAYER_CLEANUP_PROOF__ = cleanupProof
        canvas.dataset.cleanupProof = JSON.stringify(cleanupProof)
        return cleanupProof
    }

    return Object.freeze({
        assertConfiguration,
        reach,
        terrainShader,
        beforeTerrainShaderModule,
        bindGraph,
        publish,
        captureBeforeDisposal,
        finalizeFailure,
        finalizeCleanup,
        observeRuntime: (value: GPURuntime) => { runtime = value },
        mapAcquired: () => { mapAcquiredCount++ },
        rasterAcquired: () => { rasterAcquiredCount++ },
        frameSubmitted(
            provenance: readonly WebMercatorTerrainProvenanceFact[],
            camera: MapLibrePlanarCameraState
        ) {
            submittedFrames++
            latestProvenance = provenance
            latestCamera = camera
            publish()
        },
        frameObserved(frameNumber: number) {
            observedFrames = Math.max(observedFrames, frameNumber)
            publish()
        },
    })
}

function publishGraphFacts(
    configuration: ProofConfiguration,
    runtime: GPURuntime,
    graph: DemLayer
) {

    const { canvas, cachePolicy, controlPanel } = configuration
    const contract = graph.contractFacts()
    canvas.dataset.proofMode = 'true'
    canvas.dataset.stageOrder = contract.stageOrder.join('|')
    canvas.dataset.stageCount = String(contract.stageOrder.length)
    canvas.dataset.stableIdentityCount = String(graph.stableIdentities.length)
    canvas.dataset.stableIdentityHash = graph.stableIdentityHash
    canvas.dataset.graphContract = JSON.stringify(contract)
    canvas.dataset.countPath = contract.countPath
    canvas.dataset.selectionPath = contract.selectionPath
    canvas.dataset.cpuSelectionUploadCount = '0'
    canvas.dataset.adapterAcquired = String(runtime.adapter !== undefined)
    canvas.dataset.adapter = JSON.stringify(adapterFacts(runtime))
    canvas.dataset.tileServer = configuration.tileServerUrl
    canvas.dataset.cacheMode = cachePolicy.mode
    canvas.dataset.cacheLifecycle = cacheLifecycleLabel(cachePolicy)
    canvas.dataset.cacheNamespace = cachePolicy.mode === 'persistent'
        ? cachePolicy.namespace
        : ''
    canvas.dataset.cacheMaxPayloadBytes = cachePolicy.mode === 'persistent'
        ? String(cachePolicy.maxPayloadBytes)
        : '0'
    canvas.dataset.cacheMaxEntries = cachePolicy.mode === 'persistent'
        ? String(cachePolicy.maxEntries)
        : '0'
    canvas.dataset.cachePersistenceRequested = cachePolicy.mode === 'persistent'
        ? String(cachePolicy.requestPersistence)
        : 'false'
    canvas.dataset.cachePanelSource = controlPanel.source
    canvas.dataset.cachePanelStorageStatus = controlPanel.storageStatus
    canvas.dataset.renderingStorageStatus = controlPanel.renderingStorageStatus
    canvas.dataset.maxPhysicalPages = String(configuration.maxPhysicalPages)
}

function publishFrameFacts({
    canvas,
    runtime,
    graph,
    lifetime,
    submittedFrames,
    observedFrames,
    latestProvenance,
    latestCamera,
    frameController,
    virtualRasterFacts,
    cachePolicy,
}: {
    canvas: HTMLCanvasElement
    runtime: GPURuntime
    graph: DemLayer
    lifetime: LifetimeScope
    submittedFrames: number
    observedFrames: number
    latestProvenance: readonly WebMercatorTerrainProvenanceFact[]
    latestCamera?: MapLibrePlanarCameraState
    frameController: GeoFrameController
    virtualRasterFacts(): DemVirtualRasterFacts
    cachePolicy: DemCachePolicy
}) {

    const state = graph.state()
    const lifecycle = lifetime.snapshot()
    const diagnostics = runtime.diagnostics.snapshot()
    const controller = frameController.snapshot()
    const frameWork = Object.freeze({
        scheduled: controller.scheduledFrameCount,
        completed: controller.completedFrameCount,
        cancelled: controller.cancelledFrameCount,
        active: controller.scheduledFrameCount - controller.completedFrameCount -
            controller.cancelledFrameCount,
    })
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
    canvas.dataset.renderPatchCount = String(state.renderPatchCount)
    canvas.dataset.renderPatchLevelRange = JSON.stringify(state.renderPatchLevelRange)
    canvas.dataset.renderPatchCellSpanRange = JSON.stringify(state.renderPatchCellSpanRange)
    canvas.dataset.renderPatchDescriptorOverflowCount = String(
        state.renderPatchDescriptorOverflowCount
    )
    canvas.dataset.renderPatchLookupOverflowCount = String(
        state.renderPatchLookupOverflowCount
    )
    canvas.dataset.renderPatchFrameEpoch = String(state.renderPatchFrameEpoch ?? '')
    canvas.dataset.renderPatchBaselineBudget = String(state.renderPatchBaselineBudget)
    canvas.dataset.renderPatchFrameBudget = String(state.renderPatchFrameBudget)
    canvas.dataset.renderPatchRequestedCount = String(state.renderPatchRequestedCount)
    canvas.dataset.renderPatchMinimumTrialCount = String(state.renderPatchMinimumTrialCount)
    canvas.dataset.renderPatchSourceRootCount = String(state.renderPatchSourceRootCount)
    canvas.dataset.renderPatchSelectedBiasLevels = String(
        state.renderPatchSelectedBiasLevels
    )
    canvas.dataset.renderPatchBudgetLimitedByMinimumTrial = String(
        state.renderPatchBudgetLimitedByMinimumTrial
    )
    canvas.dataset.renderPatchFeedback = JSON.stringify(state.renderPatchFeedback ?? null)
    canvas.dataset.convergenceState = state.convergenceState
    canvas.dataset.readbackInFlightCount = String(state.readbackInFlightCount)
    canvas.dataset.staleFeedbackCount = String(state.staleFeedbackCount)
    canvas.dataset.supersededFeedbackCount = String(state.supersededFeedbackCount)
    canvas.dataset.virtualSnapshotEpoch = String(state.virtualSnapshotEpoch)
    canvas.dataset.virtualRequestedPageCount = String(state.virtualRequestedPageCount)
    canvas.dataset.virtualRaster = JSON.stringify(demVirtualRasterProofFacts(
        virtualRasterFacts(),
        cachePolicy
    ))
    canvas.dataset.provenance = JSON.stringify(latestProvenance)
    canvas.dataset.frontier = JSON.stringify(state.frontierFacts ?? null)
    canvas.dataset.frontierDiagnostics = JSON.stringify(state.latestFeedbackDiagnostics)
    canvas.dataset.frontierConverged = String(state.convergenceState === 'converged')
    canvas.dataset.terrainPresentation = state.terrainPresentation
    canvas.dataset.cameraView = JSON.stringify(latestCamera === undefined ? null : {
        center: latestCamera.center,
        zoom: latestCamera.zoomHint,
        pitch: latestCamera.pitchDegrees,
        bearing: latestCamera.bearingDegrees,
        cameraHigh: latestCamera.cameraHigh,
        cameraLow: latestCamera.cameraLow,
        viewport: latestCamera.viewport,
    })
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

function demVirtualRasterProofFacts(
    facts: DemVirtualRasterFacts,
    policy: DemCachePolicy
) {

    const workers = facts.worker.workers
    const sum = (read: (worker: DemTileWorkerFacts) => number) =>
        workers.reduce((total, worker) => total + read(worker), 0)
    const sumCache = (read: (cache: DemTileCacheFacts) => number) =>
        workers.reduce((total, worker) => total + read(worker.cache), 0)
    return Object.freeze({
        ...facts.source,
        ...facts.runtime,
        cachePolicy: policy.mode,
        cacheConfiguration: policy,
        stopped: facts.runtime.disposed || facts.worker.disposed,
        worker: Object.freeze({
            ...facts.worker,
            cache: Object.freeze({
                mode: policy.mode,
                ...(policy.mode === 'none' ? {
                    requestPersistence: false,
                    maxPayloadBytes: 0,
                    maxEntries: 0,
                } : {
                    lifecycle: policy.lifecycle,
                    requestPersistence: policy.requestPersistence,
                    maxPayloadBytes: policy.maxPayloadBytes,
                    maxEntries: policy.maxEntries,
                }),
                entryCount: sumCache(cache => cache.entryCount),
                payloadBytes: sumCache(cache => cache.payloadBytes),
                hitCount: sumCache(cache => cache.hitCount),
                missCount: sumCache(cache => cache.missCount),
                putCount: sumCache(cache => cache.putCount),
                evictionCount: sumCache(cache => cache.evictionCount),
                quotaFailureCount: sumCache(cache => cache.quotaFailureCount),
            }),
            networkRequestCount: sum(worker => worker.networkRequestCount),
            decodedPageCount: sum(worker => worker.decodedPageCount),
            acceptedCandidateCount: sum(worker => worker.acceptedCandidateCount),
            discardedCandidateCount: sum(worker => worker.discardedCandidateCount),
            pendingCandidateCount: sum(worker => worker.pendingCandidateCount),
            maxPendingCandidateCount: Math.max(0, ...workers.map(worker =>
                worker.maxPendingCandidateCount
            )),
            senderDecodedByteLength: sum(worker => worker.senderDecodedByteLength),
        }),
    })
}

function finalizeFailureProof({
    configuration,
    primaryFailure,
    cleanupReport,
    reachedCount,
    mapAcquiredCount,
    rasterAcquiredCount,
    runtimeEvidence,
    runtimeEvidenceByteLength,
    captureReport,
    evidenceFailure,
}: Readonly<{
    configuration: ProofConfiguration
    primaryFailure: unknown
    cleanupReport: CleanupReport
    reachedCount: number
    mapAcquiredCount: number
    rasterAcquiredCount: number
    runtimeEvidence?: GPURuntimeDiagnosticsEvidence
    runtimeEvidenceByteLength?: number
    captureReport?: GPUDiagnosticCaptureReport
    evidenceFailure?: unknown
}>) {

    if (configuration.scenario === undefined) return undefined
    const details = primaryFailure as FailureDetails | null | undefined
    const proof = {
        schemaVersion: 1,
        scenario: configuration.scenario,
        reachedCount,
        mapAcquiredCount,
        rasterAcquiredCount,
        primaryFailure: serializeFailure(primaryFailure),
        ...(details?.diagnostic === undefined ? {} : { diagnostic: details.diagnostic }),
        ...(details?.context?.incident === undefined
            ? {}
            : { incident: details.context.incident }),
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
    return frozenJson({
        ...proof,
        retainsWgslSource: serialized.includes('struct VertexInput') ||
            serialized.includes('@vertex fn vMain'),
    })
}

function cacheLifecycleLabel(policy: DemCachePolicy): string {

    if (policy.mode === 'none') return 'none'
    return policy.lifecycle.kind === 'session'
        ? 'session'
        : `durable-${policy.lifecycle.open}`
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
    if (!(error instanceof Error)) {
        return { name: 'NonErrorFailure', message: String(error) }
    }
    const details = error as FailureDetails
    return {
        name: error.name,
        message: error.message,
        ...(typeof details.code === 'string' ? { code: details.code } : {}),
        ...(typeof details.scenario === 'string' ? { scenario: details.scenario } : {}),
        ...(details.diagnostic?.code === undefined
            ? {}
            : { diagnosticCode: details.diagnostic.code }),
        ...(typeof error.stack === 'string' ? { stack: error.stack.slice(0, 8 * 1024) } : {}),
    }
}

function facts(canvas: HTMLCanvasElement): Readonly<DOMStringMap>
function facts(): Readonly<DOMStringMap>
function facts(canvas?: HTMLCanvasElement): Readonly<DOMStringMap> {

    const target = canvas ?? document.getElementById('GPUFrame') as HTMLCanvasElement
    return Object.freeze({ ...target.dataset })
}

function frozenJson<T>(value: T): T {

    return deepFreeze(JSON.parse(JSON.stringify(value)) as unknown as T)
}

function deepFreeze<T>(value: T): T {

    if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
    for (const child of Object.values(value)) deepFreeze(child)
    return Object.freeze(value) as T
}
