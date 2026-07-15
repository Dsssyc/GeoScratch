import { isBindLayout } from './binding.js'
import { createScratchDiagnostic, createScratchDiagnosticReport, throwScratchDiagnostic } from './diagnostics.js'
import { Program, isProgram } from './program.js'
import { describeValue } from './type-utils.js'
import type { BindLayout, BindLayoutEntry } from './binding.js'
import type { DiagnosticSubject, ScratchDiagnostic, ScratchDiagnosticReport } from './diagnostics.js'

export type ShaderBindingResourceType =
    | 'uniform'
    | 'read-storage'
    | 'storage'
    | 'texture'
    | 'sampler'
    | 'storage-texture'
    | 'external-texture'
    | 'unknown'

export type ShaderBinding = {
    group: number
    binding: number
    name?: string
    type: ShaderBindingResourceType
    moduleIndex: number
    source?: string
    inconclusive?: boolean
}

export type ShaderBindLayoutComparisonOptions = {
    program?: Program
    suppress?: ReadonlyArray<{
        code?: string
        group: number
        binding: number
    }>
}

export type ShaderInspection = {
    modules: string[]
    bindings: ShaderBinding[]
    diagnostics: ScratchDiagnostic[]
    report: ScratchDiagnosticReport
    compareBindLayouts(bindLayouts: ReadonlyArray<BindLayout>, options?: ShaderBindLayoutComparisonOptions): ScratchDiagnosticReport
}

export type ShaderInspectionOptions = {
    program?: Program
}

export type ShaderInspectionInput = string | ReadonlyArray<string> | Program

type BindingClassification = {
    type: ShaderBindingResourceType
    inconclusive?: boolean
}

type BindLayoutEntryRecord = {
    layout: BindLayout
    entry: BindLayoutEntry
}

const SUPPORTED_SHADER_BINDING_TYPES: ShaderBindingResourceType[] = [
    'uniform',
    'read-storage',
    'storage',
    'texture',
    'sampler',
]

const SUPPORTED_SHADER_BINDING_TYPE_SET = new Set<ShaderBindingResourceType>(SUPPORTED_SHADER_BINDING_TYPES)

export function inspectShader(input: ShaderInspectionInput, options: ShaderInspectionOptions = {}): ShaderInspection {

    return new ShaderInspectionResult(input, options)
}

class ShaderInspectionResult implements ShaderInspection {

    modules: string[]
    bindings: ShaderBinding[]
    diagnostics: ScratchDiagnostic[]
    report: ScratchDiagnosticReport
    #program: Program | undefined

