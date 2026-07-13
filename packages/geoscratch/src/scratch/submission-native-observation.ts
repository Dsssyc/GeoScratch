import {
    createReadbackNativeOutcome,
    createSubmissionNativeOutcome,
    serializeNativeGpuError,
} from './gpu-operation.js'
import { diagnosticsControllerFor } from './runtime-diagnostics.js'
import type {
    GpuNativeErrorCategory,
    ScratchGpuIncidentReport,
    ScratchGpuReadbackOperationTarget,
    ScratchReadbackNativeOutcome,
    ScratchReadbackNativeOutcomeFact,
    ScratchReadbackNativeStage,
    ScratchSubmissionNativeLocation,
    ScratchSubmissionNativeOutcome,
    ScratchSubmissionNativeOutcomeFact,
    ScratchSubmissionNativeOutcomeMode,
    ScratchSubmissionNativeStage,
} from './gpu-operation.js'
import type {
    ScratchPendingGpuOperation,
    ScratchRuntimeLifecycleChange,
    ScratchSubmissionNativeObservationReservation,
} from './runtime-diagnostics.js'
import type { ScratchRuntime } from './runtime.js'

type ScopeFilter = 'validation' | 'internal' | 'out-of-memory'
const MAX_RETAINED_SUBMISSION_FAILURES = 64

export type SubmissionNativeIssue = Readonly<{
    stage: ScratchSubmissionNativeStage
    location: ScratchSubmissionNativeLocation
}>

export type BeginSubmissionNativeObservationInput = Readonly<{
    runtime: ScratchRuntime
    submissionId: string
    effectful: boolean
    plan: readonly SubmissionNativeIssue[]
}>

export type SubmissionNativeObservation = Readonly<{
    mode: ScratchSubmissionNativeOutcomeMode
    outcome: Promise<ScratchSubmissionNativeOutcome>
    settlement: Promise<SubmissionNativeSettlement>
    issue<T>(
        stage: ScratchSubmissionNativeStage,
        location: ScratchSubmissionNativeLocation,
        issue: () => T
    ): T
    finish(): void
}>

export type SubmissionNativePrimaryFailure = Readonly<{
    fact: ScratchSubmissionNativeOutcomeFact & Readonly<{ diagnosticCode: string }>
    issueOrdinal: number
    cause?: unknown
    incident?: ScratchGpuIncidentReport
}>

export type SubmissionNativeSettlement = Readonly<{
    outcome: ScratchSubmissionNativeOutcome
    primaryFailure?: SubmissionNativePrimaryFailure
}>

export type BeginReadbackNativeObservationInput = Readonly<{
    runtime: ScratchRuntime
    target: ScratchGpuReadbackOperationTarget
    plan: readonly ScratchReadbackNativeStage[]
}>

export type ReadbackNativeObservation = Readonly<{
    mode: ScratchSubmissionNativeOutcomeMode
    outcome: Promise<ScratchReadbackNativeOutcome>
    settlement: Promise<ReadbackNativeSettlement>
    issue<T>(stage: ScratchReadbackNativeStage, issue: () => T): T
    finish(): void
}>

export type ReadbackNativePrimaryFailure = Readonly<{
    fact: ScratchReadbackNativeOutcomeFact & Readonly<{ diagnosticCode: string }>
    issueOrdinal: number
    cause?: unknown
    incident?: ScratchGpuIncidentReport
}>

export type ReadbackNativeSettlement = Readonly<{
    outcome: ScratchReadbackNativeOutcome
    primaryFailure?: ReadbackNativePrimaryFailure
}>

type SubmissionObservedFailure = Readonly<{
    fact: ScratchSubmissionNativeOutcomeFact & Readonly<{ diagnosticCode: string }>
    issueOrdinal: number
    cause?: unknown
}>

type ScopePromiseObservation =
    | Readonly<{ status: 'fulfilled', value: GPUError | null }>
    | Readonly<{ status: 'rejected', reason: unknown }>
    | Readonly<{ status: 'invalid', reason: TypeError }>

type PendingScopeObservation = Readonly<{
    filter: ScopeFilter
    observation: Promise<ScopePromiseObservation>
}>

type ScopeBundle<Location = ScratchSubmissionNativeLocation> = {
    stage: ScratchSubmissionNativeStage
    location: Location
    issueOrdinal: number
    boundaryFailures: unknown[]
    pushed: ScopeFilter[]
    observations: PendingScopeObservation[]
    isClosed: boolean
}

type ObservationState = {
    input: BeginSubmissionNativeObservationInput
    mode: ScratchSubmissionNativeOutcomeMode
    operation: ScratchPendingGpuOperation
    reservation?: ScratchSubmissionNativeObservationReservation
    planKeys: Set<string>
    issueOrdinals: Map<string, number>
    issuedKeys: Set<string>
    issuedLocations: ScratchSubmissionNativeLocation[]
    issuedLocationKeys: Set<string>
    bundles: ScopeBundle<ScratchSubmissionNativeLocation>[]
    synchronousFailures: SubmissionObservedFailure[]
    summaryBundle?: ScopeBundle
    lifecycleFailure?: SubmissionObservedFailure
    unsubscribeLifecycle: () => void
    isFinished: boolean
}

