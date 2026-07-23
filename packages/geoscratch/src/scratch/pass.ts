import { UUID } from '../core/utils/uuid.js'
import { throwScratchDiagnostic } from './diagnostics.js'
import { advanceQuerySlotContentEpoch, isQuerySetResource, QuerySetResource } from './query-set.js'
import { assertScratchRuntimeActive } from './runtime-authority.js'
import { isSurfaceReceiver, surfaceFactsFor } from './surface.js'
import { TextureResource, TextureViewSpec, isTextureViewSpec, prepareTextureViewSpecDescriptor } from './texture.js'
import {
    textureFormatIsColorRenderable,
    textureFormatSupportsResolve,
} from './texture-format-capabilities.js'
import { describeValue, diagnosticSubjectOf, getGlobalConstant, isDefined, isRecord } from './type-utils.js'
import type { DiagnosticSubject } from './diagnostics.js'
import type { ScratchRuntime } from './runtime.js'
import type { Surface, SurfaceFacts } from './surface.js'

const TEXTURE_USAGE_RENDER_ATTACHMENT = getGlobalConstant('GPUTextureUsage', 'RENDER_ATTACHMENT', 0x10)
const TEXTURE_USAGE_TRANSIENT_ATTACHMENT = getGlobalConstant('GPUTextureUsage', 'TRANSIENT_ATTACHMENT', 0x20)
const GPU_FLAGS_MAX = 0xffff_ffff
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
const renderPassStates = new WeakMap<RenderPassSpec, { isDisposed: boolean }>()
const computePassStates = new WeakMap<ComputePassSpec, { isDisposed: boolean }>()

export type TimestampWritesSpec = Readonly<{
    querySet: QuerySetResource
    begin?: number
    end?: number
}>

export type RenderPassColorAttachmentSpec = Readonly<{
    target: Surface | TextureViewSpec
    resolveTarget?: Surface | TextureViewSpec
    format?: GPUTextureFormat
    load?: GPULoadOp
    store?: GPUStoreOp
    clear?: Readonly<GPUColor>
    depthSlice?: number
    viewDescriptor?: Readonly<GPUTextureViewDescriptor>
    resolveViewDescriptor?: Readonly<GPUTextureViewDescriptor>
}>

export type RenderPassDepthStencilAttachmentSpec = Readonly<{
    target: TextureViewSpec
    depthLoad?: GPULoadOp
    depthStore?: GPUStoreOp
    depthClear?: number
    stencilLoad?: GPULoadOp
    stencilStore?: GPUStoreOp
    stencilClear?: number
    depthReadOnly?: boolean
    stencilReadOnly?: boolean
}>

export type RenderPassSpecDescriptor = {
    label?: string
    color: readonly (RenderPassColorAttachmentSpec | null)[]
    depth?: RenderPassDepthStencilAttachmentSpec
    maxDrawCount?: number
    timestampWrites?: TimestampWritesSpec
    occlusionQuerySet?: QuerySetResource
}

export type ComputePassSpecDescriptor = {
    label?: string
    timestampWrites?: TimestampWritesSpec
}

type MutableTimestampWritesSpec = {
    -readonly [Key in keyof TimestampWritesSpec]: TimestampWritesSpec[Key]
}

type MutableRenderPassColorAttachmentSpec = {
    -readonly [Key in keyof RenderPassColorAttachmentSpec]: RenderPassColorAttachmentSpec[Key]
}

type MutableRenderPassDepthStencilAttachmentSpec = {
    -readonly [Key in keyof RenderPassDepthStencilAttachmentSpec]: RenderPassDepthStencilAttachmentSpec[Key]
}

export type RenderPassNativeAttachments = Readonly<{
    color: readonly (Readonly<{
        view: GPUTextureView
        resolveTarget?: GPUTextureView
    }> | null)[]
    depth?: GPUTextureView
}>

type RenderAttachmentExtent = {
    subject: DiagnosticSubject
    width: number
    height: number
    sampleCount: number
}

type ColorAttachmentFacts = {
    extent: RenderAttachmentExtent
    region: RenderAttachmentRegion
    format: GPUTextureFormat
    textureFormat: GPUTextureFormat
    effectiveUsage: GPUTextureUsageFlags
    transient: boolean
}

type RenderAttachmentRegion = {
    index: number
    role: 'color' | 'resolve'
    subject: DiagnosticSubject
    target: GPUCanvasContext | TextureResource
    dimension: 'surface' | GPUTextureViewDimension
    baseMipLevel?: number
    baseArrayLayer?: number
    depthSlice?: number
}

type SurfaceAttachmentViewFacts = Readonly<{
    format: GPUTextureFormat
    effectiveUsage: GPUTextureUsageFlags
}>

export interface RenderPassSpec {
    readonly runtime: ScratchRuntime
    readonly id: string
    readonly label?: string
    readonly passKind: 'render'
    readonly color: readonly (RenderPassColorAttachmentSpec | null)[]
    readonly depth?: RenderPassDepthStencilAttachmentSpec
    readonly maxDrawCount?: number
    readonly timestampWrites?: TimestampWritesSpec
    readonly occlusionQuerySet?: QuerySetResource
    readonly isDisposed: boolean
}

