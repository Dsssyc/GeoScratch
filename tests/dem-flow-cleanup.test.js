import { expect } from 'chai'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8')
const methodBody = (source, name) => {

    const start = source.indexOf(`${name}() {`)
    if (start === -1) return ''

    const bodyStart = source.indexOf('{', start)
    let depth = 0
    for (let i = bodyStart; i < source.length; i++) {

        if (source[i] === '{') depth++
        if (source[i] === '}') depth--
        if (depth === 0) return source.slice(bodyStart + 1, i).replace(/\/\/.*$/gm, '')
    }

    return ''
}

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
        expect(voronoi).to.include('@location(1) mask: f32')
        expect(voronoi).to.include('length(input.velocity) / max(frameUniform.maxSpeed')
        expect(voronoi).to.include('output.velocity = input.velocity * maskValue')

        expect(simulation).to.include('var maskTexture: texture_2d<f32>')
        expect(simulation).to.include('getMask(maskTexture, uv)')
        expect(simulation).to.include('controllerUniform.useFlowMask > 0.5 && maskValid < 0.5')

        expect(swap).to.include('useFlowMask: f32')
        expect(swap).to.include('var maskTexture: texture_2d<f32>')
        expect(swap).to.include('textureLoad(maskTexture, pixel, 0).r')
    })

    it('stores the flow-domain mask as a single-channel render target', () => {

        const layer = read('examples', 'm_demLayer', 'steadyFlowLayer.js')
        const voronoi = read('examples', 'm_demLayer', 'shaders', 'flow', 'flowVoronoi.wgsl')

        expect(layer).to.include("this.flowMaskTexture = this.map.screen.createScreenDependentTexture('Texture (Flow Mask)', 'r8unorm')")
        expect(voronoi).to.include('@location(1) mask: f32')
        expect(voronoi).to.include('output.mask = maskValue')
        expect(voronoi).to.not.include('@location(1) mask: vec4f')
        expect(voronoi).to.not.include('output.mask = vec4f(maskValue')
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

    it('cleans up flow camera listeners and worker resources when removed', () => {

        const layer = read('examples', 'm_demLayer', 'steadyFlowLayer.js')

        expect(layer).to.include('this.cameraInvalidationHandlers = []')
        expect(layer).to.include('onRemove()')
        expect(layer).to.include('this.unregisterCameraInvalidation()')
        expect(layer).to.match(/onRemove\(\) \{[\s\S]*this\.makeVisibility\(false\)/)
        expect(layer).to.include('this.loadWorker.terminate()')
        expect(layer).to.include('this.cameraInvalidationHandlers.push({ eventName, handler: clearHistory })')
        expect(layer).to.include('this.map.off(eventName, handler)')
        expect(layer).to.match(/onRemove\(\) \{[\s\S]*this\.map = undefined/)
    })

    it('pauses simulation and trail accumulation while camera movement clears history', () => {

        const layer = read('examples', 'm_demLayer', 'steadyFlowLayer.js')
        const idle = methodBody(layer, 'idle')
        const restart = methodBody(layer, 'restart')

        expect(idle).to.include('this.isIdling = true')
        expect(idle).to.include('this.swapPasses[0].executable = true')
        expect(idle).to.include('this.swapPasses[1].executable = false')
        expect(idle).to.include('this.swapPasses[2].executable = false')
        expect(idle).to.include('this.layerBindings[0].executable = false')
        expect(idle).to.include('this.layerBindings[1].executable = false')
        expect(idle).to.include('this.simulationPass.executable = false')

        expect(restart).to.include('this.isIdling = false')
        expect(restart).to.include('this.swapPasses[0].executable = false')
        expect(restart).to.include('this.simulationPass.executable = true')
        expect(restart).to.include('this.particleRef.value = this.randomFillData')
    })
})
