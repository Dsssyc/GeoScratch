import { expect } from 'chai'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8')

describe('virtual raster payload ownership contract', () => {

    it('adopts an owned payload without a second typed-array copy', () => {

        const residency = read(
            'packages', 'geoscratch', 'src', 'geo', 'virtual-raster-residency.ts'
        )
        expect(residency).not.to.include('clonePayload')
        expect(residency).not.to.match(/Uint8Array\.from\(payload\.data\)/)
        expect(residency).not.to.match(/Float32Array\.from\(payload\.data\)/)
    })

    it('keeps decoded bytes out of immutable residency snapshots', () => {

        const virtualRaster = read(
            'packages', 'geoscratch', 'src', 'geo', 'virtual-raster.ts'
        )
        const physicalPage = virtualRaster.slice(
            virtualRaster.indexOf('export type VirtualRasterPhysicalPage'),
            virtualRaster.indexOf('export class VirtualRasterAddressSpace')
        )
        expect(physicalPage).not.to.include('payload:')
        expect(virtualRaster).not.to.include('snapshotPhysicalPages')
    })
})
