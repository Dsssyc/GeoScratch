import type { GeoViewSnapshot } from './geo-view.js'
import type { GpuWebMercatorQuadCoverDescriptor } from './gpu-web-mercator-quad-cover.js'

type Interval = readonly [number, number]
type WindowBounds = Readonly<{
    minTileRow: number
    maxTileRow: number
    minTileCol: number
    maxTileCol: number
}>

export type WebMercatorCoverCandidateWindow = WindowBounds & Readonly<{
    matrixLevel: number
    offset: number
    count: number
}>

export type WebMercatorCoverCandidates = Readonly<{
    seedWindow: WebMercatorCoverCandidateWindow
    clipWPositive: readonly number[]
    clipWNegative: readonly number[]
    clipWResidual: readonly (readonly number[])[]
    windows: readonly WebMercatorCoverCandidateWindow[]
    candidateCount: number
    refinementCandidateCount: number
    conservativeFallback: boolean
    fallbackReasons: readonly string[]
}>

// These constants follow the WGSL f32 accuracy contract, not a tile-distance
// allowance. A full ULP is at most 2^-23 times a normal number's magnitude.
// Division permits 2.5 ULP; sqrt inherits inverseSqrt (2 ULP) and division.
// https://www.w3.org/TR/WGSL/#accuracy-of-concrete-floating-point-expressions
const UNIT = 2 ** -23
const MIN_NORMAL = 2 ** -126
const WORLD_METERS = 40075016
const CLIP_PLANES = 6
const CLIP_OPERATION_UNITS = CLIP_PLANES * 32 + 64
const METRIC_OPERATION_UNITS = 512
const MAX_CERTIFIED_MAGNITUDE = 2 ** 60
const MINIMUM_CELL_W = Math.fround(1e-5)
const rounds = new DataView(new ArrayBuffer(8))

/**
 * Computes only conservative integer candidate domains, never LoD decisions.
 *
 * The accompanying shader must clamp the projected sample's NDC xy to [-1, 1]
 * before evaluating its Jacobian. For exact clipping this is an identity; for
 * f32 clipping it makes the metric bound independent of clipping roundoff.
 * Clip interpolation must also clamp its ratio to [0, 1] and use the midpoint
 * when abs(startDistance - endDistance) < 2^-120, avoiding a division outside
 * the WGSL normal-denominator accuracy contract.
 * The polygon retains relative-world xyz with homogeneous w=1. Clipping uses
 * raw matrix row equations dotted with those world points; only the final
 * surviving points are transformed to clip coordinates for the metric.
 * With h the upper bound on cell width, B_ij = viewport_i/2 *
 * (abs(M_ij) + abs(M_wj)), sigma(J) <= h * ||B||F / w. Therefore a split
 * requires w below the computed cap (or the existing minimum-cell-w guard).
 *
 * The inverse maps that clipped depth domain back into relative world space.
 * Its residual is multiplied by the complete current geometry prism, while
 * f32 coordinate, transform, clipping, and metric errors have separate budgets.
 * Four monotone intersections may reduce those error budgets: outside the last
 * certified domain no split is possible. Seeds are never restricted by a split
 * cap. Uncertifiable arithmetic returns the complete geometry domain.
 *
 * Non-flat bounds additionally map the box-centre support domain: the minimum
 * depth used by the volume metric need not occur at a clipped vertex. This proves
 * candidate completeness for both the clipped-plane and height-volume predicates.
 * @internal
 */
