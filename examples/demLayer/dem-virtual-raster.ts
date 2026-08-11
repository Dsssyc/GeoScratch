import type { GPURuntime } from 'geoscratch/scratch'
import {
    WebMercatorQuad,
    createVirtualRasterRuntime,
    geoField,
    tileMatrixCoverage,
    tiledFieldRepresentation,
    virtualRasterPlane,
    virtualRasterTileAddressSpace,
    webMercatorPlanarTileSpatialProfile,
    webMercatorQuadAddressCodec,
} from 'geoscratch/geo'
import type {
    VirtualRasterPageIdentity,
    WebMercatorQuadAddressCodec,
    WideFixedPosition,
} from 'geoscratch/geo'
import {
    createDemWorkerRequestExecutor,
} from './dem-worker-source.ts'
import type { DemWorkerRequestExecutor } from './dem-worker-source.ts'
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
    const addressSpace = virtualRasterTileAddressSpace({
        id: `dem.wmq.${parsed.sourceHash.slice(0, 16)}`,
        coverage,
    })
    const addressCodec = webMercatorQuadAddressCodec({
        coverage,
        coordinateBits: DEM_WEB_MERCATOR_COORDINATE_BITS,
    })
    const spatialProfile = webMercatorPlanarTileSpatialProfile({ addressCodec })
    const plane = virtualRasterPlane({
        id: `dem-height.${parsed.contentVersion}`,
        addressSpace,
        kind: 'scalar',
        channels: 1,
        sampleType: 'unorm8',
        gpuFormat: 'r8unorm',
        ...(parsed.nodata === null ? {} : { noData: parsed.nodata }),
        scale: parsed.scale,
        offset: parsed.offset,
        auxiliaryAxes: [ { name: 'tile-matrix', value: 'explicit-WebMercatorQuad' } ],
    })
    const field = geoField({
        id: `dem-height.${parsed.contentVersion}`,
        domain: addressCodec.positionCodec.domain,
        kind: 'scalar',
        channels: 1,
        sampleType: 'unorm8',
        unit: 'm',
        ...(parsed.nodata === null ? {} : { noData: parsed.nodata }),
        interpolation: 'linear',
    })
    const representation = tiledFieldRepresentation({
        id: `dem-height.WebMercatorQuad.${parsed.contentVersion}`,
        field,
        plane,
        spatialProfile,
        sourceRevision: parsed.contentVersion,
    })
    const safetyLimit = coverage.limit(parsed.tileMatrixSet.minTileMatrix)!
    const safetyCoverPages: VirtualRasterPageIdentity[] = []
    for (let row = safetyLimit.minTileRow; row <= safetyLimit.maxTileRow; row++) {
        for (let col = safetyLimit.minTileCol; col <= safetyLimit.maxTileCol; col++) {
            safetyCoverPages.push(addressSpace.pageFromTile({
                matrixId: safetyLimit.matrixId,
                tileRow: row,
                tileCol: col,
            }))
        }
    }
    return Object.freeze({
        id: representation.id,
        manifest: parsed,
        coverage,
        addressSpace,
        addressCodec,
        spatialProfile,
        field,
        representation,
        plane,
        safetyCoverPages: Object.freeze(safetyCoverPages),
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
            ...(workerCount === undefined ? {} : { workerCount }),
            ...(maxNetworkRequests === undefined ? {} : { maxNetworkRequests }),
            ...(maxDecodeTasks === undefined ? {} : { maxDecodeTasks }),
            maxRequests,
            tileUrl: page => demTileUrl(manifest, tileServerUrl, page),
        })
        const virtualRaster = await createVirtualRasterRuntime({
            runtime,
            model,
            executor: requestExecutor,
            maxRequests,
            maxPhysicalPages,
            maxStagingBytes,
            maxHistory,
            viewDemandProducerId: `dem-view-demand.${model.id}`,
        })
        let stopped = false
        let stopPromise: Promise<void> | undefined

        function stopStreaming(): Promise<void> {

            if (stopPromise !== undefined) return stopPromise
            stopped = true
            stopPromise = stop()
            return stopPromise
        }

        async function stop(): Promise<void> {

            await virtualRaster.stopDemand()
            await requestExecutor!.refreshFacts()
            await requestExecutor!.dispose()
            await virtualRaster.dispose()
        }

        return Object.freeze({
            ...virtualRaster,
            manifest: model.manifest,
            executor: requestExecutor,
            stopStreaming,
            inspect: () => {
                const facts = virtualRaster.inspect()
                return Object.freeze({
                    contentVersion: model.manifest.contentVersion,
                    coordinateEncoding: model.addressCodec.positionCodec.facts.encoding,
                    coordinateBits: model.addressCodec.coordinateBits,
                    coordinateQuantumMeters: model.addressCodec.quantumMeters,
                    tileMatrixSetId: model.manifest.tileMatrixSet.id,
                    tileOrientation: model.manifest.pixelOrientation.tile,
                    sourceOrientation: model.manifest.pixelOrientation.source,
                    cachePolicy: cachePolicy.mode,
                    cacheConfiguration: cachePolicy,
                    demandStopped: facts.demandStopped,
                    stopped,
                    residency: facts.residency,
                    scheduler: facts.scheduler,
                    demand: facts.demand,
                    worker: requestExecutor!.inspect(),
                    gpu: facts.gpu,
                })
            },
        })
    } catch (error) {
        await requestExecutor?.dispose()
        throw error
    }
}

