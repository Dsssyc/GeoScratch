import { expect } from 'chai'
import { GPURuntime } from 'geoscratch/scratch'
import {
    GpuWebMercatorQuadCover,
    WebMercatorQuad,
    tileMatrixCoverage,
    webMercatorPlanarTileSpatialProfile,
    webMercatorQuadAddressCodec,
} from 'geoscratch/geo'
import { createFakeGpu } from './scratch-test-utils.js'

function descriptor() {

    const coverage = tileMatrixCoverage({
        tileMatrixSet: WebMercatorQuad,
        limits: [{ matrixId: '0', minTileRow: 0, maxTileRow: 0, minTileCol: 0, maxTileCol: 0 }],
    })
    return {
        spatialProfile: webMercatorPlanarTileSpatialProfile({
            addressCodec: webMercatorQuadAddressCodec({ coverage }),
        }),
        policy: { minimumMatrixLevel: 0, maximumMatrixLevel: 2, maximumPatches: 8,
            cellsPerPatchEdge: 128, maximumCellSpanReferencePixels: 5, refinementTolerance: 0.005 },
        verticalRangeMeters: [0, 0],
        maximumCandidates: 16,
    }
}

function deferred() {

    let resolve
    const promise = new Promise(value => { resolve = value })
    return { promise, resolve }
}

const turn = () => new Promise(resolve => setImmediate(resolve))

async function assertLateSiblingCleanup(stage) {

    const fake = createFakeGpu()
    const runtime = await GPURuntime.create({ gpu: fake.gpu })
    const entered = deferred()
    const release = deferred()
    const primary = new Error(`First ${stage} parity failed`)
    const acquired = []
    let lateResource
    let construction
    let settled = false
    const method = stage === 'buffer' ? 'createBuffer' : 'createBindSet'
    const original = runtime[method].bind(runtime)
    const labelPrefix = stage === 'buffer'
        ? 'GPU WebMercatorQuad cover map metadata'
        : 'GPU WebMercatorQuad inverse-cover bindings'
    runtime[method] = async (...args) => {
        const label = (stage === 'buffer' ? args[0] : args[2])?.label
        if (label === `${labelPrefix} 0`) {
            await entered.promise
            throw primary
        }
        const resource = await original(...args)
        acquired.push(resource)
        if (label === `${labelPrefix} 1`) {
            lateResource = resource
            entered.resolve()
            await release.promise
        }
        return resource
    }

    try {
        construction = GpuWebMercatorQuadCover.create(runtime, descriptor()).then(
            cover => { settled = true; return { cover } },
            error => { settled = true; return { error } },
        )
        await entered.promise
        await turn()
        expect(settled, 'Creation must retain ownership of the pending sibling').to.equal(false)
        expect(acquired.every(resource => !resource.isDisposed),
            'Cleanup must not invalidate resources used by pending creation').to.equal(true)
        expect(fake.calls.bufferDestroys).to.have.length(0)

        release.resolve()
        const result = await construction
        expect(result.error).to.equal(primary)
        expect(result.cover).to.equal(undefined)
        expect(lateResource.isDisposed, 'The resource returned late must join cleanup').to.equal(true)
        expect(acquired.every(resource => resource.isDisposed)).to.equal(true)
        expect(fake.calls.buffers.every(buffer => buffer.destroyed)).to.equal(true)
        expect(fake.calls.bufferDestroys).to.have.length(fake.calls.buffers.length)
        const bufferCount = fake.calls.buffers.length
        await turn()
        expect(fake.calls.buffers).to.have.length(bufferCount)
    } finally {
        release.resolve()
        const result = await construction
        result?.cover?.dispose()
        await runtime.dispose()
    }
}

describe('GPU WebMercatorQuad cover construction ownership', () => {
    it('waits for late resource-parity creation before releasing every acquired buffer', async() => {
        await assertLateSiblingCleanup('buffer')
    })

    it('waits for late binding-parity creation before disposing bindings and their resources', async() => {
        await assertLateSiblingCleanup('binding')
    })

    it('retains both parity failures after all construction producers settle', async() => {
        const fake = createFakeGpu()
        const runtime = await GPURuntime.create({ gpu: fake.gpu })
        const first = new Error('First parity failed')
        const second = new Error('Second parity failed')
        const entered = deferred()
        const release = deferred()
        const original = runtime.createBuffer.bind(runtime)
        let construction
        let settled = false
        runtime.createBuffer = async input => {
            if (input.label === 'GPU WebMercatorQuad cover map metadata 0') {
                await entered.promise
                throw first
            }
            if (input.label === 'GPU WebMercatorQuad cover map metadata 1') {
                entered.resolve()
                await release.promise
                throw second
            }
            return original(input)
        }
        try {
            construction = GpuWebMercatorQuadCover.create(runtime, descriptor()).then(
                cover => { settled = true; return { cover } },
                error => { settled = true; return { error } },
            )
            await entered.promise
            await turn()
            expect(settled).to.equal(false)
            release.resolve()
            const result = await construction
            expect(result.error).to.be.instanceOf(AggregateError)
            expect(result.error.errors).to.deep.equal([first, second])
            expect(fake.calls.buffers.every(buffer => buffer.destroyed)).to.equal(true)
        } finally {
            release.resolve()
            const result = await construction
            result?.cover?.dispose()
            await runtime.dispose()
        }
    })
})
