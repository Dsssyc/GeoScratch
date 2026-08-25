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
import type { TileSpatialProfile } from './tile-spatial-profile.js'
import {
    ViewDemandProducer,
    virtualRasterDemandSetFromViewDemands,
} from './view-tile-demand.js'
import type { ViewTileDemandSet } from './view-tile-demand.js'
import {
    VirtualRasterRequestScheduler,
    virtualRasterDemandSet,
} from './virtual-raster-demand.js'
import type {
    VirtualRasterDemandReconciliation,
    VirtualRasterPageDemand,
    VirtualRasterRequestExecutor,
} from './virtual-raster-demand.js'
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
    safetyDemandCount: number
    viewDemandCapacity: number
    lastDecisionFrameEpoch: number
    acknowledgedSnapshotEpoch: number
    activeDemandCount: number
}>

export type VirtualRasterDemandController = Readonly<{
    initialize(): VirtualRasterDemandReconciliation
    reconcileViewDemands(
        demands: ViewTileDemandSet
    ): VirtualRasterFeedbackReconciliation
    acknowledgePublication(publication: VirtualRasterPublication): void
    abandonPublication(publication: VirtualRasterPublication): void
    facts(): VirtualRasterDemandControllerFacts
    dispose(): void
}>

/** Declares whether one Virtual Raster runtime borrows or owns its request executor. */
export type VirtualRasterExecutorBinding =
    | Readonly<{
        ownership: 'borrowed'
        executor: VirtualRasterRequestExecutor
    }>
    | Readonly<{
        ownership: 'owned'
        executor: VirtualRasterRequestExecutor & Readonly<{
            dispose(): Promise<void>
        }>
    }>

export type VirtualRasterRuntimeDescriptor<
    Model extends VirtualRasterRuntimeModel = VirtualRasterRuntimeModel,
