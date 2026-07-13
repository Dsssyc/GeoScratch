import os from 'node:os'
import process from 'node:process'
import { performance } from 'node:perf_hooks'
import { ScratchDiagnosticError } from '../../packages/geoscratch/dist/scratch/diagnostics.js'
import { ScratchRuntime } from '../../packages/geoscratch/dist/scratch/runtime.js'
import { diagnosticsControllerFor } from '../../packages/geoscratch/dist/scratch/runtime-diagnostics.js'
import { createFakeGpu } from '../scratch-test-utils.js'

const summaryIterations = positiveInteger(
    process.env.SCRATCH_SUBMISSION_STRESS_SUMMARY,
    20_000
)
const offIterations = positiveInteger(
    process.env.SCRATCH_SUBMISSION_STRESS_OFF,
    20_000
)
const allowShort = process.env.SCRATCH_SUBMISSION_STRESS_ALLOW_SHORT === '1'
const operationCapacity = 64
const incidentCapacity = 8
const evidenceByteCapacity = 64 * 1024

if (!allowShort) {
    assertStress(summaryIterations >= 20_000, 'summary stress must run at least 20,000 submissions')
    assertStress(offIterations >= 20_000, 'off stress must run at least 20,000 submissions')
}

const summary = await stressSubmissionMode('summary', summaryIterations)
const off = await stressSubmissionMode('off', offIterations)
const delayedBudget = await stressDelayedObservationBudget()
const ignoredPromises = await stressIgnoredRejectingDone()
const finiteDetailed = await stressFiniteDetailedCapture()

const result = {
    schemaVersion: 1,
    environment: {
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
        cpu: os.cpus()[0]?.model ?? 'unknown',
        logicalCpuCount: os.cpus().length,
        summaryIterations,
        offIterations,
    },
    measurementBoundary: {
        device: 'deterministic in-process fake GPUDevice',
        summary: 'synchronous upload submission through nativeOutcome and strengthened done',
        off: 'synchronous upload submission with explicit unobserved provenance through done',
        delayedBudget: 'one deferred summary owner plus a second pre-native reservation failure',
        ignoredPromises: 'rejecting done/native outcome are not consumed by application code',
        finiteDetailed: 'one operation-limited detailed copy followed by the summary path',
        recorder: `${operationCapacity} operations / ${incidentCapacity} incidents / ${evidenceByteCapacity} serialized evidence bytes`,
        excludes: [ 'browser IPC', 'driver work', 'physical GPU residency' ],
    },
    summary,
    off,
    delayedBudget,
    ignoredPromises,
    finiteDetailed,
    verification: {
        status: 'passed',
        minimumsEnforced: !allowShort,
        minimumSummarySubmissions: allowShort ? 1 : 20_000,
        minimumOffSubmissions: allowShort ? 1 : 20_000,
        terminalPendingNativeObservations:
            summary.terminal.currentPendingNativeObservations +
            off.terminal.currentPendingNativeObservations +
            delayedBudget.terminal.currentPendingNativeObservations +
            ignoredPromises.terminal.currentPendingNativeObservations +
            finiteDetailed.terminal.currentPendingNativeObservations,
        terminalEffectfulSubmittedWork:
            summary.terminal.currentEffectfulSubmittedWork +
            off.terminal.currentEffectfulSubmittedWork +
            delayedBudget.terminal.currentEffectfulSubmittedWork +
            ignoredPromises.terminal.currentEffectfulSubmittedWork +
            finiteDetailed.terminal.currentEffectfulSubmittedWork,
        terminalLifecycleSubscribers:
            summary.terminal.lifecycleSubscriberCount +
            off.terminal.lifecycleSubscriberCount +
            delayedBudget.terminal.lifecycleSubscriberCount +
            ignoredPromises.terminal.lifecycleSubscriberCount +
            finiteDetailed.terminal.lifecycleSubscriberCount,
        unhandledRejections: ignoredPromises.unhandledRejections.length,
    },
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)

