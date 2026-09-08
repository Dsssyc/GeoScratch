import { expect } from 'chai'
import { createFlowVisualClock } from '../examples/flowField/flow-visual-clock.ts'

describe('Flow visual reference clock', () => {
    it('normalizes 30/60/120 Hz to sixty reference ticks per second', () => {
        for (const hz of [30,60,120]) {
            const clock = createFlowVisualClock()
            expect(clock.tick(0,true)).to.deep.equal({referenceSteps:0,wholeSteps:0,discardedSeconds:0})
            let reference = 0, whole = 0
            const steps = []
            for (let index = 1; index <= hz; index++) {
                const tick = clock.tick(index * 1000 / hz,true)
                expect(tick.referenceSteps).to.be.closeTo(60 / hz,1e-12)
                expect(tick.discardedSeconds).to.equal(0)
                reference += tick.referenceSteps
                whole += tick.wholeSteps
                steps.push(tick.wholeSteps)
            }
            expect(reference).to.be.closeTo(60,1e-10)
            expect(whole).to.equal(60)
            if (hz === 120) expect(steps).to.deep.equal(Array.from({length:120},(_,index) => index % 2))
        }
    })

    it('shares fractional time across irregular frames without losing integer age/decay ticks', () => {
        const clock = createFlowVisualClock()
        clock.tick(100,true)
        let time = 100, reference = 0, whole = 0
        for (const delta of [1,4,8,17,31,49,3,6,12,21,48,50,9,2]) {
            time += delta
            const tick = clock.tick(time,true)
            reference += tick.referenceSteps
            whole += tick.wholeSteps
            expect(whole).to.equal(Math.floor(reference + 1e-9))
            expect(tick.wholeSteps).to.be.within(0,3)
        }
        const repeated = clock.tick(time,true)
        expect(repeated).to.deep.equal({referenceSteps:0,wholeSteps:0,discardedSeconds:0})
    })

    it('caps a short stall and discards the excess instead of accumulating future catch-up', () => {
        const clock = createFlowVisualClock()
        clock.tick(0,true)
        const capped = clock.tick(200,true)
        expect(capped).to.include({referenceSteps:3,wholeSteps:3})
        expect(capped.discardedSeconds).to.be.closeTo(.15,1e-12)
        const next = clock.tick(200 + 1000 / 60,true)
        expect(next.referenceSteps).to.be.closeTo(1,1e-12)
        expect(next.wholeSteps).to.equal(1)
        expect(next.discardedSeconds).to.equal(0)
    })

    it('reanchors long gaps and clears residual phase', () => {
        const clock = createFlowVisualClock()
        clock.tick(0,true)
        expect(clock.tick(1000 / 120,true).wholeSteps).to.equal(0)
        const gap = clock.tick(1000,true)
        expect(gap.referenceSteps).to.equal(0)
        expect(gap.wholeSteps).to.equal(0)
        expect(gap.discardedSeconds).to.be.closeTo(1 - 1 / 120,1e-12)
        expect(clock.tick(1000 + 1000 / 120,true).wholeSteps).to.equal(0)
        expect(clock.tick(1000 + 1000 / 60,true).wholeSteps).to.equal(1)
    })

    it('keeps paused controls and resume/reset first frames at zero without debt', () => {
        const clock = createFlowVisualClock()
        clock.tick(0,true)
        clock.tick(8,true)
        for (const time of [100,1000,1200]) expect(clock.tick(time,false))
            .to.deep.equal({referenceSteps:0,wholeSteps:0,discardedSeconds:0})
        expect(clock.tick(1300,true)).to.deep.equal({referenceSteps:0,wholeSteps:0,discardedSeconds:0})
        expect(clock.tick(1308,true).wholeSteps).to.equal(0)
        clock.reset()
        expect(clock.tick(1600,true)).to.deep.equal({referenceSteps:0,wholeSteps:0,discardedSeconds:0})
        expect(clock.tick(1608,true).wholeSteps).to.equal(0)
        expect(clock.tick(1617,true).wholeSteps).to.equal(1)
    })

    it('rejects bad or backward clocks without mutating a valid timing anchor', () => {
        const clock = createFlowVisualClock()
        clock.tick(100,true)
        for (const value of [NaN,Infinity,-Infinity,-1,99,null,undefined,'110']) {
            expect(() => clock.tick(value,true)).to.throw(RangeError)
        }
        for (const value of [null,undefined,0,1,'true']) expect(() => clock.tick(110,value)).to.throw(TypeError)
        expect(clock.tick(110,true).referenceSteps).to.equal(.6)
        clock.reset()
        expect(() => clock.tick(109,true)).to.throw(RangeError)
        expect(Object.isFrozen(clock.tick(111,true))).to.equal(true)
    })
})
