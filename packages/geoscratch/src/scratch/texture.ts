import { throwScratchDiagnostic } from './diagnostics.js'
import {
    createScratchNativeLabel,
    destroyNativeCandidate,
    issueScopedNativeAllocation,
    recheckScopedNativeAllocationLifecycle,
    throwScopedAllocationFailure,
} from './native-allocation.js'
import {
    contentBearingResourceOptions,
    createScratchResourceIdentity,
    registerResource,
    replaceResourceAllocation,
    Resource,
    resourceContentEpoch,
    resourceContentState,
} from './resource.js'
import {
    diagnosticsControllerFor,
    logicalTextureDescriptorFootprint,
} from './runtime-diagnostics.js'
import { getGlobalConstant, isRecord } from './type-utils.js'
import {
    textureFormatIsRenderable,
    textureFormatSupportsStorageBinding,
} from './texture-format-capabilities.js'
import type { DiagnosticSubject } from './diagnostics.js'
import type { ResourceState, ScratchResourceIdentity } from './resource.js'
import type { ScratchRuntime } from './runtime.js'
import type { ScratchPendingGpuOperation } from './runtime-diagnostics.js'

const GPU_TEXTURE_USAGE_STORAGE_BINDING = getGlobalConstant('GPUTextureUsage', 'STORAGE_BINDING', 0x8)
const GPU_TEXTURE_USAGE_RENDER_ATTACHMENT = getGlobalConstant('GPUTextureUsage', 'RENDER_ATTACHMENT', 0x10)
const GPU_TEXTURE_USAGE_TRANSIENT_ATTACHMENT = getGlobalConstant('GPUTextureUsage', 'TRANSIENT_ATTACHMENT', 0x20)
const GPU_INTEGER_COORDINATE_MAX = 0xffff_ffff
const GPU_FLAGS_MAX = 0xffff_ffff
const TEXTURE_DIMENSIONS = new Set<GPUTextureDimension>([ '1d', '2d', '3d' ])
const TEXTURE_BINDING_VIEW_DIMENSIONS = new Set<GPUTextureViewDimension>([
    '1d',
    '2d',
    '2d-array',
    'cube',
    'cube-array',
    '3d',
])
const TEXTURE_VIEW_ASPECTS = new Set<GPUTextureAspect>([ 'all', 'stencil-only', 'depth-only' ])
const DEPTH_TEXTURE_FORMATS = new Set<GPUTextureFormat>([
    'depth16unorm',
    'depth24plus',
    'depth24plus-stencil8',
    'depth32float',
    'depth32float-stencil8',
])
const STENCIL_TEXTURE_FORMATS = new Set<GPUTextureFormat>([
    'stencil8',
    'depth24plus-stencil8',
    'depth32float-stencil8',
])
const COLOR_TEXEL_COPY_FOOTPRINTS = new Map<GPUTextureFormat, number>([
    [ 'r8unorm', 1 ],
    [ 'r8snorm', 1 ],
    [ 'r8uint', 1 ],
    [ 'r8sint', 1 ],
    [ 'r16unorm', 2 ],
    [ 'r16snorm', 2 ],
    [ 'r16uint', 2 ],
    [ 'r16sint', 2 ],
    [ 'r16float', 2 ],
    [ 'rg8unorm', 2 ],
    [ 'rg8snorm', 2 ],
    [ 'rg8uint', 2 ],
    [ 'rg8sint', 2 ],
    [ 'r32uint', 4 ],
    [ 'r32sint', 4 ],
    [ 'r32float', 4 ],
    [ 'rg16unorm', 4 ],
    [ 'rg16snorm', 4 ],
    [ 'rg16uint', 4 ],
    [ 'rg16sint', 4 ],
    [ 'rg16float', 4 ],
    [ 'rgba8unorm', 4 ],
    [ 'rgba8unorm-srgb', 4 ],
    [ 'rgba8snorm', 4 ],
    [ 'rgba8uint', 4 ],
    [ 'rgba8sint', 4 ],
    [ 'bgra8unorm', 4 ],
    [ 'bgra8unorm-srgb', 4 ],
    [ 'rgb9e5ufloat', 4 ],
    [ 'rgb10a2uint', 4 ],
    [ 'rgb10a2unorm', 4 ],
    [ 'rg11b10ufloat', 4 ],
    [ 'rg32uint', 8 ],
    [ 'rg32sint', 8 ],
    [ 'rg32float', 8 ],
    [ 'rgba16unorm', 8 ],
    [ 'rgba16snorm', 8 ],
    [ 'rgba16uint', 8 ],
    [ 'rgba16sint', 8 ],
    [ 'rgba16float', 8 ],
    [ 'rgba32uint', 16 ],
    [ 'rgba32sint', 16 ],
    [ 'rgba32float', 16 ],
])
type DepthStencilTexelCopyCapability = Readonly<{
    source: boolean
    destination: boolean
    bytesPerBlock?: number
}>
type DepthStencilTexelCopyCapabilities = Readonly<{
    depth?: DepthStencilTexelCopyCapability
    stencil?: DepthStencilTexelCopyCapability
}>
const DEPTH_STENCIL_TEXEL_COPY_CAPABILITIES = new Map<
    GPUTextureFormat,
    DepthStencilTexelCopyCapabilities
