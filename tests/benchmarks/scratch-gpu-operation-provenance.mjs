import os from 'node:os'
import process from 'node:process'
import { performance } from 'node:perf_hooks'
import { ScratchRuntime } from '../../packages/geoscratch/dist/scratch/runtime.js'
import { diagnosticsControllerFor } from '../../packages/geoscratch/dist/scratch/runtime-diagnostics.js'
import { createFakeGpu } from '../scratch-test-utils.js'

const iterations = positiveInteger(process.env.SCRATCH_BENCH_ITERATIONS, 1_000)
const rounds = positiveInteger(process.env.SCRATCH_BENCH_ROUNDS, 5)
const warmupIterations = positiveInteger(process.env.SCRATCH_BENCH_WARMUP, 200)
const captureIterations = Math.min(iterations, 500)
const longRunIterations = positiveInteger(process.env.SCRATCH_BENCH_LONG_RUN, 20_000)

const profiles = []
profiles.push(await benchmarkProfile({
    name: 'history-capacity-zero',
    diagnostics: {
        operationCapacity: 0,
        incidentCapacity: 0,
        evidenceByteCapacity: 0,
    },
    iterations,
}))
profiles.push(await benchmarkProfile({
    name: 'default-bounded-recorder',
    iterations,
}))
profiles.push(await benchmarkProfile({
    name: 'steady-state-overwrite',
    diagnostics: {
        operationCapacity: 32,
        incidentCapacity: 4,
        evidenceByteCapacity: 32 * 1024,
    },
    prefill: 32,
    iterations,
}))
profiles.push(await benchmarkProfile({
    name: 'bounded-capture-descriptors',
    diagnostics: {
        operationCapacity: 0,
        incidentCapacity: 0,
        evidenceByteCapacity: 0,
    },
    capture: {
        includeStacks: false,
        includeDescriptors: true,
    },
    iterations: captureIterations,
}))
profiles.push(await benchmarkProfile({
    name: 'bounded-capture-stacks-and-descriptors',
    diagnostics: {
        operationCapacity: 0,
        incidentCapacity: 0,
        evidenceByteCapacity: 0,
    },
    capture: {
        includeStacks: true,
        includeDescriptors: true,
    },
    iterations: captureIterations,
}))
profiles.push(await benchmarkProfile({
    name: 'bounded-capture-without-stacks',
    diagnostics: {
        operationCapacity: 0,
        incidentCapacity: 0,
        evidenceByteCapacity: 0,
    },
    capture: {
        includeStacks: false,
        includeDescriptors: false,
    },
    iterations: captureIterations,
}))
profiles.push(await benchmarkProfile({
    name: 'bounded-capture-with-stacks',
    diagnostics: {
        operationCapacity: 0,
        incidentCapacity: 0,
        evidenceByteCapacity: 0,
    },
    capture: {
        includeStacks: true,
        includeDescriptors: false,
    },
    iterations: captureIterations,
}))

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
        captureIterations,
        longRunIterations,
        explicitGcAvailable: typeof globalThis.gc === 'function',
    },
    measurementBoundary: {
        device: 'deterministic in-process fake GPUDevice',
        issue: 'synchronous public API call through native scope pops',
        settlement: 'fake scope-promise settlement through public allocation resolution',
        excludes: [
            'browser IPC',
            'driver work',
            'physical GPU allocation',
            'queue work completion',
        ],
    },
    profiles,
    longRun: await benchmarkLongRun(longRunIterations),
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)

