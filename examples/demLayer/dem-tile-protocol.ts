import type {
    VirtualRasterCacheFacts,
    VirtualRasterCacheKey,
    VirtualRasterCachePolicy,
    VirtualRasterPageIdentity,
    VirtualRasterPageTransfer,
} from 'geoscratch/geo'

export type DemTileWorkerInit = Readonly<{
    cachePolicy: VirtualRasterCachePolicy
    requestPersistence: boolean
}>

export type DemTileCandidateDescriptor = Readonly<{
    candidateId: string
    page: VirtualRasterPageIdentity
    cacheKey: VirtualRasterCacheKey
    url: string
    contentVersion: string
}>

export type DemTileLookupResult = Readonly<{
    status: 'hit' | 'miss'
    candidateId?: string
}>

export type DemTileFetchResult = Readonly<{
    candidateId: string
    status: number
    encodedByteLength: number
}>

export type DemTileWorkerFacts = Readonly<{
    cache: VirtualRasterCacheFacts
    pendingCandidateCount: number
    networkRequestCount: number
    decodedPageCount: number
    acceptedCandidateCount: number
    discardedCandidateCount: number
    senderDecodedByteLength: number
    maxPendingCandidateCount: number
}>

export type DemTileDecodeResult = VirtualRasterPageTransfer
