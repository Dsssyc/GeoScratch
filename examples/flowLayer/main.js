import { ScratchRuntime } from 'geoscratch'
import {
    FIELD_COUNT,
    PARTICLE_BLOCK_SIZE,
    PARTICLE_COUNT,
    STAGE_ORDER,
    createFlowLayer,
} from './flow-layer.js'
import { createFlowLifecycle } from './flow-lifecycle.js'
import { createFlowMap, readFlowCameraState, waitForFlowMap } from './flow-map.js'

const canvas = document.getElementById('GPUFrame')
const FAILURE_RUNTIME_EVIDENCE_MAX_BYTES = 512 * 1024
const FAILURE_CAPTURE_BOUNDS = Object.freeze({
    maxOperations: 1,
    maxDurationMs: 2_000,
    maxEvidenceBytes: 64 * 1024,
    includeStacks: true,
    includeDescriptors: true,
})
const FAILURE_SCENARIOS = Object.freeze([
    'after-worker-acquisition',
    'invalid-simulation-pipeline-wgsl',
])
const parameters = new URLSearchParams(window.location.search)
const proofMode = parameters.get('proof') === '1'
const requestedFailureScenario = parameters.get('fault')
const failureConfiguration = Object.freeze({
    scenario: proofMode && requestedFailureScenario !== null
        ? requestedFailureScenario
        : undefined,
})
const flowOptions = Object.freeze({
    historyMode: parameters.get('history') ?? 'reproject',
    showVoronoi: parameters.get('field') !== '0',
    showArrow: parameters.get('arrows') === '1',
})
const pageLifetime = createFlowLifecycle()
const failureProof = createFailureProofController(failureConfiguration)
let pageSettlement
let pageCleanupContext
const handlePageHide = () => {
    void disposePage()
}

window.addEventListener('pagehide', handlePageHide, { once: true })
pageLifetime.deferStop({
    label: 'pagehide-listener',
    run: () => window.removeEventListener('pagehide', handlePageHide),
})

setStatus('loading')
void main(pageLifetime, failureProof).catch(error => {
    if (pageLifetime.isStopError(error)) return
    void failPage(error)
})

