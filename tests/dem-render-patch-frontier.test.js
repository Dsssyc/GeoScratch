import { expect } from 'chai'
import {
    DEM_MAX_RENDER_EXTRA_LEVELS,
    DEM_MAX_RENDER_MATRIX_LEVEL,
    demRenderPatchTargetMatrixLevel,
} from '../examples/demLayer/dem-render-patch-frontier.ts'

describe('DEM render-patch frontier', () => {

    it('continues geometry refinement after raster data reaches z10', () => {

        expect(DEM_MAX_RENDER_MATRIX_LEVEL).to.equal(14)
        expect(DEM_MAX_RENDER_EXTRA_LEVELS).to.equal(4)
        expect([ 10, 11, 12, 13, 14 ].map(zoomHint => (
            demRenderPatchTargetMatrixLevel(10, zoomHint)
        ))).to.deep.equal([ 10, 11, 12, 13, 14 ])
        expect(demRenderPatchTargetMatrixLevel(10, 18)).to.equal(14)
    })

    it('keeps expansion bounded and preserves distance-driven source degradation', () => {

        expect(demRenderPatchTargetMatrixLevel(9, 14)).to.equal(13)
        expect(demRenderPatchTargetMatrixLevel(8, 14)).to.equal(12)
        expect(demRenderPatchTargetMatrixLevel(4, 14)).to.equal(8)
        expect(demRenderPatchTargetMatrixLevel(10, 8)).to.equal(10)
    })

    it('rejects invalid source and view levels', () => {

        expect(() => demRenderPatchTargetMatrixLevel(-1, 10)).to.throw('source')
        expect(() => demRenderPatchTargetMatrixLevel(10, Number.NaN)).to.throw('zoom')
        expect(() => demRenderPatchTargetMatrixLevel(10, 14, {
            maximumExtraLevels: 5,
        })).to.throw('extra')
    })
})
