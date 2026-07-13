import { throwScratchDiagnostic } from './diagnostics.js'
import { createScratchNativeLabel } from './native-allocation.js'
import {
    createScratchResourceIdentity,
    registerResource,
    Resource,
} from './resource.js'
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

const ADDRESS_MODES = new Set<GPUAddressMode>([ 'clamp-to-edge', 'repeat', 'mirror-repeat' ])
const FILTER_MODES = new Set<GPUFilterMode | GPUMipmapFilterMode>([ 'nearest', 'linear' ])
const COMPARE_FUNCTIONS = new Set<GPUCompareFunction>([
    'never',
    'less',
    'equal',
    'less-equal',
    'greater',
    'not-equal',
    'greater-equal',
    'always',
])
const samplerResourceToken = Symbol('SamplerResource')
const SAMPLER_ALLOCATION_CODES = Object.freeze({
    validation: 'SCRATCH_SAMPLER_ALLOCATION_VALIDATION_FAILED',
    internal: 'SCRATCH_SAMPLER_ALLOCATION_INTERNAL_FAILED',
    outOfMemory: 'SCRATCH_SAMPLER_ALLOCATION_OUT_OF_MEMORY',
    nativeException: 'SCRATCH_SAMPLER_ALLOCATION_NATIVE_FAILED',
})

export type SamplerResourceDescriptor = GPUSamplerDescriptor

type NormalizedSamplerResourceDescriptor = Readonly<{
    label?: string
    addressModeU: GPUAddressMode
    addressModeV: GPUAddressMode
    addressModeW: GPUAddressMode
    magFilter: GPUFilterMode
    minFilter: GPUFilterMode
    mipmapFilter: GPUMipmapFilterMode
    lodMinClamp: number
    lodMaxClamp: number
    compare?: GPUCompareFunction
    maxAnisotropy: number
}>

export class SamplerResource extends Resource {

    readonly gpuSampler: GPUSampler

    private constructor(
        token: symbol,
        runtime: ScratchRuntime,
        descriptor: NormalizedSamplerResourceDescriptor,
        identity: ScratchResourceIdentity,
        gpuSampler: GPUSampler
    ) {

        if (token !== samplerResourceToken || new.target !== SamplerResource) {
            throw new TypeError('SamplerResource must be created by ScratchRuntime.createSampler().')
        }

        super(runtime, {
            resourceKind: 'SamplerResource',
            descriptor,
            identity,
            ...(descriptor.label !== undefined ? { label: descriptor.label } : {}),
        })

        this.gpuSampler = gpuSampler
        registerResource(this)
        Object.preventExtensions(this)
    }
}

export async function createSamplerResource(
    runtime: ScratchRuntime,
    descriptor: SamplerResourceDescriptor = {}
): Promise<SamplerResource> {

    runtime.assertActive()
    const normalizedDescriptor = normalizeSamplerDescriptor(runtime, descriptor)
    const identity = createScratchResourceIdentity()
    const nativeLabel = createScratchNativeLabel(normalizedDescriptor.label, identity.id)
    const nativeDescriptor = Object.freeze({
        ...normalizedDescriptor,
        label: nativeLabel,
    }) satisfies GPUSamplerDescriptor
    const controller = diagnosticsControllerFor(runtime)
    const operation = controller.beginOperation({
        kind: 'sampler-allocation',
        target: {
            kind: 'resource',
            resourceId: identity.id,
            resourceKind: 'SamplerResource',
            allocationVersion: 1,
        },
        descriptorSummary: {
            addressModeU: normalizedDescriptor.addressModeU,
            addressModeV: normalizedDescriptor.addressModeV,
            addressModeW: normalizedDescriptor.addressModeW,
            magFilter: normalizedDescriptor.magFilter,
            minFilter: normalizedDescriptor.minFilter,
            mipmapFilter: normalizedDescriptor.mipmapFilter,
            lodMinClamp: normalizedDescriptor.lodMinClamp,
            lodMaxClamp: normalizedDescriptor.lodMaxClamp,
            maxAnisotropy: normalizedDescriptor.maxAnisotropy,
            ...(normalizedDescriptor.compare !== undefined
                ? { compare: normalizedDescriptor.compare }
                : {}),
        },
        fullDescriptor: { ...normalizedDescriptor },
        nativeLabel,
    })
    const outcome = recheckSupportingObjectLifecycle(
        runtime,
        await issueSupportingObjectCreation(
            runtime,
            () => runtime.device.createSampler(nativeDescriptor)
        )
    )

    if (outcome.failures.length > 0 || outcome.candidate === undefined) {
        return throwSupportingObjectCreationFailure(
            runtime,
            operation,
            outcome,
            SAMPLER_ALLOCATION_CODES,
            {
                operationName: 'Sampler allocation',
                phase: 'resource',
                subject: {
                    kind: 'Resource',
                    id: identity.id,
                    resourceKind: 'SamplerResource',
                    ...(normalizedDescriptor.label !== undefined
                        ? { label: normalizedDescriptor.label }
                        : {}),
                },
            }
        )
    }

    let sampler: SamplerResource
    try {
        sampler = constructSamplerResource(
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
            SAMPLER_ALLOCATION_CODES,
            {
                operationName: 'Sampler allocation',
                phase: 'resource',
                subject: { kind: 'Resource', id: identity.id, resourceKind: 'SamplerResource' },
            }
        )
    }

    controller.completeOperation(operation, { status: 'succeeded' })
    return sampler
}

