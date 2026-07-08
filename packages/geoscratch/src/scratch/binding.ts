import { UUID } from '../core/utils/uuid.js'
import { BufferResource } from './buffer.js'
import { throwScratchDiagnostic } from './diagnostics.js'
import { SamplerResource } from './sampler.js'
import { TextureResource } from './texture.js'
import { describeValue, getGlobalConstant } from './type-utils.js'
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

export type BindVisibility = 'vertex' | 'fragment' | 'compute'

export type UniformBindLayoutEntry = {
    binding: number
    name: string
    type: 'uniform'
    visibility: BindVisibility[]
    hasDynamicOffset?: boolean
}

export type StorageBindLayoutEntry = {
    binding: number
    name: string
    type: 'read-storage' | 'storage'
    visibility: BindVisibility[]
    hasDynamicOffset?: boolean
}

export type TextureBindLayoutEntry = {
    binding: number
    name: string
    type: 'texture'
    visibility: BindVisibility[]
    sampleType?: GPUTextureSampleType
    viewDimension?: GPUTextureViewDimension
    multisampled?: boolean
}

export type SamplerBindLayoutEntry = {
    binding: number
    name: string
    type: 'sampler'
    visibility: BindVisibility[]
    samplerType?: GPUSamplerBindingType
}

export type BindLayoutEntry =
    | UniformBindLayoutEntry
    | StorageBindLayoutEntry
    | TextureBindLayoutEntry
    | SamplerBindLayoutEntry

type BufferBindingType = UniformBindLayoutEntry['type'] | StorageBindLayoutEntry['type']
type BufferBindLayoutEntry = UniformBindLayoutEntry | StorageBindLayoutEntry
type EntryWithDynamicOffsetFlag = BindLayoutEntry & { hasDynamicOffset?: unknown }

export type BindLayoutDescriptor = {
    label?: string
    group: number
    entries: BindLayoutEntry[]
}

export type BindSetBindings = Record<string, BufferResource | TextureResource | SamplerResource>

export type BindSetOptions = {
    label?: string
}

type NormalizedBindSetBinding = {
    entry: BindLayoutEntry
    resource: BufferResource | TextureResource | SamplerResource
}

export interface BindLayout {
    runtime: ScratchRuntime
    id: string
    label?: string
    group: number
    entries: BindLayoutEntry[]
    gpuBindGroupLayout: GPUBindGroupLayout
    isDisposed: boolean
}

export class BindLayout {

    constructor(runtime: ScratchRuntime, descriptor: BindLayoutDescriptor) {

        runtime.assertActive()

        this.runtime = runtime
        this.id = `scratch-bind-layout-${UUID()}`
        this.group = normalizeGroup(this, descriptor.group)
        this.entries = normalizeEntries(this, descriptor.entries)
        this.isDisposed = false
        if (descriptor.label !== undefined) this.label = descriptor.label

        const gpuDescriptor: GPUBindGroupLayoutDescriptor = {
            entries: this.entries.map((entry) => lowerBindLayoutEntry(entry)),
        }
        if (this.label !== undefined) gpuDescriptor.label = this.label

        this.gpuBindGroupLayout = runtime.device.createBindGroupLayout(gpuDescriptor)
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

    entrySubject(entry: BindLayoutEntry) {

        return {
            kind: 'BindLayoutEntry',
            group: this.group,
            binding: entry.binding,
            name: entry.name,
        }
    }

    dispose(): void {

        this.isDisposed = true
    }
}

export interface BindSet {
    runtime: ScratchRuntime
    id: string
    label?: string
    layout: BindLayout
    bindings: Map<string, NormalizedBindSetBinding>
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
        this.bindings = normalizeBindings(this, bindings)
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
            binding.resource.assertUsable()
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
                    binding.resource.id,
                    binding.resource.allocationVersion,
                ])
            )
        }

        return this.gpuBindGroup
    }

    hasStaleAllocationVersions(): boolean {

        for (const binding of this.bindings.values()) {
            if (this.boundAllocationVersions.get(binding.resource.id) !== binding.resource.allocationVersion) {
                return true
            }
        }

        return false
    }

    dispose(): void {

        this.isDisposed = true
    }
}

function normalizeGroup(layout: BindLayout, group: number) {

    if (!Number.isInteger(group) || group < 0) {
        throwScratchDiagnostic({
            code: 'SCRATCH_BIND_REQUIRED_ENTRY_MISSING',
            severity: 'error',
            phase: 'binding',
            subject: layout.subject,
            message: 'BindLayout group must be a non-negative integer.',
            expected: { group: 'non-negative integer' },
            actual: { group },
        })
    }

    return group
}

