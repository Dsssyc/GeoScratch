import { expect } from 'chai'
import {
    WebMercatorQuad,
    tileMatrixCoverage,
    virtualRasterTileAddressSpace,
    webMercatorQuadAddressCodec,
} from 'geoscratch/geo'
import {
    FLOW_CANDIDATE_RECORD_BYTES,
    packFlowCandidateCells,
} from '../examples/flowField/flow-candidate-packing.ts'

describe('Flow Field candidate packing', () => {

    it('packs exact little-endian 32-byte records in canonical world quanta', () => {

        const fixture = createFixture('9', {
            minTileRow: 200,
            maxTileRow: 201,
            minTileCol: 400,
            maxTileCol: 401,
        })
        const cells = [
            candidate(fixture, 200, 400, 0, 0, 0),
            candidate(fixture, 200, 400, 1, 0, 0),
            candidate(fixture, 200, 400, 31, 31, 0),
        ]
        const packed = packFlowCandidateCells(cells, fixture.codec, 32)
        const view = new DataView(packed.buffer, packed.byteOffset, packed.byteLength)
        const pageQuanta = fixture.codec.worldQuanta / 512n
        const step = pageQuanta / 32n
        const expectedX = 400n * pageQuanta
        const expectedY = 200n * pageQuanta
        const expected = fixture.codec.fromWorldQuanta([ expectedX, expectedY ]).fixed.limbs

        expect(FLOW_CANDIDATE_RECORD_BYTES).to.equal(32)
        expect(packed.byteLength).to.equal(cells.length * 32)
        expect(view.getUint32(0, true)).to.equal(expected[0].low)
        expect(view.getUint32(4, true)).to.equal(expected[0].high)
        expect(view.getUint32(8, true)).to.equal(expected[1].low)
        expect(view.getUint32(12, true)).to.equal(expected[1].high)
        expect(view.getUint32(16, true)).to.equal(Number(step))
        expect(view.getUint32(20, true)).to.equal(0)
        expect(view.getUint32(24, true)).to.equal(0)
        expect(view.getUint32(28, true)).to.equal(0)
        expect(recordAxis(view, 1, 0) - recordAxis(view, 0, 0)).to.equal(step)
    })

    it('keeps east and south page boundaries bit-exact', () => {

        const fixture = createFixture('9', {
            minTileRow: 200,
            maxTileRow: 201,
            minTileCol: 400,
            maxTileCol: 401,
        })
        const packed = packFlowCandidateCells([
            candidate(fixture, 200, 400, 31, 0, 0),
            candidate(fixture, 200, 401, 0, 0, 0),
            candidate(fixture, 200, 400, 0, 31, 0),
            candidate(fixture, 201, 400, 0, 0, 0),
        ], fixture.codec, 32)
        const view = new DataView(packed.buffer, packed.byteOffset, packed.byteLength)
        const step = BigInt(view.getUint32(16, true))

        expect(recordAxis(view, 0, 0) + step).to.equal(recordAxis(view, 1, 0))
        expect(recordAxis(view, 2, 1) + step).to.equal(recordAxis(view, 3, 1))
    })

    it('rejects invalid grids, cells, pages, levels, and non-u32 quanta steps', () => {

        const fixture = createFixture('9', {
            minTileRow: 200,
            maxTileRow: 200,
            minTileCol: 400,
            maxTileCol: 400,
        })
        const valid = candidate(fixture, 200, 400, 0, 0, 0)
        for (const cellsPerPageEdge of [ 0, 3, 257 ]) {
            expect(() => packFlowCandidateCells([ valid ], fixture.codec, cellsPerPageEdge))
                .to.throw(TypeError)
        }
        expect(() => packFlowCandidateCells([
            { ...valid, cellX: 32 },
        ], fixture.codec, 32)).to.throw(RangeError)
        expect(() => packFlowCandidateCells([
            { ...valid, cellY: -1 },
        ], fixture.codec, 32)).to.throw(RangeError)
        expect(() => packFlowCandidateCells([
            { ...valid, requestedLevel: 1 },
        ], fixture.codec, 32)).to.throw(RangeError)
        expect(() => packFlowCandidateCells([
            { ...valid, page: { ...valid.page, level: valid.page.level + 1 } },
        ], fixture.codec, 32)).to.throw(TypeError)
        const foreignTile = Object.freeze({
            ...valid.page.tile,
            tileCol: valid.page.tile.tileCol + 1,
            key: `9/${valid.page.tile.tileRow}/${valid.page.tile.tileCol + 1}`,
        })
        expect(() => packFlowCandidateCells([ {
            ...valid,
            page: {
                ...valid.page,
                key: foreignTile.key,
                coordinates: [ foreignTile.tileCol, foreignTile.tileRow ],
                tile: foreignTile,
            },
        } ], fixture.codec, 32)).to.throw(TypeError)

        const coarse = createFixture('4', {
            minTileRow: 6,
            maxTileRow: 6,
            minTileCol: 13,
            maxTileCol: 13,
        })
        expect(() => packFlowCandidateCells([
            candidate(coarse, 6, 13, 0, 0, 0),
        ], coarse.codec, 16)).to.throw(RangeError)
        expect(() => packFlowCandidateCells([
            candidate(coarse, 6, 13, 0, 0, 0),
        ], coarse.codec, 32)).to.throw(RangeError)
    })

    it('preserves internal levels independently from z8/z9 page identity', () => {

        const fixture = createMultiLevelFixture()
        const finest = candidateAtMatrix(fixture, '9', 210, 428, 0)
        const parent = candidateAtMatrix(fixture, '8', 105, 214, 1)
        const packed = packFlowCandidateCells([ finest, parent ], fixture.codec, 32)
        const view = new DataView(packed.buffer, packed.byteOffset, packed.byteLength)

        expect(finest.page.level).to.equal(0)
        expect(parent.page.level).to.equal(1)
        expect(view.getUint32(20, true)).to.equal(0)
        expect(view.getUint32(52, true)).to.equal(1)
        expect(view.getUint32(48, true)).to.equal(view.getUint32(16, true) * 2)
    })

    it('matches canonical BigInt encoding across complete coarse and fine page grids', () => {

        const coverage = tileMatrixCoverage({
            tileMatrixSet: WebMercatorQuad,
            limits: [
                { matrixId: '4', minTileRow: 6, maxTileRow: 7, minTileCol: 13, maxTileCol: 14 },
                { matrixId: '10', minTileRow: 400, maxTileRow: 401, minTileCol: 850, maxTileCol: 851 },
            ],
        })
        const codec = webMercatorQuadAddressCodec({ coverage, coordinateBits: 40 })
        const addressSpace = virtualRasterTileAddressSpace({ id: 'flow-packing-batch', coverage })
        const cells = []
        for (const limit of coverage.limits) {
            for (let tileRow = limit.minTileRow; tileRow <= limit.maxTileRow; tileRow++) {
                for (let tileCol = limit.minTileCol; tileCol <= limit.maxTileCol; tileCol++) {
                    const page = addressSpace.pageFromTile({
                        matrixId: limit.matrixId, tileRow, tileCol,
                    })
                    for (let cellY = 0; cellY < 64; cellY++) {
                        for (let cellX = 0; cellX < 64; cellX++) {
                            cells.push({ page, cellX, cellY, requestedLevel: (cellX + cellY) % 2 })
                        }
                    }
                }
            }
        }
        let originEncodings = 0
        const countedCodec = {
            coverage,
            worldQuanta: codec.worldQuanta,
            fromWorldQuanta(values) {
                originEncodings++
                return codec.fromWorldQuanta(values)
            },
        }
        const packed = packFlowCandidateCells(cells, countedCodec, 64)
        const expected = canonicalPackedCells(cells, codec, 64)

        expect(packed).to.deep.equal(expected)
        expect(originEncodings).to.equal(8)
        // z4 cells cross the u32 low limb many times within each page.
        const view = new DataView(packed.buffer)
        expect(view.getUint32(4 * 32 + 4, true)).to.equal(view.getUint32(4, true) + 1)
    })

    it('validates each cell and distinct page object even after preparing its page identity', () => {

        const fixture = createMultiLevelFixture()
        const valid = candidateAtMatrix(fixture, '9', 210, 428, 0)
        for (const invalid of [
            { ...valid, requestedLevel: 2 },
            { ...valid, cellX: 64 },
            { ...valid, cellY: 0.5 },
        ]) {
            expect(() => packFlowCandidateCells([ valid, invalid ], fixture.codec, 64))
                .to.throw(RangeError)
        }
        const forged = { ...valid, page: { ...valid.page, dimensions: 3 } }
        expect(() => packFlowCandidateCells([ valid, forged ], fixture.codec, 64))
            .to.throw(TypeError)
    })
})

