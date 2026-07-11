import { expect } from 'chai'
import {
    ScratchDiagnosticError,
    ScratchRuntime,
    TextureResource,
} from 'geoscratch'
import { createFakeGpu } from './scratch-test-utils.js'

const GPU_TEXTURE_USAGE_COPY_SRC = 0x1
const GPU_TEXTURE_USAGE_COPY_DST = 0x2
const GPU_TEXTURE_USAGE_TEXTURE_BINDING = 0x4
const GPU_TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10
const GPU_TEXTURE_USAGE_TRANSIENT_ATTACHMENT = 0x20

async function createFixture(descriptor = {}) {

    const fake = createFakeGpu()
    Object.assign(fake.device.limits, {
        maxTextureDimension2D: 8192,
        maxTextureArrayLayers: 256,
    })
    Object.assign(fake.adapter.limits, fake.device.limits)
    const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
    const texture = await runtime.createTexture({
        label: 'resizable texture',
        size: { width: 8, height: 8 },
        format: 'rgba8unorm',
        usage:
            GPU_TEXTURE_USAGE_COPY_SRC |
            GPU_TEXTURE_USAGE_COPY_DST |
            GPU_TEXTURE_USAGE_TEXTURE_BINDING |
            GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
        ...descriptor,
    })

    return { ...fake, runtime, texture }
}

function captureTextureFacts(texture) {

    return {
        runtime: texture.runtime,
        id: texture.id,
        label: texture.label,
        resourceKind: texture.resourceKind,
        gpuTexture: texture.gpuTexture,
        descriptor: texture.descriptor,
        size: texture.size,
        width: texture.width,
        height: texture.height,
        depthOrArrayLayers: texture.depthOrArrayLayers,
        allocationVersion: texture.allocationVersion,
        contentEpoch: texture.contentEpoch,
        state: texture.state,
    }
}

function expectTextureFacts(texture, expected) {

    expect(captureTextureFacts(texture)).to.deep.equal(expected)
}

async function expectDiagnostic(action, code) {

    try {
        await action()
        throw new Error(`expected ${code}`)
    } catch (error) {
        expect(error).to.be.instanceOf(ScratchDiagnosticError)
        expect(error.diagnostic).to.include({
            code,
            severity: 'error',
        })
        return error
    }
}