type ReadbackObservedFailure = Readonly<{
    fact: ScratchReadbackNativeOutcomeFact & Readonly<{ diagnosticCode: string }>
    issueOrdinal: number
    cause?: unknown
}>

type ReadbackObservationState = {
    input: BeginReadbackNativeObservationInput
    mode: ScratchSubmissionNativeOutcomeMode
    operation: ScratchPendingGpuOperation
    reservation?: ScratchSubmissionNativeObservationReservation
    plan: Set<ScratchReadbackNativeStage>
    issueOrdinals: Map<ScratchReadbackNativeStage, number>
    issued: Set<ScratchReadbackNativeStage>
    bundles: ScopeBundle<undefined>[]
    synchronousFailures: ReadbackObservedFailure[]
    summaryBundle?: ScopeBundle<undefined>
    lifecycleFailure?: ReadbackObservedFailure
    unsubscribeLifecycle: () => void
    isFinished: boolean
}

export function beginSubmissionNativeObservation(
    input: BeginSubmissionNativeObservationInput
): SubmissionNativeObservation {

    input.runtime.assertActive()
    assertObservationInput(input)
    const controller = diagnosticsControllerFor(input.runtime)
    const mode = controller.submissionNativeObservationMode()
    const summaryLocation = submissionLocation(input.submissionId)

    if (!input.effectful) {
        return createEffectFreeObservation(input.submissionId, mode)
    }

    const target = Object.freeze({
        kind: 'submission' as const,
        submissionId: input.submissionId,
    })
    const reservation = mode === 'off'
        ? undefined
        : controller.reserveSubmissionNativeObservation(target)
    let operation: ScratchPendingGpuOperation
    try {
        operation = controller.beginOperation({
            kind: 'submission-native-observation',
            target,
            descriptorSummary: {
                mode,
                issueCount: input.plan.length,
            },
            fullDescriptor: {
                mode,
                plan: input.plan,
            },
            nativeLabel: `scratch:${input.submissionId}`,
        })
    } catch (error) {
        reservation?.release()
        throw error
    }

    const state: ObservationState = {
        input: Object.freeze({
            ...input,
            plan: Object.freeze(input.plan.map(item => Object.freeze({
                stage: item.stage,
                location: Object.freeze({ ...item.location }),
            }))),
        }),
        mode,
        operation,
        ...(reservation !== undefined ? { reservation } : {}),
        planKeys: new Set(input.plan.map(issueKey)),
        issueOrdinals: new Map(input.plan.map((issue, issueOrdinal) => [
            issueKey(issue),
            issueOrdinal,
        ])),
        issuedKeys: new Set(),
        issuedLocations: [],
        issuedLocationKeys: new Set(),
        bundles: [],
        synchronousFailures: [],
        unsubscribeLifecycle: () => {},
        isFinished: false,
    }

    if (mode !== 'off') {
        state.unsubscribeLifecycle = controller.subscribeLifecycle(change => {
            state.lifecycleFailure = lifecycleFailure(input.runtime, input.submissionId, change)
        })
    }
    if (mode === 'summary') {
        const bundle = openScopeBundle(
            input.runtime.device,
            'scope-settlement',
            summaryLocation,
            0
        )
        state.summaryBundle = bundle
        state.bundles.push(bundle)
    }

    let resolveSettlement!: (settlement: SubmissionNativeSettlement) => void
    const settlement = new Promise<SubmissionNativeSettlement>(resolve => {
        resolveSettlement = resolve
    })
    const outcome = settlement.then(result => result.outcome)
    const observation: SubmissionNativeObservation = Object.freeze({
        mode,
        outcome,
        settlement,
        issue<T>(
            stage: ScratchSubmissionNativeStage,
            location: ScratchSubmissionNativeLocation,
            issue: () => T
        ): T {

            if (state.isFinished) {
                throw new TypeError('Submission native observation is already finished.')
            }
            const key = issueKey({ stage, location })
            if (!state.planKeys.has(key)) {
                throw new TypeError('Submission native issue is not present in the snapshotted plan.')
            }
            if (state.issuedKeys.has(key)) {
                throw new TypeError('Submission native issue was already executed.')
            }
            const issueOrdinal = state.issueOrdinals.get(key)
            if (issueOrdinal === undefined) {
                throw new TypeError('Submission native issue is missing its snapshotted ordinal.')
            }
            state.issuedKeys.add(key)
            retainIssuedLocation(state, location)

            const bundle = mode === 'detailed'
                ? openScopeBundle(input.runtime.device, stage, location, issueOrdinal)
                : undefined
            if (bundle !== undefined) state.bundles.push(bundle)
            try {
                return issue()
            } catch (cause) {
                state.synchronousFailures.push(observedFailure(
                    stage,
                    location,
                    issueOrdinal,
                    'native-exception',
                    'SCRATCH_SUBMISSION_NATIVE_EXCEPTION',
                    cause
                ))
                throw cause
            } finally {
                if (bundle !== undefined) closeScopeBundle(input.runtime.device, bundle)
            }
        },
        finish() {

            if (state.isFinished) return
            state.isFinished = true
            if (state.summaryBundle !== undefined) {
                closeScopeBundle(input.runtime.device, state.summaryBundle)
            }
            void settleObservation(state).then(resolveSettlement)
        },
    })

    return observation
}

