import type {
    GPURuntime,
    SubmittedWork,
} from '../scratch/index.js'
import {
    GeoDiagnosticError,
    createGeoDiagnostic,
} from './diagnostics.js'
import type {
    GeoField,
    TiledFieldRepresentation,
} from './geo-field.js'
import type { GeoViewSnapshot } from './geo-view.js'
import type {
    GpuTileFrontierDemand,
} from './gpu-tile-frontier-layout.js'
import type { TileSpatialProfile } from './tile-spatial-profile.js'
import {
    ViewDemandProducer,
    virtualRasterDemandSetFromViewDemands,
} from './view-tile-demand.js'
import {
    VirtualRasterRequestScheduler,
    virtualRasterDemandSet,
} from './virtual-raster-demand.js'
import type {
    VirtualRasterDemandReconciliation,
    VirtualRasterPageDemand,
    VirtualRasterRequestExecutor,
} from './virtual-raster-demand.js'
import type {
    GpuTileFrontierRetirement,
    VirtualRasterGpuFeedbackBatch,
} from './virtual-raster-gpu-feedback.js'
import {
    createVirtualRasterGpuState,
} from './virtual-raster-gpu.js'
import type {
    VirtualRasterGpuState,
    VirtualRasterGpuUpdate,
} from './virtual-raster-gpu.js'
import {
    VirtualRasterResidency,
} from './virtual-raster-residency.js'
import type {
    VirtualRasterPublication,
    VirtualRasterResidencyLease,
} from './virtual-raster-residency.js'
import type {
    VirtualRasterAddressSpace,
    VirtualRasterPageIdentity,
    VirtualRasterPlane,
} from './virtual-raster.js'

export type VirtualRasterRuntimeModel = Readonly<{
    id: string
    addressSpace: VirtualRasterAddressSpace
    plane: VirtualRasterPlane
    spatialProfile: TileSpatialProfile
    field: GeoField
    representation: TiledFieldRepresentation
    safetyCoverPages: readonly VirtualRasterPageIdentity[]
}>

export type VirtualRasterDemandControllerDescriptor<
    Model extends VirtualRasterRuntimeModel = VirtualRasterRuntimeModel,
> = Readonly<{
    model: Model
    residency: VirtualRasterResidency
    scheduler: VirtualRasterRequestScheduler
    viewDemandProducer: ViewDemandProducer
    maxPhysicalPages: number
    maxHistory: number
}>

export type VirtualRasterFeedbackReconciliation = Readonly<{
    generation: number
    requestedCount: number
    retainedCount: number
    retiredCount: number
    settlement: VirtualRasterDemandReconciliation['settled']
}>

export type VirtualRasterDemandControllerFacts = Readonly<{
    disposed: boolean
    generation: number
    lastDecisionFrameEpoch: number
    acknowledgedSnapshotEpoch: number
    activeDemandCount: number
    transitionCount: number
    lease: ReturnType<VirtualRasterResidencyLease['facts']>
}>

export type VirtualRasterDemandController = Readonly<{
    lease: VirtualRasterResidencyLease
    initialize(): VirtualRasterDemandReconciliation
    reconcileFeedback(
        feedback: VirtualRasterGpuFeedbackBatch,
        view: GeoViewSnapshot
    ): VirtualRasterFeedbackReconciliation
    retainPublication(publication: VirtualRasterPublication): number
    acknowledgePublication(publication: VirtualRasterPublication): void
    abandonPublication(publication: VirtualRasterPublication): void
    facts(): VirtualRasterDemandControllerFacts
    dispose(): void
}>

export type VirtualRasterRuntimeDescriptor<
    Model extends VirtualRasterRuntimeModel = VirtualRasterRuntimeModel,
> = Readonly<{
    runtime: GPURuntime
    model: Model
    executor: VirtualRasterRequestExecutor
    maxRequests: number
    maxPhysicalPages: number
    maxStagingBytes: number
    maxHistory: number
    viewDemandProducerId?: string
}>

export type VirtualRasterRuntimePublication = Readonly<{
    snapshotEpoch: number
    changed: boolean
    update: VirtualRasterGpuUpdate
    publication: VirtualRasterPublication
}>

