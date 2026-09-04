import {
    WebMercatorQuad,
    tileMatrixCoverage,
} from 'geoscratch/geo'
import type {
    TileCoordinateDescriptor,
    TileMatrixCoverage,
    TileMatrixLimits,
} from 'geoscratch/geo'

export type FlowFieldSourceAuthority = Readonly<{
    unit: 'authoritative' | 'unconfirmed'
    basis: 'authoritative' | 'unconfirmed'
    time: 'authoritative' | 'unconfirmed'
    phase: 'authoritative' | 'unconfirmed'
    topology: 'authoritative' | 'inferred'
}>

export type FlowFieldRuntimeSample = Readonly<{
    sampleKey: string
    timeIndex: number
    modelTime: number
    unit: string
    phase: string
    sourceHash: string
}>

export type FlowFieldSampleAdjacency =
    | Readonly<{
        lowerSampleKey: string
        upperSampleKey: string
        kind: 'interpolable'
        interpolation: 'component-wise-linear'
    }>
    | Readonly<{
        lowerSampleKey: string
        upperSampleKey: string
        kind: 'gap'
        interpolation: 'none'
        reason: 'omitted-source-samples'
    }>

export type FlowFieldRuntimePage = Readonly<{
    sampleKey: string
    timeIndex: number
    matrixId: string
    tileRow: number
    tileCol: number
    path: string
    url: string
    byteLength: 524288
    sha256: string
    maximumSpeed: number
}>

export type FlowFieldRuntimeRepresentation = Readonly<{
    mediaType: 'application/vnd.geoscratch.flow-rg32f'
    fieldKind: 'vector'
    channels: 2
    componentOrder: readonly ['u', 'v']
    sampleType: 'float32-le'
    layout: 'rg-interleaved'
    sampleRegistration: 'pixel-center'
    spatialInterpolation: 'bilinear'
    tileWidth: 256
    tileHeight: 256
    unsupportedVelocity: readonly [0, 0]
    missingPageSemantics: 'unavailable'
}>

export type FlowFieldRuntimeQuality = Readonly<{
    particleSimulation: string
    approvalReason: string
    [key: string]: JsonValue
}>

export type FlowFieldDataset = Readonly<{
    kind: 'flow-field-dataset'
    schemaVersion: 2
    artifactType: 'flow-field-cog-runtime'
    manifestUrl: string
    datasetId: string
    sourceRevision: string
    sourceHash: string
    contentVersion: string
    unit: string
    basis: string
    coverage: 'full' | 'subset'
    source: Readonly<{
        stationCount: number
        crs: 'EPSG:4326'
        geographicBounds: readonly [number, number, number, number]
    }>
    projectedBounds: Readonly<{
        crs: string
        bounds: readonly [number, number, number, number]
    }>
    authority: FlowFieldSourceAuthority
    quality: FlowFieldRuntimeQuality
    timeAxis: Readonly<{
        unit: string
        phase: string
        sourceSampleCount: number
        samples: readonly FlowFieldRuntimeSample[]
        adjacency: readonly FlowFieldSampleAdjacency[]
    }>
    tileMatrixSet: Readonly<{
        id: 'WebMercatorQuad'
        uri: string
        crs: string
        cornerOfOrigin: 'topLeft'
        tileRowDirection: 'south'
        tileColDirection: 'east'
        tileWidth: 256
        tileHeight: 256
        minTileMatrix: string
        maxTileMatrix: string
        tileMatrixIds: readonly string[]
        limits: readonly TileMatrixLimits[]
        coverage: TileMatrixCoverage
    }>
    sourceCeiling: Readonly<{
        tileMatrixSetId: 'WebMercatorQuad'
        matrixId: string
        matrixLevel: number
        selectionRelation: 'statistically-selected' | 'explicitly-requested'
    }>
    representation: FlowFieldRuntimeRepresentation
    budgets: Readonly<{
        spatialPageCount: number
        timePageCount: number
        pageByteLength: 524288
        totalRawPageBytes: number
    }>
    construction: Readonly<{
        algorithmVersion: 'flow-cog-wmq-rg32f-v2'
        adapterVersion: 'flow-cog-wmq-rg32f-v2'
        collectionContentVersion: string
        pageSetSha256: string
        levelConstruction: 'cog-physical-or-global-semantic-recursive'
        supportFilter: 'recursive-conservative-vector-box-v1'
        publicationPolicy: Readonly<{
            kind: 'bounded-source-ceiling'
            minimumMatrixId: '4'
            maximumMatrixCap: '10'
            resolvedMaximumMatrixId: string
        }>
    }>
    maximumSpeed: number
    timeMaximumSpeeds: readonly Readonly<{
        sampleKey: string
        timeIndex: number
        pageMaximumSpeed: number
    }>[]
    pages: readonly FlowFieldRuntimePage[]
    sample(sampleKey: string): FlowFieldRuntimeSample
    page(sampleKey: string, tile: TileCoordinateDescriptor): FlowFieldRuntimePage
}>

export type LoadFlowFieldDatasetOptions = Readonly<{
    signal?: AbortSignal
}>

type JsonPrimitive = string | number | boolean | null
type JsonValue = JsonPrimitive | readonly JsonValue[] | Readonly<{ [key: string]: JsonValue }>

