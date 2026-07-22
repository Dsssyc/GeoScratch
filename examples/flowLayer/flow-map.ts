import { mat4 } from 'geoscratch'

type Point = Readonly<{ x: number; y: number }>
export type FlowLngLat = Readonly<{ lng: number; lat: number }>
type LngLat = FlowLngLat
type FlowMapTransform = Readonly<{
    width: number
    height: number
    farZ: number
    nearZ: number
    mercatorMatrix?: ArrayLike<number>
    centerOffset?: Point
    point: Point
    _fov: number
    fov: number
    _pitch: number
    pitch: number
    angle: number
    bearing: number
    cameraToCenterDistance: number
    _pixelPerMeter: number
    pixelsPerMeter: number
    elevation: number
    _elevation: number
    minElevationForCurrentTile: number
    center: Readonly<{ lat: number }>
    worldSize: number
    getCameraPosition(): Readonly<{ lngLat: LngLat; altitude: number }>
    getHorizon?(): number
}>

type FlowMapBounds = Readonly<{
    getWest(): number
    getSouth(): number
    getEast(): number
    getNorth(): number
}>

export type FlowMap = Readonly<{
    transform: FlowMapTransform
    loaded(): boolean
    once(type: 'load', listener: () => void): void
    on(type: string, listener: () => void): void
    off(type: string, listener: () => void): void
    remove(): void
    getBounds(): FlowMapBounds
    getZoom(): number
    triggerRepaint(): void
    project(lngLat: [number, number] | LngLat): Point
}>

type RasterSource = Readonly<{
    type: 'raster'
    tiles: readonly string[]
    tileSize: number
    attribution: string
}>

type FlowMapStyle = Readonly<{
    version: 8
    sources: Readonly<Record<string, RasterSource>>
    layers: readonly Readonly<{
        id: string
        type: 'raster' | 'background'
        source?: string
        paint: Readonly<Record<string, number | string>>
    }>[]
}>

type FlowMapConstructorOptions = Readonly<{
    style: FlowMapStyle
    center: readonly [number, number]
    zoom: number
    projection: 'mercator'
    maxZoom: number
    container: HTMLElement
    antialias: boolean
}>

type FlowMapApi = Readonly<{
    Map: new (options: FlowMapConstructorOptions) => FlowMap
    MercatorCoordinate: Readonly<{
        fromLngLat(lngLat: LngLat, altitude: number): Readonly<{
            x: number
            y: number
            z: number
        }>
    }>
}>

type FlowMapOptions = Readonly<{
    proof?: boolean
    center?: readonly [number, number]
    zoom?: number
}>

export type FlowViewport = Readonly<{ width: number; height: number }>
export type FlowCameraState = Readonly<{
    far: number
    near: number
    matrix: number[]
    centerHigh: number[]
    centerLow: number[]
    bounds: number[]
    zoom: number
    viewport: number[]
}>

type FlowMatrix = number[] | Float32Array
type IdentityMatrix = (destination?: Float32Array) => Float32Array
type TranslateMatrix = (
    matrix: FlowMatrix,
    translation: readonly number[],
    destination?: Float32Array
) => Float32Array
type PerspectiveMatrix = (
    fieldOfView: number,
    aspect: number,
    near: number,
    far: number,
    destination?: Float32Array
) => Float32Array
type ScaleMatrix = (
    matrix: FlowMatrix,
    scale: readonly number[],
    destination?: Float32Array
) => Float32Array
type RotateMatrix = (
    matrix: FlowMatrix,
    radians: number,
    destination?: Float32Array
) => Float32Array

const mapApi = globalThis.maplibregl ?? globalThis.mapboxgl
const underwaterTerrainMinElevation = -80.06899999999999 * 30

if (!mapApi) throw new Error('Map runtime failed to load for Flow Layer')

export const FLOW_MAP_DEFAULTS: Readonly<{
    center: readonly [number, number]
    zoom: number
    projection: 'mercator'
    maxZoom: number
}> = Object.freeze({
    center: Object.freeze([ 120.980697, 31.684162 ] as const),
    zoom: 9,
    projection: 'mercator',
    maxZoom: 18,
})

export const darkMatterStyle: FlowMapStyle = Object.freeze({
    version: 8,
    sources: {
        cartoDarkMatter: {
            type: 'raster' as const,
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
        type: 'raster' as const,
        source: 'cartoDarkMatter',
        paint: { 'raster-opacity': 0.92 },
    } ],
})

const flowProofStyle: FlowMapStyle = Object.freeze({
    version: 8,
    sources: {},
    layers: [ {
        id: 'flow-proof-background',
        type: 'background' as const,
        paint: { 'background-color': '#101418' },
    } ],
})

