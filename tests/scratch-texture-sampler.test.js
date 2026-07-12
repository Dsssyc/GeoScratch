import { expect } from 'chai'
import {
    BindLayout,
    BindSet,
    SamplerResource,
    ScratchDiagnosticError,
    ScratchRuntime,
    TextureResource,
    TextureUploadCommand,
} from 'geoscratch'
import { createFakeCanvas, createFakeGpu } from './scratch-test-utils.js'

const GPU_TEXTURE_USAGE_COPY_DST = 0x2
const GPU_TEXTURE_USAGE_TEXTURE_BINDING = 0x4

function checkerboardPixels() {

    return new Uint8Array([
        255, 0, 0, 255,
        0, 255, 0, 255,
        0, 0, 255, 255,
        255, 255, 255, 255,
    ])
}

async function createTextureFixture({ features = [] } = {}) {

    const fake = createFakeGpu()
    for (const feature of features) fake.device.features.add(feature)
    const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
    const texture = await runtime.createTexture({
        label: 'checker texture',
        size: { width: 2, height: 2 },
        format: 'rgba8unorm',
        usage: GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
    })
    const sampler = runtime.createSampler({
        label: 'nearest sampler',
        magFilter: 'nearest',
        minFilter: 'nearest',
    })
    const bindLayout = runtime.createBindLayout({
        label: 'texture sampling layout',
        group: 0,
        entries: [
            {
                binding: 0,
                name: 'colorTexture',
                type: 'texture',
                visibility: [ 'fragment' ],
            },
            {
                binding: 1,
                name: 'colorSampler',
                type: 'sampler',
                visibility: [ 'fragment' ],
            },
        ],
    })
    const bindSet = runtime.createBindSet(bindLayout, {
        colorTexture: texture,
        colorSampler: sampler,
    }, {
        label: 'texture sampling set',
    })
    const upload = runtime.createTextureUploadCommand({
        label: 'upload checker texture',
        target: texture,
        data: checkerboardPixels(),
        layout: {
            bytesPerRow: 8,
            rowsPerImage: 2,
        },
        size: { width: 2, height: 2 },
    })

    return {
        ...fake,
        runtime,
        texture,
        sampler,
        bindLayout,
        bindSet,
        upload,
    }
}

