import { expect } from 'chai'
import {
    GeoDiagnosticError,
    decodeGpuRenderPatchState,
} from 'geoscratch/geo'

describe('Geo GPU render-patch frontier', () => {

    it('decodes bounded delayed GPU selection facts', () => {

        const words = new Uint32Array(35)
        words.set([
            23,
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
        words.set([
            20,
            1,
            1,
            14,
            23,
        ], 30)
        const facts = decodeGpuRenderPatchState(
            new Uint8Array(words.buffer),
            { maximumRenderPatches: 12_544, expectedFrameEpoch: 41 }
        )

        expect(facts).to.deep.equal({
            selectedPatchCount: 23,
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
            unbalancedPatchCount: 20,
            balanceSplitCount: 1,
            balanceOverheadPatchCount: 3,
            maximumAdjacentLevelDelta: 1,
            balancePassCount: 14,
        })
    })

    it('accepts a non-monotonic complete-cut series and reports its actual minimum', () => {

        const words = new Uint32Array(35)
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
        words.set([ 9, 0, 1, 14, 9 ], 30)

        const facts = decodeGpuRenderPatchState(
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
            unbalancedPatchCount: 9,
            balanceSplitCount: 0,
            balanceOverheadPatchCount: 0,
            maximumAdjacentLevelDelta: 1,
            balancePassCount: 14,
        })
        expect(facts).not.to.have.property('sourceFloorPatchCount')
        expect(facts).not.to.have.property('budgetLimitedBySourceFloor')
    })

    it('rejects feedback from a different frame epoch', () => {

        expect(() => decodeGpuRenderPatchState(
            new Uint8Array(140),
            { maximumRenderPatches: 12_544, expectedFrameEpoch: 9 }
        )).to.throw(GeoDiagnosticError, 'frame epoch')
    })

    it('rejects a final render cut whose adjacent patch levels differ by more than one', () => {

        const words = new Uint32Array(35)
        words.set([
            4,
            0,
            0,
            8,
            10,
            2 * 256,
            8 * 256,
            7,
            9,
            12,
            4,
            0,
            4,
        ])
        words.fill(4, 13, 30)
        words.set([ 4, 0, 2, 14, 4 ], 30)

        expect(() => decodeGpuRenderPatchState(
            new Uint8Array(words.buffer),
            { maximumRenderPatches: 12_544, expectedFrameEpoch: 7 }
        )).to.throw('level-difference-one')
    })
})
