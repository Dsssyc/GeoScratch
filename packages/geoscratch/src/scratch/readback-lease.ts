import { throwScratchDiagnostic } from './diagnostics.js'
import type { LayoutArtifact } from './layout-codec.js'
import type { ReadbackOperation } from './readback.js'
import type { TextureReadbackRowLayout } from './texture-readback.js'

export type MappedReadbackLeaseState =
    | 'mapped'
    | 'released'
    | 'cancelled'
    | 'failed'
    | 'disposed'

type MappedReadbackLeaseFacts = {
    id: string
    operation: ReadbackOperation
    state: MappedReadbackLeaseState
    view: ArrayBuffer
    byteLength: number
    rowLayout: TextureReadbackRowLayout | undefined
    layout: LayoutArtifact | undefined
    close(): void
}

export type MappedReadbackLeaseConstruction = Readonly<{
    operation: ReadbackOperation
    view: ArrayBuffer
    rowLayout?: TextureReadbackRowLayout
    layout?: LayoutArtifact
    close(): void
}>

const mappedReadbackLeaseToken = Symbol('MappedReadbackLease')
const mappedReadbackLeaseFacts = new WeakMap<MappedReadbackLease, MappedReadbackLeaseFacts>()

export class MappedReadbackLease {

    private constructor(token: symbol) {

        if (token !== mappedReadbackLeaseToken || new.target !== MappedReadbackLease) {
            throw new TypeError('MappedReadbackLease must be created by ReadbackOperation.map().')
        }
        Object.preventExtensions(this)
    }

    get id(): string {

        return leaseFactsFor(this).id
    }

    get operation(): ReadbackOperation {

        return leaseFactsFor(this).operation
    }

    get state(): MappedReadbackLeaseState {

        return leaseFactsFor(this).state
    }

    get view(): ArrayBuffer {

        const facts = leaseFactsFor(this)
        if (facts.state !== 'mapped') {
            throwScratchDiagnostic({
                code: 'SCRATCH_READBACK_MAPPED_LEASE_INACTIVE',
                severity: 'error',
                phase: 'readback',
                subject: facts.operation.subject,
                message: 'MappedReadbackLease view is unavailable after its mapping authority ended.',
                expected: { state: 'mapped' },
                actual: { leaseId: facts.id, state: facts.state },
            })
        }
        return facts.view
    }

    get byteLength(): number {

        return leaseFactsFor(this).byteLength
    }

    get rowLayout(): TextureReadbackRowLayout | undefined {

        return leaseFactsFor(this).rowLayout
    }

    get layout(): LayoutArtifact | undefined {

        return leaseFactsFor(this).layout
    }

    dispose(): void {

        const facts = leaseFactsFor(this)
        if (facts.state !== 'mapped') return
        facts.close()
    }
}

export function constructMappedReadbackLease(
    construction: MappedReadbackLeaseConstruction
): MappedReadbackLease {

    const Constructor = MappedReadbackLease as unknown as new (token: symbol) => MappedReadbackLease
    const lease = new Constructor(mappedReadbackLeaseToken)
    mappedReadbackLeaseFacts.set(lease, {
        id: `${construction.operation.id}/mapped-lease`,
        operation: construction.operation,
        state: 'mapped',
        view: construction.view,
        byteLength: construction.view.byteLength,
        rowLayout: construction.rowLayout,
        layout: construction.layout,
        close: construction.close,
    })
    return lease
}

export function setMappedReadbackLeaseState(
    lease: MappedReadbackLease,
    state: Exclude<MappedReadbackLeaseState, 'mapped'>
): void {

    const facts = leaseFactsFor(lease)
    if (facts.state !== 'mapped') return
    facts.state = state
}

function leaseFactsFor(lease: MappedReadbackLease): MappedReadbackLeaseFacts {

    const facts = mappedReadbackLeaseFacts.get(lease)
    if (facts === undefined) throw new TypeError('MappedReadbackLease is not Scratch-owned.')
    return facts
}
