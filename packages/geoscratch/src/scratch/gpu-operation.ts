import type { DiagnosticSubject } from './diagnostics.js'
import { normalizePipelineCompilationReport } from './pipeline-compilation.js'
import type {
    PipelineCompilationReport,
    PipelineKind,
} from './pipeline-compilation.js'

const MAX_INCIDENT_RELATED_SUBJECTS = 64
const MAX_INCIDENT_OUTCOMES = 64
const MAX_SUBMISSION_NATIVE_LOCATIONS = 64
const MAX_SUBMISSION_NATIVE_OUTCOMES = 64

export type ScratchJsonPrimitive = string | number | boolean | null
export type ScratchJsonValue =
    | ScratchJsonPrimitive
    | readonly ScratchJsonValue[]
    | Readonly<{ [key: string]: ScratchJsonValue }>

export type GpuOperationKind =
    | 'buffer-allocation'
    | 'texture-allocation'
    | 'texture-replacement'
    | 'sampler-allocation'
    | 'query-set-allocation'
    | 'bind-layout-allocation'
    | 'bind-set-preparation'
    | 'resource-disposal'
    | 'render-pipeline-creation'
    | 'compute-pipeline-creation'
    | 'pipeline-disposal'
    | 'readback-staging-allocation'
    | 'readback-mapping'
    | 'readback-staging-release'
    | 'readback-native-observation'
    | 'submission-native-observation'

export type GpuOperationStatus =
    | 'pending'
    | 'succeeded'
    | 'failed'
    | 'cancelled'

export type GpuNativeErrorCategory =
    | 'validation'
    | 'internal'
    | 'out-of-memory'
    | 'native-exception'
    | 'scope-failure'
    | 'uncaptured-error'
    | 'device-lost'
    | 'none'

export type GpuAttributionConfidence =
    | 'exact-operation'
    | 'enclosing-operation-family'
    | 'temporal-correlation'
    | 'unknown'

export type GpuDescriptorEvidence = Readonly<{
    hash: string
    summary: Readonly<Record<string, ScratchJsonValue>>
    full?: Readonly<Record<string, ScratchJsonValue>>
}>

export type ScratchGpuContentResourceOperationTarget = Readonly<{
    kind: 'resource'
    resourceId: string
    resourceKind: 'BufferResource' | 'TextureResource'
    allocationVersion: number
    contentEpoch: number
    logicalFootprintBytes: number
}>

export type ScratchGpuSamplerOperationTarget = Readonly<{
    kind: 'resource'
    resourceId: string
    resourceKind: 'SamplerResource'
    allocationVersion: number
}>

export type ScratchGpuQuerySetSlotFact = Readonly<{
    index: number
    state: 'empty' | 'ready' | 'indeterminate'
    contentEpoch: number
}>

export type ScratchGpuQuerySetOperationTarget = Readonly<{
    kind: 'resource'
    resourceId: string
    resourceKind: 'QuerySetResource'
    allocationVersion: number
    queryType: 'timestamp' | 'occlusion'
    count: number
    slots: readonly ScratchGpuQuerySetSlotFact[]
}>

export type ScratchGpuResourceOperationTarget =
    | ScratchGpuContentResourceOperationTarget
    | ScratchGpuSamplerOperationTarget
    | ScratchGpuQuerySetOperationTarget

export type ScratchGpuBindLayoutOperationTarget = Readonly<{
    kind: 'bind-layout'
    bindLayoutId: string
    group: number
    entries: readonly ScratchJsonValue[]
    acknowledgementState: 'pending'
}>

export type ScratchGpuBindSetPreparationStage =
    | 'descriptor-validation'
    | 'native-issue'
    | 'synchronous-native-throw'
    | 'texture-view-acknowledgement'
    | 'bind-group-acknowledgement'
    | 'lifecycle-recheck'
    | 'snapshot-recheck'
    | 'commit'
    | 'cancellation'
    | 'retry'

export type ScratchGpuBindSetOperationTarget = Readonly<{
    kind: 'bind-set'
    bindSetId: string
    bindLayoutId: string
    preparationState: 'preparing' | 'prepared' | 'stale' | 'disposed'
    generation: number
    snapshotHash: string
    preparationStage: ScratchGpuBindSetPreparationStage
}>

export type ScratchGpuPipelineOperationTarget = Readonly<{
    kind: 'pipeline'
    pipelineId: string
    pipelineKind: PipelineKind
    programId: string
    programSourceHash: string
}>

export type ScratchGpuCommandOperationTarget = Readonly<{
    kind: 'command'
    commandId: string
    commandKind: 'readback'
}>

export type ScratchGpuReadbackOperationTarget = Readonly<{
    kind: 'readback'
    readbackId: string
    path: 'direct' | 'ordered'
    sourceResourceId: string
    allocationVersion: number
    contentEpoch: number
    byteLength: number
    commandId?: string
    submissionId?: string
    stepIndex?: number
}>

export type ScratchGpuSubmissionOperationTarget = Readonly<{
    kind: 'submission'
    submissionId: string
}>

export type ScratchGpuOperationTarget =
    | ScratchGpuResourceOperationTarget
    | ScratchGpuPipelineOperationTarget
    | ScratchGpuBindLayoutOperationTarget
    | ScratchGpuBindSetOperationTarget
    | ScratchGpuCommandOperationTarget
    | ScratchGpuReadbackOperationTarget
    | ScratchGpuSubmissionOperationTarget

export type ScratchSubmissionScopeMode = 'summary' | 'off'

export type ScratchSubmissionNativeOutcomeMode =
    | ScratchSubmissionScopeMode
    | 'detailed'

export type ScratchSubmissionNativeOutcomeStatus =
    | 'no-native-work'
    | 'observed-succeeded'
    | 'observed-failed'
    | 'unobserved'
    | 'observation-failed'

export type ScratchSubmissionNativeStage =
    | 'encoder-create'
    | 'attachment-view'
    | 'pass-begin'
    | 'command-encode'
    | 'pass-end'
    | 'encoder-finish'
    | 'queue-action'
    | 'queue-submit'
    | 'scope-settlement'
    | 'queue-completion'
    | 'lifecycle-recheck'

export type ScratchSubmissionQueueActionKind =
    | 'command-buffer'
    | 'buffer-upload'
    | 'texture-upload'
    | 'external-image-upload'

