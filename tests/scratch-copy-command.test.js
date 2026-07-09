import { expect } from 'chai'
import {
    BindSet,
    CopyCommand,
    ScratchDiagnosticError,
    ScratchRuntime,
} from 'geoscratch'
import { createFakeGpu } from './scratch-test-utils.js'

const GPU_BUFFER_USAGE_COPY_SRC = 0x4
const GPU_BUFFER_USAGE_COPY_DST = 0x8
const GPU_BUFFER_USAGE_UNIFORM = 0x40

function sourceBytes() {

    return new Uint8Array([
        0, 1, 2, 3,
        4, 5, 6, 7,
        8, 9, 10, 11,
        12, 13, 14, 15,
        16, 17, 18, 19,
        20, 21, 22, 23,
        24, 25, 26, 27,
        28, 29, 30, 31,
    ])
}

function copySource(resource, contentEpoch = resource.contentEpoch) {

    return { resource, contentEpoch }
}

async function createCopyFixture() {

    const fake = createFakeGpu()
    const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
    const source = runtime.createBuffer({
        label: 'copy source',
        size: 32,
        usage: GPU_BUFFER_USAGE_COPY_SRC | GPU_BUFFER_USAGE_COPY_DST,
    })
    const target = runtime.createBuffer({
        label: 'copy target',
        size: 32,
        usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_UNIFORM,
    })
    const upload = runtime.createUploadCommand({
        label: 'upload copy source',
        target: source,
        data: sourceBytes(),
        offset: 0,
    })
    const copy = runtime.createCopyCommand({
        label: 'copy source slice',
        source: copySource(source, 1),
        sourceOffset: 4,
        target,
        targetOffset: 8,
        byteLength: 16,
        whenMissing: 'throw',
    })
    const bindLayout = runtime.createBindLayout({
        label: 'copy target bind layout',
        group: 0,
        entries: [
            {
                binding: 0,
                name: 'targetUniforms',
                type: 'uniform',
                visibility: [ 'vertex' ],
            },
        ],
    })
    const bindSet = runtime.createBindSet(bindLayout, {
        targetUniforms: target,
    }, {
        label: 'copy target bind set',
    })

    return { ...fake, runtime, source, target, upload, copy, bindLayout, bindSet }
}

async function expectScratchDiagnostic(action, expected) {

    try {
        await action()
        throw new Error('expected Scratch diagnostic')
    } catch (error) {
        expect(error).to.be.instanceOf(ScratchDiagnosticError)
        expect(error.diagnostic).to.include(expected)
        return error.diagnostic
    }
}

