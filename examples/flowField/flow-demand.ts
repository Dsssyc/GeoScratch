import { WebMercatorQuad } from 'geoscratch/geo'
import type {
    GeoViewSnapshot,
    GpuWebMercatorQuadProjectedDemand,
    VirtualRasterAddressSpace,
    VirtualRasterPageIdentity,
    ViewDemandProducer,
    ViewTileDemandSet,
} from 'geoscratch/geo'
import type { SubmissionBuilder } from 'geoscratch/scratch'

export type FlowCandidateCell = Readonly<{
    page: VirtualRasterPageIdentity
    requestedLevel: number
    cellX: number
    cellY: number
}>

export type FlowProjectedDemandBatch = Readonly<{
    kind: 'flow-projected-demand-batch'
    frameEpoch: number
    residencySnapshotEpoch: number
    overflowCount: number
    demands: readonly GpuWebMercatorQuadProjectedDemand[]
}>

export type FlowDemandRuntime = Readonly<{
    addressSpace: VirtualRasterAddressSpace
    viewDemandProducer: Pick<ViewDemandProducer, 'kind' | 'id' | 'maxDemands' | 'produce'>
    reconcileViewDemands(demands: ViewTileDemandSet): unknown
}>

export type FlowDemandTemporalRuntimes = Readonly<{
    current: FlowDemandRuntime
    next: FlowDemandRuntime
    prefetch: FlowDemandRuntime
}>

export type FlowDemandCoverHook<CoverFrame> = Readonly<{
    encode(builder: SubmissionBuilder, view: GeoViewSnapshot): CoverFrame
    dispose(): void | Promise<void>
}>

export type FlowDemandProjectionHook<CoverFrame> = Readonly<{
    encode(
        builder: SubmissionBuilder,
        coverFrame: CoverFrame,
        view: GeoViewSnapshot
    ): FlowProjectedDemandBatch
    dispose(): void | Promise<void>
}>

export type FlowDemandCandidateOptions = Readonly<{
    view: GeoViewSnapshot
    batch: FlowProjectedDemandBatch
    addressSpace: VirtualRasterAddressSpace
    maximumDisplacementMeters: number
    maximumCandidatePages: number
    cellsPerPageEdge: number
    maximumCandidateCells: number
}>

export type FlowDemandCandidates = Readonly<{
    requestedLevel: number
    candidatePages: readonly VirtualRasterPageIdentity[]
    candidateCells: readonly FlowCandidateCell[]
}>

export type FlowDemandFrame = Readonly<{
    view: GeoViewSnapshot
    generation: number
    requestedLevel: number
    candidatePages: readonly VirtualRasterPageIdentity[]
    candidateCells: readonly FlowCandidateCell[]
}>

export type FlowDemandCoordinator = Readonly<{
    encode(builder: SubmissionBuilder, view: GeoViewSnapshot): FlowDemandFrame
    reconcile(frame: FlowDemandFrame): Promise<unknown>
    dispose(): Promise<void>
}>

export type FlowDemandCoordinatorOptions<CoverFrame> = Readonly<{
    temporal: FlowDemandTemporalRuntimes
    cover: FlowDemandCoverHook<CoverFrame>
    projection: FlowDemandProjectionHook<CoverFrame>
    maximumDisplacementMeters: number
    maximumCandidatePages: number
    cellsPerPageEdge: number
    maximumCandidateCells: number
}>

type SpatialCandidate = Readonly<{
    matrixLevel: number
    tileRow: number
    tileCol: number
    requestedLevel: number
    sourceLevelCeiling: number
    priorityScore: number
}>

type CandidateBuild = Readonly<{
    public: FlowDemandCandidates
    spatial: readonly SpatialCandidate[]
}>

type FrameRecord = {
    owner: object
    runtimes: readonly [FlowDemandRuntime, FlowDemandRuntime, FlowDemandRuntime]
    spatial: readonly SpatialCandidate[]
    reconciled: boolean
}

const frameRecords = new WeakMap<FlowDemandFrame, FrameRecord>()

/** Expands projected source demand into deterministic bounded pages and logical cells. */
export function createFlowDemandCandidates(
    options: FlowDemandCandidateOptions
): FlowDemandCandidates {

    return buildCandidates(options).public
}