export function beginReadbackNativeObservation(
    input: BeginReadbackNativeObservationInput
): ReadbackNativeObservation {

    input.runtime.assertActive()
    assertReadbackObservationInput(input)
    const controller = diagnosticsControllerFor(input.runtime)
    const mode = controller.submissionNativeObservationMode()
    const reservation = mode === 'off'
        ? undefined
        : controller.reserveReadbackNativeObservation(input.target)
    let operation: ScratchPendingGpuOperation
    try {
        operation = controller.beginOperation({
            kind: 'readback-native-observation',
            target: input.target,
            descriptorSummary: {
                mode,
                issueCount: input.plan.length,
            },
            fullDescriptor: {
                mode,
                plan: input.plan,
            },
            nativeLabel: `scratch:${input.target.readbackId}`,
        })
    } catch (error) {
        reservation?.release()
        throw error
    }

    const state: ReadbackObservationState = {
        input: Object.freeze({
            ...input,
            target: Object.freeze({ ...input.target }),
            plan: Object.freeze([ ...input.plan ]),
        }),
        mode,
        operation,
        ...(reservation !== undefined ? { reservation } : {}),
        plan: new Set(input.plan),
        issueOrdinals: new Map(input.plan.map((stage, ordinal) => [ stage, ordinal ])),
        issued: new Set(),
        bundles: [],
        synchronousFailures: [],
        unsubscribeLifecycle: () => {},
        isFinished: false,
    }
    if (mode !== 'off') {
        state.unsubscribeLifecycle = controller.subscribeLifecycle(change => {
            state.lifecycleFailure = readbackLifecycleFailure(input.runtime, change)
        })
    }
    if (mode === 'summary') {
        const bundle = openScopeBundle(
            input.runtime.device,
            'scope-settlement',
            undefined,
            0
        )
        state.summaryBundle = bundle
        state.bundles.push(bundle)
    }

    let resolveSettlement!: (settlement: ReadbackNativeSettlement) => void
    const settlement = new Promise<ReadbackNativeSettlement>(resolve => {
        resolveSettlement = resolve
    })
    const outcome = settlement.then(result => result.outcome)
    return Object.freeze({
        mode,
        outcome,
        settlement,
        issue<T>(stage: ScratchReadbackNativeStage, issue: () => T): T {

            if (state.isFinished) {
                throw new TypeError('Readback native observation is already finished.')
            }
            if (!state.plan.has(stage)) {
                throw new TypeError('Readback native issue is not present in the snapshotted plan.')
            }
            if (state.issued.has(stage)) {
                throw new TypeError('Readback native issue was already executed.')
            }
            const issueOrdinal = state.issueOrdinals.get(stage)
            if (issueOrdinal === undefined) {
                throw new TypeError('Readback native issue is missing its snapshotted ordinal.')
            }
            state.issued.add(stage)
            const bundle = mode === 'detailed'
                ? openScopeBundle(input.runtime.device, stage, undefined, issueOrdinal)
                : undefined
            if (bundle !== undefined) state.bundles.push(bundle)
            try {
                return issue()
            } catch (cause) {
                state.synchronousFailures.push(readbackObservedFailure(
                    stage,
                    issueOrdinal,
                    'native-exception',
                    'SCRATCH_READBACK_NATIVE_EXCEPTION',
                    cause
                ))
                throw cause
            } finally {
                if (bundle !== undefined) closeScopeBundle(input.runtime.device, bundle)
            }
        },
        finish() {

            if (state.isFinished) return
            state.isFinished = true
            if (state.summaryBundle !== undefined) {
                closeScopeBundle(input.runtime.device, state.summaryBundle)
            }
            void settleReadbackObservation(state).then(resolveSettlement)
        },
    })
}

function createEffectFreeObservation(
    submissionId: string,
    mode: ScratchSubmissionNativeOutcomeMode
): SubmissionNativeObservation {

    const publicOutcome = createSubmissionNativeOutcome(submissionId, {
        mode,
        status: 'no-native-work',
        locations: [],
        outcomes: [],
    })
    const settlement = Promise.resolve(Object.freeze({ outcome: publicOutcome }))
    const outcome = settlement.then(result => result.outcome)
    let isFinished = false
    return Object.freeze({
        mode,
        outcome,
        settlement,
        issue<T>(
            _stage: ScratchSubmissionNativeStage,
            _location: ScratchSubmissionNativeLocation,
            issue: () => T
        ): T {

            if (isFinished) throw new TypeError('Submission native observation is already finished.')
            return issue()
        },
        finish() {

            isFinished = true
        },
    })
}

