import type {
    GeoFrameResult,
    GeoFrameSettlement,
    GeoViewSnapshot,
    GeoViewSourceCapture,
    MapLibrePlanarCameraState,
    VirtualRasterFeedbackReconciliation,
    VirtualRasterRuntimePublication,
} from 'geoscratch/geo'
import {
    gpuWebMercatorQuadCoverPolicy,
} from 'geoscratch/geo'
import type {
    GPURuntime,
    SubmittedWork,
    Surface,
    SurfaceSize,
} from 'geoscratch/scratch'
import particleSimulationShader from './shaders/particle-simulation.compute.wgsl?raw'
import {
    packFlowCandidateCells,
} from './flow-candidate-packing.ts'
import {
    createFlowContour,
} from './flow-contour.ts'
import type {
    FlowContour,
} from './flow-contour.ts'
import {
    createFlowDemandCoordinator,
} from './flow-demand.ts'
import type {
    FlowDemandCoordinator,
    FlowDemandFrame,
} from './flow-demand.ts'
import {
    createFlowHistory,
} from './flow-history.ts'
import type {
    FlowHistory,
    FlowHistoryFrame,
} from './flow-history.ts'
import {
    flowActivityThresholds,
} from './flow-particle-policy.ts'
import {
    createFlowParticleRender,
} from './flow-particle-render.ts'
import type {
    FlowParticleRender,
} from './flow-particle-render.ts'
import {
    createFlowParticles,
    prepareFlowParticleSpawnBindings,
} from './flow-particles.ts'
import type {
    FlowParticles,
    PreparedFlowParticleSpawnBindings,
} from './flow-particles.ts'
import {
    createFlowRenderView,
} from './flow-render-view.ts'
import type {
    FlowRenderView,
} from './flow-render-view.ts'
import {
    createFlowSpawnIndex,
} from './flow-spawn-index.ts'
import type {
    FlowSpawnIndex,
} from './flow-spawn-index.ts'
import {
    createFlowTemporalBindings,
} from './flow-temporal-bindings.ts'
import type {
    FlowTemporalBindings,
} from './flow-temporal-bindings.ts'
import {
    createFlowViewDemandAdapter,
} from './flow-view-demand.ts'
import type {
    FlowViewDemandAdapter,
} from './flow-view-demand.ts'
import {
    flowFieldViewAdapter,
} from './map.ts'
import type {
    TemporalVelocityRaster,
    TemporalVelocitySnapshot,
} from './temporal-velocity-raster.ts'
import type {
    FlowVelocityTimeRuntime,
} from './velocity-source.ts'

export type FlowFieldRendererOptions = Readonly<{
    runtime: GPURuntime
    surface: Surface
    size: SurfaceSize
    temporal: TemporalVelocityRaster<FlowVelocityTimeRuntime>
    maximumSpeed: number
    cellsPerPageEdge?: number
    particleCount?: number
}>

export type FlowFieldRendererFrame = Readonly<{
    submitted: SubmittedWork
    view: GeoViewSnapshot
    temporal: TemporalVelocitySnapshot
    demand: FlowDemandFrame
    history: FlowHistoryFrame
}>

export type FlowFieldRendererFacts = Readonly<{
    initialized: boolean
    disposed: boolean
    frameCount: number
    cellsPerPageEdge: number
    maximumCandidatePages: number
    maximumCandidateCount: number
    maximumSpeed: number
    temporal: ReturnType<FlowTemporalBindings['facts']>
    viewDemand: ReturnType<FlowViewDemandAdapter['facts']>
    spawn: ReturnType<FlowSpawnIndex['facts']>
    particles: ReturnType<FlowParticles['facts']>
    contour: ReturnType<FlowContour['facts']>
    history: ReturnType<FlowHistory['facts']>
}>

