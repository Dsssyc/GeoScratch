import { expect } from 'chai'
import { GPURuntime } from 'geoscratch/scratch'
import {
    WebMercatorQuad,
    createGeoViewSnapshot,
    tileMatrixCoverage,
    webMercatorPlanarTileSpatialProfile,
    webMercatorQuadAddressCodec,
} from 'geoscratch/geo'
import {
    evaluateGpuWebMercatorQuadCoverReference,
} from '../packages/geoscratch/dist/geo/gpu-web-mercator-quad-cover-reference.js'
import {
    GpuWebMercatorQuadCover,
    decodeGpuWebMercatorQuadCoverFeedback,
    gpuWebMercatorQuadCoverPolicy,
} from '../packages/geoscratch/dist/geo/gpu-web-mercator-quad-cover.js'
import {
    gpuWebMercatorQuadCoverReadWgslModule,
} from '../packages/geoscratch/dist/geo/gpu-web-mercator-quad-cover-layout.js'
import { createFakeGpu } from './scratch-test-utils.js'

const HALF_WORLD = 20_037_508.3427892
const WORLD_WIDTH = HALF_WORLD * 2

function fixture(options = {}) {

    const minimumMatrixLevel = options.minimumMatrixLevel ?? 0
    const sourceMaximumMatrixLevel = options.sourceMaximumMatrixLevel ?? 10
    const maximumMatrixLevel = options.maximumMatrixLevel ?? 14
    const coverage = tileMatrixCoverage({
        tileMatrixSet: WebMercatorQuad,
        limits: Array.from(
            { length: sourceMaximumMatrixLevel - minimumMatrixLevel + 1 },
            (_, index) => minimumMatrixLevel + index
        ).map(level => ({
            matrixId: String(level),
            minTileRow: 0,
            maxTileRow: 2 ** level - 1,
            minTileCol: 0,
            maxTileCol: 2 ** level - 1,
        })),
    })
    const spatialProfile = webMercatorPlanarTileSpatialProfile({
        addressCodec: webMercatorQuadAddressCodec({ coverage }),
    })
    const policy = gpuWebMercatorQuadCoverPolicy({
        minimumMatrixLevel,
        maximumMatrixLevel,
        sourceMaximumMatrixLevel,
        maximumPatches: options.maximumPatches ?? 256,
    })

    function view({
        x = 0,
        y = 0,
        altitude = 1_000_000,
        zoom = 10,
        pitch = 0,
        frameEpoch = 1,
    } = {}) {

        return createGeoViewSnapshot({
            id: `cover-view-${frameEpoch}`,
            clipFromRelativeWorld: [
                1 / HALF_WORLD, 0, 0, 0,
                0, 1 / HALF_WORLD, 0, 0,
                0, 0, 1 / 1_000_000, 0,
                0, 0, 1, 1,
            ],
            cameraHigh: [ Math.fround(x), Math.fround(y), Math.fround(altitude) ],
            cameraLow: [
                x - Math.fround(x),
                y - Math.fround(y),
                altitude - Math.fround(altitude),
            ],
            viewport: [ 1280, 800 ],
            verticalFovRadians: Math.PI / 3,
            cameraLatitudeRadians: 0,
            cameraPitchRadians: pitch,
            zoomHint: zoom,
            frameEpoch,
            residencySnapshotEpoch: 1,
        })
    }

    function evaluate({
        currentView = view(),
        visibleBounds = { west: 0.42, north: 0.42, east: 0.58, south: 0.58 },
    } = {}) {

        return evaluateGpuWebMercatorQuadCoverReference({
            spatialProfile,
            policy,
            view: currentView,
            visibleBounds,
        })
    }

    return { spatialProfile, policy, view, evaluate }
}

function scaledBounds(patch, maximumLevel) {

    const scale = 2 ** (maximumLevel - patch.matrixLevel)
    return {
        west: patch.tileCol * scale,
        north: patch.tileRow * scale,
        east: (patch.tileCol + 1) * scale,
        south: (patch.tileRow + 1) * scale,
    }
}

function contains(outer, inner) {

    return outer.west <= inner.west && outer.north <= inner.north &&
        outer.east >= inner.east && outer.south >= inner.south
}

function edgeAdjacent(left, right) {

    const horizontal = (left.east === right.west || right.east === left.west) &&
        Math.max(left.north, right.north) < Math.min(left.south, right.south)
    const vertical = (left.south === right.north || right.south === left.north) &&
        Math.max(left.west, right.west) < Math.min(left.east, right.east)
    return horizontal || vertical
}

function patchAt(result, x, y) {

    return result.patches.find(patch => {
        const size = 2 ** patch.matrixLevel
        return x >= patch.tileCol / size && x <= (patch.tileCol + 1) / size &&
            y >= patch.tileRow / size && y <= (patch.tileRow + 1) / size
    })
}

