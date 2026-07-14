import { throwScratchDiagnostic } from './diagnostics.js'
import {
    describeLayoutCompatibilityDifference,
    isLayoutArtifact,
    layoutArtifactSubject,
    layoutArtifactsAbiCompatible,
} from './layout-codec.js'
import {
    createScratchNativeLabel,
    destroyNativeCandidate,
    issueScopedNativeAllocation,
    recheckScopedNativeAllocationLifecycle,
    throwScopedAllocationFailure,
} from './native-allocation.js'
import {
    contentBearingResourceOptions,
    createScratchResourceIdentity,
    registerResource,
    Resource,
    resourceContentEpoch,
    resourceContentState,
} from './resource.js'
import { diagnosticsControllerFor } from './runtime-diagnostics.js'
import { describeValue, isRecord } from './type-utils.js'
import type { DiagnosticSubject } from './diagnostics.js'
import type { LayoutArtifact } from './layout-codec.js'
import type { ResourceState, ScratchResourceIdentity } from './resource.js'
import type { ScratchRuntime } from './runtime.js'

export type BufferResourceDescriptor = GPUBufferDescriptor

export type BufferRegionDescriptor = Readonly<{
    offset?: number
    size?: number
    layout?: LayoutArtifact
}>

export type BufferSubregionDescriptor = Readonly<{
    offset?: number
    size?: number
    layout?: LayoutArtifact
}>

type NormalizedBufferResourceDescriptor = BufferResourceDescriptor

const bufferResourceToken = Symbol('BufferResource')
const bufferRegionToken = Symbol('BufferRegion')
const bufferRegions = new WeakSet<BufferRegion>()
const GPU_FLAGS_MAX = 0xffff_ffff
const REMOVED_BUFFER_RESOURCE_DESCRIPTOR_FIELDS = Object.freeze([
    'layout',
    'elementCount',
    'layoutByteLength',
])
const BUFFER_ALLOCATION_CODES = Object.freeze({
    validation: 'SCRATCH_BUFFER_ALLOCATION_VALIDATION_FAILED',
    outOfMemory: 'SCRATCH_BUFFER_ALLOCATION_OUT_OF_MEMORY',
    nativeException: 'SCRATCH_BUFFER_ALLOCATION_NATIVE_FAILED',
})

export class BufferResource extends Resource {

    #gpuBuffer: GPUBuffer
    readonly size: number
    readonly usage: GPUBufferUsageFlags

    private constructor(
        token: symbol,
        runtime: ScratchRuntime,
        descriptor: NormalizedBufferResourceDescriptor,
        identity: ScratchResourceIdentity,
        gpuBuffer: GPUBuffer
    ) {

        if (token !== bufferResourceToken || new.target !== BufferResource) {
            throw new TypeError('BufferResource must be created by ScratchRuntime.createBuffer().')
        }

        super(runtime, contentBearingResourceOptions({
            resourceKind: 'BufferResource',
            descriptor,
            identity,
            ...(descriptor.label !== undefined ? { label: descriptor.label } : {}),
        }))

        this.size = descriptor.size
        this.usage = descriptor.usage
        this.#gpuBuffer = gpuBuffer
        registerResource(this)
        Object.preventExtensions(this)
    }

    get gpuBuffer(): GPUBuffer {

        return this.#gpuBuffer
    }

    get state(): ResourceState {

        return resourceContentState(this)
    }

    get contentEpoch(): number {

        return resourceContentEpoch(this)
    }

    get isReady(): boolean {

        return this.state === 'ready'
    }

    region(descriptor: BufferRegionDescriptor = {}): BufferRegion {

        this.assertUsable()
        return constructBufferRegion(this, normalizeBufferRegionDescriptor(this, descriptor))
    }

    dispose(): void {

        if (this.isDisposed) return

        if (this.gpuBuffer && typeof this.gpuBuffer.destroy === 'function') {
            this.gpuBuffer.destroy()
        }

        super.dispose()
    }

}

export class BufferRegion {

    readonly buffer: BufferResource
    readonly offset: number
    readonly size: number
    readonly layout?: LayoutArtifact

