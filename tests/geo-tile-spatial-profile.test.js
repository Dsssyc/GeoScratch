import { expect } from 'chai'
import {
    GeoDiagnosticError,
    WebMercatorQuad,
    planarTileSpatialProfile,
    regularQuadTileTopology,
    tileMatrixCoverage,
    tileMatrixSet,
    webMercatorPlanarTileSpatialProfile,
    webMercatorQuadAddressCodec,
} from 'geoscratch/geo'

function worldCrs84Quad() {

    return tileMatrixSet({
        id: 'WorldCRS84Quad-test',
        crs: 'http://www.opengis.net/def/crs/OGC/1.3/CRS84',
        orderedAxes: [ 'longitude', 'latitude' ],
        boundingBox: {
            crs: 'http://www.opengis.net/def/crs/OGC/1.3/CRS84',
            lowerCorner: [ -180, -90 ],
            upperCorner: [ 180, 90 ],
        },
        tileMatrices: Array.from({ length: 3 }, (_, level) => ({
            id: String(level),
            scaleDenominator: 1 / 2 ** level,
            cellSize: 180 / (256 * 2 ** level),
            pointOfOrigin: [ -180, 90 ],
            cornerOfOrigin: 'topLeft',
            tileWidth: 256,
            tileHeight: 256,
            matrixWidth: 2 * 2 ** level,
            matrixHeight: 2 ** level,
        })),
    })
}

