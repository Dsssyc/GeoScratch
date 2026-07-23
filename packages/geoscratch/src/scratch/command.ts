import { UUID } from '../core/utils/uuid.js'
import { BufferRegion, BufferResource, isBufferRegion } from './buffer.js'
import { isBindSet, preparedBindGroupFor } from './binding.js'
import { throwScratchDiagnostic } from './diagnostics.js'
import {
    describeLayoutCompatibilityDifference,
    isLayoutArtifact,
    isLayoutUploadView,
    layoutArtifactSubject,
    layoutArtifactsAbiCompatible,
    layoutArtifactsSchemaCompatible,
} from './layout-codec.js'
import { programLayoutRequirementExpected, programLayoutRequirementSubject } from './program.js'
import { isComputePipeline, isRenderPipeline, programLayoutRequirementsForPipeline } from './pipeline.js'
import { currentRenderPassAttachmentExtent } from './pass.js'
import { QuerySetResource, isQuerySetResource } from './query-set.js'
import {
    registerRuntimeReadbackCommand,
    releaseReservedRuntimeReadbackOperationFact,
    reserveRuntimeReadbackOperationFact,
    unregisterRuntimeReadbackCommand,
    updateReservedRuntimeReadbackOperationFact,
    updateRuntimeReadbackCommand,
} from './readback-ownership.js'
import {
    allocateReadbackStaging,
    readbackStagingBuffer,
    recordReadbackStagingRelease,
    releaseReadbackStaging,
    resetReadbackStaging,
} from './readback-staging.js'
import { readonlyMapSnapshot } from './readonly-map.js'
import { advanceResourceContentEpoch, isContentResource } from './resource.js'
import { assertScratchRuntimeActive } from './runtime-authority.js'
import {
    TextureResource,
    isTextureResource,
    textureFormatBlockSize,
    textureFormatCopyFootprint,
    textureFormatIsCompressed,
    textureFormatIsDepthStencil,
} from './texture.js'
import { describeValue, diagnosticSubjectOf, getGlobalConstant, isDefined, isRecord } from './type-utils.js'
import type { BindSet, NormalizedBindLayoutEntry } from './binding.js'
import type { DiagnosticSubject } from './diagnostics.js'
import type { ComputePassSpec, RenderPassSpec } from './pass.js'
import type { ComputePipeline, RenderPipeline } from './pipeline.js'
import type { LayoutArtifact, LayoutUploadView } from './layout-codec.js'
import type { ProgramBufferLayoutRequirement } from './program.js'
import type { ReadbackOperation, ReadbackRetentionPolicy } from './readback.js'
import type {
    ReadbackStagingCleanupFailure,
    ReadbackStagingCleanupResult,
    ReadbackStagingSlot,
} from './readback-staging.js'
import type { ScratchRuntime } from './runtime.js'
import type { ScratchReadbackCommandState } from './runtime-diagnostics.js'
import type { SubmittedWork } from './submission.js'

const GPU_BUFFER_USAGE_VERTEX = getGlobalConstant('GPUBufferUsage', 'VERTEX', 0x20)
const GPU_BUFFER_USAGE_INDEX = getGlobalConstant('GPUBufferUsage', 'INDEX', 0x10)
const GPU_BUFFER_USAGE_INDIRECT = getGlobalConstant('GPUBufferUsage', 'INDIRECT', 0x100)
const GPU_BUFFER_USAGE_COPY_SRC = getGlobalConstant('GPUBufferUsage', 'COPY_SRC', 0x4)
const GPU_BUFFER_USAGE_COPY_DST = getGlobalConstant('GPUBufferUsage', 'COPY_DST', 0x8)
const GPU_BUFFER_USAGE_QUERY_RESOLVE = getGlobalConstant('GPUBufferUsage', 'QUERY_RESOLVE', 0x200)
const GPU_TEXTURE_USAGE_COPY_SRC = getGlobalConstant('GPUTextureUsage', 'COPY_SRC', 0x1)
const GPU_TEXTURE_USAGE_COPY_DST = getGlobalConstant('GPUTextureUsage', 'COPY_DST', 0x2)
const GPU_TEXTURE_USAGE_RENDER_ATTACHMENT = getGlobalConstant('GPUTextureUsage', 'RENDER_ATTACHMENT', 0x10)
const GPU_SIZE_32_MAX = 0xffff_ffff
const GPU_SIGNED_OFFSET_32_MIN = -0x8000_0000
const GPU_SIGNED_OFFSET_32_MAX = 0x7fff_ffff
const DRAW_INDIRECT_BYTE_LENGTH = 16
const DRAW_INDEXED_INDIRECT_BYTE_LENGTH = 20
const DISPATCH_INDIRECT_BYTE_LENGTH = 12

const EXTERNAL_IMAGE_UPLOAD_BASE_FORMATS = new Set<GPUTextureFormat>([
    'r8unorm',
    'rg8unorm',
    'rgba8unorm',
    'rgba8unorm-srgb',
    'bgra8unorm',
    'r16float',
    'rg16float',
    'rgba16float',
    'r32float',
    'rg32float',
    'rgba32float',
    'rgb10a2unorm',
])

const EXTERNAL_IMAGE_UPLOAD_FEATURE_FORMATS = new Map<GPUTextureFormat, readonly string[]>([
    [ 'bgra8unorm-srgb', [ 'core-features-and-limits' ] ],
    [ 'rg11b10ufloat', [ 'rg11b10ufloat-renderable', 'texture-formats-tier1', 'texture-formats-tier2' ] ],
    [ 'r16unorm', [ 'texture-formats-tier1', 'texture-formats-tier2' ] ],
    [ 'rg16unorm', [ 'texture-formats-tier1', 'texture-formats-tier2' ] ],
    [ 'rgba16unorm', [ 'texture-formats-tier1', 'texture-formats-tier2' ] ],
])

type ExternalImageSourceKind =
    | 'ImageBitmap'
    | 'ImageData'
    | 'HTMLImageElement'
    | 'HTMLVideoElement'
    | 'VideoFrame'
    | 'HTMLCanvasElement'
    | 'OffscreenCanvas'

type ExternalImageSourceContract = {
    kind: ExternalImageSourceKind
    widthField: string
    heightField: string
    dimensionsAreContextSpecific: boolean
}

const EXTERNAL_IMAGE_SOURCE_CONTRACTS: readonly ExternalImageSourceContract[] = [
    { kind: 'ImageBitmap', widthField: 'width', heightField: 'height', dimensionsAreContextSpecific: false },
    { kind: 'ImageData', widthField: 'width', heightField: 'height', dimensionsAreContextSpecific: false },
    { kind: 'HTMLImageElement', widthField: 'naturalWidth', heightField: 'naturalHeight', dimensionsAreContextSpecific: false },
    { kind: 'HTMLVideoElement', widthField: 'videoWidth', heightField: 'videoHeight', dimensionsAreContextSpecific: false },
    { kind: 'VideoFrame', widthField: 'displayWidth', heightField: 'displayHeight', dimensionsAreContextSpecific: false },
    { kind: 'HTMLCanvasElement', widthField: 'width', heightField: 'height', dimensionsAreContextSpecific: true },
    { kind: 'OffscreenCanvas', widthField: 'width', heightField: 'height', dimensionsAreContextSpecific: true },
]

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] }

export type ResourceReadinessPolicy =
    | 'throw'
    | 'skip-command'
    | 'skip-pass'
    | 'use-fallback'

export type CommandReadinessDescriptor<FallbackCommand> =
    | {
        whenMissing: 'throw' | 'skip-command' | 'skip-pass'
        fallback?: never
    }
    | {
        whenMissing: 'use-fallback'
        fallback: FallbackCommand
    }

export type StaticDrawCount = {
    vertexCount: number
    instanceCount?: number
    firstVertex?: number
    firstInstance?: number
}

export type StaticIndexedDrawCount = {
    indexCount: number
    instanceCount?: number
    firstIndex?: number
    baseVertex?: number
    firstInstance?: number
}

export type IndirectCommandCount = {
    indirect: BufferRegion
}

type NormalizedIndirectCommandCount = {
    indirect: BufferRegion
}

export type DrawCount =
    | StaticDrawCount
    | StaticIndexedDrawCount
    | IndirectCommandCount

type StrictStaticDrawCount = StaticDrawCount & {
    indexCount?: never
    indirect?: never
}

type StrictStaticIndexedDrawCount = StaticIndexedDrawCount & {
    vertexCount?: never
    indirect?: never
}

type StrictIndirectDrawCount = IndirectCommandCount & {
    vertexCount?: never
    indexCount?: never
}

export type DrawVertexBufferBinding = {
    slot: number
    region: BufferRegion
}

export type DrawIndexBufferBinding = {
    region: BufferRegion
    format: GPUIndexFormat
}

export type DrawViewport = Readonly<{
    x: number
    y: number
    width: number
    height: number
    minDepth?: number
    maxDepth?: number
}>

export type DrawScissorRect = Readonly<{
    x: number
    y: number
    width: number
    height: number
}>

export type DrawRenderState = Readonly<{
    viewport?: 'full-attachment' | DrawViewport
    scissor?: 'full-attachment' | DrawScissorRect
    blendConstant?: Readonly<GPUColor>
    stencilReference?: number
}>

export type DrawRenderAttachmentExtent = Readonly<{
    width: number
    height: number
}>

export type CommandBindSetInvocation = Readonly<{
    set: BindSet
    dynamicOffsets?: Readonly<Record<string, number>>
}>

export type NormalizedDrawVertexBufferBinding = DrawVertexBufferBinding

export type NormalizedDrawIndexBufferBinding = DrawIndexBufferBinding

export type CommandResourceReadEpoch = number | 'current-at-step'

export type CommandResourceReadDescriptor = {
    readonly resource: BufferResource | TextureResource
    readonly contentEpoch: CommandResourceReadEpoch
}

export type BufferCopyCommandSourceDescriptor = {
    region: BufferRegion
    contentEpoch: number
}

export type TextureCopyCommandSourceDescriptor = {
    resource: TextureResource
    contentEpoch: number
}

export type CopyCommandSourceDescriptor =
    | BufferCopyCommandSourceDescriptor
    | TextureCopyCommandSourceDescriptor

export type QuerySetSlotReadDescriptor = Readonly<{
    index: number
    contentEpoch: number
}>

export type ResolveQuerySetSourceDescriptor = Readonly<{
    querySet: QuerySetResource
    slots: readonly QuerySetSlotReadDescriptor[]
}>

export type CommandResourceAccessDescriptor = {
    readonly read: readonly CommandResourceReadDescriptor[]
    readonly write: readonly (BufferResource | TextureResource)[]
}

export type CommandImmediateData = ArrayBuffer | ArrayBufferView | LayoutUploadView

type DrawCommandDescriptorBase = {
    label?: string
    pipeline: RenderPipeline
    immediateData?: CommandImmediateData
    bindSets?: CommandBindSetInvocation[]
    vertexBuffers?: DrawVertexBufferBinding[]
    renderState?: DrawRenderState
    resources: CommandResourceAccessDescriptor
}

export type NonIndexedDrawCommandDescriptor = DrawCommandDescriptorBase & CommandReadinessDescriptor<DrawCommand> & {
    indexBuffer?: never
    count: StrictStaticDrawCount | StrictIndirectDrawCount
}

export type IndexedDrawCommandDescriptor = DrawCommandDescriptorBase & CommandReadinessDescriptor<DrawCommand> & {
    indexBuffer: DrawIndexBufferBinding
    count: StrictStaticIndexedDrawCount | StrictIndirectDrawCount
}

export type DrawCommandDescriptor =
    | NonIndexedDrawCommandDescriptor
    | IndexedDrawCommandDescriptor

export type BeginOcclusionQueryCommandDescriptor = {
    label?: string
    querySet: QuerySetResource
    index: number
}

export type EndOcclusionQueryCommandDescriptor = {
    label?: string
}

export type UploadCommandDescriptor = {
    label?: string
    target: BufferRegion
    data: ArrayBuffer | ArrayBufferView | LayoutUploadView
    dataOffset?: number
    size?: number
}

export type ClearBufferCommandDescriptor = {
    label?: string
    target: BufferRegion
}

export type TexelCopyBufferLayout = {
    bytesPerRow: number
    rowsPerImage?: number
}

export type BufferToBufferCopyCommandDescriptor = {
    label?: string
    source: BufferCopyCommandSourceDescriptor
    target: BufferRegion
    whenMissing: 'throw'
}

export type TextureCopyOrigin = {
    x?: number
    y?: number
    z?: number
} | [number, number?, number?]

export type TextureCopySize = {
    width: number
    height: number
    depthOrArrayLayers?: number
} | [number, number] | [number, number, number]

export type TextureToTextureCopyCommandDescriptor = {
    label?: string
    source: TextureCopyCommandSourceDescriptor
    sourceOrigin?: TextureCopyOrigin
    sourceMipLevel?: number
    sourceAspect?: GPUTextureAspect
    target: TextureResource
    targetOrigin?: TextureCopyOrigin
    targetMipLevel?: number
    targetAspect?: GPUTextureAspect
    size: TextureCopySize
    whenMissing: 'throw'
}

export type BufferToTextureCopyCommandDescriptor = {
    label?: string
    source: BufferCopyCommandSourceDescriptor
    sourceLayout: TexelCopyBufferLayout
    target: TextureResource
    targetOrigin?: TextureCopyOrigin
    targetMipLevel?: number
    targetAspect?: GPUTextureAspect
    size: TextureCopySize
    whenMissing: 'throw'
}

export type TextureToBufferCopyCommandDescriptor = {
    label?: string
    source: TextureCopyCommandSourceDescriptor
    sourceOrigin?: TextureCopyOrigin
    sourceMipLevel?: number
    sourceAspect?: GPUTextureAspect
    target: BufferRegion
    targetLayout: TexelCopyBufferLayout
    size: TextureCopySize
    whenMissing: 'throw'
}

export type CopyCommandDescriptor =
    | BufferToBufferCopyCommandDescriptor
    | TextureToTextureCopyCommandDescriptor
    | BufferToTextureCopyCommandDescriptor
    | TextureToBufferCopyCommandDescriptor

export type ReadbackCommandDescriptor = {
    label?: string
    source: BufferCopyCommandSourceDescriptor
    retain?: ReadbackRetentionPolicy
    whenMissing: 'throw'
}

export type ReadbackCommandResultOptions = {
    after: SubmittedWork
}

export type ResolveQuerySetCommandDescriptor = {
    label?: string
    source: ResolveQuerySetSourceDescriptor
    destination: BufferRegion
    whenMissing: 'throw'
}

export type TextureUploadOrigin = {
    x?: number
    y?: number
    z?: number
} | [number, number?, number?]

export type TextureUploadSize = {
    width: number
    height: number
    depthOrArrayLayers?: number
} | [number, number] | [number, number, number]

export type TextureUploadLayout = {
    offset?: number
    bytesPerRow?: number
    rowsPerImage?: number
}

export type TextureUploadCommandDescriptor = {
    label?: string
    target: TextureResource
    data: ArrayBuffer | ArrayBufferView
    layout?: TextureUploadLayout
    size: TextureUploadSize
    origin?: TextureUploadOrigin
    mipLevel?: number
}

export type ExternalImageUploadSourceOrigin = {
    x?: number
    y?: number
} | [number, number?]

export type ExternalImageUploadSize = {
    width: number
    height: number
} | [number, number]

export type ExternalImageUploadCommandDescriptor = {
    label?: string
    source: GPUCopyExternalImageSource
    sourceOrigin?: ExternalImageUploadSourceOrigin
    flipY?: boolean
    target: TextureResource
    origin?: TextureUploadOrigin
    mipLevel?: number
    colorSpace?: PredefinedColorSpace
    premultipliedAlpha?: boolean
    size: ExternalImageUploadSize
}

export type StaticDispatchCount = {
    workgroups: [number] | [number, number] | [number, number, number]
}

export type DispatchCount = StaticDispatchCount | IndirectCommandCount

type StrictStaticDispatchCount = StaticDispatchCount & {
    indirect?: never
}

type StrictIndirectDispatchCount = IndirectCommandCount & {
    workgroups?: never
}

type DispatchCommandDescriptorBase = {
    label?: string
    pipeline: ComputePipeline
    immediateData?: CommandImmediateData
    bindSets?: CommandBindSetInvocation[]
    count: StrictStaticDispatchCount | StrictIndirectDispatchCount
    resources: CommandResourceAccessDescriptor
}

export type DispatchCommandDescriptor = DispatchCommandDescriptorBase & CommandReadinessDescriptor<DispatchCommand>

type StaticDrawCountOptionalKey = Exclude<keyof StaticDrawCount, 'vertexCount'>

type StaticIndexedDrawCountOptionalKey = Exclude<keyof StaticIndexedDrawCount, 'indexCount'>

type IndirectBufferDiagnosticDetails = {
    expected: unknown
    actual: Record<string, unknown>
    related?: DiagnosticSubject[]
}

type OcclusionQueryCommandDiagnosticInput = {
    runtime?: ScratchRuntime
    querySet?: unknown
    index?: unknown
    reason: string
}

type CopyDiagnosticInput = {
    runtime?: ScratchRuntime
    source?: unknown
    target?: unknown
    sourceLayout?: unknown
    targetLayout?: unknown
    sourceOrigin?: unknown
    targetOrigin?: unknown
    sourceMipLevel?: unknown
    targetMipLevel?: unknown
    sourceAspect?: unknown
    targetAspect?: unknown
    size?: unknown
    reason: string
}

type CopySourceDiagnosticInput = {
    runtime?: ScratchRuntime
    source?: unknown
    target?: unknown
    sourceLayout?: unknown
    targetLayout?: unknown
    sourceOrigin?: unknown
    targetOrigin?: unknown
    sourceMipLevel?: unknown
    targetMipLevel?: unknown
    sourceAspect?: unknown
    targetAspect?: unknown
    size?: unknown
    reason: string
}

type ResolveQuerySetDiagnosticInput = {
    runtime?: ScratchRuntime
    source?: unknown
    querySet?: unknown
    slots?: unknown
    firstQuery?: unknown
    queryCount?: unknown
    destination?: unknown
    destinationOffset?: unknown
    whenMissing?: unknown
    legacyInputs?: string[]
    reason: string
}

type UploadDiagnosticInput = {
    runtime?: ScratchRuntime
    target?: unknown
    data?: unknown
    offset?: unknown
    dataOffset?: unknown
    size?: unknown
    layout?: unknown
    reason: string
}

type TextureUploadDiagnosticInput = {
    runtime?: ScratchRuntime
    target?: unknown
    data?: unknown
    layout?: unknown
    origin?: unknown
    size?: unknown
    mipLevel?: unknown
    reason: string
}

type ExternalImageUploadDiagnosticInput = {
    command?: ExternalImageUploadCommand
    runtime?: ScratchRuntime
    source?: unknown
    sourceOrigin?: unknown
    sourceDimensions?: unknown
    flipY?: unknown
    target?: unknown
    origin?: unknown
    mipLevel?: unknown
    colorSpace?: unknown
    premultipliedAlpha?: unknown
    size?: unknown
    requiredFeatures?: readonly string[]
    nativeError?: Record<string, unknown>
    reason: string
}

type ExternalImageDimensions = {
    width: number
    height: number
    fields: string
}

type ExternalImageSourceInspection = {
    dimensions?: {
        width: unknown
        height: unknown
        fields: string
    }
}

type VertexBufferDiagnosticDetails = {
    expected: unknown
    actual: unknown
    related?: DiagnosticSubject[]
}

type NormalizedUploadSource = {
    data: ArrayBuffer | ArrayBufferView
    dataOffset: number
    byteLength?: number
    layout?: LayoutArtifact
}

type CommandBrand =
    | 'draw'
    | 'begin-occlusion-query'
    | 'end-occlusion-query'
    | 'dispatch'
    | 'buffer-upload'
    | 'clear'
    | 'copy'
    | 'readback'
    | 'resolve-query-set'
    | 'texture-upload'
    | 'external-image-upload'

const commandBrands = new WeakMap<object, CommandBrand>()

type CommandImmediateSourceKind =
    | 'array-buffer'
    | 'array-buffer-view'
    | 'layout-upload-view'

type CommandImmediateDataState =
    | Readonly<{
        sourceKind: 'none'
        expectedByteLength: 0
    }>
    | Readonly<{
        sourceKind: CommandImmediateSourceKind
        expectedByteLength: number
        source: CommandImmediateData
        byteStorage: ArrayBufferLike
        byteOffset: number
        visibleByteLength: number
        byteView?: ArrayBufferView
        layoutArtifact?: LayoutArtifact
    }>

export type ResolvedCommandImmediateData = Readonly<{
    sourceKind: 'none' | CommandImmediateSourceKind
    expectedByteLength: number
    visibleByteLength: number
    bytes?: Uint8Array
}>

const commandImmediateDataStates = new WeakMap<object, CommandImmediateDataState>()

export interface DrawCommand {
    readonly runtime: ScratchRuntime
    readonly id: string
    readonly label?: string
    readonly commandKind: 'draw'
    readonly pipeline: RenderPipeline
    readonly immediateData?: CommandImmediateData
    readonly bindSets: readonly CommandBindSetInvocation[]
    readonly vertexBuffers: readonly Readonly<NormalizedDrawVertexBufferBinding>[]
    readonly indexBuffer?: Readonly<NormalizedDrawIndexBufferBinding>
    readonly renderState: DrawRenderState
    readonly count: Readonly<StaticDrawCount> | Readonly<StaticIndexedDrawCount> | Readonly<NormalizedIndirectCommandCount>
    readonly resources: CommandResourceAccessDescriptor
    readonly whenMissing: ResourceReadinessPolicy
    readonly fallback?: DrawCommand
}

export class DrawCommand {

    readonly #producesDeclaredWrites: boolean
    #isDisposed = false

    constructor(runtime: ScratchRuntime, descriptor: DrawCommandDescriptor = {} as DrawCommandDescriptor) {

        assertScratchRuntimeActive(runtime)

        const pipeline: unknown = descriptor.pipeline
        if (!isRenderPipeline(pipeline)) {
            throwScratchDiagnostic({
                code: 'SCRATCH_COMMAND_DECLARED_ACCESS_INCOMPLETE',
                severity: 'error',
                phase: 'command',
                subject: { kind: 'Command', commandKind: 'draw' },
                message: 'DrawCommand requires a render pipeline.',
                expected: { pipeline: 'RenderPipeline' },
                actual: {
                    pipeline: pipeline === undefined || pipeline === null ? String(pipeline) : typeof pipeline,
                    pipelineKind: isRecord(pipeline) ? pipeline.pipelineKind : undefined,
                },
            })
        }

        pipeline.assertRuntime(runtime)

        const mutable = this as Mutable<DrawCommand>
        mutable.runtime = runtime
        mutable.id = `scratch-command-${UUID()}`
        if (descriptor.label !== undefined) mutable.label = descriptor.label
        mutable.commandKind = 'draw'
        mutable.pipeline = pipeline
        const immediateData = normalizeCommandImmediateData(
            this,
            pipeline.immediateSize,
            descriptor.immediateData
        )
        if (immediateData !== undefined) mutable.immediateData = immediateData
        rejectRemovedCommandDynamicOffsets(this, descriptor)
        mutable.bindSets = normalizeBindSetInvocations(this, descriptor.bindSets)
        mutable.vertexBuffers = normalizeVertexBuffers(this, descriptor.vertexBuffers)
        const indexBuffer = normalizeIndexBuffer(this, descriptor.indexBuffer)
        if (indexBuffer !== undefined) mutable.indexBuffer = indexBuffer
        mutable.renderState = normalizeDrawRenderState(this, descriptor.renderState)
        mutable.count = normalizeDrawCount(this, descriptor.count, indexBuffer)
        this.#producesDeclaredWrites = drawCountProducesDeclaredWrites(mutable.count)
        mutable.resources = normalizeResourceAccess(this, descriptor.resources)
        validateDrawFixedFunctionReads(this)
        validateBoundResourceAccess(this)
        const readiness = normalizeReadinessContract(this, descriptor.whenMissing, descriptor.fallback)
        mutable.whenMissing = readiness.whenMissing
        if (readiness.fallback !== undefined) mutable.fallback = readiness.fallback
        validateProgramLayoutRequirementsForCommand(this)
        commandBrands.set(this, 'draw')
        lockDrawCommandContract(this)
    }

    get subject(): DiagnosticSubject {

        const subject: DiagnosticSubject = {
            kind: 'Command',
            id: this.id,
            commandKind: 'draw',
        }
        if (this.label !== undefined) subject.label = this.label

        return subject
    }

    get _producesDeclaredWrites(): boolean {

        return this.#producesDeclaredWrites
    }

    get isDisposed(): boolean {

        return this.#isDisposed
    }

    assertRuntime(runtime: ScratchRuntime) {

        this.assertUsable()

        if (runtime !== this.runtime) {
            throwScratchDiagnostic({
                code: 'SCRATCH_COMMAND_WRONG_RUNTIME',
                severity: 'error',
                phase: 'command',
                subject: this.subject,
                related: [
                    this.runtime.subject,
                    runtime?.subject,
                ].filter(Boolean),
                message: 'Command belongs to a different ScratchRuntime.',
                expected: { runtimeId: this.runtime.id },
                actual: { runtimeId: runtime?.id },
            })
        }
    }

    assertUsable() {

        if (this.isDisposed) {
            throwScratchDiagnostic({
                code: 'SCRATCH_COMMAND_DISPOSED',
                severity: 'error',
                phase: 'command',
                subject: this.subject,
                message: 'Command has been disposed.',
            })
        }

        assertScratchRuntimeActive(this.runtime)
        this.pipeline.assertUsable()
        for (const invocation of this.bindSets) {
            invocation.set.assertUsable()
        }
        validateCurrentDynamicOffsets(this)
        for (const binding of this.vertexBuffers) {
            validateCurrentVertexBufferBinding(this, binding)
        }
        if (this.indexBuffer !== undefined) {
            validateCurrentIndexBufferBinding(this, this.indexBuffer)
            if ('indexCount' in this.count) {
                validateStaticIndexedDrawRange(this, this.count, this.indexBuffer)
            }
        }
        if ('indirect' in this.count) {
            validateCurrentIndirectCommandRegion(
                this,
                this.count.indirect,
                this.indexBuffer === undefined ? DRAW_INDIRECT_BYTE_LENGTH : DRAW_INDEXED_INDIRECT_BYTE_LENGTH,
                this.indexBuffer === undefined ? 'draw' : 'draw-indexed'
            )
        }
        for (const resource of [
            ...this.resources.read.map(read => read.resource),
            ...this.resources.write,
        ]) {
            resource.assertUsable()
        }
    }

    validateForPass(passSpec: RenderPassSpec) {

        this.assertUsable()

        if (passSpec.passKind !== 'render') {
            throwScratchDiagnostic({
                code: 'SCRATCH_COMMAND_PASS_KIND_MISMATCH',
                severity: 'error',
                phase: 'command',
                subject: this.subject,
                related: [
                    passSpec.subject,
                    this.pipeline.subject,
                ].filter(Boolean),
                message: 'DrawCommand can only be recorded into a render pass.',
                expected: { passKind: 'render' },
                actual: { passKind: passSpec.passKind },
            })
        }

        resolveDrawRenderState(this, currentRenderPassAttachmentExtent(passSpec))
    }

    encode(
        passEncoder: GPURenderPassEncoder,
        attachmentExtent: DrawRenderAttachmentExtent,
        resolvedImmediateData?: ResolvedCommandImmediateData
    ) {

        this.assertUsable()
        const renderState = resolveDrawRenderState(this, attachmentExtent)
        const immediateBytes = resolvedImmediateBytesForEncoding(this, resolvedImmediateData)

        passEncoder.setPipeline(this.pipeline.gpuPipeline)
        setPassEncoderImmediates(passEncoder, immediateBytes)
        passEncoder.setViewport(
            renderState.viewport.x,
            renderState.viewport.y,
            renderState.viewport.width,
            renderState.viewport.height,
            renderState.viewport.minDepth,
            renderState.viewport.maxDepth
        )
        passEncoder.setScissorRect(
            renderState.scissor.x,
            renderState.scissor.y,
            renderState.scissor.width,
            renderState.scissor.height
        )
        passEncoder.setBlendConstant(renderState.blendConstant)
        passEncoder.setStencilReference(renderState.stencilReference)
        for (const binding of this.vertexBuffers) {
            passEncoder.setVertexBuffer(
                binding.slot,
                binding.region.buffer.gpuBuffer,
                binding.region.offset,
                binding.region.size
            )
        }
        if (this.indexBuffer !== undefined) {
            passEncoder.setIndexBuffer(
                this.indexBuffer.region.buffer.gpuBuffer,
                this.indexBuffer.format,
                this.indexBuffer.region.offset,
                this.indexBuffer.region.size
            )
        }
        for (const invocation of this.bindSets) {
            setBindGroupWithDynamicOffsets(this, passEncoder, invocation)
        }
        if ('indexCount' in this.count) {
            passEncoder.drawIndexed(
                this.count.indexCount,
                this.count.instanceCount ?? 1,
                this.count.firstIndex ?? 0,
                this.count.baseVertex ?? 0,
                this.count.firstInstance ?? 0
            )
        } else if ('vertexCount' in this.count) {
            passEncoder.draw(
                this.count.vertexCount,
                this.count.instanceCount ?? 1,
                this.count.firstVertex ?? 0,
                this.count.firstInstance ?? 0
            )
        } else if (this.indexBuffer === undefined) {
            passEncoder.drawIndirect(this.count.indirect.buffer.gpuBuffer, this.count.indirect.offset)
        } else {
            passEncoder.drawIndexedIndirect(this.count.indirect.buffer.gpuBuffer, this.count.indirect.offset)
        }
        if (this._producesDeclaredWrites) {
            for (const resource of this.resources.write) {
                advanceResourceContentEpoch(resource)
            }
        }
    }

    dispose(): void {

        this.#isDisposed = true
    }
}

export interface BeginOcclusionQueryCommand {
    readonly runtime: ScratchRuntime
    readonly id: string
    readonly label?: string
    readonly commandKind: 'begin-occlusion-query'
    readonly querySet: QuerySetResource
    readonly index: number
}

export class BeginOcclusionQueryCommand {

    #isDisposed = false

    constructor(runtime: ScratchRuntime, descriptor: BeginOcclusionQueryCommandDescriptor = {} as BeginOcclusionQueryCommandDescriptor) {

        assertScratchRuntimeActive(runtime)

        const querySet = descriptor.querySet
        if (!isQuerySetResource(querySet)) {
            throwOcclusionQueryCommandDiagnostic({
                runtime,
                querySet,
                index: descriptor.index,
                reason: 'querySet',
            })
        }

        querySet.assertRuntime(runtime)

        if (querySet.type !== 'occlusion') {
            throwOcclusionQueryCommandDiagnostic({
                runtime,
                querySet,
                index: descriptor.index,
                reason: 'querySetType',
            })
        }

        const mutable = this as Mutable<BeginOcclusionQueryCommand>
        mutable.runtime = runtime
        mutable.id = `scratch-command-${UUID()}`
        if (descriptor.label !== undefined) mutable.label = descriptor.label
        mutable.commandKind = 'begin-occlusion-query'
        mutable.querySet = querySet
        mutable.index = normalizeOcclusionQueryIndex(runtime, querySet, descriptor.index)
        commandBrands.set(this, 'begin-occlusion-query')
        lockCommandProperties(this, [ 'runtime', 'id', 'label', 'commandKind', 'querySet', 'index' ])
        Object.preventExtensions(this)
    }

    get subject(): DiagnosticSubject {

        const subject: DiagnosticSubject = {
            kind: 'Command',
            id: this.id,
            commandKind: 'begin-occlusion-query',
        }
        if (this.label !== undefined) subject.label = this.label

        return subject
    }

    get isDisposed(): boolean {

        return this.#isDisposed
    }

