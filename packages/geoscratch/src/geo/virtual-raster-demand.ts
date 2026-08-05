import type {
    WorkerCancellationKind,
} from '../worker/diagnostics.js'
import type {
    WorkerTaskPriority,
    WorkerTaskPriorityClass,
    WorkerTaskState,
} from '../worker/worker-system.js'
import { throwGeoDiagnostic } from './diagnostics.js'
import type {
    VirtualRasterPublication,
    VirtualRasterResidency,
    VirtualRasterStageOutcome,
} from './virtual-raster-residency.js'
import {
    adoptVirtualRasterPageTransfer,
    discardOwnedVirtualRasterPagePayload,
    discardVirtualRasterPageTransfer,
} from './virtual-raster-transfer.js'
import type { VirtualRasterPageTransfer } from './virtual-raster-transfer.js'
import type { VirtualRasterPageIdentity } from './virtual-raster.js'

export type VirtualRasterDemandUsage = 'required' | 'prefetch'

export type VirtualRasterPageDemand = Readonly<{
    page: VirtualRasterPageIdentity
    generation: number
    priority: WorkerTaskPriority
    reason: string
    usage: VirtualRasterDemandUsage
    deadlineMs?: number
}>

export type VirtualRasterDemandSetDescriptor = Readonly<{
    generation: number
    demands: readonly VirtualRasterPageDemand[]
}>

export type VirtualRasterDemandSet = Readonly<{
    kind: 'virtual-raster-demand-set'
    generation: number
    demands: readonly VirtualRasterPageDemand[]
}>

export type VirtualRasterRequestExecutionFacts = Readonly<{
    state: WorkerTaskState
    phase?: 'cache' | 'network' | 'decode'
}>

export type VirtualRasterRequestExecution = Readonly<{
    result: Promise<VirtualRasterPageTransfer>
    cancel(reason?: unknown): WorkerCancellationKind | 'none'
    reprioritize(priority: Partial<WorkerTaskPriority>): boolean
    accept(): Promise<void>
    discard(): Promise<void>
    inspect?(): VirtualRasterRequestExecutionFacts
}>

export type VirtualRasterRequestExecutor = Readonly<{
    request(demand: VirtualRasterPageDemand): VirtualRasterRequestExecution
}>

export type VirtualRasterRequestSchedulerDescriptor = Readonly<{
    residency: VirtualRasterResidency
    executor: VirtualRasterRequestExecutor
    maxRequests: number
    maxHistory?: number
}>

export type VirtualRasterDemandHistoryEntry = Readonly<{
    sequence: number
    kind: 'requested' | 'retained' | 'reprioritized' | 'cancelled' | 'staged' |
        'resident' | 'stale' | 'failed' | 'dropped' | 'disposed'
    generation: number
    pageKey: string
    detail?: string
}>

export type VirtualRasterRequestSchedulerFacts = Readonly<{
    disposed: boolean
    generation: number
    demandedPageCount: number
    activeRequestCount: number
    queuedRequestCount: number
    activeNetworkCount: number
    activeDecodeCount: number
    completedRequestCount: number
    failedRequestCount: number
    staleResultCount: number
    cancellationCount: number
    reprioritizationCount: number
    degradationCount: number
    maxRequests: number
    history: readonly VirtualRasterDemandHistoryEntry[]
}>

export type VirtualRasterDemandGenerationFacts = Readonly<{
    generation: number
    stagedCount: number
    residentCount: number
    staleCount: number
    failedCount: number
}>

export type VirtualRasterDemandReconciliation = Readonly<{
    generation: number
    requestedCount: number
    retainedCount: number
    cancelledCount: number
    droppedCount: number
    settled: Promise<VirtualRasterDemandGenerationFacts>
}>

type RequestRecord = {
    demand: VirtualRasterPageDemand
    execution: VirtualRasterRequestExecution
    completion: Promise<VirtualRasterStageOutcome | undefined>
    current: boolean
}

export class VirtualRasterRequestScheduler {

    readonly residency: VirtualRasterResidency
    readonly executor: VirtualRasterRequestExecutor
    readonly maxRequests: number
    readonly maxHistory: number
    readonly #active = new Map<string, RequestRecord>()
    readonly #records = new Set<RequestRecord>()
    readonly #demands = new Map<string, VirtualRasterPageDemand>()
    readonly #history: VirtualRasterDemandHistoryEntry[] = []
    #disposed = false
    #generation = 0
    #sequence = 0
    #completedRequestCount = 0
    #failedRequestCount = 0
    #staleResultCount = 0
    #cancellationCount = 0
    #reprioritizationCount = 0
    #degradationCount = 0
    #disposePromise: Promise<void> | undefined

