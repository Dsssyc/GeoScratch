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

    it('wires a flow-domain mask through velocity, simulation, and history cleanup', () => {

        const layer = read('examples', 'm_demLayer', 'steadyFlowLayer.js')
        const voronoi = read('examples', 'm_demLayer', 'shaders', 'flow', 'flowVoronoi.wgsl')
        const simulation = read('examples', 'm_demLayer', 'shaders', 'flow', 'simulation.compute.wgsl')
        const swap = read('examples', 'm_demLayer', 'shaders', 'flow', 'swap.wgsl')

        expect(layer).to.include('this.useFlowMask = options.useFlowMask ?? true')
        expect(layer).to.include('this.flowMaskCutoff = scr.f32(')
        expect(layer).to.include("this.flowMaskTexture = this.map.screen.createScreenDependentTexture('Texture (Flow Mask)'")
        expect(layer).to.include('colorAttachments: [ { colorResource: this.flowTexture }, { colorResource: this.flowMaskTexture } ]')
        expect(layer).to.include('textures: [ { texture: this.flowTexture, sampleType: \'unfilterable-float\' }, { texture: this.flowMaskTexture } ]')
        expect(layer).to.include('textures: [ { texture: this.layerTexture2 }, { texture: this.flowMaskTexture } ]')

        expect(voronoi).to.include('flowMaskCutoff: f32')
        expect(voronoi).to.include('@location(1) mask: vec4f')
        expect(voronoi).to.include('length(input.velocity) / max(frameUniform.maxSpeed')
        expect(voronoi).to.include('output.velocity = input.velocity * maskValue')

        expect(simulation).to.include('var maskTexture: texture_2d<f32>')
        expect(simulation).to.include('getMask(maskTexture, uv)')
        expect(simulation).to.include('controllerUniform.useFlowMask > 0.5 && maskValid < 0.5')

        expect(swap).to.include('useFlowMask: f32')
        expect(swap).to.include('var maskTexture: texture_2d<f32>')
        expect(swap).to.include('textureLoad(maskTexture, pixel, 0).r')
    })

    it('derives the flow-domain mask from supported Voronoi geometry, not speed alone', () => {

        const layer = read('examples', 'm_demLayer', 'steadyFlowLayer.js')
        const voronoi = read('examples', 'm_demLayer', 'shaders', 'flow', 'flowVoronoi.wgsl')

        expect(layer).to.include('this.flowDomainMaxEdge = options.flowDomainMaxEdge ??')
        expect(layer).to.include('this.triangleVertexIndices = undefined')
        expect(layer).to.include('this.voronoiVertexCount = 0')
        expect(layer).to.include('calculateTriangleDomainSupport(')
        expect(layer).to.include('expandStationVelocities(uvs)')
        expect(layer).to.include('range: () => [ this.voronoiVertexCount ]')
        expect(layer).to.not.include('index: { buffer: this.indexBuffer_voronoi }')
        expect(layer).to.include('structure: [ { components: 1 } ]')

        expect(voronoi).to.include('@location(1) domainSupport: f32')
        expect(voronoi).to.include('@location(3) vTo: vec2f')
        expect(voronoi).to.include('output.domainSupport = input.domainSupport')
        expect(voronoi).to.include('let speedMask = step(frameUniform.flowMaskCutoff, speedRate)')
        expect(voronoi).to.include('let maskValue = speedMask * input.domainSupport')
    })
})
