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
        residency,
        publication,
        gpuState,
        frontier,
        root,
        view,
    }
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
})