    constructor(input: ShaderInspectionInput, options: ShaderInspectionOptions) {

        this.#program = resolveProgram(input, options.program)
        this.modules = normalizeModules(input)

        const inspected = inspectModules(this.modules, this.#program)
        this.bindings = inspected.bindings
        this.diagnostics = inspected.diagnostics
        this.report = createScratchDiagnosticReport(this.diagnostics)
    }

    compareBindLayouts(bindLayouts: ReadonlyArray<BindLayout>, options: ShaderBindLayoutComparisonOptions = {}): ScratchDiagnosticReport {

        const program = options.program === undefined
            ? this.#program
            : resolveProgram('', options.program)
        const diagnostics = [ ...this.diagnostics ]
        const entries = collectBindLayoutEntries(bindLayouts)
        const entriesByKey = new Map(entries.map(record => [ bindingKey(record.layout.group, record.entry.binding), record ]))
        const allShaderBindingKeys = new Set(this.bindings.map(binding => bindingKey(binding.group, binding.binding)))
        const comparableBindings = this.bindings.filter(isComparableShaderBinding)

        for (const binding of comparableBindings) {
            const key = bindingKey(binding.group, binding.binding)
            const record = entriesByKey.get(key)

            if (record === undefined) {
                const diagnostic = createMissingBindLayoutEntryDiagnostic(binding, program)
                if (!isSuppressed(diagnostic, binding.group, binding.binding, options)) diagnostics.push(diagnostic)
                continue
            }

            if (record.entry.type !== binding.type) {
                const diagnostic = createBindTypeMismatchDiagnostic(record, binding, program)
                if (!isSuppressed(diagnostic, binding.group, binding.binding, options)) diagnostics.push(diagnostic)
            }
        }

        for (const record of entries) {
            const key = bindingKey(record.layout.group, record.entry.binding)
            if (allShaderBindingKeys.has(key)) continue

            const diagnostic = createExtraBindLayoutEntryDiagnostic(record, program)
            if (!isSuppressed(diagnostic, record.layout.group, record.entry.binding, options)) diagnostics.push(diagnostic)
        }

        return createScratchDiagnosticReport(diagnostics)
    }
}

function normalizeModules(input: ShaderInspectionInput): string[] {

    if (isProgram(input)) return [ ...input.modules ]
    if (typeof input === 'string') return [ input ]
    if (!Array.isArray(input) || input.some(moduleSource => typeof moduleSource !== 'string')) {
        return throwShaderInspectionProgramInvalid(input)
    }

    return [ ...input ]
}

function resolveProgram(input: ShaderInspectionInput, program: Program | undefined): Program | undefined {

    if (program !== undefined) {
        if (!isProgram(program)) return throwShaderInspectionProgramInvalid(program)
        return program
    }
    if (isProgram(input)) return input

    return undefined
}

function inspectModules(modules: string[], program: Program | undefined): { bindings: ShaderBinding[], diagnostics: ScratchDiagnostic[] } {

    const bindings: ShaderBinding[] = []
    const diagnostics: ScratchDiagnostic[] = []

    modules.forEach((moduleSource, moduleIndex) => {
        inspectModule(moduleSource, moduleIndex, program, bindings, diagnostics)
    })

    return { bindings, diagnostics }
}

function inspectModule(
    moduleSource: string,
    moduleIndex: number,
    program: Program | undefined,
    bindings: ShaderBinding[],
    diagnostics: ScratchDiagnostic[],
) {

    const source = stripComments(moduleSource)
    const statements = source.split(';')

    for (const statement of statements) {
        const normalizedStatement = normalizeStatementSource(statement)
        if (normalizedStatement === '') continue
        if (!normalizedStatement.includes('@group') || !normalizedStatement.includes('@binding')) continue

        const group = readAttributeValue(normalizedStatement, 'group')
        const binding = readAttributeValue(normalizedStatement, 'binding')
        if (group === undefined || binding === undefined) continue

        const varMatch = normalizedStatement.match(/\bvar\s*(?:<\s*([^>]+?)\s*>)?\s+([A-Za-z_]\w*)\s*:\s*(.+)$/s)
        if (varMatch === null) {
            diagnostics.push(createInconclusiveDiagnostic({
                group,
                binding,
                moduleIndex,
                source: normalizedStatement,
                program,
                actual: { source: 'WGSLReflection', group, binding, reason: 'declaration-unmatched' },
            }))
            continue
        }

        const addressSpace = varMatch[1]
        const name = varMatch[2]
        const valueType = varMatch[3].trim()
        const classification = classifyBinding(addressSpace, valueType)
        const shaderBinding: ShaderBinding = {
            group,
            binding,
            name,
            type: classification.type,
            moduleIndex,
            source: normalizedStatement,
        }
        if (classification.inconclusive === true) shaderBinding.inconclusive = true
        bindings.push(shaderBinding)

        if (classification.inconclusive === true) {
            diagnostics.push(createInconclusiveDiagnostic({
                group,
                binding,
                name,
                moduleIndex,
                source: normalizedStatement,
                program,
                actual: {
                    source: 'WGSLReflection',
                    group,
                    binding,
                    type: classification.type,
                },
            }))
        }
    }
}

function stripComments(source: string): string {

    return source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '')
}

