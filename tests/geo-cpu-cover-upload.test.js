import { expect } from 'chai'
import { mat4 } from 'wgpu-matrix'
import { GPURuntime, ScratchDiagnosticError, SubmittedWork } from 'geoscratch/scratch'
import { WebMercatorQuadCover, WebMercatorQuadCoverUpload, WebMercatorQuad,
    createGeoViewSnapshot, tileMatrixCoverage, webMercatorPlanarTileSpatialProfile,
    webMercatorQuadAddressCodec, GeoDiagnosticError } from 'geoscratch/geo'
import { createFakeGpu } from './scratch-test-utils.js'

function makeCover() {
    const coverage = tileMatrixCoverage({ tileMatrixSet: WebMercatorQuad, limits: [
        { matrixId: '0', minTileRow: 0, maxTileRow: 0, minTileCol: 0, maxTileCol: 0 },
    ] })
    return new WebMercatorQuadCover({
        spatialProfile: webMercatorPlanarTileSpatialProfile({ addressCodec: webMercatorQuadAddressCodec({ coverage }) }),
        policy: { minimumMatrixLevel: 0, maximumMatrixLevel: 0, maximumPatches: 8,
            cellsPerPatchEdge: 128, maximumCellSpanReferencePixels: 5, refinementTolerance: .005 },
        verticalRangeMeters: [0, 0],
    })
}

function view(frameEpoch = 1) {
    return createGeoViewSnapshot({ id: `upload-view-${frameEpoch}`,
        clipFromRelativeWorld: mat4.perspective(Math.PI / 3, 1, 1, 1e9, new Float64Array(16)),
        cameraHigh: [0, 0, 1e8], cameraLow: [0, 0, 0], referenceViewport: [64, 64],
        verticalFovRadians: Math.PI / 3, cameraLatitudeRadians: 0, cameraPitchRadians: 0,
        zoomHint: 0, frameEpoch, residencySnapshotEpoch: frameEpoch + 2 })
}

async function fixture() {
    const fake = createFakeGpu(), runtime = await GPURuntime.create({ gpu: fake.gpu }), cover = makeCover()
    const upload = await WebMercatorQuadCoverUpload.create(runtime, { cover })
    return { fake, runtime, cover, upload, dispose() { upload.dispose(); cover.dispose(); runtime.dispose() } }
}

function invalid(run, reason) {
    let error
    try { run() } catch (cause) { error = cause }
    expect(error).to.be.instanceOf(GeoDiagnosticError)
    expect(error.diagnostic.code).to.equal('GEO_WEB_MERCATOR_COVER_UPLOAD_INVALID')
    expect(error.diagnostic.actual.reason).to.equal(reason)
}

