import { UUID } from '../core/utils/uuid.js'
import { throwScratchDiagnostic } from './diagnostics.js'
import { advanceQuerySlotContentEpoch, QuerySetResource } from './query-set.js'
import { TextureResource, TextureViewSpec, isTextureViewSpec, prepareTextureViewSpecDescriptor } from './texture.js'
import { describeValue, diagnosticSubjectOf, getGlobalConstant, isDefined, isRecord } from './type-utils.js'
import type { DiagnosticSubject } from './diagnostics.js'
import type { ScratchRuntime } from './runtime.js'
import type { Surface } from './surface.js'

const TEXTURE_USAGE_RENDER_ATTACHMENT = getGlobalConstant('GPUTextureUsage', 'RENDER_ATTACHMENT', 0x10)
const TEXTURE_USAGE_TRANSIENT_ATTACHMENT = getGlobalConstant('GPUTextureUsage', 'TRANSIENT_ATTACHMENT', 0x20)
const LOAD_OPS = new Set<GPULoadOp>([ 'clear', 'load' ])
const STORE_OPS = new Set<GPUStoreOp>([ 'store', 'discard' ])
const DEPTH_FORMATS = new Set<GPUTextureFormat>([
    'depth16unorm',
    'depth24plus',
    'depth24plus-stencil8',
    'depth32float',
    'depth32float-stencil8',
])
const STENCIL_FORMATS = new Set<GPUTextureFormat>([
    'stencil8',
    'depth24plus-stencil8',
    'depth32float-stencil8',
])

export type TimestampWritesSpec = {
    querySet: QuerySetResource
    begin?: number
    end?: number
}

export type RenderPassColorAttachmentSpec = {
    target: Surface | TextureViewSpec
    format?: GPUTextureFormat
    load?: GPULoadOp
    store?: GPUStoreOp
    clear?: GPUColor
    depthSlice?: number
    viewDescriptor?: GPUTextureViewDescriptor
}

export type RenderPassDepthStencilAttachmentSpec = {
    target: TextureViewSpec
    depthLoad?: GPULoadOp
    depthStore?: GPUStoreOp
    depthClear?: number
    stencilLoad?: GPULoadOp
    stencilStore?: GPUStoreOp
    stencilClear?: number
}

export type RenderPassSpecDescriptor = {
    label?: string
    color: RenderPassColorAttachmentSpec[]
    depth?: RenderPassDepthStencilAttachmentSpec
    timestampWrites?: TimestampWritesSpec
    occlusionQuerySet?: QuerySetResource
}

export type ComputePassSpecDescriptor = {
    label?: string
    timestampWrites?: TimestampWritesSpec
}

export type RenderPassNativeAttachments = Readonly<{
    color: readonly (GPUTextureView | undefined)[]
    depth?: GPUTextureView
}>

type RenderAttachmentExtent = {
    subject: DiagnosticSubject
    width: number
    height: number
    sampleCount: number
}

export interface RenderPassSpec {
    runtime: ScratchRuntime
    id: string
    label?: string
    passKind: 'render'
    color: RenderPassColorAttachmentSpec[]
    depth?: RenderPassDepthStencilAttachmentSpec
    timestampWrites?: TimestampWritesSpec
    occlusionQuerySet?: QuerySetResource
    isDisposed: boolean
}

export class RenderPassSpec {

    constructor(runtime: ScratchRuntime, descriptor: RenderPassSpecDescriptor) {

        runtime.assertActive()

        this.runtime = runtime
        this.id = `scratch-pass-${UUID()}`
        if (descriptor.label !== undefined) this.label = descriptor.label
        this.passKind = 'render'
        this.color = normalizeColorAttachments(this, descriptor.color)
        const depth = normalizeDepthStencilAttachment(this, descriptor.depth)
        validateRenderPassHasAttachment(this, this.color, depth)
        const timestampWrites = normalizeTimestampWrites(this, descriptor.timestampWrites)
        const occlusionQuerySet = normalizeOcclusionQuerySet(this, descriptor.occlusionQuerySet)
        if (depth !== undefined) this.depth = depth
        if (timestampWrites !== undefined) this.timestampWrites = timestampWrites
        if (occlusionQuerySet !== undefined) this.occlusionQuerySet = occlusionQuerySet
        this.isDisposed = false
    }

