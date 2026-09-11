import { expect } from 'chai'
import { createLayoutReadbackView } from 'geoscratch/scratch'
import {
    GeoDiagnosticError, WebMercatorQuad, tileMatrixCoverage,
    webMercatorVirtualRasterField, prepareWebMercatorVirtualRasterSampler,
} from 'geoscratch/geo'

describe('WebMercator raster sampler metadata', () => {

    it('directly maps sparse matrix ids to compact row-major page table addresses', () => {
        const model = field(['4', '6', '9'])
        const prepared = prepareWebMercatorVirtualRasterSampler(model)
        const data = decode(prepared)
        expect(data.dimensions).to.deep.equal([3, 256, 256, 40])
        for (let matrix = 0; matrix <= 24; matrix++) {
            const index = data.levelForMatrix[Math.floor(matrix / 4)][matrix % 4]
            const limit = model.coverage.limit(String(matrix))
            if (!limit) { expect(index).to.equal(0xffff_ffff); continue }
            const entry = data.levels[index]
            expect(entry.mapping[0]).to.equal(matrix)
            for (let row = limit.minTileRow; row <= limit.maxTileRow; row++) {
                for (let col = limit.minTileCol; col <= limit.maxTileCol; col++) {
                    expect(entry.mapping[1] + (row - entry.tileBounds[1]) * entry.mapping[2] + col - entry.tileBounds[0])
                        .to.equal(model.coverage.index({matrixId: String(matrix), tileRow: row, tileCol: col}))
                }
            }
            const half = BigInt(entry.halfTexel[0]) + (BigInt(entry.halfTexel[1]) << 32n)
            expect(half).to.equal(1n << BigInt(40 - matrix - 9))
        }
        expect(data.levels.slice(3).every(value => value.mapping[3] === 0)).to.equal(true)
    })

    it('keeps one uniform ABI across different source coverage and returns owned byte copies', () => {
        const a = prepareWebMercatorVirtualRasterSampler(field(['4', '5', '6']))
        const b = prepareWebMercatorVirtualRasterSampler(field(['2', '7']))
        expect(a.layout).to.equal(b.layout)
        expect(a.pack().byteLength).to.equal(1808)
        expect(b.pack().byteLength).to.equal(a.pack().byteLength)
        const bytes = a.pack(), original = a.pack()
        bytes.fill(0)
        expect(a.pack()).to.deep.equal(original)
        expect(Object.isFrozen(a)).to.equal(true)
    })

    it('packs decoding facts and represents the eastern world edge without wrapping it to zero', () => {
        const model = field(['0'], {bounds: [-180, -80, 180, 80], sampleType: 'unorm8',
            channels: 1, fieldKind: 'scalar', gpuFormat: 'r8unorm', noData: 255, scale: 2, offset: -4})
        const data = decode(prepareWebMercatorVirtualRasterSampler(model))
        expect(data.decoding).to.deep.equal([255, 2, 255, 0])
        expect(data.scale).to.deep.equal([2, 2, 2, 2])
        expect(data.offset).to.deep.equal([-4, -4, -4, -4])
        expect(data.sourceEastSouth.slice(0, 2)).to.deep.equal([0, 256])
        expect(data.levels[0].texelBounds[2]).to.equal(255)
    })

    it('rejects mixed source address-space ownership with a structured diagnostic', () => {
        const a = field(['4']), b = field(['5'])
        try { prepareWebMercatorVirtualRasterSampler({...a, plane: b.plane}) }
        catch (error) {
            expect(error).to.be.instanceOf(GeoDiagnosticError)
            expect(error.diagnostic.code).to.equal('GEO_RASTER_SAMPLER_METADATA_INVALID')
            return
        }
        throw new Error('Mixed model was accepted')
    })
})

function decode(prepared) {
    return createLayoutReadbackView(prepared.layout.artifact, prepared.pack()).toObject()
}

function field(matrices, options = {}) {
    const bounds = options.bounds ?? [0, -2, 3, 2]
    const limits = matrices.map(matrixId => {
        const first = WebMercatorQuad.tileFromLonLat([bounds[0], bounds[3]], matrixId)
        const last = WebMercatorQuad.tileFromLonLat([bounds[2] === 180 ? 179.99 : bounds[2], bounds[1]], matrixId)
        return {matrixId, minTileRow: first.tileRow, maxTileRow: last.tileRow,
            minTileCol: first.tileCol, maxTileCol: last.tileCol}
    })
    return webMercatorVirtualRasterField({
        id: 'sampler', addressSpaceId: 'sampler.' + matrices.join('-'), sourceRevision: '1',
        coverage: tileMatrixCoverage({tileMatrixSet: WebMercatorQuad, limits}), geographicBounds: bounds,
        fieldKind: 'vector', channels: 2, sampleType: 'float32', gpuFormat: 'rg32float',
        interpolation: 'linear', ...options,
    })
}
