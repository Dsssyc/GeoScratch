import { expect } from 'chai'

describe('OGC WebMercatorQuad public contract', () => {

    it('publishes standard matrix facts instead of a local raster pyramid', async() => {

        const geo = await import('geoscratch/geo')
        expect(geo).to.have.property('WebMercatorQuad')
        const matrix = geo.WebMercatorQuad.matrix('3')

        expect(geo.WebMercatorQuad).to.deep.include({
            id: 'WebMercatorQuad',
            crs: 'http://www.opengis.net/def/crs/EPSG/0/3857',
        })
        expect(matrix).to.deep.include({
            id: '3',
            pointOfOrigin: [ -20037508.3427892, 20037508.3427892 ],
            tileWidth: 256,
            tileHeight: 256,
            matrixWidth: 8,
            matrixHeight: 8,
        })
    })

    it('maps finite global coverage into compact deterministic indices', async() => {

        const geo = await import('geoscratch/geo')
        const coverage = geo.tileMatrixCoverage({
            tileMatrixSet: geo.WebMercatorQuad,
            limits: [
                { matrixId: '8', minTileRow: 101, maxTileRow: 103, minTileCol: 212, maxTileCol: 215 },
                { matrixId: '9', minTileRow: 202, maxTileRow: 207, minTileCol: 424, maxTileCol: 431 },
            ],
        })

        expect(coverage.entryCount).to.equal(12 + 48)
        expect(coverage.index({ matrixId: '8', tileRow: 101, tileCol: 212 })).to.equal(0)
        expect(coverage.index({ matrixId: '8', tileRow: 103, tileCol: 215 })).to.equal(11)
        expect(coverage.index({ matrixId: '9', tileRow: 202, tileCol: 424 })).to.equal(12)
    })
})
