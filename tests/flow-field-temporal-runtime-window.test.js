import { expect } from 'chai'
import {
    createFlowTemporalRuntimeWindow,
} from '../examples/flowField/flow-temporal-runtime-window.ts'

const HASH = '0123456789abcdef'.repeat(4)
const DATASET_IDENTITY = Object.freeze({
    datasetId: 'flow-window-test',
    sourceHash: HASH,
    contentVersion: 'flow-window-test-v1',
})

describe('Flow temporal runtime window', () => {

    it('owns one unique runtime for an exact selection', async() => {

        const harness = immediateHarness(timeAxis([ 0 ], [ 5 ]))
        const ticket = harness.window.request(exact(harness.axis.samples[0]), 0)

        expect(await ticket.settled).to.deep.include({ status: 'ready', pairGeneration: 1 })
        const capture = harness.window.capture()
        expect(capture).to.deep.include({ state: 'ready', alpha: 0 })
        expect(capture.lower.runtime).to.equal(capture.upper.runtime)
        expect(harness.created).to.deep.equal([ 't00' ])
        expect(harness.window.snapshot()).to.deep.include({
            activeSampleKeys: [ 't00' ],
            ownedRuntimeCount: 1,
        })

        capture.release()
        capture.release()
        await harness.window.dispose()
        expect(harness.disposed).to.deep.equal([ 'runtime-t00-1' ])
    })

    it('reuses the shared sample while replacing A/B with B/C', async() => {

        const harness = immediateHarness(timeAxis([ 0, 1, 2 ], [ 0, 10, 20 ]))
        await harness.window.request(interpolated(harness.axis, 0, 1, 5), 1).settled
        const oldCapture = harness.window.capture()
        const replacement = harness.window.request(interpolated(harness.axis, 1, 2, 15), 1)

        expect(await replacement.settled).to.deep.include({ status: 'ready', pairGeneration: 2 })
        const current = harness.window.capture()
        expect(current.lower.sample.sampleKey).to.equal('t01')
        expect(current.upper.sample.sampleKey).to.equal('t02')
        expect(current.lower.runtime).to.equal(oldCapture.upper.runtime)
        expect(harness.created).to.deep.equal([ 't00', 't01', 't02' ])
        expect(harness.disposed).to.not.include('runtime-t00-1')

        oldCapture.release()
        current.release()
        await waitFor(() => harness.disposed.includes('runtime-t00-1'))
        expect(harness.disposed).to.include('runtime-t00-1')
        await harness.window.dispose()
        expect(new Set(harness.disposed).size).to.equal(3)
    })

    it('retargets alpha on one candidate PairWork without restarting it', async() => {

        const axis = timeAxis([ 0, 1 ], [ 0, 10 ])
        const factory = controlledFactory()
        const harness = windowHarness(axis, factory.create)
        const first = harness.window.request(interpolated(axis, 0, 1, 2.5), 1)
        await settleMicrotasks()
        const second = harness.window.request(interpolated(axis, 0, 1, 7.5), 1)

        expect(await first.settled).to.deep.include({ status: 'superseded' })
        expect(factory.calls.map(call => call.sampleKey)).to.deep.equal([ 't00', 't01' ])
        factory.resolveAll()
        expect(await second.settled).to.deep.include({ status: 'ready' })
        const capture = harness.window.capture()
        expect(capture).to.deep.include({ state: 'ready', alpha: 0.75 })
        expect(factory.calls).to.have.length(2)

        capture.release()
        await harness.window.dispose()
        expect(harness.disposed).to.have.length(2)
    })

    it('waits for ignored-abort late completion before starting the latest pair', async() => {

        const axis = timeAxis([ 0, 1, 2, 3, 4 ], [ 0, 10, 20, 30, 40 ])
        const factory = controlledFactory()
        const harness = windowHarness(axis, factory.create)
        const first = harness.window.request(interpolated(axis, 0, 1, 5), 1)
        await settleMicrotasks()
        const middle = harness.window.request(interpolated(axis, 2, 3, 25), 1)
        const latest = harness.window.request(interpolated(axis, 3, 4, 35), 1)

        expect(await first.settled).to.deep.include({ status: 'superseded' })
        expect(await middle.settled).to.deep.include({ status: 'superseded' })
        expect(factory.calls.map(call => call.sampleKey)).to.deep.equal([ 't00', 't01' ])
        expect(harness.window.snapshot().pendingCreationCount).to.equal(2)
        factory.resolve('t00')
        factory.resolve('t01')
        await waitFor(() => factory.calls.length === 4)
        expect(factory.calls.map(call => call.sampleKey)).to.deep.equal([
            't00', 't01', 't03', 't04',
        ])
        expect(harness.disposed).to.have.members([ 'runtime-t00-1', 'runtime-t01-2' ])

        factory.resolve('t03')
        factory.resolve('t04')
        expect(await latest.settled).to.deep.include({ status: 'ready' })
        await harness.window.dispose()
        expect(new Set(harness.disposed).size).to.equal(4)
    })

    it('activates a gap synchronously and retires captured runtimes later', async() => {

        const axis = timeAxis([ 0, 1, 4 ], [ 0, 10, 40 ])
        const harness = immediateHarness(axis)
        await harness.window.request(exact(axis.samples[1]), 1).settled
        const held = harness.window.capture()
        const gapTicket = harness.window.request(gap(axis, 1, 2, 20), 1)

        expect(await gapTicket.settled).to.deep.equal({
            status: 'gap',
            revision: gapTicket.revision,
        })
        expect(harness.window.capture()).to.deep.include({ state: 'gap' })
        expect(harness.disposed).to.deep.equal([])

        held.release()
        await waitFor(() => harness.disposed.length === 1)
        expect(harness.disposed).to.deep.equal([ 'runtime-t01-1' ])
        await harness.window.dispose()
    })

    it('waits for a captured retired pair before admitting two new runtimes', async() => {

        const axis = timeAxis([ 0, 1, 2, 3, 4 ], [ 0, 10, 20, 30, 40 ])
        const harness = immediateHarness(axis)
        await harness.window.request(interpolated(axis, 0, 1, 5), 1).settled
        const held = harness.window.capture()
        await harness.window.request(interpolated(axis, 1, 2, 15), 1).settled
        const latest = harness.window.request(interpolated(axis, 3, 4, 35), 1)
        await settleMicrotasks(6)

        expect(harness.created).to.deep.equal([ 't00', 't01', 't02' ])
        expect(harness.window.snapshot()).to.deep.include({
            state: 'loading',
            ownedRuntimeCount: 3,
        })
        held.release()
        expect(await latest.settled).to.deep.include({ status: 'ready' })
        expect(harness.created).to.deep.equal([ 't00', 't01', 't02', 't03', 't04' ])
        expect(harness.window.snapshot().ownedRuntimeCount).to.be.at.most(4)

        await harness.window.dispose()
        expect(new Set(harness.disposed).size).to.equal(5)
    })

    it('reports ordinary factory failure and releases partial success', async() => {

        const axis = timeAxis([ 0, 1 ], [ 0, 10 ])
        let failUpper = true
        const harness = windowHarness(axis, async sample => {
            if (sample.sampleKey === 't01' && failUpper) {
                failUpper = false
                throw new Error('factory failed')
            }
            return { id: `runtime-${sample.sampleKey}`, sampleKey: sample.sampleKey }
        })
        const result = await harness.window.request(interpolated(axis, 0, 1, 5), 1).settled

        expect(result).to.deep.include({ status: 'failed' })
        expect(harness.window.capture()).to.deep.include({
            state: 'failed',
            failureCode: 'runtime-failed',
        })
        expect(harness.disposed).to.deep.equal([ 'runtime-t00' ])

        const retry = harness.window.request(exact(axis.samples[0]), -1)
        expect(await retry.settled).to.deep.include({ status: 'ready' })
        const capture = harness.window.capture()
        expect(capture.lower.sample.sampleKey).to.equal('t00')
        capture.release()
        await harness.window.dispose()
        expect(harness.disposed).to.deep.equal([ 'runtime-t00', 'runtime-t00' ])
    })

    it('aborts a sibling creation as soon as the primary factory fails', async() => {

        const axis = timeAxis([ 0, 1 ], [ 0, 10 ])
        let siblingAborted = false
        const harness = windowHarness(axis, async(sample, context) => {
            if (sample.sampleKey === 't00') throw new Error('primary failed')
            return await new Promise((_resolve, reject) => {
                context.signal.addEventListener('abort', () => {
                    siblingAborted = true
                    reject(context.signal.reason)
                }, { once: true })
            })
        })
        const result = await harness.window.request(interpolated(axis, 0, 1, 5), 1).settled

        expect(result).to.deep.include({ status: 'failed' })
        expect(harness.window.snapshot().failureCode).to.equal('runtime-failed')
        expect(siblingAborted).to.equal(true)
        await harness.window.dispose()
    })

    it('makes cleanup failure fatal without overwriting the counted lease', async() => {

        const axis = timeAxis([ 0, 1 ], [ 0, 10 ])
        let sequence = 0
        const disposed = []
        const window = createFlowTemporalRuntimeWindow({
            datasetIdentity: DATASET_IDENTITY,
            timeAxis: axis,
            maxOwnedRuntimes: 4,
            maxCreationSettleMs: 1000,
            async createReadyRuntime(sample) {
                return { id: `runtime-${sample.sampleKey}-${++sequence}`, sampleKey: sample.sampleKey }
            },
            async stopRuntimeRequests() {},
            async disposeRuntime(runtime) {
                disposed.push(runtime.id)
                if (runtime.id === 'runtime-t00-1') throw new Error('cleanup failed')
            },
        })
        await window.request(exact(axis.samples[0]), 1).settled
        await window.request(exact(axis.samples[1]), 1).settled
        await waitFor(() => window.snapshot().failureCode === 'runtime-cleanup-failed')

        expect(window.snapshot()).to.deep.include({
            state: 'failed',
            failureCode: 'runtime-cleanup-failed',
            ownedRuntimeCount: 2,
        })
        expect(() => window.request(exact(axis.samples[0]), -1))
            .to.throw(/runtime-cleanup-failed/)
        expect(sequence).to.equal(2)

        let disposalFailure
        try {
            await window.dispose()
        } catch (error) {
            disposalFailure = error
        }
        expect(disposalFailure).to.be.instanceOf(AggregateError)
        expect(disposed).to.have.members([ 'runtime-t00-1', 'runtime-t01-2' ])
    })

    it('enters a fatal state on an unresponsive factory and disposes later success once', async() => {

        const axis = timeAxis([ 0 ], [ 0 ])
        const factory = controlledFactory()
        const harness = windowHarness(axis, factory.create, 15)
        const ticket = harness.window.request(exact(axis.samples[0]), 0)
        const result = await ticket.settled

        expect(result).to.deep.include({ status: 'failed' })
        expect(harness.window.capture()).to.deep.include({
            state: 'failed',
            failureCode: 'factory-unresponsive',
        })
        expect(() => harness.window.request(exact(axis.samples[0]), 0))
            .to.throw(/unresponsive/)

        factory.resolve('t00')
        await settleMicrotasks(6)
        expect(harness.disposed).to.deep.equal([ 'runtime-t00-1' ])
        let disposalFailure
        try {
            await harness.window.dispose()
        } catch (error) {
            disposalFailure = error
        }
        expect(disposalFailure).to.be.instanceOf(AggregateError)
        expect(harness.disposed).to.deep.equal([ 'runtime-t00-1' ])
    })

    it('never accepts or disposes an active runtime returned by a late duplicate factory', async() => {

        const axis = timeAxis([ 0, 1 ], [ 0, 10 ])
        const shared = { id: 'shared-runtime', sampleKey: 't00' }
        let resolveLate
        const disposed = []
        const window = createFlowTemporalRuntimeWindow({
            datasetIdentity: DATASET_IDENTITY,
            timeAxis: axis,
            maxOwnedRuntimes: 4,
            maxCreationSettleMs: 15,
            createReadyRuntime(sample) {
                if (sample.sampleKey === 't00') return Promise.resolve(shared)
                return new Promise(resolve => { resolveLate = resolve })
            },
            async stopRuntimeRequests() {},
            async disposeRuntime(runtime) { disposed.push(runtime.id) },
        })
        await window.request(exact(axis.samples[0]), 1).settled
        const failed = await window.request(exact(axis.samples[1]), 1).settled
        expect(failed).to.deep.include({ status: 'failed' })

        resolveLate(shared)
        await settleMicrotasks(6)
        expect(disposed).to.deep.equal([])
        const capture = window.capture()
        expect(capture.state).to.equal('failed')

        let disposalFailure
        try {
            await window.dispose()
        } catch (error) {
            disposalFailure = error
        }
        expect(disposalFailure).to.be.instanceOf(AggregateError)
        expect(disposed).to.deep.equal([ 'shared-runtime' ])
    })

    it('counts a slow retiring same-key runtime until its disposal settles', async() => {

        const axis = timeAxis([ 0, 2 ], [ 0, 20 ])
        let sequence = 0
        let finishFirstDisposal
        const firstDisposal = new Promise(resolve => { finishFirstDisposal = resolve })
        const disposed = []
        const window = createFlowTemporalRuntimeWindow({
            datasetIdentity: DATASET_IDENTITY,
            timeAxis: axis,
            maxOwnedRuntimes: 4,
            maxCreationSettleMs: 1000,
            async createReadyRuntime(sample) {
                return { id: `runtime-${sample.sampleKey}-${++sequence}`, sampleKey: sample.sampleKey }
            },
            async stopRuntimeRequests() {},
            async disposeRuntime(runtime) {
                disposed.push(runtime.id)
                if (runtime.id === 'runtime-t00-1') await firstDisposal
            },
        })
        await window.request(exact(axis.samples[0]), 1).settled
        await window.request(gap(axis, 0, 1, 10), 1).settled
        await window.request(exact(axis.samples[0]), -1).settled

        expect(window.snapshot()).to.deep.include({
            state: 'ready',
            activeSampleKeys: [ 't00' ],
            ownedRuntimeCount: 2,
        })
        finishFirstDisposal()
        await waitFor(() => window.snapshot().ownedRuntimeCount === 1)
        const capture = window.capture()
        expect(capture.lower.runtime.id).to.equal('runtime-t00-2')
        capture.release()

        await window.dispose()
        expect(disposed).to.have.members([ 'runtime-t00-1', 'runtime-t00-2' ])
    })

    it('aborts construction during dispose and waits for late owned runtime cleanup', async() => {

        const axis = timeAxis([ 0 ], [ 0 ])
        const factory = controlledFactory()
        const harness = windowHarness(axis, factory.create)
        const ticket = harness.window.request(exact(axis.samples[0]), 0)
        await settleMicrotasks()
        const disposing = harness.window.dispose()

        expect(await ticket.settled).to.deep.include({ status: 'disposed' })
        expect(factory.calls[0].signal.aborted).to.equal(true)
        factory.resolve('t00')
        await disposing
        expect(harness.disposed).to.deep.equal([ 'runtime-t00-1' ])
        expect(harness.window.snapshot()).to.deep.include({ state: 'disposed', disposed: true })
    })

    it('stops a pending factory, aborts it, and settles its ticket as disposed', async() => {

        const axis = timeAxis([ 0 ], [ 0 ])
        let factorySignal
        const window = createFlowTemporalRuntimeWindow({
            datasetIdentity: DATASET_IDENTITY,
            timeAxis: axis,
            maxOwnedRuntimes: 4,
            maxCreationSettleMs: 1000,
            createReadyRuntime(_sample, context) {
                factorySignal = context.signal
                return new Promise((_resolve, reject) => {
                    const abort = () => reject(context.signal.reason)
                    if (context.signal.aborted) abort()
                    else context.signal.addEventListener('abort', abort, { once: true })
                })
            },
            async stopRuntimeRequests() {},
            async disposeRuntime() {},
        })
        const ticket = window.request(exact(axis.samples[0]), 0)
        await waitFor(() => factorySignal !== undefined)

        const stopping = window.stopRequests()

        expect(await ticket.settled).to.deep.equal({
            status: 'disposed',
            revision: ticket.revision,
        })
        expect(factorySignal.aborted).to.equal(true)
        await stopping
        await window.dispose()
        expect(await window.termination).to.deep.equal({ status: 'stopped' })
        expect(window.snapshot()).to.deep.include({
            state: 'disposed',
            requestsStopped: true,
            disposed: true,
        })
    })

    it('wakes a capacity waiter when runtime requests stop', async() => {

        const axis = timeAxis([ 0, 1, 2, 3, 4 ], [ 0, 10, 20, 30, 40 ])
        const harness = immediateHarness(axis)
        await harness.window.request(interpolated(axis, 0, 1, 5), 1).settled
        const held = harness.window.capture()
        await harness.window.request(interpolated(axis, 1, 2, 15), 1).settled
        const waiting = harness.window.request(interpolated(axis, 3, 4, 35), 1)
        await waitFor(() => harness.window.snapshot().candidateSampleKeys.length === 2)

        await harness.window.stopRequests()

        expect(await waiting.settled).to.deep.equal({
            status: 'disposed',
            revision: waiting.revision,
        })
        await waitFor(() => harness.window.snapshot().candidateSampleKeys.length === 0)
        expect(harness.created).to.deep.equal([ 't00', 't01', 't02' ])
        expect(harness.window.snapshot()).to.deep.include({
            requestsStopped: true,
            pendingCreationCount: 0,
        })
        expect(() => harness.window.request(exact(axis.samples[0]), -1))
            .to.throw(/requests are stopped/)

        held.release()
        await harness.window.dispose()
        expect(new Set(harness.disposed).size).to.equal(3)
    })

    it('publishes a persistent fatal termination for asynchronous retirement failure', async() => {

        const axis = timeAxis([ 0, 1 ], [ 0, 10 ])
        const cleanupFailure = new Error('retirement cleanup failed')
        let finishRetirement
        let retirementStarted = false
        const retirementGate = new Promise(resolve => { finishRetirement = resolve })
        let sequence = 0
        const window = createFlowTemporalRuntimeWindow({
            datasetIdentity: DATASET_IDENTITY,
            timeAxis: axis,
            maxOwnedRuntimes: 4,
            maxCreationSettleMs: 1000,
            async createReadyRuntime(sample) {
                return { id: `runtime-${sample.sampleKey}-${++sequence}`, sampleKey: sample.sampleKey }
            },
            async stopRuntimeRequests() {},
            async disposeRuntime(runtime) {
                if (runtime.id !== 'runtime-t00-1') return
                retirementStarted = true
                await retirementGate
                throw cleanupFailure
            },
        })
        await window.request(exact(axis.samples[0]), 1).settled
        expect(await window.request(exact(axis.samples[1]), 1).settled)
            .to.deep.include({ status: 'ready', pairGeneration: 2 })
        await waitFor(() => retirementStarted)
        let terminationSettled = false
        void window.termination.then(() => { terminationSettled = true })
        await settleMicrotasks()
        expect(terminationSettled).to.equal(false)

        finishRetirement()
        const termination = await window.termination

        expect(termination).to.deep.include({
            status: 'fatal',
            failureCode: 'runtime-cleanup-failed',
        })
        expect(termination.error).to.be.instanceOf(AggregateError)
        expect(termination.error.errors).to.deep.equal([ cleanupFailure ])
        expect(window.snapshot()).to.deep.include({
            state: 'failed',
            failureCode: 'runtime-cleanup-failed',
            ownedRuntimeCount: 2,
        })
        expect(() => window.request(exact(axis.samples[0]), -1))
            .to.throw(/runtime-cleanup-failed/)
        expect(await window.termination).to.equal(termination)

        let disposalFailure
        try {
            await window.dispose()
        } catch (error) {
            disposalFailure = error
        }
        expect(disposalFailure).to.be.instanceOf(AggregateError)
    })

    it('stops then disposes a factory runtime that arrives after stop exactly once', async() => {

        const axis = timeAxis([ 0 ], [ 0 ])
        const events = []
        let factoryCall
        const runtime = { id: 'late-runtime-t00', sampleKey: 't00' }
        const window = createFlowTemporalRuntimeWindow({
            datasetIdentity: DATASET_IDENTITY,
            timeAxis: axis,
            maxOwnedRuntimes: 4,
            maxCreationSettleMs: 1000,
            createReadyRuntime(_sample, context) {
                return new Promise(resolve => {
                    factoryCall = { resolve, signal: context.signal }
                })
            },
            async stopRuntimeRequests(value) { events.push(`stop:${value.id}`) },
            async disposeRuntime(value) { events.push(`dispose:${value.id}`) },
        })
        const ticket = window.request(exact(axis.samples[0]), 0)
        await waitFor(() => factoryCall !== undefined)

        await window.stopRequests()
        expect(await ticket.settled).to.deep.equal({
            status: 'disposed',
            revision: ticket.revision,
        })
        expect(factoryCall.signal.aborted).to.equal(true)
        factoryCall.resolve(runtime)
        await waitFor(() => events.length === 2)

        expect(events).to.deep.equal([
            'stop:late-runtime-t00',
            'dispose:late-runtime-t00',
        ])
        await window.dispose()
        expect(events).to.deep.equal([
            'stop:late-runtime-t00',
            'dispose:late-runtime-t00',
        ])
        expect(window.snapshot().ownedRuntimeCount).to.equal(0)
    })

    it('memoizes stopRequests and still disposes after an aggregated stop failure', async() => {

        const axis = timeAxis([ 0 ], [ 0 ])
        const stopFailure = new Error('runtime stop failed')
        let stopCount = 0
        let disposeCount = 0
        const window = createFlowTemporalRuntimeWindow({
            datasetIdentity: DATASET_IDENTITY,
            timeAxis: axis,
            maxOwnedRuntimes: 4,
            maxCreationSettleMs: 1000,
            async createReadyRuntime(sample) {
                return { id: `runtime-${sample.sampleKey}`, sampleKey: sample.sampleKey }
            },
            async stopRuntimeRequests() {
                stopCount++
                throw stopFailure
            },
            async disposeRuntime() { disposeCount++ },
        })
        await window.request(exact(axis.samples[0]), 0).settled

        const firstStop = window.stopRequests()
        const secondStop = window.stopRequests()
        expect(secondStop).to.equal(firstStop)
        let stoppingFailure
        try {
            await firstStop
        } catch (error) {
            stoppingFailure = error
        }

        expect(stoppingFailure).to.be.instanceOf(AggregateError)
        expect(stoppingFailure.errors).to.deep.equal([ stopFailure ])
        expect(stopCount).to.equal(1)
        expect(disposeCount).to.equal(0)
        expect(await window.termination).to.deep.include({
            status: 'fatal',
            failureCode: 'runtime-cleanup-failed',
        })

        let disposalFailure
        try {
            await window.dispose()
        } catch (error) {
            disposalFailure = error
        }
        expect(disposalFailure).to.be.instanceOf(AggregateError)
        expect(stopCount).to.equal(1)
        expect(disposeCount).to.equal(1)
        expect(window.snapshot()).to.deep.include({
            state: 'disposed',
            requestsStopped: true,
            disposed: true,
        })
    })

    it('reports an ignored-abort factory timeout during disposal as fatal', async() => {

        const axis = timeAxis([ 0 ], [ 0 ])
        const factory = controlledFactory()
        const stopped = []
        const disposed = []
        const window = createFlowTemporalRuntimeWindow({
            datasetIdentity: DATASET_IDENTITY,
            timeAxis: axis,
            maxOwnedRuntimes: 4,
            maxCreationSettleMs: 15,
            createReadyRuntime: factory.create,
            async stopRuntimeRequests(runtime) { stopped.push(runtime.id) },
            async disposeRuntime(runtime) { disposed.push(runtime.id) },
        })
        const ticket = window.request(exact(axis.samples[0]), 0)
        await waitFor(() => factory.calls.length === 1)
        const disposing = window.dispose()

        expect(await ticket.settled).to.deep.equal({
            status: 'disposed',
            revision: ticket.revision,
        })
        await new Promise(resolve => setTimeout(resolve, 25))
        factory.resolve('t00')

        let disposalFailure
        try {
            await disposing
        } catch (error) {
            disposalFailure = error
        }
        expect(disposalFailure).to.be.instanceOf(AggregateError)
        expect(await window.termination).to.deep.include({
            status: 'fatal',
            failureCode: 'factory-unresponsive',
        })
        expect(stopped).to.deep.equal([ 'runtime-t00-1' ])
        expect(disposed).to.deep.equal([ 'runtime-t00-1' ])
    })

    it('preserves primary factory and partial-runtime cleanup failures together', async() => {

        const axis = timeAxis([ 0, 1 ], [ 0, 10 ])
        const primaryFailure = new Error('primary factory failure')
        const cleanupFailure = new Error('partial runtime cleanup failure')
        const partial = { id: 'runtime-t00-partial', sampleKey: 't00' }
        const window = createFlowTemporalRuntimeWindow({
            datasetIdentity: DATASET_IDENTITY,
            timeAxis: axis,
            maxOwnedRuntimes: 4,
            maxCreationSettleMs: 1000,
            async createReadyRuntime(sample) {
                if (sample.sampleKey === 't00') return partial
                await Promise.resolve()
                throw primaryFailure
            },
            async stopRuntimeRequests() {},
            async disposeRuntime(runtime) {
                if (runtime === partial) throw cleanupFailure
            },
        })

        const result = await window.request(interpolated(axis, 0, 1, 5), 1).settled

        expect(result.status).to.equal('failed')
        expect(result.error).to.be.instanceOf(AggregateError)
        expect(result.error.errors).to.deep.equal([ primaryFailure, cleanupFailure ])
        const termination = await window.termination
        expect(termination).to.deep.include({
            status: 'fatal',
            failureCode: 'runtime-cleanup-failed',
        })
        expect(termination.error).to.equal(result.error)

        let disposalFailure
        try {
            await window.dispose()
        } catch (error) {
            disposalFailure = error
        }
        expect(disposalFailure).to.be.instanceOf(AggregateError)
    })

    it('validates the complete normalized time-axis and fixed selection shape', async() => {

        const valid = timeAxis([ 0, 1 ], [ 0, 10 ])
        const malformed = [
            cloneAxis(valid, value => { value.samples[0].sampleKey = 'sample-zero' }),
            cloneAxis(valid, value => { value.samples[1].timeIndex = 0 }),
            cloneAxis(valid, value => { value.sourceSampleCount = 1 }),
            cloneAxis(valid, value => {
                value.adjacency[0] = {
                    lowerSampleKey: 't00',
                    upperSampleKey: 't01',
                    kind: 'gap',
                    interpolation: 'none',
                    reason: 'omitted-source-samples',
                }
            }),
            timeAxis([ 0, 1 ], [ -Number.MAX_VALUE, Number.MAX_VALUE ]),
            timeAxis([ 0, 1, 2 ], [ -1e308, 0, 1e308 ]),
        ]
        for (const axis of malformed) {
            expect(() => immediateHarness(axis)).to.throw(TypeError)
        }

        const harness = immediateHarness(valid)
        const selected = { ...exact(valid.samples[0]), unexpected: true }
        const ticket = harness.window.request(selected, 0)
        expect(Object.keys(ticket.selection)).to.deep.equal([ 'kind', 'modelTime', 'sample' ])
        expect(() => harness.window.request({
            kind: 'exact',
            modelTime: 0,
            sample: { ...valid.samples[0], timeIndex: 99 },
        }, 0)).to.throw(TypeError)
        await ticket.settled
        await harness.window.dispose()
    })
})

