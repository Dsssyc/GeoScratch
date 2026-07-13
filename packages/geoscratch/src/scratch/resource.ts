import { UUID } from '../core/utils/uuid.js'
import { throwScratchDiagnostic } from './diagnostics.js'
import { updateRuntimeResourceFact } from './runtime-diagnostics.js'
import type { DiagnosticSubject } from './diagnostics.js'
import type { ScratchRuntime } from './runtime.js'

export type ResourceOptions = {
    label?: string
    resourceKind?: string
    descriptor?: object
    identity?: ScratchResourceIdentity
}

export type ScratchResourceIdentity = Readonly<{
    token: symbol
    id: string
}>

export type ResourceState = 'empty' | 'ready' | 'indeterminate' | 'disposed'

type ResourceMutators = {
    replaceAllocation(descriptor: object): void
    advanceContentEpoch(): void
    setContentState(state: ResourceState, contentEpoch: number): void
}

const resourceMutators = new WeakMap<Resource, ResourceMutators>()
const resourceDisposalSubscribers = new WeakMap<Resource, Set<() => void>>()
const resourceIdentityToken = Symbol('ScratchResourceIdentity')

export function subscribeResourceDisposal(resource: Resource, subscriber: () => void): () => void {

    if (resource.isDisposed) {
        subscriber()
        return () => {}
    }

    const subscribers = resourceDisposalSubscribers.get(resource)
    if (subscribers === undefined) throw new TypeError('Resource disposal subscriptions are unavailable.')
    subscribers.add(subscriber)
    return () => subscribers.delete(subscriber)
}

export function resourceDisposalSubscriberCount(resource: Resource): number {

    return resourceDisposalSubscribers.get(resource)?.size ?? 0
}

export function createScratchResourceIdentity(): ScratchResourceIdentity {

    return Object.freeze({
        token: resourceIdentityToken,
        id: `scratch-resource-${UUID()}`,
    })
}

function mutatorsFor(resource: Resource): ResourceMutators {

    const mutators = resourceMutators.get(resource)
    if (mutators === undefined) throw new TypeError('Resource transition is unavailable.')
    return mutators
}

export function replaceResourceAllocation(resource: Resource, descriptor: object): void {

    mutatorsFor(resource).replaceAllocation(descriptor)
}

export function advanceResourceContentEpoch(resource: Resource): void {

    mutatorsFor(resource).advanceContentEpoch()
}

export function setResourceContentState(
    resource: Resource,
    state: ResourceState,
    contentEpoch: number
): void {

    mutatorsFor(resource).setContentState(state, contentEpoch)
}

export class Resource {

    #runtime: ScratchRuntime
    #id: string
    #label: string | undefined
    #resourceKind: string
    #descriptor: object
    #isDisposed = false
    #state: ResourceState = 'empty'
    #allocationVersion = 1
    #contentEpoch = 0

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

        this.#runtime = runtime
        this.#id = options.identity?.token === resourceIdentityToken
            ? options.identity.id
            : `scratch-resource-${UUID()}`
        this.#label = options.label
        this.#resourceKind = options.resourceKind ?? 'Resource'
        this.#descriptor = options.descriptor ?? {}

        resourceMutators.set(this, {
            replaceAllocation: descriptor => {
                this.#descriptor = descriptor
                this.#allocationVersion++
                this.#state = this.#isDisposed ? 'disposed' : 'empty'
                updateRuntimeResourceFact(this.#runtime, this)
            },
            advanceContentEpoch: () => {
                this.#contentEpoch++
                this.#state = this.#isDisposed ? 'disposed' : 'ready'
                updateRuntimeResourceFact(this.#runtime, this)
            },
            setContentState: (state, contentEpoch) => {
                this.#state = this.#isDisposed ? 'disposed' : state
                this.#contentEpoch = contentEpoch
                updateRuntimeResourceFact(this.#runtime, this)
            },
        })
        resourceDisposalSubscribers.set(this, new Set())

        runtime._registerResource(this)
    }

    get runtime(): ScratchRuntime {

        return this.#runtime
    }

    get id(): string {

        return this.#id
    }

    get label(): string | undefined {

        return this.#label
    }

    get resourceKind(): string {

        return this.#resourceKind
    }

    get descriptor(): object {

        return this.#descriptor
    }

    get isDisposed(): boolean {

        return this.#isDisposed
    }

    get state(): ResourceState {

        return this.#state
    }

    get allocationVersion(): number {

        return this.#allocationVersion
    }

    get contentEpoch(): number {

        return this.#contentEpoch
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

        if (this.#isDisposed) {
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

        if (this.#isDisposed) return

        this.#isDisposed = true
        this.#state = 'disposed'
        const subscribers = resourceDisposalSubscribers.get(this)
        resourceDisposalSubscribers.delete(this)
        if (subscribers !== undefined) {
            for (const subscriber of subscribers) subscriber()
            subscribers.clear()
        }
        this.runtime._unregisterResource(this)
    }
}

Object.freeze(Resource.prototype)
