import type { FlowTemporalReadyCapture } from './flow-temporal-runtime-window.ts'
import type { FlowTimelineSnapshot, FlowTimeSelection } from './flow-timeline.ts'

export type FlowTemporalFrameSnapshot = Readonly<{
    kind: 'flow-temporal-frame-snapshot'
    timelineRevision: number
    selectionRevision: number
    windowRequestRevision: number
    pairGeneration: number
    requestedModelTime: number
    presentedModelTime: number
    lowerSampleKey: string
    upperSampleKey: string
    alpha: number
    temporalResidencyEpoch: number
    lowerSnapshotEpoch: number
    upperSnapshotEpoch: number
}>

/** Rejects a runtime capture that no longer represents the supplied timeline decision. */
export function assertFlowTemporalCapture<Runtime extends object>(
    timeline: FlowTimelineSnapshot,
    capture: FlowTemporalReadyCapture<Runtime>
): void {

    validateFlowTemporalCapture(timeline, capture)
}

/** Captures one admitted timeline selection and the exact GPU publication epochs it samples. */
export function flowTemporalFrameSnapshot<Runtime extends object>(
    timeline: FlowTimelineSnapshot,
    capture: FlowTemporalReadyCapture<Runtime>,
    epochs: Readonly<{
        temporalResidencyEpoch: number
        lowerSnapshotEpoch: number
        upperSnapshotEpoch: number
    }>
): FlowTemporalFrameSnapshot {

    const captured = validateFlowTemporalCapture(timeline, capture)
    if (!positiveInteger(epochs?.temporalResidencyEpoch) ||
        !positiveInteger(epochs.lowerSnapshotEpoch) ||
        !positiveInteger(epochs.upperSnapshotEpoch)) {
        throw new TypeError('Flow temporal frame requires one admitted timeline publication')
    }
    if (captured.lowerSampleKey === captured.upperSampleKey &&
        epochs.lowerSnapshotEpoch !== epochs.upperSnapshotEpoch) {
        throw new Error('Flow temporal frame selection provenance is stale')
    }
    return Object.freeze({
        kind: 'flow-temporal-frame-snapshot' as const,
        timelineRevision: timeline.revision,
        selectionRevision: timeline.selectionRevision,
        windowRequestRevision: capture.requestedRevision,
        pairGeneration: capture.pairGeneration,
        requestedModelTime: timeline.modelTime,
        presentedModelTime: capture.selection.modelTime,
        lowerSampleKey: captured.lowerSampleKey,
        upperSampleKey: captured.upperSampleKey,
        alpha: captured.alpha,
        temporalResidencyEpoch: epochs.temporalResidencyEpoch,
        lowerSnapshotEpoch: epochs.lowerSnapshotEpoch,
        upperSnapshotEpoch: epochs.upperSnapshotEpoch,
    })
}

function selectionEndpoints(value: Readonly<{
    selection: FlowTimeSelection
}>): Readonly<{
    lowerSampleKey: string
    upperSampleKey: string
    alpha: number
}> {

    const selection = value?.selection
    if (selection?.kind === 'exact') {
        return Object.freeze({
            lowerSampleKey: selection.sample.sampleKey,
            upperSampleKey: selection.sample.sampleKey,
            alpha: 0,
        })
    }
    if (selection?.kind === 'interpolated') {
        return Object.freeze({
            lowerSampleKey: selection.lower.sampleKey,
            upperSampleKey: selection.upper.sampleKey,
            alpha: selection.alpha,
        })
    }
    throw new TypeError('Flow temporal frames cannot sample a temporal gap')
}

function validateFlowTemporalCapture<Runtime extends object>(
    timeline: FlowTimelineSnapshot,
    capture: FlowTemporalReadyCapture<Runtime>
): ReturnType<typeof selectionEndpoints> {

    if (!positiveInteger(timeline?.revision) || !positiveInteger(timeline.selectionRevision) ||
        timeline.readiness !== 'ready' || !Number.isFinite(timeline.modelTime) ||
        capture?.state !== 'ready' || !positiveInteger(capture.requestedRevision) ||
        !positiveInteger(capture.pairGeneration) || !Number.isFinite(capture.alpha) ||
        capture.alpha < 0 || capture.alpha > 1 ||
        timeline.modelTime !== capture.selection.modelTime) {
        throw new TypeError('Flow temporal frame requires one admitted timeline publication')
    }
    const expected = selectionEndpoints(timeline)
    const captured = selectionEndpoints({ selection: capture.selection })
    if (expected.lowerSampleKey !== captured.lowerSampleKey ||
        expected.upperSampleKey !== captured.upperSampleKey ||
        expected.alpha !== captured.alpha || captured.alpha !== capture.alpha ||
        capture.lower.sample.sampleKey !== captured.lowerSampleKey ||
        capture.upper.sample.sampleKey !== captured.upperSampleKey ||
        (captured.lowerSampleKey === captured.upperSampleKey &&
            capture.lower.runtime !== capture.upper.runtime) ||
        (captured.lowerSampleKey !== captured.upperSampleKey &&
            capture.lower.runtime === capture.upper.runtime)) {
        throw new Error('Flow temporal frame selection provenance is stale')
    }
    return captured
}

function positiveInteger(value: unknown): value is number {

    return Number.isSafeInteger(value) && Number(value) > 0
}
