import { expect } from 'chai'
import fs from 'node:fs'
import path from 'node:path'
import {
    FLOW_FIELD_IDENTITY,
    FLOW_FIELD_MAP_DEFAULTS,
    createFlowFieldMap,
    flowFieldViewAdapter,
} from '../examples/flowField/map.ts'

const root = process.cwd()

function installMapEnvironment() {

    const appended = []
    let constructed
    class Map {

        constructor(options) {

            this.options = options
            constructed = this
        }
    }
    globalThis.document = {
        createElement(tagName) {

            return { tagName, id: '' }
        },
        body: {
            appendChild(element) { appended.push(element) },
        },
    }
    globalThis.maplibregl = {
        Map,
        MercatorCoordinate: {
            fromLngLat(lngLat, altitude) {

                return { x: lngLat.lng, y: lngLat.lat, z: altitude }
            },
        },
    }
    return {
        appended,
        constructed: () => constructed,
    }
}

function removeMapEnvironment() {

    delete globalThis.document
    delete globalThis.maplibregl
    delete globalThis.mapboxgl
}

describe('Flow Field map', () => {

    afterEach(removeMapEnvironment)

    it('owns the exact Flow Field identity and reviewed default camera', () => {

        expect(FLOW_FIELD_IDENTITY).to.equal('Flow Field')
        expect(FLOW_FIELD_MAP_DEFAULTS).to.deep.equal({
            center: [ 120.980697, 31.684162 ],
            zoom: 9,
            projection: 'mercator',
            maxZoom: 18,
            maxPitch: 85,
        })
        expect(Object.isFrozen(FLOW_FIELD_MAP_DEFAULTS)).to.equal(true)
        expect(Object.isFrozen(FLOW_FIELD_MAP_DEFAULTS.center)).to.equal(true)
        expect(flowFieldViewAdapter).to.deep.include({
            kind: 'geo-view-adapter',
            id: 'flow-field-maplibre-view-adapter',
            viewId: 'flow-field-map-view',
        })
    })

    it('constructs the normal structural MapLibre host with the dark raster style', () => {

        const environment = installMapEnvironment()
        const canvas = { style: {} }
        const map = createFlowFieldMap(canvas)
        const options = environment.constructed().options

        expect(map).to.equal(environment.constructed())
        expect(options).to.deep.include({
            center: FLOW_FIELD_MAP_DEFAULTS.center,
            zoom: FLOW_FIELD_MAP_DEFAULTS.zoom,
            projection: FLOW_FIELD_MAP_DEFAULTS.projection,
            maxZoom: FLOW_FIELD_MAP_DEFAULTS.maxZoom,
            maxPitch: FLOW_FIELD_MAP_DEFAULTS.maxPitch,
            antialias: true,
        })
        expect(options.style).to.deep.include({ version: 8 })
        expect(options.style.sources.cartoDarkMatter).to.deep.include({
            type: 'raster',
            tileSize: 256,
            attribution: 'OpenStreetMap contributors, CARTO',
        })
        expect(options.style.layers[0]).to.deep.equal({
            id: 'flow-field-carto-dark-matter',
            type: 'raster',
            source: 'cartoDarkMatter',
            paint: { 'raster-opacity': 0.92 },
        })
        expect(canvas.style).to.deep.equal({ pointerEvents: 'none', zIndex: '1' })
        expect(environment.appended).to.have.length(1)
        expect(environment.appended[0]).to.deep.include({ tagName: 'div', id: 'map' })
        expect(options.container).to.equal(environment.appended[0])
    })

    it('uses a network-free deterministic proof style and permits explicit camera overrides', () => {

        const environment = installMapEnvironment()
        const center = [ 121.5, 31.2 ]
        createFlowFieldMap({ style: {} }, { proof: true, center, zoom: 8 })
        const options = environment.constructed().options

        expect(options.center).to.equal(center)
        expect(options.zoom).to.equal(8)
        expect(options.style.sources).to.deep.equal({})
        expect(options.style.layers).to.deep.equal([ {
            id: 'flow-field-proof-background',
            type: 'background',
            paint: { 'background-color': '#101418' },
        } ])
    })

    it('reports the Flow Field identity when the external map runtime is unavailable', () => {

        globalThis.document = {
            createElement: () => ({ id: '' }),
            body: { appendChild() {} },
        }

        expect(() => createFlowFieldMap({ style: {} }))
            .to.throw('Map runtime failed to load for Flow Field')
    })

    it('uses only the public planar adapter and owns no local frame authority', () => {

        const source = fs.readFileSync(
            path.join(root, 'examples', 'flowField', 'map.ts'),
            'utf8'
        )

        expect(source).to.include("from 'geoscratch/geo'")
        expect(source).to.include('mapLibrePlanarViewAdapter({')
        expect(source).to.not.match(/flowLayer|examples\/flowLayer/)
        expect(source).to.not.match(/createGeoFrameController|mapLibreFrameDriver|frameController/)
        expect(source).to.not.match(/packages\/geoscratch\/src|runtime\.(?:device|queue)/)
        expect(source).to.not.match(/\.loaded\(\)|\.once\(['"]load/)
    })
})
