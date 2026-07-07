import { UUID } from '../core/utils/uuid.js'
import { throwScratchDiagnostic } from './diagnostics.js'

const SHADER_STAGE_FLAGS = {
    vertex: 0x1,
    fragment: 0x2,
    compute: 0x4,
}

const BUFFER_USAGE_UNIFORM = 0x40
const BUFFER_USAGE_STORAGE = 0x80

const BUFFER_BINDING_TYPES = new Set([ 'uniform', 'read-storage', 'storage' ])
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

export class BindLayout {

    constructor(runtime, descriptor = {}) {

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

        const subject = {
            kind: 'BindLayout',
            id: this.id,
        }
        if (this.label !== undefined) subject.label = this.label

        return subject
    }

    assertRuntime(runtime) {

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

    entrySubject(entry) {

        return {
            kind: 'BindLayoutEntry',
            group: this.group,
            binding: entry.binding,
            name: entry.name,
        }
    }

    dispose() {

        this.isDisposed = true
    }
}

export class BindSet {

    constructor(runtime, layout, bindings = {}, options = {}) {

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

        const subject = {
            kind: 'BindSet',
            id: this.id,
        }
        if (this.label !== undefined) subject.label = this.label

        return subject
    }

    assertRuntime(runtime) {

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

    getBindGroup() {

        this.assertUsable()

        if (!this.gpuBindGroup || this.hasStaleAllocationVersions()) {
            this.gpuBindGroup = this.runtime.device.createBindGroup({
                label: this.label,
                layout: this.layout.gpuBindGroupLayout,
                entries: this.layout.entries.map((entry) => {
                    const binding = this.bindings.get(entry.name)

                    return {
                        binding: entry.binding,
                        resource: createBindingResource(binding),
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

    hasStaleAllocationVersions() {

        for (const binding of this.bindings.values()) {
            if (this.boundAllocationVersions.get(binding.resource.id) !== binding.resource.allocationVersion) {
                return true
            }
        }

        return false
    }

    dispose() {

        this.isDisposed = true
    }
}

function normalizeGroup(layout, group) {

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

function normalizeEntries(layout, entries) {

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

        if (!Number.isInteger(entry.binding) || entry.binding < 0 || !BUFFER_BINDING_TYPES.has(entry.type)) {
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

        return {
            binding: entry.binding,
            name: entry.name,
            type: entry.type,
            visibility: normalizeVisibility(layout, entry),
        }
    })
}

function normalizeVisibility(layout, entry) {

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

function normalizeBindings(bindSet, bindings) {

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

    const normalized = new Map()

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

        validateBufferResource(bindSet, entry, resource)
        normalized.set(entry.name, { entry, resource })
    }

    return normalized
}

function validateBufferResource(bindSet, entry, resource) {

    if (!resource || typeof resource.assertRuntime !== 'function' || !resource.gpuBuffer) {
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

function lowerBindLayoutEntry(entry) {

    return {
        binding: entry.binding,
        visibility: entry.visibility.reduce((flags, stage) => flags | SHADER_STAGE_FLAGS[stage], 0),
        buffer: { type: WEBGPU_BUFFER_BINDING_TYPES[entry.type] },
    }
}

function createBindingResource(binding) {

    return {
        buffer: binding.resource.gpuBuffer,
    }
}

function throwBindEntryDiagnostic(layout, entry) {

    throwScratchDiagnostic({
        code: 'SCRATCH_BIND_REQUIRED_ENTRY_MISSING',
        severity: 'error',
        phase: 'binding',
        subject: layout.subject,
        message: 'BindLayout entry must declare a supported buffer binding with name, binding, and visibility.',
        expected: {
            entry: {
                name: 'string',
                binding: 'non-negative integer',
                type: [ 'uniform', 'read-storage', 'storage' ],
                visibility: [ 'vertex', 'fragment', 'compute' ],
            },
        },
        actual: { entry },
    })
}
