import { expect } from 'chai'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const exists = (...parts) => fs.existsSync(path.join(root, ...parts))

describe('module layout', () => {

    it('exposes geo and geometry as top-level library modules', async () => {

        expect(exists('packages', 'geoscratch', 'src', 'geo', 'index.ts')).to.equal(true)
        expect(exists('packages', 'geoscratch', 'src', 'geo', 'mercatorCoordinate.ts')).to.equal(true)
        expect(exists('packages', 'geoscratch', 'src', 'geo', 'tiling', 'geoQuadNode2D.ts')).to.equal(true)
        expect(exists('packages', 'geoscratch', 'src', 'core', 'geo', 'mercatorCoordinate.ts')).to.equal(true)
        expect(exists('packages', 'geoscratch', 'src', 'core', 'quadTree', 'node2D.ts')).to.equal(true)
        expect(exists('packages', 'geoscratch', 'src', 'geometry', 'index.js')).to.equal(true)
        expect(exists('packages', 'geoscratch', 'src', 'geometry', 'sphere', 'sphere.js')).to.equal(true)
        expect(exists('packages', 'geoscratch', 'src', 'geometry', 'plane', 'plane.js')).to.equal(true)

        const removedGeoSources = [
            [ 'geo', 'index.js' ],
            [ 'geo', 'index.d.ts' ],
            [ 'geo', 'mercatorCoordinate.js' ],
            [ 'geo', 'mercatorCoordinate.d.ts' ],
            [ 'geo', 'tiling', 'geoQuadNode2D.js' ],
            [ 'geo', 'tiling', 'geoQuadNode2D.d.ts' ],
            [ 'core', 'geo', 'mercatorCoordinate.js' ],
            [ 'core', 'geo', 'mercatorCoordinate.d.ts' ],
            [ 'core', 'quadTree', 'node2D.js' ],
            [ 'core', 'quadTree', 'node2D.d.ts' ],
        ]
        for (const sourcePath of removedGeoSources) {
            expect(exists('packages', 'geoscratch', 'src', ...sourcePath), sourcePath.join('/'))
                .to.equal(false)
        }

        expect(exists('packages', 'geoscratch', 'dist', 'geo', 'index.js')).to.equal(true)
        expect(exists('packages', 'geoscratch', 'dist', 'geo', 'index.d.ts')).to.equal(true)
        expect(exists('packages', 'geoscratch', 'dist', 'geo', 'mercatorCoordinate.js')).to.equal(true)
        expect(exists('packages', 'geoscratch', 'dist', 'geo', 'mercatorCoordinate.d.ts')).to.equal(true)
        expect(exists('packages', 'geoscratch', 'dist', 'geo', 'tiling', 'geoQuadNode2D.js')).to.equal(true)
        expect(exists('packages', 'geoscratch', 'dist', 'geo', 'tiling', 'geoQuadNode2D.d.ts')).to.equal(true)

        const entry = await import('geoscratch')
        const geo = await import('geoscratch/geo')
        const geometry = await import('geoscratch/geometry')

        expect(geo.MercatorCoordinate).to.equal(entry.MercatorCoordinate)
        expect(geo.Node2D).to.equal(entry.Node2D)
        expect(geo.GeoQuadNode2D).to.equal(entry.GeoQuadNode2D)
        expect(geometry.sphere).to.equal(entry.sphere)
        expect(geometry.plane).to.equal(entry.plane)
    })

    it('keeps compatibility re-exports for legacy core paths', async () => {

        const geo = await import('../packages/geoscratch/dist/geo/index.js')
        const geometry = await import('../packages/geoscratch/src/geometry/index.js')
        const legacyMercator = await import('../packages/geoscratch/dist/core/geo/mercatorCoordinate.js')
        const legacyNode = await import('../packages/geoscratch/dist/core/quadTree/node2D.js')
        const legacySphere = await import('../packages/geoscratch/src/core/geometry/sphere/sphere.js')
        const legacyPlane = await import('../packages/geoscratch/src/core/geometry/plane/plane.js')

        expect(legacyMercator.MercatorCoordinate).to.equal(geo.MercatorCoordinate)
        expect(legacyNode.Node2D).to.equal(geo.Node2D)
        expect(legacySphere.sphere).to.equal(geometry.sphere)
        expect(legacyPlane.plane).to.equal(geometry.plane)
    })

    it('publishes package subpaths for geo and geometry', async () => {

        const geo = await import('geoscratch/geo')
        const geometry = await import('geoscratch/geometry')

        expect(geo).to.have.property('MercatorCoordinate').that.is.a('function')
        expect(geo).to.have.property('GeoQuadNode2D').that.is.a('function')
        expect(geo).to.have.property('Node2D').that.equals(geo.GeoQuadNode2D)
        expect(geometry).to.have.property('sphere').that.is.a('function')
        expect(geometry).to.have.property('plane').that.is.a('function')
    })
})
