import os from 'node:os'
import process from 'node:process'
import { performance } from 'node:perf_hooks'
import { ScratchRuntime } from '../../packages/geoscratch/dist/index.js'
import { createFakeGpu } from '../scratch-test-utils.js'

const iterations = positiveInteger(
    process.env.SCRATCH_CURRENT_CONTENT_ITERATIONS,
    20_000
)
const allowShort = process.env.SCRATCH_CURRENT_CONTENT_ALLOW_SHORT === '1'
const GPU_BUFFER_USAGE_COPY_DST = 0x8
const GPU_BUFFER_USAGE_STORAGE = 0x80
const MAX_HEAP_GROWTH_BYTES = 128 * 1024 * 1024

if (!allowShort) {
    assertStress(iterations >= 20_000, 'current-content stress must run at least 20,000 submissions')
}

const result = await stressCurrentContentReads(iterations)
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)

async function stressCurrentContentReads(submissionCount) {

    const fake = createFakeGpu()
    const runtime = await ScratchRuntime.create({
        gpu: fake.gpu,
        label: 'current-content stress runtime',
        diagnostics: {
            submissionScopes: 'off',
            operationCapacity: 64,
            incidentCapacity: 16,
            evidenceByteCapacity: 128 * 1024,
        },
    })
    const input = await runtime.createBuffer({
        label: 'current-content stress input',
        size: 16,
        usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_STORAGE,
    })
    const layout = await runtime.createBindLayout({
        label: 'current-content stress layout',
        group: 0,
        entries: [ {
            binding: 0,
            name: 'inputValues',
            type: 'read-storage',
            visibility: [ 'compute' ],
        } ],
    })
    const bindSet = await runtime.createBindSet(layout, {
        inputValues: input.region(),
    }, {
        label: 'current-content stress set',
    })
    const program = runtime.createProgram({
        label: 'current-content stress program',
        modules: [ `
            @group(0) @binding(0)
            var<storage, read> inputValues: array<u32>;

            @compute @workgroup_size(1)
            fn csMain() {
                _ = inputValues[0];
            }
        ` ],
        entryPoints: { compute: 'csMain' },
    })
    const pipeline = await runtime.createComputePipeline({
        label: 'current-content stress pipeline',
        program,
        bindLayouts: [ layout ],
    })
    const pass = runtime.createComputePass({ label: 'current-content stress pass' })
    const data = new Uint32Array(4)
    const upload = runtime.createUploadCommand({
        label: 'current-content stress upload',
        target: input.region(),
        data,
    })
    const dispatch = runtime.createDispatchCommand({
        label: 'current-content stress dispatch',
        pipeline,
        bindSets: [ { set: bindSet } ],
        count: { workgroups: [ 1 ] },
        resources: {
            read: [ { resource: input, contentEpoch: 'current-at-step' } ],
            write: [],
        },
        whenMissing: 'throw',
    })
    const persistent = Object.freeze({
        upload,
        dispatch,
        bindSet,
        pipeline,
        pass,
        uploadId: upload.id,
        dispatchId: dispatch.id,
        bindSetId: bindSet.id,
        pipelineId: pipeline.id,
        passId: pass.id,
        bindGroupCount: fake.calls.bindGroups.length,
        pipelineCount: fake.calls.computePipelines.length,
    })

    clearSubmissionHistory(fake.calls)
    const startedAt = performance.now()
    const initialHeapBytes = process.memoryUsage().heapUsed
    let peakHeapBytes = initialHeapBytes
    let maxRetainedSubmissionFacts = 0
    let finalEpoch = 0
    let finalReadFact

    for (let index = 0; index < submissionCount; index++) {
        const expectedEpoch = index + 1
        data.fill(expectedEpoch)
        const submitted = runtime.createSubmission({ validation: 'throw' })
            .upload(upload)
            .compute(pass, [ dispatch ])
            .submit()
        const read = submitted.resourceAccesses.find(access => (
            access.commandId === dispatch.id &&
            access.resourceId === input.id &&
            access.access === 'read'
        ))
        const producer = submitted.producerEpochs.find(epoch => (
            epoch.resourceId === input.id &&
            epoch.producedBy.commandId === upload.id
        ))

        assertStress(upload === persistent.upload, 'UploadCommand identity changed')
        assertStress(dispatch === persistent.dispatch, 'DispatchCommand identity changed')
        assertStress(bindSet === persistent.bindSet, 'BindSet identity changed')
        assertStress(pipeline === persistent.pipeline, 'Pipeline identity changed')
        assertStress(pass === persistent.pass, 'PassSpec identity changed')
        assertStress(upload.id === persistent.uploadId, 'UploadCommand id changed')
        assertStress(dispatch.id === persistent.dispatchId, 'DispatchCommand id changed')
        assertStress(bindSet.id === persistent.bindSetId, 'BindSet id changed')
        assertStress(pipeline.id === persistent.pipelineId, 'Pipeline id changed')
        assertStress(pass.id === persistent.passId, 'PassSpec id changed')
        assertStress(dispatch.resources.read[0]?.contentEpoch === 'current-at-step', 'command declaration drifted')
        assertStress(read !== undefined, 'submission omitted the dispatch read fact')
        assertStress(producer !== undefined, 'submission omitted the upload producer fact')
        assertStress(read.declaredContentEpoch === 'current-at-step', 'ledger lost the authored sentinel')
        assertStress(read.contentEpochBefore === expectedEpoch, 'read resolved the wrong step epoch')
        assertStress(read.contentEpochAfter === expectedEpoch, 'read changed resource content')
        assertStress(producer.contentEpoch === expectedEpoch, 'producer epoch did not match the read')
        assertStress(input.contentEpoch === expectedEpoch, 'resource epoch did not advance exactly once')
        assertStress(Object.isFrozen(read), 'resource access fact is mutable')
        assertStress(Object.isFrozen(submitted.resourceAccesses), 'resource access ledger is mutable')
        assertStress(
            JSON.stringify(JSON.parse(JSON.stringify(read))) === JSON.stringify(read),
            'resource access fact is not JSON-stable'
        )
        assertStress(
            fake.calls.bindGroups.length === persistent.bindGroupCount,
            'steady-state submission rebuilt a bind group'
        )
        assertStress(
            fake.calls.computePipelines.length === persistent.pipelineCount,
            'steady-state submission rebuilt a compute pipeline'
        )

        const [ nativeOutcome ] = await Promise.all([
            submitted.nativeOutcome,
            submitted.done,
        ])
        assertStress(
            nativeOutcome.status === 'unobserved',
            `submissionScopes=off produced ${nativeOutcome.status}`
        )

        finalEpoch = expectedEpoch
        finalReadFact = read
        maxRetainedSubmissionFacts = Math.max(
            maxRetainedSubmissionFacts,
            retainedSubmissionFactCount(fake.calls)
        )
        clearSubmissionHistory(fake.calls)

        if (expectedEpoch % 256 === 0 || expectedEpoch === submissionCount) {
            peakHeapBytes = Math.max(peakHeapBytes, process.memoryUsage().heapUsed)
        }
    }

    const durationMs = performance.now() - startedAt
    const heapGrowthBytes = peakHeapBytes - initialHeapBytes
    const snapshot = runtime.diagnostics.snapshot()
    const evidence = runtime.diagnostics.exportEvidence()
    assertStress(heapGrowthBytes <= MAX_HEAP_GROWTH_BYTES, 'heap growth exceeded the bounded stress budget')
    assertStress(snapshot.pendingOperations.length === 0, 'stress retained pending GPU operations')
    assertStress(evidence.operations.length <= 64, 'bounded operation recorder exceeded capacity')
    assertStress(evidence.incidents.length === 0, 'stress recorded an unexpected GPU incident')
    assertStress(fake.calls.uncapturedErrors.length === 0, 'stress produced an uncaptured GPU error')
    assertStress(maxRetainedSubmissionFacts <= 8, 'fake-GPU submission history was not bounded per cycle')

    const output = {
        schemaVersion: 1,
        environment: {
            node: process.version,
            platform: process.platform,
            architecture: process.arch,
            cpu: os.cpus()[0]?.model ?? 'unknown',
            logicalCpuCount: os.cpus().length,
            iterations: submissionCount,
        },
        measurementBoundary: {
            device: 'deterministic in-process fake GPUDevice',
            cycle: 'one mutable-data UploadCommand followed by one current-at-step DispatchCommand submission',
            persistentObjects: [ 'UploadCommand', 'DispatchCommand', 'BindSet', 'ComputePipeline', 'ComputePassSpec' ],
            frameLocalObjects: [ 'SubmissionBuilder', 'SubmittedWork' ],
            fakeGpuHistory: 'cleared after every settled submission while cumulative scalar facts are retained',
            excludes: [ 'browser IPC', 'driver execution', 'physical GPU work' ],
        },
        identities: {
            uploadCommandId: persistent.uploadId,
            dispatchCommandId: persistent.dispatchId,
            bindSetId: persistent.bindSetId,
            pipelineId: persistent.pipelineId,
            passId: persistent.passId,
            bindGroupsCreated: fake.calls.bindGroups.length,
            computePipelinesCreated: fake.calls.computePipelines.length,
        },
        epochs: {
            finalResourceEpoch: input.contentEpoch,
            finalProducerEpoch: finalEpoch,
            finalDeclaredEpoch: finalReadFact?.declaredContentEpoch,
            finalResolvedEpoch: finalReadFact?.contentEpochBefore,
        },
        bounds: {
            operationCapacity: 64,
            retainedOperations: evidence.operations.length,
            retainedIncidents: evidence.incidents.length,
            pendingOperations: snapshot.pendingOperations.length,
            maxRetainedFakeSubmissionFacts: maxRetainedSubmissionFacts,
            initialHeapBytes,
            peakHeapBytes,
            heapGrowthBytes,
            maxHeapGrowthBytes: MAX_HEAP_GROWTH_BYTES,
        },
        timing: {
            durationMs,
            submissionsPerSecond: submissionCount / (durationMs / 1000),
        },
        verification: {
            status: 'passed',
            minimumEnforced: !allowShort,
            minimumSubmissions: allowShort ? 1 : 20_000,
        },
    }

    dispatch.dispose()
    upload.dispose()
    pass.dispose()
    pipeline.dispose()
    program.dispose()
    bindSet.dispose()
    layout.dispose()
    input.dispose()
    runtime.dispose()

    return output
}

function retainedSubmissionFactCount(calls) {

    return calls.commandEncoders.length +
        calls.queueWrites.length +
        calls.queueSubmissions.length +
        calls.computePasses.length +
        calls.dispatchCalls.length +
        calls.submittedWorkDoneRegistrations.length
}

function clearSubmissionHistory(calls) {

    for (const key of [
        'commandEncoders',
        'queueWrites',
        'queueSubmissions',
        'queueTimeline',
        'submittedWorkDoneRegistrations',
        'computePasses',
        'dispatchCalls',
        'copies',
        'errorScopes',
        'debugGroups',
        'nativeTimeline',
    ]) {
        calls[key].length = 0
    }
}

function positiveInteger(value, fallback) {

    if (value === undefined) return fallback
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new TypeError(`Expected a positive integer, received ${value}.`)
    }
    return parsed
}

function assertStress(condition, message) {

    if (!condition) throw new Error(message)
}
