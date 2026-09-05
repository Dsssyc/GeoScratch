import {
    GPURuntime,
    WorkerModuleCatalog,
    WorkerSystem,
} from 'geoscratch/scratch'
import type { LifetimeScope } from 'geoscratch/scratch'
import {
    createGeoFrameController,
    mapLibreFrameDriver,
    mapLibrePlanarViewSource,
} from 'geoscratch/geo'
import type {
    GeoFrameController,
    GeoFrameResult,
    GeoViewSourceCapture,
    MapLibrePlanarCameraState,
} from 'geoscratch/geo'
import { FLOW_FIELD_CACHE_DISABLED } from './cache-policy.ts'
import { loadFlowFieldDataset } from './flow-dataset.ts'
import { createReadyVelocitySampleRuntime } from './flow-ready-velocity-runtime.ts'
import { FLOW_FIELD_RUNTIME_BUDGETS } from './flow-runtime-budgets.ts'
import type { FlowFieldRuntimeBudgetFacts } from './flow-runtime-budgets.ts'
import {
    FlowTemporalFrameUnavailableError,
    createFlowFieldRenderer,
} from './flow-renderer.ts'
import type {
    FlowFieldRenderer,
    FlowFieldRendererFrame,
} from './flow-renderer.ts'
import { createFlowTemporalRuntimeWindow } from './flow-temporal-runtime-window.ts'
import type {
    FlowTemporalRequestResult,
    FlowTemporalRequestTicket,
    FlowTemporalRuntimeWindowSnapshot,
} from './flow-temporal-runtime-window.ts'
import { createFlowTimeline } from './flow-timeline.ts'
import { FLOW_FIELD_PRESENTATION, flowFieldPresentation } from './flow-presentation.ts'
import type { FlowFieldControlSnapshot, FlowFieldPresentation } from './flow-presentation.ts'
import type { FlowTemporalFrameSnapshot } from './flow-frame-provenance.ts'
import type {
    FlowTimelineLoop,
    FlowTimelineReadiness,
    FlowTimelineSnapshot,
} from './flow-timeline.ts'
import {
    createFlowFieldMap,
    flowFieldViewAdapter,
} from './map.ts'

export type FlowFieldApplicationOptions = Readonly<{
    lifetime: LifetimeScope
    canvas: HTMLCanvasElement
    proofMode: boolean
    tileServerUrl: string
    workerModuleManifestUrl: URL
    readWallTime(): number
    initialPlaying?: boolean
    initialRate?: number
    initialLoop?: FlowTimelineLoop
    initialZoom?: number
    initialPresentation?: FlowFieldPresentation
    onControlSnapshot?(snapshot: FlowFieldControlSnapshot): void
    fail(error: unknown): void | Promise<void>
    setStatus(status: string): void
}>

export type { FlowFieldRuntimeBudgetFacts } from './flow-runtime-budgets.ts'

export type FlowFieldApplicationFrame =
    | FlowFieldRendererFrame
    | Readonly<{
        state: 'loading'
        timelineRevision: number
        selectionRevision: number
        windowRequestRevision: number
    }>
    | Readonly<{
        state: 'gap'
        timelineRevision: number
        selectionRevision: number
        windowRequestRevision: number
        lowerSampleKey: string
        upperSampleKey: string
    }>
    | Readonly<{
        state: 'failed'
        timelineRevision: number
        selectionRevision: number
        windowRequestRevision: number
        failureCode: 'runtime-failed'
    }>

export type FlowFieldApplicationFacts = Readonly<{
    timeline: FlowTimelineSnapshot
    temporalWindow: FlowTemporalRuntimeWindowSnapshot
    handshake: Readonly<{
        timelineRevision: number
        selectionRevision: number
        windowRequestRevision: number
        status: 'pending' | FlowTemporalRequestResult['status']
    }>
    lastFrame: FlowFieldApplicationFrame
    budgets: FlowFieldRuntimeBudgetFacts
    frames: ReturnType<GeoFrameController['snapshot']>
    renderer: ReturnType<FlowFieldRenderer['facts']>
    workers: ReturnType<WorkerSystem['inspect']>
    diagnostics: ReturnType<GPURuntime['diagnostics']['snapshot']>
}>

