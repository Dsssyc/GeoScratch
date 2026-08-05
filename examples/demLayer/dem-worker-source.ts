import {
    virtualRasterCacheKey,
} from 'geoscratch/geo'
import type {
    VirtualRasterCacheFacts,
    VirtualRasterCachePolicy,
    VirtualRasterPageDemand,
    VirtualRasterPageTransfer,
    VirtualRasterRequestExecution,
    VirtualRasterRequestExecutor,
} from 'geoscratch/geo'
import {
    WorkerSystem,
} from 'geoscratch/worker'
import type {
    WorkerContextHandle,
    WorkerGroup,
    WorkerGroupFacts,
    WorkerSystemFacts,
    WorkerTaskHandle,
    WorkerTaskPriority,
    WorkerTaskState,
} from 'geoscratch/worker'
import type {
    DemTileCandidateDescriptor,
    DemTileDecodeResult,
    DemTileFetchResult,
    DemTileLookupResult,
    DemTileWorkerFacts,
    DemTileWorkerInit,
} from './dem-tile-protocol.ts'
import {
    DemPhaseBudget,
} from './dem-phase-budget.ts'
import type {
    DemPhaseBudgetFacts,
    DemPhasePermit,
    DemPhasePermitRequest,
    DemWorkerPhase,
} from './dem-phase-budget.ts'
import demTileWorkerUrl from './dem-tile-worker-url.ts'

export type DemWorkerTileSourceDescriptor = Readonly<{
    sourceId: string
    tileMatrixSetId: 'WebMercatorQuad'
    tileMatrixSetUri: string
    plane: string
    contentVersion: string
    encodedRepresentation: 'image/png'
    decoderVersion: string
    sampleType: 'uint8'
    cacheSchemaVersion: number
    cachePolicy: VirtualRasterCachePolicy
    requestPersistence?: boolean
    workerCount?: number
    maxNetworkRequests?: number
    maxDecodeTasks?: number
    maxRequests: number
    tileUrl(page: VirtualRasterPageDemand['page']): string
}>

export type DemWorkerRequestExecutorFacts = Readonly<{
    disposed: boolean
    system: WorkerSystemFacts
    group: WorkerGroupFacts
    workers: readonly DemTileWorkerFacts[]
    cache: Readonly<{
        tier: VirtualRasterCachePolicy['tier']
        memoryBytes: number
        persistentBytes: number
        hitCount: number
        memoryHitCount: number
        persistentHitCount: number
        missCount: number
        putCount: number
        evictionCount: number
        quotaFailureCount: number
    }>
    networkRequestCount: number
    decodedPageCount: number
    acceptedCandidateCount: number
    discardedCandidateCount: number
    pendingCandidateCount: number
    maxPendingCandidateCount: number
    senderDecodedByteLength: number
    phaseBudget: DemPhaseBudgetFacts
}>

export type DemWorkerRequestExecutor = VirtualRasterRequestExecutor & Readonly<{
    refreshFacts(): Promise<DemWorkerRequestExecutorFacts>
    inspect(): DemWorkerRequestExecutorFacts
    clearCache(): Promise<DemWorkerRequestExecutorFacts>
    dispose(): Promise<void>
}>

type DemContext = WorkerContextHandle<DemTileWorkerFacts>

const MODULE_ID = 'geoscratch-dem-tile'
const MODULE_VERSION = '1'
let executorSequence = 0

