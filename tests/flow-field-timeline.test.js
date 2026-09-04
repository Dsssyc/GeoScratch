import { expect } from 'chai'
import {
    createFlowTimeline,
} from '../examples/flowField/flow-timeline.ts'

const HASH = '0123456789abcdef'.repeat(4)

describe('Flow Field timeline', () => {

    it('resolves exact, interpolated, and explicit gap selections', () => {

        const timeline = createFlowTimeline({
            timeAxis: timeAxis([ 0, 1, 4, 5 ], [ 0, 2, 8, 10 ]),
            wallTime: 0,
            readiness: ready(),
        })

        expect(timeline.snapshot().selection).to.deep.include({
            kind: 'exact',
            modelTime: 0,
        })
        const interpolated = timeline.seek({ wallTime: 10, modelTime: 1 })
        expect(interpolated.selection).to.deep.include({ kind: 'interpolated', alpha: 0.5 })
        expect(interpolated.selection.lower.sampleKey).to.equal('t00')
        expect(interpolated.selection.upper.sampleKey).to.equal('t01')
        expect(interpolated.readiness).to.equal('blocked')
        expect(interpolated.blockedReason).to.equal('selection-changed')
        expect(interpolated.canAdvance).to.equal(false)
        expect(interpolated.selectionRevision).to.equal(2)
        const samePair = timeline.seek({ wallTime: 15, modelTime: 1.5 })
        expect(samePair.selectionRevision).to.equal(2)

        const beforeStale = timeline.snapshot()
        expect(() => timeline.tick({ wallTime: 16, readiness: ready(1) }))
            .to.throw(RangeError, 'stale selection')
        expect(timeline.snapshot()).to.deep.equal(beforeStale)

        const gap = timeline.seek({ wallTime: 20, modelTime: 5 })
        expect(gap.selection).to.deep.include({
            kind: 'gap',
            modelTime: 5,
            reason: 'omitted-source-samples',
        })
        expect(gap.selection.lower.sampleKey).to.equal('t01')
        expect(gap.selection.upper.sampleKey).to.equal('t04')

        const exact = timeline.seek({ wallTime: 30, modelTime: 8 })
        expect(exact.selection.kind).to.equal('exact')
        expect(exact.selection.sample.sampleKey).to.equal('t04')
        expect(Object.isFrozen(exact)).to.equal(true)
        expect(Object.isFrozen(exact.selection)).to.equal(true)
        expect(Object.isFrozen(exact.selection.sample)).to.equal(true)
    })

    it('uses explicit wall time for play, pause, and signed rates', () => {

        const timeline = createFlowTimeline({
            timeAxis: timeAxis([ 0, 1, 2 ], [ 0, 10, 20 ]),
            wallTime: 0,
            rate: 2,
            readiness: ready(),
        })

        expect(timeline.play({ wallTime: 0 })).to.deep.include({
            revision: 2,
            playing: true,
            canAdvance: true,
            needsTick: true,
        })
        const firstMotion = timeline.tick({ wallTime: 1000, readiness: ready() })
        expect(firstMotion.modelTime)
            .to.equal(2)
        expect(firstMotion).to.deep.include({
            selectionRevision: 2,
            readiness: 'blocked',
            blockedReason: 'selection-changed',
        })
        timeline.tick({ wallTime: 1000, readiness: ready(2) })
        const paused = timeline.pause({ wallTime: 2000 })
        expect(paused).to.deep.include({
            modelTime: 4,
            playing: false,
            canAdvance: true,
            needsTick: false,
        })
        expect(timeline.tick({ wallTime: 5000, readiness: ready(2) }).modelTime)
            .to.equal(4)

        timeline.setRate({ wallTime: 5000, rate: -1 })
        timeline.play({ wallTime: 5000 })
        const reversed = timeline.tick({ wallTime: 6000, readiness: ready(2) })
        expect(reversed).to.deep.include({ modelTime: 3, rate: -1, canAdvance: true })
    })

    it('reanchors through blocked readiness and never catches up', () => {

        const timeline = createFlowTimeline({
            timeAxis: timeAxis([ 0, 1 ], [ 0, 100 ]),
            wallTime: 0,
            modelTime: 1,
            playing: true,
            readiness: ready(),
        })

        expect(timeline.tick({ wallTime: 1000, readiness: ready() }).modelTime)
            .to.equal(2)
        const blockedSnapshot = timeline.tick({
            wallTime: 2000,
            readiness: notReady('velocity-pages-loading'),
        })
        expect(blockedSnapshot).to.deep.include({
            modelTime: 2,
            readiness: 'blocked',
            canAdvance: false,
            needsTick: false,
            blockedReason: 'velocity-pages-loading',
        })
        expect(timeline.tick({
            wallTime: 10000,
            readiness: notReady('velocity-pages-loading'),
        }).modelTime).to.equal(2)
        expect(timeline.tick({ wallTime: 20000, readiness: ready() }).modelTime)
            .to.equal(2)
        expect(timeline.tick({ wallTime: 21000, readiness: ready() }).modelTime)
            .to.equal(3)
    })

    it('advances through temporal gaps without ever interpolating their endpoints', () => {

        const axis = timeAxis([ 0, 1, 4, 5 ], [ 0, 2, 8, 10 ])
        const forwardTimeline = createFlowTimeline({
            timeAxis: axis,
            wallTime: 0,
            modelTime: 1,
            playing: true,
            rate: 5,
            readiness: ready(),
        })
        const forward = forwardTimeline.tick({
            wallTime: 1000,
            readiness: ready(),
        })
        expect(forward.modelTime).to.equal(6)
        expect(forward.selection.kind).to.equal('gap')
        expect(forward.selection.lower.sampleKey).to.equal('t01')
        expect(forward.selection.upper.sampleKey).to.equal('t04')
        expect(forward).to.deep.include({
            selectionRevision: 2,
            readiness: 'ready',
            canAdvance: true,
            needsTick: true,
            blockedReason: undefined,
        })
        const afterGap = forwardTimeline.tick({
            wallTime: 1600,
            readiness: ready(2),
        })
        expect(afterGap.modelTime).to.equal(9)
        expect(afterGap.selection.kind).to.equal('interpolated')
        expect(afterGap.selection.lower.sampleKey).to.equal('t04')
        expect(afterGap.selection.upper.sampleKey).to.equal('t05')
        expect(afterGap).to.deep.include({
            selectionRevision: 3,
            readiness: 'blocked',
            blockedReason: 'selection-changed',
        })

        const reverseTimeline = createFlowTimeline({
            timeAxis: axis,
            wallTime: 0,
            modelTime: 9,
            playing: true,
            rate: -5,
            readiness: ready(),
        })
        const reverse = reverseTimeline.tick({
            wallTime: 1000,
            readiness: ready(),
        })
        expect(reverse.modelTime).to.equal(4)
        expect(reverse.selection.kind).to.equal('gap')
        expect(reverse.selection.lower.sampleKey).to.equal('t01')
        expect(reverse.selection.upper.sampleKey).to.equal('t04')
        expect(reverse).to.deep.include({ canAdvance: true, needsTick: true })
        const beforeGap = reverseTimeline.tick({
            wallTime: 1600,
            readiness: ready(2),
        })
        expect(beforeGap.modelTime).to.equal(1)
        expect(beforeGap.selection.kind).to.equal('interpolated')
        expect(beforeGap.selection.lower.sampleKey).to.equal('t00')
        expect(beforeGap.selection.upper.sampleKey).to.equal('t01')
    })

    it('clamps or discontinuously wraps without a last-to-first interpolation pair', () => {

        const axis = timeAxis([ 0, 1, 2 ], [ 0, 10, 20 ])
        const timeline = createFlowTimeline({
            timeAxis: axis,
            wallTime: 0,
            modelTime: 19,
            playing: true,
            rate: 5,
            readiness: ready(),
        })
        const transition = timeline.tick({ wallTime: 1000, readiness: ready() })
        expect(transition).to.deep.include({
            modelTime: 20,
            selectionRevision: 2,
            blockedReason: 'selection-changed',
        })
        const clamped = timeline.tick({ wallTime: 1000, readiness: ready(2) })
        expect(clamped).to.deep.include({
            modelTime: 20,
            canAdvance: false,
            blockedReason: 'range-end',
        })
        expect(clamped.selection.kind).to.equal('exact')

        expect(timeline.setLoop({ wallTime: 1000, loop: 'loop' }).canAdvance).to.equal(true)
        const wrapped = timeline.tick({ wallTime: 1500, readiness: ready(2) })
        expect(wrapped.modelTime).to.equal(2.5)
        expect(wrapped.selection.kind).to.equal('interpolated')
        expect(wrapped.selection.lower.sampleKey).to.equal('t00')
        expect(wrapped.selection.upper.sampleKey).to.equal('t01')

        const backwards = createFlowTimeline({
            timeAxis: axis,
            wallTime: 0,
            playing: true,
            rate: -5,
            loop: 'loop',
            readiness: ready(),
        }).tick({ wallTime: 500, readiness: ready() })
        expect(backwards.modelTime).to.equal(17.5)
        expect(backwards.selection.kind).to.equal('interpolated')
        expect(backwards.selection.lower.sampleKey).to.equal('t01')
        expect(backwards.selection.upper.sampleKey).to.equal('t02')
    })

    it('keeps a single sample exact and idle even when playing', () => {

        const snapshot = createFlowTimeline({
            timeAxis: timeAxis([ 7 ], [ 42 ]),
            wallTime: 100,
            playing: true,
            readiness: ready(),
        }).tick({ wallTime: 5000, readiness: ready() })

        expect(snapshot).to.deep.include({
            modelTime: 42,
            canAdvance: false,
            needsTick: false,
            blockedReason: 'single-sample',
        })
        expect(snapshot.selection.kind).to.equal('exact')
    })

    it('accumulates sub-ULP motion from one stable ready anchor', () => {

        const base = 1e16
        const timeline = createFlowTimeline({
            timeAxis: timeAxis([ 0, 1 ], [ base, base + 100 ]),
            wallTime: 0,
            playing: true,
            rate: 1,
            readiness: ready(),
        })

        expect(timeline.tick({ wallTime: 1000, readiness: ready() }).modelTime)
            .to.equal(base)
        const accumulated = timeline.tick({ wallTime: 2000, readiness: ready() })
        expect(accumulated.modelTime).to.equal(base + 2)
        expect(accumulated.selectionRevision).to.equal(2)
        expect(accumulated.blockedReason).to.equal('selection-changed')

        const controlled = createFlowTimeline({
            timeAxis: timeAxis([ 0, 1 ], [ base, base + 100 ]),
            wallTime: 0,
            playing: true,
            rate: 1,
            readiness: ready(),
        })
        expect(controlled.tick({ wallTime: 1000, readiness: ready() }).modelTime)
            .to.equal(base)
        controlled.pause({ wallTime: 1000 })
        controlled.play({ wallTime: 1000 })
        expect(controlled.tick({ wallTime: 2000, readiness: ready() }).modelTime)
            .to.equal(base + 2)
    })

    it('rejects malformed axes, clocks, rates, loops, and readiness atomically', () => {

        const axis = timeAxis([ 0, 1 ], [ 0, 10 ])
        const malformed = timeAxis([ 0, 2 ], [ 0, 10 ])
        malformed.adjacency[0] = {
            lowerSampleKey: 't00',
            upperSampleKey: 't02',
            kind: 'interpolable',
            interpolation: 'component-wise-linear',
        }
        expect(() => createFlowTimeline({ timeAxis: malformed, wallTime: 0 }))
            .to.throw(TypeError)
        expect(() => createFlowTimeline({ timeAxis: axis, wallTime: Number.NaN }))
            .to.throw(TypeError)
        expect(() => createFlowTimeline({
            timeAxis: timeAxis([ 0, 1 ], [ -Number.MAX_VALUE, Number.MAX_VALUE ]),
            wallTime: 0,
        })).to.throw(TypeError, 'strictly ordered')
        expect(() => createFlowTimeline({
            timeAxis: timeAxis([ 0, 1, 2 ], [ -1e308, 0, 1e308 ]),
            wallTime: 0,
        })).to.throw(TypeError, 'span must be finite')

        const timeline = createFlowTimeline({ timeAxis: axis, wallTime: 10 })
        const before = timeline.snapshot()
        expect(() => timeline.play({ wallTime: 9 })).to.throw(RangeError)
        expect(() => timeline.setRate({ wallTime: 10, rate: 0 })).to.throw(TypeError)
        expect(() => timeline.setLoop({ wallTime: 10, loop: 'ping-pong' })).to.throw(TypeError)
        expect(() => timeline.tick({
            wallTime: 10,
            readiness: notReady(''),
        })).to.throw(TypeError)
        expect(timeline.snapshot()).to.deep.equal(before)

        const overflowing = createFlowTimeline({
            timeAxis: axis,
            wallTime: 0,
            playing: true,
            rate: Number.MAX_VALUE,
            readiness: ready(),
        })
        const beforeOverflow = overflowing.snapshot()
        expect(() => overflowing.tick({
            wallTime: Number.MAX_VALUE,
            readiness: ready(),
        })).to.throw(RangeError, 'delta must remain finite')
        expect(overflowing.snapshot()).to.deep.equal(beforeOverflow)
    })
})

function timeAxis(indices, modelTimes) {

    const samples = indices.map((timeIndex, index) => ({
        sampleKey: `t${String(timeIndex).padStart(2, '0')}`,
        timeIndex,
        modelTime: modelTimes[index],
        unit: 'hour',
        phase: 'test',
        sourceHash: HASH,
    }))
    return {
        unit: 'hour',
        phase: 'test',
        sourceSampleCount: Math.max(indices.length, indices.at(-1) + 1),
        samples,
        adjacency: samples.slice(1).map((upper, index) => {
            const lower = samples[index]
            return upper.timeIndex === lower.timeIndex + 1
                ? {
                    lowerSampleKey: lower.sampleKey,
                    upperSampleKey: upper.sampleKey,
                    kind: 'interpolable',
                    interpolation: 'component-wise-linear',
                }
                : {
                    lowerSampleKey: lower.sampleKey,
                    upperSampleKey: upper.sampleKey,
                    kind: 'gap',
                    interpolation: 'none',
                    reason: 'omitted-source-samples',
                }
        }),
    }
}

function ready(selectionRevision = 1) {

    return { state: 'ready', selectionRevision }
}

function notReady(reason, selectionRevision = 1) {

    return { state: 'blocked', reason, selectionRevision }
}
