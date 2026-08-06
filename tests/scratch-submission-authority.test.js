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

    it('rejects consumption when no preceding GPU work can cross the boundary', async() => {

        const fake = createFakeGpu()
        const runtime = await GPURuntime.create({ gpu: fake.gpu })
        const authority = runtime.createSubmissionAuthority({ label: 'empty sequence' })
        const stamp = authority.stamp()

        expect(() => runtime.createSubmission({ validation: 'throw' })
            .consume(stamp)
            .submit()).to.throw(ScratchDiagnosticError)
            .with.nested.property(
                'diagnostic.code',
                'SCRATCH_SUBMISSION_AUTHORITY_CONSUMPTION_EMPTY'
            )
        expect(authority.revision).to.equal(0)
        expect(fake.calls.queueTimeline).to.deep.equal([])

        authority.dispose()
        runtime.dispose()
    })

    it('consumes a current stamp exactly once at its issued-work boundary', async() => {

        const fake = createFakeGpu()
        const runtime = await GPURuntime.create({ gpu: fake.gpu })
        const authority = runtime.createSubmissionAuthority({ label: 'frontier sequence' })
        const stamp = authority.stamp()
        const buffer = await runtime.createBuffer({ size: 4, usage: 0x08 })
        const upload = runtime.createUploadCommand({
            target: buffer.region(),
            data: new Uint32Array([ 1 ]),
        })
        const first = runtime.createSubmission({ validation: 'throw' })
            .upload(upload)
            .consume(stamp)
        const competitor = runtime.createSubmission({ validation: 'throw' })
            .upload(upload)
            .consume(stamp)

        expect(authority.revision).to.equal(0)
        const submitted = first.submit()
        expect(submitted.resourceAccesses).to.have.length(1)
        expect(authority.revision).to.equal(1)
        expect(() => competitor.submit()).to.throw(ScratchDiagnosticError)
            .with.nested.property('diagnostic.code', 'SCRATCH_SUBMISSION_AUTHORITY_STALE')
        expect(authority.revision).to.equal(1)

        upload.dispose()
        buffer.dispose()
        authority.dispose()
        runtime.dispose()
    })

    it('does not consume a stamp when synchronous queue replay fails', async() => {

        const fake = createFakeGpu()
        const runtime = await GPURuntime.create({ gpu: fake.gpu })
        const authority = runtime.createSubmissionAuthority({ label: 'failed sequence' })
        const stamp = authority.stamp()
        const buffer = await runtime.createBuffer({ size: 4, usage: 0x08 })
        const upload = runtime.createUploadCommand({
            target: buffer.region(),
            data: new Uint32Array([ 1 ]),
        })
        const writeBuffer = runtime.queue.writeBuffer.bind(runtime.queue)
        runtime.queue.writeBuffer = () => {
            throw new Error('injected sequence upload failure')
        }

        expect(() => runtime.createSubmission({ validation: 'throw' })
            .upload(upload)
            .consume(stamp)
            .submit()).to.throw('injected sequence upload failure')
        expect(authority.revision).to.equal(0)

        runtime.queue.writeBuffer = writeBuffer
        const submitted = runtime.createSubmission({ validation: 'throw' })
            .upload(upload)
            .consume(stamp)
            .submit()
        expect(submitted.resourceAccesses).to.have.length(1)
        expect(authority.revision).to.equal(1)

        upload.dispose()
        buffer.dispose()
        authority.dispose()
        runtime.dispose()
    })

    it('does not roll back a consumed revision after asynchronous native failure', async() => {

        const fakeOptions = { deferErrorScopePops: false }
        const fake = createFakeGpu(fakeOptions)
        const runtime = await GPURuntime.create({ gpu: fake.gpu })
        const authority = runtime.createSubmissionAuthority({ label: 'issued sequence' })
        const buffer = await runtime.createBuffer({ size: 4, usage: 0x08 })
        const upload = runtime.createUploadCommand({
            target: buffer.region(),
            data: new Uint32Array([ 1 ]),
        })
        fakeOptions.deferErrorScopePops = true
        fake.errors.failNext('writeBuffer', 'validation', new Error('deferred native failure'))

        const submitted = runtime.createSubmission({ validation: 'throw' })
            .upload(upload)
            .consume(authority.stamp())
            .submit()
        expect(authority.revision).to.equal(1)
        for (let attempt = 0; attempt < 16; attempt++) {
            for (const [ index, pending ] of fake.errors.pendingPops.entries()) {
                if (!pending.settled) fake.errors.settlePop(index)
            }
            await Promise.resolve()
        }
        expect((await submitted.nativeOutcome).status).to.equal('observed-failed')
        expect(authority.revision).to.equal(1)

        upload.dispose()
        buffer.dispose()
        authority.dispose()
        runtime.dispose()
    })

    it('keeps a consumed boundary after later queue replay fails', async() => {

        const fake = createFakeGpu()
        const runtime = await GPURuntime.create({ gpu: fake.gpu })
        const authority = runtime.createSubmissionAuthority({ label: 'partial issue' })
        const leadingBuffer = await runtime.createBuffer({ size: 4, usage: 0x08 })
        const trailingBuffer = await runtime.createBuffer({ size: 4, usage: 0x08 })
        const leading = runtime.createUploadCommand({
            target: leadingBuffer.region(),
            data: new Uint32Array([ 1 ]),
        })
        const trailing = runtime.createUploadCommand({
            target: trailingBuffer.region(),
            data: new Uint32Array([ 2 ]),
        })
        const writeBuffer = runtime.queue.writeBuffer.bind(runtime.queue)
        runtime.queue.writeBuffer = (buffer, ...args) => {
            if (buffer === trailingBuffer.gpuBuffer) {
                throw new Error('injected trailing upload failure')
            }
            return writeBuffer(buffer, ...args)
        }

        expect(() => runtime.createSubmission({ validation: 'throw' })
            .upload(leading)
            .consume(authority.stamp())
            .upload(trailing)
            .submit()).to.throw('injected trailing upload failure')
        expect(fake.calls.queueWrites).to.have.length(1)
        expect(authority.revision).to.equal(1)

        runtime.queue.writeBuffer = writeBuffer
        trailing.dispose()
        leading.dispose()
        trailingBuffer.dispose()
        leadingBuffer.dispose()
        authority.dispose()
        runtime.dispose()
    })

    it('keeps a consumed boundary when completion registration throws after issue', async() => {

        const fake = createFakeGpu()
        const runtime = await GPURuntime.create({ gpu: fake.gpu })
        const authority = runtime.createSubmissionAuthority({ label: 'completion registration' })
        const buffer = await runtime.createBuffer({ size: 4, usage: 0x08 })
        const upload = runtime.createUploadCommand({
            target: buffer.region(),
            data: new Uint32Array([ 1 ]),
        })
        runtime.queue.onSubmittedWorkDone = () => {
            throw new Error('injected completion registration failure')
        }

        expect(() => runtime.createSubmission({ validation: 'throw' })
            .upload(upload)
            .consume(authority.stamp())
            .submit()).to.throw('injected completion registration failure')
        expect(fake.calls.queueWrites).to.have.length(1)
        expect(authority.revision).to.equal(1)

        upload.dispose()
        buffer.dispose()
        authority.dispose()
        runtime.dispose()
    })

    it('locks a claimed boundary against a reentrant competing submission', async() => {

        const fake = createFakeGpu()
        const runtime = await GPURuntime.create({ gpu: fake.gpu })
        const authority = runtime.createSubmissionAuthority({ label: 'reentrant sequence' })
        const stamp = authority.stamp()
        const firstBuffer = await runtime.createBuffer({ size: 4, usage: 0x08 })
        const competingBuffer = await runtime.createBuffer({ size: 4, usage: 0x08 })
        const firstUpload = runtime.createUploadCommand({
            target: firstBuffer.region(),
            data: new Uint32Array([ 1 ]),
        })
        const competingUpload = runtime.createUploadCommand({
            target: competingBuffer.region(),
            data: new Uint32Array([ 2 ]),
        })
        const competitor = runtime.createSubmission({ validation: 'throw' })
            .upload(competingUpload)
            .consume(stamp)
        const writeBuffer = runtime.queue.writeBuffer.bind(runtime.queue)
        let reentered = false
        let competingError
        runtime.queue.writeBuffer = (buffer, ...args) => {
            if (!reentered) {
                reentered = true
                try {
                    competitor.submit()
                } catch (error) {
                    competingError = error
                }
            }
            return writeBuffer(buffer, ...args)
        }

        const submitted = runtime.createSubmission({ validation: 'throw' })
            .upload(firstUpload)
            .consume(stamp)
            .submit()
        expect(submitted.resourceAccesses).to.have.length(1)
        expect(competingError).to.be.instanceOf(ScratchDiagnosticError)
        expect(competingError.diagnostic.code).to.equal('SCRATCH_SUBMISSION_AUTHORITY_BUSY')
        expect(authority.revision).to.equal(1)
        expect(fake.calls.queueWrites).to.have.length(1)

        runtime.queue.writeBuffer = writeBuffer
        competingUpload.dispose()
        firstUpload.dispose()
        competingBuffer.dispose()
        firstBuffer.dispose()
        authority.dispose()
        runtime.dispose()
    })
})
