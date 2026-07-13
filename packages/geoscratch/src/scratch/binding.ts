import { UUID } from '../core/utils/uuid.js'
import {
    registerBindLayoutOwnership,
    unregisterBindLayoutOwnership,
} from './binding-ownership.js'
import { BufferRegion, isBufferRegion } from './buffer.js'
import { throwScratchDiagnostic } from './diagnostics.js'
import { createScratchNativeLabel } from './native-allocation.js'
import { diagnosticsControllerFor } from './runtime-diagnostics.js'
import { SamplerResource } from './sampler.js'
import { throwSupportingObjectCreationFailure } from './supporting-object-failure.js'
import {
    issueSupportingObjectCreation,
    recheckSupportingObjectLifecycle,
} from './supporting-object-creation.js'
import { TextureViewSpec, createNativeTextureView, isTextureViewSpec, prepareTextureViewSpecDescriptor } from './texture.js'
import { describeValue, getGlobalConstant, isRecord } from './type-utils.js'
import { readonlyMapSnapshot } from './readonly-map.js'
import type { DiagnosticSubject } from './diagnostics.js'
import type { ScratchRuntime } from './runtime.js'

const SHADER_STAGE_FLAGS = {
    vertex: 0x1,
    fragment: 0x2,
    compute: 0x4,
}

const BUFFER_USAGE_UNIFORM = 0x40
const BUFFER_USAGE_STORAGE = 0x80
const TEXTURE_USAGE_TEXTURE_BINDING = getGlobalConstant('GPUTextureUsage', 'TEXTURE_BINDING', 0x4)

const BUFFER_BINDING_TYPES = new Set<BufferBindingType>([ 'uniform', 'read-storage', 'storage' ])
const TEXTURE_SAMPLE_TYPES = new Set<GPUTextureSampleType>([ 'float', 'unfilterable-float', 'depth', 'sint', 'uint' ])
const TEXTURE_VIEW_DIMENSIONS = new Set<GPUTextureViewDimension>([ '1d', '2d', '2d-array', 'cube', 'cube-array', '3d' ])
const SAMPLER_BINDING_TYPES = new Set<GPUSamplerBindingType>([ 'filtering', 'non-filtering', 'comparison' ])
const STORAGE_TEXTURE_ACCESS = new Set<GPUStorageTextureAccess>([ 'write-only', 'read-only', 'read-write' ])
const STORAGE_TEXTURE_VIEW_DIMENSIONS = new Set<GPUTextureViewDimension>([ '1d', '2d', '2d-array', '3d' ])
type StorageTextureFeatureRequirement =
    | 'base'
    | 'bgra8unorm-storage'
    | 'core-features-and-limits'
    | 'texture-formats-tier1'
    | 'texture-formats-tier2'

type StorageTextureFormatCapabilities = Readonly<Partial<
    Record<GPUStorageTextureAccess, StorageTextureFeatureRequirement>
>>

const BASE_STORAGE_TEXTURE_FORMATS = [
    'rgba8unorm',
    'rgba8snorm',
    'rgba8uint',
    'rgba8sint',
    'rgba16uint',
    'rgba16sint',
    'rgba16float',
    'r32uint',
    'r32sint',
    'r32float',
    'rgba32uint',
    'rgba32sint',
    'rgba32float',
] as const satisfies readonly GPUTextureFormat[]

const TIER_1_STORAGE_TEXTURE_FORMATS = [
    'r8unorm',
    'r8snorm',
    'r8uint',
    'r8sint',
    'rg8unorm',
    'rg8snorm',
    'rg8uint',
    'rg8sint',
    'r16unorm',
    'r16snorm',
    'r16uint',
    'r16sint',
    'r16float',
    'rg16unorm',
    'rg16snorm',
    'rg16uint',
    'rg16sint',
    'rg16float',
    'rgba16unorm',
    'rgba16snorm',
    'rgb10a2uint',
    'rgb10a2unorm',
    'rg11b10ufloat',
] as const satisfies readonly GPUTextureFormat[]

