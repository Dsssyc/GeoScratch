import { throwGPUDiagnostic } from './diagnostics.js'
import { isContentResource } from './resource.js'
import {
    assertGpuOperationTarget,
    boundedGpuOperationNativeLabel,
    createGpuDescriptorEvidence,
    createGpuIncidentReport,
    createGpuOperationRecord,
    serializeNativeGpuError,
    serializedEvidenceBytes,
} from './gpu-operation.js'
import type { GPUDiagnosticSubjectDraft, ScratchDiagnosticSubject } from './diagnostics.js'
import type { CommandResourceReadEpoch } from './command.js'
import type {
    GPUAttributionConfidence,
    GPUDescriptorEvidence,
    GPUNativeErrorCategory,
    GPUOperationKind,
    GPUOperationStatus,
    GPUIncidentKind,
    GPUIncidentFailureStage,
    GPUIncidentOutcome,
    GPUIncidentReport,
    GPUBindSetOperationTarget,
    GPUCommandOperationTarget,
    GPUOperationRecord,
    GPUOperationTarget,
    GPUPipelineOperationRecord,
    GPUPressureEvidence,
    GPUReadbackOperationTarget,
    GPUResourceOperationTarget,
    GPUSubmissionOperationTarget,
    GPUPipelineNativeLabelEvidence,
    GPUNativeErrorFacts,
    GPUSubmissionScopeMode,
    GPUSubmissionNativeLocation,
    GPUSubmissionNativeOutcomeInput,
    GPUSubmissionNativeOutcomeMode,
    GPUSubmissionNativeOutcomeStatus,
    GPUSubmissionNativeStage,
} from './gpu-operation.js'
import type {
    BindLayout,
    BindSet,
    BindSetPreparationState,
    NormalizedBindLayoutEntry,
} from './binding.js'
import type { GPUReadbackNativeOutcomeInput } from './gpu-operation.js'
import type {
    PipelineCreationReport,
    PipelineKind,
    ShaderModuleCompilationReport,
} from './pipeline-compilation.js'
import type { GPUReadbackPolicy } from './readback-ownership.js'
import type { QuerySetResource, QuerySetSlotSnapshot, QuerySetType } from './query-set.js'
import type { Resource, ResourceState } from './resource.js'

const DEFAULT_OPERATION_CAPACITY = 256
const DEFAULT_INCIDENT_CAPACITY = 32
const DEFAULT_EVIDENCE_BYTE_CAPACITY = 256 * 1024
const DEFAULT_RECENT_OPERATION_LIMIT = 16
const DEFAULT_CONTRIBUTOR_LIMIT = 8
const DEFAULT_MAX_ACTIVE_CAPTURES = 4
const DEFAULT_MAX_PENDING_NATIVE_OBSERVATIONS = 64
const DEFAULT_CAPTURE_MAX_OPERATIONS = 128
const DEFAULT_CAPTURE_MAX_DURATION_MS = 5_000
const DEFAULT_CAPTURE_MAX_EVIDENCE_BYTES = 256 * 1024
const CAPTURE_INCIDENT_LINK_RESERVE_BYTES = 256
const diagnosticsFacadeToken = Symbol('GPURuntimeDiagnostics')
const diagnosticCaptureToken = Symbol('GPUDiagnosticCapture')

export type GPUPendingOperationKind = Exclude<
    GPUOperationKind,
    'resource-disposal' | 'pipeline-disposal' | 'readback-staging-release'
>

export type GPURuntimeDiagnosticsOptions = Readonly<{
    operationCapacity?: number
    incidentCapacity?: number
    evidenceByteCapacity?: number
    recentOperationLimit?: number
    contributorLimit?: number
    maxActiveCaptures?: number
    submissionScopes?: GPUSubmissionScopeMode
    maxPendingNativeObservations?: number
}>

export type NormalizedGPURuntimeDiagnosticsOptions = Readonly<{
    operationCapacity: number
    incidentCapacity: number
    evidenceByteCapacity: number
    recentOperationLimit: number
    contributorLimit: number
    maxActiveCaptures: number
    submissionScopes: GPUSubmissionScopeMode
    maxPendingNativeObservations: number
}>

type GPURuntimeResourceFactBase = Readonly<{
    id: string
    label?: string
    descriptorHash: string
    allocationVersion: number
    lastAllocationOperationId?: string
    pendingReplacementOperationId?: string
}>

export type GPURuntimeContentResourceFact = GPURuntimeResourceFactBase & Readonly<{
    resourceKind: 'BufferResource' | 'TextureResource'
    contentEpoch: number
    state: ResourceState
    logicalFootprintBytes: number
    logicalFootprintKnown: boolean
}>

export type GPURuntimeSamplerResourceFact = GPURuntimeResourceFactBase & Readonly<{
    resourceKind: 'SamplerResource'
}>

export type GPURuntimeQuerySetResourceFact = GPURuntimeResourceFactBase & Readonly<{
    resourceKind: 'QuerySetResource'
    queryType: QuerySetType
    count: number
    slots: readonly QuerySetSlotSnapshot[]
}>

export type GPURuntimeResourceFact =
    | GPURuntimeContentResourceFact
    | GPURuntimeSamplerResourceFact
    | GPURuntimeQuerySetResourceFact

export type GPUPendingOperationFact = Readonly<{
    id: string
    sequence: number
    kind: GPUPendingOperationKind
    target: GPUOperationTarget
    descriptorHash: string
    startedAtMs: number
}>

export type GPURuntimePipelineFact = Readonly<{
    id: string
    label?: string
    pipelineKind: PipelineKind
    programId: string
    programContractHash: string
    descriptorHash: string
    state: 'ready'
    lastCreationOperationId: string
    stages: PipelineCreationReport['stages']
}>

export type GPURuntimePipelineRegistration = Readonly<{
    label?: string
    creationOperation: GPUPipelineOperationRecord
}>

export type GPURuntimeBindLayoutFact = Readonly<{
    id: string
    label?: string
    group: number
    entries: readonly NormalizedBindLayoutEntry[]
    origin: BindLayout['origin']
    validationConfidence: BindLayout['validationConfidence']
    sourcePipelineId?: string
    acknowledgementState: 'acknowledged'
    lastAllocationOperationId: string
}>

export type GPURuntimeBindSetFact = Readonly<{
    id: string
    label?: string
    bindLayoutId: string
    preparationState: BindSetPreparationState
    prepareGeneration: number
    preparedSnapshotHash?: string
    inFlightOperationId?: string
    lastPreparationOperationId?: string
    lastIncidentId?: string
}>

export type GPUReadbackCommandState =
    | 'allocating'
    | 'idle'
    | 'claimed'
    | 'submitted'
    | 'mapping'
    | 'releasing'
    | 'disposed'
    | 'failed'

export type GPURuntimeReadbackCommandFact = Readonly<{
    id: string
    label?: string
    sourceResourceId: string
    allocationVersion: number
    contentEpoch: CommandResourceReadEpoch
    byteLength: number
    state: GPUReadbackCommandState
    stagingAllocationOperationId?: string
}>

export type GPURuntimeReadbackOperationFact = Readonly<{
    id: string
    label?: string
    path: 'direct' | 'ordered'
    state: string
    retain: 'consume-on-read' | 'until-dispose'
    sourceKind?: 'buffer' | 'texture'
    sourceResourceId: string
    allocationVersion: number
    contentEpoch: number
    byteLength: number
    stagingByteLength?: number
    textureSubresource?: Readonly<{
        format: GPUTextureFormat
        mipLevel: number
        origin: Readonly<{ x: number, y: number, z: number }>
        size: Readonly<{ width: number, height: number, depthOrArrayLayers: number }>
        aspect: GPUTextureAspect
    }>
    stagingBytes: number
    retainedHostBytes: number
    isMapping: boolean
    commandId?: string
    submissionId?: string
    stepIndex?: number
    lastStagingOperationId?: string
    lastMappingOperationId?: string
}>

export type GPURuntimeBufferMappingFact = Readonly<{
    id: string
    resourceId: string
    offset: number
    size: number
    mode: 'read' | 'write'
    state: 'pending' | 'mapped'
    allocationVersion: number
    contentEpoch: number
    operationId: string
}>

export type GPUReadbackStagingReservation = Readonly<{
    id: string
    byteLength: number
    readonly isReleased: boolean
    release(): void
}>

export type GPURuntimeDiagnosticsSnapshot = Readonly<{
    version: 5
    runtime: Readonly<{
        id: string
        label?: string
        isDisposed: boolean
        isDeviceLost: boolean
    }>
    resources: readonly GPURuntimeResourceFact[]
    bindLayouts: readonly GPURuntimeBindLayoutFact[]
    bindSets: readonly GPURuntimeBindSetFact[]
    pipelines: readonly GPURuntimePipelineFact[]
    readbackCommands: readonly GPURuntimeReadbackCommandFact[]
    readbacks: readonly GPURuntimeReadbackOperationFact[]
    bufferMappings: readonly GPURuntimeBufferMappingFact[]
    pendingOperations: readonly GPUPendingOperationFact[]
    pressure: Readonly<{
        currentScratchLogicalFootprintBytes: number
        peakScratchLogicalFootprintBytes: number
        liveResourceCounts: Readonly<Record<string, number>>
    }>
    readbackMemory: Readonly<{
        maxPendingOperations: number
        maxStagingBytes: number
        currentStagingBytes: number
        peakStagingBytes: number
        currentRetainedHostBytes: number
        peakRetainedHostBytes: number
        activeMappings: number
        peakActiveMappings: number
    }>
    bufferMapping: Readonly<{
        currentMappings: number
        peakMappings: number
        currentSelectedBytes: number
        peakSelectedBytes: number
    }>
    submissionNative: Readonly<{
        submissionScopes: GPUSubmissionScopeMode
        maxPendingNativeObservations: number
        currentPendingNativeObservations: number
        peakPendingNativeObservations: number
        currentEffectfulSubmittedWork: number
    }>
    recorder: Readonly<{
        operationCapacity: number
        incidentCapacity: number
        evidenceByteCapacity: number
        retainedOperationCount: number
        retainedIncidentCount: number
        retainedEvidenceBytes: number
        overwrittenOperations: number
        overwrittenIncidents: number
        omittedRecords: number
    }>
    aggregates: Readonly<{
        allocationAttempts: number
        successfulAllocations: number
        validationFailures: number
        outOfMemoryFailures: number
        nativeFailures: number
        scopeFailures: number
        cancelledAllocations: number
        pipelineCreationAttempts: number
        successfulPipelineCreations: number
        failedPipelineCreations: number
        cancelledPipelineCreations: number
        pipelineDisposals: number
        readbackOperationAttempts: number
        successfulReadbackOperations: number
        failedReadbackOperations: number
        cancelledReadbackOperations: number
        uncapturedErrors: number
        deviceLosses: number
    }>
    capture: Readonly<{
        activeCount: number
        maxActiveCaptures: number
    }>
}>

export type GPURuntimeDiagnosticsEvidence = Readonly<{
    version: 5
    snapshot: GPURuntimeDiagnosticsSnapshot
    operations: readonly GPUOperationRecord[]
    incidents: readonly GPUIncidentReport[]
}>

export type GPUOperationQuery = Readonly<{
    operationId?: string
    resourceId?: string
    resourceKind?: GPUResourceOperationTarget['resourceKind']
    bindLayoutId?: string
    bindSetId?: string
    shaderModuleId?: string
    renderBundleId?: string
    preparationStage?: import('./gpu-operation.js').GPUBindSetPreparationStage
    pipelineId?: string
    commandId?: string
    readbackId?: string
    submissionId?: string
    nativeLocationKind?: GPUSubmissionNativeLocation['kind']
    nativeStage?: GPUSubmissionNativeStage
    nativeOutcomeStatus?: GPUSubmissionNativeOutcomeStatus
    targetKind?: GPUOperationTarget['kind']
    kind?: GPUOperationKind
    status?: GPUOperationStatus
    sequenceFrom?: number
    sequenceTo?: number
}>

export type GPUIncidentQuery = Readonly<{
    incidentId?: string
    operationId?: string
    resourceId?: string
    resourceKind?: GPUResourceOperationTarget['resourceKind']
    bindLayoutId?: string
    bindSetId?: string
    shaderModuleId?: string
    renderBundleId?: string
    preparationStage?: import('./gpu-operation.js').GPUBindSetPreparationStage
    pipelineId?: string
    commandId?: string
    readbackId?: string
    submissionId?: string
    nativeLocationKind?: GPUSubmissionNativeLocation['kind']
    nativeStage?: GPUSubmissionNativeStage
    targetKind?: GPUOperationTarget['kind'] | 'runtime'
    kind?: GPUIncidentKind
    sequenceFrom?: number
    sequenceTo?: number
}>

export type GPUDiagnosticCaptureOptions = Readonly<{
    maxOperations?: number
    maxDurationMs?: number
    maxEvidenceBytes?: number
    includeStacks?: boolean
    includeDescriptors?: boolean
    nativeSubmissionDetail?: 'step'
}>

type NormalizedGPUDiagnosticCaptureOptions = Readonly<{
    maxOperations: number
    maxDurationMs: number
    maxEvidenceBytes: number
    includeStacks: boolean
    includeDescriptors: boolean
    nativeSubmissionDetail?: 'step'
}>

export type GPUDiagnosticCaptureStopReason =
    | 'explicit'
    | 'operation-limit'
    | 'duration-limit'
    | 'evidence-limit'
    | 'runtime-disposed'

