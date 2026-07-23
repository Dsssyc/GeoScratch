import { UUID } from '../core/utils/uuid.js'
import { throwScratchDiagnostic } from './diagnostics.js'
import { isLayoutArtifact } from './layout-codec.js'
import {
    assertScratchRuntimeActive,
    assertScratchRuntimeAuthority,
    captureScratchRuntimeAuthority,
    observeScratchRuntimeAuthority,
    scratchRuntimeAuthoritySubject,
} from './runtime-authority.js'
import { describeValue, isRecord } from './type-utils.js'
import type { BindVisibility } from './binding.js'
import type { DiagnosticSubject } from './diagnostics.js'
import type { LayoutArtifact } from './layout-codec.js'
import type { ScratchRuntime } from './runtime.js'
import type {
    ScratchRuntimeAuthorityObservation,
    ScratchRuntimeAuthorityStamp,
} from './runtime-authority.js'

export type ProgramEntryPoints = {
    vertex?: string
    fragment?: string
    compute?: string
}

export type ProgramBufferLayoutRequirement = Readonly<{
    group: number
    binding: number
    name?: string
    type: 'uniform' | 'read-storage' | 'storage'
    visibility?: readonly BindVisibility[]
    hasDynamicOffset: boolean
    layout: LayoutArtifact
}>

export type ProgramDescriptor = {
    label?: string
    modules: string[]
    entryPoints?: ProgramEntryPoints
    requiredFeatures?: Iterable<GPUFeatureName>
    requiredLanguageFeatures?: Iterable<string>
    layoutRequirements?: readonly ProgramBufferLayoutRequirement[]
}

type ProgramState = {
    runtime: ScratchRuntime
    isDisposed: boolean
    lifecycleEpoch: number
}

type ProgramPipelineFacts = Readonly<{
    modules: readonly string[]
    entryPoints: Readonly<ProgramEntryPoints>
    requiredFeatures: readonly GPUFeatureName[]
    requiredLanguageFeatures: readonly string[]
    layoutRequirements: readonly ProgramBufferLayoutRequirement[]
}>

type ProgramPipelineFactsSnapshot = Readonly<{
    facts: ProgramPipelineFacts
    authority: ProgramPipelineAuthorityStamp
}>

export type ProgramPipelineAuthorityStamp = Readonly<{
    program: Program
    lifecycleEpoch: number
    runtimeAuthority: ScratchRuntimeAuthorityStamp
}>

export type ProgramPipelineAuthorityObservation = Readonly<{
    isProgramCurrent: boolean
    isProgramDisposed: boolean
    programLifecycleEpoch: number
    runtime: ScratchRuntimeAuthorityObservation
}>

type SampledProgramPipelineFacts = Readonly<{
    modules: unknown
    entryPoints: unknown
    requiredFeatures: unknown
    requiredLanguageFeatures: unknown
    layoutRequirements: unknown
}>

const programStates = new WeakMap<Program, ProgramState>()

export interface Program {
    readonly runtime: ScratchRuntime
    readonly id: string
    label?: string
    modules: string[]
    entryPoints: ProgramEntryPoints
    requiredFeatures: GPUFeatureName[]
    requiredLanguageFeatures: string[]
    layoutRequirements: readonly ProgramBufferLayoutRequirement[]
    readonly isDisposed: boolean
}

export class Program {

    constructor(runtime: ScratchRuntime, descriptor: ProgramDescriptor) {

        const runtimeAuthority = captureScratchRuntimeAuthority(runtime)

        programStates.set(this, { runtime, isDisposed: false, lifecycleEpoch: 0 })
        Object.defineProperties(this, {
            runtime: {
                value: runtime,
                enumerable: true,
                configurable: false,
                writable: false,
            },
            id: {
                value: `scratch-program-${UUID()}`,
                enumerable: true,
                configurable: false,
                writable: false,
            },
            isDisposed: {
                get: () => programStateFor(this).isDisposed,
                enumerable: true,
                configurable: false,
            },
        })
        if (descriptor.label !== undefined) this.label = descriptor.label
        this.modules = normalizeModules(this, descriptor.modules)
        this.entryPoints = normalizeEntryPoints(this, descriptor.entryPoints)
        this.requiredFeatures = normalizeRequiredFeatures(descriptor.requiredFeatures)
        this.requiredLanguageFeatures = normalizeRequiredLanguageFeatures(
            this,
            descriptor.requiredLanguageFeatures
        )
        this.layoutRequirements = normalizeLayoutRequirements(this, descriptor.layoutRequirements)

        validateRequiredFeatures(this, runtime, this.requiredFeatures)
        validateRequiredLanguageFeatures(this, runtime, this.requiredLanguageFeatures)
        assertScratchRuntimeAuthority(runtimeAuthority)
    }

