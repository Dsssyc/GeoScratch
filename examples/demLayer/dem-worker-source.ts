import {
    createVirtualRasterWorkerExecutor,
    virtualRasterCacheAddress,
} from 'geoscratch/geo'
import type {
    VirtualRasterPageDemand,
    VirtualRasterWorkerExecutor,
} from 'geoscratch/geo'
import { WorkerSystem } from 'geoscratch/scratch'
import type { WorkerModuleResolver } from 'geoscratch/scratch'
import type {
    DemCachePolicy,
    DemTileCacheFacts,
    DemTileCandidateDescriptor,
    DemTileWorkerFacts,
    DemTileWorkerInit,
} from './dem-tile-protocol.ts'
import { DEM_TILE_WORKER } from './dem-tile-protocol.ts'

type DemWorkerTileSourceDescriptor = Readonly<{
    sourceId: string
    tileMatrixSetId: 'WebMercatorQuad'
    tileMatrixSetUri: string
    plane: string
    contentVersion: string
    encodedRepresentation: 'image/png'
    decoderVersion: string
    sampleType: 'uint8'
    cacheSchemaVersion: number
    cachePolicy: DemCachePolicy
    workerModules: WorkerModuleResolver
    workerCount?: number
    maxNetworkRequests?: number
    maxDecodeTasks?: number
    maxRequests: number
    tileUrl(page: VirtualRasterPageDemand['page']): string
}>

export type DemWorkerRequestExecutor = VirtualRasterWorkerExecutor<DemTileWorkerFacts>

let executorSequence = 0

export async function createDemWorkerRequestExecutor(
    descriptor: DemWorkerTileSourceDescriptor
): Promise<DemWorkerRequestExecutor> {

    const workerCount = descriptor.workerCount ?? defaultWorkerCount()
    const maxNetworkRequests = descriptor.maxNetworkRequests ?? workerCount
    const maxDecodeTasks = descriptor.maxDecodeTasks ?? Math.max(1, Math.ceil(workerCount / 2))
    if (!positiveInteger(workerCount) || workerCount > 8 ||
        !positiveInteger(descriptor.maxRequests) ||
        !positiveInteger(maxNetworkRequests) || !positiveInteger(maxDecodeTasks)) {
        throw new TypeError('DEM worker executor requires finite worker and request budgets')
    }
    const sequence = ++executorSequence
    const system = new WorkerSystem({
        maxWorkers: workerCount,
        maxHistory: 64,
        agingIntervalMs: 50,
        moduleResolver: descriptor.workerModules,
    })
    let core: VirtualRasterWorkerExecutor<DemTileWorkerFacts>
    try {
        core = await createVirtualRasterWorkerExecutor({
            id: `dem-tile-workers-${sequence}`,
            system,
            module: DEM_TILE_WORKER,
            workerCount,
            maxRequests: descriptor.maxRequests,
            phaseLimits: {
                network: maxNetworkRequests,
                decode: maxDecodeTasks,
            },
            context: index => ({
                key: `dem-cache-shard-${index}`,
                init: {
                    cache: shardCacheConfiguration(
                        descriptor.cachePolicy,
                        index,
                        workerCount
                    ),
                },
            }),
            candidate: (demand, requestSequence) => createCandidate(
                descriptor,
                sequence,
                requestSequence,
                demand
            ),
            staleKey: candidate =>
                `${candidate.cacheAddress.metadata.sourceId}:${candidate.page.key}`,
            initialFacts: () => emptyWorkerFacts(descriptor.cachePolicy),
            disposedFacts: disposedWorkerFacts,
            classifyFailure: error => {
                const code = remoteFailureCode(error)
                return code === 'DEM_TILE_MISSING'
                    ? Object.freeze({
                        disposition: 'terminal' as const,
                        code,
                        detail: error instanceof Error ? error.message : String(error),
                    })
                    : undefined
            },
        })
    } catch (error) {
        try {
            await system.dispose()
        } catch (cleanupError) {
            throw new AggregateError(
                [ error, cleanupError ],
                'DEM Worker executor initialization and cleanup failed'
            )
        }
        throw error
    }

    let disposal: Promise<void> | undefined

    async function disposeOnce(): Promise<void> {

        const settlements = await Promise.allSettled([ core.dispose() ])
        const systemSettlement = await Promise.allSettled([ system.dispose() ])
        const failures = [ ...settlements, ...systemSettlement ]
            .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
            .map(result => result.reason)
        if (failures.length > 0) {
            throw new AggregateError(failures, 'DEM Worker executor disposal failed')
        }
    }

    return Object.freeze({
        request: core.request,
        refreshFacts: core.refreshFacts,
        inspect: core.inspect,
        dispose() {

            disposal ??= disposeOnce()
            return disposal
        },
    })
}

