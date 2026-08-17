import { throwGeoDiagnostic } from './diagnostics.js'

export type GeoFrameControllerState = 'running' | 'stopped'

export type GeoFrameScheduler = Readonly<{
    request(callback: () => void): number
    cancel(handle: number): void
}>

/** Supplies one revisioned capture, frame scheduler, and owned host lifecycle. */
export type GeoFrameDriver<Capture> = Readonly<{
    kind: 'geo-frame-driver'
    id: string
    scheduler: GeoFrameScheduler
    capture(): GeoFrameCapture<Capture>
    start(invalidate: () => boolean): void
    stop(): boolean
}>

/** Immutable host state captured synchronously with a monotonically increasing revision. */
export type GeoFrameCapture<Snapshot> = Readonly<{
    revision: number
    snapshot: Snapshot
}>

/** Work submitted for one Geo frame plus independently observed asynchronous outcomes. */
export type GeoFrameResult<Value> = Readonly<{
    observation: PromiseLike<unknown>
    settlement?: PromiseLike<GeoFrameSettlement>
    needsFollowUp: boolean
    value: Value
}>

/** Delayed feedback and residency facts that may request another bounded frame. */
export type GeoFrameSettlement = Readonly<{
    residencySettlement?: PromiseLike<unknown>
    residencyWorkCount: number
    needsFollowUp: boolean
}>

export type GeoFrameControllerFrame<Value> = GeoFrameResult<Value> & Readonly<{
    frameNumber: number
}>

/** Immutable scheduling, capture, submission, and convergence counters. */
export type GeoFrameControllerSnapshot = Readonly<{
    state: GeoFrameControllerState
    maximumInFlightFrames: number
    inFlightFrameCount: number
    invalidationCount: number
    deduplicatedInvalidationCount: number
    latestCaptureRevision?: number
    submittedCaptureRevision?: number
    scheduledFrameCount: number
    completedFrameCount: number
    cancelledFrameCount: number
    submittedFrameCount: number
    observedFrameCount: number
    followUpFrameCount: number
    pendingTaskCount: number
    rendering: boolean
}>

/** Host capture, frame construction, observation, and bounded convergence policy. */
export type GeoFrameControllerDescriptor<Value, Capture = undefined> = Readonly<{
    /** Owns external host capture, scheduling, and event lifecycle. */
    driver?: GeoFrameDriver<Capture>
    /** Reads one immutable host snapshot synchronously before asynchronous construction. */
    capture?(): GeoFrameCapture<Capture>
    /** Constructs one frame from the frozen capture selected for this submission. */
    render(frameNumber: number, capture: Capture): PromiseLike<GeoFrameResult<Value>>
    scheduler?: GeoFrameScheduler
    track?<Result>(work: Promise<Result>, label: string): Promise<Result>
    maximumInFlightFrames?: number
    maximumFollowUpFrames?: number
    onSubmitted?(frame: GeoFrameControllerFrame<Value>): void
    onObserved?(frame: GeoFrameControllerFrame<Value>): void
    onError?(error: unknown): void
}>

/** Latest-only Geo frame authority with optional host-revision capture. */
export type GeoFrameController = Readonly<{
    /** Coalesces an invalidation onto the configured frame scheduler. */
    invalidate(): boolean
    /** Captures host state now and starts its submission after cancelling queued work. */
    invalidateNow(): boolean
    stop(): boolean
    snapshot(): GeoFrameControllerSnapshot
}>

type MutableState = {
    state: GeoFrameControllerState
    maximumInFlightFrames: number
    inFlightFrameCount: number
    invalidationCount: number
    deduplicatedInvalidationCount: number
    latestCaptureRevision?: number
    submittedCaptureRevision?: number
    scheduledFrameCount: number
    completedFrameCount: number
    cancelledFrameCount: number
    submittedFrameCount: number
    observedFrameCount: number
    followUpFrameCount: number
    pendingTaskCount: number
    rendering: boolean
}