function normalizeEntries(layout: BindLayout, entries: BindLayoutEntry[]): BindLayoutEntry[] {

    if (!Array.isArray(entries) || entries.length === 0) {
        throwScratchDiagnostic({
            code: 'SCRATCH_BIND_REQUIRED_ENTRY_MISSING',
            severity: 'error',
            phase: 'binding',
            subject: layout.subject,
            message: 'BindLayout requires at least one entry.',
            expected: { entries: 'non-empty array' },
            actual: { entries },
        })
    }

    const names = new Set()
    const bindings = new Set()

    return entries.map((entry) => {
        if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string') {
            throwBindEntryDiagnostic(layout, entry)
        }

        if (!Number.isInteger(entry.binding) || entry.binding < 0 || !isSupportedBindingType(entry.type)) {
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

        const base = {
            binding: entry.binding,
            name: entry.name,
            visibility: normalizeVisibility(layout, entry),
        }

        if (entry.type === 'texture') {
            rejectDynamicOffsetFlag(layout, entry)

            return {
                ...base,
                type: entry.type,
                sampleType: normalizeTextureSampleType(layout, entry),
                viewDimension: normalizeTextureViewDimension(layout, entry),
                multisampled: normalizeTextureMultisampled(layout, entry),
            }
        }

        if (entry.type === 'sampler') {
            rejectDynamicOffsetFlag(layout, entry)

            return {
                ...base,
                type: entry.type,
                samplerType: normalizeSamplerBindingType(layout, entry),
            }
        }

        const hasDynamicOffset = normalizeDynamicOffsetFlag(layout, entry)
        if (hasDynamicOffset === true) {
            return {
                ...base,
                type: entry.type,
                hasDynamicOffset,
            }
        }

        return {
            ...base,
            type: entry.type,
        }
    })
}

function isSupportedBindingType(type: unknown): type is BindLayoutEntry['type'] {

    return typeof type === 'string' &&
        (isBufferBindingType(type) || type === 'texture' || type === 'sampler')
}

