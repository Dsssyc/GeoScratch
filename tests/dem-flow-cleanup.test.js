import { expect } from 'chai'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8')

describe('DEM flow layer cleanup', () => {

    it('makes trail history decay and cutoff configurable in the swap shader', () => {

        const shader = read('examples', 'm_demLayer', 'shaders', 'flow', 'swap.wgsl')

        expect(shader).to.include('struct CleanupUniformBlock')
        expect(shader).to.include('trailDecay: f32')
        expect(shader).to.include('trailCutoff: f32')
        expect(shader).to.include('var<uniform> cleanupUniform')
        expect(shader).to.include('color * cleanupUniform.trailDecay')
        expect(shader).to.include('cleanupUniform.trailCutoff')
        expect(shader).to.not.include('color * 0.996')
    })

    it('wires cleanup controls and camera invalidation from the flow layer', () => {

        const layer = read('examples', 'm_demLayer', 'steadyFlowLayer.js')

        expect(layer).to.include('constructor(options = {})')
        expect(layer).to.include('this.trailDecay = scr.f32(')
        expect(layer).to.include('this.trailCutoff = scr.f32(')
        expect(layer).to.include('name: \'cleanupUniform\'')
        expect(layer).to.include('trailDecay: this.trailDecay')
        expect(layer).to.include('trailCutoff: this.trailCutoff')
        expect(layer).to.include('registerCameraInvalidation()')
        expect(layer).to.include('clearOnMove')
        expect(layer).to.include('this.showVoronoi = options.showVoronoi ?? true')
    })
})