export type VirtualRasterRuntimeFacts = Readonly<{
    kind: 'virtual-raster-runtime'
    id: string
    demandStopped: boolean
    disposed: boolean
    residency: ReturnType<VirtualRasterResidency['inspect']>
    scheduler: ReturnType<VirtualRasterRequestScheduler['inspect']>
    demand: VirtualRasterDemandControllerFacts
    gpu: ReturnType<VirtualRasterGpuState['facts']>
}>

export type VirtualRasterRuntime<
    Model extends VirtualRasterRuntimeModel = VirtualRasterRuntimeModel,
> = Omit<Model, 'kind'> & Readonly<{
    kind: 'virtual-raster-runtime'
    model: Model
    residency: VirtualRasterResidency
    gpu: VirtualRasterGpuState
    scheduler: VirtualRasterRequestScheduler
    viewDemandProducer: ViewDemandProducer
    residencyLease: VirtualRasterResidencyLease
    initialize(): Promise<VirtualRasterRuntimePublication>
    reconcileFeedback(
        feedback: VirtualRasterGpuFeedbackBatch,
        view: GeoViewSnapshot
    ): VirtualRasterFeedbackReconciliation
    publish(): VirtualRasterRuntimePublication
    acknowledge(
        publication: VirtualRasterRuntimePublication,
        submitted: SubmittedWork
    ): Promise<void>
    stopDemand(): Promise<void>
    dispose(): Promise<void>
    inspect(): VirtualRasterRuntimeFacts
}>

type TransitionLeaseRecord = {
    page: VirtualRasterPageIdentity
    generation: number
    visibleAfterSnapshotEpoch: number
    acknowledged: boolean
}

export function createVirtualRasterDemandController<
    Model extends VirtualRasterRuntimeModel,
