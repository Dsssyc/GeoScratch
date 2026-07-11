import { throwScratchDiagnostic } from './diagnostics.js'
import {
    createGpuDescriptorEvidence,
    createGpuIncidentReport,
    createGpuOperationRecord,
    serializeNativeGpuError,
    serializedEvidenceBytes,
} from './gpu-operation.js'
import type { DiagnosticSubject } from './diagnostics.js'
import type {
    GpuAttributionConfidence,
    GpuDescriptorEvidence,
    GpuNativeErrorCategory,
    GpuOperationKind,
    GpuOperationStatus,
    ScratchGpuIncidentKind,
    ScratchGpuIncidentReport,
    ScratchGpuOperationRecord,
    ScratchGpuPressureEvidence,
    ScratchNativeGpuErrorFacts,
} from './gpu-operation.js'
import type { Resource, ResourceState } from './resource.js'

const DEFAULT_OPERATION_CAPACITY = 256
const DEFAULT_INCIDENT_CAPACITY = 32
const DEFAULT_EVIDENCE_BYTE_CAPACITY = 256 * 1024
const DEFAULT_RECENT_OPERATION_LIMIT = 16
const DEFAULT_CONTRIBUTOR_LIMIT = 8
const DEFAULT_MAX_ACTIVE_CAPTURES = 4
const DEFAULT_CAPTURE_MAX_OPERATIONS = 128
const DEFAULT_CAPTURE_MAX_DURATION_MS = 5_000
const DEFAULT_CAPTURE_MAX_EVIDENCE_BYTES = 256 * 1024
const diagnosticsFacadeToken = Symbol('ScratchRuntimeDiagnostics')
const diagnosticCaptureToken = Symbol('ScratchDiagnosticCapture')

export type ScratchRuntimeDiagnosticsOptions = Readonly<{
    operationCapacity?: number
    incidentCapacity?: number
    evidenceByteCapacity?: number
    recentOperationLimit?: number
    contributorLimit?: number
    maxActiveCaptures?: number
}>

type NormalizedScratchRuntimeDiagnosticsOptions = Readonly<{
    operationCapacity: number
    incidentCapacity: number
    evidenceByteCapacity: number
    recentOperationLimit: number
    contributorLimit: number
    maxActiveCaptures: number
}>

export type ScratchRuntimeResourceFact = Readonly<{
    id: string
    label?: string
    resourceKind: string
    descriptorHash: string
    allocationVersion: number
    contentEpoch: number
    state: ResourceState
    logicalFootprintBytes: number
    logicalFootprintKnown: boolean
    lastAllocationOperationId?: string
    pendingReplacementOperationId?: string
}>

export type ScratchPendingGpuOperationFact = Readonly<{
    id: string
    sequence: number
    kind: GpuOperationKind
    resourceId: string
    resourceKind: 'BufferResource' | 'TextureResource'
    allocationVersion: number
    contentEpoch: number
    logicalFootprintBytes: number
    descriptorHash: string
    startedAtMs: number
}>

export type ScratchRuntimeDiagnosticsSnapshot = Readonly<{
    version: 1
    runtime: Readonly<{
        id: string
        label?: string
        isDisposed: boolean
        isDeviceLost: boolean
    }>
    resources: readonly ScratchRuntimeResourceFact[]
    pendingOperations: readonly ScratchPendingGpuOperationFact[]
    pressure: Readonly<{
        currentScratchLogicalFootprintBytes: number
        peakScratchLogicalFootprintBytes: number
        liveResourceCounts: Readonly<Record<string, number>>
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
        uncapturedErrors: number
        deviceLosses: number
    }>
    capture: Readonly<{
        activeCount: number
        maxActiveCaptures: number
    }>
}>

export type ScratchRuntimeDiagnosticsEvidence = Readonly<{
    version: 1
    snapshot: ScratchRuntimeDiagnosticsSnapshot
    operations: readonly ScratchGpuOperationRecord[]
    incidents: readonly ScratchGpuIncidentReport[]
}>

export type ScratchGpuOperationQuery = Readonly<{
    operationId?: string
    resourceId?: string
    kind?: GpuOperationKind
    status?: GpuOperationStatus
    sequenceFrom?: number
    sequenceTo?: number
}>

export type ScratchGpuIncidentQuery = Readonly<{
    incidentId?: string
    operationId?: string
    resourceId?: string
    kind?: ScratchGpuIncidentKind
    sequenceFrom?: number
    sequenceTo?: number
}>

