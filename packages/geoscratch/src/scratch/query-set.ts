import { Resource } from './resource.js'
import { throwScratchDiagnostic } from './diagnostics.js'
import { isRecord } from './type-utils.js'
import type { DiagnosticSubject } from './diagnostics.js'
import type { ScratchRuntime } from './runtime.js'

export type QuerySetType = 'timestamp' | 'occlusion'
export type QuerySetSlotState = 'empty' | 'ready' | 'indeterminate'

export function setQuerySlotContentState(
    querySet: QuerySetResource,
    index: number,
    state: QuerySetSlotState,
    contentEpoch: number
): void {

    querySet.slotStates[index] = state
    querySet.slotContentEpochs[index] = contentEpoch
}

const QUERY_SET_TYPES = new Set<QuerySetType>([ 'timestamp', 'occlusion' ])

export type QuerySetResourceDescriptor = {
    label?: string
    type: QuerySetType
    count: number
}

export interface QuerySetResource {
    type: QuerySetType
    count: number
    slotStates: QuerySetSlotState[]
    slotContentEpochs: number[]
    gpuQuerySet: GPUQuerySet
}

export class QuerySetResource extends Resource {

    constructor(runtime: ScratchRuntime, descriptor: QuerySetResourceDescriptor) {

        const normalizedDescriptor = normalizeQuerySetDescriptor(runtime, descriptor)

        super(runtime, {
            resourceKind: 'QuerySetResource',
            descriptor: normalizedDescriptor,
            ...(normalizedDescriptor.label !== undefined ? { label: normalizedDescriptor.label } : {}),
        })

        this.type = normalizedDescriptor.type
        this.count = normalizedDescriptor.count
        this.slotStates = Array.from({ length: this.count }, () => 'empty')
        this.slotContentEpochs = Array.from({ length: this.count }, () => 0)
        this.gpuQuerySet = runtime.device.createQuerySet(normalizedDescriptor)
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

    dispose(): void {

        if (this.isDisposed) return

        if (this.gpuQuerySet && typeof this.gpuQuerySet.destroy === 'function') {
            this.gpuQuerySet.destroy()
        }

        super.dispose()
    }

    _advanceSlotContentEpoch(index: number): void {

        this.slotContentEpochs[index] = (this.slotContentEpochs[index] ?? 0) + 1
        this.slotStates[index] = 'ready'
    }
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