async function settleObservation(
    state: ObservationState
): Promise<SubmissionNativeSettlement> {

    const controller = diagnosticsControllerFor(state.input.runtime)
    try {
        const scopedFailures = (await Promise.all(
            state.bundles.map(settleScopeBundle)
        )).flat()
        const failures = [
            ...state.synchronousFailures,
            ...scopedFailures,
            ...(state.lifecycleFailure !== undefined ? [ state.lifecycleFailure ] : []),
        ]
        const publicOutcome = createPublicOutcome(state, failures)
        const retainedFailures = retainOrderedSubmissionFailures(failures)
        const primary = retainedFailures[0]
        const record = controller.completeOperation(state.operation, {
            status: primary === undefined ? 'succeeded' : 'failed',
            ...(primary !== undefined
                ? { nativeErrorCategory: primary.fact.nativeErrorCategory }
                : {}),
            nativeOutcome: {
                mode: publicOutcome.mode,
                status: publicOutcome.status,
                locations: publicOutcome.locations,
                outcomes: publicOutcome.outcomes,
                omittedLocationCount: publicOutcome.omittedLocationCount,
                omittedOutcomeCount: publicOutcome.omittedOutcomeCount,
            },
        })

        let incident: ScratchGpuIncidentReport | undefined
        if (primary !== undefined) {
            incident = controller.recordIncident({
                kind: 'submission-failure',
                diagnosticCode: primary.fact.diagnosticCode,
                nativeErrorCategory: primary.fact.nativeErrorCategory,
                attribution: state.mode === 'summary'
                    ? 'enclosing-operation-family'
                    : 'exact-operation',
                target: state.operation.target,
                operationId: state.operation.id,
                triggerOperation: record,
                failureStage: primary.fact.stage,
                ...(primary.fact.nativeError !== undefined
                    ? { nativeError: primary.fact.nativeError }
                    : {}),
                outcomes: retainedFailures.map(failure => ({
                    stage: failure.fact.stage,
                    diagnosticCode: failure.fact.diagnosticCode,
                    nativeErrorCategory: failure.fact.nativeErrorCategory,
                    location: failure.fact.location,
                    ...(failure.fact.nativeError !== undefined
                        ? { nativeError: failure.fact.nativeError }
                        : {}),
                })),
                omittedOutcomeCount: Math.max(0, failures.length - retainedFailures.length),
            })
        }
        return Object.freeze({
            outcome: publicOutcome,
            ...(primary !== undefined ? {
                primaryFailure: Object.freeze({
                    fact: primary.fact,
                    issueOrdinal: primary.issueOrdinal,
                    ...(primary.cause !== undefined ? { cause: primary.cause } : {}),
                    ...(incident !== undefined ? { incident } : {}),
                }),
            } : {}),
        })
    } catch (cause) {
        if (state.mode === 'off') {
            return Object.freeze({
                outcome: createSubmissionNativeOutcome(state.input.submissionId, {
                    mode: 'off',
                    status: 'unobserved',
                    locations: [ submissionLocation(state.input.submissionId) ],
                    outcomes: [],
                }),
            })
        }
        const fallback = observedFailure(
            'scope-settlement',
            submissionLocation(state.input.submissionId),
            Number.MAX_SAFE_INTEGER,
            'scope-failure',
            'SCRATCH_SUBMISSION_NATIVE_OBSERVATION_FAILED',
            cause
        )
        const outcome = createSubmissionNativeOutcome(state.input.submissionId, {
            mode: state.mode,
            status: 'observation-failed',
            locations: [ fallback.fact.location ],
            outcomes: [ fallback.fact ],
        })
        return Object.freeze({
            outcome,
            primaryFailure: Object.freeze({
                fact: fallback.fact,
                issueOrdinal: fallback.issueOrdinal,
                ...(fallback.cause !== undefined ? { cause: fallback.cause } : {}),
            }),
        })
    } finally {
        state.unsubscribeLifecycle()
        state.reservation?.release()
    }
}

