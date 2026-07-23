import { UUID } from '../core/utils/uuid.js'
import {
    registerBindLayoutOwnership,
    registerBindSetOwnership,
    unregisterBindLayoutOwnership,
    unregisterBindSetOwnership,
} from './binding-ownership.js'
import { BufferRegion, isBufferRegion } from './buffer.js'
import { ScratchDiagnosticError, isScratchDiagnosticError, throwScratchDiagnostic } from './diagnostics.js'
import { serializeNativeGpuError } from './gpu-operation.js'
import { createScratchNativeLabel } from './native-allocation.js'
import { assertScratchRuntimeActive } from './runtime-authority.js'
import { diagnosticsControllerFor } from './runtime-diagnostics.js'
import { SamplerResource, isSamplerResource } from './sampler.js'
import { throwSupportingObjectCreationFailure } from './supporting-object-failure.js'
import {
    beginSupportingObjectCreation,
    issueSupportingObjectCreation,
    recheckSupportingObjectLifecycle,
} from './supporting-object-creation.js'
import {
    TextureResource,
    TextureViewSpec,
    isTextureResource,
    isTextureViewSpec,
    prepareTextureViewSpecDescriptor,
} from './texture.js'
import {
    assertExternalTextureBindingUsable,
    assertSurfaceTextureLeaseForSubmission,
    assertSurfaceTextureViewForSubmission,
    AttemptTextureAuthority,
    ExternalTextureBinding,
    SurfaceTextureLease,
    SurfaceTextureView,
    isExternalTextureBinding,
    isSurfaceTextureLease,
    isSurfaceTextureView,
    surfaceTextureLeaseFacts,
    surfaceTextureViewFacts,
    surfaceTextureUsageForRole,
} from './temporal-texture.js'
import {
    runtimeSupportsTextureFormatRequirement,
    storageTextureFormatCapabilities,
} from './texture-format-capabilities.js'
import { describeValue, getGlobalConstant, isRecord } from './type-utils.js'
import { readonlyMapSnapshot } from './readonly-map.js'
import type { DiagnosticSubject } from './diagnostics.js'
import type {
    GpuNativeErrorCategory,
    ScratchGpuBindSetPreparationStage,
    ScratchGpuIncidentOutcome,
} from './gpu-operation.js'
import type {
    ScratchPendingGpuOperation,
} from './runtime-diagnostics.js'
import type { ScratchRuntime } from './runtime.js'
import type {
    SupportingObjectCreationAttempt,
    SupportingObjectCreationOutcome,
    SupportingObjectFailureKind,
    SupportingObjectObservedFailure,
} from './supporting-object-creation.js'
import type { SurfaceTextureLeaseOwner } from './temporal-texture.js'

const SHADER_STAGE_FLAGS = {
    vertex: 0x1,
    fragment: 0x2,
    compute: 0x4,
}

const BUFFER_USAGE_UNIFORM = 0x40
const BUFFER_USAGE_STORAGE = 0x80
const TEXTURE_USAGE_TEXTURE_BINDING = getGlobalConstant('GPUTextureUsage', 'TEXTURE_BINDING', 0x4)
const TEXTURE_USAGE_STORAGE_BINDING = getGlobalConstant('GPUTextureUsage', 'STORAGE_BINDING', 0x8)

const BUFFER_BINDING_TYPES = new Set<BufferBindingType>([ 'uniform', 'read-storage', 'storage' ])
const TEXTURE_SAMPLE_TYPES = new Set<GPUTextureSampleType>([ 'float', 'unfilterable-float', 'depth', 'sint', 'uint' ])
const TEXTURE_VIEW_DIMENSIONS = new Set<GPUTextureViewDimension>([ '1d', '2d', '2d-array', 'cube', 'cube-array', '3d' ])
const SAMPLER_BINDING_TYPES = new Set<GPUSamplerBindingType>([ 'filtering', 'non-filtering', 'comparison' ])
const STORAGE_TEXTURE_ACCESS = new Set<GPUStorageTextureAccess>([ 'write-only', 'read-only', 'read-write' ])
const STORAGE_TEXTURE_VIEW_DIMENSIONS = new Set<GPUTextureViewDimension>([ '1d', '2d', '2d-array', '3d' ])
const EXTERNAL_TEXTURE_FORMATS = new Set<GPUTextureFormat>([
    'rgba8unorm',
    'bgra8unorm',
    'rgba16float',
])
const FILTERABLE_FLOAT_TEXTURE_FORMATS = new Set<GPUTextureFormat>([
    'r8unorm',
    'r8snorm',
    'rg8unorm',
    'rg8snorm',
    'rgba8unorm',
    'rgba8unorm-srgb',
    'rgba8snorm',
    'bgra8unorm',
    'bgra8unorm-srgb',
    'r16float',
    'rg16float',
    'rgba16float',
    'rgb10a2unorm',
    'rg11b10ufloat',
    'rgb9e5ufloat',
])
const UNFILTERABLE_FLOAT_TEXTURE_FORMATS = new Set<GPUTextureFormat>([
    ...FILTERABLE_FLOAT_TEXTURE_FORMATS,
    'r16unorm',
    'r16snorm',
    'rg16unorm',
    'rg16snorm',
    'rgba16unorm',
    'rgba16snorm',
    'r32float',
    'rg32float',
    'rgba32float',
])
const FLOAT32_TEXTURE_FORMATS = new Set<GPUTextureFormat>([
    'r32float',
    'rg32float',
    'rgba32float',
])
const UINT_TEXTURE_FORMATS = new Set<GPUTextureFormat>([
    'r8uint',
    'rg8uint',
    'rgba8uint',
    'r16uint',
    'rg16uint',
    'rgba16uint',
    'r32uint',
    'rg32uint',
    'rgba32uint',
    'rgb10a2uint',
    'stencil8',
])
const SINT_TEXTURE_FORMATS = new Set<GPUTextureFormat>([
    'r8sint',
    'rg8sint',
    'rgba8sint',
    'r16sint',
    'rg16sint',
    'rgba16sint',
    'r32sint',
    'rg32sint',
    'rgba32sint',
])
const DEPTH_TEXTURE_FORMATS = new Set<GPUTextureFormat>([
    'depth16unorm',
    'depth24plus',
    'depth24plus-stencil8',
    'depth32float',
    'depth32float-stencil8',
])
const WEBGPU_BUFFER_BINDING_TYPES = {
    uniform: 'uniform',
    'read-storage': 'read-only-storage',
    storage: 'storage',
} satisfies Record<BufferBindingType, GPUBufferBindingType>
const REQUIRED_BUFFER_USAGE = {
    uniform: BUFFER_USAGE_UNIFORM,
    'read-storage': BUFFER_USAGE_STORAGE,
    storage: BUFFER_USAGE_STORAGE,
} satisfies Record<BufferBindingType, GPUBufferUsageFlags>
const bindLayoutToken = Symbol('BindLayout')
const bindSetToken = Symbol('BindSet')
const bindLayoutStates = new WeakMap<BindLayout, { isDisposed: boolean }>()
const bindSetStates = new WeakMap<BindSet, BindSetInternalState>()
const BIND_LAYOUT_ALLOCATION_CODES = Object.freeze({
    validation: 'SCRATCH_BIND_LAYOUT_ALLOCATION_VALIDATION_FAILED',
    internal: 'SCRATCH_BIND_LAYOUT_ALLOCATION_INTERNAL_FAILED',
    outOfMemory: 'SCRATCH_BIND_LAYOUT_ALLOCATION_OUT_OF_MEMORY',
    nativeException: 'SCRATCH_BIND_LAYOUT_ALLOCATION_NATIVE_FAILED',
})
const BIND_SET_PREPARATION_CODES = Object.freeze({
    validation: 'SCRATCH_BIND_SET_PREPARATION_VALIDATION_FAILED',
    internal: 'SCRATCH_BIND_SET_PREPARATION_INTERNAL_FAILED',
    outOfMemory: 'SCRATCH_BIND_SET_PREPARATION_OUT_OF_MEMORY',
    nativeException: 'SCRATCH_BIND_SET_PREPARATION_NATIVE_FAILED',
    scopeFailure: 'SCRATCH_BIND_SET_PREPARATION_SCOPE_FAILED',
})

export type BindVisibility = 'vertex' | 'fragment' | 'compute'

export type UniformBindLayoutEntry = {
    binding: number
    name: string
    type: 'uniform'
    visibility: readonly BindVisibility[]
    hasDynamicOffset?: boolean
    minBindingSize?: number
}

export type StorageBindLayoutEntry = {
    binding: number
    name: string
    type: 'read-storage' | 'storage'
    visibility: readonly BindVisibility[]
    hasDynamicOffset?: boolean
    minBindingSize?: number
}

export type TextureBindLayoutEntry = {
    binding: number
    name: string
    type: 'texture'
    visibility: readonly BindVisibility[]
    sampleType?: GPUTextureSampleType
    viewDimension?: GPUTextureViewDimension
    multisampled?: boolean
}

export type SamplerBindLayoutEntry = {
    binding: number
    name: string
    type: 'sampler'
    visibility: readonly BindVisibility[]
    samplerType?: GPUSamplerBindingType
}

export type StorageTextureBindLayoutEntry = {
    binding: number
    name: string
    type: 'storage-texture'
    visibility: readonly BindVisibility[]
    access?: GPUStorageTextureAccess
    format: GPUTextureFormat
    viewDimension?: GPUTextureViewDimension
}

export type ExternalTextureBindLayoutEntry = {
    binding: number
    name: string
    type: 'external-texture'
    visibility: readonly BindVisibility[]
}

export type BindLayoutEntry =
    | UniformBindLayoutEntry
    | StorageBindLayoutEntry
    | TextureBindLayoutEntry
    | StorageTextureBindLayoutEntry
    | SamplerBindLayoutEntry
    | ExternalTextureBindLayoutEntry

export type NormalizedUniformBindLayoutEntry = Readonly<{
    binding: number
    name: string
    type: 'uniform'
    visibility: readonly BindVisibility[]
    hasDynamicOffset: boolean
    minBindingSize: number
}>

export type NormalizedStorageBindLayoutEntry = Readonly<{
    binding: number
    name: string
    type: 'read-storage' | 'storage'
    visibility: readonly BindVisibility[]
    hasDynamicOffset: boolean
    minBindingSize: number
}>

export type NormalizedTextureBindLayoutEntry = Readonly<{
    binding: number
    name: string
    type: 'texture'
    visibility: readonly BindVisibility[]
    sampleType: GPUTextureSampleType
    viewDimension: GPUTextureViewDimension
    multisampled: boolean
}>

export type NormalizedStorageTextureBindLayoutEntry = Readonly<{
    binding: number
    name: string
    type: 'storage-texture'
    visibility: readonly BindVisibility[]
    access: GPUStorageTextureAccess
    format: GPUTextureFormat
    viewDimension: GPUTextureViewDimension
}>

export type NormalizedSamplerBindLayoutEntry = Readonly<{
    binding: number
    name: string
    type: 'sampler'
    visibility: readonly BindVisibility[]
    samplerType: GPUSamplerBindingType
}>

export type NormalizedExternalTextureBindLayoutEntry = Readonly<{
    binding: number
    name: string
    type: 'external-texture'
    visibility: readonly BindVisibility[]
}>

export type NormalizedBindLayoutEntry =
    | NormalizedUniformBindLayoutEntry
    | NormalizedStorageBindLayoutEntry
    | NormalizedTextureBindLayoutEntry
    | NormalizedStorageTextureBindLayoutEntry
    | NormalizedSamplerBindLayoutEntry
    | NormalizedExternalTextureBindLayoutEntry

type BufferBindingType = UniformBindLayoutEntry['type'] | StorageBindLayoutEntry['type']
type BufferBindLayoutEntry = UniformBindLayoutEntry | StorageBindLayoutEntry
type NormalizedBufferBindLayoutEntry = NormalizedUniformBindLayoutEntry | NormalizedStorageBindLayoutEntry
type EntryWithDynamicOffsetFlag = BindLayoutEntry & { hasDynamicOffset?: unknown }

export type BindLayoutDescriptor = {
    label?: string
    group: number
    entries: readonly BindLayoutEntry[]
}

export type BindSetBindingResource =
    | BufferRegion
    | TextureResource
    | TextureViewSpec
    | SamplerResource
    | ExternalTextureBinding
    | SurfaceTextureLease
    | SurfaceTextureView

export type BindSetBindings = Record<string, BindSetBindingResource>

export type BindSetOptions = {
    label?: string
}

export type BindSetPreparationState =
    | 'preparing'
    | 'prepared'
    | 'attempt-local'
    | 'stale'
    | 'disposed'

type NormalizedBindSetBinding = Readonly<{
    readonly entry: NormalizedBindLayoutEntry
    readonly resource: BindSetBindingResource
}>

type BindSetPreparationSnapshot = Readonly<{
    signature: string
    hash: string
    facts: readonly Readonly<Record<string, unknown>>[]
    dependencies: readonly BindSetPreparationDependency[]
}>

type BindSetPreparationDependency = Readonly<{
    resource: BindSetBindingResource
    allocationVersion: number | undefined
}>

type PreparedBindSetCandidate = Readonly<{
    snapshot: BindSetPreparationSnapshot
    gpuBindGroup: GPUBindGroup
    textureViews: readonly GPUTextureView[]
}>

type InFlightBindSetPreparation = Readonly<{
    snapshot: BindSetPreparationSnapshot
    operation: ScratchPendingGpuOperation
    promise: Promise<void>
}>

type BindSetInternalState = {
    isDisposed: boolean
    isRegistered: boolean
    prepareGeneration: number
    committed: PreparedBindSetCandidate | undefined
    inFlight: InFlightBindSetPreparation | undefined
    cachedPreparedPromise: Promise<void> | undefined
    lastPreparationOperationId?: string
    lastIncidentId?: string
}

