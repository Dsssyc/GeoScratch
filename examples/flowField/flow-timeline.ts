import type { FlowFieldDataset } from './flow-dataset.ts'

export type FlowTimelineLoop = 'clamp' | 'loop'

export type FlowTimelineReadiness =
    | Readonly<{ state: 'ready', selectionRevision: number }>
    | Readonly<{
        state: 'blocked'
        reason: string
        selectionRevision: number
    }>

export type FlowTimeSelection =
    | Readonly<{
        kind: 'exact'
        modelTime: number
        sample: FlowFieldDataset['timeAxis']['samples'][number]
    }>
    | Readonly<{
        kind: 'interpolated'
        modelTime: number
        lower: FlowFieldDataset['timeAxis']['samples'][number]
        upper: FlowFieldDataset['timeAxis']['samples'][number]
        alpha: number
    }>
    | Readonly<{
        kind: 'gap'
        modelTime: number
        lower: FlowFieldDataset['timeAxis']['samples'][number]
        upper: FlowFieldDataset['timeAxis']['samples'][number]
        reason: 'omitted-source-samples'
    }>

export type FlowTimelineSnapshot = Readonly<{
    revision: number
    selectionRevision: number
    modelTime: number
    playing: boolean
    rate: number
    loop: FlowTimelineLoop
    readiness: FlowTimelineReadiness['state']
    canAdvance: boolean
    needsTick: boolean
    blockedReason: string | undefined
    selection: FlowTimeSelection
}>

export type FlowTimelineOptions = Readonly<{
    timeAxis: FlowFieldDataset['timeAxis']
    wallTime: number
    modelTime?: number
    playing?: boolean
    rate?: number
    loop?: FlowTimelineLoop
    readiness?: FlowTimelineReadiness
}>

export type FlowTimeline = Readonly<{
    snapshot(): FlowTimelineSnapshot
    play(input: Readonly<{ wallTime: number }>): FlowTimelineSnapshot
    pause(input: Readonly<{ wallTime: number }>): FlowTimelineSnapshot
    seek(input: Readonly<{ wallTime: number, modelTime: number }>): FlowTimelineSnapshot
    setRate(input: Readonly<{ wallTime: number, rate: number }>): FlowTimelineSnapshot
    setLoop(input: Readonly<{
        wallTime: number
        loop: FlowTimelineLoop
    }>): FlowTimelineSnapshot
    tick(input: Readonly<{
        wallTime: number
        readiness: FlowTimelineReadiness
    }>): FlowTimelineSnapshot
}>

type TimeAxis = Readonly<{
    samples: FlowFieldDataset['timeAxis']['samples']
    adjacency: FlowFieldDataset['timeAxis']['adjacency']
}>

type FlowTimelineMotion = Readonly<{
    modelTime: number
    reanchor: boolean
    residual: number
}>

/**
 * Creates an explicit model-time clock. Wall times are caller-origin monotonic
 * milliseconds; signed rates are model-time units per wall-clock second.
 */
