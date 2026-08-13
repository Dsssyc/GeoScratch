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

    it('releases every owned authority when demand shutdown rejects', async() => {

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
            id: 'lifetime-height',
            addressSpaceId: 'lifetime-height-address-space',
            sourceRevision: 'v1',
            coverage,
            geographicBounds: [ -180, -85, 180, 85 ],
            fieldKind: 'scalar',
            channels: 1,
            sampleType: 'unorm8',
            gpuFormat: 'r8unorm',
            interpolation: 'linear',
        })
        const runtime = await createVirtualRasterRuntime({
            runtime: gpuRuntime,
            model,
            executor: {
                request() {
                    throw new Error('no request is expected during disposal')
                },
            },
            maxRequests: 1,
            maxPhysicalPages: 1,
            maxStagingBytes: 256 * 256,
            maxHistory: 4,
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
        expect(runtime.inspect()).to.deep.include({
            demandStopped: true,
            disposed: true,
        })
        expect(runtime.inspect().demand).to.deep.include({ disposed: true })
        expect(runtime.inspect().residency).to.deep.include({ disposed: true })
        expect(runtime.gpu.atlas.isDisposed).to.equal(true)
        expect(runtime.gpu.pageTable.isDisposed).to.equal(true)
        expect(runtime.gpu.slotTable.isDisposed).to.equal(true)
        await gpuRuntime.dispose()
    })
})
