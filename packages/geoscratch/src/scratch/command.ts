import { UUID } from '../core/utils/uuid.js'
import { BufferResource } from './buffer.js'
import { throwScratchDiagnostic } from './diagnostics.js'
import { isLayoutArtifact, isLayoutUploadView, layoutArtifactSubject } from './layout-codec.js'
import { programLayoutRequirementExpected, programLayoutRequirementSubject } from './program.js'
import { QuerySetResource } from './query-set.js'
import { TextureResource } from './texture.js'
import { describeValue, diagnosticSubjectOf, getGlobalConstant, isDefined, isRecord } from './type-utils.js'
import type { BindLayoutEntry, BindSet } from './binding.js'
import type { DiagnosticSubject } from './diagnostics.js'
import type { ComputePassSpec, RenderPassSpec } from './pass.js'
import type { ComputePipeline, RenderPipeline } from './pipeline.js'
import type { LayoutArtifact, LayoutUploadView } from './layout-codec.js'
import type { ProgramBufferLayoutRequirement } from './program.js'
import type { ReadbackOperation, ReadbackRange, ReadbackRetentionPolicy } from './readback.js'
import type { Resource } from './resource.js'
import type { ScratchRuntime } from './runtime.js'
import type { SubmittedWork } from './submission.js'

const GPU_BUFFER_USAGE_VERTEX = getGlobalConstant('GPUBufferUsage', 'VERTEX', 0x20)
const GPU_BUFFER_USAGE_INDEX = getGlobalConstant('GPUBufferUsage', 'INDEX', 0x10)
const GPU_BUFFER_USAGE_INDIRECT = getGlobalConstant('GPUBufferUsage', 'INDIRECT', 0x100)
const GPU_BUFFER_USAGE_MAP_READ = getGlobalConstant('GPUBufferUsage', 'MAP_READ', 0x1)
const GPU_BUFFER_USAGE_COPY_SRC = getGlobalConstant('GPUBufferUsage', 'COPY_SRC', 0x4)
const GPU_BUFFER_USAGE_COPY_DST = getGlobalConstant('GPUBufferUsage', 'COPY_DST', 0x8)
const GPU_BUFFER_USAGE_QUERY_RESOLVE = getGlobalConstant('GPUBufferUsage', 'QUERY_RESOLVE', 0x200)
const GPU_TEXTURE_USAGE_COPY_SRC = getGlobalConstant('GPUTextureUsage', 'COPY_SRC', 0x1)
const GPU_TEXTURE_USAGE_COPY_DST = getGlobalConstant('GPUTextureUsage', 'COPY_DST', 0x2)
const GPU_SIZE_32_MAX = 0xffff_ffff
const GPU_SIGNED_OFFSET_32_MIN = -0x8000_0000
const GPU_SIGNED_OFFSET_32_MAX = 0x7fff_ffff
const DRAW_INDIRECT_BYTE_LENGTH = 16
const DRAW_INDEXED_INDIRECT_BYTE_LENGTH = 20
const DISPATCH_INDIRECT_BYTE_LENGTH = 12

export type ResourceReadinessPolicy =
    | 'throw'
    | 'skip-command'
    | 'skip-pass'
    | 'use-fallback'

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
    indirect: BufferResource
    offset?: number
}

type NormalizedIndirectCommandCount = {
    indirect: BufferResource
    offset: number
}

export type DrawCount =
    | StaticDrawCount
    | StaticIndexedDrawCount
    | IndirectCommandCount

export type DrawVertexBufferBinding = {
    slot: number
    buffer: BufferResource
    offset?: number
    size?: number
}

export type DrawIndexBufferBinding = {
    buffer: BufferResource
    format: GPUIndexFormat
    offset?: number
    size?: number
}

export type CommandDynamicOffsets = Record<number, number[]>

export type NormalizedDrawVertexBufferBinding = Omit<DrawVertexBufferBinding, 'size'> & {
    offset: number
    size: number | undefined
}

export type NormalizedDrawIndexBufferBinding = Omit<DrawIndexBufferBinding, 'offset' | 'size'> & {
    offset: number
    size: number | undefined
}

export type CommandResourceReadDescriptor = {
    resource: Resource
    contentEpoch: number
}

export type BufferCopyCommandSourceDescriptor = {
    resource: BufferResource
    contentEpoch: number
}

export type TextureCopyCommandSourceDescriptor = {
    resource: TextureResource
    contentEpoch: number
}

export type CopyCommandSourceDescriptor =
    | BufferCopyCommandSourceDescriptor
    | TextureCopyCommandSourceDescriptor

export type QuerySetSlotReadDescriptor = {
    index: number
    contentEpoch: number
}

export type ResolveQuerySetSourceDescriptor = {
    querySet: QuerySetResource
    slots: QuerySetSlotReadDescriptor[]
}

export type CommandResourceAccessDescriptor = {
    read: CommandResourceReadDescriptor[]
    write: Resource[]
}

type DrawCommandDescriptorBase = {
    label?: string
    pipeline: RenderPipeline
    bindSets?: BindSet[]
    dynamicOffsets?: CommandDynamicOffsets
    vertexBuffers?: DrawVertexBufferBinding[]
    resources: CommandResourceAccessDescriptor
    whenMissing: ResourceReadinessPolicy
}

export type NonIndexedDrawCommandDescriptor = DrawCommandDescriptorBase & {
    indexBuffer?: never
    count: StaticDrawCount | IndirectCommandCount
}

export type IndexedDrawCommandDescriptor = DrawCommandDescriptorBase & {
    indexBuffer: DrawIndexBufferBinding
    count: StaticIndexedDrawCount | IndirectCommandCount
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
    target: BufferResource
    data: ArrayBuffer | ArrayBufferView | LayoutUploadView
    offset?: number
    dataOffset?: number
    size?: number
    layout?: LayoutArtifact
    artifact?: LayoutArtifact
}

export type TexelCopyBufferLayout = {
    offset?: number
    bytesPerRow: number
    rowsPerImage?: number
}

export type BufferToBufferCopyCommandDescriptor = {
    label?: string
    source: BufferCopyCommandSourceDescriptor
    sourceOffset?: number
    target: BufferResource
    targetOffset?: number
    byteLength: number
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
    target: BufferResource
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
    sourceOffset?: number
    byteLength?: number
    range?: ReadbackRange
    retain?: ReadbackRetentionPolicy
    whenMissing: 'throw'
}

export type ReadbackCommandResultOptions = {
    after: SubmittedWork
}