>([
    [ 'stencil8', {
        stencil: { source: true, destination: true, bytesPerBlock: 1 },
    } ],
    [ 'depth16unorm', {
        depth: { source: true, destination: true, bytesPerBlock: 2 },
    } ],
    [ 'depth24plus', {
        depth: { source: false, destination: false },
    } ],
    [ 'depth24plus-stencil8', {
        depth: { source: false, destination: false },
        stencil: { source: true, destination: true, bytesPerBlock: 1 },
    } ],
    [ 'depth32float', {
        depth: { source: true, destination: false, bytesPerBlock: 4 },
    } ],
    [ 'depth32float-stencil8', {
        depth: { source: true, destination: false, bytesPerBlock: 4 },
        stencil: { source: true, destination: true, bytesPerBlock: 1 },
    } ],
])
const textureResourceToken = Symbol('TextureResource')
const textureViewSpecToken = Symbol('TextureViewSpec')
const textureResources = new WeakSet<TextureResource>()
const textureViewSpecs = new WeakSet<TextureViewSpec>()
const TEXTURE_ALLOCATION_CODES = Object.freeze({
    validation: 'SCRATCH_TEXTURE_ALLOCATION_VALIDATION_FAILED',
    outOfMemory: 'SCRATCH_TEXTURE_ALLOCATION_OUT_OF_MEMORY',
    nativeException: 'SCRATCH_TEXTURE_ALLOCATION_NATIVE_FAILED',
})
const TEXTURE_REPLACEMENT_CODES = Object.freeze({
    validation: 'SCRATCH_TEXTURE_REPLACEMENT_VALIDATION_FAILED',
    outOfMemory: 'SCRATCH_TEXTURE_REPLACEMENT_OUT_OF_MEMORY',
    nativeException: 'SCRATCH_TEXTURE_REPLACEMENT_NATIVE_FAILED',
})

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

export type TextureViewDescriptor = GPUTextureViewDescriptor & {
    swizzle?: string
}

