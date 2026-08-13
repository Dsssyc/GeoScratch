import { expect } from 'chai'
import {
    ScratchDiagnosticError,
    WorkerContextPool,
    WorkerGroup,
    WorkerModuleCatalog,
    WorkerSystem,
    defineWorkerModuleBuild,
    defineWorkerModuleContract,
    defineWorkerModule,
    recommendedWorkerCount,
    workerRemoteErrorCode,
    workerRemoteErrorFacts,
} from 'geoscratch/scratch'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8')

describe('generic WorkerSystem public contract', () => {

    it('publishes Worker as an independent Scratch capability domain', () => {

        const packageJson = JSON.parse(read('packages', 'geoscratch', 'package.json'))
        expect(packageJson.exports).not.to.have.property('./worker')

        expect(WorkerSystem).to.be.a('function')
        expect(WorkerContextPool).to.be.a('function')
        expect(WorkerGroup).to.be.a('function')
        expect(WorkerModuleCatalog).to.be.a('function')
        expect(defineWorkerModuleContract).to.be.a('function')
        expect(defineWorkerModuleBuild).to.be.a('function')
        expect(defineWorkerModule).to.be.a('function')
        expect(recommendedWorkerCount).to.be.a('function')
        expect(workerRemoteErrorCode).to.be.a('function')
        expect(workerRemoteErrorFacts).to.be.a('function')
        expect(ScratchDiagnosticError).to.be.a('function')
    })

    it('keeps the Worker implementation independent from Geo and GPU runtime state', () => {

        const workerEntrypoint = path.join(root, 'packages', 'geoscratch', 'src', 'worker.ts')
        expect(fs.existsSync(workerEntrypoint)).to.equal(false)

        const workerRoot = path.join(root, 'packages', 'geoscratch', 'src', 'scratch', 'worker')
        for (const name of fs.readdirSync(workerRoot).filter(name => name.endsWith('.ts'))) {
            const source = fs.readFileSync(path.join(workerRoot, name), 'utf8')
            expect(source, name).not.to.match(/\.\.\/gpu|\.\.\/\.\.\/geo|GPURuntime|GPUDevice|TileMatrix|DEM/)
        }
    })
})
