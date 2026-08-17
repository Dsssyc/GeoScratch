import { GPURuntime, WorkerModuleCatalog } from 'geoscratch/scratch'
import type { LifetimeScope } from 'geoscratch/scratch'
import {
    WEB_MERCATOR_TERRAIN_TILE_WIREFRAME_FRAGMENT_ENTRY_POINT,
    createGeoFrameController,
    createWebMercatorTerrainRenderer,
    mapFieldLayer,
    mapLibreFrameDriver,
    mapLibrePlanarViewSource,
} from 'geoscratch/geo'
import {
    createUnderwaterTerrainMap,
    underwaterTerrainViewAdapter,
    waitForUnderwaterTerrainMap,
} from './map.ts'
import type { UnderwaterTerrainMap } from './map.ts'
import {
    createDemVirtualRaster,
    fetchDemTileSource,
} from './dem-source.ts'
import type { UnderwaterTerrainCachePolicy } from './cache-policy.ts'
import terrainPresentationShader from './shaders/terrain-presentation.wgsl?raw'

type UnderwaterTerrainProofModule = typeof import(
    '../../tests/browser/support/underwater-terrain-proof.ts'
)
type UnderwaterTerrainProof = ReturnType<UnderwaterTerrainProofModule['createUnderwaterTerrainProof']>
type CameraMoveOptions = Parameters<UnderwaterTerrainMap['jumpTo']>[0]

export type UnderwaterTerrainApplication = Readonly<{
    setTileWireframe(enabled: boolean): void
}>

type UnderwaterTerrainApplicationOptions = Readonly<{
    lifetime: LifetimeScope
    canvas: HTMLCanvasElement
    proofMode: boolean
    tileServerUrl: string
    workerModuleManifestUrl: URL
    cachePolicy: UnderwaterTerrainCachePolicy
    maxPhysicalPages: number
    tileWireframeEnabled: boolean
    proof?: UnderwaterTerrainProof
    fail(error: unknown): void
    dispose(): Promise<unknown>
    setStatus(status: string): void
}>

const TERRAIN_EXAGGERATION = 50

