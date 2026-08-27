import { mapLibrePlanarViewAdapter } from 'geoscratch/geo'
import type {
    MapLibreFrameMap,
    MapLibreLngLat,
    MapLibreMercatorCoordinate,
    MapLibrePlanarMap,
} from 'geoscratch/geo'

type RasterSource = Readonly<{
    type: 'raster'
    tiles: readonly string[]
    tileSize: number
    attribution: string
}>

type MapStyle = Readonly<{
    version: 8
    sources: Readonly<Record<string, RasterSource>>
    layers: readonly Readonly<{
        id: string
        type: 'raster' | 'background'
        source?: string
        paint: Readonly<Record<string, number | string>>
    }>[]
}>

export type FlowFieldMap = MapLibrePlanarMap & MapLibreFrameMap & Readonly<{
    jumpTo(options: {
        center?: readonly [number, number]
        zoom?: number
        pitch?: number
        bearing?: number
    }): void
    remove(): void
}>

type MapApi = Readonly<{
    Map: new (options: Readonly<{
        style: MapStyle
        center: readonly [number, number]
        zoom: number
        projection: 'mercator'
        maxZoom: number
        maxPitch: number
        container: HTMLElement
        antialias: boolean
    }>) => FlowFieldMap
    MercatorCoordinate: Readonly<{
        fromLngLat(
            lngLat: MapLibreLngLat,
            altitude: number
        ): MapLibreMercatorCoordinate
    }>
}>

export type FlowFieldMapOptions = Readonly<{
    proof?: boolean
    center?: readonly [number, number]
    zoom?: number
}>

export const FLOW_FIELD_IDENTITY = 'Flow Field'

export const FLOW_FIELD_MAP_DEFAULTS = Object.freeze({
    center: Object.freeze([ 120.980697, 31.684162 ] as const),
    zoom: 9,
    projection: 'mercator' as const,
    maxZoom: 18,
    maxPitch: 85,
})

const darkMatterStyle: MapStyle = Object.freeze({
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
        id: 'flow-field-carto-dark-matter',
        type: 'raster' as const,
        source: 'cartoDarkMatter',
        paint: { 'raster-opacity': 0.92 },
    } ],
})

const proofStyle: MapStyle = Object.freeze({
    version: 8,
    sources: {},
    layers: [ {
        id: 'flow-field-proof-background',
        type: 'background' as const,
        paint: { 'background-color': '#101418' },
    } ],
})

export const flowFieldViewAdapter = mapLibrePlanarViewAdapter({
    id: 'flow-field-maplibre-view-adapter',
    viewId: 'flow-field-map-view',
    mercatorCoordinateFromLngLat: (lngLat, altitude) =>
        requireMapApi().MercatorCoordinate.fromLngLat(lngLat, altitude),
})

/** Creates the external MapLibre host used by the independent Flow Field example. */
export function createFlowFieldMap(
    canvas: HTMLCanvasElement,
    options: FlowFieldMapOptions = {}
): FlowFieldMap {

    const mapApi = requireMapApi()
    const { proof = false, ...camera } = options
    canvas.style.pointerEvents = 'none'
    canvas.style.zIndex = '1'

    const container = document.createElement('div')
    container.id = 'map'
    document.body.appendChild(container)

    return new mapApi.Map({
        style: proof ? proofStyle : darkMatterStyle,
        center: FLOW_FIELD_MAP_DEFAULTS.center,
        zoom: FLOW_FIELD_MAP_DEFAULTS.zoom,
        projection: FLOW_FIELD_MAP_DEFAULTS.projection,
        maxZoom: FLOW_FIELD_MAP_DEFAULTS.maxZoom,
        maxPitch: FLOW_FIELD_MAP_DEFAULTS.maxPitch,
        container,
        antialias: true,
        ...camera,
    })
}

function requireMapApi(): MapApi {

    const globals = globalThis as unknown as Readonly<{
        maplibregl?: MapApi
        mapboxgl?: MapApi
    }>
    const mapApi = globals.maplibregl ?? globals.mapboxgl
    if (mapApi === undefined) {
        throw new Error(`Map runtime failed to load for ${FLOW_FIELD_IDENTITY}`)
    }
    return mapApi
}
