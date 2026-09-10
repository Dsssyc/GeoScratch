import { expect } from 'chai'
import fs from 'node:fs'
import { mat4 } from 'wgpu-matrix'
import {
    WebMercatorQuad, WebMercatorQuadCover, createGeoViewSnapshot, tileMatrixCoverage,
    webMercatorPlanarTileSpatialProfile, webMercatorQuadAddressCodec,
} from 'geoscratch/geo'
import { WebMercatorQuadCoverKernel } from '../packages/geoscratch/dist/geo/web-mercator-quad-cover-kernel.js'
import { webMercatorQuadCoverSelectionData } from '../packages/geoscratch/dist/geo/web-mercator-quad-cover.js'
import { coverClipWCertificate } from '../packages/geoscratch/dist/geo/gpu-web-mercator-quad-cover-candidates.js'

const captured = JSON.parse(fs.readFileSync(new URL('./fixtures/terrain-near-plane-view.json', import.meta.url), 'utf8'))
const world = 40_075_016.6855784

function setup(bits, flat) {
    const coverage = tileMatrixCoverage({ tileMatrixSet: WebMercatorQuad, limits: captured.domain.limits })
    const descriptor = { spatialProfile: webMercatorPlanarTileSpatialProfile({
        addressCodec: webMercatorQuadAddressCodec({ coverage, coordinateBits: bits }),
    }), policy: captured.policy, verticalRangeMeters: flat ? [0, 0] : captured.domain.verticalRange,
        ...(flat ? {} : { verticalBounds: captured.domain.verticalBounds }) }
    const view = createGeoViewSnapshot(flat ? { ...captured.view,
        cameraHigh: [...captured.view.cameraHigh.slice(0, 2), 3],
        cameraLow: [...captured.view.cameraLow.slice(0, 2), 0],
    } : captured.view)
    return { descriptor, view, cover: new WebMercatorQuadCover(descriptor) }
}

function transform(m, p) { return [0, 1, 2, 3].map(row => p.reduce((s, v, col) => s + m[col * 4 + row] * v, 0)) }

// Screen rays sample visible points independently of candidate enumeration or the
// implementation's box/slab metric. A genuine cover must own each point once.
function visibleSamples(selection, elevations) {
    const v = selection.view, m = Array.from(v.clipFromRelativeWorld), inverse = mat4.inverse(m, new Float64Array(16))
    const camera = v.cameraHigh.map((x, i) => x + v.cameraLow[i])
    let count = 0, maximum = 0
    for (const z of elevations) for (let row = 0; row <= 12; row++) for (let col = 0; col <= 24; col++) {
        const q = [-.95 + col * 1.9 / 24, -.95 + row * 1.9 / 12]
        const near = transform(inverse, [...q, 0, 1]), far = transform(inverse, [...q, 1, 1])
        const a = near.slice(0, 3).map(x => x / near[3]), b = far.slice(0, 3).map(x => x / far[3])
        const t = (z - camera[2] - a[2]) / (b[2] - a[2])
        if (!(t > 0 && t < 1)) continue
        const p = a.map((x, i) => x + t * (b[i] - x)), clip = transform(m, [...p, 1])
        const nx = (p[0] + camera[0]) / world + .5, ny = .5 - (p[1] + camera[1]) / world
        const root = captured.domain.limits[0], level = Number(root.matrixId)
        if (Math.floor(nx * 2 ** level) !== root.minTileCol || Math.floor(ny * 2 ** level) !== root.minTileRow) continue
        const owners = selection.patches.filter(patch => Math.floor(nx * 2 ** patch.matrixLevel) === patch.tileCol && Math.floor(ny * 2 ** patch.matrixLevel) === patch.tileRow)
        expect(owners, 'visible point has one owner').to.have.length(1)
        const owner = owners[0], h = world / 2 ** owner.matrixLevel / captured.policy.cellsPerPatchEdge
        const columns = [0, 1].map(axis => [0, 1].map(screen =>
            h * v.referenceViewport[screen] / 2 *
            (m[axis * 4 + screen] * clip[3] - clip[screen] * m[axis * 4 + 3]) / clip[3] ** 2))
        const [x, y] = columns, xx = x[0] ** 2 + x[1] ** 2, yy = y[0] ** 2 + y[1] ** 2, xy = x[0] * y[0] + x[1] * y[1]
        const stretch = Math.sqrt((xx + yy + Math.sqrt((xx - yy) ** 2 + 4 * xy ** 2)) / 2)
        expect(stretch).to.be.at.most(selection.facts.maximumCellSpanReferencePixels + .02)
        if (owner.matrixLevel < captured.policy.maximumMatrixLevel) expect(stretch).to.be.at.most(5 * 1.005 + .02)
        maximum = Math.max(maximum, stretch); count++
    }
    expect(count, 'independent visible samples').to.be.greaterThan(0)
    return { count, maximum }
}