    assertRuntime(runtime: ScratchRuntime) {

        this.assertUsable()

        if (runtime !== this.runtime) {
            throwScratchDiagnostic({
                code: 'SCRATCH_COMMAND_WRONG_RUNTIME',
                severity: 'error',
                phase: 'command',
                subject: this.subject,
                related: [
                    this.runtime.subject,
                    runtime?.subject,
                ].filter(Boolean),
                message: 'Command belongs to a different ScratchRuntime.',
                expected: { runtimeId: this.runtime.id },
                actual: { runtimeId: runtime?.id },
            })
        }
    }

    assertUsable() {

        if (this.#isDisposed) {
            throwScratchDiagnostic({
                code: 'SCRATCH_COMMAND_DISPOSED',
                severity: 'error',
                phase: 'command',
                subject: this.subject,
                message: 'Command has been disposed.',
            })
        }

        assertScratchRuntimeActive(this.runtime)
        this.querySet.assertUsable()
    }

    validateForPass(passSpec: RenderPassSpec) {

        this.assertUsable()

        if (passSpec.passKind !== 'render') {
            throwScratchDiagnostic({
                code: 'SCRATCH_COMMAND_PASS_KIND_MISMATCH',
                severity: 'error',
                phase: 'command',
                subject: this.subject,
                related: [
                    passSpec.subject,
                    this.querySet.subject,
                ].filter(Boolean),
                message: 'BeginOcclusionQueryCommand can only be recorded into a render pass.',
                expected: { passKind: 'render' },
                actual: { passKind: passSpec.passKind },
            })
        }
    }

    encode(passEncoder: GPURenderPassEncoder) {

        this.assertUsable()

        if (!passEncoder || typeof passEncoder.beginOcclusionQuery !== 'function') {
            throwScratchDiagnostic({
                code: 'SCRATCH_RUNTIME_DEVICE_UNAVAILABLE',
                severity: 'error',
                phase: 'runtime',
                subject: this.runtime.subject,
                related: [ this.subject ],
                message: 'ScratchRuntime render pass encoder cannot begin occlusion queries.',
                expected: { passEncoder: 'GPURenderPassEncoder with beginOcclusionQuery()' },
                actual: { beginOcclusionQuery: typeof passEncoder?.beginOcclusionQuery },
            })
        }

        passEncoder.beginOcclusionQuery(this.index)
    }

    dispose(): void {

        this.#isDisposed = true
    }
}

export interface EndOcclusionQueryCommand {
    readonly runtime: ScratchRuntime
    readonly id: string
    readonly label?: string
    readonly commandKind: 'end-occlusion-query'
}

export class EndOcclusionQueryCommand {

    #isDisposed = false

    constructor(runtime: ScratchRuntime, descriptor: EndOcclusionQueryCommandDescriptor = {}) {

        assertScratchRuntimeActive(runtime)

        const mutable = this as Mutable<EndOcclusionQueryCommand>
        mutable.runtime = runtime
        mutable.id = `scratch-command-${UUID()}`
        if (descriptor.label !== undefined) mutable.label = descriptor.label
        mutable.commandKind = 'end-occlusion-query'
        commandBrands.set(this, 'end-occlusion-query')
        lockCommandProperties(this, [ 'runtime', 'id', 'label', 'commandKind' ])
        Object.preventExtensions(this)
    }

    get subject(): DiagnosticSubject {

        const subject: DiagnosticSubject = {
            kind: 'Command',
            id: this.id,
            commandKind: 'end-occlusion-query',
        }
        if (this.label !== undefined) subject.label = this.label

        return subject
    }

    get isDisposed(): boolean {

        return this.#isDisposed
    }

    assertRuntime(runtime: ScratchRuntime) {

        this.assertUsable()

        if (runtime !== this.runtime) {
            throwScratchDiagnostic({
                code: 'SCRATCH_COMMAND_WRONG_RUNTIME',
                severity: 'error',
                phase: 'command',
                subject: this.subject,
                related: [
                    this.runtime.subject,
                    runtime?.subject,
                ].filter(Boolean),
                message: 'Command belongs to a different ScratchRuntime.',
                expected: { runtimeId: this.runtime.id },
                actual: { runtimeId: runtime?.id },
            })
        }
    }

    assertUsable() {

        if (this.#isDisposed) {
            throwScratchDiagnostic({
                code: 'SCRATCH_COMMAND_DISPOSED',
                severity: 'error',
                phase: 'command',
                subject: this.subject,
                message: 'Command has been disposed.',
            })
        }

        assertScratchRuntimeActive(this.runtime)
    }

    validateForPass(passSpec: RenderPassSpec) {

        this.assertUsable()

        if (passSpec.passKind !== 'render') {
            throwScratchDiagnostic({
                code: 'SCRATCH_COMMAND_PASS_KIND_MISMATCH',
                severity: 'error',
                phase: 'command',
                subject: this.subject,
                related: [
                    passSpec.subject,
                ].filter(Boolean),
                message: 'EndOcclusionQueryCommand can only be recorded into a render pass.',
                expected: { passKind: 'render' },
                actual: { passKind: passSpec.passKind },
            })
        }
    }

    encode(passEncoder: GPURenderPassEncoder) {

        this.assertUsable()

        if (!passEncoder || typeof passEncoder.endOcclusionQuery !== 'function') {
            throwScratchDiagnostic({
                code: 'SCRATCH_RUNTIME_DEVICE_UNAVAILABLE',
                severity: 'error',
                phase: 'runtime',
                subject: this.runtime.subject,
                related: [ this.subject ],
                message: 'ScratchRuntime render pass encoder cannot end occlusion queries.',
                expected: { passEncoder: 'GPURenderPassEncoder with endOcclusionQuery()' },
                actual: { endOcclusionQuery: typeof passEncoder?.endOcclusionQuery },
            })
        }

        passEncoder.endOcclusionQuery()
    }

    dispose(): void {

        this.#isDisposed = true
    }
}

export interface DispatchCommand {
    readonly runtime: ScratchRuntime
    readonly id: string
    readonly label?: string
    readonly commandKind: 'dispatch'
    readonly pipeline: ComputePipeline
    readonly immediateData?: CommandImmediateData
    readonly bindSets: readonly CommandBindSetInvocation[]
    readonly count: Readonly<{ workgroups: readonly [number, number, number] }> | Readonly<NormalizedIndirectCommandCount>
    readonly resources: CommandResourceAccessDescriptor
    readonly whenMissing: ResourceReadinessPolicy
    readonly fallback?: DispatchCommand
}

export class DispatchCommand {

    readonly #producesDeclaredWrites: boolean
    #isDisposed = false

    constructor(runtime: ScratchRuntime, descriptor: DispatchCommandDescriptor = {} as DispatchCommandDescriptor) {

        assertScratchRuntimeActive(runtime)

        const pipeline: unknown = descriptor.pipeline
        if (!isComputePipeline(pipeline)) {
            throwScratchDiagnostic({
                code: 'SCRATCH_COMMAND_DECLARED_ACCESS_INCOMPLETE',
                severity: 'error',
                phase: 'command',
                subject: { kind: 'Command', commandKind: 'dispatch' },
                message: 'DispatchCommand requires a compute pipeline.',
                expected: { pipeline: 'ComputePipeline' },
                actual: { pipeline: pipeline === undefined || pipeline === null ? String(pipeline) : typeof pipeline },
            })
        }

        pipeline.assertRuntime(runtime)

        const mutable = this as Mutable<DispatchCommand>
        mutable.runtime = runtime
        mutable.id = `scratch-command-${UUID()}`
        if (descriptor.label !== undefined) mutable.label = descriptor.label
        mutable.commandKind = 'dispatch'
        mutable.pipeline = pipeline
        const immediateData = normalizeCommandImmediateData(
            this,
            pipeline.immediateSize,
            descriptor.immediateData
        )
        if (immediateData !== undefined) mutable.immediateData = immediateData
        rejectRemovedCommandDynamicOffsets(this, descriptor)
        mutable.bindSets = normalizeBindSetInvocations(this, descriptor.bindSets)
        mutable.count = normalizeDispatchCount(this, descriptor.count)
        this.#producesDeclaredWrites = dispatchCountProducesDeclaredWrites(mutable.count)
        mutable.resources = normalizeResourceAccess(this, descriptor.resources)
        validateDispatchFixedFunctionReads(this)
        validateBoundResourceAccess(this)
        const readiness = normalizeReadinessContract(this, descriptor.whenMissing, descriptor.fallback)
        mutable.whenMissing = readiness.whenMissing
        if (readiness.fallback !== undefined) mutable.fallback = readiness.fallback
        validateProgramLayoutRequirementsForCommand(this)
        commandBrands.set(this, 'dispatch')
        lockDispatchCommandContract(this)
    }

    get subject(): DiagnosticSubject {

        const subject: DiagnosticSubject = {
            kind: 'Command',
            id: this.id,
            commandKind: 'dispatch',
        }
        if (this.label !== undefined) subject.label = this.label

        return subject
    }

    get _producesDeclaredWrites(): boolean {

        return this.#producesDeclaredWrites
    }

    get isDisposed(): boolean {

        return this.#isDisposed
    }

    assertRuntime(runtime: ScratchRuntime) {

        this.assertUsable()

        if (runtime !== this.runtime) {
            throwScratchDiagnostic({
                code: 'SCRATCH_COMMAND_WRONG_RUNTIME',
                severity: 'error',
                phase: 'command',
                subject: this.subject,
                related: [
                    this.runtime.subject,
                    runtime?.subject,
                ].filter(Boolean),
                message: 'Command belongs to a different ScratchRuntime.',
                expected: { runtimeId: this.runtime.id },
                actual: { runtimeId: runtime?.id },
            })
        }
    }

    assertUsable() {

        if (this.isDisposed) {
            throwScratchDiagnostic({
                code: 'SCRATCH_COMMAND_DISPOSED',
                severity: 'error',
                phase: 'command',
                subject: this.subject,
                message: 'Command has been disposed.',
            })
        }

        assertScratchRuntimeActive(this.runtime)
        this.pipeline.assertUsable()
        for (const invocation of this.bindSets) {
            invocation.set.assertUsable()
        }
        validateCurrentDynamicOffsets(this)
        if ('indirect' in this.count) {
            validateCurrentIndirectCommandRegion(
                this,
                this.count.indirect,
                DISPATCH_INDIRECT_BYTE_LENGTH,
                'dispatch'
            )
        }
        for (const resource of [
            ...this.resources.read.map(read => read.resource),
            ...this.resources.write,
        ]) {
            resource.assertUsable()
        }
    }

    validateForPass(passSpec: ComputePassSpec) {

        this.assertUsable()

        if (passSpec.passKind !== 'compute') {
            throwScratchDiagnostic({
                code: 'SCRATCH_COMMAND_PASS_KIND_MISMATCH',
                severity: 'error',
                phase: 'command',
                subject: this.subject,
                related: [
                    passSpec.subject,
                    this.pipeline.subject,
                ].filter(Boolean),
                message: 'DispatchCommand can only be recorded into a compute pass.',
                expected: { passKind: 'compute' },
                actual: { passKind: passSpec.passKind },
            })
        }
    }

    encode(
        passEncoder: GPUComputePassEncoder,
        resolvedImmediateData?: ResolvedCommandImmediateData
    ) {

        this.assertUsable()
        const immediateBytes = resolvedImmediateBytesForEncoding(this, resolvedImmediateData)

        passEncoder.setPipeline(this.pipeline.gpuPipeline)
        setPassEncoderImmediates(passEncoder, immediateBytes)
        for (const invocation of this.bindSets) {
            setBindGroupWithDynamicOffsets(this, passEncoder, invocation)
        }
        if ('indirect' in this.count) {
            passEncoder.dispatchWorkgroupsIndirect(
                this.count.indirect.buffer.gpuBuffer,
                this.count.indirect.offset
            )
        } else {
            passEncoder.dispatchWorkgroups(
                this.count.workgroups[0],
                this.count.workgroups[1],
                this.count.workgroups[2]
            )
        }
        if (this._producesDeclaredWrites) {
            for (const resource of this.resources.write) {
                advanceResourceContentEpoch(resource)
            }
        }
    }

    dispose(): void {

        this.#isDisposed = true
    }
}

function normalizeCommandImmediateData(
    command: DrawCommand | DispatchCommand,
    expectedByteLength: number,
    immediateData: unknown
): CommandImmediateData | undefined {

    if (expectedByteLength === 0) {
        commandImmediateDataStates.set(command, Object.freeze({
            sourceKind: 'none',
            expectedByteLength: 0,
        }))
        if (immediateData === undefined) return undefined
        throwCommandImmediateDataDiagnostic(command, {
            expectedByteLength,
            immediateData,
            reason: 'forbidden-for-zero-sized-pipeline',
        })
    }

    if (immediateData === undefined) {
        throwCommandImmediateDataDiagnostic(command, {
            expectedByteLength,
            immediateData,
            reason: 'required',
        })
    }

    let isUploadView = false
    try {
        isUploadView = isLayoutUploadView(immediateData)
    } catch {
        throwCommandImmediateDataDiagnostic(command, {
            expectedByteLength,
            immediateData,
            reason: 'unstable-source-shape',
        })
    }

    let state: CommandImmediateDataState
    if (isUploadView) {
        const uploadView = immediateData as LayoutUploadView
        const immediateCompatible = (
            uploadView.artifact.usageCompatibility as Record<string, boolean>
        ).immediate === true
        if (!immediateCompatible) {
            throwCommandImmediateDataDiagnostic(command, {
                expectedByteLength,
                immediateData: uploadView,
                sourceKind: 'layout-upload-view',
                visibleByteLength: uploadView.byteLength,
                reason: 'layout-incompatible',
                layoutArtifact: uploadView.artifact,
            })
        }

        const range = readLayoutImmediateRange(command, uploadView, expectedByteLength)
        state = Object.freeze({
            sourceKind: 'layout-upload-view',
            expectedByteLength,
            source: uploadView,
            byteStorage: range.byteStorage,
            byteOffset: range.byteOffset,
            visibleByteLength: range.visibleByteLength,
            byteView: uploadView.bytes,
            layoutArtifact: uploadView.artifact,
        })
    } else if (immediateData instanceof ArrayBuffer) {
        const visibleByteLength = immediateData.byteLength
        validateImmediateVisibleByteLength(
            command,
            immediateData,
            'array-buffer',
            visibleByteLength,
            expectedByteLength
        )
        state = Object.freeze({
            sourceKind: 'array-buffer',
            expectedByteLength,
            source: immediateData,
            byteStorage: immediateData,
            byteOffset: 0,
            visibleByteLength,
        })
    } else if (ArrayBuffer.isView(immediateData)) {
        let byteStorage: ArrayBufferLike
        let byteOffset: number
        let visibleByteLength: number
        try {
            byteStorage = immediateData.buffer
            byteOffset = immediateData.byteOffset
            visibleByteLength = immediateData.byteLength
        } catch {
            throwCommandImmediateDataDiagnostic(command, {
                expectedByteLength,
                immediateData,
                sourceKind: 'array-buffer-view',
                reason: 'unreadable-source',
            })
        }
        validateImmediateVisibleByteLength(
            command,
            immediateData,
            'array-buffer-view',
            visibleByteLength,
            expectedByteLength
        )
        state = Object.freeze({
            sourceKind: 'array-buffer-view',
            expectedByteLength,
            source: immediateData,
            byteStorage,
            byteOffset,
            visibleByteLength,
            byteView: immediateData,
        })
    } else {
        throwCommandImmediateDataDiagnostic(command, {
            expectedByteLength,
            immediateData,
            reason: 'unsupported-source',
        })
    }

    commandImmediateDataStates.set(command, state)
    return immediateData as CommandImmediateData
}

export function snapshotCommandImmediateData(
    command: DrawCommand | DispatchCommand
): ResolvedCommandImmediateData {

    const state = commandImmediateDataStates.get(command)
    if (state === undefined) {
        throw new TypeError('Command immediate-data state is unavailable.')
    }
    if (state.sourceKind === 'none') {
        return Object.freeze({
            sourceKind: 'none',
            expectedByteLength: 0,
            visibleByteLength: 0,
        })
    }

    const current = readCurrentImmediateRange(command, state)
    validateImmediateVisibleByteLength(
        command,
        state.source,
        state.sourceKind,
        current.visibleByteLength,
        state.expectedByteLength,
        state.layoutArtifact
    )

    let bytes: Uint8Array
    try {
        bytes = Uint8Array.from(new Uint8Array(
            current.byteStorage,
            current.byteOffset,
            current.visibleByteLength
        ))
    } catch {
        throwCommandImmediateDataDiagnostic(command, {
            expectedByteLength: state.expectedByteLength,
            immediateData: state.source,
            sourceKind: state.sourceKind,
            visibleByteLength: current.visibleByteLength,
            reason: 'snapshot-failed',
            layoutArtifact: state.layoutArtifact,
        })
    }

    if (bytes.byteLength !== state.expectedByteLength) {
        throwCommandImmediateDataDiagnostic(command, {
            expectedByteLength: state.expectedByteLength,
            immediateData: state.source,
            sourceKind: state.sourceKind,
            visibleByteLength: bytes.byteLength,
            reason: 'snapshot-length-changed',
            layoutArtifact: state.layoutArtifact,
        })
    }

    return Object.freeze({
        sourceKind: state.sourceKind,
        expectedByteLength: state.expectedByteLength,
        visibleByteLength: bytes.byteLength,
        bytes,
    })
}

function readLayoutImmediateRange(
    command: DrawCommand | DispatchCommand,
    uploadView: LayoutUploadView,
    expectedByteLength: number
): Readonly<{
    byteStorage: ArrayBufferLike
    byteOffset: number
    visibleByteLength: number
}> {

    let byteStorage: ArrayBufferLike
    let bytesOffset: number
    let bytesLength: number
    try {
        byteStorage = uploadView.bytes.buffer
        bytesOffset = uploadView.bytes.byteOffset
        bytesLength = uploadView.bytes.byteLength
    } catch {
        throwCommandImmediateDataDiagnostic(command, {
            expectedByteLength,
            immediateData: uploadView,
            sourceKind: 'layout-upload-view',
            reason: 'unreadable-source',
            layoutArtifact: uploadView.artifact,
        })
    }

    const byteOffset = uploadView.byteOffset
    const visibleByteLength = uploadView.byteLength
    if (
        !Number.isSafeInteger(byteOffset) ||
        !Number.isSafeInteger(visibleByteLength) ||
        byteOffset < bytesOffset ||
        visibleByteLength < 0 ||
        byteOffset + visibleByteLength > bytesOffset + bytesLength
    ) {
        throwCommandImmediateDataDiagnostic(command, {
            expectedByteLength,
            immediateData: uploadView,
            sourceKind: 'layout-upload-view',
            visibleByteLength,
            reason: 'invalid-visible-range',
            layoutArtifact: uploadView.artifact,
        })
    }
    validateImmediateVisibleByteLength(
        command,
        uploadView,
        'layout-upload-view',
        visibleByteLength,
        expectedByteLength,
        uploadView.artifact
    )
    return Object.freeze({ byteStorage, byteOffset, visibleByteLength })
}

function readCurrentImmediateRange(
    command: DrawCommand | DispatchCommand,
    state: Exclude<CommandImmediateDataState, { sourceKind: 'none' }>
): Readonly<{
    byteStorage: ArrayBufferLike
    byteOffset: number
    visibleByteLength: number
}> {

    if (state.sourceKind === 'array-buffer') {
        let visibleByteLength: number
        try {
            visibleByteLength = (state.source as ArrayBuffer).byteLength
        } catch {
            throwCommandImmediateDataDiagnostic(command, {
                expectedByteLength: state.expectedByteLength,
                immediateData: state.source,
                sourceKind: state.sourceKind,
                reason: 'unreadable-source',
            })
        }
        return Object.freeze({
            byteStorage: state.byteStorage,
            byteOffset: 0,
            visibleByteLength,
        })
    }

    const byteView = state.byteView!
    let byteStorage: ArrayBufferLike
    let viewByteOffset: number
    let viewByteLength: number
    try {
        byteStorage = byteView.buffer
        viewByteOffset = byteView.byteOffset
        viewByteLength = byteView.byteLength
    } catch {
        throwCommandImmediateDataDiagnostic(command, {
            expectedByteLength: state.expectedByteLength,
            immediateData: state.source,
            sourceKind: state.sourceKind,
            reason: 'unreadable-source',
            layoutArtifact: state.layoutArtifact,
        })
    }

    const rangeIsCurrent = byteStorage === state.byteStorage && (
        state.sourceKind === 'array-buffer-view'
            ? viewByteOffset === state.byteOffset &&
                viewByteLength === state.visibleByteLength
            : state.byteOffset >= viewByteOffset &&
                state.byteOffset + state.visibleByteLength <= viewByteOffset + viewByteLength
    )
    if (!rangeIsCurrent) {
        throwCommandImmediateDataDiagnostic(command, {
            expectedByteLength: state.expectedByteLength,
            immediateData: state.source,
            sourceKind: state.sourceKind,
            visibleByteLength: viewByteLength,
            reason: 'source-range-changed',
            layoutArtifact: state.layoutArtifact,
        })
    }

    return Object.freeze({
        byteStorage,
        byteOffset: state.byteOffset,
        visibleByteLength: state.visibleByteLength,
    })
}

function validateImmediateVisibleByteLength(
    command: DrawCommand | DispatchCommand,
    immediateData: unknown,
    sourceKind: CommandImmediateSourceKind,
    visibleByteLength: number,
    expectedByteLength: number,
    layoutArtifact?: LayoutArtifact
): void {

    if (visibleByteLength === expectedByteLength) return
    throwCommandImmediateDataDiagnostic(command, {
        expectedByteLength,
        immediateData,
        sourceKind,
        visibleByteLength,
        reason: 'byte-length-mismatch',
        layoutArtifact,
    })
}

function throwCommandImmediateDataDiagnostic(
    command: DrawCommand | DispatchCommand,
    details: {
        expectedByteLength: number
        immediateData: unknown
        sourceKind?: CommandImmediateSourceKind | undefined
        visibleByteLength?: number | undefined
        reason: string
        layoutArtifact?: LayoutArtifact | undefined
    }
): never {

    throwScratchDiagnostic({
        code: 'SCRATCH_COMMAND_IMMEDIATE_DATA_INVALID',
        severity: 'error',
        phase: 'command',
        subject: command.subject,
        related: [
            command.pipeline.subject,
            ...(details.layoutArtifact !== undefined
                ? [ layoutArtifactSubject(details.layoutArtifact) ]
                : []),
        ],
        message: 'Command immediateData does not match its Pipeline immediate range.',
        expected: {
            immediateByteLength: details.expectedByteLength,
            source: details.expectedByteLength === 0
                ? 'omitted'
                : 'ArrayBuffer, ArrayBufferView, or compatible LayoutUploadView',
        },
        actual: {
            sourceKind: details.sourceKind ?? describeImmediateSourceKind(details.immediateData),
            ...(details.visibleByteLength !== undefined
                ? { visibleByteLength: details.visibleByteLength }
                : {}),
            reason: details.reason,
        },
    })
}

function describeImmediateSourceKind(value: unknown): string {

    if (value === undefined) return 'undefined'
    if (value === null) return 'null'
    if (value instanceof ArrayBuffer) return 'array-buffer'
    if (ArrayBuffer.isView(value)) return 'array-buffer-view'
    return typeof value
}

function resolvedImmediateBytesForEncoding(
    command: DrawCommand | DispatchCommand,
    resolved: ResolvedCommandImmediateData | undefined
): Uint8Array | undefined {

    const state = commandImmediateDataStates.get(command)
    if (state === undefined) {
        throw new TypeError('Command immediate-data state is unavailable.')
    }
    if (state.sourceKind === 'none') {
        if (
            resolved === undefined ||
            (
                resolved.sourceKind === 'none' &&
                resolved.expectedByteLength === 0 &&
                resolved.visibleByteLength === 0 &&
                resolved.bytes === undefined
            )
        ) {
            return undefined
        }
        throwCommandImmediateDataDiagnostic(command, {
            expectedByteLength: 0,
            immediateData: command.immediateData,
            visibleByteLength: resolved.visibleByteLength,
            reason: 'unexpected-resolved-snapshot',
        })
    }

    if (
        resolved === undefined ||
        resolved.sourceKind !== state.sourceKind ||
        resolved.expectedByteLength !== state.expectedByteLength ||
        resolved.visibleByteLength !== state.expectedByteLength ||
        !(resolved.bytes instanceof Uint8Array) ||
        resolved.bytes.byteLength !== state.expectedByteLength
    ) {
        throwCommandImmediateDataDiagnostic(command, {
            expectedByteLength: state.expectedByteLength,
            immediateData: state.source,
            sourceKind: state.sourceKind,
            visibleByteLength: resolved?.visibleByteLength,
            reason: 'resolved-snapshot-missing-or-incompatible',
            layoutArtifact: state.layoutArtifact,
        })
    }

    return resolved.bytes
}

function setPassEncoderImmediates(
    passEncoder: GPURenderPassEncoder | GPUComputePassEncoder,
    bytes: Uint8Array | undefined
): void {

    if (bytes === undefined) return
    const encoder = passEncoder as (
        GPURenderPassEncoder | GPUComputePassEncoder
    ) & {
        setImmediates(offset: number, data: ArrayBufferView): void
    }
    encoder.setImmediates(0, bytes)
}

function drawCountProducesDeclaredWrites(count: DrawCommand['count']): boolean {

    if ('indirect' in count) return true
    const instanceCount = count.instanceCount ?? 1
    if ('indexCount' in count) return count.indexCount > 0 && instanceCount > 0
    return count.vertexCount > 0 && instanceCount > 0
}

function dispatchCountProducesDeclaredWrites(count: DispatchCommand['count']): boolean {

    if ('indirect' in count) return true
    return count.workgroups.every(value => value > 0)
}

type NormalizedDrawViewport = Readonly<{
    x: number
    y: number
    width: number
    height: number
    minDepth: number
    maxDepth: number
}>

type NormalizedDrawScissorRect = Readonly<{
    x: number
    y: number
    width: number
    height: number
}>

type NormalizedDrawBlendConstant = readonly [ number, number, number, number ]

type ResolvedDrawRenderState = Readonly<{
    viewport: NormalizedDrawViewport
    scissor: NormalizedDrawScissorRect
    blendConstant: NormalizedDrawBlendConstant
    stencilReference: number
}>

function normalizeDrawRenderState(
    command: DrawCommand,
    value: unknown
): DrawRenderState {

    if (value !== undefined && !isRecord(value)) {
        throwDrawRenderStateDiagnostic(command, value, 'renderState')
    }
    const state = value === undefined ? {} : value
    const allowed = new Set([ 'viewport', 'scissor', 'blendConstant', 'stencilReference' ])
    const unknown = Object.keys(state).filter(key => !allowed.has(key))
    if (unknown.length > 0) {
        throwDrawRenderStateDiagnostic(command, value, 'unknownFields', {
            fields: [ ...allowed ],
        }, { unknown })
    }

    const viewport = normalizeDrawViewport(command, state.viewport)
    const scissor = normalizeDrawScissor(command, state.scissor)
    const blendConstant = normalizeDrawBlendConstant(command, state.blendConstant)
    const stencilReference = state.stencilReference ?? 0
    if (!isGpuSize32(stencilReference)) {
        throwDrawRenderStateDiagnostic(command, value, 'stencilReference', {
            stencilReference: 'GPUStencilValue integer in [0, 4294967295]',
        }, { stencilReference: describeValue(state.stencilReference) })
    }

    return Object.freeze({
        viewport,
        scissor,
        blendConstant,
        stencilReference,
    })
}

function normalizeDrawViewport(
    command: DrawCommand,
    value: unknown
): 'full-attachment' | NormalizedDrawViewport {

    if (value === undefined || value === 'full-attachment') return 'full-attachment'
    if (!isRecord(value)) {
        throwDrawRenderStateDiagnostic(command, value, 'viewport')
    }
    const allowed = new Set([ 'x', 'y', 'width', 'height', 'minDepth', 'maxDepth' ])
    const unknown = Object.keys(value).filter(key => !allowed.has(key))
    const x = value.x
    const y = value.y
    const width = value.width
    const height = value.height
    const minDepth = value.minDepth ?? 0
    const maxDepth = value.maxDepth ?? 1
    const maximumDimension = command.runtime.deviceLimits.maxTextureDimension2D
    const maximumRange = maximumDimension * 2
    const valid = unknown.length === 0 &&
        [ x, y, width, height, minDepth, maxDepth ].every(isFiniteNumber) &&
        (x as number) >= -maximumRange &&
        (y as number) >= -maximumRange &&
        (width as number) >= 0 &&
        (width as number) <= maximumDimension &&
        (height as number) >= 0 &&
        (height as number) <= maximumDimension &&
        (x as number) + (width as number) <= maximumRange - 1 &&
        (y as number) + (height as number) <= maximumRange - 1 &&
        (minDepth as number) >= 0 &&
        (minDepth as number) <= 1 &&
        (maxDepth as number) >= 0 &&
        (maxDepth as number) <= 1 &&
        (minDepth as number) <= (maxDepth as number)
    if (!valid) {
        throwDrawRenderStateDiagnostic(command, value, 'viewport', {
            x: `finite number >= ${-maximumRange}`,
            y: `finite number >= ${-maximumRange}`,
            width: `finite number in [0, ${maximumDimension}]`,
            height: `finite number in [0, ${maximumDimension}]`,
            maximumX: maximumRange - 1,
            maximumY: maximumRange - 1,
            depthRange: '0 <= minDepth <= maxDepth <= 1',
            fields: [ ...allowed ],
        }, {
            viewport: describeValue(value),
            unknown,
        })
    }

    return Object.freeze({
        x: x as number,
        y: y as number,
        width: width as number,
        height: height as number,
        minDepth: minDepth as number,
        maxDepth: maxDepth as number,
    })
}

function normalizeDrawScissor(
    command: DrawCommand,
    value: unknown
): 'full-attachment' | NormalizedDrawScissorRect {

    if (value === undefined || value === 'full-attachment') return 'full-attachment'
    if (!isRecord(value)) {
        throwDrawRenderStateDiagnostic(command, value, 'scissor')
    }
    const allowed = new Set([ 'x', 'y', 'width', 'height' ])
    const unknown = Object.keys(value).filter(key => !allowed.has(key))
    if (
        unknown.length > 0 ||
        ![ value.x, value.y, value.width, value.height ].every(isGpuSize32)
    ) {
        throwDrawRenderStateDiagnostic(command, value, 'scissor', {
            x: 'GPUIntegerCoordinate',
            y: 'GPUIntegerCoordinate',
            width: 'GPUIntegerCoordinate',
            height: 'GPUIntegerCoordinate',
            fields: [ ...allowed ],
        }, {
            scissor: describeValue(value),
            unknown,
        })
    }

    return Object.freeze({
        x: value.x as number,
        y: value.y as number,
        width: value.width as number,
        height: value.height as number,
    })
}

function normalizeDrawBlendConstant(
    command: DrawCommand,
    value: unknown
): NormalizedDrawBlendConstant {

    if (value === undefined) return Object.freeze([ 0, 0, 0, 0 ])

    let components: unknown[] | undefined
    if (
        value !== null &&
        typeof value !== 'string' &&
        typeof (value as Iterable<unknown>)[Symbol.iterator] === 'function'
    ) {
        components = [ ...(value as Iterable<unknown>) ]
    } else if (isRecord(value)) {
        components = [ value.r, value.g, value.b, value.a ]
    }
    if (
        components === undefined ||
        components.length !== 4 ||
        !components.every(isFiniteNumber)
    ) {
        throwDrawRenderStateDiagnostic(command, value, 'blendConstant', {
            blendConstant: 'GPUColor with exactly four finite components',
        }, { blendConstant: describeValue(value) })
    }

    return Object.freeze([
        components[0] as number,
        components[1] as number,
        components[2] as number,
        components[3] as number,
    ])
}

