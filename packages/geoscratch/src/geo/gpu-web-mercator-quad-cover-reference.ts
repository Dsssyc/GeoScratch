import { throwGeoDiagnostic } from './diagnostics.js'
import type { GeoViewSnapshot } from './geo-view.js'
import type { GpuWebMercatorQuadCoverPolicy } from './gpu-web-mercator-quad-cover.js'
import type { WebMercatorPlanarTileSpatialProfile } from './tile-spatial-profile.js'
import {
    WEB_MERCATOR_QUAD_HALF_WORLD,
    WEB_MERCATOR_QUAD_WORLD_WIDTH,
    WebMercatorQuad,
} from './web-mercator-quad.js'

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
    elevationRangeMeters: readonly [number, number]
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

export type GpuWebMercatorQuadCoverReferenceDemand = Readonly<{
    kind: 'gpu-web-mercator-quad-cover-demand'
    desiredSampleLevel: number
    sourceLevelCeiling: number
    requestPage: GpuWebMercatorQuadCoverReferencePatch
    priority: number
}>

export type GpuWebMercatorQuadCoverReferenceResult = Readonly<{
    patches: readonly GpuWebMercatorQuadCoverReferencePatch[]
    demands: readonly GpuWebMercatorQuadCoverReferenceDemand[]
    facts: Readonly<{
        selectionPath: 'gpu-camera-inverse-webmercatorquad-cover'
        finestMatrixLevel: number
        minimumMatrixLevel: number
        maximumMatrixLevel: number
        sourceLevelCeiling: number
        candidateCount: number
        patchCount: number
        demandCount: number
        selectionMode: 'uniform' | 'variable'
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
 * CPU oracle for the deterministic pitch-gated projected-cell construction used by
 * the GPU WebMercatorQuad inverse cover.
 */
export function evaluateGpuWebMercatorQuadCoverReference(
    input: GpuWebMercatorQuadCoverReferenceInput
): GpuWebMercatorQuadCoverReferenceResult {

    validateInput(input)
    const focus = normalizedCamera(input.view)
    const fixedCamera = cameraFixedPosition(input)
    const selectionMode = input.view.cameraPitchRadians <
        input.policy.variableLodPitchThresholdRadians
        ? 'uniform'
        : 'variable'
    const generated = selectionMode === 'uniform'
        ? generateUniform(input)
        : generateVariable(input, fixedCamera)
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
    const demands = createDemands(input, generated.patches, focus)
    return Object.freeze({
        patches: Object.freeze(generated.patches),
        demands: Object.freeze(demands),
        facts: Object.freeze({
            selectionPath: 'gpu-camera-inverse-webmercatorquad-cover' as const,
            finestMatrixLevel: generated.finestMatrixLevel,
            minimumMatrixLevel: minimumPatchLevel(generated.patches),
            maximumMatrixLevel: maximumPatchLevel(generated.patches),
            sourceLevelCeiling: input.policy.sourceMaximumMatrixLevel,
            candidateCount: generated.candidateCount,
            patchCount: generated.patches.length,
            demandCount: demands.length,
            selectionMode,
            ...(generated.cellSpans.length === 0 ? {} : {
                minimumCellSpanReferencePixels: Math.min(...generated.cellSpans),
                maximumCellSpanReferencePixels: Math.max(...generated.cellSpans),
            }),
        }),
    })
}

function generateUniform(input: GpuWebMercatorQuadCoverReferenceInput) {

    const probeLevel = clamp(
        Math.floor(
            input.view.zoomHint +
            Math.log2(512 / input.policy.referenceTileSizePixels)
        ),
        input.policy.minimumMatrixLevel,
        input.policy.maximumMatrixLevel
    )
    const probeWindow = visibleWindow(input, probeLevel)
    const probePatches = patchesInWindow(input, probeLevel, probeWindow)
    const probeSpans = probePatches.map(patch => projectedCellSpanPixels(input, patch))
    const maximumProbeSpan = probeSpans.length === 0 ? 0 : Math.max(...probeSpans)
    const threshold = effectiveCellSpanThreshold(input)
    const levelAdjustment = maximumProbeSpan > threshold
        ? Math.ceil(Math.log2(maximumProbeSpan / threshold))
        : 0
    const matrixLevel = clamp(
        probeLevel + levelAdjustment,
        input.policy.minimumMatrixLevel,
        input.policy.maximumMatrixLevel
    )
    const window = visibleWindow(input, matrixLevel)
    const patches = matrixLevel === probeLevel
        ? probePatches
        : patchesInWindow(input, matrixLevel, window)
    const cellSpans = matrixLevel === probeLevel
        ? probeSpans
        : patches.map(patch => projectedCellSpanPixels(input, patch))
    patches.sort(comparePatch)
    return {
        patches,
        candidateCount: windowArea(probeWindow) +
            (matrixLevel === probeLevel ? 0 : windowArea(window)),
        cellSpans,
        finestMatrixLevel: matrixLevel,
    }
}

function generateVariable(
    input: GpuWebMercatorQuadCoverReferenceInput,
    fixedCamera: readonly [bigint, bigint]
) {

    const windows = variableWindows(input, fixedCamera)
    const patches: GpuWebMercatorQuadCoverReferencePatch[] = []
    let candidateCount = 0
    const finestMatrixLevel = Math.max(...windows.keys())
    for (let matrixLevel = finestMatrixLevel;
        matrixLevel >= input.policy.minimumMatrixLevel;
        matrixLevel--) {
        const window = windows.get(matrixLevel)
        if (window === undefined) continue
        const finer = windows.get(matrixLevel + 1)
        for (let tileRow = window.minTileRow; tileRow <= window.maxTileRow; tileRow++) {
            for (let tileCol = window.minTileCol; tileCol <= window.maxTileCol; tileCol++) {
                candidateCount++
                if (finer !== undefined && fullyCoveredByFiner(
                    tileRow,
                    tileCol,
                    finer
                )) continue
                const patch = referencePatch(matrixLevel, tileRow, tileCol)
                if (intersectsVisible(patch, input.visibleBounds)) patches.push(patch)
            }
        }
    }
    patches.sort(comparePatch)
    return {
        patches,
        candidateCount,
        cellSpans: patches.map(patch => projectedCellSpanPixels(input, patch)),
        finestMatrixLevel,
    }
}

function variableWindows(
    input: GpuWebMercatorQuadCoverReferenceInput,
    fixedCamera: readonly [bigint, bigint]
): ReadonlyMap<number, IntegerBounds> {

    const windows = new Map<number, IntegerBounds>()
    windows.set(input.policy.minimumMatrixLevel, geometryLimit(
        input,
        input.policy.minimumMatrixLevel
    ))
    const radius = projectedSearchRadius(input)
    for (let childLevel = input.policy.minimumMatrixLevel + 1;
        childLevel <= input.policy.maximumMatrixLevel;
        childLevel++) {
        const parentLevel = childLevel - 1
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
        let childWindow: IntegerBounds | undefined
        for (let tileRow = search.minTileRow; tileRow <= search.maxTileRow; tileRow++) {
            for (let tileCol = search.minTileCol; tileCol <= search.maxTileCol; tileCol++) {
                const parent = referencePatch(parentLevel, tileRow, tileCol)
                if (!intersectsVisible(parent, input.visibleBounds) ||
                    projectedCellSpanPixels(input, parent) <=
                        effectiveCellSpanThreshold(input)) continue
                const children = {
                    minTileRow: tileRow * 2,
                    maxTileRow: tileRow * 2 + 1,
                    minTileCol: tileCol * 2,
                    maxTileCol: tileCol * 2 + 1,
                }
                childWindow = childWindow === undefined
                    ? children
                    : unionBounds(childWindow, children)
            }
        }
        if (childWindow !== undefined) {
            windows.set(childLevel, fitWindow(
                alignToParentGroups(childWindow),
                geometryLimit(input, childLevel)
            ))
        }
    }
    for (let matrixLevel = input.policy.maximumMatrixLevel - 1;
        matrixLevel > input.policy.minimumMatrixLevel;
        matrixLevel--) {
        const finer = windows.get(matrixLevel + 1)
        if (finer === undefined) continue
        const parent = {
            minTileRow: Math.floor(finer.minTileRow / 2),
            maxTileRow: Math.floor(finer.maxTileRow / 2),
            minTileCol: Math.floor(finer.minTileCol / 2),
            maxTileCol: Math.floor(finer.maxTileCol / 2),
        }
        const current = windows.get(matrixLevel)
        windows.set(matrixLevel, fitWindow(
            alignToParentGroups(current === undefined ? parent : unionBounds(current, parent)),
            geometryLimit(input, matrixLevel)
        ))
    }
    return windows
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

function visibleWindow(
    input: GpuWebMercatorQuadCoverReferenceInput,
    matrixLevel: number
): IntegerBounds {

    const size = 2 ** matrixLevel
    const visible = input.visibleBounds
    return fitWindow({
        minTileRow: Math.floor(visible.north * size),
        maxTileRow: Math.ceil(visible.south * size) - 1,
        minTileCol: Math.floor(visible.west * size),
        maxTileCol: Math.ceil(visible.east * size) - 1,
    }, geometryLimit(input, matrixLevel))
}

function patchesInWindow(
    input: GpuWebMercatorQuadCoverReferenceInput,
    matrixLevel: number,
    window: IntegerBounds
): GpuWebMercatorQuadCoverReferencePatch[] {

    const patches: GpuWebMercatorQuadCoverReferencePatch[] = []
    for (let tileRow = window.minTileRow; tileRow <= window.maxTileRow; tileRow++) {
        for (let tileCol = window.minTileCol; tileCol <= window.maxTileCol; tileCol++) {
            const patch = referencePatch(matrixLevel, tileRow, tileCol)
            if (intersectsVisible(patch, input.visibleBounds)) patches.push(patch)
        }
    }
    return patches
}

function windowArea(window: IntegerBounds): number {

    return (window.maxTileRow - window.minTileRow + 1) *
        (window.maxTileCol - window.minTileCol + 1)
}

function unionBounds(left: IntegerBounds, right: IntegerBounds): IntegerBounds {

    return Object.freeze({
        minTileRow: Math.min(left.minTileRow, right.minTileRow),
        maxTileRow: Math.max(left.maxTileRow, right.maxTileRow),
        minTileCol: Math.min(left.minTileCol, right.minTileCol),
        maxTileCol: Math.max(left.maxTileCol, right.maxTileCol),
    })
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

function createDemands(
    input: GpuWebMercatorQuadCoverReferenceInput,
    patches: readonly GpuWebMercatorQuadCoverReferencePatch[],
    focus: readonly [number, number]
): GpuWebMercatorQuadCoverReferenceDemand[] {

    const byRequest = new Map<string, GpuWebMercatorQuadCoverReferenceDemand>()
    for (const patch of patches) {
        let requestLevel = Math.min(
            patch.matrixLevel,
            input.policy.sourceMaximumMatrixLevel
        )
        let shift = patch.matrixLevel - requestLevel
        let tileRow = Math.floor(patch.tileRow / 2 ** shift)
        let tileCol = Math.floor(patch.tileCol / 2 ** shift)
        while (requestLevel >= input.policy.minimumMatrixLevel &&
            !input.spatialProfile.coverage.contains({
                matrixId: String(requestLevel),
                tileRow,
                tileCol,
            })) {
            requestLevel--
            shift++
            tileRow = Math.floor(patch.tileRow / 2 ** shift)
            tileCol = Math.floor(patch.tileCol / 2 ** shift)
        }
        if (requestLevel < input.policy.minimumMatrixLevel) continue
        const requestPage = referencePatch(requestLevel, tileRow, tileCol)
        const demand = Object.freeze({
            kind: 'gpu-web-mercator-quad-cover-demand' as const,
            desiredSampleLevel: patch.matrixLevel,
            sourceLevelCeiling: input.policy.sourceMaximumMatrixLevel,
            requestPage,
            priority: demandPriority(patch.matrixLevel, requestPage, focus),
        })
        const existing = byRequest.get(requestPage.key)
        if (existing === undefined ||
            existing.desiredSampleLevel < demand.desiredSampleLevel) {
            byRequest.set(requestPage.key, demand)
        }
    }
    return [ ...byRequest.values() ]
        .sort((left, right) =>
            right.priority - left.priority ||
            comparePatch(left.requestPage, right.requestPage)
        )
}

function demandPriority(
    desiredSampleLevel: number,
    requestPage: GpuWebMercatorQuadCoverReferencePatch,
    focus: readonly [number, number]
): number {

    const size = 2 ** requestPage.matrixLevel
    const cameraRow = clamp(Math.floor(focus[1] * size), 0, size - 1)
    const cameraCol = clamp(Math.floor(focus[0] * size), 0, size - 1)
    const rowDistance = Math.abs(requestPage.tileRow - cameraRow)
    const rawColDistance = Math.abs(requestPage.tileCol - cameraCol)
    const colDistance = Math.min(rawColDistance, size - rawColDistance)
    return desiredSampleLevel * 1_000_000 + 999_999 -
        Math.min(rowDistance + colDistance, 999_999)
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

function normalizedCamera(view: GeoViewSnapshot): readonly [number, number] {

    const x = view.cameraHigh[0] + view.cameraLow[0]
    const y = view.cameraHigh[1] + view.cameraLow[1]
    return Object.freeze([
        positiveModulo(
            (x + WEB_MERCATOR_QUAD_HALF_WORLD) / WEB_MERCATOR_QUAD_WORLD_WIDTH,
            1
        ),
        clamp(
            (WEB_MERCATOR_QUAD_HALF_WORLD - y) / WEB_MERCATOR_QUAD_WORLD_WIDTH,
            0,
            1 - Number.EPSILON
        ),
    ]) as readonly [number, number]
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

function alignToParentGroups(bounds: IntegerBounds): IntegerBounds {

    return Object.freeze({
        minTileRow: Math.floor(bounds.minTileRow / 2) * 2,
        maxTileRow: Math.ceil((bounds.maxTileRow + 1) / 2) * 2 - 1,
        minTileCol: Math.floor(bounds.minTileCol / 2) * 2,
        maxTileCol: Math.ceil((bounds.maxTileCol + 1) / 2) * 2 - 1,
    })
}

function fitStart(value: number, span: number, minimum: number, maximum: number): number {

    return clamp(value, minimum, maximum - span + 1)
}

function fullyCoveredByFiner(
    tileRow: number,
    tileCol: number,
    finer: IntegerBounds
): boolean {

    return tileRow * 2 >= finer.minTileRow &&
        tileRow * 2 + 1 <= finer.maxTileRow &&
        tileCol * 2 >= finer.minTileCol &&
        tileCol * 2 + 1 <= finer.maxTileCol
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
    return Math.max(...input.elevationRangeMeters.map(elevation =>
        projectedPlaneCellSpanPixels(
            input,
            relative,
            elevation - cameraZ
        )
    ))
}

function projectedPlaneCellSpanPixels(
    input: GpuWebMercatorQuadCoverReferenceInput,
    bounds: Readonly<{
        minimumX: number
        maximumX: number
        minimumY: number
        maximumY: number
    }>,
    elevation: number
): number {

    const matrix = input.view.clipFromRelativeWorld
    let polygon: ClipPoint[] = [
        multiplyClip(matrix, [ bounds.minimumX, bounds.minimumY, elevation, 1 ]),
        multiplyClip(matrix, [ bounds.maximumX, bounds.minimumY, elevation, 1 ]),
        multiplyClip(matrix, [ bounds.maximumX, bounds.maximumY, elevation, 1 ]),
        multiplyClip(matrix, [ bounds.minimumX, bounds.maximumY, elevation, 1 ]),
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
    return Math.max(...polygon.map(point => projectedCellAreaScalePixels(
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

function projectedCellAreaScalePixels(
    viewport: readonly [number, number],
    clip: ClipPoint,
    xDelta: ClipPoint,
    yDelta: ClipPoint
): number {

    const minimumCellW = clip[3] - 0.5 * (Math.abs(xDelta[3]) + Math.abs(yDelta[3]))
    if (minimumCellW <= 1e-5) return Math.max(...viewport)
    const xPixels = projectedAxisCellDeltaPixels(viewport, clip, xDelta)
    const yPixels = projectedAxisCellDeltaPixels(viewport, clip, yDelta)
    return Math.sqrt(Math.abs(
        xPixels[0] * yPixels[1] - xPixels[1] * yPixels[0]
    ))
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
    const elevationRange = input?.elevationRangeMeters
    if (input?.spatialProfile?.kind !== 'tile-spatial-profile' ||
        input.spatialProfile.coverage.tileMatrixSet !== WebMercatorQuad ||
        input.view?.kind !== 'geo-view-snapshot' ||
        elevationRange?.length !== 2 ||
        elevationRange.some(value => !Number.isFinite(value)) ||
        elevationRange[0] > elevationRange[1] ||
        values.length !== 4 || values.some(value => !Number.isFinite(value)) ||
        bounds.west < 0 || bounds.north < 0 || bounds.east > 1 || bounds.south > 1 ||
        bounds.west >= bounds.east || bounds.north >= bounds.south) {
        return invalidCover(
            'The inverse-cover reference requires one WebMercator profile, view, and normalized visible bounds.',
            {
                profile: 'WebMercatorPlanarTileSpatialProfile',
                view: 'GeoViewSnapshot',
                elevationRangeMeters: 'ordered finite pair',
                visibleBounds: 'finite normalized west < east and north < south',
            },
            input
        )
    }
}

function positiveModulo(value: number, modulus: number): number {

    return ((value % modulus) + modulus) % modulus
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
