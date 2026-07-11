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
const defaultOperationCapacity = 256
const defaultEvidenceByteCapacity = 256 * 1024
const overwriteOperationCapacity = 32
const overwriteEvidenceByteCapacity = 32 * 1024
const captureEvidenceByteCapacity = 16 * 1024 * 1024
const longRunOperationCapacity = 64
const longRunEvidenceByteCapacity = 64 * 1024
const expectedProfileNames = Object.freeze([
    'history-capacity-zero',
    'default-bounded-recorder',
    'steady-state-overwrite',
    'bounded-capture-descriptors',
    'bounded-capture-stacks-and-descriptors',
    'bounded-capture-without-stacks',
    'bounded-capture-with-stacks',
])

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
        operationCapacity: overwriteOperationCapacity,
        incidentCapacity: 4,
        evidenceByteCapacity: overwriteEvidenceByteCapacity,
    },
    prefill: overwriteOperationCapacity,
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

const longRun = await benchmarkLongRun(longRunIterations)
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
        captureIterations,
        longRunIterations,
        explicitGcAvailable: typeof globalThis.gc === 'function',
    },
    measurementBoundary: {
        device: 'deterministic in-process fake GPUDevice',
        issue: 'synchronous public API call through native scope pops',
        settlement: 'fake scope-promise settlement through public allocation resolution',
        total: 'public allocation call through promise resolution; subsequent resource disposal is excluded',
        excludes: [
            'browser IPC',
            'driver work',
            'physical GPU allocation',
            'queue work completion',
        ],
    },
    profiles,
    longRun,
}
const result = {
    ...benchmarkResult,
    verification: verifyBenchmarkResult(benchmarkResult),
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
                maxOperations: profileIterations * 2,
                maxDurationMs: 60_000,
                maxEvidenceBytes: captureEvidenceByteCapacity,
                ...capture,
            })

        let issueMs = 0
        let settlementMs = 0
        let totalMs = 0
        for (let index = 0; index < profileIterations; index++) {
            const startedAt = performance.now()
            const allocation = runtime.createBuffer({ size: 4, usage: 1 })
            const issuedAt = performance.now()
            const buffer = await allocation
            const settledAt = performance.now()

            issueMs += issuedAt - startedAt
            settlementMs += settledAt - issuedAt
            totalMs += settledAt - startedAt
            buffer.dispose()
        }
        const captureReport = captureSession?.stop()
        const snapshot = runtime.diagnostics.snapshot()
        const lifecycleSubscriberCount = diagnosticsControllerFor(runtime).lifecycleSubscriberCount

        const sample = {
            issueMicrosecondsPerAllocation: millisecondsToMicroseconds(issueMs / profileIterations),
            settlementMicrosecondsPerAllocation: millisecondsToMicroseconds(settlementMs / profileIterations),
            totalMicrosecondsPerAllocation: millisecondsToMicroseconds(totalMs / profileIterations),
            retainedOperationCount: snapshot.recorder.retainedOperationCount,
            retainedIncidentCount: snapshot.recorder.retainedIncidentCount,
            retainedEvidenceBytes: snapshot.recorder.retainedEvidenceBytes,
            overwrittenOperations: snapshot.recorder.overwrittenOperations,
            omittedRecords: snapshot.recorder.omittedRecords,
            liveResourceCount: snapshot.resources.length,
            pendingOperationCount: snapshot.pendingOperations.length,
            lifecycleSubscriberCount,
            activeCaptureCount: snapshot.capture.activeCount,
            allocationAttempts: snapshot.aggregates.allocationAttempts,
            successfulAllocations: snapshot.aggregates.successfulAllocations,
            validationFailures: snapshot.aggregates.validationFailures,
            outOfMemoryFailures: snapshot.aggregates.outOfMemoryFailures,
            nativeFailures: snapshot.aggregates.nativeFailures,
            scopeFailures: snapshot.aggregates.scopeFailures,
            cancelledAllocations: snapshot.aggregates.cancelledAllocations,
            uncapturedErrors: snapshot.aggregates.uncapturedErrors,
            deviceLosses: snapshot.aggregates.deviceLosses,
            ...(captureReport !== undefined ? {
                captureStopReason: captureReport.stopReason,
                captureOperationCount: captureReport.operations.length,
                captureRetainedEvidenceBytes: captureReport.retainedEvidenceBytes,
            } : {}),
        }
        verifyBenchmarkProfileSample({
            name,
            sample,
            profileIterations,
            prefill,
            captureEnabled: capture !== undefined,
        })
        samples.push(sample)

        runtime.dispose()
    }

    return {
        name,
        allocationCyclesPerRound: profileIterations,
        verifiedRoundCount: samples.length,
        median: medianSample(samples),
        range: rangeSample(samples),
    }
}

