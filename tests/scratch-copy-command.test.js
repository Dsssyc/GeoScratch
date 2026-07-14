import { expect } from 'chai'
import fs from 'node:fs'
import {
    BindSet,
    CopyCommand,
    ScratchDiagnosticError,
    ScratchRuntime,
    TextureResource,
} from 'geoscratch'
import { createFakeGpu } from './scratch-test-utils.js'

const webGpuTypesSource = fs.readFileSync(
    new URL('../node_modules/@webgpu/types/dist/index.d.ts', import.meta.url),
    'utf8'
)

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

function copySource(resource, contentEpoch = resource.contentEpoch, region = {}) {

    if (resource instanceof TextureResource) return { resource, contentEpoch }
    return { region: resource.region(region), contentEpoch }
}

function webGpuTypeStringUnion(aliasName) {

    const match = webGpuTypesSource.match(new RegExp(`type\\s+${aliasName}\\s*=([\\s\\S]*?);`))
    expect(match, `${aliasName} declaration`).to.not.equal(null)
    return [ ...match[1].matchAll(/"([^"]+)"/g) ].map(entry => entry[1]).sort()
}

async function createCopyFixture() {

    const fake = createFakeGpu()
    const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
    const source = await runtime.createBuffer({
        label: 'copy source',
        size: 32,
        usage: GPU_BUFFER_USAGE_COPY_SRC | GPU_BUFFER_USAGE_COPY_DST,
    })
    const target = await runtime.createBuffer({
        label: 'copy target',
        size: 32,
        usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_UNIFORM,
    })
    const upload = runtime.createUploadCommand({
        label: 'upload copy source',
        target: (source).region({ offset: 0 }),
        data: sourceBytes(),
    })
    const copy = runtime.createCopyCommand({
        label: 'copy source slice',
        source: copySource(source, 1, { offset: 4, size: 16 }),
        target: target.region({ offset: 8, size: 16 }),
        whenMissing: 'throw',
    })
    const bindLayout = await runtime.createBindLayout({
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
    const bindSet = await runtime.createBindSet(bindLayout, {
        targetUniforms: target.region(),
    }, {
        label: 'copy target bind set',
    })

    return { ...fake, runtime, source, target, upload, copy, bindLayout, bindSet }
}

async function createTextureCopyFixture() {

    const fake = createFakeGpu()
    const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
    const source = await runtime.createTexture({
        label: 'texture copy source',
        size: { width: 4, height: 4 },
        format: 'rgba8unorm',
        usage: GPU_TEXTURE_USAGE_COPY_SRC | GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
    })
    const target = await runtime.createTexture({
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
    const source = await runtime.createBuffer({
        label: 'buffer texture copy source',
        size: 1024,
        usage: GPU_BUFFER_USAGE_COPY_SRC | GPU_BUFFER_USAGE_COPY_DST,
    })
    const target = await runtime.createTexture({
        label: 'buffer texture copy target',
        size: { width: 4, height: 4 },
        format: 'rgba8unorm',
        usage: GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
    })
    const upload = runtime.createUploadCommand({
        label: 'upload buffer texture copy source',
        target: (source).region(),
        data: new Uint8Array(1024),
    })
    const copy = runtime.createCopyCommand({
        label: 'copy buffer into texture',
        source: copySource(source, 1, { offset: 256, size: 264 }),
        sourceLayout: { bytesPerRow: 256, rowsPerImage: 4 },
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
    const source = await runtime.createTexture({
        label: 'texture buffer copy source',
        size: { width: 4, height: 4 },
        format: 'rgba8unorm',
        usage: GPU_TEXTURE_USAGE_COPY_SRC | GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
    })
    const target = await runtime.createBuffer({
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
        target: target.region({ offset: 128, size: 264 }),
        targetLayout: { bytesPerRow: 256, rowsPerImage: 4 },
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
            region: fixture.source.region({ offset: 4, size: 16 }),
            contentEpoch: 1,
        })
        expect(fixture.copy.target).to.deep.equal(fixture.target.region({ offset: 8, size: 16 }))
        expect(fixture.copy.whenMissing).to.equal('throw')

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
            region: fixture.source.region({ offset: 256, size: 264 }),
            contentEpoch: 1,
        })
        expect(fixture.copy.sourceLayout).to.deep.equal({ bytesPerRow: 256, rowsPerImage: 4 })
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
        expect(fixture.copy.target).to.deep.equal(fixture.target.region({ offset: 128, size: 264 }))
        expect(fixture.copy.targetLayout).to.deep.equal({ bytesPerRow: 256, rowsPerImage: 4 })
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

    it('uses current texture allocations for every texture copy direction', async() => {

        const textureCopy = await createTextureCopyFixture()
        const textureCopyBuilder = textureCopy.runtime.createSubmission({ validation: 'throw' })
            .upload(textureCopy.upload)
            .copy(textureCopy.copy)
        const previousTextureSource = textureCopy.source.gpuTexture
        const previousTextureTarget = textureCopy.target.gpuTexture
        await textureCopy.source.resize([ 8, 8 ])
        await textureCopy.target.resize([ 8, 8 ])
        const textureCopySubmitted = textureCopyBuilder.submit()

        expect(previousTextureSource.destroyed).to.equal(true)
        expect(previousTextureTarget.destroyed).to.equal(true)
        expect(textureCopy.calls.queueTextureWrites[0].destination.texture)
            .to.equal(textureCopy.source.gpuTexture)
        expect(textureCopy.calls.textureCopies[0].source.texture)
            .to.equal(textureCopy.source.gpuTexture)
        expect(textureCopy.calls.textureCopies[0].destination.texture)
            .to.equal(textureCopy.target.gpuTexture)
        expect(textureCopySubmitted.resourceAccesses
            .filter(access => access.resourceKind === 'TextureResource')
            .every(access => access.allocationVersion === 2)).to.equal(true)

        const bufferToTexture = await createBufferToTextureCopyFixture()
        const bufferToTextureBuilder = bufferToTexture.runtime
            .createSubmission({ validation: 'throw' })
            .upload(bufferToTexture.upload)
            .copy(bufferToTexture.copy)
        const previousBufferTarget = bufferToTexture.target.gpuTexture
        await bufferToTexture.target.resize([ 8, 8 ])
        const bufferToTextureSubmitted = bufferToTextureBuilder.submit()

        expect(previousBufferTarget.destroyed).to.equal(true)
        expect(bufferToTexture.calls.bufferTextureCopies[0].destination.texture)
            .to.equal(bufferToTexture.target.gpuTexture)
        expect(bufferToTextureSubmitted.resourceAccesses
            .find(access => access.resourceId === bufferToTexture.target.id))
            .to.include({ allocationVersion: 2 })

        const textureToBuffer = await createTextureToBufferCopyFixture()
        const textureToBufferBuilder = textureToBuffer.runtime
            .createSubmission({ validation: 'throw' })
            .upload(textureToBuffer.upload)
            .copy(textureToBuffer.copy)
        const previousBufferSource = textureToBuffer.source.gpuTexture
        await textureToBuffer.source.resize([ 8, 8 ])
        const textureToBufferSubmitted = textureToBufferBuilder.submit()

        expect(previousBufferSource.destroyed).to.equal(true)
        expect(textureToBuffer.calls.queueTextureWrites[0].destination.texture)
            .to.equal(textureToBuffer.source.gpuTexture)
        expect(textureToBuffer.calls.textureBufferCopies[0].source.texture)
            .to.equal(textureToBuffer.source.gpuTexture)
        expect(textureToBufferSubmitted.resourceAccesses
            .find(access => access.resourceId === textureToBuffer.source.id))
            .to.include({ allocationVersion: 2 })

        await Promise.all([
            textureCopySubmitted.done,
            bufferToTextureSubmitted.done,
            textureToBufferSubmitted.done,
        ])
    })

    it('revalidates shrink-invalidated copy ranges before encoder or queue effects', async() => {

        const textureCopy = await createTextureCopyFixture()
        const textureCopyBuilder = textureCopy.runtime.createSubmission({ validation: 'throw' })
            .upload(textureCopy.upload)
            .copy(textureCopy.copy)
        await textureCopy.target.resize([ 2, 2 ])

        await expectScratchDiagnostic(() => textureCopyBuilder.submit(), {
            code: 'SCRATCH_COMMAND_COPY_RANGE_INVALID',
            severity: 'error',
            phase: 'command',
        })
        expect(textureCopy.calls.queueTextureWrites).to.have.length(0)
        expect(textureCopy.calls.commandEncoders).to.have.length(0)
        expect(textureCopy.calls.textureCopies).to.have.length(0)
        expect(textureCopy.calls.queueSubmissions).to.have.length(0)

        const bufferToTexture = await createBufferToTextureCopyFixture()
        const bufferToTextureBuilder = bufferToTexture.runtime
            .createSubmission({ validation: 'throw' })
            .upload(bufferToTexture.upload)
            .copy(bufferToTexture.copy)
        await bufferToTexture.target.resize([ 2, 2 ])

        await expectScratchDiagnostic(() => bufferToTextureBuilder.submit(), {
            code: 'SCRATCH_COMMAND_COPY_RANGE_INVALID',
            severity: 'error',
            phase: 'command',
        })
        expect(bufferToTexture.calls.queueWrites).to.have.length(0)
        expect(bufferToTexture.calls.commandEncoders).to.have.length(0)
        expect(bufferToTexture.calls.bufferTextureCopies).to.have.length(0)
        expect(bufferToTexture.calls.queueSubmissions).to.have.length(0)

        const textureToBuffer = await createTextureToBufferCopyFixture()
        await textureToBuffer.source.resize([ 2, 2 ])
        const replacementUpload = textureToBuffer.runtime.createTextureUploadCommand({
            target: textureToBuffer.source,
            data: new Uint8Array(16),
            layout: { bytesPerRow: 8, rowsPerImage: 2 },
            size: { width: 2, height: 2 },
        })
        const textureToBufferBuilder = textureToBuffer.runtime
            .createSubmission({ validation: 'throw' })
            .upload(replacementUpload)
            .copy(textureToBuffer.copy)

        await expectScratchDiagnostic(() => textureToBufferBuilder.submit(), {
            code: 'SCRATCH_COMMAND_COPY_RANGE_INVALID',
            severity: 'error',
            phase: 'command',
        })
        expect(textureToBuffer.calls.queueTextureWrites).to.have.length(0)
        expect(textureToBuffer.calls.commandEncoders).to.have.length(0)
        expect(textureToBuffer.calls.textureBufferCopies).to.have.length(0)
        expect(textureToBuffer.calls.queueSubmissions).to.have.length(0)
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
        const firstBindGroup = fixture.calls.bindGroups[0]

        expect(fixture.bindSet).to.be.instanceOf(BindSet)
        expect(fixture.calls.bindGroups).to.have.length(1)

        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .upload(fixture.upload)
            .copy(fixture.copy)
            .submit()

        expect(fixture.target.contentEpoch).to.equal(1)

        await fixture.bindSet.prepare()
        expect(fixture.calls.bindGroups[0]).to.equal(firstBindGroup)
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
                target: fixtureA.target.region({ size: 4 }),
                whenMissing: 'throw',
            }), {
                code: 'SCRATCH_COMMAND_COPY_SOURCE_INVALID',
                severity: 'error',
                phase: 'command',
            })
        }

        await expectScratchDiagnostic(() => fixtureA.runtime.createCopyCommand({
            source: copySource(fixtureB.source, fixtureB.source.contentEpoch, { size: 4 }),
            target: fixtureA.target.region({ size: 4 }),
        }), {
            code: 'SCRATCH_RESOURCE_WRONG_RUNTIME',
            severity: 'error',
            phase: 'resource',
        })

        fixtureA.source.dispose()

        await expectScratchDiagnostic(() => fixtureA.runtime.createCopyCommand({
            source: copySource(fixtureA.source, fixtureA.source.contentEpoch, { size: 4 }),
            target: fixtureA.target.region({ size: 4 }),
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
            whenMissing: 'throw',
        }), {
            code: 'SCRATCH_COMMAND_COPY_RANGE_INVALID',
            severity: 'error',
            phase: 'command',
        })

        await expectScratchDiagnostic(() => fixtureA.runtime.createCopyCommand({
            source: copySource(fixtureA.source),
            target: fixtureA.target.region(),
        }), {
            code: 'SCRATCH_COMMAND_READINESS_POLICY_MISSING',
            severity: 'error',
            phase: 'command',
        })

        await expectScratchDiagnostic(() => fixtureA.runtime.createCopyCommand({
            source: copySource(fixtureA.source),
            target: fixtureA.target.region(),
            whenMissing: 'skip-command',
        }), {
            code: 'SCRATCH_COMMAND_READINESS_POLICY_MISSING',
            severity: 'error',
            phase: 'command',
        })

        await expectScratchDiagnostic(() => fixtureA.runtime.createCopyCommand({
            source: copySource(fixtureA.source),
            target: fixtureB.target.region(),
            whenMissing: 'throw',
        }), {
            code: 'SCRATCH_RESOURCE_WRONG_RUNTIME',
            severity: 'error',
            phase: 'resource',
        })

        const replacementSource = await fixtureA.runtime.createBuffer({
            size: 32,
            usage: GPU_BUFFER_USAGE_COPY_SRC | GPU_BUFFER_USAGE_COPY_DST,
        })
        fixtureA.target.dispose()

        await expectScratchDiagnostic(() => fixtureA.runtime.createCopyCommand({
            source: copySource(replacementSource),
            target: fixtureA.target.region(),
            whenMissing: 'throw',
        }), {
            code: 'SCRATCH_RESOURCE_DISPOSED',
            severity: 'error',
            phase: 'resource',
        })
    })

    it('rejects buffers missing copy usages with structured diagnostics', async() => {

        const fixture = await createCopyFixture()
        const nonCopySource = await fixture.runtime.createBuffer({
            size: 16,
            usage: GPU_BUFFER_USAGE_COPY_DST,
        })
        const nonCopyTarget = await fixture.runtime.createBuffer({
            size: 16,
            usage: GPU_BUFFER_USAGE_COPY_SRC,
        })

        await expectScratchDiagnostic(() => fixture.runtime.createCopyCommand({
            source: copySource(nonCopySource),
            target: fixture.target.region({ size: 16 }),
            whenMissing: 'throw',
        }), {
            code: 'SCRATCH_RESOURCE_USAGE_MISSING',
            severity: 'error',
            phase: 'resource',
        })

        await expectScratchDiagnostic(() => fixture.runtime.createCopyCommand({
            source: copySource(fixture.source, fixture.source.contentEpoch, { size: 16 }),
            target: nonCopyTarget.region(),
            whenMissing: 'throw',
        }), {
            code: 'SCRATCH_RESOURCE_USAGE_MISSING',
            severity: 'error',
            phase: 'resource',
        })
    })

    it('rejects invalid texture copy descriptors with structured diagnostics', async() => {

        const fixture = await createTextureCopyFixture()
        const nonCopySource = await fixture.runtime.createTexture({
            size: { width: 4, height: 4 },
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
        })
        const nonCopyTarget = await fixture.runtime.createTexture({
            size: { width: 4, height: 4 },
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_COPY_SRC | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
        })
        const mismatchedFormatTarget = await fixture.runtime.createTexture({
            size: { width: 4, height: 4 },
            format: 'rgba8uint',
            usage: GPU_TEXTURE_USAGE_COPY_DST,
        })
        const multisampledTarget = await fixture.runtime.createTexture({
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

    it('validates 3d copy depth against each physical mip extent', async() => {

        const fake = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const texture = await runtime.createTexture({
            size: { width: 8, height: 8, depthOrArrayLayers: 8 },
            dimension: '3d',
            mipLevelCount: 4,
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_COPY_SRC | GPU_TEXTURE_USAGE_COPY_DST,
        })
        const other = await runtime.createTexture({
            size: { width: 8, height: 8, depthOrArrayLayers: 8 },
            dimension: '3d',
            mipLevelCount: 4,
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_COPY_SRC | GPU_TEXTURE_USAGE_COPY_DST,
        })
        const buffer = await runtime.createBuffer({
            size: 4096,
            usage: GPU_BUFFER_USAGE_COPY_SRC | GPU_BUFFER_USAGE_COPY_DST,
        })
        const size = { width: 2, height: 2, depthOrArrayLayers: 3 }

        for (const descriptor of [
            {
                source: copySource(texture),
                sourceMipLevel: 2,
                target: other,
                targetMipLevel: 2,
                size,
                whenMissing: 'throw',
            },
            {
                source: copySource(buffer),
                sourceLayout: { bytesPerRow: 256, rowsPerImage: 2 },
                target: texture,
                targetMipLevel: 2,
                size,
                whenMissing: 'throw',
            },
            {
                source: copySource(texture),
                sourceMipLevel: 2,
                target: buffer.region(),
                targetLayout: { bytesPerRow: 256, rowsPerImage: 2 },
                size,
                whenMissing: 'throw',
            },
        ]) {
            await expectScratchDiagnostic(() => runtime.createCopyCommand(descriptor), {
                code: 'SCRATCH_COMMAND_COPY_RANGE_INVALID',
                severity: 'error',
                phase: 'command',
            })
        }
    })

    it('allows same-texture copies only across disjoint native subresources', async() => {

        const fake = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const texture = await runtime.createTexture({
            size: { width: 8, height: 8, depthOrArrayLayers: 3 },
            mipLevelCount: 3,
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_COPY_SRC | GPU_TEXTURE_USAGE_COPY_DST,
        })

        const differentMips = runtime.createCopyCommand({
            source: copySource(texture),
            sourceMipLevel: 0,
            target: texture,
            targetMipLevel: 1,
            size: { width: 4, height: 4, depthOrArrayLayers: 1 },
            whenMissing: 'throw',
        })
        const differentLayers = runtime.createCopyCommand({
            source: copySource(texture),
            sourceOrigin: { x: 0, y: 0, z: 0 },
            target: texture,
            targetOrigin: { x: 0, y: 0, z: 1 },
            size: { width: 4, height: 4, depthOrArrayLayers: 1 },
            whenMissing: 'throw',
        })

        expect(differentMips.copyKind).to.equal('texture-to-texture')
        expect(differentLayers.copyKind).to.equal('texture-to-texture')

        await expectScratchDiagnostic(() => runtime.createCopyCommand({
            source: copySource(texture),
            sourceOrigin: { x: 0, y: 0, z: 0 },
            target: texture,
            targetOrigin: { x: 0, y: 0, z: 1 },
            size: { width: 4, height: 4, depthOrArrayLayers: 2 },
            whenMissing: 'throw',
        }), {
            code: 'SCRATCH_COMMAND_COPY_RANGE_INVALID',
            severity: 'error',
            phase: 'command',
        })
    })

    it('accepts native copy-compatible linear and srgb texture formats', async() => {

        const fake = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const source = await runtime.createTexture({
            size: { width: 4, height: 4 },
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_COPY_SRC,
        })
        const target = await runtime.createTexture({
            size: { width: 4, height: 4 },
            format: 'rgba8unorm-srgb',
            usage: GPU_TEXTURE_USAGE_COPY_DST,
        })

        const copy = runtime.createCopyCommand({
            source: copySource(source),
            target,
            size: { width: 4, height: 4 },
            whenMissing: 'throw',
        })

        expect(copy.copyKind).to.equal('texture-to-texture')
    })

    it('allows equal multisample texture copies only on core devices', async() => {

        for (const coreFeatures of [ false, true ]) {
            const fake = createFakeGpu()
            if (coreFeatures) fake.device.features.add('core-features-and-limits')
            const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
            const source = await runtime.createTexture({
                size: { width: 4, height: 4 },
                format: 'rgba8unorm',
                usage: GPU_TEXTURE_USAGE_COPY_SRC | GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
                sampleCount: 4,
            })
            const target = await runtime.createTexture({
                size: { width: 4, height: 4 },
                format: 'rgba8unorm',
                usage: GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
                sampleCount: 4,
            })
            const descriptor = {
                source: copySource(source),
                target,
                size: { width: 4, height: 4 },
                whenMissing: 'throw',
            }

            if (!coreFeatures) {
                await expectScratchDiagnostic(() => runtime.createCopyCommand(descriptor), {
                    code: 'SCRATCH_COMMAND_COPY_RANGE_INVALID',
                    severity: 'error',
                    phase: 'command',
                })
                continue
            }
            expect(runtime.createCopyCommand(descriptor).copyKind).to.equal('texture-to-texture')
            await expectScratchDiagnostic(() => runtime.createCopyCommand({
                ...descriptor,
                size: { width: 2, height: 4 },
            }), {
                code: 'SCRATCH_COMMAND_COPY_RANGE_INVALID',
                severity: 'error',
                phase: 'command',
            })
        }
    })

    it('requires full physical subresources for depth-stencil texture copies', async() => {

        const fake = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const source = await runtime.createTexture({
            size: { width: 4, height: 4 },
            format: 'depth32float',
            usage: GPU_TEXTURE_USAGE_COPY_SRC,
        })
        const target = await runtime.createTexture({
            size: { width: 4, height: 4 },
            format: 'depth32float',
            usage: GPU_TEXTURE_USAGE_COPY_DST,
        })
        const descriptor = {
            source: copySource(source),
            target,
            size: { width: 4, height: 4 },
            whenMissing: 'throw',
        }

        expect(runtime.createCopyCommand(descriptor).copyKind).to.equal('texture-to-texture')
        await expectScratchDiagnostic(() => runtime.createCopyCommand({
            ...descriptor,
            size: { width: 2, height: 4 },
        }), {
            code: 'SCRATCH_COMMAND_COPY_RANGE_INVALID',
            severity: 'error',
            phase: 'command',
        })
    })

    it('allows compressed texture copies only on core devices', async() => {

        for (const coreFeatures of [ false, true ]) {
            const fake = createFakeGpu()
            fake.device.features.add('texture-compression-bc')
            if (coreFeatures) fake.device.features.add('core-features-and-limits')
            const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
            const source = await runtime.createTexture({
                size: { width: 4, height: 4 },
                format: 'bc1-rgba-unorm',
                usage: GPU_TEXTURE_USAGE_COPY_SRC,
            })
            const target = await runtime.createTexture({
                size: { width: 4, height: 4 },
                format: 'bc1-rgba-unorm',
                usage: GPU_TEXTURE_USAGE_COPY_DST,
            })
            const descriptor = {
                source: copySource(source),
                target,
                size: { width: 4, height: 4 },
                whenMissing: 'throw',
            }

            if (!coreFeatures) {
                await expectScratchDiagnostic(() => runtime.createCopyCommand(descriptor), {
                    code: 'SCRATCH_COMMAND_COPY_RANGE_INVALID',
                    severity: 'error',
                    phase: 'command',
                })
                continue
            }
            expect(runtime.createCopyCommand(descriptor).copyKind).to.equal('texture-to-texture')
        }
    })

    it('uses physical block-aligned mip extents for compressed texture copies', async() => {

        const fake = createFakeGpu()
        fake.device.features.add('core-features-and-limits')
        fake.device.features.add('texture-compression-bc')
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const source = await runtime.createTexture({
            size: { width: 12, height: 12 },
            mipLevelCount: 2,
            format: 'bc1-rgba-unorm',
            usage: GPU_TEXTURE_USAGE_COPY_SRC,
        })
        const target = await runtime.createTexture({
            size: { width: 12, height: 12 },
            mipLevelCount: 2,
            format: 'bc1-rgba-unorm',
            usage: GPU_TEXTURE_USAGE_COPY_DST,
        })
        const descriptor = {
            source: copySource(source),
            sourceMipLevel: 1,
            target,
            targetMipLevel: 1,
            size: { width: 8, height: 8 },
            whenMissing: 'throw',
        }

        expect(runtime.createCopyCommand(descriptor).copyKind).to.equal('texture-to-texture')
        for (const invalidDescriptor of [
            { ...descriptor, size: { width: 6, height: 6 } },
            {
                ...descriptor,
                sourceMipLevel: 0,
                targetMipLevel: 0,
                sourceOrigin: { x: 2, y: 0 },
                size: { width: 4, height: 4 },
            },
        ]) {
            await expectScratchDiagnostic(() => runtime.createCopyCommand(invalidDescriptor), {
                code: 'SCRATCH_COMMAND_COPY_RANGE_INVALID',
                severity: 'error',
                phase: 'command',
            })
        }
    })

    it('copies every native color texel-block footprint between buffers and textures', async() => {

        const plainGroups = [
            {
                bytesPerBlock: 1,
                formats: [ 'r8unorm', 'r8snorm', 'r8uint', 'r8sint' ],
            },
            {
                bytesPerBlock: 2,
                formats: [
                    'r16unorm', 'r16snorm', 'r16uint', 'r16sint', 'r16float',
                    'rg8unorm', 'rg8snorm', 'rg8uint', 'rg8sint',
                ],
            },
            {
                bytesPerBlock: 4,
                formats: [
                    'r32uint', 'r32sint', 'r32float',
                    'rg16unorm', 'rg16snorm', 'rg16uint', 'rg16sint', 'rg16float',
                    'rgba8unorm', 'rgba8unorm-srgb', 'rgba8snorm', 'rgba8uint', 'rgba8sint',
                    'bgra8unorm', 'bgra8unorm-srgb',
                    'rgb9e5ufloat', 'rgb10a2uint', 'rgb10a2unorm', 'rg11b10ufloat',
                ],
            },
            {
                bytesPerBlock: 8,
                formats: [
                    'rg32uint', 'rg32sint', 'rg32float',
                    'rgba16unorm', 'rgba16snorm', 'rgba16uint', 'rgba16sint', 'rgba16float',
                ],
            },
            {
                bytesPerBlock: 16,
                formats: [ 'rgba32uint', 'rgba32sint', 'rgba32float' ],
            },
        ]
        const compressedGroups = [
            {
                bytesPerBlock: 8,
                blockWidth: 4,
                blockHeight: 4,
                formats: [
                    'bc1-rgba-unorm', 'bc1-rgba-unorm-srgb',
                    'bc4-r-unorm', 'bc4-r-snorm',
                    'etc2-rgb8unorm', 'etc2-rgb8unorm-srgb',
                    'etc2-rgb8a1unorm', 'etc2-rgb8a1unorm-srgb',
                    'eac-r11unorm', 'eac-r11snorm',
                ],
            },
            {
                bytesPerBlock: 16,
                blockWidth: 4,
                blockHeight: 4,
                formats: [
                    'bc2-rgba-unorm', 'bc2-rgba-unorm-srgb',
                    'bc3-rgba-unorm', 'bc3-rgba-unorm-srgb',
                    'bc5-rg-unorm', 'bc5-rg-snorm',
                    'bc6h-rgb-ufloat', 'bc6h-rgb-float',
                    'bc7-rgba-unorm', 'bc7-rgba-unorm-srgb',
                    'etc2-rgba8unorm', 'etc2-rgba8unorm-srgb',
                    'eac-rg11unorm', 'eac-rg11snorm',
                ],
            },
            ...[ '4x4', '5x4', '5x5', '6x5', '6x6', '8x5', '8x6', '8x8', '10x5', '10x6', '10x8', '10x10', '12x10', '12x12' ]
                .map(dimensions => {
                    const [ blockWidth, blockHeight ] = dimensions.split('x').map(Number)
                    return {
                        bytesPerBlock: 16,
                        blockWidth,
                        blockHeight,
                        formats: [ `astc-${dimensions}-unorm`, `astc-${dimensions}-unorm-srgb` ],
                    }
                }),
        ]
        const formatEntries = [
            ...plainGroups.flatMap(group => group.formats.map(format => ({
                format,
                bytesPerBlock: group.bytesPerBlock,
                blockWidth: 1,
                blockHeight: 1,
            }))),
            ...compressedGroups.flatMap(group => group.formats.map(format => ({
                format,
                bytesPerBlock: group.bytesPerBlock,
                blockWidth: group.blockWidth,
                blockHeight: group.blockHeight,
            }))),
        ]
        const depthStencilFormats = new Set([
            'stencil8',
            'depth16unorm',
            'depth24plus',
            'depth24plus-stencil8',
            'depth32float',
            'depth32float-stencil8',
        ])
        const officialColorFormats = webGpuTypeStringUnion('GPUTextureFormat')
            .filter(format => !depthStencilFormats.has(format))
        expect(formatEntries.map(entry => entry.format).sort()).to.deep.equal(officialColorFormats)
        expect(formatEntries).to.have.length(95)

        const fake = createFakeGpu()
        for (const feature of [
            'core-features-and-limits',
            'texture-compression-bc',
            'texture-compression-etc2',
            'texture-compression-astc',
        ]) fake.device.features.add(feature)
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const sourceBuffer = await runtime.createBuffer({
            size: 4096,
            usage: GPU_BUFFER_USAGE_COPY_SRC,
        })
        const targetBuffer = await runtime.createBuffer({
            size: 4096,
            usage: GPU_BUFFER_USAGE_COPY_DST,
        })
        const encoder = fake.device.createCommandEncoder()

        for (const entry of formatEntries) {
            const texture = await runtime.createTexture({
                size: { width: entry.blockWidth, height: entry.blockHeight },
                format: entry.format,
                usage: GPU_TEXTURE_USAGE_COPY_SRC | GPU_TEXTURE_USAGE_COPY_DST,
            })
            const size = { width: entry.blockWidth, height: entry.blockHeight }
            const bufferToTexture = runtime.createCopyCommand({
                source: copySource(sourceBuffer, 0, { size: entry.bytesPerBlock }),
                sourceLayout: { bytesPerRow: 256 },
                target: texture,
                size,
                whenMissing: 'throw',
            })
            bufferToTexture.encode(encoder)
            const textureToBuffer = runtime.createCopyCommand({
                source: copySource(texture),
                target: targetBuffer.region({ size: entry.bytesPerBlock }),
                targetLayout: { bytesPerRow: 256 },
                size,
                whenMissing: 'throw',
            })
            textureToBuffer.encode(encoder)

            expect(bufferToTexture.sourceLayout, entry.format).to.deep.equal({
                bytesPerRow: 256,
                rowsPerImage: 1,
            })
            expect(textureToBuffer.targetLayout, entry.format).to.deep.equal({
                bytesPerRow: 256,
                rowsPerImage: 1,
            })
        }

        expect(fake.calls.bufferTextureCopies).to.have.length(95)
        expect(fake.calls.textureBufferCopies).to.have.length(95)

        const compatibilityFake = createFakeGpu()
        compatibilityFake.device.features.add('texture-compression-bc')
        const compatibilityRuntime = await ScratchRuntime.create({ gpu: compatibilityFake.gpu })
        const compatibilityBuffer = await compatibilityRuntime.createBuffer({
            size: 256,
            usage: GPU_BUFFER_USAGE_COPY_SRC | GPU_BUFFER_USAGE_COPY_DST,
        })
        const compatibilityTexture = await compatibilityRuntime.createTexture({
            size: { width: 4, height: 4 },
            format: 'bc1-rgba-unorm',
            usage: GPU_TEXTURE_USAGE_COPY_SRC | GPU_TEXTURE_USAGE_COPY_DST,
        })
        expect(compatibilityRuntime.createCopyCommand({
            source: copySource(compatibilityBuffer, 0, { size: 8 }),
            sourceLayout: { bytesPerRow: 256 },
            target: compatibilityTexture,
            size: { width: 4, height: 4 },
            whenMissing: 'throw',
        }).copyKind).to.equal('buffer-to-texture')
        await expectScratchDiagnostic(() => compatibilityRuntime.createCopyCommand({
            source: copySource(compatibilityTexture),
            target: compatibilityBuffer.region({ size: 8 }),
            targetLayout: { bytesPerRow: 256 },
            size: { width: 4, height: 4 },
            whenMissing: 'throw',
        }), {
            code: 'SCRATCH_COMMAND_COPY_RANGE_INVALID',
            severity: 'error',
            phase: 'command',
        })
    })

    it('applies native depth-stencil aspect footprints and direction limits', async() => {

        const fake = createFakeGpu()
        fake.device.features.add('depth32float-stencil8')
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const sourceBuffer = await runtime.createBuffer({
            size: 4096,
            usage: GPU_BUFFER_USAGE_COPY_SRC,
        })
        const targetBuffer = await runtime.createBuffer({
            size: 4096,
            usage: GPU_BUFFER_USAGE_COPY_DST,
        })
        const encoder = fake.device.createCommandEncoder()
        const textures = new Map()
        const texture = async(format) => {
            if (!textures.has(format)) {
                textures.set(format, await runtime.createTexture({
                    size: { width: 4, height: 4 },
                    format,
                    usage: GPU_TEXTURE_USAGE_COPY_SRC | GPU_TEXTURE_USAGE_COPY_DST,
                }))
            }
            return textures.get(format)
        }
        const requiredBytes = bytesPerBlock => 256 * 3 + 4 * bytesPerBlock
        const validCopies = [
            { direction: 'buffer-to-texture', format: 'stencil8', aspect: 'all', bytesPerBlock: 1 },
            { direction: 'texture-to-buffer', format: 'stencil8', aspect: 'stencil-only', bytesPerBlock: 1 },
            { direction: 'buffer-to-texture', format: 'depth16unorm', aspect: 'all', bytesPerBlock: 2 },
            { direction: 'texture-to-buffer', format: 'depth16unorm', aspect: 'depth-only', bytesPerBlock: 2 },
            { direction: 'buffer-to-texture', format: 'depth24plus-stencil8', aspect: 'stencil-only', bytesPerBlock: 1 },
            { direction: 'texture-to-buffer', format: 'depth24plus-stencil8', aspect: 'stencil-only', bytesPerBlock: 1 },
            { direction: 'texture-to-buffer', format: 'depth32float', aspect: 'all', bytesPerBlock: 4 },
            { direction: 'texture-to-buffer', format: 'depth32float-stencil8', aspect: 'depth-only', bytesPerBlock: 4 },
            { direction: 'buffer-to-texture', format: 'depth32float-stencil8', aspect: 'stencil-only', bytesPerBlock: 1 },
            { direction: 'texture-to-buffer', format: 'depth32float-stencil8', aspect: 'stencil-only', bytesPerBlock: 1 },
        ]

        for (const entry of validCopies) {
            const copyTexture = await texture(entry.format)
            const byteLength = requiredBytes(entry.bytesPerBlock)
            const descriptor = entry.direction === 'buffer-to-texture'
                ? {
                    source: copySource(sourceBuffer, 0, { size: byteLength }),
                    sourceLayout: { bytesPerRow: 256 },
                    target: copyTexture,
                    targetAspect: entry.aspect,
                    size: { width: 4, height: 4 },
                    whenMissing: 'throw',
                }
                : {
                    source: copySource(copyTexture),
                    sourceAspect: entry.aspect,
                    target: targetBuffer.region({ size: byteLength }),
                    targetLayout: { bytesPerRow: 256 },
                    size: { width: 4, height: 4 },
                    whenMissing: 'throw',
                }
            const copy = runtime.createCopyCommand(descriptor)
            copy.encode(encoder)
            expect(copy.copyKind).to.equal(entry.direction)
        }

        expect(fake.calls.bufferTextureCopies).to.have.length(4)
        expect(fake.calls.textureBufferCopies).to.have.length(6)

        const invalidCopies = [
            {
                source: copySource(sourceBuffer, 0, { size: requiredBytes(4) }),
                sourceLayout: { bytesPerRow: 256 },
                target: await texture('depth32float'),
                targetAspect: 'depth-only',
                size: { width: 4, height: 4 },
                whenMissing: 'throw',
            },
            {
                source: copySource(await texture('depth24plus')),
                sourceAspect: 'depth-only',
                target: targetBuffer.region({ size: requiredBytes(4) }),
                targetLayout: { bytesPerRow: 256 },
                size: { width: 4, height: 4 },
                whenMissing: 'throw',
            },
            {
                source: copySource(await texture('depth24plus-stencil8')),
                sourceAspect: 'all',
                target: targetBuffer.region({ size: requiredBytes(1) }),
                targetLayout: { bytesPerRow: 256 },
                size: { width: 4, height: 4 },
                whenMissing: 'throw',
            },
            {
                source: copySource(await texture('depth16unorm')),
                sourceAspect: 'depth-only',
                target: targetBuffer.region({ size: requiredBytes(2) }),
                targetLayout: { bytesPerRow: 256 },
                size: { width: 2, height: 4 },
                whenMissing: 'throw',
            },
            {
                source: copySource(sourceBuffer, 0, { offset: 1, size: requiredBytes(1) }),
                sourceLayout: { bytesPerRow: 256 },
                target: await texture('stencil8'),
                targetAspect: 'stencil-only',
                size: { width: 4, height: 4 },
                whenMissing: 'throw',
            },
        ]
        for (const descriptor of invalidCopies) {
            await expectScratchDiagnostic(() => runtime.createCopyCommand(descriptor), {
                code: 'SCRATCH_COMMAND_COPY_RANGE_INVALID',
                severity: 'error',
                phase: 'command',
            })
        }
    })

    it('rejects invalid buffer-texture copy usage, layout, mip, and aspect descriptors with structured diagnostics', async() => {

        const bufferToTexture = await createBufferToTextureCopyFixture()
        const textureToBuffer = await createTextureToBufferCopyFixture()
        const nonCopyBufferSource = await bufferToTexture.runtime.createBuffer({
            size: 1024,
            usage: GPU_BUFFER_USAGE_COPY_DST,
        })
        const nonCopyTextureTarget = await bufferToTexture.runtime.createTexture({
            size: { width: 4, height: 4 },
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_TEXTURE_BINDING,
        })
        const nonCopyTextureSource = await textureToBuffer.runtime.createTexture({
            size: { width: 4, height: 4 },
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
        })
        const nonCopyBufferTarget = await textureToBuffer.runtime.createBuffer({
            size: 1024,
            usage: GPU_BUFFER_USAGE_COPY_SRC,
        })

        for (const { runtime, descriptor } of [
            { runtime: bufferToTexture.runtime, descriptor: { source: copySource(nonCopyBufferSource), sourceLayout: { bytesPerRow: 256 }, target: bufferToTexture.target, size: { width: 1, height: 1 }, whenMissing: 'throw' } },
            { runtime: bufferToTexture.runtime, descriptor: { source: copySource(bufferToTexture.source), sourceLayout: { bytesPerRow: 256 }, target: nonCopyTextureTarget, size: { width: 1, height: 1 }, whenMissing: 'throw' } },
            { runtime: textureToBuffer.runtime, descriptor: { source: copySource(nonCopyTextureSource), target: textureToBuffer.target.region(), targetLayout: { bytesPerRow: 256 }, size: { width: 1, height: 1 }, whenMissing: 'throw' } },
            { runtime: textureToBuffer.runtime, descriptor: { source: copySource(textureToBuffer.source), target: nonCopyBufferTarget.region(), targetLayout: { bytesPerRow: 256 }, size: { width: 1, height: 1 }, whenMissing: 'throw' } },
        ]) {
            await expectScratchDiagnostic(() => runtime.createCopyCommand(descriptor), {
                code: 'SCRATCH_RESOURCE_USAGE_MISSING',
                severity: 'error',
                phase: 'resource',
            })
        }

        for (const { runtime, descriptor } of [
            { runtime: bufferToTexture.runtime, descriptor: { source: copySource(bufferToTexture.source), sourceLayout: { bytesPerRow: 8 }, target: bufferToTexture.target, size: { width: 1, height: 1 }, whenMissing: 'throw' } },
            { runtime: bufferToTexture.runtime, descriptor: { source: copySource(bufferToTexture.source, bufferToTexture.source.contentEpoch, { offset: 2, size: 1022 }), sourceLayout: { bytesPerRow: 256 }, target: bufferToTexture.target, size: { width: 1, height: 1 }, whenMissing: 'throw' } },
            { runtime: bufferToTexture.runtime, descriptor: { source: copySource(bufferToTexture.source), sourceLayout: { bytesPerRow: 256, rowsPerImage: 1 }, target: bufferToTexture.target, size: { width: 1, height: 2 }, whenMissing: 'throw' } },
            { runtime: bufferToTexture.runtime, descriptor: { source: copySource(bufferToTexture.source, bufferToTexture.source.contentEpoch, { offset: 900, size: 124 }), sourceLayout: { bytesPerRow: 256, rowsPerImage: 4 }, target: bufferToTexture.target, size: { width: 2, height: 2 }, whenMissing: 'throw' } },
            { runtime: bufferToTexture.runtime, descriptor: { source: copySource(bufferToTexture.source), sourceLayout: { bytesPerRow: 256 }, target: bufferToTexture.target, targetMipLevel: 1, size: { width: 1, height: 1 }, whenMissing: 'throw' } },
            { runtime: bufferToTexture.runtime, descriptor: { source: copySource(bufferToTexture.source), sourceLayout: { bytesPerRow: 256 }, target: bufferToTexture.target, targetAspect: 'depth-only', size: { width: 1, height: 1 }, whenMissing: 'throw' } },
            { runtime: textureToBuffer.runtime, descriptor: { source: copySource(textureToBuffer.source), sourceMipLevel: 1, target: textureToBuffer.target.region(), targetLayout: { bytesPerRow: 256 }, size: { width: 1, height: 1 }, whenMissing: 'throw' } },
            { runtime: textureToBuffer.runtime, descriptor: { source: copySource(textureToBuffer.source), sourceAspect: 'stencil-only', target: textureToBuffer.target.region(), targetLayout: { bytesPerRow: 256 }, size: { width: 1, height: 1 }, whenMissing: 'throw' } },
            { runtime: textureToBuffer.runtime, descriptor: { source: copySource(textureToBuffer.source), target: textureToBuffer.target.region(), targetLayout: { bytesPerRow: 8 }, size: { width: 1, height: 1 }, whenMissing: 'throw' } },
        ]) {
            await expectScratchDiagnostic(() => runtime.createCopyCommand(descriptor), {
                code: 'SCRATCH_COMMAND_COPY_RANGE_INVALID',
                severity: 'error',
                phase: 'command',
            })
        }
    })

    it('enforces GPUSize32 bounds for both native buffer-texture copy layouts', async() => {

        const bufferToTexture = await createBufferToTextureCopyFixture()
        const textureToBuffer = await createTextureToBufferCopyFixture()
        const largestAlignedBytesPerRow = 0xffffff00
        const maxGpuSize32 = 0xffffffff
        const aboveGpuSize32 = 0x1_0000_0000

        const validBufferToTexture = bufferToTexture.runtime.createCopyCommand({
            source: copySource(bufferToTexture.source, 0, { size: 4 }),
            sourceLayout: {
                bytesPerRow: largestAlignedBytesPerRow,
                rowsPerImage: maxGpuSize32,
            },
            target: bufferToTexture.target,
            size: { width: 1, height: 1 },
            whenMissing: 'throw',
        })
        const validTextureToBuffer = textureToBuffer.runtime.createCopyCommand({
            source: copySource(textureToBuffer.source),
            target: textureToBuffer.target.region({ size: 4 }),
            targetLayout: {
                bytesPerRow: largestAlignedBytesPerRow,
                rowsPerImage: maxGpuSize32,
            },
            size: { width: 1, height: 1 },
            whenMissing: 'throw',
        })
        expect(validBufferToTexture.sourceLayout).to.deep.equal({
            bytesPerRow: largestAlignedBytesPerRow,
            rowsPerImage: maxGpuSize32,
        })
        expect(validTextureToBuffer.targetLayout).to.deep.equal({
            bytesPerRow: largestAlignedBytesPerRow,
            rowsPerImage: maxGpuSize32,
        })

        for (const { runtime, descriptor } of [
            {
                runtime: bufferToTexture.runtime,
                descriptor: {
                    source: copySource(bufferToTexture.source, 0, { size: 4 }),
                    sourceLayout: { bytesPerRow: aboveGpuSize32 },
                    target: bufferToTexture.target,
                    size: { width: 1, height: 1 },
                    whenMissing: 'throw',
                },
            },
            {
                runtime: bufferToTexture.runtime,
                descriptor: {
                    source: copySource(bufferToTexture.source, 0, { size: 4 }),
                    sourceLayout: { bytesPerRow: 256, rowsPerImage: aboveGpuSize32 },
                    target: bufferToTexture.target,
                    size: { width: 1, height: 1 },
                    whenMissing: 'throw',
                },
            },
            {
                runtime: textureToBuffer.runtime,
                descriptor: {
                    source: copySource(textureToBuffer.source),
                    target: textureToBuffer.target.region({ size: 4 }),
                    targetLayout: { bytesPerRow: aboveGpuSize32 },
                    size: { width: 1, height: 1 },
                    whenMissing: 'throw',
                },
            },
            {
                runtime: textureToBuffer.runtime,
                descriptor: {
                    source: copySource(textureToBuffer.source),
                    target: textureToBuffer.target.region({ size: 4 }),
                    targetLayout: { bytesPerRow: 256, rowsPerImage: aboveGpuSize32 },
                    size: { width: 1, height: 1 },
                    whenMissing: 'throw',
                },
            },
        ]) {
            await expectScratchDiagnostic(() => runtime.createCopyCommand(descriptor), {
                code: 'SCRATCH_COMMAND_COPY_RANGE_INVALID',
                severity: 'error',
                phase: 'command',
            })
        }
    })

    it('describes only BufferRegion-based copy shapes in structured diagnostics', async() => {

        const fixture = await createCopyFixture()
        const sourceDiagnostic = await expectScratchDiagnostic(() => fixture.runtime.createCopyCommand({
            source: fixture.source,
            target: fixture.target.region({ size: 4 }),
            whenMissing: 'throw',
        }), {
            code: 'SCRATCH_COMMAND_COPY_SOURCE_INVALID',
            severity: 'error',
            phase: 'command',
        })
        const rangeDiagnostic = await expectScratchDiagnostic(() => fixture.runtime.createCopyCommand({
            source: copySource(fixture.source, 0, { offset: 2, size: 4 }),
            target: fixture.target.region({ size: 4 }),
            whenMissing: 'throw',
        }), {
            code: 'SCRATCH_COMMAND_COPY_RANGE_INVALID',
            severity: 'error',
            phase: 'command',
        })

        for (const diagnostic of [ sourceDiagnostic, rangeDiagnostic ]) {
            expect(diagnostic.expected.source).to.include('BufferRegion')
            expect(diagnostic.expected.target).to.include('BufferRegion')
            expect(JSON.stringify(diagnostic.expected)).to.not.include('BufferResource')
            expect(diagnostic.expected).to.not.have.any.keys(
                'sourceOffset',
                'targetOffset',
                'byteLength'
            )
            expect(diagnostic.expected.sourceLayout).to.not.include('offset')
            expect(diagnostic.expected.targetLayout).to.not.include('offset')
        }
    })

    it('rejects invalid copy ranges and every same-buffer copy', async() => {

        const fixture = await createCopyFixture()
        const sameBuffer = await fixture.runtime.createBuffer({
            size: 32,
            usage: GPU_BUFFER_USAGE_COPY_SRC | GPU_BUFFER_USAGE_COPY_DST,
        })

        for (const descriptor of [
            { source: copySource(fixture.source, fixture.source.contentEpoch, { offset: 2, size: 4 }), target: fixture.target.region({ size: 4 }), whenMissing: 'throw' },
            { source: copySource(fixture.source, fixture.source.contentEpoch, { size: 4 }), target: fixture.target.region({ offset: 2, size: 4 }), whenMissing: 'throw' },
            { source: copySource(fixture.source, fixture.source.contentEpoch, { size: 0 }), target: fixture.target.region({ size: 0 }), whenMissing: 'throw' },
            { source: copySource(fixture.source, fixture.source.contentEpoch, { size: 6 }), target: fixture.target.region({ size: 6 }), whenMissing: 'throw' },
            { source: copySource(fixture.source, fixture.source.contentEpoch, { size: 16 }), target: fixture.target.region({ size: 12 }), whenMissing: 'throw' },
            { source: copySource(sameBuffer, sameBuffer.contentEpoch, { size: 8 }), target: sameBuffer.region({ offset: 4, size: 8 }), whenMissing: 'throw' },
            { source: copySource(sameBuffer, sameBuffer.contentEpoch, { size: 8 }), target: sameBuffer.region({ offset: 16, size: 8 }), whenMissing: 'throw' },
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
