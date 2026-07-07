import { throwScratchDiagnostic } from './diagnostics.js'
import { Resource } from './resource.js'
import type { DiagnosticSubject } from './diagnostics.js'
import type { ScratchRuntime } from './runtime.js'

const ADDRESS_MODES = new Set([ 'clamp-to-edge', 'repeat', 'mirror-repeat' ])
const FILTER_MODES = new Set([ 'nearest', 'linear' ])

export type SamplerResourceDescriptor = GPUSamplerDescriptor

export interface SamplerResource {
    gpuSampler: GPUSampler
}

export class SamplerResource extends Resource {

    constructor(runtime: ScratchRuntime, descriptor: SamplerResourceDescriptor = {}) {

        const normalizedDescriptor = normalizeSamplerDescriptor(runtime, descriptor)

        super(runtime, {
            label: normalizedDescriptor.label,
            resourceKind: 'SamplerResource',
            descriptor: normalizedDescriptor,
        })

        this.gpuSampler = runtime.device.createSampler(normalizedDescriptor)
    }

    static create(runtime: ScratchRuntime, descriptor: SamplerResourceDescriptor = {}): SamplerResource {

        return new SamplerResource(runtime, descriptor)
    }
}

function normalizeSamplerDescriptor(runtime: ScratchRuntime, descriptor: any): GPUSamplerDescriptor {

    const subject = runtime?.subject ?? { kind: 'ScratchRuntime' }

    if (runtime?.device && typeof runtime.device.createSampler !== 'function') {
        throwScratchDiagnostic({
            code: 'SCRATCH_RUNTIME_DEVICE_UNAVAILABLE',
            severity: 'error',
            phase: 'runtime',
            subject,
            message: 'ScratchRuntime device cannot create GPU samplers.',
            expected: { device: 'GPUDevice with createSampler()' },
            actual: { createSampler: typeof runtime.device.createSampler },
        })
    }

    if (!descriptor || typeof descriptor !== 'object') {
        throwSamplerDescriptorDiagnostic(subject, descriptor, {
            descriptor: 'object',
        })
    }

    const normalized: any = {
        addressModeU: normalizeEnum(subject, descriptor.addressModeU ?? 'clamp-to-edge', ADDRESS_MODES, 'addressModeU'),
        addressModeV: normalizeEnum(subject, descriptor.addressModeV ?? 'clamp-to-edge', ADDRESS_MODES, 'addressModeV'),
        addressModeW: normalizeEnum(subject, descriptor.addressModeW ?? 'clamp-to-edge', ADDRESS_MODES, 'addressModeW'),
        magFilter: normalizeEnum(subject, descriptor.magFilter ?? 'nearest', FILTER_MODES, 'magFilter'),
        minFilter: normalizeEnum(subject, descriptor.minFilter ?? 'nearest', FILTER_MODES, 'minFilter'),
        mipmapFilter: normalizeEnum(subject, descriptor.mipmapFilter ?? 'nearest', FILTER_MODES, 'mipmapFilter'),
    }

    if (descriptor.label !== undefined) normalized.label = descriptor.label
    if (descriptor.lodMinClamp !== undefined) normalized.lodMinClamp = descriptor.lodMinClamp
    if (descriptor.lodMaxClamp !== undefined) normalized.lodMaxClamp = descriptor.lodMaxClamp
    if (descriptor.compare !== undefined) normalized.compare = descriptor.compare
    if (descriptor.maxAnisotropy !== undefined) normalized.maxAnisotropy = descriptor.maxAnisotropy

    return normalized
}

function normalizeEnum(subject: DiagnosticSubject, value: any, allowed: Set<string>, key: string): any {

    if (!allowed.has(value)) {
        throwSamplerDescriptorDiagnostic(subject, { [key]: value }, {
            [key]: [ ...allowed ],
        })
    }

    return value
}

function throwSamplerDescriptorDiagnostic(subject: DiagnosticSubject, actual: unknown, expected: unknown): never {

    throwScratchDiagnostic({
        code: 'SCRATCH_RESOURCE_DESCRIPTOR_INVALID',
        severity: 'error',
        phase: 'resource',
        subject,
        message: 'SamplerResource requires a valid sampler descriptor.',
        expected,
        actual,
    })
}
