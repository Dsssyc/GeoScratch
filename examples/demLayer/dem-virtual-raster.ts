import type { ScratchRuntime } from 'geoscratch'
import {
    VirtualRasterResidency,
    cellLocalF32Codec,
    createVirtualRasterGpuState,
    surfaceDomain,
    virtualRasterAccessor,
    virtualRasterAddressSpace,
    virtualRasterPlane,
    virtualRasterSource,
} from 'geoscratch/geo'
import type {
    CellLocalPosition,
    VirtualRasterGpuState,
    VirtualRasterGpuUpdate,
    VirtualRasterPageIdentity,
    VirtualRasterPagePayload,
    VirtualRasterSource,
} from 'geoscratch/geo'
import { MAX_TERRAIN_NODES } from './terrain-selection.ts'

type NumberSequence = ArrayLike<number> & Iterable<number>
type TerrainSelection = Readonly<{
    visibleNodeCount: number
    cameraPos?: readonly number[]
    nodeLevels: readonly number[]
    nodeBoxes: readonly number[]
}>

type DemVirtualRasterLevel = Readonly<{
    zoom: number
    decimation: number
    width: number
    height: number
    pagesX: number
    pagesY: number
}>

export type DemVirtualRasterManifest = Readonly<{
    schemaVersion: 1
    sourceHash: string
    contentVersion: string
    crs: 'EPSG:4326'
    bounds: readonly [number, number, number, number]
    rasterDimensions: Readonly<{ width: number; height: number }>
    tileMatrixSet: Readonly<{
        id: 'GeoScratchLocalRasterQuad'
        origin: 'southwest'
        axisOrder: readonly ['east', 'north']
    }>
    tileSize: number
    minZoom: number
    maxZoom: number
    nodata: number | null
    sampleType: 'uint8'
    scale: number
    offset: number
    overviewLevels: readonly number[]
    pixelOrientation: Readonly<{
        source: 'south-up-row-major'
        cog: 'north-up-row-major'
        tile: 'south-up-row-major'
    }>
    outerBoundary: 'clamp'
    levels: readonly DemVirtualRasterLevel[]
}>

export type DemVirtualRasterPagePlan = Readonly<{
    pages: readonly VirtualRasterPageIdentity[]
    requestedLodRange: readonly [number, number]
    geometryLodRange: readonly [number, number]
}>

export type DemStitchInput = Readonly<{
    x: number
    y: number
    ownLevel: number
    leftLevel: number
    rightLevel: number
    bottomLevel: number
    topLevel: number
}>

export type DemVirtualRasterRuntimeOptions = Readonly<{
    runtime: ScratchRuntime
    manifest: DemVirtualRasterManifest
    source: VirtualRasterSource
    maxPhysicalPages?: number
    maxCpuBytes?: number
    maxHistory?: number
}>

export type DemVirtualRasterPublication = Readonly<{
    snapshotEpoch: number
    changed: boolean
    update: VirtualRasterGpuUpdate
}>

export const DEM_COORDINATE_QUANTUM = 180 / 2 ** 30
export const DEM_CANONICAL_NODE_BYTES = 32
export const DEM_DEFAULT_PHYSICAL_PAGES = 18
export const DEM_DEFAULT_HISTORY = 64

const DEM_FINEST_HEIGHT_GEOMETRY_LEVEL = 12
const DEM_MAX_HEIGHT_LEVEL = 3
const DEM_LONGITUDE_ORIGIN = -180
const DEM_LATITUDE_ORIGIN = -90
const DEM_TILE_SIZE = 256

const demCoordinateDomain = surfaceDomain({
    id: 'geoscratch.dem.geographic-cell-grid',
    axes: [
        { name: 'longitude', unit: 'degree' },
        { name: 'latitude', unit: 'degree' },
    ],
    embeddingAxes: [
        { name: 'mercator-x', unit: 'normalized-world' },
        { name: 'mercator-y', unit: 'normalized-world' },
        { name: 'height', unit: 'meter' },
    ],
    auxiliaryAxes: [ { name: 'height-lod', unit: 'level' } ],
})

