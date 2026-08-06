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
const U32_LIMIT = 0x1_0000_0000

function createFixture(options = {}) {

    const minimumMatrixLevel = options.minimumMatrixLevel ?? 0
    const maximumMatrixLevel = options.maximumMatrixLevel ?? 3
    const coverage = tileMatrixCoverage({
        tileMatrixSet: WebMercatorQuad,
        limits: Array.from(
            { length: maximumMatrixLevel - minimumMatrixLevel + 1 },
            (_, index) => minimumMatrixLevel + index
        ).map(matrixLevel => ({
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
        minimumMatrixLevel,
        maximumMatrixLevel,
        maximumActiveTiles: options.maximumActiveTiles ?? 16,
        maximumDemands: options.maximumDemands ?? 16,
        transitionReservePages: options.transitionReservePages ?? 16,
        invisibleGraceFrames: options.invisibleGraceFrames ?? 2,
    })
    const errorByLevel = options.errorByLevel ?? [ 100, 100, 100, 100 ]
    const levelMetrics = Array.from(
        { length: maximumMatrixLevel - minimumMatrixLevel + 1 },
        (_, index) => minimumMatrixLevel + index
    ).map(matrixLevel => ({
        matrixLevel,
        minimumElevationMeters: 0,
        maximumElevationMeters: 100,
        geometricErrorMeters: errorByLevel[matrixLevel] ?? 100,
    }))
    const minimumLimit = coverage.limit(String(minimumMatrixLevel))
    const roots = []
    for (let row = minimumLimit.minTileRow; row <= minimumLimit.maxTileRow; row++) {
        for (let col = minimumLimit.minTileCol; col <= minimumLimit.maxTileCol; col++) {
            roots.push(addressSpace.pageFromTile({
                matrixId: String(minimumMatrixLevel),
                tileRow: row,
                tileCol: col,
            }))
        }
    }
    const descriptor = {
        gpuState: { addressSpace, maxPhysicalPages: 64 },
        addressCodec,
        policy,
        levelMetrics,
        roots,
        drawTemplates: [ { id: 'terrain', vertexCount: 6 } ],
    }
    const view = {
        clipFromRelativeWorld: [
            1 / HALF_WORLD, 0, 0, 0,
            0, 1 / HALF_WORLD, 0, 0,
            0, 0, 1 / 1_000_000, 0,
            0, 0, 1, 1,
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

function expectFrontierInvalid(action) {

    try {
        action()
        expect.fail('invalid GPU tile frontier input should throw')
    } catch (error) {
        expect(error).to.be.instanceOf(GeoDiagnosticError)
        expect(error.diagnostic).to.deep.include({
            code: 'GEO_GPU_TILE_FRONTIER_INVALID',
            phase: 'selection',
        })
    }
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

    it('requires ordered metrics, complete canonical roots, and u32-packed values', () => {

        const fixture = createFixture()
        expectFrontierInvalid(() => evaluateGpuTileFrontierReference({
            descriptor: {
                ...fixture.descriptor,
                levelMetrics: [ ...fixture.descriptor.levelMetrics ].reverse(),
            },
            view: fixture.view,
            currentFrontier: [],
            residentPages: [],
        }))

        const multiRoot = createFixture({ minimumMatrixLevel: 1 })
        expect(multiRoot.descriptor.roots).to.have.length(4)
        expectFrontierInvalid(() => evaluateGpuTileFrontierReference({
            descriptor: {
                ...multiRoot.descriptor,
                roots: multiRoot.descriptor.roots.slice(0, 3),
            },
            view: multiRoot.view,
            currentFrontier: [],
            residentPages: [],
        }))

        expectFrontierInvalid(() => gpuTileFrontierPolicy({
            ...fixture.descriptor.policy,
            maximumActiveTiles: U32_LIMIT,
        }))
        expectFrontierInvalid(() => evaluateGpuTileFrontierReference({
            descriptor: {
                ...fixture.descriptor,
                drawTemplates: [ { id: 'terrain', vertexCount: U32_LIMIT } ],
            },
            view: fixture.view,
            currentFrontier: [],
            residentPages: [],
        }))
        expectFrontierInvalid(() => evaluateGpuTileFrontierReference({
            descriptor: fixture.descriptor,
            view: { ...fixture.view, frameEpoch: U32_LIMIT },
            currentFrontier: [],
            residentPages: [],
        }))
        const oversizedEntry = fixture.entry(3, 0, 0, { physicalSlot: U32_LIMIT })
        const oversizedResident = {
            ...fixture.resident(3, 0, 0),
            physicalSlot: U32_LIMIT,
        }
        expectFrontierInvalid(() => fixture.evaluate(
            [ oversizedEntry ],
            [ oversizedResident ]
        ))
    })

    it('does not draw an off-frustum leaf', () => {

        const fixture = createFixture({ errorByLevel: [ 0.1, 0.1, 0.1, 0.1 ] })
        const leaf = fixture.entry(3, 0, 7)
        const result = fixture.evaluate([ leaf ], [ fixture.resident(3, 0, 7) ], {
            clipFromRelativeWorld: [
                1 / HALF_WORLD, 0, 0, 0,
                0, 1 / HALF_WORLD, 0, 0,
                0, 0, 1 / 1_000_000, 0,
                2, 0, 1, 1,
            ],
        })

        expect(keys(result.nextFrontier)).to.deep.equal([ leaf.page.key ])
        expect(result.visible).to.deep.equal([])
        expect(result.facts.visibleInstanceCount).to.equal(0)
    })

    it('rejects terrain behind the WebGPU near clip plane', () => {

        const fixture = createFixture({ errorByLevel: [ 0.1, 0.1, 0.1, 0.1 ] })
        const leaf = fixture.entry(3, 3, 3)
        const result = fixture.evaluate([ leaf ], [ fixture.resident(3, 3, 3) ], {
            clipFromRelativeWorld: [
                1 / HALF_WORLD, 0, 0, 0,
                0, 1 / HALF_WORLD, 0, 0,
                0, 0, 1 / 1_000_000, 0,
                0, 0, 0, 1,
            ],
        })

        expect(keys(result.nextFrontier)).to.deep.equal([ leaf.page.key ])
        expect(result.visible).to.deep.equal([])
    })

    it('retains a complete intermediate sibling cover inside the hysteresis interval', () => {

        const fixture = createFixture({ errorByLevel: [ 100, 100, 3_000, 100 ] })
        const siblings = [
            fixture.entry(2, 0, 0),
            fixture.entry(2, 0, 1),
            fixture.entry(2, 1, 0),
            fixture.entry(2, 1, 1),
        ]
        const residents = [
            fixture.resident(1, 0, 0),
            ...siblings.map(entry => fixture.resident(
                2,
                entry.page.tile.tileRow,
                entry.page.tile.tileCol
            )),
        ]
        const result = fixture.evaluate(siblings, residents)

        expect(keys(result.nextFrontier)).to.deep.equal(keys(siblings))
        expect(keys(result.visible)).to.deep.equal(keys(siblings))
        expect(result.demands).to.deep.equal([])
        expect(result.facts).to.deep.include({
            refineCandidateCount: 0,
            coarsenCandidateCount: 0,
            convergenceState: 'converged',
        })
        expect(result.nextFrontier.every(entry => entry.lastVisibleFrame === 10)).to.equal(true)
    })

    it('protects invisible complete siblings through grace before coarsening', () => {

        const fixture = createFixture({ errorByLevel: [ 100, 100, 3_000, 100 ] })
        const siblings = [
            fixture.entry(2, 0, 0, { lastVisibleFrame: 0 }),
            fixture.entry(2, 0, 1, { lastVisibleFrame: 0 }),
            fixture.entry(2, 1, 0, { lastVisibleFrame: 0 }),
            fixture.entry(2, 1, 1, { lastVisibleFrame: 0 }),
        ]
        const residents = [
            fixture.resident(1, 0, 0),
            fixture.resident(2, 0, 0),
            fixture.resident(2, 0, 1),
            fixture.resident(2, 1, 0),
            fixture.resident(2, 1, 1),
        ]
        const visible = fixture.evaluate(siblings, residents)
        expect(visible.nextFrontier.every(entry => entry.lastVisibleFrame === 10)).to.equal(true)

        const offFrustum = {
            clipFromRelativeWorld: [
                1 / HALF_WORLD, 0, 0, 0,
                0, 1 / HALF_WORLD, 0, 0,
                0, 0, 1 / 1_000_000, 0,
                3, 0, 1, 1,
            ],
        }
        const protectedResult = fixture.evaluate(visible.nextFrontier, residents, {
            ...offFrustum,
            frameEpoch: 12,
        })
        expect(keys(protectedResult.nextFrontier)).to.deep.equal(keys(siblings))
        expect(protectedResult.visible).to.deep.equal([])
        expect(protectedResult.facts.coarsenCandidateCount).to.equal(0)

        const expiredResult = fixture.evaluate(protectedResult.nextFrontier, residents, {
            ...offFrustum,
            frameEpoch: 13,
        })
        expect(keys(expiredResult.nextFrontier)).to.deep.equal([
            fixture.page(1, 0, 0).key,
        ])
        expect(expiredResult.visible).to.deep.equal([])
        expect(expiredResult.facts.coarsenCandidateCount).to.equal(1)
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

    it('compacts demands by canonical parent and child order after priority selection', () => {

        const fixture = createFixture({ errorByLevel: [ 100, 100_000, 100, 100 ] })
        const lowerPriorityFirst = fixture.entry(1, 0, 0, { lastDemandFrame: 9 })
        const higherPrioritySecond = fixture.entry(1, 0, 1, { lastDemandFrame: 0 })
        const result = fixture.evaluate(
            [ higherPrioritySecond, lowerPriorityFirst ],
            [
                fixture.resident(1, 0, 0),
                fixture.resident(1, 0, 1),
            ]
        )
        const expectedDemands = [
            [ 2, 0, 0 ], [ 2, 0, 1 ], [ 2, 1, 0 ], [ 2, 1, 1 ],
            [ 2, 0, 2 ], [ 2, 0, 3 ], [ 2, 1, 2 ], [ 2, 1, 3 ],
        ].map(([ level, row, col ]) => fixture.page(level, row, col).key)

        expect(result.demands.map(demand => demand.page.key)).to.deep.equal(expectedDemands)
        expect(result.demands.slice(0, 4).every(demand =>
            demand.parent.key === lowerPriorityFirst.page.key
        )).to.equal(true)
        expect(result.demands.slice(4).every(demand =>
            demand.parent.key === higherPrioritySecond.page.key
        )).to.equal(true)
    })

    it('refines only the balancing neighbor when its children are already resident', () => {

        const fixture = createFixture({ errorByLevel: [ 0.1, 0.1, 100_000, 100 ] })
        const coarseNeighbor = fixture.entry(1, 0, 0)
        const parent = fixture.entry(2, 0, 2)
        const parentChildren = [
            fixture.resident(3, 0, 4),
            fixture.resident(3, 0, 5),
            fixture.resident(3, 1, 4),
            fixture.resident(3, 1, 5),
        ]
        const balancingChildren = [
            fixture.resident(2, 0, 0),
            fixture.resident(2, 0, 1),
            fixture.resident(2, 1, 0),
            fixture.resident(2, 1, 1),
        ]
        const result = fixture.evaluate(
            [ coarseNeighbor, parent ],
            [
                fixture.resident(1, 0, 0),
                fixture.resident(2, 0, 2),
                ...balancingChildren,
                ...parentChildren,
            ]
        )

        expect(keys(result.nextFrontier)).to.deep.equal([
            ...balancingChildren.map(child => child.page.key),
            parent.page.key,
        ])
        expect(result.demands).to.deep.equal([])
        expect(result.facts).to.deep.include({
            fallbackCount: 1,
            budgetLimitedCount: 0,
            convergenceState: 'transitioning',
        })
    })

    it('keeps blocked pressure and unrelated refine and demand transactions independent', () => {

        const fixture = createFixture({ errorByLevel: [ 0.1, 0.1, 100_000, 100 ] })
        const coarseNeighbor = fixture.entry(1, 0, 0)
        const blocked = fixture.entry(2, 0, 2)
        const unrelatedDemand = fixture.entry(2, 3, 0)
        const unrelatedRefine = fixture.entry(2, 3, 3)
        const blockedChildren = [
            fixture.resident(3, 0, 4),
            fixture.resident(3, 0, 5),
            fixture.resident(3, 1, 4),
            fixture.resident(3, 1, 5),
        ]
        const unrelatedChildren = [
            fixture.resident(3, 6, 6),
            fixture.resident(3, 6, 7),
            fixture.resident(3, 7, 6),
            fixture.resident(3, 7, 7),
        ]
        const result = fixture.evaluate(
            [ unrelatedRefine, blocked, coarseNeighbor, unrelatedDemand ],
            [
                fixture.resident(1, 0, 0),
                fixture.resident(2, 0, 2),
                fixture.resident(2, 3, 0),
                fixture.resident(2, 3, 3),
                ...blockedChildren,
                ...unrelatedChildren,
            ]
        )
        const balancingDemandKeys = [
            fixture.page(2, 0, 0).key,
            fixture.page(2, 0, 1).key,
            fixture.page(2, 1, 0).key,
            fixture.page(2, 1, 1).key,
        ]
        const unrelatedDemandKeys = [
            fixture.page(3, 6, 0).key,
            fixture.page(3, 6, 1).key,
            fixture.page(3, 7, 0).key,
            fixture.page(3, 7, 1).key,
        ]

        expect(keys(result.nextFrontier)).to.deep.equal([
            coarseNeighbor.page.key,
            blocked.page.key,
            unrelatedDemand.page.key,
            ...unrelatedChildren.map(child => child.page.key),
        ])
        expect(result.demands.map(demand => demand.page.key)).to.deep.equal([
            ...balancingDemandKeys,
            ...unrelatedDemandKeys,
        ])
        expect(result.facts).to.deep.include({
            refineCandidateCount: 4,
            demandCount: 8,
            fallbackCount: 3,
            budgetLimitedCount: 0,
            convergenceState: 'transitioning',
        })
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
