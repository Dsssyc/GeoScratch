import process from 'node:process'
import { performance } from 'node:perf_hooks'
import { ScratchRuntime } from '../../packages/geoscratch/dist/scratch/runtime.js'
import { diagnosticsControllerFor } from '../../packages/geoscratch/dist/scratch/runtime-diagnostics.js'
import { createFakeGpu } from '../scratch-test-utils.js'

const MAP_READ = 0x1
const MAP_WRITE = 0x2
const COPY_SRC = 0x4
const COPY_DST = 0x8

const ordinaryIterations = positiveInteger(
    process.env.SCRATCH_BUFFER_MAPPING_STRESS_ORDINARY,
    20_000
)
const creationIterations = positiveInteger(
    process.env.SCRATCH_BUFFER_MAPPING_STRESS_CREATION,
    5_000
)
const allowShort = process.env.SCRATCH_BUFFER_MAPPING_STRESS_ALLOW_SHORT === '1'

if (!allowShort) {
    assertStress(ordinaryIterations >= 20_000, 'ordinary stress must run at least 20,000 leases')
    assertStress(creationIterations >= 5_000, 'creation stress must run at least 5,000 leases')
}

const ordinary = await stressOrdinaryMappings(ordinaryIterations)
const mappedCreation = await stressMappedCreation(creationIterations)
const result = {
    schemaVersion: 1,
    measurementBoundary: {
        device: 'deterministic in-process fake GPUDevice',
        ordinary: 'mapBuffer authority claim through mapped lease release and detached native view',
        mappedCreation: 'createMappedBuffer acknowledgement through WRITE release and resource disposal',
        recorder: '64 operations / 8 incidents / 64 KiB serialized evidence',
        excludes: [ 'browser IPC', 'driver work', 'physical GPU residency' ],
    },
    ordinary,
    mappedCreation,
    verification: {
        status: 'passed',
        minimumOrdinaryLeases: 20_000,
        minimumMappedCreations: 5_000,
        terminalCurrentMappings:
            ordinary.terminal.currentMappings + mappedCreation.terminal.currentMappings,
        terminalSelectedBytes:
            ordinary.terminal.currentSelectedBytes + mappedCreation.terminal.currentSelectedBytes,
        terminalLifecycleSubscribers:
            ordinary.terminal.lifecycleSubscriberCount +
            mappedCreation.terminal.lifecycleSubscriberCount,
        terminalLiveResources:
            ordinary.terminal.liveResourceCount + mappedCreation.terminal.liveResourceCount,
    },
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)

async function stressOrdinaryMappings(iterations) {

    const fake = createFakeGpu()
    const runtime = await createStressRuntime(fake)
    const readBuffer = await runtime.createBuffer({
        label: 'mapping stress read buffer',
        size: 16,
        usage: MAP_READ | COPY_DST,
    })
    const writeBuffer = await runtime.createBuffer({
        label: 'mapping stress write buffer',
        size: 16,
        usage: MAP_WRITE | COPY_SRC,
    })
    const counters = emptyNativeCounters()
    flushFakeCounters(fake, counters)
    let readLeases = 0
    let writeLeases = 0
    let detachedViews = 0
    const startedAt = performance.now()

    for (let index = 0; index < iterations; index++) {
        const write = index % 2 === 1
        const buffer = write ? writeBuffer : readBuffer
        const lease = await runtime.mapBuffer({
            region: buffer.region(),
            mode: write ? 'write' : 'read',
        })
        const view = lease.view
        if (write) {
            new Uint32Array(view)[0] = index
            writeLeases += 1
        } else {
            readLeases += 1
        }

        if ((index + 1) % 1024 === 0) {
            const active = runtime.diagnostics.snapshot()
            assertStress(active.bufferMapping.currentMappings === 1, 'active mapping count drifted')
            assertStress(active.bufferMapping.currentSelectedBytes === 16, 'active byte count drifted')
            assertStress(active.readbackMemory.activeMappings === 0, 'general map entered readback facts')
        }

        lease.dispose()
        if (view.byteLength === 0) detachedViews += 1
        if ((index + 1) % 128 === 0) flushFakeCounters(fake, counters)
    }
    flushFakeCounters(fake, counters)
    const elapsedMs = performance.now() - startedAt

    assertStress(readBuffer.contentEpoch === 0, 'READ leases advanced content epoch')
    assertStress(writeBuffer.contentEpoch === writeLeases, 'WRITE epoch count drifted')
    assertStress(detachedViews === iterations, 'ordinary mapped views did not all detach')
    assertStress(counters.maps === iterations, 'native ordinary map count drifted')
    assertStress(counters.mappedRanges === iterations, 'ordinary mapped-range count drifted')
    assertStress(counters.unmaps === iterations, 'ordinary unmap count drifted')

    readBuffer.dispose()
    writeBuffer.dispose()
    flushFakeCounters(fake, counters)
    const terminal = terminalFacts(runtime)
    assertTerminal(terminal)
    assertStress(terminal.overwrittenOperations > 0, 'ordinary operation recorder did not overflow')
    runtime.dispose()

    return {
        leases: iterations,
        readLeases,
        writeLeases,
        detachedViews,
        elapsedMs,
        leasesPerSecond: iterations / (elapsedMs / 1_000),
        native: counters,
        terminal,
    }
}

