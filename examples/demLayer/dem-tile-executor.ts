import {
    createVirtualRasterWorkerExecutor,
    virtualRasterCacheAddress,
} from 'geoscratch/geo'
import type {
    VirtualRasterPageDemand,
    VirtualRasterWorkerExecutor,
} from 'geoscratch/geo'
import {
    recommendedWorkerCount,
    workerRemoteErrorCode,
} from 'geoscratch/scratch'
import type { WorkerModuleResolver } from 'geoscratch/scratch'
import type {
    DemCachePolicy,
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

    const workerCount = descriptor.workerCount ?? recommendedWorkerCount()
    const maxNetworkRequests = descriptor.maxNetworkRequests ?? workerCount
    const maxDecodeTasks = descriptor.maxDecodeTasks ?? Math.max(1, Math.ceil(workerCount / 2))
    if (!positiveInteger(workerCount) || workerCount > 8 ||
        !positiveInteger(descriptor.maxRequests) ||
        !positiveInteger(maxNetworkRequests) || !positiveInteger(maxDecodeTasks)) {
        throw new TypeError('DEM worker executor requires finite worker and request budgets')
    }
    const sequence = ++executorSequence
    return await createVirtualRasterWorkerExecutor({
        id: `dem-tile-workers-${sequence}`,
        system: {
            ownership: 'owned',
            options: {
                maxWorkers: workerCount,
                maxHistory: 64,
                agingIntervalMs: 50,
                moduleResolver: descriptor.workerModules,
            },
        },
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
        classifyFailure: error => {
            const code = workerRemoteErrorCode(error)
            return code === 'DEM_TILE_MISSING'
                ? Object.freeze({
                    disposition: 'terminal' as const,
                    code,
                    detail: error instanceof Error ? error.message : String(error),
                })
                : undefined
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

function dividedBudget(value: number, count: number): number {

    return Math.max(1, Math.floor(value / count))
}

function positiveInteger(value: unknown): value is number {

    return Number.isSafeInteger(value) && Number(value) > 0
}
