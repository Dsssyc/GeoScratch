import { expect } from 'chai'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8')
const exists = (...parts) => fs.existsSync(path.join(root, ...parts))
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

        const layer = read('examples', 'm_demLayer', 'steadyFlowLayer.js')

        expect(layer).to.include("this.historyMode = options.historyMode ?? (options.clearOnMove === false ? 'off' : 'reproject')")
        expect(layer).to.include("this.historyModeValue = scr.f32(historyModeToValue(this.historyMode))")
        expect(layer).to.include('this.historyValid = scr.f32(0)')
        expect(layer).to.include('this.historyReprojecting = scr.f32(0)')
        expect(layer).to.include('this.previousHistoryMatrix = scr.mat4f()')
        expect(layer).to.include('this.currentHistoryInverseMatrix = scr.mat4f()')
        expect(layer).to.include('this.previousHistoryCenterHigh = scr.vec3f()')
        expect(layer).to.include('this.currentHistoryCenterLow = scr.vec3f()')
        expect(layer).to.include('this.previousHistoryViewport = scr.vec2f()')
        expect(layer).to.include('this.currentHistoryViewport = scr.vec2f()')
        expect(layer).to.include('updateHistoryCameraState()')
        expect(layer).to.include('historyModeToValue(mode)')
    })

    it('keeps reproject movement from clearing history or resetting particles', () => {

        const layer = read('examples', 'm_demLayer', 'steadyFlowLayer.js')
        const idle = methodBody(layer, 'idle')
        const restart = methodBody(layer, 'restart')

        expect(idle).to.include("if (this.historyMode !== 'clear')")
        expect(idle).to.include("if (this.historyMode === 'reproject') this.historyReprojecting.n = 1")
        expect(idle).to.match(/if \(this\.historyMode !== 'clear'\)[\s\S]*return[\s\S]*this\.swapPasses\[0\]\.executable = true/)

        expect(restart).to.include("if (this.historyMode !== 'clear')")
        expect(restart).to.include('this.historyReprojecting.n = 0')
        expect(restart).to.match(/if \(this\.historyMode !== 'clear'\)[\s\S]*return[\s\S]*this\.particleRef\.value = this\.randomFillData/)
    })

    it('exposes history reprojection uniforms to the swap pass', () => {

        const layer = read('examples', 'm_demLayer', 'steadyFlowLayer.js')

        expect(layer).to.include('historyMode: this.historyModeValue')
        expect(layer).to.include('historyValid: this.historyValid')
        expect(layer).to.include('historyReprojecting: this.historyReprojecting')
        expect(layer).to.include('previousMatrix: this.previousHistoryMatrix')
        expect(layer).to.include('currentInverseMatrix: this.currentHistoryInverseMatrix')
        expect(layer).to.include('previousCenterHigh: this.previousHistoryCenterHigh')
        expect(layer).to.include('currentCenterLow: this.currentHistoryCenterLow')
        expect(layer).to.include('previousViewport: this.previousHistoryViewport')
        expect(layer).to.include('currentViewport: this.currentHistoryViewport')
    })

    it('reprojects retained trail history by reverse gathering in the swap shader', () => {

        const swap = read('examples', 'm_demLayer', 'shaders', 'flow', 'swap.wgsl')

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

        const swap = read('examples', 'm_demLayer', 'shaders', 'flow', 'swap.wgsl')

        expect(swap).to.include('var color = textureLoad(bgTexture, pixel, 0)')
        expect(swap).to.match(/if \(cleanupUniform\.historyMode > 1\.5 && cleanupUniform\.historyReprojecting > 0\.5\)[\s\S]*color = linearSampling\(bgTexture, historyPixel, dim\)/)
        expect(swap).to.not.include('let color = linearSampling(bgTexture, historyPixel, dim)')
    })
})
