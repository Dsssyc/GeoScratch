import {
    WebMercatorQuad,
    tileMatrixCoverage,
} from 'geoscratch/geo'
import type { TileMatrixLimits } from 'geoscratch/geo'

export type FlowDatasetTime = Readonly<{
    timeIndex: number
    modelTime: number
    unit: 'ordinal'
    phase: 'unspecified'
    sourceHash: string
}>

export type FlowTileMatrixSetManifest = Readonly<{
    id: 'WebMercatorQuad'
    uri: string
    tileWidth: 256
    tileHeight: 256
    minTileMatrix: '4'
    maxTileMatrix: '9'
    limits: readonly TileMatrixLimits[]
}>

export type FlowVelocityPageManifest = Readonly<{
    timeIndex: number
    matrixId: string
    tileRow: number
    tileCol: number
    byteLength: 524288
    sha256: string
    maximumSpeed: number
}>

export type FlowDatasetManifest = Readonly<{
    schemaVersion: 1
    sourceHash: string
    contentVersion: string
    stationCount: 117148
    source: Readonly<{
        crs: 'EPSG:4326'
        geographicBounds: readonly [number, number, number, number]
    }>
    times: readonly FlowDatasetTime[]
    tileMatrixSet: FlowTileMatrixSetManifest
    encoding: Readonly<{
        channels: 2
        componentOrder: readonly ['u', 'v']
        sampleType: 'float32-le'
        layout: 'rg-interleaved'
        tileWidth: 256
        tileHeight: 256
    }>
    unit: 'legacy-flow-unit'
    basis: 'source-u-v'
    pages: readonly FlowVelocityPageManifest[]
}>

const TIME_COUNT = 27
const MIN_TILE_MATRIX = 4
const MAX_TILE_MATRIX = 9
const PAGE_BYTE_LENGTH = 256 * 256 * 2 * 4
const manifestUrls = new WeakMap<FlowDatasetManifest, URL>()

/** Loads and validates the immutable velocity-only Flow Field dataset manifest. */
export async function loadFlowDatasetManifest(
    url: string | URL
): Promise<FlowDatasetManifest> {

    let manifestUrl: URL
    try {
        manifestUrl = new URL(String(url), globalThis.location?.href)
    } catch {
        throw new TypeError('Flow Field manifest URL must be absolute or browser-relative')
    }
    const response = await fetch(manifestUrl, { cache: 'no-store' })
    if (!response.ok) {
        throw new Error(`Flow Field manifest request failed with HTTP ${response.status}`)
    }
    const manifest = parseFlowDatasetManifest(await response.json())
    manifestUrls.set(manifest, manifestUrl)
    return manifest
}

/** @internal Returns the source URL captured when a manifest was loaded. */
export function flowDatasetManifestUrl(manifest: FlowDatasetManifest): URL {

    const url = manifestUrls.get(manifest)
    if (url === undefined) {
        throw new TypeError('Flow Field sources require a manifest returned by the loader')
    }
    return url
}

function parseFlowDatasetManifest(value: unknown): FlowDatasetManifest {

    const manifest = value as Partial<FlowDatasetManifest> | null
    const matrixSet = manifest?.tileMatrixSet
    const encoding = manifest?.encoding
    const source = manifest?.source
    if (manifest === null || typeof manifest !== 'object' ||
        manifest.schemaVersion !== 1 || !sha256(manifest.sourceHash) ||
        typeof manifest.contentVersion !== 'string' || manifest.contentVersion.length === 0 ||
        manifest.stationCount !== 117148 || source?.crs !== 'EPSG:4326' ||
        !geographicBounds(source.geographicBounds) ||
        matrixSet?.id !== WebMercatorQuad.id || matrixSet.uri !== WebMercatorQuad.uri ||
        matrixSet.tileWidth !== 256 || matrixSet.tileHeight !== 256 ||
        matrixSet.minTileMatrix !== '4' || matrixSet.maxTileMatrix !== '9' ||
        !Array.isArray(matrixSet.limits) ||
        encoding?.channels !== 2 || !sameValues(encoding.componentOrder, [ 'u', 'v' ]) ||
        encoding.sampleType !== 'float32-le' || encoding.layout !== 'rg-interleaved' ||
        encoding.tileWidth !== 256 || encoding.tileHeight !== 256 ||
        manifest.unit !== 'legacy-flow-unit' || manifest.basis !== 'source-u-v' ||
        !validTimes(manifest.times) || !Array.isArray(manifest.pages)) {
        throw invalidManifest()
    }

    const snapshot = deepFreeze(structuredClone(manifest) as FlowDatasetManifest)
    const expectedMatrixIds = Array.from(
        { length: MAX_TILE_MATRIX - MIN_TILE_MATRIX + 1 },
        (_value, index) => String(index + MIN_TILE_MATRIX)
    )
    if (!sameValues(snapshot.tileMatrixSet.limits.map(limit => limit.matrixId), expectedMatrixIds) ||
        !sameLimits(snapshot.tileMatrixSet.limits, snapshot.source.geographicBounds)) {
        throw invalidManifest()
    }
    let coverage
    try {
        coverage = tileMatrixCoverage({
            tileMatrixSet: WebMercatorQuad,
            limits: snapshot.tileMatrixSet.limits,
        })
    } catch {
        throw invalidManifest()
    }
    const expectedPageCount = coverage.entryCount * TIME_COUNT
    if (snapshot.pages.length !== expectedPageCount) throw invalidManifest()
    for (let index = 0; index < snapshot.pages.length; index++) {
        const timeIndex = Math.floor(index / coverage.entryCount)
        const expected = coverage.coordinate(index % coverage.entryCount)
        const page = snapshot.pages[index]!
        if (page?.timeIndex !== timeIndex || page.matrixId !== expected.matrixId ||
            page.tileRow !== expected.tileRow || page.tileCol !== expected.tileCol ||
            page.byteLength !== PAGE_BYTE_LENGTH || !sha256(page.sha256) ||
            !Number.isFinite(page.maximumSpeed) || page.maximumSpeed < 0) {
            throw invalidManifest()
        }
    }
    return snapshot
}

function validTimes(value: unknown): value is readonly FlowDatasetTime[] {

    return Array.isArray(value) && value.length === TIME_COUNT && value.every((time, index) =>
        time?.timeIndex === index && time.modelTime === index && time.unit === 'ordinal' &&
        time.phase === 'unspecified' && sha256(time.sourceHash)
    )
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

function invalidManifest(): TypeError {

    return new TypeError('Flow Field manifest does not match the velocity-only contract')
}

function deepFreeze<T>(value: T): T {

    if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
    for (const child of Object.values(value)) deepFreeze(child)
    return Object.freeze(value) as T
}
