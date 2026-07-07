import { throwScratchDiagnostic } from './diagnostics.js'
import { Resource } from './resource.js'
import { isRecord } from './type-utils.js'
import type { DiagnosticSubject } from './diagnostics.js'
import type { ScratchRuntime } from './runtime.js'

const TEXTURE_DIMENSIONS = new Set<GPUTextureDimension>([ '2d' ])

export type TextureResourceDescriptor = Omit<GPUTextureDescriptor, 'size'> & {
    size: GPUTextureDescriptor['size'] | [number, number] | [number, number, number]
}

export type TextureViewDescriptor = GPUTextureViewDescriptor

export interface TextureResource {
    gpuTexture: GPUTexture
    size: { width: number, height: number, depthOrArrayLayers: number }
    width: number
    height: number
    depthOrArrayLayers: number
    format: GPUTextureFormat
    usage: GPUTextureUsageFlags
    dimension: GPUTextureDimension
    mipLevelCount: number
    sampleCount: number
    _viewCache: Map<string, GPUTextureView>
}

type NormalizedTextureDescriptor = GPUTextureDescriptor & {
    size: { width: number, height: number, depthOrArrayLayers: number }
    format: GPUTextureFormat
    usage: GPUTextureUsageFlags
    dimension: GPUTextureDimension
    mipLevelCount: number
    sampleCount: number
}

export class TextureResource extends Resource {

    constructor(runtime: ScratchRuntime, descriptor: TextureResourceDescriptor) {

        const normalizedDescriptor = normalizeTextureDescriptor(runtime, descriptor)

        super(runtime, {
            resourceKind: 'TextureResource',
            descriptor: normalizedDescriptor,
            ...(normalizedDescriptor.label !== undefined ? { label: normalizedDescriptor.label } : {}),
        })

        this.size = normalizedDescriptor.size
        this.width = normalizedDescriptor.size.width
        this.height = normalizedDescriptor.size.height
        this.depthOrArrayLayers = normalizedDescriptor.size.depthOrArrayLayers
        this.format = normalizedDescriptor.format
        this.usage = normalizedDescriptor.usage
        this.dimension = normalizedDescriptor.dimension
        this.mipLevelCount = normalizedDescriptor.mipLevelCount
        this.sampleCount = normalizedDescriptor.sampleCount
        this.gpuTexture = runtime.device.createTexture(normalizedDescriptor)
        this._viewCache = new Map()
    }

    static create(runtime: ScratchRuntime, descriptor: TextureResourceDescriptor): TextureResource {

        return new TextureResource(runtime, descriptor)
    }

    createView(descriptor: TextureViewDescriptor = {}): GPUTextureView {

        this.assertUsable()

        const normalizedDescriptor = normalizeTextureViewDescriptor(this, descriptor)
        const key = JSON.stringify(normalizedDescriptor)
        if (!this._viewCache.has(key)) {
            this._viewCache.set(key, this.gpuTexture.createView(normalizedDescriptor))
        }

        return this._viewCache.get(key)!
    }

    _replaceAllocation(descriptor: object): void {

        super._replaceAllocation(descriptor)
        this._viewCache.clear()
    }

    dispose(): void {

        if (this.isDisposed) return

        if (this.gpuTexture && typeof this.gpuTexture.destroy === 'function') {
            this.gpuTexture.destroy()
        }

        this._viewCache.clear()
        super.dispose()
    }
}

function normalizeTextureDescriptor(runtime: ScratchRuntime, descriptor: unknown): NormalizedTextureDescriptor {

    const subject = runtime?.subject ?? { kind: 'ScratchRuntime' }

    if (runtime?.device && typeof runtime.device.createTexture !== 'function') {
        throwScratchDiagnostic({
            code: 'SCRATCH_RUNTIME_DEVICE_UNAVAILABLE',
            severity: 'error',
            phase: 'runtime',
            subject,
            message: 'ScratchRuntime device cannot create GPU textures.',
            expected: { device: 'GPUDevice with createTexture()' },
            actual: { createTexture: typeof runtime.device.createTexture },
        })
    }

    if (!isRecord(descriptor)) {
        throwTextureDescriptorDiagnostic(subject, descriptor, {
            descriptor: 'object with size, format, and usage',
        })
    }

    const size = normalizeTextureSize(subject, descriptor.size)
    const format = normalizeTextureFormat(subject, descriptor.format)
    const usage = normalizeTextureUsage(subject, descriptor.usage)
    const dimension = normalizeTextureDimension(subject, descriptor, descriptor.dimension ?? '2d')
    if (!TEXTURE_DIMENSIONS.has(dimension)) {
        throwTextureDescriptorDiagnostic(subject, descriptor, {
            dimension: [ ...TEXTURE_DIMENSIONS ],
        })
    }

    const mipLevelCount = normalizePositiveInteger(subject, descriptor.mipLevelCount ?? 1, 'mipLevelCount')
    const sampleCount = normalizePositiveInteger(subject, descriptor.sampleCount ?? 1, 'sampleCount')

    const normalized: NormalizedTextureDescriptor = {
        size,
        format,
        usage,
        dimension,
        mipLevelCount,
        sampleCount,
    }

    if (typeof descriptor.label === 'string') normalized.label = descriptor.label

    return normalized
}

