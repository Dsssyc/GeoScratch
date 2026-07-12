import { throwScratchDiagnostic } from './diagnostics.js'

export type ScratchReadbackOptions = Readonly<{
    maxPendingOperations?: number
    maxStagingBytes?: number
}>

export type ScratchReadbackPolicy = Readonly<{
    maxPendingOperations: number
    maxStagingBytes: number
}>

const DEFAULT_MAX_PENDING_OPERATIONS = 16
const DEFAULT_MAX_STAGING_BYTES = 64 * 1024 * 1024

export function normalizeScratchReadbackPolicy(
    options: ScratchReadbackOptions | undefined,
    runtimeLabel?: string
): ScratchReadbackPolicy {

    if (options !== undefined && (options === null || typeof options !== 'object')) {
        throwReadbackPolicyDiagnostic('readback', options, 'object')
    }

    return Object.freeze({
        maxPendingOperations: finitePositiveInteger(
            'maxPendingOperations',
            options?.maxPendingOperations,
            DEFAULT_MAX_PENDING_OPERATIONS,
            runtimeLabel
        ),
        maxStagingBytes: finitePositiveInteger(
            'maxStagingBytes',
            options?.maxStagingBytes,
            DEFAULT_MAX_STAGING_BYTES,
            runtimeLabel
        ),
    })
}

function finitePositiveInteger(
    name: string,
    value: unknown,
    fallback: number,
    runtimeLabel?: string
): number {

    if (value === undefined) return fallback
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value
    throwReadbackPolicyDiagnostic(name, value, 'positive safe integer', runtimeLabel)
}

function throwReadbackPolicyDiagnostic(
    name: string,
    value: unknown,
    expected: string,
    runtimeLabel?: string
): never {

    throwScratchDiagnostic({
        code: 'SCRATCH_READBACK_POLICY_INVALID',
        severity: 'error',
        phase: 'runtime',
        subject: {
            kind: 'ScratchRuntime',
            ...(runtimeLabel !== undefined ? { label: runtimeLabel } : {}),
        },
        message: `ScratchRuntime readback option ${name} is invalid.`,
        expected: { [name]: expected },
        actual: { [name]: value },
    })
}
