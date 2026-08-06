import { expect } from 'chai'
import { GPURuntime } from 'geoscratch/scratch'
import {
    GeoDiagnosticError,
    GpuTileFrontier,
    VirtualRasterGpuFeedbackRing,
    VirtualRasterResidency,
    WebMercatorQuad,
    createVirtualRasterGpuState,
    gpuTileFrontierPolicy,
    ownedVirtualRasterPagePayload,
    tileMatrixCoverage,
    virtualRasterPlane,
    virtualRasterTileAddressSpace,
    webMercatorQuadAddressCodec,
} from 'geoscratch/geo'
import {
    gpuTileFrontierDemandCodec,
    gpuTileFrontierDiagnosticsCodec,
    gpuTileFrontierEntryCodec,
} from '../packages/geoscratch/dist/geo/gpu-tile-frontier-layout.js'
import {
    gpuTileFrontierTestFrameAccess,
} from '../packages/geoscratch/dist/geo/gpu-tile-frontier.js'
import { createFakeGpu } from './scratch-test-utils.js'

const HALF_WORLD = 20_037_508.3427892

async function createFeedbackFixture() {

    const coverage = tileMatrixCoverage({
        tileMatrixSet: WebMercatorQuad,
        limits: [ 0, 1 ].map(matrixLevel => ({
            matrixId: String(matrixLevel),
            minTileRow: 0,
            maxTileRow: 2 ** matrixLevel - 1,
            minTileCol: 0,
            maxTileCol: 2 ** matrixLevel - 1,
        })),
    })
    const addressSpace = virtualRasterTileAddressSpace({
        id: 'feedback-fixture',
        coverage,
    })
    const plane = virtualRasterPlane({
        id: 'feedback-height',
        addressSpace,
        kind: 'scalar',
        channels: 1,
        sampleType: 'unorm8',
        gpuFormat: 'r8unorm',
    })
    const fake = createFakeGpu()
    const runtime = await GPURuntime.create({ gpu: fake.gpu })
    const residency = new VirtualRasterResidency({
        addressSpace,
        plane,
        maxPhysicalPages: 8,
        maxStagingBytes: addressSpace.pageSize[0] * addressSpace.pageSize[1],
    })
    const root = addressSpace.rootPage()
    residency.stage(ownedVirtualRasterPagePayload({
        page: root,
        width: addressSpace.pageSize[0],
        height: addressSpace.pageSize[1],
        channels: 1,
        data: new Uint8Array(addressSpace.pageSize[0] * addressSpace.pageSize[1]),
        contentVersion: 'feedback-root-v1',
    }), { generation: 1 })
    const publication = residency.publish()
    const gpuState = await createVirtualRasterGpuState(runtime, {
        addressSpace,
        plane,
        maxPhysicalPages: 8,
    })
    const update = gpuState.stage(publication)
    const publicationBuilder = runtime.createSubmission({ validation: 'throw' })
    for (const command of update.commands) publicationBuilder.upload(command)
    await gpuState.acknowledge(publication, publicationBuilder.submit())

    const frontier = await GpuTileFrontier.create(runtime, {
        gpuState,
        addressCodec: webMercatorQuadAddressCodec({ coverage }),
        policy: gpuTileFrontierPolicy({
            refineErrorPixels: 2,
            coarsenErrorPixels: 1,
            minimumMatrixLevel: 0,
            maximumMatrixLevel: 1,
            maximumActiveTiles: 4,
            maximumDemands: 4,
            transitionReservePages: 4,
            invisibleGraceFrames: 2,
        }),
        levelMetrics: [ 0, 1 ].map(matrixLevel => ({
            matrixLevel,
            minimumElevationMeters: 0,
            maximumElevationMeters: 100,
            geometricErrorMeters: 100 / 2 ** matrixLevel,
        })),
        roots: [ root ],
        drawTemplates: [ { id: 'terrain', vertexCount: 6 } ],
    })
    const seed = frontier.stageSeed(publication.snapshot)
    const seedBuilder = runtime.createSubmission({ validation: 'throw' })
    for (const command of seed.commands) {
        if (command.commandKind === 'clear') seedBuilder.clear(command)
        else seedBuilder.upload(command)
    }
    seedBuilder.submit()
    const view = frameEpoch => ({
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
        zoomHint: 1,
        frameEpoch,
        residencySnapshotEpoch: gpuState.facts().snapshotEpoch,
    })

    return {
        ...fake,
        runtime,
        coverage,
        addressSpace,
        plane,
        residency,
        publication,
        gpuState,
        frontier,
        root,
        view,
    }
}