function normalizeTextureSize(subject: DiagnosticSubject, size: unknown): { width: number, height: number, depthOrArrayLayers: number } {

    let width: unknown
    let height: unknown
    let depthOrArrayLayers: unknown

    if (Array.isArray(size)) {
        width = size[0]
        height = size[1] ?? 1
        depthOrArrayLayers = size[2] ?? 1
    } else if (isRecord(size)) {
        width = size.width
        height = size.height ?? 1
        depthOrArrayLayers = size.depthOrArrayLayers ?? 1
    } else {
        throwTextureDescriptorDiagnostic(subject, { size }, {
            size: '{ width, height, depthOrArrayLayers? }',
        })
    }

    for (const [ key, value ] of Object.entries({ width, height, depthOrArrayLayers })) {
        if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
            throwTextureDescriptorDiagnostic(subject, { size }, {
                [key]: 'positive integer',
            })
        }
    }

    return {
        width: width as number,
        height: height as number,
        depthOrArrayLayers: depthOrArrayLayers as number,
    }
}

function normalizeTextureFormat(subject: DiagnosticSubject, format: unknown): GPUTextureFormat {

    if (typeof format !== 'string' || format.length === 0) {
        throwTextureDescriptorDiagnostic(subject, { format }, {
            format: 'GPUTextureFormat string',
        })
    }

    return format as GPUTextureFormat
}

function normalizeTextureUsage(subject: DiagnosticSubject, usage: unknown): GPUTextureUsageFlags {

    if (usage === undefined) {
        throwScratchDiagnostic({
            code: 'SCRATCH_RESOURCE_USAGE_MISSING',
            severity: 'error',
            phase: 'resource',
            subject,
            message: 'TextureResource usage is required.',
            expected: { usage: 'GPUTextureUsageFlags' },
            actual: { usage },
        })
    }

    if (typeof usage !== 'number' || !Number.isFinite(usage)) {
        throwTextureDescriptorDiagnostic(subject, { usage }, {
            usage: 'GPUTextureUsageFlags',
        })
    }

    return usage
}

function normalizePositiveInteger(subject: DiagnosticSubject, value: unknown, key: string): number {

    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
        throwTextureDescriptorDiagnostic(subject, { [key]: value }, {
            [key]: 'positive integer',
        })
    }

    return value
}

function normalizeTextureViewDescriptor(texture: TextureResource, descriptor: unknown): GPUTextureViewDescriptor {

    if (!isRecord(descriptor)) {
        throwTextureDescriptorDiagnostic(texture.subject, descriptor, {
            viewDescriptor: 'object',
        })
    }

    return sortObjectKeys(descriptor) as GPUTextureViewDescriptor
}

function sortObjectKeys(value: unknown): unknown {

    if (Array.isArray(value)) return value.map(sortObjectKeys)
    if (!isRecord(value)) return value

    return Object.keys(value).sort().reduce<Record<string, unknown>>((result, key) => {
        result[key] = sortObjectKeys(value[key])
        return result
    }, {})
}

function normalizeTextureDimension(subject: DiagnosticSubject, descriptor: unknown, dimension: unknown): GPUTextureDimension {

    if (typeof dimension !== 'string' || !TEXTURE_DIMENSIONS.has(dimension as GPUTextureDimension)) {
        throwTextureDescriptorDiagnostic(subject, descriptor, {
            dimension: [ ...TEXTURE_DIMENSIONS ],
        })
    }

    return dimension as GPUTextureDimension
}

function throwTextureDescriptorDiagnostic(subject: DiagnosticSubject, actual: unknown, expected: unknown): never {

    throwScratchDiagnostic({
        code: 'SCRATCH_RESOURCE_DESCRIPTOR_INVALID',
        severity: 'error',
        phase: 'resource',
        subject,
        message: 'TextureResource requires a valid sampled 2D texture descriptor.',
        expected,
        actual,
    })
}
