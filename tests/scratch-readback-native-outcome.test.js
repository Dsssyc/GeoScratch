import { expect } from 'chai'
import * as scr from 'geoscratch'
import {
    advanceResourceContentEpochForTest,
    createFakeGpu,
} from './scratch-test-utils.js'

const COPY_SRC = 0x4

async function settleMicrotasks() {

    for (let index = 0; index < 24; index++) await Promise.resolve()
}

async function expectScratchDiagnostic(action, expected) {

    try {
        await action()
        throw new Error('expected Scratch diagnostic')
    } catch (error) {
        expect(error).to.be.instanceOf(scr.ScratchDiagnosticError)
        expect(error.diagnostic).to.include(expected)
        return error
    }
}

function settlePendingScopes(fake) {

    for (const [ index, pending ] of fake.errors.pendingPops.entries()) {
        if (!pending.settled) fake.errors.settlePop(index)
    }
}

async function createDirectFixture({ diagnostics, deferMaps = false } = {}) {

    const fakeOptions = {
        deferErrorScopePops: false,
        deferMaps,
    }
    const fake = createFakeGpu(fakeOptions)
    const runtime = await scr.ScratchRuntime.create({
        gpu: fake.gpu,
        ...(diagnostics !== undefined ? { diagnostics } : {}),
    })
    const source = await runtime.createBuffer({
        size: 16,
        usage: COPY_SRC,
    })
    advanceResourceContentEpochForTest(source)
    const readback = runtime.createReadback({ source: source.region() })
    fake.calls.errorScopes.length = 0
    fake.calls.nativeTimeline.length = 0
    return { ...fake, fakeOptions, runtime, source, readback }
}

async function createOrderedFixture({ diagnostics } = {}) {

    const fakeOptions = { deferErrorScopePops: false }
    const fake = createFakeGpu(fakeOptions)
    const runtime = await scr.ScratchRuntime.create({
        gpu: fake.gpu,
        ...(diagnostics !== undefined ? { diagnostics } : {}),
    })
    const source = await runtime.createBuffer({
        size: 16,
        usage: COPY_SRC,
    })
    advanceResourceContentEpochForTest(source)
    const command = await runtime.createReadbackCommand({
        source: { region: (source).region(), contentEpoch: 1 },
        whenMissing: 'throw',
    })
    fake.calls.errorScopes.length = 0
    fake.calls.nativeTimeline.length = 0
    return { ...fake, fakeOptions, runtime, source, command }
}