export type ScratchSubmissionNativeLocation =
    | Readonly<{
        kind: 'submission'
        submissionId: string
    }>
    | Readonly<{
        kind: 'encoder-segment'
        submissionId: string
        segmentIndex: number
    }>
    | Readonly<{
        kind: 'pass'
        submissionId: string
        stepIndex: number
        passId: string
        passKind: 'render' | 'compute'
    }>
    | Readonly<{
        kind: 'render-attachment'
        submissionId: string
        stepIndex: number
        passId: string
        attachmentKind: 'color' | 'depth-stencil'
        attachmentIndex: number
        viewSpecHash: string
        resourceId: string
        allocationVersion: number
    }>
    | Readonly<{
        kind: 'render-attachment'
        submissionId: string
        stepIndex: number
        passId: string
        attachmentKind: 'color'
        attachmentIndex: number
        surfaceId: string
        surfaceFormat: GPUTextureFormat
        configurationVersion: number
    }>
    | Readonly<{
        kind: 'standalone-command'
        submissionId: string
        stepIndex: number
        commandId: string
        commandKind: string
    }>
    | Readonly<{
        kind: 'pass-command'
        submissionId: string
        stepIndex: number
        passId: string
        passKind: 'render' | 'compute'
        commandId: string
        commandKind: string
    }>
    | Readonly<{
        kind: 'queue-action'
        submissionId: string
        actionIndex: number
        actionKind: ScratchSubmissionQueueActionKind
    }>

export type ScratchSubmissionNativeOutcomeFact = Readonly<{
    stage: ScratchSubmissionNativeStage
    location: ScratchSubmissionNativeLocation
    nativeErrorCategory: GpuNativeErrorCategory
    diagnosticCode?: string
    nativeError?: ScratchNativeGpuErrorFacts
}>

export type ScratchSubmissionNativeOutcome = Readonly<{
    version: 5
    submissionId: string
    mode: ScratchSubmissionNativeOutcomeMode
    status: ScratchSubmissionNativeOutcomeStatus
    locations: readonly ScratchSubmissionNativeLocation[]
    outcomes: readonly ScratchSubmissionNativeOutcomeFact[]
    omittedLocationCount: number
    omittedOutcomeCount: number
}>

export type ScratchSubmissionNativeOutcomeInput = Readonly<{
    mode: ScratchSubmissionNativeOutcomeMode
    status: ScratchSubmissionNativeOutcomeStatus
    locations: readonly ScratchSubmissionNativeLocation[]
    outcomes: readonly ScratchSubmissionNativeOutcomeFact[]
    omittedLocationCount?: number
    omittedOutcomeCount?: number
}>

export type ScratchReadbackNativeStage =
    | 'encoder-create'
    | 'command-encode'
    | 'encoder-finish'
    | 'queue-submit'
    | 'scope-settlement'
    | 'lifecycle-recheck'

export type ScratchReadbackNativeOutcomeFact = Readonly<{
    stage: ScratchReadbackNativeStage
    nativeErrorCategory: GpuNativeErrorCategory
    diagnosticCode?: string
    nativeError?: ScratchNativeGpuErrorFacts
}>

export type ScratchReadbackNativeOutcome = Readonly<{
    version: 5
    readbackId: string
    mode: ScratchSubmissionNativeOutcomeMode
    status: Exclude<ScratchSubmissionNativeOutcomeStatus, 'no-native-work'>
    locations: readonly []
    outcomes: readonly ScratchReadbackNativeOutcomeFact[]
    omittedLocationCount: 0
    omittedOutcomeCount: number
}>

export type ScratchReadbackNativeOutcomeInput = Readonly<{
    mode: ScratchSubmissionNativeOutcomeMode
    status: Exclude<ScratchSubmissionNativeOutcomeStatus, 'no-native-work'>
    locations: readonly []
    outcomes: readonly ScratchReadbackNativeOutcomeFact[]
    omittedLocationCount?: 0
    omittedOutcomeCount?: number
}>

export type ScratchGpuRuntimeIncidentTarget = Readonly<{
    kind: 'runtime'
    runtimeId: string
}>

export type ScratchGpuIncidentTarget =
    | ScratchGpuOperationTarget
    | ScratchGpuRuntimeIncidentTarget

export type ScratchPipelineNativeLabelFact = Readonly<{
    value: string
    truncated: boolean
}>

export type ScratchPipelineNativeLabelEvidence = Readonly<{
    pipeline: ScratchPipelineNativeLabelFact
    shaderModule: ScratchPipelineNativeLabelFact
    pipelineLayout: ScratchPipelineNativeLabelFact
}>

type ScratchGpuOperationRecordBase = Readonly<{
    version: 5
    sequence: number
    id: string
    kind: GpuOperationKind
    status: GpuOperationStatus
    runtimeId: string
    target: ScratchGpuOperationTarget
    descriptor: GpuDescriptorEvidence
    nativeLabel?: string
    nativeLabels?: ScratchPipelineNativeLabelEvidence
    compilationReport?: PipelineCompilationReport
    nativeErrorCategory?: GpuNativeErrorCategory
    incidentId?: string
    startedAtMs?: number
    settledAtMs?: number
    stack?: string
}>

export type ScratchGpuResourceOperationRecord = ScratchGpuOperationRecordBase & Readonly<{
    target: ScratchGpuResourceOperationTarget
    kind:
        | 'buffer-allocation'
        | 'texture-allocation'
        | 'texture-replacement'
        | 'sampler-allocation'
        | 'query-set-allocation'
        | 'resource-disposal'
    nativeLabels?: never
    compilationReport?: never
    nativeOutcome?: never
}>

export type ScratchGpuBindLayoutOperationRecord = ScratchGpuOperationRecordBase & Readonly<{
    target: ScratchGpuBindLayoutOperationTarget
    kind: 'bind-layout-allocation'
    nativeLabels?: never
    compilationReport?: never
    nativeOutcome?: never
}>

export type ScratchGpuBindSetOperationRecord = ScratchGpuOperationRecordBase & Readonly<{
    target: ScratchGpuBindSetOperationTarget
    kind: 'bind-set-preparation'
    nativeLabels?: never
    compilationReport?: never
    nativeOutcome?: never
}>

export type ScratchGpuPipelineOperationRecord = ScratchGpuOperationRecordBase & Readonly<{
    target: ScratchGpuPipelineOperationTarget
    kind: 'render-pipeline-creation' | 'compute-pipeline-creation' | 'pipeline-disposal'
    nativeOutcome?: never
}>

export type ScratchGpuCommandOperationRecord = ScratchGpuOperationRecordBase & Readonly<{
    target: ScratchGpuCommandOperationTarget
    kind: 'readback-staging-allocation' | 'readback-staging-release'
    nativeLabels?: never
    compilationReport?: never
    nativeOutcome?: never
}>

export type ScratchGpuReadbackOperationRecord =
    | ScratchGpuOperationRecordBase & Readonly<{
        target: ScratchGpuReadbackOperationTarget
        kind: 'readback-staging-allocation' | 'readback-mapping' | 'readback-staging-release'
        nativeLabels?: never
        compilationReport?: never
        nativeOutcome?: never
    }>
    | ScratchGpuOperationRecordBase & Readonly<{
        target: ScratchGpuReadbackOperationTarget
        kind: 'readback-native-observation'
        nativeLabels?: never
        compilationReport?: never
        nativeOutcome?: ScratchReadbackNativeOutcome
    }>

