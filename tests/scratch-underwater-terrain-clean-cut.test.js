import { expect } from 'chai'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { mat4 } from 'wgpu-matrix'
import { GPURuntime, plane } from 'geoscratch/scratch'
import {
    ViewDemandProducer,
    WebMercatorQuad,
    VirtualRasterResidency,
    WEB_MERCATOR_TERRAIN_TILE_WIREFRAME_FRAGMENT_ENTRY_POINT,
    createVirtualRasterGpuState,
    createGeoFrameController,
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

        if (activePublication !== undefined) throw new Error('Test publication already pending')
        options.events?.push('publish')
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

            options.events?.push('initialize')
            await options.beforeInitialize?.()
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
            const override = options.onReconcile?.(demands, { residency, generation, safetyPage })
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
            options.events?.push('acknowledge')
            await options.beforeAcknowledge?.()
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

function createTestTerrainRenderer({ runtime, surface, virtualRaster, size, observeProvenance, viewAdapter = underwaterTerrainViewAdapter }) {

    return createWebMercatorTerrainRenderer({
        runtime,
        surface,
        fieldLayer: mapFieldLayer({
            id: 'test-dem-height-layer',
            field: virtualRaster.field,
            representation: virtualRaster.representation,
            spatialProfile: virtualRaster.spatialProfile,
            viewAdapter,
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

        expect(renderer).to.include('new WebMercatorQuadCover({')
        expect(renderer).to.include('coverUpload.encode(builder, uploadFrame)')
        expect(renderer).to.include('coverUpload.receipt(uploadFrame, submitted)')
        expect(renderer).to.include('demandProjection.project(selection)')
        expect(renderer).to.include('builder.upload(argumentsUpload)')
        expect(renderer).to.include("'cpu-cover-selection'")
        expect(renderer).to.include("'cpu-source-demand'")
        expect(renderer).to.include("'patch-draw-upload'")
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
            renderer.indexOf('function submitFrame(input: ViewInput)'),
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
        expect(frame).to.include('cover.select(view)')
        expect(frame).to.include('coverUpload.encode(builder, uploadFrame)')
        expect(frame).to.include('demandProjection.project(selection)')
        expect(frame).to.include('builder.upload(argumentsUpload)')
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
            'cpu-cover-map-meta-to-terrain-draw',
            'cpu-cover-patches-to-terrain-draw',
            'cpu-cover-lookup-to-terrain-draw',
            'cpu-patch-draw-arguments-to-terrain-draw',
        ])
        expect(fake.calls.queueSubmissions.length).to.be.greaterThan(0)

        graph.dispose()
        await virtualRaster.dispose()
        await runtime.dispose()
    })

    it('reconciles current CPU intent before any GPU completion or readback', async() => {
        const observed = []
        const fixture = await createCpuFixture({ onReconcile: value => { observed.push(value) } })
        try {
            const frame = await fixture.render()
            const progress = await frame.settlement
            expect(observed).to.have.length(1)
            expect(observed[0].demands.length).to.be.greaterThan(0)
            expect(observed[0].demands.every(d => d.source.frameEpoch === 1)).to.equal(true)
            expect(progress.coverSelection.frameEpoch).to.equal(1)
            expect(progress.projectedDemands.frameEpoch).to.equal(1)
            expect(frame.value.frame.uploadReceipt.kind).to.equal('web-mercator-quad-cover-upload-receipt')
            expect(fixture.fake.readbacks.mapRequests).to.have.length(0)
            expect(frame.needsFollowUp).to.equal(false)
            expect(progress.needsFollowUp).to.equal(false)
            expect(fixture.graph.state().convergenceState).to.equal('converged')
            expect(fixture.graph.contractFacts().countPath).to.equal('cpu-produced-indirect-arguments')
            expect(Object.keys(fixture.graph.contractFacts().passIds)).to.deep.equal(['terrain'])
        } finally { await fixture.dispose() }
    })

    it('retains active request completion in every newer same-selection settlement', async() => {
        const request = deferred()
        let count = 0
        const fixture = await createCpuFixture({ activeRequestCount: () => 1,
            onReconcile: () => ({ requestedCount: ++count === 1 ? 1 : 0,
                retainedCount: count === 1 ? 0 : 1, settlement: request.promise }) })
        try {
            const first = await fixture.render()
            const second = await fixture.render()
            const progress = await second.settlement
            expect(progress.reconciliation.retainedCount).to.equal(1)
            expect(progress.residencyWorkCount).to.equal(1)
            let resourceReady = false
            void progress.residencySettlement.then(() => { resourceReady = true })
            await nextTurn()
            expect(resourceReady).to.equal(false)
            expect(progress.coverSelection.frameEpoch).to.equal(2)
            expect((await first.settlement).coverSelection.frameEpoch).to.equal(1)
            expect(fixture.fake.readbacks.mapRequests).to.have.length(0)
            request.resolve()
            await progress.residencySettlement
        } finally { request.resolve(); await fixture.dispose() }
    })

    it('keeps A-B-A decisions deterministic with fresh provenance while publication acknowledgement is delayed', async() => {
        const ack = deferred(), events = [], observed = []
        let delay = false
        const fixture = await createCpuFixture({ events,
            beforeAcknowledge: () => delay ? ack.promise : undefined,
            onReconcile: value => { observed.push(value) } })
        try {
            delay = true
            const first = await fixture.render(terrainCapture())
            await nextTurn()
            const a = await first.settlement
            const second = await fixture.render(terrainCapture({ offset: 15000, pitch: 35 }))
            const last = await fixture.render(terrainCapture())
            const returned = await last.settlement
            expect(events.filter(x => x === 'publish')).to.have.length(2) // initialization + one pending publication
            expect(events.filter(x => x === 'acknowledge')).to.have.length(2)
            expect(returned.coverSelection.frameEpoch).to.equal(3)
            expect(returned.coverSelection.selectionId).not.to.equal(a.coverSelection.selectionId)
            const keys = p => p.projectedDemands.demands.map(d =>
                [d.requestMatrixLevel, d.tileRow, d.tileCol, d.desiredSampleLevel])
            expect(keys(returned)).to.deep.equal(keys(a))
            expect(observed.map(value => value.generation)).to.deep.equal([1, 2, 3])
            expect(observed.map(value => value.demands[0].source.frameEpoch)).to.deep.equal([1, 2, 3])
            ack.resolve()
            await Promise.all([first.observation, second.observation, last.observation])
            expect(fixture.graph.state().coverFrameEpoch).to.equal(3)
            expect(fixture.graph.state().projectedDemands).to.equal(returned.projectedDemands)
        } finally { ack.resolve(); await fixture.dispose() }
    })

    for (const phase of ['initialize', 'frame']) {
        it(`retries a pre-queue ${phase} failure with the same pending publication`, async() => {
            const events = []
            const fixture = await createCpuFixture({ events, initialize: phase !== 'initialize' })
            const original = fixture.runtime.createSubmission.bind(fixture.runtime)
            const injected = new Error('injected before queue issue')
            let fail = true
            fixture.runtime.createSubmission = options => {
                const builder = original(options)
                if (fail) { builder.submit = () => { fail = false; throw injected } }
                return builder
            }
            try {
                const action = phase === 'initialize' ? () => fixture.graph.initialize() : () => fixture.render()
                expect(await action().then(() => undefined, error => error)).to.equal(injected)
                const retry = await action()
                await retry.observation
                expect(events.filter(x => x === 'publish')).to.have.length(phase === 'initialize' ? 1 : 2)
                expect(events.filter(x => x === 'initialize')).to.have.length(1)
                expect(fixture.graph.state().convergenceState).not.to.equal('failed')
            } finally { await fixture.dispose() }
        })
    }

    for (const phase of ['view', 'arguments', 'render-encoding']) {
        it(`preserves the pending publication when ${phase} construction fails`, async() => {
            const events = [], injected = new Error(`injected ${phase}`)
            let failView = false
            const fixture = await createCpuFixture({ events,
                viewAdapter: { ...underwaterTerrainViewAdapter, read(...args) {
                    if (failView) { failView = false; throw injected }
                    return underwaterTerrainViewAdapter.read(...args)
                } } })
            try {
                if (phase === 'view') failView = true
                if (phase === 'arguments') {
                    const create = fixture.runtime.createUploadCommand.bind(fixture.runtime)
                    let once = true
                    fixture.runtime.createUploadCommand = descriptor => {
                        if (once && descriptor.label.startsWith('Upload indexed terrain arguments')) {
                            once = false; throw injected
                        }
                        return create(descriptor)
                    }
                }
                if (phase === 'render-encoding') {
                    const create = fixture.runtime.createSubmission.bind(fixture.runtime)
                    let once = true
                    fixture.runtime.createSubmission = options => {
                        const builder = create(options)
                        if (once) { once = false; builder.render = () => { throw injected } }
                        return builder
                    }
                }
                expect(await fixture.render().then(() => undefined, error => error)).to.equal(injected)
                const frame = await fixture.render()
                await frame.observation
                expect(events.filter(x => x === 'publish')).to.have.length(2)
                expect((await frame.settlement).coverSelection.frameEpoch).to.equal(1)
            } finally { await fixture.dispose() }
        })
    }

    it('rejects an uncertified CPU cut before drawing or admitting resource intent and can retry', async() => {
        const observed = [], events = []
        const fixture = await createCpuFixture({ events, onReconcile: value => { observed.push(value) } })
        try {
            const before = fixture.fake.calls.queueSubmissions.length
            const capture = terrainCapture()
            const invalid = { ...capture, view: { ...capture.view, clipFromRelativeWorld: Array(16).fill(0) } }
            const error = await fixture.render(invalid).then(() => undefined, error => error)
            expect(error?.diagnostic?.code).to.equal('GEO_WEB_MERCATOR_COVER_CANDIDATE_CAPACITY_EXCEEDED')
            expect(fixture.fake.calls.queueSubmissions).to.have.length(before)
            expect(observed).to.have.length(0)
            expect(fixture.graph.state().coverSelection).to.equal(undefined)
            const frame = await fixture.render()
            await frame.observation
            expect(events.filter(x => x === 'publish')).to.have.length(2)
            expect(observed).to.have.length(1)
        } finally { await fixture.dispose() }
    })

    it('returns issued work when resource reconciliation fails and blocks subsequent frames', async() => {
        const injected = new Error('injected reconciliation failure')
        const fixture = await createCpuFixture({ onReconcile() { throw injected } })
        try {
            const before = fixture.fake.calls.queueSubmissions.length
            const frame = await fixture.render()
            expect(fixture.fake.calls.queueSubmissions.length).to.be.greaterThan(before)
            expect(frame.value.frame.uploadReceipt.kind).to.equal('web-mercator-quad-cover-upload-receipt')
            expect(await frame.observation.then(() => undefined, error => error)).to.equal(injected)
            expect(await fixture.render().then(() => undefined, error => error)).to.equal(injected)
            expect(fixture.graph.state().convergenceState).to.equal('failed')
        } finally { await fixture.dispose() }
    })

    it('keeps queued receipts separate from native submission success', async() => {
        const fixture = await createCpuFixture()
        try {
            fixture.fake.readbacks.rejectNextQueueCompletion(new Error('injected queue completion failure'))
            const frame = await fixture.render()
            expect(frame.value.frame.uploadReceipt.kind).to.equal('web-mercator-quad-cover-upload-receipt')
            expect(await frame.observation.then(() => false, () => true)).to.equal(true)
            expect(fixture.graph.state().convergenceState).to.equal('failed')
            expect(await fixture.render().then(() => false, () => true)).to.equal(true)
        } finally { await fixture.dispose() }
    })

    it('releases all owned renderer objects while keeping borrowed runtime, Surface and raster alive', async() => {
        const fixture = await createCpuFixture()
        try {
            const frame = await fixture.render()
            await frame.observation
            const extra = await fixture.runtime.createBuffer({ size: 16, usage: 8 })
            await (await fixture.render()).observation // unrelated resources cannot invalidate renderer ownership
            extra.dispose()
            fixture.graph.dispose()
            expect(fixture.graph.persistentFacts()).to.deep.equal({ resources: 0, bindLayouts: 0,
                bindSets: 0, pipelines: 0, logicalFootprintBytes: 0 })
            expect(fixture.runtime.diagnostics.snapshot().resources.map(r => r.id).sort()).to.deep.equal(fixture.borrowedIds)
            expect(fixture.surface.isDisposed).to.equal(false)
            expect(fixture.virtualRaster.gpu.atlas.isDisposed).to.equal(false)
            expect(fixture.virtualRaster.inspect().stopped).to.equal(false)
            expect(fixture.runtime.isDisposed).to.equal(false)
            fixture.graph.dispose()
        } finally { await fixture.dispose() }
    })

    for (const method of ['createBuffer', 'createBindSet', 'createRenderPipeline', 'createDrawCommand']) {
        it(`unwinds partial renderer construction at ${method} without disposing borrowed resources`, async() => {
            const fixture = await createCpuFixture({ create: false })
            const original = fixture.runtime[method].bind(fixture.runtime)
            const injected = new Error(`injected ${method}`)
            let count = 0
            fixture.runtime[method] = (...args) => {
                if (++count === 2) throw injected
                return original(...args)
            }
            try {
                const failure = await fixture.create().then(() => undefined, error => error)
                expect(failure).to.equal(injected)
                expect(fixture.runtime.diagnostics.snapshot().resources.map(r => r.id).sort()).to.deep.equal(fixture.borrowedIds)
                expect(fixture.surface.isDisposed).to.equal(false)
                expect(fixture.virtualRaster.gpu.atlas.isDisposed).to.equal(false)
            } finally { await fixture.dispose() }
        })
    }

    it('preserves the original terminal cause when borrowed raster initialization fails', async() => {
        const events = [], injected = new Error('safety cover did not complete')
        const fixture = await createCpuFixture({ events, initialize: false,
            beforeInitialize() { throw injected } })
        try {
            for (let i = 0; i < 2; i++)
                expect(await fixture.graph.initialize().then(() => undefined, error => error)).to.equal(injected)
            expect(events.filter(value => value === 'initialize')).to.have.length(1)
            expect(fixture.virtualRaster.inspect().stopped).to.equal(false)
            expect(fixture.graph.state().convergenceState).to.equal('failed')
        } finally { await fixture.dispose() }
    })

    it('waits for publication acknowledgement before scheduling one staged-page follow-up', async() => {
        const ack = deferred()
        let delay = false, staged = false
        const errors = [], callbacks = new Map()
        let handle = 0
        const fixture = await createCpuFixture({
            beforeAcknowledge: () => delay ? ack.promise : undefined,
            onReconcile(demands, { residency, generation, safetyPage }) {
                if (staged) return
                staged = true
                const page = demands.demands.find(d => d.page.key !== safetyPage.key).page
                residency.reconcileGeneration(generation, [safetyPage, page])
                residency.stage(ownedVirtualRasterPagePayload({ page, width: 256, height: 256,
                    channels: 1, data: new Uint8Array(256 * 256).fill(128),
                    contentVersion: demManifest.contentVersion }), { generation })
            },
        })
        const controller = createGeoFrameController({ maximumInFlightFrames: 2,
            render: () => fixture.render(), onError: error => errors.push(error),
            scheduler: { request(callback) { callbacks.set(++handle, callback); return handle },
                cancel(id) { callbacks.delete(id) } },
        })
        async function runScheduled() {
            const [id, callback] = callbacks.entries().next().value
            callbacks.delete(id); callback(); await nextTurn()
        }
        try {
            delay = true
            controller.invalidate()
            await runScheduled()
            await nextTurn()
            expect(controller.snapshot().submittedFrameCount).to.equal(1)
            expect(callbacks.size).to.equal(0)
            expect(fixture.virtualRaster.residency.inspect().stagedCount).to.equal(1)
            ack.resolve()
            await nextTurn()
            expect(callbacks.size).to.equal(1)
            await runScheduled()
            await nextTurn()
            expect(controller.snapshot().submittedFrameCount).to.equal(2)
            expect(controller.snapshot().followUpFrameCount).to.equal(1)
            expect(callbacks.size).to.equal(0)
            expect(errors).to.deep.equal([])
        } finally { controller.stop(); ack.resolve(); await fixture.dispose() }
    })

    it('does not submit initialization which completes after renderer disposal', async() => {
        const ready = deferred()
        const fixture = await createCpuFixture({ initialize: false, beforeInitialize: () => ready.promise })
        try {
            const initialization = fixture.graph.initialize()
            fixture.graph.dispose()
            const count = fixture.fake.calls.queueSubmissions.length
            ready.resolve()
            expect(await initialization.then(() => false, () => true)).to.equal(true)
            expect(fixture.fake.calls.queueSubmissions).to.have.length(count)
            expect(fixture.graph.state().initialized).to.equal(false)
        } finally { ready.resolve(); await fixture.dispose() }
    })
})

