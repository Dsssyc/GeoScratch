import {
    prepareVirtualRasterPageTransfer,
} from 'geoscratch/geo'
import {
    defineWorkerModule,
    PersistentCache,
    transferWorkerResult,
} from 'geoscratch/scratch'
import type { WorkerOperationContext } from 'geoscratch/scratch'
import type {
    DemTileCandidateDescriptor,
    DemTileDecodeResult,
    DemTileFetchResult,
    DemTileLookupResult,
    DemTileWorkerFacts,
    DemTileWorkerInit,
    DemRawTileCacheMetadata,
} from './dem-tile-protocol.ts'

type DemTileCandidate = DemTileCandidateDescriptor & Readonly<{
    source: 'cache' | 'network' | 'decoded'
    encoded?: ArrayBuffer
    raw?: Uint8Array<ArrayBuffer>
    cachePayload?: ArrayBuffer
    contentType?: string
}>

type DemTileWorkerState = {
    cache?: PersistentCache<DemRawTileCacheMetadata>
    candidates: Map<string, DemTileCandidate>
    lastDecoded?: Uint8Array<ArrayBuffer>
    networkRequestCount: number
    decodedPageCount: number
    acceptedCandidateCount: number
    discardedCandidateCount: number
    maxPendingCandidateCount: number
}

const TILE_SIZE = 256

