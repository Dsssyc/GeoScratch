import { expect } from 'chai'
import {
    ViewDemandProducer,
    WebMercatorQuad,
    createGeoViewSnapshot,
    tileMatrixCoverage,
    virtualRasterDemandSetFromViewDemands,
    virtualRasterTileAddressSpace,
} from 'geoscratch/geo'
import {
    createFlowDemandCandidates,
    createFlowDemandCoordinator,
} from '../examples/flowField/flow-demand.ts'

const coverage = tileMatrixCoverage({
    tileMatrixSet: WebMercatorQuad,
    limits: [ {
        matrixId: '3',
        minTileRow: 0,
        maxTileRow: 7,
        minTileCol: 0,
        maxTileCol: 7,
    } ],
})

function addressSpace(id) {

    return virtualRasterTileAddressSpace({ id, coverage })
}

function viewAt(tileRow, tileCol, overrides = {}) {

    const bounds = WebMercatorQuad.tileBounds(WebMercatorQuad.tile({
        matrixId: '3',
        tileRow,
        tileCol,
    })).projected
    return createGeoViewSnapshot({
        id: 'flow-demand-view',
        clipFromRelativeWorld: [
            1, 0, 0, 0,
            0, 1, 0, 0,
            0, 0, 1, 0,
            0, 0, 0, 1,
        ],
        cameraHigh: [
            (bounds.west + bounds.east) / 2,
            (bounds.south + bounds.north) / 2,
            0,
        ],
        cameraLow: [ 0, 0, 0 ],
        referenceViewport: [ 1280, 720 ],
        verticalFovRadians: Math.PI / 3,
        cameraLatitudeRadians: 0,
        cameraPitchRadians: 0.5,
        zoomHint: 3,
        frameEpoch: 12,
        residencySnapshotEpoch: 7,
        ...overrides,
    })
}

function projected(view, overrides = {}) {

    return Object.freeze({
        desiredSampleLevel: 3,
        sourceLevelCeiling: 3,
        requestMatrixLevel: 3,
        tileRow: 4,
        tileCol: 0,
        priority: 1,
        decisionFrameEpoch: view.frameEpoch,
        residencySnapshotEpoch: view.residencySnapshotEpoch,
        ...overrides,
    })
}

function batch(view, demands) {

    return Object.freeze({
        kind: 'flow-projected-demand-batch',
        frameEpoch: view.frameEpoch,
        residencySnapshotEpoch: view.residencySnapshotEpoch,
        overflowCount: 0,
        demands: Object.freeze(demands),
    })
}

function candidateOptions(view, demands, overrides = {}) {

    return {
        view,
        batch: batch(view, demands),
        addressSpace: addressSpace('flow-candidates'),
        maximumDisplacementMeters: 0,
        maximumCandidatePages: 64,
        cellsPerPageEdge: 2,
        maximumCandidateCells: 256,
        ...overrides,
    }
}

function fakeRuntime(id, producerId, maxDemands = 64) {

    const reconciliations = []
    return {
        id,
        addressSpace: addressSpace(`flow-${id}`),
        viewDemandProducer: new ViewDemandProducer({ id: producerId, maxDemands }),
        reconcileViewDemands(demands) {

            reconciliations.push(demands)
            return Object.freeze({ id, demands })
        },
        reconciliations,
    }
}

function hooks(initialBatch) {

    const calls = []
    let activeBatch = initialBatch
    return {
        calls,
        setBatch(value) { activeBatch = value },
        cover: Object.freeze({
            encode(builder, view) {

                calls.push([ 'cover', builder, view ])
                return Object.freeze({ frameEpoch: view.frameEpoch })
            },
            async dispose() { calls.push([ 'dispose-cover' ]) },
        }),
        projection: Object.freeze({
            encode(builder, coverFrame, view) {

                calls.push([ 'projection', builder, coverFrame, view ])
                return activeBatch
            },
            async dispose() { calls.push([ 'dispose-projection' ]) },
        }),
    }
}

async function expectRejection(promise, pattern) {

    let failure
    try {
        await promise
    } catch (error) {
        failure = error
    }
    expect(failure).to.be.instanceOf(Error)
    expect(failure.message).to.match(pattern)
}

