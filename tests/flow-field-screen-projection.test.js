import { expect } from 'chai'
import { mat4 } from 'wgpu-matrix'
import {
    WebMercatorQuad, createGeoViewSnapshot, tileMatrixCoverage, webMercatorQuadAddressCodec,
} from 'geoscratch/geo'
import { flowScreenViewValues } from '../examples/flowField/flow-screen-projection.ts'

const addressCodec = webMercatorQuadAddressCodec({
    coordinateBits: 52,
    coverage: tileMatrixCoverage({
        tileMatrixSet: WebMercatorQuad,
        limits: [ { matrixId: '4', minTileRow: 0, maxTileRow: 15, minTileCol: 0, maxTileCol: 15 } ],
    }),
})

function snapshot(matrix) {
    return createGeoViewSnapshot({
        id: 'screen-projection', clipFromRelativeWorld: matrix,
        cameraHigh: [ 13_360_000, 3_503_000, 2500 ],
        cameraLow: [ 0.125, -0.375, 0.0625 ],
        referenceViewport: [ 1280, 720 ], verticalFovRadians: Math.PI / 3,
        cameraLatitudeRadians: 0.5, cameraPitchRadians: 0.7, zoomHint: 10,
        frameEpoch: 1, residencySnapshotEpoch: 2,
    })
}

describe('Flow Field camera-relative screen sampling', () => {
    it('retains canonical camera limbs while inverting a perspective camera transform', () => {
        const matrix = mat4.multiply(
            mat4.perspective(Math.PI / 3, 1280 / 720, 1, 200_000),
            mat4.rotationX(0.7),
        )
        const view = snapshot(matrix)
        const values = flowScreenViewValues(view, addressCodec)
        const camera = addressCodec.fromProjected([ 13_360_000.125, 3_502_999.625 ]).fixed.limbs
        expect(values.cameraX).to.deep.equal([ camera[0].low, camera[0].high ])
        expect(values.cameraY).to.deep.equal([ camera[1].low, camera[1].high ])
        expect(values.cameraZ).to.deep.equal([ 2500, 0.0625 ])
        const identity = mat4.multiply(matrix, values.relativeWorldFromClip, new Float64Array(16))
        for (let i = 0; i < 16; i++) expect(identity[i]).to.be.closeTo(i % 5 === 0 ? 1 : 0, 1e-6)
        expect(Object.isFrozen(values.relativeWorldFromClip)).to.equal(true)
    })

    it('rejects a singular transform instead of displaying a fabricated position', () => {
        expect(() => flowScreenViewValues(snapshot(Array(16).fill(0)), addressCodec))
            .to.throw(TypeError, /invertible/)
    })

    it('keeps sub-millimeter camera-coordinate distinctions outside the f32 projection matrix', () => {
        const view = snapshot(mat4.identity())
        const shifted = createGeoViewSnapshot({ ...view, cameraLow: [ 0.125001, -0.375, 0.0625 ] })
        const first = flowScreenViewValues(view, addressCodec)
        const second = flowScreenViewValues(shifted, addressCodec)
        expect(first.relativeWorldFromClip).to.deep.equal(second.relativeWorldFromClip)
        expect(first.cameraX).not.to.deep.equal(second.cameraX)
        expect(first.cameraY).to.deep.equal(second.cameraY)
    })
})
