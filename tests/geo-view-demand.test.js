import { expect } from 'chai'
import {
    GeoDiagnosticError,
    ViewDemandProducer,
    WebMercatorQuad,
    createGeoViewAdapter,
    createGeoViewSource,
    createGeoViewSnapshot,
    tileMatrixCoverage,
    virtualRasterDemandSetFromViewDemands,
    virtualRasterTileAddressSpace,
} from 'geoscratch/geo'

function view(overrides = {}) {

    return createGeoViewSnapshot({
        id: 'map-view',
        clipFromRelativeWorld: [
            1, 0, 0, 0,
            0, 1, 0, 0,
            0, 0, 1, 0,
            0, 0, 0, 1,
        ],
        cameraHigh: [ 1000, 2000, 100 ],
        cameraLow: [ 0.25, -0.5, 0.125 ],
        referenceViewport: [ 1280, 720 ],
        verticalFovRadians: Math.PI / 3,
        cameraLatitudeRadians: 0.5,
        cameraPitchRadians: 0.7,
        zoomHint: 10,
        frameEpoch: 9,
        residencySnapshotEpoch: 4,
        ...overrides,
    })
}

function pages() {

    const coverage = tileMatrixCoverage({
        tileMatrixSet: WebMercatorQuad,
        limits: [
            { matrixId: '1', minTileRow: 0, maxTileRow: 1, minTileCol: 0, maxTileCol: 1 },
        ],
    })
    const addressSpace = virtualRasterTileAddressSpace({ id: 'view-demand', coverage })
    return [
        addressSpace.pageFromTile({ matrixId: '1', tileRow: 0, tileCol: 0 }),
        addressSpace.pageFromTile({ matrixId: '1', tileRow: 0, tileCol: 1 }),
        addressSpace.pageFromTile({ matrixId: '1', tileRow: 1, tileCol: 0 }),
    ]
}

