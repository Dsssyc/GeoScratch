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
        expect(exists('examples', 'underwaterTerrain', 'assets', 'dem.png')).to.equal(true)
        expect(exists('examples', 'underwaterTerrain', 'shaders', 'lod-map.wgsl')).to.equal(false)
        expect(exists(
            'examples', 'underwaterTerrain', 'shaders', 'terrain-presentation.wgsl'
        )).to.equal(true)

        const helloGAW = read('examples', 'helloGAW', 'main.ts')
        const flowLayer = read('examples', 'flowLayer', 'flow-layer.ts')

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

        const config = read('examples', 'vite.config.ts')

        expect(config).to.include("const examplesPublic = path.resolve(examplesRoot, 'public')")
        expect(config).to.include('publicDir: examplesPublic')
        expect(config).to.not.include("publicDir: path.resolve(projectRoot, 'public')")
    })

    it('keeps DEM Worker deployment independent from Vite-specific URL modules', () => {

        const config = read('examples', 'vite.config.ts')
        const workerExecutor = read('examples', 'underwaterTerrain', 'dem-tile-executor.ts')

        expect(exists('examples', 'underwaterTerrain', 'dem-tile-worker-url.ts')).to.equal(false)
        expect(exists('examples', 'underwaterTerrain', 'dem-worker-source.ts')).to.equal(false)
        expect(config).to.not.include('workerModuleUrlPlugin')
        expect(config).to.not.include('demWorkerUrlModule')
        expect(config).to.not.include('demWorkerModule')
        expect(workerExecutor).to.include('DEM_TILE_WORKER')
        expect(workerExecutor).to.include('moduleResolver: descriptor.workerModules')
        expect(workerExecutor).to.include('module: DEM_TILE_WORKER')
        expect(read('examples', 'worker-modules.ts')).to.include('defineWorkerModuleBuild')
        expect(JSON.parse(read('examples', 'package.json')).scripts).to.deep.include({
            'workers:build': 'geoscratch-worker build --config ./worker-modules.ts',
            predev: 'npm run workers:build',
            prebuild: 'npm run workers:build',
        })
    })

    it('keeps npm package files focused on library source', () => {

        const pkg = JSON.parse(read('packages', 'geoscratch', 'package.json'))

        expect(pkg.files).to.deep.equal([
            'README.md',
            'README_zh.md',
            'dist',
            'src',
            'bin',
        ])
    })

    it('ignores large local example data under examples/public', () => {

        const gitignore = read('.gitignore')
        const lines = gitignore.split(/\r?\n/)

        expect(lines).to.include('examples/public/json/examples/*')
        expect(lines).to.not.include('public/json/examples/*')
    })

    it('keeps the DEM source beside its backend without exposing a full-image browser path', () => {

        expect(exists('examples', 'underwaterTerrain', 'assets', 'dem.png')).to.equal(true)
        expect(exists('packages', 'geoscratch', 'src', 'applications', 'terrain')).to.equal(false)

        const main = read('examples', 'underwaterTerrain', 'main.ts')
        const backend = read(
            'examples', 'underwaterTerrain', 'tile-server', 'src', 'geoscratch_dem_tiles', 'build.py'
        )
        expect(backend).to.include('"assets" / "dem.png"')
        expect(main).not.to.include('./assets/dem.png')
        expect(main).to.include('fetchDemTileSource')
        expect(main).to.not.match(/border|palette/i)
    })

    it('keeps example-owned postprocess shaders with Hello GAW after legacy removal', () => {

        expect(exists('packages', 'geoscratch', 'src', 'effects')).to.equal(false)
        expect(exists('examples', 'public', 'shaders', 'postprocess')).to.equal(false)
        expect(read('examples', 'helloGAW', 'shaders', 'bloom.wgsl')).to.include('@compute')
        expect(read('examples', 'helloGAW', 'shaders', 'fxaa.wgsl')).to.include('@compute')
    })

    it('keeps only reachable terrain shaders beside Underwater Terrain', () => {

        expect(exists('examples', 'underwaterTerrain', 'shaders', 'lod-map.wgsl')).to.equal(false)
        expect(exists(
            'examples', 'underwaterTerrain', 'shaders', 'terrain-presentation.wgsl'
        )).to.equal(true)
        expect(exists('examples', 'public', 'shaders', 'examples', 'terrain')).to.equal(false)

        const terrain = read(
            'examples', 'underwaterTerrain', 'shaders', 'terrain-presentation.wgsl'
        )
        expect(terrain).to.include('@fragment')
        expect(terrain).to.not.include('@vertex')
        expect(terrain).to.not.match(/renderPatch|stitch|sample_vertex|cameraFixed/)
        expect(terrain).to.not.include('terrainMeshLineShader')
    })
})