function constructSamplerResource(
    runtime: ScratchRuntime,
    descriptor: NormalizedSamplerResourceDescriptor,
    identity: ScratchResourceIdentity,
    gpuSampler: GPUSampler
): SamplerResource {

    const Constructor = SamplerResource as unknown as new (
        token: symbol,
        runtime: ScratchRuntime,
        descriptor: NormalizedSamplerResourceDescriptor,
        identity: ScratchResourceIdentity,
        gpuSampler: GPUSampler
    ) => SamplerResource
    return new Constructor(samplerResourceToken, runtime, descriptor, identity, gpuSampler)
}

function normalizeSamplerDescriptor(
    runtime: ScratchRuntime,
    descriptor: unknown
): NormalizedSamplerResourceDescriptor {

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
        throwSamplerDescriptorDiagnostic(subject, descriptor, { descriptor: 'object' })
    }
    if (descriptor.label !== undefined && typeof descriptor.label !== 'string') {
        throwSamplerDescriptorDiagnostic(subject, descriptor, { label: 'string' })
    }

    const addressModeU = normalizeEnum(
        subject,
        descriptor.addressModeU ?? 'clamp-to-edge',
        ADDRESS_MODES,
        'addressModeU'
    )
    const addressModeV = normalizeEnum(
        subject,
        descriptor.addressModeV ?? 'clamp-to-edge',
        ADDRESS_MODES,
        'addressModeV'
    )
    const addressModeW = normalizeEnum(
        subject,
        descriptor.addressModeW ?? 'clamp-to-edge',
        ADDRESS_MODES,
        'addressModeW'
    )
    const magFilter = normalizeEnum(
        subject,
        descriptor.magFilter ?? 'nearest',
        FILTER_MODES,
        'magFilter'
    ) as GPUFilterMode
    const minFilter = normalizeEnum(
        subject,
        descriptor.minFilter ?? 'nearest',
        FILTER_MODES,
        'minFilter'
    ) as GPUFilterMode
    const mipmapFilter = normalizeEnum(
        subject,
        descriptor.mipmapFilter ?? 'nearest',
        FILTER_MODES,
        'mipmapFilter'
    ) as GPUMipmapFilterMode
    const lodMinClamp = normalizeFiniteNumber(
        subject,
        descriptor.lodMinClamp ?? 0,
        'lodMinClamp'
    )
    const lodMaxClamp = normalizeFiniteNumber(
        subject,
        descriptor.lodMaxClamp ?? 32,
        'lodMaxClamp'
    )
    const maxAnisotropy = normalizeMaxAnisotropy(
        subject,
        descriptor.maxAnisotropy ?? 1
    )
    const compare = descriptor.compare === undefined
        ? undefined
        : normalizeEnum(subject, descriptor.compare, COMPARE_FUNCTIONS, 'compare')

    if (lodMinClamp < 0 || lodMaxClamp < lodMinClamp) {
        throwSamplerDescriptorDiagnostic(subject, descriptor, {
            lodMinClamp: 'finite number >= 0',
            lodMaxClamp: 'finite number >= lodMinClamp',
        })
    }
    if (
        maxAnisotropy > 1 &&
        (magFilter !== 'linear' || minFilter !== 'linear' || mipmapFilter !== 'linear')
    ) {
        throwSamplerDescriptorDiagnostic(subject, descriptor, {
            anisotropicFilters: {
                magFilter: 'linear',
                minFilter: 'linear',
                mipmapFilter: 'linear',
            },
        })
    }

    return Object.freeze({
        ...(descriptor.label !== undefined ? { label: descriptor.label } : {}),
        addressModeU,
        addressModeV,
        addressModeW,
        magFilter,
        minFilter,
        mipmapFilter,
        lodMinClamp,
        lodMaxClamp,
        ...(compare !== undefined ? { compare } : {}),
        maxAnisotropy,
    })
}

function normalizeFiniteNumber(
    subject: DiagnosticSubject,
    value: unknown,
    key: string
): number {

    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throwSamplerDescriptorDiagnostic(subject, { [key]: value }, { [key]: 'finite number' })
    }
    return value
}

function normalizeMaxAnisotropy(subject: DiagnosticSubject, value: unknown): number {

    if (!Number.isInteger(value) || typeof value !== 'number' || value < 1 || value > 0xffff) {
        throwSamplerDescriptorDiagnostic(subject, { maxAnisotropy: value }, {
            maxAnisotropy: 'integer in [1, 65535]',
        })
    }
    return value
}

function normalizeEnum<T extends string>(
    subject: DiagnosticSubject,
    value: unknown,
    allowed: ReadonlySet<T>,
    key: string
): T {

    if (typeof value !== 'string' || !allowed.has(value as T)) {
        throwSamplerDescriptorDiagnostic(subject, { [key]: value }, { [key]: [ ...allowed ] })
    }
    return value as T
}

function throwSamplerDescriptorDiagnostic(
    subject: DiagnosticSubject,
    actual: unknown,
    expected: unknown
): never {

    throwScratchDiagnostic({
        code: 'SCRATCH_RESOURCE_DESCRIPTOR_INVALID',
        severity: 'error',
        phase: 'resource',
        subject,
        message: 'SamplerResource requires a complete valid WebGPU sampler descriptor.',
        expected,
        actual,
    })
}