describe('Flow Field demand', () => {

    it('deduplicates deterministically and adds one filter-footprint page halo', () => {

        const view = viewAt(4, 0)
        const first = projected(view)
        const duplicate = projected(view, { priority: 999 })
        const forward = createFlowDemandCandidates(candidateOptions(view, [ first, duplicate ]))
        const reverse = createFlowDemandCandidates(candidateOptions(view, [ duplicate, first ]))
        const identity = result => result.candidatePages.map(page => [
            page.tile.matrixId,
            page.tile.tileRow,
            page.tile.tileCol,
        ])

        expect(identity(forward)).to.deep.equal(identity(reverse))
        expect(identity(forward)).to.deep.equal([
            [ '3', 3, 0 ], [ '3', 3, 1 ], [ '3', 3, 7 ],
            [ '3', 4, 0 ], [ '3', 4, 1 ], [ '3', 4, 7 ],
            [ '3', 5, 0 ], [ '3', 5, 1 ], [ '3', 5, 7 ],
        ])
        expect(forward.requestedLevel).to.equal(0)
        expect(forward.candidateCells).to.have.length(9 * 2 * 2)
        expect(new Set(forward.candidateCells.map(cell =>
            `${cell.page.key}/${cell.cellX}/${cell.cellY}`
        )).size).to.equal(forward.candidateCells.length)
    })

    it('adds a bounded displacement halo on top of the filter footprint', () => {

        const view = viewAt(4, 4)
        const pageWorldExtent = WebMercatorQuad.matrix('3').cellSize * 256
        const candidates = createFlowDemandCandidates(candidateOptions(
            view,
            [ projected(view, { tileCol: 4 }) ],
            {
                maximumDisplacementMeters: pageWorldExtent * 1.01,
                cellsPerPageEdge: 1,
                maximumCandidateCells: 64,
            }
        ))

        expect(candidates.candidatePages).to.have.length(49)
        expect(candidates.candidateCells).to.have.length(49)
    })

    it('fans one spatial set through three runtime-owned producers with wrapped priority', async () => {

        const view = viewAt(4, 7)
        const current = fakeRuntime('current', 'flow-current-demand')
        const next = fakeRuntime('next', 'flow-next-demand')
        const prefetch = fakeRuntime('prefetch', 'flow-prefetch-demand')
        const temporal = { current, next, prefetch }
        const projectionBatch = batch(view, [ projected(view) ])
        const graph = hooks(projectionBatch)
        const coordinator = createFlowDemandCoordinator({
            temporal,
            cover: graph.cover,
            projection: graph.projection,
            maximumDisplacementMeters: 0,
            maximumCandidatePages: 64,
            cellsPerPageEdge: 1,
            maximumCandidateCells: 64,
        })
        const builder = Object.freeze({ id: 'flow-builder' })
        const frame = coordinator.encode(builder, view)
        const reconciled = await coordinator.reconcile(frame)

        expect(graph.calls.slice(0, 2).map(call => call[0])).to.deep.equal([
            'cover',
            'projection',
        ])
        expect(frame.candidatePages).to.have.length(9)
        expect(reconciled).to.have.keys('current', 'next', 'prefetch')
        for (const runtime of [ current, next, prefetch ]) {
            expect(runtime.reconciliations).to.have.length(1)
            const [ demandSet ] = runtime.reconciliations
            expect(demandSet.demands).to.have.length(9)
            expect(new Set(demandSet.demands.map(demand => demand.source.producerId)))
                .to.deep.equal(new Set([ runtime.viewDemandProducer.id ]))
            expect(demandSet.demands[0].source).to.deep.include({
                viewId: view.id,
                frameEpoch: view.frameEpoch,
                residencySnapshotEpoch: view.residencySnapshotEpoch,
            })
            expect(demandSet.demands.every(demand =>
                demand.page.addressSpaceId === runtime.addressSpace.id
            )).to.equal(true)
        }

        const currentSet = current.reconciliations[0]
        const nextSet = next.reconciliations[0]
        const prefetchSet = prefetch.reconciliations[0]
        expect(currentSet.demands.every(demand => demand.intent === 'refinement')).to.equal(true)
        expect(nextSet.demands.every(demand => demand.intent === 'refinement')).to.equal(true)
        expect(prefetchSet.demands.every(demand => demand.intent === 'prefetch')).to.equal(true)
        expect(virtualRasterDemandSetFromViewDemands(currentSet).demands
            .every(demand => demand.usage === 'required')).to.equal(true)
        expect(virtualRasterDemandSetFromViewDemands(prefetchSet).demands
            .every(demand => demand.usage === 'prefetch')).to.equal(true)

        const visibleRow = currentSet.demands.filter(demand => demand.page.tile.tileRow === 4)
        const byColumn = new Map(visibleRow.map(demand => [
            demand.page.tile.tileCol,
            demand.priority.score,
        ]))
        expect(byColumn.get(7)).to.be.greaterThan(byColumn.get(1))

        await coordinator.dispose()
        expect(graph.calls.slice(-2).map(call => call[0])).to.deep.equal([
            'dispose-projection',
            'dispose-cover',
        ])
    })

    it('rejects capacity before producer fan-out', () => {

        const view = viewAt(4, 0)
        const current = fakeRuntime('current-small', 'flow-current-small', 8)
        const next = fakeRuntime('next-small', 'flow-next-small', 8)
        const prefetch = fakeRuntime('prefetch-small', 'flow-prefetch-small', 8)
        const graph = hooks(batch(view, [ projected(view) ]))
        const coordinator = createFlowDemandCoordinator({
            temporal: { current, next, prefetch },
            cover: graph.cover,
            projection: graph.projection,
            maximumDisplacementMeters: 0,
            maximumCandidatePages: 64,
            cellsPerPageEdge: 1,
            maximumCandidateCells: 64,
        })

        expect(() => coordinator.encode({}, view)).to.throw(/capacity/i)
        expect(current.reconciliations).to.deep.equal([])
        expect(next.reconciliations).to.deep.equal([])
        expect(prefetch.reconciliations).to.deep.equal([])
    })

    it('rejects stale projection and temporal provenance', async () => {

        const view = viewAt(4, 0)
        expect(() => createFlowDemandCandidates(candidateOptions(view, [
            projected(view, { decisionFrameEpoch: view.frameEpoch - 1 }),
        ]))).to.throw(/frame provenance/i)
        expect(() => createFlowDemandCandidates(candidateOptions(view, [
            projected(view, { residencySnapshotEpoch: view.residencySnapshotEpoch - 1 }),
        ]))).to.throw(/residency provenance/i)

        let current = fakeRuntime('current-stale', 'flow-current-stale')
        const temporal = {
            get current() { return current },
            next: fakeRuntime('next-stale', 'flow-next-stale'),
            prefetch: fakeRuntime('prefetch-stale', 'flow-prefetch-stale'),
        }
        const graph = hooks(batch(view, [ projected(view) ]))
        const coordinator = createFlowDemandCoordinator({
            temporal,
            cover: graph.cover,
            projection: graph.projection,
            maximumDisplacementMeters: 0,
            maximumCandidatePages: 64,
            cellsPerPageEdge: 1,
            maximumCandidateCells: 64,
        })
        const staleFrame = coordinator.encode({}, view)
        current = fakeRuntime('replacement', 'flow-replacement')

        await expectRejection(
            coordinator.reconcile(staleFrame),
            /temporal provenance/i
        )
    })

    it('rejects reused runtime producer identities and superseded frames', async () => {

        const view = viewAt(4, 0)
        const sharedProducer = 'flow-shared-demand'
        const duplicateGraph = hooks(batch(view, [ projected(view) ]))
        const duplicateCoordinator = createFlowDemandCoordinator({
            temporal: {
                current: fakeRuntime('duplicate-current', sharedProducer),
                next: fakeRuntime('duplicate-next', sharedProducer),
                prefetch: fakeRuntime('duplicate-prefetch', 'flow-other-demand'),
            },
            cover: duplicateGraph.cover,
            projection: duplicateGraph.projection,
            maximumDisplacementMeters: 0,
            maximumCandidatePages: 64,
            cellsPerPageEdge: 1,
            maximumCandidateCells: 64,
        })
        expect(() => duplicateCoordinator.encode({}, view)).to.throw(/producer identities/i)

        const temporal = {
            current: fakeRuntime('latest-current', 'flow-latest-current'),
            next: fakeRuntime('latest-next', 'flow-latest-next'),
            prefetch: fakeRuntime('latest-prefetch', 'flow-latest-prefetch'),
        }
        const graph = hooks(batch(view, [ projected(view) ]))
        const coordinator = createFlowDemandCoordinator({
            temporal,
            cover: graph.cover,
            projection: graph.projection,
            maximumDisplacementMeters: 0,
            maximumCandidatePages: 64,
            cellsPerPageEdge: 1,
            maximumCandidateCells: 64,
        })
        const first = coordinator.encode({}, view)
        const secondView = viewAt(4, 0, { frameEpoch: view.frameEpoch + 1 })
        graph.setBatch(batch(secondView, [ projected(secondView) ]))
        coordinator.encode({}, secondView)

        await expectRejection(coordinator.reconcile(first), /superseded/i)
    })
})
