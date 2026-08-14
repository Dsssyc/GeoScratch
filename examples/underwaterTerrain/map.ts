import {
    mapLibrePlanarViewAdapter,
} from 'geoscratch/geo'
import type {
    MapLibreLngLat,
    MapLibreMercatorCoordinate,
    MapLibrePlanarMap,
} from 'geoscratch/geo'

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

export type UnderwaterTerrainMap = MapLibrePlanarMap & Readonly<{
    loaded(): boolean
    once(event: 'load', listener: () => void): void
    off(event: 'render' | 'load', listener: () => void): void
    resize(): void
    on(event: 'render', listener: () => void): void
    jumpTo(options: {
        center?: readonly [number, number]
        zoom?: number
        pitch?: number
        bearing?: number
    }): void
    remove(): void
}>

type MapApi = {
    Map: new (options: {
        style: MapStyle
        center: readonly number[]
        zoom: number
        projection: string
        maxZoom: number
        maxPitch: number
        container: HTMLElement
        antialias: boolean
    }) => UnderwaterTerrainMap
    MercatorCoordinate: {
        fromLngLat(
            lngLat: MapLibreLngLat,
            altitude: number
        ): MapLibreMercatorCoordinate
    }
}

declare global {
    var maplibregl: MapApi | undefined
    var mapboxgl: MapApi | undefined
}

type UnderwaterTerrainMapOptions = Readonly<{
    proof?: boolean
}>

const UNDERWATER_TERRAIN_MAP_DEFAULTS = Object.freeze({
    center: Object.freeze([ 120.980697, 31.684162 ]),
    zoom: 9,
    projection: 'mercator',
    maxZoom: 18,
    maxPitch: 85,
})

const darkMatterStyle = Object.freeze({
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

const underwaterTerrainProofStyle = Object.freeze({
    version: 8,
    sources: {},
    layers: [ {
        id: 'underwater-terrain-proof-background',
        type: 'background',
        paint: { 'background-color': '#101418' },
    } ],
})

export const underwaterTerrainViewAdapter = mapLibrePlanarViewAdapter({
    id: 'underwater-terrain-maplibre-view-adapter',
    viewId: 'underwater-terrain-map-view',
    mercatorCoordinateFromLngLat: (lngLat, altitude) =>
        requireMapApi().MercatorCoordinate.fromLngLat(lngLat, altitude),
})

export function createUnderwaterTerrainMap(canvas: HTMLCanvasElement, options: UnderwaterTerrainMapOptions = {}) {

    const mapApi = requireMapApi()
    const { proof = false, ...mapOptions } = options
    canvas.style.pointerEvents = 'none'
    canvas.style.zIndex = '1'

    const mapContainer = document.createElement('div')
    mapContainer.id = 'map'
    document.body.appendChild(mapContainer)

    return new mapApi.Map({
        style: (proof ? underwaterTerrainProofStyle : darkMatterStyle) as MapStyle,
        center: UNDERWATER_TERRAIN_MAP_DEFAULTS.center,
        zoom: UNDERWATER_TERRAIN_MAP_DEFAULTS.zoom,
        projection: UNDERWATER_TERRAIN_MAP_DEFAULTS.projection,
        maxZoom: UNDERWATER_TERRAIN_MAP_DEFAULTS.maxZoom,
        maxPitch: UNDERWATER_TERRAIN_MAP_DEFAULTS.maxPitch,
        container: mapContainer,
        antialias: true,
        ...mapOptions,
    })
}

export function waitForUnderwaterTerrainMap(map: UnderwaterTerrainMap, signal?: AbortSignal): Promise<UnderwaterTerrainMap> {

    if (signal?.aborted) return Promise.reject(signal.reason)
    if (map.loaded()) return Promise.resolve(map)
    return new Promise<UnderwaterTerrainMap>((resolve, reject) => {
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

function requireMapApi(): MapApi {

    const mapApi = globalThis.maplibregl ?? globalThis.mapboxgl
    if (mapApi === undefined) throw new Error('Map runtime failed to load for Underwater Terrain')
    return mapApi
}
