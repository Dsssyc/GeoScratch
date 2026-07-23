import { createTestProgram } from './scratch-test-utils.js'
import { expect } from 'chai'
import {
    DispatchCommand,
    DrawCommand,
    ScratchDiagnosticError,
    ScratchRuntime,
} from 'geoscratch'
import {
    createFakeGpu,
    defaultRenderStateActions,
    replaceResourceAllocationForTest,
    triangleWgsl,
} from './scratch-test-utils.js'

const GPU_BUFFER_USAGE_COPY_DST = 0x08
const GPU_BUFFER_USAGE_INDEX = 0x10
const GPU_BUFFER_USAGE_STORAGE = 0x80
const GPU_BUFFER_USAGE_INDIRECT = 0x100
const GPU_BUFFER_USAGE_VERTEX = 0x20
const GPU_TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10

function readResource(resource, contentEpoch = resource.contentEpoch) {

    return { resource, contentEpoch }
}

async function createRenderFixture() {

    const fake = createFakeGpu()
    const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
    const program = await createTestProgram(runtime, {
        sourceParts: [ triangleWgsl ],
        vertex: 'vsMain',
        fragment: 'fsMain',
    })
    const pipeline = await runtime.createRenderPipeline({
        program,
        targets: [ { format: 'rgba8unorm' } ],
    })
    const target = await runtime.createTexture({
        size: { width: 4, height: 4 },
        format: 'rgba8unorm',
        usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
    })
    const pass = runtime.createRenderPass({
        color: [ {
            target: target.view(),
            load: 'clear',
            store: 'store',
            clear: [ 0, 0, 0, 1 ],
        } ],
    })

    return { ...fake, runtime, program, pipeline, pass }
}

async function createComputeFixture() {

    const fake = createFakeGpu()
    const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
    const program = await createTestProgram(runtime, {
        sourceParts: [ '@compute @workgroup_size(1) fn csMain() {}' ],
        compute: 'csMain',
    })
    const pipeline = await runtime.createComputePipeline({
        program,
        compute: 'csMain',
    })
    const pass = runtime.createComputePass()

    return { ...fake, runtime, pipeline, pass }
}

async function expectDiagnostic(action, code) {

    try {
        action()
        throw new Error(`expected ${code}`)
    } catch (error) {
        expect(error).to.be.instanceOf(ScratchDiagnosticError)
        expect(error.diagnostic).to.include({ code, severity: 'error' })
        return error.diagnostic
    }
}

