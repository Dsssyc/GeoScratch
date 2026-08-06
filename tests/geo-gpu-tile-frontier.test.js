import { expect } from 'chai'
import {
    GeoDiagnosticError,
    WebMercatorQuad,
    gpuTileFrontierPolicy,
    tileMatrixCoverage,
    virtualRasterTileAddressSpace,
    webMercatorQuadAddressCodec,
} from 'geoscratch/geo'
import {
    evaluateGpuTileFrontierReference,
} from '../packages/geoscratch/dist/geo/gpu-tile-frontier-reference.js'
import {
    gpuTileFrontierLayouts,
} from '../packages/geoscratch/dist/geo/gpu-tile-frontier-layout.js'

const HALF_WORLD = 20_037_508.3427892
const SNAPSHOT_EPOCH = 7

function createFixture(options = {}) {

    const coverage = tileMatrixCoverage({
        tileMatrixSet: WebMercatorQuad,
        limits: [ 0, 1, 2, 3 ].map(matrixLevel => ({
            matrixId: String(matrixLevel),
            minTileRow: 0,
            maxTileRow: 2 ** matrixLevel - 1,
            minTileCol: 0,
            maxTileCol: 2 ** matrixLevel - 1,
        })),
    })
    const addressSpace = virtualRasterTileAddressSpace({
        id: 'frontier-fixture',
        coverage,
    })
    const addressCodec = webMercatorQuadAddressCodec({ coverage })
    const policy = gpuTileFrontierPolicy({
        refineErrorPixels: 2,
        coarsenErrorPixels: 1,
        minimumMatrixLevel: 0,
        maximumMatrixLevel: 3,
        maximumActiveTiles: options.maximumActiveTiles ?? 16,
        maximumDemands: options.maximumDemands ?? 16,
        transitionReservePages: options.transitionReservePages ?? 16,
        invisibleGraceFrames: 2,
    })
    const errorByLevel = options.errorByLevel ?? [ 100, 100, 100, 100 ]
    const levelMetrics = errorByLevel.map((geometricErrorMeters, matrixLevel) => ({
        matrixLevel,
        minimumElevationMeters: 0,
        maximumElevationMeters: 100,
        geometricErrorMeters,
    }))
    const descriptor = {
        gpuState: { addressSpace, maxPhysicalPages: 64 },
        addressCodec,
        policy,
        levelMetrics,
        roots: [ addressSpace.pageFromTile({ matrixId: '0', tileRow: 0, tileCol: 0 }) ],
        drawTemplates: [ { id: 'terrain', vertexCount: 6 } ],
    }
    const view = {
        clipFromRelativeWorld: [
            1 / HALF_WORLD, 0, 0, 0,
            0, 1 / HALF_WORLD, 0, 0,
            0, 0, 1 / 1_000_000, 0,
            0, 0, 0, 1,
        ],
        cameraHigh: [ 0, 0, 1_000_000 ],
        cameraLow: [ 0, 0, 0 ],
        viewport: [ 1024, 1024 ],
        verticalFovRadians: Math.PI / 2,
        cameraLatitudeRadians: 0,
        zoomHint: 2,
        frameEpoch: 10,
        residencySnapshotEpoch: SNAPSHOT_EPOCH,
    }

    function page(matrixLevel, tileRow, tileCol) {

        return addressSpace.pageFromTile({
            matrixId: String(matrixLevel),
            tileRow,
            tileCol,
        })
    }

    function entry(matrixLevel, tileRow, tileCol, extra = {}) {

        const identity = page(matrixLevel, tileRow, tileCol)
        return {
            page: identity,
            compactIndex: coverage.index(identity.tile),
            physicalSlot: coverage.index(identity.tile),
            generation: 1,
            contentEpoch: 1,
            residencySnapshotEpoch: SNAPSHOT_EPOCH,
            previousLodState: 'retain',
            lastVisibleFrame: 9,
            lastDemandFrame: 0,
            childDemandMask: 0,
            ...extra,
        }
    }

    function resident(matrixLevel, tileRow, tileCol, extra = {}) {

        const frontierEntry = entry(matrixLevel, tileRow, tileCol, extra)
        return {
            page: frontierEntry.page,
            compactIndex: frontierEntry.compactIndex,
            physicalSlot: frontierEntry.physicalSlot,
            generation: frontierEntry.generation,
            contentEpoch: frontierEntry.contentEpoch,
            residencySnapshotEpoch: frontierEntry.residencySnapshotEpoch,
        }
    }

    function evaluate(currentFrontier, residentPages, viewOverride = {}) {

        return evaluateGpuTileFrontierReference({
            descriptor,
            view: { ...view, ...viewOverride },
            currentFrontier,
            residentPages,
        })
    }

    return { coverage, descriptor, view, page, entry, resident, evaluate }
}

