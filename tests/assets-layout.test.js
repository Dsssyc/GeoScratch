import { expect } from 'chai'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8')
const exists = (...parts) => fs.existsSync(path.join(root, ...parts))

describe('asset layout', () => {

    it('serves example runtime assets from examples/public', () => {

        expect(exists('examples', 'public', 'icon', 'icon_light.png')).to.equal(true)
        expect(exists('examples', 'public', 'images', 'Earth', 'earth.jpg')).to.equal(true)
        expect(exists('examples', 'public', 'images', 'examples', 'terrain', 'dem.png')).to.equal(true)
        expect(exists('examples', 'public', 'shaders', 'examples', 'GAW', 'land.wgsl')).to.equal(true)
        expect(exists('examples', 'public', 'shaders', 'examples', 'flow', 'particles.wgsl')).to.equal(true)
    })

    it('keeps the repository root free of public runtime asset buckets', () => {

        expect(exists('public')).to.equal(false)
    })

    it('configures Vite to use examples/public as its public directory', () => {

        const config = read('vite.config.js')

        expect(config).to.include("const examplesPublic = path.resolve(examplesRoot, 'public')")
        expect(config).to.include('publicDir: examplesPublic')
        expect(config).to.not.include("publicDir: path.resolve(projectRoot, 'public')")
    })

    it('keeps npm package files focused on library source', () => {

        const pkg = JSON.parse(read('package.json'))

        expect(pkg.files).to.deep.equal([
            'README_zh.md',
            'src',
        ])
    })

    it('ignores large local example data under examples/public', () => {

        const gitignore = read('.gitignore')
        const lines = gitignore.split(/\r?\n/)

        expect(lines).to.include('examples/public/json/examples/*')
        expect(lines).to.not.include('public/json/examples/*')
    })

    it('keeps library-owned postprocess shaders next to postprocess source', async () => {

        expect(exists('src', 'effects', 'postprocess', 'shaders', 'bloom', 'index.js')).to.equal(true)
        expect(exists('src', 'effects', 'postprocess', 'shaders', 'fxaa', 'index.js')).to.equal(true)
        expect(exists('examples', 'public', 'shaders', 'postprocess')).to.equal(false)

        const bloomPass = read('src', 'effects', 'postprocess', 'bloomPass.js')
        const fxaaPass = read('src', 'effects', 'postprocess', 'fxaaPass.js')

        expect(bloomPass).to.not.include('/shaders/postprocess/')
        expect(fxaaPass).to.not.include('/shaders/postprocess/')

        const bloomShaders = await import('../src/effects/postprocess/shaders/bloom/index.js')
        const fxaaShaders = await import('../src/effects/postprocess/shaders/fxaa/index.js')

        expect(bloomShaders.highlightComputeShader).to.include('@compute')
        expect(bloomShaders.bloomOutputComputeShader).to.include('@compute')
        expect(fxaaShaders.fxaaComputeShader).to.include('@compute')
    })

    it('keeps library-owned terrain shaders next to terrain source', async () => {

        expect(exists('src', 'applications', 'terrain', 'shaders', 'index.js')).to.equal(true)
        expect(exists('examples', 'public', 'shaders', 'examples', 'terrain')).to.equal(false)

        const localTerrain = read('src', 'applications', 'terrain', 'localTerrain.js')

        expect(localTerrain).to.not.include('/shaders/examples/terrain/')

        const terrainShaders = await import('../src/applications/terrain/shaders/index.js')

        expect(terrainShaders.lodMapShader).to.include('@vertex')
        expect(terrainShaders.terrainMeshShader).to.include('@vertex')
        expect(terrainShaders.terrainMeshLineShader).to.include('@vertex')
    })
})
