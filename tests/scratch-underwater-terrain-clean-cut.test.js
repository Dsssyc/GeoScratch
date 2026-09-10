import { expect } from 'chai'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { GPURuntime, plane } from 'geoscratch/scratch'
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
import {
    createWebMercatorTerrainWireframeIndices,
} from '../packages/geoscratch/dist/geo/web-mercator-terrain-renderer.js'
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

async function createTestVirtualRaster(runtime, options = {}) {

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
                activeRequestCount: options.activeRequestCount?.() ?? 0,
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
        reconcileViewDemands(demands) {

            generation++
            residency.reconcileGeneration(generation, [ safetyPage ])
            const override = options.onReconcile?.(demands)
            return Object.freeze({
                requestedCount: override?.requestedCount ?? 0,
                settlement: override?.settlement ?? Promise.resolve(Object.freeze({
                    generation,
                    stagedCount: 0,
                    residentCount: 1,
                    staleCount: 0,
                    failedCount: 0,
                })),
                generation,
                retainedCount: override?.retainedCount ?? 0,
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

    it('keeps indexed plane diagonals aligned with wireframe line topology', () => {

        const edgeCells = 8
        const geometry = plane(Math.log2(edgeCells))
        const positions = Uint32Array.from(geometry.positions, value =>
            Math.round(value * edgeCells)
        )
        const triangleIndices = new Uint32Array(geometry.indices)
        const wireframeIndices = createWebMercatorTerrainWireframeIndices(
            positions,
            triangleIndices,
            edgeCells
        )
        const edgeKey = (left, right) => [ left, right ]
            .map(index => `${positions[index * 2]}/${positions[index * 2 + 1]}`)
            .sort()
            .join('|')
        const triangleEdges = new Set()
        for (let offset = 0; offset < geometry.indices.length; offset += 3) {
            const [ first, second, third ] = triangleIndices.slice(offset, offset + 3)
            triangleEdges.add(edgeKey(first, second))
            triangleEdges.add(edgeKey(second, third))
            triangleEdges.add(edgeKey(third, first))
        }
        const wireframeEdges = new Set()
        for (let offset = 0; offset < wireframeIndices.length; offset += 2) {
            wireframeEdges.add(edgeKey(
                wireframeIndices[offset],
                wireframeIndices[offset + 1]
            ))
        }

        expect(wireframeIndices.length).to.equal(triangleIndices.length)
        expect(wireframeEdges.size).to.equal(edgeCells * edgeCells * 3)
        expect([ ...wireframeEdges ].every(edge => triangleEdges.has(edge))).to.equal(true)
    })

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
        expect(application).to.include('presentationSize: () => canvasPixelSize(canvas)')
        expect(application).to.include('source.elevationRangeMeters')
        expect(application).not.to.include('source.manifest.offset')
        expect(application).not.to.include('source.manifest.scale')
        expect(main).not.to.include('VITE_UNDERWATER_TERRAIN_VARIABLE_LOD_PITCH_DEGREES')
        expect(application).not.to.include('variableLodPitchThresholdRadians')
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
        const demand = read(
            'packages', 'geoscratch', 'src', 'geo', 'gpu-web-mercator-quad-demand.ts'
        )
        const patchDraw = read(
            'packages', 'geoscratch', 'src', 'geo',
            'gpu-web-mercator-quad-patch-draw.ts'
        )
        const terrain = read(
            'packages', 'geoscratch', 'src', 'geo', 'web-mercator-terrain-wgsl.ts'
        )

        expect(renderer).to.include('GpuWebMercatorQuadCover.create(runtime')
        expect(renderer).to.include('cover.encode(builder, frame)')
        expect(renderer).to.include('cover.capture(builder, frame)')
        expect(renderer).to.include('demandProjection.encode(builder, demandFrame)')
        expect(renderer).to.include('patchDraw.encode(builder, patchDrawFrame)')
        expect(renderer).to.include("'inverse-cover-compute'")
        expect(renderer).to.include("'source-demand-compute'")
        expect(renderer).to.include("'patch-draw-compute'")
        expect(renderer).to.include('virtualRaster.reconcileViewDemands(')
        expect(cover).to.include('export class GpuWebMercatorQuadCover')
        expect(cover).not.to.include('desiredSampleLevel')
        expect(cover).not.to.include('sourceLevelCeiling')
        expect(cover).not.to.include('referenceTileSizePixels')
        expect(cover).to.include('maximumCellSpanReferencePixels')
        expect(cover).to.include('refinementTolerance')
        expect(cover).not.to.include('variableLodPitchThresholdRadians')
        expect(cover).not.to.include('selectionMode')
        expect(demand).to.include('desiredSampleLevel')
        expect(demand).to.include('sourceLevelCeiling')
        expect(patchDraw).to.include('drawArgument')
        expect(patchDraw).to.include('elementCount')
        expect(patchDraw).to.include('const DRAW_ARGUMENT_BYTES = 20')
        expect(renderer).to.include(
            "indexBuffer: { region: indexBuffer.region, format: 'uint32' }"
        )
        expect(renderer).to.include('wireframeIndices')
        expect(renderer).to.include("'line-list'")
        expect(terrain).not.to.include('diagonalDistance')
        expect(terrain).not.to.include('fwidth(edgeDistance)')
        expect(terrain).not.to.include('@builtin(primitive_index)')
        expect(wgsl).to.include('fn generateWebMercatorQuadCover(')
        expect(wgsl).to.include('fn evaluateWebMercatorQuadCandidates(')
        expect(wgsl).to.include('@workgroup_size(64)')
        expect(wgsl).to.include('coverCandidateWindow')
        expect(wgsl).not.to.include('coverProjectedSearchRadiusTiles')
        expect(wgsl).to.include('fn coverProjectedCellSpanPixels(')
        expect(wgsl).to.include('fn coverMaximumStretch(')
        expect(wgsl).to.include('(xx - yy) * (xx - yy) + 4.0f * xy * xy')
        expect(wgsl).not.to.include('fn coverProjectedCellAreaScalePixels(')
        expect(wgsl).to.include('fn coverMarkSparseRefinements(')
        expect(wgsl).to.include('fn coverRefinementContains(')
        expect(wgsl).to.include('fn coverMaterializeSparseRefinements(')
        expect(wgsl).to.include('fn coverCompactVisiblePatches(')
        expect(wgsl).to.include('coverBalanceIndexedPatches')
        expect(wgsl).not.to.include('coverMaximumFinerNeighborDelta')
        expect(wgsl).not.to.include('fn coverVariableRefinementWindow(')
        expect(wgsl).not.to.include('fn coverUnionWindow(')
        expect(wgsl).not.to.include('fn coverFullyCoveredByFiner(')
        expect(wgsl).not.to.include(
            'var windows: array<GpuWebMercatorQuadCoverWindow'
        )
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
        expect(wgsl).not.to.include('fn coverUniformWindow(')
        const active = [ renderer, cover, demand, patchDraw, wgsl, terrain ].join('\n')
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
            'maximumCellSpanReferencePixels',
        ]) expect(runtime).not.to.include(forbidden)
    })

    it('keeps the active terrain support graph free of retired internal state', () => {

        const cover = read(
            'packages', 'geoscratch', 'src', 'geo', 'gpu-web-mercator-quad-cover.ts'
        )
        const coverLayout = read(
            'packages', 'geoscratch', 'src', 'geo',
            'gpu-web-mercator-quad-cover-layout.ts'
        )
        const demandLayout = read(
            'packages', 'geoscratch', 'src', 'geo',
            'gpu-web-mercator-quad-demand-layout.ts'
        )
        const virtualGpu = read(
            'packages', 'geoscratch', 'src', 'geo', 'virtual-raster-gpu.ts'
        )
        const virtualRuntime = read(
            'packages', 'geoscratch', 'src', 'geo', 'virtual-raster-runtime.ts'
        )
        const demSource = read('examples', 'underwaterTerrain', 'dem-source.ts')
        const demExecutor = read('examples', 'underwaterTerrain', 'dem-tile-executor.ts')
        const coverLimit = coverLayout.slice(
            coverLayout.indexOf('gpuWebMercatorQuadCoverLimitCodec'),
            coverLayout.indexOf('gpuWebMercatorQuadCoverVerticalBoundsCodec')
        )
        const demandLimit = demandLayout.slice(
            demandLayout.indexOf('gpuWebMercatorQuadDemandLimitCodec'),
            demandLayout.indexOf('gpuWebMercatorQuadDemandCodec')
        )

        expect(cover).not.to.include('readonly #policy:')
        expect(cover).not.to.include('readonly #coverageLimits:')
        expect(coverLayout).not.to.include("{ name: 'coverageLimitCount'")
        expect(coverLimit).not.to.include("{ name: 'matrixLevel'")
        expect(coverLayout).not.to.match(/name: 'reserved\d+'/)
        expect(demandLimit).not.to.include("{ name: 'matrixLevel'")
        for (const removed of [
            'virtualRasterResidencySubmissionStamp',
            'virtualRasterGpuAcknowledgedSnapshot',
            'virtualRasterGpuEncodedSnapshotEpoch',
            'virtualRasterGpuSubmittedSnapshotEpoch',
            'acknowledgedSnapshots',
        ]) expect(virtualGpu).not.to.include(removed)
        expect(virtualRuntime).not.to.include('function nonNegativeInteger(')
        expect(demSource).not.to.include('export type DemVirtualRaster =')
        expect(demExecutor).not.to.include(
            'export function demCacheConfigurationForShard('
        )
    })

    it('validates cached DEM payloads through the canonical Geo cache identity', () => {

        const worker = read('examples', 'underwaterTerrain', 'dem-tile-worker.ts')

        expect(worker).to.include('virtualRasterCacheMetadataMatches(')
        expect(worker).not.to.include("metadata.domain === 'geo.virtual-raster'")
        expect(worker).not.to.include("metadata.payloadRepresentation === 'raw/uint8'")
    })

    it('reuses Geo coverage indexing and keeps elevation decoding inside the DEM source', () => {

        const source = read('examples', 'underwaterTerrain', 'dem-source.ts')
        const application = read('examples', 'underwaterTerrain', 'application.ts')

        expect(source).to.include("import type {\n    TileMatrixCoverage,\n    TileMatrixLimits,")
        expect(source).to.include('coverage.coordinate(index)')
        expect(source).not.to.include('type DemTileMatrixLimit')
        expect(source).not.to.match(/for \(let tileRow[\s\S]*for \(let tileCol/)
        expect(application).to.include('source.elevationRangeMeters')
        expect(application).not.to.match(/source\.manifest\.(?:scale|offset)/)
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
        expect(frame).to.include('demandProjection.encode(builder, demandFrame)')
        expect(frame).to.include('patchDraw.encode(builder, patchDrawFrame)')
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
        expect(application).not.to.include('waitForUnderwaterTerrainMap')
        expect(map).not.to.include('waitForUnderwaterTerrainMap')
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
        const result = await graph.render(terrainCapture())
        void result.settlement.catch(() => undefined)
        let observedFailure
        try {
            await result.observation
        } catch (error) {
            observedFailure = error
        }

        expect(observedFailure).to.equal(provenanceFailure)
        expect(result.value.frame.provenance.map(fact => fact.name)).to.deep.equal([
            'cover-map-meta-to-cover-compute',
            'cover-patches-to-terrain-draw',
            'cover-lookup-to-terrain-draw',
            'patch-draw-indirect-to-terrain-draw',
        ])
        expect(fake.calls.queueSubmissions.length).to.be.greaterThan(0)

        graph.dispose()
        await virtualRaster.dispose()
        await runtime.dispose()
    })

    it('shares pending same-decision feedback without polling through newer frames', async() => {

        const fake = createFakeGpu({ deferMaps: true })
        const runtime = await GPURuntime.create({ gpu: fake.gpu })
        const fakeCanvas = createFakeCanvas()
        const surface = runtime.createSurface(fakeCanvas.canvas, {
            label: 'Underwater Terrain feedback-convergence surface',
            format: 'rgba8unorm',
            alphaMode: 'premultiplied',
            size: { width: 320, height: 180 },
        })
        const virtualRaster = await createTestVirtualRaster(runtime)
        const graph = await createTestTerrainRenderer({
            runtime,
            surface,
            virtualRaster,
            size: { width: 320, height: 180 },
        })
        const initialized = await graph.initialize()
        await initialized.observation
        const capture = terrainCapture()
        let first
        let second
        try {
            first = await graph.render(capture)
            void first.settlement.catch(() => undefined)
            second = await graph.render(capture)
            void second.settlement.catch(() => undefined)

            expect(first.needsFollowUp).to.equal(false)
            expect(second.needsFollowUp).to.equal(false)
            expect(second.settlement).to.equal(first.settlement)
        } finally {
            await Promise.allSettled([
                first?.observation,
                second?.observation,
            ].filter(Boolean))
            graph.dispose()
            resolveFeedbackMaps(fake)
            await virtualRaster.dispose()
            await runtime.dispose()
        }
    })

    it('starts feedback mapping for the first frame without submitting another frame', async() => {

        const observed = []
        const fixture = await createFeedbackFixture({ onReconcile: value => { observed.push(value) } })
        try {
            const frame = await fixture.render()
            await nextFeedbackTurn()
            expect(fixture.fake.readbacks.mapRequests).to.have.length(3)
            expect(observed).to.have.length(0)
            resolveFeedbackMaps(fixture.fake)
            const settled = await frame.settlement
            expect(settled.superseded).to.equal(false)
            expect(settled.coverFeedback.frameEpoch).to.equal(1)
            expect(observed.map(value => value.generation)).to.deep.equal([1])
            expect(fixture.graph.state().frame).to.equal(1)
        } finally { await fixture.dispose() }
    })

    it('uses an older complete demand observation without adopting its geometry as current', async() => {

        const observed = []
        let finishRequest
        const pending = new Promise(resolve => { finishRequest = resolve })
        const fixture = await createFeedbackFixture({
            activeRequestCount: () => 1,
            onReconcile(value) {
                observed.push(value)
                return { requestedCount: observed.length === 1 ? 1 : 0,
                    retainedCount: observed.length === 1 ? 0 : 1, settlement: pending }
            },
        })
        try {
            const first = await fixture.render()
            await nextFeedbackTurn()
            const capture = terrainCapture()
            const second = await fixture.render({ ...capture, view: { ...capture.view, cameraHigh: [1, 0, 100] } })
            resolveFeedbackMaps(fixture.fake)
            const older = await first.settlement
            expect(older.superseded).to.equal(true)
            expect(observed.map(value => value.generation)).to.deep.equal([1])
            expect(observed[0].demands[0].source.frameEpoch).to.equal(1)
            expect(fixture.graph.state().coverFeedback).to.equal(undefined)
            await nextFeedbackTurn()
            resolveFeedbackMaps(fixture.fake)
            const current = await second.settlement
            expect(current.superseded).to.equal(false)
            expect(observed.map(value => value.generation)).to.deep.equal([1, 2])
            expect(current.reconciliation.requestedCount).to.equal(0)
            expect(current.residencyWorkCount).to.equal(1)
            expect(current.residencySettlement).to.equal(pending)
            expect(fixture.graph.state().coverFrameEpoch).to.equal(2)
        } finally { finishRequest(); await fixture.dispose() }
    })

    it('does not reconcile feedback which completes after renderer disposal', async() => {

        const observed = []
        const fixture = await createFeedbackFixture({ onReconcile: value => { observed.push(value) } })
        try {
            const frame = await fixture.render()
            await nextFeedbackTurn()
            fixture.graph.dispose()
            resolveFeedbackMaps(fixture.fake)
            await frame.settlement
            await nextFeedbackTurn()
            expect(observed).to.have.length(0)
            expect(fixture.graph.state().disposed).to.equal(true)
        } finally { await fixture.dispose() }
    })

    it('bounds capture-capacity waiting to the latest frame and wakes it when a slot is released', async() => {

        const fixture = await createFeedbackFixture()
        const captureAt = x => {
            const capture = terrainCapture()
            return { ...capture, view: { ...capture.view, cameraHigh: [x, 0, 100] } }
        }
        try {
            const first = await fixture.render(captureAt(0))
            await nextFeedbackTurn()
            await fixture.render(captureAt(1))
            let previousWaiter
            for (let x = 2; x < 12; x++) {
                const current = await fixture.render(captureAt(x))
                expect(current.needsFollowUp).to.equal(false)
                if (previousWaiter) {
                    const retired = await previousWaiter.settlement
                    expect(retired.residencyWorkCount).to.equal(0)
                    expect(retired.needsFollowUp).to.equal(false)
                }
                previousWaiter = current
            }
            let waitingResolved = false
            void previousWaiter.settlement.then(() => { waitingResolved = true })
            await nextFeedbackTurn()
            expect(waitingResolved).to.equal(false)
            expect(fixture.graph.state().readbackInFlightCount).to.equal(2)
            resolveFeedbackMaps(fixture.fake)
            await first.settlement
            const wake = await previousWaiter.settlement
            expect(wake.needsFollowUp).to.equal(true)
            expect(wake.coverFeedback).to.equal(undefined)
            expect(wake.demandFeedback).to.equal(undefined)
            expect(fixture.graph.state().coverFeedback).to.equal(undefined)
        } finally { await fixture.dispose() }
    })

    it('does not certify a returned A view with the earlier A observation', async() => {

        const observed = []
        const fixture = await createFeedbackFixture({ onReconcile: value => { observed.push(value) } })
        try {
            const capture = terrainCapture()
            const firstA = await fixture.render(capture)
            await nextFeedbackTurn()
            await fixture.render({ ...capture, view: { ...capture.view, cameraHigh: [1, 0, 100] } })
            const returnedA = await fixture.render(capture)
            resolveFeedbackMaps(fixture.fake)
            expect((await firstA.settlement).superseded).to.equal(true)
            const progress = await returnedA.settlement
            expect(progress.coverFeedback).to.equal(undefined)
            expect(fixture.graph.state().coverFeedback).to.equal(undefined)
            expect(observed.map(value => value.generation)).to.deep.equal([1])
            expect(observed[0].demands[0].source.frameEpoch).to.equal(1)
        } finally { await fixture.dispose() }
    })

    for (const stop of ['dispose', 'invalid-feedback']) {
        it(`settles the capture waiter on ${stop}`, async() => {

            const fixture = await createFeedbackFixture({ invalid: stop === 'invalid-feedback' ? 'demand' : undefined })
            const capture = terrainCapture()
            try {
                await fixture.render(capture)
                await nextFeedbackTurn()
                await fixture.render({ ...capture, view: { ...capture.view, cameraHigh: [1, 0, 100] } })
                const waiting = await fixture.render({ ...capture, view: { ...capture.view, cameraHigh: [2, 0, 100] } })
                if (stop === 'dispose') fixture.graph.dispose()
                resolveFeedbackMaps(fixture.fake)
                if (stop === 'dispose') {
                    expect((await waiting.settlement).residencyWorkCount).to.equal(0)
                } else {
                    const failure = await waiting.settlement.then(() => undefined, error => error)
                    expect(failure?.diagnostic?.code).to.equal('GEO_WEB_MERCATOR_DEMAND_FEEDBACK_INVALID')
                }
            } finally { await fixture.dispose() }
        })
    }

    for (const invalid of ['cover', 'demand']) {
        it(`rejects invalid ${invalid} feedback before admitting resource intent`, async() => {

            const observed = []
            const fixture = await createFeedbackFixture({ invalid,
                onReconcile: value => { observed.push(value) } })
            try {
                const frame = await fixture.render()
                await nextFeedbackTurn()
                expect(fixture.fake.readbacks.mapRequests).to.have.length(3)
                resolveFeedbackMaps(fixture.fake)
                const failure = await frame.settlement.then(() => undefined, error => error)
                expect(failure?.diagnostic?.code).to.equal(invalid === 'cover'
                    ? 'GEO_WEB_MERCATOR_COVER_FEEDBACK_INVALID'
                    : 'GEO_WEB_MERCATOR_DEMAND_FEEDBACK_INVALID')
                expect(observed).to.have.length(0)
            } finally { await fixture.dispose() }
        })
    }
})

