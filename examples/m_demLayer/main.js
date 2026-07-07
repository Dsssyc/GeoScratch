import * as scr from 'geoscratch'
import TerrainLayer from './terrainLayer.js'
import SteadyFlowLayer from './steadyFlowLayer.js'

const mapboxAccessToken =
    import.meta.env?.VITE_MAPBOX_ACCESS_TOKEN ?? globalThis.GEOSCRATCH_MAPBOX_ACCESS_TOKEN

if (!mapboxAccessToken) {
    throw new Error('Set VITE_MAPBOX_ACCESS_TOKEN to run examples/m_demLayer')
}

mapboxgl.accessToken = mapboxAccessToken

// DOM Configuration //////////////////////////////////////////////////////////////////////////////////////////////////////
const GPUFrame = document.getElementById('GPUFrame')
GPUFrame.style.pointerEvents = 'none'
GPUFrame.style.zIndex = '1'

const mapDiv = document.createElement('div')
mapDiv.style.height = '100%'
mapDiv.style.width = '100%'
mapDiv.style.zIndex = '0'
mapDiv.id = 'map'
document.body.appendChild(mapDiv)

// StartDash //////////////////////////////////////////////////////////////////////////////////////////////////////
scr.StartDash().then(() => {

    const map = new ScratchMap({
        style: "mapbox://styles/ycsoku/cldjl0d2m000501qlpmmex490",
        center: [ 120.980697, 31.684162 ],
        projection: 'mercator',
        GPUFrame: GPUFrame,
        container: 'map',
        antialias: true,
        maxZoom: 18,
        zoom: 9,
    }).on('load', () => {
        
        map.addLayer(new TerrainLayer(14))
        map.addLayer(new SteadyFlowLayer())
    })
})

// Map //////////////////////////////////////////////////////////////////////////////////////////////////////
class ScratchMap extends mapboxgl.Map {