function createCandidate(
    descriptor: DemWorkerTileSourceDescriptor,
    executorSequence: number,
    requestSequence: number,
    demand: VirtualRasterPageDemand
): DemTileCandidateDescriptor {

    const tile = demand.page.tile
    if (tile === undefined || tile.tileMatrixSetId !== descriptor.tileMatrixSetId) {
        throw new TypeError('DEM worker requests require standard WebMercatorQuad pages')
    }
    return Object.freeze({
        candidateId: `${executorSequence}:${requestSequence}:${demand.generation}:${demand.page.key}`,
        page: demand.page,
        cacheAddress: virtualRasterCacheAddress({
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
            sourceRepresentation: descriptor.encodedRepresentation,
            payloadRepresentation: 'raw/uint8',
            decoderVersion: descriptor.decoderVersion,
            sampleType: descriptor.sampleType,
            schemaVersion: descriptor.cacheSchemaVersion,
        }),
        url: descriptor.tileUrl(demand.page),
        contentVersion: descriptor.contentVersion,
    })
}

function shardCacheConfiguration(
    policy: DemCachePolicy,
    shard: number,
    count: number
): DemTileWorkerInit['cache'] {

    if (policy.mode === 'none') return Object.freeze({ mode: 'none' })
    return Object.freeze({
        mode: 'persistent',
        descriptor: Object.freeze({
            namespace: `${policy.namespace}.shard-${shard}`,
            maxPayloadBytes: dividedBudget(policy.maxPayloadBytes, count),
            maxEntries: dividedBudget(policy.maxEntries, count),
            maxHistory: 64,
            requestPersistence: policy.requestPersistence && shard === 0,
            lifecycle: policy.lifecycle,
        }),
    })
}

function emptyWorkerFacts(policy: DemCachePolicy): DemTileWorkerFacts {

    return Object.freeze({
        cache: policy.mode === 'none'
            ? emptyDisabledCacheFacts()
            : emptyPersistentCacheFacts(policy),
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
        cache: facts.cache.mode === 'none'
            ? facts.cache
            : Object.freeze({ ...facts.cache, state: 'disposed', activeOperationCount: 0 }),
        pendingCandidateCount: 0,
        senderDecodedByteLength: 0,
    })
}

function emptyDisabledCacheFacts(): Extract<DemTileCacheFacts, { mode: 'none' }> {

    return Object.freeze({
        mode: 'none',
        state: 'disabled',
        entryCount: 0,
        payloadBytes: 0,
        hitCount: 0,
        missCount: 0,
        putCount: 0,
        evictionCount: 0,
        quotaFailureCount: 0,
    })
}

function emptyPersistentCacheFacts(
    policy: Extract<DemCachePolicy, { mode: 'persistent' }>
): Extract<DemTileCacheFacts, { mode: 'persistent' }> {

    return Object.freeze({
        mode: 'persistent',
        namespace: 'pending',
        observationScope: 'instance',
        state: 'active',
        lifecycle: policy.lifecycle,
        maxPayloadBytes: 0,
        maxEntries: 0,
        maxHistory: 0,
        activeOperationCount: 0,
        entryCount: 0,
        metadataOnlyEntryCount: 0,
        payloadBytes: 0,
        hitCount: 0,
        missCount: 0,
        recoveredMissCount: 0,
        putCount: 0,
        alreadyPresentCount: 0,
        evictionCount: 0,
        deletionCount: 0,
        garbageCollectionCount: 0,
        cleanupFailureCount: 0,
        quotaFailureCount: 0,
        persistenceRequested: policy.requestPersistence,
        history: Object.freeze([]),
    })
}

function remoteFailureCode(error: unknown): string | undefined {

    if (typeof error !== 'object' || error === null) return undefined
    const direct = (error as { code?: unknown }).code
    if (typeof direct === 'string') return direct
    const remote = (error as {
        diagnostic?: { actual?: { remoteCode?: unknown } }
    }).diagnostic?.actual?.remoteCode
    return typeof remote === 'string' ? remote : undefined
}

function dividedBudget(value: number, count: number): number {

    return Math.max(1, Math.floor(value / count))
}

function defaultWorkerCount(): number {

    const hardware = globalThis.navigator?.hardwareConcurrency ?? 2
    return Math.max(1, Math.min(4, hardware - 1))
}

function positiveInteger(value: unknown): value is number {

    return Number.isSafeInteger(value) && Number(value) > 0
}