function resolveDrawRenderState(
    command: DrawCommand,
    attachmentExtent: DrawRenderAttachmentExtent | undefined
): ResolvedDrawRenderState {

    if (
        attachmentExtent === undefined ||
        !isGpuSize32(attachmentExtent.width) ||
        !isGpuSize32(attachmentExtent.height) ||
        attachmentExtent.width === 0 ||
        attachmentExtent.height === 0
    ) {
        throwDrawRenderStateDiagnostic(command, attachmentExtent, 'attachmentExtent', {
            attachmentExtent: 'positive current render attachment width and height',
        }, { attachmentExtent: describeValue(attachmentExtent) })
    }

    const viewport = command.renderState.viewport === 'full-attachment' ||
        command.renderState.viewport === undefined
        ? Object.freeze({
            x: 0,
            y: 0,
            width: attachmentExtent.width,
            height: attachmentExtent.height,
            minDepth: 0,
            maxDepth: 1,
        })
        : command.renderState.viewport as NormalizedDrawViewport
    const scissor = command.renderState.scissor === 'full-attachment' ||
        command.renderState.scissor === undefined
        ? Object.freeze({
            x: 0,
            y: 0,
            width: attachmentExtent.width,
            height: attachmentExtent.height,
        })
        : command.renderState.scissor as NormalizedDrawScissorRect

    if (
        scissor.x + scissor.width > attachmentExtent.width ||
        scissor.y + scissor.height > attachmentExtent.height
    ) {
        throwDrawRenderStateDiagnostic(command, command.renderState, 'scissorBounds', {
            scissor: {
                maximumX: attachmentExtent.width,
                maximumY: attachmentExtent.height,
            },
        }, {
            scissor,
            attachmentExtent,
        })
    }

    return Object.freeze({
        viewport,
        scissor,
        blendConstant: (
            command.renderState.blendConstant ??
            Object.freeze([ 0, 0, 0, 0 ])
        ) as NormalizedDrawBlendConstant,
        stencilReference: command.renderState.stencilReference ?? 0,
    })
}

function throwDrawRenderStateDiagnostic(
    command: DrawCommand,
    value: unknown,
    reason: string,
    expected: Record<string, unknown> = {
        renderState: 'object with viewport, scissor, blendConstant, and stencilReference',
    },
    actual: Record<string, unknown> = { renderState: describeValue(value) }
): never {

    throwScratchDiagnostic({
        code: 'SCRATCH_COMMAND_RENDER_STATE_INVALID',
        severity: 'error',
        phase: 'command',
        subject: command.subject,
        related: [ command.pipeline.subject ],
        message: 'DrawCommand renderState is invalid for the current runtime or render pass.',
        expected,
        actual: {
            reason,
            ...actual,
        },
    })
}

export function isDrawCommand(value: unknown): value is DrawCommand {

    return hasCommandBrand(value, 'draw', DrawCommand.prototype)
}

export function isDispatchCommand(value: unknown): value is DispatchCommand {

    return hasCommandBrand(value, 'dispatch', DispatchCommand.prototype)
}

export function isBeginOcclusionQueryCommand(value: unknown): value is BeginOcclusionQueryCommand {

    return hasCommandBrand(value, 'begin-occlusion-query', BeginOcclusionQueryCommand.prototype)
}

export function isEndOcclusionQueryCommand(value: unknown): value is EndOcclusionQueryCommand {

    return hasCommandBrand(value, 'end-occlusion-query', EndOcclusionQueryCommand.prototype)
}

export function isRenderCommand(
    value: unknown
): value is DrawCommand | BeginOcclusionQueryCommand | EndOcclusionQueryCommand {

    return isDrawCommand(value) ||
        isBeginOcclusionQueryCommand(value) ||
        isEndOcclusionQueryCommand(value)
}

export function isUploadCommand(
    value: unknown
): value is UploadCommand | TextureUploadCommand | ExternalImageUploadCommand {

    return hasCommandBrand(value, 'buffer-upload', UploadCommand.prototype) ||
        hasCommandBrand(value, 'texture-upload', TextureUploadCommand.prototype) ||
        hasCommandBrand(value, 'external-image-upload', ExternalImageUploadCommand.prototype)
}

export function isCopyCommand(value: unknown): value is CopyCommand {

    return hasCommandBrand(value, 'copy', CopyCommand.prototype)
}

export function isClearBufferCommand(value: unknown): value is ClearBufferCommand {

    return hasCommandBrand(value, 'clear', ClearBufferCommand.prototype)
}

export function isReadbackCommand(value: unknown): value is ReadbackCommand {

    return hasCommandBrand(value, 'readback', ReadbackCommand.prototype)
}

export function isResolveQuerySetCommand(value: unknown): value is ResolveQuerySetCommand {

    return hasCommandBrand(value, 'resolve-query-set', ResolveQuerySetCommand.prototype)
}

function hasCommandBrand(value: unknown, brand: CommandBrand, prototype: object): boolean {

    return typeof value === 'object' && value !== null &&
        Object.getPrototypeOf(value) === prototype &&
        commandBrands.get(value) === brand
}

function lockDrawCommandContract(command: DrawCommand): void {

    for (const invocation of command.bindSets) Object.freeze(invocation)
    Object.freeze(command.bindSets)
    for (const binding of command.vertexBuffers) Object.freeze(binding)
    Object.freeze(command.vertexBuffers)
    if (command.indexBuffer !== undefined) Object.freeze(command.indexBuffer)
    if (command.renderState.viewport !== 'full-attachment') Object.freeze(command.renderState.viewport)
    if (command.renderState.scissor !== 'full-attachment') Object.freeze(command.renderState.scissor)
    if (command.renderState.blendConstant !== undefined) Object.freeze(command.renderState.blendConstant)
    Object.freeze(command.renderState)
    Object.freeze(command.count)
    lockCommandResources(command.resources)
    lockCommandProperties(command, [
        'runtime',
        'id',
        'label',
        'commandKind',
        'pipeline',
        'immediateData',
        'bindSets',
        'vertexBuffers',
        'indexBuffer',
        'renderState',
        'count',
        'resources',
        'whenMissing',
        'fallback',
    ])
    Object.preventExtensions(command)
}

function lockDispatchCommandContract(command: DispatchCommand): void {

    for (const invocation of command.bindSets) Object.freeze(invocation)
    Object.freeze(command.bindSets)
    if ('workgroups' in command.count) Object.freeze(command.count.workgroups)
    Object.freeze(command.count)
    lockCommandResources(command.resources)
    lockCommandProperties(command, [
        'runtime',
        'id',
        'label',
        'commandKind',
        'pipeline',
        'immediateData',
        'bindSets',
        'count',
        'resources',
        'whenMissing',
        'fallback',
    ])
    Object.preventExtensions(command)
}

function lockCommandResources(resources: CommandResourceAccessDescriptor): void {

    for (const read of resources.read) Object.freeze(read)
    Object.freeze(resources.read)
    Object.freeze(resources.write)
    Object.freeze(resources)
}

function lockCommandProperties(command: object, properties: string[]): void {

    const record = command as Record<string, unknown>
    for (const property of properties) {
        const descriptor = Object.getOwnPropertyDescriptor(command, property)
        Object.defineProperty(command, property, {
            value: descriptor === undefined ? undefined : record[property],
            enumerable: descriptor?.enumerable ?? false,
            configurable: false,
            writable: false,
        })
    }
}

function lockExternalImageUploadCommandContract(command: ExternalImageUploadCommand): void {

    Object.freeze(command.sourceOrigin)
    Object.freeze(command.origin)
    Object.freeze(command.size)
    lockCommandProperties(command, [
        'runtime',
        'id',
        'label',
        'commandKind',
        'uploadKind',
        'source',
        'sourceOrigin',
        'flipY',
        'target',
        'origin',
        'mipLevel',
        'colorSpace',
        'premultipliedAlpha',
        'size',
    ])
    Object.preventExtensions(command)
}

export interface UploadCommand {
    readonly runtime: ScratchRuntime
    readonly id: string
    readonly label?: string
    readonly commandKind: 'upload'
    readonly uploadKind: 'buffer'
    readonly target: BufferRegion
    readonly data: ArrayBuffer | ArrayBufferView
    readonly layout?: LayoutArtifact
    readonly dataOffset: number
    readonly byteLength: number
}

export class UploadCommand {

    #isDisposed = false

    constructor(runtime: ScratchRuntime, descriptor: UploadCommandDescriptor = {} as UploadCommandDescriptor) {

        assertScratchRuntimeActive(runtime)

        const target = descriptor.target
        if (!isBufferRegion(target)) {
            throwUploadDiagnostic({
                runtime,
                target,
                data: descriptor.data,
                reason: 'target',
            })
        }

        target.buffer.assertRuntime(runtime)
        target.assertUsable()
        validateBufferUploadUsage(runtime, target)
        const uploadSource = normalizeUploadSource(runtime, descriptor)

        const mutable = this as Mutable<UploadCommand>
        mutable.runtime = runtime
        mutable.id = `scratch-command-${UUID()}`
        if (descriptor.label !== undefined) mutable.label = descriptor.label
        mutable.commandKind = 'upload'
        mutable.uploadKind = 'buffer'
        mutable.target = target
        mutable.data = uploadSource.data
        const layout = normalizeUploadLayout(runtime, uploadSource.layout, descriptor)
        if (layout !== undefined) mutable.layout = layout
        mutable.dataOffset = normalizeUploadOffset(runtime, descriptor.dataOffset ?? uploadSource.dataOffset)
        const sourceByteLength = descriptor.dataOffset === undefined ? uploadSource.byteLength : undefined
        mutable.byteLength = normalizeUploadByteLength(runtime, this.data, this.dataOffset, descriptor, sourceByteLength)

        validateUploadRange(this)
        commandBrands.set(this, 'buffer-upload')
        lockCommandProperties(this, [
            'runtime', 'id', 'label', 'commandKind', 'uploadKind', 'target', 'data',
            'layout', 'dataOffset', 'byteLength',
        ])
        Object.preventExtensions(this)
    }

    get subject(): DiagnosticSubject {

        const subject: DiagnosticSubject = {
            kind: 'Command',
            id: this.id,
            commandKind: 'upload',
            uploadKind: 'buffer',
        }
        if (this.label !== undefined) subject.label = this.label

        return subject
    }

    get isDisposed(): boolean {

        return this.#isDisposed
    }

    assertRuntime(runtime: ScratchRuntime) {

        this.assertUsable()

        if (runtime !== this.runtime) {
            throwScratchDiagnostic({
                code: 'SCRATCH_COMMAND_WRONG_RUNTIME',
                severity: 'error',
                phase: 'command',
                subject: this.subject,
                related: [
                    this.runtime.subject,
                    runtime?.subject,
                ].filter(Boolean),
                message: 'Command belongs to a different ScratchRuntime.',
                expected: { runtimeId: this.runtime.id },
                actual: { runtimeId: runtime?.id },
            })
        }
    }

    assertUsable() {

        if (this.#isDisposed) {
            throwScratchDiagnostic({
                code: 'SCRATCH_COMMAND_DISPOSED',
                severity: 'error',
                phase: 'command',
                subject: this.subject,
                message: 'Command has been disposed.',
            })
        }

        assertScratchRuntimeActive(this.runtime)
        this.target.assertUsable()
    }

    execute(queue: GPUQueue) {

        validateUploadCommandQueueAction(this, queue)
        writeUploadCommandQueueAction(this, queue)
        commitUploadCommandLogicalWrite(this)
    }

    dispose(): void {

        this.#isDisposed = true
    }
}

export interface ClearBufferCommand {
    readonly runtime: ScratchRuntime
    readonly id: string
    readonly label?: string
    readonly commandKind: 'clear'
    readonly target: BufferRegion
}

export class ClearBufferCommand {

    #isDisposed = false

    constructor(
        runtime: ScratchRuntime,
        descriptor: ClearBufferCommandDescriptor = {} as ClearBufferCommandDescriptor
    ) {

        assertScratchRuntimeActive(runtime)

        if (!isRecord(descriptor) || Array.isArray(descriptor)) {
            throwClearBufferDiagnostic(runtime, descriptor, 'descriptor')
        }
        const target = descriptor.target
        if (!isBufferRegion(target)) {
            throwClearBufferDiagnostic(runtime, target, 'target')
        }
        target.buffer.assertRuntime(runtime)

        const mutable = this as Mutable<ClearBufferCommand>
        mutable.runtime = runtime
        mutable.id = `scratch-command-${UUID()}`
        if (descriptor.label !== undefined) mutable.label = descriptor.label
        mutable.commandKind = 'clear'
        mutable.target = target

        validateClearBufferTarget(this)
        commandBrands.set(this, 'clear')
        lockCommandProperties(this, [
            'runtime',
            'id',
            'label',
            'commandKind',
            'target',
        ])
        Object.preventExtensions(this)
    }

    get subject(): DiagnosticSubject {

        const subject: DiagnosticSubject = {
            kind: 'Command',
            id: this.id,
            commandKind: 'clear',
        }
        if (this.label !== undefined) subject.label = this.label

        return subject
    }

    get isDisposed(): boolean {

        return this.#isDisposed
    }

    get hasContentEffect(): boolean {

        return this.target.size > 0
    }

    assertRuntime(runtime: ScratchRuntime): void {

        this.assertUsable()

        if (runtime !== this.runtime) {
            throwScratchDiagnostic({
                code: 'SCRATCH_COMMAND_WRONG_RUNTIME',
                severity: 'error',
                phase: 'command',
                subject: this.subject,
                related: [
                    this.runtime.subject,
                    runtime?.subject,
                ].filter(Boolean),
                message: 'Command belongs to a different ScratchRuntime.',
                expected: { runtimeId: this.runtime.id },
                actual: { runtimeId: runtime?.id },
            })
        }
    }

    assertUsable(): void {

        if (this.#isDisposed) {
            throwScratchDiagnostic({
                code: 'SCRATCH_COMMAND_DISPOSED',
                severity: 'error',
                phase: 'command',
                subject: this.subject,
                message: 'Command has been disposed.',
            })
        }

        assertScratchRuntimeActive(this.runtime)
        this.target.buffer.assertUsable()
        validateClearBufferTarget(this)
    }

    validateCurrentRange(): void {

        this.assertUsable()
    }

    encode(commandEncoder: GPUCommandEncoder): void {

        this.validateCurrentRange()
        if (!this.hasContentEffect) return

        if (!commandEncoder || typeof commandEncoder.clearBuffer !== 'function') {
            throwScratchDiagnostic({
                code: 'SCRATCH_RUNTIME_DEVICE_UNAVAILABLE',
                severity: 'error',
                phase: 'runtime',
                subject: this.runtime.subject,
                related: [ this.subject, this.target.buffer.subject ],
                message: 'ScratchRuntime command encoder cannot clear GPU buffers.',
                expected: { commandEncoder: 'GPUCommandEncoder with clearBuffer()' },
                actual: { clearBuffer: typeof commandEncoder?.clearBuffer },
            })
        }

        commandEncoder.clearBuffer(
            this.target.buffer.gpuBuffer,
            this.target.offset,
            this.target.size
        )
        advanceResourceContentEpoch(this.target.buffer)
    }

    dispose(): void {

        this.#isDisposed = true
    }
}

export interface CopyCommand {
    readonly runtime: ScratchRuntime
    readonly id: string
    readonly label?: string
    readonly commandKind: 'copy'
    readonly copyKind: 'buffer-to-buffer' | 'texture-to-texture' | 'buffer-to-texture' | 'texture-to-buffer'
    readonly source: CopyCommandSourceDescriptor
    readonly sourceLayout?: Readonly<Required<TexelCopyBufferLayout>>
    readonly target: BufferRegion | TextureResource
    readonly targetLayout?: Readonly<Required<TexelCopyBufferLayout>>
    readonly sourceOrigin?: Readonly<{ x: number, y: number, z: number }>
    readonly targetOrigin?: Readonly<{ x: number, y: number, z: number }>
    readonly sourceMipLevel?: number
    readonly targetMipLevel?: number
    readonly sourceAspect?: GPUTextureAspect
    readonly targetAspect?: GPUTextureAspect
    readonly size?: Readonly<{ width: number, height: number, depthOrArrayLayers: number }>
    readonly whenMissing: 'throw'
}

export class CopyCommand {

    #isDisposed = false

    constructor(runtime: ScratchRuntime, descriptor: CopyCommandDescriptor = {} as CopyCommandDescriptor) {

        assertScratchRuntimeActive(runtime)

        const source = normalizeCopySource(runtime, descriptor)
        const sourceResource = copySourceResource(source)
        sourceResource.assertRuntime(runtime)

        const mutable = this as Mutable<CopyCommand>
        mutable.runtime = runtime
        mutable.id = `scratch-command-${UUID()}`
        if (descriptor.label !== undefined) mutable.label = descriptor.label
        mutable.commandKind = 'copy'
        mutable.source = source
        mutable.target = descriptor.target
        mutable.whenMissing = normalizeCopyReadinessPolicy(this, descriptor.whenMissing)

        if (isBufferRegionSource(source) && isBufferRegion(descriptor.target)) {
            const bufferDescriptor = descriptor as BufferToBufferCopyCommandDescriptor
            const target = normalizeBufferCopyTarget(runtime, bufferDescriptor, source.region)

            mutable.copyKind = 'buffer-to-buffer'
            mutable.target = target
            validateBufferCopyUsage(runtime, source.region.buffer, GPU_BUFFER_USAGE_COPY_SRC, 'source', 'GPUBufferUsage.COPY_SRC')
            validateBufferCopyUsage(runtime, target.buffer, GPU_BUFFER_USAGE_COPY_DST, 'target', 'GPUBufferUsage.COPY_DST')
            validateBufferCopyRange(this)
        } else if (isTextureCopySource(source) && isTextureResource(descriptor.target)) {
            const textureDescriptor = descriptor as TextureToTextureCopyCommandDescriptor
            const target = normalizeTextureCopyTarget(runtime, textureDescriptor, source.resource)

            mutable.copyKind = 'texture-to-texture'
            mutable.target = target
            mutable.sourceOrigin = normalizeTextureCopyOrigin(runtime, textureDescriptor.sourceOrigin, 'sourceOrigin')
            mutable.targetOrigin = normalizeTextureCopyOrigin(runtime, textureDescriptor.targetOrigin, 'targetOrigin')
            mutable.sourceMipLevel = normalizeTextureCopyMipLevel(runtime, source.resource, textureDescriptor.sourceMipLevel ?? 0, 'sourceMipLevel')
            mutable.targetMipLevel = normalizeTextureCopyMipLevel(runtime, target, textureDescriptor.targetMipLevel ?? 0, 'targetMipLevel')
            mutable.sourceAspect = normalizeTextureCopyAspect(runtime, textureDescriptor.sourceAspect ?? 'all', 'sourceAspect')
            mutable.targetAspect = normalizeTextureCopyAspect(runtime, textureDescriptor.targetAspect ?? 'all', 'targetAspect')
            mutable.size = normalizeTextureCopySize(runtime, source.resource, target, textureDescriptor.size, this.sourceOrigin, this.targetOrigin)
            validateTextureCopyUsage(runtime, source.resource, GPU_TEXTURE_USAGE_COPY_SRC, 'source', 'GPUTextureUsage.COPY_SRC')
            validateTextureCopyUsage(runtime, target, GPU_TEXTURE_USAGE_COPY_DST, 'target', 'GPUTextureUsage.COPY_DST')
            validateTextureCopyRange(this)
        } else if (isBufferRegionSource(source) && isTextureResource(descriptor.target)) {
            const bufferToTextureDescriptor = descriptor as BufferToTextureCopyCommandDescriptor
            const target = normalizeBufferToTextureCopyTarget(runtime, bufferToTextureDescriptor, source.region.buffer)

            mutable.copyKind = 'buffer-to-texture'
            mutable.target = target
            mutable.targetOrigin = normalizeTextureCopyOrigin(runtime, bufferToTextureDescriptor.targetOrigin, 'targetOrigin')
            mutable.targetMipLevel = normalizeTextureCopyMipLevel(runtime, target, bufferToTextureDescriptor.targetMipLevel ?? 0, 'targetMipLevel')
            const targetAspect = normalizeTextureCopyAspect(runtime, bufferToTextureDescriptor.targetAspect ?? 'all', 'targetAspect')
            mutable.targetAspect = targetAspect
            const size = normalizeTextureCopySize(runtime, source.region.buffer, target, bufferToTextureDescriptor.size, undefined, this.targetOrigin)
            mutable.size = size
            mutable.sourceLayout = normalizeTexelCopyBufferLayout(
                runtime,
                source.region,
                target,
                targetAspect,
                'destination',
                bufferToTextureDescriptor.sourceLayout,
                size,
                'sourceLayout'
            )
            validateBufferCopyUsage(runtime, source.region.buffer, GPU_BUFFER_USAGE_COPY_SRC, 'source', 'GPUBufferUsage.COPY_SRC')
            validateTextureCopyUsage(runtime, target, GPU_TEXTURE_USAGE_COPY_DST, 'target', 'GPUTextureUsage.COPY_DST')
            validateBufferToTextureCopyRange(this)
        } else if (isTextureCopySource(source) && isBufferRegion(descriptor.target)) {
            const textureToBufferDescriptor = descriptor as TextureToBufferCopyCommandDescriptor
            const target = normalizeTextureToBufferCopyTarget(runtime, textureToBufferDescriptor, source.resource)

            mutable.copyKind = 'texture-to-buffer'
            mutable.target = target
            mutable.sourceOrigin = normalizeTextureCopyOrigin(runtime, textureToBufferDescriptor.sourceOrigin, 'sourceOrigin')
            mutable.sourceMipLevel = normalizeTextureCopyMipLevel(runtime, source.resource, textureToBufferDescriptor.sourceMipLevel ?? 0, 'sourceMipLevel')
            const sourceAspect = normalizeTextureCopyAspect(runtime, textureToBufferDescriptor.sourceAspect ?? 'all', 'sourceAspect')
            mutable.sourceAspect = sourceAspect
            const size = normalizeTextureCopySize(runtime, source.resource, target.buffer, textureToBufferDescriptor.size, this.sourceOrigin, undefined)
            mutable.size = size
            mutable.targetLayout = normalizeTexelCopyBufferLayout(
                runtime,
                target,
                source.resource,
                sourceAspect,
                'source',
                textureToBufferDescriptor.targetLayout,
                size,
                'targetLayout'
            )
            validateTextureCopyUsage(runtime, source.resource, GPU_TEXTURE_USAGE_COPY_SRC, 'source', 'GPUTextureUsage.COPY_SRC')
            validateBufferCopyUsage(runtime, target.buffer, GPU_BUFFER_USAGE_COPY_DST, 'target', 'GPUBufferUsage.COPY_DST')
            validateTextureToBufferCopyRange(this)
        } else {
            throwCopyDiagnostic({
                runtime,
                source: sourceResource,
                target: descriptor.target,
                reason: 'target',
            })
        }
        for (const value of [
            this.source, this.sourceLayout, this.targetLayout, this.sourceOrigin,
            this.targetOrigin, this.size,
        ]) {
            if (value !== undefined) Object.freeze(value)
        }
        commandBrands.set(this, 'copy')
        lockCommandProperties(this, [
            'runtime', 'id', 'label', 'commandKind', 'copyKind', 'source', 'sourceLayout',
            'target', 'targetLayout', 'sourceOrigin', 'targetOrigin', 'sourceMipLevel',
            'targetMipLevel', 'sourceAspect', 'targetAspect', 'size', 'whenMissing',
        ])
        Object.preventExtensions(this)
    }

    get subject(): DiagnosticSubject {

        const subject: DiagnosticSubject = {
            kind: 'Command',
            id: this.id,
            commandKind: 'copy',
        }
        if (this.label !== undefined) subject.label = this.label

        return subject
    }

    get isDisposed(): boolean {

        return this.#isDisposed
    }

    assertRuntime(runtime: ScratchRuntime) {

        this.assertUsable()

        if (runtime !== this.runtime) {
            throwScratchDiagnostic({
                code: 'SCRATCH_COMMAND_WRONG_RUNTIME',
                severity: 'error',
                phase: 'command',
                subject: this.subject,
                related: [
                    this.runtime.subject,
                    runtime?.subject,
                ].filter(Boolean),
                message: 'Command belongs to a different ScratchRuntime.',
                expected: { runtimeId: this.runtime.id },
                actual: { runtimeId: runtime?.id },
            })
        }
    }

    assertUsable() {

        if (this.#isDisposed) {
            throwScratchDiagnostic({
                code: 'SCRATCH_COMMAND_DISPOSED',
                severity: 'error',
                phase: 'command',
                subject: this.subject,
                message: 'Command has been disposed.',
            })
        }

        assertScratchRuntimeActive(this.runtime)
        if (isBufferRegionSource(this.source)) {
            this.source.region.assertUsable()
        } else {
            this.source.resource.assertUsable()
        }
        this.target.assertUsable()
    }

    validateCurrentRange(): void {

        this.assertUsable()
        validateCurrentCopyUsage(this)

        if (this.copyKind === 'buffer-to-buffer') {
            validateBufferCopyRange(this)
        } else if (this.copyKind === 'texture-to-texture') {
            validateTextureCopyRange(this)
        } else if (this.copyKind === 'buffer-to-texture') {
            validateBufferToTextureCopyRange(this)
        } else {
            validateTextureToBufferCopyRange(this)
        }
    }

    encode(commandEncoder: GPUCommandEncoder) {

        this.validateCurrentRange()

        if (this.copyKind === 'buffer-to-buffer') {
            if (!commandEncoder || typeof commandEncoder.copyBufferToBuffer !== 'function') {
                throwScratchDiagnostic({
                    code: 'SCRATCH_RUNTIME_DEVICE_UNAVAILABLE',
                    severity: 'error',
                    phase: 'runtime',
                    subject: this.runtime.subject,
                    related: [ this.subject ],
                    message: 'ScratchRuntime command encoder cannot copy GPU buffers.',
                    expected: { commandEncoder: 'GPUCommandEncoder with copyBufferToBuffer()' },
                    actual: { copyBufferToBuffer: typeof commandEncoder?.copyBufferToBuffer },
                })
            }

            commandEncoder.copyBufferToBuffer(
                (this.source as BufferCopyCommandSourceDescriptor).region.buffer.gpuBuffer,
                (this.source as BufferCopyCommandSourceDescriptor).region.offset,
                (this.target as BufferRegion).buffer.gpuBuffer,
                (this.target as BufferRegion).offset,
                (this.target as BufferRegion).size
            )
        } else if (this.copyKind === 'texture-to-texture') {
            if (!commandEncoder || typeof commandEncoder.copyTextureToTexture !== 'function') {
                throwScratchDiagnostic({
                    code: 'SCRATCH_RUNTIME_DEVICE_UNAVAILABLE',
                    severity: 'error',
                    phase: 'runtime',
                    subject: this.runtime.subject,
                    related: [ this.subject ],
                    message: 'ScratchRuntime command encoder cannot copy GPU textures.',
                    expected: { commandEncoder: 'GPUCommandEncoder with copyTextureToTexture()' },
                    actual: { copyTextureToTexture: typeof commandEncoder?.copyTextureToTexture },
                })
            }

            commandEncoder.copyTextureToTexture(
                {
                    texture: (this.source as TextureCopyCommandSourceDescriptor).resource.gpuTexture,
                    origin: this.sourceOrigin!,
                    mipLevel: this.sourceMipLevel!,
                    aspect: this.sourceAspect!,
                },
                {
                    texture: (this.target as TextureResource).gpuTexture,
                    origin: this.targetOrigin!,
                    mipLevel: this.targetMipLevel!,
                    aspect: this.targetAspect!,
                },
                this.size!
            )
        } else if (this.copyKind === 'buffer-to-texture') {
            if (!commandEncoder || typeof commandEncoder.copyBufferToTexture !== 'function') {
                throwScratchDiagnostic({
                    code: 'SCRATCH_RUNTIME_DEVICE_UNAVAILABLE',
                    severity: 'error',
                    phase: 'runtime',
                    subject: this.runtime.subject,
                    related: [ this.subject ],
                    message: 'ScratchRuntime command encoder cannot copy GPU buffers to textures.',
                    expected: { commandEncoder: 'GPUCommandEncoder with copyBufferToTexture()' },
                    actual: { copyBufferToTexture: typeof commandEncoder?.copyBufferToTexture },
                })
            }

            commandEncoder.copyBufferToTexture(
                {
                    buffer: (this.source as BufferCopyCommandSourceDescriptor).region.buffer.gpuBuffer,
                    offset: (this.source as BufferCopyCommandSourceDescriptor).region.offset,
                    ...this.sourceLayout!,
                },
                {
                    texture: (this.target as TextureResource).gpuTexture,
                    origin: this.targetOrigin!,
                    mipLevel: this.targetMipLevel!,
                    aspect: this.targetAspect!,
                },
                this.size!
            )
        } else {
            if (!commandEncoder || typeof commandEncoder.copyTextureToBuffer !== 'function') {
                throwScratchDiagnostic({
                    code: 'SCRATCH_RUNTIME_DEVICE_UNAVAILABLE',
                    severity: 'error',
                    phase: 'runtime',
                    subject: this.runtime.subject,
                    related: [ this.subject ],
                    message: 'ScratchRuntime command encoder cannot copy GPU textures to buffers.',
                    expected: { commandEncoder: 'GPUCommandEncoder with copyTextureToBuffer()' },
                    actual: { copyTextureToBuffer: typeof commandEncoder?.copyTextureToBuffer },
                })
            }

            commandEncoder.copyTextureToBuffer(
                {
                    texture: (this.source as TextureCopyCommandSourceDescriptor).resource.gpuTexture,
                    origin: this.sourceOrigin!,
                    mipLevel: this.sourceMipLevel!,
                    aspect: this.sourceAspect!,
                },
                {
                    buffer: (this.target as BufferRegion).buffer.gpuBuffer,
                    offset: (this.target as BufferRegion).offset,
                    ...this.targetLayout!,
                },
                this.size!
            )
        }

        advanceResourceContentEpoch(isTextureResource(this.target) ? this.target : this.target.buffer)
    }

    dispose(): void {

        this.#isDisposed = true
    }
}

type NormalizedReadbackCommandDescriptor = Readonly<{
    label?: string
    source: BufferCopyCommandSourceDescriptor
    retain: ReadbackRetentionPolicy
    whenMissing: 'throw'
}>

type ReadbackCommandPrivateState = {
    runtime: ScratchRuntime
    id: string
    label: string | undefined
    source: BufferCopyCommandSourceDescriptor
    retain: ReadbackRetentionPolicy
    whenMissing: 'throw'
    slot: ReadbackStagingSlot
    state: ScratchReadbackCommandState
    isDisposed: boolean
    disposeRequested: boolean
    activeClaim: ReadbackCommandClaim | undefined
}

type ReadbackCommandClaimPrivateState = {
    command: ReadbackCommand
    operationId: string
    submissionId: string
    stepIndex: number
    sourceResourceId: string
    allocationVersion: number
    contentEpoch: number
    stagingAllocationOperationId: string
    done: Promise<unknown> | undefined
    status: 'claimed' | 'submitted' | 'mapping' | 'releasing' | 'released'
    operationAdopted: boolean
}

const readbackCommandToken = Symbol('ReadbackCommand')
const readbackCommandClaimToken = Symbol('ReadbackCommandClaim')
const readbackCommandStates = new WeakMap<ReadbackCommand, ReadbackCommandPrivateState>()
const readbackCommandClaimStates = new WeakMap<ReadbackCommandClaim, ReadbackCommandClaimPrivateState>()
const readbackCommandResults = new WeakMap<ReadbackCommand, WeakMap<SubmittedWork, ReadbackOperation>>()
const emptyReadbackStagingCleanupResult: ReadbackStagingCleanupResult = Object.freeze({
    failures: Object.freeze([]),
})

export class ReadbackCommand {