export const DEM_COORDINATE_CODEC = cellLocalF32Codec({
    domain: demCoordinateDomain,
    cellExtent: [ DEM_COORDINATE_QUANTUM, DEM_COORDINATE_QUANTUM ],
})

export function parseDemVirtualRasterManifest(value: unknown): DemVirtualRasterManifest {

    const manifest = value as Partial<DemVirtualRasterManifest> | null
    if (manifest === null || typeof manifest !== 'object') {
        throw new TypeError('DEM virtual raster manifest must be an object')
    }
    const dimensions = manifest.rasterDimensions
    const tileMatrixSet = manifest.tileMatrixSet
    const orientation = manifest.pixelOrientation
    const levels = manifest.levels
    if (
        manifest.schemaVersion !== 1 ||
        typeof manifest.sourceHash !== 'string' || !/^[0-9a-f]{64}$/.test(manifest.sourceHash) ||
        typeof manifest.contentVersion !== 'string' || manifest.contentVersion.length === 0 ||
        manifest.crs !== 'EPSG:4326' ||
        !isFiniteTuple(manifest.bounds, 4) ||
        dimensions?.width !== 1024 || dimensions.height !== 558 ||
        tileMatrixSet?.id !== 'GeoScratchLocalRasterQuad' ||
        tileMatrixSet.origin !== 'southwest' ||
        tileMatrixSet.axisOrder?.[0] !== 'east' || tileMatrixSet.axisOrder[1] !== 'north' ||
        manifest.tileSize !== DEM_TILE_SIZE ||
        manifest.minZoom !== 0 || manifest.maxZoom !== 3 ||
        manifest.nodata !== null || manifest.sampleType !== 'uint8' ||
        !Number.isFinite(manifest.scale) || !Number.isFinite(manifest.offset) ||
        !sameNumbers(manifest.overviewLevels, [ 2, 4, 8 ]) ||
        orientation?.source !== 'south-up-row-major' ||
        orientation.cog !== 'north-up-row-major' ||
        orientation.tile !== 'south-up-row-major' ||
        manifest.outerBoundary !== 'clamp' ||
        !Array.isArray(levels) || levels.length !== 4
    ) {
        throw new TypeError('DEM virtual raster manifest does not match the frozen COG contract')
    }
    for (let zoom = 0; zoom < levels.length; zoom++) {
        const level = levels[zoom]
        const decimation = 2 ** (manifest.maxZoom - zoom)
        const width = Math.ceil(dimensions.width / decimation)
        const height = Math.ceil(dimensions.height / decimation)
        if (level.zoom !== zoom || level.decimation !== decimation ||
            level.width !== width || level.height !== height ||
            level.pagesX !== Math.ceil(width / DEM_TILE_SIZE) ||
            level.pagesY !== Math.ceil(height / DEM_TILE_SIZE)) {
            throw new TypeError(`DEM virtual raster level ${zoom} is inconsistent`)
        }
    }
    if (manifest.bounds[0] >= manifest.bounds[2] || manifest.bounds[1] >= manifest.bounds[3]) {
        throw new TypeError('DEM virtual raster bounds must be ordered')
    }
    return deepFreeze(JSON.parse(JSON.stringify(manifest)) as DemVirtualRasterManifest)
}

export function createDemVirtualRasterModel(manifest: DemVirtualRasterManifest) {

    const addressSpace = virtualRasterAddressSpace({
        id: `dem.${manifest.sourceHash.slice(0, 16)}`,
        dimensions: 2,
        extent: [ manifest.rasterDimensions.width, manifest.rasterDimensions.height ],
        pageSize: [ manifest.tileSize, manifest.tileSize ],
        levelCount: manifest.maxZoom - manifest.minZoom + 1,
    })
    const plane = virtualRasterPlane({
        id: `dem-height.${manifest.contentVersion}`,
        addressSpace,
        kind: 'scalar',
        channels: 1,
        sampleType: 'unorm8',
        gpuFormat: 'r8unorm',
        ...(manifest.nodata === null ? {} : { noData: manifest.nodata }),
        scale: manifest.scale,
        offset: manifest.offset,
        auxiliaryAxes: [ { name: 'overview', value: 'explicit-level' } ],
    })
    const accessor = virtualRasterAccessor({ addressSpace, plane })
    return Object.freeze({
        addressSpace,
        plane,
        accessor,
        httpZoom: (page: VirtualRasterPageIdentity) => {
            addressSpace.assertPage(page)
            return manifest.maxZoom - page.level
        },
    })
}

