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

function addressSpace(id, selectedCoverage = coverage) {

    return virtualRasterTileAddressSpace({ id, coverage: selectedCoverage })
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

function fakeRuntime(id, producerId, maxDemands = 64, selectedCoverage = coverage) {

    const reconciliations = []
    return {
        id,
        addressSpace: addressSpace(`flow-${id}`, selectedCoverage),
        viewDemandProducer: new ViewDemandProducer({ id: producerId, maxDemands }),
        reconcileViewDemands(demands) {

            reconciliations.push(demands)
            return Object.freeze({
                id,
                requestedCount: demands.demands.length,
                retainedCount: 0,
                retiredCount: 0,
                settlement: Promise.resolve(Object.freeze({ id, settled: true })),
                demands,
            })
        },
        reconciliations,
    }
}

function sample(sampleKey, modelTime) {

    return Object.freeze({
        sampleKey,
        timeIndex: Number(sampleKey.slice(1)),
        modelTime,
        unit: 'hour',
        phase: 'test',
        sourceHash: '0123456789abcdef'.repeat(4),
    })
}

function readyCapture(lowerRuntime, upperRuntime, options = {}) {

    const lowerSample = sample(options.lowerSampleKey ?? 't00', 0)
    const upperSample = lowerRuntime === upperRuntime
        ? lowerSample
        : sample(options.upperSampleKey ?? 't01', 1)
    return Object.freeze({
        state: 'ready',
        requestedRevision: options.requestedRevision ?? 3,
        pairGeneration: options.pairGeneration ?? 2,
        selection: lowerRuntime === upperRuntime
            ? Object.freeze({ kind: 'exact', modelTime: 0, sample: lowerSample })
            : Object.freeze({
                kind: 'interpolated',
                modelTime: 0.5,
                lower: lowerSample,
                upper: upperSample,
                alpha: 0.5,
            }),
        alpha: lowerRuntime === upperRuntime ? 0 : 0.5,
        lower: Object.freeze({ sample: lowerSample, runtime: lowerRuntime }),
        upper: Object.freeze({ sample: upperSample, runtime: upperRuntime }),
        release() {},
    })
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

    it('fans one spatial set through two captured required runtimes with provenance', async () => {

        const view = viewAt(4, 7)
        const lower = fakeRuntime('lower', 'flow-lower-demand')
        const upper = fakeRuntime('upper', 'flow-upper-demand')
        const temporal = readyCapture(lower, upper)
        const projectionBatch = batch(view, [ projected(view) ])
        const graph = hooks(projectionBatch)
        const coordinator = createFlowDemandCoordinator({
            cover: graph.cover,
            projection: graph.projection,
            maximumDisplacementMeters: 0,
            maximumCandidatePages: 64,
            cellsPerPageEdge: 1,
            maximumCandidateCells: 64,
        })
        const builder = Object.freeze({ id: 'flow-builder' })
        const frame = coordinator.encode(builder, view, temporal)
        const reconciled = await coordinator.reconcile(frame)

        expect(graph.calls.slice(0, 2).map(call => call[0])).to.deep.equal([
            'cover',
            'projection',
        ])
        expect(frame.candidatePages).to.have.length(9)
        expect(frame).to.deep.include({
            requestedRevision: 3,
            pairGeneration: 2,
            sampleKeys: [ 't00', 't01' ],
        })
        expect(reconciled).to.deep.include({
            kind: 'flow-demand-reconciliations',
            generation: frame.generation,
            requestedRevision: 3,
            pairGeneration: 2,
        })
        expect(reconciled.members).to.have.length(2)
        expect(reconciled.members.map(member => member.roles)).to.deep.equal([
            [ 'lower' ], [ 'upper' ],
        ])
        for (const runtime of [ lower, upper ]) {
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

        const lowerSet = lower.reconciliations[0]
        const upperSet = upper.reconciliations[0]
        expect(lowerSet.demands.every(demand => demand.intent === 'refinement')).to.equal(true)
        expect(upperSet.demands.every(demand => demand.intent === 'refinement')).to.equal(true)
        expect(virtualRasterDemandSetFromViewDemands(lowerSet).demands
            .every(demand => demand.usage === 'required')).to.equal(true)

        const visibleRow = lowerSet.demands.filter(demand => demand.page.tile.tileRow === 4)
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

    it('produces and reconciles an exact same-runtime capture only once', async () => {

        const view = viewAt(4, 0)
        const runtime = fakeRuntime('exact', 'flow-exact-demand')
        const graph = hooks(batch(view, [ projected(view) ]))
        const coordinator = createFlowDemandCoordinator({
            cover: graph.cover,
            projection: graph.projection,
            maximumDisplacementMeters: 0,
            maximumCandidatePages: 64,
            cellsPerPageEdge: 1,
            maximumCandidateCells: 64,
        })
        const frame = coordinator.encode({}, view, readyCapture(runtime, runtime))
        const result = await coordinator.reconcile(frame)

        expect(frame.sampleKeys).to.deep.equal([ 't00' ])
        expect(result.members).to.have.length(1)
        expect(result.members[0]).to.deep.include({
            sampleKey: 't00',
            roles: [ 'lower', 'upper' ],
        })
        expect(runtime.reconciliations).to.have.length(1)
        expect(virtualRasterDemandSetFromViewDemands(runtime.reconciliations[0]).demands
            .every(demand => demand.usage === 'required')).to.equal(true)

        await coordinator.dispose()
    })

    it('returns fine settlement without awaiting it or controlling temporal readiness', async () => {

        const view = viewAt(4, 0)
        let settleFine
        const runtime = fakeRuntime('fine', 'flow-fine-demand')
        runtime.reconcileViewDemands = demands => Object.freeze({
            requestedCount: demands.demands.length,
            retainedCount: 0,
            retiredCount: 0,
            settlement: new Promise(resolve => { settleFine = resolve }),
        })
        const graph = hooks(batch(view, [ projected(view) ]))
        const coordinator = createFlowDemandCoordinator({
            cover: graph.cover,
            projection: graph.projection,
            maximumDisplacementMeters: 0,
            maximumCandidatePages: 64,
            cellsPerPageEdge: 1,
            maximumCandidateCells: 64,
        })

        const result = await coordinator.reconcile(coordinator.encode(
            {}, view, readyCapture(runtime, runtime)
        ))
        let fineSettled = false
        result.members[0].reconciliation.settlement.then(() => { fineSettled = true })
        await Promise.resolve()
        expect(fineSettled).to.equal(false)

        settleFine({ settled: true })
        await result.members[0].reconciliation.settlement
        expect(fineSettled).to.equal(true)
        await coordinator.dispose()
    })

    it('rejects capacity before producer fan-out', () => {

        const view = viewAt(4, 0)
        const lower = fakeRuntime('lower-small', 'flow-lower-small', 8)
        const upper = fakeRuntime('upper-small', 'flow-upper-small', 8)
        const graph = hooks(batch(view, [ projected(view) ]))
        const coordinator = createFlowDemandCoordinator({
            cover: graph.cover,
            projection: graph.projection,
            maximumDisplacementMeters: 0,
            maximumCandidatePages: 64,
            cellsPerPageEdge: 1,
            maximumCandidateCells: 64,
        })

        expect(() => coordinator.encode({}, view, readyCapture(lower, upper)))
            .to.throw(/capacity/i)
        expect(lower.reconciliations).to.deep.equal([])
        expect(upper.reconciliations).to.deep.equal([])
    })

    it('rejects incompatible captured coverage before demand fan-out', () => {

        const view = viewAt(4, 0)
        const otherCoverage = tileMatrixCoverage({
            tileMatrixSet: WebMercatorQuad,
            limits: coverage.limits,
        })
        const lower = fakeRuntime('coverage-lower', 'coverage-lower')
        const upper = fakeRuntime('coverage-upper', 'coverage-upper', 64, otherCoverage)
        const graph = hooks(batch(view, [ projected(view) ]))
        const coordinator = createFlowDemandCoordinator({
            cover: graph.cover,
            projection: graph.projection,
            maximumDisplacementMeters: 0,
            maximumCandidatePages: 64,
            cellsPerPageEdge: 1,
            maximumCandidateCells: 64,
        })

        expect(() => coordinator.encode({}, view, readyCapture(lower, upper)))
            .to.throw(/compatible/i)
        expect(graph.calls).to.deep.equal([])
        expect(lower.reconciliations).to.deep.equal([])
        expect(upper.reconciliations).to.deep.equal([])
    })

    it('rejects stale projection but reconciles its captured pair after a window switch', async () => {

        const view = viewAt(4, 0)
        expect(() => createFlowDemandCandidates(candidateOptions(view, [
            projected(view, { decisionFrameEpoch: view.frameEpoch - 1 }),
        ]))).to.throw(/frame provenance/i)
        expect(() => createFlowDemandCandidates(candidateOptions(view, [
            projected(view, { residencySnapshotEpoch: view.residencySnapshotEpoch - 1 }),
        ]))).to.throw(/residency provenance/i)

        const lower = fakeRuntime('captured-lower', 'flow-captured-lower')
        const upper = fakeRuntime('captured-upper', 'flow-captured-upper')
        let temporal = readyCapture(lower, upper)
        const graph = hooks(batch(view, [ projected(view) ]))
        const coordinator = createFlowDemandCoordinator({
            cover: graph.cover,
            projection: graph.projection,
            maximumDisplacementMeters: 0,
            maximumCandidatePages: 64,
            cellsPerPageEdge: 1,
            maximumCandidateCells: 64,
        })
        const capturedFrame = coordinator.encode({}, view, temporal)
        temporal = readyCapture(
            upper,
            fakeRuntime('replacement', 'flow-replacement'),
            { requestedRevision: 4, pairGeneration: 3, lowerSampleKey: 't01',
                upperSampleKey: 't02' }
        )

        const result = await coordinator.reconcile(capturedFrame)
        expect(result.members.map(member => member.sampleKey)).to.deep.equal([ 't00', 't01' ])
        expect(temporal.pairGeneration).to.equal(3)
        expect(lower.reconciliations).to.have.length(1)
        expect(upper.reconciliations).to.have.length(1)
    })

    it('rejects reused runtime producer identities and superseded frames', async () => {

        const view = viewAt(4, 0)
        const sharedProducer = 'flow-shared-demand'
        const duplicateLower = fakeRuntime('duplicate-lower', sharedProducer)
        const duplicateUpper = fakeRuntime('duplicate-upper', sharedProducer)
        const duplicateGraph = hooks(batch(view, [ projected(view) ]))
        const duplicateCoordinator = createFlowDemandCoordinator({
            cover: duplicateGraph.cover,
            projection: duplicateGraph.projection,
            maximumDisplacementMeters: 0,
            maximumCandidatePages: 64,
            cellsPerPageEdge: 1,
            maximumCandidateCells: 64,
        })
        expect(() => duplicateCoordinator.encode(
            {},
            view,
            readyCapture(duplicateLower, duplicateUpper)
        )).to.throw(/producer identities/i)
        expect(() => duplicateCoordinator.encode(
            {},
            view,
            readyCapture(duplicateLower, duplicateUpper, { upperSampleKey: 't00' })
        )).to.throw(/time selection/i)

        const temporal = readyCapture(
            fakeRuntime('latest-lower', 'flow-latest-lower'),
            fakeRuntime('latest-upper', 'flow-latest-upper')
        )
        const graph = hooks(batch(view, [ projected(view) ]))
        const coordinator = createFlowDemandCoordinator({
            cover: graph.cover,
            projection: graph.projection,
            maximumDisplacementMeters: 0,
            maximumCandidatePages: 64,
            cellsPerPageEdge: 1,
            maximumCandidateCells: 64,
        })
        const first = coordinator.encode({}, view, temporal)
        const secondView = viewAt(4, 0, { frameEpoch: view.frameEpoch + 1 })
        graph.setBatch(batch(secondView, [ projected(secondView) ]))
        coordinator.encode({}, secondView, temporal)

        await expectRejection(coordinator.reconcile(first), /superseded/i)
    })
})