type NativePreparationIssue = Readonly<{
    sequence: number
    kind: 'texture-view' | 'bind-group'
    subject: DiagnosticSubject
    attempt: SupportingObjectCreationAttempt<GPUTextureView | GPUBindGroup>
}>

type TextureViewPreparationCandidate = Readonly<{
    key: string
    view: TextureViewSpec
    bindings: readonly NormalizedBindSetBinding[]
}>

type BindSetPreparationFailure = Readonly<{
    stage: ScratchGpuBindSetPreparationStage
    issueSequence: number
    scopeOrder: number
    kind: SupportingObjectFailureKind | 'snapshot-drift' | 'bind-set-disposed' |
        'bind-layout-disposed' | 'bound-resource-disposed'
    code: string
    nativeErrorCategory: GpuNativeErrorCategory
    subject: DiagnosticSubject
    cause?: unknown
}>

type ScratchBindingSupportedLimits = GPUSupportedLimits & Readonly<{
    maxStorageBuffersInVertexStage?: number
    maxStorageBuffersInFragmentStage?: number
    maxStorageTexturesInVertexStage?: number
    maxStorageTexturesInFragmentStage?: number
}>

export type BindingLimitViolation = Readonly<{
    limit: string
    maximum: number
    actual: number
    stage?: BindVisibility
}>

export interface BindLayout {
    readonly runtime: ScratchRuntime
    readonly id: string
    readonly label?: string
    readonly group: number
    readonly entries: readonly NormalizedBindLayoutEntry[]
    readonly gpuBindGroupLayout: GPUBindGroupLayout
}

export class BindLayout {

    private constructor(
        token: symbol,
        runtime: ScratchRuntime,
        id: string,
        descriptor: Readonly<{
            label?: string
            group: number
            entries: readonly NormalizedBindLayoutEntry[]
        }>,
        gpuBindGroupLayout: GPUBindGroupLayout
    ) {

        if (token !== bindLayoutToken || new.target !== BindLayout) {
            throw new TypeError('BindLayout must be created by ScratchRuntime.createBindLayout().')
        }
        bindLayoutStates.set(this, { isDisposed: false })
        Object.defineProperties(this, {
            runtime: immutableEnumerableProperty(runtime),
            id: immutableEnumerableProperty(id),
            group: immutableEnumerableProperty(descriptor.group),
            entries: immutableEnumerableProperty(descriptor.entries),
            gpuBindGroupLayout: immutableEnumerableProperty(gpuBindGroupLayout),
            ...(descriptor.label !== undefined
                ? { label: immutableEnumerableProperty(descriptor.label) }
                : {}),
        })
        Object.preventExtensions(this)
    }

    get isDisposed(): boolean {

        return bindLayoutStateFor(this).isDisposed
    }

    get subject(): DiagnosticSubject {

        const subject: DiagnosticSubject = {
            kind: 'BindLayout',
            id: this.id,
        }
        if (this.label !== undefined) subject.label = this.label

        return subject
    }

    assertRuntime(runtime: ScratchRuntime) {

        this.assertUsable()

        if (runtime !== this.runtime) {
            throwScratchDiagnostic({
                code: 'SCRATCH_BIND_WRONG_RUNTIME',
                severity: 'error',
                phase: 'binding',
                subject: this.subject,
                related: [
                    this.runtime.subject,
                    runtime?.subject,
                ].filter(Boolean),
                message: 'BindLayout belongs to a different ScratchRuntime.',
                expected: { runtimeId: this.runtime.id },
                actual: { runtimeId: runtime?.id },
            })
        }
    }

    assertUsable() {

        if (this.isDisposed) {
            throwScratchDiagnostic({
                code: 'SCRATCH_BIND_DISPOSED',
                severity: 'error',
                phase: 'binding',
                subject: this.subject,
                message: 'BindLayout has been disposed.',
            })
        }

        assertScratchRuntimeActive(this.runtime)
    }

    entrySubject(entry: unknown) {

        return bindLayoutEntrySubject(this.group, entry)
    }

    dispose(): void {

        if (this.isDisposed) return
        bindLayoutStateFor(this).isDisposed = true
        unregisterBindLayoutOwnership(this)
        diagnosticsControllerFor(this.runtime).unregisterBindLayout(this)
    }
}

export async function createBindLayout(
    runtime: ScratchRuntime,
    descriptor: BindLayoutDescriptor
): Promise<BindLayout> {

    assertScratchRuntimeActive(runtime)
    const id = `scratch-bind-layout-${UUID()}`
    const normalizedDescriptor = normalizeBindLayoutDescriptor(runtime, id, descriptor)
    const nativeLabel = createScratchNativeLabel(normalizedDescriptor.label, id)
    const nativeEntries = normalizedDescriptor.entries.map(lowerBindLayoutEntry)
    Object.freeze(nativeEntries)
    const nativeDescriptor: GPUBindGroupLayoutDescriptor = {
        label: nativeLabel,
        entries: nativeEntries,
    }
    Object.freeze(nativeDescriptor)
    const controller = diagnosticsControllerFor(runtime)
    const operation = controller.beginOperation({
        kind: 'bind-layout-allocation',
        target: {
            kind: 'bind-layout',
            bindLayoutId: id,
            group: normalizedDescriptor.group,
            entries: normalizedDescriptor.entries,
            acknowledgementState: 'pending',
        },
        descriptorSummary: {
            group: normalizedDescriptor.group,
            entryCount: normalizedDescriptor.entries.length,
            entryTypes: normalizedDescriptor.entries.map(entry => entry.type),
        },
        fullDescriptor: {
            ...normalizedDescriptor,
            entries: normalizedDescriptor.entries,
        },
        nativeLabel,
    })
    const outcome = recheckSupportingObjectLifecycle(
        runtime,
        await issueSupportingObjectCreation(
            runtime,
            () => runtime.device.createBindGroupLayout(nativeDescriptor)
        )
    )
    const subject = bindLayoutSubject(id, normalizedDescriptor.label)

    if (outcome.failures.length > 0 || outcome.candidate === undefined) {
        return throwSupportingObjectCreationFailure(
            runtime,
            operation,
            outcome,
            BIND_LAYOUT_ALLOCATION_CODES,
            {
                operationName: 'BindLayout allocation',
                phase: 'binding',
                subject,
            }
        )
    }

    let layout: BindLayout | undefined
    try {
        layout = constructBindLayout(
            runtime,
            id,
            normalizedDescriptor,
            outcome.candidate
        )
        registerBindLayoutOwnership(layout)
        controller.registerBindLayout(layout, operation.id)
    } catch (cause) {
        if (layout !== undefined) unregisterBindLayoutOwnership(layout)
        return throwSupportingObjectCreationFailure(
            runtime,
            operation,
            {
                candidate: outcome.candidate,
                failures: [ { kind: 'native-exception', cause } ],
            },
            BIND_LAYOUT_ALLOCATION_CODES,
            {
                operationName: 'BindLayout allocation',
                phase: 'binding',
                subject,
            }
        )
    }

    controller.completeOperation(operation, { status: 'succeeded' })
    return layout
}

export interface BindSet {
    readonly runtime: ScratchRuntime
    readonly id: string
    readonly label?: string
    readonly layout: BindLayout
    readonly bindings: ReadonlyMap<string, NormalizedBindSetBinding>
}

export class BindSet {

    private constructor(
        token: symbol,
        runtime: ScratchRuntime,
        id: string,
        layout: BindLayout,
        bindings: BindSetBindings,
        options: BindSetOptions
    ) {

        if (token !== bindSetToken || new.target !== BindSet) {
            throw new TypeError('BindSet must be created by ScratchRuntime.createBindSet().')
        }

        assertScratchRuntimeActive(runtime)

        if (!isBindLayout(layout)) {
            throwScratchDiagnostic({
                code: 'SCRATCH_BIND_REQUIRED_ENTRY_MISSING',
                severity: 'error',
                phase: 'binding',
                subject: { kind: 'BindSet' },
                message: 'BindSet requires a BindLayout.',
                expected: { layout: 'BindLayout' },
                actual: { layout: layout === undefined || layout === null ? String(layout) : typeof layout },
            })
        }

        layout.assertRuntime(runtime)
        if (!isRecord(options) || (
            options.label !== undefined && typeof options.label !== 'string'
        )) {
            throwScratchDiagnostic({
                code: 'SCRATCH_BIND_SET_DESCRIPTOR_INVALID',
                severity: 'error',
                phase: 'binding',
                subject: bindSetSubject(id),
                message: 'BindSet options require an optional string label.',
                expected: { label: 'string' },
                actual: { label: isRecord(options) ? options.label : describeValue(options) },
            })
        }

        bindSetStates.set(this, {
            isDisposed: false,
            isRegistered: false,
            prepareGeneration: 0,
            committed: undefined,
            inFlight: undefined,
            cachedPreparedPromise: undefined,
        })
        Object.defineProperties(this, {
            runtime: immutableEnumerableProperty(runtime),
            id: immutableEnumerableProperty(id),
            layout: immutableEnumerableProperty(layout),
            ...(options.label !== undefined
                ? { label: immutableEnumerableProperty(options.label) }
                : {}),
        })
        const normalizedBindings = lockNormalizedBindings(normalizeBindings(this, bindings))
        Object.defineProperty(this, 'bindings', {
            value: normalizedBindings,
            enumerable: true,
            configurable: false,
            writable: false,
        })
        Object.preventExtensions(this)
    }

    get isDisposed(): boolean {

        return bindSetStateFor(this).isDisposed
    }

    get preparationState(): BindSetPreparationState {

        const state = bindSetStateFor(this)
        if (state.isDisposed) return 'disposed'
        if (this.isAttemptLocal) return 'attempt-local'
        if (state.inFlight !== undefined) return 'preparing'
        if (
            state.committed !== undefined &&
            bindSetSnapshotCurrent(this, state.committed.snapshot)
        ) return 'prepared'
        return 'stale'
    }

    get prepareGeneration(): number {

        return bindSetStateFor(this).prepareGeneration
    }

    get isAttemptLocal(): boolean {

        return bindSetRequiresAttemptRealization(this)
    }

    get preparedSnapshotHash(): string | undefined {

        return bindSetStateFor(this).committed?.snapshot.hash
    }

    get inFlightOperationId(): string | undefined {

        return bindSetStateFor(this).inFlight?.operation.id
    }

    get lastPreparationOperationId(): string | undefined {

        return bindSetStateFor(this).lastPreparationOperationId
    }

    get lastIncidentId(): string | undefined {

        return bindSetStateFor(this).lastIncidentId
    }

    get subject(): DiagnosticSubject {

        const subject: DiagnosticSubject = {
            kind: 'BindSet',
            id: this.id,
        }
        if (this.label !== undefined) subject.label = this.label

        return subject
    }

    assertRuntime(runtime: ScratchRuntime) {

        this.assertUsable()

        if (runtime !== this.runtime) {
            throwScratchDiagnostic({
                code: 'SCRATCH_BIND_WRONG_RUNTIME',
                severity: 'error',
                phase: 'binding',
                subject: this.subject,
                related: [
                    this.runtime.subject,
                    runtime?.subject,
                ].filter(Boolean),
                message: 'BindSet belongs to a different ScratchRuntime.',
                expected: { runtimeId: this.runtime.id },
                actual: { runtimeId: runtime?.id },
            })
        }
    }

    assertUsable() {

        if (this.isDisposed) {
            throwScratchDiagnostic({
                code: 'SCRATCH_BIND_DISPOSED',
                severity: 'error',
                phase: 'binding',
                subject: this.subject,
                message: 'BindSet has been disposed.',
            })
        }

        assertScratchRuntimeActive(this.runtime)
        this.layout.assertUsable()
        if (this.isAttemptLocal) {
            for (const binding of bindingsInNativeOrder(this)) {
                validateBindingResource(this, binding.entry, binding.resource)
            }
            return
        }
        this.assertPrepared()
    }

    assertPrepared(): void {

        const state = this.preparationState
        if (state !== 'prepared') {
            throwScratchDiagnostic({
                code: state === 'preparing'
                    ? 'SCRATCH_BIND_SET_PREPARING'
                    : state === 'disposed'
                        ? 'SCRATCH_BIND_DISPOSED'
                        : 'SCRATCH_BIND_SET_STALE',
                severity: 'error',
                phase: 'binding',
                subject: this.subject,
                related: [ this.layout.subject ],
                message: state === 'preparing'
                    ? 'BindSet preparation is still pending.'
                    : state === 'disposed'
                        ? 'BindSet has been disposed.'
                        : 'BindSet allocation snapshot is stale and requires explicit preparation.',
                expected: { preparationState: 'prepared' },
                actual: {
                    preparationState: state,
                    prepareGeneration: this.prepareGeneration,
                    preparedSnapshotHash: this.preparedSnapshotHash,
                    inFlightOperationId: this.inFlightOperationId,
                },
            })
        }
    }

    prepare(): Promise<void> {

        const state = bindSetStateFor(this)
        if (state.isDisposed) return rejectedBindSetDiagnostic({
            code: 'SCRATCH_BIND_DISPOSED',
            severity: 'error',
            phase: 'binding',
            subject: this.subject,
            message: 'BindSet has been disposed.',
        })
        if (this.isAttemptLocal) return rejectedBindSetDiagnostic({
            code: 'SCRATCH_BIND_SET_ATTEMPT_LOCAL',
            severity: 'error',
            phase: 'binding',
            subject: this.subject,
            related: [ this.layout.subject ],
            message: 'Attempt-local BindSets are realized by their selected SubmissionBuilder.',
            expected: { realization: 'SubmissionBuilder.submit()' },
            actual: { preparationState: 'attempt-local' },
        })

        if (
            state.inFlight === undefined &&
            state.committed !== undefined &&
            bindSetSnapshotCurrent(this, state.committed.snapshot)
        ) {
            return state.cachedPreparedPromise!
        }

        const snapshot = captureBindSetSnapshot(this)
        if (state.inFlight !== undefined) {
            if (state.inFlight.snapshot.signature === snapshot.signature) {
                return state.inFlight.promise
            }
            return rejectedBindSetDiagnostic({
                code: 'SCRATCH_BIND_SET_PREPARATION_CONFLICT',
                severity: 'error',
                phase: 'binding',
                subject: this.subject,
                related: [ this.layout.subject ],
                message: 'BindSet preparation already owns a different allocation snapshot.',
                expected: {
                    snapshotHash: state.inFlight.snapshot.hash,
                    operationId: state.inFlight.operation.id,
                },
                actual: { snapshotHash: snapshot.hash },
            })
        }

        return beginBindSetPreparation(this, snapshot)
    }

