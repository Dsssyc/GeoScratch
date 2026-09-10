import { expect } from 'chai'
import * as scr from 'geoscratch/scratch'
import {
    beginReadbackNativeObservation,
    beginSubmissionNativeObservation,
} from '../packages/geoscratch/dist/scratch/gpu/submission-native-observation.js'
import { advanceResourceContentEpochForTest, createFakeGpu } from './scratch-test-utils.js'

describe('Scratch diagnostic reuse preserves live facts', () => {

    it('keeps epochs fresh and old snapshots immutable without changing allocation facts', async () => {

        const fake = createFakeGpu()
        const runtime = await scr.GPURuntime.create({ gpu: fake.gpu })
        const buffer = await runtime.createBuffer({ size: 16, usage: 8 /* COPY_DST */ })
        const original = runtime.diagnostics.snapshot()
        for (let epoch = 1; epoch <= 32; epoch++) {
            advanceResourceContentEpochForTest(buffer)
            const current = runtime.diagnostics.snapshot()
            expect(current.resources[0]).to.deep.include({
                descriptorHash: original.resources[0].descriptorHash,
                lastAllocationOperationId: original.resources[0].lastAllocationOperationId,
                allocationVersion: 1,
                contentEpoch: epoch,
                state: 'ready',
                logicalFootprintBytes: 16,
            })
            expect(current.pressure.currentScratchLogicalFootprintBytes).to.equal(16)
            expect(current.pressure.peakScratchLogicalFootprintBytes).to.equal(16)
        }
        expect(original.resources[0].contentEpoch).to.equal(0)
        expect(Object.isFrozen(original.resources[0])).to.equal(true)
        buffer.dispose()
        expect(runtime.diagnostics.snapshot().resources).to.have.length(0)
        expect(runtime.diagnostics.snapshot().pressure.currentScratchLogicalFootprintBytes).to.equal(0)
        runtime.dispose()
    })

    it('retains pending replacement provenance and refreshes facts only when allocation commits', async () => {

        const fake = createFakeGpu({ deferErrorScopePops: true })
        const runtime = await scr.GPURuntime.create({ gpu: fake.gpu })
        const creating = runtime.createTexture({
            size: [4, 4], format: 'rgba8unorm', usage: 2 /* COPY_DST */,
        })
        fake.errors.settlePop(0)
        fake.errors.settlePop(1)
        const texture = await creating
        const original = runtime.diagnostics.snapshot()
        const replacement = texture.resize({ width: 8, height: 8 })
        const pendingId = runtime.diagnostics.snapshot().resources[0].pendingReplacementOperationId
        advanceResourceContentEpochForTest(texture)
        expect(runtime.diagnostics.snapshot().resources[0]).to.deep.include({
            pendingReplacementOperationId: pendingId,
            descriptorHash: original.resources[0].descriptorHash,
            allocationVersion: 1, contentEpoch: 1, logicalFootprintBytes: 64,
        })
        fake.errors.settlePop(3)
        fake.errors.settlePop(2)
        await replacement
        const committed = runtime.diagnostics.snapshot()
        expect(committed.resources[0]).to.deep.include({
            allocationVersion: 2, contentEpoch: 1, state: 'empty', logicalFootprintBytes: 256,
        })
        expect(committed.resources[0].descriptorHash).not.to.equal(original.resources[0].descriptorHash)
        expect(committed.resources[0]).not.to.have.property('pendingReplacementOperationId')
        expect(committed.pressure.currentScratchLogicalFootprintBytes).to.equal(256)
        expect(committed.pressure.peakScratchLogicalFootprintBytes).to.equal(256)
        expect(original.resources[0].logicalFootprintBytes).to.equal(64)
        texture.dispose()
        expect(runtime.diagnostics.snapshot().pressure.currentScratchLogicalFootprintBytes).to.equal(0)
        runtime.dispose()
    })

    it('rejects malformed, duplicate and cyclic native plans before reserving observation', async () => {

        const fake = createFakeGpu()
        const runtime = await scr.GPURuntime.create({ gpu: fake.gpu })
        const submissionId = 'diagnostic-plan'
        const issue = { stage: 'queue-submit', location: { kind: 'submission', submissionId } }
        const cyclic = { ...issue.location }
        cyclic.extra = { back: cyclic }
        for (const plan of [
            [{ ...issue, stage: 'unknown-stage' }],
            [{ ...issue, location: { kind: 'submission', submissionId: 'other' } }],
            [{ ...issue, location: { kind: 'encoder-segment', submissionId, segmentIndex: -1 } }],
            [{ ...issue, location: { kind: 'unknown', submissionId } }],
            [{ ...issue, location: cyclic }],
            [issue, issue],
        ]) {
            expect(() => beginSubmissionNativeObservation({ runtime, submissionId, effectful: true, plan }))
                .to.throw(TypeError)
            const snapshot = runtime.diagnostics.snapshot()
            expect(snapshot.pendingOperations).to.have.length(0)
            expect(snapshot.submissionNative.currentPendingNativeObservations).to.equal(0)
            expect(fake.calls.errorScopes).to.have.length(0)
        }
        runtime.dispose()
    })

    it('accepts shared acyclic evidence and snapshots plan identities before later mutation', async () => {

        const fake = createFakeGpu()
        const runtime = await scr.GPURuntime.create({ gpu: fake.gpu })
        const submissionId = 'immutable-plan', shared = { value: 1 }
        const location = { kind: 'submission', submissionId, first: shared, second: shared }
        const originalLocation = { ...location }
        const plan = [{ stage: 'queue-submit', location }]
        const observation = beginSubmissionNativeObservation({ runtime, submissionId, effectful: true, plan })
        location.submissionId = 'mutated'
        plan.length = 0
        observation.issue('queue-submit', originalLocation, () => {})
        observation.finish()
        const outcome = await observation.outcome
        expect(outcome.status).to.equal('observed-succeeded')
        expect(outcome.locations).to.deep.equal([{ kind: 'submission', submissionId }])
        expect(Object.isFrozen(outcome.locations[0])).to.equal(true)
        expect(runtime.diagnostics.snapshot().submissionNative.currentPendingNativeObservations).to.equal(0)
        runtime.dispose()
    })

    it('rejects invalid and duplicate direct-readback stages before native work', async () => {

        const fake = createFakeGpu()
        const runtime = await scr.GPURuntime.create({ gpu: fake.gpu })
        const target = { kind: 'readback', path: 'direct', readbackId: 'readback-plan' }
        for (const plan of [['unknown'], ['command-encode', 'command-encode']]) {
            expect(() => beginReadbackNativeObservation({ runtime, target, plan })).to.throw(TypeError)
            expect(fake.calls.errorScopes).to.have.length(0)
            expect(runtime.diagnostics.snapshot().pendingOperations).to.have.length(0)
        }
        runtime.dispose()
    })
})
