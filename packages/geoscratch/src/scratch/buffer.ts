import { throwScratchDiagnostic } from './diagnostics.js'
import {
    assertBufferAvailableForGpuUse,
    disposeBufferMappingAuthority,
    initializeBufferMappingAuthority,
} from './buffer-mapping-authority.js'
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
    replaceResourceAllocation,
    Resource,
    resourceContentEpoch,
    resourceContentState,
} from './resource.js'
import { assertScratchRuntimeActive } from './runtime-authority.js'
import { diagnosticsControllerFor } from './runtime-diagnostics.js'
import { describeValue, isRecord } from './type-utils.js'
import type { DiagnosticSubject } from './diagnostics.js'
import type { LayoutArtifact } from './layout-codec.js'
import type { ResourceState, ScratchResourceIdentity } from './resource.js'
import type { ScratchRuntime } from './runtime.js'

export type BufferResourceDescriptor = Omit<GPUBufferDescriptor, 'mappedAtCreation'>

export type MappedBufferResourceDescriptor = BufferResourceDescriptor

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

type NormalizedBufferResourceDescriptor = Readonly<{
    label?: string
    size: number
    usage: GPUBufferUsageFlags
}>

type BufferAllocationInstaller = (
    descriptor: NormalizedBufferResourceDescriptor,
    gpuBuffer: GPUBuffer
) => void

const bufferResourceToken = Symbol('BufferResource')
const bufferRegionToken = Symbol('BufferRegion')
const bufferResources = new WeakSet<BufferResource>()
const bufferRegions = new WeakSet<BufferRegion>()
const bufferAllocationInstallers = new WeakMap<BufferResource, BufferAllocationInstaller>()
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
    #physicalDescriptor: NormalizedBufferResourceDescriptor
    readonly size!: number
    readonly usage!: GPUBufferUsageFlags

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

        this.#physicalDescriptor = descriptor
        this.#gpuBuffer = gpuBuffer
        Object.defineProperties(this, {
            size: {
                get: () => this.#physicalDescriptor.size,
                enumerable: true,
                configurable: false,
            },
            usage: {
                get: () => this.#physicalDescriptor.usage,
                enumerable: true,
                configurable: false,
            },
        })
        bufferAllocationInstallers.set(this, (nextDescriptor, nextGpuBuffer) => {
            const previousDescriptor = this.#physicalDescriptor
            const previousGpuBuffer = this.#gpuBuffer
            this.#physicalDescriptor = nextDescriptor
            this.#gpuBuffer = nextGpuBuffer
            try {
                replaceResourceAllocation(this, nextDescriptor)
            } catch (cause) {
                this.#physicalDescriptor = previousDescriptor
                this.#gpuBuffer = previousGpuBuffer
                destroyNativeCandidate(nextGpuBuffer)
                throw cause
            }
            destroyNativeCandidate(previousGpuBuffer)
        })
        registerResource(this)
        bufferResources.add(this)
        initializeBufferMappingAuthority(this)
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

        disposeBufferMappingAuthority(this)
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

export function isBufferResource(value: unknown): value is BufferResource {

    return typeof value === 'object' && value !== null && bufferResources.has(value as BufferResource)
}

export function isBufferRegion(value: unknown): value is BufferRegion {

    return typeof value === 'object' && value !== null && bufferRegions.has(value as BufferRegion)
}

