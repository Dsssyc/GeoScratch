import { registerResource, Resource } from './resource.js'
import { throwScratchDiagnostic } from './diagnostics.js'
import { updateRuntimeResourceFact } from './runtime-diagnostics.js'
import { isRecord } from './type-utils.js'
import type { DiagnosticSubject } from './diagnostics.js'
import type { ScratchRuntime } from './runtime.js'

export type QuerySetType = 'timestamp' | 'occlusion'
export type QuerySetSlotState = 'empty' | 'ready' | 'indeterminate'

export type QuerySetSlotSnapshot = Readonly<{
    index: number
    state: QuerySetSlotState
    contentEpoch: number
}>

type MutableQuerySetSlotFacts = {
    states: QuerySetSlotState[]
    contentEpochs: number[]
}

const querySetSlotFacts = new WeakMap<QuerySetResource, MutableQuerySetSlotFacts>()

function slotFactsFor(querySet: QuerySetResource): MutableQuerySetSlotFacts {

    const facts = querySetSlotFacts.get(querySet)
    if (facts === undefined) throw new TypeError('QuerySetResource slot facts are unavailable.')
    return facts
}

export function setQuerySlotContentState(
    querySet: QuerySetResource,
    index: number,
    state: QuerySetSlotState,
    contentEpoch: number
): void {

    assertQuerySlotIndex(querySet, index)
    const facts = slotFactsFor(querySet)
    facts.states[index] = state
    facts.contentEpochs[index] = contentEpoch
    updateRuntimeResourceFact(querySet.runtime, querySet)
}

export function querySlotState(querySet: QuerySetResource, index: number): QuerySetSlotState {

    assertQuerySlotIndex(querySet, index)
    return slotFactsFor(querySet).states[index] as QuerySetSlotState
}

export function querySlotContentEpoch(querySet: QuerySetResource, index: number): number {

    assertQuerySlotIndex(querySet, index)
    return slotFactsFor(querySet).contentEpochs[index] as number
}

export function advanceQuerySlotContentEpoch(querySet: QuerySetResource, index: number): void {

    assertQuerySlotIndex(querySet, index)
    const facts = slotFactsFor(querySet)
    facts.contentEpochs[index] = (facts.contentEpochs[index] ?? 0) + 1
    facts.states[index] = 'ready'
    updateRuntimeResourceFact(querySet.runtime, querySet)
}

const QUERY_SET_TYPES = new Set<QuerySetType>([ 'timestamp', 'occlusion' ])

export type QuerySetResourceDescriptor = {
    label?: string
    type: QuerySetType
    count: number
}

export class QuerySetResource extends Resource {

    readonly type: QuerySetType
    readonly count: number
    readonly gpuQuerySet: GPUQuerySet

    constructor(runtime: ScratchRuntime, descriptor: QuerySetResourceDescriptor) {

        const normalizedDescriptor = normalizeQuerySetDescriptor(runtime, descriptor)

        super(runtime, {
            resourceKind: 'QuerySetResource',
            descriptor: normalizedDescriptor,
            ...(normalizedDescriptor.label !== undefined ? { label: normalizedDescriptor.label } : {}),
        })

        this.type = normalizedDescriptor.type
        this.count = normalizedDescriptor.count
        querySetSlotFacts.set(this, {
            states: Array.from({ length: this.count }, () => 'empty'),
            contentEpochs: Array.from({ length: this.count }, () => 0),
        })
        this.gpuQuerySet = runtime.device.createQuerySet(normalizedDescriptor)
        registerResource(this)
    }

    static create(runtime: ScratchRuntime, descriptor: QuerySetResourceDescriptor): QuerySetResource {

        return new QuerySetResource(runtime, descriptor)
    }

    get subject(): DiagnosticSubject {

        const subject: DiagnosticSubject = {
            kind: 'QuerySet',
            id: this.id,
            queryType: this.type,
        }
        if (this.label !== undefined) subject.label = this.label

        return subject
    }