    constructor(descriptor: VirtualRasterRequestSchedulerDescriptor) {

        if (!positiveSafeInteger(descriptor.maxRequests) ||
            (descriptor.maxHistory !== undefined &&
                !nonNegativeSafeInteger(descriptor.maxHistory))) {
            throwDemandDiagnostic(
                'GEO_VIRTUAL_RASTER_DEMAND_SCHEDULER_INVALID',
                'A demand scheduler requires finite request and history budgets.',
                descriptor
            )
        }
        this.residency = descriptor.residency
        this.executor = descriptor.executor
        this.maxRequests = descriptor.maxRequests
        this.maxHistory = descriptor.maxHistory ?? 64
    }

    reconcile(demandSet: VirtualRasterDemandSet): VirtualRasterDemandReconciliation {

        this.#assertActive()
        assertDemandSet(demandSet)
        if (demandSet.generation < this.#generation) {
            return throwDemandDiagnostic(
                'GEO_VIRTUAL_RASTER_DEMAND_GENERATION_INVALID',
                'Demand generations must be monotonic.',
                { current: this.#generation, received: demandSet.generation }
            )
        }
        const ordered = [ ...demandSet.demands ].sort(compareDemand)
        const selected = ordered.slice(0, this.maxRequests)
        const dropped = ordered.slice(this.maxRequests)
        const selectedByKey = new Map(selected.map(demand => [ demand.page.key, demand ]))
        this.#generation = demandSet.generation
        this.#demands.clear()
        for (const demand of selected) this.#demands.set(demand.page.key, demand)
        this.residency.reconcileGeneration(
            demandSet.generation,
            selected.map(demand => demand.page)
        )

        let cancelledCount = 0
        for (const [ key, record ] of [ ...this.#active ]) {
            if (selectedByKey.has(key)) continue
            record.current = false
            this.#active.delete(key)
            record.execution.cancel({ kind: 'obsolete-demand', generation: demandSet.generation })
            this.#cancellationCount++
            cancelledCount++
            this.#record('cancelled', record.demand, `replaced-by:${demandSet.generation}`)
        }

        let requestedCount = 0
        let retainedCount = 0
        const currentCompletions: Promise<VirtualRasterStageOutcome | undefined>[] = []
        for (const demand of selected) {
            const existing = this.#active.get(demand.page.key)
            if (existing !== undefined) {
                existing.demand = demand
                existing.current = true
                retainedCount++
                this.#record('retained', demand)
                if (existing.execution.reprioritize(demand.priority)) {
                    this.#reprioritizationCount++
                    this.#record('reprioritized', demand)
                }
                currentCompletions.push(existing.completion)
                continue
            }
            let execution: VirtualRasterRequestExecution
            try {
                execution = this.executor.request(demand)
            } catch (error) {
                this.#failedRequestCount++
                this.#degradationCount++
                this.#record('failed', demand, errorMessage(error))
                continue
            }
            const record = {} as RequestRecord
            record.demand = demand
            record.execution = execution
            record.current = true
            record.completion = this.#complete(record)
            this.#records.add(record)
            this.#active.set(demand.page.key, record)
            currentCompletions.push(record.completion)
            requestedCount++
            this.#record('requested', demand)
        }

        for (const demand of dropped) {
            this.#degradationCount++
            this.#record('dropped', demand, 'request-budget')
        }

        const settled = Promise.all(currentCompletions).then(outcomes => {
            let stagedCount = 0
            let residentCount = 0
            let staleCount = 0
            let failedCount = 0
            for (const outcome of outcomes) {
                if (outcome?.status === 'staged') stagedCount++
                else if (outcome?.status === 'resident') residentCount++
                else if (outcome?.status === 'stale') staleCount++
                else if (outcome?.status === 'failed' || outcome?.status === 'disposed' ||
                    outcome === undefined) failedCount++
            }
            return Object.freeze({
                generation: demandSet.generation,
                stagedCount,
                residentCount,
                staleCount,
                failedCount,
            })
        })
        return Object.freeze({
            generation: demandSet.generation,
            requestedCount,
            retainedCount,
            cancelledCount,
            droppedCount: dropped.length,
            settled,
        })
    }

    publish(): VirtualRasterPublication {

        this.#assertActive()
        return this.residency.publish()
    }

    inspect(): VirtualRasterRequestSchedulerFacts {

        let queuedRequestCount = 0
        let activeNetworkCount = 0
        let activeDecodeCount = 0
        for (const record of this.#active.values()) {
            const facts = record.execution.inspect?.()
            if (facts?.state === 'queued') queuedRequestCount++
            if (facts?.phase === 'network') activeNetworkCount++
            if (facts?.phase === 'decode') activeDecodeCount++
        }
        return Object.freeze({
            disposed: this.#disposed,
            generation: this.#generation,
            demandedPageCount: this.#demands.size,
            activeRequestCount: this.#active.size,
            queuedRequestCount,
            activeNetworkCount,
            activeDecodeCount,
            completedRequestCount: this.#completedRequestCount,
            failedRequestCount: this.#failedRequestCount,
            staleResultCount: this.#staleResultCount,
            cancellationCount: this.#cancellationCount,
            reprioritizationCount: this.#reprioritizationCount,
            degradationCount: this.#degradationCount,
            maxRequests: this.maxRequests,
            history: Object.freeze([ ...this.#history ]),
        })
    }

    dispose(): Promise<void> {

        if (this.#disposePromise !== undefined) return this.#disposePromise
        this.#disposePromise = this.#dispose()
        return this.#disposePromise
    }

    async #complete(record: RequestRecord): Promise<VirtualRasterStageOutcome | undefined> {

        let transfer: VirtualRasterPageTransfer | undefined
        let adopted = false
        try {
            transfer = await record.execution.result
            const current = !this.#disposed && record.current &&
                this.#active.get(record.demand.page.key) === record &&
                this.#demands.get(record.demand.page.key) === record.demand
            if (!current) {
                await record.execution.discard()
                discardVirtualRasterPageTransfer(transfer)
                this.#staleResultCount++
                this.#record('stale', record.demand, 'obsolete-result')
                return Object.freeze({
                    status: 'stale',
                    page: record.demand.page,
                    generation: record.demand.generation,
                })
            }
            const payload = adoptVirtualRasterPageTransfer(transfer)
            adopted = true
            let outcome: VirtualRasterStageOutcome
            try {
                outcome = this.residency.stage(payload, {
                    generation: record.demand.generation,
                })
            } catch (error) {
                discardOwnedVirtualRasterPagePayload(payload)
                throw error
            }
            if (outcome.status === 'staged' || outcome.status === 'resident') {
                await record.execution.accept()
                this.#completedRequestCount++
                this.#record(outcome.status, record.demand)
            } else {
                await record.execution.discard()
                if (outcome.status === 'stale') this.#staleResultCount++
                else this.#failedRequestCount++
                this.#record(outcome.status === 'stale' ? 'stale' : 'failed', record.demand,
                    outcome.detail)
            }
            return outcome
        } catch (error) {
            if (!adopted && transfer !== undefined && transfer.buffer.byteLength > 0) {
                discardVirtualRasterPageTransfer(transfer)
            }
            if (!record.current || this.#disposed) {
                this.#staleResultCount++
                this.#record('stale', record.demand, errorMessage(error))
                return Object.freeze({
                    status: 'stale',
                    page: record.demand.page,
                    generation: record.demand.generation,
                })
            }
            this.#failedRequestCount++
            this.#record('failed', record.demand, errorMessage(error))
            return undefined
        } finally {
            this.#records.delete(record)
            if (this.#active.get(record.demand.page.key) === record) {
                this.#active.delete(record.demand.page.key)
            }
        }
    }

    async #dispose(): Promise<void> {

        if (this.#disposed) return
        this.#disposed = true
        for (const record of this.#records) {
            record.current = false
            record.execution.cancel({ kind: 'scheduler-dispose' })
        }
        this.#active.clear()
        this.#demands.clear()
        const page = this.residency.addressSpace.page({
            level: this.residency.addressSpace.levelCount - 1,
            x: 0,
            y: 0,
        })
        this.#record('disposed', Object.freeze({
            page,
            generation: this.#generation,
            priority: Object.freeze({ class: 'background', score: 0 }),
            reason: 'scheduler-dispose',
            usage: 'prefetch',
        }))
    }