>({
    model,
    residency,
    scheduler,
    viewDemandProducer,
    maxPhysicalPages,
    maxHistory,
}: VirtualRasterDemandControllerDescriptor<Model>): VirtualRasterDemandController {

    assertRuntimeModel(model)
    if (residency.addressSpace !== model.addressSpace || residency.plane !== model.plane ||
        scheduler.residency !== residency || !positiveInteger(maxPhysicalPages) ||
        maxPhysicalPages > residency.maxPhysicalPages || !positiveInteger(maxHistory) ||
        model.safetyCoverPages.length > maxPhysicalPages ||
        model.safetyCoverPages.length > scheduler.maxRequests ||
        viewDemandProducer?.kind !== 'view-demand-producer' ||
        viewDemandProducer.maxDemands > scheduler.maxRequests) {
        return invalidRuntime(
            model,
            'Virtual Raster GPU demand requires one matching scheduler/residency owner and budgets that contain the safety cover.',
            {
                maxPhysicalPages,
                maxHistory,
                residencyMaxPhysicalPages: residency.maxPhysicalPages,
                schedulerMaxRequests: scheduler.maxRequests,
                viewDemandMaximum: viewDemandProducer?.maxDemands,
                safetyCoverPageCount: model.safetyCoverPages.length,
            }
        )
    }
    const lease = residency.createLease({
        id: `virtual-raster-frontier.${model.id}`,
        maximumPages: maxPhysicalPages,
        maxHistory,
    })
    const safetyKeys = new Set(model.safetyCoverPages.map(page => page.key))
    const transitions = new Map<string, TransitionLeaseRecord>()
    let activeDemandKeys = new Set(safetyKeys)
    let disposed = false
    let generation = 0
    let lastDecisionFrameEpoch = -1
    let acknowledgedSnapshotEpoch = 0
    let ringId: string | undefined
    let frontierId: string | undefined
    for (const page of model.safetyCoverPages) residency.pin(page)

    function initialize(): VirtualRasterDemandReconciliation {

        assertActive()
        if (generation !== 0) {
            return invalidRuntime(
                model,
                'A Virtual Raster safety-cover demand can be initialized exactly once.',
                { generation }
            )
        }
        const demandGeneration = ++generation
        activeDemandKeys = new Set(safetyKeys)
        return scheduler.reconcile(virtualRasterDemandSet({
            generation: demandGeneration,
            demands: model.safetyCoverPages.map(page => safetyDemand(page, demandGeneration)),
        }))
    }

    function reconcileFeedback(
        feedback: VirtualRasterGpuFeedbackBatch,
        view: GeoViewSnapshot
    ): VirtualRasterFeedbackReconciliation {

        assertActive()
        const canonical = canonicalGpuFeedback(
            model,
            feedback,
            lastDecisionFrameEpoch,
            acknowledgedSnapshotEpoch,
            ringId,
            frontierId
        )
        if (view?.kind !== 'geo-view-snapshot' ||
            view.frameEpoch !== feedback.frameEpoch ||
            view.residencySnapshotEpoch !== feedback.residencySnapshotEpoch) {
            return invalidRuntime(
                model,
                'Virtual Raster GPU feedback must be lowered against the exact Geo view that produced it.',
                {
                    feedbackFrameEpoch: feedback.frameEpoch,
                    feedbackResidencySnapshotEpoch: feedback.residencySnapshotEpoch,
                    viewKind: view?.kind,
                    viewId: view?.id,
                    viewFrameEpoch: view?.frameEpoch,
                    viewResidencySnapshotEpoch: view?.residencySnapshotEpoch,
                }
            )
        }
        ringId ??= feedback.ringId
        frontierId ??= feedback.frontierId
        lastDecisionFrameEpoch = feedback.frameEpoch
        let retainedCount = 0
        for (const demand of canonical.demands) {
            if (safetyKeys.has(demand.parent.key)) continue
            const existing = transitions.get(demand.parent.key)
            if (!lease.retain(demand.parent, demand.parentGeneration)) continue
            if (existing?.generation !== demand.parentGeneration) {
                transitions.set(demand.parent.key, {
                    page: demand.parent,
                    generation: demand.parentGeneration,
                    visibleAfterSnapshotEpoch: feedback.residencySnapshotEpoch,
                    acknowledged: true,
                })
                retainedCount++
            }
        }
        let retiredCount = 0
        for (const retirement of canonical.retirements) {
            if (safetyKeys.has(retirement.page.key)) continue
            const record = transitions.get(retirement.page.key)
            if (record === undefined || record.generation !== retirement.generation ||
                !record.acknowledged ||
                feedback.residencySnapshotEpoch <= record.visibleAfterSnapshotEpoch) continue
            const current = residency.currentSnapshot.resolve(retirement.page)
            if (current.status !== 'resident' ||
                current.physicalSlot !== retirement.physicalSlot ||
                current.generation !== retirement.generation ||
                current.contentEpoch !== retirement.contentEpoch) continue
            if (lease.release(retirement.page, retirement.generation)) retiredCount++
            transitions.delete(retirement.page.key)
        }
        const demandGeneration = ++generation
        const viewDemands = viewDemandProducer.produce({
            view,
            generation: demandGeneration,
            demands: canonical.demands.map(demand => Object.freeze({
                page: demand.page,
                priority: Object.freeze({
                    class: 'user-visible' as const,
                    score: demand.priority,
                }),
                intent: 'refinement' as const,
                reason: `gpu-frontier:${feedback.frameEpoch}`,
            })),
        })
        const requested = virtualRasterDemandSetFromViewDemands(viewDemands).demands
        activeDemandKeys = new Set([
            ...safetyKeys,
            ...requested.map(demand => demand.page.key),
        ])
        const reconciliation = scheduler.reconcile(virtualRasterDemandSet({
            generation: demandGeneration,
            demands: [
                ...model.safetyCoverPages.map(page => safetyDemand(page, demandGeneration)),
                ...requested.filter(demand => !safetyKeys.has(demand.page.key)),
            ],
        }))
        return Object.freeze({
            generation: demandGeneration,
            requestedCount: reconciliation.requestedCount,
            retainedCount,
            retiredCount,
            settlement: reconciliation.settled,
        })
    }

    function retainPublication(publication: VirtualRasterPublication): number {

        assertActive()
        if (publication.snapshot.addressSpace !== model.addressSpace ||
            publication.inspect().state !== 'pending') {
            return invalidRuntime(
                model,
                'Transition leases can retain only the active pending residency publication.',
                publication.inspect()
            )
        }
        let retainedCount = 0
        for (const page of model.safetyCoverPages) {
            const resolved = publication.snapshot.resolve(page)
            if (resolved.status === 'resident' && resolved.generation !== undefined) {
                lease.retain(page, resolved.generation)
            }
        }
        for (const upload of publication.uploads) {
            if (!activeDemandKeys.has(upload.page.key)) continue
            const existing = transitions.get(upload.page.key)
            if (!lease.retain(upload.page, upload.generation)) continue
            if (!safetyKeys.has(upload.page.key) && existing?.generation !== upload.generation) {
                transitions.set(upload.page.key, {
                    page: upload.page,
                    generation: upload.generation,
                    visibleAfterSnapshotEpoch: publication.snapshot.epoch,
                    acknowledged: false,
                })
                retainedCount++
            }
        }
        return retainedCount
    }

    function acknowledgePublication(publication: VirtualRasterPublication): void {

        assertActive()
        if (publication.snapshot.addressSpace !== model.addressSpace ||
            publication.inspect().state !== 'acknowledged' ||
            publication.snapshot.epoch < acknowledgedSnapshotEpoch) {
            return invalidRuntime(
                model,
                'Demand authority can acknowledge only a monotonic settled residency publication.',
                publication.inspect()
            )
        }
        acknowledgedSnapshotEpoch = publication.snapshot.epoch
        for (const record of transitions.values()) {
            if (record.visibleAfterSnapshotEpoch === publication.snapshot.epoch) {
                record.acknowledged = true
            }
        }
    }

    function abandonPublication(publication: VirtualRasterPublication): void {

        if (disposed) return
        if (publication.snapshot.addressSpace !== model.addressSpace ||
            publication.inspect().state !== 'abandoned') {
            return invalidRuntime(
                model,
                'Demand authority can abandon only its settled residency publication.',
                publication.inspect()
            )
        }
        for (const [ key, record ] of transitions) {
            if (record.acknowledged ||
                record.visibleAfterSnapshotEpoch !== publication.snapshot.epoch) continue
            lease.release(record.page, record.generation)
            transitions.delete(key)
        }
    }

    function facts(): VirtualRasterDemandControllerFacts {

        return Object.freeze({
            disposed,
            generation,
            lastDecisionFrameEpoch,
            acknowledgedSnapshotEpoch,
            activeDemandCount: activeDemandKeys.size,
            transitionCount: transitions.size,
            lease: lease.facts(),
        })
    }

    function dispose(): void {

        if (disposed) return
        disposed = true
        for (const page of model.safetyCoverPages) residency.unpin(page)
        transitions.clear()
        activeDemandKeys.clear()
        lease.dispose()
    }

    function assertActive(): void {

        if (!disposed) return
        invalidRuntime(model, 'Virtual Raster demand authority is disposed.', { disposed })
    }

    return Object.freeze({
        lease,
        initialize,
        reconcileFeedback,
        retainPublication,
        acknowledgePublication,
        abandonPublication,
        facts,
        dispose,
    })
}