export function gpuWebMercatorQuadCoverCandidates(
    descriptor: GpuWebMercatorQuadCoverDescriptor,
    view: GeoViewSnapshot
): WebMercatorCoverCandidates {

    const { policy, spatialProfile } = descriptor
    const root = spatialProfile.coverage.limit(String(policy.minimumMatrixLevel))
    if (root === undefined) throw new TypeError('Cover candidates require the minimum geometry limit')
    const seedWindow = freezeWindow(root, policy.minimumMatrixLevel, 0)
    const geometry = (level: number): WindowBounds => {
        const scale = 2 ** (level - policy.minimumMatrixLevel)
        return {
            minTileRow: root.minTileRow * scale,
            maxTileRow: (root.maxTileRow + 1) * scale - 1,
            minTileCol: root.minTileCol * scale,
            maxTileCol: (root.maxTileCol + 1) * scale - 1,
        }
    }
    const matrix = Array.from(view.clipFromRelativeWorld, Math.fround)
    const viewport = Array.from(view.referenceViewport, Math.fround)
    const inverse = invert(matrix)
    const encoded = spatialProfile.encodeCamera([
        view.cameraHigh[0] + view.cameraLow[0],
        view.cameraHigh[1] + view.cameraLow[1],
    ])
    const quantum = 2 ** -spatialProfile.coordinateBits
    const camera = [0, 1].map(axis =>
        (encoded.high[axis]! * 2 ** 32 + encoded.low[axis]!) * quantum
    )
    const threshold = Math.fround(policy.maximumCellSpanReferencePixels) *
        (1 + Math.fround(policy.refinementTolerance)) * (1 - gamma(2))
    const cells = Math.fround(policy.cellsPerPatchEdge)
    const reasons = new Set<string>()
    const clipPlanesCertified = rawClipPlaneCoefficientsCertified(matrix)
    const compatible = inverse !== undefined &&
        matrix.every(value => Number.isFinite(value) && Math.abs(value) < MAX_CERTIFIED_MAGNITUDE &&
            (value === 0 || Math.abs(value) >= MIN_NORMAL)) &&
        viewport.every(value => value >= 1 && value <= 2 ** 20) &&
        threshold > 2 ** -30 && threshold < 2 ** 20 &&
        cells >= 1 && cells <= 2 ** 24 &&
        inverse.every(value => Math.abs(value) < MAX_CERTIFIED_MAGNITUDE) &&
        clipPlanesCertified
    if (!compatible) reasons.add(inverse === undefined ? 'singular-matrix' :
        !clipPlanesCertified ? 'uncertified-clip-plane-coefficient' : 'uncertified-numeric-range')
    const residual = inverse === undefined ? undefined : inverseResidual(inverse, matrix)
    let refinementCandidateCount = 0
    const windows: WebMercatorCoverCandidateWindow[] = []
    for (let level = policy.minimumMatrixLevel; level < policy.maximumMatrixLevel; level++) {
        let bounds = geometry(level)
        if (compatible) {
            for (let iteration = 0; iteration < 4; iteration++) {
                const next = boundCandidates({
                    descriptor, view, matrix, viewport, inverse: inverse!, residual: residual!,
                    camera, threshold, cells, level, bounds,
                })
                if (next === undefined) {
                    reasons.add('uncertified-numeric-range')
                    bounds = geometry(level)
                    break
                }
                const narrowed = intersect(bounds, next)
                const unchanged = equalBounds(bounds, narrowed)
                bounds = narrowed
                if (unchanged || windowCount(bounds) === 0) break
            }
        }
        const window = freezeWindow(bounds, level, refinementCandidateCount)
        windows.push(window)
        refinementCandidateCount += window.count
    }
    return Object.freeze({
        ...coverClipWCertificate(matrix, inverse, residual),
        seedWindow,
        windows: Object.freeze(windows),
        candidateCount: seedWindow.count + refinementCandidateCount,
        refinementCandidateCount,
        conservativeFallback: reasons.size > 0,
        fallbackReasons: Object.freeze([...reasons]),
    })
}

