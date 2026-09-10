import { expect } from 'chai'
import { mat4 } from 'wgpu-matrix'
import {
    WebMercatorQuad,
    createGeoViewSnapshot,
    tileMatrixCoverage,
    webMercatorPlanarTileSpatialProfile,
    webMercatorQuadAddressCodec,
} from 'geoscratch/geo'
import {
    gpuWebMercatorQuadCoverCandidates,
} from '../packages/geoscratch/dist/geo/gpu-web-mercator-quad-cover-candidates.js'

const WORLD = 40075016
const SOURCE_WORLD = 40075016.6855784
const f = Math.fround

function fixture({ minimum = 0, maximum = 8, row = 0, column = 0, width = 1, coordinateBits = 52 } = {}) {
    const coverage = tileMatrixCoverage({
        tileMatrixSet: WebMercatorQuad,
        limits: [{
            matrixId: String(minimum), minTileRow: row, maxTileRow: row + width - 1,
            minTileCol: column, maxTileCol: column + width - 1,
        }],
    })
    return {
        spatialProfile: webMercatorPlanarTileSpatialProfile({
            addressCodec: webMercatorQuadAddressCodec({ coverage, coordinateBits }),
        }),
        policy: {
            minimumMatrixLevel: minimum, maximumMatrixLevel: maximum,
            maximumPatches: 512, cellsPerPatchEdge: 128,
            maximumCellSpanReferencePixels: 5, refinementTolerance: 0.005,
        },
        verticalRangeMeters: [-120, 500],
    }
}

function view({ altitude = 90000, pitch = 0, bearing = 0, fov = Math.PI / 3,
    viewport = [1280, 800], x = 0, y = 0, frameEpoch = 1 } = {}) {
    const matrix = mat4.perspective(fov, viewport[0] / viewport[1], 0.1,
        Math.max(altitude * 32, 1e6), new Float64Array(16))
    mat4.rotateX(matrix, pitch, matrix)
    mat4.rotateZ(matrix, bearing, matrix)
    return createGeoViewSnapshot({
        id: 'candidate-view', clipFromRelativeWorld: matrix,
        cameraHigh: [f(x), f(y), f(altitude)],
        cameraLow: [x - f(x), y - f(y), altitude - f(altitude)],
        referenceViewport: viewport, verticalFovRadians: fov,
        cameraLatitudeRadians: 0, cameraPitchRadians: pitch, zoomHint: 10,
        frameEpoch, residencySnapshotEpoch: 1,
    })
}

