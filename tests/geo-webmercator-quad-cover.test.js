import { expect } from 'chai'
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
    gpuWebMercatorQuadCoverPolicy,
} from '../packages/geoscratch/dist/geo/gpu-web-mercator-quad-cover.js'

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
        maximumDemands: options.maximumDemands ?? 128,
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
        expect(first.facts.rootTraversalCount).to.equal(0)
        expect(first.facts.trialCount).to.equal(0)
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