export class RenderPassSpec {

    constructor(runtime: ScratchRuntime, descriptor: RenderPassSpecDescriptor) {

        assertScratchRuntimeActive(runtime)

        const state = { isDisposed: false }
        renderPassStates.set(this, state)
        defineImmutablePassSpecProperties(this, {
            runtime,
            id: `scratch-pass-${UUID()}`,
            ...(descriptor.label !== undefined ? { label: descriptor.label } : {}),
            passKind: 'render',
        })
        installPassSpecLifecycleObservation(this, state)
        const color = normalizeColorAttachments(this, descriptor.color)
        const depth = normalizeDepthStencilAttachment(this, descriptor.depth)
        const maxDrawCount = normalizeMaxDrawCount(this, descriptor.maxDrawCount)
        validateRenderPassHasAttachment(this, color, depth)
        const timestampWrites = normalizeTimestampWrites(this, descriptor.timestampWrites)
        const occlusionQuerySet = normalizeOcclusionQuerySet(this, descriptor.occlusionQuerySet)
        lockRenderPassSpecContract(this, {
            color,
            ...(depth !== undefined ? { depth } : {}),
            ...(maxDrawCount !== undefined ? { maxDrawCount } : {}),
            ...(timestampWrites !== undefined ? { timestampWrites } : {}),
            ...(occlusionQuerySet !== undefined ? { occlusionQuerySet } : {}),
        })
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

        assertScratchRuntimeActive(this.runtime)
        this.timestampWrites?.querySet.assertUsable()
        this.occlusionQuerySet?.assertUsable()
    }

    hasEncoderSideEffects(): boolean {

        return this.color.some(attachment => attachment !== null) ||
            this.depth !== undefined ||
            this.timestampWrites !== undefined
    }

    advanceTimestampWriteEpochs(): void {

        advanceTimestampWriteEpochs(this.timestampWrites)
    }

    dispose(): void {

        renderPassStateFor(this).isDisposed = true
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
            if (attachment === null) return null
            const nativeAttachment = nativeAttachments.color[index]
            if (nativeAttachment === null) {
                throw new TypeError('Non-null RenderPass color attachment has no submission-scoped native view.')
            }
            const colorAttachment: GPURenderPassColorAttachment = {
                view: nativeAttachment.view,
                loadOp: attachment.load ?? 'clear',
                storeOp: attachment.store ?? 'store',
            }
            if (nativeAttachment.resolveTarget !== undefined) {
                colorAttachment.resolveTarget = nativeAttachment.resolveTarget
            }
            if (attachment.clear !== undefined) colorAttachment.clearValue = attachment.clear as GPUColor
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
    if (pass.maxDrawCount !== undefined) descriptor.maxDrawCount = pass.maxDrawCount

    return descriptor
}

export interface ComputePassSpec {
    readonly runtime: ScratchRuntime
    readonly id: string
    readonly label?: string
    readonly passKind: 'compute'
    readonly timestampWrites?: TimestampWritesSpec
    readonly isDisposed: boolean
}

export class ComputePassSpec {