export type FlowFieldRenderer = Readonly<{
    render(
        frameNumber: number,
        capture: GeoViewSourceCapture<MapLibrePlanarCameraState>
    ): Promise<GeoFrameResult<FlowFieldRendererFrame>>
    facts(): FlowFieldRendererFacts
    dispose(): Promise<void>
}>

type FlowFramePublications = Readonly<{
    current: VirtualRasterRuntimePublication
    next: VirtualRasterRuntimePublication
    prefetchRuntime: FlowVelocityTimeRuntime
    prefetch: VirtualRasterRuntimePublication
}>

type FlowDemandReconciliations = Readonly<{
    current: VirtualRasterFeedbackReconciliation
    next: VirtualRasterFeedbackReconciliation
    prefetch: VirtualRasterFeedbackReconciliation
}>

type Disposable = Readonly<{ dispose(): void | Promise<void> }>

const DEFAULT_CELLS_PER_PAGE_EDGE = 64
const DEFAULT_PARTICLE_COUNT = 262_144
const COVER_MAXIMUM_PATCHES = 512
const FLOW_DISPLACEMENT_SCALE = 50
const FLOW_PREDICTION_STEPS = 4

/** Assembles the example-local temporal-raster, support, particle, contour, and history graph. */
export async function createFlowFieldRenderer(
    options: FlowFieldRendererOptions
): Promise<FlowFieldRenderer> {

    const { runtime, surface, temporal } = options ?? {}
    if (runtime === undefined || surface?.runtime !== runtime ||
        temporal?.current?.gpu?.runtime !== runtime ||
        temporal.next?.gpu?.runtime !== runtime || temporal.prefetch?.gpu?.runtime !== runtime ||
        !Number.isFinite(options.maximumSpeed) || options.maximumSpeed <= 0) {
        throw new TypeError('Flow Field renderer requires one runtime, Surface, and temporal raster')
    }
    let size = flowSurfaceSize(options.size)
    const cellsPerPageEdge = boundedCellEdge(
        options.cellsPerPageEdge ?? DEFAULT_CELLS_PER_PAGE_EDGE
    )
    const particleCount = boundedParticleCount(
        options.particleCount ?? DEFAULT_PARTICLE_COUNT
    )
    const model = temporal.current.model
    const maximumCandidatePages = model.addressSpace.pageTableEntryCount
    const maximumCandidateCount = maximumCandidatePages * cellsPerPageEdge ** 2
    if (!Number.isSafeInteger(maximumCandidateCount) || maximumCandidateCount <= 0) {
        throw new RangeError('Flow Field candidate capacity exceeds the safe integer range')
    }
    const thresholds = flowActivityThresholds({ maximumSpeed: options.maximumSpeed })
    const owned: Disposable[] = []
    const own = <Value extends Disposable>(value: Value): Value => {
        owned.push(value)
        return value
    }
    let initialized = false
    let disposed = false
    let disposePromise: Promise<void> | undefined
    let frameCount = 0
    let pendingPrefetchInitialization: Readonly<{
        runtime: FlowVelocityTimeRuntime
        publication: VirtualRasterRuntimePublication
    }> | undefined

    try {
        const initialPublications = await Promise.all([
            temporal.current.initialize(),
            temporal.next.initialize(),
            temporal.prefetch.initialize(),
        ])
        const temporalBindings = own(await createFlowTemporalBindings({
            temporal,
            requestedLevel: 0,
        }))
        const renderView = own(await createFlowRenderView({
            runtime,
            addressCodec: model.addressCodec,
        }))
        const viewDemand = own(await createFlowViewDemandAdapter({
            runtime,
            spatialProfile: model.spatialProfile,
            sourceCoverage: model.coverage,
            policy: gpuWebMercatorQuadCoverPolicy({
                minimumMatrixLevel: Number(model.coverage.limits[0]!.matrixId),
                maximumMatrixLevel: 14,
                maximumPatches: COVER_MAXIMUM_PATCHES,
                cellsPerPatchEdge: 128,
                maximumCellSpanReferencePixels: 5,
                refinementTolerance: 0.005,
            }),
            maximumDemands: COVER_MAXIMUM_PATCHES,
        }))
        const demand = own(createFlowDemandCoordinator({
            temporal,
            cover: viewDemand.cover,
            projection: viewDemand.projection,
            maximumDisplacementMeters:
                options.maximumSpeed * FLOW_DISPLACEMENT_SCALE * FLOW_PREDICTION_STEPS,
            maximumCandidatePages,
            cellsPerPageEdge,
            maximumCandidateCells: maximumCandidateCount,
        }))
        const spawn = own(await createFlowSpawnIndex({
            runtime,
            maximumCandidateCount,
            capacity: maximumCandidateCount,
            temporal: temporalBindings,
        }))
        const particleSpawn = own(await prepareFlowParticleSpawnBindings(runtime, spawn))
        const particles = own(await createFlowParticles({
            runtime,
            maximumCount: particleCount,
            simulationShader: particleSimulationShader,
            temporal: temporalBindings,
            spawn: particleSpawn.module,
            activitySpawn: thresholds.spawn,
            activityKill: thresholds.kill,
            timeStep: 1,
            substeps: 2,
            maximumAgeSteps: 180,
            maximumStagnantSteps: 30,
            minimumDisplacementMeters: 0.25,
        }))
        const particleRender = own(await createFlowParticleRender({
            runtime,
            particles,
            view: renderView,
            targetFormat: 'rgba8unorm',
        }))
        const contour = own(await createFlowContour({
            runtime,
            targetFormat: 'rgba8unorm',
            maximumCandidateCount,
            segmentCapacity: maximumCandidateCount * 2,
            temporal: temporalBindings,
            view: renderView,
        }))
        const history = own(await createFlowHistory({
            runtime,
            surface,
            size,
            mode: 'reproject',
        }))

        const initialPair = temporal.setPendingPublications(
            initialPublications[0],
            initialPublications[1]
        )
        const initialBuilder = runtime.createSubmission({ validation: 'throw' })
        temporal.encodePending(initialBuilder)
        temporal.prefetch.gpu.encode(initialBuilder, initialPublications[2].update)
        const initialSubmitted = initialBuilder.submit()
        await Promise.all([
            observeFlowSubmittedWork(initialSubmitted),
            temporal.acknowledgePending(initialSubmitted),
            temporal.prefetch.acknowledge(initialPublications[2], initialSubmitted),
        ])
        if (initialPair.generation !== temporal.snapshot().generation) {
            throw new Error('Flow Field temporal generation changed during initialization')
        }
        initialized = true

        async function render(
            frameNumber: number,
            capture: GeoViewSourceCapture<MapLibrePlanarCameraState>
        ): Promise<GeoFrameResult<FlowFieldRendererFrame>> {

            assertActive()
            if (!Number.isSafeInteger(frameNumber) || frameNumber <= frameCount ||
                capture?.view === undefined) {
                throw new TypeError('Flow Field render requires one monotonic captured frame')
            }
            const nextSize = flowSurfaceSize(capture.presentationSize)
            if (!sameSize(size, nextSize)) {
                surface.resize(nextSize)
                await history.resize(nextSize)
                size = nextSize
            }
            const frameTemporal = temporal.snapshot()
            const view = flowFieldViewAdapter.read(capture.view, {
                frameEpoch: frameNumber,
                residencySnapshotEpoch: frameTemporal.temporalResidencyEpoch,
            })
            const publications = takeFramePublications()
            const builder = runtime.createSubmission({ validation: 'throw' })
            temporal.setPendingPublications(publications.current, publications.next)
            temporal.encodePending(builder)
            publications.prefetchRuntime.gpu.encode(builder, publications.prefetch.update)

            const demandFrame = demand.encode(builder, view)
            temporalBindings.setRequestedLevel(demandFrame.requestedLevel)
            renderView.encode(builder, view)
            const candidates = packFlowCandidateCells(
                demandFrame.candidateCells,
                model.addressCodec,
                cellsPerPageEdge
            )
            const supportSnapshot = Object.freeze({
                generation: frameTemporal.generation,
                currentSnapshotEpoch: frameTemporal.currentSnapshotEpoch,
                nextSnapshotEpoch: frameTemporal.nextSnapshotEpoch,
                progress: frameTemporal.progress,
                activitySpawn: thresholds.spawn,
                activityKill: thresholds.kill,
            })
            spawn.encode(builder, candidates, demandFrame.candidateCells.length, supportSnapshot)
            particles.encode(builder, particleSpawn.bindings)
            contour.encode(builder, candidates, demandFrame.candidateCells.length, {
                generation: supportSnapshot.generation,
                currentSnapshotEpoch: supportSnapshot.currentSnapshotEpoch,
                nextSnapshotEpoch: supportSnapshot.nextSnapshotEpoch,
                progress: supportSnapshot.progress,
                activityKill: supportSnapshot.activityKill,
            })
            const historyFrame = history.encode(builder, view, [
                particleRender.draw,
                contour.draw,
            ])
            const submitted = builder.submit()
            const reconciliations = demand.reconcile(demandFrame).then(
                requireFlowDemandReconciliations
            )
            const observation = observeFrame(
                submitted,
                publications,
                frameTemporal,
                reconciliations,
                viewDemand,
                contour,
                temporalBindings
            )
            const settlement = reconciliations.then(flowDemandSettlement)
            frameCount = frameNumber
            return Object.freeze({
                observation,
                settlement,
                needsFollowUp: false,
                value: Object.freeze({
                    submitted,
                    view,
                    temporal: frameTemporal,
                    demand: demandFrame,
                    history: historyFrame,
                }),
            })
        }

        function takeFramePublications(): FlowFramePublications {

            const current = temporal.current.publish()
            const next = temporal.next.publish()
            const pendingInitialization = pendingPrefetchInitialization
            const prefetchRuntime = temporal.prefetch
            let prefetch: VirtualRasterRuntimePublication
            if (pendingInitialization === undefined) {
                prefetch = prefetchRuntime.publish()
            } else {
                if (pendingInitialization.runtime !== prefetchRuntime) {
                    throw new Error('Flow Field prefetch initialization provenance is stale')
                }
                prefetch = pendingInitialization.publication
                pendingPrefetchInitialization = undefined
            }
            return Object.freeze({ current, next, prefetchRuntime, prefetch })
        }

        async function observeFrame(
            submitted: SubmittedWork,
            publications: FlowFramePublications,
            encodedTemporal: TemporalVelocitySnapshot,
            reconciliations: Promise<FlowDemandReconciliations>,
            activeViewDemand: FlowViewDemandAdapter,
            activeContour: FlowContour,
            activeBindings: FlowTemporalBindings
        ) {

            const beforeGeneration = temporal.snapshot().generation
            const results = await Promise.all([
                observeFlowSubmittedWork(submitted),
                temporal.acknowledgePending(submitted),
                publications.prefetchRuntime.acknowledge(publications.prefetch, submitted),
                activeViewDemand.observe(submitted),
                activeContour.observeOverflow(submitted),
            ])
            if (encodedTemporal.frameInTime === encodedTemporal.framesPerTime - 1) {
                const latest = await reconciliations
                await Promise.all([
                    latest.current.settlement,
                    latest.next.settlement,
                    latest.prefetch.settlement,
                ])
            }
            const advanced = await temporal.advanceFrame()
            if (advanced.generation !== beforeGeneration) {
                const prefetchRuntime = temporal.prefetch
                const publication = await prefetchRuntime.initialize()
                pendingPrefetchInitialization = Object.freeze({
                    runtime: prefetchRuntime,
                    publication,
                })
                await activeBindings.refresh()
            }
            return results[0]
        }

        function facts(): FlowFieldRendererFacts {

            return Object.freeze({
                initialized,
                disposed,
                frameCount,
                cellsPerPageEdge,
                maximumCandidatePages,
                maximumCandidateCount,
                maximumSpeed: options.maximumSpeed,
                temporal: temporalBindings.facts(),
                viewDemand: viewDemand.facts(),
                spawn: spawn.facts(),
                particles: particles.facts(),
                contour: contour.facts(),
                history: history.facts(),
            })
        }

        function dispose(): Promise<void> {

            if (disposePromise !== undefined) return disposePromise
            disposed = true
            pendingPrefetchInitialization = undefined
            disposePromise = disposeOwned(owned)
            return disposePromise
        }

        function assertActive(): void {

            if (!initialized || disposed) throw new Error('Flow Field renderer is not active')
        }

        return Object.freeze({ render, facts, dispose })
    } catch (error) {
        await disposeOwned(owned)
        throw error
    }
}