function canonicalPackedCells(cells, codec, cellsPerPageEdge) {

    const output = new Uint8Array(cells.length * FLOW_CANDIDATE_RECORD_BYTES)
    const view = new DataView(output.buffer)
    for (let index = 0; index < cells.length; index++) {
        const cell = cells[index]
        const tile = cell.page.tile
        const pageQuanta = codec.worldQuanta /
            BigInt(WebMercatorQuad.matrix(tile.matrixId).matrixWidth)
        const step = pageQuanta / BigInt(cellsPerPageEdge)
        const origin = codec.fromWorldQuanta([
            BigInt(tile.tileCol) * pageQuanta + BigInt(cell.cellX) * step,
            BigInt(tile.tileRow) * pageQuanta + BigInt(cell.cellY) * step,
        ]).fixed.limbs
        const offset = index * FLOW_CANDIDATE_RECORD_BYTES
        for (let axis = 0; axis < 2; axis++) {
            view.setUint32(offset + axis * 8, origin[axis].low, true)
            view.setUint32(offset + axis * 8 + 4, origin[axis].high, true)
        }
        view.setUint32(offset + 16, Number(step), true)
        view.setUint32(offset + 20, cell.requestedLevel, true)
    }
    return output
}

function createFixture(matrixId, bounds) {

    const coverage = tileMatrixCoverage({
        tileMatrixSet: WebMercatorQuad,
        limits: [ { matrixId, ...bounds } ],
    })
    const addressSpace = virtualRasterTileAddressSpace({
        id: `flow-candidate-${matrixId}-${bounds.minTileRow}-${bounds.minTileCol}`,
        coverage,
    })
    return {
        codec: webMercatorQuadAddressCodec({ coverage, coordinateBits: 40 }),
        addressSpace,
    }
}

