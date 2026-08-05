export {
    ScratchDiagnosticError,
    createScratchDiagnostic,
    createScratchDiagnosticReport,
    isScratchDiagnosticError,
} from './base.js'
export type {
    ScratchDiagnosticBase,
    ScratchDiagnosticDomain,
    ScratchDiagnosticErrorContext,
    ScratchDiagnosticErrorOptions,
    ScratchDiagnosticEvidence,
    ScratchDiagnosticInput,
    ScratchDiagnosticReport,
    ScratchDiagnosticSeverity,
    ScratchDiagnosticSubject,
    ScratchDiagnosticSuggestion,
} from './base.js'
export type ScratchDiagnostic = GPUDiagnostic | WorkerDiagnostic | CacheDiagnostic
import type { CacheDiagnostic } from '../cache/diagnostics.js'
import type { GPUDiagnostic } from '../gpu/diagnostics.js'
import type { WorkerDiagnostic } from '../worker/diagnostics.js'
