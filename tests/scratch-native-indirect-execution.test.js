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

    return { ...fake, runtime, pipeline, pass }
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
})
