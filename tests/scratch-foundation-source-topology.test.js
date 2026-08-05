import { expect } from 'chai'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const scratchRoot = path.join(root, 'packages', 'geoscratch', 'src', 'scratch')
const gpuRoot = path.join(scratchRoot, 'gpu')

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
})
