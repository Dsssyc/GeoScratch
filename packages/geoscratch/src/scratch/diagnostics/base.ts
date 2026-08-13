import type { GPUIncidentReport } from '../gpu/gpu-operation.js'
import type { WorkerRemoteErrorFacts } from '../worker/worker-system.js'
import type { CacheStorageErrorFacts } from '../cache/diagnostics.js'

export type ScratchDiagnosticDomain = 'gpu' | 'worker' | 'cache'
export type ScratchDiagnosticSeverity = 'info' | 'warn' | 'error'

export type ScratchDiagnosticSubject = Readonly<{
    kind: string
    id?: string
    label?: string
    [key: string]: unknown
}>

export type ScratchDiagnosticSuggestion = Readonly<{
    kind: string
    confidence: 'low' | 'medium' | 'high'
    target: ScratchDiagnosticSubject
    action?: 'edit' | 'add' | 'remove' | 'reorder' | 'declare' | 'dispose'
    set?: unknown
    note?: string
}>

export type ScratchDiagnosticEvidence = Readonly<{
    kind: string
    value?: unknown
    note?: string
}>

export type ScratchDiagnosticBase<
    Domain extends ScratchDiagnosticDomain,
    Code extends string,
    Phase extends string,
    Subject extends ScratchDiagnosticSubject,
> = Readonly<{
    version: 1
    domain: Domain
    code: Code
    severity: ScratchDiagnosticSeverity
    phase: Phase
    subject: Subject
    message: string
    expected?: unknown
    actual?: unknown
    hints?: readonly string[]
    related?: readonly ScratchDiagnosticSubject[]
    suggestions?: readonly ScratchDiagnosticSuggestion[]
    evidence?: readonly ScratchDiagnosticEvidence[]
}>

export type ScratchDiagnosticInput<
    Domain extends ScratchDiagnosticDomain = ScratchDiagnosticDomain,
    Code extends string = string,
    Phase extends string = string,
    Subject extends ScratchDiagnosticSubject = ScratchDiagnosticSubject,
> = Readonly<{
    domain: Domain
    code: Code
    severity?: ScratchDiagnosticSeverity
    phase: Phase
    subject: Subject
    message?: string
    expected?: unknown
    actual?: unknown
    hint?: string
    hints?: string | readonly string[]
    related?: readonly ScratchDiagnosticSubject[]
    suggestions?: readonly ScratchDiagnosticSuggestion[]
    evidence?: readonly ScratchDiagnosticEvidence[]
}>

type AnyScratchDiagnostic = ScratchDiagnosticBase<
    ScratchDiagnosticDomain,
    string,
    string,
    ScratchDiagnosticSubject
>

export type ScratchDiagnosticReport<
    Diagnostic extends AnyScratchDiagnostic = AnyScratchDiagnostic,
> = Readonly<{
    version: 1
    diagnostics: readonly Diagnostic[]
    hasErrors: boolean
    errorCount: number
    warningCount: number
}>

export type ScratchDiagnosticErrorContext =
    | Readonly<{ domain: 'gpu', incident?: GPUIncidentReport }>
    | Readonly<{ domain: 'worker', remote?: WorkerRemoteErrorFacts }>
    | Readonly<{ domain: 'cache', storage?: CacheStorageErrorFacts }>

type DiagnosticContext<Diagnostic extends AnyScratchDiagnostic> = Extract<
    ScratchDiagnosticErrorContext,
    { domain: Diagnostic['domain'] }
>

export type ScratchDiagnosticErrorOptions<
    Diagnostic extends AnyScratchDiagnostic = AnyScratchDiagnostic,
> = ErrorOptions & Readonly<{
    context?: DiagnosticContext<Diagnostic>
}>

/** Creates the immutable domain-neutral diagnostic envelope used by every Scratch subsystem. */
export function createScratchDiagnostic<
    const Domain extends ScratchDiagnosticDomain,
    const Code extends string,
    const Phase extends string,
    const Subject extends ScratchDiagnosticSubject,
>(input: ScratchDiagnosticInput<Domain, Code, Phase, Subject>): ScratchDiagnosticBase<
    Domain,
    Code,
    Phase,
    Subject
> {

    if (input.domain !== 'gpu' && input.domain !== 'worker' && input.domain !== 'cache') {
        throw new TypeError('Scratch diagnostics require an explicit gpu, worker, or cache domain.')
    }
    const hints = normalizeHints(input.hints ?? input.hint)
    const diagnostic = {
        version: 1 as const,
        domain: input.domain,
        code: input.code,
        severity: input.severity ?? 'error',
        phase: input.phase,
        subject: freezeSubject(input.subject) as Subject,
        message: input.message ?? input.code,
        ...(input.expected === undefined ? {} : { expected: input.expected }),
        ...(input.actual === undefined ? {} : { actual: input.actual }),
        ...(hints === undefined ? {} : { hints }),
        ...(input.related === undefined ? {} : {
            related: Object.freeze(input.related.map(freezeSubject)),
        }),
        ...(input.suggestions === undefined ? {} : {
            suggestions: Object.freeze(input.suggestions.map(suggestion => Object.freeze({
                ...suggestion,
                target: freezeSubject(suggestion.target),
            }))),
        }),
        ...(input.evidence === undefined ? {} : {
            evidence: Object.freeze(input.evidence.map(entry => Object.freeze({ ...entry }))),
        }),
    }

    return Object.freeze(diagnostic)
}

/** Aggregates immutable diagnostics and severity counts without losing individual evidence. */
export function createScratchDiagnosticReport<
    const Diagnostic extends AnyScratchDiagnostic,
