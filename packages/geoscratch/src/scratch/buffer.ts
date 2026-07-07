import { throwScratchDiagnostic } from './diagnostics.js'
import { Resource } from './resource.js'
import { describeValue, isRecord } from './type-utils.js'
import type { DiagnosticSubject } from './diagnostics.js'
import type { ScratchRuntime } from './runtime.js'

export type BufferResourceDescriptor = GPUBufferDescriptor

export interface BufferResource {
    gpuBuffer: GPUBuffer
    size: number
    usage: GPUBufferUsageFlags
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
        this.gpuBuffer = runtime.device.createBuffer(normalizedDescriptor)
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
}

function normalizeBufferDescriptor(runtime: ScratchRuntime, descriptor: unknown): BufferResourceDescriptor {

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

    const normalized: BufferResourceDescriptor = {
        size: descriptor.size,
        usage: descriptor.usage,
    }

    if (typeof descriptor.label === 'string') normalized.label = descriptor.label
    if (typeof descriptor.mappedAtCreation === 'boolean') normalized.mappedAtCreation = descriptor.mappedAtCreation

    return normalized
}