export type ScratchDiagnosticCaptureOptions = Readonly<{
    maxOperations?: number
    maxDurationMs?: number
    maxEvidenceBytes?: number
    includeStacks?: boolean
    includeDescriptors?: boolean
}>

type NormalizedScratchDiagnosticCaptureOptions = Readonly<{
    maxOperations: number
    maxDurationMs: number
    maxEvidenceBytes: number
    includeStacks: boolean
    includeDescriptors: boolean
}>

export type ScratchDiagnosticCaptureStopReason =
    | 'explicit'
    | 'operation-limit'
    | 'duration-limit'
    | 'evidence-limit'
    | 'runtime-disposed'

export type ScratchDiagnosticCaptureReport = Readonly<{
    version: 1
    id: string
    runtimeId: string
    stopReason: ScratchDiagnosticCaptureStopReason
    operations: readonly ScratchGpuOperationRecord[]
    retainedEvidenceBytes: number
    omittedOperations: number
    startedAtMs: number
    stoppedAtMs: number
}>

export type ScratchGpuOperationStart = Readonly<{
    kind: GpuOperationKind
    resourceId: string
    resourceKind: 'BufferResource' | 'TextureResource'
    allocationVersion: number
    contentEpoch: number
    logicalFootprintBytes: number
    descriptorSummary: Record<string, unknown>
    fullDescriptor: Record<string, unknown>
    nativeLabel?: string
}>

export type ScratchPendingGpuOperation = Readonly<{
    id: string
    sequence: number
    runtimeId: string
    kind: GpuOperationKind
    resourceId: string
    resourceKind: 'BufferResource' | 'TextureResource'
    allocationVersion: number
    contentEpoch: number
    logicalFootprintBytes: number
    descriptor: GpuDescriptorEvidence
    fullDescriptor: GpuDescriptorEvidence
    nativeLabel?: string
    startedAtMs: number
    stack?: string
}>

export type ScratchGpuOperationCompletion = Readonly<{
    status: Exclude<GpuOperationStatus, 'pending'>
    nativeErrorCategory?: GpuNativeErrorCategory
    incidentId?: string
}>

export type ScratchGpuIncidentInput = Readonly<{
    kind: ScratchGpuIncidentKind
    diagnosticCode: string
    nativeErrorCategory: GpuNativeErrorCategory
    attribution: GpuAttributionConfidence
    resourceId?: string
    operationId?: string
    triggerOperation?: ScratchGpuOperationRecord
    nativeError?: ScratchNativeGpuErrorFacts
    triggerLogicalFootprintBytes?: number
}>

type RuntimeDiagnosticsOwner = {
    id: string
    label?: string
    isDisposed: boolean
    isDeviceLost: boolean
    deviceLostInfo?: GPUDeviceLostInfo
}

export type ScratchRuntimeLifecycleChange =
    | Readonly<{ kind: 'device-lost', info: GPUDeviceLostInfo }>
    | Readonly<{ kind: 'runtime-disposed' }>

type RetainedEvidence<T> = {
    value: T
    bytes: number
}

type AggregateFacts = ScratchRuntimeDiagnosticsSnapshot['aggregates']

type CaptureState = {
    id: string
    runtimeId: string
    controller: ScratchRuntimeDiagnosticsController
    options: NormalizedScratchDiagnosticCaptureOptions
    operations: ScratchGpuOperationRecord[]
    retainedEvidenceBytes: number
    omittedOperations: number
    startedAtMs: number
    timer: ReturnType<typeof setTimeout>
    isActive: boolean
    report?: ScratchDiagnosticCaptureReport
}

const controllerByRuntime = new WeakMap<object, ScratchRuntimeDiagnosticsController>()
const captureStates = new WeakMap<ScratchDiagnosticCapture, CaptureState>()

export class ScratchRuntimeDiagnostics {

    #controller: ScratchRuntimeDiagnosticsController

    private constructor(token: symbol, controller: ScratchRuntimeDiagnosticsController) {

        if (token !== diagnosticsFacadeToken) throw new TypeError('ScratchRuntimeDiagnostics is runtime-owned.')
        this.#controller = controller
        Object.freeze(this)
    }

    snapshot(): ScratchRuntimeDiagnosticsSnapshot {

        return this.#controller.snapshot()
    }

    operations(query: ScratchGpuOperationQuery = {}): readonly ScratchGpuOperationRecord[] {

        return this.#controller.operations(query)
    }

    incidents(query: ScratchGpuIncidentQuery = {}): readonly ScratchGpuIncidentReport[] {

        return this.#controller.incidents(query)
    }

