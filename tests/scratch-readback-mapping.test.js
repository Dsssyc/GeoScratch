import { expect } from 'chai'
import * as scr from 'geoscratch'
import { createFakeGpu } from './scratch-test-utils.js'

const COPY_SRC = 0x4
const COPY_DST = 0x8

async function settleMicrotasks(count = 16) {

    for (let index = 0; index < count; index++) await Promise.resolve()
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

async function createDirectReadback(fakeOptions = {}, retain = 'consume-on-read') {

    const fake = createFakeGpu(fakeOptions)
    const runtime = await scr.ScratchRuntime.create({ gpu: fake.gpu })
    let source
    if (fakeOptions.deferErrorScopePops) {
        const creation = runtime.createBuffer({ size: 16, usage: COPY_SRC | COPY_DST })
        fake.errors.settlePop(0)
        fake.errors.settlePop(1)
        source = await creation
    } else {
        source = await runtime.createBuffer({ size: 16, usage: COPY_SRC | COPY_DST })
    }
    const operation = runtime.createReadback({ source, retain })
    return { fake, runtime, source, operation }
}

async function createOrderedReadback(fakeOptions = {}) {

    const fake = createFakeGpu(fakeOptions)
    const runtime = await scr.ScratchRuntime.create({ gpu: fake.gpu })
    const source = await runtime.createBuffer({ size: 16, usage: COPY_SRC | COPY_DST })
    const upload = runtime.createUploadCommand({
        target: source,
        data: new Uint8Array(16),
    })
    const command = await runtime.createReadbackCommand({
        source: { resource: source, contentEpoch: 1 },
        whenMissing: 'throw',
    })
    const stagingBuffer = fake.calls.buffers.at(-1)
    const submitted = runtime.submission().upload(upload).readback(command).submit()
    const operation = command.result({ after: submitted })
    return { fake, runtime, source, command, stagingBuffer, submitted, operation }
}

describe('scratch readback mapping transaction', () => {

    it('issues one map under balanced scopes and joins settlement order independently', async () => {

        const { fake, runtime, operation } = await createDirectReadback({
            deferErrorScopePops: true,
            deferMaps: true,
        })
        const materialization = operation.toBytes()
        fake.errors.settlePop(3)
        fake.errors.settlePop(2)
        await settleMicrotasks()

        const mapIndex = fake.calls.nativeTimeline.findLastIndex(event => event.type === 'map-async')
        const mappingBoundary = fake.calls.nativeTimeline.slice(mapIndex - 3, mapIndex + 4)
        const mappingPops = fake.errors.pendingPops.slice(4)
        for (const index of [ 6, 4, 5 ]) {
            if (fake.errors.pendingPops[index] !== undefined && !fake.errors.pendingPops[index].settled) {
                fake.errors.settlePop(index)
            }
        }
        fake.readbacks.resolveMap(0)
        expect(await materialization).to.deep.equal(new Uint8Array(16))

        expect(mappingBoundary.map(event => `${event.type}:${event.filter ?? ''}`)).to.deep.equal([
            'push-error-scope:out-of-memory',
            'push-error-scope:internal',
            'push-error-scope:validation',
            'map-async:',
            'pop-error-scope:validation',
            'pop-error-scope:internal',
            'pop-error-scope:out-of-memory',
        ])
        expect(mappingPops.map(pop => pop.filter)).to.deep.equal([
            'validation',
            'internal',
            'out-of-memory',
        ])
        expect(fake.errors.scopeDepth).to.equal(0)
        expect(fake.calls.maps).to.have.length(1)
        expect(runtime.diagnostics.operations({
            kind: 'readback-mapping',
            readbackId: operation.id,
        }).at(-1)).to.deep.include({
            kind: 'readback-mapping',
            status: 'succeeded',
        })
    })

    for (const scenario of [
        {
            filter: 'validation',
            code: 'SCRATCH_READBACK_MAPPING_VALIDATION_FAILED',
            name: 'GPUValidationError',
        },
        {
            filter: 'internal',
            code: 'SCRATCH_READBACK_MAPPING_INTERNAL_FAILED',
            name: 'GPUInternalError',
        },
        {
            filter: 'out-of-memory',
            code: 'SCRATCH_READBACK_MAPPING_OUT_OF_MEMORY',
            name: 'GPUOutOfMemoryError',
        },
    ]) {
        it(`classifies captured ${scenario.filter} without message parsing`, async () => {

            const { fake, runtime, operation } = await createDirectReadback()
            const nativeError = Object.assign(new Error(`opaque ${scenario.filter}`), {
                name: scenario.name,
            })
            fake.errors.failNext('mapAsync', scenario.filter, nativeError)

            const error = await rejectedDiagnostic(operation.toBytes())

            expect(error.diagnostic.code).to.equal(scenario.code)
            expect(error.cause).to.equal(nativeError)
            expect(error.incident).to.deep.include({
                kind: 'readback-failure',
                nativeErrorCategory: scenario.filter,
                failureStage: 'mapping',
            })
            expect(error.incident.outcomes.find(outcome => outcome.diagnosticCode === scenario.code)).to.deep.include({
                stage: 'mapping',
                diagnosticCode: scenario.code,
                nativeErrorCategory: scenario.filter,
            })
            expect(runtime.diagnostics.snapshot().pendingOperations).to.deep.equal([])
            expect(runtime.diagnostics.snapshot().readbacks).to.deep.equal([])
        })
    }

    it('does not promote a rejected map Promise to OOM without captured OOM evidence', async () => {

        const { fake, operation } = await createDirectReadback()
        const nativeError = new DOMException('opaque map rejection', 'OperationError')
        fake.readbacks.rejectNextMap(nativeError)

        const error = await rejectedDiagnostic(operation.toBytes())

        expect(error.diagnostic.code).to.equal('SCRATCH_READBACK_MAPPING_REJECTED')
        expect(error.cause).to.equal(nativeError)
        expect(error.incident).to.deep.include({
            nativeErrorCategory: 'native-exception',
            failureStage: 'mapping',
        })
        expect(error.incident.nativeErrorCategory).not.to.equal('out-of-memory')
    })

    it('reports mapping scope settlement failure after every scope is popped', async () => {

        const { fake, operation } = await createDirectReadback({
            deferErrorScopePops: true,
            deferMaps: true,
        })
        const materialization = operation.toBytes()
        fake.errors.settlePop(2)
        fake.errors.settlePop(3)
        await settleMicrotasks()

        if (fake.errors.pendingPops[4] !== undefined) {
            fake.errors.rejectPop(4, new Error('validation pop failed'))
            fake.errors.settlePop(5)
            fake.errors.settlePop(6)
        }
        fake.readbacks.resolveMap(0)
        const error = await rejectedDiagnostic(materialization)

        expect(error.diagnostic.code).to.equal('SCRATCH_READBACK_MAPPING_SCOPE_FAILED')
        expect(error.incident).to.deep.include({
            nativeErrorCategory: 'scope-failure',
            failureStage: 'mapping',
        })
        expect(fake.errors.scopeDepth).to.equal(0)
    })

    it('distinguishes mapped-range access from host-copy failure', async () => {

        for (const scenario of [
            {
                stage: 'mapped-range',
                code: 'SCRATCH_READBACK_MAPPED_RANGE_FAILED',
                configure(fake, error) {

                    fake.errors.throwNext('getMappedRange', error)
                },
            },
            {
                stage: 'host-copy',
                code: 'SCRATCH_READBACK_HOST_COPY_FAILED',
                configure(fake) {

                    fake.readbacks.detachNextMappedRange()
                },
            },
        ]) {
            const { fake, operation } = await createDirectReadback()
            const nativeError = new DOMException(`${scenario.stage} failed`, 'OperationError')
            scenario.configure(fake, nativeError)

            const error = await rejectedDiagnostic(operation.toBytes())

            expect(error.diagnostic.code).to.equal(scenario.code)
            expect(error.incident).to.deep.include({
                kind: 'readback-failure',
                failureStage: scenario.stage,
            })
            expect(operation.state).to.equal('failed')
        }
    })

    it('classifies a direct encoder exception as copy issue and preserves that code', async () => {

        const { fake, runtime, operation } = await createDirectReadback()
        const nativeError = new Error('copy encoder unavailable')
        fake.device.createCommandEncoder = () => {
            throw nativeError
        }

        const error = await rejectedDiagnostic(operation.toBytes())
        const repeated = await rejectedDiagnostic(operation.toBytes())
        const incident = runtime.diagnostics.incidents({ readbackId: operation.id })
            .find(candidate => candidate.failureStage === 'copy-issue')

        expect(error.diagnostic.code).to.equal('SCRATCH_READBACK_COPY_ISSUE_FAILED')
        expect(error.cause).to.equal(nativeError)
        expect(repeated.diagnostic.code).to.equal('SCRATCH_READBACK_COPY_ISSUE_FAILED')
        expect(incident).to.deep.include({
            diagnosticCode: 'SCRATCH_READBACK_COPY_ISSUE_FAILED',
            nativeErrorCategory: 'native-exception',
            attribution: 'exact-operation',
            failureStage: 'copy-issue',
        })
        expect(operation.state).to.equal('failed')
        expect(fake.calls.maps).to.have.length(0)
        expect(runtime.diagnostics.snapshot().readbackMemory.currentStagingBytes).to.equal(0)
    })

    for (const lifecycle of [ 'cancel', 'dispose' ]) {
        it(`preserves ${lifecycle} while map cancellation rejects`, async () => {

            const { fake, runtime, operation } = await createDirectReadback({ deferMaps: true })
            const materialization = operation.toBytes()
            await settleMicrotasks()
            expect(fake.readbacks.mapRequests).to.have.length(1)

            if (lifecycle === 'cancel') operation.cancel('not needed')
            else operation.dispose()
            const error = await rejectedDiagnostic(materialization)

            expect(error.diagnostic.code).to.equal(
                lifecycle === 'cancel'
                    ? 'SCRATCH_READBACK_CANCELLED'
                    : 'SCRATCH_READBACK_OPERATION_DISPOSED'
            )
            expect(operation.state).to.equal(lifecycle === 'cancel' ? 'cancelled' : 'disposed')
            expect(fake.readbacks.mapRequests[0].settled).to.equal(true)
            expect(runtime.diagnostics.snapshot().readbacks).to.deep.equal([])
            expect(runtime.diagnostics.snapshot().readbackMemory.activeMappings).to.equal(0)
            expect(runtime.diagnostics.snapshot().readbackMemory.currentStagingBytes).to.equal(0)
        })
    }

    it('shares one materialization for concurrent retained readers and returns owned clones', async () => {

        const { fake, operation } = await createDirectReadback({ deferMaps: true }, 'until-dispose')
        const first = operation.toBytes()
        const second = operation.toBytes()
        await settleMicrotasks()
        for (const [index, request] of fake.readbacks.mapRequests.entries()) {
            if (!request.settled) fake.readbacks.resolveMap(index)
        }
        const [ firstResult, secondResult ] = await Promise.all([ first, second ])

        expect(fake.calls.maps).to.have.length(1)
        expect(firstResult).to.deep.equal(secondResult)
        expect(firstResult).not.to.equal(secondResult)
        expect(operation.state).to.equal('ready')
        expect(operation.isResultRetained).to.equal(true)
    })

    it('rejects a competing consume-on-read caller without a second native transaction', async () => {

        const { fake, operation } = await createDirectReadback({ deferMaps: true })
        const first = operation.toBytes()
        const second = operation.toBytes()
        await settleMicrotasks()
        for (const [index, request] of fake.readbacks.mapRequests.entries()) {
            if (!request.settled) fake.readbacks.resolveMap(index)
        }
        const [ firstResult, secondResult ] = await Promise.allSettled([ first, second ])

        expect(firstResult.status).to.equal('fulfilled')
        expect(secondResult.status).to.equal('rejected')
        expect(secondResult.reason).to.be.instanceOf(scr.ScratchDiagnosticError)
        expect(secondResult.reason.diagnostic.code).to.equal('SCRATCH_READBACK_IN_PROGRESS')
        expect(fake.calls.maps).to.have.length(1)
        expect(operation.state).to.equal('consumed')
    })

    it('releases pending mapping ownership on device loss without changing the cancelled terminal state', async () => {

        const { fake, runtime, operation } = await createDirectReadback({ deferMaps: true })
        const materialization = operation.toBytes()
        await settleMicrotasks()
        const stagingBuffer = fake.calls.buffers.at(-1)
        fake.errors.loseDevice({ reason: 'unknown', message: 'mapping device loss' })
        const error = await rejectedDiagnostic(materialization)
        await settleMicrotasks()

        expect(error.diagnostic.code).to.equal('SCRATCH_RUNTIME_DEVICE_LOST')
        expect(operation.state).to.equal('cancelled')
        expect(stagingBuffer.destroyed).to.equal(true)
        expect(runtime.diagnostics.snapshot().readbacks).to.deep.equal([])
        expect(runtime.diagnostics.snapshot().readbackMemory.currentStagingBytes).to.equal(0)
        expect(runtime.diagnostics.snapshot().readbackMemory.activeMappings).to.equal(0)
    })

    it('retains simultaneous scope and device-loss outcomes in fixed mapping evidence', async () => {

        const { fake, runtime, operation } = await createDirectReadback({
            deferErrorScopePops: true,
            deferMaps: true,
        })
        const validation = Object.assign(new Error('simultaneous validation'), {
            name: 'GPUValidationError',
        })
        fake.errors.failNext('mapAsync', 'validation', validation)
        const materialization = operation.toBytes()
        fake.errors.settlePop(3)
        fake.errors.settlePop(2)
        await settleMicrotasks()
        fake.errors.loseDevice({ reason: 'unknown', message: 'simultaneous device loss' })
        await settleMicrotasks()
        for (const [index, pending] of fake.errors.pendingPops.entries()) {
            if (!pending.settled) fake.errors.settlePop(index)
        }

        const error = await rejectedDiagnostic(materialization)
        const mappingRecord = runtime.diagnostics.operations({
            kind: 'readback-mapping',
            readbackId: operation.id,
        }).at(-1)
        const incident = runtime.diagnostics.incidents({ readbackId: operation.id })
            .find(candidate => candidate.failureStage === 'lifecycle-recheck')

        expect(error.diagnostic.code).to.equal('SCRATCH_RUNTIME_DEVICE_LOST')
        expect(operation.state).to.equal('cancelled')
        expect(mappingRecord).to.deep.include({
            status: 'cancelled',
            nativeErrorCategory: 'device-lost',
        })
        expect(incident).to.deep.include({
            diagnosticCode: 'SCRATCH_RUNTIME_DEVICE_LOST',
            attribution: 'temporal-correlation',
            failureStage: 'lifecycle-recheck',
        })
        expect(incident.outcomes.map(outcome => outcome.diagnosticCode)).to.deep.equal([
            'SCRATCH_READBACK_MAPPING_VALIDATION_FAILED',
            'SCRATCH_READBACK_MAPPING_REJECTED',
            'SCRATCH_RUNTIME_DEVICE_LOST',
        ])
    })

    it('returns owned bytes while recording unmap and destroy cleanup failures', async () => {

        for (const nativeMethod of [ 'unmap', 'destroyBuffer' ]) {
            const { fake, runtime, operation } = await createDirectReadback()
            const cleanupFailure = new Error(`${nativeMethod} cleanup failure`)
            fake.errors.throwNext(nativeMethod, cleanupFailure)

            const bytes = await operation.toBytes()
            const mappingRecord = runtime.diagnostics.operations({
                kind: 'readback-mapping',
                readbackId: operation.id,
            }).at(-1)
            const releaseRecord = runtime.diagnostics.operations({
                kind: 'readback-staging-release',
                readbackId: operation.id,
            }).at(-1)
            const cleanupIncident = runtime.diagnostics.incidents({ readbackId: operation.id })
                .find(incident => incident.failureStage === 'cleanup')

            expect(bytes).to.deep.equal(new Uint8Array(16))
            expect(operation.state).to.equal('consumed')
            expect(mappingRecord).to.deep.include({
                status: 'failed',
                nativeErrorCategory: 'native-exception',
            })
            expect(releaseRecord).to.deep.include({
                status: 'failed',
                nativeErrorCategory: 'native-exception',
            })
            expect(cleanupIncident).to.deep.include({
                kind: 'readback-failure',
                diagnosticCode: 'SCRATCH_READBACK_CLEANUP_FAILED',
                failureStage: 'cleanup',
            })
            expect(cleanupIncident.outcomes[0].diagnosticCode).to.equal(
                nativeMethod === 'unmap'
                    ? 'SCRATCH_READBACK_UNMAP_FAILED'
                    : 'SCRATCH_READBACK_STAGING_DESTROY_FAILED'
            )
            expect(cleanupIncident.outcomes[0].nativeError.message).to.equal(cleanupFailure.message)
            expect(runtime.diagnostics.snapshot().readbackMemory.currentStagingBytes).to.equal(0)
            expect(runtime.diagnostics.snapshot().readbackMemory.activeMappings).to.equal(0)
        }
    })

    it('retires an ordered slot after unmap cleanup failure instead of reusing it', async () => {

        const { fake, runtime, command, stagingBuffer, operation } = await createOrderedReadback()
        const cleanupFailure = new Error('ordered unmap cleanup failure')
        fake.errors.throwNext('unmap', cleanupFailure)

        expect(await operation.toBytes()).to.deep.equal(new Uint8Array(16))

        expect(operation.state).to.equal('consumed')
        expect(command.state).to.equal('failed')
        expect(stagingBuffer.destroyed).to.equal(true)
        expect(runtime.diagnostics.operations({
            kind: 'readback-mapping',
            readbackId: operation.id,
        }).at(-1)).to.deep.include({
            status: 'failed',
            nativeErrorCategory: 'native-exception',
        })
        expect(runtime.diagnostics.operations({
            kind: 'readback-staging-release',
            readbackId: operation.id,
        }).at(-1)).to.deep.include({
            status: 'failed',
            nativeErrorCategory: 'native-exception',
        })
        expect(runtime.diagnostics.incidents({ readbackId: operation.id })
            .find(candidate => candidate.failureStage === 'cleanup')
            .outcomes[0].diagnosticCode).to.equal('SCRATCH_READBACK_UNMAP_FAILED')
        expect(runtime.diagnostics.snapshot().readbackMemory.currentStagingBytes).to.equal(0)
    })

    it('attributes ordered destroy failure to the mapping that releases a disposed command', async () => {

        const { fake, runtime, command, stagingBuffer, operation } = await createOrderedReadback({
            deferMaps: true,
        })
        const materialization = operation.toBytes()
        await settleMicrotasks()
        command.dispose()
        const cleanupFailure = new Error('ordered destroy cleanup failure')
        fake.errors.throwNext('destroyBuffer', cleanupFailure)
        fake.readbacks.resolveMap(0)

        expect(await materialization).to.deep.equal(new Uint8Array(16))
        const incident = runtime.diagnostics.incidents({ readbackId: operation.id })
            .find(candidate => candidate.failureStage === 'cleanup')

        expect(operation.state).to.equal('consumed')
        expect(command.state).to.equal('disposed')
        expect(stagingBuffer.destroyed).to.equal(false)
        expect(incident).to.deep.include({
            diagnosticCode: 'SCRATCH_READBACK_CLEANUP_FAILED',
            nativeErrorCategory: 'native-exception',
            failureStage: 'cleanup',
        })
        expect(incident.outcomes[0].diagnosticCode).to.equal(
            'SCRATCH_READBACK_STAGING_DESTROY_FAILED'
        )
        expect(incident.outcomes[0].nativeError.message).to.equal(cleanupFailure.message)
        expect(runtime.diagnostics.snapshot().readbackMemory.currentStagingBytes).to.equal(0)
        expect(runtime.diagnostics.snapshot().readbackMemory.activeMappings).to.equal(0)
    })
})
