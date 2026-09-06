import { expect } from 'chai'
import { flowPairViewReady, flowRuntimeViewReady } from '../examples/flowField/flow-pair-presentation.ts'

describe('Flow Field temporal pair presentation', () => {
    function runtime(sampleKey, availability) {
        return {
            source: {sampleKey},
            addressSpace: {pageFromTile: tile => ({tile, owner: sampleKey})},
            residency: {availability(page) {
                expect(page.owner).to.equal(sampleKey)
                return availability
            }},
        }
    }
    const pages = [{tile: {matrixId: '10', tileRow: 417, tileCol: 855}}]
    const capture = (lower, upper) => ({lower: {runtime: lower}, upper: {runtime: upper}})

    it('does not declare a view complete with safety-only or staged endpoint pages', () => {
        const ready = runtime('t00', 'resident')
        expect(flowPairViewReady(capture(ready, ready), [])).to.equal(false)
        for (const state of ['missing', 'staged']) {
            expect(flowPairViewReady(capture(ready, runtime('t01', state)), pages)).to.equal(false)
        }
        expect(flowPairViewReady(capture(ready, runtime('t01', 'resident')), pages)).to.equal(true)
    })

    it('supports an exact endpoint without probing another source identity', () => {
        const only = runtime('t04', 'resident')
        let probes = 0
        only.residency.availability = () => { probes++; return 'resident' }
        expect(flowPairViewReady(capture(only, only), pages)).to.equal(true)
        expect(probes).to.equal(1)
    })

    it('reports failed view data instead of waiting indefinitely', () => {
        expect(() => flowPairViewReady(capture(
            runtime('t00', 'resident'), runtime('t01', 'failed')
        ), pages)).to.throw(/t01/)
    })

    it('does not hide a failure behind another missing page or endpoint', () => {
        const mixed = runtime('t02', 'missing')
        let calls = 0
        mixed.residency.availability = () => ++calls === 1 ? 'missing' : 'failed'
        expect(() => flowRuntimeViewReady(mixed, [...pages, ...pages])).to.throw(/t02/)
        expect(() => flowPairViewReady(capture(
            runtime('t00', 'missing'), runtime('t01', 'failed')
        ), pages)).to.throw(/t01/)
    })

    it('checks an optional source without confusing factory readiness with detail residency', () => {
        expect(flowRuntimeViewReady(runtime('t02', 'missing'), [])).to.equal(true)
        for (const state of ['missing', 'staged']) {
            expect(flowRuntimeViewReady(runtime('t02', state), pages)).to.equal(false)
        }
        expect(flowRuntimeViewReady(runtime('t02', 'resident'), pages)).to.equal(true)
        expect(() => flowRuntimeViewReady(runtime('t02', 'failed'), pages)).to.throw(/t02/)
    })
})
