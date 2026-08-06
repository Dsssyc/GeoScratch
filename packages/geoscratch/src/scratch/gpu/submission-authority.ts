import { UUID } from '../internal/uuid.js'
import { throwGPUDiagnostic } from './diagnostics.js'
import { assertGPURuntimeActive } from './runtime-authority.js'
import type { GPURuntime } from './runtime.js'

const authorityToken = Symbol('SubmissionAuthority')

export type SubmissionAuthorityDescriptor = Readonly<{
    label?: string
}>

export type SubmissionAuthorityStamp = Readonly<{
    kind: 'submission-authority-stamp'
    authorityId: string
    runtimeId: string
    revision: number
}>

type SubmissionAuthorityState = {
    runtime: GPURuntime
    revision: number
    disposed: boolean
}

type SubmissionAuthorityStampRecord = Readonly<{
    authority: SubmissionAuthority
    runtime: GPURuntime
    revision: number
}>

const authorityStates = new WeakMap<SubmissionAuthority, SubmissionAuthorityState>()
const stampRecords = new WeakMap<SubmissionAuthorityStamp, SubmissionAuthorityStampRecord>()

export class SubmissionAuthority {

    readonly id!: string
    readonly runtime!: GPURuntime
    readonly label?: string

    private constructor(token: symbol, runtime: GPURuntime, descriptor: SubmissionAuthorityDescriptor) {

        if (token !== authorityToken) {
            return authorityInvalid('SubmissionAuthority must be created by GPURuntime.', {
                construction: 'GPURuntime.createSubmissionAuthority()',
            })
        }
        assertGPURuntimeActive(runtime)
        Object.defineProperties(this, {
            id: immutableValue(`scratch-submission-authority-${UUID()}`),
            runtime: immutableValue(runtime),
            label: immutableValue(descriptor.label),
        })
        authorityStates.set(this, { runtime, revision: 0, disposed: false })
        Object.preventExtensions(this)
    }

    get revision(): number {

        return stateFor(this).revision
    }

    get isDisposed(): boolean {

        return stateFor(this).disposed
    }

    stamp(): SubmissionAuthorityStamp {

        const state = assertAuthorityActive(this)
        return createStamp(this, state)
    }

    advance(): SubmissionAuthorityStamp {

        const state = assertAuthorityActive(this)
        if (state.revision === Number.MAX_SAFE_INTEGER) {
            return authorityInvalid('SubmissionAuthority revision exhausted safe integer storage.', {
                revision: '< Number.MAX_SAFE_INTEGER',
            }, { revision: state.revision }, this)
        }
        state.revision += 1
        return createStamp(this, state)
    }

    dispose(): void {

        const state = stateFor(this)
        if (state.disposed) return
        state.disposed = true
    }
}

Object.freeze(SubmissionAuthority.prototype)

export function createSubmissionAuthority(
    runtime: GPURuntime,
    descriptor: SubmissionAuthorityDescriptor = {}
): SubmissionAuthority {

    if (typeof descriptor !== 'object' || descriptor === null ||
        (descriptor.label !== undefined && typeof descriptor.label !== 'string')) {
        return authorityInvalid('SubmissionAuthority descriptor is invalid.', {
            label: 'string | undefined',
        }, descriptor)
    }
    const Constructor = SubmissionAuthority as unknown as new (
        token: symbol,
        runtime: GPURuntime,
        descriptor: SubmissionAuthorityDescriptor
    ) => SubmissionAuthority
    return new Constructor(authorityToken, runtime, Object.freeze({
        ...(descriptor.label === undefined ? {} : { label: descriptor.label }),
    }))
}

export function assertSubmissionAuthorityStamp(
    runtime: GPURuntime,
    stamp: SubmissionAuthorityStamp
): void {

    const record = stampRecords.get(stamp)
    if (record === undefined) {
        return authorityInvalid('SubmissionBuilder.require() needs a genuine immutable authority stamp.', {
            stamp: 'SubmissionAuthorityStamp',
        }, stamp)
    }
    if (record.runtime !== runtime) {
        return throwGPUDiagnostic({
            code: 'SCRATCH_SUBMISSION_AUTHORITY_WRONG_RUNTIME',
            severity: 'error',
            phase: 'submission',
            subject: authoritySubject(record.authority),
            message: 'Submission authority and SubmissionBuilder must belong to the same GPURuntime.',
            expected: { runtimeId: runtime.id },
            actual: { runtimeId: record.runtime.id },
        })
    }
    const state = stateFor(record.authority)
    if (state.disposed) {
        return throwGPUDiagnostic({
            code: 'SCRATCH_SUBMISSION_AUTHORITY_DISPOSED',
            severity: 'error',
            phase: 'submission',
            subject: authoritySubject(record.authority),
            message: 'Submission authority was disposed before submission.',
            expected: { disposed: false },
            actual: { disposed: true, revision: state.revision },
        })
    }
    if (record.revision !== state.revision) {
        return throwGPUDiagnostic({
            code: 'SCRATCH_SUBMISSION_AUTHORITY_STALE',
            severity: 'error',
            phase: 'submission',
            subject: authoritySubject(record.authority),
            message: 'Submission authority advanced after this work was assembled.',
            expected: { revision: state.revision },
            actual: { revision: record.revision },
        })
    }
}

function createStamp(
    authority: SubmissionAuthority,
    state: SubmissionAuthorityState
): SubmissionAuthorityStamp {

    const stamp = Object.freeze({
        kind: 'submission-authority-stamp' as const,
        authorityId: authority.id,
        runtimeId: state.runtime.id,
        revision: state.revision,
    })
    stampRecords.set(stamp, Object.freeze({
        authority,
        runtime: state.runtime,
        revision: state.revision,
    }))
    return stamp
}

function assertAuthorityActive(authority: SubmissionAuthority): SubmissionAuthorityState {

    const state = stateFor(authority)
    assertGPURuntimeActive(state.runtime)
    if (!state.disposed) return state
    return throwGPUDiagnostic({
        code: 'SCRATCH_SUBMISSION_AUTHORITY_DISPOSED',
        severity: 'error',
        phase: 'submission',
        subject: authoritySubject(authority),
        message: 'SubmissionAuthority is disposed.',
        expected: { disposed: false },
        actual: { disposed: true, revision: state.revision },
    })
}

function stateFor(authority: SubmissionAuthority): SubmissionAuthorityState {

    const state = authorityStates.get(authority)
    if (state === undefined) {
        return authorityInvalid('SubmissionAuthority identity is invalid.', {
            authority: 'runtime-created SubmissionAuthority',
        }, authority)
    }
    return state
}

function authoritySubject(authority: SubmissionAuthority) {

    return {
        kind: 'SubmissionAuthority',
        id: authority.id,
        ...(authority.label === undefined ? {} : { label: authority.label }),
    }
}

function immutableValue(value: unknown): PropertyDescriptor {

    return { value, enumerable: true, writable: false, configurable: false }
}

function authorityInvalid(
    message: string,
    expected: unknown,
    actual?: unknown,
    authority?: SubmissionAuthority
): never {

    return throwGPUDiagnostic({
        code: 'SCRATCH_SUBMISSION_AUTHORITY_INVALID',
        severity: 'error',
        phase: 'submission',
        subject: authority === undefined
            ? { kind: 'SubmissionAuthority' }
            : authoritySubject(authority),
        message,
        expected,
        ...(actual === undefined ? {} : { actual }),
    })
}