function keys(entries) {

    return entries.map(entry => entry.page.key)
}

describe('Geo GPU tile frontier contracts and reference oracle', () => {

    it('rejects invalid policies with structured selection diagnostics', () => {

        const invalidPolicy = {
            refineErrorPixels: 2,
            coarsenErrorPixels: 2,
            minimumMatrixLevel: 0,
            maximumMatrixLevel: 3,
            maximumActiveTiles: 16,
            maximumDemands: 8,
            transitionReservePages: 5,
            invisibleGraceFrames: 2,
        }

        expect(() => gpuTileFrontierPolicy(invalidPolicy)).to.throw(GeoDiagnosticError)

        try {
            gpuTileFrontierPolicy(invalidPolicy)
            expect.fail('invalid frontier policy should throw')
        } catch (error) {
            expect(error).to.be.instanceOf(GeoDiagnosticError)
            expect(error.diagnostic.code).to.equal('GEO_GPU_TILE_FRONTIER_INVALID')
            expect(error.diagnostic.phase).to.equal('selection')
        }
        expect(() => gpuTileFrontierPolicy()).to.throw(GeoDiagnosticError)

        const invalidValues = [
            { refineErrorPixels: Number.NaN },
            { coarsenErrorPixels: -1 },
            { minimumMatrixLevel: 4 },
            { maximumActiveTiles: 0 },
            { maximumDemands: 65 },
            { transitionReservePages: 0 },
            { invisibleGraceFrames: 0.5 },
        ]
        for (const changed of invalidValues) {
            expect(() => gpuTileFrontierPolicy({
                ...invalidPolicy,
                coarsenErrorPixels: 1,
                ...changed,
            })).to.throw(GeoDiagnosticError)
        }
    })

    it('exposes one LayoutCodec-derived source of byte sizes and offsets', () => {

        expect(gpuTileFrontierLayouts.mapMeta).to.deep.include({
            byteSize: 128,
            fieldOffsets: {
                clipFromRelativeWorld: 0,
                cameraHigh: 64,
                cameraLow: 80,
                viewport: 96,
                verticalFovRadians: 104,
                cameraLatitudeRadians: 108,
                zoomHint: 112,
                frameEpoch: 116,
                residencySnapshotEpoch: 120,
            },
        })
        expect(gpuTileFrontierLayouts.policy).to.deep.include({
            byteSize: 32,
            fieldOffsets: {
                refineErrorPixels: 0,
                coarsenErrorPixels: 4,
                minimumMatrixLevel: 8,
                maximumMatrixLevel: 12,
                maximumActiveTiles: 16,
                maximumDemands: 20,
                transitionReservePages: 24,
                invisibleGraceFrames: 28,
            },
        })
        expect(gpuTileFrontierLayouts.levelMetric.byteSize).to.equal(16)
        expect(gpuTileFrontierLayouts.frontierEntry.byteSize).to.equal(48)
        expect(gpuTileFrontierLayouts.visibleInstance.byteSize).to.equal(32)
        expect(gpuTileFrontierLayouts.demand.byteSize).to.equal(48)
        expect(gpuTileFrontierLayouts.diagnostics.byteSize).to.equal(80)
        for (const layout of Object.values(gpuTileFrontierLayouts)) {
            expect(layout.codec.artifact.byteLength).to.equal(layout.byteSize)
            expect(Object.fromEntries(layout.codec.artifact.fields.map(field => [
                field.name,
                field.offset,
            ]))).to.deep.equal(layout.fieldOffsets)
        }
    })

    it('rejects duplicate draw template ids through descriptor validation', () => {

        const fixture = createFixture()
        const duplicateDescriptor = {
            ...fixture.descriptor,
            drawTemplates: [
                { id: 'terrain', vertexCount: 6 },
                { id: 'terrain', vertexCount: 12 },
            ],
        }

        try {
            evaluateGpuTileFrontierReference({
                descriptor: duplicateDescriptor,
                view: fixture.view,
                currentFrontier: [],
                residentPages: [],
            })
            expect.fail('duplicate draw template ids should throw')
        } catch (error) {
            expect(error).to.be.instanceOf(GeoDiagnosticError)
            expect(error.diagnostic).to.deep.include({
                code: 'GEO_GPU_TILE_FRONTIER_INVALID',
                phase: 'selection',
            })
            expect(error.diagnostic.actual).to.deep.include({ drawTemplateId: 'terrain' })
        }
    })

    it('does not draw an off-frustum leaf', () => {

        const fixture = createFixture({ errorByLevel: [ 0.1, 0.1, 0.1, 0.1 ] })
        const leaf = fixture.entry(3, 0, 7)
        const result = fixture.evaluate([ leaf ], [ fixture.resident(3, 0, 7) ], {
            clipFromRelativeWorld: [
                1 / HALF_WORLD, 0, 0, 0,
                0, 1 / HALF_WORLD, 0, 0,
                0, 0, 1 / 1_000_000, 0,
                2, 0, 0, 1,
            ],
        })

        expect(keys(result.nextFrontier)).to.deep.equal([ leaf.page.key ])
        expect(result.visible).to.deep.equal([])
        expect(result.facts.visibleInstanceCount).to.equal(0)
    })

    it('retains a visible leaf below the refine threshold', () => {

        const fixture = createFixture({ errorByLevel: [ 0.1, 0.1, 0.1, 0.1 ] })
        const leaf = fixture.entry(3, 3, 3)
        const result = fixture.evaluate([ leaf ], [ fixture.resident(3, 3, 3) ])

        expect(keys(result.nextFrontier)).to.deep.equal([ leaf.page.key ])
        expect(keys(result.visible)).to.deep.equal([ leaf.page.key ])
        expect(result.demands).to.deep.equal([])
    })

    it('keeps a parent and emits canonical covered-child demands until all children exist', () => {

        const fixture = createFixture({ errorByLevel: [ 100, 100_000, 100, 100 ] })
        const parent = fixture.entry(1, 0, 0)
        const result = fixture.evaluate([ parent ], [ fixture.resident(1, 0, 0) ])
        const childKeys = [
            fixture.page(2, 0, 0).key,
            fixture.page(2, 0, 1).key,
            fixture.page(2, 1, 0).key,
            fixture.page(2, 1, 1).key,
        ]

        expect(keys(result.nextFrontier)).to.deep.equal([ parent.page.key ])
        expect(keys(result.visible)).to.deep.equal([ parent.page.key ])
        expect(result.demands.map(demand => demand.page.key)).to.deep.equal(childKeys)
        expect(result.demands.map(demand => demand.childMask)).to.deep.equal([ 1, 2, 4, 8 ])
        expect(result.facts).to.deep.include({
            refineCandidateCount: 1,
            demandCount: 4,
            fallbackCount: 1,
        })
    })

    it('replaces a parent only after all acknowledged children are resident', () => {

        const fixture = createFixture({ errorByLevel: [ 100, 100_000, 100, 100 ] })
        const parent = fixture.entry(1, 0, 0)
        const children = [
            fixture.resident(2, 0, 0),
            fixture.resident(2, 0, 1),
            fixture.resident(2, 1, 0),
            fixture.resident(2, 1, 1),
        ]
        const result = fixture.evaluate(
            [ parent ],
            [ fixture.resident(1, 0, 0), ...children ]
        )

        expect(keys(result.nextFrontier)).to.deep.equal(children.map(child => child.page.key))
        expect(keys(result.visible)).to.deep.equal(children.map(child => child.page.key))
        expect(result.demands).to.deep.equal([])
    })

    it('rejects a refine transition beside a cover two levels coarser than its children', () => {

        const fixture = createFixture({ errorByLevel: [ 0.1, 0.1, 100_000, 100 ] })
        const coarseNeighbor = fixture.entry(1, 0, 0)
        const parent = fixture.entry(2, 0, 2)
        const children = [
            fixture.resident(3, 0, 4),
            fixture.resident(3, 0, 5),
            fixture.resident(3, 1, 4),
            fixture.resident(3, 1, 5),
        ]
        const result = fixture.evaluate(
            [ coarseNeighbor, parent ],
            [
                fixture.resident(1, 0, 0),
                fixture.resident(2, 0, 2),
                ...children,
            ]
        )

        expect(keys(result.nextFrontier)).to.deep.equal([
            coarseNeighbor.page.key,
            parent.page.key,
        ])
        expect(result.facts.budgetLimitedCount).to.equal(0)
    })

    it('coarsens only a complete canonical sibling transaction', () => {

        const fixture = createFixture({ errorByLevel: [ 0.1, 0.1, 0.1, 0.1 ] })
        const siblings = [
            fixture.entry(2, 0, 0),
            fixture.entry(2, 0, 1),
            fixture.entry(2, 1, 0),
            fixture.entry(2, 1, 1),
        ]
        const residents = [
            fixture.resident(1, 0, 0),
            ...siblings.map(entry => fixture.resident(
                Number(entry.page.tile.matrixId),
                entry.page.tile.tileRow,
                entry.page.tile.tileCol
            )),
        ]

        const complete = fixture.evaluate(siblings, residents)
        expect(keys(complete.nextFrontier)).to.deep.equal([ fixture.page(1, 0, 0).key ])
        expect(complete.facts.coarsenCandidateCount).to.equal(1)

        const incomplete = fixture.evaluate(siblings.slice(0, 3), residents)
        expect(keys(incomplete.nextFrontier)).to.deep.equal(keys(siblings.slice(0, 3)))
        expect(incomplete.facts.coarsenCandidateCount).to.equal(0)
    })

    it('uses compact-index tie order and preserves complete cover under tight capacity', () => {

        const fixture = createFixture({
            maximumActiveTiles: 5,
            errorByLevel: [ 100, 100_000, 100, 100 ],
        })
        const first = fixture.entry(1, 0, 0)
        const second = fixture.entry(1, 0, 1)
        const firstChildren = [
            fixture.resident(2, 0, 0),
            fixture.resident(2, 0, 1),
            fixture.resident(2, 1, 0),
            fixture.resident(2, 1, 1),
        ]
        const secondChildren = [
            fixture.resident(2, 0, 2),
            fixture.resident(2, 0, 3),
            fixture.resident(2, 1, 2),
            fixture.resident(2, 1, 3),
        ]
        const result = fixture.evaluate(
            [ second, first ],
            [
                fixture.resident(1, 0, 0),
                fixture.resident(1, 0, 1),
                ...firstChildren,
                ...secondChildren,
            ]
        )

        expect(keys(result.nextFrontier)).to.deep.equal([
            ...firstChildren.map(child => child.page.key),
            second.page.key,
        ])
        expect(keys(result.visible)).to.deep.equal(keys(result.nextFrontier))
        expect(result.facts).to.deep.include({
            activeFrontierCount: 5,
            refineCandidateCount: 2,
            budgetLimitedCount: 1,
            convergenceState: 'budget-limited',
        })
    })
})
