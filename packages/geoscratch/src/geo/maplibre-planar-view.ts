import { mat4 } from 'wgpu-matrix'
import { throwGeoDiagnostic } from './diagnostics.js'
import {
    createGeoViewAdapter,
    createGeoViewSnapshot,
} from './geo-view.js'
import type {
    GeoViewAdapter,
    GeoViewSnapshotDescriptor,
} from './geo-view.js'
import {
    WEB_MERCATOR_QUAD_WORLD_WIDTH,
    WebMercatorQuad,
} from './web-mercator-quad.js'

type Vec3 = readonly [number, number, number]

export type MapLibreLngLat = Readonly<{
    lng: number
    lat: number
}>

export type MapLibreMercatorCoordinate = Readonly<{
    x: number
    y: number
    z: number
}>

type MapLibreCameraPosition = Readonly<{
    lngLat: MapLibreLngLat
    altitude: number
}>

type MapLibrePoint = Readonly<{
    x: number
    y: number
}>

export type MapLibrePlanarTransform = Readonly<{
    height: number
    width: number
    mercatorMatrix?: ArrayLike<number> | null
    farZ: number
    nearZ: number
    centerOffset?: MapLibrePoint | null
    point: MapLibrePoint
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
    center: Readonly<{ lat: number }>
    getCameraPosition(): MapLibreCameraPosition
    getHorizon?(): number
}>

export type MapLibrePlanarMap = Readonly<{
    transform: MapLibrePlanarTransform
    getZoom(): number
    getCenter(): MapLibreLngLat
    getPitch(): number
    getBearing(): number
}>

export type MapLibrePlanarViewport = Readonly<{
    width: number
    height: number
}>

export type MapLibrePlanarCameraInput = Readonly<{
    map: MapLibrePlanarMap
    viewport: MapLibrePlanarViewport
    minimumElevationMeters: number
}>

export type MapLibrePlanarCameraState = Omit<
    GeoViewSnapshotDescriptor,
    'id' | 'frameEpoch' | 'residencySnapshotEpoch'
> & Readonly<{
    far: number
    near: number
    center: readonly [number, number]
    pitchDegrees: number
    bearingDegrees: number
}>

export type MapLibrePlanarViewAdapterDescriptor = Readonly<{
    id: string
    viewId?: string
    mercatorCoordinateFromLngLat(
        lngLat: MapLibreLngLat,
        altitude: number
    ): MapLibreMercatorCoordinate
}>

export type MapLibrePlanarViewAdapter = GeoViewAdapter<MapLibrePlanarCameraState> & Readonly<{
    viewId: string
    camera(input: MapLibrePlanarCameraInput): MapLibrePlanarCameraState
}>

/** Adapts MapLibre-compatible camera state into precision-preserving planar Geo snapshots. */
export function mapLibrePlanarViewAdapter(
    descriptor: MapLibrePlanarViewAdapterDescriptor
): MapLibrePlanarViewAdapter {

    const id = descriptor?.id
    const viewId = descriptor?.viewId ?? `${id}.view`
    if (typeof id !== 'string' || id.length === 0 ||
        typeof viewId !== 'string' || viewId.length === 0 ||
        typeof descriptor?.mercatorCoordinateFromLngLat !== 'function') {
        return invalidMapLibreView(
            'A MapLibre planar view adapter requires stable adapter and view ids plus a Mercator coordinate converter.',
            {
                id: 'non-empty string',
                viewId: 'non-empty string',
                mercatorCoordinateFromLngLat: 'function',
            },
            descriptor
        )
    }
    const convert = descriptor.mercatorCoordinateFromLngLat
    const adapter = createGeoViewAdapter<MapLibrePlanarCameraState>({
        id,
        read(camera, context) {

            assertCamera(camera, id)
            return createGeoViewSnapshot({
                id: viewId,
                clipFromRelativeWorld: camera.clipFromRelativeWorld,
                cameraHigh: camera.cameraHigh,
                cameraLow: camera.cameraLow,
                viewport: camera.viewport,
                verticalFovRadians: camera.verticalFovRadians,
                cameraLatitudeRadians: camera.cameraLatitudeRadians,
                cameraPitchRadians: camera.cameraPitchRadians,
                zoomHint: camera.zoomHint,
                frameEpoch: context.frameEpoch,
                residencySnapshotEpoch: context.residencySnapshotEpoch,
            })
        },
    })
    return Object.freeze({
        ...adapter,
        viewId,
        camera: input => readMapLibrePlanarCamera(input, convert, id),
    })
}