type RuntimeManifest = Readonly<{
    schemaVersion?: unknown
    artifactType?: unknown
    datasetId?: unknown
    sourceRevision?: unknown
    sourceHash?: unknown
    contentVersion?: unknown
    unit?: unknown
    basis?: unknown
    stationCount?: unknown
    source?: unknown
    projectedBounds?: unknown
    times?: unknown
    temporal?: unknown
    tileMatrixSet?: unknown
    sourceCeiling?: unknown
    representation?: unknown
    authority?: unknown
    quality?: unknown
    maximumSpeed?: unknown
    timeMaximumSpeeds?: unknown
    pages?: unknown
    budgets?: unknown
    construction?: unknown
}>

type RuntimePageInput = Readonly<{
    sampleKey?: unknown
    timeIndex?: unknown
    matrixId?: unknown
    tileRow?: unknown
    tileCol?: unknown
    path?: unknown
    byteLength?: unknown
    sha256?: unknown
    maximumSpeed?: unknown
}>

const FLOW_FIELD_RUNTIME_ARTIFACT = 'flow-field-cog-runtime'
const FLOW_FIELD_RUNTIME_MEDIA_TYPE = 'application/vnd.geoscratch.flow-rg32f'
const FLOW_FIELD_RUNTIME_ADAPTER = 'flow-cog-wmq-rg32f-v2'
const WEB_MERCATOR_QUAD_URI =
    'http://www.opengis.net/def/tilematrixset/OGC/1.0/WebMercatorQuad'
const WEB_MERCATOR_QUAD_CRS = 'http://www.opengis.net/def/crs/EPSG/0/3857'
const RUNTIME_PAGE_BYTE_LENGTH = 256 * 256 * 2 * Float32Array.BYTES_PER_ELEMENT
const RUNTIME_MINIMUM_MATRIX = 4
const RUNTIME_MAXIMUM_MATRIX_CAP = 10
const RUNTIME_LEVEL_CONSTRUCTION = 'cog-physical-or-global-semantic-recursive'
const RUNTIME_SUPPORT_FILTER = 'recursive-conservative-vector-box-v1'
const RUNTIME_MANIFEST_KEYS = Object.freeze([
    'schemaVersion',
    'artifactType',
    'datasetId',
    'sourceRevision',
    'sourceHash',
    'contentVersion',
    'stationCount',
    'source',
    'projectedBounds',
    'authority',
    'times',
    'temporal',
    'sourceCeiling',
    'tileMatrixSet',
    'representation',
    'unit',
    'basis',
    'maximumSpeed',
    'timeMaximumSpeeds',
    'pages',
    'budgets',
    'quality',
    'construction',
])