export type ResolveQuerySetCommandDescriptor = {
    label?: string
    source: ResolveQuerySetSourceDescriptor
    destination: BufferResource
    destinationOffset?: number
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

export type StaticDispatchCount = {
    workgroups: [number] | [number, number] | [number, number, number]
}

export type DispatchCount = StaticDispatchCount | IndirectCommandCount

export type DispatchCommandDescriptor = {
    label?: string
    pipeline: ComputePipeline
    bindSets?: BindSet[]
    dynamicOffsets?: CommandDynamicOffsets
    count: DispatchCount
    resources: CommandResourceAccessDescriptor
    whenMissing: ResourceReadinessPolicy
}

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
    sourceOffset?: unknown
    targetOffset?: unknown
    byteLength?: unknown
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
    sourceOffset?: unknown
    targetOffset?: unknown
    byteLength?: unknown
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

export interface DrawCommand {
    runtime: ScratchRuntime
    id: string
    label?: string
    commandKind: 'draw'
    pipeline: RenderPipeline
    bindSets: BindSet[]
    dynamicOffsets: Map<number, number[]>
    vertexBuffers: NormalizedDrawVertexBufferBinding[]
    indexBuffer?: NormalizedDrawIndexBufferBinding
    count: StaticDrawCount | StaticIndexedDrawCount | NormalizedIndirectCommandCount
    resources: CommandResourceAccessDescriptor
    whenMissing: ResourceReadinessPolicy
    isDisposed: boolean
}

export class DrawCommand {

    constructor(runtime: ScratchRuntime, descriptor: DrawCommandDescriptor = {} as DrawCommandDescriptor) {

        runtime.assertActive()

        const pipeline = descriptor.pipeline
        if (!pipeline || typeof pipeline.assertRuntime !== 'function') {
            throwScratchDiagnostic({
                code: 'SCRATCH_COMMAND_DECLARED_ACCESS_INCOMPLETE',
                severity: 'error',
                phase: 'command',
                subject: { kind: 'Command', commandKind: 'draw' },
                message: 'DrawCommand requires a render pipeline.',
                expected: { pipeline: 'RenderPipeline' },
                actual: { pipeline: pipeline === undefined || pipeline === null ? String(pipeline) : typeof pipeline },
            })
        }

        pipeline.assertRuntime(runtime)

        this.runtime = runtime
        this.id = `scratch-command-${UUID()}`
        if (descriptor.label !== undefined) this.label = descriptor.label
        this.commandKind = 'draw'
        this.pipeline = pipeline
        this.bindSets = normalizeBindSets(this, descriptor.bindSets)
        this.dynamicOffsets = normalizeDynamicOffsets(this, descriptor.dynamicOffsets)
        this.vertexBuffers = normalizeVertexBuffers(this, descriptor.vertexBuffers)
        const indexBuffer = normalizeIndexBuffer(this, descriptor.indexBuffer)
        if (indexBuffer !== undefined) this.indexBuffer = indexBuffer
        this.count = normalizeDrawCount(this, descriptor.count, indexBuffer)
        this.resources = normalizeResourceAccess(this, descriptor.resources)
        this.whenMissing = normalizeReadinessPolicy(this, descriptor.whenMissing)
        this.isDisposed = false

        validateProgramLayoutRequirementsForCommand(this)
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

        this.runtime.assertActive()
        this.pipeline.assertUsable()
        for (const bindSet of this.bindSets) {
            bindSet.assertUsable()
        }
        for (const binding of this.vertexBuffers) {
            binding.buffer.assertUsable()
        }
        this.indexBuffer?.buffer.assertUsable()
        if ('indirect' in this.count) this.count.indirect.assertUsable()
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
    }

    encode(passEncoder: GPURenderPassEncoder) {

        this.assertUsable()

        passEncoder.setPipeline(this.pipeline.gpuPipeline)
        for (const bindSet of this.bindSets) {
            setBindGroupWithDynamicOffsets(this, passEncoder, bindSet)
        }
        for (const binding of this.vertexBuffers) {
            passEncoder.setVertexBuffer(binding.slot, binding.buffer.gpuBuffer, binding.offset, binding.size)
        }
        if (this.indexBuffer !== undefined) {
            passEncoder.setIndexBuffer(
                this.indexBuffer.buffer.gpuBuffer,
                this.indexBuffer.format,
                this.indexBuffer.offset,
                this.indexBuffer.size
            )
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
            passEncoder.drawIndirect(this.count.indirect.gpuBuffer, this.count.offset)
        } else {
            passEncoder.drawIndexedIndirect(this.count.indirect.gpuBuffer, this.count.offset)
        }
        for (const resource of this.resources.write) {
            resource._advanceContentEpoch()
        }
    }

    dispose(): void {

        this.isDisposed = true
    }
}

export interface BeginOcclusionQueryCommand {
    runtime: ScratchRuntime
    id: string
    label?: string
    commandKind: 'begin-occlusion-query'
    querySet: QuerySetResource
    index: number
    isDisposed: boolean
}

export class BeginOcclusionQueryCommand {

    constructor(runtime: ScratchRuntime, descriptor: BeginOcclusionQueryCommandDescriptor = {} as BeginOcclusionQueryCommandDescriptor) {

        runtime.assertActive()

        const querySet = descriptor.querySet
        if (!(querySet instanceof QuerySetResource)) {
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

        this.runtime = runtime
        this.id = `scratch-command-${UUID()}`
        if (descriptor.label !== undefined) this.label = descriptor.label
        this.commandKind = 'begin-occlusion-query'
        this.querySet = querySet
        this.index = normalizeOcclusionQueryIndex(runtime, querySet, descriptor.index)
        this.isDisposed = false
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

        this.runtime.assertActive()
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

        this.isDisposed = true
    }
}

export interface EndOcclusionQueryCommand {
    runtime: ScratchRuntime
    id: string
    label?: string
    commandKind: 'end-occlusion-query'
    isDisposed: boolean
}

export class EndOcclusionQueryCommand {

    constructor(runtime: ScratchRuntime, descriptor: EndOcclusionQueryCommandDescriptor = {}) {

        runtime.assertActive()

        this.runtime = runtime
        this.id = `scratch-command-${UUID()}`
        if (descriptor.label !== undefined) this.label = descriptor.label
        this.commandKind = 'end-occlusion-query'
        this.isDisposed = false
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

        this.runtime.assertActive()
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

        this.isDisposed = true
    }
}

export interface DispatchCommand {
    runtime: ScratchRuntime
    id: string
    label?: string
    commandKind: 'dispatch'
    pipeline: ComputePipeline
    bindSets: BindSet[]
    dynamicOffsets: Map<number, number[]>
    count: { workgroups: [number, number, number] } | NormalizedIndirectCommandCount
    resources: CommandResourceAccessDescriptor
    whenMissing: ResourceReadinessPolicy
    isDisposed: boolean
}

export class DispatchCommand {

    constructor(runtime: ScratchRuntime, descriptor: DispatchCommandDescriptor = {} as DispatchCommandDescriptor) {

        runtime.assertActive()

        const pipeline = descriptor.pipeline
        if (!pipeline || typeof pipeline.assertRuntime !== 'function' || pipeline.pipelineKind !== 'compute') {
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

        this.runtime = runtime
        this.id = `scratch-command-${UUID()}`
        if (descriptor.label !== undefined) this.label = descriptor.label
        this.commandKind = 'dispatch'
        this.pipeline = pipeline
        this.bindSets = normalizeBindSets(this, descriptor.bindSets)
        this.dynamicOffsets = normalizeDynamicOffsets(this, descriptor.dynamicOffsets)
        this.count = normalizeDispatchCount(this, descriptor.count)
        this.resources = normalizeResourceAccess(this, descriptor.resources)
        this.whenMissing = normalizeReadinessPolicy(this, descriptor.whenMissing)
        this.isDisposed = false

        validateProgramLayoutRequirementsForCommand(this)
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

        this.runtime.assertActive()
        this.pipeline.assertUsable()
        for (const bindSet of this.bindSets) {
            bindSet.assertUsable()
        }
        if ('indirect' in this.count) this.count.indirect.assertUsable()
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

    encode(passEncoder: GPUComputePassEncoder) {

        this.assertUsable()

        passEncoder.setPipeline(this.pipeline.gpuPipeline)
        for (const bindSet of this.bindSets) {
            setBindGroupWithDynamicOffsets(this, passEncoder, bindSet)
        }
        if ('indirect' in this.count) {
            passEncoder.dispatchWorkgroupsIndirect(this.count.indirect.gpuBuffer, this.count.offset)
        } else {
            passEncoder.dispatchWorkgroups(
                this.count.workgroups[0],
                this.count.workgroups[1],
                this.count.workgroups[2]
            )
        }
        for (const resource of this.resources.write) {
            resource._advanceContentEpoch()
        }
    }

    dispose(): void {

        this.isDisposed = true
    }
}

export interface UploadCommand {
    runtime: ScratchRuntime
    id: string
    label?: string
    commandKind: 'upload'
    target: BufferResource
    data: ArrayBuffer | ArrayBufferView
    layout?: LayoutArtifact
    offset: number
    dataOffset: number
    byteLength: number
    isDisposed: boolean
}

export class UploadCommand {

    constructor(runtime: ScratchRuntime, descriptor: UploadCommandDescriptor = {} as UploadCommandDescriptor) {

        runtime.assertActive()

        const target = descriptor.target
        if (!target || typeof target.assertRuntime !== 'function' || !target.gpuBuffer) {
            throwUploadDiagnostic({
                runtime,
                target,
                data: descriptor.data,
                offset: descriptor.offset,
                reason: 'target',
            })
        }

        target.assertRuntime(runtime)
        const uploadSource = normalizeUploadSource(runtime, descriptor)

        this.runtime = runtime
        this.id = `scratch-command-${UUID()}`
        if (descriptor.label !== undefined) this.label = descriptor.label
        this.commandKind = 'upload'
        this.target = target
        this.data = uploadSource.data
        const layout = normalizeUploadLayout(runtime, descriptor.layout ?? descriptor.artifact ?? uploadSource.layout, descriptor)
        if (layout !== undefined) this.layout = layout
        this.offset = normalizeUploadOffset(runtime, descriptor.offset ?? 0)
        this.dataOffset = normalizeUploadOffset(runtime, descriptor.dataOffset ?? uploadSource.dataOffset)
        const sourceByteLength = descriptor.dataOffset === undefined ? uploadSource.byteLength : undefined
        this.byteLength = normalizeUploadByteLength(runtime, this.data, this.dataOffset, descriptor, sourceByteLength)
        this.isDisposed = false

        validateUploadRange(this)
    }

    get subject(): DiagnosticSubject {

        const subject: DiagnosticSubject = {
            kind: 'Command',
            id: this.id,
            commandKind: 'upload',
        }
        if (this.label !== undefined) subject.label = this.label

        return subject
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

        this.runtime.assertActive()
        this.target.assertUsable()
    }

    execute(queue: GPUQueue) {

        this.assertUsable()

        if (!queue || typeof queue.writeBuffer !== 'function') {
            throwScratchDiagnostic({
                code: 'SCRATCH_RUNTIME_DEVICE_UNAVAILABLE',
                severity: 'error',
                phase: 'runtime',
                subject: this.runtime.subject,
                related: [ this.subject ],
                message: 'ScratchRuntime queue cannot write GPU buffers.',
                expected: { queue: 'GPUQueue with writeBuffer()' },
                actual: { writeBuffer: typeof queue?.writeBuffer },
            })
        }

        queue.writeBuffer(
            this.target.gpuBuffer,
            this.offset,
            createUploadSource(this.data, this.dataOffset, this.byteLength)
        )
        this.target._advanceContentEpoch()
    }

    dispose(): void {

        this.isDisposed = true
    }
}

export interface CopyCommand {
    runtime: ScratchRuntime
    id: string
    label?: string
    commandKind: 'copy'
    copyKind: 'buffer-to-buffer' | 'texture-to-texture' | 'buffer-to-texture' | 'texture-to-buffer'
    source: CopyCommandSourceDescriptor
    sourceOffset?: number
    sourceLayout?: Required<TexelCopyBufferLayout>
    target: BufferResource | TextureResource
    targetOffset?: number
    targetLayout?: Required<TexelCopyBufferLayout>
    byteLength?: number
    sourceOrigin?: { x: number, y: number, z: number }
    targetOrigin?: { x: number, y: number, z: number }
    sourceMipLevel?: number
    targetMipLevel?: number
    sourceAspect?: GPUTextureAspect
    targetAspect?: GPUTextureAspect
    size?: { width: number, height: number, depthOrArrayLayers: number }
    whenMissing: 'throw'
    isDisposed: boolean
}

export class CopyCommand {

    constructor(runtime: ScratchRuntime, descriptor: CopyCommandDescriptor = {} as CopyCommandDescriptor) {

        runtime.assertActive()

        const source = normalizeCopySource(runtime, descriptor)
        source.resource.assertRuntime(runtime)

        this.runtime = runtime
        this.id = `scratch-command-${UUID()}`
        if (descriptor.label !== undefined) this.label = descriptor.label
        this.commandKind = 'copy'
        this.source = source
        this.target = descriptor.target
        this.whenMissing = normalizeCopyReadinessPolicy(this, descriptor.whenMissing)
        this.isDisposed = false

        if (source.resource instanceof BufferResource && descriptor.target instanceof BufferResource) {
            const bufferDescriptor = descriptor as BufferToBufferCopyCommandDescriptor
            const target = normalizeBufferCopyTarget(runtime, bufferDescriptor, source.resource)

            this.copyKind = 'buffer-to-buffer'
            this.target = target
            this.sourceOffset = normalizeCopyOffset(runtime, bufferDescriptor.sourceOffset ?? 0, 'sourceOffset')
            this.targetOffset = normalizeCopyOffset(runtime, bufferDescriptor.targetOffset ?? 0, 'targetOffset')
            this.byteLength = normalizeCopyByteLength(runtime, bufferDescriptor.byteLength)
            validateBufferCopyUsage(runtime, source.resource, GPU_BUFFER_USAGE_COPY_SRC, 'source', 'GPUBufferUsage.COPY_SRC')
            validateBufferCopyUsage(runtime, target, GPU_BUFFER_USAGE_COPY_DST, 'target', 'GPUBufferUsage.COPY_DST')
            validateBufferCopyRange(this)
        } else if (source.resource instanceof TextureResource && descriptor.target instanceof TextureResource) {
            const textureDescriptor = descriptor as TextureToTextureCopyCommandDescriptor
            const target = normalizeTextureCopyTarget(runtime, textureDescriptor, source.resource)

            this.copyKind = 'texture-to-texture'
            this.target = target
            this.sourceOrigin = normalizeTextureCopyOrigin(runtime, textureDescriptor.sourceOrigin, 'sourceOrigin')
            this.targetOrigin = normalizeTextureCopyOrigin(runtime, textureDescriptor.targetOrigin, 'targetOrigin')
            this.sourceMipLevel = normalizeTextureCopyMipLevel(runtime, source.resource, textureDescriptor.sourceMipLevel ?? 0, 'sourceMipLevel')
            this.targetMipLevel = normalizeTextureCopyMipLevel(runtime, target, textureDescriptor.targetMipLevel ?? 0, 'targetMipLevel')
            this.sourceAspect = normalizeTextureCopyAspect(runtime, textureDescriptor.sourceAspect ?? 'all', 'sourceAspect')
            this.targetAspect = normalizeTextureCopyAspect(runtime, textureDescriptor.targetAspect ?? 'all', 'targetAspect')
            this.size = normalizeTextureCopySize(runtime, source.resource, target, textureDescriptor.size, this.sourceOrigin, this.targetOrigin)
            validateTextureCopyUsage(runtime, source.resource, GPU_TEXTURE_USAGE_COPY_SRC, 'source', 'GPUTextureUsage.COPY_SRC')
            validateTextureCopyUsage(runtime, target, GPU_TEXTURE_USAGE_COPY_DST, 'target', 'GPUTextureUsage.COPY_DST')
            validateTextureCopyRange(this)
        } else if (source.resource instanceof BufferResource && descriptor.target instanceof TextureResource) {
            const bufferToTextureDescriptor = descriptor as BufferToTextureCopyCommandDescriptor
            const target = normalizeBufferToTextureCopyTarget(runtime, bufferToTextureDescriptor, source.resource)

            this.copyKind = 'buffer-to-texture'
            this.target = target
            this.targetOrigin = normalizeTextureCopyOrigin(runtime, bufferToTextureDescriptor.targetOrigin, 'targetOrigin')
            this.targetMipLevel = normalizeTextureCopyMipLevel(runtime, target, bufferToTextureDescriptor.targetMipLevel ?? 0, 'targetMipLevel')
            this.targetAspect = normalizeTextureCopyAspect(runtime, bufferToTextureDescriptor.targetAspect ?? 'all', 'targetAspect')
            this.size = normalizeTextureCopySize(runtime, source.resource, target, bufferToTextureDescriptor.size, undefined, this.targetOrigin)
            this.sourceLayout = normalizeTexelCopyBufferLayout(runtime, source.resource, target, bufferToTextureDescriptor.sourceLayout, this.size, 'sourceLayout')
            validateBufferCopyUsage(runtime, source.resource, GPU_BUFFER_USAGE_COPY_SRC, 'source', 'GPUBufferUsage.COPY_SRC')
            validateTextureCopyUsage(runtime, target, GPU_TEXTURE_USAGE_COPY_DST, 'target', 'GPUTextureUsage.COPY_DST')
            validateBufferToTextureCopyRange(this)
        } else if (source.resource instanceof TextureResource && descriptor.target instanceof BufferResource) {
            const textureToBufferDescriptor = descriptor as TextureToBufferCopyCommandDescriptor
            const target = normalizeTextureToBufferCopyTarget(runtime, textureToBufferDescriptor, source.resource)

            this.copyKind = 'texture-to-buffer'
            this.target = target
            this.sourceOrigin = normalizeTextureCopyOrigin(runtime, textureToBufferDescriptor.sourceOrigin, 'sourceOrigin')
            this.sourceMipLevel = normalizeTextureCopyMipLevel(runtime, source.resource, textureToBufferDescriptor.sourceMipLevel ?? 0, 'sourceMipLevel')
            this.sourceAspect = normalizeTextureCopyAspect(runtime, textureToBufferDescriptor.sourceAspect ?? 'all', 'sourceAspect')
            this.size = normalizeTextureCopySize(runtime, source.resource, target, textureToBufferDescriptor.size, this.sourceOrigin, undefined)
            this.targetLayout = normalizeTexelCopyBufferLayout(runtime, target, source.resource, textureToBufferDescriptor.targetLayout, this.size, 'targetLayout')
            validateTextureCopyUsage(runtime, source.resource, GPU_TEXTURE_USAGE_COPY_SRC, 'source', 'GPUTextureUsage.COPY_SRC')
            validateBufferCopyUsage(runtime, target, GPU_BUFFER_USAGE_COPY_DST, 'target', 'GPUBufferUsage.COPY_DST')
            validateTextureToBufferCopyRange(this)
        } else {
            throwCopyDiagnostic({
                runtime,
                source: source.resource,
                target: descriptor.target,
                reason: 'target',
            })
        }
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

        this.runtime.assertActive()
        this.source.resource.assertUsable()
        this.target.assertUsable()
    }

    encode(commandEncoder: GPUCommandEncoder) {

        this.assertUsable()

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
                (this.source.resource as BufferResource).gpuBuffer,
                this.sourceOffset!,
                (this.target as BufferResource).gpuBuffer,
                this.targetOffset!,
                this.byteLength!
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
                    texture: (this.source.resource as TextureResource).gpuTexture,
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
                    buffer: (this.source.resource as BufferResource).gpuBuffer,
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
                    texture: (this.source.resource as TextureResource).gpuTexture,
                    origin: this.sourceOrigin!,
                    mipLevel: this.sourceMipLevel!,
                    aspect: this.sourceAspect!,
                },
                {
                    buffer: (this.target as BufferResource).gpuBuffer,
                    ...this.targetLayout!,
                },
                this.size!
            )
        }

        this.target._advanceContentEpoch()
    }

    dispose(): void {

        this.isDisposed = true
    }
}

export interface ReadbackCommand {
    runtime: ScratchRuntime
    id: string
    label?: string
    commandKind: 'readback'
    source: BufferCopyCommandSourceDescriptor
    range: {
        offset: number
        byteLength: number
    }
    retain: ReadbackRetentionPolicy
    whenMissing: 'throw'
    isDisposed: boolean
    result(options: ReadbackCommandResultOptions): ReadbackOperation
}

const readbackCommandResults = new WeakMap<ReadbackCommand, WeakMap<SubmittedWork, ReadbackOperation>>()

export class ReadbackCommand {

    constructor(runtime: ScratchRuntime, descriptor: ReadbackCommandDescriptor = {} as ReadbackCommandDescriptor) {

        runtime.assertActive()

        this.runtime = runtime
        this.id = `scratch-command-${UUID()}`
        if (isRecord(descriptor) && typeof descriptor.label === 'string') this.label = descriptor.label
        this.commandKind = 'readback'
        this.source = normalizeReadbackCommandSource(this, isRecord(descriptor) ? descriptor.source : undefined)
        this.range = normalizeReadbackCommandRange(this, descriptor)
        this.retain = normalizeReadbackCommandRetention(this, isRecord(descriptor) ? descriptor.retain : undefined)
        this.whenMissing = normalizeReadbackCommandReadinessPolicy(this, isRecord(descriptor) ? descriptor.whenMissing : undefined)
        this.isDisposed = false
        readbackCommandResults.set(this, new WeakMap())
    }

    get subject(): DiagnosticSubject {

        const subject: DiagnosticSubject = {
            kind: 'Command',
            id: this.id,
            commandKind: 'readback',
        }
        if (this.label !== undefined) subject.label = this.label

        return subject
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

        this._assertNotDisposed()
        this.runtime.assertActive()
        this.source.resource.assertUsable()
    }

    encode(commandEncoder: GPUCommandEncoder): GPUBuffer {

        this.assertUsable()

        const stagingDescriptor: GPUBufferDescriptor = {
            size: this.range.byteLength,
            usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
        }
        if (this.label !== undefined) stagingDescriptor.label = `${this.label} staging`
        const stagingBuffer = this.runtime.device.createBuffer(stagingDescriptor)
        commandEncoder.copyBufferToBuffer(
            this.source.resource.gpuBuffer,
            this.range.offset,
            stagingBuffer,
            0,
            this.range.byteLength
        )

        return stagingBuffer
    }

    result(options: ReadbackCommandResultOptions): ReadbackOperation {

        this._assertNotDisposed()
        this.runtime.assertActive()

        const after = options?.after
        if (!after || after.runtime !== this.runtime || typeof after.done?.then !== 'function') {
            throwScratchDiagnostic({
                code: 'SCRATCH_READBACK_COMMAND_AFTER_INVALID',
                severity: 'error',
                phase: 'readback',
                subject: this.subject,
                related: [
                    this.runtime.subject,
                    after?.subject,
                ].filter((subject): subject is DiagnosticSubject => subject !== undefined),
                message: 'ReadbackCommand result requires SubmittedWork from the same ScratchRuntime.',
                expected: { after: 'SubmittedWork from the command runtime' },
                actual: {
                    after: describeValue(after),
                    runtimeId: after?.runtime?.id,
                },
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

    dispose(): void {

        this.isDisposed = true
    }
}

export function registerReadbackCommandResult(
    command: ReadbackCommand,
    after: SubmittedWork,
    operation: ReadbackOperation
): void {

    readbackCommandResults.get(command)?.set(after, operation)
}

function normalizeReadbackCommandSource(command: ReadbackCommand, source: unknown): BufferCopyCommandSourceDescriptor {

    if (!isRecord(source)) {
        throwReadbackCommandSourceDiagnostic(command, source)
    }

    const resource = source.resource
    const contentEpoch = source.contentEpoch
    if (
        !(resource instanceof BufferResource) ||
        typeof contentEpoch !== 'number' ||
        !Number.isInteger(contentEpoch) ||
        contentEpoch < 0
    ) {
        throwReadbackCommandSourceDiagnostic(command, source)
    }

    resource.assertRuntime(command.runtime)
    if ((resource.usage & GPU_BUFFER_USAGE_COPY_SRC) === 0) {
        throwScratchDiagnostic({
            code: 'SCRATCH_RESOURCE_USAGE_MISSING',
            severity: 'error',
            phase: 'command',
            subject: command.subject,
            related: [ resource.subject, command.runtime.subject ],
            message: 'ReadbackCommand source requires GPUBufferUsage.COPY_SRC.',
            expected: { usage: 'GPUBufferUsage.COPY_SRC' },
            actual: { usage: resource.usage },
        })
    }

    return { resource, contentEpoch }
}

function throwReadbackCommandSourceDiagnostic(command: ReadbackCommand, source: unknown): never {

    throwScratchDiagnostic({
        code: 'SCRATCH_READBACK_SOURCE_INVALID',
        severity: 'error',
        phase: 'command',
        subject: command.subject,
        related: [ command.runtime.subject ],
        message: 'ReadbackCommand requires an explicit BufferResource source content epoch.',
        expected: { source: { resource: 'BufferResource', contentEpoch: 'non-negative integer' } },
        actual: { source: describeValue(source) },
    })
}

function normalizeReadbackCommandRange(
    command: ReadbackCommand,
    descriptor: ReadbackCommandDescriptor
): { offset: number, byteLength: number } {

    const range = isRecord(descriptor) ? descriptor.range : undefined
    if (range !== undefined && !isRecord(range)) {
        throwReadbackCommandRangeDiagnostic(command, descriptor)
    }

    const rangeOffset = isRecord(range) ? range.offset : undefined
    const rangeByteLength = isRecord(range) ? range.byteLength : undefined
    const sourceOffset = isRecord(descriptor) ? descriptor.sourceOffset : undefined
    const descriptorByteLength = isRecord(descriptor) ? descriptor.byteLength : undefined

    if (
        (rangeOffset !== undefined && sourceOffset !== undefined && rangeOffset !== sourceOffset) ||
        (rangeByteLength !== undefined && descriptorByteLength !== undefined && rangeByteLength !== descriptorByteLength)
    ) {
        throwReadbackCommandRangeDiagnostic(command, descriptor)
    }

    const offset = rangeOffset ?? sourceOffset ?? 0
    const defaultByteLength = typeof offset === 'number'
        ? command.source.resource.size - offset
        : Number.NaN
    const byteLength = rangeByteLength ?? descriptorByteLength ?? defaultByteLength
    if (
        typeof offset !== 'number' ||
        typeof byteLength !== 'number' ||
        !Number.isInteger(offset) ||
        !Number.isInteger(byteLength) ||
        offset < 0 ||
        byteLength <= 0 ||
        offset + byteLength > command.source.resource.size
    ) {
        throwReadbackCommandRangeDiagnostic(command, descriptor)
    }

    return { offset, byteLength }
}

function throwReadbackCommandRangeDiagnostic(command: ReadbackCommand, descriptor: ReadbackCommandDescriptor): never {

    throwScratchDiagnostic({
        code: 'SCRATCH_READBACK_RANGE_INVALID',
        severity: 'error',
        phase: 'command',
        subject: command.subject,
        related: [ command.source.resource.subject ],
        message: 'ReadbackCommand range must fit inside the source buffer.',
        expected: { offset: 'non-negative integer', byteLength: 'positive byte length within source' },
        actual: {
            sourceOffset: isRecord(descriptor) ? descriptor.sourceOffset : undefined,
            byteLength: isRecord(descriptor) ? descriptor.byteLength : undefined,
            range: isRecord(descriptor) ? descriptor.range : undefined,
            sourceSize: command.source.resource.size,
        },
    })
}

function normalizeReadbackCommandRetention(command: ReadbackCommand, retain: unknown): ReadbackRetentionPolicy {

    if (retain === undefined) return 'consume-on-read'
    if (retain === 'consume-on-read' || retain === 'until-dispose') return retain

    throwScratchDiagnostic({
        code: 'SCRATCH_READBACK_RETAIN_INVALID',
        severity: 'error',
        phase: 'command',
        subject: command.subject,
        related: [ command.source.resource.subject ],
        message: 'ReadbackCommand retain must be consume-on-read or until-dispose.',
        expected: { retain: [ 'consume-on-read', 'until-dispose' ] },
        actual: { retain },
    })
}

function normalizeReadbackCommandReadinessPolicy(command: ReadbackCommand, whenMissing: unknown): 'throw' {

    if (whenMissing === 'throw') return whenMissing

    throwScratchDiagnostic({
        code: 'SCRATCH_COMMAND_READINESS_POLICY_MISSING',
        severity: 'error',
        phase: 'command',
        subject: command.subject,
        related: [ command.source.resource.subject ],
        message: 'ReadbackCommand requires an explicit throw readiness policy.',
        expected: { whenMissing: [ 'throw' ] },
        actual: { whenMissing },
    })
}

export interface ResolveQuerySetCommand {
    runtime: ScratchRuntime
    id: string
    label?: string
    commandKind: 'resolve-query-set'
    source: ResolveQuerySetSourceDescriptor
    querySet: QuerySetResource
    firstQuery: number
    queryCount: number
    destination: BufferResource
    destinationOffset: number
    whenMissing: 'throw'
    isDisposed: boolean
}

export class ResolveQuerySetCommand {

    constructor(runtime: ScratchRuntime, descriptor: ResolveQuerySetCommandDescriptor = {} as ResolveQuerySetCommandDescriptor) {

        runtime.assertActive()

        const normalizedDescriptor = normalizeResolveDescriptor(runtime, descriptor)
        const source = normalizeResolveSource(runtime, normalizedDescriptor.source)

        const destination = normalizedDescriptor.destination
        if (!(destination instanceof BufferResource)) {
            throwResolveQuerySetDiagnostic({
                runtime,
                source: normalizedDescriptor.source,
                querySet: source.querySet,
                slots: source.slots,
                firstQuery: source.slots[0]?.index,
                queryCount: source.slots.length,
                destination,
                destinationOffset: normalizedDescriptor.destinationOffset,
                whenMissing: normalizedDescriptor.whenMissing,
                reason: 'destination',
            })
        }

        destination.assertRuntime(runtime)
        validateResolveDestinationUsage(runtime, destination)
        const destinationOffset = normalizeResolveDestinationOffset(runtime, normalizedDescriptor.destinationOffset ?? 0, source)
        validateResolveReadinessPolicy(runtime, normalizedDescriptor.whenMissing, source, destination, destinationOffset)

        this.runtime = runtime
        this.id = `scratch-command-${UUID()}`
        if (normalizedDescriptor.label !== undefined) this.label = normalizedDescriptor.label
        this.commandKind = 'resolve-query-set'
        this.source = source
        this.querySet = source.querySet
        this.firstQuery = source.slots[0]!.index
        this.queryCount = source.slots.length
        this.destination = destination
        this.destinationOffset = destinationOffset
        this.whenMissing = normalizedDescriptor.whenMissing
        this.isDisposed = false

        validateResolveQuerySetRange(this)
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

        this.runtime.assertActive()
        this.querySet.assertUsable()
        this.destination.assertUsable()
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
            this.destination.gpuBuffer,
            this.destinationOffset
        )
        this.destination._advanceContentEpoch()
    }

    dispose(): void {

        this.isDisposed = true
    }
}

export interface TextureUploadCommand {
    runtime: ScratchRuntime
    id: string
    label?: string
    commandKind: 'upload'
    uploadKind: 'texture'
    target: TextureResource
    data: ArrayBuffer | ArrayBufferView
    layout: Required<TextureUploadLayout>
    origin: { x: number, y: number, z: number }
    size: { width: number, height: number, depthOrArrayLayers: number }
    mipLevel: number
    isDisposed: boolean
}

export class TextureUploadCommand {

    constructor(runtime: ScratchRuntime, descriptor: TextureUploadCommandDescriptor = {} as TextureUploadCommandDescriptor) {

        runtime.assertActive()

        const target = descriptor.target
        if (!(target instanceof TextureResource)) {
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

        this.runtime = runtime
        this.id = `scratch-command-${UUID()}`
        if (descriptor.label !== undefined) this.label = descriptor.label
        this.commandKind = 'upload'
        this.uploadKind = 'texture'
        this.target = target
        this.data = descriptor.data
        this.origin = normalizeTextureUploadOrigin(runtime, descriptor.origin)
        this.mipLevel = normalizeTextureUploadMipLevel(runtime, target, descriptor.mipLevel ?? 0)
        this.size = normalizeTextureUploadSize(runtime, target, descriptor.size, this.origin)
        this.layout = normalizeTextureUploadLayout(runtime, target, descriptor.layout, this.size)
        this.isDisposed = false

        validateTextureUploadRange(this)
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

        this.runtime.assertActive()
        this.target.assertUsable()
    }

    execute(queue: GPUQueue) {

        this.assertUsable()

        if (!queue || typeof queue.writeTexture !== 'function') {
            throwScratchDiagnostic({
                code: 'SCRATCH_RUNTIME_DEVICE_UNAVAILABLE',
                severity: 'error',
                phase: 'runtime',
                subject: this.runtime.subject,
                related: [ this.subject ],
                message: 'ScratchRuntime queue cannot write GPU textures.',
                expected: { queue: 'GPUQueue with writeTexture()' },
                actual: { writeTexture: typeof queue?.writeTexture },
            })
        }

        queue.writeTexture(
            {
                texture: this.target.gpuTexture,
                mipLevel: this.mipLevel,
                origin: this.origin,
            },
            this.data,
            this.layout,
            this.size
        )
        this.target._advanceContentEpoch()
    }

    dispose(): void {

        this.isDisposed = true
    }
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
            querySetType: querySet instanceof QuerySetResource ? querySet.type : undefined,
            index,
        },
    })
}

function normalizeBindSets(command: DrawCommand | DispatchCommand, bindSets: BindSet[] = []): BindSet[] {

    if (!Array.isArray(bindSets)) {
        throwScratchDiagnostic({
            code: 'SCRATCH_PIPELINE_BIND_LAYOUT_INCOMPATIBLE',
            severity: 'error',
            phase: 'pipeline',
            subject: command.pipeline.subject,
            related: [ command.subject ],
            message: 'Command bindSets must be an array.',
            expected: { bindSets: 'BindSet[]' },
            actual: { bindSets },
        })
    }

    for (const bindSet of bindSets) {
        if (!bindSet || typeof bindSet.assertRuntime !== 'function') {
            throwScratchDiagnostic({
                code: 'SCRATCH_PIPELINE_BIND_LAYOUT_INCOMPATIBLE',
                severity: 'error',
                phase: 'pipeline',
                subject: command.pipeline.subject,
                related: [ command.subject ],
                message: 'Command bindSets must contain BindSet objects.',
                expected: { bindSet: 'BindSet' },
                actual: { bindSet: bindSet === undefined || bindSet === null ? String(bindSet) : typeof bindSet },
            })
        }

        bindSet.assertRuntime(command.runtime)

        const expectedLayout = command.pipeline.bindLayoutsByGroup.get(bindSet.layout.group)
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
                expected: { group: bindSet.layout.group, layoutId: expectedLayout?.id },
                actual: { group: bindSet.layout.group, layoutId: bindSet.layout.id },
            })
        }
    }

    return [ ...bindSets ]
}

