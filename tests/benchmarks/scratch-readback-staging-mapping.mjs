import os from 'node:os'
import process from 'node:process'
import { performance } from 'node:perf_hooks'
import { ScratchRuntime } from '../../packages/geoscratch/dist/scratch/runtime.js'
import { diagnosticsControllerFor } from '../../packages/geoscratch/dist/scratch/runtime-diagnostics.js'
import { createFakeGpu } from '../scratch-test-utils.js'

const iterations = positiveInteger(process.env.SCRATCH_READBACK_BENCH_ITERATIONS, 250)
const rounds = positiveInteger(process.env.SCRATCH_READBACK_BENCH_ROUNDS, 5)
const warmupIterations = positiveInteger(process.env.SCRATCH_READBACK_BENCH_WARMUP, 50)
const definitions = Object.freeze([
    profile('direct-mapping-history-disabled', 'direct', 'zero'),
    profile('direct-mapping-default-recorder', 'direct', 'default'),
    profile('direct-mapping-deep-capture', 'direct', 'capture'),
    profile('ordered-factory-history-disabled', 'ordered-factory', 'zero'),
    profile('ordered-mapping-history-disabled', 'ordered-reuse', 'zero'),
    profile('ordered-mapping-default-recorder', 'ordered-reuse', 'default'),
    profile('submission-no-readback-history-disabled', 'submission-baseline', 'zero'),
])

const profiles = []
for (const definition of definitions) profiles.push(await benchmarkProfile(definition))

const result = {
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
        explicitGcAvailable: typeof globalThis.gc === 'function',
    },
    measurementBoundary: {
        device: 'deterministic in-process fake GPUDevice',
        issue: 'public call through synchronous native issue and returned Promise/SubmittedWork',
        settlement: 'returned async boundary through acknowledged allocation or owned host bytes',
        direct: 'createReadback plus first toBytes issue/settlement',
        orderedFactory: 'createReadbackCommand through acknowledged reusable staging slot',
        orderedMapping: 'synchronous submit plus result mapping and host copy on one reused slot',
        submissionBaseline: 'effect-free synchronous submit plus already-resolved done',
        recording: 'default bounded recorder, history-disabled recorder, or finite deep capture',
        excludes: [
            'browser IPC',
            'driver allocation or mapping latency',
            'physical GPU work',
            'physical memory residency',
        ],
    },
    profiles,
    verification: {
        status: 'passed',
        profileCount: profiles.length,
        machineSpecificTimeThresholds: false,
        allRoundsStructurallyVerified: profiles.every(profile => profile.verifiedRoundCount === rounds),
    },
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)

function profile(name, workload, recorder) {

    return Object.freeze({ name, workload, recorder })
}

