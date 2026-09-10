import { coverClipWCertificate, gpuWebMercatorQuadCoverCandidates } from './gpu-web-mercator-quad-cover-candidates.js'
import { snapshotWebMercatorCoverVerticalBounds } from './gpu-web-mercator-quad-cover-vertical-bounds.js'
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
    const generated = generateVariable(input)
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
    if (generated.cellSpans.some(value => !Number.isFinite(value))) {
        return invalidCover('The final cover has no finite projected quality bound.',
            { quality: 'finite' }, { reason: 'unbounded-quality' })
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
    input: GpuWebMercatorQuadCoverReferenceInput
) {

    const clipW = coverClipWCertificate(input.view.clipFromRelativeWorld)
    const refinements = sparseRefinements(input, clipW)
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
        cellSpans: patchesOutput.map(patch => projectedCellSpanPixels(input, patch, clipW)),
        finestMatrixLevel: refinements.finestMatrixLevel,
    }
}

function sparseRefinements(
    input: GpuWebMercatorQuadCoverReferenceInput,
    clipW: ReturnType<typeof coverClipWCertificate>
): Readonly<{
    parents: ReadonlySet<string>
    candidateCount: number
    finestMatrixLevel: number
}> {

    const parents = new Set<string>()
    const candidates = gpuWebMercatorQuadCoverCandidates(input, input.view)
    let candidateCount = 0
    let finestMatrixLevel = input.policy.minimumMatrixLevel
    for (let parentLevel = input.policy.minimumMatrixLevel;
        parentLevel < input.policy.maximumMatrixLevel;
        parentLevel++) {
        const search = candidates.windows[parentLevel - input.policy.minimumMatrixLevel]!
        for (let tileRow = search.minTileRow; tileRow <= search.maxTileRow; tileRow++) {
            for (let tileCol = search.minTileCol; tileCol <= search.maxTileCol; tileCol++) {
                candidateCount++
                if (parentLevel > input.policy.minimumMatrixLevel && !parents.has(
                    `${parentLevel - 1}/${Math.floor(tileRow / 2)}/${Math.floor(tileCol / 2)}`
                )) continue
                const parent = referencePatch(parentLevel, tileRow, tileCol)
                if (!intersectsVisible(parent, input.visibleBounds) ||
                    projectedCellSpanPixels(input, parent, clipW) <=
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

/**
 * Balances an explicit reference cut with independent pairwise edge checks.
 * The input is the already-visible cut produced by materialization.
 * Each round marks its immutable input before replacing parents and removing
 * invisible children, so traversal order cannot propagate transient geometry.
 * The optional visibility predicate supports independent non-rectangular proofs.
 * @internal
 */
export function balancePatches(
    input: GpuWebMercatorQuadCoverReferenceInput,
    patches: GpuWebMercatorQuadCoverReferencePatch[],
    isVisible: (patch: GpuWebMercatorQuadCoverReferencePatch) => boolean = patch =>
        intersectsVisible(patch, input.visibleBounds)
): number {

    let candidateCount = 0
    const maximumRounds = input.policy.maximumPatches * (
        input.policy.maximumMatrixLevel - input.policy.minimumMatrixLevel + 1
    )
    if (!Number.isSafeInteger(maximumRounds) || maximumRounds <= 0 || maximumRounds > 0xffff_ffff) {
        return invalidCover(
            'The balanced standard cover requires a finite u32 closure work budget.',
            { maximumRounds: 'positive u32' },
            { maximumRounds }
        )
    }
    const marks = () => patches.map((candidate, patchIndex) => patches.some((other, otherIndex) =>
        otherIndex !== patchIndex &&
        other.matrixLevel > candidate.matrixLevel + 1 &&
        edgeAdjacentAtLevel(candidate, other, input.policy.maximumMatrixLevel)
    ))
    for (let iteration = 0; iteration < maximumRounds; iteration++) {
        const inputCount = patches.length
        const marked = marks()
        if (!marked.some(Boolean)) return candidateCount
        for (let patchIndex = 0; patchIndex < inputCount; patchIndex++) {
            if (!marked[patchIndex]) continue
            const candidate = patches[patchIndex]!
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
            patches[patchIndex] = children[0]!
            patches.push(...children.slice(1))
        }
        const visible = patches.filter(isVisible)
        patches.splice(0, patches.length, ...visible)
    }
    if (marks().some(Boolean)) {
        return invalidCover(
            'The balanced standard cover did not close within its declared work budget.',
            { maximumAdjacentLevelDelta: 1, maximumRounds },
            { patchCount: patches.length }
        )
    }
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
    patch: GpuWebMercatorQuadCoverReferencePatch,
    clipW: ReturnType<typeof coverClipWCertificate>
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
    const vertical = verticalRangeForPatch(input, patch).map(value => value - cameraZ)
    if (vertical[0] === vertical[1]) return projectedPlaneCellSpanPixels(input, relative, vertical[0]!)
    const matrix = input.view.clipFromRelativeWorld
    const corners: ClipPoint[] = []
    for (const z of vertical) for (const x of [relative.minimumX, relative.maximumX]) {
        for (const y of [relative.minimumY, relative.maximumY]) corners.push([x, y, z, 1])
    }
    const clips = corners.map(point => multiplyClip(matrix, point))
    const minimumBoxW = Math.min(...clips.map(clip => clip[3]))
    const magnitude = [Math.max(Math.abs(relative.minimumX), Math.abs(relative.maximumX)),
        Math.max(Math.abs(relative.minimumY), Math.abs(relative.maximumY)),
        Math.max(...vertical.map(Math.abs)), 1]
    const boxMinimum = [relative.minimumX, relative.minimumY, vertical[0]!, 1]
    const boxMaximum = [relative.maximumX, relative.maximumY, vertical[1]!, 1]
    let minimumW = minimumBoxW
    for (let axis = 0; axis < 4; axis++) {
        const residual = clipW.clipWResidual[axis]!.reduce((sum, value, index) => sum + value * magnitude[index]!, 0)
        if (clipW.clipWPositive[axis]! > 0) minimumW = Math.max(minimumW,
            Math.max(0, boxMinimum[axis]! - residual) / clipW.clipWPositive[axis]!)
        if (clipW.clipWNegative[axis]! > 0) minimumW = Math.max(minimumW,
            Math.max(0, -boxMaximum[axis]! - residual) / clipW.clipWNegative[axis]!)
    }
    const lower = [0, 1].map(axis => minimumBoxW > 0 ?
        Math.max(-1, Math.min(...clips.map(clip => clip[axis]! / clip[3]))) : -1)
    const upper = [0, 1].map(axis => minimumBoxW > 0 ?
        Math.min(1, Math.max(...clips.map(clip => clip[axis]! / clip[3]))) : 1)
    if (lower.some((value, axis) => value > upper[axis]!)) return 0
    const h = (relative.maximumX - relative.minimumX) / input.policy.cellsPerPatchEdge
    if (minimumW - 0.5 * h * (Math.abs(matrix[3]!) + Math.abs(matrix[7]!)) <= 1e-5) return Infinity
    const numerators = []
    for (const x of [lower[0]!, upper[0]!]) for (const y of [lower[1]!, upper[1]!]) {
        numerators.push(projectedNumeratorStretch(input.view.referenceViewport, [x, y],
            matrix.slice(0, 4).map(value => value * h), matrix.slice(4, 8).map(value => value * h)))
    }
    return Math.max(...numerators) / minimumW
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
    const maximumLevel = Math.min(
        patch.matrixLevel,
        boundsMaximumMatrixLevel
    )
    for (let matrixLevel = maximumLevel; matrixLevel >= input.policy.minimumMatrixLevel; matrixLevel--) {
        const shift = patch.matrixLevel - matrixLevel
        const tileRow = patch.tileRow >> shift
        const tileCol = patch.tileCol >> shift
        const bounds = hierarchy.find(entry =>
            entry.matrixLevel === matrixLevel &&
            entry.tileRow === tileRow && entry.tileCol === tileCol
        )
        if (bounds !== undefined) return [ bounds.minimumVerticalMeters, bounds.maximumVerticalMeters ]
    }
    return input.verticalRangeMeters
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
        [ bounds.minimumX, bounds.minimumY, vertical, 1 ],
        [ bounds.maximumX, bounds.minimumY, vertical, 1 ],
        [ bounds.maximumX, bounds.maximumY, vertical, 1 ],
        [ bounds.minimumX, bounds.maximumY, vertical, 1 ],
    ]
    for (let plane = 0; plane < 6 && polygon.length > 0; plane++) {
        polygon = clipPolygonToPlane(polygon, plane, matrix)
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
    const clips = polygon.map(point => multiplyClip(matrix, point))
    const minimumW = Math.min(...clips.map(clip => clip[3]))
    if (minimumW - 0.5 * (Math.abs(xDelta[3]) + Math.abs(yDelta[3])) <= 1e-5) return Infinity
    return Math.max(...clips.map(clip => projectedNumeratorStretch(input.view.referenceViewport,
        [clamp(clip[0] / clip[3], -1, 1), clamp(clip[1] / clip[3], -1, 1)],
        xDelta, yDelta))) / minimumW
}

function projectedNumeratorStretch(
    viewport: readonly [number, number], ndc: readonly number[],
    xDelta: readonly number[], yDelta: readonly number[]
): number {
    const x = [0, 1].map(axis => (xDelta[axis]! - ndc[axis]! * xDelta[3]!) * viewport[axis]! * 0.5)
    const y = [0, 1].map(axis => (yDelta[axis]! - ndc[axis]! * yDelta[3]!) * viewport[axis]! * 0.5)
    const xx = x[0]! ** 2 + x[1]! ** 2, yy = y[0]! ** 2 + y[1]! ** 2
    const xy = x[0]! * y[0]! + x[1]! * y[1]!
    return Math.sqrt(0.5 * (xx + yy + Math.hypot(xx - yy, 2 * xy)))
}

function multiplyClip(matrix: readonly number[], point: ClipPoint): ClipPoint {

    return Object.freeze([ 0, 1, 2, 3 ].map(row =>
        matrix[row]! * point[0] +
        matrix[row + 4]! * point[1] +
        matrix[row + 8]! * point[2] +
        matrix[row + 12]! * point[3]
    )) as unknown as ClipPoint
}

function clipPolygonToPlane(
    input: readonly ClipPoint[], plane: number, matrix: readonly number[]
): ClipPoint[] {

    if (input.length === 0) return []
    const output: ClipPoint[] = []
    let start = input.at(-1)!
    let startDistance = clipPlaneDistance(start, plane, matrix)
    for (const end of input) {
        const endDistance = clipPlaneDistance(end, plane, matrix)
        const startInside = startDistance >= 0
        const endInside = endDistance >= 0
        if (startInside !== endInside) {
            const denominator = startDistance - endDistance
            const ratio = Math.abs(denominator) < 2 ** -120 ? 0.5 :
                clamp(startDistance / denominator, 0, 1)
            output.push(Object.freeze(start.map((value, index) =>
                index === 3 ? 1 : value + (end[index]! - value) * ratio
            )) as unknown as ClipPoint)
        }
        if (endInside) output.push(end)
        start = end
        startDistance = endDistance
    }
    return output
}

function clipPlaneDistance(point: ClipPoint, plane: number, matrix: readonly number[]): number {

    const row = (index: number) => [0, 1, 2, 3].map(column => matrix[column * 4 + index]!)
    const row3 = row(3)
    const other = row(plane < 2 ? 2 : plane < 4 ? 0 : 1)
    const equation = plane === 0 ? other : row3.map((value, index) =>
        value + (plane === 2 || plane === 4 ? other[index]! : -other[index]!))
    return equation.reduce((sum, value, index) => sum + value * point[index]!, 0)
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
    snapshotWebMercatorCoverVerticalBounds(input.verticalBounds,
        input.spatialProfile.coverage.limits, input.verticalRangeMeters)
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
