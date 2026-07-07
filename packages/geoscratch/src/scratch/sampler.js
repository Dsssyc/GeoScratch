import { throwScratchDiagnostic } from './diagnostics.js'
import { Resource } from './resource.js'

const ADDRESS_MODES = new Set([ 'clamp-to-edge', 'repeat', 'mirror-repeat' ])
const FILTER_MODES = new Set([ 'nearest', 'linear' ])

export class SamplerResource extends Resource {

    constructor(runtime, descriptor = {}) {

        const normalizedDescriptor = normalizeSamplerDescriptor(runtime, descriptor)

        super(runtime, {
            label: normalizedDescriptor.label,
            resourceKind: 'SamplerResource',
            descriptor: normalizedDescriptor,
        })

        this.gpuSampler = runtime.device.createSampler(normalizedDescriptor)
    }

    static create(runtime, descriptor = {}) {

        return new SamplerResource(runtime, descriptor)
    }
}

function normalizeSamplerDescriptor(runtime, descriptor) {

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

    const normalized = {
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

function normalizeEnum(subject, value, allowed, key) {

    if (!allowed.has(value)) {
        throwSamplerDescriptorDiagnostic(subject, { [key]: value }, {
            [key]: [ ...allowed ],
        })
    }

    return value
}

function throwSamplerDescriptorDiagnostic(subject, actual, expected) {

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
