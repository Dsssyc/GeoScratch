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
import type { ScratchGpuIncidentReport } from './gpu-operation.js'

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

export type DiagnosticSeverity = ScratchDiagnosticSeverity

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
    | 'buffer-mapping'

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

export type GPUDiagnostic = ScratchDiagnosticBase<
    'gpu',
    string,
    DiagnosticPhase,
    ScratchDiagnosticSubject
>
export type ScratchDiagnostic = GPUDiagnostic
export type ScratchDiagnosticReport = SharedDiagnosticReport<GPUDiagnostic>

export type ScratchDiagnosticInput = Omit<
    SharedDiagnosticInput<'gpu', string, DiagnosticPhase, ScratchDiagnosticSubject>,
    'domain' | 'subject' | 'suggestions' | 'evidence'
> & Readonly<{
    subject: DiagnosticSubject
    suggestions?: readonly DiagnosticSuggestion[]
    evidence?: readonly DiagnosticEvidence[]
}>

export type ScratchDiagnosticErrorOptions = ErrorOptions & Readonly<{
    incident?: ScratchGpuIncidentReport
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
