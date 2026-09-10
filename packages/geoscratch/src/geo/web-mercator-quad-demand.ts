import { throwGeoDiagnostic } from './diagnostics.js'
import { tileMatrixCoverage, type TileMatrixCoverage } from './tile-matrix.js'
import { WebMercatorQuad } from './web-mercator-quad.js'
import {
    webMercatorQuadCoverDescriptor,
    isWebMercatorQuadCover,
    webMercatorQuadCoverSelectionData,
    type WebMercatorQuadCover,
    type WebMercatorQuadCoverSelection,
} from './web-mercator-quad-cover.js'
import type { GeoViewSnapshot } from './geo-view.js'

export type WebMercatorQuadProjectedDemand = Readonly<{
    desiredSampleLevel: number
    sourceLevelCeiling: number
    requestMatrixLevel: number
    tileRow: number
    tileCol: number
    priority: number
    decisionFrameEpoch: number
    residencySnapshotEpoch: number
}>

export type WebMercatorQuadDemandProjectionDescriptor = Readonly<{
    cover: WebMercatorQuadCover
    sourceCoverage: TileMatrixCoverage
    maximumDemands: number
}>

export type WebMercatorQuadProjectedDemands = Readonly<{
    kind: 'web-mercator-quad-projected-demands'
    projectionId: string
    coverId: string
    selectionId: string
    selectionRevision: number
    view: GeoViewSnapshot
    frameEpoch: number
    demandCount: number
    overflowCount: number
    sourceLevelCeiling: number
    demands: readonly WebMercatorQuadProjectedDemand[]
}>

export type WebMercatorQuadDemandProjectionFacts = Readonly<{
    id: string
    coverId: string
    disposed: boolean
    minimumSourceMatrixLevel: number
    sourceMaximumMatrixLevel: number
    maximumDemands: number
    sourceLimitCount: number
}>

type MutableDemand = { -readonly [Key in keyof WebMercatorQuadProjectedDemand]: WebMercatorQuadProjectedDemand[Key] }
let nextProjectionId = 1

/** Projects complete CPU geometry into source intent; owns no loading, residency or GPU work. */
export class WebMercatorQuadDemandProjection {
    #id = `geo-web-mercator-quad-demand-${nextProjectionId++}`
    #cover: WebMercatorQuadCover | undefined
    #coverId: string
    #sourceCoverage: TileMatrixCoverage
    #maximumDemands: number
    #coordinateBits: number

    constructor(input: WebMercatorQuadDemandProjectionDescriptor) {
        const cover = input?.cover
        if (!isWebMercatorQuadCover(cover)) invalidProjection(this.id, 'foreign-cover', {})
        const descriptor = webMercatorQuadCoverDescriptor(cover)
        if (input?.sourceCoverage?.tileMatrixSet !== WebMercatorQuad ||
            !Number.isSafeInteger(input.maximumDemands) || input.maximumDemands <= 0 ||
            input.maximumDemands > descriptor.policy.maximumPatches) {
            invalidProjection(this.id, 'descriptor', { maximumDemands: input?.maximumDemands })
        }
        const coverage = tileMatrixCoverage({ tileMatrixSet: WebMercatorQuad, limits: input.sourceCoverage.limits })
        const minimum = Number(coverage.limits[0].matrixId)
        const maximum = Number(coverage.limits.at(-1)!.matrixId)
        if (!coverage.limits.every((limit, i) => Number(limit.matrixId) === minimum + i) ||
            minimum > descriptor.policy.minimumMatrixLevel || maximum >= descriptor.spatialProfile.coordinateBits) {
            invalidProjection(this.id, 'source-levels', { minimum, maximum })
        }
        this.#cover = cover
        this.#coverId = cover.id
        this.#sourceCoverage = coverage
        this.#maximumDemands = input.maximumDemands
        this.#coordinateBits = descriptor.spatialProfile.coordinateBits
        Object.preventExtensions(this)
    }

