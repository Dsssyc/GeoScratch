export type FlowVisualTime = Readonly<{
    referenceSteps: number
    wholeSteps: number
    discardedSeconds: number
}>

const ZERO_TIME: FlowVisualTime = Object.freeze({referenceSteps:0, wholeSteps:0, discardedSeconds:0})

/**
 * Owns example-local 60 Hz visual time, independently of model-time playback rate.
 * Disabled/reset/long-gap intervals reanchor without debt; accepted whole ticks
 * share one fractional remainder for byte-history decay and integer particle age.
 */
export function createFlowVisualClock(): Readonly<{
    tick(wallTimeMs: number, enabled: boolean): FlowVisualTime
    reset(): void
}> {
    let lastWallTime: number | undefined
    let advancing = false
    let remainder = 0
    return Object.freeze({
        tick(wallTimeMs: number, enabled: boolean): FlowVisualTime {
            if (!Number.isFinite(wallTimeMs) || wallTimeMs < 0 ||
                (lastWallTime !== undefined && wallTimeMs < lastWallTime)) {
                throw new RangeError('Flow visual time must be finite, nonnegative and monotonic')
            }
            if (typeof enabled !== 'boolean') throw new TypeError('Flow visual clock enabled must be boolean')
            const elapsed = lastWallTime === undefined ? 0 : (wallTimeMs - lastWallTime) / 1000
            lastWallTime = wallTimeMs
            if (!enabled || !advancing) {
                advancing = enabled
                remainder = 0
                return ZERO_TIME
            }
            if (elapsed > 0.25) {
                remainder = 0
                return Object.freeze({referenceSteps:0, wholeSteps:0, discardedSeconds:elapsed})
            }
            const accepted = Math.min(elapsed, 0.05)
            const referenceSteps = accepted * 60
            const total = remainder + referenceSteps
            const wholeSteps = Math.floor(total + 1e-9)
            remainder = Math.max(0, total - wholeSteps)
            return Object.freeze({referenceSteps, wholeSteps, discardedSeconds:elapsed - accepted})
        },
        reset(): void {
            // Retain monotonic validation, but forget the animation anchor/phase.
            advancing = false
            remainder = 0
        },
    })
}