describe('Geo tile spatial profiles', () => {

    it('represents a 2 x 1 root forest without collapsing both roots into one path', () => {

        const matrixSet = worldCrs84Quad()
        const coverage = tileMatrixCoverage({
            tileMatrixSet: matrixSet,
            limits: matrixSet.tileMatrices.map(matrix => ({
                matrixId: matrix.id,
                minTileRow: 0,
                maxTileRow: matrix.matrixHeight - 1,
                minTileCol: 0,
                maxTileCol: matrix.matrixWidth - 1,
            })),
        })
        const topology = regularQuadTileTopology({
            id: 'world-crs84-quad-topology',
            tileMatrixSet: matrixSet,
        })
        const profile = planarTileSpatialProfile({
            id: 'world-crs84-planar',
            topology,
            coverage,
            coordinateBits: 40,
            wrapX: true,
        })

        expect(topology.roots.map(root => root.key)).to.deep.equal([
            '0/0/0',
            '0/0/1',
        ])
        expect(profile.tileBounds(topology.roots[0])).to.deep.equal({
            west: -180,
            south: -90,
            east: 0,
            north: 90,
        })
        expect(profile.tileBounds(topology.roots[1])).to.deep.equal({
            west: 0,
            south: -90,
            east: 180,
            north: 90,
        })
        expect(topology.children(topology.roots[1]).map(tile => tile.key)).to.deep.equal([
            '1/0/2',
            '1/0/3',
            '1/1/2',
            '1/1/3',
        ])
        expect(profile.comparePath(topology.roots[0], topology.roots[1])).to.be.lessThan(0)
        expect(profile.path(topology.roots[0])).to.deep.equal([ 0 ])
        expect(profile.path(topology.roots[1])).to.deep.equal([ 1 ])
        expect(profile.isPathPrefix(
            topology.roots[1],
            topology.children(topology.roots[1])[3]
        )).to.equal(true)
        expect(profile.isPathPrefix(
            topology.roots[0],
            topology.children(topology.roots[1])[0]
        )).to.equal(false)
    })

    it('uses matrix dimensions rather than a hard-coded 2^level normalized world', () => {

        const matrixSet = worldCrs84Quad()
        const coverage = tileMatrixCoverage({
            tileMatrixSet: matrixSet,
            limits: [
                { matrixId: '0', minTileRow: 0, maxTileRow: 0, minTileCol: 0, maxTileCol: 1 },
                { matrixId: '1', minTileRow: 0, maxTileRow: 1, minTileCol: 0, maxTileCol: 3 },
            ],
        })
        const profile = planarTileSpatialProfile({
            id: 'rectangular-world',
            topology: regularQuadTileTopology({ id: 'rectangular-world', tileMatrixSet: matrixSet }),
            coverage,
        })

        expect(profile.normalizedBounds(matrixSet.tile({
            matrixId: '0', tileRow: 0, tileCol: 1,
        }))).to.deep.equal({ west: 0.5, north: 0, east: 1, south: 1 })
        expect(profile.normalizedBounds(matrixSet.tile({
            matrixId: '1', tileRow: 1, tileCol: 3,
        }))).to.deep.equal({ west: 0.75, north: 0.5, east: 1, south: 1 })
    })

    it('rejects matrix geometry that cannot share one CPU and GPU planar world', () => {

        const createMatrixSet = ({ pointOfOrigin, childCellSize }) => tileMatrixSet({
            id: `planar-geometry-${pointOfOrigin[0]}-${childCellSize}`,
            crs: 'test',
            orderedAxes: [ 'x', 'y' ],
            boundingBox: { crs: 'test', lowerCorner: [ 0, 0 ], upperCorner: [ 1, 1 ] },
            tileMatrices: [
                {
                    id: '0', scaleDenominator: 1, cellSize: 1 / 256,
                    pointOfOrigin, cornerOfOrigin: 'topLeft',
                    tileWidth: 256, tileHeight: 256, matrixWidth: 1, matrixHeight: 1,
                },
                {
                    id: '1', scaleDenominator: 0.5, cellSize: childCellSize,
                    pointOfOrigin, cornerOfOrigin: 'topLeft',
                    tileWidth: 256, tileHeight: 256, matrixWidth: 2, matrixHeight: 2,
                },
            ],
        })
        const createProfile = matrixSet => {
            const coverage = tileMatrixCoverage({
                tileMatrixSet: matrixSet,
                limits: matrixSet.tileMatrices.map(matrix => ({
                    matrixId: matrix.id,
                    minTileRow: 0,
                    maxTileRow: matrix.matrixHeight - 1,
                    minTileCol: 0,
                    maxTileCol: matrix.matrixWidth - 1,
                })),
            })
            return planarTileSpatialProfile({
                id: 'invalid-planar-geometry',
                topology: regularQuadTileTopology({ id: 'invalid-planar-geometry', tileMatrixSet: matrixSet }),
                coverage,
            })
        }

        expect(() => createProfile(createMatrixSet({
            pointOfOrigin: [ 0.25, 1 ],
            childCellSize: 1 / 512,
        }))).to.throw(GeoDiagnosticError)
        expect(() => createProfile(createMatrixSet({
            pointOfOrigin: [ 0, 1 ],
            childCellSize: 1 / 256,
        }))).to.throw(GeoDiagnosticError)
    })

    it('snapshots descriptor policy instead of retaining a mutable descriptor', () => {

        const matrixSet = worldCrs84Quad()
        const coverage = tileMatrixCoverage({
            tileMatrixSet: matrixSet,
            limits: matrixSet.tileMatrices.map(matrix => ({
                matrixId: matrix.id,
                minTileRow: 0,
                maxTileRow: matrix.matrixHeight - 1,
                minTileCol: 0,
                maxTileCol: matrix.matrixWidth - 1,
            })),
        })
        const descriptor = {
            id: 'immutable-planar-policy',
            topology: regularQuadTileTopology({ id: 'immutable-planar-policy', tileMatrixSet: matrixSet }),
            coverage,
            coordinateBits: 40,
            wrapX: false,
        }
        const profile = planarTileSpatialProfile(descriptor)
        descriptor.wrapX = true
        const encoded = profile.encodeCamera([ 180, 0 ])
        const x = (BigInt(encoded.high[0]) << 32n) | BigInt(encoded.low[0])

        expect(x).to.equal((1n << 40n) - 1n)
    })

    it('clamps a non-wrapping planar camera at the eastern endpoint without aliasing west', () => {

        const matrixSet = worldCrs84Quad()
        const coverage = tileMatrixCoverage({
            tileMatrixSet: matrixSet,
            limits: matrixSet.tileMatrices.map(matrix => ({
                matrixId: matrix.id,
                minTileRow: 0,
                maxTileRow: matrix.matrixHeight - 1,
                minTileCol: 0,
                maxTileCol: matrix.matrixWidth - 1,
            })),
        })
        const profile = planarTileSpatialProfile({
            id: 'bounded-world',
            topology: regularQuadTileTopology({ id: 'bounded-world', tileMatrixSet: matrixSet }),
            coverage,
            coordinateBits: 40,
            wrapX: false,
        })
        const encoded = profile.encodeCamera([ 180, 0 ])
        const x = (BigInt(encoded.high[0]) << 32n) | BigInt(encoded.low[0])

        expect(x).to.equal((1n << 40n) - 1n)
    })

    it('rejects a matrix hierarchy deeper than its fixed-coordinate encoding', () => {

        const matrixSet = tileMatrixSet({
            id: 'too-deep-for-u64-frontier',
            crs: 'test',
            orderedAxes: [ 'x', 'y' ],
            boundingBox: { crs: 'test', lowerCorner: [ -180, -90 ], upperCorner: [ 180, 90 ] },
            tileMatrices: Array.from({ length: 33 }, (_, level) => ({
                id: String(level),
                scaleDenominator: 1 / 2 ** level,
                cellSize: 180 / (256 * 2 ** level),
                pointOfOrigin: [ -180, 90 ],
                cornerOfOrigin: 'topLeft',
                tileWidth: 256,
                tileHeight: 256,
                matrixWidth: 2 * 2 ** level,
                matrixHeight: 2 ** level,
            })),
        })
        const coverage = tileMatrixCoverage({
            tileMatrixSet: matrixSet,
            limits: matrixSet.tileMatrices.map(matrix => ({
                matrixId: matrix.id,
                minTileRow: 0,
                maxTileRow: 0,
                minTileCol: 0,
                maxTileCol: 0,
            })),
        })
        const topology = regularQuadTileTopology({ id: 'too-deep', tileMatrixSet: matrixSet })

        expect(() => planarTileSpatialProfile({
            id: 'too-deep',
            topology,
            coverage,
            coordinateBits: 32,
        })).to.throw(GeoDiagnosticError)
    })

    it('wraps the canonical WebMercator address codec without changing its bounds or precision', () => {

        const coverage = tileMatrixCoverage({
            tileMatrixSet: WebMercatorQuad,
            limits: [
                { matrixId: '0', minTileRow: 0, maxTileRow: 0, minTileCol: 0, maxTileCol: 0 },
                { matrixId: '1', minTileRow: 0, maxTileRow: 1, minTileCol: 0, maxTileCol: 1 },
            ],
        })
        const addressCodec = webMercatorQuadAddressCodec({ coverage, coordinateBits: 42 })
        const profile = webMercatorPlanarTileSpatialProfile({ addressCodec })
        const tile = WebMercatorQuad.tile({ matrixId: '1', tileRow: 1, tileCol: 1 })

        expect(profile.coverage).to.equal(coverage)
        expect(profile.coordinateBits).to.equal(addressCodec.coordinateBits)
        expect(profile.tileBounds(tile)).to.deep.equal(WebMercatorQuad.tileBounds(tile).projected)
        expect(profile.encodeCamera([ 0, 0 ])).to.deep.equal({
            low: [
                addressCodec.fromProjected([ 0, 0 ]).fixed.limbs[0].low,
                addressCodec.fromProjected([ 0, 0 ]).fixed.limbs[1].low,
            ],
            high: [
                addressCodec.fromProjected([ 0, 0 ]).fixed.limbs[0].high,
                addressCodec.fromProjected([ 0, 0 ]).fixed.limbs[1].high,
            ],
        })
    })

    it('rejects a topology whose adjacent matrices are not regular quadtree levels', () => {

        const matrixSet = tileMatrixSet({
            id: 'invalid-quad-growth',
            crs: 'test',
            orderedAxes: [ 'x', 'y' ],
            boundingBox: { crs: 'test', lowerCorner: [ 0, 0 ], upperCorner: [ 1, 1 ] },
            tileMatrices: [
                {
                    id: 'root', scaleDenominator: 1, cellSize: 1 / 256,
                    pointOfOrigin: [ 0, 1 ], cornerOfOrigin: 'topLeft',
                    tileWidth: 256, tileHeight: 256, matrixWidth: 1, matrixHeight: 1,
                },
                {
                    id: 'bad', scaleDenominator: 0.5, cellSize: 1 / 512,
                    pointOfOrigin: [ 0, 1 ], cornerOfOrigin: 'topLeft',
                    tileWidth: 256, tileHeight: 256, matrixWidth: 3, matrixHeight: 2,
                },
            ],
        })

        expect(() => regularQuadTileTopology({ id: 'bad', tileMatrixSet: matrixSet }))
            .to.throw(GeoDiagnosticError)
    })
})