/** Loads and normalizes one immutable COG-backed Flow Field runtime dataset. */
export async function loadFlowFieldDataset(
    url: string | URL,
    options: LoadFlowFieldDatasetOptions = {}
): Promise<FlowFieldDataset> {

    const manifestUrl = runtimeManifestUrl(url)
    const response = await fetch(manifestUrl, {
        cache: 'no-cache',
        ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    if (!response.ok) {
        throw new Error(`Flow Field runtime manifest request failed with HTTP ${response.status}`)
    }
    const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim()
    if (contentType !== 'application/json') {
        throw new TypeError('Flow Field runtime manifest must use application/json')
    }
    return normalizeFlowFieldDataset(await response.json(), manifestUrl)
}

async function normalizeFlowFieldDataset(
    value: unknown,
    manifestUrl: URL
): Promise<FlowFieldDataset> {

    const manifest = value as RuntimeManifest | null
    if (manifest === null || typeof manifest !== 'object' ||
        !sameObjectKeys(manifest, RUNTIME_MANIFEST_KEYS) ||
        manifest.schemaVersion !== 2 || manifest.artifactType !== FLOW_FIELD_RUNTIME_ARTIFACT ||
        !nonemptyString(manifest.datasetId) || !nonemptyString(manifest.sourceRevision) ||
        !sha256(manifest.sourceHash) || !nonemptyString(manifest.contentVersion) ||
        !nonemptyString(manifest.unit) || !nonemptyString(manifest.basis) ||
        !positiveInteger(manifest.stationCount)) {
        throw invalidRuntimeManifest()
    }
    const source = normalizeRuntimeSource(manifest.source, manifest.stationCount)
    const projectedBounds = normalizeRuntimeProjectedBounds(
        manifest.projectedBounds,
        source.geographicBounds
    )
    const authority = normalizeRuntimeAuthority(manifest.authority)
    const samples = normalizeRuntimeSamples(manifest.times)
    const temporal = normalizeRuntimeTemporal(manifest.temporal, samples)
    const matrixSet = normalizeRuntimeMatrixSet(manifest.tileMatrixSet, source.geographicBounds)
    const sourceCeiling = normalizeRuntimeSourceCeiling(
        manifest.sourceCeiling,
        matrixSet.tileMatrixIds
    )
    const representation = normalizeRuntimeRepresentation(manifest.representation)
    const pages = normalizeRuntimePages(
        manifest.pages,
        manifestUrl,
        samples,
        matrixSet.coverage,
        representation
    )
    const timeMaximumSpeeds = normalizeRuntimeTimeMaximumSpeeds(
        manifest.timeMaximumSpeeds,
        samples,
        pages
    )
    const maximumSpeed = requireNonnegativeNumber(manifest.maximumSpeed)
    if (maximumSpeed !== Math.max(
        ...timeMaximumSpeeds.map(record => record.pageMaximumSpeed)
    )) {
        throw invalidRuntimeManifest()
    }
    const budgets = normalizeRuntimeBudgets(
        manifest.budgets,
        matrixSet.coverage.entryCount,
        pages.length
    )
    const construction = await normalizeRuntimeConstruction(
        manifest.construction,
        manifest.contentVersion,
        matrixSet.maxTileMatrix,
        pages
    )
    const quality = normalizeRuntimeQuality(manifest.quality)
    const samplesByKey = new Map(samples.map(sample => [ sample.sampleKey, sample ]))
    const pagesByKey = new Map(pages.map(page => [ runtimePageKey(
        page.sampleKey,
        page.matrixId,
        page.tileRow,
        page.tileCol
    ), page ]))

    return Object.freeze({
        kind: 'flow-field-dataset' as const,
        schemaVersion: 2 as const,
        artifactType: FLOW_FIELD_RUNTIME_ARTIFACT,
        manifestUrl: manifestUrl.href,
        datasetId: manifest.datasetId,
        sourceRevision: manifest.sourceRevision,
        sourceHash: manifest.sourceHash,
        contentVersion: manifest.contentVersion,
        unit: manifest.unit,
        basis: manifest.basis,
        coverage: temporal.coverage,
        source,
        projectedBounds,
        authority,
        quality,
        timeAxis: Object.freeze({
            unit: samples[0]!.unit,
            phase: samples[0]!.phase,
            sourceSampleCount: temporal.sourceSampleCount,
            samples,
            adjacency: temporal.sampleAdjacency,
        }),
        tileMatrixSet: matrixSet,
        sourceCeiling,
        representation,
        budgets,
        construction,
        maximumSpeed,
        timeMaximumSpeeds,
        pages,
        sample(sampleKey: string) {

            const sample = samplesByKey.get(sampleKey)
            if (sample === undefined) {
                throw new RangeError(`Flow Field sample ${sampleKey} is not declared`)
            }
            return sample
        },
        page(sampleKey: string, tile: TileCoordinateDescriptor) {

            if (tile === null || typeof tile !== 'object' ||
                typeof tile.matrixId !== 'string' || !nonnegativeInteger(tile.tileRow) ||
                !nonnegativeInteger(tile.tileCol)) {
                throw new TypeError('Flow Field page lookup requires a tile coordinate')
            }
            const page = pagesByKey.get(runtimePageKey(
                sampleKey,
                tile.matrixId,
                tile.tileRow,
                tile.tileCol
            ))
            if (page === undefined) {
                throw new RangeError('Flow Field page is outside the declared runtime dataset')
            }
            return page
        },
    })
}

function normalizeRuntimeSource(
    value: unknown,
    stationCount: number
): FlowFieldDataset['source'] {

    const source = value as Readonly<{
        crs?: unknown
        geographicBounds?: unknown
    }> | null
    if (source === null || typeof source !== 'object' || source.crs !== 'EPSG:4326' ||
        !geographicBounds(source.geographicBounds)) {
        throw invalidRuntimeManifest()
    }
    return Object.freeze({
        stationCount,
        crs: 'EPSG:4326' as const,
        geographicBounds: Object.freeze([ ...source.geographicBounds ]) as
            readonly [number, number, number, number],
    })
}

function normalizeRuntimeProjectedBounds(
    value: unknown,
    geographic: readonly [number, number, number, number]
): FlowFieldDataset['projectedBounds'] {

    const projected = value as Readonly<{
        crs?: unknown
        bounds?: unknown
    }> | null
    if (projected === null || typeof projected !== 'object' ||
        projected.crs !== WEB_MERCATOR_QUAD_CRS ||
        !finiteTuple(projected.bounds, 4)) {
        throw invalidRuntimeManifest()
    }
    const [ west, south, east, north ] = geographic
    const [ projectedWest, projectedSouth ] = projectRuntimeLonLat(west, south)
    const [ projectedEast, projectedNorth ] = projectRuntimeLonLat(east, north)
    const expected = [
        projectedWest,
        projectedSouth,
        projectedEast,
        projectedNorth,
    ]
    if (!projected.bounds.every((coordinate, index) =>
        approximatelyEqual(coordinate, expected[index]!)
    )) {
        throw invalidRuntimeManifest()
    }
    return Object.freeze({
        crs: WEB_MERCATOR_QUAD_CRS,
        bounds: Object.freeze([ ...projected.bounds ]) as
            readonly [number, number, number, number],
    })
}

function normalizeRuntimeAuthority(value: unknown): FlowFieldSourceAuthority {

    const authority = value as Partial<FlowFieldSourceAuthority> | null
    if (authority === null || typeof authority !== 'object' ||
        (authority.unit !== 'authoritative' && authority.unit !== 'unconfirmed') ||
        (authority.basis !== 'authoritative' && authority.basis !== 'unconfirmed') ||
        (authority.time !== 'authoritative' && authority.time !== 'unconfirmed') ||
        (authority.phase !== 'authoritative' && authority.phase !== 'unconfirmed') ||
        (authority.topology !== 'authoritative' && authority.topology !== 'inferred')) {
        throw invalidRuntimeManifest()
    }
    return Object.freeze({
        unit: authority.unit,
        basis: authority.basis,
        time: authority.time,
        phase: authority.phase,
        topology: authority.topology,
    }) as FlowFieldSourceAuthority
}

function normalizeRuntimeSamples(value: unknown): readonly FlowFieldRuntimeSample[] {

    if (!Array.isArray(value) || value.length === 0) throw invalidRuntimeManifest()
    const samples: FlowFieldRuntimeSample[] = []
    const keys = new Set<string>()
    let previousTimeIndex = -1
    let previousModelTime = Number.NEGATIVE_INFINITY
    let unit: string | undefined
    let phase: string | undefined
    for (const input of value) {
        const sample = input as Partial<FlowFieldRuntimeSample> | null
        if (sample === null || typeof sample !== 'object' ||
            !nonnegativeInteger(sample.timeIndex) ||
            sample.sampleKey !== runtimeSampleKey(sample.timeIndex) ||
            keys.has(sample.sampleKey) || sample.timeIndex <= previousTimeIndex ||
            !finiteNumber(sample.modelTime) || sample.modelTime <= previousModelTime ||
            !nonemptyString(sample.unit) || !nonemptyString(sample.phase) ||
            !sha256(sample.sourceHash) ||
            (unit !== undefined && sample.unit !== unit) ||
            (phase !== undefined && sample.phase !== phase)) {
            throw invalidRuntimeManifest()
        }
        const normalized = Object.freeze({
            sampleKey: sample.sampleKey,
            timeIndex: sample.timeIndex,
            modelTime: sample.modelTime,
            unit: sample.unit,
            phase: sample.phase,
            sourceHash: sample.sourceHash,
        })
        samples.push(normalized)
        keys.add(normalized.sampleKey)
        previousTimeIndex = normalized.timeIndex
        previousModelTime = normalized.modelTime
        unit = normalized.unit
        phase = normalized.phase
    }
    return Object.freeze(samples)
}

function normalizeRuntimeTemporal(
    value: unknown,
    samples: readonly FlowFieldRuntimeSample[]
): Readonly<{
    coverage: 'full' | 'subset'
    sourceSampleCount: number
    sampleAdjacency: readonly FlowFieldSampleAdjacency[]
}> {

    const temporal = value as Readonly<{
        coverage?: unknown
        sourceSampleCount?: unknown
        sampleAdjacency?: unknown
    }> | null
    const sourceSampleCount = temporal?.sourceSampleCount
    if (temporal === null || typeof temporal !== 'object' ||
        (temporal.coverage !== 'full' && temporal.coverage !== 'subset') ||
        !positiveInteger(sourceSampleCount) ||
        sourceSampleCount < samples.length ||
        samples.some(sample => sample.timeIndex >= sourceSampleCount) ||
        (temporal.coverage === 'full' && sourceSampleCount !== samples.length) ||
        (temporal.coverage === 'full' && samples.some(
            (sample, index) => sample.timeIndex !== index
        )) ||
        (temporal.coverage === 'subset' && sourceSampleCount === samples.length) ||
        !Array.isArray(temporal.sampleAdjacency) ||
        temporal.sampleAdjacency.length !== samples.length - 1) {
        throw invalidRuntimeManifest()
    }
    const adjacency = temporal.sampleAdjacency.map((input, index) => {
        const record = input as Partial<FlowFieldSampleAdjacency> | null
        const lower = samples[index]!
        const upper = samples[index + 1]!
        const consecutive = upper.timeIndex === lower.timeIndex + 1
        const expectedKind = consecutive ? 'interpolable' : 'gap'
        const expectedInterpolation = consecutive ? 'component-wise-linear' : 'none'
        const expectedReason = consecutive ? undefined : 'omitted-source-samples'
        if (record === null || typeof record !== 'object' ||
            record.lowerSampleKey !== lower.sampleKey ||
            record.upperSampleKey !== upper.sampleKey ||
            record.kind !== expectedKind ||
            record.interpolation !== expectedInterpolation ||
            ('reason' in record ? record.reason : undefined) !== expectedReason) {
            throw invalidRuntimeManifest()
        }
        return Object.freeze(consecutive
            ? {
                lowerSampleKey: record.lowerSampleKey,
                upperSampleKey: record.upperSampleKey,
                kind: 'interpolable' as const,
                interpolation: 'component-wise-linear' as const,
            }
            : {
                lowerSampleKey: record.lowerSampleKey,
                upperSampleKey: record.upperSampleKey,
                kind: 'gap' as const,
                interpolation: 'none' as const,
                reason: 'omitted-source-samples' as const,
            })
    })
    return Object.freeze({
        coverage: temporal.coverage,
        sourceSampleCount,
        sampleAdjacency: Object.freeze(adjacency),
    })
}

function normalizeRuntimeMatrixSet(
    value: unknown,
    bounds: readonly [number, number, number, number]
): FlowFieldDataset['tileMatrixSet'] {

    const matrixSet = value as Readonly<{
        id?: unknown
        uri?: unknown
        crs?: unknown
        cornerOfOrigin?: unknown
        tileRowDirection?: unknown
        tileColDirection?: unknown
        tileWidth?: unknown
        tileHeight?: unknown
        minTileMatrix?: unknown
        maxTileMatrix?: unknown
        tileMatrixIds?: unknown
        limits?: unknown
    }> | null
    if (matrixSet === null || typeof matrixSet !== 'object' ||
        matrixSet.id !== WebMercatorQuad.id || matrixSet.uri !== WEB_MERCATOR_QUAD_URI ||
        matrixSet.crs !== WEB_MERCATOR_QUAD_CRS || matrixSet.cornerOfOrigin !== 'topLeft' ||
        matrixSet.tileRowDirection !== 'south' || matrixSet.tileColDirection !== 'east' ||
        matrixSet.tileWidth !== 256 || matrixSet.tileHeight !== 256 ||
        !Array.isArray(matrixSet.tileMatrixIds) || matrixSet.tileMatrixIds.length === 0 ||
        !Array.isArray(matrixSet.limits) ||
        matrixSet.limits.length !== matrixSet.tileMatrixIds.length) {
        throw invalidRuntimeManifest()
    }
    const matrixIds = matrixSet.tileMatrixIds as unknown[]
    for (let index = 0; index < matrixIds.length; index++) {
        const matrixId = matrixIds[index]
        const level = numericMatrixId(matrixId)
        if (level === undefined || (index > 0 &&
            level !== numericMatrixId(matrixIds[index - 1])! + 1)) {
            throw invalidRuntimeManifest()
        }
    }
    if (matrixSet.minTileMatrix !== matrixIds[0] ||
        matrixSet.maxTileMatrix !== matrixIds.at(-1) ||
        numericMatrixId(matrixIds[0]) !== RUNTIME_MINIMUM_MATRIX ||
        numericMatrixId(matrixIds.at(-1))! > RUNTIME_MAXIMUM_MATRIX_CAP) {
        throw invalidRuntimeManifest()
    }
    const limits: TileMatrixLimits[] = matrixSet.limits.map((input, index) => {
        const limit = input as Partial<TileMatrixLimits> | null
        const matrixId = matrixIds[index] as string
        const matrix = WebMercatorQuad.matrix(matrixId)
        if (limit === null || typeof limit !== 'object' || limit.matrixId !== matrixId ||
            !nonnegativeInteger(limit.minTileRow) || !nonnegativeInteger(limit.maxTileRow) ||
            !nonnegativeInteger(limit.minTileCol) || !nonnegativeInteger(limit.maxTileCol) ||
            limit.minTileRow > limit.maxTileRow || limit.minTileCol > limit.maxTileCol ||
            limit.maxTileRow >= matrix.matrixHeight || limit.maxTileCol >= matrix.matrixWidth) {
            throw invalidRuntimeManifest()
        }
        return Object.freeze({
            matrixId,
            minTileRow: limit.minTileRow,
            maxTileRow: limit.maxTileRow,
            minTileCol: limit.minTileCol,
            maxTileCol: limit.maxTileCol,
        })
    })
    if (!sameLimits(limits, bounds)) throw invalidRuntimeManifest()
    let coverage: TileMatrixCoverage
    try {
        coverage = tileMatrixCoverage({ tileMatrixSet: WebMercatorQuad, limits })
    } catch {
        throw invalidRuntimeManifest()
    }
    return Object.freeze({
        id: 'WebMercatorQuad' as const,
        uri: WEB_MERCATOR_QUAD_URI,
        crs: matrixSet.crs,
        cornerOfOrigin: 'topLeft' as const,
        tileRowDirection: 'south' as const,
        tileColDirection: 'east' as const,
        tileWidth: 256 as const,
        tileHeight: 256 as const,
        minTileMatrix: matrixIds[0] as string,
        maxTileMatrix: matrixIds.at(-1) as string,
        tileMatrixIds: Object.freeze([ ...matrixIds ]) as readonly string[],
        limits: Object.freeze(limits),
        coverage,
    })
}

function normalizeRuntimeSourceCeiling(
    value: unknown,
    matrixIds: readonly string[]
): FlowFieldDataset['sourceCeiling'] {

    const ceiling = value as Readonly<{
        tileMatrixSetId?: unknown
        matrixId?: unknown
        selectionRelation?: unknown
    }> | null
    const matrixLevel = numericMatrixId(ceiling?.matrixId)
    const publishedMaximum = numericMatrixId(matrixIds.at(-1))
    if (ceiling === null || typeof ceiling !== 'object' ||
        ceiling.tileMatrixSetId !== WebMercatorQuad.id ||
        matrixLevel === undefined || publishedMaximum === undefined ||
        publishedMaximum !== Math.min(matrixLevel, RUNTIME_MAXIMUM_MATRIX_CAP) ||
        (ceiling.selectionRelation !== 'statistically-selected' &&
            ceiling.selectionRelation !== 'explicitly-requested')) {
        throw invalidRuntimeManifest()
    }
    const matrixId = ceiling.matrixId as string
    return Object.freeze({
        tileMatrixSetId: 'WebMercatorQuad' as const,
        matrixId,
        matrixLevel,
        selectionRelation: ceiling.selectionRelation,
    })
}

function normalizeRuntimeRepresentation(value: unknown): FlowFieldRuntimeRepresentation {

    const representation = value as Partial<FlowFieldRuntimeRepresentation> | null
    if (representation === null || typeof representation !== 'object' ||
        representation.mediaType !== FLOW_FIELD_RUNTIME_MEDIA_TYPE ||
        representation.fieldKind !== 'vector' ||
        representation.channels !== 2 ||
        !sameValues(representation.componentOrder, [ 'u', 'v' ]) ||
        representation.sampleType !== 'float32-le' ||
        representation.layout !== 'rg-interleaved' ||
        representation.sampleRegistration !== 'pixel-center' ||
        representation.spatialInterpolation !== 'bilinear' ||
        representation.tileWidth !== 256 || representation.tileHeight !== 256 ||
        !sameZeroVelocity(representation.unsupportedVelocity) ||
        representation.missingPageSemantics !== 'unavailable') {
        throw invalidRuntimeManifest()
    }
    return deepFreeze(structuredClone(representation)) as FlowFieldRuntimeRepresentation
}

function normalizeRuntimePages(
    value: unknown,
    manifestUrl: URL,
    samples: readonly FlowFieldRuntimeSample[],
    coverage: TileMatrixCoverage,
    representation: FlowFieldRuntimeRepresentation
): readonly FlowFieldRuntimePage[] {

    if (!Array.isArray(value) || value.length !== samples.length * coverage.entryCount) {
        throw invalidRuntimeManifest()
    }
    const pages: FlowFieldRuntimePage[] = []
    const paths = new Set<string>()
    for (let index = 0; index < value.length; index++) {
        const input = value[index] as RuntimePageInput | null
        const sample = samples[Math.floor(index / coverage.entryCount)]!
        const expected = coverage.coordinate(index % coverage.entryCount)
        const expectedPath = runtimePagePath(sample.sampleKey, expected)
        if (input === null || typeof input !== 'object' ||
            input.sampleKey !== sample.sampleKey || input.timeIndex !== sample.timeIndex ||
            input.matrixId !== expected.matrixId || input.tileRow !== expected.tileRow ||
            input.tileCol !== expected.tileCol || input.byteLength !== RUNTIME_PAGE_BYTE_LENGTH ||
            !sha256(input.sha256) || !nonnegativeNumber(input.maximumSpeed) ||
            input.path !== expectedPath || paths.has(input.path)) {
            throw invalidRuntimeManifest()
        }
        let resolved: URL
        try {
            resolved = new URL(input.path, manifestUrl)
        } catch {
            throw invalidRuntimeManifest()
        }
        if ((resolved.protocol !== 'http:' && resolved.protocol !== 'https:') ||
            resolved.username !== '' || resolved.password !== '') {
            throw invalidRuntimeManifest()
        }
        paths.add(input.path)
        pages.push(Object.freeze({
            sampleKey: input.sampleKey,
            timeIndex: input.timeIndex,
            matrixId: input.matrixId,
            tileRow: input.tileRow,
            tileCol: input.tileCol,
            path: input.path,
            url: resolved.href,
            byteLength: RUNTIME_PAGE_BYTE_LENGTH as 524288,
            sha256: input.sha256,
            maximumSpeed: input.maximumSpeed,
        }))
    }
    if (representation.tileWidth * representation.tileHeight *
        representation.channels * Float32Array.BYTES_PER_ELEMENT !== RUNTIME_PAGE_BYTE_LENGTH) {
        throw invalidRuntimeManifest()
    }
    return Object.freeze(pages)
}

function normalizeRuntimeTimeMaximumSpeeds(
    value: unknown,
    samples: readonly FlowFieldRuntimeSample[],
    pages: readonly FlowFieldRuntimePage[]
): FlowFieldDataset['timeMaximumSpeeds'] {

    if (!Array.isArray(value) || value.length !== samples.length) {
        throw invalidRuntimeManifest()
    }
    const records = value.map((input, index) => {
        const record = input as Readonly<{
            sampleKey?: unknown
            timeIndex?: unknown
            pageMaximumSpeed?: unknown
        }> | null
        const sample = samples[index]!
        const observed = pages
            .filter(page => page.sampleKey === sample.sampleKey)
            .reduce((maximum, page) => Math.max(maximum, page.maximumSpeed), 0)
        if (record === null || typeof record !== 'object' ||
            record.sampleKey !== sample.sampleKey || record.timeIndex !== sample.timeIndex ||
            record.pageMaximumSpeed !== observed) {
            throw invalidRuntimeManifest()
        }
        return Object.freeze({
            sampleKey: record.sampleKey,
            timeIndex: record.timeIndex,
            pageMaximumSpeed: observed,
        })
    })
    return Object.freeze(records)
}

function normalizeRuntimeBudgets(
    value: unknown,
    spatialPageCount: number,
    timePageCount: number
): FlowFieldDataset['budgets'] {

    const budgets = value as Readonly<{
        spatialPageCount?: unknown
        timePageCount?: unknown
        pageByteLength?: unknown
        totalRawPageBytes?: unknown
    }> | null
    const totalRawPageBytes = timePageCount * RUNTIME_PAGE_BYTE_LENGTH
    if (budgets === null || typeof budgets !== 'object' ||
        !sameObjectKeys(budgets, [
            'spatialPageCount',
            'timePageCount',
            'pageByteLength',
            'totalRawPageBytes',
        ]) ||
        budgets.spatialPageCount !== spatialPageCount ||
        budgets.timePageCount !== timePageCount ||
        budgets.pageByteLength !== RUNTIME_PAGE_BYTE_LENGTH ||
        budgets.totalRawPageBytes !== totalRawPageBytes ||
        !Number.isSafeInteger(totalRawPageBytes)) {
        throw invalidRuntimeManifest()
    }
    return Object.freeze({
        spatialPageCount,
        timePageCount,
        pageByteLength: RUNTIME_PAGE_BYTE_LENGTH as 524288,
        totalRawPageBytes,
    })
}

async function normalizeRuntimeConstruction(
    value: unknown,
    contentVersion: string,
    resolvedMaximumMatrixId: string,
    pages: readonly FlowFieldRuntimePage[]
): Promise<FlowFieldDataset['construction']> {

    const construction = value as Readonly<{
        algorithmVersion?: unknown
        adapterVersion?: unknown
        collectionContentVersion?: unknown
        pageSetSha256?: unknown
        levelConstruction?: unknown
        supportFilter?: unknown
        publicationPolicy?: unknown
    }> | null
    const policy = construction?.publicationPolicy as Readonly<{
        kind?: unknown
        minimumMatrixId?: unknown
        maximumMatrixCap?: unknown
        resolvedMaximumMatrixId?: unknown
    }> | null
    if (construction === null || typeof construction !== 'object' ||
        !sameObjectKeys(construction, [
            'algorithmVersion',
            'adapterVersion',
            'collectionContentVersion',
            'pageSetSha256',
            'levelConstruction',
            'supportFilter',
            'publicationPolicy',
        ]) ||
        construction.algorithmVersion !== FLOW_FIELD_RUNTIME_ADAPTER ||
        construction.adapterVersion !== FLOW_FIELD_RUNTIME_ADAPTER ||
        construction.collectionContentVersion !== contentVersion ||
        !sha256(construction.pageSetSha256) ||
        construction.levelConstruction !== RUNTIME_LEVEL_CONSTRUCTION ||
        construction.supportFilter !== RUNTIME_SUPPORT_FILTER ||
        policy === null || typeof policy !== 'object' ||
        !sameObjectKeys(policy, [
            'kind',
            'minimumMatrixId',
            'maximumMatrixCap',
            'resolvedMaximumMatrixId',
        ]) ||
        policy.kind !== 'bounded-source-ceiling' ||
        policy.minimumMatrixId !== String(RUNTIME_MINIMUM_MATRIX) ||
        policy.maximumMatrixCap !== String(RUNTIME_MAXIMUM_MATRIX_CAP) ||
        policy.resolvedMaximumMatrixId !== resolvedMaximumMatrixId ||
        construction.pageSetSha256 !== await runtimePageSetSha256(pages)) {
        throw invalidRuntimeManifest()
    }
    return Object.freeze({
        algorithmVersion: FLOW_FIELD_RUNTIME_ADAPTER,
        adapterVersion: FLOW_FIELD_RUNTIME_ADAPTER,
        collectionContentVersion: contentVersion,
        pageSetSha256: construction.pageSetSha256,
        levelConstruction: RUNTIME_LEVEL_CONSTRUCTION,
        supportFilter: RUNTIME_SUPPORT_FILTER,
        publicationPolicy: Object.freeze({
            kind: 'bounded-source-ceiling' as const,
            minimumMatrixId: '4' as const,
            maximumMatrixCap: '10' as const,
            resolvedMaximumMatrixId,
        }),
    })
}

function normalizeRuntimeQuality(value: unknown): FlowFieldRuntimeQuality {

    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw invalidRuntimeManifest()
    }
    let snapshot: unknown
    try {
        snapshot = structuredClone(value)
    } catch {
        throw invalidRuntimeManifest()
    }
    const quality = snapshot as Partial<FlowFieldRuntimeQuality>
    if (!nonemptyString(quality.particleSimulation) ||
        !nonemptyString(quality.approvalReason) || !finiteJson(quality)) {
        throw invalidRuntimeManifest()
    }
    return deepFreeze(quality) as FlowFieldRuntimeQuality
}

function runtimeManifestUrl(value: string | URL): URL {

    try {
        const url = new URL(String(value), globalThis.location?.href)
        if ((url.protocol !== 'http:' && url.protocol !== 'https:') ||
            url.username !== '' || url.password !== '') {
            throw new TypeError()
        }
        return url
    } catch {
        throw new TypeError('Flow Field runtime manifest URL must be an HTTP(S) URL')
    }
}

function runtimePagePath(
    sampleKey: string,
    tile: TileCoordinateDescriptor
): string {

    return `tiles/WebMercatorQuad/${sampleKey}/${tile.matrixId}/` +
        `${tile.tileRow}/${tile.tileCol}.rg32f`
}

function runtimePageKey(
    sampleKey: string,
    matrixId: string,
    tileRow: number,
    tileCol: number
): string {

    return `${sampleKey}/${matrixId}/${tileRow}/${tileCol}`
}

async function runtimePageSetSha256(
    pages: readonly FlowFieldRuntimePage[]
): Promise<string> {

    if (globalThis.crypto?.subtle === undefined) {
        throw new Error('Flow Field runtime manifest validation requires Web Crypto')
    }
    const records = pages.map(page => {
        const prefix = JSON.stringify([
            page.sampleKey,
            page.timeIndex,
            page.matrixId,
            page.tileRow,
            page.tileCol,
            page.path,
            page.byteLength,
            page.sha256,
        ]).slice(0, -1)
        return `${prefix},${pythonJsonFloat(page.maximumSpeed)}]\n`
    }).join('')
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(records)
    ))
    return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')
}

