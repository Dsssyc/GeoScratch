import {
    ScratchDiagnosticError,
    createScratchDiagnostic,
    createScratchDiagnosticReport,
    isScratchDiagnosticError,
} from '../diagnostics/base.js'
import type {
    ScratchDiagnosticBase,
    ScratchDiagnosticErrorOptions as SharedDiagnosticErrorOptions,
    ScratchDiagnosticEvidence,
    ScratchDiagnosticInput as SharedDiagnosticInput,
    ScratchDiagnosticReport as SharedDiagnosticReport,
    ScratchDiagnosticSeverity,
    ScratchDiagnosticSubject,
    ScratchDiagnosticSuggestion,
} from '../diagnostics/base.js'
import type { GPUIncidentReport } from './gpu-operation.js'

export {
    ScratchDiagnosticError,
    createScratchDiagnosticReport,
    isScratchDiagnosticError,
}
export type {
    ScratchDiagnosticEvidence,
    ScratchDiagnosticSeverity,
    ScratchDiagnosticSubject,
    ScratchDiagnosticSuggestion,
}

export type GPUDiagnosticPhase =
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
    | 'buffer-mapping'

export type GPUDiagnosticSubjectDraft = {
    -readonly [Key in keyof ScratchDiagnosticSubject]: ScratchDiagnosticSubject[Key]
}

export type GPUDiagnostic = ScratchDiagnosticBase<
    'gpu',
    string,
    GPUDiagnosticPhase,
    ScratchDiagnosticSubject
>
export type ScratchDiagnostic = GPUDiagnostic
export type ScratchDiagnosticReport = SharedDiagnosticReport<GPUDiagnostic>

export type ScratchDiagnosticInput = Omit<
    SharedDiagnosticInput<'gpu', string, GPUDiagnosticPhase, ScratchDiagnosticSubject>,
    'domain' | 'subject' | 'suggestions' | 'evidence'
> & Readonly<{
    subject: ScratchDiagnosticSubject
    suggestions?: readonly ScratchDiagnosticSuggestion[]
    evidence?: readonly ScratchDiagnosticEvidence[]
}>

export type ScratchDiagnosticErrorOptions = ErrorOptions & Readonly<{
    incident?: GPUIncidentReport
}>

export function createGPUDiagnostic(input: ScratchDiagnosticInput): GPUDiagnostic {

    return createScratchDiagnostic({ domain: 'gpu', ...input })
}

export function throwGPUDiagnostic(
    input: ScratchDiagnosticInput,
    options?: ScratchDiagnosticErrorOptions
): never {

    const diagnostic = createGPUDiagnostic(input)
    const sharedOptions: SharedDiagnosticErrorOptions<GPUDiagnostic> = {
        ...(options?.cause === undefined ? {} : { cause: options.cause }),
        context: {
            domain: 'gpu',
            ...(options?.incident === undefined ? {} : { incident: options.incident }),
        },
    }
    throw new ScratchDiagnosticError(
        diagnostic,
        createScratchDiagnosticReport([ diagnostic ]),
        sharedOptions
    )
}