function readMapLibrePlanarCamera(
    input: MapLibrePlanarCameraInput,
    convert: MapLibrePlanarViewAdapterDescriptor['mercatorCoordinateFromLngLat'],
    adapterId: string
): MapLibrePlanarCameraState {

    const map = input?.map
    const viewport = input?.viewport
    const minimumElevationMeters = input?.minimumElevationMeters
    if (map?.transform === undefined || typeof map.getZoom !== 'function' ||
        typeof map.getCenter !== 'function' || typeof map.getPitch !== 'function' ||
        typeof map.getBearing !== 'function' ||
        !positiveFinite(viewport?.width) || !positiveFinite(viewport?.height) ||
        !Number.isFinite(minimumElevationMeters)) {
        return invalidMapLibreView(
            'A MapLibre camera read requires a compatible map, positive viewport, and finite minimum elevation.',
            {
                map: 'MapLibre-compatible planar map',
                viewport: 'positive finite width and height',
                minimumElevationMeters: 'finite number',
            },
            input,
            adapterId
        )
    }
    const transform = map.transform
    const cameraPosition = transform.getCameraPosition()
    const mercatorCenter = convert(cameraPosition.lngLat, cameraPosition.altitude)
    if (![ mercatorCenter.x, mercatorCenter.y, mercatorCenter.z ].every(Number.isFinite)) {
        return invalidMapLibreView(
            'The MapLibre Mercator coordinate converter returned non-finite camera coordinates.',
            { coordinate: 'finite x, y, and z' },
            mercatorCenter,
            adapterId
        )
    }
    const projected = WebMercatorQuad.project([
        cameraPosition.lngLat.lng,
        cameraPosition.lngLat.lat,
    ])
    const cameraX = encodeFloatToDouble(projected[0])
    const cameraY = encodeFloatToDouble(projected[1])
    const cameraZ = encodeFloatToDouble(cameraPosition.altitude)
    const cameraHigh = Object.freeze([
        cameraX[0], cameraY[0], cameraZ[0],
    ]) as Vec3
    const cameraLow = Object.freeze([
        cameraX[1], cameraY[1], cameraZ[1],
    ]) as Vec3
    const matrixFacts = cameraRelativeMercatorMatrix(
        transform,
        minimumElevationMeters,
        mercatorCenter,
        cameraPosition.lngLat.lat
    )
    const verticalFovRadians = radiansFromTransformValue(transform._fov, transform.fov)
    const center = map.getCenter()
    const pitchDegrees = map.getPitch()
    const camera = Object.freeze({
        far: matrixFacts.far,
        near: matrixFacts.near,
        clipFromRelativeWorld: Object.freeze(Array.from(matrixFacts.matrix)),
        cameraHigh,
        cameraLow,
        viewport: Object.freeze([ viewport.width, viewport.height ]) as readonly [number, number],
        verticalFovRadians,
        cameraLatitudeRadians: cameraPosition.lngLat.lat * Math.PI / 180,
        cameraPitchRadians: pitchDegrees * Math.PI / 180,
        zoomHint: map.getZoom(),
        center: Object.freeze([ center.lng, center.lat ]) as readonly [number, number],
        pitchDegrees,
        bearingDegrees: map.getBearing(),
    })
    assertMapCamera(camera, adapterId)
    return camera
}

function cameraRelativeMercatorMatrix(
    transform: MapLibrePlanarTransform,
    minimumElevationMeters: number,
    cameraOrigin: MapLibreMercatorCoordinate,
    cameraLatitudeDegrees: number
) {

    if (!transform.height || !transform.mercatorMatrix) {
        const matrix = Float64Array.from(transform.mercatorMatrix ??
            mat4.identity(new Float64Array(16)))
        mat4.translate(matrix, [ cameraOrigin.x, cameraOrigin.y, cameraOrigin.z ], matrix)
        mat4.scale(matrix, [
            1 / WEB_MERCATOR_QUAD_WORLD_WIDTH,
            -1 / WEB_MERCATOR_QUAD_WORLD_WIDTH,
            mercatorZfromAltitude(1, cameraLatitudeDegrees),
        ], matrix)
        return {
            far: transform.farZ,
            near: transform.nearZ,
            matrix: Float32Array.from(matrix),
        }
    }

    const near = transform.height / 50
    const far = farZForTerrainPlane(transform, minimumElevationMeters)
    const offset = transform.centerOffset ?? { x: 0, y: 0 }
    const point = transform.point
    const fov = radiansFromTransformValue(transform._fov, transform.fov)
    const pitch = radiansFromTransformValue(transform._pitch, transform.pitch)
    const angle = radiansFromTransformValue(transform.angle, -transform.bearing)
    const cameraToCenterDistance = getCameraToCenterDistance(transform, fov)

    const matrix = mat4.perspective(
        fov,
        transform.width / transform.height,
        near,
        far,
        new Float64Array(16)
    )
    matrix[8] = -offset.x * 2 / transform.width
    matrix[9] = offset.y * 2 / transform.height
    mat4.scale(matrix, [ 1, -1, 1 ], matrix)
    mat4.translate(matrix, [ 0, 0, -cameraToCenterDistance ], matrix)
    mat4.rotateX(matrix, pitch, matrix)
    mat4.rotateZ(matrix, angle, matrix)
    mat4.translate(matrix, [
        cameraOrigin.x * transform.worldSize - point.x,
        cameraOrigin.y * transform.worldSize - point.y,
        cameraOrigin.z * transform.worldSize,
    ], matrix)
    mat4.scale(matrix, [
        transform.worldSize / WEB_MERCATOR_QUAD_WORLD_WIDTH,
        -transform.worldSize / WEB_MERCATOR_QUAD_WORLD_WIDTH,
        transform.worldSize * mercatorZfromAltitude(1, cameraLatitudeDegrees),
    ], matrix)

    return { far, near, matrix: Float32Array.from(matrix) }
}

