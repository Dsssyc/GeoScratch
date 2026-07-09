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
import { createFakeCanvas, createFakeGpu, triangleWgsl } from './scratch-test-utils.js'

const GPU_TEXTURE_USAGE_TEXTURE_BINDING = 0x4
const GPU_TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10

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
    const pipeline = runtime.createRenderPipeline({
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

async function createRenderTargetScene(format = 'rgba8unorm') {

    const fake = createFakeGpu()
    const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
    const renderTarget = runtime.createTexture({
        label: 'offscreen color target',
        size: { width: 64, height: 64 },
        format,
        usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
    })
    const sampler = runtime.createSampler({
        label: 'offscreen sampler',
        magFilter: 'nearest',
        minFilter: 'nearest',
    })
    const bindLayout = runtime.createBindLayout({
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
    const bindSet = runtime.createBindSet(bindLayout, {
        colorTexture: renderTarget,
        colorSampler: sampler,
    }, {
        label: 'sample offscreen set',
    })
    const program = runtime.createProgram({
        modules: [ triangleWgsl ],
        entryPoints: {
            vertex: 'vsMain',
            fragment: 'fsMain',
        },
    })
    const pipeline = runtime.createRenderPipeline({
        program,
        targets: [ { format } ],
    })
    const draw = runtime.createDrawCommand({
        pipeline,
        count: { vertexCount: 3 },
        resources: {
            read: [ renderTarget, sampler ],
            write: [],
        },
        whenMissing: 'throw',
    })
    const pass = runtime.createRenderPass({
        label: 'offscreen pass',
        color: [
            {
                target: renderTarget,
                load: 'clear',
                store: 'store',
                clear: [ 0.1, 0.2, 0.3, 1 ],
            },
        ],
    })

    return { ...fake, runtime, renderTarget, sampler, bindLayout, bindSet, program, pipeline, draw, pass }
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

    it('lowers TextureResource color attachments into WebGPU render pass descriptors', async() => {

        const fixture = await createRenderTargetScene()

        expect(fixture.renderTarget).to.be.instanceOf(TextureResource)
        expect(fixture.pass.color).to.have.length(1)
        expect(fixture.pass.color[0].target).to.equal(fixture.renderTarget)
        expect(fixture.pass.color[0].format).to.equal('rgba8unorm')

        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .render(fixture.pass, [ fixture.draw ])
            .submit()

        expect(fixture.calls.textureViews).to.have.length(1)
        expect(fixture.calls.textureViews[0].texture).to.equal(fixture.renderTarget.gpuTexture)
        expect(fixture.calls.textureViews[0].descriptor).to.deep.equal({})
        expect(fixture.calls.renderPasses).to.have.length(1)
        expect(fixture.calls.renderPasses[0].descriptor.colorAttachments[0]).to.deep.equal({
            view: fixture.calls.textureViews[0],
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: [ 0.1, 0.2, 0.3, 1 ],
        })

        await submitted.done
    })

    it('advances TextureResource contentEpoch after render attachment writes', async() => {

        const fixture = await createRenderTargetScene()

        expect(fixture.renderTarget.contentEpoch).to.equal(0)

        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .render(fixture.pass, [ fixture.draw ])
            .submit()

        expect(fixture.renderTarget.contentEpoch).to.equal(1)

        await submitted.done
    })

    it('does not rebuild BindSet only because a rendered texture contentEpoch changes', async() => {

        const fixture = await createRenderTargetScene()
        const firstBindGroup = fixture.bindSet.getBindGroup()

        expect(fixture.bindSet).to.be.instanceOf(BindSet)
        expect(fixture.calls.bindGroups).to.have.length(1)

        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .render(fixture.pass, [ fixture.draw ])
            .submit()

        expect(fixture.renderTarget.contentEpoch).to.equal(1)

        const secondBindGroup = fixture.bindSet.getBindGroup()

        expect(secondBindGroup).to.equal(firstBindGroup)
        expect(fixture.calls.bindGroups).to.have.length(1)

        await submitted.done
    })

    it('rejects target format mismatches with structured diagnostics', async() => {

        const fixture = await createTriangleScene('bgra8unorm')
        const mismatchedPass = fixture.runtime.createRenderPass({
            color: [
                {
                    target: fixture.surface,
                    format: 'rgba8unorm',
                    load: 'clear',
                    store: 'store',
                    clear: [ 0, 0, 0, 1 ],
                },
            ],
        })

        try {
            fixture.runtime.createSubmission({ validation: 'throw' })
                .render(mismatchedPass, [ fixture.draw ])
                .submit()
            throw new Error('expected target format mismatch to fail')
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

    it('rejects render pipeline target format mismatches against TextureResource attachments', async() => {

        const fixture = await createRenderTargetScene('rgba8unorm')
        const mismatchedPipeline = fixture.runtime.createRenderPipeline({
            program: fixture.program,
            targets: [ { format: 'bgra8unorm' } ],
        })
        const mismatchedDraw = fixture.runtime.createDrawCommand({
            pipeline: mismatchedPipeline,
            count: { vertexCount: 3 },
            resources: {
                read: [ fixture.renderTarget, fixture.sampler ],
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

    it('rejects invalid TextureResource render attachment targets with structured diagnostics', async() => {

        const fixtureA = await createRenderTargetScene()
        const fixtureB = await createRenderTargetScene()

        try {
            fixtureA.runtime.createRenderPass({
                color: [
                    {
                        target: fixtureB.renderTarget,
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
                        target: fixtureA.renderTarget,
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

        const textureOnlyForSampling = fixtureB.runtime.createTexture({
            size: { width: 4, height: 4 },
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_TEXTURE_BINDING,
        })

        try {
            fixtureB.runtime.createRenderPass({
                color: [
                    {
                        target: textureOnlyForSampling,
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
