import * as scr from 'geoscratch'
import TerrainLayer from './terrainLayer.js'
import SteadyFlowLayer from './steadyFlowLayer.js'

const mapApi = globalThis.maplibregl ?? globalThis.mapboxgl

if (!mapApi) {
    throw new Error('Map runtime failed to load for examples/m_demLayer')
}

const rasterStyle = {
    version: 8,
    sources: {
        osm: {
            type: 'raster',
            tiles: [
                'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',
                'https://b.tile.openstreetmap.org/{z}/{x}/{y}.png',
                'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png',
            ],
            tileSize: 256,
            attribution: 'OpenStreetMap contributors',
        },
    },
    layers: [
        {
            id: 'osm',
            type: 'raster',
            source: 'osm',
        },
    ],
}

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
        style: rasterStyle,
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
class ScratchMap extends mapApi.Map {

    constructor(options) {

        // Init map runtime
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

        const cameraPosition = this.transform.getCameraPosition()
        this.mercatorCenter = mapApi.MercatorCoordinate.fromLngLat(cameraPosition.lngLat, cameraPosition.altitude)
        this.zoom.n = this.getZoom()

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

        this.far.n = this.transform.farZ
        this.near.n = this.transform.nearZ
        this.uMatrix.data = Float32Array.from(this.transform.mercatorMatrix)
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
function encodeFloatToDouble(value) {
    const result = new Float32Array(2);
    result[0] = value;
    
    const delta = value - result[0];
    result[1] = delta;
    return result;
}