    private constructor(
        token: symbol,
        buffer: BufferResource,
        descriptor: Readonly<{ offset: number, size: number, layout?: LayoutArtifact }>
    ) {

        if (token !== bufferRegionToken || new.target !== BufferRegion) {
            throw new TypeError('BufferRegion must be created by BufferResource.region().')
        }

        this.buffer = buffer
        this.offset = descriptor.offset
        this.size = descriptor.size
        if (descriptor.layout !== undefined) this.layout = descriptor.layout
        bufferRegions.add(this)
        Object.freeze(this)
    }

    get elementCount(): number | undefined {

        if (this.layout === undefined || this.size % this.layout.stride !== 0) return undefined
        return this.size / this.layout.stride
    }

    get subject(): DiagnosticSubject {

        return bufferRegionSubject(this)
    }

    assertUsable(): void {

        this.buffer.assertUsable()
        validateBufferRegionRange(this.buffer, this.offset, this.size)
        if (this.layout !== undefined) {
            validateBufferRegionLayout(this.buffer, this.offset, this.size, this.layout)
        }
    }

    subregion(descriptor: BufferSubregionDescriptor = {}): BufferRegion {

        this.assertUsable()
        if (!isRecord(descriptor)) {
            return throwBufferRegionRangeDiagnostic(this.buffer, descriptor, {
                descriptor: 'object with optional offset, size, and layout',
            })
        }

        const relativeOffset = descriptor.offset ?? 0
        const size = descriptor.size ?? this.size - relativeOffset
        validateSafeRangeValues(this.buffer, relativeOffset, size, {
            offset: descriptor.offset,
            size: descriptor.size,
            relativeTo: { offset: this.offset, size: this.size },
        })
        const relativeEnd = relativeOffset + size
        if (relativeEnd > this.size) {
            return throwBufferRegionRangeDiagnostic(this.buffer, descriptor, {
                range: `within parent region size ${this.size}`,
            })
        }

        const absoluteOffset = this.offset + relativeOffset
        if (!Number.isSafeInteger(absoluteOffset)) {
            return throwBufferRegionRangeDiagnostic(this.buffer, descriptor, {
                absoluteOffset: 'safe integer',
            })
        }

        return this.buffer.region({
            offset: absoluteOffset,
            size,
            ...(descriptor.layout !== undefined ? { layout: descriptor.layout } : {}),
        })
    }

    interpretAs(layout: LayoutArtifact): BufferRegion {

        this.assertUsable()
        if (!isLayoutArtifact(layout)) {
            throwScratchDiagnostic({
                code: 'SCRATCH_LAYOUT_UNSUPPORTED_FORMAT',
                severity: 'error',
                phase: 'layout-codec',
                subject: this.subject,
                related: [ this.buffer.subject ],
                message: 'BufferRegion interpretation requires a LayoutArtifact.',
                expected: { layout: 'LayoutArtifact' },
                actual: { layout: describeValue(layout) },
            })
        }

        if (this.layout !== undefined && !layoutArtifactsAbiCompatible(this.layout, layout)) {
            throwScratchDiagnostic({
                code: 'SCRATCH_LAYOUT_ABI_MISMATCH',
                severity: 'error',
                phase: 'layout-codec',
                subject: this.subject,
                related: [
                    this.buffer.subject,
                    layoutArtifactSubject(this.layout),
                    layoutArtifactSubject(layout),
                ],
                message: 'BufferRegion cannot be reinterpreted with a physically incompatible layout.',
                expected: {
                    abiHash: this.layout.abiHash,
                    schemaHash: this.layout.schemaHash,
                },
                actual: {
                    abiHash: layout.abiHash,
                    schemaHash: layout.schemaHash,
                },
                evidence: [ {
                    kind: 'layout-abi-difference',
                    value: describeLayoutCompatibilityDifference(this.layout, layout, 'abi'),
                } ],
                hints: [ 'Create another explicit region from the parent buffer for a different physical interpretation.' ],
            })
        }

        return this.buffer.region({ offset: this.offset, size: this.size, layout })
    }
}

Object.freeze(BufferRegion.prototype)

export function isBufferRegion(value: unknown): value is BufferRegion {

    return typeof value === 'object' && value !== null && bufferRegions.has(value as BufferRegion)
}