function normalizeStatementSource(statement: string): string {

    return statement
        .replace(/\s+/g, ' ')
        .trim()
}

function readAttributeValue(source: string, name: 'group' | 'binding'): number | undefined {

    const match = source.match(new RegExp(`@${name}\\s*\\(\\s*(\\d+)\\s*\\)`))
    if (match === null) return undefined

    return Number(match[1])
}

function classifyBinding(addressSpace: string | undefined, valueType: string): BindingClassification {

    const addressParts = addressSpace?.split(',').map(part => part.trim()).filter(Boolean) ?? []
    const addressKind = addressParts[0]
    const accessKind = addressParts[1]

    if (addressKind === 'uniform') return { type: 'uniform' }

    if (addressKind === 'storage') {
        if (accessKind === 'read') return { type: 'read-storage' }
        return { type: 'storage' }
    }

    if (/^texture_storage_/.test(valueType)) {
        return { type: 'storage-texture', inconclusive: true }
    }

    if (/^texture_external\b/.test(valueType)) {
        return { type: 'external-texture', inconclusive: true }
    }

    if (/^texture_/.test(valueType)) {
        return { type: 'texture' }
    }

    if (/^sampler(?:_comparison)?\b/.test(valueType)) {
        return { type: 'sampler' }
    }

    return { type: 'unknown', inconclusive: true }
}

function createInconclusiveDiagnostic(input: {
    group: number
    binding: number
    name?: string
    moduleIndex: number
    source: string
    program: Program | undefined
    actual: unknown
}): ScratchDiagnostic {

    const shaderSubject = shaderBindingSubject(input)

    return createScratchDiagnostic({
        code: 'SCRATCH_PROGRAM_SHADER_REFLECTION_INCONCLUSIVE',
        severity: 'warn',
        phase: 'program',
        subject: input.program?.subject ?? shaderSubject,
        related: input.program === undefined ? [] : [ shaderSubject ],
        message: 'Shader binding inspection could not conclusively classify a WGSL binding declaration.',
        expected: {
            source: 'WGSLReflection',
            supportedTypes: [ ...SUPPORTED_SHADER_BINDING_TYPES ],
        },
        actual: input.actual,
        evidence: [
            {
                kind: 'WGSLDeclaration',
                value: {
                    moduleIndex: input.moduleIndex,
                    source: input.source,
                },
            },
        ],
    })
}

function collectBindLayoutEntries(bindLayouts: ReadonlyArray<BindLayout>): BindLayoutEntryRecord[] {

    if (!Array.isArray(bindLayouts)) return throwShaderInspectionBindLayoutInvalid(bindLayouts)
    const records: BindLayoutEntryRecord[] = []

    for (const layout of bindLayouts) {
        if (!isBindLayout(layout)) return throwShaderInspectionBindLayoutInvalid(layout)
        for (const entry of layout.entries) {
            records.push({ layout, entry })
        }
    }

    return records.sort((left, right) => {
        const groupDelta = left.layout.group - right.layout.group
        if (groupDelta !== 0) return groupDelta

        const bindingDelta = left.entry.binding - right.entry.binding
        if (bindingDelta !== 0) return bindingDelta

        return left.entry.name.localeCompare(right.entry.name)
    })
}

function throwShaderInspectionProgramInvalid(program: unknown): never {

    throwScratchDiagnostic({
        code: 'SCRATCH_PROGRAM_MODULES_INVALID',
        severity: 'error',
        phase: 'program',
        subject: { kind: 'Program' },
        message: 'Shader inspection requires a constructed Program or explicit WGSL modules.',
        expected: { input: 'Program, string, or string[]' },
        actual: { input: describeValue(program) },
    })
}

