import { throwScratchDiagnostic } from './diagnostics.js'
import { isLayoutArtifact } from './layout-codec.js'
import {
    isTextureResource,
    textureFormatBlockSize,
    textureFormatCopyFootprint,
    textureFormatIsCompressed,
    textureFormatIsDepthStencil,
} from './texture.js'
import { describeValue, isRecord } from './type-utils.js'
import type { DiagnosticSubject } from './diagnostics.js'
import type { LayoutArtifact } from './layout-codec.js'
import type { ScratchRuntime } from './runtime.js'
import type { TextureResource } from './texture.js'

const TEXTURE_USAGE_COPY_SRC = 0x1
const GPU_SIZE_32_MAX = 0xffff_ffff

export type TextureReadbackOrigin =
    | Readonly<{ x?: number, y?: number, z?: number }>
    | readonly [number, number?, number?]

export type TextureReadbackSize =
    | Readonly<{ width: number, height?: number, depthOrArrayLayers?: number }>
    | readonly [number, number?, number?]

export type TextureReadbackSourceDescriptor = Readonly<{
    resource: TextureResource
    mipLevel?: number
    origin?: TextureReadbackOrigin
    size: TextureReadbackSize
    aspect?: GPUTextureAspect
    layout?: LayoutArtifact
}>

export type TextureReadbackSource = Readonly<{
    resource: TextureResource
    mipLevel: number
    origin: Readonly<{ x: number, y: number, z: number }>
    size: Readonly<{ width: number, height: number, depthOrArrayLayers: number }>
    aspect: GPUTextureAspect
    layout?: LayoutArtifact
}>

export type TextureReadbackRowLayout = Readonly<{
    format: GPUTextureFormat
    aspect: GPUTextureAspect
    blockWidth: number
    blockHeight: number
    bytesPerBlock: number
    widthInBlocks: number
    heightInBlocks: number
    logicalBytesPerRow: number
    logicalRowsPerImage: number
    logicalBytesPerImage: number
    logicalByteLength: number
    stagingBytesPerRow: number
    stagingRowsPerImage: number
    stagingBytesPerImage: number
    stagingByteLength: number
}>

export type NormalizedTextureReadback = Readonly<{
    source: TextureReadbackSource
    rowLayout: TextureReadbackRowLayout
}>

