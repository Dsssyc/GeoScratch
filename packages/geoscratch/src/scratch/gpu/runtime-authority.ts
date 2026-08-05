import { throwScratchDiagnostic } from './diagnostics.js'
import type { DiagnosticSubject } from './diagnostics.js'
import type { ScratchRuntime } from './runtime.js'
import type { ScratchDeviceLostInfo } from './runtime-diagnostics.js'

type ScratchRuntimeAuthorityState = {
    isDisposed: boolean
    isDeviceLost: boolean
    lifecycleEpoch: number
    deviceLostInfo?: ScratchDeviceLostInfo
}

export type ScratchRuntimeAuthorityStamp = Readonly<{
    runtime: ScratchRuntime
    lifecycleEpoch: number
}>

export type ScratchRuntimeAuthorityObservation = Readonly<{
    isCurrent: boolean
    isDisposed: boolean
    isDeviceLost: boolean
    lifecycleEpoch: number
    deviceLostInfo?: ScratchDeviceLostInfo
}>

const runtimeAuthorityStates = new WeakMap<ScratchRuntime, ScratchRuntimeAuthorityState>()

export function initializeScratchRuntimeAuthority(runtime: ScratchRuntime): void {

    if (runtimeAuthorityStates.has(runtime)) {
        throw new TypeError('ScratchRuntime authority is already initialized.')
    }
    runtimeAuthorityStates.set(runtime, {
        isDisposed: false,
        isDeviceLost: false,
        lifecycleEpoch: 0,
    })
}

export function scratchRuntimeIsDisposed(runtime: ScratchRuntime): boolean {

    return runtimeAuthorityStateFor(runtime).isDisposed
}

export function scratchRuntimeIsDeviceLost(runtime: ScratchRuntime): boolean {

    return runtimeAuthorityStateFor(runtime).isDeviceLost
}

export function scratchRuntimeDeviceLostInfo(
    runtime: ScratchRuntime
): ScratchDeviceLostInfo | undefined {

    return runtimeAuthorityStateFor(runtime).deviceLostInfo
}

export function disposeScratchRuntimeAuthority(runtime: ScratchRuntime): boolean {

    const state = runtimeAuthorityStateFor(runtime)
    if (state.isDisposed) return false
    state.isDisposed = true
    state.lifecycleEpoch += 1
    return true
}

export function loseScratchRuntimeAuthority(
    runtime: ScratchRuntime,
    info: ScratchDeviceLostInfo
): boolean {

    const state = runtimeAuthorityStateFor(runtime)
    if (state.isDeviceLost) return false
    state.isDeviceLost = true
    state.deviceLostInfo = info
    state.lifecycleEpoch += 1
    return true
}

export function assertScratchRuntimeActive(runtime: ScratchRuntime): void {

    const state = runtimeAuthorityStateFor(runtime)
    if (state.isDisposed) {
        throwScratchDiagnostic({
            code: 'SCRATCH_RUNTIME_DISPOSED',
            severity: 'error',
            phase: 'runtime',
            subject: scratchRuntimeAuthoritySubject(runtime),
            message: 'ScratchRuntime has been disposed.',
            hints: [ 'Create a new ScratchRuntime before creating resources or surfaces.' ],
        })
    }

    if (state.isDeviceLost) {
        throwScratchDiagnostic({
            code: 'SCRATCH_RUNTIME_DEVICE_LOST',
            severity: 'error',
            phase: 'runtime',
            subject: scratchRuntimeAuthoritySubject(runtime),
            message: 'ScratchRuntime device has been lost.',
            actual: state.deviceLostInfo,
            hints: [ 'Create a replacement runtime or wait for a future rehydration API.' ],
        })
    }
}

export function captureScratchRuntimeAuthority(
    runtime: ScratchRuntime
): ScratchRuntimeAuthorityStamp {

    assertScratchRuntimeActive(runtime)
    return Object.freeze({
        runtime,
        lifecycleEpoch: runtimeAuthorityStateFor(runtime).lifecycleEpoch,
    })
}

export function assertScratchRuntimeAuthority(stamp: ScratchRuntimeAuthorityStamp): void {

    const observation = observeScratchRuntimeAuthority(stamp)
    assertScratchRuntimeActive(stamp.runtime)
    if (observation.isCurrent) return

    throwScratchDiagnostic({
        code: 'SCRATCH_RUNTIME_LIFECYCLE_CHANGED',
        severity: 'error',
        phase: 'runtime',
        subject: scratchRuntimeAuthoritySubject(stamp.runtime),
        message: 'ScratchRuntime lifecycle changed after operation preparation.',
        expected: { lifecycleEpoch: stamp.lifecycleEpoch },
        actual: { lifecycleEpoch: observation.lifecycleEpoch },
        hints: [ 'Prepare a new operation against the current runtime lifecycle.' ],
    })
}

export function observeScratchRuntimeAuthority(
    stamp: ScratchRuntimeAuthorityStamp
): ScratchRuntimeAuthorityObservation {

    const state = runtimeAuthorityStateFor(stamp.runtime)
    return Object.freeze({
        isCurrent: state.lifecycleEpoch === stamp.lifecycleEpoch,
        isDisposed: state.isDisposed,
        isDeviceLost: state.isDeviceLost,
        lifecycleEpoch: state.lifecycleEpoch,
        ...(state.deviceLostInfo !== undefined ? { deviceLostInfo: state.deviceLostInfo } : {}),
    })
}

export function scratchRuntimeAuthoritySubject(runtime: ScratchRuntime): DiagnosticSubject {

    const subject: DiagnosticSubject = {
        kind: 'ScratchRuntime',
        id: runtime.id,
    }
    if (runtime.label !== undefined) subject.label = runtime.label
    return subject
}

function runtimeAuthorityStateFor(runtime: ScratchRuntime): ScratchRuntimeAuthorityState {

    const state = runtimeAuthorityStates.get(runtime)
    if (state === undefined) throw new TypeError('ScratchRuntime authority is unavailable.')
    return state
}