async function benchmarkLongRun(totalIterations) {

    const fake = createFakeGpu()
    const runtime = await ScratchRuntime.create({
        gpu: fake.gpu,
        diagnostics: {
            operationCapacity: longRunOperationCapacity,
            incidentCapacity: 8,
            evidenceByteCapacity: longRunEvidenceByteCapacity,
        },
    })
    const halfway = Math.floor(totalIterations / 2)

    await runUntimed(runtime, fake, halfway)
    collectGarbageIfAvailable()
    const first = longRunSnapshot(runtime)

    await runUntimed(runtime, fake, totalIterations - halfway)
    collectGarbageIfAvailable()
    const second = longRunSnapshot(runtime)

    const result = {
        firstAllocationCycleCount: halfway,
        secondAllocationCycleCount: totalIterations,
        firstOperationEventCount: halfway * 2,
        secondOperationEventCount: totalIterations * 2,
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
    verifyLongRunResult(result, totalIterations)
    runtime.dispose()
    return result
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
        activeCaptureCount: snapshot.capture.activeCount,
        allocationAttempts: snapshot.aggregates.allocationAttempts,
        successfulAllocations: snapshot.aggregates.successfulAllocations,
        validationFailures: snapshot.aggregates.validationFailures,
        outOfMemoryFailures: snapshot.aggregates.outOfMemoryFailures,
        nativeFailures: snapshot.aggregates.nativeFailures,
        scopeFailures: snapshot.aggregates.scopeFailures,
        cancelledAllocations: snapshot.aggregates.cancelledAllocations,
        uncapturedErrors: snapshot.aggregates.uncapturedErrors,
        deviceLosses: snapshot.aggregates.deviceLosses,
        heapUsedBytes: process.memoryUsage().heapUsed,
    }
}

function verifyBenchmarkProfileSample({
    name,
    sample,
    profileIterations,
    prefill,
    captureEnabled,
}) {

    const expectedAllocationAttempts = warmupIterations + prefill + profileIterations
    const zeroFields = [
        'retainedIncidentCount',
        'liveResourceCount',
        'pendingOperationCount',
        'lifecycleSubscriberCount',
        'activeCaptureCount',
        'validationFailures',
        'outOfMemoryFailures',
        'nativeFailures',
        'scopeFailures',
        'cancelledAllocations',
        'uncapturedErrors',
        'deviceLosses',
    ]
    for (const field of zeroFields) {
        assertBenchmark(sample[field] === 0, `${name} retained non-zero ${field}`)
    }
    assertBenchmark(
        sample.allocationAttempts === expectedAllocationAttempts,
        `${name} allocation-attempt count drifted`
    )
    assertBenchmark(
        sample.successfulAllocations === expectedAllocationAttempts,
        `${name} successful-allocation count drifted`
    )

    const isCaptureProfile = name.startsWith('bounded-capture-')
    assertBenchmark(
        captureEnabled === isCaptureProfile,
        `${name} capture configuration does not match its profile contract`
    )

    if (name === 'history-capacity-zero') {
        assertBenchmark(sample.retainedOperationCount === 0, `${name} retained operations`)
        assertBenchmark(sample.retainedEvidenceBytes === 0, `${name} retained evidence bytes`)
        return
    }

    if (name === 'default-bounded-recorder') {
        assertBenchmark(
            sample.retainedOperationCount <= defaultOperationCapacity,
            `${name} exceeded operation capacity`
        )
        assertBenchmark(
            sample.retainedEvidenceBytes <= defaultEvidenceByteCapacity,
            `${name} exceeded evidence-byte capacity`
        )
        assertBenchmark(sample.omittedRecords === 0, `${name} omitted records unexpectedly`)
        return
    }

    if (name === 'steady-state-overwrite') {
        assertBenchmark(
            sample.retainedOperationCount <= overwriteOperationCapacity,
            `${name} exceeded operation capacity`
        )
        assertBenchmark(
            sample.retainedEvidenceBytes <= overwriteEvidenceByteCapacity,
            `${name} exceeded evidence-byte capacity`
        )
        assertBenchmark(sample.overwrittenOperations > 0, `${name} did not exercise overwrite`)
        assertBenchmark(sample.omittedRecords === 0, `${name} omitted records unexpectedly`)
        return
    }

    assertBenchmark(isCaptureProfile, `unexpected benchmark profile ${name}`)
    assertBenchmark(sample.retainedOperationCount === 0, `${name} polluted default history`)
    assertBenchmark(sample.retainedEvidenceBytes === 0, `${name} polluted default evidence`)
    assertBenchmark(
        sample.captureStopReason === 'operation-limit',
        `${name} stopped for ${sample.captureStopReason}`
    )
    assertBenchmark(
        sample.captureOperationCount === profileIterations * 2,
        `${name} capture operation count drifted`
    )
    assertBenchmark(
        sample.captureRetainedEvidenceBytes <= captureEvidenceByteCapacity,
        `${name} exceeded capture evidence-byte capacity`
    )
}