// Independent finite-domain checker: enumerate every standard tile and evaluate
// clipped cell derivatives. It has no search radius, inverse matrix, depth cap,
// candidate helper calls, or candidate-parent pruning.
// Z uses ordinary f32 subtraction, deliberately independent from the shader's
// compensated high/low expansion. This checker is evidence, not the arithmetic
// proof or a substitute for native compensated-coordinate tests.
function splitMetric(descriptor, currentView, level, row, column) {
    const encoded = descriptor.spatialProfile.encodeCamera([
        currentView.cameraHigh[0] + currentView.cameraLow[0],
        currentView.cameraHigh[1] + currentView.cameraLow[1],
    ])
    const bits = descriptor.spatialProfile.coordinateBits
    const camera = [0, 1].map(axis =>
        (BigInt(encoded.high[axis]) << 32n) | BigInt(encoded.low[axis]))
    const meters = (boundary, origin) => {
        const difference = (BigInt(boundary) << BigInt(bits - level)) - origin
        const magnitude = difference < 0n ? -difference : difference
        const high = Number(magnitude >> 32n)
        const low = Number(magnitude & 0xffff_ffffn)
        const quantum = f(WORLD * 2 ** -bits)
        const result = f(f(f(high) * f(quantum * 2 ** 32)) + f(f(low) * quantum))
        return difference < 0n ? -result : result
    }
    const west = meters(column, camera[0])
    const east = meters(column + 1, camera[0])
    const north = -meters(row, camera[1])
    const south = -meters(row + 1, camera[1])
    const cell = f(Math.max(f(east - west), f(north - south)) / f(descriptor.policy.cellsPerPatchEdge))
    const m = currentView.clipFromRelativeWorld.map(f)
    const deltaX = m.slice(0, 4).map(value => f(value * cell))
    const deltaY = m.slice(4, 8).map(value => f(value * cell))
    const transform = point => [0, 1, 2, 3].map(axis =>
        f(f(f(f(m[axis] * point[0]) + f(m[axis + 4] * point[1])) +
            f(m[axis + 8] * point[2])) + m[axis + 12]))
    const matrixRows = [0, 1, 2, 3].map(row => [0, 1, 2, 3].map(column => m[column * 4 + row]))
    const planes = [matrixRows[2],
        matrixRows[3].map((value, index) => f(value - matrixRows[2][index])),
        matrixRows[3].map((value, index) => f(value + matrixRows[0][index])),
        matrixRows[3].map((value, index) => f(value - matrixRows[0][index])),
        matrixRows[3].map((value, index) => f(value + matrixRows[1][index])),
        matrixRows[3].map((value, index) => f(value - matrixRows[1][index]))]
    const distance = (point, plane) => {
        const equation = planes[plane]
        return f(f(f(f(equation[0] * point[0]) + f(equation[1] * point[1])) +
            f(equation[2] * point[2])) + equation[3])
    }
    let maximum = 0
    for (const height of descriptor.verticalRangeMeters) {
        const z = f(f(f(height) - f(currentView.cameraHigh[2])) - f(currentView.cameraLow[2]))
        let polygon = [[west, south, z], [east, south, z], [east, north, z], [west, north, z]]
        for (let plane = 0; plane < 6 && polygon.length > 0; plane++) {
            const output = []
            let start = polygon.at(-1)
            let startDistance = distance(start, plane)
            for (const end of polygon) {
                const endDistance = distance(end, plane)
                if ((startDistance >= 0) !== (endDistance >= 0)) {
                    const denominator = f(startDistance - endDistance)
                    const ratio = Math.abs(denominator) < 2 ** -120 ? 0.5 :
                        Math.max(0, Math.min(1, f(startDistance / denominator)))
                    output.push(start.map((value, axis) =>
                        f(f(value * f(1 - ratio)) + f(end[axis] * ratio))))
                }
                if (endDistance >= 0) output.push(end)
                start = end
                startDistance = endDistance
            }
            polygon = output
        }
        for (const point of polygon) {
            const clip = transform(point)
            if (f(clip[3] - f(0.5 * f(Math.abs(deltaX[3]) + Math.abs(deltaY[3])))) <= f(1e-5)) {
                maximum = Math.max(maximum, ...currentView.referenceViewport.map(f))
                continue
            }
            const reciprocal = f(1 / clip[3])
            const axisPixels = delta => [0, 1].map(axis => {
                const ndc = Math.max(-1, Math.min(1, f(clip[axis] * reciprocal)))
                return f(f(f(f(delta[axis] - f(ndc * delta[3])) * reciprocal) *
                    f(currentView.referenceViewport[axis])) * 0.5)
            })
            const x = axisPixels(deltaX)
            const y = axisPixels(deltaY)
            const dot = (a, b) => f(f(a[0] * b[0]) + f(a[1] * b[1]))
            const xx = dot(x, x)
            const yy = dot(y, y)
            const xy = dot(x, y)
            const d = f(xx - yy)
            const discriminant = f(Math.sqrt(Math.max(0, f(f(d * d) + f(f(4 * xy) * xy)))))
            maximum = Math.max(maximum, f(Math.sqrt(Math.max(0, f(0.5 * f(f(xx + yy) + discriminant))))))
        }
    }
    return maximum
}

function contains(window, row, column) {
    return row >= window.minTileRow && row <= window.maxTileRow &&
        column >= window.minTileCol && column <= window.maxTileCol
}

function exhaustive(descriptor, currentView) {
    const candidate = gpuWebMercatorQuadCoverCandidates(descriptor, currentView)
    const root = descriptor.spatialProfile.coverage.limits[0]
    const threshold = f(f(descriptor.policy.maximumCellSpanReferencePixels) *
        f(1 + f(descriptor.policy.refinementTolerance)))
    let checked = 0
    let outside = 0
    for (const window of candidate.windows) {
        const scale = 2 ** (window.matrixLevel - descriptor.policy.minimumMatrixLevel)
        for (let row = root.minTileRow * scale; row < (root.maxTileRow + 1) * scale; row++) {
            for (let column = root.minTileCol * scale; column < (root.maxTileCol + 1) * scale; column++) {
                checked++
                if (contains(window, row, column)) continue
                outside++
                const metric = splitMetric(descriptor, currentView, window.matrixLevel, row, column)
                expect(metric, `${window.matrixLevel}/${row}/${column}`).to.be.at.most(threshold)
            }
        }
    }
    return { candidate, checked, outside }
}

