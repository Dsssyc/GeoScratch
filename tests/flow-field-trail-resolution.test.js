import { expect } from 'chai'
import { flowTrailTextureSize } from '../examples/flowField/flow-trail-resolution.ts'

describe('Flow Field trail pixel budget', () => {
    it('keeps a native Surface while reducing high-DPR trail dimensions', () => {
        const surface = Object.freeze({width:3520,height:1760})
        const reference = Object.freeze([1760,880])
        expect(flowTrailTextureSize(surface,reference,'balanced')).to.deep.equal({width:1760,height:880})
        expect(flowTrailTextureSize(surface,reference,'native')).to.deep.equal(surface)
        expect(surface).to.deep.equal({width:3520,height:1760})
        expect(reference).to.deep.equal([1760,880])
    })

    it('bounds 4K and ultrawide allocations without changing aspect or upscaling', () => {
        for (const [width,height] of [[3840,2160],[7680,2160],[1920,1080],[640,480],[1,1]]) {
            const size = flowTrailTextureSize({width,height},[width,height],'balanced')
            expect(size.width*size.height).to.be.at.most(1920*1080)
            expect(size.width).to.be.at.most(width)
            expect(size.height).to.be.at.most(height)
            expect(Math.abs(size.width/width-size.height/height)).to.be.at.most(1/width+1/height)
            expect(Object.isFrozen(size)).to.equal(true)
        }
        expect(flowTrailTextureSize({width:800,height:600},[1600,1200],'balanced'))
            .to.deep.equal({width:800,height:600})
    })

    it('accepts fractional reference sizes and rejects invalid dimensions and choices', () => {
        expect(flowTrailTextureSize({width:2001,height:1001},[1000.5,500.5],'balanced'))
            .to.deep.equal({width:1000,height:500})
        for (const bad of [0,-1,NaN,Infinity]) {
            expect(() => flowTrailTextureSize({width:bad,height:10},[10,10],'balanced')).to.throw(TypeError)
            expect(() => flowTrailTextureSize({width:10,height:10},[bad,10],'balanced')).to.throw(TypeError)
        }
        expect(() => flowTrailTextureSize({width:10,height:10},[10,10],'bad')).to.throw(TypeError)
    })
})