const TIER_2_READ_WRITE_STORAGE_TEXTURE_FORMATS = [
    'r8unorm',
    'r8uint',
    'r8sint',
    'rgba8unorm',
    'rgba8uint',
    'rgba8sint',
    'r16uint',
    'r16sint',
    'r16float',
    'rgba16uint',
    'rgba16sint',
    'rgba16float',
    'rgba32uint',
    'rgba32sint',
    'rgba32float',
] as const satisfies readonly GPUTextureFormat[]

const STORAGE_TEXTURE_FORMAT_CAPABILITIES = createStorageTextureFormatCapabilities()
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
const bindLayoutStates = new WeakMap<BindLayout, { isDisposed: boolean }>()
const BIND_LAYOUT_ALLOCATION_CODES = Object.freeze({
    validation: 'SCRATCH_BIND_LAYOUT_ALLOCATION_VALIDATION_FAILED',
    internal: 'SCRATCH_BIND_LAYOUT_ALLOCATION_INTERNAL_FAILED',
    outOfMemory: 'SCRATCH_BIND_LAYOUT_ALLOCATION_OUT_OF_MEMORY',
    nativeException: 'SCRATCH_BIND_LAYOUT_ALLOCATION_NATIVE_FAILED',
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

export type BindLayoutEntry =
    | UniformBindLayoutEntry
    | StorageBindLayoutEntry
    | TextureBindLayoutEntry
    | StorageTextureBindLayoutEntry
    | SamplerBindLayoutEntry

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

export type NormalizedBindLayoutEntry =
    | NormalizedUniformBindLayoutEntry
    | NormalizedStorageBindLayoutEntry
    | NormalizedTextureBindLayoutEntry
    | NormalizedStorageTextureBindLayoutEntry
    | NormalizedSamplerBindLayoutEntry

type BufferBindingType = UniformBindLayoutEntry['type'] | StorageBindLayoutEntry['type']
type BufferBindLayoutEntry = UniformBindLayoutEntry | StorageBindLayoutEntry
type NormalizedBufferBindLayoutEntry = NormalizedUniformBindLayoutEntry | NormalizedStorageBindLayoutEntry
type EntryWithDynamicOffsetFlag = BindLayoutEntry & { hasDynamicOffset?: unknown }

export type BindLayoutDescriptor = {
    label?: string
    group: number
    entries: readonly BindLayoutEntry[]
}

export type BindSetBindings = Record<string, BufferRegion | TextureViewSpec | SamplerResource>

export type BindSetOptions = {
    label?: string
}

type NormalizedBindSetBinding = {
    readonly entry: NormalizedBindLayoutEntry
    readonly resource: BufferRegion | TextureViewSpec | SamplerResource
}

type ScratchBindingSupportedLimits = GPUSupportedLimits & Readonly<{
    maxStorageBuffersInVertexStage?: number
    maxStorageBuffersInFragmentStage?: number
    maxStorageTexturesInVertexStage?: number
    maxStorageTexturesInFragmentStage?: number
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

        this.runtime.assertActive()
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

    runtime.assertActive()
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
    runtime: ScratchRuntime
    id: string
    label?: string
    layout: BindLayout
    readonly bindings: ReadonlyMap<string, NormalizedBindSetBinding>
    gpuBindGroup?: GPUBindGroup
    boundAllocationVersions: Map<string, number>
    isDisposed: boolean
}

export class BindSet {

    constructor(runtime: ScratchRuntime, layout: BindLayout, bindings: BindSetBindings, options: BindSetOptions = {}) {

        runtime.assertActive()

        if (!layout || typeof layout.assertRuntime !== 'function') {
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

        this.runtime = runtime
        this.id = `scratch-bind-set-${UUID()}`
        this.layout = layout
        const normalizedBindings = lockNormalizedBindings(normalizeBindings(this, bindings))
        Object.defineProperty(this, 'bindings', {
            value: normalizedBindings,
            enumerable: true,
            configurable: false,
            writable: false,
        })
        this.isDisposed = false
        if (options.label !== undefined) this.label = options.label
        this.boundAllocationVersions = new Map()
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

        this.runtime.assertActive()
        this.layout.assertUsable()
        for (const binding of this.bindings.values()) {
            validateBindingResource(this, binding.entry, binding.resource)
        }
    }

    getBindGroup(): GPUBindGroup {

        this.assertUsable()

        if (!this.gpuBindGroup || this.hasStaleAllocationVersions()) {
            const descriptor: GPUBindGroupDescriptor = {
                layout: this.layout.gpuBindGroupLayout,
                entries: this.layout.entries.map((entry) => {
                    const binding = this.bindings.get(entry.name)

                    return {
                        binding: entry.binding,
                        resource: createBindingResource(binding!),
                    }
                }),
            }
            if (this.label !== undefined) descriptor.label = this.label

            this.gpuBindGroup = this.runtime.device.createBindGroup(descriptor)
            this.boundAllocationVersions = new Map(
                [ ...this.bindings.values() ].map(binding => [
                    bindingResourceId(binding.resource),
                    bindingAllocationVersion(binding.resource),
                ])
            )
        }

        return this.gpuBindGroup
    }

    hasStaleAllocationVersions(): boolean {

        for (const binding of this.bindings.values()) {
            if (
                this.boundAllocationVersions.get(bindingResourceId(binding.resource)) !==
                bindingAllocationVersion(binding.resource)
            ) {
                return true
            }
        }

        return false
    }

    dispose(): void {

        this.isDisposed = true
    }
}

function lockNormalizedBindings(
    bindings: Map<string, NormalizedBindSetBinding>
): ReadonlyMap<string, NormalizedBindSetBinding> {

    for (const binding of bindings.values()) Object.freeze(binding)
    return readonlyMapSnapshot(bindings)
}

function bindingResourceId(resource: BufferRegion | TextureViewSpec | SamplerResource): string {

    if (isBufferRegion(resource)) return resource.buffer.id
    if (isTextureViewSpec(resource)) return resource.texture.id
    return resource.id
}

function bindingAllocationVersion(resource: BufferRegion | TextureViewSpec | SamplerResource): number {

    if (isBufferRegion(resource)) return resource.buffer.allocationVersion
    if (isTextureViewSpec(resource)) return resource.texture.allocationVersion
    return resource.allocationVersion
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
        (isBufferBindingType(type) || type === 'texture' || type === 'storage-texture' || type === 'sampler')
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

        validateBindingResource(bindSet, entry, resource)
        normalized.set(entry.name, { entry, resource })
    }

    return normalized
}

function validateBindingResource(bindSet: BindSet, entry: NormalizedBindLayoutEntry, resource: unknown) {

    if (isBufferBindLayoutEntry(entry)) {
        validateBufferResource(bindSet, entry, resource)
        return
    }

    if (entry.type === 'texture') {
        validateTextureResource(bindSet, entry, resource)
        return
    }

    if (entry.type === 'storage-texture') {
        throwScratchDiagnostic({
            code: 'SCRATCH_BIND_RESOURCE_TYPE_MISMATCH',
            severity: 'error',
            phase: 'binding',
            subject: bindSet.layout.entrySubject(entry),
            related: [ bindSet.subject ],
            message: 'Storage-texture BindSet preparation is not yet available.',
            expected: { preparation: 'Phase 5 storage-texture binding support' },
            actual: { type: entry.type },
        })
    }

    if (entry.type === 'sampler') {
        validateSamplerResource(bindSet, entry, resource)
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
}

function validateTextureResource(
    bindSet: BindSet,
    entry: NormalizedTextureBindLayoutEntry,
    resource: unknown
) {

    if (!isTextureViewSpec(resource)) {
        throwScratchDiagnostic({
            code: 'SCRATCH_BIND_RESOURCE_TYPE_MISMATCH',
            severity: 'error',
            phase: 'binding',
            subject: bindSet.layout.entrySubject(entry),
            related: [ bindSet.subject ],
            message: 'BindSet texture entries require TextureViewSpec bindings.',
            expected: { type: 'TextureViewSpec' },
            actual: { resource: describeValue(resource) },
        })
    }

    resource.texture.assertRuntime(bindSet.runtime)
    resource.assertUsable()

    if ((resource.texture.usage & TEXTURE_USAGE_TEXTURE_BINDING) === 0) {
        throwScratchDiagnostic({
            code: 'SCRATCH_BIND_RESOURCE_USAGE_MISSING',
            severity: 'error',
            phase: 'binding',
            subject: resource.subject,
            related: [ bindSet.layout.entrySubject(entry), bindSet.subject ],
            message: 'Texture binding requires a texture created with compatible usage.',
            expected: { usage: 'GPUTextureUsage.TEXTURE_BINDING' },
            actual: { usage: resource.texture.usage },
        })
    }

    const descriptor = prepareTextureViewSpecDescriptor(resource, true)
    if (descriptor.dimension !== (entry.viewDimension ?? '2d')) {
        throwScratchDiagnostic({
            code: 'SCRATCH_BIND_RESOURCE_TYPE_MISMATCH',
            severity: 'error',
            phase: 'binding',
            subject: bindSet.layout.entrySubject(entry),
            related: [ bindSet.subject, resource.subject ],
            message: 'TextureViewSpec dimension must match its BindLayout entry.',
            expected: { viewDimension: entry.viewDimension ?? '2d' },
            actual: { viewDimension: descriptor.dimension },
        })
    }
}

function validateSamplerResource(
    bindSet: BindSet,
    entry: NormalizedSamplerBindLayoutEntry,
    resource: unknown
) {

    if (!(resource instanceof SamplerResource)) {
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

    return lowered
}

function createBindingResource(binding: NormalizedBindSetBinding): GPUBindingResource {

    const resource = binding.resource

    if (isBufferRegion(resource)) {
        return {
            buffer: resource.buffer.gpuBuffer,
            offset: resource.offset,
            size: resource.size,
        }
    }

    if (isTextureViewSpec(resource) && binding.entry.type === 'texture') {
        return createNativeTextureView(resource, true)
    }

    if (resource instanceof SamplerResource) {
        return resource.gpuSampler
    }

    throwScratchDiagnostic({
        code: 'SCRATCH_BIND_RESOURCE_TYPE_MISMATCH',
        severity: 'error',
        phase: 'binding',
        subject: {
            kind: 'BindLayoutEntry',
            binding: binding.entry.binding,
            name: binding.entry.name,
        },
        message: 'BindSet resource type does not match its BindLayout entry.',
        expected: { type: binding.entry.type },
        actual: { resource: describeValue(resource) },
    })
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

    const capabilities = STORAGE_TEXTURE_FORMAT_CAPABILITIES.get(entry.format as GPUTextureFormat)
    const requirement = capabilities?.[access]
    if (requirement === undefined || !runtimeSupportsStorageTextureRequirement(runtime, requirement)) {
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

    const dynamicUniformCount = entries.filter(entry =>
        entry.type === 'uniform' && entry.hasDynamicOffset
    ).length
    const dynamicStorageCount = entries.filter(entry =>
        (entry.type === 'read-storage' || entry.type === 'storage') && entry.hasDynamicOffset
    ).length
    assertBindingLimit(
        layout,
        'maxDynamicUniformBuffersPerPipelineLayout',
        runtime.deviceLimits.maxDynamicUniformBuffersPerPipelineLayout,
        dynamicUniformCount
    )
    assertBindingLimit(
        layout,
        'maxDynamicStorageBuffersPerPipelineLayout',
        runtime.deviceLimits.maxDynamicStorageBuffersPerPipelineLayout,
        dynamicStorageCount
    )

    for (const stage of [ 'vertex', 'fragment', 'compute' ] as const) {
        const visible = entries.filter(entry => entry.visibility.includes(stage))
        assertBindingLimit(
            layout,
            'maxUniformBuffersPerShaderStage',
            runtime.deviceLimits.maxUniformBuffersPerShaderStage,
            visible.filter(entry => entry.type === 'uniform').length,
            stage
        )
        assertBindingLimit(
            layout,
            'maxSamplersPerShaderStage',
            runtime.deviceLimits.maxSamplersPerShaderStage,
            visible.filter(entry => entry.type === 'sampler').length,
            stage
        )
        assertBindingLimit(
            layout,
            'maxSampledTexturesPerShaderStage',
            runtime.deviceLimits.maxSampledTexturesPerShaderStage,
            visible.filter(entry => entry.type === 'texture').length,
            stage
        )
        assertBindingLimit(
            layout,
            storageBufferLimitName(stage),
            storageBufferLimit(runtime, stage),
            visible.filter(entry => entry.type === 'read-storage' || entry.type === 'storage').length,
            stage
        )
        assertBindingLimit(
            layout,
            storageTextureLimitName(stage),
            storageTextureLimit(runtime, stage),
            visible.filter(entry => entry.type === 'storage-texture').length,
            stage
        )
    }
}

function assertBindingLimit(
    layout: BindLayoutDiagnosticContext,
    limit: string,
    maximum: number,
    actual: number,
    stage?: BindVisibility
): void {

    if (actual <= maximum) return
    throwScratchDiagnostic({
        code: 'SCRATCH_BIND_LAYOUT_LIMIT_EXCEEDED',
        severity: 'error',
        phase: 'binding',
        subject: layout.subject,
        message: 'BindLayout entries exceed a device binding-slot limit.',
        expected: { limit, maximum, ...(stage !== undefined ? { stage } : {}) },
        actual: { count: actual, ...(stage !== undefined ? { stage } : {}) },
    })
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

function createStorageTextureFormatCapabilities(): ReadonlyMap<
    GPUTextureFormat,
    StorageTextureFormatCapabilities
> {

    const formats = new Map<GPUTextureFormat, Record<string, StorageTextureFeatureRequirement>>()
    const addAccess = (
        format: GPUTextureFormat,
        access: GPUStorageTextureAccess,
        requirement: StorageTextureFeatureRequirement
    ) => {
        const capabilities = formats.get(format) ?? {}
        capabilities[access] = requirement
        formats.set(format, capabilities)
    }

    for (const format of BASE_STORAGE_TEXTURE_FORMATS) {
        addAccess(format, 'write-only', 'base')
        addAccess(format, 'read-only', 'base')
    }
    for (const format of [ 'r32uint', 'r32sint', 'r32float' ] as const) {
        addAccess(format, 'read-write', 'base')
    }
    for (const format of TIER_1_STORAGE_TEXTURE_FORMATS) {
        addAccess(format, 'write-only', 'texture-formats-tier1')
        addAccess(format, 'read-only', 'texture-formats-tier1')
    }
    for (const format of [ 'rg32uint', 'rg32sint', 'rg32float' ] as const) {
        addAccess(format, 'write-only', 'core-features-and-limits')
        addAccess(format, 'read-only', 'core-features-and-limits')
    }
    for (const format of TIER_2_READ_WRITE_STORAGE_TEXTURE_FORMATS) {
        addAccess(format, 'read-write', 'texture-formats-tier2')
    }
    addAccess('bgra8unorm', 'write-only', 'bgra8unorm-storage')

    return new Map([ ...formats ].map(([ format, capabilities ]) => [
        format,
        Object.freeze(capabilities),
    ]))
}

function runtimeSupportsStorageTextureRequirement(
    runtime: ScratchRuntime,
    requirement: StorageTextureFeatureRequirement
): boolean {

    if (requirement === 'base') return true
    if (requirement === 'texture-formats-tier1') {
        return runtimeHasFeature(runtime, 'texture-formats-tier1') ||
            runtimeHasFeature(runtime, 'texture-formats-tier2')
    }
    return runtimeHasFeature(runtime, requirement)
}

function runtimeHasFeature(runtime: ScratchRuntime, feature: string): boolean {

    return runtime.deviceFeatures.has(feature as GPUFeatureName)
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
    entry: TextureBindLayoutEntry | StorageTextureBindLayoutEntry | SamplerBindLayoutEntry
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
                type: [ 'uniform', 'read-storage', 'storage', 'texture', 'storage-texture', 'sampler' ],
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
