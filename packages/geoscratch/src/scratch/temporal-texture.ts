import { UUID } from '../core/utils/uuid.js'
import { throwScratchDiagnostic } from './diagnostics.js'
import { serializeNativeGpuError } from './gpu-operation.js'
import { createScratchNativeLabel } from './native-allocation.js'
import { assertScratchRuntimeActive } from './runtime-authority.js'
import {
    assertPreparedSurfaceFactsCurrent,
    isSurfaceReceiver,
    preparedSurfaceAttachmentSurfaceFacts,
    surfaceFactsFor,
} from './surface.js'
import { describeValue, getGlobalConstant, isRecord } from './type-utils.js'
import type { DiagnosticSubject } from './diagnostics.js'
import type { ScratchRuntime } from './runtime.js'
import type {
    PreparedSurfaceAttachment,
    Surface,
    SurfaceFacts,
} from './surface.js'
import type { TextureViewDescriptor } from './texture.js'

const externalTextureBindingToken = Symbol('ExternalTextureBinding')
const surfaceTextureLeaseToken = Symbol('SurfaceTextureLease')
const surfaceTextureViewToken = Symbol('SurfaceTextureView')
const externalTextureBindingStates = new WeakMap<ExternalTextureBinding, ExternalTextureBindingState>()
const surfaceTextureLeaseStates = new WeakMap<SurfaceTextureLease, SurfaceTextureLeaseInternalState>()
const surfaceTextureViewStates = new WeakMap<SurfaceTextureView, SurfaceTextureViewInternalState>()
const ownerSurfaceTextureLeases = new WeakMap<SurfaceTextureLeaseOwner, Set<SurfaceTextureLease>>()

const GPU_TEXTURE_USAGE_COPY_SRC = getGlobalConstant('GPUTextureUsage', 'COPY_SRC', 0x1)
const GPU_TEXTURE_USAGE_COPY_DST = getGlobalConstant('GPUTextureUsage', 'COPY_DST', 0x2)
const GPU_TEXTURE_USAGE_TEXTURE_BINDING = getGlobalConstant('GPUTextureUsage', 'TEXTURE_BINDING', 0x4)
const GPU_TEXTURE_USAGE_STORAGE_BINDING = getGlobalConstant('GPUTextureUsage', 'STORAGE_BINDING', 0x8)
const GPU_TEXTURE_USAGE_RENDER_ATTACHMENT = getGlobalConstant('GPUTextureUsage', 'RENDER_ATTACHMENT', 0x10)
const COLOR_SPACES = new Set<PredefinedColorSpace>([ 'srgb', 'display-p3' ])
const TEXTURE_VIEW_ASPECTS = new Set<GPUTextureAspect>([ 'all', 'depth-only', 'stencil-only' ])

export type ExternalTextureBindingDescriptor = {
    label?: string
    source: HTMLVideoElement | VideoFrame
    colorSpace?: PredefinedColorSpace
}

type ExternalTextureSourceKind = 'HTMLVideoElement' | 'VideoFrame'

type ExternalTextureBindingState = Readonly<{
    runtime: ScratchRuntime
    id: string
    label?: string
    source: HTMLVideoElement | VideoFrame
    sourceKind: ExternalTextureSourceKind
    colorSpace: PredefinedColorSpace
}>

export interface ExternalTextureBinding {
    readonly runtime: ScratchRuntime
    readonly id: string
    readonly label?: string
    readonly sourceKind: ExternalTextureSourceKind
    readonly colorSpace: PredefinedColorSpace
}

export class ExternalTextureBinding {

    private constructor(
        token: symbol,
        runtime: ScratchRuntime,
        descriptor: ExternalTextureBindingDescriptor
    ) {

        if (token !== externalTextureBindingToken || new.target !== ExternalTextureBinding) {
            throw new TypeError(
                'ExternalTextureBinding must be created by ScratchRuntime.createExternalTextureBinding().'
            )
        }
        assertScratchRuntimeActive(runtime)
        const normalized = normalizeExternalTextureBindingDescriptor(runtime, descriptor)
        const state = Object.freeze({
            runtime,
            id: `scratch-external-texture-binding-${UUID()}`,
            ...(normalized.label !== undefined ? { label: normalized.label } : {}),
            source: normalized.source,
            sourceKind: normalized.sourceKind,
            colorSpace: normalized.colorSpace,
        })
        externalTextureBindingStates.set(this, state)
        Object.defineProperties(this, {
            runtime: immutableObservation(state.runtime),
            id: immutableObservation(state.id),
            ...(state.label !== undefined ? { label: immutableObservation(state.label) } : {}),
            sourceKind: immutableObservation(state.sourceKind),
            colorSpace: immutableObservation(state.colorSpace),
        })
        Object.preventExtensions(this)
    }

