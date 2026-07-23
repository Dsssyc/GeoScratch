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
import { isShaderModule } from './shader-module.js'
import { describeValue, isRecord } from './type-utils.js'
import type { BindVisibility } from './binding.js'
import type { DiagnosticSubject } from './diagnostics.js'
import type { LayoutArtifact } from './layout-codec.js'
import type { ScratchRuntime } from './runtime.js'
import type {
    ScratchRuntimeAuthorityObservation,
    ScratchRuntimeAuthorityStamp,
} from './runtime-authority.js'
import type { ShaderModule } from './shader-module.js'

const ALIGNMENT_LIMITS = new Set([
    'minUniformBufferOffsetAlignment',
    'minStorageBufferOffsetAlignment',
])

export type ProgramStage = Readonly<{
    module: ShaderModule
    entryPoint?: string
    constants?: Readonly<Record<string, GPUPipelineConstantValue>>
}>

export type ProgramBufferLayoutRequirement = Readonly<{
    group: number
    binding: number
    name?: string
    type: 'uniform' | 'read-storage' | 'storage'
    visibility?: readonly BindVisibility[]
    hasDynamicOffset: boolean
    layout: LayoutArtifact
}>

export type ProgramDescriptor = Readonly<{
    label?: string
    vertex?: ProgramStage
    fragment?: ProgramStage
    compute?: ProgramStage
    requiredFeatures?: Iterable<GPUFeatureName>
    requiredLimits?: Readonly<Record<string, GPUSize64 | undefined>>
    requiredLanguageFeatures?: Iterable<string>
    layoutRequirements?: readonly ProgramBufferLayoutRequirement[]
}>

type ProgramState = {
    runtime: ScratchRuntime
    isDisposed: boolean
    lifecycleEpoch: number
}