async function benchmarkProfile({
    name,
    diagnostics,
    capture,
    iterations: profileIterations,
    prefill = 0,
}) {

    const samples = []
    for (let round = 0; round < rounds; round++) {
        const fake = createFakeGpu()
        const runtime = await ScratchRuntime.create({
            gpu: fake.gpu,
            ...(diagnostics !== undefined ? { diagnostics } : {}),
        })

        await runUntimed(runtime, fake, warmupIterations + prefill)
        const captureSession = capture === undefined
            ? undefined
            : runtime.diagnostics.capture({
                maxOperations: profileIterations,
                maxDurationMs: 60_000,
                maxEvidenceBytes: 16 * 1024 * 1024,
                ...capture,
            })

        let issueMs = 0
        let settlementMs = 0
        const totalStartedAt = performance.now()
        for (let index = 0; index < profileIterations; index++) {
            const startedAt = performance.now()
            const allocation = runtime.createBuffer({ size: 4, usage: 1 })
            const issuedAt = performance.now()
            const buffer = await allocation
            const settledAt = performance.now()

            issueMs += issuedAt - startedAt
            settlementMs += settledAt - issuedAt
            buffer.dispose()
        }
        const totalMs = performance.now() - totalStartedAt
        const captureReport = captureSession?.stop()
        const snapshot = runtime.diagnostics.snapshot()
        const lifecycleSubscriberCount = diagnosticsControllerFor(runtime).lifecycleSubscriberCount

        samples.push({
            issueMicrosecondsPerOperation: millisecondsToMicroseconds(issueMs / profileIterations),
            settlementMicrosecondsPerOperation: millisecondsToMicroseconds(settlementMs / profileIterations),
            totalMicrosecondsPerOperation: millisecondsToMicroseconds(totalMs / profileIterations),
            retainedOperationCount: snapshot.recorder.retainedOperationCount,
            retainedIncidentCount: snapshot.recorder.retainedIncidentCount,
            retainedEvidenceBytes: snapshot.recorder.retainedEvidenceBytes,
            overwrittenOperations: snapshot.recorder.overwrittenOperations,
            omittedRecords: snapshot.recorder.omittedRecords,
            liveResourceCount: snapshot.resources.length,
            pendingOperationCount: snapshot.pendingOperations.length,
            lifecycleSubscriberCount,
            ...(captureReport !== undefined ? {
                captureStopReason: captureReport.stopReason,
                captureOperationCount: captureReport.operations.length,
                captureRetainedEvidenceBytes: captureReport.retainedEvidenceBytes,
            } : {}),
        })

        runtime.dispose()
    }

    return {
        name,
        operationsPerRound: profileIterations,
        median: medianSample(samples),
        range: rangeSample(samples),
    }
}

async function benchmarkLongRun(totalIterations) {

    const fake = createFakeGpu()
    const runtime = await ScratchRuntime.create({
        gpu: fake.gpu,
        diagnostics: {
            operationCapacity: 64,
            incidentCapacity: 8,
            evidenceByteCapacity: 64 * 1024,
        },
    })
    const halfway = Math.floor(totalIterations / 2)

    await runUntimed(runtime, fake, halfway)
    collectGarbageIfAvailable()
    const first = longRunSnapshot(runtime)

    await runUntimed(runtime, fake, totalIterations - halfway)
    collectGarbageIfAvailable()
    const second = longRunSnapshot(runtime)

    runtime.dispose()
    return {
        firstEventCount: halfway,
        secondEventCount: totalIterations,
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
}

async function runUntimed(runtime, fake, count) {

    for (let index = 0; index < count; index++) {
        const buffer = await runtime.createBuffer({ size: 4, usage: 1 })
        buffer.dispose()
        if ((index + 1) % 256 === 0) clearFakeCallRetention(fake)
    }
    clearFakeCallRetention(fake)
}

function clearFakeCallRetention(fake) {

    fake.calls.buffers.length = 0
    fake.calls.errorScopes.length = 0
}

function longRunSnapshot(runtime) {

    const snapshot = runtime.diagnostics.snapshot()
    return {
        retainedOperationCount: snapshot.recorder.retainedOperationCount,
        retainedIncidentCount: snapshot.recorder.retainedIncidentCount,
        retainedEvidenceBytes: snapshot.recorder.retainedEvidenceBytes,
        overwrittenOperations: snapshot.recorder.overwrittenOperations,
        liveResourceCount: snapshot.resources.length,
        pendingOperationCount: snapshot.pendingOperations.length,
        lifecycleSubscriberCount: diagnosticsControllerFor(runtime).lifecycleSubscriberCount,
        heapUsedBytes: process.memoryUsage().heapUsed,
    }
}

function medianSample(samples) {

    const result = {}
    for (const key of numericKeys(samples)) {
        result[key] = median(samples.map(sample => sample[key]))
    }
    const representative = samples[Math.floor(samples.length / 2)]
    for (const [ key, value ] of Object.entries(representative)) {
        if (typeof value !== 'number') result[key] = value
    }
    return result
}

function rangeSample(samples) {

    const result = {}
    for (const key of numericKeys(samples)) {
        const values = samples.map(sample => sample[key])
        result[key] = { min: Math.min(...values), max: Math.max(...values) }
    }
    return result
}

function numericKeys(samples) {

    return Object.keys(samples[0]).filter(key => samples.every(sample => typeof sample[key] === 'number'))
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

    if (value === undefined) return fallback
    const parsed = Number(value)
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed
    throw new TypeError(`Expected a positive integer, received ${value}.`)
}

function collectGarbageIfAvailable() {

    globalThis.gc?.()
}
