import { UUID } from '../core/utils/uuid.js'
import { throwScratchDiagnostic } from './diagnostics.js'
import { QuerySetResource } from './query-set.js'
import { TextureResource } from './texture.js'

const TEXTURE_USAGE_RENDER_ATTACHMENT = globalThis.GPUTextureUsage?.RENDER_ATTACHMENT ?? 0x10

export class RenderPassSpec {

    constructor(runtime, descriptor = {}) {

        runtime.assertActive()

        this.runtime = runtime
        this.id = `scratch-pass-${UUID()}`
        this.label = descriptor.label
        this.passKind = 'render'
        this.color = normalizeColorAttachments(this, descriptor.color)
        this.timestampWrites = normalizeTimestampWrites(this, descriptor.timestampWrites)
        this.isDisposed = false
    }

    get subject() {

        const subject = {
            kind: 'PassSpec',
            id: this.id,
            passKind: 'render',
        }
        if (this.label !== undefined) subject.label = this.label

        return subject
    }

    assertRuntime(runtime) {

        this.assertUsable()

        if (runtime !== this.runtime) {
            throwScratchDiagnostic({
                code: 'SCRATCH_PASS_WRONG_RUNTIME',
                severity: 'error',
                phase: 'submission',
                subject: this.subject,
                related: [
                    this.runtime.subject,
                    runtime?.subject,
                ].filter(Boolean),
                message: 'PassSpec belongs to a different ScratchRuntime.',
                expected: { runtimeId: this.runtime.id },
                actual: { runtimeId: runtime?.id },
            })
        }
    }

    assertUsable() {

        if (this.isDisposed) {
            throwScratchDiagnostic({
                code: 'SCRATCH_PASS_DISPOSED',
                severity: 'error',
                phase: 'submission',
                subject: this.subject,
                message: 'PassSpec has been disposed.',
            })
        }

        this.runtime.assertActive()
    }

    createRenderPassDescriptor() {

        this.assertUsable()

        return {
            label: this.label,
            colorAttachments: this.color.map((attachment) => {
                const target = attachment.target
                target.assertUsable()

                return {
                    view: createColorAttachmentView(attachment),
                    loadOp: attachment.load,
                    storeOp: attachment.store,
                    ...(attachment.clear !== undefined ? { clearValue: attachment.clear } : {}),
                }
            }),
            ...(this.timestampWrites !== undefined ? { timestampWrites: createTimestampWritesDescriptor(this.timestampWrites) } : {}),
        }
    }

    hasEncoderSideEffects() {

        return this.timestampWrites !== undefined
    }

    advanceTimestampWriteEpochs() {

        advanceTimestampWriteEpochs(this.timestampWrites)
    }

    dispose() {

        this.isDisposed = true
    }
}

export class ComputePassSpec {

    constructor(runtime, descriptor = {}) {

        runtime.assertActive()

        this.runtime = runtime
        this.id = `scratch-pass-${UUID()}`
        this.label = descriptor.label
        this.passKind = 'compute'
        this.timestampWrites = normalizeTimestampWrites(this, descriptor.timestampWrites)
        this.isDisposed = false
    }

    get subject() {

        const subject = {
            kind: 'PassSpec',
            id: this.id,
            passKind: 'compute',
        }
        if (this.label !== undefined) subject.label = this.label

        return subject
    }

    assertRuntime(runtime) {

        this.assertUsable()

        if (runtime !== this.runtime) {
            throwScratchDiagnostic({
                code: 'SCRATCH_PASS_WRONG_RUNTIME',
                severity: 'error',
                phase: 'submission',
                subject: this.subject,
                related: [
                    this.runtime.subject,
                    runtime?.subject,
                ].filter(Boolean),
                message: 'PassSpec belongs to a different ScratchRuntime.',
                expected: { runtimeId: this.runtime.id },
                actual: { runtimeId: runtime?.id },
            })
        }
    }

    assertUsable() {

        if (this.isDisposed) {
            throwScratchDiagnostic({
                code: 'SCRATCH_PASS_DISPOSED',
                severity: 'error',
                phase: 'submission',
                subject: this.subject,
                message: 'PassSpec has been disposed.',
            })
        }

        this.runtime.assertActive()
    }

    createComputePassDescriptor() {

        this.assertUsable()

        return {
            label: this.label,
            ...(this.timestampWrites !== undefined ? { timestampWrites: createTimestampWritesDescriptor(this.timestampWrites) } : {}),
        }
    }

    hasEncoderSideEffects() {

        return this.timestampWrites !== undefined
    }

    advanceTimestampWriteEpochs() {

        advanceTimestampWriteEpochs(this.timestampWrites)
    }

    dispose() {

        this.isDisposed = true
    }
}

function normalizeTimestampWrites(pass, timestampWrites) {

    if (timestampWrites === undefined) return undefined

    const querySet = timestampWrites?.querySet
    if (!(querySet instanceof QuerySetResource)) {
        throwTimestampWritesDiagnostic(pass, timestampWrites, 'querySet')
    }

    querySet.assertRuntime(pass.runtime)

    if (querySet.type !== 'timestamp') {
        throwTimestampWritesDiagnostic(pass, timestampWrites, 'querySetType')
    }

    const begin = normalizeTimestampWriteIndex(pass, querySet, timestampWrites.begin, 'begin')
    const end = normalizeTimestampWriteIndex(pass, querySet, timestampWrites.end, 'end')

    if (begin === undefined && end === undefined) {
        throwTimestampWritesDiagnostic(pass, timestampWrites, 'empty')
    }

    return {
        querySet,
        begin,
        end,
    }
}