export function bufferRegionSubject(region: BufferRegion): DiagnosticSubject {

    const subject: DiagnosticSubject = {
        kind: 'BufferRegion',
        resourceId: region.buffer.id,
        offset: region.offset,
        size: region.size,
    }
    if (region.layout !== undefined) {
        subject.abiHash = region.layout.abiHash
        subject.schemaHash = region.layout.schemaHash
    }
    return subject
}

function constructBufferRegion(
    buffer: BufferResource,
    descriptor: Readonly<{ offset: number, size: number, layout?: LayoutArtifact }>
): BufferRegion {

    const Constructor = BufferRegion as unknown as new (
        token: symbol,
        buffer: BufferResource,
        descriptor: Readonly<{ offset: number, size: number, layout?: LayoutArtifact }>
    ) => BufferRegion
    return new Constructor(bufferRegionToken, buffer, descriptor)
}

function normalizeBufferRegionDescriptor(
    buffer: BufferResource,
    descriptor: unknown
): Readonly<{ offset: number, size: number, layout?: LayoutArtifact }> {

    if (!isRecord(descriptor)) {
        return throwBufferRegionRangeDiagnostic(buffer, descriptor, {
            descriptor: 'object with optional offset, size, and layout',
        })
    }

    const offsetValue = descriptor.offset ?? 0
    const sizeValue = descriptor.size ?? (
        typeof offsetValue === 'number' ? buffer.size - offsetValue : Number.NaN
    )
    validateSafeRangeValues(buffer, offsetValue, sizeValue, descriptor)
    const offset = offsetValue as number
    const size = sizeValue as number
    validateBufferRegionRange(buffer, offset, size)

    const layout = descriptor.layout
    if (layout !== undefined) {
        if (!isLayoutArtifact(layout)) {
            throwScratchDiagnostic({
                code: 'SCRATCH_LAYOUT_UNSUPPORTED_FORMAT',
                severity: 'error',
                phase: 'layout-codec',
                subject: buffer.subject,
                message: 'BufferRegion layout must be a LayoutArtifact.',
                expected: { layout: 'LayoutArtifact' },
                actual: { layout: describeValue(layout) },
            })
        }
        validateBufferRegionLayout(buffer, offset, size, layout)
    }

    return Object.freeze({
        offset,
        size,
        ...(layout !== undefined ? { layout } : {}),
    })
}

function validateSafeRangeValues(
    buffer: BufferResource,
    offset: unknown,
    size: unknown,
    actual: unknown
): void {

    if (
        typeof offset !== 'number' ||
        typeof size !== 'number' ||
        !Number.isSafeInteger(offset) ||
        !Number.isSafeInteger(size) ||
        offset < 0 ||
        size < 0 ||
        !Number.isSafeInteger(offset + size)
    ) {
        throwBufferRegionRangeDiagnostic(buffer, actual, {
            offset: 'non-negative safe integer',
            size: 'non-negative safe integer',
            end: 'safe integer without overflow',
        })
    }
}

function validateBufferRegionRange(buffer: BufferResource, offset: number, size: number): void {

    if (offset + size > buffer.size) {
        throwBufferRegionRangeDiagnostic(buffer, { offset, size, bufferSize: buffer.size }, {
            range: `within BufferResource size ${buffer.size}`,
        })
    }
}

function validateBufferRegionLayout(
    buffer: BufferResource,
    offset: number,
    size: number,
    layout: LayoutArtifact
): void {

    if (offset % layout.alignment !== 0 || size % layout.stride !== 0) {
        throwScratchDiagnostic({
            code: 'SCRATCH_BUFFER_REGION_LAYOUT_INVALID',
            severity: 'error',
            phase: 'layout-codec',
            subject: {
                kind: 'BufferRegion',
                resourceId: buffer.id,
                offset,
                size,
                abiHash: layout.abiHash,
                schemaHash: layout.schemaHash,
            },
            related: [ buffer.subject, layoutArtifactSubject(layout) ],
            message: 'BufferRegion range is incompatible with its LayoutArtifact.',
            expected: {
                offsetAlignment: layout.alignment,
                sizeStride: layout.stride,
            },
            actual: { offset, size },
        })
    }
}