export function createFlowTimeline(options: FlowTimelineOptions): FlowTimeline {

    const axis = normalizeTimeAxis(options?.timeAxis)
    let lastWallTime = requireWallTime(options?.wallTime)
    let motionAnchorWallTime = lastWallTime
    let loop = requireLoop(options?.loop ?? 'clamp')
    let modelTime = normalizeModelTime(
        options?.modelTime ?? axis.samples[0]!.modelTime,
        loop,
        axis
    )
    let motionAnchorModelTime = modelTime
    let motionResidual = 0
    let observedResidual = 0
    let playing = options?.playing ?? false
    let rate = requireRate(options?.rate ?? 1)
    let revision = 1
    let selectionRevision = 1
    let supportKey = selectionSupportKey(selectTime(axis, modelTime))

    if (typeof playing !== 'boolean') {
        throw new TypeError('Flow timeline playing must be boolean')
    }
    const requestedReadiness = normalizeReadiness(
        options?.readiness ?? blockedReadiness('readiness-unreported', selectionRevision),
        selectionRevision
    )
    let readiness = selectTime(axis, modelTime).kind === 'gap'
        ? readyReadiness(selectionRevision)
        : requestedReadiness

    function snapshot(): FlowTimelineSnapshot {

        const selection = selectTime(axis, modelTime)
        const blockedReason = timelineBlockedReason(
            axis,
            modelTime,
            rate,
            loop,
            readiness
        )
        const canAdvance = blockedReason === undefined
        return Object.freeze({
            revision,
            selectionRevision,
            modelTime,
            playing,
            rate,
            loop,
            readiness: readiness.state,
            canAdvance,
            needsTick: playing && canAdvance,
            blockedReason,
            selection,
        })
    }

    function motionAt(wallTime: number): FlowTimelineMotion {

        const elapsedSeconds = (wallTime - motionAnchorWallTime) / 1000
        const elapsedDelta = rate * elapsedSeconds
        const delta = elapsedDelta + motionResidual
        if (!Number.isFinite(elapsedDelta) || !Number.isFinite(delta)) {
            throw new RangeError('Flow timeline elapsed model-time delta must remain finite')
        }
        return advanceModelTime(axis, motionAnchorModelTime, delta, loop)
    }

    function commitMotion(
        motion: FlowTimelineMotion,
        wallTime: number,
        forceReanchor: boolean
    ): void {

        const selection = selectTime(axis, motion.modelTime)
        const nextSupportKey = selectionSupportKey(selection)
        const supportChanged = nextSupportKey !== supportKey
        const nextSelectionRevision = selectionRevision + (supportChanged ? 1 : 0)
        const nextReadiness = supportChanged
            ? selection.kind === 'gap'
                ? readyReadiness(nextSelectionRevision)
                : blockedReadiness('selection-changed', nextSelectionRevision)
            : readiness

        modelTime = motion.modelTime
        supportKey = nextSupportKey
        selectionRevision = nextSelectionRevision
        readiness = nextReadiness
        lastWallTime = wallTime
        if (forceReanchor || motion.reanchor || supportChanged) {
            motionAnchorWallTime = wallTime
            motionAnchorModelTime = modelTime
            motionResidual = motion.reanchor ? 0 : motion.residual
            observedResidual = motionResidual
        } else {
            observedResidual = motion.residual
        }
    }

    function settleControl(wallTime: number): void {

        const accepted = requireNextWallTime(wallTime, lastWallTime)
        const motion = snapshot().needsTick
            ? motionAt(accepted)
            : Object.freeze({ modelTime, reanchor: false, residual: motionResidual })
        commitMotion(motion, accepted, true)
    }

    function play(input: Readonly<{ wallTime: number }>): FlowTimelineSnapshot {

        settleControl(input?.wallTime)
        playing = true
        revision++
        return snapshot()
    }

    function pause(input: Readonly<{ wallTime: number }>): FlowTimelineSnapshot {

        settleControl(input?.wallTime)
        playing = false
        revision++
        return snapshot()
    }

    function seek(
        input: Readonly<{ wallTime: number, modelTime: number }>
    ): FlowTimelineSnapshot {

        const acceptedWallTime = requireNextWallTime(input?.wallTime, lastWallTime)
        const acceptedModelTime = normalizeModelTime(input?.modelTime, loop, axis)
        commitMotion(
            Object.freeze({ modelTime: acceptedModelTime, reanchor: true, residual: 0 }),
            acceptedWallTime,
            true
        )
        revision++
        return snapshot()
    }

    function setRate(
        input: Readonly<{ wallTime: number, rate: number }>
    ): FlowTimelineSnapshot {

        const acceptedRate = requireRate(input?.rate)
        settleControl(input?.wallTime)
        rate = acceptedRate
        revision++
        return snapshot()
    }

    function setLoop(input: Readonly<{
        wallTime: number
        loop: FlowTimelineLoop
    }>): FlowTimelineSnapshot {

        const acceptedLoop = requireLoop(input?.loop)
        settleControl(input?.wallTime)
        loop = acceptedLoop
        modelTime = normalizeModelTime(modelTime, loop, axis)
        motionAnchorWallTime = lastWallTime
        motionAnchorModelTime = modelTime
        revision++
        return snapshot()
    }

    function tick(input: Readonly<{
        wallTime: number
        readiness: FlowTimelineReadiness
    }>): FlowTimelineSnapshot {

        const acceptedWallTime = requireNextWallTime(input?.wallTime, lastWallTime)
        const acceptedReadiness = normalizeReadiness(input?.readiness, selectionRevision)
        const selection = selectTime(axis, modelTime)
        const effectiveReadiness = selection.kind === 'gap'
            ? readyReadiness(selectionRevision)
            : acceptedReadiness
        const readinessChanged = !sameReadiness(effectiveReadiness, readiness)
        if (effectiveReadiness.state === 'blocked' || readinessChanged) {
            readiness = effectiveReadiness
            lastWallTime = acceptedWallTime
            motionAnchorWallTime = acceptedWallTime
            motionAnchorModelTime = modelTime
            motionResidual = observedResidual
        } else {
            const current = snapshot()
            const motion = current.needsTick
                ? motionAt(acceptedWallTime)
                : Object.freeze({ modelTime, reanchor: false, residual: motionResidual })
            commitMotion(motion, acceptedWallTime, !current.needsTick)
        }
        revision++
        return snapshot()
    }

    return Object.freeze({ snapshot, play, pause, seek, setRate, setLoop, tick })
}