describe('scratch native indexed and indirect execution', () => {

    it('encodes a static indexed draw through setIndexBuffer and drawIndexed', async() => {

        const fixture = await createRenderFixture()
        const indexBuffer = await fixture.runtime.createBuffer({
            size: 8,
            usage: GPU_BUFFER_USAGE_INDEX | GPU_BUFFER_USAGE_COPY_DST,
        })
        const upload = fixture.runtime.createUploadCommand({
            target: (indexBuffer).region(),
            data: new Uint16Array([ 0, 1, 2, 0 ]),
        })
        const draw = fixture.runtime.createDrawCommand({
            pipeline: fixture.pipeline,
            indexBuffer: {
                region: indexBuffer.region({ size: 8 }),
                format: 'uint16',
            },
            count: {
                indexCount: 3,
                instanceCount: 2,
                firstIndex: 0,
                baseVertex: -1,
                firstInstance: 4,
            },
            resources: {
                read: [ readResource(indexBuffer, 1) ],
                write: [],
            },
            whenMissing: 'throw',
        })

        fixture.runtime.createSubmission({ validation: 'throw' })
            .upload(upload)
            .render(fixture.pass, [ draw ])
            .submit()

        expect(draw).to.be.instanceOf(DrawCommand)
        expect(fixture.calls.renderPasses[0].actions).to.deep.equal([
            { type: 'setPipeline', pipeline: fixture.pipeline.gpuPipeline },
            ...defaultRenderStateActions(4, 4),
            {
                type: 'setIndexBuffer',
                buffer: indexBuffer.gpuBuffer,
                indexFormat: 'uint16',
                offset: 0,
                size: 8,
            },
            {
                type: 'drawIndexed',
                call: {
                    indexCount: 3,
                    instanceCount: 2,
                    firstIndex: 0,
                    baseVertex: -1,
                    firstInstance: 4,
                },
            },
            { type: 'end' },
        ])
    })

    it('accepts uint32 index bindings with four-byte aligned ranges', async() => {

        const fixture = await createRenderFixture()
        const indexBuffer = await fixture.runtime.createBuffer({
            size: 16,
            usage: GPU_BUFFER_USAGE_INDEX | GPU_BUFFER_USAGE_COPY_DST,
        })
        const upload = fixture.runtime.createUploadCommand({
            target: (indexBuffer).region(),
            data: new Uint32Array([ 9, 0, 1, 2 ]),
        })
        const draw = fixture.runtime.createDrawCommand({
            pipeline: fixture.pipeline,
            indexBuffer: {
                region: indexBuffer.region({ offset: 4, size: 12 }),
                format: 'uint32',
            },
            count: { indexCount: 3 },
            resources: { read: [ readResource(indexBuffer, 1) ], write: [] },
            whenMissing: 'throw',
        })

        fixture.runtime.createSubmission({ validation: 'throw' })
            .upload(upload)
            .render(fixture.pass, [ draw ])
            .submit()

        expect(fixture.calls.renderPasses[0].actions.find(
            action => action.type === 'setIndexBuffer'
        )).to.deep.equal({
            type: 'setIndexBuffer',
            buffer: indexBuffer.gpuBuffer,
            indexFormat: 'uint32',
            offset: 4,
            size: 12,
        })
    })

    it('accepts zero-count direct draw and dispatch commands as no-ops', async() => {

        const render = await createRenderFixture()
        const drawOutput = await render.runtime.createBuffer({ size: 4, usage: GPU_BUFFER_USAGE_STORAGE })
        const indexedOutput = await render.runtime.createBuffer({ size: 4, usage: GPU_BUFFER_USAGE_STORAGE })
        const draw = render.runtime.createDrawCommand({
            pipeline: render.pipeline,
            count: { vertexCount: 0, instanceCount: 0 },
            resources: { read: [], write: [ drawOutput ] },
            whenMissing: 'throw',
        })
        const indexBuffer = await render.runtime.createBuffer({
            size: 4,
            usage: GPU_BUFFER_USAGE_INDEX | GPU_BUFFER_USAGE_COPY_DST,
        })
        const uploadIndices = render.runtime.createUploadCommand({
            target: (indexBuffer).region(),
            data: new Uint16Array([ 0, 0 ]),
        })
        const indexedDraw = render.runtime.createDrawCommand({
            pipeline: render.pipeline,
            indexBuffer: { region: indexBuffer.region({ size: 0 }), format: 'uint16' },
            count: { indexCount: 0, instanceCount: 0 },
            resources: { read: [ readResource(indexBuffer, 1) ], write: [ indexedOutput ] },
            whenMissing: 'throw',
        })

        const rendered = render.runtime.createSubmission({ validation: 'throw' })
            .upload(uploadIndices)
            .render(render.pass, [ draw, indexedDraw ])
            .submit()

        expect(render.calls.renderPasses[0].actions).to.deep.equal([
            { type: 'setPipeline', pipeline: render.pipeline.gpuPipeline },
            ...defaultRenderStateActions(4, 4),
            {
                type: 'draw',
                call: { vertexCount: 0, instanceCount: 0, firstVertex: 0, firstInstance: 0 },
            },
            { type: 'setPipeline', pipeline: render.pipeline.gpuPipeline },
            ...defaultRenderStateActions(4, 4),
            {
                type: 'setIndexBuffer',
                buffer: indexBuffer.gpuBuffer,
                indexFormat: 'uint16',
                offset: 0,
                size: 0,
            },
            {
                type: 'drawIndexed',
                call: { indexCount: 0, instanceCount: 0, firstIndex: 0, baseVertex: 0, firstInstance: 0 },
            },
            { type: 'end' },
        ])
        expect(drawOutput).to.include({ contentEpoch: 0, state: 'empty' })
        expect(indexedOutput).to.include({ contentEpoch: 0, state: 'empty' })
        expect(rendered.resourceAccesses.some(access =>
            access.access === 'write' && [ drawOutput.id, indexedOutput.id ].includes(access.resourceId)
        )).to.equal(false)
        expect(rendered.producerEpochs.some(epoch =>
            [ drawOutput.id, indexedOutput.id ].includes(epoch.resourceId)
        )).to.equal(false)

        const compute = await createComputeFixture()
        const dispatchOutput = await compute.runtime.createBuffer({ size: 4, usage: GPU_BUFFER_USAGE_STORAGE })
        const dispatch = compute.runtime.createDispatchCommand({
            pipeline: compute.pipeline,
            count: { workgroups: [ 0, 1, 1 ] },
            resources: { read: [], write: [ dispatchOutput ] },
            whenMissing: 'throw',
        })

        const computed = compute.runtime.createSubmission({ validation: 'throw' })
            .compute(compute.pass, [ dispatch ])
            .submit()

        expect(dispatch).to.be.instanceOf(DispatchCommand)
        expect(compute.calls.computePasses[0].actions[1]).to.deep.equal({
            type: 'dispatchWorkgroups',
            call: { x: 0, y: 1, z: 1 },
        })
        expect(dispatchOutput).to.include({ contentEpoch: 0, state: 'empty' })
        expect(computed.resourceAccesses.some(access =>
            access.access === 'write' && access.resourceId === dispatchOutput.id
        )).to.equal(false)
        expect(computed.producerEpochs.some(epoch => epoch.resourceId === dispatchOutput.id)).to.equal(false)
    })

    it('rejects invalid direct integer ranges with structured count diagnostics', async() => {

        const render = await createRenderFixture()
        const drawCounts = [
            { vertexCount: 0.5 },
            { vertexCount: 0x1_0000_0000 },
            { vertexCount: 1, instanceCount: -1 },
            { vertexCount: 1, firstVertex: Number.NaN },
        ]
        for (const count of drawCounts) {
            const diagnostic = await expectDiagnostic(() => render.runtime.createDrawCommand({
                pipeline: render.pipeline,
                count,
                resources: { read: [], write: [] },
                whenMissing: 'throw',
            }), 'SCRATCH_COMMAND_COUNT_INVALID')
            expect(diagnostic.phase).to.equal('command')
            expect(diagnostic.related).to.deep.include(render.pipeline.subject)
            expect(diagnostic.expected).to.be.an('object')
            expect(diagnostic.actual).to.be.an('object')
        }

        const indexBuffer = await render.runtime.createBuffer({
            size: 8,
            usage: GPU_BUFFER_USAGE_INDEX,
        })
        const indexCases = [
            { indexCount: 0.5 },
            { indexCount: 1, baseVertex: 0x8000_0000 },
            { indexCount: 1, baseVertex: -0x8000_0001 },
        ]
        for (const count of indexCases) {
            await expectDiagnostic(() => render.runtime.createDrawCommand({
                pipeline: render.pipeline,
                indexBuffer: { region: indexBuffer.region(), format: 'uint16' },
                count,
                resources: { read: [ readResource(indexBuffer) ], write: [] },
                whenMissing: 'throw',
            }), 'SCRATCH_COMMAND_COUNT_INVALID')
        }

        const compute = await createComputeFixture()
        const dispatchDiagnostic = await expectDiagnostic(() => compute.runtime.createDispatchCommand({
            pipeline: compute.pipeline,
            count: { workgroups: [ 65_536 ] },
            resources: { read: [], write: [] },
            whenMissing: 'throw',
        }), 'SCRATCH_COMMAND_COUNT_INVALID')
        expect(dispatchDiagnostic.related).to.deep.include(compute.pipeline.subject)
    })

    it('reports the complete native count alternatives without stale slice wording', async() => {

        const render = await createRenderFixture()
        const drawDiagnostic = await expectDiagnostic(() => render.runtime.createDrawCommand({
            pipeline: render.pipeline,
            count: {},
            resources: { read: [], write: [] },
            whenMissing: 'throw',
        }), 'SCRATCH_COMMAND_COUNT_INVALID')
        expect(drawDiagnostic.message).to.not.include('for this slice')
        expect(drawDiagnostic.expected.count).to.deep.equal([
            '{ vertexCount: GPUSize32, ... }',
            '{ indexCount: GPUSize32, ... } with indexBuffer',
            '{ indirect: BufferRegion }',
        ])
        expect(drawDiagnostic.related).to.deep.include(render.pipeline.subject)

        const compute = await createComputeFixture()
        const dispatchDiagnostic = await expectDiagnostic(() => compute.runtime.createDispatchCommand({
            pipeline: compute.pipeline,
            count: {},
            resources: { read: [], write: [] },
            whenMissing: 'throw',
        }), 'SCRATCH_COMMAND_COUNT_INVALID')
        expect(dispatchDiagnostic.message).to.not.include('for this slice')
        expect(dispatchDiagnostic.expected.count).to.deep.equal([
            '{ workgroups: [GPUSize32, GPUSize32?, GPUSize32?] }',
            '{ indirect: BufferRegion }',
        ])
        expect(dispatchDiagnostic.related).to.deep.include(compute.pipeline.subject)
    })

    it('rejects mixed count variants instead of selecting a precedence path', async() => {

        const render = await createRenderFixture()
        const indirect = await render.runtime.createBuffer({ size: 20, usage: GPU_BUFFER_USAGE_INDIRECT })
        const mixedDrawCounts = [
            { vertexCount: 3, indirect: indirect.region() },
            { vertexCount: 3, indexCount: 3 },
            { indexCount: 3, indirect: indirect.region() },
        ]
        for (const count of mixedDrawCounts) {
            await expectDiagnostic(() => render.runtime.createDrawCommand({
                pipeline: render.pipeline,
                count,
                resources: { read: [ readResource(indirect) ], write: [] },
                whenMissing: 'throw',
            }), 'SCRATCH_COMMAND_COUNT_INVALID')
        }

        const compute = await createComputeFixture()
        const dispatchIndirect = await compute.runtime.createBuffer({ size: 12, usage: GPU_BUFFER_USAGE_INDIRECT })
        await expectDiagnostic(() => compute.runtime.createDispatchCommand({
            pipeline: compute.pipeline,
            count: { workgroups: [ 1 ], indirect: dispatchIndirect.region() },
            resources: { read: [ readResource(dispatchIndirect) ], write: [] },
            whenMissing: 'throw',
        }), 'SCRATCH_COMMAND_COUNT_INVALID')
    })

    it('rejects invalid static index bindings and count pairings', async() => {

        const fixture = await createRenderFixture()
        const valid = await fixture.runtime.createBuffer({
            size: 8,
            usage: GPU_BUFFER_USAGE_INDEX,
        })
        const missingUsage = await fixture.runtime.createBuffer({
            size: 8,
            usage: GPU_BUFFER_USAGE_STORAGE,
        })

        const cases = [
            {
                descriptor: { region: valid.region(), format: 'uint8' },
                resource: valid,
                code: 'SCRATCH_COMMAND_INDEX_BUFFER_INVALID',
            },
            {
                descriptor: { region: valid.region({ offset: 2 }), format: 'uint32' },
                resource: valid,
                code: 'SCRATCH_COMMAND_INDEX_BUFFER_INVALID',
            },
            {
                descriptor: { region: valid.region({ size: 3 }), format: 'uint16' },
                resource: valid,
                code: 'SCRATCH_COMMAND_INDEX_BUFFER_INVALID',
            },
            {
                descriptor: { region: valid.region({ size: 0 }), format: 'uint16' },
                resource: valid,
                code: 'SCRATCH_COMMAND_INDEX_BUFFER_INVALID',
            },
            {
                descriptor: { region: missingUsage.region(), format: 'uint16' },
                resource: missingUsage,
                code: 'SCRATCH_RESOURCE_USAGE_MISSING',
            },
        ]

        for (const testCase of cases) {
            await expectDiagnostic(() => fixture.runtime.createDrawCommand({
                pipeline: fixture.pipeline,
                indexBuffer: testCase.descriptor,
                count: { indexCount: 3 },
                resources: { read: [ readResource(testCase.resource) ], write: [] },
                whenMissing: 'throw',
            }), testCase.code)
        }

        const indexedRangeDiagnostic = await expectDiagnostic(() => fixture.runtime.createDrawCommand({
            pipeline: fixture.pipeline,
            indexBuffer: { region: valid.region({ size: 4 }), format: 'uint16' },
            count: { indexCount: 3 },
            resources: { read: [ readResource(valid) ], write: [] },
            whenMissing: 'throw',
        }), 'SCRATCH_COMMAND_INDEX_BUFFER_INVALID')
        expect(indexedRangeDiagnostic.expected).to.deep.equal({
            indexedRange: 'firstIndex + indexCount within complete indices in the bound range',
        })
        expect(indexedRangeDiagnostic.actual).to.deep.include({
            firstIndex: 0,
            indexCount: 3,
            availableIndexCount: 2,
            bindingSize: 4,
        })

        await expectDiagnostic(() => fixture.runtime.createDrawCommand({
            pipeline: fixture.pipeline,
            count: { indexCount: 3 },
            resources: { read: [ readResource(valid) ], write: [] },
            whenMissing: 'throw',
        }), 'SCRATCH_COMMAND_INDEX_BUFFER_INVALID')

        await expectDiagnostic(() => fixture.runtime.createDrawCommand({
            pipeline: fixture.pipeline,
            indexBuffer: { region: valid.region(), format: 'uint16' },
            count: { vertexCount: 3 },
            resources: { read: [ readResource(valid) ], write: [] },
            whenMissing: 'throw',
        }), 'SCRATCH_COMMAND_INDEX_BUFFER_INVALID')

        const foreignRuntime = await ScratchRuntime.create({ gpu: createFakeGpu().gpu })
        const foreign = await foreignRuntime.createBuffer({ size: 8, usage: GPU_BUFFER_USAGE_INDEX })
        await expectDiagnostic(() => fixture.runtime.createDrawCommand({
            pipeline: fixture.pipeline,
            indexBuffer: { region: foreign.region(), format: 'uint16' },
            count: { indexCount: 3 },
            resources: { read: [ readResource(foreign) ], write: [] },
            whenMissing: 'throw',
        }), 'SCRATCH_RESOURCE_WRONG_RUNTIME')

        const disposed = await fixture.runtime.createBuffer({ size: 8, usage: GPU_BUFFER_USAGE_INDEX })
        const disposedRegion = disposed.region()
        disposed.dispose()
        await expectDiagnostic(() => fixture.runtime.createDrawCommand({
            pipeline: fixture.pipeline,
            indexBuffer: { region: disposedRegion, format: 'uint16' },
            count: { indexCount: 3 },
            resources: { read: [ readResource(disposed) ], write: [] },
            whenMissing: 'throw',
        }), 'SCRATCH_RESOURCE_DISPOSED')
    })

    it('validates strip pipeline index formats before native encoding', async() => {

        const fixture = await createRenderFixture()
        const stripPipeline = await fixture.runtime.createRenderPipeline({
            program: fixture.program,
            primitive: {
                topology: 'triangle-strip',
                stripIndexFormat: 'uint16',
            },
            targets: [ { format: 'rgba8unorm' } ],
        })
        const indexBuffer = await fixture.runtime.createBuffer({ size: 8, usage: GPU_BUFFER_USAGE_INDEX })
        const diagnostic = await expectDiagnostic(() => fixture.runtime.createDrawCommand({
            pipeline: stripPipeline,
            indexBuffer: { region: indexBuffer.region(), format: 'uint32' },
            count: { indexCount: 1 },
            resources: { read: [ readResource(indexBuffer) ], write: [] },
            whenMissing: 'throw',
        }), 'SCRATCH_COMMAND_INDEX_BUFFER_INVALID')
        expect(diagnostic.expected).to.deep.equal({ indexFormat: 'uint16' })
        expect(diagnostic.actual).to.deep.include({
            indexFormat: 'uint32',
            topology: 'triangle-strip',
        })
    })

    it('requires every pipeline vertex slot for direct, indexed, and indirect draws', async() => {

        const fixture = await createRenderFixture()
        const vertexPipeline = await fixture.runtime.createRenderPipeline({
            program: fixture.program,
            vertexBuffers: [ {
                arrayStride: 8,
                attributes: [ { shaderLocation: 0, offset: 0, format: 'float32x2' } ],
            } ],
            targets: [ { format: 'rgba8unorm' } ],
        })
        const indexBuffer = await fixture.runtime.createBuffer({ size: 8, usage: GPU_BUFFER_USAGE_INDEX })
        const indirect = await fixture.runtime.createBuffer({ size: 20, usage: GPU_BUFFER_USAGE_INDIRECT })
        const descriptors = [
            {
                pipeline: vertexPipeline,
                count: { vertexCount: 3 },
                resources: { read: [], write: [] },
                whenMissing: 'throw',
            },
            {
                pipeline: vertexPipeline,
                count: { indirect: indirect.region() },
                resources: { read: [ readResource(indirect) ], write: [] },
                whenMissing: 'throw',
            },
            {
                pipeline: vertexPipeline,
                indexBuffer: { region: indexBuffer.region(), format: 'uint16' },
                count: { indexCount: 3 },
                resources: { read: [ readResource(indexBuffer) ], write: [] },
                whenMissing: 'throw',
            },
            {
                pipeline: vertexPipeline,
                indexBuffer: { region: indexBuffer.region(), format: 'uint16' },
                count: { indirect: indirect.region() },
                resources: { read: [ readResource(indexBuffer), readResource(indirect) ], write: [] },
                whenMissing: 'throw',
            },
        ]

        for (const descriptor of descriptors) {
            const diagnostic = await expectDiagnostic(
                () => fixture.runtime.createDrawCommand(descriptor),
                'SCRATCH_COMMAND_VERTEX_BUFFER_INVALID'
            )
            expect(diagnostic.actual).to.deep.include({
                requiredSlots: [ 0 ],
                boundSlots: [],
                missingSlots: [ 0 ],
            })
        }
    })

    it('rejects compute pipelines through the structured draw diagnostic path', async() => {

        const fixture = await createRenderFixture()
        const computeProgram = await createTestProgram(fixture.runtime, {
            sourceParts: [ '@compute @workgroup_size(1) fn csMain() {}' ],
            compute: 'csMain',
        })
        const computePipeline = await fixture.runtime.createComputePipeline({
            program: computeProgram,
            compute: 'csMain',
        })
        const diagnostic = await expectDiagnostic(() => fixture.runtime.createDrawCommand({
            pipeline: computePipeline,
            count: { vertexCount: 3 },
            resources: { read: [], write: [] },
            whenMissing: 'throw',
        }), 'SCRATCH_COMMAND_DECLARED_ACCESS_INCOMPLETE')
        expect(diagnostic.expected).to.deep.equal({ pipeline: 'RenderPipeline' })
        expect(diagnostic.actual).to.deep.include({ pipelineKind: 'compute' })
    })

    it('locks validated execution contracts against post-construction mutation', async() => {

        const fixture = await createRenderFixture()
        const indirect = await fixture.runtime.createBuffer({ size: 20, usage: GPU_BUFFER_USAGE_INDIRECT })
        const indexBuffer = await fixture.runtime.createBuffer({ size: 8, usage: GPU_BUFFER_USAGE_INDEX })
        const boundBuffer = await fixture.runtime.createBuffer({ size: 16, usage: GPU_BUFFER_USAGE_STORAGE })
        const bindLayout = await fixture.runtime.createBindLayout({
            group: 0,
            entries: [ {
                binding: 0,
                name: 'input',
                type: 'read-storage',
                visibility: [ 'vertex' ],
            } ],
        })
        const bindSet = await fixture.runtime.createBindSet(bindLayout, {
            input: boundBuffer.region(),
        })
        const boundPipeline = await fixture.runtime.createRenderPipeline({
            program: fixture.program,
            layout: { mode: 'explicit', bindLayouts: [ bindLayout ] },
            targets: [ { format: 'rgba8unorm' } ],
        })
        const draw = fixture.runtime.createDrawCommand({
            pipeline: fixture.pipeline,
            count: { vertexCount: 3 },
            resources: { read: [], write: [] },
            whenMissing: 'throw',
        })
        const indexedDraw = fixture.runtime.createDrawCommand({
            pipeline: fixture.pipeline,
            indexBuffer: { region: indexBuffer.region(), format: 'uint16' },
            count: { indexCount: 3 },
            resources: { read: [ readResource(indexBuffer) ], write: [] },
            whenMissing: 'throw',
        })
        const boundDraw = fixture.runtime.createDrawCommand({
            pipeline: boundPipeline,
            bindSets: [ { set: bindSet } ],
            count: { vertexCount: 3 },
            resources: { read: [ readResource(boundBuffer) ], write: [] },
            whenMissing: 'throw',
        })

        expect('indexBuffer' in draw).to.equal(true)
        expect(Object.getOwnPropertyDescriptor(draw, 'indexBuffer')).to.include({
            configurable: false,
            enumerable: false,
            value: undefined,
            writable: false,
        })
        expect(Object.isExtensible(draw)).to.equal(false)
        expect(() => { draw.indexBuffer = { region: indexBuffer.region(), format: 'uint16' } }).to.throw(TypeError)
        expect(() => { draw.count = { indirect: indirect.region() } }).to.throw(TypeError)
        expect(() => { draw.resources.read.push(readResource(indirect)) }).to.throw(TypeError)
        expect(() => { indexedDraw.indexBuffer.region = indirect.region() }).to.throw(TypeError)
        expect(() => { indexedDraw.indexBuffer = undefined }).to.throw(TypeError)
        expect(() => { bindSet.bindings.clear() }).to.throw(TypeError)
        expect(() => { Map.prototype.clear.call(bindSet.bindings) }).to.throw(TypeError)
        expect(() => { boundDraw.bindSets[0].set = bindSet }).to.throw(TypeError)
        draw.dispose()
        expect(draw.isDisposed).to.equal(true)
        expect(() => { draw.isDisposed = false }).to.throw(TypeError)
        expect(draw.isDisposed).to.equal(true)

        const compute = await createComputeFixture()
        const dispatch = compute.runtime.createDispatchCommand({
            pipeline: compute.pipeline,
            count: { workgroups: [ 1 ] },
            resources: { read: [], write: [] },
            whenMissing: 'throw',
        })
        expect(() => { dispatch.count = { indirect: indirect.region() } }).to.throw(TypeError)
        expect(() => { dispatch.count.workgroups[0] = 0 }).to.throw(TypeError)
        expect(() => { dispatch.resources.write.push(indirect) }).to.throw(TypeError)
        dispatch.dispose()
        expect(() => { dispatch.isDisposed = false }).to.throw(TypeError)
    })

    it('encodes non-indexed and indexed draws through native indirect methods', async() => {

        const fixture = await createRenderFixture()
        const drawArguments = await fixture.runtime.createBuffer({
            size: 16,
            usage: GPU_BUFFER_USAGE_INDIRECT | GPU_BUFFER_USAGE_COPY_DST,
        })
        const indexedArguments = await fixture.runtime.createBuffer({
            size: 24,
            usage: GPU_BUFFER_USAGE_INDIRECT | GPU_BUFFER_USAGE_COPY_DST,
        })
        const indexBuffer = await fixture.runtime.createBuffer({
            size: 8,
            usage: GPU_BUFFER_USAGE_INDEX | GPU_BUFFER_USAGE_COPY_DST,
        })
        const uploadDrawArguments = fixture.runtime.createUploadCommand({
            target: (drawArguments).region(),
            data: new Uint32Array([ 3, 1, 0, 0 ]),
        })
        const uploadIndexedArguments = fixture.runtime.createUploadCommand({
            target: (indexedArguments).region(),
            data: new Uint32Array([ 0, 3, 1, 0, 0, 0 ]),
        })
        const uploadIndices = fixture.runtime.createUploadCommand({
            target: (indexBuffer).region(),
            data: new Uint16Array([ 0, 1, 2, 0 ]),
        })
        const drawIndirect = fixture.runtime.createDrawCommand({
            pipeline: fixture.pipeline,
            count: { indirect: drawArguments.region() },
            resources: { read: [ readResource(drawArguments, 1) ], write: [] },
            whenMissing: 'throw',
        })
        const drawIndexedIndirect = fixture.runtime.createDrawCommand({
            pipeline: fixture.pipeline,
            indexBuffer: { region: indexBuffer.region({ size: 6 }), format: 'uint16' },
            count: { indirect: indexedArguments.region({ offset: 4 }) },
            resources: {
                read: [
                    readResource(indexBuffer, 1),
                    readResource(indexedArguments, 1),
                ],
                write: [],
            },
            whenMissing: 'throw',
        })

        fixture.runtime.createSubmission({ validation: 'throw' })
            .upload(uploadDrawArguments)
            .upload(uploadIndexedArguments)
            .upload(uploadIndices)
            .render(fixture.pass, [ drawIndirect, drawIndexedIndirect ])
            .submit()

        expect(fixture.calls.renderPasses[0].actions).to.deep.equal([
            { type: 'setPipeline', pipeline: fixture.pipeline.gpuPipeline },
            ...defaultRenderStateActions(4, 4),
            { type: 'drawIndirect', buffer: drawArguments.gpuBuffer, offset: 0 },
            { type: 'setPipeline', pipeline: fixture.pipeline.gpuPipeline },
            ...defaultRenderStateActions(4, 4),
            {
                type: 'setIndexBuffer',
                buffer: indexBuffer.gpuBuffer,
                indexFormat: 'uint16',
                offset: 0,
                size: 6,
            },
            { type: 'drawIndexedIndirect', buffer: indexedArguments.gpuBuffer, offset: 4 },
            { type: 'end' },
        ])
    })

    it('encodes dispatchWorkgroupsIndirect without inspecting argument bytes', async() => {

        const fixture = await createComputeFixture()
        const argumentsBuffer = await fixture.runtime.createBuffer({
            size: 16,
            usage: GPU_BUFFER_USAGE_INDIRECT | GPU_BUFFER_USAGE_COPY_DST,
        })
        const upload = fixture.runtime.createUploadCommand({
            target: (argumentsBuffer).region(),
            data: new Uint32Array([ 99, 1, 2, 3 ]),
        })
        const dispatch = fixture.runtime.createDispatchCommand({
            pipeline: fixture.pipeline,
            count: { indirect: argumentsBuffer.region({ offset: 4 }) },
            resources: { read: [ readResource(argumentsBuffer, 1) ], write: [] },
            whenMissing: 'throw',
        })

        fixture.runtime.createSubmission({ validation: 'throw' })
            .upload(upload)
            .compute(fixture.pass, [ dispatch ])
            .submit()

        expect(fixture.calls.computePasses[0].actions).to.deep.equal([
            { type: 'setPipeline', pipeline: fixture.pipeline.gpuPipeline },
            { type: 'dispatchWorkgroupsIndirect', buffer: argumentsBuffer.gpuBuffer, offset: 4 },
            { type: 'end' },
        ])
        expect(fixture.calls.maps).to.deep.equal([])
    })

    it('keeps selected indirect fallbacks on the native WebGPU path', async() => {

        const fixture = await createComputeFixture()
        const missingPrimaryInput = await fixture.runtime.createBuffer({
            size: 16,
            usage: GPU_BUFFER_USAGE_STORAGE,
        })
        const argumentsBuffer = await fixture.runtime.createBuffer({
            size: 16,
            usage: GPU_BUFFER_USAGE_INDIRECT | GPU_BUFFER_USAGE_COPY_DST,
        })
        const output = await fixture.runtime.createBuffer({
            size: 16,
            usage: GPU_BUFFER_USAGE_STORAGE,
        })
        const upload = fixture.runtime.createUploadCommand({
            target: (argumentsBuffer).region(),
            data: new Uint32Array([ 9, 4, 5, 6 ]),
        })
        const fallback = fixture.runtime.createDispatchCommand({
            pipeline: fixture.pipeline,
            count: { indirect: argumentsBuffer.region({ offset: 4 }) },
            resources: { read: [ readResource(argumentsBuffer, 1) ], write: [ output ] },
            whenMissing: 'throw',
        })
        const primary = fixture.runtime.createDispatchCommand({
            pipeline: fixture.pipeline,
            count: { workgroups: [ 1 ] },
            resources: { read: [ readResource(missingPrimaryInput) ], write: [ output ] },
            whenMissing: 'use-fallback',
            fallback,
        })
        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .upload(upload)
            .compute(fixture.pass, [ primary ])
            .submit()

        expect(fixture.calls.computePasses[0].actions).to.deep.equal([
            { type: 'setPipeline', pipeline: fixture.pipeline.gpuPipeline },
            { type: 'dispatchWorkgroupsIndirect', buffer: argumentsBuffer.gpuBuffer, offset: 4 },
            { type: 'end' },
        ])
        expect(fixture.calls.maps).to.deep.equal([])
        expect(submitted.resourceAccesses.filter(access => access.stepKind === 'compute')).to.deep.include({
            stepIndex: 1,
            stepKind: 'compute',
            commandKind: 'dispatch',
            commandId: fallback.id,
            passId: fixture.pass.id,
            resourceId: argumentsBuffer.id,
            resourceKind: 'BufferResource',
            subject: argumentsBuffer.subject,
            access: 'read',
            declaredContentEpoch: 1,
            contentEpochBefore: 1,
            contentEpochAfter: 1,
            allocationVersion: 1,
        })
        expect(submitted.executionOutcomes[0]).to.deep.include({
            outcomeKind: 'pass',
            requestedCommandIds: [ primary.id ],
            encodedCommandIds: [ fallback.id ],
        })
        expect(submitted.executionOutcomes[1]).to.deep.include({
            outcomeKind: 'command',
            requestedCommandId: primary.id,
            status: 'fallback-executed',
            executedCommandId: fallback.id,
        })
        expect(output.contentEpoch).to.equal(1)
        expect(submitted.resourceAccesses).to.deep.include({
            stepIndex: 1,
            stepKind: 'compute',
            commandKind: 'dispatch',
            commandId: fallback.id,
            passId: fixture.pass.id,
            resourceId: output.id,
            resourceKind: 'BufferResource',
            subject: output.subject,
            access: 'write',
            contentEpochBefore: 0,
            contentEpochAfter: 1,
            allocationVersion: 1,
        })
        expect(submitted.producerEpochs).to.deep.include({
            resourceId: output.id,
            resourceKind: 'BufferResource',
            subject: output.subject,
            contentEpoch: 1,
            allocationVersion: 1,
            producedBy: {
                stepIndex: 1,
                stepKind: 'compute',
                commandKind: 'dispatch',
                commandId: fallback.id,
                passId: fixture.pass.id,
            },
        })
    })

    it('validates native indirect buffers, offsets, ranges, runtimes, and disposal', async() => {

        const render = await createRenderFixture()
        const compute = await createComputeFixture()
        const noUsage = await render.runtime.createBuffer({ size: 20, usage: GPU_BUFFER_USAGE_STORAGE })
        const tooSmallDraw = await render.runtime.createBuffer({ size: 15, usage: GPU_BUFFER_USAGE_INDIRECT })
        const tooSmallIndexed = await render.runtime.createBuffer({ size: 19, usage: GPU_BUFFER_USAGE_INDIRECT })
        const misaligned = await render.runtime.createBuffer({ size: 32, usage: GPU_BUFFER_USAGE_INDIRECT })

        const drawCases = [
            { count: { indirect: 'buffer' }, code: 'SCRATCH_COMMAND_INDIRECT_BUFFER_INVALID' },
            { count: { indirect: noUsage.region() }, code: 'SCRATCH_RESOURCE_USAGE_MISSING' },
            { count: { indirect: tooSmallDraw.region() }, code: 'SCRATCH_COMMAND_INDIRECT_BUFFER_INVALID' },
            { count: { indirect: misaligned.region({ offset: 2, size: 16 }) }, code: 'SCRATCH_COMMAND_INDIRECT_BUFFER_INVALID' },
        ]
        for (const testCase of drawCases) {
            await expectDiagnostic(() => render.runtime.createDrawCommand({
                pipeline: render.pipeline,
                count: testCase.count,
                resources: { read: [], write: [] },
                whenMissing: 'throw',
            }), testCase.code)
        }

        const indexBuffer = await render.runtime.createBuffer({ size: 8, usage: GPU_BUFFER_USAGE_INDEX })
        await expectDiagnostic(() => render.runtime.createDrawCommand({
            pipeline: render.pipeline,
            indexBuffer: { region: indexBuffer.region(), format: 'uint16' },
            count: { indirect: tooSmallIndexed.region() },
            resources: { read: [ readResource(indexBuffer), readResource(tooSmallIndexed) ], write: [] },
            whenMissing: 'throw',
        }), 'SCRATCH_COMMAND_INDIRECT_BUFFER_INVALID')

        const tooSmallDispatch = await compute.runtime.createBuffer({ size: 11, usage: GPU_BUFFER_USAGE_INDIRECT })
        await expectDiagnostic(() => compute.runtime.createDispatchCommand({
            pipeline: compute.pipeline,
            count: { indirect: tooSmallDispatch.region() },
            resources: { read: [ readResource(tooSmallDispatch) ], write: [] },
            whenMissing: 'throw',
        }), 'SCRATCH_COMMAND_INDIRECT_BUFFER_INVALID')

        const foreignRuntime = await ScratchRuntime.create({ gpu: createFakeGpu().gpu })
        const foreign = await foreignRuntime.createBuffer({ size: 16, usage: GPU_BUFFER_USAGE_INDIRECT })
        await expectDiagnostic(() => render.runtime.createDrawCommand({
            pipeline: render.pipeline,
            count: { indirect: foreign.region() },
            resources: { read: [ readResource(foreign) ], write: [] },
            whenMissing: 'throw',
        }), 'SCRATCH_RESOURCE_WRONG_RUNTIME')

        const disposed = await render.runtime.createBuffer({ size: 16, usage: GPU_BUFFER_USAGE_INDIRECT })
        const disposedRegion = disposed.region()
        disposed.dispose()
        await expectDiagnostic(() => render.runtime.createDrawCommand({
            pipeline: render.pipeline,
            count: { indirect: disposedRegion },
            resources: { read: [ readResource(disposed) ], write: [] },
            whenMissing: 'throw',
        }), 'SCRATCH_RESOURCE_DISPOSED')
    })

    it('revalidates every fixed-function buffer usage against replacement allocations before encoder effects', async() => {

        const render = await createRenderFixture()
        const vertexPipeline = await render.runtime.createRenderPipeline({
            program: render.program,
            vertexBuffers: [ {
                arrayStride: 8,
                attributes: [ { shaderLocation: 0, offset: 0, format: 'float32x2' } ],
            } ],
            targets: [ { format: 'rgba8unorm' } ],
        })
        const vertex = await render.runtime.createBuffer({
            size: 24,
            usage: GPU_BUFFER_USAGE_VERTEX | GPU_BUFFER_USAGE_COPY_DST,
        })
        const index = await render.runtime.createBuffer({
            size: 8,
            usage: GPU_BUFFER_USAGE_INDEX | GPU_BUFFER_USAGE_COPY_DST,
        })
        const drawArguments = await render.runtime.createBuffer({
            size: 16,
            usage: GPU_BUFFER_USAGE_INDIRECT | GPU_BUFFER_USAGE_COPY_DST,
        })
        const vertexDraw = render.runtime.createDrawCommand({
            pipeline: vertexPipeline,
            vertexBuffers: [ { slot: 0, region: vertex.region() } ],
            count: { vertexCount: 3 },
            resources: { read: [ readResource(vertex) ], write: [] },
            whenMissing: 'throw',
        })
        const indexedDraw = render.runtime.createDrawCommand({
            pipeline: render.pipeline,
            indexBuffer: { region: index.region(), format: 'uint16' },
            count: { indexCount: 3 },
            resources: { read: [ readResource(index) ], write: [] },
            whenMissing: 'throw',
        })
        const indirectDraw = render.runtime.createDrawCommand({
            pipeline: render.pipeline,
            count: { indirect: drawArguments.region() },
            resources: { read: [ readResource(drawArguments) ], write: [] },
            whenMissing: 'throw',
        })

        const compute = await createComputeFixture()
        const dispatchArguments = await compute.runtime.createBuffer({
            size: 12,
            usage: GPU_BUFFER_USAGE_INDIRECT | GPU_BUFFER_USAGE_COPY_DST,
        })
        const indirectDispatch = compute.runtime.createDispatchCommand({
            pipeline: compute.pipeline,
            count: { indirect: dispatchArguments.region() },
            resources: { read: [ readResource(dispatchArguments) ], write: [] },
            whenMissing: 'throw',
        })

        const cases = [
            {
                fixture: render,
                resource: vertex,
                submit: () => render.runtime.createSubmission({ validation: 'throw' })
                    .render(render.pass, [ vertexDraw ])
                    .submit(),
            },
            {
                fixture: render,
                resource: index,
                submit: () => render.runtime.createSubmission({ validation: 'throw' })
                    .render(render.pass, [ indexedDraw ])
                    .submit(),
            },
            {
                fixture: render,
                resource: drawArguments,
                submit: () => render.runtime.createSubmission({ validation: 'throw' })
                    .render(render.pass, [ indirectDraw ])
                    .submit(),
            },
            {
                fixture: compute,
                resource: dispatchArguments,
                submit: () => compute.runtime.createSubmission({ validation: 'throw' })
                    .compute(compute.pass, [ indirectDispatch ])
                    .submit(),
            },
        ]

        for (const testCase of cases) {
            replaceResourceAllocationForTest(testCase.resource, {
                ...testCase.resource.descriptor,
                usage: GPU_BUFFER_USAGE_COPY_DST,
            })
            const encoderCount = testCase.fixture.calls.commandEncoders.length
            const submissionCount = testCase.fixture.calls.queueSubmissions.length
            await expectDiagnostic(testCase.submit, 'SCRATCH_RESOURCE_USAGE_MISSING')
            expect(testCase.fixture.calls.commandEncoders).to.have.length(encoderCount)
            expect(testCase.fixture.calls.queueSubmissions).to.have.length(submissionCount)
        }
    })

    it('requires explicit epoch reads for every fixed-function buffer role', async() => {

        const render = await createRenderFixture()
        const vertexPipeline = await render.runtime.createRenderPipeline({
            program: render.program,
            vertexBuffers: [ {
                arrayStride: 8,
                attributes: [ { shaderLocation: 0, offset: 0, format: 'float32x2' } ],
            } ],
            targets: [ { format: 'rgba8unorm' } ],
        })
        const vertex = await render.runtime.createBuffer({ size: 24, usage: GPU_BUFFER_USAGE_VERTEX })
        const index = await render.runtime.createBuffer({ size: 8, usage: GPU_BUFFER_USAGE_INDEX })
        const indirect = await render.runtime.createBuffer({ size: 20, usage: GPU_BUFFER_USAGE_INDIRECT })

        const cases = [
            {
                role: 'vertex-buffer',
                descriptor: {
                    pipeline: vertexPipeline,
                    vertexBuffers: [ { slot: 0, region: vertex.region() } ],
                    count: { vertexCount: 3 },
                    resources: { read: [], write: [] },
                    whenMissing: 'throw',
                },
            },
            {
                role: 'index-buffer',
                descriptor: {
                    pipeline: render.pipeline,
                    indexBuffer: { region: index.region(), format: 'uint16' },
                    count: { indexCount: 3 },
                    resources: { read: [], write: [] },
                    whenMissing: 'throw',
                },
            },
            {
                role: 'indirect-buffer',
                descriptor: {
                    pipeline: render.pipeline,
                    count: { indirect: indirect.region() },
                    resources: { read: [], write: [] },
                    whenMissing: 'throw',
                },
            },
        ]

        for (const testCase of cases) {
            const diagnostic = await expectDiagnostic(
                () => render.runtime.createDrawCommand(testCase.descriptor),
                'SCRATCH_COMMAND_DECLARED_ACCESS_INCOMPLETE'
            )
            expect(diagnostic.phase).to.equal('command')
            expect(diagnostic.expected.read).to.deep.include({
                role: testCase.role,
                contentEpoch: 'non-negative integer | "current-at-step"',
            })
            expect(diagnostic.actual).to.deep.include({ role: testCase.role })
        }

        const compute = await createComputeFixture()
        const dispatchArguments = await compute.runtime.createBuffer({ size: 12, usage: GPU_BUFFER_USAGE_INDIRECT })
        const diagnostic = await expectDiagnostic(() => compute.runtime.createDispatchCommand({
            pipeline: compute.pipeline,
            count: { indirect: dispatchArguments.region() },
            resources: { read: [], write: [] },
            whenMissing: 'throw',
        }), 'SCRATCH_COMMAND_DECLARED_ACCESS_INCOMPLETE')
        expect(diagnostic.expected.read).to.deep.include({
            role: 'indirect-buffer',
            contentEpoch: 'non-negative integer | "current-at-step"',
        })
        expect(diagnostic.actual).to.deep.include({ role: 'indirect-buffer' })
    })

    it('uses same-submission GPU-produced indirect epochs and records read-only ledger facts', async() => {

        const fixture = await createRenderFixture()
        const computeProgram = await createTestProgram(fixture.runtime, {
            sourceParts: [ '@compute @workgroup_size(1) fn csMain() {}' ],
            compute: 'csMain',
        })
        const computePipeline = await fixture.runtime.createComputePipeline({
            program: computeProgram,
            compute: 'csMain',
        })
        const computePass = fixture.runtime.createComputePass()
        const drawArguments = await fixture.runtime.createBuffer({
            size: 16,
            usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_INDIRECT,
        })
        const indexedArguments = await fixture.runtime.createBuffer({
            size: 20,
            usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_INDIRECT,
        })
        const dispatchArguments = await fixture.runtime.createBuffer({
            size: 12,
            usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_INDIRECT,
        })
        const indexBuffer = await fixture.runtime.createBuffer({
            size: 8,
            usage: GPU_BUFFER_USAGE_INDEX | GPU_BUFFER_USAGE_COPY_DST,
        })
        const uploadIndices = fixture.runtime.createUploadCommand({
            target: (indexBuffer).region(),
            data: new Uint16Array([ 0, 1, 2, 0 ]),
        })
        const produceArguments = fixture.runtime.createDispatchCommand({
            pipeline: computePipeline,
            count: { workgroups: [ 1 ] },
            resources: {
                read: [],
                write: [ drawArguments, indexedArguments, dispatchArguments ],
            },
            whenMissing: 'throw',
        })
        const consumeDispatch = fixture.runtime.createDispatchCommand({
            pipeline: computePipeline,
            count: { indirect: dispatchArguments.region() },
            resources: { read: [ readResource(dispatchArguments, 1) ], write: [] },
            whenMissing: 'throw',
        })
        const consumeDraw = fixture.runtime.createDrawCommand({
            pipeline: fixture.pipeline,
            count: { indirect: drawArguments.region() },
            resources: { read: [ readResource(drawArguments, 1) ], write: [] },
            whenMissing: 'throw',
        })
        const consumeIndexedDraw = fixture.runtime.createDrawCommand({
            pipeline: fixture.pipeline,
            indexBuffer: { region: indexBuffer.region({ size: 6 }), format: 'uint16' },
            count: { indirect: indexedArguments.region() },
            resources: {
                read: [
                    readResource(indexBuffer, 1),
                    readResource(indexedArguments, 1),
                ],
                write: [],
            },
            whenMissing: 'throw',
        })

        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .upload(uploadIndices)
            .compute(computePass, [ produceArguments ])
            .compute(computePass, [ consumeDispatch ])
            .render(fixture.pass, [ consumeDraw, consumeIndexedDraw ])
            .submit()

        const fixedFunctionReads = submitted.resourceAccesses.filter(access =>
            access.access === 'read' &&
            [ drawArguments.id, indexedArguments.id, dispatchArguments.id, indexBuffer.id ].includes(access.resourceId)
        )
        expect(fixedFunctionReads.map(access => ({
            resourceId: access.resourceId,
            before: access.contentEpochBefore,
            after: access.contentEpochAfter,
            stepKind: access.stepKind,
        }))).to.deep.equal([
            { resourceId: dispatchArguments.id, before: 1, after: 1, stepKind: 'compute' },
            { resourceId: drawArguments.id, before: 1, after: 1, stepKind: 'render' },
            { resourceId: indexBuffer.id, before: 1, after: 1, stepKind: 'render' },
            { resourceId: indexedArguments.id, before: 1, after: 1, stepKind: 'render' },
        ])
        expect(submitted.producerEpochs.filter(epoch =>
            [ drawArguments.id, indexedArguments.id, dispatchArguments.id, indexBuffer.id ].includes(epoch.resourceId)
        ).map(epoch => epoch.resourceId)).to.deep.equal([
            indexBuffer.id,
            drawArguments.id,
            indexedArguments.id,
            dispatchArguments.id,
        ])
        expect(indexBuffer.contentEpoch).to.equal(1)
        expect(fixture.calls.maps).to.deep.equal([])
    })

    it('applies existing readiness and epoch disposition to index and indirect reads', async() => {

        const fixture = await createRenderFixture()
        const emptyIndirect = await fixture.runtime.createBuffer({
            size: 16,
            usage: GPU_BUFFER_USAGE_INDIRECT,
        })
        const emptyDraw = fixture.runtime.createDrawCommand({
            pipeline: fixture.pipeline,
            count: { indirect: emptyIndirect.region() },
            resources: { read: [ readResource(emptyIndirect) ], write: [] },
            whenMissing: 'throw',
        })
        await expectDiagnostic(() => fixture.runtime.createSubmission({ validation: 'off' })
            .render(fixture.pass, [ emptyDraw ])
            .submit(), 'SCRATCH_COMMAND_RESOURCE_NOT_READY')
        expect(fixture.calls.commandEncoders).to.have.length(0)

        const emptyIndex = await fixture.runtime.createBuffer({
            size: 8,
            usage: GPU_BUFFER_USAGE_INDEX,
        })
        const emptyIndexedDraw = fixture.runtime.createDrawCommand({
            pipeline: fixture.pipeline,
            indexBuffer: { region: emptyIndex.region(), format: 'uint16' },
            count: { indexCount: 3 },
            resources: { read: [ readResource(emptyIndex) ], write: [] },
            whenMissing: 'throw',
        })
        await expectDiagnostic(() => fixture.runtime.createSubmission({ validation: 'warn' })
            .render(fixture.pass, [ emptyIndexedDraw ])
            .submit(), 'SCRATCH_COMMAND_RESOURCE_NOT_READY')
        expect(fixture.calls.commandEncoders).to.have.length(0)

        const readyIndirect = await fixture.runtime.createBuffer({
            size: 16,
            usage: GPU_BUFFER_USAGE_INDIRECT | GPU_BUFFER_USAGE_COPY_DST,
        })
        fixture.runtime.createSubmission({ validation: 'throw' })
            .upload(fixture.runtime.createUploadCommand({
                target: (readyIndirect).region(),
                data: new Uint32Array([ 3, 1, 0, 0 ]),
            }))
            .submit()

        const futureDraw = fixture.runtime.createDrawCommand({
            pipeline: fixture.pipeline,
            count: { indirect: readyIndirect.region() },
            resources: { read: [ readResource(readyIndirect, 2) ], write: [] },
            whenMissing: 'throw',
        })
        await expectDiagnostic(() => fixture.runtime.createSubmission({ validation: 'throw' })
            .render(fixture.pass, [ futureDraw ])
            .submit(), 'SCRATCH_SUBMISSION_READ_BEFORE_WRITE')

        const staleDraw = fixture.runtime.createDrawCommand({
            pipeline: fixture.pipeline,
            count: { indirect: readyIndirect.region() },
            resources: { read: [ readResource(readyIndirect, 0) ], write: [] },
            whenMissing: 'throw',
        })
        const warned = fixture.runtime.createSubmission({ validation: 'warn' })
            .render(fixture.pass, [ staleDraw ])
            .submit()
        expect(warned.report.diagnostics.map(diagnostic => diagnostic.code)).to.include(
            'SCRATCH_SUBMISSION_STALE_READ'
        )

        const unvalidated = fixture.runtime.createSubmission({ validation: 'off' })
            .render(fixture.pass, [ staleDraw ])
            .submit()
        expect(unvalidated.report.diagnostics).to.deep.equal([])
    })
})
