import { expect } from 'chai'
import * as scr from '../src/index.js'
import * as scratchCompat from '../src/scratch.js'
import * as pkg from 'geoscratch'
import * as pkgScratchCompat from 'geoscratch/scratch'

describe('public entrypoints', () => {

    it('exports the standard library entrypoint', () => {

        expect(scr).to.have.property('StartDash').that.is.a('function')
        expect(scr).to.have.property('renderPass').that.is.a('function')
        expect(scr).to.have.property('binding').that.is.a('function')
    })

    it('keeps the scratch compatibility entrypoint', () => {

        expect(scratchCompat).to.have.property('StartDash').that.equals(scr.StartDash)
        expect(scratchCompat).to.have.property('renderPass').that.equals(scr.renderPass)
    })

    it('exposes package-level entrypoints', () => {

        expect(pkg).to.have.property('StartDash').that.equals(scr.StartDash)
        expect(pkgScratchCompat).to.have.property('renderPass').that.equals(scr.renderPass)
    })
})