async function settleReadbackObservation(
    state: ReadbackObservationState
): Promise<ReadbackNativeSettlement> {

    const controller = diagnosticsControllerFor(state.input.runtime)
    try {
        const scopedFailures = (await Promise.all(
            state.bundles.map(settleReadbackScopeBundle)
        )).flat()
        const failures = [
            ...state.synchronousFailures,
            ...scopedFailures,
            ...(state.lifecycleFailure !== undefined ? [ state.lifecycleFailure ] : []),
        ]
        const publicOutcome = createPublicReadbackOutcome(state, failures)
        const retainedFailures = retainOrderedReadbackFailures(failures)
        const primary = retainedFailures[0]
        const record = controller.completeOperation(state.operation, {
            status: primary === undefined ? 'succeeded' : 'failed',
            ...(primary !== undefined
                ? { nativeErrorCategory: primary.fact.nativeErrorCategory }
                : {}),
            nativeOutcome: {
                mode: publicOutcome.mode,
                status: publicOutcome.status,
                locations: [],
                outcomes: publicOutcome.outcomes,
                omittedLocationCount: 0,
                omittedOutcomeCount: publicOutcome.omittedOutcomeCount,
            },
        })

        let incident: ScratchGpuIncidentReport | undefined
        if (primary !== undefined) {
            incident = controller.recordIncident({
                kind: 'readback-failure',
                diagnosticCode: primary.fact.diagnosticCode,
                nativeErrorCategory: primary.fact.nativeErrorCategory,
                attribution: state.mode === 'summary'
                    ? 'enclosing-operation-family'
                    : 'exact-operation',
                target: state.input.target,
                operationId: state.operation.id,
                triggerOperation: record,
                failureStage: 'copy-issue',
                ...(primary.fact.nativeError !== undefined
                    ? { nativeError: primary.fact.nativeError }
                    : {}),
                outcomes: retainedFailures.map(failure => ({
                    stage: failure.fact.stage,
                    diagnosticCode: failure.fact.diagnosticCode,
                    nativeErrorCategory: failure.fact.nativeErrorCategory,
                    ...(failure.fact.nativeError !== undefined
                        ? { nativeError: failure.fact.nativeError }
                        : {}),
                })),
                omittedOutcomeCount: Math.max(0, failures.length - retainedFailures.length),
            })
        }
        return Object.freeze({
            outcome: publicOutcome,
            ...(primary !== undefined ? {
                primaryFailure: Object.freeze({
                    fact: primary.fact,
                    issueOrdinal: primary.issueOrdinal,
                    ...(primary.cause !== undefined ? { cause: primary.cause } : {}),
                    ...(incident !== undefined ? { incident } : {}),
                }),
            } : {}),
        })
    } catch (cause) {
        if (state.mode === 'off') {
            return Object.freeze({
                outcome: createReadbackNativeOutcome(state.input.target.readbackId, {
                    mode: 'off',
                    status: 'unobserved',
                    locations: [],
                    outcomes: [],
                }),
            })
        }
        const fallback = readbackObservedFailure(
            'scope-settlement',
            Number.MAX_SAFE_INTEGER,
            'scope-failure',
            'SCRATCH_READBACK_NATIVE_OBSERVATION_FAILED',
            cause
        )
        const outcome = createReadbackNativeOutcome(state.input.target.readbackId, {
            mode: state.mode,
            status: 'observation-failed',
            locations: [],
            outcomes: [ fallback.fact ],
        })
        return Object.freeze({
            outcome,
            primaryFailure: Object.freeze({
                fact: fallback.fact,
                issueOrdinal: fallback.issueOrdinal,
                ...(fallback.cause !== undefined ? { cause: fallback.cause } : {}),
            }),
        })
    } finally {
        state.unsubscribeLifecycle()
        state.reservation?.release()
    }
}

function createPublicReadbackOutcome(
    state: ReadbackObservationState,
    failures: readonly ReadbackObservedFailure[]
): ScratchReadbackNativeOutcome {

    if (state.mode === 'off') {
        return createReadbackNativeOutcome(state.input.target.readbackId, {
            mode: 'off',
            status: 'unobserved',
            locations: [],
            outcomes: [],
        })
    }
    const observationFailed = failures.some(failure =>
        failure.fact.nativeErrorCategory === 'scope-failure' ||
        failure.fact.nativeErrorCategory === 'device-lost' ||
        failure.fact.nativeErrorCategory === 'none'
    )
    const retainedFailures = failures.slice(0, MAX_RETAINED_SUBMISSION_FAILURES)
    return createReadbackNativeOutcome(state.input.target.readbackId, {
        mode: state.mode,
        status: failures.length === 0
            ? 'observed-succeeded'
            : observationFailed
                ? 'observation-failed'
                : 'observed-failed',
        locations: [],
        outcomes: retainedFailures.map(failure => failure.fact),
        omittedOutcomeCount: Math.max(0, failures.length - retainedFailures.length),
    })
}

function createPublicOutcome(
    state: ObservationState,
    failures: readonly SubmissionObservedFailure[]
): ScratchSubmissionNativeOutcome {

    if (state.mode === 'off') {
        return createSubmissionNativeOutcome(state.input.submissionId, {
            mode: 'off',
            status: 'unobserved',
            locations: [ submissionLocation(state.input.submissionId) ],
            outcomes: [],
        })
    }
    const observationFailed = failures.some(failure =>
        failure.fact.nativeErrorCategory === 'scope-failure' ||
        failure.fact.nativeErrorCategory === 'device-lost' ||
        failure.fact.nativeErrorCategory === 'none'
    )
    const allLocations = state.mode === 'summary'
        ? failures.length === 0
            ? [ submissionLocation(state.input.submissionId) ]
            : state.issuedLocations.length > 0
                ? state.issuedLocations
                : [ submissionLocation(state.input.submissionId) ]
        : state.issuedLocations
    const locations = allLocations.slice(0, MAX_RETAINED_SUBMISSION_FAILURES)
    const retainedFailures = failures.slice(0, MAX_RETAINED_SUBMISSION_FAILURES)
    return createSubmissionNativeOutcome(state.input.submissionId, {
        mode: state.mode,
        status: failures.length === 0
            ? 'observed-succeeded'
            : observationFailed
                ? 'observation-failed'
                : 'observed-failed',
        locations,
        outcomes: retainedFailures.map(failure => failure.fact),
        omittedLocationCount: Math.max(0, allLocations.length - locations.length),
        omittedOutcomeCount: Math.max(0, failures.length - retainedFailures.length),
    })
}

