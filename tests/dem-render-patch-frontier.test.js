import { expect } from 'chai'
import * as renderPatch from '../examples/demLayer/dem-render-patch-frontier.ts'

const {
    DEM_MAX_RENDER_EXTRA_LEVELS,
    DEM_MAX_RENDER_MATRIX_LEVEL,
    DEM_RENDER_PATCH_MAXIMUM_CELL_SPAN_PIXELS,
    DEM_RENDER_PATCH_NOMINAL_SPAN_PIXELS,
} = renderPatch

describe('DEM render-patch frontier', () => {

    it('derives a pitch-aware frame budget from the nominal viewport cover', () => {

        expect(renderPatch.demRenderPatchFrameBudget).to.be.a('function')
        expect(renderPatch.demRenderPatchFrameBudget({
            viewport: [ 1024, 768 ],
            cameraPitchRadians: 0,
        })).to.deep.equal({
            baselinePatchBudget: 9,
            framePatchBudget: 9,
        })
        expect(renderPatch.demRenderPatchFrameBudget({
            viewport: [ 1024, 768 ],
            cameraPitchRadians: Math.PI / 3,
        })).to.deep.equal({
            baselinePatchBudget: 9,
            framePatchBudget: 23,
        })
        expect(renderPatch.demRenderPatchFrameBudget({
            viewport: [ 1024, 768 ],
            cameraPitchRadians: Math.PI / 2,
            maximumRenderPatches: 20,
        })).to.deep.equal({
            baselinePatchBudget: 9,
            framePatchBudget: 20,
        })
    })

    it('chooses the finest complete cut inside budget with bounded hysteresis', () => {

        expect(renderPatch.demRenderPatchSelectBudgetBias).to.be.a('function')
        expect(renderPatch.demRenderPatchSelectBudgetBias(
            [ 80, 52, 27, 8 ],
            30,
            0
        )).to.equal(2)
        expect(renderPatch.demRenderPatchSelectBudgetBias(
            [ 29, 23, 8 ],
            30,
            1
        )).to.equal(1)
        expect(renderPatch.demRenderPatchSelectBudgetBias(
            [ 18, 17, 16, 15 ],
            18,
            3
        )).to.equal(0)
        expect(renderPatch.demRenderPatchSelectBudgetBias(
            [ 50, 31, 28 ],
            30,
            1
        )).to.equal(2)
        expect(renderPatch.demRenderPatchSelectBudgetBias(
            [ 80, 52, 40 ],
            30,
            0
        )).to.equal(2)
        expect(renderPatch.demRenderPatchSelectBudgetBias(
            [ 9, 9, 9, 9, 9, 6, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3 ],
            31,
            0
        )).to.equal(0)
        expect(renderPatch.demRenderPatchSelectBudgetBias(
            [ 50, 40, 32, 35 ],
            30,
            0
        )).to.equal(2)
    })

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

        const words = new Uint32Array(30)
        words.set([
            20,
            0,
            0,
            10,
            12,
            3 * 256,
            8 * 256,
            41,
            9,
            23,
            80,
            3,
            8,
        ])
        words.set([
            80, 52, 27, 20, 18, 16, 14, 12, 11,
            10, 9, 9, 8, 8, 8, 8, 8,
        ], 13)
        const facts = renderPatch.decodeDemRenderPatchState(
            new Uint8Array(words.buffer),
            { maximumRenderPatches: 12_544, expectedFrameEpoch: 41 }
        )

        expect(facts).to.deep.equal({
            selectedPatchCount: 20,
            descriptorOverflowCount: 0,
            lookupOverflowCount: 0,
            minimumMatrixLevel: 10,
            maximumMatrixLevel: 12,
            minimumCellSpanPixels: 3,
            maximumCellSpanPixels: 8,
            frameEpoch: 41,
            baselinePatchBudget: 9,
            framePatchBudget: 23,
            requestedPatchCount: 80,
            minimumTrialPatchCount: 8,
            sourceRootPatchCount: 8,
            selectedBiasStep: 3,
            selectedBiasLevels: 0.75,
            budgetLimitedByMinimumTrial: false,
        })
    })

    it('accepts a non-monotonic complete-cut series and reports its actual minimum', () => {

        const words = new Uint32Array(30)
        words.set([
            9,
            0,
            0,
            8,
            11,
            1 * 256,
            65_535 * 256,
            17,
            12,
            31,
            9,
            0,
            2,
        ])
        words.set([
            9, 9, 9, 9, 9, 6, 2, 2, 2,
            2, 2, 2, 2, 2, 2, 2, 3,
        ], 13)

        const facts = renderPatch.decodeDemRenderPatchState(
            new Uint8Array(words.buffer),
            { maximumRenderPatches: 12_544, expectedFrameEpoch: 17 }
        )

        expect(facts).to.deep.include({
            selectedPatchCount: 9,
            requestedPatchCount: 9,
            selectedBiasStep: 0,
            minimumTrialPatchCount: 2,
            sourceRootPatchCount: 3,
            budgetLimitedByMinimumTrial: false,
        })
        expect(facts).not.to.have.property('sourceFloorPatchCount')
        expect(facts).not.to.have.property('budgetLimitedBySourceFloor')
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
            new Uint8Array(120),
            { maximumRenderPatches: 12_544, expectedFrameEpoch: 9 }
        )).to.throw('frame epoch')
    })
})
