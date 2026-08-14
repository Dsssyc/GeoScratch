import { expect } from 'chai'
import { GPURuntime } from 'geoscratch/scratch'
import {
    WebMercatorQuad,
    createVirtualRasterRuntime,
    tileMatrixCoverage,
    webMercatorVirtualRasterField,
} from 'geoscratch/geo'
import { createFakeGpu } from './scratch-test-utils.js'

describe('Geo Virtual Raster runtime lifetime', () => {

    it('never disposes a borrowed executor', async() => {

        const fixture = await createRuntimeFixture('borrowed-executor')
        let executorDisposeCount = 0
        const executor = {
            request() {
                throw new Error('no request is expected during disposal')
            },
            async dispose() {
                executorDisposeCount++
            },
        }
        const runtime = await createRuntime(fixture, {
            ownership: 'borrowed',
            executor,
        })

        await runtime.dispose()
        await runtime.dispose()

        expect(executorDisposeCount).to.equal(0)
        expect(runtime.inspect()).to.include({ executorOwnership: 'borrowed' })
        await fixture.gpuRuntime.dispose()
    })

    it('disposes an owned executor once after scheduler settlement', async() => {

        const fixture = await createRuntimeFixture('owned-executor')
        const events = []
        const executor = {
            request() {
                throw new Error('no request is expected during disposal')
            },
            async dispose() {
                events.push('executor')
            },
        }
        const runtime = await createRuntime(fixture, {
            ownership: 'owned',
            executor,
        })
        runtime.scheduler.dispose = async() => {
            events.push('scheduler:start')
            await Promise.resolve()
            events.push('scheduler:settled')
        }

        await Promise.all([ runtime.dispose(), runtime.dispose() ])

        expect(events).to.deep.equal([ 'scheduler:start', 'scheduler:settled', 'executor' ])
        expect(runtime.inspect()).to.include({ executorOwnership: 'owned' })
        await fixture.gpuRuntime.dispose()
    })

    it('releases only owned executors when runtime creation fails', async() => {

        const fixture = await createRuntimeFixture('failed-creation')
        let ownedDisposeCount = 0
        let borrowedDisposeCount = 0
        const owned = {
            request() {
                throw new Error('no request is expected during failed creation')
            },
            async dispose() {
                ownedDisposeCount++
            },
        }
        const borrowed = {
            request() {
                throw new Error('no request is expected during failed creation')
            },
            async dispose() {
                borrowedDisposeCount++
            },
        }

        for (const binding of [
            { ownership: 'owned', executor: owned },
            { ownership: 'borrowed', executor: borrowed },
        ]) {
            let failure
            try {
                await createRuntime(fixture, binding, { maxRequests: 0 })
            } catch (error) {
                failure = error
            }
            expect(failure).to.be.instanceOf(Error)
        }

        expect(ownedDisposeCount).to.equal(1)
        expect(borrowedDisposeCount).to.equal(0)
        await fixture.gpuRuntime.dispose()
    })

    it('releases every owned authority when demand shutdown rejects', async() => {

        const fixture = await createRuntimeFixture('failed-shutdown')
        const executorFailure = new Error('injected executor disposal failure')
        const runtime = await createRuntime(fixture, {
            ownership: 'owned',
            executor: {
                request() {
                    throw new Error('no request is expected during disposal')
                },
                async dispose() {
                    throw executorFailure
                },
            },
        })
        const shutdownFailure = new Error('injected demand shutdown failure')
        runtime.scheduler.dispose = async() => { throw shutdownFailure }

        let failure
        try {
            await runtime.dispose()
        } catch (error) {
            failure = error
        }

        expect(failure).to.be.instanceOf(AggregateError)
        expect(failure.errors).to.include(shutdownFailure)
        expect(failure.errors).to.include(executorFailure)
        expect(runtime.inspect()).to.deep.include({
            demandStopped: true,
            disposed: true,
            executorOwnership: 'owned',
        })
        expect(runtime.inspect().demand).to.deep.include({ disposed: true })
        expect(runtime.inspect().residency).to.deep.include({ disposed: true })
        expect(runtime.gpu.atlas.isDisposed).to.equal(true)
        expect(runtime.gpu.pageTable.isDisposed).to.equal(true)
        expect(runtime.gpu.slotTable.isDisposed).to.equal(true)
        await fixture.gpuRuntime.dispose()
    })
})

let fixtureSequence = 0

async function createRuntimeFixture(label) {

    const sequence = ++fixtureSequence
    const fake = createFakeGpu({ deferErrorScopePops: false })
    const gpuRuntime = await GPURuntime.create({ gpu: fake.gpu })
    const coverage = tileMatrixCoverage({
        tileMatrixSet: WebMercatorQuad,
        limits: [ {
            matrixId: '0',
            minTileRow: 0,
            maxTileRow: 0,
            minTileCol: 0,
            maxTileCol: 0,
        } ],
    })
    const model = webMercatorVirtualRasterField({
        id: `${label}-${sequence}`,
        addressSpaceId: `${label}-address-space-${sequence}`,
        sourceRevision: 'v1',
        coverage,
        geographicBounds: [ -180, -85, 180, 85 ],
        fieldKind: 'scalar',
        channels: 1,
        sampleType: 'unorm8',
        gpuFormat: 'r8unorm',
        interpolation: 'linear',
    })
    return Object.freeze({ gpuRuntime, model })
}

function createRuntime(fixture, executor, overrides = {}) {

    return createVirtualRasterRuntime({
        runtime: fixture.gpuRuntime,
        model: fixture.model,
        executor,
        maxRequests: 1,
        maxPhysicalPages: 1,
        maxStagingBytes: 256 * 256,
        maxHistory: 4,
        ...overrides,
    })
}
