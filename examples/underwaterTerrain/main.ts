import { GPURuntime, LifetimeScope, WorkerModuleCatalog } from 'geoscratch/scratch'
import type { SurfaceSize } from 'geoscratch/scratch'
import {
    WEB_MERCATOR_TERRAIN_TILE_WIREFRAME_FRAGMENT_ENTRY_POINT,
    createGeoFrameController,
    createWebMercatorTerrainRenderer,
    mapFieldLayer,
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
import { readUnderwaterTerrainCachePolicy } from './cache-policy.ts'
import { prepareUnderwaterTerrainControlPanel } from './control-panel.ts'
import terrainPresentationShader from './shaders/terrain-presentation.wgsl?raw'

type UnderwaterTerrainProofModule = typeof import(
    '../../tests/browser/support/underwater-terrain-proof.ts'
)
type UnderwaterTerrainProof = ReturnType<UnderwaterTerrainProofModule['createUnderwaterTerrainProof']>
type PageSettlement = Promise<unknown>
type CameraMoveOptions = Parameters<UnderwaterTerrainMap['jumpTo']>[0]
type FailureDetails = Error & { diagnostic?: unknown }
type UnderwaterTerrainFrameCapture = Readonly<{
    camera: ReturnType<typeof underwaterTerrainViewAdapter.camera>
    size: SurfaceSize
}>

const TERRAIN_EXAGGERATION = 50
const canvas = document.getElementById('GPUFrame') as HTMLCanvasElement
const controlPanelContainer = document.getElementById('UnderwaterTerrainControlPanel') as HTMLElement
const pageLifetime = new LifetimeScope({ label: 'underwater-terrain-page' })
const preparedControlPanel = prepareUnderwaterTerrainControlPanel({
    parameters: new URLSearchParams(window.location.search),
})
const parameters = preparedControlPanel.parameters
const proofMode = parameters.get('proof') === '1'
const tileServerUrl = parameters.get('tileServer') ?? 'http://127.0.0.1:8787'
const workerModuleManifestUrl = new URL(
    '../scratch-workers/manifest.json',
    window.location.href
)
const cachePolicy = readUnderwaterTerrainCachePolicy(parameters)
const maxPhysicalPages = boundedIntegerParameter(parameters.get('atlasPages'), 64, 2, 64)
let tileWireframeEnabled = preparedControlPanel.renderingPreference.tileWireframe
let applyTerrainPresentation: ((enabled: boolean) => void) | undefined
let proof: UnderwaterTerrainProof | undefined
let pageSettlement: PageSettlement | undefined

const controlPanel = preparedControlPanel.mount({
    container: controlPanelContainer,
    location: window.location,
    compact: window.matchMedia('(max-width: 640px)').matches,
    onTileWireframeChange(enabled) {
        tileWireframeEnabled = enabled
        applyTerrainPresentation?.(enabled)
    },
})
const handlePageHide = () => { void disposePage() }
window.addEventListener('pagehide', handlePageHide, { once: true })
pageLifetime.deferStop({ label: 'underwater-terrain-control-panel', run: controlPanel.dispose })
pageLifetime.deferStop({
    label: 'pagehide-listener',
    run: () => window.removeEventListener('pagehide', handlePageHide),
})

setStatus('loading')
const pageInitialization = pageLifetime.track(
    loadProof().then(loadedProof => {
        proof = loadedProof
        return main(pageLifetime, loadedProof)
    }),
    'underwater-terrain-page-initialization'
)
void pageInitialization.catch(error => {
    if (pageLifetime.isStopError(error)) return
    void failPage(error)
})

async function loadProof(): Promise<UnderwaterTerrainProof | undefined> {
    if (!import.meta.env.DEV || !proofMode) return undefined
    const { createUnderwaterTerrainProof } = await import(
        '../../tests/browser/support/underwater-terrain-proof.ts'
    )
    return createUnderwaterTerrainProof({
        canvas,
        lifetime: pageLifetime,
        scenario: parameters.get('fault') ?? undefined,
        tileServerUrl,
        cachePolicy,
        maxPhysicalPages,
        controlPanel: preparedControlPanel,
    })
}

async function main(lifetime: LifetimeScope, activeProof?: UnderwaterTerrainProof) {

    activeProof?.assertConfiguration()
    const map = lifetime.own(createUnderwaterTerrainMap(canvas, { proof: proofMode }), {
        label: 'maplibre-map',
        release: value => value.remove(),
    })
    activeProof?.mapAcquired()
    activeProof?.reach('after-map-acquisition')

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
        lifetime.track(
            fetchDemTileSource(tileServerUrl, lifetime.signal),
            'dem-tile-source'
        ),
        lifetime.track(
            WorkerModuleCatalog.load(workerModuleManifestUrl, { signal: lifetime.signal }),
            'worker-module-catalog'
        ),
    ])
    activeProof?.observeRuntime(runtime)
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
    activeProof?.rasterAcquired()
    lifetime.deferStop({
        label: 'dem-virtual-raster-demand',
        run: virtualRaster.stopDemand,
    })

    const elevationRangeMeters = [
        source.manifest.offset,
        source.manifest.offset + source.manifest.scale * 255,
    ].sort((left, right) => left - right) as [number, number]
    activeProof?.beforeTerrainShaderModule(runtime)
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
            presentationShader: activeProof?.terrainShader(terrainPresentationShader) ??
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
            initialPresentation: tileWireframeEnabled ? 'tile-wireframe' : 'shaded',
        }), {
            label: 'underwater-terrain-gpu-frontier',
            release: value => value.dispose(),
        }
    )
    const initialized = await graph.initialize()
    await lifetime.track(initialized.observation, 'underwater-terrain-initial-submission')
    lifetime.assertActive()

    const minimumTerrainElevationMeters = elevationRangeMeters[0] * TERRAIN_EXAGGERATION
    let hostViewRevision = 0
    let cachedHostCapture: Readonly<{
        revision: number
        snapshot: UnderwaterTerrainFrameCapture
    }> | undefined
    const frameController = createGeoFrameController({
        track: (work, label) => lifetime.track(work, label),
        maximumInFlightFrames: 1,
        capture() {
            if (cachedHostCapture?.revision === hostViewRevision) return cachedHostCapture
            const size = canvasPixelSize(canvas)
            const camera = underwaterTerrainViewAdapter.camera({
                map,
                viewport: size,
                minimumElevationMeters: minimumTerrainElevationMeters,
            })
            cachedHostCapture = Object.freeze({
                revision: hostViewRevision,
                snapshot: Object.freeze({ camera, size }),
            })
            return cachedHostCapture
        },
        async render(_frameNumber, captured) {
            if (!sameSize(graph.state().size, captured.size)) await graph.resize(captured.size)
            lifetime.assertActive()
            const frame = await graph.renderFrame(captured.camera)
            return {
                observation: frame.observation,
                settlement: frame.settlement.then(settlement => ({
                    residencySettlement: settlement.residencySettlement,
                    residencyWorkCount: settlement.requestedPageCount,
                    needsFollowUp: settlement.needsFollowUp,
                })),
                needsFollowUp: frame.needsFollowUp,
                value: { frame, camera: captured.camera },
            }
        },
        onSubmitted({ value }) {
            activeProof?.frameSubmitted(value.frame.provenance, value.camera)
        },
        onObserved({ frameNumber }) {
            activeProof?.frameObserved(frameNumber)
            if (frameController.snapshot().state === 'running') setStatus('ready')
        },
        onError(error) {
            if (lifetime.isStopError(error)) return
            void failPage(error)
        },
    })

    function moveCamera(options: CameraMoveOptions) {

        if (frameController.snapshot().state === 'stopped') {
            throw new Error('Underwater Terrain frame controller is stopped')
        }
        map.jumpTo(options)
        frameController.invalidate()
    }

    applyTerrainPresentation = enabled => {
        graph.setPresentation(enabled ? 'tile-wireframe' : 'shaded')
        frameController.invalidate()
    }
    lifetime.deferStop({
        label: 'underwater-terrain-presentation-control',
        run: () => { applyTerrainPresentation = undefined },
    })

    const handleMapViewChange = () => { hostViewRevision++ }
    const handleMapRender = () => { frameController.invalidateNow() }
    const handleResize = () => {
        handleMapViewChange()
        map.resize()
        frameController.invalidate()
    }
    map.on('move', handleMapViewChange)
    map.on('resize', handleMapViewChange)
    map.on('render', handleMapRender)
    window.addEventListener('resize', handleResize)
    lifetime.deferStop({
        label: 'map-render-listener',
        run: () => map.off('render', handleMapRender),
    })
    lifetime.deferStop({
        label: 'map-view-revision-listeners',
        run: () => {
            map.off('move', handleMapViewChange)
            map.off('resize', handleMapViewChange)
        },
    })
    lifetime.deferStop({
        label: 'window-resize-listener',
        run: () => window.removeEventListener('resize', handleResize),
    })
    lifetime.deferStop({
        label: 'underwater-terrain-frame-scheduler',
        run: frameController.stop,
    })
    activeProof?.bindGraph({
        runtime,
        graph,
        lifetime,
        frameController,
        virtualRasterFacts: () => Object.freeze({
            runtime: virtualRaster.inspect(),
            source: source.facts,
            worker: virtualRaster.workerFacts(),
        }),
        dispose: disposePage,
        moveCamera,
        setStatus,
    })
    frameController.invalidate()
}

