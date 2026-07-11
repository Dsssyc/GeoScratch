import { expect } from 'chai'
import {
    BindSet,
    CopyCommand,
    ScratchDiagnosticError,
    ScratchRuntime,
    TextureResource,
} from 'geoscratch'
import { createFakeGpu } from './scratch-test-utils.js'

const GPU_BUFFER_USAGE_COPY_SRC = 0x4
const GPU_BUFFER_USAGE_COPY_DST = 0x8
const GPU_BUFFER_USAGE_UNIFORM = 0x40
const GPU_TEXTURE_USAGE_COPY_SRC = 0x1
const GPU_TEXTURE_USAGE_COPY_DST = 0x2
const GPU_TEXTURE_USAGE_TEXTURE_BINDING = 0x4
const GPU_TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10

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

async function createTextureCopyFixture() {

    const fake = createFakeGpu()
    const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
    const source = runtime.createTexture({
        label: 'texture copy source',
        size: { width: 4, height: 4 },
        format: 'rgba8unorm',
        usage: GPU_TEXTURE_USAGE_COPY_SRC | GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
    })
    const target = runtime.createTexture({
        label: 'texture copy target',
        size: { width: 4, height: 4 },
        format: 'rgba8unorm',
        usage: GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
    })
    const upload = runtime.createTextureUploadCommand({
        label: 'upload texture copy source',
        target: source,
        data: new Uint8Array(4 * 4 * 4),
        layout: { bytesPerRow: 16, rowsPerImage: 4 },
        size: { width: 4, height: 4 },
    })
    const copy = runtime.createCopyCommand({
        label: 'copy texture region',
        source: copySource(source, 1),
        sourceOrigin: [ 1, 1 ],
        target,
        targetOrigin: { x: 2, y: 0 },
        size: { width: 2, height: 2 },
        whenMissing: 'throw',
    })

    return { ...fake, runtime, source, target, upload, copy }
}

async function createBufferToTextureCopyFixture() {

    const fake = createFakeGpu()
    const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
    const source = runtime.createBuffer({
        label: 'buffer texture copy source',
        size: 1024,
        usage: GPU_BUFFER_USAGE_COPY_SRC | GPU_BUFFER_USAGE_COPY_DST,
    })
    const target = runtime.createTexture({
        label: 'buffer texture copy target',
        size: { width: 4, height: 4 },
        format: 'rgba8unorm',
        usage: GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
    })
    const upload = runtime.createUploadCommand({
        label: 'upload buffer texture copy source',
        target: source,
        data: new Uint8Array(1024),
    })
    const copy = runtime.createCopyCommand({
        label: 'copy buffer into texture',
        source: copySource(source, 1),
        sourceLayout: { offset: 256, bytesPerRow: 256, rowsPerImage: 4 },
        target,
        targetOrigin: [ 1, 1 ],
        targetMipLevel: 0,
        targetAspect: 'all',
        size: { width: 2, height: 2 },
        whenMissing: 'throw',
    })

    return { ...fake, runtime, source, target, upload, copy }
}

