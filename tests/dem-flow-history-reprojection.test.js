import { expect } from 'chai'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8')
const exists = (...parts) => fs.existsSync(path.join(root, ...parts))
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

describe('DEM flow history reprojection', () => {

    it('records the history reprojection decision as a new ADR', () => {

        expect(exists('docs', 'decisions', 'ADR-002-dem-flow-history-reprojection.md')).to.equal(true)

        const adr = read('docs', 'decisions', 'ADR-002-dem-flow-history-reprojection.md')

        expect(adr).to.include('# ADR-002: Reproject DEM Flow History During Camera Movement')
        expect(adr).to.include('screen-space reverse reprojection')
        expect(adr).to.include('Do not introduce a world-space or vector trail buffer')
        expect(adr).to.include('historyMode')
        expect(adr).to.include('reverse gather')
        expect(adr).to.include('Mercator `z=0` plane')
    })

    it('keeps ADR-001 history while superseding its camera movement decision', () => {

        const adr = read('docs', 'decisions', 'ADR-001-dem-flow-layer-artifact-cleanup.md')

        expect(adr).to.include('Mask cleanup remains accepted.')
        expect(adr).to.include('Camera movement handling is superseded by ADR-002.')
    })

    it('adds history mode options and camera state for reprojection', () => {

        const layer = read('examples', 'flowLayer', 'flow-layer.ts')

        expect(layer).to.include("const historyMode = options.historyMode ?? (options.clearOnMove === false ? 'off' : 'reproject')")
        expect(layer).to.include('historyMode: historyModeValue(settings.historyMode)')
        expect(layer).to.include('historyValid: 0')
        expect(layer).to.include('historyReprojecting: 0')
        expect(layer).to.include('previousMatrix: identity')
        expect(layer).to.include('currentInverseMatrix: identity')
        expect(layer).to.include('previousCenterHigh: [ 0, 0, 0 ]')
        expect(layer).to.include('currentCenterLow: [ 0, 0, 0 ]')
        expect(layer).to.include('previousViewport: [ size.width, size.height ]')
        expect(layer).to.include('currentViewport: [ size.width, size.height ]')
        expect(layer).to.include('updateCameraHistory(graph, state, camera)')
        expect(layer).to.include('function historyModeValue(mode: FlowHistoryMode): number')
    })

    it('keeps reproject movement from clearing history or resetting particles', () => {

        const layer = read('examples', 'flowLayer', 'flow-layer.ts')
        const moving = methodBody(layer, 'setCameraMoving')
        const settled = methodBody(layer, 'setCameraSettled')

        expect(moving).to.include("if (settings.historyMode === 'clear') state.historyClearPending = true")
        expect(settled).to.include("if (settings.historyMode === 'clear') state.particleResetPending = true")
        expect(moving).to.not.include("settings.historyMode === 'reproject'")
        expect(settled).to.not.include("settings.historyMode === 'reproject'")
        expect(moving).to.not.include('particleResetPending')
        expect(settled).to.not.include('historyClearPending')
    })

    it('exposes history reprojection uniforms to the swap pass', () => {

        const layer = read('examples', 'flowLayer', 'flow-layer.ts')

        expect(layer).to.include('historyMode: historyModeValue(graph.settings.historyMode)')
        expect(layer).to.include('historyValid: state.historyValid')
        expect(layer).to.include("historyReprojecting: state.cameraMoving && graph.settings.historyMode === 'reproject' ? 1 : 0")
        expect(layer).to.include('previousMatrix: state.historyUniformValues!.previousMatrix')
        expect(layer).to.include('currentInverseMatrix: state.currentInverseMatrix')
        expect(layer).to.include('previousCenterHigh: state.historyUniformValues!.previousCenterHigh')
        expect(layer).to.include('currentCenterLow: state.currentCenterLow')
        expect(layer).to.include('previousViewport: state.historyUniformValues!.previousViewport')
        expect(layer).to.include('currentViewport: state.currentViewport')
    })

    it('reprojects retained trail history by reverse gathering in the swap shader', () => {

        const swap = read('examples', 'flowLayer', 'shaders', 'flow', 'swap.wgsl')

        expect(swap).to.include('historyMode: f32')
        expect(swap).to.include('historyValid: f32')
        expect(swap).to.include('historyReprojecting: f32')
        expect(swap).to.include('previousMatrix: mat4x4f')
        expect(swap).to.include('currentInverseMatrix: mat4x4f')
        expect(swap).to.include('previousCenterHigh: vec3f')
        expect(swap).to.include('currentCenterLow: vec3f')
        expect(swap).to.include('fn reprojectHistoryUv')
        expect(swap).to.include('let nearClip = vec4f(ndc, 0.0, 1.0)')
        expect(swap).to.include('let farClip = vec4f(ndc, 1.0, 1.0)')
        expect(swap).to.include('let planeT = -nearWorld.z / ray.z')
        expect(swap).to.include('let previousClip = cleanupUniform.previousMatrix * previousRelative')
        expect(swap).to.include('abs(previousClip.x) > previousClip.w')
        expect(swap).to.include('previousClip.z < 0.0 || previousClip.z > previousClip.w')
        expect(swap).to.include('cleanupUniform.historyMode > 1.5 && cleanupUniform.historyReprojecting > 0.5')
        expect(swap).to.include('cleanupUniform.historyValid < 0.5')
        expect(swap).to.include('let historyPixel = clamp(historyUv * dim, vec2f(0.0), dim - vec2f(1.0))')
        expect(swap).to.include('linearSampling(bgTexture, historyPixel, dim)')
        expect(swap).to.include('textureLoad(maskTexture, pixel, 0).r')
    })

    it('keeps static trail feedback pixel-exact and filters only during reprojection', () => {

        const swap = read('examples', 'flowLayer', 'shaders', 'flow', 'swap.wgsl')

        expect(swap).to.include('var color = textureLoad(bgTexture, pixel, 0)')
        expect(swap).to.match(/if \(cleanupUniform\.historyMode > 1\.5 && cleanupUniform\.historyReprojecting > 0\.5\)[\s\S]*color = linearSampling\(bgTexture, historyPixel, dim\)/)
        expect(swap).to.not.include('let color = linearSampling(bgTexture, historyPixel, dim)')
    })
})