    private constructor(
        token: symbol,
        runtime: ScratchRuntime,
        id: string,
        descriptor: NormalizedReadbackCommandDescriptor,
        slot: ReadbackStagingSlot
    ) {

        if (token !== readbackCommandToken || new.target !== ReadbackCommand) {
            throwScratchDiagnostic({
                code: 'SCRATCH_READBACK_COMMAND_CONSTRUCTOR_PRIVATE',
                severity: 'error',
                phase: 'readback',
                subject: { kind: 'Command', commandKind: 'readback' },
                message: 'ReadbackCommand must be created by ScratchRuntime.',
                hints: [ 'Use await runtime.createReadbackCommand(descriptor).' ],
            })
        }
        readbackCommandStates.set(this, {
            runtime,
            id,
            label: descriptor.label,
            source: descriptor.source,
            retain: descriptor.retain,
            whenMissing: descriptor.whenMissing,
            slot,
            state: 'idle',
            isDisposed: false,
            disposeRequested: false,
            activeClaim: undefined,
        })
        readbackCommandResults.set(this, new WeakMap())
        commandBrands.set(this, 'readback')
        Object.preventExtensions(this)
    }

    get runtime(): ScratchRuntime { return readbackCommandStateFor(this).runtime }
    get id(): string { return readbackCommandStateFor(this).id }
    get label(): string | undefined { return readbackCommandStateFor(this).label }
    get commandKind(): 'readback' { return 'readback' }
    get source(): BufferCopyCommandSourceDescriptor { return readbackCommandStateFor(this).source }
    get retain(): ReadbackRetentionPolicy { return readbackCommandStateFor(this).retain }
    get whenMissing(): 'throw' { return readbackCommandStateFor(this).whenMissing }
    get state(): ScratchReadbackCommandState { return readbackCommandStateFor(this).state }
    get isDisposed(): boolean { return readbackCommandStateFor(this).isDisposed }

    get subject(): DiagnosticSubject {

        return readbackCommandSubject(this.runtime, this.id, this.label)
    }

    assertRuntime(runtime: ScratchRuntime): void {

        this.assertUsable()
        if (runtime === this.runtime) return
        throwScratchDiagnostic({
            code: 'SCRATCH_COMMAND_WRONG_RUNTIME',
            severity: 'error',
            phase: 'command',
            subject: this.subject,
            related: [ this.runtime.subject, runtime?.subject ]
                .filter((subject): subject is DiagnosticSubject => subject !== undefined),
            message: 'Command belongs to a different ScratchRuntime.',
            expected: { runtimeId: this.runtime.id },
            actual: { runtimeId: runtime?.id },
        })
    }

    assertUsable(): void {

        this._assertNotDisposed()
        assertScratchRuntimeActive(this.runtime)
        validateCurrentReadbackCommandSource(this.runtime, this.subject, this.source)
    }

    result(options: ReadbackCommandResultOptions): ReadbackOperation {

        assertScratchRuntimeActive(this.runtime)
        const after = options?.after
        if (!after || after.runtime !== this.runtime || typeof after.done?.then !== 'function') {
            throwScratchDiagnostic({
                code: 'SCRATCH_READBACK_COMMAND_AFTER_INVALID',
                severity: 'error',
                phase: 'readback',
                subject: this.subject,
                related: [ this.runtime.subject, after?.subject ]
                    .filter((subject): subject is DiagnosticSubject => subject !== undefined),
                message: 'ReadbackCommand result requires SubmittedWork from the same ScratchRuntime.',
                expected: { after: 'SubmittedWork from the command runtime' },
                actual: { after: describeValue(after), runtimeId: after?.runtime?.id },
            })
        }
        const operation = readbackCommandResults.get(this)?.get(after)
        if (operation === undefined) {
            throwScratchDiagnostic({
                code: 'SCRATCH_READBACK_COMMAND_RESULT_UNAVAILABLE',
                severity: 'error',
                phase: 'readback',
                subject: this.subject,
                related: [ after.subject ],
                message: 'SubmittedWork did not include this ReadbackCommand.',
                expected: { commandId: this.id, submissionContainsCommand: true },
                actual: { commandId: this.id, submissionId: after.id, submissionContainsCommand: false },
            })
        }
        return operation
    }

    dispose(): void {

        const state = readbackCommandStateFor(this)
        if (state.isDisposed) return
        state.isDisposed = true
        state.disposeRequested = true
        if (state.activeClaim !== undefined) {
            if (state.runtime.isDisposed || state.runtime.isDeviceLost) {
                readbackCommandClaimStateFor(state.activeClaim).status = 'released'
                state.activeClaim = undefined
                finalizeReadbackCommandDisposal(this)
                return
            }
            state.state = 'releasing'
            updateRuntimeReadbackCommand(this.runtime, this.id, { state: 'releasing' })
            return
        }
        finalizeReadbackCommandDisposal(this)
    }

    private _assertNotDisposed(): void {

        if (!this.isDisposed) return
        throwScratchDiagnostic({
            code: 'SCRATCH_COMMAND_DISPOSED',
            severity: 'error',
            phase: 'command',
            subject: this.subject,
            message: 'Command has been disposed.',
        })
    }
}

export class ReadbackCommandClaim {

    private constructor(token: symbol) {

        if (token !== readbackCommandClaimToken || new.target !== ReadbackCommandClaim) {
            throw new TypeError('ReadbackCommandClaim is Scratch-owned.')
        }
        Object.preventExtensions(this)
    }

    get commandId(): string { return readbackCommandClaimStateFor(this).command.id }
    get operationId(): string { return readbackCommandClaimStateFor(this).operationId }
    get submissionId(): string { return readbackCommandClaimStateFor(this).submissionId }
    get stepIndex(): number { return readbackCommandClaimStateFor(this).stepIndex }
    get sourceResourceId(): string { return readbackCommandClaimStateFor(this).sourceResourceId }
    get allocationVersion(): number { return readbackCommandClaimStateFor(this).allocationVersion }
    get contentEpoch(): number { return readbackCommandClaimStateFor(this).contentEpoch }
    get stagingAllocationOperationId(): string { return readbackCommandClaimStateFor(this).stagingAllocationOperationId }
}

export async function createReadbackCommand(
    runtime: ScratchRuntime,
    descriptor: ReadbackCommandDescriptor
): Promise<ReadbackCommand> {

    assertScratchRuntimeActive(runtime)
    const id = `scratch-command-${UUID()}`
    const normalized = normalizeReadbackCommandDescriptor(runtime, id, descriptor)
    const stagingLabel = normalized.label === undefined ? undefined : `${normalized.label} staging`
    const slot = await allocateReadbackStaging({
        runtime,
        target: { kind: 'command', commandId: id, commandKind: 'readback' },
        source: normalized.source.region.buffer,
        byteLength: normalized.source.region.size,
        ...(stagingLabel !== undefined ? { label: stagingLabel } : {}),
    })
    try {
        assertScratchRuntimeActive(runtime)
        normalized.source.region.assertUsable()
        const command = constructReadbackCommand(runtime, id, normalized, slot)
        registerRuntimeReadbackCommand(runtime, command, readbackCommandFact(command))
        return command
    } catch (cause) {
        releaseReadbackStaging(slot)
        throw cause
    }
}

export function claimReadbackCommand(
    command: ReadbackCommand,
    input: Readonly<{ submissionId: string, stepIndex: number }>
): ReadbackCommandClaim {

    command.assertUsable()
    const commandState = readbackCommandStateFor(command)
    if (commandState.state !== 'idle' || commandState.activeClaim !== undefined) {
        throwScratchDiagnostic({
            code: 'SCRATCH_READBACK_COMMAND_BUSY',
            severity: 'error',
            phase: 'submission',
            subject: command.subject,
            related: [ command.runtime.subject ],
            message: 'ReadbackCommand staging slot is still owned by an earlier result.',
            expected: { state: 'idle' },
            actual: { state: commandState.state, submissionId: input.submissionId, stepIndex: input.stepIndex },
        })
    }
    const claim = constructReadbackCommandClaim({
        command,
        operationId: `scratch-readback-${UUID()}`,
        submissionId: input.submissionId,
        stepIndex: input.stepIndex,
        sourceResourceId: command.source.region.buffer.id,
        allocationVersion: command.source.region.buffer.allocationVersion,
        contentEpoch: command.source.contentEpoch,
        stagingAllocationOperationId: commandState.slot.allocationOperationId,
        done: undefined,
        status: 'claimed',
        operationAdopted: false,
    })
    reserveRuntimeReadbackOperationFact(command.runtime, readbackCommandClaimFact(claim))
    commandState.activeClaim = claim
    commandState.state = 'claimed'
    updateRuntimeReadbackCommand(command.runtime, command.id, { state: 'claimed' })
    return claim
}

export function updateReadbackCommandClaimProvenance(
    claim: ReadbackCommandClaim,
    input: Readonly<{ contentEpoch: number, allocationVersion: number }>
): void {

    const state = assertActiveReadbackCommandClaim(claim)
    state.contentEpoch = input.contentEpoch
    state.allocationVersion = input.allocationVersion
    updateReservedRuntimeReadbackOperationFact(state.command.runtime, state.operationId, input)
}

export function encodeReadbackCommandClaim(
    claim: ReadbackCommandClaim,
    commandEncoder: GPUCommandEncoder
): void {

    const state = assertActiveReadbackCommandClaim(claim)
    const command = state.command
    commandEncoder.copyBufferToBuffer(
        command.source.region.buffer.gpuBuffer,
        command.source.region.offset,
        readbackStagingBuffer(readbackCommandStateFor(command).slot),
        0,
        command.source.region.size
    )
}

export function readbackCommandClaimBuffer(claim: ReadbackCommandClaim): GPUBuffer {

    const state = assertActiveReadbackCommandClaim(claim)
    return readbackStagingBuffer(readbackCommandStateFor(state.command).slot)
}

export function markReadbackCommandClaimSubmitted(claim: ReadbackCommandClaim, done: Promise<unknown>): void {

    const state = assertActiveReadbackCommandClaim(claim)
    state.done = done
    state.status = 'submitted'
    const commandState = readbackCommandStateFor(state.command)
    if (!commandState.disposeRequested) {
        commandState.state = 'submitted'
        updateRuntimeReadbackCommand(state.command.runtime, state.command.id, { state: 'submitted' })
    }
    updateReservedRuntimeReadbackOperationFact(state.command.runtime, state.operationId, { state: 'submitted' })
}

export function markReadbackCommandClaimAdopted(claim: ReadbackCommandClaim): void {

    assertActiveReadbackCommandClaim(claim).operationAdopted = true
}

export function markReadbackCommandClaimMapping(claim: ReadbackCommandClaim): void {

    const state = assertActiveReadbackCommandClaim(claim)
    state.status = 'mapping'
    const commandState = readbackCommandStateFor(state.command)
    if (!commandState.disposeRequested) {
        commandState.state = 'mapping'
        updateRuntimeReadbackCommand(state.command.runtime, state.command.id, { state: 'mapping' })
    }
}

export function releaseReadbackCommandClaim(
    claim: ReadbackCommandClaim,
    options: Readonly<{ unmap: boolean, gpuUseComplete: boolean }>
): ReadbackStagingCleanupResult {

    const state = readbackCommandClaimStateFor(claim)
    if (state.status === 'released' || state.status === 'releasing') {
        return emptyReadbackStagingCleanupResult
    }
    const wasSubmitted = state.done !== undefined
    state.status = 'releasing'
    const commandState = readbackCommandStateFor(state.command)
    commandState.state = 'releasing'
    updateRuntimeReadbackCommand(state.command.runtime, state.command.id, { state: 'releasing' })
    const resetCleanup = resetReadbackStaging(commandState.slot, options.unmap)
    if (!state.operationAdopted) {
        releaseReservedRuntimeReadbackOperationFact(state.command.runtime, state.operationId)
    }
    if (options.gpuUseComplete || !wasSubmitted) {
        const finishCleanup = finishReadbackCommandClaim(
            claim,
            resetCleanup.failures.length === 0,
            false
        )
        return recordReadbackCommandClaimRelease(
            state,
            options.unmap,
            [ ...resetCleanup.failures, ...finishCleanup.failures ]
        )
    }
    void state.done!.then(
        () => finishReadbackCommandClaim(claim, resetCleanup.failures.length === 0, true),
        () => finishReadbackCommandClaim(claim, false, true)
    )
    return recordReadbackCommandClaimRelease(state, options.unmap, resetCleanup.failures)
}

export function registerReadbackCommandResult(
    command: ReadbackCommand,
    after: SubmittedWork,
    operation: ReadbackOperation
): void {

    readbackCommandResults.get(command)?.set(after, operation)
}

function constructReadbackCommand(
    runtime: ScratchRuntime,
    id: string,
    descriptor: NormalizedReadbackCommandDescriptor,
    slot: ReadbackStagingSlot
): ReadbackCommand {

    const Constructor = ReadbackCommand as unknown as new (
        token: symbol,
        runtime: ScratchRuntime,
        id: string,
        descriptor: NormalizedReadbackCommandDescriptor,
        slot: ReadbackStagingSlot
    ) => ReadbackCommand
    return new Constructor(readbackCommandToken, runtime, id, descriptor, slot)
}

function constructReadbackCommandClaim(state: ReadbackCommandClaimPrivateState): ReadbackCommandClaim {

    const Constructor = ReadbackCommandClaim as unknown as new (token: symbol) => ReadbackCommandClaim
    const claim = new Constructor(readbackCommandClaimToken)
    readbackCommandClaimStates.set(claim, state)
    return claim
}

function readbackCommandStateFor(command: ReadbackCommand): ReadbackCommandPrivateState {

    const state = readbackCommandStates.get(command)
    if (state === undefined) throw new TypeError('ReadbackCommand is not Scratch-owned.')
    return state
}

function readbackCommandClaimStateFor(claim: ReadbackCommandClaim): ReadbackCommandClaimPrivateState {

    const state = readbackCommandClaimStates.get(claim)
    if (state === undefined) throw new TypeError('ReadbackCommandClaim is not Scratch-owned.')
    return state
}

function assertActiveReadbackCommandClaim(claim: ReadbackCommandClaim): ReadbackCommandClaimPrivateState {

    const state = readbackCommandClaimStateFor(claim)
    if (state.status === 'released') throw new TypeError(`Readback operation ${state.operationId} released its command slot.`)
    if (readbackCommandStateFor(state.command).activeClaim !== claim) {
        throw new TypeError(`Readback operation ${state.operationId} does not own its command slot.`)
    }
    return state
}

function finishReadbackCommandClaim(
    claim: ReadbackCommandClaim,
    reusable: boolean,
    recordPhysicalIncident: boolean
): ReadbackStagingCleanupResult {

    const state = readbackCommandClaimStateFor(claim)
    if (state.status === 'released') return emptyReadbackStagingCleanupResult
    state.status = 'released'
    const command = state.command
    const commandState = readbackCommandStateFor(command)
    if (commandState.activeClaim === claim) commandState.activeClaim = undefined
    if (!reusable) {
        const cleanup = releaseReadbackStaging(commandState.slot, {
            recordIncident: recordPhysicalIncident,
        })
        if (commandState.disposeRequested) {
            commandState.state = 'disposed'
            unregisterRuntimeReadbackCommand(command.runtime, command)
        } else {
            commandState.state = 'failed'
            updateRuntimeReadbackCommand(command.runtime, command.id, { state: 'failed' })
        }
        return cleanup
    }
    if (commandState.disposeRequested) {
        return finalizeReadbackCommandDisposal(command, recordPhysicalIncident)
    }
    commandState.state = 'idle'
    updateRuntimeReadbackCommand(command.runtime, command.id, { state: 'idle' })
    return emptyReadbackStagingCleanupResult
}

function finalizeReadbackCommandDisposal(
    command: ReadbackCommand,
    recordIncident = true
): ReadbackStagingCleanupResult {

    const state = readbackCommandStateFor(command)
    const cleanup = releaseReadbackStaging(state.slot, { recordIncident })
    state.state = 'disposed'
    unregisterRuntimeReadbackCommand(command.runtime, command)
    return cleanup
}

function recordReadbackCommandClaimRelease(
    state: ReadbackCommandClaimPrivateState,
    unmapRequested: boolean,
    failures: readonly ReadbackStagingCleanupFailure[]
): ReadbackStagingCleanupResult {

    const command = state.command
    const commandState = readbackCommandStateFor(command)
    return recordReadbackStagingRelease({
        runtime: command.runtime,
        target: {
            kind: 'readback',
            readbackId: state.operationId,
            path: 'ordered',
            sourceResourceId: state.sourceResourceId,
            allocationVersion: state.allocationVersion,
            contentEpoch: state.contentEpoch,
            byteLength: command.source.region.size,
            commandId: command.id,
            submissionId: state.submissionId,
            stepIndex: state.stepIndex,
        },
        byteLength: command.source.region.size,
        allocationOperationId: state.stagingAllocationOperationId,
        failures,
        unmapRequested,
        destroyRequested: commandState.slot.isReleased,
    })
}

function readbackCommandFact(command: ReadbackCommand) {

    const state = readbackCommandStateFor(command)
    return {
        id: command.id,
        ...(command.label !== undefined ? { label: command.label } : {}),
        sourceResourceId: command.source.region.buffer.id,
        allocationVersion: command.source.region.buffer.allocationVersion,
        contentEpoch: command.source.contentEpoch,
        byteLength: command.source.region.size,
        state: state.state,
        stagingAllocationOperationId: state.slot.allocationOperationId,
    }
}

function readbackCommandClaimFact(claim: ReadbackCommandClaim) {

    const state = readbackCommandClaimStateFor(claim)
    const command = state.command
    return {
        id: state.operationId,
        ...(command.label !== undefined ? { label: command.label } : {}),
        path: 'ordered' as const,
        state: 'scheduled',
        retain: command.retain,
        sourceResourceId: state.sourceResourceId,
        allocationVersion: state.allocationVersion,
        contentEpoch: state.contentEpoch,
        byteLength: command.source.region.size,
        stagingBytes: command.source.region.size,
        retainedHostBytes: 0,
        isMapping: false,
        commandId: command.id,
        submissionId: state.submissionId,
        stepIndex: state.stepIndex,
        lastStagingOperationId: state.stagingAllocationOperationId,
    }
}

function normalizeReadbackCommandDescriptor(
    runtime: ScratchRuntime,
    id: string,
    descriptor: unknown
): NormalizedReadbackCommandDescriptor {

    const record = isRecord(descriptor) ? descriptor : {}
    const label = typeof record.label === 'string' ? record.label : undefined
    const subject = readbackCommandSubject(runtime, id, label)
    const source = normalizeReadbackCommandSource(runtime, subject, record.source)
    return Object.freeze({
        ...(label !== undefined ? { label } : {}),
        source,
        retain: normalizeReadbackCommandRetention(subject, source, record.retain),
        whenMissing: normalizeReadbackCommandReadinessPolicy(subject, source, record.whenMissing),
    })
}

function normalizeReadbackCommandSource(
    runtime: ScratchRuntime,
    subject: DiagnosticSubject,
    source: unknown
): BufferCopyCommandSourceDescriptor {

    if (!isRecord(source)) throwReadbackCommandSourceDiagnostic(runtime, subject, source)
    const region = source.region
    const contentEpoch = source.contentEpoch
    if (
        !isBufferRegion(region) ||
        typeof contentEpoch !== 'number' ||
        !Number.isInteger(contentEpoch) ||
        contentEpoch < 0
    ) {
        throwReadbackCommandSourceDiagnostic(runtime, subject, source)
    }
    const normalized = Object.freeze({ region, contentEpoch })
    validateCurrentReadbackCommandSource(runtime, subject, normalized)
    return normalized
}

function validateCurrentReadbackCommandSource(
    runtime: ScratchRuntime,
    subject: DiagnosticSubject,
    source: BufferCopyCommandSourceDescriptor
): void {

    const region = source.region
    region.buffer.assertRuntime(runtime)
    region.assertUsable()
    if (region.size <= 0) throwReadbackCommandSourceDiagnostic(runtime, subject, source)
    if (region.offset % 4 !== 0 || region.size % 4 !== 0) {
        throwReadbackCommandSourceDiagnostic(runtime, subject, source, 'copyAlignment')
    }
    if ((region.buffer.usage & GPU_BUFFER_USAGE_COPY_SRC) === 0) {
        throwScratchDiagnostic({
            code: 'SCRATCH_RESOURCE_USAGE_MISSING',
            severity: 'error',
            phase: 'command',
            subject,
            related: [ region.subject, region.buffer.subject, runtime.subject ],
            message: 'ReadbackCommand source requires GPUBufferUsage.COPY_SRC.',
            expected: { usage: 'GPUBufferUsage.COPY_SRC' },
            actual: { usage: region.buffer.usage },
        })
    }
}

function throwReadbackCommandSourceDiagnostic(
    runtime: ScratchRuntime,
    subject: DiagnosticSubject,
    source: unknown,
    reason = 'source'
): never {

    throwScratchDiagnostic({
        code: 'SCRATCH_READBACK_SOURCE_INVALID',
        severity: 'error',
        phase: 'command',
        subject,
        related: [ runtime.subject ],
        message: 'ReadbackCommand requires an explicit, copy-aligned BufferRegion source content epoch.',
        expected: {
            source: {
                region: 'non-empty BufferRegion with 4-byte aligned offset and size',
                contentEpoch: 'non-negative integer',
            },
        },
        actual: {
            reason,
            source: describeValue(source),
            offset: isRecord(source) && isBufferRegion(source.region)
                ? source.region.offset
                : undefined,
            size: isRecord(source) && isBufferRegion(source.region)
                ? source.region.size
                : undefined,
        },
    })
}

function normalizeReadbackCommandRetention(
    subject: DiagnosticSubject,
    source: BufferCopyCommandSourceDescriptor,
    retain: unknown
): ReadbackRetentionPolicy {

    if (retain === undefined) return 'consume-on-read'
    if (retain === 'consume-on-read' || retain === 'until-dispose') return retain
    throwScratchDiagnostic({
        code: 'SCRATCH_READBACK_RETAIN_INVALID',
        severity: 'error',
        phase: 'command',
        subject,
        related: [ source.region.subject ],
        message: 'ReadbackCommand retain must be consume-on-read or until-dispose.',
        expected: { retain: [ 'consume-on-read', 'until-dispose' ] },
        actual: { retain },
    })
}

function normalizeReadbackCommandReadinessPolicy(
    subject: DiagnosticSubject,
    source: BufferCopyCommandSourceDescriptor,
    whenMissing: unknown
): 'throw' {

    if (whenMissing === 'throw') return whenMissing
    throwScratchDiagnostic({
        code: 'SCRATCH_COMMAND_READINESS_POLICY_MISSING',
        severity: 'error',
        phase: 'command',
        subject,
        related: [ source.region.subject ],
        message: 'ReadbackCommand requires an explicit throw readiness policy.',
        expected: { whenMissing: [ 'throw' ] },
        actual: { whenMissing },
    })
}

function readbackCommandSubject(
    runtime: ScratchRuntime,
    id: string,
    label?: string
): DiagnosticSubject {

    return {
        kind: 'Command',
        id,
        commandKind: 'readback',
        ...(label !== undefined ? { label } : {}),
        runtimeId: runtime.id,
    }
}

export interface ResolveQuerySetCommand {
    readonly runtime: ScratchRuntime
    readonly id: string
    readonly label?: string
    readonly commandKind: 'resolve-query-set'
    readonly destination: BufferRegion
    readonly whenMissing: 'throw'
}

export class ResolveQuerySetCommand {

    readonly #source: ResolveQuerySetSourceDescriptor
    #isDisposed = false

    constructor(runtime: ScratchRuntime, descriptor: ResolveQuerySetCommandDescriptor = {} as ResolveQuerySetCommandDescriptor) {

        assertScratchRuntimeActive(runtime)

        const normalizedDescriptor = normalizeResolveDescriptor(runtime, descriptor)
        const source = normalizeResolveSource(runtime, normalizedDescriptor.source)

        const destination = normalizedDescriptor.destination
        if (!isBufferRegion(destination)) {
            throwResolveQuerySetDiagnostic({
                runtime,
                source: normalizedDescriptor.source,
                querySet: source.querySet,
                slots: source.slots,
                firstQuery: source.slots[0]?.index,
                queryCount: source.slots.length,
                destination,
                whenMissing: normalizedDescriptor.whenMissing,
                reason: 'destination',
            })
        }

        destination.buffer.assertRuntime(runtime)
        destination.assertUsable()
        validateResolveDestinationUsage(runtime, destination.buffer)
        validateResolveReadinessPolicy(runtime, normalizedDescriptor.whenMissing, source, destination)

        const mutable = this as Mutable<ResolveQuerySetCommand>
        mutable.runtime = runtime
        mutable.id = `scratch-command-${UUID()}`
        if (normalizedDescriptor.label !== undefined) mutable.label = normalizedDescriptor.label
        mutable.commandKind = 'resolve-query-set'
        this.#source = source
        mutable.destination = destination
        mutable.whenMissing = normalizedDescriptor.whenMissing

        validateResolveQuerySetRange(this)
        commandBrands.set(this, 'resolve-query-set')
        lockCommandProperties(this, [
            'runtime', 'id', 'label', 'commandKind', 'destination', 'whenMissing',
        ])
        Object.preventExtensions(this)
    }

    get source(): ResolveQuerySetSourceDescriptor {

        return this.#source
    }

    get querySet(): QuerySetResource {

        return this.#source.querySet
    }

    get firstQuery(): number {

        return this.#source.slots[0]!.index
    }

    get queryCount(): number {

        return this.#source.slots.length
    }

    get subject(): DiagnosticSubject {

        const subject: DiagnosticSubject = {
            kind: 'Command',
            id: this.id,
            commandKind: 'resolve-query-set',
        }
        if (this.label !== undefined) subject.label = this.label

        return subject
    }

    get isDisposed(): boolean {

        return this.#isDisposed
    }

    assertRuntime(runtime: ScratchRuntime) {

        this.assertUsable()

        if (runtime !== this.runtime) {
            throwScratchDiagnostic({
                code: 'SCRATCH_COMMAND_WRONG_RUNTIME',
                severity: 'error',
                phase: 'command',
                subject: this.subject,
                related: [
                    this.runtime.subject,
                    runtime?.subject,
                ].filter(Boolean),
                message: 'Command belongs to a different ScratchRuntime.',
                expected: { runtimeId: this.runtime.id },
                actual: { runtimeId: runtime?.id },
            })
        }
    }

    assertUsable() {

        if (this.#isDisposed) {
            throwScratchDiagnostic({
                code: 'SCRATCH_COMMAND_DISPOSED',
                severity: 'error',
                phase: 'command',
                subject: this.subject,
                message: 'Command has been disposed.',
            })
        }

        assertScratchRuntimeActive(this.runtime)
        this.querySet.assertUsable()
        this.destination.assertUsable()
        validateResolveDestinationUsage(this.runtime, this.destination.buffer)
        validateResolveQuerySetRange(this)
    }

    encode(commandEncoder: GPUCommandEncoder) {

        this.assertUsable()

        if (!commandEncoder || typeof commandEncoder.resolveQuerySet !== 'function') {
            throwScratchDiagnostic({
                code: 'SCRATCH_RUNTIME_DEVICE_UNAVAILABLE',
                severity: 'error',
                phase: 'runtime',
                subject: this.runtime.subject,
                related: [ this.subject ],
                message: 'ScratchRuntime command encoder cannot resolve GPU query sets.',
                expected: { commandEncoder: 'GPUCommandEncoder with resolveQuerySet()' },
                actual: { resolveQuerySet: typeof commandEncoder?.resolveQuerySet },
            })
        }

        commandEncoder.resolveQuerySet(
            this.querySet.gpuQuerySet,
            this.firstQuery,
            this.queryCount,
            this.destination.buffer.gpuBuffer,
            this.destination.offset
        )
        advanceResourceContentEpoch(this.destination.buffer)
    }

    dispose(): void {

        this.#isDisposed = true
    }
}

export interface TextureUploadCommand {
    readonly runtime: ScratchRuntime
    readonly id: string
    readonly label?: string
    readonly commandKind: 'upload'
    readonly uploadKind: 'texture'
    readonly target: TextureResource
    readonly data: ArrayBuffer | ArrayBufferView
    readonly layout: Readonly<Required<TextureUploadLayout>>
    readonly origin: Readonly<{ x: number, y: number, z: number }>
    readonly size: Readonly<{ width: number, height: number, depthOrArrayLayers: number }>
    readonly mipLevel: number
}

export class TextureUploadCommand {

    #isDisposed = false

    constructor(runtime: ScratchRuntime, descriptor: TextureUploadCommandDescriptor = {} as TextureUploadCommandDescriptor) {

        assertScratchRuntimeActive(runtime)

        const target = descriptor.target
        if (!isTextureResource(target)) {
            throwTextureUploadDiagnostic({
                runtime,
                target,
                data: descriptor.data,
                layout: descriptor.layout,
                size: descriptor.size,
                reason: 'target',
            })
        }

        target.assertRuntime(runtime)

        if ((target.usage & GPU_TEXTURE_USAGE_COPY_DST) === 0) {
            throwScratchDiagnostic({
                code: 'SCRATCH_RESOURCE_USAGE_MISSING',
                severity: 'error',
                phase: 'resource',
                subject: target.subject,
                related: [ runtime.subject ],
                message: 'TextureUploadCommand target requires GPUTextureUsage.COPY_DST.',
                expected: { usage: 'GPUTextureUsage.COPY_DST' },
                actual: { usage: target.usage },
            })
        }

        const mutable = this as Mutable<TextureUploadCommand>
        mutable.runtime = runtime
        mutable.id = `scratch-command-${UUID()}`
        if (descriptor.label !== undefined) mutable.label = descriptor.label
        mutable.commandKind = 'upload'
        mutable.uploadKind = 'texture'
        mutable.target = target
        mutable.data = descriptor.data
        mutable.origin = normalizeTextureUploadOrigin(runtime, descriptor.origin)
        mutable.mipLevel = normalizeTextureUploadMipLevel(runtime, target, descriptor.mipLevel ?? 0)
        mutable.size = normalizeTextureUploadSize(runtime, target, descriptor.size, this.origin)
        mutable.layout = normalizeTextureUploadLayout(runtime, target, descriptor.layout, this.size)

        validateTextureUploadRange(this)
        Object.freeze(this.layout)
        Object.freeze(this.origin)
        Object.freeze(this.size)
        commandBrands.set(this, 'texture-upload')
        lockCommandProperties(this, [
            'runtime', 'id', 'label', 'commandKind', 'uploadKind', 'target', 'data',
            'layout', 'origin', 'size', 'mipLevel',
        ])
        Object.preventExtensions(this)
    }

    get subject(): DiagnosticSubject {

        const subject: DiagnosticSubject = {
            kind: 'Command',
            id: this.id,
            commandKind: 'upload',
            uploadKind: 'texture',
        }
        if (this.label !== undefined) subject.label = this.label

        return subject
    }

    get isDisposed(): boolean {

        return this.#isDisposed
    }

    assertRuntime(runtime: ScratchRuntime) {

        this.assertUsable()

        if (runtime !== this.runtime) {
            throwScratchDiagnostic({
                code: 'SCRATCH_COMMAND_WRONG_RUNTIME',
                severity: 'error',
                phase: 'command',
                subject: this.subject,
                related: [
                    this.runtime.subject,
                    runtime?.subject,
                ].filter(Boolean),
                message: 'Command belongs to a different ScratchRuntime.',
                expected: { runtimeId: this.runtime.id },
                actual: { runtimeId: runtime?.id },
            })
        }
    }

    assertUsable() {

        if (this.#isDisposed) {
            throwScratchDiagnostic({
                code: 'SCRATCH_COMMAND_DISPOSED',
                severity: 'error',
                phase: 'command',
                subject: this.subject,
                message: 'Command has been disposed.',
            })
        }

        assertScratchRuntimeActive(this.runtime)
        this.target.assertUsable()
    }

    execute(queue: GPUQueue) {

        validateUploadCommandQueueAction(this, queue)
        writeUploadCommandQueueAction(this, queue)
        commitUploadCommandLogicalWrite(this)
    }

    dispose(): void {

        this.#isDisposed = true
    }
}

