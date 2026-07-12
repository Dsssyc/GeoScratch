import { expect } from 'chai'
import {
    ScratchDiagnosticError,
    ScratchRuntime,
} from 'geoscratch'
import {
    diagnosticsControllerFor,
} from '../packages/geoscratch/dist/scratch/runtime-diagnostics.js'
import {
    serializedEvidenceBytes,
} from '../packages/geoscratch/dist/scratch/gpu-operation.js'
import {
    createFakeGpu,
    createFakePipelineError,
    triangleWgsl,
} from './scratch-test-utils.js'

const computeWgsl = `
override scale: f32 = 1.0;
@compute @workgroup_size(1)
fn csMain() {
    let value = scale;
}
`

describe('ScratchRuntime pipeline lifecycle and bounded evidence', () => {

    it('keeps pending, live, disposed, and retained facts bounded under sustained churn', async() => {

        const { gpu } = createFakeGpu()
        const runtime = await ScratchRuntime.create({
            gpu,
            diagnostics: {
                operationCapacity: 8,
                incidentCapacity: 4,
                evidenceByteCapacity: 32_768,
                recentOperationLimit: 4,
                contributorLimit: 2,
            },
        })
        const controller = diagnosticsControllerFor(runtime)
        const renderProgram = createRenderProgram(runtime)
        const computeProgram = createComputeProgram(runtime)

        for (let index = 0; index < 64; index++) {
            const pipeline = index % 2 === 0
                ? await runtime.createRenderPipeline({
                    label: `churn render ${index}`,
                    program: renderProgram,
                    targets: [ { format: 'bgra8unorm' } ],
                })
                : await runtime.createComputePipeline({
                    label: `churn compute ${index}`,
                    program: computeProgram,
                    constants: { scale: index },
                })
            const live = runtime.diagnostics.snapshot()
            expect(live.pendingOperations).to.have.length(0)
            expect(live.pipelines).to.have.length(1)
            expect(runtime._pipelines.size).to.equal(1)
            expect(controller.lifecycleSubscriberCount).to.equal(0)

            pipeline.dispose()
            expect(runtime.diagnostics.snapshot().pipelines).to.have.length(0)
            expect(runtime._pipelines.size).to.equal(0)
        }

        const snapshot = runtime.diagnostics.snapshot()
        expect(snapshot.pendingOperations).to.have.length(0)
        expect(snapshot.pipelines).to.have.length(0)
        expect(snapshot.recorder.retainedOperationCount).to.be.at.most(8)
        expect(snapshot.recorder.retainedIncidentCount).to.equal(0)
        expect(snapshot.recorder.retainedEvidenceBytes).to.be.at.most(32_768)
        expect(snapshot.aggregates).to.deep.include({
            pipelineCreationAttempts: 64,
            successfulPipelineCreations: 64,
            failedPipelineCreations: 0,
            cancelledPipelineCreations: 0,
            pipelineDisposals: 64,
        })
        expect(runtime.diagnostics.operations()).to.have.length.at.most(8)
        expect(runtime.diagnostics.operations().every(operation => [
            'render-pipeline-creation',
            'compute-pipeline-creation',
            'pipeline-disposal',
        ].includes(operation.kind))).to.equal(true)
    })

    it('preserves complete native labels while bounding successful current and history facts', async() => {

        const fake = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const label = `successful-pipeline-${'p'.repeat(100_000)}`
        const pipeline = await runtime.createComputePipeline({
            label,
            program: createComputeProgram(runtime),
        })
        const suffix = ` [scratch:${pipeline.id}]`
        const operation = runtime.diagnostics.operations({ pipelineId: pipeline.id })[0]
        const current = runtime.diagnostics.snapshot().pipelines[0]
        const exportedJson = JSON.stringify(runtime.diagnostics.exportEvidence())

        expect(fake.calls.asyncPipelineRequests[0].descriptor.label).to.equal(`${label}${suffix}`)
        expect(operation.nativeLabel.length).to.be.at.most(256)
        expect(operation.nativeLabel.endsWith(suffix)).to.equal(true)
        expect(operation.nativeLabels.pipeline.value.length).to.be.at.most(256)
        expect(operation.nativeLabels.pipeline.truncated).to.equal(true)
        expect(current.label.length).to.be.at.most(256)
        expect(exportedJson).not.to.include(label)

        pipeline.dispose()
        expect(runtime.diagnostics.snapshot().pipelines).to.have.length(0)
    })

    it('bounds returned pipeline diagnostics and incidents without retaining WGSL', async() => {

        const oversized = 'x'.repeat(100_000)
        const pipelineLabel = `oversized-pipeline-${oversized}`
        const programLabel = `oversized-program-${oversized}`
        const layoutLabel = `oversized-layout-${oversized}`
        const sourceSentinel = 'PIPELINE_SOURCE_SENTINEL_MUST_NOT_ESCAPE'
        const nativeMessage = `native-message-${'m'.repeat(100_000)}`
        const fake = createFakeGpu({
            compilationMessages: [ {
                type: 'error',
                message: nativeMessage,
                offset: 0,
                length: 0,
                lineNum: 0,
                linePos: 0,
            } ],
        })
        const runtime = await ScratchRuntime.create({
            gpu: fake.gpu,
            diagnostics: {
                operationCapacity: 2,
                incidentCapacity: 2,
                evidenceByteCapacity: 32_768,
            },
        })
        const program = runtime.createProgram({
            label: programLabel,
            modules: [ `${sourceSentinel}\n${triangleWgsl}` ],
            entryPoints: { vertex: 'vsMain', fragment: 'fsMain' },
        })
        const bindLayout = runtime.createBindLayout({
            label: layoutLabel,
            group: 0,
            entries: [ {
                binding: 0,
                name: 'unusedUniform',
                type: 'uniform',
                visibility: [ 'vertex' ],
            } ],
        })

        const error = await rejectedDiagnostic(runtime.createRenderPipeline({
            label: pipelineLabel,
            program,
            bindLayouts: [ bindLayout ],
            targets: [ { format: 'bgra8unorm' } ],
        }))
        const suffix = ` [scratch:${error.incident.target.pipelineId}]`
        const incidentJson = JSON.stringify(error.incident)
        const diagnosticJson = JSON.stringify(error.diagnostic)

        expect(fake.calls.asyncPipelineRequests[0].descriptor.label)
            .to.equal(`${pipelineLabel}${suffix}`)
        expect(error.incident.compilationReport.messages[0].message.length).to.be.at.most(4_096)
        expect(error.incident.triggerOperation.nativeLabel.length).to.be.at.most(256)
        expect(error.incident.triggerOperation.nativeLabel.endsWith(suffix)).to.equal(true)
        expect(error.incident.related.every(subject =>
            subject.label === undefined || subject.label.length <= 256
        )).to.equal(true)
        expect(error.diagnostic.subject.label?.length ?? 0).to.be.at.most(256)
        expect((error.diagnostic.related ?? []).every(subject =>
            subject.label === undefined || subject.label.length <= 256
        )).to.equal(true)
        expect(incidentJson.length).to.be.lessThan(32_768)
        expect(diagnosticJson.length).to.be.lessThan(16_384)
        expect(incidentJson).not.to.include(sourceSentinel)
        expect(diagnosticJson).not.to.include(sourceSentinel)
        expect(incidentJson).not.to.include(pipelineLabel)
        expect(incidentJson).not.to.include(programLabel)
        expect(incidentJson).not.to.include(layoutLabel)
        expect(error.incident).not.to.have.property('pressure')
        expect(runtime.diagnostics.snapshot().pipelines).to.have.length(0)
        expect(runtime.diagnostics.snapshot().pendingOperations).to.have.length(0)
    })

    it('bounds related subjects and independent lifecycle outcomes with explicit omissions', async() => {

        const fake = createFakeGpu({
            deferCompilationInfo: true,
            deferAsyncPipelines: true,
        })
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const program = createRenderProgram(runtime)
        const bindLayouts = Array.from({ length: 80 }, (_, group) =>
            runtime.createBindLayout({
                group,
                entries: [ {
                    binding: 0,
                    name: `entry${group}`,
                    type: 'uniform',
                    visibility: [ 'vertex' ],
                } ],
            })
        )
        const promise = runtime.createRenderPipeline({
            program,
            bindLayouts,
            targets: [ { format: 'bgra8unorm' } ],
        })

        for (const layout of bindLayouts) layout.dispose()
        fake.pipelines.resolveCompilation(0, { messages: [] })
        fake.pipelines.resolvePipeline(0)
        const error = await rejectedDiagnostic(promise)

        expect(error.incident.related).to.have.length.at.most(64)
        expect(error.incident.outcomes).to.have.length.at.most(64)
        expect(error.incident.related.slice(0, 3).map(subject => subject.kind)).to.deep.equal([
            'ScratchRuntime',
            'Program',
            'GpuOperation',
        ])
        expect(error.incident.evidence.complete).to.equal(false)
        expect(error.incident.evidence.omittedRecords).to.equal(35)
        expect(error.diagnostic.actual).to.deep.include({
            failureCount: 80,
            retainedFailureCount: 64,
            omittedFailureCount: 16,
        })
        expect(error.diagnostic.actual.failureStages).to.have.length.at.most(64)
        expect(error.diagnostic.actual.diagnosticCodes).to.have.length.at.most(64)
        expect(JSON.stringify(error.incident).length).to.be.lessThan(65_536)
        expect(JSON.stringify(error.diagnostic).length).to.be.lessThan(32_768)
        expect(runtime.diagnostics.snapshot().pendingOperations).to.have.length(0)
        expect(runtime.diagnostics.snapshot().pipelines).to.have.length(0)
    })

    it('captures full pipeline descriptors and stacks only inside a finite source-free capture', async() => {

        const { gpu } = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu })
        const renderProgram = createRenderProgram(runtime)
        const computeProgram = createComputeProgram(runtime)
        const capture = runtime.diagnostics.capture({
            maxOperations: 2,
            maxDurationMs: 1_000,
            maxEvidenceBytes: 65_536,
            includeStacks: true,
            includeDescriptors: true,
        })

        const render = await runtime.createRenderPipeline({
            label: 'captured render',
            program: renderProgram,
            targets: [ {
                format: 'bgra8unorm',
                writeMask: 0xF,
            } ],
            primitive: { topology: 'triangle-list', cullMode: 'back' },
            multisample: { count: 1 },
        })
        const compute = await runtime.createComputePipeline({
            label: 'captured compute',
            program: computeProgram,
            constants: { scale: 7 },
        })
        const report = capture.stop()
        const reportJson = JSON.stringify(report)

        expect(report.stopReason).to.equal('operation-limit')
        expect(report.operations.map(operation => operation.kind)).to.deep.equal([
            'render-pipeline-creation',
            'compute-pipeline-creation',
        ])
        expect(report.operations.every(operation => typeof operation.stack === 'string')).to.equal(true)
        expect(report.operations.every(operation => operation.descriptor.full !== undefined)).to.equal(true)
        expect(report.operations[0].descriptor.full.targets).to.deep.equal([ {
            format: 'bgra8unorm',
            writeMask: 0xF,
        } ])
        expect(report.operations[1].descriptor.full.constants).to.deep.equal({ scale: 7 })
        expect(report.operations.every(operation => operation.compilationReport !== undefined)).to.equal(true)
        expect(report.retainedEvidenceBytes).to.be.at.most(65_536)
        expect(reportJson).not.to.include(triangleWgsl)
        expect(reportJson).not.to.include(computeWgsl)
        expect(runtime.diagnostics.operations().every(operation => operation.stack === undefined)).to.equal(true)
        expect(runtime.diagnostics.operations().every(operation => operation.descriptor.full === undefined)).to.equal(true)
        expect(Object.isFrozen(report)).to.equal(true)
        expect(JSON.parse(reportJson)).to.deep.equal(report)

        render.dispose()
        compute.dispose()
    })

    it('links real pipeline failures into capture when default history capacities are zero', async() => {

        const fake = createFakeGpu()
        const runtime = await ScratchRuntime.create({
            gpu: fake.gpu,
            diagnostics: {
                operationCapacity: 0,
                incidentCapacity: 0,
            },
        })
        const capture = runtime.diagnostics.capture({
            maxOperations: 1,
            maxDurationMs: 1_000,
            maxEvidenceBytes: 32_768,
        })
        const program = createComputeProgram(runtime)
        fake.pipelines.rejectNextPipeline(
            'compute',
            createFakePipelineError('validation', 'captured compute validation')
        )

        const error = await rejectedDiagnostic(runtime.createComputePipeline({ program }))
        const report = capture.stop()

        expect(runtime.diagnostics.operations()).to.have.length(0)
        expect(runtime.diagnostics.incidents()).to.have.length(0)
        expect(runtime.diagnostics.snapshot().pendingOperations).to.have.length(0)
        expect(runtime.diagnostics.snapshot().pipelines).to.have.length(0)
        expect(report.operations).to.have.length(1)
        expect(report.operations[0].incidentId).to.equal(error.incident.id)
        expect(report.operations[0].target.pipelineId).to.equal(error.incident.target.pipelineId)
        expect(report.retainedEvidenceBytes).to.equal(
            serializedEvidenceBytes(report.operations[0])
        )
    })
})

function createRenderProgram(runtime) {

    return runtime.createProgram({
        modules: [ triangleWgsl ],
        entryPoints: { vertex: 'vsMain', fragment: 'fsMain' },
    })
}

function createComputeProgram(runtime) {

    return runtime.createProgram({
        modules: [ computeWgsl ],
        entryPoints: { compute: 'csMain' },
    })
}

async function rejectedDiagnostic(promise) {

    try {
        await promise
    } catch (error) {
        expect(error).to.be.instanceOf(ScratchDiagnosticError)
        return error
    }
    throw new Error('Expected a ScratchDiagnosticError rejection.')
}
