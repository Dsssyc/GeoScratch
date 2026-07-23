import { expect } from 'chai'
import {
    DrawCommand,
    ScratchDiagnosticError,
    ScratchRuntime,
    ScratchRenderPipeline,
} from 'geoscratch'
import { createFakeGpu, triangleWgsl } from './scratch-test-utils.js'

const GPU_BUFFER_USAGE_VERTEX = 0x20
const GPU_BUFFER_USAGE_COPY_DST = 0x08

function readResource(resource, contentEpoch = resource.contentEpoch) {

    return { resource, contentEpoch }
}

function createProgram(runtime) {

    return runtime.createProgram({
        label: 'hello triangle program',
        modules: [ triangleWgsl ],
        entryPoints: {
            vertex: 'vsMain',
            fragment: 'fsMain',
        },
    })
}

describe('scratch RenderPipeline and DrawCommand', () => {

    it('builds a real render pipeline with an explicit empty layout', async() => {

        const { gpu, calls } = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu })
        const program = createProgram(runtime)

        const pipeline = await runtime.createRenderPipeline({
            label: 'hello triangle pipeline',
            program,
            vertex: 'vsMain',
            fragment: 'fsMain',
            targets: [ { format: 'bgra8unorm' } ],
        })

        expect(pipeline).to.be.instanceOf(ScratchRenderPipeline)
        expect(pipeline.runtime).to.equal(runtime)
        expect(pipeline.program).to.equal(program)
        expect(pipeline.pipelineKind).to.equal('render')
        expect(pipeline.targetFormats).to.deep.equal([ 'bgra8unorm' ])
        expect(calls.pipelineLayouts).to.have.length(1)
        expect(calls.pipelineLayouts[0].descriptor).to.deep.equal({
            label: `hello triangle pipeline layout [scratch:${pipeline.id}]`,
            bindGroupLayouts: [],
        })
        expect(calls.renderPipelines).to.have.length(1)
        expect(calls.renderPipelines[0].descriptor.layout).to.equal(calls.pipelineLayouts[0])
        expect(calls.renderPipelines[0].descriptor.vertex.entryPoint).to.equal('vsMain')
        expect(calls.renderPipelines[0].descriptor.fragment.entryPoint).to.equal('fsMain')
        expect(calls.renderPipelines[0].descriptor.fragment.targets).to.deep.equal([
            { format: 'bgra8unorm' },
        ])
    })

    it('passes explicit vertex buffer layouts to render pipeline creation', async() => {

        const { gpu, calls } = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu })
        const program = createProgram(runtime)
        const vertexBuffers = [
            {
                arrayStride: 20,
                stepMode: 'vertex',
                attributes: [
                    { shaderLocation: 0, offset: 0, format: 'float32x2' },
                    { shaderLocation: 1, offset: 8, format: 'float32x3' },
                ],
            },
            {
                arrayStride: 4,
                stepMode: 'instance',
                attributes: [
                    { shaderLocation: 2, offset: 0, format: 'float32' },
                ],
            },
        ]

        const pipeline = await runtime.createRenderPipeline({
            label: 'vertex layout pipeline',
            program,
            vertexBuffers,
            targets: [ { format: 'bgra8unorm' } ],
        })

        expect(pipeline.vertexBuffers).to.deep.equal(vertexBuffers)
        expect(calls.renderPipelines[0].descriptor.vertex.buffers).to.deep.equal(vertexBuffers)
    })

    it('preserves explicit null pipeline slots without renumbering', async() => {

        const { gpu, calls } = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu })
        const program = createProgram(runtime)
        const layout = {
            arrayStride: 8,
            attributes: [
                { shaderLocation: 0, offset: 0, format: 'float32x2' },
            ],
        }
        const target = { format: 'bgra8unorm' }

        const pipeline = await runtime.createRenderPipeline({
            program,
            vertexBuffers: [ null, layout ],
            targets: [ null, target ],
        })

        expect(pipeline.vertexBuffers).to.deep.equal([ null, layout ])
        expect(pipeline.targets).to.deep.equal([ null, target ])
        expect(pipeline.targetFormats).to.deep.equal([ null, 'bgra8unorm' ])
        expect(calls.renderPipelines[0].descriptor.vertex.buffers)
            .to.deep.equal([ null, layout ])
        expect(calls.renderPipelines[0].descriptor.fragment.targets)
            .to.deep.equal([ null, target ])
    })

    it('rejects pipeline array holes and undefined slots with structured diagnostics', async() => {

        const vertexHole = new Array(1)
        const targetHole = new Array(1)
        const cases = [
            {
                vertexBuffers: vertexHole,
                targets: [ { format: 'bgra8unorm' } ],
                code: 'SCRATCH_PIPELINE_VERTEX_LAYOUT_MISMATCH',
                field: 'vertexBuffers',
            },
            {
                vertexBuffers: [ undefined ],
                targets: [ { format: 'bgra8unorm' } ],
                code: 'SCRATCH_PIPELINE_VERTEX_LAYOUT_MISMATCH',
                field: 'vertexBuffers',
            },
            {
                targets: targetHole,
                code: 'SCRATCH_PIPELINE_TARGET_STATE_INVALID',
                field: 'targets',
            },
            {
                targets: [ undefined ],
                code: 'SCRATCH_PIPELINE_TARGET_STATE_INVALID',
                field: 'targets',
            },
        ]

        for (const scenario of cases) {
            const { gpu, calls } = createFakeGpu()
            const runtime = await ScratchRuntime.create({ gpu })
            const program = createProgram(runtime)

            try {
                await runtime.createRenderPipeline({
                    program,
                    ...(scenario.vertexBuffers !== undefined
                        ? { vertexBuffers: scenario.vertexBuffers }
                        : {}),
                    targets: scenario.targets,
                })
                throw new Error('expected sparse pipeline slot validation to fail')
            } catch (error) {
                expect(error).to.be.instanceOf(ScratchDiagnosticError)
                expect(error.diagnostic).to.include({
                    code: scenario.code,
                    severity: 'error',
                    phase: 'pipeline',
                })
                expect(error.diagnostic.actual).to.include({
                    field: scenario.field,
                    slot: 0,
                })
                expect(calls.renderPipelines).to.have.length(0)
            }
        }
    })

    it('requires only non-null vertex slots and rejects bindings to null slots', async() => {

        const { gpu } = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu })
        const program = createProgram(runtime)
        const pipeline = await runtime.createRenderPipeline({
            program,
            vertexBuffers: [
                null,
                {
                    arrayStride: 8,
                    attributes: [
                        { shaderLocation: 0, offset: 0, format: 'float32x2' },
                    ],
                },
            ],
            targets: [ { format: 'bgra8unorm' } ],
        })
        const vertexBuffer = await runtime.createBuffer({
            size: 24,
            usage: GPU_BUFFER_USAGE_VERTEX | GPU_BUFFER_USAGE_COPY_DST,
        })

        const command = runtime.createDrawCommand({
            pipeline,
            count: { vertexCount: 3 },
            vertexBuffers: [ { slot: 1, region: vertexBuffer.region() } ],
            resources: {
                read: [ readResource(vertexBuffer) ],
                write: [],
            },
            whenMissing: 'throw',
        })

        expect(command.vertexBuffers.map(binding => binding.slot)).to.deep.equal([ 1 ])

        try {
            runtime.createDrawCommand({
                pipeline,
                count: { vertexCount: 3 },
                vertexBuffers: [
                    { slot: 0, region: vertexBuffer.region() },
                    { slot: 1, region: vertexBuffer.region() },
                ],
                resources: {
                    read: [ readResource(vertexBuffer) ],
                    write: [],
                },
                whenMissing: 'throw',
            })
            throw new Error('expected binding to null vertex slot to fail')
        } catch (error) {
            expect(error).to.be.instanceOf(ScratchDiagnosticError)
            expect(error.diagnostic).to.include({
                code: 'SCRATCH_COMMAND_VERTEX_BUFFER_INVALID',
                severity: 'error',
                phase: 'command',
            })
            expect(error.diagnostic.actual).to.deep.include({
                slot: 0,
                pipelineLayout: null,
            })
        }
    })

    it('rejects invalid vertex buffer layouts with structured diagnostics', async() => {

        const { gpu } = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu })
        const program = createProgram(runtime)

        try {
            await runtime.createRenderPipeline({
                program,
                vertexBuffers: [
                    {
                        arrayStride: 0,
                        attributes: [
                            { shaderLocation: 0, offset: 0, format: 'float32x2' },
                        ],
                    },
                ],
                targets: [ { format: 'bgra8unorm' } ],
            })
            throw new Error('expected invalid vertex buffer layout to fail')
        } catch (error) {
            expect(error).to.be.instanceOf(ScratchDiagnosticError)
            expect(error.diagnostic).to.include({
                code: 'SCRATCH_PIPELINE_VERTEX_LAYOUT_MISMATCH',
                severity: 'error',
                phase: 'pipeline',
            })
            expect(error.diagnostic.expected).to.deep.include({
                arrayStride: 'positive finite number',
            })
        }
    })

    it('rejects wrong-runtime programs with structured diagnostics', async() => {

        const runtimeA = await ScratchRuntime.create({ gpu: createFakeGpu().gpu })
        const runtimeB = await ScratchRuntime.create({ gpu: createFakeGpu().gpu })
        const program = createProgram(runtimeA)

        try {
            await runtimeB.createRenderPipeline({
                program,
                targets: [ { format: 'bgra8unorm' } ],
            })
            throw new Error('expected wrong-runtime program validation to fail')
        } catch (error) {
            expect(error).to.be.instanceOf(ScratchDiagnosticError)
            expect(error.diagnostic).to.include({
                code: 'SCRATCH_PROGRAM_WRONG_RUNTIME',
                severity: 'error',
                phase: 'program',
            })
            expect(error.diagnostic.expected).to.deep.equal({ runtimeId: runtimeA.id })
            expect(error.diagnostic.actual).to.deep.equal({ runtimeId: runtimeB.id })
        }
    })

    it('creates a static draw command that encodes setPipeline and draw', async() => {

        const { gpu, calls } = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu })
        const program = createProgram(runtime)
        const pipeline = await runtime.createRenderPipeline({
            program,
            targets: [ { format: 'bgra8unorm' } ],
        })
        const command = runtime.createDrawCommand({
            label: 'draw triangle',
            pipeline,
            count: { vertexCount: 3 },
            resources: {
                read: [],
                write: [],
            },
            whenMissing: 'throw',
        })
        const passEncoder = {
            setPipeline(pipelineValue) {
                calls.drawCalls.push({ type: 'setPipeline', pipeline: pipelineValue })
            },
            setViewport(x, y, width, height, minDepth, maxDepth) {
                calls.drawCalls.push({ type: 'setViewport', x, y, width, height, minDepth, maxDepth })
            },
            setScissorRect(x, y, width, height) {
                calls.drawCalls.push({ type: 'setScissorRect', x, y, width, height })
            },
            setBlendConstant(color) {
                calls.drawCalls.push({ type: 'setBlendConstant', color: [ ...color ] })
            },
            setStencilReference(reference) {
                calls.drawCalls.push({ type: 'setStencilReference', reference })
            },
            draw(vertexCount, instanceCount, firstVertex, firstInstance) {
                calls.drawCalls.push({ vertexCount, instanceCount, firstVertex, firstInstance })
            },
        }

        command.encode(passEncoder, { width: 64, height: 48 })

        expect(command).to.be.instanceOf(DrawCommand)
        expect(command.commandKind).to.equal('draw')
        expect(command.pipeline).to.equal(pipeline)
        expect(command.count).to.deep.equal({ vertexCount: 3 })
        expect(command.resources).to.deep.equal({ read: [], write: [] })
        expect(command.whenMissing).to.equal('throw')
        expect(calls.drawCalls).to.deep.equal([
            { type: 'setPipeline', pipeline: pipeline.gpuPipeline },
            { type: 'setViewport', x: 0, y: 0, width: 64, height: 48, minDepth: 0, maxDepth: 1 },
            { type: 'setScissorRect', x: 0, y: 0, width: 64, height: 48 },
            { type: 'setBlendConstant', color: [ 0, 0, 0, 0 ] },
            { type: 'setStencilReference', reference: 0 },
            { vertexCount: 3, instanceCount: 1, firstVertex: 0, firstInstance: 0 },
        ])
    })

    it('encodes vertex buffers before draw', async() => {

        const { gpu, calls } = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu })
        const program = createProgram(runtime)
        const pipeline = await runtime.createRenderPipeline({
            program,
            vertexBuffers: [
                {
                    arrayStride: 20,
                    attributes: [
                        { shaderLocation: 0, offset: 0, format: 'float32x2' },
                        { shaderLocation: 1, offset: 8, format: 'float32x3' },
                    ],
                },
                {
                    arrayStride: 4,
                    stepMode: 'instance',
                    attributes: [
                        { shaderLocation: 2, offset: 0, format: 'float32' },
                    ],
                },
            ],
            targets: [ { format: 'bgra8unorm' } ],
        })
        const vertexBuffer = await runtime.createBuffer({
            label: 'vertex attributes',
            size: 60,
            usage: GPU_BUFFER_USAGE_VERTEX | GPU_BUFFER_USAGE_COPY_DST,
        })
        const instanceBuffer = await runtime.createBuffer({
            label: 'instance attributes',
            size: 4,
            usage: GPU_BUFFER_USAGE_VERTEX | GPU_BUFFER_USAGE_COPY_DST,
        })
        const vertexRegion = vertexBuffer.region()
        const instanceRegion = instanceBuffer.region()
        const command = runtime.createDrawCommand({
            label: 'draw vertex buffer triangle',
            pipeline,
            vertexBuffers: [
                { slot: 0, region: vertexRegion },
                { slot: 1, region: instanceRegion },
            ],
            count: { vertexCount: 3, instanceCount: 1 },
            resources: {
                read: [
                    readResource(vertexBuffer),
                    readResource(instanceBuffer),
                ],
                write: [],
            },
            whenMissing: 'throw',
        })
        const passEncoder = {
            setPipeline(pipelineValue) {
                calls.drawCalls.push({ type: 'setPipeline', pipeline: pipelineValue })
            },
            setViewport(x, y, width, height, minDepth, maxDepth) {
                calls.drawCalls.push({ type: 'setViewport', x, y, width, height, minDepth, maxDepth })
            },
            setScissorRect(x, y, width, height) {
                calls.drawCalls.push({ type: 'setScissorRect', x, y, width, height })
            },
            setBlendConstant(color) {
                calls.drawCalls.push({ type: 'setBlendConstant', color: [ ...color ] })
            },
            setStencilReference(reference) {
                calls.drawCalls.push({ type: 'setStencilReference', reference })
            },
            setVertexBuffer(slot, buffer, offset, size) {
                calls.drawCalls.push({ type: 'setVertexBuffer', slot, buffer, offset, size })
            },
            draw(vertexCount, instanceCount, firstVertex, firstInstance) {
                calls.drawCalls.push({ type: 'draw', vertexCount, instanceCount, firstVertex, firstInstance })
            },
        }

        command.encode(passEncoder, { width: 64, height: 48 })

        expect(command.vertexBuffers).to.deep.equal([
            { slot: 0, region: vertexRegion },
            { slot: 1, region: instanceRegion },
        ])
        expect(command.resources).to.deep.equal({
            read: [
                readResource(vertexBuffer),
                readResource(instanceBuffer),
            ],
            write: [],
        })
        expect(calls.drawCalls).to.deep.equal([
            { type: 'setPipeline', pipeline: pipeline.gpuPipeline },
            { type: 'setViewport', x: 0, y: 0, width: 64, height: 48, minDepth: 0, maxDepth: 1 },
            { type: 'setScissorRect', x: 0, y: 0, width: 64, height: 48 },
            { type: 'setBlendConstant', color: [ 0, 0, 0, 0 ] },
            { type: 'setStencilReference', reference: 0 },
            { type: 'setVertexBuffer', slot: 0, buffer: vertexBuffer.gpuBuffer, offset: 0, size: 60 },
            { type: 'setVertexBuffer', slot: 1, buffer: instanceBuffer.gpuBuffer, offset: 0, size: 4 },
            { type: 'draw', vertexCount: 3, instanceCount: 1, firstVertex: 0, firstInstance: 0 },
        ])
    })

    it('rejects missing draw resource declarations with structured diagnostics', async() => {

        const { gpu } = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu })
        const program = createProgram(runtime)
        const pipeline = await runtime.createRenderPipeline({
            program,
            targets: [ { format: 'bgra8unorm' } ],
        })

        try {
            runtime.createDrawCommand({
                pipeline,
                count: { vertexCount: 3 },
                whenMissing: 'throw',
            })
            throw new Error('expected missing draw resources validation to fail')
        } catch (error) {
            expect(error).to.be.instanceOf(ScratchDiagnosticError)
            expect(error.diagnostic).to.include({
                code: 'SCRATCH_COMMAND_DECLARED_ACCESS_INCOMPLETE',
                severity: 'error',
                phase: 'command',
            })
            expect(error.diagnostic.expected).to.deep.equal({
                resources: { read: 'CommandResourceReadDescriptor[]', write: '(BufferResource | TextureResource)[]' },
            })
            expect(error.diagnostic.actual).to.deep.equal({ resources: undefined })
        }
    })

    it('rejects malformed draw resource declarations with structured diagnostics', async() => {

        const { gpu } = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu })
        const program = createProgram(runtime)
        const pipeline = await runtime.createRenderPipeline({
            program,
            targets: [ { format: 'bgra8unorm' } ],
        })

        try {
            runtime.createDrawCommand({
                pipeline,
                count: { vertexCount: 3 },
                resources: { read: 'positions', write: [] },
                whenMissing: 'throw',
            })
            throw new Error('expected malformed draw resources validation to fail')
        } catch (error) {
            expect(error).to.be.instanceOf(ScratchDiagnosticError)
            expect(error.diagnostic).to.include({
                code: 'SCRATCH_COMMAND_DECLARED_ACCESS_INCOMPLETE',
                severity: 'error',
                phase: 'command',
            })
            expect(error.diagnostic.expected).to.deep.equal({
                resources: { read: 'CommandResourceReadDescriptor[]', write: '(BufferResource | TextureResource)[]' },
            })
            expect(error.diagnostic.actual).to.deep.equal({
                resources: { read: 'positions', write: [] },
            })
        }
    })

    it('rejects bare draw read resources with structured diagnostics', async() => {

        const { gpu } = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu })
        const program = createProgram(runtime)
        const pipeline = await runtime.createRenderPipeline({
            program,
            targets: [ { format: 'bgra8unorm' } ],
        })
        const buffer = await runtime.createBuffer({
            size: 16,
            usage: GPU_BUFFER_USAGE_COPY_DST,
        })

        try {
            runtime.createDrawCommand({
                pipeline,
                count: { vertexCount: 3 },
                resources: {
                    read: [ buffer ],
                    write: [],
                },
                whenMissing: 'throw',
            })
            throw new Error('expected bare draw read resource validation to fail')
        } catch (error) {
            expect(error).to.be.instanceOf(ScratchDiagnosticError)
            expect(error.diagnostic).to.include({
                code: 'SCRATCH_COMMAND_DECLARED_ACCESS_INCOMPLETE',
                severity: 'error',
                phase: 'command',
            })
            expect(error.diagnostic.expected).to.deep.equal({
                read: {
                    resource: 'BufferResource | TextureResource',
                    contentEpoch: 'non-negative integer | "current-at-step"',
                },
            })
            expect(error.diagnostic.actual).to.deep.include({
                access: 'read',
                descriptor: 'BufferResource',
            })
        }
    })

    it('rejects incomplete or invalid draw read descriptors with structured diagnostics', async() => {

        const { gpu } = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu })
        const program = createProgram(runtime)
        const pipeline = await runtime.createRenderPipeline({
            program,
            targets: [ { format: 'bgra8unorm' } ],
        })
        const buffer = await runtime.createBuffer({
            size: 16,
            usage: GPU_BUFFER_USAGE_COPY_DST,
        })
        const cases = [
            {
                label: 'missing resource',
                descriptor: { contentEpoch: 0 },
                actual: { reason: 'resource', contentEpoch: 0 },
            },
            {
                label: 'missing contentEpoch',
                descriptor: { resource: buffer },
                actual: { reason: 'contentEpoch', resourceId: buffer.id },
            },
            {
                label: 'non-integer contentEpoch',
                descriptor: { resource: buffer, contentEpoch: 0.5 },
                actual: { reason: 'contentEpoch', resourceId: buffer.id, contentEpoch: 0.5 },
            },
            {
                label: 'negative contentEpoch',
                descriptor: { resource: buffer, contentEpoch: -1 },
                actual: { reason: 'contentEpoch', resourceId: buffer.id, contentEpoch: -1 },
            },
        ]

        for (const testCase of cases) {
            try {
                runtime.createDrawCommand({
                    label: testCase.label,
                    pipeline,
                    count: { vertexCount: 3 },
                    resources: {
                        read: [ testCase.descriptor ],
                        write: [],
                    },
                    whenMissing: 'throw',
                })
                throw new Error(`expected ${testCase.label} validation to fail`)
            } catch (error) {
                expect(error).to.be.instanceOf(ScratchDiagnosticError)
                expect(error.diagnostic).to.include({
                    code: 'SCRATCH_COMMAND_DECLARED_ACCESS_INCOMPLETE',
                    severity: 'error',
                    phase: 'command',
                })
                expect(error.diagnostic.expected).to.deep.equal({
                    read: {
                    resource: 'BufferResource | TextureResource',
                        contentEpoch: 'non-negative integer | "current-at-step"',
                    },
                })
                expect(error.diagnostic.actual).to.deep.include(testCase.actual)
            }
        }
    })

    it('rejects wrong-runtime draw resources with structured diagnostics', async() => {

        const runtimeA = await ScratchRuntime.create({ gpu: createFakeGpu().gpu })
        const runtimeB = await ScratchRuntime.create({ gpu: createFakeGpu().gpu })
        const program = createProgram(runtimeA)
        const pipeline = await runtimeA.createRenderPipeline({
            program,
            targets: [ { format: 'bgra8unorm' } ],
        })
        const foreignBuffer = await runtimeB.createBuffer({
            size: 16,
            usage: GPU_BUFFER_USAGE_COPY_DST,
        })

        try {
            runtimeA.createDrawCommand({
                pipeline,
                count: { vertexCount: 3 },
                resources: {
                    read: [ readResource(foreignBuffer) ],
                    write: [],
                },
                whenMissing: 'throw',
            })
            throw new Error('expected wrong-runtime draw resource validation to fail')
        } catch (error) {
            expect(error).to.be.instanceOf(ScratchDiagnosticError)
            expect(error.diagnostic).to.include({
                code: 'SCRATCH_RESOURCE_WRONG_RUNTIME',
                severity: 'error',
                phase: 'resource',
            })
            expect(error.diagnostic.expected).to.deep.equal({ runtimeId: runtimeB.id })
            expect(error.diagnostic.actual).to.deep.equal({ runtimeId: runtimeA.id })
        }
    })

    it('rejects disposed draw resources with structured diagnostics', async() => {

        const { gpu } = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu })
        const program = createProgram(runtime)
        const pipeline = await runtime.createRenderPipeline({
            program,
            targets: [ { format: 'bgra8unorm' } ],
        })
        const buffer = await runtime.createBuffer({
            size: 16,
            usage: GPU_BUFFER_USAGE_COPY_DST,
        })

        buffer.dispose()

        try {
            runtime.createDrawCommand({
                pipeline,
                count: { vertexCount: 3 },
                resources: {
                    read: [ readResource(buffer) ],
                    write: [],
                },
                whenMissing: 'throw',
            })
            throw new Error('expected disposed draw resource validation to fail')
        } catch (error) {
            expect(error).to.be.instanceOf(ScratchDiagnosticError)
            expect(error.diagnostic).to.include({
                code: 'SCRATCH_RESOURCE_DISPOSED',
                severity: 'error',
                phase: 'resource',
            })
        }
    })

    it('rejects wrong-runtime vertex buffers with structured diagnostics', async() => {

        const runtimeA = await ScratchRuntime.create({ gpu: createFakeGpu().gpu })
        const runtimeB = await ScratchRuntime.create({ gpu: createFakeGpu().gpu })
        const program = createProgram(runtimeA)
        const pipeline = await runtimeA.createRenderPipeline({
            program,
            vertexBuffers: [
                {
                    arrayStride: 8,
                    attributes: [
                        { shaderLocation: 0, offset: 0, format: 'float32x2' },
                    ],
                },
            ],
            targets: [ { format: 'bgra8unorm' } ],
        })
        const foreignBuffer = await runtimeB.createBuffer({
            size: 24,
            usage: GPU_BUFFER_USAGE_VERTEX,
        })

        try {
            runtimeA.createDrawCommand({
                pipeline,
                vertexBuffers: [
                    { slot: 0, region: foreignBuffer.region() },
                ],
                count: { vertexCount: 3 },
                resources: {
                    read: [ readResource(foreignBuffer) ],
                    write: [],
                },
                whenMissing: 'throw',
            })
            throw new Error('expected wrong-runtime vertex buffer validation to fail')
        } catch (error) {
            expect(error).to.be.instanceOf(ScratchDiagnosticError)
            expect(error.diagnostic).to.include({
                code: 'SCRATCH_RESOURCE_WRONG_RUNTIME',
                severity: 'error',
                phase: 'resource',
            })
            expect(error.diagnostic.expected).to.deep.equal({ runtimeId: runtimeB.id })
            expect(error.diagnostic.actual).to.deep.equal({ runtimeId: runtimeA.id })
        }
    })

    it('rejects disposed vertex buffers with structured diagnostics', async() => {

        const { gpu } = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu })
        const program = createProgram(runtime)
        const pipeline = await runtime.createRenderPipeline({
            program,
            vertexBuffers: [
                {
                    arrayStride: 8,
                    attributes: [
                        { shaderLocation: 0, offset: 0, format: 'float32x2' },
                    ],
                },
            ],
            targets: [ { format: 'bgra8unorm' } ],
        })
        const buffer = await runtime.createBuffer({
            size: 24,
            usage: GPU_BUFFER_USAGE_VERTEX,
        })
        const region = buffer.region()

        buffer.dispose()

        try {
            runtime.createDrawCommand({
                pipeline,
                vertexBuffers: [
                    { slot: 0, region },
                ],
                count: { vertexCount: 3 },
                resources: {
                    read: [ readResource(buffer) ],
                    write: [],
                },
                whenMissing: 'throw',
            })
            throw new Error('expected disposed vertex buffer validation to fail')
        } catch (error) {
            expect(error).to.be.instanceOf(ScratchDiagnosticError)
            expect(error.diagnostic).to.include({
                code: 'SCRATCH_RESOURCE_DISPOSED',
                severity: 'error',
                phase: 'resource',
            })
        }
    })

    it('rejects invalid and unaligned vertex buffer bindings with structured diagnostics', async() => {

        const { gpu } = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu })
        const program = createProgram(runtime)
        const pipeline = await runtime.createRenderPipeline({
            program,
            vertexBuffers: [
                {
                    arrayStride: 8,
                    attributes: [
                        { shaderLocation: 0, offset: 0, format: 'float32x2' },
                    ],
                },
            ],
            targets: [ { format: 'bgra8unorm' } ],
        })
        const buffer = await runtime.createBuffer({
            size: 24,
            usage: GPU_BUFFER_USAGE_COPY_DST,
        })

        try {
            runtime.createDrawCommand({
                pipeline,
                vertexBuffers: [
                    { slot: 0, region: buffer.region({ size: 0 }) },
                ],
                count: { vertexCount: 3 },
                resources: {
                    read: [ readResource(buffer) ],
                    write: [],
                },
                whenMissing: 'throw',
            })
            throw new Error('expected invalid vertex buffer binding to fail')
        } catch (error) {
            expect(error).to.be.instanceOf(ScratchDiagnosticError)
            expect(error.diagnostic).to.include({
                code: 'SCRATCH_COMMAND_VERTEX_BUFFER_INVALID',
                severity: 'error',
                phase: 'command',
            })
            expect(error.diagnostic.expected).to.deep.include({
                region: 'non-empty BufferRegion',
            })
        }

        const vertexBuffer = await runtime.createBuffer({
            size: 24,
            usage: GPU_BUFFER_USAGE_VERTEX,
        })
        try {
            runtime.createDrawCommand({
                pipeline,
                vertexBuffers: [
                    { slot: 0, region: vertexBuffer.region({ offset: 2, size: 16 }) },
                ],
                count: { vertexCount: 2 },
                resources: {
                    read: [ readResource(vertexBuffer) ],
                    write: [],
                },
                whenMissing: 'throw',
            })
            throw new Error('expected unaligned vertex buffer binding to fail')
        } catch (error) {
            expect(error).to.be.instanceOf(ScratchDiagnosticError)
            expect(error.diagnostic).to.include({
                code: 'SCRATCH_COMMAND_VERTEX_BUFFER_INVALID',
                severity: 'error',
                phase: 'command',
            })
            expect(error.diagnostic.expected).to.deep.include({
                regionOffset: 'aligned to 4 bytes',
            })
        }
    })

    it('rejects invalid draw counts with structured diagnostics', async() => {

        const { gpu } = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu })
        const program = createProgram(runtime)
        const pipeline = await runtime.createRenderPipeline({
            program,
            targets: [ { format: 'bgra8unorm' } ],
        })

        try {
            runtime.createDrawCommand({
                pipeline,
                count: { vertexCount: 0.5 },
                resources: {
                    read: [],
                    write: [],
                },
                whenMissing: 'throw',
            })
            throw new Error('expected invalid draw count to fail')
        } catch (error) {
            expect(error).to.be.instanceOf(ScratchDiagnosticError)
            expect(error.diagnostic).to.include({
                code: 'SCRATCH_COMMAND_COUNT_INVALID',
                severity: 'error',
                phase: 'command',
            })
            expect(error.diagnostic.expected).to.deep.equal({
                vertexCount: 'unsigned 32-bit integer',
            })
        }
    })

    it('rejects disposed pipelines with structured diagnostics', async() => {

        const { gpu } = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu })
        const program = createProgram(runtime)
        const pipeline = await runtime.createRenderPipeline({
            label: 'temporary pipeline',
            program,
            targets: [ { format: 'bgra8unorm' } ],
        })

        pipeline.dispose()

        try {
            runtime.createDrawCommand({
                pipeline,
                count: { vertexCount: 3 },
                resources: {
                    read: [],
                    write: [],
                },
                whenMissing: 'throw',
            })
            throw new Error('expected disposed pipeline validation to fail')
        } catch (error) {
            expect(error).to.be.instanceOf(ScratchDiagnosticError)
            expect(error.diagnostic).to.include({
                code: 'SCRATCH_PIPELINE_DISPOSED',
                severity: 'error',
                phase: 'pipeline',
            })
        }
    })
})