/** Coordinates immediate submission, bounded native frames in flight, and Geo follow-up work. */
export function createGeoFrameController<Value, Capture = undefined>(
    descriptor: GeoFrameControllerDescriptor<Value, Capture>
): GeoFrameController {

    const validated = validateDescriptor(descriptor)
    const scheduler = validated.scheduler ?? browserFrameScheduler()
    const maximumInFlightFrames = validated.maximumInFlightFrames ?? 3
    const maximumFollowUpFrames = validated.maximumFollowUpFrames ?? 8
    const state: MutableState = {
        state: 'running',
        maximumInFlightFrames,
        inFlightFrameCount: 0,
        invalidationCount: 0,
        deduplicatedInvalidationCount: 0,
        scheduledFrameCount: 0,
        completedFrameCount: 0,
        cancelledFrameCount: 0,
        submittedFrameCount: 0,
        observedFrameCount: 0,
        followUpFrameCount: 0,
        pendingTaskCount: 0,
        rendering: false,
    }
    let scheduledHandle: number | undefined
    let renderRequested = false
    let consecutiveFollowUps = 0
    let latestCapture: GeoFrameCapture<Capture> | undefined
    let pendingCapture: GeoFrameCapture<Capture> | undefined

    function invalidate(): boolean {

        if (state.state === 'stopped') return false
        state.invalidationCount++
        consecutiveFollowUps = 0
        requestFrame()
        return true
    }

    function invalidateNow(): boolean {

        if (state.state === 'stopped') return false
        state.invalidationCount++
        if (validated.capture !== undefined) {
            let capture: GeoFrameCapture<Capture>
            try {
                capture = readCapture(validated.capture)
                assertCaptureOrder(capture, latestCapture)
            } catch (error) {
                stopWithError(error)
                return false
            }
            if (capture.revision === latestCapture?.revision) {
                state.deduplicatedInvalidationCount++
                return false
            }
            latestCapture = capture
            pendingCapture = capture
            state.latestCaptureRevision = capture.revision
        }
        consecutiveFollowUps = 0
        renderRequested = true
        if (state.rendering) return true
        if (scheduledHandle !== undefined) {
            scheduler.cancel(scheduledHandle)
            scheduledHandle = undefined
            state.cancelledFrameCount++
        }
        if (!hasSubmissionCapacity()) return true
        state.scheduledFrameCount++
        runScheduledFrame()
        return true
    }

    function requestFrame(): void {

        if (state.state === 'stopped') return
        renderRequested = true
        if (scheduledHandle !== undefined || state.rendering || !hasSubmissionCapacity()) return
        scheduledHandle = scheduler.request(runScheduledFrame)
        state.scheduledFrameCount++
    }

    function runScheduledFrame(): void {

        scheduledHandle = undefined
        state.completedFrameCount++
        if (state.state === 'stopped' || state.rendering || !hasSubmissionCapacity()) return
        state.rendering = true
        let capture = pendingCapture
        try {
            if (capture === undefined && validated.capture !== undefined) {
                capture = readCapture(validated.capture)
                assertCaptureOrder(capture, latestCapture)
                latestCapture = capture
                state.latestCaptureRevision = capture.revision
            }
        } catch (error) {
            releaseRenderSlot()
            stopWithError(error)
            return
        }
        pendingCapture = undefined
        renderRequested = false
        if (capture !== undefined) state.submittedCaptureRevision = capture.revision
        const frameNumber = state.submittedFrameCount + 1
        let construction: PromiseLike<GeoFrameResult<Value>>
        try {
            construction = validated.render(frameNumber, capture?.snapshot as Capture)
        } catch (error) {
            releaseRenderSlot()
            stopWithError(error)
            return
        }
        const task = Promise.resolve(construction)
            .then(
                result => {
                    const observation = observeFrame(frameNumber, result)
                    releaseRenderSlot()
                    return observation
                },
                error => {
                    releaseRenderSlot()
                    throw error
                }
            )
        observeTracked(task, `geo-frame-${frameNumber}`)
    }

    function releaseRenderSlot(): void {

        state.rendering = false
        if (renderRequested) requestFrame()
    }

    function hasSubmissionCapacity(): boolean {

        return state.inFlightFrameCount < maximumInFlightFrames
    }

    async function observeFrame(
        frameNumber: number,
        result: GeoFrameResult<Value>
    ): Promise<void> {

        assertFrameResult(result, frameNumber)
        const frame = Object.freeze({
            ...result,
            frameNumber,
        }) satisfies GeoFrameControllerFrame<Value>
        state.submittedFrameCount++
        state.inFlightFrameCount++
        try {
            validated.onSubmitted?.(frame)

            if (result.settlement !== undefined) {
                const settlement = Promise.resolve(result.settlement).then(value => {
                    observeFrameSettlement(frameNumber, value)
                })
                observeTracked(settlement, `geo-frame-settlement-${frameNumber}`)
            }

            await result.observation
            state.observedFrameCount++
            validated.onObserved?.(frame)
            requestConvergenceFollowUp(frameNumber, result.needsFollowUp)
        } finally {
            state.inFlightFrameCount--
            if (state.state === 'running' && renderRequested) requestFrame()
        }
    }

    function observeFrameSettlement(
        frameNumber: number,
        settlement: GeoFrameSettlement
    ): void {

        assertFrameSettlement(settlement, frameNumber)
        if (frameNumber !== state.submittedFrameCount) return
        if (settlement.residencyWorkCount > 0) {
            const residency = Promise.resolve(settlement.residencySettlement).then(() => {
                if (state.state === 'stopped') return
                consecutiveFollowUps = 0
                requestFrame()
            })
            observeTracked(residency, `geo-frame-residency-${frameNumber}`)
        }
        requestConvergenceFollowUp(frameNumber, settlement.needsFollowUp)
    }

    function requestConvergenceFollowUp(frameNumber: number, needed: boolean): void {

        if (frameNumber !== state.submittedFrameCount) return
        if (needed && consecutiveFollowUps < maximumFollowUpFrames) {
            consecutiveFollowUps++
            state.followUpFrameCount++
            requestFrame()
        } else if (!needed) {
            consecutiveFollowUps = 0
        }
    }

    function observeTracked<Result>(work: Promise<Result>, label: string): void {

        state.pendingTaskCount++
        let tracked: Promise<Result>
        try {
            tracked = trackWork(validated, work, label)
        } catch (error) {
            state.pendingTaskCount--
            stopWithError(error)
            return
        }
        void tracked.then(
            () => { state.pendingTaskCount-- },
            error => {
                state.pendingTaskCount--
                stopWithError(error)
            }
        )
    }

    function stopWithError(error: unknown): void {

        stop()
        if (validated.onError !== undefined) {
            validated.onError(error)
            return
        }
        queueMicrotask(() => { throw error })
    }

    function stop(): boolean {

        if (state.state === 'stopped') return false
        state.state = 'stopped'
        renderRequested = false
        pendingCapture = undefined
        if (scheduledHandle !== undefined) {
            scheduler.cancel(scheduledHandle)
            scheduledHandle = undefined
            state.cancelledFrameCount++
        }
        validated.driver?.stop()
        return true
    }

    function snapshot(): GeoFrameControllerSnapshot {

        return Object.freeze({ ...state })
    }

    const controller = Object.freeze({ invalidate, invalidateNow, stop, snapshot })
    try {
        validated.driver?.start(invalidate)
    } catch (error) {
        stop()
        throw error
    }
    return controller
}