export function createDemHttpVirtualRasterSource(
    manifest: DemVirtualRasterManifest,
    baseUrl: string
): VirtualRasterSource {

    const model = createDemVirtualRasterModel(manifest)
    const normalizedBaseUrl = baseUrl.replace(/\/$/, '')
    return virtualRasterSource({
        id: `dem-http.${manifest.contentVersion}`,
        async loadPage(page, { signal }): Promise<VirtualRasterPagePayload> {
            model.addressSpace.assertPage(page)
            const [ x, y ] = page.coordinates
            const zoom = model.httpZoom(page)
            const response = await fetch(
                `${normalizedBaseUrl}/tiles/${zoom}/${x}/${y}.png`,
                { signal }
            )
            if (!response.ok) {
                const error = new Error(
                    `DEM tile ${page.key} request failed with HTTP ${response.status}`
                ) as Error & { code?: string; status?: number }
                error.code = response.status === 404
                    ? 'DEM_TILE_MISSING'
                    : 'DEM_TILE_SERVICE_ERROR'
                error.status = response.status
                throw error
            }
            const data = await decodeDemTile(await response.blob(), signal)
            return Object.freeze({
                page,
                width: manifest.tileSize,
                height: manifest.tileSize,
                channels: 1,
                data,
                contentVersion: manifest.contentVersion,
            })
        },
    })
}