describe('CPU cover GPU upload ownership', () => {
    it('snapshots private bytes, alternates parity and receipts actual producer epochs without native-ready claims', async () => {
        const f = await fixture()
        const works = [], receipts = [], initial = f.cover.select(view())
        for (let epoch = 1; epoch <= 3; epoch++) {
            const selection = epoch === 1 ? initial : f.cover.select(view(epoch))
            const frame = f.upload.prepare(selection)
            // Reusing CPU workspace cannot alter this prepared upload.
            f.cover.select(view(epoch + 20))
            const builder = f.runtime.createSubmission()
            f.upload.encode(builder, frame)
            expect(builder.steps.map(step => step.kind)).to.deep.equal(['opaque', 'opaque', 'opaque'])
            expect(builder.steps.every(step => !('command' in step))).to.equal(true)
            const work = builder.submit()
            works.push(work)
            // A closed builder is not the authority for already submitted facts.
            builder.steps.length = 0
            builder.isSubmitted = false
            const receipt = f.upload.receipt(frame, work)
            receipts.push(receipt)
            expect(frame.isDisposed).to.equal(true)
            expect(f.upload.receipt(frame, work)).to.equal(receipt)
            expect(receipt.frameEpoch).to.equal(epoch)
            expect(receipt.selectionId).to.equal(selection.id)
            expect(receipt.resources).to.have.length(3)
            expect(receipt).not.to.have.property('nativeStatus')
            const bytes = f.upload.templates()[frame.parity].mapMeta.gpuBuffer.data
            expect(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(124, true)).to.equal(epoch)
            expect(f.upload.facts().preparedFrameCount).to.equal(0)
        }
        expect(receipts.map(r => r.parity)).to.deep.equal([0, 1, 0])
        expect(receipts.map(r => r.resources[0].contentEpoch)).to.deep.equal([1, 1, 2])
        await Promise.all(works.map(work => work.done))
        f.dispose()
        expect(f.upload.facts().persistentBufferBytes).to.equal(0)
        expect(Object.isFrozen(receipts[0].resources[0])).to.equal(true)
        expect(f.runtime.diagnostics.snapshot().resources).to.have.length(0)
    })

    it('rejects superseded, forged and duplicate attempts before queue effects and permits a fresh retry', async () => {
        const f = await fixture(), selection = f.cover.select(view())
        const old = f.upload.prepare(selection), abandoned = f.runtime.createSubmission()
        f.upload.encode(abandoned, old)
        const next = f.upload.prepare(selection)
        expect(old.isDisposed).to.equal(true)
        expect(() => abandoned.submit()).to.throw(ScratchDiagnosticError)
        expect(f.fake.calls.queueTimeline).to.have.length(0)
        invalid(() => f.upload.encode(f.runtime.createSubmission(), { ...next }), 'foreign-frame')
        const builder = f.runtime.createSubmission()
        f.upload.encode(builder, next)
        invalid(() => f.upload.encode(builder, next), 'stale-or-encoded-frame')
        builder.steps.pop()
        expect(() => builder.submit()).to.throw(ScratchDiagnosticError)
        next.dispose()
        const retry = f.upload.prepare(selection), valid = f.runtime.createSubmission()
        f.upload.encode(valid, retry)
        const work = valid.submit()
        f.upload.receipt(retry, work)
        await work.done
        f.dispose()
    })

    it('poisons queued work with intervening geometry writes instead of accepting an incomplete receipt', async () => {
        const f = await fixture(), selection = f.cover.select(view()), frame = f.upload.prepare(selection)
        const builder = f.runtime.createSubmission()
        f.upload.encode(builder, frame)
        const foreign = f.runtime.createUploadCommand({ target: f.upload.templates()[frame.parity].patches.region({ size: 12 }), data: new Uint32Array([9, 9, 9]) })
        builder.upload(foreign)
        const work = builder.submit()
        invalid(() => f.upload.prepare(selection), 'pending-receipt')
        invalid(() => f.upload.receipt(frame, work), 'receipt-mismatch')
        expect(f.upload.facts().poisoned).to.equal(true)
        invalid(() => f.upload.prepare(selection), 'poisoned')
        await work.done
        foreign.dispose()
        f.dispose()
    })

    it('authenticates SubmittedWork private identity and stops after an abandoned issued attempt', async () => {
        const f = await fixture(), selection = f.cover.select(view()), frame = f.upload.prepare(selection)
        const builder = f.runtime.createSubmission()
        f.upload.encode(builder, frame)
        const work = builder.submit()
        const fake = Object.create(SubmittedWork.prototype)
        Object.defineProperty(fake, 'runtime', { value: f.runtime })
        invalid(() => f.upload.receipt(frame, fake), 'receipt-mismatch')
        expect(f.upload.facts().poisoned).to.equal(true)
        await work.done
        f.dispose()
    })

    it('keeps native failure independent from a valid queued-upload receipt', async () => {
        const f = await fixture(), frame = f.upload.prepare(f.cover.select(view()))
        const builder = f.runtime.createSubmission()
        f.upload.encode(builder, frame)
        f.fake.errors.failNext('writeBuffer', 'validation', new Error('injected native upload failure'))
        const work = builder.submit()
        expect(f.upload.receipt(frame, work).submissionId).to.equal(work.id)
        expect((await work.nativeOutcome).status).to.equal('observed-failed')
        let failure
        try { await work.done } catch (error) { failure = error }
        expect(failure).to.be.instanceOf(ScratchDiagnosticError)
        f.dispose()
    })

    it('never retries a partially issued queue transaction as if nothing happened', async () => {
        const f = await fixture(), selection = f.cover.select(view()), frame = f.upload.prepare(selection)
        const builder = f.runtime.createSubmission(), failure = new Error('second write failed')
        f.upload.encode(builder, frame)
        const original = f.fake.queue.writeBuffer.bind(f.fake.queue)
        let writes = 0
        f.fake.queue.writeBuffer = (...args) => {
            if (++writes === 2) throw failure
            return original(...args)
        }
        expect(() => builder.submit()).to.throw(failure)
        expect(builder.isSubmitted).to.equal(true)
        frame.dispose()
        expect(f.upload.facts().poisoned).to.equal(true)
        invalid(() => f.upload.prepare(selection), 'poisoned')
        await new Promise(resolve => setImmediate(resolve))
        expect(f.runtime.diagnostics.snapshot().submissionNative.currentPendingNativeObservations).to.equal(0)
        f.dispose()
    })

    it('uses retained immutable selections after selector disposal and frees all unsubmitted frames', async () => {
        const f = await fixture(), selection = f.cover.select(view())
        f.cover.dispose()
        const frame = f.upload.prepare(selection), builder = f.runtime.createSubmission()
        f.upload.encode(builder, frame)
        f.upload.dispose()
        expect(frame.isDisposed).to.equal(true)
        expect(f.upload.facts().preparedFrameCount).to.equal(0)
        expect(() => builder.submit()).to.throw(ScratchDiagnosticError)
        expect(f.fake.calls.queueTimeline).to.have.length(0)
        f.dispose()
    })

    for (let failedAllocation = 1; failedAllocation <= 6; failedAllocation++) {
        it(`releases earlier allocations when GPU buffer ${failedAllocation} fails`, async () => {
            const fake = createFakeGpu(), runtime = await GPURuntime.create({ gpu: fake.gpu }), cover = makeCover()
            const original = runtime.createBuffer.bind(runtime), failure = new Error('allocation failure')
            let count = 0, observed
            runtime.createBuffer = async descriptor => {
                if (++count === failedAllocation) throw failure
                return original(descriptor)
            }
            try { await WebMercatorQuadCoverUpload.create(runtime, { cover }) } catch (error) { observed = error }
            expect(observed).to.equal(failure)
            expect(fake.calls.buffers.every(buffer => buffer.destroyed)).to.equal(true)
            expect(runtime.diagnostics.snapshot().resources).to.have.length(0)
            expect(cover.isDisposed).to.equal(false)
            cover.dispose()
            runtime.dispose()
        })
    }

    it('preserves the previous prepared frame if creating its replacement commands fails', async () => {
        const f = await fixture(), frame = f.upload.prepare(f.cover.select(view()))
        const original = f.runtime.createUploadCommand.bind(f.runtime), failure = new Error('upload preparation failed'), acquired = []
        let count = 0
        f.runtime.createUploadCommand = descriptor => {
            if (++count === 2) throw failure
            const command = original(descriptor)
            acquired.push(command)
            return command
        }
        expect(() => f.upload.prepare(f.cover.select(view(2)))).to.throw(failure)
        expect(acquired.every(command => command.isDisposed)).to.equal(true)
        expect(frame.isDisposed).to.equal(false)
        f.runtime.createUploadCommand = original
        const builder = f.runtime.createSubmission()
        f.upload.encode(builder, frame)
        const work = builder.submit()
        expect(f.upload.receipt(frame, work).frameEpoch).to.equal(1)
        await work.done
        f.dispose()
    })
})