    dispose(): void {

        const state = bindSetStateFor(this)
        if (state.isDisposed) return
        state.isDisposed = true
        state.committed = undefined
        state.cachedPreparedPromise = undefined
        if (state.isRegistered) {
            state.isRegistered = false
            unregisterBindSetOwnership(this)
            diagnosticsControllerFor(this.runtime).unregisterBindSet(this)
        }
    }
}

export function isBindLayout(value: unknown): value is BindLayout {

    return typeof value === 'object' && value !== null &&
        Object.getPrototypeOf(value) === BindLayout.prototype &&
        bindLayoutStates.has(value as BindLayout)
}

export function isBindSet(value: unknown): value is BindSet {

    return typeof value === 'object' && value !== null &&
        Object.getPrototypeOf(value) === BindSet.prototype &&
        bindSetStates.has(value as BindSet)
}

export async function createBindSet(
    runtime: ScratchRuntime,
    layout: BindLayout,
    bindings: BindSetBindings,
    options: BindSetOptions = {}
): Promise<BindSet> {

    assertScratchRuntimeActive(runtime)
    const bindSet = constructBindSet(
        runtime,
        `scratch-bind-set-${UUID()}`,
        layout,
        bindings,
        options
    )

    try {
        if (bindSet.isAttemptLocal) {
            bindSet.assertUsable()
            registerBindSetOwnership(bindSet)
            diagnosticsControllerFor(runtime).registerBindSet(bindSet)
            bindSetStateFor(bindSet).isRegistered = true
            return bindSet
        }
        await bindSet.prepare()
        bindSet.assertUsable()
        registerBindSetOwnership(bindSet)
        diagnosticsControllerFor(runtime).registerBindSet(bindSet)
        bindSetStateFor(bindSet).isRegistered = true
        return bindSet
    } catch (cause) {
        bindSet.dispose()
        throw cause
    }
}

export function preparedBindGroupFor(bindSet: BindSet): GPUBindGroup {

    if (bindSet.isAttemptLocal) {
        throwScratchDiagnostic({
            code: 'SCRATCH_ATTEMPT_AUTHORITY_REQUIRED',
            severity: 'error',
            phase: 'binding',
            subject: bindSet.subject,
            related: [ bindSet.layout.subject ],
            message: 'Attempt-local BindSet encoding requires SubmissionBuilder authority.',
            expected: { authority: 'active submission attempt' },
            actual: { authority: 'none' },
        })
    }
    const candidate = bindSetStateFor(bindSet).committed
    if (candidate === undefined) throw new TypeError('Prepared BindSet candidate is unavailable.')
    return candidate.gpuBindGroup
}

const attemptBindGroups = new WeakMap<AttemptTextureAuthority, Map<BindSet, GPUBindGroup>>()

export function bindSetRequiresAttemptRealization(bindSet: BindSet): boolean {

    return [ ...bindSet.bindings.values() ].some(binding =>
        isExternalTextureBinding(binding.resource) ||
        isSurfaceTextureLease(binding.resource) ||
        isSurfaceTextureView(binding.resource)
    )
}

export function assertBindSetTemporalDependencies(
    bindSet: BindSet,
    owner: SurfaceTextureLeaseOwner
): void {

    bindSet.assertRuntime(owner.runtime)
    for (const binding of bindSet.bindings.values()) {
        const resource = binding.resource
        if (isExternalTextureBinding(resource)) {
            assertExternalTextureBindingUsable(resource, owner.runtime)
            continue
        }
        if (isSurfaceTextureLease(resource)) {
            assertSurfaceTextureLeaseForSubmission(
                resource,
                owner,
                surfaceTextureUsageForBindingEntry(binding.entry),
                binding.entry.type
            )
            continue
        }
        if (isSurfaceTextureView(resource)) {
            assertSurfaceTextureViewForSubmission(
                resource,
                owner,
                surfaceTextureUsageForBindingEntry(binding.entry),
                binding.entry.type
            )
        }
    }
}

export function realizeAttemptBindGroup(
    bindSet: BindSet,
    authority: AttemptTextureAuthority
): GPUBindGroup {

    bindSet.assertUsable()
    if (!bindSet.isAttemptLocal) return preparedBindGroupFor(bindSet)
    let groups = attemptBindGroups.get(authority)
    if (groups === undefined) {
        groups = new Map()
        attemptBindGroups.set(authority, groups)
    }
    const existing = groups.get(bindSet)
    if (existing !== undefined) return existing

    const views = new Map<string, GPUTextureView>()
    for (const candidate of textureViewPreparationCandidates(bindSet)) {
        try {
            views.set(
                candidate.key,
                candidate.view.texture.gpuTexture.createView(
                    prepareTextureViewSpecDescriptor(candidate.view, true)
                )
            )
        } catch (cause) {
            throwScratchDiagnostic({
                code: 'SCRATCH_BIND_SET_ATTEMPT_REALIZATION_FAILED',
                severity: 'error',
                phase: 'submission',
                subject: bindSetTextureViewCandidateSubject(bindSet, candidate),
                related: [ bindSet.subject, bindSet.layout.subject ],
                message: 'Attempt-local binding view creation failed synchronously.',
                actual: { nativeError: serializeNativeGpuError(cause) },
            }, { cause })
        }
    }
    const entries = bindingsInNativeOrder(bindSet).map(binding => Object.freeze({
        binding: binding.entry.binding,
        resource: nativeAttemptBindingResource(binding, views, authority),
    }))
    Object.freeze(entries)
    let group: GPUBindGroup
    try {
        group = bindSet.runtime.device.createBindGroup({
            label: createScratchNativeLabel(bindSet.label, bindSet.id),
            layout: bindSet.layout.gpuBindGroupLayout,
            entries,
        })
    } catch (cause) {
        throwScratchDiagnostic({
            code: 'SCRATCH_BIND_SET_ATTEMPT_REALIZATION_FAILED',
            severity: 'error',
            phase: 'submission',
            subject: bindSet.subject,
            related: [ bindSet.layout.subject ],
            message: 'Attempt-local bind group creation failed synchronously.',
            actual: { nativeError: serializeNativeGpuError(cause) },
        }, { cause })
    }
    groups.set(bindSet, group)
    return group
}

function constructBindSet(
    runtime: ScratchRuntime,
    id: string,
    layout: BindLayout,
    bindings: BindSetBindings,
    options: BindSetOptions
): BindSet {

    const Constructor = BindSet as unknown as new (
        token: symbol,
        runtime: ScratchRuntime,
        id: string,
        layout: BindLayout,
        bindings: BindSetBindings,
        options: BindSetOptions
    ) => BindSet
    return new Constructor(bindSetToken, runtime, id, layout, bindings, options)
}

function bindSetStateFor(bindSet: BindSet): BindSetInternalState {

    const state = bindSetStates.get(bindSet)
    if (state === undefined) throw new TypeError('BindSet state is unavailable.')
    return state
}

function beginBindSetPreparation(
    bindSet: BindSet,
    snapshot: BindSetPreparationSnapshot
): Promise<void> {

    const state = bindSetStateFor(bindSet)
    state.committed = undefined
    state.cachedPreparedPromise = undefined
    const nativeLabel = createScratchNativeLabel(bindSet.label, bindSet.id)
    const controller = diagnosticsControllerFor(bindSet.runtime)
    const operation = controller.beginOperation({
        kind: 'bind-set-preparation',
        target: {
            kind: 'bind-set',
            bindSetId: bindSet.id,
            bindLayoutId: bindSet.layout.id,
            preparationState: 'preparing',
            generation: state.prepareGeneration,
            snapshotHash: snapshot.hash,
            preparationStage: state.prepareGeneration === 0
                ? 'descriptor-validation'
                : 'retry',
        },
        descriptorSummary: {
            bindLayoutId: bindSet.layout.id,
            bindingCount: bindSet.bindings.size,
            textureViewCount: uniqueTextureViewCount(bindSet),
            retry: state.prepareGeneration > 0,
            snapshotHash: snapshot.hash,
        },
        fullDescriptor: {
            bindLayoutId: bindSet.layout.id,
            bindings: snapshot.facts,
            snapshotHash: snapshot.hash,
        },
        nativeLabel,
    })

    let resolvePromise!: () => void
    let rejectPromise!: (cause: unknown) => void
    const promise = new Promise<void>((resolve, reject) => {
        resolvePromise = resolve
        rejectPromise = reject
    })
    const inFlight = Object.freeze({ snapshot, operation, promise })
    state.inFlight = inFlight

    void executeBindSetPreparation(bindSet, inFlight, nativeLabel).then(
        () => {
            if (state.inFlight === inFlight) state.inFlight = undefined
            if (!state.isDisposed && state.committed !== undefined) {
                state.cachedPreparedPromise = promise
            }
            resolvePromise()
        },
        cause => {
            if (state.inFlight === inFlight) state.inFlight = undefined
            rejectPromise(cause)
        }
    )
    return promise
}

async function executeBindSetPreparation(
    bindSet: BindSet,
    inFlight: InFlightBindSetPreparation,
    nativeLabel: string
): Promise<void> {

    try {
        assertScratchRuntimeActive(bindSet.runtime)
        bindSet.layout.assertUsable()
        for (const binding of bindingsInNativeOrder(bindSet)) {
            validateBindingResource(bindSet, binding.entry, binding.resource)
        }
    } catch (cause) {
        return failBindSetPreflight(bindSet, inFlight, cause)
    }

    const viewCandidates = new Map<string, GPUTextureView>()
    const issues: NativePreparationIssue[] = []
    let issueSequence = 0

    for (const candidate of textureViewPreparationCandidates(bindSet)) {
        const binding = candidate.bindings[0]!
        const viewLabel = bindSetTextureViewLabel(bindSet, binding)
        const descriptor = Object.freeze({
            ...prepareTextureViewSpecDescriptor(candidate.view, true),
            label: viewLabel,
        }) satisfies GPUTextureViewDescriptor
        const attempt = beginSupportingObjectCreation<GPUTextureView>(
            bindSet.runtime,
            () => candidate.view.texture.gpuTexture.createView(descriptor)
        )
        if (attempt.candidate !== undefined) {
            viewCandidates.set(candidate.key, attempt.candidate)
        }
        issues.push(Object.freeze({
            sequence: issueSequence++,
            kind: 'texture-view',
            subject: bindSetTextureViewCandidateSubject(bindSet, candidate),
            attempt,
        }))
    }

    const entries: GPUBindGroupEntry[] = []
    let entriesComplete = true
    for (const binding of bindingsInNativeOrder(bindSet)) {
        const resource = nativeBindingResource(binding, viewCandidates)
        if (resource === undefined) {
            entriesComplete = false
            continue
        }
        entries.push(Object.freeze({
            binding: binding.entry.binding,
            resource,
        }))
    }
    Object.freeze(entries)

    let bindGroupIssue: NativePreparationIssue | undefined
    if (entriesComplete) {
        const descriptor = Object.freeze({
            label: nativeLabel,
            layout: bindSet.layout.gpuBindGroupLayout,
            entries,
        }) satisfies GPUBindGroupDescriptor
        const attempt = beginSupportingObjectCreation<GPUBindGroup>(
            bindSet.runtime,
            () => bindSet.runtime.device.createBindGroup(descriptor)
        )
        bindGroupIssue = Object.freeze({
            sequence: issueSequence,
            kind: 'bind-group',
            subject: bindSet.subject,
            attempt,
        })
        issues.push(bindGroupIssue)
    }

    const outcomes = await Promise.all(issues.map(issue => issue.attempt.settlement))
    const failures = nativePreparationFailures(issues, outcomes)
    failures.push(...bindSetLifecycleFailures(bindSet))
    if (failures.length > 0) {
        return failBindSetPreparation(bindSet, inFlight, failures)
    }

    const currentSnapshot = captureBindSetSnapshot(bindSet)
    if (currentSnapshot.signature !== inFlight.snapshot.signature) {
        return failBindSetPreparation(bindSet, inFlight, [ Object.freeze({
            stage: 'snapshot-recheck',
            issueSequence: Number.MAX_SAFE_INTEGER,
            scopeOrder: 0,
            kind: 'snapshot-drift',
            code: 'SCRATCH_BIND_SET_PREPARATION_SNAPSHOT_DRIFT',
            nativeErrorCategory: 'none',
            subject: bindSet.subject,
        }) ])
    }

    const gpuBindGroup = bindGroupIssue?.attempt.candidate
    if (gpuBindGroup === undefined) {
        return failBindSetPreparation(bindSet, inFlight, [ Object.freeze({
            stage: 'native-issue',
            issueSequence: issueSequence,
            scopeOrder: 0,
            kind: 'native-exception',
            code: BIND_SET_PREPARATION_CODES.nativeException,
            nativeErrorCategory: 'native-exception',
            subject: bindSet.subject,
            cause: new TypeError('BindSet preparation produced no native bind-group candidate.'),
        }) ])
    }

    const state = bindSetStateFor(bindSet)
    const textureViews = Object.freeze([ ...viewCandidates.values() ])
    state.committed = Object.freeze({
        snapshot: inFlight.snapshot,
        gpuBindGroup,
        textureViews,
    })
    state.prepareGeneration++
    state.lastPreparationOperationId = inFlight.operation.id
    diagnosticsControllerFor(bindSet.runtime).completeOperation(inFlight.operation, {
        status: 'succeeded',
        bindSetTarget: bindSetOperationTarget(bindSet, inFlight.snapshot, 'commit', 'prepared'),
    })
}

