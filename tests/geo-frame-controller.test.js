import { expect } from 'chai'
import { createGeoFrameController } from 'geoscratch/geo'

describe('Geo frame controller', () => {

    it('invokes frame construction synchronously when the scheduler admits work', async() => {

        const scheduler = fakeFrameScheduler()
        const events = []
        const controller = createGeoFrameController({
            scheduler,
            render() {
                events.push('render')
                return Promise.resolve({
                    observation: Promise.resolve(),
                    needsFollowUp: false,
                    value: undefined,
                })
            },
        })

        controller.invalidate()
        const completion = scheduler.runNext()
        events.push('scheduler-returned')

        expect(events).to.deep.equal([ 'render', 'scheduler-returned' ])
        await completion
    })

    it('owns one configured frame driver lifecycle', async() => {

        const scheduler = fakeFrameScheduler()
        const lifecycle = []
        let invalidate
        const driver = {
            kind: 'geo-frame-driver',
            id: 'test-driver',
            scheduler,
            capture: () => ({
                revision: 0,
                snapshot: Object.freeze({ zoom: 8 }),
            }),
            start(callback) {
                lifecycle.push('start')
                invalidate = callback
            },
            stop() {
                lifecycle.push('stop')
                return true
            },
        }
        const submitted = []
        const controller = createGeoFrameController({
            driver,
            render(_frameNumber, capture) {
                submitted.push(capture.zoom)
                return Promise.resolve({
                    observation: Promise.resolve(),
                    needsFollowUp: false,
                    value: capture.zoom,
                })
            },
        })

        expect(lifecycle).to.deep.equal([ 'start' ])
        expect(invalidate()).to.equal(true)
        await scheduler.runNext()
        expect(submitted).to.deep.equal([ 8 ])
        expect(controller.stop()).to.equal(true)
        expect(controller.stop()).to.equal(false)
        expect(lifecycle).to.deep.equal([ 'start', 'stop' ])
    })

    it('rejects competing driver and descriptor-level frame authorities', () => {

        const scheduler = fakeFrameScheduler()
        const driver = {
            kind: 'geo-frame-driver',
            id: 'test-driver',
            scheduler,
            capture: () => ({ revision: 0, snapshot: undefined }),
            start() {},
            stop: () => true,
        }
        for (const competingAuthority of [
            { capture: driver.capture },
            { scheduler },
        ]) {
            expect(() => createGeoFrameController({
                driver,
                ...competingAuthority,
                render: async() => ({
                    observation: Promise.resolve(),
                    needsFollowUp: false,
                    value: undefined,
                }),
            })).to.throw().with.nested.property(
                'diagnostic.code',
                'GEO_FRAME_CONTROLLER_INVALID'
            )
        }
    })

    it('bounds native frames in flight and coalesces invalidation onto the newest state', async() => {

        const scheduler = fakeFrameScheduler()
        const observations = Array.from({ length: 4 }, deferred)
        let renderCount = 0
        const controller = createGeoFrameController({
            scheduler,
            maximumInFlightFrames: 2,
            async render(frameNumber) {
                renderCount++
                return {
                    observation: observations[frameNumber - 1].promise,
                    needsFollowUp: false,
                    value: frameNumber,
                }
            },
        })

        controller.invalidate()
        await scheduler.runNext()
        controller.invalidate()
        await scheduler.runNext()
        expect(controller.snapshot()).to.deep.include({
            maximumInFlightFrames: 2,
            inFlightFrameCount: 2,
            submittedFrameCount: 2,
            observedFrameCount: 0,
        })

        controller.invalidate()
        controller.invalidate()
        expect(scheduler.pendingCount).to.equal(0)
        expect(renderCount).to.equal(2)

        observations[0].resolve()
        await flushTasks()
        expect(scheduler.pendingCount).to.equal(1)
        await scheduler.runNext()
        expect(renderCount).to.equal(3)

        observations[1].resolve()
        observations[2].resolve()
        observations[3].resolve()
        await flushTasks()
        expect(controller.snapshot()).to.deep.include({
            inFlightFrameCount: 0,
            submittedFrameCount: 3,
            observedFrameCount: 3,
        })
    })

    it('single-flights a camera overlay and skips intermediate invalidated states', async() => {

        const scheduler = fakeFrameScheduler()
        const firstObservation = deferred()
        const submittedStates = []
        let cameraState = 0
        const controller = createGeoFrameController({
            scheduler,
            maximumInFlightFrames: 1,
            async render() {
                submittedStates.push(cameraState)
                return {
                    observation: submittedStates.length === 1
                        ? firstObservation.promise
                        : Promise.resolve(),
                    needsFollowUp: false,
                    value: cameraState,
                }
            },
        })

        controller.invalidate()
        await scheduler.runNext()
        cameraState = 1
        controller.invalidate()
        cameraState = 2
        controller.invalidate()

        expect(submittedStates).to.deep.equal([ 0 ])
        expect(scheduler.pendingCount).to.equal(0)
        firstObservation.resolve()
        await flushTasks()
        await scheduler.runNext()
        await flushTasks()

        expect(submittedStates).to.deep.equal([ 0, 2 ])
        expect(controller.snapshot()).to.deep.include({
            maximumInFlightFrames: 1,
            inFlightFrameCount: 0,
            submittedFrameCount: 2,
            observedFrameCount: 2,
        })
    })

    it('captures host state synchronously before asynchronous frame construction', async() => {

        const scheduler = fakeFrameScheduler()
        const submittedStates = []
        const errors = []
        let hostState = 4
        const controller = createGeoFrameController({
            scheduler,
            capture() {
                return {
                    revision: hostState,
                    snapshot: Object.freeze({ hostState }),
                }
            },
            async render(_frameNumber, capture) {
                submittedStates.push(capture.hostState)
                return {
                    observation: Promise.resolve(),
                    needsFollowUp: false,
                    value: capture.hostState,
                }
            },
            onError: error => errors.push(error),
        })

        expect(controller.invalidateNow()).to.equal(true)
        hostState = 5
        await flushTasks()

        expect(errors).to.deep.equal([])
        expect(submittedStates).to.deep.equal([ 4 ])
    })

    it('deduplicates host invalidations that retain the same captured revision', async() => {

        const scheduler = fakeFrameScheduler()
        const submittedStates = []
        const errors = []
        let hostState = 7
        const controller = createGeoFrameController({
            scheduler,
            capture() {
                return {
                    revision: hostState,
                    snapshot: Object.freeze({ hostState }),
                }
            },
            async render(_frameNumber, capture) {
                submittedStates.push(capture.hostState)
                return {
                    observation: Promise.resolve(),
                    needsFollowUp: false,
                    value: capture.hostState,
                }
            },
            onError: error => errors.push(error),
        })

        expect(controller.invalidateNow()).to.equal(true)
        await flushTasks()
        expect(controller.invalidateNow()).to.equal(false)
        await flushTasks()

        expect(errors).to.deep.equal([])
        expect(submittedStates).to.deep.equal([ 7 ])
        expect(scheduler.pendingCount).to.equal(0)
        expect(controller.snapshot()).to.deep.include({
            invalidationCount: 2,
            deduplicatedInvalidationCount: 1,
            latestCaptureRevision: 7,
            submittedCaptureRevision: 7,
            submittedFrameCount: 1,
        })
    })

    it('keeps internal invalidation forceful when the host capture revision is unchanged', async() => {

        const scheduler = fakeFrameScheduler()
        const submittedStates = []
        const controller = createGeoFrameController({
            scheduler,
            capture: () => ({
                revision: 3,
                snapshot: Object.freeze({ hostState: 3 }),
            }),
            async render(_frameNumber, capture) {
                submittedStates.push(capture.hostState)
                return {
                    observation: Promise.resolve(),
                    needsFollowUp: false,
                    value: capture.hostState,
                }
            },
        })

        controller.invalidateNow()
        await flushTasks()
        controller.invalidate()
        await scheduler.runNext()
        await flushTasks()

        expect(submittedStates).to.deep.equal([ 3, 3 ])
        expect(controller.snapshot()).to.deep.include({
            deduplicatedInvalidationCount: 0,
            submittedFrameCount: 2,
        })
    })

    it('stops with a structured diagnostic when capture revisions move backwards', async() => {

        const scheduler = fakeFrameScheduler()
        const errors = []
        let revision = 2
        const controller = createGeoFrameController({
            scheduler,
            capture: () => ({ revision, snapshot: revision }),
            async render(_frameNumber, capture) {
                return {
                    observation: Promise.resolve(),
                    needsFollowUp: false,
                    value: capture,
                }
            },
            onError: error => errors.push(error),
        })

        controller.invalidateNow()
        await flushTasks()
        revision = 1
        expect(controller.invalidateNow()).to.equal(false)

        expect(errors).to.have.length(1)
        expect(errors[0].diagnostic.code).to.equal('GEO_FRAME_CAPTURE_STALE')
        expect(controller.snapshot().state).to.equal('stopped')
    })

    it('delivers only the latest captured host state after native capacity is released', async() => {

        const scheduler = fakeFrameScheduler()
        const firstObservation = deferred()
        const submittedStates = []
        const errors = []
        let hostState = 0
        const controller = createGeoFrameController({
            scheduler,
            maximumInFlightFrames: 1,
            capture() {
                return {
                    revision: hostState,
                    snapshot: Object.freeze({ hostState }),
                }
            },
            async render(frameNumber, capture) {
                submittedStates.push(capture.hostState)
                return {
                    observation: frameNumber === 1
                        ? firstObservation.promise
                        : Promise.resolve(),
                    needsFollowUp: false,
                    value: capture.hostState,
                }
            },
            onError: error => errors.push(error),
        })

        controller.invalidateNow()
        await flushTasks()
        hostState = 1
        controller.invalidateNow()
        hostState = 2
        controller.invalidateNow()

        expect(submittedStates).to.deep.equal([ 0 ])
        firstObservation.resolve()
        await flushTasks()
        await scheduler.runNext()
        await flushTasks()

        expect(errors).to.deep.equal([])
        expect(submittedStates).to.deep.equal([ 0, 2 ])
    })

    it('coalesces invalidation and resumes after residency settlement', async() => {

        const scheduler = fakeFrameScheduler()
        const tracked = []
        const submitted = []
        const observed = []
        const residency = deferred()
        let renderCount = 0
        const controller = createGeoFrameController({
            scheduler,
            track(work, label) {
                tracked.push(label)
                return work
            },
            async render(frameNumber) {
                renderCount++
                return {
                    observation: Promise.resolve(),
                    settlement: Promise.resolve({
                        residencySettlement: residency.promise,
                        residencyWorkCount: frameNumber === 1 ? 1 : 0,
                        needsFollowUp: false,
                    }),
                    needsFollowUp: false,
                    value: `frame-${frameNumber}`,
                }
            },
            onSubmitted: frame => submitted.push(frame),
            onObserved: frame => observed.push(frame),
        })

        controller.invalidate()
        controller.invalidate()
        expect(scheduler.pendingCount).to.equal(1)
        await scheduler.runNext()
        await flushTasks()

        expect(renderCount).to.equal(1)
        expect(submitted.map(frame => frame.value)).to.deep.equal([ 'frame-1' ])
        expect(observed.map(frame => frame.value)).to.deep.equal([ 'frame-1' ])
        expect(scheduler.pendingCount).to.equal(0)

        residency.resolve()
        await flushTasks()
        expect(scheduler.pendingCount).to.equal(1)
        await scheduler.runNext()
        await flushTasks()

        expect(renderCount).to.equal(2)
        expect(tracked).to.deep.equal([
            'geo-frame-1',
            'geo-frame-settlement-1',
            'geo-frame-residency-1',
            'geo-frame-2',
            'geo-frame-settlement-2',
        ])
        expect(controller.snapshot()).to.deep.include({
            state: 'running',
            scheduledFrameCount: 2,
            completedFrameCount: 2,
            cancelledFrameCount: 0,
            submittedFrameCount: 2,
            observedFrameCount: 2,
            pendingTaskCount: 0,
        })
    })

    it('does not let native observation block a newer invalidated submission', async() => {

        const scheduler = fakeFrameScheduler()
        const firstObservation = deferred()
        const submitted = []
        const observed = []
        const controller = createGeoFrameController({
            scheduler,
            async render(frameNumber) {
                return {
                    observation: frameNumber === 1
                        ? firstObservation.promise
                        : Promise.resolve(),
                    needsFollowUp: false,
                    value: `frame-${frameNumber}`,
                }
            },
            onSubmitted: frame => submitted.push(frame.value),
            onObserved: frame => observed.push(frame.value),
        })

        controller.invalidate()
        await scheduler.runNext()
        await flushTasks()
        expect(submitted).to.deep.equal([ 'frame-1' ])
        expect(observed).to.deep.equal([])

        controller.invalidate()
        expect(scheduler.pendingCount).to.equal(1)
        await scheduler.runNext()
        await flushTasks()
        expect(submitted).to.deep.equal([ 'frame-1', 'frame-2' ])
        expect(observed).to.deep.equal([ 'frame-2' ])

        firstObservation.resolve()
        await flushTasks()
        expect(observed).to.deep.equal([ 'frame-2', 'frame-1' ])
        expect(controller.snapshot()).to.deep.include({
            submittedFrameCount: 2,
            observedFrameCount: 2,
            rendering: false,
        })
    })

    it('can align a pending invalidation with the current host render frame', async() => {

        const scheduler = fakeFrameScheduler()
        const submitted = []
        const controller = createGeoFrameController({
            scheduler,
            async render(frameNumber) {
                return {
                    observation: Promise.resolve(),
                    needsFollowUp: false,
                    value: `frame-${frameNumber}`,
                }
            },
            onSubmitted: frame => submitted.push(frame.value),
        })

        controller.invalidate()
        expect(scheduler.pendingCount).to.equal(1)
        expect(controller.invalidateNow()).to.equal(true)
        expect(scheduler.pendingCount).to.equal(0)
        await flushTasks()

        expect(submitted).to.deep.equal([ 'frame-1' ])
        expect(controller.snapshot()).to.deep.include({
            invalidationCount: 2,
            scheduledFrameCount: 2,
            completedFrameCount: 1,
            cancelledFrameCount: 1,
            submittedFrameCount: 1,
            observedFrameCount: 1,
        })
    })

    it('bounds autonomous convergence follow-ups', async() => {

        const scheduler = fakeFrameScheduler()
        let renderCount = 0
        const controller = createGeoFrameController({
            scheduler,
            maximumFollowUpFrames: 2,
            async render() {
                renderCount++
                return {
                    observation: Promise.resolve(),
                    needsFollowUp: true,
                    value: undefined,
                }
            },
        })

        controller.invalidate()
        while (scheduler.pendingCount > 0) {
            await scheduler.runNext()
            await flushTasks()
        }

        expect(renderCount).to.equal(3)
        expect(controller.snapshot()).to.deep.include({
            followUpFrameCount: 2,
            submittedFrameCount: 3,
            observedFrameCount: 3,
        })
    })

    it('cancels scheduled work and rejects later invalidation after stop', () => {

        const scheduler = fakeFrameScheduler()
        const controller = createGeoFrameController({
            scheduler,
            async render() {
                throw new Error('must not render')
            },
        })

        controller.invalidate()
        expect(controller.stop()).to.equal(true)
        expect(controller.stop()).to.equal(false)
        expect(controller.invalidate()).to.equal(false)
        expect(scheduler.pendingCount).to.equal(0)
        expect(controller.snapshot()).to.deep.include({
            state: 'stopped',
            scheduledFrameCount: 1,
            completedFrameCount: 0,
            cancelledFrameCount: 1,
            pendingTaskCount: 0,
        })
    })

    it('captures its descriptor instead of retaining mutable scheduling policy', async() => {

        const scheduler = fakeFrameScheduler()
        const submitted = []
        const descriptor = {
            scheduler,
            maximumInFlightFrames: 2,
            maximumFollowUpFrames: 0,
            async render() {
                return {
                    observation: Promise.resolve(),
                    needsFollowUp: false,
                    value: 'captured',
                }
            },
            onSubmitted: frame => submitted.push(frame.value),
        }
        const controller = createGeoFrameController(descriptor)
        descriptor.render = async() => { throw new Error('mutated render') }
        descriptor.onSubmitted = () => { throw new Error('mutated callback') }
        descriptor.maximumInFlightFrames = 7
        descriptor.maximumFollowUpFrames = 10

        controller.invalidate()
        await scheduler.runNext()
        await flushTasks()

        expect(submitted).to.deep.equal([ 'captured' ])
        expect(controller.snapshot()).to.deep.include({
            state: 'running',
            maximumInFlightFrames: 2,
            submittedFrameCount: 1,
            observedFrameCount: 1,
        })
    })

    it('stops with a structured diagnostic for an invalid render result', async() => {

        const scheduler = fakeFrameScheduler()
        const errors = []
        const controller = createGeoFrameController({
            scheduler,
            async render() {
                return {
                    observation: Promise.resolve(),
                    settlement: Promise.resolve({
                        residencyWorkCount: 1,
                        needsFollowUp: false,
                    }),
                    needsFollowUp: false,
                    value: undefined,
                }
            },
            onError: error => errors.push(error),
        })

        controller.invalidate()
        await scheduler.runNext()
        await flushTasks()

        expect(errors).to.have.length(1)
        expect(errors[0].diagnostic.code).to.equal('GEO_FRAME_SETTLEMENT_INVALID')
        expect(controller.snapshot()).to.deep.include({
            state: 'stopped',
            submittedFrameCount: 1,
            observedFrameCount: 1,
            pendingTaskCount: 0,
        })
    })
})

function fakeFrameScheduler() {

    let nextId = 1
    const callbacks = new Map()
    return {
        request(callback) {
            const id = nextId++
            callbacks.set(id, callback)
            return id
        },
        cancel(id) {
            callbacks.delete(id)
        },
        get pendingCount() {
            return callbacks.size
        },
        async runNext() {
            const entry = callbacks.entries().next().value
            if (entry === undefined) throw new Error('No frame is scheduled')
            callbacks.delete(entry[0])
            entry[1]()
            await flushTasks()
        },
    }
}

function deferred() {

    let resolve
    const promise = new Promise(settle => { resolve = settle })
    return { promise, resolve }
}

async function flushTasks() {

    await new Promise(resolve => setImmediate(resolve))
}