function throwBufferRegionRangeDiagnostic(
    buffer: BufferResource,
    actual: unknown,
    expected: unknown
): never {

    throwScratchDiagnostic({
        code: 'SCRATCH_BUFFER_REGION_RANGE_INVALID',
        severity: 'error',
        phase: 'resource',
        subject: buffer.subject,
        message: 'BufferRegion requires a safe byte range within its parent BufferResource.',
        expected,
        actual,
    })
}

export async function createBufferResource(
    runtime: ScratchRuntime,
    descriptor: BufferResourceDescriptor
): Promise<BufferResource> {

    runtime.assertActive()
    const normalizedDescriptor = normalizeBufferDescriptor(runtime, descriptor)
    const identity = createScratchResourceIdentity()
    const nativeLabel = createScratchNativeLabel(normalizedDescriptor.label, identity.id)
    const nativeDescriptor = createGpuBufferDescriptor(normalizedDescriptor, nativeLabel)
    const controller = diagnosticsControllerFor(runtime)
    const operation = controller.beginOperation({
        kind: 'buffer-allocation',
        target: {
            kind: 'resource',
            resourceId: identity.id,
            resourceKind: 'BufferResource',
            allocationVersion: 1,
            contentEpoch: 0,
            logicalFootprintBytes: normalizedDescriptor.size,
        },
        descriptorSummary: {
            size: normalizedDescriptor.size,
            usage: normalizedDescriptor.usage,
            ...(normalizedDescriptor.mappedAtCreation !== undefined
                ? { mappedAtCreation: normalizedDescriptor.mappedAtCreation }
                : {}),
        },
        fullDescriptor: { ...normalizedDescriptor },
        nativeLabel,
    })
    let outcome = await issueScopedNativeAllocation(
        runtime,
        () => runtime.device.createBuffer(nativeDescriptor)
    )
    outcome = recheckScopedNativeAllocationLifecycle(runtime, outcome)

    if (!outcome.ok) {
        return throwScopedAllocationFailure(
            runtime,
            operation,
            outcome,
            BUFFER_ALLOCATION_CODES,
            'Buffer allocation'
        )
    }

    let resource: BufferResource
    try {
        resource = constructBufferResource(runtime, normalizedDescriptor, identity, outcome.candidate)
    } catch (cause) {
        destroyNativeCandidate(outcome.candidate)
        return throwScopedAllocationFailure(
            runtime,
            operation,
            { ok: false, kind: 'native-exception', cause },
            BUFFER_ALLOCATION_CODES,
            'Buffer allocation'
        )
    }

    controller.completeOperation(operation, { status: 'succeeded' })
    return resource
}

function constructBufferResource(
    runtime: ScratchRuntime,
    descriptor: NormalizedBufferResourceDescriptor,
    identity: ScratchResourceIdentity,
    gpuBuffer: GPUBuffer
): BufferResource {

    const Constructor = BufferResource as unknown as new (
        token: symbol,
        runtime: ScratchRuntime,
        descriptor: NormalizedBufferResourceDescriptor,
        identity: ScratchResourceIdentity,
        gpuBuffer: GPUBuffer
    ) => BufferResource
    return new Constructor(bufferResourceToken, runtime, descriptor, identity, gpuBuffer)
}

