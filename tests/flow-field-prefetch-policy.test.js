import { expect } from 'chai'
import { flowPrefetchSample } from '../examples/flowField/flow-prefetch-policy.ts'

describe('Flow Field lookahead policy', () => {
    const samples = [0,1,2,5].map(timeIndex => ({ sampleKey:`t${String(timeIndex).padStart(2,'0')}`, timeIndex, modelTime:timeIndex }))
    const axis = {samples, adjacency: [
        {lowerSampleKey:'t00',upperSampleKey:'t01',kind:'interpolable'},
        {lowerSampleKey:'t01',upperSampleKey:'t02',kind:'interpolable'},
        {lowerSampleKey:'t02',upperSampleKey:'t05',kind:'gap'},
    ]}
    const snapshot = (selection, extra = {}) => ({playing:true,rate:0.2,loop:'clamp',selection,...extra})
    const pair = {kind:'interpolated',lower:samples[0],upper:samples[1]}
    it('looks past the current pair in playback direction', () => {
        expect(flowPrefetchSample(axis,snapshot(pair))).to.equal(samples[2])
        expect(flowPrefetchSample(axis,snapshot({kind:'interpolated',lower:samples[1],upper:samples[2]}, {rate:-0.2})))
            .to.equal(samples[0])
    })
    it('keeps the next endpoint across exact selection and cancels when paused', () => {
        expect(flowPrefetchSample(axis,snapshot({kind:'exact',sample:samples[1]}))).to.equal(samples[2])
        expect(flowPrefetchSample(axis,snapshot(pair,{playing:false}))).to.equal(undefined)
    })
    it('does not interpolate or prefetch across an omitted interval', () => {
        expect(flowPrefetchSample(axis,snapshot({kind:'interpolated',lower:samples[1],upper:samples[2]}))).to.equal(undefined)
        expect(flowPrefetchSample(axis,snapshot({kind:'gap'}))).to.equal(undefined)
    })
    it('warms only a loop destination and does not exceed a clamped or singleton axis', () => {
        const exact = {kind:'exact',sample:samples[3]}
        expect(flowPrefetchSample(axis,snapshot(exact))).to.equal(undefined)
        expect(flowPrefetchSample(axis,snapshot(exact,{loop:'loop'}))).to.equal(samples[0])
        expect(flowPrefetchSample(axis,snapshot({kind:'exact',sample:samples[0]},{loop:'loop',rate:-1}))).to.equal(samples[3])
        expect(flowPrefetchSample({samples:[samples[0]],adjacency:[]},snapshot({kind:'exact',sample:samples[0]},{loop:'loop'}))).to.equal(undefined)
    })
})
