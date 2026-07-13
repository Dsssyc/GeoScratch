import { expect } from 'chai'
import * as scr from 'geoscratch'
import { createGpuOperationRecord } from '../packages/geoscratch/dist/scratch/gpu-operation.js'
import { createFakeGpu } from './scratch-test-utils.js'

async function expectScratchDiagnostic(action, expected) {

    try {
        await action()
        throw new Error('expected Scratch diagnostic')
    } catch (error) {
        expect(error).to.be.instanceOf(scr.ScratchDiagnosticError)
        expect(error.diagnostic).to.include(expected)
        return error.diagnostic
    }
}

describe('scratch submission native contract', () => {

    it('publishes finite default summary observation policy', async () => {

        const fake = createFakeGpu()
        const runtime = await scr.ScratchRuntime.create({ gpu: fake.gpu })
        const snapshot = runtime.diagnostics.snapshot()

        expect(snapshot.submissionNative).to.deep.include({
            submissionScopes: 'summary',
            currentPendingNativeObservations: 0,
            peakPendingNativeObservations: 0,
            currentEffectfulSubmittedWork: 0,
        })
        expect(snapshot.submissionNative.maxPendingNativeObservations)
            .to.be.a('number').and.to.be.greaterThan(0)
        expect(Number.isSafeInteger(snapshot.submissionNative.maxPendingNativeObservations)).to.equal(true)
        expect(Object.isFrozen(snapshot.submissionNative)).to.equal(true)
    })

    it('accepts explicit off policy and rejects invalid policy before adapter request', async () => {

        const offFake = createFakeGpu()
        const offRuntime = await scr.ScratchRuntime.create({
            gpu: offFake.gpu,
            diagnostics: {
                submissionScopes: 'off',
                maxPendingNativeObservations: 3,
            },
        })
        expect(offRuntime.diagnostics.snapshot().submissionNative).to.deep.include({
            submissionScopes: 'off',
            maxPendingNativeObservations: 3,
        })

        for (const diagnostics of [
            { submissionScopes: 'detailed' },
            { submissionScopes: null },
            { maxPendingNativeObservations: 0 },
            { maxPendingNativeObservations: 1.5 },
            { maxPendingNativeObservations: null },
        ]) {
            const fake = createFakeGpu()
            let adapterRequests = 0
            const gpu = {
                ...fake.gpu,
                async requestAdapter(options) {
                    adapterRequests++
                    return fake.gpu.requestAdapter(options)
                },
            }

            await expectScratchDiagnostic(
                () => scr.ScratchRuntime.create({ gpu, diagnostics }),
                {
                    code: 'SCRATCH_SUBMISSION_NATIVE_POLICY_INVALID',
                    severity: 'error',
                    phase: 'runtime',
                }
            )
            expect(adapterRequests).to.equal(0)
        }
    })

    it('keeps effect-free submit synchronous and publishes no-native-work', async () => {

        const fake = createFakeGpu()
        const runtime = await scr.ScratchRuntime.create({ gpu: fake.gpu })
        const submitted = runtime.submission().submit()

        expect(submitted).to.be.instanceOf(scr.SubmittedWork)
        expect(submitted).not.to.be.instanceOf(Promise)
        expect(submitted.nativeOutcome).to.be.instanceOf(Promise)

        const outcome = await submitted.nativeOutcome
        expect(outcome).to.deep.include({
            version: 4,
            submissionId: submitted.id,
            mode: 'summary',
            status: 'no-native-work',
        })
        expect(outcome.outcomes).to.deep.equal([])
        expect(Object.isFrozen(outcome)).to.equal(true)
        expect(Object.isFrozen(outcome.outcomes)).to.equal(true)
        expect(JSON.parse(JSON.stringify(outcome))).to.deep.equal(outcome)
        expect(fake.calls.errorScopes).to.deep.equal([])
        await submitted.done
    })

    it('closes SubmittedWork construction and makes every public fact read-only', async () => {

        const fake = createFakeGpu()
        const runtime = await scr.ScratchRuntime.create({ gpu: fake.gpu })

        for (const Candidate of [ scr.SubmittedWork, class extends scr.SubmittedWork {} ]) {
            await expectScratchDiagnostic(
                () => new Candidate(runtime),
                {
                    code: 'SCRATCH_SUBMITTED_WORK_CONSTRUCTOR_PRIVATE',
                    severity: 'error',
                    phase: 'submission',
                }
            )
        }

        const submitted = runtime.submission().submit()
        const original = {
            id: submitted.id,
            runtime: submitted.runtime,
            report: submitted.report,
            diagnostics: submitted.diagnostics,
            commandBuffers: submitted.commandBuffers,
            resourceAccesses: submitted.resourceAccesses,
            producerEpochs: submitted.producerEpochs,
            executionOutcomes: submitted.executionOutcomes,
            readbacks: submitted.readbacks,
            nativeOutcome: submitted.nativeOutcome,
            done: submitted.done,
        }

        for (const [ name, value ] of Object.entries(original)) {
            expect(() => { submitted[name] = Symbol(name) }).to.throw(TypeError)
            expect(submitted[name]).to.equal(value)
        }
        for (const name of Object.keys(original)) {
            const descriptor = findPropertyDescriptor(submitted, name)
            expect(descriptor?.set).to.equal(undefined)
        }
    })

    it('uses schema version 4 with a macro submission target and discriminated location', () => {

        const record = createGpuOperationRecord({
            sequence: 1,
            id: 'operation-submission-1',
            kind: 'submission-native-observation',
            status: 'succeeded',
            runtimeId: 'runtime-1',
            target: {
                kind: 'submission',
                submissionId: 'submission-1',
            },
            descriptor: {
                hash: 'descriptor-submission-1',
                summary: {
                    mode: 'summary',
                    stepCount: 3,
                    queueActionCount: 2,
                },
            },
            nativeOutcome: {
                mode: 'summary',
                status: 'observed-succeeded',
                locations: [ {
                    kind: 'submission',
                    submissionId: 'submission-1',
                } ],
                outcomes: [],
            },
        })

        expect(record.version).to.equal(4)
        expect(record.target).to.deep.equal({
            kind: 'submission',
            submissionId: 'submission-1',
        })
        expect(record.nativeOutcome.locations).to.deep.equal([ {
            kind: 'submission',
            submissionId: 'submission-1',
        } ])
        expect(Object.isFrozen(record.nativeOutcome)).to.equal(true)
        expect(Object.isFrozen(record.nativeOutcome.locations)).to.equal(true)
        expect(JSON.parse(JSON.stringify(record))).to.deep.equal(record)
    })

    it('versions runtime snapshots and exported evidence together', async () => {

        const fake = createFakeGpu()
        const runtime = await scr.ScratchRuntime.create({ gpu: fake.gpu })
        const snapshot = runtime.diagnostics.snapshot()
        const evidence = runtime.diagnostics.exportEvidence()

        expect(snapshot.version).to.equal(4)
        expect(evidence.version).to.equal(4)
        expect(evidence.snapshot.version).to.equal(4)
    })
})

function findPropertyDescriptor(value, name) {

    let candidate = value
    while (candidate !== null) {
        const descriptor = Object.getOwnPropertyDescriptor(candidate, name)
        if (descriptor !== undefined) return descriptor
        candidate = Object.getPrototypeOf(candidate)
    }

    return undefined
}