describe('Geo view snapshots and demand', () => {

    it('captures one immutable view and presentation size from a frozen source descriptor', () => {

        const size = { width: 640, height: 360 }
        const viewState = Object.freeze({ camera: 'primary' })
        const descriptor = {
            id: 'primary-view-source',
            capture: () => ({ view: viewState, presentationSize: size }),
        }
        const source = createGeoViewSource(descriptor)
        descriptor.capture = () => ({
            view: Object.freeze({ camera: 'mutated' }),
            presentationSize: { width: 1, height: 1 },
        })

        const captured = source.capture()
        size.width = 1

        expect(source).to.deep.include({
            kind: 'geo-view-source',
            id: 'primary-view-source',
        })
        expect(captured.view).to.equal(viewState)
        expect(captured.presentationSize).to.deep.equal({ width: 640, height: 360 })
        expect(Object.isFrozen(captured)).to.equal(true)
        expect(Object.isFrozen(captured.presentationSize)).to.equal(true)
    })

    it('rejects invalid source ids, captures, and surface sizes diagnostically', () => {

        expect(() => createGeoViewSource({
            id: '',
            capture: () => ({
                view: undefined,
                presentationSize: { width: 1, height: 1 },
            }),
        })).to.throw(GeoDiagnosticError)
        expect(() => createGeoViewSource({
            id: 'invalid-size',
            capture: () => ({
                view: undefined,
                presentationSize: { width: 10.5, height: 0 },
            }),
        }).capture()).to.throw(GeoDiagnosticError)
    })

    it('defensively snapshots mutable camera facts', () => {

        const matrix = [
            1, 0, 0, 0,
            0, 1, 0, 0,
            0, 0, 1, 0,
            0, 0, 0, 1,
        ]
        const cameraHigh = [ 1, 2, 3 ]
        const snapshot = view({ clipFromRelativeWorld: matrix, cameraHigh })
        matrix[0] = 99
        cameraHigh[0] = 99

        expect(snapshot.kind).to.equal('geo-view-snapshot')
        expect(snapshot.clipFromRelativeWorld[0]).to.equal(1)
        expect(snapshot.cameraHigh[0]).to.equal(1)
        expect(Object.isFrozen(snapshot)).to.equal(true)
        expect(Object.isFrozen(snapshot.clipFromRelativeWorld)).to.equal(true)
        expect(Object.isFrozen(snapshot.cameraHigh)).to.equal(true)
    })

    it('rejects non-finite or dimensionally invalid view facts with a Geo diagnostic', () => {

        expect(() => view({ referenceViewport: [ 1280, 0 ] })).to.throw(GeoDiagnosticError)
        expect(() => view({ verticalFovRadians: Math.PI })).to.throw(GeoDiagnosticError)
        expect(() => view({ clipFromRelativeWorld: [ 1, 2 ] })).to.throw(GeoDiagnosticError)
    })

    it('captures its adapter implementation and rejects forged view-shaped objects', () => {

        const descriptor = {
            id: 'captured-adapter',
            read: (_input, context) => view({
                id: 'original-view',
                frameEpoch: context.frameEpoch,
                residencySnapshotEpoch: context.residencySnapshotEpoch,
            }),
        }
        const adapter = createGeoViewAdapter(descriptor)
        descriptor.read = () => view({ id: 'mutated-view' })

        const context = { frameEpoch: 7, residencySnapshotEpoch: 3 }
        expect(adapter.read(undefined, context)).to.deep.include({
            id: 'original-view',
            frameEpoch: 7,
            residencySnapshotEpoch: 3,
        })
        expect(() => createGeoViewAdapter({
            id: 'forged-adapter',
            read: () => ({ kind: 'geo-view-snapshot' }),
        }).read(undefined, context)).to.throw(GeoDiagnosticError)
    })

    it('adds view provenance, deduplicates by priority, and applies a hard demand bound', () => {

        const [ first, second, third ] = pages()
        const producer = new ViewDemandProducer({ id: 'map-demand', maxDemands: 2 })
        const demandSet = producer.produce({
            view: view(),
            generation: 12,
            demands: [
                {
                    page: first,
                    priority: { class: 'user-visible', score: 10 },
                    intent: 'refinement',
                    reason: 'initial-refine',
                    desiredSampleLevel: 1,
                    sourceLevelCeiling: 1,
                },
                {
                    page: first,
                    priority: { class: 'critical', score: 1 },
                    intent: 'coverage',
                    reason: 'cover-hole',
                    desiredSampleLevel: 1,
                    sourceLevelCeiling: 1,
                },
                {
                    page: second,
                    priority: { class: 'background', score: 100 },
                    intent: 'prefetch',
                    reason: 'guard-band',
                    desiredSampleLevel: 1,
                    sourceLevelCeiling: 1,
                },
                {
                    page: third,
                    priority: { class: 'user-visible', score: 20 },
                    intent: 'refinement',
                    reason: 'higher-sse',
                    desiredSampleLevel: 1,
                    sourceLevelCeiling: 1,
                },
            ],
        })

        expect(demandSet.kind).to.equal('view-tile-demand-set')
        expect(demandSet.demands.map(demand => demand.page.key)).to.deep.equal([
            first.key,
            third.key,
        ])
        expect(demandSet.demands[0]).to.deep.include({
            generation: 12,
            intent: 'coverage',
            reason: 'cover-hole',
        })
        expect(demandSet.demands[0].source).to.deep.equal({
            kind: 'view',
            producerId: 'map-demand',
            viewId: 'map-view',
            frameEpoch: 9,
            residencySnapshotEpoch: 4,
        })
        expect(producer).not.to.have.any.keys('scheduler', 'worker', 'cache', 'runtime')
    })

    it('allows a zero dynamic budget when safety pages consume all physical slots', () => {

        const [ page ] = pages()
        const producer = new ViewDemandProducer({
            id: 'safety-only-demand',
            maxDemands: 0,
        })
        const demandSet = producer.produce({
            view: view(),
            generation: 14,
            demands: [ {
                page,
                priority: { class: 'user-visible', score: 1 },
                intent: 'refinement',
                reason: 'no-free-physical-slot',
                desiredSampleLevel: 1,
                sourceLevelCeiling: 1,
            } ],
        })

        expect(demandSet.demands).to.deep.equal([])
    })

    it('lowers view intent to Virtual Raster usage explicitly', () => {

        const [ required, prefetched ] = pages()
        const producer = new ViewDemandProducer({ id: 'map-demand', maxDemands: 4 })
        const viewDemands = producer.produce({
            view: view(),
            generation: 13,
            demands: [
                {
                    page: required,
                    priority: { class: 'critical', score: 1 },
                    intent: 'coverage',
                    reason: 'visible-cover',
                    desiredSampleLevel: 14,
                    sourceLevelCeiling: 10,
                },
                {
                    page: prefetched,
                    priority: { class: 'background', score: 1 },
                    intent: 'prefetch',
                    reason: 'view-guard-band',
                    desiredSampleLevel: 10,
                    sourceLevelCeiling: 10,
                },
            ],
        })
        const lowered = virtualRasterDemandSetFromViewDemands(viewDemands)

        expect(lowered.kind).to.equal('virtual-raster-demand-set')
        expect(lowered.demands.map(demand => demand.usage)).to.deep.equal([
            'required',
            'prefetch',
        ])
        expect(lowered.demands.map(demand => demand.reason)).to.deep.equal([
            'visible-cover',
            'view-guard-band',
        ])
        expect(viewDemands.demands[0]).to.deep.include({
            desiredSampleLevel: 14,
            sourceLevelCeiling: 10,
        })
        expect(lowered.demands[0]).not.to.have.any.keys(
            'desiredSampleLevel',
            'sourceLevelCeiling'
        )
    })
})