describe('scratch readback native outcomes', () => {

    it('waits for direct summary observation after mapping succeeds', async () => {

        const fixture = await createDirectFixture()
        fixture.fakeOptions.deferErrorScopePops = true
        let settled = false
        const materialization = fixture.readback.toBytes().then(bytes => {
            settled = true
            return bytes
        })

        expect(fixture.errors.pendingPops).to.have.length(2)
        settlePendingScopes(fixture)
        await settleMicrotasks()
        expect(fixture.errors.pendingPops).to.have.length(8)
        expect(fixture.calls.maps).to.have.length(1)
        expect(settled).to.equal(false)

        settlePendingScopes(fixture)
        const bytes = await materialization
        expect(bytes).to.have.length(16)
        expect(fixture.runtime.diagnostics.operations({
            kind: 'readback-native-observation',
            readbackId: fixture.readback.id,
        })[0]?.nativeOutcome).to.deep.include({
            readbackId: fixture.readback.id,
            mode: 'summary',
            status: 'observed-succeeded',
        })
        expect(fixture.runtime.diagnostics.snapshot().submissionNative)
            .to.include({ currentPendingNativeObservations: 0 })
    })

    it('rejects direct bytes after an observed copy failure while retaining mapping success', async () => {

        const fixture = await createDirectFixture()
        fixture.fakeOptions.deferErrorScopePops = true
        fixture.errors.failNext(
            'copyBufferToBuffer',
            'validation',
            new Error('direct copy validation')
        )
        const materialization = fixture.readback.toBytes()
        settlePendingScopes(fixture)
        await settleMicrotasks()
        settlePendingScopes(fixture)

        const error = await expectScratchDiagnostic(() => materialization, {
            code: 'SCRATCH_READBACK_NATIVE_VALIDATION_FAILED',
            phase: 'readback',
        })
        expect(error.incident).to.deep.include({
            kind: 'readback-failure',
            failureStage: 'copy-issue',
        })
        expect(error.incident.outcomes).to.deep.include.members([ {
            stage: 'scope-settlement',
            diagnosticCode: 'SCRATCH_READBACK_NATIVE_VALIDATION_FAILED',
            nativeErrorCategory: 'validation',
            nativeError: {
                name: 'Error',
                message: 'direct copy validation',
            },
        } ])
        expect(fixture.runtime.diagnostics.operations({
            kind: 'readback-mapping',
            readbackId: fixture.readback.id,
        })[0]?.status).to.equal('succeeded')
        expect(fixture.readback.state).to.equal('failed')
        expect(fixture.runtime.diagnostics.snapshot().readbackMemory.currentStagingBytes).to.equal(0)
        expect(fixture.runtime.diagnostics.snapshot().submissionNative)
            .to.include({ currentPendingNativeObservations: 0 })
    })

    it('attributes direct copy failures to exact stages only during finite detailed capture', async () => {

        const fixture = await createDirectFixture()
        const capture = fixture.runtime.diagnostics.capture({ nativeSubmissionDetail: 'step' })
        fixture.errors.failNext(
            'copyBufferToBuffer',
            'validation',
            new Error('detailed direct copy validation')
        )
        await expectScratchDiagnostic(() => fixture.readback.toBytes(), {
            code: 'SCRATCH_READBACK_NATIVE_VALIDATION_FAILED',
            phase: 'readback',
        })
        const observation = fixture.runtime.diagnostics.operations({
            kind: 'readback-native-observation',
            readbackId: fixture.readback.id,
        })[0]

        expect(observation.nativeOutcome).to.deep.include({
            mode: 'detailed',
            status: 'observed-failed',
        })
        expect(observation.nativeOutcome.outcomes[0]).to.deep.include({
            stage: 'command-encode',
            nativeErrorCategory: 'validation',
        })
        capture.stop()
    })

    for (const testCase of [
        { method: 'createCommandEncoder', stage: 'encoder-create' },
        { method: 'copyBufferToBuffer', stage: 'command-encode' },
        { method: 'finish', stage: 'encoder-finish' },
        { method: 'submit', stage: 'queue-submit' },
    ]) {
        it(`observes the direct ${testCase.stage} boundary`, async () => {

            const fixture = await createDirectFixture()
            const capture = fixture.runtime.diagnostics.capture({ nativeSubmissionDetail: 'step' })
            fixture.errors.failNext(
                testCase.method,
                'validation',
                new Error(`${testCase.stage} validation`)
            )
            await expectScratchDiagnostic(() => fixture.readback.toBytes(), {
                code: 'SCRATCH_READBACK_NATIVE_VALIDATION_FAILED',
                phase: 'readback',
            })
            const observation = fixture.runtime.diagnostics.operations({
                kind: 'readback-native-observation',
                readbackId: fixture.readback.id,
                nativeStage: testCase.stage,
            })[0]

            expect(observation.nativeOutcome.outcomes.some(outcome =>
                outcome.stage === testCase.stage &&
                outcome.nativeErrorCategory === 'validation'
            )).to.equal(true)
            capture.stop()
        })
    }

    it('classifies direct scope settlement failure after every scope is balanced', async () => {

        const fixture = await createDirectFixture()
        fixture.fakeOptions.deferErrorScopePops = true
        const materialization = fixture.readback.toBytes()
        settlePendingScopes(fixture)
        await settleMicrotasks()
        fixture.errors.rejectPop(2, new Error('direct validation pop failed'))
        for (const index of [ 3, 4, 5, 6, 7 ]) {
            fixture.errors.settlePop(index)
        }

        await expectScratchDiagnostic(() => materialization, {
            code: 'SCRATCH_READBACK_NATIVE_SCOPE_FAILED',
            phase: 'readback',
        })
        expect(fixture.errors.scopeDepth).to.equal(0)
        expect(fixture.runtime.diagnostics.snapshot().submissionNative)
            .to.include({ currentPendingNativeObservations: 0 })
    })

    it('keeps an application error scope paired outside direct readback scopes', async () => {

        const fixture = await createDirectFixture()
        fixture.device.pushErrorScope('validation')
        expect(Array.from(await fixture.readback.toBytes())).to.have.length(16)
        expect(await fixture.device.popErrorScope()).to.equal(null)
        expect(fixture.errors.scopeDepth).to.equal(0)
    })

    it('retains direct copy and mapping failures as independent outcomes', async () => {

        const fixture = await createDirectFixture()
        fixture.errors.failNext(
            'copyBufferToBuffer',
            'validation',
            new Error('simultaneous direct copy validation')
        )
        fixture.readbacks.rejectNextMap(new DOMException('simultaneous map rejection', 'OperationError'))

        await expectScratchDiagnostic(() => fixture.readback.toBytes(), {
            code: 'SCRATCH_READBACK_MAPPING_REJECTED',
            phase: 'readback',
        })
        await settleMicrotasks()
        expect(fixture.runtime.diagnostics.incidents({ readbackId: fixture.readback.id })
            .map(incident => incident.diagnosticCode)).to.include.members([
                'SCRATCH_READBACK_NATIVE_VALIDATION_FAILED',
                'SCRATCH_READBACK_MAPPING_REJECTED',
            ])
        expect(fixture.runtime.diagnostics.operations({ readbackId: fixture.readback.id })
            .filter(operation => [
                'readback-native-observation',
                'readback-mapping',
            ].includes(operation.kind))
            .map(operation => [ operation.kind, operation.status ])).to.deep.include.members([
                [ 'readback-native-observation', 'failed' ],
                [ 'readback-mapping', 'failed' ],
            ])
    })

    it('publishes explicit unobserved direct provenance when scopes are off', async () => {

        const fixture = await createDirectFixture({
            diagnostics: { submissionScopes: 'off' },
        })
        const bytes = await fixture.readback.toBytes()
        const observation = fixture.runtime.diagnostics.operations({
            kind: 'readback-native-observation',
            readbackId: fixture.readback.id,
        })[0]

        expect(bytes).to.have.length(16)
        expect(fixture.calls.errorScopes.filter(call => call.action === 'push')).to.have.length(5)
        expect(observation.nativeOutcome).to.deep.include({
            readbackId: fixture.readback.id,
            mode: 'off',
            status: 'unobserved',
        })
    })

    it('internally observes an ignored direct materialization rejection', async () => {

        const fixture = await createDirectFixture()
        fixture.errors.failNext(
            'copyBufferToBuffer',
            'validation',
            new Error('ignored direct copy validation')
        )
        const unhandled = []
        const onUnhandled = reason => unhandled.push(reason)
        process.on('unhandledRejection', onUnhandled)
        try {
            const materialization = fixture.readback.toBytes()
            await new Promise(resolve => setImmediate(resolve))
            await new Promise(resolve => setImmediate(resolve))
            expect(unhandled).to.deep.equal([])
            await expectScratchDiagnostic(() => materialization, {
                code: 'SCRATCH_READBACK_NATIVE_VALIDATION_FAILED',
                phase: 'readback',
            })
        } finally {
            process.removeListener('unhandledRejection', onUnhandled)
        }
    })

    it('releases deferred direct observation, mapping, and staging ownership after cancellation', async () => {

        const fixture = await createDirectFixture({ deferMaps: true })
        fixture.fakeOptions.deferErrorScopePops = true
        const materialization = fixture.readback.toBytes()
        settlePendingScopes(fixture)
        await settleMicrotasks()
        expect(fixture.calls.maps).to.have.length(1)
        expect(fixture.runtime.diagnostics.snapshot().submissionNative)
            .to.include({ currentPendingNativeObservations: 1 })

        fixture.readback.cancel('cancel deferred native observation')
        settlePendingScopes(fixture)
        await expectScratchDiagnostic(() => materialization, {
            code: 'SCRATCH_READBACK_CANCELLED',
            phase: 'readback',
        })
        await settleMicrotasks()
        const snapshot = fixture.runtime.diagnostics.snapshot()
        expect(snapshot.readbacks).to.deep.equal([])
        expect(snapshot.pendingOperations).to.deep.equal([])
        expect(snapshot.readbackMemory).to.include({
            currentStagingBytes: 0,
            activeMappings: 0,
        })
        expect(snapshot.submissionNative.currentPendingNativeObservations).to.equal(0)
    })

    it('fails the shared pending-observation budget before direct encoder effects', async () => {

        const fixture = await createDirectFixture({
            diagnostics: { maxPendingNativeObservations: 1 },
        })
        const target = await fixture.runtime.createBuffer({ size: 16, usage: 0xc })
        fixture.fakeOptions.deferErrorScopePops = true
        const pendingSubmission = fixture.runtime.submission()
            .copy(fixture.runtime.createCopyCommand({
                source: { region: fixture.source.region(), contentEpoch: 1 },
                target: target.region(),
                whenMissing: 'throw',
            }))
            .submit()
        fixture.fakeOptions.deferErrorScopePops = false
        const encoderCount = fixture.calls.commandEncoders.length

        await expectScratchDiagnostic(() => fixture.readback.toBytes(), {
            code: 'SCRATCH_READBACK_NATIVE_OBSERVATION_BUDGET_EXCEEDED',
            phase: 'readback',
        })
        expect(fixture.calls.commandEncoders).to.have.length(encoderCount)

        settlePendingScopes(fixture)
        await pendingSubmission.done
        const snapshot = fixture.runtime.diagnostics.snapshot()
        expect(snapshot.readbackMemory.currentStagingBytes).to.equal(0)
        expect(snapshot.submissionNative.currentPendingNativeObservations).to.equal(0)
        expect(snapshot.pendingOperations).to.deep.equal([])
    })

    it('rejects ordered bytes when the associated submission native outcome fails', async () => {

        const fixture = await createOrderedFixture()
        fixture.fakeOptions.deferErrorScopePops = true
        fixture.errors.failNext(
            'copyBufferToBuffer',
            'validation',
            new Error('ordered staging copy validation')
        )
        const submitted = fixture.runtime.submission().readback(fixture.command).submit()
        const operation = fixture.command.result({ after: submitted })
        let settled = false
        const materialization = operation.toBytes().then(
            bytes => {
                settled = true
                return bytes
            },
            error => {
                settled = true
                throw error
            }
        )

        await settleMicrotasks()
        expect(fixture.calls.maps).to.have.length(1)
        expect(settled).to.equal(false)
        settlePendingScopes(fixture)
        await expectScratchDiagnostic(() => materialization, {
            code: 'SCRATCH_READBACK_ORDERED_COPY_UNTRUSTED',
            phase: 'readback',
        })
        expect(fixture.runtime.diagnostics.operations({
            kind: 'readback-mapping',
            readbackId: operation.id,
        })[0]?.status).to.equal('succeeded')
    })

    it('releases an ordered slot after native failure and reuses the command sequentially', async () => {

        const fixture = await createOrderedFixture()
        fixture.errors.failNext(
            'copyBufferToBuffer',
            'validation',
            new Error('first ordered copy validation')
        )
        const firstSubmitted = fixture.runtime.submission().readback(fixture.command).submit()
        const first = fixture.command.result({ after: firstSubmitted })
        await expectScratchDiagnostic(() => first.toBytes(), {
            code: 'SCRATCH_READBACK_ORDERED_COPY_UNTRUSTED',
            phase: 'readback',
        })
        expect(fixture.command.state).to.equal('idle')

        const secondSubmitted = fixture.runtime.submission().readback(fixture.command).submit()
        const second = fixture.command.result({ after: secondSubmitted })
        expect(Array.from(await second.toBytes())).to.have.length(16)
        expect(fixture.command.state).to.equal('idle')
        expect(fixture.runtime.diagnostics.snapshot().readbackMemory.currentStagingBytes)
            .to.equal(16)
        fixture.command.dispose()
        expect(fixture.runtime.diagnostics.snapshot().readbackMemory.currentStagingBytes)
            .to.equal(0)
    })

    it('allows ordered bytes with explicit unobserved provenance when scopes are off', async () => {

        const fixture = await createOrderedFixture({
            diagnostics: { submissionScopes: 'off' },
        })
        const submitted = fixture.runtime.submission().readback(fixture.command).submit()
        const operation = fixture.command.result({ after: submitted })

        expect(Array.from(await operation.toBytes())).to.have.length(16)
        expect((await submitted.nativeOutcome).status).to.equal('unobserved')
    })

    it('does not turn queue-completion rejection into an ordered mapping failure', async () => {

        const fixture = await createOrderedFixture()
        fixture.readbacks.rejectNextQueueCompletion(new Error('ordered queue completion rejected'))
        const submitted = fixture.runtime.submission().readback(fixture.command).submit()
        const operation = fixture.command.result({ after: submitted })

        expect(Array.from(await operation.toBytes())).to.have.length(16)
        expect(fixture.runtime.diagnostics.operations({
            kind: 'readback-mapping',
            readbackId: operation.id,
        })[0]?.status).to.equal('succeeded')
        await expectScratchDiagnostic(() => submitted.done, {
            code: 'SCRATCH_SUBMISSION_QUEUE_COMPLETION_FAILED',
            phase: 'submission',
        })
    })
})