    operation(operationId: string): ScratchGpuOperationRecord | undefined {

        return this.#controller.operation(operationId)
    }

    incident(incidentId: string): ScratchGpuIncidentReport | undefined {

        return this.#controller.incident(incidentId)
    }

    exportEvidence(): ScratchRuntimeDiagnosticsEvidence {

        return this.#controller.exportEvidence()
    }

    capture(options: ScratchDiagnosticCaptureOptions = {}): ScratchDiagnosticCapture {

        return this.#controller.capture(options)
    }
}

export class ScratchDiagnosticCapture {

    private constructor(token: symbol) {

        if (token !== diagnosticCaptureToken) throw new TypeError('ScratchDiagnosticCapture is runtime-owned.')
        Object.preventExtensions(this)
    }

    get id(): string {

        return captureStateFor(this).id
    }

    get isActive(): boolean {

        return captureStateFor(this).isActive
    }

    stop(): ScratchDiagnosticCaptureReport {

        return stopCapture(this, 'explicit')
    }
}

export class ScratchRuntimeDiagnosticsController {

    #owner: RuntimeDiagnosticsOwner
    #device: GPUDevice
    #options: NormalizedScratchRuntimeDiagnosticsOptions
    #facade: ScratchRuntimeDiagnostics
    #resourceFacts = new Map<string, ScratchRuntimeResourceFact>()
    #pendingOperations = new Map<string, ScratchPendingGpuOperation>()
    #operations: RetainedEvidence<ScratchGpuOperationRecord>[] = []
    #incidents: RetainedEvidence<ScratchGpuIncidentReport>[] = []
    #captures = new Set<ScratchDiagnosticCapture>()
    #operationSequence = 0
    #incidentSequence = 0
    #captureSequence = 0
    #retainedEvidenceBytes = 0
    #overwrittenOperations = 0
    #overwrittenIncidents = 0
    #omittedRecords = 0
    #currentLogicalFootprintBytes = 0
    #peakLogicalFootprintBytes = 0
    #aggregates: AggregateFacts = {
        allocationAttempts: 0,
        successfulAllocations: 0,
        validationFailures: 0,
        outOfMemoryFailures: 0,
        nativeFailures: 0,
        scopeFailures: 0,
        cancelledAllocations: 0,
        uncapturedErrors: 0,
        deviceLosses: 0,
    }
    #uncapturedErrorListener: ((event: GPUUncapturedErrorEvent) => void) | undefined
    #lifecycleSubscribers = new Set<(change: ScratchRuntimeLifecycleChange) => void>()
    #isDisposed = false
    #deviceLossIncident: ScratchGpuIncidentReport | undefined

    constructor(
        owner: RuntimeDiagnosticsOwner,
        device: GPUDevice,
        options: ScratchRuntimeDiagnosticsOptions = {}
    ) {

        this.#owner = owner
        this.#device = device
        this.#options = normalizeDiagnosticsOptions(owner, options)
        this.#facade = createDiagnosticsFacade(this)
        this.#installUncapturedErrorListener()
    }

    get facade(): ScratchRuntimeDiagnostics {

        return this.#facade
    }

    get lifecycleSubscriberCount(): number {

        return this.#lifecycleSubscribers.size
    }

    subscribeLifecycle(subscriber: (change: ScratchRuntimeLifecycleChange) => void): () => void {

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

    snapshot(): ScratchRuntimeDiagnosticsSnapshot {

        const resources = [ ...this.#resourceFacts.values() ]
            .sort((left, right) => left.id.localeCompare(right.id))
        const pendingOperations = [ ...this.#pendingOperations.values() ]
            .sort((left, right) => left.sequence - right.sequence)
            .map(operation => pendingFact(operation))

        return freezeEvidence({
            version: 1,
            runtime: {
                id: this.#owner.id,
                ...(this.#owner.label !== undefined ? { label: this.#owner.label } : {}),
                isDisposed: this.#owner.isDisposed,
                isDeviceLost: this.#owner.isDeviceLost,
            },
            resources,
            pendingOperations,
            pressure: {
                currentScratchLogicalFootprintBytes: this.#currentLogicalFootprintBytes,
                peakScratchLogicalFootprintBytes: this.#peakLogicalFootprintBytes,
                liveResourceCounts: this.#liveResourceCounts(),
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

    operations(query: ScratchGpuOperationQuery = {}): readonly ScratchGpuOperationRecord[] {

        return Object.freeze(this.#operations
            .map(entry => entry.value)
            .filter(record => matchesOperationQuery(record, query)))
    }

    incidents(query: ScratchGpuIncidentQuery = {}): readonly ScratchGpuIncidentReport[] {

        return Object.freeze(this.#incidents
            .map(entry => entry.value)
            .filter(report => matchesIncidentQuery(report, query)))
    }

    operation(operationId: string): ScratchGpuOperationRecord | undefined {

        return this.#operations.find(entry => entry.value.id === operationId)?.value
    }

    incident(incidentId: string): ScratchGpuIncidentReport | undefined {

        return this.#incidents.find(entry => entry.value.id === incidentId)?.value
    }

    exportEvidence(): ScratchRuntimeDiagnosticsEvidence {

        return freezeEvidence({
            version: 1,
            snapshot: this.snapshot(),
            operations: this.operations(),
            incidents: this.incidents(),
        })
    }

    beginOperation(input: ScratchGpuOperationStart): ScratchPendingGpuOperation {

        const sequence = ++this.#operationSequence
        const id = `${this.#owner.id}/gpu-operation-${sequence}`
        const needsStack = [ ...this.#captures ].some(capture => {
            const state = captureStateFor(capture)
            return state.isActive && state.options.includeStacks
        })
        const operation: ScratchPendingGpuOperation = Object.freeze({
            id,
            sequence,
            runtimeId: this.#owner.id,
            kind: input.kind,
            resourceId: input.resourceId,
            resourceKind: input.resourceKind,
            allocationVersion: input.allocationVersion,
            contentEpoch: input.contentEpoch,
            logicalFootprintBytes: input.logicalFootprintBytes,
            descriptor: createGpuDescriptorEvidence(input.descriptorSummary),
            fullDescriptor: createGpuDescriptorEvidence(input.descriptorSummary, input.fullDescriptor),
            ...(input.nativeLabel !== undefined ? { nativeLabel: input.nativeLabel } : {}),
            startedAtMs: nowMs(),
            ...(needsStack ? { stack: captureStack() } : {}),
        })

        this.#pendingOperations.set(id, operation)
        this.#aggregates = {
            ...this.#aggregates,
            allocationAttempts: this.#aggregates.allocationAttempts + 1,
        }
        if (input.kind === 'texture-replacement') {
            this.#setPendingReplacement(input.resourceId, id)
        }

        return operation
    }

    completeOperation(
        operation: ScratchPendingGpuOperation,
        completion: ScratchGpuOperationCompletion
    ): ScratchGpuOperationRecord {

        if (this.#pendingOperations.get(operation.id) !== operation) {
            throw new TypeError(`GPU operation ${operation.id} is not pending on this runtime.`)
        }

        this.#pendingOperations.delete(operation.id)
        this.#clearPendingReplacement(operation.resourceId, operation.id)

        const baseInput = {
            sequence: operation.sequence,
            id: operation.id,
            kind: operation.kind,
            status: completion.status,
            runtimeId: operation.runtimeId,
            resourceId: operation.resourceId,
            resourceKind: operation.resourceKind,
            allocationVersion: operation.allocationVersion,
            contentEpoch: operation.contentEpoch,
            logicalFootprintBytes: operation.logicalFootprintBytes,
            descriptor: operation.descriptor,
            ...(operation.nativeLabel !== undefined ? { nativeLabel: operation.nativeLabel } : {}),
            ...(completion.nativeErrorCategory !== undefined
                ? { nativeErrorCategory: completion.nativeErrorCategory }
                : {}),
            ...(completion.incidentId !== undefined ? { incidentId: completion.incidentId } : {}),
            startedAtMs: operation.startedAtMs,
            settledAtMs: nowMs(),
        } as const
        const record = createGpuOperationRecord(baseInput)

        this.#recordOperation(record)
        for (const capture of [ ...this.#captures ]) {
            acceptCaptureOperation(capture, operation, completion)
        }
        this.#recordCompletionAggregate(completion)
        if (completion.status === 'succeeded') this.linkResourceOperation(operation.resourceId, operation.id)

        return record
    }

    linkOperationIncident(operationId: string, incidentId: string): void {

        const entry = this.#operations.find(item => item.value.id === operationId)
        if (entry === undefined) return

        const replacement = createGpuOperationRecord({ ...entry.value, incidentId })
        const bytes = serializedEvidenceBytes(replacement)
        this.#retainedEvidenceBytes += bytes - entry.bytes
        entry.value = replacement
        entry.bytes = bytes
        this.#trimOperationEvidenceToBudget()
    }

    recordIncident(input: ScratchGpuIncidentInput): ScratchGpuIncidentReport {

        const sequence = ++this.#incidentSequence
        const id = `${this.#owner.id}/gpu-incident-${sequence}`
        const recentOperations = this.#recentOperations(input.operationId)
        const pendingOperations = [ ...this.#pendingOperations.values() ]
            .slice(0, this.#options.recentOperationLimit)
            .map(pendingFact)
        const currentResources = this.#largestResourceFacts(this.#options.contributorLimit)
        const localOmissions = Math.max(0, this.#pendingOperations.size - pendingOperations.length) +
            Math.max(0, this.#resourceFacts.size - currentResources.length)
        const report = createGpuIncidentReport({
            sequence,
            id,
            kind: input.kind,
            diagnosticCode: input.diagnosticCode,
            nativeErrorCategory: input.nativeErrorCategory,
            attribution: input.attribution,
            runtimeId: this.#owner.id,
            ...(input.resourceId !== undefined ? { resourceId: input.resourceId } : {}),
            ...(input.operationId !== undefined ? { operationId: input.operationId } : {}),
            ...(input.triggerOperation !== undefined ? { triggerOperation: input.triggerOperation } : {}),
            ...(input.nativeError !== undefined ? { nativeError: input.nativeError } : {}),
            recentOperations,
            ...(pendingOperations.length > 0 ? { pendingOperations } : {}),
            ...(currentResources.length > 0 ? { currentResources } : {}),
            pressure: this.#pressureEvidence(input.triggerLogicalFootprintBytes ?? 0),
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

    recordDeviceLoss(info: GPUDeviceLostInfo): ScratchGpuIncidentReport | undefined {

        if (this.#isDisposed) return undefined
        this.#publishLifecycleChange(Object.freeze({ kind: 'device-lost', info }))
        if (this.#deviceLossIncident !== undefined) return this.#deviceLossIncident

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
            nativeError: serializeNativeGpuError(info),
        })
        return this.#deviceLossIncident
    }

    capture(options: ScratchDiagnosticCaptureOptions): ScratchDiagnosticCapture {

        if (this.#captures.size >= this.#options.maxActiveCaptures) {
            throwScratchDiagnostic({
                code: 'SCRATCH_DIAGNOSTIC_CAPTURE_LIMIT_EXCEEDED',
                severity: 'error',
                phase: 'runtime',
                subject: this.#runtimeSubject(),
                message: 'ScratchRuntime has reached its active diagnostic capture limit.',
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
        this.#recalculatePressure()
    }

    unregisterResource(resource: Resource): void {

        this.#resourceFacts.delete(resource.id)
        this.#recalculatePressure()
    }

    linkResourceOperation(resourceId: string, operationId: string): void {

        const fact = this.#resourceFacts.get(resourceId)
        if (fact === undefined) return
        this.#resourceFacts.set(resourceId, Object.freeze({
            ...fact,
            lastAllocationOperationId: operationId,
        }))
    }

    dispose(): void {

        if (this.#isDisposed) return
        this.#isDisposed = true
        this.#publishLifecycleChange(Object.freeze({ kind: 'runtime-disposed' }))
        if (this.#uncapturedErrorListener !== undefined && typeof this.#device.removeEventListener === 'function') {
            this.#device.removeEventListener('uncapturederror', this.#uncapturedErrorListener)
        }
        for (const capture of [ ...this.#captures ]) stopCapture(capture, 'runtime-disposed')
    }

    #publishLifecycleChange(change: ScratchRuntimeLifecycleChange): void {

        const subscribers = [ ...this.#lifecycleSubscribers ]
        this.#lifecycleSubscribers.clear()
        for (const subscriber of subscribers) subscriber(change)
    }

    captureStopped(capture: ScratchDiagnosticCapture, reason: ScratchDiagnosticCaptureStopReason): void {

        this.#captures.delete(capture)
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

    #recordOperation(record: ScratchGpuOperationRecord): void {

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

    #recordIncident(report: ScratchGpuIncidentReport): void {

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

    #recordCompletionAggregate(completion: ScratchGpuOperationCompletion): void {

        const next = { ...this.#aggregates }
        if (completion.status === 'succeeded') next.successfulAllocations++
        if (completion.status === 'cancelled') next.cancelledAllocations++
        if (completion.nativeErrorCategory === 'validation') next.validationFailures++
        if (completion.nativeErrorCategory === 'out-of-memory') next.outOfMemoryFailures++
        if (completion.nativeErrorCategory === 'native-exception') next.nativeFailures++
        if (completion.nativeErrorCategory === 'scope-failure') next.scopeFailures++
        this.#aggregates = next
    }

    #recentOperations(operationId?: string): ScratchGpuOperationRecord[] {

        const recent = this.#operations
            .slice(-this.#options.recentOperationLimit)
            .map(entry => entry.value)
        if (operationId === undefined || recent.some(record => record.id === operationId)) return recent
        const trigger = this.operation(operationId)
        if (trigger === undefined) return recent
        return [ trigger, ...recent ].slice(-this.#options.recentOperationLimit)
    }

    #pressureEvidence(triggerLogicalFootprintBytes: number): ScratchGpuPressureEvidence {

        const largestContributors = this.#largestResourceFacts(this.#options.contributorLimit)
            .map(fact => ({
                resourceId: fact.id,
                resourceKind: fact.resourceKind,
                logicalFootprintBytes: fact.logicalFootprintBytes,
                ...(fact.label !== undefined ? { label: boundedLabel(fact.label) } : {}),
                allocationVersion: fact.allocationVersion,
            }))
        const recentChurn = this.#operations
            .slice(-this.#options.recentOperationLimit)
            .map(({ value }) => ({
                sequence: value.sequence,
                operationId: value.id,
                operationKind: value.kind,
                status: value.status,
                resourceId: value.resourceId,
                logicalFootprintBytes: value.logicalFootprintBytes,
            }))

        return freezeEvidence({
            triggerLogicalFootprintBytes,
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

    #largestResourceFacts(limit: number): ScratchRuntimeResourceFact[] {

        return [ ...this.#resourceFacts.values() ]
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
            .reduce((total, fact) => total + fact.logicalFootprintBytes, 0)
        this.#peakLogicalFootprintBytes = Math.max(
            this.#peakLogicalFootprintBytes,
            this.#currentLogicalFootprintBytes
        )
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

    #runtimeSubject(): DiagnosticSubject {

        return {
            kind: 'ScratchRuntime',
            id: this.#owner.id,
            ...(this.#owner.label !== undefined ? { label: this.#owner.label } : {}),
        }
    }
}

export function registerRuntimeDiagnostics(
    runtime: object,
    controller: ScratchRuntimeDiagnosticsController
): void {

    controllerByRuntime.set(runtime, controller)
}

export function diagnosticsControllerFor(runtime: object): ScratchRuntimeDiagnosticsController {

    const controller = controllerByRuntime.get(runtime)
    if (controller === undefined) throw new TypeError('ScratchRuntime diagnostics are unavailable.')
    return controller
}

export function updateRuntimeResourceFact(runtime: object, resource: Resource): void {

    controllerByRuntime.get(runtime)?.updateResource(resource)
}

function createDiagnosticsFacade(
    controller: ScratchRuntimeDiagnosticsController
): ScratchRuntimeDiagnostics {

    const Constructor = ScratchRuntimeDiagnostics as unknown as new (
        token: symbol,
        controller: ScratchRuntimeDiagnosticsController
    ) => ScratchRuntimeDiagnostics
    return new Constructor(diagnosticsFacadeToken, controller)
}

function createDiagnosticCapture(input: {
    id: string
    runtimeId: string
    controller: ScratchRuntimeDiagnosticsController
    options: NormalizedScratchDiagnosticCaptureOptions
}): ScratchDiagnosticCapture {

    const Constructor = ScratchDiagnosticCapture as unknown as new (token: symbol) => ScratchDiagnosticCapture
    const capture = new Constructor(diagnosticCaptureToken)
    const state: CaptureState = {
        ...input,
        operations: [],
        retainedEvidenceBytes: 0,
        omittedOperations: 0,
        startedAtMs: nowMs(),
        timer: undefined as unknown as ReturnType<typeof setTimeout>,
        isActive: true,
    }
    captureStates.set(capture, state)
    state.timer = setTimeout(() => stopCapture(capture, 'duration-limit'), input.options.maxDurationMs)
    const timer = state.timer as unknown as { unref?: () => void }
    timer.unref?.()
    return capture
}

function acceptCaptureOperation(
    capture: ScratchDiagnosticCapture,
    operation: ScratchPendingGpuOperation,
    completion: ScratchGpuOperationCompletion
): void {

    const state = captureStateFor(capture)
    if (!state.isActive) return

    const record = createGpuOperationRecord({
        sequence: operation.sequence,
        id: operation.id,
        kind: operation.kind,
        status: completion.status,
        runtimeId: operation.runtimeId,
        resourceId: operation.resourceId,
        resourceKind: operation.resourceKind,
        allocationVersion: operation.allocationVersion,
        contentEpoch: operation.contentEpoch,
        logicalFootprintBytes: operation.logicalFootprintBytes,
        descriptor: state.options.includeDescriptors ? operation.fullDescriptor : operation.descriptor,
        ...(operation.nativeLabel !== undefined ? { nativeLabel: operation.nativeLabel } : {}),
        ...(completion.nativeErrorCategory !== undefined
            ? { nativeErrorCategory: completion.nativeErrorCategory }
            : {}),
        ...(completion.incidentId !== undefined ? { incidentId: completion.incidentId } : {}),
        startedAtMs: operation.startedAtMs,
        settledAtMs: nowMs(),
        ...(state.options.includeStacks && operation.stack !== undefined ? { stack: operation.stack } : {}),
    })
    const bytes = serializedEvidenceBytes(record)

    if (state.retainedEvidenceBytes + bytes > state.options.maxEvidenceBytes) {
        state.omittedOperations++
        stopCapture(capture, 'evidence-limit')
        return
    }

    state.operations.push(record)
    state.retainedEvidenceBytes += bytes
    if (state.operations.length >= state.options.maxOperations) {
        stopCapture(capture, 'operation-limit')
    }
}

function stopCapture(
    capture: ScratchDiagnosticCapture,
    reason: ScratchDiagnosticCaptureStopReason
): ScratchDiagnosticCaptureReport {

    const state = captureStateFor(capture)
    if (state.report !== undefined) return state.report

    state.isActive = false
    clearTimeout(state.timer)
    state.report = freezeEvidence({
        version: 1,
        id: state.id,
        runtimeId: state.runtimeId,
        stopReason: reason,
        operations: [ ...state.operations ],
        retainedEvidenceBytes: state.retainedEvidenceBytes,
        omittedOperations: state.omittedOperations,
        startedAtMs: state.startedAtMs,
        stoppedAtMs: nowMs(),
    })
    state.controller.captureStopped(capture, reason)
    return state.report
}

function captureStateFor(capture: ScratchDiagnosticCapture): CaptureState {

    const state = captureStates.get(capture)
    if (state === undefined) throw new TypeError('ScratchDiagnosticCapture state is unavailable.')
    return state
}

function normalizeDiagnosticsOptions(
    owner: RuntimeDiagnosticsOwner,
    options: ScratchRuntimeDiagnosticsOptions
): NormalizedScratchRuntimeDiagnosticsOptions {

    return Object.freeze({
        operationCapacity: finiteIntegerOption(owner, options.operationCapacity, 'operationCapacity', 0, DEFAULT_OPERATION_CAPACITY),
        incidentCapacity: finiteIntegerOption(owner, options.incidentCapacity, 'incidentCapacity', 0, DEFAULT_INCIDENT_CAPACITY),
        evidenceByteCapacity: finiteIntegerOption(owner, options.evidenceByteCapacity, 'evidenceByteCapacity', 0, DEFAULT_EVIDENCE_BYTE_CAPACITY),
        recentOperationLimit: finiteIntegerOption(owner, options.recentOperationLimit, 'recentOperationLimit', 1, DEFAULT_RECENT_OPERATION_LIMIT),
        contributorLimit: finiteIntegerOption(owner, options.contributorLimit, 'contributorLimit', 1, DEFAULT_CONTRIBUTOR_LIMIT),
        maxActiveCaptures: finiteIntegerOption(owner, options.maxActiveCaptures, 'maxActiveCaptures', 1, DEFAULT_MAX_ACTIVE_CAPTURES),
    })
}

function normalizeCaptureOptions(
    owner: RuntimeDiagnosticsOwner,
    options: ScratchDiagnosticCaptureOptions
): NormalizedScratchDiagnosticCaptureOptions {

    return Object.freeze({
        maxOperations: finiteIntegerOption(owner, options.maxOperations, 'maxOperations', 1, DEFAULT_CAPTURE_MAX_OPERATIONS),
        maxDurationMs: finiteNumberOption(owner, options.maxDurationMs, 'maxDurationMs', DEFAULT_CAPTURE_MAX_DURATION_MS),
        maxEvidenceBytes: finiteIntegerOption(owner, options.maxEvidenceBytes, 'maxEvidenceBytes', 1, DEFAULT_CAPTURE_MAX_EVIDENCE_BYTES),
        includeStacks: options.includeStacks === true,
        includeDescriptors: options.includeDescriptors === true,
    })
}

function finiteIntegerOption(
    owner: RuntimeDiagnosticsOwner,
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
    owner: RuntimeDiagnosticsOwner,
    value: unknown,
    name: string,
    fallback: number
): number {

    if (value === undefined) return fallback
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
    throwDiagnosticsOption(owner, name, value, 'finite number > 0')
}

function throwDiagnosticsOption(
    owner: RuntimeDiagnosticsOwner,
    name: string,
    value: unknown,
    expected: string
): never {

    throwScratchDiagnostic({
        code: 'SCRATCH_RESOURCE_DESCRIPTOR_INVALID',
        severity: 'error',
        phase: 'runtime',
        subject: {
            kind: 'ScratchRuntime',
            id: owner.id,
            ...(owner.label !== undefined ? { label: owner.label } : {}),
        },
        message: `ScratchRuntime diagnostic option ${name} is invalid.`,
        expected: { [name]: expected },
        actual: { [name]: value },
    })
}

function pendingFact(operation: ScratchPendingGpuOperation): ScratchPendingGpuOperationFact {

    return Object.freeze({
        id: operation.id,
        sequence: operation.sequence,
        kind: operation.kind,
        resourceId: operation.resourceId,
        resourceKind: operation.resourceKind,
        allocationVersion: operation.allocationVersion,
        contentEpoch: operation.contentEpoch,
        logicalFootprintBytes: operation.logicalFootprintBytes,
        descriptorHash: operation.descriptor.hash,
        startedAtMs: operation.startedAtMs,
    })
}

function resourceFact(
    resource: Resource,
    previous?: ScratchRuntimeResourceFact
): ScratchRuntimeResourceFact {

    const footprint = logicalResourceFootprint(resource)
    const descriptor = createGpuDescriptorEvidence(resourceDescriptorSummary(resource))
    return Object.freeze({
        id: resource.id,
        ...(resource.label !== undefined ? { label: resource.label } : {}),
        resourceKind: resource.resourceKind,
        descriptorHash: descriptor.hash,
        allocationVersion: resource.allocationVersion,
        contentEpoch: resource.contentEpoch,
        state: resource.state,
        logicalFootprintBytes: footprint.bytes,
        logicalFootprintKnown: footprint.known,
        ...(previous?.lastAllocationOperationId !== undefined
            ? { lastAllocationOperationId: previous.lastAllocationOperationId }
            : {}),
        ...(previous?.pendingReplacementOperationId !== undefined
            ? { pendingReplacementOperationId: previous.pendingReplacementOperationId }
            : {}),
    })
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
    if (
        typeof width !== 'number' || typeof height !== 'number' || typeof layers !== 'number' ||
        typeof mipLevelCount !== 'number' || typeof sampleCount !== 'number' || typeof format !== 'string'
    ) return { bytes: 0, known: false }

    const block = textureFormatBlock(format)
    if (block === undefined) return { bytes: 0, known: false }

    let total = 0
    for (let mip = 0; mip < mipLevelCount; mip++) {
        const mipWidth = Math.max(1, Math.floor(width / 2 ** mip))
        const mipHeight = Math.max(1, Math.floor(height / 2 ** mip))
        total += Math.ceil(mipWidth / block.width) *
            Math.ceil(mipHeight / block.height) *
            layers * block.bytes * sampleCount
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
    record: ScratchGpuOperationRecord,
    query: ScratchGpuOperationQuery
): boolean {

    return (query.operationId === undefined || record.id === query.operationId) &&
        (query.resourceId === undefined || record.resourceId === query.resourceId) &&
        (query.kind === undefined || record.kind === query.kind) &&
        (query.status === undefined || record.status === query.status) &&
        (query.sequenceFrom === undefined || record.sequence >= query.sequenceFrom) &&
        (query.sequenceTo === undefined || record.sequence <= query.sequenceTo)
}

function matchesIncidentQuery(
    report: ScratchGpuIncidentReport,
    query: ScratchGpuIncidentQuery
): boolean {

    return (query.incidentId === undefined || report.id === query.incidentId) &&
        (query.operationId === undefined || report.operationId === query.operationId) &&
        (query.resourceId === undefined || report.resourceId === query.resourceId) &&
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

function freezeEvidence<T>(value: T): T {

    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value
    if (Object.isFrozen(value)) return value
    for (const item of Object.values(value as Record<string, unknown>)) freezeEvidence(item)
    return Object.freeze(value)
}

Object.freeze(ScratchRuntimeDiagnostics.prototype)
Object.freeze(ScratchDiagnosticCapture.prototype)