describe('CPU cover visible near-plane domain', () => {
    for (const bits of [40, 52]) for (const flat of [false, true]) {
        it(`certifies the clipped ${flat ? 'plane' : 'height volume'} at ${bits} bits`, () => {
            const { cover, view } = setup(bits, flat)
            try {
                const selected = cover.select(view)
                expect(selected.patches.length).to.be.greaterThan(0)
                expect(selected.facts).to.include({ descriptorOverflowCount: 0, lookupOverflowCount: 0, finestMatrixLevel: 14 })
                expect(selected.facts.maximumAdjacentLevelDelta).to.be.at.most(1)
                expect(selected.facts.maximumCellSpanReferencePixels).to.be.lessThan(65535)
                visibleSamples(selected, flat ? [0] : [-50, 0, 100, 200])
                const returned = cover.select(createGeoViewSnapshot({ ...view, frameEpoch: view.frameEpoch + 1 }))
                expect(returned.patches).to.deep.equal(selected.patches)
            } finally { cover.dispose() }
        })
    }

    for (const bits of [40, 52]) {
        it(`matches exhaustive candidates for a finite near-plane domain at ${bits} bits`, () => {
            const [x, y] = captured.view.cameraHigh.map((v, i) => v + captured.view.cameraLow[i])
            const row = Math.floor((.5 - y / world) * 1024) - 1, col = Math.floor((.5 + x / world) * 1024) - 1
            const limits = [{ matrixId: '10', minTileRow: row, maxTileRow: row + 1, minTileCol: col, maxTileCol: col + 1 }]
            const coverage = tileMatrixCoverage({ tileMatrixSet: WebMercatorQuad, limits })
            const policy = { ...captured.policy, minimumMatrixLevel: 10, maximumPatches: 512 }
            const cover = new WebMercatorQuadCover({ policy, verticalRangeMeters: captured.domain.verticalRange,
                spatialProfile: webMercatorPlanarTileSpatialProfile({ addressCodec: webMercatorQuadAddressCodec({ coverage, coordinateBits: bits }) }) })
            try {
                const selection = cover.select(createGeoViewSnapshot(captured.view))
                const bounded = webMercatorQuadCoverSelectionData(selection)
                const bytes = bounded.mapMeta.slice(), words = new DataView(bytes.buffer)
                let count = 0
                for (let level = 10; level < 14; level++) {
                    const scale = 2 ** (level - 10), width = 2 * scale
                    count += width * width
                    for (const [index, value] of [row * scale, col * scale, width, count].entries())
                        words.setUint32(144 + level * 16 + index * 4, value, true)
                }
                const kernel = new WebMercatorQuadCoverKernel({ ...captured.domain,
                    coordinateBits: bits, row, col, width: 2, height: 2, limits, verticalBounds: undefined,
                }, policy, cover.facts().lookupCapacity)
                const full = kernel.run(bytes)
                expect([...full.patches]).to.deep.equal([...bounded.patches])
                expect([...full.state].slice(2)).to.deep.equal([...bounded.state].slice(2))
                expect(full.state[1]).to.be.at.least(selection.facts.candidateCount)
            } finally { cover.dispose() }
        })
    }

    for (const flat of [true, false]) for (const near of [0.9e-5, 1.1e-5]) {
        it(`${flat ? 'plane' : 'volume'} retains the positive visible-depth guard at near=${near}`, () => {
            const kernel = new WebMercatorQuadCoverKernel(captured.domain, captured.policy, 512)
            kernel.m = Array.from(mat4.perspective(Math.PI / 3, 1, near, 10, new Float64Array(16)), Math.fround)
            kernel.viewport = [128, 128]
            const certificate = coverClipWCertificate(kernel.m)
            kernel.meta = { positive: certificate.clipWPositive, negative: certificate.clipWNegative,
                residual: certificate.clipWResidual.flat() }
            kernel.planes = [[0, 0, -1, -near], [0, 0, 1, 10], [1, 0, -1, 0], [-1, 0, -1, 0], [0, 1, -1, 0], [0, -1, -1, 0]]
            const bounds = { min: [-near * .1, -near * .1, flat ? -near : -2 * near], max: [near * .1, near * .1, flat ? -near : near] }
            const metric = kernel.metric(bounds)
            expect(metric < 2 ** 120).to.equal(near > 1e-5)
        })
    }
})