export function normalizeTextureReadbackSource(
    runtime: ScratchRuntime,
    descriptor: unknown,
    subject: DiagnosticSubject
): NormalizedTextureReadback {

    if (!isRecord(descriptor)) {
        return throwTextureReadbackSourceInvalid(subject, undefined, descriptor, 'resource')
    }

    const resource = descriptor.resource
    if (!isTextureResource(resource)) {
        return throwTextureReadbackSourceInvalid(subject, undefined, descriptor, 'resource')
    }
    const mipLevelInput = descriptor.mipLevel
    const originInput = descriptor.origin
    const sizeInput = descriptor.size
    const aspectInput = descriptor.aspect
    const layoutInput = descriptor.layout

    resource.assertRuntime(runtime)
    resource.assertUsable()
    if ((resource.usage & TEXTURE_USAGE_COPY_SRC) === 0) {
        throwScratchDiagnostic({
            code: 'SCRATCH_RESOURCE_USAGE_MISSING',
            severity: 'error',
            phase: 'readback',
            subject,
            related: [ resource.subject ],
            message: 'Texture readback source requires GPUTextureUsage.COPY_SRC.',
            expected: { usage: 'GPUTextureUsage.COPY_SRC' },
            actual: { usage: resource.usage },
        })
    }

    const mipLevel = normalizeMipLevel(subject, resource, mipLevelInput)
    const origin = normalizeOrigin(subject, resource, originInput)
    const size = normalizeSize(subject, resource, sizeInput)
    const aspect = normalizeAspect(subject, resource, aspectInput)
    const layout = normalizeInterpretation(subject, resource, layoutInput)
    resource.assertRuntime(runtime)
    resource.assertUsable()
    const extent = textureMipExtent(resource, mipLevel)
    const footprint = textureFormatCopyFootprint(resource.format, aspect, 'source')
    const blockSize = textureFormatBlockSize(resource.format)
    const blockAligned =
        origin.x % blockSize.width === 0 &&
        origin.y % blockSize.height === 0 &&
        size.width % blockSize.width === 0 &&
        size.height % blockSize.height === 0
    const physicalSubresourceCovered = !textureFormatIsDepthStencil(resource.format) || (
        size.width === extent.width &&
        size.height === extent.height &&
        size.depthOrArrayLayers === extent.depthOrArrayLayers
    )
    const compressedAllowed =
        runtime.deviceFeatures.has('core-features-and-limits') ||
        !textureFormatIsCompressed(resource.format)

    if (
        resource.sampleCount !== 1 ||
        footprint === undefined ||
        !compressedAllowed ||
        !blockAligned ||
        !physicalSubresourceCovered ||
        origin.x + size.width > extent.width ||
        origin.y + size.height > extent.height ||
        origin.z + size.depthOrArrayLayers > extent.depthOrArrayLayers
    ) {
        return throwTextureReadbackSourceInvalid(
            subject,
            resource,
            descriptor,
            resource.sampleCount !== 1
                ? 'sampleCount'
                : footprint === undefined
                    ? 'aspect'
                    : !compressedAllowed
                        ? 'format'
                        : !blockAligned
                            ? 'blockAlignment'
                            : !physicalSubresourceCovered
                                ? 'physicalSubresource'
                                : 'range',
            { mipLevel, origin, size, aspect }
        )
    }

    const widthInBlocks = size.width / footprint.blockWidth
    const heightInBlocks = size.height / footprint.blockHeight
    const logicalBytesPerRow = checkedProduct(
        subject,
        resource,
        widthInBlocks,
        footprint.bytesPerBlock,
        'logicalBytesPerRow'
    )
    const logicalRowsPerImage = heightInBlocks
    const logicalBytesPerImage = checkedProduct(
        subject,
        resource,
        logicalBytesPerRow,
        logicalRowsPerImage,
        'logicalBytesPerImage'
    )
    const logicalByteLength = checkedProduct(
        subject,
        resource,
        logicalBytesPerImage,
        size.depthOrArrayLayers,
        'logicalByteLength'
    )
    const stagingBytesPerRow = checkedRoundUp(
        subject,
        resource,
        logicalBytesPerRow,
        256,
        'stagingBytesPerRow'
    )
    if (stagingBytesPerRow > GPU_SIZE_32_MAX || logicalRowsPerImage > GPU_SIZE_32_MAX) {
        return throwTextureReadbackSourceInvalid(
            subject,
            resource,
            descriptor,
            'layoutRange',
            { stagingBytesPerRow, logicalRowsPerImage }
        )
    }
    const stagingRowsPerImage = logicalRowsPerImage
    const stagingBytesPerImage = checkedProduct(
        subject,
        resource,
        stagingBytesPerRow,
        stagingRowsPerImage,
        'stagingBytesPerImage'
    )
    const stagingByteLength = checkedProduct(
        subject,
        resource,
        stagingBytesPerImage,
        size.depthOrArrayLayers,
        'stagingByteLength'
    )

    if (
        layout !== undefined &&
        (
            layout.usageCompatibility.readback !== true ||
            logicalByteLength % layout.stride !== 0
        )
    ) {
        throwScratchDiagnostic({
            code: 'SCRATCH_READBACK_LAYOUT_INVALID',
            severity: 'error',
            phase: 'readback',
            subject,
            related: [ resource.subject ],
            message: 'Texture readback interpretation must cover complete logical result records.',
            expected: {
                usageCompatibility: { readback: true },
                logicalByteLength: `multiple of layout stride ${layout.stride}`,
            },
            actual: {
                usageCompatibility: layout.usageCompatibility,
                logicalByteLength,
                layoutStride: layout.stride,
            },
        })
    }

    const normalizedSource: TextureReadbackSource = Object.freeze({
        resource,
        mipLevel,
        origin: Object.freeze(origin),
        size: Object.freeze(size),
        aspect,
        ...(layout !== undefined ? { layout } : {}),
    })
    const rowLayout: TextureReadbackRowLayout = Object.freeze({
        format: resource.format,
        aspect,
        blockWidth: footprint.blockWidth,
        blockHeight: footprint.blockHeight,
        bytesPerBlock: footprint.bytesPerBlock,
        widthInBlocks,
        heightInBlocks,
        logicalBytesPerRow,
        logicalRowsPerImage,
        logicalBytesPerImage,
        logicalByteLength,
        stagingBytesPerRow,
        stagingRowsPerImage,
        stagingBytesPerImage,
        stagingByteLength,
    })
    return Object.freeze({ source: normalizedSource, rowLayout })
}

