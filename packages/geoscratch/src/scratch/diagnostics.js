export function createScratchDiagnostic(input) {

    const diagnostic = {
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

export function createScratchDiagnosticReport(diagnostics = []) {

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

    constructor(diagnostic, report = createScratchDiagnosticReport([ diagnostic ])) {

        super(diagnostic.message)

        this.name = 'ScratchDiagnosticError'
        this.diagnostic = diagnostic
        this.report = report
    }
}

export function throwScratchDiagnostic(input) {

    const diagnostic = createScratchDiagnostic(input)
    throw new ScratchDiagnosticError(diagnostic)
}

function normalizeHints(hints) {

    if (hints === undefined) return undefined
    if (Array.isArray(hints)) return hints
    return [ hints ]
}