export type GPUDiagnosticCaptureReport = Readonly<{
    version: 5
    id: string
    runtimeId: string
    stopReason: GPUDiagnosticCaptureStopReason
    operations: readonly GPUOperationRecord[]
    retainedEvidenceBytes: number
    omittedOperations: number
    startedAtMs: number
    stoppedAtMs: number
}>

export type GPUOperationStart = Readonly<{
    kind: GPUPendingOperationKind
    target: GPUOperationTarget
    descriptorSummary: Record<string, unknown>
    fullDescriptor: Record<string, unknown>
    nativeLabel?: string
}>

export type GPUPendingOperation = Readonly<{
    id: string
    sequence: number
    runtimeId: string
    kind: GPUPendingOperationKind
    target: GPUOperationTarget
    descriptor: GPUDescriptorEvidence
    fullDescriptor?: GPUDescriptorEvidence
    nativeLabel?: string
    startedAtMs: number
    stack?: string
}>

export type GPUOperationCompletion = Readonly<{
    status: Exclude<GPUOperationStatus, 'pending'>
    nativeErrorCategory?: GPUNativeErrorCategory
    incidentId?: string
    nativeLabels?: GPUPipelineNativeLabelEvidence
    pipelineCreationReport?: PipelineCreationReport
    nativeOutcome?: GPUSubmissionNativeOutcomeInput | GPUReadbackNativeOutcomeInput
    bindSetTarget?: GPUBindSetOperationTarget
}>

export type GPUSubmissionNativeObservationReservation = Readonly<{
    id: string
    readonly isReleased: boolean
    release(): void
}>

export type GPUEffectfulSubmittedWorkReservation = Readonly<{
    id: string
    readonly isReleased: boolean
    release(): void
}>

export type GPUIncidentInput = Readonly<{
    kind: GPUIncidentKind
    diagnosticCode: string
    nativeErrorCategory: GPUNativeErrorCategory
    attribution: GPUAttributionConfidence
    target?: GPUOperationTarget
    operationId?: string
    triggerOperation?: GPUOperationRecord
    related?: readonly ScratchDiagnosticSubject[]
    nativeError?: GPUNativeErrorFacts
    triggerLogicalFootprintBytes?: number
    failureStage?: GPUIncidentFailureStage
    pipelineErrorReason?: GPUPipelineErrorReason
    pipelineCreationReport?: PipelineCreationReport
    shaderModuleCompilationReport?: ShaderModuleCompilationReport
    outcomes?: readonly GPUIncidentOutcome[]
    omittedOutcomeCount?: number
}>

type RuntimeDiagnosticsOwner = {
    id: string
    label?: string
    isDisposed: boolean
    isDeviceLost: boolean
    deviceLostInfo: GPUDeviceLostInfo | undefined
}

type NativeGPUDeviceLostInfo = Awaited<GPUDevice['lost']>

export type GPUDeviceLostInfo = Readonly<{
    reason: GPUDeviceLostReason
    message: '[native device-loss message omitted]'
    nativeMessageOmitted: true
}>

export function retainDeviceLostInfo(info: NativeGPUDeviceLostInfo): GPUDeviceLostInfo {

    const serialized = serializeNativeGpuError(info)
    return Object.freeze({
        reason: (serialized.reason ?? 'unknown') as GPUDeviceLostReason,
        message: '[native device-loss message omitted]',
        nativeMessageOmitted: true,
    })
}

export type GPURuntimeLifecycleChange =
    | Readonly<{ kind: 'device-lost', info: NativeGPUDeviceLostInfo }>
    | Readonly<{ kind: 'runtime-disposed' }>

type RetainedEvidence<T> = {
    value: T
    bytes: number
}

type AggregateFacts = GPURuntimeDiagnosticsSnapshot['aggregates']

type CaptureState = {
    id: string
    runtimeId: string
    controller: GPURuntimeDiagnosticsController | undefined
    options: NormalizedGPUDiagnosticCaptureOptions
    operations: GPUOperationRecord[]
    retainedEvidenceBytes: number
    budgetedEvidenceBytes: number
    omittedOperations: number
    startedAtMs: number
    timer: ReturnType<typeof setTimeout> | undefined
    isActive: boolean
    report?: GPUDiagnosticCaptureReport
}

const controllerByRuntime = new WeakMap<object, GPURuntimeDiagnosticsController>()
const captureStates = new WeakMap<GPUDiagnosticCapture, CaptureState>()

/** Exposes bounded, read-only operation and incident evidence owned by one GPU runtime. */
export class GPURuntimeDiagnostics {

    #controller: GPURuntimeDiagnosticsController

    private constructor(token: symbol, controller: GPURuntimeDiagnosticsController) {

        if (token !== diagnosticsFacadeToken) throw new TypeError('GPURuntimeDiagnostics is runtime-owned.')
        this.#controller = controller
        Object.freeze(this)
    }

    snapshot(): GPURuntimeDiagnosticsSnapshot {

        return this.#controller.snapshot()
    }

    operations(query: GPUOperationQuery = {}): readonly GPUOperationRecord[] {

        return this.#controller.operations(query)
    }

    incidents(query: GPUIncidentQuery = {}): readonly GPUIncidentReport[] {

        return this.#controller.incidents(query)
    }

    operation(operationId: string): GPUOperationRecord | undefined {

        return this.#controller.operation(operationId)
    }

    incident(incidentId: string): GPUIncidentReport | undefined {

        return this.#controller.incident(incidentId)
    }

    exportEvidence(): GPURuntimeDiagnosticsEvidence {

        return this.#controller.exportEvidence()
    }

    capture(options: GPUDiagnosticCaptureOptions = {}): GPUDiagnosticCapture {

        return this.#controller.capture(options)
    }
}

/** Defines an explicit bounded interval for collecting one runtime's diagnostic evidence. */
export class GPUDiagnosticCapture {

    private constructor(token: symbol) {

        if (token !== diagnosticCaptureToken) throw new TypeError('GPUDiagnosticCapture is runtime-owned.')
        Object.preventExtensions(this)
    }

    get id(): string {

        return captureStateFor(this).id
    }

    get isActive(): boolean {

        return captureStateFor(this).isActive
    }

    stop(): GPUDiagnosticCaptureReport {

        return stopCapture(this, 'explicit')
    }
}

export class GPURuntimeDiagnosticsController {