function requireFlowDemandReconciliations(value: unknown): FlowDemandReconciliations {

    const candidate = value as Partial<FlowDemandReconciliations> | null
    for (const reconciliation of [ candidate?.current, candidate?.next, candidate?.prefetch ]) {
        if (!Number.isSafeInteger(reconciliation?.requestedCount) ||
            reconciliation!.requestedCount < 0 ||
            typeof reconciliation?.settlement?.then !== 'function') {
            throw new TypeError('Flow Field demand reconciliation facts are invalid')
        }
    }
    return candidate as FlowDemandReconciliations
}

function flowDemandSettlement(
    reconciliations: FlowDemandReconciliations
): GeoFrameSettlement {

    const members = [
        reconciliations.current,
        reconciliations.next,
        reconciliations.prefetch,
    ]
    const residencyWorkCount = members.reduce(
        (sum, reconciliation) => sum + reconciliation.requestedCount,
        0
    )
    return Object.freeze({
        residencySettlement: Promise.all(members.map(member => member.settlement)),
        residencyWorkCount,
        needsFollowUp: residencyWorkCount > 0,
    })
}

async function observeFlowSubmittedWork(submitted: SubmittedWork) {

    const [ nativeOutcome ] = await Promise.all([ submitted.nativeOutcome, submitted.done ])
    if (nativeOutcome.status !== 'observed-succeeded') {
        throw new Error(`Flow Field submission native outcome was ${nativeOutcome.status}`)
    }
    return Object.freeze({ submissionId: submitted.id, nativeStatus: nativeOutcome.status })
}

