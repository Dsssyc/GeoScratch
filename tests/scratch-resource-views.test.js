import { expect } from 'chai'
import {
    BufferRegion,
    ScratchDiagnosticError,
    ScratchRuntime,
    TextureViewSpec,
    layoutCodec,
} from 'geoscratch'
import { createFakeGpu } from './scratch-test-utils.js'

const GPU_TEXTURE_USAGE_TEXTURE_BINDING = 0x4
const GPU_TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10

function particleCodec(name = 'Particle', positionName = 'position', massName = 'mass') {

    return layoutCodec({
        name,
        fields: [
            { name: positionName, type: 'vec3f' },
            { name: massName, type: 'f32' },
        ],
    })
}

async function createRuntimeFixture(options) {

    const fake = createFakeGpu(options)
    const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
    return { ...fake, runtime }
}

function expectDiagnostic(action, code) {

    let caught
    try {
        action()
    } catch (error) {
        caught = error
    }

    expect(caught).to.be.instanceOf(ScratchDiagnosticError)
    expect(caught.diagnostic.code).to.equal(code)
    return caught.diagnostic
}

describe('scratch logical resource views', () => {

    it('separates canonical physical ABI from semantic schema identity', () => {

        const first = particleCodec('Particle', 'position', 'mass').artifact
        const same = particleCodec('Particle', 'position', 'mass').artifact
        const renamed = particleCodec('ParticleRenamed', 'location', 'weight').artifact
        const physicalDifference = layoutCodec({
            name: 'Particle',
            fields: [
                { name: 'position', type: 'vec4f' },
                { name: 'mass', type: 'f32' },
            ],
        }).artifact

        expect(first.abiHash).to.match(/^layout-abi-[0-9a-f]+$/)
        expect(first.schemaHash).to.match(/^layout-schema-[0-9a-f]+$/)
        expect(first).to.not.have.property('structuralHash')
        expect(same.abiHash).to.equal(first.abiHash)
        expect(same.schemaHash).to.equal(first.schemaHash)
        expect(renamed.abiHash).to.equal(first.abiHash)
        expect(renamed.schemaHash).to.not.equal(first.schemaHash)
        expect(physicalDifference.abiHash).to.not.equal(first.abiHash)
        expect(Object.isFrozen(first)).to.equal(true)
        expect(Object.isFrozen(first.fields)).to.equal(true)
        expect(Object.isFrozen(first.fields[0])).to.equal(true)
    })

    it('creates immutable whole, typed, overlapping, and normalized child BufferRegions', async() => {

        const { runtime } = await createRuntimeFixture()
        const codec = particleCodec()
        const buffer = await runtime.createBuffer({ size: 128, usage: 0x8 | 0x80 })

        const whole = buffer.region()
        const records = buffer.region({ offset: 16, size: 64, layout: codec.artifact })
        const child = records.subregion({ offset: 16, size: 16 })
        const overlap = buffer.region({ offset: 32, size: 48 })

        expect(whole).to.be.instanceOf(BufferRegion)
        expect(whole.buffer).to.equal(buffer)
        expect(whole.offset).to.equal(0)
        expect(whole.size).to.equal(128)
        expect(whole.layout).to.equal(undefined)
        expect(whole.elementCount).to.equal(undefined)

        expect(records.buffer).to.equal(buffer)
        expect(records.offset).to.equal(16)
        expect(records.size).to.equal(64)
        expect(records.layout).to.equal(codec.artifact)
        expect(records.elementCount).to.equal(4)

        expect(child.buffer).to.equal(buffer)
        expect(child.offset).to.equal(32)
        expect(child.size).to.equal(16)
        expect(child.layout).to.equal(undefined)
        expect(child.elementCount).to.equal(undefined)
        expect(overlap.offset).to.equal(32)

        expect(Object.isFrozen(records)).to.equal(true)
        expect(Object.isExtensible(records)).to.equal(false)
        expect(records).to.not.have.property('id')
        expect(records).to.not.have.property('allocationVersion')
        expect(records).to.not.have.property('contentEpoch')
        expect(records).to.not.have.property('state')
        expect(() => new BufferRegion()).to.throw(TypeError)
    })

    it('rejects unsafe ranges and permits only ABI-compatible reinterpretation', async() => {

        const { runtime } = await createRuntimeFixture()
        const original = particleCodec('Particle').artifact
        const renamed = particleCodec('RenamedParticle', 'location', 'weight').artifact
        const incompatible = layoutCodec({
            name: 'WideParticle',
            fields: [
                { name: 'position', type: 'vec4f' },
                { name: 'mass', type: 'f32' },
            ],
        }).artifact
        const buffer = await runtime.createBuffer({ size: 128, usage: 0x80 })
        const region = buffer.region({ offset: 16, size: 64, layout: original })

        const reinterpreted = region.interpretAs(renamed)
        expect(reinterpreted).to.not.equal(region)
        expect(reinterpreted.buffer).to.equal(buffer)
        expect(reinterpreted.offset).to.equal(region.offset)
        expect(reinterpreted.size).to.equal(region.size)
        expect(reinterpreted.layout).to.equal(renamed)
        expect(region.layout).to.equal(original)

        const mismatch = expectDiagnostic(
            () => region.interpretAs(incompatible),
            'SCRATCH_LAYOUT_ABI_MISMATCH'
        )
        expect(mismatch.expected).to.include({ abiHash: original.abiHash })
        expect(mismatch.actual).to.include({ abiHash: incompatible.abiHash })
        expect(mismatch.evidence).to.be.an('array').and.not.be.empty

        expectDiagnostic(
            () => buffer.region({ offset: 120, size: 16 }),
            'SCRATCH_BUFFER_REGION_RANGE_INVALID'
        )
        expectDiagnostic(
            () => buffer.region({ offset: Number.MAX_SAFE_INTEGER, size: 16 }),
            'SCRATCH_BUFFER_REGION_RANGE_INVALID'
        )
        expectDiagnostic(
            () => buffer.region({ offset: 0, size: original.stride + 1, layout: original }),
            'SCRATCH_BUFFER_REGION_LAYOUT_INVALID'
        )
        expectDiagnostic(
            () => region.subregion({ offset: 63, size: 2 }),
            'SCRATCH_BUFFER_REGION_RANGE_INVALID'
        )
    })

    it('creates complete immutable TextureViewSpecs without native view creation', async() => {

        const { runtime, calls } = await createRuntimeFixture()
        const texture = await runtime.createTexture({
            label: 'array texture',
            size: { width: 8, height: 4, depthOrArrayLayers: 2 },
            mipLevelCount: 3,
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_TEXTURE_BINDING | GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
        })
        const nativeViewCount = calls.textureViews.length

        const view = texture.view()

        expect(view).to.be.instanceOf(TextureViewSpec)
        expect(view.texture).to.equal(texture)
        expect(view.descriptor).to.deep.equal({
            format: 'rgba8unorm',
            dimension: '2d-array',
            usage: GPU_TEXTURE_USAGE_TEXTURE_BINDING | GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
            aspect: 'all',
            baseMipLevel: 0,
            mipLevelCount: 3,
            baseArrayLayer: 0,
            arrayLayerCount: 2,
            swizzle: 'rgba',
        })
        expect(view.hash).to.match(/^texture-view-[0-9a-f]+$/)
        expect(calls.textureViews).to.have.length(nativeViewCount)
        expect(Object.isFrozen(view)).to.equal(true)
        expect(Object.isFrozen(view.descriptor)).to.equal(true)
        expect(Object.isExtensible(view)).to.equal(false)
        expect(view).to.not.have.property('gpuTextureView')
        expect(() => new TextureViewSpec()).to.throw(TypeError)
    })

    it('freezes explicit texture view defaults and revalidates parent lifecycle', async() => {

        const { runtime } = await createRuntimeFixture()
        const texture = await runtime.createTexture({
            size: { width: 8, height: 8, depthOrArrayLayers: 6 },
            mipLevelCount: 4,
            format: 'rgba8unorm',
            viewFormats: [ 'rgba8unorm-srgb' ],
            usage: GPU_TEXTURE_USAGE_TEXTURE_BINDING,
        })
        const view = texture.view({
            format: 'rgba8unorm-srgb',
            dimension: 'cube',
            usage: GPU_TEXTURE_USAGE_TEXTURE_BINDING,
            aspect: 'all',
            baseMipLevel: 1,
            mipLevelCount: 2,
            baseArrayLayer: 0,
            arrayLayerCount: 6,
        })

        expect(view.descriptor).to.deep.equal({
            format: 'rgba8unorm-srgb',
            dimension: 'cube',
            usage: GPU_TEXTURE_USAGE_TEXTURE_BINDING,
            aspect: 'all',
            baseMipLevel: 1,
            mipLevelCount: 2,
            baseArrayLayer: 0,
            arrayLayerCount: 6,
            swizzle: 'rgba',
        })

        texture.dispose()
        expectDiagnostic(() => view.assertUsable(), 'SCRATCH_RESOURCE_DISPOSED')
    })

    it('rejects stencil formats for one-dimensional and three-dimensional textures', async() => {

        const { runtime, calls } = await createRuntimeFixture()
        for (const [ dimension, size ] of [
            [ '1d', [ 4 ] ],
            [ '3d', [ 4, 4, 4 ] ],
        ]) {
            const before = calls.textures.length
            await expectRejectedDiagnostic(runtime.createTexture({
                dimension,
                size,
                format: 'stencil8',
                usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
            }), 'SCRATCH_RESOURCE_DESCRIPTOR_INVALID')
            expect(calls.textures).to.have.length(before)
        }
    })

    it('rejects mipmapped and render-attachment one-dimensional textures', async() => {

        const { runtime, calls } = await createRuntimeFixture()
        const cases = [
            {
                dimension: '1d',
                size: [ 4 ],
                mipLevelCount: 2,
                format: 'rgba8unorm',
                usage: GPU_TEXTURE_USAGE_TEXTURE_BINDING,
            },
            {
                dimension: '1d',
                size: [ 4 ],
                format: 'rgba8unorm',
                usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
            },
        ]

        for (const descriptor of cases) {
            const before = calls.textures.length
            await expectRejectedDiagnostic(
                runtime.createTexture(descriptor),
                'SCRATCH_RESOURCE_DESCRIPTOR_INVALID'
            )
            expect(calls.textures).to.have.length(before)
        }
    })

    it('treats three-dimensional texture depth as one view array layer', async() => {

        const { runtime } = await createRuntimeFixture()
        const texture = await runtime.createTexture({
            dimension: '3d',
            size: [ 4, 4, 4 ],
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_TEXTURE_BINDING,
        })

        expectDiagnostic(
            () => texture.view({ baseArrayLayer: 1 }),
            'SCRATCH_RESOURCE_DESCRIPTOR_INVALID'
        )
    })

    it('materializes depth-stencil aspect-specific view formats', async() => {

        const { runtime } = await createRuntimeFixture()
        const texture = await runtime.createTexture({
            size: [ 4, 4 ],
            format: 'depth24plus-stencil8',
            usage: GPU_TEXTURE_USAGE_TEXTURE_BINDING | GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
        })

        const depth = texture.view({ aspect: 'depth-only' })
        const stencil = texture.view({ aspect: 'stencil-only' })

        expect(depth.descriptor.format).to.equal('depth24plus')
        expect(stencil.descriptor.format).to.equal('stencil8')
        expectDiagnostic(() => texture.view({
            aspect: 'stencil-only',
            format: 'depth24plus-stencil8',
        }), 'SCRATCH_RESOURCE_DESCRIPTOR_INVALID')
    })
})

async function expectRejectedDiagnostic(promise, code) {

    let caught
    try {
        await promise
    } catch (error) {
        caught = error
    }

    expect(caught).to.be.instanceOf(ScratchDiagnosticError)
    expect(caught.diagnostic.code).to.equal(code)
    return caught.diagnostic
}