export type ScratchGpuSubmissionOperationRecord = ScratchGpuOperationRecordBase & Readonly<{
    target: ScratchGpuSubmissionOperationTarget
    kind: 'submission-native-observation'
    nativeOutcome?: ScratchSubmissionNativeOutcome
    nativeLabels?: never
    compilationReport?: never
}>

export type ScratchGpuOperationRecord =
    | ScratchGpuResourceOperationRecord
    | ScratchGpuPipelineOperationRecord
    | ScratchGpuBindLayoutOperationRecord
    | ScratchGpuBindSetOperationRecord
    | ScratchGpuCommandOperationRecord
    | ScratchGpuReadbackOperationRecord
    | ScratchGpuSubmissionOperationRecord

export type ScratchGpuOperationRecordInput = Readonly<{
    sequence: number
    id: string
    kind: GpuOperationKind
    status: GpuOperationStatus
    runtimeId: string
    target: ScratchGpuOperationTarget
    descriptor: GpuDescriptorEvidence
    nativeLabel?: string
    nativeLabels?: ScratchPipelineNativeLabelEvidence
    compilationReport?: PipelineCompilationReport
    nativeErrorCategory?: GpuNativeErrorCategory
    incidentId?: string
    startedAtMs?: number
    settledAtMs?: number
    stack?: string
    nativeOutcome?: ScratchSubmissionNativeOutcomeInput | ScratchReadbackNativeOutcomeInput
    [key: string]: unknown
}>

export type ScratchNativeGpuErrorFacts = Readonly<{
    name?: string
    message: string
    reason?: string
    truncated?: boolean
    sourceExcerptRedacted?: boolean
    nativeMessageOmitted?: boolean
}>

export type ScratchGpuIncidentPendingOperation = Readonly<{
    id: string
    sequence: number
    kind: GpuOperationKind
    target: ScratchGpuOperationTarget
}>

export type ScratchGpuIncidentResourceFact = Readonly<{
    id: string
    resourceKind: string
    logicalFootprintBytes: number
    allocationVersion: number
    contentEpoch: number
    state: string
}>

export type ScratchGpuPressureContributor = Readonly<{
    resourceId: string
    resourceKind: string
    logicalFootprintBytes: number
    label?: string
    allocationVersion?: number
}>

export type ScratchGpuPressureChurn = Readonly<{
    sequence: number
    operationId: string
    operationKind: GpuOperationKind
    status: GpuOperationStatus
    resourceId: string
    logicalFootprintBytes: number
}>

export type ScratchGpuPressureEvidence = Readonly<{
    triggerLogicalFootprintBytes?: number
    currentScratchLogicalFootprintBytes: number
    peakScratchLogicalFootprintBytes: number
    liveResourceCounts: Readonly<Record<string, number>>
    largestContributors: readonly ScratchGpuPressureContributor[]
    recentChurn: readonly ScratchGpuPressureChurn[]
    caveats: readonly string[]
}>

export type ScratchGpuIncidentEvidenceCompleteness = Readonly<{
    complete: boolean
    overwrittenOperations: number
    overwrittenIncidents: number
    omittedRecords: number
}>

export type ScratchGpuIncidentKind =
    | 'allocation-failure'
    | 'supporting-object-failure'
    | 'pipeline-failure'
    | 'readback-failure'
    | 'submission-failure'
    | 'uncaptured-error'
    | 'device-loss'
    | 'capture-degraded'

export type ScratchGpuPipelineFailureStage =
    | 'supporting-object-creation'
    | 'compilation-info'
    | 'shader-compilation'
    | 'pipeline-creation'
    | 'scope-settlement'
    | 'lifecycle-recheck'

export type ScratchReadbackFailureStage =
    | 'staging-allocation'
    | 'copy-issue'
    | 'queue-completion'
    | 'mapping'
    | 'mapped-range'
    | 'host-copy'
    | 'cleanup'
    | 'budget'
    | 'lifecycle-recheck'

export type ScratchSubmissionFailureStage =
    | ScratchSubmissionNativeStage
    | 'budget'

export type ScratchSupportingObjectFailureStage =
    | 'native-issue'
    | 'scope-settlement'
    | 'lifecycle-recheck'
    | ScratchGpuBindSetPreparationStage

export type ScratchGpuIncidentFailureStage =
    | ScratchGpuPipelineFailureStage
    | ScratchReadbackFailureStage
    | ScratchSubmissionFailureStage
    | ScratchSupportingObjectFailureStage

export type ScratchGpuIncidentOutcome = Readonly<{
    stage: ScratchGpuIncidentFailureStage
    diagnosticCode: string
    nativeErrorCategory: GpuNativeErrorCategory
    subject?: DiagnosticSubject
    pipelineErrorReason?: GPUPipelineErrorReason
    nativeError?: ScratchNativeGpuErrorFacts
    location?: ScratchSubmissionNativeLocation
}>

export type ScratchGpuIncidentPipelineFact = Readonly<{
    id: string
    label?: string
    pipelineKind: PipelineKind
    programId: string
    programSourceHash: string
    descriptorHash: string
    state: string
    lastCreationOperationId?: string
}>

type ScratchGpuIncidentReportBase = Readonly<{
    version: 5
    sequence: number
    id: string
    kind: ScratchGpuIncidentKind
    diagnosticCode: string
    nativeErrorCategory: GpuNativeErrorCategory
    attribution: GpuAttributionConfidence
    runtimeId: string
    target: ScratchGpuIncidentTarget
    operationId?: string
    subject: DiagnosticSubject
    related: readonly DiagnosticSubject[]
    triggerOperation?: ScratchGpuOperationRecord
    nativeError?: ScratchNativeGpuErrorFacts
    recentOperations: readonly ScratchGpuOperationRecord[]
    pendingOperations?: readonly ScratchGpuIncidentPendingOperation[]
    currentResources?: readonly ScratchGpuIncidentResourceFact[]
    currentPipelines?: readonly ScratchGpuIncidentPipelineFact[]
    evidence: ScratchGpuIncidentEvidenceCompleteness
}>

export type ScratchGpuResourceIncidentReport = ScratchGpuIncidentReportBase & Readonly<{
    target: ScratchGpuContentResourceOperationTarget
    kind: 'allocation-failure'
    pressure: ScratchGpuPressureEvidence
}>

export type ScratchGpuSupportingObjectIncidentReport = ScratchGpuIncidentReportBase & Readonly<{
    target:
        | ScratchGpuSamplerOperationTarget
        | ScratchGpuQuerySetOperationTarget
        | ScratchGpuBindLayoutOperationTarget
        | ScratchGpuBindSetOperationTarget
    kind: 'supporting-object-failure'
    failureStage: ScratchSupportingObjectFailureStage
    outcomes?: readonly ScratchGpuIncidentOutcome[]
    pressure?: ScratchGpuPressureEvidence
    compilationReport?: never
    pipelineErrorReason?: never
}>

