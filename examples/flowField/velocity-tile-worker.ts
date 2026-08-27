import {
    prepareVirtualRasterPageTransfer,
    virtualRasterCacheMetadataMatches,
} from 'geoscratch/geo'
import {
    PersistentCache,
    transferWorkerResult,
} from 'geoscratch/scratch'
import type { WorkerOperationContext } from 'geoscratch/scratch'
import type {
    FlowVelocityRawTileCacheMetadata,
    FlowVelocityTileCandidateDescriptor,
    FlowVelocityTileDecodeResult,
    FlowVelocityTileFetchResult,
    FlowVelocityTileLookupResult,
    FlowVelocityTileWorkerFacts,
    FlowVelocityTileWorkerInit,
} from './velocity-tile-protocol.ts'
import { FLOW_FIELD_VELOCITY_TILE_WORKER } from './velocity-tile-protocol.ts'

type FlowVelocityTileCandidate = FlowVelocityTileCandidateDescriptor & Readonly<{
    source: 'cache' | 'network' | 'decoded'
    encoded?: ArrayBuffer
    raw?: Float32Array<ArrayBuffer>
    cachePayload?: ArrayBuffer
}>

type FlowVelocityTileWorkerState = {
    cache?: PersistentCache<FlowVelocityRawTileCacheMetadata>
    candidates: Map<string, FlowVelocityTileCandidate>
    lastDecoded?: Float32Array<ArrayBuffer>
    networkRequestCount: number
    decodedPageCount: number
    acceptedCandidateCount: number
    discardedCandidateCount: number
    maxPendingCandidateCount: number
}

const TILE_SIZE = 256
const CHANNELS = 2
const PAGE_BYTE_LENGTH = TILE_SIZE * TILE_SIZE * CHANNELS * Float32Array.BYTES_PER_ELEMENT
const CONTENT_TYPE = 'application/vnd.geoscratch.flow-rg32f'