function trackWork<Value, Capture, Result>(
    descriptor: GeoFrameControllerDescriptor<Value, Capture>,
    work: Promise<Result>,
    label: string
): Promise<Result> {

    return descriptor.track === undefined ? work : descriptor.track(work, label)
}

function readCapture<Capture>(
    capture: () => GeoFrameCapture<Capture>
): GeoFrameCapture<Capture> {

    const value = capture()
    if (value === null || typeof value !== 'object' ||
        !Number.isSafeInteger(value.revision) || value.revision < 0 ||
        !Object.prototype.hasOwnProperty.call(value, 'snapshot')) {
        return throwGeoDiagnostic({
            code: 'GEO_FRAME_CAPTURE_INVALID',
            phase: 'selection',
            subject: { kind: 'geo-frame-controller' },
            message: 'A Geo frame capture requires a non-negative monotonic revision and a snapshot.',
            expected: {
                revision: 'non-negative safe integer',
                snapshot: 'immutable host state',
            },
            actual: value,
        })
    }
    return Object.freeze({
        revision: value.revision,
        snapshot: value.snapshot,
    })
}

function assertCaptureOrder<Capture>(
    capture: GeoFrameCapture<Capture>,
    latest: GeoFrameCapture<Capture> | undefined
): void {

    if (latest !== undefined && capture.revision < latest.revision) {
        return throwGeoDiagnostic({
            code: 'GEO_FRAME_CAPTURE_STALE',
            phase: 'selection',
            subject: { kind: 'geo-frame-controller' },
            message: 'A Geo host capture revision cannot move backwards.',
            expected: { minimumRevision: latest.revision },
            actual: { revision: capture.revision },
        })
    }
}