function boundCandidates(input: Readonly<{
    descriptor: GpuWebMercatorQuadCoverDescriptor
    view: GeoViewSnapshot
    matrix: readonly number[]
    viewport: readonly number[]
    inverse: readonly number[]
    residual: readonly Interval[]
    camera: readonly number[]
    threshold: number
    cells: number
    level: number
    bounds: WindowBounds
}>): WindowBounds | undefined {

    const { descriptor, view, matrix, viewport, inverse, residual, camera,
        threshold, cells, level, bounds } = input
    const scale = 2 ** level
    const x: Interval = [
        (bounds.minTileCol / scale - camera[0]!) * WORLD_METERS,
        ((bounds.maxTileCol + 1) / scale - camera[0]!) * WORLD_METERS,
    ]
    const y: Interval = [
        (camera[1]! - (bounds.maxTileRow + 1) / scale) * WORLD_METERS,
        (camera[1]! - bounds.minTileRow / scale) * WORLD_METERS,
    ]
    // Two u32 limbs are converted/multiplied and summed without cancellation;
    // gamma(4) covers conversion and product/sum errors. The tile width also
    // includes both endpoint errors before its subtraction and division.
    const xError = upward(gamma(4) * magnitude(x) + 4 * MIN_NORMAL)
    const yError = upward(gamma(4) * magnitude(y) + 4 * MIN_NORMAL)
    const heightLow = Math.fround(descriptor.verticalRangeMeters[0])
    const heightHigh = Math.fround(descriptor.verticalRangeMeters[1])
    const cameraHigh = Math.fround(view.cameraHigh[2])
    const cameraLow = Math.fround(view.cameraLow[2])
    const zError = upward(gamma(12) * (Math.max(Math.abs(heightLow), Math.abs(heightHigh)) +
        Math.abs(cameraHigh) + Math.abs(cameraLow)) + 12 * MIN_NORMAL)
    const prism: Interval[] = [expand(x, xError), expand(y, yError),
        expand([heightLow - cameraHigh - cameraLow, heightHigh - cameraHigh - cameraLow], zError), [1, 1]]
    const cellWidth = upward((WORLD_METERS / scale + 2 * Math.max(xError, yError)) /
        cells * (1 + gamma(8)))
    const clipMagnitude = Math.max(...[0, 1, 2, 3].map(row =>
        absoluteDot(rowValues(matrix, row), prism.map(magnitude))
    ))
    if (!Number.isFinite(clipMagnitude) || clipMagnitude > MAX_CERTIFIED_MAGNITUDE ||
        prism.some(range => range.some(value => !Number.isFinite(value)))) return undefined

    // World-space polygon clipping forms each raw plane before evaluating its
    // two endpoint distances. Per intersection: two 7-operation dots, one row
    // equation add/subtract, denominator subtraction, <=5-unit division, and
    // four-operation mix fit in 32 units. Six times 32, plus 32 for the final
    // transform and 32 propagation allowance, gives 256. Clamped ratios keep
    // the ideal mixed world point in the original prism; w is reset to one.
    // The ratio denominator has no cancellation between opposite signs.
    // The tiny-denominator midpoint can miss its plane by at most 2^-120.
    // FTZ before a world-space multiply requires propagation: coefficient FTZ
    // scales with prism magnitude, world-mix FTZ with matrix row magnitude,
    // while dot/denominator FTZ and the six midpoint guards are clip-space.
    const prismMagnitude = Math.max(...prism.map(magnitude))
    const matrixRowMagnitude = Math.max(...[0, 1, 2, 3].map(row =>
        absoluteDot(rowValues(matrix, row), [1, 1, 1, 1])
    ))
    const absoluteClipError = upward(1024 * MIN_NORMAL *
        upward(1 + upward(prismMagnitude + matrixRowMagnitude)))
    const clipError = upward(gamma(CLIP_OPERATION_UNITS) * clipMagnitude +
        absoluteClipError)
    const clipConstraintError = upward(4 * clipError)
    const b = [0, 1].flatMap(row => [0, 1].map(column =>
        viewport[row]! * 0.5 * (Math.abs(matrix[column * 4 + row]!) +
            Math.abs(matrix[column * 4 + 3]!))
    ))
    // Bound the arithmetic by absolute magnitudes, not relative error in the
    // possibly cancelling (xx-yy). Each clamped-NDC derivative is bounded by
    // h*B_ij/w with <=16 ULP units (including the 5-unit reciprocal). For the
    // computed columns a,b let X=||a||^2,Y=||b||^2. Ignoring the FTZ terms
    // bounded separately below, the three-operation dots give
    // xx,yy in (1 +/- gamma(3))*X,Y and |xy| <= (1+gamma(3))*sqrt(XY).
    // Thus xy^2 <= k^2*xx*yy, k=(1+gamma(3))/(1-gamma(3)), and
    // (xx-yy)^2+4*xy^2 <= k^2*(xx+yy)^2. Propagate magnitudes through the
    // discriminant and trace instead of dividing by their cancelling terms.
    // Allowing 16 units for derivatives, 8 for Gram/k, 32 for discriminant/trace,
    // 24 for two inherited sqrt operations, and 48 for reassociation gives 128.
    // The normalized singular calculation additionally divides both columns by
    // their largest entry. A 512-unit envelope includes that normalization, the
    // 2e-5 absolute L1 numerator allowance (<=4e-5*Frobenius), and the final
    // depth division. Spatial convexity is established separately for N(q).
    // The guard keeps reciprocals below 1/minimumCellW. This absolute budget
    // covers flushed metric intermediates, including the final squared norm,
    // separately from the relative ULP budget. Its permitted viewport and
    // threshold ranges are checked above; extreme inputs use full geometry.
    // The fourth root accounts for absolute flushing errors before the nested
    // discriminant/final square roots; treating them as a relative error alone
    // would be unsound near zero. The second term is already a derivative-entry
    // error in pixels: primitive flushing, then one guarded reciprocal and the
    // pixel multiplier. Frobenius' triangle inequality converts four such entry
    // errors into a stretch error; the factor 1024 includes that factor of two.
    const metricAbsoluteError = upward(16 * Math.sqrt(Math.sqrt(1024 * MIN_NORMAL)) +
        1024 * MIN_NORMAL * (1 + Math.max(...viewport)) * (1 + 1 / MINIMUM_CELL_W))
    const effectiveThreshold = threshold - metricAbsoluteError
    if (effectiveThreshold <= 0) return undefined
    const metricCap = upward(cellWidth * Math.hypot(...b) *
        (1 + gamma(METRIC_OPERATION_UNITS)) / effectiveThreshold)
    const guardCap = upward((MINIMUM_CELL_W + 0.5 * cellWidth *
        (Math.abs(matrix[3]!) + Math.abs(matrix[7]!)) * (1 + gamma(8))) * (1 + gamma(4)))
    const depthCap = Math.max(metricCap, guardCap)
    if (!Number.isFinite(depthCap) || depthCap > MAX_CERTIFIED_MAGNITUDE) return undefined
    // The volume predicate may use the minimum w at an UNCLIPPED box corner.
    // If it splits, minBoxW <= depthCap. For a potentially visible box, its
    // centre satisfies -Rw <= centreW <= depthCap+Rw and each clip-plane
    // support bounds centreX/Y/Z. The radii include the complete height range.
    // Mapping these centre intervals is conservative even if no corner is visible.
    const volume = heightLow !== heightHigh
    let r = [0, 0, 0, 0]
    if (volume) {
        const radius = [upward(WORLD_METERS / scale * 0.5 + xError),
            upward(WORLD_METERS / scale * 0.5 + yError),
            upward((heightHigh - heightLow) * 0.5 + zError), 0]
        r = [0, 1, 2, 3].map(row => absoluteDot(rowValues(matrix, row), radius))
    }
    const extra = volume ? r.map(value => upward(value + 2 * r[3]!)) : [0, 0, 0, 0]
    const clipped: Interval[] = [
        [-depthCap - clipConstraintError - extra[0]!, depthCap + clipConstraintError + extra[0]!],
        [-depthCap - clipConstraintError - extra[1]!, depthCap + clipConstraintError + extra[1]!],
        [-clipConstraintError - (volume ? r[2]! : 0), depthCap + clipConstraintError + extra[2]!],
        [-clipConstraintError - (volume ? r[3]! : 0), depthCap + (volume ? r[3]! : 0)],
    ]
    const projected = [0, 1].map(row => {
        const fromClip = intervalDot(rowValues(inverse, row), clipped)
        const fromResidual = intervalProducts(
            [0, 1, 2, 3].map(column => residual[row * 4 + column]!), prism
        )
        const associationError = absoluteDot(rowValues(inverse, row), [clipError, clipError, clipError, clipError])
        return expand(addIntervals(fromClip, fromResidual), associationError)
    })
    if (projected.some(range => range.some(value => !Number.isFinite(value)))) return undefined
    const normalizedX = expand(projected[0]!, xError)
    const normalizedY = expand(projected[1]!, yError)
    // Closed tile/sample intersection: ceil(lower)-1 includes a tile whose east
    // or south boundary touches the interval. This is not a radius allowance.
    return {
        minTileCol: Math.ceil(downward((normalizedX[0] / WORLD_METERS + camera[0]!) * scale)) - 1,
        maxTileCol: Math.floor(upward((normalizedX[1] / WORLD_METERS + camera[0]!) * scale)),
        minTileRow: Math.ceil(downward((camera[1]! - normalizedY[1] / WORLD_METERS) * scale)) - 1,
        maxTileRow: Math.floor(upward((camera[1]! - normalizedY[0] / WORLD_METERS) * scale)),
    }
}

