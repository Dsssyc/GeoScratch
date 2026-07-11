import { throwScratchDiagnostic } from './diagnostics.js'
import { replaceResourceAllocation, Resource } from './resource.js'
import { getGlobalConstant, isRecord } from './type-utils.js'
import type { DiagnosticSubject } from './diagnostics.js'
import type { ScratchRuntime } from './runtime.js'

const GPU_TEXTURE_USAGE_STORAGE_BINDING = getGlobalConstant('GPUTextureUsage', 'STORAGE_BINDING', 0x8)
const GPU_TEXTURE_USAGE_RENDER_ATTACHMENT = getGlobalConstant('GPUTextureUsage', 'RENDER_ATTACHMENT', 0x10)
const GPU_TEXTURE_USAGE_TRANSIENT_ATTACHMENT = getGlobalConstant('GPUTextureUsage', 'TRANSIENT_ATTACHMENT', 0x20)
const TEXTURE_DIMENSIONS = new Set<GPUTextureDimension>([ '2d' ])
const TEXTURE_BINDING_VIEW_DIMENSIONS = new Set<GPUTextureViewDimension>([
    '1d',
    '2d',
    '2d-array',
    'cube',
    'cube-array',
    '3d',
])

export type TextureResourceSize =
    | Readonly<{
        width: number
        height?: number
        depthOrArrayLayers?: number
    }>
    | readonly [number, number?, number?]

// TypeScript 6's bundled WebGPU declarations currently lag the compatibility
// field and iterable form shipped by @webgpu/types, so spell out those current
// descriptor fields without widening the public contract.
export type TextureResourceDescriptor =
    Omit<GPUTextureDescriptor, 'size' | 'viewFormats' | 'textureBindingViewDimension'> & {
        size: TextureResourceSize
        viewFormats?: Iterable<GPUTextureFormat>
        textureBindingViewDimension?: GPUTextureViewDimension
    }

export type TextureViewDescriptor = GPUTextureViewDescriptor

type NormalizedTextureSize = Readonly<{
    width: number
    height: number
    depthOrArrayLayers: number
}>

type NormalizedTextureDescriptor = Readonly<{
    label?: string
    size: NormalizedTextureSize
    mipLevelCount: number
    sampleCount: number
    dimension: GPUTextureDimension
    format: GPUTextureFormat
    usage: GPUTextureUsageFlags
    viewFormats: GPUTextureFormat[]
    textureBindingViewDimension?: GPUTextureViewDimension
}>

export class TextureResource extends Resource {

    #gpuTexture: GPUTexture
    #physicalDescriptor: NormalizedTextureDescriptor
    #viewCache: Map<string, GPUTextureView>

    constructor(runtime: ScratchRuntime, descriptor: TextureResourceDescriptor) {

        const normalizedDescriptor = normalizeTextureDescriptor(runtime, descriptor)

        super(runtime, {
            resourceKind: 'TextureResource',
            descriptor: normalizedDescriptor,
            ...(normalizedDescriptor.label !== undefined ? { label: normalizedDescriptor.label } : {}),
        })

        this.#physicalDescriptor = normalizedDescriptor
        this.#gpuTexture = runtime.device.createTexture(normalizedDescriptor)
        this.#viewCache = new Map()
    }

    static create(runtime: ScratchRuntime, descriptor: TextureResourceDescriptor): TextureResource {

        return new TextureResource(runtime, descriptor)
    }

    get gpuTexture(): GPUTexture {

        return this.#gpuTexture
    }

    get size(): NormalizedTextureSize {

        return this.#physicalDescriptor.size
    }

    get width(): number {

        return this.size.width
    }

    get height(): number {

        return this.size.height
    }

    get depthOrArrayLayers(): number {

        return this.size.depthOrArrayLayers
    }

    get format(): GPUTextureFormat {

        return this.#physicalDescriptor.format
    }

    get usage(): GPUTextureUsageFlags {

        return this.#physicalDescriptor.usage
    }

    get dimension(): GPUTextureDimension {

        return this.#physicalDescriptor.dimension
    }

    get mipLevelCount(): number {

        return this.#physicalDescriptor.mipLevelCount
    }

    get sampleCount(): number {

        return this.#physicalDescriptor.sampleCount
    }