export async function createDemWorkerRequestExecutor(
    descriptor: DemWorkerTileSourceDescriptor
): Promise<DemWorkerRequestExecutor> {

    const workerCount = descriptor.workerCount ?? defaultWorkerCount()
    const maxNetworkRequests = descriptor.maxNetworkRequests ?? workerCount
    const maxDecodeTasks = descriptor.maxDecodeTasks ?? Math.max(1, Math.ceil(workerCount / 2))
    if (!Number.isSafeInteger(workerCount) || workerCount < 1 || workerCount > 8 ||
        !Number.isSafeInteger(descriptor.maxRequests) || descriptor.maxRequests < 1 ||
        !Number.isSafeInteger(maxNetworkRequests) || maxNetworkRequests < 1 ||
        !Number.isSafeInteger(maxDecodeTasks) || maxDecodeTasks < 1) {
        throw new TypeError('DEM worker executor requires finite worker and request budgets')
    }
    const id = ++executorSequence
    const system = new WorkerSystem({
        maxWorkers: workerCount,
        maxHistory: 64,
        agingIntervalMs: 50,
    })
    const group = system.createGroup({
        id: `dem-tile-workers-${id}`,
        modules: [ {
            id: MODULE_ID,
            version: MODULE_VERSION,
            url: new URL(demTileWorkerUrl, import.meta.url),
        } ],
        isolation: 'group',
        size: { min: workerCount, max: workerCount },
        maxQueuedTasks: Math.max(16, descriptor.maxRequests * 4),
        maxActiveTasks: workerCount,
        idleTimeoutMs: 30_000,
    })
    try {
        await group.ready
    } catch (error) {
        await system.dispose()
        throw error
    }
    const contexts: DemContext[] = []
    const phaseBudget = new DemPhaseBudget({
        maxNetworkRequests,
        maxDecodeTasks,
        maxQueuedTasks: descriptor.maxRequests,
    })
    try {
        for (let index = 0; index < workerCount; index++) {
            contexts.push(await group.openContext<DemTileWorkerInit, DemTileWorkerFacts>({
                module: MODULE_ID,
                key: `dem-cache-shard-${index}`,
                init: {
                    cachePolicy: shardCachePolicy(descriptor.cachePolicy, index, workerCount),
                    requestPersistence: descriptor.requestPersistence ?? false,
                },
            }))
        }
    } catch (error) {
        await system.dispose()
        throw error
    }

    let requestSequence = 0
    let disposed = false
    let disposePromise: Promise<void> | undefined
    let workerFacts = contexts.map(() => emptyWorkerFacts(descriptor.cachePolicy.tier))

    const source: DemWorkerRequestExecutor = Object.freeze({
        request(demand) {

            if (disposed) throw new Error('DEM worker request executor is disposed')
            const contextIndex = stableShard(demand.page.key, contexts.length)
            const context = contexts[contextIndex]!
            const tile = demand.page.tile
            if (tile === undefined || tile.tileMatrixSetId !== descriptor.tileMatrixSetId) {
                throw new TypeError('DEM worker requests require standard WebMercatorQuad pages')
            }
            const candidate: DemTileCandidateDescriptor = Object.freeze({
                candidateId: `${id}:${++requestSequence}:${demand.generation}:${demand.page.key}`,
                page: demand.page,
                cacheKey: virtualRasterCacheKey({
                    sourceId: descriptor.sourceId,
                    tileMatrixSetId: descriptor.tileMatrixSetId,
                    tileMatrixSetUri: descriptor.tileMatrixSetUri,
                    matrixId: tile.matrixId,
                    tileRow: tile.tileRow,
                    tileColumn: tile.tileCol,
                    plane: descriptor.plane,
                    coherence: {
                        mode: 'immutable',
                        contentVersion: descriptor.contentVersion,
                    },
                    encodedRepresentation: descriptor.encodedRepresentation,
                    decoderVersion: descriptor.decoderVersion,
                    sampleType: descriptor.sampleType,
                    schemaVersion: descriptor.cacheSchemaVersion,
                }),
                url: descriptor.tileUrl(demand.page),
                contentVersion: descriptor.contentVersion,
            })
            return createExecution(context, contextIndex, demand, candidate, phaseBudget, facts => {
                workerFacts[contextIndex] = facts
            })
        },
        async refreshFacts() {

            if (!disposed) {
                workerFacts = await Promise.all(contexts.map(context =>
                    context.run<null, DemTileWorkerFacts>('facts', null, {
                        priority: { class: 'background', score: -1 },
                        cancellation: 'cooperative',
                    }).result
                ))
            }
            return inspect()
        },
        inspect,
        async clearCache() {

            if (disposed) return inspect()
            workerFacts = await Promise.all(contexts.map(context =>
                context.run<null, DemTileWorkerFacts>('clear', null, {
                    priority: { class: 'background', score: 0 },
                    cancellation: 'cooperative',
                }).result
            ))
            return inspect()
        },
        dispose() {

            if (disposePromise !== undefined) return disposePromise
            disposePromise = dispose()
            return disposePromise
        },
    })
    return source

    function inspect(): DemWorkerRequestExecutorFacts {

        return aggregateFacts(
            disposed,
            system.inspect(),
            group.inspect(),
            workerFacts,
            descriptor.cachePolicy.tier,
            phaseBudget.inspect()
        )
    }

    async function dispose(): Promise<void> {

        if (disposed) return
        disposed = true
        const failures: unknown[] = []
        const phaseBudgetDisposal = phaseBudget.dispose()
        const contextSettlements = await Promise.allSettled(
            contexts.map(context => context.dispose())
        )
        for (const settlement of contextSettlements) {
            if (settlement.status === 'rejected') failures.push(settlement.reason)
        }
        try {
            await group.dispose()
        } catch (error) {
            failures.push(error)
        }
        try {
            await system.dispose()
        } catch (error) {
            failures.push(error)
        }
        try {
            await phaseBudgetDisposal
        } catch (error) {
            failures.push(error)
        }
        workerFacts = workerFacts.map(disposedWorkerFacts)
        if (failures.length > 0) {
            throw new AggregateError(failures, 'DEM Worker executor disposal failed')
        }
    }
}