export interface ExternalImageUploadCommand {
    readonly runtime: ScratchRuntime
    readonly id: string
    readonly label?: string
    readonly commandKind: 'upload'
    readonly uploadKind: 'external-image'
    readonly source: GPUCopyExternalImageSource
    readonly sourceOrigin: Readonly<{ x: number, y: number }>
    readonly flipY: boolean
    readonly target: TextureResource
    readonly origin: Readonly<{ x: number, y: number, z: number }>
    readonly mipLevel: number
    readonly colorSpace: PredefinedColorSpace
    readonly premultipliedAlpha: boolean
    readonly size: Readonly<{ width: number, height: number, depthOrArrayLayers: 1 }>
}

export class ExternalImageUploadCommand {

    #isDisposed = false

    constructor(
        runtime: ScratchRuntime,
        descriptor: ExternalImageUploadCommandDescriptor
    ) {

        assertScratchRuntimeActive(runtime)

        if (!isRecord(descriptor)) {
            throwExternalImageUploadInvalid({ runtime, reason: 'descriptor' })
        }

        const target = descriptor.target
        if (!isTextureResource(target)) {
            throwExternalImageUploadInvalid({
                runtime,
                source: descriptor.source,
                target,
                size: descriptor.size,
                reason: 'target',
            })
        }
        target.assertRuntime(runtime)

        const mutable = this as Mutable<ExternalImageUploadCommand>
        mutable.runtime = runtime
        mutable.id = `scratch-command-${UUID()}`
        if (descriptor.label !== undefined) mutable.label = descriptor.label
        mutable.commandKind = 'upload'
        mutable.uploadKind = 'external-image'
        mutable.source = normalizeExternalImageUploadSource(runtime, descriptor.source)
        mutable.sourceOrigin = normalizeExternalImageUploadSourceOrigin(runtime, descriptor.sourceOrigin)
        mutable.flipY = normalizeExternalImageUploadBoolean(runtime, descriptor.flipY ?? false, 'flipY')
        mutable.target = target
        mutable.origin = normalizeExternalImageUploadTargetOrigin(runtime, descriptor.origin)
        mutable.mipLevel = normalizeExternalImageUploadMipLevel(runtime, target, descriptor.mipLevel ?? 0)
        mutable.colorSpace = normalizeExternalImageUploadColorSpace(runtime, descriptor.colorSpace ?? 'srgb')
        mutable.premultipliedAlpha = normalizeExternalImageUploadBoolean(
            runtime,
            descriptor.premultipliedAlpha ?? false,
            'premultiplied-alpha'
        )
        mutable.size = normalizeExternalImageUploadSize(runtime, descriptor.size)

        validateExternalImageUploadTarget(this)
        commandBrands.set(this, 'external-image-upload')
        lockExternalImageUploadCommandContract(this)
    }

    get subject(): DiagnosticSubject {

        const subject: DiagnosticSubject = {
            kind: 'Command',
            id: this.id,
            commandKind: 'upload',
            uploadKind: 'external-image',
        }
        if (this.label !== undefined) subject.label = this.label

        return subject
    }

    get isDisposed(): boolean {

        return this.#isDisposed
    }

    assertRuntime(runtime: ScratchRuntime): void {

        this.assertUsable()

        if (runtime !== this.runtime) {
            throwScratchDiagnostic({
                code: 'SCRATCH_COMMAND_WRONG_RUNTIME',
                severity: 'error',
                phase: 'command',
                subject: this.subject,
                related: [ this.runtime.subject, runtime?.subject ].filter(Boolean),
                message: 'Command belongs to a different ScratchRuntime.',
                expected: { runtimeId: this.runtime.id },
                actual: { runtimeId: runtime?.id },
            })
        }
    }

    assertUsable(): void {

        if (this.isDisposed) {
            throwScratchDiagnostic({
                code: 'SCRATCH_COMMAND_DISPOSED',
                severity: 'error',
                phase: 'command',
                subject: this.subject,
                message: 'Command has been disposed.',
            })
        }

        assertScratchRuntimeActive(this.runtime)
        this.target.assertRuntime(this.runtime)
    }

    execute(queue: GPUQueue): void {

        validateUploadCommandQueueAction(this, queue)
        writeUploadCommandQueueAction(this, queue)
        commitUploadCommandLogicalWrite(this)
    }

    dispose(): void {

        this.#isDisposed = true
    }
}

export function validateUploadCommandQueueAction(
    command: UploadCommand | TextureUploadCommand | ExternalImageUploadCommand,
    queue: GPUQueue
): void {

    command.assertUsable()

    switch (command.uploadKind) {
        case 'buffer':
            validateBufferUploadUsage(command.runtime, command.target)
            if (!queue || typeof queue.writeBuffer !== 'function') {
                throwScratchDiagnostic({
                    code: 'SCRATCH_RUNTIME_DEVICE_UNAVAILABLE',
                    severity: 'error',
                    phase: 'runtime',
                    subject: command.runtime.subject,
                    related: [ command.subject ],
                    message: 'ScratchRuntime queue cannot write GPU buffers.',
                    expected: { queue: 'GPUQueue with writeBuffer()' },
                    actual: { writeBuffer: typeof queue?.writeBuffer },
                })
            }
            validateUploadCommandQueueOwner(command, queue)
            validateUploadRange(command)
            return
        case 'texture':
            if (!queue || typeof queue.writeTexture !== 'function') {
                throwScratchDiagnostic({
                    code: 'SCRATCH_RUNTIME_DEVICE_UNAVAILABLE',
                    severity: 'error',
                    phase: 'runtime',
                    subject: command.runtime.subject,
                    related: [ command.subject ],
                    message: 'ScratchRuntime queue cannot write GPU textures.',
                    expected: { queue: 'GPUQueue with writeTexture()' },
                    actual: { writeTexture: typeof queue?.writeTexture },
                })
            }
            validateUploadCommandQueueOwner(command, queue)
            validateTextureUploadRange(command)
            return
        case 'external-image':
            validateExternalImageUploadQueueAction(command, queue)
            return
        default:
            return assertNeverUploadCommand(command)
    }
}

function validateUploadCommandQueueOwner(
    command: UploadCommand | TextureUploadCommand | ExternalImageUploadCommand,
    queue: GPUQueue
): void {

    if (queue === command.runtime.queue) return

    throwScratchDiagnostic({
        code: 'SCRATCH_COMMAND_WRONG_RUNTIME',
        severity: 'error',
        phase: 'command',
        subject: command.subject,
        related: [ command.runtime.subject ],
        message: 'Upload command queue is not owned by its ScratchRuntime.',
        expected: {
            queueOwnedByRuntime: true,
            runtimeId: command.runtime.id,
        },
        actual: {
            queueOwnedByRuntime: false,
        },
    })
}

export function writeUploadCommandQueueAction(
    command: UploadCommand | TextureUploadCommand | ExternalImageUploadCommand,
    queue: GPUQueue
): void {

    switch (command.uploadKind) {
        case 'buffer':
            queue.writeBuffer(
                command.target.buffer.gpuBuffer,
                command.target.offset,
                createUploadSource(command.data, command.dataOffset, command.byteLength)
            )
            return
        case 'texture':
            queue.writeTexture(
                {
                    texture: command.target.gpuTexture,
                    mipLevel: command.mipLevel,
                    origin: command.origin,
                },
                command.data,
                command.layout,
                command.size
            )
            return
        case 'external-image':
            writeExternalImageUploadQueueAction(command, queue)
            return
        default:
            return assertNeverUploadCommand(command)
    }
}

export function uploadCommandHasContentEffect(
    command: UploadCommand | TextureUploadCommand | ExternalImageUploadCommand
): boolean {

    return command.uploadKind !== 'external-image' || (command.size.width > 0 && command.size.height > 0)
}

export function commitUploadCommandLogicalWrite(
    command: UploadCommand | TextureUploadCommand | ExternalImageUploadCommand
): void {

    if (!uploadCommandHasContentEffect(command)) return
    advanceResourceContentEpoch(command.uploadKind === 'buffer' ? command.target.buffer : command.target)
}

function assertNeverUploadCommand(command: never): never {

    throw new TypeError(`Unsupported upload command: ${describeValue(command)}`)
}

function normalizeOcclusionQueryIndex(runtime: ScratchRuntime, querySet: QuerySetResource, index: number): number {

    if (!Number.isInteger(index) || index < 0 || index >= querySet.count) {
        throwOcclusionQueryCommandDiagnostic({ runtime, querySet, index, reason: 'index' })
    }

    return index
}

function throwOcclusionQueryCommandDiagnostic({ runtime, querySet, index, reason }: OcclusionQueryCommandDiagnosticInput): never {

    throwScratchDiagnostic({
        code: 'SCRATCH_COMMAND_OCCLUSION_QUERY_INVALID',
        severity: 'error',
        phase: 'command',
        subject: { kind: 'Command', commandKind: 'begin-occlusion-query' },
        related: [
            runtime?.subject,
            diagnosticSubjectOf(querySet),
        ].filter(isDefined),
        message: 'BeginOcclusionQueryCommand requires an occlusion QuerySetResource and a valid query slot index.',
        expected: {
            querySet: 'occlusion QuerySetResource owned by this ScratchRuntime',
            index: 'integer query index within querySet.count',
        },
        actual: {
            reason,
            querySet: describeValue(querySet),
            querySetType: isQuerySetResource(querySet) ? querySet.type : undefined,
            index,
        },
    })
}

type DynamicOffsetCommand = DrawCommand | DispatchCommand
type DynamicBufferBindLayoutEntry = Extract<
    NormalizedBindLayoutEntry,
    { type: 'uniform' | 'read-storage' | 'storage' }
> & {
    type: 'uniform' | 'read-storage' | 'storage'
    hasDynamicOffset: true
}

type CommandDynamicOffsetContract = Readonly<{
    entries: readonly DynamicBufferBindLayoutEntry[]
    nativeOffsets: readonly number[]
}>

const commandDynamicOffsetContracts = new WeakMap<
    DynamicOffsetCommand,
    ReadonlyMap<number, CommandDynamicOffsetContract>
>()

function rejectRemovedCommandDynamicOffsets(command: DynamicOffsetCommand, descriptor: unknown): void {

    if (!isRecord(descriptor) || !Object.prototype.hasOwnProperty.call(descriptor, 'dynamicOffsets')) return

    throwScratchDiagnostic({
        code: 'SCRATCH_BIND_DYNAMIC_OFFSET_INVALID',
        severity: 'error',
        phase: 'binding',
        subject: command.subject,
        related: [ command.pipeline.subject ],
        message: 'Dynamic offsets belong to each Command BindSet invocation.',
        expected: {
            bindSets: [ {
                set: 'BindSet',
                dynamicOffsets: 'Record<string, number>',
            } ],
        },
        actual: { dynamicOffsets: describeValue(descriptor.dynamicOffsets) },
    })
}

function normalizeBindSetInvocations(
    command: DynamicOffsetCommand,
    bindSets: CommandBindSetInvocation[] = []
): CommandBindSetInvocation[] {

    if (!Array.isArray(bindSets)) {
        throwScratchDiagnostic({
            code: 'SCRATCH_PIPELINE_BIND_LAYOUT_INCOMPATIBLE',
            severity: 'error',
            phase: 'pipeline',
            subject: command.pipeline.subject,
            related: [ command.subject ],
            message: 'Command bindSets must be an array of BindSet invocations.',
            expected: { bindSets: 'CommandBindSetInvocation[]' },
            actual: { bindSets: describeValue(bindSets) },
        })
    }

    const groups = new Set<number>()
    const dynamicOffsetContracts = new Map<number, CommandDynamicOffsetContract>()
    const normalized = bindSets.map((invocation): CommandBindSetInvocation => {
        if (!isRecord(invocation) || !('set' in invocation)) {
            throwScratchDiagnostic({
                code: 'SCRATCH_PIPELINE_BIND_LAYOUT_INCOMPATIBLE',
                severity: 'error',
                phase: 'pipeline',
                subject: command.pipeline.subject,
                related: [ command.subject ],
                message: 'Command bindSets must contain explicit BindSet invocation objects.',
                expected: {
                    invocation: '{ set: BindSet, dynamicOffsets?: Record<string, number> }',
                },
                actual: { invocation: describeValue(invocation) },
            })
        }

        const bindSet = invocation.set
        if (!isBindSet(bindSet)) {
            throwScratchDiagnostic({
                code: 'SCRATCH_PIPELINE_BIND_LAYOUT_INCOMPATIBLE',
                severity: 'error',
                phase: 'pipeline',
                subject: command.pipeline.subject,
                related: [ command.subject ],
                message: 'Command BindSet invocation requires a BindSet.',
                expected: { set: 'BindSet' },
                actual: { set: describeValue(bindSet) },
            })
        }

        bindSet.assertRuntime(command.runtime)
        const group = bindSet.layout.group
        const expectedLayout = command.pipeline.bindLayoutsByGroup.get(group)
        if (expectedLayout !== bindSet.layout) {
            throwScratchDiagnostic({
                code: 'SCRATCH_PIPELINE_BIND_LAYOUT_INCOMPATIBLE',
                severity: 'error',
                phase: 'pipeline',
                subject: command.pipeline.subject,
                related: [
                    command.subject,
                    bindSet.subject,
                    bindSet.layout.subject,
                ],
                message: 'Command BindSet layout is not part of its Pipeline layout.',
                expected: { group, layoutId: expectedLayout?.id },
                actual: { group, layoutId: bindSet.layout.id },
            })
        }

        if (groups.has(group)) {
            throwScratchDiagnostic({
                code: 'SCRATCH_PIPELINE_BIND_LAYOUT_INCOMPATIBLE',
                severity: 'error',
                phase: 'pipeline',
                subject: command.pipeline.subject,
                related: [ command.subject, bindSet.subject ],
                message: 'Command BindSet invocations must use each bind group at most once.',
                expected: { uniqueGroup: group },
                actual: { duplicateGroup: group },
            })
        }
        groups.add(group)

        const offsets = normalizeInvocationDynamicOffsets(command, bindSet, invocation.dynamicOffsets)
        if (offsets.entries.length > 0) {
            dynamicOffsetContracts.set(group, Object.freeze({
                entries: offsets.entries,
                nativeOffsets: offsets.native,
            }))
        }

        const result: {
            set: BindSet
            dynamicOffsets?: Readonly<Record<string, number>>
        } = { set: bindSet }
        if (offsets.public !== undefined) result.dynamicOffsets = offsets.public
        return result
    })

    commandDynamicOffsetContracts.set(command, readonlyMapSnapshot(dynamicOffsetContracts))
    return normalized
}

function normalizeInvocationDynamicOffsets(
    command: DynamicOffsetCommand,
    bindSet: BindSet,
    supplied: unknown
): Readonly<{
    public: Readonly<Record<string, number>> | undefined
    entries: readonly DynamicBufferBindLayoutEntry[]
    native: readonly number[]
}> {

    const entries = dynamicBufferEntries(bindSet)
    if (supplied !== undefined && (!isRecord(supplied) || Array.isArray(supplied))) {
        throwScratchDiagnostic({
            code: 'SCRATCH_BIND_DYNAMIC_OFFSET_INVALID',
            severity: 'error',
            phase: 'binding',
            subject: bindSet.subject,
            related: [ command.subject, bindSet.layout.subject ],
            message: 'BindSet invocation dynamicOffsets must be keyed by binding name.',
            expected: { dynamicOffsets: 'Record<string, number>' },
            actual: { dynamicOffsets: Array.isArray(supplied) ? 'array' : describeValue(supplied) },
        })
    }

    const record = supplied as Record<string, unknown> | undefined
    const expectedNames = entries.map(entry => entry.name)
    const actualNames = record === undefined ? [] : Object.keys(record).sort()
    const missing = expectedNames.filter(name => !actualNames.includes(name))
    const extra = actualNames.filter(name => !expectedNames.includes(name))

    if (missing.length > 0 || extra.length > 0) {
        const onlyMissing = missing.length > 0 && extra.length === 0
        throwScratchDiagnostic({
            code: onlyMissing
                ? 'SCRATCH_BIND_DYNAMIC_OFFSET_MISSING'
                : 'SCRATCH_BIND_DYNAMIC_OFFSET_INVALID',
            severity: 'error',
            phase: 'binding',
            subject: onlyMissing
                ? bindSet.layout.entrySubject(entries.find(entry => entry.name === missing[0]))
                : bindSet.subject,
            related: dynamicOffsetRelatedSubjects(
                command,
                bindSet,
                entries.find(entry => entry.name === missing[0])
            ),
            message: 'BindSet invocation dynamic offsets must exactly cover its dynamic buffer entries.',
            expected: { group: bindSet.layout.group, names: expectedNames },
            actual: {
                group: bindSet.layout.group,
                names: actualNames,
                ...(!onlyMissing && missing.length > 0 ? { missing } : {}),
                ...(!onlyMissing && extra.length > 0 && missing.length > 0 ? { extra } : {}),
            },
        })
    }

    const normalizedRecord: Record<string, number> = {}
    const native = entries.map((entry) => {
        const offset = record![entry.name]
        validateDynamicOffsetValue(command, bindSet, entry, offset)
        normalizedRecord[entry.name] = offset as number
        return offset as number
    })

    Object.freeze(native)
    return Object.freeze({
        public: supplied === undefined ? undefined : Object.freeze(normalizedRecord),
        entries,
        native,
    })
}

function dynamicBufferEntries(bindSet: BindSet): readonly DynamicBufferBindLayoutEntry[] {

    return Object.freeze(bindSet.layout.entries
        .filter((entry): entry is DynamicBufferBindLayoutEntry =>
            (entry.type === 'uniform' || entry.type === 'read-storage' || entry.type === 'storage') &&
            entry.hasDynamicOffset === true
        )
        .sort((a, b) => a.binding - b.binding))
}

function validateDynamicOffsetValue(
    command: DynamicOffsetCommand,
    bindSet: BindSet,
    entry: DynamicBufferBindLayoutEntry,
    offset: unknown
): void {

    if (
        typeof offset !== 'number' ||
        !Number.isFinite(offset) ||
        !Number.isInteger(offset) ||
        offset < 0 ||
        offset > GPU_SIZE_32_MAX
    ) {
        throwScratchDiagnostic({
            code: 'SCRATCH_BIND_DYNAMIC_OFFSET_INVALID',
            severity: 'error',
            phase: 'binding',
            subject: bindSet.layout.entrySubject(entry),
            related: dynamicOffsetRelatedSubjects(command, bindSet, entry),
            message: 'Command dynamic offsets must be WebGPU uint32 values.',
            expected: { offset: 'uint32' },
            actual: {
                group: bindSet.layout.group,
                binding: entry.binding,
                name: entry.name,
                offset,
            },
        })
    }

    const binding = bindSet.bindings.get(entry.name)
    if (binding === undefined || !isBufferRegion(binding.resource)) {
        throwScratchDiagnostic({
            code: 'SCRATCH_BIND_DYNAMIC_OFFSET_INVALID',
            severity: 'error',
            phase: 'binding',
            subject: bindSet.layout.entrySubject(entry),
            related: dynamicOffsetRelatedSubjects(command, bindSet, entry),
            message: 'Dynamic buffer entry does not resolve to a BufferRegion.',
            expected: { resource: 'BufferRegion' },
            actual: { resource: describeValue(binding?.resource) },
        })
    }

    const region = binding.resource
    const effectiveOffset = region.offset + offset
    const effectiveEnd = effectiveOffset + region.size
    const alignment = dynamicOffsetAlignment(command, entry)
    if (effectiveOffset % alignment !== 0) {
        throwScratchDiagnostic({
            code: 'SCRATCH_BIND_DYNAMIC_OFFSET_UNALIGNED',
            severity: 'error',
            phase: 'binding',
            subject: bindSet.layout.entrySubject(entry),
            related: dynamicOffsetRelatedSubjects(command, bindSet, entry),
            message: 'Command dynamic offset does not satisfy WebGPU alignment limits.',
            expected: { alignment },
            actual: {
                group: bindSet.layout.group,
                binding: entry.binding,
                name: entry.name,
                offset,
                effectiveOffset,
            },
        })
    }

    if (
        !Number.isSafeInteger(effectiveOffset) ||
        !Number.isSafeInteger(effectiveEnd) ||
        effectiveEnd > region.buffer.size
    ) {
        throwScratchDiagnostic({
            code: 'SCRATCH_BIND_DYNAMIC_OFFSET_OUT_OF_BOUNDS',
            severity: 'error',
            phase: 'binding',
            subject: bindSet.layout.entrySubject(entry),
            related: dynamicOffsetRelatedSubjects(command, bindSet, entry),
            message: 'Dynamic buffer offset moves the bound region outside its parent allocation.',
            expected: {
                bufferSize: region.buffer.size,
                effectiveEnd: '<= bufferSize',
            },
            actual: {
                group: bindSet.layout.group,
                binding: entry.binding,
                name: entry.name,
                regionOffset: region.offset,
                dynamicOffset: offset,
                effectiveOffset,
                effectiveSize: region.size,
                effectiveEnd,
            },
        })
    }
}

function validateCurrentDynamicOffsets(command: DynamicOffsetCommand): void {

    const contractsByGroup = commandDynamicOffsetContracts.get(command)
    for (const invocation of command.bindSets) {
        const contract = contractsByGroup?.get(invocation.set.layout.group)
        if (contract === undefined) continue
        for (let index = 0; index < contract.entries.length; index++) {
            validateDynamicOffsetValue(
                command,
                invocation.set,
                contract.entries[index]!,
                contract.nativeOffsets[index]
            )
        }
    }
}

function dynamicOffsetAlignment(command: DynamicOffsetCommand, entry: DynamicBufferBindLayoutEntry): number {

    const limits = command.runtime.device.limits
    const alignment = entry.type === 'uniform'
        ? limits.minUniformBufferOffsetAlignment
        : limits.minStorageBufferOffsetAlignment

    if (Number.isInteger(alignment) && alignment > 0) return alignment

    return 256
}

function dynamicOffsetRelatedSubjects(
    command: DynamicOffsetCommand,
    bindSet: BindSet,
    entry?: DynamicBufferBindLayoutEntry
): DiagnosticSubject[] {

    const binding = entry === undefined ? undefined : bindSet.bindings.get(entry.name)

    return [
        command.subject,
        bindSet.subject,
        bindSet.layout.subject,
        binding === undefined ? undefined : diagnosticSubjectOf(binding.resource),
    ].filter(isDefined)
}

function setBindGroupWithDynamicOffsets(
    command: DynamicOffsetCommand,
    passEncoder: GPURenderPassEncoder | GPUComputePassEncoder,
    invocation: CommandBindSetInvocation
): void {

    const bindSet = invocation.set
    const contract = commandDynamicOffsetContracts.get(command)?.get(bindSet.layout.group)
    if (contract !== undefined) {
        passEncoder.setBindGroup(
            bindSet.layout.group,
            preparedBindGroupFor(bindSet),
            contract.nativeOffsets
        )
        return
    }

    passEncoder.setBindGroup(bindSet.layout.group, preparedBindGroupFor(bindSet))
}

function validateProgramLayoutRequirementsForCommand(command: DrawCommand | DispatchCommand): void {

    for (const requirement of programLayoutRequirementsForPipeline(command.pipeline)) {
        const invocation = command.bindSets.find(candidate => candidate.set.layout.group === requirement.group)
        if (invocation === undefined) {
            throwCommandProgramLayoutMismatch(command, requirement, {
                actual: {
                    bindSetGroups: command.bindSets.map(candidate => candidate.set.layout.group),
                },
            })
        }
        const bindSet = invocation.set

        const binding = [ ...bindSet.bindings.values() ].find(candidate => candidate.entry.binding === requirement.binding)
        if (binding === undefined) {
            throwCommandProgramLayoutMismatch(command, requirement, {
                bindSet,
                actual: {
                    group: bindSet.layout.group,
                    bindings: [ ...bindSet.bindings.values() ].map(candidate => candidate.entry.binding),
                },
            })
        }

        if (!isBufferRegion(binding.resource)) {
            throwCommandProgramLayoutMismatch(command, requirement, {
                bindSet,
                entry: binding.entry,
                resource: diagnosticSubjectOf(binding.resource),
                actual: { resource: describeValue(binding.resource) },
            })
        }

        const region = binding.resource
        if (region.layout === undefined) {
            throwCommandProgramLayoutMismatch(command, requirement, {
                bindSet,
                entry: binding.entry,
                resource: region.subject,
                actual: { abiHash: undefined, schemaHash: undefined },
            })
        }

        if (!layoutArtifactsAbiCompatible(requirement.layout, region.layout)) {
            throwCommandProgramLayoutMismatch(command, requirement, {
                bindSet,
                entry: binding.entry,
                resource: region.subject,
                actualLayout: layoutArtifactSubject(region.layout),
                actual: {
                    abiHash: region.layout.abiHash,
                    schemaHash: region.layout.schemaHash,
                    difference: describeLayoutCompatibilityDifference(
                        requirement.layout,
                        region.layout,
                        'abi'
                    ),
                },
            })
        }

        if (!layoutArtifactsSchemaCompatible(requirement.layout, region.layout)) {
            throwCommandProgramLayoutMismatch(command, requirement, {
                bindSet,
                entry: binding.entry,
                resource: region.subject,
                actualLayout: layoutArtifactSubject(region.layout),
                actual: {
                    abiHash: region.layout.abiHash,
                    schemaHash: region.layout.schemaHash,
                    difference: describeLayoutCompatibilityDifference(
                        requirement.layout,
                        region.layout,
                        'schema'
                    ),
                },
            })
        }
    }
}

function throwCommandProgramLayoutMismatch(
    command: DrawCommand | DispatchCommand,
    requirement: ProgramBufferLayoutRequirement,
    details: {
        actual: unknown
        bindSet?: BindSet
        entry?: NormalizedBindLayoutEntry
        resource?: DiagnosticSubject | undefined
        actualLayout?: DiagnosticSubject | undefined
    }
): never {

    const related: Array<DiagnosticSubject | undefined> = [
        command.pipeline.program.subject,
        command.pipeline.subject,
        command.subject,
        details.bindSet?.subject,
        details.bindSet?.layout.subject,
        details.bindSet !== undefined && details.entry !== undefined
            ? details.bindSet.layout.entrySubject(details.entry)
            : undefined,
        details.resource,
        layoutArtifactSubject(requirement.layout),
        details.actualLayout,
    ]

    throwScratchDiagnostic({
        code: 'SCRATCH_PROGRAM_ACCESSOR_LAYOUT_MISMATCH',
        severity: 'error',
        phase: 'program',
        subject: programLayoutRequirementSubject(requirement),
        related: related.filter(isDefined),
        message: 'Command bind sets do not satisfy Program buffer layout requirements.',
        expected: programLayoutRequirementExpected(requirement),
        actual: details.actual,
    })
}

function normalizeVertexBuffers(
    command: DrawCommand,
    vertexBuffers: DrawVertexBufferBinding[] = []
): NormalizedDrawVertexBufferBinding[] {

    if (!Array.isArray(vertexBuffers)) {
        throwVertexBufferDiagnostic(command, {
            expected: { vertexBuffers: 'DrawVertexBufferBinding[]' },
            actual: { vertexBuffers },
        })
    }

    const slots = new Set<number>()
    const normalized = vertexBuffers.map((binding: DrawVertexBufferBinding) => {
        if (!binding || typeof binding !== 'object') {
            throwVertexBufferDiagnostic(command, {
                expected: { binding: 'DrawVertexBufferBinding' },
                actual: { binding: binding === undefined || binding === null ? String(binding) : typeof binding },
            })
        }

        if (!Number.isInteger(binding.slot) || binding.slot < 0) {
            throwVertexBufferDiagnostic(command, {
                expected: { slot: 'non-negative integer' },
                actual: { slot: binding.slot },
            })
        }

        if (binding.slot >= command.pipeline.vertexBuffers.length) {
            throwVertexBufferDiagnostic(command, {
                expected: { slot: `0..${Math.max(0, command.pipeline.vertexBuffers.length - 1)}` },
                actual: { slot: binding.slot },
            })
        }

        if (command.pipeline.vertexBuffers[binding.slot] === null) {
            throwVertexBufferDiagnostic(command, {
                expected: { pipelineLayout: 'non-null GPUVertexBufferLayout' },
                actual: { slot: binding.slot, pipelineLayout: null },
            })
        }

        if (slots.has(binding.slot)) {
            throwVertexBufferDiagnostic(command, {
                expected: { slot: 'unique' },
                actual: { slot: binding.slot },
            })
        }
        slots.add(binding.slot)

        const region = binding.region
        if (!isBufferRegion(region)) {
            throwVertexBufferDiagnostic(command, {
                expected: { region: 'BufferRegion' },
                actual: {
                    region: describeValue(region),
                },
            })
        }

        validateCurrentVertexBufferBinding(command, binding)

        const normalized: NormalizedDrawVertexBufferBinding = { slot: binding.slot, region }

        return normalized
    })

    const requiredSlots = command.pipeline.vertexBuffers.flatMap((layout, slot) =>
        layout === null ? [] : [ slot ]
    )
    const boundSlots = normalized.map(binding => binding.slot)
    const missingSlots = requiredSlots.filter(slot => !slots.has(slot))
    if (missingSlots.length > 0) {
        throwVertexBufferDiagnostic(command, {
            expected: { vertexBuffers: 'binding for every RenderPipeline vertex buffer slot' },
            actual: { requiredSlots, boundSlots, missingSlots },
            related: [ command.pipeline.subject ],
        })
    }

    return normalized
}

function normalizeIndexBuffer(
    command: DrawCommand,
    binding: DrawIndexBufferBinding | undefined
): NormalizedDrawIndexBufferBinding | undefined {

    if (binding === undefined) return undefined

    if (!isRecord(binding)) {
        throwIndexBufferDiagnostic(command, binding, {
            expected: { indexBuffer: 'DrawIndexBufferBinding' },
            actual: { indexBuffer: describeValue(binding) },
        })
    }

    const region = binding.region
    if (!isBufferRegion(region)) {
        throwIndexBufferDiagnostic(command, binding, {
            expected: { region: 'BufferRegion' },
            actual: { region: describeValue(region) },
        })
    }

    validateCurrentIndexBufferBinding(command, binding)

    return { region, format: binding.format }
}

function normalizeDispatchCount(command: DispatchCommand, count: DispatchCount): { workgroups: [number, number, number] } | NormalizedIndirectCommandCount {

    if (isRecord(count) && 'indirect' in count && 'workgroups' in count) {
        throwDispatchCountDiagnostic(command, count)
    }

    if (isRecord(count) && 'indirect' in count) {
        return normalizeIndirectCommandCount(command, count, DISPATCH_INDIRECT_BYTE_LENGTH, 'dispatch')
    }

    if (!count || typeof count !== 'object' || !('workgroups' in count) || !Array.isArray(count.workgroups)) {
        throwDispatchCountDiagnostic(command, count)
    }

    if (count.workgroups.length < 1 || count.workgroups.length > 3) {
        throwDispatchCountDiagnostic(command, count)
    }

    const workgroups: [number, number, number] = [
        count.workgroups[0],
        count.workgroups[1] ?? 1,
        count.workgroups[2] ?? 1,
    ]

    const maxWorkgroupsPerDimension = command.runtime.deviceLimits.maxComputeWorkgroupsPerDimension
    for (const value of workgroups) {
        if (!isGpuSize32(value) || value > maxWorkgroupsPerDimension) {
            throwScratchDiagnostic({
                code: 'SCRATCH_COMMAND_COUNT_INVALID',
                severity: 'error',
                phase: 'command',
                subject: command.subject,
                related: [ command.pipeline.subject ],
                message: 'DispatchCommand workgroup counts must be unsigned 32-bit integers within the device limit.',
                expected: {
                    workgroups: 'unsigned 32-bit integer tuple',
                    maxComputeWorkgroupsPerDimension: maxWorkgroupsPerDimension,
                },
                actual: { workgroups: count.workgroups },
            })
        }
    }

    return { workgroups }
}

