import { expect } from 'chai'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const sourcePath = path.join(root, 'examples', 'flowField', 'flow-history.ts')
const historyPath = path.join(root, 'examples', 'flowField', 'shaders', 'history.wgsl')
const presentationPath = path.join(root, 'examples', 'flowField', 'shaders', 'presentation.wgsl')
const hardBoundaryPath = path.join(root, 'examples', 'flowField', 'shaders', 'hard-boundary.wgsl')
const presentationSupportPath = path.join(root, 'examples', 'flowField', 'shaders', 'presentation-support.wgsl')

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

    it('reverse gathers and finitely decays raw history without temporal destruction', () => {

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
        expect(shader).not.to.include('FlowHistory_coverage(')
        expect(shader).not.to.include('FlowPresentation_coverage(')
        expect(shader).not.to.include('FlowVelocity_sample(')
        expect(shader).not.to.match(/@group\(1\)/)
        const support = read(path.join(root, 'examples/flowField/shaders/history-support.wgsl'))
        expect(support).to.include('FlowScreen_ground_position(')
        expect(support).to.include('FlowPresentation_coverage(')
        expect(shader).to.include('historyUv * dim - vec2f(0.5)')
        expect(shader).not.to.include('let nearWorld')
    })

    it('shares A/B presentation support without changing the actual particle sampler', () => {

        const support = read(presentationSupportPath)
        const sdf = read(path.join(root, 'examples/flowField/shaders/boundary-sdf.wgsl'))
        const velocity = read(path.join(root, 'examples/flowField/shaders/temporal-velocity.wgsl'))
        expect(support).to.include('fn FlowPresentation_stationary_coverage(')
        expect(support).to.include('fn FlowPresentation_coverage(')
        expect(support).to.include('FlowVelocityRegistration_position(position, level)')
        expect(support).to.include('return mix(support.x, support.y, progress)')
        expect(support).to.include('FlowVelocity_nearest_zero_gate')
        expect(support).to.include('FlowVelocityCurrent_load_global(')
        expect(support).to.include('FlowVelocityNext_load_global(')
        expect(support).to.include('FlowVelocity_sample(')
        expect(sdf).to.include('FlowPresentation_stationary_coverage(')
        expect(sdf).to.include('FlowPresentation_coverage(')
        expect(velocity).not.to.include('FlowPresentation_')
        expect(velocity).to.include('let velocity = mix(current_velocity, next_velocity, temporal.progress)')
        expect(velocity).to.include('let advectable = speed > 0.0 && speed >= temporal.activityKill')
        const source = read(sourcePath)
        expect(source).to.include("import presentationSupportShader from './shaders/presentation-support.wgsl?raw'")
        expect(source.match(/\{ code: presentationSupportShader \}/g)).to.have.length(2)
    })

    it('clips current hard visibility only in the final pass and skips empty ink sampling', () => {
        const hard = read(hardBoundaryPath)
        expect(hard).to.include('var<uniform> cleanupUniform: FlowFieldHistoryUniform')
        expect(hard).to.include('@group(2) @binding(0) var historyTexture: texture_2d<f32>')
        const load = hard.indexOf('textureLoad(historyTexture')
        const empty = hard.indexOf('color.a == 0.0')
        const gate = hard.indexOf('FlowHistory_coverage(input.texcoords)')
        expect(load).to.be.greaterThan(-1)
        expect(empty).to.be.greaterThan(load)
        expect(gate).to.be.greaterThan(empty)
        expect(hard).to.include('color.a * FlowHistory_coverage(input.texcoords)')
        expect(hard).not.to.include('trailDecay')
        expect(hard).not.to.match(/textureStore|storage.*read_write/)
        const source = read(sourcePath)
        expect(source).to.include('sourceParts: [ { code: historyShader } ]')
        expect(source).to.include('bindLayouts: [ uniformLayout, historyLayout ]')
        expect(source).to.include('const compose = accumulate ? historyCommands[directionIndex]! : undefined')
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
        const clip = source.indexOf('builder.render(visiblePasses[retainedTextureIndex]!')
        const present = source.indexOf('builder.render(presentationPass')
        expect(upload).to.be.greaterThan(-1)
        expect(compose).to.be.greaterThan(upload)
        expect(clip).to.be.greaterThan(compose)
        expect(present).to.be.greaterThan(clip)
        expect(source).to.include('retainedTextureIndex = presentation === undefined ? rawIndex : 1 - rawIndex')
        expect(source).to.include('retainedTextureIndex === 0 ? presentA : presentB')
        expect(source).to.include('[ compose, ...content ]')
        expect(source).to.match(/target: surface,\s+load: 'clear'/)
        expect(source).to.include('clear: [ 0, 0, 0, 0 ]')
        expect(source).to.include("import type { GeoViewSnapshot, WebMercatorQuadAddressCodec } from 'geoscratch/geo'")
        expect(source).not.to.include('runtime.device')
        expect(source).not.to.include('runtime.queue')

        const presentation = read(presentationPath)
        expect(presentation).to.include('var historyTexture: texture_2d<f32>')
        expect(presentation).to.include('textureLoad(historyTexture')
    })

    it('retains only the last clipped image without feedback, direction advance or reference-camera drift', () => {

        const source = read(sourcePath)
        const retained = source.slice(source.indexOf('function presentRetained('),
            source.indexOf('return Object.freeze({ resize, reset, encode, presentRetained'))
        expect(retained).to.include('for (const command of presentationPair?.commands ?? []) command.dispose()')
        expect(retained).to.include('presentationPair = undefined')
        expect(retained).to.include('trailDecay: 1')
        expect(retained).to.include('prepared: undefined')
        expect(retained).to.include('retainedTextureIndex === undefined || clearPending')
        expect(retained).to.include('retainedCommands[retainedTextureIndex]')
        expect(retained.match(/builder\.render\(/g)).to.have.length(1)
        expect(retained).to.include('builder.render(presentationPass, display === undefined ? [] : [display])')
        expect(retained).not.to.match(/(?:directionIndex|previousView|retainedTextureIndex)\s*=(?!=)/)
        expect(retained).not.to.include('preparePresentationPair(')
        for (const [begin, end] of [
            ['async function resize(', 'function encode('],
            ['function reset()', 'function presentRetained('],
            ['function dispose()', 'function assertActive()'],
        ]) {
            const lifecycle = source.slice(source.indexOf(begin), source.indexOf(end))
            expect(lifecycle).to.include('previousView = undefined')
            expect(lifecycle).to.include('retainedTextureIndex = undefined')
        }
    })

    it('borrows temporal frames only for presentation and retires its owned display commands', () => {

        const source = read(sourcePath)
        expect(source).to.include('prepared: FlowTemporalReadyBindingFrame')
        expect(source).to.include('uniformLayout, temporal.layout, historyLayout')
        expect(source).to.include('new Set(prepared?.resources ?? [])')
        expect(source).to.include('presentationPair?.bindSet === prepared.bindSet')
        expect(source).to.include('presentationPair.boundary === boundary')
        expect(source).to.include("boundary === 'sdf' ? sdfPipeline : hardPipeline")
        expect(source).to.include('const historyCommands = [')
        expect(source).to.include('for (const command of previous?.commands ?? []) command.dispose()')
        expect(source).not.to.match(/prepared\.(?:bindSet\.dispose|release)\(/)
        expect(source).not.to.match(/temporal\.layout\.dispose\(/)
    })
})