function pythonJsonFloat(value: number): string {

    if (value === 0) return Object.is(value, -0) ? '-0.0' : '0.0'
    const negative = value < 0
    const source = String(Math.abs(value))
    let digits: string
    let exponent: number
    const exponentMarker = source.indexOf('e')
    if (exponentMarker >= 0) {
        const coefficient = source.slice(0, exponentMarker)
        digits = coefficient.replace('.', '')
        exponent = Number(source.slice(exponentMarker + 1))
    } else {
        const [ integer, fraction = '' ] = source.split('.')
        if (integer !== '0') {
            digits = `${integer}${fraction}`
            exponent = integer.length - 1
        } else {
            const firstSignificant = fraction.search(/[1-9]/)
            digits = fraction.slice(firstSignificant)
            exponent = -firstSignificant - 1
        }
    }
    const sign = negative ? '-' : ''
    if (exponent < -4 || exponent >= 16) {
        digits = digits.replace(/0+$/, '')
        const coefficient = digits.length === 1
            ? digits
            : `${digits[0]}.${digits.slice(1)}`
        const exponentSign = exponent >= 0 ? '+' : '-'
        return `${sign}${coefficient}e${exponentSign}` +
            String(Math.abs(exponent)).padStart(2, '0')
    }
    const decimalPoint = exponent + 1
    if (decimalPoint <= 0) {
        return `${sign}0.${'0'.repeat(-decimalPoint)}${digits}`
    }
    if (decimalPoint >= digits.length) {
        return `${sign}${digits}${'0'.repeat(decimalPoint - digits.length)}.0`
    }
    return `${sign}${digits.slice(0, decimalPoint)}.${digits.slice(decimalPoint)}`
}