    #record(
        kind: VirtualRasterDemandHistoryEntry['kind'],
        demand: VirtualRasterPageDemand,
        detail?: string
    ): void {

        if (this.maxHistory === 0) return
        this.#history.push(Object.freeze({
            sequence: ++this.#sequence,
            kind,
            generation: demand.generation,
            pageKey: demand.page.key,
            ...(detail === undefined ? {} : { detail }),
        }))
        if (this.#history.length > this.maxHistory) {
            this.#history.splice(0, this.#history.length - this.maxHistory)
        }
    }

    #assertActive(): void {

        if (this.#disposed) {
            return throwDemandDiagnostic(
                'GEO_VIRTUAL_RASTER_DEMAND_SCHEDULER_DISPOSED',
                'Virtual raster demand scheduler is disposed.',
                { generation: this.#generation }
            )
        }
    }
}

export function virtualRasterDemandSet(
    descriptor: VirtualRasterDemandSetDescriptor
): VirtualRasterDemandSet {

    if (!nonNegativeSafeInteger(descriptor.generation) || !Array.isArray(descriptor.demands)) {
        return throwDemandDiagnostic(
            'GEO_VIRTUAL_RASTER_DEMAND_SET_INVALID',
            'A demand set requires one non-negative generation and a finite demand list.',
            descriptor
        )
    }
    const keys = new Set<string>()
    const demands = descriptor.demands.map(demand => {
        validateDemand(demand, descriptor.generation)
        if (keys.has(demand.page.key)) {
            return throwDemandDiagnostic(
                'GEO_VIRTUAL_RASTER_DEMAND_DUPLICATE',
                'A page can appear at most once in a demand generation.',
                { generation: descriptor.generation, pageKey: demand.page.key }
            )
        }
        keys.add(demand.page.key)
        return Object.freeze({
            ...demand,
            priority: Object.freeze({ ...demand.priority }),
        })
    })
    return Object.freeze({
        kind: 'virtual-raster-demand-set',
        generation: descriptor.generation,
        demands: Object.freeze(demands),
    })
}

