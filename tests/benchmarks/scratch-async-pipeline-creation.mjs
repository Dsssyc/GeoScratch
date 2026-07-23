import os from 'node:os'
import process from 'node:process'
import { performance } from 'node:perf_hooks'
import { ScratchRuntime } from '../../packages/geoscratch/dist/scratch/runtime.js'
import { diagnosticsControllerFor } from '../../packages/geoscratch/dist/scratch/runtime-diagnostics.js'
import { runtimePipelineCount } from '../../packages/geoscratch/dist/scratch/pipeline-ownership.js'
import { createFakeGpu, triangleWgsl } from '../scratch-test-utils.js'

const iterations = positiveInteger(process.env.SCRATCH_PIPELINE_BENCH_ITERATIONS, 200)
const rounds = positiveInteger(process.env.SCRATCH_PIPELINE_BENCH_ROUNDS, 5)
const warmupIterations = positiveInteger(process.env.SCRATCH_PIPELINE_BENCH_WARMUP, 40)
const longRunIterations = positiveInteger(process.env.SCRATCH_PIPELINE_BENCH_LONG_RUN, 5_000)
const populatedMessages = Object.freeze([
    Object.freeze({
        type: 'warning',
        message: 'synthetic warning evidence',
        offset: 0,
        length: 0,
        lineNum: 0,
        linePos: 0,
    }),
    Object.freeze({
        type: 'info',
        message: 'synthetic information evidence',
        offset: 0,
        length: 0,
        lineNum: 0,
        linePos: 0,
    }),
])
const profileDefinitions = Object.freeze([
    profile('render-empty-history-zero', 'render', 'empty', 'zero'),
    profile('render-populated-history-zero', 'render', 'populated', 'zero'),
    profile('compute-empty-history-zero', 'compute', 'empty', 'zero'),
    profile('compute-populated-history-zero', 'compute', 'populated', 'zero'),
    profile('render-empty-default-recorder', 'render', 'empty', 'default'),
    profile('compute-empty-default-recorder', 'compute', 'empty', 'default'),
    profile('render-empty-steady-overwrite', 'render', 'empty', 'overwrite'),
    profile('compute-empty-steady-overwrite', 'compute', 'empty', 'overwrite'),
    profile('render-populated-deep-capture', 'render', 'populated', 'capture'),
    profile('compute-populated-deep-capture', 'compute', 'populated', 'capture'),
])

const profiles = []
for (const definition of profileDefinitions) {
    profiles.push(await benchmarkProfile(definition))
}

const benchmarkResult = {
    schemaVersion: 1,
    environment: {
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
        cpu: os.cpus()[0]?.model ?? 'unknown',
        logicalCpuCount: os.cpus().length,
        rounds,
        warmupIterations,
        iterations,
        longRunIterations,
        explicitGcAvailable: typeof globalThis.gc === 'function',
    },
    measurementBoundary: {
        device: 'deterministic in-process fake GPUDevice',
        cpuIssue: 'public factory call through native async request and all scope-pop requests',
        asyncSettlement: 'factory return through compilation, pipeline, scope, and lifecycle settlement',
        total: 'public factory call through acknowledged pipeline wrapper resolution',
        disposal: 'excluded from timing and included in retention verification',
        excludes: [
            'browser IPC',
            'driver compilation',
            'physical GPU work',
            'queue submission',
        ],
    },
    profiles,
    longRun: await benchmarkLongRun(longRunIterations),
}
const result = {
    ...benchmarkResult,
    verification: verifyBenchmarkResult(benchmarkResult),
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)

function profile(name, pipelineKind, reportKind, recorderKind) {

    return Object.freeze({ name, pipelineKind, reportKind, recorderKind })
}