export default FLOW_FIELD_VELOCITY_TILE_WORKER.implement({
    operations: {},
    context: {
        async create(init: FlowVelocityTileWorkerInit) {

            return {
                ...(init.cache.mode === 'persistent' ? {
                    cache: await PersistentCache.open<FlowVelocityRawTileCacheMetadata>(
                        init.cache.descriptor
                    ),
                } : {}),
                candidates: new Map(),
                networkRequestCount: 0,
                decodedPageCount: 0,
                acceptedCandidateCount: 0,
                discardedCandidateCount: 0,
                maxPendingCandidateCount: 0,
            } satisfies FlowVelocityTileWorkerState
        },
        operations: {
            async lookup(
                state: FlowVelocityTileWorkerState,
                descriptor: FlowVelocityTileCandidateDescriptor,
                context: WorkerOperationContext
            ): Promise<FlowVelocityTileLookupResult> {

                throwIfAborted(context.signal)
                if (state.cache === undefined) return Object.freeze({ status: 'miss' })
                const outcome = await state.cache.get(descriptor.cacheAddress.key)
                throwIfAborted(context.signal)
                if (outcome.status === 'miss') return Object.freeze({ status: 'miss' })
                if (!await validCachedVelocity(outcome.record, descriptor, context.signal)) {
                    await state.cache.delete(descriptor.cacheAddress.key)
                    return Object.freeze({ status: 'miss' })
                }
                retainCachedCandidate(state, descriptor, outcome.record.payload!)
                return Object.freeze({ status: 'hit', candidateId: descriptor.candidateId })
            },
            async fetch(
                state: FlowVelocityTileWorkerState,
                descriptor: FlowVelocityTileCandidateDescriptor,
                context: WorkerOperationContext
            ): Promise<FlowVelocityTileFetchResult> {

                throwIfAborted(context.signal)
                state.networkRequestCount++
                const response = await fetch(descriptor.url, {
                    signal: context.signal,
                    cache: 'no-store',
                })
                if (!response.ok) throw tileHttpError(descriptor.page.key, response.status)
                const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim()
                if (contentType !== CONTENT_TYPE) {
                    throw velocityError(
                        'FLOW_FIELD_VELOCITY_TILE_CONTENT_TYPE_INVALID',
                        `Flow Field velocity tile ${descriptor.page.key} has content type ${contentType}`
                    )
                }
                const encoded = await response.arrayBuffer()
                throwIfAborted(context.signal)
                if (encoded.byteLength !== PAGE_BYTE_LENGTH ||
                    encoded.byteLength !== descriptor.expectedByteLength) {
                    throw velocityError(
                        'FLOW_FIELD_VELOCITY_TILE_BYTE_LENGTH_INVALID',
                        `Flow Field velocity tile ${descriptor.page.key} must contain ${PAGE_BYTE_LENGTH} bytes`
                    )
                }
                if (await sha256(encoded, context.signal) !== descriptor.expectedSha256) {
                    throw velocityError(
                        'FLOW_FIELD_VELOCITY_TILE_CHECKSUM_INVALID',
                        `Flow Field velocity tile ${descriptor.page.key} failed SHA-256 validation`
                    )
                }
                state.candidates.set(descriptor.candidateId, Object.freeze({
                    ...descriptor,
                    source: 'network',
                    encoded,
                }))
                updatePendingMaximum(state)
                return Object.freeze({
                    candidateId: descriptor.candidateId,
                    status: response.status,
                    encodedByteLength: encoded.byteLength,
                })
            },
            decode(
                state: FlowVelocityTileWorkerState,
                input: Readonly<{ candidateId: string }>,
                context: WorkerOperationContext
            ) {

                throwIfAborted(context.signal)
                const candidate = requireCandidate(state, input.candidateId)
                if (candidate.source !== 'network' || candidate.encoded === undefined) {
                    throw candidateStateError(candidate.candidateId, 'network')
                }
                const data = new Float32Array(candidate.encoded)
                validateFiniteVelocity(data, candidate.page.key, context.signal)
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
                    channels: CHANNELS,
                    data,
                    contentVersion: candidate.contentVersion,
                })
                return transferWorkerResult<FlowVelocityTileDecodeResult>(
                    prepared.value,
                    prepared.transferables
                )
            },
            transfer(
                state: FlowVelocityTileWorkerState,
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
                    channels: CHANNELS,
                    data: candidate.raw,
                    contentVersion: candidate.contentVersion,
                })
                return transferWorkerResult<FlowVelocityTileDecodeResult>(
                    prepared.value,
                    prepared.transferables
                )
            },
            async accept(
                state: FlowVelocityTileWorkerState,
                input: Readonly<{ candidateId: string }>
            ): Promise<FlowVelocityTileWorkerFacts> {

                const candidate = requireCandidate(state, input.candidateId)
                if (candidate.source === 'decoded' && state.cache !== undefined &&
                    candidate.cachePayload !== undefined) {
                    await state.cache.put(candidate.cacheAddress.key, {
                        metadata: Object.freeze({
                            ...candidate.cacheAddress.metadata,
                            width: TILE_SIZE,
                            height: TILE_SIZE,
                            channels: CHANNELS,
                            dataType: 'float32',
                            layout: 'rg-interleaved-le',
                            contentVersion: candidate.contentVersion,
                            sha256: candidate.expectedSha256,
                        }),
                        payload: candidate.cachePayload,
                    })
                }
                state.candidates.delete(candidate.candidateId)
                state.acceptedCandidateCount++
                return facts(state)
            },
            discard(
                state: FlowVelocityTileWorkerState,
                input: Readonly<{ candidateId: string }>
            ): FlowVelocityTileWorkerFacts {

                if (state.candidates.delete(input.candidateId)) {
                    state.discardedCandidateCount++
                }
                return facts(state)
            },
            facts(state: FlowVelocityTileWorkerState): FlowVelocityTileWorkerFacts {

                return facts(state)
            },
        },
        snapshot(state: FlowVelocityTileWorkerState) {

            return facts(state)
        },
        async dispose(state: FlowVelocityTileWorkerState) {

            state.candidates.clear()
            await state.cache?.dispose()
        },
    },
})

function retainCachedCandidate(
    state: FlowVelocityTileWorkerState,
    descriptor: FlowVelocityTileCandidateDescriptor,
    payload: ArrayBuffer
): void {

    state.candidates.set(descriptor.candidateId, Object.freeze({
        ...descriptor,
        source: 'cache',
        raw: new Float32Array(payload),
    }))
    updatePendingMaximum(state)
}

