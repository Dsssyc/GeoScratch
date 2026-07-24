import { expect } from 'chai'
import * as scr from 'geoscratch'
import {
    createFakeCanvas,
    createFakeExternalImageSource,
    createFakeGpu,
    createTestProgram,
    replaceResourceAllocationForTest,
    triangleWgsl,
} from './scratch-test-utils.js'

const GPU_BUFFER_USAGE_COPY_DST = 0x8
const GPU_BUFFER_USAGE_UNIFORM = 0x40
const GPU_BUFFER_USAGE_STORAGE = 0x80
const GPU_BUFFER_USAGE_VERTEX = 0x20
const GPU_TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10
const MAX_RETAINED_DEBUG_GROUP_IDS = 16

const externalTextureWgsl = `
@group(0) @binding(0)
var video: texture_external;

@vertex
fn vsMain(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4f {
    let positions = array(
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

describe('scratch RenderBundle and public debug commands', () => {

    it('acknowledges one persistent native bundle and executes that exact bundle', async() => {

        const fixture = await createRenderFixture()
        const bundleDraw = fixture.runtime.createBundleDrawCommand({
            label: 'bundle triangle',
            pipeline: fixture.pipeline,
            bindSets: [],
            vertexBuffers: [],
            count: { vertexCount: 3 },
            resources: { read: [], write: [] },
            whenMissing: 'throw',
        })
        const marker = fixture.runtime.createDebugCommand({
            action: 'insert-marker',
            label: 'inside persistent bundle',
        })
        const bundle = await fixture.runtime.createRenderBundle({
            label: 'persistent triangle',
            realization: 'persistent',
            colorFormats: [ 'rgba8unorm' ],
            commands: [ marker, bundleDraw ],
        })

        expect(bundle.realization).to.equal('persistent')
        expect(bundle.realizationState).to.equal('ready')
        expect(fixture.fake.calls.renderBundleEncoders).to.have.length(1)
        expect(fixture.fake.calls.renderBundleEncoders[0].descriptor).to.deep.equal({
            label: `persistent triangle [scratch:${bundle.id}]`,
            colorFormats: [ 'rgba8unorm' ],
            sampleCount: 1,
            depthReadOnly: false,
            stencilReadOnly: false,
        })
        expect(fixture.fake.calls.renderBundles).to.have.length(1)
        expect(fixture.fake.calls.renderBundles[0].actions.map(action => action.type))
            .to.deep.equal([
                'insertDebugMarker',
                'setPipeline',
                'draw',
            ])

        const execute = fixture.runtime.createExecuteRenderBundlesCommand({
            label: 'execute persistent triangle',
            bundles: [ bundle ],
        })
        const submitted = fixture.runtime.createSubmission()
            .render(fixture.pass, [ execute ])
            .submit()

        expect(fixture.fake.calls.renderBundleEncoders).to.have.length(1)
        expect(fixture.fake.calls.renderBundleExecutions).to.have.length(1)
        expect(fixture.fake.calls.renderBundleExecutions[0].bundles)
            .to.deep.equal([ fixture.fake.calls.renderBundles[0] ])
        expect(submitted.renderBundles).to.deep.equal([
            {
                executeCommandId: execute.id,
                bundleId: bundle.id,
                realization: 'persistent',
                commandIds: [ marker.id, bundleDraw.id ],
            },
        ])
        await submitted.done
    })

    it('calls executeBundles for an empty iterable and leaves the next Draw self-contained', async() => {

        const fixture = await createRenderFixture()
        const execute = fixture.runtime.createExecuteRenderBundlesCommand({
            bundles: [],
        })
        const draw = fixture.runtime.createDrawCommand({
            pipeline: fixture.pipeline,
            count: { vertexCount: 3 },
            resources: { read: [], write: [] },
            whenMissing: 'throw',
        })

        const submitted = fixture.runtime.createSubmission()
            .render(fixture.pass, [ execute, draw ])
            .submit()
        const actions = fixture.fake.calls.renderPasses[0].actions

        expect(fixture.fake.calls.renderBundleExecutions).to.have.length(1)
        expect(fixture.fake.calls.renderBundleExecutions[0].bundles).to.deep.equal([])
        expect(actions.map(action => action.type)).to.deep.equal([
            'executeBundles',
            'setPipeline',
            'setViewport',
            'setScissorRect',
            'setBlendConstant',
            'setStencilReference',
            'draw',
            'end',
        ])
        await submitted.done
    })

    it('rejects a stale persistent allocation snapshot instead of rebuilding it', async() => {

        const fixture = await createRenderFixture({
            vertexBuffers: [ {
                arrayStride: 4,
                attributes: [ {
                    shaderLocation: 0,
                    offset: 0,
                    format: 'float32',
                } ],
            } ],
        })
        const vertices = await fixture.runtime.createBuffer({
            size: 16,
            usage: GPU_BUFFER_USAGE_VERTEX | GPU_BUFFER_USAGE_COPY_DST,
        })
        const bundleDraw = fixture.runtime.createBundleDrawCommand({
            pipeline: fixture.pipeline,
            vertexBuffers: [ { slot: 0, region: vertices.region() } ],
            count: { vertexCount: 3 },
            resources: {
                read: [ {
                    resource: vertices,
                    contentEpoch: vertices.contentEpoch,
                } ],
                write: [],
            },
            whenMissing: 'throw',
        })
        const bundle = await fixture.runtime.createRenderBundle({
            realization: 'persistent',
            colorFormats: [ 'rgba8unorm' ],
            commands: [ bundleDraw ],
        })

        replaceResourceAllocationForTest(vertices)
        expect(bundle.realizationState).to.equal('stale')

        const execute = fixture.runtime.createExecuteRenderBundlesCommand({
            bundles: [ bundle ],
        })
        const error = await rejectedDiagnostic(() =>
            fixture.runtime.createSubmission()
                .render(fixture.pass, [ execute ])
                .submit()
        )

        expect(error.diagnostic).to.deep.include({
            code: 'SCRATCH_RENDER_BUNDLE_STALE',
            phase: 'command',
        })
        expect(fixture.fake.calls.renderBundleEncoders).to.have.length(1)
        expect(fixture.fake.calls.commandEncoders).to.have.length(0)
    })

    it('requires explicit attempt-local realization for temporal bindings', async() => {

        const fake = createFakeGpu()
        const canvas = createFakeCanvas()
        const runtime = await scr.ScratchRuntime.create({ gpu: fake.gpu })
        const surface = runtime.createSurface(canvas.canvas, {
            format: 'bgra8unorm',
            size: { width: 8, height: 8 },
        })
        const external = runtime.createExternalTextureBinding({
            source: createFakeExternalImageSource('HTMLVideoElement', {
                width: 8,
                height: 8,
            }),
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
        const program = await createTestProgram(runtime, {
            sourceParts: [ externalTextureWgsl ],
            vertex: 'vsMain',
            fragment: 'fsMain',
        })
        const pipeline = await runtime.createRenderPipeline({
            program,
            layout: { mode: 'explicit', bindLayouts: [ layout ] },
            targets: [ { format: surface.format } ],
        })
        const bundleDraw = runtime.createBundleDrawCommand({
            pipeline,
            bindSets: [ { set: bindSet } ],
            count: { vertexCount: 3 },
            resources: { read: [], write: [] },
            whenMissing: 'throw',
        })

        const persistentError = await rejectedDiagnostic(() =>
            runtime.createRenderBundle({
                realization: 'persistent',
                colorFormats: [ surface.format ],
                commands: [ bundleDraw ],
            })
        )
        expect(persistentError.diagnostic.code)
            .to.equal('SCRATCH_RENDER_BUNDLE_TEMPORAL_REALIZATION_REQUIRED')
        expect(fake.calls.renderBundleEncoders).to.have.length(0)

        const bundle = await runtime.createRenderBundle({
            realization: 'attempt-local',
            colorFormats: [ surface.format ],
            commands: [ bundleDraw ],
        })
        const execute = runtime.createExecuteRenderBundlesCommand({
            bundles: [ bundle ],
        })
        const pass = runtime.createRenderPass({
            color: [ { target: surface } ],
        })
        const submitted = runtime.createSubmission()
            .render(pass, [ execute ])
            .submit()

        expect(bundle.realizationState).to.equal('attempt-local')
        expect(fake.calls.externalTextures).to.have.length(1)
        expect(fake.calls.renderBundleEncoders).to.have.length(1)
        expect(fake.calls.renderBundleExecutions).to.have.length(1)
        expect(submitted.renderBundles[0]).to.deep.include({
            executeCommandId: execute.id,
            bundleId: bundle.id,
            realization: 'attempt-local',
        })
        await submitted.done
    })

    it('executes a fragmentless bundle in a compatible read-only depth pass', async() => {

        const fake = createFakeGpu()
        const runtime = await scr.ScratchRuntime.create({ gpu: fake.gpu })
        const depth = await runtime.createTexture({
            size: [ 8, 8 ],
            format: 'depth24plus',
            usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
        })
        const module = await runtime.createShaderModule({
            sourceParts: [ { code: triangleWgsl } ],
        })
        const pipeline = await runtime.createRenderPipeline({
            program: runtime.createProgram({
                vertex: { module, entryPoint: 'vsMain' },
            }),
            depthStencil: {
                format: 'depth24plus',
                depthWriteEnabled: false,
                depthCompare: 'less',
            },
        })
        const bundleDraw = runtime.createBundleDrawCommand({
            pipeline,
            count: { vertexCount: 3 },
            resources: { read: [], write: [] },
            whenMissing: 'throw',
        })
        const bundle = await runtime.createRenderBundle({
            realization: 'persistent',
            colorFormats: [],
            depthStencilFormat: 'depth24plus',
            depthReadOnly: true,
            commands: [ bundleDraw ],
        })
        const execute = runtime.createExecuteRenderBundlesCommand({
            bundles: [ bundle ],
        })
        const pass = runtime.createRenderPass({
            color: [],
            depth: {
                target: depth.view(),
                depthReadOnly: true,
            },
        })
        const initializeDepth = runtime.createRenderPass({
            color: [],
            depth: {
                target: depth.view(),
                depthLoad: 'clear',
                depthStore: 'store',
                depthClear: 1,
            },
        })

        const submitted = runtime.createSubmission()
            .render(initializeDepth)
            .render(pass, [ execute ])
            .submit()

        expect(fake.calls.renderBundleEncoders[0].descriptor).to.deep.include({
            colorFormats: [],
            depthStencilFormat: 'depth24plus',
            depthReadOnly: true,
        })
        expect(fake.calls.renderBundleExecutions).to.have.length(1)
        await submitted.done
    })

    it('lowers one DebugCommand family to command, render, compute, and bundle encoders', async() => {

        const fixture = await createRenderFixture()
        const computeProgram = await createTestProgram(fixture.runtime, {
            sourceParts: [ '@compute @workgroup_size(1) fn main() {}' ],
            compute: 'main',
        })
        const computePipeline = await fixture.runtime.createComputePipeline({
            program: computeProgram,
        })
        const dispatch = fixture.runtime.createDispatchCommand({
            pipeline: computePipeline,
            count: { workgroups: [ 1 ] },
            resources: { read: [], write: [] },
            whenMissing: 'throw',
        })
        const draw = fixture.runtime.createDrawCommand({
            pipeline: fixture.pipeline,
            count: { vertexCount: 3 },
            resources: { read: [], write: [] },
            whenMissing: 'throw',
        })
        const commandMarker = fixture.runtime.createDebugCommand({
            action: 'insert-marker',
            label: 'command marker',
        })
        const renderMarker = fixture.runtime.createDebugCommand({
            action: 'insert-marker',
            label: 'render marker',
        })
        const computeMarker = fixture.runtime.createDebugCommand({
            action: 'insert-marker',
            label: 'compute marker',
        })
        const bundleMarker = fixture.runtime.createDebugCommand({
            action: 'insert-marker',
            label: 'bundle marker',
        })
        await fixture.runtime.createRenderBundle({
            realization: 'persistent',
            colorFormats: [ 'rgba8unorm' ],
            commands: [ bundleMarker ],
        })

        const submitted = fixture.runtime.createSubmission()
            .debug(commandMarker)
            .render(fixture.pass, [ renderMarker, draw ])
            .compute(fixture.runtime.createComputePass(), [ computeMarker, dispatch ])
            .submit()

        expect(fixture.fake.calls.debugMarkers).to.deep.equal([
            { encoder: 'render-bundle', label: 'bundle marker' },
            { encoder: 'command', label: 'command marker' },
            { encoder: 'render-pass', label: 'render marker' },
            { encoder: 'compute-pass', label: 'compute marker' },
        ])
        await submitted.done
    })

    it('rejects unbalanced debug groups before native effects', async() => {

        const fixture = await createRenderFixture()
        const pop = fixture.runtime.createDebugCommand({ action: 'pop-group' })

        const bundleError = await rejectedDiagnostic(() =>
            fixture.runtime.createRenderBundle({
                realization: 'persistent',
                colorFormats: [ 'rgba8unorm' ],
                commands: [ pop ],
            })
        )
        expect(bundleError.diagnostic.code).to.equal('SCRATCH_DEBUG_GROUP_UNBALANCED')
        expect(fixture.fake.calls.renderBundleEncoders).to.have.length(0)

        const push = fixture.runtime.createDebugCommand({
            action: 'push-group',
            label: 'unclosed',
        })
        const submissionError = await rejectedDiagnostic(() =>
            fixture.runtime.createSubmission()
                .debug(push)
                .render(fixture.pass, [])
                .submit()
        )
        expect(submissionError.diagnostic.code).to.equal('SCRATCH_DEBUG_GROUP_UNBALANCED')
        expect(fixture.fake.calls.commandEncoders).to.have.length(0)
    })

    it('balances debug groups independently across command, pass, and bundle scopes', async() => {

        const fixture = await createRenderFixture()
        const commandPush = fixture.runtime.createDebugCommand({
            action: 'push-group',
            label: 'command scope',
        })
        const commandPop = fixture.runtime.createDebugCommand({ action: 'pop-group' })
        const renderPush = fixture.runtime.createDebugCommand({
            action: 'push-group',
            label: 'render scope',
        })
        const renderPop = fixture.runtime.createDebugCommand({ action: 'pop-group' })
        const computePush = fixture.runtime.createDebugCommand({
            action: 'push-group',
            label: 'compute scope',
        })
        const computePop = fixture.runtime.createDebugCommand({ action: 'pop-group' })
        const bundlePush = fixture.runtime.createDebugCommand({
            action: 'push-group',
            label: 'bundle scope',
        })
        const bundlePop = fixture.runtime.createDebugCommand({ action: 'pop-group' })
        const bundle = await fixture.runtime.createRenderBundle({
            realization: 'persistent',
            colorFormats: [ 'rgba8unorm' ],
            commands: [ bundlePush, bundlePop ],
        })
        const execute = fixture.runtime.createExecuteRenderBundlesCommand({
            bundles: [ bundle ],
        })

        const submitted = fixture.runtime.createSubmission()
            .debug(commandPush)
            .render(fixture.pass, [ renderPush, execute, renderPop ])
            .compute(fixture.runtime.createComputePass(), [ computePush, computePop ])
            .debug(commandPop)
            .submit()

        expect(fixture.fake.calls.debugGroups).to.deep.equal([
            { action: 'push', encoder: 'render-bundle', label: 'bundle scope' },
            { action: 'pop', encoder: 'render-bundle' },
            { action: 'push', encoder: 'command', label: 'command scope' },
            { action: 'push', encoder: 'render-pass', label: 'render scope' },
            { action: 'pop', encoder: 'render-pass' },
            { action: 'push', encoder: 'compute-pass', label: 'compute scope' },
            { action: 'pop', encoder: 'compute-pass' },
            { action: 'pop', encoder: 'command' },
        ])
        await submitted.done
    })

    it('rejects a command-encoder debug group that crosses an upload boundary', async() => {

        const fixture = await createRenderFixture()
        const target = await fixture.runtime.createBuffer({
            size: 16,
            usage: GPU_BUFFER_USAGE_COPY_DST,
        })
        const push = fixture.runtime.createDebugCommand({
            action: 'push-group',
            label: 'invalid cross-segment group',
        })
        const pop = fixture.runtime.createDebugCommand({ action: 'pop-group' })
        const upload = fixture.runtime.createUploadCommand({
            target: target.region(),
            data: new Uint8Array(16),
        })

        const error = await rejectedDiagnostic(() =>
            fixture.runtime.createSubmission()
                .debug(push)
                .upload(upload)
                .debug(pop)
                .submit()
        )

        expect(error.diagnostic.code).to.equal('SCRATCH_DEBUG_GROUP_UNBALANCED')
        expect(error.diagnostic.actual).to.deep.include({
            context: 'command-encoder',
            openGroupCountAtEnd: 1,
        })
        expect(fixture.fake.calls.commandEncoders).to.have.length(0)
    })

    it('snapshots descriptor getters and one-shot iterables once before native effects', async() => {

        const fixture = await createRenderFixture()
        const marker = fixture.runtime.createDebugCommand({
            action: 'insert-marker',
            label: 'single snapshot',
        })
        let realizationReads = 0
        let colorFormatReads = 0
        let commandReads = 0
        let colorFormatIterations = 0
        let commandIterations = 0
        const oneShot = (values, count) => ({
            [Symbol.iterator]() {
                count()
                return values[Symbol.iterator]()
            },
        })
        const descriptor = {
            get realization() {
                realizationReads++
                if (realizationReads > 1) throw new Error('realization read twice')
                return 'persistent'
            },
            get colorFormats() {
                colorFormatReads++
                if (colorFormatReads > 1) throw new Error('colorFormats read twice')
                return oneShot([ 'rgba8unorm' ], () => {
                    colorFormatIterations++
                    if (colorFormatIterations > 1) {
                        throw new Error('colorFormats iterated twice')
                    }
                })
            },
            get commands() {
                commandReads++
                if (commandReads > 1) throw new Error('commands read twice')
                return oneShot([ marker ], () => {
                    commandIterations++
                    if (commandIterations > 1) throw new Error('commands iterated twice')
                })
            },
        }

        const bundle = await fixture.runtime.createRenderBundle(descriptor)

        expect(bundle.commands).to.deep.equal([ marker ])
        expect({
            realizationReads,
            colorFormatReads,
            commandReads,
            colorFormatIterations,
            commandIterations,
        }).to.deep.equal({
            realizationReads: 1,
            colorFormatReads: 1,
            commandReads: 1,
            colorFormatIterations: 1,
            commandIterations: 1,
        })
        expect(fixture.fake.calls.renderBundleEncoders).to.have.length(1)
    })

    it('attributes debug native exceptions and delayed validation to their owning scopes', async() => {

        const synchronousFixture = await createRenderFixture()
        const commandMarker = synchronousFixture.runtime.createDebugCommand({
            action: 'insert-marker',
            label: 'synchronous failure',
        })
        const synchronousCause = new TypeError('command marker failed')
        synchronousFixture.fake.errors.throwNext(
            'commandInsertDebugMarker',
            synchronousCause
        )
        const synchronousError = await rejectedDiagnostic(() =>
            synchronousFixture.runtime.createSubmission()
                .debug(commandMarker)
                .submit()
        )

        expect(synchronousError.diagnostic).to.deep.include({
            code: 'SCRATCH_DEBUG_COMMAND_NATIVE_FAILED',
            subject: commandMarker.subject,
        })
        expect(synchronousError.cause).to.equal(synchronousCause)

        const validationFixture = await createRenderFixture()
        const renderMarker = validationFixture.runtime.createDebugCommand({
            action: 'insert-marker',
            label: 'validation failure',
        })
        validationFixture.fake.errors.failNext(
            'renderInsertDebugMarker',
            'validation',
            gpuError('GPUValidationError', 'render marker validation failed')
        )
        const submitted = validationFixture.runtime.createSubmission()
            .render(validationFixture.pass, [ renderMarker ])
            .submit()
        const validationError = await rejectedDiagnostic(() => submitted.done)

        expect(validationError.diagnostic.code)
            .to.equal('SCRATCH_SUBMISSION_NATIVE_VALIDATION_FAILED')
        expect(validationError.incident.target).to.deep.include({
            kind: 'submission',
            submissionId: submitted.id,
        })

        const bundleFixture = await createRenderFixture()
        const bundleMarker = bundleFixture.runtime.createDebugCommand({
            action: 'insert-marker',
            label: 'bundle validation failure',
        })
        bundleFixture.fake.errors.failNext(
            'renderBundleInsertDebugMarker',
            'validation',
            gpuError('GPUValidationError', 'bundle marker validation failed')
        )
        const bundleError = await rejectedDiagnostic(() =>
            bundleFixture.runtime.createRenderBundle({
                realization: 'persistent',
                colorFormats: [ 'rgba8unorm' ],
                commands: [ bundleMarker ],
            })
        )

        expect(bundleError.diagnostic.code)
            .to.equal('SCRATCH_RENDER_BUNDLE_NATIVE_VALIDATION_FAILED')
        expect(bundleError.incident.target).to.deep.include({
            kind: 'render-bundle',
            realization: 'persistent',
        })
    })

    it('requires an explicit realization mode and at least one attachment', async() => {

        const fixture = await createRenderFixture()
        const marker = fixture.runtime.createDebugCommand({
            action: 'insert-marker',
            label: 'descriptor validation',
        })

        const missingRealization = await rejectedDiagnostic(() =>
            fixture.runtime.createRenderBundle({
                colorFormats: [ 'rgba8unorm' ],
                commands: [ marker ],
            })
        )
        expect(missingRealization.diagnostic).to.deep.include({
            code: 'SCRATCH_RENDER_BUNDLE_DESCRIPTOR_INVALID',
            phase: 'command',
        })

        const missingAttachment = await rejectedDiagnostic(() =>
            fixture.runtime.createRenderBundle({
                realization: 'persistent',
                colorFormats: [],
                commands: [ marker ],
            })
        )
        expect(missingAttachment.diagnostic).to.deep.include({
            code: 'SCRATCH_RENDER_BUNDLE_DESCRIPTOR_INVALID',
            phase: 'command',
        })
        expect(fixture.fake.calls.renderBundleEncoders).to.have.length(0)
    })

    it('uses the native writesStencil rule including primitive culling', async() => {

        const fixture = await createRenderFixture()
        const culledWriter = await fixture.runtime.createRenderPipeline({
            program: fixture.program,
            targets: [ { format: 'rgba8unorm' } ],
            primitive: { cullMode: 'front' },
            depthStencil: {
                format: 'stencil8',
                stencilFront: { passOp: 'replace' },
                stencilBack: { passOp: 'keep' },
                stencilWriteMask: 0xff,
            },
        })
        const culledDraw = createBundleDraw(fixture.runtime, culledWriter)
        const accepted = await fixture.runtime.createRenderBundle({
            realization: 'persistent',
            colorFormats: [ 'rgba8unorm' ],
            depthStencilFormat: 'stencil8',
            stencilReadOnly: true,
            commands: [ culledDraw ],
        })

        expect(accepted.realizationState).to.equal('ready')
        expect(fixture.fake.calls.renderBundleEncoders).to.have.length(1)

        const effectiveWriter = await fixture.runtime.createRenderPipeline({
            program: fixture.program,
            targets: [ { format: 'rgba8unorm' } ],
            primitive: { cullMode: 'none' },
            depthStencil: {
                format: 'stencil8',
                stencilFront: { passOp: 'replace' },
                stencilBack: { passOp: 'keep' },
                stencilWriteMask: 0xff,
            },
        })
        const effectiveDraw = createBundleDraw(fixture.runtime, effectiveWriter)
        const error = await rejectedDiagnostic(() =>
            fixture.runtime.createRenderBundle({
                realization: 'persistent',
                colorFormats: [ 'rgba8unorm' ],
                depthStencilFormat: 'stencil8',
                stencilReadOnly: true,
                commands: [ effectiveDraw ],
            })
        )

        expect(error.diagnostic.code).to.equal('SCRATCH_RENDER_BUNDLE_READ_ONLY_MISMATCH')
        expect(fixture.fake.calls.renderBundleEncoders).to.have.length(1)
    })

    it('bounds open debug-group evidence without retaining an unbounded stack', async() => {

        const fixture = await createRenderFixture()
        const pushes = Array.from({ length: 40 }, (_, index) =>
            fixture.runtime.createDebugCommand({
                action: 'push-group',
                label: `open group ${index}`,
            })
        )
        const error = await rejectedDiagnostic(() =>
            fixture.runtime.createRenderBundle({
                realization: 'attempt-local',
                colorFormats: [ 'rgba8unorm' ],
                commands: pushes,
            })
        )

        expect(error.diagnostic.code).to.equal('SCRATCH_DEBUG_GROUP_UNBALANCED')
        expect(error.diagnostic.actual).to.deep.include({
            context: 'render-bundle',
            openGroupCountAtEnd: 40,
            omittedOpenCommandCount: 40 - MAX_RETAINED_DEBUG_GROUP_IDS,
        })
        expect(error.diagnostic.actual.openCommandIds)
            .to.deep.equal(pushes.slice(0, MAX_RETAINED_DEBUG_GROUP_IDS).map(command => command.id))
    })

    it('snapshots persistent immediates at creation and attempt-local immediates at submission', async() => {

        const persistentFixture = await createRenderFixture({ immediateSize: 16 })
        const persistentBytes = Uint8Array.from(
            { length: 16 },
            (_, index) => index + 1
        )
        const persistentDraw = createBundleDraw(
            persistentFixture.runtime,
            persistentFixture.pipeline,
            { immediateData: persistentBytes }
        )
        const persistent = await persistentFixture.runtime.createRenderBundle({
            realization: 'persistent',
            colorFormats: [ 'rgba8unorm' ],
            commands: [ persistentDraw ],
        })
        persistentBytes.fill(9)
        const persistentExecute =
            persistentFixture.runtime.createExecuteRenderBundlesCommand({
                bundles: [ persistent ],
            })
        await persistentFixture.runtime.createSubmission()
            .render(persistentFixture.pass, [ persistentExecute ])
            .submit()
            .done

        expect(persistentFixture.fake.calls.immediateWrites).to.have.length(1)
        expect([ ...persistentFixture.fake.calls.immediateWrites[0].bytes ])
            .to.deep.equal(Array.from({ length: 16 }, (_, index) => index + 1))
        expect(persistentFixture.fake.calls.renderBundleEncoders).to.have.length(1)

        const attemptFixture = await createRenderFixture({ immediateSize: 16 })
        const attemptBytes = new Uint8Array(16).fill(5)
        const attemptDraw = createBundleDraw(
            attemptFixture.runtime,
            attemptFixture.pipeline,
            { immediateData: attemptBytes }
        )
        const attempt = await attemptFixture.runtime.createRenderBundle({
            realization: 'attempt-local',
            colorFormats: [ 'rgba8unorm' ],
            commands: [ attemptDraw ],
        })
        attemptBytes.fill(7)
        const attemptExecute = attemptFixture.runtime.createExecuteRenderBundlesCommand({
            bundles: [ attempt, attempt ],
        })
        await attemptFixture.runtime.createSubmission()
            .render(attemptFixture.pass, [ attemptExecute ])
            .submit()
            .done

        expect(attemptFixture.fake.calls.renderBundleEncoders).to.have.length(1)
        expect(attemptFixture.fake.calls.renderBundleExecutions[0].bundles[0])
            .to.equal(attemptFixture.fake.calls.renderBundleExecutions[0].bundles[1])
        expect(attemptFixture.fake.calls.immediateWrites).to.have.length(1)
        expect([ ...attemptFixture.fake.calls.immediateWrites[0].bytes ])
            .to.deep.equal(new Array(16).fill(7))
    })

    it('invalidates a persistent bundle after explicit BindSet re-preparation', async() => {

        const fixture = await createUniformBindingFixture()
        const draw = fixture.runtime.createBundleDrawCommand({
            pipeline: fixture.pipeline,
            bindSets: [ { set: fixture.bindSet } ],
            count: { vertexCount: 3 },
            resources: {
                read: [ {
                    resource: fixture.uniform,
                    contentEpoch: fixture.uniform.contentEpoch,
                } ],
                write: [],
            },
            whenMissing: 'throw',
        })
        const bundle = await fixture.runtime.createRenderBundle({
            realization: 'persistent',
            colorFormats: [ 'rgba8unorm' ],
            commands: [ draw ],
        })
        const initialGeneration = fixture.bindSet.prepareGeneration

        replaceResourceAllocationForTest(fixture.uniform)
        await fixture.bindSet.prepare()

        expect(fixture.bindSet.prepareGeneration).to.equal(initialGeneration + 1)
        expect(bundle.realizationState).to.equal('stale')
        const execute = fixture.runtime.createExecuteRenderBundlesCommand({
            bundles: [ bundle ],
        })
        const error = await rejectedDiagnostic(() =>
            fixture.runtime.createSubmission()
                .render(fixture.pass, [ execute ])
                .submit()
        )
        expect(error.diagnostic.code).to.equal('SCRATCH_RENDER_BUNDLE_STALE')
        expect(fixture.fake.calls.renderBundleEncoders).to.have.length(1)
        expect(fixture.fake.calls.commandEncoders).to.have.length(0)
    })

    it('advances nested declared writes once per native bundle occurrence with provenance', async() => {

        const fixture = await createRenderFixture()
        const output = await fixture.runtime.createBuffer({
            size: 16,
            usage: GPU_BUFFER_USAGE_STORAGE,
        })
        const draw = createBundleDraw(fixture.runtime, fixture.pipeline, {
            resources: { read: [], write: [ output ] },
        })
        const bundle = await fixture.runtime.createRenderBundle({
            realization: 'persistent',
            colorFormats: [ 'rgba8unorm' ],
            commands: [ draw ],
        })
        expect(output.contentEpoch).to.equal(0)

        const execute = fixture.runtime.createExecuteRenderBundlesCommand({
            bundles: [ bundle, bundle ],
        })
        const submitted = fixture.runtime.createSubmission()
            .render(fixture.pass, [ execute ])
            .submit()
        const writes = submitted.resourceAccesses.filter(access =>
            access.resourceId === output.id && access.access === 'write'
        )

        expect(output.contentEpoch).to.equal(2)
        expect(writes.map(access => ({
            stepKind: access.stepKind,
            commandKind: access.commandKind,
            commandId: access.commandId,
            before: access.contentEpochBefore,
            after: access.contentEpochAfter,
        }))).to.deep.equal([
            {
                stepKind: 'render',
                commandKind: 'bundle-draw',
                commandId: draw.id,
                before: 0,
                after: 1,
            },
            {
                stepKind: 'render',
                commandKind: 'bundle-draw',
                commandId: draw.id,
                before: 1,
                after: 2,
            },
        ])
        expect(submitted.renderBundles).to.have.length(2)
        expect(submitted.potentialWrites).to.deep.include({
            kind: 'resource',
            resourceId: output.id,
            resourceKind: 'BufferResource',
            subject: output.subject,
            allocationVersion: output.allocationVersion,
            contentEpoch: 2,
        })
        await submitted.done
    })

    it('does not advance bundle writes when executeBundles throws synchronously', async() => {

        const fixture = await createRenderFixture()
        const output = await fixture.runtime.createBuffer({
            size: 16,
            usage: GPU_BUFFER_USAGE_STORAGE,
        })
        const draw = createBundleDraw(fixture.runtime, fixture.pipeline, {
            resources: { read: [], write: [ output ] },
        })
        const bundle = await fixture.runtime.createRenderBundle({
            realization: 'persistent',
            colorFormats: [ 'rgba8unorm' ],
            commands: [ draw ],
        })
        const execute = fixture.runtime.createExecuteRenderBundlesCommand({
            bundles: [ bundle ],
        })
        const nativeCause = new TypeError('executeBundles failed')
        fixture.fake.errors.throwNext('executeBundles', nativeCause)

        const error = await rejectedDiagnostic(() =>
            fixture.runtime.createSubmission()
                .render(fixture.pass, [ execute ])
                .submit()
        )
        expect(error.diagnostic.code).to.equal('SCRATCH_RENDER_BUNDLE_EXECUTION_FAILED')
        expect(error.cause).to.equal(nativeCause)
        expect(output.contentEpoch).to.equal(0)
    })

    it('accepts trailing-null layout equivalence and rejects pass read-only mismatch', async() => {

        const fixture = await createRenderFixture()
        const draw = createBundleDraw(fixture.runtime, fixture.pipeline)
        const trailingNull = await fixture.runtime.createRenderBundle({
            realization: 'persistent',
            colorFormats: [ 'rgba8unorm', null ],
            commands: [ draw ],
        })
        const executeTrailing = fixture.runtime.createExecuteRenderBundlesCommand({
            bundles: [ trailingNull ],
        })
        await fixture.runtime.createSubmission()
            .render(fixture.pass, [ executeTrailing ])
            .submit()
            .done

        const depthFixture = await createDepthFixture()
        const depthDraw = createBundleDraw(depthFixture.runtime, depthFixture.pipeline)
        const writableDeclaration = await depthFixture.runtime.createRenderBundle({
            realization: 'persistent',
            colorFormats: [],
            depthStencilFormat: 'depth24plus',
            depthReadOnly: false,
            commands: [ depthDraw ],
        })
        const executeDepth = depthFixture.runtime.createExecuteRenderBundlesCommand({
            bundles: [ writableDeclaration ],
        })
        const error = await rejectedDiagnostic(() =>
            depthFixture.runtime.createSubmission()
                .render(depthFixture.readOnlyPass, [ executeDepth ])
                .submit()
        )

        expect(error.diagnostic.code).to.equal('SCRATCH_RENDER_BUNDLE_PASS_INCOMPATIBLE')
        expect(depthFixture.fake.calls.commandEncoders).to.have.length(0)
    })

    it('records bounded exact-operation evidence for persistent native creation', async() => {

        const fixture = await createRenderFixture()
        const draw = createBundleDraw(fixture.runtime, fixture.pipeline)
        const bundle = await fixture.runtime.createRenderBundle({
            label: 'operation evidence',
            realization: 'persistent',
            colorFormats: [ 'rgba8unorm' ],
            commands: [ draw ],
        })
        const operation = fixture.runtime.diagnostics.operations({
            kind: 'render-bundle-creation',
            renderBundleId: bundle.id,
        })[0]

        expect(operation).to.deep.include({
            kind: 'render-bundle-creation',
            status: 'succeeded',
            target: {
                kind: 'render-bundle',
                renderBundleId: bundle.id,
                realization: 'persistent',
                colorFormats: [ 'rgba8unorm' ],
                sampleCount: 1,
                depthReadOnly: false,
                stencilReadOnly: false,
                commandCount: 1,
            },
        })
        expect(operation.descriptor.summary).to.deep.include({
            realization: 'persistent',
            commandCount: 1,
            bundleDrawCount: 1,
            debugCommandCount: 0,
        })
        expect(JSON.stringify(operation)).to.not.include(draw.id)
        expect(fixture.runtime.diagnostics.snapshot().pendingOperations).to.deep.equal([])
    })

    for (const failure of [
        {
            name: 'validation',
            method: 'renderBundleFinish',
            filter: 'validation',
            nativeName: 'GPUValidationError',
            code: 'SCRATCH_RENDER_BUNDLE_NATIVE_VALIDATION_FAILED',
        },
        {
            name: 'internal',
            method: 'renderBundleFinish',
            filter: 'internal',
            nativeName: 'GPUInternalError',
            code: 'SCRATCH_RENDER_BUNDLE_NATIVE_INTERNAL_FAILED',
        },
        {
            name: 'out of memory',
            method: 'createRenderBundleEncoder',
            filter: 'out-of-memory',
            nativeName: 'GPUOutOfMemoryError',
            code: 'SCRATCH_RENDER_BUNDLE_NATIVE_OUT_OF_MEMORY',
        },
        {
            name: 'synchronous exception',
            method: 'createRenderBundleEncoder',
            nativeName: 'TypeError',
            code: 'SCRATCH_RENDER_BUNDLE_NATIVE_CREATION_FAILED',
        },
    ]) {
        it(`attributes persistent ${failure.name} to its exact creation operation`, async() => {

            const fixture = await createRenderFixture()
            const draw = createBundleDraw(fixture.runtime, fixture.pipeline)
            const nativeCause = gpuError(failure.nativeName, `${failure.name} bundle failure`)
            if (failure.filter === undefined) {
                fixture.fake.errors.throwNext(failure.method, nativeCause)
            } else {
                fixture.fake.errors.failNext(failure.method, failure.filter, nativeCause)
            }

            const error = await rejectedDiagnostic(() =>
                fixture.runtime.createRenderBundle({
                    realization: 'persistent',
                    colorFormats: [ 'rgba8unorm' ],
                    commands: [ draw ],
                })
            )
            const renderBundleId = error.incident.target.renderBundleId
            const operation = fixture.runtime.diagnostics.operations({
                kind: 'render-bundle-creation',
                renderBundleId,
            })[0]
            const incidents = fixture.runtime.diagnostics.incidents({ renderBundleId })

            expect(error.diagnostic.code).to.equal(failure.code)
            expect(operation).to.deep.include({
                kind: 'render-bundle-creation',
                status: 'failed',
            })
            expect(incidents).to.have.length(1)
            expect(incidents[0]).to.deep.include({
                kind: 'supporting-object-failure',
                operationId: operation.id,
                attribution: 'exact-operation',
                target: operation.target,
                diagnosticCode: failure.code,
            })
            expect(fixture.runtime.diagnostics.snapshot().pendingOperations).to.deep.equal([])
        })
    }

    it('settles a pending persistent creation when Runtime disposal wins the race', async() => {

        const fixture = await createRenderFixture()
        const draw = createBundleDraw(fixture.runtime, fixture.pipeline)
        fixture.fakeOptions.deferErrorScopePops = true
        const creation = fixture.runtime.createRenderBundle({
            realization: 'persistent',
            colorFormats: [ 'rgba8unorm' ],
            commands: [ draw ],
        })

        expect(fixture.fake.errors.pendingPops.filter(pop => !pop.settled)).to.have.length(3)
        fixture.runtime.dispose()
        settleAllPops(fixture.fake)
        const error = await rejectedDiagnostic(() => creation)

        expect(error.diagnostic.code).to.equal('SCRATCH_RUNTIME_DISPOSED')
        expect(error.incident).to.deep.include({
            kind: 'supporting-object-failure',
            failureStage: 'lifecycle-recheck',
        })
        expect(error.incident.triggerOperation.status).to.equal('cancelled')
        expect(fixture.runtime.diagnostics.snapshot().pendingOperations).to.deep.equal([])
    })

    it('rejects wrong-runtime, forged, and disposed bundle contracts before native effects', async() => {

        const fixtureA = await createRenderFixture()
        const fixtureB = await createRenderFixture()
        const draw = createBundleDraw(fixtureA.runtime, fixtureA.pipeline)
        const bundle = await fixtureA.runtime.createRenderBundle({
            realization: 'persistent',
            colorFormats: [ 'rgba8unorm' ],
            commands: [ draw ],
        })

        const wrongRuntime = await rejectedDiagnostic(() =>
            fixtureB.runtime.createExecuteRenderBundlesCommand({
                bundles: [ bundle ],
            })
        )
        expect(wrongRuntime.diagnostic.code).to.equal('SCRATCH_RENDER_BUNDLE_WRONG_RUNTIME')

        const forged = Object.create(scr.RenderBundle.prototype)
        const forgedError = await rejectedDiagnostic(() =>
            fixtureA.runtime.createExecuteRenderBundlesCommand({
                bundles: [ forged ],
            })
        )
        expect(forgedError.diagnostic.code)
            .to.equal('SCRATCH_RENDER_BUNDLE_EXECUTION_DESCRIPTOR_INVALID')

        expect(() => new scr.RenderBundle()).to.throw(TypeError)
        expect(() => new scr.BundleDrawCommand()).to.throw(TypeError)
        expect(() => new scr.DebugCommand()).to.throw(TypeError)
        expect(() => new scr.ExecuteRenderBundlesCommand()).to.throw(TypeError)

        fixtureA.runtime.dispose()
        expect(bundle.realizationState).to.equal('disposed')
        expect(() => bundle.assertUsable()).to.throw(scr.ScratchDiagnosticError)
        expect(fixtureA.fake.calls.commandEncoders).to.have.length(0)
    })

    it('reuses one persistent native bundle across a bounded submission stress run', async() => {

        const fixture = await createRenderFixture()
        const draw = createBundleDraw(fixture.runtime, fixture.pipeline)
        const bundle = await fixture.runtime.createRenderBundle({
            realization: 'persistent',
            colorFormats: [ 'rgba8unorm' ],
            commands: [ draw ],
        })
        const execute = fixture.runtime.createExecuteRenderBundlesCommand({
            bundles: [ bundle ],
        })
        const runCount = 128

        for (let index = 0; index < runCount; index++) {
            await fixture.runtime.createSubmission()
                .render(fixture.pass, [ execute ])
                .submit()
                .done
        }

        expect(fixture.fake.calls.renderBundleEncoders).to.have.length(1)
        expect(fixture.fake.calls.renderBundles).to.have.length(1)
        expect(fixture.fake.calls.renderBundleExecutions).to.have.length(runCount)
        expect(fixture.runtime.diagnostics.operations({
            kind: 'render-bundle-creation',
            renderBundleId: bundle.id,
        })).to.have.length(1)
        expect(fixture.runtime.diagnostics.snapshot().pendingOperations).to.deep.equal([])
    })
})

async function createRenderFixture(options = {}) {

    const fakeOptions = { deferErrorScopePops: false }
    const fake = createFakeGpu(fakeOptions)
    if (options.immediateSize !== undefined) {
        fake.gpu.wgslLanguageFeatures = new Set([ 'immediate_address_space' ])
        fake.device.limits.maxImmediateSize = 64
        fake.adapter.limits.maxImmediateSize = 64
    }
    const runtime = await scr.ScratchRuntime.create({ gpu: fake.gpu })
    const target = await runtime.createTexture({
        size: [ 16, 12 ],
        format: 'rgba8unorm',
        usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
    })
    const program = await createTestProgram(runtime, {
        sourceParts: [ triangleWgsl ],
        vertex: 'vsMain',
        fragment: 'fsMain',
        ...(options.immediateSize !== undefined
            ? { requiredLanguageFeatures: [ 'immediate_address_space' ] }
            : {}),
    })
    const pipeline = await runtime.createRenderPipeline({
        program,
        targets: [ { format: 'rgba8unorm' } ],
        ...(options.immediateSize !== undefined
            ? { immediateSize: options.immediateSize }
            : {}),
        ...(options.vertexBuffers !== undefined
            ? { vertexBuffers: options.vertexBuffers }
            : {}),
    })
    const pass = runtime.createRenderPass({
        color: [ { target: target.view() } ],
    })

    return { fake, fakeOptions, runtime, target, program, pipeline, pass }
}

function createBundleDraw(runtime, pipeline, overrides = {}) {

    return runtime.createBundleDrawCommand({
        pipeline,
        count: { vertexCount: 3 },
        resources: { read: [], write: [] },
        whenMissing: 'throw',
        ...overrides,
    })
}

async function createUniformBindingFixture() {

    const fixture = await createRenderFixture()
    const uniform = await fixture.runtime.createBuffer({
        size: 16,
        usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
    })
    const layout = await fixture.runtime.createBindLayout({
        group: 0,
        entries: [ {
            binding: 0,
            name: 'uniforms',
            type: 'uniform',
            visibility: [ 'vertex' ],
        } ],
    })
    const bindSet = await fixture.runtime.createBindSet(layout, {
        uniforms: uniform.region(),
    })
    const pipeline = await fixture.runtime.createRenderPipeline({
        program: fixture.program,
        layout: { mode: 'explicit', bindLayouts: [ layout ] },
        targets: [ { format: 'rgba8unorm' } ],
    })
    return { ...fixture, uniform, layout, bindSet, pipeline }
}

async function createDepthFixture() {

    const fakeOptions = { deferErrorScopePops: false }
    const fake = createFakeGpu(fakeOptions)
    const runtime = await scr.ScratchRuntime.create({ gpu: fake.gpu })
    const depth = await runtime.createTexture({
        size: [ 8, 8 ],
        format: 'depth24plus',
        usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
    })
    const module = await runtime.createShaderModule({
        sourceParts: [ { code: triangleWgsl } ],
    })
    const pipeline = await runtime.createRenderPipeline({
        program: runtime.createProgram({
            vertex: { module, entryPoint: 'vsMain' },
        }),
        depthStencil: {
            format: 'depth24plus',
            depthWriteEnabled: false,
            depthCompare: 'less',
        },
    })
    const readOnlyPass = runtime.createRenderPass({
        color: [],
        depth: {
            target: depth.view(),
            depthReadOnly: true,
        },
    })
    return { fake, fakeOptions, runtime, depth, pipeline, readOnlyPass }
}

function settleAllPops(fake) {

    for (const [ index, pending ] of fake.errors.pendingPops.entries()) {
        if (!pending.settled) fake.errors.settlePop(index)
    }
}

function gpuError(name, message) {

    return Object.assign(new Error(message), { name })
}

async function rejectedDiagnostic(action) {

    try {
        await action()
        throw new Error('expected Scratch diagnostic')
    } catch (error) {
        expect(error).to.be.instanceOf(scr.ScratchDiagnosticError)
        return error
    }
}