async function createFeedbackFixture(options = {}) {

    const fake = createFakeGpu({ deferMaps: true })
    // These bytes emulate transport output only; native browser gates validate LoD.
    const submit = fake.device.queue.submit.bind(fake.device.queue)
    fake.device.queue.submit = commandBuffers => {
        for (const parity of [0, 1]) {
            const find = name => fake.calls.buffers.find(buffer =>
                buffer.descriptor.label?.includes(`${name} ${parity}`))
            const meta = find('GPU WebMercatorQuad cover map metadata')
            if (!meta) continue
            const view = new DataView(meta.data.buffer)
            const epoch = view.getUint32(124, true)
            const residencyEpoch = view.getUint32(128, true)
            const write = (name, words) => find(name).data.set(new Uint8Array(new Uint32Array(words).buffer))
            write('GPU WebMercatorQuad cover state', [options.invalid === 'cover' ? 0 : epoch,
                1, 1, 0, 0, 5, 5, 0, 5, 256, 256])
            write('GPU WebMercatorQuad demand state', [options.invalid === 'demand' ? 0 : epoch, 1, 0, 10])
            write('GPU WebMercatorQuad projected demands', [5, 10, 5, 12, 26, 1, epoch, residencyEpoch])
        }
        return submit(commandBuffers)
    }
    const runtime = await GPURuntime.create({ gpu: fake.gpu })
    const surface = runtime.createSurface(createFakeCanvas().canvas, {
        format: 'rgba8unorm', alphaMode: 'premultiplied', size: { width: 320, height: 180 },
    })
    const virtualRaster = await createTestVirtualRaster(runtime, options)
    const graph = await createTestTerrainRenderer({ runtime, surface, virtualRaster,
        size: { width: 320, height: 180 } })
    await (await graph.initialize()).observation
    const frames = []
    return {
        fake, graph,
        async render(capture = terrainCapture()) {
            const frame = await graph.render(capture)
            void frame.settlement.catch(() => undefined)
            frames.push(frame)
            return frame
        },
        async dispose() {
            graph.dispose()
            for (let turn = 0; turn < 3; turn++) {
                resolveFeedbackMaps(fake)
                await nextFeedbackTurn()
            }
            await Promise.allSettled(frames.flatMap(frame => [frame.observation, frame.settlement]))
            await virtualRaster.dispose()
            await runtime.dispose()
        },
    }
}

function resolveFeedbackMaps(fake) {

    for (const [index, request] of fake.readbacks.mapRequests.entries()) {
        if (!request.settled) fake.readbacks.resolveMap(index)
    }
}

function nextFeedbackTurn() { return new Promise(resolve => setImmediate(resolve)) }

function terrainCapture() {

    return Object.freeze({
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
            referenceViewport: [ 320, 180 ],
            verticalFovRadians: Math.PI / 3,
            cameraLatitudeRadians: 31.684162 * Math.PI / 180,
            cameraPitchRadians: 0,
            zoomHint: 9,
        }),
        presentationSize: { width: 320, height: 180 },
    })
}
