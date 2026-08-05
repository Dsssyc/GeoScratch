import { expect } from 'chai'
import * as root from 'geoscratch'
import * as geo from 'geoscratch/geo'
import * as scratch from 'geoscratch/scratch'

describe('public entrypoints', () => {

    it('exports Scratch and Geo as the only root concepts', () => {

        expect(Object.keys(root).sort()).to.deep.equal([ 'geo', 'scratch' ])
        expect(root.scratch.GPURuntime).to.equal(scratch.GPURuntime)
        expect(root.scratch.WorkerSystem).to.equal(scratch.WorkerSystem)
        expect(root.scratch.plane).to.equal(scratch.plane)
        expect(root.geo.WebMercatorQuad).to.equal(geo.WebMercatorQuad)
    })

    it('keeps the formal Scratch and Geo subpaths independent', () => {

        expect(scratch).to.have.property('GPURuntime').that.is.a('function')
        expect(scratch).to.have.property('WorkerSystem').that.is.a('function')
        expect(scratch).to.have.property('plane').that.is.a('function')
        expect(geo).to.have.property('WebMercatorQuad')
        expect(scratch).not.to.have.property('WebMercatorQuad')
        expect(geo).not.to.have.property('GPURuntime')
    })
})