function normalizeResourceAccess(command: DrawCommand | DispatchCommand, resources: CommandResourceAccessDescriptor) {

    if (!resources || typeof resources !== 'object' || !Array.isArray(resources.read) || !Array.isArray(resources.write)) {
        throwScratchDiagnostic({
            code: 'SCRATCH_COMMAND_DECLARED_ACCESS_INCOMPLETE',
            severity: 'error',
            phase: 'command',
            subject: command.subject,
            message: 'Command requires explicit read and write resource declarations.',
            expected: { resources: { read: 'CommandResourceReadDescriptor[]', write: '(BufferResource | TextureResource)[]' } },
            actual: { resources },
        })
    }

    return {
        read: normalizeResourceReadList(command, resources.read),
        write: normalizeResourceList(command, resources.write, 'write'),
    }
}

function validateDrawFixedFunctionReads(command: DrawCommand): void {

    for (const binding of command.vertexBuffers) {
        assertDeclaredCommandRead(command, binding.region.buffer, 'vertex-buffer', { slot: binding.slot })
    }

    if (command.indexBuffer !== undefined) {
        assertDeclaredCommandRead(command, command.indexBuffer.region.buffer, 'index-buffer')
    }

    if ('indirect' in command.count) {
        assertDeclaredCommandRead(command, command.count.indirect.buffer, 'indirect-buffer')
    }
}

function validateDispatchFixedFunctionReads(command: DispatchCommand): void {

    if ('indirect' in command.count) {
        assertDeclaredCommandRead(command, command.count.indirect.buffer, 'indirect-buffer')
    }
}

type BoundResourceAccess = Readonly<{
    read: boolean
    write: boolean
}>

function validateBoundResourceAccess(command: DrawCommand | DispatchCommand): void {

    const declaredReads = new Set(command.resources.read.map(read => read.resource))
    const declaredWrites = new Set(command.resources.write)

    for (const invocation of command.bindSets) {
        const bindSet = invocation.set
        for (const binding of bindSet.bindings.values()) {
            const access = boundResourceAccess(binding.entry)
            if (!access.read && !access.write) continue

            const resource = isBufferRegion(binding.resource)
                ? binding.resource.buffer
                : 'texture' in binding.resource
                    ? binding.resource.texture
                    : undefined
            if (resource === undefined) continue

            const missingRead = access.read && !declaredReads.has(resource)
            const missingWrite = access.write && !declaredWrites.has(resource)
            if (!missingRead && !missingWrite) continue

            throwScratchDiagnostic({
                code: 'SCRATCH_COMMAND_DECLARED_ACCESS_INCOMPLETE',
                severity: 'error',
                phase: 'command',
                subject: bindSet.layout.entrySubject(binding.entry),
                related: [
                    command.subject,
                    command.pipeline.subject,
                    bindSet.subject,
                    bindSet.layout.subject,
                    resource.subject,
                ],
                message: 'Command resource declarations do not cover a bound resource access contract.',
                expected: {
                    group: bindSet.layout.group,
                    binding: binding.entry.binding,
                    name: binding.entry.name,
                    access,
                    resourceId: resource.id,
                },
                actual: {
                    missing: {
                        read: missingRead,
                        write: missingWrite,
                    },
                    declaredReadResourceIds: [ ...declaredReads ].map(candidate => candidate.id),
                    declaredWriteResourceIds: [ ...declaredWrites ].map(candidate => candidate.id),
                },
            })
        }
    }
}

function boundResourceAccess(entry: NormalizedBindLayoutEntry): BoundResourceAccess {

    switch (entry.type) {
        case 'uniform':
        case 'read-storage':
        case 'texture':
            return { read: true, write: false }
        case 'storage':
            return { read: true, write: true }
        case 'storage-texture':
            return {
                read: entry.access === 'read-only' || entry.access === 'read-write',
                write: entry.access === 'write-only' || entry.access === 'read-write',
            }
        case 'sampler':
            return { read: false, write: false }
    }
}

function assertDeclaredCommandRead(
    command: DrawCommand | DispatchCommand,
    resource: BufferResource,
    role: 'vertex-buffer' | 'index-buffer' | 'indirect-buffer',
    details: Record<string, unknown> = {}
): void {

    if (command.resources.read.some(read => read.resource === resource)) return

    throwScratchDiagnostic({
        code: 'SCRATCH_COMMAND_DECLARED_ACCESS_INCOMPLETE',
        severity: 'error',
        phase: 'command',
        subject: command.subject,
        related: [ resource.subject, command.pipeline.subject ],
        message: 'Command fixed-function buffers require explicit resource read declarations.',
        expected: {
            read: {
                role,
                resourceId: resource.id,
                contentEpoch: 'non-negative integer | "current-at-step"',
            },
        },
        actual: {
            role,
            resourceId: resource.id,
            declaredReadResourceIds: command.resources.read.map(read => read.resource.id),
            ...details,
        },
    })
}

function normalizeResourceReadList(
    command: DrawCommand | DispatchCommand,
    resources: readonly CommandResourceReadDescriptor[]
): CommandResourceReadDescriptor[] {

    return resources.map((descriptor) => {
        if (isResourceLike(descriptor)) {
            throwResourceReadDescriptorDiagnostic(command, descriptor, 'descriptor')
        }

        if (!isRecord(descriptor)) {
            throwResourceReadDescriptorDiagnostic(command, descriptor, 'descriptor')
        }

        const resource = descriptor.resource
        if (!isResourceLike(resource)) {
            throwResourceReadDescriptorDiagnostic(command, descriptor, 'resource')
        }

        const contentEpoch = descriptor.contentEpoch
        if (contentEpoch !== 'current-at-step' && (!Number.isInteger(contentEpoch) || contentEpoch < 0)) {
            throwResourceReadDescriptorDiagnostic(command, descriptor, 'contentEpoch')
        }

        resource.assertRuntime(command.runtime)

        return { resource, contentEpoch }
    })
}

function normalizeResourceList(
    command: DrawCommand | DispatchCommand,
    resources: readonly (BufferResource | TextureResource)[],
    access: 'read' | 'write'
): (BufferResource | TextureResource)[] {

    const normalized: (BufferResource | TextureResource)[] = []
    const seen = new Set<BufferResource | TextureResource>()

    for (const resource of resources) {
        if (!isContentResource(resource)) {
            throwScratchDiagnostic({
                code: 'SCRATCH_COMMAND_DECLARED_ACCESS_INCOMPLETE',
                severity: 'error',
                phase: 'command',
                subject: command.subject,
                message: 'Command resource access declarations must contain BufferResource or TextureResource objects.',
                expected: { [access]: '(BufferResource | TextureResource)[]' },
                actual: { resource: resource === undefined || resource === null ? String(resource) : typeof resource },
            })
        }

        resource.assertRuntime(command.runtime)
        if (seen.has(resource)) continue
        seen.add(resource)
        normalized.push(resource)
    }

    return normalized
}

function isResourceLike(value: unknown): value is BufferResource | TextureResource {

    return isRecord(value) && isContentResource(value)
}

function throwResourceReadDescriptorDiagnostic(
    command: DrawCommand | DispatchCommand,
    descriptor: unknown,
    reason: 'descriptor' | 'resource' | 'contentEpoch'
): never {

    const descriptorRecord = isRecord(descriptor) ? descriptor : {}
    const resource = descriptorRecord.resource
    const actual: Record<string, unknown> = {
        access: 'read',
        reason,
        descriptor: isResourceLike(descriptor) ? descriptor.resourceKind : describeValue(descriptor),
    }

    if (isResourceLike(resource)) {
        actual.resourceId = resource.id
        actual.resourceKind = resource.resourceKind
    }
    if ('contentEpoch' in descriptorRecord) actual.contentEpoch = descriptorRecord.contentEpoch

    throwScratchDiagnostic({
        code: 'SCRATCH_COMMAND_DECLARED_ACCESS_INCOMPLETE',
        severity: 'error',
        phase: 'command',
        subject: command.subject,
        related: [
            diagnosticSubjectOf(resource),
        ].filter(isDefined),
        message: 'Command read resource declarations must contain resource and contentEpoch.',
        expected: {
            read: {
                resource: 'BufferResource | TextureResource',
                contentEpoch: 'non-negative integer | "current-at-step"',
            },
        },
        actual,
    })
}

function normalizeDrawCount(
    command: DrawCommand,
    count: DrawCount,
    indexBuffer: NormalizedDrawIndexBufferBinding | undefined
): StaticDrawCount | StaticIndexedDrawCount | NormalizedIndirectCommandCount {

    if (!isRecord(count)) {
        throwCountDiagnostic(command, count)
    }

    const variantCount = Number('indirect' in count) + Number('indexCount' in count) + Number('vertexCount' in count)
    if (variantCount !== 1) throwCountDiagnostic(command, count)

    if ('indirect' in count) {
        return normalizeIndirectCommandCount(
            command,
            count,
            indexBuffer === undefined ? DRAW_INDIRECT_BYTE_LENGTH : DRAW_INDEXED_INDIRECT_BYTE_LENGTH,
            indexBuffer === undefined ? 'draw' : 'draw-indexed'
        )
    }

    if ('indexCount' in count) {
        if (indexBuffer === undefined) {
            throwIndexBufferDiagnostic(command, undefined, {
                expected: { indexBuffer: 'required for indexed draw count' },
                actual: { indexBuffer: undefined, count },
            })
        }

        if (!isGpuSize32(count.indexCount)) {
            throwScratchDiagnostic({
                code: 'SCRATCH_COMMAND_COUNT_INVALID',
                severity: 'error',
                phase: 'command',
                subject: command.subject,
                related: [ command.pipeline.subject ],
                message: 'DrawCommand indexCount must be an unsigned 32-bit integer.',
                expected: { indexCount: 'unsigned 32-bit integer' },
                actual: { indexCount: count.indexCount },
            })
        }

        for (const key of [ 'instanceCount', 'firstIndex', 'firstInstance' ] satisfies StaticIndexedDrawCountOptionalKey[]) {
            if (count[key] !== undefined && !isGpuSize32(count[key])) {
                throwScratchDiagnostic({
                    code: 'SCRATCH_COMMAND_COUNT_INVALID',
                    severity: 'error',
                    phase: 'command',
                    subject: command.subject,
                    related: [ command.pipeline.subject ],
                    message: `DrawCommand ${key} must be an unsigned 32-bit integer.`,
                    expected: { [key]: 'unsigned 32-bit integer' },
                    actual: { [key]: count[key] },
                })
            }
        }

        if (count.baseVertex !== undefined && !isGpuSignedOffset32(count.baseVertex)) {
            throwScratchDiagnostic({
                code: 'SCRATCH_COMMAND_COUNT_INVALID',
                severity: 'error',
                phase: 'command',
                subject: command.subject,
                related: [ command.pipeline.subject ],
                message: 'DrawCommand baseVertex must be a signed 32-bit integer.',
                expected: { baseVertex: 'signed 32-bit integer' },
                actual: { baseVertex: count.baseVertex },
            })
        }

        const normalizedCount = { ...count } as StaticIndexedDrawCount
        validateStaticIndexedDrawRange(command, normalizedCount, indexBuffer)
        return normalizedCount
    }

    if (indexBuffer !== undefined) {
        throwIndexBufferDiagnostic(command, indexBuffer, {
            expected: { indexBuffer: 'omitted for non-indexed static draw count' },
            actual: { indexBuffer: indexBuffer.region.buffer.id, count },
            related: [ indexBuffer.region.subject ],
        })
    }

    if (!('vertexCount' in count)) throwCountDiagnostic(command, count)

    if (!isGpuSize32(count.vertexCount)) {
        throwScratchDiagnostic({
            code: 'SCRATCH_COMMAND_COUNT_INVALID',
            severity: 'error',
            phase: 'command',
            subject: command.subject,
            related: [ command.pipeline.subject ],
            message: 'DrawCommand vertexCount must be an unsigned 32-bit integer.',
            expected: { vertexCount: 'unsigned 32-bit integer' },
            actual: { vertexCount: count.vertexCount },
        })
    }

    for (const key of [ 'instanceCount', 'firstVertex', 'firstInstance' ] satisfies StaticDrawCountOptionalKey[]) {
        if (count[key] !== undefined && !isGpuSize32(count[key])) {
            throwScratchDiagnostic({
                code: 'SCRATCH_COMMAND_COUNT_INVALID',
                severity: 'error',
                phase: 'command',
                subject: command.subject,
                related: [ command.pipeline.subject ],
                message: `DrawCommand ${key} must be an unsigned 32-bit integer.`,
                expected: { [key]: 'unsigned 32-bit integer' },
                actual: { [key]: count[key] },
            })
        }
    }

    return { ...count }
}

function validateStaticIndexedDrawRange(
    command: DrawCommand,
    count: StaticIndexedDrawCount,
    indexBuffer: NormalizedDrawIndexBufferBinding
): void {

    const elementByteLength = indexBuffer.format === 'uint16' ? 2 : 4
    const bindingSize = indexBuffer.region.size
    const availableIndexCount = Math.floor(bindingSize / elementByteLength)
    const firstIndex = count.firstIndex ?? 0

    if (firstIndex + count.indexCount <= availableIndexCount) return

    throwIndexBufferDiagnostic(command, indexBuffer, {
        expected: {
            indexedRange: 'firstIndex + indexCount within complete indices in the bound range',
        },
        actual: {
            firstIndex,
            indexCount: count.indexCount,
            availableIndexCount,
            bindingSize,
            format: indexBuffer.format,
            offset: indexBuffer.region.offset,
        },
        related: [ indexBuffer.region.subject ],
    })
}

function validateIndexFormatForPipeline(
    command: DrawCommand,
    format: GPUIndexFormat,
    buffer: BufferResource
): void {

    const topology = command.pipeline.primitive.topology ?? 'triangle-list'
    if (topology !== 'line-strip' && topology !== 'triangle-strip') return

    const stripIndexFormat = command.pipeline.primitive.stripIndexFormat
    if (stripIndexFormat === format) return

    throwIndexBufferDiagnostic(command, { buffer, format }, {
        expected: { indexFormat: stripIndexFormat ?? 'pipeline stripIndexFormat' },
        actual: {
            indexFormat: format,
            topology,
            stripIndexFormat,
        },
        related: [ buffer.subject, command.pipeline.subject ],
    })
}

function validateCurrentVertexBufferBinding(
    command: DrawCommand,
    binding: Readonly<NormalizedDrawVertexBufferBinding>
): void {

    const region = binding.region
    const buffer = region.buffer
    buffer.assertRuntime(command.runtime)
    region.assertUsable()
    if (region.size <= 0) {
        throwVertexBufferDiagnostic(command, {
            expected: { region: 'non-empty BufferRegion' },
            actual: { slot: binding.slot, size: region.size },
            related: [ region.subject, buffer.subject ],
        })
    }
    if (region.offset % 4 !== 0) {
        throwVertexBufferDiagnostic(command, {
            expected: { regionOffset: 'aligned to 4 bytes' },
            actual: { slot: binding.slot, offset: region.offset, size: region.size },
            related: [ region.subject, buffer.subject ],
        })
    }
    if ((buffer.usage & GPU_BUFFER_USAGE_VERTEX) !== 0) return

    throwScratchDiagnostic({
        code: 'SCRATCH_RESOURCE_USAGE_MISSING',
        severity: 'error',
        phase: 'resource',
        subject: buffer.subject,
        related: [ command.subject, command.pipeline.subject ],
        message: 'DrawCommand vertex buffer binding requires GPUBufferUsage.VERTEX.',
        expected: { usage: 'GPUBufferUsage.VERTEX' },
        actual: { usage: buffer.usage },
    })
}

function validateCurrentIndexBufferBinding(
    command: DrawCommand,
    binding: Readonly<NormalizedDrawIndexBufferBinding>
): void {

    const region = binding.region
    const buffer = region.buffer
    buffer.assertRuntime(command.runtime)
    region.assertUsable()

    const format = binding.format
    if (format !== 'uint16' && format !== 'uint32') {
        throwIndexBufferDiagnostic(command, binding, {
            expected: { format: [ 'uint16', 'uint32' ] },
            actual: { format },
            related: [ buffer.subject ],
        })
    }

    validateIndexFormatForPipeline(command, format, buffer)

    const elementByteLength = format === 'uint16' ? 2 : 4
    if (region.offset % elementByteLength !== 0) {
        throwIndexBufferDiagnostic(command, binding, {
            expected: { regionOffset: `aligned to ${elementByteLength} bytes` },
            actual: { offset: region.offset, format },
            related: [ region.subject, buffer.subject ],
        })
    }
    if (region.size % elementByteLength !== 0) {
        throwIndexBufferDiagnostic(command, binding, {
            expected: { regionSize: `multiple of ${elementByteLength} bytes` },
            actual: { size: region.size, format },
            related: [ region.subject, buffer.subject ],
        })
    }
    if ((buffer.usage & GPU_BUFFER_USAGE_INDEX) !== 0) return

    throwScratchDiagnostic({
        code: 'SCRATCH_RESOURCE_USAGE_MISSING',
        severity: 'error',
        phase: 'resource',
        subject: buffer.subject,
        related: [ command.subject, command.pipeline.subject ],
        message: 'DrawCommand index buffer binding requires GPUBufferUsage.INDEX.',
        expected: { usage: 'GPUBufferUsage.INDEX' },
        actual: { usage: buffer.usage },
    })
}

function normalizeIndirectCommandCount(
    command: DrawCommand | DispatchCommand,
    count: Record<string, unknown>,
    requiredByteLength: number,
    operation: 'draw' | 'draw-indexed' | 'dispatch'
): NormalizedIndirectCommandCount {

    const region = count.indirect
    if (!isBufferRegion(region)) {
        throwIndirectBufferDiagnostic(command, {
            expected: { indirect: 'BufferRegion' },
            actual: {
                operation,
                indirect: describeValue(region),
                requiredByteLength,
            },
        })
    }

    validateCurrentIndirectCommandRegion(command, region, requiredByteLength, operation)

    return { indirect: region }
}

function validateCurrentIndirectCommandRegion(
    command: DrawCommand | DispatchCommand,
    region: BufferRegion,
    requiredByteLength: number,
    operation: 'draw' | 'draw-indexed' | 'dispatch'
): void {

    const buffer = region.buffer
    buffer.assertRuntime(command.runtime)
    region.assertUsable()

    if (region.offset % 4 !== 0) {
        throwIndirectBufferDiagnostic(command, {
            expected: { regionOffset: 'aligned to 4 bytes' },
            actual: {
                operation,
                offset: region.offset,
                bufferSize: buffer.size,
                requiredByteLength,
            },
            related: [ region.subject, buffer.subject ],
        })
    }

    if (region.size < requiredByteLength) {
        throwIndirectBufferDiagnostic(command, {
            expected: { regionSize: `at least ${requiredByteLength} bytes` },
            actual: {
                operation,
                offset: region.offset,
                regionSize: region.size,
                bufferSize: buffer.size,
                requiredByteLength,
            },
            related: [ region.subject, buffer.subject ],
        })
    }

    if ((buffer.usage & GPU_BUFFER_USAGE_INDIRECT) === 0) {
        throwScratchDiagnostic({
            code: 'SCRATCH_RESOURCE_USAGE_MISSING',
            severity: 'error',
            phase: 'resource',
            subject: buffer.subject,
            related: [ command.subject, command.pipeline.subject ],
            message: 'Indirect command count requires GPUBufferUsage.INDIRECT.',
            expected: { usage: 'GPUBufferUsage.INDIRECT' },
            actual: { usage: buffer.usage, operation },
        })
    }

}

function normalizeUploadSource(runtime: ScratchRuntime, descriptor: UploadCommandDescriptor): NormalizedUploadSource {

    const data = descriptor.data
    if (isLayoutUploadView(data)) {
        const bytes = createLayoutUploadBytes(runtime, data)
        return {
            data: bytes,
            dataOffset: 0,
            byteLength: bytes.byteLength,
            layout: data.artifact,
        }
    }

    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        return {
            data,
            dataOffset: 0,
        }
    }

    throwUploadDiagnostic({
        runtime,
        target: descriptor.target,
        data,
        dataOffset: descriptor.dataOffset,
        size: descriptor.size,
        reason: 'data',
    })
}

function createLayoutUploadBytes(runtime: ScratchRuntime, uploadView: LayoutUploadView): Uint8Array {

    if (
        !Number.isInteger(uploadView.byteOffset) ||
        !Number.isInteger(uploadView.byteLength) ||
        uploadView.byteOffset < 0 ||
        uploadView.byteLength < 0 ||
        uploadView.byteOffset + uploadView.byteLength > uploadView.bytes.buffer.byteLength
    ) {
        throwScratchDiagnostic({
            code: 'SCRATCH_CODEC_BYTE_LENGTH_MISMATCH',
            severity: 'error',
            phase: 'layout-codec',
            subject: layoutArtifactSubject(uploadView.artifact),
            related: [ runtime.subject ],
            message: 'LayoutUploadView byte range must fit inside its byte storage.',
            expected: { byteRange: 'non-negative byte range inside bytes.buffer' },
            actual: {
                byteOffset: uploadView.byteOffset,
                byteLength: uploadView.byteLength,
                bufferByteLength: uploadView.bytes.buffer.byteLength,
            },
        })
    }

    if (uploadView.byteOffset === uploadView.bytes.byteOffset && uploadView.byteLength === uploadView.bytes.byteLength) {
        return uploadView.bytes
    }

    return new Uint8Array(uploadView.bytes.buffer, uploadView.byteOffset, uploadView.byteLength)
}

function normalizeUploadLayout(
    runtime: ScratchRuntime,
    layout: unknown,
    descriptor: UploadCommandDescriptor
): LayoutArtifact | undefined {

    if (layout === undefined) return undefined
    if (isLayoutArtifact(layout)) return layout

    throwScratchDiagnostic({
        code: 'SCRATCH_LAYOUT_UNSUPPORTED_FORMAT',
        severity: 'error',
        phase: 'layout-codec',
        subject: runtime.subject,
        related: [ diagnosticSubjectOf(descriptor.target) ].filter(isDefined),
        message: 'UploadCommand layout must be a LayoutArtifact.',
        expected: { layout: 'LayoutArtifact' },
        actual: { layout: describeValue(layout) },
    })
}

function normalizeUploadOffset(runtime: ScratchRuntime, value: number): number {

    if (!Number.isInteger(value) || value < 0) {
        throwUploadDiagnostic({ runtime, offset: value, reason: 'offset' })
    }

    return value
}

function normalizeUploadByteLength(
    runtime: ScratchRuntime,
    data: ArrayBuffer | ArrayBufferView,
    dataOffset: number,
    descriptor: UploadCommandDescriptor,
    sourceByteLength?: number
): number {

    const dataByteLength = getDataByteLength(data)
    if (dataByteLength === undefined) {
        throwUploadDiagnostic({
            runtime,
            target: descriptor.target,
            data,
            reason: 'data',
        })
    }

    const size = descriptor.size ?? sourceByteLength ?? dataByteLength - dataOffset
    if (!Number.isInteger(size) || size < 0) {
        throwUploadDiagnostic({
            runtime,
            target: descriptor.target,
            data,
            reason: 'size',
        })
    }

    return size
}

function validateUploadRange(command: UploadCommand) {

    const dataByteLength = getDataByteLength(command.data)

    if (
        dataByteLength === undefined ||
        command.dataOffset + command.byteLength > dataByteLength ||
        command.byteLength !== command.target.size
    ) {
        throwUploadDiagnostic({
            runtime: command.runtime,
            target: command.target,
            data: command.data,
            dataOffset: command.dataOffset,
            size: command.byteLength,
            reason: 'range',
        })
    }
    if (command.target.offset % 4 !== 0 || command.byteLength % 4 !== 0) {
        throwUploadDiagnostic({
            runtime: command.runtime,
            target: command.target,
            data: command.data,
            offset: command.target.offset,
            dataOffset: command.dataOffset,
            size: command.byteLength,
            reason: 'writeBufferAlignment',
        })
    }

    validateUploadLayout(command)
}

function validateBufferUploadUsage(runtime: ScratchRuntime, target: BufferRegion): void {

    if ((target.buffer.usage & GPU_BUFFER_USAGE_COPY_DST) !== 0) return

    throwScratchDiagnostic({
        code: 'SCRATCH_RESOURCE_USAGE_MISSING',
        severity: 'error',
        phase: 'resource',
        subject: target.buffer.subject,
        related: [ runtime.subject, target.subject ],
        message: 'UploadCommand target requires GPUBufferUsage.COPY_DST.',
        expected: { usage: 'GPUBufferUsage.COPY_DST' },
        actual: { usage: target.buffer.usage },
    })
}

function validateClearBufferTarget(command: ClearBufferCommand): void {

    const target = command.target
    const buffer = target.buffer
    if ((buffer.usage & GPU_BUFFER_USAGE_COPY_DST) === 0) {
        throwClearBufferDiagnostic(command.runtime, target, 'usage', command)
    }
    if (target.offset % 4 !== 0 || target.size % 4 !== 0) {
        throwClearBufferDiagnostic(command.runtime, target, 'alignment', command)
    }
    if (
        !Number.isSafeInteger(target.offset + target.size) ||
        target.offset + target.size > buffer.size
    ) {
        throwClearBufferDiagnostic(command.runtime, target, 'range', command)
    }
}

function throwClearBufferDiagnostic(
    runtime: ScratchRuntime,
    target: unknown,
    reason: 'descriptor' | 'target' | 'usage' | 'alignment' | 'range',
    command?: ClearBufferCommand
): never {

    const region = isBufferRegion(target) ? target : undefined
    throwScratchDiagnostic({
        code: 'SCRATCH_COMMAND_CLEAR_BUFFER_INVALID',
        severity: 'error',
        phase: 'command',
        subject: command?.subject ?? { kind: 'Command', commandKind: 'clear' },
        related: [
            runtime.subject,
            region?.subject,
            region?.buffer.subject,
        ].filter(isDefined),
        message: 'ClearBufferCommand requires a current, aligned COPY_DST BufferRegion.',
        expected: {
            descriptor: '{ label?, target: BufferRegion }',
            target: 'BufferRegion',
            usage: 'GPUBufferUsage.COPY_DST',
            offsetAlignment: 4,
            sizeAlignment: 4,
            range: 'within the current BufferResource allocation',
        },
        actual: {
            reason,
            target: describeValue(target),
            resourceId: region?.buffer.id,
            usage: region?.buffer.usage,
            bufferSize: region?.buffer.size,
            offset: region?.offset,
            size: region?.size,
        },
    })
}

function validateUploadLayout(command: UploadCommand) {

    const targetLayout = command.target.layout
    if (targetLayout === undefined) {
        if (command.layout === undefined) return
        throwScratchDiagnostic({
            code: 'SCRATCH_CODEC_SCHEMA_MISMATCH',
            severity: 'error',
            phase: 'layout-codec',
            subject: command.target.subject,
            related: [ command.subject, layoutArtifactSubject(command.layout) ],
            message: 'Typed UploadCommand data requires an explicitly interpreted target BufferRegion.',
            expected: { targetLayout: 'LayoutArtifact on BufferRegion' },
            actual: {
                abiHash: command.layout.abiHash,
                schemaHash: command.layout.schemaHash,
            },
        })
    }

    if (command.layout !== undefined && !layoutArtifactsSchemaCompatible(targetLayout, command.layout)) {
        throwScratchDiagnostic({
            code: 'SCRATCH_CODEC_SCHEMA_MISMATCH',
            severity: 'error',
            phase: 'layout-codec',
            subject: command.target.subject,
            related: [ command.subject, layoutArtifactSubject(command.layout), layoutArtifactSubject(targetLayout) ],
            message: 'UploadCommand LayoutArtifact does not match the target BufferRegion layout.',
            expected: {
                abiHash: targetLayout.abiHash,
                schemaHash: targetLayout.schemaHash,
            },
            actual: {
                abiHash: command.layout.abiHash,
                schemaHash: command.layout.schemaHash,
            },
            evidence: [ {
                kind: 'layout-schema-difference',
                value: describeLayoutCompatibilityDifference(targetLayout, command.layout, 'schema'),
            } ],
        })
    }

}

function getDataByteLength(data: unknown): number | undefined {

    if (data instanceof ArrayBuffer) return data.byteLength
    if (ArrayBuffer.isView(data)) return data.byteLength
    return undefined
}

function createUploadSource(data: ArrayBuffer | ArrayBufferView, byteOffset: number, byteLength: number): Uint8Array {

    if (data instanceof ArrayBuffer) {
        return new Uint8Array(data, byteOffset, byteLength)
    }

    return new Uint8Array(data.buffer, data.byteOffset + byteOffset, byteLength)
}

function validateBufferCopyUsage(
    runtime: ScratchRuntime,
    buffer: BufferResource,
    requiredUsage: GPUBufferUsageFlags,
    role: string,
    usageName: string
) {

    if ((buffer.usage & requiredUsage) !== 0) return

    throwScratchDiagnostic({
        code: 'SCRATCH_RESOURCE_USAGE_MISSING',
        severity: 'error',
        phase: 'resource',
        subject: buffer.subject,
        related: [ runtime.subject ],
        message: `CopyCommand ${role} requires ${usageName}.`,
        expected: { usage: usageName },
        actual: { usage: buffer.usage },
    })
}

function validateTextureCopyUsage(
    runtime: ScratchRuntime,
    texture: TextureResource,
    requiredUsage: GPUTextureUsageFlags,
    role: string,
    usageName: string
) {

    if ((texture.usage & requiredUsage) !== 0) return

    throwScratchDiagnostic({
        code: 'SCRATCH_RESOURCE_USAGE_MISSING',
        severity: 'error',
        phase: 'resource',
        subject: texture.subject,
        related: [ runtime.subject ],
        message: `CopyCommand ${role} requires ${usageName}.`,
        expected: { usage: usageName },
        actual: { usage: texture.usage },
    })
}

function validateCurrentCopyUsage(command: CopyCommand): void {

    if (command.copyKind === 'buffer-to-buffer') {
        const source = (command.source as BufferCopyCommandSourceDescriptor).region.buffer
        const target = (command.target as BufferRegion).buffer
        validateBufferCopyUsage(
            command.runtime,
            source,
            GPU_BUFFER_USAGE_COPY_SRC,
            'source',
            'GPUBufferUsage.COPY_SRC'
        )
        validateBufferCopyUsage(
            command.runtime,
            target,
            GPU_BUFFER_USAGE_COPY_DST,
            'target',
            'GPUBufferUsage.COPY_DST'
        )
        return
    }
    if (command.copyKind === 'texture-to-texture') {
        const source = (command.source as TextureCopyCommandSourceDescriptor).resource
        const target = command.target as TextureResource
        validateTextureCopyUsage(
            command.runtime,
            source,
            GPU_TEXTURE_USAGE_COPY_SRC,
            'source',
            'GPUTextureUsage.COPY_SRC'
        )
        validateTextureCopyUsage(
            command.runtime,
            target,
            GPU_TEXTURE_USAGE_COPY_DST,
            'target',
            'GPUTextureUsage.COPY_DST'
        )
        return
    }
    if (command.copyKind === 'buffer-to-texture') {
        const source = (command.source as BufferCopyCommandSourceDescriptor).region.buffer
        const target = command.target as TextureResource
        validateBufferCopyUsage(
            command.runtime,
            source,
            GPU_BUFFER_USAGE_COPY_SRC,
            'source',
            'GPUBufferUsage.COPY_SRC'
        )
        validateTextureCopyUsage(
            command.runtime,
            target,
            GPU_TEXTURE_USAGE_COPY_DST,
            'target',
            'GPUTextureUsage.COPY_DST'
        )
        return
    }

    const source = (command.source as TextureCopyCommandSourceDescriptor).resource
    const target = (command.target as BufferRegion).buffer
    validateTextureCopyUsage(
        command.runtime,
        source,
        GPU_TEXTURE_USAGE_COPY_SRC,
        'source',
        'GPUTextureUsage.COPY_SRC'
    )
    validateBufferCopyUsage(
        command.runtime,
        target,
        GPU_BUFFER_USAGE_COPY_DST,
        'target',
        'GPUBufferUsage.COPY_DST'
    )
}

