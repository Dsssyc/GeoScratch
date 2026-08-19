import { expect } from 'chai'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { GPURuntime } from 'geoscratch/scratch'
import {
    ViewDemandProducer,
    VirtualRasterResidency,
    WEB_MERCATOR_TERRAIN_TILE_WIREFRAME_FRAGMENT_ENTRY_POINT,
    createVirtualRasterGpuState,
    createWebMercatorTerrainRenderer,
    mapFieldLayer,
    ownedVirtualRasterPagePayload,
} from 'geoscratch/geo'
import { createDemTileSource } from '../examples/underwaterTerrain/dem-source.ts'
import { underwaterTerrainViewAdapter } from '../examples/underwaterTerrain/map.ts'
import { createFakeCanvas, createFakeGpu } from './scratch-test-utils.js'
import { demWebMercatorManifest } from './fixtures/dem-webmercator-manifest.js'

const root = process.cwd()
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8')
const exists = (...parts) => fs.existsSync(path.join(root, ...parts))
const demSource = createDemTileSource({
    manifest: demWebMercatorManifest,
    tileServerUrl: 'http://127.0.0.1:8787',
})
const demManifest = demSource.manifest

function sha256(value) {

    return crypto.createHash('sha256').update(value).digest('hex')
}

async function createTestVirtualRaster(runtime) {

    const model = demSource.model
    const residency = new VirtualRasterResidency({
        addressSpace: model.addressSpace,
        plane: model.plane,
        maxPhysicalPages: 18,
        maxStagingBytes: 18 * 256 * 256,
        maxHistory: 8,
    })
    const safetyPage = model.safetyCoverPages[0]
    residency.pin(safetyPage)
    const gpu = await createVirtualRasterGpuState(runtime, {
        addressSpace: model.addressSpace,
        plane: model.plane,
        maxPhysicalPages: 18,
    })
    let generation = 0
    let activePublication
    let stopped = false

    function publish() {

        const publication = residency.publish()
        const update = gpu.stage(publication)
        activePublication = publication
        return Object.freeze({
            snapshotEpoch: publication.snapshot.epoch,
            changed: update.commands.length > 0,
            update,
            publication,
        })
    }

    return Object.freeze({
        ...model,
        kind: 'virtual-raster-runtime',
        model,
        manifest: demManifest,
        residency,
        gpu,
        scheduler: Object.freeze({
            maxRequests: 18,
            inspect: () => Object.freeze({
                activeRequestCount: 0,
                queuedRequestCount: 0,
            }),
        }),
        viewDemandProducer: new ViewDemandProducer({
            id: 'test-dem-view-demand',
            maxDemands: 18,
        }),
        async initialize() {

            generation++
            residency.reconcileGeneration(generation, [ safetyPage ])
            residency.stage(ownedVirtualRasterPagePayload({
                page: safetyPage,
                width: 256,
                height: 256,
                channels: 1,
                data: new Uint8Array(256 * 256).fill(128),
                contentVersion: demManifest.contentVersion,
            }), { generation })
            return publish()
        },
        reconcileViewDemands() {

            generation++
            residency.reconcileGeneration(generation, [ safetyPage ])
            return Object.freeze({
                requestedCount: 0,
                settlement: Promise.resolve(Object.freeze({
                    generation,
                    stagedCount: 0,
                    residentCount: 1,
                    staleCount: 0,
                    failedCount: 0,
                })),
                generation,
                retainedCount: 0,
                retiredCount: 0,
            })
        },
        publish,
        async acknowledge(wrapped, submitted) {

            if (activePublication !== wrapped.publication) {
                throw new Error('Test DEM publication authority mismatch')
            }
            await gpu.acknowledge(wrapped.publication, submitted)
            activePublication = undefined
        },
        inspect: () => Object.freeze({
            contentVersion: demManifest.contentVersion,
            tileMatrixSetId: demManifest.tileMatrixSet.id,
            stopped,
            residency: residency.inspect(),
            gpu: gpu.facts(),
        }),
        async dispose() {

            if (stopped) return
            stopped = true
            if (activePublication !== undefined) {
                await gpu.abandon(activePublication)
                activePublication = undefined
            }
            residency.dispose()
            gpu.dispose()
        },
    })
}