export type ScratchGpuPipelineIncidentReport = ScratchGpuIncidentReportBase & Readonly<{
    target: ScratchGpuPipelineOperationTarget
    kind: 'pipeline-failure'
    failureStage: ScratchGpuPipelineFailureStage
    pipelineErrorReason?: GPUPipelineErrorReason
    compilationReport?: PipelineCompilationReport
    outcomes?: readonly ScratchGpuIncidentOutcome[]
    pressure?: never
}>

export type ScratchGpuReadbackIncidentReport = ScratchGpuIncidentReportBase & Readonly<{
    target: ScratchGpuCommandOperationTarget | ScratchGpuReadbackOperationTarget
    kind: 'readback-failure'
    failureStage: ScratchReadbackFailureStage
    outcomes?: readonly ScratchGpuIncidentOutcome[]
    pressure?: never
    compilationReport?: never
    pipelineErrorReason?: never
}>

export type ScratchGpuSubmissionIncidentReport = ScratchGpuIncidentReportBase & Readonly<{
    target: ScratchGpuSubmissionOperationTarget
    kind: 'submission-failure'
    failureStage: ScratchSubmissionFailureStage
    outcomes?: readonly ScratchGpuIncidentOutcome[]
    pressure?: never
    compilationReport?: never
    pipelineErrorReason?: never
}>

export type ScratchGpuRuntimeIncidentReport = ScratchGpuIncidentReportBase & Readonly<{
    target: ScratchGpuRuntimeIncidentTarget
    kind: 'uncaptured-error' | 'device-loss' | 'capture-degraded'
    pressure?: never
}>

export type ScratchGpuIncidentReport =
    | ScratchGpuResourceIncidentReport
    | ScratchGpuSupportingObjectIncidentReport
    | ScratchGpuPipelineIncidentReport
    | ScratchGpuReadbackIncidentReport
    | ScratchGpuSubmissionIncidentReport
    | ScratchGpuRuntimeIncidentReport

export type ScratchGpuIncidentReportInput = Readonly<{
    sequence: number
    id: string
    kind: ScratchGpuIncidentKind
    diagnosticCode: string
    nativeErrorCategory: GpuNativeErrorCategory
    attribution: GpuAttributionConfidence
    runtimeId: string
    target: ScratchGpuIncidentTarget
    operationId?: string
    subject?: DiagnosticSubject
    related?: readonly DiagnosticSubject[]
    triggerOperation?: ScratchGpuOperationRecord
    nativeError?: ScratchNativeGpuErrorFacts
    recentOperations: readonly ScratchGpuOperationRecord[]
    pendingOperations?: readonly ScratchGpuIncidentPendingOperation[]
    currentResources?: readonly ScratchGpuIncidentResourceFact[]
    currentPipelines?: readonly ScratchGpuIncidentPipelineFact[]
    pressure?: ScratchGpuPressureEvidence
    failureStage?: ScratchGpuIncidentFailureStage
    pipelineErrorReason?: GPUPipelineErrorReason
    compilationReport?: PipelineCompilationReport
    outcomes?: readonly ScratchGpuIncidentOutcome[]
    omittedOutcomeCount?: number
    evidence: ScratchGpuIncidentEvidenceCompleteness
    [key: string]: unknown
}>

export function createGpuOperationRecord(
    input: ScratchGpuOperationRecordInput
): ScratchGpuOperationRecord {

    assertGpuOperationTarget(input.kind, input.target)
    const record: Record<string, unknown> = {
        version: 5,
        sequence: input.sequence,
        id: input.id,
        kind: input.kind,
        status: input.status,
        runtimeId: input.runtimeId,
        target: cloneJsonValue(input.target),
        descriptor: cloneJsonValue(input.descriptor),
    }

    const targetId = operationTargetId(input.target)
    const nativeLabel = boundedGpuOperationNativeLabel(input.nativeLabel, targetId)
    if (nativeLabel !== undefined) record.nativeLabel = nativeLabel

    if (input.target.kind === 'pipeline') {
        if (input.nativeLabels !== undefined) {
            record.nativeLabels = normalizePipelineNativeLabels(
                input.nativeLabels,
                input.target.pipelineId
            )
        }
        if (input.compilationReport !== undefined) {
            record.compilationReport = normalizeCompilationReportEvidence(
                input.compilationReport,
                input.target
            )
        }
    }
    if (input.target.kind === 'submission' && input.nativeOutcome !== undefined) {
        record.nativeOutcome = createSubmissionNativeOutcome(
            input.target.submissionId,
            input.nativeOutcome as ScratchSubmissionNativeOutcomeInput
        )
    } else if (
        input.target.kind === 'readback' &&
        input.kind === 'readback-native-observation' &&
        input.nativeOutcome !== undefined
    ) {
        record.nativeOutcome = createReadbackNativeOutcome(
            input.target.readbackId,
            input.nativeOutcome as ScratchReadbackNativeOutcomeInput
        )
    } else if (input.nativeOutcome !== undefined) {
        throw new TypeError('Only native-observation GPU operations may retain a native outcome.')
    }

    copyDefined(record, input, [
        'nativeErrorCategory',
        'incidentId',
        'startedAtMs',
        'settledAtMs',
        'stack',
    ])

    return deepFreeze(record) as ScratchGpuOperationRecord
}

export function createSubmissionNativeOutcome(
    submissionId: string,
    input: ScratchSubmissionNativeOutcomeInput
): ScratchSubmissionNativeOutcome {

    assertNonEmptyString(submissionId, 'submissionId')
    assertSubmissionNativeOutcomeStatus(input.mode, input.status)
    assertNonNegativeInteger(input.omittedLocationCount ?? 0, 'omittedLocationCount')
    assertNonNegativeInteger(input.omittedOutcomeCount ?? 0, 'omittedOutcomeCount')
    const locations: ScratchSubmissionNativeLocation[] = input.locations
        .slice(0, MAX_SUBMISSION_NATIVE_LOCATIONS)
        .map(location => {
        assertSubmissionNativeLocation(location, submissionId)
        return cloneJsonValue(location) as ScratchSubmissionNativeLocation
    })
    const outcomes: ScratchSubmissionNativeOutcomeFact[] = input.outcomes
        .slice(0, MAX_SUBMISSION_NATIVE_OUTCOMES)
        .map(outcome => {
        assertSubmissionNativeStage(outcome.stage)
        assertNativeErrorCategory(outcome.nativeErrorCategory)
        assertSubmissionNativeLocation(outcome.location, submissionId)
        if (outcome.diagnosticCode !== undefined) {
            assertNonEmptyString(outcome.diagnosticCode, 'diagnosticCode')
        }
        return cloneJsonValue(
            outcome,
            new Set<object>(),
            true
        ) as ScratchSubmissionNativeOutcomeFact
    })
    assertSubmissionNativeOutcomeContents(input.status, locations, outcomes)

    return deepFreeze({
        version: 5,
        submissionId,
        mode: input.mode,
        status: input.status,
        locations,
        outcomes,
        omittedLocationCount: (input.omittedLocationCount ?? 0) +
            Math.max(0, input.locations.length - locations.length),
        omittedOutcomeCount: (input.omittedOutcomeCount ?? 0) +
            Math.max(0, input.outcomes.length - outcomes.length),
    })
}

