export type DiagnosticSeverity = 'info' | 'warn' | 'error'

export type DiagnosticPhase =
    | 'runtime'
    | 'resource'
    | 'layout-codec'
    | 'program'
    | 'binding'
    | 'pipeline'
    | 'command'
    | 'submission'
    | 'query'
    | 'readback'

export type DiagnosticSubject = {
    kind: string
    id?: string
    label?: string
    [key: string]: unknown
}

export type DiagnosticSuggestion = {
    kind: string
    confidence: 'low' | 'medium' | 'high'
    target: DiagnosticSubject
    action?: 'edit' | 'add' | 'remove' | 'reorder' | 'declare' | 'dispose'
    set?: unknown
    note?: string
}

export type DiagnosticEvidence = {
    kind: string
    value?: unknown
    note?: string
}

export type ScratchDiagnostic = {
    version: 1
    code: string
    severity: DiagnosticSeverity
    phase: DiagnosticPhase
    subject: DiagnosticSubject
    message: string
    expected?: unknown
    actual?: unknown
    hints?: string[]
    related?: DiagnosticSubject[]
    suggestions?: DiagnosticSuggestion[]
    evidence?: DiagnosticEvidence[]
}

export type ScratchDiagnosticInput = {
    code: string
    severity?: DiagnosticSeverity
    phase: DiagnosticPhase
    subject: DiagnosticSubject
    message?: string
    expected?: unknown
    actual?: unknown
    hint?: string
    hints?: string | string[]
    related?: DiagnosticSubject[]
    suggestions?: DiagnosticSuggestion[]
    evidence?: DiagnosticEvidence[]
}

export type ScratchDiagnosticReport = {
    version: 1
    diagnostics: ScratchDiagnostic[]
    hasErrors: boolean
    errorCount: number
    warningCount: number
}

export function createScratchDiagnostic(input: ScratchDiagnosticInput): ScratchDiagnostic {

    const diagnostic: ScratchDiagnostic = {
        version: 1,
        code: input.code,
        severity: input.severity ?? 'error',
        phase: input.phase,
        subject: input.subject,
        message: input.message ?? input.code,
    }

    if (input.expected !== undefined) diagnostic.expected = input.expected
    if (input.actual !== undefined) diagnostic.actual = input.actual
    if (input.related !== undefined) diagnostic.related = input.related
    if (input.suggestions !== undefined) diagnostic.suggestions = input.suggestions
    if (input.evidence !== undefined) diagnostic.evidence = input.evidence

    const hints = normalizeHints(input.hints ?? input.hint)
    if (hints !== undefined) diagnostic.hints = hints

    return diagnostic
}

export function createScratchDiagnosticReport(diagnostics: ScratchDiagnostic[] = []): ScratchDiagnosticReport {

    let errorCount = 0
    let warningCount = 0

    for (const diagnostic of diagnostics) {
        if (diagnostic.severity === 'error') errorCount++
        if (diagnostic.severity === 'warn') warningCount++
    }

    return {
        version: 1,
        diagnostics,
        hasErrors: errorCount > 0,
        errorCount,
        warningCount,
    }
}

export class ScratchDiagnosticError extends Error {

    diagnostic: ScratchDiagnostic
    report: ScratchDiagnosticReport

    constructor(
        diagnostic: ScratchDiagnostic,
        report = createScratchDiagnosticReport([ diagnostic ]),
        options?: ErrorOptions
    ) {

        super(diagnostic.message, options)

        this.name = 'ScratchDiagnosticError'
        this.diagnostic = diagnostic
        this.report = report
    }
}

export function throwScratchDiagnostic(input: ScratchDiagnosticInput, options?: ErrorOptions): never {

    const diagnostic = createScratchDiagnostic(input)
    throw new ScratchDiagnosticError(diagnostic, createScratchDiagnosticReport([ diagnostic ]), options)
}

function normalizeHints(hints: string | string[] | undefined): string[] | undefined {

    if (hints === undefined) return undefined
    if (Array.isArray(hints)) return hints
    return [ hints ]
}
