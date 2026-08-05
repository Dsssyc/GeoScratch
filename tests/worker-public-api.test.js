import { expect } from 'chai'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8')

describe('generic WorkerSystem public contract', () => {

    it('publishes an independent geoscratch/worker package subpath', async() => {

        const packageJson = JSON.parse(read('packages', 'geoscratch', 'package.json'))
        expect(packageJson.exports).to.have.property('./worker')

        const worker = await import('geoscratch/worker')
        for (const name of [
            'WorkerSystem',
            'WorkerGroup',
            'WorkerDiagnosticError',
            'createWorkerDiagnostic',
            'defineWorkerModule',
        ]) expect(worker).to.have.property(name)
    })

    it('keeps the worker package independent from Geo and Scratch', () => {

        const workerEntrypoint = path.join(root, 'packages', 'geoscratch', 'src', 'worker.ts')
        expect(fs.existsSync(workerEntrypoint)).to.equal(true)
        const source = read('packages', 'geoscratch', 'src', 'worker.ts')
        expect(source).not.to.match(/\.\/geo|\.\/scratch|ScratchRuntime|GPUDevice|TileMatrix|DEM/)
    })
})
