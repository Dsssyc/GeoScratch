import { persistentCacheKey } from '../scratch/cache/persistent-cache.js'
import type { PersistentCacheKey } from '../scratch/cache/types.js'
import { throwGeoDiagnostic } from './diagnostics.js'

export type VirtualRasterCacheCoherence =
    | Readonly<{ mode: 'immutable', contentVersion: string }>
    | Readonly<{ mode: 'revisioned', revision: string, validator?: string }>
    | Readonly<{ mode: 'editable', baseRevision: string }>

export type VirtualRasterCacheAddressDescriptor = Readonly<{
    sourceId: string
    tileMatrixSetId: string
    tileMatrixSetUri: string
    matrixId: string
    tileRow: number
    tileColumn: number
    plane: string
    coherence: VirtualRasterCacheCoherence
    sourceRepresentation: string
    payloadRepresentation: string
    decoderVersion: string
    sampleType: string
    schemaVersion: number
}>

export type VirtualRasterCacheMetadata = Readonly<{
    domain: 'geo.virtual-raster'
    sourceId: string
    tileMatrixSetId: string
    tileMatrixSetUri: string
    matrixId: string
    tileRow: number
    tileColumn: number
    plane: string
    coherence: VirtualRasterCacheCoherence
    sourceRepresentation: string
    payloadRepresentation: string
    decoderVersion: string
    sampleType: string
    schemaVersion: number
}>

export type VirtualRasterCacheInvalidationPrefixes = Readonly<{
    source: string
    plane: string
    tileMatrixSet: string
    matrix: string
}>

export type VirtualRasterCacheAddress = Readonly<{
    kind: 'virtual-raster-cache-address'
    key: PersistentCacheKey
    metadata: VirtualRasterCacheMetadata
    invalidationPrefixes: VirtualRasterCacheInvalidationPrefixes
}>

/** Maps one versioned raster page and coherence contract into generic persistent-cache addresses. */
export function virtualRasterCacheAddress(
    descriptor: VirtualRasterCacheAddressDescriptor
): VirtualRasterCacheAddress {

    validateDescriptor(descriptor)
    const coherence = Object.freeze({ ...descriptor.coherence }) as VirtualRasterCacheCoherence
    const source = `geo.virtual-raster/v${descriptor.schemaVersion}/` +
        `source/${component(descriptor.sourceId)}/`
    const plane = `${source}plane/${component(descriptor.plane)}/`
    const tileMatrixSet = `${plane}tile-matrix-set/${component(descriptor.tileMatrixSetId)}/` +
        `${component(descriptor.tileMatrixSetUri)}/`
    const matrix = `${tileMatrixSet}matrix/${component(descriptor.matrixId)}/`
    const id = `${matrix}tile/${descriptor.tileRow}/${descriptor.tileColumn}/` +
        `source-representation/${component(descriptor.sourceRepresentation)}/` +
        `payload-representation/${component(descriptor.payloadRepresentation)}/` +
        `decoder/${component(descriptor.decoderVersion)}/` +
        `sample/${component(descriptor.sampleType)}`
    const revision = coherenceRevision(coherence)
    let key: PersistentCacheKey
    try {
        key = persistentCacheKey({ id, revision })
    } catch {
        return throwGeoDiagnostic({
            code: 'GEO_VIRTUAL_RASTER_CACHE_ADDRESS_INVALID',
            phase: 'cache',
            subject: { kind: 'virtual-raster-cache-address' },
            message: 'Virtual raster cache identity exceeds the bounded Scratch cache key contract.',
            expected: { boundedCacheIdentity: true },
            actual: { idLength: id.length, revisionLength: revision.length },
        })
    }
    const metadata: VirtualRasterCacheMetadata = Object.freeze({
        domain: 'geo.virtual-raster',
        sourceId: descriptor.sourceId,
        tileMatrixSetId: descriptor.tileMatrixSetId,
        tileMatrixSetUri: descriptor.tileMatrixSetUri,
        matrixId: descriptor.matrixId,
        tileRow: descriptor.tileRow,
        tileColumn: descriptor.tileColumn,
        plane: descriptor.plane,
        coherence,
        sourceRepresentation: descriptor.sourceRepresentation,
        payloadRepresentation: descriptor.payloadRepresentation,
        decoderVersion: descriptor.decoderVersion,
        sampleType: descriptor.sampleType,
        schemaVersion: descriptor.schemaVersion,
    })
    return Object.freeze({
        kind: 'virtual-raster-cache-address',
        key,
        metadata,
        invalidationPrefixes: Object.freeze({ source, plane, tileMatrixSet, matrix }),
    })
}

function coherenceRevision(coherence: VirtualRasterCacheCoherence): string {

    switch (coherence.mode) {
        case 'immutable': return `immutable:${coherence.contentVersion}`
        case 'revisioned': return `revisioned:${JSON.stringify([
            coherence.revision,
            coherence.validator ?? null,
        ])}`
        case 'editable': return `editable-base:${coherence.baseRevision}`
    }
}

function validateDescriptor(descriptor: VirtualRasterCacheAddressDescriptor): void {

    const textFields = [
        descriptor.sourceId,
        descriptor.tileMatrixSetId,
        descriptor.tileMatrixSetUri,
        descriptor.matrixId,
        descriptor.plane,
        descriptor.sourceRepresentation,
        descriptor.payloadRepresentation,
        descriptor.decoderVersion,
        descriptor.sampleType,
    ]
    if (textFields.some(value => !boundedText(value)) ||
        !nonNegativeSafeInteger(descriptor.tileRow) ||
        !nonNegativeSafeInteger(descriptor.tileColumn) ||
        !positiveSafeInteger(descriptor.schemaVersion) ||
        !validCoherence(descriptor.coherence)) {
        return throwGeoDiagnostic({
            code: 'GEO_VIRTUAL_RASTER_CACHE_ADDRESS_INVALID',
            phase: 'cache',
            subject: { kind: 'virtual-raster-cache-address' },
            message: 'A virtual raster cache address requires complete bounded tile, representation, and coherence facts.',
            actual: descriptor,
        })
    }
}

function validCoherence(coherence: VirtualRasterCacheCoherence): boolean {

    if (coherence === null || typeof coherence !== 'object') return false
    switch (coherence.mode) {
        case 'immutable': return boundedText(coherence.contentVersion)
        case 'revisioned': return boundedText(coherence.revision) &&
            (coherence.validator === undefined || boundedText(coherence.validator))
        case 'editable': return boundedText(coherence.baseRevision)
        default: return false
    }
}

function component(value: string): string {

    return encodeURIComponent(value)
}

function boundedText(value: unknown): value is string {

    return typeof value === 'string' && value.length > 0 && value.length <= 256 &&
        wellFormedText(value)
}

function wellFormedText(value: string): boolean {

    for (let index = 0; index < value.length; index++) {
        const unit = value.charCodeAt(index)
        if (unit >= 0xd800 && unit <= 0xdbff) {
            if (index + 1 >= value.length) return false
            const next = value.charCodeAt(index + 1)
            if (next < 0xdc00 || next > 0xdfff) return false
            index++
        } else if (unit >= 0xdc00 && unit <= 0xdfff) {
            return false
        }
    }
    return true
}

function nonNegativeSafeInteger(value: unknown): value is number {

    return Number.isSafeInteger(value) && Number(value) >= 0
}

function positiveSafeInteger(value: unknown): value is number {

    return Number.isSafeInteger(value) && Number(value) > 0
}
