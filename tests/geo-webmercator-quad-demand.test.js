import { expect } from 'chai'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { GPURuntime } from 'geoscratch/scratch'
import {
    GpuWebMercatorQuadCover,
    GpuWebMercatorQuadDemandProjection,
    WebMercatorQuad,
    createGeoViewSnapshot,
    decodeGpuWebMercatorQuadDemandProjectionFeedback,
    gpuWebMercatorQuadCoverPolicy,
    tileMatrixCoverage,
    webMercatorPlanarTileSpatialProfile,
    webMercatorQuadAddressCodec,
} from 'geoscratch/geo'
import { createFakeGpu } from './scratch-test-utils.js'

const root = resolve(import.meta.dirname, '..')
const source = (...parts) => resolve(root, 'packages', 'geoscratch', 'src', 'geo', ...parts)

function coverage(maximumMatrixLevel = 2) {

    return tileMatrixCoverage({
        tileMatrixSet: WebMercatorQuad,
        limits: Array.from({ length: maximumMatrixLevel + 1 }, (_, level) => ({
            matrixId: String(level),
            minTileRow: 0,
            maxTileRow: 2 ** level - 1,
            minTileCol: 0,
            maxTileCol: 2 ** level - 1,
        })),
    })
}

async function fixture() {

    const fake = createFakeGpu()
    const runtime = await GPURuntime.create({ gpu: fake.gpu })
    const sourceCoverage = coverage()
    const spatialProfile = webMercatorPlanarTileSpatialProfile({
        addressCodec: webMercatorQuadAddressCodec({ coverage: sourceCoverage }),
    })
    const cover = await GpuWebMercatorQuadCover.create(runtime, {
        spatialProfile,
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
    const projection = await GpuWebMercatorQuadDemandProjection.create(runtime, {
        cover,
        sourceCoverage,
        maximumDemands: 64,
    })
    return { ...fake, runtime, cover, projection }
}

function view(frameEpoch = 7) {

    return createGeoViewSnapshot({
        id: `demand-view-${frameEpoch}`,
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
        frameEpoch,
        residencySnapshotEpoch: 9,
    })
}

describe('GPU WebMercatorQuad demand projection', () => {

    it('exists as a source-owned GPU component independent from the geometry cover', () => {

        const implementation = source('gpu-web-mercator-quad-demand.ts')
        expect(existsSync(implementation)).to.equal(true)
        const contents = readFileSync(implementation, 'utf8')

        expect(contents).to.include('export class GpuWebMercatorQuadDemandProjection')
        expect(contents).to.include('sourceMaximumMatrixLevel')
        expect(contents).to.include('desiredSampleLevel')
        expect(contents).to.include('requestMatrixLevel')
        expect(contents).to.not.include('maximumCellSpanReferencePixels')
        expect(contents).to.not.include('verticalBounds')
    })

    it('decodes desired precision separately from executable source tiles', () => {

        const state = new Uint32Array([ 7, 2, 0, 10 ])
        const demandWords = new Uint32Array(4 * 8)
        demandWords.set([ 14, 10, 10, 416, 855, 14_999_998, 7, 9 ], 0)
        demandWords.set([ 13, 10, 10, 416, 856, 13_999_997, 7, 9 ], 8)

        expect(decodeGpuWebMercatorQuadDemandProjectionFeedback(
            new Uint8Array(state.buffer),
            new Uint8Array(demandWords.buffer),
            { expectedFrameEpoch: 7, maximumDemands: 4, sourceLevelCeiling: 10 }
        )).to.deep.equal({
            frameEpoch: 7,
            demandCount: 2,
            overflowCount: 0,
            sourceLevelCeiling: 10,
            demands: [
                {
                    desiredSampleLevel: 14,
                    sourceLevelCeiling: 10,
                    requestMatrixLevel: 10,
                    tileRow: 416,
                    tileCol: 855,
                    priority: 14_999_998,
                    decisionFrameEpoch: 7,
                    residencySnapshotEpoch: 9,
                },
                {
                    desiredSampleLevel: 13,
                    sourceLevelCeiling: 10,
                    requestMatrixLevel: 10,
                    tileRow: 416,
                    tileCol: 856,
                    priority: 13_999_997,
                    decisionFrameEpoch: 7,
                    residencySnapshotEpoch: 9,
                },
            ],
        })

        const invalidWords = demandWords.slice()
        invalidWords[1] = 9
        expect(() => decodeGpuWebMercatorQuadDemandProjectionFeedback(
            new Uint8Array(state.buffer),
            new Uint8Array(invalidWords.buffer),
            { expectedFrameEpoch: 7, maximumDemands: 4, sourceLevelCeiling: 10 }
        )).to.throw()
    })

    it('rejects a source whose minimum level cannot cover coarse geometry patches', async() => {

        const setup = await fixture()
        const incompatibleCoverage = tileMatrixCoverage({
            tileMatrixSet: WebMercatorQuad,
            limits: [ {
                matrixId: '1',
                minTileRow: 0,
                maxTileRow: 1,
                minTileCol: 0,
                maxTileCol: 1,
            } ],
        })
        let created
        let failure
        try {
            created = await GpuWebMercatorQuadDemandProjection.create(setup.runtime, {
                cover: setup.cover,
                sourceCoverage: incompatibleCoverage,
                maximumDemands: 64,
            })
        } catch (error) {
            failure = error
        }

        expect(failure).to.be.instanceOf(Error)
        created?.dispose()
        setup.projection.dispose()
        setup.cover.dispose()
        await setup.runtime.dispose()
    })

    it('composes after cover compute and owns only projection resources', async() => {

        const setup = await fixture()
        const token = setup.cover.writeView(view())
        const coverFrame = setup.cover.frame(token)
        const demandFrame = setup.projection.frame(coverFrame)
        expect(() => setup.projection.frame({ ...coverFrame })).to.throw()
        expect(() => setup.projection.encode(
            setup.runtime.submission(),
            demandFrame
        )).to.throw()
        const builder = setup.runtime.submission()
        setup.cover.initialize(builder)
        setup.projection.initialize(builder)
        setup.cover.encode(builder, coverFrame)
        setup.projection.encode(builder, demandFrame)
        setup.cover.capture(builder, coverFrame)
        setup.projection.capture(builder, demandFrame)
        const submitted = builder.submit()

        expect(setup.calls.dispatchCalls).to.have.length(3)
        expect(setup.calls.dispatchCalls[0].type).to.equal('dispatchWorkgroupsIndirect')
        expect(setup.calls.dispatchCalls.slice(1)).to.deep.equal([
            { x: 1, y: 1, z: 1 }, { x: 1, y: 1, z: 1 },
        ])
        expect(submitted.readbacks).to.have.length(3)
        expect(setup.projection.facts()).to.deep.include({
            coverId: setup.cover.id,
            minimumSourceMatrixLevel: 0,
            sourceMaximumMatrixLevel: 2,
            maximumDemands: 64,
        })
        const coverResourceIds = new Set(
            setup.cover.identityObjects().resources.map(resource => resource.id)
        )
        expect(setup.projection.identityObjects().resources.every(resource =>
            !coverResourceIds.has(resource.id)
        )).to.equal(true)

        token.dispose()
        setup.projection.dispose()
        expect(setup.cover.facts().disposed).to.equal(false)
        setup.cover.dispose()
        await setup.runtime.dispose()
    })
})