export function demVirtualRasterWgslModule(model: DemVirtualRasterModel): string {

    const codec = model.addressCodec
    const matrixIds = Array.from({ length: model.addressSpace.levelCount }, (_, level) =>
        `${Number(model.addressSpace.matrixId(level))}u`
    ).join(', ')
    const sourceBounds = model.manifest.source.geographicBounds
    const canonicalMinimum = canonicalPosition(codec, [ sourceBounds[0], sourceBounds[1] ])
    const canonicalMaximum = canonicalPosition(codec, [ sourceBounds[2], sourceBounds[3] ])
    const minimums: string[] = []
    const maximums: string[] = []
    for (let level = 0; level < model.addressSpace.levelCount; level++) {
        const matrixId = model.addressSpace.matrixId(level)
        const northwest = codec.address(codec.fromLonLat([ sourceBounds[0], sourceBounds[3] ]), matrixId)
        const southeast = codec.address(codec.fromLonLat([ sourceBounds[2], sourceBounds[1] ]), matrixId)
        minimums.push(`vec2u(${coveredTexel(northwest, 0, 'minimum')}u, ` +
            `${coveredTexel(northwest, 1, 'minimum')}u)`)
        maximums.push(`vec2u(${coveredTexel(southeast, 0, 'maximum')}u, ` +
            `${coveredTexel(southeast, 1, 'maximum')}u)`)
    }
    const positionLiteral = (position: WideFixedPosition) => {
        const axes = position.limbs.map(axis =>
            `DemAddressFixedAxis(${axis.low}u, ${axis.high}u)`
        ).join(', ')
        return `DemAddressFixedPosition(array<DemAddressFixedAxis, 2>(${axes}))`
    }
    const rawScale = model.plane.sampleType === 'unorm8' ? 255 : 1
    return `${codec.wgslModule({ namespace: 'DemAddress' })}\n\n` +
        `struct DemHeightSample {\n` +
        `    value: vec4f,\n    status: u32,\n    requested_level: u32,\n    resolved_level: u32,\n}\n\n` +
        `@group(2) @binding(0) var<storage, read> DemHeight_page_table: array<u32>;\n` +
        `@group(2) @binding(1) var DemHeight_atlas: texture_2d<f32>;\n\n` +
        `const DemHeight_level_count = ${model.addressSpace.levelCount}u;\n` +
        `const DemHeight_transition_texels = 16.0f;\n` +
        `const DemHeight_matrix = array<u32, ${model.addressSpace.levelCount}>(${matrixIds});\n` +
        `const DemHeight_minimum_texel = array<vec2u, ${model.addressSpace.levelCount}>(${minimums.join(', ')});\n` +
        `const DemHeight_maximum_texel = array<vec2u, ${model.addressSpace.levelCount}>(${maximums.join(', ')});\n` +
        `const DemCanonicalMinimum = ${positionLiteral(canonicalMinimum)};\n` +
        `const DemCanonicalMaximum = ${positionLiteral(canonicalMaximum)};\n` +
        `const DemElevationRange = vec2f(${Math.fround(model.manifest.offset)}f, ` +
        `${Math.fround(model.manifest.offset + model.manifest.scale * 255)}f);\n\n` +
        demCanonicalWgsl(codec.coordinateBits) + '\n' +
        `fn DemHeight_missing(level: u32) -> DemHeightSample {\n` +
        `    return DemHeightSample(vec4f(0.0), 0u, level, level);\n}\n\n` +
        `fn DemHeight_failed(level: u32) -> DemHeightSample {\n` +
        `    return DemHeightSample(vec4f(0.0), 4u, level, level);\n}\n\n` +
        `fn DemHeight_mercator_position(value: DemAddressFixedPosition) -> DemAddressFixedPosition {\n` +
        `    let south = DemCanonical_axis_fraction(value.axes[1]);\n` +
        `    let latitude = (0.5f - south) * 3.141592653589793f;\n` +
        `    let sine = sin(latitude);\n` +
        `    let world_y = clamp(0.5f - log((1.0f + sine) / (1.0f - sine)) / (4.0f * 3.141592653589793f), 0.0f, 0.99999994f);\n` +
        `    return DemAddressFixedPosition(array<DemAddressFixedAxis, 2>(\n` +
        `        value.axes[0], DemCanonical_axis_from_fraction(world_y)\n` +
        `    ));\n}\n\n` +
        `fn DemHeight_resolution_global(input_texel: vec2i, level: u32) -> vec2u {\n` +
        `    let texel = vec2u(clamp(input_texel, vec2i(DemHeight_minimum_texel[level]), vec2i(DemHeight_maximum_texel[level])));\n` +
        `    let matrix = DemHeight_matrix[level];\n` +
        `    let tile = texel >> vec2u(8u);\n` +
        `    let table_index = DemAddress_compact_index(matrix, tile);\n` +
        `    if (table_index == DemAddress_not_covered) { return vec2u(0u, level); }\n` +
        `    let base = table_index * 8u;\n` +
        `    let status = DemHeight_page_table[base + 3u];\n` +
        `    return vec2u(status, select(level, DemHeight_page_table[base + 2u], status != 0u));\n` +
        `}\n\n` +
        `fn DemHeight_load_global(input_texel: vec2i, level: u32) -> DemHeightSample {\n` +
        `    let texel = vec2u(clamp(input_texel, vec2i(DemHeight_minimum_texel[level]), vec2i(DemHeight_maximum_texel[level])));\n` +
        `    let matrix = DemHeight_matrix[level];\n` +
        `    let tile = texel >> vec2u(8u);\n` +
        `    let table_index = DemAddress_compact_index(matrix, tile);\n` +
        `    if (table_index == DemAddress_not_covered) { return DemHeight_missing(level); }\n` +
        `    let base = table_index * 8u;\n` +
        `    let status = DemHeight_page_table[base + 3u];\n` +
        `    if (status == 0u) { return DemHeight_missing(level); }\n` +
        `    if (status == 4u) { return DemHeight_failed(level); }\n` +
        `    let resolved_level = DemHeight_page_table[base + 2u];\n` +
        `    let resolved_matrix = DemHeight_matrix[resolved_level];\n` +
        `    let resolved_texel = texel >> vec2u(matrix - resolved_matrix);\n` +
        `    let local_texel = resolved_texel & vec2u(255u);\n` +
        `    let slot = vec2u(DemHeight_page_table[base], DemHeight_page_table[base + 1u]);\n` +
        `    let raw = textureLoad(DemHeight_atlas, vec2i(slot * vec2u(256u) + local_texel), 0);\n` +
        `    let decoded = raw * ${rawScale}.0f * vec4f(${Math.fround(model.manifest.scale)}f) + vec4f(${Math.fround(model.manifest.offset)}f);\n` +
        `    return DemHeightSample(decoded, status, level, resolved_level);\n}\n\n` +
        `fn DemHeight_load_position(position: DemAddressFixedPosition, level: u32) -> DemHeightSample {\n` +
        `    let address = DemAddress_address(DemHeight_mercator_position(position), DemHeight_matrix[level]);\n` +
        `    let texel = address.tile * vec2u(256u) + address.texel;\n` +
        `    return DemHeight_load_global(vec2i(texel), level);\n}\n\n` +
        `fn DemHeight_sample_level_mercator(mercator_position: DemAddressFixedPosition, level: u32) -> DemHeightSample {\n` +
        `    var sample_level = level;\n` +
        `    var address = DemAddress_address(mercator_position, DemHeight_matrix[sample_level]);\n` +
        `    for (var iteration = 0u; iteration < DemHeight_level_count; iteration++) {\n` +
        `        let base = vec2i(address.tile * vec2u(256u) + address.texel);\n` +
        `        let tl_resolution = DemHeight_resolution_global(base, sample_level);\n` +
        `        let tr_resolution = DemHeight_resolution_global(base + vec2i(1, 0), sample_level);\n` +
        `        let bl_resolution = DemHeight_resolution_global(base + vec2i(0, 1), sample_level);\n` +
        `        let br_resolution = DemHeight_resolution_global(base + vec2i(1, 1), sample_level);\n` +
        `        if (tl_resolution.x == 4u || tr_resolution.x == 4u || bl_resolution.x == 4u || br_resolution.x == 4u) { return DemHeight_failed(level); }\n` +
        `        if (tl_resolution.x == 0u || tr_resolution.x == 0u || bl_resolution.x == 0u || br_resolution.x == 0u) { return DemHeight_missing(level); }\n` +
        `        let resolved_level = max(max(tl_resolution.y, tr_resolution.y), max(bl_resolution.y, br_resolution.y));\n` +
        `        if (resolved_level == sample_level) { break; }\n` +
        `        sample_level = resolved_level;\n` +
        `        address = DemAddress_address(mercator_position, DemHeight_matrix[sample_level]);\n` +
        `    }\n` +
        `    let base = vec2i(address.tile * vec2u(256u) + address.texel);\n` +
        `    let tl = DemHeight_load_global(base, sample_level);\n` +
        `    let tr = DemHeight_load_global(base + vec2i(1, 0), sample_level);\n` +
        `    let bl = DemHeight_load_global(base + vec2i(0, 1), sample_level);\n` +
        `    let br = DemHeight_load_global(base + vec2i(1, 1), sample_level);\n` +
        `    if (tl.status == 4u || tr.status == 4u || bl.status == 4u || br.status == 4u) { return DemHeight_failed(level); }\n` +
        `    if (tl.status == 0u || tr.status == 0u || bl.status == 0u || br.status == 0u) { return DemHeight_missing(level); }\n` +
        `    if (tl.status == 3u || tr.status == 3u || bl.status == 3u || br.status == 3u) {\n` +
        `        return DemHeightSample(vec4f(0.0), 3u, level, sample_level);\n` +
        `    }\n` +
        `    let value = mix(mix(tl.value, tr.value, address.sub_texel.x), mix(bl.value, br.value, address.sub_texel.x), address.sub_texel.y);\n` +
        `    return DemHeightSample(value, max(max(tl.status, tr.status), max(bl.status, br.status)), level, sample_level);\n` +
        `}\n\n` +
        `fn DemHeight_sample_level(position: DemAddressFixedPosition, level: u32) -> DemHeightSample {\n` +
        `    return DemHeight_sample_level_mercator(DemHeight_mercator_position(position), level);\n` +
        `}\n\n` +
        `fn DemHeight_edge_blend_weight_mercator(mercator_position: DemAddressFixedPosition, level: u32) -> f32 {\n` +
        `    let address = DemAddress_address(mercator_position, DemHeight_matrix[level]);\n` +
        `    let local = vec2f(address.texel) + address.sub_texel;\n` +
        `    let origin = vec2i(address.tile * vec2u(256u));\n` +
        `    var weight = 1.0f;\n` +
        `    if (local.x < DemHeight_transition_texels) {\n` +
        `        let neighbor = DemHeight_resolution_global(origin + vec2i(-1, i32(address.texel.y)), level);\n` +
        `        if (neighbor.x != 0u && neighbor.y > level) { weight = min(weight, smoothstep(0.0f, DemHeight_transition_texels, local.x)); }\n` +
        `    }\n` +
        `    if (256.0f - local.x < DemHeight_transition_texels) {\n` +
        `        let neighbor = DemHeight_resolution_global(origin + vec2i(256, i32(address.texel.y)), level);\n` +
        `        if (neighbor.x != 0u && neighbor.y > level) { weight = min(weight, smoothstep(0.0f, DemHeight_transition_texels, 256.0f - local.x)); }\n` +
        `    }\n` +
        `    if (local.y < DemHeight_transition_texels) {\n` +
        `        let neighbor = DemHeight_resolution_global(origin + vec2i(i32(address.texel.x), -1), level);\n` +
        `        if (neighbor.x != 0u && neighbor.y > level) { weight = min(weight, smoothstep(0.0f, DemHeight_transition_texels, local.y)); }\n` +
        `    }\n` +
        `    if (256.0f - local.y < DemHeight_transition_texels) {\n` +
        `        let neighbor = DemHeight_resolution_global(origin + vec2i(i32(address.texel.x), 256), level);\n` +
        `        if (neighbor.x != 0u && neighbor.y > level) { weight = min(weight, smoothstep(0.0f, DemHeight_transition_texels, 256.0f - local.y)); }\n` +
        `    }\n` +
        `    return weight;\n` +
        `}\n\n` +
        `fn DemHeight_edge_blend_weight(position: DemAddressFixedPosition, level: u32) -> f32 {\n` +
        `    return DemHeight_edge_blend_weight_mercator(DemHeight_mercator_position(position), level);\n` +
        `}\n\n` +
        `fn DemHeight_sample_bilinear_mercator(position: DemAddressFixedPosition, level: u32) -> DemHeightSample {\n` +
        `    let fine = DemHeight_sample_level_mercator(position, level);\n` +
        `    if (fine.status == 0u || fine.status == 3u || fine.status == 4u || fine.resolved_level != level || level + 1u >= DemHeight_level_count) { return fine; }\n` +
        `    let weight = DemHeight_edge_blend_weight_mercator(position, level);\n` +
        `    if (weight >= 1.0f) { return fine; }\n` +
        `    let parent = DemHeight_sample_level_mercator(position, level + 1u);\n` +
        `    if (parent.status == 0u || parent.status == 3u || parent.status == 4u) { return fine; }\n` +
        `    return DemHeightSample(mix(parent.value, fine.value, weight), max(parent.status, fine.status), level, max(parent.resolved_level, fine.resolved_level));\n` +
        `}\n\n` +
        `fn DemHeight_sample_bilinear(position: DemAddressFixedPosition, level: u32) -> DemHeightSample { return DemHeight_sample_bilinear_mercator(DemHeight_mercator_position(position), level); }\n` +
        `fn DemHeight_sample_vertex_mercator(position: DemAddressFixedPosition, level: u32) -> DemHeightSample { return DemHeight_sample_bilinear_mercator(position, level); }\n` +
        `fn DemHeight_sample_vertex(position: DemAddressFixedPosition, level: u32) -> DemHeightSample { return DemHeight_sample_bilinear(position, level); }\n` +
        `fn DemHeight_sample_fragment(position: DemAddressFixedPosition, level: u32) -> DemHeightSample { return DemHeight_sample_bilinear(position, level); }\n` +
        `fn DemHeight_sample_compute(position: DemAddressFixedPosition, level: u32) -> DemHeightSample { return DemHeight_sample_bilinear(position, level); }\n`
}

