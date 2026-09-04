import type { SubmittedWork } from 'geoscratch/scratch'
import {
    createVelocitySampleRuntime,
} from './velocity-source.ts'
import type {
    FlowVelocitySampleRuntime,
    FlowVelocitySampleRuntimeOptions,
} from './velocity-source.ts'

export type ReadyVelocitySampleRuntimeOptions = FlowVelocitySampleRuntimeOptions & Readonly<{
    signal: AbortSignal
}>

type ReadyRuntime = Pick<
    FlowVelocitySampleRuntime,
    'initialize' | 'acknowledge' | 'dispose'
> & Readonly<{
    gpu: Pick<FlowVelocitySampleRuntime['gpu'], 'runtime' | 'encode'>
}>

type InitializationResult =
    | Readonly<{
        state: 'initialized'
        publication: Awaited<ReturnType<ReadyRuntime['initialize']>>
    }>
    | Readonly<{ state: 'failed', error: unknown }>
    | Readonly<{ state: 'aborted', error: unknown }>

/** Creates a sample runtime and returns it only after its safety cover is GPU-observed. */
export async function createReadyVelocitySampleRuntime(
    options: ReadyVelocitySampleRuntimeOptions
): Promise<FlowVelocitySampleRuntime> {

    const signal = requireAbortSignal(options?.signal)
    if (signal.aborted) throw abortReason(signal)
    const { signal: _signal, ...runtimeOptions } = options
    const runtime = await createVelocitySampleRuntime(runtimeOptions)
    return await acknowledgeReadyRuntime(runtime, signal)
}

/**
 * Initializes, submits, observes, and acknowledges one owned runtime. This seam is
 * exported so lifecycle ordering can be proven without constructing native WebGPU.
 */
export async function acknowledgeReadyRuntime<Runtime extends ReadyRuntime>(
    runtime: Runtime,
    signal: AbortSignal
): Promise<Runtime> {

    assertReadyRuntime(runtime)
    const acceptedSignal = requireAbortSignal(signal)
    let disposal: Promise<void> | undefined

    function disposeOnce(): Promise<void> {

        disposal ??= Promise.resolve().then(() => runtime.dispose())
        return disposal
    }

    async function fail(primary: unknown, additional: readonly unknown[] = []): Promise<never> {

        const failures: unknown[] = []
        appendFailure(failures, primary)
        for (const failure of additional) appendFailure(failures, failure)
        const cleanup = await Promise.allSettled([ disposeOnce() ])
        if (cleanup[0]!.status === 'rejected') {
            appendFailure(failures, cleanup[0]!.reason)
        }
        if (failures.length === 1) throw failures[0]
        throw new AggregateError(
            failures,
            'Flow velocity runtime readiness and cleanup failed'
        )
    }

    if (acceptedSignal.aborted) return await fail(abortReason(acceptedSignal))

    const initialization = Promise.resolve().then(() => runtime.initialize())
    let abortDisposal: Promise<void> | undefined
    let abortObserved = false
    let onAbort!: () => void
    const aborted = new Promise<InitializationResult>(resolve => {
        onAbort = () => {
            if (abortObserved) return
            abortObserved = true
            abortDisposal = disposeOnce()
            resolve(Object.freeze({
                state: 'aborted' as const,
                error: abortReason(acceptedSignal),
            }))
        }
        acceptedSignal.addEventListener('abort', onAbort, { once: true })
        if (acceptedSignal.aborted) onAbort()
    })
    const initialized = initialization.then<InitializationResult, InitializationResult>(
        publication => Object.freeze({ state: 'initialized' as const, publication }),
        error => Object.freeze({ state: 'failed' as const, error })
    )
    const initializationResult = await Promise.race([ initialized, aborted ])
    acceptedSignal.removeEventListener('abort', onAbort)
    if (initializationResult.state === 'aborted') {
        const settlements = await Promise.allSettled([
            initialization,
            abortDisposal ?? disposeOnce(),
        ])
        const additional = settlements[0]!.status === 'rejected'
            ? [ settlements[0]!.reason ]
            : []
        return await fail(initializationResult.error, additional)
    }
    if (initializationResult.state === 'failed') {
        if (acceptedSignal.aborted) {
            return await fail(abortReason(acceptedSignal), [ initializationResult.error ])
        }
        return await fail(initializationResult.error)
    }
    if (acceptedSignal.aborted) return await fail(abortReason(acceptedSignal))

    let submitted: SubmittedWork
    let acknowledgement: Promise<void>
    try {
        const builder = runtime.gpu.runtime.createSubmission({ validation: 'throw' })
        runtime.gpu.encode(builder, initializationResult.publication.update)
        submitted = builder.submit()
        acknowledgement = Promise.resolve().then(() => runtime.acknowledge(
            initializationResult.publication,
            submitted
        ))
    } catch (error) {
        return await fail(error)
    }

    const settlements = await Promise.allSettled([
        submitted.nativeOutcome,
        submitted.done,
        acknowledgement,
    ])
    const failures: unknown[] = []
    if (acceptedSignal.aborted) appendFailure(failures, abortReason(acceptedSignal))
    const native = settlements[0]!
    if (native.status === 'rejected') {
        appendFailure(failures, native.reason)
    } else if (native.value.status !== 'observed-succeeded') {
        appendFailure(
            failures,
            new Error(`Flow velocity readiness native outcome was ${native.value.status}`)
        )
    }
    for (const settlement of settlements.slice(1)) {
        if (settlement.status === 'rejected') appendFailure(failures, settlement.reason)
    }
    if (failures.length > 0) return await fail(failures[0], failures.slice(1))
    return runtime
}

function assertReadyRuntime(runtime: ReadyRuntime): void {

    if (typeof runtime?.initialize !== 'function' || typeof runtime.acknowledge !== 'function' ||
        typeof runtime.dispose !== 'function' || typeof runtime.gpu?.encode !== 'function' ||
        typeof runtime.gpu?.runtime?.createSubmission !== 'function') {
        throw new TypeError('Flow velocity readiness requires one Virtual Raster runtime')
    }
}

function requireAbortSignal(signal: AbortSignal): AbortSignal {

    if (typeof signal?.aborted !== 'boolean' ||
        typeof signal.addEventListener !== 'function' ||
        typeof signal.removeEventListener !== 'function') {
        throw new TypeError('Flow velocity readiness requires an AbortSignal')
    }
    return signal
}

function abortReason(signal: AbortSignal): unknown {

    if (signal.reason !== undefined) return signal.reason
    const error = new Error('Flow velocity runtime readiness was aborted')
    error.name = 'AbortError'
    return error
}

function appendFailure(failures: unknown[], failure: unknown): void {

    if (!failures.includes(failure)) failures.push(failure)
}