    constructor(runtime: ScratchRuntime, descriptor: ComputePassSpecDescriptor = {}) {

        assertScratchRuntimeActive(runtime)

        const state = { isDisposed: false }
        computePassStates.set(this, state)
        defineImmutablePassSpecProperties(this, {
            runtime,
            id: `scratch-pass-${UUID()}`,
            ...(descriptor.label !== undefined ? { label: descriptor.label } : {}),
            passKind: 'compute',
        })
        installPassSpecLifecycleObservation(this, state)
        const timestampWrites = normalizeTimestampWrites(this, descriptor.timestampWrites)
        lockComputePassSpecContract(this, {
            ...(timestampWrites !== undefined ? { timestampWrites } : {}),
        })
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

        assertScratchRuntimeActive(this.runtime)
        this.timestampWrites?.querySet.assertUsable()
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

        computePassStateFor(this).isDisposed = true
    }
}

export function isRenderPassSpec(value: unknown): value is RenderPassSpec {

    return typeof value === 'object' && value !== null &&
        Object.getPrototypeOf(value) === RenderPassSpec.prototype &&
        renderPassStates.has(value as RenderPassSpec)
}

export function isComputePassSpec(value: unknown): value is ComputePassSpec {

    return typeof value === 'object' && value !== null &&
        Object.getPrototypeOf(value) === ComputePassSpec.prototype &&
        computePassStates.has(value as ComputePassSpec)
}

function normalizeTimestampWrites(
    pass: RenderPassSpec | ComputePassSpec,
    timestampWrites?: TimestampWritesSpec
): TimestampWritesSpec | undefined {

    if (timestampWrites === undefined) return undefined

    const querySet = timestampWrites?.querySet
    if (!isQuerySetResource(querySet)) {
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
    if (begin !== undefined && begin === end) {
        throwTimestampWritesDiagnostic(pass, timestampWrites, 'duplicate-indices')
    }

    const normalized: MutableTimestampWritesSpec = {
        querySet,
    }
    if (begin !== undefined) normalized.begin = begin
    if (end !== undefined) normalized.end = end

    return normalized
}

function normalizeOcclusionQuerySet(pass: RenderPassSpec, querySet?: QuerySetResource): QuerySetResource | undefined {

    if (querySet === undefined) return undefined

    if (!isQuerySetResource(querySet)) {
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
        message: 'PassSpec timestampWrites requires a timestamp QuerySetResource and distinct valid query slot indices.',
        expected: {
            querySet: 'timestamp QuerySetResource owned by this ScratchRuntime',
            begin: 'optional integer query index within querySet.count',
            end: 'optional integer query index within querySet.count',
            distinct: 'provided begin and end indices differ',
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
            querySetType: isQuerySetResource(querySet) ? querySet.type : undefined,
        },
    })
}

function normalizeColorAttachments(
    pass: RenderPassSpec,
    color: readonly (RenderPassColorAttachmentSpec | null)[]
): (RenderPassColorAttachmentSpec | null)[] {

    if (!Array.isArray(color)) {
        throwColorAttachmentDiagnostic(pass, color, undefined, 'array')
    }

    const normalized: (RenderPassColorAttachmentSpec | null)[] = []
    for (let index = 0; index < color.length; index++) {
        if (!(index in color)) {
            throwColorAttachmentDiagnostic(pass, undefined, index, 'hole')
        }
        const attachment = color[index]
        if (attachment === undefined) {
            throwColorAttachmentDiagnostic(pass, attachment, index, 'undefined')
        }
        normalized.push(attachment === null
            ? null
            : normalizeColorAttachment(pass, attachment, index))
    }

    return normalized
}

function normalizeColorAttachment(
    pass: RenderPassSpec,
    attachment: RenderPassColorAttachmentSpec,
    index: number
): RenderPassColorAttachmentSpec {

    if (!isRecord(attachment)) {
        throwColorAttachmentDiagnostic(pass, attachment, index, 'attachment')
    }

    const target = attachment?.target
    if (isTextureViewSpec(target)) {
        target.texture.assertRuntime(pass.runtime)
        target.assertUsable()
        validateTextureColorAttachmentUsage(pass, target.texture)
        validateRenderAttachmentView(pass, target)
        validateColorRenderableAttachmentFormat(
            pass,
            target.subject,
            target.descriptor.format,
            [ target.texture.subject ]
        )
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
        const normalized: MutableRenderPassColorAttachmentSpec = {
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
        normalizeResolveAttachment(pass, normalized, attachment, index)
        return normalized
    }

    if (!isSurfaceReceiver(target)) {
        throwColorAttachmentDiagnostic(pass, attachment, index, 'target')
    }

    const surface = surfaceFactsFor(target)

    if (surface.runtime !== pass.runtime) {
        throwScratchDiagnostic({
            code: 'SCRATCH_SUBMISSION_SURFACE_VIEW_OUT_OF_SCOPE',
            severity: 'error',
            phase: 'submission',
            subject: pass.subject,
            related: [
                surface.subject,
                pass.runtime.subject,
            ].filter(Boolean),
            message: 'Surface color attachment belongs to a different ScratchRuntime.',
            expected: { runtimeId: pass.runtime.id },
            actual: { runtimeId: surface.runtime.id },
        })
    }

    const viewDescriptor = snapshotSurfaceAttachmentViewDescriptor(attachment.viewDescriptor)
    const view = validateSurfaceAttachmentViewDescriptor(
        pass,
        surface,
        viewDescriptor
    )
    validateColorRenderableAttachmentFormat(pass, surface.subject, view.format)
    validateColorAttachmentFormat(pass, surface.subject, attachment.format, view.format)
    const operations = normalizeColorAttachmentOperations(pass, surface.subject, attachment, false)
    const normalized: MutableRenderPassColorAttachmentSpec = {
        target,
        format: view.format,
        load: operations.load,
        store: operations.store,
    }
    if (attachment.clear !== undefined) {
        normalized.clear = normalizeColorClearValue(pass, surface.subject, attachment.clear)
    }
    if (attachment.depthSlice !== undefined) {
        throwScratchDiagnostic({
            code: 'SCRATCH_RESOURCE_DESCRIPTOR_INVALID',
            severity: 'error',
            phase: 'resource',
            subject: surface.subject,
            related: [ pass.subject ],
            message: 'Surface color attachments cannot select a 3D depth slice.',
            expected: { depthSlice: undefined },
            actual: { depthSlice: attachment.depthSlice },
        })
    }
    if (viewDescriptor !== undefined) normalized.viewDescriptor = viewDescriptor
    normalizeResolveAttachment(pass, normalized, attachment, index)

    return normalized
}

function normalizeResolveAttachment(
    pass: RenderPassSpec,
    normalized: MutableRenderPassColorAttachmentSpec,
    attachment: RenderPassColorAttachmentSpec,
    index: number
): void {

    const resolveTarget = attachment.resolveTarget
    if (resolveTarget === undefined) {
        if (attachment.resolveViewDescriptor !== undefined) {
            throwResolveAttachmentDiagnostic(pass, attachment, index, 'descriptorWithoutTarget')
        }
        return
    }

    if (isTextureViewSpec(resolveTarget)) {
        resolveTarget.texture.assertRuntime(pass.runtime)
        resolveTarget.assertUsable()
        if (attachment.resolveViewDescriptor !== undefined) {
            throwResolveAttachmentDiagnostic(pass, attachment, index, 'textureViewDescriptor')
        }
        validateResolveTextureView(pass, resolveTarget, attachment, index)
        normalized.resolveTarget = resolveTarget
    } else {
        if (!isSurfaceReceiver(resolveTarget)) {
            throwResolveAttachmentDiagnostic(pass, attachment, index, 'target')
        }
        const surface = surfaceFactsFor(resolveTarget)
        if (surface.runtime !== pass.runtime) {
            throwResolveAttachmentDiagnostic(pass, attachment, index, 'runtime')
        }
        const resolveViewDescriptor = snapshotSurfaceAttachmentViewDescriptor(
            attachment.resolveViewDescriptor
        )
        validateSurfaceAttachmentViewDescriptor(pass, surface, resolveViewDescriptor)
        normalized.resolveTarget = resolveTarget
        if (resolveViewDescriptor !== undefined) {
            normalized.resolveViewDescriptor = resolveViewDescriptor
        }
    }

    validateResolveAttachment(pass, normalized, index)
}

function validateResolveTextureView(
    pass: RenderPassSpec,
    view: TextureViewSpec,
    attachment: RenderPassColorAttachmentSpec,
    index: number
): void {

    const prepared = prepareTextureViewSpecDescriptor(view)
    const valid = (prepared.usage & TEXTURE_USAGE_RENDER_ATTACHMENT) !== 0 &&
        (prepared.usage & TEXTURE_USAGE_TRANSIENT_ATTACHMENT) === 0 &&
        (prepared.dimension === '2d' || prepared.dimension === '2d-array') &&
        prepared.mipLevelCount === 1 &&
        prepared.arrayLayerCount === 1 &&
        prepared.aspect === 'all' &&
        prepared.swizzle === 'rgba' &&
        textureFormatIsColorRenderable(pass.runtime, prepared.format)
    if (valid) return

    throwResolveAttachmentDiagnostic(pass, attachment, index, 'targetView', {
        viewDescriptor: prepared,
    })
}

function validateRenderPassHasAttachment(
    pass: RenderPassSpec,
    color: readonly (RenderPassColorAttachmentSpec | null)[],
    depth: RenderPassDepthStencilAttachmentSpec | undefined
): void {

    if (color.some(attachment => attachment !== null) || depth !== undefined) return

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
        actual: {
            colorAttachmentCount: color.length,
            nonNullColorAttachmentCount: color.filter(attachment => attachment !== null).length,
            depth: undefined,
        },
    })
}

