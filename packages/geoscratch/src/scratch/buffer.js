import { throwScratchDiagnostic } from './diagnostics.js'
import { Resource } from './resource.js'

export class BufferResource extends Resource {

    constructor(runtime, descriptor = {}) {

        const normalizedDescriptor = normalizeBufferDescriptor(runtime, descriptor)

        super(runtime, {
            label: normalizedDescriptor.label,
            resourceKind: 'BufferResource',
            descriptor: normalizedDescriptor,
        })

        this.size = normalizedDescriptor.size
        this.usage = normalizedDescriptor.usage
        this.gpuBuffer = runtime.device.createBuffer(normalizedDescriptor)
    }

    static create(runtime, descriptor = {}) {

        return new BufferResource(runtime, descriptor)
    }

    dispose() {

        if (this.isDisposed) return

        if (this.gpuBuffer && typeof this.gpuBuffer.destroy === 'function') {
            this.gpuBuffer.destroy()
        }

        super.dispose()
    }
}

function normalizeBufferDescriptor(runtime, descriptor) {

    const subject = runtime?.subject ?? { kind: 'ScratchRuntime' }

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

    if (!descriptor || typeof descriptor !== 'object') {
        throwScratchDiagnostic({
            code: 'SCRATCH_RESOURCE_DESCRIPTOR_INVALID',
            severity: 'error',
            phase: 'resource',
            subject,
            message: 'BufferResource requires a descriptor object.',
            expected: { descriptor: 'object with size and usage' },
            actual: { descriptor: descriptor === null ? 'null' : typeof descriptor },
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

    const normalized = {
        size: descriptor.size,
        usage: descriptor.usage,
    }

    if (descriptor.label !== undefined) normalized.label = descriptor.label
    if (descriptor.mappedAtCreation !== undefined) normalized.mappedAtCreation = descriptor.mappedAtCreation

    return normalized
}
