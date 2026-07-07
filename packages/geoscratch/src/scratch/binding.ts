import { UUID } from '../core/utils/uuid.js'
import { BufferResource } from './buffer.js'
import { throwScratchDiagnostic } from './diagnostics.js'
import { SamplerResource } from './sampler.js'
import { TextureResource } from './texture.js'
import type { ScratchRuntime } from './runtime.js'

const SHADER_STAGE_FLAGS = {
    vertex: 0x1,
    fragment: 0x2,
    compute: 0x4,
}

const BUFFER_USAGE_UNIFORM = 0x40
const BUFFER_USAGE_STORAGE = 0x80
const TEXTURE_USAGE_TEXTURE_BINDING = globalThis.GPUTextureUsage?.TEXTURE_BINDING ?? 0x4

const BUFFER_BINDING_TYPES = new Set([ 'uniform', 'read-storage', 'storage' ])
const TEXTURE_SAMPLE_TYPES = new Set([ 'float', 'unfilterable-float', 'depth', 'sint', 'uint' ])
const TEXTURE_VIEW_DIMENSIONS = new Set([ '1d', '2d', '2d-array', 'cube', 'cube-array', '3d' ])
const SAMPLER_BINDING_TYPES = new Set([ 'filtering', 'non-filtering', 'comparison' ])
const WEBGPU_BUFFER_BINDING_TYPES = {
    uniform: 'uniform',
    'read-storage': 'read-only-storage',
    storage: 'storage',
}
const REQUIRED_BUFFER_USAGE = {
    uniform: BUFFER_USAGE_UNIFORM,
    'read-storage': BUFFER_USAGE_STORAGE,
    storage: BUFFER_USAGE_STORAGE,
}

export type BindVisibility = 'vertex' | 'fragment' | 'compute'

export type UniformBindLayoutEntry = {
    binding: number
    name: string
    type: 'uniform'
    visibility: BindVisibility[]
}

export type StorageBindLayoutEntry = {
    binding: number
    name: string
    type: 'read-storage' | 'storage'
    visibility: BindVisibility[]
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
        this.label = descriptor.label
        this.group = normalizeGroup(this, descriptor.group)
        this.entries = normalizeEntries(this, descriptor.entries)
        this.isDisposed = false
        this.gpuBindGroupLayout = runtime.device.createBindGroupLayout({
            label: this.label,
            entries: this.entries.map((entry) => lowerBindLayoutEntry(entry)),
        })
    }

    get subject() {

        const subject: any = {
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
        this.label = options.label
        this.layout = layout
        this.bindings = normalizeBindings(this, bindings)
        this.isDisposed = false
        this.gpuBindGroup = undefined
        this.boundAllocationVersions = new Map()
    }

    get subject() {

        const subject: any = {
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
            this.gpuBindGroup = this.runtime.device.createBindGroup({
                label: this.label,
                layout: this.layout.gpuBindGroupLayout,
                entries: this.layout.entries.map((entry) => {
                    const binding = this.bindings.get(entry.name)

                    return {
                        binding: entry.binding,
                        resource: createBindingResource(binding!),
                    }
                }),
            })
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

        const normalized: any = {
            binding: entry.binding,
            name: entry.name,
            type: entry.type,
            visibility: normalizeVisibility(layout, entry),
        }

        if (entry.type === 'texture') {
            normalized.sampleType = normalizeTextureSampleType(layout, entry)
            normalized.viewDimension = normalizeTextureViewDimension(layout, entry)
            normalized.multisampled = normalizeTextureMultisampled(layout, entry)
        }

        if (entry.type === 'sampler') {
            normalized.samplerType = normalizeSamplerBindingType(layout, entry)
        }

        return normalized
    })
}

function isSupportedBindingType(type: any): boolean {

    return BUFFER_BINDING_TYPES.has(type) || type === 'texture' || type === 'sampler'
}

