import { expect } from 'chai'
import * as scr from 'geoscratch'
import { diagnosticsControllerFor } from '../packages/geoscratch/dist/scratch/runtime-diagnostics.js'
import {
    advanceResourceContentEpochForTest,
    createFakeGpu,
} from './scratch-test-utils.js'

const COPY_SRC = 0x4
const COPY_DST = 0x8

async function settleMicrotasks() {

    for (let index = 0; index < 16; index++) await Promise.resolve()
}

async function rejectedDiagnostic(promise) {

    try {
        await promise
        throw new Error('expected Scratch diagnostic rejection')
    } catch (error) {
        expect(error).to.be.instanceOf(scr.ScratchDiagnosticError)
        return error
    }
}

async function createSource(runtime, label = 'direct staging source') {

    return runtime.createBuffer({
        label,
        size: 16,
        usage: COPY_SRC | COPY_DST,
    })
}

async function createSourceWithDeferredScopes(fake, runtime) {

    const creation = createSource(runtime)
    fake.errors.settlePop(0)
    fake.errors.settlePop(1)
    return creation
}

describe('scratch acknowledged readback staging', () => {

    it('acknowledges direct staging before encoder or queue use', async () => {

        const fake = createFakeGpu({ deferErrorScopePops: true })
        const runtime = await scr.ScratchRuntime.create({ gpu: fake.gpu })
        const source = await createSourceWithDeferredScopes(fake, runtime)
        const readback = runtime.createReadback({ source })
        const bufferCount = fake.calls.buffers.length
        const encoderCount = fake.calls.commandEncoders.length
        const submissionCount = fake.calls.queueSubmissions.length

        const materialization = readback.toBytes()

        expect(fake.calls.buffers).to.have.length(bufferCount + 1)
        expect(fake.calls.errorScopes.slice(-4).map(call => `${call.action}:${call.filter}`)).to.deep.equal([
            'push:out-of-memory',
            'push:validation',
            'pop:validation',
            'pop:out-of-memory',
        ])
        expect(fake.errors.scopeDepth).to.equal(0)
        expect(fake.calls.commandEncoders).to.have.length(encoderCount)
        expect(fake.calls.queueSubmissions).to.have.length(submissionCount)
        expect(runtime.diagnostics.snapshot().readbackMemory.currentStagingBytes).to.equal(16)
        expect(runtime.diagnostics.snapshot().pendingOperations).to.have.length(1)

        fake.errors.settlePop(3)
        await settleMicrotasks()
        expect(fake.calls.commandEncoders).to.have.length(encoderCount)
        expect(fake.calls.queueSubmissions).to.have.length(submissionCount)

        fake.errors.settlePop(2)
        expect(await materialization).to.deep.equal(new Uint8Array(16))
        expect(fake.calls.commandEncoders).to.have.length(encoderCount + 1)
        expect(fake.calls.queueSubmissions).to.have.length(submissionCount + 1)
        expect(fake.queue.submittedWorkDoneCalls).to.equal(0)
        expect(fake.calls.buffers.at(-1).destroyed).to.equal(true)
        expect(readback).not.to.have.property('stagingBuffer')
        expect(runtime.diagnostics.snapshot().readbackMemory.currentStagingBytes).to.equal(0)
        expect(runtime.diagnostics.snapshot().pendingOperations).to.have.length(0)
        expect(runtime.diagnostics.operations({ readbackId: readback.id }).at(-1)).to.deep.include({
            kind: 'readback-staging-allocation',
            status: 'succeeded',
        })
    })

    for (const failure of [
        {
            name: 'validation',
            configure(fake, error) {

                fake.errors.failNext('createBuffer', 'validation', error)
            },
            code: 'SCRATCH_READBACK_STAGING_VALIDATION_FAILED',
            category: 'validation',
        },
        {
            name: 'out of memory',
            configure(fake, error) {

                fake.errors.failNext('createBuffer', 'out-of-memory', error)
            },
            code: 'SCRATCH_READBACK_STAGING_OUT_OF_MEMORY',
            category: 'out-of-memory',
        },
        {
            name: 'synchronous native exception',
            configure(fake, error) {

                fake.errors.throwNext('createBuffer', error)
            },
            code: 'SCRATCH_READBACK_STAGING_NATIVE_FAILED',
            category: 'native-exception',
        },
    ]) {
        it(`rolls back direct staging after ${failure.name}`, async () => {

            const fake = createFakeGpu()
            const runtime = await scr.ScratchRuntime.create({ gpu: fake.gpu })
            const source = await createSource(runtime)
            const readback = runtime.createReadback({ source })
            const nativeError = Object.assign(new Error(`fake ${failure.name}`), {
                name: failure.category === 'out-of-memory'
                    ? 'GPUOutOfMemoryError'
                    : failure.category === 'validation'
                        ? 'GPUValidationError'
                        : 'TypeError',
            })
            const bufferCount = fake.calls.buffers.length
            const encoderCount = fake.calls.commandEncoders.length
            const submissionCount = fake.calls.queueSubmissions.length
            failure.configure(fake, nativeError)

            const error = await rejectedDiagnostic(readback.toBytes())

            expect(error.diagnostic.code).to.equal(failure.code)
            expect(error.cause).to.equal(nativeError)
            expect(error.incident).to.deep.include({
                kind: 'readback-failure',
                nativeErrorCategory: failure.category,
                attribution: 'exact-operation',
                failureStage: 'staging-allocation',
            })
            expect(fake.calls.commandEncoders).to.have.length(encoderCount)
            expect(fake.calls.queueSubmissions).to.have.length(submissionCount)
            expect(fake.calls.buffers).to.have.length(
                failure.category === 'native-exception' ? bufferCount : bufferCount + 1
            )
            if (failure.category !== 'native-exception') {
                expect(fake.calls.buffers.at(-1).destroyed).to.equal(true)
            }
            expect(runtime.diagnostics.snapshot().readbackMemory.currentStagingBytes).to.equal(0)
            expect(runtime.diagnostics.snapshot().pendingOperations).to.have.length(0)
        })
    }

    it('reports scope settlement failure and destroys the candidate once', async () => {

        const fake = createFakeGpu({ deferErrorScopePops: true })
        const runtime = await scr.ScratchRuntime.create({ gpu: fake.gpu })
        const source = await createSourceWithDeferredScopes(fake, runtime)
        const readback = runtime.createReadback({ source })
        const materialization = readback.toBytes()
        const candidate = fake.calls.buffers.at(-1)

        fake.errors.rejectPop(2, new Error('validation scope pop failed'))
        fake.errors.settlePop(3)
        const error = await rejectedDiagnostic(materialization)

        expect(error.diagnostic.code).to.equal('SCRATCH_READBACK_STAGING_SCOPE_FAILED')
        expect(error.incident).to.deep.include({
            kind: 'readback-failure',
            nativeErrorCategory: 'scope-failure',
            failureStage: 'staging-allocation',
        })
        expect(candidate.destroyed).to.equal(true)
        expect(fake.calls.bufferDestroys.filter(call => call.buffer === candidate)).to.have.length(1)
        expect(runtime.diagnostics.snapshot().readbackMemory.currentStagingBytes).to.equal(0)
    })

    it('fails staging budget before a native allocation or encoder effect', async () => {

        const fake = createFakeGpu()
        const runtime = await scr.ScratchRuntime.create({
            gpu: fake.gpu,
            readback: { maxPendingOperations: 1, maxStagingBytes: 8 },
        })
        const source = await createSource(runtime)
        const readback = runtime.createReadback({ source })
        const bufferCount = fake.calls.buffers.length
        const encoderCount = fake.calls.commandEncoders.length

        const error = await rejectedDiagnostic(readback.toBytes())

        expect(error.diagnostic.code).to.equal('SCRATCH_READBACK_STAGING_BUDGET_EXCEEDED')
        expect(fake.calls.buffers).to.have.length(bufferCount)
        expect(fake.calls.commandEncoders).to.have.length(encoderCount)
        expect(runtime.diagnostics.snapshot().readbackMemory.currentStagingBytes).to.equal(0)
        expect(runtime.diagnostics.snapshot().pendingOperations).to.have.length(0)
    })

    it('rechecks source epoch after staging acknowledgement and before copy issue', async () => {

        const fake = createFakeGpu({ deferErrorScopePops: true })
        const runtime = await scr.ScratchRuntime.create({ gpu: fake.gpu })
        const source = await createSourceWithDeferredScopes(fake, runtime)
        const readback = runtime.createReadback({ source })
        const encoderCount = fake.calls.commandEncoders.length
        const submissionCount = fake.calls.queueSubmissions.length
        const materialization = readback.toBytes()
        const candidate = fake.calls.buffers.at(-1)

        advanceResourceContentEpochForTest(source)
        fake.errors.settlePop(2)
        fake.errors.settlePop(3)
        const error = await rejectedDiagnostic(materialization)

        expect(error.diagnostic.code).to.equal('SCRATCH_READBACK_SOURCE_EPOCH_STALE')
        expect(fake.calls.commandEncoders).to.have.length(encoderCount)
        expect(fake.calls.queueSubmissions).to.have.length(submissionCount)
        expect(candidate.destroyed).to.equal(true)
        expect(runtime.diagnostics.snapshot().readbackMemory.currentStagingBytes).to.equal(0)
        expect(runtime.diagnostics.snapshot().pendingOperations).to.have.length(0)
    })

    it('cancels pending allocation when the source is disposed and releases every owner', async () => {

        const fake = createFakeGpu({ deferErrorScopePops: true })
        const runtime = await scr.ScratchRuntime.create({ gpu: fake.gpu })
        const source = await createSourceWithDeferredScopes(fake, runtime)
        const controller = diagnosticsControllerFor(runtime)
        const readback = runtime.createReadback({ source })
        const encoderCount = fake.calls.commandEncoders.length
        const materialization = readback.toBytes()
        const candidate = fake.calls.buffers.at(-1)

        source.dispose()
        const error = await rejectedDiagnostic(materialization)
        fake.errors.settlePop(2)
        fake.errors.settlePop(3)
        await settleMicrotasks()

        expect(error.diagnostic.code).to.equal('SCRATCH_RESOURCE_DISPOSED')
        expect(error.incident).to.deep.include({
            kind: 'readback-failure',
            failureStage: 'lifecycle-recheck',
        })
        expect(candidate.destroyed).to.equal(true)
        expect(fake.calls.bufferDestroys.filter(call => call.buffer === candidate)).to.have.length(1)
        expect(fake.calls.commandEncoders).to.have.length(encoderCount)
        expect(runtime.diagnostics.snapshot().readbackMemory.currentStagingBytes).to.equal(0)
        expect(runtime.diagnostics.snapshot().pendingOperations).to.have.length(0)
        expect(controller.lifecycleSubscriberCount).to.equal(0)
    })

    it('submits a direct copy without waiting for broad submitted-work completion', async () => {

        const fake = createFakeGpu({ deferSubmittedWorkDone: true })
        const runtime = await scr.ScratchRuntime.create({ gpu: fake.gpu })
        const source = await createSource(runtime)
        const upload = runtime.createUploadCommand({
            target: source,
            data: new Uint32Array([ 1, 2, 3, 4 ]),
        })
        const submitted = runtime.submission().upload(upload).submit()
        const readback = runtime.createReadback({ source, after: submitted })
        let materialized = false
        const materialization = readback.toBytes().then(bytes => {
            materialized = true
            return bytes
        })

        await settleMicrotasks()
        const observation = {
            materialized,
            submissions: fake.calls.queueSubmissions.length,
            maps: fake.calls.maps.length,
            completionRegistrations: fake.calls.submittedWorkDoneRegistrations.length,
        }
        fake.readbacks.resolveQueueCompletion(0)
        await submitted.done
        const bytes = await materialization

        expect(observation).to.deep.equal({
            materialized: true,
            submissions: 1,
            maps: 1,
            completionRegistrations: 1,
        })
        expect(bytes).to.deep.equal(new Uint8Array(new Uint32Array([ 1, 2, 3, 4 ]).buffer))
    })
})