function normalizeBufferDescriptor(runtime: ScratchRuntime, descriptor: unknown): NormalizedBufferResourceDescriptor {

    const subject: DiagnosticSubject = runtime?.subject ?? { kind: 'ScratchRuntime' }

    if (runtime?.device && typeof runtime.device.createBuffer !== 'function') {
        throwScratchDiagnostic({
            code: 'SCRATCH_RUNTIME_DEVICE_UNAVAILABLE',
            severity: 'error',
            phase: 'runtime',
            subject,
            message: 'ScratchRuntime device cannot create GPU buffers.',
            expected: { device: 'GPUDevice with createBuffer()' },
            actual: { createBuffer: typeof runtime.device.createBuffer },
        })
    }

    if (!isRecord(descriptor)) {
        throwScratchDiagnostic({
            code: 'SCRATCH_RESOURCE_DESCRIPTOR_INVALID',
            severity: 'error',
            phase: 'resource',
            subject,
            message: 'BufferResource requires a descriptor object.',
            expected: { descriptor: 'object with size and usage' },
            actual: { descriptor: describeValue(descriptor) },
        })
    }

    const removedFields = REMOVED_BUFFER_RESOURCE_DESCRIPTOR_FIELDS
        .filter(key => Object.prototype.hasOwnProperty.call(descriptor, key))
    if (removedFields.length > 0) {
        throwScratchDiagnostic({
            code: 'SCRATCH_RESOURCE_DESCRIPTOR_INVALID',
            severity: 'error',
            phase: 'resource',
            subject,
            message: 'BufferResource is a raw byte container and cannot own layout interpretation.',
            expected: {
                descriptor: 'GPUBufferDescriptor without resource-global layout fields',
                interpretation: 'BufferResource.region({ layout })',
            },
            actual: { removedFields },
            hints: [ 'Move layout interpretation onto an explicit BufferRegion.' ],
        })
    }

    if (
        typeof descriptor.size !== 'number' ||
        !Number.isSafeInteger(descriptor.size) ||
        descriptor.size < 0
    ) {
        throwScratchDiagnostic({
            code: 'SCRATCH_RESOURCE_DESCRIPTOR_INVALID',
            severity: 'error',
            phase: 'resource',
            subject,
            message: 'BufferResource size must be an exact non-negative GPUSize64 value.',
            expected: { size: 'non-negative safe integer' },
            actual: { size: descriptor.size },
        })
    }

    if (descriptor.usage === undefined) {
        throwScratchDiagnostic({
            code: 'SCRATCH_RESOURCE_USAGE_MISSING',
            severity: 'error',
            phase: 'resource',
            subject,
            message: 'BufferResource usage is required.',
            expected: { usage: 'GPUBufferUsageFlags' },
            actual: { usage: descriptor.usage },
        })
    }

    if (
        typeof descriptor.usage !== 'number' ||
        !Number.isInteger(descriptor.usage) ||
        descriptor.usage < 0 ||
        descriptor.usage > GPU_FLAGS_MAX
    ) {
        throwScratchDiagnostic({
            code: 'SCRATCH_RESOURCE_DESCRIPTOR_INVALID',
            severity: 'error',
            phase: 'resource',
            subject,
            message: 'BufferResource usage must be GPUBufferUsageFlags.',
            expected: { usage: `GPUBufferUsageFlags integer in [0, ${GPU_FLAGS_MAX}]` },
            actual: { usage: descriptor.usage },
        })
    }

    if (descriptor.label !== undefined && typeof descriptor.label !== 'string') {
        throwScratchDiagnostic({
            code: 'SCRATCH_RESOURCE_DESCRIPTOR_INVALID',
            severity: 'error',
            phase: 'resource',
            subject,
            message: 'BufferResource label must be a string when provided.',
            expected: { label: 'string or undefined' },
            actual: { label: descriptor.label },
        })
    }
    if (
        descriptor.mappedAtCreation !== undefined &&
        typeof descriptor.mappedAtCreation !== 'boolean'
    ) {
        throwScratchDiagnostic({
            code: 'SCRATCH_RESOURCE_DESCRIPTOR_INVALID',
            severity: 'error',
            phase: 'resource',
            subject,
            message: 'BufferResource mappedAtCreation must be boolean when provided.',
            expected: { mappedAtCreation: 'boolean or undefined' },
            actual: { mappedAtCreation: descriptor.mappedAtCreation },
        })
    }

    const normalized: NormalizedBufferResourceDescriptor = {
        size: descriptor.size,
        usage: descriptor.usage,
    }

    if (descriptor.label !== undefined) normalized.label = descriptor.label
    if (descriptor.mappedAtCreation !== undefined) normalized.mappedAtCreation = descriptor.mappedAtCreation

    return normalized
}

function createGpuBufferDescriptor(
    descriptor: NormalizedBufferResourceDescriptor,
    nativeLabel = descriptor.label
): GPUBufferDescriptor {

    const gpuDescriptor: GPUBufferDescriptor = {
        size: descriptor.size,
        usage: descriptor.usage,
    }

    if (nativeLabel !== undefined) gpuDescriptor.label = nativeLabel
    if (descriptor.mappedAtCreation !== undefined) gpuDescriptor.mappedAtCreation = descriptor.mappedAtCreation

    return gpuDescriptor
}
