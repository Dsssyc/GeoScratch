import { throwGeoDiagnostic } from './diagnostics.js'

export type GeoFrameControllerState = 'running' | 'stopped'

export type GeoFrameScheduler = Readonly<{
    request(callback: () => void): number
    cancel(handle: number): void
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

export type GeoFrameControllerSnapshot = Readonly<{
    state: GeoFrameControllerState
    maximumInFlightFrames: number
    inFlightFrameCount: number
    invalidationCount: number
    scheduledFrameCount: number
    completedFrameCount: number
    cancelledFrameCount: number
    submittedFrameCount: number
    observedFrameCount: number
    followUpFrameCount: number
    pendingTaskCount: number
    rendering: boolean
}>

export type GeoFrameControllerDescriptor<Value> = Readonly<{
    render(frameNumber: number): PromiseLike<GeoFrameResult<Value>>
    scheduler?: GeoFrameScheduler
    track?<Result>(work: Promise<Result>, label: string): Promise<Result>
    maximumInFlightFrames?: number
    maximumFollowUpFrames?: number
    onSubmitted?(frame: GeoFrameControllerFrame<Value>): void
    onObserved?(frame: GeoFrameControllerFrame<Value>): void
    onError?(error: unknown): void
}>

export type GeoFrameController = Readonly<{
    /** Coalesces an invalidation onto the configured frame scheduler. */
    invalidate(): boolean
    /** Starts submission from the current host callback after cancelling queued work. */
    invalidateNow(): boolean
    stop(): boolean
    snapshot(): GeoFrameControllerSnapshot
}>

type MutableState = {
    state: GeoFrameControllerState
    maximumInFlightFrames: number
    inFlightFrameCount: number
    invalidationCount: number
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
export function createGeoFrameController<Value>(
    descriptor: GeoFrameControllerDescriptor<Value>
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
        renderRequested = false
        const frameNumber = state.submittedFrameCount + 1
        const task = Promise.resolve()
            .then(() => validated.render(frameNumber))
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
        if (scheduledHandle !== undefined) {
            scheduler.cancel(scheduledHandle)
            scheduledHandle = undefined
            state.cancelledFrameCount++
        }
        return true
    }

    function snapshot(): GeoFrameControllerSnapshot {

        return Object.freeze({ ...state })
    }

    return Object.freeze({ invalidate, invalidateNow, stop, snapshot })
}

function trackWork<Value, Result>(
    descriptor: GeoFrameControllerDescriptor<Value>,
    work: Promise<Result>,
    label: string
): Promise<Result> {

    return descriptor.track === undefined ? work : descriptor.track(work, label)
}

function validateDescriptor<Value>(
    descriptor: GeoFrameControllerDescriptor<Value>
): GeoFrameControllerDescriptor<Value> {

    if (descriptor === null || typeof descriptor !== 'object') {
        return invalidDescriptor(descriptor)
    }
    const render = descriptor.render
    const scheduler = descriptor.scheduler
    const track = descriptor.track
    const maximumInFlightFrames = descriptor.maximumInFlightFrames ?? 3
    const maximumFollowUpFrames = descriptor.maximumFollowUpFrames ?? 8
    const onSubmitted = descriptor.onSubmitted
    const onObserved = descriptor.onObserved
    const onError = descriptor.onError
    const schedulerRequest = scheduler?.request
    const schedulerCancel = scheduler?.cancel
    if (typeof render !== 'function' ||
        !Number.isSafeInteger(maximumInFlightFrames) ||
        maximumInFlightFrames < 1 || maximumInFlightFrames > 8 ||
        !Number.isSafeInteger(maximumFollowUpFrames) || maximumFollowUpFrames < 0 ||
        (track !== undefined && typeof track !== 'function') ||
        (onSubmitted !== undefined && typeof onSubmitted !== 'function') ||
        (onObserved !== undefined && typeof onObserved !== 'function') ||
        (onError !== undefined && typeof onError !== 'function') ||
        (scheduler !== undefined && (typeof schedulerRequest !== 'function' ||
            typeof schedulerCancel !== 'function'))) {
        return invalidDescriptor(descriptor)
    }
    return Object.freeze({
        render,
        maximumInFlightFrames,
        maximumFollowUpFrames,
        ...(scheduler === undefined ? {} : {
            scheduler: Object.freeze({
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

function invalidDescriptor<Value>(
    descriptor: GeoFrameControllerDescriptor<Value>
): never {

    return throwGeoDiagnostic({
        code: 'GEO_FRAME_CONTROLLER_INVALID',
        phase: 'selection',
        subject: { kind: 'geo-frame-controller' },
        message: 'A Geo frame controller requires a render operation and bounded scheduling configuration.',
        expected: {
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
