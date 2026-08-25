import { expect } from 'chai'
import { GPURuntime } from 'geoscratch/scratch'
import { mat4 } from 'wgpu-matrix'
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
    const coverageMaximumMatrixLevel = options.coverageMaximumMatrixLevel ?? 10
    const maximumMatrixLevel = options.maximumMatrixLevel ?? 14
    const coverage = tileMatrixCoverage({
        tileMatrixSet: WebMercatorQuad,
        limits: Array.from(
            { length: coverageMaximumMatrixLevel - minimumMatrixLevel + 1 },
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
    const verticalRangeMeters = options.verticalRangeMeters ?? [ -120, 30 ]
    const verticalBounds = options.verticalBounds
    const policy = gpuWebMercatorQuadCoverPolicy({
        minimumMatrixLevel,
        maximumMatrixLevel,
        maximumPatches: options.maximumPatches ?? 256,
        cellsPerPatchEdge: options.cellsPerPatchEdge ?? 128,
        maximumCellSpanReferencePixels:
            options.maximumCellSpanReferencePixels ?? 4,
        refinementTolerance: options.refinementTolerance ?? 0.005,
    })

    function view({
        x = 0,
        y = 0,
        altitude,
        zoom = 10,
        pitch = 0,
        referenceViewport = [ 1280, 800 ],
        frameEpoch = 1,
    } = {}) {

        const resolvedAltitude = altitude ?? WORLD_WIDTH / 2 ** zoom * 1.5
        const verticalFovRadians = Math.PI / 3
        const clipFromRelativeWorld = mat4.perspective(
            verticalFovRadians,
            referenceViewport[0] / referenceViewport[1],
            1,
            resolvedAltitude * 16,
            new Float64Array(16)
        )
        mat4.rotateX(clipFromRelativeWorld, pitch, clipFromRelativeWorld)
        return createGeoViewSnapshot({
            id: `cover-view-${frameEpoch}`,
            clipFromRelativeWorld,
            cameraHigh: [ Math.fround(x), Math.fround(y), Math.fround(resolvedAltitude) ],
            cameraLow: [
                x - Math.fround(x),
                y - Math.fround(y),
                resolvedAltitude - Math.fround(resolvedAltitude),
            ],
            referenceViewport,
            verticalFovRadians,
            cameraLatitudeRadians: 0,
            cameraPitchRadians: pitch,
            zoomHint: zoom,
            frameEpoch,
            residencySnapshotEpoch: 1,
        })
    }

    function evaluate({
        currentView = view(),
        visibleBounds = visibleBoundsForView(currentView),
    } = {}) {

        return evaluateGpuWebMercatorQuadCoverReference({
            spatialProfile,
            policy,
            view: currentView,
            visibleBounds,
            verticalRangeMeters,
            ...(verticalBounds === undefined ? {} : { verticalBounds }),
        })
    }

    return { spatialProfile, policy, verticalRangeMeters, verticalBounds, view, evaluate }
}

function flatVerticalBounds(setup, vertical = 0) {

    return setup.spatialProfile.coverage.limits.flatMap(limit => {
        const matrixLevel = Number(limit.matrixId)
        return Array.from(
            { length: limit.maxTileRow - limit.minTileRow + 1 },
            (_, rowOffset) => Array.from(
                { length: limit.maxTileCol - limit.minTileCol + 1 },
                (_, colOffset) => ({
                    matrixLevel,
                    tileRow: limit.minTileRow + rowOffset,
                    tileCol: limit.minTileCol + colOffset,
                    minimumVerticalMeters: vertical,
                    maximumVerticalMeters: vertical,
                })
            )
        ).flat()
    })
}

function visibleBoundsForView(view) {

    const level = Math.max(0, Math.ceil(view.zoomHint))
    const scale = 2 ** level
    const x = (view.cameraHigh[0] + view.cameraLow[0] + HALF_WORLD) / WORLD_WIDTH
    const y = (HALF_WORLD - view.cameraHigh[1] - view.cameraLow[1]) / WORLD_WIDTH
    return {
        west: Math.max(0, x - 4 / scale),
        east: Math.min(1, x + 4 / scale),
        north: Math.max(0, y - 3 / scale),
        south: Math.min(1, y + 3 / scale),
    }
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

    it('validates one source-neutral projected-cell policy for every pitch', () => {

        const setup = fixture()

        expect(setup.policy).to.deep.include({
            cellsPerPatchEdge: 128,
            maximumCellSpanReferencePixels: 4,
            refinementTolerance: 0.005,
        })
        expect(setup.policy).not.to.have.property('sourceMaximumMatrixLevel')
        expect(setup.policy).not.to.have.property('variableLodPitchThresholdRadians')
        for (const maximumCellSpanReferencePixels of [ 0, Number.NaN ]) {
            expect(() => fixture({ maximumCellSpanReferencePixels })).to.throw()
        }
        for (const refinementTolerance of [
            -Number.EPSILON,
            0.1 + Number.EPSILON,
            Number.NaN,
        ]) {
            expect(() => fixture({ refinementTolerance })).to.throw()
        }
        for (const pitch of [ 0, Math.PI / 6, Math.PI / 3, Math.PI * 0.44 ]) {
            const result = setup.evaluate({ currentView: setup.view({ pitch }) })
            expect(result.facts).not.to.have.property('selectionMode')
            expectStandardBalancedCover(result, setup.policy.maximumMatrixLevel)
        }
    })

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

    it('keeps a wide top-down footprint symmetric and locally balanced', () => {

        const setup = fixture({
            minimumMatrixLevel: 10,
            coverageMaximumMatrixLevel: 10,
            maximumMatrixLevel: 14,
            maximumPatches: 512,
        })
        const halfColumns = 5 / 2 ** 14
        const halfRows = 3 / 2 ** 14
        const result = setup.evaluate({
            currentView: setup.view({
                altitude: 8_850,
                zoom: 13.25,
                pitch: 0,
                referenceViewport: [ 1512, 864 ],
            }),
            visibleBounds: {
                west: 0.5 - halfColumns,
                east: 0.5 + halfColumns,
                north: 0.5 - halfRows,
                south: 0.5 + halfRows,
            },
        })
        const levels = new Set(result.patches.map(patch => patch.matrixLevel))

        expect(Math.max(...levels) - Math.min(...levels)).to.be.at.most(1)
        expect(result.patches.length).to.be.greaterThan(16)
        expectStandardBalancedCover(result, setup.policy.maximumMatrixLevel)
    })

    it('bounds anisotropic cells by maximum projected stretch rather than area', () => {

        const setup = fixture({ maximumPatches: 512 })
        const baseView = setup.view({ zoom: 10, pitch: 0 })
        const anisotropicMatrix = [ ...baseView.clipFromRelativeWorld ]
        for (const index of [ 0, 4, 8, 12 ]) anisotropicMatrix[index] *= 4
        for (const index of [ 1, 5, 9, 13 ]) anisotropicMatrix[index] *= 0.25
        const anisotropicView = createGeoViewSnapshot({
            id: 'cover-view-anisotropic',
            clipFromRelativeWorld: anisotropicMatrix,
            cameraHigh: baseView.cameraHigh,
            cameraLow: baseView.cameraLow,
            referenceViewport: baseView.referenceViewport,
            verticalFovRadians: baseView.verticalFovRadians,
            cameraLatitudeRadians: baseView.cameraLatitudeRadians,
            cameraPitchRadians: baseView.cameraPitchRadians,
            zoomHint: baseView.zoomHint,
            frameEpoch: baseView.frameEpoch,
            residencySnapshotEpoch: baseView.residencySnapshotEpoch,
        })
        const visibleBounds = {
            west: 0.498,
            north: 0.498,
            east: 0.502,
            south: 0.502,
        }
        const isotropic = setup.evaluate({ currentView: baseView, visibleBounds })
        const anisotropic = setup.evaluate({
            currentView: anisotropicView,
            visibleBounds,
        })

        expect(anisotropic.facts.maximumMatrixLevel).to.be.at.least(
            isotropic.facts.maximumMatrixLevel + 2
        )
        expect(anisotropic.facts.patchCount).to.be.greaterThan(isotropic.facts.patchCount)
        expectStandardBalancedCover(anisotropic, setup.policy.maximumMatrixLevel)
    })

    it('advances ordinary top-down geometry monotonically with map zoom', () => {

        const setup = fixture({ maximumPatches: 512 })
        let previousLevel = -1
        for (const zoom of [ 8, 9, 10, 11, 12, 13, 14 ]) {
            const result = setup.evaluate({
                currentView: setup.view({ zoom, pitch: 0 }),
            })

            expect(result.facts.minimumMatrixLevel).to.be.at.least(previousLevel)
            expect(result.facts.maximumMatrixLevel).to.be.at.least(previousLevel)
            expect(result.facts.maximumMatrixLevel).to.be.at.most(zoom)
            previousLevel = result.facts.minimumMatrixLevel
        }
    })

    it('uses complete immutable tile bounds instead of unrelated global extremes', () => {

        const globalSetup = fixture({
            coverageMaximumMatrixLevel: 2,
            maximumMatrixLevel: 4,
            verticalRangeMeters: [ 0, 10_000_000 ],
        })
        const hierarchySetup = fixture({
            coverageMaximumMatrixLevel: 2,
            maximumMatrixLevel: 4,
            verticalRangeMeters: [ 0, 10_000_000 ],
            verticalBounds: flatVerticalBounds(globalSetup),
        })
        const globalResult = globalSetup.evaluate({
            currentView: globalSetup.view({ zoom: 2, pitch: 0 }),
        })
        const hierarchyResult = hierarchySetup.evaluate({
            currentView: hierarchySetup.view({ zoom: 2, pitch: 0 }),
        })

        expect(globalResult.facts.verticalBoundsMode).to.equal('global')
        expect(hierarchyResult.facts).to.deep.include({
            verticalBoundsMode: 'hierarchy',
            verticalBoundCount: 21,
            minimumMatrixLevel: 2,
            maximumMatrixLevel: 2,
        })
        expect(globalResult.facts.maximumMatrixLevel).to.be.greaterThan(
            hierarchyResult.facts.maximumMatrixLevel
        )
    })

    it('preserves sparse parent decisions instead of filling their bounding rectangle', () => {

        const base = fixture({
            coverageMaximumMatrixLevel: 2,
            maximumMatrixLevel: 3,
            maximumPatches: 128,
            maximumCellSpanReferencePixels: 8,
        })
        const currentView = base.view({ zoom: 2, pitch: 0 })
        const altitude = currentView.cameraHigh[2] + currentView.cameraLow[2]
        const elevation = altitude * 0.8
        const elevated = [ [ 1, 1 ], [ 2, 2 ] ]
        const verticalBounds = base.spatialProfile.coverage.limits.flatMap(limit => {
            const matrixLevel = Number(limit.matrixId)
            return Array.from(
                { length: limit.maxTileRow - limit.minTileRow + 1 },
                (_, rowOffset) => Array.from(
                    { length: limit.maxTileCol - limit.minTileCol + 1 },
                    (_, colOffset) => {
                        const tileRow = limit.minTileRow + rowOffset
                        const tileCol = limit.minTileCol + colOffset
                        const descendants = elevated.filter(([ row, col ]) =>
                            row >> (2 - matrixLevel) === tileRow &&
                            col >> (2 - matrixLevel) === tileCol
                        )
                        const exact = matrixLevel === 2 && descendants.length > 0
                        return {
                            matrixLevel,
                            tileRow,
                            tileCol,
                            minimumVerticalMeters: exact ? elevation : 0,
                            maximumVerticalMeters: descendants.length > 0 ? elevation : 0,
                        }
                    }
                )
            ).flat()
        })
        const setup = fixture({
            coverageMaximumMatrixLevel: 2,
            maximumMatrixLevel: 3,
            maximumPatches: 128,
            maximumCellSpanReferencePixels: 8,
            verticalRangeMeters: [ 0, elevation ],
            verticalBounds,
        })
        const result = setup.evaluate({
            currentView: setup.view({ zoom: 2, pitch: 0 }),
            visibleBounds: { west: 0, north: 0, east: 1, south: 1 },
        })
        const refinedParents = new Set(result.patches
            .filter(patch => patch.matrixLevel === 3)
            .map(patch => `2/${patch.tileRow >> 1}/${patch.tileCol >> 1}`))
        const keys = new Set(result.patches.map(patch => patch.key))

        expect([ ...refinedParents ].sort()).to.deep.equal([
            '2/1/1',
            '2/2/2',
        ])
        expect(keys.has('2/1/2')).to.equal(true)
        expect(keys.has('2/2/1')).to.equal(true)
        expectStandardBalancedCover(result, setup.policy.maximumMatrixLevel)
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
            [ 0.498, 0.498 ],
            [ 0.5, 0.5 ],
            [ 0.502, 0.498 ],
            [ 0.498, 0.502 ],
            [ 0.502, 0.502 ],
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

})

describe('GPU WebMercatorQuad inverse cover lowering', () => {

    it('publishes a bounded full-identity read-side lookup and stitching module', () => {

        const module = gpuWebMercatorQuadCoverReadWgslModule({
            namespace: 'TerrainCover',
            group: 1,
            patchesBinding: 2,
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

    it('decodes bounded geometry-cut feedback without source or draw facts', () => {

        const state = new Uint32Array([
            42,
            88,
            24,
            0,
            0,
            8,
            11,
            1,
            11,
            2 * 256,
            15 * 128,
        ])

        const decoded = decodeGpuWebMercatorQuadCoverFeedback(
            new Uint8Array(state.buffer),
            {
                expectedFrameEpoch: 42,
                maximumPatches: 64,
            }
        )

        expect(decoded).to.deep.equal({
            frameEpoch: 42,
            candidateCount: 88,
            patchCount: 24,
            descriptorOverflowCount: 0,
            lookupOverflowCount: 0,
            minimumMatrixLevel: 8,
            maximumMatrixLevel: 11,
            maximumAdjacentLevelDelta: 1,
            finestMatrixLevel: 11,
            minimumCellSpanReferencePixels: 2,
            maximumCellSpanReferencePixels: 7.5,
        })
    })

    it('owns one stable double-parity compute graph without raster residency authority', async() => {

        const setup = fixture({
            minimumMatrixLevel: 0,
            coverageMaximumMatrixLevel: 10,
            maximumMatrixLevel: 14,
            maximumPatches: 64,
        })
        const fake = createFakeGpu()
        const runtime = await GPURuntime.create({ gpu: fake.gpu })
        const cover = await GpuWebMercatorQuadCover.create(runtime, {
            spatialProfile: setup.spatialProfile,
            policy: setup.policy,
            verticalRangeMeters: [ -120, 30 ],
        })

        expect(cover.facts()).to.deep.include({
            selectionPath: 'gpu-camera-inverse-webmercatorquad-cover',
            lookupCapacity: 128,
            coverageLimitCount: 11,
        })
        expect(cover.facts().parity).to.have.length(2)
        expect(cover.facts().parity.every(parity =>
            parity.commandIds.length === 2
        )).to.equal(true)
        expect(cover.facts().parity.every(parity =>
            !('demandBufferId' in parity) && !('drawArgumentBufferId' in parity)
        )).to.equal(true)
        const templates = cover.templates()
        expect(templates.map(template => template.coverId)).to.deep.equal([
            cover.id,
            cover.id,
        ])
        expect(templates.map(template => template.parity)).to.deep.equal([ 0, 1 ])
        expect(templates.every(template =>
            template.patches !== undefined &&
            template.state !== undefined &&
            !('drawArgument' in template)
        )).to.equal(true)

        const view = setup.view({ zoom: 10, frameEpoch: 42 })
        const token = cover.writeView(view)
        const frame = cover.frame(token)
        const builder = runtime.submission()
        cover.initialize(builder)
        cover.encode(builder, frame)
        cover.capture(builder, frame)
        const submitted = builder.submit()
        expect(submitted.readbacks.map(link => link.commandId)).to.have.length(1)
        expect(fake.calls.dispatchCalls).to.have.length(1)

        token.dispose()
        cover.dispose()
        await runtime.dispose()
    })

    it('owns one complete immutable vertical hierarchy and rejects partial metadata', async() => {

        const base = fixture({
            coverageMaximumMatrixLevel: 2,
            maximumMatrixLevel: 4,
            maximumPatches: 64,
        })
        const verticalBounds = flatVerticalBounds(base)
        const fake = createFakeGpu()
        const runtime = await GPURuntime.create({ gpu: fake.gpu })
        const cover = await GpuWebMercatorQuadCover.create(runtime, {
            spatialProfile: base.spatialProfile,
            policy: base.policy,
            verticalRangeMeters: base.verticalRangeMeters,
            verticalBounds,
        })

        expect(cover.facts()).to.deep.include({
            verticalBoundsMode: 'hierarchy',
            verticalBoundCount: verticalBounds.length,
        })
        expect(cover.identityObjects().resources.some(resource =>
            resource.label === 'GPU WebMercatorQuad vertical bounds'
        )).to.equal(true)

        let partialFailure
        try {
            await GpuWebMercatorQuadCover.create(runtime, {
                spatialProfile: base.spatialProfile,
                policy: base.policy,
                verticalRangeMeters: base.verticalRangeMeters,
                verticalBounds: verticalBounds.slice(1),
            })
        } catch (error) {
            partialFailure = error
        }
        expect(partialFailure).to.be.instanceOf(Error)

        cover.dispose()
        await runtime.dispose()
    })
})