function assertObservationInput(input: BeginSubmissionNativeObservationInput): void {

    if (typeof input.submissionId !== 'string' || input.submissionId.length === 0) {
        throw new TypeError('Submission native observation requires a submissionId.')
    }
    if (typeof input.effectful !== 'boolean') {
        throw new TypeError('Submission native observation effectful must be boolean.')
    }
    if (!Array.isArray(input.plan)) {
        throw new TypeError('Submission native observation plan must be an array.')
    }
    if (!input.effectful && input.plan.length !== 0) {
        throw new TypeError('Effect-free submission native observation must have an empty plan.')
    }
    if (input.effectful && input.plan.length === 0) {
        throw new TypeError('Effectful submission native observation requires a non-empty plan.')
    }

    const keys = new Set<string>()
    for (const issue of input.plan) {
        createSubmissionNativeOutcome(input.submissionId, {
            mode: 'detailed',
            status: 'observed-failed',
            locations: [ issue.location ],
            outcomes: [ {
                stage: issue.stage,
                location: issue.location,
                nativeErrorCategory: 'scope-failure',
            } ],
        })
        const key = issueKey(issue)
        if (keys.has(key)) {
            throw new TypeError('Submission native observation plan contains a duplicate issue.')
        }
        keys.add(key)
    }
}

function assertReadbackObservationInput(input: BeginReadbackNativeObservationInput): void {

    if (
        input.target.kind !== 'readback' ||
        input.target.path !== 'direct' ||
        typeof input.target.readbackId !== 'string' ||
        input.target.readbackId.length === 0
    ) {
        throw new TypeError('Readback native observation requires a direct readback target.')
    }
    if (!Array.isArray(input.plan) || input.plan.length === 0) {
        throw new TypeError('Readback native observation requires a non-empty plan.')
    }
    const stages = new Set<ScratchReadbackNativeStage>()
    for (const stage of input.plan) {
        createReadbackNativeOutcome(input.target.readbackId, {
            mode: 'detailed',
            status: 'observed-failed',
            locations: [],
            outcomes: [ {
                stage,
                nativeErrorCategory: 'scope-failure',
            } ],
        })
        if (stages.has(stage)) {
            throw new TypeError('Readback native observation plan contains a duplicate stage.')
        }
        stages.add(stage)
    }
}

function openScopeBundle<Location>(
    device: GPUDevice,
    stage: ScratchSubmissionNativeStage,
    location: Location,
    issueOrdinal: number
): ScopeBundle<Location> {

    const bundle: ScopeBundle<Location> = {
        stage,
        location,
        issueOrdinal,
        boundaryFailures: [],
        pushed: [],
        observations: [],
        isClosed: false,
    }
    if (
        device === undefined ||
        typeof device.pushErrorScope !== 'function' ||
        typeof device.popErrorScope !== 'function'
    ) {
        bundle.boundaryFailures.push(
            new TypeError('GPUDevice error-scope methods are unavailable.')
        )
        return bundle
    }

    for (const filter of [ 'out-of-memory', 'internal', 'validation' ] as const) {
        try {
            device.pushErrorScope(filter)
            bundle.pushed.push(filter)
        } catch (cause) {
            bundle.boundaryFailures.push(cause)
        }
    }
    return bundle
}

function closeScopeBundle<Location>(device: GPUDevice, bundle: ScopeBundle<Location>): void {

    if (bundle.isClosed) return
    bundle.isClosed = true
    for (const filter of [ ...bundle.pushed ].reverse()) {
        bundle.observations.push({
            filter,
            observation: popScope(device),
        })
    }
}

async function settleScopeBundle(
    bundle: ScopeBundle<ScratchSubmissionNativeLocation>
): Promise<SubmissionObservedFailure[]> {

    const failures = bundle.boundaryFailures.map(cause => observedFailure(
        'scope-settlement',
        bundle.location,
        bundle.issueOrdinal,
        'scope-failure',
        'SCRATCH_SUBMISSION_NATIVE_SCOPE_FAILED',
        cause
    ))
    const observations = await Promise.all(
        bundle.observations.map(observation => observation.observation)
    )

    for (const [ index, observation ] of observations.entries()) {
        const filter = bundle.observations[index].filter
        if (observation.status === 'rejected' || observation.status === 'invalid') {
            failures.push(observedFailure(
                'scope-settlement',
                bundle.location,
                bundle.issueOrdinal,
                'scope-failure',
                'SCRATCH_SUBMISSION_NATIVE_SCOPE_FAILED',
                observation.reason
            ))
            continue
        }
        if (observation.value === null) continue
        if (!isGpuError(observation.value)) {
            failures.push(observedFailure(
                'scope-settlement',
                bundle.location,
                bundle.issueOrdinal,
                'scope-failure',
                'SCRATCH_SUBMISSION_NATIVE_SCOPE_FAILED',
                new TypeError(`The ${filter} error scope resolved with an invalid value.`)
            ))
            continue
        }
        failures.push(observedFailure(
            bundle.stage,
            bundle.location,
            bundle.issueOrdinal,
            filter,
            diagnosticCodeForCategory(filter),
            observation.value
        ))
    }
    return failures
}