type DynamicOffsetCommand = DrawCommand | DispatchCommand
type DynamicBufferBindLayoutEntry = BindLayoutEntry & {
    type: 'uniform' | 'read-storage' | 'storage'
    hasDynamicOffset: true
}

function normalizeDynamicOffsets(
    command: DynamicOffsetCommand,
    dynamicOffsets: CommandDynamicOffsets | undefined
): Map<number, number[]> {

    const suppliedOffsets = normalizeDynamicOffsetRecord(command, dynamicOffsets)
    const bindSetGroups = command.bindSets.map(bindSet => bindSet.layout.group)

    for (const group of suppliedOffsets.keys()) {
        if (!bindSetGroups.includes(group)) {
            throwScratchDiagnostic({
                code: 'SCRATCH_BIND_DYNAMIC_OFFSET_INVALID',
                severity: 'error',
                phase: 'binding',
                subject: command.pipeline.subject,
                related: [ command.subject ],
                message: 'Command dynamic offsets reference a bind group not used by this command.',
                expected: { groups: bindSetGroups },
                actual: { group },
            })
        }
    }

    const normalized = new Map<number, number[]>()
    for (const bindSet of command.bindSets) {
        const entries = dynamicBufferEntries(bindSet)
        const group = bindSet.layout.group
        const offsets = suppliedOffsets.get(group)

        if (entries.length === 0) {
            if (offsets !== undefined && offsets.length > 0) {
                throwDynamicOffsetCountDiagnostic(command, bindSet, [], offsets, bindSet.subject)
            }
            continue
        }

        if (offsets === undefined) {
            throwScratchDiagnostic({
                code: 'SCRATCH_BIND_DYNAMIC_OFFSET_MISSING',
                severity: 'error',
                phase: 'binding',
                subject: bindSet.layout.entrySubject(entries[0]),
                related: dynamicOffsetRelatedSubjects(command, bindSet, entries[0]),
                message: 'Command is missing dynamic offsets required by its BindLayout.',
                expected: dynamicOffsetExpected(group, entries),
                actual: {
                    group,
                    offsets: undefined,
                },
            })
        }

        if (offsets.length !== entries.length) {
            throwDynamicOffsetCountDiagnostic(command, bindSet, entries, offsets, bindSet.layout.entrySubject(entries[0]))
        }

        const normalizedOffsets = offsets.map((offset, index) => {
            const entry = entries[index]
            validateDynamicOffsetValue(command, bindSet, entry, offset, index)
            return offset
        })

        normalized.set(group, normalizedOffsets)
    }

    return normalized
}

