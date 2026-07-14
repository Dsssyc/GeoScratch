import { expect } from 'chai'
import {
    BindSet,
    RenderPassSpec,
    ScratchDiagnosticError,
    ScratchRuntime,
    SubmissionBuilder,
    SubmittedWork,
    TextureResource,
} from 'geoscratch'
import {
    advanceResourceContentEpochForTest,
    createFakeCanvas,
    createFakeGpu,
    triangleWgsl,
} from './scratch-test-utils.js'

const GPU_TEXTURE_USAGE_TEXTURE_BINDING = 0x4
const GPU_TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10
const GPU_TEXTURE_USAGE_TRANSIENT_ATTACHMENT = 0x20

async function createTriangleScene(format = 'bgra8unorm') {

    const fake = createFakeGpu()
    const canvas = createFakeCanvas()
    const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
    const surface = runtime.createSurface(canvas.canvas, {
        format,
        size: { width: 64, height: 64 },
    })
    const program = runtime.createProgram({
        modules: [ triangleWgsl ],
        entryPoints: {
            vertex: 'vsMain',
            fragment: 'fsMain',
        },
    })
    const pipeline = await runtime.createRenderPipeline({
        program,
        targets: [ { format } ],
    })
    const draw = runtime.createDrawCommand({
        pipeline,
        count: { vertexCount: 3 },
        resources: {
            read: [],
            write: [],
        },
        whenMissing: 'throw',
    })
    const pass = runtime.createRenderPass({
        label: 'hello pass',
        color: [
            {
                target: surface,
                load: 'clear',
                store: 'store',
                clear: [ 0, 0, 0, 1 ],
            },
        ],
    })

    return { ...fake, ...canvas, runtime, surface, program, pipeline, draw, pass }
}

