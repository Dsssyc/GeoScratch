import { expect } from 'chai'
import {
    decodeGpuWebMercatorQuadCoverFeedback,
    decodeGpuWebMercatorQuadDemandProjectionFeedback,
} from 'geoscratch/geo'

const FRAME_EPOCH = 17
const MAXIMUM_PATCHES = 64

function coverState(overrides = {}) {

    const words = [
        FRAME_EPOCH,
        32,
        0,
        0,
        0,
        0xffff_ffff,
        0,
        0,
        14,
        0xffff_ffff,
        0,
    ]
    for (const [ index, value ] of Object.entries(overrides)) words[Number(index)] = value
    return new Uint8Array(new Uint32Array(words).buffer)
}

function decodeCover(bytes) {

    return decodeGpuWebMercatorQuadCoverFeedback(bytes, {
        expectedFrameEpoch: FRAME_EPOCH,
        maximumPatches: MAXIMUM_PATCHES,
    })
}

describe('GPU WebMercatorQuad cover outcomes', () => {

    it('accepts a successful empty cut without exposing untouched range sentinels', () => {

        const facts = decodeCover(coverState())

        expect(facts).to.deep.equal({
            frameEpoch: FRAME_EPOCH,
            candidateCount: 32,
            patchCount: 0,
            descriptorOverflowCount: 0,
            lookupOverflowCount: 0,
            maximumAdjacentLevelDelta: 0,
            finestMatrixLevel: 14,
        })
        expect(Object.isFrozen(facts)).to.equal(true)
    })

    it('does not turn failed or stale empty feedback into a successful empty cut', () => {

        for (const overrides of [
            { 0: FRAME_EPOCH - 1 },
            { 3: 1 },
            { 4: 1 },
            { 7: 2 },
        ]) {
            expect(() => decodeCover(coverState(overrides))).to.throw(RangeError)
        }
    })

    it('keeps span and level validation for nonempty cuts and rejects partial failures', () => {

        const populated = { 2: 1, 5: 10, 6: 10, 9: 256, 10: 512 }
        expect(decodeCover(coverState(populated))).to.include({
            patchCount: 1,
            minimumMatrixLevel: 10,
            maximumMatrixLevel: 10,
            minimumCellSpanReferencePixels: 1,
            maximumCellSpanReferencePixels: 2,
        })
        for (const invalid of [
            { 2: MAXIMUM_PATCHES + 1 },
            { 3: 1 },
            { 4: 1 },
            { 7: 2 },
            { 5: 0xffff_ffff },
            { 5: 11 },
            { 6: 15 },
            { 9: 513 },
        ]) {
            expect(() => decodeCover(coverState({ ...populated, ...invalid })))
                .to.throw(RangeError)
        }
    })

    it('accepts empty demand projection while preserving an upstream failure marker', () => {

        const options = {
            expectedFrameEpoch: FRAME_EPOCH,
            maximumDemands: 4,
            sourceLevelCeiling: 10,
        }
        const demands = new Uint8Array(4 * 32)
        const state = overflow => new Uint8Array(new Uint32Array([
            FRAME_EPOCH, 0, overflow, 10,
        ]).buffer)

        expect(decodeGpuWebMercatorQuadDemandProjectionFeedback(
            state(0), demands, options
        )).to.deep.equal({
            frameEpoch: FRAME_EPOCH,
            demandCount: 0,
            overflowCount: 0,
            sourceLevelCeiling: 10,
            demands: [],
        })
        expect(() => decodeGpuWebMercatorQuadDemandProjectionFeedback(
            state(1), demands, options
        )).to.throw(RangeError)
    })
})
