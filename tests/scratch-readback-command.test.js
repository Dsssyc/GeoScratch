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

async function createSubmittedReadback(retain = 'consume-on-read', fakeOptions = {}) {

    const fake = createFakeGpu(fakeOptions)
    const runtime = await scr.ScratchRuntime.create({ gpu: fake.gpu })
    const source = await runtime.createBuffer({ size: 16, usage: COPY_SRC | COPY_DST })
    const upload = runtime.createUploadCommand({
        target: (source).region(),
        data: new Uint32Array([ 1, 2, 3, 4 ]),
    })
    const command = await runtime.createReadbackCommand({
        source: { region: (source).region(), contentEpoch: 1 },
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
        const region = source.region({ offset: 4, size: 8 })
        const descriptor = {
            label: 'ordered readback',
            source: { region, contentEpoch: source.contentEpoch },
            retain: 'until-dispose',
            whenMissing: 'throw',
        }

        expect(runtime).to.respondTo('createReadbackCommand')
        expect(runtime).to.respondTo('readbackCommand')

        const command = await runtime.createReadbackCommand(descriptor)
        const alias = await runtime.readbackCommand({
            label: 'ordered readback alias',
            source: descriptor.source,
            whenMissing: 'throw',
        })

        expect(command).to.be.instanceOf(scr.ReadbackCommand)
        expect(alias).to.be.instanceOf(scr.ReadbackCommand)
        expect(command.commandKind).to.equal('readback')
        expect(command.source).to.deep.equal(descriptor.source)
        expect(command.source.region).to.equal(region)
        expect(command.source.region).to.include({ offset: 4, size: 8 })
        expect(alias.source.region).to.equal(region)
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
            target: (source).region(),
            data: new Uint32Array([ 11, 22, 33, 44 ]),
        })
        const command = await runtime.createReadbackCommand({
            label: 'ordered readback',
            source: { region: (source).region({ offset: 4, size: 8 }), contentEpoch: source.contentEpoch + 1 },
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

        for (const invalidSource of [ source, { region: texture, contentEpoch: 0 }, { region: source.region(), contentEpoch: -1 } ]) {
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
            source: { region: (noCopySource).region(), contentEpoch: 0 },
            whenMissing: 'throw',
        }), {
            code: 'SCRATCH_RESOURCE_USAGE_MISSING',
            severity: 'error',
            phase: 'command',
        })

        await expectScratchDiagnostic(() => runtime.createReadbackCommand({
            source: { region: source.region({ size: 0 }), contentEpoch: 0 },
            whenMissing: 'throw',
        }), {
            code: 'SCRATCH_READBACK_SOURCE_INVALID',
            severity: 'error',
            phase: 'command',
        })

        await expectScratchDiagnostic(() => runtime.createReadbackCommand({
            source: { region: (source).region(), contentEpoch: 0 },
            retain: 'forever',
            whenMissing: 'throw',
        }), {
            code: 'SCRATCH_READBACK_RETAIN_INVALID',
            severity: 'error',
            phase: 'command',
        })

        await expectScratchDiagnostic(() => runtime.createReadbackCommand({
            source: { region: (source).region(), contentEpoch: 0 },
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
        const command = await runtimeA.createReadbackCommand({
            source: { region: (source).region(), contentEpoch: 0 },
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
        const command = await runtime.createReadbackCommand({
            source: { region: (source).region(), contentEpoch: 1 },
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
            target: (await runtimeA.createBuffer({ size: 16, usage: COPY_DST })).region(),
            data: new Uint8Array(16),
        })
        const commandA = await runtimeA.createReadbackCommand({
            source: { region: (sourceA).region(), contentEpoch: 0 },
            whenMissing: 'throw',
        })
        const commandB = await runtimeB.createReadbackCommand({
            source: { region: (sourceB).region(), contentEpoch: 0 },
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
            const command = await runtime.createReadbackCommand({
                source: { region: (source).region(), contentEpoch: 0 },
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
                    ? runtime.createUploadCommand({ target: (source).region(), data: new Uint8Array(16) })
                    : undefined
                const command = await runtime.createReadbackCommand({
                    source: {
                        region: (source).region(),
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
        const standaloneCommand = await standaloneRuntime.createReadbackCommand({
            source: { region: (standaloneSource).region(), contentEpoch: 1 },
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
            target: (producedSource).region(),
            data: new Uint8Array(16),
        })
        const producedCommand = await producedRuntime.createReadbackCommand({
            source: { region: (producedSource).region(), contentEpoch: 1 },
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
            target: (source).region(),
            data: new Uint32Array([ 10, 20 ]),
        })
        const laterSourceUpload = runtime.createUploadCommand({
            label: 'later source producer',
            target: (laterSource).region(),
            data: new Uint32Array([ 30, 40 ]),
        })
        const command = await runtime.createReadbackCommand({
            source: { region: (source).region(), contentEpoch: 1 },
            whenMissing: 'throw',
        })
        const laterCopy = runtime.createCopyCommand({
            label: 'later GPU producer',
            source: { region: laterSource.region(), contentEpoch: 1 },
            target: source.region(),
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

        const { fake, command, operation } = await createSubmittedReadback()
        const stagingBuffer = fake.calls.buffers.at(-1)

        expect(Array.from(await operation.toArray(Uint32Array))).to.deep.equal([ 1, 2, 3, 4 ])
        expect(operation.state).to.equal('consumed')
        expect(command.state).to.equal('idle')
        expect(stagingBuffer.destroyed).to.equal(false)
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
        })
        const region = source.region({ layout: codec.artifact })
        const upload = runtime.createUploadCommand({ target: region, data: uploadBytes })
        const command = await runtime.createReadbackCommand({
            source: { region, contentEpoch: 1 },
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
            const { fake, command, submitted, operation } = await createSubmittedReadback()
            const stagingBuffer = fake.calls.buffers.at(-1)

            if (lifecycle === 'cancel') {
                operation.cancel('not needed')
            } else {
                operation.dispose()
            }

            await submitted.done
            await Promise.resolve()
            expect(command.state).to.equal('idle')
            expect(stagingBuffer.destroyed).to.equal(false)
            expect(operation).not.to.have.property('stagingBuffer')
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

        const { fake, command, submitted, operation } = await createSubmittedReadback()
        const stagingBuffer = fake.calls.buffers.at(-1)
        fake.readbacks.rejectNextMap(new Error('map failed'))

        await expectScratchDiagnostic(() => operation.toBytes(), {
            code: 'SCRATCH_READBACK_MAPPING_REJECTED',
            severity: 'error',
            phase: 'readback',
        })
        await submitted.done
        await Promise.resolve()

        expect(operation.state).to.equal('failed')
        expect(operation).not.to.have.property('stagingBuffer')
        expect(command.state).to.equal('idle')
        expect(stagingBuffer.destroyed).to.equal(false)
    })

    it('keeps submitted completion independent from pending mapping', async () => {

        const { fake, submitted, operation } = await createSubmittedReadback(
            'consume-on-read',
            { deferMaps: true }
        )
        const materialization = operation.toBytes()

        expect(fake.readbacks.mapRequests).to.have.length(1)
        expect(operation.state).to.equal('mapping')
        await submitted.done
        expect(operation.state).to.equal('mapping')

        fake.readbacks.resolveMap(0)
        expect(Array.from(await materialization)).to.deep.equal(
            Array.from(new Uint8Array(new Uint32Array([ 1, 2, 3, 4 ]).buffer))
        )
    })

    it('keeps an exact submitted result retrievable after command disposal', async () => {

        const fake = createFakeGpu()
        const runtime = await scr.ScratchRuntime.create({ gpu: fake.gpu })
        const source = await runtime.createBuffer({ size: 16, usage: COPY_SRC | COPY_DST })
        const upload = runtime.createUploadCommand({
            target: (source).region(),
            data: new Uint32Array([ 1, 2, 3, 4 ]),
        })
        const command = await runtime.createReadbackCommand({
            source: { region: (source).region(), contentEpoch: 1 },
            whenMissing: 'throw',
        })
        const stagingBuffer = fake.calls.buffers.at(-1)
        const submitted = runtime.submission().upload(upload).readback(command).submit()

        command.dispose()
        expect(command.state).to.equal('releasing')
        const operation = command.result({ after: submitted })
        expect(Array.from(await operation.toArray(Uint32Array))).to.deep.equal([ 1, 2, 3, 4 ])

        expect(command.state).to.equal('disposed')
        expect(stagingBuffer.destroyed).to.equal(true)
        expect(runtime.diagnostics.snapshot().readbackCommands).to.deep.equal([])
        expect(runtime.diagnostics.snapshot().readbackMemory.currentStagingBytes).to.equal(0)
        await expectScratchDiagnostic(() => runtime.submission().readback(command).submit(), {
            code: 'SCRATCH_COMMAND_DISPOSED',
            phase: 'command',
        })
    })

    it('wraps queue completion rejection without rewriting the linked readback', async () => {

        const fake = createFakeGpu()
        const runtime = await scr.ScratchRuntime.create({ gpu: fake.gpu })
        const source = await runtime.createBuffer({ size: 16, usage: COPY_SRC | COPY_DST })
        const upload = runtime.createUploadCommand({
            target: (source).region(),
            data: new Uint32Array([ 1, 2, 3, 4 ]),
        })
        const command = await runtime.createReadbackCommand({
            source: { region: (source).region(), contentEpoch: 1 },
            whenMissing: 'throw',
        })
        const nativeFailure = new Error('fake queue completion failure')
        fake.readbacks.rejectNextQueueCompletion(nativeFailure)
        const submitted = runtime.submission().upload(upload).readback(command).submit()
        const operation = command.result({ after: submitted })

        let caught
        try {
            await submitted.done
        } catch (error) {
            caught = error
        }

        expect(caught).to.be.instanceOf(scr.ScratchDiagnosticError)
        expect(caught.cause).to.equal(nativeFailure)
        expect(caught.diagnostic).to.deep.include({
            code: 'SCRATCH_SUBMISSION_QUEUE_COMPLETION_FAILED',
            severity: 'error',
            phase: 'submission',
        })
        expect(caught.diagnostic.related.map(subject => subject.id)).to.include.members([
            command.id,
            operation.id,
            source.id,
        ])
        const incident = runtime.diagnostics.incidents({ commandId: command.id })
            .find(candidate => candidate.failureStage === 'queue-completion')
        expect(caught.incident).to.deep.include({
            kind: 'submission-failure',
            diagnosticCode: 'SCRATCH_SUBMISSION_QUEUE_COMPLETION_FAILED',
            failureStage: 'queue-completion',
        })
        expect(incident).to.deep.include({
            kind: 'readback-failure',
            diagnosticCode: 'SCRATCH_SUBMISSION_QUEUE_COMPLETION_FAILED',
            nativeErrorCategory: 'native-exception',
            attribution: 'enclosing-operation-family',
            failureStage: 'queue-completion',
        })
        expect(incident.target).to.deep.equal({
            kind: 'command',
            commandId: command.id,
            commandKind: 'readback',
        })
        expect(incident.related.map(subject => subject.id)).to.include.members([
            runtime.id,
            submitted.id,
            operation.id,
            source.id,
        ])
        expect(incident.outcomes).to.deep.equal([ {
            stage: 'queue-completion',
            diagnosticCode: 'SCRATCH_SUBMISSION_QUEUE_COMPLETION_FAILED',
            nativeErrorCategory: 'native-exception',
            nativeError: {
                name: 'Error',
                message: nativeFailure.message,
            },
        } ])
        expect(submitted.readbacks[0].operationId).to.equal(operation.id)
        expect(submitted.executionOutcomes).to.deep.equal([])
        expect(Array.from(await operation.toArray(Uint32Array))).to.deep.equal([ 1, 2, 3, 4 ])
        expect(command.state).to.equal('idle')
    })

    it('records enclosing-family queue completion evidence for every linked readback', async () => {

        const fake = createFakeGpu()
        const runtime = await scr.ScratchRuntime.create({ gpu: fake.gpu })
        const source = await runtime.createBuffer({ size: 16, usage: COPY_SRC | COPY_DST })
        const upload = runtime.createUploadCommand({
            target: (source).region(),
            data: new Uint32Array([ 1, 2, 3, 4 ]),
        })
        const commands = await Promise.all([ 'first', 'second' ].map(label =>
            runtime.createReadbackCommand({
                label,
                source: { region: (source).region(), contentEpoch: 1 },
                whenMissing: 'throw',
            })
        ))
        fake.readbacks.rejectNextQueueCompletion(new Error('multi-readback queue completion failure'))
        const submitted = runtime.submission()
            .upload(upload)
            .readback(commands[0])
            .readback(commands[1])
            .submit()
        const operations = commands.map(command => command.result({ after: submitted }))

        await expectScratchDiagnostic(() => submitted.done, {
            code: 'SCRATCH_SUBMISSION_QUEUE_COMPLETION_FAILED',
            phase: 'submission',
        })

        const incidents = runtime.diagnostics.incidents()
            .filter(incident =>
                incident.kind === 'readback-failure' &&
                incident.failureStage === 'queue-completion'
            )
        expect(incidents).to.have.length(2)
        expect(incidents.map(incident => incident.target.commandId).sort()).to.deep.equal(
            commands.map(command => command.id).sort()
        )
        for (const [ index, command ] of commands.entries()) {
            const incident = incidents.find(candidate => candidate.target.commandId === command.id)
            expect(incident.attribution).to.equal('enclosing-operation-family')
            expect(incident.related.map(subject => subject.id)).to.include.members([
                submitted.id,
                operations[index].id,
                source.id,
            ])
        }

        runtime.dispose()
    })
})