    get id(): string { return this.#id }
    get isDisposed(): boolean { return this.#cover === undefined }

    project(selection: WebMercatorQuadCoverSelection): WebMercatorQuadProjectedDemands {
        if (this.#cover === undefined) return invalidProjection(this.id, 'disposed', {})
        const { descriptor } = webMercatorQuadCoverSelectionData(selection, this.#cover)
        const limits = this.#sourceCoverage.limits
        const first = Number(limits[0].matrixId), ceiling = Number(limits.at(-1)!.matrixId)
        const camera = descriptor.spatialProfile.encodeCamera([
            selection.view.cameraHigh[0] + selection.view.cameraLow[0],
            selection.view.cameraHigh[1] + selection.view.cameraLow[1],
        ])
        const fixed = camera.low.map((low, axis) => low + camera.high[axis] * 2 ** 32)
        const demands: MutableDemand[] = [], byIdentity = new Map<string, MutableDemand>()
        for (const patch of selection.patches) {
            const desired = patch.matrixLevel
            let level = Math.min(desired, ceiling), row = 0, col = 0, found = false
            while (level >= first) {
                const scale = 2 ** (desired - level), limit = limits[level - first]
                row = Math.floor(patch.tileRow / scale)
                col = Math.floor(patch.tileCol / scale)
                if (row >= limit.minTileRow && row <= limit.maxTileRow && col >= limit.minTileCol && col <= limit.maxTileCol) {
                    found = true
                    break
                }
                level--
            }
            if (!found) continue
            const scale = 2 ** (this.#coordinateBits - level)
            const cameraCol = Math.floor(fixed[0] / scale), cameraRow = Math.floor(fixed[1] / scale)
            const dc = Math.abs(col - cameraCol)
            const distance = Math.abs(row - cameraRow) + Math.min(dc, 2 ** level - dc)
            const priority = desired * 1_000_000 + 999_999 - Math.min(distance, 999_999)
            const key = `${level}/${row}/${col}`, previous = byIdentity.get(key)
            if (previous !== undefined) {
                previous.desiredSampleLevel = Math.max(previous.desiredSampleLevel, desired)
                previous.priority = Math.max(previous.priority, priority)
                continue
            }
            if (demands.length >= this.#maximumDemands) {
                return invalidProjection(this.id, 'demand-capacity', {
                    maximumDemands: this.#maximumDemands, selectionId: selection.id,
                })
            }
            const demand: MutableDemand = { desiredSampleLevel: desired, sourceLevelCeiling: ceiling,
                requestMatrixLevel: level, tileRow: row, tileCol: col, priority,
                decisionFrameEpoch: selection.view.frameEpoch, residencySnapshotEpoch: selection.view.residencySnapshotEpoch }
            demands.push(demand)
            byIdentity.set(key, demand)
        }
        return Object.freeze({ kind: 'web-mercator-quad-projected-demands', projectionId: this.id,
            coverId: selection.coverId, selectionId: selection.id, selectionRevision: selection.revision,
            view: selection.view, frameEpoch: selection.view.frameEpoch,
            demandCount: demands.length, overflowCount: 0, sourceLevelCeiling: ceiling,
            demands: Object.freeze(demands.map(demand => Object.freeze(demand))) })
    }

    facts(): WebMercatorQuadDemandProjectionFacts {
        return Object.freeze({ id: this.id, coverId: this.#coverId, disposed: this.isDisposed,
            minimumSourceMatrixLevel: Number(this.#sourceCoverage.limits[0].matrixId),
            sourceMaximumMatrixLevel: Number(this.#sourceCoverage.limits.at(-1)!.matrixId),
            maximumDemands: this.#maximumDemands, sourceLimitCount: this.#sourceCoverage.limits.length })
    }

    dispose(): void { this.#cover = undefined }
}

Object.freeze(WebMercatorQuadDemandProjection.prototype)

function invalidProjection(id: string, reason: string, actual: Record<string, unknown>): never {
    return throwGeoDiagnostic({ code: 'GEO_WEB_MERCATOR_DEMAND_PROJECTION_INVALID', phase: 'demand',
        subject: { kind: 'web-mercator-quad-demand-projection', id },
        message: 'CPU source projection requires a complete owned selection and bounded source coverage.',
        actual: { reason, ...actual } })
}