export type ProgramPipelineFacts = Readonly<{
    vertex?: ProgramStage
    fragment?: ProgramStage
    compute?: ProgramStage
    requiredFeatures: readonly GPUFeatureName[]
    requiredLimits: Readonly<Record<string, GPUSize64 | undefined>>
    requiredLanguageFeatures: readonly string[]
    layoutRequirements: readonly ProgramBufferLayoutRequirement[]
    sourcePartDependencies: readonly LayoutArtifact[]
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

const programStates = new WeakMap<Program, ProgramState>()

export interface Program {
    readonly runtime: ScratchRuntime
    readonly id: string
    readonly label?: string
    readonly vertex?: ProgramStage
    readonly fragment?: ProgramStage
    readonly compute?: ProgramStage
    readonly requiredFeatures: readonly GPUFeatureName[]
    readonly requiredLimits: Readonly<Record<string, GPUSize64 | undefined>>
    readonly requiredLanguageFeatures: readonly string[]
    readonly layoutRequirements: readonly ProgramBufferLayoutRequirement[]
    readonly sourcePartDependencies: readonly LayoutArtifact[]
}

export class Program {

    constructor(runtime: ScratchRuntime, descriptor: ProgramDescriptor) {

        const runtimeAuthority = captureScratchRuntimeAuthority(runtime)
        const id = `scratch-program-${UUID()}`
        const subject = programSubjectFrom(id, descriptor?.label)
        const normalized = normalizeProgramDescriptor(runtime, subject, descriptor)
        assertScratchRuntimeAuthority(runtimeAuthority)

        programStates.set(this, { runtime, isDisposed: false, lifecycleEpoch: 0 })
        Object.defineProperties(this, {
            runtime: immutableEnumerableProperty(runtime),
            id: immutableEnumerableProperty(id),
            ...(normalized.label !== undefined
                ? { label: immutableEnumerableProperty(normalized.label) }
                : {}),
            ...(normalized.vertex !== undefined
                ? { vertex: immutableEnumerableProperty(normalized.vertex) }
                : {}),
            ...(normalized.fragment !== undefined
                ? { fragment: immutableEnumerableProperty(normalized.fragment) }
                : {}),
            ...(normalized.compute !== undefined
                ? { compute: immutableEnumerableProperty(normalized.compute) }
                : {}),
            requiredFeatures: immutableEnumerableProperty(normalized.requiredFeatures),
            requiredLimits: immutableEnumerableProperty(normalized.requiredLimits),
            requiredLanguageFeatures: immutableEnumerableProperty(
                normalized.requiredLanguageFeatures
            ),
            layoutRequirements: immutableEnumerableProperty(normalized.layoutRequirements),
            sourcePartDependencies: immutableEnumerableProperty(
                normalized.sourcePartDependencies
            ),
        })
        Object.preventExtensions(this)
    }

    get isDisposed(): boolean {

        return programStateFor(this).isDisposed
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
    const facts = Object.freeze({
        ...(program.vertex !== undefined ? { vertex: snapshotProgramStage(program.vertex) } : {}),
        ...(program.fragment !== undefined ? { fragment: snapshotProgramStage(program.fragment) } : {}),
        ...(program.compute !== undefined ? { compute: snapshotProgramStage(program.compute) } : {}),
        requiredFeatures: program.requiredFeatures,
        requiredLimits: program.requiredLimits,
        requiredLanguageFeatures: program.requiredLanguageFeatures,
        layoutRequirements: program.layoutRequirements,
        sourcePartDependencies: program.sourcePartDependencies,
    })
    assertProgramPipelineAuthority(authority)
    for (const stage of [ facts.vertex, facts.fragment, facts.compute ]) {
        if (stage === undefined) continue
        stage.module.assertRuntime(runtime)
    }
    validateRequiredFeatures(program, runtime, facts.requiredFeatures)
    validateRequiredLimits(program, runtime, facts.requiredLimits)
    validateRequiredLanguageFeatures(program, runtime, facts.requiredLanguageFeatures)
    assertProgramPipelineAuthority(authority)

    return Object.freeze({ facts, authority })
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
            hints: [ 'Create a new pipeline candidate from a current Program.' ],
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

    return programSubjectFrom(program.id, program.label)
}

export function programLayoutRequirementSubject(
    requirement: Pick<ProgramBufferLayoutRequirement, 'group' | 'binding'> & {
        name?: unknown
    }
): DiagnosticSubject {

    const subject: DiagnosticSubject = {
        kind: 'ShaderBinding',
        group: requirement.group,
        binding: requirement.binding,
        stage: 'buffer',
    }
    if (typeof requirement.name === 'string') subject.name = requirement.name
    return subject
}

export function programLayoutRequirementExpected(
    requirement: ProgramBufferLayoutRequirement
) {

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

function normalizeProgramDescriptor(
    runtime: ScratchRuntime,
    subject: DiagnosticSubject,
    descriptor: unknown
): ProgramPipelineFacts & Readonly<{ label?: string }> {

    if (!isRecord(descriptor)) {
        throwProgramDescriptorInvalid(subject, 'descriptor', descriptor)
    }
    if (descriptor.label !== undefined && typeof descriptor.label !== 'string') {
        throwProgramDescriptorInvalid(subject, 'label', descriptor.label)
    }
    const vertex = normalizeProgramStage(runtime, subject, 'vertex', descriptor.vertex)
    const fragment = normalizeProgramStage(runtime, subject, 'fragment', descriptor.fragment)
    const compute = normalizeProgramStage(runtime, subject, 'compute', descriptor.compute)
    if (vertex === undefined && fragment === undefined && compute === undefined) {
        throwScratchDiagnostic({
            code: 'SCRATCH_PROGRAM_STAGE_MISSING',
            severity: 'error',
            phase: 'program',
            subject,
            message: 'Program requires at least one ShaderModule stage.',
            expected: { stages: 'vertex, fragment, or compute' },
            actual: { vertex: false, fragment: false, compute: false },
        })
    }

    const requiredFeatures = Object.freeze(
        normalizeStringIterable<GPUFeatureName>(
            subject,
            'requiredFeatures',
            descriptor.requiredFeatures
        )
    )
    const requiredLimits = normalizeRequiredLimits(
        subject,
        descriptor.requiredLimits
    )
    const requiredLanguageFeatures = Object.freeze(
        normalizeStringIterable(
            subject,
            'requiredLanguageFeatures',
            descriptor.requiredLanguageFeatures
        )
    )
    const layoutRequirements = normalizeLayoutRequirements(
        subject,
        descriptor.layoutRequirements
    )
    const sourcePartDependencies = collectSourcePartDependencies([
        vertex,
        fragment,
        compute,
    ])

    const normalized = Object.freeze({
        ...(descriptor.label !== undefined ? { label: descriptor.label } : {}),
        ...(vertex !== undefined ? { vertex } : {}),
        ...(fragment !== undefined ? { fragment } : {}),
        ...(compute !== undefined ? { compute } : {}),
        requiredFeatures,
        requiredLimits,
        requiredLanguageFeatures,
        layoutRequirements,
        sourcePartDependencies,
    })
    const placeholder = {
        id: typeof subject.id === 'string' ? subject.id : 'scratch-program-pending',
        runtime,
        label: descriptor.label,
        subject,
    } as unknown as Program
    validateRequiredFeatures(placeholder, runtime, requiredFeatures)
    validateRequiredLimits(placeholder, runtime, requiredLimits)
    validateRequiredLanguageFeatures(placeholder, runtime, requiredLanguageFeatures)
    return normalized
}

function normalizeProgramStage(
    runtime: ScratchRuntime,
    subject: DiagnosticSubject,
    stageName: 'vertex' | 'fragment' | 'compute',
    value: unknown
): ProgramStage | undefined {

    if (value === undefined) return undefined
    if (!isRecord(value) || !isShaderModule(value.module)) {
        throwScratchDiagnostic({
            code: 'SCRATCH_PROGRAM_STAGE_INVALID',
            severity: 'error',
            phase: 'program',
            subject: {
                kind: 'ShaderEntryPoint',
                programId: subject.id,
                stage: stageName,
            },
            related: [ subject ],
            message: 'Program stage requires an acknowledged ShaderModule.',
            expected: { module: 'ShaderModule' },
            actual: { module: describeValue(isRecord(value) ? value.module : value) },
        })
    }
    value.module.assertRuntime(runtime)
    if (
        value.entryPoint !== undefined &&
        (
            typeof value.entryPoint !== 'string' ||
            value.entryPoint.length === 0
        )
    ) {
        throwScratchDiagnostic({
            code: 'SCRATCH_PROGRAM_ENTRY_POINT_INVALID',
            severity: 'error',
            phase: 'program',
            subject: {
                kind: 'ShaderEntryPoint',
                programId: subject.id,
                stage: stageName,
                name: String(value.entryPoint),
            },
            related: [ subject, value.module.subject ],
            message: 'Program stage entry point must be a non-empty string when present.',
            expected: { entryPoint: 'non-empty string or omitted' },
            actual: { entryPoint: value.entryPoint },
        })
    }
    const constants = normalizeStageConstants(subject, stageName, value.constants)
    return Object.freeze({
        module: value.module,
        ...(value.entryPoint !== undefined ? { entryPoint: value.entryPoint } : {}),
        ...(constants !== undefined ? { constants } : {}),
    })
}

function normalizeStageConstants(
    subject: DiagnosticSubject,
    stage: string,
    value: unknown
): Readonly<Record<string, GPUPipelineConstantValue>> | undefined {

    if (value === undefined) return undefined
    if (!isRecord(value)) {
        throwProgramDescriptorInvalid(subject, `${stage}.constants`, value)
    }
    const normalized: Record<string, GPUPipelineConstantValue> = {}
    for (const [ name, constant ] of Object.entries(value)) {
        if (
            typeof constant !== 'number' ||
            !Number.isFinite(constant)
        ) {
            throwProgramDescriptorInvalid(
                subject,
                `${stage}.constants.${name}`,
                constant
            )
        }
        normalized[name] = constant
    }
    return Object.freeze(normalized)
}

function snapshotProgramStage(stage: ProgramStage): ProgramStage {

    return Object.freeze({
        module: stage.module,
        ...(stage.entryPoint !== undefined ? { entryPoint: stage.entryPoint } : {}),
        ...(stage.constants !== undefined
            ? { constants: Object.freeze({ ...stage.constants }) }
            : {}),
    })
}

function normalizeStringIterable<T extends string>(
    subject: DiagnosticSubject,
    field: string,
    value: unknown
): T[] {

    if (value === undefined) return []
    if (
        value === null ||
        typeof value === 'string' ||
        (
            typeof value !== 'object' &&
            typeof value !== 'function'
        )
    ) {
        throwProgramDescriptorInvalid(subject, field, value)
    }
    let values: unknown[]
    try {
        values = [ ...(value as Iterable<unknown>) ]
    } catch {
        throwProgramDescriptorInvalid(subject, field, value, 'iterator failed')
    }
    if (!values.every(item => typeof item === 'string' && item.length > 0)) {
        throwProgramDescriptorInvalid(subject, field, values)
    }
    return values as T[]
}

function normalizeRequiredLimits(
    subject: DiagnosticSubject,
    value: unknown
): Readonly<Record<string, GPUSize64 | undefined>> {

    if (value === undefined) return Object.freeze({})
    if (!isRecord(value)) {
        throwProgramDescriptorInvalid(subject, 'requiredLimits', value)
    }
    const limits: Record<string, GPUSize64 | undefined> = {}
    for (const [ name, limit ] of Object.entries(value)) {
        if (
            limit !== undefined &&
            (
                typeof limit !== 'number' ||
                !Number.isSafeInteger(limit) ||
                limit < 0
            )
        ) {
            throwProgramDescriptorInvalid(subject, `requiredLimits.${name}`, limit)
        }
        limits[name] = limit as GPUSize64 | undefined
    }
    return Object.freeze(limits)
}

function normalizeLayoutRequirements(
    subject: DiagnosticSubject,
    value: unknown
): readonly ProgramBufferLayoutRequirement[] {

    if (value === undefined) return Object.freeze([])
    if (!Array.isArray(value)) {
        throwLayoutRequirementDiagnostic(subject, {}, {
            expected: { layoutRequirements: 'ProgramBufferLayoutRequirement[]' },
            actual: { layoutRequirements: describeValue(value) },
        })
    }
    const seen = new Set<string>()
    const normalized = value.map(requirement => {
        const result = normalizeLayoutRequirement(subject, requirement)
        const key = `${result.group}:${result.binding}`
        if (seen.has(key)) {
            throwLayoutRequirementDiagnostic(subject, result, {
                expected: { unique: [ 'group', 'binding' ] },
                actual: { group: result.group, binding: result.binding },
            })
        }
        seen.add(key)
        return result
    })
    return Object.freeze(normalized)
}

function normalizeLayoutRequirement(
    subject: DiagnosticSubject,
    requirement: unknown
): ProgramBufferLayoutRequirement {

    if (!isRecord(requirement)) {
        throwLayoutRequirementDiagnostic(subject, {}, {
            expected: { requirement: 'ProgramBufferLayoutRequirement' },
            actual: { requirement: describeValue(requirement) },
        })
    }
    const { group, binding, name, type, visibility, hasDynamicOffset, layout } = requirement
    if (typeof group !== 'number' || !Number.isInteger(group) || group < 0) {
        throwLayoutRequirementDiagnostic(subject, requirement, {
            expected: { group: 'non-negative integer' },
            actual: { group },
        })
    }
    if (typeof binding !== 'number' || !Number.isInteger(binding) || binding < 0) {
        throwLayoutRequirementDiagnostic(subject, requirement, {
            expected: { binding: 'non-negative integer' },
            actual: { binding },
        })
    }
    if (name !== undefined && (typeof name !== 'string' || name.length === 0)) {
        throwLayoutRequirementDiagnostic(subject, requirement, {
            expected: { name: 'non-empty string' },
            actual: { name },
        })
    }
    if (type !== 'uniform' && type !== 'read-storage' && type !== 'storage') {
        throwLayoutRequirementDiagnostic(subject, requirement, {
            expected: { type: [ 'uniform', 'read-storage', 'storage' ] },
            actual: { type },
        })
    }
    const normalizedVisibility = normalizeVisibility(subject, requirement, visibility)
    if (typeof hasDynamicOffset !== 'boolean') {
        throwLayoutRequirementDiagnostic(subject, requirement, {
            expected: { hasDynamicOffset: 'boolean' },
            actual: { hasDynamicOffset },
        })
    }
    if (!isLayoutArtifact(layout)) {
        throwLayoutRequirementDiagnostic(subject, requirement, {
            expected: { layout: 'LayoutArtifact' },
            actual: { layout: describeValue(layout) },
        })
    }
    return Object.freeze({
        group,
        binding,
        ...(name !== undefined ? { name } : {}),
        type,
        ...(normalizedVisibility !== undefined ? { visibility: normalizedVisibility } : {}),
        hasDynamicOffset,
        layout,
    })
}

function normalizeVisibility(
    subject: DiagnosticSubject,
    requirement: Record<string, unknown>,
    value: unknown
): readonly BindVisibility[] | undefined {

    if (value === undefined) return undefined
    if (!Array.isArray(value) || value.length === 0) {
        throwLayoutRequirementDiagnostic(subject, requirement, {
            expected: { visibility: 'non-empty stage array' },
            actual: { visibility: value },
        })
    }
    if (!value.every(stage =>
        stage === 'vertex' || stage === 'fragment' || stage === 'compute'
    )) {
        throwLayoutRequirementDiagnostic(subject, requirement, {
            expected: { visibility: [ 'vertex', 'fragment', 'compute' ] },
            actual: { visibility: value },
        })
    }
    return Object.freeze([ ...value ]) as readonly BindVisibility[]
}

function collectSourcePartDependencies(
    stages: readonly (ProgramStage | undefined)[]
): readonly LayoutArtifact[] {

    const dependencies = new Set<LayoutArtifact>()
    for (const stage of stages) {
        if (stage === undefined) continue
        for (const sourcePart of stage.module.sourceParts) {
            for (const dependency of sourcePart.layoutDependencies) {
                dependencies.add(dependency)
            }
        }
    }
    return Object.freeze([ ...dependencies ])
}

function validateRequiredFeatures(
    program: Program,
    runtime: ScratchRuntime,
    requiredFeatures: readonly GPUFeatureName[]
): void {

    for (const feature of requiredFeatures) {
        if (runtime.deviceFeatures?.has?.(feature)) continue
        throwScratchDiagnostic({
            code: 'SCRATCH_PROGRAM_FEATURE_UNAVAILABLE',
            severity: 'error',
            phase: 'program',
            subject: programSubjectForValidation(program),
            message: 'Program requires a WebGPU feature unavailable on this Runtime.',
            expected: { feature },
            actual: { features: [ ...(runtime.deviceFeatures ?? []) ] },
        })
    }
}

function validateRequiredLimits(
    program: Program,
    runtime: ScratchRuntime,
    requiredLimits: Readonly<Record<string, GPUSize64 | undefined>>
): void {

    const limits = runtime.deviceLimits as unknown as Record<string, unknown>
    for (const [ name, required ] of Object.entries(requiredLimits)) {
        if (required === undefined) continue
        const available = limits[name]
        if (typeof available !== 'number') {
            throwScratchDiagnostic({
                code: 'SCRATCH_PROGRAM_LIMIT_UNAVAILABLE',
                severity: 'error',
                phase: 'program',
                subject: programSubjectForValidation(program),
                message: 'Program requires an unknown WebGPU device limit.',
                expected: { limit: name, required },
                actual: { available: describeValue(available) },
            })
        }
        const satisfied = ALIGNMENT_LIMITS.has(name)
            ? available <= required
            : available >= required
        if (satisfied) continue
        throwScratchDiagnostic({
            code: 'SCRATCH_PROGRAM_LIMIT_UNAVAILABLE',
            severity: 'error',
            phase: 'program',
            subject: programSubjectForValidation(program),
            message: 'Program requires a WebGPU device limit unavailable on this Runtime.',
            expected: {
                limit: name,
                required,
                comparison: ALIGNMENT_LIMITS.has(name)
                    ? 'available <= required'
                    : 'available >= required',
            },
            actual: { available },
        })
    }
}

function validateRequiredLanguageFeatures(
    program: Program,
    runtime: ScratchRuntime,
    features: readonly string[]
): void {

    for (const languageFeature of features) {
        if (runtime.wgslLanguageFeatures.includes(languageFeature)) continue
        throwScratchDiagnostic({
            code: 'SCRATCH_PROGRAM_LANGUAGE_FEATURE_UNAVAILABLE',
            severity: 'error',
            phase: 'program',
            subject: programSubjectForValidation(program),
            related: [ runtime.subject ],
            message: 'Program requires a WGSL language feature unavailable on this Runtime.',
            expected: { languageFeature },
            actual: { wgslLanguageFeatures: runtime.wgslLanguageFeatures },
        })
    }
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
        ].filter((value): value is DiagnosticSubject => value !== undefined),
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

function programStateFor(program: Program): ProgramState {

    const state = programStates.get(program)
    if (state === undefined) throw new TypeError('Program private state is unavailable.')
    return state
}

function programSubjectForValidation(program: Program): DiagnosticSubject {

    try {
        return program.subject
    } catch {
        const candidate = program as unknown as {
            id?: unknown
            label?: unknown
            subject?: unknown
        }
        if (isRecord(candidate.subject)) return candidate.subject as DiagnosticSubject
        return programSubjectFrom(
            typeof candidate.id === 'string' ? candidate.id : 'scratch-program-pending',
            typeof candidate.label === 'string' ? candidate.label : undefined
        )
    }
}

function programSubjectFrom(id: string, label?: unknown): DiagnosticSubject {

    return {
        kind: 'Program',
        id,
        ...(typeof label === 'string' ? { label } : {}),
    }
}

function relatedRuntimeSubject(runtime: ScratchRuntime | undefined): DiagnosticSubject | undefined {

    if (runtime === undefined || runtime === null) return undefined
    try {
        return scratchRuntimeAuthoritySubject(runtime)
    } catch {
        return undefined
    }
}

function throwProgramDescriptorInvalid(
    subject: DiagnosticSubject,
    field: string,
    actual: unknown,
    reason?: string
): never {

    throwScratchDiagnostic({
        code: 'SCRATCH_PROGRAM_DESCRIPTOR_INVALID',
        severity: 'error',
        phase: 'program',
        subject,
        message: 'Program descriptor is invalid.',
        expected: { field: 'valid Program descriptor value' },
        actual: {
            field,
            value: describeValue(actual),
            ...(reason !== undefined ? { reason } : {}),
        },
    })
}

function throwLayoutRequirementDiagnostic(
    programSubject: DiagnosticSubject,
    requirement: Record<string, unknown>,
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
        related: [ programSubject ],
        message: 'Program buffer layout requirement is invalid.',
        expected: details.expected,
        actual: details.actual,
    })
}

function immutableEnumerableProperty<T>(value: T): PropertyDescriptor {

    return {
        value,
        enumerable: true,
        configurable: false,
        writable: false,
    }
}

Object.freeze(Program.prototype)
