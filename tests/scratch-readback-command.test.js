import { expect } from 'chai'
import * as scr from 'geoscratch'
import { advanceResourceContentEpochForTest, createFakeGpu } from './scratch-test-utils.js'

const COPY_SRC = 0x4
const COPY_DST = 0x8

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

async function createSubmittedReadback(retain = 'consume-on-read') {

    const fake = createFakeGpu()
    const runtime = await scr.ScratchRuntime.create({ gpu: fake.gpu })
    const source = await runtime.createBuffer({ size: 16, usage: COPY_SRC | COPY_DST })
    const upload = runtime.createUploadCommand({
        target: source,
        data: new Uint32Array([ 1, 2, 3, 4 ]),
    })
    const command = runtime.createReadbackCommand({
        source: { resource: source, contentEpoch: 1 },
        retain,
        whenMissing: 'throw',
    })
    const submitted = runtime.submission()
        .upload(upload)
        .readback(command)
        .submit()
    const operation = command.result({ after: submitted })

    return { fake, runtime, source, command, submitted, operation }
}

describe('scratch ReadbackCommand', () => {

    it('creates explicit buffer readback commands from both runtime factories', async () => {

        const fake = createFakeGpu()
        const runtime = await scr.ScratchRuntime.create({ gpu: fake.gpu })
        const source = await runtime.createBuffer({
            label: 'readback source',
            size: 16,
            usage: COPY_SRC | COPY_DST,
        })
        const descriptor = {
            label: 'ordered readback',
            source: { resource: source, contentEpoch: source.contentEpoch },
            range: { offset: 4, byteLength: 8 },
            retain: 'until-dispose',
            whenMissing: 'throw',
        }

        expect(runtime).to.respondTo('createReadbackCommand')
        expect(runtime).to.respondTo('readbackCommand')

        const command = runtime.createReadbackCommand(descriptor)
        const alias = runtime.readbackCommand({
            label: 'ordered readback alias',
            source: descriptor.source,
            sourceOffset: 4,
            byteLength: 8,
            whenMissing: 'throw',
        })

        expect(command).to.be.instanceOf(scr.ReadbackCommand)
        expect(alias).to.be.instanceOf(scr.ReadbackCommand)
        expect(command.commandKind).to.equal('readback')
        expect(command.source).to.deep.equal(descriptor.source)
        expect(command.range).to.deep.equal({ offset: 4, byteLength: 8 })
        expect(alias.range).to.deep.equal({ offset: 4, byteLength: 8 })
        expect(command.retain).to.equal('until-dispose')
        expect(command.whenMissing).to.equal('throw')
    })

    it('stages at the submission step and maps without a second copy', async () => {

        const fake = createFakeGpu()
        const runtime = await scr.ScratchRuntime.create({ gpu: fake.gpu })
        const source = await runtime.createBuffer({
            label: 'ordered source',
            size: 16,
            usage: COPY_SRC | COPY_DST,
        })
        const upload = runtime.createUploadCommand({
            target: source,
            data: new Uint32Array([ 11, 22, 33, 44 ]),
        })
        const command = runtime.createReadbackCommand({
            label: 'ordered readback',
            source: { resource: source, contentEpoch: source.contentEpoch + 1 },
            range: { offset: 4, byteLength: 8 },
            whenMissing: 'throw',
        })
        const builder = runtime.submission()

        expect(builder).to.respondTo('readback')

        const submitted = builder
            .upload(upload)
            .readback(command)
            .submit()
        const stagedCopyCount = fake.calls.copies.length
        const stagedSubmissionCount = fake.calls.queueSubmissions.length
        const operation = command.result({ after: submitted })

        expect(command.result({ after: submitted })).to.equal(operation)
        expect(stagedCopyCount).to.equal(1)
        expect(operation.producerEpoch?.contentEpoch).to.equal(1)
        expect(Array.from(await operation.toArray(Uint32Array))).to.deep.equal([ 22, 33 ])
        expect(fake.calls.copies).to.have.length(stagedCopyCount)
        expect(fake.calls.queueSubmissions).to.have.length(stagedSubmissionCount)
    })

    it('rejects invalid descriptors with structured diagnostics', async () => {

        const fake = createFakeGpu()
        const runtime = await scr.ScratchRuntime.create({ gpu: fake.gpu })
        const source = await runtime.createBuffer({ size: 16, usage: COPY_SRC })
        const noCopySource = await runtime.createBuffer({ size: 16, usage: COPY_DST })
        const texture = await runtime.createTexture({
            size: { width: 1, height: 1 },
            format: 'rgba8unorm',
            usage: 0x1,
        })

        for (const invalidSource of [ source, { resource: texture, contentEpoch: 0 }, { resource: source, contentEpoch: -1 } ]) {
            await expectScratchDiagnostic(() => runtime.createReadbackCommand({
                source: invalidSource,
                whenMissing: 'throw',
            }), {
                code: 'SCRATCH_READBACK_SOURCE_INVALID',
                severity: 'error',
                phase: 'command',
            })
        }

        await expectScratchDiagnostic(() => runtime.createReadbackCommand({
            source: { resource: noCopySource, contentEpoch: 0 },
            whenMissing: 'throw',
        }), {
            code: 'SCRATCH_RESOURCE_USAGE_MISSING',
            severity: 'error',
            phase: 'command',
        })

        for (const range of [
            { offset: -1, byteLength: 4 },
            { offset: 0, byteLength: 0 },
            { offset: 12, byteLength: 8 },
        ]) {
            await expectScratchDiagnostic(() => runtime.createReadbackCommand({
                source: { resource: source, contentEpoch: 0 },
                range,
                whenMissing: 'throw',
            }), {
                code: 'SCRATCH_READBACK_RANGE_INVALID',
                severity: 'error',
                phase: 'command',
            })
        }

        await expectScratchDiagnostic(() => runtime.createReadbackCommand({
            source: { resource: source, contentEpoch: 0 },
            sourceOffset: 4,
            range: { offset: 0, byteLength: 8 },
            whenMissing: 'throw',
        }), {
            code: 'SCRATCH_READBACK_RANGE_INVALID',
            severity: 'error',
            phase: 'command',
        })

        await expectScratchDiagnostic(() => runtime.createReadbackCommand({
            source: { resource: source, contentEpoch: 0 },
            retain: 'forever',
            whenMissing: 'throw',
        }), {
            code: 'SCRATCH_READBACK_RETAIN_INVALID',
            severity: 'error',
            phase: 'command',
        })

        await expectScratchDiagnostic(() => runtime.createReadbackCommand({
            source: { resource: source, contentEpoch: 0 },
        }), {
            code: 'SCRATCH_COMMAND_READINESS_POLICY_MISSING',
            severity: 'error',
            phase: 'command',
        })
    })

    it('requires an explicit submitted work that included the command', async () => {

        const fakeA = createFakeGpu()
        const fakeB = createFakeGpu()
        const runtimeA = await scr.ScratchRuntime.create({ gpu: fakeA.gpu })
        const runtimeB = await scr.ScratchRuntime.create({ gpu: fakeB.gpu })
        const source = await runtimeA.createBuffer({ size: 16, usage: COPY_SRC | COPY_DST })
        const command = runtimeA.createReadbackCommand({
            source: { resource: source, contentEpoch: 0 },
            whenMissing: 'throw',
        })
        const unrelated = runtimeA.submission().submit()
        const wrongRuntime = runtimeB.submission().submit()

        for (const after of [ undefined, wrongRuntime ]) {
            await expectScratchDiagnostic(() => command.result({ after }), {
                code: 'SCRATCH_READBACK_COMMAND_AFTER_INVALID',
                severity: 'error',
                phase: 'readback',
            })
        }

        const diagnostic = await expectScratchDiagnostic(() => command.result({ after: unrelated }), {
            code: 'SCRATCH_READBACK_COMMAND_RESULT_UNAVAILABLE',
            severity: 'error',
            phase: 'readback',
        })

        expect(diagnostic.subject).to.deep.equal(command.subject)
        expect(diagnostic.related).to.deep.include(unrelated.subject)
    })

    it('rejects duplicate use of one command in the same submission', async () => {

        const fake = createFakeGpu()
        const runtime = await scr.ScratchRuntime.create({ gpu: fake.gpu })
        const source = await runtime.createBuffer({ size: 16, usage: COPY_SRC })
        advanceResourceContentEpochForTest(source)
        const command = runtime.createReadbackCommand({
            source: { resource: source, contentEpoch: 1 },
            whenMissing: 'throw',
        })

        const diagnostic = await expectScratchDiagnostic(
            () => runtime.submission().readback(command).readback(command).submit(),
            {
                code: 'SCRATCH_READBACK_COMMAND_DUPLICATE_IN_SUBMISSION',
                severity: 'error',
                phase: 'submission',
            }
        )

        expect(diagnostic.subject).to.deep.equal(command.subject)
        expect(fake.calls.commandEncoders).to.have.length(0)
        expect(fake.calls.copies).to.have.length(0)
        expect(fake.calls.queueSubmissions).to.have.length(0)
    })

    it('rejects incompatible, wrong-runtime, and disposed submission commands', async () => {

        const fakeA = createFakeGpu()
        const fakeB = createFakeGpu()
        const runtimeA = await scr.ScratchRuntime.create({ gpu: fakeA.gpu })
        const runtimeB = await scr.ScratchRuntime.create({ gpu: fakeB.gpu })
        const sourceA = await runtimeA.createBuffer({ size: 16, usage: COPY_SRC })
        const sourceB = await runtimeB.createBuffer({ size: 16, usage: COPY_SRC })
        const upload = runtimeA.createUploadCommand({
            target: await runtimeA.createBuffer({ size: 16, usage: COPY_DST }),
            data: new Uint8Array(16),
        })
        const commandA = runtimeA.createReadbackCommand({
            source: { resource: sourceA, contentEpoch: 0 },
            whenMissing: 'throw',
        })
        const commandB = runtimeB.createReadbackCommand({
            source: { resource: sourceB, contentEpoch: 0 },
            whenMissing: 'throw',
        })

        await expectScratchDiagnostic(() => runtimeA.submission().readback(upload).submit(), {
            code: 'SCRATCH_SUBMISSION_PASS_COMMAND_INCOMPATIBLE',
            severity: 'error',
            phase: 'submission',
        })
        await expectScratchDiagnostic(() => runtimeA.submission({ validation: 'off' }).readback(commandB).submit(), {
            code: 'SCRATCH_COMMAND_WRONG_RUNTIME',
            severity: 'error',
            phase: 'command',
        })

        commandA.dispose()
        await expectScratchDiagnostic(() => runtimeA.submission({ validation: 'warn' }).readback(commandA).submit(), {
            code: 'SCRATCH_COMMAND_DISPOSED',
            severity: 'error',
            phase: 'command',
        })

        expect(fakeA.calls.commandEncoders).to.have.length(0)
        expect(fakeA.calls.queueSubmissions).to.have.length(0)
    })

    it('rejects empty sources before encoding in every validation mode', async () => {

        for (const validation of [ 'throw', 'warn', 'off' ]) {
            const fake = createFakeGpu()
            const runtime = await scr.ScratchRuntime.create({ gpu: fake.gpu })
            const source = await runtime.createBuffer({ size: 16, usage: COPY_SRC })
            const command = runtime.createReadbackCommand({
                source: { resource: source, contentEpoch: 0 },
                whenMissing: 'throw',
            })

            const diagnostic = await expectScratchDiagnostic(
                () => runtime.submission({ validation }).readback(command).submit(),
                {
                    code: 'SCRATCH_COMMAND_RESOURCE_NOT_READY',
                    severity: 'error',
                    phase: 'command',
                }
            )

            expect(diagnostic.actual).to.deep.include({
                stepIndex: 0,
                commandId: command.id,
                commandKind: 'readback',
                access: 'read',
                role: 'source',
                resourceId: source.id,
                resourceState: 'empty',
                requiredContentEpoch: 0,
            })
            expect(fake.calls.commandEncoders).to.have.length(0)
            expect(fake.calls.copies).to.have.length(0)
            expect(fake.calls.queueSubmissions).to.have.length(0)
        }
    })

    it('applies validation disposition to future and stale source epochs', async () => {

        for (const scenario of [ 'future', 'stale' ]) {
            for (const validation of [ 'throw', 'warn', 'off' ]) {
                const fake = createFakeGpu()
                const runtime = await scr.ScratchRuntime.create({ gpu: fake.gpu })
                const source = await runtime.createBuffer({ size: 16, usage: COPY_SRC | COPY_DST })
                advanceResourceContentEpochForTest(source)
                const upload = scenario === 'stale'
                    ? runtime.createUploadCommand({ target: source, data: new Uint8Array(16) })
                    : undefined
                const command = runtime.createReadbackCommand({
                    source: {
                        resource: source,
                        contentEpoch: scenario === 'future' ? 2 : 1,
                    },
                    whenMissing: 'throw',
                })
                const builder = runtime.submission({ validation })
                if (upload !== undefined) builder.upload(upload)
                builder.readback(command)
                const code = scenario === 'future'
                    ? 'SCRATCH_SUBMISSION_READ_BEFORE_WRITE'
                    : 'SCRATCH_SUBMISSION_STALE_READ'

                if (validation === 'throw') {
                    await expectScratchDiagnostic(() => builder.submit(), {
                        code,
                        severity: 'error',
                        phase: 'submission',
                    })
                    expect(fake.calls.commandEncoders).to.have.length(0)
                    expect(fake.calls.copies).to.have.length(0)
                    expect(fake.calls.queueSubmissions).to.have.length(0)
                    continue
                }

                const submitted = builder.submit()
                if (validation === 'warn') {
                    expect(submitted.report.diagnostics).to.have.length(1)
                    expect(submitted.report.diagnostics[0]).to.include({ code })
                } else {
                    expect(submitted.report.diagnostics).to.deep.equal([])
                }
                expect(fake.calls.copies).to.have.length(1)
                expect(fake.calls.queueSubmissions).to.have.length(1)
                await submitted.done
            }
        }
    })

    it('records a read-only ledger entry and preserves earlier producer provenance', async () => {

        const standaloneFake = createFakeGpu()
        const standaloneRuntime = await scr.ScratchRuntime.create({ gpu: standaloneFake.gpu })
        const standaloneSource = await standaloneRuntime.createBuffer({ size: 16, usage: COPY_SRC })
        advanceResourceContentEpochForTest(standaloneSource)
        const standaloneCommand = standaloneRuntime.createReadbackCommand({
            source: { resource: standaloneSource, contentEpoch: 1 },
            whenMissing: 'throw',
        })
        const standalone = standaloneRuntime.submission().readback(standaloneCommand).submit()

        expect(standalone.resourceAccesses).to.have.length(1)
        expect(standalone.resourceAccesses[0]).to.include({
            stepIndex: 0,
            stepKind: 'readback',
            commandKind: 'readback',
            commandId: standaloneCommand.id,
            resourceId: standaloneSource.id,
            access: 'read',
            contentEpochBefore: 1,
            contentEpochAfter: 1,
        })
        expect(standalone.producerEpochs).to.deep.equal([])
        expect(standaloneSource.contentEpoch).to.equal(1)

        const producedFake = createFakeGpu()
        const producedRuntime = await scr.ScratchRuntime.create({ gpu: producedFake.gpu })
        const producedSource = await producedRuntime.createBuffer({ size: 16, usage: COPY_SRC | COPY_DST })
        const upload = producedRuntime.createUploadCommand({
            target: producedSource,
            data: new Uint8Array(16),
        })
        const producedCommand = producedRuntime.createReadbackCommand({
            source: { resource: producedSource, contentEpoch: 1 },
            whenMissing: 'throw',
        })
        const produced = producedRuntime.submission()
            .upload(upload)
            .readback(producedCommand)
            .submit()
        const producerEpoch = produced.producerEpochs.find(epoch => epoch.resourceId === producedSource.id)
        const operation = producedCommand.result({ after: produced })

        expect(produced.resourceAccesses.map(access => access.access)).to.deep.equal([ 'write', 'read' ])
        expect(producerEpoch?.producedBy).to.include({
            stepIndex: 0,
            stepKind: 'upload',
            commandKind: 'upload',
        })
        expect(operation.producerEpoch).to.equal(producerEpoch)
        expect(operation.contentEpoch).to.equal(1)
    })

    it('pins bytes and producer provenance to the readback step before later GPU writes', async () => {

        const fake = createFakeGpu()
        const runtime = await scr.ScratchRuntime.create({ gpu: fake.gpu })
        const source = await runtime.createBuffer({ size: 8, usage: COPY_SRC | COPY_DST })
        const laterSource = await runtime.createBuffer({ size: 8, usage: COPY_SRC | COPY_DST })
        const firstUpload = runtime.createUploadCommand({
            label: 'first producer',
            target: source,
            data: new Uint32Array([ 10, 20 ]),
        })
        const laterSourceUpload = runtime.createUploadCommand({
            label: 'later source producer',
            target: laterSource,
            data: new Uint32Array([ 30, 40 ]),
        })
        const command = runtime.createReadbackCommand({
            source: { resource: source, contentEpoch: 1 },
            whenMissing: 'throw',
        })
        const laterCopy = runtime.createCopyCommand({
            label: 'later GPU producer',
            source: { resource: laterSource, contentEpoch: 1 },
            target: source,
            byteLength: 8,
            whenMissing: 'throw',
        })
        const submitted = runtime.submission()
            .upload(firstUpload)
            .upload(laterSourceUpload)
            .readback(command)
            .copy(laterCopy)
            .submit()
        const operation = command.result({ after: submitted })

        expect(source.contentEpoch).to.equal(2)
        expect(operation.contentEpoch).to.equal(1)
        expect(operation.producerEpoch?.producedBy).to.include({
            stepIndex: 0,
            stepKind: 'upload',
            commandId: firstUpload.id,
        })
        expect(Array.from(await operation.toArray(Uint32Array))).to.deep.equal([ 10, 20 ])
        expect(fake.calls.copies).to.have.length(2)
    })

    it('keeps a staged result retrievable after the source is disposed', async () => {

        const { source, command, submitted, operation } = await createSubmittedReadback()

        source.dispose()

        expect(command.result({ after: submitted })).to.equal(operation)
        expect(Array.from(await operation.toArray(Uint32Array))).to.deep.equal([ 1, 2, 3, 4 ])
    })

    it('keeps scheduled consume-on-read semantics', async () => {

        const { fake, operation } = await createSubmittedReadback()
        const stagingBuffer = operation.stagingBuffer

        expect(Array.from(await operation.toArray(Uint32Array))).to.deep.equal([ 1, 2, 3, 4 ])
        expect(operation.state).to.equal('consumed')
        expect(stagingBuffer.destroyed).to.equal(true)
        expect(fake.calls.copies).to.have.length(1)
        expect(fake.calls.maps).to.have.length(1)

        await expectScratchDiagnostic(() => operation.toBytes(), {
            code: 'SCRATCH_READBACK_ALREADY_CONSUMED',
            severity: 'error',
            phase: 'readback',
        })
        expect(fake.calls.copies).to.have.length(1)
        expect(fake.calls.maps).to.have.length(1)
    })

    it('retains one scheduled mapping until dispose', async () => {

        const { fake, operation } = await createSubmittedReadback('until-dispose')
        const first = await operation.toBytes()
        const second = await operation.toBytes()

        expect(first).to.deep.equal(second)
        expect(first).to.not.equal(second)
        expect(operation.state).to.equal('ready')
        expect(operation.isResultRetained).to.equal(true)
        expect(operation.retainedByteLength).to.equal(16)
        expect(fake.calls.copies).to.have.length(1)
        expect(fake.calls.maps).to.have.length(1)

        operation.dispose()

        expect(operation.state).to.equal('disposed')
        expect(operation.isResultRetained).to.equal(false)
        await expectScratchDiagnostic(() => operation.toBytes(), {
            code: 'SCRATCH_READBACK_OPERATION_DISPOSED',
            severity: 'error',
            phase: 'readback',
        })
    })

    it('preserves layout-aware views on the scheduled path', async () => {

        const fake = createFakeGpu()
        const runtime = await scr.ScratchRuntime.create({ gpu: fake.gpu })
        const codec = scr.layoutCodec({
            name: 'OrderedReadbackValue',
            fields: [ { name: 'value', type: 'f32' } ],
        }, {
            usage: [ 'storage', 'readback' ],
        })
        const values = [ { value: 3 }, { value: 7 } ]
        const uploadBytes = codec.pack(values)
        const source = await runtime.createBuffer({
            size: uploadBytes.byteLength,
            usage: COPY_SRC | COPY_DST,
            layout: codec.artifact,
            elementCount: values.length,
        })
        const upload = runtime.createUploadCommand({ target: source, data: uploadBytes })
        const command = runtime.createReadbackCommand({
            source: { resource: source, contentEpoch: 1 },
            whenMissing: 'throw',
        })
        const submitted = runtime.submission().upload(upload).readback(command).submit()
        const view = await command.result({ after: submitted }).toLayoutView()

        expect(view.artifact).to.equal(codec.artifact)
        expect(view.toArray()).to.deep.equal(values)
        expect(fake.calls.copies).to.have.length(1)
    })

    it('releases scheduled staging when cancelled or disposed before mapping', async () => {

        for (const lifecycle of [ 'cancel', 'dispose' ]) {
            const { fake, operation } = await createSubmittedReadback()
            const stagingBuffer = operation.stagingBuffer

            if (lifecycle === 'cancel') {
                operation.cancel('not needed')
            } else {
                operation.dispose()
            }

            expect(stagingBuffer.destroyed).to.equal(true)
            expect(operation.stagingBuffer).to.equal(undefined)
            await expectScratchDiagnostic(() => operation.toBytes(), {
                code: lifecycle === 'cancel'
                    ? 'SCRATCH_READBACK_CANCELLED'
                    : 'SCRATCH_READBACK_OPERATION_DISPOSED',
                severity: 'error',
                phase: 'readback',
            })
            expect(fake.calls.copies).to.have.length(1)
            expect(fake.calls.maps).to.have.length(0)
        }
    })

    it('marks scheduled map failures and releases staging', async () => {

        const { operation } = await createSubmittedReadback()
        const stagingBuffer = operation.stagingBuffer
        stagingBuffer.mapAsync = async() => {
            throw new Error('map failed')
        }

        await expectScratchDiagnostic(() => operation.toBytes(), {
            code: 'SCRATCH_READBACK_MAP_FAILED',
            severity: 'error',
            phase: 'readback',
        })

        expect(operation.state).to.equal('failed')
        expect(operation.stagingBuffer).to.equal(undefined)
        expect(stagingBuffer.destroyed).to.equal(true)
    })
})