/** Coordinates one bounded view-derived spatial demand set across three temporal runtimes. */
export function createFlowDemandCoordinator<CoverFrame>(
    options: FlowDemandCoordinatorOptions<CoverFrame>
): FlowDemandCoordinator {

    validateCoordinatorOptions(options)
    const owner = Object.freeze({ kind: 'flow-demand-coordinator-owner' })
    let generation = 0
    let latestFrame: FlowDemandFrame | undefined
    let disposed = false
    let disposePromise: Promise<void> | undefined

    function encode(builder: SubmissionBuilder, view: GeoViewSnapshot): FlowDemandFrame {

        assertActive()
        const runtimes = snapshotRuntimes(options.temporal)
        assertDistinctProducerIds(runtimes)
        const coverFrame = options.cover.encode(builder, view)
        const projected = options.projection.encode(builder, coverFrame, view)
        const candidates = buildCandidates({
            view,
            batch: projected,
            addressSpace: runtimes[0].addressSpace,
            maximumDisplacementMeters: options.maximumDisplacementMeters,
            maximumCandidatePages: options.maximumCandidatePages,
            cellsPerPageEdge: options.cellsPerPageEdge,
            maximumCandidateCells: options.maximumCandidateCells,
        })
        for (const runtime of runtimes) {
            if (candidates.spatial.length > runtime.viewDemandProducer.maxDemands) {
                throw new RangeError(
                    'Flow demand candidate count exceeds a temporal runtime producer capacity'
                )
            }
        }
        const frame = Object.freeze({
            view,
            generation: ++generation,
            requestedLevel: candidates.public.requestedLevel,
            candidatePages: candidates.public.candidatePages,
            candidateCells: candidates.public.candidateCells,
        })
        frameRecords.set(frame, {
            owner,
            runtimes,
            spatial: candidates.spatial,
            reconciled: false,
        })
        latestFrame = frame
        return frame
    }

    async function reconcile(frame: FlowDemandFrame): Promise<unknown> {

        assertActive()
        const record = frameRecords.get(frame)
        if (record?.owner !== owner) {
            throw new TypeError('Flow demand reconciliation requires one owned frame')
        }
        if (latestFrame !== frame) {
            throw new Error('Flow demand frame was superseded by a newer view decision')
        }
        if (record.reconciled) {
            throw new Error('Flow demand frame can be reconciled exactly once')
        }
        const currentRuntimes = snapshotRuntimes(options.temporal)
        if (currentRuntimes.some((runtime, index) => runtime !== record.runtimes[index])) {
            throw new Error('Flow demand temporal provenance is stale after runtime rotation')
        }
        assertDistinctProducerIds(currentRuntimes)

        const [ currentSet, nextSet, prefetchSet ] = [
            produceDemandSet(record.runtimes[0], record.spatial, frame, 'required'),
            produceDemandSet(record.runtimes[1], record.spatial, frame, 'required'),
            produceDemandSet(record.runtimes[2], record.spatial, frame, 'prefetch'),
        ]
        record.reconciled = true
        return Object.freeze({
            current: record.runtimes[0].reconcileViewDemands(currentSet),
            next: record.runtimes[1].reconcileViewDemands(nextSet),
            prefetch: record.runtimes[2].reconcileViewDemands(prefetchSet),
        })
    }

    function dispose(): Promise<void> {

        if (disposePromise !== undefined) return disposePromise
        disposed = true
        disposePromise = disposeHooks(options)
        return disposePromise
    }

    function assertActive(): void {

        if (disposed) throw new Error('Flow demand coordinator is disposed')
    }

    return Object.freeze({ encode, reconcile, dispose })
}

