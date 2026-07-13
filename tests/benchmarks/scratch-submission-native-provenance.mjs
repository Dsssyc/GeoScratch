import os from 'node:os'
import process from 'node:process'
import { performance } from 'node:perf_hooks'
import { ScratchRuntime } from '../../packages/geoscratch/dist/scratch/runtime.js'
import { diagnosticsControllerFor } from '../../packages/geoscratch/dist/scratch/runtime-diagnostics.js'
import { createFakeGpu } from '../scratch-test-utils.js'

const iterations = positiveInteger(process.env.SCRATCH_SUBMISSION_BENCH_ITERATIONS, 250)
const rounds = positiveInteger(process.env.SCRATCH_SUBMISSION_BENCH_ROUNDS, 5)
const warmupIterations = positiveInteger(process.env.SCRATCH_SUBMISSION_BENCH_WARMUP, 50)
const manyCount = positiveInteger(process.env.SCRATCH_SUBMISSION_BENCH_MANY, 8)
const operationCapacity = 64
const incidentCapacity = 8
const evidenceByteCapacity = 64 * 1024
const captureEvidenceByteCapacity = 16 * 1024 * 1024

const profileDefinitions = Object.freeze([
    profile('effect-free-immediate', 'summary', 'effect-free'),
    profile('off-one-command-immediate', 'off', 'one-command'),
    profile('summary-one-command-immediate', 'summary', 'one-command'),
    profile('summary-many-commands-immediate', 'summary', 'many-commands'),
    profile('summary-one-queue-action-immediate', 'summary', 'one-queue-action'),
    profile('summary-many-queue-actions-immediate', 'summary', 'many-queue-actions'),
    profile('detailed-one-command-immediate', 'summary', 'one-command', {
        detailed: true,
    }),
    profile('detailed-many-commands-immediate', 'summary', 'many-commands', {
        detailed: true,
    }),
    profile('summary-one-command-deferred-observation', 'summary', 'one-command', {
        deferObservation: true,
    }),
    profile('summary-one-command-deferred-done', 'summary', 'one-command', {
        deferDone: true,
    }),
    profile(
        'summary-one-command-deferred-observation-and-done',
        'summary',
        'one-command',
        { deferObservation: true, deferDone: true }
    ),
])

const profiles = []
for (const definition of profileDefinitions) {
    profiles.push(await benchmarkProfile(definition))
}

const benchmark = {
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
        manyCount,
    },
    measurementBoundary: {
        device: 'deterministic in-process fake GPUDevice',
        issue: 'public SubmissionBuilder.submit() call until synchronous return',
        observation: 'submit return until SubmittedWork.nativeOutcome resolves',
        doneAfterObservation: 'nativeOutcome resolution until strengthened SubmittedWork.done settles',
        totalDone: 'submit call start until strengthened done settles',
        deferredObservation: 'fake error-scope Promises are manually settled after submit returns',
        deferredDone: 'fake queue-completion Promise is manually settled after nativeOutcome resolves',
        excludes: [
            'browser IPC',
            'driver execution',
            'physical GPU work',
            'physical memory residency',
            'JavaScript garbage collection guarantees',
        ],
    },
    profiles,
}

const result = {
    ...benchmark,
    verification: verifyBenchmark(benchmark),
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)

function profile(name, submissionScopes, shape, options = {}) {

    return Object.freeze({
        name,
        submissionScopes,
        shape,
        detailed: options.detailed === true,
        deferObservation: options.deferObservation === true,
        deferDone: options.deferDone === true,
    })
}

async function benchmarkProfile(definition) {

    const samples = []
    for (let round = 0; round < rounds; round++) {
        samples.push(await benchmarkRound(definition))
    }

    return {
        name: definition.name,
        policy: definition.submissionScopes,
        shape: definition.shape,
        detailed: definition.detailed,
        deferredObservation: definition.deferObservation,
        deferredDone: definition.deferDone,
        submissionsPerRound: iterations,
        verifiedRoundCount: samples.length,
        median: medianSample(samples),
        range: rangeSample(samples),
        structural: samples[0].structural,
    }
}

