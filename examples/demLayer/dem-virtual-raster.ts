import type { GPURuntime, WorkerModuleResolver } from 'geoscratch/scratch'
import {
    WebMercatorQuad,
    createVirtualRasterRuntime,
    tileMatrixCoverage,
    webMercatorVirtualRasterField,
} from 'geoscratch/geo'
import type { VirtualRasterPageIdentity } from 'geoscratch/geo'
import {
    createDemWorkerRequestExecutor,
} from './dem-tile-executor.ts'
import type { DemWorkerRequestExecutor } from './dem-tile-executor.ts'
import type { DemCachePolicy } from './dem-tile-protocol.ts'

type NumberSequence = ArrayLike<number> & Iterable<number>

type DemTileMatrixLimit = Readonly<{
    matrixId: string
    minTileRow: number
    maxTileRow: number
    minTileCol: number
    maxTileCol: number
}>

type DemVirtualRasterManifest = Readonly<{
    schemaVersion: 2
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
        limits: readonly DemTileMatrixLimit[]
    }>
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

type DemVirtualRasterRuntimeOptions = Readonly<{
    runtime: GPURuntime
    manifest: DemVirtualRasterManifest
    tileServerUrl: string
    cachePolicy: DemCachePolicy
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

export function parseDemVirtualRasterManifest(value: unknown): DemVirtualRasterManifest {

    const manifest = value as Partial<DemVirtualRasterManifest> | null
    const source = manifest?.source
    const projected = manifest?.projectedBounds
    const matrixSet = manifest?.tileMatrixSet
    const resolution = manifest?.nativeResolution
    const orientation = manifest?.pixelOrientation
    const validators = manifest?.cacheValidators
    if (manifest === null || typeof manifest !== 'object' ||
        manifest.schemaVersion !== 2 ||
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
        !Number.isFinite(manifest.scale) || !Number.isFinite(manifest.offset) ||
        !sameNumbers(manifest.overviewLevels, [ 2, 4, 8 ]) ||
        orientation?.source !== 'north-up-row-major' ||
        orientation.cog !== 'north-up-row-major' || orientation.tile !== 'north-up-row-major' ||
        manifest.outerBoundary !== 'clamp' || validators?.coherence !== 'immutable' ||
        validators.encodedRepresentation !== 'image/png' ||
        typeof validators.decoderVersion !== 'string' || validators.decoderVersion.length === 0 ||
        validators.etag !== 'content-version-and-standard-tile') {
        throw new TypeError('DEM manifest does not match the WebMercatorQuad COG contract')
    }
    assertOrderedBounds(source.geographicBounds, 'DEM geographic bounds')
    assertOrderedBounds(projected.bounds, 'DEM projected bounds')
    const seen = new Set<string>()
    for (let index = 0; index < matrixSet.limits.length; index++) {
        const limit = matrixSet.limits[index]!
        if (limit.matrixId !== matrixSet.tileMatrixIds[index] || seen.has(limit.matrixId) ||
            !nonNegativeInteger(limit.minTileRow) || !nonNegativeInteger(limit.maxTileRow) ||
            !nonNegativeInteger(limit.minTileCol) || !nonNegativeInteger(limit.maxTileCol) ||
            limit.minTileRow > limit.maxTileRow || limit.minTileCol > limit.maxTileCol) {
            throw new TypeError(`DEM TileMatrixLimits ${index} is invalid`)
        }
        WebMercatorQuad.tile({
            matrixId: limit.matrixId,
            tileRow: limit.maxTileRow,
            tileCol: limit.maxTileCol,
        })
        seen.add(limit.matrixId)
    }
    return deepFreeze(structuredClone(manifest) as DemVirtualRasterManifest)
}

export function createDemVirtualRasterModel(manifest: DemVirtualRasterManifest) {

    const parsed = parseDemVirtualRasterManifest(manifest)
    const coverage = tileMatrixCoverage({
        tileMatrixSet: WebMercatorQuad,
        limits: parsed.tileMatrixSet.limits,
    })
    const model = webMercatorVirtualRasterField({
        id: 'dem-height',
        addressSpaceId: `dem.wmq.${parsed.sourceHash.slice(0, 16)}`,
        sourceRevision: parsed.contentVersion,
        coverage,
        geographicBounds: parsed.source.geographicBounds,
        coordinateBits: DEM_WEB_MERCATOR_COORDINATE_BITS,
        fieldKind: 'scalar',
        channels: 1,
        sampleType: 'unorm8',
        gpuFormat: 'r8unorm',
        unit: 'm',
        ...(parsed.nodata === null ? {} : { noData: parsed.nodata }),
        interpolation: 'linear',
        scale: parsed.scale,
        offset: parsed.offset,
        auxiliaryAxes: [ { name: 'tile-matrix', value: 'explicit-WebMercatorQuad' } ],
    })
    return Object.freeze({
        ...model,
        manifest: parsed,
    })
}

export function demTileUrl(
    manifest: DemVirtualRasterManifest,
    baseUrl: string,
    page: VirtualRasterPageIdentity
): string {

    const parsed = parseDemVirtualRasterManifest(manifest)
    const tile = page.tile
    if (tile === undefined || tile.tileMatrixSetId !== parsed.tileMatrixSet.id) {
        throw new TypeError('DEM tile URL requires a standard WebMercatorQuad page')
    }
    return `${baseUrl.replace(/\/$/, '')}/tiles/WebMercatorQuad/` +
        `${encodeURIComponent(tile.matrixId)}/${tile.tileRow}/${tile.tileCol}.png` +
        `?v=${encodeURIComponent(parsed.contentVersion)}`
}

export async function fetchDemVirtualRasterManifest(
    baseUrl: string,
    signal: AbortSignal
): Promise<DemVirtualRasterManifest> {

    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/manifest.json`, {
        signal,
        cache: 'no-store',
    })
    if (!response.ok) throw new Error(`DEM manifest request failed with HTTP ${response.status}`)
    return parseDemVirtualRasterManifest(await response.json())
}

export async function createDemVirtualRasterRuntime({
    runtime,
    manifest,
    tileServerUrl,
    cachePolicy,
    workerModules,
    workerCount,
    maxNetworkRequests,
    maxDecodeTasks,
    maxRequests = DEM_DEFAULT_MAX_REQUESTS,
    maxPhysicalPages = DEM_DEFAULT_PHYSICAL_PAGES,
    maxStagingBytes = maxPhysicalPages * DEM_TILE_SIZE * DEM_TILE_SIZE,
    maxHistory = DEM_DEFAULT_HISTORY,
}: DemVirtualRasterRuntimeOptions) {

    const model = createDemVirtualRasterModel(manifest)
    let requestExecutor: DemWorkerRequestExecutor | undefined
    try {
        requestExecutor = await createDemWorkerRequestExecutor({
            sourceId: `dem.${manifest.sourceHash}`,
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
            tileUrl: page => demTileUrl(manifest, tileServerUrl, page),
        })
        const virtualRaster = await createVirtualRasterRuntime({
            runtime,
            model,
            executor: {
                ownership: 'borrowed',
                executor: requestExecutor,
            },
            maxRequests,
            maxPhysicalPages,
            maxStagingBytes,
            maxHistory,
            viewDemandProducerId: `dem-view-demand.${model.id}`,
        })
        let stopped = false
        let stopPromise: Promise<void> | undefined

        function dispose(): Promise<void> {

            if (stopPromise !== undefined) return stopPromise
            stopped = true
            stopPromise = stop()
            return stopPromise
        }

        async function stop(): Promise<void> {

            const failures: unknown[] = []
            try {
                await virtualRaster.dispose()
            } catch (error) {
                failures.push(error)
            }
            try {
                await requestExecutor!.dispose()
            } catch (error) {
                failures.push(error)
            }
            if (failures.length > 0) {
                throw new AggregateError(failures, 'DEM Virtual Raster disposal failed')
            }
        }

        return Object.freeze({
            ...virtualRaster,
            manifest: model.manifest,
            dispose,
            inspect: () => {
                const facts = virtualRaster.inspect()
                return Object.freeze({
                    ...facts,
                    contentVersion: model.manifest.contentVersion,
                    coordinateEncoding: model.addressCodec.positionCodec.facts.encoding,
                    coordinateBits: model.addressCodec.coordinateBits,
                    coordinateQuantumMeters: model.addressCodec.quantumMeters,
                    tileMatrixSetId: model.manifest.tileMatrixSet.id,
                    tileOrientation: model.manifest.pixelOrientation.tile,
                    sourceOrientation: model.manifest.pixelOrientation.source,
                    cachePolicy: cachePolicy.mode,
                    cacheConfiguration: cachePolicy,
                    stopped,
                    worker: requestExecutor!.inspect(),
                })
            },
        })
    } catch (error) {
        if (requestExecutor === undefined) throw error
        try {
            await requestExecutor.dispose()
        } catch (cleanupError) {
            throw new AggregateError(
                [ error, cleanupError ],
                'DEM Virtual Raster initialization and cleanup failed'
            )
        }
        throw error
    }
}

function assertOrderedBounds(value: NumberSequence, name: string): void {

    if (value[0] >= value[2] || value[1] >= value[3]) {
        throw new TypeError(`${name} must be strictly ordered`)
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

function sameNumbers(left: unknown, right: readonly number[]): boolean {

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