export function textureReadbackCopySource(
    source: TextureReadbackSource
): GPUTexelCopyTextureInfo {

    return {
        texture: source.resource.gpuTexture,
        mipLevel: source.mipLevel,
        origin: source.origin,
        aspect: source.aspect,
    }
}

export function textureReadbackCopyDestination(
    buffer: GPUBuffer,
    rowLayout: TextureReadbackRowLayout
): GPUTexelCopyBufferInfo {

    return {
        buffer,
        offset: 0,
        bytesPerRow: rowLayout.stagingBytesPerRow,
        rowsPerImage: rowLayout.stagingRowsPerImage,
    }
}

export function copyTextureReadbackLogicalBytes(
    mapped: ArrayBuffer,
    rowLayout: TextureReadbackRowLayout,
    depthOrArrayLayers: number
): Uint8Array {

    const source = new Uint8Array(mapped)
    const result = new Uint8Array(rowLayout.logicalByteLength)
    for (let image = 0; image < depthOrArrayLayers; image++) {
        const sourceImageOffset = image * rowLayout.stagingBytesPerImage
        const targetImageOffset = image * rowLayout.logicalBytesPerImage
        for (let row = 0; row < rowLayout.logicalRowsPerImage; row++) {
            const sourceOffset = sourceImageOffset + row * rowLayout.stagingBytesPerRow
            const targetOffset = targetImageOffset + row * rowLayout.logicalBytesPerRow
            result.set(
                source.subarray(sourceOffset, sourceOffset + rowLayout.logicalBytesPerRow),
                targetOffset
            )
        }
    }
    return result
}

function normalizeMipLevel(
    subject: DiagnosticSubject,
    resource: TextureResource,
    value: unknown
): number {

    const mipLevel = value ?? 0
    if (
        !Number.isInteger(mipLevel) ||
        (mipLevel as number) < 0 ||
        (mipLevel as number) >= resource.mipLevelCount
    ) {
        return throwTextureReadbackSourceInvalid(subject, resource, value, 'mipLevel')
    }
    return mipLevel as number
}

function normalizeOrigin(
    subject: DiagnosticSubject,
    resource: TextureResource,
    value: unknown
): { x: number, y: number, z: number } {

    const origin = value ?? {}
    let x: unknown
    let y: unknown
    let z: unknown
    if (Array.isArray(origin)) {
        x = origin[0] ?? 0
        y = origin[1] ?? 0
        z = origin[2] ?? 0
    } else if (isRecord(origin)) {
        x = origin.x ?? 0
        y = origin.y ?? 0
        z = origin.z ?? 0
    } else {
        return throwTextureReadbackSourceInvalid(subject, resource, value, 'origin')
    }
    if (![ x, y, z ].every(coordinate =>
        Number.isInteger(coordinate) && (coordinate as number) >= 0
    )) {
        return throwTextureReadbackSourceInvalid(subject, resource, value, 'origin')
    }
    return { x: x as number, y: y as number, z: z as number }
}