function verifyLongRunResult(result, totalIterations) {

    const halfway = Math.floor(totalIterations / 2)
    assertBenchmark(
        result.firstAllocationCycleCount === halfway &&
        result.secondAllocationCycleCount === totalIterations,
        'long-run allocation-cycle facts drifted'
    )
    assertBenchmark(
        result.firstOperationEventCount === halfway * 2 &&
        result.secondOperationEventCount === totalIterations * 2,
        'long-run operation-event facts drifted'
    )
    verifyLongRunSnapshot('first', result.afterFirstHalf, halfway)
    verifyLongRunSnapshot('second', result.afterSecondHalf, totalIterations)

    const expectedFirstRetained = Math.min(longRunOperationCapacity, halfway * 2)
    const expectedSecondRetained = Math.min(longRunOperationCapacity, totalIterations * 2)
    assertBenchmark(
        result.retainedCountGrowth === expectedSecondRetained - expectedFirstRetained,
        'long-run retained-count growth drifted'
    )
}

function verifyLongRunSnapshot(name, snapshot, allocationCycles) {

    const operationEvents = allocationCycles * 2
    const expectedRetained = Math.min(longRunOperationCapacity, operationEvents)
    const expectedOverwritten = Math.max(0, operationEvents - longRunOperationCapacity)
    const zeroFields = [
        'retainedIncidentCount',
        'liveResourceCount',
        'pendingOperationCount',
        'lifecycleSubscriberCount',
        'activeCaptureCount',
        'validationFailures',
        'outOfMemoryFailures',
        'nativeFailures',
        'scopeFailures',
        'cancelledAllocations',
        'uncapturedErrors',
        'deviceLosses',
    ]
    for (const field of zeroFields) {
        assertBenchmark(snapshot[field] === 0, `long-run ${name} retained non-zero ${field}`)
    }
    assertBenchmark(
        snapshot.retainedOperationCount === expectedRetained,
        `long-run ${name} retained-operation count drifted`
    )
    assertBenchmark(
        snapshot.overwrittenOperations === expectedOverwritten,
        `long-run ${name} overwritten-operation count drifted`
    )
    assertBenchmark(
        snapshot.retainedEvidenceBytes <= longRunEvidenceByteCapacity,
        `long-run ${name} exceeded evidence-byte capacity`
    )
    assertBenchmark(
        snapshot.allocationAttempts === allocationCycles &&
        snapshot.successfulAllocations === allocationCycles,
        `long-run ${name} allocation aggregates drifted`
    )
}

function verifyBenchmarkResult(result) {

    assertBenchmark(result.schemaVersion === 1, 'benchmark schema version drifted')
    assertBenchmark(
        JSON.stringify(result.profiles.map(profile => profile.name)) ===
        JSON.stringify(expectedProfileNames),
        'benchmark profile set or order drifted'
    )
    assertBenchmark(
        result.profiles.every(profile => profile.verifiedRoundCount === rounds),
        'one or more benchmark rounds were not structurally verified'
    )
    assertBenchmark(
        result.measurementBoundary.total.includes('subsequent resource disposal is excluded'),
        'allocation timing boundary no longer excludes disposal'
    )
    verifyLongRunResult(result.longRun, longRunIterations)

    return Object.freeze({
        status: 'passed',
        checkedProfileRounds: result.profiles.length * rounds,
        structuralInvariantGroups: 5,
        timingThresholdsEnforced: false,
    })
}

function assertBenchmark(condition, message) {

    if (!condition) {
        throw new Error(`Scratch GPU provenance benchmark invariant failed: ${message}.`)
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
