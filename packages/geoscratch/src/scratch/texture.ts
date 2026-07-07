import { throwScratchDiagnostic } from './diagnostics.js'
import { Resource } from './resource.js'
import type { DiagnosticSubject } from './diagnostics.js'
import type { ScratchRuntime } from './runtime.js'

const TEXTURE_DIMENSIONS = new Set([ '2d' ])

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
            label: normalizedDescriptor.label,
            resourceKind: 'TextureResource',
            descriptor: normalizedDescriptor,
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

function normalizeTextureDescriptor(runtime: ScratchRuntime, descriptor: any): NormalizedTextureDescriptor {

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

    if (!descriptor || typeof descriptor !== 'object') {
        throwTextureDescriptorDiagnostic(subject, descriptor, {
            descriptor: 'object with size, format, and usage',
        })
    }

    const size = normalizeTextureSize(subject, descriptor.size)
    const format = normalizeTextureFormat(subject, descriptor.format)
    const usage = normalizeTextureUsage(subject, descriptor.usage)
    const dimension = (descriptor.dimension ?? '2d') as GPUTextureDimension
    if (!TEXTURE_DIMENSIONS.has(dimension)) {
        throwTextureDescriptorDiagnostic(subject, descriptor, {
            dimension: [ ...TEXTURE_DIMENSIONS ],
        })
    }

    const mipLevelCount = normalizePositiveInteger(subject, descriptor.mipLevelCount ?? 1, 'mipLevelCount')
    const sampleCount = normalizePositiveInteger(subject, descriptor.sampleCount ?? 1, 'sampleCount')

    const normalized: any = {
        size,
        format,
        usage,
        dimension,
        mipLevelCount,
        sampleCount,
    }

    if (descriptor.label !== undefined) normalized.label = descriptor.label

    return normalized
}

function normalizeTextureSize(subject: DiagnosticSubject, size: any): { width: number, height: number, depthOrArrayLayers: number } {

    let width
    let height
    let depthOrArrayLayers

    if (Array.isArray(size)) {
        width = size[0]
        height = size[1] ?? 1
        depthOrArrayLayers = size[2] ?? 1
    } else if (size && typeof size === 'object') {
        width = size.width
        height = size.height ?? 1
        depthOrArrayLayers = size.depthOrArrayLayers ?? 1
    } else {
        throwTextureDescriptorDiagnostic(subject, { size }, {
            size: '{ width, height, depthOrArrayLayers? }',
        })
    }

    for (const [ key, value ] of Object.entries({ width, height, depthOrArrayLayers })) {
        if (!Number.isInteger(value) || value <= 0) {
            throwTextureDescriptorDiagnostic(subject, { size }, {
                [key]: 'positive integer',
            })
        }
    }

    return { width, height, depthOrArrayLayers }
}

function normalizeTextureFormat(subject: DiagnosticSubject, format: any): GPUTextureFormat {

    if (typeof format !== 'string' || format.length === 0) {
        throwTextureDescriptorDiagnostic(subject, { format }, {
            format: 'GPUTextureFormat string',
        })
    }

    return format as GPUTextureFormat
}

function normalizeTextureUsage(subject: DiagnosticSubject, usage: any): GPUTextureUsageFlags {

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

function normalizePositiveInteger(subject: DiagnosticSubject, value: any, key: string): number {

    if (!Number.isInteger(value) || value <= 0) {
        throwTextureDescriptorDiagnostic(subject, { [key]: value }, {
            [key]: 'positive integer',
        })
    }

    return value
}

function normalizeTextureViewDescriptor(texture: TextureResource, descriptor: any): GPUTextureViewDescriptor {

    if (!descriptor || typeof descriptor !== 'object') {
        throwTextureDescriptorDiagnostic(texture.subject, descriptor, {
            viewDescriptor: 'object',
        })
    }

    return sortObjectKeys(descriptor)
}

function sortObjectKeys(value: any): any {

    if (Array.isArray(value)) return value.map(sortObjectKeys)
    if (!value || typeof value !== 'object') return value

    return Object.keys(value).sort().reduce((result: any, key) => {
        result[key] = sortObjectKeys(value[key])
        return result
    }, {})
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