export default defineWorkerModule({
    id: 'geoscratch-dem-tile',
    version: '2',
    operations: {},
    context: {
        async create(init: DemTileWorkerInit) {

            return {
                ...(init.cache.mode === 'persistent' ? {
                    cache: await PersistentCache.open<DemRawTileCacheMetadata>(
                        init.cache.descriptor
                    ),
                } : {}),
                candidates: new Map(),
                networkRequestCount: 0,
                decodedPageCount: 0,
                acceptedCandidateCount: 0,
                discardedCandidateCount: 0,
                maxPendingCandidateCount: 0,
            } satisfies DemTileWorkerState
        },
        operations: {
            async lookup(
                state: DemTileWorkerState,
                descriptor: DemTileCandidateDescriptor,
                context: WorkerOperationContext
            ): Promise<DemTileLookupResult> {

                throwIfAborted(context.signal)
                if (state.cache === undefined) return Object.freeze({ status: 'miss' })
                const outcome = await state.cache.get(descriptor.cacheAddress.key)
                throwIfAborted(context.signal)
                if (outcome.status === 'miss') return Object.freeze({ status: 'miss' })
                if (!validCachedTile(outcome.record, descriptor)) {
                    await state.cache.delete(descriptor.cacheAddress.key)
                    return Object.freeze({ status: 'miss' })
                }
                retainCachedCandidate(state, descriptor, outcome.record.payload!)
                return Object.freeze({ status: 'hit', candidateId: descriptor.candidateId })
            },
            async fetch(
                state: DemTileWorkerState,
                descriptor: DemTileCandidateDescriptor,
                context: WorkerOperationContext
            ): Promise<DemTileFetchResult> {

                throwIfAborted(context.signal)
                state.networkRequestCount++
                const response = await fetch(descriptor.url, {
                    signal: context.signal,
                    cache: 'no-store',
                })
                if (!response.ok) throw tileHttpError(descriptor.page.key, response.status)
                const encoded = await response.arrayBuffer()
                throwIfAborted(context.signal)
                const contentType = response.headers.get('content-type') ?? 'image/png'
                state.candidates.set(descriptor.candidateId, Object.freeze({
                    ...descriptor,
                    source: 'network',
                    encoded,
                    contentType,
                }))
                updatePendingMaximum(state)
                return Object.freeze({
                    candidateId: descriptor.candidateId,
                    status: response.status,
                    encodedByteLength: encoded.byteLength,
                })
            },
            async decode(
                state: DemTileWorkerState,
                input: Readonly<{ candidateId: string }>,
                context: WorkerOperationContext
            ) {

                throwIfAborted(context.signal)
                const candidate = requireCandidate(state, input.candidateId)
                if (candidate.source !== 'network' || candidate.encoded === undefined ||
                    candidate.contentType === undefined) {
                    throw candidateStateError(candidate.candidateId, 'network')
                }
                const data = await decodeTile(candidate.encoded, candidate.contentType, context.signal)
                state.decodedPageCount++
                state.lastDecoded = data
                const { encoded: _encoded, raw: _raw, cachePayload: _cachePayload, ...retained } =
                    candidate
                state.candidates.set(candidate.candidateId, Object.freeze({
                    ...retained,
                    source: 'decoded',
                    ...(state.cache === undefined ? {} : { cachePayload: data.slice().buffer }),
                }))
                const prepared = prepareVirtualRasterPageTransfer({
                    page: candidate.page,
                    width: TILE_SIZE,
                    height: TILE_SIZE,
                    channels: 1,
                    data,
                    contentVersion: candidate.contentVersion,
                })
                return transferWorkerResult<DemTileDecodeResult>(
                    prepared.value,
                    prepared.transferables
                )
            },
            transfer(
                state: DemTileWorkerState,
                input: Readonly<{ candidateId: string }>,
                context: WorkerOperationContext
            ) {

                throwIfAborted(context.signal)
                const candidate = requireCandidate(state, input.candidateId)
                if (candidate.source !== 'cache' || candidate.raw === undefined) {
                    throw candidateStateError(candidate.candidateId, 'cache')
                }
                state.lastDecoded = candidate.raw
                const prepared = prepareVirtualRasterPageTransfer({
                    page: candidate.page,
                    width: TILE_SIZE,
                    height: TILE_SIZE,
                    channels: 1,
                    data: candidate.raw,
                    contentVersion: candidate.contentVersion,
                })
                return transferWorkerResult<DemTileDecodeResult>(
                    prepared.value,
                    prepared.transferables
                )
            },
            async accept(
                state: DemTileWorkerState,
                input: Readonly<{ candidateId: string }>
            ): Promise<DemTileWorkerFacts> {

                const candidate = requireCandidate(state, input.candidateId)
                if (candidate.source === 'decoded' && state.cache !== undefined &&
                    candidate.cachePayload !== undefined) {
                    await state.cache.put(candidate.cacheAddress.key, {
                        metadata: Object.freeze({
                            ...candidate.cacheAddress.metadata,
                            width: TILE_SIZE,
                            height: TILE_SIZE,
                            channels: 1,
                            dataType: 'uint8',
                            contentVersion: candidate.contentVersion,
                        }),
                        payload: candidate.cachePayload,
                    })
                }
                state.candidates.delete(candidate.candidateId)
                state.acceptedCandidateCount++
                return facts(state)
            },
            discard(
                state: DemTileWorkerState,
                input: Readonly<{ candidateId: string }>
            ): DemTileWorkerFacts {

                if (state.candidates.delete(input.candidateId)) {
                    state.discardedCandidateCount++
                }
                return facts(state)
            },
            facts(state: DemTileWorkerState): DemTileWorkerFacts {

                return facts(state)
            },
            async clear(state: DemTileWorkerState): Promise<DemTileWorkerFacts> {

                await state.cache?.clear()
                return facts(state)
            },
        },
        snapshot(state: DemTileWorkerState) {

            return facts(state)
        },
        async dispose(state: DemTileWorkerState) {

            state.candidates.clear()
            await state.cache?.dispose()
        },
    },
})

function retainCachedCandidate(
    state: DemTileWorkerState,
    descriptor: DemTileCandidateDescriptor,
    payload: ArrayBuffer
): void {

    state.candidates.set(descriptor.candidateId, Object.freeze({
        ...descriptor,
        source: 'cache',
        raw: new Uint8Array(payload),
    }))
    updatePendingMaximum(state)
}