describe('scratch TextureResource, SamplerResource, and TextureUploadCommand', () => {

    it('creates runtime-owned texture and sampler resources with normalized descriptors', async() => {

        const fixture = await createTextureFixture()

        expect(fixture.texture).to.be.instanceOf(TextureResource)
        expect(fixture.sampler).to.be.instanceOf(SamplerResource)
        expect(fixture.texture.runtime).to.equal(fixture.runtime)
        expect(fixture.texture.width).to.equal(2)
        expect(fixture.texture.height).to.equal(2)
        expect(fixture.texture.depthOrArrayLayers).to.equal(1)
        expect(fixture.texture.format).to.equal('rgba8unorm')
        expect(fixture.texture.usage).to.equal(GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING)
        expect(fixture.texture.descriptor).to.deep.equal({
            label: 'checker texture',
            size: { width: 2, height: 2, depthOrArrayLayers: 1 },
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
            dimension: '2d',
            mipLevelCount: 1,
            sampleCount: 1,
            viewFormats: [],
        })
        expect(fixture.calls.textures[0].descriptor).to.deep.equal({
            ...fixture.texture.descriptor,
            label: `checker texture [scratch:${fixture.texture.id}]`,
        })

        const firstView = fixture.texture.createView()
        const secondView = fixture.texture.createView()

        expect(firstView).to.equal(secondView)
        expect(fixture.calls.textureViews).to.have.length(1)

        expect(fixture.sampler.descriptor).to.deep.equal({
            label: 'nearest sampler',
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge',
            addressModeW: 'clamp-to-edge',
            magFilter: 'nearest',
            minFilter: 'nearest',
            mipmapFilter: 'nearest',
        })
        expect(fixture.calls.samplers[0].descriptor).to.deep.equal(fixture.sampler.descriptor)

        fixture.texture.dispose()

        expect(fixture.texture.isDisposed).to.equal(true)
        expect(fixture.calls.textures[0].destroyed).to.equal(true)
        expect(() => fixture.texture.assertUsable()).to.throw(ScratchDiagnosticError)
    })

    it('lowers sampled texture and sampler bindings into WebGPU bind layouts and bind groups', async() => {

        const fixture = await createTextureFixture()

        expect(fixture.bindLayout).to.be.instanceOf(BindLayout)
        expect(fixture.bindSet).to.be.instanceOf(BindSet)
        expect(fixture.bindLayout.entries).to.deep.equal([
            {
                binding: 0,
                name: 'colorTexture',
                type: 'texture',
                sampleType: 'float',
                viewDimension: '2d',
                multisampled: false,
                visibility: [ 'fragment' ],
            },
            {
                binding: 1,
                name: 'colorSampler',
                type: 'sampler',
                samplerType: 'filtering',
                visibility: [ 'fragment' ],
            },
        ])
        expect(fixture.calls.bindGroupLayouts[0].descriptor).to.deep.equal({
            label: 'texture sampling layout',
            entries: [
                {
                    binding: 0,
                    visibility: 2,
                    texture: {
                        sampleType: 'float',
                        viewDimension: '2d',
                        multisampled: false,
                    },
                },
                {
                    binding: 1,
                    visibility: 2,
                    sampler: { type: 'filtering' },
                },
            ],
        })

        const bindGroup = fixture.bindSet.getBindGroup()

        expect(fixture.calls.bindGroups).to.have.length(1)
        expect(fixture.calls.textureViews[0].descriptor).to.deep.equal({ dimension: '2d' })
        expect(fixture.calls.bindGroups[0]).to.equal(bindGroup)
        expect(fixture.calls.bindGroups[0].descriptor.entries).to.deep.equal([
            {
                binding: 0,
                resource: fixture.calls.textureViews[0],
            },
            {
                binding: 1,
                resource: fixture.sampler.gpuSampler,
            },
        ])
    })

    it('keeps a default 2d binding valid after array-layer growth on core devices', async() => {

        const fixture = await createTextureFixture({ features: [ 'core-features-and-limits' ] })
        const firstBindGroup = fixture.bindSet.getBindGroup()

        await fixture.texture.resize([ 2, 2, 3 ])
        const secondBindGroup = fixture.bindSet.getBindGroup()

        expect(secondBindGroup).to.not.equal(firstBindGroup)
        expect(fixture.calls.textureViews.map(view => view.descriptor)).to.deep.equal([
            { dimension: '2d' },
            { dimension: '2d' },
        ])
        expect(fixture.calls.textureViews[1].texture).to.equal(fixture.texture.gpuTexture)
        expect(fixture.calls.bindGroups).to.have.length(2)
    })

    it('rejects a derived binding-dimension change on compatibility devices', async() => {

        const fixture = await createTextureFixture()
        fixture.bindSet.getBindGroup()
        const bindGroupCount = fixture.calls.bindGroups.length
        const viewCount = fixture.calls.textureViews.length

        await fixture.texture.resize([ 2, 2, 3 ])

        try {
            fixture.bindSet.getBindGroup()
            throw new Error('expected compatibility binding dimension validation to fail')
        } catch (error) {
            expect(error).to.be.instanceOf(ScratchDiagnosticError)
            expect(error.diagnostic).to.include({
                code: 'SCRATCH_RESOURCE_DESCRIPTOR_INVALID',
                severity: 'error',
                phase: 'resource',
            })
        }
        expect(fixture.calls.textureViews).to.have.length(viewCount)
        expect(fixture.calls.bindGroups).to.have.length(bindGroupCount)
    })

    it('preserves an explicit 2d-array binding dimension on compatibility devices', async() => {

        const fake = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const texture = await runtime.createTexture({
            size: [ 2, 2 ],
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_TEXTURE_BINDING,
            textureBindingViewDimension: '2d-array',
        })
        const layout = runtime.createBindLayout({
            group: 0,
            entries: [ {
                binding: 0,
                name: 'arrayTexture',
                type: 'texture',
                visibility: [ 'fragment' ],
                viewDimension: '2d-array',
            } ],
        })
        const bindSet = runtime.createBindSet(layout, { arrayTexture: texture })
        const firstBindGroup = bindSet.getBindGroup()

        await texture.resize([ 2, 2, 3 ])
        const secondBindGroup = bindSet.getBindGroup()

        expect(secondBindGroup).to.not.equal(firstBindGroup)
        expect(fake.calls.textureViews.map(view => view.descriptor)).to.deep.equal([
            { dimension: '2d-array' },
            { dimension: '2d-array' },
        ])
    })

    it('revalidates bind-layout view dimensions after array-layer resize', async() => {

        const fake = createFakeGpu()
        fake.device.features.add('core-features-and-limits')
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const texture = await runtime.createTexture({
            size: [ 2, 2, 6 ],
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_TEXTURE_BINDING,
        })
        const layout = runtime.createBindLayout({
            group: 0,
            entries: [ {
                binding: 0,
                name: 'cubeTexture',
                type: 'texture',
                visibility: [ 'fragment' ],
                viewDimension: 'cube',
            } ],
        })
        const bindSet = runtime.createBindSet(layout, { cubeTexture: texture })
        bindSet.getBindGroup()
        const bindGroupCount = fake.calls.bindGroups.length
        const viewCount = fake.calls.textureViews.length

        await texture.resize([ 2, 2, 5 ])

        try {
            bindSet.getBindGroup()
            throw new Error('expected current cube view validation to fail')
        } catch (error) {
            expect(error).to.be.instanceOf(ScratchDiagnosticError)
            expect(error.diagnostic).to.include({
                code: 'SCRATCH_RESOURCE_DESCRIPTOR_INVALID',
                severity: 'error',
                phase: 'resource',
            })
        }
        expect(fake.calls.textureViews).to.have.length(viewCount)
        expect(fake.calls.bindGroups).to.have.length(bindGroupCount)
    })

    it('uploads CPU pixel data into textures through an explicit writeTexture command', async() => {

        const fixture = await createTextureFixture()

        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .upload(fixture.upload)
            .submit()

        expect(fixture.upload).to.be.instanceOf(TextureUploadCommand)
        expect(fixture.texture.contentEpoch).to.equal(1)
        expect(fixture.calls.queueTextureWrites).to.have.length(1)
        expect(fixture.calls.queueTextureWrites[0].destination).to.deep.equal({
            texture: fixture.texture.gpuTexture,
            mipLevel: 0,
            origin: { x: 0, y: 0, z: 0 },
        })
        expect(fixture.calls.queueTextureWrites[0].data).to.be.instanceOf(Uint8Array)
        expect(fixture.calls.queueTextureWrites[0].data.byteLength).to.equal(16)
        expect(fixture.calls.queueTextureWrites[0].layout).to.deep.equal({
            offset: 0,
            bytesPerRow: 8,
            rowsPerImage: 2,
        })
        expect(fixture.calls.queueTextureWrites[0].size).to.deep.equal({
            width: 2,
            height: 2,
            depthOrArrayLayers: 1,
        })

        await submitted.done
    })

    it('targets the allocation current when a queued texture upload is submitted', async() => {

        const fixture = await createTextureFixture()
        const upload = fixture.upload
        const previousTexture = fixture.texture.gpuTexture
        const builder = fixture.runtime.createSubmission({ validation: 'throw' })
            .upload(upload)

        await fixture.texture.resize([ 4, 4 ])
        const replacementTexture = fixture.texture.gpuTexture
        const submitted = builder.submit()

        expect(fixture.upload).to.equal(upload)
        expect(replacementTexture).to.not.equal(previousTexture)
        expect(previousTexture.destroyed).to.equal(true)
        expect(fixture.calls.queueTextureWrites).to.have.length(1)
        expect(fixture.calls.queueTextureWrites[0].destination.texture).to.equal(replacementTexture)
        expect(fixture.texture.allocationVersion).to.equal(2)
        expect(fixture.texture.contentEpoch).to.equal(1)
        expect(fixture.texture.state).to.equal('ready')
        expect(submitted.resourceAccesses[0]).to.include({
            resourceId: fixture.texture.id,
            contentEpochBefore: 0,
            contentEpochAfter: 1,
            allocationVersion: 2,
        })

        await submitted.done
    })

    it('rejects an upload range invalidated by shrink before queue effects', async() => {

        const fixture = await createTextureFixture()
        const builder = fixture.runtime.createSubmission({ validation: 'throw' })
            .upload(fixture.upload)

        await fixture.texture.resize([ 1, 1 ])

        try {
            builder.submit()
            throw new Error('expected resized texture upload range to fail')
        } catch (error) {
            expect(error).to.be.instanceOf(ScratchDiagnosticError)
            expect(error.diagnostic).to.include({
                code: 'SCRATCH_COMMAND_TEXTURE_UPLOAD_INVALID',
                severity: 'error',
                phase: 'command',
            })
            expect(error.diagnostic.actual).to.deep.include({ reason: 'range' })
        }

        expect(fixture.texture.contentEpoch).to.equal(0)
        expect(fixture.texture.state).to.equal('empty')
        expect(fixture.calls.queueTextureWrites).to.have.length(0)
        expect(fixture.calls.commandEncoders).to.have.length(0)
        expect(fixture.calls.queueSubmissions).to.have.length(0)
    })

    it('rebuilds the texture bind group used by a persistent draw command', async() => {

        const fixture = await createTextureFixture()
        const canvas = createFakeCanvas()
        const surface = fixture.runtime.createSurface(canvas.canvas, {
            format: 'bgra8unorm',
            size: { width: 8, height: 8 },
        })
        const program = fixture.runtime.createProgram({
            modules: [
                `
                    @group(0) @binding(0) var colorTexture: texture_2d<f32>;
                    @group(0) @binding(1) var colorSampler: sampler;

                    @vertex
                    fn vsMain(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4f {
                        var positions = array<vec2f, 3>(
                            vec2f(0.0, 0.8),
                            vec2f(-0.8, -0.8),
                            vec2f(0.8, -0.8)
                        );
                        return vec4f(positions[vertexIndex], 0.0, 1.0);
                    }

                    @fragment
                    fn fsMain() -> @location(0) vec4f {
                        return textureSampleLevel(colorTexture, colorSampler, vec2f(0.5), 0.0);
                    }
                `,
            ],
            entryPoints: { vertex: 'vsMain', fragment: 'fsMain' },
        })
        const pipeline = await fixture.runtime.createRenderPipeline({
            program,
            bindLayouts: [ fixture.bindLayout ],
            targets: [ { format: surface.format } ],
        })
        const draw = fixture.runtime.createDrawCommand({
            pipeline,
            bindSets: [ fixture.bindSet ],
            count: { vertexCount: 3 },
            resources: {
                read: [ { resource: fixture.texture, contentEpoch: 1 } ],
                write: [],
            },
            whenMissing: 'throw',
        })
        const pass = fixture.runtime.createRenderPass({
            color: [
                {
                    target: surface,
                    load: 'clear',
                    store: 'store',
                    clear: [ 0, 0, 0, 1 ],
                },
            ],
        })
        const previousBindGroup = fixture.bindSet.getBindGroup()
        const builder = fixture.runtime.createSubmission({ validation: 'throw' })
            .upload(fixture.upload)
            .render(pass, [ draw ])

        await fixture.texture.resize([ 4, 4 ])
        const replacementTexture = fixture.texture.gpuTexture
        const submitted = builder.submit()
        const bindGroupAction = fixture.calls.renderPasses[0].actions
            .find(action => action.type === 'setBindGroup')

        expect(bindGroupAction.bindGroup).to.not.equal(previousBindGroup)
        expect(bindGroupAction.bindGroup.descriptor.entries[0].resource.texture)
            .to.equal(replacementTexture)
        expect(fixture.bindSet.getBindGroup()).to.equal(bindGroupAction.bindGroup)
        expect(fixture.calls.bindGroups).to.have.length(2)

        await submitted.done
    })

    it('rebuilds the texture bind group used by a persistent dispatch command', async() => {

        const fixture = await createTextureFixture()
        const bindLayout = fixture.runtime.createBindLayout({
            group: 0,
            entries: [
                {
                    binding: 0,
                    name: 'colorTexture',
                    type: 'texture',
                    visibility: [ 'compute' ],
                },
            ],
        })
        const bindSet = fixture.runtime.createBindSet(bindLayout, {
            colorTexture: fixture.texture,
        })
        const program = fixture.runtime.createProgram({
            modules: [
                `
                    @group(0) @binding(0) var colorTexture: texture_2d<f32>;

                    @compute @workgroup_size(1)
                    fn csMain() {
                        _ = textureLoad(colorTexture, vec2i(0, 0), 0);
                    }
                `,
            ],
            entryPoints: { compute: 'csMain' },
        })
        const pipeline = await fixture.runtime.createComputePipeline({
            program,
            bindLayouts: [ bindLayout ],
        })
        const dispatch = fixture.runtime.createDispatchCommand({
            pipeline,
            bindSets: [ bindSet ],
            count: { workgroups: [ 1 ] },
            resources: {
                read: [ { resource: fixture.texture, contentEpoch: 1 } ],
                write: [],
            },
            whenMissing: 'throw',
        })
        const pass = fixture.runtime.createComputePass()
        const previousBindGroup = bindSet.getBindGroup()
        const builder = fixture.runtime.createSubmission({ validation: 'throw' })
            .upload(fixture.upload)
            .compute(pass, [ dispatch ])

        await fixture.texture.resize([ 4, 4 ])
        const replacementTexture = fixture.texture.gpuTexture
        const submitted = builder.submit()
        const bindGroupAction = fixture.calls.computePasses[0].actions
            .find(action => action.type === 'setBindGroup')

        expect(bindGroupAction.bindGroup).to.not.equal(previousBindGroup)
        expect(bindGroupAction.bindGroup.descriptor.entries[0].resource.texture)
            .to.equal(replacementTexture)
        expect(bindSet.getBindGroup()).to.equal(bindGroupAction.bindGroup)
        expect(fixture.calls.bindGroups).to.have.length(2)

        await submitted.done
    })

    it('rejects invalid texture and sampler binding descriptors with structured diagnostics', async() => {

        const fake = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })

        try {
            runtime.createBindLayout({
                group: 0,
                entries: [
                    {
                        binding: 0,
                        name: 'badTexture',
                        type: 'texture',
                        sampleType: 'not-a-sample-type',
                        visibility: [ 'fragment' ],
                    },
                ],
            })
            throw new Error('expected invalid texture sample type to fail')
        } catch (error) {
            expect(error).to.be.instanceOf(ScratchDiagnosticError)
            expect(error.diagnostic).to.include({
                code: 'SCRATCH_BIND_REQUIRED_ENTRY_MISSING',
                severity: 'error',
                phase: 'binding',
            })
        }

        try {
            runtime.createBindLayout({
                group: 0,
                entries: [
                    {
                        binding: 1,
                        name: 'badSampler',
                        type: 'sampler',
                        samplerType: 'not-a-sampler-type',
                        visibility: [ 'fragment' ],
                    },
                ],
            })
            throw new Error('expected invalid sampler type to fail')
        } catch (error) {
            expect(error).to.be.instanceOf(ScratchDiagnosticError)
            expect(error.diagnostic).to.include({
                code: 'SCRATCH_BIND_REQUIRED_ENTRY_MISSING',
                severity: 'error',
                phase: 'binding',
            })
        }
    })

    it('rejects wrong resource types, wrong runtimes, disposed resources, and missing texture usage', async() => {

        const fixtureA = await createTextureFixture()
        const fixtureB = await createTextureFixture()

        try {
            fixtureA.runtime.createBindSet(fixtureA.bindLayout, {
                colorTexture: fixtureA.sampler,
                colorSampler: fixtureA.sampler,
            })
            throw new Error('expected texture binding type mismatch to fail')
        } catch (error) {
            expect(error).to.be.instanceOf(ScratchDiagnosticError)
            expect(error.diagnostic).to.include({
                code: 'SCRATCH_BIND_RESOURCE_TYPE_MISMATCH',
                severity: 'error',
                phase: 'binding',
            })
        }

        try {
            fixtureA.runtime.createBindSet(fixtureA.bindLayout, {
                colorTexture: fixtureB.texture,
                colorSampler: fixtureA.sampler,
            })
            throw new Error('expected wrong-runtime texture binding to fail')
        } catch (error) {
            expect(error).to.be.instanceOf(ScratchDiagnosticError)
            expect(error.diagnostic).to.include({
                code: 'SCRATCH_RESOURCE_WRONG_RUNTIME',
                severity: 'error',
                phase: 'resource',
            })
        }

        fixtureA.sampler.dispose()

        try {
            fixtureA.bindSet.getBindGroup()
            throw new Error('expected disposed sampler to fail')
        } catch (error) {
            expect(error).to.be.instanceOf(ScratchDiagnosticError)
            expect(error.diagnostic).to.include({
                code: 'SCRATCH_RESOURCE_DISPOSED',
                severity: 'error',
                phase: 'resource',
            })
        }

        const unbindableTexture = await fixtureA.runtime.createTexture({
            size: { width: 2, height: 2 },
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_COPY_DST,
        })
        const replacementSampler = fixtureA.runtime.createSampler()

        try {
            fixtureA.runtime.createBindSet(fixtureA.bindLayout, {
                colorTexture: unbindableTexture,
                colorSampler: replacementSampler,
            })
            throw new Error('expected missing texture binding usage to fail')
        } catch (error) {
            expect(error).to.be.instanceOf(ScratchDiagnosticError)
            expect(error.diagnostic).to.include({
                code: 'SCRATCH_BIND_RESOURCE_USAGE_MISSING',
                severity: 'error',
                phase: 'binding',
            })
        }
    })

    it('rejects invalid texture uploads and textures missing COPY_DST usage', async() => {

        const fixture = await createTextureFixture()

        for (const descriptor of [
            {
                target: fixture.texture,
                data: checkerboardPixels(),
                layout: { bytesPerRow: 4 },
                size: { width: 2, height: 2 },
            },
            {
                target: fixture.texture,
                data: 'not bytes',
                layout: { bytesPerRow: 8 },
                size: { width: 2, height: 2 },
            },
        ]) {
            try {
                fixture.runtime.createTextureUploadCommand(descriptor)
                throw new Error('expected invalid texture upload descriptor to fail')
            } catch (error) {
                expect(error).to.be.instanceOf(ScratchDiagnosticError)
                expect(error.diagnostic).to.include({
                    code: 'SCRATCH_COMMAND_TEXTURE_UPLOAD_INVALID',
                    severity: 'error',
                    phase: 'command',
                })
            }
        }

        const readOnlyTexture = await fixture.runtime.createTexture({
            size: { width: 2, height: 2 },
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_TEXTURE_BINDING,
        })

        try {
            fixture.runtime.createTextureUploadCommand({
                target: readOnlyTexture,
                data: checkerboardPixels(),
                layout: { bytesPerRow: 8 },
                size: { width: 2, height: 2 },
            })
            throw new Error('expected texture upload without COPY_DST usage to fail')
        } catch (error) {
            expect(error).to.be.instanceOf(ScratchDiagnosticError)
            expect(error.diagnostic).to.include({
                code: 'SCRATCH_RESOURCE_USAGE_MISSING',
                severity: 'error',
                phase: 'resource',
            })
        }
    })
})