    #owner: RuntimeDiagnosticsOwner
    #device: GPUDevice
    #options: NormalizedGPURuntimeDiagnosticsOptions
    #readbackPolicy: GPUReadbackPolicy
    #facade: GPURuntimeDiagnostics
    #resourceFacts = new Map<string, GPURuntimeResourceFact>()
    #bindLayoutFacts = new Map<string, GPURuntimeBindLayoutFact>()
    #bindSets = new Map<string, BindSet>()
    #pipelineFacts = new Map<string, GPURuntimePipelineFact>()
    #readbackCommandFacts = new Map<string, GPURuntimeReadbackCommandFact>()
    #readbackFacts = new Map<string, GPURuntimeReadbackOperationFact>()
    #bufferMappingFacts = new Map<string, GPURuntimeBufferMappingFact>()
    #readbackStagingReservations = new Map<string, number>()
    #submissionNativeObservationReservations = new Set<string>()
    #effectfulSubmittedWorkReservations = new Set<string>()
    #pendingOperations = new Map<string, GPUPendingOperation>()
    #completedOperations = new WeakSet<GPUOperationRecord>()
    #registeredPipelineCreations = new WeakSet<GPUPipelineOperationRecord>()
    #operations: RetainedEvidence<GPUOperationRecord>[] = []
    #incidents: RetainedEvidence<GPUIncidentReport>[] = []
    #captures = new Set<GPUDiagnosticCapture>()
    #linkableStoppedCaptures = new Set<GPUDiagnosticCapture>()
    #operationSequence = 0
    #incidentSequence = 0
    #captureSequence = 0
    #retainedEvidenceBytes = 0
    #overwrittenOperations = 0
    #overwrittenIncidents = 0
    #omittedRecords = 0
    #currentLogicalFootprintBytes = 0
    #peakLogicalFootprintBytes = 0
    #currentReadbackStagingBytes = 0
    #peakReadbackStagingBytes = 0
    #currentRetainedHostBytes = 0
    #peakRetainedHostBytes = 0
    #activeMappings = 0
    #peakActiveMappings = 0
    #currentBufferMappingBytes = 0
    #peakBufferMappingBytes = 0
    #peakBufferMappings = 0
    #currentPendingNativeObservations = 0
    #peakPendingNativeObservations = 0
    #currentEffectfulSubmittedWork = 0
    #aggregates: AggregateFacts = {
        allocationAttempts: 0,
        successfulAllocations: 0,
        validationFailures: 0,
        outOfMemoryFailures: 0,
        nativeFailures: 0,
        scopeFailures: 0,
        cancelledAllocations: 0,
        pipelineCreationAttempts: 0,
        successfulPipelineCreations: 0,
        failedPipelineCreations: 0,
        cancelledPipelineCreations: 0,
        pipelineDisposals: 0,
        readbackOperationAttempts: 0,
        successfulReadbackOperations: 0,
        failedReadbackOperations: 0,
        cancelledReadbackOperations: 0,
        uncapturedErrors: 0,
        deviceLosses: 0,
    }
    #uncapturedErrorListener: ((event: GPUUncapturedErrorEvent) => void) | undefined
    #lifecycleSubscribers = new Set<(change: GPURuntimeLifecycleChange) => void>()
    #isDisposed = false
    #deviceLossIncident: GPUIncidentReport | undefined

    constructor(
        owner: RuntimeDiagnosticsOwner,
        device: GPUDevice,
        options: NormalizedGPURuntimeDiagnosticsOptions,
        readbackPolicy: GPUReadbackPolicy
    ) {

        this.#owner = owner
        this.#device = device
        this.#options = options
        this.#readbackPolicy = readbackPolicy
        this.#facade = createDiagnosticsFacade(this)
        this.#installUncapturedErrorListener()
    }

    get facade(): GPURuntimeDiagnostics {

        return this.#facade
    }

    get lifecycleSubscriberCount(): number {

        return this.#lifecycleSubscribers.size
    }

    submissionNativeObservationMode(): GPUSubmissionNativeOutcomeMode {

        const detailed = [ ...this.#captures ].some(capture => {
            const state = captureStateFor(capture)
            return state.isActive && state.options.nativeSubmissionDetail === 'step'
        })
        return detailed ? 'detailed' : this.#options.submissionScopes
    }

    reserveSubmissionNativeObservation(
        target: GPUSubmissionOperationTarget
    ): GPUSubmissionNativeObservationReservation {

        const reservationId = target.submissionId
        if (this.#submissionNativeObservationReservations.has(reservationId)) {
            throw new TypeError(`Submission native observation ${reservationId} is already reserved.`)
        }
        if (
            this.#submissionNativeObservationReservations.size >=
            this.#options.maxPendingNativeObservations
        ) {
            const incident = this.recordIncident({
                kind: 'submission-failure',
                diagnosticCode: 'SCRATCH_SUBMISSION_NATIVE_OBSERVATION_BUDGET_EXCEEDED',
                nativeErrorCategory: 'none',
                attribution: 'exact-operation',
                target,
                failureStage: 'budget',
            })
            throwGPUDiagnostic({
                code: 'SCRATCH_SUBMISSION_NATIVE_OBSERVATION_BUDGET_EXCEEDED',
                severity: 'error',
                phase: 'submission',
                subject: { kind: 'Submission', id: target.submissionId },
                related: [ this.#runtimeSubject(), incident.subject ],
                message: 'GPURuntime submission native-observation budget is exhausted.',
                expected: {
                    maxPendingNativeObservations: this.#options.maxPendingNativeObservations,
                },
                actual: {
                    currentPendingNativeObservations:
                        this.#submissionNativeObservationReservations.size,
                    requested: 1,
                },
            }, { incident })
        }

        this.#submissionNativeObservationReservations.add(reservationId)
        this.#currentPendingNativeObservations =
            this.#submissionNativeObservationReservations.size
        this.#peakPendingNativeObservations = Math.max(
            this.#peakPendingNativeObservations,
            this.#currentPendingNativeObservations
        )

        let isReleased = false
        const controller = this
        return Object.freeze({
            id: reservationId,
            get isReleased() {

                return isReleased
            },
            release() {

                if (isReleased) return
                isReleased = true
                if (!controller.#submissionNativeObservationReservations.delete(reservationId)) return
                controller.#currentPendingNativeObservations =
                    controller.#submissionNativeObservationReservations.size
            },
        })
    }

    reserveReadbackNativeObservation(
        target: GPUReadbackOperationTarget
    ): GPUSubmissionNativeObservationReservation {

        const reservationId = target.readbackId
        if (this.#submissionNativeObservationReservations.has(reservationId)) {
            throw new TypeError(`Readback native observation ${reservationId} is already reserved.`)
        }
        if (
            this.#submissionNativeObservationReservations.size >=
            this.#options.maxPendingNativeObservations
        ) {
            const incident = this.recordIncident({
                kind: 'readback-failure',
                diagnosticCode: 'SCRATCH_READBACK_NATIVE_OBSERVATION_BUDGET_EXCEEDED',
                nativeErrorCategory: 'none',
                attribution: 'exact-operation',
                target,
                failureStage: 'budget',
            })
            throwGPUDiagnostic({
                code: 'SCRATCH_READBACK_NATIVE_OBSERVATION_BUDGET_EXCEEDED',
                severity: 'error',
                phase: 'readback',
                subject: { kind: 'ReadbackOperation', id: target.readbackId },
                related: [ this.#runtimeSubject(), incident.subject ],
                message: 'GPURuntime readback native-observation budget is exhausted.',
                expected: {
                    maxPendingNativeObservations: this.#options.maxPendingNativeObservations,
                },
                actual: {
                    currentPendingNativeObservations:
                        this.#submissionNativeObservationReservations.size,
                    requested: 1,
                },
            }, { incident })
        }

        this.#submissionNativeObservationReservations.add(reservationId)
        this.#currentPendingNativeObservations =
            this.#submissionNativeObservationReservations.size
        this.#peakPendingNativeObservations = Math.max(
            this.#peakPendingNativeObservations,
            this.#currentPendingNativeObservations
        )

        let isReleased = false
        const controller = this
        return Object.freeze({
            id: reservationId,
            get isReleased() {

                return isReleased
            },
            release() {

                if (isReleased) return
                isReleased = true
                if (!controller.#submissionNativeObservationReservations.delete(reservationId)) return
                controller.#currentPendingNativeObservations =
                    controller.#submissionNativeObservationReservations.size
            },
        })
    }

    retainEffectfulSubmittedWork(
        submissionId: string
    ): GPUEffectfulSubmittedWorkReservation {

        if (submissionId.length === 0) {
            throw new TypeError('Effectful SubmittedWork requires a submissionId.')
        }
        if (this.#effectfulSubmittedWorkReservations.has(submissionId)) {
            throw new TypeError(`Effectful SubmittedWork ${submissionId} is already retained.`)
        }

        this.#effectfulSubmittedWorkReservations.add(submissionId)
        this.#currentEffectfulSubmittedWork = this.#effectfulSubmittedWorkReservations.size

        let isReleased = false
        const controller = this
        return Object.freeze({
            id: submissionId,
            get isReleased() {

                return isReleased
            },
            release() {

                if (isReleased) return
                isReleased = true
                if (!controller.#effectfulSubmittedWorkReservations.delete(submissionId)) return
                controller.#currentEffectfulSubmittedWork =
                    controller.#effectfulSubmittedWorkReservations.size
            },
        })
    }

    subscribeLifecycle(subscriber: (change: GPURuntimeLifecycleChange) => void): () => void {

        if (this.#isDisposed || this.#owner.isDisposed) {
            subscriber(Object.freeze({ kind: 'runtime-disposed' }))
            return () => {}
        }
        if (this.#owner.isDeviceLost && this.#owner.deviceLostInfo !== undefined) {
            subscriber(Object.freeze({ kind: 'device-lost', info: this.#owner.deviceLostInfo }))
            return () => {}
        }

        this.#lifecycleSubscribers.add(subscriber)
        return () => this.#lifecycleSubscribers.delete(subscriber)
    }

    publishRuntimeDisposal(): void {

        if (this.#isDisposed) return
        this.#publishLifecycleChange(Object.freeze({ kind: 'runtime-disposed' }))
    }

    snapshot(): GPURuntimeDiagnosticsSnapshot {

        const resources = [ ...this.#resourceFacts.values() ]
            .sort((left, right) => left.id.localeCompare(right.id))
        const bindLayouts = [ ...this.#bindLayoutFacts.values() ]
            .sort((left, right) => left.id.localeCompare(right.id))
        const bindSets = [ ...this.#bindSets.values() ]
            .sort((left, right) => left.id.localeCompare(right.id))
            .map(bindSetRuntimeFact)
        const pipelines = [ ...this.#pipelineFacts.values() ]
            .sort((left, right) => left.id.localeCompare(right.id))
        const readbackCommands = [ ...this.#readbackCommandFacts.values() ]
            .sort((left, right) => left.id.localeCompare(right.id))
        const readbacks = [ ...this.#readbackFacts.values() ]
            .sort((left, right) => left.id.localeCompare(right.id))
        const bufferMappings = [ ...this.#bufferMappingFacts.values() ]
            .sort((left, right) => left.id.localeCompare(right.id))
        const pendingOperations = [ ...this.#pendingOperations.values() ]
            .sort((left, right) => left.sequence - right.sequence)
            .map(operation => pendingFact(operation))

        return freezeEvidence({
            version: 5,
            runtime: {
                id: this.#owner.id,
                ...(this.#owner.label !== undefined ? { label: boundedLabel(this.#owner.label) } : {}),
                isDisposed: this.#owner.isDisposed,
                isDeviceLost: this.#owner.isDeviceLost,
            },
            resources,
            bindLayouts,
            bindSets,
            pipelines,
            readbackCommands,
            readbacks,
            bufferMappings,
            pendingOperations,
            pressure: {
                currentScratchLogicalFootprintBytes: this.#currentLogicalFootprintBytes,
                peakScratchLogicalFootprintBytes: this.#peakLogicalFootprintBytes,
                liveResourceCounts: this.#liveResourceCounts(),
            },
            readbackMemory: {
                maxPendingOperations: this.#readbackPolicy.maxPendingOperations,
                maxStagingBytes: this.#readbackPolicy.maxStagingBytes,
                currentStagingBytes: this.#currentReadbackStagingBytes,
                peakStagingBytes: this.#peakReadbackStagingBytes,
                currentRetainedHostBytes: this.#currentRetainedHostBytes,
                peakRetainedHostBytes: this.#peakRetainedHostBytes,
                activeMappings: this.#activeMappings,
                peakActiveMappings: this.#peakActiveMappings,
            },
            bufferMapping: {
                currentMappings: this.#bufferMappingFacts.size,
                peakMappings: this.#peakBufferMappings,
                currentSelectedBytes: this.#currentBufferMappingBytes,
                peakSelectedBytes: this.#peakBufferMappingBytes,
            },
            submissionNative: {
                submissionScopes: this.#options.submissionScopes,
                maxPendingNativeObservations: this.#options.maxPendingNativeObservations,
                currentPendingNativeObservations: this.#currentPendingNativeObservations,
                peakPendingNativeObservations: this.#peakPendingNativeObservations,
                currentEffectfulSubmittedWork: this.#currentEffectfulSubmittedWork,
            },
            recorder: {
                operationCapacity: this.#options.operationCapacity,
                incidentCapacity: this.#options.incidentCapacity,
                evidenceByteCapacity: this.#options.evidenceByteCapacity,
                retainedOperationCount: this.#operations.length,
                retainedIncidentCount: this.#incidents.length,
                retainedEvidenceBytes: this.#retainedEvidenceBytes,
                overwrittenOperations: this.#overwrittenOperations,
                overwrittenIncidents: this.#overwrittenIncidents,
                omittedRecords: this.#omittedRecords,
            },
            aggregates: { ...this.#aggregates },
            capture: {
                activeCount: this.#captures.size,
                maxActiveCaptures: this.#options.maxActiveCaptures,
            },
        })
    }

    operations(query: GPUOperationQuery = {}): readonly GPUOperationRecord[] {

        return Object.freeze(this.#operations
            .map(entry => entry.value)
            .filter(record => matchesOperationQuery(record, query)))
    }

    incidents(query: GPUIncidentQuery = {}): readonly GPUIncidentReport[] {

        return Object.freeze(this.#incidents
            .map(entry => entry.value)
            .filter(report => matchesIncidentQuery(report, query)))
    }

    operation(operationId: string): GPUOperationRecord | undefined {

        return this.#operations.find(entry => entry.value.id === operationId)?.value
    }

    incident(incidentId: string): GPUIncidentReport | undefined {

        return this.#incidents.find(entry => entry.value.id === incidentId)?.value
    }

    exportEvidence(): GPURuntimeDiagnosticsEvidence {

        return freezeEvidence({
            version: 5,
            snapshot: this.snapshot(),
            operations: this.operations(),
            incidents: this.incidents(),
        })
    }

    beginOperation(input: GPUOperationStart): GPUPendingOperation {

        const kind: unknown = input.kind
        assertPendingGpuOperationKind(kind)
        assertGpuOperationTarget(kind, input.target)
        const sequence = ++this.#operationSequence
        const id = `${this.#owner.id}/gpu-operation-${sequence}`
        const activeCaptureStates = [ ...this.#captures ]
            .map(captureStateFor)
            .filter(state => state.isActive)
        const needsStack = activeCaptureStates.some(state => state.options.includeStacks)
        const needsFullDescriptor = activeCaptureStates.some(state => state.options.includeDescriptors)
        const target = freezeEvidence({ ...input.target })
        const targetId = operationTargetId(target)
        const nativeLabel = boundedGpuOperationNativeLabel(input.nativeLabel, targetId)
        const operation: GPUPendingOperation = Object.freeze({
            id,
            sequence,
            runtimeId: this.#owner.id,
            kind,
            target,
            descriptor: createGpuDescriptorEvidence(input.descriptorSummary),
            ...(needsFullDescriptor ? {
                fullDescriptor: createGpuDescriptorEvidence(
                    input.descriptorSummary,
                    input.fullDescriptor
                ),
            } : {}),
            ...(nativeLabel !== undefined ? { nativeLabel } : {}),
            startedAtMs: nowMs(),
            ...(needsStack ? { stack: captureStack() } : {}),
        })

        this.#pendingOperations.set(id, operation)
        if (kind === 'readback-mapping') {
            this.#activeMappings++
            this.#peakActiveMappings = Math.max(this.#peakActiveMappings, this.#activeMappings)
        }
        if (isAllocationAttemptKind(kind)) {
            this.#aggregates = {
                ...this.#aggregates,
                allocationAttempts: this.#aggregates.allocationAttempts + 1,
            }
        } else if (isPipelineCreationKind(kind)) {
            this.#aggregates = {
                ...this.#aggregates,
                pipelineCreationAttempts: this.#aggregates.pipelineCreationAttempts + 1,
            }
        } else if (isReadbackAttemptKind(kind)) {
            this.#aggregates = {
                ...this.#aggregates,
                readbackOperationAttempts: this.#aggregates.readbackOperationAttempts + 1,
            }
        }
        if (kind === 'texture-replacement' && target.kind === 'resource') {
            this.#setPendingReplacement(target.resourceId, id)
        }

        return operation
    }

    completeOperation(
        operation: GPUPendingOperation,
        completion: GPUOperationCompletion
    ): GPUOperationRecord {

        if (this.#pendingOperations.get(operation.id) !== operation) {
            throw new TypeError(`GPU operation ${operation.id} is not pending on this runtime.`)
        }
        const target = validatedCompletionTarget(operation, completion.bindSetTarget)

        const baseInput = {
            sequence: operation.sequence,
            id: operation.id,
            kind: operation.kind,
            status: completion.status,
            runtimeId: operation.runtimeId,
            target,
            descriptor: operation.descriptor,
            ...(operation.nativeLabel !== undefined ? { nativeLabel: operation.nativeLabel } : {}),
            ...(completion.nativeErrorCategory !== undefined
                ? { nativeErrorCategory: completion.nativeErrorCategory }
                : {}),
            ...(completion.incidentId !== undefined ? { incidentId: completion.incidentId } : {}),
            ...(completion.nativeLabels !== undefined ? { nativeLabels: completion.nativeLabels } : {}),
            ...(completion.pipelineCreationReport !== undefined
                ? { pipelineCreationReport: completion.pipelineCreationReport }
                : {}),
            ...(completion.nativeOutcome !== undefined
                ? { nativeOutcome: completion.nativeOutcome }
                : {}),
            startedAtMs: operation.startedAtMs,
            settledAtMs: nowMs(),
        } as const
        const record = createGpuOperationRecord(baseInput)

        this.#pendingOperations.delete(operation.id)
        if (operation.kind === 'readback-mapping') this.#activeMappings--
        if (operation.target.kind === 'resource') {
            this.#clearPendingReplacement(operation.target.resourceId, operation.id)
        }
        this.#completedOperations.add(record)

        this.#recordOperation(record)
        for (const capture of [ ...this.#captures ]) {
            acceptCaptureOperation(capture, operation, completion)
        }
        this.#recordCompletionAggregate(operation, completion)
        if (completion.status === 'succeeded') {
            if (
                operation.target.kind === 'resource' &&
                isResourceAllocationKind(operation.kind)
            ) {
                this.linkResourceOperation(operation.target.resourceId, operation.id)
            }
        }

        return record
    }

    recordReadbackStagingRelease(input: Readonly<{
        target: GPUCommandOperationTarget | GPUReadbackOperationTarget
        descriptorSummary: Record<string, unknown>
        status: 'succeeded' | 'failed'
        nativeErrorCategory?: GPUNativeErrorCategory
    }>): GPUOperationRecord {

        assertGpuOperationTarget('readback-staging-release', input.target)
        const sequence = ++this.#operationSequence
        const settledAtMs = nowMs()
        const record = createGpuOperationRecord({
            sequence,
            id: `${this.#owner.id}/gpu-operation-${sequence}`,
            kind: 'readback-staging-release',
            status: input.status,
            runtimeId: this.#owner.id,
            target: freezeEvidence({ ...input.target }),
            descriptor: createGpuDescriptorEvidence(input.descriptorSummary),
            ...(input.nativeErrorCategory !== undefined
                ? { nativeErrorCategory: input.nativeErrorCategory }
                : {}),
            startedAtMs: settledAtMs,
            settledAtMs,
        })

        this.#recordOperation(record)
        const needsStack = [ ...this.#captures ].some(capture => {
            const state = captureStateFor(capture)
            return state.isActive && state.options.includeStacks
        })
        const stack = needsStack ? captureStack() : undefined
        for (const capture of [ ...this.#captures ]) {
            acceptCaptureInstantOperation(capture, record, stack)
        }

        const next = {
            ...this.#aggregates,
            readbackOperationAttempts: this.#aggregates.readbackOperationAttempts + 1,
            successfulReadbackOperations: this.#aggregates.successfulReadbackOperations +
                (input.status === 'succeeded' ? 1 : 0),
            failedReadbackOperations: this.#aggregates.failedReadbackOperations +
                (input.status === 'failed' ? 1 : 0),
        }
        if (input.nativeErrorCategory === 'native-exception') next.nativeFailures++
        if (input.nativeErrorCategory === 'scope-failure') next.scopeFailures++
        if (input.nativeErrorCategory === 'validation') next.validationFailures++
        if (input.nativeErrorCategory === 'out-of-memory') next.outOfMemoryFailures++
        this.#aggregates = next
        return record
    }

    linkOperationIncident(operationId: string, incidentId: string): void {

        const entry = this.#operations.find(item => item.value.id === operationId)
        if (entry !== undefined) {
            const replacement = createGpuOperationRecord({ ...entry.value, incidentId })
            const bytes = serializedEvidenceBytes(replacement)
            this.#retainedEvidenceBytes += bytes - entry.bytes
            entry.value = replacement
            entry.bytes = bytes
            this.#trimOperationEvidenceToBudget()
        }
        for (const capture of new Set([
            ...this.#captures,
            ...this.#linkableStoppedCaptures,
        ])) {
            linkCaptureOperationIncident(capture, operationId, incidentId)
        }
    }

    recordIncident(input: GPUIncidentInput): GPUIncidentReport {

        const sequence = ++this.#incidentSequence
        const id = `${this.#owner.id}/gpu-incident-${sequence}`
        const target = input.target ?? freezeEvidence({
            kind: 'runtime' as const,
            runtimeId: this.#owner.id,
        })
        const recentOperations = this.#recentOperations(input.operationId)
        const pendingOperations = [ ...this.#pendingOperations.values() ]
            .slice(0, this.#options.recentOperationLimit)
            .map(pendingFact)
        const currentResources = target.kind === 'pipeline'
            ? []
            : this.#largestResourceFacts(this.#options.contributorLimit)
        const currentPipelines = target.kind === 'pipeline' || target.kind === 'runtime'
            ? [ ...this.#pipelineFacts.values() ]
                .sort((left, right) => left.id.localeCompare(right.id))
                .slice(0, this.#options.contributorLimit)
            : []
        const localOmissions = Math.max(0, this.#pendingOperations.size - pendingOperations.length) +
            (target.kind === 'pipeline'
                ? 0
                : Math.max(0, this.#resourceFacts.size - currentResources.length)) +
            (target.kind === 'pipeline' || target.kind === 'runtime'
                ? Math.max(0, this.#pipelineFacts.size - currentPipelines.length)
                : 0)
        const report = createGpuIncidentReport({
            sequence,
            id,
            kind: input.kind,
            diagnosticCode: input.diagnosticCode,
            nativeErrorCategory: input.nativeErrorCategory,
            attribution: input.attribution,
            runtimeId: this.#owner.id,
            target,
            ...(input.operationId !== undefined ? { operationId: input.operationId } : {}),
            ...(input.triggerOperation !== undefined ? { triggerOperation: input.triggerOperation } : {}),
            ...(input.related !== undefined ? { related: input.related } : {}),
            ...(input.nativeError !== undefined ? { nativeError: input.nativeError } : {}),
            recentOperations,
            ...(pendingOperations.length > 0 ? { pendingOperations } : {}),
            ...(currentResources.length > 0 ? { currentResources } : {}),
            ...(currentPipelines.length > 0 ? { currentPipelines } : {}),
            ...((input.kind === 'allocation-failure' || (
                input.kind === 'supporting-object-failure' &&
                input.nativeErrorCategory === 'out-of-memory'
            ))
                ? { pressure: this.#pressureEvidence(input.triggerLogicalFootprintBytes) }
                : {}),
            ...(input.failureStage !== undefined ? { failureStage: input.failureStage } : {}),
            ...(input.pipelineErrorReason !== undefined
                ? { pipelineErrorReason: input.pipelineErrorReason }
                : {}),
            ...(input.pipelineCreationReport !== undefined
                ? { pipelineCreationReport: input.pipelineCreationReport }
                : {}),
            ...(input.shaderModuleCompilationReport !== undefined
                ? { shaderModuleCompilationReport: input.shaderModuleCompilationReport }
                : {}),
            ...(input.outcomes !== undefined ? { outcomes: input.outcomes } : {}),
            ...(input.omittedOutcomeCount !== undefined
                ? { omittedOutcomeCount: input.omittedOutcomeCount }
                : {}),
            evidence: {
                complete: this.#overwrittenOperations === 0 &&
                    this.#overwrittenIncidents === 0 &&
                    this.#omittedRecords === 0 &&
                    localOmissions === 0,
                overwrittenOperations: this.#overwrittenOperations,
                overwrittenIncidents: this.#overwrittenIncidents,
                omittedRecords: this.#omittedRecords + localOmissions,
            },
        })

        this.#recordIncident(report)
        if (input.operationId !== undefined) this.linkOperationIncident(input.operationId, id)
        return report
    }

    recordDeviceLoss(info: NativeGPUDeviceLostInfo): GPUIncidentReport | undefined {

        if (this.#isDisposed) return undefined
        this.#publishLifecycleChange(Object.freeze({ kind: 'device-lost', info }))
        if (this.#deviceLossIncident !== undefined) return this.#deviceLossIncident

        const retainedInfo = this.#owner.deviceLostInfo ?? retainDeviceLostInfo(info)

        this.#aggregates = {
            ...this.#aggregates,
            deviceLosses: this.#aggregates.deviceLosses + 1,
        }
        const hasTemporalEvidence = this.#pendingOperations.size > 0 || this.#operations.length > 0
        this.#deviceLossIncident = this.recordIncident({
            kind: 'device-loss',
            diagnosticCode: this.#pendingOperations.size > 0
                ? 'SCRATCH_RUNTIME_DEVICE_LOST_DURING_GPU_OPERATION'
                : 'SCRATCH_RUNTIME_DEVICE_LOST',
            nativeErrorCategory: 'device-lost',
            attribution: hasTemporalEvidence ? 'temporal-correlation' : 'unknown',
            nativeError: Object.freeze({
                message: retainedInfo.message,
                reason: retainedInfo.reason,
                nativeMessageOmitted: true,
            }),
        })
        return this.#deviceLossIncident
    }

    capture(options: GPUDiagnosticCaptureOptions): GPUDiagnosticCapture {

        if (this.#captures.size >= this.#options.maxActiveCaptures) {
            throwGPUDiagnostic({
                code: 'SCRATCH_DIAGNOSTIC_CAPTURE_LIMIT_EXCEEDED',
                severity: 'error',
                phase: 'runtime',
                subject: this.#runtimeSubject(),
                message: 'GPURuntime has reached its active diagnostic capture limit.',
                expected: { maxActiveCaptures: this.#options.maxActiveCaptures },
                actual: { activeCaptures: this.#captures.size },
            })
        }

        const normalized = normalizeCaptureOptions(this.#owner, options)
        const capture = createDiagnosticCapture({
            id: `${this.#owner.id}/diagnostic-capture-${++this.#captureSequence}`,
            runtimeId: this.#owner.id,
            controller: this,
            options: normalized,
        })
        this.#captures.add(capture)
        return capture
    }

    registerResource(resource: Resource): void {

        this.#resourceFacts.set(resource.id, resourceFact(resource))
        this.#recalculatePressure()
    }

    updateResource(resource: Resource): void {

        const previous = this.#resourceFacts.get(resource.id)
        if (previous === undefined) return
        const next = resourceFact(resource, previous)
        this.#resourceFacts.set(resource.id, next)
        if (isContentRuntimeResourceFact(next) &&
            (!isContentRuntimeResourceFact(previous) ||
                next.logicalFootprintBytes !== previous.logicalFootprintBytes)) {
            this.#recalculatePressure()
        }
    }

    unregisterResource(resource: Resource): void {

        const fact = this.#resourceFacts.get(resource.id)
        this.#resourceFacts.delete(resource.id)
        this.#recalculatePressure()
        if (fact !== undefined) this.#recordResourceDisposal(resource, fact)
    }

    registerBufferMapping(fact: GPURuntimeBufferMappingFact): void {

        if (this.#bufferMappingFacts.has(fact.id)) {
            throw new TypeError(`Buffer mapping ${fact.id} is already registered.`)
        }
        const retained = Object.freeze({ ...fact })
        this.#bufferMappingFacts.set(fact.id, retained)
        this.#currentBufferMappingBytes += retained.size
        this.#peakBufferMappings = Math.max(
            this.#peakBufferMappings,
            this.#bufferMappingFacts.size
        )
        this.#peakBufferMappingBytes = Math.max(
            this.#peakBufferMappingBytes,
            this.#currentBufferMappingBytes
        )
    }

    updateBufferMapping(id: string, state: GPURuntimeBufferMappingFact['state']): void {

        const fact = this.#bufferMappingFacts.get(id)
        if (fact === undefined) throw new TypeError(`Buffer mapping ${id} is not registered.`)
        this.#bufferMappingFacts.set(id, Object.freeze({ ...fact, state }))
    }

    unregisterBufferMapping(id: string): void {

        const fact = this.#bufferMappingFacts.get(id)
        if (fact === undefined) return
        this.#bufferMappingFacts.delete(id)
        this.#currentBufferMappingBytes = Math.max(
            0,
            this.#currentBufferMappingBytes - fact.size
        )
    }

    registerPipeline(registration: GPURuntimePipelineRegistration): void {

        const operation = registration.creationOperation
        if (
            !this.#completedOperations.has(operation) ||
            operation.runtimeId !== this.#owner.id ||
            operation.status !== 'succeeded' ||
            operation.target.kind !== 'pipeline' ||
            operation.pipelineCreationReport === undefined
        ) {
            throw new TypeError('Pipeline registration requires its matching successful creation operation.')
        }
        const target = operation.target
        const expectedKind = target.pipelineKind === 'render'
            ? 'render-pipeline-creation'
            : 'compute-pipeline-creation'
        if (operation.kind !== expectedKind) {
            throw new TypeError('Pipeline registration requires its matching successful creation operation.')
        }
        if (this.#pipelineFacts.has(target.pipelineId)) {
            throw new TypeError(`Pipeline ${target.pipelineId} is already registered.`)
        }
        if (this.#registeredPipelineCreations.has(operation)) {
            throw new TypeError(`Pipeline creation operation ${operation.id} has already been registered.`)
        }
        this.#registeredPipelineCreations.add(operation)
        this.#pipelineFacts.set(target.pipelineId, freezeEvidence({
            id: target.pipelineId,
            ...(registration.label !== undefined ? { label: boundedLabel(registration.label) } : {}),
            pipelineKind: target.pipelineKind,
            programId: target.programId,
            programContractHash: target.programContractHash,
            descriptorHash: operation.descriptor.hash,
            state: 'ready' as const,
            lastCreationOperationId: operation.id,
            stages: operation.pipelineCreationReport.stages,
        }))
    }

    registerReadbackCommand(fact: GPURuntimeReadbackCommandFact): void {

        if (this.#readbackCommandFacts.has(fact.id)) {
            throw new TypeError(`Readback command ${fact.id} is already registered.`)
        }
        this.#readbackCommandFacts.set(fact.id, readbackCommandFact(fact))
    }

    updateReadbackCommand(
        commandId: string,
        update: Partial<Omit<GPURuntimeReadbackCommandFact, 'id'>>
    ): void {

        const previous = this.#readbackCommandFacts.get(commandId)
        if (previous === undefined) throw new TypeError(`Readback command ${commandId} is not registered.`)
        this.#readbackCommandFacts.set(commandId, readbackCommandFact({ ...previous, ...update, id: commandId }))
    }

    unregisterReadbackCommand(commandId: string): void {

        this.#readbackCommandFacts.delete(commandId)
    }

    registerReadbackOperation(fact: GPURuntimeReadbackOperationFact): void {

        if (this.#readbackFacts.has(fact.id)) {
            throw new TypeError(`Readback operation ${fact.id} is already registered.`)
        }
        if (this.#readbackFacts.size >= this.#readbackPolicy.maxPendingOperations) {
            this.#throwReadbackBudget('pending-operations', 1, fact)
        }
        this.#readbackFacts.set(fact.id, readbackOperationFact(fact))
        this.#recalculateReadbackOperationMemory()
    }

    updateReadbackOperation(
        readbackId: string,
        update: Partial<Omit<GPURuntimeReadbackOperationFact, 'id'>>
    ): void {

        const previous = this.#readbackFacts.get(readbackId)
        if (previous === undefined) throw new TypeError(`Readback operation ${readbackId} is not registered.`)
        this.#readbackFacts.set(readbackId, readbackOperationFact({ ...previous, ...update, id: readbackId }))
        this.#recalculateReadbackOperationMemory()
    }

    unregisterReadbackOperation(readbackId: string): void {

        if (!this.#readbackFacts.delete(readbackId)) return
        this.#recalculateReadbackOperationMemory()
    }

    reserveReadbackStaging(reservationId: string, byteLength: number): GPUReadbackStagingReservation {

        if (!Number.isSafeInteger(byteLength) || byteLength <= 0) {
            throw new TypeError('Readback staging byteLength must be a positive safe integer.')
        }
        if (this.#readbackStagingReservations.has(reservationId)) {
            throw new TypeError(`Readback staging reservation ${reservationId} already exists.`)
        }
        if (this.#currentReadbackStagingBytes + byteLength > this.#readbackPolicy.maxStagingBytes) {
            this.#throwReadbackBudget('staging-bytes', byteLength)
        }

        this.#readbackStagingReservations.set(reservationId, byteLength)
        this.#currentReadbackStagingBytes += byteLength
        this.#peakReadbackStagingBytes = Math.max(
            this.#peakReadbackStagingBytes,
            this.#currentReadbackStagingBytes
        )

        let isReleased = false
        const controller = this
        return Object.freeze({
            id: reservationId,
            byteLength,
            get isReleased() {

                return isReleased
            },
            release() {

                if (isReleased) return
                isReleased = true
                const reserved = controller.#readbackStagingReservations.get(reservationId)
                if (reserved === undefined) return
                controller.#readbackStagingReservations.delete(reservationId)
                controller.#currentReadbackStagingBytes -= reserved
            },
        })
    }

    unregisterPipeline(pipelineId: string): void {

        const fact = this.#pipelineFacts.get(pipelineId)
        if (fact === undefined) return
        this.#pipelineFacts.delete(pipelineId)
        this.#aggregates = {
            ...this.#aggregates,
            pipelineDisposals: this.#aggregates.pipelineDisposals + 1,
        }

        const sequence = ++this.#operationSequence
        const settledAtMs = nowMs()
        const record = createGpuOperationRecord({
            sequence,
            id: `${this.#owner.id}/gpu-operation-${sequence}`,
            kind: 'pipeline-disposal',
            status: 'succeeded',
            runtimeId: this.#owner.id,
            target: {
                kind: 'pipeline',
                pipelineId: fact.id,
                pipelineKind: fact.pipelineKind,
                programId: fact.programId,
                programContractHash: fact.programContractHash,
            },
            descriptor: createGpuDescriptorEvidence({
                descriptorHash: fact.descriptorHash,
                pipelineKind: fact.pipelineKind,
            }),
            startedAtMs: settledAtMs,
            settledAtMs,
        })
        this.#recordOperation(record)
        const needsStack = [ ...this.#captures ].some(capture => {
            const state = captureStateFor(capture)
            return state.isActive && state.options.includeStacks
        })
        const stack = needsStack ? captureStack() : undefined
        for (const capture of [ ...this.#captures ]) {
            acceptCaptureInstantOperation(capture, record, stack)
        }
    }

    #recordResourceDisposal(resource: Resource, fact: GPURuntimeResourceFact): void {

        if (fact.resourceKind !== 'BufferResource' && fact.resourceKind !== 'TextureResource') return
        const sequence = ++this.#operationSequence
        const id = `${this.#owner.id}/gpu-operation-${sequence}`
        const settledAtMs = nowMs()
        const descriptor = createGpuDescriptorEvidence(resourceDescriptorSummary(resource))
        const record = createGpuOperationRecord({
            sequence,
            id,
            kind: 'resource-disposal',
            status: 'succeeded',
            runtimeId: this.#owner.id,
            target: {
                kind: 'resource',
                resourceId: fact.id,
                resourceKind: fact.resourceKind,
                allocationVersion: fact.allocationVersion,
                contentEpoch: fact.contentEpoch,
                logicalFootprintBytes: fact.logicalFootprintBytes,
            },
            descriptor,
            startedAtMs: settledAtMs,
            settledAtMs,
        })

        this.#recordOperation(record)
        const needsStack = [ ...this.#captures ].some(capture => {
            const state = captureStateFor(capture)
            return state.isActive && state.options.includeStacks
        })
        const stack = needsStack ? captureStack() : undefined
        for (const capture of [ ...this.#captures ]) {
            acceptCaptureInstantOperation(capture, record, stack)
        }
    }

    linkResourceOperation(resourceId: string, operationId: string): void {

        const fact = this.#resourceFacts.get(resourceId)
        if (fact === undefined) return
        this.#resourceFacts.set(resourceId, Object.freeze({
            ...fact,
            lastAllocationOperationId: operationId,
        }))
    }

    registerBindLayout(
        layout: BindLayout,
        creationOperationId: string
    ): void {

        if (this.#bindLayoutFacts.has(layout.id)) {
            throw new TypeError(`BindLayout ${layout.id} is already registered.`)
        }
        this.#bindLayoutFacts.set(layout.id, Object.freeze({
            id: layout.id,
            ...(layout.label !== undefined ? { label: boundedLabel(layout.label) } : {}),
            group: layout.group,
            entries: freezeEvidence(layout.entries),
            origin: layout.origin,
            validationConfidence: layout.validationConfidence,
            ...(layout.sourcePipelineId !== undefined
                ? { sourcePipelineId: layout.sourcePipelineId }
                : {}),
            acknowledgementState: 'acknowledged',
            lastAllocationOperationId: creationOperationId,
        }))
    }

    unregisterBindLayout(layout: BindLayout): void {

        this.#bindLayoutFacts.delete(layout.id)
    }

    registerBindSet(bindSet: BindSet): void {

        if (this.#bindSets.has(bindSet.id)) {
            throw new TypeError(`BindSet ${bindSet.id} is already registered.`)
        }
        this.#bindSets.set(bindSet.id, bindSet)
    }

    unregisterBindSet(bindSet: BindSet): void {

        this.#bindSets.delete(bindSet.id)
    }

    dispose(): void {

        if (this.#isDisposed) return
        this.publishRuntimeDisposal()
        this.#isDisposed = true
        if (this.#uncapturedErrorListener !== undefined && typeof this.#device.removeEventListener === 'function') {
            this.#device.removeEventListener('uncapturederror', this.#uncapturedErrorListener)
        }
        for (const capture of [ ...this.#captures ]) stopCapture(capture, 'runtime-disposed')
        this.#readbackCommandFacts.clear()
        this.#bindLayoutFacts.clear()
        this.#bindSets.clear()
        this.#readbackFacts.clear()
        this.#bufferMappingFacts.clear()
        this.#readbackStagingReservations.clear()
        this.#submissionNativeObservationReservations.clear()
        this.#effectfulSubmittedWorkReservations.clear()
        this.#currentReadbackStagingBytes = 0
        this.#currentRetainedHostBytes = 0
        this.#currentBufferMappingBytes = 0
        this.#currentPendingNativeObservations = 0
        this.#currentEffectfulSubmittedWork = 0
    }

    #publishLifecycleChange(change: GPURuntimeLifecycleChange): void {

        const subscribers = [ ...this.#lifecycleSubscribers ]
        this.#lifecycleSubscribers.clear()
        for (const subscriber of subscribers) subscriber(change)
    }

    captureStopped(capture: GPUDiagnosticCapture, reason: GPUDiagnosticCaptureStopReason): void {

        this.#captures.delete(capture)
        if (reason === 'operation-limit') {
            this.#linkableStoppedCaptures.add(capture)
            queueMicrotask(() => this.#linkableStoppedCaptures.delete(capture))
        }
        if (reason === 'evidence-limit') {
            this.recordIncident({
                kind: 'capture-degraded',
                diagnosticCode: 'SCRATCH_DIAGNOSTIC_CAPTURE_DEGRADED',
                nativeErrorCategory: 'none',
                attribution: 'unknown',
            })
        }
    }

    #installUncapturedErrorListener(): void {

        if (typeof this.#device.addEventListener !== 'function') return
        this.#uncapturedErrorListener = event => {
            if (this.#isDisposed) return
            this.#aggregates = {
                ...this.#aggregates,
                uncapturedErrors: this.#aggregates.uncapturedErrors + 1,
            }
            const recent = this.#operations.at(-1)?.value
            const attribution = recent !== undefined || this.#pendingOperations.size > 0
                ? 'temporal-correlation'
                : 'unknown'
            this.recordIncident({
                kind: 'uncaptured-error',
                diagnosticCode: 'SCRATCH_RUNTIME_UNCAPTURED_GPU_ERROR',
                nativeErrorCategory: 'uncaptured-error',
                attribution,
                ...(recent !== undefined ? { operationId: recent.id } : {}),
                nativeError: serializeNativeGpuError(event.error),
            })
        }
        this.#device.addEventListener('uncapturederror', this.#uncapturedErrorListener)
    }

    #recordOperation(record: GPUOperationRecord): void {

        if (this.#options.operationCapacity === 0) {
            this.#omittedRecords++
            return
        }

        const bytes = serializedEvidenceBytes(record)
        if (bytes > this.#options.evidenceByteCapacity) {
            this.#omittedRecords++
            return
        }

        while (this.#operations.length >= this.#options.operationCapacity) {
            this.#evictOldestOperation()
        }
        while (
            this.#retainedEvidenceBytes + bytes > this.#options.evidenceByteCapacity &&
            this.#operations.length > 0
        ) {
            this.#evictOldestOperation()
        }
        if (this.#retainedEvidenceBytes + bytes > this.#options.evidenceByteCapacity) {
            this.#omittedRecords++
            return
        }

        this.#operations.push({ value: record, bytes })
        this.#retainedEvidenceBytes += bytes
    }

    #recordIncident(report: GPUIncidentReport): void {

        if (this.#options.incidentCapacity === 0) {
            this.#omittedRecords++
            return
        }

        const bytes = serializedEvidenceBytes(report)
        if (bytes > this.#options.evidenceByteCapacity) {
            this.#omittedRecords++
            return
        }

        while (this.#incidents.length >= this.#options.incidentCapacity) {
            this.#evictOldestIncident()
        }
        while (
            this.#retainedEvidenceBytes + bytes > this.#options.evidenceByteCapacity &&
            this.#operations.length > 0
        ) {
            this.#evictOldestOperation()
        }
        while (
            this.#retainedEvidenceBytes + bytes > this.#options.evidenceByteCapacity &&
            this.#incidents.length > 0
        ) {
            this.#evictOldestIncident()
        }
        if (this.#retainedEvidenceBytes + bytes > this.#options.evidenceByteCapacity) {
            this.#omittedRecords++
            return
        }

        this.#incidents.push({ value: report, bytes })
        this.#retainedEvidenceBytes += bytes
    }

    #evictOldestOperation(): void {

        const removed = this.#operations.shift()
        if (removed === undefined) return
        this.#retainedEvidenceBytes -= removed.bytes
        this.#overwrittenOperations++
    }

    #evictOldestIncident(): void {

        const removed = this.#incidents.shift()
        if (removed === undefined) return
        this.#retainedEvidenceBytes -= removed.bytes
        this.#overwrittenIncidents++
    }

    #trimOperationEvidenceToBudget(): void {

        while (
            this.#retainedEvidenceBytes > this.#options.evidenceByteCapacity &&
            this.#operations.length > 0
        ) {
            this.#evictOldestOperation()
        }
    }

    #recordCompletionAggregate(
        operation: GPUPendingOperation,
        completion: GPUOperationCompletion
    ): void {

        const next = { ...this.#aggregates }
        if (isAllocationAttemptKind(operation.kind)) {
            if (completion.status === 'succeeded') next.successfulAllocations++
            if (completion.status === 'cancelled') next.cancelledAllocations++
        } else if (isPipelineCreationKind(operation.kind)) {
            if (completion.status === 'succeeded') next.successfulPipelineCreations++
            if (completion.status === 'failed') next.failedPipelineCreations++
            if (completion.status === 'cancelled') next.cancelledPipelineCreations++
        } else if (isReadbackAttemptKind(operation.kind)) {
            if (completion.status === 'succeeded') next.successfulReadbackOperations++
            if (completion.status === 'failed') next.failedReadbackOperations++
            if (completion.status === 'cancelled') next.cancelledReadbackOperations++
        }
        if (completion.nativeErrorCategory === 'validation') next.validationFailures++
        if (completion.nativeErrorCategory === 'out-of-memory') next.outOfMemoryFailures++
        if (completion.nativeErrorCategory === 'native-exception') next.nativeFailures++
        if (completion.nativeErrorCategory === 'scope-failure') next.scopeFailures++
        this.#aggregates = next
    }

    #recentOperations(operationId?: string): GPUOperationRecord[] {

        const recent = this.#operations
            .slice(-this.#options.recentOperationLimit)
            .map(entry => entry.value)
        if (operationId === undefined || recent.some(record => record.id === operationId)) return recent
        const trigger = this.operation(operationId)
        if (trigger === undefined) return recent
        return [ trigger, ...recent ].slice(-this.#options.recentOperationLimit)
    }

    #pressureEvidence(triggerLogicalFootprintBytes?: number): GPUPressureEvidence {

        const largestContributors = this.#largestResourceFacts(this.#options.contributorLimit)
            .map(fact => ({
                resourceId: fact.id,
                resourceKind: fact.resourceKind,
                logicalFootprintBytes: fact.logicalFootprintBytes,
                ...(fact.label !== undefined ? { label: boundedLabel(fact.label) } : {}),
                allocationVersion: fact.allocationVersion,
            }))
        const recentChurn = this.#operations
            .flatMap(({ value }) => {
                const target = value.target
                if (
                    target.kind !== 'resource' ||
                    !isResourceChurnKind(value.kind) ||
                    (target.resourceKind !== 'BufferResource' && target.resourceKind !== 'TextureResource')
                ) return []
                return [ {
                    sequence: value.sequence,
                    operationId: value.id,
                    operationKind: value.kind,
                    status: value.status,
                    resourceId: target.resourceId,
                    logicalFootprintBytes: target.logicalFootprintBytes,
                } ]
            })
            .slice(-this.#options.recentOperationLimit)

        return freezeEvidence({
            ...(triggerLogicalFootprintBytes !== undefined ? { triggerLogicalFootprintBytes } : {}),
            currentScratchLogicalFootprintBytes: this.#currentLogicalFootprintBytes,
            peakScratchLogicalFootprintBytes: this.#peakLogicalFootprintBytes,
            liveResourceCounts: this.#liveResourceCounts(),
            largestContributors,
            recentChurn,
            caveats: [
                'Scratch observes only Scratch-owned logical allocations.',
                'Logical footprint is not physical GPU residency.',
                'The triggering operation is not necessarily the sole OOM cause.',
                'Browser, driver, tab, process, and system allocations are unknown.',
            ],
        })
    }

    #largestResourceFacts(limit: number): GPURuntimeContentResourceFact[] {

        return [ ...this.#resourceFacts.values() ]
            .filter(isContentRuntimeResourceFact)
            .sort((left, right) =>
                right.logicalFootprintBytes - left.logicalFootprintBytes ||
                left.id.localeCompare(right.id)
            )
            .slice(0, limit)
    }

    #liveResourceCounts(): Readonly<Record<string, number>> {

        const counts: Record<string, number> = {}
        for (const fact of this.#resourceFacts.values()) {
            counts[fact.resourceKind] = (counts[fact.resourceKind] ?? 0) + 1
        }
        return Object.freeze(Object.keys(counts).sort().reduce<Record<string, number>>((result, key) => {
            result[key] = counts[key]
            return result
        }, {}))
    }

    #recalculatePressure(): void {

        this.#currentLogicalFootprintBytes = [ ...this.#resourceFacts.values() ]
            .filter(isContentRuntimeResourceFact)
            .reduce((total, fact) => total + fact.logicalFootprintBytes, 0)
        this.#peakLogicalFootprintBytes = Math.max(
            this.#peakLogicalFootprintBytes,
            this.#currentLogicalFootprintBytes
        )
    }

    #recalculateReadbackOperationMemory(): void {

        this.#currentRetainedHostBytes = [ ...this.#readbackFacts.values() ]
            .reduce((total, fact) => total + fact.retainedHostBytes, 0)
        this.#peakRetainedHostBytes = Math.max(
            this.#peakRetainedHostBytes,
            this.#currentRetainedHostBytes
        )
    }

    #throwReadbackBudget(
        kind: 'pending-operations' | 'staging-bytes',
        requested: number,
        fact?: GPURuntimeReadbackOperationFact
    ): never {

        const isPending = kind === 'pending-operations'
        const target = isPending && fact !== undefined
            ? readbackTargetFromFact(fact)
            : undefined
        const incident = target === undefined
            ? undefined
            : this.recordIncident({
                kind: 'readback-failure',
                diagnosticCode: 'SCRATCH_READBACK_STAGING_BUDGET_EXCEEDED',
                nativeErrorCategory: 'none',
                attribution: 'exact-operation',
                target,
                failureStage: 'budget',
            })
        const subject: GPUDiagnosticSubjectDraft = fact === undefined
            ? this.#runtimeSubject()
            : {
                kind: 'ReadbackOperation',
                id: fact.id,
                ...(fact.label !== undefined ? { label: boundedLabel(fact.label) } : {}),
            }
        const related: ScratchDiagnosticSubject[] = fact === undefined
            ? []
            : [
                this.#runtimeSubject(),
                { kind: 'Resource', id: fact.sourceResourceId },
                ...(fact.commandId !== undefined
                    ? [ { kind: 'Command' as const, id: fact.commandId, commandKind: 'readback' } ]
                    : []),
                ...(fact.submissionId !== undefined
                    ? [ { kind: 'Submission' as const, id: fact.submissionId } ]
                    : []),
            ]
        throwGPUDiagnostic({
            code: 'SCRATCH_READBACK_STAGING_BUDGET_EXCEEDED',
            severity: 'error',
            phase: 'readback',
            subject,
            ...(related.length > 0 ? { related } : {}),
            message: isPending
                ? 'GPURuntime readback pending-operation budget is exhausted.'
                : 'GPURuntime readback staging-byte budget is exhausted.',
            expected: isPending
                ? { maxPendingOperations: this.#readbackPolicy.maxPendingOperations }
                : { maxStagingBytes: this.#readbackPolicy.maxStagingBytes },
            actual: isPending
                ? {
                    currentPendingOperations: this.#readbackFacts.size,
                    requested,
                    ...(fact !== undefined ? { readbackId: fact.id } : {}),
                }
                : { currentStagingBytes: this.#currentReadbackStagingBytes, requested },
        }, { ...(incident !== undefined ? { incident } : {}) })
    }

    #setPendingReplacement(resourceId: string, operationId: string): void {

        const fact = this.#resourceFacts.get(resourceId)
        if (fact === undefined) return
        this.#resourceFacts.set(resourceId, Object.freeze({
            ...fact,
            pendingReplacementOperationId: operationId,
        }))
    }

    #clearPendingReplacement(resourceId: string, operationId: string): void {

        const fact = this.#resourceFacts.get(resourceId)
        if (fact?.pendingReplacementOperationId !== operationId) return
        const { pendingReplacementOperationId: _pending, ...rest } = fact
        this.#resourceFacts.set(resourceId, Object.freeze(rest))
    }

    #runtimeSubject(): ScratchDiagnosticSubject {

        return {
            kind: 'GPURuntime',
            id: this.#owner.id,
            ...(this.#owner.label !== undefined ? { label: boundedLabel(this.#owner.label) } : {}),
        }
    }
}

function immutableTextureReadbackSubresource(
    fact: NonNullable<GPURuntimeReadbackOperationFact['textureSubresource']>
): NonNullable<GPURuntimeReadbackOperationFact['textureSubresource']> {

    return Object.freeze({
        format: fact.format,
        mipLevel: fact.mipLevel,
        origin: Object.freeze({ ...fact.origin }),
        size: Object.freeze({ ...fact.size }),
        aspect: fact.aspect,
    })
}

function readbackTargetFromFact(
    fact: GPURuntimeReadbackOperationFact
): GPUReadbackOperationTarget {

    return Object.freeze({
        kind: 'readback',
        readbackId: fact.id,
        path: fact.path,
        ...(fact.sourceKind !== undefined ? { sourceKind: fact.sourceKind } : {}),
        sourceResourceId: fact.sourceResourceId,
        allocationVersion: fact.allocationVersion,
        contentEpoch: fact.contentEpoch,
        byteLength: fact.byteLength,
        ...(fact.stagingByteLength !== undefined
            ? { stagingByteLength: fact.stagingByteLength }
            : {}),
        ...(fact.textureSubresource !== undefined
            ? { textureSubresource: immutableTextureReadbackSubresource(fact.textureSubresource) }
            : {}),
        ...(fact.commandId !== undefined ? { commandId: fact.commandId } : {}),
        ...(fact.submissionId !== undefined ? { submissionId: fact.submissionId } : {}),
        ...(fact.stepIndex !== undefined ? { stepIndex: fact.stepIndex } : {}),
    })
}

export function registerRuntimeDiagnostics(
    runtime: object,
    controller: GPURuntimeDiagnosticsController
): void {

    controllerByRuntime.set(runtime, controller)
}

export function diagnosticsControllerFor(runtime: object): GPURuntimeDiagnosticsController {

    const controller = controllerByRuntime.get(runtime)
    if (controller === undefined) throw new TypeError('GPURuntime diagnostics are unavailable.')
    return controller
}

export function updateRuntimeResourceFact(runtime: object, resource: Resource): void {

    controllerByRuntime.get(runtime)?.updateResource(resource)
}

function createDiagnosticsFacade(
    controller: GPURuntimeDiagnosticsController
): GPURuntimeDiagnostics {

    const Constructor = GPURuntimeDiagnostics as unknown as new (
        token: symbol,
        controller: GPURuntimeDiagnosticsController
    ) => GPURuntimeDiagnostics
    return new Constructor(diagnosticsFacadeToken, controller)
}

function createDiagnosticCapture(input: {
    id: string
    runtimeId: string
    controller: GPURuntimeDiagnosticsController
    options: NormalizedGPUDiagnosticCaptureOptions
}): GPUDiagnosticCapture {

    const Constructor = GPUDiagnosticCapture as unknown as new (token: symbol) => GPUDiagnosticCapture
    const capture = new Constructor(diagnosticCaptureToken)
    const state: CaptureState = {
        ...input,
        operations: [],
        retainedEvidenceBytes: 0,
        budgetedEvidenceBytes: 0,
        omittedOperations: 0,
        startedAtMs: nowMs(),
        timer: undefined,
        isActive: true,
    }
    captureStates.set(capture, state)
    state.timer = setTimeout(() => stopCapture(capture, 'duration-limit'), input.options.maxDurationMs)
    const timer = state.timer as unknown as { unref?: () => void }
    timer.unref?.()
    return capture
}

function acceptCaptureOperation(
    capture: GPUDiagnosticCapture,
    operation: GPUPendingOperation,
    completion: GPUOperationCompletion
): void {

    const state = captureStateFor(capture)
    if (!state.isActive) return

    const record = createGpuOperationRecord({
        sequence: operation.sequence,
        id: operation.id,
        kind: operation.kind,
        status: completion.status,
        runtimeId: operation.runtimeId,
        target: operation.target,
        descriptor: state.options.includeDescriptors && operation.fullDescriptor !== undefined
            ? operation.fullDescriptor
            : operation.descriptor,
        ...(operation.nativeLabel !== undefined ? { nativeLabel: operation.nativeLabel } : {}),
        ...(completion.nativeErrorCategory !== undefined
            ? { nativeErrorCategory: completion.nativeErrorCategory }
            : {}),
        ...(completion.incidentId !== undefined ? { incidentId: completion.incidentId } : {}),
        ...(completion.nativeLabels !== undefined ? { nativeLabels: completion.nativeLabels } : {}),
        ...(completion.pipelineCreationReport !== undefined
            ? { pipelineCreationReport: completion.pipelineCreationReport }
            : {}),
        ...(completion.nativeOutcome !== undefined
            ? { nativeOutcome: completion.nativeOutcome }
            : {}),
        startedAtMs: operation.startedAtMs,
        settledAtMs: nowMs(),
        ...(state.options.includeStacks && operation.stack !== undefined ? { stack: operation.stack } : {}),
    })
    retainCaptureRecord(capture, state, record)
}

function acceptCaptureInstantOperation(
    capture: GPUDiagnosticCapture,
    record: GPUOperationRecord,
    stack?: string
): void {

    const state = captureStateFor(capture)
    if (!state.isActive) return
    const captureRecord = state.options.includeStacks && stack !== undefined
        ? createGpuOperationRecord({ ...record, stack })
        : record
    retainCaptureRecord(capture, state, captureRecord)
}

function linkCaptureOperationIncident(
    capture: GPUDiagnosticCapture,
    operationId: string,
    incidentId: string
): void {

    const state = captureStateFor(capture)
    const records = state.report?.operations ?? state.operations
    const index = records.findIndex(record => record.id === operationId)
    if (index < 0) return

    const previous = records[index]
    const replacement = createGpuOperationRecord({ ...previous, incidentId })
    const nextBytes = state.retainedEvidenceBytes -
        serializedEvidenceBytes(previous) +
        serializedEvidenceBytes(replacement)
    if (
        nextBytes > state.options.maxEvidenceBytes ||
        nextBytes > state.budgetedEvidenceBytes
    ) return

    const nextRecords = [ ...records ]
    nextRecords[index] = replacement
    state.retainedEvidenceBytes = nextBytes
    if (state.report === undefined) {
        state.operations = nextRecords
        return
    }
    state.report = freezeEvidence({
        ...state.report,
        operations: nextRecords,
        retainedEvidenceBytes: nextBytes,
    })
}

function retainCaptureRecord(
    capture: GPUDiagnosticCapture,
    state: CaptureState,
    record: GPUOperationRecord
): void {

    const bytes = serializedEvidenceBytes(record)
    const budgetedBytes = bytes + CAPTURE_INCIDENT_LINK_RESERVE_BYTES

    if (state.budgetedEvidenceBytes + budgetedBytes > state.options.maxEvidenceBytes) {
        state.omittedOperations++
        stopCapture(capture, 'evidence-limit')
        return
    }

    state.operations.push(record)
    state.retainedEvidenceBytes += bytes
    state.budgetedEvidenceBytes += budgetedBytes
    if (state.operations.length >= state.options.maxOperations) {
        stopCapture(capture, 'operation-limit')
    }
}

function stopCapture(
    capture: GPUDiagnosticCapture,
    reason: GPUDiagnosticCaptureStopReason
): GPUDiagnosticCaptureReport {

    const state = captureStateFor(capture)
    if (state.report !== undefined) return state.report

    state.isActive = false
    if (state.timer !== undefined) clearTimeout(state.timer)
    state.timer = undefined
    state.report = freezeEvidence({
        version: 5,
        id: state.id,
        runtimeId: state.runtimeId,
        stopReason: reason,
        operations: [ ...state.operations ],
        retainedEvidenceBytes: state.retainedEvidenceBytes,
        omittedOperations: state.omittedOperations,
        startedAtMs: state.startedAtMs,
        stoppedAtMs: nowMs(),
    })
    state.operations = []
    const controller = state.controller
    state.controller = undefined
    controller?.captureStopped(capture, reason)
    return state.report
}

function captureStateFor(capture: GPUDiagnosticCapture): CaptureState {

    const state = captureStates.get(capture)
    if (state === undefined) throw new TypeError('GPUDiagnosticCapture state is unavailable.')
    return state
}

export function normalizeGPURuntimeDiagnosticsOptions(
    options: GPURuntimeDiagnosticsOptions = {},
    label?: string
): NormalizedGPURuntimeDiagnosticsOptions {

    const owner: DiagnosticsOptionOwner = {
        ...(label !== undefined ? { label } : {}),
    }
    return Object.freeze({
        operationCapacity: finiteIntegerOption(owner, options.operationCapacity, 'operationCapacity', 0, DEFAULT_OPERATION_CAPACITY),
        incidentCapacity: finiteIntegerOption(owner, options.incidentCapacity, 'incidentCapacity', 0, DEFAULT_INCIDENT_CAPACITY),
        evidenceByteCapacity: finiteIntegerOption(owner, options.evidenceByteCapacity, 'evidenceByteCapacity', 0, DEFAULT_EVIDENCE_BYTE_CAPACITY),
        recentOperationLimit: finiteIntegerOption(owner, options.recentOperationLimit, 'recentOperationLimit', 1, DEFAULT_RECENT_OPERATION_LIMIT),
        contributorLimit: finiteIntegerOption(owner, options.contributorLimit, 'contributorLimit', 1, DEFAULT_CONTRIBUTOR_LIMIT),
        maxActiveCaptures: finiteIntegerOption(owner, options.maxActiveCaptures, 'maxActiveCaptures', 1, DEFAULT_MAX_ACTIVE_CAPTURES),
        submissionScopes: submissionScopesOption(owner, options.submissionScopes),
        maxPendingNativeObservations: submissionNativeIntegerOption(
            owner,
            options.maxPendingNativeObservations,
            'maxPendingNativeObservations',
            DEFAULT_MAX_PENDING_NATIVE_OBSERVATIONS
        ),
    })
}

type DiagnosticsOptionOwner = Readonly<{
    id?: string
    label?: string
}>

function submissionScopesOption(
    owner: DiagnosticsOptionOwner,
    value: unknown
): GPUSubmissionScopeMode {

    if (value === undefined) return 'summary'
    if (value === 'summary' || value === 'off') return value
    throwSubmissionNativePolicyOption(owner, 'submissionScopes', value, 'summary | off')
}

function submissionNativeIntegerOption(
    owner: DiagnosticsOptionOwner,
    value: unknown,
    name: string,
    fallback: number
): number {

    if (value === undefined) return fallback
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1) return value
    throwSubmissionNativePolicyOption(owner, name, value, 'safe integer >= 1')
}

function normalizeCaptureOptions(
    owner: DiagnosticsOptionOwner,
    options: GPUDiagnosticCaptureOptions
): NormalizedGPUDiagnosticCaptureOptions {

    return Object.freeze({
        maxOperations: finiteIntegerOption(owner, options.maxOperations, 'maxOperations', 1, DEFAULT_CAPTURE_MAX_OPERATIONS),
        maxDurationMs: finiteNumberOption(owner, options.maxDurationMs, 'maxDurationMs', DEFAULT_CAPTURE_MAX_DURATION_MS),
        maxEvidenceBytes: finiteIntegerOption(owner, options.maxEvidenceBytes, 'maxEvidenceBytes', 1, DEFAULT_CAPTURE_MAX_EVIDENCE_BYTES),
        includeStacks: options.includeStacks === true,
        includeDescriptors: options.includeDescriptors === true,
        ...(options.nativeSubmissionDetail !== undefined
            ? { nativeSubmissionDetail: nativeSubmissionDetailOption(owner, options.nativeSubmissionDetail) }
            : {}),
    })
}

function nativeSubmissionDetailOption(
    owner: DiagnosticsOptionOwner,
    value: unknown
): 'step' {

    if (value === 'step') return value
    throwDiagnosticsOption(owner, 'nativeSubmissionDetail', value, 'step')
}

function finiteIntegerOption(
    owner: DiagnosticsOptionOwner,
    value: unknown,
    name: string,
    minimum: number,
    fallback: number
): number {

    if (value === undefined) return fallback
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum) return value
    throwDiagnosticsOption(owner, name, value, `safe integer >= ${minimum}`)
}

function finiteNumberOption(
    owner: DiagnosticsOptionOwner,
    value: unknown,
    name: string,
    fallback: number
): number {

    if (value === undefined) return fallback
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
    throwDiagnosticsOption(owner, name, value, 'finite number > 0')
}

function throwDiagnosticsOption(
    owner: DiagnosticsOptionOwner,
    name: string,
    value: unknown,
    expected: string
): never {

    throwGPUDiagnostic({
        code: 'SCRATCH_RESOURCE_DESCRIPTOR_INVALID',
        severity: 'error',
        phase: 'runtime',
        subject: {
            kind: 'GPURuntime',
            ...(owner.id !== undefined ? { id: owner.id } : {}),
            ...(owner.label !== undefined ? { label: owner.label } : {}),
        },
        message: `GPURuntime diagnostic option ${name} is invalid.`,
        expected: { [name]: expected },
        actual: { [name]: value },
    })
}

function throwSubmissionNativePolicyOption(
    owner: DiagnosticsOptionOwner,
    name: string,
    value: unknown,
    expected: string
): never {

    throwGPUDiagnostic({
        code: 'SCRATCH_SUBMISSION_NATIVE_POLICY_INVALID',
        severity: 'error',
        phase: 'runtime',
        subject: {
            kind: 'GPURuntime',
            ...(owner.id !== undefined ? { id: owner.id } : {}),
            ...(owner.label !== undefined ? { label: owner.label } : {}),
        },
        message: `GPURuntime submission native policy option ${name} is invalid.`,
        expected: { [name]: expected },
        actual: { [name]: value },
    })
}

function bindSetRuntimeFact(bindSet: BindSet): GPURuntimeBindSetFact {

    return Object.freeze({
        id: bindSet.id,
        ...(bindSet.label !== undefined ? { label: boundedLabel(bindSet.label) } : {}),
        bindLayoutId: bindSet.layout.id,
        preparationState: bindSet.preparationState,
        prepareGeneration: bindSet.prepareGeneration,
        ...(bindSet.preparedSnapshotHash !== undefined
            ? { preparedSnapshotHash: bindSet.preparedSnapshotHash }
            : {}),
        ...(bindSet.inFlightOperationId !== undefined
            ? { inFlightOperationId: bindSet.inFlightOperationId }
            : {}),
        ...(bindSet.lastPreparationOperationId !== undefined
            ? { lastPreparationOperationId: bindSet.lastPreparationOperationId }
            : {}),
        ...(bindSet.lastIncidentId !== undefined
            ? { lastIncidentId: bindSet.lastIncidentId }
            : {}),
    })
}

function pendingFact(operation: GPUPendingOperation): GPUPendingOperationFact {

    return Object.freeze({
        id: operation.id,
        sequence: operation.sequence,
        kind: operation.kind,
        target: operation.target,
        descriptorHash: operation.descriptor.hash,
        startedAtMs: operation.startedAtMs,
    })
}

function isResourceAllocationKind(kind: GPUOperationKind): boolean {

    return kind === 'buffer-allocation' ||
        kind === 'texture-allocation' ||
        kind === 'texture-replacement' ||
        kind === 'sampler-allocation' ||
        kind === 'query-set-allocation'
}

function isAllocationAttemptKind(kind: GPUOperationKind): boolean {

    return isResourceAllocationKind(kind) ||
        kind === 'bind-layout-allocation' ||
        kind === 'bind-set-preparation'
}

function isPipelineCreationKind(kind: GPUOperationKind): boolean {

    return kind === 'render-pipeline-creation' || kind === 'compute-pipeline-creation'
}

function isReadbackAttemptKind(kind: GPUOperationKind): boolean {

    return kind === 'readback-staging-allocation' ||
        kind === 'readback-mapping' ||
        kind === 'readback-native-observation'
}

function isResourceChurnKind(kind: GPUOperationKind): boolean {

    return isResourceAllocationKind(kind) || kind === 'resource-disposal'
}

function assertPendingGpuOperationKind(
    kind: unknown
): asserts kind is GPUPendingOperationKind {

    if (
        kind === 'buffer-allocation' ||
        kind === 'texture-allocation' ||
        kind === 'texture-replacement' ||
        kind === 'sampler-allocation' ||
        kind === 'query-set-allocation' ||
        kind === 'bind-layout-allocation' ||
        kind === 'bind-set-preparation' ||
        kind === 'shader-module-creation' ||
        kind === 'render-bundle-creation' ||
        kind === 'render-pipeline-creation' ||
        kind === 'compute-pipeline-creation' ||
        kind === 'readback-staging-allocation' ||
        kind === 'readback-mapping' ||
        kind === 'buffer-mapping' ||
        kind === 'readback-native-observation' ||
        kind === 'submission-native-observation'
    ) return
    throw new TypeError(`GPU operation ${String(kind)} cannot be pending.`)
}

function readbackCommandFact(
    fact: GPURuntimeReadbackCommandFact
): GPURuntimeReadbackCommandFact {

    return Object.freeze({
        id: fact.id,
        ...(fact.label !== undefined ? { label: boundedLabel(fact.label) } : {}),
        sourceResourceId: fact.sourceResourceId,
        allocationVersion: fact.allocationVersion,
        contentEpoch: fact.contentEpoch,
        byteLength: fact.byteLength,
        state: fact.state,
        ...(fact.stagingAllocationOperationId !== undefined
            ? { stagingAllocationOperationId: fact.stagingAllocationOperationId }
            : {}),
    })
}

function readbackOperationFact(
    fact: GPURuntimeReadbackOperationFact
): GPURuntimeReadbackOperationFact {

    return Object.freeze({
        id: fact.id,
        ...(fact.label !== undefined ? { label: boundedLabel(fact.label) } : {}),
        path: fact.path,
        state: fact.state,
        retain: fact.retain,
        ...(fact.sourceKind !== undefined ? { sourceKind: fact.sourceKind } : {}),
        sourceResourceId: fact.sourceResourceId,
        allocationVersion: fact.allocationVersion,
        contentEpoch: fact.contentEpoch,
        byteLength: fact.byteLength,
        ...(fact.stagingByteLength !== undefined
            ? { stagingByteLength: fact.stagingByteLength }
            : {}),
        ...(fact.textureSubresource !== undefined
            ? { textureSubresource: immutableTextureReadbackSubresource(fact.textureSubresource) }
            : {}),
        stagingBytes: fact.stagingBytes,
        retainedHostBytes: fact.retainedHostBytes,
        isMapping: fact.isMapping,
        ...(fact.commandId !== undefined ? { commandId: fact.commandId } : {}),
        ...(fact.submissionId !== undefined ? { submissionId: fact.submissionId } : {}),
        ...(fact.stepIndex !== undefined ? { stepIndex: fact.stepIndex } : {}),
        ...(fact.lastStagingOperationId !== undefined
            ? { lastStagingOperationId: fact.lastStagingOperationId }
            : {}),
        ...(fact.lastMappingOperationId !== undefined
            ? { lastMappingOperationId: fact.lastMappingOperationId }
            : {}),
    })
}

function resourceFact(
    resource: Resource,
    previous?: GPURuntimeResourceFact
): GPURuntimeResourceFact {

    // Allocation descriptors are immutable until allocationVersion advances.
    // Content epochs/state and allocation-operation provenance remain fresh.
    const sameAllocation = previous?.allocationVersion === resource.allocationVersion
    const descriptorHash = sameAllocation
        ? previous.descriptorHash
        : createGpuDescriptorEvidence(resourceDescriptorSummary(resource)).hash
    const common = {
        id: resource.id,
        ...(resource.label !== undefined ? { label: boundedLabel(resource.label) } : {}),
        descriptorHash,
        allocationVersion: resource.allocationVersion,
        ...(previous?.lastAllocationOperationId !== undefined
            ? { lastAllocationOperationId: previous.lastAllocationOperationId }
            : {}),
        ...(previous?.pendingReplacementOperationId !== undefined
            ? { pendingReplacementOperationId: previous.pendingReplacementOperationId }
            : {}),
    }

    if (isContentResource(resource)) {
        if (resource.resourceKind !== 'BufferResource' && resource.resourceKind !== 'TextureResource') {
            throw new TypeError('Only BufferResource and TextureResource may carry scalar content facts.')
        }
        const footprint = sameAllocation && isContentRuntimeResourceFact(previous)
            ? { bytes: previous.logicalFootprintBytes, known: previous.logicalFootprintKnown }
            : logicalResourceFootprint(resource)
        return Object.freeze({
            ...common,
            resourceKind: resource.resourceKind,
            contentEpoch: resource.contentEpoch,
            state: resource.state,
            logicalFootprintBytes: footprint.bytes,
            logicalFootprintKnown: footprint.known,
        })
    }

    if (resource.resourceKind === 'SamplerResource') {
        return Object.freeze({
            ...common,
            resourceKind: 'SamplerResource',
        })
    }

    if (resource.resourceKind === 'QuerySetResource') {
        const querySet = resource as QuerySetResource
        return Object.freeze({
            ...common,
            resourceKind: 'QuerySetResource',
            queryType: querySet.type,
            count: querySet.count,
            slots: querySet.slots(),
        })
    }

    throw new TypeError(`Unsupported Scratch resource kind: ${resource.resourceKind}`)
}

function resourceDescriptorSummary(resource: Resource): Record<string, unknown> {

    const descriptor = resource.descriptor as Record<string, unknown>
    if (resource.resourceKind === 'BufferResource') {
        return {
            size: descriptor.size,
            usage: descriptor.usage,
            ...(descriptor.mappedAtCreation !== undefined
                ? { mappedAtCreation: descriptor.mappedAtCreation }
                : {}),
        }
    }

    if (resource.resourceKind === 'SamplerResource') {
        return {
            addressModeU: descriptor.addressModeU,
            addressModeV: descriptor.addressModeV,
            addressModeW: descriptor.addressModeW,
            magFilter: descriptor.magFilter,
            minFilter: descriptor.minFilter,
            mipmapFilter: descriptor.mipmapFilter,
            lodMinClamp: descriptor.lodMinClamp,
            lodMaxClamp: descriptor.lodMaxClamp,
            compare: descriptor.compare,
            maxAnisotropy: descriptor.maxAnisotropy,
        }
    }

    if (resource.resourceKind === 'QuerySetResource') {
        return {
            type: descriptor.type,
            count: descriptor.count,
        }
    }

    const size = descriptor.size as Record<string, unknown> | undefined
    return {
        ...(size !== undefined ? {
            width: size.width,
            height: size.height,
            depthOrArrayLayers: size.depthOrArrayLayers,
        } : {}),
        format: descriptor.format,
        usage: descriptor.usage,
        mipLevelCount: descriptor.mipLevelCount,
        sampleCount: descriptor.sampleCount,
        dimension: descriptor.dimension,
    }
}

function logicalResourceFootprint(resource: Resource): { bytes: number, known: boolean } {

    const descriptor = resource.descriptor as Record<string, unknown>
    if (resource.resourceKind === 'BufferResource') {
        const size = descriptor.size
        return typeof size === 'number' && Number.isSafeInteger(size) && size >= 0
            ? { bytes: size, known: true }
            : { bytes: 0, known: false }
    }
    if (resource.resourceKind !== 'TextureResource') return { bytes: 0, known: false }
    return logicalTextureDescriptorFootprint(descriptor)
}

function isContentRuntimeResourceFact(
    fact: GPURuntimeResourceFact
): fact is GPURuntimeContentResourceFact {

    return fact.resourceKind === 'BufferResource' || fact.resourceKind === 'TextureResource'
}

export function logicalTextureDescriptorFootprint(
    descriptor: Record<string, unknown>
): { bytes: number, known: boolean } {

    const size = descriptor.size as Record<string, unknown> | undefined
    const width = size?.width
    const height = size?.height
    const layers = size?.depthOrArrayLayers
    const mipLevelCount = descriptor.mipLevelCount
    const sampleCount = descriptor.sampleCount
    const format = descriptor.format
    const dimension = descriptor.dimension
    if (
        typeof width !== 'number' || typeof height !== 'number' || typeof layers !== 'number' ||
        typeof mipLevelCount !== 'number' || typeof sampleCount !== 'number' || typeof format !== 'string' ||
        (dimension !== '1d' && dimension !== '2d' && dimension !== '3d')
    ) return { bytes: 0, known: false }

    const block = textureFormatBlock(format)
    if (block === undefined) return { bytes: 0, known: false }

    let total = 0
    for (let mip = 0; mip < mipLevelCount; mip++) {
        const mipWidth = Math.max(1, Math.floor(width / 2 ** mip))
        const mipHeight = Math.max(1, Math.floor(height / 2 ** mip))
        const mipLayers = dimension === '3d'
            ? Math.max(1, Math.floor(layers / 2 ** mip))
            : layers
        total += Math.ceil(mipWidth / block.width) *
            Math.ceil(mipHeight / block.height) *
            mipLayers * block.bytes * sampleCount
        if (!Number.isSafeInteger(total)) return { bytes: 0, known: false }
    }

    return { bytes: total, known: true }
}

function textureFormatBlock(format: string): { width: number, height: number, bytes: number } | undefined {

    const oneByte = new Set([ 'r8unorm', 'r8snorm', 'r8uint', 'r8sint', 'stencil8' ])
    const twoBytes = new Set([
        'r16uint', 'r16sint', 'r16float', 'rg8unorm', 'rg8snorm', 'rg8uint', 'rg8sint',
        'depth16unorm',
    ])
    const fourBytes = new Set([
        'r32uint', 'r32sint', 'r32float', 'rg16uint', 'rg16sint', 'rg16float',
        'rgba8unorm', 'rgba8unorm-srgb', 'rgba8snorm', 'rgba8uint', 'rgba8sint',
        'bgra8unorm', 'bgra8unorm-srgb', 'rgb10a2uint', 'rgb10a2unorm',
        'rg11b10ufloat', 'rgb9e5ufloat', 'depth32float',
    ])
    const eightBytes = new Set([
        'rg32uint', 'rg32sint', 'rg32float', 'rgba16uint', 'rgba16sint', 'rgba16float',
    ])
    const sixteenBytes = new Set([ 'rgba32uint', 'rgba32sint', 'rgba32float' ])

    if (oneByte.has(format)) return { width: 1, height: 1, bytes: 1 }
    if (twoBytes.has(format)) return { width: 1, height: 1, bytes: 2 }
    if (fourBytes.has(format)) return { width: 1, height: 1, bytes: 4 }
    if (eightBytes.has(format)) return { width: 1, height: 1, bytes: 8 }
    if (sixteenBytes.has(format)) return { width: 1, height: 1, bytes: 16 }

    if (/^(bc1|bc4)-/.test(format) || /^etc2-rgb8/.test(format) || /^eac-r11/.test(format)) {
        return { width: 4, height: 4, bytes: 8 }
    }
    if (/^(bc[2-7]|etc2-rgba8|eac-rg11)-/.test(format)) {
        return { width: 4, height: 4, bytes: 16 }
    }
    const astc = /^astc-(4|5|6|8|10|12)x(4|5|6|8|10|12)-/.exec(format)
    if (astc !== null) {
        return { width: Number(astc[1]), height: Number(astc[2]), bytes: 16 }
    }
    return undefined
}

function matchesOperationQuery(
    record: GPUOperationRecord,
    query: GPUOperationQuery
): boolean {

    return (query.operationId === undefined || record.id === query.operationId) &&
        (query.targetKind === undefined || record.target.kind === query.targetKind) &&
        (query.resourceId === undefined || (
            record.target.kind === 'resource' && record.target.resourceId === query.resourceId
        )) &&
        (query.resourceKind === undefined || (
            record.target.kind === 'resource' && record.target.resourceKind === query.resourceKind
        )) &&
        (query.bindLayoutId === undefined || (
            record.target.kind === 'bind-layout' &&
            record.target.bindLayoutId === query.bindLayoutId
        ) || (
            record.target.kind === 'bind-set' &&
            record.target.bindLayoutId === query.bindLayoutId
        )) &&
        (query.bindSetId === undefined || (
            record.target.kind === 'bind-set' && record.target.bindSetId === query.bindSetId
        )) &&
        (query.shaderModuleId === undefined || (
            record.target.kind === 'shader-module' &&
            record.target.shaderModuleId === query.shaderModuleId
        )) &&
        (query.renderBundleId === undefined || (
            record.target.kind === 'render-bundle' &&
            record.target.renderBundleId === query.renderBundleId
        )) &&
        (query.preparationStage === undefined || (
            record.target.kind === 'bind-set' &&
            record.target.preparationStage === query.preparationStage
        )) &&
        (query.pipelineId === undefined || (
            record.target.kind === 'pipeline' && record.target.pipelineId === query.pipelineId
        )) &&
        (query.commandId === undefined || (
            record.target.kind === 'command' && record.target.commandId === query.commandId
        ) || (
            record.target.kind === 'readback' && record.target.commandId === query.commandId
        )) &&
        (query.readbackId === undefined || (
            record.target.kind === 'readback' && record.target.readbackId === query.readbackId
        )) &&
        (query.submissionId === undefined || (
            record.target.kind === 'submission' && record.target.submissionId === query.submissionId
        )) &&
        (query.nativeLocationKind === undefined || (
            record.target.kind === 'submission' &&
            record.nativeOutcome?.locations.some(
                location => location.kind === query.nativeLocationKind
            ) === true
        )) &&
        (query.nativeStage === undefined || (
            (record.target.kind === 'submission' || record.target.kind === 'readback') &&
            record.nativeOutcome?.outcomes.some(
                outcome => outcome.stage === query.nativeStage
            ) === true
        )) &&
        (query.nativeOutcomeStatus === undefined || (
            (record.target.kind === 'submission' || record.target.kind === 'readback') &&
            record.nativeOutcome?.status === query.nativeOutcomeStatus
        )) &&
        (query.kind === undefined || record.kind === query.kind) &&
        (query.status === undefined || record.status === query.status) &&
        (query.sequenceFrom === undefined || record.sequence >= query.sequenceFrom) &&
        (query.sequenceTo === undefined || record.sequence <= query.sequenceTo)
}

function matchesIncidentQuery(
    report: GPUIncidentReport,
    query: GPUIncidentQuery
): boolean {

    return (query.incidentId === undefined || report.id === query.incidentId) &&
        (query.operationId === undefined || report.operationId === query.operationId) &&
        (query.targetKind === undefined || report.target.kind === query.targetKind) &&
        (query.resourceId === undefined || (
            report.target.kind === 'resource' && report.target.resourceId === query.resourceId
        )) &&
        (query.resourceKind === undefined || (
            report.target.kind === 'resource' && report.target.resourceKind === query.resourceKind
        )) &&
        (query.bindLayoutId === undefined || (
            report.target.kind === 'bind-layout' &&
            report.target.bindLayoutId === query.bindLayoutId
        ) || (
            report.target.kind === 'bind-set' &&
            report.target.bindLayoutId === query.bindLayoutId
        )) &&
        (query.bindSetId === undefined || (
            report.target.kind === 'bind-set' && report.target.bindSetId === query.bindSetId
        )) &&
        (query.shaderModuleId === undefined || (
            report.target.kind === 'shader-module' &&
            report.target.shaderModuleId === query.shaderModuleId
        )) &&
        (query.renderBundleId === undefined || (
            report.target.kind === 'render-bundle' &&
            report.target.renderBundleId === query.renderBundleId
        )) &&
        (query.preparationStage === undefined || (
            report.target.kind === 'bind-set' &&
            report.target.preparationStage === query.preparationStage
        )) &&
        (query.pipelineId === undefined || (
            report.target.kind === 'pipeline' && report.target.pipelineId === query.pipelineId
        )) &&
        (query.commandId === undefined || (
            report.target.kind === 'command' && report.target.commandId === query.commandId
        ) || (
            report.target.kind === 'readback' && report.target.commandId === query.commandId
        )) &&
        (query.readbackId === undefined || (
            report.target.kind === 'readback' && report.target.readbackId === query.readbackId
        )) &&
        (query.submissionId === undefined || (
            report.target.kind === 'submission' && report.target.submissionId === query.submissionId
        )) &&
        (query.nativeLocationKind === undefined || (
            report.kind === 'submission-failure' &&
            report.outcomes?.some(
                outcome => outcome.location?.kind === query.nativeLocationKind
            ) === true
        )) &&
        (query.nativeStage === undefined || (
            (report.kind === 'submission-failure' || report.kind === 'readback-failure') && (
                report.failureStage === query.nativeStage ||
                report.outcomes?.some(outcome => outcome.stage === query.nativeStage) === true
            )
        )) &&
        (query.kind === undefined || report.kind === query.kind) &&
        (query.sequenceFrom === undefined || report.sequence >= query.sequenceFrom) &&
        (query.sequenceTo === undefined || report.sequence <= query.sequenceTo)
}

function boundedLabel(label: string): string {

    if (label.length <= 256) return label
    return `${label.slice(0, 253)}...`
}

function captureStack(): string {

    return new Error('Scratch diagnostic capture call site').stack ?? 'Stack unavailable'
}

function nowMs(): number {

    return globalThis.performance?.now() ?? Date.now()
}

function operationTargetId(target: GPUOperationTarget): string {

    switch (target.kind) {
        case 'resource': return target.resourceId
        case 'shader-module': return target.shaderModuleId
        case 'render-bundle': return target.renderBundleId
        case 'pipeline': return target.pipelineId
        case 'bind-layout': return target.bindLayoutId
        case 'bind-set': return target.bindSetId
        case 'command': return target.commandId
        case 'readback': return target.readbackId
        case 'submission': return target.submissionId
    }
}

function validatedCompletionTarget(
    operation: GPUPendingOperation,
    bindSetTarget: GPUBindSetOperationTarget | undefined
): GPUOperationTarget {

    if (bindSetTarget === undefined) return operation.target
    if (operation.kind !== 'bind-set-preparation' || operation.target.kind !== 'bind-set') {
        throw new TypeError('Only bind-set preparation operations may replace their completion target.')
    }
    if (
        bindSetTarget.bindSetId !== operation.target.bindSetId ||
        bindSetTarget.bindLayoutId !== operation.target.bindLayoutId ||
        bindSetTarget.snapshotHash !== operation.target.snapshotHash
    ) {
        throw new TypeError('BindSet completion target must preserve operation identity and snapshot.')
    }
    return bindSetTarget
}

function freezeEvidence<T>(value: T): T {

    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value
    if (Object.isFrozen(value)) return value
    for (const item of Object.values(value as Record<string, unknown>)) freezeEvidence(item)
    return Object.freeze(value)
}

Object.freeze(GPURuntimeDiagnostics.prototype)
Object.freeze(GPUDiagnosticCapture.prototype)