    slot(index: number): QuerySetSlotSnapshot {

        assertQuerySlotIndex(this, index)
        const facts = slotFactsFor(this)
        return Object.freeze({
            index,
            state: facts.states[index] as QuerySetSlotState,
            contentEpoch: facts.contentEpochs[index] as number,
        })
    }

    slots(): readonly QuerySetSlotSnapshot[] {

        return Object.freeze(Array.from({ length: this.count }, (_, index) => this.slot(index)))
    }

    dispose(): void {

        if (this.isDisposed) return

        if (this.gpuQuerySet && typeof this.gpuQuerySet.destroy === 'function') {
            this.gpuQuerySet.destroy()
        }

        super.dispose()
    }

}

function assertQuerySlotIndex(querySet: QuerySetResource, index: number): void {

    if (Number.isInteger(index) && index >= 0 && index < querySet.count) return

    throwScratchDiagnostic({
        code: 'SCRATCH_QUERY_SLOT_INDEX_INVALID',
        severity: 'error',
        phase: 'resource',
        subject: querySet.subject,
        message: 'QuerySetResource slot access requires an in-range integer index.',
        expected: { index: `integer in [0, ${querySet.count})` },
        actual: { index },
    })
}

function normalizeQuerySetDescriptor(runtime: ScratchRuntime, descriptor: unknown): QuerySetResourceDescriptor {

    const subject = runtime?.subject ?? { kind: 'ScratchRuntime' }

    if (runtime?.device && typeof runtime.device.createQuerySet !== 'function') {
        throwScratchDiagnostic({
            code: 'SCRATCH_RUNTIME_DEVICE_UNAVAILABLE',
            severity: 'error',
            phase: 'runtime',
            subject,
            message: 'ScratchRuntime device cannot create GPU query sets.',
            expected: { device: 'GPUDevice with createQuerySet()' },
            actual: { createQuerySet: typeof runtime.device.createQuerySet },
        })
    }

    if (!isRecord(descriptor)) {
        throwQuerySetDescriptorDiagnostic(subject, descriptor, 'descriptor')
    }

    if (!isQuerySetType(descriptor.type)) {
        throwQuerySetDescriptorDiagnostic(subject, descriptor, 'type')
    }

    if (typeof descriptor.count !== 'number' || !Number.isInteger(descriptor.count) || descriptor.count <= 0) {
        throwQuerySetDescriptorDiagnostic(subject, descriptor, 'count')
    }

    if (descriptor.type === 'timestamp' && !runtime?.deviceFeatures?.has?.('timestamp-query')) {
        throwScratchDiagnostic({
            code: 'SCRATCH_RUNTIME_FEATURE_UNAVAILABLE',
            severity: 'error',
            phase: 'runtime',
            subject,
            message: 'Timestamp query sets require the timestamp-query feature.',
            expected: { feature: 'timestamp-query' },
            actual: { features: Array.from(runtime?.deviceFeatures ?? []) },
        })
    }

    const normalized: QuerySetResourceDescriptor = {
        type: descriptor.type,
        count: descriptor.count,
    }

    if (typeof descriptor.label === 'string') normalized.label = descriptor.label

    return normalized
}

function throwQuerySetDescriptorDiagnostic(subject: DiagnosticSubject, descriptor: unknown, reason: string): never {

    const descriptorRecord = isRecord(descriptor) ? descriptor : {}

    throwScratchDiagnostic({
        code: 'SCRATCH_RESOURCE_DESCRIPTOR_INVALID',
        severity: 'error',
        phase: 'resource',
        subject,
        message: 'QuerySetResource requires a timestamp or occlusion descriptor with a positive slot count.',
        expected: {
            type: [ 'timestamp', 'occlusion' ],
            count: 'positive integer',
        },
        actual: {
            reason,
            type: descriptorRecord.type,
            count: descriptorRecord.count,
        },
    })
}

function isQuerySetType(type: unknown): type is QuerySetType {

    return QUERY_SET_TYPES.has(type as QuerySetType)
}