async function createRenderTargetScene(format = 'rgba8unorm', features = []) {

    const fake = createFakeGpu()
    for (const feature of features) fake.device.features.add(feature)
    const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
    const renderTarget = await runtime.createTexture({
        label: 'offscreen color target',
        size: { width: 64, height: 64 },
        format,
        usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
    })
    const sampler = await runtime.createSampler({
        label: 'offscreen sampler',
        magFilter: 'nearest',
        minFilter: 'nearest',
    })
    const renderView = renderTarget.view()
    const bindLayout = await runtime.createBindLayout({
        label: 'sample offscreen layout',
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
    const bindSet = await runtime.createBindSet(bindLayout, {
        colorTexture: renderView,
        colorSampler: sampler,
    }, {
        label: 'sample offscreen set',
    })
    fake.calls.textureViews.length = 0
    const program = runtime.createProgram({
        modules: [ triangleWgsl ],
        entryPoints: {
            vertex: 'vsMain',
            fragment: 'fsMain',
        },
    })
    const pipeline = await runtime.createRenderPipeline({
        program,
        targets: [ { format } ],
    })
    const draw = runtime.createDrawCommand({
        pipeline,
        count: { vertexCount: 3 },
        resources: {
            read: [],
            write: [],
        },
        whenMissing: 'throw',
    })
    const pass = runtime.createRenderPass({
        label: 'offscreen pass',
        color: [
            {
                target: renderView,
                load: 'clear',
                store: 'store',
                clear: [ 0.1, 0.2, 0.3, 1 ],
            },
        ],
    })

    return { ...fake, runtime, renderTarget, renderView, sampler, bindLayout, bindSet, program, pipeline, draw, pass }
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

function readResource(resource, contentEpoch = resource.contentEpoch) {

    return { resource, contentEpoch }
}

describe('scratch RenderPassSpec and SubmissionBuilder', () => {

    it('creates persistent render pass specs without storing commands', async() => {

        const fixture = await createTriangleScene()

        expect(fixture.pass).to.be.instanceOf(RenderPassSpec)
        expect(fixture.pass.runtime).to.equal(fixture.runtime)
        expect(fixture.pass.passKind).to.equal('render')
        expect(fixture.pass.label).to.equal('hello pass')
        expect(fixture.pass.color).to.have.length(1)
        expect(fixture.pass.color[0].target).to.equal(fixture.surface)
        expect(fixture.pass.commands).to.equal(undefined)
        expect(fixture.context.currentTextureCalls).to.equal(0)
    })

    it('submits ordered render work and returns non-thenable SubmittedWork', async() => {

        const fixture = await createTriangleScene()

        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .render(fixture.pass, [ fixture.draw ])
            .submit()

        expect(submitted).to.be.instanceOf(SubmittedWork)
        expect(submitted.done).to.be.instanceOf(Promise)
        expect(submitted.then).to.equal(undefined)
        expect(submitted.runtime).to.equal(fixture.runtime)
        expect(submitted.report).to.deep.equal({
            version: 1,
            diagnostics: [],
            hasErrors: false,
            errorCount: 0,
            warningCount: 0,
        })
        expect(fixture.context.currentTextureCalls).to.equal(1)
        expect(fixture.textureViews).to.have.length(1)
        expect(fixture.calls.textureViews).to.have.length(0)
        expect(fixture.calls.renderPasses).to.have.length(1)
        expect(fixture.calls.renderPasses[0].descriptor.colorAttachments[0]).to.deep.equal({
            view: fixture.textureViews[0],
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: [ 0, 0, 0, 1 ],
        })
        expect(fixture.calls.drawCalls).to.deep.equal([
            { vertexCount: 3, instanceCount: 1, firstVertex: 0, firstInstance: 0 },
        ])
        expect(fixture.calls.queueSubmissions).to.have.length(1)
        expect(fixture.calls.queueSubmissions[0]).to.deep.equal([
            { type: 'commandBuffer', descriptor: { label: submitted.id } },
        ])

        await submitted.done
    })

    it('lowers TextureViewSpec color attachments into WebGPU render pass descriptors', async() => {

        const fixture = await createRenderTargetScene()

        expect(fixture.renderTarget).to.be.instanceOf(TextureResource)
        expect(fixture.pass.color).to.have.length(1)
        expect(fixture.pass.color[0].target).to.equal(fixture.renderView)
        expect(fixture.pass.color[0].format).to.equal('rgba8unorm')

        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .render(fixture.pass, [ fixture.draw ])
            .submit()

        expect(fixture.calls.textureViews).to.have.length(1)
        expect(fixture.calls.textureViews[0].texture).to.equal(fixture.renderTarget.gpuTexture)
        expect(fixture.calls.textureViews[0].descriptor).to.deep.include({
            dimension: '2d',
            mipLevelCount: 1,
            arrayLayerCount: 1,
        })
        expect(fixture.calls.renderPasses).to.have.length(1)
        expect(fixture.calls.renderPasses[0].descriptor.colorAttachments[0]).to.deep.equal({
            view: fixture.calls.textureViews[0],
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: [ 0.1, 0.2, 0.3, 1 ],
        })

        await submitted.done
    })

    it('supports native-renderable 2d-array and 3d attachment views', async() => {

        const fake = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const arrayTexture = await runtime.createTexture({
            size: [ 8, 8, 2 ],
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
        })
        const volumeTexture = await runtime.createTexture({
            dimension: '3d',
            size: [ 8, 8, 4 ],
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
        })
        const arrayPass = runtime.createRenderPass({
            color: [ {
                target: arrayTexture.view({
                    dimension: '2d-array',
                    baseArrayLayer: 1,
                    arrayLayerCount: 1,
                }),
            } ],
        })
        const volumePass = runtime.createRenderPass({
            color: [ {
                target: volumeTexture.view({ dimension: '3d' }),
                depthSlice: 2,
            } ],
        })

        const arrayWork = runtime.submission().render(arrayPass).submit()
        const volumeWork = runtime.submission().render(volumePass).submit()

        expect(fake.calls.renderPasses[0].descriptor.colorAttachments[0]).to.deep.equal({
            view: fake.calls.textureViews[0],
            loadOp: 'clear',
            storeOp: 'store',
        })
        expect(fake.calls.textureViews[0].descriptor).to.deep.include({
            dimension: '2d-array',
            baseArrayLayer: 1,
            arrayLayerCount: 1,
        })
        expect(fake.calls.renderPasses[1].descriptor.colorAttachments[0]).to.deep.equal({
            view: fake.calls.textureViews[1],
            loadOp: 'clear',
            storeOp: 'store',
            depthSlice: 2,
        })
        expect(fake.calls.textureViews[1].descriptor.dimension).to.equal('3d')

        await Promise.all([ arrayWork.done, volumeWork.done ])
    })

    it('requires a current in-range depthSlice only for 3d color attachments', async() => {

        const fake = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const volumeTexture = await runtime.createTexture({
            dimension: '3d',
            size: [ 8, 8, 4 ],
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
        })
        const twoDTexture = await runtime.createTexture({
            size: [ 8, 8 ],
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
        })

        for (const descriptor of [
            { target: volumeTexture.view({ dimension: '3d' }) },
            { target: volumeTexture.view({ dimension: '3d' }), depthSlice: 4 },
            { target: twoDTexture.view(), depthSlice: 0 },
        ]) {
            await expectScratchDiagnostic(() => runtime.createRenderPass({
                color: [ descriptor ],
            }), {
                code: 'SCRATCH_RESOURCE_DESCRIPTOR_INVALID',
                severity: 'error',
                phase: 'resource',
            })
        }

        expect(fake.calls.commandEncoders).to.have.length(0)
        expect(fake.calls.textureViews).to.have.length(0)
    })

    it('revalidates a persistent 3d attachment depthSlice after allocation replacement', async() => {

        const fake = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const volumeTexture = await runtime.createTexture({
            dimension: '3d',
            size: [ 8, 8, 4 ],
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
        })
        const pass = runtime.createRenderPass({
            color: [ {
                target: volumeTexture.view({ dimension: '3d' }),
                depthSlice: 3,
            } ],
        })

        await volumeTexture.resize([ 8, 8, 2 ])

        await expectScratchDiagnostic(() => runtime.submission()
            .render(pass)
            .submit(), {
            code: 'SCRATCH_RESOURCE_DESCRIPTOR_INVALID',
            severity: 'error',
            phase: 'resource',
        })

        expect(fake.calls.commandEncoders).to.have.length(0)
        expect(fake.calls.textureViews).to.have.length(0)
        expect(fake.calls.renderPasses).to.have.length(0)
        expect(fake.calls.queueSubmissions).to.have.length(0)
        expect(volumeTexture.contentEpoch).to.equal(0)
    })

    it('rejects overlapping color attachment regions while permitting disjoint 3d slices', async() => {

        const fake = createFakeGpu()
        const canvas = createFakeCanvas()
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const texture = await runtime.createTexture({
            size: [ 8, 8 ],
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
        })
        const view = texture.view()
        const overlappingViewPass = runtime.createRenderPass({
            color: [ { target: view }, { target: view } ],
        })
        const surface = runtime.createSurface(canvas.canvas, {
            format: 'bgra8unorm',
            size: { width: 8, height: 8 },
        })
        const overlappingSurfacePass = runtime.createRenderPass({
            color: [ { target: surface }, { target: surface } ],
        })
        for (const pass of [ overlappingViewPass, overlappingSurfacePass ]) {
            await expectScratchDiagnostic(() => runtime.submission().render(pass).submit(), {
                code: 'SCRATCH_RESOURCE_DESCRIPTOR_INVALID',
                severity: 'error',
                phase: 'resource',
            })
        }

        expect(fake.calls.commandEncoders).to.have.length(0)
        expect(fake.calls.textureViews).to.have.length(0)
        expect(fake.calls.renderPasses).to.have.length(0)
        expect(fake.calls.queueSubmissions).to.have.length(0)
        expect(canvas.context.currentTextureCalls).to.equal(0)

        const volumeTexture = await runtime.createTexture({
            dimension: '3d',
            size: [ 8, 8, 2 ],
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
        })
        const volumeView = volumeTexture.view({ dimension: '3d' })
        const disjointPass = runtime.createRenderPass({
            color: [
                { target: volumeView, depthSlice: 0 },
                { target: volumeView, depthSlice: 1 },
            ],
        })
        const submitted = runtime.submission().render(disjointPass).submit()

        expect(fake.calls.commandEncoders).to.have.length(1)
        expect(fake.calls.textureViews).to.have.length(2)
        expect(fake.calls.renderPasses).to.have.length(1)
        expect(fake.calls.queueSubmissions).to.have.length(1)

        await submitted.done
    })

    it('rejects a non-owner Surface alias before presentation effects', async() => {

        const fake = createFakeGpu()
        const canvas = createFakeCanvas()
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const owner = runtime.createSurface(canvas.canvas, {
            format: 'bgra8unorm',
            size: { width: 8, height: 8 },
        })
        const alias = Object.create(owner)
        Object.defineProperties(alias, {
            id: { value: 'forged-pass-surface-alias', enumerable: true },
            label: { value: 'forged pass Surface alias', enumerable: true },
        })

        await expectScratchDiagnostic(() => runtime.createRenderPass({
            color: [ { target: alias } ],
        }), {
            code: 'SCRATCH_SURFACE_CONTEXT_NOT_OWNED',
            severity: 'error',
            phase: 'runtime',
        })

        expect(fake.calls.commandEncoders).to.have.length(0)
        expect(fake.calls.textureViews).to.have.length(0)
        expect(fake.calls.renderPasses).to.have.length(0)
        expect(fake.calls.queueSubmissions).to.have.length(0)
        expect(canvas.context.getConfigurationCalls).to.equal(1)
        expect(canvas.context.currentTextureCalls).to.equal(0)
    })

    it('rejects a forged Surface alias with shadowed public methods before pass effects', async() => {

        const fake = createFakeGpu()
        const canvas = createFakeCanvas()
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const owner = runtime.createSurface(canvas.canvas, {
            format: 'bgra8unorm',
            size: { width: 8, height: 8 },
        })
        const alias = Object.create(owner)
        Object.defineProperties(alias, {
            id: { value: 'forged-shadowed-pass-surface-alias', enumerable: true },
            runtime: { value: runtime, enumerable: true },
            context: { value: owner.context, enumerable: true },
            format: { value: owner.format, enumerable: true },
            size: { value: owner.size, enumerable: true },
            assertUsable: { value() {}, enumerable: true },
            getCurrentTexture: {
                value() {
                    return canvas.context.getCurrentTexture()
                },
                enumerable: true,
            },
        })

        await expectScratchDiagnostic(() => runtime.createRenderPass({
            color: [ { target: alias } ],
        }), {
            code: 'SCRATCH_SURFACE_CONTEXT_NOT_OWNED',
            severity: 'error',
            phase: 'runtime',
        })

        expect(fake.calls.commandEncoders).to.have.length(0)
        expect(fake.calls.textureViews).to.have.length(0)
        expect(fake.calls.renderPasses).to.have.length(0)
        expect(fake.calls.queueSubmissions).to.have.length(0)
        expect(canvas.context.getConfigurationCalls).to.equal(1)
        expect(canvas.context.currentTextureCalls).to.equal(0)
    })

    it('performs the final Surface configuration read before encoder creation', async() => {

        const fixture = await createTriangleScene()
        const secondCanvas = createFakeCanvas()
        const secondSurface = fixture.runtime.createSurface(secondCanvas.canvas, {
            format: 'bgra8unorm',
            size: { width: 32, height: 32 },
        })
        const secondPass = fixture.runtime.createRenderPass({
            color: [ { target: secondSurface, load: 'clear', store: 'store' } ],
        })
        let postEncoderConfigurationReads = 0
        for (const context of [ fixture.context, secondCanvas.context ]) {
            const getConfiguration = context.getConfiguration.bind(context)
            context.getConfiguration = () => {
                if (fixture.calls.commandEncoders.length > 0) {
                    postEncoderConfigurationReads++
                    throw new Error('Surface configuration read after encoder creation')
                }
                return getConfiguration()
            }
        }

        const submitted = fixture.runtime.submission()
            .render(fixture.pass, [ fixture.draw ])
            .render(secondPass)
            .submit()

        expect(postEncoderConfigurationReads).to.equal(0)
        expect(fixture.calls.commandEncoders).to.have.length(1)
        expect(fixture.calls.renderPasses).to.have.length(2)
        expect(fixture.calls.queueSubmissions).to.have.length(1)
        expect(secondCanvas.context.currentTextureCalls).to.equal(1)
        await submitted.done
    })

    it('preserves native Surface usage, view format, color, and tone-mapping capabilities', async() => {

        const fixture = await createTriangleScene('rgba8unorm')
        fixture.surface.configure({
            usage: GPU_TEXTURE_USAGE_TEXTURE_BINDING | GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
            viewFormats: [ 'rgba8unorm-srgb' ],
            colorSpace: 'display-p3',
            toneMapping: { mode: 'extended' },
        })
        const pass = fixture.runtime.createRenderPass({
            color: [ {
                target: fixture.surface,
                format: 'rgba8unorm-srgb',
                viewDescriptor: {
                    format: 'rgba8unorm-srgb',
                    usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
                },
                load: 'clear',
                store: 'store',
            } ],
        })

        const submitted = fixture.runtime.submission().render(pass).submit()

        expect(fixture.surface.usage).to.equal(0x14)
        expect(fixture.surface.viewFormats).to.deep.equal([ 'rgba8unorm-srgb' ])
        expect(fixture.surface.colorSpace).to.equal('display-p3')
        expect(fixture.surface.toneMapping).to.deep.equal({ mode: 'extended' })
        expect(fixture.textureViews.at(-1).descriptor).to.deep.equal({
            format: 'rgba8unorm-srgb',
            usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
        })
        await submitted.done
    })

    it('enforces clear-discard operations for transient Surface attachment views', async() => {

        const fixture = await createTriangleScene()
        fixture.surface.configure({
            usage: GPU_TEXTURE_USAGE_TRANSIENT_ATTACHMENT | GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
        })
        const pass = fixture.runtime.createRenderPass({
            color: [ { target: fixture.surface } ],
        })

        expect(pass.color[0]).to.include({ load: 'clear', store: 'discard' })
        const submitted = fixture.runtime.submission().render(pass).submit()
        expect(fixture.calls.renderPasses.at(-1).descriptor.colorAttachments[0]).to.include({
            loadOp: 'clear',
            storeOp: 'discard',
        })
        await submitted.done

        for (const attachment of [
            { target: fixture.surface, load: 'load' },
            { target: fixture.surface, store: 'store' },
            {
                target: fixture.surface,
                viewDescriptor: { usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT },
            },
        ]) {
            await expectScratchDiagnostic(() => fixture.runtime.createRenderPass({
                color: [ attachment ],
            }), {
                code: 'SCRATCH_RESOURCE_DESCRIPTOR_INVALID',
                severity: 'error',
                phase: 'resource',
            })
        }
    })

    it('revalidates transient Surface operations after usage reconfiguration', async() => {

        const fixture = await createTriangleScene()
        fixture.surface.configure({
            usage: GPU_TEXTURE_USAGE_TRANSIENT_ATTACHMENT | GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
        })

        await expectScratchDiagnostic(() => fixture.runtime.submission()
            .render(fixture.pass)
            .submit(), {
            code: 'SCRATCH_RESOURCE_DESCRIPTOR_INVALID',
            severity: 'error',
            phase: 'resource',
        })
        expect(fixture.context.currentTextureCalls).to.equal(0)
        expect(fixture.calls.commandEncoders).to.have.length(0)
        expect(fixture.calls.renderPasses).to.have.length(0)
        expect(fixture.calls.queueSubmissions).to.have.length(0)
    })

    it('snapshots Surface attachment view descriptors when the PassSpec is created', async() => {

        const fixture = await createTriangleScene()
        const viewDescriptor = {
            label: 'stable surface view',
            usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
        }
        const pass = fixture.runtime.createRenderPass({
            color: [ { target: fixture.surface, viewDescriptor } ],
        })

        viewDescriptor.usage = GPU_TEXTURE_USAGE_TEXTURE_BINDING

        const submitted = fixture.runtime.submission().render(pass).submit()

        expect(pass.color[0].viewDescriptor).to.deep.equal({
            label: 'stable surface view',
            usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
        })
        expect(Object.isFrozen(pass.color[0].viewDescriptor)).to.equal(true)
        expect(fixture.textureViews.at(-1).descriptor).to.deep.equal({
            label: 'stable surface view',
            usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
        })
        await submitted.done
    })

    it('rejects depth-stencil formats in color attachment slots before encoder creation', async() => {

        const fake = createFakeGpu()
        const canvas = createFakeCanvas()
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const depthTexture = await runtime.createTexture({
            size: [ 8, 8 ],
            format: 'depth32float',
            usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
        })
        const invalidSurface = runtime.createSurface(canvas.canvas, {
            format: 'depth32float',
            size: { width: 8, height: 8 },
        })

        for (const target of [ depthTexture.view(), invalidSurface ]) {
            await expectScratchDiagnostic(() => runtime.createRenderPass({
                color: [ { target } ],
            }), {
                code: 'SCRATCH_RESOURCE_DESCRIPTOR_INVALID',
                severity: 'error',
                phase: 'resource',
            })
        }

        const validCanvas = createFakeCanvas()
        const reconfiguredSurface = runtime.createSurface(validCanvas.canvas, {
            format: 'bgra8unorm',
            size: { width: 8, height: 8 },
        })
        const pass = runtime.createRenderPass({
            color: [ { target: reconfiguredSurface } ],
        })
        reconfiguredSurface.configure({ format: 'depth32float' })
        await expectScratchDiagnostic(() => runtime.submission().render(pass).submit(), {
            code: 'SCRATCH_RESOURCE_DESCRIPTOR_INVALID',
            severity: 'error',
            phase: 'resource',
        })

        expect(fake.calls.commandEncoders).to.have.length(0)
        expect(fake.calls.textureViews).to.have.length(0)
        expect(fake.calls.renderPasses).to.have.length(0)
        expect(fake.calls.queueSubmissions).to.have.length(0)
        expect(canvas.context.currentTextureCalls).to.equal(0)
        expect(validCanvas.context.currentTextureCalls).to.equal(0)
    })

    it('keeps compatibility render attachments valid after array-layer growth', async() => {

        const fixture = await createRenderTargetScene()
        const pass = fixture.pass
        const draw = fixture.draw
        await fixture.renderTarget.resize([ 64, 64, 3 ])

        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .render(pass, [ draw ])
            .submit()

        expect(fixture.pass).to.equal(pass)
        expect(fixture.draw).to.equal(draw)
        expect(fixture.calls.commandEncoders).to.have.length(1)
        expect(fixture.calls.textureViews[0].descriptor).to.deep.include({
            dimension: '2d',
            mipLevelCount: 1,
            arrayLayerCount: 1,
        })
        expect(fixture.calls.queueSubmissions).to.have.length(1)
        expect(fixture.renderTarget.contentEpoch).to.equal(1)

        await submitted.done
    })

    it('reuses a persistent color pass and draw against the allocation current at submit time', async() => {

        const fixture = await createRenderTargetScene(
            'rgba8unorm',
            [ 'core-features-and-limits' ]
        )
        const pass = fixture.pass
        const draw = fixture.draw
        const previousTexture = fixture.renderTarget.gpuTexture
        const builder = fixture.runtime.createSubmission({ validation: 'throw' })
            .render(pass, [ draw ])

        await fixture.renderTarget.resize([ 32, 16, 3 ])
        const replacementTexture = fixture.renderTarget.gpuTexture
        const submitted = builder.submit()

        expect(fixture.pass).to.equal(pass)
        expect(fixture.draw).to.equal(draw)
        expect(replacementTexture).to.not.equal(previousTexture)
        expect(previousTexture.destroyed).to.equal(true)
        expect(fixture.calls.textureViews).to.have.length(1)
        expect(fixture.calls.textureViews[0].texture).to.equal(replacementTexture)
        expect(fixture.calls.textureViews[0].descriptor).to.deep.include({
            dimension: '2d',
            mipLevelCount: 1,
            arrayLayerCount: 1,
        })
        expect(fixture.calls.renderPasses[0].descriptor.colorAttachments[0].view)
            .to.equal(fixture.calls.textureViews[0])
        expect(fixture.renderTarget.allocationVersion).to.equal(2)
        expect(fixture.renderTarget.contentEpoch).to.equal(1)
        expect(submitted.resourceAccesses[0]).to.include({
            resourceId: fixture.renderTarget.id,
            access: 'write',
            contentEpochBefore: 0,
            contentEpochAfter: 1,
            allocationVersion: 2,
        })

        await submitted.done
    })

    it('rejects a stale color attachment layer before encoder creation', async() => {

        const fixture = await createRenderTargetScene()
        await fixture.renderTarget.resize([ 64, 64, 3 ])
        const pass = fixture.runtime.createRenderPass({
            color: [ {
                target: fixture.renderTarget.view({
                    dimension: '2d',
                    baseArrayLayer: 2,
                    mipLevelCount: 1,
                    arrayLayerCount: 1,
                }),
            } ],
        })
        await fixture.renderTarget.resize([ 64, 64, 1 ])

        await expectScratchDiagnostic(() => fixture.runtime.createSubmission({ validation: 'throw' })
            .render(pass, [ fixture.draw ])
            .submit(), {
            code: 'SCRATCH_RESOURCE_DESCRIPTOR_INVALID',
            severity: 'error',
            phase: 'resource',
        })

        expect(fixture.calls.commandEncoders).to.have.length(0)
        expect(fixture.calls.textureViews).to.have.length(0)
        expect(fixture.calls.queueSubmissions).to.have.length(0)
        expect(fixture.renderTarget.contentEpoch).to.equal(0)
        expect(fixture.renderTarget.state).to.equal('empty')
    })

    it('advances TextureResource contentEpoch after render attachment writes', async() => {

        const fixture = await createRenderTargetScene()

        expect(fixture.renderTarget.contentEpoch).to.equal(0)
        expect(fixture.renderTarget.state).to.equal('empty')
        expect(fixture.renderTarget.isReady).to.equal(false)

        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .render(fixture.pass, [ fixture.draw ])
            .submit()

        expect(fixture.renderTarget.contentEpoch).to.equal(1)
        expect(fixture.renderTarget.state).to.equal('ready')
        expect(fixture.renderTarget.isReady).to.equal(true)

        await submitted.done
    })

    it('does not rebuild BindSet only because a rendered texture contentEpoch changes', async() => {

        const fixture = await createRenderTargetScene()
        const firstBindGroup = fixture.calls.bindGroups[0]

        expect(fixture.bindSet).to.be.instanceOf(BindSet)
        expect(fixture.calls.bindGroups).to.have.length(1)

        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .render(fixture.pass, [ fixture.draw ])
            .submit()

        expect(fixture.renderTarget.contentEpoch).to.equal(1)
        expect(fixture.renderTarget.state).to.equal('ready')

        await fixture.bindSet.prepare()
        expect(fixture.calls.bindGroups[0]).to.equal(firstBindGroup)
        expect(fixture.calls.bindGroups).to.have.length(1)

        await submitted.done
    })

    it('rejects draw reads of an empty TextureResource before creating a command encoder', async() => {

        const fixture = await createRenderTargetScene()
        const emptyTexture = await fixture.runtime.createTexture({
            label: 'empty sampled texture',
            size: { width: 64, height: 64 },
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_TEXTURE_BINDING,
        })
        const readEmptyTexture = fixture.runtime.createDrawCommand({
            pipeline: fixture.pipeline,
            count: { vertexCount: 3 },
            resources: {
                read: [ readResource(emptyTexture) ],
                write: [],
            },
            whenMissing: 'throw',
        })
        const builder = fixture.runtime.createSubmission({ validation: 'throw' })
            .render(fixture.pass, [ readEmptyTexture ])

        const diagnostic = await expectScratchDiagnostic(() => builder.submit(), {
            code: 'SCRATCH_COMMAND_RESOURCE_NOT_READY',
            severity: 'error',
            phase: 'command',
        })

        expect(diagnostic.subject).to.deep.equal(readEmptyTexture.subject)
        expect(diagnostic.related).to.deep.include(emptyTexture.subject)
        expect(diagnostic.related).to.deep.include(fixture.pass.subject)
        expect(diagnostic.related).to.deep.include(builder.subject)
        expect(diagnostic.expected).to.deep.equal({ resourceState: 'ready' })
        expect(diagnostic.actual).to.deep.include({
            stepIndex: 0,
            commandId: readEmptyTexture.id,
            commandKind: 'draw',
            access: 'read',
            resourceId: emptyTexture.id,
            resourceKind: 'TextureResource',
            resourceState: 'empty',
            contentEpoch: 0,
            allocationVersion: 1,
            whenMissing: 'throw',
        })
        expect(emptyTexture.contentEpoch).to.equal(0)
        expect(emptyTexture.state).to.equal('empty')
        expect(fixture.renderTarget.contentEpoch).to.equal(0)
        expect(fixture.renderTarget.state).to.equal('empty')
        expect(fixture.calls.commandEncoders).to.have.length(0)
        expect(fixture.calls.renderPasses).to.have.length(0)
        expect(fixture.calls.drawCalls).to.have.length(0)
        expect(fixture.calls.queueSubmissions).to.have.length(0)
    })

    it('treats preserved epochs as unavailable content after allocation replacement', async() => {

        const fixture = await createRenderTargetScene()
        advanceResourceContentEpochForTest(fixture.renderTarget)
        const secondTarget = await fixture.runtime.createTexture({
            label: 'replacement readiness target',
            size: { width: 64, height: 64 },
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
        })
        const secondPass = fixture.runtime.createRenderPass({
            color: [
                {
                    target: secondTarget.view(),
                    load: 'clear',
                    store: 'store',
                },
            ],
        })
        const readBeforeReplacement = fixture.runtime.createDrawCommand({
            pipeline: fixture.pipeline,
            count: { vertexCount: 3 },
            resources: {
                read: [ readResource(fixture.renderTarget, 1) ],
                write: [],
            },
            whenMissing: 'throw',
        })
        const builder = fixture.runtime.createSubmission({ validation: 'throw' })
            .render(secondPass, [ readBeforeReplacement ])

        await fixture.renderTarget.resize([ 32, 32 ])

        const diagnostic = await expectScratchDiagnostic(() => builder.submit(), {
            code: 'SCRATCH_COMMAND_RESOURCE_NOT_READY',
            severity: 'error',
            phase: 'command',
        })

        expect(fixture.renderTarget.contentEpoch).to.equal(1)
        expect(fixture.renderTarget.allocationVersion).to.equal(2)
        expect(fixture.renderTarget.state).to.equal('empty')
        expect(diagnostic.actual).to.deep.include({
            resourceId: fixture.renderTarget.id,
            resourceState: 'empty',
            contentEpoch: 1,
            allocationVersion: 2,
        })
        expect(fixture.calls.commandEncoders).to.have.length(0)
        expect(fixture.calls.renderPasses).to.have.length(0)
        expect(fixture.calls.queueSubmissions).to.have.length(0)
    })

    it('rejects draw reads requiring a future texture epoch before creating a command encoder', async() => {

        const fixture = await createRenderTargetScene()
        advanceResourceContentEpochForTest(fixture.renderTarget)
        const secondTarget = await fixture.runtime.createTexture({
            label: 'future epoch render target',
            size: { width: 64, height: 64 },
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
        })
        const secondPass = fixture.runtime.createRenderPass({
            label: 'future epoch pass',
            color: [
                {
                    target: secondTarget.view(),
                    load: 'clear',
                    store: 'store',
                    clear: [ 0, 0, 0, 1 ],
                },
            ],
        })
        const readFutureTexture = fixture.runtime.createDrawCommand({
            pipeline: fixture.pipeline,
            count: { vertexCount: 3 },
            resources: {
                read: [ readResource(fixture.renderTarget, 2) ],
                write: [],
            },
            whenMissing: 'throw',
        })
        const builder = fixture.runtime.createSubmission({ validation: 'throw' })
            .render(secondPass, [ readFutureTexture ])

        const diagnostic = await expectScratchDiagnostic(() => builder.submit(), {
            code: 'SCRATCH_SUBMISSION_READ_BEFORE_WRITE',
            severity: 'error',
            phase: 'submission',
        })

        expect(diagnostic.subject).to.deep.equal(readFutureTexture.subject)
        expect(diagnostic.related).to.deep.include(fixture.renderTarget.subject)
        expect(diagnostic.related).to.deep.include(secondPass.subject)
        expect(diagnostic.related).to.deep.include(builder.subject)
        expect(diagnostic.expected).to.deep.equal({ contentEpoch: 2 })
        expect(diagnostic.actual).to.deep.include({
            stepIndex: 0,
            commandId: readFutureTexture.id,
            commandKind: 'draw',
            access: 'read',
            resourceId: fixture.renderTarget.id,
            resourceKind: 'TextureResource',
            resourceState: 'ready',
            simulatedContentEpoch: 1,
            currentContentEpoch: 1,
            whenMissing: 'throw',
        })
        expect(fixture.renderTarget.contentEpoch).to.equal(1)
        expect(secondTarget.contentEpoch).to.equal(0)
        expect(fixture.calls.commandEncoders).to.have.length(0)
        expect(fixture.calls.renderPasses).to.have.length(0)
        expect(fixture.calls.drawCalls).to.have.length(0)
        expect(fixture.calls.queueSubmissions).to.have.length(0)
    })

    it('rejects draw reads requiring an older texture epoch before creating a command encoder', async() => {

        const fixture = await createRenderTargetScene()
        advanceResourceContentEpochForTest(fixture.renderTarget)
        const secondTarget = await fixture.runtime.createTexture({
            label: 'stale epoch render target',
            size: { width: 64, height: 64 },
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
        })
        const secondPass = fixture.runtime.createRenderPass({
            label: 'stale epoch pass',
            color: [
                {
                    target: secondTarget.view(),
                    load: 'clear',
                    store: 'store',
                    clear: [ 0, 0, 0, 1 ],
                },
            ],
        })
        const readStaleTexture = fixture.runtime.createDrawCommand({
            pipeline: fixture.pipeline,
            count: { vertexCount: 3 },
            resources: {
                read: [ readResource(fixture.renderTarget, 1) ],
                write: [],
            },
            whenMissing: 'throw',
        })
        const builder = fixture.runtime.createSubmission({ validation: 'throw' })
            .render(fixture.pass, [ fixture.draw ])
            .render(secondPass, [ readStaleTexture ])

        const diagnostic = await expectScratchDiagnostic(() => builder.submit(), {
            code: 'SCRATCH_SUBMISSION_STALE_READ',
            severity: 'error',
            phase: 'submission',
        })

        expect(diagnostic.subject).to.deep.equal(readStaleTexture.subject)
        expect(diagnostic.related).to.deep.include(fixture.renderTarget.subject)
        expect(diagnostic.related).to.deep.include(secondPass.subject)
        expect(diagnostic.related).to.deep.include(builder.subject)
        expect(diagnostic.expected).to.deep.equal({ contentEpoch: 1 })
        expect(diagnostic.actual).to.deep.include({
            stepIndex: 1,
            commandId: readStaleTexture.id,
            commandKind: 'draw',
            access: 'read',
            resourceId: fixture.renderTarget.id,
            resourceKind: 'TextureResource',
            resourceState: 'ready',
            simulatedContentEpoch: 2,
            currentContentEpoch: 1,
            whenMissing: 'throw',
        })
        expect(fixture.renderTarget.contentEpoch).to.equal(1)
        expect(secondTarget.contentEpoch).to.equal(0)
        expect(fixture.calls.commandEncoders).to.have.length(0)
        expect(fixture.calls.renderPasses).to.have.length(0)
        expect(fixture.calls.drawCalls).to.have.length(0)
        expect(fixture.calls.queueSubmissions).to.have.length(0)
    })

    it('rejects color attachment metadata and surface view descriptor divergence', async() => {

        const fixture = await createTriangleScene('bgra8unorm')
        const diagnostic = await expectScratchDiagnostic(() => fixture.runtime.createRenderPass({
            color: [
                {
                    target: fixture.surface,
                    format: 'rgba8unorm',
                    load: 'clear',
                    store: 'store',
                    clear: [ 0, 0, 0, 1 ],
                },
            ],
        }), {
            code: 'SCRATCH_RESOURCE_DESCRIPTOR_INVALID',
            severity: 'error',
            phase: 'resource',
        })

        expect(diagnostic.expected).to.deep.equal({ format: 'bgra8unorm' })
        expect(diagnostic.actual).to.deep.equal({ format: 'rgba8unorm' })

        for (const viewDescriptor of [
            { format: 'rgba8unorm' },
            { usage: GPU_TEXTURE_USAGE_TEXTURE_BINDING },
            { usage: 0x1_0000_0010 },
            { dimension: '2d-array' },
        ]) {
            await expectScratchDiagnostic(() => fixture.runtime.createRenderPass({
                color: [ { target: fixture.surface, viewDescriptor } ],
            }), {
                code: 'SCRATCH_RESOURCE_DESCRIPTOR_INVALID',
                severity: 'error',
                phase: 'resource',
            })
        }
        expect(fixture.calls.commandEncoders).to.have.length(0)
    })

    it('rejects render pipeline target format mismatches against TextureResource attachments', async() => {

        const fixture = await createRenderTargetScene('rgba8unorm')
        const mismatchedPipeline = await fixture.runtime.createRenderPipeline({
            program: fixture.program,
            targets: [ { format: 'bgra8unorm' } ],
        })
        const mismatchedDraw = fixture.runtime.createDrawCommand({
            pipeline: mismatchedPipeline,
            count: { vertexCount: 3 },
            resources: {
                read: [],
                write: [],
            },
            whenMissing: 'throw',
        })

        try {
            fixture.runtime.createSubmission({ validation: 'throw' })
                .render(fixture.pass, [ mismatchedDraw ])
                .submit()
            throw new Error('expected texture target format mismatch to fail')
        } catch (error) {
            expect(error).to.be.instanceOf(ScratchDiagnosticError)
            expect(error.diagnostic).to.include({
                code: 'SCRATCH_PIPELINE_TARGET_FORMAT_MISMATCH',
                severity: 'error',
                phase: 'pipeline',
            })
            expect(error.diagnostic.expected).to.deep.equal({ format: 'rgba8unorm' })
            expect(error.diagnostic.actual).to.deep.equal({ format: 'bgra8unorm' })
        }
    })

    it('rejects invalid TextureResource attachment views and transient operations', async() => {

        const fixtureA = await createRenderTargetScene()
        const fixtureB = await createRenderTargetScene()

        try {
            fixtureA.runtime.createRenderPass({
                color: [
                    {
                        target: fixtureB.renderTarget.view(),
                        load: 'clear',
                        store: 'store',
                    },
                ],
            })
            throw new Error('expected wrong-runtime texture attachment to fail')
        } catch (error) {
            expect(error).to.be.instanceOf(ScratchDiagnosticError)
            expect(error.diagnostic).to.include({
                code: 'SCRATCH_RESOURCE_WRONG_RUNTIME',
                severity: 'error',
                phase: 'resource',
            })
        }

        fixtureA.renderTarget.dispose()

        try {
            fixtureA.runtime.createRenderPass({
                color: [
                    {
                        target: fixtureA.renderTarget.view(),
                        load: 'clear',
                        store: 'store',
                    },
                ],
            })
            throw new Error('expected disposed texture attachment to fail')
        } catch (error) {
            expect(error).to.be.instanceOf(ScratchDiagnosticError)
            expect(error.diagnostic).to.include({
                code: 'SCRATCH_RESOURCE_DISPOSED',
                severity: 'error',
                phase: 'resource',
            })
        }

        const textureOnlyForSampling = await fixtureB.runtime.createTexture({
            size: { width: 4, height: 4 },
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_TEXTURE_BINDING,
        })

        try {
            fixtureB.runtime.createRenderPass({
                color: [
                    {
                        target: textureOnlyForSampling.view(),
                        load: 'clear',
                        store: 'store',
                    },
                ],
            })
            throw new Error('expected missing render attachment usage to fail')
        } catch (error) {
            expect(error).to.be.instanceOf(ScratchDiagnosticError)
            expect(error.diagnostic).to.include({
                code: 'SCRATCH_RESOURCE_USAGE_MISSING',
                severity: 'error',
                phase: 'resource',
            })
        }

        const narrowedAttachment = await fixtureB.runtime.createTexture({
            size: { width: 4, height: 4 },
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
        })
        await expectScratchDiagnostic(() => fixtureB.runtime.createRenderPass({
            color: [ {
                target: narrowedAttachment.view({ usage: GPU_TEXTURE_USAGE_TEXTURE_BINDING }),
            } ],
        }), {
            code: 'SCRATCH_RESOURCE_USAGE_MISSING',
            severity: 'error',
            phase: 'resource',
        })

        await expectScratchDiagnostic(() => fixtureB.runtime.createRenderPass({
            color: [ {
                target: narrowedAttachment.view(),
                format: 'bgra8unorm',
            } ],
        }), {
            code: 'SCRATCH_RESOURCE_DESCRIPTOR_INVALID',
            severity: 'error',
            phase: 'resource',
        })

        const transientAttachment = await fixtureB.runtime.createTexture({
            size: { width: 4, height: 4 },
            format: 'rgba8unorm',
            usage:
                GPU_TEXTURE_USAGE_RENDER_ATTACHMENT |
                GPU_TEXTURE_USAGE_TRANSIENT_ATTACHMENT,
        })
        const transientPass = fixtureB.runtime.createRenderPass({
            color: [ { target: transientAttachment.view() } ],
        })
        expect(transientPass.color[0]).to.include({ load: 'clear', store: 'discard' })
        for (const attachment of [
            { target: transientAttachment.view(), load: 'load' },
            { target: transientAttachment.view(), store: 'store' },
        ]) {
            await expectScratchDiagnostic(() => fixtureB.runtime.createRenderPass({
                color: [ attachment ],
            }), {
                code: 'SCRATCH_RESOURCE_DESCRIPTOR_INVALID',
                severity: 'error',
                phase: 'resource',
            })
        }
    })

    it('rejects draw reads of the current TextureResource color attachment before encoding', async() => {

        const fixture = await createRenderTargetScene()
        advanceResourceContentEpochForTest(fixture.renderTarget)
        const conflictingDraw = fixture.runtime.createDrawCommand({
            pipeline: fixture.pipeline,
            count: { vertexCount: 3 },
            resources: {
                read: [ readResource(fixture.renderTarget) ],
                write: [],
            },
            whenMissing: 'throw',
        })

        expect(fixture.renderTarget.contentEpoch).to.equal(1)
        expect(fixture.renderTarget.state).to.equal('ready')

        try {
            fixture.runtime.createSubmission({ validation: 'throw' })
                .render(fixture.pass, [ conflictingDraw ])
                .submit()
            throw new Error('expected render attachment read conflict to fail')
        } catch (error) {
            expect(error).to.be.instanceOf(ScratchDiagnosticError)
            expect(error.diagnostic).to.include({
                code: 'SCRATCH_SUBMISSION_RESOURCE_ACCESS_CONFLICT',
                severity: 'error',
                phase: 'submission',
            })
            expect(error.diagnostic.subject).to.deep.equal(conflictingDraw.subject)
            expect(error.diagnostic.related).to.deep.include(fixture.pass.subject)
            expect(error.diagnostic.related).to.deep.include(fixture.renderTarget.subject)
            expect(error.diagnostic.expected).to.deep.equal({
                attachment: 'pass-level write only',
                drawResources: 'must exclude current render pass color attachment targets',
            })
            expect(error.diagnostic.actual).to.deep.equal({
                stepIndex: 0,
                passId: fixture.pass.id,
                requestedCommandId: conflictingDraw.id,
                commandId: conflictingDraw.id,
                attemptedCommandIds: [ conflictingDraw.id ],
                attempts: [ {
                    commandId: conflictingDraw.id,
                    commandKind: 'draw',
                    policy: 'throw',
                    missing: [],
                } ],
                access: 'read',
                resourceId: fixture.renderTarget.id,
                resourceKind: 'TextureResource',
                contentEpoch: 1,
                allocationVersion: 1,
            })
            expect(error.report).to.deep.equal({
                version: 1,
                diagnostics: [ error.diagnostic ],
                hasErrors: true,
                errorCount: 1,
                warningCount: 0,
            })
        }

        expect(fixture.renderTarget.contentEpoch).to.equal(1)
        expect(fixture.renderTarget.state).to.equal('ready')
        expect(fixture.calls.commandEncoders).to.have.length(0)
        expect(fixture.calls.renderPasses).to.have.length(0)
        expect(fixture.calls.drawCalls).to.have.length(0)
        expect(fixture.calls.queueSubmissions).to.have.length(0)
    })

    it('attaches render resource conflict diagnostics and continues in warn mode', async() => {

        const fixture = await createRenderTargetScene()
        advanceResourceContentEpochForTest(fixture.renderTarget)
        const conflictingDraw = fixture.runtime.createDrawCommand({
            pipeline: fixture.pipeline,
            count: { vertexCount: 3 },
            resources: {
                read: [ readResource(fixture.renderTarget) ],
                write: [],
            },
            whenMissing: 'throw',
        })

        const submitted = fixture.runtime.createSubmission({ validation: 'warn' })
            .render(fixture.pass, [ conflictingDraw ])
            .submit()

        expect(submitted.report).to.deep.equal({
            version: 1,
            diagnostics: submitted.diagnostics,
            hasErrors: true,
            errorCount: 1,
            warningCount: 0,
        })
        expect(submitted.diagnostics).to.equal(submitted.report.diagnostics)
        expect(submitted.diagnostics).to.have.length(1)
        expect(submitted.diagnostics[0]).to.include({
            code: 'SCRATCH_SUBMISSION_RESOURCE_ACCESS_CONFLICT',
            severity: 'error',
            phase: 'submission',
        })
        expect(submitted.diagnostics[0].subject).to.deep.equal(conflictingDraw.subject)
        expect(submitted.diagnostics[0].actual).to.deep.include({
            stepIndex: 0,
            passId: fixture.pass.id,
            commandId: conflictingDraw.id,
            access: 'read',
            resourceId: fixture.renderTarget.id,
            resourceKind: 'TextureResource',
            contentEpoch: 1,
            allocationVersion: 1,
        })
        expect(Object.isFrozen(submitted.diagnostics[0])).to.equal(true)
        expect(Object.isFrozen(submitted.diagnostics[0].subject)).to.equal(true)
        expect(Object.isFrozen(submitted.diagnostics[0].related)).to.equal(true)
        expect(Object.isFrozen(submitted.diagnostics[0].actual)).to.equal(true)
        expect(() => {
            submitted.diagnostics[0].actual.stepIndex = 99
        }).to.throw(TypeError)
        expect(submitted.diagnostics[0].actual.stepIndex).to.equal(0)
        expect(fixture.calls.renderPasses).to.have.length(1)
        expect(fixture.calls.drawCalls).to.have.length(1)
        expect(fixture.calls.queueSubmissions).to.have.length(1)
        expect(fixture.renderTarget.contentEpoch).to.equal(2)
        expect(fixture.renderTarget.state).to.equal('ready')
        expect(submitted.resourceAccesses.map(access => access.access)).to.deep.equal([ 'read', 'write' ])
        expect(submitted.producerEpochs.map(epoch => epoch.resourceId)).to.deep.equal([ fixture.renderTarget.id ])

        await submitted.done
    })

    it('skips render resource conflict diagnostics and continues in off mode', async() => {

        const fixture = await createRenderTargetScene()
        advanceResourceContentEpochForTest(fixture.renderTarget)
        const conflictingDraw = fixture.runtime.createDrawCommand({
            pipeline: fixture.pipeline,
            count: { vertexCount: 3 },
            resources: {
                read: [ readResource(fixture.renderTarget) ],
                write: [],
            },
            whenMissing: 'throw',
        })

        const submitted = fixture.runtime.createSubmission({ validation: 'off' })
            .render(fixture.pass, [ conflictingDraw ])
            .submit()

        expect(submitted.report).to.deep.equal({
            version: 1,
            diagnostics: [],
            hasErrors: false,
            errorCount: 0,
            warningCount: 0,
        })
        expect(submitted.diagnostics).to.equal(submitted.report.diagnostics)
        expect(fixture.calls.renderPasses).to.have.length(1)
        expect(fixture.calls.drawCalls).to.have.length(1)
        expect(fixture.calls.queueSubmissions).to.have.length(1)
        expect(fixture.renderTarget.contentEpoch).to.equal(2)
        expect(fixture.renderTarget.state).to.equal('ready')

        await submitted.done
    })

    it('rejects draw writes of the current TextureResource color attachment before encoding', async() => {

        const fixture = await createRenderTargetScene()
        const conflictingDraw = fixture.runtime.createDrawCommand({
            pipeline: fixture.pipeline,
            count: { vertexCount: 3 },
            resources: {
                read: [],
                write: [ fixture.renderTarget ],
            },
            whenMissing: 'throw',
        })

        try {
            fixture.runtime.createSubmission({ validation: 'throw' })
                .render(fixture.pass, [ conflictingDraw ])
                .submit()
            throw new Error('expected render attachment write conflict to fail')
        } catch (error) {
            expect(error).to.be.instanceOf(ScratchDiagnosticError)
            expect(error.diagnostic).to.include({
                code: 'SCRATCH_SUBMISSION_RESOURCE_ACCESS_CONFLICT',
                severity: 'error',
                phase: 'submission',
            })
            expect(error.diagnostic.subject).to.deep.equal(conflictingDraw.subject)
            expect(error.diagnostic.related).to.deep.include(fixture.pass.subject)
            expect(error.diagnostic.related).to.deep.include(fixture.renderTarget.subject)
            expect(error.diagnostic.actual).to.deep.include({
                stepIndex: 0,
                passId: fixture.pass.id,
                commandId: conflictingDraw.id,
                access: 'write',
                resourceId: fixture.renderTarget.id,
                resourceKind: 'TextureResource',
                contentEpoch: 0,
                allocationVersion: 1,
            })
            expect(error.report).to.deep.equal({
                version: 1,
                diagnostics: [ error.diagnostic ],
                hasErrors: true,
                errorCount: 1,
                warningCount: 0,
            })
        }

        expect(fixture.renderTarget.contentEpoch).to.equal(0)
        expect(fixture.calls.commandEncoders).to.have.length(0)
        expect(fixture.calls.renderPasses).to.have.length(0)
        expect(fixture.calls.drawCalls).to.have.length(0)
        expect(fixture.calls.queueSubmissions).to.have.length(0)
    })

    it('allows a draw to read a texture written by an earlier render step while rendering elsewhere', async() => {

        const fixture = await createRenderTargetScene()
        const secondTarget = await fixture.runtime.createTexture({
            label: 'second render target',
            size: { width: 64, height: 64 },
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
        })
        const secondPass = fixture.runtime.createRenderPass({
            label: 'sample previous pass',
            color: [
                {
                    target: secondTarget.view(),
                    load: 'clear',
                    store: 'store',
                    clear: [ 0, 0, 0, 1 ],
                },
            ],
        })
        const samplePrevious = fixture.runtime.createDrawCommand({
            pipeline: fixture.pipeline,
            count: { vertexCount: 3 },
            resources: {
                read: [ readResource(fixture.renderTarget, 1) ],
                write: [],
            },
            whenMissing: 'throw',
        })

        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .render(fixture.pass, [ fixture.draw ])
            .render(secondPass, [ samplePrevious ])
            .submit()

        expect(fixture.calls.queueSubmissions).to.have.length(1)
        expect(fixture.renderTarget.contentEpoch).to.equal(1)
        expect(secondTarget.contentEpoch).to.equal(1)
        expect(submitted.resourceAccesses.map(access => ({
            stepIndex: access.stepIndex,
            stepKind: access.stepKind,
            commandKind: access.commandKind,
            commandId: access.commandId,
            passId: access.passId,
            resourceId: access.resourceId,
            access: access.access,
            contentEpochBefore: access.contentEpochBefore,
            contentEpochAfter: access.contentEpochAfter,
        }))).to.deep.equal([
            {
                stepIndex: 0,
                stepKind: 'render',
                commandKind: undefined,
                commandId: undefined,
                passId: fixture.pass.id,
                resourceId: fixture.renderTarget.id,
                access: 'write',
                contentEpochBefore: 0,
                contentEpochAfter: 1,
            },
            {
                stepIndex: 1,
                stepKind: 'render',
                commandKind: 'draw',
                commandId: samplePrevious.id,
                passId: secondPass.id,
                resourceId: fixture.renderTarget.id,
                access: 'read',
                contentEpochBefore: 1,
                contentEpochAfter: 1,
            },
            {
                stepIndex: 1,
                stepKind: 'render',
                commandKind: undefined,
                commandId: undefined,
                passId: secondPass.id,
                resourceId: secondTarget.id,
                access: 'write',
                contentEpochBefore: 0,
                contentEpochAfter: 1,
            },
        ])
        expect(submitted.producerEpochs.map(epoch => epoch.resourceId)).to.deep.equal([ fixture.renderTarget.id, secondTarget.id ])

        await submitted.done
    })

    it('allows a draw to read a texture made ready by earlier submitted work', async() => {

        const fixture = await createRenderTargetScene()
        const firstSubmitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .render(fixture.pass, [ fixture.draw ])
            .submit()
        await firstSubmitted.done

        const secondTarget = await fixture.runtime.createTexture({
            label: 'later render target',
            size: { width: 64, height: 64 },
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
        })
        const secondPass = fixture.runtime.createRenderPass({
            label: 'sample ready previous work',
            color: [
                {
                    target: secondTarget.view(),
                    load: 'clear',
                    store: 'store',
                    clear: [ 0, 0, 0, 1 ],
                },
            ],
        })
        const sampleReadyTexture = fixture.runtime.createDrawCommand({
            pipeline: fixture.pipeline,
            count: { vertexCount: 3 },
            resources: {
                read: [ readResource(fixture.renderTarget) ],
                write: [],
            },
            whenMissing: 'throw',
        })

        expect(fixture.renderTarget.contentEpoch).to.equal(1)
        expect(fixture.renderTarget.state).to.equal('ready')

        const secondSubmitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .render(secondPass, [ sampleReadyTexture ])
            .submit()

        expect(fixture.calls.queueSubmissions).to.have.length(2)
        expect(secondTarget.contentEpoch).to.equal(1)
        expect(secondTarget.state).to.equal('ready')
        expect(secondSubmitted.resourceAccesses.map(access => ({
            stepIndex: access.stepIndex,
            stepKind: access.stepKind,
            commandKind: access.commandKind,
            resourceId: access.resourceId,
            access: access.access,
            contentEpochBefore: access.contentEpochBefore,
            contentEpochAfter: access.contentEpochAfter,
        }))).to.deep.equal([
            {
                stepIndex: 0,
                stepKind: 'render',
                commandKind: 'draw',
                resourceId: fixture.renderTarget.id,
                access: 'read',
                contentEpochBefore: 1,
                contentEpochAfter: 1,
            },
            {
                stepIndex: 0,
                stepKind: 'render',
                commandKind: undefined,
                resourceId: secondTarget.id,
                access: 'write',
                contentEpochBefore: 0,
                contentEpochAfter: 1,
            },
        ])

        await secondSubmitted.done
    })

    it('rejects wrong pass kinds with structured diagnostics', async() => {

        const fixture = await createTriangleScene()
        const fakeComputePass = {
            runtime: fixture.runtime,
            passKind: 'compute',
            subject: { kind: 'PassSpec', id: 'compute-pass', passKind: 'compute' },
            assertUsable() {},
            assertRuntime() {},
        }

        try {
            fixture.runtime.createSubmission({ validation: 'throw' })
                .render(fakeComputePass, [ fixture.draw ])
                .submit()
            throw new Error('expected wrong pass kind to fail')
        } catch (error) {
            expect(error).to.be.instanceOf(ScratchDiagnosticError)
            expect(error.diagnostic).to.include({
                code: 'SCRATCH_COMMAND_PASS_KIND_MISMATCH',
                severity: 'error',
                phase: 'command',
            })
            expect(error.diagnostic.expected).to.deep.equal({ passKind: 'render' })
            expect(error.diagnostic.actual).to.deep.equal({ passKind: 'compute' })
        }
    })

    it('rejects wrong-runtime commands with structured diagnostics', async() => {

        const fixtureA = await createTriangleScene()
        const fixtureB = await createTriangleScene()

        try {
            fixtureA.runtime.createSubmission({ validation: 'throw' })
                .render(fixtureA.pass, [ fixtureB.draw ])
                .submit()
            throw new Error('expected wrong-runtime command to fail')
        } catch (error) {
            expect(error).to.be.instanceOf(ScratchDiagnosticError)
            expect(error.diagnostic).to.include({
                code: 'SCRATCH_COMMAND_WRONG_RUNTIME',
                severity: 'error',
                phase: 'command',
            })
            expect(error.diagnostic.expected).to.deep.equal({ runtimeId: fixtureB.runtime.id })
            expect(error.diagnostic.actual).to.deep.equal({ runtimeId: fixtureA.runtime.id })
        }
    })

    it('keeps wrong-runtime command errors hard in warn and off modes', async() => {

        const fixtureA = await createTriangleScene()
        const fixtureB = await createTriangleScene()

        for (const validation of [ 'warn', 'off' ]) {
            try {
                fixtureA.runtime.createSubmission({ validation })
                    .render(fixtureA.pass, [ fixtureB.draw ])
                    .submit()
                throw new Error(`expected wrong-runtime command to fail in ${validation} mode`)
            } catch (error) {
                expect(error).to.be.instanceOf(ScratchDiagnosticError)
                expect(error.diagnostic).to.include({
                    code: 'SCRATCH_COMMAND_WRONG_RUNTIME',
                    severity: 'error',
                    phase: 'command',
                })
            }
        }

        expect(fixtureA.calls.renderPasses).to.have.length(0)
        expect(fixtureA.calls.drawCalls).to.have.length(0)
        expect(fixtureA.calls.queueSubmissions).to.have.length(0)
    })

    it('rejects disposed commands during submission with structured diagnostics', async() => {

        const fixture = await createTriangleScene()
        const builder = fixture.runtime.createSubmission({ validation: 'throw' })

        fixture.draw.dispose()

        expect(builder).to.be.instanceOf(SubmissionBuilder)
        try {
            builder.render(fixture.pass, [ fixture.draw ]).submit()
            throw new Error('expected disposed command to fail')
        } catch (error) {
            expect(error).to.be.instanceOf(ScratchDiagnosticError)
            expect(error.diagnostic).to.include({
                code: 'SCRATCH_COMMAND_DISPOSED',
                severity: 'error',
                phase: 'command',
            })
        }
    })
})