async function stressMappedCreation(iterations) {

    const fake = createFakeGpu()
    const runtime = await createStressRuntime(fake)
    const counters = emptyNativeCounters()
    let detachedViews = 0
    const startedAt = performance.now()

    for (let index = 0; index < iterations; index++) {
        const { buffer, lease } = await runtime.createMappedBuffer({
            label: `mapped creation stress ${index}`,
            size: 16,
            usage: COPY_SRC,
        })
        const view = lease.view
        new Uint32Array(view)[0] = index
        lease.dispose()
        assertStress(buffer.contentEpoch === 1, `mapped creation ${index} epoch drifted`)
        if (view.byteLength === 0) detachedViews += 1
        buffer.dispose()
        if ((index + 1) % 128 === 0) flushFakeCounters(fake, counters)
    }
    flushFakeCounters(fake, counters)
    const elapsedMs = performance.now() - startedAt
    const terminal = terminalFacts(runtime)

    assertStress(detachedViews === iterations, 'mapped-at-creation views did not all detach')
    assertStress(counters.allocations === iterations, 'mapped allocation count drifted')
    assertStress(counters.maps === 0, 'mapped creation called mapAsync')
    assertStress(counters.mappedRanges === iterations, 'mapped creation range count drifted')
    assertStress(counters.unmaps === iterations, 'mapped creation unmap count drifted')
    assertStress(counters.destroys === iterations, 'mapped creation destroy count drifted')
    assertTerminal(terminal)
    assertStress(terminal.overwrittenOperations > 0, 'creation operation recorder did not overflow')
    runtime.dispose()

    return {
        creations: iterations,
        detachedViews,
        elapsedMs,
        creationsPerSecond: iterations / (elapsedMs / 1_000),
        native: counters,
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
    })
}

function terminalFacts(runtime) {

    const snapshot = runtime.diagnostics.snapshot()
    return {
        currentMappings: snapshot.bufferMapping.currentMappings,
        currentSelectedBytes: snapshot.bufferMapping.currentSelectedBytes,
        peakMappings: snapshot.bufferMapping.peakMappings,
        peakSelectedBytes: snapshot.bufferMapping.peakSelectedBytes,
        currentFacts: snapshot.bufferMappings.length,
        pendingOperationCount: snapshot.pendingOperations.length,
        liveResourceCount: snapshot.resources.length,
        readbackActiveMappings: snapshot.readbackMemory.activeMappings,
        retainedOperationCount: snapshot.recorder.retainedOperationCount,
        retainedIncidentCount: snapshot.recorder.retainedIncidentCount,
        retainedEvidenceBytes: snapshot.recorder.retainedEvidenceBytes,
        overwrittenOperations: snapshot.recorder.overwrittenOperations,
        lifecycleSubscriberCount: diagnosticsControllerFor(runtime).lifecycleSubscriberCount,
    }
}

function assertTerminal(facts) {

    assertStress(facts.currentMappings === 0, 'terminal mappings were retained')
    assertStress(facts.currentSelectedBytes === 0, 'terminal selected bytes were retained')
    assertStress(facts.currentFacts === 0, 'terminal mapping facts were retained')
    assertStress(facts.pendingOperationCount === 0, 'terminal pending operations were retained')
    assertStress(facts.liveResourceCount === 0, 'terminal resources were retained')
    assertStress(facts.readbackActiveMappings === 0, 'general mapping changed readback facts')
    assertStress(facts.lifecycleSubscriberCount === 0, 'terminal lifecycle subscribers were retained')
    assertStress(facts.retainedOperationCount <= 64, 'operation recorder exceeded capacity')
    assertStress(facts.retainedIncidentCount <= 8, 'incident recorder exceeded capacity')
    assertStress(facts.retainedEvidenceBytes <= 64 * 1024, 'evidence recorder exceeded byte budget')
}

function emptyNativeCounters() {

    return {
        allocations: 0,
        maps: 0,
        mappedRanges: 0,
        unmaps: 0,
        destroys: 0,
    }
}

function flushFakeCounters(fake, counters) {

    counters.allocations += fake.calls.buffers.length
    counters.maps += fake.calls.maps.length
    counters.mappedRanges += fake.calls.mappedRanges.length
    counters.unmaps += fake.calls.unmaps.length
    counters.destroys += fake.calls.bufferDestroys.length
    for (const value of Object.values(fake.calls)) {
        if (Array.isArray(value)) value.length = 0
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
