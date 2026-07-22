import type { ScratchRuntime } from 'geoscratch'
import type { FlowMap } from './flow-map.ts'

type FlowLifecycleState = 'active' | 'disposing' | 'disposed'
type FlowCleanupPhase = 'stop' | 'settle' | 'release'

type FlowLifecycleStopError = Error & {
    code: 'FLOW_LIFECYCLE_STOPPED'
}

type StopAction = {
    id: number
    label: string
    run: (() => void | Promise<void>) | undefined
    active: boolean
}

type ObservationSettlement =
    | Readonly<{ status: 'fulfilled'; value: unknown }>
    | Readonly<{ status: 'rejected'; error: unknown }>

type ObservationEntry = Readonly<{
    id: number
    label: string
    settlement: Promise<ObservationSettlement>
}>

export type FlowCleanupAction = Readonly<{
    phase: FlowCleanupPhase
    label: string
    status: 'fulfilled' | 'rejected'
}>

export type FlowCleanupFailure = Readonly<{
    phase: FlowCleanupPhase
    label: string
    error: unknown
}>

export type FlowCleanupReport = Readonly<{
    primaryFailure: unknown
    cleanupInvocationCount: number
    pendingObservationsBefore: number
    pendingObservationsAfter: number
    retainedActionCount: number
    cleanupActions: readonly FlowCleanupAction[]
    cleanupFailures: readonly FlowCleanupFailure[]
}>

export type FlowLifecycleSnapshot = Readonly<{
    state: FlowLifecycleState
    activeActionCount: number
    pendingObservationCount: number
    ownsWorker: boolean
    ownsMap: boolean
    ownsRuntime: boolean
}>

export type FlowLifecycle = Readonly<{
    ownWorker(value: Worker): Worker
    ownMap(value: FlowMap): FlowMap
    ownRuntime(value: ScratchRuntime): ScratchRuntime
    acquireRuntime(acquisition: ScratchRuntime | PromiseLike<ScratchRuntime>): Promise<ScratchRuntime>
    deferStop(action: Readonly<{
        label: string
        run: () => void | Promise<void>
    }>): Readonly<{ cancel(): boolean; readonly isActive: boolean }>
    track<T>(observation: T | PromiseLike<T>, label?: string): Promise<Awaited<T>>
    drain(): Promise<FlowLifecycleSnapshot>
    dispose(failure?: unknown): Promise<FlowCleanupReport>
    snapshot(): FlowLifecycleSnapshot
    assertActive(action: string): void
    isStopError(error: unknown): boolean
    signal: AbortSignal
}>

