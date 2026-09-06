import { expect } from 'chai'
import {
    FLOW_FIELD_PRESENTATION,
    flowFieldPresentation,
} from '../examples/flowField/flow-presentation.ts'

describe('Flow Field presentation choices', () => {
    it('defaults to the hard boundary and normalizes older input objects', () => {
        const input = {view:'particles',sample:'interpolated',trails:true,contour:false}
        const normalized = flowFieldPresentation(input)
        expect(normalized).to.deep.equal({...input,boundary:'hard'})
        expect(FLOW_FIELD_PRESENTATION).to.deep.equal(normalized)
        expect(Object.isFrozen(normalized)).to.equal(true)
        expect(input).to.not.have.property('boundary')
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
})