function throwShaderInspectionBindLayoutInvalid(layout: unknown): never {

    throwScratchDiagnostic({
        code: 'SCRATCH_BIND_LAYOUT_DESCRIPTOR_INVALID',
        severity: 'error',
        phase: 'binding',
        subject: { kind: 'BindLayout' },
        message: 'Shader inspection comparison requires constructed BindLayout objects.',
        expected: { bindLayouts: 'BindLayout[]' },
        actual: { bindLayout: describeValue(layout) },
    })
}

function isComparableShaderBinding(binding: ShaderBinding): boolean {

    return binding.inconclusive !== true && SUPPORTED_SHADER_BINDING_TYPE_SET.has(binding.type)
}

function createMissingBindLayoutEntryDiagnostic(binding: ShaderBinding, program: Program | undefined): ScratchDiagnostic {

    return createScratchDiagnostic({
        code: 'SCRATCH_BIND_SHADER_INDEX_MISMATCH',
        severity: 'warn',
        phase: 'binding',
        subject: shaderBindingSubject(binding),
        related: relatedSubjects(undefined, program),
        message: 'Shader binding has no matching explicit bind entry.',
        expected: {
            source: 'WGSLReflection',
            group: binding.group,
            binding: binding.binding,
            type: binding.type,
        },
        actual: {
            source: 'BindLayout',
            present: false,
        },
    })
}

function createExtraBindLayoutEntryDiagnostic(record: BindLayoutEntryRecord, program: Program | undefined): ScratchDiagnostic {

    return createScratchDiagnostic({
        code: 'SCRATCH_BIND_SHADER_INDEX_MISMATCH',
        severity: 'warn',
        phase: 'binding',
        subject: record.layout.entrySubject(record.entry),
        related: relatedSubjects(undefined, program),
        message: 'Explicit bind entry has no matching shader binding.',
        expected: {
            source: 'WGSLReflection',
            present: false,
        },
        actual: {
            source: 'BindLayout',
            group: record.layout.group,
            binding: record.entry.binding,
            type: record.entry.type,
        },
    })
}

function createBindTypeMismatchDiagnostic(record: BindLayoutEntryRecord, binding: ShaderBinding, program: Program | undefined): ScratchDiagnostic {

    return createScratchDiagnostic({
        code: 'SCRATCH_BIND_SHADER_TYPE_MISMATCH',
        severity: 'warn',
        phase: 'binding',
        subject: record.layout.entrySubject(record.entry),
        related: relatedSubjects(binding, program),
        message: 'Explicit bind entry type does not match the shader binding type.',
        expected: {
            source: 'BindLayout',
            group: record.layout.group,
            binding: record.entry.binding,
            type: record.entry.type,
        },
        actual: {
            source: 'WGSLReflection',
            group: binding.group,
            binding: binding.binding,
            type: binding.type,
        },
    })
}

function relatedSubjects(binding: ShaderBinding | undefined, program: Program | undefined): DiagnosticSubject[] {

    const related: DiagnosticSubject[] = []
    if (binding !== undefined) related.push(shaderBindingSubject(binding))
    if (program !== undefined) related.push(program.subject)

    return related
}

function shaderBindingSubject(binding: Pick<ShaderBinding, 'group' | 'binding'> & { name?: unknown }): DiagnosticSubject {

    const subject: DiagnosticSubject = {
        kind: 'ShaderBinding',
        group: binding.group,
        binding: binding.binding,
    }
    if (typeof binding.name === 'string') subject.name = binding.name

    return subject
}

function bindingKey(group: number, binding: number): string {

    return `${group}:${binding}`
}

function isSuppressed(
    diagnostic: ScratchDiagnostic,
    group: number,
    binding: number,
    options: ShaderBindLayoutComparisonOptions,
): boolean {

    return options.suppress?.some(suppression => {
        if (suppression.group !== group || suppression.binding !== binding) return false
        if (suppression.code !== undefined && suppression.code !== diagnostic.code) return false

        return true
    }) ?? false
}
