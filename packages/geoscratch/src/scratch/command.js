import { UUID } from '../core/utils/uuid.js'
import { throwScratchDiagnostic } from './diagnostics.js'

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

function normalizeBindSets(command, bindSets = []) {

    if (!Array.isArray(bindSets)) {
        throwScratchDiagnostic({
            code: 'SCRATCH_PIPELINE_BIND_LAYOUT_INCOMPATIBLE',
            severity: 'error',
            phase: 'pipeline',
            subject: command.pipeline.subject,
            related: [ command.subject ],
            message: 'DrawCommand bindSets must be an array.',
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
                message: 'DrawCommand bindSets must contain BindSet objects.',
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
                message: 'DrawCommand BindSet layout is not part of its RenderPipeline layout.',
                expected: { group: bindSet.layout.group, layoutId: expectedLayout?.id },
                actual: { group: bindSet.layout.group, layoutId: bindSet.layout.id },
            })
        }
    }

    return [ ...bindSets ]
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

function normalizeReadinessPolicy(command, whenMissing) {

    const allowed = new Set([ 'throw', 'skip-command', 'skip-pass', 'use-fallback' ])

    if (!allowed.has(whenMissing)) {
        throwScratchDiagnostic({
            code: 'SCRATCH_COMMAND_READINESS_POLICY_MISSING',
            severity: 'error',
            phase: 'command',
            subject: command.subject,
            message: 'DrawCommand requires an explicit readiness policy.',
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

function isPositiveFinite(value) {

    return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function isNonNegativeFinite(value) {

    return typeof value === 'number' && Number.isFinite(value) && value >= 0
}
