import { expect } from 'chai'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8')
const exists = (...parts) => fs.existsSync(path.join(root, ...parts))

describe('Hello GAW Scratch clean cut', () => {

    it('publishes one neutral example and removes the legacy route', () => {

        expect(exists('examples', 'helloGAW')).to.equal(true)
        expect(exists('examples', 'x_helloGAW')).to.equal(false)

        const catalog = read('examples', 'index.html')
        const vite = read('examples', 'vite.config.js')
        const neutralLinkStart = catalog.indexOf('data-id="helloGAW"')
        const neutralLinkEnd = catalog.indexOf('</a>', neutralLinkStart)
        const neutralLink = catalog.slice(neutralLinkStart, neutralLinkEnd)

        expect(neutralLinkStart).to.be.greaterThan(-1)
        expect(neutralLink).to.include('data-path="./helloGAW/"')
        expect(neutralLink).to.include('data-title="Hello GAW"')
        expect(neutralLink).to.include('<span class="example-title">Hello GAW</span>')
        expect(neutralLink).to.not.include('(legacy)')
        expect(neutralLink).to.not.match(/scratch/i)
        expect(catalog.match(/\(legacy\)/g) ?? []).to.have.length(2)
        expect(catalog).to.not.include('x_helloGAW')
        expect(vite).to.include("helloGAW: path.resolve(examplesRoot, 'helloGAW/index.html')")
        expect(vite).to.not.include('x_helloGAW')
    })

    it('uses only public Scratch ownership and execution APIs', () => {

        const source = read('examples', 'helloGAW', 'main.js')

        expect(source).to.include("from 'geoscratch'")
        expect(source).to.include('ScratchRuntime')
        expect(source).to.include('createSurface')
        expect(source).to.include('createExternalImageUploadCommand')
        expect(source).to.include('createSubmission')
        expect(source).to.include('submitted.nativeOutcome')
        expect(source).to.include('submitted.done')
        expect(source).to.include("contentEpoch: 'current-at-step'")
        expect(source).to.not.match(/packages\/geoscratch\/src|\.\.\/\.\.\/src|\.\.\/src/)

        for (const forbidden of [
            'StartDash',
            'director',
            'BloomPass',
            'FXAAPass',
            'imageLoader',
            'scr.screen',
            'scr.binding',
            'scr.renderPass',
            'scr.computePass',
            'scr.renderPipeline',
            'scr.computePipeline',
            'scr.vertexBuffer',
            'scr.storageBuffer',
            'scr.indirectBuffer',
            'scr.texture',
            'scr.sampler',
            'scr.f32',
            'scr.u32',
            'scr.aRef',
            'scr.asF32',
            'scr.asU32',
            'scr.asVec',
        ]) {
            expect(source, forbidden).to.not.include(forbidden)
        }
        expect(source).to.not.match(/\b(?:legacy|compatibility|compatRoute|useOldApi)\b/i)
    })

    it('keeps the complete GPU workload and exact five-stage order', () => {

        const source = read('examples', 'helloGAW', 'main.js')
        const stageMarkers = [
            '.compute(simulationPass, simulationCommands)',
            '.render(scenePass, sceneCommands)',
            '.compute(bloomPass, bloomCommands)',
            '.compute(fxaaPass, [ fxaaCommand ])',
            '.render(outputPass, [ outputCommand ])',
        ]
        let previousIndex = -1
        for (const marker of stageMarkers) {
            const markerIndex = source.indexOf(marker)
            expect(markerIndex, marker).to.be.greaterThan(previousIndex)
            previousIndex = markerIndex
        }

        for (const marker of [
            'const BLOOM_BLUR_LEVELS = 5',
            'bloomCommands.length === 17',
            'sceneCommands.length === 5',
            'count: { indirect: linkIndirectRegion }',
            'createDispatchCommand',
            'createDrawCommand',
            'createRenderPass',
            'createComputePass',
            'depth24plus',
            'normalBlend',
            'additiveBlend',
            'toneMapACES',
            'gammaCorrect',
            'resizeRenderGraph',
            'prepareStaleBindSets',
            'createSizeDependentCommands',
        ]) {
            expect(source, marker).to.include(marker)
        }

        expect(source).to.not.match(/mapAsync|getMappedRange|createReadback|toBytes|toArray/)
        expect(source).to.not.match(/linkIndirect[^\n]*(?:map|readback|decode)/i)
    })

    it('keeps every workload shader and used image beside the neutral example', () => {

        for (const shader of [
            'cloud.wgsl',
            'land.wgsl',
            'last.wgsl',
            'link.compute.wgsl',
            'link.wgsl',
            'particle.compute.wgsl',
            'point.wgsl',
            'water.wgsl',
            'bloom.wgsl',
            'fxaa.wgsl',
        ]) {
            expect(exists('examples', 'helloGAW', 'shaders', shader), shader).to.equal(true)
        }

        for (const image of [
            'earth.jpg',
            'earth-night.jpg',
            'earth-specular.jpg',
            'earth-selfillumination.jpg',
            'mask-land.jpg',
            'cloud.jpg',
            'cloud-night.jpg',
            'cloud-alpha.jpg',
        ]) {
            expect(
                exists('examples', 'helloGAW', 'assets', 'images', image),
                image
            ).to.equal(true)
        }
    })

    it('locks the migration decision, audit, and managed browser proof', () => {

        const adr = read('docs', 'decisions', 'ADR-042-hello-gaw-scratch-api-clean-cut.md')
        const audit = read('docs', 'review', 'scratch-hello-gaw-migration-audit.md')
        const browser = read('tests', 'browser', 'scratch-hello-gaw.mjs')

        expect(adr).to.include('## Status')
        expect(adr).to.include('Accepted')
        expect(adr).to.include('five-stage')
        expect(adr).to.include("'current-at-step'")
        expect(adr).to.include('17')
        expect(audit).to.include('Fixed Legacy Browser Evidence')
        expect(audit).to.include('Five-Stage Submission Matrix')
        expect(browser).to.include('HELLO_GAW_PROOF_FRAMES')
        expect(browser).to.include("headless: false")
        expect(browser).to.include("channel: 'chrome'")
        expect(browser).to.include("args: [ '--enable-unsafe-webgpu' ]")
        expect(browser).to.include('requestfailed')
        expect(browser).to.include('response.status() >= 400')
        expect(browser).to.include('waitForPortClosed')
        expect(browser).to.include('resize')
    })
})
