type CleanupPhase = 'stop' | 'release'
type CleanupRun = () => unknown | PromiseLike<unknown>

type CleanupAction = {
    id: number
    phase: CleanupPhase
    label: string
    run: CleanupRun | undefined
    active: boolean
    settlement: Promise<void> | undefined
}

type CleanupActionResult = Readonly<{
    phase: CleanupPhase
    label: string
    status: 'fulfilled' | 'rejected'
}>

type CleanupFailure = Readonly<{
    phase: CleanupPhase | 'settle'
    label: string
    error: unknown
}>

type ObservationSettlement =
    | { status: 'fulfilled', value: unknown }
    | { status: 'rejected', error: unknown }

type PendingObservation = {
    id: number
    label: string
    settlement: Promise<ObservationSettlement> | undefined
}

type DisposalReport = Readonly<{
    primaryFailure: unknown
    cleanupInvocationCount: number
    pendingObservationsBefore: number
    pendingObservationsAfter: number
    retainedActionCount: 0
    cleanupActions: readonly CleanupActionResult[]
    cleanupFailures: readonly CleanupFailure[]
}>

type PageLifetimeState = 'active' | 'disposing' | 'disposed'

type DeferOptions = {
    phase: CleanupPhase
    label: string
    run: CleanupRun
}

const CLEANUP_PHASES = new Set<CleanupPhase>([ 'stop', 'release' ])

export function createPageLifetime() {
    const actions: Record<CleanupPhase, CleanupAction[]> = {
        stop: [],
        release: [],
    }
    const pendingObservations = new Map<number, PendingObservation>()
    const cleanupActions: CleanupActionResult[] = []
    const cleanupFailures: CleanupFailure[] = []
    let nextActionId = 1
    let nextObservationId = 1
    let state: PageLifetimeState = 'active'
    let disposal: Promise<DisposalReport> | undefined
    let primaryFailure: unknown
    let cleanupInvocationCount = 0

    function snapshot() {
        return Object.freeze({
            state,
            activeActionCount: actions.stop.filter(({ active }) => active).length
                + actions.release.filter(({ active }) => active).length,
            pendingObservationCount: pendingObservations.size,
        })
    }

    function executeAction(action: CleanupAction) {
        if (action.settlement) {
            return action.settlement
        }
        if (!action.active) {
            action.settlement = Promise.resolve()
            return action.settlement
        }

        action.active = false
        const run = action.run as CleanupRun
        action.run = undefined
        action.settlement = Promise.resolve()
            .then(run)
            .then(
                () => {
                    cleanupActions.push(Object.freeze({
                        phase: action.phase,
                        label: action.label,
                        status: 'fulfilled',
                    }))
                },
                error => {
                    cleanupActions.push(Object.freeze({
                        phase: action.phase,
                        label: action.label,
                        status: 'rejected',
                    }))
                    cleanupFailures.push(Object.freeze({
                        phase: action.phase,
                        label: action.label,
                        error,
                    }))
                    throw error
                }
            )
        return action.settlement
    }

    function defer({ phase, label, run }: DeferOptions) {
        if (state !== 'active') {
            throw new Error('Cannot register cleanup after page disposal has started')
        }
        if (!CLEANUP_PHASES.has(phase)) {
            throw new TypeError(`Unsupported cleanup phase: ${phase}`)
        }
        if (typeof label !== 'string' || label.length === 0) {
            throw new TypeError('Cleanup label must be a non-empty string')
        }
        if (typeof run !== 'function') {
            throw new TypeError('Cleanup action must be a function')
        }

        const action: CleanupAction = {
            id: nextActionId,
            phase,
            label,
            run,
            active: true,
            settlement: undefined,
        }
        nextActionId += 1
        actions[phase].push(action)

        return Object.freeze({
            run: () => executeAction(action),
            cancel: () => {
                if (action.settlement || !action.active) {
                    return false
                }
                action.active = false
                action.run = undefined
                return true
            },
            get isActive() {
                return action.active
            },
        })
    }

    function track<T>(observation: T, label = 'pending-observation') {
        if (state !== 'active') {
            throw new Error('Cannot track work after page disposal has started')
        }
        if (typeof label !== 'string' || label.length === 0) {
            throw new TypeError('Observation label must be a non-empty string')
        }

        const id = nextObservationId
        nextObservationId += 1
        const promise = Promise.resolve(observation)
        const entry: PendingObservation = {
            id,
            label,
            settlement: undefined,
        }
        entry.settlement = promise.then(
            value => ({ status: 'fulfilled' as const, value }),
            (error: unknown) => ({ status: 'rejected' as const, error })
        ).finally(() => {
            pendingObservations.delete(id)
        })
        pendingObservations.set(id, entry)
        return promise
    }

    async function runPhase(phase: CleanupPhase) {
        const phaseActions = actions[phase]
        for (let index = phaseActions.length - 1; index >= 0; index -= 1) {
            const action = phaseActions[index]
            if (action.settlement) {
                await action.settlement.catch(() => {})
                continue
            }
            if (!action.active) {
                continue
            }
            await executeAction(action).catch(() => {})
        }
    }

    async function disposeOnce(pendingAtDisposal: PendingObservation[]) {
        await runPhase('stop')

        const settlements = await Promise.all(
            pendingAtDisposal.map(({ settlement }) => settlement as Promise<ObservationSettlement>)
        )
        for (let index = 0; index < settlements.length; index += 1) {
            const settlement = settlements[index]
            if (settlement.status === 'rejected') {
                cleanupFailures.push(Object.freeze({
                    phase: 'settle',
                    label: pendingAtDisposal[index].label,
                    error: settlement.error,
                }))
            }
        }

        await runPhase('release')

        actions.stop.length = 0
        actions.release.length = 0
        pendingObservations.clear()
        state = 'disposed'

        return Object.freeze({
            primaryFailure,
            cleanupInvocationCount,
            pendingObservationsBefore: pendingAtDisposal.length,
            pendingObservationsAfter: pendingObservations.size,
            retainedActionCount: 0 as const,
            cleanupActions: Object.freeze([ ...cleanupActions ]),
            cleanupFailures: Object.freeze([ ...cleanupFailures ]),
        })
    }

    function dispose(failure?: unknown) {
        if (disposal) {
            return disposal
        }

        state = 'disposing'
        primaryFailure = failure
        cleanupInvocationCount = 1
        const pendingAtDisposal = [ ...pendingObservations.values() ]
        disposal = disposeOnce(pendingAtDisposal)
        return disposal
    }

    return Object.freeze({
        defer,
        track,
        dispose,
        snapshot,
    })
}
