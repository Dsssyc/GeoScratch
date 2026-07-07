import { expect } from 'chai'
import * as scr from '../packages/geoscratch/src/index.js'
import * as scratchCompat from '../packages/geoscratch/src/scratch.js'
import * as pkg from 'geoscratch'
import * as pkgScratchCompat from 'geoscratch/scratch'

describe('public entrypoints', () => {

    it('exports the standard library entrypoint', () => {

        expect(scr).to.have.property('StartDash').that.is.a('function')
        expect(scr).to.have.property('renderPass').that.is.a('function')
        expect(scr).to.have.property('binding').that.is.a('function')
        expect(scr).to.have.property('Program').that.is.a('function')
        expect(scr).to.have.property('ScratchRenderPipeline').that.is.a('function')
        expect(scr).to.have.property('DrawCommand').that.is.a('function')
        expect(scr).to.have.property('RenderPassSpec').that.is.a('function')
        expect(scr).to.have.property('SubmissionBuilder').that.is.a('function')
        expect(scr).to.have.property('SubmittedWork').that.is.a('function')
    })

    it('keeps the scratch compatibility entrypoint', () => {

        expect(scratchCompat).to.have.property('StartDash').that.equals(scr.StartDash)
        expect(scratchCompat).to.have.property('renderPass').that.equals(scr.renderPass)
        expect(scratchCompat).to.have.property('Program').that.equals(scr.Program)
        expect(scratchCompat).to.have.property('DrawCommand').that.equals(scr.DrawCommand)
        expect(scratchCompat).to.have.property('RenderPassSpec').that.equals(scr.RenderPassSpec)
        expect(scratchCompat).to.have.property('SubmissionBuilder').that.equals(scr.SubmissionBuilder)
    })

    it('exposes package-level entrypoints', () => {

        expect(pkg).to.have.property('StartDash').that.equals(scr.StartDash)
        expect(pkgScratchCompat).to.have.property('renderPass').that.equals(scr.renderPass)
        expect(pkg).to.have.property('Program').that.equals(scr.Program)
        expect(pkg).to.have.property('ScratchRenderPipeline').that.equals(scr.ScratchRenderPipeline)
        expect(pkgScratchCompat).to.have.property('SubmittedWork').that.equals(scr.SubmittedWork)
    })
})