function projectRuntimeLonLat(longitude: number, latitude: number): readonly [number, number] {

    const radius = 6_378_137
    return [
        radius * (longitude * Math.PI / 180),
        radius * Math.asinh(Math.tan(latitude * Math.PI / 180)),
    ]
}

function approximatelyEqual(value: number, expected: number): boolean {

    const tolerance = Math.max(1e-7, Math.abs(expected) * 1e-14)
    return Math.abs(value - expected) <= tolerance
}

function finiteTuple(value: unknown, length: number): value is readonly number[] {

    return Array.isArray(value) && value.length === length && value.every(finiteNumber)
}

function sameObjectKeys(value: object, expected: readonly string[]): boolean {

    const keys = Object.keys(value)
    return keys.length === expected.length && expected.every(key => Object.hasOwn(value, key))
}

function numericMatrixId(value: unknown): number | undefined {

    if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) return undefined
    const level = Number(value)
    return Number.isSafeInteger(level) && level >= 0 && level <= 24
        ? level
        : undefined
}

function finiteJson(value: unknown, seen = new Set<object>()): value is JsonValue {

    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
    if (typeof value === 'number') return Number.isFinite(value)
    if (typeof value !== 'object' || seen.has(value)) return false
    seen.add(value)
    const valid = Array.isArray(value)
        ? value.every(entry => finiteJson(entry, seen))
        : Object.values(value).every(entry => finiteJson(entry, seen))
    seen.delete(value)
    return valid
}