async function main(lifetime, proof) {

    proof.assertConfiguration()
    const worker = lifetime.ownWorker(new Worker(
        new URL('./flow-worker.js', import.meta.url),
        { type: 'module' }
    ))
    proof.workerAcquired()
    const fieldStream = createFieldStream(worker, lifetime)
    proof.reach(FAILURE_SCENARIOS[0])

    const map = lifetime.ownMap(createFlowMap(canvas, { proof: proofMode }))
    const mapReady = waitForFlowMap(map, lifetime.signal)
    const runtimeReady = lifetime.acquireRuntime(ScratchRuntime.create({
        label: 'Flow Layer runtime',
        powerPreference: 'high-performance',
        diagnostics: {
            operationCapacity: 256,
            incidentCapacity: 32,
            evidenceByteCapacity: 256 * 1024,
            submissionScopes: 'summary',
            maxPendingNativeObservations: 8,
        },
    }))
    const [ runtime ] = await Promise.all([ runtimeReady, mapReady ])
    proof.observeRuntime(runtime)
    lifetime.assertActive('continue Flow initialization')

    const initialSize = canvasPixelSize(canvas)
    const surface = runtime.createSurface(canvas, {
        label: 'Flow Layer surface',
        format: 'preferred',
        alphaMode: 'premultiplied',
        size: initialSize,
    })
    proof.observeSurface(surface)
    const graph = await createFlowLayer({
        runtime,
        surface,
        map,
        lifetime,
        loadField: fieldStream.request,
        size: initialSize,
        random: proofMode ? seededRandom(0x6d2b79f5) : Math.random,
        options: flowOptions,
        failureProof: proof,
    })
    lifetime.assertActive('continue Flow initialization')
    let active = true
    let animationFrame
    let animationTimer
    let submittedFrames = 0
    let observedFrames = 0
    let latestProvenance = []
    let frameWorkScheduled = 0
    let frameWorkCompleted = 0
    let frameWorkCancelled = 0

    registerCameraListeners(map, graph, lifetime)

    function stopScheduling() {

        active = false
        if (animationTimer !== undefined) {
            clearTimeout(animationTimer)
            animationTimer = undefined
            frameWorkCancelled++
        }
        if (animationFrame !== undefined) {
            cancelAnimationFrame(animationFrame)
            animationFrame = undefined
            frameWorkCancelled++
        }
    }

    lifetime.deferStop({ label: 'flow-frame-scheduler', run: stopScheduling })
    pageCleanupContext = { fieldStream }

    function publish() {

        publishFrameFacts({
            runtime,
            graph,
            fieldStream,
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

    window.__FLOW_LAYER_PROOF__ = Object.freeze({
        pauseAndDrain,
        dispose: disposePage,
        facts: readPublishedFacts,
    })
    publishGraphFacts(graph)

    function scheduleFrame() {

        const delay = proofMode ? 0 : 1000 / 45
        animationTimer = window.setTimeout(() => {
            animationTimer = undefined
            frameWorkCompleted++
            if (!active) return
            animationFrame = requestAnimationFrame(render)
            frameWorkScheduled++
        }, delay)
        frameWorkScheduled++
    }

    async function render() {

        if (animationFrame !== undefined) {
            animationFrame = undefined
            frameWorkCompleted++
        }
        if (!active) return

        try {
            const nextSize = canvasPixelSize(canvas)
            if (!sameSize(surface.size, nextSize)) {
                await graph.resize(nextSize)
                if (!active) return
            }
            map.triggerRepaint()
            const camera = readFlowCameraState(map, nextSize)
            const frame = await graph.renderFrame(camera)
            submittedFrames++
            latestProvenance = frame.provenance
            publish()

            const frameNumber = submittedFrames
            await lifetime.track(frame.observation, `flow-frame-${frameNumber}`)
            observedFrames = Math.max(observedFrames, frameNumber)
            publish()
            if (active) setStatus('ready')
        } catch (error) {
            active = false
            await failPage(error)
            return
        }

        if (active) scheduleFrame()
    }

    animationFrame = requestAnimationFrame(render)
    frameWorkScheduled++
}

function createFieldStream(worker, lifetime) {

    const pending = new Map()
    let nextRequestId = 1
    let requests = 0
    let responses = 0
    let failures = 0
    let listenerRemoved = false

    const handleMessage = event => {
        const message = event.data
        if (message?.type !== 'field-loaded' && message?.type !== 'field-failed') return
        const request = pending.get(message.requestId)
        if (request === undefined) return
        pending.delete(message.requestId)
        if (message.type === 'field-failed') {
            failures++
            request.reject(deserializeWorkerError(message.error, message.url))
            return
        }
        responses++
        request.resolve({
            index: message.index,
            url: message.url,
            maxSpeed: message.maxSpeed,
            uvs: message.uvs,
        })
    }
    const handleError = event => {
        failures++
        const error = new Error(event.message || 'Flow worker failed')
        for (const request of pending.values()) request.reject(error)
        pending.clear()
    }

    worker.addEventListener('message', handleMessage)
    worker.addEventListener('error', handleError)
    lifetime.deferStop({
        label: 'flow-worker-listeners',
        run: () => {
            if (listenerRemoved) return
            listenerRemoved = true
            worker.removeEventListener('message', handleMessage)
            worker.removeEventListener('error', handleError)
            const error = new Error('Flow worker stream stopped')
            for (const request of pending.values()) request.reject(error)
            pending.clear()
        },
    })

    function request(index) {

        lifetime.assertActive('request Flow field')
        if (!Number.isInteger(index) || index < 0 || index >= FIELD_COUNT) {
            return Promise.reject(new RangeError(`Invalid Flow field index: ${index}`))
        }
        const requestId = nextRequestId++
        const url = `/json/examples/flow/uv_${index}.bin`
        requests++
        const promise = new Promise((resolve, reject) => {
            pending.set(requestId, { resolve, reject, index, url })
        })
        worker.postMessage({ type: 'load-field', requestId, index, url })
        return promise
    }

    return Object.freeze({
        request,
        snapshot: () => Object.freeze({
            requests,
            responses,
            failures,
            pending: pending.size,
            listenerRemoved,
        }),
    })
}

function registerCameraListeners(map, graph, lifetime) {

    if (graph.settings.historyMode === 'off') return
    const movingEvents = [
        'movestart', 'move', 'dragstart', 'drag', 'zoomstart',
        'zoom', 'rotatestart', 'rotate', 'pitchstart', 'pitch',
    ]
    const settledEvents = [ 'moveend', 'dragend', 'zoomend', 'rotateend', 'pitchend' ]
    const moving = () => graph.cameraMoving()
    const settled = () => graph.cameraSettled()

    for (const eventName of movingEvents) map.on(eventName, moving)
    for (const eventName of settledEvents) map.on(eventName, settled)
    lifetime.deferStop({
        label: 'flow-camera-listeners',
        run: () => {
            for (const eventName of movingEvents) map.off(eventName, moving)
            for (const eventName of settledEvents) map.off(eventName, settled)
        },
    })
}

function publishGraphFacts(graph) {

    canvas.dataset.stageOrder = STAGE_ORDER.join('|')
    canvas.dataset.stageCount = String(STAGE_ORDER.length)
    canvas.dataset.particleCount = String(PARTICLE_COUNT)
    canvas.dataset.particleBlockSize = String(PARTICLE_BLOCK_SIZE)
    canvas.dataset.historyDirectionCount = '2'
    canvas.dataset.stableIdentityCount = String(graph.stableIdentities.length)
    canvas.dataset.stableIdentityHash = graph.stableIdentityHash
    canvas.dataset.proofMode = String(proofMode)
    canvas.dataset.seed = proofMode ? '0x6d2b79f5' : 'random'
    canvas.dataset.fixedTimestep = String(proofMode)
    canvas.dataset.historyMode = graph.settings.historyMode
    canvas.dataset.graphContract = JSON.stringify(graph.contractFacts())
}

function publishFrameFacts({
    runtime,
    graph,
    fieldStream,
    lifetime,
    submittedFrames,
    observedFrames,
    latestProvenance,
    frameWork,
}) {

    const state = graph.state()
    const stream = fieldStream.snapshot()
    const lifecycle = lifetime.snapshot()
    const diagnostics = runtime.diagnostics.snapshot()
    const bounded = diagnostics.recorder.retainedOperationCount <= diagnostics.recorder.operationCapacity &&
        diagnostics.recorder.retainedIncidentCount <= diagnostics.recorder.incidentCapacity &&
        diagnostics.recorder.retainedEvidenceBytes <= diagnostics.recorder.evidenceByteCapacity

    canvas.dataset.frames = String(submittedFrames)
    canvas.dataset.observedFrames = String(observedFrames)
    canvas.dataset.resizeGeneration = String(state.resizeGeneration)
    canvas.dataset.workerTransitions = String(state.workerTransitions)
    canvas.dataset.workerRequests = String(stream.requests)
    canvas.dataset.workerResponses = String(stream.responses)
    canvas.dataset.workerFailures = String(stream.failures)
    canvas.dataset.workerPending = String(stream.pending)
    canvas.dataset.fromFieldIndex = String(state.fromFieldIndex)
    canvas.dataset.toFieldIndex = String(state.toFieldIndex)
    canvas.dataset.fieldProgress = String(state.progress)
    canvas.dataset.historyDirection = state.historyDirection
    canvas.dataset.cameraMoveCount = String(state.cameraMoveCount)
    canvas.dataset.cameraSettleCount = String(state.cameraSettleCount)
    canvas.dataset.historyReprojectionFrames = String(state.historyReprojectionFrames)
    canvas.dataset.historyClearFrames = String(state.historyClearFrames)
    canvas.dataset.historyValid = String(state.historyValid)
    canvas.dataset.stageActivity = JSON.stringify(state.stageActivity)
    canvas.dataset.provenance = JSON.stringify(latestProvenance)
    canvas.dataset.persistentFacts = JSON.stringify(graph.persistentFacts())
    canvas.dataset.pendingObservationCount = String(lifecycle.pendingObservationCount)
    canvas.dataset.frameWork = JSON.stringify(frameWork)
    canvas.dataset.diagnosticsBounded = String(bounded)
    canvas.dataset.diagnosticOperationCapacity = String(diagnostics.recorder.operationCapacity)
    canvas.dataset.diagnosticIncidentCapacity = String(diagnostics.recorder.incidentCapacity)
    canvas.dataset.diagnosticEvidenceByteCapacity = String(diagnostics.recorder.evidenceByteCapacity)
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

function createFailureProofController(configuration) {

    let runtime
    let surface
    let capture
    let captureReport
    let runtimeEvidence
    let runtimeEvidenceByteLength
    let evidenceFailure
    let reachedCount = 0
    let workerAcquiredCount = 0

    function assertConfiguration() {

        if (configuration.scenario !== undefined && !FAILURE_SCENARIOS.includes(configuration.scenario)) {
            throw new Error(`Unsupported Flow Layer failure scenario: ${configuration.scenario}`)
        }
    }

    function reach(scenario) {

        if (configuration.scenario !== scenario) return
        reachedCount++
        const error = new Error(`Injected Flow Layer initialization failure: ${scenario}`)
        error.name = 'FlowLayerInjectedFailure'
        error.code = 'FLOW_LAYER_INJECTED_FAILURE'
        error.scenario = scenario
        throw error
    }

    function simulationShader(source) {

        if (configuration.scenario !== FAILURE_SCENARIOS[1]) return source
        return `${source}\n@compute fn flowInjectedFailure( {`
    }

    function beforeSimulationPipeline(value) {

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
                        `Flow runtime evidence exceeded ${FAILURE_RUNTIME_EVIDENCE_MAX_BYTES} bytes`
                    )
                }
            }
        } catch (error) {
            evidenceFailure = error
        }
    }

    function finalize(primaryFailure, cleanupReport) {

        if (configuration.scenario === undefined) return undefined
        const diagnostic = primaryFailure && typeof primaryFailure === 'object'
            ? primaryFailure.diagnostic
            : undefined
        const incident = primaryFailure && typeof primaryFailure === 'object'
            ? primaryFailure.incident
            : undefined
        const proof = frozenJson({
            schemaVersion: 1,
            scenario: configuration.scenario,
            reachedCount,
            workerAcquiredCount,
            primaryFailure: serializeFailure(primaryFailure),
            ...(diagnostic !== undefined ? { diagnostic } : {}),
            ...(incident !== undefined ? { incident } : {}),
            runtimeEvidence,
            runtimeEvidenceByteLength,
            runtimeEvidenceMaxBytes: FAILURE_RUNTIME_EVIDENCE_MAX_BYTES,
            ...(captureReport !== undefined ? {
                captureBounds: FAILURE_CAPTURE_BOUNDS,
                captureReport,
            } : {}),
            ...(evidenceFailure !== undefined
                ? { evidenceFailure: serializeFailure(evidenceFailure) }
                : {}),
            cleanup: serializeCleanupReport(cleanupReport),
        })
        runtime = undefined
        surface = undefined
        capture = undefined
        return proof
    }

    return Object.freeze({
        assertConfiguration,
        reach,
        simulationShader,
        beforeSimulationPipeline,
        captureBeforeDisposal,
        finalize,
        observeRuntime: value => { runtime = value },
        observeSurface: value => { surface = value },
        workerAcquired: () => { workerAcquiredCount++ },
    })
}

