import { throwGeoDiagnostic } from './diagnostics.js'
import type { GeoViewSnapshot } from './geo-view.js'
import type { GpuWebMercatorQuadCoverPolicy } from './gpu-web-mercator-quad-cover.js'
import type { WebMercatorTileVerticalBounds } from './gpu-web-mercator-quad-cover.js'
import type { WebMercatorPlanarTileSpatialProfile } from './tile-spatial-profile.js'
import { WebMercatorQuad } from './web-mercator-quad.js'

export type GpuWebMercatorQuadCoverReferenceBounds = Readonly<{
    west: number
    north: number
    east: number
    south: number
}>

export type GpuWebMercatorQuadCoverReferenceInput = Readonly<{
    spatialProfile: WebMercatorPlanarTileSpatialProfile
    policy: GpuWebMercatorQuadCoverPolicy
    view: GeoViewSnapshot
    visibleBounds: GpuWebMercatorQuadCoverReferenceBounds
    verticalRangeMeters: readonly [number, number]
    verticalBounds?: readonly WebMercatorTileVerticalBounds[]
}>

export type GpuWebMercatorQuadCoverReferencePatch = Readonly<{
    kind: 'gpu-web-mercator-quad-cover-patch'
    tileMatrixSetId: 'WebMercatorQuad'
    matrixId: string
    matrixLevel: number
    tileRow: number
    tileCol: number
    key: string
}>

export type GpuWebMercatorQuadCoverReferenceResult = Readonly<{
    patches: readonly GpuWebMercatorQuadCoverReferencePatch[]
    facts: Readonly<{
        selectionPath: 'gpu-camera-inverse-webmercatorquad-cover'
        finestMatrixLevel: number
        minimumMatrixLevel: number
        maximumMatrixLevel: number
        candidateCount: number
        patchCount: number
        verticalBoundsMode: 'global' | 'hierarchy'
        verticalBoundCount: number
        minimumCellSpanReferencePixels?: number
        maximumCellSpanReferencePixels?: number
    }>
}>

type IntegerBounds = Readonly<{
    minTileRow: number
    maxTileRow: number
    minTileCol: number
    maxTileCol: number
}>

/**
 * CPU oracle for the deterministic adaptive projected-cell construction used by
 * the GPU WebMercatorQuad inverse cover.
 */
export function evaluateGpuWebMercatorQuadCoverReference(
    input: GpuWebMercatorQuadCoverReferenceInput
): GpuWebMercatorQuadCoverReferenceResult {

    validateInput(input)
    const generated = generateVariable(input, cameraFixedPosition(input))
    if (generated.patches.length > input.policy.maximumPatches) {
        return invalidCover(
            'The minimum standard cover exceeds its declared patch capacity.',
            {
                maximumPatches: input.policy.maximumPatches,
                minimumMatrixLevel: input.policy.minimumMatrixLevel,
            },
            { patchCount: generated.patches.length }
        )
    }
    return Object.freeze({
        patches: Object.freeze(generated.patches),
        facts: Object.freeze({
            selectionPath: 'gpu-camera-inverse-webmercatorquad-cover' as const,
            finestMatrixLevel: generated.finestMatrixLevel,
            minimumMatrixLevel: minimumPatchLevel(generated.patches),
            maximumMatrixLevel: maximumPatchLevel(generated.patches),
            candidateCount: generated.candidateCount,
            patchCount: generated.patches.length,
            verticalBoundsMode: input.verticalBounds === undefined
                ? 'global' as const
                : 'hierarchy' as const,
            verticalBoundCount: input.verticalBounds?.length ?? 0,
            ...(generated.cellSpans.length === 0 ? {} : {
                minimumCellSpanReferencePixels: Math.min(...generated.cellSpans),
                maximumCellSpanReferencePixels: Math.max(...generated.cellSpans),
            }),
        }),
    })
}