function createTestTerrainRenderer({ runtime, surface, virtualRaster, size, observeProvenance }) {

    return createWebMercatorTerrainRenderer({
        runtime,
        surface,
        fieldLayer: mapFieldLayer({
            id: 'test-dem-height-layer',
            field: virtualRaster.field,
            representation: virtualRaster.representation,
            spatialProfile: virtualRaster.spatialProfile,
            viewAdapter: underwaterTerrainViewAdapter,
            demandProducer: virtualRaster.viewDemandProducer,
        }),
        virtualRaster,
        size,
        presentationShader: read(
            'examples', 'underwaterTerrain', 'shaders', 'terrain-presentation.wgsl'
        ),
        fieldSampling: {
            namespace: 'DemHeight',
            addressNamespace: 'DemAddress',
            transitionTexels: 16,
        },
        elevationRangeMeters: [
            demManifest.offset,
            demManifest.offset + demManifest.scale * 255,
        ].sort((left, right) => left - right),
        exaggeration: 50,
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
        initialPresentation: 'shaded',
        ...(observeProvenance === undefined ? {} : { observeProvenance }),
    })
}

describe('Underwater Terrain clean cut', () => {

    it('keeps page bootstrap and explicit terrain application assembly context-bounded', () => {

        const main = read('examples', 'underwaterTerrain', 'main.ts')
        const application = read('examples', 'underwaterTerrain', 'application.ts')

        expect(main.split('\n')).to.have.length.at.most(181)
        for (const forbidden of [
            'GPURuntime',
            'createUnderwaterTerrainMap',
            'createDemVirtualRaster',
            'createWebMercatorTerrainRenderer',
            'createGeoFrameController',
        ]) expect(main).not.to.include(forbidden)
        for (const required of [
            'GPURuntime.create(',
            'createUnderwaterTerrainMap(',
            'createDemVirtualRaster({',
            'createWebMercatorTerrainRenderer({',
            'mapLibrePlanarViewSource({',
            'mapLibreFrameDriver({',
            'createGeoFrameController({',
        ]) expect(application).to.include(required)
        expect(application).to.include('maximumInFlightFrames: 2')
        expect(main).to.include('VITE_UNDERWATER_TERRAIN_VARIABLE_LOD_PITCH_DEGREES')
        expect(application).to.include('variableLodPitchThresholdRadians:')
        expect(application).not.to.match(/URLSearchParams|localStorage|tweakpane|Pane/)
    })

    it('uses one standard inverse cover and removes both forward frontier authorities', () => {

        const renderer = read(
            'packages', 'geoscratch', 'src', 'geo', 'web-mercator-terrain-renderer.ts'
        )
        const cover = read(
            'packages', 'geoscratch', 'src', 'geo', 'gpu-web-mercator-quad-cover.ts'
        )
        const wgsl = read(
            'packages', 'geoscratch', 'src', 'geo', 'gpu-web-mercator-quad-cover-wgsl.ts'
        )
        const terrain = read(
            'packages', 'geoscratch', 'src', 'geo', 'web-mercator-terrain-wgsl.ts'
        )

        expect(renderer).to.include('GpuWebMercatorQuadCover.create(runtime')
        expect(renderer).to.include('cover.encode(builder, frame)')
        expect(renderer).to.include('cover.capture(builder, frame)')
        expect(renderer).to.include("'inverse-cover-compute'")
        expect(renderer).to.include('virtualRaster.reconcileViewDemands(')
        expect(cover).to.include('export class GpuWebMercatorQuadCover')
        expect(cover).to.include('desiredSampleLevel')
        expect(cover).to.include('sourceLevelCeiling')
        expect(cover).to.include('maximumCellSpanPixels')
        expect(cover).to.include('variableLodPitchThresholdRadians')
        expect(wgsl).to.include('fn generateWebMercatorQuadCover()')
        expect(wgsl).to.include('coverCameraTileIndex')
        expect(wgsl).to.include('coverAlignToParentGroups')
        expect(wgsl).to.include('fn coverProjectedCellSpanPixels(')
        expect(wgsl).to.include('fn coverUniformWindow(')
        expect(wgsl).to.include('fn coverVariableRefinementWindow(')
        expect(wgsl).to.include('fn coverUnionWindow(')
        expect(wgsl).to.include('coverBalancePatches')
        expect(wgsl).not.to.include(
            '((focusRow - COVER_FINE_WINDOW_SPAN / 2i) / 2i) * 2i'
        )
        expect(wgsl).not.to.include('COVER_LEVEL_HALO_TILES')
        expect(wgsl).not.to.include('COVER_DISTANCE_BAND_RADIUS_TILES')
        expect(wgsl).not.to.include('coverPitchLevelBoost')
        expect(wgsl).not.to.include('rootTraversalCount')
        expect(wgsl).not.to.include('trialCount')
        expect(terrain).to.include('gpuWebMercatorQuadCoverReadWgslModule')
        for (const removed of [
            'gpu-tile-frontier.ts',
            'gpu-tile-frontier-layout.ts',
            'gpu-tile-frontier-wgsl.ts',
            'gpu-render-patch-frontier.ts',
            'gpu-render-patch-frontier-wgsl.ts',
            'virtual-raster-gpu-feedback.ts',
        ]) expect(exists('packages', 'geoscratch', 'src', 'geo', removed)).to.equal(false)
        const active = [ renderer, cover, wgsl, terrain ].join('\n')
        for (const forbidden of [
            'renderRoots',
            'countRenderPatchTrials',
            'biasStepCount',
            'trialCounts',
            'GpuTileFrontier',
            'GpuRenderPatchFrontier',
        ]) expect(active).not.to.include(forbidden)
    })

    it('keeps Virtual Raster passive and view demand provenance explicit', () => {

        const runtime = read(
            'packages', 'geoscratch', 'src', 'geo', 'virtual-raster-runtime.ts'
        )
        const demand = read(
            'packages', 'geoscratch', 'src', 'geo', 'view-tile-demand.ts'
        )

        expect(runtime).to.include('reconcileViewDemands(')
        expect(runtime).not.to.include('reconcileFeedback(')
        expect(demand).to.include('desiredSampleLevel')
        expect(demand).to.include('sourceLevelCeiling')
        for (const forbidden of [
            'zoomHint',
            'cameraPitchRadians',
            'refineErrorPixels',
            'coarsenErrorPixels',
            'maximumCellSpanPixels',
        ]) expect(runtime).not.to.include(forbidden)
    })

    it('uses only persistent Scratch objects in the frame hot path', () => {

        const renderer = read(
            'packages', 'geoscratch', 'src', 'geo', 'web-mercator-terrain-renderer.ts'
        )
        const frame = renderer.slice(
            renderer.indexOf('async function submitFrame(input: ViewInput)'),
            renderer.indexOf('async function resize(nextSize: SurfaceSize)')
        )

        for (const call of [
            'createBuffer',
            'createTexture',
            'createBindLayout',
            'createBindSet',
            'createProgram',
            'createRenderPipeline',
            'createRenderPass',
            'createDrawCommand',
        ]) {
            expect(renderer).to.include(call)
            expect(frame).not.to.include(call)
        }
        expect(frame).to.include('cover.writeView(view)')
        expect(frame).to.include('cover.encode(builder, frame)')
        expect(frame).to.include('.render(passes.terrain')
        expect(renderer).to.include("contentEpoch: 'current-at-step'")
        expect(renderer.match(/count: \{ indirect:/g)).to.have.length(1)
    })

    it('keeps neutral identity, generic Worker ownership, and MapLibre frame authority', () => {

        const application = read('examples', 'underwaterTerrain', 'application.ts')
        const map = read('examples', 'underwaterTerrain', 'map.ts')

        expect(exists('examples', 'underwaterTerrain', 'index.html')).to.equal(true)
        expect(exists('examples', 'm_demLayer')).to.equal(false)
        expect(exists('examples', 'underwaterTerrain', 'terrain-selection.ts')).to.equal(false)
        expect(application).to.include('driver: mapLibreFrameDriver({')
        expect(application).to.include('const viewSource = mapLibrePlanarViewSource({')
        expect(application).not.to.match(/map\.on\(['"](?:move|render|resize)/)
        expect(map).to.include('mapLibrePlanarViewAdapter')
    })

    it('preserves the source payload and keeps terrain presentation WGSL-only', () => {

        const presentation = read(
            'examples', 'underwaterTerrain', 'shaders', 'terrain-presentation.wgsl'
        )
        const payload = fs.readFileSync(path.join(
            root,
            'examples',
            'underwaterTerrain',
            'assets',
            'dem.png'
        ))

        expect(payload.byteLength).to.equal(91_980)
        expect(sha256(payload)).to.equal(
            'aa7a584830f198772d242df1ce1ae47e21b2bdc85bfc1f97101af8be986c57e1'
        )
        expect(presentation).to.include('fn fMain(')
        expect(presentation).not.to.match(/@vertex|renderRoots|canonicalNodes|meshStitch/)
    })

    it('submits native work before surfacing a provenance observer failure', async() => {

        const fake = createFakeGpu()
        const runtime = await GPURuntime.create({ gpu: fake.gpu })
        const fakeCanvas = createFakeCanvas()
        const surface = runtime.createSurface(fakeCanvas.canvas, {
            label: 'Underwater Terrain provenance-failure surface',
            format: 'rgba8unorm',
            alphaMode: 'premultiplied',
            size: { width: 320, height: 180 },
        })
        const provenanceFailure = new Error('injected Underwater Terrain provenance mismatch')
        const virtualRaster = await createTestVirtualRaster(runtime)
        const graph = await createTestTerrainRenderer({
            runtime,
            surface,
            virtualRaster,
            size: { width: 320, height: 180 },
            observeProvenance() {
                throw provenanceFailure
            },
        })
        const initialized = await graph.initialize()
        await initialized.observation
        const result = await graph.render({
            view: Object.freeze({
                far: 1000,
                near: 1,
                clipFromRelativeWorld: [
                    1, 0, 0, 0,
                    0, 1, 0, 0,
                    0, 0, 1, 0,
                    0, 0, 0, 1,
                ],
                cameraLow: [ 0, 0, 0 ],
                cameraHigh: [ 0, 0, 100 ],
                viewport: [ 320, 180 ],
                verticalFovRadians: Math.PI / 3,
                cameraLatitudeRadians: 31.684162 * Math.PI / 180,
                cameraPitchRadians: 0,
                zoomHint: 9,
            }),
            size: { width: 320, height: 180 },
        })
        let observedFailure
        try {
            await result.observation
        } catch (error) {
            observedFailure = error
        }

        expect(observedFailure).to.equal(provenanceFailure)
        expect(result.value.frame.provenance.map(fact => fact.name)).to.deep.equal([
            'cover-map-meta-to-cover-compute',
            'cover-visible-to-terrain-draw',
            'cover-lookup-to-terrain-draw',
            'cover-indirect-to-terrain-draw',
        ])
        expect(fake.calls.queueSubmissions.length).to.be.greaterThan(0)

        graph.dispose()
        await virtualRaster.dispose()
        await runtime.dispose()
    })
})
