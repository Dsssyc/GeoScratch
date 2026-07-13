import process from 'node:process'
import { performance } from 'node:perf_hooks'
import { ScratchRuntime } from '../../packages/geoscratch/dist/scratch/runtime.js'
import { diagnosticsControllerFor } from '../../packages/geoscratch/dist/scratch/runtime-diagnostics.js'
import {
    runtimeReadbackCommandCount,
    runtimeReadbackOperationCount,
} from '../../packages/geoscratch/dist/scratch/readback-ownership.js'
import { createFakeGpu } from '../scratch-test-utils.js'

const directIterations = positiveInteger(
    process.env.SCRATCH_READBACK_STRESS_DIRECT,
    20_000
)
const orderedIterations = positiveInteger(
    process.env.SCRATCH_READBACK_STRESS_ORDERED,
    5_000
)
const allowShort = process.env.SCRATCH_READBACK_STRESS_ALLOW_SHORT === '1'

if (!allowShort) {
    assertStress(directIterations >= 20_000, 'direct stress must run at least 20,000 operations')
    assertStress(orderedIterations >= 5_000, 'ordered stress must run at least 5,000 reuses')
}

const direct = await stressDirect(directIterations)
const ordered = await stressOrdered(orderedIterations)
const result = {
    schemaVersion: 1,
    measurementBoundary: {
        device: 'deterministic in-process fake GPUDevice',
        direct: 'create ReadbackOperation through owned host copy and terminal cleanup',
        ordered: 'reuse one acknowledged ReadbackCommand through submit, map, host copy, and slot return',
        recorder: '64 operations / 8 incidents / 64 KiB serialized evidence',
        excludes: [ 'browser IPC', 'driver work', 'physical GPU residency' ],
    },
    direct,
    ordered,
    verification: {
        status: 'passed',
        minimumDirectOperations: 20_000,
        minimumOrderedReuses: 5_000,
        terminalPendingOperations: direct.terminal.pendingOperationCount +
            ordered.terminal.pendingOperationCount,
        terminalActiveMappings: direct.terminal.activeMappings + ordered.terminal.activeMappings,
        terminalLifecycleSubscribers: direct.terminal.lifecycleSubscriberCount +
            ordered.terminal.lifecycleSubscriberCount,
        terminalStagingBytes: direct.terminal.currentStagingBytes +
            ordered.terminal.currentStagingBytes,
    },
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)

async function stressDirect(iterations) {

    const fake = createFakeGpu()
    const runtime = await createStressRuntime(fake)
    const source = await createReadySource(runtime)
    const counters = emptyNativeCounters()
    const startedAt = performance.now()

    for (let index = 0; index < iterations; index++) {
        const operation = runtime.createReadback({
            label: `direct stress ${index}`,
            source: source.region(),
            retain: 'consume-on-read',
        })
        const bytes = await operation.toBytes()
        assertStress(bytes.byteLength === 16, `direct operation ${index} returned wrong byte length`)
        assertStress(operation.state === 'consumed', `direct operation ${index} did not consume`)
        if ((index + 1) % 128 === 0) flushFakeCounters(fake, counters)
    }
    flushFakeCounters(fake, counters)
    const elapsedMs = performance.now() - startedAt
    const terminal = terminalFacts(runtime)

    assertStress(counters.stagingAllocations === iterations, 'direct staging allocation count drifted')
    assertStress(counters.maps === iterations, 'direct map count drifted')
    assertStress(counters.destroys === iterations, 'direct staging destroy count drifted')
    assertTerminal(runtime, terminal, { expectedCommands: 0 })
    assertStress(terminal.overwrittenOperations > 0, 'direct recorder did not overflow')
    runtime.dispose()
    return {
        operations: iterations,
        elapsedMs,
        operationsPerSecond: iterations / (elapsedMs / 1_000),
        native: counters,
        terminal,
    }
}

async function stressOrdered(iterations) {

    const fake = createFakeGpu()
    const runtime = await createStressRuntime(fake)
    const source = await createReadySource(runtime)
    const command = await runtime.createReadbackCommand({
        label: 'ordered stress command',
        source: { region: source.region(), contentEpoch: source.contentEpoch },
        whenMissing: 'throw',
    })
    const stagingAllocations = fake.calls.buffers.filter(isStagingBuffer).length
    const counters = emptyNativeCounters()
    clearFakeCalls(fake)
    const startedAt = performance.now()

    for (let index = 0; index < iterations; index++) {
        const submitted = runtime.createSubmission().readback(command).submit()
        const operation = command.result({ after: submitted })
        const bytes = await operation.toBytes()
        await submitted.done
        assertStress(bytes.byteLength === 16, `ordered reuse ${index} returned wrong byte length`)
        assertStress(operation.state === 'consumed', `ordered reuse ${index} did not consume`)
        assertStress(command.state === 'idle', `ordered reuse ${index} did not return slot to idle`)
        if ((index + 1) % 128 === 0) flushFakeCounters(fake, counters)
    }
    flushFakeCounters(fake, counters)
    const elapsedMs = performance.now() - startedAt
    const beforeDispose = terminalFacts(runtime)
    assertStress(stagingAllocations === 1, 'ordered factory did not allocate exactly one staging slot')
    assertStress(counters.stagingAllocations === 0, 'ordered reuse allocated another staging slot')
    assertStress(counters.maps === iterations, 'ordered map count drifted')
    assertStress(counters.destroys === 0, 'ordered slot was destroyed before command disposal')
    assertStress(beforeDispose.currentStagingBytes === 16, 'ordered idle slot staging bytes drifted')
    assertStress(beforeDispose.activeMappings === 0, 'ordered reuse retained active mappings')
    assertStress(beforeDispose.pendingOperationCount === 0, 'ordered reuse retained pending operations')
    assertStress(beforeDispose.lifecycleSubscriberCount === 0, 'ordered reuse retained lifecycle subscribers')
    assertStress(beforeDispose.overwrittenOperations > 0, 'ordered recorder did not overflow')

    command.dispose()
    flushFakeCounters(fake, counters)
    const terminal = terminalFacts(runtime)
    assertStress(counters.destroys === 1, 'ordered slot was not destroyed exactly once')
    assertTerminal(runtime, terminal, { expectedCommands: 0 })
    runtime.dispose()
    return {
        reuses: iterations,
        elapsedMs,
        reusesPerSecond: iterations / (elapsedMs / 1_000),
        acknowledgedStagingAllocations: stagingAllocations,
        native: counters,
        beforeCommandDispose: beforeDispose,
        terminal,
    }
}

