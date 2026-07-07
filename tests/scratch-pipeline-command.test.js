import { expect } from 'chai'
import {
    DrawCommand,
    ScratchDiagnosticError,
    ScratchRuntime,
    ScratchRenderPipeline,
} from '../packages/geoscratch/src/index.js'
import { createFakeGpu, triangleWgsl } from './scratch-test-utils.js'

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

        const pipeline = runtime.createRenderPipeline({
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
            label: 'hello triangle pipeline layout',
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

    it('rejects wrong-runtime programs with structured diagnostics', async() => {

        const runtimeA = await ScratchRuntime.create({ gpu: createFakeGpu().gpu })
        const runtimeB = await ScratchRuntime.create({ gpu: createFakeGpu().gpu })
        const program = createProgram(runtimeA)

        try {
            runtimeB.createRenderPipeline({
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
        const pipeline = runtime.createRenderPipeline({
            program,
            targets: [ { format: 'bgra8unorm' } ],
        })
        const command = runtime.createDrawCommand({
            label: 'draw triangle',
            pipeline,
            count: { vertexCount: 3 },
            whenMissing: 'throw',
        })
        const passEncoder = {
            setPipeline(pipelineValue) {
                calls.drawCalls.push({ type: 'setPipeline', pipeline: pipelineValue })
            },
            draw(vertexCount, instanceCount, firstVertex, firstInstance) {
                calls.drawCalls.push({ vertexCount, instanceCount, firstVertex, firstInstance })
            },
        }

        command.encode(passEncoder)

        expect(command).to.be.instanceOf(DrawCommand)
        expect(command.commandKind).to.equal('draw')
        expect(command.pipeline).to.equal(pipeline)
        expect(command.count).to.deep.equal({ vertexCount: 3 })
        expect(command.whenMissing).to.equal('throw')
        expect(calls.drawCalls).to.deep.equal([
            { type: 'setPipeline', pipeline: pipeline.gpuPipeline },
            { vertexCount: 3, instanceCount: 1, firstVertex: 0, firstInstance: 0 },
        ])
    })

    it('rejects invalid draw counts with structured diagnostics', async() => {

        const { gpu } = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu })
        const program = createProgram(runtime)
        const pipeline = runtime.createRenderPipeline({
            program,
            targets: [ { format: 'bgra8unorm' } ],
        })

        try {
            runtime.createDrawCommand({
                pipeline,
                count: { vertexCount: 0 },
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
                vertexCount: 'positive finite number',
            })
        }
    })

    it('rejects disposed pipelines with structured diagnostics', async() => {

        const { gpu } = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu })
        const program = createProgram(runtime)
        const pipeline = runtime.createRenderPipeline({
            label: 'temporary pipeline',
            program,
            targets: [ { format: 'bgra8unorm' } ],
        })

        pipeline.dispose()

        try {
            runtime.createDrawCommand({
                pipeline,
                count: { vertexCount: 3 },
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