function createExecution(
    context: DemContext,
    contextIndex: number,
    demand: VirtualRasterPageDemand,
    candidate: DemTileCandidateDescriptor,
    phaseBudget: DemPhaseBudget,
    updateFacts: (facts: DemTileWorkerFacts) => void
): VirtualRasterRequestExecution {

    let currentTask: WorkerTaskHandle<unknown> | undefined
    let phaseRequest: DemPhasePermitRequest | undefined
    let phasePermit: DemPhasePermit | undefined
    let phase: 'cache' | 'network' | 'decode' = 'cache'
    let terminalState: WorkerTaskState = 'queued'
    let priority = demand.priority
    let cancelled = false
    let settlement: 'accept' | 'discard' | undefined
    let settlementPromise: Promise<void> | undefined

    const run = async<Input, Output>(operation: string, input: Input): Promise<Output> => {
        if (cancelled) throw cancelledError(candidate.page.key)
        const task = context.run<Input, Output>(operation, input, {
            priority,
            cancellation: 'cooperative',
            generation: demand.generation,
            staleKey: `${candidate.cacheKey.sourceId}:${candidate.page.key}`,
            ...(demand.deadlineMs === undefined ? {} : { deadlineMs: demand.deadlineMs }),
        })
        currentTask = task as WorkerTaskHandle<unknown>
        return await task.result
    }

    const runPhase = async<Input, Output>(
        nextPhase: DemWorkerPhase,
        operation: string,
        input: Input
    ): Promise<Output> => {

        phase = nextPhase
        currentTask = undefined
        const request = phaseBudget.acquire(nextPhase, priority)
        phaseRequest = request
        const permit = await request.result
        phasePermit = permit
        if (cancelled) {
            permit.release()
            phasePermit = undefined
            throw cancelledError(candidate.page.key)
        }
        try {
            return await run<Input, Output>(operation, input)
        } finally {
            permit.release()
            phasePermit = undefined
            phaseRequest = undefined
        }
    }

    const result = (async(): Promise<VirtualRasterPageTransfer> => {
        try {
            phase = 'cache'
            const lookup = await run<DemTileCandidateDescriptor, DemTileLookupResult>(
                'lookup',
                candidate
            )
            if (lookup.status === 'miss') {
                await runPhase<DemTileCandidateDescriptor, DemTileFetchResult>(
                    'network',
                    'fetch',
                    candidate
                )
            }
            const transfer = await runPhase<Readonly<{ candidateId: string }>, DemTileDecodeResult>(
                'decode',
                'decode',
                { candidateId: candidate.candidateId }
            )
            terminalState = 'succeeded'
            return transfer
        } catch (error) {
            terminalState = currentTask?.inspect().state ?? (cancelled ? 'cancelled' : 'failed')
            throw error
        }
    })()

    function settle(kind: 'accept' | 'discard'): Promise<void> {

        if (settlementPromise !== undefined) {
            return settlement === kind
                ? settlementPromise
                : Promise.reject(new Error(`DEM candidate already settled as ${settlement}`))
        }
        settlement = kind
        settlementPromise = context.run<Readonly<{ candidateId: string }>, DemTileWorkerFacts>(
            kind,
            { candidateId: candidate.candidateId },
            {
                priority: { class: 'critical', score: Number.MAX_SAFE_INTEGER },
                cancellation: 'cooperative',
            }
        ).result.then(facts => {
            updateFacts(facts)
        })
        return settlementPromise
    }

    return Object.freeze({
        result,
        cancel(reason?: unknown) {

            cancelled = true
            const phaseCancelled = phaseRequest?.cancel(reason) ?? false
            const taskCancellation = currentTask?.cancel(reason) ?? 'none'
            if (taskCancellation !== 'none') return taskCancellation
            return phaseCancelled ? 'queued' : 'none'
        },
        reprioritize(priority: Partial<WorkerTaskPriority>) {

            const phaseReprioritized = phaseRequest?.reprioritize(priority) ?? false
            const taskReprioritized = currentTask?.reprioritize(priority) ?? false
            updatePriority(priority)
            return phaseReprioritized || taskReprioritized
        },
        accept: () => settle('accept'),
        discard: () => settle('discard'),
        inspect: () => Object.freeze({
            state: phaseRequest?.inspect().state === 'queued'
                ? 'queued'
                : currentTask?.inspect().state ?? (phasePermit === undefined
                    ? terminalState
                    : 'running'),
            phase,
            contextIndex,
        }),
    })

    function updatePriority(next: Partial<WorkerTaskPriority>): void {

        priority = Object.freeze({
            class: next.class ?? priority.class,
            score: next.score ?? priority.score,
        })
    }
}