function normalizeTimeAxis(value: FlowFieldDataset['timeAxis']): TimeAxis {

    const samples = value?.samples
    const adjacency = value?.adjacency
    if (typeof value?.unit !== 'string' || value.unit.length === 0 ||
        typeof value.phase !== 'string' || value.phase.length === 0 ||
        !Number.isSafeInteger(value.sourceSampleCount) ||
        value.sourceSampleCount < 1 || !Array.isArray(samples) || samples.length === 0 ||
        value.sourceSampleCount < samples.length || !Array.isArray(adjacency) ||
        adjacency.length !== samples.length - 1) {
        throw new TypeError('Flow timeline requires a non-empty normalized time axis')
    }
    const normalizedSamples = samples.map((sample, index) => {
        const previous = samples[index - 1]
        const difference = previous === undefined
            ? 0
            : sample.modelTime - previous.modelTime
        if (sample?.sampleKey !== `t${String(sample?.timeIndex).padStart(2, '0')}` ||
            !Number.isSafeInteger(sample.timeIndex) || sample.timeIndex < 0 ||
            !Number.isFinite(sample.modelTime) ||
            sample.unit !== value.unit || sample.phase !== value.phase ||
            typeof sample.sourceHash !== 'string' || !/^[0-9a-f]{64}$/.test(sample.sourceHash) ||
            (previous !== undefined && (
                sample.timeIndex <= previous.timeIndex || sample.modelTime <= previous.modelTime ||
                !Number.isFinite(difference) || difference <= 0
            ))) {
            throw new TypeError('Flow timeline samples must be uniquely and strictly ordered')
        }
        return Object.freeze({ ...sample })
    })
    if (new Set(normalizedSamples.map(sample => sample.sampleKey)).size !== samples.length) {
        throw new TypeError('Flow timeline sample keys must be unique')
    }
    const totalSpan = normalizedSamples.at(-1)!.modelTime - normalizedSamples[0]!.modelTime
    if (!Number.isFinite(totalSpan)) {
        throw new TypeError('Flow timeline model-time span must be finite')
    }
    const normalizedAdjacency = adjacency.map((edge, index) => {
        const lower = normalizedSamples[index]!
        const upper = normalizedSamples[index + 1]!
        const consecutive = upper.timeIndex === lower.timeIndex + 1
        const valid = edge?.lowerSampleKey === lower.sampleKey &&
            edge.upperSampleKey === upper.sampleKey && (
                consecutive
                    ? edge.kind === 'interpolable' &&
                        edge.interpolation === 'component-wise-linear'
                    : edge.kind === 'gap' && edge.interpolation === 'none' &&
                        edge.reason === 'omitted-source-samples'
            )
        if (!valid) throw new TypeError('Flow timeline adjacency does not match its samples')
        return Object.freeze({ ...edge })
    })
    return Object.freeze({
        samples: Object.freeze(normalizedSamples),
        adjacency: Object.freeze(normalizedAdjacency),
    })
}

function selectTime(axis: TimeAxis, modelTime: number): FlowTimeSelection {

    const samples = axis.samples
    const exact = samples.find(sample => sample.modelTime === modelTime)
    if (exact !== undefined) {
        return Object.freeze({ kind: 'exact', modelTime, sample: exact })
    }
    let upperIndex = 1
    while (upperIndex < samples.length && samples[upperIndex]!.modelTime < modelTime) {
        upperIndex++
    }
    const lower = samples[upperIndex - 1]!
    const upper = samples[upperIndex]!
    const edge = axis.adjacency[upperIndex - 1]!
    if (edge.kind === 'gap') {
        return Object.freeze({
            kind: 'gap',
            modelTime,
            lower,
            upper,
            reason: edge.reason,
        })
    }
    return Object.freeze({
        kind: 'interpolated',
        modelTime,
        lower,
        upper,
        alpha: (modelTime - lower.modelTime) / (upper.modelTime - lower.modelTime),
    })
}

function timelineBlockedReason(
    axis: TimeAxis,
    modelTime: number,
    rate: number,
    loop: FlowTimelineLoop,
    readiness: FlowTimelineReadiness
): string | undefined {

    if (readiness.state === 'blocked') return readiness.reason
    if (axis.samples.length === 1) return 'single-sample'
    const first = axis.samples[0]!.modelTime
    const last = axis.samples.at(-1)!.modelTime
    if (loop === 'clamp' && ((rate < 0 && modelTime === first) ||
        (rate > 0 && modelTime === last))) {
        return rate < 0 ? 'range-start' : 'range-end'
    }
    return undefined
}