describe('conservative WebMercator refinement candidate domains', function() {
    this.timeout(30000)

    it('retains every split in independent finite-domain enumeration across projection changes', () => {
        const descriptor = fixture({ maximum: 7 })
        let omitted = 0
        for (const pitch of [0, 0.4, 1.0, 1.5]) {
            for (const [viewport, bearing, fov] of [
                [[1280, 800], 0, Math.PI / 3],
                [[4096, 512], 0.73, 2.4],
            ]) {
                const result = exhaustive(descriptor, view({ pitch, viewport, bearing, fov }))
                expect(result.candidate.conservativeFallback).to.equal(false)
                omitted += result.outside
            }
        }
        expect(omitted).to.be.greaterThan(1000)
    })

    for (const coordinateBits of [40, 52]) it(`keeps ${coordinateBits}-bit positions and z24 boundary candidates near and away from the camera`, () => {
        const minimum = 20
        const row = 435711
        const column = 871422
        const descriptor = fixture({ minimum, maximum: 24, row, column, width: 2, coordinateBits })
        const x = ((column + 0.9999999) / 2 ** minimum - 0.5) * SOURCE_WORLD
        const y = (0.5 - (row + 1.0000001) / 2 ** minimum) * SOURCE_WORLD
        for (const [altitude, pitch] of [[25, 0], [500, 1.45], [10000, 0.7]]) {
            const result = exhaustive(descriptor, view({ x, y, altitude, pitch }))
            expect(result.candidate.conservativeFallback).to.equal(false)
            expect(result.candidate.seedWindow.count).to.equal(4)
        }
    })

    it('includes a wide-viewport refinement that the previous focal-only radius omitted', () => {
        const descriptor = fixture({ maximum: 8 })
        const currentView = view({ altitude: 100000, viewport: [16384, 128] })
        const level = 6
        const row = 32
        const column = 40
        const threshold = f(f(descriptor.policy.maximumCellSpanReferencePixels) *
            f(1 + f(descriptor.policy.refinementTolerance)))
        const previousRadius = Math.max(2, Math.ceil(
            currentView.referenceViewport[1] * 0.5 / Math.tan(currentView.verticalFovRadians * 0.5) /
            (descriptor.policy.cellsPerPatchEdge * threshold)
        ) + 2)
        const cameraTile = 2 ** (level - 1)
        expect(previousRadius).to.equal(3)
        expect(column).to.be.greaterThan(cameraTile + previousRadius)
        expect(splitMetric(descriptor, currentView, level, row, column)).to.be.greaterThan(threshold)

        const candidate = gpuWebMercatorQuadCoverCandidates(descriptor, currentView)
        expect(candidate.conservativeFallback).to.equal(false)
        // The complete ancestor chain is visible and asks to split, so this is
        // not merely a raw predicate on a tile whose parents are ineligible.
        for (let parentLevel = 0; parentLevel <= level; parentLevel++) {
            const divisor = 2 ** (level - parentLevel)
            const parentRow = Math.floor(row / divisor)
            const parentColumn = Math.floor(column / divisor)
            expect(splitMetric(descriptor, currentView, parentLevel, parentRow, parentColumn),
                `${parentLevel}/${parentRow}/${parentColumn}`).to.be.greaterThan(threshold)
            expect(contains(candidate.windows[parentLevel], parentRow, parentColumn)).to.equal(true)
        }
    })

    it('retains the pitched world root when far-plane subtraction would cancel in clip coordinates', () => {
        const descriptor = fixture({ maximum: 14 })
        const currentView = view({ altitude: SOURCE_WORLD / 1024 * 1.5, pitch: 85 * Math.PI / 180 })
        const metric = splitMetric(descriptor, currentView, 0, 0, 0)
        expect(metric).to.be.greaterThan(5.025)
        const candidates = gpuWebMercatorQuadCoverCandidates(descriptor, currentView)
        expect(candidates.conservativeFallback).to.equal(false)
        expect(contains(candidates.windows[0], 0, 0)).to.equal(true)
    })

    it('checks all four exterior sides of high-zoom windows without a coarse-root search shortcut', () => {
        const descriptor = fixture({ maximum: 24 })
        const threshold = f(f(descriptor.policy.maximumCellSpanReferencePixels) *
            f(1 + f(descriptor.policy.refinementTolerance)))
        let checked = 0
        for (const options of [
            { altitude: 10, pitch: 0, x: 0.01, y: -0.01 },
            { altitude: 500, pitch: 1.56, bearing: 1.13, viewport: [8192, 512], fov: 2.8 },
            { altitude: 25000, pitch: 1.2, x: SOURCE_WORLD * 0.499999, y: SOURCE_WORLD * 0.499999 },
        ]) {
            const currentView = view(options)
            const candidates = gpuWebMercatorQuadCoverCandidates(descriptor, currentView)
            expect(candidates.conservativeFallback).to.equal(false)
            for (const level of [4, 10, 16, 22, 23]) {
                const window = candidates.windows[level]
                const maximum = 2 ** level - 1
                const middleRow = Math.floor((window.minTileRow + window.maxTileRow) / 2)
                const middleCol = Math.floor((window.minTileCol + window.maxTileCol) / 2)
                for (const distance of [1, 2, 17, 1024]) {
                    for (const [row, column] of [
                        [middleRow, window.minTileCol - distance],
                        [middleRow, window.maxTileCol + distance],
                        [window.minTileRow - distance, middleCol],
                        [window.maxTileRow + distance, middleCol],
                    ]) {
                        if (row < 0 || row > maximum || column < 0 || column > maximum) continue
                        checked++
                        expect(splitMetric(descriptor, currentView, level, row, column),
                            `${level}/${row}/${column}`).to.be.at.most(threshold)
                    }
                }
            }
        }
        expect(checked).to.be.greaterThan(100)
    })

    it('keeps the complete coarse seed domain separate from refinement candidates', () => {
        const descriptor = fixture({ minimum: 4, maximum: 14, row: 6, column: 12, width: 2 })
        const result = gpuWebMercatorQuadCoverCandidates(descriptor, view())
        expect(result.seedWindow).to.include({ minTileRow: 6, maxTileRow: 7,
            minTileCol: 12, maxTileCol: 13, count: 4 })
        expect(result.candidateCount).to.equal(result.refinementCandidateCount + 4)
        let offset = 0
        for (const window of result.windows) {
            expect(window.offset).to.equal(offset)
            offset += window.count
        }
        expect(offset).to.equal(result.refinementCandidateCount)
    })

    it('depends on uploaded reference pixels and projection facts rather than FOV hints or epochs', () => {
        const descriptor = fixture({ maximum: 12 })
        const a = view()
        const first = gpuWebMercatorQuadCoverCandidates(descriptor, a)
        gpuWebMercatorQuadCoverCandidates(descriptor, view({ pitch: 1.2 }))
        const same = createGeoViewSnapshot({ ...a, frameEpoch: 7, residencySnapshotEpoch: 9,
            verticalFovRadians: 2.9, zoomHint: 2 })
        expect(gpuWebMercatorQuadCoverCandidates(descriptor, same)).to.deep.equal(first)
        expect(gpuWebMercatorQuadCoverCandidates(descriptor, a)).to.deep.equal(first)
    })

    it('falls back to full geometry for singular and unrepresentable uploaded matrices', () => {
        const descriptor = fixture({ maximum: 5 })
        for (const matrix of [new Float64Array(16), new Float64Array(16).fill(1e100)]) {
            const candidate = gpuWebMercatorQuadCoverCandidates(descriptor,
                createGeoViewSnapshot({ ...view(), clipFromRelativeWorld: matrix }))
            expect(candidate.conservativeFallback).to.equal(true)
            for (const window of candidate.windows) {
                expect(window.count).to.equal(4 ** window.matrixLevel)
            }
        }
    })

    it('does not certify subnormal matrix coefficients or unsupported viewport arithmetic', () => {
        const descriptor = fixture({ maximum: 5 })
        const base = view()
        const subnormal = [...base.clipFromRelativeWorld]
        subnormal[0] = 2 ** -130
        for (const altered of [
            { clipFromRelativeWorld: subnormal },
            { referenceViewport: [0.5, 800] },
            { referenceViewport: [2 ** 21, 800] },
        ]) {
            const result = gpuWebMercatorQuadCoverCandidates(descriptor,
                createGeoViewSnapshot({ ...base, ...altered }))
            expect(result.conservativeFallback).to.equal(true)
            expect(result.refinementCandidateCount).to.equal((4 ** 5 - 1) / 3)
        }
    })

    it('rejects subnormal raw-plane differences even when all uploaded matrix coefficients are normal', () => {
        const descriptor = fixture({ maximum: 5 })
        const base = view()
        const matrix = [...base.clipFromRelativeWorld]
        matrix[2] = 2 ** -126 + 2 ** -149
        matrix[3] = 2 ** -126
        expect(matrix.map(f).every(value => value === 0 || Math.abs(value) >= 2 ** -126)).to.equal(true)
        const result = gpuWebMercatorQuadCoverCandidates(descriptor,
            createGeoViewSnapshot({ ...base, clipFromRelativeWorld: matrix }))
        expect(result.conservativeFallback).to.equal(true)
        expect(result.fallbackReasons).to.include('uncertified-clip-plane-coefficient')
        expect(result.refinementCandidateCount).to.equal((4 ** 5 - 1) / 3)
    })
})