export function createReadbackNativeOutcome(
    readbackId: string,
    input: ScratchReadbackNativeOutcomeInput
): ScratchReadbackNativeOutcome {

    assertNonEmptyString(readbackId, 'readbackId')
    assertSubmissionNativeOutcomeStatus(input.mode, input.status)
    if ((input.status as ScratchSubmissionNativeOutcomeStatus) === 'no-native-work') {
        throw new TypeError('Readback native observations cannot publish no-native-work.')
    }
    if (!Array.isArray(input.locations) || input.locations.length !== 0) {
        throw new TypeError('Readback native outcomes do not retain submission locations.')
    }
    if ((input.omittedLocationCount ?? 0) !== 0) {
        throw new TypeError('Readback native outcomes cannot omit submission locations.')
    }
    assertNonNegativeInteger(input.omittedOutcomeCount ?? 0, 'omittedOutcomeCount')
    const outcomes = input.outcomes
        .slice(0, MAX_SUBMISSION_NATIVE_OUTCOMES)
        .map(outcome => {
            assertReadbackNativeStage(outcome.stage)
            assertNativeErrorCategory(outcome.nativeErrorCategory)
            if (outcome.diagnosticCode !== undefined) {
                assertNonEmptyString(outcome.diagnosticCode, 'diagnosticCode')
            }
            return cloneJsonValue(
                outcome,
                new Set<object>(),
                true
            ) as ScratchReadbackNativeOutcomeFact
        })
    assertSubmissionNativeOutcomeContents(input.status, [], outcomes)

    return deepFreeze({
        version: 5,
        readbackId,
        mode: input.mode,
        status: input.status,
        locations: [],
        outcomes,
        omittedLocationCount: 0,
        omittedOutcomeCount: (input.omittedOutcomeCount ?? 0) +
            Math.max(0, input.outcomes.length - outcomes.length),
    }) as ScratchReadbackNativeOutcome
}

export function createGpuIncidentReport(
    input: ScratchGpuIncidentReportInput
): ScratchGpuIncidentReport {

    assertIncidentTarget(input)
    assertNonNegativeInteger(input.omittedOutcomeCount ?? 0, 'omittedOutcomeCount')
    const subject = input.subject ?? createIncidentSubject(input)
    const completeRelated = input.related ?? createIncidentRelatedSubjects(input)
    const related = completeRelated.slice(0, MAX_INCIDENT_RELATED_SUBJECTS)
    const outcomes = (
        input.kind === 'supporting-object-failure' ||
        input.target.kind === 'pipeline' ||
        input.target.kind === 'command' ||
        input.target.kind === 'readback' ||
        input.target.kind === 'submission'
    ) && input.outcomes !== undefined
        ? input.outcomes.slice(0, MAX_INCIDENT_OUTCOMES)
        : undefined
    const omittedEvidenceItems = Math.max(
        0,
        completeRelated.length - related.length
    ) + Math.max(
        0,
        (input.outcomes?.length ?? 0) - (outcomes?.length ?? 0)
    ) + (input.omittedOutcomeCount ?? 0)
    const evidence = {
        ...input.evidence,
        complete: input.evidence.complete && omittedEvidenceItems === 0,
        omittedRecords: input.evidence.omittedRecords + omittedEvidenceItems,
    }
    const report: Record<string, unknown> = {
        version: 5,
        sequence: input.sequence,
        id: input.id,
        kind: input.kind,
        diagnosticCode: input.diagnosticCode,
        nativeErrorCategory: input.nativeErrorCategory,
        attribution: input.attribution,
        runtimeId: input.runtimeId,
        target: cloneJsonValue(input.target),
        subject: cloneJsonValue(subject, new Set<object>(), true),
        related: cloneJsonValue(related, new Set<object>(), true),
        recentOperations: cloneJsonValue(input.recentOperations),
        evidence: cloneJsonValue(evidence),
    }

    copyJsonDefined(report, input, [
        'operationId',
        'triggerOperation',
        'nativeError',
        'pendingOperations',
    ])
    if (input.target.kind === 'resource') {
        copyJsonDefined(report, input, [ 'currentResources', 'pressure' ])
    }
    if (input.kind === 'supporting-object-failure') {
        copyJsonDefined(report, input, [ 'failureStage', 'pressure' ])
        if (outcomes !== undefined) {
            report.outcomes = cloneJsonValue(outcomes, new Set<object>(), true)
        }
    }
    if (input.target.kind === 'pipeline') {
        copyJsonDefined(report, input, [
            'currentPipelines',
            'failureStage',
            'pipelineErrorReason',
        ])
        if (outcomes !== undefined) {
            report.outcomes = cloneJsonValue(outcomes, new Set<object>(), true)
        }
        if (input.compilationReport !== undefined) {
            report.compilationReport = normalizeCompilationReportEvidence(
                input.compilationReport,
                input.target
            )
        }
    }
    if (
        input.target.kind === 'command' ||
        input.target.kind === 'readback' ||
        input.target.kind === 'submission'
    ) {
        copyJsonDefined(report, input, [ 'failureStage' ])
        if (outcomes !== undefined) {
            report.outcomes = cloneJsonValue(outcomes, new Set<object>(), true)
        }
    }
    if (input.target.kind === 'runtime') {
        copyJsonDefined(report, input, [ 'currentResources', 'currentPipelines' ])
    }

    return deepFreeze(report) as ScratchGpuIncidentReport
}

function normalizePipelineNativeLabels(
    evidence: ScratchPipelineNativeLabelEvidence,
    pipelineId: string
): ScratchPipelineNativeLabelEvidence {

    const fallback = `scratch:${pipelineId}`
    const normalize = (fact: ScratchPipelineNativeLabelFact | undefined) => {
        const value = typeof fact?.value === 'string' ? fact.value : fallback
        const bounded = boundedGpuOperationNativeLabel(value, pipelineId) ?? fallback
        return {
            value: bounded,
            truncated: fact?.truncated === true || bounded !== value,
        }
    }
    return deepFreeze({
        pipeline: normalize(evidence.pipeline),
        shaderModule: normalize(evidence.shaderModule),
        pipelineLayout: normalize(evidence.pipelineLayout),
    })
}

