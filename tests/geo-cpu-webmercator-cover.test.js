import { expect } from 'chai'
import { mat4 } from 'wgpu-matrix'
import {
    GeoDiagnosticError, WebMercatorQuad, WebMercatorQuadCover, WebMercatorQuadDemandProjection,
    createGeoViewSnapshot, tileMatrixCoverage, webMercatorPlanarTileSpatialProfile,
    webMercatorQuadAddressCodec,
} from 'geoscratch/geo'

function fixture({ bits = 52, maximumPatches = 512, maximumMatrixLevel = 14, maximumCandidates,
    minimumMatrixLevel = 0, limits, verticalRangeMeters = [0, 0] } = {}) {
    const coverage = tileMatrixCoverage({ tileMatrixSet: WebMercatorQuad,
        limits: limits ?? Array.from({ length: 11 }, (_, level) => ({ matrixId: String(level),
            minTileRow: 0, maxTileRow: 2 ** level - 1, minTileCol: 0, maxTileCol: 2 ** level - 1 })) })
    const spatialProfile = webMercatorPlanarTileSpatialProfile({
        addressCodec: webMercatorQuadAddressCodec({ coverage, coordinateBits: bits }),
    })
    const descriptor = { spatialProfile, verticalRangeMeters,
        policy: { minimumMatrixLevel, maximumMatrixLevel, maximumPatches, cellsPerPatchEdge: 128,
            maximumCellSpanReferencePixels: 5, refinementTolerance: .005 },
        ...(maximumCandidates === undefined ? {} : { maximumCandidates }) }
    return { coverage, descriptor, cover: new WebMercatorQuadCover(descriptor) }
}

function view({ frameEpoch = 1, residencySnapshotEpoch = 1, zoom = 10, pitch = 0,
    x = 0, y = 0, altitude = 40_075_016.6855784 / 2 ** zoom * 1.5,
    referenceViewport = [1280, 800], singular = false } = {}) {
    const matrix = mat4.perspective(Math.PI / 3, referenceViewport[0] / referenceViewport[1],
        1, altitude * 16, new Float64Array(16))
    mat4.rotateX(matrix, pitch * Math.PI / 180, matrix)
    if (singular) matrix.fill(0)
    const p = [x, y, altitude]
    return createGeoViewSnapshot({ id: `cpu-view-${frameEpoch}`, clipFromRelativeWorld: matrix,
        cameraHigh: p.map(Math.fround), cameraLow: p.map(v => v - Math.fround(v)),
        referenceViewport, verticalFovRadians: Math.PI / 3, cameraLatitudeRadians: 0,
        cameraPitchRadians: pitch * Math.PI / 180, zoomHint: zoom, frameEpoch, residencySnapshotEpoch })
}

function expectDiagnostic(run, code, reason) {
    let failure
    try { run() } catch (error) { failure = error }
    expect(failure).to.be.instanceOf(GeoDiagnosticError)
    expect(failure.diagnostic.code).to.equal(code)
    if (reason !== undefined) expect(failure.diagnostic.actual.reason).to.equal(reason)
}

function assertCut(selection) {
    expect(selection.facts.patchCount).to.equal(selection.patches.length)
    const identities = new Set(selection.patches.map(p => `${p.matrixLevel}/${p.tileRow}/${p.tileCol}`))
    expect(identities.size).to.equal(selection.patches.length)
    for (const p of selection.patches) {
        for (let parent = p.matrixLevel - 1; parent >= 0; parent--) {
            const d = 2 ** (p.matrixLevel - parent)
            expect(identities.has(`${parent}/${Math.floor(p.tileRow / d)}/${Math.floor(p.tileCol / d)}`)).to.equal(false)
        }
        const scale = 2 ** (24 - p.matrixLevel)
        const a = [p.tileCol * scale, p.tileRow * scale, (p.tileCol + 1) * scale, (p.tileRow + 1) * scale]
        for (const q of selection.patches) {
            const d = 2 ** (24 - q.matrixLevel)
            const b = [q.tileCol * d, q.tileRow * d, (q.tileCol + 1) * d, (q.tileRow + 1) * d]
            const vertical = (a[0] === b[2] || a[2] === b[0]) && Math.max(a[1], b[1]) < Math.min(a[3], b[3])
            const horizontal = (a[1] === b[3] || a[3] === b[1]) && Math.max(a[0], b[0]) < Math.min(a[2], b[2])
            if (vertical || horizontal) expect(Math.abs(p.matrixLevel - q.matrixLevel)).to.be.at.most(1)
        }
    }
}

