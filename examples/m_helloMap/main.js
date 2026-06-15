import * as scr from '../../src/index.js'
import Hammer from 'hammerjs'
import earcut from 'earcut'
import tilebelt from '@mapbox/tilebelt'
import Protobuf from 'pbf'
import { VectorTile } from '@mapbox/vector-tile'
import axios from 'axios'
import mapTestShader from './shaders/test.wgsl?raw'

const MIN_ZOOM = 0
const MAX_ZOOM = 16
const TILE_SIZE = 512
const MAX_TILE_ZOOM = MAX_ZOOM
let startX = 0.
let startY = 0.
let tilesInView = []
const GPUFrame = document.getElementById('GPUFrame')
scr.StartDash().then(() => main(GPUFrame)) 

let uMatrix = scr.mat4f()
function inlineShader(name, code) {

    return scr.shader({ name, codeFunc: () => code })
}

function main(canvas) {
    const camera = {
        x: 0.,
        y: 0.,
        z: 0.,
        zoom: 0.,
    }
    function updateMatrix() {
    
        // Translate
        const cameraMat = scr.Mat4f.translation(scr.vec3f(camera.x, camera.y, camera.z))
    
        // Scale
        const zoomScale = 1. / Math.pow(2, camera.zoom)
        const widthScale = TILE_SIZE / canvas.width
        const heightScale = TILE_SIZE / canvas.height
        cameraMat.scale(scr.vec3f(zoomScale / widthScale, zoomScale / heightScale, zoomScale))
    
        // Update matrix
        uMatrix.data = scr.Mat4f.multiplication(scr.Mat4f.inverse(cameraMat)).data
    
        scr.director.tick()

        getTilesInView()
    }
    updateMatrix()
    
    //////////// Helpers
    function getNDCPosition(e, canvas) {
    
        // Handle mouse and touch events
        const [ x, y ] = [
            e.center?.x || e.clientX,
            e.center?.y || e.clientY,
        ]
    
        // Get canvas relative css position
        const rect = canvas.getBoundingClientRect()
        const cssX = x - rect.left
        const cssY = y - rect.top
    
        // Get normalized 0 to 1 position across and down canvas
        const normalizedX = cssX / canvas.clientWidth
        const normalizedY = cssY / canvas.clientHeight
    
        // Convert to NDC
        const ndcX = normalizedX * 2. - 1.
        const ndcY = 1. - normalizedY * 2.
    
        return [ ndcX, ndcY ]
    }
    
    // Interaction handlers
    const hammer = new Hammer(GPUFrame)
    hammer.get('pinch').set({ enable: true })
    hammer.get('pan').set({ direction: Hammer.DIRECTION_ALL })
    
    // Handle drag changes while mouse is still down
    const handleMove = (moveEvent) => {
    
        const [ x, y ] = getNDCPosition(moveEvent, GPUFrame)
    
        // Compute the previous position in world space
        const [ preX, preY ] = scr.vec4f(startX, startY, 0., 1.).transformFromMat4(scr.Mat4f.inverse(uMatrix)).xy
    
        // Compute the new position in world space
        const [ postX, postY ] = scr.vec4f(x, y, 0., 1.).transformFromMat4(scr.Mat4f.inverse(uMatrix)).xy
    
        // Move that amount, because how much the position changes depends on the zoom level
        const deltaX = preX - postX
        const deltaY = preY - postY
        if (isNaN(deltaX) || isNaN(deltaY)) return // Abort
    
        // Only update within world limits
        camera.x += deltaX
        camera.y += deltaY
    
        // Save current pos for next movement
        startX = x
        startY = y
    
        // Update matrix with new camera and redraw scene
        updateMatrix()
    }
    
    const handlePan = (startEvent) => {
    
        // Get position of initial drag
        const [ sX, sY ] = getNDCPosition(startEvent, GPUFrame)
        startX = sX
        startY = sY
        GPUFrame.style.cursor = 'grabbing'
    
        window.addEventListener('mousemove', handleMove)
        hammer.on('pan', handleMove)
    
        // Clear on release
        const clear = (event) => {
            GPUFrame.style.cursor = 'grab'
            window.removeEventListener('mousemove', handleMove)
            window.removeEventListener('mouseup', clear)
            hammer.off('pan', handleMove)
            hammer.off('panend', clear)
        }
        window.addEventListener('mouseup', clear)
        hammer.on('panend', clear)
    }
    hammer.on('panstart', handlePan)
    window.addEventListener('mousedown', handlePan)
    
    // Handle zoom events
    const handleZoom = (wheelEvent) => {

        wheelEvent.preventDefault()
        const [ x, y ] = getNDCPosition(wheelEvent, GPUFrame)
    
        // Get position before zooming
        const [ preZoomX, preZoomY ] = scr.vec4f(x, y, 0., 1.).transformFromMat4(scr.Mat4f.inverse(uMatrix)).xy
    
        // Update current zoom state
        const zoomDelta = -wheelEvent.deltaY * (1. / 300.)
        camera.zoom += zoomDelta
        camera.zoom = Math.max(MIN_ZOOM, Math.min(camera.zoom, MAX_ZOOM))
        updateMatrix()
    
        // Get new position after zooming
        const [ postZoomX, postZoomY ] = scr.vec4f(x, y, 0., 1.).transformFromMat4(scr.Mat4f.inverse(uMatrix)).xy
    
        // Camera needs to be translated the difference of before and after
        camera.x += preZoomX - postZoomX
        camera.y += preZoomY - postZoomY
        updateMatrix()
    }
    hammer.on('pinch', handleZoom)
    GPUFrame.addEventListener('wheel', handleZoom)

    // Tile //////
    function getBounds() {
        
        const zoomScale = Math.pow(2, camera.zoom)

        // Undo NDC
        const px = (1. + camera.x) / 2.
        const py = (1. - camera.y) / 2.

        // Get world coord in px
        const wx = px * TILE_SIZE
        const wy = py * TILE_SIZE

        // Get zoom px
        const zx = wx * zoomScale
        const zy = wy * zoomScale

        // Get bottom-left and top-right pixels
        let x1 = zx - (GPUFrame.width / 2.)
        let y1 = zy + (GPUFrame.height / 2.)
        let x2 = zx + (GPUFrame.width / 2.)
        let y2 = zy - (GPUFrame.height / 2.)

        // Convert to world coords
        x1 = x1 / zoomScale / TILE_SIZE
        y1 = y1 / zoomScale / TILE_SIZE
        x2 = x2 / zoomScale / TILE_SIZE
        y2 = y2 / zoomScale / TILE_SIZE
        
        // Get Lon/Lat bounding box
        const bbox = [
            Math.max(scr.MercatorCoordinate.lonFromMercatorX(x1), -180.),
            Math.max(scr.MercatorCoordinate.latFromMercatorY(y1), -85.05),
            Math.min(scr.MercatorCoordinate.lonFromMercatorX(x2), 180.),
            Math.min(scr.MercatorCoordinate.latFromMercatorY(y2), 85.05),
        ]

        return bbox
    }


    function getTilesInView() {

        // Get bbox from viewport
        const bbox = getBounds()

        // Find min and max tiles
        const z = Math.min(Math.trunc(camera.zoom), MAX_TILE_ZOOM)
        const minTile = tilebelt.pointToTile(bbox[0], bbox[3], z) // top-left
        const maxTile = tilebelt.pointToTile(bbox[2], bbox[1], z) // bottom-right

        // Tiles visible in viewport
        tilesInView = []
        const [ minX, maxX ] = [ Math.max(minTile[0], 0), maxTile[0] ]
        const [ minY, maxY ] = [ Math.max(minTile[1], 0), maxTile[1] ]
        for (let x = minX; x <= maxX; x++) {
            for (let y = minY; y <= maxY; y++) {

                tilesInView.push([ x, y, z ])
            }
        }
    }

    ///////////////////////////////////////////////////

    const screen = scr.screen({ canvas })

    const USA_BBOX = [
        [-126.03515625, 23.079731762449878],
        [-60.1171875, 23.079731762449878],
        [-60.1171875, 50.233151832472245],
        [-126.03515625, 50.233151832472245]
    ]
    const [ nw_x, nw_y ] = scr.MercatorCoordinate.toNDC(scr.MercatorCoordinate.fromLonLat(USA_BBOX[0]))
    const [ ne_x, ne_y ] = scr.MercatorCoordinate.toNDC(scr.MercatorCoordinate.fromLonLat(USA_BBOX[1]))
    const [ se_x, se_y ] = scr.MercatorCoordinate.toNDC(scr.MercatorCoordinate.fromLonLat(USA_BBOX[2]))
    const [ sw_x, sw_y ] = scr.MercatorCoordinate.toNDC(scr.MercatorCoordinate.fromLonLat(USA_BBOX[3]))
    const positions = [
        sw_x, sw_y,
        nw_x, nw_y,
        se_x, se_y,
        ne_x, ne_y
    ]
    const positionRef = scr.aRef(new Float32Array(positions), 'USA_BBOX')

    // Convert a GeoJSON geometry to webgl vertices
    const geometryToVertices = (geometry) => {
        const verticesFromPolygon = (coordinates, n) => {
          const data = earcut.flatten(coordinates)
          const triangles = earcut(data.vertices, data.holes, 2)
      
          const vertices = new Float32Array(triangles.length * 2)
          for (let i = 0; i < triangles.length; i++) {
            const point = triangles[i]
            const lng = data.vertices[point * 2]
            const lat = data.vertices[point * 2 + 1]
            const [x, y] = scr.MercatorCoordinate.toNDC(scr.MercatorCoordinate.fromLonLat([lng, lat]))
            vertices[i * 2] = x
            vertices[i * 2 + 1] = y
          }
          return vertices
        }
      
        if (geometry.type === 'Polygon') {
          return verticesFromPolygon(geometry.coordinates)
        }
      
        // concat all vertices from each polygon
        if (geometry.type === 'MultiPolygon') {
          const positions = []
          geometry.coordinates.forEach((polygon, i) => {
            positions.push(...verticesFromPolygon([polygon[0]], i))
          })
          return Float32Array.from(positions)
        }
      
        // only support Polygon & Multipolygon for now
        return new Float32Array()
      }

    async function init() {

        // const [ x, y, z ] = tilesInView[0]
        // const res = await axios.get(`https://maps.ckochis.com/data/v3/${z}/${x}/${y}.pbf?apiKey=${config('mapsApiKey')}`, {
        //   responseType: 'arraybuffer',
        // })
        // const pbf = new Protobuf(res.data)
        // const vectorTile = new VectorTile(pbf)
        // console.log(vectorTile)

        // Buffer-related resource
        const geoJsonResource = await fetch('/json/examples/map/washington.geojson').then(async response => { return await response.text() })
        const WASHINGTON = JSON.parse(geoJsonResource)
        const vertices = geometryToVertices(WASHINGTON)
    
        const vertexBuffer_pos = scr.vertexBuffer({
            name: 'VertexBuffer (USA POS)',
            resource: { arrayRef: scr.aRef(new Float32Array(vertices)), structure: [ { components: 2 } ] }
        })

        const tBinding = scr.binding({ 
            range: () => [ vertices.length / 2 ],
            vertices: [
                { buffer: vertexBuffer_pos }
            ],
            uniforms: [
                {
                    name: 'dynamicUniform',
                    dynamic: true,
                    map: {
                        uMatrix
                    }
                },
            ]
        })
    
        const tPipeline = scr.renderPipeline({
            shader: { module: inlineShader('Shader (Map test)', mapTestShader) },
        })
    
        const mapPass = scr.renderPass({
            colorAttachments: [ { colorResource: screen } ]
        }).add(tPipeline, tBinding)
    
        // Stage
        scr.director.addStage({
            name: 'HelloMap',
            items: [ mapPass ],
        })
    }

    init()
}
