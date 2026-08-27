export type FlowContourPoint = readonly [number, number]
export type FlowContourSegment = readonly [FlowContourPoint, FlowContourPoint]

const CASE_EDGES: Readonly<Record<number, readonly (readonly [number, number])[]>> =
    Object.freeze({
        0: [],
        1: [ [ 3, 0 ] ],
        2: [ [ 0, 1 ] ],
        3: [ [ 3, 1 ] ],
        4: [ [ 1, 2 ] ],
        6: [ [ 0, 2 ] ],
        7: [ [ 3, 2 ] ],
        8: [ [ 2, 3 ] ],
        9: [ [ 0, 2 ] ],
        11: [ [ 1, 2 ] ],
        12: [ [ 1, 3 ] ],
        13: [ [ 0, 1 ] ],
        14: [ [ 3, 0 ] ],
        15: [],
    })

/** Evaluates one bilinear cell using top-left, top-right, bottom-right, bottom-left values. */
export function flowContourSegments(
    inputValues: readonly number[],
    threshold: number
): readonly FlowContourSegment[] {

    if (!Array.isArray(inputValues) || inputValues.length !== 4 ||
        inputValues.some(value => !Number.isFinite(value)) || !Number.isFinite(threshold)) {
        throw new TypeError('Flow contour requires four finite corner values and one threshold')
    }
    const values = inputValues.map(value => value - threshold)
    const code = values.reduce((result, value, index) =>
        result | (value >= 0 ? 1 << index : 0), 0)
    const edgePairs = code === 5 || code === 10
        ? ambiguousEdges(code, values)
        : CASE_EDGES[code]!
    return Object.freeze(edgePairs.map(pair => Object.freeze([
        edgePoint(pair[0], values),
        edgePoint(pair[1], values),
    ]) as FlowContourSegment))
}

/** Assigns each logical contour cell to the page containing its top-left texel. */
export function ownsFlowContourCell(input: Readonly<{
    cellX: number
    cellY: number
    pageCol: number
    pageRow: number
    pageSize: number
    globalWidth: number
    globalHeight: number
}>): boolean {

    for (const value of [
        input?.cellX,
        input?.cellY,
        input?.pageCol,
        input?.pageRow,
        input?.pageSize,
        input?.globalWidth,
        input?.globalHeight,
    ]) {
        if (!Number.isSafeInteger(value) || value < 0) {
            throw new TypeError('Flow contour ownership requires non-negative integer facts')
        }
    }
    if (input.pageSize === 0 || input.globalWidth === 0 || input.globalHeight === 0) {
        throw new RangeError('Flow contour dimensions must be positive')
    }
    if (input.cellX >= input.globalWidth - 1 || input.cellY >= input.globalHeight - 1) {
        return false
    }
    const originX = input.pageCol * input.pageSize
    const originY = input.pageRow * input.pageSize
    return input.cellX >= originX && input.cellX < originX + input.pageSize &&
        input.cellY >= originY && input.cellY < originY + input.pageSize
}

/** Computes the hard two-segment-per-cell capacity bound without truncation. */
export function flowContourCapacity(input: Readonly<{
    candidateCellCount: number
    segmentCapacity: number
}>): Readonly<{
    requiredMaximum: number
    capacity: number
    overflow: boolean
}> {

    if (!Number.isSafeInteger(input?.candidateCellCount) || input.candidateCellCount < 0 ||
        !Number.isSafeInteger(input?.segmentCapacity) || input.segmentCapacity < 0 ||
        input.candidateCellCount > Math.floor(Number.MAX_SAFE_INTEGER / 2)) {
        throw new RangeError('Flow contour capacity requires bounded non-negative integers')
    }
    const requiredMaximum = input.candidateCellCount * 2
    return Object.freeze({
        requiredMaximum,
        capacity: input.segmentCapacity,
        overflow: requiredMaximum > input.segmentCapacity,
    })
}

function ambiguousEdges(
    code: 5 | 10,
    values: readonly number[]
): readonly (readonly [number, number])[] {

    const determinant = values[0]! * values[2]! - values[1]! * values[3]!
    if (code === 5) {
        return determinant >= 0
            ? [ [ 0, 1 ], [ 2, 3 ] ]
            : [ [ 3, 0 ], [ 1, 2 ] ]
    }
    return determinant >= 0
        ? [ [ 3, 0 ], [ 1, 2 ] ]
        : [ [ 0, 1 ], [ 2, 3 ] ]
}

function edgePoint(edge: number, values: readonly number[]): FlowContourPoint {

    switch (edge) {
        case 0: return Object.freeze([ interpolation(values[0]!, values[1]!), 0 ])
        case 1: return Object.freeze([ 1, interpolation(values[1]!, values[2]!) ])
        case 2: return Object.freeze([ 1 - interpolation(values[2]!, values[3]!), 1 ])
        case 3: return Object.freeze([ 0, 1 - interpolation(values[3]!, values[0]!) ])
        default: throw new RangeError(`Unknown Flow contour edge ${edge}`)
    }
}

function interpolation(first: number, second: number): number {

    const denominator = first - second
    if (denominator === 0) return 0.5
    return Math.min(1, Math.max(0, first / denominator))
}
