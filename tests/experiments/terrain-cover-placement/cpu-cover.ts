// Experimental CPU port of the current WGSL selector. No production exports.
// Reads the exact uploaded 656-byte map metadata. Scalar arithmetic uses JS f64
// over f32 inputs, with the shader's camera limb reconstruction rounded to f32.
const F = Math.fround, HUGE = 2 ** 120, NIL = 0xffffffff
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x))
type Patch = {
    level: number
    row: number
    col: number
}
type Bounds = {
    min: number[]
    max: number[]
}
export class CpuCover {
    policy: any
    domain: any
    lookup: Uint32Array
    patches: Uint32Array
    marks: Uint32Array
    state: Uint32Array
    m: number[] = [];
    planes: number[][] = [];
    viewport: number[] = [];
    meta: any
    n = 0;
    candidateCount = 0;
    finest = 0;
    overflow = 0;
    lookupOverflow = 0;
    adjacent = 0;
    metrics = 0;
    visibilityTests = 0;
    constructor(domain: any, policy: any, lookupCapacity: number) {
        this.domain = { coordinateBits: 52, ...domain }
        this.policy = { ...policy, lookupCapacity }
        this.lookup = new Uint32Array(lookupCapacity * 5)
        this.patches = new Uint32Array(policy.maximumPatches * 3)
        this.marks = new Uint32Array(policy.maximumPatches)
        this.state = new Uint32Array(11)
    }
    run(bytes: Uint8Array, mode = 'gated') {
        const t = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        const fs = (offset: number, n: number) => Array.from({ length: n }, (_, i) => t.getFloat32(offset + i * 4, true))
        const us = (offset: number, n: number) => Array.from({ length: n }, (_, i) => t.getUint32(offset + i * 4, true))
        this.m = fs(0, 16)
        this.viewport = fs(112, 2)
        this.meta = { cameraHigh: fs(64, 3), cameraLow: fs(80, 3), fixedLow: us(96, 2), fixedHigh: us(104, 2), epoch: t.getUint32(124, true), windows: us(144, 100), positive: fs(560, 4), negative: fs(576, 4), residual: fs(592, 16) }
        const rows = Array.from({ length: 4 }, (_, row) => [0, 1, 2, 3].map(c => this.m[c * 4 + row]))
        const plus = (a: number[], b: number[], sign = 1) => a.map((v, i) => F(v + sign * b[i]))
        this.planes = [rows[2], plus(rows[3], rows[2], -1), plus(rows[3], rows[0]), plus(rows[3], rows[0], -1), plus(rows[3], rows[1]), plus(rows[3], rows[1], -1)]
        this.n = 0
        this.candidateCount = 0
        this.finest = this.policy.minimumMatrixLevel
        this.overflow = 0
        this.lookupOverflow = 0
        this.adjacent = 0
        this.metrics = 0
        this.visibilityTests = 0
        this.lookup.fill(0)
        const lo = this.policy.minimumMatrixLevel, hi = this.policy.maximumMatrixLevel, threshold = F(F(this.policy.maximumCellSpanReferencePixels) * F(1 + F(this.policy.refinementTolerance)))
        candidateLevels: for (let level = lo; level < hi; level++) {
            const w = this.meta.windows, o = level * 4, start = level ? w[o - 1] : 0, count = w[o + 3] - start, width = w[o + 2]
            if (!count)
                continue
            for (let i = 0; i < count; i++) {
                this.candidateCount++
                const row = w[o] + Math.floor(i / width), col = w[o + 1] + i % width
                const eligible = level === lo || this.find(level - 1, Math.floor(row / 2), Math.floor(col / 2)) !== NIL
                if (mode === 'gated' && !eligible)
                    continue
                const b = this.bounds(level, row, col)
                if (!this.visible(b) || this.metric(b) <= threshold || !eligible)
                    continue
                if (!this.insert(level, row, col, NIL - 1)) {
                    this.lookupOverflow++
                    break candidateLevels
                }
                this.finest = Math.max(this.finest, level + 1)
            }
        }
        for (let row = this.domain.row; row < this.domain.row + this.domain.height; row++)
            for (let col = this.domain.col; col < this.domain.col + this.domain.width; col++) {
                this.candidateCount++
                if (!this.visible(this.bounds(lo, row, col)))
                    continue
                if (this.n >= this.policy.maximumPatches) {
                    this.overflow++
                    continue
                }
                this.set(this.n++, lo, row, col)
            }
        for (let level = lo; level < this.finest; level++) {
            const input = this.n
            for (let i = 0; i < input; i++) {
                const p = this.get(i)
                if (p.level === level && this.find(level, p.row, p.col) !== NIL)
                    this.split(i)
            }
            this.compact()
        }
        let balanced = false
        for (let iteration = 0; iteration < this.policy.maximumPatches * (hi - lo + 1); iteration++) {
            if (!this.buildIndex())
                break
            const input = this.n
            this.marks.fill(0, 0, input)
            let changed = false
            this.adjacent = 0
            for (let i = 0; i < input; i++) {
                const p = this.get(i)
                for (let edge = 0; edge < 4; edge++) {
                    const j = this.neighbor(p, edge)
                    if (j === NIL)
                        continue
                    const delta = p.level - this.patches[j * 3]
                    this.adjacent = Math.max(this.adjacent, delta)
                    if (delta > 1) {
                        this.marks[j] = 1
                        changed = true
                    }
                }
            }
            if (!changed) {
                balanced = true
                break
            }
            let failed = false
            for (let i = 0; i < input; i++)
                if (this.marks[i] && !this.split(i)) {
                    failed = true
                    break
                }
            if (failed)
                break
            this.compact()
        }
        if (!balanced || this.overflow || this.lookupOverflow) {
            this.compact()
            this.buildIndex()
            this.adjacent = 0
            for (let i = 0; i < this.n; i++) {
                const p = this.get(i)
                for (let e = 0; e < 4; e++) {
                    const j = this.neighbor(p, e)
                    if (j !== NIL)
                        this.adjacent = Math.max(this.adjacent, p.level - this.patches[j * 3])
                }
            }
        }
        let minLevel = NIL, maxLevel = 0, minSpan = NIL, maxSpan = 0
        for (let i = 0; i < this.n; i++) {
            minLevel = Math.min(minLevel, this.patches[i * 3])
            maxLevel = Math.max(maxLevel, this.patches[i * 3])
        }
        if (this.overflow || this.lookupOverflow || this.adjacent > 1) {
            this.n = 0
            this.lookup.fill(0)
        }
        for (let i = 0; i < this.n; i++) {
            const p = this.get(i), v = this.metric(this.bounds(p.level, p.row, p.col)), q = !(v >= 0 && v < HUGE) ? NIL : Math.round(clamp(v, 0, 65535) * 256)
            minSpan = Math.min(minSpan, q)
            maxSpan = Math.max(maxSpan, q)
        }
        if (maxSpan === NIL) {
            this.n = 0
            this.lookup.fill(0)
        }
        this.state.set([this.meta.epoch, this.candidateCount, this.n, this.overflow, this.lookupOverflow, minLevel, maxLevel, this.adjacent, this.finest, minSpan, maxSpan])
        return { state: this.state, patches: this.patches.subarray(0, this.n * 3), lookup: this.lookup, metrics: this.metrics, visibilityTests: this.visibilityTests }
    }
    get(i: number): Patch { return { level: this.patches[i * 3], row: this.patches[i * 3 + 1], col: this.patches[i * 3 + 2] } }
    set(i: number, l: number, r: number, c: number) { this.patches[i * 3] = l; this.patches[i * 3 + 1] = r; this.patches[i * 3 + 2] = c }
    hash(l: number, r: number, c: number) { let h = Math.imul(l, 0x9e3779b9); h = Math.imul(h ^ r, 0x85ebca6b); h = Math.imul(h ^ c, 0xc2b2ae35); return (h ^ (h >>> 16)) >>> 0 }
    find(l: number, r: number, c: number) {
        const mask = this.policy.lookupCapacity - 1, h = this.hash(l, r, c); for (let probe = 0; probe <= mask; probe++) {
            const o = ((h + probe) & mask) * 5
            if (!this.lookup[o])
                return NIL
            if (this.lookup[o + 1] === l && this.lookup[o + 2] === r && this.lookup[o + 3] === c)
                return this.lookup[o + 4]
        } return NIL
    }
    insert(l: number, r: number, c: number, index: number) {
        const mask = this.policy.lookupCapacity - 1, h = this.hash(l, r, c); for (let probe = 0; probe <= mask; probe++) {
            const o = ((h + probe) & mask) * 5
            if (!this.lookup[o]) {
                this.lookup.set([1, l, r, c, index], o)
                return true
            }
            if (this.lookup[o + 1] === l && this.lookup[o + 2] === r && this.lookup[o + 3] === c)
                return true
        } return false
    }
    buildIndex() {
        this.lookup.fill(0); for (let i = 0; i < this.n; i++) {
            const p = this.get(i)
            if (!this.insert(p.level, p.row, p.col, i)) {
                this.lookupOverflow++
                return false
            }
        } return true
    }
    neighbor(p: Patch, edge: number) {
        let r = p.row, c = p.col; const w = 2 ** p.level; if (edge === 0) {
            if (!c)
                return NIL
            c--
        } if (edge === 1) {
            if (c + 1 >= w)
                return NIL
            c++
        } if (edge === 2) {
            if (!r)
                return NIL
            r--
        } if (edge === 3) {
            if (r + 1 >= w)
                return NIL
            r++
        } for (let l = p.level; l >= this.policy.minimumMatrixLevel; l--) {
            const d = 2 ** (p.level - l), i = this.find(l, Math.floor(r / d), Math.floor(c / d))
            if (i !== NIL)
                return i
        } return NIL
    }
    split(i: number) {
        if (this.n + 3 > this.policy.maximumPatches) {
            this.overflow++
            return false
        } const p = this.get(i), l = p.level + 1, r = p.row * 2, c = p.col * 2; this.set(i, l, r, c); this.set(this.n++, l, r, c + 1); this.set(this.n++, l, r + 1, c); this.set(this.n++, l, r + 1, c + 1); this.candidateCount += 4; return true
    }
    compact() {
        let count = 0; for (let i = 0; i < this.n; i++) {
            const p = this.get(i)
            if (this.visible(this.bounds(p.level, p.row, p.col)))
                this.set(count++, p.level, p.row, p.col)
        } this.n = count
    }
    relative(a: number, b: number) { const diff = a - b, mag = Math.abs(diff), lo = mag % 2 ** 32, hi = Math.floor(mag / 2 ** 32), quantum = F(40075016 * 2 ** -this.domain.coordinateBits), high = F(quantum * 2 ** 32), meters = F(F(F(hi) * high) + F(F(lo) * quantum)); return diff < 0 ? -meters : meters }
    bounds(level: number, row: number, col: number): Bounds {
        const scale = 2 ** (this.domain.coordinateBits - level), cx = this.meta.fixedHigh[0] * 2 ** 32 + this.meta.fixedLow[0], cy = this.meta.fixedHigh[1] * 2 ** 32 + this.meta.fixedLow[1]
        let vertical = this.domain.verticalRange ?? [this.domain.elevation, this.domain.elevation]
        if (this.domain.verticalBounds) {
            const limits = this.domain.limits, entries = this.domain.verticalBounds
            for (let index = limits.length - 1; index >= 0; index--) {
                const lim = limits[index], l = Number(lim.matrixId)
                if (l > level)
                    continue
                const d = 2 ** (level - l), r = Math.floor(row / d), c = Math.floor(col / d)
                if (r < lim.minTileRow || r > lim.maxTileRow || c < lim.minTileCol || c > lim.maxTileCol)
                    continue
                let offset = 0
                for (let i = 0; i < index; i++)
                    offset += (limits[i].maxTileRow - limits[i].minTileRow + 1) * (limits[i].maxTileCol - limits[i].minTileCol + 1)
                const v = entries[offset + (r - lim.minTileRow) * (lim.maxTileCol - lim.minTileCol + 1) + c - lim.minTileCol]
                vertical = [v.minimumVerticalMeters, v.maximumVerticalMeters]
                break
            }
        }
        const z = (value: number) => {
            const h = F(value), ch = this.meta.cameraHigh[2], cl = this.meta.cameraLow[2]; if (h === ch)
                return F(-cl); const d = F(h - ch), bridge = F(d - h), round = F(F(h - F(d - bridge)) - F(ch + bridge)); return F(d + F(F(round + 0) - cl))
        }
        return { min: [this.relative(col * scale, cx), this.relative(cy, (row + 1) * scale), z(vertical[0])], max: [this.relative((col + 1) * scale, cx), this.relative(cy, row * scale), z(vertical[1])] }
    }
    visible(b: Bounds) {
        this.visibilityTests++; for (const e of this.planes) {
            let value = e[3]
            for (let a = 0; a < 3; a++)
                value += e[a] * (e[a] >= 0 ? b.max[a] : b.min[a])
            if (value < 0)
                return false
        } return true
    }
    transform(p: number[]) { const m = this.m; return [0, 1, 2, 3].map(r => m[r] * p[0] + m[r + 4] * p[1] + m[r + 8] * p[2] + m[r + 12]) }
    metric(b: Bounds) { this.metrics++; return b.min[2] === b.max[2] ? this.planeMetric(b) : this.volumeMetric(b) }
    numerator(x: number, y: number, dx: number[], dy: number[]) {
        const px = this.viewport[0] * .5, py = this.viewport[1] * .5, ax = (dx[0] - x * dx[3]) * px, ay = (dx[1] - y * dx[3]) * py, bx = (dy[0] - x * dy[3]) * px, by = (dy[1] - y * dy[3]) * py; const scale = Math.max(Math.abs(ax), Math.abs(ay), Math.abs(bx), Math.abs(by)); if (!scale)
            return 0; if (!(scale < 2 ** 110))
            return HUGE; const a = ax / scale, b = ay / scale, c = bx / scale, d = by / scale, xx = a * a + b * b, xy = a * c + b * d, yy = c * c + d * d; return scale * Math.sqrt(Math.max(0, .5 * (xx + yy + Math.sqrt(Math.max(0, (xx - yy) ** 2 + 4 * xy * xy)))))
    }
    deltas(b: Bounds) { const h = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1]) / this.policy.cellsPerPatchEdge, dx = this.m.slice(0, 4).map(v => v * h), dy = this.m.slice(4, 8).map(v => v * h), px = this.viewport[0] * .5, py = this.viewport[1] * .5; return { dx, dy, error: 2e-5 * ((Math.abs(dx[0]) + Math.abs(dx[3])) * px + (Math.abs(dx[1]) + Math.abs(dx[3])) * py + (Math.abs(dy[0]) + Math.abs(dy[3])) * px + (Math.abs(dy[1]) + Math.abs(dy[3])) * py) + 1e-20 } }
    planeMetric(b: Bounds) {
        let poly = [[b.min[0], b.min[1], b.min[2]], [b.max[0], b.min[1], b.min[2]], [b.max[0], b.max[1], b.min[2]], [b.min[0], b.max[1], b.min[2]]]
        for (const e of this.planes) {
            const out: number[][] = []
            let start = poly[poly.length - 1], sd = e[0] * start[0] + e[1] * start[1] + e[2] * start[2] + e[3]
            for (const end of poly) {
                const ed = e[0] * end[0] + e[1] * end[1] + e[2] * end[2] + e[3]
                if ((sd >= 0) !== (ed >= 0)) {
                    const den = sd - ed, r = Math.abs(den) >= 2 ** -120 ? clamp(sd / den, 0, 1) : .5
                    out.push(start.map((v, i) => v + (end[i] - v) * r))
                }
                if (ed >= 0)
                    out.push(end)
                start = end
                sd = ed
            }
            poly = out
            if (!poly.length)
                return 0
        }
        const { dx, dy, error } = this.deltas(b)
        let minW = HUGE, maxN = 0
        for (const p of poly) {
            const c = this.transform(p)
            minW = Math.min(minW, c[3])
            if (c[3] <= 1e-5)
                return HUGE
            maxN = Math.max(maxN, this.numerator(clamp(c[0] / c[3], -1, 1), clamp(c[1] / c[3], -1, 1), dx, dy))
        }
        return minW - .5 * (Math.abs(dx[3]) + Math.abs(dy[3])) <= 1e-5 ? HUGE : (maxN + error) / minW
    }
    volumeMetric(b: Bounds) {
        const m = this.m, mag = b.min.map((v, i) => Math.max(Math.abs(v), Math.abs(b.max[i]))), error = [0, 1, 2, 3].map(a => (Math.abs(m[a]) * mag[0] + Math.abs(m[a + 4]) * mag[1] + Math.abs(m[a + 8]) * mag[2] + Math.abs(m[a + 12])) * 4e-6 + 1e-30)
        const clips: number[][] = []
        let minBox = HUGE
        for (let corner = 0; corner < 8; corner++) {
            const c = this.transform([corner & 1 ? b.max[0] : b.min[0], corner & 2 ? b.max[1] : b.min[1], corner & 4 ? b.max[2] : b.min[2]])
            clips.push(c)
            minBox = Math.min(minBox, c[3] - error[3])
        }
        let lower = [-1, -1], upper = [1, 1]
        if (minBox > 1e-5) {
            const lo = [HUGE, HUGE], hi = [-HUGE, -HUGE]
            for (const c of clips)
                for (let a = 0; a < 2; a++) {
                    const ndc = c[a] / c[3], err = (error[a] + Math.abs(ndc) * error[3]) / minBox + Math.abs(ndc) * 2e-6 + 1e-20
                    lo[a] = Math.min(lo[a], ndc - err)
                    hi[a] = Math.max(hi[a], ndc + err)
                }
            lower = lower.map((v, a) => Math.max(v, lo[a]))
            upper = upper.map((v, a) => Math.min(v, hi[a]))
            if (lower.some((v, a) => v > upper[a]))
                return 0
        }
        let frustum = 0
        const min = [...b.min, 1], max = [...b.max, 1]
        for (let a = 0; a < 4; a++) {
            const residual = (this.meta.residual[a * 4] * mag[0] + this.meta.residual[a * 4 + 1] * mag[1] + this.meta.residual[a * 4 + 2] * mag[2] + this.meta.residual[a * 4 + 3]) * 1.000002, err = residual + 2e-6 * Math.max(Math.abs(min[a]), Math.abs(max[a])) + 1e-30
            if (this.meta.positive[a] > 0)
                frustum = Math.max(frustum, Math.max(0, min[a] - err) / this.meta.positive[a] * .999998)
            if (this.meta.negative[a] > 0)
                frustum = Math.max(frustum, Math.max(0, -max[a] - err) / this.meta.negative[a] * .999998)
        }
        const minW = Math.max(minBox, frustum), { dx, dy, error: round } = this.deltas(b)
        if (minW - .5 * (Math.abs(dx[3]) + Math.abs(dy[3])) <= 1e-5)
            return HUGE
        let maxN = 0
        for (let c = 0; c < 4; c++)
            maxN = Math.max(maxN, this.numerator(c & 1 ? upper[0] : lower[0], c & 2 ? upper[1] : lower[1], dx, dy))
        return (maxN + round) / minW * 1.000002
    }
}
