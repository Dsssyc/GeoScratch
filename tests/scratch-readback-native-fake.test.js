import { expect } from 'chai'
import { createFakeGpu } from './scratch-test-utils.js'

describe('fake WebGPU readback outcomes', () => {

    it('settles map requests independently while preserving native issue order', async () => {

        const fake = createFakeGpu({ deferMaps: true })
        const first = fake.device.createBuffer({ size: 8, usage: 0x9 })
        const second = fake.device.createBuffer({ size: 8, usage: 0x9 })

        const firstMap = first.mapAsync(0x1, 0, 8)
        const secondMap = second.mapAsync(0x1, 0, 8)

        expect(fake.readbacks.mapRequests).to.have.length(2)
        expect(fake.calls.nativeTimeline.slice(-2)).to.deep.equal([
            { type: 'map-async', bufferId: first.id, offset: 0, size: 8 },
            { type: 'map-async', bufferId: second.id, offset: 0, size: 8 },
        ])

        fake.readbacks.resolveMap(1)
        await secondMap
        expect(second.mapped).to.equal(true)
        expect(first.mapped).to.equal(false)

        const failure = new DOMException('first map failed', 'OperationError')
        fake.readbacks.rejectMap(0, failure)
        try {
            await firstMap
            throw new Error('expected map rejection')
        } catch (error) {
            expect(error).to.equal(failure)
        }
    })

    it('applies queued map outcomes without requiring deferred settlement', async () => {

        const fake = createFakeGpu()
        const buffer = fake.device.createBuffer({ size: 8, usage: 0x9 })
        const failure = new DOMException('queued map failed', 'OperationError')
        fake.readbacks.rejectNextMap(failure)

        try {
            await buffer.mapAsync(0x1, 0, 8)
            throw new Error('expected queued map rejection')
        } catch (error) {
            expect(error).to.equal(failure)
        }

        expect(buffer.mapped).to.equal(false)
        expect(fake.calls.maps).to.have.length(1)
    })

    it('cancels one pending map through unmap without affecting another buffer', async () => {

        const fake = createFakeGpu({ deferMaps: true })
        const first = fake.device.createBuffer({ size: 8, usage: 0x9 })
        const second = fake.device.createBuffer({ size: 8, usage: 0x9 })
        const firstMap = first.mapAsync(0x1, 0, 8)
        const secondMap = second.mapAsync(0x1, 0, 8)

        first.unmap()
        fake.readbacks.resolveMap(1)

        try {
            await firstMap
            throw new Error('expected cancelled map rejection')
        } catch (error) {
            expect(error.name).to.equal('OperationError')
        }
        await secondMap
        expect(first.mapState).to.equal('unmapped')
        expect(second.mapState).to.equal('mapped')
    })

    it('injects mapped-range, unmap, and destroy exceptions independently', async () => {

        const fake = createFakeGpu()
        const buffer = fake.device.createBuffer({ size: 8, usage: 0x9 })
        await buffer.mapAsync(0x1, 0, 8)

        const rangeFailure = new DOMException('range failed', 'OperationError')
        fake.errors.throwNext('getMappedRange', rangeFailure)
        expect(() => buffer.getMappedRange(0, 8)).to.throw(rangeFailure)

        const unmapFailure = new Error('unmap failed')
        fake.errors.throwNext('unmap', unmapFailure)
        expect(() => buffer.unmap()).to.throw(unmapFailure)

        const destroyFailure = new Error('destroy failed')
        fake.errors.throwNext('destroyBuffer', destroyFailure)
        expect(() => buffer.destroy()).to.throw(destroyFailure)
    })

    it('settles queue completion requests independently', async () => {

        const fake = createFakeGpu({ deferSubmittedWorkDone: true })
        const first = fake.queue.onSubmittedWorkDone()
        const second = fake.queue.onSubmittedWorkDone()

        expect(fake.readbacks.queueCompletionRequests).to.have.length(2)
        fake.readbacks.resolveQueueCompletion(0, 'first done')
        expect(await first).to.equal('first done')

        const failure = new Error('queue completion failed')
        fake.readbacks.rejectQueueCompletion(1, failure)
        try {
            await second
            throw new Error('expected queue completion rejection')
        } catch (error) {
            expect(error).to.equal(failure)
        }
    })
})