async function benchmarkRound(definition) {

    const fakeOptions = {
        deferErrorScopePops: false,
        deferSubmittedWorkDone: false,
    }
    const fake = createFakeGpu(fakeOptions)
    const runtime = await ScratchRuntime.create({
        gpu: fake.gpu,
        diagnostics: {
            submissionScopes: definition.submissionScopes,
            operationCapacity,
            incidentCapacity,
            evidenceByteCapacity,
        },
    })
    const fixture = await createFixture(runtime)

    fakeOptions.deferErrorScopePops = definition.deferObservation
    fakeOptions.deferSubmittedWorkDone = definition.deferDone
    const warmupSettlement = settlementCursor(fake)
    for (let index = 0; index < warmupIterations; index++) {
        await runSubmission(runtime, fixture, definition, fake, warmupSettlement)
    }

    clearFakeCalls(fake)
    const settlement = settlementCursor(fake)
    const capture = definition.detailed
        ? runtime.diagnostics.capture({
            maxOperations: iterations,
            maxDurationMs: 60_000,
            maxEvidenceBytes: captureEvidenceByteCapacity,
            nativeSubmissionDetail: 'step',
        })
        : undefined

    let issueMs = 0
    let observationMs = 0
    let doneAfterObservationMs = 0
    let totalDoneMs = 0
    const statuses = new Map()

    for (let index = 0; index < iterations; index++) {
        const startedAt = performance.now()
        const submitted = buildSubmission(runtime, fixture, definition).submit()
        const issuedAt = performance.now()

        settleObservationIfDeferred(fake, settlement, definition)
        const outcome = await submitted.nativeOutcome
        const observedAt = performance.now()
        settleDoneIfDeferred(fake, settlement, definition)
        await submitted.done
        const doneAt = performance.now()

        issueMs += issuedAt - startedAt
        observationMs += observedAt - issuedAt
        doneAfterObservationMs += doneAt - observedAt
        totalDoneMs += doneAt - startedAt
        statuses.set(outcome.status, (statuses.get(outcome.status) ?? 0) + 1)
    }

    const captureReport = capture?.stop()
    disposeFixture(fixture)
    const snapshot = runtime.diagnostics.snapshot()
    const structural = collectStructuralFacts(
        fake,
        runtime,
        snapshot,
        definition,
        captureReport,
        statuses
    )
    verifyRound(definition, structural)
    runtime.dispose()
    assertBenchmark(
        fake.errors.listenerCount('uncapturederror') === 0,
        `${definition.name} leaked the runtime uncaptured-error listener`
    )

    return {
        issueMicrosecondsPerSubmission: toMicroseconds(issueMs / iterations),
        observationMicrosecondsPerSubmission: toMicroseconds(observationMs / iterations),
        doneAfterObservationMicrosecondsPerSubmission:
            toMicroseconds(doneAfterObservationMs / iterations),
        totalDoneMicrosecondsPerSubmission: toMicroseconds(totalDoneMs / iterations),
        structural,
    }
}

async function createFixture(runtime) {

    const source = await runtime.createBuffer({
        label: 'submission benchmark source',
        size: 16,
        usage: 0x4 | 0x8,
    })
    const target = await runtime.createBuffer({
        label: 'submission benchmark target',
        size: 16,
        usage: 0x8,
    })
    const seed = runtime.createUploadCommand({
        label: 'submission benchmark seed',
        target: source.region(),
        data: new Uint32Array([ 1, 2, 3, 4 ]),
    })
    const seeded = runtime.createSubmission().upload(seed).submit()
    await seeded.done
    const copies = Array.from({ length: manyCount }, (_, index) =>
        runtime.createCopyCommand({
            label: `submission benchmark copy ${index}`,
            source: { region: source.region(), contentEpoch: 1 },
            target: target.region(),
            whenMissing: 'throw',
        })
    )
    const uploads = Array.from({ length: manyCount }, (_, index) =>
        runtime.createUploadCommand({
            label: `submission benchmark upload ${index}`,
            target: target.region(),
            data: new Uint32Array([ index, index + 1, index + 2, index + 3 ]),
        })
    )

    return { source, target, seed, copies, uploads }
}

function buildSubmission(runtime, fixture, definition) {

    const builder = runtime.createSubmission()
    switch (definition.shape) {
        case 'effect-free':
            return builder
        case 'one-command':
            return builder.copy(fixture.copies[0])
        case 'many-commands':
            for (const command of fixture.copies) builder.copy(command)
            return builder
        case 'one-queue-action':
            return builder.upload(fixture.uploads[0])
        case 'many-queue-actions':
            for (const command of fixture.uploads) builder.upload(command)
            return builder
        default:
            throw new TypeError(`Unsupported benchmark shape: ${definition.shape}`)
    }
}

async function runSubmission(runtime, fixture, definition, fake, settlement) {

    const submitted = buildSubmission(runtime, fixture, definition).submit()
    settleObservationIfDeferred(fake, settlement, definition)
    await submitted.nativeOutcome
    settleDoneIfDeferred(fake, settlement, definition)
    await submitted.done
}

function settleObservationIfDeferred(fake, cursor, definition) {

    if (!definition.deferObservation) return
    const count = expectedScopePushesPerSubmission(definition)
    for (let offset = count - 1; offset >= 0; offset--) {
        fake.errors.settlePop(cursor.nextPopIndex + offset)
    }
    cursor.nextPopIndex += count
}

