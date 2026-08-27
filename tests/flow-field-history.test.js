import { expect } from 'chai'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const sourcePath = path.join(root, 'examples', 'flowField', 'flow-history.ts')
const historyPath = path.join(root, 'examples', 'flowField', 'shaders', 'history.wgsl')
const presentationPath = path.join(root, 'examples', 'flowField', 'shaders', 'presentation.wgsl')

function read(file) {

    return fs.readFileSync(file, 'utf8')
}

describe('Flow Field viewport history', () => {

    it('owns exactly two resizeable rgba8unorm history directions', () => {

        const source = read(sourcePath)
        expect(source.match(/format: 'rgba8unorm'/g)).to.have.length(2)
        expect(source).to.include("label: 'Flow Field history A'")
        expect(source).to.include("label: 'Flow Field history B'")
        expect(source).to.include("label: 'Flow Field history B to A'")
        expect(source).to.include("label: 'Flow Field history A to B'")
        expect(source).to.include('GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING')
        expect(source).to.include('Object.freeze([ directionBToA, directionAToB ])')
        expect(source).not.to.match(/flowLayer|Flow Layer|\.\.\/flowLayer/)
    })

    it('keeps off clear and reproject decisions explicit and bounded', () => {

        const source = read(sourcePath)
        expect(source).to.include("export type FlowHistoryMode = 'off' | 'clear' | 'reproject'")
        expect(source).to.include("const mode = options.mode ?? 'reproject'")
        expect(source).to.include("case 'off': return 0")
        expect(source).to.include("case 'clear': return 1")
        expect(source).to.include("case 'reproject': return 2")
        expect(source).to.include("mode === 'clear' && cameraChanged")
        expect(source).to.include("mode === 'reproject' && cameraChanged")
        expect(source).to.include('centerDelta <= maxReprojectCenterDeltaMeters')
        expect(source).to.include('10_018_754.171394622')
        expect(source).to.include('historyValid = false')
    })

    it('reverse gathers camera history without any support texture', () => {

        const shader = read(historyPath)
        expect(shader).to.include('trailDecay: f32')
        expect(shader).to.include('trailCutoff: f32')
        expect(shader).to.include('previousMatrix: mat4x4f')
        expect(shader).to.include('currentInverseMatrix: mat4x4f')
        expect(shader).to.include('fn reprojectHistoryUv')
        expect(shader).to.include('cleanupUniform.currentInverseMatrix * nearClip')
        expect(shader).to.include('cleanupUniform.previousMatrix * previousRelative')
        expect(shader).to.include('let historyPixel = clamp(historyUv * dim')
        expect(shader).to.include('color = linearSampling(historyTexture, historyPixel, dim)')
        expect(shader).to.include('floor(255.0 * color * cleanupUniform.trailDecay) / 255.0')
        expect(shader).to.include('residual <= cleanupUniform.trailCutoff')
        expect(shader).not.to.match(/mask|boundary|depth|wet|sdf/i)
    })

    it('resizes stable resources, reparses bindings, invalidates history, and clears both targets', () => {

        const source = read(sourcePath)
        expect(source).to.include('await historyA.resize(normalized)')
        expect(source).to.include('await historyB.resize(normalized)')
        expect(source).to.include('await prepareStaleBindSets(historyBindSets)')
        expect(source).to.include('resizeGeneration++')
        expect(source).to.include('previousView = undefined')
        expect(source).to.include('clearPending = true')
        expect(source).to.match(/target: historyAView[\s\S]*target: historyBView/)
    })

    it('encodes uniform upload, target composition, content draw, and Surface presentation in order', () => {

        const source = read(sourcePath)
        const upload = source.indexOf('builder.upload(uniformUpload)')
        const compose = source.indexOf('builder.render(direction.pass')
        const present = source.indexOf('builder.render(presentationPass')
        expect(upload).to.be.greaterThan(-1)
        expect(compose).to.be.greaterThan(upload)
        expect(present).to.be.greaterThan(compose)
        expect(source).to.include('[ direction.compose, ...content ]')
        expect(source).to.include("target: surface, load: 'load', store: 'store'")
        expect(source).to.include("import type { GeoViewSnapshot } from 'geoscratch/geo'")
        expect(source).not.to.include('runtime.device')
        expect(source).not.to.include('runtime.queue')

        const presentation = read(presentationPath)
        expect(presentation).to.include('var historyTexture: texture_2d<f32>')
        expect(presentation).to.include('textureLoad(historyTexture')
    })
})