function windowHarness(axis, createReadyRuntime, maxCreationSettleMs = 1000) {

    const disposed = []
    const window = createFlowTemporalRuntimeWindow({
        datasetIdentity: DATASET_IDENTITY,
        timeAxis: axis,
        maxOwnedRuntimes: 4,
        maxCreationSettleMs,
        createReadyRuntime,
        async stopRuntimeRequests() {},
        async disposeRuntime(runtime) { disposed.push(runtime.id) },
    })
    return { axis, window, disposed }
}

function immediateHarness(axis) {

    const created = []
    let sequence = 0
    const harness = windowHarness(axis, async sample => {
        created.push(sample.sampleKey)
        return { id: `runtime-${sample.sampleKey}-${++sequence}`, sampleKey: sample.sampleKey }
    })
    return { ...harness, created }
}

function controlledFactory() {

    const calls = []
    let sequence = 0
    function create(sample, context) {

        let resolve
        let reject
        const promise = new Promise((resolvePromise, rejectPromise) => {
            resolve = resolvePromise
            reject = rejectPromise
        })
        calls.push({
            sampleKey: sample.sampleKey,
            signal: context.signal,
            attemptId: context.attemptId,
            runtime: { id: `runtime-${sample.sampleKey}-${++sequence}`, sampleKey: sample.sampleKey },
            resolve,
            reject,
            promise,
        })
        return promise
    }
    function unresolved(sampleKey) {

        const call = calls.find(candidate =>
            candidate.sampleKey === sampleKey && candidate.resolve !== undefined
        )
        if (call === undefined) throw new Error(`No unresolved factory call for ${sampleKey}`)
        return call
    }
    return {
        calls,
        create,
        resolve(sampleKey) {

            const call = unresolved(sampleKey)
            const resolve = call.resolve
            call.resolve = undefined
            call.reject = undefined
            resolve(call.runtime)
        },
        resolveAll() {

            for (const call of calls.filter(candidate => candidate.resolve !== undefined)) {
                const resolve = call.resolve
                call.resolve = undefined
                call.reject = undefined
                resolve(call.runtime)
            }
        },
    }
}

