import type { ScratchRuntime } from './runtime.js'

export type TextureFormatFeatureRequirement =
    | 'base'
    | 'bgra8unorm-storage'
    | 'core-features-and-limits'
    | 'depth32float-stencil8'
    | 'rg11b10ufloat-renderable'
    | 'texture-formats-tier1'
    | 'texture-formats-tier2'

export type StorageTextureFormatCapabilities = Readonly<Partial<
    Record<GPUStorageTextureAccess, TextureFormatFeatureRequirement>
>>

const BASE_RENDERABLE_COLOR_FORMATS = [
    'r8unorm',
    'r8uint',
    'r8sint',
    'rg8unorm',
    'rg8uint',
    'rg8sint',
    'rgba8unorm',
    'rgba8unorm-srgb',
    'rgba8uint',
    'rgba8sint',
    'bgra8unorm',
    'r16uint',
    'r16sint',
    'r16float',
    'rg16uint',
    'rg16sint',
    'rg16float',
    'rgba16uint',
    'rgba16sint',
    'rgba16float',
    'r32uint',
    'r32sint',
    'r32float',
    'rg32uint',
    'rg32sint',
    'rg32float',
    'rgba32uint',
    'rgba32sint',
    'rgba32float',
    'rgb10a2uint',
    'rgb10a2unorm',
] as const satisfies readonly GPUTextureFormat[]

const TIER_1_RENDERABLE_COLOR_FORMATS = [
    'r8snorm',
    'rg8snorm',
    'rgba8snorm',
    'r16unorm',
    'r16snorm',
    'rg16unorm',
    'rg16snorm',
    'rgba16unorm',
    'rgba16snorm',
] as const satisfies readonly GPUTextureFormat[]

const DEPTH_STENCIL_FORMATS = [
    'stencil8',
    'depth16unorm',
    'depth24plus',
    'depth24plus-stencil8',
    'depth32float',
] as const satisfies readonly GPUTextureFormat[]

const DEPTH_STENCIL_FORMAT_SET = new Set<GPUTextureFormat>([
    ...DEPTH_STENCIL_FORMATS,
    'depth32float-stencil8',
])

const BASE_STORAGE_TEXTURE_FORMATS = [
    'rgba8unorm',
    'rgba8snorm',
    'rgba8uint',
    'rgba8sint',
    'rgba16uint',
    'rgba16sint',
    'rgba16float',
    'r32uint',
    'r32sint',
    'r32float',
    'rgba32uint',
    'rgba32sint',
    'rgba32float',
] as const satisfies readonly GPUTextureFormat[]

const TIER_1_STORAGE_TEXTURE_FORMATS = [
    'r8unorm',
    'r8snorm',
    'r8uint',
    'r8sint',
    'rg8unorm',
    'rg8snorm',
    'rg8uint',
    'rg8sint',
    'r16unorm',
    'r16snorm',
    'r16uint',
    'r16sint',
    'r16float',
    'rg16unorm',
    'rg16snorm',
    'rg16uint',
    'rg16sint',
    'rg16float',
    'rgba16unorm',
    'rgba16snorm',
    'rgb10a2uint',
    'rgb10a2unorm',
    'rg11b10ufloat',
] as const satisfies readonly GPUTextureFormat[]

const TIER_2_READ_WRITE_STORAGE_TEXTURE_FORMATS = [
    'r8unorm',
    'r8uint',
    'r8sint',
    'rgba8unorm',
    'rgba8uint',
    'rgba8sint',
    'r16uint',
    'r16sint',
    'r16float',
    'rgba16uint',
    'rgba16sint',
    'rgba16float',
    'rgba32uint',
    'rgba32sint',
    'rgba32float',
] as const satisfies readonly GPUTextureFormat[]

const RENDERABLE_FORMAT_REQUIREMENTS = createRenderableFormatRequirements()
const STORAGE_TEXTURE_FORMAT_CAPABILITIES = createStorageTextureFormatCapabilities()

export function textureFormatIsRenderable(
    runtime: ScratchRuntime,
    format: GPUTextureFormat
): boolean {

    const requirement = RENDERABLE_FORMAT_REQUIREMENTS.get(format)
    return requirement !== undefined &&
        runtimeSupportsTextureFormatRequirement(runtime, requirement)
}

