import { expect } from 'chai'
import {
    FLOW_FIELD_PRESENTATION,
    FLOW_FIELD_SDF_FEATHER,
    flowFieldPresentation,
    flowFieldSdfFeatherTexels,
} from '../examples/flowField/flow-presentation.ts'

describe('Flow Field presentation choices', () => {
    it('defaults to the hard boundary and normalizes older input objects', () => {
        const input = {view:'particles',sample:'interpolated',trails:true,contour:false}
        const normalized = flowFieldPresentation(input)
        expect(normalized).to.deep.equal({...input,boundary:'hard',sdfFeatherTexels:0.25})
        expect(FLOW_FIELD_PRESENTATION).to.deep.equal(normalized)
        expect(Object.isFrozen(normalized)).to.equal(true)
        expect(input).to.not.have.property('boundary')
        expect(input).to.not.have.property('sdfFeatherTexels')
    })

    it('preserves a selected SDF boundary and unrelated inspection choices', () => {
        for (const view of ['particles','speed','direction','u','v','status']) {
            const input = {...FLOW_FIELD_PRESENTATION,view,sample:'upper',trails:false,contour:true,boundary:'sdf'}
            expect(flowFieldPresentation(input)).to.deep.equal(input)
        }
    })

    it('rejects explicitly invalid boundary choices without treating null as omission', () => {
        for (const boundary of [null,'smooth','',0,true,{},[]]) {
            expect(() => flowFieldPresentation({...FLOW_FIELD_PRESENTATION,boundary})).to.throw(TypeError)
        }
    })

    it('keeps the existing validation of view, sample and toggles', () => {
        for (const changed of [{view:'bad'},{sample:'bad'},{trails:0},{contour:null}]) {
            expect(() => flowFieldPresentation({...FLOW_FIELD_PRESENTATION,...changed})).to.throw(TypeError)
        }
    })

    it('shares immutable source-texel bounds and accepts finite widths without snapping', () => {
        expect(FLOW_FIELD_SDF_FEATHER).to.deep.equal({minimum:0.05,maximum:0.35,default:0.25})
        expect(Object.isFrozen(FLOW_FIELD_SDF_FEATHER)).to.equal(true)
        for (const sdfFeatherTexels of [0.05,0.25,0.35,0.123]) {
            expect(flowFieldSdfFeatherTexels(sdfFeatherTexels)).to.equal(sdfFeatherTexels)
            expect(flowFieldPresentation({...FLOW_FIELD_PRESENTATION,sdfFeatherTexels}).sdfFeatherTexels)
                .to.equal(sdfFeatherTexels)
        }
    })

    it('rejects nonnumeric, nonfinite, zero and out-of-range explicit feather widths', () => {
        for (const sdfFeatherTexels of [null,'0.25',NaN,Infinity,-Infinity,0,-0.1,0.049,0.351,{},[]]) {
            expect(() => flowFieldSdfFeatherTexels(sdfFeatherTexels)).to.throw(TypeError)
            expect(() => flowFieldPresentation({...FLOW_FIELD_PRESENTATION,sdfFeatherTexels})).to.throw(TypeError)
        }
    })
})