    get subject(): DiagnosticSubject {

        const state = externalTextureBindingStateFor(this)
        return {
            kind: 'ExternalTextureBinding',
            id: state.id,
            ...(state.label !== undefined ? { label: state.label } : {}),
            sourceKind: state.sourceKind,
        }
    }

    assertRuntime(runtime: ScratchRuntime): void {

        const state = externalTextureBindingStateFor(this)
        assertScratchRuntimeActive(state.runtime)
        if (runtime === state.runtime) return
        throwScratchDiagnostic({
            code: 'SCRATCH_EXTERNAL_TEXTURE_WRONG_RUNTIME',
            severity: 'error',
            phase: 'binding',
            subject: this.subject,
            related: [ state.runtime.subject, runtime.subject ],
            message: 'ExternalTextureBinding belongs to a different ScratchRuntime.',
            expected: { runtimeId: state.runtime.id },
            actual: { runtimeId: runtime.id },
        })
    }
}

Object.freeze(ExternalTextureBinding.prototype)

export function createExternalTextureBinding(
    runtime: ScratchRuntime,
    descriptor: ExternalTextureBindingDescriptor
): ExternalTextureBinding {

    const Constructor = ExternalTextureBinding as unknown as new (
        token: symbol,
        runtime: ScratchRuntime,
        descriptor: ExternalTextureBindingDescriptor
    ) => ExternalTextureBinding
    return new Constructor(externalTextureBindingToken, runtime, descriptor)
}

export function isExternalTextureBinding(value: unknown): value is ExternalTextureBinding {

    return typeof value === 'object' && value !== null &&
        Object.getPrototypeOf(value) === ExternalTextureBinding.prototype &&
        externalTextureBindingStates.has(value as ExternalTextureBinding)
}

export function assertExternalTextureBindingUsable(
    binding: ExternalTextureBinding,
    runtime: ScratchRuntime
): void {

    binding.assertRuntime(runtime)
    assertExternalTextureSourceUsable(binding, externalTextureBindingStateFor(binding))
}

export type SurfaceTextureLeaseState = 'pending' | 'active' | 'expired'

export type SurfaceTextureLeaseOwner = {
    readonly runtime: ScratchRuntime
    readonly id: string
    readonly isSubmitted: boolean
}

type SurfaceTextureLeaseInternalState = {
    runtime: ScratchRuntime
    id: string
    owner: SurfaceTextureLeaseOwner
    surface: Surface
    surfaceFacts: SurfaceFacts
    configurationVersion: number
    state: SurfaceTextureLeaseState
}

export interface SurfaceTextureLease {
    readonly runtime: ScratchRuntime
    readonly id: string
    readonly surface: Surface
    readonly state: SurfaceTextureLeaseState
}

export class SurfaceTextureLease {

