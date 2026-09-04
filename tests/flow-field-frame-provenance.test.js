import { expect } from 'chai'
import {
    flowTemporalFrameSnapshot,
} from '../examples/flowField/flow-frame-provenance.ts'

const HASH = '0123456789abcdef'.repeat(4)
const lower = sample('t00', 0, 0)
const upper = sample('t01', 1, 10)

describe('Flow Field selection frame provenance', () => {

    it('binds an interpolated timeline to one window pair and publication epoch set', () => {

        const selection = Object.freeze({
            kind: 'interpolated',
            modelTime: 2.5,
            lower,
            upper,
            alpha: 0.25,
        })
        const snapshot = flowTemporalFrameSnapshot(
            timeline(selection, 8, 3),
            capture(selection, 12, 4),
            {
                temporalResidencyEpoch: 9,
                lowerSnapshotEpoch: 17,
                upperSnapshotEpoch: 21,
            }
        )

        expect(snapshot).to.deep.equal({
            kind: 'flow-temporal-frame-snapshot',
            timelineRevision: 8,
            selectionRevision: 3,
            windowRequestRevision: 12,
            pairGeneration: 4,
            requestedModelTime: 2.5,
            presentedModelTime: 2.5,
            lowerSampleKey: 't00',
            upperSampleKey: 't01',
            alpha: 0.25,
            temporalResidencyEpoch: 9,
            lowerSnapshotEpoch: 17,
            upperSnapshotEpoch: 21,
        })
        expect(Object.isFrozen(snapshot)).to.equal(true)
    })

    it('uses one sample and one epoch twice for an exact selection', () => {

        const selection = Object.freeze({ kind: 'exact', modelTime: 0, sample: lower })
        const runtime = Object.freeze({ id: 'runtime-t00' })
        const ready = capture(selection, 2, 1, runtime, runtime)
        const snapshot = flowTemporalFrameSnapshot(timeline(selection), ready, {
            temporalResidencyEpoch: 1,
            lowerSnapshotEpoch: 6,
            upperSnapshotEpoch: 6,
        })

        expect(snapshot).to.deep.include({
            lowerSampleKey: 't00',
            upperSampleKey: 't00',
            alpha: 0,
            lowerSnapshotEpoch: 6,
            upperSnapshotEpoch: 6,
        })
    })

    it('rejects stale pair, alpha, model-time, sample, gap, and epoch provenance', () => {

        const selection = Object.freeze({
            kind: 'interpolated',
            modelTime: 5,
            lower,
            upper,
            alpha: 0.5,
        })
        const baseTimeline = timeline(selection)
        const baseCapture = capture(selection)
        const epochs = {
            temporalResidencyEpoch: 1,
            lowerSnapshotEpoch: 2,
            upperSnapshotEpoch: 3,
        }
        const cases = [
            () => flowTemporalFrameSnapshot(
                { ...baseTimeline, modelTime: 4 },
                baseCapture,
                epochs
            ),
            () => flowTemporalFrameSnapshot(baseTimeline, {
                ...baseCapture,
                alpha: 0.25,
            }, epochs),
            () => flowTemporalFrameSnapshot(baseTimeline, {
                ...baseCapture,
                upper: { ...baseCapture.upper, sample: sample('t02', 2, 20) },
            }, epochs),
            () => flowTemporalFrameSnapshot({
                ...baseTimeline,
                selection: {
                    kind: 'gap',
                    modelTime: 5,
                    lower,
                    upper,
                    reason: 'omitted-source-samples',
                },
            }, baseCapture, epochs),
            () => flowTemporalFrameSnapshot(baseTimeline, baseCapture, {
                ...epochs,
                upperSnapshotEpoch: 0,
            }),
            () => flowTemporalFrameSnapshot({
                ...baseTimeline,
                readiness: 'blocked',
                canAdvance: false,
                needsTick: false,
                blockedReason: 'selection-changed',
            }, baseCapture, epochs),
            () => flowTemporalFrameSnapshot(baseTimeline, {
                ...baseCapture,
                upper: { ...baseCapture.upper, runtime: baseCapture.lower.runtime },
            }, epochs),
        ]
        for (const invoke of cases) expect(invoke).to.throw()
    })
})

function sample(sampleKey, timeIndex, modelTime) {

    return Object.freeze({
        sampleKey,
        timeIndex,
        modelTime,
        unit: 'hour',
        phase: 'test',
        sourceHash: HASH,
    })
}

function timeline(selection, revision = 1, selectionRevision = 1) {

    return Object.freeze({
        revision,
        selectionRevision,
        modelTime: selection.modelTime,
        playing: true,
        rate: 1,
        loop: 'clamp',
        readiness: 'ready',
        canAdvance: true,
        needsTick: true,
        blockedReason: undefined,
        selection,
    })
}

function capture(
    selection,
    requestedRevision = 1,
    pairGeneration = 1,
    lowerRuntime = Object.freeze({ id: 'runtime-lower' }),
    upperRuntime = Object.freeze({ id: 'runtime-upper' })
) {

    const lowerSample = selection.kind === 'exact' ? selection.sample : selection.lower
    const upperSample = selection.kind === 'exact' ? selection.sample : selection.upper
    return Object.freeze({
        state: 'ready',
        requestedRevision,
        pairGeneration,
        selection,
        alpha: selection.kind === 'exact' ? 0 : selection.alpha,
        lower: Object.freeze({ sample: lowerSample, runtime: lowerRuntime }),
        upper: Object.freeze({ sample: upperSample, runtime: upperRuntime }),
        release() {},
    })
}