export async function createVirtualRasterRuntime<
    Model extends VirtualRasterRuntimeModel,
>({
    runtime,
    model,
    executor,
    maxRequests,
    maxPhysicalPages,
    maxStagingBytes,
    maxHistory,
    viewDemandProducerId = `virtual-raster-view-demand.${model?.id}`,
}: VirtualRasterRuntimeDescriptor<Model>): Promise<VirtualRasterRuntime<Model>> {

    assertRuntimeModel(model)
    if (runtime === undefined || typeof runtime.createTexture !== 'function' ||
        typeof executor?.request !== 'function' || !positiveInteger(maxRequests) ||
        !positiveInteger(maxPhysicalPages) || !positiveInteger(maxStagingBytes) ||
        !positiveInteger(maxHistory) || typeof viewDemandProducerId !== 'string' ||
        viewDemandProducerId.length === 0 || model.safetyCoverPages.length > maxRequests ||
        model.safetyCoverPages.length > maxPhysicalPages) {
        return invalidRuntime(
            model,
            'A Virtual Raster runtime requires one GPU runtime, request executor, and explicit budgets containing its safety cover.',
            {
                runtime,
                executor,
                maxRequests,
                maxPhysicalPages,
                maxStagingBytes,
                maxHistory,
                viewDemandProducerId,
                safetyCoverPageCount: model.safetyCoverPages.length,
            }
        )
    }
    const residency = new VirtualRasterResidency({
        addressSpace: model.addressSpace,
        plane: model.plane,
        maxPhysicalPages,
        maxStagingBytes,
        maxHistory,
    })
    let gpu: VirtualRasterGpuState | undefined
    try {
        gpu = await createVirtualRasterGpuState(runtime, {
            addressSpace: model.addressSpace,
            plane: model.plane,
            maxPhysicalPages,
        })
    } catch (error) {
        residency.dispose()
        throw error
    }
    const gpuState = gpu
    const scheduler = new VirtualRasterRequestScheduler({
        residency,
        executor,
        maxRequests,
        maxHistory,
    })
    const viewDemandProducer = new ViewDemandProducer({
        id: viewDemandProducerId,
        maxDemands: maxRequests,
    })
    const demandController = createVirtualRasterDemandController({
        model,
        residency,
        scheduler,
        viewDemandProducer,
        maxPhysicalPages,
        maxHistory,
    })
    let demandStopped = false
    let disposed = false
    let stopDemandPromise: Promise<void> | undefined
    let disposePromise: Promise<void> | undefined
    let activePublication: VirtualRasterRuntimePublication | undefined

    async function initialize() {

        const reconciliation = demandController.initialize()
        const settlement = await reconciliation.settled
        if (settlement.stagedCount + settlement.residentCount < model.safetyCoverPages.length) {
            return invalidRuntime(
                model,
                'The minimum-level Virtual Raster safety cover failed to become available.',
                settlement
            )
        }
        return publish()
    }

    function publish(): VirtualRasterRuntimePublication {

        assertActive()
        if (activePublication !== undefined) {
            return invalidRuntime(
                model,
                'A Virtual Raster publication must settle before the next publication.',
                activePublication.publication.inspect()
            )
        }
        const publication = scheduler.publish()
        demandController.retainPublication(publication)
        let update: VirtualRasterGpuUpdate
        try {
            update = gpuState.stage(publication)
        } catch (error) {
            void publication.abandon().then(() => {
                demandController.abandonPublication(publication)
            })
            throw error
        }
        const wrapped = Object.freeze({
            snapshotEpoch: publication.snapshot.epoch,
            changed: update.commands.length > 0,
            update,
            publication,
        })
        activePublication = wrapped
        return wrapped
    }

    async function acknowledge(
        wrapped: VirtualRasterRuntimePublication,
        submitted: SubmittedWork
    ): Promise<void> {

        assertActive()
        if (activePublication !== wrapped) {
            return invalidRuntime(
                model,
                'Only the active Virtual Raster publication can be acknowledged.',
                wrapped.publication.inspect()
            )
        }
        await gpuState.acknowledge(wrapped.publication, submitted)
        demandController.acknowledgePublication(wrapped.publication)
        activePublication = undefined
    }

    function stopDemand(): Promise<void> {

        if (stopDemandPromise !== undefined) return stopDemandPromise
        demandStopped = true
        stopDemandPromise = scheduler.dispose()
        return stopDemandPromise
    }

    function dispose(): Promise<void> {

        if (disposePromise !== undefined) return disposePromise
        disposePromise = disposeOnce()
        return disposePromise
    }

    async function disposeOnce(): Promise<void> {

        if (disposed) return
        disposed = true
        await stopDemand()
        if (activePublication !== undefined) {
            await gpuState.abandon(activePublication.publication)
            demandController.abandonPublication(activePublication.publication)
            activePublication = undefined
        }
        demandController.dispose()
        residency.dispose()
        gpuState.dispose()
    }

    function inspect(): VirtualRasterRuntimeFacts {

        return Object.freeze({
            kind: 'virtual-raster-runtime' as const,
            id: model.id,
            demandStopped,
            disposed,
            residency: residency.inspect(),
            scheduler: scheduler.inspect(),
            demand: demandController.facts(),
            gpu: gpuState.facts(),
        })
    }

    function assertActive(): void {

        if (!disposed) return
        invalidRuntime(model, 'Virtual Raster runtime is disposed.', { disposed })
    }

    return Object.freeze({
        ...model,
        kind: 'virtual-raster-runtime' as const,
        model,
        residency,
        gpu: gpuState,
        scheduler,
        viewDemandProducer,
        residencyLease: demandController.lease,
        initialize,
        reconcileFeedback: demandController.reconcileFeedback,
        publish,
        acknowledge,
        stopDemand,
        dispose,
        inspect,
    })
}