function generateVariable(
    input: GpuWebMercatorQuadCoverReferenceInput,
    fixedCamera: readonly [bigint, bigint]
) {

    const refinements = sparseRefinements(input, fixedCamera)
    let candidateCount = refinements.candidateCount
    const seeded = seedMinimumPatches(input)
    candidateCount += seeded.candidateCount
    let materialized = seeded.patches
    for (let matrixLevel = input.policy.minimumMatrixLevel;
        matrixLevel < input.policy.maximumMatrixLevel;
        matrixLevel++) {
        const next: GpuWebMercatorQuadCoverReferencePatch[] = []
        for (const patch of materialized) {
            if (patch.matrixLevel !== matrixLevel ||
                !refinements.parents.has(patch.key)) {
                next.push(patch)
                continue
            }
            const children = childPatches(patch)
            candidateCount += children.length
            next.push(...children)
        }
        if (next.length > input.policy.maximumPatches) {
            return invalidCover(
                'The sparse standard cover exceeds its declared patch capacity.',
                { maximumPatches: input.policy.maximumPatches },
                { patchCount: next.length }
            )
        }
        materialized = next.filter(patch =>
            intersectsVisible(patch, input.visibleBounds)
        )
    }
    const patchesOutput = materialized
    candidateCount += balancePatches(input, patchesOutput)
    patchesOutput.sort(comparePatch)
    return {
        patches: patchesOutput,
        candidateCount,
        cellSpans: patchesOutput.map(patch => projectedCellSpanPixels(input, patch)),
        finestMatrixLevel: refinements.finestMatrixLevel,
    }
}

function sparseRefinements(
    input: GpuWebMercatorQuadCoverReferenceInput,
    fixedCamera: readonly [bigint, bigint]
): Readonly<{
    parents: ReadonlySet<string>
    candidateCount: number
    finestMatrixLevel: number
}> {

    const parents = new Set<string>()
    const radius = projectedSearchRadius(input)
    let candidateCount = 0
    let finestMatrixLevel = input.policy.minimumMatrixLevel
    for (let parentLevel = input.policy.minimumMatrixLevel;
        parentLevel < input.policy.maximumMatrixLevel;
        parentLevel++) {
        const parentLimit = geometryLimit(input, parentLevel)
        const cameraRow = cameraTileIndex(
            fixedCamera[1],
            parentLevel,
            input.spatialProfile.coordinateBits
        )
        const cameraCol = cameraTileIndex(
            fixedCamera[0],
            parentLevel,
            input.spatialProfile.coordinateBits
        )
        const search = fitWindow({
            minTileRow: cameraRow - radius,
            maxTileRow: cameraRow + radius,
            minTileCol: cameraCol - radius,
            maxTileCol: cameraCol + radius,
        }, parentLimit)
        for (let tileRow = search.minTileRow; tileRow <= search.maxTileRow; tileRow++) {
            for (let tileCol = search.minTileCol; tileCol <= search.maxTileCol; tileCol++) {
                candidateCount++
                if (parentLevel > input.policy.minimumMatrixLevel && !parents.has(
                    `${parentLevel - 1}/${Math.floor(tileRow / 2)}/${Math.floor(tileCol / 2)}`
                )) continue
                const parent = referencePatch(parentLevel, tileRow, tileCol)
                if (!intersectsVisible(parent, input.visibleBounds) ||
                    projectedCellSpanPixels(input, parent) <=
                        effectiveCellSpanThreshold(input)) continue
                parents.add(parent.key)
                finestMatrixLevel = Math.max(finestMatrixLevel, parentLevel + 1)
            }
        }
    }
    return Object.freeze({ parents, candidateCount, finestMatrixLevel })
}

function seedMinimumPatches(
    input: GpuWebMercatorQuadCoverReferenceInput
): Readonly<{
    patches: GpuWebMercatorQuadCoverReferencePatch[]
    candidateCount: number
}> {

    const matrixLevel = input.policy.minimumMatrixLevel
    const window = geometryLimit(input, matrixLevel)
    const patches: GpuWebMercatorQuadCoverReferencePatch[] = []
    let candidateCount = 0
    for (let tileRow = window.minTileRow; tileRow <= window.maxTileRow; tileRow++) {
        for (let tileCol = window.minTileCol; tileCol <= window.maxTileCol; tileCol++) {
            candidateCount++
            const patch = referencePatch(matrixLevel, tileRow, tileCol)
            if (intersectsVisible(patch, input.visibleBounds)) patches.push(patch)
        }
    }
    return Object.freeze({ patches, candidateCount })
}

function childPatches(
    parent: GpuWebMercatorQuadCoverReferencePatch
): readonly GpuWebMercatorQuadCoverReferencePatch[] {

    const matrixLevel = parent.matrixLevel + 1
    const tileRow = parent.tileRow * 2
    const tileCol = parent.tileCol * 2
    return Object.freeze([
        referencePatch(matrixLevel, tileRow, tileCol),
        referencePatch(matrixLevel, tileRow, tileCol + 1),
        referencePatch(matrixLevel, tileRow + 1, tileCol),
        referencePatch(matrixLevel, tileRow + 1, tileCol + 1),
    ])
}

