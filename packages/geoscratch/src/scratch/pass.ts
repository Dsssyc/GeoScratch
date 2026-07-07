import { UUID } from '../core/utils/uuid.js'
import { throwScratchDiagnostic } from './diagnostics.js'
import { QuerySetResource } from './query-set.js'
import { TextureResource } from './texture.js'
import type { ScratchRuntime } from './runtime.js'
import type { Surface } from './surface.js'

const TEXTURE_USAGE_RENDER_ATTACHMENT = globalThis.GPUTextureUsage?.RENDER_ATTACHMENT ?? 0x10

export type TimestampWritesSpec = {
    querySet: QuerySetResource
    begin?: number
    end?: number
}

export type RenderPassColorAttachmentSpec = {
    target: Surface | TextureResource
    format?: GPUTextureFormat
    load?: GPULoadOp
    store?: GPUStoreOp
    clear?: GPUColor
    viewDescriptor?: GPUTextureViewDescriptor
}

export type RenderPassSpecDescriptor = {
    label?: string
    color: RenderPassColorAttachmentSpec[]
    timestampWrites?: TimestampWritesSpec
    occlusionQuerySet?: QuerySetResource
}

export type ComputePassSpecDescriptor = {
    label?: string
    timestampWrites?: TimestampWritesSpec
}

export interface RenderPassSpec {
    runtime: ScratchRuntime
    id: string
    label?: string
    passKind: 'render'
    color: RenderPassColorAttachmentSpec[]
    timestampWrites?: TimestampWritesSpec
    occlusionQuerySet?: QuerySetResource
    isDisposed: boolean
}

export class RenderPassSpec {

    constructor(runtime: ScratchRuntime, descriptor: RenderPassSpecDescriptor) {

        runtime.assertActive()

        this.runtime = runtime
        this.id = `scratch-pass-${UUID()}`
        this.label = descriptor.label
        this.passKind = 'render'
        this.color = normalizeColorAttachments(this, descriptor.color)
        this.timestampWrites = normalizeTimestampWrites(this, descriptor.timestampWrites)
        this.occlusionQuerySet = normalizeOcclusionQuerySet(this, descriptor.occlusionQuerySet)
        this.isDisposed = false
    }

    get subject() {

        const subject: any = {
            kind: 'PassSpec',
            id: this.id,
            passKind: 'render',
        }
        if (this.label !== undefined) subject.label = this.label

        return subject
    }

    assertRuntime(runtime: ScratchRuntime) {

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

    createRenderPassDescriptor(): GPURenderPassDescriptor {

        this.assertUsable()
        this.occlusionQuerySet?.assertUsable()

        return {
            label: this.label,
            colorAttachments: this.color.map((attachment) => {
                const target = attachment.target
                target.assertUsable()

                return {
                    view: createColorAttachmentView(attachment),
                    loadOp: attachment.load ?? 'clear',
                    storeOp: attachment.store ?? 'store',
                    ...(attachment.clear !== undefined ? { clearValue: attachment.clear } : {}),
                }
            }),
            ...(this.timestampWrites !== undefined ? { timestampWrites: createTimestampWritesDescriptor(this.timestampWrites) } : {}),
            ...(this.occlusionQuerySet !== undefined ? { occlusionQuerySet: this.occlusionQuerySet.gpuQuerySet } : {}),
        }
    }

    hasEncoderSideEffects(): boolean {

        return this.timestampWrites !== undefined
    }

    advanceTimestampWriteEpochs(): void {

        advanceTimestampWriteEpochs(this.timestampWrites)
    }

    dispose(): void {

        this.isDisposed = true
    }
}

export interface ComputePassSpec {
    runtime: ScratchRuntime
    id: string
    label?: string
    passKind: 'compute'
    timestampWrites?: TimestampWritesSpec
    isDisposed: boolean
}

export class ComputePassSpec {

    constructor(runtime: ScratchRuntime, descriptor: ComputePassSpecDescriptor = {}) {

        runtime.assertActive()

        this.runtime = runtime
        this.id = `scratch-pass-${UUID()}`
        this.label = descriptor.label
        this.passKind = 'compute'
        this.timestampWrites = normalizeTimestampWrites(this, descriptor.timestampWrites)
        this.isDisposed = false
    }

    get subject() {

        const subject: any = {
            kind: 'PassSpec',
            id: this.id,
            passKind: 'compute',
        }
        if (this.label !== undefined) subject.label = this.label

        return subject
    }