    get subject(): DiagnosticSubject {

        return programAuthoritySubject(this)
    }

    assertRuntime(runtime: ScratchRuntime): void {

        assertProgramRuntimeAuthority(this, runtime)
    }

    assertUsable(): void {

        assertProgramUsableAuthority(this)
    }

    dispose(): void {

        const state = programStateFor(this)
        if (state.isDisposed) return
        state.isDisposed = true
        state.lifecycleEpoch += 1
    }
}

export function isProgram(value: unknown): value is Program {

    return typeof value === 'object' && value !== null &&
        Object.getPrototypeOf(value) === Program.prototype &&
        programStates.has(value as Program)
}

export function snapshotProgramPipelineFacts(
    program: Program,
    runtime: ScratchRuntime
): ProgramPipelineFactsSnapshot {

    const authority = captureProgramPipelineAuthority(program, runtime)
    const state = programStateFor(program)
    const sampled = runProgramFactPhase(authority, () => materializeProgramPipelineFacts(program))
    const normalized = runProgramFactPhase(authority, () => Object.freeze({
        modules: Object.freeze(normalizeModules(program, sampled.modules)),
        entryPoints: Object.freeze(normalizeEntryPoints(program, sampled.entryPoints)),
        requiredFeatures: Object.freeze(normalizeRequiredFeatures(
            sampled.requiredFeatures as Iterable<GPUFeatureName> | undefined
        )),
        requiredLanguageFeatures: Object.freeze(normalizeRequiredLanguageFeatures(
            program,
            sampled.requiredLanguageFeatures
        )),
        layoutRequirements: normalizeLayoutRequirements(program, sampled.layoutRequirements),
    }))

    runProgramFactPhase(authority, () => {
        validateRequiredFeatures(program, state.runtime, normalized.requiredFeatures)
        validateRequiredLanguageFeatures(
            program,
            state.runtime,
            normalized.requiredLanguageFeatures
        )
    })

    return Object.freeze({ facts: normalized, authority })
}

export function assertProgramUsableAuthority(program: Program): void {

    const state = programStateFor(program)
    assertProgramNotDisposed(program, state)
    assertScratchRuntimeActive(state.runtime)
}

export function assertProgramPipelineAuthority(stamp: ProgramPipelineAuthorityStamp): void {

    const state = programStateFor(stamp.program)
    assertProgramNotDisposed(stamp.program, state)
    if (state.lifecycleEpoch !== stamp.lifecycleEpoch) {
        throwScratchDiagnostic({
            code: 'SCRATCH_PROGRAM_LIFECYCLE_CHANGED',
            severity: 'error',
            phase: 'program',
            subject: programAuthoritySubject(stamp.program),
            message: 'Program lifecycle changed after pipeline preparation.',
            expected: { lifecycleEpoch: stamp.lifecycleEpoch },
            actual: { lifecycleEpoch: state.lifecycleEpoch },
            hints: [ 'Prepare a new pipeline candidate from the current Program lifecycle.' ],
        })
    }
    assertScratchRuntimeAuthority(stamp.runtimeAuthority)
}

export function observeProgramPipelineAuthority(
    stamp: ProgramPipelineAuthorityStamp
): ProgramPipelineAuthorityObservation {

    const state = programStateFor(stamp.program)
    return Object.freeze({
        isProgramCurrent: state.lifecycleEpoch === stamp.lifecycleEpoch,
        isProgramDisposed: state.isDisposed,
        programLifecycleEpoch: state.lifecycleEpoch,
        runtime: observeScratchRuntimeAuthority(stamp.runtimeAuthority),
    })
}

export function programAuthoritySubject(program: Program): DiagnosticSubject {

    const subject: DiagnosticSubject = {
        kind: 'Program',
        id: program.id,
    }
    let label: unknown
    try {
        label = program.label
    } catch {
        label = undefined
    }
    if (typeof label === 'string') subject.label = label
    return subject
}

function programStateFor(program: Program): ProgramState {

    const state = programStates.get(program)
    if (state === undefined) throw new TypeError('Program private state is unavailable.')
    return state
}

function runProgramFactPhase<T>(authority: ProgramPipelineAuthorityStamp, phase: () => T): T {

    let value: T | undefined
    let failure: unknown
    let failed = false

    try {
        value = phase()
    } catch (error) {
        failed = true
        failure = error
    }

    assertProgramPipelineAuthority(authority)
    if (failed) throw failure
    return value as T
}