function balancePatches(
    input: GpuWebMercatorQuadCoverReferenceInput,
    patches: GpuWebMercatorQuadCoverReferencePatch[]
): number {

    let candidateCount = 0
    for (let iteration = 0; iteration < 24; iteration++) {
        const inputCount = patches.length
        let changed = false
        for (let patchIndex = 0; patchIndex < inputCount; patchIndex++) {
            const candidate = patches[patchIndex]!
            if (!patches.some((other, otherIndex) =>
                otherIndex !== patchIndex &&
                other.matrixLevel > candidate.matrixLevel + 1 &&
                edgeAdjacentAtLevel(
                    candidate,
                    other,
                    input.policy.maximumMatrixLevel
                )
            )) continue
            const children = childPatches(candidate)
            const patchCount = patches.length + 3
            if (patchCount > input.policy.maximumPatches) {
                return invalidCover(
                    'The balanced standard cover exceeds its declared patch capacity.',
                    { maximumPatches: input.policy.maximumPatches },
                    { patchCount }
                )
            }
            candidateCount += 4
            if (children.length === 0) continue
            patches[patchIndex] = children[0]!
            patches.push(...children.slice(1))
            changed = true
        }
        if (!changed) break
    }
    const visible = patches.filter(patch =>
        intersectsVisible(patch, input.visibleBounds)
    )
    patches.splice(0, patches.length, ...visible)
    return candidateCount
}

function edgeAdjacentAtLevel(
    left: GpuWebMercatorQuadCoverReferencePatch,
    right: GpuWebMercatorQuadCoverReferencePatch,
    maximumMatrixLevel: number
): boolean {

    const bounds = (patch: GpuWebMercatorQuadCoverReferencePatch) => {
        const scale = 2 ** (maximumMatrixLevel - patch.matrixLevel)
        return {
            west: patch.tileCol * scale,
            north: patch.tileRow * scale,
            east: (patch.tileCol + 1) * scale,
            south: (patch.tileRow + 1) * scale,
        }
    }
    const a = bounds(left)
    const b = bounds(right)
    const horizontal = (a.east === b.west || b.east === a.west) &&
        Math.max(a.north, b.north) < Math.min(a.south, b.south)
    const vertical = (a.south === b.north || b.south === a.north) &&
        Math.max(a.west, b.west) < Math.min(a.east, b.east)
    return horizontal || vertical
}

function cameraFixedPosition(
    input: GpuWebMercatorQuadCoverReferenceInput
): readonly [bigint, bigint] {

    const encoded = input.spatialProfile.encodeCamera([
        input.view.cameraHigh[0] + input.view.cameraLow[0],
        input.view.cameraHigh[1] + input.view.cameraLow[1],
    ])
    return Object.freeze([
        (BigInt(encoded.high[0]) << 32n) | BigInt(encoded.low[0]),
        (BigInt(encoded.high[1]) << 32n) | BigInt(encoded.low[1]),
    ]) as readonly [bigint, bigint]
}

function cameraTileIndex(
    fixed: bigint,
    matrixLevel: number,
    coordinateBits: number
): number {

    const fractionalBits = BigInt(coordinateBits - matrixLevel)
    return Number(fixed >> fractionalBits)
}

function projectedSearchRadius(input: GpuWebMercatorQuadCoverReferenceInput): number {

    const focalPixels = input.view.referenceViewport[1] /
        (2 * Math.tan(input.view.verticalFovRadians / 2))
    return Math.max(2, Math.ceil(
        focalPixels /
        (input.policy.cellsPerPatchEdge * effectiveCellSpanThreshold(input))
    ) + 2)
}

function effectiveCellSpanThreshold(
    input: GpuWebMercatorQuadCoverReferenceInput
): number {

    return input.policy.maximumCellSpanReferencePixels *
        (1 + input.policy.refinementTolerance)
}

