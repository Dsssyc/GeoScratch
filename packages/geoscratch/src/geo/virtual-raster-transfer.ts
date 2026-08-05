import { throwGeoDiagnostic } from './diagnostics.js'
import type { VirtualRasterPageIdentity } from './virtual-raster.js'

export type VirtualRasterPageData =
    | Uint8Array<ArrayBuffer>
    | Float32Array<ArrayBuffer>

export type VirtualRasterPagePayloadDescriptor = Readonly<{
    page: VirtualRasterPageIdentity
    width: number
    height: number
    channels: number
    data: VirtualRasterPageData
    contentVersion: string
}>

export type OwnedVirtualRasterPagePayload = Readonly<{
    kind: 'owned-virtual-raster-page-payload'
    page: VirtualRasterPageIdentity
    width: number
    height: number
    channels: number
    data: VirtualRasterPageData
    contentVersion: string
}>

export type VirtualRasterPageTransfer = Readonly<{
    kind: 'virtual-raster-page-transfer'
    page: VirtualRasterPageIdentity
    width: number
    height: number
    channels: number
    dataType: 'uint8' | 'float32'
    buffer: ArrayBuffer
    contentVersion: string
}>

export type PreparedVirtualRasterPageTransfer = Readonly<{
    value: VirtualRasterPageTransfer
    transferables: readonly [ArrayBuffer]
}>

type PayloadOwnership = {
    owner: object | undefined
    released: boolean
}

const payloadOwnership = new WeakMap<OwnedVirtualRasterPagePayload, PayloadOwnership>()

export function ownedVirtualRasterPagePayload(
    descriptor: VirtualRasterPagePayloadDescriptor
): OwnedVirtualRasterPagePayload {

    validateDescriptor(descriptor)
    const payload: OwnedVirtualRasterPagePayload = Object.freeze({
        kind: 'owned-virtual-raster-page-payload',
        page: descriptor.page,
        width: descriptor.width,
        height: descriptor.height,
        channels: descriptor.channels,
        data: descriptor.data,
        contentVersion: descriptor.contentVersion,
    })
    payloadOwnership.set(payload, { owner: undefined, released: false })
    return payload
}

export function prepareVirtualRasterPageTransfer(
    descriptor: VirtualRasterPagePayloadDescriptor
): PreparedVirtualRasterPageTransfer {

    validateDescriptor(descriptor)
    const value: VirtualRasterPageTransfer = Object.freeze({
        kind: 'virtual-raster-page-transfer',
        page: descriptor.page,
        width: descriptor.width,
        height: descriptor.height,
        channels: descriptor.channels,
        dataType: descriptor.data instanceof Uint8Array ? 'uint8' : 'float32',
        buffer: descriptor.data.buffer,
        contentVersion: descriptor.contentVersion,
    })
    return Object.freeze({
        value,
        transferables: Object.freeze([ descriptor.data.buffer ]) as readonly [ArrayBuffer],
    })
}

export function adoptVirtualRasterPageTransfer(
    transfer: VirtualRasterPageTransfer
): OwnedVirtualRasterPagePayload {

    if (transfer.kind !== 'virtual-raster-page-transfer' ||
        (transfer.dataType !== 'uint8' && transfer.dataType !== 'float32') ||
        !(transfer.buffer instanceof ArrayBuffer) || transfer.buffer.byteLength === 0) {
        return throwOwnershipDiagnostic(
            'GEO_VIRTUAL_RASTER_TRANSFER_INVALID',
            transfer.page,
            'A transferred page must contain one non-detached ArrayBuffer and a supported data type.',
            transfer
        )
    }
    const data = transfer.dataType === 'uint8'
        ? new Uint8Array(transfer.buffer)
        : new Float32Array(transfer.buffer)
    return ownedVirtualRasterPagePayload({
        page: transfer.page,
        width: transfer.width,
        height: transfer.height,
        channels: transfer.channels,
        data,
        contentVersion: transfer.contentVersion,
    })
}

export function discardVirtualRasterPageTransfer(transfer: VirtualRasterPageTransfer): void {

    if (transfer.kind !== 'virtual-raster-page-transfer' ||
        !(transfer.buffer instanceof ArrayBuffer)) {
        return throwOwnershipDiagnostic(
            'GEO_VIRTUAL_RASTER_TRANSFER_INVALID',
            transfer.page,
            'Only an unadopted virtual raster transfer can be discarded.',
            transfer
        )
    }
    detachBuffer(transfer.buffer)
}

export function discardOwnedVirtualRasterPagePayload(
    payload: OwnedVirtualRasterPagePayload
): void {

    const state = ownershipState(payload)
    if (state.released || state.owner !== undefined) {
        return throwOwnershipDiagnostic(
            'GEO_VIRTUAL_RASTER_PAYLOAD_OWNERSHIP_INVALID',
            payload.page,
            'Only an unclaimed live payload can be discarded directly.',
            { released: state.released, claimed: state.owner !== undefined }
        )
    }
    const owner = {}
    state.owner = owner
    releaseOwnedVirtualRasterPagePayload(payload, owner)
}

