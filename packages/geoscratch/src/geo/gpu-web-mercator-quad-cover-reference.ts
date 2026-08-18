import { throwGeoDiagnostic } from './diagnostics.js'
import type { GeoViewSnapshot } from './geo-view.js'
import type { GpuWebMercatorQuadCoverPolicy } from './gpu-web-mercator-quad-cover.js'
import type { TileMatrixLimits } from './tile-matrix.js'
import type { WebMercatorPlanarTileSpatialProfile } from './tile-spatial-profile.js'
import {
    WEB_MERCATOR_QUAD_HALF_WORLD,
    WEB_MERCATOR_QUAD_WORLD_WIDTH,
    WebMercatorQuad,
} from './web-mercator-quad.js'

const FINE_WINDOW_SPAN = 4
const LEVEL_HALO_TILES = 1

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
    }>
}>

type IntegerBounds = Readonly<{
    minTileRow: number
    maxTileRow: number
    minTileCol: number
    maxTileCol: number
}>

/**
 * CPU oracle for the deterministic matrix-aligned level-band construction used by
 * the GPU WebMercatorQuad inverse cover.
 */
export function evaluateGpuWebMercatorQuadCoverReference(
    input: GpuWebMercatorQuadCoverReferenceInput
): GpuWebMercatorQuadCoverReferenceResult {

    validateInput(input)
    const focus = normalizedCamera(input.view)
    const finestMatrixLevel = clamp(
        Math.ceil(input.view.zoomHint) + pitchLevelBoost(input.view.cameraPitchRadians),
        input.policy.minimumMatrixLevel,
        input.policy.maximumMatrixLevel
    )
    const generated = generate(input, focus, finestMatrixLevel)
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
            finestMatrixLevel,
            minimumMatrixLevel: input.policy.minimumMatrixLevel,
            maximumMatrixLevel: input.policy.maximumMatrixLevel,
            sourceLevelCeiling: input.policy.sourceMaximumMatrixLevel,
            candidateCount: generated.candidateCount,
            patchCount: generated.patches.length,
            demandCount: demands.length,
        }),
    })
}

function generate(
    input: GpuWebMercatorQuadCoverReferenceInput,
    focus: readonly [number, number],
    finestMatrixLevel: number
) {

    const windows = coverWindows(input, focus, finestMatrixLevel)
    const patches: GpuWebMercatorQuadCoverReferencePatch[] = []
    let candidateCount = 0
    for (let matrixLevel = finestMatrixLevel;
        matrixLevel >= input.policy.minimumMatrixLevel;
        matrixLevel--) {
        const window = windows.get(matrixLevel)!
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
    return { patches, candidateCount }
}

function coverWindows(
    input: GpuWebMercatorQuadCoverReferenceInput,
    focus: readonly [number, number],
    finestMatrixLevel: number
): ReadonlyMap<number, IntegerBounds> {

    const windows = new Map<number, IntegerBounds>()
    const finestLimit = geometryLimit(input, finestMatrixLevel)
    const finestSize = 2 ** finestMatrixLevel
    const focusRow = clamp(Math.floor(focus[1] * finestSize), 0, finestSize - 1)
    const focusCol = clamp(Math.floor(focus[0] * finestSize), 0, finestSize - 1)
    windows.set(finestMatrixLevel, fitWindow({
        minTileRow: Math.floor((focusRow - FINE_WINDOW_SPAN / 2) / 2) * 2,
        maxTileRow: Math.floor((focusRow - FINE_WINDOW_SPAN / 2) / 2) * 2 +
            FINE_WINDOW_SPAN - 1,
        minTileCol: Math.floor((focusCol - FINE_WINDOW_SPAN / 2) / 2) * 2,
        maxTileCol: Math.floor((focusCol - FINE_WINDOW_SPAN / 2) / 2) * 2 +
            FINE_WINDOW_SPAN - 1,
    }, finestLimit))

    for (let matrixLevel = finestMatrixLevel - 1;
        matrixLevel >= input.policy.minimumMatrixLevel;
        matrixLevel--) {
        const finer = windows.get(matrixLevel + 1)!
        const limit = geometryLimit(input, matrixLevel)
        const parentWindow = {
            minTileRow: Math.floor(finer.minTileRow / 2),
            maxTileRow: Math.floor(finer.maxTileRow / 2),
            minTileCol: Math.floor(finer.minTileCol / 2),
            maxTileCol: Math.floor(finer.maxTileCol / 2),
        }
        const expanded = alignToParentGroups({
            minTileRow: parentWindow.minTileRow - LEVEL_HALO_TILES,
            maxTileRow: parentWindow.maxTileRow + LEVEL_HALO_TILES,
            minTileCol: parentWindow.minTileCol - LEVEL_HALO_TILES,
            maxTileCol: parentWindow.maxTileCol + LEVEL_HALO_TILES,
        })
        windows.set(matrixLevel, matrixLevel === input.policy.minimumMatrixLevel
            ? limit
            : fitWindow(expanded, limit))
    }
    return windows
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

function pitchLevelBoost(pitch: number): number {

    return Math.floor(Math.sin(pitch) ** 2 * 1.5)
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

function comparePatch(
    left: GpuWebMercatorQuadCoverReferencePatch,
    right: GpuWebMercatorQuadCoverReferencePatch
): number {

    return left.matrixLevel - right.matrixLevel ||
        left.tileRow - right.tileRow ||
        left.tileCol - right.tileCol
}

function integerBounds(limit: TileMatrixLimits): IntegerBounds {

    return Object.freeze({
        minTileRow: limit.minTileRow,
        maxTileRow: limit.maxTileRow,
        minTileCol: limit.minTileCol,
        maxTileCol: limit.maxTileCol,
    })
}

function validateInput(input: GpuWebMercatorQuadCoverReferenceInput): void {

    const bounds = input?.visibleBounds
    const values = bounds === undefined
        ? []
        : [ bounds.west, bounds.north, bounds.east, bounds.south ]
    if (input?.spatialProfile?.kind !== 'tile-spatial-profile' ||
        input.spatialProfile.coverage.tileMatrixSet !== WebMercatorQuad ||
        input.view?.kind !== 'geo-view-snapshot' ||
        values.length !== 4 || values.some(value => !Number.isFinite(value)) ||
        bounds.west < 0 || bounds.north < 0 || bounds.east > 1 || bounds.south > 1 ||
        bounds.west >= bounds.east || bounds.north >= bounds.south) {
        return invalidCover(
            'The inverse-cover reference requires one WebMercator profile, view, and normalized visible bounds.',
            {
                profile: 'WebMercatorPlanarTileSpatialProfile',
                view: 'GeoViewSnapshot',
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
