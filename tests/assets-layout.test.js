import { expect } from 'chai'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8')
const exists = (...parts) => fs.existsSync(path.join(root, ...parts))

describe('asset layout', () => {

    it('keeps documentation and branding assets under docs/assets', () => {

        expect(exists('docs', 'assets', 'icons', 'icon_light.png')).to.equal(true)
        expect(exists('docs', 'assets', 'icons', 'icon_dark.png')).to.equal(true)
        expect(read('examples', 'index.html')).to.include('../docs/assets/icons/icon_light.png')
        expect(read('examples', 'helloTriangle', 'index.html')).to.include('../../docs/assets/icons/icon_light.png')
    })

    it('keeps ordinary example assets colocated with their examples', () => {

        expect(exists('examples', 'helloGAW', 'assets', 'images', 'earth.jpg')).to.equal(true)
        expect(exists('examples', 'helloGAW', 'shaders', 'land.wgsl')).to.equal(true)
        expect(exists('examples', 'flowLayer', 'shaders', 'flow', 'particles.wgsl')).to.equal(true)

        const helloGAW = read('examples', 'helloGAW', 'main.js')
        const flowLayer = read('examples', 'flowLayer', 'flow-layer.js')

        expect(helloGAW).to.not.include('/images/Earth/')
        expect(helloGAW).to.not.include('/shaders/examples/GAW/')
        expect(helloGAW).to.include('./assets/images/earth.jpg')
        expect(helloGAW).to.include('./shaders/land.wgsl?raw')
        expect(flowLayer).to.not.include('/shaders/examples/flow/')
        expect(flowLayer).to.include('./shaders/flow/particles.wgsl?raw')
    })

    it('keeps public directories only for large URL-addressed local data', () => {

        expect(exists('public')).to.equal(false)
        expect(exists('examples', 'public', 'icon')).to.equal(false)
        expect(exists('examples', 'public', 'images')).to.equal(false)
        expect(exists('examples', 'public', 'shaders')).to.equal(false)
    })

    it('configures Vite to use examples/public as its public directory', () => {

        const config = read('examples', 'vite.config.js')

        expect(config).to.include("const examplesPublic = path.resolve(examplesRoot, 'public')")
        expect(config).to.include('publicDir: examplesPublic')
        expect(config).to.not.include("publicDir: path.resolve(projectRoot, 'public')")
    })

    it('keeps npm package files focused on library source', () => {

        const pkg = JSON.parse(read('packages', 'geoscratch', 'package.json'))

        expect(pkg.files).to.deep.equal([
            'README.md',
            'README_zh.md',
            'dist',
            'src',
        ])
    })

    it('ignores large local example data under examples/public', () => {

        const gitignore = read('.gitignore')
        const lines = gitignore.split(/\r?\n/)

        expect(lines).to.include('examples/public/json/examples/*')
        expect(lines).to.not.include('public/json/examples/*')
    })

    it('keeps library-owned terrain assets next to terrain source', async () => {

        expect(exists('packages', 'geoscratch', 'src', 'applications', 'terrain', 'assets', 'index.js')).to.equal(true)
        expect(exists('packages', 'geoscratch', 'src', 'applications', 'terrain', 'assets', 'dem.png')).to.equal(false)
        expect(exists('packages', 'geoscratch', 'src', 'applications', 'terrain', 'assets', 'border.png')).to.equal(false)
        expect(exists('packages', 'geoscratch', 'src', 'applications', 'terrain', 'assets', 'demPalette10.png')).to.equal(false)

        const localTerrain = read('packages', 'geoscratch', 'src', 'applications', 'terrain', 'localTerrain.js')

        expect(localTerrain).to.not.include('/images/examples/terrain/')
        expect(localTerrain).to.include('./assets/index.js')

        const terrainAssets = await import('../packages/geoscratch/src/applications/terrain/assets/index.js')

        expect(terrainAssets.demImageDataUrl).to.match(/^data:image\/png;base64,/)
        expect(terrainAssets.borderImageDataUrl).to.match(/^data:image\/png;base64,/)
        expect(terrainAssets.demPaletteImageDataUrl).to.match(/^data:image\/png;base64,/)
    })

    it('keeps library-owned postprocess shaders next to postprocess source', async () => {

        expect(exists('packages', 'geoscratch', 'src', 'effects', 'postprocess', 'shaders', 'bloom', 'index.js')).to.equal(true)
        expect(exists('packages', 'geoscratch', 'src', 'effects', 'postprocess', 'shaders', 'fxaa', 'index.js')).to.equal(true)
        expect(exists('examples', 'public', 'shaders', 'postprocess')).to.equal(false)

        const bloomPass = read('packages', 'geoscratch', 'src', 'effects', 'postprocess', 'bloomPass.js')
        const fxaaPass = read('packages', 'geoscratch', 'src', 'effects', 'postprocess', 'fxaaPass.js')

        expect(bloomPass).to.not.include('/shaders/postprocess/')
        expect(fxaaPass).to.not.include('/shaders/postprocess/')

        const bloomShaders = await import('../packages/geoscratch/src/effects/postprocess/shaders/bloom/index.js')
        const fxaaShaders = await import('../packages/geoscratch/src/effects/postprocess/shaders/fxaa/index.js')

        expect(bloomShaders.highlightComputeShader).to.include('@compute')
        expect(bloomShaders.bloomOutputComputeShader).to.include('@compute')
        expect(fxaaShaders.fxaaComputeShader).to.include('@compute')
    })

    it('keeps library-owned terrain shaders next to terrain source', async () => {

        expect(exists('packages', 'geoscratch', 'src', 'applications', 'terrain', 'shaders', 'index.js')).to.equal(true)
        expect(exists('examples', 'public', 'shaders', 'examples', 'terrain')).to.equal(false)

        const localTerrain = read('packages', 'geoscratch', 'src', 'applications', 'terrain', 'localTerrain.js')

        expect(localTerrain).to.not.include('/shaders/examples/terrain/')

        const terrainShaders = await import('../packages/geoscratch/src/applications/terrain/shaders/index.js')

        expect(terrainShaders.lodMapShader).to.include('@vertex')
        expect(terrainShaders.terrainMeshShader).to.include('@vertex')
        expect(terrainShaders.terrainMeshLineShader).to.include('@vertex')
    })
})