function normalizeMaxDrawCount(pass: RenderPassSpec, value: unknown): number | undefined {

    if (value === undefined) return undefined
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value

    throwScratchDiagnostic({
        code: 'SCRATCH_PASS_MAX_DRAW_COUNT_INVALID',
        severity: 'error',
        phase: 'submission',
        subject: pass.subject,
        message: 'RenderPassSpec maxDrawCount must be a non-negative JavaScript safe integer.',
        expected: { maxDrawCount: 'non-negative safe integer' },
        actual: { maxDrawCount: describeValue(value) },
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
        attachment.depthClear !== undefined ||
        attachment.depthReadOnly !== undefined
    )
    const hasStencilFields = (
        attachment.stencilLoad !== undefined ||
        attachment.stencilStore !== undefined ||
        attachment.stencilClear !== undefined ||
        attachment.stencilReadOnly !== undefined
    )

    if (hasDepthFields && !hasDepth) {
        throwDepthStencilAttachmentDiagnostic(pass, attachment, 'depthFieldsForStencilOnlyFormat')
    }
    if (hasStencilFields && !hasStencil) {
        throwDepthStencilAttachmentDiagnostic(pass, attachment, 'stencilFieldsForDepthOnlyFormat')
    }

    const normalized: MutableRenderPassDepthStencilAttachmentSpec = { target }
    const transient = (target.descriptor.usage & TEXTURE_USAGE_TRANSIENT_ATTACHMENT) !== 0
    const depthReadOnly = normalizeDepthStencilReadOnly(
        pass,
        attachment.depthReadOnly,
        attachment,
        'depthReadOnly'
    )
    const stencilReadOnly = normalizeDepthStencilReadOnly(
        pass,
        attachment.stencilReadOnly,
        attachment,
        'stencilReadOnly'
    )

    if (hasDepth) {
        if (depthReadOnly) {
            if (attachment.depthLoad !== undefined || attachment.depthStore !== undefined) {
                throwDepthStencilAttachmentDiagnostic(pass, attachment, 'depthReadOnlyOperations')
            }
            normalized.depthReadOnly = true
        } else {
            normalized.depthLoad = normalizeDepthStencilLoadOp(
                pass,
                attachment.depthLoad ?? 'clear',
                attachment,
                'depthLoad'
            )
            normalized.depthStore = normalizeDepthStencilStoreOp(
                pass,
                attachment.depthStore ?? (transient ? 'discard' : 'store'),
                attachment,
                'depthStore'
            )
        }
        const depthClear = attachment.depthClear ??
            (normalized.depthLoad === 'clear' ? 1 : undefined)
        if (depthClear !== undefined) {
            normalized.depthClear = normalizeDepthClearValue(pass, depthClear, attachment)
        }
    }
    if (hasStencil) {
        if (stencilReadOnly) {
            if (attachment.stencilLoad !== undefined || attachment.stencilStore !== undefined) {
                throwDepthStencilAttachmentDiagnostic(pass, attachment, 'stencilReadOnlyOperations')
            }
            normalized.stencilReadOnly = true
        } else {
            normalized.stencilLoad = normalizeDepthStencilLoadOp(
                pass,
                attachment.stencilLoad ?? 'clear',
                attachment,
                'stencilLoad'
            )
            normalized.stencilStore = normalizeDepthStencilStoreOp(
                pass,
                attachment.stencilStore ?? (transient ? 'discard' : 'store'),
                attachment,
                'stencilStore'
            )
        }
        if (attachment.stencilClear !== undefined) normalized.stencilClear = normalizeStencilClearValue(pass, attachment.stencilClear, attachment)
    }
    if (transient && (
        depthReadOnly ||
        stencilReadOnly ||
        (hasDepth && (normalized.depthLoad !== 'clear' || normalized.depthStore !== 'discard')) ||
        (hasStencil && (normalized.stencilLoad !== 'clear' || normalized.stencilStore !== 'discard'))
    )) {
        throwDepthStencilAttachmentDiagnostic(pass, attachment, 'transientLoadStore')
    }

    return normalized
}

function normalizeDepthStencilReadOnly(
    pass: RenderPassSpec,
    value: unknown,
    attachment: RenderPassDepthStencilAttachmentSpec,
    key: 'depthReadOnly' | 'stencilReadOnly'
): boolean {

    if (value === undefined) return false
    if (typeof value === 'boolean') return value
    throwDepthStencilAttachmentDiagnostic(pass, { ...attachment, [key]: value }, key)
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
    if (attachment.depthReadOnly !== undefined) descriptor.depthReadOnly = attachment.depthReadOnly
    if (attachment.stencilLoad !== undefined) descriptor.stencilLoadOp = attachment.stencilLoad
    if (attachment.stencilStore !== undefined) descriptor.stencilStoreOp = attachment.stencilStore
    if (attachment.stencilClear !== undefined) descriptor.stencilClearValue = attachment.stencilClear
    if (attachment.stencilReadOnly !== undefined) descriptor.stencilReadOnly = attachment.stencilReadOnly

    return descriptor
}

export function validateRenderPassAttachments(pass: RenderPassSpec): void {

    pass.assertUsable()
    const extents: RenderAttachmentExtent[] = []
    const regions: RenderAttachmentRegion[] = []
    for (const [ index, attachment ] of pass.color.entries()) {
        if (attachment === null) continue
        const sourceFacts = colorAttachmentFacts(
            pass,
            attachment.target,
            attachment.viewDescriptor,
            index,
            'color',
            attachment.depthSlice
        )
        validateColorAttachmentFormat(
            pass,
            sourceFacts.extent.subject,
            attachment.format,
            sourceFacts.format
        )
        normalizeColorAttachmentOperations(
            pass,
            sourceFacts.extent.subject,
            attachment,
            sourceFacts.transient
        )
        extents.push(sourceFacts.extent)
        regions.push(sourceFacts.region)
        if (attachment.resolveTarget !== undefined) {
            validateResolveAttachment(pass, attachment, index)
            const resolveFacts = colorAttachmentFacts(
                pass,
                attachment.resolveTarget,
                attachment.resolveViewDescriptor,
                index,
                'resolve'
            )
            regions.push(resolveFacts.region)
        }
    }
    if (pass.depth !== undefined) {
        validateRenderAttachmentView(pass, pass.depth.target)
        extents.push(textureRenderAttachmentExtent(pass.depth.target))
    }

    validateDisjointColorAttachmentRegions(pass, regions)
    validateMatchingRenderAttachmentExtents(pass, extents)
}

export function currentRenderPassAttachmentExtent(
    pass: RenderPassSpec,
    preparedSurfaceExtent?: (
        surface: Surface
    ) => Readonly<{ width: number, height: number }>
): Readonly<{ width: number, height: number }> {

    pass.assertUsable()
    for (const [ index, attachment ] of pass.color.entries()) {
        if (attachment === null) continue
        if (!isTextureViewSpec(attachment.target) && preparedSurfaceExtent !== undefined) {
            const extent = preparedSurfaceExtent(attachment.target)
            return Object.freeze({
                width: extent.width,
                height: extent.height,
            })
        }
        const extent = colorAttachmentFacts(
            pass,
            attachment.target,
            attachment.viewDescriptor,
            index,
            'color',
            attachment.depthSlice
        ).extent
        return Object.freeze({
            width: extent.width,
            height: extent.height,
        })
    }
    if (pass.depth !== undefined) {
        const extent = textureRenderAttachmentExtent(pass.depth.target)
        return Object.freeze({
            width: extent.width,
            height: extent.height,
        })
    }

    throw new TypeError('RenderPassSpec has no current attachment extent.')
}

function validateResolveAttachment(
    pass: RenderPassSpec,
    attachment: RenderPassColorAttachmentSpec,
    index: number
): void {

    if (attachment.resolveTarget === undefined) return
    const source = colorAttachmentFacts(
        pass,
        attachment.target,
        attachment.viewDescriptor,
        index,
        'color',
        attachment.depthSlice
    )
    const resolve = colorAttachmentFacts(
        pass,
        attachment.resolveTarget,
        attachment.resolveViewDescriptor,
        index,
        'resolve'
    )
    const valid = source.extent.sampleCount > 1 &&
        resolve.extent.sampleCount === 1 &&
        resolve.region.dimension !== '3d' &&
        source.extent.width === resolve.extent.width &&
        source.extent.height === resolve.extent.height &&
        source.format === resolve.format &&
        source.textureFormat === resolve.textureFormat &&
        textureFormatSupportsResolve(pass.runtime, resolve.format) &&
        !resolve.transient &&
        !renderAttachmentRegionsOverlap(source.region, resolve.region)
    if (valid) return

    throwResolveAttachmentDiagnostic(pass, attachment, index, 'incompatible', {
        source: describeColorAttachmentFacts(source),
        resolve: describeColorAttachmentFacts(resolve),
        overlap: renderAttachmentRegionsOverlap(source.region, resolve.region),
    })
}

function colorAttachmentFacts(
    pass: RenderPassSpec,
    target: Surface | TextureViewSpec,
    viewDescriptor: GPUTextureViewDescriptor | undefined,
    index: number,
    role: 'color' | 'resolve',
    depthSlice?: number
): ColorAttachmentFacts {

    if (isTextureViewSpec(target)) {
        target.texture.assertRuntime(pass.runtime)
        target.assertUsable()
        if (role === 'resolve') {
            validateResolveTextureView(pass, target, {
                target: target,
                resolveTarget: target,
            }, index)
        } else {
            validateRenderAttachmentView(pass, target)
            validateColorRenderableAttachmentFormat(
                pass,
                target.subject,
                target.descriptor.format,
                [ target.texture.subject ]
            )
        }
        const normalizedDepthSlice = role === 'color'
            ? normalizeColorAttachmentDepthSlice(pass, target, depthSlice)
            : undefined
        return {
            extent: textureRenderAttachmentExtent(target),
            region: textureRenderAttachmentRegion(
                index,
                role,
                target,
                normalizedDepthSlice
            ),
            format: target.descriptor.format,
            textureFormat: target.texture.format,
            effectiveUsage: target.descriptor.usage,
            transient: (target.descriptor.usage & TEXTURE_USAGE_TRANSIENT_ATTACHMENT) !== 0,
        }
    }

    const surface = surfaceFactsFor(target)
    if (surface.runtime !== pass.runtime) {
        if (role === 'resolve') {
            throwResolveAttachmentDiagnostic(pass, { target, resolveTarget: target }, index, 'runtime')
        }
        throwColorAttachmentDiagnostic(pass, { target }, index, 'runtime')
    }
    const view = validateSurfaceAttachmentViewDescriptor(pass, surface, viewDescriptor)
    validateColorRenderableAttachmentFormat(pass, surface.subject, view.format)
    return {
        extent: {
            subject: surface.subject,
            width: surface.size.width,
            height: surface.size.height,
            sampleCount: 1,
        },
        region: {
            index,
            role,
            subject: surface.subject,
            target: surface.context,
            dimension: 'surface',
        },
        format: view.format,
        textureFormat: surface.format,
        effectiveUsage: view.effectiveUsage,
        transient: (view.effectiveUsage & TEXTURE_USAGE_TRANSIENT_ATTACHMENT) !== 0,
    }
}

function describeColorAttachmentFacts(facts: ColorAttachmentFacts): Record<string, unknown> {

    return {
        format: facts.format,
        textureFormat: facts.textureFormat,
        width: facts.extent.width,
        height: facts.extent.height,
        sampleCount: facts.extent.sampleCount,
        usage: facts.effectiveUsage,
        transient: facts.transient,
        region: describeRenderAttachmentRegion(facts.region),
    }
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

function validateColorRenderableAttachmentFormat(
    pass: RenderPassSpec,
    subject: DiagnosticSubject,
    format: GPUTextureFormat,
    related: DiagnosticSubject[] = []
): void {

    if (textureFormatIsColorRenderable(pass.runtime, format)) return

    throwScratchDiagnostic({
        code: 'SCRATCH_RESOURCE_DESCRIPTOR_INVALID',
        severity: 'error',
        phase: 'resource',
        subject,
        related: [ pass.subject, ...related ],
        message: 'RenderPassSpec color attachment requires a color-renderable texture format.',
        expected: { format: 'color-renderable GPUTextureFormat' },
        actual: { format },
    })
}

function validateSurfaceAttachmentViewDescriptor(
    pass: RenderPassSpec,
    surface: SurfaceFacts,
    descriptor: GPUTextureViewDescriptor | undefined
): SurfaceAttachmentViewFacts {

    const record = isRecord(descriptor) ? descriptor : {}
    const format = record.format ?? surface.format
    const requestedUsage = typeof record.usage === 'number'
        ? record.usage
        : record.usage === undefined ? 0 : Number.NaN
    const effectiveUsage = requestedUsage === 0 ? surface.usage : requestedUsage
    const valid = (descriptor === undefined || isRecord(descriptor)) &&
        (record.label === undefined || typeof record.label === 'string') &&
        (format === surface.format || surface.viewFormats.includes(format as GPUTextureFormat)) &&
        (record.dimension === undefined || record.dimension === '2d') &&
        Number.isInteger(requestedUsage) &&
        requestedUsage >= 0 &&
        requestedUsage <= GPU_FLAGS_MAX &&
        (requestedUsage === 0 || (requestedUsage & ~surface.usage) === 0) &&
        (effectiveUsage & TEXTURE_USAGE_RENDER_ATTACHMENT) !== 0 &&
        (record.aspect === undefined || record.aspect === 'all') &&
        (record.baseMipLevel === undefined || record.baseMipLevel === 0) &&
        (record.mipLevelCount === undefined || record.mipLevelCount === 1) &&
        (record.baseArrayLayer === undefined || record.baseArrayLayer === 0) &&
        (record.arrayLayerCount === undefined || record.arrayLayerCount === 1) &&
        (record.swizzle === undefined || record.swizzle === 'rgba')
    if (valid) return Object.freeze({
        format: format as GPUTextureFormat,
        effectiveUsage,
    })

    throwScratchDiagnostic({
        code: 'SCRATCH_RESOURCE_DESCRIPTOR_INVALID',
        severity: 'error',
        phase: 'resource',
        subject: surface.subject,
        related: [ pass.subject ],
        message: 'Surface attachment view descriptor must describe its configured renderable canvas view.',
        expected: {
            format: [ surface.format, ...surface.viewFormats ],
            dimension: '2d',
            usage: '0 or a Surface usage subset containing GPUTextureUsage.RENDER_ATTACHMENT',
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

function snapshotSurfaceAttachmentViewDescriptor(
    descriptor: GPUTextureViewDescriptor | undefined
): GPUTextureViewDescriptor | undefined {

    if (descriptor === undefined || !isRecord(descriptor)) return descriptor
    const snapshot: Record<string, unknown> = {}
    for (const key of [
        'label',
        'format',
        'dimension',
        'usage',
        'aspect',
        'baseMipLevel',
        'mipLevelCount',
        'baseArrayLayer',
        'arrayLayerCount',
        'swizzle',
    ]) {
        const value = descriptor[key]
        if (value !== undefined) snapshot[key] = value
    }
    return Object.freeze(snapshot) as GPUTextureViewDescriptor
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

function lockRenderPassSpecContract(
    pass: RenderPassSpec,
    normalized: Readonly<{
        color: (RenderPassColorAttachmentSpec | null)[]
        depth?: RenderPassDepthStencilAttachmentSpec
        maxDrawCount?: number
        timestampWrites?: TimestampWritesSpec
        occlusionQuerySet?: QuerySetResource
    }>
): void {

    for (const attachment of normalized.color) {
        if (attachment !== null) Object.freeze(attachment)
    }
    Object.freeze(normalized.color)
    if (normalized.depth !== undefined) Object.freeze(normalized.depth)
    if (normalized.timestampWrites !== undefined) Object.freeze(normalized.timestampWrites)
    defineImmutablePassSpecProperties(pass, normalized)
    Object.preventExtensions(pass)
}

function lockComputePassSpecContract(
    pass: ComputePassSpec,
    normalized: Readonly<{ timestampWrites?: TimestampWritesSpec }>
): void {

    if (normalized.timestampWrites !== undefined) Object.freeze(normalized.timestampWrites)
    defineImmutablePassSpecProperties(pass, normalized)
    Object.preventExtensions(pass)
}

function defineImmutablePassSpecProperties(
    pass: object,
    values: Readonly<Record<string, unknown>>
): void {

    Object.defineProperties(pass, Object.fromEntries(
        Object.entries(values).map(([ property, value ]) => [ property, {
            value,
            enumerable: true,
            configurable: false,
            writable: false,
        } ])
    ))
}

function installPassSpecLifecycleObservation(
    pass: object,
    state: { isDisposed: boolean }
): void {

    Object.defineProperty(pass, 'isDisposed', {
        get: () => state.isDisposed,
        enumerable: true,
        configurable: false,
    })
}

function renderPassStateFor(pass: RenderPassSpec): { isDisposed: boolean } {

    const state = renderPassStates.get(pass)
    if (state === undefined) throw new TypeError('RenderPassSpec state is unavailable.')
    return state
}

function computePassStateFor(pass: ComputePassSpec): { isDisposed: boolean } {

    const state = computePassStates.get(pass)
    if (state === undefined) throw new TypeError('ComputePassSpec state is unavailable.')
    return state
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

function textureRenderAttachmentRegion(
    index: number,
    role: 'color' | 'resolve',
    view: TextureViewSpec,
    depthSlice: number | undefined
): RenderAttachmentRegion {

    const descriptor = view.descriptor
    const region = {
        index,
        role,
        subject: view.subject,
        target: view.texture,
        dimension: descriptor.dimension,
        baseMipLevel: descriptor.baseMipLevel,
    }
    if (descriptor.dimension === '3d') {
        if (depthSlice === undefined) {
            throw new TypeError('Validated 3D render attachment region requires a depthSlice.')
        }
        return { ...region, depthSlice }
    }
    return { ...region, baseArrayLayer: descriptor.baseArrayLayer }
}

function validateDisjointColorAttachmentRegions(
    pass: RenderPassSpec,
    regions: RenderAttachmentRegion[]
): void {

    for (let leftIndex = 0; leftIndex < regions.length; leftIndex++) {
        for (let rightIndex = leftIndex + 1; rightIndex < regions.length; rightIndex++) {
            const left = regions[leftIndex]
            const right = regions[rightIndex]
            if (!renderAttachmentRegionsOverlap(left, right)) continue

            throwScratchDiagnostic({
                code: 'SCRATCH_RESOURCE_DESCRIPTOR_INVALID',
                severity: 'error',
                phase: 'resource',
                subject: pass.subject,
                related: [ left.subject, right.subject ],
                message: 'RenderPassSpec color attachment regions must be pairwise disjoint.',
                expected: { colorAttachmentRegions: 'pairwise disjoint texture regions' },
                actual: {
                    reason: 'overlap',
                    colorAttachmentRegions: [
                        describeRenderAttachmentRegion(left),
                        describeRenderAttachmentRegion(right),
                    ],
                },
            })
        }
    }
}

function renderAttachmentRegionsOverlap(
    left: RenderAttachmentRegion,
    right: RenderAttachmentRegion
): boolean {

    if (left.dimension === 'surface' || right.dimension === 'surface') {
        return left.dimension === 'surface' &&
            right.dimension === 'surface' &&
            left.target === right.target
    }
    if (left.target !== right.target) return false
    if (left.baseMipLevel !== right.baseMipLevel) return false
    if (left.dimension === '3d' || right.dimension === '3d') {
        return left.dimension === '3d' &&
            right.dimension === '3d' &&
            left.depthSlice === right.depthSlice
    }
    return left.baseArrayLayer === right.baseArrayLayer
}

function describeRenderAttachmentRegion(region: RenderAttachmentRegion): Readonly<Record<string, unknown>> {

    return Object.freeze({
        index: region.index,
        role: region.role,
        dimension: region.dimension,
        ...(region.baseMipLevel !== undefined ? { baseMipLevel: region.baseMipLevel } : {}),
        ...(region.baseArrayLayer !== undefined ? { baseArrayLayer: region.baseArrayLayer } : {}),
        ...(region.depthSlice !== undefined ? { depthSlice: region.depthSlice } : {}),
    })
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
            depthReadOnly: 'boolean',
            stencilReadOnly: 'boolean',
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
            depthReadOnly: isRecord(attachment) ? attachment.depthReadOnly : undefined,
            stencilReadOnly: isRecord(attachment) ? attachment.stencilReadOnly : undefined,
        },
    })
}

function throwColorAttachmentDiagnostic(
    pass: RenderPassSpec,
    attachment: unknown,
    index: number | undefined,
    reason: string
): never {

    const target = isRecord(attachment) ? attachment.target : undefined
    throwScratchDiagnostic({
        code: 'SCRATCH_PASS_COLOR_ATTACHMENT_INVALID',
        severity: 'error',
        phase: 'submission',
        subject: pass.subject,
        related: [ diagnosticSubjectOf(target) ].filter(isDefined),
        message: 'RenderPassSpec color requires dense explicit null or valid color attachment slots.',
        expected: {
            color: 'dense array of RenderPassColorAttachmentSpec | null',
            target: 'Surface or TextureViewSpec for each non-null slot',
        },
        actual: {
            reason,
            index,
            attachment: describeValue(attachment),
            target: describeValue(target),
        },
    })
}

function throwResolveAttachmentDiagnostic(
    pass: RenderPassSpec,
    attachment: unknown,
    index: number,
    reason: string,
    details: Record<string, unknown> = {}
): never {

    const record = isRecord(attachment) ? attachment : {}
    throwScratchDiagnostic({
        code: 'SCRATCH_PASS_RESOLVE_ATTACHMENT_INVALID',
        severity: 'error',
        phase: 'submission',
        subject: pass.subject,
        related: [
            diagnosticSubjectOf(record.target),
            diagnosticSubjectOf(record.resolveTarget),
        ].filter(isDefined),
        message: 'RenderPassSpec resolve source and target must satisfy the current WebGPU resolve contract.',
        expected: {
            sourceSampleCount: '> 1',
            resolveSampleCount: 1,
            extent: 'matching current render extents',
            format: 'matching view and texture formats with resolve support',
            resolveTarget: 'non-3d, renderable, non-transient, disjoint view',
        },
        actual: {
            reason,
            index,
            target: describeValue(record.target),
            resolveTarget: describeValue(record.resolveTarget),
            ...details,
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

Object.freeze(RenderPassSpec.prototype)
Object.freeze(ComputePassSpec.prototype)
