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
import type { Resource } from './resource.js'
import type { ScratchRuntime } from './runtime.js'

const GPU_BUFFER_USAGE_VERTEX = getGlobalConstant('GPUBufferUsage', 'VERTEX', 0x20)
const GPU_BUFFER_USAGE_COPY_SRC = getGlobalConstant('GPUBufferUsage', 'COPY_SRC', 0x4)
const GPU_BUFFER_USAGE_COPY_DST = getGlobalConstant('GPUBufferUsage', 'COPY_DST', 0x8)
const GPU_BUFFER_USAGE_QUERY_RESOLVE = getGlobalConstant('GPUBufferUsage', 'QUERY_RESOLVE', 0x200)
const GPU_TEXTURE_USAGE_COPY_DST = getGlobalConstant('GPUTextureUsage', 'COPY_DST', 0x2)

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

export type DrawVertexBufferBinding = {
    slot: number
    buffer: BufferResource
    offset?: number
    size?: number
}

export type CommandDynamicOffsets = Record<number, number[]>

export type NormalizedDrawVertexBufferBinding = Omit<DrawVertexBufferBinding, 'size'> & {
    offset: number
    size: number | undefined
}

export type CommandResourceReadDescriptor = {
    resource: Resource
    contentEpoch: number
}

export type CommandResourceAccessDescriptor = {
    read: CommandResourceReadDescriptor[]
    write: Resource[]
}

export type DrawCommandDescriptor = {
    label?: string
    pipeline: RenderPipeline
    bindSets?: BindSet[]
    dynamicOffsets?: CommandDynamicOffsets
    vertexBuffers?: DrawVertexBufferBinding[]
    count: StaticDrawCount
    resources: CommandResourceAccessDescriptor
    whenMissing: ResourceReadinessPolicy
}

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

export type CopyCommandDescriptor = {
    label?: string
    source: BufferResource
    sourceOffset?: number
    target: BufferResource
    targetOffset?: number
    byteLength: number
}

export type ResolveQuerySetCommandDescriptor = {
    label?: string
    querySet: QuerySetResource
    firstQuery?: number
    queryCount: number
    destination: BufferResource
    destinationOffset?: number
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

export type DispatchCommandDescriptor = {
    label?: string
    pipeline: ComputePipeline
    bindSets?: BindSet[]
    dynamicOffsets?: CommandDynamicOffsets
    count: StaticDispatchCount
    resources: CommandResourceAccessDescriptor
    whenMissing: ResourceReadinessPolicy
}

type DrawCountOptionalKey = Exclude<keyof StaticDrawCount, 'vertexCount'>

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
    reason: string
}

type ResolveQuerySetDiagnosticInput = {
    runtime?: ScratchRuntime
    querySet?: unknown
    firstQuery?: unknown
    queryCount?: unknown
    destination?: unknown
    destinationOffset?: unknown
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
    count: StaticDrawCount
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
        this.count = normalizeDrawCount(this, descriptor.count)
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
        passEncoder.draw(
            this.count.vertexCount,
            this.count.instanceCount ?? 1,
            this.count.firstVertex ?? 0,
            this.count.firstInstance ?? 0
        )
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
    count: { workgroups: [number, number, number] }
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
        passEncoder.dispatchWorkgroups(
            this.count.workgroups[0],
            this.count.workgroups[1],
            this.count.workgroups[2]
        )
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
    source: BufferResource
    sourceOffset: number
    target: BufferResource
    targetOffset: number
    byteLength: number
    isDisposed: boolean
}

export class CopyCommand {

    constructor(runtime: ScratchRuntime, descriptor: CopyCommandDescriptor = {} as CopyCommandDescriptor) {

        runtime.assertActive()

        const source = descriptor.source
        if (!(source instanceof BufferResource)) {
            throwCopyDiagnostic({
                runtime,
                source,
                target: descriptor.target,
                sourceOffset: descriptor.sourceOffset,
                targetOffset: descriptor.targetOffset,
                byteLength: descriptor.byteLength,
                reason: 'source',
            })
        }

        source.assertRuntime(runtime)

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
        validateBufferCopyUsage(runtime, source, GPU_BUFFER_USAGE_COPY_SRC, 'source', 'GPUBufferUsage.COPY_SRC')
        validateBufferCopyUsage(runtime, target, GPU_BUFFER_USAGE_COPY_DST, 'target', 'GPUBufferUsage.COPY_DST')

        this.runtime = runtime
        this.id = `scratch-command-${UUID()}`
        if (descriptor.label !== undefined) this.label = descriptor.label
        this.commandKind = 'copy'
        this.source = source
        this.target = target
        this.sourceOffset = normalizeCopyOffset(runtime, descriptor.sourceOffset ?? 0, 'sourceOffset')
        this.targetOffset = normalizeCopyOffset(runtime, descriptor.targetOffset ?? 0, 'targetOffset')
        this.byteLength = normalizeCopyByteLength(runtime, descriptor.byteLength)
        this.isDisposed = false

        validateCopyRange(this)
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
        this.source.assertUsable()
        this.target.assertUsable()
    }

