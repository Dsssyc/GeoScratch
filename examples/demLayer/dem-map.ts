import { mat4 } from 'wgpu-matrix'

type Vec3 = [ number, number, number ]
type Matrix = Float32Array<ArrayBuffer>

type LngLat = {
    lng: number
    lat: number
}

type CameraPosition = {
    lngLat: LngLat
    altitude: number
}

type Point = {
    x: number
    y: number
}

type MapStyle = {
    readonly version: number
    readonly sources: {
        readonly cartoDarkMatter?: {
            readonly type: 'raster'
            readonly tiles: readonly string[]
            readonly tileSize: number
            readonly attribution: string
        }
    }
    readonly layers: readonly (
        | {
            readonly id: string
            readonly type: 'raster'
            readonly source: string
            readonly paint: { readonly 'raster-opacity': number }
        }
        | {
            readonly id: string
            readonly type: 'background'
            readonly paint: { readonly 'background-color': string }
        }
    )[]
}

type MapTransform = {
    height: number
    width: number
    mercatorMatrix?: ArrayLike<number> | null
    farZ: number
    nearZ: number
    centerOffset?: Point | null
    point: Point
    _fov?: number
    fov: number
    _pitch?: number
    pitch: number
    angle: number
    bearing: number
    worldSize: number
    elevation?: number
    _elevation?: number
    minElevationForCurrentTile?: number
    cameraToCenterDistance?: number
    _pixelPerMeter?: number
    pixelsPerMeter?: number
    center: { lat: number }
    getCameraPosition(): CameraPosition
    getHorizon?(): number
}

export type DemMap = {
    transform: MapTransform
    loaded(): boolean
    once(event: 'load', listener: () => void): void
    off(event: 'load', listener: () => void): void
    getZoom(): number
    getBounds(): {
        getWest(): number
        getSouth(): number
        getEast(): number
        getNorth(): number
    }
    resize(): void
    on(event: 'render', listener: () => void): void
    off(event: 'render' | 'load', listener: () => void): void
    jumpTo(options: { center?: readonly [ number, number ]; zoom?: number }): void
    remove(): void
}

type MapApi = {
    Map: new (options: {
        style: MapStyle
        center: readonly number[]
        zoom: number
        projection: string
        maxZoom: number
        container: HTMLElement
        antialias: boolean
    }) => DemMap
    MercatorCoordinate: {
        fromLngLat(lngLat: LngLat, altitude: number): { x: number; y: number; z: number }
    }
}

declare global {
    var maplibregl: MapApi | undefined
    var mapboxgl: MapApi | undefined
}

type DemMapOptions = {
    proof?: boolean
}

type Viewport = {
    width: number
    height: number
}

const mapApi = globalThis.maplibregl ?? globalThis.mapboxgl
const underwaterTerrainMinElevation = -80.06899999999999 * 30

if (!mapApi) throw new Error('Map runtime failed to load for DEM Layer')

export const DEM_MAP_DEFAULTS = Object.freeze({
    center: Object.freeze([ 120.980697, 31.684162 ]),
    zoom: 9,
    projection: 'mercator',
    maxZoom: 18,
})

export const darkMatterStyle = Object.freeze({
    version: 8,
    sources: {
        cartoDarkMatter: {
            type: 'raster',
            tiles: [
                'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
                'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
                'https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
                'https://d.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
            ],
            tileSize: 256,
            attribution: 'OpenStreetMap contributors, CARTO',
        },
    },
    layers: [ {
        id: 'carto-dark-matter',
        type: 'raster',
        source: 'cartoDarkMatter',
        paint: { 'raster-opacity': 0.92 },
    } ],
})

const demProofStyle = Object.freeze({
    version: 8,
    sources: {},
    layers: [ {
        id: 'dem-proof-background',
        type: 'background',
        paint: { 'background-color': '#101418' },
    } ],
})

