import { expect } from 'chai'
import * as geo from 'geoscratch/geo'
import {
    balancePatches,
} from '../packages/geoscratch/dist/geo/gpu-web-mercator-quad-cover-reference.js'

function patch(matrixLevel, tileRow, tileCol) {
    const tile = geo.WebMercatorQuad.tile({ matrixId: String(matrixLevel), tileRow, tileCol })
    return Object.freeze({
        kind: 'gpu-web-mercator-quad-cover-patch',
        tileMatrixSetId: 'WebMercatorQuad', matrixId: tile.matrixId,
        matrixLevel, tileRow, tileCol, key: tile.key,
    })
}

function input(minimum = 0, maximum = 5, capacity = 512) {
    return {
        policy: { minimumMatrixLevel: minimum, maximumMatrixLevel: maximum, maximumPatches: capacity },
        visibleBounds: { west: 0, north: 0, east: 1, south: 1 },
    }
}

function children(parent) {
    return [0, 1, 2, 3].map(index => patch(parent.matrixLevel + 1,
        parent.tileRow * 2 + (index >> 1), parent.tileCol * 2 + (index & 1)))
}

function scaled(p, maximum) {
    const scale = 2 ** (maximum - p.matrixLevel)
    return { west: p.tileCol * scale, east: (p.tileCol + 1) * scale,
        north: p.tileRow * scale, south: (p.tileRow + 1) * scale }
}

function adjacent(left, right, maximum) {
    const a = scaled(left, maximum)
    const b = scaled(right, maximum)
    return ((a.east === b.west || a.west === b.east) &&
        Math.max(a.north, b.north) < Math.min(a.south, b.south)) ||
        ((a.south === b.north || a.north === b.south) &&
            Math.max(a.west, b.west) < Math.min(a.east, b.east))
}

function keys(patches) {
    return patches.map(value => value.key).sort()
}

function assertCut(patches, maximum) {
    expect(new Set(keys(patches)).size).to.equal(patches.length)
    for (let i = 0; i < patches.length; i++) {
        for (let j = i + 1; j < patches.length; j++) {
            const a = scaled(patches[i], maximum)
            const b = scaled(patches[j], maximum)
            const overlap = Math.max(a.west, b.west) < Math.min(a.east, b.east) &&
                Math.max(a.north, b.north) < Math.min(a.south, b.south)
            expect(overlap).to.equal(false)
            if (adjacent(patches[i], patches[j], maximum)) {
                expect(Math.abs(patches[i].matrixLevel - patches[j].matrixLevel)).to.be.at.most(1)
            }
        }
    }
}

// Subject model of the new GPU identity-index algorithm. Its result is checked
// against balancePatches(), which remains the independent pairwise oracle.
// This model tests topology, not GPU hashing, memory visibility, or native work.
function indexedClosure(initial, minimum, maximum, isVisible = () => true) {
    let cut = [...initial]
    for (let round = 0; round < 4096; round++) {
        const index = new Map(cut.map((value, i) => [value.key, i]))
        const marks = new Set()
        for (const candidate of cut) {
            for (const [dr, dc] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
                const row = candidate.tileRow + dr
                const column = candidate.tileCol + dc
                const width = 2 ** candidate.matrixLevel
                if (row < 0 || column < 0 || row >= width || column >= width) continue
                for (let level = candidate.matrixLevel; level >= minimum; level--) {
                    const scale = 2 ** (candidate.matrixLevel - level)
                    const neighborIndex = index.get(`${level}/${Math.floor(row / scale)}/${Math.floor(column / scale)}`)
                    if (neighborIndex === undefined) continue
                    if (candidate.matrixLevel > cut[neighborIndex].matrixLevel + 1) marks.add(neighborIndex)
                    break
                }
            }
        }
        if (marks.size === 0) return cut
        const length = cut.length
        for (let index = 0; index < length; index++) {
            if (!marks.has(index)) continue
            const next = children(cut[index])
            cut[index] = next[0]
            cut.push(...next.slice(1))
        }
        cut = cut.filter(isVisible)
        expect(cut.length).to.be.lessThan(4096)
        expect(cut.every(value => value.matrixLevel <= maximum)).to.equal(true)
    }
    throw new Error('Indexed subject model did not close')
}

function sequentialClosure(initial, maximum, isVisible) {
    let cut = [...initial]
    for (let iteration = 0; iteration < 24; iteration++) {
        const length = cut.length
        let changed = false
        for (let i = 0; i < length; i++) {
            if (!cut.some((other, j) => i !== j &&
                other.matrixLevel > cut[i].matrixLevel + 1 && adjacent(cut[i], other, maximum))) continue
            const next = children(cut[i])
            cut[i] = next[0]
            cut.push(...next.slice(1))
            changed = true
        }
        cut = cut.filter(isVisible)
        if (!changed) return cut
    }
    throw new Error('Sequential regression model did not close')
}

function permutations(values) {
    if (values.length === 0) return [[]]
    return values.flatMap((value, index) => permutations(values.filter((_, other) => index !== other))
        .map(rest => [value, ...rest]))
}