export type NormalizedTextureViewDescriptor = Readonly<{
    label?: string
    format: GPUTextureFormat
    dimension: GPUTextureViewDimension
    usage: GPUTextureUsageFlags
    aspect: GPUTextureAspect
    baseMipLevel: number
    mipLevelCount: number
    baseArrayLayer: number
    arrayLayerCount: number
    swizzle: string
}>

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
    #pendingReplacement: ScratchPendingGpuOperation | undefined

    private constructor(
        token: symbol,
        runtime: ScratchRuntime,
        descriptor: NormalizedTextureDescriptor,
        identity: ScratchResourceIdentity,
        gpuTexture: GPUTexture
    ) {

        if (new.target !== TextureResource) {
            throw new TypeError('TextureResource does not support subclass construction.')
        }
        if (token !== textureResourceToken) {
            throw new TypeError('TextureResource must be created by ScratchRuntime.createTexture().')
        }

        super(runtime, contentBearingResourceOptions({
            resourceKind: 'TextureResource',
            descriptor,
            identity,
            ...(descriptor.label !== undefined ? { label: descriptor.label } : {}),
        }))

        this.#physicalDescriptor = descriptor
        this.#gpuTexture = gpuTexture
        registerResource(this)
        textureResources.add(this)
        Object.preventExtensions(this)
    }

    get gpuTexture(): GPUTexture {

        return this.#gpuTexture
    }

    get state(): ResourceState {

        return resourceContentState(this)
    }

    get contentEpoch(): number {

        return resourceContentEpoch(this)
    }

    get isReady(): boolean {

        return this.state === 'ready'
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

    async resize(size: TextureResourceSize): Promise<void> {

        this.assertUsable()

        const nextSize = normalizeTextureSize(this.subject, size)
        validateTextureAllocationDescriptor(this.runtime, this.#physicalDescriptor, nextSize, size)
        if (this.#pendingReplacement !== undefined) {
            throwScratchDiagnostic({
                code: 'SCRATCH_TEXTURE_REPLACEMENT_PENDING',
                severity: 'error',
                phase: 'resource',
                subject: this.subject,
                related: [
                    {
                        kind: 'GpuOperation',
                        id: this.#pendingReplacement.id,
                        operationKind: this.#pendingReplacement.kind,
                    },
                ],
                message: 'TextureResource already has a replacement allocation pending.',
                expected: { pendingReplacement: false },
                actual: { pendingOperationId: this.#pendingReplacement.id },
            })
        }
        if (sameTextureSize(nextSize, this.size)) return

        assertTextureCreationAvailable(this.runtime)

        const nextDescriptor = freezeTextureDescriptor({
            ...this.#physicalDescriptor,
            size: nextSize,
        })
        const nativeLabel = createScratchNativeLabel(this.label, this.id)
        const footprint = logicalTextureDescriptorFootprint(
            nextDescriptor as unknown as Record<string, unknown>
        )
        const controller = diagnosticsControllerFor(this.runtime)
        const operation = controller.beginOperation({
            kind: 'texture-replacement',
            target: {
                kind: 'resource',
                resourceId: this.id,
                resourceKind: 'TextureResource',
                allocationVersion: this.allocationVersion + 1,
                contentEpoch: this.contentEpoch,
                logicalFootprintBytes: footprint.bytes,
            },
            descriptorSummary: textureDescriptorSummary(nextDescriptor),
            fullDescriptor: { ...nextDescriptor },
            nativeLabel,
        })
        this.#pendingReplacement = operation
        let outcome = await issueScopedNativeAllocation(
            this.runtime,
            () => this.runtime.device.createTexture({
                ...nextDescriptor,
                label: nativeLabel,
            }),
            this
        )

        outcome = recheckScopedNativeAllocationLifecycle(this.runtime, outcome, this)
        if (!outcome.ok) {
            this.#pendingReplacement = undefined
            return throwScopedAllocationFailure(
                this.runtime,
                operation,
                outcome,
                TEXTURE_REPLACEMENT_CODES,
                'Texture replacement allocation'
            )
        }

        const previousTexture = this.#gpuTexture
        this.#gpuTexture = outcome.candidate
        this.#physicalDescriptor = nextDescriptor
        replaceResourceAllocation(this, nextDescriptor)
        this.#pendingReplacement = undefined
        controller.completeOperation(operation, { status: 'succeeded' })
        destroyNativeCandidate(previousTexture)
    }

    view(descriptor: TextureViewDescriptor = {}): TextureViewSpec {

        this.assertUsable()
        return constructTextureViewSpec(this, normalizeTextureViewSpecDescriptor(this, descriptor))
    }

    dispose(): void {

        if (this.isDisposed) return

        if (this.gpuTexture && typeof this.gpuTexture.destroy === 'function') {
            this.gpuTexture.destroy()
        }

        super.dispose()
    }
}

Object.freeze(TextureResource.prototype)

export function isTextureResource(value: unknown): value is TextureResource {

    return typeof value === 'object' && value !== null && textureResources.has(value as TextureResource)
}

export class TextureViewSpec {

    readonly texture: TextureResource
    readonly descriptor: NormalizedTextureViewDescriptor
    readonly hash: string

    private constructor(
        token: symbol,
        texture: TextureResource,
        descriptor: NormalizedTextureViewDescriptor
    ) {

        if (token !== textureViewSpecToken || new.target !== TextureViewSpec) {
            throw new TypeError('TextureViewSpec must be created by TextureResource.view().')
        }

        this.texture = texture
        this.descriptor = descriptor
        this.hash = `texture-view-${fnv1a64(textureViewDescriptorSignature(descriptor))}`
        textureViewSpecs.add(this)
        Object.freeze(this)
    }

    get subject(): DiagnosticSubject {

        return textureViewSpecSubject(this)
    }

    assertUsable(): void {

        this.texture.assertUsable()
        validateNormalizedTextureViewDescriptor(this.texture, this.descriptor, this.descriptor)
    }
}

Object.freeze(TextureViewSpec.prototype)

export function isTextureViewSpec(value: unknown): value is TextureViewSpec {

    return typeof value === 'object' && value !== null && textureViewSpecs.has(value as TextureViewSpec)
}

export function textureViewSpecSubject(view: TextureViewSpec): DiagnosticSubject {

    const subject: DiagnosticSubject = {
        kind: 'TextureViewSpec',
        resourceId: view.texture.id,
        hash: view.hash,
        descriptor: view.descriptor,
    }
    if (view.descriptor.label !== undefined) subject.label = view.descriptor.label
    return subject
}

export function prepareTextureViewSpecDescriptor(
    view: TextureViewSpec,
    binding = false
): NormalizedTextureViewDescriptor {

    if (!isTextureViewSpec(view)) {
        throwScratchDiagnostic({
            code: 'SCRATCH_RESOURCE_DESCRIPTOR_INVALID',
            severity: 'error',
            phase: 'resource',
            subject: { kind: 'TextureViewSpec' },
            message: 'Texture view preparation requires a TextureViewSpec.',
            expected: { view: 'TextureViewSpec' },
            actual: { view: typeof view },
        })
    }

    view.assertUsable()
    if (binding) validateTextureBindingViewDimension(view.texture, view.descriptor)
    return view.descriptor
}

export function createNativeTextureView(
    view: TextureViewSpec,
    binding = false
): GPUTextureView {

    const descriptor = prepareTextureViewSpecDescriptor(view, binding)
    return view.texture.gpuTexture.createView(descriptor)
}

function constructTextureViewSpec(
    texture: TextureResource,
    descriptor: NormalizedTextureViewDescriptor
): TextureViewSpec {

    const Constructor = TextureViewSpec as unknown as new (
        token: symbol,
        texture: TextureResource,
        descriptor: NormalizedTextureViewDescriptor
    ) => TextureViewSpec
    return new Constructor(textureViewSpecToken, texture, descriptor)
}

export async function createTextureResource(
    runtime: ScratchRuntime,
    descriptor: TextureResourceDescriptor
): Promise<TextureResource> {

    runtime.assertActive()
    const normalizedDescriptor = normalizeTextureDescriptor(runtime, descriptor)
    const identity = createScratchResourceIdentity()
    const nativeLabel = createScratchNativeLabel(normalizedDescriptor.label, identity.id)
    const nativeDescriptor: GPUTextureDescriptor = {
        ...normalizedDescriptor,
        label: nativeLabel,
    }
    const footprint = logicalTextureDescriptorFootprint(
        normalizedDescriptor as unknown as Record<string, unknown>
    )
    const controller = diagnosticsControllerFor(runtime)
    const operation = controller.beginOperation({
        kind: 'texture-allocation',
        target: {
            kind: 'resource',
            resourceId: identity.id,
            resourceKind: 'TextureResource',
            allocationVersion: 1,
            contentEpoch: 0,
            logicalFootprintBytes: footprint.bytes,
        },
        descriptorSummary: textureDescriptorSummary(normalizedDescriptor),
        fullDescriptor: { ...normalizedDescriptor },
        nativeLabel,
    })
    let outcome = await issueScopedNativeAllocation(
        runtime,
        () => runtime.device.createTexture(nativeDescriptor)
    )
    outcome = recheckScopedNativeAllocationLifecycle(runtime, outcome)

    if (!outcome.ok) {
        return throwScopedAllocationFailure(
            runtime,
            operation,
            outcome,
            TEXTURE_ALLOCATION_CODES,
            'Texture allocation'
        )
    }

    let resource: TextureResource
    try {
        resource = constructTextureResource(
            runtime,
            normalizedDescriptor,
            identity,
            outcome.candidate
        )
    } catch (cause) {
        destroyNativeCandidate(outcome.candidate)
        return throwScopedAllocationFailure(
            runtime,
            operation,
            { ok: false, kind: 'native-exception', cause },
            TEXTURE_ALLOCATION_CODES,
            'Texture allocation'
        )
    }

    controller.completeOperation(operation, { status: 'succeeded' })
    return resource
}

function constructTextureResource(
    runtime: ScratchRuntime,
    descriptor: NormalizedTextureDescriptor,
    identity: ScratchResourceIdentity,
    gpuTexture: GPUTexture
): TextureResource {

    const Constructor = TextureResource as unknown as new (
        token: symbol,
        runtime: ScratchRuntime,
        descriptor: NormalizedTextureDescriptor,
        identity: ScratchResourceIdentity,
        gpuTexture: GPUTexture
    ) => TextureResource
    return new Constructor(textureResourceToken, runtime, descriptor, identity, gpuTexture)
}

function textureDescriptorSummary(descriptor: NormalizedTextureDescriptor): Record<string, unknown> {

    return {
        width: descriptor.size.width,
        height: descriptor.size.height,
        depthOrArrayLayers: descriptor.size.depthOrArrayLayers,
        mipLevelCount: descriptor.mipLevelCount,
        sampleCount: descriptor.sampleCount,
        dimension: descriptor.dimension,
        format: descriptor.format,
        usage: descriptor.usage,
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
    const dimension = normalizeTextureDimension(
        subject,
        descriptor,
        descriptor.dimension === undefined ? '2d' : descriptor.dimension
    )
    const mipLevelCount = normalizePositiveInteger(
        subject,
        descriptor.mipLevelCount === undefined ? 1 : descriptor.mipLevelCount,
        'mipLevelCount'
    )
    const sampleCount = normalizeSampleCount(
        subject,
        descriptor.sampleCount === undefined ? 1 : descriptor.sampleCount
    )
    const viewFormats = normalizeTextureViewFormats(subject, descriptor.viewFormats)
    const textureBindingViewDimension = normalizeTextureBindingViewDimension(
        subject,
        descriptor.textureBindingViewDimension
    )
    if (descriptor.label !== undefined && typeof descriptor.label !== 'string') {
        throwTextureDescriptorDiagnostic(subject, descriptor, {
            label: 'string or undefined',
        })
    }

    const normalized = freezeTextureDescriptor({
        size,
        format,
        usage,
        dimension,
        mipLevelCount,
        sampleCount,
        viewFormats,
        ...(descriptor.label !== undefined ? { label: descriptor.label } : {}),
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
        height = size[1] === undefined ? 1 : size[1]
        depthOrArrayLayers = size[2] === undefined ? 1 : size[2]
    } else if (isRecord(size)) {
        width = size.width
        height = size.height === undefined ? 1 : size.height
        depthOrArrayLayers = size.depthOrArrayLayers === undefined ? 1 : size.depthOrArrayLayers
    } else {
        throwTextureDescriptorDiagnostic(subject, { size }, {
            size: '{ width, height?, depthOrArrayLayers? } or [width, height?, depthOrArrayLayers?]',
        })
    }

    for (const [ key, value ] of Object.entries({ width, height, depthOrArrayLayers })) {
        if (
            typeof value !== 'number' ||
            !Number.isSafeInteger(value) ||
            value <= 0 ||
            value > GPU_INTEGER_COORDINATE_MAX
        ) {
            throwTextureDescriptorDiagnostic(subject, { size }, {
                [key]: `integer in [1, ${GPU_INTEGER_COORDINATE_MAX}]`,
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

    if (
        typeof usage !== 'number' ||
        !Number.isInteger(usage) ||
        usage < 0 ||
        usage > GPU_FLAGS_MAX
    ) {
        throwTextureDescriptorDiagnostic(subject, { usage }, {
            usage: `GPUTextureUsageFlags integer in [0, ${GPU_FLAGS_MAX}]`,
        })
    }

    return usage
}

function normalizePositiveInteger(subject: DiagnosticSubject, value: unknown, key: string): number {

    if (
        typeof value !== 'number' ||
        !Number.isSafeInteger(value) ||
        value <= 0 ||
        value > GPU_INTEGER_COORDINATE_MAX
    ) {
        throwTextureDescriptorDiagnostic(subject, { [key]: value }, {
            [key]: `integer in [1, ${GPU_INTEGER_COORDINATE_MAX}]`,
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

function normalizeTextureViewSpecDescriptor(
    texture: TextureResource,
    descriptor: unknown
): NormalizedTextureViewDescriptor {

    if (!isRecord(descriptor)) {
        throwTextureViewDescriptorDiagnostic(texture, descriptor, {
            descriptor: 'object',
        })
    }

    const aspect = descriptor.aspect === undefined ? 'all' : descriptor.aspect
    const defaultFormat = textureViewAspectFormat(texture.format, aspect)
    const format = descriptor.format === undefined
        ? defaultFormat ?? texture.format
        : descriptor.format
    const dimension = descriptor.dimension === undefined
        ? defaultTextureViewDimension(texture)
        : descriptor.dimension
    const usage = descriptor.usage === undefined || descriptor.usage === 0
        ? texture.usage
        : descriptor.usage
    const baseMipLevel = descriptor.baseMipLevel === undefined ? 0 : descriptor.baseMipLevel
    const mipLevelCount = descriptor.mipLevelCount === undefined
        ? typeof baseMipLevel === 'number' ? texture.mipLevelCount - baseMipLevel : Number.NaN
        : descriptor.mipLevelCount
    const baseArrayLayer = descriptor.baseArrayLayer === undefined ? 0 : descriptor.baseArrayLayer
    const arrayLayerCount = descriptor.arrayLayerCount === undefined && typeof dimension === 'string' && typeof baseArrayLayer === 'number'
        ? defaultTextureViewArrayLayerCount(
            texture,
            dimension as GPUTextureViewDimension,
            baseArrayLayer
        )
        : descriptor.arrayLayerCount
    const swizzle = descriptor.swizzle === undefined ? 'rgba' : descriptor.swizzle

    const normalized = Object.freeze({
        ...(descriptor.label !== undefined ? { label: descriptor.label } : {}),
        format,
        dimension,
        usage,
        aspect,
        baseMipLevel,
        mipLevelCount,
        baseArrayLayer,
        arrayLayerCount,
        swizzle,
    }) as NormalizedTextureViewDescriptor

    validateNormalizedTextureViewDescriptor(texture, normalized, descriptor)
    return normalized
}

function validateNormalizedTextureViewDescriptor(
    texture: TextureResource,
    descriptor: NormalizedTextureViewDescriptor,
    actual: unknown
): void {

    const textureDescriptor = texture.descriptor as NormalizedTextureDescriptor
    const aspectFormat = textureViewAspectFormat(texture.format, descriptor.aspect)
    const allowedFormats = descriptor.aspect === 'all'
        ? new Set<GPUTextureFormat>([ texture.format, ...textureDescriptor.viewFormats ])
        : aspectFormat === undefined
            ? new Set<GPUTextureFormat>()
            : new Set<GPUTextureFormat>([ aspectFormat ])
    if (!allowedFormats.has(descriptor.format)) {
        throwTextureViewDescriptorDiagnostic(texture, actual, {
            format: [ ...allowedFormats ],
            aspect: descriptor.aspect,
        })
    }
    if (
        !Number.isSafeInteger(descriptor.usage) ||
        descriptor.usage < 0 ||
        descriptor.usage > GPU_FLAGS_MAX ||
        (descriptor.usage & texture.usage) !== descriptor.usage
    ) {
        throwTextureViewDescriptorDiagnostic(texture, actual, {
            usage: `GPUTextureUsageFlags subset of ${texture.usage}`,
        })
    }
    if (
        (texture.usage & GPU_TEXTURE_USAGE_TRANSIENT_ATTACHMENT) !== 0 &&
        descriptor.usage !== texture.usage
    ) {
        throwTextureViewDescriptorDiagnostic(texture, actual, {
            usage: `exactly transient texture usage ${texture.usage}`,
        })
    }
    if (
        (descriptor.usage & GPU_TEXTURE_USAGE_RENDER_ATTACHMENT) !== 0 &&
        !textureFormatIsRenderable(texture.runtime, descriptor.format)
    ) {
        throwTextureViewDescriptorDiagnostic(texture, actual, {
            format: 'renderable for RENDER_ATTACHMENT view usage',
        })
    }
    if (
        (descriptor.usage & GPU_TEXTURE_USAGE_STORAGE_BINDING) !== 0 &&
        !textureFormatSupportsStorageBinding(texture.runtime, descriptor.format)
    ) {
        throwTextureViewDescriptorDiagnostic(texture, actual, {
            format: 'supports STORAGE_BINDING for at least one access mode',
        })
    }
    if (!TEXTURE_VIEW_ASPECTS.has(descriptor.aspect)) {
        throwTextureViewDescriptorDiagnostic(texture, actual, {
            aspect: [ ...TEXTURE_VIEW_ASPECTS ],
        })
    }
    if (
        (descriptor.aspect === 'depth-only' && !DEPTH_TEXTURE_FORMATS.has(descriptor.format)) ||
        (descriptor.aspect === 'stencil-only' && !STENCIL_TEXTURE_FORMATS.has(descriptor.format))
    ) {
        throwTextureViewDescriptorDiagnostic(texture, actual, {
            aspect: `aspect supported by ${descriptor.format}`,
        })
    }
    if (typeof descriptor.swizzle !== 'string' || !/^[rgba01]{4}$/.test(descriptor.swizzle)) {
        throwTextureViewDescriptorDiagnostic(texture, actual, {
            swizzle: 'four characters selected from r, g, b, a, 0, and 1',
        })
    }
    if (
        descriptor.swizzle !== 'rgba' &&
        !texture.runtime.deviceFeatures.has('texture-component-swizzle')
    ) {
        throwTextureViewDescriptorDiagnostic(texture, actual, {
            swizzleFeature: 'texture-component-swizzle',
        })
    }
    if (descriptor.label !== undefined && typeof descriptor.label !== 'string') {
        throwTextureViewDescriptorDiagnostic(texture, actual, {
            label: 'string',
        })
    }

    validateTextureViewDescriptor(texture, descriptor, actual)
}

export function prepareTextureViewDescriptor(
    texture: TextureResource,
    descriptor: unknown = {}
): GPUTextureViewDescriptor {

    texture.assertUsable()
    const normalized = normalizeTextureViewDescriptor(texture, descriptor)
    validateTextureViewDescriptor(texture, normalized, descriptor)
    return normalized
}

export function prepareTextureBindingViewDescriptor(
    texture: TextureResource,
    descriptor: unknown = {}
): GPUTextureViewDescriptor {

    const prepared = prepareTextureViewDescriptor(texture, descriptor)
    const dimension = prepared.dimension === undefined
        ? defaultTextureViewDimension(texture)
        : prepared.dimension
    const requiredDimension = currentTextureBindingViewDimension(texture)

    if (requiredDimension !== undefined && dimension !== requiredDimension) {
        throwTextureViewDescriptorDiagnostic(texture, descriptor, {
            textureBindingViewDimension: requiredDimension,
        })
    }

    return prepared
}

function validateTextureBindingViewDimension(
    texture: TextureResource,
    descriptor: Pick<NormalizedTextureViewDescriptor, 'dimension'>
): void {

    const requiredDimension = currentTextureBindingViewDimension(texture)
    if (requiredDimension !== undefined && descriptor.dimension !== requiredDimension) {
        throwTextureViewDescriptorDiagnostic(texture, descriptor, {
            textureBindingViewDimension: requiredDimension,
        })
    }
}

function validateTextureViewDescriptor(
    texture: TextureResource,
    descriptor: GPUTextureViewDescriptor,
    actual: unknown
): void {

    const baseMipLevel = descriptor.baseMipLevel === undefined ? 0 : descriptor.baseMipLevel
    const mipLevelCount = descriptor.mipLevelCount === undefined
        ? texture.mipLevelCount - baseMipLevel
        : descriptor.mipLevelCount
    const baseArrayLayer = descriptor.baseArrayLayer === undefined ? 0 : descriptor.baseArrayLayer
    const dimension = descriptor.dimension === undefined
        ? defaultTextureViewDimension(texture)
        : descriptor.dimension
    const textureArrayLayerCount = texture.dimension === '2d'
        ? texture.depthOrArrayLayers
        : 1

    if (
        !Number.isInteger(baseMipLevel) || baseMipLevel < 0 ||
        !Number.isInteger(mipLevelCount) || mipLevelCount <= 0 ||
        baseMipLevel + mipLevelCount > texture.mipLevelCount ||
        !Number.isInteger(baseArrayLayer) || baseArrayLayer < 0 ||
        !TEXTURE_BINDING_VIEW_DIMENSIONS.has(dimension)
    ) {
        throwTextureViewDescriptorDiagnostic(texture, actual, {
            baseMipLevel: `integer in [0, ${texture.mipLevelCount - 1}]`,
            mipLevelCount: `positive integer within ${texture.mipLevelCount} mip levels`,
            baseArrayLayer: `integer in [0, ${textureArrayLayerCount - 1}]`,
            dimension: [ ...TEXTURE_BINDING_VIEW_DIMENSIONS ],
        })
    }

    const arrayLayerCount = descriptor.arrayLayerCount === undefined
        ? defaultTextureViewArrayLayerCount(texture, dimension, baseArrayLayer)
        : descriptor.arrayLayerCount
    if (
        !Number.isInteger(arrayLayerCount) ||
        arrayLayerCount <= 0 ||
        baseArrayLayer + arrayLayerCount > textureArrayLayerCount
    ) {
        throwTextureViewDescriptorDiagnostic(texture, actual, {
            arrayLayerCount: `positive integer within ${textureArrayLayerCount} array layers`,
        })
    }

    const validDimension = (
        (dimension === '1d' && texture.dimension === '1d' && arrayLayerCount === 1) ||
        (dimension === '2d' && texture.dimension === '2d' && arrayLayerCount === 1) ||
        (dimension === '2d-array' && texture.dimension === '2d') ||
        (dimension === 'cube' && (
            texture.dimension === '2d' &&
            arrayLayerCount === 6 &&
            texture.width === texture.height
        )) ||
        (dimension === 'cube-array' && (
            texture.dimension === '2d' &&
            arrayLayerCount % 6 === 0 &&
            texture.width === texture.height &&
            texture.runtime.deviceFeatures.has('core-features-and-limits')
        )) ||
        (dimension === '3d' && texture.dimension === '3d' && arrayLayerCount === 1)
    ) && (texture.sampleCount === 1 || dimension === '2d')

    if (!validDimension) {
        throwTextureViewDescriptorDiagnostic(texture, actual, {
            dimension: {
                '2d': 'exactly one array layer',
                '2d-array': 'one or more array layers',
                cube: 'six layers on a square texture',
                'cube-array': 'a positive multiple of six layers on a square texture with core-features-and-limits',
                '1d': 'a one-dimensional texture with one array layer',
                '3d': 'a three-dimensional texture with one array layer',
            },
        })
    }
}

function currentTextureBindingViewDimension(
    texture: TextureResource
): GPUTextureViewDimension | undefined {

    if (texture.runtime.deviceFeatures.has('core-features-and-limits')) return undefined

    const declared = (
        texture.descriptor as NormalizedTextureDescriptor
    ).textureBindingViewDimension
    if (declared !== undefined) return declared

    if (texture.dimension === '1d') return '1d'
    if (texture.dimension === '3d') return '3d'
    return texture.depthOrArrayLayers === 1 ? '2d' : '2d-array'
}

function defaultTextureViewDimension(texture: TextureResource): GPUTextureViewDimension {

    if (texture.dimension === '1d') return '1d'
    if (texture.dimension === '3d') return '3d'
    return texture.depthOrArrayLayers === 1 ? '2d' : '2d-array'
}

function defaultTextureViewArrayLayerCount(
    texture: TextureResource,
    dimension: GPUTextureViewDimension,
    baseArrayLayer: number
): number {

    if (dimension === 'cube') return 6
    if (dimension === '2d-array' || dimension === 'cube-array') {
        return texture.depthOrArrayLayers - baseArrayLayer
    }

    return 1
}

function textureViewAspectFormat(
    format: GPUTextureFormat,
    aspect: unknown
): GPUTextureFormat | undefined {

    if (aspect === 'all') return format
    if (aspect === 'depth-only') {
        if (format === 'depth24plus-stencil8') return 'depth24plus'
        if (format === 'depth32float-stencil8') return 'depth32float'
        return DEPTH_TEXTURE_FORMATS.has(format) ? format : undefined
    }
    if (aspect === 'stencil-only') {
        return STENCIL_TEXTURE_FORMATS.has(format) ? 'stencil8' : undefined
    }
    return undefined
}

function throwTextureViewDescriptorDiagnostic(
    texture: TextureResource,
    actual: unknown,
    expected: object
): never {

    throwScratchDiagnostic({
        code: 'SCRATCH_RESOURCE_DESCRIPTOR_INVALID',
        severity: 'error',
        phase: 'resource',
        subject: texture.subject,
        message: 'TextureResource view descriptor is invalid for the current allocation.',
        expected: { viewDescriptor: expected },
        actual: { viewDescriptor: actual },
        hints: [ 'Select mip levels, array layers, and a view dimension valid for the current texture allocation.' ],
    })
}

function sortObjectKeys(value: unknown): unknown {

    if (Array.isArray(value)) return value.map(sortObjectKeys)
    if (!isRecord(value)) return value

    return Object.keys(value).sort().reduce<Record<string, unknown>>((result, key) => {
        result[key] = sortObjectKeys(value[key])
        return result
    }, {})
}

function textureViewDescriptorSignature(descriptor: NormalizedTextureViewDescriptor): string {

    return JSON.stringify({
        format: descriptor.format,
        dimension: descriptor.dimension,
        usage: descriptor.usage,
        aspect: descriptor.aspect,
        baseMipLevel: descriptor.baseMipLevel,
        mipLevelCount: descriptor.mipLevelCount,
        baseArrayLayer: descriptor.baseArrayLayer,
        arrayLayerCount: descriptor.arrayLayerCount,
        swizzle: descriptor.swizzle,
    })
}

function fnv1a64(value: string): string {

    let hash = 0xcbf29ce484222325n
    for (let index = 0; index < value.length; index++) {
        hash ^= BigInt(value.charCodeAt(index))
        hash = BigInt.asUintN(64, hash * 0x100000001b3n)
    }
    return hash.toString(16).padStart(16, '0')
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

    const limits = runtime.deviceLimits
    const maxTextureDimension1D = limits?.maxTextureDimension1D
    const maxTextureDimension2D = limits?.maxTextureDimension2D
    const maxTextureDimension3D = limits?.maxTextureDimension3D
    const maxTextureArrayLayers = limits?.maxTextureArrayLayers

    if (descriptor.dimension === '1d' && (
        size.height !== 1 ||
        size.depthOrArrayLayers !== 1 ||
        descriptor.mipLevelCount !== 1 ||
        descriptor.sampleCount !== 1 ||
        (descriptor.usage & GPU_TEXTURE_USAGE_RENDER_ATTACHMENT) !== 0 ||
        DEPTH_TEXTURE_FORMATS.has(descriptor.format) ||
        STENCIL_TEXTURE_FORMATS.has(descriptor.format) ||
        textureFormatIsCompressed(descriptor.format) ||
        (typeof maxTextureDimension1D === 'number' && size.width > maxTextureDimension1D)
    )) {
        throwTextureDescriptorDiagnostic(runtime.subject, actual, {
            dimension: '1d',
            width: `positive integer <= ${String(maxTextureDimension1D)}`,
            height: 1,
            depthOrArrayLayers: 1,
            mipLevelCount: 1,
            sampleCount: 1,
            usage: 'excludes RENDER_ATTACHMENT',
            format: 'non-compressed color format',
        })
    }
    if (descriptor.dimension === '2d' && (
        (typeof maxTextureDimension2D === 'number' && (
            size.width > maxTextureDimension2D || size.height > maxTextureDimension2D
        )) ||
        (typeof maxTextureArrayLayers === 'number' &&
            size.depthOrArrayLayers > maxTextureArrayLayers)
    )) {
        throwTextureDescriptorDiagnostic(runtime.subject, actual, {
            width: `positive integer <= ${String(maxTextureDimension2D)}`,
            height: `positive integer <= ${String(maxTextureDimension2D)}`,
            depthOrArrayLayers: `positive integer <= ${String(maxTextureArrayLayers)}`,
        })
    }
    if (descriptor.dimension === '3d' && (
        descriptor.sampleCount !== 1 ||
        DEPTH_TEXTURE_FORMATS.has(descriptor.format) ||
        STENCIL_TEXTURE_FORMATS.has(descriptor.format) ||
        !textureFormatSupports3D(runtime, descriptor.format) ||
        (typeof maxTextureDimension3D === 'number' && (
            size.width > maxTextureDimension3D ||
            size.height > maxTextureDimension3D ||
            size.depthOrArrayLayers > maxTextureDimension3D
        ))
    )) {
        throwTextureDescriptorDiagnostic(runtime.subject, actual, {
            dimension: '3d',
            extent: `positive integers <= ${String(maxTextureDimension3D)}`,
            sampleCount: 1,
            format: 'color format with 3d capability',
        })
    }

    const maxMipLevelCount = descriptor.dimension === '1d'
        ? 1
        : Math.floor(Math.log2(Math.max(
            size.width,
            size.height,
            descriptor.dimension === '3d' ? size.depthOrArrayLayers : 1
        ))) + 1
    if (descriptor.mipLevelCount > maxMipLevelCount) {
        throwTextureDescriptorDiagnostic(runtime.subject, actual, {
            mipLevelCount: `<= ${maxMipLevelCount} for the requested texture extent`,
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
        (descriptor.usage & GPU_TEXTURE_USAGE_RENDER_ATTACHMENT) !== 0 &&
        !textureFormatIsRenderable(runtime, descriptor.format)
    ) {
        throwTextureDescriptorDiagnostic(runtime.subject, actual, {
            format: 'renderable for RENDER_ATTACHMENT texture usage',
        })
    }

    if (
        (descriptor.usage & GPU_TEXTURE_USAGE_STORAGE_BINDING) !== 0 &&
        !textureFormatSupportsStorageBinding(runtime, descriptor.format)
    ) {
        throwTextureDescriptorDiagnostic(runtime.subject, actual, {
            format: 'supports STORAGE_BINDING for at least one access mode',
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

export function textureFormatBlockSize(format: GPUTextureFormat): { width: number, height: number } {

    if (/^(bc(?:[1-5]|6h|7)|etc2|eac)-/.test(format)) {
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

export function textureFormatIsCompressed(format: GPUTextureFormat): boolean {

    const block = textureFormatBlockSize(format)
    return block.width > 1 || block.height > 1
}

export type TextureFormatCopyFootprint = Readonly<{
    blockWidth: number
    blockHeight: number
    bytesPerBlock: number
    offsetAlignment: number
}>

export function textureFormatCopyFootprint(
    format: GPUTextureFormat,
    aspect: GPUTextureAspect,
    direction: 'source' | 'destination'
): TextureFormatCopyFootprint | undefined {

    const depthStencilCapabilities = DEPTH_STENCIL_TEXEL_COPY_CAPABILITIES.get(format)
    if (depthStencilCapabilities !== undefined) {
        const availableAspects = [
            depthStencilCapabilities.depth !== undefined ? 'depth' : undefined,
            depthStencilCapabilities.stencil !== undefined ? 'stencil' : undefined,
        ].filter((value): value is 'depth' | 'stencil' => value !== undefined)
        const resolvedAspect = aspect === 'depth-only'
            ? 'depth'
            : aspect === 'stencil-only'
                ? 'stencil'
                : aspect === 'all' && availableAspects.length === 1
                    ? availableAspects[0]
                    : undefined
        const capability = resolvedAspect === undefined
            ? undefined
            : depthStencilCapabilities[resolvedAspect]
        if (
            capability === undefined ||
            capability[direction] !== true ||
            capability.bytesPerBlock === undefined
        ) return undefined

        return Object.freeze({
            blockWidth: 1,
            blockHeight: 1,
            bytesPerBlock: capability.bytesPerBlock,
            offsetAlignment: 4,
        })
    }

    if (aspect !== 'all') return undefined
    const bytesPerBlock = colorTexelCopyFootprint(format)
    if (bytesPerBlock === undefined) return undefined
    const blockSize = textureFormatBlockSize(format)
    return Object.freeze({
        blockWidth: blockSize.width,
        blockHeight: blockSize.height,
        bytesPerBlock,
        offsetAlignment: bytesPerBlock,
    })
}

export function textureFormatIsDepthStencil(format: GPUTextureFormat): boolean {

    return DEPTH_STENCIL_TEXEL_COPY_CAPABILITIES.has(format)
}

function colorTexelCopyFootprint(format: GPUTextureFormat): number | undefined {

    const plainFootprint = COLOR_TEXEL_COPY_FOOTPRINTS.get(format)
    if (plainFootprint !== undefined) return plainFootprint
    if (/^bc(?:1|4)-/.test(format)) return 8
    if (/^bc(?:2|3|5|6h|7)-/.test(format)) return 16
    if (/^(?:etc2-(?:rgb8|rgb8a1)|eac-r11)/.test(format)) return 8
    if (/^(?:etc2-rgba8|eac-rg11)/.test(format)) return 16
    if (/^astc-/.test(format)) return 16
    return undefined
}

function textureFormatSupports3D(runtime: ScratchRuntime, format: GPUTextureFormat): boolean {

    if (/^bc(?:[1-5]|6h|7)-/.test(format)) {
        return runtime.deviceFeatures.has('texture-compression-bc-sliced-3d')
    }
    if (/^astc-/.test(format)) {
        return runtime.deviceFeatures.has('texture-compression-astc-sliced-3d')
    }
    if (/^(etc2|eac)-/.test(format)) return false
    return true
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
        message: 'TextureResource requires a valid texture descriptor and extent.',
        expected,
        actual,
    })
}
