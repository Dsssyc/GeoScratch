import { UUID } from '../core/utils/uuid.js'
import { throwScratchDiagnostic } from './diagnostics.js'
import type { DiagnosticSubject } from './diagnostics.js'
import type { ScratchRuntime } from './runtime.js'

export type ResourceOptions = {
    label?: string
    resourceKind?: string
    descriptor?: object
}

export interface Resource {
    runtime: ScratchRuntime
    id: string
    label?: string
    resourceKind: string
    descriptor: object
    isDisposed: boolean
    allocationVersion: number
    contentEpoch: number
}

export class Resource {

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
        this.label = options.label
        this.resourceKind = options.resourceKind ?? 'Resource'
        this.descriptor = options.descriptor ?? {}
        this.isDisposed = false
        this.allocationVersion = 1
        this.contentEpoch = 0

        runtime._registerResource(this)
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
        this.runtime._unregisterResource(this)
    }

    _replaceAllocation(descriptor: object): void {

        this.descriptor = descriptor
        this.allocationVersion++
    }

    _advanceContentEpoch(): void {

        this.contentEpoch++
    }
}
