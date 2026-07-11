import { throwScratchDiagnostic } from './diagnostics.js'
import { isLayoutArtifact, layoutArtifactSubject } from './layout-codec.js'
import {
    createScratchNativeLabel,
    destroyNativeCandidate,
    issueScopedNativeAllocation,
    recheckScopedNativeAllocationLifecycle,
    throwScopedAllocationFailure,
} from './native-allocation.js'
import { createScratchResourceIdentity, Resource } from './resource.js'
import { diagnosticsControllerFor } from './runtime-diagnostics.js'
import { describeValue, isRecord } from './type-utils.js'
import type { DiagnosticSubject } from './diagnostics.js'
import type { LayoutArtifact } from './layout-codec.js'
import type { ScratchResourceIdentity } from './resource.js'
import type { ScratchRuntime } from './runtime.js'

export type BufferResourceDescriptor = GPUBufferDescriptor & {
    layout?: LayoutArtifact
    elementCount?: number
}

type NormalizedBufferResourceDescriptor = BufferResourceDescriptor & {
    layoutByteLength?: number
}

const bufferResourceToken = Symbol('BufferResource')
const BUFFER_ALLOCATION_CODES = Object.freeze({
    validation: 'SCRATCH_BUFFER_ALLOCATION_VALIDATION_FAILED',
    outOfMemory: 'SCRATCH_BUFFER_ALLOCATION_OUT_OF_MEMORY',
    nativeException: 'SCRATCH_BUFFER_ALLOCATION_NATIVE_FAILED',
})

export class BufferResource extends Resource {

    #gpuBuffer: GPUBuffer
    readonly size: number
    readonly usage: GPUBufferUsageFlags
    readonly layout?: LayoutArtifact
    readonly elementCount?: number
    readonly layoutByteLength?: number

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

        super(runtime, {
            resourceKind: 'BufferResource',
            descriptor,
            identity,
            ...(descriptor.label !== undefined ? { label: descriptor.label } : {}),
        })

        this.size = descriptor.size
        this.usage = descriptor.usage
        if (descriptor.layout !== undefined) this.layout = descriptor.layout
        if (descriptor.elementCount !== undefined) this.elementCount = descriptor.elementCount
        if (descriptor.layoutByteLength !== undefined) this.layoutByteLength = descriptor.layoutByteLength
        this.#gpuBuffer = gpuBuffer
        Object.preventExtensions(this)
    }

    get gpuBuffer(): GPUBuffer {

        return this.#gpuBuffer
    }

    dispose(): void {

        if (this.isDisposed) return

        if (this.gpuBuffer && typeof this.gpuBuffer.destroy === 'function') {
            this.gpuBuffer.destroy()
        }

        super.dispose()
    }

    get layoutSubject(): DiagnosticSubject | undefined {

        if (this.layout === undefined) return undefined
        return layoutArtifactSubject(this.layout)
    }
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

    if (typeof descriptor.size !== 'number' || !Number.isFinite(descriptor.size) || descriptor.size < 0) {
        throwScratchDiagnostic({
            code: 'SCRATCH_RESOURCE_DESCRIPTOR_INVALID',
            severity: 'error',
            phase: 'resource',
            subject,
            message: 'BufferResource size must be a finite non-negative number.',
            expected: { size: 'finite non-negative number' },
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

    if (typeof descriptor.usage !== 'number' || !Number.isFinite(descriptor.usage)) {
        throwScratchDiagnostic({
            code: 'SCRATCH_RESOURCE_DESCRIPTOR_INVALID',
            severity: 'error',
            phase: 'resource',
            subject,
            message: 'BufferResource usage must be GPUBufferUsageFlags.',
            expected: { usage: 'GPUBufferUsageFlags' },
            actual: { usage: descriptor.usage },
        })
    }

    const layout = normalizeBufferLayout(runtime, descriptor.layout)
    const elementCount = normalizeBufferElementCount(runtime, layout, descriptor.elementCount)
    const layoutByteLength = layout === undefined || elementCount === undefined
        ? undefined
        : layout.stride * elementCount

    if (layout !== undefined && layoutByteLength !== undefined && (!Number.isSafeInteger(layoutByteLength) || layoutByteLength > descriptor.size)) {
        throwScratchDiagnostic({
            code: 'SCRATCH_CODEC_BYTE_LENGTH_MISMATCH',
            severity: 'error',
            phase: 'layout-codec',
            subject: layoutArtifactSubject(layout),
            related: [ subject ],
            message: 'BufferResource layout byte length exceeds the GPU buffer size.',
            expected: { layoutByteLength },
            actual: { bufferSize: descriptor.size },
        })
    }

    const normalized: NormalizedBufferResourceDescriptor = {
        size: descriptor.size,
        usage: descriptor.usage,
    }

    if (typeof descriptor.label === 'string') normalized.label = descriptor.label
    if (typeof descriptor.mappedAtCreation === 'boolean') normalized.mappedAtCreation = descriptor.mappedAtCreation
    if (layout !== undefined) normalized.layout = layout
    if (elementCount !== undefined) normalized.elementCount = elementCount
    if (layoutByteLength !== undefined) normalized.layoutByteLength = layoutByteLength

    return normalized
}

function normalizeBufferLayout(runtime: ScratchRuntime, layout: unknown): LayoutArtifact | undefined {

    if (layout === undefined) return undefined
    if (isLayoutArtifact(layout)) return layout

    throwScratchDiagnostic({
        code: 'SCRATCH_LAYOUT_UNSUPPORTED_FORMAT',
        severity: 'error',
        phase: 'layout-codec',
        subject: runtime?.subject ?? { kind: 'ScratchRuntime' },
        message: 'BufferResource layout must be a LayoutArtifact.',
        expected: { layout: 'LayoutArtifact' },
        actual: { layout: describeValue(layout) },
    })
}

function normalizeBufferElementCount(
    runtime: ScratchRuntime,
    layout: LayoutArtifact | undefined,
    elementCount: unknown
): number | undefined {

    if (layout === undefined) {
        if (elementCount === undefined) return undefined

        throwScratchDiagnostic({
            code: 'SCRATCH_LAYOUT_UNSUPPORTED_FORMAT',
            severity: 'error',
            phase: 'layout-codec',
            subject: runtime?.subject ?? { kind: 'ScratchRuntime' },
            message: 'BufferResource elementCount requires a LayoutArtifact.',
            expected: { layout: 'LayoutArtifact' },
            actual: { elementCount },
        })
    }

    const normalized = elementCount ?? 1
    if (typeof normalized !== 'number' || !Number.isInteger(normalized) || normalized <= 0) {
        throwScratchDiagnostic({
            code: 'SCRATCH_LAYOUT_UNSUPPORTED_FORMAT',
            severity: 'error',
            phase: 'layout-codec',
            subject: layoutArtifactSubject(layout),
            related: [ runtime?.subject ?? { kind: 'ScratchRuntime' } ],
            message: 'BufferResource elementCount must be a positive integer.',
            expected: { elementCount: 'positive integer' },
            actual: { elementCount: normalized },
        })
    }

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