function exact(sample) {

    return Object.freeze({ kind: 'exact', modelTime: sample.modelTime, sample })
}

function interpolated(axis, lowerIndex, upperIndex, modelTime) {

    const lower = axis.samples[lowerIndex]
    const upper = axis.samples[upperIndex]
    return Object.freeze({
        kind: 'interpolated',
        modelTime,
        lower,
        upper,
        alpha: (modelTime - lower.modelTime) / (upper.modelTime - lower.modelTime),
    })
}

function gap(axis, lowerIndex, upperIndex, modelTime) {

    return Object.freeze({
        kind: 'gap',
        modelTime,
        lower: axis.samples[lowerIndex],
        upper: axis.samples[upperIndex],
        reason: 'omitted-source-samples',
    })
}

function timeAxis(indices, modelTimes) {

    const samples = indices.map((timeIndex, index) => Object.freeze({
        sampleKey: `t${String(timeIndex).padStart(2, '0')}`,
        timeIndex,
        modelTime: modelTimes[index],
        unit: 'hour',
        phase: 'test',
        sourceHash: HASH,
    }))
    return Object.freeze({
        unit: 'hour',
        phase: 'test',
        sourceSampleCount: Math.max(indices.length, indices.at(-1) + 1),
        samples: Object.freeze(samples),
        adjacency: Object.freeze(samples.slice(1).map((upper, index) => {
            const lower = samples[index]
            return Object.freeze(upper.timeIndex === lower.timeIndex + 1
                ? {
                    lowerSampleKey: lower.sampleKey,
                    upperSampleKey: upper.sampleKey,
                    kind: 'interpolable',
                    interpolation: 'component-wise-linear',
                }
                : {
                    lowerSampleKey: lower.sampleKey,
                    upperSampleKey: upper.sampleKey,
                    kind: 'gap',
                    interpolation: 'none',
                    reason: 'omitted-source-samples',
                })
        })),
    })
}

async function settleMicrotasks(count = 3) {

    for (let index = 0; index < count; index++) await Promise.resolve()
}

async function waitFor(predicate) {

    const deadline = Date.now() + 1000
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error('Timed out waiting for test condition')
        await new Promise(resolve => setTimeout(resolve, 0))
    }
}

function cloneAxis(axis, mutate) {

    const value = structuredClone(axis)
    mutate(value)
    return value
}
