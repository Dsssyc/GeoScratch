import { expect } from 'chai'
import * as scr from 'geoscratch'
import { createFakeGpu } from './scratch-test-utils.js'

const COPY_SRC = 0x4
const COPY_DST = 0x8

describe('scratch ReadbackCommand', () => {

    it('creates explicit buffer readback commands from both runtime factories', async () => {

        const fake = createFakeGpu()
        const runtime = await scr.ScratchRuntime.create({ gpu: fake.gpu })
        const source = runtime.createBuffer({
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
        const alias = runtime.readbackCommand(descriptor)

        expect(command).to.be.instanceOf(scr.ReadbackCommand)
        expect(alias).to.be.instanceOf(scr.ReadbackCommand)
        expect(command.commandKind).to.equal('readback')
        expect(command.source).to.deep.equal(descriptor.source)
        expect(command.range).to.deep.equal({ offset: 4, byteLength: 8 })
        expect(command.retain).to.equal('until-dispose')
        expect(command.whenMissing).to.equal('throw')
    })

    it('stages at the submission step and maps without a second copy', async () => {

        const fake = createFakeGpu()
        const runtime = await scr.ScratchRuntime.create({ gpu: fake.gpu })
        const source = runtime.createBuffer({
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
        const operation = command.result({ after: submitted })

        expect(command.result({ after: submitted })).to.equal(operation)
        expect(stagedCopyCount).to.equal(1)
        expect(operation.producerEpoch?.contentEpoch).to.equal(1)
        expect(Array.from(await operation.toArray(Uint32Array))).to.deep.equal([ 22, 33 ])
        expect(fake.calls.copies).to.have.length(stagedCopyCount)
    })
})