/** Assembles the explicit map, GPU, raster, terrain, view, and frame owners. */
export async function startUnderwaterTerrainApplication(
    options: UnderwaterTerrainApplicationOptions
): Promise<UnderwaterTerrainApplication> {

    const {
        lifetime,
        canvas,
        proofMode,
        tileServerUrl,
        workerModuleManifestUrl,
        cachePolicy,
        maxPhysicalPages,
        proof,
        setStatus,
    } = options
    proof?.assertConfiguration()
    const map = lifetime.own(createUnderwaterTerrainMap(canvas, { proof: proofMode }), {
        label: 'maplibre-map',
        release: value => value.remove(),
    })
    proof?.mapAcquired()
    proof?.reach('after-map-acquisition')

    const [ runtime, , source, workerModules ] = await Promise.all([
        lifetime.acquire(GPURuntime.create({
            label: 'Underwater Terrain runtime',
            powerPreference: 'high-performance',
            diagnostics: {
                operationCapacity: 192,
                incidentCapacity: 32,
                evidenceByteCapacity: 256 * 1024,
                submissionScopes: 'summary',
                maxPendingNativeObservations: 8,
            },
        }), {
            label: 'scratch-runtime',
            release: value => value.dispose(),
        }),
        waitForUnderwaterTerrainMap(map, lifetime.signal),
        lifetime.track(fetchDemTileSource(tileServerUrl, lifetime.signal), 'dem-tile-source'),
        lifetime.track(
            WorkerModuleCatalog.load(workerModuleManifestUrl, { signal: lifetime.signal }),
            'worker-module-catalog'
        ),
    ])
    proof?.observeRuntime(runtime)
    lifetime.assertActive()

    const initialSize = canvasPixelSize(canvas)
    const surface = runtime.createSurface(canvas, {
        label: 'Underwater Terrain surface',
        format: 'preferred',
        alphaMode: 'premultiplied',
        size: initialSize,
    })
    const virtualRaster = await lifetime.acquire(
        createDemVirtualRaster({
            runtime,
            source,
            cachePolicy,
            workerModules,
            workerCount: 3,
            maxNetworkRequests: 2,
            maxDecodeTasks: 1,
            maxPhysicalPages,
        }), {
            label: 'dem-virtual-raster-streaming',
            release: value => value.dispose(),
        }
    )
    proof?.rasterAcquired()
    lifetime.deferStop({
        label: 'dem-virtual-raster-demand',
        run: virtualRaster.stopDemand,
    })

    const elevationRangeMeters = [
        source.manifest.offset,
        source.manifest.offset + source.manifest.scale * 255,
    ].sort((left, right) => left - right) as [number, number]
    proof?.beforeTerrainShaderModule(runtime)
    const graph = await lifetime.acquire(
        createWebMercatorTerrainRenderer({
            runtime,
            surface,
            fieldLayer: mapFieldLayer({
                id: 'underwater-terrain-height-field',
                field: virtualRaster.field,
                representation: virtualRaster.representation,
                spatialProfile: virtualRaster.spatialProfile,
                viewAdapter: underwaterTerrainViewAdapter,
                demandProducer: virtualRaster.viewDemandProducer,
            }),
            virtualRaster,
            size: initialSize,
            presentationShader: proof?.terrainShader(terrainPresentationShader) ??
                terrainPresentationShader,
            fieldSampling: {
                namespace: 'DemHeight',
                addressNamespace: 'DemAddress',
                transitionTexels: 16,
            },
            elevationRangeMeters,
            exaggeration: TERRAIN_EXAGGERATION,
            presentations: [
                {
                    id: 'shaded',
                    fragmentEntryPoint: 'fMain',
                    label: 'Underwater Terrain pipeline',
                },
                {
                    id: 'tile-wireframe',
                    fragmentEntryPoint:
                        WEB_MERCATOR_TERRAIN_TILE_WIREFRAME_FRAGMENT_ENTRY_POINT,
                    label: 'Underwater Terrain tile wireframe pipeline',
                },
            ],
            initialPresentation: options.tileWireframeEnabled ? 'tile-wireframe' : 'shaded',
        }), {
            label: 'underwater-terrain-gpu-frontier',
            release: value => value.dispose(),
        }
    )
    const initialized = await graph.initialize()
    await lifetime.track(initialized.observation, 'underwater-terrain-initial-submission')
    lifetime.assertActive()

    const viewSource = mapLibrePlanarViewSource({
        id: 'underwater-terrain-maplibre-view-source',
        adapter: underwaterTerrainViewAdapter,
        map,
        viewport: () => canvasPixelSize(canvas),
        minimumElevationMeters: elevationRangeMeters[0] * TERRAIN_EXAGGERATION,
    })
    const frameController = createGeoFrameController({
        track: (work, label) => lifetime.track(work, label),
        maximumInFlightFrames: 1,
        driver: mapLibreFrameDriver({
            id: 'underwater-terrain-maplibre-frames',
            map,
            capture: viewSource.capture,
        }),
        render(_frameNumber, captured) {
            lifetime.assertActive()
            return graph.render(captured)
        },
        onSubmitted({ value }) {
            proof?.frameSubmitted(value.frame.provenance, value.view)
        },
        onObserved({ frameNumber }) {
            proof?.frameObserved(frameNumber)
            if (frameController.snapshot().state === 'running') setStatus('ready')
        },
        onError(error) {
            if (lifetime.isStopError(error)) return
            options.fail(error)
        },
    })

    function moveCamera(camera: CameraMoveOptions) {

        if (frameController.snapshot().state === 'stopped') {
            throw new Error('Underwater Terrain frame controller is stopped')
        }
        map.jumpTo(camera)
    }

    let presentationActive = true
    const application = Object.freeze({
        setTileWireframe(enabled: boolean) {
            if (!presentationActive) return
            graph.setPresentation(enabled ? 'tile-wireframe' : 'shaded')
            frameController.invalidate()
        },
    })
    lifetime.deferStop({
        label: 'underwater-terrain-presentation-control',
        run: () => { presentationActive = false },
    })
    lifetime.deferStop({
        label: 'underwater-terrain-frame-scheduler',
        run: frameController.stop,
    })
    proof?.bindGraph({
        runtime,
        graph,
        lifetime,
        frameController,
        virtualRasterFacts: () => Object.freeze({
            runtime: virtualRaster.inspect(),
            source: source.facts,
            worker: virtualRaster.workerFacts(),
        }),
        dispose: options.dispose,
        moveCamera,
        setStatus,
    })
    return application
}

function canvasPixelSize(target: HTMLElement) {

    const ratio = window.devicePixelRatio || 1
    return {
        width: Math.max(1, Math.floor(target.clientWidth * ratio)),
        height: Math.max(1, Math.floor(target.clientHeight * ratio)),
    }
}