async function stressSubmissionMode(mode, iterations) {

    const fake = createFakeGpu()
    const runtime = await createStressRuntime(fake, {
        submissionScopes: mode,
    })
    const target = await runtime.createBuffer({
        label: `${mode} stress target`,
        size: 16,
        usage: 0x8,
    })
    const upload = runtime.createUploadCommand({
        label: `${mode} stress upload`,
        target: target.region(),
        data: new Uint32Array([ 1, 2, 3, 4 ]),
    })
    const counters = emptyCounters()
    clearFakeCalls(fake)
    const startedAt = performance.now()

    for (let index = 0; index < iterations; index++) {
        const submitted = runtime.createSubmission().upload(upload).submit()
        const outcome = await submitted.nativeOutcome
        await submitted.done
        assertStress(
            outcome.status === (mode === 'summary' ? 'observed-succeeded' : 'unobserved'),
            `${mode} outcome ${index} drifted to ${outcome.status}`
        )
        assertStress(outcome.mode === mode, `${mode} outcome mode ${index} drifted`)
        if ((index + 1) % 128 === 0) flushFakeCounters(fake, counters)
    }
    flushFakeCounters(fake, counters)
    const elapsedMs = performance.now() - startedAt

    upload.dispose()
    target.dispose()
    const terminal = terminalFacts(runtime, fake)
    assertStress(counters.queueWrites === iterations, `${mode} queue-write count drifted`)
    assertStress(counters.queueCompletionRegistrations === iterations, `${mode} done registrations drifted`)
    const expectedScopes = mode === 'summary' ? iterations * 3 : 0
    assertStress(counters.scopePushes === expectedScopes, `${mode} scope-push count drifted`)
    assertStress(counters.scopePops === expectedScopes, `${mode} scope-pop count drifted`)
    assertTerminal(runtime, fake, terminal, {
        requireOverflow: iterations > operationCapacity,
    })
    const listenersBeforeDispose = fake.errors.listenerCount('uncapturederror')
    runtime.dispose()
    const listenersAfterDispose = fake.errors.listenerCount('uncapturederror')
    assertStress(listenersBeforeDispose === 1, `${mode} runtime listener ownership drifted`)
    assertStress(listenersAfterDispose === 0, `${mode} runtime listener leaked after disposal`)

    return {
        mode,
        submissions: iterations,
        elapsedMs,
        submissionsPerSecond: iterations / (elapsedMs / 1_000),
        native: counters,
        terminal,
        listenersBeforeDispose,
        listenersAfterDispose,
    }
}