async function failPage(error: unknown) {

    if (pageSettlement !== undefined) return pageSettlement
    reportFatalError(error)
    proof?.captureBeforeDisposal()
    pageSettlement = pageLifetime.dispose(error).then(report =>
        proof?.finalizeFailure(error, report)
    ).catch((cleanupFailure: unknown) => {
        console.error(cleanupFailure)
    })
    return pageSettlement
}

async function disposePage() {

    if (pageSettlement !== undefined) return pageSettlement
    pageSettlement = pageLifetime.dispose().then(report => {
        const cleanupProof = proof?.finalizeCleanup(report)
        setStatus(report.cleanupFailures.length === 0 ? 'disposed' : 'error')
        return cleanupProof ?? report
    })
    return pageSettlement
}

function canvasPixelSize(target: HTMLElement): SurfaceSize {

    const ratio = window.devicePixelRatio || 1
    return {
        width: Math.max(1, Math.floor(target.clientWidth * ratio)),
        height: Math.max(1, Math.floor(target.clientHeight * ratio)),
    }
}

function sameSize(left: SurfaceSize, right: SurfaceSize) {

    return left.width === right.width && left.height === right.height
}

function boundedIntegerParameter(
    value: string | null,
    fallback: number,
    minimum: number,
    maximum: number
) {

    if (value === null) return fallback
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
        throw new RangeError(
            `Underwater Terrain integer parameter must be between ${minimum} and ${maximum}`
        )
    }
    return parsed
}

function setStatus(status: string) {

    canvas.dataset.status = status
    document.body.dataset.status = status
}

function reportFatalError(error: unknown) {

    setStatus('error')
    canvas.dataset.error = error instanceof Error ? error.message : String(error)
    if ((error as FailureDetails | null | undefined)?.diagnostic !== undefined) {
        canvas.dataset.diagnostic = JSON.stringify((error as FailureDetails).diagnostic)
    }
    console.error(error)
}