function projectedCameraAtTile(level, tileCol, tileRow, fractionX, fractionY) {

    const scale = 2 ** level
    const normalizedX = (tileCol + fractionX) / scale
    const normalizedY = (tileRow + fractionY) / scale
    return {
        x: normalizedX * WORLD_WIDTH - HALF_WORLD,
        y: HALF_WORLD - normalizedY * WORLD_WIDTH,
        normalizedX,
        normalizedY,
    }
}

function selectedLevel(result, x, y) {

    const patch = patchAt(result, x, y)
    expect(patch, `cover at ${x},${y}`).not.to.equal(undefined)
    return patch.matrixLevel
}

function expectStandardBalancedCover(result, maximumLevel) {

    expect(result.patches.length).to.be.greaterThan(0)
    const bounds = result.patches.map(patch => scaledBounds(patch, maximumLevel))
    for (const [ index, patch ] of result.patches.entries()) {
        expect(patch.key).to.equal(
            `${patch.matrixLevel}/${patch.tileRow}/${patch.tileCol}`
        )
        expect(patch.tileMatrixSetId).to.equal(WebMercatorQuad.id)
        expect(patch.tileRow).to.be.within(0, 2 ** patch.matrixLevel - 1)
        expect(patch.tileCol).to.be.within(0, 2 ** patch.matrixLevel - 1)
        for (let other = index + 1; other < result.patches.length; other++) {
            expect(
                contains(bounds[index], bounds[other]) ||
                contains(bounds[other], bounds[index]),
                `prefix overlap: ${patch.key} and ${result.patches[other].key}`
            ).to.equal(false)
            if (edgeAdjacent(bounds[index], bounds[other])) {
                expect(
                    Math.abs(patch.matrixLevel - result.patches[other].matrixLevel),
                    `unbalanced edge: ${patch.key} and ${result.patches[other].key}`
                ).to.be.at.most(1)
            }
        }
    }
}

