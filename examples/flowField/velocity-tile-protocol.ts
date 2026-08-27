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

type FlowVelocityTileCacheConfiguration =
    | Readonly<{ mode: 'none' }>
    | Readonly<{
        mode: 'persistent'
        descriptor: PersistentCacheDescriptor
    }>

export type FlowVelocityTileWorkerInit = Readonly<{
    cache: FlowVelocityTileCacheConfiguration
}>

export type FlowVelocityTileCandidateDescriptor = Readonly<{
    candidateId: string
    page: VirtualRasterPageIdentity
    cacheAddress: VirtualRasterCacheAddress
    url: string
    contentVersion: string
    expectedByteLength: 524288
    expectedSha256: string
}>

export type FlowVelocityTileLookupResult = VirtualRasterWorkerLookupResult

export type FlowVelocityTileFetchResult = Readonly<{
    candidateId: string
    status: number
    encodedByteLength: number
}>

export type FlowVelocityTileDecodeResult = VirtualRasterPageTransfer

export type FlowVelocityRawTileCacheMetadata = VirtualRasterCacheMetadata & Readonly<{
    width: 256
    height: 256
    channels: 2
    dataType: 'float32'
    layout: 'rg-interleaved-le'
    contentVersion: string
    sha256: string
}>

export type FlowVelocityTileCacheFacts =
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

export type FlowVelocityTileWorkerFacts = Readonly<{
    cache: FlowVelocityTileCacheFacts
    pendingCandidateCount: number
    networkRequestCount: number
    decodedPageCount: number
    acceptedCandidateCount: number
    discardedCandidateCount: number
    senderDecodedByteLength: number
    maxPendingCandidateCount: number
}>

type FlowVelocityTileWorkerProtocol = VirtualRasterWorkerModuleProtocol<
    FlowVelocityTileCandidateDescriptor,
    FlowVelocityTileWorkerInit,
    FlowVelocityTileWorkerFacts,
    FlowVelocityTileFetchResult
>

export const FLOW_FIELD_VELOCITY_TILE_WORKER =
    defineWorkerModuleContract<FlowVelocityTileWorkerProtocol>({
        id: 'geoscratch-flow-field-velocity-tile',
        version: '1',
    })