function normalizeDynamicOffsetRecord(
    command: DynamicOffsetCommand,
    dynamicOffsets: CommandDynamicOffsets | undefined
): Map<number, number[]> {

    const normalized = new Map<number, number[]>()
    if (dynamicOffsets === undefined) return normalized

    if (!dynamicOffsets || typeof dynamicOffsets !== 'object' || Array.isArray(dynamicOffsets)) {
        throwScratchDiagnostic({
            code: 'SCRATCH_BIND_DYNAMIC_OFFSET_INVALID',
            severity: 'error',
            phase: 'binding',
            subject: command.subject,
            related: [ command.pipeline.subject ],
            message: 'Command dynamicOffsets must be an object keyed by bind group.',
            expected: { dynamicOffsets: 'Record<number, number[]>' },
            actual: { dynamicOffsets: describeValue(dynamicOffsets) },
        })
    }

    for (const [ key, offsets ] of Object.entries(dynamicOffsets)) {
        const group = Number(key)
        if (!Number.isInteger(group) || group < 0 || String(group) !== key) {
            throwScratchDiagnostic({
                code: 'SCRATCH_BIND_DYNAMIC_OFFSET_INVALID',
                severity: 'error',
                phase: 'binding',
                subject: command.subject,
                related: [ command.pipeline.subject ],
                message: 'Command dynamic offset groups must be non-negative integers.',
                expected: { group: 'non-negative integer' },
                actual: { group: key },
            })
        }

        if (!Array.isArray(offsets)) {
            throwScratchDiagnostic({
                code: 'SCRATCH_BIND_DYNAMIC_OFFSET_INVALID',
                severity: 'error',
                phase: 'binding',
                subject: command.subject,
                related: [ command.pipeline.subject ],
                message: 'Command dynamic offsets for a bind group must be an array.',
                expected: { offsets: 'number[]' },
                actual: { group, offsets: describeValue(offsets) },
            })
        }

        normalized.set(group, [ ...offsets ])
    }

    return normalized
}