function nativePreparationFailures(
    issues: readonly NativePreparationIssue[],
    outcomes: readonly SupportingObjectCreationOutcome<GPUTextureView | GPUBindGroup>[]
): BindSetPreparationFailure[] {

    const failures: BindSetPreparationFailure[] = []
    for (let index = 0; index < issues.length; index++) {
        const issue = issues[index]!
        const outcome = outcomes[index]!
        for (const failure of outcome.failures) {
            if (failure.kind === 'runtime-disposed' || failure.kind === 'device-lost') continue
            failures.push(preparationFailureForNativeIssue(issue, failure))
        }
        if (outcome.candidate === undefined && outcome.failures.length === 0) {
            failures.push(preparationFailureForNativeIssue(issue, {
                kind: 'native-exception',
                cause: new TypeError('Native preparation issue produced no candidate.'),
            }))
        }
    }

    return failures.sort(comparePreparationFailures)
}

function preparationFailureForNativeIssue(
    issue: NativePreparationIssue,
    failure: SupportingObjectObservedFailure
): BindSetPreparationFailure {

    return Object.freeze({
        stage: failure.kind === 'native-exception'
            ? 'synchronous-native-throw'
            : issue.kind === 'texture-view'
                ? 'texture-view-acknowledgement'
                : 'bind-group-acknowledgement',
        issueSequence: issue.sequence,
        scopeOrder: supportingFailureScopeOrder(failure.kind),
        kind: failure.kind,
        code: bindSetPreparationFailureCode(failure.kind),
        nativeErrorCategory: supportingFailureNativeCategory(failure.kind),
        subject: issue.subject,
        ...(failure.cause !== undefined ? { cause: failure.cause } : {}),
    })
}

function bindSetLifecycleFailures(bindSet: BindSet): BindSetPreparationFailure[] {

    const failures: BindSetPreparationFailure[] = []

    if (bindSet.runtime.isDisposed) {
        failures.push(lifecyclePreparationFailure(
            bindSet,
            'runtime-disposed',
            'SCRATCH_RUNTIME_DISPOSED',
            bindSet.runtime.subject
        ))
    }
    if (bindSet.runtime.isDeviceLost) {
        failures.push(lifecyclePreparationFailure(
            bindSet,
            'device-lost',
            'SCRATCH_RUNTIME_DEVICE_LOST_DURING_GPU_OPERATION',
            bindSet.runtime.subject
        ))
    }
    if (bindSet.isDisposed) {
        failures.push(lifecyclePreparationFailure(
            bindSet,
            'bind-set-disposed',
            'SCRATCH_BIND_DISPOSED',
            bindSet.subject
        ))
    }
    if (bindSet.layout.isDisposed) {
        failures.push(lifecyclePreparationFailure(
            bindSet,
            'bind-layout-disposed',
            'SCRATCH_BIND_DISPOSED',
            bindSet.layout.subject
        ))
    }
    const seenResources = new Set<BindSetBindingResource>()
    for (const [ index, binding ] of bindingsInNativeOrder(bindSet).entries()) {
        if (!bindingResourceDisposed(binding.resource)) continue
        if (seenResources.has(binding.resource)) continue
        seenResources.add(binding.resource)
        failures.push(lifecyclePreparationFailure(
            bindSet,
            'bound-resource-disposed',
            'SCRATCH_RESOURCE_DISPOSED',
            bindingResourceSubject(binding.resource),
            lifecycleFailureOrder('bound-resource-disposed') + index
        ))
    }
    return failures
}

function lifecyclePreparationFailure(
    bindSet: BindSet,
    kind: BindSetPreparationFailure['kind'],
    code: string,
    subject: DiagnosticSubject,
    scopeOrder = lifecycleFailureOrder(kind)
): BindSetPreparationFailure {

    return Object.freeze({
        stage: 'lifecycle-recheck',
        issueSequence: Number.MAX_SAFE_INTEGER,
        scopeOrder,
        kind,
        code,
        nativeErrorCategory: kind === 'device-lost' ? 'device-lost' : 'none',
        subject,
    })
}

function failBindSetPreflight(
    bindSet: BindSet,
    inFlight: InFlightBindSetPreparation,
    cause: unknown
): never {

    const diagnosticError = isScratchDiagnosticError(cause) ? cause : undefined
    const code = diagnosticError?.diagnostic.code ?? BIND_SET_PREPARATION_CODES.nativeException
    const failure = Object.freeze({
        stage: 'descriptor-validation' as const,
        issueSequence: -1,
        scopeOrder: 0,
        kind: 'validation' as const,
        code,
        nativeErrorCategory: 'none' as const,
        subject: diagnosticError?.diagnostic.subject ?? bindSet.subject,
        ...(cause !== undefined ? { cause } : {}),
    })

    return failBindSetPreparation(bindSet, inFlight, [ failure ], diagnosticError)
}

function failBindSetPreparation(
    bindSet: BindSet,
    inFlight: InFlightBindSetPreparation,
    failures: readonly BindSetPreparationFailure[],
    sourceDiagnostic?: ScratchDiagnosticError
): never {

    const ordered = [ ...failures ].sort(comparePreparationFailures)
    const primary = ordered[0]!
    const controller = diagnosticsControllerFor(bindSet.runtime)
    const state = bindSetStateFor(bindSet)
    state.committed = undefined
    state.cachedPreparedPromise = undefined
    const deviceLossIncident = primary.kind === 'device-lost'
        ? controller.recordDeviceLoss((bindSet.runtime.deviceLostInfo ?? {
            reason: 'unknown',
            message: 'GPU device was lost while BindSet preparation was settling.',
        }) as GPUDeviceLostInfo)
        : undefined
    const cancelled = primary.stage === 'lifecycle-recheck' || primary.stage === 'snapshot-recheck'
    const record = controller.completeOperation(inFlight.operation, {
        status: cancelled ? 'cancelled' : 'failed',
        nativeErrorCategory: primary.nativeErrorCategory,
        bindSetTarget: bindSetOperationTarget(
            bindSet,
            inFlight.snapshot,
            primary.stage === 'snapshot-recheck' ? 'snapshot-recheck' : primary.stage,
            state.isDisposed ? 'disposed' : 'stale'
        ),
    })
    const outcomes = Object.freeze(ordered.map(preparationIncidentOutcome))
    const incident = controller.recordIncident({
        kind: 'supporting-object-failure',
        diagnosticCode: primary.code,
        nativeErrorCategory: primary.nativeErrorCategory,
        attribution: 'exact-operation',
        target: record.target,
        operationId: record.id,
        triggerOperation: record,
        related: [
            bindSet.subject,
            bindSet.layout.subject,
            ...ordered.map(failure => failure.subject),
            ...(deviceLossIncident !== undefined ? [ deviceLossIncident.subject ] : []),
        ],
        ...(primary.cause !== undefined
            ? { nativeError: serializeNativeGpuError(primary.cause) }
            : {}),
        failureStage: primary.stage,
        outcomes,
    })
    state.lastIncidentId = incident.id

    if (sourceDiagnostic !== undefined) {
        throw new ScratchDiagnosticError(
            sourceDiagnostic.diagnostic,
            sourceDiagnostic.report,
            { cause: sourceDiagnostic, incident }
        )
    }

    throwScratchDiagnostic({
        code: primary.code,
        severity: 'error',
        phase: primary.stage === 'lifecycle-recheck' ? 'runtime' : 'binding',
        subject: { kind: 'GpuOperation', id: record.id, operationKind: record.kind },
        related: [
            bindSet.subject,
            bindSet.layout.subject,
            primary.subject,
            ...(deviceLossIncident !== undefined ? [ deviceLossIncident.subject ] : []),
            incident.subject,
        ],
        message: bindSetPreparationFailureMessage(primary),
        actual: {
            operationId: record.id,
            snapshotHash: inFlight.snapshot.hash,
            failures: outcomes,
        },
    }, {
        ...(primary.cause !== undefined ? { cause: primary.cause } : {}),
        incident,
    })
}

function preparationIncidentOutcome(
    failure: BindSetPreparationFailure
): ScratchGpuIncidentOutcome {

    return Object.freeze({
        stage: failure.stage,
        diagnosticCode: failure.code,
        nativeErrorCategory: failure.nativeErrorCategory,
        subject: failure.subject,
        ...(failure.cause !== undefined
            ? { nativeError: serializeNativeGpuError(failure.cause) }
            : {}),
    })
}

function bindSetOperationTarget(
    bindSet: BindSet,
    snapshot: BindSetPreparationSnapshot,
    stage: ScratchGpuBindSetPreparationStage,
    preparationState: Exclude<BindSetPreparationState, 'attempt-local'>
) {

    return Object.freeze({
        kind: 'bind-set' as const,
        bindSetId: bindSet.id,
        bindLayoutId: bindSet.layout.id,
        preparationState,
        generation: bindSet.prepareGeneration,
        snapshotHash: snapshot.hash,
        preparationStage: stage,
    })
}

function captureBindSetSnapshot(bindSet: BindSet): BindSetPreparationSnapshot {

    const orderedBindings = bindingsInNativeOrder(bindSet)
    const facts = orderedBindings.map(binding => {
        const entry = binding.entry
        const resource = binding.resource
        const base = {
            name: entry.name,
            binding: entry.binding,
            entry: canonicalizeSnapshotValue(entry),
        }
        if (isBufferRegion(resource)) {
            return Object.freeze({
                ...base,
                resourceKind: 'buffer-region',
                resourceId: resource.buffer.id,
                allocationVersion: resource.buffer.allocationVersion,
                offset: resource.offset,
                size: resource.size,
                abiHash: resource.layout?.abiHash ?? null,
                schemaHash: resource.layout?.schemaHash ?? null,
            })
        }
        if (isTextureViewSpec(resource)) {
            return Object.freeze({
                ...base,
                resourceKind: 'texture-view',
                resourceId: resource.texture.id,
                allocationVersion: resource.texture.allocationVersion,
                viewHash: resource.hash,
                descriptor: canonicalizeSnapshotValue(resource.descriptor),
            })
        }
        if (isTextureResource(resource)) {
            return Object.freeze({
                ...base,
                resourceKind: 'texture',
                resourceId: resource.id,
                allocationVersion: resource.allocationVersion,
            })
        }
        if (isSamplerResource(resource)) {
            return Object.freeze({
                ...base,
                resourceKind: 'sampler',
                resourceId: resource.id,
                allocationVersion: resource.allocationVersion,
            })
        }
        if (isExternalTextureBinding(resource)) {
            return Object.freeze({
                ...base,
                resourceKind: 'external-texture-binding',
                bindingId: resource.id,
                sourceKind: resource.sourceKind,
                colorSpace: resource.colorSpace,
            })
        }
        if (isSurfaceTextureLease(resource)) {
            const facts = surfaceTextureLeaseFacts(resource)
            return Object.freeze({
                ...base,
                resourceKind: 'surface-texture-lease',
                leaseId: resource.id,
                surfaceId: facts.surfaceFacts.id,
                configurationVersion: facts.configurationVersion,
                state: facts.state,
            })
        }
        if (isSurfaceTextureView(resource)) {
            const view = surfaceTextureViewFacts(resource)
            const facts = surfaceTextureLeaseFacts(view.lease)
            return Object.freeze({
                ...base,
                resourceKind: 'surface-texture-view',
                leaseId: view.lease.id,
                surfaceId: facts.surfaceFacts.id,
                configurationVersion: facts.configurationVersion,
                descriptor: canonicalizeSnapshotValue(view.descriptor),
            })
        }
        return Object.freeze({
            ...base,
            resourceKind: 'invalid',
            value: describeValue(resource),
        })
    })
    Object.freeze(facts)
    const dependencies = Object.freeze(orderedBindings.map(binding => Object.freeze({
        resource: binding.resource,
        allocationVersion: bindingResourceAllocationVersion(binding.resource),
    })))
    const signature = JSON.stringify({
        bindLayoutId: bindSet.layout.id,
        bindLayoutGroup: bindSet.layout.group,
        bindLayoutAcknowledged: true,
        bindings: facts,
    })

    return Object.freeze({
        signature,
        hash: `bind-set-snapshot-${fnv1a64(signature)}`,
        facts,
        dependencies,
    })
}

function canonicalizeSnapshotValue(value: unknown): unknown {

    if (Array.isArray(value)) return value.map(canonicalizeSnapshotValue)
    if (!isRecord(value)) return value
    return Object.keys(value).sort().reduce<Record<string, unknown>>((result, key) => {
        result[key] = canonicalizeSnapshotValue(value[key])
        return result
    }, {})
}

function bindingsInNativeOrder(bindSet: BindSet): NormalizedBindSetBinding[] {

    return [ ...bindSet.bindings.values() ]
        .sort((left, right) => left.entry.binding - right.entry.binding)
}

function nativeBindingResource(
    binding: NormalizedBindSetBinding,
    views: ReadonlyMap<string, GPUTextureView>
): GPUBindingResource | undefined {

    const resource = binding.resource
    if (isBufferRegion(resource)) {
        return Object.freeze({
            buffer: resource.buffer.gpuBuffer,
            offset: resource.offset,
            size: resource.size,
        })
    }
    if (isTextureResource(resource)) return resource.gpuTexture
    if (isTextureViewSpec(resource)) return views.get(textureViewCandidateKey(resource))
    if (isSamplerResource(resource)) return resource.gpuSampler
    return undefined
}

