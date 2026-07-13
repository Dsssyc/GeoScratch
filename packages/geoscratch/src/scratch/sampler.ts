import { throwScratchDiagnostic } from './diagnostics.js'
import { registerResource, Resource } from './resource.js'
import { isRecord } from './type-utils.js'
import type { DiagnosticSubject } from './diagnostics.js'
import type { ScratchRuntime } from './runtime.js'

const ADDRESS_MODES = new Set<GPUAddressMode>([ 'clamp-to-edge', 'repeat', 'mirror-repeat' ])
const FILTER_MODES = new Set<GPUFilterMode | GPUMipmapFilterMode>([ 'nearest', 'linear' ])

export type SamplerResourceDescriptor = GPUSamplerDescriptor

export interface SamplerResource {
    gpuSampler: GPUSampler
}

export class SamplerResource extends Resource {

    constructor(runtime: ScratchRuntime, descriptor: SamplerResourceDescriptor = {}) {

        const normalizedDescriptor = normalizeSamplerDescriptor(runtime, descriptor)

        super(runtime, {
            resourceKind: 'SamplerResource',
            descriptor: normalizedDescriptor,
            ...(normalizedDescriptor.label !== undefined ? { label: normalizedDescriptor.label } : {}),
        })

        this.gpuSampler = runtime.device.createSampler(normalizedDescriptor)
        registerResource(this)
    }

    static create(runtime: ScratchRuntime, descriptor: SamplerResourceDescriptor = {}): SamplerResource {

        return new SamplerResource(runtime, descriptor)
    }
}

function normalizeSamplerDescriptor(runtime: ScratchRuntime, descriptor: unknown): GPUSamplerDescriptor {

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

    if (!isRecord(descriptor)) {
        throwSamplerDescriptorDiagnostic(subject, descriptor, {
            descriptor: 'object',
        })
    }

    const normalized: GPUSamplerDescriptor = {
        addressModeU: normalizeEnum(subject, descriptor.addressModeU ?? 'clamp-to-edge', ADDRESS_MODES, 'addressModeU'),
        addressModeV: normalizeEnum(subject, descriptor.addressModeV ?? 'clamp-to-edge', ADDRESS_MODES, 'addressModeV'),
        addressModeW: normalizeEnum(subject, descriptor.addressModeW ?? 'clamp-to-edge', ADDRESS_MODES, 'addressModeW'),
        magFilter: normalizeEnum(subject, descriptor.magFilter ?? 'nearest', FILTER_MODES, 'magFilter'),
        minFilter: normalizeEnum(subject, descriptor.minFilter ?? 'nearest', FILTER_MODES, 'minFilter'),
        mipmapFilter: normalizeEnum(subject, descriptor.mipmapFilter ?? 'nearest', FILTER_MODES, 'mipmapFilter'),
    }

    if (typeof descriptor.label === 'string') normalized.label = descriptor.label
    if (typeof descriptor.lodMinClamp === 'number') normalized.lodMinClamp = descriptor.lodMinClamp
    if (typeof descriptor.lodMaxClamp === 'number') normalized.lodMaxClamp = descriptor.lodMaxClamp
    if (descriptor.compare !== undefined) normalized.compare = descriptor.compare as GPUCompareFunction
    if (typeof descriptor.maxAnisotropy === 'number') normalized.maxAnisotropy = descriptor.maxAnisotropy

    return normalized
}

function normalizeEnum<T extends string>(subject: DiagnosticSubject, value: unknown, allowed: ReadonlySet<T>, key: string): T {

    if (typeof value !== 'string' || !allowed.has(value as T)) {
        throwSamplerDescriptorDiagnostic(subject, { [key]: value }, {
            [key]: [ ...allowed ],
        })
    }

    return value as T
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