function advanceModelTime(
    axis: TimeAxis,
    modelTime: number,
    delta: number,
    loop: FlowTimelineLoop
): FlowTimelineMotion {

    if (delta === 0 || axis.samples.length === 1) {
        return Object.freeze({ modelTime, reanchor: false, residual: delta })
    }
    const first = axis.samples[0]!.modelTime
    const last = axis.samples.at(-1)!.modelTime
    const proposed = modelTime + delta
    if (!Number.isFinite(proposed)) {
        throw new RangeError('Flow timeline modelTime must remain finite')
    }
    if (loop === 'loop') {
        const wrapped = proposed < first || proposed > last
        return Object.freeze({
            modelTime: wrapped ? wrapModelTime(proposed, first, last) : proposed,
            reanchor: wrapped,
            residual: wrapped ? 0 : additionResidual(modelTime, delta, proposed),
        })
    }
    const clamped = Math.max(first, Math.min(last, proposed))
    const reachedClampBoundary = (clamped === first && delta < 0) ||
        (clamped === last && delta > 0)
    return Object.freeze({
        modelTime: clamped,
        reanchor: clamped !== proposed || reachedClampBoundary,
        residual: clamped === proposed ? additionResidual(modelTime, delta, proposed) : 0,
    })
}

function additionResidual(modelTime: number, delta: number, result: number): number {

    const residual = delta - (result - modelTime)
    if (!Number.isFinite(residual)) {
        throw new RangeError('Flow timeline motion residual must remain finite')
    }
    return residual
}

function wrapModelTime(value: number, first: number, last: number): number {

    const span = last - first
    const relative = value - first
    if (!Number.isFinite(relative)) {
        throw new RangeError('Flow timeline wrapped modelTime must remain finite')
    }
    const offset = ((relative % span) + span) % span
    return first + offset
}

function normalizeModelTime(value: number, loop: FlowTimelineLoop, axis: TimeAxis): number {

    if (!Number.isFinite(value)) throw new TypeError('Flow timeline modelTime must be finite')
    const first = axis.samples[0]!.modelTime
    const last = axis.samples.at(-1)!.modelTime
    if (first === last) return first
    if (loop === 'clamp') return Math.max(first, Math.min(last, value))
    if (value >= first && value <= last) return value
    return wrapModelTime(value, first, last)
}

function normalizeReadiness(
    value: FlowTimelineReadiness,
    selectionRevision: number
): FlowTimelineReadiness {

    if (!Number.isSafeInteger(value?.selectionRevision) ||
        value.selectionRevision !== selectionRevision) {
        throw new RangeError('Flow timeline readiness belongs to a stale selection')
    }
    if (value.state === 'ready') return readyReadiness(selectionRevision)
    if (value.state === 'blocked' && typeof value.reason === 'string' && value.reason.length > 0) {
        return blockedReadiness(value.reason, selectionRevision)
    }
    throw new TypeError('Flow timeline readiness must be ready or blocked with a reason')
}

function readyReadiness(selectionRevision: number): FlowTimelineReadiness {

    return Object.freeze({ state: 'ready', selectionRevision })
}

function blockedReadiness(reason: string, selectionRevision: number): FlowTimelineReadiness {

    return Object.freeze({ state: 'blocked', reason, selectionRevision })
}

function sameReadiness(left: FlowTimelineReadiness, right: FlowTimelineReadiness): boolean {

    return left.state === right.state && left.selectionRevision === right.selectionRevision &&
        (left.state === 'ready' || (right.state === 'blocked' && left.reason === right.reason))
}

function selectionSupportKey(selection: FlowTimeSelection): string {

    switch (selection.kind) {
        case 'exact': return `sample:${selection.sample.sampleKey}`
        case 'interpolated':
            return `pair:${selection.lower.sampleKey}:${selection.upper.sampleKey}`
        case 'gap': return `gap:${selection.lower.sampleKey}:${selection.upper.sampleKey}`
    }
}

function requireWallTime(value: number): number {

    if (!Number.isFinite(value)) throw new TypeError('Flow timeline wallTime must be finite')
    return value
}

function requireNextWallTime(value: number, anchor: number): number {

    const accepted = requireWallTime(value)
    if (accepted < anchor) throw new RangeError('Flow timeline wallTime must be monotonic')
    return accepted
}

function requireRate(value: number): number {

    if (!Number.isFinite(value) || value === 0) {
        throw new TypeError('Flow timeline rate must be finite and non-zero')
    }
    return value
}

function requireLoop(value: FlowTimelineLoop): FlowTimelineLoop {

    if (value !== 'clamp' && value !== 'loop') {
        throw new TypeError('Flow timeline loop must be clamp or loop')
    }
    return value
}