async function failPage(error) {

    if (pageSettlement !== undefined) return pageSettlement
    reportFatalError(error)
    failureProof.captureBeforeDisposal()
    pageSettlement = pageLifetime.dispose(error).then(cleanupReport => {
        const proof = failureProof.finalize(error, cleanupReport)
        if (proof !== undefined) {
            window.__FLOW_LAYER_INIT_FAILURE_PROOF__ = proof
            canvas.dataset.initFailureProof = JSON.stringify(proof)
            canvas.dataset.failureScenario = proof.scenario
        }
        return proof
    }).catch(cleanupFailure => {
        console.error(cleanupFailure)
    })
    return pageSettlement
}

async function disposePage() {

    if (pageSettlement !== undefined) return pageSettlement
    pageSettlement = pageLifetime.dispose().then(report => {
        const cleanupProof = frozenJson({
            report: serializeCleanupReport(report),
            ...(pageCleanupContext === undefined
                ? {}
                : { stream: pageCleanupContext.fieldStream.snapshot() }),
            lifecycle: pageLifetime.snapshot(),
        })
        window.__FLOW_LAYER_CLEANUP_PROOF__ = cleanupProof
        canvas.dataset.cleanupProof = JSON.stringify(cleanupProof)
        setStatus(report.cleanupFailures.length === 0 ? 'disposed' : 'error')
        return cleanupProof
    })
    return pageSettlement
}