function validateDescriptor<Value, Capture>(
    descriptor: GeoFrameControllerDescriptor<Value, Capture>
): GeoFrameControllerDescriptor<Value, Capture> {

    if (descriptor === null || typeof descriptor !== 'object') {
        return invalidDescriptor(descriptor)
    }
    const driver = descriptor.driver
    const capture = descriptor.capture
    const render = descriptor.render
    const scheduler = descriptor.scheduler
    const track = descriptor.track
    const maximumInFlightFrames = descriptor.maximumInFlightFrames ?? 3
    const maximumFollowUpFrames = descriptor.maximumFollowUpFrames ?? 8
    const onSubmitted = descriptor.onSubmitted
    const onObserved = descriptor.onObserved
    const onError = descriptor.onError
    const driverScheduler = driver?.scheduler
    const effectiveCapture = driver?.capture ?? capture
    const effectiveScheduler = driverScheduler ?? scheduler
    const schedulerRequest = effectiveScheduler?.request
    const schedulerCancel = effectiveScheduler?.cancel
    const driverStart = driver?.start
    const driverStop = driver?.stop
    if ((driver !== undefined && (
        driver.kind !== 'geo-frame-driver' ||
        typeof driver.id !== 'string' || driver.id.length === 0 ||
        typeof driver.capture !== 'function' ||
        typeof driverStart !== 'function' || typeof driverStop !== 'function' ||
        capture !== undefined || scheduler !== undefined
    )) ||
        (effectiveCapture !== undefined && typeof effectiveCapture !== 'function') ||
        typeof render !== 'function' ||
        !Number.isSafeInteger(maximumInFlightFrames) ||
        maximumInFlightFrames < 1 || maximumInFlightFrames > 8 ||
        !Number.isSafeInteger(maximumFollowUpFrames) || maximumFollowUpFrames < 0 ||
        (track !== undefined && typeof track !== 'function') ||
        (onSubmitted !== undefined && typeof onSubmitted !== 'function') ||
        (onObserved !== undefined && typeof onObserved !== 'function') ||
        (onError !== undefined && typeof onError !== 'function') ||
        (effectiveScheduler !== undefined && (typeof schedulerRequest !== 'function' ||
            typeof schedulerCancel !== 'function'))) {
        return invalidDescriptor(descriptor)
    }
    const validatedDriver = driver === undefined ? undefined : Object.freeze({
        kind: 'geo-frame-driver' as const,
        id: driver.id,
        scheduler: Object.freeze({
            request: schedulerRequest!.bind(driverScheduler),
            cancel: schedulerCancel!.bind(driverScheduler),
        }),
        capture: driver.capture.bind(driver),
        start: driverStart!.bind(driver),
        stop: driverStop!.bind(driver),
    })
    return Object.freeze({
        ...(validatedDriver === undefined ? {} : { driver: validatedDriver }),
        ...(effectiveCapture === undefined ? {} : {
            capture: validatedDriver?.capture ?? effectiveCapture,
        }),
        render,
        maximumInFlightFrames,
        maximumFollowUpFrames,
        ...(effectiveScheduler === undefined ? {} : {
            scheduler: validatedDriver?.scheduler ?? Object.freeze({
                request: schedulerRequest!.bind(scheduler),
                cancel: schedulerCancel!.bind(scheduler),
            }),
        }),
        ...(track === undefined ? {} : { track }),
        ...(onSubmitted === undefined ? {} : { onSubmitted }),
        ...(onObserved === undefined ? {} : { onObserved }),
        ...(onError === undefined ? {} : { onError }),
    })
}