async function benchmarkProfile(definition) {

    const samples = []
    for (let round = 0; round < rounds; round++) {
        const fake = createFakeGpu({
            compilationMessages: definition.reportKind === 'populated'
                ? populatedMessages
                : [],
        })
        const runtime = await ScratchRuntime.create({
            gpu: fake.gpu,
            ...(diagnosticsOptions(definition.recorderKind) !== undefined
                ? { diagnostics: diagnosticsOptions(definition.recorderKind) }
                : {}),
        })
        const programs = await createPrograms(runtime)

        await runCycles({
            runtime,
            fake,
            programs,
            pipelineKind: definition.pipelineKind,
            reportKind: definition.reportKind,
            count: warmupIterations,
            timed: false,
        })
        const capture = definition.recorderKind === 'capture'
            ? runtime.diagnostics.capture({
                maxOperations: iterations * 2,
                maxDurationMs: 60_000,
                maxEvidenceBytes: 32 * 1024 * 1024,
                includeStacks: true,
                includeDescriptors: true,
            })
            : undefined
        const timing = await runCycles({
            runtime,
            fake,
            programs,
            pipelineKind: definition.pipelineKind,
            reportKind: definition.reportKind,
            count: iterations,
            timed: true,
        })
        const captureReport = capture?.stop()
        const snapshot = runtime.diagnostics.snapshot()
        const sample = {
            cpuIssueMicrosecondsPerPipeline: millisecondsToMicroseconds(
                timing.issueMs / iterations
            ),
            asyncSettlementMicrosecondsPerPipeline: millisecondsToMicroseconds(
                timing.settlementMs / iterations
            ),
            totalMicrosecondsPerPipeline: millisecondsToMicroseconds(
                timing.totalMs / iterations
            ),
            retainedOperationCount: snapshot.recorder.retainedOperationCount,
            retainedIncidentCount: snapshot.recorder.retainedIncidentCount,
            retainedEvidenceBytes: snapshot.recorder.retainedEvidenceBytes,
            overwrittenOperations: snapshot.recorder.overwrittenOperations,
            pendingOperationCount: snapshot.pendingOperations.length,
            livePipelineCount: snapshot.pipelines.length,
            runtimePipelineCount: runtimePipelineCount(runtime),
            lifecycleSubscriberCount: diagnosticsControllerFor(runtime).lifecycleSubscriberCount,
            pipelineCreationAttempts: snapshot.aggregates.pipelineCreationAttempts,
            successfulPipelineCreations: snapshot.aggregates.successfulPipelineCreations,
            failedPipelineCreations: snapshot.aggregates.failedPipelineCreations,
            cancelledPipelineCreations: snapshot.aggregates.cancelledPipelineCreations,
            pipelineDisposals: snapshot.aggregates.pipelineDisposals,
            ...(captureReport !== undefined ? {
                captureStopReason: captureReport.stopReason,
                captureOperationCount: captureReport.operations.length,
                captureRetainedEvidenceBytes: captureReport.retainedEvidenceBytes,
                captureOperationsWithStacks: captureReport.operations.filter(
                    operation => operation.stack !== undefined
                ).length,
                captureOperationsWithFullDescriptors: captureReport.operations.filter(
                    operation => operation.descriptor.full !== undefined
                ).length,
            } : {}),
        }
        verifyProfileSample(definition, sample)
        samples.push(sample)
        runtime.dispose()
    }

    return {
        ...definition,
        pipelineCreationsPerRound: iterations,
        verifiedRoundCount: samples.length,
        median: medianSample(samples),
        range: rangeSample(samples),
    }
}