function serializeCleanupReport(report) {

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

function serializeFailure(error) {

    if (error === undefined) return undefined
    if (!(error instanceof Error)) return { name: 'NonErrorFailure', message: String(error) }
    return {
        name: error.name,
        message: error.message,
        ...(typeof error.code === 'string' ? { code: error.code } : {}),
        ...(typeof error.scenario === 'string' ? { scenario: error.scenario } : {}),
        ...(error.diagnostic?.code !== undefined
            ? { diagnosticCode: error.diagnostic.code }
            : {}),
        ...(typeof error.stack === 'string' ? { stack: error.stack.slice(0, 8 * 1024) } : {}),
    }
}

function deserializeWorkerError(error, url) {

    const failure = new Error(error?.message ?? `Flow worker failed for ${url}`)
    failure.name = error?.name ?? 'FlowWorkerError'
    return failure
}

function canvasPixelSize(target) {

    const ratio = window.devicePixelRatio || 1
    return {
        width: Math.max(1, Math.floor(target.clientWidth * ratio)),
        height: Math.max(1, Math.floor(target.clientHeight * ratio)),
    }
}

function sameSize(left, right) {

    return left.width === right.width && left.height === right.height
}

function seededRandom(seed) {

    let state = seed >>> 0
    return () => {
        state += 0x6d2b79f5
        let value = state
        value = Math.imul(value ^ value >>> 15, value | 1)
        value ^= value + Math.imul(value ^ value >>> 7, value | 61)
        return ((value ^ value >>> 14) >>> 0) / 4294967296
    }
}

function readPublishedFacts() {

    return Object.freeze({ ...canvas.dataset })
}

function setStatus(status) {

    canvas.dataset.status = status
    document.body.dataset.status = status
}

function reportFatalError(error) {

    setStatus('error')
    canvas.dataset.error = error instanceof Error ? error.message : String(error)
    if (error?.diagnostic !== undefined) {
        canvas.dataset.diagnostic = JSON.stringify(error.diagnostic)
    }
    console.error(error)
}

function frozenJson(value) {

    return deepFreeze(JSON.parse(JSON.stringify(value)))
}

function deepFreeze(value) {

    if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
    for (const child of Object.values(value)) deepFreeze(child)
    return Object.freeze(value)
}
