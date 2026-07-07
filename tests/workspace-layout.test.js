import { expect } from 'chai'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8')
const exists = (...parts) => fs.existsSync(path.join(root, ...parts))
const readJson = (...parts) => JSON.parse(read(...parts))

describe('workspace layout', () => {

    it('keeps the repository root as a private workspace orchestrator', () => {

        const pkg = readJson('package.json')

        expect(pkg.name).to.equal('geoscratch-repo')
        expect(pkg.private).to.equal(true)
        expect(pkg.workspaces).to.deep.equal([
            'packages/geoscratch',
            'examples',
        ])
        expect(pkg).to.not.have.property('dependencies')
        expect(pkg.scripts.dev).to.equal('npm --workspace geoscratch run build && npm --workspace examples run dev')
        expect(pkg.scripts.build).to.equal('npm --workspace geoscratch run build && npm --workspace examples run build')
        expect(pkg.scripts.test).to.equal('npm --workspace geoscratch run build && mocha "tests/**/*.test.js"')
        expect(pkg.scripts.typecheck).to.equal('npm --workspace geoscratch run build && tsc -p tsconfig.types.json')
    })

    it('publishes the library from packages/geoscratch only', () => {

        expect(exists('src')).to.equal(false)
        expect(exists('packages', 'geoscratch', 'src', 'index.ts')).to.equal(true)
        expect(exists('packages', 'geoscratch', 'src', 'scratch.ts')).to.equal(true)

        const pkg = readJson('packages', 'geoscratch', 'package.json')

        expect(pkg.name).to.equal('geoscratch')
        expect(pkg.main).to.equal('dist/index.js')
        expect(pkg.types).to.equal('dist/index.d.ts')
        expect(pkg.exports['.'].import).to.equal('./dist/index.js')
        expect(pkg.exports['.'].types).to.equal('./dist/index.d.ts')
        expect(pkg.exports['./scratch'].import).to.equal('./dist/scratch.js')
        expect(pkg.exports['./scratch'].types).to.equal('./dist/scratch.d.ts')
        expect(pkg.exports['./geo'].import).to.equal('./dist/geo/index.js')
        expect(pkg.files).to.deep.equal([
            'README.md',
            'README_zh.md',
            'dist',
            'src',
        ])
        expect(pkg.scripts.build).to.equal('tsc -p tsconfig.build.json')
        expect(Object.keys(pkg.dependencies)).to.deep.equal(['@webgpu/types'])
    })

    it('keeps example-only dependencies inside the examples workspace', () => {

        const examplesPkg = readJson('examples', 'package.json')

        expect(examplesPkg.name).to.equal('geoscratch-examples')
        expect(examplesPkg.private).to.equal(true)
        expect(examplesPkg.dependencies.geoscratch).to.equal('file:../packages/geoscratch')
        expect(examplesPkg.dependencies).to.include.keys([
            '@mapbox/tilebelt',
            'd3-delaunay',
            'earcut',
            'hammerjs',
        ])
        expect(examplesPkg.dependencies).to.not.include.keys([
            '@mapbox/vector-tile',
            'd3-voronoi',
            'pbf',
        ])
    })

    it('makes examples consume the package API rather than internal source files', () => {

        const exampleFiles = [
            'examples/1_helloTriangle/main.js',
            'examples/2_helloVertexBuffer/main.js',
            'examples/scratch_helloTriangle/main.js',
            'examples/scratch_uniformTriangle/main.js',
            'examples/scratch_computeReadback/main.js',
            'examples/scratch_helloVertexBuffer/main.js',
            'examples/shared/scratchMap.js',
            'examples/m_demLayer/terrainLayer.js',
            'examples/m_flowLayer/steadyFlowLayer.js',
            'examples/m_flowLayer/flowJson.worker.js',
            'examples/x_helloGAW/main.js',
        ]

        for (const file of exampleFiles) {
            const source = read(file)

            expect(source, file).to.include("from 'geoscratch'")
            expect(source, file).to.not.include('../../src/')
            expect(source, file).to.not.include('../src/')
        }
    })
})