function geometryLimit(
    input: GpuWebMercatorQuadCoverReferenceInput,
    matrixLevel: number
): IntegerBounds {

    const rootLevel = input.policy.minimumMatrixLevel
    const root = input.spatialProfile.coverage.limit(String(rootLevel))
    if (root === undefined || matrixLevel < rootLevel) {
        return invalidCover(
            'Cover levels require one standard minimum-level safety domain.',
            { minimumMatrixLevel: rootLevel },
            { matrixLevel, limits: input.spatialProfile.coverage.limits }
        )
    }
    const scale = 2 ** (matrixLevel - rootLevel)
    return Object.freeze({
        minTileRow: root.minTileRow * scale,
        maxTileRow: (root.maxTileRow + 1) * scale - 1,
        minTileCol: root.minTileCol * scale,
        maxTileCol: (root.maxTileCol + 1) * scale - 1,
    })
}

function referencePatch(
    matrixLevel: number,
    tileRow: number,
    tileCol: number
): GpuWebMercatorQuadCoverReferencePatch {

    const tile = WebMercatorQuad.tile({
        matrixId: String(matrixLevel),
        tileRow,
        tileCol,
    })
    return Object.freeze({
        kind: 'gpu-web-mercator-quad-cover-patch' as const,
        tileMatrixSetId: 'WebMercatorQuad' as const,
        matrixId: tile.matrixId,
        matrixLevel,
        tileRow: tile.tileRow,
        tileCol: tile.tileCol,
        key: tile.key,
    })
}

function fitWindow(bounds: IntegerBounds, limit: IntegerBounds): IntegerBounds {

    const height = Math.min(
        bounds.maxTileRow - bounds.minTileRow + 1,
        limit.maxTileRow - limit.minTileRow + 1
    )
    const width = Math.min(
        bounds.maxTileCol - bounds.minTileCol + 1,
        limit.maxTileCol - limit.minTileCol + 1
    )
    const minTileRow = fitStart(
        bounds.minTileRow,
        height,
        limit.minTileRow,
        limit.maxTileRow
    )
    const minTileCol = fitStart(
        bounds.minTileCol,
        width,
        limit.minTileCol,
        limit.maxTileCol
    )
    return Object.freeze({
        minTileRow,
        maxTileRow: minTileRow + height - 1,
        minTileCol,
        maxTileCol: minTileCol + width - 1,
    })
}

function fitStart(value: number, span: number, minimum: number, maximum: number): number {

    return clamp(value, minimum, maximum - span + 1)
}

function intersectsVisible(
    patch: GpuWebMercatorQuadCoverReferencePatch,
    visible: GpuWebMercatorQuadCoverReferenceBounds
): boolean {

    const size = 2 ** patch.matrixLevel
    return (patch.tileCol + 1) / size > visible.west &&
        patch.tileCol / size < visible.east &&
        (patch.tileRow + 1) / size > visible.north &&
        patch.tileRow / size < visible.south
}

type ClipPoint = readonly [number, number, number, number]

function projectedCellSpanPixels(
    input: GpuWebMercatorQuadCoverReferenceInput,
    patch: GpuWebMercatorQuadCoverReferencePatch
): number {

    const bounds = WebMercatorQuad.tileBounds(WebMercatorQuad.tile({
        matrixId: patch.matrixId,
        tileRow: patch.tileRow,
        tileCol: patch.tileCol,
    })).projected
    const cameraX = input.view.cameraHigh[0] + input.view.cameraLow[0]
    const cameraY = input.view.cameraHigh[1] + input.view.cameraLow[1]
    const cameraZ = input.view.cameraHigh[2] + input.view.cameraLow[2]
    const relative = {
        minimumX: bounds.west - cameraX,
        maximumX: bounds.east - cameraX,
        minimumY: bounds.south - cameraY,
        maximumY: bounds.north - cameraY,
    }
    return Math.max(...verticalRangeForPatch(input, patch).map(vertical =>
        projectedPlaneCellSpanPixels(
            input,
            relative,
            vertical - cameraZ
        )
    ))
}

function verticalRangeForPatch(
    input: GpuWebMercatorQuadCoverReferenceInput,
    patch: GpuWebMercatorQuadCoverReferencePatch
): readonly [number, number] {

    const hierarchy = input.verticalBounds
    if (hierarchy === undefined) return input.verticalRangeMeters
    const boundsMaximumMatrixLevel = Number(
        input.spatialProfile.coverage.limits.at(-1)!.matrixId
    )
    const matrixLevel = Math.min(
        patch.matrixLevel,
        boundsMaximumMatrixLevel
    )
    const shift = patch.matrixLevel - matrixLevel
    const tileRow = patch.tileRow >> shift
    const tileCol = patch.tileCol >> shift
    const bounds = hierarchy.find(entry =>
        entry.matrixLevel === matrixLevel &&
        entry.tileRow === tileRow && entry.tileCol === tileCol
    )!
    return [ bounds.minimumVerticalMeters, bounds.maximumVerticalMeters ]
}