function nativeAttemptBindingResource(
    binding: NormalizedBindSetBinding,
    views: ReadonlyMap<string, GPUTextureView>,
    authority: AttemptTextureAuthority
): GPUBindingResource {

    const resource = binding.resource
    if (isExternalTextureBinding(resource)) return authority.externalTexture(resource)
    if (isSurfaceTextureLease(resource)) return authority.surfaceTexture(resource)
    if (isSurfaceTextureView(resource)) return authority.surfaceView(resource)
    const persistent = nativeBindingResource(binding, views)
    if (persistent !== undefined) return persistent
    throw new TypeError('Attempt-local BindSet binding could not be lowered.')
}

function textureViewCandidateKey(view: TextureViewSpec): string {

    return JSON.stringify({
        resourceId: view.texture.id,
        allocationVersion: view.texture.allocationVersion,
        hash: view.hash,
        descriptor: canonicalizeSnapshotValue(view.descriptor),
    })
}

function textureViewPreparationCandidates(
    bindSet: BindSet
): readonly TextureViewPreparationCandidate[] {

    const candidates = new Map<string, {
        view: TextureViewSpec
        bindings: NormalizedBindSetBinding[]
    }>()
    for (const binding of bindingsInNativeOrder(bindSet)) {
        if (!isTextureViewSpec(binding.resource)) continue
        const key = textureViewCandidateKey(binding.resource)
        const candidate = candidates.get(key)
        if (candidate === undefined) {
            candidates.set(key, {
                view: binding.resource,
                bindings: [ binding ],
            })
        } else {
            candidate.bindings.push(binding)
        }
    }

    return Object.freeze([ ...candidates ].map(([ key, candidate ]) => Object.freeze({
        key,
        view: candidate.view,
        bindings: Object.freeze([ ...candidate.bindings ]),
    })))
}

function bindSetTextureViewCandidateSubject(
    bindSet: BindSet,
    candidate: TextureViewPreparationCandidate
): DiagnosticSubject {

    const bindingLimit = 8
    const bindings = Object.freeze(candidate.bindings.slice(0, bindingLimit).map(binding => Object.freeze({
        group: bindSet.layout.group,
        binding: binding.entry.binding,
        name: binding.entry.name,
    })))
    return {
        kind: 'BindSetTextureViewCandidate',
        bindSetId: bindSet.id,
        bindLayoutId: bindSet.layout.id,
        group: bindSet.layout.group,
        resourceId: candidate.view.texture.id,
        allocationVersion: candidate.view.texture.allocationVersion,
        viewSpecHash: candidate.view.hash,
        bindings,
        omittedBindingCount: candidate.bindings.length - bindings.length,
    }
}

function bindSetTextureViewLabel(
    bindSet: BindSet,
    binding: NormalizedBindSetBinding
): string {

    const view = binding.resource as TextureViewSpec
    const prefix = bindSet.label === undefined ? 'BindSet texture view' : `${bindSet.label} texture view`
    return createScratchNativeLabel(
        `${prefix} ${binding.entry.binding}:${binding.entry.name} ${view.hash}`,
        bindSet.id
    )
}

function uniqueTextureViewCount(bindSet: BindSet): number {

    return new Set([ ...bindSet.bindings.values() ]
        .filter(binding => isTextureViewSpec(binding.resource))
        .map(binding => textureViewCandidateKey(binding.resource as TextureViewSpec))).size
}

function bindSetSnapshotCurrent(
    bindSet: BindSet,
    snapshot: BindSetPreparationSnapshot
): boolean {

    if (
        bindSet.runtime.isDisposed ||
        bindSet.runtime.isDeviceLost ||
        bindSet.layout.isDisposed
    ) return false
    for (let index = 0; index < snapshot.dependencies.length; index++) {
        const dependency = snapshot.dependencies[index]!
        if (
            bindingResourceDisposed(dependency.resource) ||
            bindingResourceAllocationVersion(dependency.resource) !== dependency.allocationVersion
        ) return false
    }
    return true
}

function bindingResourceAllocationVersion(
    resource: BindSetBindingResource
): number | undefined {

    if (isBufferRegion(resource)) return resource.buffer.allocationVersion
    if (isTextureResource(resource)) return resource.allocationVersion
    if (isTextureViewSpec(resource)) return resource.texture.allocationVersion
    return isSamplerResource(resource) ? resource.allocationVersion : undefined
}

function bindingResourceDisposed(resource: BindSetBindingResource): boolean {

    if (isBufferRegion(resource)) return resource.buffer.isDisposed
    if (isTextureResource(resource)) return resource.isDisposed
    if (isTextureViewSpec(resource)) return resource.texture.isDisposed
    if (isSamplerResource(resource)) return resource.isDisposed
    return false
}

function bindingResourceSubject(
    resource: BindSetBindingResource
): DiagnosticSubject {

    return resource.subject
}

function comparePreparationFailures(
    left: BindSetPreparationFailure,
    right: BindSetPreparationFailure
): number {

    const stageOrder: Record<ScratchGpuBindSetPreparationStage, number> = {
        'descriptor-validation': 0,
        'native-issue': 1,
        'synchronous-native-throw': 1,
        'texture-view-acknowledgement': 2,
        'bind-group-acknowledgement': 2,
        'lifecycle-recheck': 3,
        'snapshot-recheck': 4,
        commit: 5,
        cancellation: 6,
        retry: 7,
    }
    return stageOrder[left.stage] - stageOrder[right.stage] ||
        left.issueSequence - right.issueSequence ||
        left.scopeOrder - right.scopeOrder
}

function supportingFailureScopeOrder(kind: SupportingObjectFailureKind): number {

    if (kind === 'native-exception') return 0
    if (kind === 'scope-failure') return 1
    if (kind === 'validation') return 2
    if (kind === 'internal') return 3
    if (kind === 'out-of-memory') return 4
    return 5
}

function lifecycleFailureOrder(kind: BindSetPreparationFailure['kind']): number {

    if (kind === 'runtime-disposed') return 0
    if (kind === 'device-lost') return 1
    if (kind === 'bind-set-disposed') return 2
    if (kind === 'bind-layout-disposed') return 3
    return 4
}

function bindSetPreparationFailureCode(kind: SupportingObjectFailureKind): string {

    if (kind === 'validation') return BIND_SET_PREPARATION_CODES.validation
    if (kind === 'internal') return BIND_SET_PREPARATION_CODES.internal
    if (kind === 'out-of-memory') return BIND_SET_PREPARATION_CODES.outOfMemory
    if (kind === 'scope-failure') return BIND_SET_PREPARATION_CODES.scopeFailure
    if (kind === 'runtime-disposed') return 'SCRATCH_RUNTIME_DISPOSED'
    if (kind === 'device-lost') return 'SCRATCH_RUNTIME_DEVICE_LOST_DURING_GPU_OPERATION'
    return BIND_SET_PREPARATION_CODES.nativeException
}

function supportingFailureNativeCategory(
    kind: SupportingObjectFailureKind
): GpuNativeErrorCategory {

    if (
        kind === 'validation' ||
        kind === 'internal' ||
        kind === 'out-of-memory' ||
        kind === 'scope-failure' ||
        kind === 'device-lost'
    ) return kind
    if (kind === 'runtime-disposed') return 'none'
    return 'native-exception'
}

function bindSetPreparationFailureMessage(failure: BindSetPreparationFailure): string {

    if (failure.kind === 'snapshot-drift') {
        return 'BindSet allocation snapshot changed while preparation was pending.'
    }
    if (failure.stage === 'lifecycle-recheck') {
        return 'BindSet preparation was cancelled by a lifecycle change.'
    }
    if (failure.kind === 'validation') return 'BindSet preparation failed native validation.'
    if (failure.kind === 'internal') return 'BindSet preparation observed a native internal error.'
    if (failure.kind === 'out-of-memory') return 'BindSet preparation observed native out-of-memory.'
    if (failure.kind === 'scope-failure') return 'BindSet preparation error scopes failed to settle.'
    return 'BindSet preparation failed during native candidate creation.'
}

function rejectedBindSetDiagnostic(
    input: Parameters<typeof throwScratchDiagnostic>[0]
): Promise<never> {

    try {
        throwScratchDiagnostic(input)
    } catch (cause) {
        return Promise.reject(cause)
    }
}

function bindSetSubject(id: string, label?: string): DiagnosticSubject {

    return {
        kind: 'BindSet',
        id,
        ...(label !== undefined ? { label } : {}),
    }
}

function fnv1a64(value: string): string {

    let hash = 0xcbf29ce484222325n
    for (let index = 0; index < value.length; index++) {
        hash ^= BigInt(value.charCodeAt(index))
        hash = BigInt.asUintN(64, hash * 0x100000001b3n)
    }
    return hash.toString(16).padStart(16, '0')
}

function lockNormalizedBindings(
    bindings: Map<string, NormalizedBindSetBinding>
): ReadonlyMap<string, NormalizedBindSetBinding> {

    for (const binding of bindings.values()) Object.freeze(binding)
    return readonlyMapSnapshot(bindings)
}

type BindLayoutDiagnosticContext = Readonly<{
    subject: DiagnosticSubject
    entrySubject(entry: unknown): DiagnosticSubject
}>

function constructBindLayout(
    runtime: ScratchRuntime,
    id: string,
    descriptor: Readonly<{
        label?: string
        group: number
        entries: readonly NormalizedBindLayoutEntry[]
    }>,
    gpuBindGroupLayout: GPUBindGroupLayout
): BindLayout {

    const Constructor = BindLayout as unknown as new (
        token: symbol,
        runtime: ScratchRuntime,
        id: string,
        descriptor: Readonly<{
            label?: string
            group: number
            entries: readonly NormalizedBindLayoutEntry[]
        }>,
        gpuBindGroupLayout: GPUBindGroupLayout
    ) => BindLayout
    return new Constructor(bindLayoutToken, runtime, id, descriptor, gpuBindGroupLayout)
}

function bindLayoutStateFor(layout: BindLayout): { isDisposed: boolean } {

    const state = bindLayoutStates.get(layout)
    if (state === undefined) throw new TypeError('BindLayout state is unavailable.')
    return state
}

function immutableEnumerableProperty<T>(value: T): PropertyDescriptor {

    return {
        value,
        enumerable: true,
        configurable: false,
        writable: false,
    }
}

function normalizeBindLayoutDescriptor(
    runtime: ScratchRuntime,
    id: string,
    descriptor: unknown
): Readonly<{
    label?: string
    group: number
    entries: readonly NormalizedBindLayoutEntry[]
}> {

    if (!runtime?.device || typeof runtime.device.createBindGroupLayout !== 'function') {
        throwScratchDiagnostic({
            code: 'SCRATCH_RUNTIME_DEVICE_UNAVAILABLE',
            severity: 'error',
            phase: 'runtime',
            subject: runtime?.subject ?? { kind: 'ScratchRuntime' },
            message: 'ScratchRuntime device cannot create GPU bind-group layouts.',
            expected: { device: 'GPUDevice with createBindGroupLayout()' },
            actual: { createBindGroupLayout: typeof runtime?.device?.createBindGroupLayout },
        })
    }
    if (!isRecord(descriptor)) {
        throwBindLayoutDescriptorDiagnostic(
            bindLayoutSubject(id),
            descriptor,
            { descriptor: 'object' }
        )
    }
    if (descriptor.label !== undefined && typeof descriptor.label !== 'string') {
        throwBindLayoutDescriptorDiagnostic(
            bindLayoutSubject(id),
            descriptor,
            { label: 'string' }
        )
    }

    const label = descriptor.label as string | undefined
    const subject = bindLayoutSubject(id, label)
    const provisionalContext: BindLayoutDiagnosticContext = {
        subject,
        entrySubject: entry => bindLayoutEntrySubject(0, entry),
    }
    const group = normalizeGroup(runtime, provisionalContext, descriptor.group)
    const context: BindLayoutDiagnosticContext = {
        subject,
        entrySubject: entry => bindLayoutEntrySubject(group, entry),
    }
    const entries = normalizeEntries(runtime, context, descriptor.entries)
    validateBindingLimits(runtime, context, entries)

    return Object.freeze({
        ...(label !== undefined ? { label } : {}),
        group,
        entries,
    })
}

function normalizeGroup(
    runtime: ScratchRuntime,
    layout: BindLayoutDiagnosticContext,
    group: unknown
): number {

    const maxBindGroups = runtime.deviceLimits.maxBindGroups
    if (
        typeof group !== 'number' ||
        !Number.isInteger(group) ||
        group < 0 ||
        group >= maxBindGroups
    ) {
        throwScratchDiagnostic({
            code: 'SCRATCH_BIND_REQUIRED_ENTRY_MISSING',
            severity: 'error',
            phase: 'binding',
            subject: layout.subject,
            message: 'BindLayout group must be a non-negative integer.',
            expected: { group: `integer in [0, ${maxBindGroups})` },
            actual: { group },
        })
    }

    return group
}

