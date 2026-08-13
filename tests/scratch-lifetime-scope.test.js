import { expect } from 'chai'
import { LifetimeScope } from 'geoscratch/scratch'

describe('Scratch LifetimeScope', () => {

    it('stops scheduling, drains observations, and releases owners exactly once', async() => {

        const actions = []
        const lifetime = new LifetimeScope({ label: 'test-page' })
        let settleObservation
        const observation = new Promise(resolve => { settleObservation = resolve })

        lifetime.deferStop({ label: 'scheduler', run: () => { actions.push('stop') } })
        lifetime.own({ remove: () => { actions.push('map') } }, {
            label: 'map',
            release: value => value.remove(),
        })
        lifetime.own({ dispose: () => { actions.push('runtime') } }, {
            label: 'runtime',
            release: value => value.dispose(),
        })
        lifetime.track(observation.then(() => { actions.push('settled') }), 'frame')

        const firstDisposal = lifetime.dispose()
        const secondDisposal = lifetime.dispose()
        expect(secondDisposal).to.equal(firstDisposal)
        settleObservation()
        const report = await firstDisposal

        expect(actions).to.deep.equal([ 'stop', 'settled', 'runtime', 'map' ])
        expect(report).to.include({
            cleanupInvocationCount: 1,
            pendingObservationsBefore: 1,
            pendingObservationsAfter: 0,
            retainedActionCount: 0,
        })
        expect(report.cleanupFailures).to.deep.equal([])
        expect(lifetime.snapshot()).to.deep.include({
            label: 'test-page',
            state: 'disposed',
            activeActionCount: 0,
            pendingObservationCount: 0,
        })
    })

    it('releases an acquisition that settles after disposal', async() => {

        const lifetime = new LifetimeScope()
        let resolveRuntime
        let lateRuntimeDisposals = 0
        const acquisition = new Promise(resolve => { resolveRuntime = resolve })
        const primaryFailure = new Error('primary failure')
        const guarded = lifetime.acquire(acquisition, {
            label: 'runtime',
            release: value => value.dispose(),
        })

        const disposal = lifetime.dispose(primaryFailure)
        resolveRuntime({ dispose: () => { lateRuntimeDisposals++ } })

        let guardedFailure
        try {
            await guarded
        } catch (error) {
            guardedFailure = error
        }
        const report = await disposal

        expect(lifetime.isStopError(guardedFailure)).to.equal(true)
        expect(guardedFailure.code).to.equal('SCRATCH_LIFETIME_STOPPED')
        expect(lateRuntimeDisposals).to.equal(1)
        expect(report.primaryFailure).to.equal(primaryFailure)
        expect(report.cleanupActions).to.deep.include({
            phase: 'release',
            label: 'late-runtime',
            status: 'fulfilled',
        })
    })

    it('drains child work registered by a tracked task during disposal', async() => {

        const lifetime = new LifetimeScope()
        const actions = []
        let resumeParent
        let resolveChild
        const parentGate = new Promise(resolve => { resumeParent = resolve })
        const child = new Promise(resolve => { resolveChild = resolve })
        lifetime.deferRelease({
            label: 'runtime',
            run: () => { actions.push('release') },
        })
        lifetime.track((async() => {
            await parentGate
            await lifetime.track(child, 'late-child')
            actions.push('child-settled')
        })(), 'parent')

        let disposalSettled = false
        const disposal = lifetime.dispose().then(report => {
            disposalSettled = true
            return report
        })
        resumeParent()
        await new Promise(resolve => setImmediate(resolve))

        expect(disposalSettled).to.equal(false)
        resolveChild()
        const report = await disposal

        expect(actions).to.deep.equal([ 'child-settled', 'release' ])
        expect(report.cleanupFailures).to.deep.equal([])
    })

    it('does not duplicate the primary failure as a settlement failure', async() => {

        const lifetime = new LifetimeScope()
        const primaryFailure = new Error('tracked initialization failed')
        let rejectInitialization
        const initialization = new Promise((_resolve, reject) => {
            rejectInitialization = reject
        })
        lifetime.track(initialization, 'initialization')

        const disposal = lifetime.dispose(primaryFailure)
        rejectInitialization(primaryFailure)
        const report = await disposal

        expect(report.primaryFailure).to.equal(primaryFailure)
        expect(report.cleanupFailures).to.deep.equal([])
    })

    it('reports cleanup failures without replacing the primary failure', async() => {

        const lifetime = new LifetimeScope()
        const primaryFailure = new Error('pipeline failed')
        const cleanupFailure = new Error('map cleanup failed')
        lifetime.own({ remove: () => { throw cleanupFailure } }, {
            label: 'map',
            release: value => value.remove(),
        })

        const report = await lifetime.dispose(primaryFailure)

        expect(report.primaryFailure).to.equal(primaryFailure)
        expect(report.cleanupFailures).to.deep.equal([ {
            phase: 'release',
            label: 'map',
            error: cleanupFailure,
        } ])
    })

    it('validates labels and rejects new ownership after disposal starts', async() => {

        const lifetime = new LifetimeScope()
        expect(() => lifetime.deferStop({ label: '', run() {} })).to.throw(TypeError)
        expect(() => lifetime.track(Promise.resolve(), '')).to.throw(TypeError)

        const disposal = lifetime.dispose()
        expect(() => lifetime.assertActive()).to.throw('disposal has started')
        expect(() => lifetime.own({}, { label: 'late', release() {} }))
            .to.throw('disposal has started')
        await disposal
    })
})
