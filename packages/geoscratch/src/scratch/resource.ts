import { UUID } from '../core/utils/uuid.js'
import { throwScratchDiagnostic } from './diagnostics.js'
import type { DiagnosticSubject } from './diagnostics.js'
import type { ScratchRuntime } from './runtime.js'

export type ResourceOptions = {
    label?: string
    resourceKind?: string
    descriptor?: object
}

export type ResourceState = 'empty' | 'ready' | 'disposed'

export interface Resource {
    runtime: ScratchRuntime
    id: string
    label?: string
    resourceKind: string
    isDisposed: boolean
    state: ResourceState
    allocationVersion: number
    contentEpoch: number
}

const allocationReplacers = new WeakMap<Resource, (descriptor: object) => void>()

export function replaceResourceAllocation(resource: Resource, descriptor: object): void {

    const replace = allocationReplacers.get(resource)
    if (replace === undefined) throw new TypeError('Resource allocation transition is unavailable.')
    replace(descriptor)
}

export class Resource {

    #descriptor: object

    constructor(runtime: ScratchRuntime, options: ResourceOptions = {}) {

        if (!runtime || typeof runtime._registerResource !== 'function') {
            throwScratchDiagnostic({
                code: 'SCRATCH_RESOURCE_WRONG_RUNTIME',
                severity: 'error',
                phase: 'resource',
                subject: { kind: 'Resource', resourceKind: options.resourceKind ?? 'Resource' },
                message: 'Resource requires a valid ScratchRuntime owner.',
                expected: { runtime: 'ScratchRuntime' },
                actual: { runtime: runtime === undefined || runtime === null ? String(runtime) : typeof runtime },
            })
        }

        runtime.assertActive()

        this.runtime = runtime
        this.id = `scratch-resource-${UUID()}`
        this.resourceKind = options.resourceKind ?? 'Resource'
        this.#descriptor = options.descriptor ?? {}
        this.isDisposed = false
        this.state = 'empty'
        this.allocationVersion = 1
        this.contentEpoch = 0
        if (options.label !== undefined) this.label = options.label

        allocationReplacers.set(this, descriptor => {
            this.#descriptor = descriptor
            this.allocationVersion++
            this.state = this.isDisposed ? 'disposed' : 'empty'
        })

        runtime._registerResource(this)
    }

    get descriptor(): object {

        return this.#descriptor
    }

    get subject(): DiagnosticSubject {

        const subject: DiagnosticSubject = {
            kind: 'Resource',
            id: this.id,
        }
        if (this.label !== undefined) subject.label = this.label
        if (this.resourceKind !== undefined) subject.resourceKind = this.resourceKind

        return subject
    }

    get isReady(): boolean {

        return this.state === 'ready'
    }

    assertRuntime(runtime: ScratchRuntime): void {

        this.assertUsable()

        if (runtime !== this.runtime) {
            throwScratchDiagnostic({
                code: 'SCRATCH_RESOURCE_WRONG_RUNTIME',
                severity: 'error',
                phase: 'resource',
                subject: this.subject,
                related: [
                    this.runtime.subject,
                    runtime?.subject,
                ].filter(Boolean),
                message: 'Resource belongs to a different ScratchRuntime.',
                expected: { runtimeId: this.runtime.id },
                actual: { runtimeId: runtime?.id },
                hints: [ 'Use resources with the runtime that created them.' ],
            })
        }
    }

    assertUsable(): void {

        if (this.isDisposed) {
            throwScratchDiagnostic({
                code: 'SCRATCH_RESOURCE_DISPOSED',
                severity: 'error',
                phase: 'resource',
                subject: this.subject,
                message: 'Resource has been disposed.',
                hints: [ 'Create a replacement resource before using this handle again.' ],
            })
        }

        this.runtime.assertActive()
    }

    dispose(): void {

        if (this.isDisposed) return

        this.isDisposed = true
        this.state = 'disposed'
        this.runtime._unregisterResource(this)
    }

    _advanceContentEpoch(): void {

        this.contentEpoch++
        this.state = this.isDisposed ? 'disposed' : 'ready'
    }
}