function demCanonicalWgsl(coordinateBits: number): string {

    const highBits = coordinateBits - 32
    return `fn DemCanonical_compare_axis(a: DemAddressFixedAxis, b: DemAddressFixedAxis) -> i32 {\n` +
        `    if (a.high < b.high || (a.high == b.high && a.low < b.low)) { return -1; }\n` +
        `    if (a.high == b.high && a.low == b.low) { return 0; }\n` +
        `    return 1;\n}\n\n` +
        `fn DemCanonical_shift_right_6(value: DemAddressFixedAxis) -> DemAddressFixedAxis {\n` +
        `    return DemAddressFixedAxis((value.low >> 6u) | (value.high << 26u), value.high >> 6u);\n}\n\n` +
        `fn DemCanonical_multiply_small(value: DemAddressFixedAxis, factor: u32) -> DemAddressFixedAxis {\n` +
        `    let low_low = value.low & 0xffffu;\n` +
        `    let low_high = value.low >> 16u;\n` +
        `    let first = low_low * factor;\n` +
        `    let second = low_high * factor;\n` +
        `    let shifted = second << 16u;\n` +
        `    let low = first + shifted;\n` +
        `    let carry = select(0u, 1u, low < first);\n` +
        `    return DemAddressFixedAxis(low, value.high * factor + (second >> 16u) + carry);\n}\n\n` +
        `fn DemCanonical_interpolation_delta(value: DemAddressFixedAxis, index: u32) -> DemAddressFixedAxis {\n` +
        `    let quotient = DemCanonical_shift_right_6(value);\n` +
        `    let product = DemCanonical_multiply_small(quotient, index);\n` +
        `    let extra = ((value.low & 63u) * index) >> 6u;\n` +
        `    return DemAddressFixed_add_axis(product, DemAddressFixedAxis(extra, 0u));\n}\n\n` +
        `fn DemCanonical_interpolate(minimum: DemAddressFixedPosition, maximum: DemAddressFixedPosition, grid: vec2u) -> DemAddressFixedPosition {\n` +
        `    var result = minimum;\n` +
        `    let east_delta = DemAddressFixed_subtract_axis(maximum.axes[0], minimum.axes[0]);\n` +
        `    let north_delta = DemAddressFixed_subtract_axis(minimum.axes[1], maximum.axes[1]);\n` +
        `    result.axes[0] = DemAddressFixed_add_axis(minimum.axes[0], DemCanonical_interpolation_delta(east_delta, grid.x));\n` +
        `    result.axes[1] = DemAddressFixed_subtract_axis(minimum.axes[1], DemCanonical_interpolation_delta(north_delta, grid.y));\n` +
        `    return result;\n}\n\n` +
        `fn DemCanonical_axis_fraction(value: DemAddressFixedAxis) -> f32 {\n` +
        `    return ldexp(f32(value.high), -${highBits}) + ldexp(f32(value.low), -${coordinateBits});\n}\n\n` +
        `fn DemCanonical_axis_from_fraction(input: f32) -> DemAddressFixedAxis {\n` +
        `    let value = clamp(input, 0.0f, 0.99999994f);\n` +
        `    let high_scaled = value * ${2 ** highBits}.0f;\n` +
        `    let high = u32(floor(high_scaled));\n` +
        `    let low_scaled = fract(high_scaled) * 65536.0f;\n` +
        `    let upper = u32(floor(low_scaled));\n` +
        `    let lower = u32(floor(fract(low_scaled) * 65536.0f));\n` +
        `    return DemAddressFixedAxis((upper << 16u) | lower, high);\n}\n\n` +
        `fn DemCanonical_axis_difference(a: DemAddressFixedAxis, b: DemAddressFixedAxis) -> f32 {\n` +
        `    let order = DemCanonical_compare_axis(a, b);\n` +
        `    var magnitude: DemAddressFixedAxis;\n` +
        `    if (order >= 0) {\n` +
        `        magnitude = DemAddressFixed_subtract_axis(a, b);\n` +
        `    } else {\n` +
        `        magnitude = DemAddressFixed_subtract_axis(b, a);\n` +
        `    }\n` +
        `    let value = ldexp(f32(magnitude.high), 32 - ${coordinateBits}) + ldexp(f32(magnitude.low), -${coordinateBits});\n` +
        `    return select(-value, value, order >= 0);\n}\n\n` +
        `fn DemCanonical_difference_degrees(value: DemAddressFixedPosition, origin: DemAddressFixedPosition) -> vec2f {\n` +
        `    return vec2f(\n` +
        `        DemCanonical_axis_difference(value.axes[0], origin.axes[0]) * 360.0f,\n` +
        `        -DemCanonical_axis_difference(value.axes[1], origin.axes[1]) * 180.0f\n` +
        `    );\n}\n\n` +
        `fn DemCanonical_inside(value: DemAddressFixedPosition) -> bool {\n` +
        `    return DemCanonical_compare_axis(value.axes[0], DemCanonicalMinimum.axes[0]) >= 0 &&\n` +
        `        DemCanonical_compare_axis(value.axes[0], DemCanonicalMaximum.axes[0]) <= 0 &&\n` +
        `        DemCanonical_compare_axis(value.axes[1], DemCanonicalMinimum.axes[1]) <= 0 &&\n` +
        `        DemCanonical_compare_axis(value.axes[1], DemCanonicalMaximum.axes[1]) >= 0;\n}\n\n` +
        `fn DemCanonical_uv(value: DemAddressFixedPosition) -> vec2f {\n` +
        `    let x = DemCanonical_axis_difference(value.axes[0], DemCanonicalMinimum.axes[0]) / DemCanonical_axis_difference(DemCanonicalMaximum.axes[0], DemCanonicalMinimum.axes[0]);\n` +
        `    let y = DemCanonical_axis_difference(DemCanonicalMinimum.axes[1], value.axes[1]) / DemCanonical_axis_difference(DemCanonicalMinimum.axes[1], DemCanonicalMaximum.axes[1]);\n` +
        `    return vec2f(x, y);\n}\n`
}