    assertRuntime(runtime: ScratchRuntime) {

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

    createComputePassDescriptor(): GPUComputePassDescriptor {

        this.assertUsable()

        return {
            label: this.label,
            ...(this.timestampWrites !== undefined ? { timestampWrites: createTimestampWritesDescriptor(this.timestampWrites) } : {}),
        }
    }

    hasEncoderSideEffects(): boolean {

        return this.timestampWrites !== undefined
    }

    advanceTimestampWriteEpochs(): void {

        advanceTimestampWriteEpochs(this.timestampWrites)
    }

    dispose(): void {

        this.isDisposed = true
    }
}

function normalizeTimestampWrites(
    pass: RenderPassSpec | ComputePassSpec,
    timestampWrites?: TimestampWritesSpec
): TimestampWritesSpec | undefined {

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

function normalizeOcclusionQuerySet(pass: RenderPassSpec, querySet?: QuerySetResource): QuerySetResource | undefined {

    if (querySet === undefined) return undefined

    if (!(querySet instanceof QuerySetResource)) {
        throwOcclusionQuerySetDiagnostic(pass, querySet, 'querySet')
    }

    querySet.assertRuntime(pass.runtime)

    if (querySet.type !== 'occlusion') {
        throwOcclusionQuerySetDiagnostic(pass, querySet, 'querySetType')
    }

    return querySet
}

function normalizeTimestampWriteIndex(
    pass: RenderPassSpec | ComputePassSpec,
    querySet: QuerySetResource,
    index: number | undefined,
    key: 'begin' | 'end'
): number | undefined {

    if (index === undefined) return undefined

    if (!Number.isInteger(index) || index < 0 || index >= querySet.count) {
        throwTimestampWritesDiagnostic(pass, { querySet, [key]: index }, key)
    }

    return index
}

function createTimestampWritesDescriptor(timestampWrites: TimestampWritesSpec): GPUComputePassTimestampWrites | GPURenderPassTimestampWrites {

    return {
        querySet: timestampWrites.querySet.gpuQuerySet,
        ...(timestampWrites.begin !== undefined ? { beginningOfPassWriteIndex: timestampWrites.begin } : {}),
        ...(timestampWrites.end !== undefined ? { endOfPassWriteIndex: timestampWrites.end } : {}),
    }
}

function advanceTimestampWriteEpochs(timestampWrites?: TimestampWritesSpec) {

    if (timestampWrites === undefined) return

    const indices = [ timestampWrites.begin, timestampWrites.end ].filter((value): value is number => value !== undefined)
    for (const index of new Set(indices)) {
        timestampWrites.querySet._advanceSlotContentEpoch(index)
    }
}

function throwTimestampWritesDiagnostic(pass: RenderPassSpec | ComputePassSpec, timestampWrites: any, reason: string) {

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

function throwOcclusionQuerySetDiagnostic(pass: RenderPassSpec, querySet: any, reason: string) {

    throwScratchDiagnostic({
        code: 'SCRATCH_PASS_OCCLUSION_QUERY_SET_INVALID',
        severity: 'error',
        phase: 'submission',
        subject: pass.subject,
        related: [
            querySet?.subject,
        ].filter(Boolean),
        message: 'RenderPassSpec occlusionQuerySet requires an occlusion QuerySetResource owned by this ScratchRuntime.',
        expected: { occlusionQuerySet: 'occlusion QuerySetResource owned by this ScratchRuntime' },
        actual: {
            reason,
            occlusionQuerySet: querySet === undefined || querySet === null ? String(querySet) : typeof querySet,
            querySetType: querySet?.type,
        },
    })
}

function normalizeColorAttachments(pass: RenderPassSpec, color: RenderPassColorAttachmentSpec[]): RenderPassColorAttachmentSpec[] {

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

function normalizeColorAttachment(
    pass: RenderPassSpec,
    attachment: RenderPassColorAttachmentSpec,
    index: number
): RenderPassColorAttachmentSpec {

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

function createColorAttachmentView(attachment: RenderPassColorAttachmentSpec): GPUTextureView {

    const target = attachment.target
    if (target instanceof TextureResource) {
        return target.createView(attachment.viewDescriptor)
    }

    return target.getCurrentTexture().createView(attachment.viewDescriptor)
}

function validateTextureColorAttachmentUsage(pass: RenderPassSpec, texture: TextureResource) {

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
