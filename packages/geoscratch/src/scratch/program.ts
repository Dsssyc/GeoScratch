import { UUID } from '../core/utils/uuid.js'
import { throwScratchDiagnostic } from './diagnostics.js'
import { isRecord } from './type-utils.js'
import type { DiagnosticSubject } from './diagnostics.js'
import type { ScratchRuntime } from './runtime.js'

export type ProgramEntryPoints = {
    vertex?: string
    fragment?: string
    compute?: string
}

export type ProgramDescriptor = {
    label?: string
    modules: string[]
    entryPoints?: ProgramEntryPoints
    requiredFeatures?: Iterable<GPUFeatureName>
}

export interface Program {
    runtime: ScratchRuntime
    id: string
    label?: string
    modules: string[]
    entryPoints: ProgramEntryPoints
    requiredFeatures: GPUFeatureName[]
    isDisposed: boolean
}

export class Program {

    constructor(runtime: ScratchRuntime, descriptor: ProgramDescriptor) {

        runtime.assertActive()

        this.runtime = runtime
        this.id = `scratch-program-${UUID()}`
        if (descriptor.label !== undefined) this.label = descriptor.label
        this.modules = normalizeModules(this, descriptor.modules)
        this.entryPoints = normalizeEntryPoints(this, descriptor.entryPoints)
        this.requiredFeatures = normalizeRequiredFeatures(descriptor.requiredFeatures)
        this.isDisposed = false

        validateRequiredFeatures(this)
    }

    get subject(): DiagnosticSubject {

        const subject: DiagnosticSubject = {
            kind: 'Program',
            id: this.id,
        }
        if (this.label !== undefined) subject.label = this.label

        return subject
    }

    assertRuntime(runtime: ScratchRuntime): void {

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

    assertUsable(): void {

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

    dispose(): void {

        this.isDisposed = true
    }
}

function normalizeModules(program: Program, modules: unknown): string[] {

    if (
        !Array.isArray(modules) ||
        modules.length === 0 ||
        !modules.every((module): module is string => typeof module === 'string')
    ) {
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

function normalizeEntryPoints(program: Program, entryPoints: unknown): ProgramEntryPoints {

    if (entryPoints !== undefined && !isRecord(entryPoints)) {
        throwEntryPointDiagnostic(program, 'entryPoints', entryPoints)
    }

    const vertex = entryPoints?.vertex
    const fragment = entryPoints?.fragment
    const compute = entryPoints?.compute
    const normalized: ProgramEntryPoints = {}

    if (vertex !== undefined && typeof vertex !== 'string') {
        throwEntryPointDiagnostic(program, 'vertex', vertex)
    }

    if (fragment !== undefined && typeof fragment !== 'string') {
        throwEntryPointDiagnostic(program, 'fragment', fragment)
    }

    if (compute !== undefined && typeof compute !== 'string') {
        throwEntryPointDiagnostic(program, 'compute', compute)
    }

    if (vertex !== undefined) normalized.vertex = vertex
    if (fragment !== undefined) normalized.fragment = fragment
    if (compute !== undefined) normalized.compute = compute

    return normalized
}

function normalizeRequiredFeatures(requiredFeatures: Iterable<GPUFeatureName> | undefined): GPUFeatureName[] {

    if (requiredFeatures === undefined) return []
    return [ ...requiredFeatures ]
}

function validateRequiredFeatures(program: Program): void {

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

function throwEntryPointDiagnostic(program: Program, stage: string, actual: unknown): never {

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
