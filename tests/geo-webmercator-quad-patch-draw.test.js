import { expect } from 'chai'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { GPURuntime } from 'geoscratch/scratch'
import {
    GpuWebMercatorQuadCover,
    GpuWebMercatorQuadPatchDraw,
    WebMercatorQuad,
    createGeoViewSnapshot,
    gpuWebMercatorQuadCoverPolicy,
    tileMatrixCoverage,
    webMercatorPlanarTileSpatialProfile,
    webMercatorQuadAddressCodec,
} from 'geoscratch/geo'
import { createFakeGpu } from './scratch-test-utils.js'

const root = resolve(import.meta.dirname, '..')
const implementation = resolve(
    root,
    'packages',
    'geoscratch',
    'src',
    'geo',
    'gpu-web-mercator-quad-patch-draw.ts'
)

describe('GPU WebMercatorQuad patch draw preparation', () => {

    it('owns indirect draw arguments without owning geometry selection', () => {

        expect(existsSync(implementation)).to.equal(true)
        const contents = readFileSync(implementation, 'utf8')

        expect(contents).to.include('export class GpuWebMercatorQuadPatchDraw')
        expect(contents).to.include('createDispatchCommand')
        expect(contents).to.include("contentEpoch: 'current-at-step'")
        expect(contents).to.include('vertexCount')
        expect(contents).to.include('patchCount')
        expect(contents).to.not.include('maximumCellSpanReferencePixels')
        expect(contents).to.not.include('sourceMaximumMatrixLevel')
    })

    it('owns indirect arguments and borrows one cover frame', async() => {

        const fake = createFakeGpu()
        const runtime = await GPURuntime.create({ gpu: fake.gpu })
        const sourceCoverage = tileMatrixCoverage({
            tileMatrixSet: WebMercatorQuad,
            limits: [ {
                matrixId: '0',
                minTileRow: 0,
                maxTileRow: 0,
                minTileCol: 0,
                maxTileCol: 0,
            } ],
        })
        const cover = await GpuWebMercatorQuadCover.create(runtime, {
            spatialProfile: webMercatorPlanarTileSpatialProfile({
                addressCodec: webMercatorQuadAddressCodec({ coverage: sourceCoverage }),
            }),
            policy: gpuWebMercatorQuadCoverPolicy({
                minimumMatrixLevel: 0,
                maximumMatrixLevel: 4,
                maximumPatches: 64,
                cellsPerPatchEdge: 128,
                maximumCellSpanReferencePixels: 4,
                refinementTolerance: 0.005,
            }),
            verticalRangeMeters: [ 0, 0 ],
        })
        const patchDraw = await GpuWebMercatorQuadPatchDraw.create(runtime, {
            cover,
            vertexCount: 98_304,
        })
        const snapshot = createGeoViewSnapshot({
            id: 'patch-draw-view',
            clipFromRelativeWorld: new Float64Array([
                1, 0, 0, 0,
                0, 1, 0, 0,
                0, 0, 1, 0,
                0, 0, 0, 1,
            ]),
            cameraHigh: [ 0, 0, 1000 ],
            cameraLow: [ 0, 0, 0 ],
            referenceViewport: [ 800, 600 ],
            verticalFovRadians: Math.PI / 3,
            cameraLatitudeRadians: 0,
            cameraPitchRadians: 0,
            zoomHint: 2,
            frameEpoch: 1,
            residencySnapshotEpoch: 1,
        })
        const token = cover.writeView(snapshot)
        const coverFrame = cover.frame(token)
        const drawFrame = patchDraw.frame(coverFrame)
        const builder = runtime.submission()
        cover.initialize(builder)
        patchDraw.initialize(builder)
        cover.encode(builder, coverFrame)
        patchDraw.encode(builder, drawFrame)
        builder.submit()

        expect(fake.calls.dispatchCalls).to.have.length(2)
        expect(drawFrame.drawArgument.size).to.equal(16)
        expect(patchDraw.facts()).to.deep.include({
            coverId: cover.id,
            vertexCount: 98_304,
        })
        const coverResourceIds = new Set(
            cover.identityObjects().resources.map(resource => resource.id)
        )
        expect(patchDraw.identityObjects().resources.some(resource =>
            !coverResourceIds.has(resource.id) &&
            resource.label.includes('patch draw arguments')
        )).to.equal(true)

        token.dispose()
        patchDraw.dispose()
        expect(cover.facts().disposed).to.equal(false)
        cover.dispose()
        await runtime.dispose()
    })
})