async function runCycles({
    runtime,
    fake,
    programs,
    pipelineKind,
    reportKind,
    count,
    timed,
}) {

    let issueMs = 0
    let settlementMs = 0
    let totalMs = 0
    for (let index = 0; index < count; index++) {
        const startedAt = performance.now()
        const pending = pipelineKind === 'render'
            ? runtime.createRenderPipeline({
                label: `benchmark render ${index}`,
                program: programs.render,
                targets: [ { format: 'bgra8unorm' } ],
            })
            : runtime.createComputePipeline({
                label: `benchmark compute ${index}`,
                program: programs.compute,
            })
        const issuedAt = performance.now()
        const pipeline = await pending
        const settledAt = performance.now()

        const expectedMessageCount = reportKind === 'populated' ? populatedMessages.length : 0
        const compilationReport = pipelineKind === 'render'
            ? programs.renderModule.compilationReport
            : programs.computeModule.compilationReport
        assertBenchmark(
            compilationReport.nativeMessageCount === expectedMessageCount,
            `${pipelineKind}/${reportKind} compilation-message count drifted`
        )
        if (timed) {
            issueMs += issuedAt - startedAt
            settlementMs += settledAt - issuedAt
            totalMs += settledAt - startedAt
        }
        pipeline.dispose()
        if ((index + 1) % 32 === 0) clearFakeCallRetention(fake)
    }
    clearFakeCallRetention(fake)
    return { issueMs, settlementMs, totalMs }
}

function diagnosticsOptions(recorderKind) {

    if (recorderKind === 'zero' || recorderKind === 'capture') {
        return {
            operationCapacity: 0,
            incidentCapacity: 0,
            evidenceByteCapacity: 0,
        }
    }
    if (recorderKind === 'overwrite') {
        return {
            operationCapacity: 32,
            incidentCapacity: 4,
            evidenceByteCapacity: 32 * 1024,
        }
    }
    return undefined
}

async function benchmarkLongRun(count) {

    const fake = createFakeGpu()
    const runtime = await ScratchRuntime.create({
        gpu: fake.gpu,
        diagnostics: {
            operationCapacity: 64,
            incidentCapacity: 8,
            evidenceByteCapacity: 64 * 1024,
        },
    })
    const programs = await createPrograms(runtime)
    const halfway = Math.floor(count / 2)

    await runAlternatingCycles(runtime, fake, programs, halfway)
    collectGarbageIfAvailable()
    const first = longRunSnapshot(runtime)

    await runAlternatingCycles(runtime, fake, programs, count - halfway, halfway)
    collectGarbageIfAvailable()
    const second = longRunSnapshot(runtime)

    const result = {
        firstPipelineCycleCount: halfway,
        secondPipelineCycleCount: count,
        afterFirstHalf: first,
        afterSecondHalf: second,
        retainedCountGrowth: second.retainedOperationCount - first.retainedOperationCount,
        retainedEvidenceByteGrowth: second.retainedEvidenceBytes - first.retainedEvidenceBytes,
        heapExperiment: typeof globalThis.gc === 'function'
            ? {
                classification: 'environment-specific supporting evidence, not a heap guarantee',
                firstHeapUsedBytes: first.heapUsedBytes,
                secondHeapUsedBytes: second.heapUsedBytes,
                deltaBytes: second.heapUsedBytes - first.heapUsedBytes,
            }
            : {
                classification: 'not run; invoke node with --expose-gc for supporting evidence',
            },
    }
    verifyLongRun(result, count)
    runtime.dispose()
    return result
}

async function runAlternatingCycles(runtime, fake, programs, count, offset = 0) {

    for (let index = 0; index < count; index++) {
        const sequence = index + offset
        const pipeline = sequence % 2 === 0
            ? await runtime.createRenderPipeline({
                program: programs.render,
                targets: [ { format: 'bgra8unorm' } ],
            })
            : await runtime.createComputePipeline({ program: programs.compute })
        pipeline.dispose()
        if ((index + 1) % 32 === 0) clearFakeCallRetention(fake)
    }
    clearFakeCallRetention(fake)
}