function normalizeVisibility(layout: BindLayout, entry: BindLayoutEntry): BindVisibility[] {

    if (!Array.isArray(entry.visibility) || entry.visibility.length === 0) {
        throwBindEntryDiagnostic(layout, entry)
    }

    for (const stage of entry.visibility) {
        if (!Object.hasOwn(SHADER_STAGE_FLAGS, stage)) {
            throwBindEntryDiagnostic(layout, entry)
        }
    }

    return [ ...entry.visibility ]
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

function validateBindingResource(bindSet: BindSet, entry: BindLayoutEntry, resource: unknown) {

    if (isBufferBindLayoutEntry(entry)) {
        validateBufferResource(bindSet, entry, resource)
        return
    }

    if (entry.type === 'texture') {
        validateTextureResource(bindSet, entry, resource)
        return
    }

    if (entry.type === 'sampler') {
        validateSamplerResource(bindSet, entry, resource)
        return
    }

    throwBindEntryDiagnostic(bindSet.layout, entry)
}

function validateBufferResource(bindSet: BindSet, entry: BufferBindLayoutEntry, resource: unknown) {

    if (!(resource instanceof BufferResource)) {
        throwScratchDiagnostic({
            code: 'SCRATCH_BIND_RESOURCE_TYPE_MISMATCH',
            severity: 'error',
            phase: 'binding',
            subject: bindSet.layout.entrySubject(entry),
            related: [ bindSet.subject ],
            message: 'BindSet buffer entries require BufferResource bindings.',
            expected: { type: 'BufferResource' },
            actual: { resource: describeValue(resource) },
        })
    }

    resource.assertRuntime(bindSet.runtime)

    const requiredUsage = REQUIRED_BUFFER_USAGE[entry.type]
    if (typeof resource.usage === 'number' && (resource.usage & requiredUsage) === 0) {
        throwScratchDiagnostic({
            code: 'SCRATCH_BIND_RESOURCE_USAGE_MISSING',
            severity: 'error',
            phase: 'binding',
            subject: resource.subject,
            related: [ bindSet.layout.entrySubject(entry), bindSet.subject ],
            message: 'Buffer binding requires a buffer created with compatible usage.',
            expected: { usage: entry.type },
            actual: { usage: resource.usage },
        })
    }
}

function validateTextureResource(bindSet: BindSet, entry: TextureBindLayoutEntry, resource: unknown) {

    if (!(resource instanceof TextureResource)) {
        throwScratchDiagnostic({
            code: 'SCRATCH_BIND_RESOURCE_TYPE_MISMATCH',
            severity: 'error',
            phase: 'binding',
            subject: bindSet.layout.entrySubject(entry),
            related: [ bindSet.subject ],
            message: 'BindSet texture entries require TextureResource bindings.',
            expected: { type: 'TextureResource' },
            actual: { resource: describeValue(resource) },
        })
    }

    resource.assertRuntime(bindSet.runtime)

    if (typeof resource.usage === 'number' && (resource.usage & TEXTURE_USAGE_TEXTURE_BINDING) === 0) {
        throwScratchDiagnostic({
            code: 'SCRATCH_BIND_RESOURCE_USAGE_MISSING',
            severity: 'error',
            phase: 'binding',
            subject: resource.subject,
            related: [ bindSet.layout.entrySubject(entry), bindSet.subject ],
            message: 'Texture binding requires a texture created with compatible usage.',
            expected: { usage: 'GPUTextureUsage.TEXTURE_BINDING' },
            actual: { usage: resource.usage },
        })
    }
}

function validateSamplerResource(bindSet: BindSet, entry: SamplerBindLayoutEntry, resource: unknown) {

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

function lowerBindLayoutEntry(entry: BindLayoutEntry): GPUBindGroupLayoutEntry {

    const lowered: GPUBindGroupLayoutEntry = {
        binding: entry.binding,
        visibility: entry.visibility.reduce((flags, stage) => flags | SHADER_STAGE_FLAGS[stage], 0),
    }

    if (isBufferBindLayoutEntry(entry)) {
        const buffer: GPUBufferBindingLayout = { type: WEBGPU_BUFFER_BINDING_TYPES[entry.type] }
        if (entry.hasDynamicOffset === true) buffer.hasDynamicOffset = true
        lowered.buffer = buffer
        return lowered
    }

    if (entry.type === 'texture') {
        const texture: GPUTextureBindingLayout = {}
        if (entry.sampleType !== undefined) texture.sampleType = entry.sampleType
        if (entry.viewDimension !== undefined) texture.viewDimension = entry.viewDimension
        if (entry.multisampled !== undefined) texture.multisampled = entry.multisampled
        lowered.texture = texture
        return lowered
    }

    if (entry.type === 'sampler') {
        const sampler: GPUSamplerBindingLayout = {}
        if (entry.samplerType !== undefined) sampler.type = entry.samplerType
        lowered.sampler = sampler
        return lowered
    }

    return lowered
}

function createBindingResource(binding: NormalizedBindSetBinding): GPUBindingResource {

    const resource = binding.resource

    if (resource instanceof BufferResource) {
        return {
            buffer: resource.gpuBuffer,
        }
    }

    if (resource instanceof TextureResource) {
        return resource.createView()
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

function normalizeTextureSampleType(layout: BindLayout, entry: TextureBindLayoutEntry): GPUTextureSampleType {

    const sampleType = entry.sampleType ?? 'float'
    if (!TEXTURE_SAMPLE_TYPES.has(sampleType)) {
        throwBindEntryDiagnostic(layout, entry)
    }

    return sampleType
}

function normalizeTextureViewDimension(layout: BindLayout, entry: TextureBindLayoutEntry): GPUTextureViewDimension {

    const viewDimension = entry.viewDimension ?? '2d'
    if (!TEXTURE_VIEW_DIMENSIONS.has(viewDimension)) {
        throwBindEntryDiagnostic(layout, entry)
    }

    return viewDimension
}

function normalizeTextureMultisampled(layout: BindLayout, entry: TextureBindLayoutEntry): boolean {

    const multisampled = entry.multisampled ?? false
    if (typeof multisampled !== 'boolean') {
        throwBindEntryDiagnostic(layout, entry)
    }

    return multisampled
}

function normalizeSamplerBindingType(layout: BindLayout, entry: SamplerBindLayoutEntry): GPUSamplerBindingType {

    const samplerType = entry.samplerType ?? 'filtering'
    if (!SAMPLER_BINDING_TYPES.has(samplerType)) {
        throwBindEntryDiagnostic(layout, entry)
    }

    return samplerType
}

function normalizeDynamicOffsetFlag(layout: BindLayout, entry: BufferBindLayoutEntry): true | undefined {

    const hasDynamicOffset = (entry as EntryWithDynamicOffsetFlag).hasDynamicOffset
    if (hasDynamicOffset === undefined) return undefined

    if (typeof hasDynamicOffset !== 'boolean') {
        throwDynamicOffsetFlagDiagnostic(layout, entry, hasDynamicOffset, {
            hasDynamicOffset: 'boolean',
        })
    }

    return hasDynamicOffset === true ? true : undefined
}

function rejectDynamicOffsetFlag(layout: BindLayout, entry: TextureBindLayoutEntry | SamplerBindLayoutEntry): void {

    const hasDynamicOffset = (entry as EntryWithDynamicOffsetFlag).hasDynamicOffset
    if (hasDynamicOffset === undefined) return

    throwDynamicOffsetFlagDiagnostic(layout, entry, hasDynamicOffset, {
        hasDynamicOffset: 'only supported for uniform, read-storage, and storage entries',
    })
}

function throwDynamicOffsetFlagDiagnostic(
    layout: BindLayout,
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

function throwBindEntryDiagnostic(layout: BindLayout, entry: unknown): never {

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
                type: [ 'uniform', 'read-storage', 'storage', 'texture', 'sampler' ],
                visibility: [ 'vertex', 'fragment', 'compute' ],
            },
        },
        actual: { entry },
    })
}

function isBufferBindLayoutEntry(entry: BindLayoutEntry): entry is BufferBindLayoutEntry {

    return isBufferBindingType(entry.type)
}

function isBufferBindingType(type: unknown): type is BufferBindingType {

    return typeof type === 'string' && BUFFER_BINDING_TYPES.has(type as BufferBindingType)
}
