import { expect } from 'chai'
import * as scr from 'geoscratch'
import { createFakeGpu } from './scratch-test-utils.js'

describe('Scratch buffer host mapping public contract', () => {

    it('rejects mappedAtCreation on ordinary buffer creation before native allocation', async () => {

        const fake = createFakeGpu()
        const runtime = await scr.ScratchRuntime.create({ gpu: fake.gpu })
        const before = fake.calls.buffers.length

        const failure = await rejectedDiagnostic(runtime.createBuffer({
            label: 'hidden mapped state',
            size: 16,
            usage: 0x8,
            mappedAtCreation: false,
        }))

        expect(failure.diagnostic.code).to.equal(
            'SCRATCH_BUFFER_MAPPING_USE_EXPLICIT_FACTORY'
        )
        expect(fake.calls.buffers).to.have.length(before)
    })

    it('publishes dedicated mapped creation, mapping, and closed lease APIs', async () => {

        const fake = createFakeGpu()
        const runtime = await scr.ScratchRuntime.create({ gpu: fake.gpu })

        expect(runtime.createMappedBuffer).to.be.a('function')
        expect(runtime.mapBuffer).to.be.a('function')
        expect(scr.MappedBufferLease).to.be.a('function')
    })
})

async function rejectedDiagnostic(promise) {

    try {
        await promise
    } catch (error) {
        expect(error).to.be.instanceOf(scr.ScratchDiagnosticError)
        return error
    }
    throw new Error('Expected a ScratchDiagnosticError rejection.')
}
