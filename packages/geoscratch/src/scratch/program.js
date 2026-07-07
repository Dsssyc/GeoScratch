import { UUID } from '../core/utils/uuid.js'
import { throwScratchDiagnostic } from './diagnostics.js'

export class Program {

    constructor(runtime, descriptor = {}) {

        runtime.assertActive()

        this.runtime = runtime
        this.id = `scratch-program-${UUID()}`
        this.label = descriptor.label
        this.modules = normalizeModules(this, descriptor.modules)
        this.entryPoints = normalizeEntryPoints(this, descriptor.entryPoints)
        this.requiredFeatures = normalizeRequiredFeatures(descriptor.requiredFeatures)
        this.isDisposed = false

        validateRequiredFeatures(this)
    }

    get subject() {

        const subject = {
            kind: 'Program',
            id: this.id,
        }
        if (this.label !== undefined) subject.label = this.label

        return subject
    }

    assertRuntime(runtime) {

        this.assertUsable()

        if (runtime !== this.runtime) {
            throwScratchDiagnostic({
                code: 'SCRATCH_PROGRAM_WRONG_RUNTIME',
                severity: 'error',
                phase: 'program',
                subject: this.subject,
                related: [
                    this.runtime.subject,
                    runtime?.subject,
                ].filter(Boolean),
                message: 'Program belongs to a different ScratchRuntime.',
                expected: { runtimeId: this.runtime.id },
                actual: { runtimeId: runtime?.id },
            })
        }
    }

    assertUsable() {

        if (this.isDisposed) {
            throwScratchDiagnostic({
                code: 'SCRATCH_PROGRAM_DISPOSED',
                severity: 'error',
                phase: 'program',
                subject: this.subject,
                message: 'Program has been disposed.',
            })
        }

        this.runtime.assertActive()
    }

    dispose() {

        this.isDisposed = true
    }
}

function normalizeModules(program, modules) {

    if (!Array.isArray(modules) || modules.length === 0 || modules.some(module => typeof module !== 'string')) {
        throwScratchDiagnostic({
            code: 'SCRATCH_PROGRAM_MODULES_INVALID',
            severity: 'error',
            phase: 'program',
            subject: program.subject,
            message: 'Program requires at least one WGSL source module string.',
            expected: { modules: 'non-empty string[]' },
            actual: { modules: Array.isArray(modules) ? modules.map(module => typeof module) : typeof modules },
        })
    }

    return [ ...modules ]
}

function normalizeEntryPoints(program, entryPoints) {

    const normalized = {
        vertex: entryPoints?.vertex,
        fragment: entryPoints?.fragment,
        compute: entryPoints?.compute,
    }

    if (normalized.vertex !== undefined && typeof normalized.vertex !== 'string') {
        throwEntryPointDiagnostic(program, 'vertex', normalized.vertex)
    }

    if (normalized.fragment !== undefined && typeof normalized.fragment !== 'string') {
        throwEntryPointDiagnostic(program, 'fragment', normalized.fragment)
    }

    if (normalized.compute !== undefined && typeof normalized.compute !== 'string') {
        throwEntryPointDiagnostic(program, 'compute', normalized.compute)
    }

    return Object.fromEntries(
        Object.entries(normalized).filter((entry) => entry[1] !== undefined)
    )
}

function normalizeRequiredFeatures(requiredFeatures) {

    if (requiredFeatures === undefined) return []
    return [ ...requiredFeatures ]
}

function validateRequiredFeatures(program) {

    for (const feature of program.requiredFeatures) {
        if (!program.runtime.deviceFeatures?.has?.(feature)) {
            throwScratchDiagnostic({
                code: 'SCRATCH_PROGRAM_FEATURE_UNAVAILABLE',
                severity: 'error',
                phase: 'program',
                subject: program.subject,
                message: 'Program requires a WebGPU feature that is not available on this runtime.',
                expected: { feature },
                actual: { features: [ ...(program.runtime.deviceFeatures ?? []) ] },
            })
        }
    }
}

function throwEntryPointDiagnostic(program, stage, actual) {

    throwScratchDiagnostic({
        code: 'SCRATCH_PROGRAM_ENTRY_POINT_MISSING',
        severity: 'error',
        phase: 'program',
        subject: {
            kind: 'ShaderEntryPoint',
            programId: program.id,
            name: String(actual),
            stage,
        },
        related: [ program.subject ],
        message: 'Program entry point must be a string.',
        expected: { entryPoint: 'string' },
        actual: { entryPoint: actual },
    })
}