function normalizeTimestampWriteIndex(pass, querySet, index, key) {

    if (index === undefined) return undefined

    if (!Number.isInteger(index) || index < 0 || index >= querySet.count) {
        throwTimestampWritesDiagnostic(pass, { querySet, [key]: index }, key)
    }

    return index
}

function createTimestampWritesDescriptor(timestampWrites) {

    return {
        querySet: timestampWrites.querySet.gpuQuerySet,
        ...(timestampWrites.begin !== undefined ? { beginningOfPassWriteIndex: timestampWrites.begin } : {}),
        ...(timestampWrites.end !== undefined ? { endOfPassWriteIndex: timestampWrites.end } : {}),
    }
}

function advanceTimestampWriteEpochs(timestampWrites) {

    if (timestampWrites === undefined) return

    for (const index of new Set([ timestampWrites.begin, timestampWrites.end ].filter((value) => value !== undefined))) {
        timestampWrites.querySet._advanceSlotContentEpoch(index)
    }
}

function throwTimestampWritesDiagnostic(pass, timestampWrites, reason) {

    throwScratchDiagnostic({
        code: 'SCRATCH_PASS_TIMESTAMP_WRITES_INVALID',
        severity: 'error',
        phase: 'submission',
        subject: pass.subject,
        related: [
            timestampWrites?.querySet?.subject,
        ].filter(Boolean),
        message: 'PassSpec timestampWrites requires a timestamp QuerySetResource and at least one valid query slot index.',
        expected: {
            querySet: 'timestamp QuerySetResource owned by this ScratchRuntime',
            begin: 'optional integer query index within querySet.count',
            end: 'optional integer query index within querySet.count',
        },
        actual: {
            reason,
            querySet: timestampWrites?.querySet === undefined || timestampWrites?.querySet === null ? String(timestampWrites?.querySet) : typeof timestampWrites?.querySet,
            begin: timestampWrites?.begin,
            end: timestampWrites?.end,
        },
    })
}

function normalizeColorAttachments(pass, color) {

    if (!Array.isArray(color) || color.length === 0) {
        throwScratchDiagnostic({
            code: 'SCRATCH_SUBMISSION_PASS_COMMAND_INCOMPATIBLE',
            severity: 'error',
            phase: 'submission',
            subject: pass.subject,
            message: 'RenderPassSpec requires at least one color attachment.',
            expected: { color: 'non-empty array' },
            actual: { color },
        })
    }

    return color.map((attachment, index) => normalizeColorAttachment(pass, attachment, index))
}

function normalizeColorAttachment(pass, attachment, index) {

    const target = attachment?.target
    if (target instanceof TextureResource) {
        target.assertRuntime(pass.runtime)
        validateTextureColorAttachmentUsage(pass, target)

        return {
            target,
            format: attachment.format ?? target.format,
            load: attachment.load ?? 'clear',
            store: attachment.store ?? 'store',
            clear: attachment.clear,
            viewDescriptor: attachment.viewDescriptor,
        }
    }

    if (!target || typeof target.assertUsable !== 'function' || typeof target.getCurrentTexture !== 'function') {
        throwScratchDiagnostic({
            code: 'SCRATCH_SUBMISSION_SURFACE_VIEW_OUT_OF_SCOPE',
            severity: 'error',
            phase: 'submission',
            subject: pass.subject,
            message: 'RenderPassSpec color attachment target must be a Surface or TextureResource.',
            expected: { target: 'Surface or TextureResource' },
            actual: { index, target: target === undefined || target === null ? String(target) : typeof target },
        })
    }

    target.assertUsable()

    if (target.runtime !== pass.runtime) {
        throwScratchDiagnostic({
            code: 'SCRATCH_SUBMISSION_SURFACE_VIEW_OUT_OF_SCOPE',
            severity: 'error',
            phase: 'submission',
            subject: pass.subject,
            related: [
                target.subject,
                pass.runtime.subject,
            ].filter(Boolean),
            message: 'Surface color attachment belongs to a different ScratchRuntime.',
            expected: { runtimeId: pass.runtime.id },
            actual: { runtimeId: target.runtime?.id },
        })
    }

    return {
        target,
        format: attachment.format ?? target.format,
        load: attachment.load ?? 'clear',
        store: attachment.store ?? 'store',
        clear: attachment.clear,
        viewDescriptor: attachment.viewDescriptor,
    }
}

function createColorAttachmentView(attachment) {

    const target = attachment.target
    if (target instanceof TextureResource) {
        return target.createView(attachment.viewDescriptor)
    }

    return target.getCurrentTexture().createView(attachment.viewDescriptor)
}

function validateTextureColorAttachmentUsage(pass, texture) {

    if ((texture.usage & TEXTURE_USAGE_RENDER_ATTACHMENT) !== 0) return

    throwScratchDiagnostic({
        code: 'SCRATCH_RESOURCE_USAGE_MISSING',
        severity: 'error',
        phase: 'resource',
        subject: texture.subject,
        related: [ pass.subject ],
        message: 'TextureResource color attachment requires GPUTextureUsage.RENDER_ATTACHMENT.',
        expected: { usage: 'GPUTextureUsage.RENDER_ATTACHMENT' },
        actual: { usage: texture.usage },
    })
}