function captureProgramPipelineAuthority(
    program: Program,
    runtime: ScratchRuntime
): ProgramPipelineAuthorityStamp {

    assertProgramRuntimeAuthority(program, runtime)
    const state = programStateFor(program)
    return Object.freeze({
        program,
        lifecycleEpoch: state.lifecycleEpoch,
        runtimeAuthority: captureScratchRuntimeAuthority(state.runtime),
    })
}

function assertProgramRuntimeAuthority(program: Program, runtime: ScratchRuntime): void {

    const state = programStateFor(program)
    assertProgramUsableAuthority(program)
    if (runtime === state.runtime) return

    throwScratchDiagnostic({
        code: 'SCRATCH_PROGRAM_WRONG_RUNTIME',
        severity: 'error',
        phase: 'program',
        subject: programAuthoritySubject(program),
        related: [
            scratchRuntimeAuthoritySubject(state.runtime),
            relatedRuntimeSubject(runtime),
        ].filter((subject): subject is DiagnosticSubject => subject !== undefined),
        message: 'Program belongs to a different ScratchRuntime.',
        expected: { runtimeId: state.runtime.id },
        actual: { runtimeId: runtime?.id },
    })
}

function assertProgramNotDisposed(program: Program, state: ProgramState): void {

    if (!state.isDisposed) return
    throwScratchDiagnostic({
        code: 'SCRATCH_PROGRAM_DISPOSED',
        severity: 'error',
        phase: 'program',
        subject: programAuthoritySubject(program),
        message: 'Program has been disposed.',
    })
}

function relatedRuntimeSubject(runtime: ScratchRuntime | undefined): DiagnosticSubject | undefined {

    if (runtime === undefined || runtime === null) return undefined
    try {
        return scratchRuntimeAuthoritySubject(runtime)
    } catch {
        return undefined
    }
}

function materializeProgramPipelineFacts(program: Program): SampledProgramPipelineFacts {

    const modules = program.modules as unknown
    const entryPoints = program.entryPoints as unknown
    const requiredFeatures = program.requiredFeatures as unknown
    const requiredLanguageFeatures = program.requiredLanguageFeatures as unknown
    const layoutRequirements = program.layoutRequirements as unknown

    return Object.freeze({
        modules: materializeProgramModules(modules),
        entryPoints: materializeProgramEntryPoints(entryPoints),
        requiredFeatures: materializeProgramRequiredFeatures(requiredFeatures),
        requiredLanguageFeatures,
        layoutRequirements: materializeProgramLayoutRequirements(layoutRequirements),
    })
}

function materializeProgramModules(modules: unknown): unknown {

    return Array.isArray(modules) ? [ ...modules ] : modules
}

function materializeProgramEntryPoints(entryPoints: unknown): unknown {

    if (!isRecord(entryPoints)) return entryPoints
    return {
        vertex: entryPoints.vertex,
        fragment: entryPoints.fragment,
        compute: entryPoints.compute,
    }
}

function materializeProgramRequiredFeatures(requiredFeatures: unknown): unknown {

    if (requiredFeatures === undefined) return undefined
    return [ ...(requiredFeatures as Iterable<unknown>) ]
}

function materializeProgramLayoutRequirements(layoutRequirements: unknown): unknown {

    if (!Array.isArray(layoutRequirements)) return layoutRequirements
    return layoutRequirements.map(requirement => materializeProgramLayoutRequirement(requirement))
}

