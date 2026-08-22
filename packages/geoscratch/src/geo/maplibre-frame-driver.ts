import { throwGeoDiagnostic } from './diagnostics.js'
import type {
    GeoFrameCapture,
    GeoFrameDriver,
    GeoFrameScheduler,
} from './frame-controller.js'

type MapLibreFrameEvent = 'move' | 'resize' | 'style.load'

/** No-draw custom-layer shape used only to enter a MapLibre render frame. */
export type MapLibreFrameLayer = Readonly<{
    id: string
    type: 'custom'
    renderingMode: '2d'
    render(...arguments_: unknown[]): void
}>

/** MapLibre-compatible style readiness and host methods required by the frame driver. */
export type MapLibreFrameMap = Readonly<{
    on(event: MapLibreFrameEvent, listener: () => void): void
    off(event: MapLibreFrameEvent, listener: () => void): void
    isStyleLoaded(): boolean
    addLayer(layer: MapLibreFrameLayer): unknown
    removeLayer(id: string): unknown
    getLayer(id: string): unknown
    triggerRepaint(): void
}>

/** Map host, stable layer id, and application capture read by a MapLibre driver. */
export type MapLibreFrameDriverDescriptor<Capture> = Readonly<{
    id: string
    map: MapLibreFrameMap
    capture(): Capture
}>

/** Geo frame driver synchronized to a MapLibre-compatible custom-layer callback. */
export type MapLibreFrameDriver<Capture> = GeoFrameDriver<Capture>

type DriverState = 'idle' | 'running' | 'stopped'

/** Creates a readiness-aware no-draw MapLibre custom-layer driver with revisioned capture. */
export function mapLibreFrameDriver<Capture>(
    descriptor: MapLibreFrameDriverDescriptor<Capture>
): MapLibreFrameDriver<Capture> {

    const validated = validateDescriptor(descriptor)
    const { id, map, readCapture } = validated
    const scheduled = new Map<number, () => void>()
    let state: DriverState = 'idle'
    let nextHandle = 1
    let revision = 0
    let cachedCapture: GeoFrameCapture<Capture> | undefined
    let invalidate: (() => boolean) | undefined
    let ownsLayer = false

    const layer: MapLibreFrameLayer = Object.freeze({
        id,
        type: 'custom' as const,
        renderingMode: '2d' as const,
        render(..._arguments: unknown[]) {
            flushScheduledFrame()
        },
    })

    const scheduler: GeoFrameScheduler = Object.freeze({
        request(callback) {
            assertRunning()
            const handle = nextSchedulerHandle()
            scheduled.set(handle, callback)
            if (!ownsLayer) return handle
            try {
                map.triggerRepaint()
            } catch (error) {
                scheduled.delete(handle)
                throw error
            }
            return handle
        },
        cancel(handle) {
            scheduled.delete(handle)
        },
    })

    function capture(): GeoFrameCapture<Capture> {

        assertRunning()
        if (cachedCapture?.revision === revision) return cachedCapture
        cachedCapture = Object.freeze({
            revision,
            snapshot: readCapture(),
        })
        return cachedCapture
    }

    function start(nextInvalidate: () => boolean): void {

        if (state !== 'idle' || typeof nextInvalidate !== 'function') {
            return invalidState('start', state, id)
        }
        if (map.getLayer(id) !== undefined) return layerConflict(id)
        state = 'running'
        invalidate = nextInvalidate
        try {
            map.on('move', handleViewChange)
            map.on('resize', handleViewChange)
            map.on('style.load', handleStyleLoad)
            if (map.isStyleLoaded()) attachOwnedLayer()
        } catch (error) {
            releaseHostState()
            state = 'stopped'
            throw error
        }
    }

    function stop(): boolean {

        if (state === 'stopped') return false
        state = 'stopped'
        releaseHostState()
        return true
    }

    function handleViewChange(): void {

        if (state !== 'running') return
        if (revision === Number.MAX_SAFE_INTEGER) {
            return invalidState('advance revision', state, id)
        }
        revision++
        cachedCapture = undefined
        invalidate?.()
    }

    function handleStyleLoad(): void {

        if (state !== 'running') return
        ownsLayer = false
        if (map.getLayer(id) !== undefined) return layerConflict(id)
        attachOwnedLayer()
    }

    function attachOwnedLayer(): void {

        const hadScheduledWork = scheduled.size > 0
        map.addLayer(layer)
        ownsLayer = true
        invalidate?.()
        if (hadScheduledWork) map.triggerRepaint()
    }

    function flushScheduledFrame(): void {

        if (state !== 'running' || scheduled.size === 0) return
        const callbacks = [ ...scheduled.values() ]
        scheduled.clear()
        for (const callback of callbacks) callback()
    }

    function releaseHostState(): void {

        scheduled.clear()
        cachedCapture = undefined
        invalidate = undefined
        map.off('move', handleViewChange)
        map.off('resize', handleViewChange)
        map.off('style.load', handleStyleLoad)
        if (ownsLayer && map.getLayer(id) !== undefined) map.removeLayer(id)
        ownsLayer = false
    }

    function nextSchedulerHandle(): number {

        if (nextHandle === Number.MAX_SAFE_INTEGER) {
            return invalidState('allocate scheduler handle', state, id)
        }
        return nextHandle++
    }

    function assertRunning(): void {

        if (state !== 'running') return invalidState('schedule or capture', state, id)
    }

    return Object.freeze({
        kind: 'geo-frame-driver' as const,
        id,
        scheduler,
        capture,
        start,
        stop,
    })
}

