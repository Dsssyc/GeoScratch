import {
    createVirtualRasterWorkerExecutor,
    virtualRasterCacheAddress,
} from 'geoscratch/geo'
import type {
    VirtualRasterPageDemand,
    VirtualRasterPageIdentity,
    VirtualRasterWorkerExecutor,
} from 'geoscratch/geo'
import {
    persistentCacheDescriptor,
    workerRemoteErrorCode,
} from 'geoscratch/scratch'
import type {
    WorkerModuleResolver,
    WorkerSystem,
} from 'geoscratch/scratch'
import type { FlowFieldCachePolicy } from './cache-policy.ts'
import type {
    FlowVelocityTileCandidateDescriptor,
    FlowVelocityTileWorkerFacts,
    FlowVelocityTileWorkerInit,
} from './velocity-tile-protocol.ts'
import { FLOW_FIELD_VELOCITY_TILE_WORKER } from './velocity-tile-protocol.ts'

type FlowVelocityWorkerTileSourceDescriptor = Readonly<{
    sourceId: string
    sampleKey: string
    contentVersion: string
    cachePolicy: FlowFieldCachePolicy
    workerSystem: WorkerSystem
    workerModules: WorkerModuleResolver
    workerCount?: number
    maxNetworkRequests?: number
    maxDecodeTasks?: number
    maxRequests: number
    resolvePage(page: VirtualRasterPageIdentity): Readonly<{
        url: string
        byteLength: 524288
        sha256: string
    }>
}>

export type FlowVelocityWorkerRequestExecutor =
    VirtualRasterWorkerExecutor<FlowVelocityTileWorkerFacts>

const TILE_MATRIX_SET_URI =
    'http://www.opengis.net/def/tilematrixset/OGC/1.0/WebMercatorQuad'
const CACHE_SCHEMA_VERSION = 1
let executorSequence = 0