function settleDoneIfDeferred(fake, cursor, definition) {

    if (!definition.deferDone || definition.shape === 'effect-free') return
    fake.readbacks.resolveQueueCompletion(cursor.nextQueueCompletionIndex)
    cursor.nextQueueCompletionIndex++
}

function settlementCursor(fake) {

    return {
        nextPopIndex: fake.errors.pendingPops.length,
        nextQueueCompletionIndex: fake.readbacks.queueCompletionRequests.length,
    }
}

function collectStructuralFacts(
    fake,
    runtime,
    snapshot,
    definition,
    captureReport,
    statuses
) {

    return {
        expectedScopePushesPerSubmission: expectedScopePushesPerSubmission(definition),
        scopePushes: countScopeCalls(fake, 'push'),
        scopePops: countScopeCalls(fake, 'pop'),
        debugPushes: fake.calls.debugGroups.filter(call => call.action === 'push').length,
        debugPops: fake.calls.debugGroups.filter(call => call.action === 'pop').length,
        queueWrites: fake.calls.queueWrites.length,
        queueSubmissions: fake.calls.queueSubmissions.length,
        copyCalls: fake.calls.copies.length,
        doneRegistrations: fake.calls.submittedWorkDoneRegistrations.length,
        pendingPopCount: fake.errors.pendingPops.filter(pop => !pop.settled).length,
        pendingQueueCompletionCount:
            fake.readbacks.queueCompletionRequests.filter(request => !request.settled).length,
        nativeScopeDepth: fake.errors.scopeDepth,
        statusCounts: Object.fromEntries(statuses),
        pendingOperationCount: snapshot.pendingOperations.length,
        liveResourceCount: snapshot.resources.length,
        currentPendingNativeObservations:
            snapshot.submissionNative.currentPendingNativeObservations,
        currentEffectfulSubmittedWork:
            snapshot.submissionNative.currentEffectfulSubmittedWork,
        retainedOperationCount: snapshot.recorder.retainedOperationCount,
        retainedIncidentCount: snapshot.recorder.retainedIncidentCount,
        retainedEvidenceBytes: snapshot.recorder.retainedEvidenceBytes,
        overwrittenOperations: snapshot.recorder.overwrittenOperations,
        activeCaptureCount: snapshot.capture.activeCount,
        lifecycleSubscriberCount: diagnosticsControllerFor(runtime).lifecycleSubscriberCount,
        ...(captureReport !== undefined ? {
            captureStopReason: captureReport.stopReason,
            captureOperationCount: captureReport.operations.length,
            captureRetainedEvidenceBytes: captureReport.retainedEvidenceBytes,
        } : {}),
    }
}

function verifyRound(definition, facts) {

    const expectedScopes = facts.expectedScopePushesPerSubmission * iterations
    const commandCount = definition.shape === 'many-commands'
        ? manyCount
        : definition.shape === 'one-command'
            ? 1
            : 0
    const queueActionCount = definition.shape === 'many-queue-actions'
        ? manyCount
        : definition.shape === 'one-queue-action'
            ? 1
            : 0
    const effectful = definition.shape !== 'effect-free'
    const expectedStatus = !effectful
        ? 'no-native-work'
        : definition.submissionScopes === 'off'
            ? 'unobserved'
            : 'observed-succeeded'

    assertBenchmark(facts.scopePushes === expectedScopes, `${definition.name} scope pushes drifted`)
    assertBenchmark(facts.scopePops === expectedScopes, `${definition.name} scope pops drifted`)
    assertBenchmark(facts.nativeScopeDepth === 0, `${definition.name} left native scopes open`)
    assertBenchmark(facts.pendingPopCount === 0, `${definition.name} left scope Promises pending`)
    assertBenchmark(
        facts.pendingQueueCompletionCount === 0,
        `${definition.name} left queue completion pending`
    )
    assertBenchmark(
        facts.statusCounts[expectedStatus] === iterations &&
            Object.keys(facts.statusCounts).length === 1,
        `${definition.name} outcome status counts drifted`
    )
    assertBenchmark(
        facts.copyCalls === commandCount * iterations,
        `${definition.name} command call count drifted`
    )
    assertBenchmark(
        facts.queueWrites === queueActionCount * iterations,
        `${definition.name} queue-action call count drifted`
    )
    assertBenchmark(
        facts.queueSubmissions === (commandCount > 0 ? iterations : 0),
        `${definition.name} queue-submit count drifted`
    )
    assertBenchmark(
        facts.doneRegistrations === (effectful ? iterations : 0),
        `${definition.name} done registration count drifted`
    )
    const expectedDebugGroups = definition.detailed ? commandCount * iterations : 0
    assertBenchmark(facts.debugPushes === expectedDebugGroups, `${definition.name} debug pushes drifted`)
    assertBenchmark(facts.debugPops === expectedDebugGroups, `${definition.name} debug pops drifted`)
    assertBenchmark(facts.pendingOperationCount === 0, `${definition.name} retained pending operations`)
    assertBenchmark(facts.liveResourceCount === 0, `${definition.name} retained live resources`)
    assertBenchmark(
        facts.currentPendingNativeObservations === 0,
        `${definition.name} retained observation owners`
    )
    assertBenchmark(
        facts.currentEffectfulSubmittedWork === 0,
        `${definition.name} retained SubmittedWork owners`
    )
    assertBenchmark(facts.activeCaptureCount === 0, `${definition.name} retained active capture`)
    assertBenchmark(facts.lifecycleSubscriberCount === 0, `${definition.name} retained subscribers`)
    assertBenchmark(
        facts.retainedOperationCount <= operationCapacity,
        `${definition.name} exceeded operation capacity`
    )
    assertBenchmark(
        facts.retainedIncidentCount === 0,
        `${definition.name} retained unexpected incidents`
    )
    assertBenchmark(
        facts.retainedEvidenceBytes <= evidenceByteCapacity,
        `${definition.name} exceeded evidence capacity`
    )

    if (definition.detailed) {
        assertBenchmark(
            facts.captureStopReason === 'operation-limit',
            `${definition.name} capture did not stop at operation limit`
        )
        assertBenchmark(
            facts.captureOperationCount === iterations,
            `${definition.name} capture operation count drifted`
        )
        assertBenchmark(
            facts.captureRetainedEvidenceBytes <= captureEvidenceByteCapacity,
            `${definition.name} capture exceeded evidence capacity`
        )
    } else {
        assertBenchmark(facts.captureStopReason === undefined, `${definition.name} created a capture`)
    }
}