function runtimeSampleKey(timeIndex: number): string {

    return `t${String(timeIndex).padStart(2, '0')}`
}

function sameZeroVelocity(value: unknown): value is readonly [0, 0] {

    return Array.isArray(value) && value.length === 2 &&
        Object.is(value[0], 0) && Object.is(value[1], 0)
}

function nonemptyString(value: unknown): value is string {

    return typeof value === 'string' && value.length > 0
}

function finiteNumber(value: unknown): value is number {

    return typeof value === 'number' && Number.isFinite(value)
}

function nonnegativeNumber(value: unknown): value is number {

    return finiteNumber(value) && value >= 0
}

function requireNonnegativeNumber(value: unknown): number {

    if (!nonnegativeNumber(value)) throw invalidRuntimeManifest()
    return value
}

function nonnegativeInteger(value: unknown): value is number {

    return Number.isSafeInteger(value) && Number(value) >= 0
}

function positiveInteger(value: unknown): value is number {

    return Number.isSafeInteger(value) && Number(value) > 0
}

function invalidRuntimeManifest(): TypeError {

    return new TypeError('Flow Field runtime manifest does not match schema 2')
}

function geographicBounds(value: unknown): value is readonly [number, number, number, number] {

    return Array.isArray(value) && value.length === 4 && value.every(Number.isFinite) &&
        value[0] >= -180 && value[2] <= 180 &&
        value[1] >= -WebMercatorQuad.maxLatitude &&
        value[3] <= WebMercatorQuad.maxLatitude &&
        value[0] < value[2] && value[1] < value[3]
}

function sameValues(value: unknown, expected: readonly unknown[]): boolean {

    return Array.isArray(value) && value.length === expected.length &&
        value.every((entry, index) => entry === expected[index])
}

function sameLimits(
    limits: readonly TileMatrixLimits[],
    bounds: readonly [number, number, number, number]
): boolean {

    return limits.every(limit => {
        const northWest = WebMercatorQuad.tileFromLonLat(
            [ bounds[0], bounds[3] ],
            limit.matrixId
        )
        const southEast = WebMercatorQuad.tileFromLonLat(
            [ bounds[2], bounds[1] ],
            limit.matrixId
        )
        return limit.minTileRow === northWest.tileRow &&
            limit.maxTileRow === southEast.tileRow &&
            limit.minTileCol === northWest.tileCol &&
            limit.maxTileCol === southEast.tileCol
    })
}

function sha256(value: unknown): value is string {

    return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

function deepFreeze<T>(value: T): T {

    if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
    for (const child of Object.values(value)) deepFreeze(child)
    return Object.freeze(value) as T
}
