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
    serializedEvidenceBytes,
} from '../packages/geoscratch/dist/scratch/gpu-operation.js'
import { diagnosticsControllerFor } from '../packages/geoscratch/dist/scratch/runtime-diagnostics.js'
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

        const cases = [
            {
                Pipeline: ScratchRenderPipeline,
                descriptor: { program, targets: [ { format: 'bgra8unorm' } ] },
            },
            {
                Pipeline: ScratchComputePipeline,
                descriptor: { program },
            },
        ]
        for (const { Pipeline, descriptor } of cases) {
            for (const Candidate of [ Pipeline, class extends Pipeline {} ]) {
                try {
                    new Candidate(runtime, descriptor)
                    throw new Error('expected direct pipeline construction to fail')
                } catch (error) {
                    expect(error).to.be.instanceOf(ScratchDiagnosticError)
                    expect(error.diagnostic.code).to.equal('SCRATCH_PIPELINE_CONSTRUCTOR_PRIVATE')
                }
            }
        }
    })
})

describe('scratch GPU provenance schema v3 contract', () => {

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

        expect(record.version).to.equal(3)
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

        expect(record.version).to.equal(3)
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
            pressure: {
                triggerLogicalFootprintBytes: 1,
                currentScratchLogicalFootprintBytes: 1,
                peakScratchLogicalFootprintBytes: 1,
                liveResourceCounts: {},
                largestContributors: [],
                recentChurn: [],
                caveats: [],
            },
            evidence: {
                complete: true,
                overwrittenOperations: 0,
                overwrittenIncidents: 0,
                omittedRecords: 0,
            },
        })

        expect(report.version).to.equal(3)
        expect(report.target).to.deep.equal(operation.target)
        expect(report.failureStage).to.equal('pipeline-creation')
        expect(report).not.to.have.property('pressure')
        expect(report.subject).to.deep.include({
            kind: 'Pipeline',
            id: operation.target.pipelineId,
            pipelineKind: 'compute',
        })
        expect(report.related).to.deep.include({ kind: 'Program', id: operation.target.programId })
        expect(JSON.stringify(report)).not.to.include(triangleWgsl)
    })

    it('rejects mismatched operation and incident target discriminators', () => {

        const bufferTarget = {
            kind: 'resource',
            resourceId: 'buffer-1',
            resourceKind: 'BufferResource',
            allocationVersion: 1,
            contentEpoch: 0,
            logicalFootprintBytes: 16,
        }
        const textureTarget = {
            ...bufferTarget,
            resourceId: 'texture-1',
            resourceKind: 'TextureResource',
        }
        const renderTarget = {
            kind: 'pipeline',
            pipelineId: 'render-pipeline-1',
            pipelineKind: 'render',
            programId: 'program-1',
            programSourceHash: 'source-1',
        }
        const computeTarget = {
            ...renderTarget,
            pipelineId: 'compute-pipeline-1',
            pipelineKind: 'compute',
        }
        const commandTarget = {
            kind: 'command',
            commandId: 'readback-command-1',
            commandKind: 'readback',
        }
        const readbackTarget = {
            kind: 'readback',
            readbackId: 'readback-1',
            path: 'direct',
            sourceResourceId: 'buffer-1',
            allocationVersion: 1,
            contentEpoch: 0,
            byteLength: 16,
        }
        const cases = [
            [ 'buffer-allocation', textureTarget, 'requires a BufferResource target' ],
            [ 'texture-allocation', bufferTarget, 'requires a TextureResource target' ],
            [ 'texture-replacement', bufferTarget, 'requires a TextureResource target' ],
            [ 'resource-disposal', renderTarget, 'incompatible pipeline target' ],
            [ 'render-pipeline-creation', computeTarget, 'requires a render pipeline target' ],
            [ 'compute-pipeline-creation', renderTarget, 'requires a compute pipeline target' ],
            [ 'pipeline-disposal', textureTarget, 'incompatible resource target' ],
            [ 'readback-staging-allocation', bufferTarget, 'requires a command or readback target' ],
            [ 'readback-staging-release', renderTarget, 'requires a command or readback target' ],
            [ 'readback-mapping', commandTarget, 'requires a readback target' ],
        ]
        for (const [ kind, target, expected ] of cases) {
            expect(() => createGpuOperationRecord({
                sequence: 1,
                id: `mismatched-${kind}`,
                kind,
                status: 'failed',
                runtimeId: 'runtime-1',
                target,
                descriptor: { hash: 'descriptor-1', summary: {} },
            })).to.throw(TypeError, expected)
        }

        expect(() => createGpuIncidentReport({
            sequence: 1,
            id: 'mismatched-incident',
            kind: 'pipeline-failure',
            diagnosticCode: 'SCRATCH_PIPELINE_CREATION_VALIDATION_FAILED',
            nativeErrorCategory: 'validation',
            attribution: 'exact-operation',
            runtimeId: 'runtime-1',
            target: {
                kind: 'runtime',
                runtimeId: 'runtime-1',
            },
            recentOperations: [],
            failureStage: 'pipeline-creation',
            evidence: {
                complete: true,
                overwrittenOperations: 0,
                overwrittenIncidents: 0,
                omittedRecords: 0,
            },
        })).to.throw(TypeError, 'incompatible runtime target')

        expect(() => createGpuIncidentReport({
            sequence: 2,
            id: 'mismatched-readback-incident',
            kind: 'readback-failure',
            diagnosticCode: 'SCRATCH_READBACK_MAP_FAILED',
            nativeErrorCategory: 'validation',
            attribution: 'exact-operation',
            runtimeId: 'runtime-1',
            target: renderTarget,
            recentOperations: [],
            failureStage: 'mapping',
            evidence: {
                complete: true,
                overwrittenOperations: 0,
                overwrittenIncidents: 0,
                omittedRecords: 0,
            },
        })).to.throw(TypeError, 'incompatible pipeline target')

        expect(() => createGpuIncidentReport({
            sequence: 3,
            id: 'missing-readback-stage',
            kind: 'readback-failure',
            diagnosticCode: 'SCRATCH_READBACK_MAP_FAILED',
            nativeErrorCategory: 'validation',
            attribution: 'exact-operation',
            runtimeId: 'runtime-1',
            target: readbackTarget,
            recentOperations: [],
            evidence: {
                complete: true,
                overwrittenOperations: 0,
                overwrittenIncidents: 0,
                omittedRecords: 0,
            },
        })).to.throw(TypeError, 'require a failureStage')
    })

    it('rejects mismatched pending targets before mutating controller state', async() => {

        const { gpu } = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu })
        const controller = diagnosticsControllerFor(runtime)
        expect(() => controller.beginOperation({
            kind: 'buffer-allocation',
            target: {
                kind: 'pipeline',
                pipelineId: 'invalid-pending-pipeline',
                pipelineKind: 'render',
                programId: 'invalid-pending-program',
                programSourceHash: 'invalid-pending-source',
            },
            descriptorSummary: { size: 16, usage: 1 },
            fullDescriptor: { size: 16, usage: 1 },
        })).to.throw(TypeError, 'requires a BufferResource target')
        expect(() => controller.beginOperation({
            kind: 'resource-disposal',
            target: {
                kind: 'resource',
                resourceId: 'invalid-pending-disposal',
                resourceKind: 'BufferResource',
                allocationVersion: 1,
                contentEpoch: 0,
                logicalFootprintBytes: 16,
            },
            descriptorSummary: { size: 16, usage: 1 },
            fullDescriptor: { size: 16, usage: 1 },
        })).to.throw(TypeError, 'cannot be pending')

        const snapshot = runtime.diagnostics.snapshot()
        expect(snapshot.pendingOperations).to.have.length(0)
        expect(snapshot.aggregates.allocationAttempts).to.equal(0)
        expect(snapshot.aggregates.pipelineCreationAttempts).to.equal(0)
    })

    it('bounds pipeline labels and compilation evidence without retaining source fields', () => {

        const sourceSentinel = 'SOURCE_SENTINEL_MUST_NOT_SURVIVE'
        const target = {
            kind: 'pipeline',
            pipelineId: 'pipeline-bounds-1',
            pipelineKind: 'render',
            programId: 'program-bounds-1',
            programSourceHash: 'source-bounds-1',
        }
        const modules = Array.from({ length: 300 }, (_, index) => ({
            index,
            hash: `module-hash-${index}`,
            startOffset: index * 10,
            endOffset: index * 10 + 9,
            startLine: index + 1,
            endLine: index + 1,
            lineCount: 1,
            source: sourceSentinel,
        })).reverse()
        const messages = Array.from({ length: 80 }, (_, index) => ({
            nativeIndex: index,
            type: index % 2 === 0 ? 'error' : 'warning',
            message: `message-${index}-${'x'.repeat(5_000)}`,
            messageTruncated: false,
            locationKind: 'module',
            nativeLocation: { offset: index, length: 1, lineNum: 1, linePos: 1 },
            moduleLocation: { moduleIndex: 0, offset: index, length: 1, lineNum: 1, linePos: 1 },
            excerpt: sourceSentinel,
        }))
        const compilationReport = {
            ...emptyCompilationReport(target),
            moduleCount: modules.length,
            modules,
            errorCount: 40,
            warningCount: 40,
            nativeMessageCount: messages.length,
            messages,
            source: sourceSentinel,
        }
        const nativeLabel = 'native-label-'.repeat(100)
        const record = createGpuOperationRecord({
            sequence: 1,
            id: 'bounded-pipeline-operation',
            kind: 'render-pipeline-creation',
            status: 'succeeded',
            runtimeId: 'runtime-1',
            target,
            descriptor: { hash: 'descriptor-1', summary: {} },
            nativeLabels: {
                pipeline: { value: nativeLabel, truncated: false },
                shaderModule: { value: nativeLabel, truncated: false },
                pipelineLayout: { value: nativeLabel, truncated: false },
            },
            compilationReport,
        })

        expect(record.nativeLabels.pipeline.value.length).to.be.at.most(256)
        expect(record.nativeLabels.shaderModule.value.length).to.be.at.most(256)
        expect(record.nativeLabels.pipelineLayout.value.length).to.be.at.most(256)
        expect(record.nativeLabels.pipeline.truncated).to.equal(true)
        expect(record.compilationReport.retainedModuleCount).to.be.at.most(256)
        expect(record.compilationReport.retainedMessageCount).to.be.at.most(64)
        expect(record.compilationReport.modules.map(module => module.index)).to.deep.equal(
            Array.from(
                { length: record.compilationReport.retainedModuleCount },
                (_, index) => index
            )
        )
        expect(record.compilationReport.omittedModuleCount).to.equal(
            modules.length - record.compilationReport.retainedModuleCount
        )
        expect(record.compilationReport.omittedMessageCount).to.equal(
            messages.length - record.compilationReport.retainedMessageCount
        )
        expect(record.compilationReport.messages[0].message.length).to.equal(4_096)
        expect(record.compilationReport.messages[0].messageTruncated).to.equal(true)
        expect(serializedEvidenceBytes(record.compilationReport)).to.be.at.most(64 * 1024)
        expect(record.compilationReport.retainedEvidenceBytes).to.equal(
            serializedEvidenceBytes(record.compilationReport)
        )
        expect(Object.isFrozen(record.compilationReport.modules)).to.equal(true)
        expect(Object.isFrozen(record.compilationReport.messages[0])).to.equal(true)
        expect(JSON.stringify(record)).not.to.include(sourceSentinel)

        const incident = createGpuIncidentReport({
            sequence: 1,
            id: 'bounded-pipeline-incident',
            kind: 'pipeline-failure',
            diagnosticCode: 'SCRATCH_PIPELINE_CREATION_VALIDATION_FAILED',
            nativeErrorCategory: 'validation',
            attribution: 'exact-operation',
            runtimeId: 'runtime-1',
            target,
            recentOperations: [],
            failureStage: 'pipeline-creation',
            compilationReport,
            evidence: {
                complete: true,
                overwrittenOperations: 0,
                overwrittenIncidents: 0,
                omittedRecords: 0,
            },
        })
        expect(serializedEvidenceBytes(incident.compilationReport)).to.be.at.most(64 * 1024)
        expect(JSON.stringify(incident)).not.to.include(sourceSentinel)
    })

    it('rejects compilation evidence whose identity differs from its pipeline target', () => {

        const target = {
            kind: 'pipeline',
            pipelineId: 'pipeline-identity-1',
            pipelineKind: 'compute',
            programId: 'program-identity-1',
            programSourceHash: 'source-identity-1',
        }
        const mismatches = [
            { pipelineId: 'other-pipeline' },
            { pipelineKind: 'render' },
            { programId: 'other-program' },
            { combinedSourceHash: 'other-source' },
        ]
        for (const mismatch of mismatches) {
            expect(() => createGpuOperationRecord({
                sequence: 1,
                id: 'identity-mismatch-operation',
                kind: 'compute-pipeline-creation',
                status: 'failed',
                runtimeId: 'runtime-1',
                target,
                descriptor: { hash: 'descriptor-1', summary: {} },
                compilationReport: {
                    ...emptyCompilationReport(target),
                    ...mismatch,
                },
            })).to.throw(TypeError, 'identity does not match')
        }
    })

    it('keeps pending state intact when completion evidence cannot be normalized', async() => {

        const { gpu } = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu })
        const controller = diagnosticsControllerFor(runtime)
        const target = {
            kind: 'pipeline',
            pipelineId: 'pipeline-atomic-completion-1',
            pipelineKind: 'compute',
            programId: 'program-atomic-completion-1',
            programSourceHash: 'source-atomic-completion-1',
        }
        const pending = controller.beginOperation({
            kind: 'compute-pipeline-creation',
            target,
            descriptorSummary: { entryPoint: 'main' },
            fullDescriptor: { entryPoint: 'main' },
        })

        expect(() => controller.completeOperation(pending, {
            status: 'failed',
            compilationReport: {
                ...emptyCompilationReport(target),
                pipelineId: 'wrong-pipeline-id',
            },
        })).to.throw(TypeError, 'identity does not match')
        expect(runtime.diagnostics.snapshot().pendingOperations).to.have.length(1)

        const record = controller.completeOperation(pending, {
            status: 'failed',
            compilationReport: emptyCompilationReport(target),
        })
        expect(record.status).to.equal('failed')
        expect(runtime.diagnostics.snapshot().pendingOperations).to.have.length(0)
        expect(runtime.diagnostics.snapshot().aggregates.pipelineCreationAttempts).to.equal(1)
        expect(runtime.diagnostics.snapshot().aggregates.failedPipelineCreations).to.equal(1)
    })

    it('versions snapshots, captures, exports, queries, and current pipeline facts together', async() => {

        const { gpu } = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu })
        const controller = diagnosticsControllerFor(runtime)
        const capture = runtime.diagnostics.capture({
            maxOperations: 8,
            maxDurationMs: 1_000,
            maxEvidenceBytes: 64 * 1024,
        })
        const target = {
            kind: 'pipeline',
            pipelineId: 'pipeline-current-1',
            pipelineKind: 'render',
            programId: 'program-current-1',
            programSourceHash: 'source-current-1',
        }
        const compilationReport = emptyCompilationReport(target)
        const pending = controller.beginOperation({
            kind: 'render-pipeline-creation',
            target,
            descriptorSummary: { targetFormats: [ 'bgra8unorm' ] },
            fullDescriptor: { targetFormats: [ 'bgra8unorm' ] },
            nativeLabel: 'current pipeline [scratch:pipeline-current-1]',
        })

        const pendingSnapshot = runtime.diagnostics.snapshot()
        expect(pendingSnapshot.version).to.equal(3)
        expect(pendingSnapshot.pendingOperations[0].target).to.deep.equal(target)

        const record = controller.completeOperation(pending, {
            status: 'succeeded',
            compilationReport,
        })
        controller.registerPipeline({
            label: 'current pipeline',
            creationOperation: record,
        })

        const snapshot = runtime.diagnostics.snapshot()
        const evidence = runtime.diagnostics.exportEvidence()
        const captureReport = capture.stop()
        expect(snapshot.version).to.equal(3)
        expect(snapshot.pipelines).to.deep.equal([ {
            id: target.pipelineId,
            label: 'current pipeline',
            pipelineKind: 'render',
            programId: target.programId,
            programSourceHash: target.programSourceHash,
            descriptorHash: record.descriptor.hash,
            state: 'ready',
            lastCreationOperationId: record.id,
            compilation: { errorCount: 0, warningCount: 0, infoCount: 0 },
        } ])
        expect(evidence.version).to.equal(3)
        expect(captureReport.version).to.equal(3)
        expect(runtime.diagnostics.operations({
            targetKind: 'pipeline',
            pipelineId: target.pipelineId,
        })).to.deep.equal([ record ])
        expect(Object.isFrozen(snapshot.pipelines[0])).to.equal(true)
        expect(Object.isFrozen(evidence)).to.equal(true)
        expect(JSON.parse(JSON.stringify(evidence))).to.deep.equal(evidence)
        expect(() => controller.registerPipeline({
            creationOperation: record,
        })).to.throw(TypeError, 'already registered')
        expect(() => controller.registerPipeline({
            creationOperation: createGpuOperationRecord({
                ...record,
                status: 'failed',
            }),
        })).to.throw(TypeError, 'matching successful creation operation')

        const incident = controller.recordIncident({
            kind: 'pipeline-failure',
            diagnosticCode: 'SCRATCH_PIPELINE_CREATION_VALIDATION_FAILED',
            nativeErrorCategory: 'validation',
            attribution: 'exact-operation',
            target,
            operationId: record.id,
            triggerOperation: record,
            failureStage: 'pipeline-creation',
            compilationReport,
        })
        expect(runtime.diagnostics.incidents({
            targetKind: 'pipeline',
            pipelineId: target.pipelineId,
        })).to.deep.equal([ incident ])

        controller.unregisterPipeline(target.pipelineId)
        expect(runtime.diagnostics.snapshot().pipelines).to.have.length(0)
        const disposal = runtime.diagnostics.operations({ kind: 'pipeline-disposal' })[0]
        expect(disposal.target).to.deep.equal(target)
        expect(runtime.diagnostics.snapshot().aggregates.pipelineDisposals).to.equal(1)
        expect(() => controller.registerPipeline({
            creationOperation: record,
        })).to.throw(TypeError, 'already been registered')

        const forgedTarget = {
            ...target,
            pipelineId: 'forged-pipeline-current-1',
        }
        expect(() => controller.registerPipeline({
            creationOperation: createGpuOperationRecord({
                sequence: 99,
                id: 'forged-successful-operation',
                kind: 'render-pipeline-creation',
                status: 'succeeded',
                runtimeId: runtime.id,
                target: forgedTarget,
                descriptor: { hash: 'forged-descriptor', summary: {} },
                compilationReport: emptyCompilationReport(forgedTarget),
            }),
        })).to.throw(TypeError, 'matching successful creation operation')
        expect(runtime.diagnostics.snapshot().pipelines).to.have.length(0)
    })

    it('keeps pipeline history out of allocation pressure churn', async() => {

        const { gpu } = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu })
        const controller = diagnosticsControllerFor(runtime)
        const resourceTarget = {
            kind: 'resource',
            resourceId: 'resource-trigger-1',
            resourceKind: 'BufferResource',
            allocationVersion: 1,
            contentEpoch: 0,
            logicalFootprintBytes: 32,
        }
        const resourcePending = controller.beginOperation({
            kind: 'buffer-allocation',
            target: resourceTarget,
            descriptorSummary: { size: 32, usage: 1 },
            fullDescriptor: { size: 32, usage: 1 },
        })
        const resourceRecord = controller.completeOperation(resourcePending, { status: 'failed' })
        const pipelineTarget = {
            kind: 'pipeline',
            pipelineId: 'pipeline-no-pressure-1',
            pipelineKind: 'compute',
            programId: 'program-no-pressure-1',
            programSourceHash: 'source-no-pressure-1',
        }
        const pipelinePending = controller.beginOperation({
            kind: 'compute-pipeline-creation',
            target: pipelineTarget,
            descriptorSummary: { entryPoint: 'main' },
            fullDescriptor: { entryPoint: 'main' },
        })
        controller.completeOperation(pipelinePending, {
            status: 'failed',
            compilationReport: emptyCompilationReport(pipelineTarget),
        })

        const incident = controller.recordIncident({
            kind: 'allocation-failure',
            diagnosticCode: 'SCRATCH_BUFFER_ALLOCATION_OUT_OF_MEMORY',
            nativeErrorCategory: 'out-of-memory',
            attribution: 'exact-operation',
            target: resourceTarget,
            operationId: resourceRecord.id,
            triggerOperation: resourceRecord,
            triggerLogicalFootprintBytes: 32,
        })

        expect(incident.pressure.recentChurn).to.have.length(1)
        expect(incident.pressure.recentChurn[0].resourceId).to.equal(resourceTarget.resourceId)
        expect(JSON.stringify(incident.pressure)).not.to.include(pipelineTarget.pipelineId)
    })
})

function emptyCompilationReport(target) {

    return Object.freeze({
        version: 1,
        pipelineId: target.pipelineId,
        pipelineKind: target.pipelineKind,
        programId: target.programId,
        combinedSourceHash: target.programSourceHash,
        moduleCount: 0,
        retainedModuleCount: 0,
        omittedModuleCount: 0,
        modules: Object.freeze([]),
        errorCount: 0,
        warningCount: 0,
        infoCount: 0,
        nativeMessageCount: 0,
        retainedMessageCount: 0,
        omittedMessageCount: 0,
        retainedEvidenceBytes: 0,
        messages: Object.freeze([]),
    })
}