function expectedScopePushesPerSubmission(definition) {

    if (definition.shape === 'effect-free' || definition.submissionScopes === 'off') return 0
    if (!definition.detailed) return 3

    if (definition.shape === 'one-command') return 4 * 3
    if (definition.shape === 'many-commands') return (manyCount + 3) * 3
    if (definition.shape === 'one-queue-action') return 3
    if (definition.shape === 'many-queue-actions') return manyCount * 3
    throw new TypeError(`Unsupported detailed benchmark shape: ${definition.shape}`)
}

function disposeFixture(fixture) {

    fixture.seed.dispose()
    for (const command of fixture.copies) command.dispose()
    for (const command of fixture.uploads) command.dispose()
    fixture.source.dispose()
    fixture.target.dispose()
}

function clearFakeCalls(fake) {

    for (const value of Object.values(fake.calls)) {
        if (Array.isArray(value)) value.length = 0
    }
    fake.readbacks.mapRequests.length = 0
    fake.readbacks.queueCompletionRequests.length = 0
}

function countScopeCalls(fake, action) {

    return fake.calls.errorScopes.filter(call => call.action === action).length
}

function medianSample(samples) {

    return Object.fromEntries(timingKeys().map(key => [
        key,
        median(samples.map(sample => sample[key])),
    ]))
}

function rangeSample(samples) {

    return Object.fromEntries(timingKeys().map(key => {
        const values = samples.map(sample => sample[key])
        return [ key, { min: Math.min(...values), max: Math.max(...values) } ]
    }))
}

function timingKeys() {

    return [
        'issueMicrosecondsPerSubmission',
        'observationMicrosecondsPerSubmission',
        'doneAfterObservationMicrosecondsPerSubmission',
        'totalDoneMicrosecondsPerSubmission',
    ]
}

function median(values) {

    const sorted = [ ...values ].sort((left, right) => left - right)
    const middle = Math.floor(sorted.length / 2)
    return sorted.length % 2 === 0
        ? (sorted[middle - 1] + sorted[middle]) / 2
        : sorted[middle]
}

function verifyBenchmark(benchmark) {

    assertBenchmark(
        benchmark.profiles.length === profileDefinitions.length,
        'benchmark profile count drifted'
    )
    assertBenchmark(
        benchmark.profiles.every(profileResult => profileResult.verifiedRoundCount === rounds),
        'benchmark round count drifted'
    )
    assertBenchmark(
        benchmark.profiles.every(profileResult => timingKeys().every(key =>
            Number.isFinite(profileResult.median[key]) && profileResult.median[key] >= 0
        )),
        'benchmark emitted an invalid timing value'
    )

    return {
        status: 'passed',
        verifiedProfileCount: benchmark.profiles.length,
        verifiedRoundCount: benchmark.profiles.length * rounds,
        structuralThresholdsEnforced: true,
        timingThresholdsEnforced: false,
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