    encode(commandEncoder: GPUCommandEncoder) {

        this.assertUsable()

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
            this.source.gpuBuffer,
            this.sourceOffset,
            this.target.gpuBuffer,
            this.targetOffset,
            this.byteLength
        )
        this.target._advanceContentEpoch()
    }

    dispose(): void {

        this.isDisposed = true
    }
}

export interface ResolveQuerySetCommand {
    runtime: ScratchRuntime
    id: string
    label?: string
    commandKind: 'resolve-query-set'
    querySet: QuerySetResource
    firstQuery: number
    queryCount: number
    destination: BufferResource
    destinationOffset: number
    isDisposed: boolean
}

export class ResolveQuerySetCommand {

    constructor(runtime: ScratchRuntime, descriptor: ResolveQuerySetCommandDescriptor = {} as ResolveQuerySetCommandDescriptor) {

        runtime.assertActive()

        const querySet = descriptor.querySet
        if (!(querySet instanceof QuerySetResource)) {
            throwResolveQuerySetDiagnostic({
                runtime,
                querySet,
                firstQuery: descriptor.firstQuery,
                queryCount: descriptor.queryCount,
                destination: descriptor.destination,
                destinationOffset: descriptor.destinationOffset,
                reason: 'querySet',
            })
        }

        querySet.assertRuntime(runtime)

        const destination = descriptor.destination
        if (!(destination instanceof BufferResource)) {
            throwResolveQuerySetDiagnostic({
                runtime,
                querySet,
                firstQuery: descriptor.firstQuery,
                queryCount: descriptor.queryCount,
                destination,
                destinationOffset: descriptor.destinationOffset,
                reason: 'destination',
            })
        }

        destination.assertRuntime(runtime)
        validateResolveDestinationUsage(runtime, destination)

        this.runtime = runtime
        this.id = `scratch-command-${UUID()}`
        if (descriptor.label !== undefined) this.label = descriptor.label
        this.commandKind = 'resolve-query-set'
        this.querySet = querySet
        this.firstQuery = normalizeResolveFirstQuery(runtime, descriptor.firstQuery ?? 0)
        this.queryCount = normalizeResolveQueryCount(runtime, descriptor.queryCount)
        this.destination = destination
        this.destinationOffset = normalizeResolveDestinationOffset(runtime, descriptor.destinationOffset ?? 0)
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

function normalizeDispatchCount(command: DispatchCommand, count: StaticDispatchCount): { workgroups: [number, number, number] } {

    if (!count || typeof count !== 'object' || !Array.isArray(count.workgroups)) {
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

    for (const value of workgroups) {
        if (!Number.isInteger(value) || value <= 0) {
            throwScratchDiagnostic({
                code: 'SCRATCH_COMMAND_COUNT_INVALID',
                severity: 'error',
                phase: 'command',
                subject: command.subject,
                message: 'DispatchCommand workgroup counts must be positive integers.',
                expected: { workgroups: 'positive integer tuple' },
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

function normalizeDrawCount(command: DrawCommand, count: StaticDrawCount): StaticDrawCount {

    if (!count || typeof count !== 'object') {
        throwCountDiagnostic(command, count)
    }

    if (!isPositiveFinite(count.vertexCount)) {
        throwScratchDiagnostic({
            code: 'SCRATCH_COMMAND_COUNT_INVALID',
            severity: 'error',
            phase: 'command',
            subject: command.subject,
            message: 'DrawCommand vertexCount must be a positive finite number.',
            expected: { vertexCount: 'positive finite number' },
            actual: { vertexCount: count.vertexCount },
        })
    }

    for (const key of [ 'instanceCount', 'firstVertex', 'firstInstance' ] satisfies DrawCountOptionalKey[]) {
        if (count[key] !== undefined && !isNonNegativeFinite(count[key])) {
            throwScratchDiagnostic({
                code: 'SCRATCH_COMMAND_COUNT_INVALID',
                severity: 'error',
                phase: 'command',
                subject: command.subject,
                message: `DrawCommand ${key} must be a non-negative finite number.`,
                expected: { [key]: 'non-negative finite number' },
                actual: { [key]: count[key] },
            })
        }
    }

    return { ...count }
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

function validateCopyRange(command: CopyCommand) {

    const sourceEnd = command.sourceOffset + command.byteLength
    const targetEnd = command.targetOffset + command.byteLength

    if (sourceEnd > command.source.size || targetEnd > command.target.size) {
        throwCopyDiagnostic({
            runtime: command.runtime,
            source: command.source,
            target: command.target,
            sourceOffset: command.sourceOffset,
            targetOffset: command.targetOffset,
            byteLength: command.byteLength,
            reason: 'range',
        })
    }

    if (
        command.source === command.target &&
        command.sourceOffset < targetEnd &&
        command.targetOffset < sourceEnd
    ) {
        throwCopyDiagnostic({
            runtime: command.runtime,
            source: command.source,
            target: command.target,
            sourceOffset: command.sourceOffset,
            targetOffset: command.targetOffset,
            byteLength: command.byteLength,
            reason: 'overlap',
        })
    }
}

function throwCopyDiagnostic({ runtime, source, target, sourceOffset, targetOffset, byteLength, reason }: CopyDiagnosticInput): never {

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
        message: 'CopyCommand requires BufferResource source and target buffers with a valid aligned byte range.',
        expected: {
            source: 'BufferResource with GPUBufferUsage.COPY_SRC',
            target: 'BufferResource with GPUBufferUsage.COPY_DST',
            sourceOffset: 'non-negative integer aligned to 4 bytes',
            targetOffset: 'non-negative integer aligned to 4 bytes',
            byteLength: 'positive integer aligned to 4 bytes within source and target',
        },
        actual: {
            reason,
            source: describeValue(source),
            target: describeValue(target),
            sourceOffset,
            targetOffset,
            byteLength,
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

function normalizeResolveFirstQuery(runtime: ScratchRuntime, firstQuery: number): number {

    if (!Number.isInteger(firstQuery) || firstQuery < 0) {
        throwResolveQuerySetDiagnostic({ runtime, firstQuery, reason: 'firstQuery' })
    }

    return firstQuery
}

function normalizeResolveQueryCount(runtime: ScratchRuntime, queryCount: number): number {

    if (!Number.isInteger(queryCount) || queryCount <= 0) {
        throwResolveQuerySetDiagnostic({ runtime, queryCount, reason: 'queryCount' })
    }

    return queryCount
}

function normalizeResolveDestinationOffset(runtime: ScratchRuntime, destinationOffset: number): number {

    if (!Number.isInteger(destinationOffset) || destinationOffset < 0 || destinationOffset % 256 !== 0) {
        throwResolveQuerySetDiagnostic({ runtime, destinationOffset, reason: 'destinationOffset' })
    }

    return destinationOffset
}

function validateResolveQuerySetRange(command: ResolveQuerySetCommand) {

    if (command.firstQuery >= command.querySet.count || command.firstQuery + command.queryCount > command.querySet.count) {
        throwResolveQuerySetDiagnostic({
            runtime: command.runtime,
            querySet: command.querySet,
            firstQuery: command.firstQuery,
            queryCount: command.queryCount,
            destination: command.destination,
            destinationOffset: command.destinationOffset,
            reason: 'queryRange',
        })
    }

    const byteLength = command.queryCount * 8
    if (command.destinationOffset + byteLength > command.destination.size) {
        throwResolveQuerySetDiagnostic({
            runtime: command.runtime,
            querySet: command.querySet,
            firstQuery: command.firstQuery,
            queryCount: command.queryCount,
            destination: command.destination,
            destinationOffset: command.destinationOffset,
            reason: 'destinationRange',
        })
    }
}

function throwResolveQuerySetDiagnostic({
    runtime,
    querySet,
    firstQuery,
    queryCount,
    destination,
    destinationOffset,
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
        message: 'ResolveQuerySetCommand requires a QuerySetResource source, BufferResource destination, and valid query and byte ranges.',
        expected: {
            querySet: 'QuerySetResource',
            firstQuery: 'non-negative integer within querySet.count',
            queryCount: 'positive integer fitting inside querySet.count',
            destination: 'BufferResource with GPUBufferUsage.QUERY_RESOLVE',
            destinationOffset: 'non-negative integer aligned to 256 bytes with 8 bytes per query available',
        },
        actual: {
            reason,
            querySet: describeValue(querySet),
            firstQuery,
            queryCount,
            destination: describeValue(destination),
            destinationOffset,
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

function isPositiveFinite(value: unknown): value is number {

    return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function isNonNegativeFinite(value: unknown): value is number {

    return typeof value === 'number' && Number.isFinite(value) && value >= 0
}
