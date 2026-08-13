import { isScratchDiagnosticError } from '../diagnostics/base.js'
import type { WorkerDiagnostic } from './diagnostics.js'
import type { WorkerRemoteErrorFacts } from './worker-system.js'

export type RecommendedWorkerCountOptions = Readonly<{
    hardwareConcurrency?: number
    reserve?: number
    minimum?: number
    maximum?: number
}>

/** Derives a bounded Worker count from explicit or host-reported concurrency facts. */
export function recommendedWorkerCount(
    options: RecommendedWorkerCountOptions = {}
): number {

    const hardwareConcurrency = positiveInteger(
        options.hardwareConcurrency ?? globalThis.navigator?.hardwareConcurrency ?? 4,
        'hardwareConcurrency'
    )
    const reserve = nonNegativeInteger(options.reserve ?? 1, 'reserve')
    const minimum = positiveInteger(options.minimum ?? 1, 'minimum')
    const maximum = positiveInteger(options.maximum ?? 4, 'maximum')
    if (minimum > maximum) {
        throw new TypeError('Recommended Worker count minimum cannot exceed maximum.')
    }
    return Math.max(minimum, Math.min(maximum, hardwareConcurrency - reserve))
}

/** Returns immutable remote error facts from a genuine Worker diagnostic error. */
export function workerRemoteErrorFacts(error: unknown): WorkerRemoteErrorFacts | undefined {

    if (!isScratchDiagnosticError(error) || error.diagnostic.domain !== 'worker') return undefined
    const diagnostic = error.diagnostic as WorkerDiagnostic
    const remote = error.context?.domain === 'worker' ? error.context.remote : undefined
    if (remote !== undefined) return remote
    if (typeof diagnostic.actual !== 'object' || diagnostic.actual === null) return undefined
    const candidate = diagnostic.actual as Partial<WorkerRemoteErrorFacts>
    if (typeof candidate.remoteName !== 'string' ||
        typeof candidate.remoteMessage !== 'string') return undefined
    return Object.freeze({
        remoteName: candidate.remoteName,
        remoteMessage: candidate.remoteMessage,
        ...(typeof candidate.remoteCode === 'string' ? { remoteCode: candidate.remoteCode } : {}),
    })
}

/** Returns the application-defined remote code carried by a genuine Worker diagnostic error. */
export function workerRemoteErrorCode(error: unknown): string | undefined {

    return workerRemoteErrorFacts(error)?.remoteCode
}

function positiveInteger(value: unknown, name: string): number {

    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError(`${name} must be a positive integer.`)
    }
    return value
}

function nonNegativeInteger(value: unknown, name: string): number {

    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${name} must be a non-negative integer.`)
    }
    return value
}
