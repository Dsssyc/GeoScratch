import { UUID } from '../core/utils/uuid.js'
import { BufferResource } from './buffer.js'
import { throwScratchDiagnostic } from './diagnostics.js'
import { QuerySetResource } from './query-set.js'
import { TextureResource } from './texture.js'

const GPU_BUFFER_USAGE_VERTEX = globalThis.GPUBufferUsage?.VERTEX ?? 0x20
const GPU_BUFFER_USAGE_COPY_SRC = globalThis.GPUBufferUsage?.COPY_SRC ?? 0x4
const GPU_BUFFER_USAGE_COPY_DST = globalThis.GPUBufferUsage?.COPY_DST ?? 0x8
const GPU_BUFFER_USAGE_QUERY_RESOLVE = globalThis.GPUBufferUsage?.QUERY_RESOLVE ?? 0x200
const GPU_TEXTURE_USAGE_COPY_DST = globalThis.GPUTextureUsage?.COPY_DST ?? 0x2

export class DrawCommand {

    constructor(runtime, descriptor = {}) {

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
        this.label = descriptor.label
        this.commandKind = 'draw'
        this.pipeline = pipeline
        this.bindSets = normalizeBindSets(this, descriptor.bindSets)
        this.vertexBuffers = normalizeVertexBuffers(this, descriptor.vertexBuffers)
        this.count = normalizeDrawCount(this, descriptor.count)
        this.whenMissing = normalizeReadinessPolicy(this, descriptor.whenMissing)
        this.isDisposed = false
    }

    get subject() {

        const subject = {
            kind: 'Command',
            id: this.id,
            commandKind: 'draw',
        }
        if (this.label !== undefined) subject.label = this.label

        return subject
    }

    assertRuntime(runtime) {

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
    }