export function createDemMap(canvas: HTMLCanvasElement, options: DemMapOptions = {}) {

    const { proof = false, ...mapOptions } = options
    canvas.style.pointerEvents = 'none'
    canvas.style.zIndex = '1'

    const mapContainer = document.createElement('div')
    mapContainer.id = 'map'
    document.body.appendChild(mapContainer)

    return new mapApi!.Map({
        style: (proof ? demProofStyle : darkMatterStyle) as MapStyle,
        center: DEM_MAP_DEFAULTS.center,
        zoom: DEM_MAP_DEFAULTS.zoom,
        projection: DEM_MAP_DEFAULTS.projection,
        maxZoom: DEM_MAP_DEFAULTS.maxZoom,
        container: mapContainer,
        antialias: true,
        ...mapOptions,
    })
}

export function waitForDemMap(map: DemMap, signal?: AbortSignal): Promise<DemMap> {

    if (signal?.aborted) return Promise.reject(signal.reason)
    if (map.loaded()) return Promise.resolve(map)
    return new Promise<DemMap>((resolve, reject) => {
        const onLoad = () => {
            signal?.removeEventListener('abort', onAbort)
            resolve(map)
        }
        const onAbort = () => {
            map.off('load', onLoad)
            reject(signal!.reason)
        }
        map.once('load', onLoad)
        signal?.addEventListener('abort', onAbort, { once: true })
    })
}

export function readDemCameraState(map: DemMap, viewport: Viewport) {

    const transform = map.transform
    const cameraPosition = transform.getCameraPosition()
    const mercatorCenter = mapApi!.MercatorCoordinate.fromLngLat(
        cameraPosition.lngLat,
        cameraPosition.altitude
    )
    const centerX = encodeFloatToDouble(mercatorCenter.x)
    const centerY = encodeFloatToDouble(mercatorCenter.y)
    const centerZ = encodeFloatToDouble(mercatorCenter.z)
    const centerHigh: Vec3 = [ centerX[0], centerY[0], centerZ[0] ]
    const centerLow: Vec3 = [ centerX[1], centerY[1], centerZ[1] ]
    const { far, near, matrix } = getScratchMercatorMatrix(transform)

    return Object.freeze({
        far,
        near,
        matrix: Array.from((mat4.translate as (
            matrix: Matrix,
            vector: Vec3,
            destination?: Matrix
        ) => Matrix)(matrix, centerHigh)),
        centerHigh,
        centerLow,
        cameraPos: [ cameraPosition.lngLat.lng, cameraPosition.lngLat.lat ],
        zoom: map.getZoom(),
        viewport: [ viewport.width, viewport.height ],
    })
}

function getScratchMercatorMatrix(transform: MapTransform) {

    if (!transform.height || !transform.mercatorMatrix) {
        return {
            far: transform.farZ,
            near: transform.nearZ,
            matrix: Float32Array.from(transform.mercatorMatrix ??
                (mat4.identity as (destination?: Matrix) => Matrix)()),
        }
    }

    const near = transform.height / 50
    const far = calculateFarZForTerrainPlane(transform, underwaterTerrainMinElevation)
    const offset = transform.centerOffset ?? { x: 0, y: 0 }
    const point = transform.point
    const fov = radiansFromTransformValue(transform._fov, transform.fov)
    const pitch = radiansFromTransformValue(transform._pitch, transform.pitch)
    const angle = radiansFromTransformValue(transform.angle, -transform.bearing)
    const cameraToCenterDistance = getCameraToCenterDistance(transform, fov)

    let matrix = (mat4.perspective as (
        fieldOfView: number,
        aspect: number,
        near: number,
        far: number,
        destination?: Matrix
    ) => Matrix)(fov, transform.width / transform.height, near, far)
    matrix[8] = -offset.x * 2 / transform.width
    matrix[9] = offset.y * 2 / transform.height
    mat4.scale(matrix, [ 1, -1, 1 ], matrix)
    mat4.translate(matrix, [ 0, 0, -cameraToCenterDistance ], matrix)
    mat4.rotateX(matrix, pitch, matrix)
    mat4.rotateZ(matrix, angle, matrix)
    mat4.translate(matrix, [ -point.x, -point.y, 0 ], matrix)
    matrix = (mat4.scale as (
        matrix: Matrix,
        vector: Vec3,
        destination?: Matrix
    ) => Matrix)(matrix, [ transform.worldSize, transform.worldSize, transform.worldSize ])

    return { far, near, matrix: Float32Array.from(matrix) }
}