async function createCpuFixture(options = {}) {
    const fake = createFakeGpu({ deferMaps: true })
    const runtime = await GPURuntime.create({ gpu: fake.gpu })
    const surface = runtime.createSurface(createFakeCanvas().canvas, {
        format: 'rgba8unorm', alphaMode: 'premultiplied', size: { width: 320, height: 180 },
    })
    const virtualRaster = await createTestVirtualRaster(runtime, options)
    const borrowedIds = runtime.diagnostics.snapshot().resources.map(r => r.id).sort()
    let graph
    const frames = []
    async function create() {
        graph = await createTestTerrainRenderer({ runtime, surface, virtualRaster,
            size: { width: 320, height: 180 }, viewAdapter: options.viewAdapter })
        return graph
    }
    if (options.create !== false) {
        await create()
        if (options.initialize !== false) await (await graph.initialize()).observation
    }
    return {
        fake, runtime, surface, virtualRaster, borrowedIds, create,
        get graph() { return graph },
        async render(capture = terrainCapture()) {
            const frame = await graph.render(capture)
            void frame.observation.catch(() => undefined)
            void frame.settlement.catch(() => undefined)
            frames.push(frame)
            return frame
        },
        async dispose() {
            await Promise.allSettled(frames.flatMap(frame => [frame.observation, frame.settlement]))
            graph?.dispose()
            await virtualRaster.dispose()
            surface.dispose()
            await runtime.dispose()
        },
    }
}

function deferred() {
    let resolve
    const promise = new Promise(done => { resolve = done })
    return { promise, resolve }
}

function nextTurn() { return new Promise(resolve => setImmediate(resolve)) }

function terrainCapture({ offset = 0, pitch = 0 } = {}) {
    const altitude = 70_000
    const [x, y] = WebMercatorQuad.project([120.980697, 31.684162])
    const camera = [x + offset, y, altitude]
    const matrix = mat4.perspective(Math.PI / 3, 320 / 180, 1, altitude * 16, new Float64Array(16))
    mat4.rotateX(matrix, pitch * Math.PI / 180, matrix)
    return Object.freeze({
        view: Object.freeze({
            far: altitude * 16, near: 1, clipFromRelativeWorld: matrix,
            cameraLow: camera.map(v => v - Math.fround(v)), cameraHigh: camera.map(Math.fround),
            referenceViewport: [320, 180], verticalFovRadians: Math.PI / 3,
            cameraLatitudeRadians: 31.684162 * Math.PI / 180,
            cameraPitchRadians: pitch * Math.PI / 180, zoomHint: 9,
        }),
        presentationSize: { width: 320, height: 180 },
    })
}
