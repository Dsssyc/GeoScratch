import { expect } from 'chai'
import { ScratchDiagnosticError } from 'geoscratch'
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
            'defineWorkerModule',
        ]) expect(worker).to.have.property(name)
        expect(worker).not.to.have.property('WorkerDiagnosticError')
        expect(worker).not.to.have.property('createWorkerDiagnostic')
        expect(ScratchDiagnosticError).to.be.a('function')
    })

    it('keeps the Worker implementation independent from Geo and GPU runtime state', () => {

        const workerEntrypoint = path.join(root, 'packages', 'geoscratch', 'src', 'worker.ts')
        expect(fs.existsSync(workerEntrypoint)).to.equal(true)
        expect(read('packages', 'geoscratch', 'src', 'worker.ts'))
            .to.equal("export * from './scratch/worker/index.js'\n")

        const workerRoot = path.join(root, 'packages', 'geoscratch', 'src', 'scratch', 'worker')
        for (const name of fs.readdirSync(workerRoot).filter(name => name.endsWith('.ts'))) {
            const source = fs.readFileSync(path.join(workerRoot, name), 'utf8')
            expect(source, name).not.to.match(/\.\.\/gpu|\.\.\/\.\.\/geo|ScratchRuntime|GPUDevice|TileMatrix|DEM/)
        }
    })
})