export function createFlowMap(canvas: HTMLCanvasElement, options: FlowMapOptions = {}): FlowMap {

    const { proof = false, ...mapOptions } = options
    canvas.style.pointerEvents = 'none'
    canvas.style.zIndex = '1'

    const mapContainer = document.createElement('div')
    mapContainer.id = 'map'
    document.body.appendChild(mapContainer)

    return new (mapApi as unknown as FlowMapApi).Map({
        style: proof ? flowProofStyle : darkMatterStyle,
        center: FLOW_MAP_DEFAULTS.center,
        zoom: FLOW_MAP_DEFAULTS.zoom,
        projection: FLOW_MAP_DEFAULTS.projection,
        maxZoom: FLOW_MAP_DEFAULTS.maxZoom,
        container: mapContainer,
        antialias: true,
        ...mapOptions,
    })
}

export function waitForFlowMap(map: FlowMap, signal: AbortSignal): Promise<FlowMap> {

    if (signal?.aborted) return Promise.reject(signal.reason)
    if (map.loaded()) return Promise.resolve(map)
    return new Promise<FlowMap>((resolve, reject) => {
        const onLoad = () => {
            signal?.removeEventListener('abort', onAbort)
            resolve(map)
        }
        const onAbort = () => {
            map.off('load', onLoad)
            reject(signal.reason)
        }
        map.once('load', onLoad)
        signal?.addEventListener('abort', onAbort, { once: true })
    })
}

export function readFlowCameraState(map: FlowMap, viewport: FlowViewport): FlowCameraState {

    const transform = map.transform
    const cameraPosition = transform.getCameraPosition()
    const mercatorCenter = (mapApi as unknown as FlowMapApi).MercatorCoordinate.fromLngLat(
        cameraPosition.lngLat,
        cameraPosition.altitude
    )
    const centerX = encodeFloatToDouble(mercatorCenter.x)
    const centerY = encodeFloatToDouble(mercatorCenter.y)
    const centerZ = encodeFloatToDouble(mercatorCenter.z)
    const centerHigh = [ centerX[0], centerY[0], centerZ[0] ]
    const centerLow = [ centerX[1], centerY[1], centerZ[1] ]
    const bounds = map.getBounds()
    const { far, near, matrix } = getScratchMercatorMatrix(transform)

    return Object.freeze({
        far,
        near,
        matrix: Array.from((mat4.translate as TranslateMatrix)(matrix, centerHigh)),
        centerHigh,
        centerLow,
        bounds: [ bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth() ],
        zoom: map.getZoom(),
        viewport: [ viewport.width, viewport.height ],
    })
}

function getScratchMercatorMatrix(transform: FlowMapTransform): Readonly<{
    far: number
    near: number
    matrix: Float32Array
}> {

    if (!transform.height || !transform.mercatorMatrix) {
        return {
            far: transform.farZ,
            near: transform.nearZ,
            matrix: Float32Array.from(
                transform.mercatorMatrix ?? (mat4.identity as IdentityMatrix)()
            ),
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

    let matrix = (mat4.perspective as PerspectiveMatrix)(
        fov,
        transform.width / transform.height,
        near,
        far
    )
    matrix[8] = -offset.x * 2 / transform.width
    matrix[9] = offset.y * 2 / transform.height
    mat4.scale(matrix, [ 1, -1, 1 ], matrix)
    mat4.translate(matrix, [ 0, 0, -cameraToCenterDistance ], matrix)
    mat4.rotateX(matrix, pitch, matrix)
    mat4.rotateZ(matrix, angle, matrix)
    mat4.translate(matrix, [ -point.x, -point.y, 0 ], matrix)
    matrix = (mat4.scale as ScaleMatrix)(
        matrix,
        [ transform.worldSize, transform.worldSize, transform.worldSize ]
    )

    return { far, near, matrix: Float32Array.from(matrix) }
}

function calculateFarZForTerrainPlane(transform: FlowMapTransform, minElevation: number): number {

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

function getCameraToCenterDistance(transform: FlowMapTransform, fov: number): number {

    return getFiniteNumber(
        transform.cameraToCenterDistance,
        0.5 / Math.tan(fov / 2) * transform.height
    )
}

function getPixelPerMeter(transform: FlowMapTransform): number {

    return getFiniteNumber(
        transform._pixelPerMeter,
        transform.pixelsPerMeter,
        mercatorZfromAltitude(1, transform.center.lat) * transform.worldSize
    )
}

function radiansFromTransformValue(privateRadians: number, publicDegrees: number): number {

    return Number.isFinite(privateRadians) ? privateRadians : publicDegrees * Math.PI / 180
}

function getFiniteNumber(...values: readonly number[]): number {

    return values.find(value => Number.isFinite(value)) as number
}

function clamp(value: number, min: number, max: number): number {

    return Math.min(Math.max(value, min), max)
}

function circumferenceAtLatitude(latitude: number): number {

    const earthRadius = 6371008.8
    return 2 * Math.PI * earthRadius * Math.cos(latitude * Math.PI / 180)
}

function mercatorZfromAltitude(altitude: number, latitude: number): number {

    return altitude / circumferenceAtLatitude(latitude)
}

function encodeFloatToDouble(value: number): [number, number] {

    const high = Math.fround(value)
    return [ high, value - high ]
}