function requireCandidate(
    state: FlowVelocityTileWorkerState,
    candidateId: string
): FlowVelocityTileCandidate {

    const candidate = state.candidates.get(candidateId)
    if (candidate === undefined) {
        throw velocityError(
            'FLOW_FIELD_VELOCITY_TILE_CANDIDATE_MISSING',
            `Flow Field velocity candidate ${candidateId} is unavailable`
        )
    }
    return candidate
}

async function validCachedVelocity(
    record: Readonly<{
        metadata: FlowVelocityRawTileCacheMetadata
        payload?: ArrayBuffer
        byteLength: number
    }>,
    descriptor: FlowVelocityTileCandidateDescriptor,
    signal: AbortSignal
): Promise<boolean> {

    const metadata = record.metadata
    if (!(record.payload instanceof ArrayBuffer) ||
        record.byteLength !== PAGE_BYTE_LENGTH ||
        !virtualRasterCacheMetadataMatches(descriptor.cacheAddress, metadata) ||
        metadata.width !== TILE_SIZE || metadata.height !== TILE_SIZE ||
        metadata.channels !== CHANNELS || metadata.dataType !== 'float32' ||
        metadata.layout !== 'rg-interleaved-le' ||
        metadata.contentVersion !== descriptor.contentVersion ||
        metadata.sha256 !== descriptor.expectedSha256 ||
        await sha256(record.payload, signal) !== descriptor.expectedSha256) {
        return false
    }
    try {
        validateFiniteVelocity(new Float32Array(record.payload), descriptor.page.key, signal)
        return true
    } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw error
        return false
    }
}

function validateFiniteVelocity(
    data: Float32Array,
    pageKey: string,
    signal: AbortSignal
): void {

    if (data.length !== TILE_SIZE * TILE_SIZE * CHANNELS) {
        throw velocityError(
            'FLOW_FIELD_VELOCITY_TILE_BYTE_LENGTH_INVALID',
            `Flow Field velocity tile ${pageKey} has an invalid float32 element count`
        )
    }
    for (let index = 0; index < data.length; index++) {
        if ((index & 4095) === 0) throwIfAborted(signal)
        if (!Number.isFinite(data[index])) {
            throw velocityError(
                'FLOW_FIELD_VELOCITY_TILE_NON_FINITE_INVALID',
                `Flow Field velocity tile ${pageKey} contains a non-finite component`
            )
        }
    }
}

async function sha256(buffer: ArrayBuffer, signal: AbortSignal): Promise<string> {

    throwIfAborted(signal)
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))
    throwIfAborted(signal)
    return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')
}

function facts(state: FlowVelocityTileWorkerState): FlowVelocityTileWorkerFacts {

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

function candidateStateError(candidateId: string, expected: 'cache' | 'network'): Error {

    return velocityError(
        'FLOW_FIELD_VELOCITY_TILE_CANDIDATE_STATE_INVALID',
        `Flow Field velocity candidate ${candidateId} is not a ${expected} candidate`
    )
}

function updatePendingMaximum(state: FlowVelocityTileWorkerState): void {

    state.maxPendingCandidateCount = Math.max(
        state.maxPendingCandidateCount,
        state.candidates.size
    )
}

function throwIfAborted(signal: AbortSignal): void {

    if (!signal.aborted) return
    const error = new Error(
        signal.reason === undefined ? 'Flow Field velocity task cancelled' : String(signal.reason)
    )
    error.name = 'AbortError'
    throw error
}

function tileHttpError(pageKey: string, status: number): Error {

    const code = status === 404
        ? 'FLOW_FIELD_VELOCITY_TILE_MISSING'
        : 'FLOW_FIELD_VELOCITY_TILE_SERVICE_ERROR'
    const error = velocityError(
        code,
        `Flow Field velocity tile ${pageKey} request failed with HTTP ${status}`
    ) as Error & { status: number }
    error.status = status
    return error
}

function velocityError(code: string, message: string): Error {

    const error = new Error(message) as Error & { code: string }
    error.code = code
    return error
}
