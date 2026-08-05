import { expect } from 'chai'
import {
    GeoDiagnosticError,
    WebMercatorQuad,
    tileMatrixCoverage,
    virtualRasterTileAddressSpace,
    webMercatorQuadAddressCodec,
} from 'geoscratch/geo'

describe('OGC WebMercatorQuad public contract', () => {

    it('publishes standard matrix facts instead of a local raster pyramid', async() => {

        const matrix = WebMercatorQuad.matrix('3')

        expect(WebMercatorQuad).to.deep.include({
            id: 'WebMercatorQuad',
            crs: 'http://www.opengis.net/def/crs/EPSG/0/3857',
            orderedAxes: [ 'X', 'Y' ],
            wellKnownScaleSet: 'http://www.opengis.net/def/wkss/OGC/1.0/GoogleMapsCompatible',
        })
        expect(matrix).to.deep.include({
            id: '3',
            scaleDenominator: 69885283.0035897,
            cellSize: 19567.8792410051,
            pointOfOrigin: [ -20037508.3427892, 20037508.3427892 ],
            tileWidth: 256,
            tileHeight: 256,
            matrixWidth: 8,
            matrixHeight: 8,
        })
    })

    it('maps finite global coverage into compact deterministic indices', async() => {

        const coverage = tileMatrixCoverage({
            tileMatrixSet: WebMercatorQuad,
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

    it('clamps latitude, wraps longitude, and grows rows southward', () => {

        expect(WebMercatorQuad.project([ 0, 0 ])).to.deep.equal([ 0, 0 ])
        expect(WebMercatorQuad.tileFromLonLat([ -180, 0 ], '2')).to.deep.include({
            tileRow: 2,
            tileCol: 0,
        })
        expect(WebMercatorQuad.tileFromLonLat([ 180, 0 ], '2')).to.deep.include({
            tileRow: 2,
            tileCol: 0,
        })
        expect(WebMercatorQuad.tileFromLonLat([ 540, 0 ], '2')).to.deep.include({
            tileRow: 2,
            tileCol: 0,
        })
        expect(WebMercatorQuad.tileFromLonLat([ 0, 90 ], '2').tileRow).to.equal(0)
        expect(WebMercatorQuad.tileFromLonLat([ 0, -90 ], '2').tileRow).to.equal(3)
        expect(WebMercatorQuad.tileFromLonLat([ 0, 45 ], '5').tileRow)
            .to.be.lessThan(WebMercatorQuad.tileFromLonLat([ 0, -45 ], '5').tileRow)
        const restored = WebMercatorQuad.unproject(WebMercatorQuad.project([ 121.5, 31.2 ]))
        expect(restored[0]).to.be.closeTo(121.5, 1e-10)
        expect(restored[1]).to.be.closeTo(31.2, 1e-10)
        expect(WebMercatorQuad.tileBounds(WebMercatorQuad.tile({
            matrixId: '0',
            tileRow: 0,
            tileCol: 0,
        })).geographic).to.deep.include({ west: -180, east: 180 })
    })

    it('validates sparse limits, reverses compact indices, and resolves covered parents', () => {

        const coverage = fixtureCoverage()
        expect(coverage.coordinate(0)).to.deep.include({
            matrixId: '8',
            tileRow: 101,
            tileCol: 212,
        })
        expect(coverage.coordinate(59)).to.deep.include({
            matrixId: '9',
            tileRow: 207,
            tileCol: 431,
        })
        expect(coverage.parent({ matrixId: '9', tileRow: 202, tileCol: 424 }))
            .to.deep.include({ matrixId: '8', tileRow: 101, tileCol: 212 })
        expect(coverage.contains({ matrixId: '9', tileRow: 201, tileCol: 424 }))
            .to.equal(false)
        expect(coverage.contains({ matrixId: '9', tileRow: 202.5, tileCol: 424 }))
            .to.equal(false)
        expect(() => coverage.index({ matrixId: '9', tileRow: 202.5, tileCol: 424 }))
            .to.throw(GeoDiagnosticError)
        expect(() => coverage.index({ matrixId: '9', tileRow: 201, tileCol: 424 }))
            .to.throw(GeoDiagnosticError)
        expect(() => tileMatrixCoverage({
            tileMatrixSet: WebMercatorQuad,
            limits: [
                { matrixId: '8', minTileRow: 3, maxTileRow: 2, minTileCol: 0, maxTileCol: 0 },
            ],
        })).to.throw(GeoDiagnosticError)
    })

    it('keeps canonical positions compact and expands sample addresses transiently', () => {

        const coverage = fixtureCoverage()
        const codec = webMercatorQuadAddressCodec({ coverage, coordinateBits: 40 })
        const shift = 40n - 16n
        const position = codec.fromWorldQuanta([
            BigInt(212 * 256) << shift,
            BigInt(101 * 256) << shift,
        ])
        const address = codec.address(position, '8')

        expect(codec.bytesPerPosition).to.equal(16)
        expect(codec.quantumMeters).to.be.lessThan(0.001)
        expect(position).to.have.keys([ 'kind', 'tileMatrixSetId', 'coordinateBits', 'fixed' ])
        expect(JSON.stringify(position)).to.not.match(/tileRow|tileCol|texel|subTexel|matrixId/)
        expect(address).to.deep.include({
            kind: 'web-mercator-tile-sample-address',
            covered: true,
            compactIndex: 0,
            texel: [ 0, 0 ],
            subTexel: [ 0, 0 ],
        })
        expect(address.tile).to.deep.include({ matrixId: '8', tileRow: 101, tileCol: 212 })
        const impostorCoverage = tileMatrixCoverage({
            tileMatrixSet: Object.freeze({ ...WebMercatorQuad }),
            limits: [
                { matrixId: '8', minTileRow: 101, maxTileRow: 101,
                    minTileCol: 212, maxTileCol: 212 },
            ],
        })
        expect(() => webMercatorQuadAddressCodec({ coverage: impostorCoverage }))
            .to.throw(GeoDiagnosticError)
    })

    it('uses global standard tiles as compact virtual page identities', () => {

        const coverage = fixtureCoverage()
        const addressSpace = virtualRasterTileAddressSpace({
            id: 'web-mercator-height',
            coverage,
        })
        const detail = addressSpace.pageFromTile({
            matrixId: '9',
            tileRow: 202,
            tileCol: 424,
        })

        expect(addressSpace.pageTableEntryCount).to.equal(coverage.entryCount)
        expect(addressSpace.levelCount).to.equal(2)
        expect(addressSpace.matrixId(0)).to.equal('9')
        expect(addressSpace.matrixId(1)).to.equal('8')
        expect(detail).to.deep.include({
            level: 0,
            coordinates: [ 424, 202 ],
            key: '9/202/424',
        })
        expect(detail.tile).to.deep.include({
            tileMatrixSetId: 'WebMercatorQuad',
            matrixId: '9',
            tileRow: 202,
            tileCol: 424,
        })
        expect(addressSpace.tableIndex(detail)).to.equal(coverage.index(detail.tile))
        expect(addressSpace.parent(detail)).to.deep.include({
            level: 1,
            key: '8/101/212',
        })
        expect(addressSpace.pages()).to.have.length(coverage.entryCount)
        expect(addressSpace.pages().map(page => page.key)).to.deep.equal(
            coverage.limits.slice().reverse().flatMap(limit => {
                const keys = []
                for (let row = limit.minTileRow; row <= limit.maxTileRow; row++) {
                    for (let col = limit.minTileCol; col <= limit.maxTileCol; col++) {
                        keys.push(`${limit.matrixId}/${row}/${col}`)
                    }
                }
                return keys
            })
        )
    })

    it('matches WGSL limb addressing at tile, texel, antimeridian, and carry boundaries', () => {

        const coverage = fixtureCoverage()
        const codec = webMercatorQuadAddressCodec({ coverage, coordinateBits: 40 })
        const world = 1n << 40n
        const vectors = [
            [ 0n, 0n ],
            [ world / 2n, world / 2n ],
            [ (BigInt(212 * 256 + 17) << 24n) + 12345n,
                (BigInt(101 * 256 + 255) << 24n) + 16_777_215n ],
            [ -1n, world - 1n ],
        ]
        for (const quanta of vectors) {
            const position = codec.fromWorldQuanta(quanta)
            for (const matrixId of [ '0', '8', '9', '24' ]) {
                const cpu = codec.address(position, matrixId)
                const wgsl = emulateWgslAddress(codec.toWorldQuanta(position), Number(matrixId), 40)
                expect(cpu.tile.tileCol).to.equal(wgsl.tileCol)
                expect(cpu.tile.tileRow).to.equal(wgsl.tileRow)
                expect(cpu.texel).to.deep.equal(wgsl.texel)
                expect(cpu.subTexel[0]).to.be.closeTo(wgsl.subTexel[0], 2 ** -23)
                expect(cpu.subTexel[1]).to.be.closeTo(wgsl.subTexel[1], 2 ** -23)
            }
        }
        const wrapped = codec.toWorldQuanta(codec.fromWorldQuanta([ -1n, 0n ]))
        expect(wrapped).to.deep.equal([ world - 1n, 0n ])
        const borrowed = codec.advance(codec.fromWorldQuanta([ 0n, 1n ]), [ -1n, -1n ])
        expect(codec.toWorldQuanta(borrowed)).to.deep.equal([ world - 1n, 0n ])
        const carried = codec.advance(
            codec.fromWorldQuanta([ 0xffff_ffffn, world / 2n ]),
            [ 1n, 0n ],
        )
        expect(codec.toWorldQuanta(carried)).to.deep.equal([ 0x1_0000_0000n, world / 2n ])
        expect(() => codec.advance(codec.fromWorldQuanta([ 0n, 0n ]), [ 0n, -1n ]))
            .to.throw(GeoDiagnosticError)
        expect(() => codec.advanceMeters(
            codec.fromWorldQuanta([ 0n, world / 2n ]),
            [ codec.quantumMeters * 2_147_483_648, 0 ],
        )).to.throw(GeoDiagnosticError)
        const meterOrigin = codec.fromWorldQuanta([ 100n, 100n ])
        const halfQuantum = Math.fround(Math.fround(codec.quantumMeters) * 0.5)
        expect(codec.toWorldQuanta(codec.advanceMeters(
            meterOrigin,
            [ halfQuantum, -halfQuantum ],
        ))).to.deep.equal([ 100n, 100n ])
        const wgsl = codec.wgslModule({ namespace: 'ProofMercator' })
        expect(wgsl).to.include('fn ProofMercator_address(')
        expect(wgsl).to.include('fn ProofMercator_compact_index(')
        expect(wgsl).to.include('fn ProofMercator_advance_i32(')
        expect(wgsl).to.include('fn ProofMercator_advance_meters(')
        expect(wgsl).to.not.include('f64')
    })
})

function fixtureCoverage() {

    return tileMatrixCoverage({
        tileMatrixSet: WebMercatorQuad,
        limits: [
            { matrixId: '8', minTileRow: 101, maxTileRow: 103, minTileCol: 212, maxTileCol: 215 },
            { matrixId: '9', minTileRow: 202, maxTileRow: 207, minTileCol: 424, maxTileCol: 431 },
        ],
    })
}

function emulateWgslAddress(quanta, zoom, coordinateBits) {

    const subBits = coordinateBits - zoom - 8
    const shifted = quanta.map(value => Number(value >> BigInt(subBits)) >>> 0)
    const mask = subBits === 0 ? 0n : (1n << BigInt(subBits)) - 1n
    const denominator = 2 ** subBits
    return {
        tileCol: shifted[0] >>> 8,
        tileRow: shifted[1] >>> 8,
        texel: [ shifted[0] & 255, shifted[1] & 255 ],
        subTexel: quanta.map(value => Math.fround(Number(value & mask) / denominator)),
    }
}
