import { expect } from 'chai'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const moduleUrl = pathToFileURL(path.join(
    process.cwd(),
    'examples',
    'flowField',
    'temporal-velocity-raster.ts'
)).href

describe('Flow Field temporal velocity raster', () => {

    it('owns exactly current, next, and prefetch runtimes', async() => {

        const { createTemporalVelocityRaster } = await import(moduleUrl)
        const live = new Set()
        const created = []
        const disposed = []
        const temporal = await createTemporalVelocityRaster({
            fieldCount: 27,
            framesPerTime: 3,
            async createRuntime(timeIndex) {
                const runtime = Object.freeze({ timeIndex })
                created.push(timeIndex)
                live.add(runtime)
                return runtime
            },
            async disposeRuntime(runtime) {
                expect(live.delete(runtime)).to.equal(true)
                disposed.push(runtime.timeIndex)
            },
        })

        expect(created).to.deep.equal([ 0, 1, 2 ])
        expect(live.size).to.equal(3)
        expect(temporal.snapshot()).to.deep.include({
            generation: 1,
            currentTimeIndex: 0,
            nextTimeIndex: 1,
            prefetchTimeIndex: 2,
            frameInTime: 0,
            progress: 0,
        })

        await temporal.advanceFrame()
        expect(temporal.snapshot()).to.deep.include({ frameInTime: 1, progress: 0.5 })
        await temporal.advanceFrame()
        expect(temporal.snapshot()).to.deep.include({ frameInTime: 2, progress: 1 })
        await temporal.advanceFrame()

        expect(temporal.snapshot()).to.deep.include({
            generation: 2,
            currentTimeIndex: 1,
            nextTimeIndex: 2,
            prefetchTimeIndex: 3,
            frameInTime: 0,
            progress: 0,
        })
        expect(created).to.deep.equal([ 0, 1, 2, 3 ])
        expect(disposed).to.deep.equal([ 0 ])
        expect(live.size).to.equal(3)

        await temporal.dispose()
        expect(disposed).to.deep.equal([ 0, 1, 2, 3 ])
        expect(live.size).to.equal(0)
        await temporal.dispose()
        expect(disposed).to.deep.equal([ 0, 1, 2, 3 ])
    })

    it('wraps the three-slot window and publishes immutable epochs', async() => {

        const { createTemporalVelocityRaster } = await import(`${moduleUrl}?wrap=1`)
        const temporal = await createTemporalVelocityRaster({
            fieldCount: 27,
            framesPerTime: 1,
            initialTimeIndex: 26,
            createRuntime: async timeIndex => Object.freeze({ timeIndex }),
            disposeRuntime: async() => {},
        })

        expect(temporal.snapshot()).to.deep.include({
            currentTimeIndex: 26,
            nextTimeIndex: 0,
            prefetchTimeIndex: 1,
        })
        expect(Object.isFrozen(temporal.snapshot())).to.equal(true)

        temporal.recordPublication(26, 4)
        temporal.recordPublication(0, 7)
        expect(temporal.snapshot()).to.deep.include({
            temporalResidencyEpoch: 2,
            currentSnapshotEpoch: 4,
            nextSnapshotEpoch: 7,
        })
        expect(() => temporal.recordPublication(1, 2))
            .to.throw('Prefetch publication cannot enter the active temporal pair')
        expect(() => temporal.recordPublication(26, 3))
            .to.throw('Velocity snapshot epochs must increase monotonically')

        await temporal.advanceFrame()
        expect(temporal.snapshot()).to.deep.include({
            generation: 2,
            currentTimeIndex: 0,
            nextTimeIndex: 1,
            prefetchTimeIndex: 2,
            currentSnapshotEpoch: 7,
            nextSnapshotEpoch: 0,
        })
        await temporal.dispose()
    })

    it('does not commit a rotation when prefetch creation fails', async() => {

        const { createTemporalVelocityRaster } = await import(`${moduleUrl}?failure=1`)
        const temporal = await createTemporalVelocityRaster({
            fieldCount: 4,
            framesPerTime: 1,
            async createRuntime(timeIndex) {
                if (timeIndex === 3) throw new Error('prefetch failed')
                return Object.freeze({ timeIndex })
            },
            disposeRuntime: async() => {},
        })

        let failure
        try {
            await temporal.advanceFrame()
        } catch (error) {
            failure = error
        }
        expect(failure?.message).to.equal('prefetch failed')
        expect(temporal.snapshot()).to.deep.include({
            generation: 1,
            currentTimeIndex: 0,
            nextTimeIndex: 1,
            prefetchTimeIndex: 2,
        })
        await temporal.dispose()
    })

    it('aborts an in-flight replacement before disposing the three owned slots', async() => {

        const { createTemporalVelocityRaster } = await import(`${moduleUrl}?dispose=1`)
        const disposed = []
        let replacementStarted
        const started = new Promise(resolve => { replacementStarted = resolve })
        const temporal = await createTemporalVelocityRaster({
            fieldCount: 4,
            framesPerTime: 1,
            createRuntime(timeIndex, signal) {
                if (timeIndex !== 3) return Promise.resolve(Object.freeze({ timeIndex }))
                replacementStarted()
                return new Promise((resolve, reject) => {
                    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
                })
            },
            async disposeRuntime(runtime) { disposed.push(runtime.timeIndex) },
        })

        const advancing = temporal.advanceFrame()
        await started
        const disposal = temporal.dispose()
        let advanceFailure
        try {
            await advancing
        } catch (error) {
            advanceFailure = error
        }
        await disposal

        expect(advanceFailure?.message).to.equal('Temporal velocity disposal requested')
        expect(disposed).to.deep.equal([ 0, 1, 2 ])
        expect(() => temporal.snapshot()).to.throw('Temporal velocity raster is disposed')
    })
})
