import { expect } from 'chai'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8')
const stripLineComments = (source) => source.replace(/\/\/.*$/gm, '')
const methodBody = (source, name) => {

    const functionStart = source.indexOf(`function ${name}(`)
    const methodStart = source.indexOf(`${name}() {`)
    const start = functionStart === -1 ? methodStart : functionStart
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

        const shader = read('examples', 'flowLayer', 'shaders', 'flow', 'swap.wgsl')

        expect(shader).to.include('struct CleanupUniformBlock')
        expect(shader).to.include('trailDecay: f32')
        expect(shader).to.include('trailCutoff: f32')
        expect(shader).to.include('var<uniform> cleanupUniform')
        expect(shader).to.include('color * cleanupUniform.trailDecay')
        expect(shader).to.include('cleanupUniform.trailCutoff')
        expect(shader).to.not.include('color * 0.996')
    })

    it('wires cleanup controls and camera invalidation from the flow layer', () => {

        const layer = read('examples', 'flowLayer', 'flow-layer.ts')
        const main = read('examples', 'flowLayer', 'main.ts')

        expect(layer).to.include('function normalizeOptions(options: FlowLayerOptions): FlowSettings')
        expect(layer).to.include('trailDecay: options.trailDecay ?? 0.996')
        expect(layer).to.include('trailCutoff: options.trailCutoff ?? 1 / 255')
        expect(layer).to.include('flowMaskCutoff: options.flowMaskCutoff ?? 0')
        expect(layer).to.not.include('flowMaskCutoff: options.flowMaskCutoff ?? 0.02')
        expect(layer).to.include("cleanup: uniform('FlowCleanupUniform'")
        expect(layer).to.include('trailDecay: settings.trailDecay')
        expect(layer).to.include('trailCutoff: settings.trailCutoff')
        expect(main).to.include('registerCameraListeners(map, graph, lifetime)')
        expect(layer).to.include('clearOnMove')
        expect(layer).to.include('showVoronoi: options.showVoronoi ?? false')
    })

    it('wires a flow-domain mask through velocity, simulation, and history cleanup', () => {

        const layer = read('examples', 'flowLayer', 'flow-layer.ts')
        const voronoi = read('examples', 'flowLayer', 'shaders', 'flow', 'flowVoronoi.wgsl')
        const simulation = read('examples', 'flowLayer', 'shaders', 'flow', 'simulation.compute.wgsl')
        const swap = read('examples', 'flowLayer', 'shaders', 'flow', 'swap.wgsl')

        expect(layer).to.include('useFlowMask: options.useFlowMask ?? true')
        expect(layer).to.include('flowMaskCutoff: options.flowMaskCutoff ?? 0')
        expect(layer).to.include("label: 'Flow domain mask'")
        expect(layer).to.include('targets: [ { format: textures.flow.format }, { format: textures.mask.format } ]')
        expect(layer).to.include('fromTexture: textures.views.flow')
        expect(layer).to.include('maskTexture: textures.views.mask')
        expect(layer).to.include('bgTexture: textures.views.historyB')

        expect(voronoi).to.include('flowMaskCutoff: f32')
        expect(voronoi).to.include('@location(1) mask: f32')
        expect(voronoi).to.include('length(input.velocity) / max(frameUniform.maxSpeed')
        expect(voronoi).to.include('output.velocity = input.velocity * speedMask * fieldSupport')

        expect(simulation).to.include('var maskTexture: texture_2d<f32>')
        expect(simulation).to.include('getMask(maskTexture, uv)')
        expect(simulation).to.include('controllerUniform.useFlowMask > 0.5 && maskValid < 0.5')

        expect(swap).to.include('useFlowMask: f32')
        expect(swap).to.include('var maskTexture: texture_2d<f32>')
        expect(swap).to.include('textureLoad(maskTexture, pixel, 0).r')
    })

    it('stores the flow-domain mask as a single-channel render target', () => {

        const layer = read('examples', 'flowLayer', 'flow-layer.ts')
        const voronoi = read('examples', 'flowLayer', 'shaders', 'flow', 'flowVoronoi.wgsl')

        expect(layer).to.match(/label: 'Flow domain mask',[\s\S]*?format: 'r8unorm'/)
        expect(voronoi).to.include('@location(1) mask: f32')
        expect(voronoi).to.include('output.mask = fieldSupport')
        expect(voronoi).to.not.include('@location(1) mask: vec4f')
        expect(voronoi).to.not.include('output.mask = vec4f(maskValue')
    })

    it('guards simulation drop-rate scaling against a zero max speed', () => {

        const simulation = read('examples', 'flowLayer', 'shaders', 'flow', 'simulation.compute.wgsl')

        expect(simulation).to.include('length(velocity) / max(frameUniform.maxSpeed, 0.000001)')
        expect(simulation).to.not.include('length(velocity) / frameUniform.maxSpeed')
    })

    it('guards flow visualization speed scaling against a zero max speed', () => {

        const shaderNames = [
            'flowVoronoi.wgsl',
            'simulation.compute.wgsl',
            'particles.wgsl',
            'flowShow.wgsl',
            'arrow.wgsl',
        ]

        for (const shaderName of shaderNames) {

            const shader = stripLineComments(read('examples', 'flowLayer', 'shaders', 'flow', shaderName))

            expect(shader, shaderName).to.not.match(/\/\s*frameUniform\.maxSpeed/)
        }

        expect(read('examples', 'flowLayer', 'shaders', 'flow', 'particles.wgsl')).to.include('length(velocity) / max(frameUniform.maxSpeed, 0.000001)')
        expect(read('examples', 'flowLayer', 'shaders', 'flow', 'flowShow.wgsl')).to.include('length(velocity) / max(frameUniform.maxSpeed, 0.000001)')
        expect(read('examples', 'flowLayer', 'shaders', 'flow', 'arrow.wgsl')).to.include('length(velocity) / max(frameUniform.maxSpeed, 0.000001)')
    })

    it('clamps flow velocity palette indices to the ramp bounds', () => {

        const shaderNames = [
            'particles.wgsl',
            'flowShow.wgsl',
            'arrow.wgsl',
        ]

        for (const shaderName of shaderNames) {

            const shader = stripLineComments(read('examples', 'flowLayer', 'shaders', 'flow', shaderName))

            expect(shader, shaderName).to.include('let palettePosition = clamp(speed * 8.0, 0.0, 7.0)')
            expect(shader, shaderName).to.include('let bottomIndex = u32(floor(palettePosition))')
            expect(shader, shaderName).to.include('let topIndex = min(bottomIndex + 1u, 7u)')
            expect(shader, shaderName).to.include('rampColors[bottomIndex]')
            expect(shader, shaderName).to.include('rampColors[topIndex]')
            expect(shader, shaderName).to.not.include('ceil(speed * 8.0)')
        }
    })

    it('derives the flow-domain mask from supported geometry and the business display extent', () => {

        const layer = read('examples', 'flowLayer', 'flow-layer.ts')
        const voronoi = read('examples', 'flowLayer', 'shaders', 'flow', 'flowVoronoi.wgsl')

        expect(layer).to.include('flowDomainMaxEdge: options.flowDomainMaxEdge ??')
        expect(layer).to.include('stationIndices.push(id)')
        expect(layer).to.include('vertexCount: stationIndices.length')
        expect(layer).to.include('calculateTriangleDomainSupport(')
        expect(layer).to.include('expandStationVelocities(geometry, first.uvs)')
        expect(layer).to.include('count: { vertexCount }')
        expect(layer).to.not.include('indexBuffer:')
        expect(layer).to.include("vertexLayout(4, 1, 'float32')")

        expect(voronoi).to.include('@location(1) domainSupport: f32')
        expect(voronoi).to.include('@location(3) vTo: vec2f')
        expect(voronoi).to.include('output.domainSupport = input.domainSupport')
        expect(voronoi).to.include('let speedMask = step(frameUniform.flowMaskCutoff, speedRate)')
        expect(voronoi).to.include('let displaySupport = select(0.0, 1.0,')
        expect(voronoi).to.include('let fieldSupport = input.domainSupport * displaySupport')
        expect(voronoi).to.include('output.velocity = input.velocity * speedMask * fieldSupport')
        expect(voronoi).to.include('output.mask = fieldSupport')
        expect(voronoi).to.not.include('output.mask = speedMask * fieldSupport')
    })

    it('cleans up flow camera listeners and worker resources when removed', () => {

        const main = read('examples', 'flowLayer', 'main.ts')
        const lifecycle = read('examples', 'flowLayer', 'flow-lifecycle.ts')

        expect(main).to.include('lifetime.deferStop({')
        expect(main).to.include("label: 'flow-camera-listeners'")
        expect(main).to.include('map.off(eventName, moving)')
        expect(main).to.include('worker.removeEventListener(\'message\', handleMessage)')
        expect(lifecycle).to.include("recordAction('release', 'flow-worker', () => worker!.terminate())")
        expect(lifecycle).to.include("recordAction('release', 'maplibre-map', () => map!.remove())")
        expect(lifecycle).to.include("recordAction('release', 'scratch-runtime', () => runtime!.dispose())")
        expect(lifecycle.indexOf("'flow-worker'")).to.be.lessThan(lifecycle.indexOf("'maplibre-map'"))
        expect(lifecycle.indexOf("'maplibre-map'")).to.be.lessThan(lifecycle.indexOf("'scratch-runtime'"))
    })

    it('keeps current flow rendering active while camera movement clears history', () => {

        const layer = read('examples', 'flowLayer', 'flow-layer.ts')
        const moving = methodBody(layer, 'setCameraMoving')
        const settled = methodBody(layer, 'setCameraSettled')
        const render = methodBody(layer, 'renderFrame')

        expect(moving).to.include("if (settings.historyMode === 'clear') state.historyClearPending = true")
        expect(settled).to.include("if (settings.historyMode === 'clear') state.particleResetPending = true")
        expect(render).to.include('builder.render(graph.passes.voronoi, [ graph.commands.voronoi ])')
        expect(render).to.include('builder.compute(graph.passes.simulation, [ graph.commands.simulation ])')
        expect(render).to.include('builder.render(direction.pass, direction.commands as DrawCommand[])')
        expect(render).to.include('builder.render(graph.passes.presentation, [ direction.presentation ])')
        expect(render).to.not.include('.executable')
    })
})
