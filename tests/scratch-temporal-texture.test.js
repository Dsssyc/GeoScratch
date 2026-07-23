import { createTestProgram } from './scratch-test-utils.js'
import { expect } from 'chai'
import {
    ExternalTextureBinding,
    ScratchDiagnosticError,
    ScratchRuntime,
    SurfaceTextureLease,
    SurfaceTextureView,
} from 'geoscratch'
import {
    createFakeCanvas,
    createFakeExternalImageSource,
    createFakeGpu,
    triangleWgsl,
} from './scratch-test-utils.js'

const GPU_TEXTURE_USAGE_COPY_SRC = 0x1
const GPU_TEXTURE_USAGE_COPY_DST = 0x2
const GPU_TEXTURE_USAGE_TEXTURE_BINDING = 0x4
const GPU_TEXTURE_USAGE_STORAGE_BINDING = 0x8
const GPU_TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10
const GPU_BUFFER_USAGE_COPY_SRC = 0x4
const GPU_BUFFER_USAGE_COPY_DST = 0x8

const externalTextureWgsl = `
@group(0) @binding(0)
var video: texture_external;

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
    return textureLoad(video, vec2u(0, 0));
}
`

const sampledTextureComputeWgsl = `
@group(0) @binding(0)
var current: texture_2d<f32>;

@compute @workgroup_size(1)
fn main() {
    _ = textureDimensions(current);
}
`

const storageTextureComputeWgsl = `
@group(0) @binding(0)
var current: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(1)
fn main() {
    textureStore(current, vec2u(0, 0), vec4f(1.0, 0.0, 0.0, 1.0));
}
`

async function createRenderPipeline(runtime, format, bindLayouts = [], source = triangleWgsl) {

    const program = await createTestProgram(runtime, {
        sourceParts: [ source ],
        vertex: 'vsMain',
        fragment: 'fsMain',
    })
    return await runtime.createRenderPipeline({
        program,
        layout: { mode: 'explicit', bindLayouts },
        targets: [ { format } ],
    })
}

function emptyResources() {

    return { read: [], write: [] }
}

