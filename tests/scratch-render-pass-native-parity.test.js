import { createTestProgram } from './scratch-test-utils.js'
import { expect } from 'chai'
import {
    ScratchDiagnosticError,
    ScratchRuntime,
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

async function createRenderProgram(runtime) {

    return await createTestProgram(runtime, {
        sourceParts: [ triangleWgsl ],
        vertex: 'vsMain',
        fragment: 'fsMain',
    })
}

function readResource(resource, contentEpoch = resource.contentEpoch) {

    return { resource, contentEpoch }
}

async function createResolvePass(runtime, format) {

    const source = await runtime.createTexture({
        size: [ 8, 8 ],
        sampleCount: 4,
        format,
        usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
    })
    const target = await runtime.createTexture({
        size: [ 8, 8 ],
        format,
        usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
    })
    return runtime.createRenderPass({
        color: [ {
            target: source.view(),
            resolveTarget: target.view(),
        } ],
    })
}

describe('scratch render/pass native parity', () => {

    it('preserves nullable color slots and lowers maxDrawCount without resource effects', async() => {

        const fake = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const target = await runtime.createTexture({
            size: [ 32, 32 ],
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
        })
        const program = await createRenderProgram(runtime)
        const pipeline = await runtime.createRenderPipeline({
            program,
            targets: [ null, { format: 'rgba8unorm' } ],
        })
        const draw = runtime.createDrawCommand({
            pipeline,
            count: { vertexCount: 3 },
            resources: { read: [], write: [] },
            whenMissing: 'throw',
        })
        const pass = runtime.createRenderPass({
            color: [ null, {
                target: target.view(),
                load: 'clear',
                store: 'store',
            } ],
            maxDrawCount: 7,
        })

        const submitted = runtime.submission().render(pass, [ draw ]).submit()

        expect(pass.maxDrawCount).to.equal(7)
        expect(Object.isExtensible(pass)).to.equal(false)
        expect(fake.calls.textureViews).to.have.length(1)
        expect(fake.calls.renderPasses[0].descriptor).to.deep.include({
            maxDrawCount: 7,
        })
        expect(fake.calls.renderPasses[0].descriptor.colorAttachments[0]).to.equal(null)
        expect(fake.calls.renderPasses[0].descriptor.colorAttachments[1].view)
            .to.equal(fake.calls.textureViews[0])
        expect(target.contentEpoch).to.equal(1)
        expect(submitted.resourceAccesses.map(access => access.resourceId)).to.deep.equal([
            target.id,
        ])

        await submitted.done
    })

    it('rejects color holes, undefined slots, null-only passes, and invalid maxDrawCount', async() => {

        const fake = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const target = await runtime.createTexture({
            size: [ 8, 8 ],
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
        })
        const sparse = new Array(2)
        sparse[1] = { target: target.view() }
        const inheritedHole = new Array(2)
        inheritedHole[1] = { target: target.view() }
        const inheritedIndex = Object.create(Array.prototype)
        Object.defineProperty(inheritedIndex, 0, { value: null })
        Object.setPrototypeOf(inheritedHole, inheritedIndex)

        for (const color of [
            sparse,
            inheritedHole,
            [ undefined ],
        ]) {
            const diagnostic = await expectScratchDiagnostic(() => runtime.createRenderPass({
                color,
            }), {
                code: 'SCRATCH_PASS_COLOR_ATTACHMENT_INVALID',
                severity: 'error',
                phase: 'submission',
            })
            expect(diagnostic.actual.reason).to.be.oneOf([ 'hole', 'undefined' ])
        }

        await expectScratchDiagnostic(() => runtime.createRenderPass({
            color: [ null ],
        }), {
            code: 'SCRATCH_SUBMISSION_PASS_COMMAND_INCOMPATIBLE',
            severity: 'error',
            phase: 'submission',
        })

        for (const maxDrawCount of [
            -1,
            0.5,
            Number.NaN,
            Number.POSITIVE_INFINITY,
            Number.MAX_SAFE_INTEGER + 1,
        ]) {
            await expectScratchDiagnostic(() => runtime.createRenderPass({
                color: [ { target: target.view() } ],
                maxDrawCount,
            }), {
                code: 'SCRATCH_PASS_MAX_DRAW_COUNT_INVALID',
                severity: 'error',
                phase: 'submission',
            })
        }
    })

    it('lowers multisample resolve and records retained and discarded content facts', async() => {

        const fake = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const source = await runtime.createTexture({
            label: 'multisampled source',
            size: [ 32, 32 ],
            sampleCount: 4,
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
        })
        const resolved = await runtime.createTexture({
            label: 'resolved target',
            size: [ 32, 32 ],
            format: 'rgba8unorm',
            usage:
                GPU_TEXTURE_USAGE_RENDER_ATTACHMENT |
                GPU_TEXTURE_USAGE_TEXTURE_BINDING,
        })
        const program = await createRenderProgram(runtime)
        const pipeline = await runtime.createRenderPipeline({
            program,
            targets: [ { format: 'rgba8unorm' } ],
            multisample: { count: 4 },
        })
        const draw = runtime.createDrawCommand({
            pipeline,
            count: { vertexCount: 3 },
            resources: { read: [], write: [] },
            whenMissing: 'throw',
        })
        const pass = runtime.createRenderPass({
            color: [ {
                target: source.view(),
                resolveTarget: resolved.view(),
                load: 'clear',
                store: 'discard',
            } ],
        })

        const submitted = runtime.submission().render(pass, [ draw ]).submit()
        const native = fake.calls.renderPasses[0].descriptor.colorAttachments[0]

        expect(fake.calls.textureViews).to.have.length(2)
        expect(native.view).to.equal(fake.calls.textureViews[0])
        expect(native.resolveTarget).to.equal(fake.calls.textureViews[1])
        expect(source.contentEpoch).to.equal(1)
        expect(source.state).to.equal('indeterminate')
        expect(resolved.contentEpoch).to.equal(1)
        expect(resolved.state).to.equal('ready')
        expect(submitted.resourceAccesses.map(access => ({
            resourceId: access.resourceId,
            access: access.access,
            before: access.contentEpochBefore,
            after: access.contentEpochAfter,
        }))).to.deep.equal([
            { resourceId: source.id, access: 'write', before: 0, after: 1 },
            { resourceId: resolved.id, access: 'write', before: 0, after: 1 },
        ])

        await submitted.done
    })

    it('prepares and observes a Surface used as a resolve target', async() => {

        const fake = createFakeGpu()
        const canvas = createFakeCanvas()
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const source = await runtime.createTexture({
            size: [ 24, 16 ],
            sampleCount: 4,
            format: 'bgra8unorm',
            usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
        })
        const surface = runtime.createSurface(canvas.canvas, {
            format: 'bgra8unorm',
            size: { width: 24, height: 16 },
        })
        const pass = runtime.createRenderPass({
            color: [ {
                target: source.view(),
                resolveTarget: surface,
                load: 'clear',
                store: 'discard',
            } ],
        })

        const submitted = runtime.submission().render(pass, []).submit()
        const native = fake.calls.renderPasses[0].descriptor.colorAttachments[0]

        expect(canvas.context.currentTextureCalls).to.equal(1)
        expect(canvas.textureViews).to.have.length(1)
        expect(native.resolveTarget).to.equal(canvas.textureViews[0])
        expect(source.contentEpoch).to.equal(1)
        expect(source.state).to.equal('indeterminate')
        expect(submitted.resourceAccesses.map(access => access.resourceId)).to.deep.equal([
            source.id,
        ])

        await submitted.done
    })

    it('rejects invalid resolve pairs and revalidates replacement allocation extents', async() => {

        const fake = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const source = await runtime.createTexture({
            size: [ 16, 16 ],
            sampleCount: 4,
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
        })
        const target = await runtime.createTexture({
            size: [ 16, 16 ],
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
        })
        const singleSampledSource = await runtime.createTexture({
            size: [ 16, 16 ],
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
        })
        const multisampledTarget = await runtime.createTexture({
            size: [ 16, 16 ],
            sampleCount: 4,
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
        })
        const transientTarget = await runtime.createTexture({
            size: [ 16, 16 ],
            format: 'rgba8unorm',
            usage:
                GPU_TEXTURE_USAGE_RENDER_ATTACHMENT |
                GPU_TEXTURE_USAGE_TRANSIENT_ATTACHMENT,
        })
        const missingUsageTarget = await runtime.createTexture({
            size: [ 16, 16 ],
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_TEXTURE_BINDING,
        })
        const unsupportedResolveSource = await runtime.createTexture({
            size: [ 16, 16 ],
            sampleCount: 4,
            format: 'r32float',
            usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
        })
        const unsupportedResolveTarget = await runtime.createTexture({
            size: [ 16, 16 ],
            format: 'r32float',
            usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
        })

        for (const attachment of [
            {
                target: singleSampledSource.view(),
                resolveTarget: target.view(),
            },
            {
                target: source.view(),
                resolveTarget: multisampledTarget.view(),
            },
            {
                target: source.view(),
                resolveTarget: transientTarget.view(),
            },
            {
                target: source.view(),
                resolveTarget: source.view(),
            },
            {
                target: source.view(),
                resolveTarget: missingUsageTarget.view(),
            },
            {
                target: unsupportedResolveSource.view(),
                resolveTarget: unsupportedResolveTarget.view(),
            },
        ]) {
            await expectScratchDiagnostic(() => runtime.createRenderPass({
                color: [ attachment ],
            }), {
                code: 'SCRATCH_PASS_RESOLVE_ATTACHMENT_INVALID',
                severity: 'error',
                phase: 'submission',
            })
        }

        const pass = runtime.createRenderPass({
            color: [ {
                target: source.view(),
                resolveTarget: target.view(),
            } ],
        })
        await target.resize([ 8, 8 ])

        await expectScratchDiagnostic(() => runtime.submission()
            .render(pass, [])
            .submit(), {
            code: 'SCRATCH_PASS_RESOLVE_ATTACHMENT_INVALID',
            severity: 'error',
            phase: 'submission',
        })
        expect(fake.calls.commandEncoders).to.have.length(0)
        expect(fake.calls.textureViews).to.have.length(0)
    })

    it('matches resolve-capable formats and feature requirements from the fixed CRD', async() => {

        const tierFake = createFakeGpu()
        tierFake.device.features.add('texture-formats-tier1')
        const tierRuntime = await ScratchRuntime.create({ gpu: tierFake.gpu })

        for (const format of [
            'r8snorm',
            'rg8snorm',
            'rgba8snorm',
            'rg11b10ufloat',
        ]) {
            const pass = await createResolvePass(tierRuntime, format)
            expect(pass.color[0].format).to.equal(format)
        }

        for (const format of [ 'r16unorm', 'rgba16float' ]) {
            await expectScratchDiagnostic(() => createResolvePass(tierRuntime, format), {
                code: 'SCRATCH_PASS_RESOLVE_ATTACHMENT_INVALID',
                severity: 'error',
                phase: 'submission',
            })
        }

        const coreFake = createFakeGpu()
        coreFake.device.features.add('core-features-and-limits')
        const coreRuntime = await ScratchRuntime.create({ gpu: coreFake.gpu })
        const corePass = await createResolvePass(coreRuntime, 'rgba16float')
        expect(corePass.color[0].format).to.equal('rgba16float')
    })

    it('compares complete render layouts while ignoring only trailing null color slots', async() => {

        const fake = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const target = await runtime.createTexture({
            size: [ 16, 16 ],
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
        })
        const program = await createRenderProgram(runtime)
        const pipelineWithTrailingNull = await runtime.createRenderPipeline({
            program,
            targets: [ { format: 'rgba8unorm' }, null ],
        })
        const pipelineWithoutTrailingNull = await runtime.createRenderPipeline({
            program,
            targets: [ { format: 'rgba8unorm' } ],
        })
        const drawWithTrailingNull = runtime.createDrawCommand({
            pipeline: pipelineWithTrailingNull,
            count: { vertexCount: 3 },
            resources: { read: [], write: [] },
            whenMissing: 'throw',
        })
        const drawWithoutTrailingNull = runtime.createDrawCommand({
            pipeline: pipelineWithoutTrailingNull,
            count: { vertexCount: 3 },
            resources: { read: [], write: [] },
            whenMissing: 'throw',
        })
        const compactPass = runtime.createRenderPass({
            color: [ { target: target.view() } ],
        })
        const passWithTrailingNull = runtime.createRenderPass({
            color: [ { target: target.view() }, null ],
        })

        const first = runtime.submission()
            .render(compactPass, [ drawWithTrailingNull ])
            .submit()
        const second = runtime.submission()
            .render(passWithTrailingNull, [ drawWithoutTrailingNull ])
            .submit()

        expect(fake.calls.drawCalls).to.have.length(2)
        expect(first.diagnostics).to.deep.equal([])
        expect(second.diagnostics).to.deep.equal([])
        await Promise.all([ first.done, second.done ])
    })

    it('rejects render layout sample-count and depth-format absence before encoding', async() => {

        const fake = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const color = await runtime.createTexture({
            size: [ 16, 16 ],
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
        })
        const multisampledColor = await runtime.createTexture({
            size: [ 16, 16 ],
            sampleCount: 4,
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
        })
        const depth = await runtime.createTexture({
            size: [ 16, 16 ],
            format: 'depth24plus',
            usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
        })
        const program = await createRenderProgram(runtime)
        const pipeline = await runtime.createRenderPipeline({
            program,
            targets: [ { format: 'rgba8unorm' } ],
        })
        const draw = runtime.createDrawCommand({
            pipeline,
            count: { vertexCount: 3 },
            resources: { read: [], write: [] },
            whenMissing: 'throw',
        })

        await expectScratchDiagnostic(() => runtime.submission()
            .render(runtime.createRenderPass({
                color: [ { target: multisampledColor.view() } ],
            }), [ draw ])
            .submit(), {
            code: 'SCRATCH_PIPELINE_SAMPLE_COUNT_MISMATCH',
            severity: 'error',
            phase: 'pipeline',
        })
        await expectScratchDiagnostic(() => runtime.submission()
            .render(runtime.createRenderPass({
                color: [ { target: color.view() } ],
                depth: { target: depth.view() },
            }), [ draw ])
            .submit(), {
            code: 'SCRATCH_PIPELINE_DEPTH_STENCIL_MISMATCH',
            severity: 'error',
            phase: 'pipeline',
        })

        expect(fake.calls.commandEncoders).to.have.length(0)
        expect(fake.calls.textureViews).to.have.length(0)
    })

    it('rejects clear values on read-only depth and stencil aspects', async() => {

        const fake = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const depth = await runtime.createTexture({
            size: [ 16, 16 ],
            format: 'depth24plus',
            usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
        })
        const stencil = await runtime.createTexture({
            size: [ 16, 16 ],
            format: 'stencil8',
            usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
        })

        for (const attachment of [
            {
                target: depth.view(),
                depthReadOnly: true,
                depthClear: 0.25,
            },
            {
                target: stencil.view(),
                stencilReadOnly: true,
                stencilClear: 3,
            },
        ]) {
            await expectScratchDiagnostic(() => runtime.createRenderPass({
                color: [],
                depth: attachment,
            }), {
                code: 'SCRATCH_PASS_DEPTH_STENCIL_ATTACHMENT_INVALID',
                severity: 'error',
                phase: 'submission',
            })
        }
    })

    it('lowers read-only depth as a pass read without advancing its content epoch', async() => {

        const fake = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const color = await runtime.createTexture({
            size: [ 32, 32 ],
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
        })
        const depth = await runtime.createTexture({
            size: [ 32, 32 ],
            format: 'depth24plus',
            usage:
                GPU_TEXTURE_USAGE_RENDER_ATTACHMENT |
                GPU_TEXTURE_USAGE_TEXTURE_BINDING,
        })
        advanceResourceContentEpochForTest(depth)
        const program = await createRenderProgram(runtime)
        const pipeline = await runtime.createRenderPipeline({
            program,
            targets: [ { format: 'rgba8unorm' } ],
            depthStencil: {
                format: 'depth24plus',
                depthWriteEnabled: false,
                depthCompare: 'less',
            },
        })
        const draw = runtime.createDrawCommand({
            pipeline,
            count: { vertexCount: 3 },
            resources: {
                read: [ readResource(depth) ],
                write: [],
            },
            whenMissing: 'throw',
        })
        const pass = runtime.createRenderPass({
            color: [ { target: color.view() } ],
            depth: {
                target: depth.view(),
                depthReadOnly: true,
            },
        })

        const submitted = runtime.submission().render(pass, [ draw ]).submit()

        expect(fake.calls.renderPasses[0].descriptor.depthStencilAttachment).to.deep.equal({
            view: fake.calls.textureViews[1],
            depthReadOnly: true,
        })
        expect(depth.contentEpoch).to.equal(1)
        expect(submitted.resourceAccesses.filter(access => access.resourceId === depth.id)
            .map(access => access.access)).to.deep.equal([ 'read', 'read' ])
        expect(submitted.producerEpochs.map(epoch => epoch.resourceId)).to.deep.equal([
            color.id,
        ])

        await submitted.done
    })

    it('requires initialized read-only content and rejects a depth-writing pipeline', async() => {

        const fake = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const depth = await runtime.createTexture({
            size: [ 16, 16 ],
            format: 'depth24plus',
            usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
        })
        const pass = runtime.createRenderPass({
            color: [],
            depth: {
                target: depth.view(),
                depthReadOnly: true,
            },
        })

        await expectScratchDiagnostic(() => runtime.submission()
            .render(pass, [])
            .submit(), {
            code: 'SCRATCH_COMMAND_RESOURCE_NOT_READY',
            severity: 'error',
            phase: 'submission',
        })

        advanceResourceContentEpochForTest(depth)
        const program = await createRenderProgram(runtime)
        const pipeline = await runtime.createRenderPipeline({
            program,
            targets: [],
            depthStencil: {
                format: 'depth24plus',
                depthWriteEnabled: true,
                depthCompare: 'less',
            },
        })
        const draw = runtime.createDrawCommand({
            pipeline,
            count: { vertexCount: 3 },
            resources: { read: [], write: [] },
            whenMissing: 'throw',
        })

        await expectScratchDiagnostic(() => runtime.submission()
            .render(pass, [ draw ])
            .submit(), {
            code: 'SCRATCH_PIPELINE_DEPTH_STENCIL_MISMATCH',
            severity: 'error',
            phase: 'pipeline',
        })
    })

    it('keeps a stencil-only read-only attachment ready without a write epoch', async() => {

        const fake = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const stencil = await runtime.createTexture({
            size: [ 16, 16 ],
            format: 'stencil8',
            usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
        })
        advanceResourceContentEpochForTest(stencil)
        const pass = runtime.createRenderPass({
            color: [],
            depth: {
                target: stencil.view(),
                stencilReadOnly: true,
            },
        })

        const submitted = runtime.submission().render(pass, []).submit()

        expect(fake.calls.renderPasses[0].descriptor.depthStencilAttachment).to.deep.equal({
            view: fake.calls.textureViews[0],
            stencilReadOnly: true,
        })
        expect(stencil.contentEpoch).to.equal(1)
        expect(submitted.resourceAccesses.filter(access =>
            access.resourceId === stencil.id
        ).map(access => access.access)).to.deep.equal([ 'read' ])
        expect(submitted.producerEpochs.filter(epoch => epoch.resourceId === stencil.id))
            .to.deep.equal([])

        await submitted.done
    })

    it('allows depth-only sampling while a disjoint stencil aspect remains writable', async() => {

        const fake = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const color = await runtime.createTexture({
            size: [ 16, 16 ],
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
        })
        const depthStencil = await runtime.createTexture({
            size: [ 16, 16 ],
            format: 'depth24plus-stencil8',
            usage:
                GPU_TEXTURE_USAGE_RENDER_ATTACHMENT |
                GPU_TEXTURE_USAGE_TEXTURE_BINDING,
        })
        advanceResourceContentEpochForTest(depthStencil)
        const bindLayout = await runtime.createBindLayout({
            group: 0,
            entries: [ {
                binding: 0,
                name: 'depthTexture',
                type: 'texture',
                visibility: [ 'fragment' ],
                sampleType: 'depth',
            } ],
        })
        const bindSet = await runtime.createBindSet(bindLayout, {
            depthTexture: depthStencil.view({ aspect: 'depth-only' }),
        })
        const program = await createTestProgram(runtime, {
            sourceParts: [ `
            @group(0) @binding(0) var depthTexture: texture_depth_2d;

            @vertex
            fn vsMain(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4f {
            var positions = array<vec2f, 3>(
            vec2f(0.0, 0.5),
            vec2f(-0.5, -0.5),
            vec2f(0.5, -0.5)
            );
            return vec4f(positions[vertexIndex], 0.0, 1.0);
            }

            @fragment
            fn fsMain() -> @location(0) vec4f {
            let depth = textureLoad(depthTexture, vec2i(0, 0), 0);
            return vec4f(depth, depth, depth, 1.0);
            }
            ` ],
            vertex: 'vsMain',
            fragment: 'fsMain',
        })
        const pipeline = await runtime.createRenderPipeline({
            program,
            layout: { mode: 'explicit', bindLayouts: [ bindLayout ] },
            targets: [ { format: 'rgba8unorm' } ],
            depthStencil: {
                format: 'depth24plus-stencil8',
                depthWriteEnabled: false,
                depthCompare: 'less',
                stencilWriteMask: 0,
            },
        })
        const draw = runtime.createDrawCommand({
            pipeline,
            bindSets: [ { set: bindSet } ],
            count: { vertexCount: 3 },
            resources: {
                read: [ readResource(depthStencil) ],
                write: [],
            },
            whenMissing: 'throw',
        })
        const pass = runtime.createRenderPass({
            color: [ { target: color.view() } ],
            depth: {
                target: depthStencil.view(),
                depthReadOnly: true,
                stencilLoad: 'clear',
                stencilStore: 'store',
            },
        })

        const submitted = runtime.submission().render(pass, [ draw ]).submit()

        expect(submitted.diagnostics).to.deep.equal([])
        expect(depthStencil.contentEpoch).to.equal(2)
        expect(submitted.resourceAccesses.filter(access =>
            access.resourceId === depthStencil.id
        ).map(access => access.access)).to.deep.equal([
            'read',
            'read',
            'write',
        ])

        await submitted.done
    })

    it('advances a mixed read-only/writable depth-stencil attachment only once', async() => {

        const fake = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const depthStencil = await runtime.createTexture({
            size: [ 16, 16 ],
            format: 'depth24plus-stencil8',
            usage:
                GPU_TEXTURE_USAGE_RENDER_ATTACHMENT |
                GPU_TEXTURE_USAGE_TEXTURE_BINDING,
        })
        advanceResourceContentEpochForTest(depthStencil)
        const pass = runtime.createRenderPass({
            color: [],
            depth: {
                target: depthStencil.view(),
                depthReadOnly: true,
                stencilLoad: 'clear',
                stencilStore: 'store',
                stencilClear: 3,
            },
        })

        const submitted = runtime.submission().render(pass, []).submit()

        expect(fake.calls.renderPasses[0].descriptor.depthStencilAttachment).to.deep.equal({
            view: fake.calls.textureViews[0],
            depthReadOnly: true,
            stencilLoadOp: 'clear',
            stencilStoreOp: 'store',
            stencilClearValue: 3,
        })
        expect(depthStencil.contentEpoch).to.equal(2)
        expect(submitted.resourceAccesses.filter(access => access.resourceId === depthStencil.id)
            .map(access => access.access)).to.deep.equal([ 'read', 'write' ])
        expect(submitted.producerEpochs.filter(epoch => epoch.resourceId === depthStencil.id))
            .to.have.length(1)

        await submitted.done
    })
})