function normalizeCompilationReportEvidence(
    input: PipelineCompilationReport,
    target: ScratchGpuPipelineOperationTarget
): PipelineCompilationReport {

    return normalizePipelineCompilationReport(input, {
        pipelineId: target.pipelineId,
        pipelineKind: target.pipelineKind,
        programId: target.programId,
        combinedSourceHash: target.programSourceHash,
    })
}

export function serializeNativeGpuError(error: unknown): ScratchNativeGpuErrorFacts {

    let name: string | undefined
    let message: string
    let reason: string | undefined
    let nativeMessageOmitted = false

    if (error !== null && (typeof error === 'object' || typeof error === 'function')) {
        name = readStringProperty(error, 'name')
        reason = readStringProperty(error, 'reason')
        nativeMessageOmitted = readBooleanProperty(error, 'nativeMessageOmitted') === true
        message = readStringProperty(error, 'message') ?? safeString(error)
    } else {
        message = safeString(error)
    }

    const boundedName = boundString(name, 256)
    const boundedMessage = boundString(message, 4_096)!
    const boundedReason = boundString(reason, 256)

    return deepFreeze({
        ...(boundedName !== undefined ? { name: boundedName } : {}),
        message: boundedMessage,
        ...(boundedReason !== undefined ? { reason: boundedReason } : {}),
        ...(nativeMessageOmitted ? { nativeMessageOmitted: true } : {}),
        ...(
            boundedName !== name || boundedMessage !== message || boundedReason !== reason
                ? { truncated: true }
                : {}
        ),
    })
}

export function createGpuDescriptorEvidence(
    summary: Record<string, unknown>,
    full?: Record<string, unknown>
): GpuDescriptorEvidence {

    const normalizedSummary = cloneJsonValue(
        summary,
        new Set<object>(),
        true
    ) as Readonly<Record<string, ScratchJsonValue>>
    const normalizedFull = full === undefined
        ? undefined
        : cloneJsonValue(
            full,
            new Set<object>(),
            true
        ) as Readonly<Record<string, ScratchJsonValue>>
    const canonical = JSON.stringify(normalizedFull ?? normalizedSummary)

    return deepFreeze({
        hash: `fnv1a-${fnv1a(canonical)}`,
        summary: normalizedSummary,
        ...(normalizedFull !== undefined ? { full: normalizedFull } : {}),
    })
}

export function serializedEvidenceBytes(value: unknown): number {

    const serialized = JSON.stringify(value)
    if (serialized === undefined) return 0
    return new TextEncoder().encode(serialized).byteLength
}

function createIncidentRelatedSubjects(input: ScratchGpuIncidentReportInput): DiagnosticSubject[] {

    const related: DiagnosticSubject[] = [ {
        kind: 'ScratchRuntime',
        id: input.runtimeId,
    } ]
    if (input.target.kind === 'resource') {
        related.push({ kind: 'Resource', id: input.target.resourceId })
    }
    if (input.target.kind === 'bind-layout') {
        related.push({ kind: 'BindLayout', id: input.target.bindLayoutId })
    }
    if (input.target.kind === 'bind-set') {
        related.push({ kind: 'BindSet', id: input.target.bindSetId })
        related.push({ kind: 'BindLayout', id: input.target.bindLayoutId })
    }
    if (input.target.kind === 'pipeline') {
        related.push({
            kind: 'Pipeline',
            id: input.target.pipelineId,
            pipelineKind: input.target.pipelineKind,
        })
        related.push({ kind: 'Program', id: input.target.programId })
    }
    if (input.target.kind === 'command') {
        related.push({
            kind: 'Command',
            id: input.target.commandId,
            commandKind: input.target.commandKind,
        })
    }
    if (input.target.kind === 'readback') {
        related.push({ kind: 'ReadbackOperation', id: input.target.readbackId })
        related.push({ kind: 'Resource', id: input.target.sourceResourceId })
    }
    if (input.target.kind === 'submission') {
        related.push({ kind: 'Submission', id: input.target.submissionId })
    }
    if (input.operationId !== undefined) {
        related.push({
            kind: 'GpuOperation',
            id: input.operationId,
            ...(input.triggerOperation !== undefined
                ? { operationKind: input.triggerOperation.kind }
                : {}),
        })
    }
    return related
}

function createIncidentSubject(input: ScratchGpuIncidentReportInput): DiagnosticSubject {

    if (input.target.kind === 'pipeline') {
        return {
            kind: 'Pipeline',
            id: input.target.pipelineId,
            pipelineKind: input.target.pipelineKind,
        }
    }
    if (input.target.kind === 'command') {
        return {
            kind: 'Command',
            id: input.target.commandId,
            commandKind: input.target.commandKind,
        }
    }
    if (input.target.kind === 'readback') {
        return { kind: 'ReadbackOperation', id: input.target.readbackId }
    }
    if (input.target.kind === 'submission') {
        return { kind: 'Submission', id: input.target.submissionId }
    }
    if (input.target.kind === 'bind-layout') {
        return { kind: 'BindLayout', id: input.target.bindLayoutId }
    }
    if (input.target.kind === 'bind-set') {
        return { kind: 'BindSet', id: input.target.bindSetId }
    }
    return {
        kind: 'Incident',
        id: input.id,
        incidentKind: input.kind,
    }
}

export function assertGpuOperationTarget(
    kind: GpuOperationKind,
    target: ScratchGpuOperationTarget
): void {

    switch (kind) {
        case 'buffer-allocation':
            if (target.kind === 'resource' && target.resourceKind === 'BufferResource') return
            throw new TypeError(`GPU operation ${kind} requires a BufferResource target.`)
        case 'texture-allocation':
        case 'texture-replacement':
            if (target.kind === 'resource' && target.resourceKind === 'TextureResource') return
            throw new TypeError(`GPU operation ${kind} requires a TextureResource target.`)
        case 'sampler-allocation':
            if (target.kind === 'resource' && target.resourceKind === 'SamplerResource') return
            throw new TypeError(`GPU operation ${kind} requires a SamplerResource target.`)
        case 'query-set-allocation':
            if (target.kind === 'resource' && target.resourceKind === 'QuerySetResource') return
            throw new TypeError(`GPU operation ${kind} requires a QuerySetResource target.`)
        case 'bind-layout-allocation':
            if (target.kind === 'bind-layout') return
            throw new TypeError(`GPU operation ${kind} requires a BindLayout target.`)
        case 'bind-set-preparation':
            if (target.kind === 'bind-set') return
            throw new TypeError(`GPU operation ${kind} requires a BindSet target.`)
        case 'resource-disposal':
            if (target.kind === 'resource') return
            break
        case 'render-pipeline-creation':
            if (target.kind === 'pipeline' && target.pipelineKind === 'render') return
            throw new TypeError(`GPU operation ${kind} requires a render pipeline target.`)
        case 'compute-pipeline-creation':
            if (target.kind === 'pipeline' && target.pipelineKind === 'compute') return
            throw new TypeError(`GPU operation ${kind} requires a compute pipeline target.`)
        case 'pipeline-disposal':
            if (target.kind === 'pipeline') return
            break
        case 'readback-staging-allocation':
        case 'readback-staging-release':
            if (target.kind === 'command' || target.kind === 'readback') return
            throw new TypeError(`GPU operation ${kind} requires a command or readback target.`)
        case 'readback-mapping':
            if (target.kind === 'readback') return
            throw new TypeError(`GPU operation ${kind} requires a readback target.`)
        case 'readback-native-observation':
            if (target.kind === 'readback' && target.path === 'direct') return
            throw new TypeError(`GPU operation ${kind} requires a direct readback target.`)
        case 'submission-native-observation':
            if (target.kind === 'submission') {
                assertNonEmptyString(target.submissionId, 'submissionId')
                return
            }
            throw new TypeError(`GPU operation ${kind} requires a submission target.`)
    }

    throw new TypeError(`GPU operation ${kind} has an incompatible ${target.kind} target.`)
}