    resize(size: TextureResourceSize): void {

        this.assertUsable()

        const nextSize = normalizeTextureSize(this.subject, size)
        validateTextureAllocationDescriptor(this.runtime, this.#physicalDescriptor, nextSize, size)
        if (sameTextureSize(nextSize, this.size)) return

        assertTextureCreationAvailable(this.runtime)

        const nextDescriptor = freezeTextureDescriptor({
            ...this.#physicalDescriptor,
            size: nextSize,
        })

        let nextTexture: GPUTexture
        try {
            nextTexture = this.runtime.device.createTexture(nextDescriptor)
        } catch (cause) {
            throwScratchDiagnostic({
                code: 'SCRATCH_RESOURCE_ALLOCATION_REPLACEMENT_FAILED',
                severity: 'error',
                phase: 'resource',
                subject: this.subject,
                related: [ this.runtime.subject ],
                message: 'TextureResource replacement creation failed synchronously.',
                expected: {
                    createTexture: 'returns a replacement GPUTexture',
                    previousAllocation: 'remains installed on failure',
                },
                actual: {
                    size: nextSize,
                    nativeError: nativeErrorFacts(cause),
                },
                hints: [
                    'The old allocation remains usable; correct the synchronous native failure before retrying.',
                    'Asynchronous WebGPU validation and allocation errors are reported by the device error model.',
                ],
            }, { cause })
        }

        const previousTexture = this.#gpuTexture
        this.#gpuTexture = nextTexture
        this.#physicalDescriptor = nextDescriptor
        this.#viewCache.clear()
        replaceResourceAllocation(this, nextDescriptor)
        previousTexture.destroy()
    }

    createView(descriptor: TextureViewDescriptor = {}): GPUTextureView {

        this.assertUsable()

        const normalizedDescriptor = normalizeTextureViewDescriptor(this, descriptor)
        const key = JSON.stringify(normalizedDescriptor)
        if (!this.#viewCache.has(key)) {
            this.#viewCache.set(key, this.gpuTexture.createView(normalizedDescriptor))
        }

        return this.#viewCache.get(key)!
    }

    dispose(): void {

        if (this.isDisposed) return

        if (this.gpuTexture && typeof this.gpuTexture.destroy === 'function') {
            this.gpuTexture.destroy()
        }

        this.#viewCache.clear()
        super.dispose()
    }
}

function normalizeTextureDescriptor(runtime: ScratchRuntime, descriptor: unknown): NormalizedTextureDescriptor {

    const subject = runtime?.subject ?? { kind: 'ScratchRuntime' }

    assertTextureCreationAvailable(runtime)

    if (!isRecord(descriptor)) {
        throwTextureDescriptorDiagnostic(subject, descriptor, {
            descriptor: 'object with size, format, and usage',
        })
    }

    const size = normalizeTextureSize(subject, descriptor.size)
    const format = normalizeTextureFormat(subject, descriptor.format)
    const usage = normalizeTextureUsage(subject, descriptor.usage)
    const dimension = normalizeTextureDimension(subject, descriptor, descriptor.dimension ?? '2d')
    const mipLevelCount = normalizePositiveInteger(subject, descriptor.mipLevelCount ?? 1, 'mipLevelCount')
    const sampleCount = normalizeSampleCount(subject, descriptor.sampleCount ?? 1)
    const viewFormats = normalizeTextureViewFormats(subject, descriptor.viewFormats)
    const textureBindingViewDimension = normalizeTextureBindingViewDimension(
        subject,
        descriptor.textureBindingViewDimension
    )

    const normalized = freezeTextureDescriptor({
        size,
        format,
        usage,
        dimension,
        mipLevelCount,
        sampleCount,
        viewFormats,
        ...(typeof descriptor.label === 'string' ? { label: descriptor.label } : {}),
        ...(textureBindingViewDimension !== undefined ? { textureBindingViewDimension } : {}),
    })

    validateTextureAllocationDescriptor(runtime, normalized, size, descriptor)
    return normalized
}

function freezeTextureDescriptor(descriptor: NormalizedTextureDescriptor): NormalizedTextureDescriptor {

    return Object.freeze(descriptor)
}

function normalizeTextureSize(subject: DiagnosticSubject, size: unknown): NormalizedTextureSize {

    let width: unknown
    let height: unknown
    let depthOrArrayLayers: unknown

    if (Array.isArray(size)) {
        if (size.length < 1 || size.length > 3) {
            throwTextureDescriptorDiagnostic(subject, { size }, {
                size: 'readonly tuple [width, height?, depthOrArrayLayers?] with length 1 through 3',
            })
        }
        width = size[0]
        height = size[1] ?? 1
        depthOrArrayLayers = size[2] ?? 1
    } else if (isRecord(size)) {
        width = size.width
        height = size.height ?? 1
        depthOrArrayLayers = size.depthOrArrayLayers ?? 1
    } else {
        throwTextureDescriptorDiagnostic(subject, { size }, {
            size: '{ width, height?, depthOrArrayLayers? } or [width, height?, depthOrArrayLayers?]',
        })
    }

    for (const [ key, value ] of Object.entries({ width, height, depthOrArrayLayers })) {
        if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
            throwTextureDescriptorDiagnostic(subject, { size }, {
                [key]: 'positive integer',
            })
        }
    }