function createMultiLevelFixture() {

    const coverage = tileMatrixCoverage({
        tileMatrixSet: WebMercatorQuad,
        limits: [
            {
                matrixId: '8',
                minTileRow: 105,
                maxTileRow: 105,
                minTileCol: 214,
                maxTileCol: 214,
            },
            {
                matrixId: '9',
                minTileRow: 210,
                maxTileRow: 210,
                minTileCol: 428,
                maxTileCol: 428,
            },
        ],
    })
    return {
        codec: webMercatorQuadAddressCodec({ coverage, coordinateBits: 40 }),
        addressSpace: virtualRasterTileAddressSpace({ id: 'flow-candidate-z8-z9', coverage }),
    }
}

function candidate(fixture, tileRow, tileCol, cellX, cellY, requestedLevel) {

    return Object.freeze({
        page: fixture.addressSpace.pageFromTile({
            matrixId: fixture.codec.coverage.limits[0].matrixId,
            tileRow,
            tileCol,
        }),
        requestedLevel,
        cellX,
        cellY,
    })
}

function candidateAtMatrix(fixture, matrixId, tileRow, tileCol, requestedLevel) {

    return Object.freeze({
        page: fixture.addressSpace.pageFromTile({ matrixId, tileRow, tileCol }),
        requestedLevel,
        cellX: 0,
        cellY: 0,
    })
}

function recordAxis(view, record, axis) {

    const offset = record * 32 + axis * 8
    return BigInt(view.getUint32(offset, true)) |
        BigInt(view.getUint32(offset + 4, true)) << 32n
}