    private constructor(
        token: symbol,
        owner: SurfaceTextureLeaseOwner,
        surface: Surface
    ) {

        if (token !== surfaceTextureLeaseToken || new.target !== SurfaceTextureLease) {
            throw new TypeError(
                'SurfaceTextureLease must be created by SubmissionBuilder.surfaceTexture().'
            )
        }
        assertScratchRuntimeActive(owner.runtime)
        const facts = surfaceFactsFor(surface)
        if (facts.runtime !== owner.runtime) {
            throwScratchDiagnostic({
                code: 'SCRATCH_SURFACE_TEXTURE_WRONG_RUNTIME',
                severity: 'error',
                phase: 'submission',
                subject: facts.subject,
                related: [ owner.runtime.subject ],
                message: 'SurfaceTextureLease requires a Surface from its SubmissionBuilder Runtime.',
                expected: { runtimeId: owner.runtime.id },
                actual: { runtimeId: facts.runtime.id },
            })
        }
        if (owner.isSubmitted) {
            throwScratchDiagnostic({
                code: 'SCRATCH_SUBMISSION_WORK_ALREADY_SUBMITTED',
                severity: 'error',
                phase: 'submission',
                subject: { kind: 'SubmissionBuilder', id: owner.id },
                message: 'A submitted SubmissionBuilder cannot create a SurfaceTextureLease.',
            })
        }

        const state: SurfaceTextureLeaseInternalState = {
            runtime: owner.runtime,
            id: `scratch-surface-texture-lease-${UUID()}`,
            owner,
            surface,
            surfaceFacts: facts,
            configurationVersion: facts.configurationVersion,
            state: 'pending',
        }
        surfaceTextureLeaseStates.set(this, state)
        let leases = ownerSurfaceTextureLeases.get(owner)
        if (leases === undefined) {
            leases = new Set()
            ownerSurfaceTextureLeases.set(owner, leases)
        }
        leases.add(this)
        Object.defineProperties(this, {
            runtime: immutableObservation(state.runtime),
            id: immutableObservation(state.id),
            surface: immutableObservation(state.surface),
            state: {
                get: () => surfaceTextureLeaseStateFor(this).state,
                enumerable: true,
                configurable: false,
            },
        })
        Object.preventExtensions(this)
    }

    get subject(): DiagnosticSubject {

        const state = surfaceTextureLeaseStateFor(this)
        return {
            kind: 'SurfaceTextureLease',
            id: state.id,
            surfaceId: state.surfaceFacts.id,
            submissionBuilderId: state.owner.id,
        }
    }

    view(descriptor: TextureViewDescriptor = {}): SurfaceTextureView {

        const state = assertSurfaceTextureLeasePending(this)
        return constructSurfaceTextureView(this, normalizeSurfaceTextureViewDescriptor(state, descriptor))
    }
}

Object.freeze(SurfaceTextureLease.prototype)

export interface SurfaceTextureView {
    readonly lease: SurfaceTextureLease
    readonly descriptor: Readonly<TextureViewDescriptor>
}

type SurfaceTextureViewInternalState = Readonly<{
    lease: SurfaceTextureLease
    descriptor: Readonly<TextureViewDescriptor>
}>

export class SurfaceTextureView {

    private constructor(
        token: symbol,
        lease: SurfaceTextureLease,
        descriptor: Readonly<TextureViewDescriptor>
    ) {

        if (token !== surfaceTextureViewToken || new.target !== SurfaceTextureView) {
            throw new TypeError('SurfaceTextureView must be created by SurfaceTextureLease.view().')
        }
        surfaceTextureViewStates.set(this, Object.freeze({ lease, descriptor }))
        Object.defineProperties(this, {
            lease: immutableObservation(lease),
            descriptor: immutableObservation(descriptor),
        })
        Object.freeze(this)
    }

    get subject(): DiagnosticSubject {

        const state = surfaceTextureViewStateFor(this)
        return {
            kind: 'SurfaceTextureView',
            leaseId: state.lease.id,
            surfaceId: state.lease.surface.id,
            ...(state.descriptor.label !== undefined ? { label: state.descriptor.label } : {}),
        }
    }
}

Object.freeze(SurfaceTextureView.prototype)

export function createSurfaceTextureLease(
    owner: SurfaceTextureLeaseOwner,
    surface: Surface
): SurfaceTextureLease {

    if (!isSurfaceReceiver(surface)) {
        throwScratchDiagnostic({
            code: 'SCRATCH_SURFACE_TEXTURE_LEASE_INVALID',
            severity: 'error',
            phase: 'submission',
            subject: { kind: 'SurfaceTextureLease' },
            message: 'SubmissionBuilder.surfaceTexture() requires a genuine Surface.',
            expected: { surface: 'Surface' },
            actual: { surface: describeValue(surface) },
        })
    }
    const Constructor = SurfaceTextureLease as unknown as new (
        token: symbol,
        owner: SurfaceTextureLeaseOwner,
        surface: Surface
    ) => SurfaceTextureLease
    return new Constructor(surfaceTextureLeaseToken, owner, surface)
}

export function isSurfaceTextureLease(value: unknown): value is SurfaceTextureLease {

    return typeof value === 'object' && value !== null &&
        Object.getPrototypeOf(value) === SurfaceTextureLease.prototype &&
        surfaceTextureLeaseStates.has(value as SurfaceTextureLease)
}