function calculateFarZForTerrainPlane(transform: MapTransform, minElevation: number) {

    const fov = radiansFromTransformValue(transform._fov, transform.fov)
    const pitch = radiansFromTransformValue(transform._pitch, transform.pitch)
    const offset = transform.centerOffset ?? { x: 0, y: 0 }
    const pixelPerMeter = getPixelPerMeter(transform)
    const elevation = getFiniteNumber(transform.elevation, transform._elevation, 0)
    const currentTileMinElevation = getFiniteNumber(transform.minElevationForCurrentTile, elevation)
    const visibleMinElevation = Math.min(elevation, currentTileMinElevation, minElevation)
    const cameraToCenterDistance = getCameraToCenterDistance(transform, fov)
    const cameraToSeaLevelDistance = cameraToCenterDistance +
        elevation * pixelPerMeter / Math.cos(pitch)
    const cameraToLowestPointDistance = cameraToSeaLevelDistance -
        visibleMinElevation * pixelPerMeter / Math.cos(pitch)
    const lowestPlane = visibleMinElevation < 0
        ? cameraToLowestPointDistance
        : cameraToSeaLevelDistance
    const groundAngle = Math.PI / 2 + pitch
    const fovAboveCenter = fov * (0.5 + offset.y / transform.height)
    const topHalfSurfaceDistance = Math.sin(fovAboveCenter) * lowestPlane /
        Math.sin(clamp(Math.PI - groundAngle - fovAboveCenter, 0.01, Math.PI - 0.01))
    const horizon = typeof transform.getHorizon === 'function' ? transform.getHorizon() : Infinity
    let topHalfSurfaceDistanceHorizon = Infinity

    if (Number.isFinite(horizon) && horizon > 0) {
        const horizonAngle = Math.atan(horizon / cameraToCenterDistance)
        const fovCenterToHorizon = 2 * horizonAngle *
            (0.5 + offset.y / (horizon * 2))
        topHalfSurfaceDistanceHorizon = Math.sin(fovCenterToHorizon) * lowestPlane /
            Math.sin(clamp(
                Math.PI - groundAngle - fovCenterToHorizon,
                0.01,
                Math.PI - 0.01
            ))
    }

    const topHalfMinDistance = Math.min(topHalfSurfaceDistance, topHalfSurfaceDistanceHorizon)
    return (Math.cos(Math.PI / 2 - pitch) * topHalfMinDistance + lowestPlane) * 1.01
}

function getCameraToCenterDistance(transform: MapTransform, fov: number) {

    return getFiniteNumber(
        transform.cameraToCenterDistance,
        0.5 / Math.tan(fov / 2) * transform.height
    )
}

function getPixelPerMeter(transform: MapTransform) {

    return getFiniteNumber(
        transform._pixelPerMeter,
        transform.pixelsPerMeter,
        mercatorZfromAltitude(1, transform.center.lat) * transform.worldSize
    )
}

function radiansFromTransformValue(privateRadians: number | undefined, publicDegrees: number) {

    return Number.isFinite(privateRadians) ? privateRadians as number : publicDegrees * Math.PI / 180
}

function getFiniteNumber(...values: readonly (number | undefined)[]): number {

    return values.find(value => Number.isFinite(value)) as number
}

function clamp(value: number, min: number, max: number) {

    return Math.min(Math.max(value, min), max)
}

function circumferenceAtLatitude(latitude: number) {

    const earthRadius = 6371008.8
    return 2 * Math.PI * earthRadius * Math.cos(latitude * Math.PI / 180)
}

function mercatorZfromAltitude(altitude: number, latitude: number) {

    return altitude / circumferenceAtLatitude(latitude)
}

function encodeFloatToDouble(value: number): [ number, number ] {

    const high = Math.fround(value)
    return [ high, value - high ]
}
