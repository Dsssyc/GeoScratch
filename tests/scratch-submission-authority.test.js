import { expect } from 'chai'
import {
    GPURuntime,
    ScratchDiagnosticError,
} from 'geoscratch/scratch'
import { createFakeGpu } from './scratch-test-utils.js'

describe('Scratch SubmissionAuthority', () => {

    it('accepts only the current immutable branded revision stamp', async() => {

        const fake = createFakeGpu()
        const runtime = await GPURuntime.create({ gpu: fake.gpu })
        const authority = runtime.createSubmissionAuthority({ label: 'frontier view' })
        const first = authority.stamp()

        expect(Object.isFrozen(first)).to.equal(true)
        expect(first).to.deep.include({ revision: 0 })
        expect(runtime.createSubmission({ validation: 'throw' })
            .require(first)
            .submit().executionOutcomes).to.deep.equal([])

        const second = authority.advance()
        expect(second).to.deep.include({ revision: 1 })
        expect(second).not.to.equal(first)
        expect(() => runtime.createSubmission({ validation: 'throw' })
            .require(first)
            .submit()).to.throw(ScratchDiagnosticError)
            .with.nested.property('diagnostic.code', 'SCRATCH_SUBMISSION_AUTHORITY_STALE')
        expect(runtime.createSubmission({ validation: 'throw' })
            .require(second)
            .submit().executionOutcomes).to.deep.equal([])

        authority.dispose()
        runtime.dispose()
    })

    it('rechecks requirements after caller-owned materialization and before native effects', async() => {

        const fake = createFakeGpu()
        const runtime = await GPURuntime.create({ gpu: fake.gpu })
        const authority = runtime.createSubmissionAuthority({ label: 'late advance' })
        const buffer = await runtime.createBuffer({
            label: 'late-authority upload target',
            size: 4,
            usage: 0x08,
        })
        const upload = runtime.createUploadCommand({
            label: 'late-authority upload',
            target: buffer.region(),
            data: new Uint32Array([ 1 ]),
        })
        const builder = runtime.createSubmission({ validation: 'throw' })
            .require(authority.stamp())
            .upload(upload)
        let validationReads = 0
        Object.defineProperty(builder, 'validation', {
            configurable: true,
            enumerable: true,
            get() {
                validationReads++
                authority.advance()
                return 'throw'
            },
        })

        expect(() => builder.submit()).to.throw(ScratchDiagnosticError)
            .with.nested.property('diagnostic.code', 'SCRATCH_SUBMISSION_AUTHORITY_STALE')
        expect(validationReads).to.be.greaterThan(0)
        expect(fake.calls.commandEncoders).to.have.length(0)
        expect(fake.calls.queueWrites).to.have.length(0)

        upload.dispose()
        buffer.dispose()
        authority.dispose()
        runtime.dispose()
    })

    it('rejects forged, wrong-runtime, and disposed requirements without callbacks or native work', async() => {

        const fakeA = createFakeGpu()
        const fakeB = createFakeGpu()
        const runtimeA = await GPURuntime.create({ gpu: fakeA.gpu })
        const runtimeB = await GPURuntime.create({ gpu: fakeB.gpu })
        const authority = runtimeA.createSubmissionAuthority({ label: 'owned authority' })
        const stamp = authority.stamp()

        expect(() => runtimeB.createSubmission().require(stamp).submit())
            .to.throw(ScratchDiagnosticError)
            .with.nested.property('diagnostic.code', 'SCRATCH_SUBMISSION_AUTHORITY_WRONG_RUNTIME')
        expect(() => runtimeA.createSubmission().require(Object.freeze({
            kind: 'submission-authority-stamp',
            authorityId: authority.id,
            runtimeId: runtimeA.id,
            revision: stamp.revision,
        })).submit()).to.throw(ScratchDiagnosticError)
            .with.nested.property('diagnostic.code', 'SCRATCH_SUBMISSION_AUTHORITY_INVALID')

        authority.dispose()
        expect(() => runtimeA.createSubmission().require(stamp).submit())
            .to.throw(ScratchDiagnosticError)
            .with.nested.property('diagnostic.code', 'SCRATCH_SUBMISSION_AUTHORITY_DISPOSED')
        expect(fakeA.calls.commandEncoders).to.have.length(0)
        expect(fakeB.calls.commandEncoders).to.have.length(0)

        runtimeA.dispose()
        runtimeB.dispose()
    })
})