describe('immutable-round WebMercator adjacency closure', function() {
    this.timeout(30000)

    it('does not let temporary invisible children trigger an unrelated coarse split', () => {
        // Minimized from seeded audit 0x83ab7149, min7/max12, case54, then
        // translated into a single z0 tile. Visibility is one oblique half-plane.
        const initial = [patch(3, 6, 4), patch(2, 3, 1), patch(5, 27, 20)]
        const visible = p => { const b = scaled(p, 5); return b.east + b.south > 47.5 }
        const expected = keys([patch(2, 3, 1), patch(4, 13, 9), patch(5, 27, 20)])
        const actual = [...initial]
        expect(balancePatches(input(), actual, visible)).to.equal(4)
        expect(keys(actual)).to.deep.equal(expected)
        expect(keys(indexedClosure(initial, 0, 5, visible))).to.deep.equal(expected)
        expect(keys(sequentialClosure(initial, 5, visible))).to.deep.equal(
            keys([patch(3, 7, 3), patch(4, 13, 9), patch(5, 27, 20)]))
        assertCut(actual, 5)
    })

    it('produces the same closed identities for every permutation of the regression cut', () => {
        const initial = [patch(3, 6, 4), patch(2, 3, 1), patch(5, 27, 20)]
        const visible = p => { const b = scaled(p, 5); return b.east + b.south > 47.5 }
        const expected = keys(indexedClosure(initial, 0, 5, visible))
        for (const permutation of permutations(initial)) {
            balancePatches(input(), permutation, visible)
            expect(keys(permutation)).to.deep.equal(expected)
        }
    })

    it('matches indexed identity queries for seeded sparse cuts with holes and visibility clipping', () => {
        let state = 0x83ab7149
        const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32 }
        for (const minimum of [0, 3, 20]) {
            const maximum = Math.min(24, minimum + 5)
            for (let run = 0; run < 40; run++) {
                const width = minimum === 0 ? 1 : 2
                const matrixWidth = 2 ** minimum
                const row = Math.floor(random() * (matrixWidth - width + 1))
                const column = Math.floor(random() * (matrixWidth - width + 1))
                let cut = []
                for (let r = row; r < row + width; r++) {
                    for (let c = column; c < column + width; c++) cut.push(patch(minimum, r, c))
                }
                for (let split = 0; split < 24; split++) {
                    const eligible = cut.map((value, index) => value.matrixLevel < maximum ? index : -1).filter(value => value >= 0)
                    if (eligible.length === 0) break
                    const selected = eligible[Math.floor(random() * eligible.length)]
                    const next = children(cut[selected])
                    cut[selected] = next[0]
                    cut.push(...next.slice(1))
                }
                const scale = 2 ** (maximum - minimum)
                const cutoff = (row + column) * scale + random() * width * scale
                const visible = value => { const b = scaled(value, maximum); return b.east + b.south > cutoff }
                cut = cut.filter(visible)
                if (run % 3 === 0) cut = cut.filter(() => random() > 0.15)
                const expected = indexedClosure(cut, minimum, maximum, visible)
                const actual = [...cut]
                balancePatches(input(minimum, maximum, 4096), actual, visible)
                expect(keys(actual)).to.deep.equal(keys(expected))
                assertCut(actual, maximum)
            }
        }
    })

    it('uses finite world edges without inventing antimeridian or polar neighbors', () => {
        const initial = [patch(1, 0, 0), patch(4, 0, 15), patch(4, 15, 0)]
        const actual = [...initial]
        expect(balancePatches(input(0, 4), actual)).to.equal(0)
        expect(keys(actual)).to.deep.equal(keys(initial))
        expect(keys(indexedClosure(initial, 0, 4))).to.deep.equal(keys(initial))
    })

    it('closes a four-level edge difference at z24 without losing integer identity', () => {
        const initial = [patch(20, 2 ** 20 - 1, 2 ** 20 - 2), patch(24, 2 ** 24 - 16, 2 ** 24 - 16)]
        const actual = [...initial]
        balancePatches(input(20, 24, 256), actual)
        expect(keys(actual)).to.deep.equal(keys(indexedClosure(initial, 20, 24)))
        assertCut(actual, 24)
        expect(actual.some(value => value.matrixLevel === 23)).to.equal(true)
    })

    it('rejects capacity overflow and unrepresentable closure work budgets', () => {
        const initial = [patch(3, 6, 4), patch(2, 3, 1), patch(5, 27, 20)]
        expect(() => balancePatches(input(0, 5, 4), [...initial])).to.throw(geo.GeoDiagnosticError)
        expect(() => balancePatches(input(0, 24, 0xffff_ffff), [...initial])).to.throw(geo.GeoDiagnosticError)
        expect(() => balancePatches(input(0, 5, 0), [...initial])).to.throw(geo.GeoDiagnosticError)
        expect(geo).not.to.have.property('balancePatches')
    })
})
