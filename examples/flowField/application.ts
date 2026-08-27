import {
    GPURuntime,
    WorkerModuleCatalog,
    WorkerSystem,
} from 'geoscratch/scratch'
import type {
    LifetimeScope,
} from 'geoscratch/scratch'
import {
    createGeoFrameController,
    mapLibreFrameDriver,
    mapLibrePlanarViewSource,
} from 'geoscratch/geo'
import type {
    GeoFrameController,
} from 'geoscratch/geo'
import {
    FLOW_FIELD_CACHE_DISABLED,
} from './cache-policy.ts'
import {
    loadFlowDatasetManifest,
} from './flow-dataset.ts'
import {
    createFlowFieldRenderer,
} from './flow-renderer.ts'
import type {
    FlowFieldRenderer,
} from './flow-renderer.ts'
import {
    createFlowFieldMap,
    flowFieldViewAdapter,
} from './map.ts'
import {
    createTemporalVelocityRaster,
} from './temporal-velocity-raster.ts'

export type FlowFieldApplicationOptions = Readonly<{
    lifetime: LifetimeScope
    canvas: HTMLCanvasElement
    proofMode: boolean
    tileServerUrl: string
    workerModuleManifestUrl: URL
    framesPerTime: number
    fail(error: unknown): void
    setStatus(status: string): void
}>

export type FlowFieldApplicationFacts = Readonly<{
    paused: boolean
    frames: ReturnType<GeoFrameController['snapshot']>
    renderer: ReturnType<FlowFieldRenderer['facts']>
    workers: ReturnType<WorkerSystem['inspect']>
    diagnostics: ReturnType<GPURuntime['diagnostics']['snapshot']>
}>

export type FlowFieldApplication = Readonly<{
    setPaused(paused: boolean): void
    flush(): Promise<void>
    facts(): FlowFieldApplicationFacts
}>

/** Assembles the independent Flow Field map, workers, temporal rasters, renderer, and frame owner. */
export async function startFlowFieldApplication(
    options: FlowFieldApplicationOptions
): Promise<FlowFieldApplication> {

    const {
        lifetime,
        canvas,
        proofMode,
        tileServerUrl,
        workerModuleManifestUrl,
        framesPerTime,
        setStatus,
    } = options
    if (!Number.isSafeInteger(framesPerTime) || framesPerTime <= 0) {
        throw new RangeError('Flow Field framesPerTime must be a positive integer')
    }
    const map = lifetime.own(createFlowFieldMap(canvas, { proof: proofMode }), {
        label: 'flow-field-maplibre-map',
        release: value => value.remove(),
    })
    const [ runtime, manifest, workerModules ] = await Promise.all([
        lifetime.acquire(GPURuntime.create({
            label: 'Flow Field runtime',
            powerPreference: 'high-performance',
            diagnostics: {
                operationCapacity: 256,
                incidentCapacity: 32,
                evidenceByteCapacity: 256 * 1024,
                submissionScopes: 'summary',
                maxPendingNativeObservations: 8,
            },
        }), {
            label: 'flow-field-runtime',
            release: value => value.dispose(),
        }),
        lifetime.track(
            loadFlowDatasetManifest(flowManifestUrl(tileServerUrl)),
            'flow-field-manifest'
        ),
        lifetime.track(
            WorkerModuleCatalog.load(workerModuleManifestUrl, { signal: lifetime.signal }),
            'flow-field-worker-module-catalog'
        ),
    ])
    lifetime.assertActive()
    const workers = lifetime.own(new WorkerSystem({
        maxWorkers: 6,
        maxHistory: 64,
        moduleResolver: workerModules,
    }), {
        label: 'flow-field-worker-system',
        release: value => value.dispose(),
    })
    const size = canvasPixelSize(canvas)
    const surface = runtime.createSurface(canvas, {
        label: 'Flow Field surface',
        format: 'preferred',
        alphaMode: 'premultiplied',
        size,
    })
    const temporal = await lifetime.acquire(createTemporalVelocityRaster({
        runtime,
        manifest,
        cachePolicy: FLOW_FIELD_CACHE_DISABLED,
        workerSystem: workers,
        workerModules,
        framesPerTime,
        workerCount: 1,
        maxNetworkRequests: 1,
        maxDecodeTasks: 1,
        maxRequests: 64,
        maxPhysicalPages: 64,
        maxHistory: 64,
    }), {
        label: 'flow-field-temporal-velocity',
        release: value => value.dispose(),
    })
    const maximumSpeed = manifest.pages.reduce(
        (maximum, page) => Math.max(maximum, page.maximumSpeed),
        0
    )
    const renderer = await lifetime.acquire(createFlowFieldRenderer({
        runtime,
        surface,
        size,
        temporal,
        maximumSpeed,
    }), {
        label: 'flow-field-renderer',
        release: value => value.dispose(),
    })
    lifetime.assertActive()

    const viewSource = mapLibrePlanarViewSource({
        id: 'flow-field-maplibre-view-source',
        adapter: flowFieldViewAdapter,
        map,
        presentationSize: () => canvasPixelSize(canvas),
        minimumElevationMeters: 0,
    })
    let paused = false
    const frameController = createGeoFrameController({
        track: (work, label) => lifetime.track(work, label),
        maximumInFlightFrames: 1,
        driver: mapLibreFrameDriver({
            id: 'flow-field-maplibre-frames',
            map,
            capture: viewSource.capture,
        }),
        render(frameNumber, captured) {

            lifetime.assertActive()
            return renderer.render(frameNumber, captured)
        },
        onObserved() {

            if (frameController.snapshot().state !== 'running') return
            setStatus('ready')
            if (!paused) frameController.invalidate()
        },
        onError(error) {

            if (lifetime.isStopError(error)) return
            options.fail(error)
        },
    })
    lifetime.deferStop({
        label: 'flow-field-frame-controller',
        run: frameController.stop,
    })

    function setPaused(nextPaused: boolean): void {

        paused = nextPaused
        if (!paused && frameController.snapshot().state === 'running') {
            frameController.invalidate()
        }
    }

    function flush(): Promise<void> {

        if (frameController.snapshot().state !== 'running') {
            return Promise.reject(new Error('Flow Field frame controller is stopped'))
        }
        frameController.stop()
        return lifetime.track(renderer.flushResidency(), 'flow-field-residency-flush')
    }

    function facts(): FlowFieldApplicationFacts {

        return Object.freeze({
            paused,
            frames: frameController.snapshot(),
            renderer: renderer.facts(),
            workers: workers.inspect(),
            diagnostics: runtime.diagnostics.snapshot(),
        })
    }

    return Object.freeze({ setPaused, flush, facts })
}

function flowManifestUrl(tileServerUrl: string): URL {

    let base: URL
    try {
        base = new URL(tileServerUrl, window.location.href)
    } catch {
        throw new TypeError('Flow Field tile server URL is invalid')
    }
    if (!base.pathname.endsWith('/')) base.pathname += '/'
    return new URL('manifest.json', base)
}

function canvasPixelSize(target: HTMLElement) {

    const ratio = window.devicePixelRatio || 1
    return {
        width: Math.max(1, Math.floor(target.clientWidth * ratio)),
        height: Math.max(1, Math.floor(target.clientHeight * ratio)),
    }
}
