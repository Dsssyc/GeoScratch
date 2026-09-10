import { throwGeoDiagnostic } from './diagnostics.js'
import type { WebMercatorTileVerticalBounds } from './gpu-web-mercator-quad-cover.js'
import type { WebMercatorPlanarTileSpatialProfile } from './tile-spatial-profile.js'

/** @internal Snapshots complete declared metadata with conservative ancestor enclosure. */
export function snapshotWebMercatorCoverVerticalBounds(
    input: readonly WebMercatorTileVerticalBounds[] | undefined,
    limits: WebMercatorPlanarTileSpatialProfile['coverage']['limits'],
    globalRange: readonly [number, number]
): readonly WebMercatorTileVerticalBounds[] | undefined {

    if (input === undefined) return undefined
    const expectedCount = limits.reduce((count, limit) => count +
        (limit.maxTileRow - limit.minTileRow + 1) *
        (limit.maxTileCol - limit.minTileCol + 1), 0)
    const invalid = (reason: string, actual: unknown): never => throwGeoDiagnostic({
        code: 'GEO_WEB_MERCATOR_COVER_VERTICAL_BOUNDS_INVALID',
        phase: 'selection', subject: { kind: 'web-mercator-quad-cover' },
        message: 'Cover vertical bounds require complete declared tiles and enclosing ancestors.',
        expected: { count: expectedCount, globalRange }, actual: { reason, value: actual },
    })
    // Reject absent metadata without enumerating a potentially world-sized domain.
    if (!Array.isArray(input) || input.length !== expectedCount) {
        return invalid('record-count', { count: input?.length })
    }
    const records = new Map<string, WebMercatorTileVerticalBounds>()
    const minimumLevel = Number(limits[0]!.matrixId)
    let index = 0
    for (const limit of limits) {
        const matrixLevel = Number(limit.matrixId)
        for (let tileRow = limit.minTileRow; tileRow <= limit.maxTileRow; tileRow++) {
            for (let tileCol = limit.minTileCol; tileCol <= limit.maxTileCol; tileCol++) {
                const entry = input[index++]!
                if (entry?.matrixLevel !== matrixLevel || entry.tileRow !== tileRow ||
                    entry.tileCol !== tileCol ||
                    !Number.isFinite(entry.minimumVerticalMeters) ||
                    !Number.isFinite(entry.maximumVerticalMeters) ||
                    entry.minimumVerticalMeters > entry.maximumVerticalMeters ||
                    entry.minimumVerticalMeters < globalRange[0] ||
                    entry.maximumVerticalMeters > globalRange[1]) {
                    return invalid('record', { index: index - 1, entry })
                }
                if (matrixLevel > minimumLevel) {
                    let ancestor: WebMercatorTileVerticalBounds | undefined
                    for (let level = matrixLevel - 1; level >= minimumLevel; level--) {
                        const scale = 2 ** (matrixLevel - level)
                        ancestor = records.get(`${level}/${Math.floor(tileRow / scale)}/${Math.floor(tileCol / scale)}`)
                        if (ancestor !== undefined) break
                    }
                    if (ancestor === undefined ||
                        entry.minimumVerticalMeters < ancestor.minimumVerticalMeters ||
                        entry.maximumVerticalMeters > ancestor.maximumVerticalMeters) {
                        return invalid('ancestor-enclosure', { entry, ancestor })
                    }
                }
                records.set(`${matrixLevel}/${tileRow}/${tileCol}`, Object.freeze({ ...entry }))
            }
        }
    }
    return Object.freeze([...records.values()])
}