function dynamicBufferEntries(bindSet: BindSet): DynamicBufferBindLayoutEntry[] {

    return bindSet.layout.entries
        .filter((entry): entry is DynamicBufferBindLayoutEntry =>
            (entry.type === 'uniform' || entry.type === 'read-storage' || entry.type === 'storage') &&
            entry.hasDynamicOffset === true
        )
        .sort((a, b) => a.binding - b.binding)
}

function throwDynamicOffsetCountDiagnostic(
    command: DynamicOffsetCommand,
    bindSet: BindSet,
    entries: DynamicBufferBindLayoutEntry[],
    offsets: number[],
    subject: DiagnosticSubject
): never {

    throwScratchDiagnostic({
        code: 'SCRATCH_BIND_DYNAMIC_OFFSET_INVALID',
        severity: 'error',
        phase: 'binding',
        subject,
        related: dynamicOffsetRelatedSubjects(command, bindSet, entries[0]),
        message: 'Command dynamic offset count does not match its BindLayout dynamic buffer entries.',
        expected: dynamicOffsetExpected(bindSet.layout.group, entries),
        actual: {
            group: bindSet.layout.group,
            count: offsets.length,
            offsets,
        },
    })
}

function validateDynamicOffsetValue(
    command: DynamicOffsetCommand,
    bindSet: BindSet,
    entry: DynamicBufferBindLayoutEntry,
    offset: unknown,
    index: number
): void {

    if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) {
        throwScratchDiagnostic({
            code: 'SCRATCH_BIND_DYNAMIC_OFFSET_INVALID',
            severity: 'error',
            phase: 'binding',
            subject: bindSet.layout.entrySubject(entry),
            related: dynamicOffsetRelatedSubjects(command, bindSet, entry),
            message: 'Command dynamic offsets must be non-negative integers.',
            expected: { offset: 'non-negative integer' },
            actual: {
                group: bindSet.layout.group,
                binding: entry.binding,
                index,
                offset,
            },
        })
    }

    const alignment = dynamicOffsetAlignment(command, entry)
    if (offset % alignment !== 0) {
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
                index,
                offset,
            },
        })
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

