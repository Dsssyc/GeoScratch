import {
    createVirtualRasterCache,
    prepareVirtualRasterPageTransfer,
} from 'geoscratch/geo'
import type {
    VirtualRasterCache,
    VirtualRasterCacheRecord,
} from 'geoscratch/geo'
import {
    defineWorkerModule,
    transferWorkerResult,
} from 'geoscratch/worker'
import type { WorkerOperationContext } from 'geoscratch/worker'
import type {
    DemTileCandidateDescriptor,
    DemTileDecodeResult,
    DemTileFetchResult,
    DemTileLookupResult,
    DemTileWorkerFacts,
    DemTileWorkerInit,
} from './dem-tile-protocol.ts'

type DemTileCandidate = DemTileCandidateDescriptor & Readonly<{
    source: 'cache' | 'network'
    encoded: ArrayBuffer
    contentType: string
    validator?: string
    lastModified?: string
}>

type DemTileWorkerState = {
    cache: VirtualRasterCache
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
    version: '1',
    operations: {},
    context: {
        async create(init: DemTileWorkerInit) {

            return {
                cache: await createVirtualRasterCache({
                    policy: init.cachePolicy,
                    requestPersistence: init.requestPersistence,
                }),
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
                const record = await state.cache.get(descriptor.cacheKey)
                throwIfAborted(context.signal)
                if (record === undefined) return Object.freeze({ status: 'miss' })
                retainCandidate(state, descriptor, record, 'cache')
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
                    ...(response.headers.get('etag') === null ? {} : {
                        validator: response.headers.get('etag')!,
                    }),
                    ...(response.headers.get('last-modified') === null ? {} : {
                        lastModified: response.headers.get('last-modified')!,
                    }),
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
                const data = await decodeTile(candidate.encoded, candidate.contentType, context.signal)
                state.decodedPageCount++
                state.lastDecoded = data
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
            async accept(
                state: DemTileWorkerState,
                input: Readonly<{ candidateId: string }>
            ): Promise<DemTileWorkerFacts> {

                const candidate = requireCandidate(state, input.candidateId)
                if (candidate.source === 'network') {
                    await state.cache.put(candidate.cacheKey, {
                        data: candidate.encoded,
                        contentType: candidate.contentType,
                        ...(candidate.validator === undefined ? {} : {
                            validator: candidate.validator,
                        }),
                        ...(candidate.lastModified === undefined ? {} : {
                            lastModified: candidate.lastModified,
                        }),
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

                await state.cache.clear()
                return facts(state)
            },
        },
        snapshot(state: DemTileWorkerState) {

            return facts(state)
        },
        async dispose(state: DemTileWorkerState) {

            state.candidates.clear()
            await state.cache.dispose()
        },
    },
})

function retainCandidate(
    state: DemTileWorkerState,
    descriptor: DemTileCandidateDescriptor,
    record: VirtualRasterCacheRecord,
    source: 'cache'
): void {

    state.candidates.set(descriptor.candidateId, Object.freeze({
        ...descriptor,
        source,
        encoded: record.data,
        contentType: record.contentType,
        ...(record.validator === undefined ? {} : { validator: record.validator }),
        ...(record.lastModified === undefined ? {} : { lastModified: record.lastModified }),
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
        cache: state.cache.inspect(),
        pendingCandidateCount: state.candidates.size,
        networkRequestCount: state.networkRequestCount,
        decodedPageCount: state.decodedPageCount,
        acceptedCandidateCount: state.acceptedCandidateCount,
        discardedCandidateCount: state.discardedCandidateCount,
        senderDecodedByteLength: state.lastDecoded?.byteLength ?? 0,
        maxPendingCandidateCount: state.maxPendingCandidateCount,
    })
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
