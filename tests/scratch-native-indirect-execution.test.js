import { expect } from 'chai'
import {
    DispatchCommand,
    DrawCommand,
    ScratchDiagnosticError,
    ScratchRuntime,
} from 'geoscratch'
import { createFakeGpu, triangleWgsl } from './scratch-test-utils.js'

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
    const program = runtime.createProgram({
        modules: [ triangleWgsl ],
        entryPoints: {
            vertex: 'vsMain',
            fragment: 'fsMain',
        },
    })
    const pipeline = runtime.createRenderPipeline({
        program,
        targets: [ { format: 'rgba8unorm' } ],
    })
    const target = runtime.createTexture({
        size: { width: 4, height: 4 },
        format: 'rgba8unorm',
        usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
    })
    const pass = runtime.createRenderPass({
        color: [ {
            target,
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
    const program = runtime.createProgram({
        modules: [ '@compute @workgroup_size(1) fn csMain() {}' ],
        entryPoints: { compute: 'csMain' },
    })
    const pipeline = runtime.createComputePipeline({
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
        const indexBuffer = fixture.runtime.createBuffer({
            size: 8,
            usage: GPU_BUFFER_USAGE_INDEX | GPU_BUFFER_USAGE_COPY_DST,
        })
        const upload = fixture.runtime.createUploadCommand({
            target: indexBuffer,
            data: new Uint16Array([ 0, 1, 2 ]),
        })
        const draw = fixture.runtime.createDrawCommand({
            pipeline: fixture.pipeline,
            indexBuffer: {
                buffer: indexBuffer,
                format: 'uint16',
                offset: 0,
                size: 6,
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
            {
                type: 'setIndexBuffer',
                buffer: indexBuffer.gpuBuffer,
                indexFormat: 'uint16',
                offset: 0,
                size: 6,
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
        const indexBuffer = fixture.runtime.createBuffer({
            size: 16,
            usage: GPU_BUFFER_USAGE_INDEX | GPU_BUFFER_USAGE_COPY_DST,
        })
        const upload = fixture.runtime.createUploadCommand({
            target: indexBuffer,
            data: new Uint32Array([ 9, 0, 1, 2 ]),
        })
        const draw = fixture.runtime.createDrawCommand({
            pipeline: fixture.pipeline,
            indexBuffer: { buffer: indexBuffer, format: 'uint32', offset: 4, size: 12 },
            count: { indexCount: 3 },
            resources: { read: [ readResource(indexBuffer, 1) ], write: [] },
            whenMissing: 'throw',
        })

        fixture.runtime.createSubmission({ validation: 'throw' })
            .upload(upload)
            .render(fixture.pass, [ draw ])
            .submit()

        expect(fixture.calls.renderPasses[0].actions[1]).to.deep.equal({
            type: 'setIndexBuffer',
            buffer: indexBuffer.gpuBuffer,
            indexFormat: 'uint32',
            offset: 4,
            size: 12,
        })
    })

    it('accepts zero-count direct draw and dispatch commands as no-ops', async() => {

        const render = await createRenderFixture()
        const draw = render.runtime.createDrawCommand({
            pipeline: render.pipeline,
            count: { vertexCount: 0, instanceCount: 0 },
            resources: { read: [], write: [] },
            whenMissing: 'throw',
        })

        render.runtime.createSubmission({ validation: 'throw' })
            .render(render.pass, [ draw ])
            .submit()

        expect(render.calls.renderPasses[0].actions[1]).to.deep.equal({
            type: 'draw',
            call: { vertexCount: 0, instanceCount: 0, firstVertex: 0, firstInstance: 0 },
        })

        const compute = await createComputeFixture()
        const dispatch = compute.runtime.createDispatchCommand({
            pipeline: compute.pipeline,
            count: { workgroups: [ 0, 1, 1 ] },
            resources: { read: [], write: [] },
            whenMissing: 'throw',
        })

        compute.runtime.createSubmission({ validation: 'throw' })
            .compute(compute.pass, [ dispatch ])
            .submit()

        expect(dispatch).to.be.instanceOf(DispatchCommand)
        expect(compute.calls.computePasses[0].actions[1]).to.deep.equal({
            type: 'dispatchWorkgroups',
            call: { x: 0, y: 1, z: 1 },
        })
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
        }

        const indexBuffer = render.runtime.createBuffer({
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
                indexBuffer: { buffer: indexBuffer, format: 'uint16' },
                count,
                resources: { read: [ readResource(indexBuffer) ], write: [] },
                whenMissing: 'throw',
            }), 'SCRATCH_COMMAND_COUNT_INVALID')
        }

        const compute = await createComputeFixture()
        await expectDiagnostic(() => compute.runtime.createDispatchCommand({
            pipeline: compute.pipeline,
            count: { workgroups: [ 65_536 ] },
            resources: { read: [], write: [] },
            whenMissing: 'throw',
        }), 'SCRATCH_COMMAND_COUNT_INVALID')
    })

    it('rejects invalid static index bindings and count pairings', async() => {

        const fixture = await createRenderFixture()
        const valid = fixture.runtime.createBuffer({
            size: 8,
            usage: GPU_BUFFER_USAGE_INDEX,
        })
        const missingUsage = fixture.runtime.createBuffer({
            size: 8,
            usage: GPU_BUFFER_USAGE_STORAGE,
        })

        const cases = [
            {
                descriptor: { buffer: valid, format: 'uint8' },
                code: 'SCRATCH_COMMAND_INDEX_BUFFER_INVALID',
            },
            {
                descriptor: { buffer: valid, format: 'uint32', offset: 2 },
                code: 'SCRATCH_COMMAND_INDEX_BUFFER_INVALID',
            },
            {
                descriptor: { buffer: valid, format: 'uint16', size: 3 },
                code: 'SCRATCH_COMMAND_INDEX_BUFFER_INVALID',
            },
            {
                descriptor: { buffer: valid, format: 'uint16', offset: 6, size: 4 },
                code: 'SCRATCH_COMMAND_INDEX_BUFFER_INVALID',
            },
            {
                descriptor: { buffer: missingUsage, format: 'uint16' },
                code: 'SCRATCH_RESOURCE_USAGE_MISSING',
            },
        ]

        for (const testCase of cases) {
            await expectDiagnostic(() => fixture.runtime.createDrawCommand({
                pipeline: fixture.pipeline,
                indexBuffer: testCase.descriptor,
                count: { indexCount: 3 },
                resources: { read: [ readResource(testCase.descriptor.buffer) ], write: [] },
                whenMissing: 'throw',
            }), testCase.code)
        }

        await expectDiagnostic(() => fixture.runtime.createDrawCommand({
            pipeline: fixture.pipeline,
            count: { indexCount: 3 },
            resources: { read: [ readResource(valid) ], write: [] },
            whenMissing: 'throw',
        }), 'SCRATCH_COMMAND_INDEX_BUFFER_INVALID')

        await expectDiagnostic(() => fixture.runtime.createDrawCommand({
            pipeline: fixture.pipeline,
            indexBuffer: { buffer: valid, format: 'uint16' },
            count: { vertexCount: 3 },
            resources: { read: [ readResource(valid) ], write: [] },
            whenMissing: 'throw',
        }), 'SCRATCH_COMMAND_INDEX_BUFFER_INVALID')

        const foreignRuntime = await ScratchRuntime.create({ gpu: createFakeGpu().gpu })
        const foreign = foreignRuntime.createBuffer({ size: 8, usage: GPU_BUFFER_USAGE_INDEX })
        await expectDiagnostic(() => fixture.runtime.createDrawCommand({
            pipeline: fixture.pipeline,
            indexBuffer: { buffer: foreign, format: 'uint16' },
            count: { indexCount: 3 },
            resources: { read: [ readResource(foreign) ], write: [] },
            whenMissing: 'throw',
        }), 'SCRATCH_RESOURCE_WRONG_RUNTIME')

        const disposed = fixture.runtime.createBuffer({ size: 8, usage: GPU_BUFFER_USAGE_INDEX })
        disposed.dispose()
        await expectDiagnostic(() => fixture.runtime.createDrawCommand({
            pipeline: fixture.pipeline,
            indexBuffer: { buffer: disposed, format: 'uint16' },
            count: { indexCount: 3 },
            resources: { read: [ readResource(disposed) ], write: [] },
            whenMissing: 'throw',
        }), 'SCRATCH_RESOURCE_DISPOSED')
    })

    it('encodes non-indexed and indexed draws through native indirect methods', async() => {

        const fixture = await createRenderFixture()
        const drawArguments = fixture.runtime.createBuffer({
            size: 16,
            usage: GPU_BUFFER_USAGE_INDIRECT | GPU_BUFFER_USAGE_COPY_DST,
        })
        const indexedArguments = fixture.runtime.createBuffer({
            size: 24,
            usage: GPU_BUFFER_USAGE_INDIRECT | GPU_BUFFER_USAGE_COPY_DST,
        })
        const indexBuffer = fixture.runtime.createBuffer({
            size: 8,
            usage: GPU_BUFFER_USAGE_INDEX | GPU_BUFFER_USAGE_COPY_DST,
        })
        const uploadDrawArguments = fixture.runtime.createUploadCommand({
            target: drawArguments,
            data: new Uint32Array([ 3, 1, 0, 0 ]),
        })
        const uploadIndexedArguments = fixture.runtime.createUploadCommand({
            target: indexedArguments,
            data: new Uint32Array([ 0, 3, 1, 0, 0, 0 ]),
        })
        const uploadIndices = fixture.runtime.createUploadCommand({
            target: indexBuffer,
            data: new Uint16Array([ 0, 1, 2 ]),
        })
        const drawIndirect = fixture.runtime.createDrawCommand({
            pipeline: fixture.pipeline,
            count: { indirect: drawArguments },
            resources: { read: [ readResource(drawArguments, 1) ], write: [] },
            whenMissing: 'throw',
        })
        const drawIndexedIndirect = fixture.runtime.createDrawCommand({
            pipeline: fixture.pipeline,
            indexBuffer: { buffer: indexBuffer, format: 'uint16', size: 6 },
            count: { indirect: indexedArguments, offset: 4 },
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
            { type: 'drawIndirect', buffer: drawArguments.gpuBuffer, offset: 0 },
            { type: 'setPipeline', pipeline: fixture.pipeline.gpuPipeline },
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
        const argumentsBuffer = fixture.runtime.createBuffer({
            size: 16,
            usage: GPU_BUFFER_USAGE_INDIRECT | GPU_BUFFER_USAGE_COPY_DST,
        })
        const upload = fixture.runtime.createUploadCommand({
            target: argumentsBuffer,
            data: new Uint32Array([ 99, 1, 2, 3 ]),
        })
        const dispatch = fixture.runtime.createDispatchCommand({
            pipeline: fixture.pipeline,
            count: { indirect: argumentsBuffer, offset: 4 },
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

    it('validates native indirect buffers, offsets, ranges, runtimes, and disposal', async() => {

        const render = await createRenderFixture()
        const compute = await createComputeFixture()
        const noUsage = render.runtime.createBuffer({ size: 20, usage: GPU_BUFFER_USAGE_STORAGE })
        const tooSmallDraw = render.runtime.createBuffer({ size: 15, usage: GPU_BUFFER_USAGE_INDIRECT })
        const tooSmallIndexed = render.runtime.createBuffer({ size: 19, usage: GPU_BUFFER_USAGE_INDIRECT })
        const misaligned = render.runtime.createBuffer({ size: 32, usage: GPU_BUFFER_USAGE_INDIRECT })

        const drawCases = [
            { count: { indirect: 'buffer' }, code: 'SCRATCH_COMMAND_INDIRECT_BUFFER_INVALID' },
            { count: { indirect: noUsage }, code: 'SCRATCH_RESOURCE_USAGE_MISSING' },
            { count: { indirect: tooSmallDraw }, code: 'SCRATCH_COMMAND_INDIRECT_BUFFER_INVALID' },
            { count: { indirect: misaligned, offset: 2 }, code: 'SCRATCH_COMMAND_INDIRECT_BUFFER_INVALID' },
        ]
        for (const testCase of drawCases) {
            await expectDiagnostic(() => render.runtime.createDrawCommand({
                pipeline: render.pipeline,
                count: testCase.count,
                resources: { read: [], write: [] },
                whenMissing: 'throw',
            }), testCase.code)
        }

        const indexBuffer = render.runtime.createBuffer({ size: 8, usage: GPU_BUFFER_USAGE_INDEX })
        await expectDiagnostic(() => render.runtime.createDrawCommand({
            pipeline: render.pipeline,
            indexBuffer: { buffer: indexBuffer, format: 'uint16' },
            count: { indirect: tooSmallIndexed },
            resources: { read: [ readResource(indexBuffer), readResource(tooSmallIndexed) ], write: [] },
            whenMissing: 'throw',
        }), 'SCRATCH_COMMAND_INDIRECT_BUFFER_INVALID')

        const tooSmallDispatch = compute.runtime.createBuffer({ size: 11, usage: GPU_BUFFER_USAGE_INDIRECT })
        await expectDiagnostic(() => compute.runtime.createDispatchCommand({
            pipeline: compute.pipeline,
            count: { indirect: tooSmallDispatch },
            resources: { read: [ readResource(tooSmallDispatch) ], write: [] },
            whenMissing: 'throw',
        }), 'SCRATCH_COMMAND_INDIRECT_BUFFER_INVALID')

        const foreignRuntime = await ScratchRuntime.create({ gpu: createFakeGpu().gpu })
        const foreign = foreignRuntime.createBuffer({ size: 16, usage: GPU_BUFFER_USAGE_INDIRECT })
        await expectDiagnostic(() => render.runtime.createDrawCommand({
            pipeline: render.pipeline,
            count: { indirect: foreign },
            resources: { read: [ readResource(foreign) ], write: [] },
            whenMissing: 'throw',
        }), 'SCRATCH_RESOURCE_WRONG_RUNTIME')

        const disposed = render.runtime.createBuffer({ size: 16, usage: GPU_BUFFER_USAGE_INDIRECT })
        disposed.dispose()
        await expectDiagnostic(() => render.runtime.createDrawCommand({
            pipeline: render.pipeline,
            count: { indirect: disposed },
            resources: { read: [ readResource(disposed) ], write: [] },
            whenMissing: 'throw',
        }), 'SCRATCH_RESOURCE_DISPOSED')
    })

    it('requires explicit epoch reads for every fixed-function buffer role', async() => {

        const render = await createRenderFixture()
        const vertexPipeline = render.runtime.createRenderPipeline({
            program: render.program,
            vertexBuffers: [ {
                arrayStride: 8,
                attributes: [ { shaderLocation: 0, offset: 0, format: 'float32x2' } ],
            } ],
            targets: [ { format: 'rgba8unorm' } ],
        })
        const vertex = render.runtime.createBuffer({ size: 24, usage: GPU_BUFFER_USAGE_VERTEX })
        const index = render.runtime.createBuffer({ size: 8, usage: GPU_BUFFER_USAGE_INDEX })
        const indirect = render.runtime.createBuffer({ size: 20, usage: GPU_BUFFER_USAGE_INDIRECT })

        const cases = [
            {
                role: 'vertex-buffer',
                descriptor: {
                    pipeline: vertexPipeline,
                    vertexBuffers: [ { slot: 0, buffer: vertex } ],
                    count: { vertexCount: 3 },
                    resources: { read: [], write: [] },
                    whenMissing: 'throw',
                },
            },
            {
                role: 'index-buffer',
                descriptor: {
                    pipeline: render.pipeline,
                    indexBuffer: { buffer: index, format: 'uint16' },
                    count: { indexCount: 3 },
                    resources: { read: [], write: [] },
                    whenMissing: 'throw',
                },
            },
            {
                role: 'indirect-buffer',
                descriptor: {
                    pipeline: render.pipeline,
                    count: { indirect },
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
            expect(diagnostic.actual).to.deep.include({ role: testCase.role })
        }

        const compute = await createComputeFixture()
        const dispatchArguments = compute.runtime.createBuffer({ size: 12, usage: GPU_BUFFER_USAGE_INDIRECT })
        const diagnostic = await expectDiagnostic(() => compute.runtime.createDispatchCommand({
            pipeline: compute.pipeline,
            count: { indirect: dispatchArguments },
            resources: { read: [], write: [] },
            whenMissing: 'throw',
        }), 'SCRATCH_COMMAND_DECLARED_ACCESS_INCOMPLETE')
        expect(diagnostic.actual).to.deep.include({ role: 'indirect-buffer' })
    })

    it('uses same-submission GPU-produced indirect epochs and records read-only ledger facts', async() => {

        const fixture = await createRenderFixture()
        const computeProgram = fixture.runtime.createProgram({
            modules: [ '@compute @workgroup_size(1) fn csMain() {}' ],
            entryPoints: { compute: 'csMain' },
        })
        const computePipeline = fixture.runtime.createComputePipeline({
            program: computeProgram,
            compute: 'csMain',
        })
        const computePass = fixture.runtime.createComputePass()
        const drawArguments = fixture.runtime.createBuffer({
            size: 16,
            usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_INDIRECT,
        })
        const indexedArguments = fixture.runtime.createBuffer({
            size: 20,
            usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_INDIRECT,
        })
        const dispatchArguments = fixture.runtime.createBuffer({
            size: 12,
            usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_INDIRECT,
        })
        const indexBuffer = fixture.runtime.createBuffer({
            size: 8,
            usage: GPU_BUFFER_USAGE_INDEX | GPU_BUFFER_USAGE_COPY_DST,
        })
        const uploadIndices = fixture.runtime.createUploadCommand({
            target: indexBuffer,
            data: new Uint16Array([ 0, 1, 2 ]),
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
            count: { indirect: dispatchArguments },
            resources: { read: [ readResource(dispatchArguments, 1) ], write: [] },
            whenMissing: 'throw',
        })
        const consumeDraw = fixture.runtime.createDrawCommand({
            pipeline: fixture.pipeline,
            count: { indirect: drawArguments },
            resources: { read: [ readResource(drawArguments, 1) ], write: [] },
            whenMissing: 'throw',
        })
        const consumeIndexedDraw = fixture.runtime.createDrawCommand({
            pipeline: fixture.pipeline,
            indexBuffer: { buffer: indexBuffer, format: 'uint16', size: 6 },
            count: { indirect: indexedArguments },
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

        const indirectReads = submitted.resourceAccesses.filter(access =>
            access.access === 'read' &&
            [ drawArguments.id, indexedArguments.id, dispatchArguments.id ].includes(access.resourceId)
        )
        expect(indirectReads.map(access => ({
            resourceId: access.resourceId,
            before: access.contentEpochBefore,
            after: access.contentEpochAfter,
            stepKind: access.stepKind,
        }))).to.deep.equal([
            { resourceId: dispatchArguments.id, before: 1, after: 1, stepKind: 'compute' },
            { resourceId: drawArguments.id, before: 1, after: 1, stepKind: 'render' },
            { resourceId: indexedArguments.id, before: 1, after: 1, stepKind: 'render' },
        ])
        expect(submitted.producerEpochs.filter(epoch =>
            [ drawArguments.id, indexedArguments.id, dispatchArguments.id ].includes(epoch.resourceId)
        )).to.have.length(3)
        expect(fixture.calls.maps).to.deep.equal([])
    })

    it('applies existing readiness and epoch disposition to index and indirect reads', async() => {

        const fixture = await createRenderFixture()
        const emptyIndirect = fixture.runtime.createBuffer({
            size: 16,
            usage: GPU_BUFFER_USAGE_INDIRECT,
        })
        const emptyDraw = fixture.runtime.createDrawCommand({
            pipeline: fixture.pipeline,
            count: { indirect: emptyIndirect },
            resources: { read: [ readResource(emptyIndirect) ], write: [] },
            whenMissing: 'throw',
        })
        await expectDiagnostic(() => fixture.runtime.createSubmission({ validation: 'off' })
            .render(fixture.pass, [ emptyDraw ])
            .submit(), 'SCRATCH_COMMAND_RESOURCE_NOT_READY')
        expect(fixture.calls.commandEncoders).to.have.length(0)

        const emptyIndex = fixture.runtime.createBuffer({
            size: 8,
            usage: GPU_BUFFER_USAGE_INDEX,
        })
        const emptyIndexedDraw = fixture.runtime.createDrawCommand({
            pipeline: fixture.pipeline,
            indexBuffer: { buffer: emptyIndex, format: 'uint16' },
            count: { indexCount: 3 },
            resources: { read: [ readResource(emptyIndex) ], write: [] },
            whenMissing: 'throw',
        })
        await expectDiagnostic(() => fixture.runtime.createSubmission({ validation: 'warn' })
            .render(fixture.pass, [ emptyIndexedDraw ])
            .submit(), 'SCRATCH_COMMAND_RESOURCE_NOT_READY')
        expect(fixture.calls.commandEncoders).to.have.length(0)

        const readyIndirect = fixture.runtime.createBuffer({
            size: 16,
            usage: GPU_BUFFER_USAGE_INDIRECT | GPU_BUFFER_USAGE_COPY_DST,
        })
        fixture.runtime.createSubmission({ validation: 'throw' })
            .upload(fixture.runtime.createUploadCommand({
                target: readyIndirect,
                data: new Uint32Array([ 3, 1, 0, 0 ]),
            }))
            .submit()

        const futureDraw = fixture.runtime.createDrawCommand({
            pipeline: fixture.pipeline,
            count: { indirect: readyIndirect },
            resources: { read: [ readResource(readyIndirect, 2) ], write: [] },
            whenMissing: 'throw',
        })
        await expectDiagnostic(() => fixture.runtime.createSubmission({ validation: 'throw' })
            .render(fixture.pass, [ futureDraw ])
            .submit(), 'SCRATCH_SUBMISSION_READ_BEFORE_WRITE')

        const staleDraw = fixture.runtime.createDrawCommand({
            pipeline: fixture.pipeline,
            count: { indirect: readyIndirect },
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