function dynamicOffsetExpected(group: number, entries: DynamicBufferBindLayoutEntry[]) {

    return {
        group,
        count: entries.length,
        bindings: entries.map(entry => entry.binding),
    }
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
    bindSet: BindSet
): void {

    const dynamicOffsets = command.dynamicOffsets.get(bindSet.layout.group)
    if (dynamicOffsets !== undefined) {
        passEncoder.setBindGroup(bindSet.layout.group, bindSet.getBindGroup(), dynamicOffsets)
        return
    }

    passEncoder.setBindGroup(bindSet.layout.group, bindSet.getBindGroup())
}

function validateProgramLayoutRequirementsForCommand(command: DrawCommand | DispatchCommand): void {

    for (const requirement of command.pipeline.program.layoutRequirements) {
        const bindSet = command.bindSets.find(candidate => candidate.layout.group === requirement.group)
        if (bindSet === undefined) {
            throwCommandProgramLayoutMismatch(command, requirement, {
                actual: {
                    bindSetGroups: command.bindSets.map(candidate => candidate.layout.group),
                },
            })
        }

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

        if (!(binding.resource instanceof BufferResource)) {
            throwCommandProgramLayoutMismatch(command, requirement, {
                bindSet,
                entry: binding.entry,
                resource: diagnosticSubjectOf(binding.resource),
                actual: { resource: describeValue(binding.resource) },
            })
        }

        const buffer = binding.resource
        if (buffer.layout === undefined) {
            throwCommandProgramLayoutMismatch(command, requirement, {
                bindSet,
                entry: binding.entry,
                resource: buffer.subject,
                actual: { structuralHash: undefined },
            })
        }

        if (buffer.layout.structuralHash !== requirement.layout.structuralHash) {
            throwCommandProgramLayoutMismatch(command, requirement, {
                bindSet,
                entry: binding.entry,
                resource: buffer.subject,
                actualLayout: buffer.layoutSubject,
                actual: { structuralHash: buffer.layout.structuralHash },
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
        entry?: BindLayoutEntry
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
    return vertexBuffers.map((binding: DrawVertexBufferBinding) => {
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

        if (slots.has(binding.slot)) {
            throwVertexBufferDiagnostic(command, {
                expected: { slot: 'unique' },
                actual: { slot: binding.slot },
            })
        }
        slots.add(binding.slot)

        const buffer = binding.buffer
        if (!(buffer instanceof BufferResource)) {
            throwVertexBufferDiagnostic(command, {
                expected: { buffer: 'BufferResource' },
                actual: {
                    buffer: describeValue(buffer),
                },
            })
        }

        buffer.assertRuntime(command.runtime)

        const offset = binding.offset ?? 0
        if (!Number.isInteger(offset) || offset < 0) {
            throwVertexBufferDiagnostic(command, {
                expected: { offset: 'non-negative integer' },
                actual: { slot: binding.slot, offset },
                related: [ buffer.subject ],
            })
        }

        if (binding.size !== undefined && (!Number.isInteger(binding.size) || binding.size <= 0)) {
            throwVertexBufferDiagnostic(command, {
                expected: { size: 'positive integer' },
                actual: { slot: binding.slot, size: binding.size },
                related: [ buffer.subject ],
            })
        }

        if (offset > buffer.size || (binding.size !== undefined && offset + binding.size > buffer.size)) {
            throwVertexBufferDiagnostic(command, {
                expected: { range: 'within BufferResource size' },
                actual: { slot: binding.slot, offset, size: binding.size, bufferSize: buffer.size },
                related: [ buffer.subject ],
            })
        }

        if ((buffer.usage & GPU_BUFFER_USAGE_VERTEX) === 0) {
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

        const normalized: NormalizedDrawVertexBufferBinding = {
            slot: binding.slot,
            buffer,
            offset,
            size: binding.size,
        }

        return normalized
    })
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

    const buffer = binding.buffer
    if (!(buffer instanceof BufferResource)) {
        throwIndexBufferDiagnostic(command, binding, {
            expected: { buffer: 'BufferResource' },
            actual: { buffer: describeValue(buffer) },
        })
    }

    buffer.assertRuntime(command.runtime)

    const format = binding.format
    if (format !== 'uint16' && format !== 'uint32') {
        throwIndexBufferDiagnostic(command, binding, {
            expected: { format: [ 'uint16', 'uint32' ] },
            actual: { format },
            related: [ buffer.subject ],
        })
    }

    const elementByteLength = format === 'uint16' ? 2 : 4
    const offset = binding.offset ?? 0
    if (!Number.isInteger(offset) || offset < 0 || offset % elementByteLength !== 0) {
        throwIndexBufferDiagnostic(command, binding, {
            expected: { offset: `non-negative integer aligned to ${elementByteLength} bytes` },
            actual: { offset, format },
            related: [ buffer.subject ],
        })
    }

    const size = binding.size
    const effectiveSize = size ?? buffer.size - offset
    if (!Number.isInteger(effectiveSize) || effectiveSize <= 0 || effectiveSize % elementByteLength !== 0) {
        throwIndexBufferDiagnostic(command, binding, {
            expected: { size: `positive integer aligned to ${elementByteLength} bytes` },
            actual: { size, effectiveSize, format },
            related: [ buffer.subject ],
        })
    }

    if (offset > buffer.size || offset + effectiveSize > buffer.size) {
        throwIndexBufferDiagnostic(command, binding, {
            expected: { range: 'within BufferResource size' },
            actual: { offset, size, effectiveSize, bufferSize: buffer.size },
            related: [ buffer.subject ],
        })
    }

    if ((buffer.usage & GPU_BUFFER_USAGE_INDEX) === 0) {
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

    return { buffer, format, offset, size }
}

function normalizeDispatchCount(command: DispatchCommand, count: DispatchCount): { workgroups: [number, number, number] } | NormalizedIndirectCommandCount {

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
            expected: { resources: { read: 'CommandResourceReadDescriptor[]', write: 'Resource[]' } },
            actual: { resources },
        })
    }

    return {
        read: normalizeResourceReadList(command, resources.read),
        write: normalizeResourceList(command, resources.write, 'write'),
    }
}

function normalizeResourceReadList(
    command: DrawCommand | DispatchCommand,
    resources: CommandResourceReadDescriptor[]
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
        if (!Number.isInteger(contentEpoch) || contentEpoch < 0) {
            throwResourceReadDescriptorDiagnostic(command, descriptor, 'contentEpoch')
        }

        resource.assertRuntime(command.runtime)

        return { resource, contentEpoch }
    })
}

function normalizeResourceList(command: DrawCommand | DispatchCommand, resources: Resource[], access: 'read' | 'write'): Resource[] {

    return resources.map((resource) => {
        if (!resource || typeof resource.assertRuntime !== 'function') {
            throwScratchDiagnostic({
                code: 'SCRATCH_COMMAND_DECLARED_ACCESS_INCOMPLETE',
                severity: 'error',
                phase: 'command',
                subject: command.subject,
                message: 'Command resource access declarations must contain Resource objects.',
                expected: { [access]: 'Resource[]' },
                actual: { resource: resource === undefined || resource === null ? String(resource) : typeof resource },
            })
        }

        resource.assertRuntime(command.runtime)
        return resource
    })
}

function isResourceLike(value: unknown): value is Resource {

    return isRecord(value) && typeof value.assertRuntime === 'function'
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
        descriptor: isResourceLike(descriptor) ? 'Resource' : describeValue(descriptor),
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
                resource: 'Resource',
                contentEpoch: 'non-negative integer',
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
                message: 'DrawCommand baseVertex must be a signed 32-bit integer.',
                expected: { baseVertex: 'signed 32-bit integer' },
                actual: { baseVertex: count.baseVertex },
            })
        }

        return { ...count } as StaticIndexedDrawCount
    }

    if (indexBuffer !== undefined) {
        throwIndexBufferDiagnostic(command, indexBuffer, {
            expected: { indexBuffer: 'omitted for non-indexed static draw count' },
            actual: { indexBuffer: indexBuffer.buffer.id, count },
            related: [ indexBuffer.buffer.subject ],
        })
    }

    if (!('vertexCount' in count)) throwCountDiagnostic(command, count)

    if (!isGpuSize32(count.vertexCount)) {
        throwScratchDiagnostic({
            code: 'SCRATCH_COMMAND_COUNT_INVALID',
            severity: 'error',
            phase: 'command',
            subject: command.subject,
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
                message: `DrawCommand ${key} must be an unsigned 32-bit integer.`,
                expected: { [key]: 'unsigned 32-bit integer' },
                actual: { [key]: count[key] },
            })
        }
    }

    return { ...count }
}

