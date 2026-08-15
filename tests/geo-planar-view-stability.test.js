import { expect } from 'chai'
import {
    WebMercatorQuad,
    mapLibrePlanarViewAdapter,
} from 'geoscratch/geo'

const EARTH_RADIUS_METERS = 6_371_008.8
const VIEWPORT = Object.freeze({ width: 1_280, height: 800 })
const ZOOM = 18
const WORLD_SIZE = 512 * 2 ** ZOOM
const CAMERA_FOV = 0.6435011087932844
const CAMERA_TO_CENTER_DISTANCE = 0.5 / Math.tan(CAMERA_FOV / 2) * VIEWPORT.height
const CENTER = Object.freeze([ 120.980697, 31.684162 ])
const TARGET = Object.freeze([ 120.980997, CENTER[1] ])

describe('Geo planar view stability', () => {

    let viewAdapter

    before(async() => {

        globalThis.maplibregl = {
            Map: class {},
            MercatorCoordinate: {
                fromLngLat(lngLat, altitude) {
                    return {
                        x: mercatorX(lngLat.lng),
                        y: mercatorY(lngLat.lat),
                        z: altitude / circumferenceAtLatitude(lngLat.lat),
                    }
                },
            },
        }
        viewAdapter = mapLibrePlanarViewAdapter({
            id: 'camera-stability-maplibre-view-adapter',
            viewId: 'camera-stability-map-view',
            mercatorCoordinateFromLngLat: globalThis.maplibregl.MercatorCoordinate.fromLngLat,
        })
    })

    after(() => {

        delete globalThis.maplibregl
    })

    it('keeps a fixed world point continuous across subpixel camera pans at z18', () => {

        const targetMeters = WebMercatorQuad.project(TARGET)
        const samples = []

        for (let index = 0; index <= 80; index++) {
            const center = [
                CENTER[0] + index * 0.05 * 360 / WORLD_SIZE,
                CENTER[1],
            ]
            const map = fakeMap(center)
            const camera = viewAdapter.camera({
                map,
                viewport: VIEWPORT,
                minimumElevationMeters: -100,
            })
            const cameraMeters = camera.cameraHigh.map(
                (high, axis) => high + camera.cameraLow[axis]
            )
            const clip = transformPoint(camera.clipFromRelativeWorld, [
                targetMeters[0] - cameraMeters[0],
                targetMeters[1] - cameraMeters[1],
                -cameraMeters[2],
                1,
            ])
            samples.push((clip[0] / clip[3] + 1) * VIEWPORT.width / 2)
        }

        const expectedFirst = VIEWPORT.width / 2 +
            (mercatorX(TARGET[0]) - mercatorX(CENTER[0])) * WORLD_SIZE
        expect(samples[0]).to.be.closeTo(expectedFirst, 0.001)
        for (let index = 1; index < samples.length; index++) {
            expect(samples[index] - samples[index - 1]).to.be.closeTo(-0.05, 0.001)
        }
    })

    it('adapts one map camera reading into an immutable epoch-bound Geo view', () => {

        const input = {
            map: fakeMap(CENTER),
            viewport: VIEWPORT,
            minimumElevationMeters: -100,
        }
        const camera = viewAdapter.camera(input)
        const view = viewAdapter.read(camera, {
            frameEpoch: 17,
            residencySnapshotEpoch: 9,
        })

        expect(view).to.deep.include({
            kind: 'geo-view-snapshot',
            id: 'camera-stability-map-view',
            frameEpoch: 17,
            residencySnapshotEpoch: 9,
            zoomHint: ZOOM,
        })
        expect(view.clipFromRelativeWorld).to.deep.equal(camera.clipFromRelativeWorld)
        expect(view.clipFromRelativeWorld).not.to.equal(camera.clipFromRelativeWorld)
        expect(Object.isFrozen(view)).to.equal(true)
    })
})

function fakeMap(center) {

    const circumference = circumferenceAtLatitude(center[1])
    const altitude = CAMERA_TO_CENTER_DISTANCE * circumference / WORLD_SIZE
    const centerX = mercatorX(center[0])
    const centerY = mercatorY(center[1])
    const lngLat = { lng: center[0], lat: center[1] }
    const transform = {
        height: VIEWPORT.height,
        width: VIEWPORT.width,
        mercatorMatrix: new Array(16).fill(0),
        farZ: 10_000,
        nearZ: VIEWPORT.height / 50,
        centerOffset: { x: 0, y: 0 },
        point: { x: centerX * WORLD_SIZE, y: centerY * WORLD_SIZE },
        _fov: CAMERA_FOV,
        fov: CAMERA_FOV * 180 / Math.PI,
        _pitch: 0,
        pitch: 0,
        angle: 0,
        bearing: 0,
        worldSize: WORLD_SIZE,
        elevation: 0,
        minElevationForCurrentTile: 0,
        cameraToCenterDistance: CAMERA_TO_CENTER_DISTANCE,
        pixelsPerMeter: WORLD_SIZE / circumference,
        center: { lat: center[1] },
        getCameraPosition: () => ({ lngLat, altitude }),
        getHorizon: () => Infinity,
    }

    return {
        transform,
        getZoom: () => ZOOM,
        getCenter: () => lngLat,
        getPitch: () => 0,
        getBearing: () => 0,
    }
}

function mercatorX(longitude) {

    return (longitude + 180) / 360
}

function mercatorY(latitude) {

    const radians = latitude * Math.PI / 180
    return (1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2
}

function circumferenceAtLatitude(latitude) {

    return 2 * Math.PI * EARTH_RADIUS_METERS * Math.cos(latitude * Math.PI / 180)
}

function transformPoint(matrix, vector) {

    return [
        matrix[0] * vector[0] + matrix[4] * vector[1] +
            matrix[8] * vector[2] + matrix[12] * vector[3],
        matrix[1] * vector[0] + matrix[5] * vector[1] +
            matrix[9] * vector[2] + matrix[13] * vector[3],
        matrix[2] * vector[0] + matrix[6] * vector[1] +
            matrix[10] * vector[2] + matrix[14] * vector[3],
        matrix[3] * vector[0] + matrix[7] * vector[1] +
            matrix[11] * vector[2] + matrix[15] * vector[3],
    ]
}