function validateDescriptor<Capture>(descriptor: MapLibreFrameDriverDescriptor<Capture>) {

    const map = descriptor?.map
    const id = descriptor?.id
    const capture = descriptor?.capture
    if (typeof id !== 'string' || id.length === 0 ||
        typeof capture !== 'function' ||
        typeof map?.on !== 'function' || typeof map.off !== 'function' ||
        typeof map.isStyleLoaded !== 'function' ||
        typeof map.addLayer !== 'function' || typeof map.removeLayer !== 'function' ||
        typeof map.getLayer !== 'function' || typeof map.triggerRepaint !== 'function') {
        return throwGeoDiagnostic({
            code: 'GEO_MAPLIBRE_FRAME_DRIVER_INVALID',
            phase: 'selection',
            subject: { kind: 'maplibre-frame-driver', id },
            message: 'A MapLibre frame driver requires a stable id, capture, and compatible map host.',
            expected: {
                id: 'non-empty string',
                capture: 'function',
                map: 'on/off/isStyleLoaded/addLayer/removeLayer/getLayer/triggerRepaint methods',
            },
            actual: descriptor,
        })
    }
    return Object.freeze({
        id,
        map: Object.freeze({
            on: map.on.bind(map),
            off: map.off.bind(map),
            isStyleLoaded: map.isStyleLoaded.bind(map),
            addLayer: map.addLayer.bind(map),
            removeLayer: map.removeLayer.bind(map),
            getLayer: map.getLayer.bind(map),
            triggerRepaint: map.triggerRepaint.bind(map),
        }) satisfies MapLibreFrameMap,
        readCapture: capture.bind(descriptor),
    })
}

function layerConflict(id: string): never {

    return throwGeoDiagnostic({
        code: 'GEO_MAPLIBRE_FRAME_LAYER_CONFLICT',
        phase: 'selection',
        subject: { kind: 'maplibre-frame-driver', id },
        message: `MapLibre already contains a layer named ${id}.`,
        expected: { layerId: 'unused by the host style' },
        actual: { layerId: id, exists: true },
    })
}

function invalidState(operation: string, state: DriverState, id: string): never {

    return throwGeoDiagnostic({
        code: 'GEO_MAPLIBRE_FRAME_DRIVER_STATE_INVALID',
        phase: 'selection',
        subject: { kind: 'maplibre-frame-driver', id },
        message: `MapLibre frame driver cannot ${operation} while ${state}.`,
        expected: { state: operation === 'start' ? 'idle' : 'running' },
        actual: { state, operation },
    })
}
