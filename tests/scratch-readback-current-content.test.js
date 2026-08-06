import { expect } from 'chai'
import * as scr from 'geoscratch/scratch'
import { setResourceContentState } from '../packages/geoscratch/dist/scratch/gpu/resource.js'
import { createFakeGpu, createTestProgram } from './scratch-test-utils.js'

const COPY_SRC = 0x4
const STORAGE = 0x80

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

async function createFixture() {

    const fake = createFakeGpu()
    const runtime = await scr.GPURuntime.create({ gpu: fake.gpu })
    const source = await runtime.createBuffer({
        label: 'ordered current readback source',
        size: 16,
        usage: COPY_SRC | STORAGE,
    })
    const program = await createTestProgram(runtime, {
        sourceParts: [ '@compute @workgroup_size(1) fn produce() {}' ],
        compute: 'produce',
    })
    const pipeline = await runtime.createComputePipeline({ program, compute: 'produce' })
    const pass = runtime.createComputePass({ label: 'ordered current producer pass' })
    const producer = runtime.createDispatchCommand({
        label: 'ordered current producer',
        pipeline,
        count: { workgroups: [ 1 ] },
        resources: { read: [], write: [ source ] },
        whenMissing: 'throw',
    })

    return { ...fake, runtime, source, pass, producer }
}

async function createCurrentReadback(fixture) {

    return await fixture.runtime.createReadbackCommand({
        label: 'ordered current readback',
        source: {
            region: fixture.source.region(),
            contentEpoch: 'current-at-step',
        },
        whenMissing: 'throw',
    })
}

describe('scratch ordered readback of current content', () => {

    it('reuses one command across three submissions and snapshots each produced epoch', async () => {

        const fixture = await createFixture()
        const command = await createCurrentReadback(fixture)
        const commandId = command.id
        const allocationVersion = fixture.source.allocationVersion

        expect(command.source.contentEpoch).to.equal('current-at-step')

        for (let expectedEpoch = 1; expectedEpoch <= 3; expectedEpoch++) {
            const submitted = fixture.runtime.submission({ validation: 'throw' })
                .compute(fixture.pass, [ fixture.producer ])
                .readback(command)
                .submit()
            const operation = command.result({ after: submitted })
            const readAccess = submitted.resourceAccesses.find(access => (
                access.commandId === command.id && access.access === 'read'
            ))
            const commandFact = fixture.runtime.diagnostics.snapshot().readbackCommands.find(
                fact => fact.id === command.id
            )
            const operationFact = fixture.runtime.diagnostics.snapshot().readbacks.find(
                fact => fact.id === operation.id
            )

            expect(command.id).to.equal(commandId)
            expect(fixture.source.contentEpoch).to.equal(expectedEpoch)
            expect(readAccess).to.include({
                declaredContentEpoch: 'current-at-step',
                contentEpochBefore: expectedEpoch,
                contentEpochAfter: expectedEpoch,
                allocationVersion,
            })
            expect(submitted.readbacks[0]).to.include({
                commandId,
                sourceResourceId: fixture.source.id,
                contentEpoch: expectedEpoch,
                allocationVersion,
            })
            expect(operation).to.include({
                contentEpoch: expectedEpoch,
                allocationVersion,
            })
            expect(operation.producerEpoch).to.include({
                resourceId: fixture.source.id,
                contentEpoch: expectedEpoch,
                allocationVersion,
            })
            expect(commandFact).to.include({
                contentEpoch: 'current-at-step',
                allocationVersion,
            })
            expect(operationFact).to.include({
                contentEpoch: expectedEpoch,
                allocationVersion,
            })

            expect(await operation.toBytes()).to.have.length(16)
            expect(command.state).to.equal('idle')
        }
    })

    it('fails when the readback precedes its first producer without future lookahead', async () => {

        const fixture = await createFixture()
        const command = await createCurrentReadback(fixture)
        const encoderCount = fixture.calls.commandEncoders.length

        const diagnostic = await expectScratchDiagnostic(() => fixture.runtime.submission({ validation: 'off' })
            .readback(command)
            .compute(fixture.pass, [ fixture.producer ])
            .submit(), {
            code: 'SCRATCH_COMMAND_RESOURCE_NOT_READY',
            phase: 'command',
        })

        expect(diagnostic.actual).to.include({
            stepIndex: 0,
            resourceId: fixture.source.id,
            requiredContentEpoch: 'current-at-step',
            simulatedContentEpoch: 0,
        })
        expect(fixture.calls.commandEncoders).to.have.length(encoderCount)
        expect(fixture.source.contentEpoch).to.equal(0)
    })

    it('fails closed for indeterminate current content with validation disabled', async () => {

        const fixture = await createFixture()
        const command = await createCurrentReadback(fixture)
        setResourceContentState(fixture.source, 'indeterminate', 7)
        const encoderCount = fixture.calls.commandEncoders.length

        const diagnostic = await expectScratchDiagnostic(
            () => fixture.runtime.submission({ validation: 'off' }).readback(command).submit(),
            {
                code: 'SCRATCH_COMMAND_RESOURCE_CONTENT_INDETERMINATE',
                phase: 'command',
            }
        )

        expect(diagnostic.actual).to.include({
            requiredContentEpoch: 'current-at-step',
            contentEpoch: 7,
        })
        expect(fixture.calls.commandEncoders).to.have.length(encoderCount)
    })

    it('keeps stale numeric exact readback strict', async () => {

        const fixture = await createFixture()
        const command = await fixture.runtime.createReadbackCommand({
            source: { region: fixture.source.region(), contentEpoch: 1 },
            whenMissing: 'throw',
        })
        const first = fixture.runtime.submission({ validation: 'throw' })
            .compute(fixture.pass, [ fixture.producer ])
            .readback(command)
            .submit()
        await command.result({ after: first }).toBytes()

        await expectScratchDiagnostic(() => fixture.runtime.submission({ validation: 'throw' })
            .compute(fixture.pass, [ fixture.producer ])
            .readback(command)
            .submit(), {
            code: 'SCRATCH_SUBMISSION_STALE_READ',
            phase: 'submission',
        })
        expect(fixture.source.contentEpoch).to.equal(1)
    })

    it('keeps CopyCommand current-at-step sources invalid at runtime', async () => {

        const fixture = await createFixture()
        const target = await fixture.runtime.createBuffer({ size: 16, usage: STORAGE })

        await expectScratchDiagnostic(() => fixture.runtime.createCopyCommand({
            source: {
                region: fixture.source.region(),
                contentEpoch: 'current-at-step',
            },
            target: target.region(),
            whenMissing: 'throw',
        }), {
            code: 'SCRATCH_COMMAND_COPY_SOURCE_INVALID',
            phase: 'command',
        })
    })
})
