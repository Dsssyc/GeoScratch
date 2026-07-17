const CLEANUP_PHASES = new Set([ 'stop', 'release' ])

export function createPageLifetime() {
    const actions = {
        stop: [],
        release: [],
    }
    const pendingObservations = new Map()
    const cleanupActions = []
    const cleanupFailures = []
    let nextActionId = 1
    let nextObservationId = 1
    let state = 'active'
    let disposal
    let primaryFailure
    let cleanupInvocationCount = 0

    function snapshot() {
        return Object.freeze({
            state,
            activeActionCount: actions.stop.filter(({ active }) => active).length
                + actions.release.filter(({ active }) => active).length,
            pendingObservationCount: pendingObservations.size,
        })
    }

    function executeAction(action) {
        if (action.settlement) {
            return action.settlement
        }
        if (!action.active) {
            action.settlement = Promise.resolve()
            return action.settlement
        }

        action.active = false
        const run = action.run
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

    function defer({ phase, label, run }) {
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

        const action = {
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

    function track(observation, label = 'pending-observation') {
        if (state !== 'active') {
            throw new Error('Cannot track work after page disposal has started')
        }
        if (typeof label !== 'string' || label.length === 0) {
            throw new TypeError('Observation label must be a non-empty string')
        }

        const id = nextObservationId
        nextObservationId += 1
        const promise = Promise.resolve(observation)
        const entry = {
            id,
            label,
            settlement: undefined,
        }
        entry.settlement = promise.then(
            value => ({ status: 'fulfilled', value }),
            error => ({ status: 'rejected', error })
        ).finally(() => {
            pendingObservations.delete(id)
        })
        pendingObservations.set(id, entry)
        return promise
    }

    async function runPhase(phase) {
        const phaseActions = actions[phase]
        for (let index = phaseActions.length - 1; index >= 0; index -= 1) {
            const action = phaseActions[index]
            if (!action.active) {
                continue
            }
            await executeAction(action).catch(() => {})
        }
    }

    async function disposeOnce(pendingAtDisposal) {
        await runPhase('stop')

        const settlements = await Promise.all(
            pendingAtDisposal.map(({ settlement }) => settlement)
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
            retainedActionCount: 0,
            cleanupActions: Object.freeze([ ...cleanupActions ]),
            cleanupFailures: Object.freeze([ ...cleanupFailures ]),
        })
    }

    function dispose(failure) {
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
