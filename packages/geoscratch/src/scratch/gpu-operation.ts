import type { DiagnosticSubject } from './diagnostics.js'
import { normalizePipelineCompilationReport } from './pipeline-compilation.js'
import type {
    PipelineCompilationReport,
    PipelineKind,
} from './pipeline-compilation.js'

const MAX_INCIDENT_RELATED_SUBJECTS = 64
const MAX_INCIDENT_OUTCOMES = 64

export type ScratchJsonPrimitive = string | number | boolean | null
export type ScratchJsonValue =
    | ScratchJsonPrimitive
    | readonly ScratchJsonValue[]
    | Readonly<{ [key: string]: ScratchJsonValue }>

export type GpuOperationKind =
    | 'buffer-allocation'
    | 'texture-allocation'
    | 'texture-replacement'
    | 'resource-disposal'
    | 'render-pipeline-creation'
    | 'compute-pipeline-creation'
    | 'pipeline-disposal'

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

export type ScratchGpuResourceOperationTarget = Readonly<{
    kind: 'resource'
    resourceId: string
    resourceKind: 'BufferResource' | 'TextureResource'
    allocationVersion: number
    contentEpoch: number
    logicalFootprintBytes: number
}>

export type ScratchGpuPipelineOperationTarget = Readonly<{
    kind: 'pipeline'
    pipelineId: string
    pipelineKind: PipelineKind
    programId: string
    programSourceHash: string
}>

export type ScratchGpuOperationTarget =
    | ScratchGpuResourceOperationTarget
    | ScratchGpuPipelineOperationTarget

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
    version: 2
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
    kind: 'buffer-allocation' | 'texture-allocation' | 'texture-replacement' | 'resource-disposal'
    nativeLabels?: never
    compilationReport?: never
}>

export type ScratchGpuPipelineOperationRecord = ScratchGpuOperationRecordBase & Readonly<{
    target: ScratchGpuPipelineOperationTarget
    kind: 'render-pipeline-creation' | 'compute-pipeline-creation' | 'pipeline-disposal'
}>

export type ScratchGpuOperationRecord =
    | ScratchGpuResourceOperationRecord
    | ScratchGpuPipelineOperationRecord

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
    [key: string]: unknown
}>

export type ScratchNativeGpuErrorFacts = Readonly<{
    name?: string
    message: string
    reason?: string
    truncated?: boolean
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
    triggerLogicalFootprintBytes: number
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
    | 'pipeline-failure'
    | 'uncaptured-error'
    | 'device-loss'
    | 'capture-degraded'

export type ScratchGpuIncidentFailureStage =
    | 'supporting-object-creation'
    | 'compilation-info'
    | 'shader-compilation'
    | 'pipeline-creation'
    | 'scope-settlement'
    | 'lifecycle-recheck'

export type ScratchGpuIncidentOutcome = Readonly<{
    stage: ScratchGpuIncidentFailureStage
    diagnosticCode: string
    nativeErrorCategory: GpuNativeErrorCategory
    subject?: DiagnosticSubject
    pipelineErrorReason?: GPUPipelineErrorReason
    nativeError?: ScratchNativeGpuErrorFacts
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
    version: 2
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
    target: ScratchGpuResourceOperationTarget
    kind: 'allocation-failure'
    pressure: ScratchGpuPressureEvidence
}>

export type ScratchGpuPipelineIncidentReport = ScratchGpuIncidentReportBase & Readonly<{
    target: ScratchGpuPipelineOperationTarget
    kind: 'pipeline-failure'
    failureStage: ScratchGpuIncidentFailureStage
    pipelineErrorReason?: GPUPipelineErrorReason
    compilationReport?: PipelineCompilationReport
    outcomes?: readonly ScratchGpuIncidentOutcome[]
    pressure?: never
}>

export type ScratchGpuRuntimeIncidentReport = ScratchGpuIncidentReportBase & Readonly<{
    target: ScratchGpuRuntimeIncidentTarget
    kind: 'uncaptured-error' | 'device-loss' | 'capture-degraded'
    pressure?: never
}>

export type ScratchGpuIncidentReport =
    | ScratchGpuResourceIncidentReport
    | ScratchGpuPipelineIncidentReport
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
    evidence: ScratchGpuIncidentEvidenceCompleteness
    [key: string]: unknown
}>

