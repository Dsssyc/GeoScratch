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
    if (!Number.isSafeInteger(workerCount) || workerCount < 1 || workerCount > 8 ||
        !Number.isSafeInteger(descriptor.maxRequests) || descriptor.maxRequests < 1) {
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
            return createExecution(context, contextIndex, demand, candidate, facts => {
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
            descriptor.cachePolicy.tier
        )
    }

    async function dispose(): Promise<void> {

        if (disposed) return
        disposed = true
        const failures: unknown[] = []
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
    updateFacts: (facts: DemTileWorkerFacts) => void
): VirtualRasterRequestExecution {

    let currentTask: WorkerTaskHandle<unknown> | undefined
    let phase: 'cache' | 'network' | 'decode' = 'cache'
    let terminalState: WorkerTaskState = 'queued'
    let cancelled = false
    let settlement: 'accept' | 'discard' | undefined
    let settlementPromise: Promise<void> | undefined

    const run = async<Input, Output>(operation: string, input: Input): Promise<Output> => {
        if (cancelled) throw cancelledError(candidate.page.key)
        const task = context.run<Input, Output>(operation, input, {
            priority: demand.priority,
            cancellation: 'cooperative',
            generation: demand.generation,
            staleKey: `${candidate.cacheKey.sourceId}:${candidate.page.key}`,
            ...(demand.deadlineMs === undefined ? {} : { deadlineMs: demand.deadlineMs }),
        })
        currentTask = task as WorkerTaskHandle<unknown>
        return await task.result
    }

    const result = (async(): Promise<VirtualRasterPageTransfer> => {
        try {
            phase = 'cache'
            const lookup = await run<DemTileCandidateDescriptor, DemTileLookupResult>(
                'lookup',
                candidate
            )
            if (lookup.status === 'miss') {
                phase = 'network'
                await run<DemTileCandidateDescriptor, DemTileFetchResult>('fetch', candidate)
            }
            phase = 'decode'
            const transfer = await run<Readonly<{ candidateId: string }>, DemTileDecodeResult>(
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
            return currentTask?.cancel(reason) ?? 'none'
        },
        reprioritize(priority: Partial<WorkerTaskPriority>) {

            return currentTask?.reprioritize(priority) ?? false
        },
        accept: () => settle('accept'),
        discard: () => settle('discard'),
        inspect: () => Object.freeze({
            state: currentTask?.inspect().state ?? terminalState,
            phase,
            contextIndex,
        }),
    })
}

function aggregateFacts(
    disposed: boolean,
    system: WorkerSystemFacts,
    group: WorkerGroupFacts,
    workers: readonly DemTileWorkerFacts[],
    tier: VirtualRasterCachePolicy['tier']
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
