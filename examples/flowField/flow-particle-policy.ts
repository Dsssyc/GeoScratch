export type FlowActivityThresholds = Readonly<{
    spawn: number
    kill: number
    spawnRatio: number
    killRatio: number
}>

export type FlowParticleLifecycleState = 'active' | 'dormant'

export type FlowParticlePolicyState = Readonly<{
    current: readonly [number, number, number, number]
    previous: readonly [number, number, number, number]
    velocity: readonly [number, number]
    ageSteps: number
    stagnantSteps: number
    randomState: number
    state: FlowParticleLifecycleState
}>

/** Derives application-owned spawn/kill hysteresis without adding another field plane. */
export function flowActivityThresholds(options: Readonly<{
    maximumSpeed: number
    spawnRatio?: number
    killRatio?: number
}>): FlowActivityThresholds {

    const maximumSpeed = options?.maximumSpeed
    const spawnRatio = options?.spawnRatio ?? 0.001
    const killRatio = options?.killRatio ?? 0.0005
    if (!Number.isFinite(maximumSpeed) || maximumSpeed <= 0) {
        throw new RangeError('maximumSpeed must be positive and finite')
    }
    if (!Number.isFinite(killRatio) || killRatio < 0 || killRatio >= 1) {
        throw new RangeError('killRatio must be finite and within [0, 1)')
    }
    if (!Number.isFinite(spawnRatio) || spawnRatio <= killRatio || spawnRatio > 1) {
        throw new RangeError('spawnRatio must be greater than killRatio and at most 1')
    }
    return Object.freeze({
        spawn: maximumSpeed * spawnRatio,
        kill: maximumSpeed * killRatio,
        spawnRatio,
        killRatio,
    })
}

/** Applies finite support, lifetime, and stagnation bounds to one particle step. */
export function classifyFlowParticle(input: Readonly<{
    available: boolean
    speed: number
    ageSteps: number
    stagnantSteps: number
    activityKill: number
    maximumAgeSteps: number
    maximumStagnantSteps: number
}>): 'alive' | 'retire' {

    if (typeof input?.available !== 'boolean' || !nonNegativeFinite(input.speed) ||
        !nonNegativeFinite(input.activityKill) || !nonNegativeInteger(input.ageSteps) ||
        !nonNegativeInteger(input.stagnantSteps) ||
        !positiveInteger(input.maximumAgeSteps) ||
        !positiveInteger(input.maximumStagnantSteps)) {
        throw new TypeError('Flow particle classification requires finite support and lifecycle facts')
    }
    return input.available && input.speed >= input.activityKill &&
        input.ageSteps < input.maximumAgeSteps &&
        input.stagnantSteps < input.maximumStagnantSteps
        ? 'alive'
        : 'retire'
}

/** Counts consecutive sub-threshold displacement steps with saturation. */
export function nextStagnantSteps(input: Readonly<{
    previous: number
    displacementMeters: number
    minimumDisplacementMeters: number
}>): number {

    if (!nonNegativeInteger(input?.previous) ||
        !nonNegativeFinite(input?.displacementMeters) ||
        !Number.isFinite(input?.minimumDisplacementMeters) ||
        input.minimumDisplacementMeters <= 0) {
        throw new TypeError('Flow stagnation requires a count and non-negative metric displacement')
    }
    if (input.displacementMeters >= input.minimumDisplacementMeters) return 0
    return Math.min(Number.MAX_SAFE_INTEGER, input.previous + 1)
}

/** Creates a replacement state whose segment has zero length in the rebirth frame. */
export function rebirthFlowParticle(
    inputPosition: readonly number[],
    randomState: number
): FlowParticlePolicyState {

    const position = positionValue(inputPosition)
    return particleState(position, randomState, 'active')
}

/** Creates a non-simulating slot without retrying random positions. */
export function dormantFlowParticle(randomState: number): FlowParticlePolicyState {

    return particleState(Object.freeze([ 0, 0, 0, 0 ]), randomState, 'dormant')
}

function particleState(
    position: readonly [number, number, number, number],
    randomState: number,
    state: FlowParticleLifecycleState
): FlowParticlePolicyState {

    if (!u32(randomState)) throw new RangeError('Flow particle randomState must be u32')
    const velocity = Object.freeze([ 0, 0 ]) as readonly [number, number]
    return Object.freeze({
        current: position,
        previous: position,
        velocity,
        ageSteps: 0,
        stagnantSteps: 0,
        randomState,
        state,
    })
}

function positionValue(values: readonly number[]): readonly [number, number, number, number] {

    if (!Array.isArray(values) || values.length !== 4 || values.some(value => !u32(value))) {
        throw new TypeError('Flow particle position requires four u32 limbs')
    }
    return Object.freeze([ values[0]!, values[1]!, values[2]!, values[3]! ])
}

function u32(value: number): boolean {

    return Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff
}

function nonNegativeInteger(value: number): boolean {

    return Number.isSafeInteger(value) && value >= 0
}

function positiveInteger(value: number): boolean {

    return Number.isSafeInteger(value) && value > 0
}

function nonNegativeFinite(value: number): boolean {

    return Number.isFinite(value) && value >= 0
}