function normalizeVisibility(layout: BindLayout, entry: any): BindVisibility[] {

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

function validateBindingResource(bindSet: BindSet, entry: BindLayoutEntry, resource: any) {

    if (BUFFER_BINDING_TYPES.has(entry.type)) {
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

function validateBufferResource(bindSet: BindSet, entry: BindLayoutEntry, resource: any) {

    if (!(resource instanceof BufferResource)) {
        throwScratchDiagnostic({
            code: 'SCRATCH_BIND_RESOURCE_TYPE_MISMATCH',
            severity: 'error',
            phase: 'binding',
            subject: bindSet.layout.entrySubject(entry),
            related: [ bindSet.subject ],
            message: 'BindSet buffer entries require BufferResource bindings.',
            expected: { type: 'BufferResource' },
            actual: { resource: resource === undefined || resource === null ? String(resource) : typeof resource },
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

function validateTextureResource(bindSet: BindSet, entry: BindLayoutEntry, resource: any) {

    if (!(resource instanceof TextureResource)) {
        throwScratchDiagnostic({
            code: 'SCRATCH_BIND_RESOURCE_TYPE_MISMATCH',
            severity: 'error',
            phase: 'binding',
            subject: bindSet.layout.entrySubject(entry),
            related: [ bindSet.subject ],
            message: 'BindSet texture entries require TextureResource bindings.',
            expected: { type: 'TextureResource' },
            actual: { resource: resource === undefined || resource === null ? String(resource) : typeof resource },
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

function validateSamplerResource(bindSet: BindSet, entry: BindLayoutEntry, resource: any) {

    if (!(resource instanceof SamplerResource)) {
        throwScratchDiagnostic({
            code: 'SCRATCH_BIND_RESOURCE_TYPE_MISMATCH',
            severity: 'error',
            phase: 'binding',
            subject: bindSet.layout.entrySubject(entry),
            related: [ bindSet.subject ],
            message: 'BindSet sampler entries require SamplerResource bindings.',
            expected: { type: 'SamplerResource' },
            actual: { resource: resource === undefined || resource === null ? String(resource) : typeof resource },
        })
    }

    resource.assertRuntime(bindSet.runtime)
}

function lowerBindLayoutEntry(entry: BindLayoutEntry): GPUBindGroupLayoutEntry {

    const lowered: any = {
        binding: entry.binding,
        visibility: entry.visibility.reduce((flags, stage) => flags | SHADER_STAGE_FLAGS[stage], 0),
    }

    if (BUFFER_BINDING_TYPES.has(entry.type)) {
        lowered.buffer = { type: WEBGPU_BUFFER_BINDING_TYPES[entry.type] }
        return lowered
    }

    if (entry.type === 'texture') {
        lowered.texture = {
            sampleType: entry.sampleType,
            viewDimension: entry.viewDimension,
            multisampled: entry.multisampled,
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

    const resource: any = binding.resource

    if (BUFFER_BINDING_TYPES.has(binding.entry.type)) {
        return {
            buffer: resource.gpuBuffer,
        }
    }

    if (binding.entry.type === 'texture') {
        return resource.createView()
    }

    if (binding.entry.type === 'sampler') {
        return resource.gpuSampler
    }

    return {
        buffer: resource.gpuBuffer,
    }
}

function normalizeTextureSampleType(layout: BindLayout, entry: any): GPUTextureSampleType {

    const sampleType = entry.sampleType ?? 'float'
    if (!TEXTURE_SAMPLE_TYPES.has(sampleType)) {
        throwBindEntryDiagnostic(layout, entry)
    }

    return sampleType
}

function normalizeTextureViewDimension(layout: BindLayout, entry: any): GPUTextureViewDimension {

    const viewDimension = entry.viewDimension ?? '2d'
    if (!TEXTURE_VIEW_DIMENSIONS.has(viewDimension)) {
        throwBindEntryDiagnostic(layout, entry)
    }

    return viewDimension
}

function normalizeTextureMultisampled(layout: BindLayout, entry: any): boolean {

    const multisampled = entry.multisampled ?? false
    if (typeof multisampled !== 'boolean') {
        throwBindEntryDiagnostic(layout, entry)
    }

    return multisampled
}

function normalizeSamplerBindingType(layout: BindLayout, entry: any): GPUSamplerBindingType {

    const samplerType = entry.samplerType ?? 'filtering'
    if (!SAMPLER_BINDING_TYPES.has(samplerType)) {
        throwBindEntryDiagnostic(layout, entry)
    }

    return samplerType
}

function throwBindEntryDiagnostic(layout: BindLayout, entry: any) {

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
