import type { GPURuntime, WorkerModuleResolver } from 'geoscratch/scratch'
import {
    WebMercatorQuad,
    createVirtualRasterRuntime,
    tileMatrixCoverage,
    webMercatorVirtualRasterField,
} from 'geoscratch/geo'
import type {
    TileMatrixCoverage,
    TileMatrixLimits,
    VirtualRasterPageIdentity,
    VirtualRasterRuntime,
    WebMercatorTerrainElevationBounds,
} from 'geoscratch/geo'
import {
    createDemWorkerRequestExecutor,
} from './dem-tile-executor.ts'
import type { DemWorkerRequestExecutor } from './dem-tile-executor.ts'
import type { UnderwaterTerrainCachePolicy } from './cache-policy.ts'

type NumberSequence = ArrayLike<number> & Iterable<number>

type DemVirtualRasterManifest = Readonly<{
    schemaVersion: 3
    sourceHash: string
    contentVersion: string
    source: Readonly<{
        crs: 'EPSG:4326'
        geographicBounds: readonly [number, number, number, number]
        rasterDimensions: Readonly<{ width: number; height: number }>
        sampleType: 'uint8'
        bitsPerSample: 8
    }>
    projectedBounds: Readonly<{
        crs: 'http://www.opengis.net/def/crs/EPSG/0/3857'
        bounds: readonly [number, number, number, number]
    }>
    tileMatrixSet: Readonly<{
        id: 'WebMercatorQuad'
        uri: 'http://www.opengis.net/def/tilematrixset/OGC/1.0/WebMercatorQuad'
        crs: 'http://www.opengis.net/def/crs/EPSG/0/3857'
        cornerOfOrigin: 'topLeft'
        tileRowDirection: 'south'
        tileColDirection: 'east'
        tileWidth: 256
        tileHeight: 256
        minTileMatrix: string
        maxTileMatrix: string
        tileMatrixIds: readonly string[]
        limits: readonly TileMatrixLimits[]
    }>
    tileElevationBounds: readonly WebMercatorTerrainElevationBounds[]
    nativeResolution: Readonly<{
        closestTileMatrix: string
        tileMatrixCellSizeMeters: number
        sourceProjectedPixelSizeMeters: readonly [number, number]
        tileMatrixCellsPerSourcePixel: readonly [number, number]
        resampling: 'nearest'
    }>
    nodata: number | null
    scale: number
    offset: number
    overviewLevels: readonly number[]
    pixelOrientation: Readonly<{
        source: 'north-up-row-major'
        cog: 'north-up-row-major'
        tile: 'north-up-row-major'
    }>
    outerBoundary: 'clamp'
    cacheValidators: Readonly<{
        coherence: 'immutable'
        encodedRepresentation: 'image/png'
        decoderVersion: string
        etag: 'content-version-and-standard-tile'
    }>
}>

type DemVirtualRasterModel = ReturnType<typeof createDemVirtualRasterModel>

type ParsedDemVirtualRasterManifest = Readonly<{
    manifest: DemVirtualRasterManifest
    coverage: TileMatrixCoverage
    elevationRangeMeters: readonly [number, number]
}>

export type DemTileSourceFacts = Readonly<{
    kind: 'dem-tile-source-facts'
    sourceId: string
    contentVersion: string
    coordinateEncoding: string
    coordinateBits: number
    coordinateQuantumMeters: number
    tileMatrixSetId: 'WebMercatorQuad'
    tileOrientation: 'north-up-row-major'
    sourceOrientation: 'north-up-row-major'
}>

export type DemTileSource = Readonly<{
    kind: 'dem-tile-source'
    id: string
    manifest: DemVirtualRasterManifest
    elevationRangeMeters: readonly [number, number]
    elevationBounds: readonly WebMercatorTerrainElevationBounds[]
    model: DemVirtualRasterModel
    facts: DemTileSourceFacts
    tileUrl(page: VirtualRasterPageIdentity): string
}>

export type DemVirtualRaster = VirtualRasterRuntime<DemVirtualRasterModel> & Readonly<{
    source: DemTileSource
    workerFacts(): ReturnType<DemWorkerRequestExecutor['inspect']>
}>

type DemVirtualRasterOptions = Readonly<{
    runtime: GPURuntime
    source: DemTileSource
    cachePolicy: UnderwaterTerrainCachePolicy
    workerModules: WorkerModuleResolver
    workerCount?: number
    maxNetworkRequests?: number
    maxDecodeTasks?: number
    maxRequests?: number
    maxPhysicalPages?: number
    maxStagingBytes?: number
    maxHistory?: number
}>