function aggregateFacts(
    disposed: boolean,
    system: WorkerSystemFacts,
    group: WorkerGroupFacts,
    workers: readonly DemTileWorkerFacts[],
    tier: VirtualRasterCachePolicy['tier'],
    phaseBudget: DemPhaseBudgetFacts
): DemWorkerRequestExecutorFacts {

    const sumCache = (read: (facts: VirtualRasterCacheFacts) => number) =>
        workers.reduce((sum, worker) => sum + read(worker.cache), 0)
    const sum = (read: (facts: DemTileWorkerFacts) => number) =>
        workers.reduce((total, worker) => total + read(worker), 0)
    return Object.freeze({
        disposed,
        system,
        group,
        workers: Object.freeze([ ...workers ]),
        cache: Object.freeze({
            tier,
            memoryBytes: sumCache(facts => facts.memoryBytes),
            persistentBytes: sumCache(facts => facts.persistentBytes),
            hitCount: sumCache(facts => facts.hitCount),
            memoryHitCount: sumCache(facts => facts.memoryHitCount),
            persistentHitCount: sumCache(facts => facts.persistentHitCount),
            missCount: sumCache(facts => facts.missCount),
            putCount: sumCache(facts => facts.putCount),
            evictionCount: sumCache(facts => facts.evictionCount),
            quotaFailureCount: sumCache(facts => facts.quotaFailureCount),
        }),
        networkRequestCount: sum(facts => facts.networkRequestCount),
        decodedPageCount: sum(facts => facts.decodedPageCount),
        acceptedCandidateCount: sum(facts => facts.acceptedCandidateCount),
        discardedCandidateCount: sum(facts => facts.discardedCandidateCount),
        pendingCandidateCount: sum(facts => facts.pendingCandidateCount),
        maxPendingCandidateCount: Math.max(0, ...workers.map(facts => facts.maxPendingCandidateCount)),
        senderDecodedByteLength: sum(facts => facts.senderDecodedByteLength),
        phaseBudget,
    })
}

function shardCachePolicy(
    policy: VirtualRasterCachePolicy,
    shard: number,
    count: number
): VirtualRasterCachePolicy {

    if (policy.tier === 'none') return policy
    if (policy.tier === 'memory') {
        return Object.freeze({
            tier: 'memory',
            maxBytes: dividedBudget(policy.maxBytes, count),
        })
    }
    return Object.freeze({
        tier: 'persistent',
        memoryMaxBytes: dividedBudget(policy.memoryMaxBytes, count),
        persistentMaxBytes: dividedBudget(policy.persistentMaxBytes, count),
        backend: 'indexeddb',
        namespace: `${policy.namespace}.shard-${shard}`,
    })
}

function dividedBudget(value: number, count: number): number {

    return Math.max(1, Math.floor(value / count))
}

function stableShard(key: string, count: number): number {

    let hash = 0x811c9dc5
    for (let index = 0; index < key.length; index++) {
        hash ^= key.charCodeAt(index)
        hash = Math.imul(hash, 0x01000193)
    }
    return (hash >>> 0) % count
}

function defaultWorkerCount(): number {

    const hardware = globalThis.navigator?.hardwareConcurrency ?? 2
    return Math.max(1, Math.min(4, hardware - 1))
}

function emptyWorkerFacts(tier: VirtualRasterCachePolicy['tier']): DemTileWorkerFacts {

    return Object.freeze({
        cache: Object.freeze({
            tier,
            disposed: false,
            memoryEntryCount: 0,
            memoryBytes: 0,
            persistentEntryCount: 0,
            persistentBytes: 0,
            hitCount: 0,
            memoryHitCount: 0,
            persistentHitCount: 0,
            missCount: 0,
            putCount: 0,
            evictionCount: 0,
            invalidationCount: 0,
            quotaFailureCount: 0,
            persistenceRequested: false,
        }),
        pendingCandidateCount: 0,
        networkRequestCount: 0,
        decodedPageCount: 0,
        acceptedCandidateCount: 0,
        discardedCandidateCount: 0,
        senderDecodedByteLength: 0,
        maxPendingCandidateCount: 0,
    })
}

function disposedWorkerFacts(facts: DemTileWorkerFacts): DemTileWorkerFacts {

    return Object.freeze({
        ...facts,
        cache: Object.freeze({
            ...facts.cache,
            disposed: true,
            memoryEntryCount: 0,
            memoryBytes: 0,
            persistentEntryCount: 0,
            persistentBytes: 0,
        }),
        pendingCandidateCount: 0,
        senderDecodedByteLength: 0,
    })
}

function cancelledError(pageKey: string): Error {

    const error = new Error(`DEM tile ${pageKey} request was cancelled`)
    error.name = 'AbortError'
    return error
}