function canonicalGpuFeedback(
    model: VirtualRasterRuntimeModel,
    feedback: VirtualRasterGpuFeedbackBatch,
    lastDecisionFrameEpoch: number,
    acknowledgedSnapshotEpoch: number,
    ringId: string | undefined,
    frontierId: string | undefined
): Readonly<{
    demands: readonly GpuTileFrontierDemand[]
    retirements: readonly GpuTileFrontierRetirement[]
}> {

    if (feedback.kind !== 'virtual-raster-gpu-feedback-batch' ||
        typeof feedback.ringId !== 'string' || feedback.ringId.length === 0 ||
        typeof feedback.frontierId !== 'string' || feedback.frontierId.length === 0 ||
        !nonNegativeInteger(feedback.frameEpoch) || feedback.frameEpoch > 0xffff_ffff ||
        feedback.frameEpoch <= lastDecisionFrameEpoch ||
        !nonNegativeInteger(feedback.residencySnapshotEpoch) ||
        feedback.residencySnapshotEpoch > 0xffff_ffff ||
        feedback.residencySnapshotEpoch > acknowledgedSnapshotEpoch ||
        (ringId !== undefined && feedback.ringId !== ringId) ||
        (frontierId !== undefined && feedback.frontierId !== frontierId)) {
        return invalidRuntime(
            model,
            'GPU feedback must come from one stable frontier and advance monotonically within acknowledged residency.',
            {
                ringId: feedback.ringId,
                frontierId: feedback.frontierId,
                frameEpoch: feedback.frameEpoch,
                residencySnapshotEpoch: feedback.residencySnapshotEpoch,
                lastDecisionFrameEpoch,
                acknowledgedSnapshotEpoch,
            }
        )
    }
    const demands = new Map<string, GpuTileFrontierDemand>()
    for (const demand of feedback.demands) {
        try {
            model.addressSpace.assertPage(demand.page)
            model.addressSpace.assertPage(demand.parent)
        } catch (error) {
            return invalidRuntime(
                model,
                'GPU demand pages must belong to the configured Virtual Raster coverage.',
                demand,
                error
            )
        }
        const expectedParent = model.addressSpace.parent(demand.page)
        const tile = demand.page.tile!
        const expectedChildMask = 1 << ((tile.tileRow % 2) * 2 + tile.tileCol % 2)
        if (expectedParent?.key !== demand.parent.key ||
            demand.parentCompactIndex !== model.addressSpace.tableIndex(demand.parent) ||
            !nonNegativeInteger(demand.parentPhysicalSlot) ||
            demand.parentPhysicalSlot > 0xffff_ffff ||
            !positiveInteger(demand.parentGeneration) || demand.parentGeneration > 0xffff_ffff ||
            !nonNegativeInteger(demand.priority) || demand.priority > 0xffff_ffff ||
            demand.childMask !== expectedChildMask ||
            demand.decisionFrameEpoch !== feedback.frameEpoch ||
            demand.residencySnapshotEpoch !== feedback.residencySnapshotEpoch) {
            return invalidRuntime(
                model,
                'GPU demand must identify one covered child and its acknowledged parent assignment.',
                { demand, expectedParent }
            )
        }
        const existing = demands.get(demand.page.key)
        if (existing === undefined || demand.priority > existing.priority) {
            demands.set(demand.page.key, demand)
        }
    }
    const retirements: GpuTileFrontierRetirement[] = []
    for (const retirement of feedback.retirements) {
        try {
            model.addressSpace.assertPage(retirement.page)
        } catch (error) {
            return invalidRuntime(
                model,
                'GPU retirement pages must belong to the configured Virtual Raster coverage.',
                retirement,
                error
            )
        }
        if (!nonNegativeInteger(retirement.physicalSlot) ||
            retirement.physicalSlot > 0xffff_ffff ||
            !positiveInteger(retirement.generation) || retirement.generation > 0xffff_ffff ||
            !positiveInteger(retirement.contentEpoch) || retirement.contentEpoch > 0xffff_ffff ||
            retirement.decisionFrameEpoch !== feedback.frameEpoch ||
            retirement.residencySnapshotEpoch !== feedback.residencySnapshotEpoch) {
            return invalidRuntime(
                model,
                'GPU retirement must identify one physical assignment from this feedback frame.',
                retirement
            )
        }
        retirements.push(retirement)
    }
    return Object.freeze({
        demands: Object.freeze([ ...demands.values() ].sort((left, right) =>
            left.page.key.localeCompare(right.page.key)
        )),
        retirements: Object.freeze(retirements),
    })
}

