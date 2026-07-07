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

export function createScratchDiagnostic(input: ScratchDiagnosticInput): ScratchDiagnostic

export function createScratchDiagnosticReport(diagnostics?: ScratchDiagnostic[]): ScratchDiagnosticReport

export class ScratchDiagnosticError extends Error {
    readonly diagnostic: ScratchDiagnostic
    readonly report: ScratchDiagnosticReport
    constructor(diagnostic: ScratchDiagnostic, report?: ScratchDiagnosticReport)
}

export function throwScratchDiagnostic(input: ScratchDiagnosticInput): never