/** @internal A residual certificate for positive clip-w throughout the visible frustum. */
export function coverClipWCertificate(
    matrix: readonly number[], inverse = invert(matrix), residuals?: readonly Interval[]
) {
    const empty = { clipWPositive: [0, 0, 0, 0], clipWNegative: [0, 0, 0, 0],
        clipWResidual: Array.from({ length: 4 }, () => [0, 0, 0, 0]) }
    if (inverse === undefined) return empty
    // p_j=k_j*M*p+(e_j-k_j*M)*p. Each positive/negative coordinate slab
    // therefore gives a lower clip-w bound over qx/qy in [-1,1], qz in [0,1].
    // The homogeneous row also bounds a frustum entirely inside the height slab.
    // Outward residuals certify the actual k, without assuming an exact inverse.
    const upperF32 = (value: number) => value <= 0 ? 0 :
        Math.fround(upward(value * (1 + 2 ** -23) + MIN_NORMAL))
    const positive = [], negative = [], residual = residuals ?? inverseResidual(inverse, matrix)
    for (let row = 0; row < 4; row++) {
        const k = rowValues(inverse, row)
        const xy = addIntervals([Math.abs(k[0]!), Math.abs(k[0]!)],
            [Math.abs(k[1]!), Math.abs(k[1]!)])
        const sum = (sign: number) => addIntervals(xy, addIntervals(
            [Math.max(0, sign * k[2]!), Math.max(0, sign * k[2]!)],
            [sign * k[3]!, sign * k[3]!]))[1]
        positive.push(upperF32(sum(1)))
        negative.push(upperF32(sum(-1)))
    }
    const clipWResidual = Array.from({ length: 4 }, (_, row) =>
        residual.slice(row * 4, row * 4 + 4).map(range => upperF32(magnitude(range))))
    if (![...positive, ...negative, ...clipWResidual.flat()].every(Number.isFinite)) return empty
    return { clipWPositive: positive, clipWNegative: negative, clipWResidual }
}