export function textureFormatIsColorRenderable(
    runtime: ScratchRuntime,
    format: GPUTextureFormat
): boolean {

    return !DEPTH_STENCIL_FORMAT_SET.has(format) && textureFormatIsRenderable(runtime, format)
}

export function textureFormatSupportsStorageBinding(
    runtime: ScratchRuntime,
    format: GPUTextureFormat
): boolean {

    const capabilities = STORAGE_TEXTURE_FORMAT_CAPABILITIES.get(format)
    return capabilities !== undefined && Object.values(capabilities).some(requirement =>
        requirement !== undefined &&
        runtimeSupportsTextureFormatRequirement(runtime, requirement)
    )
}

export function storageTextureFormatCapabilities(
    format: GPUTextureFormat
): StorageTextureFormatCapabilities | undefined {

    return STORAGE_TEXTURE_FORMAT_CAPABILITIES.get(format)
}

export function runtimeSupportsTextureFormatRequirement(
    runtime: ScratchRuntime,
    requirement: TextureFormatFeatureRequirement
): boolean {

    if (requirement === 'base') return true
    if (requirement === 'texture-formats-tier1') {
        return runtimeHasFeature(runtime, 'texture-formats-tier1') ||
            runtimeHasFeature(runtime, 'texture-formats-tier2')
    }
    if (requirement === 'rg11b10ufloat-renderable') {
        return runtimeHasFeature(runtime, 'rg11b10ufloat-renderable') ||
            runtimeHasFeature(runtime, 'texture-formats-tier1') ||
            runtimeHasFeature(runtime, 'texture-formats-tier2')
    }
    return runtimeHasFeature(runtime, requirement)
}

function createRenderableFormatRequirements(): ReadonlyMap<
    GPUTextureFormat,
    TextureFormatFeatureRequirement
> {

    const requirements = new Map<GPUTextureFormat, TextureFormatFeatureRequirement>()
    for (const format of BASE_RENDERABLE_COLOR_FORMATS) requirements.set(format, 'base')
    for (const format of TIER_1_RENDERABLE_COLOR_FORMATS) {
        requirements.set(format, 'texture-formats-tier1')
    }
    for (const format of DEPTH_STENCIL_FORMATS) requirements.set(format, 'base')
    requirements.set('bgra8unorm-srgb', 'core-features-and-limits')
    requirements.set('rg11b10ufloat', 'rg11b10ufloat-renderable')
    requirements.set('depth32float-stencil8', 'depth32float-stencil8')
    return requirements
}

function createStorageTextureFormatCapabilities(): ReadonlyMap<
    GPUTextureFormat,
    StorageTextureFormatCapabilities
> {

    const formats = new Map<GPUTextureFormat, Record<string, TextureFormatFeatureRequirement>>()
    const addAccess = (
        format: GPUTextureFormat,
        access: GPUStorageTextureAccess,
        requirement: TextureFormatFeatureRequirement
    ) => {
        const capabilities = formats.get(format) ?? {}
        capabilities[access] = requirement
        formats.set(format, capabilities)
    }

    for (const format of BASE_STORAGE_TEXTURE_FORMATS) {
        addAccess(format, 'write-only', 'base')
        addAccess(format, 'read-only', 'base')
    }
    for (const format of [ 'r32uint', 'r32sint', 'r32float' ] as const) {
        addAccess(format, 'read-write', 'base')
    }
    for (const format of TIER_1_STORAGE_TEXTURE_FORMATS) {
        addAccess(format, 'write-only', 'texture-formats-tier1')
        addAccess(format, 'read-only', 'texture-formats-tier1')
    }
    for (const format of [ 'rg32uint', 'rg32sint', 'rg32float' ] as const) {
        addAccess(format, 'write-only', 'core-features-and-limits')
        addAccess(format, 'read-only', 'core-features-and-limits')
    }
    for (const format of TIER_2_READ_WRITE_STORAGE_TEXTURE_FORMATS) {
        addAccess(format, 'read-write', 'texture-formats-tier2')
    }
    addAccess('bgra8unorm', 'write-only', 'bgra8unorm-storage')

    return new Map([ ...formats ].map(([ format, capabilities ]) => [
        format,
        Object.freeze(capabilities),
    ]))
}

function runtimeHasFeature(runtime: ScratchRuntime, feature: string): boolean {

    return runtime.deviceFeatures.has(feature as GPUFeatureName)
}
