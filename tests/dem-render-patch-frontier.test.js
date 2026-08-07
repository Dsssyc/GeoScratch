import { expect } from 'chai'
import * as renderPatch from '../examples/demLayer/dem-render-patch-frontier.ts'

const {
    DEM_MAX_RENDER_EXTRA_LEVELS,
    DEM_MAX_RENDER_MATRIX_LEVEL,
    DEM_RENDER_PATCH_MAXIMUM_CELL_SPAN_PIXELS,
    DEM_RENDER_PATCH_NOMINAL_SPAN_PIXELS,
} = renderPatch

describe('DEM render-patch frontier', () => {

    it('selects geometry detail from projected grid spacing after raster data reaches z10', () => {

        expect(DEM_MAX_RENDER_MATRIX_LEVEL).to.equal(14)
        expect(DEM_MAX_RENDER_EXTRA_LEVELS).to.equal(4)
        expect(DEM_RENDER_PATCH_MAXIMUM_CELL_SPAN_PIXELS).to.equal(8)
        expect(DEM_RENDER_PATCH_NOMINAL_SPAN_PIXELS).to.equal(512)
        expect(renderPatch.demRenderPatchProjectedCellSpan).to.be.a('function')
        expect(renderPatch.demRenderPatchSelectMatrixLevel).to.be.a('function')

        const policy = {
            terrainSectorSize: 64,
            maximumCellSpanPixels: 8,
        }
        expect(renderPatch.demRenderPatchSelectMatrixLevel(10, {
            widthPixels: 1_780,
            heightPixels: 1_780,
        }, policy))
            .to.equal(12)
        expect(renderPatch.demRenderPatchSelectMatrixLevel(10, {
            widthPixels: 235,
            heightPixels: 235,
        }, policy))
            .to.equal(10)
    })

    it('uses projected area so perspective-foreshortened patches stay coarser', () => {

        const policy = {
            terrainSectorSize: 64,
            maximumCellSpanPixels: 8,
        }
        const squareLevel = renderPatch.demRenderPatchSelectMatrixLevel(10, {
            widthPixels: 1_780,
            heightPixels: 1_780,
        }, policy)
        const foreshortenedLevel = renderPatch.demRenderPatchSelectMatrixLevel(10, {
            widthPixels: 1_780,
            heightPixels: 200,
        }, policy)

        expect(squareLevel).to.equal(12)
        expect(foreshortenedLevel).to.equal(11)
        expect(squareLevel).to.be.greaterThan(foreshortenedLevel)
        expect(renderPatch.demRenderPatchProjectedCellSpan({
            widthPixels: 1_780,
            heightPixels: 200,
            terrainSectorSize: 64,
        })).to.be.closeTo(Math.sqrt(1_780 * 200) / 64, 1e-12)
        expect(renderPatch.demRenderPatchLookupCapacity(49, 4)).to.equal(32_768)
    })

    it('decodes bounded delayed GPU selection facts', () => {

        const words = new Uint32Array([
            384,
            0,
            0,
            10,
            12,
            3 * 256,
            8 * 256,
            41,
        ])
        const facts = renderPatch.decodeDemRenderPatchState(
            new Uint8Array(words.buffer),
            { maximumRenderPatches: 12_544, expectedFrameEpoch: 41 }
        )

        expect(facts).to.deep.equal({
            selectedPatchCount: 384,
            descriptorOverflowCount: 0,
            lookupOverflowCount: 0,
            minimumMatrixLevel: 10,
            maximumMatrixLevel: 12,
            minimumCellSpanPixels: 3,
            maximumCellSpanPixels: 8,
            frameEpoch: 41,
        })
    })

    it('rejects invalid projected-grid selection inputs', () => {

        expect(() => renderPatch.demRenderPatchSelectMatrixLevel(-1, {
            widthPixels: 10,
            heightPixels: 10,
        }, {}))
            .to.throw('source')
        expect(() => renderPatch.demRenderPatchSelectMatrixLevel(10, {
            widthPixels: Number.NaN,
            heightPixels: 10,
        }, {})).to.throw('projected')
        expect(() => renderPatch.demRenderPatchSelectMatrixLevel(10, {
            widthPixels: 10,
            heightPixels: 10,
        }, {
            terrainSectorSize: 64,
            maximumCellSpanPixels: 8,
        }, {
            maximumExtraLevels: 5,
        })).to.throw('extra')
        expect(() => renderPatch.demRenderPatchSelectMatrixLevel(10, {
            widthPixels: 10,
            heightPixels: 10,
        }, {
            maximumCellSpanPixels: 8,
        }, {
            maximumMatrixLevel: 15,
        })).to.throw('matrix')
        expect(() => renderPatch.decodeDemRenderPatchState(
            new Uint8Array(32),
            { maximumRenderPatches: 12_544, expectedFrameEpoch: 9 }
        )).to.throw('frame epoch')
    })
})