function normalizeIndirectCommandCount(
    command: DrawCommand | DispatchCommand,
    count: Record<string, unknown>,
    requiredByteLength: number,
    operation: 'draw' | 'draw-indexed' | 'dispatch'
): NormalizedIndirectCommandCount {

    const buffer = count.indirect
    if (!(buffer instanceof BufferResource)) {
        throwIndirectBufferDiagnostic(command, {
            expected: { indirect: 'BufferResource' },
            actual: {
                operation,
                indirect: describeValue(buffer),
                requiredByteLength,
            },
        })
    }

    buffer.assertRuntime(command.runtime)

    const offset = count.offset ?? 0
    if (!Number.isInteger(offset) || (offset as number) < 0 || (offset as number) % 4 !== 0) {
        throwIndirectBufferDiagnostic(command, {
            expected: { offset: 'non-negative integer aligned to 4 bytes' },
            actual: {
                operation,
                offset,
                bufferSize: buffer.size,
                requiredByteLength,
            },
            related: [ buffer.subject ],
        })
    }

    if ((offset as number) + requiredByteLength > buffer.size) {
        throwIndirectBufferDiagnostic(command, {
            expected: { range: `${requiredByteLength} bytes within BufferResource size` },
            actual: {
                operation,
                offset,
                bufferSize: buffer.size,
                requiredByteLength,
            },
            related: [ buffer.subject ],
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

    return { indirect: buffer, offset: offset as number }
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
        offset: descriptor.offset,
        dataOffset: descriptor.dataOffset,
        size: descriptor.size,
        layout: descriptor.layout ?? descriptor.artifact,
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
            offset: descriptor.offset,
            reason: 'data',
        })
    }

    const size = descriptor.size ?? sourceByteLength ?? dataByteLength - dataOffset
    if (!Number.isInteger(size) || size < 0) {
        throwUploadDiagnostic({
            runtime,
            target: descriptor.target,
            data,
            offset: descriptor.offset,
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
        command.offset + command.byteLength > command.target.size
    ) {
        throwUploadDiagnostic({
            runtime: command.runtime,
            target: command.target,
            data: command.data,
            offset: command.offset,
            dataOffset: command.dataOffset,
            size: command.byteLength,
            reason: 'range',
        })
    }

    validateUploadLayout(command)
}

function validateUploadLayout(command: UploadCommand) {

    const targetLayout = command.target.layout
    if (targetLayout === undefined) return

    if (command.layout !== undefined && command.layout.structuralHash !== targetLayout.structuralHash) {
        throwScratchDiagnostic({
            code: 'SCRATCH_CODEC_STRUCTURAL_HASH_MISMATCH',
            severity: 'error',
            phase: 'layout-codec',
            subject: command.target.layoutSubject ?? layoutArtifactSubject(targetLayout),
            related: [ command.subject, layoutArtifactSubject(command.layout), command.target.subject ],
            message: 'UploadCommand LayoutArtifact does not match the target BufferResource layout.',
            expected: { structuralHash: targetLayout.structuralHash },
            actual: { structuralHash: command.layout.structuralHash },
        })
    }

    const layoutByteLength = command.target.layoutByteLength ?? targetLayout.byteLength
    const rangeEnd = command.offset + command.byteLength
    if (rangeEnd > layoutByteLength) {
        throwScratchDiagnostic({
            code: 'SCRATCH_CODEC_BYTE_LENGTH_MISMATCH',
            severity: 'error',
            phase: 'layout-codec',
            subject: command.target.layoutSubject ?? layoutArtifactSubject(targetLayout),
            related: [ command.subject, command.target.subject ],
            message: 'UploadCommand byte range exceeds the target BufferResource layout byte length.',
            expected: { layoutByteLength },
            actual: {
                offset: command.offset,
                byteLength: command.byteLength,
                rangeEnd,
            },
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

function normalizeCopySource(runtime: ScratchRuntime, descriptor: CopyCommandDescriptor): CopyCommandSourceDescriptor {

    const source = descriptor.source
    const bufferDescriptor = descriptor as Partial<BufferToBufferCopyCommandDescriptor>
    if (!isRecord(source)) {
        throwCopySourceDiagnostic({
            runtime,
            source,
            target: descriptor.target,
            sourceOffset: bufferDescriptor.sourceOffset,
            targetOffset: bufferDescriptor.targetOffset,
            byteLength: bufferDescriptor.byteLength,
            reason: 'source',
        })
    }

    const resource = source.resource
    const contentEpoch = source.contentEpoch
    if (!(resource instanceof BufferResource) && !(resource instanceof TextureResource)) {
        throwCopySourceDiagnostic({
            runtime,
            source,
            target: descriptor.target,
            sourceOffset: bufferDescriptor.sourceOffset,
            targetOffset: bufferDescriptor.targetOffset,
            byteLength: bufferDescriptor.byteLength,
            reason: 'source.resource',
        })
    }

    if (typeof contentEpoch !== 'number' || !Number.isInteger(contentEpoch) || contentEpoch < 0) {
        throwCopySourceDiagnostic({
            runtime,
            source,
            target: descriptor.target,
            sourceOffset: bufferDescriptor.sourceOffset,
            targetOffset: bufferDescriptor.targetOffset,
            byteLength: bufferDescriptor.byteLength,
            reason: 'source.contentEpoch',
        })
    }

    return { resource, contentEpoch } as CopyCommandSourceDescriptor
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

function normalizeCopyOffset(runtime: ScratchRuntime, value: number, key: 'sourceOffset' | 'targetOffset'): number {

    if (!Number.isInteger(value) || value < 0 || value % 4 !== 0) {
        throwCopyDiagnostic({ runtime, [key]: value, reason: key })
    }

    return value
}

function normalizeCopyByteLength(runtime: ScratchRuntime, byteLength: number): number {

    if (!Number.isInteger(byteLength) || byteLength <= 0 || byteLength % 4 !== 0) {
        throwCopyDiagnostic({ runtime, byteLength, reason: 'byteLength' })
    }

    return byteLength
}

function normalizeBufferCopyTarget(runtime: ScratchRuntime, descriptor: BufferToBufferCopyCommandDescriptor, source: BufferResource): BufferResource {

    const target = descriptor.target
    if (!(target instanceof BufferResource)) {
        throwCopyDiagnostic({
            runtime,
            source,
            target,
            sourceOffset: descriptor.sourceOffset,
            targetOffset: descriptor.targetOffset,
            byteLength: descriptor.byteLength,
            reason: 'target',
        })
    }

    target.assertRuntime(runtime)
    return target
}

function normalizeTextureCopyTarget(runtime: ScratchRuntime, descriptor: TextureToTextureCopyCommandDescriptor, source: TextureResource): TextureResource {

    const target = descriptor.target
    if (!(target instanceof TextureResource)) {
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
    if (!(target instanceof TextureResource)) {
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

function normalizeTextureToBufferCopyTarget(runtime: ScratchRuntime, descriptor: TextureToBufferCopyCommandDescriptor, source: TextureResource): BufferResource {

    const target = descriptor.target
    if (!(target instanceof BufferResource)) {
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

    target.assertRuntime(runtime)
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

    if (aspect !== 'all') {
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
    buffer: BufferResource,
    texture: TextureResource,
    layout: TexelCopyBufferLayout,
    size: { width: number, height: number, depthOrArrayLayers: number },
    key: 'sourceLayout' | 'targetLayout'
): Required<TexelCopyBufferLayout> {

    if (!isRecord(layout)) {
        throwCopyDiagnostic({ runtime, source: buffer, target: texture, [key]: layout, size, reason: key })
    }

    const bytesPerPixel = getTextureBytesPerPixel(texture.format)
    if (bytesPerPixel === undefined) {
        throwCopyDiagnostic({ runtime, source: buffer, target: texture, [key]: layout, size, reason: 'format' })
    }

    const offset = layout.offset ?? 0
    const bytesPerRow = layout.bytesPerRow
    const rowsPerImage = layout.rowsPerImage ?? size.height

    for (const [ field, value ] of Object.entries({ offset, bytesPerRow, rowsPerImage })) {
        if (!Number.isInteger(value) || value < 0 || (field !== 'offset' && value === 0)) {
            throwCopyDiagnostic({ runtime, source: buffer, target: texture, [key]: layout, size, reason: field })
        }
    }

    if (bytesPerRow % 256 !== 0 || offset % bytesPerPixel !== 0) {
        throwCopyDiagnostic({ runtime, source: buffer, target: texture, [key]: layout, size, reason: bytesPerRow % 256 !== 0 ? 'bytesPerRow' : 'offset' })
    }

    const rowBytes = size.width * bytesPerPixel
    if (bytesPerRow < rowBytes || rowsPerImage < size.height) {
        throwCopyDiagnostic({ runtime, source: buffer, target: texture, [key]: layout, size, reason: key })
    }

    const requiredBytes =
        offset +
        bytesPerRow * rowsPerImage * (size.depthOrArrayLayers - 1) +
        bytesPerRow * (size.height - 1) +
        rowBytes

    if (requiredBytes > buffer.size) {
        throwCopyDiagnostic({ runtime, source: buffer, target: texture, [key]: layout, size, reason: 'range' })
    }

    return { offset, bytesPerRow, rowsPerImage }
}

function validateBufferCopyRange(command: CopyCommand) {

    const source = command.source.resource as BufferResource
    const target = command.target as BufferResource
    const sourceEnd = command.sourceOffset! + command.byteLength!
    const targetEnd = command.targetOffset! + command.byteLength!

    if (sourceEnd > source.size || targetEnd > target.size) {
        throwCopyDiagnostic({
            runtime: command.runtime,
            source,
            target,
            sourceOffset: command.sourceOffset,
            targetOffset: command.targetOffset,
            byteLength: command.byteLength,
            reason: 'range',
        })
    }

    if (
        source === target &&
        command.sourceOffset! < targetEnd &&
        command.targetOffset! < sourceEnd
    ) {
        throwCopyDiagnostic({
            runtime: command.runtime,
            source,
            target,
            sourceOffset: command.sourceOffset,
            targetOffset: command.targetOffset,
            byteLength: command.byteLength,
            reason: 'overlap',
        })
    }
}

function validateTextureCopyRange(command: CopyCommand) {

    const source = command.source.resource as TextureResource
    const target = command.target as TextureResource
    const sourceOrigin = command.sourceOrigin!
    const targetOrigin = command.targetOrigin!
    const size = command.size!
    const sourceExtent = textureMipExtent(source, command.sourceMipLevel!)
    const targetExtent = textureMipExtent(target, command.targetMipLevel!)

    if (
        source === target ||
        source.format !== target.format ||
        source.sampleCount !== 1 ||
        target.sampleCount !== 1 ||
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
            reason: source === target
                ? 'overlap'
                : source.format !== target.format
                    ? 'format'
                    : source.sampleCount !== 1 || target.sampleCount !== 1
                        ? 'sampleCount'
                        : command.sourceAspect !== 'all' || command.targetAspect !== 'all'
                            ? 'aspect'
                        : 'range',
        })
    }
}

function validateBufferToTextureCopyRange(command: CopyCommand) {

    const source = command.source.resource as BufferResource
    const target = command.target as TextureResource
    const targetOrigin = command.targetOrigin!
    const size = command.size!
    const targetExtent = textureMipExtent(target, command.targetMipLevel!)

    if (
        target.sampleCount !== 1 ||
        command.targetAspect !== 'all' ||
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
                : command.targetAspect !== 'all'
                    ? 'aspect'
                    : 'range',
        })
    }
}

function validateTextureToBufferCopyRange(command: CopyCommand) {

    const source = command.source.resource as TextureResource
    const target = command.target as BufferResource
    const sourceOrigin = command.sourceOrigin!
    const size = command.size!
    const sourceExtent = textureMipExtent(source, command.sourceMipLevel!)

    if (
        source.sampleCount !== 1 ||
        command.sourceAspect !== 'all' ||
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
                : command.sourceAspect !== 'all'
                    ? 'aspect'
                    : 'range',
        })
    }
}

function textureMipExtent(texture: TextureResource, mipLevel: number): { width: number, height: number, depthOrArrayLayers: number } {

    return {
        width: Math.max(1, texture.width >> mipLevel),
        height: Math.max(1, texture.height >> mipLevel),
        depthOrArrayLayers: texture.depthOrArrayLayers,
    }
}

function throwCopySourceDiagnostic({
    runtime,
    source,
    target,
    sourceOffset,
    targetOffset,
    byteLength,
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
        message: 'CopyCommand source must declare a BufferResource or TextureResource and required content epoch.',
        expected: {
            source: '{ resource: BufferResource or TextureResource with copy source usage, contentEpoch: non-negative integer }',
            target: 'BufferResource or TextureResource with matching copy destination usage',
            sourceOffset: 'non-negative integer aligned to 4 bytes',
            targetOffset: 'non-negative integer aligned to 4 bytes',
            byteLength: 'positive integer aligned to 4 bytes within source and target',
            sourceLayout: '{ offset?: non-negative integer, bytesPerRow: positive 256-byte aligned integer, rowsPerImage?: positive integer }',
            targetLayout: '{ offset?: non-negative integer, bytesPerRow: positive 256-byte aligned integer, rowsPerImage?: positive integer }',
            sourceOrigin: '{ x?: non-negative integer, y?: non-negative integer, z?: non-negative integer }',
            targetOrigin: '{ x?: non-negative integer, y?: non-negative integer, z?: non-negative integer }',
            sourceMipLevel: 'non-negative integer within source texture mip levels',
            targetMipLevel: 'non-negative integer within target texture mip levels',
            sourceAspect: 'GPUTextureAspect; only all is supported in this slice',
            targetAspect: 'GPUTextureAspect; only all is supported in this slice',
            size: '{ width: positive integer, height: positive integer, depthOrArrayLayers?: positive integer }',
        },
        actual: {
            reason,
            source: describeValue(source),
            target: describeValue(target),
            sourceOffset,
            targetOffset,
            byteLength,
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
    sourceOffset,
    targetOffset,
    byteLength,
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
            source: 'BufferResource or TextureResource with copy source usage',
            target: 'matching BufferResource or TextureResource with copy destination usage',
            sourceOffset: 'non-negative integer aligned to 4 bytes',
            targetOffset: 'non-negative integer aligned to 4 bytes',
            byteLength: 'positive integer aligned to 4 bytes within source and target',
            sourceLayout: '{ offset?: non-negative integer, bytesPerRow: positive 256-byte aligned integer, rowsPerImage?: positive integer }',
            targetLayout: '{ offset?: non-negative integer, bytesPerRow: positive 256-byte aligned integer, rowsPerImage?: positive integer }',
            sourceOrigin: '{ x?: non-negative integer, y?: non-negative integer, z?: non-negative integer }',
            targetOrigin: '{ x?: non-negative integer, y?: non-negative integer, z?: non-negative integer }',
            sourceMipLevel: 'non-negative integer within source texture mip levels',
            targetMipLevel: 'non-negative integer within target texture mip levels',
            sourceAspect: 'GPUTextureAspect; only all is supported in this slice',
            targetAspect: 'GPUTextureAspect; only all is supported in this slice',
            size: '{ width: positive integer, height: positive integer, depthOrArrayLayers?: positive integer }',
        },
        actual: {
            reason,
            source: describeValue(source),
            target: describeValue(target),
            sourceOffset,
            targetOffset,
            byteLength,
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

    const legacyInputs = [ 'querySet', 'firstQuery', 'queryCount' ]
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
    if (!(querySet instanceof QuerySetResource)) {
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

    return {
        querySet,
        slots,
    }
}

function normalizeResolveQuerySlots(
    runtime: ScratchRuntime,
    querySet: QuerySetResource,
    slots: unknown,
    source: unknown
): QuerySetSlotReadDescriptor[] {

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

        normalized.push({
            index,
            contentEpoch,
        })
    }

    return normalized
}

function normalizeResolveDestinationOffset(
    runtime: ScratchRuntime,
    destinationOffset: number,
    source?: ResolveQuerySetSourceDescriptor
): number {

    if (!Number.isInteger(destinationOffset) || destinationOffset < 0 || destinationOffset % 256 !== 0) {
        throwResolveQuerySetDiagnostic({
            runtime,
            source,
            querySet: source?.querySet,
            slots: source?.slots,
            firstQuery: source?.slots[0]?.index,
            queryCount: source?.slots.length,
            destinationOffset,
            reason: 'destinationOffset',
        })
    }

    return destinationOffset
}

function validateResolveReadinessPolicy(
    runtime: ScratchRuntime,
    whenMissing: unknown,
    source: ResolveQuerySetSourceDescriptor,
    destination: BufferResource,
    destinationOffset: number
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
        destinationOffset,
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
            destinationOffset: command.destinationOffset,
            whenMissing: command.whenMissing,
            reason: 'queryRange',
        })
    }

    const byteLength = command.queryCount * 8
    if (command.destinationOffset + byteLength > command.destination.size) {
        throwResolveQuerySetDiagnostic({
            runtime: command.runtime,
            querySet: command.querySet,
            slots: command.source.slots,
            firstQuery: command.firstQuery,
            queryCount: command.queryCount,
            destination: command.destination,
            destinationOffset: command.destinationOffset,
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
        message: 'ResolveQuerySetCommand requires an explicit QuerySetResource slot source, BufferResource destination, and valid query and byte ranges.',
        expected: {
            source: {
                querySet: 'QuerySetResource',
                slots: 'non-empty contiguous QuerySetSlotReadDescriptor[]',
            },
            slot: {
                index: 'integer within querySet.count',
                contentEpoch: 'non-negative integer',
            },
            destination: 'BufferResource with GPUBufferUsage.QUERY_RESOLVE',
            destinationOffset: 'non-negative integer aligned to 256 bytes with 8 bytes per query available',
            whenMissing: 'throw',
            legacyInputs: 'no top-level querySet, firstQuery, or queryCount fields',
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
        message: 'UploadCommand requires a BufferResource target, byte data, and a valid byte range.',
        expected: {
            target: 'BufferResource',
            data: 'ArrayBuffer, ArrayBufferView, or LayoutUploadView',
            offset: 'non-negative integer',
            dataOffset: 'non-negative integer',
            size: 'byte length within source and target',
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
        if (!Number.isInteger(value) || value < 0 || (key !== 'offset' && value === 0)) {
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
            layout: '{ offset?: number, bytesPerRow: number, rowsPerImage?: number }',
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

function normalizeReadinessPolicy(command: DrawCommand | DispatchCommand, whenMissing: ResourceReadinessPolicy): ResourceReadinessPolicy {

    const allowed = new Set([ 'throw', 'skip-command', 'skip-pass', 'use-fallback' ])

    if (!allowed.has(whenMissing)) {
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

    return whenMissing
}

function throwCountDiagnostic(command: DrawCommand, count: unknown): never {

    throwScratchDiagnostic({
        code: 'SCRATCH_COMMAND_COUNT_INVALID',
        severity: 'error',
        phase: 'command',
        subject: command.subject,
        message: 'DrawCommand requires a static draw count for this slice.',
        expected: { count: '{ vertexCount: number }' },
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
        message: 'DispatchCommand requires a static workgroup count for this slice.',
        expected: { count: '{ workgroups: [number, number?, number?] }' },
        actual: { count },
    })
}

function isGpuSize32(value: unknown): value is number {

    return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= GPU_SIZE_32_MAX
}

function isGpuSignedOffset32(value: unknown): value is number {

    return Number.isInteger(value) &&
        (value as number) >= GPU_SIGNED_OFFSET_32_MIN &&
        (value as number) <= GPU_SIGNED_OFFSET_32_MAX
}