function farZForTerrainPlane(transform: MapLibrePlanarTransform, minElevation: number) {

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

function getCameraToCenterDistance(transform: MapLibrePlanarTransform, fov: number) {

    return getFiniteNumber(
        transform.cameraToCenterDistance,
        0.5 / Math.tan(fov / 2) * transform.height
    )
}

function getPixelPerMeter(transform: MapLibrePlanarTransform) {

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

function clamp(value: number, minimum: number, maximum: number) {

    return Math.min(Math.max(value, minimum), maximum)
}

function circumferenceAtLatitude(latitude: number) {

    const earthRadius = 6371008.8
    return 2 * Math.PI * earthRadius * Math.cos(latitude * Math.PI / 180)
}

function mercatorZfromAltitude(altitude: number, latitude: number) {

    return altitude / circumferenceAtLatitude(latitude)
}

function encodeFloatToDouble(value: number): readonly [number, number] {

    const high = Math.fround(value)
    return Object.freeze([ high, value - high ])
}

function assertCamera(
    value: MapLibrePlanarCameraState,
    adapterId: string
): void {

    const values = [
        value?.zoomHint,
        value?.verticalFovRadians,
        value?.cameraLatitudeRadians,
        value?.cameraPitchRadians,
        ...Array.from(value?.clipFromRelativeWorld ?? []),
        ...Array.from(value?.cameraHigh ?? []),
        ...Array.from(value?.cameraLow ?? []),
        ...Array.from(value?.viewport ?? []),
    ]
    if (value === undefined || values.some(entry => !Number.isFinite(entry)) ||
        value.clipFromRelativeWorld.length !== 16 ||
        value.cameraHigh.length !== 3 || value.cameraLow.length !== 3 ||
        value.viewport.length !== 2 || value.viewport.some(entry => entry <= 0) ||
        value.verticalFovRadians <= 0 || value.verticalFovRadians >= Math.PI ||
        Math.abs(value.cameraLatitudeRadians) > Math.PI / 2 ||
        value.cameraPitchRadians < 0 || value.cameraPitchRadians > Math.PI / 2) {
        invalidMapLibreView(
            'A MapLibre planar camera contains incomplete or invalid projection facts.',
            {
                matrixLength: 16,
                cameraLength: 3,
                viewport: 'positive pair',
                pitchRadians: '[0, PI/2]',
            },
            value,
            adapterId
        )
    }
}

function assertMapCamera(value: MapLibrePlanarCameraState, adapterId: string): void {

    assertCamera(value, adapterId)
    if (![ value.far, value.near, value.pitchDegrees, value.bearingDegrees,
        ...Array.from(value.center ?? []) ].every(Number.isFinite) ||
        value.center.length !== 2 || value.near <= 0 || value.far <= value.near) {
        invalidMapLibreView(
            'A MapLibre camera contains invalid map-facing clip or orientation facts.',
            { clipPlanes: '0 < near < far', center: 'finite pair' },
            value,
            adapterId
        )
    }
}

function invalidMapLibreView(
    message: string,
    expected: unknown,
    actual: unknown,
    id?: string
): never {

    return throwGeoDiagnostic({
        code: 'GEO_VIEW_INVALID',
        phase: 'selection',
        subject: { kind: 'maplibre-planar-view', ...(id === undefined ? {} : { id }) },
        message,
        expected,
        actual,
    })
}

function positiveFinite(value: number | undefined): value is number {

    return Number.isFinite(value) && value! > 0
}