async function createStressRuntime(fake) {

    return ScratchRuntime.create({
        gpu: fake.gpu,
        diagnostics: {
            operationCapacity: 64,
            incidentCapacity: 8,
            evidenceByteCapacity: 64 * 1024,
        },
        readback: {
            maxPendingOperations: 32,
            maxStagingBytes: 1024 * 1024,
        },
    })
}

async function createReadySource(runtime) {

    const source = await runtime.createBuffer({
        label: 'readback stress source',
        size: 16,
        usage: 0x4 | 0x8,
    })
    const upload = runtime.createUploadCommand({
        target: source.region(),
        data: new Uint32Array([ 1, 2, 3, 4 ]),
    })
    const submitted = runtime.createSubmission().upload(upload).submit()
    await submitted.done
    assertStress(source.contentEpoch === 1, 'stress source upload did not advance content epoch')
    return source
}

function terminalFacts(runtime) {

    const snapshot = runtime.diagnostics.snapshot()
    return {
        pendingOperationCount: snapshot.pendingOperations.length,
        currentReadbackCount: snapshot.readbacks.length,
        currentCommandCount: snapshot.readbackCommands.length,
        currentStagingBytes: snapshot.readbackMemory.currentStagingBytes,
        currentRetainedHostBytes: snapshot.readbackMemory.currentRetainedHostBytes,
        activeMappings: snapshot.readbackMemory.activeMappings,
        retainedOperationCount: snapshot.recorder.retainedOperationCount,
        retainedIncidentCount: snapshot.recorder.retainedIncidentCount,
        retainedEvidenceBytes: snapshot.recorder.retainedEvidenceBytes,
        overwrittenOperations: snapshot.recorder.overwrittenOperations,
        runtimeReadbackOperationCount: runtimeReadbackOperationCount(runtime),
        runtimeReadbackCommandCount: runtimeReadbackCommandCount(runtime),
        lifecycleSubscriberCount: diagnosticsControllerFor(runtime).lifecycleSubscriberCount,
    }
}

function assertTerminal(runtime, facts, { expectedCommands }) {

    assertStress(facts.pendingOperationCount === 0, 'terminal pending operations were retained')
    assertStress(facts.currentReadbackCount === 0, 'terminal current readbacks were retained')
    assertStress(facts.currentCommandCount === expectedCommands, 'terminal command facts drifted')
    assertStress(facts.currentStagingBytes === 0, 'terminal staging bytes were retained')
    assertStress(facts.currentRetainedHostBytes === 0, 'terminal host bytes were retained')
    assertStress(facts.activeMappings === 0, 'terminal active mappings were retained')
    assertStress(facts.runtimeReadbackOperationCount === 0, 'runtime retained readback operations')
    assertStress(facts.runtimeReadbackCommandCount === expectedCommands, 'runtime command ownership drifted')
    assertStress(facts.lifecycleSubscriberCount === 0, 'terminal lifecycle subscribers were retained')
    assertStress(facts.retainedOperationCount <= 64, 'operation recorder exceeded capacity')
    assertStress(facts.retainedIncidentCount <= 8, 'incident recorder exceeded capacity')
    assertStress(facts.retainedEvidenceBytes <= 64 * 1024, 'evidence recorder exceeded byte budget')
    assertStress(runtime.isDisposed === false, 'runtime disposed before terminal facts were checked')
}

function emptyNativeCounters() {

    return { stagingAllocations: 0, maps: 0, destroys: 0 }
}

function flushFakeCounters(fake, counters) {

    counters.stagingAllocations += fake.calls.buffers.filter(isStagingBuffer).length
    counters.maps += fake.calls.maps.length
    counters.destroys += fake.calls.bufferDestroys.length
    clearFakeCalls(fake)
}

function clearFakeCalls(fake) {

    for (const value of Object.values(fake.calls)) {
        if (Array.isArray(value)) value.length = 0
    }
    fake.readbacks.mapRequests.length = 0
    fake.readbacks.queueCompletionRequests.length = 0
}

function isStagingBuffer(buffer) {

    return (buffer.descriptor?.usage & 0x1) !== 0
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