function gamma(operations: number): number {
    return upward(operations * UNIT / (1 - operations * UNIT))
}

function magnitude(range: Interval): number {
    return Math.max(Math.abs(range[0]), Math.abs(range[1]))
}

function expand(range: Interval, error: number): Interval {
    return [downward(range[0] - error), upward(range[1] + error)]
}

function addIntervals(left: Interval, right: Interval): Interval {
    return [downward(left[0] + right[0]), upward(left[1] + right[1])]
}

function intervalProducts(left: readonly Interval[], right: readonly Interval[]): Interval {
    let result: Interval = [0, 0]
    for (let index = 0; index < left.length; index++) {
        const a = left[index]!
        const b = right[index]!
        const products = [a[0] * b[0], a[0] * b[1], a[1] * b[0], a[1] * b[1]]
        result = addIntervals(result, [downward(Math.min(...products)), upward(Math.max(...products))])
    }
    return result
}

function intervalDot(values: readonly number[], ranges: readonly Interval[]): Interval {
    return intervalProducts(values.map(value => [value, value]), ranges)
}

function absoluteDot(left: readonly number[], right: readonly number[]): number {
    return left.reduce((sum, value, index) => upward(sum + upward(Math.abs(value) * right[index]!)), 0)
}

function rowValues(matrix: readonly number[], row: number): number[] {
    return [0, 1, 2, 3].map(column => matrix[column * 4 + row]!)
}

function rawClipPlaneCoefficientsCertified(matrix: readonly number[]): boolean {
    const rows = [0, 1, 2, 3].map(row => rowValues(matrix, row))
    const planes = [
        rows[2]!,
        rows[3]!.map((value, index) => value - rows[2]![index]!),
        rows[3]!.map((value, index) => value + rows[0]![index]!),
        rows[3]!.map((value, index) => value - rows[0]![index]!),
        rows[3]!.map((value, index) => value + rows[1]![index]!),
        rows[3]!.map((value, index) => value - rows[1]![index]!),
    ]
    // Test the sum/difference before fround as well: an unrepresentable small
    // coefficient must not be certified merely because it became zero.
    return planes.every(plane => plane.every(value => Number.isFinite(value) &&
        (value === 0 || (Math.abs(value) >= MIN_NORMAL &&
            Math.abs(Math.fround(value)) >= MIN_NORMAL))))
}