export async function createVelocityWorkerRequestExecutor(
    descriptor: FlowVelocityWorkerTileSourceDescriptor
): Promise<FlowVelocityWorkerRequestExecutor> {

    const workerCount = descriptor.workerCount ?? 1
    const maxNetworkRequests = descriptor.maxNetworkRequests ?? workerCount
    const maxDecodeTasks = descriptor.maxDecodeTasks ?? workerCount
    if (!positiveInteger(workerCount) || workerCount > descriptor.workerSystem.maxWorkers ||
        !positiveInteger(descriptor.maxRequests) ||
        !positiveInteger(maxNetworkRequests) || !positiveInteger(maxDecodeTasks) ||
        typeof descriptor.sourceId !== 'string' || descriptor.sourceId.length === 0 ||
        !validSampleKey(descriptor.sampleKey) ||
        typeof descriptor.contentVersion !== 'string' || descriptor.contentVersion.length === 0 ||
        typeof descriptor.resolvePage !== 'function' ||
        !validCachePolicy(descriptor.cachePolicy)) {
        throw new TypeError(
            'Flow Field Worker executor requires source identity, page resolution, and finite budgets'
        )
    }
    const module = descriptor.workerModules.resolve(FLOW_FIELD_VELOCITY_TILE_WORKER)
    const sequence = ++executorSequence
    return await createVirtualRasterWorkerExecutor({
        id: `flow-field-velocity-workers-${descriptor.sampleKey}-${sequence}`,
        system: {
            ownership: 'borrowed',
            system: descriptor.workerSystem,
        },
        module,
        workerCount,
        maxRequests: descriptor.maxRequests,
        phaseLimits: {
            network: maxNetworkRequests,
            decode: maxDecodeTasks,
        },
        context: index => ({
            key: `flow-field-velocity-${descriptor.sampleKey}-cache-shard-${index}`,
            init: {
                cache: flowCacheConfigurationForShard(
                    descriptor.cachePolicy,
                    descriptor.sampleKey,
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
            `${candidate.cacheAddress.metadata.sourceId}:` +
            `${candidate.cacheAddress.metadata.plane}:${candidate.page.key}`,
        classifyFailure: error => {
            const code = workerRemoteErrorCode(error)
            return code === 'FLOW_FIELD_VELOCITY_TILE_MISSING'
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
    descriptor: FlowVelocityWorkerTileSourceDescriptor,
    executorId: number,
    requestSequence: number,
    demand: VirtualRasterPageDemand
): FlowVelocityTileCandidateDescriptor {

    const tile = demand.page.tile
    if (tile === undefined || tile.tileMatrixSetId !== 'WebMercatorQuad') {
        throw new TypeError('Flow Field Worker requests require WebMercatorQuad pages')
    }
    const expected = descriptor.resolvePage(demand.page)
    return Object.freeze({
        candidateId:
            `${executorId}:${requestSequence}:${demand.generation}:${demand.page.key}`,
        page: demand.page,
        cacheAddress: virtualRasterCacheAddress({
            sourceId: descriptor.sourceId,
            tileMatrixSetId: 'WebMercatorQuad',
            tileMatrixSetUri: TILE_MATRIX_SET_URI,
            matrixId: tile.matrixId,
            tileRow: tile.tileRow,
            tileColumn: tile.tileCol,
            plane: `velocity.${descriptor.sampleKey}`,
            coherence: {
                mode: 'immutable',
                contentVersion: descriptor.contentVersion,
            },
            sourceRepresentation: 'application/vnd.geoscratch.flow-rg32f',
            payloadRepresentation: 'raw/float32-rg-interleaved-le',
            decoderVersion: 'flow-rg32f-v1',
            sampleType: 'float32',
            schemaVersion: CACHE_SCHEMA_VERSION,
        }),
        url: expected.url,
        contentVersion: descriptor.contentVersion,
        expectedByteLength: expected.byteLength,
        expectedSha256: expected.sha256,
    })
}

function flowCacheConfigurationForShard(
    policy: FlowFieldCachePolicy,
    sampleKey: string,
    shard: number,
    count: number
): FlowVelocityTileWorkerInit['cache'] {

    if (!positiveInteger(count) || !Number.isSafeInteger(shard) ||
        shard < 0 || shard >= count) {
        throw new TypeError('Flow Field cache sharding requires a valid shard index and count')
    }
    if (policy.mode === 'none') return Object.freeze({ mode: 'none' })
    const activeShardCount = Math.min(count, policy.maxEntries)
    if (shard >= activeShardCount) return Object.freeze({ mode: 'none' })
    return Object.freeze({
        mode: 'persistent',
        descriptor: persistentCacheDescriptor({
            namespace: `${policy.namespace}.${sampleKey}.shard-${shard}`,
            maxPayloadBytes: partitionBudget(
                policy.maxPayloadBytes,
                activeShardCount,
                shard
            ),
            maxEntries: partitionBudget(policy.maxEntries, activeShardCount, shard),
            maxHistory: 64,
            requestPersistence: policy.requestPersistence && shard === 0,
            lifecycle: policy.lifecycle,
        }),
    })
}

function partitionBudget(value: number, count: number, index: number): number {

    const base = Math.floor(value / count)
    return base + (index < value % count ? 1 : 0)
}

function positiveInteger(value: unknown): value is number {

    return Number.isSafeInteger(value) && Number(value) > 0
}

function validSampleKey(value: unknown): value is string {

    return typeof value === 'string' && /^t(?:[0-9]{2}|[1-9][0-9]{2,})$/.test(value)
}

function validCachePolicy(policy: FlowFieldCachePolicy): boolean {

    return policy?.mode === 'none' || (
        policy?.mode === 'persistent' && typeof policy.namespace === 'string' &&
        policy.namespace.length > 0 && positiveInteger(policy.maxPayloadBytes) &&
        positiveInteger(policy.maxEntries) && typeof policy.requestPersistence === 'boolean' &&
        policy.lifecycle !== null && typeof policy.lifecycle === 'object'
    )
}
