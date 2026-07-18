import { expect } from 'chai'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const moduleUrl = pathToFileURL(path.join(
    process.cwd(),
    'examples',
    'flowLayer',
    'flow-lifecycle.js'
)).href

describe('Flow Layer lifecycle authority', () => {

    it('stops, settles, terminates, removes, and disposes exactly once in order', async() => {

        const { createFlowLifecycle } = await import(moduleUrl)
        const order = []
        const primaryFailure = new Error('primary')
        let settle
        const pending = new Promise(resolve => { settle = resolve })
        const lifecycle = createFlowLifecycle()

        lifecycle.ownWorker({ terminate: () => order.push('worker') })
        lifecycle.ownMap({ remove: () => order.push('map') })
        lifecycle.ownRuntime({ dispose: () => order.push('runtime') })
        lifecycle.deferStop({ label: 'scheduler', run: () => order.push('stop') })
        lifecycle.track(pending.then(() => order.push('settle')), 'submitted-work')

        const first = lifecycle.dispose(primaryFailure)
        const second = lifecycle.dispose(new Error('secondary invocation'))
        expect(second).to.equal(first)
        settle()
        const report = await first

        expect(order).to.deep.equal([ 'stop', 'settle', 'worker', 'map', 'runtime' ])
        expect(report.primaryFailure).to.equal(primaryFailure)
        expect(report.cleanupInvocationCount).to.equal(1)
        expect(report.pendingObservationsBefore).to.equal(1)
        expect(report.pendingObservationsAfter).to.equal(0)
        expect(report.cleanupFailures).to.deep.equal([])
        expect(lifecycle.snapshot()).to.deep.include({
            state: 'disposed',
            pendingObservationCount: 0,
        })
    })

    it('preserves the primary failure while continuing after cleanup failures', async() => {

        const { createFlowLifecycle } = await import(moduleUrl)
        const order = []
        const primaryFailure = new Error('primary')
        const lifecycle = createFlowLifecycle()

        lifecycle.ownWorker({ terminate: () => {
            order.push('worker')
            throw new Error('worker cleanup')
        } })
        lifecycle.ownMap({ remove: () => {
            order.push('map')
            throw new Error('map cleanup')
        } })
        lifecycle.ownRuntime({ dispose: () => order.push('runtime') })
        lifecycle.deferStop({ label: 'listener', run: () => {
            order.push('stop')
            throw new Error('listener cleanup')
        } })

        const report = await lifecycle.dispose(primaryFailure)

        expect(order).to.deep.equal([ 'stop', 'worker', 'map', 'runtime' ])
        expect(report.primaryFailure).to.equal(primaryFailure)
        expect(report.cleanupFailures.map(failure => failure.label)).to.deep.equal([
            'listener',
            'flow-worker',
            'maplibre-map',
        ])
        expect(report.cleanupActions.at(-1)).to.deep.include({
            phase: 'release',
            label: 'scratch-runtime',
            status: 'fulfilled',
        })
    })
})
