import { expect } from 'chai'
import * as scr from 'geoscratch'
import { createGpuOperationRecord } from '../packages/geoscratch/dist/scratch/gpu-operation.js'
import { createFakeGpu } from './scratch-test-utils.js'

const COPY_SRC = 0x4
const COPY_DST = 0x8

async function createRuntimeAndSource() {

    const fake = createFakeGpu()
    const runtime = await scr.ScratchRuntime.create({ gpu: fake.gpu })
    const source = await runtime.createBuffer({
        label: 'readback contract source',
        size: 16,
        usage: COPY_SRC | COPY_DST,
    })

    return { fake, runtime, source }
}

describe('scratch readback provenance contract', () => {

    it('returns ordinary Promises from both ordered readback command factories', async () => {

        const { runtime, source } = await createRuntimeAndSource()
        const descriptor = {
            source: { region: source.region(), contentEpoch: 1 },
            whenMissing: 'throw',
        }

        const primary = runtime.createReadbackCommand(descriptor)
        const alias = runtime.readbackCommand(descriptor)

        expect(primary).to.be.instanceOf(Promise)
        expect(alias).to.be.instanceOf(Promise)
        expect(await primary).to.be.instanceOf(scr.ReadbackCommand)
        expect(await alias).to.be.instanceOf(scr.ReadbackCommand)
    })

    it('closes direct and subclass construction for command and operation wrappers', async () => {

        const { runtime, source } = await createRuntimeAndSource()
        const cases = [
            {
                Wrapper: scr.ReadbackCommand,
                descriptor: {
                    source: { region: source.region(), contentEpoch: 0 },
                    whenMissing: 'throw',
                },
                code: 'SCRATCH_READBACK_COMMAND_CONSTRUCTOR_PRIVATE',
            },
            {
                Wrapper: scr.ReadbackOperation,
                descriptor: { source: source.region() },
                code: 'SCRATCH_READBACK_OPERATION_CONSTRUCTOR_PRIVATE',
            },
        ]

        for (const { Wrapper, descriptor, code } of cases) {
            for (const Candidate of [ Wrapper, class extends Wrapper {} ]) {
                try {
                    new Candidate(runtime, descriptor)
                    throw new Error('expected direct readback construction to fail')
                } catch (error) {
                    expect(error).to.be.instanceOf(scr.ScratchDiagnosticError)
                    expect(error.diagnostic.code).to.equal(code)
                }
            }
        }
    })

    it('keeps submit synchronous and publishes immutable serializable readback links', async () => {

        const { runtime, source } = await createRuntimeAndSource()
        const upload = runtime.createUploadCommand({
            target: (source).region(),
            data: new Uint32Array([ 1, 2, 3, 4 ]),
        })
        const command = await runtime.createReadbackCommand({
            label: 'readback contract command',
            source: { region: (source).region(), contentEpoch: 1 },
            whenMissing: 'throw',
        })
        const submitted = runtime.submission().upload(upload).readback(command).submit()

        expect(submitted).to.be.instanceOf(scr.SubmittedWork)
        expect(submitted).not.to.be.instanceOf(Promise)
        expect(submitted.readbacks).to.have.length(1)
        expect(submitted.readbacks[0]).to.deep.include({
            commandId: command.id,
            stepIndex: 1,
            sourceResourceId: source.id,
            allocationVersion: source.allocationVersion,
            contentEpoch: 1,
        })
        expect(submitted.readbacks[0].operationId).to.be.a('string').and.not.empty
        expect(submitted.readbacks[0].stagingAllocationOperationId).to.be.a('string').and.not.empty
        expect(Object.isFrozen(submitted.readbacks)).to.equal(true)
        expect(Object.isFrozen(submitted.readbacks[0])).to.equal(true)
        expect(JSON.parse(JSON.stringify(submitted.readbacks))).to.deep.equal(submitted.readbacks)

        const operation = command.result({ after: submitted })
        expect(operation.id).to.equal(submitted.readbacks[0].operationId)
        expect(operation).not.to.have.property('stagingBuffer')
    })

    it('uses schema version 4 command and readback targets without resource placeholders', () => {

        const commandRecord = createGpuOperationRecord({
            sequence: 1,
            id: 'operation-command',
            kind: 'readback-staging-allocation',
            status: 'succeeded',
            runtimeId: 'runtime-1',
            target: {
                kind: 'command',
                commandId: 'command-1',
                commandKind: 'readback',
            },
            descriptor: {
                hash: 'descriptor-command',
                summary: { byteLength: 16 },
            },
        })
        const readbackRecord = createGpuOperationRecord({
            sequence: 2,
            id: 'operation-readback',
            kind: 'readback-mapping',
            status: 'succeeded',
            runtimeId: 'runtime-1',
            target: {
                kind: 'readback',
                readbackId: 'readback-1',
                path: 'ordered',
                sourceResourceId: 'buffer-1',
                allocationVersion: 1,
                contentEpoch: 2,
                byteLength: 16,
                commandId: 'command-1',
                submissionId: 'submission-1',
                stepIndex: 3,
            },
            descriptor: {
                hash: 'descriptor-readback',
                summary: { byteLength: 16 },
            },
        })

        expect(commandRecord.version).to.equal(4)
        expect(commandRecord.target.kind).to.equal('command')
        expect(commandRecord.target).not.to.have.any.keys(
            'resourceId',
            'allocationVersion',
            'contentEpoch',
            'logicalFootprintBytes'
        )
        expect(readbackRecord.version).to.equal(4)
        expect(readbackRecord.target.kind).to.equal('readback')
        expect(readbackRecord.target).not.to.have.any.keys(
            'resourceId',
            'resourceKind',
            'logicalFootprintBytes',
            'programId'
        )
        expect(JSON.parse(JSON.stringify([ commandRecord, readbackRecord ]))).to.deep.equal([
            commandRecord,
            readbackRecord,
        ])
    })

    it('versions runtime snapshots and exported evidence together', async () => {

        const { runtime } = await createRuntimeAndSource()
        const snapshot = runtime.diagnostics.snapshot()
        const evidence = runtime.diagnostics.exportEvidence()

        expect(snapshot.version).to.equal(4)
        expect(evidence.version).to.equal(4)
        expect(evidence.snapshot.version).to.equal(4)
    })
})