function normalizeEntries(
    runtime: ScratchRuntime,
    layout: BindLayoutDiagnosticContext,
    entries: unknown
): readonly NormalizedBindLayoutEntry[] {

    if (!Array.isArray(entries)) {
        throwBindLayoutDescriptorDiagnostic(layout.subject, { entries }, { entries: 'array' })
    }

    const names = new Set()
    const bindings = new Set()

    const normalized = entries.map((entry: unknown) => {
        if (!isRecord(entry) || typeof entry.name !== 'string' || entry.name.length === 0) {
            throwBindEntryDiagnostic(layout, entry)
        }

        if (
            typeof entry.binding !== 'number' ||
            !Number.isInteger(entry.binding) ||
            entry.binding < 0 ||
            entry.binding >= runtime.deviceLimits.maxBindingsPerBindGroup ||
            !isSupportedBindingType(entry.type)
        ) {
            throwBindEntryDiagnostic(layout, entry)
        }

        if (names.has(entry.name) || bindings.has(entry.binding)) {
            throwScratchDiagnostic({
                code: 'SCRATCH_BIND_SHADER_INDEX_MISMATCH',
                severity: 'error',
                phase: 'binding',
                subject: layout.entrySubject(entry),
                message: 'BindLayout entries must have unique names and binding indices.',
                expected: { unique: [ 'name', 'binding' ] },
                actual: { name: entry.name, binding: entry.binding },
            })
        }

        names.add(entry.name)
        bindings.add(entry.binding)

        const typedEntry = entry as BindLayoutEntry
        const base = {
            binding: entry.binding,
            name: entry.name,
            visibility: normalizeVisibility(layout, typedEntry),
        }

        if (typedEntry.type === 'texture') {
            rejectDynamicOffsetFlag(layout, typedEntry)

            const sampleType = normalizeTextureSampleType(layout, typedEntry)
            const viewDimension = normalizeTextureViewDimension(layout, typedEntry)
            const multisampled = normalizeTextureMultisampled(layout, typedEntry)
            if (multisampled && (viewDimension !== '2d' || sampleType === 'float')) {
                throwBindEntryDiagnostic(layout, typedEntry)
            }

            return Object.freeze({
                ...base,
                type: typedEntry.type,
                sampleType,
                viewDimension,
                multisampled,
            })
        }

        if (typedEntry.type === 'storage-texture') {
            rejectDynamicOffsetFlag(layout, typedEntry)
            const access = normalizeStorageTextureAccess(layout, typedEntry)
            const format = normalizeStorageTextureFormat(runtime, layout, typedEntry, access)
            const viewDimension = normalizeStorageTextureViewDimension(layout, typedEntry)
            if (base.visibility.includes('vertex') && access !== 'read-only') {
                throwBindEntryDiagnostic(layout, typedEntry)
            }

            return Object.freeze({
                ...base,
                type: typedEntry.type,
                access,
                format,
                viewDimension,
            })
        }

        if (typedEntry.type === 'sampler') {
            rejectDynamicOffsetFlag(layout, typedEntry)

            return Object.freeze({
                ...base,
                type: typedEntry.type,
                samplerType: normalizeSamplerBindingType(layout, typedEntry),
            })
        }

        if (typedEntry.type === 'external-texture') {
            rejectDynamicOffsetFlag(layout, typedEntry)
            return Object.freeze({
                ...base,
                type: typedEntry.type,
            })
        }

        if (typedEntry.type === 'storage' && base.visibility.includes('vertex')) {
            throwBindEntryDiagnostic(layout, typedEntry)
        }
        const hasDynamicOffset = normalizeDynamicOffsetFlag(layout, typedEntry)
        const minBindingSize = normalizeMinBindingSize(layout, typedEntry)

        return Object.freeze({
            ...base,
            type: typedEntry.type,
            hasDynamicOffset,
            minBindingSize,
        })
    })

    return Object.freeze(normalized)
}

function isSupportedBindingType(type: unknown): type is BindLayoutEntry['type'] {

    return typeof type === 'string' &&
        (
            isBufferBindingType(type) ||
            type === 'texture' ||
            type === 'storage-texture' ||
            type === 'sampler' ||
            type === 'external-texture'
        )
}

function normalizeVisibility(
    layout: BindLayoutDiagnosticContext,
    entry: BindLayoutEntry
): readonly BindVisibility[] {

    if (!Array.isArray(entry.visibility)) {
        throwBindEntryDiagnostic(layout, entry)
    }

    for (const stage of entry.visibility) {
        if (!Object.hasOwn(SHADER_STAGE_FLAGS, stage)) {
            throwBindEntryDiagnostic(layout, entry)
        }
    }

    return Object.freeze(([ 'vertex', 'fragment', 'compute' ] as const)
        .filter(stage => entry.visibility.includes(stage)))
}

function normalizeBindings(bindSet: BindSet, bindings: BindSetBindings): Map<string, NormalizedBindSetBinding> {

    if (!bindings || typeof bindings !== 'object') {
        throwScratchDiagnostic({
            code: 'SCRATCH_BIND_REQUIRED_ENTRY_MISSING',
            severity: 'error',
            phase: 'binding',
            subject: bindSet.subject,
            message: 'BindSet bindings must be an object keyed by BindLayout entry name.',
            expected: { bindings: 'object' },
            actual: { bindings: bindings === null ? 'null' : typeof bindings },
        })
    }

    const expectedNames = bindSet.layout.entries.map(entry => entry.name)
    for (const name of Object.keys(bindings)) {
        if (!expectedNames.includes(name)) {
            throwScratchDiagnostic({
                code: 'SCRATCH_BIND_UNKNOWN_ENTRY',
                severity: 'error',
                phase: 'binding',
                subject: bindSet.subject,
                related: [ bindSet.layout.subject ],
                message: 'BindSet includes a binding name that is not present in its BindLayout.',
                expected: { names: expectedNames },
                actual: { name },
            })
        }
    }

    const normalized = new Map<string, NormalizedBindSetBinding>()

    for (const entry of bindSet.layout.entries) {
        const resource = bindings[entry.name]
        if (resource === undefined) {
            throwScratchDiagnostic({
                code: 'SCRATCH_BIND_REQUIRED_ENTRY_MISSING',
                severity: 'error',
                phase: 'binding',
                subject: bindSet.layout.entrySubject(entry),
                related: [ bindSet.subject, bindSet.layout.subject ],
                message: 'BindSet is missing a required BindLayout entry.',
                expected: { name: entry.name },
                actual: { names: Object.keys(bindings) },
            })
        }

        normalized.set(entry.name, { entry, resource })
    }

    return normalized
}

function validateBindingResource(bindSet: BindSet, entry: NormalizedBindLayoutEntry, resource: unknown) {

    if (isBufferBindLayoutEntry(entry)) {
        validateBufferResource(bindSet, entry, resource)
        return
    }

    if (entry.type === 'texture' || entry.type === 'storage-texture') {
        validateTextureResource(bindSet, entry, resource)
        return
    }

    if (entry.type === 'sampler') {
        validateSamplerResource(bindSet, entry, resource)
        return
    }

    if (entry.type === 'external-texture') {
        validateExternalTextureResource(bindSet, entry, resource)
        return
    }

    throwBindEntryDiagnostic(bindSet.layout, entry)
}

function validateBufferResource(
    bindSet: BindSet,
    entry: NormalizedBufferBindLayoutEntry,
    resource: unknown
) {

    if (!isBufferRegion(resource)) {
        throwScratchDiagnostic({
            code: 'SCRATCH_BIND_RESOURCE_TYPE_MISMATCH',
            severity: 'error',
            phase: 'binding',
            subject: bindSet.layout.entrySubject(entry),
            related: [ bindSet.subject ],
            message: 'BindSet buffer entries require BufferRegion bindings.',
            expected: { type: 'BufferRegion' },
            actual: { resource: describeValue(resource) },
        })
    }

    resource.buffer.assertRuntime(bindSet.runtime)
    resource.assertUsable()

    const requiredUsage = REQUIRED_BUFFER_USAGE[entry.type]
    if ((resource.buffer.usage & requiredUsage) === 0) {
        throwScratchDiagnostic({
            code: 'SCRATCH_BIND_RESOURCE_USAGE_MISSING',
            severity: 'error',
            phase: 'binding',
            subject: resource.subject,
            related: [ bindSet.layout.entrySubject(entry), bindSet.subject ],
            message: 'Buffer binding requires a buffer created with compatible usage.',
            expected: { usage: entry.type },
            actual: { usage: resource.buffer.usage },
        })
    }

    if (resource.size === 0) {
        throwBindingCompatibilityDiagnostic(bindSet, entry, resource.subject, {
            code: 'SCRATCH_BIND_RESOURCE_RANGE_INVALID',
            expected: { size: 'positive byte length' },
            actual: { size: resource.size },
        })
    }
    if (resource.size < entry.minBindingSize) {
        throwBindingCompatibilityDiagnostic(bindSet, entry, resource.subject, {
            code: 'SCRATCH_BIND_MIN_BINDING_SIZE_UNSATISFIED',
            expected: { minBindingSize: entry.minBindingSize },
            actual: { size: resource.size },
        })
    }

    const uniform = entry.type === 'uniform'
    const alignment = uniform
        ? bindSet.runtime.deviceLimits.minUniformBufferOffsetAlignment
        : bindSet.runtime.deviceLimits.minStorageBufferOffsetAlignment
    const maximumSize = uniform
        ? bindSet.runtime.deviceLimits.maxUniformBufferBindingSize
        : bindSet.runtime.deviceLimits.maxStorageBufferBindingSize
    if (resource.offset % alignment !== 0) {
        throwBindingCompatibilityDiagnostic(bindSet, entry, resource.subject, {
            code: 'SCRATCH_BIND_RESOURCE_OFFSET_UNALIGNED',
            expected: { offsetAlignment: alignment },
            actual: { offset: resource.offset },
        })
    }
    if (resource.size > maximumSize) {
        throwBindingCompatibilityDiagnostic(bindSet, entry, resource.subject, {
            code: 'SCRATCH_BIND_RESOURCE_SIZE_LIMIT_EXCEEDED',
            expected: { maximumSize },
            actual: { size: resource.size },
        })
    }
    if (!uniform && resource.size % 4 !== 0) {
        throwBindingCompatibilityDiagnostic(bindSet, entry, resource.subject, {
            code: 'SCRATCH_BIND_RESOURCE_RANGE_INVALID',
            expected: { sizeMultiple: 4 },
            actual: { size: resource.size },
        })
    }
}

function validateTextureResource(
    bindSet: BindSet,
    entry: NormalizedTextureBindLayoutEntry | NormalizedStorageTextureBindLayoutEntry,
    resource: unknown
) {

    if (isSurfaceTextureLease(resource) || isSurfaceTextureView(resource)) {
        validateSurfaceTextureBindingResource(bindSet, entry, resource)
        return
    }
    if (!isTextureResource(resource) && !isTextureViewSpec(resource)) {
        throwScratchDiagnostic({
            code: 'SCRATCH_BIND_RESOURCE_TYPE_MISMATCH',
            severity: 'error',
            phase: 'binding',
            subject: bindSet.layout.entrySubject(entry),
            related: [ bindSet.subject ],
            message: 'BindSet texture entries require managed texture or texture-view bindings.',
            expected: { type: [ 'TextureResource', 'TextureViewSpec' ] },
            actual: { resource: describeValue(resource) },
        })
    }

    const view = isTextureResource(resource) ? resource.view() : resource
    const subject = resource.subject
    view.texture.assertRuntime(bindSet.runtime)
    view.assertUsable()

    const descriptor = prepareTextureViewSpecDescriptor(view, true)
    const requiredUsage = entry.type === 'texture'
        ? TEXTURE_USAGE_TEXTURE_BINDING
        : TEXTURE_USAGE_STORAGE_BINDING
    if ((descriptor.usage & requiredUsage) === 0) {
        throwScratchDiagnostic({
            code: 'SCRATCH_BIND_RESOURCE_USAGE_MISSING',
            severity: 'error',
            phase: 'binding',
            subject,
            related: [ bindSet.layout.entrySubject(entry), bindSet.subject ],
            message: 'Texture binding requires a texture created with compatible usage.',
            expected: {
                usage: entry.type === 'texture'
                    ? 'GPUTextureUsage.TEXTURE_BINDING'
                    : 'GPUTextureUsage.STORAGE_BINDING',
            },
            actual: {
                usage: descriptor.usage,
                textureUsage: view.texture.usage,
            },
        })
    }

    if (descriptor.dimension !== entry.viewDimension) {
        throwBindingCompatibilityDiagnostic(bindSet, entry, subject, {
            expected: { viewDimension: entry.viewDimension },
            actual: { viewDimension: descriptor.dimension },
        })
    }
    if (!bindSet.runtime.deviceFeatures.has('core-features-and-limits')) {
        const arrayLayerCount = view.texture.dimension === '2d'
            ? view.texture.depthOrArrayLayers
            : 1
        if (descriptor.baseArrayLayer !== 0 || descriptor.arrayLayerCount !== arrayLayerCount) {
            throwBindingCompatibilityDiagnostic(bindSet, entry, subject, {
                code: 'SCRATCH_BIND_TEXTURE_COMPATIBILITY_MODE_MISMATCH',
                expected: { baseArrayLayer: 0, arrayLayerCount },
                actual: {
                    baseArrayLayer: descriptor.baseArrayLayer,
                    arrayLayerCount: descriptor.arrayLayerCount,
                },
            })
        }
    }

    if (entry.type === 'texture') {
        const multisampled = view.texture.sampleCount > 1
        if (multisampled !== entry.multisampled) {
            throwBindingCompatibilityDiagnostic(bindSet, entry, subject, {
                expected: { multisampled: entry.multisampled },
                actual: {
                    multisampled,
                    sampleCount: view.texture.sampleCount,
                },
            })
        }
        if (!textureSampleTypeCompatible(bindSet.runtime, view, entry.sampleType)) {
            throwBindingCompatibilityDiagnostic(bindSet, entry, subject, {
                code: 'SCRATCH_BIND_TEXTURE_SAMPLE_TYPE_MISMATCH',
                expected: { sampleType: entry.sampleType },
                actual: {
                    format: descriptor.format,
                    aspect: descriptor.aspect,
                    compatibleSampleTypes: textureViewSampleTypes(bindSet.runtime, view),
                },
            })
        }
        return
    }

    if (
        descriptor.format !== entry.format ||
        descriptor.mipLevelCount !== 1 ||
        descriptor.swizzle !== 'rgba' ||
        view.texture.sampleCount !== 1
    ) {
        throwBindingCompatibilityDiagnostic(bindSet, entry, subject, {
            code: 'SCRATCH_BIND_STORAGE_TEXTURE_VIEW_MISMATCH',
            expected: {
                format: entry.format,
                mipLevelCount: 1,
                swizzle: 'rgba',
                sampleCount: 1,
            },
            actual: {
                format: descriptor.format,
                mipLevelCount: descriptor.mipLevelCount,
                swizzle: descriptor.swizzle,
                sampleCount: view.texture.sampleCount,
            },
        })
    }
}

