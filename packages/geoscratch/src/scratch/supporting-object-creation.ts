import { diagnosticsControllerFor } from './runtime-diagnostics.js'
import type { ScratchRuntimeLifecycleChange } from './runtime-diagnostics.js'
import type { ScratchRuntime } from './runtime.js'

export type SupportingObjectFailureKind =
    | 'validation'
    | 'internal'
    | 'out-of-memory'
    | 'native-exception'
    | 'scope-failure'
    | 'device-lost'
    | 'runtime-disposed'

export type SupportingObjectObservedFailure = Readonly<{
    kind: SupportingObjectFailureKind
    cause?: unknown
    deviceLostInfo?: GPUDeviceLostInfo
}>

export type SupportingObjectCreationOutcome<T> = Readonly<{
    candidate?: T
    failures: readonly SupportingObjectObservedFailure[]
}>

type ScopeFilter = 'validation' | 'internal' | 'out-of-memory'

type PromiseObservation<T> =
    | Readonly<{ status: 'fulfilled', value: T }>
    | Readonly<{ status: 'rejected', reason: unknown }>

type ScopeObservation = Readonly<{
    filter: ScopeFilter
    observation: PromiseObservation<GPUError | null>
}>

type LifecycleSettlement =
    | Readonly<{ kind: 'device-lost', info: GPUDeviceLostInfo }>
    | Readonly<{ kind: 'runtime-disposed' }>

const filters = Object.freeze([
    'out-of-memory',
    'internal',
    'validation',
] satisfies ScopeFilter[])

export function issueSupportingObjectCreation<T>(
    runtime: ScratchRuntime,
    issue: () => T
): Promise<SupportingObjectCreationOutcome<T>> {

    const device = runtime.device
    const boundaryFailures: SupportingObjectObservedFailure[] = []
    const pushed: ScopeFilter[] = []
    let candidate: T | undefined
    let synchronousFailure: unknown
    let resolveLifecycle!: (settlement: LifecycleSettlement) => void
    const lifecycle = new Promise<LifecycleSettlement>(resolve => {
        resolveLifecycle = resolve
    })
    const unsubscribeLifecycle = diagnosticsControllerFor(runtime).subscribeLifecycle(change => {
        resolveLifecycle(runtimeLifecycleSettlement(change))
    })

    if (
        !device ||
        typeof device.pushErrorScope !== 'function' ||
        typeof device.popErrorScope !== 'function'
    ) {
        boundaryFailures.push(observedFailure(
            'scope-failure',
            new TypeError('GPUDevice error-scope methods are unavailable.')
        ))
    } else {
        for (const filter of filters) {
            if (pushed.length !== filters.indexOf(filter)) break
            try {
                device.pushErrorScope(filter)
                pushed.push(filter)
            } catch (cause) {
                boundaryFailures.push(observedFailure('scope-failure', cause))
            }
        }
    }

    if (pushed.length === filters.length) {
        try {
            candidate = issue()
            if (!isObjectLike(candidate)) {
                throw new TypeError('Native supporting-object creation returned an invalid object.')
            }
        } catch (cause) {
            synchronousFailure = cause
        }
    }

    const pendingScopes = [ ...pushed ]
        .reverse()
        .map(filter => popScope(device, filter))
    const scopes = Promise.all(pendingScopes)

    return Promise.race([
        scopes.then(observations => ({ kind: 'scopes-settled' as const, observations })),
        lifecycle,
    ]).then(settlement => {
        const failures = [ ...boundaryFailures ]

        if (settlement.kind === 'device-lost') {
            failures.push(Object.freeze({
                kind: 'device-lost' as const,
                deviceLostInfo: settlement.info,
            }))
        } else if (settlement.kind === 'runtime-disposed') {
            failures.push(observedFailure('runtime-disposed'))
        } else {
            if (synchronousFailure !== undefined) {
                failures.push(observedFailure('native-exception', synchronousFailure))
            }
            for (const scope of settlement.observations) {
                failures.push(...scopeFailures(scope))
            }
            if (runtime.isDisposed) failures.push(observedFailure('runtime-disposed'))
            else if (runtime.isDeviceLost) {
                failures.push(Object.freeze({
                    kind: 'device-lost' as const,
                    ...(runtime.deviceLostInfo !== undefined
                        ? { deviceLostInfo: runtime.deviceLostInfo }
                        : {}),
                }))
            }
        }

        return Object.freeze({
            ...(candidate !== undefined ? { candidate } : {}),
            failures: Object.freeze(failures),
        })
    }).finally(unsubscribeLifecycle)
}

export function recheckSupportingObjectLifecycle<T>(
    runtime: ScratchRuntime,
    outcome: SupportingObjectCreationOutcome<T>
): SupportingObjectCreationOutcome<T> {

    if (outcome.failures.length > 0) return outcome

    let failure: SupportingObjectObservedFailure | undefined
    if (runtime.isDisposed) {
        failure = observedFailure('runtime-disposed')
    } else if (runtime.isDeviceLost) {
        failure = Object.freeze({
            kind: 'device-lost' as const,
            ...(runtime.deviceLostInfo !== undefined
                ? { deviceLostInfo: runtime.deviceLostInfo }
                : {}),
        })
    }
    if (failure === undefined) return outcome

    return Object.freeze({
        ...(outcome.candidate !== undefined ? { candidate: outcome.candidate } : {}),
        failures: Object.freeze([ failure ]),
    })
}

export function destroySupportingObjectCandidate(candidate: unknown): void {

    if (!isObjectLike(candidate)) return
    const destroy = (candidate as { destroy?: unknown }).destroy
    if (typeof destroy !== 'function') return

    try {
        destroy.call(candidate)
    } catch {
        // Cleanup remains best effort after the primary transaction failure.
    }
}

function popScope(device: GPUDevice, filter: ScopeFilter): Promise<ScopeObservation> {

    try {
        return Promise.resolve(device.popErrorScope()).then(
            value => Object.freeze({
                filter,
                observation: Object.freeze({ status: 'fulfilled' as const, value }),
            }),
            reason => Object.freeze({
                filter,
                observation: Object.freeze({ status: 'rejected' as const, reason }),
            })
        )
    } catch (reason) {
        return Promise.resolve(Object.freeze({
            filter,
            observation: Object.freeze({ status: 'rejected' as const, reason }),
        }))
    }
}

function scopeFailures(scope: ScopeObservation): SupportingObjectObservedFailure[] {

    if (scope.observation.status === 'rejected') {
        return [ observedFailure('scope-failure', scope.observation.reason) ]
    }
    if (scope.observation.value === null) return []
    if (!isObjectLike(scope.observation.value)) {
        return [ observedFailure(
            'scope-failure',
            new TypeError(`The ${scope.filter} error scope resolved with an invalid value.`)
        ) ]
    }
    return [ observedFailure(scope.filter, scope.observation.value) ]
}

function observedFailure(
    kind: SupportingObjectFailureKind,
    cause?: unknown
): SupportingObjectObservedFailure {

    return Object.freeze({
        kind,
        ...(cause !== undefined ? { cause } : {}),
    })
}

function runtimeLifecycleSettlement(change: ScratchRuntimeLifecycleChange): LifecycleSettlement {

    return change.kind === 'device-lost'
        ? Object.freeze({ kind: 'device-lost', info: change.info })
        : Object.freeze({ kind: 'runtime-disposed' })
}

function isObjectLike(value: unknown): value is object {

    return value !== null && (typeof value === 'object' || typeof value === 'function')
}