function assertDemandSet(demandSet: VirtualRasterDemandSet): void {

    if (demandSet.kind !== 'virtual-raster-demand-set') {
        return throwDemandDiagnostic(
            'GEO_VIRTUAL_RASTER_DEMAND_SET_INVALID',
            'Demand reconciliation requires a set from virtualRasterDemandSet().',
            demandSet
        )
    }
}

function validateDemand(demand: VirtualRasterPageDemand, generation: number): void {

    const priorityClasses = new Set<WorkerTaskPriorityClass>([
        'background',
        'user-visible',
        'critical',
    ])
    if (demand?.page?.kind !== 'virtual-raster-page' || demand.generation !== generation ||
        !priorityClasses.has(demand.priority?.class) ||
        !Number.isFinite(demand.priority?.score) ||
        typeof demand.reason !== 'string' || demand.reason.length === 0 ||
        (demand.usage !== 'required' && demand.usage !== 'prefetch') ||
        (demand.deadlineMs !== undefined &&
            (!Number.isFinite(demand.deadlineMs) || demand.deadlineMs < 0))) {
        return throwDemandDiagnostic(
            'GEO_VIRTUAL_RASTER_PAGE_DEMAND_INVALID',
            'Each page demand requires matching generation, priority, reason, and usage facts.',
            demand
        )
    }
}

function compareDemand(left: VirtualRasterPageDemand, right: VirtualRasterPageDemand): number {

    return priorityRank(right.priority.class) - priorityRank(left.priority.class) ||
        usageRank(right.usage) - usageRank(left.usage) ||
        right.priority.score - left.priority.score ||
        (left.deadlineMs ?? Number.POSITIVE_INFINITY) -
            (right.deadlineMs ?? Number.POSITIVE_INFINITY) ||
        left.page.key.localeCompare(right.page.key)
}

function priorityRank(priority: WorkerTaskPriorityClass): number {

    switch (priority) {
        case 'critical': return 3
        case 'user-visible': return 2
        case 'background': return 1
    }
}

function usageRank(usage: VirtualRasterDemandUsage): number {

    return usage === 'required' ? 1 : 0
}

function errorMessage(error: unknown): string {

    return error instanceof Error ? error.message : String(error)
}

function positiveSafeInteger(value: unknown): value is number {

    return Number.isSafeInteger(value) && Number(value) > 0
}

function nonNegativeSafeInteger(value: unknown): value is number {

    return Number.isSafeInteger(value) && Number(value) >= 0
}

function throwDemandDiagnostic(code: string, message: string, actual: unknown): never {

    return throwGeoDiagnostic({
        code,
        phase: 'demand',
        subject: { kind: 'virtual-raster-demand' },
        message,
        actual,
    })
}