export function isSurfaceTextureView(value: unknown): value is SurfaceTextureView {

    return typeof value === 'object' && value !== null &&
        Object.getPrototypeOf(value) === SurfaceTextureView.prototype &&
        surfaceTextureViewStates.has(value as SurfaceTextureView)
}

export function assertSurfaceTextureLeaseForSubmission(
    lease: SurfaceTextureLease,
    owner: SurfaceTextureLeaseOwner,
    requiredUsage?: GPUTextureUsageFlags,
    role?: string
): void {

    const state = surfaceTextureLeaseStateFor(lease)
    assertScratchRuntimeActive(state.runtime)
    if (state.owner !== owner) {
        throwScratchDiagnostic({
            code: 'SCRATCH_SURFACE_TEXTURE_LEASE_WRONG_SUBMISSION',
            severity: 'error',
            phase: 'submission',
            subject: lease.subject,
            related: [
                { kind: 'SubmissionBuilder', id: state.owner.id },
                { kind: 'SubmissionBuilder', id: owner.id },
            ],
            message: 'SurfaceTextureLease belongs to a different SubmissionBuilder.',
            expected: { submissionBuilderId: state.owner.id },
            actual: { submissionBuilderId: owner.id },
        })
    }
    if (state.state === 'expired') throwStaleSurfaceTextureLease(lease, state, 'expired')
    const facts = surfaceFactsForState(state)
    if (facts.configurationVersion !== state.configurationVersion) {
        throwStaleSurfaceTextureLease(lease, state, 'surface-reconfigured')
    }
    if (requiredUsage !== undefined && (facts.usage & requiredUsage) !== requiredUsage) {
        throwScratchDiagnostic({
            code: 'SCRATCH_SURFACE_TEXTURE_USAGE_MISSING',
            severity: 'error',
            phase: 'submission',
            subject: lease.subject,
            related: [ facts.subject ],
            message: 'Surface configuration does not permit the selected texture role.',
            expected: { requiredUsage, role },
            actual: { usage: facts.usage },
        })
    }
}

export function assertSurfaceTextureViewForSubmission(
    view: SurfaceTextureView,
    owner: SurfaceTextureLeaseOwner,
    requiredUsage = GPU_TEXTURE_USAGE_TEXTURE_BINDING,
    role = 'sampled-binding'
): void {

    const state = surfaceTextureViewStateFor(view)
    assertSurfaceTextureLeaseForSubmission(state.lease, owner, requiredUsage, role)
}

export function assertSurfaceTextureLeaseUsable(lease: SurfaceTextureLease): void {

    const state = surfaceTextureLeaseStateFor(lease)
    assertScratchRuntimeActive(state.runtime)
    if (state.state === 'expired') throwStaleSurfaceTextureLease(lease, state, 'expired')
    const facts = surfaceFactsForState(state)
    if (facts.configurationVersion !== state.configurationVersion) {
        throwStaleSurfaceTextureLease(lease, state, 'surface-reconfigured')
    }
}

export function expireSurfaceTextureLeasesForOwner(owner: SurfaceTextureLeaseOwner): void {

    for (const lease of ownerSurfaceTextureLeases.get(owner) ?? []) {
        surfaceTextureLeaseStateFor(lease).state = 'expired'
    }
    ownerSurfaceTextureLeases.delete(owner)
}

function activateSurfaceTextureLeaseForOwner(
    lease: SurfaceTextureLease,
    owner: SurfaceTextureLeaseOwner
): void {

    const state = surfaceTextureLeaseStateFor(lease)
    assertScratchRuntimeActive(state.runtime)
    if (state.owner !== owner) {
        throwScratchDiagnostic({
            code: 'SCRATCH_SURFACE_TEXTURE_LEASE_WRONG_SUBMISSION',
            severity: 'error',
            phase: 'submission',
            subject: lease.subject,
            related: [
                { kind: 'SubmissionBuilder', id: state.owner.id },
                { kind: 'SubmissionBuilder', id: owner.id },
            ],
            message: 'SurfaceTextureLease belongs to a different SubmissionBuilder.',
            expected: { submissionBuilderId: state.owner.id },
            actual: { submissionBuilderId: owner.id },
        })
    }
    if (state.state === 'expired') throwStaleSurfaceTextureLease(lease, state, 'expired')
    assertPreparedSurfaceFactsCurrent(state.surface, state.surfaceFacts)
    state.state = 'active'
}

