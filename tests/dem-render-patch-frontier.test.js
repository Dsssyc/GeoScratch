import { expect } from 'chai'
import * as renderPatch from '../examples/demLayer/dem-render-patch-frontier.ts'

const {
    DEM_MAX_RENDER_EXTRA_LEVELS,
    DEM_MAX_RENDER_MATRIX_LEVEL,
} = renderPatch

describe('DEM render-patch frontier', () => {

    it('selects geometry detail from screen-space error after raster data reaches z10', () => {

        expect(DEM_MAX_RENDER_MATRIX_LEVEL).to.equal(14)
        expect(DEM_MAX_RENDER_EXTRA_LEVELS).to.equal(4)
        expect(renderPatch.demRenderPatchScreenSpaceError).to.be.a('function')
        expect(renderPatch.demRenderPatchSelectMatrixLevel).to.be.a('function')

        const view = {
            viewportHeight: 800,
            verticalFovRadians: Math.PI / 3,
            terrainSectorSize: 64,
            refineErrorPixels: 2,
        }
        expect(renderPatch.demRenderPatchSelectMatrixLevel(10, 5_000, view))
            .to.equal(14)
        expect(renderPatch.demRenderPatchSelectMatrixLevel(10, 100_000, view))
            .to.equal(12)
        expect(renderPatch.demRenderPatchSelectMatrixLevel(10, 500_000, view))
            .to.equal(10)
    })

    it('gives near and far patches different levels at one camera zoom', () => {

        const sharedView = {
            viewportHeight: 800,
            verticalFovRadians: Math.PI / 3,
            terrainSectorSize: 64,
            refineErrorPixels: 2,
        }
        const nearLevel = renderPatch.demRenderPatchSelectMatrixLevel(
            10,
            5_000,
            sharedView
        )
        const farLevel = renderPatch.demRenderPatchSelectMatrixLevel(
            10,
            500_000,
            sharedView
        )

        expect(nearLevel).to.be.greaterThan(farLevel)
        expect(renderPatch.demRenderPatchLookupCapacity(49, 4)).to.equal(32_768)
    })

    it('rejects invalid screen-space selection inputs', () => {

        expect(() => renderPatch.demRenderPatchSelectMatrixLevel(-1, 10, {}))
            .to.throw('source')
        expect(() => renderPatch.demRenderPatchSelectMatrixLevel(10, Number.NaN, {}))
            .to.throw('distance')
        expect(() => renderPatch.demRenderPatchSelectMatrixLevel(10, 10, {
            viewportHeight: 800,
            verticalFovRadians: Math.PI / 3,
            terrainSectorSize: 64,
            refineErrorPixels: 2,
        }, {
            maximumExtraLevels: 5,
        })).to.throw('extra')
        expect(() => renderPatch.demRenderPatchSelectMatrixLevel(10, 10, {
            viewportHeight: 800,
            verticalFovRadians: Math.PI / 3,
        }, {
            maximumMatrixLevel: 15,
        })).to.throw('matrix')
    })
})
