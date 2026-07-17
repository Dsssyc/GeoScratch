import { expect } from 'chai'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const moduleUrl = pathToFileURL(
    path.join(process.cwd(), 'examples', 'helloGAW', 'page-lifetime.js')
).href

describe('Hello GAW page lifetime authority', () => {

    let createPageLifetime
    let loadError

    before(async () => {
        try {
            ({ createPageLifetime } = await import(moduleUrl))
        } catch (error) {
            loadError = error
        }
    })

    function createLifetime() {
        expect(loadError, loadError?.message).to.equal(undefined)
        expect(createPageLifetime).to.be.a('function')
        return createPageLifetime()
    }

    it('stops producers, settles observations, then releases ownership in reverse order', async () => {
        const lifetime = createLifetime()
        const order = []

        lifetime.defer({ phase: 'release', label: 'runtime', run: () => order.push('runtime') })
        lifetime.defer({ phase: 'release', label: 'bitmap', run: () => order.push('bitmap') })
        lifetime.defer({ phase: 'stop', label: 'listener', run: () => order.push('listener') })
        lifetime.defer({ phase: 'stop', label: 'frame', run: () => order.push('frame') })

        const report = await lifetime.dispose()

        expect(order).to.deep.equal([ 'frame', 'listener', 'bitmap', 'runtime' ])
        expect(report.cleanupActions.map(({ label }) => label)).to.deep.equal(order)
        expect(report.cleanupFailures).to.deep.equal([])
    })

    it('waits for tracked observations before releasing owned values', async () => {
        const lifetime = createLifetime()
        let settle
        let released = false
        const observation = new Promise(resolve => {
            settle = resolve
        })

        lifetime.track(observation, 'initial-submission')
        lifetime.defer({
            phase: 'release',
            label: 'runtime',
            run: () => {
                released = true
            },
        })

        const disposal = lifetime.dispose()
        await Promise.resolve()

        expect(released).to.equal(false)
        expect(lifetime.snapshot().pendingObservationCount).to.equal(1)

        settle()
        const report = await disposal

        expect(released).to.equal(true)
        expect(report.pendingObservationsBefore).to.equal(1)
        expect(report.pendingObservationsAfter).to.equal(0)
    })

    it('returns the same disposal settlement and preserves the first primary failure', async () => {
        const lifetime = createLifetime()
        const primaryFailure = new Error('primary')
        const laterFailure = new Error('later')
        let releases = 0

        lifetime.defer({
            phase: 'release',
            label: 'runtime',
            run: () => {
                releases += 1
            },
        })

        const first = lifetime.dispose(primaryFailure)
        const second = lifetime.dispose(laterFailure)

        expect(second).to.equal(first)

        const report = await first
        expect(report.primaryFailure).to.equal(primaryFailure)
        expect(report.cleanupInvocationCount).to.equal(1)
        expect(releases).to.equal(1)
    })

    it('allows successful-path ownership release exactly once', async () => {
        const lifetime = createLifetime()
        let releases = 0
        const ownership = lifetime.defer({
            phase: 'release',
            label: 'bitmap',
            run: () => {
                releases += 1
            },
        })

        const first = ownership.run()
        const second = ownership.run()

        expect(second).to.equal(first)
        await first
        await lifetime.dispose()

        expect(releases).to.equal(1)
    })

    it('waits for an already-started async release before later ownership cleanup', async () => {
        const lifetime = createLifetime()
        const order = []
        let settleBitmap
        let disposalSettled = false
        const bitmapSettlement = new Promise(resolve => {
            settleBitmap = resolve
        })

        lifetime.defer({
            phase: 'release',
            label: 'runtime',
            run: () => order.push('runtime'),
        })
        const bitmap = lifetime.defer({
            phase: 'release',
            label: 'bitmap',
            run: async() => {
                order.push('bitmap:start')
                await bitmapSettlement
                order.push('bitmap:end')
            },
        })

        const startedRelease = bitmap.run()
        await Promise.resolve()
        const disposal = lifetime.dispose()
        void disposal.then(() => { disposalSettled = true })
        await new Promise(resolve => setTimeout(resolve, 0))

        expect(order).to.deep.equal([ 'bitmap:start' ])
        expect(disposalSettled).to.equal(false)

        settleBitmap()
        await startedRelease
        const report = await disposal

        expect(order).to.deep.equal([ 'bitmap:start', 'bitmap:end', 'runtime' ])
        expect(report.cleanupActions.map(({ label }) => label))
            .to.deep.equal([ 'bitmap', 'runtime' ])
    })

    it('runs every cleanup action while retaining cleanup failures as secondary facts', async () => {
        const lifetime = createLifetime()
        const primaryFailure = new Error('initialization failed')
        const cleanupFailure = new Error('bitmap close failed')
        const order = []

        lifetime.defer({ phase: 'release', label: 'runtime', run: () => order.push('runtime') })
        lifetime.defer({
            phase: 'release',
            label: 'bitmap',
            run: () => {
                order.push('bitmap')
                throw cleanupFailure
            },
        })

        const report = await lifetime.dispose(primaryFailure)

        expect(order).to.deep.equal([ 'bitmap', 'runtime' ])
        expect(report.primaryFailure).to.equal(primaryFailure)
        expect(report.cleanupFailures).to.have.length(1)
        expect(report.cleanupFailures[0]).to.deep.include({
            phase: 'release',
            label: 'bitmap',
            error: cleanupFailure,
        })
    })

    it('records rejected pending observations without skipping ownership release', async () => {
        const lifetime = createLifetime()
        const observationFailure = new Error('submission rejected')
        let released = false

        lifetime.track(Promise.reject(observationFailure), 'initial-submission')
        lifetime.defer({
            phase: 'release',
            label: 'runtime',
            run: () => {
                released = true
            },
        })

        const report = await lifetime.dispose()

        expect(released).to.equal(true)
        expect(report.cleanupFailures).to.have.length(1)
        expect(report.cleanupFailures[0]).to.deep.include({
            phase: 'settle',
            label: 'initial-submission',
            error: observationFailure,
        })
    })

    it('clears retained cleanup and observation references after disposal', async () => {
        const lifetime = createLifetime()

        lifetime.defer({ phase: 'stop', label: 'listener', run: () => {} })
        lifetime.defer({ phase: 'release', label: 'runtime', run: () => {} })
        lifetime.track(Promise.resolve(), 'settled-submission')

        await lifetime.dispose()
        const snapshot = lifetime.snapshot()

        expect(snapshot).to.deep.include({
            state: 'disposed',
            activeActionCount: 0,
            pendingObservationCount: 0,
        })
    })
})