function buildCandidates(options: FlowDemandCandidateOptions): CandidateBuild {

    validateCandidateOptions(options)
    const coverage = options.addressSpace.tileCoverage!
    const spatialByKey = new Map<string, SpatialCandidate>()
    for (const demand of options.batch.demands) {
        validateProjectedDemand(demand, options.view)
        const matrix = WebMercatorQuad.matrix(String(demand.requestMatrixLevel))
        const pageWorldExtent = matrix.cellSize * matrix.tileWidth
        const displacementPages = Math.ceil(
            options.maximumDisplacementMeters / pageWorldExtent
        )
        if (!Number.isSafeInteger(displacementPages)) {
            throw new RangeError('Flow demand displacement halo exceeds the safe integer range')
        }
        const haloPages = 1 + displacementPages
        if (!Number.isSafeInteger(haloPages)) {
            throw new RangeError('Flow demand combined halo exceeds the safe integer range')
        }
        const limit = coverage.limit(String(demand.requestMatrixLevel))
        if (limit === undefined || !coverage.contains({
            matrixId: String(demand.requestMatrixLevel),
            tileRow: demand.tileRow,
            tileCol: demand.tileCol,
        })) {
            throw new RangeError('Flow projected demand is outside velocity source coverage')
        }
        const minimumRow = Math.max(limit.minTileRow, demand.tileRow - haloPages)
        const maximumRow = Math.min(limit.maxTileRow, demand.tileRow + haloPages)
        const tileColumns = haloColumns(
            demand.tileCol,
            haloPages,
            matrix.matrixWidth,
            limit.minTileCol,
            limit.maxTileCol,
            options.maximumCandidatePages
        )
        for (let tileRow = minimumRow; tileRow <= maximumRow; tileRow++) {
            for (const tileCol of tileColumns) {
                const candidate = Object.freeze({
                    matrixLevel: demand.requestMatrixLevel,
                    tileRow,
                    tileCol,
                    requestedLevel: demand.desiredSampleLevel,
                    sourceLevelCeiling: demand.sourceLevelCeiling,
                    priorityScore: cameraPriority(
                        options.view,
                        demand.desiredSampleLevel,
                        demand.requestMatrixLevel,
                        tileRow,
                        tileCol
                    ),
                })
                const key = spatialKey(candidate)
                const existing = spatialByKey.get(key)
                if (existing === undefined || betterCandidate(candidate, existing)) {
                    spatialByKey.set(key, candidate)
                }
                if (spatialByKey.size > options.maximumCandidatePages) {
                    throw new RangeError('Flow demand candidate page capacity was exceeded')
                }
            }
        }
    }

    const spatial = Object.freeze([ ...spatialByKey.values() ].sort(compareSpatial))
    const candidatePages = Object.freeze(spatial.map(candidate =>
        options.addressSpace.pageFromTile({
            matrixId: String(candidate.matrixLevel),
            tileRow: candidate.tileRow,
            tileCol: candidate.tileCol,
        })
    ))
    const cellCount = candidatePages.length * options.cellsPerPageEdge ** 2
    if (!Number.isSafeInteger(cellCount) || cellCount > options.maximumCandidateCells) {
        throw new RangeError('Flow demand candidate cell capacity was exceeded')
    }
    const candidateCells: FlowCandidateCell[] = []
    for (let pageIndex = 0; pageIndex < candidatePages.length; pageIndex++) {
        const page = candidatePages[pageIndex]!
        const requestedLevel = candidateSampleLevel(
            options.addressSpace,
            spatial[pageIndex]!
        )
        for (let cellY = 0; cellY < options.cellsPerPageEdge; cellY++) {
            for (let cellX = 0; cellX < options.cellsPerPageEdge; cellX++) {
                candidateCells.push(Object.freeze({
                    page,
                    requestedLevel,
                    cellX,
                    cellY,
                }))
            }
        }
    }
    const requestedLevel = candidateCells.length === 0
        ? 0
        : candidateCells.reduce(
            (finest, candidate) => Math.min(finest, candidate.requestedLevel),
            options.addressSpace.levelCount - 1
        )
    return Object.freeze({
        public: Object.freeze({
            requestedLevel,
            candidatePages,
            candidateCells: Object.freeze(candidateCells),
        }),
        spatial,
    })
}

function candidateSampleLevel(
    addressSpace: VirtualRasterAddressSpace,
    candidate: SpatialCandidate
): number {

    const sampleMatrixLevel = Math.min(
        candidate.requestedLevel,
        candidate.sourceLevelCeiling
    )
    return addressSpace.levelForMatrix(String(sampleMatrixLevel))
}