export const DEM_WEB_MERCATOR_COORDINATE_BITS = 40
const DEM_DEFAULT_PHYSICAL_PAGES = 18
const DEM_DEFAULT_HISTORY = 64
const DEM_DEFAULT_MAX_REQUESTS = 24

const DEM_TILE_SIZE = 256
const DEM_CACHE_SCHEMA_VERSION = 2

function parseDemVirtualRasterManifest(value: unknown): ParsedDemVirtualRasterManifest {

    const manifest = value as Partial<DemVirtualRasterManifest> | null
    const source = manifest?.source
    const projected = manifest?.projectedBounds
    const matrixSet = manifest?.tileMatrixSet
    const resolution = manifest?.nativeResolution
    const orientation = manifest?.pixelOrientation
    const validators = manifest?.cacheValidators
    const scale = manifest?.scale
    const offset = manifest?.offset
    if (manifest === null || typeof manifest !== 'object' ||
        manifest.schemaVersion !== 3 ||
        typeof manifest.sourceHash !== 'string' || !/^[0-9a-f]{64}$/.test(manifest.sourceHash) ||
        typeof manifest.contentVersion !== 'string' || manifest.contentVersion.length === 0 ||
        source?.crs !== 'EPSG:4326' || !isFiniteTuple(source.geographicBounds, 4) ||
        !positiveInteger(source.rasterDimensions?.width) ||
        !positiveInteger(source.rasterDimensions?.height) ||
        source.sampleType !== 'uint8' || source.bitsPerSample !== 8 ||
        projected?.crs !== WebMercatorQuad.crs || !isFiniteTuple(projected.bounds, 4) ||
        matrixSet?.id !== WebMercatorQuad.id || matrixSet.uri !== WebMercatorQuad.uri ||
        matrixSet.crs !== WebMercatorQuad.crs || matrixSet.cornerOfOrigin !== 'topLeft' ||
        matrixSet.tileRowDirection !== 'south' || matrixSet.tileColDirection !== 'east' ||
        matrixSet.tileWidth !== DEM_TILE_SIZE || matrixSet.tileHeight !== DEM_TILE_SIZE ||
        !Array.isArray(matrixSet.tileMatrixIds) || matrixSet.tileMatrixIds.length === 0 ||
        matrixSet.minTileMatrix !== matrixSet.tileMatrixIds[0] ||
        matrixSet.maxTileMatrix !== matrixSet.tileMatrixIds.at(-1) ||
        !Array.isArray(matrixSet.limits) || matrixSet.limits.length !== matrixSet.tileMatrixIds.length ||
        resolution?.closestTileMatrix !== matrixSet.maxTileMatrix ||
        !positiveFinite(resolution.tileMatrixCellSizeMeters) ||
        !isPositiveTuple(resolution.sourceProjectedPixelSizeMeters, 2) ||
        !isPositiveTuple(resolution.tileMatrixCellsPerSourcePixel, 2) ||
        resolution.resampling !== 'nearest' ||
        (manifest.nodata !== null && !Number.isFinite(manifest.nodata)) ||
        typeof scale !== 'number' || !positiveFinite(scale) ||
        typeof offset !== 'number' || !Number.isFinite(offset) ||
        !sameValues(manifest.overviewLevels, [ 2, 4, 8 ]) ||
        orientation?.source !== 'north-up-row-major' ||
        orientation.cog !== 'north-up-row-major' || orientation.tile !== 'north-up-row-major' ||
        manifest.outerBoundary !== 'clamp' || validators?.coherence !== 'immutable' ||
        validators.encodedRepresentation !== 'image/png' ||
        typeof validators.decoderVersion !== 'string' || validators.decoderVersion.length === 0 ||
        validators.etag !== 'content-version-and-standard-tile') {
        throw new TypeError('DEM manifest does not match the WebMercatorQuad COG contract')
    }
    const snapshot = deepFreeze(structuredClone(manifest) as DemVirtualRasterManifest)
    assertOrderedBounds(snapshot.source.geographicBounds, 'DEM geographic bounds')
    assertOrderedBounds(snapshot.projectedBounds.bounds, 'DEM projected bounds')
    const coverage = createDemCoverage(snapshot.tileMatrixSet.limits)
    if (!sameValues(
        snapshot.tileMatrixSet.tileMatrixIds,
        coverage.limits.map(limit => limit.matrixId)
    )) {
        throw new TypeError('DEM TileMatrixLimits must follow the declared matrix order')
    }
    const elevationBounds = snapshot.tileElevationBounds
    if (!Array.isArray(elevationBounds) ||
        elevationBounds.length !== coverage.entryCount) {
        throw new TypeError('DEM tile elevation bounds must cover every declared tile')
    }
    const elevationRangeMeters = Object.freeze([
        snapshot.offset,
        snapshot.offset + snapshot.scale * 255,
    ]) as readonly [number, number]
    for (let index = 0; index < elevationBounds.length; index++) {
        const bounds = elevationBounds[index]!
        const expected = coverage.coordinate(index)
        if (!nonNegativeInteger(bounds?.matrixLevel) ||
            !nonNegativeInteger(bounds?.tileRow) ||
            !nonNegativeInteger(bounds?.tileCol) ||
            String(bounds.matrixLevel) !== expected.matrixId ||
            bounds.tileRow !== expected.tileRow || bounds.tileCol !== expected.tileCol ||
            !Number.isFinite(bounds?.minimumElevationMeters) ||
            !Number.isFinite(bounds?.maximumElevationMeters) ||
            bounds.minimumElevationMeters > bounds.maximumElevationMeters ||
            bounds.minimumElevationMeters < elevationRangeMeters[0] ||
            bounds.maximumElevationMeters > elevationRangeMeters[1]) {
            throw new TypeError(`DEM tile elevation bounds ${index} is invalid`)
        }
    }
    return Object.freeze({ manifest: snapshot, coverage, elevationRangeMeters })
}

