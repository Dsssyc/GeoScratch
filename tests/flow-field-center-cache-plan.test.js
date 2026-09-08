import { expect } from 'chai'
import { WebMercatorQuad, tileMatrixCoverage, virtualRasterAddressSpace } from 'geoscratch/geo'
import {
    FLOW_CENTER_CACHE_EDGE,
    FLOW_CENTER_CACHE_MAX_PAGES,
    flowCenterCachePlan,
} from '../examples/flowField/flow-center-cache-plan.ts'

const space = virtualRasterAddressSpace({
    id: 'flow-center-plan', dimensions: 2, extent: [2048, 2048], pageSize: [256, 256], levelCount: 3,
})

describe('Flow center-distance cache page planning', () => {
    it('declares bounded source-center cache dimensions', () => {
        expect(FLOW_CENTER_CACHE_EDGE).to.equal(257)
        expect(FLOW_CENTER_CACHE_MAX_PAGES).to.equal(48)
    })

    it('sorts and deduplicates the selected global indices without mutating source demand', () => {
        const a = space.page({level:0,x:6,y:1}), b = space.page({level:0,x:2,y:0})
        const input = Object.freeze([a,b,a,{...b}])
        const planned = flowCenterCachePlan(space, 4, input, 0)
        const reversed = flowCenterCachePlan(space, 4, [...input].reverse(), 0)
        expect(planned.key).to.equal('0:2,14')
        expect(planned.pageCount).to.equal(2)
        expect(planned.lookup.length).to.equal(space.pageTableEntryCount)
        expect([...planned.lookup]).to.deep.equal([...reversed.lookup])
        expect([...planned.jobs]).to.deep.equal([2,0,0,0,6,1,1,0,0,0,0,0,0,0,0,0])
        expect([...planned.jobs]).to.deep.equal([...reversed.jobs])
        expect(reversed.key).to.equal(planned.key)
        expect(input).to.deep.equal([a,b,a,b])
        expect(planned.lookup[2]).to.equal(1)
        expect(planned.lookup[14]).to.equal(2)
    })

    it('bounds cache jobs to the first capacity pages and leaves every omitted lookup at zero', () => {
        const input = space.pages().filter(page => page.level === 0).reverse()
        const planned = flowCenterCachePlan(space, 48, input, 0)
        expect(planned.pageCount).to.equal(48)
        expect(planned.jobs.length).to.equal(48 * 4)
        expect(planned.jobs.byteLength).to.equal(48 * 16)
        expect([...planned.jobs.slice(-4)]).to.deep.equal([7,5,47,0])
        for (let index = 0; index < planned.lookup.length; index++) {
            expect(planned.lookup[index], `lookup ${index}`).to.equal(index < 48 ? index + 1 : 0)
        }
        for (let slot = 0; slot < 48; slot++) {
            expect([...planned.jobs.slice(slot * 4, slot * 4 + 4)])
                .to.deep.equal([slot % 8, Math.floor(slot / 8), slot, 0])
        }
        expect(planned.key).to.equal(`0:${Array.from({length:48}, (_,index) => index).join(',')}`)
        expect(flowCenterCachePlan(space, 48, input.slice().reverse(), 0).key).to.equal(planned.key)
    })

    it('selects only the requested level and has an explicit empty plan', () => {
        const upper = space.page({level:1,x:2,y:1}), lower = space.page({level:0,x:2,y:1})
        const planned = flowCenterCachePlan(space, 2, [lower,upper], 1)
        expect(planned.key).to.equal(`1:${space.tableIndex(upper)}`)
        expect(planned.pageCount).to.equal(1)
        expect(planned.lookup[space.tableIndex(lower)]).to.equal(0)
        expect(planned.lookup[space.tableIndex(upper)]).to.equal(1)
        expect([...planned.jobs]).to.deep.equal([2,1,0,0,0,0,0,0])
        const empty = flowCenterCachePlan(space, 2, [lower], 1)
        expect(empty.key).to.equal('1:')
        expect(empty.pageCount).to.equal(0)
        expect([...empty.lookup].every(value => value === 0)).to.equal(true)
        expect([...empty.jobs]).to.deep.equal(Array(8).fill(0))
    })

    it('emits actual global tile coordinates for compact nonzero-origin coverage', () => {
        const tiled = virtualRasterAddressSpace({id:'flow-center-tiled',coverage:tileMatrixCoverage({
            tileMatrixSet:WebMercatorQuad,
            limits:[{matrixId:'3',minTileCol:3,maxTileCol:6,minTileRow:4,maxTileRow:5}],
        })})
        const first = tiled.page({level:0,x:3,y:4}), last = tiled.page({level:0,x:6,y:5})
        const planned = flowCenterCachePlan(tiled, 2, [last,first], 0)
        expect(planned.key).to.equal('0:0,7')
        expect([...planned.jobs]).to.deep.equal([3,4,0,0,6,5,1,0])
        expect([...planned.lookup]).to.deep.equal([1,0,0,0,0,0,0,2])
    })

    it('keys only the selected indices and level, independently of budget slack or unrelated inputs', () => {
        const selected = space.page({level:0,x:0,y:0}), excess = space.page({level:0,x:7,y:7})
        const otherLevel = space.page({level:1,x:0,y:0})
        expect(flowCenterCachePlan(space, 1, [selected,excess,otherLevel], 0).key)
            .to.equal(flowCenterCachePlan(space, 48, [selected], 0).key)
        expect(flowCenterCachePlan(space, 1, [], 0).key).not.to.equal(flowCenterCachePlan(space, 1, [], 1).key)
        const first = flowCenterCachePlan(space, 1, [selected], 0)
        const second = flowCenterCachePlan(space, 1, [selected], 0)
        expect(Object.isFrozen(first)).to.equal(true)
        expect(first.lookup).not.to.equal(second.lookup)
        expect(first.jobs).not.to.equal(second.jobs)
        first.lookup.fill(0)
        first.jobs.fill(99)
        expect(second.lookup[space.tableIndex(selected)]).to.equal(1)
        expect([...second.jobs]).to.deep.equal([0,0,0,0])
    })

    it('rejects invalid capacities and levels before constructing GPU payload arrays', () => {
        for (const capacity of [0,49,-1,1.5,NaN,Infinity,null,'2']) {
            expect(() => flowCenterCachePlan(space, capacity, [], 0)).to.throw(RangeError)
        }
        for (const level of [-1,3,0.5,NaN,Infinity,null,'0']) {
            expect(() => flowCenterCachePlan(space, 1, [], level)).to.throw(RangeError)
        }
        for (const pages of [null,undefined,{},new Set()]) {
            expect(() => flowCenterCachePlan(space, 1, pages, 0)).to.throw(TypeError)
        }
    })

    it('requires a two-dimensional 256 by 256 address space', () => {
        for (const dimensions of [1,3]) {
            const invalid = virtualRasterAddressSpace({id:`dimension-${dimensions}`,dimensions,
                extent:Array(dimensions).fill(512),pageSize:Array(dimensions).fill(256),levelCount:1})
            expect(() => flowCenterCachePlan(invalid, 1, [], 0)).to.throw(TypeError)
        }
        for (const pageSize of [[128,256],[256,128],[512,512]]) {
            const invalid = virtualRasterAddressSpace({id:'wrong-size',dimensions:2,
                extent:[512,512],pageSize,levelCount:1})
            expect(() => flowCenterCachePlan(invalid, 1, [], 0)).to.throw(TypeError)
        }
        for (const invalid of [undefined,null,{}]) {
            expect(() => flowCenterCachePlan(invalid, 1, [], 0)).to.throw(TypeError)
        }
    })

    it('validates every page identity, including rejected levels and over-budget candidates', () => {
        const foreign = virtualRasterAddressSpace({id:'foreign-center',dimensions:2,
            extent:[2048,2048],pageSize:[256,256],levelCount:3})
        const own = space.page({level:0,x:0,y:0})
        for (const invalid of [foreign.page({level:0,x:1,y:0}),foreign.page({level:1,x:0,y:0}),
            {...own,key:'forged'}, {...own,coordinates:[8,0]}, {...own,dimensions:3}]) {
            expect(() => flowCenterCachePlan(space, 1, [own,invalid], 0)).to.throw()
        }
    })
})
