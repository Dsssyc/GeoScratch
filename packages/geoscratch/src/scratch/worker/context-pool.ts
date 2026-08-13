import { workerDiagnosticError } from './diagnostics.js'
import type {
    WorkerOperationProtocol,
    WorkerOperationProtocolInput,
    WorkerOperationProtocolMap,
    WorkerOperationProtocolOutput,
} from './module.js'
import type {
    WorkerContextFacts,
    WorkerContextHandle,
    WorkerGroup,
    WorkerGroupFacts,
    WorkerModuleReference,
    WorkerSystemFacts,
    WorkerSystemOptions,
    WorkerTaskDescriptor,
    WorkerTaskHandle,
} from './worker-system.js'
import { WorkerSystem } from './worker-system.js'

export type WorkerContextPoolSystem =
    | Readonly<{
        ownership: 'borrowed'
        system: WorkerSystem
    }>
    | Readonly<{
        ownership: 'owned'
        options?: WorkerSystemOptions
    }>

export type WorkerContextPoolDescriptor<Init> = Readonly<{
    id: string
    system: WorkerContextPoolSystem
    module: WorkerModuleReference
    size: number
    maxQueuedTasks: number
    maxActiveTasks: number
    idleTimeoutMs: number
    disposeGraceMs?: number
    context(index: number, count: number): WorkerContextPoolEntry<Init>
}>

export type WorkerContextPoolEntry<Init> = Readonly<{
    key: string
    init: Init
    restore?: unknown
}>

export type WorkerContextPoolDisposalMode =
    | 'remote-finalized'
    | 'remote-finalizer-failed'
    | 'forced-pending-work'
    | 'forced-timeout'

export type WorkerContextPoolFacts = Readonly<{
    kind: 'worker-context-pool'
    id: string
    state: 'active' | 'disposing' | 'disposed'
    systemOwnership: WorkerContextPoolSystem['ownership']
    size: number
    disposeGraceMs: number
    disposalMode?: WorkerContextPoolDisposalMode
    system: WorkerSystemFacts
    group: WorkerGroupFacts
    contexts: readonly WorkerContextFacts[]
}>

type PoolState = 'active' | 'disposing' | 'disposed'

const DEFAULT_DISPOSE_GRACE_MS = 5_000

/** Owns one fixed set of retained Worker contexts and optionally its WorkerSystem. */
export class WorkerContextPool<
    State = unknown,
    Operations extends WorkerOperationProtocolMap = WorkerOperationProtocolMap,