async function createPrograms(runtime) {

    const renderModule = await runtime.createShaderModule({
        sourceParts: [ { code: triangleWgsl } ],
    })
    const computeModule = await runtime.createShaderModule({
        sourceParts: [ { code: `
            override scale: f32 = 1.0;
            @compute @workgroup_size(1)
            fn csMain() {
                let value = scale;
            }
        ` } ],
    })
    return Object.freeze({
        renderModule,
        computeModule,
        render: runtime.createProgram({
            vertex: { module: renderModule, entryPoint: 'vsMain' },
            fragment: { module: renderModule, entryPoint: 'fsMain' },
        }),
        compute: runtime.createProgram({
            compute: {
                module: computeModule,
                entryPoint: 'csMain',
                constants: { scale: 1 },
            },
        }),
    })
}

function verifyProfileSample(definition, sample) {

    const expectedCycles = warmupIterations + iterations
    for (const field of [
        'retainedIncidentCount',
        'pendingOperationCount',
        'livePipelineCount',
        'runtimePipelineCount',
        'lifecycleSubscriberCount',
        'failedPipelineCreations',
        'cancelledPipelineCreations',
    ]) {
        assertBenchmark(sample[field] === 0, `${definition.name} retained non-zero ${field}`)
    }
    assertBenchmark(
        sample.pipelineCreationAttempts === expectedCycles,
        `${definition.name} pipeline-attempt count drifted`
    )
    assertBenchmark(
        sample.successfulPipelineCreations === expectedCycles,
        `${definition.name} success count drifted`
    )
    assertBenchmark(
        sample.pipelineDisposals === expectedCycles,
        `${definition.name} disposal count drifted`
    )

    if (definition.recorderKind === 'zero' || definition.recorderKind === 'capture') {
        assertBenchmark(sample.retainedOperationCount === 0, `${definition.name} retained history`)
        assertBenchmark(sample.retainedEvidenceBytes === 0, `${definition.name} retained bytes`)
    }
    if (definition.recorderKind === 'default') {
        assertBenchmark(sample.retainedOperationCount <= 256, `${definition.name} exceeded default capacity`)
        assertBenchmark(sample.retainedEvidenceBytes <= 256 * 1024, `${definition.name} exceeded default bytes`)
    }
    if (definition.recorderKind === 'overwrite') {
        assertBenchmark(sample.retainedOperationCount <= 32, `${definition.name} exceeded overwrite capacity`)
        assertBenchmark(sample.retainedEvidenceBytes <= 32 * 1024, `${definition.name} exceeded overwrite bytes`)
        assertBenchmark(sample.overwrittenOperations > 0, `${definition.name} did not overwrite`)
    }
    if (definition.recorderKind === 'capture') {
        assertBenchmark(sample.captureStopReason === 'operation-limit', `${definition.name} capture did not self-stop`)
        assertBenchmark(sample.captureOperationCount === iterations * 2, `${definition.name} capture count drifted`)
        assertBenchmark(sample.captureOperationsWithStacks === iterations * 2, `${definition.name} omitted stacks`)
        assertBenchmark(
            sample.captureOperationsWithFullDescriptors === iterations,
            `${definition.name} omitted creation descriptors`
        )
        assertBenchmark(
            sample.captureRetainedEvidenceBytes <= 32 * 1024 * 1024,
            `${definition.name} exceeded capture bytes`
        )
    }
}

function longRunSnapshot(runtime) {

    const snapshot = runtime.diagnostics.snapshot()
    return {
        retainedOperationCount: snapshot.recorder.retainedOperationCount,
        retainedIncidentCount: snapshot.recorder.retainedIncidentCount,
        retainedEvidenceBytes: snapshot.recorder.retainedEvidenceBytes,
        overwrittenOperations: snapshot.recorder.overwrittenOperations,
        pendingOperationCount: snapshot.pendingOperations.length,
        livePipelineCount: snapshot.pipelines.length,
        runtimePipelineCount: runtimePipelineCount(runtime),
        lifecycleSubscriberCount: diagnosticsControllerFor(runtime).lifecycleSubscriberCount,
        pipelineCreationAttempts: snapshot.aggregates.pipelineCreationAttempts,
        successfulPipelineCreations: snapshot.aggregates.successfulPipelineCreations,
        pipelineDisposals: snapshot.aggregates.pipelineDisposals,
        heapUsedBytes: process.memoryUsage().heapUsed,
    }
}