    return Object.freeze({
        width: width as number,
        height: height as number,
        depthOrArrayLayers: depthOrArrayLayers as number,
    })
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

function normalizeSampleCount(subject: DiagnosticSubject, value: unknown): number {

    const sampleCount = normalizePositiveInteger(subject, value, 'sampleCount')
    if (sampleCount !== 1 && sampleCount !== 4) {
        throwTextureDescriptorDiagnostic(subject, { sampleCount }, {
            sampleCount: [ 1, 4 ],
        })
    }

    return sampleCount
}

function normalizeTextureViewFormats(
    subject: DiagnosticSubject,
    value: unknown
): GPUTextureFormat[] {

    if (value === undefined) {
        const viewFormats: GPUTextureFormat[] = []
        Object.freeze(viewFormats)
        return viewFormats
    }
    if (
        typeof value === 'string' ||
        value === null ||
        (typeof value !== 'object' && typeof value !== 'function') ||
        !(Symbol.iterator in value) ||
        typeof value[Symbol.iterator] !== 'function'
    ) {
        throwTextureDescriptorDiagnostic(subject, { viewFormats: value }, {
            viewFormats: 'iterable of GPUTextureFormat strings',
        })
    }

    let viewFormats: unknown[]
    try {
        viewFormats = Array.from(value as Iterable<unknown>)
    } catch {
        throwTextureDescriptorDiagnostic(subject, { viewFormats: value }, {
            viewFormats: 'iterable of GPUTextureFormat strings',
        })
    }

    if (viewFormats.some(format => typeof format !== 'string' || format.length === 0)) {
        throwTextureDescriptorDiagnostic(subject, { viewFormats }, {
            viewFormats: 'iterable of GPUTextureFormat strings',
        })
    }

    const normalized = viewFormats as GPUTextureFormat[]
    Object.freeze(normalized)
    return normalized
}

function normalizeTextureBindingViewDimension(
    subject: DiagnosticSubject,
    value: unknown
): GPUTextureViewDimension | undefined {

    if (value === undefined) return undefined
    if (
        typeof value !== 'string' ||
        !TEXTURE_BINDING_VIEW_DIMENSIONS.has(value as GPUTextureViewDimension)
    ) {
        throwTextureDescriptorDiagnostic(subject, { textureBindingViewDimension: value }, {
            textureBindingViewDimension: [ ...TEXTURE_BINDING_VIEW_DIMENSIONS ],
        })
    }

    return value as GPUTextureViewDimension
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

function normalizeTextureDimension(
    subject: DiagnosticSubject,
    descriptor: unknown,
    dimension: unknown
): GPUTextureDimension {

    if (typeof dimension !== 'string' || !TEXTURE_DIMENSIONS.has(dimension as GPUTextureDimension)) {
        throwTextureDescriptorDiagnostic(subject, descriptor, {
            dimension: [ ...TEXTURE_DIMENSIONS ],
        })
    }

    return dimension as GPUTextureDimension
}

function validateTextureAllocationDescriptor(
    runtime: ScratchRuntime,
    descriptor: NormalizedTextureDescriptor,
    size: NormalizedTextureSize,
    actual: unknown
): void {

    const maxTextureDimension2D = runtime.deviceLimits?.maxTextureDimension2D
    const maxTextureArrayLayers = runtime.deviceLimits?.maxTextureArrayLayers

    if (
        (typeof maxTextureDimension2D === 'number' &&
            (size.width > maxTextureDimension2D || size.height > maxTextureDimension2D)) ||
        (typeof maxTextureArrayLayers === 'number' &&
            size.depthOrArrayLayers > maxTextureArrayLayers)
    ) {
        throwTextureDescriptorDiagnostic(runtime.subject, actual, {
            width: `positive integer <= ${String(maxTextureDimension2D)}`,
            height: `positive integer <= ${String(maxTextureDimension2D)}`,
            depthOrArrayLayers: `positive integer <= ${String(maxTextureArrayLayers)}`,
        })
    }

    const maxMipLevelCount = Math.floor(Math.log2(Math.max(size.width, size.height))) + 1
    if (descriptor.mipLevelCount > maxMipLevelCount) {
        throwTextureDescriptorDiagnostic(runtime.subject, actual, {
            mipLevelCount: `<= ${maxMipLevelCount} for the requested 2D extent`,
        })
    }

    if (
        descriptor.sampleCount > 1 &&
        (
            descriptor.dimension !== '2d' ||
            descriptor.mipLevelCount !== 1 ||
            size.depthOrArrayLayers !== 1 ||
            (descriptor.usage & GPU_TEXTURE_USAGE_STORAGE_BINDING) !== 0 ||
            (descriptor.usage & GPU_TEXTURE_USAGE_RENDER_ATTACHMENT) === 0
        )
    ) {
        throwTextureDescriptorDiagnostic(runtime.subject, actual, {
            multisampledTexture: {
                dimension: '2d',
                mipLevelCount: 1,
                depthOrArrayLayers: 1,
                usage: 'includes RENDER_ATTACHMENT and excludes STORAGE_BINDING',
            },
        })
    }

    if (
        (descriptor.usage & GPU_TEXTURE_USAGE_TRANSIENT_ATTACHMENT) !== 0 &&
        (
            descriptor.usage !==
                (GPU_TEXTURE_USAGE_TRANSIENT_ATTACHMENT | GPU_TEXTURE_USAGE_RENDER_ATTACHMENT) ||
            descriptor.viewFormats.length !== 0 ||
            descriptor.dimension !== '2d' ||
            descriptor.mipLevelCount !== 1 ||
            size.depthOrArrayLayers !== 1
        )
    ) {
        throwTextureDescriptorDiagnostic(runtime.subject, actual, {
            transientAttachment: {
                usage: 'exactly TRANSIENT_ATTACHMENT | RENDER_ATTACHMENT',
                viewFormats: 'empty',
                dimension: '2d',
                mipLevelCount: 1,
                depthOrArrayLayers: 1,
            },
        })
    }

    const blockSize = textureFormatBlockSize(descriptor.format)
    if (size.width % blockSize.width !== 0 || size.height % blockSize.height !== 0) {
        throwTextureDescriptorDiagnostic(runtime.subject, actual, {
            size: {
                width: `multiple of format block width ${blockSize.width}`,
                height: `multiple of format block height ${blockSize.height}`,
            },
        })
    }

    validateTextureBindingViewSize(runtime, descriptor.textureBindingViewDimension, size, actual)
}

function validateTextureBindingViewSize(
    runtime: ScratchRuntime,
    viewDimension: GPUTextureViewDimension | undefined,
    size: NormalizedTextureSize,
    actual: unknown
): void {

    if (viewDimension === undefined || runtime.deviceFeatures.has('core-features-and-limits')) return

    if (
        (viewDimension === '2d' && size.depthOrArrayLayers !== 1) ||
        (viewDimension === 'cube' && size.depthOrArrayLayers !== 6) ||
        viewDimension === 'cube-array'
    ) {
        throwTextureDescriptorDiagnostic(runtime.subject, actual, {
            textureBindingViewDimension: {
                '2d': 'exactly 1 array layer',
                cube: 'exactly 6 array layers',
                'cube-array': 'requires core-features-and-limits',
            },
        })
    }
}

function textureFormatBlockSize(format: GPUTextureFormat): { width: number, height: number } {

    if (/^(bc[1-7]|etc2|eac)-/.test(format)) {
        return { width: 4, height: 4 }
    }

    const astc = /^astc-(4|5|6|8|10|12)x(4|5|6|8|10|12)-/.exec(format)
    if (astc !== null) {
        return {
            width: Number(astc[1]),
            height: Number(astc[2]),
        }
    }

    return { width: 1, height: 1 }
}

function sameTextureSize(left: NormalizedTextureSize, right: NormalizedTextureSize): boolean {

    return left.width === right.width &&
        left.height === right.height &&
        left.depthOrArrayLayers === right.depthOrArrayLayers
}

function assertTextureCreationAvailable(runtime: ScratchRuntime): void {

    if (!runtime?.device || typeof runtime.device.createTexture !== 'function') {
        const subject = runtime?.subject ?? { kind: 'ScratchRuntime' }
        throwScratchDiagnostic({
            code: 'SCRATCH_RUNTIME_DEVICE_UNAVAILABLE',
            severity: 'error',
            phase: 'runtime',
            subject,
            message: 'ScratchRuntime device cannot create GPU textures.',
            expected: { device: 'GPUDevice with createTexture()' },
            actual: { createTexture: typeof runtime?.device?.createTexture },
        })
    }
}

function nativeErrorFacts(error: unknown): { name?: string, message: string } {

    if (error instanceof Error) {
        return {
            name: error.name,
            message: error.message,
        }
    }

    return { message: String(error) }
}

function throwTextureDescriptorDiagnostic(
    subject: DiagnosticSubject,
    actual: unknown,
    expected: unknown
): never {

    throwScratchDiagnostic({
        code: 'SCRATCH_RESOURCE_DESCRIPTOR_INVALID',
        severity: 'error',
        phase: 'resource',
        subject,
        message: 'TextureResource requires a valid 2D texture descriptor and extent.',
        expected,
        actual,
    })
}
