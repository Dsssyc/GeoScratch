import { expect } from 'chai'
import {
    BindSet,
    ScratchDiagnosticError,
    ScratchRuntime,
    TextureResource,
} from 'geoscratch'
import {
    advanceResourceContentEpochForTest,
    createFakeGpu,
    triangleWgsl,
} from './scratch-test-utils.js'

const GPU_TEXTURE_USAGE_TEXTURE_BINDING = 0x4
const GPU_TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10

async function createDepthFixture(depthFormat = 'depth24plus') {

    const fake = createFakeGpu()
    const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
    const colorTarget = await runtime.createTexture({
        label: 'scene color',
        size: { width: 64, height: 64 },
        format: 'rgba8unorm',
        usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
    })
    const depthTarget = await runtime.createTexture({
        label: 'scene depth',
        size: { width: 64, height: 64 },
        format: depthFormat,
        usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
    })
    const program = runtime.createProgram({
        modules: [ triangleWgsl ],
        entryPoints: {
            vertex: 'vsMain',
            fragment: 'fsMain',
        },
    })
    const depthPipeline = await runtime.createRenderPipeline({
        program,
        targets: [ { format: colorTarget.format } ],
        depthStencil: {
            format: depthTarget.format,
            depthWriteEnabled: true,
            depthCompare: 'less',
        },
    })
    const colorOnlyPipeline = await runtime.createRenderPipeline({
        program,
        targets: [ { format: colorTarget.format } ],
    })
    const draw = runtime.createDrawCommand({
        pipeline: depthPipeline,
        count: { vertexCount: 3 },
        resources: {
            read: [],
            write: [],
        },
        whenMissing: 'throw',
    })
    const colorOnlyDraw = runtime.createDrawCommand({
        pipeline: colorOnlyPipeline,
        count: { vertexCount: 3 },
        resources: {
            read: [],
            write: [],
        },
        whenMissing: 'throw',
    })
    const pass = runtime.createRenderPass({
        label: 'depth pass',
        color: [
            {
                target: colorTarget,
                load: 'clear',
                store: 'store',
                clear: [ 0, 0, 0, 1 ],
            },
        ],
        depth: {
            target: depthTarget,
            depthLoad: 'clear',
            depthStore: 'store',
            depthClear: 1,
        },
    })

    return { ...fake, runtime, colorTarget, depthTarget, program, depthPipeline, colorOnlyPipeline, draw, colorOnlyDraw, pass }
}

function createColorOnlyPass(runtime, colorTarget, label = 'color only pass') {

    return runtime.createRenderPass({
        label,
        color: [
            {
                target: colorTarget,
                load: 'clear',
                store: 'store',
                clear: [ 0, 0, 0, 1 ],
            },
        ],
    })
}

async function createColorTarget(runtime, label = 'secondary color') {

    return await runtime.createTexture({
        label,
        size: { width: 64, height: 64 },
        format: 'rgba8unorm',
        usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
    })
}