function projectedPlaneCellSpanPixels(
    input: GpuWebMercatorQuadCoverReferenceInput,
    bounds: Readonly<{
        minimumX: number
        maximumX: number
        minimumY: number
        maximumY: number
    }>,
    vertical: number
): number {

    const matrix = input.view.clipFromRelativeWorld
    let polygon: ClipPoint[] = [
        multiplyClip(matrix, [ bounds.minimumX, bounds.minimumY, vertical, 1 ]),
        multiplyClip(matrix, [ bounds.maximumX, bounds.minimumY, vertical, 1 ]),
        multiplyClip(matrix, [ bounds.maximumX, bounds.maximumY, vertical, 1 ]),
        multiplyClip(matrix, [ bounds.minimumX, bounds.maximumY, vertical, 1 ]),
    ]
    for (let plane = 0; plane < 6 && polygon.length > 0; plane++) {
        polygon = clipPolygonToPlane(polygon, plane)
    }
    if (polygon.length === 0) return 0

    const cellMeters = (bounds.maximumX - bounds.minimumX) /
        input.policy.cellsPerPatchEdge
    const xDelta: ClipPoint = [
        matrix[0]! * cellMeters,
        matrix[1]! * cellMeters,
        matrix[2]! * cellMeters,
        matrix[3]! * cellMeters,
    ]
    const yDelta: ClipPoint = [
        matrix[4]! * cellMeters,
        matrix[5]! * cellMeters,
        matrix[6]! * cellMeters,
        matrix[7]! * cellMeters,
    ]
    return Math.max(...polygon.map(point => projectedCellMaximumStretchPixels(
        input.view.referenceViewport,
        point,
        xDelta,
        yDelta
    )))
}

function multiplyClip(matrix: readonly number[], point: ClipPoint): ClipPoint {

    return Object.freeze([ 0, 1, 2, 3 ].map(row =>
        matrix[row]! * point[0] +
        matrix[row + 4]! * point[1] +
        matrix[row + 8]! * point[2] +
        matrix[row + 12]! * point[3]
    )) as unknown as ClipPoint
}

function clipPolygonToPlane(input: readonly ClipPoint[], plane: number): ClipPoint[] {

    if (input.length === 0) return []
    const output: ClipPoint[] = []
    let start = input.at(-1)!
    let startDistance = clipPlaneDistance(start, plane)
    for (const end of input) {
        const endDistance = clipPlaneDistance(end, plane)
        const startInside = startDistance >= 0
        const endInside = endDistance >= 0
        if (startInside !== endInside) {
            const ratio = startDistance / (startDistance - endDistance)
            output.push(Object.freeze(start.map((value, index) =>
                value + (end[index]! - value) * ratio
            )) as unknown as ClipPoint)
        }
        if (endInside) output.push(end)
        start = end
        startDistance = endDistance
    }
    return output
}

function clipPlaneDistance(point: ClipPoint, plane: number): number {

    switch (plane) {
        case 0: return point[2]
        case 1: return point[3] - point[2]
        case 2: return point[0] + point[3]
        case 3: return point[3] - point[0]
        case 4: return point[1] + point[3]
        default: return point[3] - point[1]
    }
}

function projectedCellMaximumStretchPixels(
    viewport: readonly [number, number],
    clip: ClipPoint,
    xDelta: ClipPoint,
    yDelta: ClipPoint
): number {

    const minimumCellW = clip[3] - 0.5 * (Math.abs(xDelta[3]) + Math.abs(yDelta[3]))
    if (minimumCellW <= 1e-5) return Math.max(...viewport)
    const xPixels = projectedAxisCellDeltaPixels(viewport, clip, xDelta)
    const yPixels = projectedAxisCellDeltaPixels(viewport, clip, yDelta)
    const xx = xPixels[0] ** 2 + xPixels[1] ** 2
    const xy = xPixels[0] * yPixels[0] + xPixels[1] * yPixels[1]
    const yy = yPixels[0] ** 2 + yPixels[1] ** 2
    const discriminant = Math.sqrt(Math.max(
        0,
        (xx - yy) ** 2 + 4 * xy ** 2
    ))
    const maximumStretch = Math.sqrt(Math.max(
        0,
        0.5 * (xx + yy + discriminant)
    ))
    return maximumStretch
}

