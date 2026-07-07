import * as scr from 'geoscratch'

const mapApi = globalThis.maplibregl ?? globalThis.mapboxgl

if (!mapApi) {
    throw new Error('Map runtime failed to load for map-backed examples')
}

const underwaterTerrainMinElevation = -80.06899999999999 * 30.0

export const darkMatterStyle = {
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
    layers: [
        {
            id: 'carto-dark-matter',
            type: 'raster',
            source: 'cartoDarkMatter',
            paint: {
                'raster-opacity': 0.92,
            },
        },
    ],
}

export async function startScratchMap(options, onLoad) {

    const GPUFrame = document.getElementById('GPUFrame')
    GPUFrame.style.pointerEvents = 'none'
    GPUFrame.style.zIndex = '1'

    const mapDiv = document.createElement('div')
    mapDiv.style.height = '100%'
    mapDiv.style.width = '100%'
    mapDiv.style.zIndex = '0'
    mapDiv.id = 'map'
    document.body.appendChild(mapDiv)

    await scr.StartDash()

    const map = new ScratchMap({
        style: darkMatterStyle,
        center: [ 120.980697, 31.684162 ],
        projection: 'mercator',
        GPUFrame: GPUFrame,
        container: 'map',
        antialias: true,
        maxZoom: 18,
        zoom: 9,
        ...options,
    })

    if (onLoad) {
        map.on('load', () => onLoad(map))
    }

    return map
}

export class ScratchMap extends mapApi.Map {

    constructor(options) {

        super(options)

        this.far = scr.f32()
        this.near = scr.f32()
        this.uMatrix = scr.mat4f()
        this.centerLow = scr.vec3f()
        this.centerHigh = scr.vec3f()
        this.mercatorCenter = scr.vec3f()
        this.zoom = scr.f32(this.getZoom())
        this.mercatorBounds = new scr.BoundingBox2D()
        this.cameraBounds = new scr.BoundingBox2D(...this.getBounds().toArray())
        
        this.dynamicUniformBuffer = scr.uniformBuffer({
            name: 'Uniform Buffer (Scratch map dynamic status)',
            blocks: [
                scr.bRef({
                    name: 'dynamicUniform',
                    dynamic: true,
                    map: {
                        far: this.far,
                        near: this.near,
                        uMatrix: this.uMatrix,
                        centerLow: this.centerLow,
                        centerHigh: this.centerHigh,
                    }
                }),
            ]
        })

        this.screen = scr.screen({ canvas: options.GPUFrame, alphaMode: 'premultiplied'})
        this.depthTexture = this.screen.createScreenDependentTexture('Texture (Map Common Depth)', 'depth32float')

        this.outputPass = scr.renderPass({
            name: 'Render Pass (Scratch map)',
            colorAttachments: [ { colorResource: this.screen } ],
            depthStencilAttachment: { depthStencilResource: this.depthTexture }
        })
        
        this.preProcessStageName = 'PreRendering'
        this.renderStageName = 'Rendering'
        scr.director.addStage({
            name: this.preProcessStageName,
            items: [],
        })
        scr.director.addStage({
            name: this.renderStageName,
            items: [ this.outputPass ],
        })

        this.on('render', () => {

            this.update()
            scr.director.tick()
        })
    }

    update() {

        const cameraPosition = this.transform.getCameraPosition()
        this.mercatorCenter = mapApi.MercatorCoordinate.fromLngLat(cameraPosition.lngLat, cameraPosition.altitude)
        this.zoom.n = this.getZoom()
        const { far, near, matrix } = getScratchMercatorMatrix(this.transform)

        const mercatorCenterX = encodeFloatToDouble(this.mercatorCenter.x)
        const mercatorCenterY = encodeFloatToDouble(this.mercatorCenter.y)
        const mercatorCenterZ = encodeFloatToDouble(this.mercatorCenter.z)

        this.centerHigh.x = mercatorCenterX[0]
        this.centerHigh.y = mercatorCenterY[0]
        this.centerHigh.z = mercatorCenterZ[0]
        this.centerLow.x = mercatorCenterX[1]
        this.centerLow.y = mercatorCenterY[1]
        this.centerLow.z = mercatorCenterZ[1]

        const { _sw, _ne } = this.getBounds()
        const m_sw = scr.MercatorCoordinate.fromLonLat(_sw.toArray())
        const m_ne = scr.MercatorCoordinate.fromLonLat(_ne.toArray())

        this.mercatorBounds.reset(...m_sw, ...m_ne)
        this.cameraBounds.reset(...this.getBounds().toArray().flat())

        this.far.n = far
        this.near.n = near
        this.uMatrix.data = matrix
        this.uMatrix.translate(scr.vec3f(mercatorCenterX[0], mercatorCenterY[0], mercatorCenterZ[0]))
    }

    add2PreProcess(prePass) {
        
        scr.director.addItem(this.preProcessStageName, prePass)
        return this
    }

