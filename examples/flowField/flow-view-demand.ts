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
    /** Original GPU-producing frame; a reused adapter frame does not invent new GPU provenance. */
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
    /** Complete spatial build batches encoded, not native-success observations. */
    buildCount: number
    /** Current-provenance batches encoded from previously observed spatial feedback. */
    reuseCount: number
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
    viewToken?: GpuWebMercatorQuadCoverViewToken
    coverFrame: GpuWebMercatorQuadCoverFrame
    publicFrame: FlowViewDemandCoverFrame
    reused?: SettledSpatialFrame
}

type PendingFrame = StagedFrame & {
    demandFrame?: GpuWebMercatorQuadDemandProjectionFrame
    settlement?: Promise<FlowViewDemandSettlement>
}

type SettledSpatialFrame = Readonly<{
    coverFrame: GpuWebMercatorQuadCoverFrame
    value: FlowViewDemandSettlement
}>

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
    let reusable: SettledSpatialFrame | undefined
    let buildCount = 0
    let reuseCount = 0
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
            if (view?.kind !== 'geo-view-snapshot' ||
                ![view.frameEpoch, view.residencySnapshotEpoch].every(value =>
                    Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff)) {
                throw new TypeError('Flow GPU view demand requires a GeoViewSnapshot with u32 epochs')
            }
            if (reusable !== undefined && flowViewDecisionEquals(reusable.value.sourceView, view)) {
                const publicFrame = Object.freeze({
                    kind: 'flow-view-demand-cover-frame' as const,
                    frameEpoch: view.frameEpoch,
                    residencySnapshotEpoch: view.residencySnapshotEpoch,
                    coverFrame: reusable.coverFrame,
                })
                staged = {builder, view, publicFrame, coverFrame: reusable.coverFrame, reused: reusable}
                frameRecords.set(publicFrame, staged)
                return publicFrame
            }
            // A new spatial build may overwrite parity resources; only its own
            // successful feedback can restore reuse, including an A-B-A return.
            reusable = undefined
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
            if (builder?.runtime !== runtime || builder.isSubmitted ||
                active === undefined || active !== staged || active.builder !== builder ||
                active.view !== view || frame.frameEpoch !== view.frameEpoch ||
                frame.residencySnapshotEpoch !== view.residencySnapshotEpoch) {
                throw new Error('Flow GPU demand projection requires its staged cover frame')
            }
            if (active.reused !== undefined) {
                pending = {...active}
                staged = undefined
                reuseCount++
                return flowProjectedDemandBatch(view, active.reused.value.demandFeedback)
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
            buildCount++
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
        if (submitted?.runtime !== runtime || !active.builder.isSubmitted) {
            reusable = undefined
            throw new TypeError('Flow GPU view demand requires an owning SubmittedWork receipt')
        }
        const feedback = active.reused === undefined ? Promise.all([
            cover.feedback(active.coverFrame, submitted),
            projection.feedback(active.demandFrame!, submitted),
        ]) : Promise.resolve([active.reused.value.coverFeedback, active.reused.value.demandFeedback] as const)
        const observing = Promise.all([feedback, submitted.done, submitted.nativeOutcome]).then(([
            [coverFeedback, demandFeedback], , nativeOutcome,
        ]) => {
            if (nativeOutcome.status !== 'observed-succeeded' &&
                !(active.reused !== undefined && nativeOutcome.status === 'no-native-work')) {
                throw new Error('Flow GPU view demand submission did not succeed')
            }
            // A current frame can reuse old spatial facts without new native
            // spatial work. Keep their actual generating view/receipt unchanged.
            if (active.reused !== undefined) return active.reused.value
            if (coverFeedback.descriptorOverflowCount !== 0 ||
                coverFeedback.lookupOverflowCount !== 0) {
                throw new RangeError('Flow GPU cover capacity was exceeded')
            }
            // Projection overflow remains a complete-source fallback signal for
            // the Flow coordinator, not an invalid spatial observation.
            const value = Object.freeze({
                sourceView: active.view,
                coverFeedback,
                demandFeedback,
            })
            if (!disposed) {
                latestDemandFeedback = demandFeedback
                latestSettledFrameEpoch = active.view.frameEpoch
                latestSettledView = active.view
                reusable = Object.freeze({coverFrame: active.coverFrame, value})
            }
            return value
        }).catch(error => {
            reusable = undefined
            initialized = false
            throw error
        }).finally(() => {
            active.viewToken?.dispose()
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
        return !disposed && reusable !== undefined && latestSettledView !== undefined &&
            flowViewDecisionEquals(latestSettledView, view)
    }

    function facts(): FlowViewDemandFacts {
        return Object.freeze({
            coverId: cover.id,
            projectionId: projection.id,
            initialized,
            pending: staged !== undefined || pending !== undefined,
            hasSettledFeedback: latestDemandFeedback !== undefined,
            latestSettledFrameEpoch,
            buildCount,
            reuseCount,
            disposed,
        })
    }

    function dispose(): Promise<void> {
        if (disposePromise !== undefined) return disposePromise
        disposed = true
        reusable = undefined
        disposePromise = (async() => {
            const settling = pending?.settlement
            if (settling !== undefined) {
                try {
                    await settling
                } catch {
                    // Disposal still releases both public GPU owners after failed feedback.
                }
            } else {
                staged?.viewToken?.dispose()
                pending?.viewToken?.dispose()
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

/** Compares one view identity and all camera facts, excluding only per-frame/residency epochs. */
export function flowViewDecisionEquals(left: GeoViewSnapshot, right: GeoViewSnapshot): boolean {
    const keys = [ 'clipFromRelativeWorld', 'cameraHigh', 'cameraLow', 'referenceViewport' ] as const
    return left.id === right.id && left.zoomHint === right.zoomHint &&
        left.verticalFovRadians === right.verticalFovRadians &&
        left.cameraLatitudeRadians === right.cameraLatitudeRadians &&
        left.cameraPitchRadians === right.cameraPitchRadians &&
        keys.every(key => {
            const a = left[key]
            const b = right[key]
            return a.length === b.length && a.every((value, index) => value === b[index])
        })
}