describe('CPU WebMercatorQuad complete products', () => {
    for (const bits of [40, 52]) {
        it(`preserves ordered A-B-A identities and immutable earlier products at ${bits} bits`, () => {
            const { cover } = fixture({ bits })
            expect(cover.facts().coordinateBits).to.equal(bits)
            const a = cover.select(view())
            const frozen = JSON.stringify(a)
            const b = cover.select(view({ frameEpoch: 2, pitch: 70, zoom: 12, x: 15000, y: -5000 }))
            const returned = cover.select(view({ frameEpoch: 3, residencySnapshotEpoch: 99 }))
            expect(returned.patches).to.deep.equal(a.patches)
            expect(returned.id).not.to.equal(a.id)
            expect(returned.revision).to.equal(3)
            expect(returned.view.residencySnapshotEpoch).to.equal(99)
            expect(JSON.stringify(a)).to.equal(frozen)
            expect(Object.isFrozen(a.patches[0])).to.equal(true)
            assertCut(a)
            assertCut(b)
            cover.dispose()
            expect(cover.facts().workspaceBytes).to.equal(0)
            expect(a.patches.length).to.be.greaterThan(0)
            expectDiagnostic(() => cover.select(view()), 'GEO_WEB_MERCATOR_COVER_SELECTION_INVALID', 'disposed')
        })
    }

    it('rejects capacity and uncertified quality without returning a partial product', () => {
        const limited = fixture({ maximumPatches: 1 }).cover
        expectDiagnostic(() => limited.select(view()), 'GEO_WEB_MERCATOR_COVER_SELECTION_INVALID', 'descriptor-overflow')
        const singular = fixture({ maximumMatrixLevel: 0 }).cover
        expectDiagnostic(() => singular.select(view({ singular: true })), 'GEO_WEB_MERCATOR_COVER_SELECTION_INVALID', 'unbounded-quality')
        const recovered = singular.select(view())
        expect(recovered.facts.patchCount).to.equal(1)
        expect(recovered.facts.maximumCellSpanReferencePixels).to.be.greaterThan(5)
        limited.dispose()
        singular.dispose()
    })

    it('fails conservative candidate overflow instead of shrinking its search domain', () => {
        const { cover } = fixture({ maximumCandidates: 1 })
        expectDiagnostic(() => cover.select(view()), 'GEO_WEB_MERCATOR_COVER_CANDIDATE_CAPACITY_EXCEEDED')
        cover.dispose()
    })

    it('returns a legal empty cut outside a finite standard domain', () => {
        const { cover } = fixture({ minimumMatrixLevel: 22, maximumMatrixLevel: 24,
            limits: [{ matrixId: '22', minTileRow: 2_000_000, maxTileRow: 2_000_001,
                minTileCol: 3_000_000, maxTileCol: 3_000_001 }] })
        const empty = cover.select(view())
        expect(empty.patches).to.have.length(0)
        expect(empty.facts).not.to.have.property('minimumMatrixLevel')
        expect(empty.facts).not.to.have.property('maximumCellSpanReferencePixels')
        cover.dispose()
    })

    it('retains complete height hierarchy validation before any selection', () => {
        const setup = fixture()
        expectDiagnostic(() => new WebMercatorQuadCover({ ...setup.descriptor, verticalBounds: [] }),
            'GEO_WEB_MERCATOR_COVER_VERTICAL_BOUNDS_INVALID')
        setup.cover.dispose()
    })

    it('projects desired levels separately from source ceilings with exact original provenance', () => {
        const { cover, coverage } = fixture()
        const projector = new WebMercatorQuadDemandProjection({ cover, sourceCoverage: coverage, maximumDemands: 512 })
        const selection = cover.select(view({ zoom: 13, frameEpoch: 17, residencySnapshotEpoch: 9 }))
        const result = projector.project(selection)
        expect(result.selectionId).to.equal(selection.id)
        expect(result.selectionRevision).to.equal(selection.revision)
        expect(result.view).to.equal(selection.view)
        expect(result.demands.length).to.be.greaterThan(0)
        expect(new Set(result.demands.map(d => `${d.requestMatrixLevel}/${d.tileRow}/${d.tileCol}`)).size).to.equal(result.demands.length)
        expect(result.demands.some(d => d.desiredSampleLevel > d.sourceLevelCeiling)).to.equal(true)
        for (const demand of result.demands) {
            expect(demand.sourceLevelCeiling).to.equal(10)
            expect(demand.requestMatrixLevel).to.be.at.most(10)
            expect(demand.decisionFrameEpoch).to.equal(17)
            expect(demand.residencySnapshotEpoch).to.equal(9)
            expect(Object.isFrozen(demand)).to.equal(true)
        }
        cover.dispose()
        expect(projector.project(selection)).to.deep.equal(result)
        projector.dispose()
        expectDiagnostic(() => projector.project(selection), 'GEO_WEB_MERCATOR_DEMAND_PROJECTION_INVALID', 'disposed')
    })

    it('rejects foreign/forged products and demand overflow without a partial request set', () => {
        const { cover, coverage } = fixture()
        const other = fixture().cover
        const projector = new WebMercatorQuadDemandProjection({ cover, sourceCoverage: coverage, maximumDemands: 1 })
        const selection = cover.select(view())
        expectDiagnostic(() => projector.project({ ...selection }), 'GEO_WEB_MERCATOR_COVER_SELECTION_INVALID', 'foreign-selection')
        expectDiagnostic(() => projector.project(other.select(view())), 'GEO_WEB_MERCATOR_COVER_SELECTION_INVALID', 'foreign-selection')
        expectDiagnostic(() => projector.project(selection), 'GEO_WEB_MERCATOR_DEMAND_PROJECTION_INVALID', 'demand-capacity')
        projector.dispose()
        cover.dispose()
        other.dispose()
    })

    it('rejects unowned projector descriptors with a demand diagnostic', () => {
        const { cover, coverage } = fixture()
        for (const foreign of [undefined, {}, Object.create(WebMercatorQuadCover.prototype)]) {
            expectDiagnostic(() => new WebMercatorQuadDemandProjection({
                cover: foreign, sourceCoverage: coverage, maximumDemands: 1,
            }), 'GEO_WEB_MERCATOR_DEMAND_PROJECTION_INVALID', 'foreign-cover')
        }
        cover.dispose()
    })
})
