import { expect } from 'chai'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const exists = (...parts) => fs.existsSync(path.join(root, ...parts))

describe('module layout', () => {

    it('owns geometry and identity inside the TypeScript Scratch foundation', () => {

        for (const sourcePath of [
            [ 'scratch', 'geometry', 'index.ts' ],
            [ 'scratch', 'geometry', 'sphere.ts' ],
            [ 'scratch', 'geometry', 'plane.ts' ],
            [ 'scratch', 'internal', 'uuid.ts' ],
        ]) {
            expect(exists('packages', 'geoscratch', 'src', ...sourcePath), sourcePath.join('/'))
                .to.equal(true)
        }

        for (const removedPath of [ 'core', 'geometry', 'gpu', 'effects', 'loaders', 'worker.ts' ]) {
            expect(exists('packages', 'geoscratch', 'src', removedPath), removedPath)
                .to.equal(false)
        }
    })

    it('emits only the formal Scratch and Geo module trees', async () => {

        expect(exists('packages', 'geoscratch', 'dist', 'scratch', 'geometry', 'index.js'))
            .to.equal(true)
        expect(exists('packages', 'geoscratch', 'dist', 'geo', 'index.js')).to.equal(true)
        expect(exists('packages', 'geoscratch', 'dist', 'geometry')).to.equal(false)
        expect(exists('packages', 'geoscratch', 'dist', 'worker.js')).to.equal(false)

        const entry = await import('geoscratch')
        const scratch = await import('geoscratch/scratch')
        const geo = await import('geoscratch/geo')

        expect(entry.scratch.plane).to.equal(scratch.plane)
        expect(entry.scratch.WorkerSystem).to.equal(scratch.WorkerSystem)
        expect(entry.geo.MercatorCoordinate).to.equal(geo.MercatorCoordinate)
    })
})
