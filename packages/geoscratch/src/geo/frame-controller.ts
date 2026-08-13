import { throwGeoDiagnostic } from './diagnostics.js'

export type GeoFrameControllerState = 'running' | 'stopped'

export type GeoFrameScheduler = Readonly<{
    request(callback: () => void): number
    cancel(handle: number): void
}>

export type GeoFrameResult<Value> = Readonly<{
    observation: PromiseLike<unknown>
    residencySettlement?: PromiseLike<unknown>
    residencyWorkCount: number
    needsFollowUp: boolean
    value: Value
}>

export type GeoFrameControllerFrame<Value> = GeoFrameResult<Value> & Readonly<{
    frameNumber: number
}>

export type GeoFrameControllerSnapshot = Readonly<{
    state: GeoFrameControllerState
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
    maximumFollowUpFrames?: number
    onSubmitted?(frame: GeoFrameControllerFrame<Value>): void
    onObserved?(frame: GeoFrameControllerFrame<Value>): void
    onError?(error: unknown): void
}>

export type GeoFrameController = Readonly<{
    invalidate(): boolean
    stop(): boolean
    snapshot(): GeoFrameControllerSnapshot
}>

type MutableState = {
    state: GeoFrameControllerState
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

/** Coordinates invalidation, asynchronous preparation, rendering, and bounded follow-up frames. */
export function createGeoFrameController<Value>(
    descriptor: GeoFrameControllerDescriptor<Value>
): GeoFrameController {

    const validated = validateDescriptor(descriptor)
    const scheduler = validated.scheduler ?? browserFrameScheduler()
    const maximumFollowUpFrames = validated.maximumFollowUpFrames ?? 8
    const state: MutableState = {
        state: 'running',
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

    function requestFrame(): void {

        if (state.state === 'stopped') return
        renderRequested = true
        if (scheduledHandle !== undefined || state.rendering) return
        scheduledHandle = scheduler.request(runScheduledFrame)
        state.scheduledFrameCount++
    }

    function runScheduledFrame(): void {

        scheduledHandle = undefined
        state.completedFrameCount++
        if (state.state === 'stopped' || state.rendering) return
        state.rendering = true
        renderRequested = false
        const frameNumber = state.submittedFrameCount + 1
        const task = Promise.resolve()
            .then(() => validated.render(frameNumber))
            .then(result => observeFrame(frameNumber, result))
            .finally(() => {
                state.rendering = false
                if (renderRequested) requestFrame()
            })
        observeTracked(task, `geo-frame-${frameNumber}`)
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
        validated.onSubmitted?.(frame)

        if (result.residencyWorkCount > 0) {
            const settlement = Promise.resolve(result.residencySettlement).then(() => {
                if (state.state === 'stopped') return
                consecutiveFollowUps = 0
                requestFrame()
            })
            observeTracked(settlement, `geo-frame-residency-${frameNumber}`)
        }

        await result.observation
        state.observedFrameCount++
        validated.onObserved?.(frame)
        if (result.needsFollowUp && consecutiveFollowUps < maximumFollowUpFrames) {
            consecutiveFollowUps++
            state.followUpFrameCount++
            requestFrame()
        } else if (!result.needsFollowUp) {
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

    return Object.freeze({ invalidate, stop, snapshot })
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
    const maximumFollowUpFrames = descriptor.maximumFollowUpFrames ?? 8
    const onSubmitted = descriptor.onSubmitted
    const onObserved = descriptor.onObserved
    const onError = descriptor.onError
    const schedulerRequest = scheduler?.request
    const schedulerCancel = scheduler?.cancel
    if (typeof render !== 'function' ||
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
        !Number.isSafeInteger(result.residencyWorkCount) || result.residencyWorkCount < 0 ||
        typeof result.needsFollowUp !== 'boolean' ||
        (result.residencyWorkCount > 0 &&
            typeof result.residencySettlement?.then !== 'function')) {
        return throwGeoDiagnostic({
            code: 'GEO_FRAME_RESULT_INVALID',
            phase: 'selection',
            subject: { kind: 'geo-frame-controller', frameNumber },
            message: 'A Geo frame result requires observable work and explicit follow-up facts.',
            expected: {
                observation: 'PromiseLike',
                residencyWorkCount: 'non-negative safe integer',
                residencySettlement: 'PromiseLike when residencyWorkCount is positive',
                needsFollowUp: 'boolean',
            },
            actual: result,
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