function createDemVirtualRasterModel(
    manifest: DemVirtualRasterManifest,
    coverage: TileMatrixCoverage
) {
    return webMercatorVirtualRasterField({
        id: 'dem-height',
        addressSpaceId: `dem.wmq.${manifest.sourceHash.slice(0, 16)}`,
        sourceRevision: manifest.contentVersion,
        coverage,
        geographicBounds: manifest.source.geographicBounds,
        coordinateBits: DEM_WEB_MERCATOR_COORDINATE_BITS,
        fieldKind: 'scalar',
        channels: 1,
        sampleType: 'unorm8',
        gpuFormat: 'r8unorm',
        unit: 'm',
        ...(manifest.nodata === null ? {} : { noData: manifest.nodata }),
        interpolation: 'linear',
        scale: manifest.scale,
        offset: manifest.offset,
        auxiliaryAxes: [ { name: 'tile-matrix', value: 'explicit-WebMercatorQuad' } ],
    })
}

/** Validates one manifest and captures the immutable model and tile URL authority. */
export function createDemTileSource({
    manifest: value,
    tileServerUrl,
}: Readonly<{
    manifest: unknown
    tileServerUrl: string
}>): DemTileSource {

    if (typeof tileServerUrl !== 'string' || tileServerUrl.length === 0) {
        throw new TypeError('DEM tile source requires a non-empty tile server URL')
    }
    const parsed = parseDemVirtualRasterManifest(value)
    const { manifest, coverage, elevationRangeMeters } = parsed
    const model = createDemVirtualRasterModel(manifest, coverage)
    const baseUrl = tileServerUrl.replace(/\/$/, '')
    const id = `dem.${manifest.sourceHash}`
    const facts = Object.freeze({
        kind: 'dem-tile-source-facts' as const,
        sourceId: id,
        contentVersion: manifest.contentVersion,
        coordinateEncoding: model.addressCodec.positionCodec.facts.encoding,
        coordinateBits: model.addressCodec.coordinateBits,
        coordinateQuantumMeters: model.addressCodec.quantumMeters,
        tileMatrixSetId: manifest.tileMatrixSet.id,
        tileOrientation: manifest.pixelOrientation.tile,
        sourceOrientation: manifest.pixelOrientation.source,
    })
    return Object.freeze({
        kind: 'dem-tile-source' as const,
        id,
        manifest,
        elevationRangeMeters,
        elevationBounds: manifest.tileElevationBounds,
        model,
        facts,
        tileUrl(page: VirtualRasterPageIdentity) {

            const tile = page.tile
            if (tile === undefined || tile.tileMatrixSetId !== manifest.tileMatrixSet.id) {
                throw new TypeError('DEM tile URL requires a standard WebMercatorQuad page')
            }
            return `${baseUrl}/tiles/WebMercatorQuad/` +
                `${encodeURIComponent(tile.matrixId)}/${tile.tileRow}/${tile.tileCol}.png` +
                `?v=${encodeURIComponent(manifest.contentVersion)}`
        },
    })
}