async function settleReadbackScopeBundle(
    bundle: ScopeBundle<undefined>
): Promise<ReadbackObservedFailure[]> {

    const failures = bundle.boundaryFailures.map(cause => readbackObservedFailure(
        'scope-settlement',
        bundle.issueOrdinal,
        'scope-failure',
        'SCRATCH_READBACK_NATIVE_SCOPE_FAILED',
        cause
    ))
    const observations = await Promise.all(
        bundle.observations.map(observation => observation.observation)
    )

    for (const [ index, observation ] of observations.entries()) {
        const filter = bundle.observations[index].filter
        if (observation.status === 'rejected' || observation.status === 'invalid') {
            failures.push(readbackObservedFailure(
                'scope-settlement',
                bundle.issueOrdinal,
                'scope-failure',
                'SCRATCH_READBACK_NATIVE_SCOPE_FAILED',
                observation.reason
            ))
            continue
        }
        if (observation.value === null) continue
        if (!isGpuError(observation.value)) {
            failures.push(readbackObservedFailure(
                'scope-settlement',
                bundle.issueOrdinal,
                'scope-failure',
                'SCRATCH_READBACK_NATIVE_SCOPE_FAILED',
                new TypeError(`The ${filter} error scope resolved with an invalid value.`)
            ))
            continue
        }
        failures.push(readbackObservedFailure(
            bundle.stage as ScratchReadbackNativeStage,
            bundle.issueOrdinal,
            filter,
            readbackDiagnosticCodeForCategory(filter),
            observation.value
        ))
    }
    return failures
}

function popScope(device: GPUDevice): Promise<ScopePromiseObservation> {

    let value: unknown
    try {
        value = device.popErrorScope()
    } catch (reason) {
        return Promise.resolve(Object.freeze({ status: 'rejected', reason }))
    }
    if (!isObjectLike(value) || typeof (value as { then?: unknown }).then !== 'function') {
        return Promise.resolve(Object.freeze({
            status: 'invalid',
            reason: new TypeError('GPUDevice.popErrorScope() did not return a Promise.'),
        }))
    }
    return Promise.resolve(value as PromiseLike<GPUError | null>).then(
        result => Object.freeze({ status: 'fulfilled', value: result }),
        reason => Object.freeze({ status: 'rejected', reason })
    )
}

function lifecycleFailure(
    runtime: ScratchRuntime,
    submissionId: string,
    change: ScratchRuntimeLifecycleChange
): SubmissionObservedFailure {

    const location = submissionLocation(submissionId)
    if (change.kind === 'device-lost') {
        return observedFailure(
            'lifecycle-recheck',
            location,
            Number.MAX_SAFE_INTEGER,
            'device-lost',
            'SCRATCH_RUNTIME_DEVICE_LOST_DURING_GPU_OPERATION',
            runtime.deviceLostInfo
        )
    }
    return observedFailure(
        'lifecycle-recheck',
        location,
        Number.MAX_SAFE_INTEGER,
        'none',
        'SCRATCH_RUNTIME_DISPOSED'
    )
}

function readbackLifecycleFailure(
    runtime: ScratchRuntime,
    change: ScratchRuntimeLifecycleChange
): ReadbackObservedFailure {

    if (change.kind === 'device-lost') {
        return readbackObservedFailure(
            'lifecycle-recheck',
            Number.MAX_SAFE_INTEGER,
            'device-lost',
            'SCRATCH_RUNTIME_DEVICE_LOST_DURING_GPU_OPERATION',
            runtime.deviceLostInfo
        )
    }
    return readbackObservedFailure(
        'lifecycle-recheck',
        Number.MAX_SAFE_INTEGER,
        'none',
        'SCRATCH_RUNTIME_DISPOSED'
    )
}

function observedFailure(
    stage: ScratchSubmissionNativeStage,
    location: ScratchSubmissionNativeLocation,
    issueOrdinal: number,
    nativeErrorCategory: GpuNativeErrorCategory,
    diagnosticCode: string,
    cause?: unknown
): SubmissionObservedFailure {

    return Object.freeze({
        fact: Object.freeze({
            stage,
            location: Object.freeze({ ...location }),
            nativeErrorCategory,
            diagnosticCode,
            ...(cause !== undefined
                ? { nativeError: serializeNativeGpuError(cause) }
                : {}),
        }),
        issueOrdinal,
        ...(cause !== undefined ? { cause } : {}),
    })
}

function readbackObservedFailure(
    stage: ScratchReadbackNativeStage,
    issueOrdinal: number,
    nativeErrorCategory: GpuNativeErrorCategory,
    diagnosticCode: string,
    cause?: unknown
): ReadbackObservedFailure {

    return Object.freeze({
        fact: Object.freeze({
            stage,
            nativeErrorCategory,
            diagnosticCode,
            ...(cause !== undefined
                ? { nativeError: serializeNativeGpuError(cause) }
                : {}),
        }),
        issueOrdinal,
        ...(cause !== undefined ? { cause } : {}),
    })
}