function verifyLongRun(result, count) {

    for (const snapshot of [ result.afterFirstHalf, result.afterSecondHalf ]) {
        assertBenchmark(snapshot.retainedOperationCount <= 64, 'long run exceeded operation capacity')
        assertBenchmark(snapshot.retainedIncidentCount === 0, 'long run retained an incident')
        assertBenchmark(snapshot.retainedEvidenceBytes <= 64 * 1024, 'long run exceeded evidence bytes')
        assertBenchmark(snapshot.pendingOperationCount === 0, 'long run retained pending work')
        assertBenchmark(snapshot.livePipelineCount === 0, 'long run retained current pipeline facts')
        assertBenchmark(snapshot.runtimePipelineCount === 0, 'long run retained runtime pipelines')
        assertBenchmark(snapshot.lifecycleSubscriberCount === 0, 'long run retained lifecycle subscribers')
    }
    assertBenchmark(result.retainedCountGrowth === 0, 'long-run retained count grew after capacity')
    assertBenchmark(
        result.afterSecondHalf.pipelineCreationAttempts === count,
        'long-run pipeline-attempt count drifted'
    )
    assertBenchmark(
        result.afterSecondHalf.successfulPipelineCreations === count,
        'long-run success count drifted'
    )
    assertBenchmark(
        result.afterSecondHalf.pipelineDisposals === count,
        'long-run disposal count drifted'
    )
}

export function verifyBenchmarkResult(result) {

    assertBenchmark(result.profiles.length === profileDefinitions.length, 'profile count drifted')
    assertBenchmark(
        result.profiles.every((profileResult, index) => (
            profileResult.name === profileDefinitions[index].name &&
            profileResult.verifiedRoundCount === rounds
        )),
        'profile order or verified-round count drifted'
    )
    return {
        status: 'passed',
        verifiedProfileCount: result.profiles.length,
        verifiedProfileRoundCount: result.profiles.length * rounds,
        longRunPipelineCycleCount: result.longRun.secondPipelineCycleCount,
    }
}

function clearFakeCallRetention(fake) {

    for (const key of [
        'shaderModules',
        'pipelineLayouts',
        'renderPipelines',
        'computePipelines',
        'errorScopes',
        'nativeTimeline',
        'compilationInfoRequests',
        'asyncPipelineRequests',
    ]) {
        fake.calls[key].length = 0
    }
}

function medianSample(samples) {

    return Object.fromEntries(
        numericKeys(samples).map(key => [ key, median(samples.map(sample => sample[key])) ])
    )
}

function rangeSample(samples) {

    return Object.fromEntries(numericKeys(samples).map(key => {
        const values = samples.map(sample => sample[key])
        return [ key, { min: Math.min(...values), max: Math.max(...values) } ]
    }))
}

function numericKeys(samples) {

    return Object.keys(samples[0]).filter(key => samples.every(sample => (
        typeof sample[key] === 'number'
    )))
}

function median(values) {

    const sorted = [ ...values ].sort((left, right) => left - right)
    const middle = Math.floor(sorted.length / 2)
    return sorted.length % 2 === 0
        ? (sorted[middle - 1] + sorted[middle]) / 2
        : sorted[middle]
}

function millisecondsToMicroseconds(value) {

    return Number((value * 1_000).toFixed(3))
}

function positiveInteger(value, fallback) {

    const number = Number(value ?? fallback)
    if (!Number.isSafeInteger(number) || number <= 0) {
        throw new TypeError(`Expected a positive integer, received ${value}.`)
    }
    return number
}

function collectGarbageIfAvailable() {

    if (typeof globalThis.gc === 'function') globalThis.gc()
}

function assertBenchmark(condition, message) {

    if (!condition) throw new Error(`Benchmark verification failed: ${message}`)
}