    validateForPass(passSpec) {

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

    encode(passEncoder) {

        this.assertUsable()

        passEncoder.setPipeline(this.pipeline.gpuPipeline)
        for (const bindSet of this.bindSets) {
            passEncoder.setBindGroup(bindSet.layout.group, bindSet.getBindGroup())
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
    }

    dispose() {

        this.isDisposed = true
    }
}

export class BeginOcclusionQueryCommand {

    constructor(runtime, descriptor = {}) {

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
        this.label = descriptor.label
        this.commandKind = 'begin-occlusion-query'
        this.querySet = querySet
        this.index = normalizeOcclusionQueryIndex(runtime, querySet, descriptor.index)
        this.isDisposed = false
    }

    get subject() {

        const subject = {
            kind: 'Command',
            id: this.id,
            commandKind: 'begin-occlusion-query',
        }
        if (this.label !== undefined) subject.label = this.label

        return subject
    }

    assertRuntime(runtime) {

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

    validateForPass(passSpec) {

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

    encode(passEncoder) {

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

    dispose() {

        this.isDisposed = true
    }
}

export class EndOcclusionQueryCommand {

    constructor(runtime, descriptor = {}) {

        runtime.assertActive()

        this.runtime = runtime
        this.id = `scratch-command-${UUID()}`
        this.label = descriptor.label
        this.commandKind = 'end-occlusion-query'
        this.isDisposed = false
    }

    get subject() {

        const subject = {
            kind: 'Command',
            id: this.id,
            commandKind: 'end-occlusion-query',
        }
        if (this.label !== undefined) subject.label = this.label

        return subject
    }

    assertRuntime(runtime) {

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

    validateForPass(passSpec) {

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

    encode(passEncoder) {

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

    dispose() {

        this.isDisposed = true
    }
}

export class DispatchCommand {

    constructor(runtime, descriptor = {}) {

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
        this.label = descriptor.label
        this.commandKind = 'dispatch'
        this.pipeline = pipeline
        this.bindSets = normalizeBindSets(this, descriptor.bindSets)
        this.count = normalizeDispatchCount(this, descriptor.count)
        this.resources = normalizeResourceAccess(this, descriptor.resources)
        this.whenMissing = normalizeReadinessPolicy(this, descriptor.whenMissing)
        this.isDisposed = false
    }

    get subject() {

        const subject = {
            kind: 'Command',
            id: this.id,
            commandKind: 'dispatch',
        }
        if (this.label !== undefined) subject.label = this.label

        return subject
    }

    assertRuntime(runtime) {

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
        for (const resource of [ ...this.resources.read, ...this.resources.write ]) {
            resource.assertUsable()
        }
    }

    validateForPass(passSpec) {

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

    encode(passEncoder) {

        this.assertUsable()

        passEncoder.setPipeline(this.pipeline.gpuPipeline)
        for (const bindSet of this.bindSets) {
            passEncoder.setBindGroup(bindSet.layout.group, bindSet.getBindGroup())
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

    dispose() {

        this.isDisposed = true
    }
}

export class UploadCommand {

    constructor(runtime, descriptor = {}) {

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

        this.runtime = runtime
        this.id = `scratch-command-${UUID()}`
        this.label = descriptor.label
        this.commandKind = 'upload'
        this.target = target
        this.data = descriptor.data
        this.offset = normalizeUploadOffset(runtime, descriptor.offset ?? 0)
        this.dataOffset = normalizeUploadOffset(runtime, descriptor.dataOffset ?? 0)
        this.byteLength = normalizeUploadByteLength(runtime, descriptor)
        this.isDisposed = false

        validateUploadRange(this)
    }

    get subject() {

        const subject = {
            kind: 'Command',
            id: this.id,
            commandKind: 'upload',
        }
        if (this.label !== undefined) subject.label = this.label

        return subject
    }

    assertRuntime(runtime) {

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

    execute(queue) {

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

    dispose() {

        this.isDisposed = true
    }
}

export class CopyCommand {

    constructor(runtime, descriptor = {}) {

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
        this.label = descriptor.label
        this.commandKind = 'copy'
        this.source = source
        this.target = target
        this.sourceOffset = normalizeCopyOffset(runtime, descriptor.sourceOffset ?? 0, 'sourceOffset')
        this.targetOffset = normalizeCopyOffset(runtime, descriptor.targetOffset ?? 0, 'targetOffset')
        this.byteLength = normalizeCopyByteLength(runtime, descriptor.byteLength)
        this.isDisposed = false

        validateCopyRange(this)
    }

    get subject() {

        const subject = {
            kind: 'Command',
            id: this.id,
            commandKind: 'copy',
        }
        if (this.label !== undefined) subject.label = this.label

        return subject
    }

    assertRuntime(runtime) {

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

    encode(commandEncoder) {

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

    dispose() {

        this.isDisposed = true
    }
}

export class ResolveQuerySetCommand {

    constructor(runtime, descriptor = {}) {

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
        this.label = descriptor.label
        this.commandKind = 'resolve-query-set'
        this.querySet = querySet
        this.firstQuery = normalizeResolveFirstQuery(runtime, descriptor.firstQuery ?? 0)
        this.queryCount = normalizeResolveQueryCount(runtime, descriptor.queryCount)
        this.destination = destination
        this.destinationOffset = normalizeResolveDestinationOffset(runtime, descriptor.destinationOffset ?? 0)
        this.isDisposed = false

        validateResolveQuerySetRange(this)
    }

    get subject() {

        const subject = {
            kind: 'Command',
            id: this.id,
            commandKind: 'resolve-query-set',
        }
        if (this.label !== undefined) subject.label = this.label

        return subject
    }

    assertRuntime(runtime) {

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

    encode(commandEncoder) {

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

    dispose() {

        this.isDisposed = true
    }
}

export class TextureUploadCommand {

    constructor(runtime, descriptor = {}) {

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
        this.label = descriptor.label
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

    get subject() {

        const subject = {
            kind: 'Command',
            id: this.id,
            commandKind: 'upload',
            uploadKind: 'texture',
        }
        if (this.label !== undefined) subject.label = this.label

        return subject
    }

    assertRuntime(runtime) {

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

    execute(queue) {

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

    dispose() {

        this.isDisposed = true
    }
}

function normalizeOcclusionQueryIndex(runtime, querySet, index) {

    if (!Number.isInteger(index) || index < 0 || index >= querySet.count) {
        throwOcclusionQueryCommandDiagnostic({ runtime, querySet, index, reason: 'index' })
    }

    return index
}

function throwOcclusionQueryCommandDiagnostic({ runtime, querySet, index, reason }) {

    throwScratchDiagnostic({
        code: 'SCRATCH_COMMAND_OCCLUSION_QUERY_INVALID',
        severity: 'error',
        phase: 'command',
        subject: { kind: 'Command', commandKind: 'begin-occlusion-query' },
        related: [
            runtime?.subject,
            querySet?.subject,
        ].filter(Boolean),
        message: 'BeginOcclusionQueryCommand requires an occlusion QuerySetResource and a valid query slot index.',
        expected: {
            querySet: 'occlusion QuerySetResource owned by this ScratchRuntime',
            index: 'integer query index within querySet.count',
        },
        actual: {
            reason,
            querySet: querySet === undefined || querySet === null ? String(querySet) : typeof querySet,
            querySetType: querySet?.type,
            index,
        },
    })
}

function normalizeBindSets(command, bindSets = []) {

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

function normalizeVertexBuffers(command, vertexBuffers = []) {

    if (!Array.isArray(vertexBuffers)) {
        throwVertexBufferDiagnostic(command, {
            expected: { vertexBuffers: 'DrawVertexBufferBinding[]' },
            actual: { vertexBuffers },
        })
    }

    const slots = new Set()
    return vertexBuffers.map((binding) => {
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
                    buffer: buffer === undefined || buffer === null ? String(buffer) : typeof buffer,
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

        return {
            slot: binding.slot,
            buffer,
            offset,
            size: binding.size,
        }
    })
}

function normalizeDispatchCount(command, count) {

    if (!count || typeof count !== 'object' || !Array.isArray(count.workgroups)) {
        throwDispatchCountDiagnostic(command, count)
    }

    if (count.workgroups.length < 1 || count.workgroups.length > 3) {
        throwDispatchCountDiagnostic(command, count)
    }

    const workgroups = [
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

function normalizeResourceAccess(command, resources) {

    if (!resources || typeof resources !== 'object' || !Array.isArray(resources.read) || !Array.isArray(resources.write)) {
        throwScratchDiagnostic({
            code: 'SCRATCH_COMMAND_DECLARED_ACCESS_INCOMPLETE',
            severity: 'error',
            phase: 'command',
            subject: command.subject,
            message: 'DispatchCommand requires explicit read and write resource declarations.',
            expected: { resources: { read: 'Resource[]', write: 'Resource[]' } },
            actual: { resources },
        })
    }

    return {
        read: normalizeResourceList(command, resources.read, 'read'),
        write: normalizeResourceList(command, resources.write, 'write'),
    }
}

function normalizeResourceList(command, resources, access) {

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

function normalizeDrawCount(command, count) {

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

    for (const key of [ 'instanceCount', 'firstVertex', 'firstInstance' ]) {
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

function normalizeUploadOffset(runtime, value) {

    if (!Number.isInteger(value) || value < 0) {
        throwUploadDiagnostic({ runtime, offset: value, reason: 'offset' })
    }

    return value
}

function normalizeUploadByteLength(runtime, descriptor) {

    const data = descriptor.data
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

    const size = descriptor.size ?? dataByteLength - (descriptor.dataOffset ?? 0)
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

function validateUploadRange(command) {

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
}

function getDataByteLength(data) {

    if (data instanceof ArrayBuffer) return data.byteLength
    if (ArrayBuffer.isView(data)) return data.byteLength
    return undefined
}

function createUploadSource(data, byteOffset, byteLength) {

    if (data instanceof ArrayBuffer) {
        return new Uint8Array(data, byteOffset, byteLength)
    }

    return new Uint8Array(data.buffer, data.byteOffset + byteOffset, byteLength)
}

function validateBufferCopyUsage(runtime, buffer, requiredUsage, role, usageName) {

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

function normalizeCopyOffset(runtime, value, key) {

    if (!Number.isInteger(value) || value < 0 || value % 4 !== 0) {
        throwCopyDiagnostic({ runtime, [key]: value, reason: key })
    }

    return value
}

function normalizeCopyByteLength(runtime, byteLength) {

    if (!Number.isInteger(byteLength) || byteLength <= 0 || byteLength % 4 !== 0) {
        throwCopyDiagnostic({ runtime, byteLength, reason: 'byteLength' })
    }

    return byteLength
}

function validateCopyRange(command) {

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

function throwCopyDiagnostic({ runtime, source, target, sourceOffset, targetOffset, byteLength, reason }) {

    throwScratchDiagnostic({
        code: 'SCRATCH_COMMAND_COPY_RANGE_INVALID',
        severity: 'error',
        phase: 'command',
        subject: { kind: 'Command', commandKind: 'copy' },
        related: [
            runtime?.subject,
            source?.subject,
            target?.subject,
        ].filter(Boolean),
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
            source: source === undefined || source === null ? String(source) : typeof source,
            target: target === undefined || target === null ? String(target) : typeof target,
            sourceOffset,
            targetOffset,
            byteLength,
        },
    })
}

function validateResolveDestinationUsage(runtime, destination) {

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

function normalizeResolveFirstQuery(runtime, firstQuery) {

    if (!Number.isInteger(firstQuery) || firstQuery < 0) {
        throwResolveQuerySetDiagnostic({ runtime, firstQuery, reason: 'firstQuery' })
    }

    return firstQuery
}

function normalizeResolveQueryCount(runtime, queryCount) {

    if (!Number.isInteger(queryCount) || queryCount <= 0) {
        throwResolveQuerySetDiagnostic({ runtime, queryCount, reason: 'queryCount' })
    }

    return queryCount
}

function normalizeResolveDestinationOffset(runtime, destinationOffset) {

    if (!Number.isInteger(destinationOffset) || destinationOffset < 0 || destinationOffset % 256 !== 0) {
        throwResolveQuerySetDiagnostic({ runtime, destinationOffset, reason: 'destinationOffset' })
    }

    return destinationOffset
}

function validateResolveQuerySetRange(command) {

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

function throwResolveQuerySetDiagnostic({ runtime, querySet, firstQuery, queryCount, destination, destinationOffset, reason }) {

    throwScratchDiagnostic({
        code: 'SCRATCH_COMMAND_RESOLVE_QUERY_SET_INVALID',
        severity: 'error',
        phase: 'command',
        subject: { kind: 'Command', commandKind: 'resolve-query-set' },
        related: [
            runtime?.subject,
            querySet?.subject,
            destination?.subject,
        ].filter(Boolean),
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
            querySet: querySet === undefined || querySet === null ? String(querySet) : typeof querySet,
            firstQuery,
            queryCount,
            destination: destination === undefined || destination === null ? String(destination) : typeof destination,
            destinationOffset,
        },
    })
}

function throwUploadDiagnostic({ runtime, target, data, offset, dataOffset, size, reason }) {

    throwScratchDiagnostic({
        code: 'SCRATCH_COMMAND_UPLOAD_RANGE_INVALID',
        severity: 'error',
        phase: 'command',
        subject: { kind: 'Command', commandKind: 'upload' },
        related: [
            runtime?.subject,
            target?.subject,
        ].filter(Boolean),
        message: 'UploadCommand requires a BufferResource target, byte data, and a valid byte range.',
        expected: {
            target: 'BufferResource',
            data: 'ArrayBuffer or ArrayBufferView',
            offset: 'non-negative integer',
            dataOffset: 'non-negative integer',
            size: 'byte length within source and target',
        },
        actual: {
            reason,
            target: target === undefined || target === null ? String(target) : typeof target,
            data: data === undefined || data === null ? String(data) : typeof data,
            offset,
            dataOffset,
            size,
        },
    })
}

function normalizeTextureUploadOrigin(runtime, origin = { x: 0, y: 0, z: 0 }) {

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

function normalizeTextureUploadMipLevel(runtime, target, mipLevel) {

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

function normalizeTextureUploadSize(runtime, target, size, origin) {

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

function normalizeTextureUploadLayout(runtime, target, layout = {}, size) {

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

function validateTextureUploadRange(command) {

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

function getTextureBytesPerPixel(format) {

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

function throwTextureUploadDiagnostic({ runtime, target, data, layout, origin, size, mipLevel, reason }) {

    throwScratchDiagnostic({
        code: 'SCRATCH_COMMAND_TEXTURE_UPLOAD_INVALID',
        severity: 'error',
        phase: 'command',
        subject: { kind: 'Command', commandKind: 'upload', uploadKind: 'texture' },
        related: [
            runtime?.subject,
            target?.subject,
        ].filter(Boolean),
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
            target: target === undefined || target === null ? String(target) : typeof target,
            data: data === undefined || data === null ? String(data) : typeof data,
            layout,
            origin,
            size,
            mipLevel,
        },
    })
}

function normalizeReadinessPolicy(command, whenMissing) {

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

function throwCountDiagnostic(command, count) {

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

function throwVertexBufferDiagnostic(command, { expected, actual, related = [] }) {

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

function throwDispatchCountDiagnostic(command, count) {

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

function isPositiveFinite(value) {

    return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function isNonNegativeFinite(value) {

    return typeof value === 'number' && Number.isFinite(value) && value >= 0
}