describe('GPU WebMercatorQuad inverse cover reference', () => {

    it('emits one deterministic standard prefix-free and 2:1-balanced cover', () => {

        const setup = fixture()
        const first = setup.evaluate()
        const second = setup.evaluate()

        expect(first).to.deep.equal(second)
        expectStandardBalancedCover(first, setup.policy.maximumMatrixLevel)
        expect(first.facts.selectionPath).to.equal(
            'gpu-camera-inverse-webmercatorquad-cover'
        )
    })

    it('keeps a centered top-down cover symmetric in the fixed matrix', () => {

        const setup = fixture()
        const result = setup.evaluate({
            currentView: setup.view({ x: 0, y: 0, zoom: 10, pitch: 0 }),
        })
        const keys = new Set(result.patches.map(patch => patch.key))

        for (const patch of result.patches) {
            const size = 2 ** patch.matrixLevel
            expect(keys.has(
                `${patch.matrixLevel}/${patch.tileRow}/${size - 1 - patch.tileCol}`
            )).to.equal(true)
            expect(keys.has(
                `${patch.matrixLevel}/${size - 1 - patch.tileRow}/${patch.tileCol}`
            )).to.equal(true)
        }
    })

    it('keeps equal-distance samples symmetric at odd camera tile indices', () => {

        const setup = fixture()
        for (const sample of [
            { level: 14, col: 13_697, row: 6_670, fx: 0.966, fy: 0.354, axis: 'x' },
            { level: 12, col: 3_424, row: 1_667, fx: 0.491, fy: 0.589, axis: 'y' },
        ]) {
            const camera = projectedCameraAtTile(
                sample.level,
                sample.col,
                sample.row,
                sample.fx,
                sample.fy
            )
            const delta = 1 / 2 ** sample.level
            const result = setup.evaluate({
                currentView: setup.view({
                    x: camera.x,
                    y: camera.y,
                    zoom: sample.level - 0.75,
                }),
                visibleBounds: {
                    west: camera.normalizedX - delta * 4,
                    east: camera.normalizedX + delta * 4,
                    north: camera.normalizedY - delta * 4,
                    south: camera.normalizedY + delta * 4,
                },
            })
            const negative = sample.axis === 'x'
                ? [ camera.normalizedX - delta, camera.normalizedY ]
                : [ camera.normalizedX, camera.normalizedY - delta ]
            const positive = sample.axis === 'x'
                ? [ camera.normalizedX + delta, camera.normalizedY ]
                : [ camera.normalizedX, camera.normalizedY + delta ]

            expect(selectedLevel(result, ...negative)).to.equal(
                selectedLevel(result, ...positive)
            )
        }
    })

    it('expands both directions at an exact odd parent-center boundary', () => {

        const setup = fixture()
        const level = 10
        const camera = projectedCameraAtTile(level, 513, 417, 0, 0)
        const delta = 1.5 / 2 ** level
        const result = setup.evaluate({
            currentView: setup.view({ x: camera.x, y: camera.y, zoom: 9.25 }),
            visibleBounds: {
                west: camera.normalizedX - delta * 3,
                east: camera.normalizedX + delta * 3,
                north: camera.normalizedY - delta * 3,
                south: camera.normalizedY + delta * 3,
            },
        })

        expect(selectedLevel(
            result,
            camera.normalizedX - delta,
            camera.normalizedY
        )).to.equal(selectedLevel(
            result,
            camera.normalizedX + delta,
            camera.normalizedY
        ))
        expect(selectedLevel(
            result,
            camera.normalizedX,
            camera.normalizedY - delta
        )).to.equal(selectedLevel(
            result,
            camera.normalizedX,
            camera.normalizedY + delta
        ))
    })

    it('does not coarsen visible sample locations during zoom-in', () => {

        const setup = fixture()
        const coarse = setup.evaluate({ currentView: setup.view({ zoom: 9 }) })
        const fine = setup.evaluate({ currentView: setup.view({ zoom: 10 }) })

        for (const [ x, y ] of [
            [ 0.45, 0.45 ],
            [ 0.5, 0.5 ],
            [ 0.55, 0.45 ],
            [ 0.45, 0.55 ],
            [ 0.55, 0.55 ],
        ]) {
            const coarsePatch = patchAt(coarse, x, y)
            const finePatch = patchAt(fine, x, y)
            expect(coarsePatch, `coarse cover at ${x},${y}`).not.to.equal(undefined)
            expect(finePatch, `fine cover at ${x},${y}`).not.to.equal(undefined)
            expect(finePatch.matrixLevel).to.be.at.least(coarsePatch.matrixLevel)
        }
    })

    it('does not select an equivalent farther location finer than a nearer one', () => {

        const setup = fixture()
        const result = setup.evaluate({
            currentView: setup.view({
                x: 0,
                y: -WORLD_WIDTH * 0.08,
                zoom: 10,
                pitch: Math.PI * 0.38,
            }),
            visibleBounds: { west: 0.44, north: 0.24, east: 0.56, south: 0.58 },
        })
        const near = patchAt(result, 0.5, 0.55)
        const far = patchAt(result, 0.5, 0.28)

        expect(near).not.to.equal(undefined)
        expect(far).not.to.equal(undefined)
        expect(near.matrixLevel).to.be.at.least(far.matrixLevel)
    })

    it('prioritizes equal-precision demand by wrapped distance to the camera tile', () => {

        const setup = fixture()
        const result = setup.evaluate({
            currentView: setup.view({ x: 0, y: 0, zoom: 10, pitch: 0 }),
            visibleBounds: { west: 0.46, north: 0.46, east: 0.54, south: 0.54 },
        })
        const desiredLevel = Math.max(...result.demands.map(demand =>
            demand.desiredSampleLevel
        ))
        const equallyDetailed = result.demands.filter(demand =>
            demand.desiredSampleLevel === desiredLevel
        )
        const distances = equallyDetailed.map(demand => {
            const page = demand.requestPage
            const size = 2 ** page.matrixLevel
            const cameraRow = Math.floor(0.5 * size)
            const cameraCol = Math.floor(0.5 * size)
            const rowDistance = Math.abs(page.tileRow - cameraRow)
            const rawColDistance = Math.abs(page.tileCol - cameraCol)
            return rowDistance + Math.min(rawColDistance, size - rawColDistance)
        })

        expect(equallyDetailed.length).to.be.greaterThan(1)
        expect(distances).to.deep.equal([ ...distances ].sort((left, right) => left - right))
        expect(equallyDetailed.map(demand => demand.priority)).to.deep.equal(
            [ ...equallyDetailed ].map(demand => demand.priority).sort((left, right) =>
                right - left
            )
        )
    })

    it('keeps desired sample precision separate from the executable source page', () => {

        const setup = fixture({ sourceMaximumMatrixLevel: 10, maximumMatrixLevel: 14 })
        const result = setup.evaluate({
            currentView: setup.view({ zoom: 14 }),
            visibleBounds: { west: 0.49, north: 0.49, east: 0.51, south: 0.51 },
        })

        expect(result.patches.some(patch => patch.matrixLevel === 14)).to.equal(true)
        expect(result.demands.some(demand =>
            demand.desiredSampleLevel === 14 &&
            demand.requestPage.matrixLevel === 10
        )).to.equal(true)
        expect(result.demands.every(demand =>
            demand.requestPage.matrixLevel <= setup.policy.sourceMaximumMatrixLevel
        )).to.equal(true)
        expect(result.facts.sourceLevelCeiling).to.equal(10)
    })
})