> {

    readonly #id: string
    readonly #system: WorkerSystem
    readonly #systemOwnership: WorkerContextPoolSystem['ownership']
    readonly #group: WorkerGroup
    readonly #contexts: readonly WorkerContextHandle<State>[]
    readonly #disposeGraceMs: number
    #state: PoolState = 'active'
    #disposalMode: WorkerContextPoolDisposalMode | undefined
    #disposePromise: Promise<void> | undefined

    private constructor(
        id: string,
        system: WorkerSystem,
        systemOwnership: WorkerContextPoolSystem['ownership'],
        group: WorkerGroup,
        contexts: readonly WorkerContextHandle<State>[],
        disposeGraceMs: number
    ) {

        this.#id = id
        this.#system = system
        this.#systemOwnership = systemOwnership
        this.#group = group
        this.#contexts = Object.freeze([ ...contexts ])
        this.#disposeGraceMs = disposeGraceMs
    }

    static async create<
        Init,
        State = unknown,
        Operations extends WorkerOperationProtocolMap = WorkerOperationProtocolMap,
    >(
        descriptor: WorkerContextPoolDescriptor<Init>
    ): Promise<WorkerContextPool<State, Operations>> {

        validateDescriptor(descriptor)
        const contextDescriptors: WorkerContextPoolEntry<Init>[] = []
        const contextKeys = new Set<string>()
        for (let index = 0; index < descriptor.size; index++) {
            const context = descriptor.context(index, descriptor.size)
            validateContextDescriptor(descriptor.id, context, index)
            if (contextKeys.has(context.key)) {
                invalidPool(
                    descriptor.id,
                    'Worker context pool keys must be unique.',
                    { index, key: context.key }
                )
            }
            contextKeys.add(context.key)
            contextDescriptors.push(context)
        }
        const configuredMaximum = descriptor.system.ownership === 'borrowed'
            ? descriptor.system.system.maxWorkers
            : descriptor.system.options?.maxWorkers
        if (configuredMaximum !== undefined && descriptor.size > configuredMaximum) {
            return invalidPool(
                descriptor.id,
                'Worker context pool size exceeds the WorkerSystem capacity.',
                { size: descriptor.size, maxWorkers: configuredMaximum }
            )
        }
        const system = descriptor.system.ownership === 'borrowed'
            ? descriptor.system.system
            : new WorkerSystem({
                ...descriptor.system.options,
                maxWorkers: descriptor.system.options?.maxWorkers ?? descriptor.size,
            })
        const disposeGraceMs = descriptor.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS
        let group: WorkerGroup | undefined
        const contexts: WorkerContextHandle<State>[] = []
        try {
            group = system.createGroup({
                id: descriptor.id,
                modules: [ descriptor.module ],
                isolation: 'group',
                size: { min: descriptor.size, max: descriptor.size },
                maxQueuedTasks: descriptor.maxQueuedTasks,
                maxActiveTasks: descriptor.maxActiveTasks,
                idleTimeoutMs: descriptor.idleTimeoutMs,
            })
            await group.ready
            for (const context of contextDescriptors) {
                contexts.push(await group.openContext<Init, State>({
                    module: descriptor.module.id,
                    ...context,
                }))
            }
            return new WorkerContextPool<State, Operations>(
                descriptor.id,
                system,
                descriptor.system.ownership,
                group,
                contexts,
                disposeGraceMs
            )
        } catch (error) {
            const cleanupFailures: unknown[] = []
            if (group !== undefined) {
                if (contexts.length > 0) {
                    const outcome = await settleContextFinalizers(contexts, disposeGraceMs)
                    if (outcome.kind === 'timeout') {
                        cleanupFailures.push(contextDisposeTimeout(
                            descriptor.id,
                            disposeGraceMs,
                            contexts
                        ))
                    } else {
                        cleanupFailures.push(...outcome.settlements
                            .filter((result): result is PromiseRejectedResult =>
                                result.status === 'rejected'
                            )
                            .map(result => result.reason))
                    }
                }
                try {
                    await group.dispose()
                } catch (cleanupError) {
                    cleanupFailures.push(cleanupError)
                }
            }
            if (descriptor.system.ownership === 'owned') {
                try {
                    await system.dispose()
                } catch (cleanupError) {
                    cleanupFailures.push(cleanupError)
                }
            }
            if (cleanupFailures.length > 0) {
                throw new AggregateError(
                    [ error, ...cleanupFailures ],
                    `Worker context pool ${descriptor.id} initialization and rollback failed`
                )
            }
            throw error
        }
    }

    run<Name extends keyof Operations & string>(
        index: number,
        operation: Name,
        input: WorkerOperationProtocolInput<Operations[Name]>,
        options: Omit<
            WorkerTaskDescriptor<WorkerOperationProtocolInput<Operations[Name]>>,
            'module' | 'operation' | 'input'
        > = {}
    ): WorkerTaskHandle<WorkerOperationProtocolOutput<Operations[Name]>> {

        type Protocol = Extract<
            Operations[Name],
            WorkerOperationProtocol<unknown, unknown>
        >
        return this.#context(index).run<
            WorkerOperationProtocolInput<Protocol>,
            WorkerOperationProtocolOutput<Protocol>
        >(operation, input, options)
    }

    snapshot<Snapshot = State>(index: number): Promise<Snapshot> {

        return this.#context(index).snapshot<Snapshot>()
    }

    #context(index: number): WorkerContextHandle<State> {

        this.#assertActive()
        if (!Number.isSafeInteger(index) || index < 0 || index >= this.#contexts.length) {
            return invalidPool(
                this.#id,
                'Worker context pool index is outside the retained context set.',
                { index, size: this.#contexts.length }
            )
        }
        return this.#contexts[index]!
    }

    inspect(): WorkerContextPoolFacts {

        return Object.freeze({
            kind: 'worker-context-pool',
            id: this.#id,
            state: this.#state,
            systemOwnership: this.#systemOwnership,
            size: this.#contexts.length,
            disposeGraceMs: this.#disposeGraceMs,
            ...(this.#disposalMode === undefined ? {} : {
                disposalMode: this.#disposalMode,
            }),
            system: this.#system.inspect(),
            group: this.#group.inspect(),
            contexts: Object.freeze(this.#contexts.map(context => context.inspect())),
        })
    }

    dispose(): Promise<void> {

        this.#disposePromise ??= this.#dispose()
        return this.#disposePromise
    }

    async #dispose(): Promise<void> {

        if (this.#state === 'disposed') return
        this.#state = 'disposing'
        const failures: unknown[] = []
        const groupFacts = this.#group.inspect()
        if (groupFacts.activeTaskCount === 0 && groupFacts.queuedTaskCount === 0) {
            const outcome = await settleContextFinalizers(
                this.#contexts,
                this.#disposeGraceMs
            )
            if (outcome.kind === 'timeout') {
                this.#disposalMode = 'forced-timeout'
                failures.push(contextDisposeTimeout(
                    this.#id,
                    this.#disposeGraceMs,
                    this.#contexts
                ))
            } else {
                const rejected = outcome.settlements.filter(
                    (settlement): settlement is PromiseRejectedResult =>
                        settlement.status === 'rejected'
                )
                this.#disposalMode = rejected.length === 0
                    ? 'remote-finalized'
                    : 'remote-finalizer-failed'
                failures.push(...rejected.map(settlement => settlement.reason))
            }
        } else {
            this.#disposalMode = 'forced-pending-work'
        }
        try {
            // In-flight work makes remote finalization unsafe, so group termination wins.
            await this.#group.dispose()
        } catch (error) {
            failures.push(error)
        }
        if (this.#systemOwnership === 'owned') {
            try {
                await this.#system.dispose()
            } catch (error) {
                failures.push(error)
            }
        }
        this.#state = 'disposed'
        if (failures.length > 0) {
            throw new AggregateError(failures, `Worker context pool ${this.#id} disposal failed`)
        }
    }

    #assertActive(): void {

        if (this.#state === 'active') return
        invalidPool(
            this.#id,
            'A disposing or disposed Worker context pool cannot provide contexts.',
            { state: this.#state }
        )
    }
}

function validateDescriptor<Init>(descriptor: WorkerContextPoolDescriptor<Init>): void {

    const validSystem = descriptor?.system?.ownership === 'borrowed'
        ? descriptor.system.system instanceof WorkerSystem
        : descriptor?.system?.ownership === 'owned' &&
            (descriptor.system.options === undefined ||
                (typeof descriptor.system.options === 'object' &&
                    descriptor.system.options !== null))
    if (typeof descriptor?.id === 'string' && descriptor.id.length > 0 &&
        validSystem && descriptor.module !== null && typeof descriptor.module === 'object' &&
        positiveInteger(descriptor.size) && positiveInteger(descriptor.maxQueuedTasks) &&
        positiveInteger(descriptor.maxActiveTasks) &&
        descriptor.maxActiveTasks <= descriptor.size &&
        positiveInteger(descriptor.idleTimeoutMs) &&
        (descriptor.disposeGraceMs === undefined || positiveInteger(descriptor.disposeGraceMs)) &&
        typeof descriptor.context === 'function') {
        return
    }
    invalidPool(
        typeof descriptor?.id === 'string' && descriptor.id.length > 0
            ? descriptor.id
            : 'invalid-worker-context-pool',
        'A Worker context pool requires explicit system ownership, a module, and finite capacity.',
        descriptor
    )
}

async function settleContextFinalizers(
    contexts: readonly WorkerContextHandle[],
    disposeGraceMs: number
): Promise<
    | Readonly<{
        kind: 'settled'
        settlements: readonly PromiseSettledResult<void>[]
    }>
    | Readonly<{ kind: 'timeout' }>
> {

    let timeout: ReturnType<typeof setTimeout> | undefined
    const settlements = Promise.allSettled(contexts.map(context => context.dispose()))
    const outcome = await Promise.race([
        settlements.then(results => Object.freeze({
            kind: 'settled' as const,
            settlements: Object.freeze(results),
        })),
        new Promise<Readonly<{ kind: 'timeout' }>>(resolve => {
            timeout = setTimeout(
                () => resolve(Object.freeze({ kind: 'timeout' })),
                disposeGraceMs
            )
        }),
    ])
    if (timeout !== undefined) clearTimeout(timeout)
    return outcome
}

function contextDisposeTimeout(
    id: string,
    disposeGraceMs: number,
    contexts: readonly WorkerContextHandle[]
): Error {

    return workerDiagnosticError({
        code: 'WORKER_CONTEXT_DISPOSE_TIMEOUT',
        severity: 'error',
        phase: 'worker-context',
        subject: { kind: 'WorkerContextPool', id },
        message: 'Worker context finalization exceeded the pool disposal grace period.',
        expected: { disposeWithinMs: disposeGraceMs },
        actual: {
            disposeGraceMs,
            pendingContextIds: contexts
                .filter(context => context.inspect().state !== 'disposed')
                .map(context => context.inspect().id),
        },
        hints: [
            'Bound context finalizers and persist durable state before pool disposal.',
            'Inspect disposalMode to distinguish graceful and forced convergence.',
        ],
        retriable: false,
    })
}

function validateContextDescriptor<Init>(
    id: string,
    context: WorkerContextPoolEntry<Init>,
    index: number
): void {

    if (context !== null && typeof context === 'object' &&
        typeof context.key === 'string' && context.key.length > 0 && 'init' in context) return
    invalidPool(id, 'A Worker context pool entry requires key and init.', {
        index,
        context,
    })
}

function invalidPool(id: string, message: string, actual: unknown): never {

    throw workerDiagnosticError({
        code: 'WORKER_DESCRIPTOR_INVALID',
        severity: 'error',
        phase: 'worker-context',
        subject: { kind: 'WorkerContextPool', id },
        message,
        actual,
        retriable: false,
    })
}

function positiveInteger(value: unknown): value is number {

    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}
