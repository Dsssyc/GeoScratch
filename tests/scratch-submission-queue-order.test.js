import { expect } from 'chai'
import { ScratchRuntime } from 'geoscratch'
import { createFakeGpu } from './scratch-test-utils.js'

const GPU_BUFFER_USAGE_COPY_SRC = 0x4
const GPU_BUFFER_USAGE_COPY_DST = 0x8

function timelineTypes(calls) {

    return calls.queueTimeline.map(action => action.type)
}

async function createOrderingFixture() {

    const fake = createFakeGpu()
    const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
    const copySource = runtime.createBuffer({
        label: 'queue order copy source',
        size: 16,
        usage: GPU_BUFFER_USAGE_COPY_SRC,
    })
    const firstCopyTarget = runtime.createBuffer({
        label: 'queue order first copy target',
        size: 16,
        usage: GPU_BUFFER_USAGE_COPY_DST,
    })
    const secondCopyTarget = runtime.createBuffer({
        label: 'queue order second copy target',
        size: 16,
        usage: GPU_BUFFER_USAGE_COPY_DST,
    })
    const uploadTarget = runtime.createBuffer({
        label: 'queue order upload target',
        size: 16,
        usage: GPU_BUFFER_USAGE_COPY_DST,
    })

    copySource._advanceContentEpoch()

    const firstCopy = runtime.createCopyCommand({
        label: 'queue order first copy',
        source: { resource: copySource, contentEpoch: 1 },
        target: firstCopyTarget,
        byteLength: 16,
        whenMissing: 'throw',
    })
    const secondCopy = runtime.createCopyCommand({
        label: 'queue order second copy',
        source: { resource: copySource, contentEpoch: 1 },
        target: secondCopyTarget,
        byteLength: 16,
        whenMissing: 'throw',
    })
    const upload = runtime.createUploadCommand({
        label: 'queue order upload',
        target: uploadTarget,
        data: new Uint8Array(16),
    })

    return {
        ...fake,
        runtime,
        firstCopy,
        secondCopy,
        upload,
    }
}

describe('scratch submission queue order', () => {

    it('keeps a leading queue upload before later encoded GPU work', async() => {

        const fixture = await createOrderingFixture()
        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .upload(fixture.upload)
            .copy(fixture.firstCopy)
            .submit()

        expect(timelineTypes(fixture.calls)).to.deep.equal([
            'write-buffer',
            'submit',
        ])
        expect(submitted.commandBuffers).to.have.length(1)

        await submitted.done
    })

    it('keeps a trailing queue upload after earlier encoded GPU work', async() => {

        const fixture = await createOrderingFixture()
        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .copy(fixture.firstCopy)
            .upload(fixture.upload)
            .submit()

        expect(timelineTypes(fixture.calls)).to.deep.equal([
            'submit',
            'write-buffer',
        ])
        expect(submitted.commandBuffers).to.have.length(1)

        await submitted.done
    })

    it('splits encoded GPU work around an interleaved queue upload', async() => {

        const fixture = await createOrderingFixture()
        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .copy(fixture.firstCopy)
            .upload(fixture.upload)
            .copy(fixture.secondCopy)
            .submit()

        expect(timelineTypes(fixture.calls)).to.deep.equal([
            'submit',
            'write-buffer',
            'submit',
        ])
        expect(submitted.commandBuffers).to.have.length(2)
        expect(fixture.calls.queueSubmissions).to.deep.equal([
            [ submitted.commandBuffers[0] ],
            [ submitted.commandBuffers[1] ],
        ])

        await submitted.done
    })
})