async function benchmarkProfile(definition) {

    const samples = []
    for (let round = 0; round < rounds; round++) {
        const fake = createFakeGpu()
        const runtime = await ScratchRuntime.create({
            gpu: fake.gpu,
            ...(diagnosticsOptions(definition.recorder) !== undefined
                ? { diagnostics: diagnosticsOptions(definition.recorder) }
                : {}),
            readback: {
                maxPendingOperations: 32,
                maxStagingBytes: 1024 * 1024,
            },
        })
        const setup = await setupWorkload(runtime, definition.workload)
        await runWorkload(runtime, fake, definition.workload, setup, warmupIterations, false)
        const capture = definition.recorder === 'capture'
            ? runtime.diagnostics.capture({
                maxOperations: iterations * 6,
                maxDurationMs: 60_000,
                maxEvidenceBytes: 32 * 1024 * 1024,
                includeStacks: true,
                includeDescriptors: true,
            })
            : undefined
        const timing = await runWorkload(
            runtime,
            fake,
            definition.workload,
            setup,
            iterations,
            true
        )
        setup.command?.dispose()
        const captureReport = capture?.stop()
        const snapshot = runtime.diagnostics.snapshot()
        const sample = {
            issueMicrosecondsPerIteration: toMicroseconds(timing.issueMs / iterations),
            settlementMicrosecondsPerIteration: toMicroseconds(timing.settlementMs / iterations),
            totalMicrosecondsPerIteration: toMicroseconds(timing.totalMs / iterations),
            pendingOperationCount: snapshot.pendingOperations.length,
            currentReadbackCount: snapshot.readbacks.length,
            currentCommandCount: snapshot.readbackCommands.length,
            currentStagingBytes: snapshot.readbackMemory.currentStagingBytes,
            currentRetainedHostBytes: snapshot.readbackMemory.currentRetainedHostBytes,
            activeMappings: snapshot.readbackMemory.activeMappings,
            lifecycleSubscriberCount: diagnosticsControllerFor(runtime).lifecycleSubscriberCount,
            retainedOperationCount: snapshot.recorder.retainedOperationCount,
            retainedIncidentCount: snapshot.recorder.retainedIncidentCount,
            retainedEvidenceBytes: snapshot.recorder.retainedEvidenceBytes,
            overwrittenOperations: snapshot.recorder.overwrittenOperations,
            omittedRecords: snapshot.recorder.omittedRecords,
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
        verifySample(definition, sample)
        samples.push(sample)
        runtime.dispose()
    }

    return {
        ...definition,
        iterationsPerRound: iterations,
        verifiedRoundCount: samples.length,
        median: medianSample(samples),
        range: rangeSample(samples),
    }
}

async function setupWorkload(runtime, workload) {

    if (workload === 'submission-baseline') return {}
    const source = await runtime.createBuffer({
        label: `${workload} benchmark source`,
        size: 16,
        usage: 0x4 | 0x8,
    })
    const upload = runtime.createUploadCommand({
        target: source.region(),
        data: new Uint32Array([ 1, 2, 3, 4 ]),
    })
    await runtime.createSubmission().upload(upload).submit().done
    if (workload !== 'ordered-reuse') return { source }
    const command = await runtime.createReadbackCommand({
        label: 'ordered mapping benchmark',
        source: { region: source.region(), contentEpoch: source.contentEpoch },
        whenMissing: 'throw',
    })
    return { source, command }
}

async function runWorkload(runtime, fake, workload, setup, count, timed) {

    let issueMs = 0
    let settlementMs = 0
    let totalMs = 0
    for (let index = 0; index < count; index++) {
        const startedAt = performance.now()
        let settlement
        let cleanup
        if (workload === 'direct') {
            const operation = runtime.createReadback({
                source: setup.source.region(),
                retain: 'consume-on-read',
            })
            settlement = operation.toBytes()
        } else if (workload === 'ordered-factory') {
            settlement = runtime.createReadbackCommand({
                source: {
                    region: setup.source.region(),
                    contentEpoch: setup.source.contentEpoch,
                },
                whenMissing: 'throw',
            })
            cleanup = value => value.dispose()
        } else if (workload === 'ordered-reuse') {
            const submitted = runtime.createSubmission().readback(setup.command).submit()
            settlement = setup.command.result({ after: submitted }).toBytes()
        } else {
            settlement = runtime.createSubmission().submit().done
        }
        const issuedAt = performance.now()
        const value = await settlement
        const settledAt = performance.now()
        cleanup?.(value)
        if (value instanceof Uint8Array) {
            assertBenchmark(value.byteLength === 16, `${workload} returned wrong byte length`)
        }
        if (timed) {
            issueMs += issuedAt - startedAt
            settlementMs += settledAt - issuedAt
            totalMs += settledAt - startedAt
        }
        if ((index + 1) % 64 === 0) clearFakeCallRetention(fake)
    }
    clearFakeCallRetention(fake)
    return { issueMs, settlementMs, totalMs }
}

function diagnosticsOptions(recorder) {

    if (recorder === 'zero' || recorder === 'capture') {
        return {
            operationCapacity: 0,
            incidentCapacity: 0,
            evidenceByteCapacity: 0,
        }
    }
    return undefined
}

function verifySample(definition, sample) {

    assertBenchmark(sample.issueMicrosecondsPerIteration >= 0, `${definition.name} issue timing invalid`)
    assertBenchmark(sample.settlementMicrosecondsPerIteration >= 0, `${definition.name} settlement timing invalid`)
    assertBenchmark(sample.totalMicrosecondsPerIteration >= 0, `${definition.name} total timing invalid`)
    assertBenchmark(sample.pendingOperationCount === 0, `${definition.name} retained pending operations`)
    assertBenchmark(sample.currentReadbackCount === 0, `${definition.name} retained readbacks`)
    assertBenchmark(sample.currentCommandCount === 0, `${definition.name} retained commands`)
    assertBenchmark(sample.currentStagingBytes === 0, `${definition.name} retained staging bytes`)
    assertBenchmark(sample.currentRetainedHostBytes === 0, `${definition.name} retained host bytes`)
    assertBenchmark(sample.activeMappings === 0, `${definition.name} retained active mappings`)
    assertBenchmark(sample.lifecycleSubscriberCount === 0, `${definition.name} retained lifecycle subscribers`)
    if (definition.recorder === 'zero' || definition.recorder === 'capture') {
        assertBenchmark(sample.retainedOperationCount === 0, `${definition.name} retained disabled history`)
    }
    if (definition.recorder === 'capture') {
        assertBenchmark(sample.captureStopReason === 'explicit', 'capture did not stop explicitly')
        assertBenchmark(sample.captureOperationCount > 0, 'capture retained no readback operations')
        assertBenchmark(sample.captureOperationsWithStacks > 0, 'capture retained no stacks')
        assertBenchmark(sample.captureOperationsWithFullDescriptors > 0, 'capture retained no descriptors')
    }
}

function medianSample(samples) {

    const keys = [
        'issueMicrosecondsPerIteration',
        'settlementMicrosecondsPerIteration',
        'totalMicrosecondsPerIteration',
        'retainedOperationCount',
        'retainedEvidenceBytes',
        'overwrittenOperations',
        'omittedRecords',
    ]
    return Object.fromEntries(keys.map(key => [ key, median(samples.map(sample => sample[key])) ]))
}

function rangeSample(samples) {

    const keys = [
        'issueMicrosecondsPerIteration',
        'settlementMicrosecondsPerIteration',
        'totalMicrosecondsPerIteration',
    ]
    return Object.fromEntries(keys.map(key => {
        const values = samples.map(sample => sample[key])
        return [ key, { min: Math.min(...values), max: Math.max(...values) } ]
    }))
}

function median(values) {

    const sorted = [ ...values ].sort((left, right) => left - right)
    const middle = Math.floor(sorted.length / 2)
    return sorted.length % 2 === 0
        ? (sorted[middle - 1] + sorted[middle]) / 2
        : sorted[middle]
}

function clearFakeCallRetention(fake) {

    for (const value of Object.values(fake.calls)) {
        if (Array.isArray(value)) value.length = 0
    }
}

function toMicroseconds(milliseconds) {

    return milliseconds * 1_000
}

function positiveInteger(value, fallback) {

    if (value === undefined) return fallback
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new TypeError(`Expected a positive integer, received ${value}.`)
    }
    return parsed
}

function assertBenchmark(condition, message) {

    if (!condition) throw new Error(message)
}