describe('scratch CopyCommand', () => {

    it('copies buffer ranges through an explicit submission copy step', async() => {

        const fixture = await createCopyFixture()

        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .upload(fixture.upload)
            .copy(fixture.copy)
            .submit()

        expect(fixture.copy).to.be.instanceOf(CopyCommand)
        expect(fixture.copy.commandKind).to.equal('copy')
        expect(fixture.copy.source).to.deep.equal({
            resource: fixture.source,
            contentEpoch: 1,
        })
        expect(fixture.copy.target).to.equal(fixture.target)
        expect(fixture.copy.whenMissing).to.equal('throw')
        expect(fixture.copy.sourceOffset).to.equal(4)
        expect(fixture.copy.targetOffset).to.equal(8)
        expect(fixture.copy.byteLength).to.equal(16)

        expect(fixture.calls.queueWrites).to.have.length(1)
        expect(fixture.calls.copies).to.deep.equal([
            {
                source: fixture.source.gpuBuffer,
                sourceOffset: 4,
                destination: fixture.target.gpuBuffer,
                destinationOffset: 8,
                size: 16,
            },
        ])
        expect([ ...fixture.target.gpuBuffer.data.slice(8, 24) ]).to.deep.equal([
            4, 5, 6, 7,
            8, 9, 10, 11,
            12, 13, 14, 15,
            16, 17, 18, 19,
        ])
        expect(fixture.calls.queueSubmissions).to.have.length(1)
        expect(fixture.calls.queueSubmissions[0]).to.deep.equal([
            { type: 'commandBuffer', descriptor: { label: submitted.id } },
        ])

        await submitted.done
    })

    it('advances only the copy target contentEpoch and preserves allocationVersion', async() => {

        const fixture = await createCopyFixture()
        const sourceAllocationVersion = fixture.source.allocationVersion
        const targetAllocationVersion = fixture.target.allocationVersion

        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .upload(fixture.upload)
            .copy(fixture.copy)
            .submit()

        expect(fixture.source.contentEpoch).to.equal(1)
        expect(fixture.target.contentEpoch).to.equal(1)
        expect(fixture.source.allocationVersion).to.equal(sourceAllocationVersion)
        expect(fixture.target.allocationVersion).to.equal(targetAllocationVersion)

        await submitted.done
    })

    it('does not rebuild BindSet only because a copied-to buffer contentEpoch changes', async() => {

        const fixture = await createCopyFixture()
        const firstBindGroup = fixture.bindSet.getBindGroup()

        expect(fixture.bindSet).to.be.instanceOf(BindSet)
        expect(fixture.calls.bindGroups).to.have.length(1)

        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .upload(fixture.upload)
            .copy(fixture.copy)
            .submit()

        expect(fixture.target.contentEpoch).to.equal(1)

        const secondBindGroup = fixture.bindSet.getBindGroup()

        expect(secondBindGroup).to.equal(firstBindGroup)
        expect(fixture.calls.bindGroups).to.have.length(1)

        await submitted.done
    })

    it('rejects invalid source descriptors with structured diagnostics', async() => {

        const fixtureA = await createCopyFixture()
        const fixtureB = await createCopyFixture()

        for (const source of [
            fixtureA.source,
            {},
            { contentEpoch: 0 },
            { resource: fixtureA.source },
            { resource: fixtureA.source, contentEpoch: -1 },
            { resource: fixtureA.source, contentEpoch: 0.5 },
            { resource: fixtureA.source, contentEpoch: Number.NaN },
        ]) {
            await expectScratchDiagnostic(() => fixtureA.runtime.createCopyCommand({
                source,
                target: fixtureA.target,
                byteLength: 4,
                whenMissing: 'throw',
            }), {
                code: 'SCRATCH_COMMAND_COPY_SOURCE_INVALID',
                severity: 'error',
                phase: 'command',
            })
        }

        await expectScratchDiagnostic(() => fixtureA.runtime.createCopyCommand({
            source: copySource(fixtureB.source),
            target: fixtureA.target,
            byteLength: 4,
        }), {
            code: 'SCRATCH_RESOURCE_WRONG_RUNTIME',
            severity: 'error',
            phase: 'resource',
        })

        fixtureA.source.dispose()

        await expectScratchDiagnostic(() => fixtureA.runtime.createCopyCommand({
            source: copySource(fixtureA.source),
            target: fixtureA.target,
            byteLength: 4,
            whenMissing: 'throw',
        }), {
            code: 'SCRATCH_RESOURCE_DISPOSED',
            severity: 'error',
            phase: 'resource',
        })
    })

    it('rejects invalid targets and readiness policies with structured diagnostics', async() => {

        const fixtureA = await createCopyFixture()
        const fixtureB = await createCopyFixture()

        await expectScratchDiagnostic(() => fixtureA.runtime.createCopyCommand({
            source: copySource(fixtureA.source),
            target: {},
            byteLength: 4,
            whenMissing: 'throw',
        }), {
            code: 'SCRATCH_COMMAND_COPY_RANGE_INVALID',
            severity: 'error',
            phase: 'command',
        })

        await expectScratchDiagnostic(() => fixtureA.runtime.createCopyCommand({
            source: copySource(fixtureA.source),
            target: fixtureA.target,
            byteLength: 4,
        }), {
            code: 'SCRATCH_COMMAND_READINESS_POLICY_MISSING',
            severity: 'error',
            phase: 'command',
        })

        await expectScratchDiagnostic(() => fixtureA.runtime.createCopyCommand({
            source: copySource(fixtureA.source),
            target: fixtureA.target,
            byteLength: 4,
            whenMissing: 'skip-command',
        }), {
            code: 'SCRATCH_COMMAND_READINESS_POLICY_MISSING',
            severity: 'error',
            phase: 'command',
        })

        await expectScratchDiagnostic(() => fixtureA.runtime.createCopyCommand({
            source: copySource(fixtureA.source),
            target: fixtureB.target,
            byteLength: 4,
            whenMissing: 'throw',
        }), {
            code: 'SCRATCH_RESOURCE_WRONG_RUNTIME',
            severity: 'error',
            phase: 'resource',
        })

        const replacementSource = fixtureA.runtime.createBuffer({
            size: 32,
            usage: GPU_BUFFER_USAGE_COPY_SRC | GPU_BUFFER_USAGE_COPY_DST,
        })
        fixtureA.target.dispose()

        await expectScratchDiagnostic(() => fixtureA.runtime.createCopyCommand({
            source: copySource(replacementSource),
            target: fixtureA.target,
            byteLength: 4,
            whenMissing: 'throw',
        }), {
            code: 'SCRATCH_RESOURCE_DISPOSED',
            severity: 'error',
            phase: 'resource',
        })
    })

    it('rejects buffers missing copy usages with structured diagnostics', async() => {

        const fixture = await createCopyFixture()
        const nonCopySource = fixture.runtime.createBuffer({
            size: 16,
            usage: GPU_BUFFER_USAGE_COPY_DST,
        })
        const nonCopyTarget = fixture.runtime.createBuffer({
            size: 16,
            usage: GPU_BUFFER_USAGE_COPY_SRC,
        })

        await expectScratchDiagnostic(() => fixture.runtime.createCopyCommand({
            source: copySource(nonCopySource),
            target: fixture.target,
            byteLength: 4,
            whenMissing: 'throw',
        }), {
            code: 'SCRATCH_RESOURCE_USAGE_MISSING',
            severity: 'error',
            phase: 'resource',
        })

        await expectScratchDiagnostic(() => fixture.runtime.createCopyCommand({
            source: copySource(fixture.source),
            target: nonCopyTarget,
            byteLength: 4,
            whenMissing: 'throw',
        }), {
            code: 'SCRATCH_RESOURCE_USAGE_MISSING',
            severity: 'error',
            phase: 'resource',
        })
    })

    it('rejects invalid copy ranges and overlapping same-buffer copies', async() => {

        const fixture = await createCopyFixture()
        const sameBuffer = fixture.runtime.createBuffer({
            size: 32,
            usage: GPU_BUFFER_USAGE_COPY_SRC | GPU_BUFFER_USAGE_COPY_DST,
        })

        for (const descriptor of [
            { source: copySource(fixture.source), sourceOffset: -4, target: fixture.target, targetOffset: 0, byteLength: 4, whenMissing: 'throw' },
            { source: copySource(fixture.source), sourceOffset: 0, target: fixture.target, targetOffset: -4, byteLength: 4, whenMissing: 'throw' },
            { source: copySource(fixture.source), sourceOffset: 0, target: fixture.target, targetOffset: 0, byteLength: 0, whenMissing: 'throw' },
            { source: copySource(fixture.source), sourceOffset: 2, target: fixture.target, targetOffset: 0, byteLength: 4, whenMissing: 'throw' },
            { source: copySource(fixture.source), sourceOffset: 0, target: fixture.target, targetOffset: 2, byteLength: 4, whenMissing: 'throw' },
            { source: copySource(fixture.source), sourceOffset: 0, target: fixture.target, targetOffset: 0, byteLength: 6, whenMissing: 'throw' },
            { source: copySource(fixture.source), sourceOffset: 20, target: fixture.target, targetOffset: 0, byteLength: 16, whenMissing: 'throw' },
            { source: copySource(fixture.source), sourceOffset: 0, target: fixture.target, targetOffset: 20, byteLength: 16, whenMissing: 'throw' },
            { source: copySource(sameBuffer), sourceOffset: 0, target: sameBuffer, targetOffset: 4, byteLength: 8, whenMissing: 'throw' },
        ]) {
            await expectScratchDiagnostic(() => fixture.runtime.createCopyCommand(descriptor), {
                code: 'SCRATCH_COMMAND_COPY_RANGE_INVALID',
                severity: 'error',
                phase: 'command',
            })
        }
    })

    it('rejects invalid copy submission steps with structured diagnostics', async() => {

        const fixtureA = await createCopyFixture()
        const fixtureB = await createCopyFixture()

        await expectScratchDiagnostic(() => fixtureA.runtime.createSubmission({ validation: 'throw' })
            .copy(fixtureA.upload)
            .submit(), {
            code: 'SCRATCH_SUBMISSION_PASS_COMMAND_INCOMPATIBLE',
            severity: 'error',
            phase: 'submission',
        })

        fixtureA.copy.dispose()

        await expectScratchDiagnostic(() => fixtureA.runtime.createSubmission({ validation: 'throw' })
            .copy(fixtureA.copy)
            .submit(), {
            code: 'SCRATCH_COMMAND_DISPOSED',
            severity: 'error',
            phase: 'command',
        })

        await expectScratchDiagnostic(() => fixtureA.runtime.createSubmission({ validation: 'throw' })
            .copy(fixtureB.copy)
            .submit(), {
            code: 'SCRATCH_COMMAND_WRONG_RUNTIME',
            severity: 'error',
            phase: 'command',
        })
    })
})