describe('GPU WebMercatorQuad inverse cover lowering', () => {

    it('publishes a bounded full-identity read-side lookup and stitching module', () => {

        const module = gpuWebMercatorQuadCoverReadWgslModule({
            namespace: 'TerrainCover',
            group: 1,
            visibleInstancesBinding: 2,
            lookupEntriesBinding: 3,
        })

        expect(module).to.deep.include({
            kind: 'gpu-web-mercator-quad-cover-read-wgsl-module',
            namespace: 'TerrainCover',
        })
        expect(module.code).to.include('@group(1) @binding(2)')
        expect(module.code).to.include('@group(1) @binding(3)')
        expect(module.code).to.include('entry.matrixLevel == matrix_level')
        expect(module.code).to.include('entry.tileRow == tile_row')
        expect(module.code).to.include('entry.tileCol == tile_col')
        expect(module.code).to.include('fn TerrainCover_neighbor(')
        expect(module.code).to.include('fn TerrainCover_snap_edge_coordinate(')
        expect(module.code).not.to.include('matrixLevel << 28u')
    })

    it('decodes bounded cover and desired/source-level feedback facts', () => {

        const state = new Uint32Array([
            42,
            88,
            24,
            2,
            0,
            0,
            0,
            8,
            11,
            1,
            11,
            10,
            0,
            0,
            0,
            0,
        ])
        const demandWords = new Uint32Array(4 * 8)
        demandWords.set([ 11, 10, 10, 416, 855, 11_000_000, 42, 7 ], 0)
        demandWords.set([ 10, 10, 10, 416, 856, 10_000_000, 42, 7 ], 8)

        const decoded = decodeGpuWebMercatorQuadCoverFeedback(
            new Uint8Array(state.buffer),
            new Uint8Array(demandWords.buffer),
            {
                expectedFrameEpoch: 42,
                maximumPatches: 64,
                sourceLevelCeiling: 10,
            }
        )

        expect(decoded).to.deep.equal({
            frameEpoch: 42,
            candidateCount: 88,
            patchCount: 24,
            demandCount: 2,
            descriptorOverflowCount: 0,
            lookupOverflowCount: 0,
            demandOverflowCount: 0,
            minimumMatrixLevel: 8,
            maximumMatrixLevel: 11,
            maximumAdjacentLevelDelta: 1,
            finestMatrixLevel: 11,
            sourceLevelCeiling: 10,
            demands: [
                {
                    desiredSampleLevel: 11,
                    sourceLevelCeiling: 10,
                    requestMatrixLevel: 10,
                    tileRow: 416,
                    tileCol: 855,
                    priority: 11_000_000,
                    decisionFrameEpoch: 42,
                    residencySnapshotEpoch: 7,
                },
                {
                    desiredSampleLevel: 10,
                    sourceLevelCeiling: 10,
                    requestMatrixLevel: 10,
                    tileRow: 416,
                    tileCol: 856,
                    priority: 10_000_000,
                    decisionFrameEpoch: 42,
                    residencySnapshotEpoch: 7,
                },
            ],
        })
    })

    it('owns one stable double-parity compute graph without raster residency authority', async() => {

        const setup = fixture({
            minimumMatrixLevel: 0,
            sourceMaximumMatrixLevel: 10,
            maximumMatrixLevel: 14,
            maximumPatches: 64,
        })
        const fake = createFakeGpu()
        const runtime = await GPURuntime.create({ gpu: fake.gpu })
        const cover = await GpuWebMercatorQuadCover.create(runtime, {
            spatialProfile: setup.spatialProfile,
            policy: setup.policy,
            elevationRangeMeters: [ -120, 30 ],
            vertexCount: 24_576,
        })

        expect(cover.facts()).to.deep.include({
            selectionPath: 'gpu-camera-inverse-webmercatorquad-cover',
            lookupCapacity: 128,
            coverageLimitCount: 11,
        })
        expect(cover.facts().parity).to.have.length(2)
        expect(cover.facts().parity.every(parity =>
            parity.commandIds.length === 3
        )).to.equal(true)
        const templates = cover.renderTemplates()
        expect(templates.map(template => template.coverId)).to.deep.equal([
            cover.id,
            cover.id,
        ])
        expect(templates.map(template => template.parity)).to.deep.equal([ 0, 1 ])

        const view = setup.view({ zoom: 10, frameEpoch: 42 })
        const token = cover.writeView(view)
        const frame = cover.frame(token)
        const builder = runtime.submission()
        cover.initialize(builder)
        cover.encode(builder, frame)
        cover.capture(builder, frame)
        const submitted = builder.submit()
        expect(submitted.readbacks.map(link => link.commandId)).to.have.length(2)
        expect(fake.calls.dispatchCalls).to.have.length(1)

        token.dispose()
        cover.dispose()
        await runtime.dispose()
    })
})