function requireCandidate(state: DemTileWorkerState, candidateId: string): DemTileCandidate {

    const candidate = state.candidates.get(candidateId)
    if (candidate === undefined) {
        const error = new Error(`DEM tile candidate ${candidateId} is unavailable`) as Error & {
            code: string
        }
        error.code = 'DEM_TILE_CANDIDATE_MISSING'
        throw error
    }
    return candidate
}

async function decodeTile(
    encoded: ArrayBuffer,
    contentType: string,
    signal: AbortSignal
): Promise<Uint8Array<ArrayBuffer>> {

    throwIfAborted(signal)
    const bitmap = await createImageBitmap(new Blob([ encoded ], { type: contentType }), {
        colorSpaceConversion: 'none',
        premultiplyAlpha: 'none',
    })
    try {
        throwIfAborted(signal)
        if (bitmap.width !== TILE_SIZE || bitmap.height !== TILE_SIZE) {
            throw new Error(`DEM tile payload must be ${TILE_SIZE} by ${TILE_SIZE}`)
        }
        const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE)
        const context = canvas.getContext('2d', { willReadFrequently: true })
        if (context === null) throw new Error('DEM worker could not create a 2D decode context')
        context.drawImage(bitmap, 0, 0)
        const rgba = context.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data
        const result = new Uint8Array(TILE_SIZE * TILE_SIZE)
        for (let index = 0; index < result.length; index++) result[index] = rgba[index * 4]!
        throwIfAborted(signal)
        return result
    } finally {
        bitmap.close()
    }
}

function facts(state: DemTileWorkerState): DemTileWorkerFacts {

    return Object.freeze({
        cache: state.cache === undefined
            ? Object.freeze({
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
            : Object.freeze({ mode: 'persistent', ...state.cache.inspect() }),
        pendingCandidateCount: state.candidates.size,
        networkRequestCount: state.networkRequestCount,
        decodedPageCount: state.decodedPageCount,
        acceptedCandidateCount: state.acceptedCandidateCount,
        discardedCandidateCount: state.discardedCandidateCount,
        senderDecodedByteLength: state.lastDecoded?.byteLength ?? 0,
        maxPendingCandidateCount: state.maxPendingCandidateCount,
    })
}

function validCachedTile(
    record: Readonly<{
        metadata: DemRawTileCacheMetadata
        payload?: ArrayBuffer
        byteLength: number
    }>,
    descriptor: DemTileCandidateDescriptor
): boolean {

    const metadata = record.metadata
    return record.payload instanceof ArrayBuffer &&
        record.byteLength === TILE_SIZE * TILE_SIZE &&
        metadata.domain === 'geo.virtual-raster' &&
        metadata.width === TILE_SIZE && metadata.height === TILE_SIZE &&
        metadata.channels === 1 && metadata.dataType === 'uint8' &&
        metadata.contentVersion === descriptor.contentVersion &&
        metadata.payloadRepresentation === 'raw/uint8'
}

function candidateStateError(candidateId: string, expected: 'cache' | 'network'): Error {

    const error = new Error(
        `DEM tile candidate ${candidateId} is not a ${expected} candidate`
    ) as Error & { code: string }
    error.code = 'DEM_TILE_CANDIDATE_STATE_INVALID'
    return error
}

function updatePendingMaximum(state: DemTileWorkerState): void {

    state.maxPendingCandidateCount = Math.max(
        state.maxPendingCandidateCount,
        state.candidates.size
    )
}

function throwIfAborted(signal: AbortSignal): void {

    if (!signal.aborted) return
    const error = new Error(signal.reason === undefined ? 'DEM tile task cancelled' : String(signal.reason))
    error.name = 'AbortError'
    throw error
}

function tileHttpError(pageKey: string, status: number): Error {

    const error = new Error(`DEM tile ${pageKey} request failed with HTTP ${status}`) as Error & {
        code: string
        status: number
    }
    error.code = status === 404 ? 'DEM_TILE_MISSING' : 'DEM_TILE_SERVICE_ERROR'
    error.status = status
    return error
}