function materializeProgramLayoutRequirement(requirement: unknown): unknown {

    if (!isRecord(requirement)) return requirement
    const visibility = requirement.visibility
    return {
        group: requirement.group,
        binding: requirement.binding,
        name: requirement.name,
        type: requirement.type,
        visibility: Array.isArray(visibility) ? [ ...visibility ] : visibility,
        hasDynamicOffset: requirement.hasDynamicOffset,
        layout: requirement.layout,
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
        hasDynamicOffset: requirement.hasDynamicOffset,
        abiByteLength: requirement.layout.byteLength,
        minBindingSize: `0 or >= ${requirement.layout.byteLength}`,
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

function normalizeRequiredLanguageFeatures(
    program: Program,
    requiredLanguageFeatures: unknown
): string[] {

    if (requiredLanguageFeatures === undefined) return []
    if (
        requiredLanguageFeatures === null ||
        typeof requiredLanguageFeatures === 'string' ||
        (
            typeof requiredLanguageFeatures !== 'object' &&
            typeof requiredLanguageFeatures !== 'function'
        )
    ) {
        throwRequiredLanguageFeatureDiagnostic(program, requiredLanguageFeatures)
    }

    let iterator: unknown
    try {
        iterator = (requiredLanguageFeatures as { [Symbol.iterator]?: unknown })[Symbol.iterator]
    } catch {
        throwRequiredLanguageFeatureDiagnostic(
            program,
            requiredLanguageFeatures,
            'iterator property threw'
        )
    }
    if (typeof iterator !== 'function') {
        throwRequiredLanguageFeatureDiagnostic(program, requiredLanguageFeatures)
    }

    let features: unknown[]
    try {
        features = [ ...(requiredLanguageFeatures as Iterable<unknown>) ]
    } catch {
        throwRequiredLanguageFeatureDiagnostic(program, requiredLanguageFeatures, 'iterator threw')
    }

    if (!features.every(feature => typeof feature === 'string' && feature.length > 0)) {
        throwRequiredLanguageFeatureDiagnostic(program, features)
    }

    return features as string[]
}

function normalizeLayoutRequirements(program: Program, layoutRequirements: unknown): readonly ProgramBufferLayoutRequirement[] {

    if (layoutRequirements === undefined) return Object.freeze([])

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
    const normalized = layoutRequirements.map((requirement) => {
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
    return Object.freeze(normalized)
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
    const hasDynamicOffset = requirement.hasDynamicOffset
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

    if (typeof hasDynamicOffset !== 'boolean') {
        throwLayoutRequirementDiagnostic(program, subjectInput, {
            expected: { hasDynamicOffset: 'boolean' },
            actual: { hasDynamicOffset },
        })
    }

    if (!isLayoutArtifact(layout)) {
        throwLayoutRequirementDiagnostic(program, subjectInput, {
            expected: { layout: 'LayoutArtifact' },
            actual: { layout: describeValue(layout) },
        })
    }

    const normalized: ProgramBufferLayoutRequirement = {
        group,
        binding,
        ...(name !== undefined ? { name } : {}),
        type,
        ...(normalizedVisibility !== undefined ? { visibility: normalizedVisibility } : {}),
        hasDynamicOffset,
        layout,
    }

    return Object.freeze(normalized)
}

function normalizeLayoutRequirementVisibility(
    program: Program,
    subjectInput: { group: unknown, binding: unknown, name: unknown },
    visibility: unknown
): readonly BindVisibility[] | undefined {

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

    return Object.freeze([ ...visibility ])
}

function isProgramBufferLayoutRequirementType(type: unknown): type is ProgramBufferLayoutRequirement['type'] {

    return type === 'uniform' || type === 'read-storage' || type === 'storage'
}

function isBindVisibility(stage: unknown): stage is BindVisibility {

    return stage === 'vertex' || stage === 'fragment' || stage === 'compute'
}

function validateRequiredFeatures(
    program: Program,
    runtime: ScratchRuntime,
    requiredFeatures: readonly GPUFeatureName[]
): void {

    for (const feature of requiredFeatures) {
        if (!runtime.deviceFeatures?.has?.(feature)) {
            throwScratchDiagnostic({
                code: 'SCRATCH_PROGRAM_FEATURE_UNAVAILABLE',
                severity: 'error',
                phase: 'program',
                subject: program.subject,
                message: 'Program requires a WebGPU feature that is not available on this runtime.',
                expected: { feature },
                actual: { features: [ ...(runtime.deviceFeatures ?? []) ] },
            })
        }
    }
}

function validateRequiredLanguageFeatures(
    program: Program,
    runtime: ScratchRuntime,
    requiredLanguageFeatures: readonly string[]
): void {

    for (const languageFeature of requiredLanguageFeatures) {
        if (runtime.wgslLanguageFeatures.includes(languageFeature)) continue
        throwScratchDiagnostic({
            code: 'SCRATCH_PROGRAM_LANGUAGE_FEATURE_UNAVAILABLE',
            severity: 'error',
            phase: 'program',
            subject: program.subject,
            related: [ runtime.subject ],
            message: 'Program requires a WGSL language feature that is unavailable on this runtime.',
            expected: { languageFeature },
            actual: { wgslLanguageFeatures: runtime.wgslLanguageFeatures },
        })
    }
}

function throwRequiredLanguageFeatureDiagnostic(
    program: Program,
    actual: unknown,
    reason?: string
): never {

    throwScratchDiagnostic({
        code: 'SCRATCH_PROGRAM_LANGUAGE_FEATURE_UNAVAILABLE',
        severity: 'error',
        phase: 'program',
        subject: program.subject,
        related: [ program.runtime.subject ],
        message: 'Program requiredLanguageFeatures must be a stable iterable of non-empty strings.',
        expected: { requiredLanguageFeatures: 'Iterable<non-empty string>' },
        actual: {
            requiredLanguageFeatures: describeValue(actual),
            wgslLanguageFeatures: program.runtime.wgslLanguageFeatures,
            ...(reason !== undefined ? { reason } : {}),
        },
    })
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

Object.freeze(Program.prototype)
