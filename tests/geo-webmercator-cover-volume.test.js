import { expect } from 'chai'
import { mat4 } from 'wgpu-matrix'
import { createGeoViewSnapshot, WebMercatorQuad, tileMatrixCoverage,
    webMercatorPlanarTileSpatialProfile, webMercatorQuadAddressCodec } from 'geoscratch/geo'
import { coverClipWCertificate } from '../packages/geoscratch/dist/geo/gpu-web-mercator-quad-cover-candidates.js'
import { evaluateGpuWebMercatorQuadCoverReference } from '../packages/geoscratch/dist/geo/gpu-web-mercator-quad-cover-reference.js'

describe('continuous cover height bounds', () => {
    it('refines an interior visible height when the upper endpoint lies behind the camera', () => {
        const coverage = tileMatrixCoverage({ tileMatrixSet: WebMercatorQuad, limits: [{
            matrixId: '20', minTileRow: 524287, maxTileRow: 524287,
            minTileCol: 524288, maxTileCol: 524288,
        }] })
        const matrix = mat4.perspective(Math.PI / 3, 1280 / 800, 1, 160, new Float64Array(16))
        const view = createGeoViewSnapshot({ id: 'interior-height', clipFromRelativeWorld: matrix,
            cameraHigh: [19.10925707129402, 19.10925707129402, 10], cameraLow: [0, 0, 0],
            referenceViewport: [1280, 800], verticalFovRadians: Math.PI / 3,
            cameraLatitudeRadians: 0, cameraPitchRadians: 0, zoomHint: 20,
            frameEpoch: 1, residencySnapshotEpoch: 1 })
        const result = evaluateGpuWebMercatorQuadCoverReference({
            spatialProfile: webMercatorPlanarTileSpatialProfile({
                addressCodec: webMercatorQuadAddressCodec({ coverage, coordinateBits: 52 }),
            }),
            policy: { minimumMatrixLevel: 20, maximumMatrixLevel: 24, maximumPatches: 512,
                cellsPerPatchEdge: 128, maximumCellSpanReferencePixels: 5, refinementTolerance: 0.005 },
            view, verticalRangeMeters: [-120, 500],
            visibleBounds: { west: 524288 / 2 ** 20, east: 524289 / 2 ** 20,
                north: 524287 / 2 ** 20, south: 524288 / 2 ** 20 },
        })
        // At z=0 the original z20 patch has 20.686 reference-pixel stretch;
        // the old two endpoint samples reported only 1.59 and kept that parent.
        expect(result.patches.some(patch => patch.matrixLevel === 20)).to.equal(false)
        expect(result.facts.finestMatrixLevel).to.equal(24)
        expect(result.facts.maximumCellSpanReferencePixels).to.be.greaterThan(5)
    })

    it('certifies clip-w against independent inverse-projected frustum points and coordinate slabs', () => {
        let seed = 29183
        const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32)
        let checked = 0
        for (const pitch of [0, 0.4, 1.1, 1.49]) for (const bearing of [0, 0.7, 2.6]) {
            const matrix = mat4.perspective(1.7, 2.3, 0.1, 1e7, new Float64Array(16))
            mat4.rotateX(matrix, pitch, matrix)
            mat4.rotateZ(matrix, bearing, matrix)
            const uploaded = Array.from(matrix, Math.fround)
            const inverse = mat4.inverse(uploaded, new Float64Array(16))
            const certificate = coverClipWCertificate(uploaded)
            for (let sample = 0; sample < 256; sample++) {
                const q = [random() * 2 - 1, random() * 2 - 1, random(), 1]
                const p = [0, 1, 2, 3].map(row => q.reduce((sum, value, col) => sum + inverse[col * 4 + row] * value, 0))
                const w = 1 / p[3]
                const point = p.map(value => value * w)
                const radius = [random() * 20, random() * 20, random() * 20, 0]
                const magnitude = point.map((value, axis) => Math.abs(value) + radius[axis])
                let lower = 0
                for (let axis = 0; axis < 4; axis++) {
                    const error = certificate.clipWResidual[axis].reduce((sum, value, index) => sum + value * magnitude[index], 0)
                    if (certificate.clipWPositive[axis] > 0) lower = Math.max(lower,
                        (point[axis] - radius[axis] - error) / certificate.clipWPositive[axis])
                    if (certificate.clipWNegative[axis] > 0) lower = Math.max(lower,
                        (-point[axis] - radius[axis] - error) / certificate.clipWNegative[axis])
                }
                expect(lower).to.be.at.most(w * (1 + 1e-10))
                checked++
            }
        }
        expect(checked).to.equal(3072)
    })

    it('uses no inverse certificate for a singular projection', () => {
        const result = coverClipWCertificate(new Array(16).fill(0))
        expect(result.clipWPositive).to.deep.equal([0, 0, 0, 0])
        expect(result.clipWNegative).to.deep.equal([0, 0, 0, 0])
    })
})