function normalizeSize(
    subject: DiagnosticSubject,
    resource: TextureResource,
    value: unknown
): { width: number, height: number, depthOrArrayLayers: number } {

    let width: unknown
    let height: unknown
    let depthOrArrayLayers: unknown
    if (Array.isArray(value)) {
        width = value[0]
        height = value[1] ?? 1
        depthOrArrayLayers = value[2] ?? 1
    } else if (isRecord(value)) {
        width = value.width
        height = value.height ?? 1
        depthOrArrayLayers = value.depthOrArrayLayers ?? 1
    } else {
        return throwTextureReadbackSourceInvalid(subject, resource, value, 'size')
    }
    if (![ width, height, depthOrArrayLayers ].every(dimension =>
        Number.isInteger(dimension) && (dimension as number) > 0
    )) {
        return throwTextureReadbackSourceInvalid(subject, resource, value, 'size')
    }
    return {
        width: width as number,
        height: height as number,
        depthOrArrayLayers: depthOrArrayLayers as number,
    }
}

function normalizeAspect(
    subject: DiagnosticSubject,
    resource: TextureResource,
    value: unknown
): GPUTextureAspect {

    const aspect = value ?? 'all'
    if (![ 'all', 'depth-only', 'stencil-only' ].includes(aspect as string)) {
        return throwTextureReadbackSourceInvalid(subject, resource, value, 'aspect')
    }
    return aspect as GPUTextureAspect
}

function normalizeInterpretation(
    subject: DiagnosticSubject,
    resource: TextureResource,
    value: unknown
): LayoutArtifact | undefined {

    if (value === undefined) return undefined
    if (!isLayoutArtifact(value)) {
        throwScratchDiagnostic({
            code: 'SCRATCH_READBACK_LAYOUT_INVALID',
            severity: 'error',
            phase: 'readback',
            subject,
            related: [ resource.subject ],
            message: 'Texture readback layout must be a Scratch LayoutArtifact.',
            expected: { layout: 'LayoutArtifact' },
            actual: { layout: describeValue(value) },
        })
    }
    return value
}

function textureMipExtent(
    texture: TextureResource,
    mipLevel: number
): { width: number, height: number, depthOrArrayLayers: number } {

    const blockSize = textureFormatBlockSize(texture.format)
    const logicalWidth = Math.max(1, texture.width >> mipLevel)
    const logicalHeight = Math.max(1, texture.height >> mipLevel)
    return {
        width: Math.ceil(logicalWidth / blockSize.width) * blockSize.width,
        height: Math.ceil(logicalHeight / blockSize.height) * blockSize.height,
        depthOrArrayLayers: texture.dimension === '3d'
            ? Math.max(1, texture.depthOrArrayLayers >> mipLevel)
            : texture.depthOrArrayLayers,
    }
}

function checkedProduct(
    subject: DiagnosticSubject,
    resource: TextureResource,
    left: number,
    right: number,
    field: string
): number {

    const result = left * right
    if (!Number.isSafeInteger(result) || result <= 0) {
        return throwTextureReadbackSourceInvalid(
            subject,
            resource,
            { left, right, result },
            field
        )
    }
    return result
}

function checkedRoundUp(
    subject: DiagnosticSubject,
    resource: TextureResource,
    value: number,
    alignment: number,
    field: string
): number {

    const result = Math.ceil(value / alignment) * alignment
    if (!Number.isSafeInteger(result) || result <= 0) {
        return throwTextureReadbackSourceInvalid(
            subject,
            resource,
            { value, alignment, result },
            field
        )
    }
    return result
}

function throwTextureReadbackSourceInvalid(
    subject: DiagnosticSubject,
    resource: TextureResource | undefined,
    actual: unknown,
    reason: string,
    normalized?: unknown
): never {

    throwScratchDiagnostic({
        code: 'SCRATCH_READBACK_TEXTURE_SOURCE_INVALID',
        severity: 'error',
        phase: 'readback',
        subject,
        related: resource === undefined ? [] : [ resource.subject ],
        message: 'Texture readback source does not describe a valid native texture-to-buffer copy.',
        expected: {
            resource: 'current TextureResource with GPUTextureUsage.COPY_SRC',
            mipLevel: 'valid non-negative mip index',
            origin: 'non-negative block-aligned texture origin',
            size: 'positive block-aligned extent within the physical subresource',
            aspect: 'one copyable texture aspect',
            sampleCount: 1,
        },
        actual: {
            reason,
            source: describeValue(actual),
            ...(normalized !== undefined ? { normalized } : {}),
        },
    })
}