async function stressDelayedObservationBudget() {

    const fakeOptions = { deferErrorScopePops: false }
    const fake = createFakeGpu(fakeOptions)
    const runtime = await createStressRuntime(fake, {
        maxPendingNativeObservations: 1,
    })
    const target = await runtime.createBuffer({ size: 16, usage: 0x8 })
    const upload = runtime.createUploadCommand({
        target: target.region(),
        data: new Uint32Array([ 5, 6, 7, 8 ]),
    })
    clearFakeCalls(fake)
    fakeOptions.deferErrorScopePops = true

    const first = runtime.createSubmission().upload(upload).submit()
    const pending = runtime.diagnostics.snapshot().submissionNative
    let budgetFailure
    try {
        runtime.createSubmission().upload(upload).submit()
    } catch (error) {
        budgetFailure = error
    }

    assertStress(budgetFailure instanceof ScratchDiagnosticError, 'budget failure was not structured')
    assertStress(
        budgetFailure.diagnostic.code === 'SCRATCH_SUBMISSION_NATIVE_OBSERVATION_BUDGET_EXCEEDED',
        `budget failure code drifted to ${budgetFailure.diagnostic.code}`
    )
    assertStress(pending.currentPendingNativeObservations === 1, 'deferred owner was not current')
    assertStress(fake.calls.queueWrites.length === 1, 'budget failure reached a second queue action')
    assertStress(fake.errors.pendingPops.length === 3, 'deferred summary pop count drifted')

    settlePendingPopsReverse(fake)
    const outcome = await first.nativeOutcome
    await first.done
    fakeOptions.deferErrorScopePops = false
    assertStress(outcome.status === 'observed-succeeded', 'deferred observation did not succeed')
    assertStress(target.contentEpoch === 1, 'budget failure committed a logical write')

    upload.dispose()
    target.dispose()
    const terminal = terminalFacts(runtime, fake)
    assertTerminal(runtime, fake, terminal, { requireOverflow: false })
    const incident = runtime.diagnostics.incidents({
        diagnosticCode: 'SCRATCH_SUBMISSION_NATIVE_OBSERVATION_BUDGET_EXCEEDED',
    })[0]
    assertStress(incident !== undefined, 'budget incident was not retained')
    runtime.dispose()
    assertStress(fake.errors.listenerCount('uncapturederror') === 0, 'budget runtime listener leaked')

    return {
        pendingBeforeSettlement: pending,
        budgetDiagnosticCode: budgetFailure.diagnostic.code,
        queueWritesBeforeSettlement: 1,
        deferredPopCount: 3,
        settledOutcome: outcome,
        incidentId: incident.id,
        terminal,
    }
}

async function stressIgnoredRejectingDone() {

    const fake = createFakeGpu()
    const runtime = await createStressRuntime(fake)
    const target = await runtime.createBuffer({ size: 16, usage: 0x8 })
    const upload = runtime.createUploadCommand({
        target: target.region(),
        data: new Uint32Array([ 9, 10, 11, 12 ]),
    })
    const unhandledRejections = []
    const onUnhandledRejection = reason => unhandledRejections.push(serializeReason(reason))
    process.on('unhandledRejection', onUnhandledRejection)

    try {
        fake.errors.failNext('writeBuffer', 'validation', new Error('ignored submission validation'))
        runtime.createSubmission().upload(upload).submit()
        await waitForSubmissionTerminal(runtime)
        await nextTurn()
        await nextTurn()

        assertStress(unhandledRejections.length === 0, 'ignored done produced unhandled rejection')
        assertStress(target.state === 'indeterminate', 'ignored failed write stayed ready')
        assertStress(target.contentEpoch === 1, 'ignored failed write rolled back its epoch')

        const recovery = runtime.createSubmission().upload(upload).submit()
        const recoveryOutcome = await recovery.nativeOutcome
        await recovery.done
        assertStress(recoveryOutcome.status === 'observed-succeeded', 'recovery observation failed')
        assertStress(target.state === 'ready', 'recovery write did not restore ready state')
        assertStress(target.contentEpoch === 2, 'recovery write did not advance a new epoch')
    } finally {
        process.off('unhandledRejection', onUnhandledRejection)
    }

    upload.dispose()
    target.dispose()
    const terminal = terminalFacts(runtime, fake)
    assertTerminal(runtime, fake, terminal, { requireOverflow: false })
    const failureIncidentCount = runtime.diagnostics.incidents({
        diagnosticCode: 'SCRATCH_SUBMISSION_NATIVE_VALIDATION_FAILED',
    }).length
    assertStress(failureIncidentCount === 1, 'ignored failure incident count drifted')
    runtime.dispose()
    assertStress(fake.errors.listenerCount('uncapturederror') === 0, 'ignored runtime listener leaked')

    return {
        ignoredApplicationPromiseCount: 2,
        unhandledRejections,
        failureIncidentCount,
        recoveredState: 'ready',
        recoveredContentEpoch: 2,
        terminal,
    }
}