function constructSurfaceTextureView(
    lease: SurfaceTextureLease,
    descriptor: Readonly<TextureViewDescriptor>
): SurfaceTextureView {

    const Constructor = SurfaceTextureView as unknown as new (
        token: symbol,
        lease: SurfaceTextureLease,
        descriptor: Readonly<TextureViewDescriptor>
    ) => SurfaceTextureView
    return new Constructor(surfaceTextureViewToken, lease, descriptor)
}

export type AttemptTextureBindingResource =
    | ExternalTextureBinding
    | SurfaceTextureLease
    | SurfaceTextureView

export class AttemptTextureAuthority {

    readonly #owner: SurfaceTextureLeaseOwner
    readonly #runtime: ScratchRuntime
    readonly #surfaceTextures = new Map<Surface, {
        texture: GPUTexture
        configurationVersion: number
    }>()
    readonly #externalTextures = new Map<ExternalTextureBinding, GPUExternalTexture>()
    readonly #surfaceViews = new Map<SurfaceTextureView, GPUTextureView>()
    #isClosed = false

    constructor(owner: SurfaceTextureLeaseOwner) {

        this.#owner = owner
        this.#runtime = owner.runtime
    }

    externalTexture(binding: ExternalTextureBinding): GPUExternalTexture {

        this.#assertOpen()
        binding.assertRuntime(this.#runtime)
        const existing = this.#externalTextures.get(binding)
        if (existing !== undefined) return existing
        const state = externalTextureBindingStateFor(binding)
        assertExternalTextureSourceUsable(binding, state)
        let externalTexture: GPUExternalTexture
        try {
            externalTexture = this.#runtime.device.importExternalTexture({
                label: createScratchNativeLabel(state.label, state.id),
                source: state.source,
                colorSpace: state.colorSpace,
            })
        } catch (cause) {
            throwScratchDiagnostic({
                code: 'SCRATCH_EXTERNAL_TEXTURE_IMPORT_FAILED',
                severity: 'error',
                phase: 'submission',
                subject: binding.subject,
                related: [ this.#runtime.subject ],
                message: 'External texture import failed synchronously.',
                actual: {
                    sourceKind: state.sourceKind,
                    colorSpace: state.colorSpace,
                    nativeError: serializeNativeGpuError(cause),
                },
            }, { cause })
        }
        this.#externalTextures.set(binding, externalTexture)
        return externalTexture
    }

    surfaceTexture(lease: SurfaceTextureLease): GPUTexture {

        this.#assertOpen()
        activateSurfaceTextureLeaseForOwner(lease, this.#owner)
        const state = surfaceTextureLeaseStateFor(lease)
        return this.#acquireSurface(state.surface, state.surfaceFacts)
    }

    directSurfaceTexture(prepared: PreparedSurfaceAttachment): GPUTexture {

        this.#assertOpen()
        return this.#acquireSurface(
            prepared.surface,
            preparedSurfaceAttachmentSurfaceFacts(prepared)
        )
    }

    surfaceView(view: SurfaceTextureView): GPUTextureView {

        this.#assertOpen()
        assertSurfaceTextureViewForSubmission(view, this.#owner)
        const existing = this.#surfaceViews.get(view)
        if (existing !== undefined) return existing
        const state = surfaceTextureViewStateFor(view)
        const texture = this.surfaceTexture(state.lease)
        const nativeView = createAttemptTextureView(
            texture,
            state.descriptor,
            view.subject,
            [ state.lease.subject ]
        )
        this.#surfaceViews.set(view, nativeView)
        return nativeView
    }

    surfaceLeaseView(
        lease: SurfaceTextureLease,
        descriptor?: GPUTextureViewDescriptor
    ): GPUTextureView {

        return createAttemptTextureView(
            this.surfaceTexture(lease),
            descriptor,
            lease.subject
        )
    }

    directSurfaceView(
        prepared: PreparedSurfaceAttachment,
        descriptor?: GPUTextureViewDescriptor
    ): GPUTextureView {

        return createAttemptTextureView(
            this.directSurfaceTexture(prepared),
            descriptor,
            prepared.surface.subject
        )
    }

    close(): void {

        if (this.#isClosed) return
        this.#isClosed = true
        this.#surfaceViews.clear()
        this.#externalTextures.clear()
        this.#surfaceTextures.clear()
    }

    #acquireSurface(surface: Surface, facts: SurfaceFacts): GPUTexture {

        if (facts.runtime !== this.#runtime) {
            throwScratchDiagnostic({
                code: 'SCRATCH_SURFACE_TEXTURE_WRONG_RUNTIME',
                severity: 'error',
                phase: 'submission',
                subject: facts.subject,
                related: [ this.#runtime.subject ],
                message: 'Attempt texture authority cannot acquire a Surface from another Runtime.',
                expected: { runtimeId: this.#runtime.id },
                actual: { runtimeId: facts.runtime.id },
            })
        }
        assertPreparedSurfaceFactsCurrent(surface, facts)
        const existing = this.#surfaceTextures.get(surface)
        if (existing !== undefined) {
            if (existing.configurationVersion !== facts.configurationVersion) {
                throwScratchDiagnostic({
                    code: 'SCRATCH_SURFACE_TEXTURE_LEASE_STALE',
                    severity: 'error',
                    phase: 'submission',
                    subject: facts.subject,
                    message: 'Attempt texture authority observed conflicting Surface configurations.',
                    expected: { configurationVersion: existing.configurationVersion },
                    actual: { configurationVersion: facts.configurationVersion },
                })
            }
            return existing.texture
        }
        let texture: GPUTexture
        try {
            texture = facts.context.getCurrentTexture()
        } catch (cause) {
            throwScratchDiagnostic({
                code: 'SCRATCH_SURFACE_TEXTURE_ACQUISITION_FAILED',
                severity: 'error',
                phase: 'submission',
                subject: facts.subject,
                related: [ this.#runtime.subject ],
                message: 'Surface current texture acquisition failed synchronously.',
                expected: { configurationVersion: facts.configurationVersion },
                actual: {
                    configurationVersion: facts.configurationVersion,
                    nativeError: serializeNativeGpuError(cause),
                },
            }, { cause })
        }
        this.#surfaceTextures.set(surface, {
            texture,
            configurationVersion: facts.configurationVersion,
        })
        return texture
    }

    #assertOpen(): void {

        if (!this.#isClosed) return
        throw new TypeError('AttemptTextureAuthority has expired.')
    }
}

function createAttemptTextureView(
    texture: GPUTexture,
    descriptor: GPUTextureViewDescriptor | undefined,
    subject: DiagnosticSubject,
    related: DiagnosticSubject[] = []
): GPUTextureView {

    try {
        return texture.createView(descriptor)
    } catch (cause) {
        throwScratchDiagnostic({
            code: 'SCRATCH_SURFACE_TEXTURE_VIEW_FAILED',
            severity: 'error',
            phase: 'submission',
            subject,
            related,
            message: 'Attempt-local texture view creation failed synchronously.',
            actual: { nativeError: serializeNativeGpuError(cause) },
        }, { cause })
    }
}

export function surfaceTextureLeaseFacts(
    lease: SurfaceTextureLease
): Readonly<{
    runtime: ScratchRuntime
    id: string
    owner: SurfaceTextureLeaseOwner
    surface: Surface
    configurationVersion: number
    state: SurfaceTextureLeaseState
    surfaceFacts: SurfaceFacts
}> {

    const state = surfaceTextureLeaseStateFor(lease)
    return Object.freeze({
        ...state,
        surfaceFacts: state.surfaceFacts,
    })
}

export function surfaceTextureViewFacts(
    view: SurfaceTextureView
): Readonly<{
    lease: SurfaceTextureLease
    descriptor: Readonly<TextureViewDescriptor>
}> {

    return surfaceTextureViewStateFor(view)
}

export function surfaceTextureUsageForRole(
    role:
        | 'copy-source'
        | 'copy-destination'
        | 'sampled-binding'
        | 'storage-binding'
        | 'render-attachment'
): GPUTextureUsageFlags {

    switch (role) {
        case 'copy-source':
            return GPU_TEXTURE_USAGE_COPY_SRC
        case 'copy-destination':
            return GPU_TEXTURE_USAGE_COPY_DST
        case 'sampled-binding':
            return GPU_TEXTURE_USAGE_TEXTURE_BINDING
        case 'storage-binding':
            return GPU_TEXTURE_USAGE_STORAGE_BINDING
        case 'render-attachment':
            return GPU_TEXTURE_USAGE_RENDER_ATTACHMENT
    }
}

function normalizeExternalTextureBindingDescriptor(
    runtime: ScratchRuntime,
    descriptor: ExternalTextureBindingDescriptor
): ExternalTextureBindingState {

    if (!isRecord(descriptor)) {
        return throwExternalTextureSourceInvalid(runtime, descriptor, 'descriptor')
    }
    const label = descriptor.label
    if (label !== undefined && typeof label !== 'string') {
        return throwExternalTextureSourceInvalid(runtime, descriptor.source, 'label')
    }
    const source = descriptor.source
    const sourceKind = externalTextureSourceKind(source)
    if (sourceKind === undefined) {
        return throwExternalTextureSourceInvalid(runtime, source, 'source')
    }
    const colorSpace = descriptor.colorSpace ?? 'srgb'
    if (!COLOR_SPACES.has(colorSpace)) {
        return throwExternalTextureSourceInvalid(runtime, source, 'colorSpace')
    }
    return {
        runtime,
        id: '',
        ...(label !== undefined ? { label } : {}),
        source,
        sourceKind,
        colorSpace,
    }
}

function externalTextureSourceKind(source: unknown): ExternalTextureSourceKind | undefined {

    for (const kind of [ 'HTMLVideoElement', 'VideoFrame' ] as const) {
        const Constructor = globalThis[kind]
        if (typeof Constructor === 'function' && source instanceof Constructor) return kind
    }
    return undefined
}

function assertExternalTextureSourceUsable(
    binding: ExternalTextureBinding,
    state: ExternalTextureBindingState
): void {

    if (state.sourceKind !== 'VideoFrame') return
    try {
        const source = state.source as VideoFrame
        if (source.format !== null) return
    } catch {
        return
    }
    throwScratchDiagnostic({
        code: 'SCRATCH_EXTERNAL_TEXTURE_SOURCE_EXPIRED',
        severity: 'error',
        phase: 'submission',
        subject: binding.subject,
        message: 'External texture VideoFrame has been closed.',
        expected: { sourceState: 'open VideoFrame' },
        actual: { sourceState: 'closed' },
    })
}

function throwExternalTextureSourceInvalid(
    runtime: ScratchRuntime,
    source: unknown,
    field: string
): never {

    throwScratchDiagnostic({
        code: 'SCRATCH_EXTERNAL_TEXTURE_SOURCE_INVALID',
        severity: 'error',
        phase: 'binding',
        subject: { kind: 'ExternalTextureBinding' },
        related: [ runtime.subject ],
        message: 'ExternalTextureBinding requires a native external-texture source descriptor.',
        expected: {
            source: 'HTMLVideoElement or VideoFrame',
            colorSpace: [ 'srgb', 'display-p3' ],
        },
        actual: {
            field,
            sourceKind: externalTextureSourceKind(source) ?? describeValue(source),
        },
    })
}

function normalizeSurfaceTextureViewDescriptor(
    state: SurfaceTextureLeaseInternalState,
    descriptor: TextureViewDescriptor
): Readonly<TextureViewDescriptor> {

    if (!isRecord(descriptor)) {
        return throwSurfaceTextureViewInvalid(state, descriptor, 'descriptor')
    }
    const input = descriptor as TextureViewDescriptor
    const facts = surfaceFactsForState(state)
    const format = input.format ?? facts.format
    const dimension = input.dimension ?? '2d'
    const aspect = input.aspect ?? 'all'
    const baseMipLevel = input.baseMipLevel ?? 0
    const mipLevelCount = input.mipLevelCount ?? 1
    const baseArrayLayer = input.baseArrayLayer ?? 0
    const arrayLayerCount = input.arrayLayerCount ?? 1
    const usage = input.usage ?? facts.usage
    if (
        (input.label !== undefined && typeof input.label !== 'string') ||
        (format !== facts.format && !facts.viewFormats.includes(format)) ||
        dimension !== '2d' ||
        !TEXTURE_VIEW_ASPECTS.has(aspect) ||
        baseMipLevel !== 0 ||
        mipLevelCount !== 1 ||
        baseArrayLayer !== 0 ||
        arrayLayerCount !== 1 ||
        !Number.isInteger(usage) ||
        usage < 0 ||
        (usage & facts.usage) !== usage
    ) {
        return throwSurfaceTextureViewInvalid(state, descriptor, 'fields')
    }
    return Object.freeze({
        ...(input.label !== undefined ? { label: input.label } : {}),
        format,
        dimension,
        usage,
        aspect,
        baseMipLevel,
        mipLevelCount,
        baseArrayLayer,
        arrayLayerCount,
        ...(input.swizzle !== undefined ? { swizzle: input.swizzle } : {}),
    })
}

function throwSurfaceTextureViewInvalid(
    state: SurfaceTextureLeaseInternalState,
    descriptor: unknown,
    reason: string
): never {

    const facts = surfaceFactsForState(state)
    throwScratchDiagnostic({
        code: 'SCRATCH_SURFACE_TEXTURE_VIEW_INVALID',
        severity: 'error',
        phase: 'binding',
        subject: { kind: 'SurfaceTextureLease', id: state.id },
        related: [ facts.subject ],
        message: 'SurfaceTextureView descriptor is incompatible with the configured Surface.',
        expected: {
            format: [ facts.format, ...facts.viewFormats ],
            dimension: '2d',
            mipLevels: 1,
            arrayLayers: 1,
            usage: `subset of ${facts.usage}`,
        },
        actual: { reason, descriptor },
    })
}

function assertSurfaceTextureLeasePending(
    lease: SurfaceTextureLease
): SurfaceTextureLeaseInternalState {

    const state = surfaceTextureLeaseStateFor(lease)
    assertScratchRuntimeActive(state.runtime)
    if (state.state !== 'pending') throwStaleSurfaceTextureLease(lease, state, state.state)
    const facts = surfaceFactsForState(state)
    if (facts.configurationVersion !== state.configurationVersion) {
        throwStaleSurfaceTextureLease(lease, state, 'surface-reconfigured')
    }
    return state
}

function throwStaleSurfaceTextureLease(
    lease: SurfaceTextureLease,
    state: SurfaceTextureLeaseInternalState,
    reason: string
): never {

    throwScratchDiagnostic({
        code: 'SCRATCH_SURFACE_TEXTURE_LEASE_STALE',
        severity: 'error',
        phase: 'submission',
        subject: {
            kind: 'SurfaceTextureLease',
            id: state.id,
            surfaceId: state.surface.id,
            submissionBuilderId: state.owner.id,
        },
        related: [ state.surface.subject, state.runtime.subject ],
        message: 'SurfaceTextureLease no longer names a valid submission-scoped borrow.',
        expected: {
            state: [ 'pending', 'active' ],
            configurationVersion: state.configurationVersion,
        },
        actual: { state: state.state, reason },
    })
}

function externalTextureBindingStateFor(
    binding: ExternalTextureBinding
): ExternalTextureBindingState {

    const state = externalTextureBindingStates.get(binding)
    if (
        state === undefined ||
        Object.getPrototypeOf(binding) !== ExternalTextureBinding.prototype
    ) {
        throw new TypeError('ExternalTextureBinding state is unavailable.')
    }
    return state
}

function surfaceTextureLeaseStateFor(
    lease: SurfaceTextureLease
): SurfaceTextureLeaseInternalState {

    const state = surfaceTextureLeaseStates.get(lease)
    if (
        state === undefined ||
        Object.getPrototypeOf(lease) !== SurfaceTextureLease.prototype
    ) {
        throw new TypeError('SurfaceTextureLease state is unavailable.')
    }
    return state
}

function surfaceTextureViewStateFor(view: SurfaceTextureView): SurfaceTextureViewInternalState {

    const state = surfaceTextureViewStates.get(view)
    if (
        state === undefined ||
        Object.getPrototypeOf(view) !== SurfaceTextureView.prototype
    ) {
        throw new TypeError('SurfaceTextureView state is unavailable.')
    }
    return state
}

function surfaceFactsForState(state: SurfaceTextureLeaseInternalState): SurfaceFacts {

    return surfaceFactsFor(state.surface)
}

function immutableObservation<Value>(value: Value): PropertyDescriptor {

    return {
        value,
        enumerable: true,
        configurable: false,
        writable: false,
    }
}