export type FlowFieldApplication = Readonly<{
    play(input: Readonly<{ wallTime: number }>): FlowTimelineSnapshot
    pause(input: Readonly<{ wallTime: number }>): FlowTimelineSnapshot
    seek(input: Readonly<{ wallTime: number, modelTime: number }>): FlowTimelineSnapshot
    setRate(input: Readonly<{ wallTime: number, rate: number }>): FlowTimelineSnapshot
    setLoop(input: Readonly<{ wallTime: number, loop: FlowTimelineLoop }>): FlowTimelineSnapshot
    setPresentation(value: FlowFieldPresentation): void
    controlSnapshot(): FlowFieldControlSnapshot
    flush(input: Readonly<{ wallTime: number }>): Promise<FlowFieldApplicationFacts>
    facts(): FlowFieldApplicationFacts
}>

type WindowHandshake = {
    timelineRevision: number
    selectionRevision: number
    ticket: FlowTemporalRequestTicket
    status: 'pending' | FlowTemporalRequestResult['status']
}

/** Assembles the schema-two Flow Field dataset, model clock, runtime window, and renderer. */
export async function startFlowFieldApplication(
    options: FlowFieldApplicationOptions
): Promise<FlowFieldApplication> {

    const {
        lifetime,
        canvas,
        proofMode,
        tileServerUrl,
        workerModuleManifestUrl,
        setStatus,
    } = options
    if (typeof options?.readWallTime !== 'function') {
        throw new TypeError('Flow Field application requires one monotonic wall-time source')
    }
    const map = lifetime.own(createFlowFieldMap(canvas, {
        proof: proofMode,
        ...(options.initialZoom === undefined ? {} : { zoom: options.initialZoom }),
    }), {
        label: 'flow-field-maplibre-map',
        release: value => value.remove(),
    })
    const [ runtime, dataset, workerModules ] = await Promise.all([
        lifetime.acquire(GPURuntime.create({
            label: 'Flow Field runtime',
            powerPreference: 'high-performance',
            diagnostics: {
                operationCapacity: 256,
                incidentCapacity: 32,
                evidenceByteCapacity: 256 * 1024,
                submissionScopes: 'summary',
                maxPendingNativeObservations: 8,
            },
        }), {
            label: 'flow-field-runtime',
            release: value => value.dispose(),
        }),
        lifetime.track(loadFlowFieldDataset(flowManifestUrl(tileServerUrl), {
            signal: lifetime.signal,
        }), 'flow-field-runtime-manifest'),
        lifetime.track(
            WorkerModuleCatalog.load(workerModuleManifestUrl, { signal: lifetime.signal }),
            'flow-field-worker-module-catalog'
        ),
    ])
    lifetime.assertActive()
    const workers = lifetime.own(new WorkerSystem({
        maxWorkers: 6,
        maxHistory: 64,
        moduleResolver: workerModules,
    }), {
        label: 'flow-field-worker-system',
        release: value => value.dispose(),
    })
    const size = canvasPixelSize(canvas)
    const surface = runtime.createSurface(canvas, {
        label: 'Flow Field surface',
        format: 'preferred',
        alphaMode: 'premultiplied',
        size,
    })
    const timeline = createFlowTimeline({
        timeAxis: dataset.timeAxis,
        wallTime: readWallTime(options),
        playing: options.initialPlaying ?? true,
        rate: options.initialRate ?? (proofMode ? 8 : 0.2),
        loop: options.initialLoop ?? 'loop',
    })
    const temporalWindow = lifetime.own(createFlowTemporalRuntimeWindow({
        datasetIdentity: {
            datasetId: dataset.datasetId,
            sourceHash: dataset.sourceHash,
            contentVersion: dataset.contentVersion,
        },
        timeAxis: dataset.timeAxis,
        maxOwnedRuntimes: FLOW_FIELD_RUNTIME_BUDGETS.maxOwnedRuntimes,
        maxCreationSettleMs: FLOW_FIELD_RUNTIME_BUDGETS.maxCreationSettleMs,
        createReadyRuntime: (sample, context) => createReadyVelocitySampleRuntime({
            runtime,
            dataset,
            sampleKey: sample.sampleKey,
            cachePolicy: FLOW_FIELD_CACHE_DISABLED,
            workerSystem: workers,
            workerModules,
            workerCount: 1,
            maxNetworkRequests: FLOW_FIELD_RUNTIME_BUDGETS.perRuntime.maxNetworkRequests,
            maxDecodeTasks: FLOW_FIELD_RUNTIME_BUDGETS.perRuntime.maxDecodeTasks,
            maxRequests: FLOW_FIELD_RUNTIME_BUDGETS.perRuntime.maxRequests,
            maxPhysicalPages: FLOW_FIELD_RUNTIME_BUDGETS.perRuntime.maxPhysicalPages,
            maxStagingBytes: FLOW_FIELD_RUNTIME_BUDGETS.perRuntime.maxStagingBytes,
            maxHistory: 64,
            signal: AbortSignal.any([ context.signal, lifetime.signal ]),
        }),
        stopRuntimeRequests: value => value.stopDemand(),
        disposeRuntime: value => value.dispose(),
    }), {
        label: 'flow-field-temporal-runtime-window',
        release: value => value.dispose(),
    })
    lifetime.deferStop({
        label: 'flow-field-temporal-runtime-window-requests',
        run: () => temporalWindow.stopRequests(),
    })
    void temporalWindow.termination.then(outcome => {
        if (outcome.status === 'fatal') return options.fail(outcome.error)
    }).catch(() => undefined)
    let frameController: GeoFrameController | undefined
    let presentation = flowFieldPresentation(options.initialPresentation ?? FLOW_FIELD_PRESENTATION)
    let presented: FlowTemporalFrameSnapshot | undefined
    let latestHandshake: WindowHandshake
    let lastFrame: FlowFieldApplicationFrame = Object.freeze({
        state: 'loading',
        timelineRevision: timeline.snapshot().revision,
        selectionRevision: timeline.snapshot().selectionRevision,
        windowRequestRevision: 0,
    })

    const initialRequest = requestWindow(timeline.snapshot(), false)
    const initialOutcome = await initialRequest.ticket.settled
    initialRequest.status = initialOutcome.status
    if (initialOutcome.status !== 'ready') {
        throw new Error(`Flow Field initial temporal selection was ${initialOutcome.status}`)
    }
    const renderer = await lifetime.acquire(createFlowFieldRenderer({
        runtime,
        surface,
        size,
        temporalWindow,
        maximumSpeed: dataset.maximumSpeed,
        presentation,
    }), {
        label: 'flow-field-renderer',
        release: value => value.dispose(),
    })
    lifetime.assertActive()
    timeline.tick({
        wallTime: readWallTime(options),
        readiness: readyReadiness(timeline.snapshot().selectionRevision),
    })

    const viewSource = mapLibrePlanarViewSource({
        id: 'flow-field-maplibre-view-source',
        adapter: flowFieldViewAdapter,
        map,
        presentationSize: () => canvasPixelSize(canvas),
        minimumElevationMeters: 0,
    })
    frameController = createGeoFrameController<
        FlowFieldApplicationFrame,
        GeoViewSourceCapture<MapLibrePlanarCameraState>
    >({
        track: (work, label) => lifetime.track(work, label),
        maximumInFlightFrames: 1,
        driver: mapLibreFrameDriver({
            id: 'flow-field-maplibre-frames',
            map,
            capture: viewSource.capture,
        }),
        async render(frameNumber, captured) {

            lifetime.assertActive()
            const wallTime = readWallTime(options)
            const before = timeline.snapshot()
            let current = timeline.tick({
                wallTime,
                readiness: readinessFor(before),
            })
            if ((current.rate >= 0 && current.modelTime < before.modelTime) ||
                (current.rate < 0 && current.modelTime > before.modelTime) ||
                current.selection.kind === 'gap') renderer.resetVisuals()
            const handshake = requestWindow(current, true)
            const windowState = temporalWindow.snapshot()
            if (windowState.state === 'loading') {
                await renderer.suspendTemporal()
                const retained = await renderer.presentRetained(frameNumber, captured)
                return { ...retained, value: setLoadingFrame(current, handshake) }
            }
            if (windowState.state === 'gap' && current.selection.kind === 'gap') {
                await renderer.suspendTemporal()
                return idleFrameResult(setGapFrame(current, handshake))
            }
            if (windowState.state === 'failed') {
                if (windowState.failureCode !== 'runtime-failed') {
                    throw new Error(
                        `Flow Field temporal window failed: ${windowState.failureCode}`
                    )
                }
                await renderer.suspendTemporal()
                return idleFrameResult(setFailedFrame(current, handshake))
            }
            if (current.readiness !== 'ready') {
                current = timeline.tick({
                    wallTime,
                    readiness: readyReadiness(current.selectionRevision),
                })
            }
            try {
                const rendered = await renderer.render(frameNumber, captured, current)
                lastFrame = rendered.value
                return rendered
            } catch (error) {
                if (!(error instanceof FlowTemporalFrameUnavailableError)) throw error
                await renderer.suspendTemporal()
                const latest = timeline.snapshot()
                const latestWindow = temporalWindow.snapshot()
                if (latestWindow.state === 'failed') {
                    if (latestWindow.failureCode !== 'runtime-failed') {
                        throw new Error(
                            `Flow Field temporal window failed: ${latestWindow.failureCode}`
                        )
                    }
                    return idleFrameResult(setFailedFrame(latest, latestHandshake))
                }
                if (latestWindow.state === 'gap' && latest.selection.kind === 'gap') {
                    return idleFrameResult(setGapFrame(latest, latestHandshake))
                }
                const retained = await renderer.presentRetained(frameNumber, captured)
                return { ...retained, value: setLoadingFrame(latest, latestHandshake) }
            }
        },
        onObserved({ value }) {

            if (frameController?.snapshot().state !== 'running') return
            if (value.state === 'rendered' && value.presentationReady) presented = value.temporal
            else if (value.state === 'gap') presented = undefined
            setStatus(lastFrame.state === 'rendered'
                ? lastFrame.presentationReady ? 'ready' : 'loading' : lastFrame.state)
            emitControls()
            if (timeline.snapshot().needsTick) frameController.invalidate()
        },
        onError(error) {

            if (lifetime.isStopError(error)) return
            options.fail(error)
        },
    })
    lifetime.deferStop({
        label: 'flow-field-frame-controller',
        run: () => { frameController?.stop() },
    })

    function requestWindow(
        snapshot: FlowTimelineSnapshot,
        wake: boolean,
        retryFailure = false
    ): WindowHandshake {

        if (!retryFailure && latestHandshake !== undefined &&
            latestHandshake.selectionRevision === snapshot.selectionRevision) {
            const currentWindow = temporalWindow.snapshot()
            if (latestHandshake.status === 'failed' ||
                (currentWindow.requestedRevision === latestHandshake.ticket.revision &&
                    currentWindow.state === 'failed' &&
                    currentWindow.failureCode === 'runtime-failed')) {
                latestHandshake.status = 'failed'
                return latestHandshake
            }
        }
        const ticket = temporalWindow.request(snapshot.selection, snapshot.rate < 0 ? -1 : 1)
        const windowState = temporalWindow.snapshot()
        const handshake: WindowHandshake = {
            timelineRevision: snapshot.revision,
            selectionRevision: snapshot.selectionRevision,
            ticket,
            status: windowState.requestedRevision === ticket.revision &&
                (windowState.state === 'ready' || windowState.state === 'gap')
                ? windowState.state
                : 'pending',
        }
        latestHandshake = handshake
        if (wake && handshake.status === 'pending') {
            const waking = ticket.settled.then(outcome => {
                if (latestHandshake !== handshake) return
                handshake.status = outcome.status
                if (outcome.status === 'failed') {
                    if (temporalWindow.snapshot().failureCode === 'runtime-failed' &&
                        frameController?.snapshot().state === 'running') {
                        frameController.invalidate()
                    }
                    return
                }
                if ((outcome.status === 'ready' || outcome.status === 'gap') &&
                    frameController?.snapshot().state === 'running') {
                    frameController.invalidate()
                }
            })
            void lifetime.track(waking, `flow-field-window-request-${ticket.revision}`)
        }
        return handshake
    }

    function readinessFor(snapshot: FlowTimelineSnapshot): FlowTimelineReadiness {

        const windowState = temporalWindow.snapshot()
        if (snapshot.selection.kind === 'gap') {
            return readyReadiness(snapshot.selectionRevision)
        }
        if (latestHandshake.selectionRevision !== snapshot.selectionRevision) {
            return blockedReadiness(snapshot.selectionRevision, 'runtime-selection-unrequested')
        }
        if (windowState.requestedRevision !== latestHandshake.ticket.revision) {
            return blockedReadiness(snapshot.selectionRevision, 'runtime-selection-superseded')
        }
        if (windowState.state === 'ready' && latestHandshake.status === 'ready') {
            return readyReadiness(snapshot.selectionRevision)
        }
        if (windowState.state === 'failed') {
            if (windowState.failureCode !== 'runtime-failed') {
                throw new Error(`Flow Field temporal window failed: ${windowState.failureCode}`)
            }
            return blockedReadiness(snapshot.selectionRevision, 'runtime-selection-failed')
        }
        return blockedReadiness(snapshot.selectionRevision, 'runtime-selection-loading')
    }

    function applyControl(snapshot: FlowTimelineSnapshot): FlowTimelineSnapshot {

        requestWindow(snapshot, true, true)
        frameController!.invalidate()
        emitControls()
        return snapshot
    }

    function play(input: Readonly<{ wallTime: number }>): FlowTimelineSnapshot {

        assertControllable()
        return applyControl(timeline.play(input))
    }

    function pause(input: Readonly<{ wallTime: number }>): FlowTimelineSnapshot {

        assertControllable()
        return applyControl(timeline.pause(input))
    }

    function seek(
        input: Readonly<{ wallTime: number, modelTime: number }>
    ): FlowTimelineSnapshot {

        assertControllable()
        renderer.resetVisuals()
        return applyControl(timeline.seek(input))
    }

    function setRate(
        input: Readonly<{ wallTime: number, rate: number }>
    ): FlowTimelineSnapshot {

        assertControllable()
        if (Math.sign(input.rate) !== Math.sign(timeline.snapshot().rate)) {
            renderer.resetVisuals()
        }
        return applyControl(timeline.setRate(input))
    }

    function setLoop(
        input: Readonly<{ wallTime: number, loop: FlowTimelineLoop }>
    ): FlowTimelineSnapshot {

        assertControllable()
        return applyControl(timeline.setLoop(input))
    }

    async function flush(
        input: Readonly<{ wallTime: number }>
    ): Promise<FlowFieldApplicationFacts> {

        try {
            assertControllable()
            pause(input)
            frameController!.stop()
            await renderer.suspendTemporal()
            lifetime.assertActive()
            await lifetime.drain()
            lifetime.assertActive()
            const outcome = await latestHandshake.ticket.settled
            lifetime.assertActive()
            latestHandshake.status = outcome.status
            if (outcome.status === 'ready') {
                const admitted = timeline.tick({
                    wallTime: readWallTime(options),
                    readiness: readyReadiness(timeline.snapshot().selectionRevision),
                })
                const terminalCapture = viewSource.capture()
                await renderTerminalPass(admitted, terminalCapture, 'feedback')
                await renderTerminalPass(admitted, terminalCapture, 'demand')
                await lifetime.track(
                    renderer.flushResidency(),
                    'flow-field-terminal-residency-publication'
                )
                lifetime.assertActive()
                await renderTerminalPass(admitted, terminalCapture, 'presentation')
                setStatus('ready')
            } else if (outcome.status !== 'gap') {
                throw new Error(`Flow Field flush temporal selection was ${outcome.status}`)
            } else {
                await renderer.suspendTemporal()
                setGapFrame(timeline.snapshot(), latestHandshake)
                setStatus('gap')
            }
            await lifetime.drain()
            lifetime.assertActive()
            return facts()
        } catch (error) {
            void Promise.resolve(options.fail(error)).catch(() => undefined)
            throw error
        }
    }

    async function renderTerminalPass(
        admitted: FlowTimelineSnapshot,
        capture: GeoViewSourceCapture<MapLibrePlanarCameraState>,
        phase: 'feedback' | 'demand' | 'presentation'
    ): Promise<void> {

        const rendered = await renderer.render(
            renderer.facts().frameCount + 1,
            capture,
            admitted
        )
        lifetime.assertActive()
        lastFrame = rendered.value
        await lifetime.track(rendered.observation, `flow-field-terminal-${phase}-observation`)
        lifetime.assertActive()
        if (rendered.value.presentationReady) presented = rendered.value.temporal
        emitControls()
        const settlement = await lifetime.track(
            rendered.settlement,
            `flow-field-terminal-${phase}-settlement`
        )
        if (settlement !== undefined) {
            await lifetime.track(
                settlement.residencySettlement,
                `flow-field-terminal-${phase}-residency`
            )
            lifetime.assertActive()
        }
    }

    function setLoadingFrame(
        snapshot: FlowTimelineSnapshot,
        handshake: WindowHandshake
    ): Extract<FlowFieldApplicationFrame, Readonly<{ state: 'loading' }>> {

        const value = Object.freeze({
            state: 'loading' as const,
            timelineRevision: snapshot.revision,
            selectionRevision: snapshot.selectionRevision,
            windowRequestRevision: handshake.ticket.revision,
        })
        lastFrame = value
        return value
    }

    function setGapFrame(
        snapshot: FlowTimelineSnapshot,
        handshake: WindowHandshake
    ): Extract<FlowFieldApplicationFrame, Readonly<{ state: 'gap' }>> {

        if (snapshot.selection.kind !== 'gap') {
            throw new TypeError('Flow Field gap frame requires a gap selection')
        }
        const value = Object.freeze({
            state: 'gap' as const,
            timelineRevision: snapshot.revision,
            selectionRevision: snapshot.selectionRevision,
            windowRequestRevision: handshake.ticket.revision,
            lowerSampleKey: snapshot.selection.lower.sampleKey,
            upperSampleKey: snapshot.selection.upper.sampleKey,
        })
        lastFrame = value
        return value
    }

    function setFailedFrame(
        snapshot: FlowTimelineSnapshot,
        handshake: WindowHandshake
    ): Extract<FlowFieldApplicationFrame, Readonly<{ state: 'failed' }>> {

        const value = Object.freeze({
            state: 'failed' as const,
            timelineRevision: snapshot.revision,
            selectionRevision: snapshot.selectionRevision,
            windowRequestRevision: handshake.ticket.revision,
            failureCode: 'runtime-failed' as const,
        })
        lastFrame = value
        return value
    }

    function facts(): FlowFieldApplicationFacts {

        return Object.freeze({
            timeline: timeline.snapshot(),
            temporalWindow: temporalWindow.snapshot(),
            handshake: Object.freeze({
                timelineRevision: latestHandshake.timelineRevision,
                selectionRevision: latestHandshake.selectionRevision,
                windowRequestRevision: latestHandshake.ticket.revision,
                status: latestHandshake.status,
            }),
            lastFrame,
            budgets: FLOW_FIELD_RUNTIME_BUDGETS,
            frames: frameController!.snapshot(),
            renderer: renderer.facts(),
            workers: workers.inspect(),
            diagnostics: runtime.diagnostics.snapshot(),
        })
    }

    function controlSnapshot(): FlowFieldControlSnapshot {
        const windowState = temporalWindow.snapshot()
        return Object.freeze({
            dataset: Object.freeze({
                id: dataset.datasetId,
                minimumTime: dataset.timeAxis.samples[0]!.modelTime,
                maximumTime: dataset.timeAxis.samples.at(-1)!.modelTime,
                timeUnit: dataset.timeAxis.unit,
                velocityUnit: dataset.unit,
                sampleCount: dataset.timeAxis.samples.length,
                maximumMatrix: dataset.tileMatrixSet.maxTileMatrix,
            }),
            timeline: timeline.snapshot(),
            presented,
            state: frameController?.snapshot().state === 'stopped' ? 'stopped'
                : windowState.state === 'disposed' ? 'stopped'
                    : windowState.state === 'ready' && lastFrame.state === 'rendered' &&
                        !lastFrame.presentationReady ? 'loading' : windowState.state,
            runtimeCount: windowState.ownedRuntimeCount,
            presentation,
        })
    }

    function emitControls(): void {
        options.onControlSnapshot?.(controlSnapshot())
    }

    function setPresentation(value: FlowFieldPresentation): void {
        assertControllable()
        const next = flowFieldPresentation(value)
        renderer.setPresentation(next)
        presentation = next
        frameController!.invalidate()
        emitControls()
    }

    function assertControllable(): void {

        if (frameController?.snapshot().state !== 'running') {
            throw new Error('Flow Field frame controller is stopped')
        }
    }

    emitControls()
    return Object.freeze({
        play, pause, seek, setRate, setLoop, setPresentation, controlSnapshot, flush, facts,
    })
}