async function stressFiniteDetailedCapture() {

    const fake = createFakeGpu()
    const runtime = await createStressRuntime(fake)
    const source = await runtime.createBuffer({ size: 16, usage: 0x4 | 0x8 })
    const target = await runtime.createBuffer({ size: 16, usage: 0x8 })
    const upload = runtime.createUploadCommand({
        target: source.region(),
        data: new Uint32Array([ 13, 14, 15, 16 ]),
    })
    const seeded = runtime.createSubmission().upload(upload).submit()
    await seeded.done
    const copy = runtime.createCopyCommand({
        source: { region: source.region(), contentEpoch: 1 },
        target: target.region(),
        whenMissing: 'throw',
    })
    const capture = runtime.diagnostics.capture({
        maxOperations: 1,
        maxDurationMs: 60_000,
        maxEvidenceBytes: 64 * 1024,
        nativeSubmissionDetail: 'step',
    })

    clearFakeCalls(fake)
    const detailed = runtime.createSubmission().copy(copy).submit()
    const detailedOutcome = await detailed.nativeOutcome
    await detailed.done
    const detailedScopePushes = countScopeCalls(fake, 'push')
    const detailedDebugPushes = fake.calls.debugGroups.filter(call => call.action === 'push').length
    const captureReport = capture.stop()

    clearFakeCalls(fake)
    const summary = runtime.createSubmission().copy(copy).submit()
    const summaryOutcome = await summary.nativeOutcome
    await summary.done
    const summaryScopePushes = countScopeCalls(fake, 'push')
    const summaryDebugPushes = fake.calls.debugGroups.filter(call => call.action === 'push').length

    assertStress(detailedOutcome.mode === 'detailed', 'finite capture did not enable detailed mode')
    assertStress(detailedScopePushes === 12, 'one detailed copy did not use four scope bundles')
    assertStress(detailedDebugPushes === 1, 'detailed command debug group count drifted')
    assertStress(captureReport.stopReason === 'operation-limit', 'capture did not stop at operation limit')
    assertStress(captureReport.operations.length === 1, 'capture retained wrong operation count')
    assertStress(summaryOutcome.mode === 'summary', 'stopped capture did not restore summary mode')
    assertStress(summaryScopePushes === 3, 'summary copy scope count was not constant')
    assertStress(summaryDebugPushes === 0, 'summary mode retained detailed debug groups')

    copy.dispose()
    upload.dispose()
    source.dispose()
    target.dispose()
    const terminal = terminalFacts(runtime, fake)
    assertTerminal(runtime, fake, terminal, { requireOverflow: false })
    assertStress(terminal.activeCaptureCount === 0, 'finite capture remained active')
    runtime.dispose()
    assertStress(fake.errors.listenerCount('uncapturederror') === 0, 'capture runtime listener leaked')

    return {
        detailed: {
            outcomeMode: detailedOutcome.mode,
            scopePushes: detailedScopePushes,
            debugPushes: detailedDebugPushes,
        },
        capture: {
            stopReason: captureReport.stopReason,
            operationCount: captureReport.operations.length,
            retainedEvidenceBytes: captureReport.retainedEvidenceBytes,
        },
        restoredSummary: {
            outcomeMode: summaryOutcome.mode,
            scopePushes: summaryScopePushes,
            debugPushes: summaryDebugPushes,
        },
        terminal,
    }
}

async function createStressRuntime(fake, diagnostics = {}) {

    return ScratchRuntime.create({
        gpu: fake.gpu,
        diagnostics: {
            operationCapacity,
            incidentCapacity,
            evidenceByteCapacity,
            ...diagnostics,
        },
    })
}