function safetyDemand(
    page: VirtualRasterPageIdentity,
    generation: number
): VirtualRasterPageDemand {

    return Object.freeze({
        page,
        generation,
        priority: Object.freeze({ class: 'critical' as const, score: 1_000_000 }),
        reason: 'minimum-matrix-safety-cover',
        usage: 'required' as const,
    })
}

function assertRuntimeModel(
    model: VirtualRasterRuntimeModel
): asserts model is VirtualRasterRuntimeModel {

    if (typeof model?.id !== 'string' || model.id.length === 0 ||
        model.addressSpace?.dimensions !== 2 ||
        model.plane?.addressSpace !== model.addressSpace ||
        model.spatialProfile?.kind !== 'tile-spatial-profile' ||
        model.spatialProfile.coverage !== model.addressSpace.tileCoverage ||
        model.field?.kind !== 'geo-field' ||
        model.representation?.kind !== 'tiled-field-representation' ||
        model.representation.field !== model.field ||
        model.representation.plane !== model.plane ||
        model.representation.spatialProfile !== model.spatialProfile ||
        !Array.isArray(model.safetyCoverPages) || model.safetyCoverPages.length === 0) {
        return invalidRuntime(
            model,
            'A Virtual Raster runtime model requires one coherent tiled field and a non-empty safety cover.',
            model
        )
    }
    try {
        for (const page of model.safetyCoverPages) model.addressSpace.assertPage(page)
    } catch (error) {
        invalidRuntime(
            model,
            'Every Virtual Raster safety-cover page must belong to the model address space.',
            model.safetyCoverPages,
            error
        )
    }
}

function invalidRuntime(
    model: Partial<VirtualRasterRuntimeModel> | undefined,
    message: string,
    actual: unknown,
    cause?: unknown
): never {

    const addressSpaceId = model?.addressSpace?.id
    throw new GeoDiagnosticError(createGeoDiagnostic({
        code: 'GEO_GPU_TILE_FRONTIER_INVALID',
        phase: 'selection',
        subject: {
            kind: 'virtual-raster-runtime',
            ...(typeof model?.id === 'string' ? { id: model.id } : {}),
        },
        message,
        expected: {
            ...(addressSpaceId === undefined ? {} : { addressSpaceId }),
            ...(Array.isArray(model?.safetyCoverPages)
                ? { safetyCoverPageCount: model.safetyCoverPages.length }
                : {}),
        },
        actual,
    }), cause === undefined ? undefined : { cause })
}

function positiveInteger(value: number): boolean {

    return Number.isSafeInteger(value) && value > 0
}

function nonNegativeInteger(value: number): boolean {

    return Number.isSafeInteger(value) && value >= 0
}