describe('Scratch attempt-local texture authority', () => {

    it('reimports an external texture once per selected submission without preparing per frame', async() => {

        const fixture = createFakeGpu()
        const canvas = createFakeCanvas()
        const runtime = await ScratchRuntime.create({ gpu: fixture.gpu })
        const surface = runtime.createSurface(canvas.canvas, {
            format: 'bgra8unorm',
            size: { width: 8, height: 8 },
        })
        const source = createFakeExternalImageSource('HTMLVideoElement', {
            width: 8,
            height: 8,
        })
        const external = runtime.externalTexture({
            label: 'video frame',
            source,
            colorSpace: 'display-p3',
        })
        const layout = await runtime.createBindLayout({
            group: 0,
            entries: [ {
                binding: 0,
                name: 'video',
                type: 'external-texture',
                visibility: [ 'fragment' ],
            } ],
        })
        const bindSet = await runtime.createBindSet(layout, { video: external })
        const pipeline = await createRenderPipeline(
            runtime,
            surface.format,
            [ layout ],
            externalTextureWgsl
        )
        const draw = runtime.createDrawCommand({
            pipeline,
            bindSets: [ { set: bindSet } ],
            count: { vertexCount: 3 },
            resources: emptyResources(),
            whenMissing: 'throw',
        })
        const pass = runtime.createRenderPass({
            color: [ { target: surface, load: 'clear', store: 'store' } ],
        })

        expect(external).to.be.instanceOf(ExternalTextureBinding)
        expect(bindSet.isAttemptLocal).to.equal(true)
        expect(bindSet.preparationState).to.equal('attempt-local')
        expect(fixture.calls.externalTextures).to.have.length(0)
        expect(fixture.calls.bindGroups).to.have.length(0)

        runtime.createSubmission({ validation: 'throw' }).render(pass, [ draw ]).submit()

        expect(fixture.calls.externalTextures).to.have.length(1)
        expect(fixture.calls.externalTextures[0].descriptor).to.deep.equal({
            label: `video frame [scratch:${external.id}]`,
            source,
            colorSpace: 'display-p3',
        })
        expect(fixture.calls.bindGroups).to.have.length(1)
        expect(fixture.calls.bindGroups[0].descriptor.entries[0].resource)
            .to.equal(fixture.calls.externalTextures[0])
        expect(bindSet.preparationState).to.equal('attempt-local')

        runtime.createSubmission({ validation: 'throw' }).render(pass, [ draw ]).submit()

        expect(fixture.calls.externalTextures).to.have.length(2)
        expect(fixture.calls.bindGroups).to.have.length(2)
    })

    it('attributes native external imports to the selected submission command', async() => {

        const fixture = createFakeGpu()
        const canvas = createFakeCanvas()
        const runtime = await ScratchRuntime.create({ gpu: fixture.gpu })
        const surface = runtime.createSurface(canvas.canvas, {
            format: 'bgra8unorm',
            size: { width: 8, height: 8 },
        })
        const source = createFakeExternalImageSource('VideoFrame', {
            width: 8,
            height: 8,
        })
        const external = runtime.externalTexture({ source })
        const layout = await runtime.createBindLayout({
            group: 0,
            entries: [ {
                binding: 0,
                name: 'video',
                type: 'external-texture',
                visibility: [ 'fragment' ],
            } ],
        })
        const bindSet = await runtime.createBindSet(layout, { video: external })
        const pipeline = await createRenderPipeline(
            runtime,
            surface.format,
            [ layout ],
            externalTextureWgsl
        )
        const draw = runtime.createDrawCommand({
            pipeline,
            bindSets: [ { set: bindSet } ],
            count: { vertexCount: 3 },
            resources: emptyResources(),
            whenMissing: 'throw',
        })
        const pass = runtime.createRenderPass({
            color: [ { target: surface, load: 'clear', store: 'store' } ],
        })
        const capture = runtime.diagnostics.capture({
            nativeSubmissionDetail: 'step',
        })
        fixture.errors.failNext(
            'importExternalTexture',
            'validation',
            new Error('external texture import validation')
        )

        const submitted = runtime.createSubmission({ validation: 'throw' })
            .render(pass, [ draw ])
            .submit()
        const outcome = await submitted.nativeOutcome
        await submitted.done.catch(() => {})
        capture.stop()

        expect(outcome.mode).to.equal('detailed')
        expect(outcome.status).to.equal('observed-failed')
        const importFailure = outcome.outcomes.find(candidate =>
            candidate.stage === 'command-encode' &&
            candidate.nativeErrorCategory === 'validation'
        )
        expect(importFailure).to.deep.include({
            stage: 'command-encode',
            location: {
                kind: 'pass-command',
                submissionId: submitted.id,
                stepIndex: 0,
                commandIndex: 0,
                passId: pass.id,
                passKind: 'render',
                commandId: draw.id,
                commandKind: 'draw',
            },
            nativeErrorCategory: 'validation',
            diagnosticCode: 'SCRATCH_SUBMISSION_NATIVE_VALIDATION_FAILED',
        })
        expect(importFailure.nativeError).to.deep.include({
            name: 'Error',
        })
        expect(JSON.stringify(outcome)).not.to.include('"source"')
        expect(fixture.calls.externalTextures).to.have.length(1)
    })

    it('wraps a synchronous external import exception with binding provenance', async() => {

        const fixture = createFakeGpu()
        const canvas = createFakeCanvas()
        const runtime = await ScratchRuntime.create({ gpu: fixture.gpu })
        const surface = runtime.createSurface(canvas.canvas, {
            format: 'bgra8unorm',
            size: { width: 8, height: 8 },
        })
        const external = runtime.externalTexture({
            source: createFakeExternalImageSource('VideoFrame'),
        })
        const layout = await runtime.createBindLayout({
            group: 0,
            entries: [ {
                binding: 0,
                name: 'video',
                type: 'external-texture',
                visibility: [ 'fragment' ],
            } ],
        })
        const bindSet = await runtime.createBindSet(layout, { video: external })
        const pipeline = await createRenderPipeline(
            runtime,
            surface.format,
            [ layout ],
            externalTextureWgsl
        )
        const draw = runtime.createDrawCommand({
            pipeline,
            bindSets: [ { set: bindSet } ],
            count: { vertexCount: 3 },
            resources: emptyResources(),
            whenMissing: 'throw',
        })
        const pass = runtime.createRenderPass({
            color: [ { target: surface, load: 'clear', store: 'store' } ],
        })
        const nativeCause = new Error('synchronous external import failure')
        fixture.errors.throwNext('importExternalTexture', nativeCause)
        let caught

        try {
            runtime.createSubmission({ validation: 'throw' })
                .render(pass, [ draw ])
                .submit()
        } catch (error) {
            caught = error
        }

        expect(caught).to.be.instanceOf(ScratchDiagnosticError)
        expect(caught.diagnostic).to.deep.include({
            code: 'SCRATCH_EXTERNAL_TEXTURE_IMPORT_FAILED',
            severity: 'error',
            phase: 'submission',
            subject: external.subject,
        })
        expect(caught.cause).to.equal(nativeCause)
        expect(caught.diagnostic.actual).to.deep.include({
            sourceKind: 'VideoFrame',
            colorSpace: 'srgb',
        })
        expect(fixture.calls.externalTextures).to.have.length(0)
        expect(fixture.errors.scopeDepth).to.equal(0)
    })

    it('binds regular textures and views to external-texture slots without importing', async() => {

        const fixture = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu: fixture.gpu })
        const layout = await runtime.createBindLayout({
            group: 0,
            entries: [ {
                binding: 0,
                name: 'image',
                type: 'external-texture',
                visibility: [ 'fragment' ],
            } ],
        })
        const texture = await runtime.createTexture({
            size: [ 8, 8 ],
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_TEXTURE_BINDING,
        })
        const direct = await runtime.createBindSet(layout, { image: texture })
        const view = texture.view()
        const throughView = await runtime.createBindSet(layout, { image: view })

        expect(direct.isAttemptLocal).to.equal(false)
        expect(throughView.isAttemptLocal).to.equal(false)
        expect(fixture.calls.externalTextures).to.have.length(0)
        expect(fixture.calls.bindGroups.at(-2).descriptor.entries[0].resource)
            .to.equal(texture.gpuTexture)
        expect(fixture.calls.bindGroups.at(-1).descriptor.entries[0].resource)
            .to.equal(fixture.calls.textureViews[0])
    })

    it('validates regular external-texture resources before native bind-group creation', async() => {

        const fixture = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu: fixture.gpu })
        const layout = await runtime.createBindLayout({
            group: 0,
            entries: [ {
                binding: 0,
                name: 'image',
                type: 'external-texture',
                visibility: [ 'fragment' ],
            } ],
        })
        const invalidResources = [
            await runtime.createTexture({
                size: [ 8, 8, 2 ],
                dimension: '3d',
                format: 'rgba8unorm',
                usage: GPU_TEXTURE_USAGE_TEXTURE_BINDING,
            }),
            await runtime.createTexture({
                size: [ 8, 8 ],
                mipLevelCount: 2,
                format: 'rgba8unorm',
                usage: GPU_TEXTURE_USAGE_TEXTURE_BINDING,
            }),
            await runtime.createTexture({
                size: [ 8, 8 ],
                format: 'rgba8unorm-srgb',
                usage: GPU_TEXTURE_USAGE_TEXTURE_BINDING,
            }),
            await runtime.createTexture({
                size: [ 8, 8 ],
                sampleCount: 4,
                format: 'rgba8unorm',
                usage: GPU_TEXTURE_USAGE_TEXTURE_BINDING |
                    GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
            }),
        ]
        const bindGroupCount = fixture.calls.bindGroups.length

        for (const resource of invalidResources) {
            let caught
            try {
                await runtime.createBindSet(layout, { image: resource })
            } catch (error) {
                caught = error
            }

            expect(caught).to.be.instanceOf(ScratchDiagnosticError)
            expect(caught.diagnostic.code)
                .to.equal('SCRATCH_BIND_EXTERNAL_TEXTURE_VIEW_MISMATCH')
        }
        expect(fixture.calls.bindGroups).to.have.length(bindGroupCount)
        expect(fixture.calls.externalTextures).to.have.length(0)
    })

    it('shares one Surface current texture between copy and attachment uses in one attempt', async() => {

        const fixture = createFakeGpu()
        const canvas = createFakeCanvas()
        const runtime = await ScratchRuntime.create({ gpu: fixture.gpu })
        const surface = runtime.createSurface(canvas.canvas, {
            format: 'bgra8unorm',
            usage: GPU_TEXTURE_USAGE_COPY_SRC | GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
            size: { width: 8, height: 8 },
        })
        const target = await runtime.createTexture({
            format: surface.format,
            size: [ 8, 8 ],
            usage: GPU_TEXTURE_USAGE_COPY_DST,
        })
        const submission = runtime.createSubmission({ validation: 'throw' })
        const current = submission.surfaceTexture(surface)
        const copy = runtime.createCopyCommand({
            source: { surface: current },
            target,
            size: [ 8, 8 ],
            whenMissing: 'throw',
        })
        const pass = runtime.createRenderPass({
            color: [ { target: surface, load: 'clear', store: 'store' } ],
        })

        expect(current).to.be.instanceOf(SurfaceTextureLease)
        expect(current.state).to.equal('pending')
        submission.copy(copy).render(pass).submit()

        expect(canvas.context.currentTextureCalls).to.equal(1)
        expect(fixture.calls.textureCopies).to.have.length(1)
        expect(fixture.calls.textureCopies[0].source.texture)
            .to.equal(canvas.context.currentTextures[0])
        expect(canvas.textureViews[0].texture).to.equal(canvas.context.currentTextures[0])
        expect(current.state).to.equal('expired')
        expect(target.contentEpoch).to.equal(1)
    })

    it('wraps synchronous Surface acquisition failure and expires the lease', async() => {

        const fixture = createFakeGpu()
        const canvas = createFakeCanvas()
        const runtime = await ScratchRuntime.create({ gpu: fixture.gpu })
        const surface = runtime.createSurface(canvas.canvas, {
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_COPY_SRC,
            size: { width: 8, height: 8 },
        })
        const target = await runtime.createTexture({
            format: surface.format,
            size: [ 8, 8 ],
            usage: GPU_TEXTURE_USAGE_COPY_DST,
        })
        const submission = runtime.createSubmission({ validation: 'throw' })
        const current = submission.surfaceTexture(surface)
        const copy = runtime.createCopyCommand({
            source: { surface: current },
            target,
            size: [ 8, 8 ],
            whenMissing: 'throw',
        })
        const nativeCause = new Error('synchronous current texture failure')
        canvas.context.getCurrentTexture = () => {
            throw nativeCause
        }
        let caught

        try {
            submission.copy(copy).submit()
        } catch (error) {
            caught = error
        }

        expect(caught).to.be.instanceOf(ScratchDiagnosticError)
        expect(caught.diagnostic).to.deep.include({
            code: 'SCRATCH_SURFACE_TEXTURE_ACQUISITION_FAILED',
            severity: 'error',
            phase: 'submission',
            subject: surface.subject,
        })
        expect(caught.cause).to.equal(nativeCause)
        expect(current.state).to.equal('expired')
        expect(target.contentEpoch).to.equal(0)
        expect(fixture.errors.scopeDepth).to.equal(0)
    })

    it('uses an explicit Surface lease as a render attachment', async() => {

        const fixture = createFakeGpu()
        const canvas = createFakeCanvas()
        const runtime = await ScratchRuntime.create({ gpu: fixture.gpu })
        const surface = runtime.createSurface(canvas.canvas, {
            format: 'bgra8unorm',
            usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
            size: { width: 8, height: 8 },
        })
        const submission = runtime.createSubmission({ validation: 'throw' })
        const current = submission.surfaceTexture(surface)
        const pass = runtime.createRenderPass({
            color: [ {
                target: current,
                load: 'clear',
                store: 'store',
            } ],
        })

        submission.render(pass).submit()

        expect(canvas.context.currentTextureCalls).to.equal(1)
        expect(canvas.textureViews).to.have.length(1)
        expect(canvas.textureViews[0].texture).to.equal(canvas.context.currentTextures[0])
        expect(current.state).to.equal('expired')
    })

    it('uses a Surface lease as a buffer-to-texture copy destination', async() => {

        const fixture = createFakeGpu()
        const canvas = createFakeCanvas()
        const runtime = await ScratchRuntime.create({ gpu: fixture.gpu })
        const surface = runtime.createSurface(canvas.canvas, {
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_COPY_DST,
            size: { width: 8, height: 8 },
        })
        const source = await runtime.createBuffer({
            size: 2048,
            usage: GPU_BUFFER_USAGE_COPY_SRC | GPU_BUFFER_USAGE_COPY_DST,
        })
        const upload = runtime.createUploadCommand({
            target: source.region(),
            data: new Uint8Array(2048),
        })
        const submission = runtime.createSubmission({ validation: 'throw' })
        const current = submission.surfaceTexture(surface)
        const copy = runtime.createCopyCommand({
            source: { region: source.region(), contentEpoch: 1 },
            sourceLayout: { bytesPerRow: 256, rowsPerImage: 8 },
            target: current,
            size: [ 8, 8 ],
            whenMissing: 'throw',
        })

        submission.upload(upload).copy(copy).submit()

        expect(canvas.context.currentTextureCalls).to.equal(1)
        expect(fixture.calls.bufferTextureCopies).to.have.length(1)
        expect(fixture.calls.bufferTextureCopies[0].destination.texture)
            .to.equal(canvas.context.currentTextures[0])
        expect(current.state).to.equal('expired')
    })

    it('realizes a Surface view only when an explicit compute binding selects it', async() => {

        const fixture = createFakeGpu()
        const canvas = createFakeCanvas()
        const runtime = await ScratchRuntime.create({ gpu: fixture.gpu })
        const surface = runtime.createSurface(canvas.canvas, {
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_TEXTURE_BINDING,
            size: { width: 8, height: 8 },
        })
        const unusedSubmission = runtime.createSubmission()
        const unused = unusedSubmission.surfaceTexture(surface)

        unusedSubmission.submit()

        expect(canvas.context.currentTextureCalls).to.equal(0)
        expect(unused.state).to.equal('expired')

        const submission = runtime.createSubmission({ validation: 'throw' })
        const current = submission.surfaceTexture(surface)
        const view = current.view()
        const layout = await runtime.createBindLayout({
            group: 0,
            entries: [ {
                binding: 0,
                name: 'current',
                type: 'texture',
                visibility: [ 'compute' ],
            } ],
        })
        const bindSet = await runtime.createBindSet(layout, { current: view })
        const program = await createTestProgram(runtime, {
            sourceParts: [ sampledTextureComputeWgsl ],
            compute: 'main',
        })
        const pipeline = await runtime.createComputePipeline({
            program,
            layout: { mode: 'explicit', bindLayouts: [ layout ] },
        })
        const dispatch = runtime.createDispatchCommand({
            pipeline,
            bindSets: [ { set: bindSet } ],
            count: { workgroups: [ 1 ] },
            resources: emptyResources(),
            whenMissing: 'throw',
        })
        const pass = runtime.createComputePass()

        expect(view).to.be.instanceOf(SurfaceTextureView)
        submission.compute(pass, [ dispatch ]).submit()

        expect(canvas.context.currentTextureCalls).to.equal(1)
        expect(canvas.textureViews).to.have.length(1)
        expect(fixture.calls.bindGroups).to.have.length(1)
        expect(fixture.calls.bindGroups[0].descriptor.entries[0].resource)
            .to.equal(canvas.textureViews[0])
        expect(current.state).to.equal('expired')
    })

    it('binds a Surface lease directly as a sampled texture', async() => {

        const fixture = createFakeGpu()
        const canvas = createFakeCanvas()
        const runtime = await ScratchRuntime.create({ gpu: fixture.gpu })
        const surface = runtime.createSurface(canvas.canvas, {
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_TEXTURE_BINDING,
            size: { width: 8, height: 8 },
        })
        const submission = runtime.createSubmission({ validation: 'throw' })
        const current = submission.surfaceTexture(surface)
        const layout = await runtime.createBindLayout({
            group: 0,
            entries: [ {
                binding: 0,
                name: 'current',
                type: 'texture',
                visibility: [ 'compute' ],
            } ],
        })
        const bindSet = await runtime.createBindSet(layout, { current })
        const program = await createTestProgram(runtime, {
            sourceParts: [ sampledTextureComputeWgsl ],
            compute: 'main',
        })
        const pipeline = await runtime.createComputePipeline({
            program,
            layout: { mode: 'explicit', bindLayouts: [ layout ] },
        })
        const dispatch = runtime.createDispatchCommand({
            pipeline,
            bindSets: [ { set: bindSet } ],
            count: { workgroups: [ 1 ] },
            resources: emptyResources(),
            whenMissing: 'throw',
        })

        submission.compute(runtime.createComputePass(), [ dispatch ]).submit()

        expect(canvas.context.currentTextureCalls).to.equal(1)
        expect(canvas.textureViews).to.have.length(0)
        expect(fixture.calls.bindGroups.at(-1).descriptor.entries[0].resource)
            .to.equal(canvas.context.currentTextures[0])
    })

    it('does not inspect Surface configuration after encoder creation', async() => {

        const fixture = createFakeGpu()
        const canvas = createFakeCanvas()
        const runtime = await ScratchRuntime.create({ gpu: fixture.gpu })
        const surface = runtime.createSurface(canvas.canvas, {
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_TEXTURE_BINDING,
            size: { width: 8, height: 8 },
        })
        const submission = runtime.createSubmission({ validation: 'throw' })
        const current = submission.surfaceTexture(surface)
        const layout = await runtime.createBindLayout({
            group: 0,
            entries: [ {
                binding: 0,
                name: 'current',
                type: 'texture',
                visibility: [ 'compute' ],
            } ],
        })
        const bindSet = await runtime.createBindSet(layout, { current })
        const program = await createTestProgram(runtime, {
            sourceParts: [ sampledTextureComputeWgsl ],
            compute: 'main',
        })
        const pipeline = await runtime.createComputePipeline({
            program,
            layout: { mode: 'explicit', bindLayouts: [ layout ] },
        })
        const dispatch = runtime.createDispatchCommand({
            pipeline,
            bindSets: [ { set: bindSet } ],
            count: { workgroups: [ 1 ] },
            resources: emptyResources(),
            whenMissing: 'throw',
        })
        const buffer = await runtime.createBuffer({
            size: 16,
            usage: GPU_BUFFER_USAGE_COPY_SRC | GPU_BUFFER_USAGE_COPY_DST,
        })
        const clear = runtime.createClearBufferCommand({
            target: buffer.region(),
        })
        const getConfiguration = canvas.context.getConfiguration.bind(canvas.context)
        let postEncoderConfigurationReads = 0
        canvas.context.getConfiguration = () => {
            if (fixture.calls.commandEncoders.length > 0) {
                postEncoderConfigurationReads++
                throw new Error('Surface configuration read after encoder creation')
            }
            return getConfiguration()
        }

        submission
            .clear(clear)
            .compute(runtime.createComputePass(), [ dispatch ])
            .submit()

        expect(postEncoderConfigurationReads).to.equal(0)
        expect(canvas.context.currentTextureCalls).to.equal(1)
        expect(fixture.calls.commandEncoders).to.have.length(1)
    })

    it('binds a Surface lease directly as a storage texture', async() => {

        const fixture = createFakeGpu()
        fixture.device.features.add('core-features-and-limits')
        const canvas = createFakeCanvas()
        const runtime = await ScratchRuntime.create({ gpu: fixture.gpu })
        const surface = runtime.createSurface(canvas.canvas, {
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_STORAGE_BINDING,
            size: { width: 8, height: 8 },
        })
        const submission = runtime.createSubmission({ validation: 'throw' })
        const current = submission.surfaceTexture(surface)
        const layout = await runtime.createBindLayout({
            group: 0,
            entries: [ {
                binding: 0,
                name: 'current',
                type: 'storage-texture',
                visibility: [ 'compute' ],
                access: 'write-only',
                format: 'rgba8unorm',
            } ],
        })
        const bindSet = await runtime.createBindSet(layout, { current })
        const program = await createTestProgram(runtime, {
            sourceParts: [ storageTextureComputeWgsl ],
            compute: 'main',
        })
        const pipeline = await runtime.createComputePipeline({
            program,
            layout: { mode: 'explicit', bindLayouts: [ layout ] },
        })
        const dispatch = runtime.createDispatchCommand({
            pipeline,
            bindSets: [ { set: bindSet } ],
            count: { workgroups: [ 1 ] },
            resources: emptyResources(),
            whenMissing: 'throw',
        })

        submission.compute(runtime.createComputePass(), [ dispatch ]).submit()

        expect(canvas.context.currentTextureCalls).to.equal(1)
        expect(canvas.textureViews).to.have.length(0)
        expect(fixture.calls.bindGroups.at(-1).descriptor.entries[0].resource)
            .to.equal(canvas.context.currentTextures[0])
    })

    it('rejects stale and wrong-builder Surface leases before acquiring a native texture', async() => {

        const fixture = createFakeGpu()
        const canvas = createFakeCanvas()
        const runtime = await ScratchRuntime.create({ gpu: fixture.gpu })
        const surface = runtime.createSurface(canvas.canvas, {
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_COPY_SRC,
            size: { width: 8, height: 8 },
        })
        const target = await runtime.createTexture({
            format: surface.format,
            size: [ 8, 8 ],
            usage: GPU_TEXTURE_USAGE_COPY_DST,
        })
        const owner = runtime.createSubmission({ validation: 'throw' })
        const current = owner.surfaceTexture(surface)
        const copy = runtime.createCopyCommand({
            source: { surface: current },
            target,
            size: [ 8, 8 ],
            whenMissing: 'throw',
        })
        let wrongBuilderError

        try {
            runtime.createSubmission({ validation: 'throw' }).copy(copy).submit()
        } catch (error) {
            wrongBuilderError = error
        }

        expect(wrongBuilderError).to.be.instanceOf(ScratchDiagnosticError)
        expect(wrongBuilderError.diagnostic.code)
            .to.equal('SCRATCH_SURFACE_TEXTURE_LEASE_WRONG_SUBMISSION')
        expect(canvas.context.currentTextureCalls).to.equal(0)

        surface.configure({ size: { width: 8, height: 8 } })
        let staleError
        try {
            owner.copy(copy).submit()
        } catch (error) {
            staleError = error
        }

        expect(staleError).to.be.instanceOf(ScratchDiagnosticError)
        expect(staleError.diagnostic.code).to.equal('SCRATCH_SURFACE_TEXTURE_LEASE_STALE')
        expect(canvas.context.currentTextureCalls).to.equal(0)
    })

    it('rejects forged temporal objects and invalid external sources', async() => {

        const fixture = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu: fixture.gpu })
        let invalidSourceError
        try {
            runtime.externalTexture({
                source: createFakeExternalImageSource('ImageData'),
            })
        } catch (error) {
            invalidSourceError = error
        }

        expect(invalidSourceError).to.be.instanceOf(ScratchDiagnosticError)
        expect(invalidSourceError.diagnostic.code)
            .to.equal('SCRATCH_EXTERNAL_TEXTURE_SOURCE_INVALID')

        const layout = await runtime.createBindLayout({
            group: 0,
            entries: [ {
                binding: 0,
                name: 'video',
                type: 'external-texture',
                visibility: [ 'fragment' ],
            } ],
        })
        let forgedError
        try {
            await runtime.createBindSet(layout, {
                video: Object.create(ExternalTextureBinding.prototype),
            })
        } catch (error) {
            forgedError = error
        }

        expect(forgedError).to.be.instanceOf(ScratchDiagnosticError)
        expect(forgedError.diagnostic.code).to.equal('SCRATCH_BIND_RESOURCE_TYPE_MISMATCH')
        expect(fixture.calls.externalTextures).to.have.length(0)
    })

    it('rejects direct encoding when a command needs attempt-local realization', async() => {

        const fixture = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu: fixture.gpu })
        const source = runtime.externalTexture({
            source: createFakeExternalImageSource('VideoFrame'),
        })
        const layout = await runtime.createBindLayout({
            group: 0,
            entries: [ {
                binding: 0,
                name: 'video',
                type: 'external-texture',
                visibility: [ 'fragment' ],
            } ],
        })
        const bindSet = await runtime.createBindSet(layout, { video: source })
        const pipeline = await createRenderPipeline(
            runtime,
            'bgra8unorm',
            [ layout ],
            externalTextureWgsl
        )
        const draw = runtime.createDrawCommand({
            pipeline,
            bindSets: [ { set: bindSet } ],
            count: { vertexCount: 3 },
            resources: emptyResources(),
            whenMissing: 'throw',
        })
        const encoder = fixture.device.createCommandEncoder()
        const pass = encoder.beginRenderPass({ colorAttachments: [] })
        let caught

        try {
            draw.encode(pass, { width: 1, height: 1 })
        } catch (error) {
            caught = error
        }

        expect(caught).to.be.instanceOf(ScratchDiagnosticError)
        expect(caught.diagnostic.code).to.equal('SCRATCH_ATTEMPT_AUTHORITY_REQUIRED')
        expect(fixture.calls.externalTextures).to.have.length(0)
    })

    it('rejects direct copy encoding for a Surface texture endpoint', async() => {

        const fixture = createFakeGpu()
        const canvas = createFakeCanvas()
        const runtime = await ScratchRuntime.create({ gpu: fixture.gpu })
        const surface = runtime.createSurface(canvas.canvas, {
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_COPY_SRC,
            size: { width: 8, height: 8 },
        })
        const target = await runtime.createTexture({
            format: surface.format,
            size: [ 8, 8 ],
            usage: GPU_TEXTURE_USAGE_COPY_DST,
        })
        const submission = runtime.createSubmission()
        const copy = runtime.createCopyCommand({
            source: { surface: submission.surfaceTexture(surface) },
            target,
            size: [ 8, 8 ],
            whenMissing: 'throw',
        })
        let caught

        try {
            copy.encode(fixture.device.createCommandEncoder())
        } catch (error) {
            caught = error
        }

        expect(caught).to.be.instanceOf(ScratchDiagnosticError)
        expect(caught.diagnostic.code).to.equal('SCRATCH_ATTEMPT_AUTHORITY_REQUIRED')
        expect(canvas.context.currentTextureCalls).to.equal(0)
    })
})
