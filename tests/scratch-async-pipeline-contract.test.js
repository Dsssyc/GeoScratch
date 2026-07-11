import { expect } from 'chai'
import {
    ScratchComputePipeline,
    ScratchDiagnosticError,
    ScratchRenderPipeline,
    ScratchRuntime,
} from 'geoscratch'
import {
    createGpuIncidentReport,
    createGpuOperationRecord,
} from '../packages/geoscratch/dist/scratch/gpu-operation.js'
import { createFakeGpu, triangleWgsl } from './scratch-test-utils.js'

function createProgram(runtime) {

    return runtime.createProgram({
        label: 'async pipeline contract program',
        modules: [ triangleWgsl ],
        entryPoints: {
            vertex: 'vsMain',
            fragment: 'fsMain',
            compute: 'csMain',
        },
    })
}

describe('scratch async pipeline public contract', () => {

    it('returns ordinary Promises for both render factories', async() => {

        const { gpu } = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu })
        const program = createProgram(runtime)

        const primary = runtime.createRenderPipeline({
            program,
            targets: [ { format: 'bgra8unorm' } ],
        })
        const alias = runtime.renderPipeline({
            program,
            targets: [ { format: 'bgra8unorm' } ],
        })

        expect(primary).to.be.instanceOf(Promise)
        expect(alias).to.be.instanceOf(Promise)
        expect(await primary).to.be.instanceOf(ScratchRenderPipeline)
        expect(await alias).to.be.instanceOf(ScratchRenderPipeline)
    })

    it('returns ordinary Promises for both compute factories', async() => {

        const { gpu } = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu })
        const program = createProgram(runtime)

        const primary = runtime.createComputePipeline({ program })
        const alias = runtime.computePipeline({ program })

        expect(primary).to.be.instanceOf(Promise)
        expect(alias).to.be.instanceOf(Promise)
        expect(await primary).to.be.instanceOf(ScratchComputePipeline)
        expect(await alias).to.be.instanceOf(ScratchComputePipeline)
    })

    it('closes direct render and compute construction', async() => {

        const { gpu } = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu })
        const program = createProgram(runtime)

        for (const Pipeline of [ ScratchRenderPipeline, ScratchComputePipeline ]) {
            expect(() => new Pipeline(runtime, {
                program,
                targets: [ { format: 'bgra8unorm' } ],
            })).to.throw(ScratchDiagnosticError)
        }
    })
})

describe('scratch GPU provenance schema v2 contract', () => {

    it('encodes a resource operation through an explicit resource target', () => {

        const record = createGpuOperationRecord({
            sequence: 1,
            id: 'operation-1',
            kind: 'buffer-allocation',
            status: 'succeeded',
            runtimeId: 'runtime-1',
            target: {
                kind: 'resource',
                resourceId: 'buffer-1',
                resourceKind: 'BufferResource',
                allocationVersion: 1,
                contentEpoch: 0,
                logicalFootprintBytes: 16,
            },
            descriptor: {
                hash: 'descriptor-1',
                summary: { size: 16, usage: 1 },
            },
        })

        expect(record.version).to.equal(2)
        expect(record.target).to.deep.equal({
            kind: 'resource',
            resourceId: 'buffer-1',
            resourceKind: 'BufferResource',
            allocationVersion: 1,
            contentEpoch: 0,
            logicalFootprintBytes: 16,
        })
        expect(record).not.to.have.any.keys(
            'resourceId',
            'allocationVersion',
            'contentEpoch',
            'logicalFootprintBytes'
        )
        expect(JSON.parse(JSON.stringify(record))).to.deep.equal(record)
    })

    it('encodes pipeline operations without fabricated resource facts', () => {

        const record = createGpuOperationRecord({
            sequence: 2,
            id: 'operation-2',
            kind: 'render-pipeline-creation',
            status: 'succeeded',
            runtimeId: 'runtime-1',
            target: {
                kind: 'pipeline',
                pipelineId: 'pipeline-1',
                pipelineKind: 'render',
                programId: 'program-1',
                programSourceHash: 'source-1',
            },
            descriptor: {
                hash: 'descriptor-2',
                summary: { targetFormats: [ 'bgra8unorm' ] },
            },
        })

        expect(record.version).to.equal(2)
        expect(record.target.kind).to.equal('pipeline')
        expect(record.target).not.to.have.any.keys(
            'resourceId',
            'allocationVersion',
            'contentEpoch',
            'logicalFootprintBytes'
        )
        expect(Object.isFrozen(record.target)).to.equal(true)
    })

    it('keeps pipeline incidents source-free and pressure-free', () => {

        const operation = createGpuOperationRecord({
            sequence: 2,
            id: 'operation-2',
            kind: 'compute-pipeline-creation',
            status: 'failed',
            runtimeId: 'runtime-1',
            target: {
                kind: 'pipeline',
                pipelineId: 'pipeline-2',
                pipelineKind: 'compute',
                programId: 'program-2',
                programSourceHash: 'source-2',
            },
            descriptor: {
                hash: 'descriptor-2',
                summary: { entryPoint: 'main' },
            },
        })
        const report = createGpuIncidentReport({
            sequence: 1,
            id: 'incident-1',
            kind: 'pipeline-failure',
            diagnosticCode: 'SCRATCH_PIPELINE_CREATION_VALIDATION_FAILED',
            nativeErrorCategory: 'validation',
            attribution: 'exact-operation',
            runtimeId: 'runtime-1',
            target: operation.target,
            operationId: operation.id,
            triggerOperation: operation,
            recentOperations: [ operation ],
            failureStage: 'pipeline-creation',
            evidence: {
                complete: true,
                overwrittenOperations: 0,
                overwrittenIncidents: 0,
                omittedRecords: 0,
            },
        })

        expect(report.version).to.equal(2)
        expect(report.target).to.deep.equal(operation.target)
        expect(report).not.to.have.property('pressure')
        expect(JSON.stringify(report)).not.to.include(triangleWgsl)
    })
})