function idleFrameResult(
    value: Exclude<FlowFieldApplicationFrame, FlowFieldRendererFrame>
): GeoFrameResult<FlowFieldApplicationFrame> {

    return Object.freeze({
        observation: Promise.resolve(Object.freeze({ state: value.state })),
        settlement: Promise.resolve(Object.freeze({
            residencyWorkCount: 0,
            needsFollowUp: false,
        })),
        needsFollowUp: false,
        value,
    })
}

function readyReadiness(selectionRevision: number): FlowTimelineReadiness {

    return Object.freeze({ state: 'ready', selectionRevision })
}

function blockedReadiness(
    selectionRevision: number,
    reason: string
): FlowTimelineReadiness {

    return Object.freeze({ state: 'blocked', reason, selectionRevision })
}

function readWallTime(options: FlowFieldApplicationOptions): number {

    const value = options.readWallTime()
    if (!Number.isFinite(value)) throw new TypeError('Flow Field wall time must be finite')
    return value
}

function flowManifestUrl(tileServerUrl: string): URL {

    let base: URL
    try {
        base = new URL(tileServerUrl, window.location.href)
    } catch {
        throw new TypeError('Flow Field tile server URL is invalid')
    }
    if (!base.pathname.endsWith('/')) base.pathname += '/'
    return new URL('manifest.json', base)
}

function canvasPixelSize(target: HTMLElement) {

    const ratio = window.devicePixelRatio || 1
    return {
        width: Math.max(1, Math.floor(target.clientWidth * ratio)),
        height: Math.max(1, Math.floor(target.clientHeight * ratio)),
    }
}
