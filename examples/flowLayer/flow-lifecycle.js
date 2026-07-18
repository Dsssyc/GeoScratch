export function createFlowLifecycle() {

    const stopActions = []
    const pendingObservations = new Map()
    const cleanupActions = []
    const cleanupFailures = []
    let worker
    let map
    let runtime
    let nextActionId = 1
    let nextObservationId = 1
    let state = 'active'
    let disposal
    let primaryFailure
    let cleanupInvocationCount = 0

    function assertActive(action) {

        if (state !== 'active') throw new Error(`Cannot ${action} after Flow disposal has started`)
    }

    function own(kind, value) {

        assertActive(`own ${kind}`)
        if (value === undefined || value === null) throw new TypeError(`${kind} must be defined`)
        if (kind === 'worker') {
            if (worker !== undefined) throw new Error('Flow worker ownership is already established')
            worker = value
        } else if (kind === 'map') {
            if (map !== undefined) throw new Error('Flow map ownership is already established')
            map = value
        } else {
            if (runtime !== undefined) throw new Error('Flow runtime ownership is already established')
            runtime = value
        }
        return value
    }

    function deferStop({ label, run }) {

        assertActive('register cleanup')
        if (typeof label !== 'string' || label.length === 0) {
            throw new TypeError('Flow stop action label must be a non-empty string')
        }
        if (typeof run !== 'function') throw new TypeError('Flow stop action must be a function')

        const action = {
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

    function track(observation, label = 'submitted-work') {

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
                value => ({ status: 'fulfilled', value }),
                error => ({ status: 'rejected', error })
            ).finally(() => pendingObservations.delete(id)),
        }
        pendingObservations.set(id, entry)
        return promise
    }

    async function recordAction(phase, label, run) {

        try {
            await run()
            cleanupActions.push(Object.freeze({ phase, label, status: 'fulfilled' }))
        } catch (error) {
            cleanupActions.push(Object.freeze({ phase, label, status: 'rejected' }))
            cleanupFailures.push(Object.freeze({ phase, label, error }))
        }
    }

    async function runStopActions() {

        for (let index = stopActions.length - 1; index >= 0; index--) {
            const action = stopActions[index]
            if (!action.active) continue
            action.active = false
            const run = action.run
            action.run = undefined
            await recordAction('stop', action.label, run)
        }
    }

    async function settle(entries) {

        const settlements = await Promise.all(entries.map(entry => entry.settlement))
        for (let index = 0; index < settlements.length; index++) {
            const settlement = settlements[index]
            if (settlement.status !== 'rejected') continue
            cleanupFailures.push(Object.freeze({
                phase: 'settle',
                label: entries[index].label,
                error: settlement.error,
            }))
        }
    }

    async function drain() {

        while (pendingObservations.size > 0) {
            await settle([ ...pendingObservations.values() ])
        }
        return snapshot()
    }

    async function disposeOnce(pendingAtDisposal) {

        await runStopActions()
        await settle(pendingAtDisposal)

        if (worker !== undefined) {
            await recordAction('release', 'flow-worker', () => worker.terminate())
        }
        if (map !== undefined) {
            await recordAction('release', 'maplibre-map', () => map.remove())
        }
        if (runtime !== undefined) {
            await recordAction('release', 'scratch-runtime', () => runtime.dispose())
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

    function dispose(failure) {

        if (disposal !== undefined) return disposal
        state = 'disposing'
        primaryFailure = failure
        cleanupInvocationCount = 1
        disposal = disposeOnce([ ...pendingObservations.values() ])
        return disposal
    }

    function snapshot() {

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
        deferStop,
        track,
        drain,
        dispose,
        snapshot,
    })
}