function validateSurfaceTextureBindingResource(
    bindSet: BindSet,
    entry: NormalizedTextureBindLayoutEntry | NormalizedStorageTextureBindLayoutEntry,
    resource: SurfaceTextureLease | SurfaceTextureView
): void {

    const view = isSurfaceTextureView(resource)
        ? surfaceTextureViewFacts(resource)
        : undefined
    const lease = surfaceTextureLeaseFacts(view?.lease ?? resource as SurfaceTextureLease)
    if (lease.runtime !== bindSet.runtime) {
        throwBindingCompatibilityDiagnostic(bindSet, entry, resource.subject, {
            code: 'SCRATCH_BIND_WRONG_RUNTIME',
            expected: { runtimeId: bindSet.runtime.id },
            actual: { runtimeId: lease.runtime.id },
        })
    }
    const descriptor = view?.descriptor
    const usage = descriptor?.usage ?? lease.surfaceFacts.usage
    const requiredUsage = entry.type === 'texture'
        ? TEXTURE_USAGE_TEXTURE_BINDING
        : TEXTURE_USAGE_STORAGE_BINDING
    if ((usage & requiredUsage) === 0) {
        throwBindingCompatibilityDiagnostic(bindSet, entry, resource.subject, {
            code: 'SCRATCH_BIND_RESOURCE_USAGE_MISSING',
            expected: {
                usage: entry.type === 'texture'
                    ? 'GPUTextureUsage.TEXTURE_BINDING'
                    : 'GPUTextureUsage.STORAGE_BINDING',
            },
            actual: { usage, surfaceUsage: lease.surfaceFacts.usage },
        })
    }
    const dimension = descriptor?.dimension ?? '2d'
    if (dimension !== entry.viewDimension) {
        throwBindingCompatibilityDiagnostic(bindSet, entry, resource.subject, {
            expected: { viewDimension: entry.viewDimension },
            actual: { viewDimension: dimension },
        })
    }
    const format = descriptor?.format ?? lease.surfaceFacts.format
    const aspect = descriptor?.aspect ?? 'all'
    if (entry.type === 'storage-texture') {
        const mipLevelCount = descriptor?.mipLevelCount ?? 1
        const swizzle = descriptor?.swizzle ?? 'rgba'
        if (
            format !== entry.format ||
            mipLevelCount !== 1 ||
            swizzle !== 'rgba'
        ) {
            throwBindingCompatibilityDiagnostic(bindSet, entry, resource.subject, {
                code: 'SCRATCH_BIND_STORAGE_TEXTURE_VIEW_MISMATCH',
                expected: {
                    format: entry.format,
                    mipLevelCount: 1,
                    swizzle: 'rgba',
                    sampleCount: 1,
                },
                actual: {
                    format,
                    mipLevelCount,
                    swizzle,
                    sampleCount: 1,
                },
            })
        }
        return
    }
    const compatibleSampleTypes = textureFormatSampleTypes(bindSet.runtime, format, aspect)
    if (!compatibleSampleTypes.includes(entry.sampleType)) {
        throwBindingCompatibilityDiagnostic(bindSet, entry, resource.subject, {
            code: 'SCRATCH_BIND_TEXTURE_SAMPLE_TYPE_MISMATCH',
            expected: { sampleType: entry.sampleType },
            actual: { format, aspect, compatibleSampleTypes },
        })
    }
    if (entry.multisampled) {
        throwBindingCompatibilityDiagnostic(bindSet, entry, resource.subject, {
            expected: { multisampled: false },
            actual: { multisampled: true, sampleCount: 1 },
        })
    }
}

function surfaceTextureUsageForBindingEntry(
    entry: NormalizedBindLayoutEntry
): GPUTextureUsageFlags {

    return surfaceTextureUsageForRole(
        entry.type === 'storage-texture'
            ? 'storage-binding'
            : 'sampled-binding'
    )
}

function validateExternalTextureResource(
    bindSet: BindSet,
    entry: NormalizedExternalTextureBindLayoutEntry,
    resource: unknown
): void {

    if (isExternalTextureBinding(resource)) {
        resource.assertRuntime(bindSet.runtime)
        return
    }
    if (isTextureResource(resource)) {
        resource.assertRuntime(bindSet.runtime)
        resource.assertUsable()
        const descriptor = prepareTextureViewSpecDescriptor(resource.view(), true)
        validateExternalTextureViewFacts(bindSet, entry, resource.subject, {
            usage: descriptor.usage,
            dimension: descriptor.dimension,
            mipLevelCount: descriptor.mipLevelCount,
            format: descriptor.format,
            sampleCount: resource.sampleCount,
        })
        return
    }
    if (isTextureViewSpec(resource)) {
        resource.texture.assertRuntime(bindSet.runtime)
        resource.assertUsable()
        const descriptor = prepareTextureViewSpecDescriptor(resource, true)
        validateExternalTextureViewFacts(bindSet, entry, resource.subject, {
            usage: descriptor.usage,
            dimension: descriptor.dimension,
            mipLevelCount: descriptor.mipLevelCount,
            format: descriptor.format,
            sampleCount: resource.texture.sampleCount,
        })
        return
    }
    if (isSurfaceTextureLease(resource)) {
        const lease = surfaceTextureLeaseFacts(resource)
        validateExternalSurfaceTextureFacts(
            bindSet,
            entry,
            resource.subject,
            lease
        )
        return
    }
    if (isSurfaceTextureView(resource)) {
        const view = surfaceTextureViewFacts(resource)
        const lease = surfaceTextureLeaseFacts(view.lease)
        if (lease.runtime !== bindSet.runtime) {
            throwBindingCompatibilityDiagnostic(bindSet, entry, resource.subject, {
                code: 'SCRATCH_BIND_WRONG_RUNTIME',
                expected: { runtimeId: bindSet.runtime.id },
                actual: { runtimeId: lease.runtime.id },
            })
        }
        validateExternalTextureViewFacts(bindSet, entry, resource.subject, {
            usage: view.descriptor.usage ?? lease.surfaceFacts.usage,
            dimension: view.descriptor.dimension ?? '2d',
            mipLevelCount: view.descriptor.mipLevelCount ?? 1,
            format: view.descriptor.format ?? lease.surfaceFacts.format,
            sampleCount: 1,
        })
        return
    }
    throwScratchDiagnostic({
        code: 'SCRATCH_BIND_RESOURCE_TYPE_MISMATCH',
        severity: 'error',
        phase: 'binding',
        subject: bindSet.layout.entrySubject(entry),
        related: [ bindSet.subject ],
        message: 'External texture entry requires a managed external or texture binding.',
        expected: {
            type: [
                'ExternalTextureBinding',
                'TextureResource',
                'TextureViewSpec',
                'SurfaceTextureLease',
                'SurfaceTextureView',
            ],
        },
        actual: { resource: describeValue(resource) },
    })
}

function validateExternalSurfaceTextureFacts(
    bindSet: BindSet,
    entry: NormalizedExternalTextureBindLayoutEntry,
    subject: DiagnosticSubject,
    lease: ReturnType<typeof surfaceTextureLeaseFacts>
): void {

    if (lease.runtime !== bindSet.runtime) {
        throwBindingCompatibilityDiagnostic(bindSet, entry, subject, {
            code: 'SCRATCH_BIND_WRONG_RUNTIME',
            expected: { runtimeId: bindSet.runtime.id },
            actual: { runtimeId: lease.runtime.id },
        })
    }
    validateExternalTextureViewFacts(bindSet, entry, subject, {
        usage: lease.surfaceFacts.usage,
        dimension: '2d',
        mipLevelCount: 1,
        format: lease.surfaceFacts.format,
        sampleCount: 1,
    })
}

function validateExternalTextureViewFacts(
    bindSet: BindSet,
    entry: NormalizedExternalTextureBindLayoutEntry,
    subject: DiagnosticSubject,
    facts: Readonly<{
        usage: GPUTextureUsageFlags
        dimension: GPUTextureViewDimension
        mipLevelCount: number
        format: GPUTextureFormat
        sampleCount: number
    }>
): void {

    if ((facts.usage & TEXTURE_USAGE_TEXTURE_BINDING) === 0) {
        throwBindingCompatibilityDiagnostic(bindSet, entry, subject, {
            code: 'SCRATCH_BIND_RESOURCE_USAGE_MISSING',
            expected: { usage: 'GPUTextureUsage.TEXTURE_BINDING' },
            actual: { usage: facts.usage },
        })
    }
    if (
        facts.dimension !== '2d' ||
        facts.mipLevelCount !== 1 ||
        !EXTERNAL_TEXTURE_FORMATS.has(facts.format) ||
        facts.sampleCount !== 1
    ) {
        throwBindingCompatibilityDiagnostic(bindSet, entry, subject, {
            code: 'SCRATCH_BIND_EXTERNAL_TEXTURE_VIEW_MISMATCH',
            expected: {
                dimension: '2d',
                mipLevelCount: 1,
                format: [ ...EXTERNAL_TEXTURE_FORMATS ],
                sampleCount: 1,
            },
            actual: facts,
        })
    }
}

function validateSamplerResource(
    bindSet: BindSet,
    entry: NormalizedSamplerBindLayoutEntry,
    resource: unknown
) {

    if (!isSamplerResource(resource)) {
        throwScratchDiagnostic({
            code: 'SCRATCH_BIND_RESOURCE_TYPE_MISMATCH',
            severity: 'error',
            phase: 'binding',
            subject: bindSet.layout.entrySubject(entry),
            related: [ bindSet.subject ],
            message: 'BindSet sampler entries require SamplerResource bindings.',
            expected: { type: 'SamplerResource' },
            actual: { resource: describeValue(resource) },
        })
    }

    resource.assertRuntime(bindSet.runtime)
    const descriptor = resource.descriptor as Readonly<{
        magFilter?: GPUFilterMode
        minFilter?: GPUFilterMode
        mipmapFilter?: GPUMipmapFilterMode
        compare?: GPUCompareFunction
    }>
    const isComparison = descriptor.compare !== undefined
    const isFiltering = descriptor.magFilter === 'linear' ||
        descriptor.minFilter === 'linear' ||
        descriptor.mipmapFilter === 'linear'
    const compatible = entry.samplerType === 'comparison'
        ? isComparison
        : entry.samplerType === 'non-filtering'
            ? !isComparison && !isFiltering
            : !isComparison
    if (!compatible) {
        throwBindingCompatibilityDiagnostic(bindSet, entry, resource.subject, {
            code: 'SCRATCH_BIND_SAMPLER_TYPE_MISMATCH',
            expected: { samplerType: entry.samplerType },
            actual: { isComparison, isFiltering },
        })
    }
}

function textureSampleTypeCompatible(
    runtime: ScratchRuntime,
    view: TextureViewSpec,
    sampleType: GPUTextureSampleType
): boolean {

    return textureViewSampleTypes(runtime, view).includes(sampleType)
}

function textureViewSampleTypes(
    runtime: ScratchRuntime,
    view: TextureViewSpec
): GPUTextureSampleType[] {

    return textureFormatSampleTypes(runtime, view.descriptor.format, view.descriptor.aspect)
}

function textureFormatSampleTypes(
    runtime: ScratchRuntime,
    format: GPUTextureFormat,
    aspect: GPUTextureAspect
): GPUTextureSampleType[] {

    if (
        aspect === 'stencil-only' ||
        (format === 'stencil8' && aspect === 'all')
    ) return [ 'uint' ]
    if (DEPTH_TEXTURE_FORMATS.has(format)) return [ 'depth', 'unfilterable-float' ]
    if (UINT_TEXTURE_FORMATS.has(format)) return [ 'uint' ]
    if (SINT_TEXTURE_FORMATS.has(format)) return [ 'sint' ]

    const packedOrCompressed = format === 'rgb9e5ufloat' ||
        /^(bc\d|etc2-|eac-|astc-)/.test(format)
    const filterable = FILTERABLE_FLOAT_TEXTURE_FORMATS.has(format) ||
        packedOrCompressed ||
        (FLOAT32_TEXTURE_FORMATS.has(format) && runtime.deviceFeatures.has('float32-filterable'))
    const unfilterable = UNFILTERABLE_FLOAT_TEXTURE_FORMATS.has(format) || packedOrCompressed
    return [
        ...(filterable ? [ 'float' as const ] : []),
        ...(unfilterable ? [ 'unfilterable-float' as const ] : []),
    ]
}

function throwBindingCompatibilityDiagnostic(
    bindSet: BindSet,
    entry: NormalizedBindLayoutEntry,
    resourceSubject: DiagnosticSubject,
    input: Readonly<{
        code?: string
        expected: unknown
        actual: unknown
    }>
): never {

    throwScratchDiagnostic({
        code: input.code ?? 'SCRATCH_BIND_RESOURCE_TYPE_MISMATCH',
        severity: 'error',
        phase: 'binding',
        subject: bindSet.layout.entrySubject(entry),
        related: [ bindSet.subject, resourceSubject ],
        message: 'BindSet resource is incompatible with its BindLayout entry.',
        expected: input.expected,
        actual: input.actual,
    })
}

function lowerBindLayoutEntry(entry: NormalizedBindLayoutEntry): GPUBindGroupLayoutEntry {

    const lowered: GPUBindGroupLayoutEntry = {
        binding: entry.binding,
        visibility: entry.visibility.reduce((flags, stage) => flags | SHADER_STAGE_FLAGS[stage], 0),
    }

    if (isBufferBindLayoutEntry(entry)) {
        const buffer: GPUBufferBindingLayout = {
            type: WEBGPU_BUFFER_BINDING_TYPES[entry.type],
            hasDynamicOffset: entry.hasDynamicOffset,
            minBindingSize: entry.minBindingSize,
        }
        lowered.buffer = buffer
        return lowered
    }

    if (entry.type === 'texture') {
        const texture: GPUTextureBindingLayout = {
            sampleType: entry.sampleType,
            viewDimension: entry.viewDimension,
            multisampled: entry.multisampled,
        }
        lowered.texture = texture
        return lowered
    }

    if (entry.type === 'storage-texture') {
        lowered.storageTexture = {
            access: entry.access,
            format: entry.format,
            viewDimension: entry.viewDimension,
        }
        return lowered
    }

    if (entry.type === 'sampler') {
        lowered.sampler = { type: entry.samplerType }
        return lowered
    }

    if (entry.type === 'external-texture') {
        lowered.externalTexture = {}
        return lowered
    }

    return lowered
}

