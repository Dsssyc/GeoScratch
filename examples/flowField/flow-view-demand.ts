import {
    GpuWebMercatorQuadCover,
    GpuWebMercatorQuadDemandProjection,
    gpuWebMercatorQuadCoverPolicy,
} from 'geoscratch/geo'
import type {
    GeoViewSnapshot,
    GpuWebMercatorQuadCoverFeedback,
    GpuWebMercatorQuadCoverFrame,
    GpuWebMercatorQuadCoverPolicy,
    GpuWebMercatorQuadCoverViewToken,
    GpuWebMercatorQuadDemandProjectionFeedback,
    GpuWebMercatorQuadDemandProjectionFrame,
    TileMatrixCoverage,
    WebMercatorPlanarTileSpatialProfile,
} from 'geoscratch/geo'
import type {
    GPURuntime,
    SubmissionBuilder,
    SubmittedWork,
} from 'geoscratch/scratch'
import type {
    FlowDemandCoverHook,
    FlowDemandProjectionHook,
    FlowProjectedDemandBatch,
} from './flow-demand.ts'


export type FlowViewDemandOptions = Readonly<{
    runtime: GPURuntime
    spatialProfile: WebMercatorPlanarTileSpatialProfile
    sourceCoverage: TileMatrixCoverage
    policy: GpuWebMercatorQuadCoverPolicy
    maximumDemands: number
}>

export type FlowViewDemandCoverFrame = Readonly<{
    kind: 'flow-view-demand-cover-frame'
    frameEpoch: number
    residencySnapshotEpoch: number
    coverFrame: GpuWebMercatorQuadCoverFrame
}>

export type FlowViewDemandSettlement = Readonly<{
    sourceView: GeoViewSnapshot
    coverFeedback: GpuWebMercatorQuadCoverFeedback
    demandFeedback: GpuWebMercatorQuadDemandProjectionFeedback
}>

export type FlowViewDemandFacts = Readonly<{
    coverId: string
    projectionId: string
    initialized: boolean
    pending: boolean
    hasSettledFeedback: boolean
    latestSettledFrameEpoch: number
    disposed: boolean
}>

export type FlowViewDemandAdapter = Readonly<{
    cover: FlowDemandCoverHook<FlowViewDemandCoverFrame>
    projection: FlowDemandProjectionHook<FlowViewDemandCoverFrame>
    observe(submitted: SubmittedWork): Promise<FlowViewDemandSettlement>
    settlement(): Promise<FlowViewDemandSettlement> | undefined
    hasFeedbackFor(view: GeoViewSnapshot): boolean
    facts(): FlowViewDemandFacts
    dispose(): Promise<void>
}>

type StagedFrame = {
    builder: SubmissionBuilder
    view: GeoViewSnapshot
    viewToken: GpuWebMercatorQuadCoverViewToken
    coverFrame: GpuWebMercatorQuadCoverFrame
    publicFrame: FlowViewDemandCoverFrame
}

type PendingFrame = StagedFrame & {
    demandFrame: GpuWebMercatorQuadDemandProjectionFrame
    settlement?: Promise<FlowViewDemandSettlement>
}

const frameRecords = new WeakMap<FlowViewDemandCoverFrame, StagedFrame>()

/** Rebinds one delayed GPU demand result to the current view provenance. */
export function flowProjectedDemandBatch(
    view: GeoViewSnapshot,
    feedback: GpuWebMercatorQuadDemandProjectionFeedback | undefined
): FlowProjectedDemandBatch {
    if (view?.kind !== 'geo-view-snapshot') {
        throw new TypeError('Flow projected demand requires one GeoViewSnapshot')
    }
    const demands = feedback?.demands.map(demand => Object.freeze({
        ...demand,
        decisionFrameEpoch: view.frameEpoch,
        residencySnapshotEpoch: view.residencySnapshotEpoch,
    })) ?? []
    return Object.freeze({
        kind: 'flow-projected-demand-batch',
        frameEpoch: view.frameEpoch,
        residencySnapshotEpoch: view.residencySnapshotEpoch,
        overflowCount: feedback?.overflowCount ?? 0,
        demands: Object.freeze(demands),
    })
}