function projectedAxisCellDeltaPixels(
    viewport: readonly [number, number],
    clip: ClipPoint,
    delta: ClipPoint
): readonly [number, number] {

    const reciprocalW = 1 / clip[3]
    return Object.freeze([
        (delta[0] - clip[0] * reciprocalW * delta[3]) * reciprocalW * viewport[0] * 0.5,
        (delta[1] - clip[1] * reciprocalW * delta[3]) * reciprocalW * viewport[1] * 0.5,
    ])
}

function comparePatch(
    left: GpuWebMercatorQuadCoverReferencePatch,
    right: GpuWebMercatorQuadCoverReferencePatch
): number {

    return left.matrixLevel - right.matrixLevel ||
        left.tileRow - right.tileRow ||
        left.tileCol - right.tileCol
}

function minimumPatchLevel(patches: readonly GpuWebMercatorQuadCoverReferencePatch[]): number {

    return Math.min(...patches.map(patch => patch.matrixLevel))
}

function maximumPatchLevel(patches: readonly GpuWebMercatorQuadCoverReferencePatch[]): number {

    return Math.max(...patches.map(patch => patch.matrixLevel))
}

function validateInput(input: GpuWebMercatorQuadCoverReferenceInput): void {

    const bounds = input?.visibleBounds
    const values = bounds === undefined
        ? []
        : [ bounds.west, bounds.north, bounds.east, bounds.south ]
    const verticalRange = input?.verticalRangeMeters
    if (input?.spatialProfile?.kind !== 'tile-spatial-profile' ||
        input.spatialProfile.coverage.tileMatrixSet !== WebMercatorQuad ||
        input.view?.kind !== 'geo-view-snapshot' ||
        verticalRange?.length !== 2 ||
        verticalRange.some(value => !Number.isFinite(value)) ||
        verticalRange[0] > verticalRange[1] ||
        values.length !== 4 || values.some(value => !Number.isFinite(value)) ||
        bounds.west < 0 || bounds.north < 0 || bounds.east > 1 || bounds.south > 1 ||
        bounds.west >= bounds.east || bounds.north >= bounds.south) {
        return invalidCover(
            'The inverse-cover reference requires one WebMercator profile, view, and normalized visible bounds.',
            {
                profile: 'WebMercatorPlanarTileSpatialProfile',
                view: 'GeoViewSnapshot',
                verticalRangeMeters: 'ordered finite pair',
                visibleBounds: 'finite normalized west < east and north < south',
            },
            input
        )
    }
    validateVerticalBounds(input)
}

function validateVerticalBounds(input: GpuWebMercatorQuadCoverReferenceInput): void {

    const hierarchy = input.verticalBounds
    if (hierarchy === undefined) return
    const expected = input.spatialProfile.coverage.limits.flatMap(limit =>
        Array.from(
            { length: limit.maxTileRow - limit.minTileRow + 1 },
            (_, rowOffset) => Array.from(
                { length: limit.maxTileCol - limit.minTileCol + 1 },
                (_, colOffset) => `${limit.matrixId}/` +
                    `${limit.minTileRow + rowOffset}/${limit.minTileCol + colOffset}`
            )
        ).flat()
    )
    const valid = hierarchy.length === expected.length && hierarchy.every((entry, index) =>
        Number.isSafeInteger(entry?.matrixLevel) &&
        Number.isSafeInteger(entry?.tileRow) && Number.isSafeInteger(entry?.tileCol) &&
        `${entry.matrixLevel}/${entry.tileRow}/${entry.tileCol}` === expected[index] &&
        Number.isFinite(entry.minimumVerticalMeters) &&
        Number.isFinite(entry.maximumVerticalMeters) &&
        entry.minimumVerticalMeters <= entry.maximumVerticalMeters
    )
    if (!valid) {
        invalidCover(
            'The inverse-cover vertical hierarchy must exactly match declared coverage.',
            { tileKeys: expected },
            hierarchy
        )
    }
}

function clamp(value: number, minimum: number, maximum: number): number {

    return Math.max(minimum, Math.min(maximum, value))
}

function invalidCover(message: string, expected: unknown, actual: unknown): never {

    return throwGeoDiagnostic({
        code: 'GEO_WEB_MERCATOR_COVER_INVALID',
        phase: 'selection',
        subject: { kind: 'web-mercator-quad-cover' },
        message,
        expected,
        actual,
    })
}
