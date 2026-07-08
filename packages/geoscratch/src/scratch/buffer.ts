import { throwScratchDiagnostic } from './diagnostics.js'
import { isLayoutArtifact, layoutArtifactSubject } from './layout-codec.js'
import { Resource } from './resource.js'
import { describeValue, isRecord } from './type-utils.js'
import type { DiagnosticSubject } from './diagnostics.js'
import type { LayoutArtifact } from './layout-codec.js'
import type { ScratchRuntime } from './runtime.js'

export type BufferResourceDescriptor = GPUBufferDescriptor & {
    layout?: LayoutArtifact
    elementCount?: number
}

type NormalizedBufferResourceDescriptor = BufferResourceDescriptor & {
    layoutByteLength?: number
}

export interface BufferResource {
    gpuBuffer: GPUBuffer
    size: number
    usage: GPUBufferUsageFlags
    layout?: LayoutArtifact
    elementCount?: number
    layoutByteLength?: number
}

export class BufferResource extends Resource {

    constructor(runtime: ScratchRuntime, descriptor: BufferResourceDescriptor) {

        const normalizedDescriptor = normalizeBufferDescriptor(runtime, descriptor)

        super(runtime, {
            resourceKind: 'BufferResource',
            descriptor: normalizedDescriptor,
            ...(normalizedDescriptor.label !== undefined ? { label: normalizedDescriptor.label } : {}),
        })

        this.size = normalizedDescriptor.size
        this.usage = normalizedDescriptor.usage
        if (normalizedDescriptor.layout !== undefined) this.layout = normalizedDescriptor.layout
        if (normalizedDescriptor.elementCount !== undefined) this.elementCount = normalizedDescriptor.elementCount
        if (normalizedDescriptor.layoutByteLength !== undefined) this.layoutByteLength = normalizedDescriptor.layoutByteLength
        this.gpuBuffer = runtime.device.createBuffer(createGpuBufferDescriptor(normalizedDescriptor))
    }

    static create(runtime: ScratchRuntime, descriptor: BufferResourceDescriptor): BufferResource {

        return new BufferResource(runtime, descriptor)
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

function createGpuBufferDescriptor(descriptor: NormalizedBufferResourceDescriptor): GPUBufferDescriptor {

    const gpuDescriptor: GPUBufferDescriptor = {
        size: descriptor.size,
        usage: descriptor.usage,
    }

    if (descriptor.label !== undefined) gpuDescriptor.label = descriptor.label
    if (descriptor.mappedAtCreation !== undefined) gpuDescriptor.mappedAtCreation = descriptor.mappedAtCreation

    return gpuDescriptor
}