function inverseResidual(inverse: readonly number[], matrix: readonly number[]): Interval[] {
    return [0, 1, 2, 3].flatMap(row => [0, 1, 2, 3].map(column => {
        const product = intervalDot(rowValues(inverse, row),
            [0, 1, 2, 3].map(index => [matrix[column * 4 + index]!, matrix[column * 4 + index]!] as Interval))
        const identity = row === column ? 1 : 0
        return [downward(identity - product[1]), upward(identity - product[0])] as Interval
    }))
}

function invert(matrix: readonly number[]): number[] | undefined {
    if (matrix.length !== 16 || matrix.some(value => !Number.isFinite(value))) return undefined
    const rows = [0, 1, 2, 3].map(row => [
        ...rowValues(matrix, row), ...[0, 1, 2, 3].map(column => row === column ? 1 : 0),
    ])
    for (let column = 0; column < 4; column++) {
        let pivot = column
        for (let row = column + 1; row < 4; row++) {
            if (Math.abs(rows[row]![column]!) > Math.abs(rows[pivot]![column]!)) pivot = row
        }
        if (rows[pivot]![column] === 0) return undefined
        const previous = rows[column]!
        rows[column] = rows[pivot]!
        rows[pivot] = previous
        const divisor = rows[column]![column]!
        rows[column] = rows[column]!.map(value => value / divisor)
        for (let row = 0; row < 4; row++) {
            if (row === column) continue
            const factor = rows[row]![column]!
            rows[row] = rows[row]!.map((value, index) => value - factor * rows[column]![index]!)
        }
    }
    const result = [0, 1, 2, 3].flatMap(column => [0, 1, 2, 3].map(row => rows[row]![column + 4]!))
    return result.every(Number.isFinite) ? result : undefined
}

function intersect(left: WindowBounds, right: WindowBounds): WindowBounds {
    const result = {
        minTileRow: Math.max(left.minTileRow, right.minTileRow),
        maxTileRow: Math.min(left.maxTileRow, right.maxTileRow),
        minTileCol: Math.max(left.minTileCol, right.minTileCol),
        maxTileCol: Math.min(left.maxTileCol, right.maxTileCol),
    }
    // Empty windows have an explicit non-negative sentinel for u32 metadata.
    return windowCount(result) === 0
        ? { minTileRow: 1, maxTileRow: 0, minTileCol: 1, maxTileCol: 0 }
        : result
}

function equalBounds(left: WindowBounds, right: WindowBounds): boolean {
    return left.minTileRow === right.minTileRow && left.maxTileRow === right.maxTileRow &&
        left.minTileCol === right.minTileCol && left.maxTileCol === right.maxTileCol
}

function windowCount(bounds: WindowBounds): number {
    return Math.max(0, bounds.maxTileRow - bounds.minTileRow + 1) *
        Math.max(0, bounds.maxTileCol - bounds.minTileCol + 1)
}

function freezeWindow(bounds: WindowBounds, matrixLevel: number, offset: number): WebMercatorCoverCandidateWindow {
    return Object.freeze({
        matrixLevel, minTileRow: bounds.minTileRow, maxTileRow: bounds.maxTileRow,
        minTileCol: bounds.minTileCol, maxTileCol: bounds.maxTileCol,
        offset, count: windowCount(bounds),
    })
}

function upward(value: number): number {
    if (!Number.isFinite(value)) return value
    if (value === 0) return Number.MIN_VALUE
    rounds.setFloat64(0, value)
    let high = rounds.getUint32(0)
    let low = rounds.getUint32(4)
    if (value > 0) {
        low = (low + 1) >>> 0
        if (low === 0) high = (high + 1) >>> 0
    } else {
        if (low === 0) high = (high - 1) >>> 0
        low = (low - 1) >>> 0
    }
    rounds.setUint32(0, high)
    rounds.setUint32(4, low)
    return rounds.getFloat64(0)
}

function downward(value: number): number {
    return -upward(-value)
}