/** Fetches the mutable manifest endpoint without browser caching, then creates one source. */
export async function fetchDemTileSource(
    baseUrl: string,
    signal: AbortSignal
): Promise<DemTileSource> {

    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/manifest.json`, {
        signal,
        cache: 'no-store',
    })
    if (!response.ok) throw new Error(`DEM manifest request failed with HTTP ${response.status}`)
    return createDemTileSource({
        manifest: await response.json(),
        tileServerUrl: baseUrl,
    })
}

/** Composes one DEM source with an owned Worker executor and generic Virtual Raster runtime. */
export async function createDemVirtualRaster({
    runtime,
    source,
    cachePolicy,
    workerModules,
    workerCount,
    maxNetworkRequests,
    maxDecodeTasks,
    maxRequests = DEM_DEFAULT_MAX_REQUESTS,
    maxPhysicalPages = DEM_DEFAULT_PHYSICAL_PAGES,
    maxStagingBytes = maxPhysicalPages * DEM_TILE_SIZE * DEM_TILE_SIZE,
    maxHistory = DEM_DEFAULT_HISTORY,
}: DemVirtualRasterOptions): Promise<DemVirtualRaster> {

    const { manifest, model } = source
    const requestExecutor = await createDemWorkerRequestExecutor({
        sourceId: source.id,
        tileMatrixSetId: 'WebMercatorQuad',
        tileMatrixSetUri: manifest.tileMatrixSet.uri,
        plane: 'height',
        contentVersion: manifest.contentVersion,
        encodedRepresentation: manifest.cacheValidators.encodedRepresentation,
        decoderVersion: manifest.cacheValidators.decoderVersion,
        sampleType: manifest.source.sampleType,
        cacheSchemaVersion: DEM_CACHE_SCHEMA_VERSION,
        cachePolicy,
        workerModules,
        ...(workerCount === undefined ? {} : { workerCount }),
        ...(maxNetworkRequests === undefined ? {} : { maxNetworkRequests }),
        ...(maxDecodeTasks === undefined ? {} : { maxDecodeTasks }),
        maxRequests,
        tileUrl: source.tileUrl,
    })
    const virtualRaster = await createVirtualRasterRuntime({
        runtime,
        model,
        executor: {
            ownership: 'owned',
            executor: requestExecutor,
        },
        maxRequests,
        maxPhysicalPages,
        maxStagingBytes,
        maxHistory,
        viewDemandProducerId: `dem-view-demand.${model.id}`,
    })
    return Object.freeze({
        ...virtualRaster,
        source,
        workerFacts: requestExecutor.inspect,
    })
}

function assertOrderedBounds(value: NumberSequence, name: string): void {

    if (value[0] >= value[2] || value[1] >= value[3]) {
        throw new TypeError(`${name} must be strictly ordered`)
    }
}

function createDemCoverage(limits: readonly TileMatrixLimits[]): TileMatrixCoverage {

    try {
        return tileMatrixCoverage({ tileMatrixSet: WebMercatorQuad, limits })
    } catch {
        throw new TypeError('DEM TileMatrixLimits are invalid')
    }
}

function isFiniteTuple(value: unknown, length: number): value is NumberSequence {

    return (Array.isArray(value) || ArrayBuffer.isView(value)) &&
        (value as NumberSequence).length === length &&
        Array.from(value as NumberSequence).every(Number.isFinite)
}

function isPositiveTuple(value: unknown, length: number): value is NumberSequence {

    return isFiniteTuple(value, length) && Array.from(value).every(number => number > 0)
}

function sameValues(left: unknown, right: readonly (number | string)[]): boolean {

    return Array.isArray(left) && left.length === right.length &&
        left.every((value, index) => value === right[index])
}

function positiveInteger(value: unknown): value is number {

    return Number.isSafeInteger(value) && Number(value) > 0
}

function nonNegativeInteger(value: unknown): value is number {

    return Number.isSafeInteger(value) && Number(value) >= 0
}

function positiveFinite(value: unknown): value is number {

    return Number.isFinite(value) && Number(value) > 0
}

function deepFreeze<T>(value: T): T {

    if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
    for (const child of Object.values(value)) deepFreeze(child)
    return Object.freeze(value) as T
}