function normalizeCopySource(runtime: ScratchRuntime, descriptor: CopyCommandDescriptor): CopyCommandSourceDescriptor {

    const source = descriptor.source
    if (!isRecord(source)) {
        throwCopySourceDiagnostic({
            runtime,
            source,
            target: descriptor.target,
            reason: 'source',
        })
    }

    const contentEpoch = source.contentEpoch
    const region = 'region' in source ? source.region : undefined
    const resource = 'resource' in source ? source.resource : undefined
    if (!isBufferRegion(region) && !isTextureResource(resource)) {
        throwCopySourceDiagnostic({
            runtime,
            source,
            target: descriptor.target,
            reason: 'source.resource-or-region',
        })
    }

    if (typeof contentEpoch !== 'number' || !Number.isInteger(contentEpoch) || contentEpoch < 0) {
        throwCopySourceDiagnostic({
            runtime,
            source,
            target: descriptor.target,
            reason: 'source.contentEpoch',
        })
    }

    if (isBufferRegion(region)) {
        region.buffer.assertRuntime(runtime)
        region.assertUsable()
        return Object.freeze({ region, contentEpoch })
    }
    const texture = resource as TextureResource
    texture.assertRuntime(runtime)
    return Object.freeze({ resource: texture, contentEpoch })
}

function isBufferRegionSource(source: CopyCommandSourceDescriptor): source is BufferCopyCommandSourceDescriptor {

    return 'region' in source
}

function isTextureCopySource(source: CopyCommandSourceDescriptor): source is TextureCopyCommandSourceDescriptor {

    return 'resource' in source
}

function copySourceResource(source: CopyCommandSourceDescriptor): BufferResource | TextureResource {

    return isBufferRegionSource(source) ? source.region.buffer : source.resource
}

function normalizeCopyReadinessPolicy(command: CopyCommand, whenMissing: ResourceReadinessPolicy): 'throw' {

    if (whenMissing !== 'throw') {
        throwScratchDiagnostic({
            code: 'SCRATCH_COMMAND_READINESS_POLICY_MISSING',
            severity: 'error',
            phase: 'command',
            subject: command.subject,
            message: 'CopyCommand requires an explicit throw readiness policy.',
            expected: { whenMissing: [ 'throw' ] },
            actual: { whenMissing },
        })
    }

    return 'throw'
}

function normalizeBufferCopyTarget(runtime: ScratchRuntime, descriptor: BufferToBufferCopyCommandDescriptor, source: BufferRegion): BufferRegion {

    const target = descriptor.target
    if (!isBufferRegion(target)) {
        throwCopyDiagnostic({
            runtime,
            source,
            target,
            reason: 'target',
        })
    }

    target.buffer.assertRuntime(runtime)
    target.assertUsable()
    return target
}

function normalizeTextureCopyTarget(runtime: ScratchRuntime, descriptor: TextureToTextureCopyCommandDescriptor, source: TextureResource): TextureResource {

    const target = descriptor.target
    if (!isTextureResource(target)) {
        throwCopyDiagnostic({
            runtime,
            source,
            target,
            sourceOrigin: descriptor.sourceOrigin,
            targetOrigin: descriptor.targetOrigin,
            size: descriptor.size,
            reason: 'target',
        })
    }

    target.assertRuntime(runtime)
    return target
}

function normalizeBufferToTextureCopyTarget(runtime: ScratchRuntime, descriptor: BufferToTextureCopyCommandDescriptor, source: BufferResource): TextureResource {

    const target = descriptor.target
    if (!isTextureResource(target)) {
        throwCopyDiagnostic({
            runtime,
            source,
            target,
            sourceLayout: descriptor.sourceLayout,
            targetOrigin: descriptor.targetOrigin,
            targetMipLevel: descriptor.targetMipLevel,
            targetAspect: descriptor.targetAspect,
            size: descriptor.size,
            reason: 'target',
        })
    }

    target.assertRuntime(runtime)
    return target
}

function normalizeTextureToBufferCopyTarget(runtime: ScratchRuntime, descriptor: TextureToBufferCopyCommandDescriptor, source: TextureResource): BufferRegion {

    const target = descriptor.target
    if (!isBufferRegion(target)) {
        throwCopyDiagnostic({
            runtime,
            source,
            target,
            targetLayout: descriptor.targetLayout,
            sourceOrigin: descriptor.sourceOrigin,
            sourceMipLevel: descriptor.sourceMipLevel,
            sourceAspect: descriptor.sourceAspect,
            size: descriptor.size,
            reason: 'target',
        })
    }

    target.buffer.assertRuntime(runtime)
    target.assertUsable()
    return target
}

function normalizeTextureCopyOrigin(
    runtime: ScratchRuntime,
    origin: TextureCopyOrigin | undefined = { x: 0, y: 0, z: 0 },
    key: 'sourceOrigin' | 'targetOrigin'
): { x: number, y: number, z: number } {

    let x
    let y
    let z

    if (Array.isArray(origin)) {
        x = origin[0] ?? 0
        y = origin[1] ?? 0
        z = origin[2] ?? 0
    } else if (origin && typeof origin === 'object') {
        x = origin.x ?? 0
        y = origin.y ?? 0
        z = origin.z ?? 0
    } else {
        throwCopyDiagnostic({ runtime, [key]: origin, reason: key })
    }

    for (const value of [ x, y, z ]) {
        if (!Number.isInteger(value) || value < 0) {
            throwCopyDiagnostic({ runtime, [key]: origin, reason: key })
        }
    }

    return { x, y, z }
}

function normalizeTextureCopyMipLevel(
    runtime: ScratchRuntime,
    texture: TextureResource,
    mipLevel: number,
    key: 'sourceMipLevel' | 'targetMipLevel'
): number {

    if (!Number.isInteger(mipLevel) || mipLevel < 0 || mipLevel >= texture.mipLevelCount) {
        throwCopyDiagnostic({ runtime, [key]: mipLevel, reason: key })
    }

    return mipLevel
}

function normalizeTextureCopyAspect(
    runtime: ScratchRuntime,
    aspect: GPUTextureAspect,
    key: 'sourceAspect' | 'targetAspect'
): GPUTextureAspect {

    if (![ 'all', 'depth-only', 'stencil-only' ].includes(aspect)) {
        throwCopyDiagnostic({ runtime, [key]: aspect, reason: key })
    }

    return aspect
}

function normalizeTextureCopySize(
    runtime: ScratchRuntime,
    source: unknown,
    target: unknown,
    size: TextureCopySize,
    sourceOrigin?: { x: number, y: number, z: number },
    targetOrigin?: { x: number, y: number, z: number }
): { width: number, height: number, depthOrArrayLayers: number } {

    let width
    let height
    let depthOrArrayLayers

    if (Array.isArray(size)) {
        width = size[0]
        height = size[1] ?? 1
        depthOrArrayLayers = size[2] ?? 1
    } else if (size && typeof size === 'object') {
        width = size.width
        height = size.height
        depthOrArrayLayers = size.depthOrArrayLayers ?? 1
    } else {
        throwCopyDiagnostic({ runtime, source, target, size, sourceOrigin, targetOrigin, reason: 'size' })
    }

    for (const value of [ width, height, depthOrArrayLayers ]) {
        if (!Number.isInteger(value) || value <= 0) {
            throwCopyDiagnostic({ runtime, source, target, size, sourceOrigin, targetOrigin, reason: 'size' })
        }
    }

    return { width, height, depthOrArrayLayers }
}

function normalizeTexelCopyBufferLayout(
    runtime: ScratchRuntime,
    region: BufferRegion,
    texture: TextureResource,
    aspect: GPUTextureAspect,
    direction: 'source' | 'destination',
    layout: TexelCopyBufferLayout,
    size: { width: number, height: number, depthOrArrayLayers: number },
    key: 'sourceLayout' | 'targetLayout'
): Required<TexelCopyBufferLayout> {

    if (!isRecord(layout)) {
        throwCopyDiagnostic({ runtime, source: region, target: texture, [key]: layout, size, reason: key })
    }

    const footprint = textureFormatCopyFootprint(texture.format, aspect, direction)
    if (footprint === undefined) {
        throwCopyDiagnostic({ runtime, source: region, target: texture, [key]: layout, size, reason: 'format' })
    }
    const widthInBlocks = size.width / footprint.blockWidth
    const heightInBlocks = size.height / footprint.blockHeight
    if (!Number.isInteger(widthInBlocks) || !Number.isInteger(heightInBlocks)) {
        throwCopyDiagnostic({ runtime, source: region, target: texture, [key]: layout, size, reason: 'blockAlignment' })
    }

    const bytesPerRow = layout.bytesPerRow
    const rowsPerImage = layout.rowsPerImage ?? heightInBlocks

    for (const [ field, value ] of Object.entries({ bytesPerRow, rowsPerImage })) {
        if (!Number.isInteger(value) || value <= 0 || value > GPU_SIZE_32_MAX) {
            throwCopyDiagnostic({ runtime, source: region, target: texture, [key]: layout, size, reason: field })
        }
    }

    if (bytesPerRow % 256 !== 0 || region.offset % footprint.offsetAlignment !== 0) {
        throwCopyDiagnostic({ runtime, source: region, target: texture, [key]: layout, size, reason: bytesPerRow % 256 !== 0 ? 'bytesPerRow' : 'regionOffset' })
    }

    const rowBytes = widthInBlocks * footprint.bytesPerBlock
    if (bytesPerRow < rowBytes || rowsPerImage < heightInBlocks) {
        throwCopyDiagnostic({ runtime, source: region, target: texture, [key]: layout, size, reason: key })
    }

    const requiredBytes =
        bytesPerRow * rowsPerImage * (size.depthOrArrayLayers - 1) +
        bytesPerRow * (heightInBlocks - 1) +
        rowBytes

    if (requiredBytes > region.size) {
        throwCopyDiagnostic({ runtime, source: region, target: texture, [key]: layout, size, reason: 'range' })
    }

    return { bytesPerRow, rowsPerImage }
}

function validateBufferCopyRange(command: CopyCommand) {

    const source = (command.source as BufferCopyCommandSourceDescriptor).region
    const target = command.target as BufferRegion

    if (
        source.size <= 0 ||
        source.size !== target.size ||
        source.offset % 4 !== 0 ||
        target.offset % 4 !== 0 ||
        source.size % 4 !== 0
    ) {
        throwCopyDiagnostic({
            runtime: command.runtime,
            source,
            target,
            reason: 'range',
        })
    }

    if (source.buffer === target.buffer) {
        throwCopyDiagnostic({
            runtime: command.runtime,
            source,
            target,
            reason: 'sameBuffer',
        })
    }
}

function validateTextureCopyRange(command: CopyCommand) {

    const source = (command.source as TextureCopyCommandSourceDescriptor).resource
    const target = command.target as TextureResource
    const sourceOrigin = command.sourceOrigin!
    const targetOrigin = command.targetOrigin!
    const size = command.size!
    const sourceExtent = textureMipExtent(source, command.sourceMipLevel!)
    const targetExtent = textureMipExtent(target, command.targetMipLevel!)
    const sourceBlockSize = textureFormatBlockSize(source.format)
    const targetBlockSize = textureFormatBlockSize(target.format)
    const subresourcesOverlap = textureCopySubresourcesOverlap(command)
    const formatsCompatible = textureCopyFormatsCompatible(source.format, target.format)
    const sampleCountsCompatible =
        source.sampleCount === target.sampleCount &&
        (source.sampleCount === 1 || command.runtime.deviceFeatures.has('core-features-and-limits'))
    const requiresFullPhysicalSubresources =
        source.sampleCount > 1 ||
        target.sampleCount > 1 ||
        textureFormatIsDepthStencil(source.format) ||
        textureFormatIsDepthStencil(target.format)
    const physicalSubresourcesCovered = !requiresFullPhysicalSubresources || (
        size.width === sourceExtent.width &&
        size.height === sourceExtent.height &&
        size.depthOrArrayLayers === sourceExtent.depthOrArrayLayers &&
        size.width === targetExtent.width &&
        size.height === targetExtent.height &&
        size.depthOrArrayLayers === targetExtent.depthOrArrayLayers
    )
    const compressedFormatsAllowed =
        command.runtime.deviceFeatures.has('core-features-and-limits') ||
        (!textureFormatIsCompressed(source.format) && !textureFormatIsCompressed(target.format))
    const blockAligned =
        sourceOrigin.x % sourceBlockSize.width === 0 &&
        sourceOrigin.y % sourceBlockSize.height === 0 &&
        targetOrigin.x % targetBlockSize.width === 0 &&
        targetOrigin.y % targetBlockSize.height === 0 &&
        size.width % sourceBlockSize.width === 0 &&
        size.height % sourceBlockSize.height === 0 &&
        size.width % targetBlockSize.width === 0 &&
        size.height % targetBlockSize.height === 0

    if (
        subresourcesOverlap ||
        !formatsCompatible ||
        !compressedFormatsAllowed ||
        !sampleCountsCompatible ||
        !physicalSubresourcesCovered ||
        !blockAligned ||
        command.sourceAspect !== 'all' ||
        command.targetAspect !== 'all' ||
        sourceOrigin.x + size.width > sourceExtent.width ||
        sourceOrigin.y + size.height > sourceExtent.height ||
        sourceOrigin.z + size.depthOrArrayLayers > sourceExtent.depthOrArrayLayers ||
        targetOrigin.x + size.width > targetExtent.width ||
        targetOrigin.y + size.height > targetExtent.height ||
        targetOrigin.z + size.depthOrArrayLayers > targetExtent.depthOrArrayLayers
    ) {
        throwCopyDiagnostic({
            runtime: command.runtime,
            source,
            target,
            sourceOrigin,
            targetOrigin,
            sourceMipLevel: command.sourceMipLevel,
            targetMipLevel: command.targetMipLevel,
            sourceAspect: command.sourceAspect,
            targetAspect: command.targetAspect,
            size,
            reason: subresourcesOverlap
                ? 'overlap'
                : !formatsCompatible || !compressedFormatsAllowed
                    ? 'format'
                    : !sampleCountsCompatible
                        ? 'sampleCount'
                        : !physicalSubresourcesCovered
                            ? 'physicalSubresource'
                        : !blockAligned
                            ? 'blockAlignment'
                        : command.sourceAspect !== 'all' || command.targetAspect !== 'all'
                            ? 'aspect'
                        : 'range',
        })
    }
}

function validateBufferToTextureCopyRange(command: CopyCommand) {

    const source = (command.source as BufferCopyCommandSourceDescriptor).region
    const target = command.target as TextureResource
    const targetOrigin = command.targetOrigin!
    const size = command.size!
    const targetExtent = textureMipExtent(target, command.targetMipLevel!)
    const blockSize = textureFormatBlockSize(target.format)
    const footprint = textureFormatCopyFootprint(target.format, command.targetAspect!, 'destination')
    const blockAligned =
        targetOrigin.x % blockSize.width === 0 &&
        targetOrigin.y % blockSize.height === 0 &&
        size.width % blockSize.width === 0 &&
        size.height % blockSize.height === 0
    const physicalSubresourceCovered = !textureFormatIsDepthStencil(target.format) || (
        size.width === targetExtent.width &&
        size.height === targetExtent.height &&
        size.depthOrArrayLayers === targetExtent.depthOrArrayLayers
    )

    if (
        target.sampleCount !== 1 ||
        footprint === undefined ||
        !blockAligned ||
        !physicalSubresourceCovered ||
        targetOrigin.x + size.width > targetExtent.width ||
        targetOrigin.y + size.height > targetExtent.height ||
        targetOrigin.z + size.depthOrArrayLayers > targetExtent.depthOrArrayLayers
    ) {
        throwCopyDiagnostic({
            runtime: command.runtime,
            source,
            target,
            sourceLayout: command.sourceLayout,
            targetOrigin,
            targetMipLevel: command.targetMipLevel,
            targetAspect: command.targetAspect,
            size,
            reason: target.sampleCount !== 1
                ? 'sampleCount'
                : footprint === undefined
                    ? 'aspect'
                    : !blockAligned
                        ? 'blockAlignment'
                        : !physicalSubresourceCovered
                            ? 'physicalSubresource'
                    : 'range',
        })
    }
}

function validateTextureToBufferCopyRange(command: CopyCommand) {

    const source = (command.source as TextureCopyCommandSourceDescriptor).resource
    const target = command.target as BufferRegion
    const sourceOrigin = command.sourceOrigin!
    const size = command.size!
    const sourceExtent = textureMipExtent(source, command.sourceMipLevel!)
    const blockSize = textureFormatBlockSize(source.format)
    const footprint = textureFormatCopyFootprint(source.format, command.sourceAspect!, 'source')
    const blockAligned =
        sourceOrigin.x % blockSize.width === 0 &&
        sourceOrigin.y % blockSize.height === 0 &&
        size.width % blockSize.width === 0 &&
        size.height % blockSize.height === 0
    const physicalSubresourceCovered = !textureFormatIsDepthStencil(source.format) || (
        size.width === sourceExtent.width &&
        size.height === sourceExtent.height &&
        size.depthOrArrayLayers === sourceExtent.depthOrArrayLayers
    )
    const compressedFormatAllowed =
        command.runtime.deviceFeatures.has('core-features-and-limits') ||
        !textureFormatIsCompressed(source.format)

    if (
        source.sampleCount !== 1 ||
        footprint === undefined ||
        !compressedFormatAllowed ||
        !blockAligned ||
        !physicalSubresourceCovered ||
        sourceOrigin.x + size.width > sourceExtent.width ||
        sourceOrigin.y + size.height > sourceExtent.height ||
        sourceOrigin.z + size.depthOrArrayLayers > sourceExtent.depthOrArrayLayers
    ) {
        throwCopyDiagnostic({
            runtime: command.runtime,
            source,
            target,
            targetLayout: command.targetLayout,
            sourceOrigin,
            sourceMipLevel: command.sourceMipLevel,
            sourceAspect: command.sourceAspect,
            size,
            reason: source.sampleCount !== 1
                ? 'sampleCount'
                : footprint === undefined
                    ? 'aspect'
                    : !compressedFormatAllowed
                        ? 'format'
                        : !blockAligned
                            ? 'blockAlignment'
                            : !physicalSubresourceCovered
                                ? 'physicalSubresource'
                    : 'range',
        })
    }
}

function textureMipExtent(texture: TextureResource, mipLevel: number): { width: number, height: number, depthOrArrayLayers: number } {

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

function textureCopySubresourcesOverlap(command: CopyCommand): boolean {

    const source = (command.source as TextureCopyCommandSourceDescriptor).resource
    const target = command.target as TextureResource
    if (source !== target || command.sourceMipLevel !== command.targetMipLevel) return false
    if (
        command.sourceAspect !== 'all' &&
        command.targetAspect !== 'all' &&
        command.sourceAspect !== command.targetAspect
    ) return false
    if (source.dimension !== '2d') return true

    const sourceStart = command.sourceOrigin!.z
    const sourceEnd = sourceStart + command.size!.depthOrArrayLayers
    const targetStart = command.targetOrigin!.z
    const targetEnd = targetStart + command.size!.depthOrArrayLayers
    return sourceStart < targetEnd && targetStart < sourceEnd
}

function textureCopyFormatsCompatible(
    source: GPUTextureFormat,
    target: GPUTextureFormat
): boolean {

    return source === target || source.replace(/-srgb$/, '') === target.replace(/-srgb$/, '')
}

function throwCopySourceDiagnostic({
    runtime,
    source,
    target,
    sourceLayout,
    targetLayout,
    sourceOrigin,
    targetOrigin,
    sourceMipLevel,
    targetMipLevel,
    sourceAspect,
    targetAspect,
    size,
    reason,
}: CopySourceDiagnosticInput): never {

    throwScratchDiagnostic({
        code: 'SCRATCH_COMMAND_COPY_SOURCE_INVALID',
        severity: 'error',
        phase: 'command',
        subject: { kind: 'Command', commandKind: 'copy' },
        related: [
            runtime?.subject,
            diagnosticSubjectOf(source),
            diagnosticSubjectOf(target),
        ].filter(isDefined),
        message: 'CopyCommand source must declare a BufferRegion or TextureResource and required content epoch.',
        expected: {
            source: '{ region: BufferRegion, contentEpoch: non-negative integer } or { resource: TextureResource, contentEpoch: non-negative integer }',
            target: 'BufferRegion or TextureResource with matching copy destination usage',
            sourceLayout: 'required only for buffer-to-texture copies; bytesPerRow is a positive 256-byte aligned GPUSize32 and rowsPerImage is an optional positive GPUSize32',
            targetLayout: 'required only for texture-to-buffer copies; bytesPerRow is a positive 256-byte aligned GPUSize32 and rowsPerImage is an optional positive GPUSize32',
            sourceOrigin: 'optional non-negative texture-source origin',
            targetOrigin: 'optional non-negative texture-target origin',
            sourceMipLevel: 'optional non-negative mip level within a texture source',
            targetMipLevel: 'optional non-negative mip level within a texture target',
            sourceAspect: "optional 'all', 'depth-only', or 'stencil-only' for a texture source, compatible with its format and copy direction",
            targetAspect: "optional 'all', 'depth-only', or 'stencil-only' for a texture target, compatible with its format and copy direction",
            size: 'required positive texture extent for copies involving a texture; buffer-to-buffer copies use equal positive BufferRegion sizes',
        },
        actual: {
            reason,
            source: describeValue(source),
            target: describeValue(target),
            sourceLayout,
            targetLayout,
            sourceOrigin,
            targetOrigin,
            sourceMipLevel,
            targetMipLevel,
            sourceAspect,
            targetAspect,
            size,
        },
    })
}

function throwCopyDiagnostic({
    runtime,
    source,
    target,
    sourceLayout,
    targetLayout,
    sourceOrigin,
    targetOrigin,
    sourceMipLevel,
    targetMipLevel,
    sourceAspect,
    targetAspect,
    size,
    reason,
}: CopyDiagnosticInput): never {

    throwScratchDiagnostic({
        code: 'SCRATCH_COMMAND_COPY_RANGE_INVALID',
        severity: 'error',
        phase: 'command',
        subject: { kind: 'Command', commandKind: 'copy' },
        related: [
            runtime?.subject,
            diagnosticSubjectOf(source),
            diagnosticSubjectOf(target),
        ].filter(isDefined),
        message: 'CopyCommand requires compatible source and target resources with a valid copy range.',
        expected: {
            source: 'BufferRegion or TextureResource with copy source usage',
            target: 'matching BufferRegion or TextureResource with copy destination usage',
            sourceLayout: 'required only for buffer-to-texture copies; bytesPerRow is a positive 256-byte aligned GPUSize32 and rowsPerImage is an optional positive GPUSize32',
            targetLayout: 'required only for texture-to-buffer copies; bytesPerRow is a positive 256-byte aligned GPUSize32 and rowsPerImage is an optional positive GPUSize32',
            sourceOrigin: 'optional non-negative texture-source origin',
            targetOrigin: 'optional non-negative texture-target origin',
            sourceMipLevel: 'optional non-negative mip level within a texture source',
            targetMipLevel: 'optional non-negative mip level within a texture target',
            sourceAspect: "optional 'all', 'depth-only', or 'stencil-only' for a texture source, compatible with its format and copy direction",
            targetAspect: "optional 'all', 'depth-only', or 'stencil-only' for a texture target, compatible with its format and copy direction",
            size: 'required positive texture extent for copies involving a texture; buffer-to-buffer copies use equal positive BufferRegion sizes',
        },
        actual: {
            reason,
            source: describeValue(source),
            target: describeValue(target),
            sourceLayout,
            targetLayout,
            sourceOrigin,
            targetOrigin,
            sourceMipLevel,
            targetMipLevel,
            sourceAspect,
            targetAspect,
            size,
        },
    })
}

function validateResolveDestinationUsage(runtime: ScratchRuntime, destination: BufferResource) {

    if ((destination.usage & GPU_BUFFER_USAGE_QUERY_RESOLVE) !== 0) return

    throwScratchDiagnostic({
        code: 'SCRATCH_RESOURCE_USAGE_MISSING',
        severity: 'error',
        phase: 'resource',
        subject: destination.subject,
        related: [ runtime.subject ],
        message: 'ResolveQuerySetCommand destination requires GPUBufferUsage.QUERY_RESOLVE.',
        expected: { usage: 'GPUBufferUsage.QUERY_RESOLVE' },
        actual: { usage: destination.usage },
    })
}

function normalizeResolveDescriptor(runtime: ScratchRuntime, descriptor: unknown): ResolveQuerySetCommandDescriptor {

    if (!isRecord(descriptor)) {
        throwResolveQuerySetDiagnostic({ runtime, reason: 'descriptor' })
    }

    const legacyInputs = [ 'querySet', 'firstQuery', 'queryCount', 'destinationOffset' ]
        .filter(key => Object.prototype.hasOwnProperty.call(descriptor, key))

    if (legacyInputs.length > 0) {
        throwResolveQuerySetDiagnostic({
            runtime,
            source: descriptor.source,
            querySet: descriptor.querySet,
            firstQuery: descriptor.firstQuery,
            queryCount: descriptor.queryCount,
            destination: descriptor.destination,
            destinationOffset: descriptor.destinationOffset,
            whenMissing: descriptor.whenMissing,
            legacyInputs,
            reason: 'legacyDescriptor',
        })
    }

    return descriptor as ResolveQuerySetCommandDescriptor
}

function normalizeResolveSource(runtime: ScratchRuntime, source: unknown): ResolveQuerySetSourceDescriptor {

    if (!isRecord(source)) {
        throwResolveQuerySetDiagnostic({ runtime, source, reason: 'source' })
    }

    const querySet = source.querySet
    if (!isQuerySetResource(querySet)) {
        throwResolveQuerySetDiagnostic({
            runtime,
            source,
            querySet,
            slots: source.slots,
            reason: 'querySet',
        })
    }

    querySet.assertRuntime(runtime)

    const slots = normalizeResolveQuerySlots(runtime, querySet, source.slots, source)

    return Object.freeze({
        querySet,
        slots,
    })
}

function normalizeResolveQuerySlots(
    runtime: ScratchRuntime,
    querySet: QuerySetResource,
    slots: unknown,
    source: unknown
): readonly QuerySetSlotReadDescriptor[] {

    if (!Array.isArray(slots) || slots.length === 0) {
        throwResolveQuerySetDiagnostic({ runtime, source, querySet, slots, reason: 'slots' })
    }

    const normalized: QuerySetSlotReadDescriptor[] = []

    for (const [slotOffset, slot] of slots.entries()) {
        if (!isRecord(slot)) {
            throwResolveQuerySetDiagnostic({ runtime, source, querySet, slots, reason: 'slot' })
        }

        const index = slot.index
        if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= querySet.count) {
            throwResolveQuerySetDiagnostic({ runtime, source, querySet, slots, reason: 'slotIndex' })
        }

        const contentEpoch = slot.contentEpoch
        if (typeof contentEpoch !== 'number' || !Number.isFinite(contentEpoch) || !Number.isInteger(contentEpoch) || contentEpoch < 0) {
            throwResolveQuerySetDiagnostic({ runtime, source, querySet, slots, reason: 'slotContentEpoch' })
        }

        if (slotOffset > 0 && index !== normalized[slotOffset - 1].index + 1) {
            throwResolveQuerySetDiagnostic({ runtime, source, querySet, slots, reason: 'slotRange' })
        }

        normalized.push(Object.freeze({
            index,
            contentEpoch,
        }))
    }

    return Object.freeze(normalized)
}

function validateResolveReadinessPolicy(
    runtime: ScratchRuntime,
    whenMissing: unknown,
    source: ResolveQuerySetSourceDescriptor,
    destination: BufferRegion
) {

    if (whenMissing === 'throw') return

    throwResolveQuerySetDiagnostic({
        runtime,
        source,
        querySet: source.querySet,
        slots: source.slots,
        firstQuery: source.slots[0]?.index,
        queryCount: source.slots.length,
        destination,
        whenMissing,
        reason: 'whenMissing',
    })
}

function validateResolveQuerySetRange(command: ResolveQuerySetCommand) {

    if (command.firstQuery >= command.querySet.count || command.firstQuery + command.queryCount > command.querySet.count) {
        throwResolveQuerySetDiagnostic({
            runtime: command.runtime,
            querySet: command.querySet,
            slots: command.source.slots,
            firstQuery: command.firstQuery,
            queryCount: command.queryCount,
            destination: command.destination,
            destinationOffset: command.destination.offset,
            whenMissing: command.whenMissing,
            reason: 'queryRange',
        })
    }

    const byteLength = command.queryCount * 8
    if (
        command.destination.offset % 256 !== 0 ||
        command.destination.size !== byteLength
    ) {
        throwResolveQuerySetDiagnostic({
            runtime: command.runtime,
            querySet: command.querySet,
            slots: command.source.slots,
            firstQuery: command.firstQuery,
            queryCount: command.queryCount,
            destination: command.destination,
            destinationOffset: command.destination.offset,
            whenMissing: command.whenMissing,
            reason: 'destinationRange',
        })
    }
}

function throwResolveQuerySetDiagnostic({
    runtime,
    source,
    querySet,
    slots,
    firstQuery,
    queryCount,
    destination,
    destinationOffset,
    whenMissing,
    legacyInputs,
    reason,
}: ResolveQuerySetDiagnosticInput): never {

    throwScratchDiagnostic({
        code: 'SCRATCH_COMMAND_RESOLVE_QUERY_SET_INVALID',
        severity: 'error',
        phase: 'command',
        subject: { kind: 'Command', commandKind: 'resolve-query-set' },
        related: [
            runtime?.subject,
            diagnosticSubjectOf(querySet),
            diagnosticSubjectOf(destination),
        ].filter(isDefined),
        message: 'ResolveQuerySetCommand requires an explicit QuerySetResource slot source, BufferRegion destination, and valid query and byte ranges.',
        expected: {
            source: {
                querySet: 'QuerySetResource',
                slots: 'non-empty contiguous QuerySetSlotReadDescriptor[]',
            },
            slot: {
                index: 'integer within querySet.count',
                contentEpoch: 'non-negative integer',
            },
            destination: 'BufferRegion with GPUBufferUsage.QUERY_RESOLVE, 256-byte aligned offset, and exactly 8 bytes per query',
            whenMissing: 'throw',
            legacyInputs: 'no top-level querySet, firstQuery, queryCount, or destinationOffset fields',
        },
        actual: {
            reason,
            legacyInputs,
            source: describeValue(source),
            querySet: describeValue(querySet),
            slots,
            firstQuery,
            queryCount,
            destination: describeValue(destination),
            destinationOffset,
            whenMissing,
        },
    })
}

function throwUploadDiagnostic({ runtime, target, data, offset, dataOffset, size, layout, reason }: UploadDiagnosticInput): never {

    throwScratchDiagnostic({
        code: 'SCRATCH_COMMAND_UPLOAD_RANGE_INVALID',
        severity: 'error',
        phase: 'command',
        subject: { kind: 'Command', commandKind: 'upload' },
        related: [
            runtime?.subject,
            diagnosticSubjectOf(target),
        ].filter(isDefined),
        message: 'UploadCommand requires a BufferRegion target, byte data, and a valid writeBuffer range.',
        expected: {
            target: 'BufferRegion',
            data: 'ArrayBuffer, ArrayBufferView, or LayoutUploadView',
            offset: 'non-negative integer aligned to 4 bytes',
            dataOffset: 'non-negative integer',
            size: 'byte length within source and target and a multiple of 4 bytes',
        },
        actual: {
            reason,
            target: describeValue(target),
            data: describeValue(data),
            offset,
            dataOffset,
            size,
            layout: describeValue(layout),
        },
    })
}

function normalizeTextureUploadOrigin(
    runtime: ScratchRuntime,
    origin: TextureUploadOrigin = { x: 0, y: 0, z: 0 }
): { x: number, y: number, z: number } {

    let x
    let y
    let z

    if (Array.isArray(origin)) {
        x = origin[0] ?? 0
        y = origin[1] ?? 0
        z = origin[2] ?? 0
    } else if (origin && typeof origin === 'object') {
        x = origin.x ?? 0
        y = origin.y ?? 0
        z = origin.z ?? 0
    } else {
        throwTextureUploadDiagnostic({ runtime, origin, reason: 'origin' })
    }

    for (const value of [ x, y, z ]) {
        if (!Number.isInteger(value) || value < 0) {
            throwTextureUploadDiagnostic({ runtime, origin, reason: 'origin' })
        }
    }

    return { x, y, z }
}