describe('scratch texture resize', () => {

    it('snapshots the complete physical descriptor for creation and replacement', async() => {

        const size = { width: 8, height: 4 }
        const viewFormats = new Set([ 'rgba8unorm-srgb' ])
        const fixture = await createFixture({
            size,
            mipLevelCount: 3,
            sampleCount: 1,
            dimension: '2d',
            viewFormats,
            textureBindingViewDimension: '2d',
        })

        size.width = 32
        viewFormats.add('bgra8unorm')

        expect(fixture.texture.descriptor).to.deep.equal({
            label: 'resizable texture',
            size: { width: 8, height: 4, depthOrArrayLayers: 1 },
            mipLevelCount: 3,
            sampleCount: 1,
            dimension: '2d',
            format: 'rgba8unorm',
            usage:
                GPU_TEXTURE_USAGE_COPY_SRC |
                GPU_TEXTURE_USAGE_COPY_DST |
                GPU_TEXTURE_USAGE_TEXTURE_BINDING |
                GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
            viewFormats: [ 'rgba8unorm-srgb' ],
            textureBindingViewDimension: '2d',
        })
        expect(Object.isFrozen(fixture.texture.descriptor)).to.equal(true)
        expect(Object.isFrozen(fixture.texture.size)).to.equal(true)
        expect(Object.isFrozen(fixture.texture.descriptor.viewFormats)).to.equal(true)

        await fixture.texture.resize([ 4, 4 ])

        expect(fixture.calls.textures[1].descriptor).to.deep.equal({
            ...fixture.calls.textures[0].descriptor,
            size: { width: 4, height: 4, depthOrArrayLayers: 1 },
        })
    })

    it('replaces only the physical allocation behind stable logical identity', async() => {

        const fixture = await createFixture()
        const logicalTexture = fixture.texture
        const logicalId = fixture.texture.id
        const previousTexture = fixture.texture.gpuTexture
        const previousVersion = fixture.texture.allocationVersion
        const previousEpoch = fixture.texture.contentEpoch
        const queueFacts = {
            submissions: fixture.calls.queueSubmissions.length,
            writes: fixture.calls.queueWrites.length,
            textureWrites: fixture.calls.queueTextureWrites.length,
            externalCopies: fixture.calls.queueExternalImageCopies.length,
            encoders: fixture.calls.commandEncoders.length,
            completionRegistrations: fixture.calls.submittedWorkDoneRegistrations.length,
        }

        await fixture.texture.resize({ width: 16, height: 4 })

        expect(fixture.texture).to.equal(logicalTexture)
        expect(fixture.texture.id).to.equal(logicalId)
        expect(fixture.texture.gpuTexture).to.not.equal(previousTexture)
        expect(previousTexture.destroyed).to.equal(true)
        expect(fixture.texture.size).to.deep.equal({
            width: 16,
            height: 4,
            depthOrArrayLayers: 1,
        })
        expect(fixture.texture.allocationVersion).to.equal(previousVersion + 1)
        expect(fixture.texture.contentEpoch).to.equal(previousEpoch)
        expect(fixture.texture.state).to.equal('empty')
        expect({
            submissions: fixture.calls.queueSubmissions.length,
            writes: fixture.calls.queueWrites.length,
            textureWrites: fixture.calls.queueTextureWrites.length,
            externalCopies: fixture.calls.queueExternalImageCopies.length,
            encoders: fixture.calls.commandEncoders.length,
            completionRegistrations: fixture.calls.submittedWorkDoneRegistrations.length,
        }).to.deep.equal(queueFacts)
    })

    it('creates the replacement before destroying the old allocation', async() => {

        const fixture = await createFixture()
        const previousTexture = fixture.texture.gpuTexture
        const nativeCreateTexture = fixture.device.createTexture.bind(fixture.device)
        let oldWasDestroyedDuringCreate
        fixture.device.createTexture = (descriptor) => {
            oldWasDestroyedDuringCreate = previousTexture.destroyed
            return nativeCreateTexture(descriptor)
        }

        await fixture.texture.resize([ 16, 8 ])

        expect(oldWasDestroyedDuringCreate).to.equal(false)
        expect(previousTexture.destroyed).to.equal(true)
    })

    it('treats normalized same-size resize as a true no-op', async() => {

        const fixture = await createFixture()
        const view = fixture.texture.createView()
        const facts = captureTextureFacts(fixture.texture)
        const createdTextureCount = fixture.calls.textures.length

        await fixture.texture.resize([ 8, 8, 1 ])

        expectTextureFacts(fixture.texture, facts)
        expect(fixture.calls.textures).to.have.length(createdTextureCount)
        expect(fixture.texture.createView()).to.equal(view)
        expect(view.texture.destroyed).to.equal(false)
    })

    it('supports width, height, array-layer, and repeated replacements', async() => {

        const fixture = await createFixture()
        const allocations = [ fixture.texture.gpuTexture ]

        for (const size of [
            [ 16, 8, 1 ],
            { width: 16, height: 4, depthOrArrayLayers: 1 },
            [ 16, 4, 3 ],
            { width: 2 },
        ]) {
            const previousVersion = fixture.texture.allocationVersion
            const previousEpoch = fixture.texture.contentEpoch
            await fixture.texture.resize(size)
            allocations.push(fixture.texture.gpuTexture)

            expect(fixture.texture.allocationVersion).to.equal(previousVersion + 1)
            expect(fixture.texture.contentEpoch).to.equal(previousEpoch)
            expect(fixture.texture.state).to.equal('empty')
        }

        expect(fixture.texture.size).to.deep.equal({
            width: 2,
            height: 1,
            depthOrArrayLayers: 1,
        })
        expect(new Set(allocations).size).to.equal(allocations.length)
        expect(allocations.slice(0, -1).every(texture => texture.destroyed)).to.equal(true)
        expect(allocations.at(-1).destroyed).to.equal(false)
    })

    it('rejects invalid size grammar and numeric dimensions atomically', async() => {

        const fixture = await createFixture()
        const facts = captureTextureFacts(fixture.texture)
        const textureCount = fixture.calls.textures.length
        const invalidSizes = [
            [],
            [ 1, 2, 3, 4 ],
            [ 0, 1 ],
            [ -1, 1 ],
            [ 1.5, 1 ],
            [ Number.NaN, 1 ],
            [ 1, 0 ],
            [ 1, null ],
            [ 1, 1, -1 ],
            [ 1, 1, null ],
            { width: 0 },
            { width: 1, height: Number.NaN },
            { width: 1, height: null },
            { width: 1, depthOrArrayLayers: null },
            null,
            '8x8',
        ]

        for (const size of invalidSizes) {
            await expectDiagnostic(
                async () => await fixture.texture.resize(size),
                'SCRATCH_RESOURCE_DESCRIPTOR_INVALID'
            )
            expectTextureFacts(fixture.texture, facts)
            expect(fixture.calls.textures).to.have.length(textureCount)
        }
    })

    it('validates device limits before creating a replacement', async() => {

        const fixture = await createFixture()
        fixture.device.limits.maxTextureDimension2D = 16
        fixture.device.limits.maxTextureArrayLayers = 4
        const facts = captureTextureFacts(fixture.texture)

        for (const size of [
            { width: 17, height: 8 },
            { width: 8, height: 17 },
            { width: 8, height: 8, depthOrArrayLayers: 5 },
        ]) {
            await expectDiagnostic(
                async () => await fixture.texture.resize(size),
                'SCRATCH_RESOURCE_DESCRIPTOR_INVALID'
            )
            expectTextureFacts(fixture.texture, facts)
        }
    })

    it('validates retained mip, sample, and format size constraints', async() => {

        const mipFixture = await createFixture({ mipLevelCount: 4 })
        await expectDiagnostic(
            async () => await mipFixture.texture.resize([ 4, 4 ]),
            'SCRATCH_RESOURCE_DESCRIPTOR_INVALID'
        )

        const multisampleFixture = await createFixture({
            sampleCount: 4,
            usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
        })
        await expectDiagnostic(
            async () => await multisampleFixture.texture.resize([ 8, 8, 2 ]),
            'SCRATCH_RESOURCE_DESCRIPTOR_INVALID'
        )

        const compressedFixture = await createFixture({
            format: 'bc1-rgba-unorm',
            usage: GPU_TEXTURE_USAGE_TEXTURE_BINDING,
        })
        await expectDiagnostic(
            async () => await compressedFixture.texture.resize([ 6, 8 ]),
            'SCRATCH_RESOURCE_DESCRIPTOR_INVALID'
        )
    })

    it('rejects transient attachment array layers before replacing the allocation', async() => {

        const fixture = await createFixture({
            usage:
                GPU_TEXTURE_USAGE_RENDER_ATTACHMENT |
                GPU_TEXTURE_USAGE_TRANSIENT_ATTACHMENT,
        })
        const facts = captureTextureFacts(fixture.texture)
        const textureCount = fixture.calls.textures.length

        await expectDiagnostic(
            async () => await fixture.texture.resize([ 8, 8, 2 ]),
            'SCRATCH_RESOURCE_DESCRIPTOR_INVALID'
        )

        expectTextureFacts(fixture.texture, facts)
        expect(fixture.calls.textures).to.have.length(textureCount)
        expect(fixture.texture.gpuTexture.destroyed).to.equal(false)
    })

    it('validates the complete transient attachment descriptor contract', async() => {

        const fixture = await createFixture()
        const transientUsage =
            GPU_TEXTURE_USAGE_RENDER_ATTACHMENT |
            GPU_TEXTURE_USAGE_TRANSIENT_ATTACHMENT
        const invalidDescriptors = [
            { usage: GPU_TEXTURE_USAGE_TRANSIENT_ATTACHMENT },
            { usage: transientUsage | GPU_TEXTURE_USAGE_COPY_SRC },
            { usage: transientUsage, viewFormats: [ 'rgba8unorm-srgb' ] },
            { usage: transientUsage, mipLevelCount: 2 },
            { usage: transientUsage, size: [ 8, 8, 2 ] },
            { usage: transientUsage, dimension: null },
            { usage: transientUsage, mipLevelCount: null },
            { usage: transientUsage, sampleCount: null },
        ]

        for (const descriptor of invalidDescriptors) {
            await expectDiagnostic(async () => await fixture.runtime.createTexture({
                size: [ 8, 8 ],
                format: 'rgba8unorm',
                ...descriptor,
            }), 'SCRATCH_RESOURCE_DESCRIPTOR_INVALID')
        }
    })

    it('leaves the old allocation fully installed after synchronous native failure', async() => {

        const fixture = await createFixture()
        const oldView = fixture.texture.createView()
        const facts = captureTextureFacts(fixture.texture)
        const nativeError = new RangeError('synthetic allocation failure')
        fixture.device.createTexture = () => {
            throw nativeError
        }

        const error = await expectDiagnostic(
            async () => await fixture.texture.resize([ 16, 8 ]),
            'SCRATCH_TEXTURE_REPLACEMENT_NATIVE_FAILED'
        )

        expect(error.cause).to.equal(nativeError)
        expectTextureFacts(fixture.texture, facts)
        expect(fixture.texture.gpuTexture.destroyed).to.equal(false)
        expect(fixture.texture.createView()).to.equal(oldView)
    })

    it('rejects disposed, lost-device, disposed-runtime, and missing-native use', async() => {

        const disposedFixture = await createFixture()
        disposedFixture.texture.dispose()
        await expectDiagnostic(
            async () => await disposedFixture.texture.resize([ 16, 8 ]),
            'SCRATCH_RESOURCE_DISPOSED'
        )

        const lostFixture = await createFixture()
        lostFixture.runtime.isDeviceLost = true
        await expectDiagnostic(
            async () => await lostFixture.texture.resize([ 16, 8 ]),
            'SCRATCH_RUNTIME_DEVICE_LOST'
        )

        const runtimeFixture = await createFixture()
        runtimeFixture.runtime.isDisposed = true
        await expectDiagnostic(
            async () => await runtimeFixture.texture.resize([ 16, 8 ]),
            'SCRATCH_RUNTIME_DISPOSED'
        )

        const nativeFixture = await createFixture()
        nativeFixture.device.createTexture = undefined
        await expectDiagnostic(
            async () => await nativeFixture.texture.resize([ 16, 8 ]),
            'SCRATCH_RUNTIME_DEVICE_UNAVAILABLE'
        )
    })

    it('exposes allocation facts as read-only runtime properties', async() => {

        const fixture = await createFixture()
        const facts = captureTextureFacts(fixture.texture)

        expect(Object.isExtensible(fixture.texture)).to.equal(false)

        for (const [ key, value ] of [
            [ 'runtime', {} ],
            [ 'id', 'forged-resource-id' ],
            [ 'label', 'forged label' ],
            [ 'resourceKind', 'ForgedResource' ],
            [ 'descriptor', {} ],
            [ 'isDisposed', true ],
            [ 'state', 'ready' ],
            [ 'allocationVersion', 99 ],
            [ 'contentEpoch', 99 ],
            [ 'gpuTexture', {} ],
            [ 'size', { width: 99, height: 99, depthOrArrayLayers: 1 } ],
            [ 'width', 99 ],
            [ 'height', 99 ],
            [ 'depthOrArrayLayers', 99 ],
            [ 'format', 'bgra8unorm' ],
            [ 'usage', 0 ],
            [ 'dimension', '3d' ],
            [ 'mipLevelCount', 99 ],
            [ 'sampleCount', 4 ],
        ]) {
            expect(() => {
                fixture.texture[key] = value
            }).to.throw(TypeError)
        }

        for (const [ key, value ] of [
            [ 'allocationVersion', 99 ],
            [ 'contentEpoch', 99 ],
            [ 'state', 'ready' ],
            [ 'gpuTexture', {} ],
            [ 'width', 99 ],
        ]) {
            expect(() => Object.defineProperty(fixture.texture, key, { value })).to.throw(TypeError)
        }
        expect(() => Object.setPrototypeOf(fixture.texture, {})).to.throw(TypeError)
        expect(Object.isFrozen(TextureResource.prototype)).to.equal(true)
        const resourcePrototype = Object.getPrototypeOf(TextureResource.prototype)
        expect(Object.isFrozen(resourcePrototype)).to.equal(true)
        expect(() => Object.defineProperty(
            TextureResource.prototype,
            'allocationVersion',
            { value: 99 }
        )).to.throw(TypeError)
        expect(() => Object.defineProperty(
            resourcePrototype,
            'allocationVersion',
            { value: 99 }
        )).to.throw(TypeError)

        expectTextureFacts(fixture.texture, facts)
    })

    it('rejects subclass construction that could override logical facts', async() => {

        const fixture = await createFixture()
        class ForgedTextureResource extends TextureResource {

            get allocationVersion() {

                return 99
            }
        }

        expect(() => new ForgedTextureResource(fixture.runtime, {
            size: [ 1, 1 ],
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_TEXTURE_BINDING,
        })).to.throw(TypeError, 'does not support subclass construction')
    })

    it('does not expose an alternate allocation transition on the resource object', async() => {

        const fixture = await createFixture()
        const facts = captureTextureFacts(fixture.texture)

        expect(fixture.texture._replaceAllocation).to.equal(undefined)
        expect(fixture.texture._advanceContentEpoch).to.equal(undefined)
        expect(fixture.texture._gpuTexture).to.equal(undefined)
        expect(fixture.texture._physicalDescriptor).to.equal(undefined)
        expect(fixture.texture._viewCache).to.equal(undefined)

        for (const [ key, value ] of [
            [ '_gpuTexture', {} ],
            [ '_physicalDescriptor', {} ],
            [ '_viewCache', new Map() ],
        ]) {
            expect(() => {
                fixture.texture[key] = value
            }).to.throw(TypeError)
        }

        expectTextureFacts(fixture.texture, facts)
    })

    it('revalidates texture view ranges against the current allocation', async() => {

        const fixture = await createFixture({ size: [ 8, 8, 3 ] })
        fixture.texture.createView({ dimension: '2d', baseArrayLayer: 2 })
        const viewCount = fixture.calls.textureViews.length

        await fixture.texture.resize([ 8, 8, 1 ])

        await expectDiagnostic(
            () => fixture.texture.createView({ dimension: '2d', baseArrayLayer: 2 }),
            'SCRATCH_RESOURCE_DESCRIPTOR_INVALID'
        )
        await expectDiagnostic(
            () => fixture.texture.createView({ dimension: 'cube-array', arrayLayerCount: 1n }),
            'SCRATCH_RESOURCE_DESCRIPTOR_INVALID'
        )
        expect(fixture.calls.textureViews).to.have.length(viewCount)
    })

    it('invalidates cached views and lazily rebuilds one bind group', async() => {

        const fixture = await createFixture()
        const sampler = fixture.runtime.createSampler()
        const layout = fixture.runtime.createBindLayout({
            group: 0,
            entries: [
                {
                    binding: 0,
                    name: 'texture',
                    type: 'texture',
                    visibility: [ 'fragment' ],
                },
                {
                    binding: 1,
                    name: 'sampler',
                    type: 'sampler',
                    visibility: [ 'fragment' ],
                },
            ],
        })
        const bindSet = fixture.runtime.createBindSet(layout, {
            texture: fixture.texture,
            sampler,
        })
        const oldView = fixture.texture.createView()
        const oldBindGroup = bindSet.getBindGroup()

        await fixture.texture.resize({ width: 8, height: 8, depthOrArrayLayers: 1 })

        expect(bindSet.getBindGroup()).to.equal(oldBindGroup)
        expect(fixture.calls.bindGroups).to.have.length(1)

        await fixture.texture.resize([ 16, 8 ])

        const newView = fixture.texture.createView()
        const newBindGroup = bindSet.getBindGroup()
        expect(newView).to.not.equal(oldView)
        expect(newView.texture).to.equal(fixture.texture.gpuTexture)
        expect(newBindGroup).to.not.equal(oldBindGroup)
        expect(bindSet.getBindGroup()).to.equal(newBindGroup)
        expect(fixture.calls.bindGroups).to.have.length(2)
    })

    it('keeps TextureResource as the public runtime result', async() => {

        const fixture = await createFixture()
        const tupleTexture = await fixture.runtime.texture({
            size: [ 1 ],
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_TEXTURE_BINDING,
        })
        const objectTexture = await fixture.runtime.texture({
            size: { width: 1 },
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_TEXTURE_BINDING,
        })

        expect(fixture.texture).to.be.instanceOf(TextureResource)
        expect(tupleTexture).to.be.instanceOf(TextureResource)
        expect(objectTexture).to.be.instanceOf(TextureResource)
        expect(tupleTexture.size).to.deep.equal(objectTexture.size)

        await tupleTexture.resize({ width: 2 })
        await objectTexture.resize([ 2 ])
        expect(tupleTexture.size).to.deep.equal(objectTexture.size)

        for (const size of [ [], [ 1, 2, 3, 4 ] ]) {
            await expectDiagnostic(async () => await fixture.runtime.createTexture({
                size,
                format: 'rgba8unorm',
                usage: GPU_TEXTURE_USAGE_TEXTURE_BINDING,
            }), 'SCRATCH_RESOURCE_DESCRIPTOR_INVALID')
        }
    })
})