function invalidDescriptor<Value, Capture>(
    descriptor: GeoFrameControllerDescriptor<Value, Capture>
): never {

    return throwGeoDiagnostic({
        code: 'GEO_FRAME_CONTROLLER_INVALID',
        phase: 'selection',
        subject: { kind: 'geo-frame-controller' },
        message: 'A Geo frame controller requires a render operation and bounded scheduling configuration.',
        expected: {
            driver: 'optional exclusive GeoFrameDriver',
            capture: 'optional synchronous function returning GeoFrameCapture',
            render: 'function',
            maximumInFlightFrames: 'safe integer from 1 through 8',
            maximumFollowUpFrames: 'non-negative safe integer',
            scheduler: 'optional request/cancel pair',
            callbacks: 'optional functions',
        },
        actual: descriptor,
    })
}

function assertFrameResult<Value>(
    result: GeoFrameResult<Value>,
    frameNumber: number
): void {

    if (result === null || typeof result !== 'object' ||
        typeof result.observation?.then !== 'function' ||
        typeof result.needsFollowUp !== 'boolean' ||
        (result.settlement !== undefined &&
            typeof result.settlement?.then !== 'function')) {
        return throwGeoDiagnostic({
            code: 'GEO_FRAME_RESULT_INVALID',
            phase: 'selection',
            subject: { kind: 'geo-frame-controller', frameNumber },
            message: 'A Geo frame result requires observable work and explicit follow-up facts.',
            expected: {
                observation: 'PromiseLike',
                settlement: 'optional PromiseLike<GeoFrameSettlement>',
                needsFollowUp: 'boolean',
            },
            actual: result,
        })
    }
}

function assertFrameSettlement(
    settlement: GeoFrameSettlement,
    frameNumber: number
): void {

    if (settlement === null || typeof settlement !== 'object' ||
        !Number.isSafeInteger(settlement.residencyWorkCount) ||
        settlement.residencyWorkCount < 0 ||
        typeof settlement.needsFollowUp !== 'boolean' ||
        (settlement.residencyWorkCount > 0 &&
            typeof settlement.residencySettlement?.then !== 'function')) {
        return throwGeoDiagnostic({
            code: 'GEO_FRAME_SETTLEMENT_INVALID',
            phase: 'selection',
            subject: { kind: 'geo-frame-controller', frameNumber },
            message: 'A Geo frame settlement requires explicit bounded residency and follow-up facts.',
            expected: {
                residencyWorkCount: 'non-negative safe integer',
                residencySettlement: 'PromiseLike when residencyWorkCount is positive',
                needsFollowUp: 'boolean',
            },
            actual: settlement,
        })
    }
}

function browserFrameScheduler(): GeoFrameScheduler {

    if (typeof globalThis.requestAnimationFrame !== 'function' ||
        typeof globalThis.cancelAnimationFrame !== 'function') {
        return throwGeoDiagnostic({
            code: 'GEO_FRAME_SCHEDULER_UNAVAILABLE',
            phase: 'selection',
            subject: { kind: 'geo-frame-controller' },
            message: 'No browser animation-frame scheduler is available.',
            expected: { requestAnimationFrame: 'function', cancelAnimationFrame: 'function' },
            actual: {
                requestAnimationFrame: typeof globalThis.requestAnimationFrame,
                cancelAnimationFrame: typeof globalThis.cancelAnimationFrame,
            },
        })
    }
    return Object.freeze({
        request: callback => globalThis.requestAnimationFrame(callback),
        cancel: handle => globalThis.cancelAnimationFrame(handle),
    })
}
