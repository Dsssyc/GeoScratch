import { expect } from 'chai'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const scratchRoot = path.join(root, 'packages', 'geoscratch', 'src', 'scratch')
const gpuRoot = path.join(scratchRoot, 'gpu')
const workerRoot = path.join(scratchRoot, 'worker')
const legacyWorkerRoot = path.join(root, 'packages', 'geoscratch', 'src', 'worker')
const sourceRoot = path.join(root, 'packages', 'geoscratch', 'src')

const gpuBasenames = [
    'binding-ownership.ts',
    'binding.ts',
    'buffer-mapping-authority.ts',
    'buffer-mapping.ts',
    'buffer.ts',
    'command.ts',
    'debug-command.ts',
    'diagnostics.ts',
    'feature-contract.ts',
    'gpu-operation.ts',
    'layout-artifact.ts',
    'layout-codec.ts',
    'native-allocation.ts',
    'pass.ts',
    'pipeline-compilation.ts',
    'pipeline-creation.ts',
    'pipeline-native-error.ts',
    'pipeline-ownership.ts',
    'pipeline.ts',
    'program.ts',
    'query-set.ts',
    'readback-lease.ts',
    'readback-mapping.ts',
    'readback-ownership.ts',
    'readback-staging.ts',
    'readback.ts',
    'readonly-map.ts',
    'render-bundle-ownership.ts',
    'render-bundle.ts',
    'resource.ts',
    'runtime-authority.ts',
    'runtime-diagnostics.ts',
    'runtime.ts',
    'sampler.ts',
    'shader-inspection.ts',
    'shader-module-ownership.ts',
    'shader-module.ts',
    'submission-authority.ts',
    'submission-native-observation.ts',
    'submission.ts',
    'supporting-object-creation.ts',
    'supporting-object-failure.ts',
    'surface.ts',
    'temporal-texture.ts',
    'texture-format-capabilities.ts',
    'texture-readback.ts',
    'texture.ts',
    'type-utils.ts',
]

const workerBasenames = [
    'diagnostics.ts',
    'index.ts',
    'module.ts',
    'protocol.ts',
    'task-phase-budget.ts',
    'worker-bootstrap.ts',
    'worker-system.ts',
]

describe('Scratch foundation source topology', () => {

    it('owns every current GPU implementation under scratch/gpu', () => {

        const directTypeScript = fs.readdirSync(scratchRoot, { withFileTypes: true })
            .filter(entry => entry.isFile() && entry.name.endsWith('.ts'))
            .map(entry => entry.name)
            .sort()

        expect(directTypeScript).to.deep.equal([ 'index.ts' ])
        expect(fs.readdirSync(gpuRoot).filter(name => name.endsWith('.ts')).sort())
            .to.deep.equal(gpuBasenames)
    })

    it('keeps the GPU domain independent from Worker and Geo', () => {

        for (const basename of gpuBasenames) {
            const source = fs.readFileSync(path.join(gpuRoot, basename), 'utf8')
            expect(source, basename).not.to.match(/from ['"][^'"]*(?:worker|geo)[^'"]*['"]/)
        }
    })

    it('owns Worker only under scratch/worker without GPU, Geo, Cache, or Canvas coupling', () => {

        expect(fs.existsSync(legacyWorkerRoot)).to.equal(false)
        expect(fs.readdirSync(workerRoot).filter(name => name.endsWith('.ts')).sort())
            .to.deep.equal(workerBasenames)

        for (const basename of workerBasenames) {
            const source = fs.readFileSync(path.join(workerRoot, basename), 'utf8')
            const forbiddenDomainImport = /from ['"][^'"]*(?:gpu|geo|cache)[^'"]*['"]/
            expect(source, basename).not.to.match(forbiddenDomainImport)
            expect(source, basename).not.to.match(
                /\b(?:GPUDevice|GPUCanvasContext|HTMLCanvasElement|OffscreenCanvas|GPURuntime)\b/
            )
        }
    })

    it('contains only TypeScript source under the two approved domains', () => {

        const unexpectedExtensions = []
        const visit = directory => {
            for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
                const target = path.join(directory, entry.name)
                if (entry.isDirectory()) visit(target)
                else if (!entry.name.endsWith('.ts')) unexpectedExtensions.push(
                    path.relative(sourceRoot, target)
                )
            }
        }
        visit(sourceRoot)

        expect(unexpectedExtensions).to.deep.equal([])
        expect(fs.existsSync(path.join(sourceRoot, 'core'))).to.equal(false)
        expect(fs.existsSync(path.join(sourceRoot, 'gpu'))).to.equal(false)
        expect(fs.existsSync(path.join(sourceRoot, 'geometry'))).to.equal(false)
        expect(fs.existsSync(path.join(sourceRoot, 'effects'))).to.equal(false)
        expect(fs.existsSync(path.join(sourceRoot, 'loaders'))).to.equal(false)
        expect(fs.existsSync(path.join(sourceRoot, 'worker.ts'))).to.equal(false)
    })
})