export function createFlowLifecycle() {

    const abortController = new AbortController()
    const stopActions: StopAction[] = []
    const pendingObservations = new Map<number, ObservationEntry>()
    const cleanupActions: FlowCleanupAction[] = []
    const cleanupFailures: FlowCleanupFailure[] = []
    let worker: Worker | undefined
    let map: FlowMap | undefined
    let runtime: ScratchRuntime | undefined
    let nextActionId = 1
    let nextObservationId = 1
    let state: FlowLifecycleState = 'active'
    let disposal: Promise<FlowCleanupReport> | undefined
    let primaryFailure: unknown
    let stopError: FlowLifecycleStopError | undefined
    let cleanupInvocationCount = 0

    function lifecycleStopError(): FlowLifecycleStopError {

        if (stopError !== undefined) return stopError
        stopError = new Error('Flow lifecycle disposal has started') as FlowLifecycleStopError
        stopError.name = 'FlowLifecycleStoppedError'
        stopError.code = 'FLOW_LIFECYCLE_STOPPED'
        return stopError
    }

    function isStopError(error: unknown): boolean {

        return (error as Readonly<{ code?: unknown }> | null | undefined)?.code ===
            'FLOW_LIFECYCLE_STOPPED'
    }

    function assertActive(action: string): void {

        if (state !== 'active') throw lifecycleStopError()
    }

    function own<T extends Worker | FlowMap | ScratchRuntime>(
        kind: 'worker' | 'map' | 'runtime',
        value: T
    ): T {

        assertActive(`own ${kind}`)
        if (value === undefined || value === null) throw new TypeError(`${kind} must be defined`)
        if (kind === 'worker') {
            if (worker !== undefined) throw new Error('Flow worker ownership is already established')
            worker = value as Worker
        } else if (kind === 'map') {
            if (map !== undefined) throw new Error('Flow map ownership is already established')
            map = value as FlowMap
        } else {
            if (runtime !== undefined) throw new Error('Flow runtime ownership is already established')
            runtime = value as ScratchRuntime
        }
        return value
    }

    function deferStop({ label, run }: Readonly<{
        label: string
        run: () => void | Promise<void>
    }>) {

        assertActive('register cleanup')
        if (typeof label !== 'string' || label.length === 0) {
            throw new TypeError('Flow stop action label must be a non-empty string')
        }
        if (typeof run !== 'function') throw new TypeError('Flow stop action must be a function')

        const action: StopAction = {
            id: nextActionId++,
            label,
            run,
            active: true,
        }
        stopActions.push(action)
        return Object.freeze({
            cancel() {
                if (!action.active) return false
                action.active = false
                action.run = undefined
                return true
            },
            get isActive() {
                return action.active
            },
        })
    }

    function track<T>(observation: T | PromiseLike<T>, label = 'submitted-work'): Promise<Awaited<T>> {

        assertActive('track work')
        if (typeof label !== 'string' || label.length === 0) {
            throw new TypeError('Flow observation label must be a non-empty string')
        }

        const id = nextObservationId++
        const promise = Promise.resolve(observation)
        const entry = {
            id,
            label,
            settlement: promise.then(
                value => ({ status: 'fulfilled' as const, value }),
                (error: unknown) => ({ status: 'rejected' as const, error })
            ).finally(() => pendingObservations.delete(id)),
        }
        pendingObservations.set(id, entry)
        return promise
    }

    function acquireRuntime(
        acquisition: ScratchRuntime | PromiseLike<ScratchRuntime>
    ): Promise<ScratchRuntime> {

        assertActive('acquire Scratch runtime')
        const guarded = Promise.resolve(acquisition).then(async value => {
            if (state !== 'active') {
                await recordAction('release', 'late-scratch-runtime', () => value.dispose())
                throw lifecycleStopError()
            }
            return own('runtime', value)
        })
        return track(guarded, 'scratch-runtime-acquisition')
    }

    async function recordAction(
        phase: FlowCleanupPhase,
        label: string,
        run: () => void | Promise<void>
    ): Promise<void> {

        try {
            await run()
            cleanupActions.push(Object.freeze({ phase, label, status: 'fulfilled' }))
        } catch (error) {
            cleanupActions.push(Object.freeze({ phase, label, status: 'rejected' }))
            cleanupFailures.push(Object.freeze({ phase, label, error }))
        }
    }

    async function runStopActions(): Promise<void> {

        for (let index = stopActions.length - 1; index >= 0; index--) {
            const action = stopActions[index]
            if (!action.active) continue
            action.active = false
            const run = action.run
            action.run = undefined
            await recordAction('stop', action.label, run as () => void | Promise<void>)
        }
    }

    async function settle(entries: readonly ObservationEntry[]): Promise<void> {

        const settlements = await Promise.all(entries.map(entry => entry.settlement))
        for (let index = 0; index < settlements.length; index++) {
            const settlement = settlements[index]
            if (settlement.status !== 'rejected' || isStopError(settlement.error)) continue
            cleanupFailures.push(Object.freeze({
                phase: 'settle',
                label: entries[index].label,
                error: settlement.error,
            }))
        }
    }

    async function drain(): Promise<FlowLifecycleSnapshot> {

        while (pendingObservations.size > 0) {
            await settle([ ...pendingObservations.values() ])
        }
        return snapshot()
    }

    async function disposeOnce(
        pendingAtDisposal: readonly ObservationEntry[]
    ): Promise<FlowCleanupReport> {

        await runStopActions()
        await settle(pendingAtDisposal)

        if (worker !== undefined) {
            await recordAction('release', 'flow-worker', () => worker!.terminate())
        }
        if (map !== undefined) {
            await recordAction('release', 'maplibre-map', () => map!.remove())
        }
        if (runtime !== undefined) {
            await recordAction('release', 'scratch-runtime', () => runtime!.dispose())
        }

        worker = undefined
        map = undefined
        runtime = undefined
        stopActions.length = 0
        pendingObservations.clear()
        state = 'disposed'

        return Object.freeze({
            primaryFailure,
            cleanupInvocationCount,
            pendingObservationsBefore: pendingAtDisposal.length,
            pendingObservationsAfter: pendingObservations.size,
            retainedActionCount: 0,
            cleanupActions: Object.freeze([ ...cleanupActions ]),
            cleanupFailures: Object.freeze([ ...cleanupFailures ]),
        })
    }

    function dispose(failure?: unknown): Promise<FlowCleanupReport> {

        if (disposal !== undefined) return disposal
        state = 'disposing'
        primaryFailure = failure
        cleanupInvocationCount = 1
        abortController.abort(lifecycleStopError())
        disposal = disposeOnce([ ...pendingObservations.values() ])
        return disposal
    }

    function snapshot(): FlowLifecycleSnapshot {

        return Object.freeze({
            state,
            activeActionCount: stopActions.filter(action => action.active).length,
            pendingObservationCount: pendingObservations.size,
            ownsWorker: worker !== undefined,
            ownsMap: map !== undefined,
            ownsRuntime: runtime !== undefined,
        })
    }

    return Object.freeze({
        ownWorker: value => own('worker', value),
        ownMap: value => own('map', value),
        ownRuntime: value => own('runtime', value),
        acquireRuntime,
        deferStop,
        track,
        drain,
        dispose,
        snapshot,
        assertActive,
        isStopError,
        signal: abortController.signal,
    }) satisfies FlowLifecycle
}
