import { throwScratchDiagnostic } from './diagnostics.js'
import type { DiagnosticSubject } from './diagnostics.js'
import type { BufferMappingMode } from './buffer-mapping.js'
import type { BufferRegion, BufferResource } from './buffer.js'

export type BufferMappingLifecycleReason =
    | 'resource-disposed'
    | 'runtime-disposed'
    | 'device-lost'

type BufferMappingAuthorityClaim = {
    id: string
    mode: BufferMappingMode
    region: BufferRegion
    state: 'pending' | 'mapped'
    lifecycleNotified: boolean
    onLifecycle(reason: BufferMappingLifecycleReason): void
}

const authorityByBuffer = new WeakMap<BufferResource, BufferMappingAuthorityClaim | undefined>()

export function initializeBufferMappingAuthority(buffer: BufferResource): void {

    if (authorityByBuffer.has(buffer)) {
        throw new TypeError('Buffer mapping authority is already initialized.')
    }
    authorityByBuffer.set(buffer, undefined)
}

export function claimBufferMappingAuthority(
    buffer: BufferResource,
    input: Readonly<{
        id: string
        mode: BufferMappingMode
        region: BufferRegion
        onLifecycle(reason: BufferMappingLifecycleReason): void
    }>
): void {

    assertAuthorityInitialized(buffer)
    const current = authorityByBuffer.get(buffer)
    if (current !== undefined) {
        throwScratchDiagnostic({
            code: 'SCRATCH_BUFFER_MAPPING_CONFLICT',
            severity: 'error',
            phase: 'buffer-mapping',
            subject: input.region.subject,
            related: [ buffer.subject, current.region.subject ],
            message: 'BufferResource already has a pending or active host mapping.',
            expected: { mappingAuthority: 'available' },
            actual: {
                mappingAuthority: current.state,
                mappingId: current.id,
                mode: current.mode,
            },
            hints: [ 'Release or cancel the current MappedBufferLease before mapping this buffer again.' ],
        })
    }
    authorityByBuffer.set(buffer, {
        id: input.id,
        mode: input.mode,
        region: input.region,
        state: 'pending',
        lifecycleNotified: false,
        onLifecycle: input.onLifecycle,
    })
}

export function activateBufferMappingAuthority(buffer: BufferResource, id: string): void {

    const claim = matchingClaim(buffer, id)
    if (claim.state !== 'pending') {
        throw new TypeError(`Buffer mapping ${id} is not pending.`)
    }
    claim.state = 'mapped'
}

export function releaseBufferMappingAuthority(buffer: BufferResource, id: string): void {

    const claim = authorityByBuffer.get(buffer)
    if (claim?.id === id) authorityByBuffer.set(buffer, undefined)
}

export function assertBufferAvailableForGpuUse(
    buffer: BufferResource,
    subject: DiagnosticSubject = buffer.subject
): void {

    assertAuthorityInitialized(buffer)
    const claim = authorityByBuffer.get(buffer)
    if (claim === undefined) return
    throwScratchDiagnostic({
        code: 'SCRATCH_BUFFER_MAPPING_GPU_USE_CONFLICT',
        severity: 'error',
        phase: 'buffer-mapping',
        subject,
        related: [ buffer.subject, claim.region.subject ],
        message: 'GPU use cannot begin while BufferResource host mapping is pending or active.',
        expected: { mappingAuthority: 'available' },
        actual: {
            mappingAuthority: claim.state,
            mappingId: claim.id,
            mode: claim.mode,
        },
        hints: [ 'Release or cancel the mapping before issuing Scratch GPU work for this buffer.' ],
    })
}

export function disposeBufferMappingAuthority(buffer: BufferResource): void {

    notifyBufferMappingLifecycle(buffer, 'resource-disposed')
}

function notifyBufferMappingLifecycle(
    buffer: BufferResource,
    reason: BufferMappingLifecycleReason
): void {

    const claim = authorityByBuffer.get(buffer)
    if (claim === undefined || claim.lifecycleNotified) return
    claim.lifecycleNotified = true
    claim.onLifecycle(reason)
}

function matchingClaim(buffer: BufferResource, id: string): BufferMappingAuthorityClaim {

    assertAuthorityInitialized(buffer)
    const claim = authorityByBuffer.get(buffer)
    if (claim?.id !== id) throw new TypeError(`Buffer mapping authority ${id} is unavailable.`)
    return claim
}

function assertAuthorityInitialized(buffer: BufferResource): void {

    if (!authorityByBuffer.has(buffer)) {
        throw new TypeError('Buffer mapping authority is unavailable.')
    }
}