function normalizeTextureUploadMipLevel(runtime: ScratchRuntime, target: TextureResource, mipLevel: number): number {

    if (!Number.isInteger(mipLevel) || mipLevel < 0 || mipLevel >= target.mipLevelCount) {
        throwTextureUploadDiagnostic({
            runtime,
            target,
            mipLevel,
            reason: 'mipLevel',
        })
    }

    return mipLevel
}

function normalizeTextureUploadSize(
    runtime: ScratchRuntime,
    target: TextureResource,
    size: TextureUploadSize,
    origin: { x: number, y: number, z: number }
): { width: number, height: number, depthOrArrayLayers: number } {

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
        throwTextureUploadDiagnostic({ runtime, target, size, reason: 'size' })
    }

    for (const value of [ width, height, depthOrArrayLayers ]) {
        if (!Number.isInteger(value) || value <= 0) {
            throwTextureUploadDiagnostic({ runtime, target, size, reason: 'size' })
        }
    }

    if (
        origin.x + width > target.width ||
        origin.y + height > target.height ||
        origin.z + depthOrArrayLayers > target.depthOrArrayLayers
    ) {
        throwTextureUploadDiagnostic({
            runtime,
            target,
            origin,
            size,
            reason: 'range',
        })
    }

    return { width, height, depthOrArrayLayers }
}

function normalizeTextureUploadLayout(
    runtime: ScratchRuntime,
    target: TextureResource,
    layout: TextureUploadLayout = {},
    size: { width: number, height: number, depthOrArrayLayers: number }
): Required<TextureUploadLayout> {

    if (!layout || typeof layout !== 'object') {
        throwTextureUploadDiagnostic({ runtime, target, layout, size, reason: 'layout' })
    }

    const bytesPerPixel = getTextureBytesPerPixel(target.format)
    if (bytesPerPixel === undefined) {
        throwTextureUploadDiagnostic({
            runtime,
            target,
            layout,
            size,
            reason: 'format',
        })
    }

    const offset = layout.offset ?? 0
    const bytesPerRow = layout.bytesPerRow ?? size.width * bytesPerPixel
    const rowsPerImage = layout.rowsPerImage ?? size.height

    for (const [ key, value ] of Object.entries({ offset, bytesPerRow, rowsPerImage })) {
        if (
            !Number.isInteger(value) ||
            value < 0 ||
            (key !== 'offset' && (value === 0 || value > GPU_SIZE_32_MAX))
        ) {
            throwTextureUploadDiagnostic({
                runtime,
                target,
                layout,
                size,
                reason: key,
            })
        }
    }

    if (bytesPerRow < size.width * bytesPerPixel || rowsPerImage < size.height) {
        throwTextureUploadDiagnostic({
            runtime,
            target,
            layout,
            size,
            reason: 'layout',
        })
    }

    return { offset, bytesPerRow, rowsPerImage }
}

function validateTextureUploadRange(command: TextureUploadCommand) {

    if (command.mipLevel >= command.target.mipLevelCount) {
        throwTextureUploadDiagnostic({
            runtime: command.runtime,
            target: command.target,
            data: command.data,
            layout: command.layout,
            origin: command.origin,
            size: command.size,
            mipLevel: command.mipLevel,
            reason: 'mipLevel',
        })
    }

    const targetExtent = textureMipExtent(command.target, command.mipLevel)
    if (
        command.target.sampleCount !== 1 ||
        command.origin.x + command.size.width > targetExtent.width ||
        command.origin.y + command.size.height > targetExtent.height ||
        command.origin.z + command.size.depthOrArrayLayers > targetExtent.depthOrArrayLayers
    ) {
        throwTextureUploadDiagnostic({
            runtime: command.runtime,
            target: command.target,
            data: command.data,
            layout: command.layout,
            origin: command.origin,
            size: command.size,
            mipLevel: command.mipLevel,
            reason: command.target.sampleCount !== 1 ? 'sampleCount' : 'range',
        })
    }

    const dataByteLength = getDataByteLength(command.data)
    if (dataByteLength === undefined) {
        throwTextureUploadDiagnostic({
            runtime: command.runtime,
            target: command.target,
            data: command.data,
            layout: command.layout,
            size: command.size,
            reason: 'data',
        })
    }

    const bytesPerPixel = getTextureBytesPerPixel(command.target.format)
    if (bytesPerPixel === undefined) {
        throwTextureUploadDiagnostic({
            runtime: command.runtime,
            target: command.target,
            data: command.data,
            layout: command.layout,
            size: command.size,
            reason: 'format',
        })
    }
    const rowBytes = command.size.width * bytesPerPixel
    const imageBytes = command.layout.bytesPerRow * command.layout.rowsPerImage
    const requiredBytes =
        command.layout.offset +
        imageBytes * (command.size.depthOrArrayLayers - 1) +
        command.layout.bytesPerRow * (command.size.height - 1) +
        rowBytes

    if (requiredBytes > dataByteLength) {
        throwTextureUploadDiagnostic({
            runtime: command.runtime,
            target: command.target,
            data: command.data,
            layout: command.layout,
            size: command.size,
            reason: 'range',
        })
    }
}

function getTextureBytesPerPixel(format: GPUTextureFormat): number | undefined {

    if ([
        'rgba8unorm',
        'rgba8unorm-srgb',
        'rgba8snorm',
        'rgba8uint',
        'rgba8sint',
        'bgra8unorm',
        'bgra8unorm-srgb',
    ].includes(format)) {
        return 4
    }

    return undefined
}

function throwTextureUploadDiagnostic({
    runtime,
    target,
    data,
    layout,
    origin,
    size,
    mipLevel,
    reason,
}: TextureUploadDiagnosticInput): never {

    throwScratchDiagnostic({
        code: 'SCRATCH_COMMAND_TEXTURE_UPLOAD_INVALID',
        severity: 'error',
        phase: 'command',
        subject: { kind: 'Command', commandKind: 'upload', uploadKind: 'texture' },
        related: [
            runtime?.subject,
            diagnosticSubjectOf(target),
        ].filter(isDefined),
        message: 'TextureUploadCommand requires a TextureResource target, byte data, texture layout, and upload size.',
        expected: {
            target: 'TextureResource with GPUTextureUsage.COPY_DST',
            data: 'ArrayBuffer or ArrayBufferView',
            layout: '{ offset?: GPUSize64, bytesPerRow?: GPUSize32, rowsPerImage?: GPUSize32 }',
            origin: '{ x?: number, y?: number, z?: number }',
            size: '{ width: number, height: number, depthOrArrayLayers?: number }',
        },
        actual: {
            reason,
            target: describeValue(target),
            data: describeValue(data),
            layout,
            origin,
            size,
            mipLevel,
        },
    })
}

function normalizeExternalImageUploadSource(
    runtime: ScratchRuntime,
    source: GPUCopyExternalImageSource
): GPUCopyExternalImageSource {

    if (!isRecord(source) || inspectExternalImageSource(source) === undefined) {
        throwExternalImageUploadInvalid({ runtime, source, reason: 'source' })
    }

    return source
}

function normalizeExternalImageUploadSourceOrigin(
    runtime: ScratchRuntime,
    origin: ExternalImageUploadSourceOrigin = { x: 0, y: 0 }
): { x: number, y: number } {

    let x: unknown
    let y: unknown

    if (Array.isArray(origin)) {
        if (origin.length < 1 || origin.length > 2) {
            throwExternalImageUploadInvalid({ runtime, sourceOrigin: origin, reason: 'source-origin' })
        }
        x = origin[0] ?? 0
        y = origin[1] ?? 0
    } else if (isRecord(origin)) {
        x = origin.x ?? 0
        y = origin.y ?? 0
    } else {
        throwExternalImageUploadInvalid({ runtime, sourceOrigin: origin, reason: 'source-origin' })
    }

    if (!isGpuSize32(x) || !isGpuSize32(y)) {
        throwExternalImageUploadInvalid({ runtime, sourceOrigin: origin, reason: 'source-origin' })
    }

    return { x, y }
}

function normalizeExternalImageUploadTargetOrigin(
    runtime: ScratchRuntime,
    origin: TextureUploadOrigin = { x: 0, y: 0, z: 0 }
): { x: number, y: number, z: number } {

    let x: unknown
    let y: unknown
    let z: unknown

    if (Array.isArray(origin)) {
        if (origin.length < 1 || origin.length > 3) {
            throwExternalImageUploadInvalid({ runtime, origin, reason: 'target-origin' })
        }
        x = origin[0] ?? 0
        y = origin[1] ?? 0
        z = origin[2] ?? 0
    } else if (isRecord(origin)) {
        x = origin.x ?? 0
        y = origin.y ?? 0
        z = origin.z ?? 0
    } else {
        throwExternalImageUploadInvalid({ runtime, origin, reason: 'target-origin' })
    }

    if (!isGpuSize32(x) || !isGpuSize32(y) || !isGpuSize32(z)) {
        throwExternalImageUploadInvalid({ runtime, origin, reason: 'target-origin' })
    }

    return { x, y, z }
}

function normalizeExternalImageUploadMipLevel(
    runtime: ScratchRuntime,
    target: TextureResource,
    mipLevel: number
): number {

    if (!isGpuSize32(mipLevel) || mipLevel >= target.mipLevelCount) {
        throwExternalImageUploadInvalid({ runtime, target, mipLevel, reason: 'mip-level' })
    }

    return mipLevel
}

function normalizeExternalImageUploadColorSpace(
    runtime: ScratchRuntime,
    colorSpace: PredefinedColorSpace
): PredefinedColorSpace {

    if (colorSpace !== 'srgb' && colorSpace !== 'display-p3') {
        throwExternalImageUploadInvalid({ runtime, colorSpace, reason: 'color-space' })
    }

    return colorSpace
}

function normalizeExternalImageUploadBoolean(
    runtime: ScratchRuntime,
    value: unknown,
    reason: 'flipY' | 'premultiplied-alpha'
): boolean {

    if (typeof value !== 'boolean') {
        throwExternalImageUploadInvalid({
            runtime,
            ...(reason === 'flipY' ? { flipY: value } : { premultipliedAlpha: value }),
            reason,
        })
    }

    return value
}

function normalizeExternalImageUploadSize(
    runtime: ScratchRuntime,
    size: ExternalImageUploadSize
): { width: number, height: number, depthOrArrayLayers: 1 } {

    let width: unknown
    let height: unknown

    if (Array.isArray(size)) {
        if (size.length !== 2) {
            throwExternalImageUploadInvalid({ runtime, size, reason: 'size' })
        }
        width = size[0]
        height = size[1]
    } else if (isRecord(size)) {
        width = size.width
        height = size.height
    } else {
        throwExternalImageUploadInvalid({ runtime, size, reason: 'size' })
    }

    if (!isGpuSize32(width) || !isGpuSize32(height)) {
        throwExternalImageUploadInvalid({ runtime, size, reason: 'size' })
    }

    return { width, height, depthOrArrayLayers: 1 }
}

function validateExternalImageUploadQueueAction(
    command: ExternalImageUploadCommand,
    queue: GPUQueue
): void {

    validateUploadCommandQueueOwner(command, queue)

    if (typeof queue.copyExternalImageToTexture !== 'function') {
        throwExternalImageUploadInvalid({
            command,
            runtime: command.runtime,
            target: command.target,
            source: command.source,
            reason: 'queue-method',
        })
    }

    validateExternalImageUploadTarget(command)
    const sourceDimensions = readExternalImageDimensions(command)
    if (sourceDimensions !== undefined && (
        command.sourceOrigin.x + command.size.width > sourceDimensions.width ||
        command.sourceOrigin.y + command.size.height > sourceDimensions.height
    )) {
        throwExternalImageUploadInvalid({
            command,
            runtime: command.runtime,
            source: command.source,
            sourceOrigin: command.sourceOrigin,
            sourceDimensions,
            size: command.size,
            reason: 'source-range',
        })
    }
}

function validateExternalImageUploadTarget(command: ExternalImageUploadCommand): void {

    const { runtime, target } = command
    target.assertRuntime(runtime)

    const requiredUsage = GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_RENDER_ATTACHMENT
    if ((target.usage & requiredUsage) !== requiredUsage) {
        throwExternalImageUploadInvalid({ command, runtime, target, reason: 'target-usage' })
    }
    if (target.dimension !== '2d') {
        throwExternalImageUploadInvalid({ command, runtime, target, reason: 'target-dimension' })
    }
    if (target.sampleCount !== 1) {
        throwExternalImageUploadInvalid({ command, runtime, target, reason: 'target-sample-count' })
    }

    validateExternalImageUploadTargetFormat(command)

    if (!isGpuSize32(command.mipLevel) || command.mipLevel >= target.mipLevelCount) {
        throwExternalImageUploadInvalid({
            command,
            runtime,
            target,
            mipLevel: command.mipLevel,
            reason: 'mip-level',
        })
    }

    const mipWidth = Math.max(1, Math.floor(target.width / (2 ** command.mipLevel)))
    const mipHeight = Math.max(1, Math.floor(target.height / (2 ** command.mipLevel)))
    if (
        command.origin.x + command.size.width > mipWidth ||
        command.origin.y + command.size.height > mipHeight ||
        command.origin.z + command.size.depthOrArrayLayers > target.depthOrArrayLayers
    ) {
        throwExternalImageUploadInvalid({
            command,
            runtime,
            target,
            origin: command.origin,
            mipLevel: command.mipLevel,
            size: command.size,
            reason: 'target-range',
        })
    }
}

function validateExternalImageUploadTargetFormat(command: ExternalImageUploadCommand): void {

    const { format } = command.target
    if (EXTERNAL_IMAGE_UPLOAD_BASE_FORMATS.has(format)) return

    const requiredFeatures = EXTERNAL_IMAGE_UPLOAD_FEATURE_FORMATS.get(format)
    if (requiredFeatures === undefined) {
        throwExternalImageUploadInvalid({
            command,
            runtime: command.runtime,
            target: command.target,
            reason: 'target-format',
        })
    }

    if (requiredFeatures.some(feature => runtimeHasFeature(command.runtime, feature))) return

    throwExternalImageUploadInvalid({
        command,
        runtime: command.runtime,
        target: command.target,
        requiredFeatures,
        reason: 'target-format-feature',
    })
}

function readExternalImageDimensions(command: ExternalImageUploadCommand): ExternalImageDimensions | undefined {

    const inspection = inspectExternalImageSource(command.source)
    if (inspection === undefined) {
        throwExternalImageUploadInvalid({
            command,
            runtime: command.runtime,
            source: command.source,
            reason: 'source',
        })
    }
    if (inspection.dimensions === undefined) return undefined

    const { width, height, fields } = inspection.dimensions
    if (isGpuSize32(width) && isGpuSize32(height)) return { width, height, fields }

    throwExternalImageUploadInvalid({
        command,
        runtime: command.runtime,
        source: command.source,
        sourceDimensions: inspection.dimensions,
        reason: 'source-dimensions',
    })
}

function inspectExternalImageSource(source: unknown): ExternalImageSourceInspection | undefined {

    if (!isRecord(source)) return undefined

    for (const contract of EXTERNAL_IMAGE_SOURCE_CONTRACTS) {
        const widthGetter = getPlatformPropertyGetter(contract.kind, contract.widthField)
        const heightGetter = getPlatformPropertyGetter(contract.kind, contract.heightField)
        if (widthGetter === undefined || heightGetter === undefined) continue

        let width: unknown
        let height: unknown

        try {
            width = widthGetter.call(source)
            height = heightGetter.call(source)
        } catch {
            continue
        }

        if (contract.dimensionsAreContextSpecific) return {}
        return {
            dimensions: {
                width,
                height,
                fields: `${contract.widthField}/${contract.heightField}`,
            },
        }
    }

    return undefined
}

function getPlatformPropertyGetter(kind: ExternalImageSourceKind, property: string): (() => unknown) | undefined {

    const constructor = (globalThis as unknown as Record<string, unknown>)[kind]
    if (typeof constructor !== 'function') return undefined

    let prototype: unknown = (constructor as { prototype?: unknown }).prototype
    while (isRecord(prototype)) {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, property)
        if (typeof descriptor?.get === 'function') return descriptor.get
        prototype = Object.getPrototypeOf(prototype)
    }

    return undefined
}

function runtimeHasFeature(runtime: ScratchRuntime, requiredFeature: string): boolean {

    for (const enabledFeature of runtime.deviceFeatures) {
        if (String(enabledFeature) === requiredFeature) return true
    }

    return false
}

function writeExternalImageUploadQueueAction(
    command: ExternalImageUploadCommand,
    queue: GPUQueue
): void {

    const source: GPUCopyExternalImageSourceInfo = {
        source: command.source,
        origin: command.sourceOrigin,
        flipY: command.flipY,
    }
    const destination: GPUCopyExternalImageDestInfo = {
        texture: command.target.gpuTexture,
        mipLevel: command.mipLevel,
        origin: command.origin,
        aspect: 'all',
        colorSpace: command.colorSpace,
        premultipliedAlpha: command.premultipliedAlpha,
    }
    const copySize = {
        width: command.size.width,
        height: command.size.height,
        depthOrArrayLayers: command.size.depthOrArrayLayers,
    }

    try {
        queue.copyExternalImageToTexture(source, destination, copySize)
    } catch (cause) {
        if (nativeErrorName(cause) === 'OperationError') {
            throwExternalImageUploadInvalid({
                command,
                runtime: command.runtime,
                source: command.source,
                sourceOrigin: command.sourceOrigin,
                size: command.size,
                nativeError: serializeNativeError(cause),
                reason: 'source-range-native',
            }, cause)
        }
        throwExternalImageUploadFailed(command, cause)
    }
}

function throwExternalImageUploadInvalid(input: ExternalImageUploadDiagnosticInput, cause?: unknown): never {

    const target = isTextureResource(input.target) ? input.target : input.command?.target
    throwScratchDiagnostic({
        code: 'SCRATCH_COMMAND_EXTERNAL_IMAGE_UPLOAD_INVALID',
        severity: 'error',
        phase: 'command',
        subject: input.command?.subject ?? {
            kind: 'Command',
            commandKind: 'upload',
            uploadKind: 'external-image',
        },
        related: [
            input.runtime?.subject,
            diagnosticSubjectOf(target),
        ].filter(isDefined),
        message: 'ExternalImageUploadCommand requires a valid external source and an eligible texture destination.',
        expected: {
            source: 'GPUCopyExternalImageSource with live non-negative integer dimensions',
            sourceOrigin: '{ x?: GPUIntegerCoordinate, y?: GPUIntegerCoordinate }',
            flipY: 'boolean',
            target: 'single-sampled 2D TextureResource with COPY_DST and RENDER_ATTACHMENT usage',
            targetFormat: 'renderable plain unorm, unorm-srgb, float, or ufloat format enabled on the device',
            origin: '{ x?: GPUIntegerCoordinate, y?: GPUIntegerCoordinate, z?: GPUIntegerCoordinate }',
            mipLevel: 'GPUIntegerCoordinate within target mip levels',
            colorSpace: [ 'srgb', 'display-p3' ],
            premultipliedAlpha: 'boolean',
            size: '{ width: GPUIntegerCoordinate, height: GPUIntegerCoordinate }',
            queue: 'GPUQueue with copyExternalImageToTexture()',
        },
        actual: {
            reason: input.reason,
            source: describeValue(input.source ?? input.command?.source),
            sourceOrigin: input.sourceOrigin ?? input.command?.sourceOrigin,
            sourceDimensions: input.sourceDimensions,
            flipY: input.flipY ?? input.command?.flipY,
            target: target === undefined ? describeValue(input.target) : {
                id: target.id,
                format: target.format,
                usage: target.usage,
                dimension: target.dimension,
                sampleCount: target.sampleCount,
                mipLevelCount: target.mipLevelCount,
                size: target.size,
            },
            origin: input.origin ?? input.command?.origin,
            mipLevel: input.mipLevel ?? input.command?.mipLevel,
            colorSpace: input.colorSpace ?? input.command?.colorSpace,
            premultipliedAlpha: input.premultipliedAlpha ?? input.command?.premultipliedAlpha,
            size: input.size ?? input.command?.size,
            requiredFeatures: input.requiredFeatures,
            nativeError: input.nativeError,
        },
    }, cause === undefined ? undefined : { cause })
}

function throwExternalImageUploadFailed(command: ExternalImageUploadCommand, cause: unknown): never {

    const nativeError = serializeNativeError(cause)
    throwScratchDiagnostic({
        code: 'SCRATCH_COMMAND_EXTERNAL_IMAGE_UPLOAD_FAILED',
        severity: 'error',
        phase: 'command',
        subject: command.subject,
        related: [ command.runtime.subject, command.target.subject ],
        message: 'GPUQueue.copyExternalImageToTexture() failed synchronously.',
        expected: { nativeCall: 'copyExternalImageToTexture returns successfully' },
        actual: {
            reason: 'native-call',
            nativeError,
        },
    }, { cause })
}

function serializeNativeError(cause: unknown): Record<string, unknown> {

    if (!isRecord(cause)) return { value: String(cause) }

    const nativeError: Record<string, unknown> = {
        name: typeof cause.name === 'string' ? cause.name : 'Error',
        message: typeof cause.message === 'string' ? cause.message : String(cause),
    }
    if (typeof cause.code === 'number' && Number.isFinite(cause.code)) nativeError.code = cause.code

    return nativeError
}

function nativeErrorName(cause: unknown): string | undefined {

    return isRecord(cause) && typeof cause.name === 'string' ? cause.name : undefined
}

function normalizeReadinessContract<Command extends DrawCommand | DispatchCommand>(
    command: Command,
    whenMissing: ResourceReadinessPolicy,
    fallback: Command | undefined
): { whenMissing: ResourceReadinessPolicy, fallback?: Command } {

    const policy = normalizeReadinessPolicy(command, whenMissing)

    if (policy === 'use-fallback') {
        if (fallback === undefined) {
            throwReadinessContractDiagnostic(command, policy, fallback, 'missing-fallback')
        }

        validateFallbackChain(command, fallback)
        return { whenMissing: policy, fallback }
    }

    if (fallback !== undefined) {
        throwReadinessContractDiagnostic(command, policy, fallback, 'forbidden-fallback')
    }

    return { whenMissing: policy }
}

function normalizeReadinessPolicy(command: DrawCommand | DispatchCommand, whenMissing: unknown): ResourceReadinessPolicy {

    const allowed = new Set<ResourceReadinessPolicy>([ 'throw', 'skip-command', 'skip-pass', 'use-fallback' ])

    if (typeof whenMissing !== 'string' || !allowed.has(whenMissing as ResourceReadinessPolicy)) {
        throwScratchDiagnostic({
            code: 'SCRATCH_COMMAND_READINESS_POLICY_MISSING',
            severity: 'error',
            phase: 'command',
            subject: command.subject,
            message: 'Command requires an explicit readiness policy.',
            expected: { whenMissing: [ ...allowed ] },
            actual: { whenMissing },
        })
    }

    return whenMissing as ResourceReadinessPolicy
}

function validateFallbackChain(
    command: DrawCommand | DispatchCommand,
    fallback: DrawCommand | DispatchCommand
): void {

    const visited = new Set<unknown>([ command ])
    const visitedIds = new Set<string>([ command.id ])
    const chain: (DrawCommand | DispatchCommand)[] = []
    let candidate: unknown = fallback

    while (candidate !== undefined) {
        if (visited.has(candidate)) {
            throwFallbackDiagnostic(command, candidate, 'cycle')
        }
        visited.add(candidate)

        if (!isRecord(candidate) || candidate.commandKind !== command.commandKind) {
            throwFallbackDiagnostic(command, candidate, 'commandKind')
        }

        const fallbackCommand = candidate as unknown as DrawCommand | DispatchCommand
        const fallbackId = typeof fallbackCommand.id === 'string' ? fallbackCommand.id : undefined
        if (fallbackId !== undefined) {
            if (visitedIds.has(fallbackId)) {
                throwFallbackDiagnostic(command, fallbackCommand, 'repeated-id')
            }
            visitedIds.add(fallbackId)
        }
        chain.push(fallbackCommand)
        candidate = fallbackCommand.fallback
    }

    for (const fallbackCommand of chain) {
        const isExpectedCommand = command.commandKind === 'draw'
            ? isDrawCommand(fallbackCommand)
            : isDispatchCommand(fallbackCommand)
        if (!isExpectedCommand) {
            throwFallbackDiagnostic(command, fallbackCommand, 'command')
        }
        if (fallbackCommand.runtime !== command.runtime) {
            throwFallbackDiagnostic(command, fallbackCommand, 'runtime')
        }
        if (fallbackCommand.isDisposed) {
            throwFallbackDiagnostic(command, fallbackCommand, 'disposed')
        }
        if (!hasSameWriteResourceSet(command, fallbackCommand)) {
            throwFallbackDiagnostic(command, fallbackCommand, 'writes')
        }

        const next = fallbackCommand.fallback
        if (fallbackCommand.whenMissing === 'use-fallback' && next === undefined) {
            throwFallbackDiagnostic(command, fallbackCommand, 'policy')
        }
        if (fallbackCommand.whenMissing !== 'use-fallback' && next !== undefined) {
            throwFallbackDiagnostic(command, fallbackCommand, 'policy')
        }
    }
}

function hasSameWriteResourceSet(
    command: DrawCommand | DispatchCommand,
    fallback: DrawCommand | DispatchCommand
): boolean {

    if (!fallback.resources || !Array.isArray(fallback.resources.write)) return false

    const expected = new Set(command.resources.write)
    const actual = new Set(fallback.resources.write)
    return expected.size === actual.size && [ ...expected ].every(resource => actual.has(resource))
}

function throwReadinessContractDiagnostic(
    command: DrawCommand | DispatchCommand,
    whenMissing: ResourceReadinessPolicy,
    fallback: unknown,
    reason: 'missing-fallback' | 'forbidden-fallback'
): never {

    throwScratchDiagnostic({
        code: 'SCRATCH_COMMAND_FALLBACK_INVALID',
        severity: 'error',
        phase: 'command',
        subject: command.subject,
        related: [ diagnosticSubjectOf(fallback) ].filter(isDefined),
        message: 'Command readiness policy and fallback descriptor do not form a valid contract.',
        expected: whenMissing === 'use-fallback'
            ? { whenMissing: 'use-fallback', fallback: command.commandKind === 'draw' ? 'DrawCommand' : 'DispatchCommand' }
            : { whenMissing, fallback: 'absent' },
        actual: {
            reason,
            whenMissing,
            fallback: fallback === undefined ? 'undefined' : describeValue(fallback),
        },
    })
}

function throwFallbackDiagnostic(
    command: DrawCommand | DispatchCommand,
    fallback: unknown,
    reason: 'command' | 'commandKind' | 'runtime' | 'disposed' | 'writes' | 'cycle' | 'repeated-id' | 'policy'
): never {

    const record = isRecord(fallback) ? fallback : {}
    const resources = isRecord(record.resources) && Array.isArray(record.resources.write)
        ? record.resources.write
        : []
    const runtime = isRecord(record.runtime) ? record.runtime : undefined

    throwScratchDiagnostic({
        code: 'SCRATCH_COMMAND_FALLBACK_INVALID',
        severity: 'error',
        phase: 'command',
        subject: command.subject,
        related: [
            diagnosticSubjectOf(fallback),
            ...command.resources.write.map(resource => resource.subject),
            ...resources.map(resource => diagnosticSubjectOf(resource)).filter(isDefined),
        ].filter(isDefined),
        message: 'Command fallback must be an acyclic, usable command with the same kind, runtime, and declared writes.',
        expected: {
            commandKind: command.commandKind,
            runtimeId: command.runtime.id,
            disposed: false,
            writeResourceIds: command.resources.write.map(resource => resource.id),
            fallbackChain: 'acyclic readiness contracts',
        },
        actual: {
            reason,
            fallbackCommandId: record.id,
            commandKind: record.commandKind,
            runtimeId: runtime?.id,
            disposed: record.isDisposed,
            whenMissing: record.whenMissing,
            writeResourceIds: resources.map(resource => isRecord(resource) ? resource.id : undefined),
        },
    })
}

function throwCountDiagnostic(command: DrawCommand, count: unknown): never {

    throwScratchDiagnostic({
        code: 'SCRATCH_COMMAND_COUNT_INVALID',
        severity: 'error',
        phase: 'command',
        subject: command.subject,
        related: [ command.pipeline.subject ],
        message: 'DrawCommand count must select static vertex, static indexed, or indirect execution.',
        expected: {
            count: [
                '{ vertexCount: GPUSize32, ... }',
                '{ indexCount: GPUSize32, ... } with indexBuffer',
                '{ indirect: BufferRegion }',
            ],
        },
        actual: { count },
    })
}

function throwVertexBufferDiagnostic(
    command: DrawCommand,
    { expected, actual, related = [] }: VertexBufferDiagnosticDetails
): never {

    throwScratchDiagnostic({
        code: 'SCRATCH_COMMAND_VERTEX_BUFFER_INVALID',
        severity: 'error',
        phase: 'command',
        subject: command.subject,
        related: [
            command.pipeline?.subject,
            ...related,
        ].filter(Boolean),
        message: 'DrawCommand vertex buffer binding is invalid.',
        expected,
        actual,
    })
}

function throwIndexBufferDiagnostic(
    command: DrawCommand,
    binding: unknown,
    { expected, actual, related = [] }: VertexBufferDiagnosticDetails
): never {

    throwScratchDiagnostic({
        code: 'SCRATCH_COMMAND_INDEX_BUFFER_INVALID',
        severity: 'error',
        phase: 'command',
        subject: command.subject,
        related: [
            command.pipeline?.subject,
            ...related,
        ].filter(Boolean),
        message: 'DrawCommand index buffer binding is invalid.',
        expected,
        actual: { binding: describeValue(binding), ...actual as Record<string, unknown> },
    })
}

function throwIndirectBufferDiagnostic(
    command: DrawCommand | DispatchCommand,
    { expected, actual, related = [] }: IndirectBufferDiagnosticDetails
): never {

    throwScratchDiagnostic({
        code: 'SCRATCH_COMMAND_INDIRECT_BUFFER_INVALID',
        severity: 'error',
        phase: 'command',
        subject: command.subject,
        related: [ command.pipeline?.subject, ...related ].filter(Boolean),
        message: 'Command indirect buffer is invalid.',
        expected,
        actual,
    })
}

function throwDispatchCountDiagnostic(command: DispatchCommand, count: unknown): never {

    throwScratchDiagnostic({
        code: 'SCRATCH_COMMAND_COUNT_INVALID',
        severity: 'error',
        phase: 'command',
        subject: command.subject,
        related: [ command.pipeline.subject ],
        message: 'DispatchCommand count must select static or indirect execution.',
        expected: {
            count: [
                '{ workgroups: [GPUSize32, GPUSize32?, GPUSize32?] }',
                '{ indirect: BufferRegion }',
            ],
        },
        actual: { count },
    })
}

function isGpuSize32(value: unknown): value is number {

    return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= GPU_SIZE_32_MAX
}

function isFiniteNumber(value: unknown): value is number {

    return typeof value === 'number' && Number.isFinite(value)
}

function isGpuSignedOffset32(value: unknown): value is number {

    return Number.isInteger(value) &&
        (value as number) >= GPU_SIGNED_OFFSET_32_MIN &&
        (value as number) <= GPU_SIGNED_OFFSET_32_MAX
}

for (const commandPrototype of [
    DrawCommand.prototype,
    DispatchCommand.prototype,
    UploadCommand.prototype,
    ClearBufferCommand.prototype,
    CopyCommand.prototype,
    BeginOcclusionQueryCommand.prototype,
    EndOcclusionQueryCommand.prototype,
    ResolveQuerySetCommand.prototype,
    TextureUploadCommand.prototype,
    ExternalImageUploadCommand.prototype,
    ReadbackCommand.prototype,
    ReadbackCommandClaim.prototype,
]) Object.freeze(commandPrototype)
