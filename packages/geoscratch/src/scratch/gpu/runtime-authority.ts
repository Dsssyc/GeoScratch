import { throwGPUDiagnostic } from './diagnostics.js'
import type { GPUDiagnosticSubjectDraft, ScratchDiagnosticSubject } from './diagnostics.js'
import type { GPURuntime } from './runtime.js'
import type { GPUDeviceLostInfo } from './runtime-diagnostics.js'

type GPURuntimeAuthorityState = {
    isDisposed: boolean
    isDeviceLost: boolean
    lifecycleEpoch: number
    deviceLostInfo?: GPUDeviceLostInfo
}

export type GPURuntimeAuthorityStamp = Readonly<{
    runtime: GPURuntime
    lifecycleEpoch: number
}>

export type GPURuntimeAuthorityObservation = Readonly<{
    isCurrent: boolean
    isDisposed: boolean
    isDeviceLost: boolean
    lifecycleEpoch: number
    deviceLostInfo?: GPUDeviceLostInfo
}>

const runtimeAuthorityStates = new WeakMap<GPURuntime, GPURuntimeAuthorityState>()

export function initializeScratchRuntimeAuthority(runtime: GPURuntime): void {

    if (runtimeAuthorityStates.has(runtime)) {
        throw new TypeError('GPURuntime authority is already initialized.')
    }
    runtimeAuthorityStates.set(runtime, {
        isDisposed: false,
        isDeviceLost: false,
        lifecycleEpoch: 0,
    })
}

export function scratchRuntimeIsDisposed(runtime: GPURuntime): boolean {

    return runtimeAuthorityStateFor(runtime).isDisposed
}

export function scratchRuntimeIsDeviceLost(runtime: GPURuntime): boolean {

    return runtimeAuthorityStateFor(runtime).isDeviceLost
}

export function scratchRuntimeDeviceLostInfo(
    runtime: GPURuntime
): GPUDeviceLostInfo | undefined {

    return runtimeAuthorityStateFor(runtime).deviceLostInfo
}

export function disposeScratchRuntimeAuthority(runtime: GPURuntime): boolean {

    const state = runtimeAuthorityStateFor(runtime)
    if (state.isDisposed) return false
    state.isDisposed = true
    state.lifecycleEpoch += 1
    return true
}

export function loseScratchRuntimeAuthority(
    runtime: GPURuntime,
    info: GPUDeviceLostInfo
): boolean {

    const state = runtimeAuthorityStateFor(runtime)
    if (state.isDeviceLost) return false
    state.isDeviceLost = true
    state.deviceLostInfo = info
    state.lifecycleEpoch += 1
    return true
}

export function assertScratchRuntimeActive(runtime: GPURuntime): void {

    const state = runtimeAuthorityStateFor(runtime)
    if (state.isDisposed) {
        throwGPUDiagnostic({
            code: 'SCRATCH_RUNTIME_DISPOSED',
            severity: 'error',
            phase: 'runtime',
            subject: scratchRuntimeAuthoritySubject(runtime),
            message: 'GPURuntime has been disposed.',
            hints: [ 'Create a new GPURuntime before creating resources or surfaces.' ],
        })
    }

    if (state.isDeviceLost) {
        throwGPUDiagnostic({
            code: 'SCRATCH_RUNTIME_DEVICE_LOST',
            severity: 'error',
            phase: 'runtime',
            subject: scratchRuntimeAuthoritySubject(runtime),
            message: 'GPURuntime device has been lost.',
            actual: state.deviceLostInfo,
            hints: [ 'Create a replacement runtime or wait for a future rehydration API.' ],
        })
    }
}

export function captureScratchRuntimeAuthority(
    runtime: GPURuntime
): GPURuntimeAuthorityStamp {

    assertScratchRuntimeActive(runtime)
    return Object.freeze({
        runtime,
        lifecycleEpoch: runtimeAuthorityStateFor(runtime).lifecycleEpoch,
    })
}

export function assertScratchRuntimeAuthority(stamp: GPURuntimeAuthorityStamp): void {

    const observation = observeScratchRuntimeAuthority(stamp)
    assertScratchRuntimeActive(stamp.runtime)
    if (observation.isCurrent) return

    throwGPUDiagnostic({
        code: 'SCRATCH_RUNTIME_LIFECYCLE_CHANGED',
        severity: 'error',
        phase: 'runtime',
        subject: scratchRuntimeAuthoritySubject(stamp.runtime),
        message: 'GPURuntime lifecycle changed after operation preparation.',
        expected: { lifecycleEpoch: stamp.lifecycleEpoch },
        actual: { lifecycleEpoch: observation.lifecycleEpoch },
        hints: [ 'Prepare a new operation against the current runtime lifecycle.' ],
    })
}

export function observeScratchRuntimeAuthority(
    stamp: GPURuntimeAuthorityStamp
): GPURuntimeAuthorityObservation {

    const state = runtimeAuthorityStateFor(stamp.runtime)
    return Object.freeze({
        isCurrent: state.lifecycleEpoch === stamp.lifecycleEpoch,
        isDisposed: state.isDisposed,
        isDeviceLost: state.isDeviceLost,
        lifecycleEpoch: state.lifecycleEpoch,
        ...(state.deviceLostInfo !== undefined ? { deviceLostInfo: state.deviceLostInfo } : {}),
    })
}

export function scratchRuntimeAuthoritySubject(runtime: GPURuntime): ScratchDiagnosticSubject {

    const subject: GPUDiagnosticSubjectDraft = {
        kind: 'GPURuntime',
        id: runtime.id,
    }
    if (runtime.label !== undefined) subject.label = runtime.label
    return subject
}

function runtimeAuthorityStateFor(runtime: GPURuntime): GPURuntimeAuthorityState {

    const state = runtimeAuthorityStates.get(runtime)
    if (state === undefined) throw new TypeError('GPURuntime authority is unavailable.')
    return state
}