/** @internal */
export function claimOwnedVirtualRasterPagePayload(
    payload: OwnedVirtualRasterPagePayload,
    owner: object
): void {

    const state = ownershipState(payload)
    if (state.released || state.owner !== undefined) {
        return throwOwnershipDiagnostic(
            'GEO_VIRTUAL_RASTER_PAYLOAD_OWNERSHIP_INVALID',
            payload.page,
            'An owned page payload can be claimed by exactly one live owner.',
            { released: state.released, claimed: state.owner !== undefined }
        )
    }
    state.owner = owner
}

/** @internal */
export function moveOwnedVirtualRasterPagePayload(
    payload: OwnedVirtualRasterPagePayload,
    currentOwner: object,
    nextOwner: object
): void {

    const state = ownershipState(payload)
    if (state.released || state.owner !== currentOwner) {
        return throwOwnershipDiagnostic(
            'GEO_VIRTUAL_RASTER_PAYLOAD_OWNERSHIP_INVALID',
            payload.page,
            'Only the current owner can move a page payload.',
            { released: state.released, currentOwner: state.owner === currentOwner }
        )
    }
    state.owner = nextOwner
}

/** @internal */
export function assertOwnedVirtualRasterPagePayloadOwner(
    payload: OwnedVirtualRasterPagePayload,
    owner: object
): void {

    const state = ownershipState(payload)
    if (state.released || state.owner !== owner) {
        return throwOwnershipDiagnostic(
            'GEO_VIRTUAL_RASTER_PAYLOAD_OWNERSHIP_INVALID',
            payload.page,
            'Page bytes are unavailable to a non-owner or after release.',
            { released: state.released, currentOwner: state.owner === owner }
        )
    }
}

/** @internal */
export function releaseOwnedVirtualRasterPagePayload(
    payload: OwnedVirtualRasterPagePayload,
    owner: object
): void {

    assertOwnedVirtualRasterPagePayloadOwner(payload, owner)
    const state = ownershipState(payload)
    state.released = true
    state.owner = undefined
    detachBuffer(payload.data.buffer)
}

function ownershipState(payload: OwnedVirtualRasterPagePayload): PayloadOwnership {

    const state = payloadOwnership.get(payload)
    if (state === undefined || payload.kind !== 'owned-virtual-raster-page-payload') {
        return throwOwnershipDiagnostic(
            'GEO_VIRTUAL_RASTER_PAYLOAD_OWNERSHIP_INVALID',
            payload.page,
            'Page payload ownership must originate from a Geo adoption factory.',
            { branded: false }
        )
    }
    return state
}

function validateDescriptor(descriptor: VirtualRasterPagePayloadDescriptor): void {

    const dataIsSupported = descriptor.data instanceof Uint8Array ||
        descriptor.data instanceof Float32Array
    if (descriptor.page.kind !== 'virtual-raster-page' ||
        !positiveInteger(descriptor.width) || !positiveInteger(descriptor.height) ||
        !positiveInteger(descriptor.channels) || descriptor.channels > 4 ||
        !dataIsSupported || !(descriptor.data.buffer instanceof ArrayBuffer) ||
        descriptor.data.byteOffset !== 0 ||
        descriptor.data.byteLength !== descriptor.data.buffer.byteLength ||
        descriptor.data.byteLength === 0 ||
        typeof descriptor.contentVersion !== 'string' || descriptor.contentVersion.length === 0) {
        return throwOwnershipDiagnostic(
            'GEO_VIRTUAL_RASTER_PAGE_PAYLOAD_INVALID',
            descriptor.page,
            'An owned payload requires one whole non-empty ArrayBuffer and finite page metadata.',
            {
                width: descriptor.width,
                height: descriptor.height,
                channels: descriptor.channels,
                dataType: dataIsSupported ? descriptor.data.constructor.name : typeof descriptor.data,
                byteOffset: dataIsSupported ? descriptor.data.byteOffset : undefined,
                byteLength: dataIsSupported ? descriptor.data.byteLength : undefined,
                bufferByteLength: dataIsSupported ? descriptor.data.buffer.byteLength : undefined,
                contentVersion: descriptor.contentVersion,
            }
        )
    }
}

function detachBuffer(buffer: ArrayBuffer): void {

    if (buffer.byteLength === 0) return
    structuredClone(buffer, { transfer: [ buffer ] })
}

function positiveInteger(value: unknown): value is number {

    return Number.isSafeInteger(value) && Number(value) > 0
}

function throwOwnershipDiagnostic(
    code: string,
    page: VirtualRasterPageIdentity,
    message: string,
    actual: unknown
): never {

    return throwGeoDiagnostic({
        code,
        phase: 'residency',
        subject: { kind: 'virtual-raster-page', id: page?.key },
        message,
        actual,
    })
}