>(diagnostics: readonly Diagnostic[] = []): ScratchDiagnosticReport<Diagnostic> {

    const immutableDiagnostics = diagnostics.map(freezeDiagnosticEnvelope)
    let errorCount = 0
    let warningCount = 0

    for (const diagnostic of immutableDiagnostics) {
        if (diagnostic.severity === 'error') errorCount++
        if (diagnostic.severity === 'warn') warningCount++
    }

    return Object.freeze({
        version: 1 as const,
        diagnostics: Object.freeze(immutableDiagnostics),
        hasErrors: errorCount > 0,
        errorCount,
        warningCount,
    })
}

const scratchDiagnosticErrors = new WeakSet<object>()

/** Carries a structured Scratch diagnostic through exception control flow. */
export class ScratchDiagnosticError<
    Diagnostic extends AnyScratchDiagnostic = AnyScratchDiagnostic,
> extends Error {

    declare readonly diagnostic: Diagnostic
    declare readonly report: ScratchDiagnosticReport
    declare readonly context?: DiagnosticContext<Diagnostic>

    constructor(
        diagnostic: Diagnostic,
        report: ScratchDiagnosticReport = createScratchDiagnosticReport([ diagnostic ]),
        options?: ScratchDiagnosticErrorOptions<Diagnostic>
    ) {

        const immutableDiagnostic = freezeDiagnosticEnvelope(diagnostic)
        const immutableReport = freezeDiagnosticReport(report, diagnostic, immutableDiagnostic)
        super(
            immutableDiagnostic.message,
            options?.cause === undefined ? undefined : { cause: options.cause }
        )
        if (options?.context !== undefined && options.context.domain !== immutableDiagnostic.domain) {
            throw new TypeError(
                `Scratch diagnostic context domain ${options.context.domain} does not match ` +
                `diagnostic domain ${immutableDiagnostic.domain}.`
            )
        }

        this.name = 'ScratchDiagnosticError'
        Object.defineProperties(this, {
            diagnostic: { value: immutableDiagnostic, enumerable: true },
            report: { value: immutableReport, enumerable: true },
            ...(options?.context === undefined ? {} : {
                context: {
                    value: Object.freeze({ ...options.context }),
                    enumerable: true,
                },
            }),
        })
        scratchDiagnosticErrors.add(this)
    }
}

/** Recognizes genuine Scratch diagnostic errors without trusting a mutable structural lookalike. */
export function isScratchDiagnosticError(value: unknown): value is ScratchDiagnosticError {

    return typeof value === 'object' && value !== null && scratchDiagnosticErrors.has(value as ScratchDiagnosticError)
}

function freezeSubject(subject: ScratchDiagnosticSubject): ScratchDiagnosticSubject {

    return Object.freeze({ ...subject })
}

function freezeDiagnosticEnvelope<Diagnostic extends AnyScratchDiagnostic>(
    diagnostic: Diagnostic
): Diagnostic {

    if (hasFrozenLibraryStructure(diagnostic)) return diagnostic
    return Object.freeze({
        ...diagnostic,
        subject: freezeSubject(diagnostic.subject),
        ...(diagnostic.hints === undefined ? {} : {
            hints: Object.freeze([ ...diagnostic.hints ]),
        }),
        ...(diagnostic.related === undefined ? {} : {
            related: Object.freeze(diagnostic.related.map(freezeSubject)),
        }),
        ...(diagnostic.suggestions === undefined ? {} : {
            suggestions: Object.freeze(diagnostic.suggestions.map(suggestion => Object.freeze({
                ...suggestion,
                target: freezeSubject(suggestion.target),
            }))),
        }),
        ...(diagnostic.evidence === undefined ? {} : {
            evidence: Object.freeze(diagnostic.evidence.map(entry => Object.freeze({ ...entry }))),
        }),
    }) as Diagnostic
}

function freezeDiagnosticReport<Diagnostic extends AnyScratchDiagnostic>(
    report: ScratchDiagnosticReport,
    sourceDiagnostic: Diagnostic,
    immutableDiagnostic: Diagnostic
): ScratchDiagnosticReport {

    if (Object.isFrozen(report) && Object.isFrozen(report.diagnostics) &&
        report.diagnostics.every(hasFrozenLibraryStructure)) {
        return report
    }
    return createScratchDiagnosticReport(report.diagnostics.map(diagnostic =>
        diagnostic === sourceDiagnostic
            ? immutableDiagnostic
            : freezeDiagnosticEnvelope(diagnostic)
    ))
}

function hasFrozenLibraryStructure(diagnostic: AnyScratchDiagnostic): boolean {

    return Object.isFrozen(diagnostic) &&
        Object.isFrozen(diagnostic.subject) &&
        (diagnostic.hints === undefined || Object.isFrozen(diagnostic.hints)) &&
        (diagnostic.related === undefined || (
            Object.isFrozen(diagnostic.related) && diagnostic.related.every(Object.isFrozen)
        )) &&
        (diagnostic.suggestions === undefined || (
            Object.isFrozen(diagnostic.suggestions) && diagnostic.suggestions.every(suggestion =>
                Object.isFrozen(suggestion) && Object.isFrozen(suggestion.target)
            )
        )) &&
        (diagnostic.evidence === undefined || (
            Object.isFrozen(diagnostic.evidence) && diagnostic.evidence.every(Object.isFrozen)
        ))
}

function normalizeHints(hints: string | readonly string[] | undefined): readonly string[] | undefined {

    if (hints === undefined) return undefined
    return Object.freeze(typeof hints === 'string' ? [ hints ] : [ ...hints ])
}
