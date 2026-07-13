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

export type ResourceState = 'empty' | 'ready' | 'indeterminate'

export interface ContentResource extends Resource {
    readonly state: ResourceState
    readonly contentEpoch: number
    readonly isReady: boolean
}

type ResourceMutators = {
    replaceAllocation(descriptor: object): void
}

type MutableResourceContentFacts = {
    state: ResourceState
    contentEpoch: number
}

const resourceMutators = new WeakMap<Resource, ResourceMutators>()
const contentBearingOptions = new WeakSet<ResourceOptions>()
const resourceContentFacts = new WeakMap<Resource, MutableResourceContentFacts>()
const resourceDisposalSubscribers = new WeakMap<Resource, Set<() => void>>()
const registeredResources = new WeakSet<Resource>()
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

function contentFactsFor(resource: Resource): MutableResourceContentFacts {

    const facts = resourceContentFacts.get(resource)
    if (facts === undefined) throw new TypeError('Resource does not carry scalar content state.')
    return facts
}

export function contentBearingResourceOptions(options: ResourceOptions): ResourceOptions {

    contentBearingOptions.add(options)
    return options
}

export function isContentResource(resource: unknown): resource is ContentResource {

    return typeof resource === 'object' && resource !== null && resourceContentFacts.has(resource as Resource)
}

export function resourceContentState(resource: ContentResource): ResourceState {

    return contentFactsFor(resource).state
}

export function resourceContentEpoch(resource: ContentResource): number {

    return contentFactsFor(resource).contentEpoch
}

export function replaceResourceAllocation(resource: Resource, descriptor: object): void {

    mutatorsFor(resource).replaceAllocation(descriptor)
}

export function registerResource(resource: Resource): void {

    if (registeredResources.has(resource)) throw new TypeError('Resource is already registered.')
    resource.runtime._registerResource(resource)
    registeredResources.add(resource)
}

export function advanceResourceContentEpoch(resource: ContentResource): void {

    const facts = contentFactsFor(resource)
    facts.contentEpoch++
    facts.state = resource.isDisposed ? facts.state : 'ready'
    updateRuntimeResourceFact(resource.runtime, resource)
}

export function setResourceContentState(
    resource: ContentResource,
    state: ResourceState,
    contentEpoch: number
): void {

    const facts = contentFactsFor(resource)
    facts.state = state
    facts.contentEpoch = contentEpoch
    updateRuntimeResourceFact(resource.runtime, resource)
}

export abstract class Resource {

    #runtime: ScratchRuntime
    #id: string
    #label: string | undefined
    #resourceKind: string
    #descriptor: object
    #isDisposed = false
    #allocationVersion = 1

    protected constructor(runtime: ScratchRuntime, options: ResourceOptions = {}) {

        if (new.target === Resource) {
            throw new TypeError('Resource is abstract and cannot be constructed directly.')
        }

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

        if (contentBearingOptions.delete(options)) {
            resourceContentFacts.set(this, {
                state: 'empty',
                contentEpoch: 0,
            })
        }

        resourceMutators.set(this, {
            replaceAllocation: descriptor => {
                this.#descriptor = descriptor
                this.#allocationVersion++
                const content = resourceContentFacts.get(this)
                if (content !== undefined) content.state = 'empty'
                updateRuntimeResourceFact(this.#runtime, this)
            },
        })
        resourceDisposalSubscribers.set(this, new Set())

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

    get allocationVersion(): number {

        return this.#allocationVersion
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
        const subscribers = resourceDisposalSubscribers.get(this)
        resourceDisposalSubscribers.delete(this)
        if (subscribers !== undefined) {
            for (const subscriber of subscribers) subscriber()
            subscribers.clear()
        }
        if (registeredResources.delete(this)) this.runtime._unregisterResource(this)
    }
}

Object.freeze(Resource.prototype)
