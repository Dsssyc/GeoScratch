import type { DiagnosticSubject } from './diagnostics.js'

export type ScratchJsonPrimitive = string | number | boolean | null
export type ScratchJsonValue =
    | ScratchJsonPrimitive
    | readonly ScratchJsonValue[]
    | Readonly<{ [key: string]: ScratchJsonValue }>

export type GpuOperationKind =
    | 'buffer-allocation'
    | 'texture-allocation'
    | 'texture-replacement'

export type GpuOperationStatus =
    | 'pending'
    | 'succeeded'
    | 'failed'
    | 'cancelled'

export type GpuNativeErrorCategory =
    | 'validation'
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

export type ScratchGpuOperationRecord = Readonly<{
    version: 1
    sequence: number
    id: string
    kind: GpuOperationKind
    status: GpuOperationStatus
    runtimeId: string
    resourceId: string
    resourceKind: 'BufferResource' | 'TextureResource'
    allocationVersion: number
    contentEpoch: number
    logicalFootprintBytes: number
    descriptor: GpuDescriptorEvidence
    nativeLabel?: string
    nativeErrorCategory?: GpuNativeErrorCategory
    incidentId?: string
    startedAtMs?: number
    settledAtMs?: number
    stack?: string
}>

export type ScratchGpuOperationRecordInput = Omit<ScratchGpuOperationRecord, 'version'> & {
    [key: string]: unknown
}

export type ScratchNativeGpuErrorFacts = Readonly<{
    name?: string
    message: string
    reason?: string
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
    | 'uncaptured-error'
    | 'device-loss'
    | 'capture-degraded'

export type ScratchGpuIncidentReport = Readonly<{
    version: 1
    sequence: number
    id: string
    kind: ScratchGpuIncidentKind
    diagnosticCode: string
    nativeErrorCategory: GpuNativeErrorCategory
    attribution: GpuAttributionConfidence
    runtimeId: string
    resourceId?: string
    operationId?: string
    subject: DiagnosticSubject
    related: readonly DiagnosticSubject[]
    triggerOperation?: ScratchGpuOperationRecord
    nativeError?: ScratchNativeGpuErrorFacts
    recentOperations: readonly ScratchGpuOperationRecord[]
    pressure?: ScratchGpuPressureEvidence
    evidence: ScratchGpuIncidentEvidenceCompleteness
}>

export type ScratchGpuIncidentReportInput = Omit<
    ScratchGpuIncidentReport,
    'version' | 'subject' | 'related'
> & {
    subject?: DiagnosticSubject
    related?: readonly DiagnosticSubject[]
    [key: string]: unknown
}

export function createGpuOperationRecord(
    input: ScratchGpuOperationRecordInput
): ScratchGpuOperationRecord {

    const record: Record<string, unknown> = {
        version: 1,
        sequence: input.sequence,
        id: input.id,
        kind: input.kind,
        status: input.status,
        runtimeId: input.runtimeId,
        resourceId: input.resourceId,
        resourceKind: input.resourceKind,
        allocationVersion: input.allocationVersion,
        contentEpoch: input.contentEpoch,
        logicalFootprintBytes: input.logicalFootprintBytes,
        descriptor: cloneJsonValue(input.descriptor),
    }

    copyDefined(record, input, [
        'nativeLabel',
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

    const subject = input.subject ?? {
        kind: 'Incident',
        id: input.id,
        incidentKind: input.kind,
    }
    const related = input.related ?? createIncidentRelatedSubjects(input)
    const report: Record<string, unknown> = {
        version: 1,
        sequence: input.sequence,
        id: input.id,
        kind: input.kind,
        diagnosticCode: input.diagnosticCode,
        nativeErrorCategory: input.nativeErrorCategory,
        attribution: input.attribution,
        runtimeId: input.runtimeId,
        subject: cloneJsonValue(subject),
        related: cloneJsonValue(related),
        recentOperations: cloneJsonValue(input.recentOperations),
        evidence: cloneJsonValue(input.evidence),
    }

    copyJsonDefined(report, input, [
        'resourceId',
        'operationId',
        'triggerOperation',
        'nativeError',
        'pressure',
    ])

    return deepFreeze(report) as ScratchGpuIncidentReport
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

    return deepFreeze({
        ...(name !== undefined ? { name } : {}),
        message,
        ...(reason !== undefined ? { reason } : {}),
    })
}

export function createGpuDescriptorEvidence(
    summary: Record<string, unknown>,
    full?: Record<string, unknown>
): GpuDescriptorEvidence {

    const normalizedSummary = cloneJsonValue(summary) as Readonly<Record<string, ScratchJsonValue>>
    const normalizedFull = full === undefined
        ? undefined
        : cloneJsonValue(full) as Readonly<Record<string, ScratchJsonValue>>
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
    if (input.resourceId !== undefined) {
        related.push({ kind: 'Resource', id: input.resourceId })
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

function cloneJsonValue(value: unknown, ancestors = new Set<object>()): ScratchJsonValue {

    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
    if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)

    if (Array.isArray(value)) {
        if (ancestors.has(value)) throw new TypeError('Diagnostic evidence cannot contain cycles.')
        const nextAncestors = new Set(ancestors)
        nextAncestors.add(value)
        return value
            .filter(item => item !== undefined && typeof item !== 'function' && typeof item !== 'symbol')
            .map(item => cloneJsonValue(item, nextAncestors))
    }

    if (value !== null && typeof value === 'object') {
        if (ancestors.has(value)) throw new TypeError('Diagnostic evidence cannot contain cycles.')
        const nextAncestors = new Set(ancestors)
        nextAncestors.add(value)
        const result: Record<string, ScratchJsonValue> = {}
        for (const key of Object.keys(value).sort()) {
            const item = (value as Record<string, unknown>)[key]
            if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue
            result[key] = cloneJsonValue(item, nextAncestors)
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

function fnv1a(value: string): string {

    let hash = 0x811c9dc5
    for (let index = 0; index < value.length; index++) {
        hash ^= value.charCodeAt(index)
        hash = Math.imul(hash, 0x01000193)
    }
    return (hash >>> 0).toString(16).padStart(8, '0')
}
