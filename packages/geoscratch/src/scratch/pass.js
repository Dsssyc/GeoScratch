import { UUID } from '../core/utils/uuid.js'
import { throwScratchDiagnostic } from './diagnostics.js'
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
        }
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
        }
    }

    dispose() {

        this.isDisposed = true
    }
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