async function acknowledgePage(fixture, page, contentVersion, generation = 2) {

    fixture.residency.stage(ownedVirtualRasterPagePayload({
        page,
        width: fixture.addressSpace.pageSize[0],
        height: fixture.addressSpace.pageSize[1],
        channels: 1,
        data: new Uint8Array(
            fixture.addressSpace.pageSize[0] * fixture.addressSpace.pageSize[1]
        ),
        contentVersion,
    }), { generation })
    const publication = fixture.residency.publish()
    const update = fixture.gpuState.stage(publication)
    const builder = fixture.runtime.createSubmission({ validation: 'throw' })
    for (const command of update.commands) builder.upload(command)
    await fixture.gpuState.acknowledge(publication, builder.submit())
    return publication
}

function packedFeedback(frame, options = {}) {

    const layout = frame.feedbackOutput.layout
    const demands = options.demands ?? []
    const retirements = options.retirements ?? []
    const bytes = new Uint8Array(layout.byteLength)
    if (demands.length > 0) {
        gpuTileFrontierDemandCodec.write(bytes, demands, {
            byteOffset: layout.demands.offset,
        })
    }
    if (retirements.length > 0) {
        gpuTileFrontierEntryCodec.write(bytes, retirements, {
            byteOffset: layout.retirements.offset,
        })
    }
    const counters = new Uint32Array(
        bytes.buffer,
        bytes.byteOffset + layout.counters.offset,
        layout.counters.byteLength / 4
    )
    counters[0] = options.activeFrontierCount ?? 1
    counters[1] = options.activeFrontierCount ?? 1
    counters[2] = options.visibleInstanceCount ?? 1
    counters[3] = options.refineCandidateCount ?? 0
    counters[4] = options.coarsenCandidateCount ?? 0
    counters[5] = options.demandCount ?? demands.length
    counters[6] = options.retirementCount ?? retirements.length
    counters[7] = options.staleGenerationCount ?? 0
    counters[8] = options.budgetLimitedCount ?? 0
    new DataView(counters.buffer, counters.byteOffset, counters.byteLength)
        .setFloat32(9 * 4, options.maximumObservedSse ?? 1, true)
    counters[10] = options.minimumSelectedMatrixLevel ?? 0
    counters[11] = options.maximumSelectedMatrixLevel ?? 0
    counters[12] = options.frontierOverflow ? 1 : 0
    counters[13] = options.demandOverflow ? 1 : 0
    counters[14] = options.visibleOverflow ? 1 : 0
    counters[15] = options.lookupDuplicateCount ?? 0
    counters[16] = options.balanceRejectedCount ?? 0
    counters[17] = frame.frameEpoch
    counters[18] = options.residencySnapshotEpoch ?? 0
    counters[19] = options.fallbackCount ?? 0
    counters[20] = options.acceptedRefineCount ?? 0
    counters[21] = options.acceptedCoarsenCount ?? 0
    gpuTileFrontierDiagnosticsCodec.write(bytes, {
        frameEpoch: frame.frameEpoch,
        residencySnapshotEpoch: options.residencySnapshotEpoch ?? 0,
        activeFrontierCount: counters[0],
        visibleInstanceCount: counters[2],
        refineCandidateCount: counters[3],
        coarsenCandidateCount: counters[4],
        demandCount: counters[5],
        fallbackCount: counters[19],
        staleGenerationCount: counters[7],
        budgetLimitedCount: counters[8],
        maximumObservedSse: options.maximumObservedSse ?? 1,
        minimumSelectedMatrixLevel: counters[10],
        maximumSelectedMatrixLevel: counters[11],
        frontierOverflow: counters[12],
        demandOverflow: counters[13],
        visibleOverflow: counters[14],
        convergenceState: options.convergenceState ?? 0,
        reserved0: counters[15],
        reserved1: counters[16],
        reserved2: counters[6],
    }, { byteOffset: layout.diagnostics.offset })
    return bytes
}

