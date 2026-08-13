export type GeoDiagnosticSeverity = 'info' | 'warn' | 'error'

export type GeoDiagnosticPhase =
    | 'coordinate'
    | 'transform'
    | 'virtual-raster'
    | 'source'
    | 'cache'
    | 'demand'
    | 'residency'
    | 'sampling'
    | 'selection'

export type GeoDiagnosticSubject = Readonly<{
    kind: string
    id?: string
    label?: string
    [key: string]: unknown
}>

export type GeoDiagnostic = Readonly<{
    version: 1
    code: string
    severity: GeoDiagnosticSeverity
    phase: GeoDiagnosticPhase
    subject: GeoDiagnosticSubject
    message: string
    expected?: unknown
    actual?: unknown
    related?: readonly GeoDiagnosticSubject[]
    evidence?: readonly Readonly<{ kind: string, value?: unknown }>[]
}>

export type GeoDiagnosticInput = Readonly<{
    code: string
    severity?: GeoDiagnosticSeverity
    phase: GeoDiagnosticPhase
    subject: GeoDiagnosticSubject
    message?: string
    expected?: unknown
    actual?: unknown
    related?: readonly GeoDiagnosticSubject[]
    evidence?: readonly Readonly<{ kind: string, value?: unknown }>[]
}>

const geoDiagnosticErrors = new WeakSet<GeoDiagnosticError>()

/** Carries one immutable Geo diagnostic through exception control flow. */
export class GeoDiagnosticError extends Error {

    readonly diagnostic: GeoDiagnostic

    constructor(diagnostic: GeoDiagnostic, options?: ErrorOptions) {

        super(diagnostic.message, options)
        this.name = 'GeoDiagnosticError'
        this.diagnostic = diagnostic
        geoDiagnosticErrors.add(this)
    }
}

/** Recognizes genuine Geo diagnostic errors without trusting structural lookalikes. */
export function isGeoDiagnosticError(value: unknown): value is GeoDiagnosticError {

    return typeof value === 'object' &&
        value !== null &&
        geoDiagnosticErrors.has(value as GeoDiagnosticError)
}

/** Creates an immutable machine-readable diagnostic for geographic contracts. */
export function createGeoDiagnostic(input: GeoDiagnosticInput): GeoDiagnostic {

    const diagnostic: {
        version: 1
        code: string
        severity: GeoDiagnosticSeverity
        phase: GeoDiagnosticPhase
        subject: GeoDiagnosticSubject
        message: string
        expected?: unknown
        actual?: unknown
        related?: readonly GeoDiagnosticSubject[]
        evidence?: readonly Readonly<{ kind: string, value?: unknown }>[]
    } = {
        version: 1,
        code: input.code,
        severity: input.severity ?? 'error',
        phase: input.phase,
        subject: Object.freeze({ ...input.subject }),
        message: input.message ?? input.code,
    }
    if (input.expected !== undefined) diagnostic.expected = input.expected
    if (input.actual !== undefined) diagnostic.actual = input.actual
    if (input.related !== undefined) diagnostic.related = Object.freeze([ ...input.related ])
    if (input.evidence !== undefined) diagnostic.evidence = Object.freeze([ ...input.evidence ])
    return Object.freeze(diagnostic)
}

export function throwGeoDiagnostic(input: GeoDiagnosticInput): never {

    throw new GeoDiagnosticError(createGeoDiagnostic(input))
}