    get subject(): DiagnosticSubject {

        const subject: DiagnosticSubject = {
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

    hasEncoderSideEffects(): boolean {

        return this.color.length > 0 || this.depth !== undefined || this.timestampWrites !== undefined
    }

    advanceTimestampWriteEpochs(): void {

        advanceTimestampWriteEpochs(this.timestampWrites)
    }

    dispose(): void {

        this.isDisposed = true
    }
}

export function createRenderPassDescriptor(
    pass: RenderPassSpec,
    nativeAttachments: RenderPassNativeAttachments
): GPURenderPassDescriptor {

    pass.assertUsable()
    pass.occlusionQuerySet?.assertUsable()
    if (nativeAttachments.color.length !== pass.color.length) {
        throw new TypeError('RenderPass native color attachment count does not match its PassSpec.')
    }

    const descriptor: GPURenderPassDescriptor = {
        colorAttachments: pass.color.map((attachment, index) => {
            const target = attachment.target
            target.assertUsable()

            const colorAttachment: GPURenderPassColorAttachment = {
                view: createColorAttachmentView(attachment, nativeAttachments.color[index]),
                loadOp: attachment.load ?? 'clear',
                storeOp: attachment.store ?? 'store',
            }
            if (attachment.clear !== undefined) colorAttachment.clearValue = attachment.clear
            if (attachment.depthSlice !== undefined) colorAttachment.depthSlice = attachment.depthSlice

            return colorAttachment
        }),
    }
    if (pass.label !== undefined) descriptor.label = pass.label
    if (pass.depth !== undefined) {
        descriptor.depthStencilAttachment = createDepthStencilAttachmentDescriptor(
            pass.depth,
            nativeAttachments.depth
        )
    }
    if (pass.timestampWrites !== undefined) descriptor.timestampWrites = createTimestampWritesDescriptor(pass.timestampWrites)
    if (pass.occlusionQuerySet !== undefined) descriptor.occlusionQuerySet = pass.occlusionQuerySet.gpuQuerySet

    return descriptor
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
        if (descriptor.label !== undefined) this.label = descriptor.label
        this.passKind = 'compute'
        const timestampWrites = normalizeTimestampWrites(this, descriptor.timestampWrites)
        if (timestampWrites !== undefined) this.timestampWrites = timestampWrites
        this.isDisposed = false
    }

    get subject(): DiagnosticSubject {

        const subject: DiagnosticSubject = {
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

        const descriptor: GPUComputePassDescriptor = {}
        if (this.label !== undefined) descriptor.label = this.label
        if (this.timestampWrites !== undefined) descriptor.timestampWrites = createTimestampWritesDescriptor(this.timestampWrites)

        return descriptor
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

    const normalized: TimestampWritesSpec = {
        querySet,
    }
    if (begin !== undefined) normalized.begin = begin
    if (end !== undefined) normalized.end = end

    return normalized
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
        advanceQuerySlotContentEpoch(timestampWrites.querySet, index)
    }
}

function throwTimestampWritesDiagnostic(pass: RenderPassSpec | ComputePassSpec, timestampWrites: unknown, reason: string): never {

    const querySet = isRecord(timestampWrites) ? timestampWrites.querySet : undefined

    throwScratchDiagnostic({
        code: 'SCRATCH_PASS_TIMESTAMP_WRITES_INVALID',
        severity: 'error',
        phase: 'submission',
        subject: pass.subject,
        related: [
            diagnosticSubjectOf(querySet),
        ].filter(isDefined),
        message: 'PassSpec timestampWrites requires a timestamp QuerySetResource and at least one valid query slot index.',
        expected: {
            querySet: 'timestamp QuerySetResource owned by this ScratchRuntime',
            begin: 'optional integer query index within querySet.count',
            end: 'optional integer query index within querySet.count',
        },
        actual: {
            reason,
            querySet: describeValue(querySet),
            begin: isRecord(timestampWrites) ? timestampWrites.begin : undefined,
            end: isRecord(timestampWrites) ? timestampWrites.end : undefined,
        },
    })
}

function throwOcclusionQuerySetDiagnostic(pass: RenderPassSpec, querySet: unknown, reason: string): never {

    throwScratchDiagnostic({
        code: 'SCRATCH_PASS_OCCLUSION_QUERY_SET_INVALID',
        severity: 'error',
        phase: 'submission',
        subject: pass.subject,
        related: [
            diagnosticSubjectOf(querySet),
        ].filter(isDefined),
        message: 'RenderPassSpec occlusionQuerySet requires an occlusion QuerySetResource owned by this ScratchRuntime.',
        expected: { occlusionQuerySet: 'occlusion QuerySetResource owned by this ScratchRuntime' },
        actual: {
            reason,
            occlusionQuerySet: describeValue(querySet),
            querySetType: querySet instanceof QuerySetResource ? querySet.type : undefined,
        },
    })
}

function normalizeColorAttachments(pass: RenderPassSpec, color: RenderPassColorAttachmentSpec[]): RenderPassColorAttachmentSpec[] {

    if (!Array.isArray(color)) {
        throwScratchDiagnostic({
            code: 'SCRATCH_SUBMISSION_PASS_COMMAND_INCOMPATIBLE',
            severity: 'error',
            phase: 'submission',
            subject: pass.subject,
            message: 'RenderPassSpec color attachments must be an array.',
            expected: { color: 'RenderPassColorAttachmentSpec[]' },
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
    if (isTextureViewSpec(target)) {
        target.texture.assertRuntime(pass.runtime)
        target.assertUsable()
        validateTextureColorAttachmentUsage(pass, target.texture)
        validateRenderAttachmentView(pass, target)
        if (attachment.viewDescriptor !== undefined) {
            throwScratchDiagnostic({
                code: 'SCRATCH_RESOURCE_DESCRIPTOR_INVALID',
                severity: 'error',
                phase: 'resource',
                subject: target.subject,
                related: [ pass.subject ],
                message: 'TextureViewSpec attachment descriptors are fixed by the view spec.',
                expected: { viewDescriptor: undefined },
                actual: { viewDescriptor: attachment.viewDescriptor },
            })
        }

        validateColorAttachmentFormat(pass, target.subject, attachment.format, target.descriptor.format)
        const transient = (target.descriptor.usage & TEXTURE_USAGE_TRANSIENT_ATTACHMENT) !== 0
        const operations = normalizeColorAttachmentOperations(pass, target.subject, attachment, transient)
        const normalized: RenderPassColorAttachmentSpec = {
            target,
            format: target.descriptor.format,
            load: operations.load,
            store: operations.store,
        }
        if (attachment.clear !== undefined) {
            normalized.clear = normalizeColorClearValue(pass, target.subject, attachment.clear)
        }
        const depthSlice = normalizeColorAttachmentDepthSlice(pass, target, attachment.depthSlice)
        if (depthSlice !== undefined) normalized.depthSlice = depthSlice
        return normalized
    }

    if (!target || typeof target.assertUsable !== 'function' || typeof target.getCurrentTexture !== 'function') {
        throwScratchDiagnostic({
            code: 'SCRATCH_SUBMISSION_SURFACE_VIEW_OUT_OF_SCOPE',
            severity: 'error',
            phase: 'submission',
            subject: pass.subject,
            message: 'RenderPassSpec color attachment target must be a Surface or TextureViewSpec.',
            expected: { target: 'Surface or TextureViewSpec' },
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

    const viewFormat = validateSurfaceAttachmentViewDescriptor(
        pass,
        target,
        attachment.viewDescriptor
    )
    validateColorAttachmentFormat(pass, target.subject, attachment.format, viewFormat)
    const operations = normalizeColorAttachmentOperations(pass, target.subject, attachment, false)
    const normalized: RenderPassColorAttachmentSpec = {
        target,
        format: viewFormat,
        load: operations.load,
        store: operations.store,
    }
    if (attachment.clear !== undefined) {
        normalized.clear = normalizeColorClearValue(pass, target.subject, attachment.clear)
    }
    if (attachment.depthSlice !== undefined) {
        throwScratchDiagnostic({
            code: 'SCRATCH_RESOURCE_DESCRIPTOR_INVALID',
            severity: 'error',
            phase: 'resource',
            subject: target.subject,
            related: [ pass.subject ],
            message: 'Surface color attachments cannot select a 3D depth slice.',
            expected: { depthSlice: undefined },
            actual: { depthSlice: attachment.depthSlice },
        })
    }
    if (attachment.viewDescriptor !== undefined) normalized.viewDescriptor = attachment.viewDescriptor

    return normalized
}

function validateRenderPassHasAttachment(
    pass: RenderPassSpec,
    color: readonly RenderPassColorAttachmentSpec[],
    depth: RenderPassDepthStencilAttachmentSpec | undefined
): void {

    if (color.length > 0 || depth !== undefined) return

    throwScratchDiagnostic({
        code: 'SCRATCH_SUBMISSION_PASS_COMMAND_INCOMPATIBLE',
        severity: 'error',
        phase: 'submission',
        subject: pass.subject,
        message: 'RenderPassSpec requires at least one color or depth/stencil attachment.',
        expected: {
            color: 'at least one color attachment when depth is absent',
            depth: 'depth/stencil attachment when color is empty',
        },
        actual: { colorAttachmentCount: color.length, depth: undefined },
    })
}

function normalizeColorClearValue(
    pass: RenderPassSpec,
    subject: DiagnosticSubject,
    value: unknown
): GPUColor {

    if (
        value !== null &&
        value !== undefined &&
        typeof value !== 'string' &&
        typeof (value as Iterable<unknown>)[Symbol.iterator] === 'function'
    ) {
        const components = [ ...(value as Iterable<unknown>) ]
        if (components.length === 4 && components.every(isFiniteNumber)) {
            return Object.freeze(components) as unknown as GPUColor
        }
    } else if (
        isRecord(value) &&
        [ value.r, value.g, value.b, value.a ].every(isFiniteNumber)
    ) {
        return Object.freeze({
            r: value.r as number,
            g: value.g as number,
            b: value.b as number,
            a: value.a as number,
        })
    }

    throwScratchDiagnostic({
        code: 'SCRATCH_RESOURCE_DESCRIPTOR_INVALID',
        severity: 'error',
        phase: 'resource',
        subject,
        related: [ pass.subject ],
        message: 'RenderPassSpec color clear value must be a complete finite GPUColor.',
        expected: {
            clear: 'exactly four finite components or { r, g, b, a } with finite components',
        },
        actual: { clear: value },
    })
}

function isFiniteNumber(value: unknown): value is number {

    return typeof value === 'number' && Number.isFinite(value)
}

function createColorAttachmentView(
    attachment: RenderPassColorAttachmentSpec,
    persistentView: GPUTextureView | undefined
): GPUTextureView {

    const target = attachment.target
    if (isTextureViewSpec(target)) {
        if (persistentView === undefined) {
            throw new TypeError('Persistent render color attachment has no submission-scoped native view.')
        }
        return persistentView
    }

    return target.getCurrentTexture().createView(attachment.viewDescriptor)
}

function normalizeColorAttachmentDepthSlice(
    pass: RenderPassSpec,
    view: TextureViewSpec,
    depthSlice: unknown
): number | undefined {

    if (view.descriptor.dimension !== '3d') {
        if (depthSlice === undefined) return undefined
        throwScratchDiagnostic({
            code: 'SCRATCH_RESOURCE_DESCRIPTOR_INVALID',
            severity: 'error',
            phase: 'resource',
            subject: view.subject,
            related: [ pass.subject ],
            message: 'Only 3D color attachment views accept depthSlice.',
            expected: { depthSlice: undefined },
            actual: { depthSlice },
        })
    }

    const mipDepth = Math.max(
        1,
        Math.floor(view.texture.depthOrArrayLayers / (2 ** view.descriptor.baseMipLevel))
    )
    if (
        typeof depthSlice !== 'number' ||
        !Number.isInteger(depthSlice) ||
        depthSlice < 0 ||
        depthSlice >= mipDepth
    ) {
        throwScratchDiagnostic({
            code: 'SCRATCH_RESOURCE_DESCRIPTOR_INVALID',
            severity: 'error',
            phase: 'resource',
            subject: view.subject,
            related: [ pass.subject ],
            message: '3D color attachment depthSlice must select the current mip extent.',
            expected: { depthSlice: `integer in [0, ${mipDepth})` },
            actual: { depthSlice, mipDepth },
        })
    }

    return depthSlice
}

function normalizeDepthStencilAttachment(
    pass: RenderPassSpec,
    attachment?: RenderPassDepthStencilAttachmentSpec
): RenderPassDepthStencilAttachmentSpec | undefined {

    if (attachment === undefined) return undefined

    const target = attachment?.target
    if (!isTextureViewSpec(target)) {
        throwDepthStencilAttachmentDiagnostic(pass, attachment, 'target')
    }

    target.texture.assertRuntime(pass.runtime)
    target.assertUsable()
    validateRenderAttachmentView(pass, target)
    validateTextureDepthStencilAttachmentUsage(pass, target.texture)

    const hasDepth = DEPTH_FORMATS.has(target.descriptor.format)
    const hasStencil = STENCIL_FORMATS.has(target.descriptor.format)
    if (!hasDepth && !hasStencil) {
        throwDepthStencilAttachmentDiagnostic(pass, attachment, 'format')
    }

    const hasDepthFields = (
        attachment.depthLoad !== undefined ||
        attachment.depthStore !== undefined ||
        attachment.depthClear !== undefined
    )
    const hasStencilFields = (
        attachment.stencilLoad !== undefined ||
        attachment.stencilStore !== undefined ||
        attachment.stencilClear !== undefined
    )

    if (hasDepthFields && !hasDepth) {
        throwDepthStencilAttachmentDiagnostic(pass, attachment, 'depthFieldsForStencilOnlyFormat')
    }
    if (hasStencilFields && !hasStencil) {
        throwDepthStencilAttachmentDiagnostic(pass, attachment, 'stencilFieldsForDepthOnlyFormat')
    }

    const usesDepth = hasDepth && (hasDepthFields || !hasStencilFields)
    const usesStencil = hasStencil && (hasStencilFields || !hasDepth)
    const normalized: RenderPassDepthStencilAttachmentSpec = { target }
    const transient = (target.descriptor.usage & TEXTURE_USAGE_TRANSIENT_ATTACHMENT) !== 0

    if (usesDepth) {
        normalized.depthLoad = normalizeDepthStencilLoadOp(pass, attachment.depthLoad ?? 'clear', attachment, 'depthLoad')
        normalized.depthStore = normalizeDepthStencilStoreOp(
            pass,
            attachment.depthStore ?? (transient ? 'discard' : 'store'),
            attachment,
            'depthStore'
        )
        const depthClear = attachment.depthClear ?? (normalized.depthLoad === 'clear' ? 1 : undefined)
        if (depthClear !== undefined) {
            normalized.depthClear = normalizeDepthClearValue(pass, depthClear, attachment)
        }
    }
    if (usesStencil) {
        normalized.stencilLoad = normalizeDepthStencilLoadOp(pass, attachment.stencilLoad ?? 'clear', attachment, 'stencilLoad')
        normalized.stencilStore = normalizeDepthStencilStoreOp(
            pass,
            attachment.stencilStore ?? (transient ? 'discard' : 'store'),
            attachment,
            'stencilStore'
        )
        if (attachment.stencilClear !== undefined) normalized.stencilClear = normalizeStencilClearValue(pass, attachment.stencilClear, attachment)
    }
    if (transient && (
        (usesDepth && (normalized.depthLoad !== 'clear' || normalized.depthStore !== 'discard')) ||
        (usesStencil && (normalized.stencilLoad !== 'clear' || normalized.stencilStore !== 'discard'))
    )) {
        throwDepthStencilAttachmentDiagnostic(pass, attachment, 'transientLoadStore')
    }

    return normalized
}

function normalizeDepthStencilLoadOp(
    pass: RenderPassSpec,
    value: unknown,
    attachment: RenderPassDepthStencilAttachmentSpec,
    key: 'depthLoad' | 'stencilLoad'
): GPULoadOp {

    if (LOAD_OPS.has(value as GPULoadOp)) return value as GPULoadOp

    throwDepthStencilAttachmentDiagnostic(pass, { ...attachment, [key]: value }, key)
}

function normalizeDepthStencilStoreOp(
    pass: RenderPassSpec,
    value: unknown,
    attachment: RenderPassDepthStencilAttachmentSpec,
    key: 'depthStore' | 'stencilStore'
): GPUStoreOp {

    if (STORE_OPS.has(value as GPUStoreOp)) return value as GPUStoreOp

    throwDepthStencilAttachmentDiagnostic(pass, { ...attachment, [key]: value }, key)
}

function normalizeDepthClearValue(
    pass: RenderPassSpec,
    value: unknown,
    attachment: RenderPassDepthStencilAttachmentSpec
): number {

    if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1) return value

    throwDepthStencilAttachmentDiagnostic(pass, { ...attachment, depthClear: value }, 'depthClear')
}

function normalizeStencilClearValue(
    pass: RenderPassSpec,
    value: unknown,
    attachment: RenderPassDepthStencilAttachmentSpec
): number {

    if (
        typeof value === 'number' &&
        Number.isInteger(value) &&
        value >= 0 &&
        value <= 0xffff_ffff
    ) return value

    throwDepthStencilAttachmentDiagnostic(pass, { ...attachment, stencilClear: value }, 'stencilClear')
}

function createDepthStencilAttachmentDescriptor(
    attachment: RenderPassDepthStencilAttachmentSpec,
    nativeView: GPUTextureView | undefined
): GPURenderPassDepthStencilAttachment {

    if (nativeView === undefined) {
        throw new TypeError('Persistent render depth attachment has no submission-scoped native view.')
    }
    const descriptor: GPURenderPassDepthStencilAttachment = {
        view: nativeView,
    }
    if (attachment.depthLoad !== undefined) descriptor.depthLoadOp = attachment.depthLoad
    if (attachment.depthStore !== undefined) descriptor.depthStoreOp = attachment.depthStore
    if (attachment.depthClear !== undefined) descriptor.depthClearValue = attachment.depthClear
    if (attachment.stencilLoad !== undefined) descriptor.stencilLoadOp = attachment.stencilLoad
    if (attachment.stencilStore !== undefined) descriptor.stencilStoreOp = attachment.stencilStore
    if (attachment.stencilClear !== undefined) descriptor.stencilClearValue = attachment.stencilClear

    return descriptor
}

export function validateRenderPassAttachments(pass: RenderPassSpec): void {

    pass.assertUsable()
    const extents: RenderAttachmentExtent[] = []
    for (const attachment of pass.color) {
        if (isTextureViewSpec(attachment.target)) {
            validateRenderAttachmentView(pass, attachment.target)
            normalizeColorAttachmentDepthSlice(pass, attachment.target, attachment.depthSlice)
            extents.push(textureRenderAttachmentExtent(attachment.target))
            continue
        }

        attachment.target.assertUsable()
        extents.push({
            subject: attachment.target.subject,
            width: attachment.target.size.width,
            height: attachment.target.size.height,
            sampleCount: 1,
        })
    }
    if (pass.depth !== undefined) {
        validateRenderAttachmentView(pass, pass.depth.target)
        extents.push(textureRenderAttachmentExtent(pass.depth.target))
    }

    validateMatchingRenderAttachmentExtents(pass, extents)
}

function validateRenderAttachmentView(
    pass: RenderPassSpec,
    view: TextureViewSpec
): void {

    view.texture.assertRuntime(pass.runtime)
    const prepared = prepareTextureViewSpecDescriptor(view)
    if ((prepared.usage & TEXTURE_USAGE_RENDER_ATTACHMENT) === 0) {
        throwScratchDiagnostic({
            code: 'SCRATCH_RESOURCE_USAGE_MISSING',
            severity: 'error',
            phase: 'resource',
            subject: view.subject,
            related: [ pass.subject, view.texture.subject ],
            message: 'Render attachment TextureViewSpec usage requires GPUTextureUsage.RENDER_ATTACHMENT.',
            expected: { usage: 'GPUTextureUsage.RENDER_ATTACHMENT' },
            actual: { usage: prepared.usage },
        })
    }
    if (
        !(
            prepared.dimension === '2d' ||
            prepared.dimension === '2d-array' ||
            prepared.dimension === '3d'
        ) ||
        prepared.mipLevelCount !== 1 ||
        prepared.arrayLayerCount !== 1 ||
        prepared.aspect !== 'all' ||
        prepared.swizzle !== 'rgba'
    ) {
        throwScratchDiagnostic({
            code: 'SCRATCH_RESOURCE_DESCRIPTOR_INVALID',
            severity: 'error',
            phase: 'resource',
            subject: view.subject,
            related: [ pass.subject ],
            message: 'Render attachment view does not satisfy the WebGPU renderable-view contract.',
            expected: {
                viewDescriptor: {
                    dimension: [ '2d', '2d-array', '3d' ],
                    mipLevelCount: 1,
                    arrayLayerCount: 1,
                    aspect: 'all',
                    swizzle: 'rgba',
                },
            },
            actual: { viewDescriptor: prepared },
        })
    }

}

function validateColorAttachmentFormat(
    pass: RenderPassSpec,
    subject: DiagnosticSubject,
    requested: GPUTextureFormat | undefined,
    actual: GPUTextureFormat
): void {

    if (requested === undefined || requested === actual) return
    throwScratchDiagnostic({
        code: 'SCRATCH_RESOURCE_DESCRIPTOR_INVALID',
        severity: 'error',
        phase: 'resource',
        subject,
        related: [ pass.subject ],
        message: 'RenderPassSpec color attachment format must equal its actual view format.',
        expected: { format: actual },
        actual: { format: requested },
    })
}

function validateSurfaceAttachmentViewDescriptor(
    pass: RenderPassSpec,
    surface: Surface,
    descriptor: GPUTextureViewDescriptor | undefined
): GPUTextureFormat {

    if (descriptor === undefined) return surface.format
    const valid = isRecord(descriptor) &&
        (descriptor.label === undefined || typeof descriptor.label === 'string') &&
        (descriptor.format === undefined || descriptor.format === surface.format) &&
        (descriptor.dimension === undefined || descriptor.dimension === '2d') &&
        (
            descriptor.usage === undefined ||
            descriptor.usage === 0 ||
            descriptor.usage === TEXTURE_USAGE_RENDER_ATTACHMENT
        ) &&
        (descriptor.aspect === undefined || descriptor.aspect === 'all') &&
        (descriptor.baseMipLevel === undefined || descriptor.baseMipLevel === 0) &&
        (descriptor.mipLevelCount === undefined || descriptor.mipLevelCount === 1) &&
        (descriptor.baseArrayLayer === undefined || descriptor.baseArrayLayer === 0) &&
        (descriptor.arrayLayerCount === undefined || descriptor.arrayLayerCount === 1) &&
        (descriptor.swizzle === undefined || descriptor.swizzle === 'rgba')
    if (valid) return surface.format

    throwScratchDiagnostic({
        code: 'SCRATCH_RESOURCE_DESCRIPTOR_INVALID',
        severity: 'error',
        phase: 'resource',
        subject: surface.subject,
        related: [ pass.subject ],
        message: 'Surface attachment view descriptor must describe its configured renderable canvas view.',
        expected: {
            format: surface.format,
            dimension: '2d',
            usage: '0 or GPUTextureUsage.RENDER_ATTACHMENT',
            aspect: 'all',
            baseMipLevel: 0,
            mipLevelCount: 1,
            baseArrayLayer: 0,
            arrayLayerCount: 1,
            swizzle: 'rgba',
        },
        actual: { viewDescriptor: describeValue(descriptor) },
    })
}

function normalizeColorAttachmentOperations(
    pass: RenderPassSpec,
    subject: DiagnosticSubject,
    attachment: RenderPassColorAttachmentSpec,
    transient: boolean
): Readonly<{ load: GPULoadOp, store: GPUStoreOp }> {

    const load = attachment.load ?? 'clear'
    const store = attachment.store ?? (transient ? 'discard' : 'store')
    if (
        !LOAD_OPS.has(load) ||
        !STORE_OPS.has(store) ||
        (transient && (load !== 'clear' || store !== 'discard'))
    ) {
        throwScratchDiagnostic({
            code: 'SCRATCH_RESOURCE_DESCRIPTOR_INVALID',
            severity: 'error',
            phase: 'resource',
            subject,
            related: [ pass.subject ],
            message: 'RenderPassSpec color attachment load/store operations are invalid.',
            expected: transient
                ? { load: 'clear', store: 'discard' }
                : { load: [ 'clear', 'load' ], store: [ 'store', 'discard' ] },
            actual: { load, store, transient },
        })
    }

    return Object.freeze({ load, store })
}

function textureRenderAttachmentExtent(
    view: TextureViewSpec
): RenderAttachmentExtent {

    const target = view.texture
    const baseMipLevel = view.descriptor.baseMipLevel
    const divisor = 2 ** baseMipLevel
    return {
        subject: view.subject,
        width: Math.max(1, Math.floor(target.width / divisor)),
        height: Math.max(1, Math.floor(target.height / divisor)),
        sampleCount: target.sampleCount,
    }
}

function validateMatchingRenderAttachmentExtents(
    pass: RenderPassSpec,
    extents: RenderAttachmentExtent[]
): void {

    const expected = extents[0]
    if (expected === undefined) return
    if (extents.every(extent => (
        extent.width === expected.width &&
        extent.height === expected.height &&
        extent.sampleCount === expected.sampleCount
    ))) return

    throwScratchDiagnostic({
        code: 'SCRATCH_RESOURCE_DESCRIPTOR_INVALID',
        severity: 'error',
        phase: 'resource',
        subject: pass.subject,
        related: extents.map(extent => extent.subject),
        message: 'Render pass attachments must have matching current render extents and sample counts.',
        expected: {
            renderExtent: {
                width: expected.width,
                height: expected.height,
                sampleCount: expected.sampleCount,
            },
        },
        actual: {
            renderExtents: extents.map(extent => ({
                subject: extent.subject,
                width: extent.width,
                height: extent.height,
                sampleCount: extent.sampleCount,
            })),
        },
    })
}

function validateTextureDepthStencilAttachmentUsage(pass: RenderPassSpec, texture: TextureResource) {

    if ((texture.usage & TEXTURE_USAGE_RENDER_ATTACHMENT) !== 0) return

    throwScratchDiagnostic({
        code: 'SCRATCH_RESOURCE_USAGE_MISSING',
        severity: 'error',
        phase: 'resource',
        subject: texture.subject,
        related: [ pass.subject ],
        message: 'TextureResource depth/stencil attachment requires GPUTextureUsage.RENDER_ATTACHMENT.',
        expected: { usage: 'GPUTextureUsage.RENDER_ATTACHMENT' },
        actual: { usage: texture.usage },
    })
}

function throwDepthStencilAttachmentDiagnostic(
    pass: RenderPassSpec,
    attachment: unknown,
    reason: string
): never {

    const target = isRecord(attachment) ? attachment.target : undefined

    throwScratchDiagnostic({
        code: 'SCRATCH_PASS_DEPTH_STENCIL_ATTACHMENT_INVALID',
        severity: 'error',
        phase: 'submission',
        subject: pass.subject,
        related: [
            diagnosticSubjectOf(target),
        ].filter(isDefined),
        message: 'RenderPassSpec depth attachment requires a depth/stencil TextureViewSpec owned by this ScratchRuntime.',
        expected: {
            target: 'TextureViewSpec with depth/stencil format and GPUTextureUsage.RENDER_ATTACHMENT',
            depthLoad: [ 'clear', 'load' ],
            depthStore: [ 'store', 'discard' ],
            stencilLoad: [ 'clear', 'load' ],
            stencilStore: [ 'store', 'discard' ],
        },
        actual: {
            reason,
            target: describeValue(target),
            format: isTextureViewSpec(target) ? target.descriptor.format : undefined,
            depthLoad: isRecord(attachment) ? attachment.depthLoad : undefined,
            depthStore: isRecord(attachment) ? attachment.depthStore : undefined,
            depthClear: isRecord(attachment) ? attachment.depthClear : undefined,
            stencilLoad: isRecord(attachment) ? attachment.stencilLoad : undefined,
            stencilStore: isRecord(attachment) ? attachment.stencilStore : undefined,
            stencilClear: isRecord(attachment) ? attachment.stencilClear : undefined,
        },
    })
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