function issueFeedbackFrame(fixture, ring, frameEpoch, feedback = {}) {

    const token = fixture.frontier.writeView(fixture.view(frameEpoch))
    const frame = fixture.frontier.frame(token)
    const builder = fixture.frontier.encode(
        fixture.runtime.createSubmission({ validation: 'throw' }),
        frame
    )
    const access = gpuTileFrontierTestFrameAccess(fixture.frontier, frame)
    const upload = fixture.runtime.createUploadCommand({
        label: `Inject GPU feedback ${frameEpoch}`,
        target: access.feedbackOutput.region(),
        data: packedFeedback(frame, {
            residencySnapshotEpoch: fixture.gpuState.facts().snapshotEpoch,
            ...feedback,
        }),
    })
    builder.upload(upload)
    ring.encode(builder, frame)
    const submitted = builder.submit()
    upload.dispose()
    token.dispose()
    return { frame, submitted }
}

async function expectFeedbackError(action, code) {

    let failure
    try {
        await action()
    } catch (error) {
        failure = error
    }
    expect(failure).to.be.instanceOf(GeoDiagnosticError)
    expect(failure.diagnostic).to.deep.include({ code, phase: 'selection' })
    return failure.diagnostic
}

describe('Geo Virtual Raster GPU feedback ring', () => {

    it('owns exactly three fixed readback slots and follows frontier disposal', async() => {

        const fixture = await createFeedbackFixture()
        const bufferCountBeforeRing = fixture.calls.buffers.length
        const ring = await VirtualRasterGpuFeedbackRing.create(fixture.frontier)
        const facts = ring.facts()

        expect(facts).to.deep.include({
            frontierId: fixture.frontier.id,
            runtimeId: fixture.runtime.id,
            slotCount: 3,
            disposed: false,
        })
        expect(facts.slots).to.have.length(3)
        expect(new Set(facts.slots.map(slot => slot.commandId)).size).to.equal(3)
        expect(facts.slots.map(slot => slot.state)).to.deep.equal([
            'idle',
            'idle',
            'idle',
        ])
        expect(fixture.calls.buffers.length - bufferCountBeforeRing).to.equal(3)
        expect(ring).not.to.have.property('commands')
        expect(ring).not.to.have.property('feedbackRegion')

        fixture.frontier.dispose()
        expect(ring.facts().disposed).to.equal(true)
        expect(ring.facts().slots.map(slot => slot.state)).to.deep.equal([
            'disposed',
            'disposed',
            'disposed',
        ])
        expect(fixture.gpuState.slotTable.isDisposed).to.equal(false)

        fixture.gpuState.dispose()
        fixture.residency.dispose()
        fixture.runtime.dispose()
    })

    it('applies three-slot backpressure without blocking frontier submission', async() => {

        const fixture = await createFeedbackFixture()
        const ring = await VirtualRasterGpuFeedbackRing.create(fixture.frontier)
        const issued = []

        for (let frameEpoch = 0; frameEpoch < 3; frameEpoch++) {
            const token = fixture.frontier.writeView(fixture.view(frameEpoch))
            const frame = fixture.frontier.frame(token)
            const builder = fixture.frontier.encode(
                fixture.runtime.createSubmission({ validation: 'throw' }),
                frame
            )
            expect(ring.encode(builder, frame)).to.equal(builder)
            const submitted = builder.submit()
            token.dispose()
            issued.push({ frame, submitted })
        }

        expect(issued.map(({ submitted }) => submitted.readbacks.length))
            .to.deep.equal([ 1, 1, 1 ])
        expect(ring.facts().issuedCount).to.equal(3)
        expect(ring.facts().slots.map(slot => slot.state)).to.deep.equal([
            'submitted',
            'submitted',
            'submitted',
        ])

        const token = fixture.frontier.writeView(fixture.view(3))
        const frame = fixture.frontier.frame(token)
        const builder = fixture.frontier.encode(
            fixture.runtime.createSubmission({ validation: 'throw' }),
            frame
        )
        const stepCount = builder.steps.length
        let backpressure
        try {
            ring.encode(builder, frame)
        } catch (error) {
            backpressure = error
        }
        expect(backpressure).to.be.instanceOf(GeoDiagnosticError)
        expect(backpressure.diagnostic).to.deep.include({
            code: 'GEO_GPU_TILE_FEEDBACK_BACKPRESSURE',
            phase: 'selection',
        })
        expect(builder.steps).to.have.length(stepCount)
        const submittedWithoutFeedback = builder.submit()
        token.dispose()
        expect(submittedWithoutFeedback.readbacks).to.deep.equal([])

        fixture.frontier.dispose()
        fixture.gpuState.dispose()
        fixture.residency.dispose()
        fixture.runtime.dispose()
    })

    it('consumes only N-1 feedback exactly once without exposing mapped bytes', async() => {

        const fixture = await createFeedbackFixture()
        const ring = await VirtualRasterGpuFeedbackRing.create(fixture.frontier)
        const first = issueFeedbackFrame(fixture, ring, 0)

        await expectFeedbackError(
            () => ring.feedback(first.frame, first.submitted),
            'GEO_GPU_TILE_FEEDBACK_TOO_RECENT'
        )
        expect(ring.facts().slots[0].state).to.equal('submitted')

        issueFeedbackFrame(fixture, ring, 1)
        const feedback = await ring.feedback(first.frame, first.submitted)
        expect(feedback).to.deep.include({
            kind: 'virtual-raster-gpu-feedback-batch',
            ringId: ring.id,
            frontierId: fixture.frontier.id,
            submissionId: first.submitted.id,
            frameEpoch: 0,
            residencySnapshotEpoch: fixture.gpuState.facts().snapshotEpoch,
        })
        expect(feedback.demands).to.deep.equal([])
        expect(feedback.retirements).to.deep.equal([])
        expect(feedback.facts).to.deep.include({
            frameEpoch: 0,
            activeFrontierCount: 1,
            visibleInstanceCount: 1,
            convergenceState: 'converged',
        })
        expect(feedback).not.to.have.property('bytes')
        expect(feedback).not.to.have.property('mapped')
        expect(Object.isFrozen(feedback)).to.equal(true)
        expect(Object.isFrozen(feedback.facts)).to.equal(true)
        expect(ring.facts().slots[0].state).to.equal('idle')

        await expectFeedbackError(
            () => ring.feedback(first.frame, first.submitted),
            'GEO_GPU_TILE_FEEDBACK_CONSUMED'
        )

        fixture.frontier.dispose()
        fixture.gpuState.dispose()
        fixture.residency.dispose()
        fixture.runtime.dispose()
    })

    it('deduplicates canonical demands and drops generation-stale retirements', async() => {

        const fixture = await createFeedbackFixture()
        const ring = await VirtualRasterGpuFeedbackRing.create(fixture.frontier)
        const snapshotEpoch = fixture.gpuState.facts().snapshotEpoch
        const rootEntry = fixture.publication.snapshot.resolve(fixture.root)
        const child = fixture.addressSpace.pageFromTile({
            matrixId: '1',
            tileRow: 0,
            tileCol: 0,
        })
        const demand = priority => ({
            samplingLevel: child.level,
            matrixLevel: 1,
            tileRow: 0,
            tileCol: 0,
            compactIndex: fixture.coverage.index(child.tile),
            parentCompactIndex: fixture.coverage.index(fixture.root.tile),
            parentPhysicalSlot: rootEntry.physicalSlot,
            parentGeneration: rootEntry.generation,
            priority,
            decisionFrameEpoch: 0,
            residencySnapshotEpoch: snapshotEpoch,
            childMask: 1,
        })
        const retirement = {
            physicalSlot: rootEntry.physicalSlot,
            expectedGeneration: rootEntry.generation,
            expectedContentEpoch: rootEntry.contentEpoch,
            samplingLevel: fixture.root.level,
            matrixLevel: 0,
            tileRow: 0,
            tileCol: 0,
            compactIndex: fixture.coverage.index(fixture.root.tile),
            previousLodState: 0,
            transitionState: 0,
            lastDemandEpoch: 0,
            childDemandMask: 0,
            residencySnapshotEpoch: snapshotEpoch,
        }
        const first = issueFeedbackFrame(fixture, ring, 0, {
            demands: [ demand(3), demand(11) ],
            retirements: [
                retirement,
                { ...retirement, expectedGeneration: retirement.expectedGeneration + 1 },
            ],
        })
        issueFeedbackFrame(fixture, ring, 1)

        const feedback = await ring.feedback(first.frame, first.submitted)
        expect(feedback.demands).to.have.length(1)
        expect(feedback.demands[0]).to.deep.include({
            page: child,
            parent: fixture.root,
            priority: 11,
            decisionFrameEpoch: 0,
            residencySnapshotEpoch: snapshotEpoch,
        })
        expect(feedback.retirements).to.have.length(1)
        expect(feedback.retirements[0]).to.deep.include({
            page: fixture.root,
            physicalSlot: rootEntry.physicalSlot,
            generation: rootEntry.generation,
            contentEpoch: rootEntry.contentEpoch,
            decisionFrameEpoch: 0,
            residencySnapshotEpoch: snapshotEpoch,
        })
        expect(feedback.counters).to.deep.include({
            demandCount: 2,
            retirementCount: 2,
            discardedStaleRetirementCount: 1,
        })
        expect(feedback.diagnostics.map(diagnostic => diagnostic.code))
            .to.include('GEO_GPU_TILE_FEEDBACK_STALE_RETIREMENT')
        expect(Object.isFrozen(feedback.demands)).to.equal(true)
        expect(Object.isFrozen(feedback.retirements)).to.equal(true)

        fixture.frontier.dispose()
        fixture.gpuState.dispose()
        fixture.residency.dispose()
        fixture.runtime.dispose()
    })

    it('fails closed on capacity overflow after releasing the readback slot', async() => {

        const fixture = await createFeedbackFixture()
        const ring = await VirtualRasterGpuFeedbackRing.create(fixture.frontier)
        const first = issueFeedbackFrame(fixture, ring, 0, { demandOverflow: true })
        issueFeedbackFrame(fixture, ring, 1)

        await expectFeedbackError(
            () => ring.feedback(first.frame, first.submitted),
            'GEO_GPU_TILE_DEMAND_CAPACITY_EXCEEDED'
        )
        expect(ring.facts().slots[0].state).to.equal('idle')

        fixture.frontier.dispose()
        fixture.gpuState.dispose()
        fixture.residency.dispose()
        fixture.runtime.dispose()
    })

    it('consumes and rejects feedback after residency authority advances', async() => {

        const fixture = await createFeedbackFixture()
        const ring = await VirtualRasterGpuFeedbackRing.create(fixture.frontier)
        const first = issueFeedbackFrame(fixture, ring, 0)
        issueFeedbackFrame(fixture, ring, 1)
        const child = fixture.addressSpace.pageFromTile({
            matrixId: '1',
            tileRow: 0,
            tileCol: 0,
        })
        await acknowledgePage(fixture, child, 'feedback-child-v1')

        await expectFeedbackError(
            () => ring.feedback(first.frame, first.submitted),
            'GEO_GPU_TILE_FEEDBACK_STALE'
        )
        expect(ring.facts().slots[0].state).to.equal('idle')

        fixture.frontier.dispose()
        fixture.gpuState.dispose()
        fixture.residency.dispose()
        fixture.runtime.dispose()
    })
})