function terminalFacts(runtime, fake) {

    const snapshot = runtime.diagnostics.snapshot()
    return {
        pendingOperationCount: snapshot.pendingOperations.length,
        liveResourceCount: snapshot.resources.length,
        currentPendingNativeObservations:
            snapshot.submissionNative.currentPendingNativeObservations,
        peakPendingNativeObservations:
            snapshot.submissionNative.peakPendingNativeObservations,
        currentEffectfulSubmittedWork:
            snapshot.submissionNative.currentEffectfulSubmittedWork,
        retainedOperationCount: snapshot.recorder.retainedOperationCount,
        retainedIncidentCount: snapshot.recorder.retainedIncidentCount,
        retainedEvidenceBytes: snapshot.recorder.retainedEvidenceBytes,
        overwrittenOperations: snapshot.recorder.overwrittenOperations,
        omittedRecords: snapshot.recorder.omittedRecords,
        activeCaptureCount: snapshot.capture.activeCount,
        lifecycleSubscriberCount: diagnosticsControllerFor(runtime).lifecycleSubscriberCount,
        nativeScopeDepth: fake.errors.scopeDepth,
    }
}

function assertTerminal(runtime, fake, facts, { requireOverflow }) {

    assertStress(runtime.isDisposed === false, 'runtime disposed before terminal inspection')
    assertStress(facts.pendingOperationCount === 0, 'terminal pending operations were retained')
    assertStress(facts.liveResourceCount === 0, 'terminal resources were retained')
    assertStress(facts.currentPendingNativeObservations === 0, 'terminal observation owner was retained')
    assertStress(facts.currentEffectfulSubmittedWork === 0, 'terminal SubmittedWork owner was retained')
    assertStress(facts.lifecycleSubscriberCount === 0, 'terminal lifecycle subscriber was retained')
    assertStress(facts.nativeScopeDepth === 0, 'native error scope was left open')
    assertStress(facts.activeCaptureCount === 0, 'diagnostic capture was left active')
    assertStress(facts.retainedOperationCount <= operationCapacity, 'operation recorder exceeded capacity')
    assertStress(facts.retainedIncidentCount <= incidentCapacity, 'incident recorder exceeded capacity')
    assertStress(facts.retainedEvidenceBytes <= evidenceByteCapacity, 'evidence recorder exceeded byte budget')
    if (requireOverflow) {
        assertStress(facts.overwrittenOperations > 0, 'operation recorder did not overflow')
    }
    assertStress(fake.errors.pendingPops.every(pop => pop.settled), 'native scope Promise remained unsettled')
}

function emptyCounters() {

    return {
        scopePushes: 0,
        scopePops: 0,
        queueWrites: 0,
        queueCompletionRegistrations: 0,
    }
}

function flushFakeCounters(fake, counters) {

    counters.scopePushes += countScopeCalls(fake, 'push')
    counters.scopePops += countScopeCalls(fake, 'pop')
    counters.queueWrites += fake.calls.queueWrites.length
    counters.queueCompletionRegistrations += fake.calls.submittedWorkDoneRegistrations.length
    clearFakeCalls(fake)
}

function countScopeCalls(fake, action) {

    return fake.calls.errorScopes.filter(call => call.action === action).length
}

function clearFakeCalls(fake) {

    for (const value of Object.values(fake.calls)) {
        if (Array.isArray(value)) value.length = 0
    }
    fake.readbacks.mapRequests.length = 0
    fake.readbacks.queueCompletionRequests.length = 0
}

function settlePendingPopsReverse(fake) {

    const pops = fake.errors.pendingPops
    for (let index = pops.length - 1; index >= 0; index--) {
        if (!pops[index].settled) fake.errors.settlePop(index)
    }
}

async function waitForSubmissionTerminal(runtime) {

    for (let attempt = 0; attempt < 100; attempt++) {
        const facts = runtime.diagnostics.snapshot().submissionNative
        if (
            facts.currentPendingNativeObservations === 0 &&
            facts.currentEffectfulSubmittedWork === 0
        ) return
        await nextTurn()
    }
    throw new Error('ignored submission did not settle to terminal ownership')
}

function nextTurn() {

    return new Promise(resolve => setImmediate(resolve))
}

function serializeReason(reason) {

    return {
        name: reason?.name ?? 'unknown',
        message: reason?.message ?? String(reason),
        diagnosticCode: reason?.diagnostic?.code,
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