function produceDemandSet(
    runtime: FlowDemandRuntime,
    spatial: readonly SpatialCandidate[],
    frame: FlowDemandFrame,
    usage: 'required' | 'prefetch'
): ViewTileDemandSet {

    if (spatial.length > runtime.viewDemandProducer.maxDemands) {
        throw new RangeError('Flow demand fan-out exceeds its runtime producer capacity')
    }
    const intent = usage === 'prefetch' ? 'prefetch' as const : 'refinement' as const
    const priorityClass = usage === 'prefetch' ? 'background' as const : 'user-visible' as const
    const produced = runtime.viewDemandProducer.produce({
        view: frame.view,
        generation: frame.generation,
        demands: spatial.map(candidate => ({
            page: runtime.addressSpace.pageFromTile({
                matrixId: String(candidate.matrixLevel),
                tileRow: candidate.tileRow,
                tileCol: candidate.tileCol,
            }),
            desiredSampleLevel: candidate.requestedLevel,
            sourceLevelCeiling: candidate.sourceLevelCeiling,
            priority: Object.freeze({
                class: priorityClass,
                score: candidate.priorityScore,
            }),
            intent,
            reason: usage === 'prefetch'
                ? `flow-velocity-prefetch:z${candidate.requestedLevel}`
                : `flow-velocity-required:z${candidate.requestedLevel}`,
        })),
    })
    if (produced.demands.length !== spatial.length) {
        throw new RangeError('Flow demand producer truncated a capacity-checked spatial set')
    }
    return produced
}

function validateCandidateOptions(options: FlowDemandCandidateOptions): void {

    if (options?.view?.kind !== 'geo-view-snapshot' ||
        options?.batch?.kind !== 'flow-projected-demand-batch' ||
        options.addressSpace?.kind !== 'virtual-raster-address-space' ||
        options.addressSpace.tileCoverage?.tileMatrixSet !== WebMercatorQuad ||
        !nonNegativeFinite(options.maximumDisplacementMeters) ||
        !positiveInteger(options.maximumCandidatePages) ||
        !positiveInteger(options.cellsPerPageEdge) ||
        !positiveInteger(options.maximumCandidateCells) ||
        !Array.isArray(options.batch.demands) || options.batch.overflowCount !== 0) {
        throw new TypeError('Flow demand candidates require bounded WebMercator projection facts')
    }
    if (options.batch.frameEpoch !== options.view.frameEpoch) {
        throw new Error('Flow demand batch frame provenance is stale')
    }
    if (options.batch.residencySnapshotEpoch !== options.view.residencySnapshotEpoch) {
        throw new Error('Flow demand batch residency provenance is stale')
    }
}

function validateProjectedDemand(
    demand: GpuWebMercatorQuadProjectedDemand,
    view: GeoViewSnapshot
): void {

    if (!matrixLevel(demand?.desiredSampleLevel) ||
        !matrixLevel(demand?.sourceLevelCeiling) ||
        !matrixLevel(demand?.requestMatrixLevel) ||
        demand.desiredSampleLevel < demand.requestMatrixLevel ||
        demand.requestMatrixLevel > demand.sourceLevelCeiling ||
        !Number.isSafeInteger(demand.tileRow) || demand.tileRow < 0 ||
        !Number.isSafeInteger(demand.tileCol) || demand.tileCol < 0 ||
        !Number.isFinite(demand.priority)) {
        throw new TypeError('Flow projected demand contains invalid source tile facts')
    }
    if (demand.decisionFrameEpoch !== view.frameEpoch) {
        throw new Error('Flow projected demand frame provenance is stale')
    }
    if (demand.residencySnapshotEpoch !== view.residencySnapshotEpoch) {
        throw new Error('Flow projected demand residency provenance is stale')
    }
}

function validateCoordinatorOptions<CoverFrame>(
    options: FlowDemandCoordinatorOptions<CoverFrame>
): void {

    if (typeof options?.cover?.encode !== 'function' ||
        typeof options.cover.dispose !== 'function' ||
        typeof options?.projection?.encode !== 'function' ||
        typeof options.projection.dispose !== 'function') {
        throw new TypeError('Flow demand coordinator requires cover and projection encode hooks')
    }
    snapshotRuntimes(options.temporal)
    if (!nonNegativeFinite(options.maximumDisplacementMeters) ||
        !positiveInteger(options.maximumCandidatePages) ||
        !positiveInteger(options.cellsPerPageEdge) ||
        !positiveInteger(options.maximumCandidateCells)) {
        throw new TypeError('Flow demand coordinator requires finite bounded demand policy')
    }
}

