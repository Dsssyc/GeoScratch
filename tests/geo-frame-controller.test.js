import { expect } from 'chai'
import { createGeoFrameController } from 'geoscratch/geo'

describe('Geo frame controller', () => {

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
                    residencySettlement: residency.promise,
                    residencyWorkCount: frameNumber === 1 ? 1 : 0,
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
            'geo-frame-residency-1',
            'geo-frame-2',
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
                    residencyWorkCount: 0,
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
            maximumFollowUpFrames: 0,
            async render() {
                return {
                    observation: Promise.resolve(),
                    residencyWorkCount: 0,
                    needsFollowUp: false,
                    value: 'captured',
                }
            },
            onSubmitted: frame => submitted.push(frame.value),
        }
        const controller = createGeoFrameController(descriptor)
        descriptor.render = async() => { throw new Error('mutated render') }
        descriptor.onSubmitted = () => { throw new Error('mutated callback') }
        descriptor.maximumFollowUpFrames = 10

        controller.invalidate()
        await scheduler.runNext()
        await flushTasks()

        expect(submitted).to.deep.equal([ 'captured' ])
        expect(controller.snapshot()).to.deep.include({
            state: 'running',
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
                    residencyWorkCount: 1,
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
        expect(errors[0].diagnostic.code).to.equal('GEO_FRAME_RESULT_INVALID')
        expect(controller.snapshot()).to.deep.include({
            state: 'stopped',
            submittedFrameCount: 0,
            observedFrameCount: 0,
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