export async function fetchDemVirtualRasterManifest(
    baseUrl: string,
    signal: AbortSignal
): Promise<DemVirtualRasterManifest> {

    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/manifest.json`, { signal })
    if (!response.ok) {
        throw new Error(`DEM manifest request failed with HTTP ${response.status}`)
    }
    return parseDemVirtualRasterManifest(await response.json())
}

export async function createDemVirtualRasterRuntime({
    runtime,
    manifest,
    source,
    maxPhysicalPages = DEM_DEFAULT_PHYSICAL_PAGES,
    maxCpuBytes = maxPhysicalPages * manifest.tileSize * manifest.tileSize,
    maxHistory = DEM_DEFAULT_HISTORY,
}: DemVirtualRasterRuntimeOptions) {

    const model = createDemVirtualRasterModel(manifest)
    const residency = new VirtualRasterResidency({
        addressSpace: model.addressSpace,
        plane: model.plane,
        source,
        maxPhysicalPages,
        maxCpuBytes,
        maxHistory,
    })
    const rootPage = model.addressSpace.page({
        level: model.addressSpace.levelCount - 1,
        x: 0,
        y: 0,
    })
    residency.pin(rootPage)
    let gpu: VirtualRasterGpuState
    try {
        gpu = await createVirtualRasterGpuState(runtime, {
            addressSpace: model.addressSpace,
            plane: model.plane,
            maxPhysicalPages,
        })
    } catch (error) {
        residency.dispose()
        throw error
    }
    let publishedFailedCount = 0
    const failedPageKeys = new Set<string>()

    async function initialize() {
        const outcome = await residency.request(rootPage)
        if (outcome.status !== 'staged' && outcome.status !== 'resident') {
            throw new Error(`DEM root page failed to become resident: ${outcome.error ?? outcome.status}`)
        }
        failedPageKeys.delete(rootPage.key)
        return publish()
    }

    function prepare(selection: TerrainSelection) {
        const plan = planDemVirtualPages(model.addressSpace, selection, manifest.bounds)
        const activePages = plan.pages.slice(0, maxPhysicalPages)
        const beforeRequestCount = residency.inspect().pageRequestCount
        const requests = activePages
            .filter(page => !failedPageKeys.has(page.key))
            .map(page => residency.request(page).then(outcome => {
                if (outcome.status === 'failed') failedPageKeys.add(page.key)
                return outcome
            }))
        const requestedCount = residency.inspect().pageRequestCount - beforeRequestCount
        return Object.freeze({
            plan,
            activePages: Object.freeze(activePages),
            requestedCount,
            settlement: Promise.all(requests).then(outcomes => Object.freeze({
                outcomes: Object.freeze(outcomes),
                failedCount: outcomes.filter(outcome => outcome.status === 'failed').length,
            })),
        })
    }

    function publish(): DemVirtualRasterPublication {
        const facts = residency.inspect()
        const changed = facts.stagedCount > 0 || facts.failedCount !== publishedFailedCount
        const snapshot = changed ? residency.publishSnapshot() : residency.currentSnapshot
        const update = gpu.stage(snapshot)
        publishedFailedCount = facts.failedCount
        return Object.freeze({ snapshotEpoch: snapshot.epoch, changed, update })
    }

    function acknowledge(publication: DemVirtualRasterPublication) {
        if (publication.update.commands.length === 0) return
        gpu.acknowledge(residency.currentSnapshot)
    }

    async function stopStreaming() {
        residency.dispose()
        await residency.whenIdle()
    }

    return Object.freeze({
        ...model,
        manifest,
        source,
        residency,
        gpu,
        rootPage,
        initialize,
        prepare,
        publish,
        acknowledge,
        stopStreaming,
        inspect: () => Object.freeze({
            contentVersion: manifest.contentVersion,
            coordinateEncoding: DEM_COORDINATE_CODEC.facts.encoding,
            coordinateQuantum: DEM_COORDINATE_QUANTUM,
            failedPageKeys: Object.freeze([ ...failedPageKeys ].sort()),
            residency: residency.inspect(),
            gpu: gpu.facts(),
        }),
    })
}

export function planDemVirtualPages(
    addressSpace: ReturnType<typeof virtualRasterAddressSpace>,
    selection: TerrainSelection,
    bounds: NumberSequence
): DemVirtualRasterPagePlan {

    const pages = new Map<string, VirtualRasterPageIdentity>()
    const requested = new Map<string, VirtualRasterPageIdentity>()
    let minimumRequestedLevel = addressSpace.levelCount - 1
    let maximumRequestedLevel = 0
    let minimumGeometryLevel = Number.POSITIVE_INFINITY
    let maximumGeometryLevel = 0
    const addWithParents = (page: VirtualRasterPageIdentity) => {
        let current: VirtualRasterPageIdentity | undefined = page
        while (current !== undefined) {
            pages.set(current.key, current)
            current = addressSpace.parent(current)
        }
    }

    for (let index = 0; index < selection.visibleNodeCount; index++) {
        const offset = index * 4
        const nodeBounds = selection.nodeBoxes.slice(offset, offset + 4)
        const intersection = intersectBounds(nodeBounds, bounds)
        if (intersection === undefined) continue
        const geometryLevel = selection.nodeLevels[index]!
        const level = demHeightSamplingLevel(geometryLevel)
        minimumRequestedLevel = Math.min(minimumRequestedLevel, level)
        maximumRequestedLevel = Math.max(maximumRequestedLevel, level)
        minimumGeometryLevel = Math.min(minimumGeometryLevel, geometryLevel)
        maximumGeometryLevel = Math.max(maximumGeometryLevel, geometryLevel)
        const extent = addressSpace.levelExtent(level)
        const scale = 2 ** level
        const finest = addressSpace.extent
        const minimumX = logicalTexel(intersection[0], bounds[0], bounds[2], finest[0]!) / scale
        const minimumY = logicalTexel(intersection[1], bounds[1], bounds[3], finest[1]!) / scale
        const maximumX = logicalTexel(intersection[2], bounds[0], bounds[2], finest[0]!) / scale
        const maximumY = logicalTexel(intersection[3], bounds[1], bounds[3], finest[1]!) / scale
        const pageMinimumX = Math.floor(clamp(Math.floor(minimumX) - 1, 0, extent[0]! - 1) /
            addressSpace.pageSize[0]!)
        const pageMinimumY = Math.floor(clamp(Math.floor(minimumY) - 1, 0, extent[1]! - 1) /
            addressSpace.pageSize[1]!)
        const pageMaximumX = Math.floor(clamp(Math.ceil(maximumX) + 1, 0, extent[0]! - 1) /
            addressSpace.pageSize[0]!)
        const pageMaximumY = Math.floor(clamp(Math.ceil(maximumY) + 1, 0, extent[1]! - 1) /
            addressSpace.pageSize[1]!)
        for (let pageY = pageMinimumY; pageY <= pageMaximumY; pageY++) {
            for (let pageX = pageMinimumX; pageX <= pageMaximumX; pageX++) {
                addWithParents(addressSpace.page({ level, x: pageX, y: pageY }))
                const requestedPage = addressSpace.page({ level, x: pageX, y: pageY })
                requested.set(requestedPage.key, requestedPage)
            }
        }
    }
    if (pages.size === 0) {
        addWithParents(addressSpace.page({ level: addressSpace.levelCount - 1, x: 0, y: 0 }))
    }
    const root = addressSpace.page({ level: addressSpace.levelCount - 1, x: 0, y: 0 })
    const requestedPages = [ ...requested.values() ].sort((left, right) =>
        left.level - right.level ||
        left.coordinates[1]! - right.coordinates[1]! ||
        left.coordinates[0]! - right.coordinates[0]!,
    )
    const requestedKeys = new Set(requestedPages.map(page => page.key))
    const parents = [ ...pages.values() ].filter(page =>
        page.key !== root.key && !requestedKeys.has(page.key)
    ).sort((left, right) =>
        right.level - left.level ||
        left.coordinates[1]! - right.coordinates[1]! ||
        left.coordinates[0]! - right.coordinates[0]!,
    )
    const ordered = [
        root,
        ...requestedPages.filter(page => page.key !== root.key),
        ...parents,
    ]
    return Object.freeze({
        pages: Object.freeze(ordered),
        requestedLodRange: Object.freeze([
            minimumRequestedLevel,
            Math.max(maximumRequestedLevel, addressSpace.levelCount - 1),
        ]) as readonly [number, number],
        geometryLodRange: Object.freeze([
            Number.isFinite(minimumGeometryLevel) ? minimumGeometryLevel : 0,
            maximumGeometryLevel,
        ]) as readonly [number, number],
    })
}

export function demHeightSamplingLevel(geometryLevel: number): number {

    if (!Number.isSafeInteger(geometryLevel) || geometryLevel < 0) {
        throw new TypeError('DEM geometry level must be a non-negative integer')
    }
    return clamp(
        DEM_FINEST_HEIGHT_GEOMETRY_LEVEL - geometryLevel,
        0,
        DEM_MAX_HEIGHT_LEVEL
    )
}

export function resolveDemStitchedGrid(input: DemStitchInput) {

    for (const name of [ 'x', 'y', 'ownLevel', 'leftLevel', 'rightLevel', 'bottomLevel', 'topLevel' ] as const) {
        if (!Number.isSafeInteger(input[name]) || input[name] < 0) {
            throw new TypeError(`DEM stitch ${name} must be a non-negative integer`)
        }
    }
    if (input.x > 64 || input.y > 64) {
        throw new RangeError('DEM stitch grid coordinate must be inside the 64-sector mesh')
    }
    let x = input.x
    let y = input.y
    let heightSamplingLevel = demHeightSamplingLevel(input.ownLevel)
    if (x === 0) {
        heightSamplingLevel = Math.max(heightSamplingLevel, demHeightSamplingLevel(input.leftLevel))
        if (input.leftLevel < input.ownLevel && y % 2 === 1) y++
    }
    if (x === 64) {
        heightSamplingLevel = Math.max(heightSamplingLevel, demHeightSamplingLevel(input.rightLevel))
        if (input.rightLevel < input.ownLevel && y % 2 === 1) y++
    }
    if (y === 0) {
        heightSamplingLevel = Math.max(heightSamplingLevel, demHeightSamplingLevel(input.bottomLevel))
        if (input.bottomLevel < input.ownLevel && x % 2 === 1) x++
    }
    if (y === 64) {
        heightSamplingLevel = Math.max(heightSamplingLevel, demHeightSamplingLevel(input.topLevel))
        if (input.topLevel < input.ownLevel && x % 2 === 1) x++
    }
    return Object.freeze({ x, y, heightSamplingLevel })
}

export function encodeDemCoordinate(coordinate: NumberSequence): CellLocalPosition {

    if (!isFiniteTuple(coordinate, 2)) {
        throw new TypeError('DEM coordinate must contain two finite numbers')
    }
    const cells = [
        Math.round((coordinate[0] - DEM_LONGITUDE_ORIGIN) / DEM_COORDINATE_QUANTUM),
        Math.round((coordinate[1] - DEM_LATITUDE_ORIGIN) / DEM_COORDINATE_QUANTUM),
    ]
    return DEM_COORDINATE_CODEC.normalize({ cells, local: [ 0, 0 ] })
}

export function canonicalDemCoordinateCells(
    bounds: NumberSequence,
    grid: Readonly<{ x: number; y: number }>
): readonly [number, number] {

    if (!isFiniteTuple(bounds, 4) ||
        !Number.isSafeInteger(grid.x) || !Number.isSafeInteger(grid.y) ||
        grid.x < 0 || grid.x > 64 || grid.y < 0 || grid.y > 64) {
        throw new TypeError('DEM canonical grid input is invalid')
    }
    const minimum = encodeDemCoordinate([ bounds[0], bounds[1] ])
    const maximum = encodeDemCoordinate([ bounds[2], bounds[3] ])
    return Object.freeze([
        interpolateInteger(minimum.cells[0]!, maximum.cells[0]!, grid.x, 64),
        interpolateInteger(minimum.cells[1]!, maximum.cells[1]!, grid.y, 64),
    ])
}

export function encodeDemCanonicalNodes(
    selection: TerrainSelection,
    manifest: DemVirtualRasterManifest
): Uint8Array<ArrayBuffer> {

    parseDemVirtualRasterManifest(manifest)
    if (selection.visibleNodeCount > MAX_TERRAIN_NODES ||
        selection.nodeLevels.length < selection.visibleNodeCount ||
        selection.nodeBoxes.length < selection.visibleNodeCount * 4) {
        throw new RangeError('DEM terrain selection exceeds the canonical node buffer')
    }
    const bytes = new Uint8Array(MAX_TERRAIN_NODES * DEM_CANONICAL_NODE_BYTES)
    return writeDemCanonicalNodes(bytes, selection, manifest)
}

export function writeDemCanonicalNodes(
    bytes: Uint8Array<ArrayBuffer>,
    selection: TerrainSelection,
    manifest: DemVirtualRasterManifest
): Uint8Array<ArrayBuffer> {

    if (bytes.byteLength !== MAX_TERRAIN_NODES * DEM_CANONICAL_NODE_BYTES) {
        throw new RangeError('DEM canonical node target has the wrong byte length')
    }
    bytes.fill(0)
    for (let index = 0; index < selection.visibleNodeCount; index++) {
        const offset = index * 4
        const minimum = encodeDemCoordinate([
            selection.nodeBoxes[offset]!,
            selection.nodeBoxes[offset + 1]!,
        ])
        const maximum = encodeDemCoordinate([
            selection.nodeBoxes[offset + 2]!,
            selection.nodeBoxes[offset + 3]!,
        ])
        bytes.set(DEM_COORDINATE_CODEC.pack([ minimum, maximum ]), index * DEM_CANONICAL_NODE_BYTES)
    }
    return bytes
}

export function demCoordinateWgslModule() {

    return DEM_COORDINATE_CODEC.wgslModule({ namespace: 'DemCoordinate' })
}

export function demVirtualRasterWgslModule(
    virtualRaster: Readonly<{
        accessor: ReturnType<typeof virtualRasterAccessor>
        manifest: DemVirtualRasterManifest
    }>
) {

    const minimum = encodeDemCoordinate([
        virtualRaster.manifest.bounds[0],
        virtualRaster.manifest.bounds[1],
    ])
    const maximum = encodeDemCoordinate([
        virtualRaster.manifest.bounds[2],
        virtualRaster.manifest.bounds[3],
    ])
    const positionLiteral = (position: CellLocalPosition) =>
        `DemCoordinatePosition(array<DemCoordinateAxis, 2>(` +
        `DemCoordinateAxis(${position.cells[0]}i, ${Math.fround(position.local[0]!)}f), ` +
        `DemCoordinateAxis(${position.cells[1]}i, ${Math.fround(position.local[1]!)}f)))`
    return `${demCoordinateWgslModule()}\n\n` +
        `${virtualRaster.accessor.wgslModule({
            namespace: 'DemHeight',
            group: 2,
            pageTableBinding: 0,
            atlasBinding: 1,
        })}\n\n` +
        `const DemRasterMinimum = ${positionLiteral(minimum)};\n` +
        `const DemRasterMaximum = ${positionLiteral(maximum)};\n` +
        `const DemRasterDimensions = vec2f(` +
        `${virtualRaster.manifest.rasterDimensions.width - 1}.0, ` +
        `${virtualRaster.manifest.rasterDimensions.height - 1}.0);\n` +
        `const DemElevationRange = vec2f(` +
        `${Math.fround(virtualRaster.manifest.offset)}f, ` +
        `${Math.fround(virtualRaster.manifest.offset + virtualRaster.manifest.scale * 255)}f);\n`
}

async function decodeDemTile(blob: Blob, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {

    if (signal.aborted) throw signal.reason
    const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none' })
    try {
        if (bitmap.width !== DEM_TILE_SIZE || bitmap.height !== DEM_TILE_SIZE) {
            throw new Error(`DEM tile payload must be ${DEM_TILE_SIZE} by ${DEM_TILE_SIZE}`)
        }
        const canvas = new OffscreenCanvas(DEM_TILE_SIZE, DEM_TILE_SIZE)
        const context = canvas.getContext('2d', { willReadFrequently: true })
        if (context === null) throw new Error('DEM tile decoder could not create a 2D context')
        context.drawImage(bitmap, 0, 0)
        const rgba = context.getImageData(0, 0, DEM_TILE_SIZE, DEM_TILE_SIZE).data
        const result = new Uint8Array(DEM_TILE_SIZE * DEM_TILE_SIZE)
        for (let index = 0; index < result.length; index++) result[index] = rgba[index * 4]!
        return result
    } finally {
        bitmap.close()
    }
}

function logicalTexel(value: number, minimum: number, maximum: number, extent: number) {

    return (value - minimum) / (maximum - minimum) * (extent - 1)
}

function intersectBounds(left: NumberSequence, right: NumberSequence) {

    const intersection = [
        Math.max(left[0], right[0]),
        Math.max(left[1], right[1]),
        Math.min(left[2], right[2]),
        Math.min(left[3], right[3]),
    ]
    return intersection[0] > intersection[2] || intersection[1] > intersection[3]
        ? undefined
        : intersection
}

function interpolateInteger(minimum: number, maximum: number, index: number, count: number) {

    const delta = maximum - minimum
    const quotient = Math.trunc(delta / count)
    const remainder = delta - quotient * count
    return minimum + quotient * index + Math.trunc(remainder * index / count)
}

function isFiniteTuple(value: unknown, length: number): value is NumberSequence {

    return (Array.isArray(value) || ArrayBuffer.isView(value)) &&
        (value as NumberSequence).length === length &&
        Array.from(value as NumberSequence).every(Number.isFinite)
}

function sameNumbers(left: unknown, right: readonly number[]) {

    return Array.isArray(left) && left.length === right.length &&
        left.every((value, index) => value === right[index])
}

function clamp(value: number, minimum: number, maximum: number) {

    return Math.min(maximum, Math.max(minimum, value))
}

function deepFreeze<T>(value: T): T {

    if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
    for (const child of Object.values(value)) deepFreeze(child)
    return Object.freeze(value) as T
}