    add2RenderPass(pipeline, binding) {

        this.outputPass.add(pipeline, binding)
        return this
    }
}

function getScratchMercatorMatrix(transform) {

    if (!transform.height || !transform.mercatorMatrix) {
        return {
            far: transform.farZ,
            near: transform.nearZ,
            matrix: Float32Array.from(transform.mercatorMatrix ?? scr.mat4.identity()),
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

    // Match MapLibre's Mercator custom-layer matrix, but lower the far-plane anchor for underwater DEM.
    let matrix = scr.mat4.perspective(fov, transform.width / transform.height, near, far)
    matrix[8] = -offset.x * 2 / transform.width
    matrix[9] = offset.y * 2 / transform.height

    scr.mat4.scale(matrix, [ 1, -1, 1 ], matrix)
    scr.mat4.translate(matrix, [ 0, 0, -cameraToCenterDistance ], matrix)
    scr.mat4.rotateX(matrix, pitch, matrix)
    scr.mat4.rotateZ(matrix, angle, matrix)
    scr.mat4.translate(matrix, [ -point.x, -point.y, 0 ], matrix)

    matrix = scr.mat4.scale(matrix, [ transform.worldSize, transform.worldSize, transform.worldSize ])

    return {
        far,
        near,
        matrix: Float32Array.from(matrix),
    }
}

function calculateFarZForTerrainPlane(transform, minElevation) {

    const fov = radiansFromTransformValue(transform._fov, transform.fov)
    const pitch = radiansFromTransformValue(transform._pitch, transform.pitch)
    const offset = transform.centerOffset ?? { x: 0, y: 0 }
    const pixelPerMeter = getPixelPerMeter(transform)
    const elevation = getFiniteNumber(transform.elevation, transform._elevation, 0)
    const currentTileMinElevation = getFiniteNumber(transform.minElevationForCurrentTile, elevation)
    const visibleMinElevation = Math.min(elevation, currentTileMinElevation, minElevation)
    const cameraToCenterDistance = getCameraToCenterDistance(transform, fov)

    const cameraToSeaLevelDistance = cameraToCenterDistance + elevation * pixelPerMeter / Math.cos(pitch)
    const cameraToLowestPointDistance = cameraToSeaLevelDistance - visibleMinElevation * pixelPerMeter / Math.cos(pitch)
    const lowestPlane = visibleMinElevation < 0 ? cameraToLowestPointDistance : cameraToSeaLevelDistance
    const groundAngle = Math.PI / 2 + pitch
    const fovAboveCenter = fov * (0.5 + offset.y / transform.height)
    const topHalfSurfaceDistance = Math.sin(fovAboveCenter) * lowestPlane / Math.sin(clamp(Math.PI - groundAngle - fovAboveCenter, 0.01, Math.PI - 0.01))
    const horizon = typeof transform.getHorizon === 'function' ? transform.getHorizon() : Infinity
    let topHalfSurfaceDistanceHorizon = Infinity

    if (Number.isFinite(horizon) && horizon > 0) {
        const horizonAngle = Math.atan(horizon / cameraToCenterDistance)
        const fovCenterToHorizon = 2 * horizonAngle * (0.5 + offset.y / (horizon * 2))
        topHalfSurfaceDistanceHorizon = Math.sin(fovCenterToHorizon) * lowestPlane / Math.sin(clamp(Math.PI - groundAngle - fovCenterToHorizon, 0.01, Math.PI - 0.01))
    }

    const topHalfMinDistance = Math.min(topHalfSurfaceDistance, topHalfSurfaceDistanceHorizon)
    return (Math.cos(Math.PI / 2 - pitch) * topHalfMinDistance + lowestPlane) * 1.01
}

function getCameraToCenterDistance(transform, fov) {

    return getFiniteNumber(
        transform.cameraToCenterDistance,
        0.5 / Math.tan(fov / 2) * transform.height
    )
}

function getPixelPerMeter(transform) {

    return getFiniteNumber(
        transform._pixelPerMeter,
        transform.pixelsPerMeter,
        mercatorZfromAltitude(1, transform.center.lat) * transform.worldSize
    )
}

function radiansFromTransformValue(privateRadians, publicDegrees) {

    return Number.isFinite(privateRadians) ? privateRadians : publicDegrees * Math.PI / 180
}

function getFiniteNumber(...values) {

    return values.find((value) => Number.isFinite(value))
}

function clamp(value, min, max) {

    return Math.min(Math.max(value, min), max)
}

function circumferenceAtLatitude(latitude) {

    const earthRadius = 6371008.8
    const earthCircumference = 2 * Math.PI * earthRadius
    return earthCircumference * Math.cos(latitude * Math.PI / 180)
}

function mercatorZfromAltitude(altitude, latitude) {

    return altitude / circumferenceAtLatitude(latitude)
}

function encodeFloatToDouble(value) {

    const result = new Float32Array(2)
    result[0] = value
    
    const delta = value - result[0]
    result[1] = delta
    return result
}
