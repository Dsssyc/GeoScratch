import type {
    VirtualRasterCacheAddress,
    VirtualRasterCacheMetadata,
    VirtualRasterPageIdentity,
    VirtualRasterPageTransfer,
    VirtualRasterWorkerLookupResult,
    VirtualRasterWorkerModuleProtocol,
} from 'geoscratch/geo'
import { defineWorkerModuleContract } from 'geoscratch/scratch'
import type {
    PersistentCacheDescriptor,
    PersistentCacheFacts,
} from 'geoscratch/scratch'

type DemTileCacheConfiguration =
    | Readonly<{ mode: 'none' }>
    | Readonly<{
        mode: 'persistent'
        descriptor: PersistentCacheDescriptor
    }>

export type DemTileWorkerInit = Readonly<{
    cache: DemTileCacheConfiguration
}>

export type DemTileCandidateDescriptor = Readonly<{
    candidateId: string
    page: VirtualRasterPageIdentity
    cacheAddress: VirtualRasterCacheAddress
    url: string
    contentVersion: string
}>

export type DemTileLookupResult = VirtualRasterWorkerLookupResult

export type DemTileFetchResult = Readonly<{
    candidateId: string
    status: number
    encodedByteLength: number
}>

export type DemTileWorkerFacts = Readonly<{
    cache: DemTileCacheFacts
    pendingCandidateCount: number
    networkRequestCount: number
    decodedPageCount: number
    acceptedCandidateCount: number
    discardedCandidateCount: number
    senderDecodedByteLength: number
    maxPendingCandidateCount: number
}>

export type DemTileDecodeResult = VirtualRasterPageTransfer

export type DemRawTileCacheMetadata = VirtualRasterCacheMetadata & Readonly<{
    width: 256
    height: 256
    channels: 1
    dataType: 'uint8'
    contentVersion: string
}>

export type DemTileCacheFacts =
    | Readonly<{
        mode: 'none'
        state: 'disabled'
        entryCount: 0
        payloadBytes: 0
        hitCount: 0
        missCount: 0
        putCount: 0
        evictionCount: 0
        quotaFailureCount: 0
    }>
    | (PersistentCacheFacts & Readonly<{ mode: 'persistent' }>)

type DemTileWorkerProtocol = VirtualRasterWorkerModuleProtocol<
    DemTileCandidateDescriptor,
    DemTileWorkerInit,
    DemTileWorkerFacts,
    DemTileFetchResult
>

export const DEM_TILE_WORKER = defineWorkerModuleContract<DemTileWorkerProtocol>({
    id: 'geoscratch-dem-tile',
    version: '2',
})