function snapshotRuntimes(
    temporal: FlowDemandTemporalRuntimes
): readonly [FlowDemandRuntime, FlowDemandRuntime, FlowDemandRuntime] {

    const runtimes = [ temporal?.current, temporal?.next, temporal?.prefetch ] as const
    for (const runtime of runtimes) {
        if (runtime?.addressSpace?.kind !== 'virtual-raster-address-space' ||
            runtime.addressSpace.tileCoverage?.tileMatrixSet !== WebMercatorQuad ||
            runtime.viewDemandProducer?.kind !== 'view-demand-producer' ||
            typeof runtime.viewDemandProducer.id !== 'string' ||
            !Number.isSafeInteger(runtime.viewDemandProducer.maxDemands) ||
            runtime.viewDemandProducer.maxDemands < 0 ||
            typeof runtime.viewDemandProducer.produce !== 'function' ||
            typeof runtime.reconcileViewDemands !== 'function') {
            throw new TypeError('Flow demand requires three public Virtual Raster runtime surfaces')
        }
    }
    return runtimes
}

function assertDistinctProducerIds(
    runtimes: readonly [FlowDemandRuntime, FlowDemandRuntime, FlowDemandRuntime]
): void {

    const ids = runtimes.map(runtime => runtime.viewDemandProducer.id)
    if (new Set(ids).size !== ids.length) {
        throw new TypeError('Flow temporal runtimes require unique view-demand producer identities')
    }
}

async function disposeHooks<CoverFrame>(
    options: FlowDemandCoordinatorOptions<CoverFrame>
): Promise<void> {

    const failures: unknown[] = []
    for (const hook of [ options.projection, options.cover ]) {
        try {
            await hook.dispose()
        } catch (error) {
            failures.push(error)
        }
    }
    if (failures.length > 0) {
        throw new AggregateError(failures, 'Flow demand hook disposal failed')
    }
}

function cameraPriority(
    view: GeoViewSnapshot,
    requestedLevel: number,
    matrixLevel: number,
    tileRow: number,
    tileCol: number
): number {

    const matrixId = String(matrixLevel)
    const camera = WebMercatorQuad.tileFromProjected([
        view.cameraHigh[0] + view.cameraLow[0],
        view.cameraHigh[1] + view.cameraLow[1],
    ], matrixId)
    const matrixWidth = WebMercatorQuad.matrix(matrixId).matrixWidth
    const distance = Math.abs(tileRow - camera.tileRow) +
        wrappedDistance(tileCol, camera.tileCol, matrixWidth)
    return requestedLevel * 1_000_000 + 999_999 - Math.min(distance, 999_999)
}

function wrappedDistance(left: number, right: number, width: number): number {

    const raw = Math.abs(left - right)
    return Math.min(raw, width - raw)
}

function haloColumns(
    center: number,
    halo: number,
    matrixWidth: number,
    minimum: number,
    maximum: number,
    capacity: number
): readonly number[] {

    const columns = new Set<number>()
    const add = (column: number) => {
        if (column >= minimum && column <= maximum) columns.add(column)
        if (columns.size > capacity) {
            throw new RangeError('Flow demand candidate page capacity was exceeded')
        }
    }
    if (halo * 2 + 1 >= matrixWidth) {
        for (let column = minimum; column <= maximum; column++) add(column)
    } else {
        for (let offset = -halo; offset <= halo; offset++) {
            add(positiveModulo(center + offset, matrixWidth))
        }
    }
    return Object.freeze([ ...columns ].sort((left, right) => left - right))
}

function positiveModulo(value: number, divisor: number): number {

    return ((value % divisor) + divisor) % divisor
}

function betterCandidate(left: SpatialCandidate, right: SpatialCandidate): boolean {

    return left.requestedLevel > right.requestedLevel ||
        (left.requestedLevel === right.requestedLevel &&
            left.sourceLevelCeiling > right.sourceLevelCeiling) ||
        (left.requestedLevel === right.requestedLevel &&
            left.sourceLevelCeiling === right.sourceLevelCeiling &&
            left.priorityScore > right.priorityScore)
}

function compareSpatial(left: SpatialCandidate, right: SpatialCandidate): number {

    return left.matrixLevel - right.matrixLevel ||
        left.tileRow - right.tileRow ||
        left.tileCol - right.tileCol
}

function spatialKey(candidate: Pick<SpatialCandidate, 'matrixLevel' | 'tileRow' | 'tileCol'>): string {

    return `${candidate.matrixLevel}/${candidate.tileRow}/${candidate.tileCol}`
}

function matrixLevel(value: number): boolean {

    return Number.isSafeInteger(value) && value >= 0 && value <= 24
}

function positiveInteger(value: number): boolean {

    return Number.isSafeInteger(value) && value > 0
}

function nonNegativeFinite(value: number): boolean {

    return Number.isFinite(value) && value >= 0
}
