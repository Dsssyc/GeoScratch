import type { FlowFieldDataset, FlowFieldRuntimeSample } from './flow-dataset.ts'
import type { FlowTimelineSnapshot } from './flow-timeline.ts'

/** Selects one directional lookahead without changing model time or inventing gap interpolation. */
export function flowPrefetchSample(
    axis: FlowFieldDataset['timeAxis'],
    timeline: FlowTimelineSnapshot
): FlowFieldRuntimeSample | undefined {
    if (!timeline.playing || timeline.selection.kind === 'gap' || axis.samples.length < 2) return undefined
    const forward = timeline.rate > 0
    const edge = timeline.selection.kind === 'exact' ? timeline.selection.sample
        : forward ? timeline.selection.upper : timeline.selection.lower
    const index = axis.samples.findIndex(sample => sample.sampleKey === edge.sampleKey)
    if (index < 0) throw new TypeError('Flow prefetch selection is outside the dataset')
    const next = index + (forward ? 1 : -1)
    if (next < 0 || next >= axis.samples.length) {
        // Loop is a discontinuous destination, never a last-to-first interpolation pair.
        return timeline.loop === 'loop' ? axis.samples[forward ? 0 : axis.samples.length - 1] : undefined
    }
    const sample = axis.samples[next]!
    const lower = forward ? edge : sample
    const upper = forward ? sample : edge
    const adjacency = axis.adjacency.find(value =>
        value.lowerSampleKey === lower.sampleKey && value.upperSampleKey === upper.sampleKey)
    return adjacency?.kind === 'interpolable' ? sample : undefined
}