function readResource(resource, contentEpoch = resource.contentEpoch) {

    return { resource, contentEpoch }
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

describe('scratch depth/stencil render attachments', () => {

    it('accepts and lowers depth attachments into WebGPU render pass descriptors', async() => {

        const fixture = await createDepthFixture()

        expect(fixture.depthTarget).to.be.instanceOf(TextureResource)
        expect(fixture.pass.depth.target).to.equal(fixture.depthTarget)
        expect(fixture.pass.depth.depthLoad).to.equal('clear')
        expect(fixture.pass.depth.depthStore).to.equal('store')
        expect(fixture.pass.depth.depthClear).to.equal(1)

        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .render(fixture.pass, [ fixture.draw ])
            .submit()

        expect(fixture.calls.textureViews).to.have.length(2)
        expect(fixture.calls.textureViews[1].texture).to.equal(fixture.depthTarget.gpuTexture)
        expect(fixture.calls.renderPasses[0].descriptor.depthStencilAttachment).to.deep.equal({
            view: fixture.calls.textureViews[1],
            depthLoadOp: 'clear',
            depthStoreOp: 'store',
            depthClearValue: 1,
        })

        await submitted.done
    })

    it('reuses persistent color and depth attachments against replacement allocations', async() => {

        const fixture = await createDepthFixture()
        const pass = fixture.pass
        const draw = fixture.draw
        const previousColorTexture = fixture.colorTarget.gpuTexture
        const previousDepthTexture = fixture.depthTarget.gpuTexture
        const builder = fixture.runtime.createSubmission({ validation: 'throw' })
            .render(pass, [ draw ])

        await fixture.colorTarget.resize([ 32, 32, 3 ])
        await fixture.depthTarget.resize([ 32, 32, 3 ])
        const replacementColorTexture = fixture.colorTarget.gpuTexture
        const replacementDepthTexture = fixture.depthTarget.gpuTexture
        const submitted = builder.submit()

        expect(fixture.pass).to.equal(pass)
        expect(fixture.draw).to.equal(draw)
        expect(previousColorTexture.destroyed).to.equal(true)
        expect(previousDepthTexture.destroyed).to.equal(true)
        expect(fixture.calls.textureViews).to.have.length(2)
        expect(fixture.calls.textureViews[0].texture).to.equal(replacementColorTexture)
        expect(fixture.calls.textureViews[1].texture).to.equal(replacementDepthTexture)
        expect(fixture.calls.textureViews[0].descriptor).to.deep.equal({
            dimension: '2d',
            mipLevelCount: 1,
            arrayLayerCount: 1,
        })
        expect(fixture.calls.textureViews[1].descriptor).to.deep.equal({
            dimension: '2d',
            mipLevelCount: 1,
            arrayLayerCount: 1,
        })
        expect(fixture.calls.renderPasses[0].descriptor.colorAttachments[0].view)
            .to.equal(fixture.calls.textureViews[0])
        expect(fixture.calls.renderPasses[0].descriptor.depthStencilAttachment.view)
            .to.equal(fixture.calls.textureViews[1])
        expect(fixture.colorTarget.allocationVersion).to.equal(2)
        expect(fixture.depthTarget.allocationVersion).to.equal(2)
        expect(submitted.resourceAccesses.map(access => ({
            resourceId: access.resourceId,
            allocationVersion: access.allocationVersion,
        }))).to.deep.equal([
            { resourceId: fixture.colorTarget.id, allocationVersion: 2 },
            { resourceId: fixture.depthTarget.id, allocationVersion: 2 },
        ])

        await submitted.done
    })

    it('rejects mismatched current attachment extents before encoder creation', async() => {

        const fixture = await createDepthFixture()
        await fixture.colorTarget.resize([ 32, 32 ])

        await expectScratchDiagnostic(() => fixture.runtime.createSubmission({ validation: 'throw' })
            .render(fixture.pass, [ fixture.draw ])
            .submit(), {
            code: 'SCRATCH_RESOURCE_DESCRIPTOR_INVALID',
            severity: 'error',
            phase: 'resource',
        })

        expect(fixture.calls.commandEncoders).to.have.length(0)
        expect(fixture.calls.textureViews).to.have.length(0)
        expect(fixture.calls.queueSubmissions).to.have.length(0)
        expect(fixture.colorTarget.contentEpoch).to.equal(0)
        expect(fixture.depthTarget.contentEpoch).to.equal(0)
    })

    it('rejects mismatched current attachment sample counts before encoder creation', async() => {

        const fixture = await createDepthFixture()
        const multisampledDepth = await fixture.runtime.createTexture({
            label: 'multisampled scene depth',
            size: { width: 64, height: 64 },
            format: 'depth24plus',
            usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
            sampleCount: 4,
        })
        const pass = fixture.runtime.createRenderPass({
            color: [ {
                target: fixture.colorTarget,
                load: 'clear',
                store: 'store',
            } ],
            depth: {
                target: multisampledDepth,
                depthLoad: 'clear',
                depthStore: 'store',
                depthClear: 1,
            },
        })

        await expectScratchDiagnostic(() => fixture.runtime.createSubmission({ validation: 'throw' })
            .render(pass, [])
            .submit(), {
            code: 'SCRATCH_RESOURCE_DESCRIPTOR_INVALID',
            severity: 'error',
            phase: 'resource',
        })

        expect(fixture.calls.commandEncoders).to.have.length(0)
        expect(fixture.calls.textureViews).to.have.length(0)
        expect(fixture.calls.queueSubmissions).to.have.length(0)
        expect(fixture.colorTarget.contentEpoch).to.equal(0)
        expect(multisampledDepth.contentEpoch).to.equal(0)
    })

    it('lowers stencil fields for stencil-capable depth/stencil formats', async() => {

        const fixture = await createDepthFixture('depth24plus-stencil8')
        const pass = fixture.runtime.createRenderPass({
            color: [
                {
                    target: fixture.colorTarget,
                    load: 'clear',
                    store: 'store',
                },
            ],
            depth: {
                target: fixture.depthTarget,
                depthLoad: 'load',
                depthStore: 'store',
                stencilLoad: 'load',
                stencilStore: 'discard',
                stencilClear: 7,
            },
        })

        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .render(pass, [ fixture.draw ])
            .submit()

        expect(fixture.calls.renderPasses[0].descriptor.depthStencilAttachment).to.deep.equal({
            view: fixture.calls.textureViews[1],
            depthLoadOp: 'load',
            depthStoreOp: 'store',
            stencilLoadOp: 'load',
            stencilStoreOp: 'discard',
            stencilClearValue: 7,
        })

        await submitted.done
    })

    it('rejects invalid depth/stencil attachment targets with structured diagnostics', async() => {

        const fixtureA = await createDepthFixture()
        const fixtureB = await createDepthFixture()

        await expectScratchDiagnostic(() => fixtureA.runtime.createRenderPass({
            color: [ { target: fixtureA.colorTarget } ],
            depth: {},
        }), {
            code: 'SCRATCH_PASS_DEPTH_STENCIL_ATTACHMENT_INVALID',
            severity: 'error',
            phase: 'submission',
        })

        await expectScratchDiagnostic(() => fixtureA.runtime.createRenderPass({
            color: [ { target: fixtureA.colorTarget } ],
            depth: { target: fixtureB.depthTarget },
        }), {
            code: 'SCRATCH_RESOURCE_WRONG_RUNTIME',
            severity: 'error',
            phase: 'resource',
        })

        fixtureA.depthTarget.dispose()
        await expectScratchDiagnostic(() => fixtureA.runtime.createRenderPass({
            color: [ { target: fixtureA.colorTarget } ],
            depth: { target: fixtureA.depthTarget },
        }), {
            code: 'SCRATCH_RESOURCE_DISPOSED',
            severity: 'error',
            phase: 'resource',
        })

        const sampledOnlyDepth = await fixtureB.runtime.createTexture({
            size: { width: 16, height: 16 },
            format: 'depth24plus',
            usage: GPU_TEXTURE_USAGE_TEXTURE_BINDING,
        })
        await expectScratchDiagnostic(() => fixtureB.runtime.createRenderPass({
            color: [ { target: fixtureB.colorTarget } ],
            depth: { target: sampledOnlyDepth },
        }), {
            code: 'SCRATCH_RESOURCE_USAGE_MISSING',
            severity: 'error',
            phase: 'resource',
        })

        const colorTexture = await fixtureB.runtime.createTexture({
            size: { width: 16, height: 16 },
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
        })
        await expectScratchDiagnostic(() => fixtureB.runtime.createRenderPass({
            color: [ { target: fixtureB.colorTarget } ],
            depth: { target: colorTexture },
        }), {
            code: 'SCRATCH_PASS_DEPTH_STENCIL_ATTACHMENT_INVALID',
            severity: 'error',
            phase: 'submission',
        })
    })

    it('records depth attachment writes as pass-level submitted work without changing allocationVersion', async() => {

        const fixture = await createDepthFixture()
        const depthAllocationVersion = fixture.depthTarget.allocationVersion

        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .render(fixture.pass, [ fixture.draw ])
            .submit()

        expect(fixture.depthTarget.contentEpoch).to.equal(1)
        expect(fixture.depthTarget.state).to.equal('ready')
        expect(fixture.depthTarget.allocationVersion).to.equal(depthAllocationVersion)
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
            allocationVersion: access.allocationVersion,
        }))).to.deep.equal([
            {
                stepIndex: 0,
                stepKind: 'render',
                commandKind: undefined,
                commandId: undefined,
                passId: fixture.pass.id,
                resourceId: fixture.colorTarget.id,
                access: 'write',
                contentEpochBefore: 0,
                contentEpochAfter: 1,
                allocationVersion: 1,
            },
            {
                stepIndex: 0,
                stepKind: 'render',
                commandKind: undefined,
                commandId: undefined,
                passId: fixture.pass.id,
                resourceId: fixture.depthTarget.id,
                access: 'write',
                contentEpochBefore: 0,
                contentEpochAfter: 1,
                allocationVersion: 1,
            },
        ])
        expect(submitted.producerEpochs.map(epoch => epoch.resourceId)).to.deep.equal([
            fixture.colorTarget.id,
            fixture.depthTarget.id,
        ])

        await submitted.done
    })

    it('does not rebuild BindSet only because a depth attachment contentEpoch changes', async() => {

        const fixture = await createDepthFixture()
        const bindLayout = fixture.runtime.createBindLayout({
            group: 0,
            entries: [
                {
                    binding: 0,
                    name: 'depthTexture',
                    type: 'texture',
                    visibility: [ 'fragment' ],
                    sampleType: 'depth',
                },
            ],
        })
        const bindSet = fixture.runtime.createBindSet(bindLayout, {
            depthTexture: fixture.depthTarget,
        })
        const firstBindGroup = bindSet.getBindGroup()

        expect(bindSet).to.be.instanceOf(BindSet)
        expect(fixture.calls.bindGroups).to.have.length(1)

        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .render(fixture.pass, [ fixture.draw ])
            .submit()

        expect(fixture.depthTarget.contentEpoch).to.equal(1)
        expect(bindSet.getBindGroup()).to.equal(firstBindGroup)
        expect(fixture.calls.bindGroups).to.have.length(1)

        await submitted.done
    })

    it('rejects draw reads and writes of the current depth attachment before encoding', async() => {

        const fixture = await createDepthFixture()
        advanceResourceContentEpochForTest(fixture.depthTarget)
        const readDepth = fixture.runtime.createDrawCommand({
            pipeline: fixture.depthPipeline,
            count: { vertexCount: 3 },
            resources: {
                read: [ readResource(fixture.depthTarget) ],
                write: [],
            },
            whenMissing: 'throw',
        })
        const readBuilder = fixture.runtime.createSubmission({ validation: 'throw' })
            .render(fixture.pass, [ readDepth ])

        const readDiagnostic = await expectScratchDiagnostic(() => readBuilder.submit(), {
            code: 'SCRATCH_SUBMISSION_RESOURCE_ACCESS_CONFLICT',
            severity: 'error',
            phase: 'submission',
        })
        expect(readDiagnostic.actual).to.deep.include({
            stepIndex: 0,
            passId: fixture.pass.id,
            commandId: readDepth.id,
            commandKind: 'draw',
            access: 'read',
            attachmentKind: 'depth-stencil',
            resourceId: fixture.depthTarget.id,
            resourceKind: 'TextureResource',
            contentEpoch: 1,
            allocationVersion: 1,
        })
        expect(fixture.calls.commandEncoders).to.have.length(0)
        expect(fixture.calls.renderPasses).to.have.length(0)
        expect(fixture.calls.queueSubmissions).to.have.length(0)

        const writeDepth = fixture.runtime.createDrawCommand({
            pipeline: fixture.depthPipeline,
            count: { vertexCount: 3 },
            resources: {
                read: [],
                write: [ fixture.depthTarget ],
            },
            whenMissing: 'throw',
        })
        const writeBuilder = fixture.runtime.createSubmission({ validation: 'throw' })
            .render(fixture.pass, [ writeDepth ])

        const writeDiagnostic = await expectScratchDiagnostic(() => writeBuilder.submit(), {
            code: 'SCRATCH_SUBMISSION_RESOURCE_ACCESS_CONFLICT',
            severity: 'error',
            phase: 'submission',
        })
        expect(writeDiagnostic.actual).to.deep.include({
            stepIndex: 0,
            passId: fixture.pass.id,
            commandId: writeDepth.id,
            commandKind: 'draw',
            access: 'write',
            attachmentKind: 'depth-stencil',
            resourceId: fixture.depthTarget.id,
            resourceKind: 'TextureResource',
        })
    })

    it('applies validation disposition to depth attachment conflicts', async() => {

        const warnFixture = await createDepthFixture()
        advanceResourceContentEpochForTest(warnFixture.depthTarget)
        const warnConflict = warnFixture.runtime.createDrawCommand({
            pipeline: warnFixture.depthPipeline,
            count: { vertexCount: 3 },
            resources: {
                read: [ readResource(warnFixture.depthTarget) ],
                write: [],
            },
            whenMissing: 'throw',
        })

        const warned = warnFixture.runtime.createSubmission({ validation: 'warn' })
            .render(warnFixture.pass, [ warnConflict ])
            .submit()

        expect(warned.diagnostics).to.have.length(1)
        expect(warned.diagnostics[0]).to.include({
            code: 'SCRATCH_SUBMISSION_RESOURCE_ACCESS_CONFLICT',
            severity: 'error',
            phase: 'submission',
        })
        expect(warned.diagnostics[0].actual).to.deep.include({
            attachmentKind: 'depth-stencil',
            access: 'read',
            resourceId: warnFixture.depthTarget.id,
        })
        expect(warnFixture.calls.renderPasses).to.have.length(1)
        expect(warnFixture.calls.queueSubmissions).to.have.length(1)
        await warned.done

        const offFixture = await createDepthFixture()
        advanceResourceContentEpochForTest(offFixture.depthTarget)
        const offConflict = offFixture.runtime.createDrawCommand({
            pipeline: offFixture.depthPipeline,
            count: { vertexCount: 3 },
            resources: {
                read: [ readResource(offFixture.depthTarget) ],
                write: [],
            },
            whenMissing: 'throw',
        })
        const submitted = offFixture.runtime.createSubmission({ validation: 'off' })
            .render(offFixture.pass, [ offConflict ])
            .submit()

        expect(submitted.diagnostics).to.deep.equal([])
        expect(offFixture.calls.renderPasses).to.have.length(1)
        expect(offFixture.calls.queueSubmissions).to.have.length(1)
        await submitted.done
    })

    it('allows later render steps to read depth textures produced by earlier render steps', async() => {

        const fixture = await createDepthFixture()
        const secondColor = await createColorTarget(fixture.runtime)
        const secondPass = createColorOnlyPass(fixture.runtime, secondColor, 'sample depth pass')
        const sampleDepth = fixture.runtime.createDrawCommand({
            pipeline: fixture.colorOnlyPipeline,
            count: { vertexCount: 3 },
            resources: {
                read: [ readResource(fixture.depthTarget, 1) ],
                write: [],
            },
            whenMissing: 'throw',
        })

        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .render(fixture.pass, [ fixture.draw ])
            .render(secondPass, [ sampleDepth ])
            .submit()

        expect(fixture.depthTarget.contentEpoch).to.equal(1)
        expect(secondColor.contentEpoch).to.equal(1)
        expect(submitted.resourceAccesses.map(access => ({
            stepIndex: access.stepIndex,
            stepKind: access.stepKind,
            commandKind: access.commandKind,
            resourceId: access.resourceId,
            access: access.access,
            contentEpochBefore: access.contentEpochBefore,
            contentEpochAfter: access.contentEpochAfter,
        }))).to.deep.equal([
            { stepIndex: 0, stepKind: 'render', commandKind: undefined, resourceId: fixture.colorTarget.id, access: 'write', contentEpochBefore: 0, contentEpochAfter: 1 },
            { stepIndex: 0, stepKind: 'render', commandKind: undefined, resourceId: fixture.depthTarget.id, access: 'write', contentEpochBefore: 0, contentEpochAfter: 1 },
            { stepIndex: 1, stepKind: 'render', commandKind: 'draw', resourceId: fixture.depthTarget.id, access: 'read', contentEpochBefore: 1, contentEpochAfter: 1 },
            { stepIndex: 1, stepKind: 'render', commandKind: undefined, resourceId: secondColor.id, access: 'write', contentEpochBefore: 0, contentEpochAfter: 1 },
        ])

        await submitted.done
    })

    it('uses existing epoch diagnostics for future and stale depth reads', async() => {

        const futureFixture = await createDepthFixture()
        advanceResourceContentEpochForTest(futureFixture.depthTarget)
        const futureRead = futureFixture.runtime.createDrawCommand({
            pipeline: futureFixture.colorOnlyPipeline,
            count: { vertexCount: 3 },
            resources: {
                read: [ readResource(futureFixture.depthTarget, 2) ],
                write: [],
            },
            whenMissing: 'throw',
        })
        const futurePass = createColorOnlyPass(futureFixture.runtime, await createColorTarget(futureFixture.runtime, 'future color'), 'future read pass')
        const futureDiagnostic = await expectScratchDiagnostic(() => futureFixture.runtime.createSubmission({ validation: 'throw' })
            .render(futurePass, [ futureRead ])
            .submit(), {
            code: 'SCRATCH_SUBMISSION_READ_BEFORE_WRITE',
            severity: 'error',
            phase: 'submission',
        })
        expect(futureDiagnostic.actual).to.deep.include({
            resourceId: futureFixture.depthTarget.id,
            requiredContentEpoch: 2,
            simulatedContentEpoch: 1,
        })

        const staleFixture = await createDepthFixture()
        advanceResourceContentEpochForTest(staleFixture.depthTarget)
        const staleRead = staleFixture.runtime.createDrawCommand({
            pipeline: staleFixture.colorOnlyPipeline,
            count: { vertexCount: 3 },
            resources: {
                read: [ readResource(staleFixture.depthTarget, 1) ],
                write: [],
            },
            whenMissing: 'throw',
        })
        const stalePass = createColorOnlyPass(staleFixture.runtime, await createColorTarget(staleFixture.runtime, 'stale color'), 'stale read pass')
        const staleDiagnostic = await expectScratchDiagnostic(() => staleFixture.runtime.createSubmission({ validation: 'throw' })
            .render(staleFixture.pass, [ staleFixture.draw ])
            .render(stalePass, [ staleRead ])
            .submit(), {
            code: 'SCRATCH_SUBMISSION_STALE_READ',
            severity: 'error',
            phase: 'submission',
        })
        expect(staleDiagnostic.actual).to.deep.include({
            resourceId: staleFixture.depthTarget.id,
            requiredContentEpoch: 1,
            simulatedContentEpoch: 2,
        })
    })

    it('validates pipeline depth/stencil compatibility against the active render pass', async() => {

        const fixture = await createDepthFixture()
        const noDepthPass = createColorOnlyPass(fixture.runtime, fixture.colorTarget, 'missing depth pass')

        const missingDiagnostic = await expectScratchDiagnostic(() => fixture.runtime.createSubmission({ validation: 'throw' })
            .render(noDepthPass, [ fixture.draw ])
            .submit(), {
            code: 'SCRATCH_PIPELINE_DEPTH_STENCIL_MISMATCH',
            severity: 'error',
            phase: 'pipeline',
        })
        expect(missingDiagnostic.expected).to.deep.equal({ depthStencilAttachment: 'RenderPassSpec.depth with matching format' })
        expect(missingDiagnostic.actual).to.deep.include({
            pipelineDepthStencilFormat: fixture.depthTarget.format,
            passDepthStencilFormat: undefined,
        })

        const mismatchPipeline = await fixture.runtime.createRenderPipeline({
            program: fixture.program,
            targets: [ { format: fixture.colorTarget.format } ],
            depthStencil: {
                format: 'depth32float',
                depthWriteEnabled: true,
                depthCompare: 'less',
            },
        })
        const mismatchDraw = fixture.runtime.createDrawCommand({
            pipeline: mismatchPipeline,
            count: { vertexCount: 3 },
            resources: {
                read: [],
                write: [],
            },
            whenMissing: 'throw',
        })
        const mismatchDiagnostic = await expectScratchDiagnostic(() => fixture.runtime.createSubmission({ validation: 'throw' })
            .render(fixture.pass, [ mismatchDraw ])
            .submit(), {
            code: 'SCRATCH_PIPELINE_DEPTH_STENCIL_MISMATCH',
            severity: 'error',
            phase: 'pipeline',
        })
        expect(mismatchDiagnostic.expected).to.deep.equal({ format: fixture.depthTarget.format })
        expect(mismatchDiagnostic.actual).to.deep.include({ format: 'depth32float' })
    })
})