const submissionNativeStageOrder: readonly ScratchSubmissionNativeStage[] = Object.freeze([
    'encoder-create',
    'pass-begin',
    'command-encode',
    'pass-end',
    'encoder-finish',
    'queue-action',
    'queue-submit',
    'scope-settlement',
    'queue-completion',
    'lifecycle-recheck',
])

export function compareSubmissionNativeStages(
    left: ScratchSubmissionNativeStage,
    right: ScratchSubmissionNativeStage
): number {

    return submissionNativeStageOrder.indexOf(left) - submissionNativeStageOrder.indexOf(right)
}

function retainOrderedSubmissionFailures(
    failures: readonly SubmissionObservedFailure[]
): SubmissionObservedFailure[] {

    const retained: Array<Readonly<{
        failure: SubmissionObservedFailure
        settlementOrder: number
    }>> = []
    for (const [ settlementOrder, failure ] of failures.entries()) {
        const candidate = { failure, settlementOrder }
        const insertionIndex = retained.findIndex(current =>
            compareRankedSubmissionFailures(candidate, current) < 0
        )
        if (insertionIndex < 0) {
            if (retained.length < MAX_RETAINED_SUBMISSION_FAILURES) retained.push(candidate)
            continue
        }
        retained.splice(insertionIndex, 0, candidate)
        if (retained.length > MAX_RETAINED_SUBMISSION_FAILURES) retained.pop()
    }
    return retained.map(item => item.failure)
}

function retainOrderedReadbackFailures(
    failures: readonly ReadbackObservedFailure[]
): ReadbackObservedFailure[] {

    const retained: Array<Readonly<{
        failure: ReadbackObservedFailure
        settlementOrder: number
    }>> = []
    for (const [ settlementOrder, failure ] of failures.entries()) {
        const candidate = { failure, settlementOrder }
        const insertionIndex = retained.findIndex(current => {
            const stageDifference = compareSubmissionNativeStages(
                candidate.failure.fact.stage,
                current.failure.fact.stage
            )
            if (stageDifference !== 0) return stageDifference < 0
            const issueDifference = candidate.failure.issueOrdinal - current.failure.issueOrdinal
            return issueDifference !== 0
                ? issueDifference < 0
                : candidate.settlementOrder < current.settlementOrder
        })
        if (insertionIndex < 0) {
            if (retained.length < MAX_RETAINED_SUBMISSION_FAILURES) retained.push(candidate)
            continue
        }
        retained.splice(insertionIndex, 0, candidate)
        if (retained.length > MAX_RETAINED_SUBMISSION_FAILURES) retained.pop()
    }
    return retained.map(item => item.failure)
}

function compareRankedSubmissionFailures(
    left: Readonly<{ failure: SubmissionObservedFailure, settlementOrder: number }>,
    right: Readonly<{ failure: SubmissionObservedFailure, settlementOrder: number }>
): number {

    const stageDifference = compareSubmissionNativeStages(
        left.failure.fact.stage,
        right.failure.fact.stage
    )
    if (stageDifference !== 0) return stageDifference
    const issueDifference = left.failure.issueOrdinal - right.failure.issueOrdinal
    return issueDifference !== 0
        ? issueDifference
        : left.settlementOrder - right.settlementOrder
}

function retainIssuedLocation(
    state: ObservationState,
    location: ScratchSubmissionNativeLocation
): void {

    const key = locationKey(location)
    if (state.issuedLocationKeys.has(key)) return
    state.issuedLocationKeys.add(key)
    state.issuedLocations.push(Object.freeze({ ...location }) as ScratchSubmissionNativeLocation)
}

function submissionLocation(submissionId: string): ScratchSubmissionNativeLocation {

    return Object.freeze({ kind: 'submission', submissionId })
}

function issueKey(issue: SubmissionNativeIssue): string {

    return `${issue.stage}:${locationKey(issue.location)}`
}

function locationKey(location: ScratchSubmissionNativeLocation): string {

    return JSON.stringify(location)
}

function diagnosticCodeForCategory(category: ScopeFilter): string {

    if (category === 'validation') return 'SCRATCH_SUBMISSION_NATIVE_VALIDATION_FAILED'
    if (category === 'internal') return 'SCRATCH_SUBMISSION_NATIVE_INTERNAL_FAILED'
    return 'SCRATCH_SUBMISSION_NATIVE_OUT_OF_MEMORY'
}

function readbackDiagnosticCodeForCategory(category: ScopeFilter): string {

    if (category === 'validation') return 'SCRATCH_READBACK_NATIVE_VALIDATION_FAILED'
    if (category === 'internal') return 'SCRATCH_READBACK_NATIVE_INTERNAL_FAILED'
    return 'SCRATCH_READBACK_NATIVE_OUT_OF_MEMORY'
}

function isGpuError(value: unknown): value is GPUError {

    if (!isObjectLike(value)) return false
    try {
        return typeof (value as { message?: unknown }).message === 'string'
    } catch {
        return false
    }
}

function isObjectLike(value: unknown): value is object {

    return value !== null && (typeof value === 'object' || typeof value === 'function')
}