function assertIncidentTarget(input: ScratchGpuIncidentReportInput): void {

    const compatible = input.kind === 'allocation-failure'
        ? input.target.kind === 'resource' && (
            input.target.resourceKind === 'BufferResource' ||
            input.target.resourceKind === 'TextureResource'
        )
        : input.kind === 'supporting-object-failure'
            ? (
                input.target.kind === 'bind-layout' ||
                input.target.kind === 'bind-set' ||
                input.target.kind === 'resource' && (
                    input.target.resourceKind === 'SamplerResource' ||
                    input.target.resourceKind === 'QuerySetResource'
                )
            )
        : input.kind === 'pipeline-failure'
            ? input.target.kind === 'pipeline'
            : input.kind === 'readback-failure'
                ? input.target.kind === 'command' || input.target.kind === 'readback'
                : input.kind === 'submission-failure'
                    ? input.target.kind === 'submission'
                    : input.target.kind === 'runtime'
    if (!compatible) {
        throw new TypeError(`GPU incident ${input.kind} has an incompatible ${input.target.kind} target.`)
    }
    if ((
        input.kind === 'supporting-object-failure' ||
        input.kind === 'pipeline-failure' ||
        input.kind === 'readback-failure' ||
        input.kind === 'submission-failure'
    ) && input.failureStage === undefined) {
        throw new TypeError(`${input.kind} incidents require a failureStage.`)
    }
    if (input.kind === 'submission-failure' && input.target.kind === 'submission') {
        assertNonEmptyString(input.target.submissionId, 'submissionId')
        assertSubmissionFailureStage(input.failureStage)
        for (const outcome of input.outcomes ?? []) {
            assertSubmissionFailureStage(outcome.stage)
            assertNativeErrorCategory(outcome.nativeErrorCategory)
            assertNonEmptyString(outcome.diagnosticCode, 'diagnosticCode')
            if (outcome.location !== undefined) {
                assertSubmissionNativeLocation(outcome.location, input.target.submissionId)
            }
        }
    }
}

function assertSubmissionFailureStage(
    value: unknown
): asserts value is ScratchSubmissionFailureStage {

    if (value === 'budget') return
    assertSubmissionNativeStage(value)
}

function operationTargetId(target: ScratchGpuOperationTarget): string {

    switch (target.kind) {
        case 'resource': return target.resourceId
        case 'pipeline': return target.pipelineId
        case 'bind-layout': return target.bindLayoutId
        case 'bind-set': return target.bindSetId
        case 'command': return target.commandId
        case 'readback': return target.readbackId
        case 'submission': return target.submissionId
    }
}

function assertSubmissionNativeOutcomeStatus(
    mode: ScratchSubmissionNativeOutcomeMode,
    status: ScratchSubmissionNativeOutcomeStatus
): void {

    if (mode !== 'summary' && mode !== 'off' && mode !== 'detailed') {
        throw new TypeError(`Unsupported submission native outcome mode: ${String(mode)}`)
    }
    if (
        status !== 'no-native-work' &&
        status !== 'observed-succeeded' &&
        status !== 'observed-failed' &&
        status !== 'unobserved' &&
        status !== 'observation-failed'
    ) {
        throw new TypeError(`Unsupported submission native outcome status: ${String(status)}`)
    }
    if (status === 'unobserved' && mode !== 'off') {
        throw new TypeError('Only off mode may publish an unobserved native outcome.')
    }
    if ((status === 'observed-succeeded' || status === 'observed-failed' || status === 'observation-failed') && mode === 'off') {
        throw new TypeError(`Off mode cannot publish ${status}.`)
    }
}

function assertSubmissionNativeOutcomeContents(
    status: ScratchSubmissionNativeOutcomeStatus,
    locations: readonly ScratchSubmissionNativeLocation[],
    outcomes: readonly unknown[]
): void {

    if (status === 'no-native-work' && (locations.length !== 0 || outcomes.length !== 0)) {
        throw new TypeError('No-native-work outcomes cannot retain native locations or failures.')
    }
    if ((status === 'observed-succeeded' || status === 'unobserved') && outcomes.length !== 0) {
        throw new TypeError(`${status} outcomes cannot retain native failures.`)
    }
    if ((status === 'observed-failed' || status === 'observation-failed') && outcomes.length === 0) {
        throw new TypeError(`${status} outcomes require at least one native failure.`)
    }
}

function assertReadbackNativeStage(stage: ScratchReadbackNativeStage): void {

    if (
        stage !== 'encoder-create' &&
        stage !== 'command-encode' &&
        stage !== 'encoder-finish' &&
        stage !== 'queue-submit' &&
        stage !== 'scope-settlement' &&
        stage !== 'lifecycle-recheck'
    ) {
        throw new TypeError(`Unsupported readback native stage: ${String(stage)}`)
    }
}