function canonicalPosition(
    codec: WebMercatorQuadAddressCodec,
    coordinate: readonly [number, number]
): WideFixedPosition {

    return codec.positionCodec.fromQuanta(canonicalEndpointQuanta(codec, coordinate))
}

function canonicalEndpointQuanta(
    codec: WebMercatorQuadAddressCodec,
    coordinate: readonly [number, number]
): readonly [bigint, bigint] {

    const longitude = ((coordinate[0] + 180) % 360 + 360) % 360
    const latitude = clamp(coordinate[1], -90, 90)
    return Object.freeze([
        BigInt(Math.round(longitude / 360 * Number(codec.worldQuanta))),
        BigInt(Math.min(
            Number(codec.worldQuanta - 1n),
            Math.round((90 - latitude) / 180 * Number(codec.worldQuanta))
        )),
    ])
}

function globalTexel(
    address: ReturnType<WebMercatorQuadAddressCodec['address']>,
    axis: 0 | 1
): number {

    const tileCoordinate = axis === 0 ? address.tile.tileCol : address.tile.tileRow
    return tileCoordinate * DEM_TILE_SIZE + address.texel[axis]
}

function coveredTexel(
    address: ReturnType<WebMercatorQuadAddressCodec['address']>,
    axis: 0 | 1,
    edge: 'minimum' | 'maximum'
): number {

    const pixelCoordinate = globalTexel(address, axis) + address.subTexel[axis]
    return edge === 'minimum'
        ? Math.ceil(pixelCoordinate - 0.5)
        : Math.floor(pixelCoordinate - 0.5)
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

function clamp(value: number, minimum: number, maximum: number): number {

    return Math.min(maximum, Math.max(minimum, value))
}

function deepFreeze<T>(value: T): T {

    if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
    for (const child of Object.values(value)) deepFreeze(child)
    return Object.freeze(value) as T
}