export function createGpuOperationRecord(
    input: ScratchGpuOperationRecordInput
): ScratchGpuOperationRecord {

    assertGpuOperationTarget(input.kind, input.target)
    const record: Record<string, unknown> = {
        version: 2,
        sequence: input.sequence,
        id: input.id,
        kind: input.kind,
        status: input.status,
        runtimeId: input.runtimeId,
        target: cloneJsonValue(input.target),
        descriptor: cloneJsonValue(input.descriptor),
    }

    const targetId = input.target.kind === 'resource'
        ? input.target.resourceId
        : input.target.pipelineId
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

    copyDefined(record, input, [
        'nativeErrorCategory',
        'incidentId',
        'startedAtMs',
        'settledAtMs',
        'stack',
    ])

    return deepFreeze(record) as ScratchGpuOperationRecord
}

export function createGpuIncidentReport(
    input: ScratchGpuIncidentReportInput
): ScratchGpuIncidentReport {

    assertIncidentTarget(input)
    const subject = input.subject ?? createIncidentSubject(input)
    const completeRelated = input.related ?? createIncidentRelatedSubjects(input)
    const related = completeRelated.slice(0, MAX_INCIDENT_RELATED_SUBJECTS)
    const outcomes = input.target.kind === 'pipeline' && input.outcomes !== undefined
        ? input.outcomes.slice(0, MAX_INCIDENT_OUTCOMES)
        : undefined
    const omittedEvidenceItems = Math.max(
        0,
        completeRelated.length - related.length
    ) + Math.max(
        0,
        (input.outcomes?.length ?? 0) - (outcomes?.length ?? 0)
    )
    const evidence = {
        ...input.evidence,
        complete: input.evidence.complete && omittedEvidenceItems === 0,
        omittedRecords: input.evidence.omittedRecords + omittedEvidenceItems,
    }
    const report: Record<string, unknown> = {
        version: 2,
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

    if (error !== null && (typeof error === 'object' || typeof error === 'function')) {
        name = readStringProperty(error, 'name')
        reason = readStringProperty(error, 'reason')
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
    if (input.target.kind === 'pipeline') {
        related.push({
            kind: 'Pipeline',
            id: input.target.pipelineId,
            pipelineKind: input.target.pipelineKind,
        })
        related.push({ kind: 'Program', id: input.target.programId })
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

    if (kind === 'buffer-allocation' && (
        target.kind !== 'resource' || target.resourceKind !== 'BufferResource'
    )) {
        throw new TypeError(`GPU operation ${kind} requires a BufferResource target.`)
    }
    if ((kind === 'texture-allocation' || kind === 'texture-replacement') && (
        target.kind !== 'resource' || target.resourceKind !== 'TextureResource'
    )) {
        throw new TypeError(`GPU operation ${kind} requires a TextureResource target.`)
    }
    if (kind === 'resource-disposal' && target.kind !== 'resource') {
        throw new TypeError(`GPU operation ${kind} has an incompatible ${target.kind} target.`)
    }
    if (kind === 'render-pipeline-creation' && (
        target.kind !== 'pipeline' || target.pipelineKind !== 'render'
    )) {
        throw new TypeError(`GPU operation ${kind} requires a render pipeline target.`)
    }
    if (kind === 'compute-pipeline-creation' && (
        target.kind !== 'pipeline' || target.pipelineKind !== 'compute'
    )) {
        throw new TypeError(`GPU operation ${kind} requires a compute pipeline target.`)
    }
    if (kind === 'pipeline-disposal' && target.kind !== 'pipeline') {
        throw new TypeError(`GPU operation ${kind} has an incompatible ${target.kind} target.`)
    }
}

function assertIncidentTarget(input: ScratchGpuIncidentReportInput): void {

    const expectedTargetKind = input.kind === 'allocation-failure'
        ? 'resource'
        : input.kind === 'pipeline-failure'
            ? 'pipeline'
            : 'runtime'
    if (input.target.kind !== expectedTargetKind) {
        throw new TypeError(`GPU incident ${input.kind} has an incompatible ${input.target.kind} target.`)
    }
    if (input.kind === 'pipeline-failure' && input.failureStage === undefined) {
        throw new TypeError('Pipeline failure incidents require a failureStage.')
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