function assertSubmissionNativeLocation(
    location: ScratchSubmissionNativeLocation,
    submissionId: string
): void {

    if (location === null || typeof location !== 'object') {
        throw new TypeError('Submission native location must be an object.')
    }
    if (location.submissionId !== submissionId) {
        throw new TypeError('Submission native location belongs to another submission.')
    }

    switch (location.kind) {
        case 'submission': return
        case 'encoder-segment':
            assertNonNegativeInteger(location.segmentIndex, 'segmentIndex')
            return
        case 'pass':
            assertNonNegativeInteger(location.stepIndex, 'stepIndex')
            assertNonEmptyString(location.passId, 'passId')
            assertPassKind(location.passKind)
            return
        case 'render-attachment':
            assertNonNegativeInteger(location.stepIndex, 'stepIndex')
            assertNonEmptyString(location.passId, 'passId')
            if (location.attachmentKind !== 'color' && location.attachmentKind !== 'depth-stencil') {
                throw new TypeError(`Unsupported render attachment kind: ${String(location.attachmentKind)}`)
            }
            assertNonNegativeInteger(location.attachmentIndex, 'attachmentIndex')
            if ('surfaceId' in location) {
                if (location.attachmentKind !== 'color') {
                    throw new TypeError('Surface render attachments must be color attachments.')
                }
                assertNonEmptyString(location.surfaceId, 'surfaceId')
                assertNonEmptyString(location.surfaceFormat, 'surfaceFormat')
                assertNonNegativeInteger(location.configurationVersion, 'configurationVersion')
                return
            }
            assertNonEmptyString(location.viewSpecHash, 'viewSpecHash')
            assertNonEmptyString(location.resourceId, 'resourceId')
            assertNonNegativeInteger(location.allocationVersion, 'allocationVersion')
            return
        case 'standalone-command':
            assertNonNegativeInteger(location.stepIndex, 'stepIndex')
            assertNonEmptyString(location.commandId, 'commandId')
            assertNonEmptyString(location.commandKind, 'commandKind')
            return
        case 'pass-command':
            assertNonNegativeInteger(location.stepIndex, 'stepIndex')
            assertNonEmptyString(location.passId, 'passId')
            assertPassKind(location.passKind)
            assertNonEmptyString(location.commandId, 'commandId')
            assertNonEmptyString(location.commandKind, 'commandKind')
            return
        case 'queue-action':
            assertNonNegativeInteger(location.actionIndex, 'actionIndex')
            assertQueueActionKind(location.actionKind)
            return
    }

    throw new TypeError(`Unsupported submission native location kind: ${String((location as { kind?: unknown }).kind)}`)
}

function assertSubmissionNativeStage(value: unknown): asserts value is ScratchSubmissionNativeStage {

    if (
        value === 'encoder-create' ||
        value === 'attachment-view' ||
        value === 'pass-begin' ||
        value === 'command-encode' ||
        value === 'pass-end' ||
        value === 'encoder-finish' ||
        value === 'queue-action' ||
        value === 'queue-submit' ||
        value === 'scope-settlement' ||
        value === 'queue-completion' ||
        value === 'lifecycle-recheck'
    ) return
    throw new TypeError(`Unsupported submission native stage: ${String(value)}`)
}

function assertNativeErrorCategory(value: unknown): asserts value is GpuNativeErrorCategory {

    if (
        value === 'validation' ||
        value === 'internal' ||
        value === 'out-of-memory' ||
        value === 'native-exception' ||
        value === 'scope-failure' ||
        value === 'uncaptured-error' ||
        value === 'device-lost' ||
        value === 'none'
    ) return
    throw new TypeError(`Unsupported native error category: ${String(value)}`)
}

function assertPassKind(value: unknown): asserts value is 'render' | 'compute' {

    if (value === 'render' || value === 'compute') return
    throw new TypeError(`Unsupported pass kind: ${String(value)}`)
}

function assertQueueActionKind(value: unknown): asserts value is ScratchSubmissionQueueActionKind {

    if (
        value === 'command-buffer' ||
        value === 'buffer-upload' ||
        value === 'texture-upload' ||
        value === 'external-image-upload'
    ) return
    throw new TypeError(`Unsupported submission queue action kind: ${String(value)}`)
}

function assertNonEmptyString(value: unknown, name: string): asserts value is string {

    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`${name} must be a non-empty string.`)
    }
}

function assertNonNegativeInteger(value: unknown, name: string): asserts value is number {

    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${name} must be a non-negative safe integer.`)
    }
}

function copyDefined(
    target: Record<string, unknown>,
    source: Record<string, unknown>,
    keys: readonly string[]
): void {

    for (const key of keys) {
        if (source[key] !== undefined) target[key] = source[key]
    }
}

function copyJsonDefined(
    target: Record<string, unknown>,
    source: Record<string, unknown>,
    keys: readonly string[]
): void {

    for (const key of keys) {
        if (source[key] !== undefined) target[key] = cloneJsonValue(source[key])
    }
}

function cloneJsonValue(
    value: unknown,
    ancestors = new Set<object>(),
    boundDescriptorLabels = false
): ScratchJsonValue {

    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
    if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)

    if (Array.isArray(value)) {
        if (ancestors.has(value)) throw new TypeError('Diagnostic evidence cannot contain cycles.')
        const nextAncestors = new Set(ancestors)
        nextAncestors.add(value)
        return value
            .filter(item => item !== undefined && typeof item !== 'function' && typeof item !== 'symbol')
            .map(item => cloneJsonValue(item, nextAncestors, boundDescriptorLabels))
    }

    if (value !== null && typeof value === 'object') {
        if (ancestors.has(value)) throw new TypeError('Diagnostic evidence cannot contain cycles.')
        const nextAncestors = new Set(ancestors)
        nextAncestors.add(value)
        const result: Record<string, ScratchJsonValue> = {}
        for (const key of Object.keys(value).sort()) {
            const item = (value as Record<string, unknown>)[key]
            if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue
            result[key] = boundDescriptorLabels && key === 'label' && typeof item === 'string'
                ? boundString(item, 256)!
                : cloneJsonValue(item, nextAncestors, boundDescriptorLabels)
        }
        return result
    }

    return safeString(value)
}

function deepFreeze<T>(value: T): T {

    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value
    if (Object.isFrozen(value)) return value
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item)
    return Object.freeze(value)
}

function readStringProperty(value: object, key: string): string | undefined {

    try {
        const property = (value as Record<string, unknown>)[key]
        return typeof property === 'string' ? property : undefined
    } catch {
        return undefined
    }
}

function readBooleanProperty(value: object, key: string): boolean | undefined {

    try {
        const property = (value as Record<string, unknown>)[key]
        return typeof property === 'boolean' ? property : undefined
    } catch {
        return undefined
    }
}

function safeString(value: unknown): string {

    try {
        return String(value)
    } catch {
        return '[unprintable native error]'
    }
}

function boundString(value: string | undefined, maxLength: number): string | undefined {

    if (value === undefined || value.length <= maxLength) return value
    return `${value.slice(0, Math.max(0, maxLength - 3))}...`
}

export function boundedGpuOperationNativeLabel(value: unknown, resourceId: unknown): string | undefined {

    if (typeof value !== 'string') return undefined
    const maxLength = 256
    if (value.length <= maxLength) return value

    const suffix = typeof resourceId === 'string' ? ` [scratch:${resourceId}]` : undefined
    if (suffix !== undefined && value.endsWith(suffix) && suffix.length <= maxLength - 3) {
        const prefix = value.slice(0, -suffix.length)
        return `${prefix.slice(0, maxLength - suffix.length - 3)}...${suffix}`
    }
    return boundString(value, maxLength)
}

function fnv1a(value: string): string {

    let hash = 0x811c9dc5
    for (let index = 0; index < value.length; index++) {
        hash ^= value.charCodeAt(index)
        hash = Math.imul(hash, 0x01000193)
    }
    return (hash >>> 0).toString(16).padStart(8, '0')
}