    constructor(options) {

        // Init mapbox map
        super(options)

        // Attributes
        this.far = scr.f32()
        this.near = scr.f32()
        this.uMatrix = scr.mat4f()
        this.centerLow = scr.vec3f()
        this.centerHigh = scr.vec3f()
        this.mercatorCenter = scr.vec3f()
        this.zoom = scr.f32(this.getZoom())
        this.mercatorBounds = new scr.BoundingBox2D()
        this.cameraBounds = new scr.BoundingBox2D(...this.getBounds().toArray())
        
        // Buffer-related resource (based on map status)
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

        // Texture-related resource
        this.screen = scr.screen({ canvas: options.GPUFrame, alphaMode: 'premultiplied'})
        this.depthTexture = this.screen.createScreenDependentTexture('Texture (Map Common Depth)', 'depth32float')

        // Pass
        this.outputPass = scr.renderPass({
            name: 'Render Pass (Scratch map)',
            colorAttachments: [ { colorResource: this.screen } ],
            depthStencilAttachment: { depthStencilResource: this.depthTexture }
        })
        
        // Make stages
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

        this.mercatorCenter = new mapboxgl.MercatorCoordinate(...this.transform._computeCameraPosition().slice(0, 3))
        this.zoom.n = this.getZoom()
        
        const { far, near, matrix} = getMercatorMatrix(this.transform.clone())
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

// Helpers //////////////////////////////////////////////////////////////////////////////////////////////////////
function getMercatorMatrix(t) {
    
    if (!t.height) return;

    const offset = t.centerOffset;

    // Z-axis uses pixel coordinates when globe mode is enabled
    const pixelsPerMeter = t.pixelsPerMeter;

    if (t.projection.name === 'globe') {
        t._mercatorScaleRatio = mercatorZfromAltitude(1, t.center.lat) / mercatorZfromAltitude(1, GLOBE_SCALE_MATCH_LATITUDE);
    }

    const projectionT = getProjectionInterpolationT(t.projection, t.zoom, t.width, t.height, 1024);

    // 'this._pixelsPerMercatorPixel' is the ratio between pixelsPerMeter in the current projection relative to Mercator.
    // This is useful for converting e.g. camera position between pixel spaces as some logic
    // such as raycasting expects the scale to be in mercator pixels
    t._pixelsPerMercatorPixel = t.projection.pixelSpaceConversion(t.center.lat, t.worldSize, projectionT);

    t.cameraToCenterDistance = 0.5 / Math.tan(t._fov * 0.5) * t.height * t._pixelsPerMercatorPixel;

    t._updateCameraState();

    // t._farZ = t.projection.farthestPixelDistance(t);
    t._farZ = farthestPixelDistanceOnPlane(t, -80.06899999999999 * 30.0, pixelsPerMeter)
    // console.log(t._farZ, t.projection.farthestPixelDistance(t))

    // The larger the value of nearZ is
    // - the more depth precision is available for features (good)
    // - clipping starts appearing sooner when the camera is close to 3d features (bad)
    //
    // Smaller values worked well for mapbox-gl-js but deckgl was encountering precision issues
    // when rendering it's layers using custom layers. This value was experimentally chosen and
    // seems to solve z-fighting issues in deckgl while not clipping buildings too close to the camera.
    t._nearZ = t.height / 50;

    let _farZ = Math.max(Math.pow(2, t.tileZoom), 5000000.0)
    // let _farZ = Math.min(Math.pow(2, t.tileZoom + 5), 50000.0)
    // let _nearZ = Math.max(Math.pow(2, t.tileZoom - 8), 0.0)

    const zUnit = t.projection.zAxisUnit === "meters" ? pixelsPerMeter : 1.0;
    const worldToCamera = t._camera.getWorldToCamera(t.worldSize, zUnit);

    let cameraToClip;

    // Projection matrix
    const cameraToClipPerspective = t._camera.getCameraToClipPerspective(t._fov, t.width / t.height, t._nearZ, t._farZ) 
    // const cameraToClipPerspective = t._camera.getCameraToClipPerspective(t._fov, t.width / t.height, t._nearZ, _farZ) 
    // const cameraToClipPerspective = scr.mat4.perspective(t._fov, t.width / t.height, t._nearZ, t._farZ)
    // Apply offset/padding
    cameraToClipPerspective[8] = -offset.x * 2 / t.width;
    cameraToClipPerspective[9] = offset.y * 2 / t.height;

    if (t.isOrthographic) {
        const cameraToCenterDistance =  0.5 * t.height / Math.tan(t._fov / 2.0) * 1.0;

        // Calculate bounds for orthographic view
        let top = cameraToCenterDistance * Math.tan(t._fov * 0.5);
        let right = top * t.aspect;
        let left = -right;
        let bottom = -top;
        // Apply offset/padding
        right -= offset.x;
        left -= offset.x;
        top += offset.y;
        bottom += offset.y;

        cameraToClip = t._camera.getCameraToClipOrthographic(left, right, bottom, top, t._nearZ, _farZ);

        const mixValue =
        t.pitch >= OrthographicPitchTranstionValue ? 1.0 : t.pitch / OrthographicPitchTranstionValue;
        // lerpMatrix(cameraToClip, cameraToClip, cameraToClipPerspective, easeIn(mixValue));
    } else {
        cameraToClip = cameraToClipPerspective;
    }

    const worldToClipPerspective = scr.mat4.mul(cameraToClipPerspective, worldToCamera);
    let m = scr.mat4.mul(cameraToClip, worldToCamera);

    if (t.projection.isReprojectedInTileSpace) {
        // Projections undistort as you zoom in (shear, scale, rotate).
        // Apply the undistortion around the center of the map.
        const mc = t.locationCoordinate(t.center);
        const adjustments = scr.mat4.identity();
        scr.mat4.translate(adjustments, scr.vec3.fromValues(mc.x * t.worldSize, mc.y * t.worldSize, 0), adjustments);
        scr.mat4.multiply(adjustments, getProjectionAdjustments(t), adjustments);
        scr.mat4.translate(adjustments, [-mc.x * t.worldSize, -mc.y * t.worldSize, 0], adjustments);
        scr.mat4.multiply(m, adjustments, m);
        scr.mat4.multiply(worldToClipPerspective, adjustments, worldToClipPerspective);
        t.inverseAdjustmentMatrix = getProjectionAdjustmentInverted(t);
    } else {
        t.inverseAdjustmentMatrix = [1, 0, 0, 1];
    }

    // The mercatorMatrix can be used to transform points from mercator coordinates
    // ([0, 0] nw, [1, 1] se) to GL coordinates. / zUnit compensates for scaling done in worldToCamera.
    t.mercatorMatrix = scr.mat4.scale(m, scr.vec3.fromValues(t.worldSize, t.worldSize, t.worldSize / zUnit));
    t.projMatrix = m;

    // For tile cover calculation, use inverted of base (non elevated) matrix
    // as tile elevations are in tile coordinates and relative to center elevation.
    t.invProjMatrix = scr.mat4.invert(t.projMatrix);

    return {
        far: t._farZ,
        near: t._nearZ,
        matrix: t.mercatorMatrix,
    }
}
function smoothstep(e0, e1, x) {
    x = clamp((x - e0) / (e1 - e0), 0, 1);
    return x * x * (3 - 2 * x);
}
function encodeFloatToDouble(value) {
    const result = new Float32Array(2);
    result[0] = value;
    
    const delta = value - result[0];
    result[1] = delta;
    return result;
}
function circumferenceAtLatitude(latitude) {

    const earthRadius = 6371008.8
    const earthCircumference = 2 * Math.PI * earthRadius
    return earthCircumference * Math.cos(latitude * Math.PI / 180)
}
function mercatorZfromAltitude(altitude, lat) {
    return altitude / circumferenceAtLatitude(lat)
}
function farthestPixelDistanceOnPlane(tr, minElevation, pixelsPerMeter) {
    // Find the distance from the center point [width/2 + offset.x, height/2 + offset.y] to the
    // center top point [width/2 + offset.x, 0] in Z units, using the law of sines.
    // 1 Z unit is equivalent to 1 horizontal px at the center of the map
    // (the distance between[width/2, height/2] and [width/2 + 1, height/2])
    const fovAboveCenter = tr.fovAboveCenter;

    // Adjust distance to MSL by the minimum possible elevation visible on screen,
    // this way the far plane is pushed further in the case of negative elevation.
    const minElevationInPixels = minElevation * pixelsPerMeter;
    const cameraToSeaLevelDistance = ((tr._camera.position[2] * tr.worldSize) - minElevationInPixels) / Math.cos(tr._pitch);
    const topHalfSurfaceDistance = Math.sin(fovAboveCenter) * cameraToSeaLevelDistance / Math.sin(Math.max(Math.PI / 2.0 - tr._pitch - fovAboveCenter, 0.01));

    // Calculate z distance of the farthest fragment that should be rendered.
    const furthestDistance = Math.sin(tr._pitch) * topHalfSurfaceDistance + cameraToSeaLevelDistance;
    const horizonDistance = cameraToSeaLevelDistance * (1 / tr._horizonShift);

    // Add a bit extra to avoid precision problems when a fragment's distance is exactly `furthestDistance`
    return Math.min(furthestDistance * 1.01, horizonDistance);
}
function getProjectionInterpolationT(projection, zoom, width, height, maxSize = Infinity) {
    const range = projection.range;
    if (!range) return 0;

    const size = Math.min(maxSize, Math.max(width, height));
    // The interpolation ranges are manually defined based on what makes
    // sense in a 1024px wide map. Adjust the ranges to the current size
    // of the map. The smaller the map, the earlier you can start unskewing.
    const rangeAdjustment = Math.log(size / 1024) / Math.LN2;
    const zoomA = range[0] + rangeAdjustment;
    const zoomB = range[1] + rangeAdjustment;
    const t = smoothstep(zoomA, zoomB, zoom);
    return t;
}