function bindLayoutSubject(id: string, label?: string): DiagnosticSubject {

    return {
        kind: 'BindLayout',
        id,
        ...(label !== undefined ? { label } : {}),
    }
}

function bindLayoutEntrySubject(
    group: number,
    entry: unknown
): DiagnosticSubject {

    const record = isRecord(entry) ? entry : {}
    return {
        kind: 'BindLayoutEntry',
        group,
        ...(typeof record.binding === 'number' ? { binding: record.binding } : {}),
        ...(typeof record.name === 'string' ? { name: record.name } : {}),
    }
}

function throwBindLayoutDescriptorDiagnostic(
    subject: DiagnosticSubject,
    actual: unknown,
    expected: unknown
): never {

    throwScratchDiagnostic({
        code: 'SCRATCH_BIND_LAYOUT_DESCRIPTOR_INVALID',
        severity: 'error',
        phase: 'binding',
        subject,
        message: 'BindLayout requires a valid explicit group and entry descriptor.',
        expected,
        actual,
    })
}

function normalizeStorageTextureAccess(
    layout: BindLayoutDiagnosticContext,
    entry: StorageTextureBindLayoutEntry
): GPUStorageTextureAccess {

    const access = entry.access ?? 'write-only'
    if (!STORAGE_TEXTURE_ACCESS.has(access)) {
        throwBindEntryDiagnostic(layout, entry)
    }
    return access
}

function normalizeStorageTextureFormat(
    runtime: ScratchRuntime,
    layout: BindLayoutDiagnosticContext,
    entry: StorageTextureBindLayoutEntry,
    access: GPUStorageTextureAccess
): GPUTextureFormat {

    if (typeof entry.format !== 'string') {
        throwBindEntryDiagnostic(layout, entry)
    }

    const capabilities = storageTextureFormatCapabilities(entry.format as GPUTextureFormat)
    const requirement = capabilities?.[access]
    if (requirement === undefined || !runtimeSupportsTextureFormatRequirement(runtime, requirement)) {
        throwScratchDiagnostic({
            code: 'SCRATCH_BIND_STORAGE_TEXTURE_FORMAT_UNSUPPORTED',
            severity: 'error',
            phase: 'binding',
            subject: layout.entrySubject(entry),
            related: [ layout.subject ],
            message: 'Storage-texture format and access must be supported by the runtime device.',
            expected: {
                format: entry.format,
                access,
                ...(requirement !== undefined ? { feature: requirement } : {}),
            },
            actual: {
                features: Array.from(runtime.deviceFeatures),
                supportedAccesses: capabilities === undefined
                    ? []
                    : Object.keys(capabilities),
            },
        })
    }

    return entry.format as GPUTextureFormat
}

function normalizeStorageTextureViewDimension(
    layout: BindLayoutDiagnosticContext,
    entry: StorageTextureBindLayoutEntry
): GPUTextureViewDimension {

    const viewDimension = entry.viewDimension ?? '2d'
    if (!STORAGE_TEXTURE_VIEW_DIMENSIONS.has(viewDimension)) {
        throwBindEntryDiagnostic(layout, entry)
    }
    return viewDimension
}

function normalizeMinBindingSize(
    layout: BindLayoutDiagnosticContext,
    entry: BufferBindLayoutEntry
): number {

    const minBindingSize = entry.minBindingSize ?? 0
    if (
        typeof minBindingSize !== 'number' ||
        !Number.isSafeInteger(minBindingSize) ||
        minBindingSize < 0
    ) {
        throwScratchDiagnostic({
            code: 'SCRATCH_BIND_MIN_BINDING_SIZE_INVALID',
            severity: 'error',
            phase: 'binding',
            subject: layout.entrySubject(entry),
            related: [ layout.subject ],
            message: 'Buffer minBindingSize must be a non-negative safe integer byte count.',
            expected: { minBindingSize: 'safe integer >= 0' },
            actual: { minBindingSize },
        })
    }
    return minBindingSize
}

function validateBindingLimits(
    runtime: ScratchRuntime,
    layout: BindLayoutDiagnosticContext,
    entries: readonly NormalizedBindLayoutEntry[]
): void {

    const violation = firstBindingLimitViolation(runtime, entries)
    if (violation === undefined) return
    throwScratchDiagnostic({
        code: 'SCRATCH_BIND_LAYOUT_LIMIT_EXCEEDED',
        severity: 'error',
        phase: 'binding',
        subject: layout.subject,
        message: 'BindLayout entries exceed a device binding-slot limit.',
        expected: {
            limit: violation.limit,
            maximum: violation.maximum,
            ...(violation.stage !== undefined ? { stage: violation.stage } : {}),
        },
        actual: {
            count: violation.actual,
            ...(violation.stage !== undefined ? { stage: violation.stage } : {}),
        },
    })
}

export function firstBindingLimitViolation(
    runtime: ScratchRuntime,
    entries: readonly NormalizedBindLayoutEntry[]
): BindingLimitViolation | undefined {

    const checks: BindingLimitViolation[] = [
        {
            limit: 'maxDynamicUniformBuffersPerPipelineLayout',
            maximum: runtime.deviceLimits.maxDynamicUniformBuffersPerPipelineLayout,
            actual: entries.filter(entry =>
                entry.type === 'uniform' && entry.hasDynamicOffset
            ).length,
        },
        {
            limit: 'maxDynamicStorageBuffersPerPipelineLayout',
            maximum: runtime.deviceLimits.maxDynamicStorageBuffersPerPipelineLayout,
            actual: entries.filter(entry =>
                (entry.type === 'read-storage' || entry.type === 'storage') && entry.hasDynamicOffset
            ).length,
        },
    ]

    for (const stage of [ 'vertex', 'fragment', 'compute' ] as const) {
        const visible = entries.filter(entry => entry.visibility.includes(stage))
        const externalTextures = visible.filter(entry => entry.type === 'external-texture').length
        checks.push(
            {
                limit: 'maxUniformBuffersPerShaderStage',
                maximum: runtime.deviceLimits.maxUniformBuffersPerShaderStage,
                actual: visible.filter(entry => entry.type === 'uniform').length + externalTextures,
                stage,
            },
            {
                limit: 'maxSamplersPerShaderStage',
                maximum: runtime.deviceLimits.maxSamplersPerShaderStage,
                actual: visible.filter(entry => entry.type === 'sampler').length + externalTextures,
                stage,
            },
            {
                limit: 'maxSampledTexturesPerShaderStage',
                maximum: runtime.deviceLimits.maxSampledTexturesPerShaderStage,
                actual: visible.filter(entry => entry.type === 'texture').length + externalTextures * 4,
                stage,
            },
            {
                limit: storageBufferLimitName(stage),
                maximum: storageBufferLimit(runtime, stage),
                actual: visible.filter(entry =>
                    entry.type === 'read-storage' || entry.type === 'storage'
                ).length,
                stage,
            },
            {
                limit: storageTextureLimitName(stage),
                maximum: storageTextureLimit(runtime, stage),
                actual: visible.filter(entry => entry.type === 'storage-texture').length,
                stage,
            }
        )
    }

    return checks.find(check => check.actual > check.maximum)
}

function storageBufferLimit(runtime: ScratchRuntime, stage: BindVisibility): number {

    const limits = runtime.deviceLimits as ScratchBindingSupportedLimits
    if (stage === 'vertex') {
        return limits.maxStorageBuffersInVertexStage ?? limits.maxStorageBuffersPerShaderStage
    }
    if (stage === 'fragment') {
        return limits.maxStorageBuffersInFragmentStage ?? limits.maxStorageBuffersPerShaderStage
    }
    return runtime.deviceLimits.maxStorageBuffersPerShaderStage
}

function storageBufferLimitName(stage: BindVisibility): string {

    if (stage === 'vertex') return 'maxStorageBuffersInVertexStage'
    if (stage === 'fragment') return 'maxStorageBuffersInFragmentStage'
    return 'maxStorageBuffersPerShaderStage'
}

function storageTextureLimit(runtime: ScratchRuntime, stage: BindVisibility): number {

    const limits = runtime.deviceLimits as ScratchBindingSupportedLimits
    if (stage === 'vertex') {
        return limits.maxStorageTexturesInVertexStage ?? limits.maxStorageTexturesPerShaderStage
    }
    if (stage === 'fragment') {
        return limits.maxStorageTexturesInFragmentStage ?? limits.maxStorageTexturesPerShaderStage
    }
    return runtime.deviceLimits.maxStorageTexturesPerShaderStage
}

function storageTextureLimitName(stage: BindVisibility): string {

    if (stage === 'vertex') return 'maxStorageTexturesInVertexStage'
    if (stage === 'fragment') return 'maxStorageTexturesInFragmentStage'
    return 'maxStorageTexturesPerShaderStage'
}

function normalizeTextureSampleType(
    layout: BindLayoutDiagnosticContext,
    entry: TextureBindLayoutEntry
): GPUTextureSampleType {

    const sampleType = entry.sampleType ?? 'float'
    if (!TEXTURE_SAMPLE_TYPES.has(sampleType)) {
        throwBindEntryDiagnostic(layout, entry)
    }

    return sampleType
}

function normalizeTextureViewDimension(
    layout: BindLayoutDiagnosticContext,
    entry: TextureBindLayoutEntry
): GPUTextureViewDimension {

    const viewDimension = entry.viewDimension ?? '2d'
    if (!TEXTURE_VIEW_DIMENSIONS.has(viewDimension)) {
        throwBindEntryDiagnostic(layout, entry)
    }

    return viewDimension
}

function normalizeTextureMultisampled(
    layout: BindLayoutDiagnosticContext,
    entry: TextureBindLayoutEntry
): boolean {

    const multisampled = entry.multisampled ?? false
    if (typeof multisampled !== 'boolean') {
        throwBindEntryDiagnostic(layout, entry)
    }

    return multisampled
}

function normalizeSamplerBindingType(
    layout: BindLayoutDiagnosticContext,
    entry: SamplerBindLayoutEntry
): GPUSamplerBindingType {

    const samplerType = entry.samplerType ?? 'filtering'
    if (!SAMPLER_BINDING_TYPES.has(samplerType)) {
        throwBindEntryDiagnostic(layout, entry)
    }

    return samplerType
}

function normalizeDynamicOffsetFlag(
    layout: BindLayoutDiagnosticContext,
    entry: BufferBindLayoutEntry
): boolean {

    const hasDynamicOffset = (entry as EntryWithDynamicOffsetFlag).hasDynamicOffset
    if (hasDynamicOffset === undefined) return false

    if (typeof hasDynamicOffset !== 'boolean') {
        throwDynamicOffsetFlagDiagnostic(layout, entry, hasDynamicOffset, {
            hasDynamicOffset: 'boolean',
        })
    }

    return hasDynamicOffset
}

function rejectDynamicOffsetFlag(
    layout: BindLayoutDiagnosticContext,
    entry:
        | TextureBindLayoutEntry
        | StorageTextureBindLayoutEntry
        | SamplerBindLayoutEntry
        | ExternalTextureBindLayoutEntry
): void {

    const hasDynamicOffset = (entry as EntryWithDynamicOffsetFlag).hasDynamicOffset
    if (hasDynamicOffset === undefined) return

    throwDynamicOffsetFlagDiagnostic(layout, entry, hasDynamicOffset, {
        hasDynamicOffset: 'only supported for uniform, read-storage, and storage entries',
    })
}

function throwDynamicOffsetFlagDiagnostic(
    layout: BindLayoutDiagnosticContext,
    entry: BindLayoutEntry,
    hasDynamicOffset: unknown,
    expected: unknown
): never {

    throwScratchDiagnostic({
        code: 'SCRATCH_BIND_DYNAMIC_OFFSET_INVALID',
        severity: 'error',
        phase: 'binding',
        subject: layout.entrySubject(entry),
        related: [ layout.subject ],
        message: 'BindLayout entry dynamic offset flag is invalid.',
        expected,
        actual: {
            type: entry.type,
            hasDynamicOffset,
        },
    })
}

function throwBindEntryDiagnostic(layout: BindLayoutDiagnosticContext, entry: unknown): never {

    throwScratchDiagnostic({
        code: 'SCRATCH_BIND_REQUIRED_ENTRY_MISSING',
        severity: 'error',
        phase: 'binding',
        subject: layout.subject,
        message: 'BindLayout entry must declare a supported resource binding with name, binding, and visibility.',
        expected: {
            entry: {
                name: 'string',
                binding: 'non-negative integer',
                type: [
                    'uniform',
                    'read-storage',
                    'storage',
                    'texture',
                    'storage-texture',
                    'sampler',
                    'external-texture',
                ],
                visibility: [ 'vertex', 'fragment', 'compute' ],
            },
        },
        actual: { entry },
    })
}

function isBufferBindLayoutEntry(entry: BindLayoutEntry): entry is BufferBindLayoutEntry
function isBufferBindLayoutEntry(
    entry: NormalizedBindLayoutEntry
): entry is NormalizedBufferBindLayoutEntry
function isBufferBindLayoutEntry(
    entry: BindLayoutEntry | NormalizedBindLayoutEntry
): boolean {

    return isBufferBindingType(entry.type)
}

function isBufferBindingType(type: unknown): type is BufferBindingType {

    return typeof type === 'string' && BUFFER_BINDING_TYPES.has(type as BufferBindingType)
}

Object.freeze(BindLayout.prototype)
Object.freeze(BindSet.prototype)