export function commitBufferResourceAllocation(
    resource: BufferResource,
    descriptor: BufferResourceDescriptor,
    gpuBuffer: GPUBuffer
): void {

    if (!isBufferResource(resource)) {
        destroyNativeCandidate(gpuBuffer)
        throw new TypeError('Buffer allocation commit requires a BufferResource.')
    }
    if (gpuBuffer === undefined || gpuBuffer === null || typeof gpuBuffer !== 'object') {
        throw new TypeError('Buffer allocation commit requires a GPUBuffer candidate.')
    }
    try {
        resource.assertUsable()
    } catch (cause) {
        destroyNativeCandidate(gpuBuffer)
        throw cause
    }
    if (gpuBuffer === resource.gpuBuffer) {
        throw new TypeError('Buffer allocation commit requires a distinct GPUBuffer candidate.')
    }
    try {
        assertBufferAvailableForGpuUse(resource)
    } catch (cause) {
        destroyNativeCandidate(gpuBuffer)
        throw cause
    }

    let normalizedDescriptor: NormalizedBufferResourceDescriptor
    try {
        normalizedDescriptor = normalizeBufferDescriptor(resource.runtime, descriptor)
    } catch (cause) {
        destroyNativeCandidate(gpuBuffer)
        throw cause
    }
    if (normalizedDescriptor.label !== resource.label) {
        destroyNativeCandidate(gpuBuffer)
        throw new TypeError('Buffer replacement cannot change logical resource label identity.')
    }

    const install = bufferAllocationInstallers.get(resource)
    if (install === undefined) {
        destroyNativeCandidate(gpuBuffer)
        throw new TypeError('Buffer allocation commit is unavailable.')
    }
    install(normalizedDescriptor, gpuBuffer)
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

    return createBufferResourceAllocation(runtime, descriptor, false)
}

export async function createMappedBufferResourceAllocation(
    runtime: ScratchRuntime,
    descriptor: MappedBufferResourceDescriptor
): Promise<BufferResource> {

    return createBufferResourceAllocation(runtime, descriptor, true)
}

async function createBufferResourceAllocation(
    runtime: ScratchRuntime,
    descriptor: BufferResourceDescriptor,
    mappedAtCreation: boolean
): Promise<BufferResource> {

    assertScratchRuntimeActive(runtime)
    const normalizedDescriptor = normalizeBufferDescriptor(runtime, descriptor)
    if (mappedAtCreation && normalizedDescriptor.size % 4 !== 0) {
        throwScratchDiagnostic({
            code: 'SCRATCH_BUFFER_MAPPING_RANGE_INVALID',
            severity: 'error',
            phase: 'buffer-mapping',
            subject: runtime.subject,
            message: 'Mapped buffer creation requires a size that is a multiple of 4 bytes.',
            expected: { sizeMultiple: 4 },
            actual: { size: normalizedDescriptor.size },
        })
    }
    const identity = createScratchResourceIdentity()
    const nativeLabel = createScratchNativeLabel(normalizedDescriptor.label, identity.id)
    const nativeDescriptor = createGpuBufferDescriptor(
        normalizedDescriptor,
        nativeLabel,
        mappedAtCreation
    )
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
            ...(mappedAtCreation ? { mappedAtCreation: true } : {}),
        },
        fullDescriptor: {
            ...normalizedDescriptor,
            ...(mappedAtCreation ? { mappedAtCreation: true } : {}),
        },
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
    if (Object.prototype.hasOwnProperty.call(descriptor, 'mappedAtCreation')) {
        throwScratchDiagnostic({
            code: 'SCRATCH_BUFFER_MAPPING_USE_EXPLICIT_FACTORY',
            severity: 'error',
            phase: 'buffer-mapping',
            subject,
            message: 'Ordinary buffer descriptors cannot expose unmanaged mapped-at-creation state.',
            expected: {
                creation: 'ScratchRuntime.createMappedBuffer(descriptor)',
                descriptor: 'without mappedAtCreation',
            },
            actual: {
                mappedAtCreation: descriptor.mappedAtCreation,
            },
            hints: [ 'Use createMappedBuffer() and release its MappedBufferLease explicitly.' ],
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
    return Object.freeze({
        size: descriptor.size,
        usage: descriptor.usage,
        ...(descriptor.label !== undefined ? { label: descriptor.label } : {}),
    })
}

function createGpuBufferDescriptor(
    descriptor: NormalizedBufferResourceDescriptor,
    nativeLabel = descriptor.label,
    mappedAtCreation = false
): GPUBufferDescriptor {

    const gpuDescriptor: GPUBufferDescriptor = {
        size: descriptor.size,
        usage: descriptor.usage,
    }

    if (nativeLabel !== undefined) gpuDescriptor.label = nativeLabel
    if (mappedAtCreation) gpuDescriptor.mappedAtCreation = true

    return gpuDescriptor
}

Object.freeze(BufferResource.prototype)