async function createTextureToBufferCopyFixture() {

    const fake = createFakeGpu()
    const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
    const source = runtime.createTexture({
        label: 'texture buffer copy source',
        size: { width: 4, height: 4 },
        format: 'rgba8unorm',
        usage: GPU_TEXTURE_USAGE_COPY_SRC | GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
    })
    const target = runtime.createBuffer({
        label: 'texture buffer copy target',
        size: 1024,
        usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_COPY_SRC,
    })
    const upload = runtime.createTextureUploadCommand({
        label: 'upload texture buffer copy source',
        target: source,
        data: new Uint8Array(4 * 4 * 4),
        layout: { bytesPerRow: 16, rowsPerImage: 4 },
        size: { width: 4, height: 4 },
    })
    const copy = runtime.createCopyCommand({
        label: 'copy texture into buffer',
        source: copySource(source, 1),
        sourceOrigin: [ 1, 1 ],
        sourceMipLevel: 0,
        sourceAspect: 'all',
        target,
        targetLayout: { offset: 128, bytesPerRow: 256, rowsPerImage: 4 },
        size: { width: 2, height: 2 },
        whenMissing: 'throw',
    })

    return { ...fake, runtime, source, target, upload, copy }
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

    it('copies texture regions through an explicit submission copy step', async() => {

        const fixture = await createTextureCopyFixture()

        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .upload(fixture.upload)
            .copy(fixture.copy)
            .submit()

        expect(fixture.source).to.be.instanceOf(TextureResource)
        expect(fixture.target).to.be.instanceOf(TextureResource)
        expect(fixture.copy).to.be.instanceOf(CopyCommand)
        expect(fixture.copy.commandKind).to.equal('copy')
        expect(fixture.copy.copyKind).to.equal('texture-to-texture')
        expect(fixture.copy.source).to.deep.equal({
            resource: fixture.source,
            contentEpoch: 1,
        })
        expect(fixture.copy.target).to.equal(fixture.target)
        expect(fixture.copy.whenMissing).to.equal('throw')
        expect(fixture.copy.sourceOrigin).to.deep.equal({ x: 1, y: 1, z: 0 })
        expect(fixture.copy.targetOrigin).to.deep.equal({ x: 2, y: 0, z: 0 })
        expect(fixture.copy.size).to.deep.equal({ width: 2, height: 2, depthOrArrayLayers: 1 })

        expect(fixture.calls.queueTextureWrites).to.have.length(1)
        expect(fixture.calls.textureCopies).to.deep.equal([
            {
                source: {
                    texture: fixture.source.gpuTexture,
                    origin: { x: 1, y: 1, z: 0 },
                    mipLevel: 0,
                    aspect: 'all',
                },
                destination: {
                    texture: fixture.target.gpuTexture,
                    origin: { x: 2, y: 0, z: 0 },
                    mipLevel: 0,
                    aspect: 'all',
                },
                size: { width: 2, height: 2, depthOrArrayLayers: 1 },
            },
        ])
        expect(fixture.calls.queueSubmissions).to.have.length(1)
        expect(fixture.source.contentEpoch).to.equal(1)
        expect(fixture.target.contentEpoch).to.equal(1)

        await submitted.done
    })

    it('copies buffer texel layouts into texture regions through an explicit submission copy step', async() => {

        const fixture = await createBufferToTextureCopyFixture()

        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .upload(fixture.upload)
            .copy(fixture.copy)
            .submit()

        expect(fixture.copy).to.be.instanceOf(CopyCommand)
        expect(fixture.copy.commandKind).to.equal('copy')
        expect(fixture.copy.copyKind).to.equal('buffer-to-texture')
        expect(fixture.copy.source).to.deep.equal({
            resource: fixture.source,
            contentEpoch: 1,
        })
        expect(fixture.copy.sourceLayout).to.deep.equal({ offset: 256, bytesPerRow: 256, rowsPerImage: 4 })
        expect(fixture.copy.target).to.equal(fixture.target)
        expect(fixture.copy.targetOrigin).to.deep.equal({ x: 1, y: 1, z: 0 })
        expect(fixture.copy.targetMipLevel).to.equal(0)
        expect(fixture.copy.targetAspect).to.equal('all')
        expect(fixture.copy.size).to.deep.equal({ width: 2, height: 2, depthOrArrayLayers: 1 })

        expect(fixture.calls.bufferTextureCopies).to.deep.equal([
            {
                source: {
                    buffer: fixture.source.gpuBuffer,
                    offset: 256,
                    bytesPerRow: 256,
                    rowsPerImage: 4,
                },
                destination: {
                    texture: fixture.target.gpuTexture,
                    origin: { x: 1, y: 1, z: 0 },
                    mipLevel: 0,
                    aspect: 'all',
                },
                size: { width: 2, height: 2, depthOrArrayLayers: 1 },
            },
        ])
        expect(fixture.source.contentEpoch).to.equal(1)
        expect(fixture.target.contentEpoch).to.equal(1)

        await submitted.done
    })

    it('copies texture regions into buffer texel layouts through an explicit submission copy step', async() => {

        const fixture = await createTextureToBufferCopyFixture()

        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .upload(fixture.upload)
            .copy(fixture.copy)
            .submit()

        expect(fixture.copy).to.be.instanceOf(CopyCommand)
        expect(fixture.copy.commandKind).to.equal('copy')
        expect(fixture.copy.copyKind).to.equal('texture-to-buffer')
        expect(fixture.copy.source).to.deep.equal({
            resource: fixture.source,
            contentEpoch: 1,
        })
        expect(fixture.copy.sourceOrigin).to.deep.equal({ x: 1, y: 1, z: 0 })
        expect(fixture.copy.sourceMipLevel).to.equal(0)
        expect(fixture.copy.sourceAspect).to.equal('all')
        expect(fixture.copy.target).to.equal(fixture.target)
        expect(fixture.copy.targetLayout).to.deep.equal({ offset: 128, bytesPerRow: 256, rowsPerImage: 4 })
        expect(fixture.copy.size).to.deep.equal({ width: 2, height: 2, depthOrArrayLayers: 1 })

        expect(fixture.calls.textureBufferCopies).to.deep.equal([
            {
                source: {
                    texture: fixture.source.gpuTexture,
                    origin: { x: 1, y: 1, z: 0 },
                    mipLevel: 0,
                    aspect: 'all',
                },
                destination: {
                    buffer: fixture.target.gpuBuffer,
                    offset: 128,
                    bytesPerRow: 256,
                    rowsPerImage: 4,
                },
                size: { width: 2, height: 2, depthOrArrayLayers: 1 },
            },
        ])
        expect(fixture.source.contentEpoch).to.equal(1)
        expect(fixture.target.contentEpoch).to.equal(1)

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

    it('advances only the texture copy target contentEpoch and preserves allocationVersion', async() => {

        const fixture = await createTextureCopyFixture()
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

    it('advances only buffer-texture copy targets and preserves allocationVersion', async() => {

        for (const createFixture of [ createBufferToTextureCopyFixture, createTextureToBufferCopyFixture ]) {
            const fixture = await createFixture()
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
        }
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

    it('rejects invalid texture copy descriptors with structured diagnostics', async() => {

        const fixture = await createTextureCopyFixture()
        const nonCopySource = fixture.runtime.createTexture({
            size: { width: 4, height: 4 },
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
        })
        const nonCopyTarget = fixture.runtime.createTexture({
            size: { width: 4, height: 4 },
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_COPY_SRC | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
        })
        const mismatchedFormatTarget = fixture.runtime.createTexture({
            size: { width: 4, height: 4 },
            format: 'rgba8uint',
            usage: GPU_TEXTURE_USAGE_COPY_DST,
        })
        const multisampledTarget = fixture.runtime.createTexture({
            size: { width: 4, height: 4 },
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
            sampleCount: 4,
        })

        for (const descriptor of [
            { source: copySource(nonCopySource), target: fixture.target, size: { width: 1, height: 1 }, whenMissing: 'throw' },
            { source: copySource(fixture.source), target: nonCopyTarget, size: { width: 1, height: 1 }, whenMissing: 'throw' },
        ]) {
            await expectScratchDiagnostic(() => fixture.runtime.createCopyCommand(descriptor), {
                code: 'SCRATCH_RESOURCE_USAGE_MISSING',
                severity: 'error',
                phase: 'resource',
            })
        }

        for (const descriptor of [
            { source: copySource(fixture.source), target: mismatchedFormatTarget, size: { width: 1, height: 1 }, whenMissing: 'throw' },
            { source: copySource(fixture.source), target: multisampledTarget, size: { width: 1, height: 1 }, whenMissing: 'throw' },
            { source: copySource(fixture.source), target: fixture.source, size: { width: 1, height: 1 }, whenMissing: 'throw' },
            { source: copySource(fixture.source), target: fixture.target, size: { width: 0, height: 1 }, whenMissing: 'throw' },
            { source: copySource(fixture.source), sourceOrigin: 5, target: fixture.target, size: { width: 1, height: 1 }, whenMissing: 'throw' },
            { source: copySource(fixture.source), target: fixture.target, targetOrigin: 'bad', size: { width: 1, height: 1 }, whenMissing: 'throw' },
            { source: copySource(fixture.source), sourceOrigin: { x: 3, y: 3 }, target: fixture.target, size: { width: 2, height: 2 }, whenMissing: 'throw' },
            { source: copySource(fixture.source), target: fixture.target, targetOrigin: { x: 3, y: 3 }, size: { width: 2, height: 2 }, whenMissing: 'throw' },
        ]) {
            await expectScratchDiagnostic(() => fixture.runtime.createCopyCommand(descriptor), {
                code: 'SCRATCH_COMMAND_COPY_RANGE_INVALID',
                severity: 'error',
                phase: 'command',
            })
        }
    })

    it('rejects invalid buffer-texture copy usage, layout, mip, and aspect descriptors with structured diagnostics', async() => {

        const bufferToTexture = await createBufferToTextureCopyFixture()
        const textureToBuffer = await createTextureToBufferCopyFixture()
        const nonCopyBufferSource = bufferToTexture.runtime.createBuffer({
            size: 1024,
            usage: GPU_BUFFER_USAGE_COPY_DST,
        })
        const nonCopyTextureTarget = bufferToTexture.runtime.createTexture({
            size: { width: 4, height: 4 },
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_TEXTURE_BINDING,
        })
        const nonCopyTextureSource = textureToBuffer.runtime.createTexture({
            size: { width: 4, height: 4 },
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
        })
        const nonCopyBufferTarget = textureToBuffer.runtime.createBuffer({
            size: 1024,
            usage: GPU_BUFFER_USAGE_COPY_SRC,
        })

        for (const { runtime, descriptor } of [
            { runtime: bufferToTexture.runtime, descriptor: { source: copySource(nonCopyBufferSource), sourceLayout: { bytesPerRow: 256 }, target: bufferToTexture.target, size: { width: 1, height: 1 }, whenMissing: 'throw' } },
            { runtime: bufferToTexture.runtime, descriptor: { source: copySource(bufferToTexture.source), sourceLayout: { bytesPerRow: 256 }, target: nonCopyTextureTarget, size: { width: 1, height: 1 }, whenMissing: 'throw' } },
            { runtime: textureToBuffer.runtime, descriptor: { source: copySource(nonCopyTextureSource), target: textureToBuffer.target, targetLayout: { bytesPerRow: 256 }, size: { width: 1, height: 1 }, whenMissing: 'throw' } },
            { runtime: textureToBuffer.runtime, descriptor: { source: copySource(textureToBuffer.source), target: nonCopyBufferTarget, targetLayout: { bytesPerRow: 256 }, size: { width: 1, height: 1 }, whenMissing: 'throw' } },
        ]) {
            await expectScratchDiagnostic(() => runtime.createCopyCommand(descriptor), {
                code: 'SCRATCH_RESOURCE_USAGE_MISSING',
                severity: 'error',
                phase: 'resource',
            })
        }

        for (const { runtime, descriptor } of [
            { runtime: bufferToTexture.runtime, descriptor: { source: copySource(bufferToTexture.source), sourceLayout: { bytesPerRow: 8 }, target: bufferToTexture.target, size: { width: 1, height: 1 }, whenMissing: 'throw' } },
            { runtime: bufferToTexture.runtime, descriptor: { source: copySource(bufferToTexture.source), sourceLayout: { offset: -4, bytesPerRow: 256 }, target: bufferToTexture.target, size: { width: 1, height: 1 }, whenMissing: 'throw' } },
            { runtime: bufferToTexture.runtime, descriptor: { source: copySource(bufferToTexture.source), sourceLayout: { bytesPerRow: 256, rowsPerImage: 1 }, target: bufferToTexture.target, size: { width: 1, height: 2 }, whenMissing: 'throw' } },
            { runtime: bufferToTexture.runtime, descriptor: { source: copySource(bufferToTexture.source), sourceLayout: { offset: 900, bytesPerRow: 256, rowsPerImage: 4 }, target: bufferToTexture.target, size: { width: 2, height: 2 }, whenMissing: 'throw' } },
            { runtime: bufferToTexture.runtime, descriptor: { source: copySource(bufferToTexture.source), sourceLayout: { bytesPerRow: 256 }, target: bufferToTexture.target, targetMipLevel: 1, size: { width: 1, height: 1 }, whenMissing: 'throw' } },
            { runtime: bufferToTexture.runtime, descriptor: { source: copySource(bufferToTexture.source), sourceLayout: { bytesPerRow: 256 }, target: bufferToTexture.target, targetAspect: 'depth-only', size: { width: 1, height: 1 }, whenMissing: 'throw' } },
            { runtime: textureToBuffer.runtime, descriptor: { source: copySource(textureToBuffer.source), sourceMipLevel: 1, target: textureToBuffer.target, targetLayout: { bytesPerRow: 256 }, size: { width: 1, height: 1 }, whenMissing: 'throw' } },
            { runtime: textureToBuffer.runtime, descriptor: { source: copySource(textureToBuffer.source), sourceAspect: 'stencil-only', target: textureToBuffer.target, targetLayout: { bytesPerRow: 256 }, size: { width: 1, height: 1 }, whenMissing: 'throw' } },
            { runtime: textureToBuffer.runtime, descriptor: { source: copySource(textureToBuffer.source), target: textureToBuffer.target, targetLayout: { bytesPerRow: 8 }, size: { width: 1, height: 1 }, whenMissing: 'throw' } },
        ]) {
            await expectScratchDiagnostic(() => runtime.createCopyCommand(descriptor), {
                code: 'SCRATCH_COMMAND_COPY_RANGE_INVALID',
                severity: 'error',
                phase: 'command',
            })
        }
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
