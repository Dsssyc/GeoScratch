import {
    ScratchDiagnosticError,
    createScratchDiagnostic,
    createScratchDiagnosticReport,
} from '../diagnostics/base.js'
import type {
    ScratchDiagnosticBase,
    ScratchDiagnosticSeverity,
} from '../diagnostics/base.js'

export type CacheDiagnosticPhase =
    | 'cache-key'
    | 'cache-open'
    | 'cache-read'
    | 'cache-write'
    | 'cache-delete'
    | 'cache-invalidate'
    | 'cache-clear'
    | 'cache-recovery'
    | 'cache-lifecycle'

export type CacheDiagnosticCode =
    | 'CACHE_KEY_INVALID'
    | 'CACHE_DESCRIPTOR_INVALID'
    | 'CACHE_ENTRY_INVALID'
    | 'CACHE_STORAGE_UNAVAILABLE'
    | 'CACHE_STORAGE_FAILED'
    | 'CACHE_QUOTA_EXCEEDED'
    | 'CACHE_PAYLOAD_MISSING'
    | 'CACHE_PAYLOAD_SIZE_MISMATCH'
    | 'CACHE_DISPOSED'

export type CacheDiagnosticSubject = Readonly<{
    kind: 'PersistentCache' | 'PersistentCacheKey' | 'CacheEntry' | 'CachePayload'
    id?: string
    label?: string
}>

export type CacheStorageErrorFacts = Readonly<{
    operation: string
    storage: 'indexeddb' | 'opfs' | 'storage-manager' | 'coordination'
    errorName?: string
    errorMessage?: string
    retriable: boolean
}>

type CacheDiagnosticFacts = Readonly<{
    operation?: string
    keyId?: string
    revision?: string
    storage?: CacheStorageErrorFacts['storage']
    storageErrorName?: string
    retriable?: boolean
}>

export type CacheDiagnostic = ScratchDiagnosticBase<
    'cache',
    CacheDiagnosticCode,
    CacheDiagnosticPhase,
    CacheDiagnosticSubject
> & CacheDiagnosticFacts

export type CacheDiagnosticInput = Readonly<{
    code: CacheDiagnosticCode
    severity: ScratchDiagnosticSeverity
    phase: CacheDiagnosticPhase
    subject: CacheDiagnosticSubject
    message: string
    expected?: unknown
    actual?: unknown
    hints?: readonly string[]
    operation?: string
    keyId?: string
    revision?: string
    storage?: CacheStorageErrorFacts['storage']
    storageErrorName?: string
    retriable?: boolean
}>

export function createCacheDiagnostic(input: CacheDiagnosticInput): CacheDiagnostic {

    const base = createScratchDiagnostic({
        domain: 'cache',
        code: input.code,
        severity: input.severity,
        phase: input.phase,
        subject: input.subject,
        message: input.message,
        ...(input.expected === undefined ? {} : { expected: input.expected }),
        ...(input.actual === undefined ? {} : { actual: input.actual }),
        ...(input.hints === undefined ? {} : { hints: input.hints }),
    })
    const facts: CacheDiagnosticFacts = {
        ...(input.operation === undefined ? {} : { operation: input.operation }),
        ...(input.keyId === undefined ? {} : { keyId: input.keyId }),
        ...(input.revision === undefined ? {} : { revision: input.revision }),
        ...(input.storage === undefined ? {} : { storage: input.storage }),
        ...(input.storageErrorName === undefined ? {} : {
            storageErrorName: input.storageErrorName,
        }),
        ...(input.retriable === undefined ? {} : { retriable: input.retriable }),
    }
    return Object.freeze({ ...base, ...facts })
}

export function cacheDiagnosticError(
    input: CacheDiagnosticInput,
    cause?: unknown,
    storage?: CacheStorageErrorFacts
): ScratchDiagnosticError<CacheDiagnostic> {

    const diagnostic = createCacheDiagnostic(input)
    return new ScratchDiagnosticError(
        diagnostic,
        createScratchDiagnosticReport([ diagnostic ]),
        {
            ...(cause === undefined ? {} : { cause }),
            context: {
                domain: 'cache',
                ...(storage === undefined ? {} : { storage }),
            },
        }
    )
}
