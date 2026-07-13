import { UUID } from '../core/utils/uuid.js'
import { throwScratchDiagnostic } from './diagnostics.js'
import { isLayoutArtifact } from './layout-codec.js'
import { describeValue, isRecord } from './type-utils.js'
import type { BindVisibility } from './binding.js'
import type { DiagnosticSubject } from './diagnostics.js'
import type { LayoutArtifact } from './layout-codec.js'
import type { ScratchRuntime } from './runtime.js'

export type ProgramEntryPoints = {
    vertex?: string
    fragment?: string
    compute?: string
}

export type ProgramBufferLayoutRequirement = {
    group: number
    binding: number
    name?: string
    type: 'uniform' | 'read-storage' | 'storage'
    visibility?: BindVisibility[]
    layout: LayoutArtifact
}

export type ProgramDescriptor = {
    label?: string
    modules: string[]
    entryPoints?: ProgramEntryPoints
    requiredFeatures?: Iterable<GPUFeatureName>
    layoutRequirements?: ProgramBufferLayoutRequirement[]
}

export interface Program {
    runtime: ScratchRuntime
    id: string
    label?: string
    modules: string[]
    entryPoints: ProgramEntryPoints
    requiredFeatures: GPUFeatureName[]
    layoutRequirements: ProgramBufferLayoutRequirement[]
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
        this.layoutRequirements = normalizeLayoutRequirements(this, descriptor.layoutRequirements)
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

export function programLayoutRequirementSubject(requirement: Pick<ProgramBufferLayoutRequirement, 'group' | 'binding'> & { name?: unknown }): DiagnosticSubject {

    const subject: DiagnosticSubject = {
        kind: 'ShaderBinding',
        group: requirement.group,
        binding: requirement.binding,
        stage: 'buffer',
    }
    if (typeof requirement.name === 'string') subject.name = requirement.name

    return subject
}

export function programLayoutRequirementExpected(requirement: ProgramBufferLayoutRequirement) {

    return {
        group: requirement.group,
        binding: requirement.binding,
        ...(requirement.name !== undefined ? { name: requirement.name } : {}),
        type: requirement.type,
        ...(requirement.visibility !== undefined ? { visibility: requirement.visibility } : {}),
        abiHash: requirement.layout.abiHash,
        schemaHash: requirement.layout.schemaHash,
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

function normalizeLayoutRequirements(program: Program, layoutRequirements: unknown): ProgramBufferLayoutRequirement[] {

    if (layoutRequirements === undefined) return []

    if (!Array.isArray(layoutRequirements)) {
        throwScratchDiagnostic({
            code: 'SCRATCH_PROGRAM_ACCESSOR_LAYOUT_MISMATCH',
            severity: 'error',
            phase: 'program',
            subject: program.subject,
            message: 'Program layoutRequirements must be an array.',
            expected: { layoutRequirements: 'ProgramBufferLayoutRequirement[]' },
            actual: { layoutRequirements: describeValue(layoutRequirements) },
        })
    }

    const seen = new Set<string>()
    return layoutRequirements.map((requirement) => {
        const normalized = normalizeLayoutRequirement(program, requirement)
        const key = `${normalized.group}:${normalized.binding}`
        if (seen.has(key)) {
            throwScratchDiagnostic({
                code: 'SCRATCH_PROGRAM_ACCESSOR_LAYOUT_MISMATCH',
                severity: 'error',
                phase: 'program',
                subject: programLayoutRequirementSubject(normalized),
                related: [ program.subject ],
                message: 'Program layoutRequirements must not duplicate a group and binding pair.',
                expected: { unique: [ 'group', 'binding' ] },
                actual: { group: normalized.group, binding: normalized.binding },
            })
        }
        seen.add(key)

        return normalized
    })
}

function normalizeLayoutRequirement(program: Program, requirement: unknown): ProgramBufferLayoutRequirement {

    if (!isRecord(requirement)) {
        throwLayoutRequirementDiagnostic(program, { group: undefined, binding: undefined }, {
            expected: { requirement: 'ProgramBufferLayoutRequirement' },
            actual: { requirement: describeValue(requirement) },
        })
    }

    const group = requirement.group
    const binding = requirement.binding
    const name = requirement.name
    const type = requirement.type
    const visibility = requirement.visibility
    const layout = requirement.layout
    const subjectInput = {
        group,
        binding,
        name,
    }

    if (typeof group !== 'number' || !Number.isInteger(group) || group < 0) {
        throwLayoutRequirementDiagnostic(program, subjectInput, {
            expected: { group: 'non-negative integer' },
            actual: { group },
        })
    }

    if (typeof binding !== 'number' || !Number.isInteger(binding) || binding < 0) {
        throwLayoutRequirementDiagnostic(program, subjectInput, {
            expected: { binding: 'non-negative integer' },
            actual: { binding },
        })
    }

    if (name !== undefined && (typeof name !== 'string' || name.length === 0)) {
        throwLayoutRequirementDiagnostic(program, subjectInput, {
            expected: { name: 'non-empty string' },
            actual: { name },
        })
    }

    if (!isProgramBufferLayoutRequirementType(type)) {
        throwLayoutRequirementDiagnostic(program, subjectInput, {
            expected: { type: [ 'uniform', 'read-storage', 'storage' ] },
            actual: { type },
        })
    }

    const normalizedVisibility = normalizeLayoutRequirementVisibility(program, subjectInput, visibility)

    if (!isLayoutArtifact(layout)) {
        throwLayoutRequirementDiagnostic(program, subjectInput, {
            expected: { layout: 'LayoutArtifact' },
            actual: { layout: describeValue(layout) },
        })
    }

    const normalized: ProgramBufferLayoutRequirement = {
        group,
        binding,
        type,
        layout,
    }
    if (name !== undefined) normalized.name = name
    if (normalizedVisibility !== undefined) normalized.visibility = normalizedVisibility

    return normalized
}

function normalizeLayoutRequirementVisibility(
    program: Program,
    subjectInput: { group: unknown, binding: unknown, name: unknown },
    visibility: unknown
): BindVisibility[] | undefined {

    if (visibility === undefined) return undefined

    if (!Array.isArray(visibility) || visibility.length === 0) {
        throwLayoutRequirementDiagnostic(program, subjectInput, {
            expected: { visibility: 'non-empty stage array' },
            actual: { visibility },
        })
    }

    for (const stage of visibility) {
        if (!isBindVisibility(stage)) {
            throwLayoutRequirementDiagnostic(program, subjectInput, {
                expected: { visibility: [ 'vertex', 'fragment', 'compute' ] },
                actual: { visibility },
            })
        }
    }

    return [ ...visibility ]
}

function isProgramBufferLayoutRequirementType(type: unknown): type is ProgramBufferLayoutRequirement['type'] {

    return type === 'uniform' || type === 'read-storage' || type === 'storage'
}

function isBindVisibility(stage: unknown): stage is BindVisibility {

    return stage === 'vertex' || stage === 'fragment' || stage === 'compute'
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

function throwLayoutRequirementDiagnostic(
    program: Program,
    requirement: { group: unknown, binding: unknown, name?: unknown },
    details: { expected: unknown, actual: unknown }
): never {

    throwScratchDiagnostic({
        code: 'SCRATCH_PROGRAM_ACCESSOR_LAYOUT_MISMATCH',
        severity: 'error',
        phase: 'program',
        subject: {
            kind: 'ShaderBinding',
            group: requirement.group,
            binding: requirement.binding,
            ...(typeof requirement.name === 'string' ? { name: requirement.name } : {}),
            stage: 'buffer',
        },
        related: [ program.subject ],
        message: 'Program buffer layout requirement is invalid.',
        expected: details.expected,
        actual: details.actual,
    })
}
