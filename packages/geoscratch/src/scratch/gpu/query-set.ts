import {
    createScratchResourceIdentity,
    registerResource,
    Resource,
} from './resource.js'
import { throwScratchDiagnostic } from './diagnostics.js'
import { createScratchNativeLabel } from './native-allocation.js'
import { assertScratchRuntimeActive } from './runtime-authority.js'
import { updateRuntimeResourceFact } from './runtime-diagnostics.js'
import { diagnosticsControllerFor } from './runtime-diagnostics.js'
import { throwSupportingObjectCreationFailure } from './supporting-object-failure.js'
import {
    issueSupportingObjectCreation,
    recheckSupportingObjectLifecycle,
} from './supporting-object-creation.js'
import { isRecord } from './type-utils.js'
import type { DiagnosticSubject } from './diagnostics.js'
import type { ScratchResourceIdentity } from './resource.js'
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
const querySetResources = new WeakSet<QuerySetResource>()

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
const MAX_QUERY_SET_COUNT = 4096
const querySetResourceToken = Symbol('QuerySetResource')
const QUERY_SET_ALLOCATION_CODES = Object.freeze({
    validation: 'SCRATCH_QUERY_SET_ALLOCATION_VALIDATION_FAILED',
    internal: 'SCRATCH_QUERY_SET_ALLOCATION_INTERNAL_FAILED',
    outOfMemory: 'SCRATCH_QUERY_SET_ALLOCATION_OUT_OF_MEMORY',
    nativeException: 'SCRATCH_QUERY_SET_ALLOCATION_NATIVE_FAILED',
})

export type QuerySetResourceDescriptor = {
    label?: string
    type: QuerySetType
    count: number
}

export class QuerySetResource extends Resource {

    readonly #type: QuerySetType
    readonly #count: number
    readonly #gpuQuerySet: GPUQuerySet

    private constructor(
        token: symbol,
        runtime: ScratchRuntime,
        descriptor: QuerySetResourceDescriptor,
        identity: ScratchResourceIdentity,
        gpuQuerySet: GPUQuerySet
    ) {

        if (token !== querySetResourceToken || new.target !== QuerySetResource) {
            throw new TypeError('QuerySetResource must be created by ScratchRuntime.createQuerySet().')
        }

        super(runtime, {
            resourceKind: 'QuerySetResource',
            descriptor,
            identity,
            ...(descriptor.label !== undefined ? { label: descriptor.label } : {}),
        })

        this.#type = descriptor.type
        this.#count = descriptor.count
        querySetSlotFacts.set(this, {
            states: Array.from({ length: this.#count }, () => 'empty'),
            contentEpochs: Array.from({ length: this.#count }, () => 0),
        })
        this.#gpuQuerySet = gpuQuerySet
        registerResource(this)
        querySetResources.add(this)
        Object.preventExtensions(this)
    }

    get type(): QuerySetType {

        return this.#type
    }

    get count(): number {

        return this.#count
    }

    get gpuQuerySet(): GPUQuerySet {

        return this.#gpuQuerySet
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

        if (this.#gpuQuerySet && typeof this.#gpuQuerySet.destroy === 'function') {
            this.#gpuQuerySet.destroy()
        }

        super.dispose()
    }

}

Object.freeze(QuerySetResource.prototype)

export function isQuerySetResource(value: unknown): value is QuerySetResource {

    return typeof value === 'object' && value !== null && querySetResources.has(value as QuerySetResource)
}

export async function createQuerySetResource(
    runtime: ScratchRuntime,
    descriptor: QuerySetResourceDescriptor
): Promise<QuerySetResource> {

    assertScratchRuntimeActive(runtime)
    const normalizedDescriptor = normalizeQuerySetDescriptor(runtime, descriptor)
    const identity = createScratchResourceIdentity()
    const nativeLabel = createScratchNativeLabel(normalizedDescriptor.label, identity.id)
    const nativeDescriptor = Object.freeze({
        ...normalizedDescriptor,
        label: nativeLabel,
    }) satisfies GPUQuerySetDescriptor
    const slots = Object.freeze(Array.from(
        { length: normalizedDescriptor.count },
        (_, index) => Object.freeze({ index, state: 'empty' as const, contentEpoch: 0 })
    ))
    const controller = diagnosticsControllerFor(runtime)
    const operation = controller.beginOperation({
        kind: 'query-set-allocation',
        target: {
            kind: 'resource',
            resourceId: identity.id,
            resourceKind: 'QuerySetResource',
            allocationVersion: 1,
            queryType: normalizedDescriptor.type,
            count: normalizedDescriptor.count,
            slots,
        },
        descriptorSummary: {
            type: normalizedDescriptor.type,
            count: normalizedDescriptor.count,
        },
        fullDescriptor: { ...normalizedDescriptor },
        nativeLabel,
    })
    const outcome = recheckSupportingObjectLifecycle(
        runtime,
        await issueSupportingObjectCreation(
            runtime,
            () => runtime.device.createQuerySet(nativeDescriptor)
        )
    )
    const subject: DiagnosticSubject = {
        kind: 'QuerySet',
        id: identity.id,
        queryType: normalizedDescriptor.type,
        ...(normalizedDescriptor.label !== undefined
            ? { label: normalizedDescriptor.label }
            : {}),
    }

    if (outcome.failures.length > 0 || outcome.candidate === undefined) {
        return throwSupportingObjectCreationFailure(
            runtime,
            operation,
            outcome,
            QUERY_SET_ALLOCATION_CODES,
            {
                operationName: 'Query-set allocation',
                phase: 'query',
                subject,
            }
        )
    }

    let querySet: QuerySetResource
    try {
        querySet = constructQuerySetResource(
            runtime,
            normalizedDescriptor,
            identity,
            outcome.candidate
        )
    } catch (cause) {
        return throwSupportingObjectCreationFailure(
            runtime,
            operation,
            {
                candidate: outcome.candidate,
                failures: [ { kind: 'native-exception', cause } ],
            },
            QUERY_SET_ALLOCATION_CODES,
            {
                operationName: 'Query-set allocation',
                phase: 'query',
                subject,
            }
        )
    }

    controller.completeOperation(operation, { status: 'succeeded' })
    return querySet
}

function constructQuerySetResource(
    runtime: ScratchRuntime,
    descriptor: QuerySetResourceDescriptor,
    identity: ScratchResourceIdentity,
    gpuQuerySet: GPUQuerySet
): QuerySetResource {

    const Constructor = QuerySetResource as unknown as new (
        token: symbol,
        runtime: ScratchRuntime,
        descriptor: QuerySetResourceDescriptor,
        identity: ScratchResourceIdentity,
        gpuQuerySet: GPUQuerySet
    ) => QuerySetResource
    return new Constructor(querySetResourceToken, runtime, descriptor, identity, gpuQuerySet)
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

    if (
        typeof descriptor.count !== 'number' ||
        !Number.isInteger(descriptor.count) ||
        descriptor.count <= 0 ||
        descriptor.count > MAX_QUERY_SET_COUNT
    ) {
        throwQuerySetDescriptorDiagnostic(subject, descriptor, 'count')
    }

    if (descriptor.label !== undefined && typeof descriptor.label !== 'string') {
        throwQuerySetDescriptorDiagnostic(subject, descriptor, 'label')
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

    return Object.freeze(normalized)
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
            count: `integer in [1, ${MAX_QUERY_SET_COUNT}]`,
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