async function disposeOwned(owned: Disposable[]): Promise<void> {

    const failures: unknown[] = []
    for (const value of owned.reverse()) {
        try {
            await value.dispose()
        } catch (error) {
            failures.push(error)
        }
    }
    owned.length = 0
    if (failures.length > 0) {
        throw new AggregateError(failures, 'Flow Field renderer disposal failed')
    }
}

function flowSurfaceSize(value: SurfaceSize): { width: number, height: number } {

    if (!Number.isSafeInteger(value?.width) || value.width <= 0 ||
        !Number.isSafeInteger(value?.height) || value.height <= 0) {
        throw new RangeError('Flow Field Surface size requires positive integer dimensions')
    }
    return { width: value.width, height: value.height }
}

function sameSize(
    first: Readonly<{ width: number, height: number }>,
    second: Readonly<{ width: number, height: number }>
): boolean {

    return first.width === second.width && first.height === second.height
}

function boundedCellEdge(value: number): number {

    if (!Number.isSafeInteger(value) || value < 64 || value > 256 || 256 % value !== 0) {
        throw new RangeError('Flow Field candidate grid must evenly divide 256 and be at least 64')
    }
    return value
}

function boundedParticleCount(value: number): number {

    if (!Number.isSafeInteger(value) || value <= 0 || value > DEFAULT_PARTICLE_COUNT) {
        throw new RangeError('Flow Field particle count must be within the canonical capacity')
    }
    return value
}
