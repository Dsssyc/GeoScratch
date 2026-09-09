import { expect } from 'chai'
import { GPURuntime } from 'geoscratch/scratch'
import {
    GpuWebMercatorQuadCover,
    WebMercatorQuad,
    createGeoViewSnapshot,
    tileMatrixCoverage,
    webMercatorPlanarTileSpatialProfile,
    webMercatorQuadAddressCodec,
} from 'geoscratch/geo'
import { createFakeGpu } from './scratch-test-utils.js'

function descriptor(maximumCandidates) {
    const coverage = tileMatrixCoverage({
        tileMatrixSet: WebMercatorQuad,
        limits: [{ matrixId: '0', minTileRow: 0, maxTileRow: 0, minTileCol: 0, maxTileCol: 0 }],
    })
    return {
        spatialProfile: webMercatorPlanarTileSpatialProfile({
            addressCodec: webMercatorQuadAddressCodec({ coverage }),
        }),
        policy: { minimumMatrixLevel: 0, maximumMatrixLevel: 1, maximumPatches: 8,
            cellsPerPatchEdge: 128, maximumCellSpanReferencePixels: 5, refinementTolerance: 0.005 },
        verticalRangeMeters: [0, 0],
        ...(maximumCandidates === undefined ? {} : { maximumCandidates }),
    }
}

const singularView = () => createGeoViewSnapshot({
    id: 'candidate-fallback', clipFromRelativeWorld: new Float64Array(16),
    cameraHigh: [0, 0, 1000], cameraLow: [0, 0, 0], referenceViewport: [64, 64],
    verticalFovRadians: Math.PI / 3, cameraLatitudeRadians: 0,
    cameraPitchRadians: 0, zoomHint: 1, frameEpoch: 1, residencySnapshotEpoch: 1,
})

async function diagnostic(operation, code) {
    let caught
    try { await operation() } catch (error) { caught = error }
    expect(caught?.diagnostic?.code).to.equal(code)
    return caught.diagnostic
}

describe('Camera cover candidate budget', () => {
    it('rejects invalid enumeration budgets before constructing the cover', async() => {
        const runtime = await GPURuntime.create({ gpu: createFakeGpu().gpu })
        try {
            for (const value of [0, -1, 1.5, Infinity, 2 ** 32]) {
                await diagnostic(() => GpuWebMercatorQuadCover.create(runtime, descriptor(value)),
                    'GEO_WEB_MERCATOR_COVER_CANDIDATE_BUDGET_INVALID')
            }
        } finally { await runtime.dispose() }
    })

    it('reports an uncertified full-domain capacity failure without truncating its input', async() => {
        const runtime = await GPURuntime.create({ gpu: createFakeGpu().gpu })
        const cover = await GpuWebMercatorQuadCover.create(runtime, descriptor(1))
        try {
            const identities = cover.identityObjects().resources.map(resource => resource.id)
            const failure = await diagnostic(() => cover.writeView(singularView()),
                'GEO_WEB_MERCATOR_COVER_CANDIDATE_CAPACITY_EXCEEDED')
            expect(failure.actual).to.include({ candidateCount: 2, conservativeFallback: true })
            expect(cover.identityObjects().resources.map(resource => resource.id)).to.deep.equal(identities)
            expect(cover.facts().candidateCapacity).to.equal(1)
        } finally {
            cover.dispose()
            await runtime.dispose()
        }
    })

    it('can enumerate an uncertified complete domain when its explicit budget fits', async() => {
        const runtime = await GPURuntime.create({ gpu: createFakeGpu().gpu })
        const cover = await GpuWebMercatorQuadCover.create(runtime, descriptor(2))
        try {
            const token = cover.writeView(singularView())
            expect(token.frameEpoch).to.equal(1)
            token.dispose()
        } finally {
            cover.dispose()
            await runtime.dispose()
        }
    })
})