> = Readonly<{
    runtime: GPURuntime
    model: Model
    executor: VirtualRasterExecutorBinding
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
    executorOwnership: VirtualRasterExecutorBinding['ownership']
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
    initialize(): Promise<VirtualRasterRuntimePublication>
    reconcileViewDemands(
        demands: ViewTileDemandSet
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

/** Coordinates safety cover, view demand, feedback acknowledgement, and publication retention. */
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
        viewDemandProducer.maxDemands + model.safetyCoverPages.length >
            Math.min(maxPhysicalPages, scheduler.maxRequests)) {
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
    const safetyKeys = new Set(model.safetyCoverPages.map(page => page.key))
    const viewDemandCapacity = viewDemandProducer.maxDemands
    let activeDemandKeys = new Set(safetyKeys)
    let disposed = false
    let generation = 0
    let lastDecisionFrameEpoch = -1
    let acknowledgedSnapshotEpoch = 0
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

    function reconcileViewDemands(
        demandSet: ViewTileDemandSet
    ): VirtualRasterFeedbackReconciliation {

        assertActive()
        if (demandSet?.kind !== 'view-tile-demand-set' ||
            !Array.isArray(demandSet.demands) ||
            demandSet.demands.length > viewDemandCapacity ||
            demandSet.demands.some(demand =>
                demand?.page?.addressSpaceId !== model.addressSpace.id ||
                demand?.source?.producerId !== viewDemandProducer.id
            )) {
            return invalidRuntime(
                model,
                'Virtual Raster accepts only bounded explicit demand from its own view-demand producer.',
                {
                    kind: 'view-tile-demand-set',
                    addressSpaceId: model.addressSpace.id,
                    producerId: viewDemandProducer.id,
                    viewDemandCapacity,
                }
            )
        }
        const demandGeneration = ++generation
        const normalized = Object.freeze({
            kind: 'view-tile-demand-set' as const,
            generation: demandGeneration,
            demands: Object.freeze(demandSet.demands.map(demand => Object.freeze({
                ...demand,
                generation: demandGeneration,
            }))),
        })
        const requested = virtualRasterDemandSetFromViewDemands(normalized).demands
            .filter(demand => !safetyKeys.has(demand.page.key))
        activeDemandKeys = new Set([
            ...safetyKeys,
            ...requested.map(demand => demand.page.key),
        ])
        const frameEpochs = demandSet.demands.map(demand => demand.source.frameEpoch)
        if (frameEpochs.length > 0) lastDecisionFrameEpoch = Math.max(...frameEpochs)
        const reconciliation = scheduler.reconcile(virtualRasterDemandSet({
            generation: demandGeneration,
            demands: [
                ...model.safetyCoverPages.map(page =>
                    safetyDemand(page, demandGeneration)
                ),
                ...requested,
            ],
        }))
        return Object.freeze({
            generation: demandGeneration,
            requestedCount: reconciliation.requestedCount,
            retainedCount: reconciliation.retainedCount,
            retiredCount: reconciliation.cancelledCount,
            settlement: reconciliation.settled,
        })
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
    }

    function facts(): VirtualRasterDemandControllerFacts {

        return Object.freeze({
            disposed,
            generation,
            safetyDemandCount: safetyKeys.size,
            viewDemandCapacity,
            lastDecisionFrameEpoch,
            acknowledgedSnapshotEpoch,
            activeDemandCount: activeDemandKeys.size,
        })
    }

    function dispose(): void {

        if (disposed) return
        disposed = true
        for (const page of model.safetyCoverPages) residency.unpin(page)
        activeDemandKeys.clear()
    }

    function assertActive(): void {

        if (!disposed) return
        invalidRuntime(model, 'Virtual Raster demand authority is disposed.', { disposed })
    }

    return Object.freeze({
        initialize,
        reconcileViewDemands,
        acknowledgePublication,
        abandonPublication,
        facts,
        dispose,
    })
}

/** Assembles request scheduling, CPU residency, GPU publication, demand, and explicit executor authority. */
export async function createVirtualRasterRuntime<
    Model extends VirtualRasterRuntimeModel,
>({
    runtime,
    model,
    executor: executorBinding,
    maxRequests,
    maxPhysicalPages,
    maxStagingBytes,
    maxHistory,
    viewDemandProducerId = `virtual-raster-view-demand.${model?.id}`,
}: VirtualRasterRuntimeDescriptor<Model>): Promise<VirtualRasterRuntime<Model>> {

    const binding = assertExecutorBinding(model, executorBinding)
    const executor = binding.executor
    let residency: VirtualRasterResidency | undefined
    let gpuState: VirtualRasterGpuState | undefined
    let scheduler: VirtualRasterRequestScheduler | undefined
    let demandController: VirtualRasterDemandController | undefined
    let viewDemandProducer: ViewDemandProducer | undefined
    try {
        assertRuntimeModel(model)
        if (runtime === undefined || typeof runtime.createTexture !== 'function' ||
            !positiveInteger(maxRequests) || !positiveInteger(maxPhysicalPages) ||
            !positiveInteger(maxStagingBytes) || !positiveInteger(maxHistory) ||
            typeof viewDemandProducerId !== 'string' || viewDemandProducerId.length === 0 ||
            model.safetyCoverPages.length > maxRequests ||
            model.safetyCoverPages.length > maxPhysicalPages) {
            return invalidRuntime(
                model,
                'A Virtual Raster runtime requires one GPU runtime, explicit executor authority, and budgets containing its safety cover.',
                {
                    runtime,
                    executorOwnership: binding.ownership,
                    maxRequests,
                    maxPhysicalPages,
                    maxStagingBytes,
                    maxHistory,
                    viewDemandProducerId,
                    safetyCoverPageCount: model.safetyCoverPages.length,
                }
            )
        }
        residency = new VirtualRasterResidency({
            addressSpace: model.addressSpace,
            plane: model.plane,
            maxPhysicalPages,
            maxStagingBytes,
            maxHistory,
        })
        gpuState = await createVirtualRasterGpuState(runtime, {
            addressSpace: model.addressSpace,
            plane: model.plane,
            maxPhysicalPages,
        })
        scheduler = new VirtualRasterRequestScheduler({
            residency,
            executor,
            maxRequests,
            maxHistory,
        })
        viewDemandProducer = new ViewDemandProducer({
            id: viewDemandProducerId,
            maxDemands: Math.min(maxPhysicalPages, maxRequests) -
                model.safetyCoverPages.length,
        })
        demandController = createVirtualRasterDemandController({
            model,
            residency,
            scheduler,
            viewDemandProducer,
            maxPhysicalPages,
            maxHistory,
        })
    } catch (error) {
        return await failRuntimeCreation({
            model,
            binding,
            residency,
            gpu: gpuState,
            scheduler,
            demandController,
            error,
        })
    }
    const activeResidency = residency
    const activeGpuState = gpuState
    const activeScheduler = scheduler
    const activeDemandController = demandController
    const activeViewDemandProducer = viewDemandProducer
    let demandStopped = false
    let disposed = false
    let stopDemandPromise: Promise<void> | undefined
    let disposePromise: Promise<void> | undefined
    let activePublication: VirtualRasterRuntimePublication | undefined

    async function initialize() {

        const reconciliation = activeDemandController.initialize()
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
        const publication = activeScheduler.publish()
        let update: VirtualRasterGpuUpdate
        try {
            update = activeGpuState.stage(publication)
        } catch (error) {
            void publication.abandon().then(() => {
                activeDemandController.abandonPublication(publication)
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
        await activeGpuState.acknowledge(wrapped.publication, submitted)
        activeDemandController.acknowledgePublication(wrapped.publication)
        activePublication = undefined
    }

    function stopDemand(): Promise<void> {

        if (stopDemandPromise !== undefined) return stopDemandPromise
        demandStopped = true
        stopDemandPromise = activeScheduler.dispose()
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
        const failures: unknown[] = []
        try {
            await stopDemand()
        } catch (error) {
            failures.push(error)
        }
        if (activePublication !== undefined) {
            const publication = activePublication.publication
            try {
                await activeGpuState.abandon(publication)
            } catch (error) {
                failures.push(error)
            }
            try {
                activeDemandController.abandonPublication(publication)
            } catch (error) {
                failures.push(error)
            }
            activePublication = undefined
        }
        for (const dispose of [
            () => activeDemandController.dispose(),
            () => activeResidency.dispose(),
            () => activeGpuState.dispose(),
        ]) {
            try {
                dispose()
            } catch (error) {
                failures.push(error)
            }
        }
        if (binding.ownership === 'owned') {
            try {
                await binding.executor.dispose()
            } catch (error) {
                failures.push(error)
            }
        }
        if (failures.length > 0) {
            throw new AggregateError(failures, `Virtual Raster runtime ${model.id} disposal failed`)
        }
    }

    function inspect(): VirtualRasterRuntimeFacts {

        return Object.freeze({
            kind: 'virtual-raster-runtime' as const,
            id: model.id,
            executorOwnership: binding.ownership,
            demandStopped,
            disposed,
            residency: activeResidency.inspect(),
            scheduler: activeScheduler.inspect(),
            demand: activeDemandController.facts(),
            gpu: activeGpuState.facts(),
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
        residency: activeResidency,
        gpu: activeGpuState,
        scheduler: activeScheduler,
        viewDemandProducer: activeViewDemandProducer,
        initialize,
        reconcileViewDemands: activeDemandController.reconcileViewDemands,
        publish,
        acknowledge,
        stopDemand,
        dispose,
        inspect,
    })
}

function assertExecutorBinding(
    model: Partial<VirtualRasterRuntimeModel> | undefined,
    binding: VirtualRasterExecutorBinding
): VirtualRasterExecutorBinding {

    const ownership = binding?.ownership
    const executor = binding?.executor
    if ((ownership !== 'borrowed' && ownership !== 'owned') ||
        typeof executor?.request !== 'function' ||
        (ownership === 'owned' &&
            typeof (executor as { dispose?: unknown } | undefined)?.dispose !== 'function')) {
        return invalidRuntime(
            model,
            'Virtual Raster executor authority must explicitly be borrowed or owned; owned executors require asynchronous disposal.',
            binding
        )
    }
    return binding
}

async function failRuntimeCreation({
    model,
    binding,
    residency,
    gpu,
    scheduler,
    demandController,
    error,
}: Readonly<{
    model: Partial<VirtualRasterRuntimeModel> | undefined
    binding: VirtualRasterExecutorBinding
    residency: VirtualRasterResidency | undefined
    gpu: VirtualRasterGpuState | undefined
    scheduler: VirtualRasterRequestScheduler | undefined
    demandController: VirtualRasterDemandController | undefined
    error: unknown
}>): Promise<never> {

    const failures = [ error ]
    if (scheduler !== undefined) {
        try {
            await scheduler.dispose()
        } catch (cleanupError) {
            failures.push(cleanupError)
        }
    }
    for (const dispose of [
        () => demandController?.dispose(),
        () => residency?.dispose(),
        () => gpu?.dispose(),
    ]) {
        try {
            dispose()
        } catch (cleanupError) {
            failures.push(cleanupError)
        }
    }
    if (binding.ownership === 'owned') {
        try {
            await binding.executor.dispose()
        } catch (cleanupError) {
            failures.push(cleanupError)
        }
    }
    if (failures.length === 1) throw error
    throw new AggregateError(
        failures,
        `Virtual Raster runtime ${model?.id ?? '<unknown>'} initialization and cleanup failed`
    )
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
        !Array.isArray(model.safetyCoverPages) || model.safetyCoverPages.length === 0 ||
        new Set(model.safetyCoverPages.map(page => page?.key)).size !==
            model.safetyCoverPages.length) {
        return invalidRuntime(
            model,
            'A Virtual Raster runtime model requires one coherent tiled field and a unique non-empty safety cover.',
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
        code: 'GEO_VIRTUAL_RASTER_RUNTIME_INVALID',
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