/** Composes the public GPU cover and source-demand projection behind Flow demand hooks. */
export async function createFlowViewDemandAdapter(
    options: FlowViewDemandOptions
): Promise<FlowViewDemandAdapter> {
    const runtime = options?.runtime
    const policy = gpuWebMercatorQuadCoverPolicy(options.policy)
    const cover = await GpuWebMercatorQuadCover.create(runtime, {
        spatialProfile: options.spatialProfile,
        policy,
        verticalRangeMeters: [ 0, 0 ],
    })
    let projection: GpuWebMercatorQuadDemandProjection
    try {
        projection = await GpuWebMercatorQuadDemandProjection.create(runtime, {
            cover,
            sourceCoverage: options.sourceCoverage,
            maximumDemands: options.maximumDemands,
        })
    } catch (error) {
        cover.dispose()
        throw error
    }

    let initialized = false
    let staged: StagedFrame | undefined
    let pending: PendingFrame | undefined
    let latestDemandFeedback: GpuWebMercatorQuadDemandProjectionFeedback | undefined
    let latestSettlement: Promise<FlowViewDemandSettlement> | undefined
    let latestSettledFrameEpoch = 0
    let latestSettledView: GeoViewSnapshot | undefined
    let disposed = false
    let disposePromise: Promise<void> | undefined

    const coverHook: FlowDemandCoverHook<FlowViewDemandCoverFrame> = Object.freeze({
        encode(builder: SubmissionBuilder, view: GeoViewSnapshot): FlowViewDemandCoverFrame {
            assertActive()
            if (staged !== undefined || pending !== undefined) {
                throw new Error('Flow GPU view demand already has an unsettled frame')
            }
            if (builder?.runtime !== runtime || builder.isSubmitted) {
                throw new TypeError('Flow GPU view demand requires one live owning builder')
            }
            if (!initialized) cover.initialize(builder)
            const viewToken = cover.writeView(view)
            try {
                const coverFrame = cover.frame(viewToken)
                cover.encode(builder, coverFrame)
                const publicFrame = Object.freeze({
                    kind: 'flow-view-demand-cover-frame' as const,
                    frameEpoch: view.frameEpoch,
                    residencySnapshotEpoch: view.residencySnapshotEpoch,
                    coverFrame,
                })
                staged = { builder, view, viewToken, coverFrame, publicFrame }
                frameRecords.set(publicFrame, staged)
                return publicFrame
            } catch (error) {
                viewToken.dispose()
                throw error
            }
        },
        dispose,
    })

    const projectionHook: FlowDemandProjectionHook<FlowViewDemandCoverFrame> = Object.freeze({
        encode(
            builder: SubmissionBuilder,
            frame: FlowViewDemandCoverFrame,
            view: GeoViewSnapshot
        ): FlowProjectedDemandBatch {
            assertActive()
            const active = frameRecords.get(frame)
            if (active === undefined || active !== staged || active.builder !== builder ||
                active.view !== view || frame.frameEpoch !== view.frameEpoch ||
                frame.residencySnapshotEpoch !== view.residencySnapshotEpoch) {
                throw new Error('Flow GPU demand projection requires its staged cover frame')
            }
            if (!initialized) projection.initialize(builder)
            const coverFrame = active.coverFrame
            const demandFrame = projection.frame(coverFrame)
            projection.encode(builder, demandFrame)
            cover.capture(builder, coverFrame)
            projection.capture(builder, demandFrame)
            pending = { ...active, demandFrame }
            staged = undefined
            initialized = true
            return flowProjectedDemandBatch(view, latestDemandFeedback)
        },
        dispose,
    })

    async function observe(submitted: SubmittedWork): Promise<FlowViewDemandSettlement> {
        assertActive()
        const active = pending
        if (active === undefined) {
            throw new Error('Flow GPU view demand has no encoded frame to observe')
        }
        if (active.settlement !== undefined) return active.settlement
        if (submitted?.runtime !== runtime) {
            throw new TypeError('Flow GPU view demand requires an owning SubmittedWork receipt')
        }
        const observing = Promise.all([
            cover.feedback(active.coverFrame, submitted),
            projection.feedback(active.demandFrame, submitted),
        ]).then(([ coverFeedback, demandFeedback ]) => {
            if (coverFeedback.descriptorOverflowCount !== 0 ||
                coverFeedback.lookupOverflowCount !== 0) {
                throw new RangeError('Flow GPU cover capacity was exceeded')
            }
            latestDemandFeedback = demandFeedback
            latestSettledFrameEpoch = active.view.frameEpoch
            latestSettledView = active.view
            return Object.freeze({
                sourceView: active.view,
                coverFeedback,
                demandFeedback,
            })
        }).finally(() => {
            active.viewToken.dispose()
            if (pending === active) pending = undefined
        })
        active.settlement = observing
        latestSettlement = observing
        return observing
    }

    function settlement(): Promise<FlowViewDemandSettlement> | undefined {
        return latestSettlement
    }

    function hasFeedbackFor(view: GeoViewSnapshot): boolean {
        return latestSettledView !== undefined && flowViewDecisionEquals(latestSettledView, view)
    }

    function facts(): FlowViewDemandFacts {
        return Object.freeze({
            coverId: cover.id,
            projectionId: projection.id,
            initialized,
            pending: staged !== undefined || pending !== undefined,
            hasSettledFeedback: latestDemandFeedback !== undefined,
            latestSettledFrameEpoch,
            disposed,
        })
    }

    function dispose(): Promise<void> {
        if (disposePromise !== undefined) return disposePromise
        disposed = true
        disposePromise = (async() => {
            const settling = pending?.settlement
            if (settling !== undefined) {
                try {
                    await settling
                } catch {
                    // Disposal still releases both public GPU owners after failed feedback.
                }
            } else {
                staged?.viewToken.dispose()
                pending?.viewToken.dispose()
            }
            staged = undefined
            pending = undefined
            projection.dispose()
            cover.dispose()
        })()
        return disposePromise
    }

    function assertActive(): void {
        if (disposed) throw new Error('Flow GPU view demand is disposed')
    }

    return Object.freeze({
        cover: coverHook,
        projection: projectionHook,
        observe,
        settlement,
        hasFeedbackFor,
        facts,
        dispose,
    })
}

/** Compares camera decisions independently of per-frame residency and submission epochs. */
export function flowViewDecisionEquals(left: GeoViewSnapshot, right: GeoViewSnapshot): boolean {
    const keys = [ 'clipFromRelativeWorld', 'cameraHigh', 'cameraLow', 'referenceViewport' ] as const
    return left.zoomHint === right.zoomHint &&
        keys.every(key => {
            const a = left[key]
            const b = right[key]
            return a.length === b.length && a.every((value, index) => value === b[index])
        })
}
