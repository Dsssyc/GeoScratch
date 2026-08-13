import { isScratchDiagnosticError } from '../diagnostics/base.js'
import type { ScratchDiagnosticError } from '../diagnostics/base.js'
import { workerDiagnosticError } from './diagnostics.js'
import type {
    WorkerCancellationKind,
    WorkerDiagnostic,
    WorkerDiagnosticCode,
} from './diagnostics.js'
import type {
    WorkerControlInboundMessage,
    WorkerControlOutboundMessage,
    WorkerOutboundMessage,
    WorkerRemoteError,
    WorkerTaskOutboundMessage,
} from './protocol.js'
import type { WorkerModuleContract } from './module.js'
import { isWorkerModuleContract } from './module.js'

type WorkerFailure = ScratchDiagnosticError<WorkerDiagnostic>

export type WorkerTaskPriorityClass = 'background' | 'user-visible' | 'critical'

export type WorkerTaskPriority = Readonly<{
    class: WorkerTaskPriorityClass
    score: number
}>

export type WorkerTaskState =
    | 'queued'
    | 'running'
    | 'succeeded'
    | 'failed'
    | 'cancelled'
    | 'stale'
    | 'terminated'

export type WorkerTaskCancellationMode = 'cooperative' | 'non-cooperative' | 'hard'
export type WorkerGroupIsolation = 'shared' | 'group' | 'task'

export type WorkerModuleDescriptor = Readonly<{
    id: string
    version: string
    url: URL
}>

export type WorkerModuleReference = WorkerModuleDescriptor | WorkerModuleContract

export type WorkerModuleResolver = Readonly<{
    resolve(contract: WorkerModuleContract): WorkerModuleDescriptor
}>

export type WorkerEndpoint = {
    postMessage(message: unknown, transfer?: readonly Transferable[]): void
    terminate(): void
    addEventListener(type: string, listener: (event: MessageEvent<unknown> | ErrorEvent) => void): void
    removeEventListener(type: string, listener: (event: MessageEvent<unknown> | ErrorEvent) => void): void
}

export type WorkerEndpointFactory = (
    url: URL,
    options: Readonly<{ type: 'module', name: string }>
) => WorkerEndpoint

export type WorkerSystemOptions = Readonly<{
    maxWorkers?: number
    maxHistory?: number
    agingIntervalMs?: number
    workerFactory?: WorkerEndpointFactory
    bootstrapUrl?: URL
    moduleResolver?: WorkerModuleResolver
}>

export type WorkerGroupOptions = Readonly<{
    id: string
    modules: readonly WorkerModuleReference[]
    isolation: WorkerGroupIsolation
    size: Readonly<{ min: number, max: number }>
    maxQueuedTasks: number
    maxActiveTasks: number
    idleTimeoutMs: number
}>

export type ResolvedWorkerGroupOptions = Omit<WorkerGroupOptions, 'modules'> & Readonly<{
    modules: readonly WorkerModuleDescriptor[]
}>

export type WorkerTaskDescriptor<Input> = Readonly<{
    module: string
    operation: string
    input: Input
    priority?: Partial<WorkerTaskPriority>
    transfer?: readonly Transferable[]
    cancellation?: WorkerTaskCancellationMode
    generation?: number
    staleKey?: string
    deadlineMs?: number
}>

export type WorkerTaskFacts = Readonly<{
    id: string
    groupId: string
    moduleId: string
    moduleVersion: string
    operation: string
    enqueueSequence: number
    state: WorkerTaskState
    priority: WorkerTaskPriority
    cancellation: WorkerTaskCancellationMode
    cancellationKind?: WorkerCancellationKind
    workerId?: string
    generation?: number
    staleKey?: string
    deadlineMs?: number
    enqueuedAt: number
    startedAt?: number
    completedAt?: number
}>

export type WorkerContextOpenDescriptor<Init> = Readonly<{
    module: string
    key: string
    init: Init
    restore?: unknown
}>

export type WorkerContextFacts = Readonly<{
    id: string
    groupId: string
    moduleId: string
    moduleVersion: string
    key: string
    workerId: string
    state: 'active' | 'lost' | 'disposed'
}>

export type WorkerRemoteErrorFacts = Readonly<{
    remoteName: string
    remoteCode?: string
    remoteMessage: string
}>

export type WorkerHistoryEntry = Readonly<{
    sequence: number
    kind: 'queued' | 'started' | 'completed' | 'cancelled' | 'stale' | 'worker-created' |
        'worker-terminated' | 'context-opened' | 'context-disposed' | 'diagnostic'
    groupId: string
    taskId?: string
    workerId?: string
    contextId?: string
    code?: string
}>

export type WorkerGroupFacts = Readonly<{
    id: string
    state: 'active' | 'disposing' | 'disposed'
    isolation: WorkerGroupIsolation
    workerCount: number
    queuedTaskCount: number
    activeTaskCount: number
    contextCount: number
    completedTaskCount: number
    cancelledTaskCount: number
    staleTaskCount: number
    failedTaskCount: number
    terminatedWorkerCount: number
    maxQueuedTasks: number
    maxActiveTasks: number
    history: readonly WorkerHistoryEntry[]
}>

export type WorkerSystemFacts = Readonly<{
    id: string
    disposed: boolean
    maxWorkers: number
    workerCount: number
    groupCount: number
    queuedTaskCount: number
    activeTaskCount: number
    contextCount: number
    history: readonly WorkerHistoryEntry[]
}>

type TaskRecord = {
    id: string
    group: WorkerGroup
    module: WorkerModuleDescriptor
    operation: string
    input: unknown
    transfer: readonly Transferable[]
    priority: WorkerTaskPriority
    cancellation: WorkerTaskCancellationMode
    generation?: number
    staleKey?: string
    deadlineMs?: number
    contextId?: string
    affinityWorkerId?: string
    enqueueSequence: number
    enqueuedAt: number
    startedAt?: number
    completedAt?: number
    state: WorkerTaskState
    cancellationKind?: WorkerCancellationKind
    cancellationRequested: boolean
    staleRequested: boolean
    worker?: WorkerHost
    workerId?: string
    resolve: (value: unknown) => void
    reject: (reason: unknown) => void
    result: Promise<unknown>
}

type HostEvents = Readonly<{
    taskResult(host: WorkerHost, record: TaskRecord, message: WorkerTaskOutboundMessage): void
    failed(host: WorkerHost, error: WorkerRemoteError): void
    idle(host: WorkerHost): void
}>

const DEFAULT_PRIORITY: WorkerTaskPriority = Object.freeze({ class: 'user-visible', score: 0 })
const EMPTY_TRANSFER: readonly Transferable[] = Object.freeze([])
const PRIORITY_RANK: Readonly<Record<WorkerTaskPriorityClass, number>> = Object.freeze({
    background: 0,
    'user-visible': 1,
    critical: 2,
})
const WORKER_CODES = new Set<string>([
    'WORKER_MODULE_LOAD_FAILED',
    'WORKER_OPERATION_NOT_FOUND',
    'WORKER_TASK_CANCELLED',
    'WORKER_TASK_FAILED',
    'WORKER_TASK_STALE',
    'WORKER_QUEUE_SATURATED',
    'WORKER_TERMINATED',
    'WORKER_CONTEXT_LOST',
    'WORKER_TRANSFER_INVALID',
    'WORKER_GROUP_DISPOSED',
    'WORKER_SYSTEM_DISPOSED',
    'WORKER_DESCRIPTOR_INVALID',
])

let systemSequence = 0

export class WorkerTaskHandle<Output> {

    readonly result: Promise<Output>
    readonly #group: WorkerGroup
    readonly #record: TaskRecord

    private constructor(group: WorkerGroup, record: TaskRecord) {

        this.#group = group
        this.#record = record
        this.result = record.result as Promise<Output>
        Object.freeze(this)
    }

    /** @internal */
    static create<Output>(group: WorkerGroup, record: TaskRecord): WorkerTaskHandle<Output> {

        return new WorkerTaskHandle<Output>(group, record)
    }

    cancel(reason?: unknown): WorkerCancellationKind | 'none' {

        return this.#group.cancelTask(this.#record, reason)
    }

    reprioritize(priority: Partial<WorkerTaskPriority>): boolean {

        return this.#group.reprioritizeTask(this.#record, priority)
    }

    inspect(): WorkerTaskFacts {

        return taskFacts(this.#record)
    }
}

export class WorkerContextHandle<State = unknown> {

    readonly #group: WorkerGroup
    readonly #module: WorkerModuleDescriptor
    readonly #host: WorkerHost
    readonly #id: string
    readonly #key: string
    #state: 'active' | 'lost' | 'disposed' = 'active'
    #disposePromise: Promise<void> | undefined
    #loss: WorkerFailure | undefined

    private constructor(
        group: WorkerGroup,
        module: WorkerModuleDescriptor,
        host: WorkerHost,
        id: string,
        key: string
    ) {

        this.#group = group
        this.#module = module
        this.#host = host
        this.#id = id
        this.#key = key
    }

    /** @internal */
    static create<State>(
        group: WorkerGroup,
        module: WorkerModuleDescriptor,
        host: WorkerHost,
        id: string,
        key: string
    ): WorkerContextHandle<State> {

        return new WorkerContextHandle<State>(group, module, host, id, key)
    }

    run<Input, Output>(
        operation: string,
        input: Input,
        options: Omit<WorkerTaskDescriptor<Input>, 'module' | 'operation' | 'input'> = {}
    ): WorkerTaskHandle<Output> {

        this.#assertActive()
        return this.#group.runContext<Input, Output>(this, operation, input, options)
    }

    async snapshot<Snapshot = State>(): Promise<Snapshot> {

        this.#assertActive()
        const message = await this.#group.contextControl(this.#host, requestId => ({
            kind: 'context-snapshot',
            requestId,
            contextId: this.#id,
        }))
        if (message.kind !== 'context-snapshot-result') {
            throw unexpectedControlResponse(
                this.#group.id,
                this.#host.id,
                'context-snapshot-result',
                message.kind
            )
        }
        return message.value as Snapshot
    }

    dispose(): Promise<void> {

        if (this.#disposePromise !== undefined) return this.#disposePromise
        this.#disposePromise = this.#dispose()
        return this.#disposePromise
    }

    inspect(): WorkerContextFacts {

        return Object.freeze({
            id: this.#id,
            groupId: this.#group.id,
            moduleId: this.#module.id,
            moduleVersion: this.#module.version,
            key: this.#key,
            workerId: this.#host.id,
            state: this.#state,
        })
    }

    /** @internal */
    contextId(): string {

        return this.#id
    }

    /** @internal */
    affinityHost(): WorkerHost {

        return this.#host
    }

    /** @internal */
    lose(error: WorkerFailure): void {

        if (this.#state !== 'active') return
        this.#state = 'lost'
        this.#loss = error
    }

    /** @internal */
    async disposeFromGroup(): Promise<void> {

        await this.dispose()
    }

    async #dispose(): Promise<void> {

        if (this.#state === 'disposed') return
        if (this.#state === 'lost') {
            this.#state = 'disposed'
            this.#group.removeContext(this)
            return
        }
        const message = await this.#group.contextControl(this.#host, requestId => ({
            kind: 'context-dispose',
            requestId,
            contextId: this.#id,
        }))
        if (message.kind !== 'context-disposed') {
            throw unexpectedControlResponse(
                this.#group.id,
                this.#host.id,
                'context-disposed',
                message.kind
            )
        }
        this.#state = 'disposed'
        this.#host.contextIds.delete(this.#id)
        this.#group.removeContext(this)
    }

    #assertActive(): void {

        if (this.#state === 'active') return
        if (this.#loss !== undefined) throw this.#loss
        throw workerDiagnosticError({
            code: 'WORKER_CONTEXT_LOST',
            severity: 'error',
            phase: 'worker-context',
            subject: { kind: 'WorkerContext', id: this.#id },
            message: `Worker context ${this.#id} is ${this.#state}.`,
            groupId: this.#group.id,
            workerId: this.#host.id,
            moduleId: this.#module.id,
            moduleVersion: this.#module.version,
            retriable: this.#state === 'lost',
        })
    }
}

export class WorkerGroup {

    readonly id: string
    readonly options: ResolvedWorkerGroupOptions
    readonly ready: Promise<void>
    readonly #system: WorkerSystem
    readonly #modules: ReadonlyMap<string, WorkerModuleDescriptor>
    readonly #hosts = new Map<string, WorkerHost>()
    readonly #queue: TaskRecord[] = []
    readonly #records = new Map<string, TaskRecord>()
    readonly #contexts = new Map<string, WorkerContextHandle>()
    readonly #latestGenerations = new Map<string, number>()
    readonly #history: WorkerHistoryEntry[] = []
    readonly #idleTimers = new Map<string, ReturnType<typeof setTimeout>>()
    #state: 'active' | 'disposing' | 'disposed' = 'active'
    #startingHosts = 0
    #activeTaskCount = 0
    #completedTaskCount = 0
    #cancelledTaskCount = 0
    #staleTaskCount = 0
    #failedTaskCount = 0
    #terminatedWorkerCount = 0
    #disposePromise: Promise<void> | undefined

    private constructor(
        system: WorkerSystem,
        options: WorkerGroupOptions,
        modules: readonly WorkerModuleDescriptor[]
    ) {

        validateGroupOptions(options, modules)
        this.#system = system
        this.options = freezeGroupOptions(options, modules)
        this.id = options.id
        this.#modules = new Map(modules.map(module => [ module.id, freezeModule(module) ]))
        this.ready = this.#warm()
    }

    /** @internal */
    static create(
        system: WorkerSystem,
        options: WorkerGroupOptions,
        modules: readonly WorkerModuleDescriptor[]
    ): WorkerGroup {

        return new WorkerGroup(system, options, modules)
    }

    run<Input, Output>(descriptor: WorkerTaskDescriptor<Input>): WorkerTaskHandle<Output> {

        return this.#enqueue<Input, Output>(descriptor)
    }

    async openContext<Init, State = unknown>(
        descriptor: WorkerContextOpenDescriptor<Init>
    ): Promise<WorkerContextHandle<State>> {

        this.#assertActive()
        if (this.options.isolation !== 'group') {
            throw descriptorError(
                'WorkerGroup',
                this.id,
                'Stateful contexts require group isolation.'
            )
        }
        const module = this.#requireModule(descriptor.module)
        await this.ready
        const host = await this.#obtainContextHost()
        const contextId = this.#system.nextId('worker-context')
        const message = await this.contextControl(host, requestId => ({
            kind: 'context-open',
            requestId,
            contextId,
            groupId: this.id,
            moduleId: module.id,
            moduleVersion: module.version,
            key: descriptor.key,
            init: descriptor.init,
            ...(descriptor.restore === undefined ? {} : { restore: descriptor.restore }),
        }))
        if (message.kind !== 'context-opened') {
            throw unexpectedControlResponse(this.id, host.id, 'context-opened', message.kind)
        }
        this.#assertActive()
        host.contextIds.add(contextId)
        const handle = WorkerContextHandle.create<State>(
            this,
            module,
            host,
            contextId,
            descriptor.key
        )
        this.#contexts.set(contextId, handle)
        this.#recordHistory({ kind: 'context-opened', contextId, workerId: host.id })
        return handle
    }

    inspect(): WorkerGroupFacts {

        return Object.freeze({
            id: this.id,
            state: this.#state,
            isolation: this.options.isolation,
            workerCount: this.#hosts.size,
            queuedTaskCount: this.#queue.length,
            activeTaskCount: this.#activeTaskCount,
            contextCount: this.#contexts.size,
            completedTaskCount: this.#completedTaskCount,
            cancelledTaskCount: this.#cancelledTaskCount,
            staleTaskCount: this.#staleTaskCount,
            failedTaskCount: this.#failedTaskCount,
            terminatedWorkerCount: this.#terminatedWorkerCount,
            maxQueuedTasks: this.options.maxQueuedTasks,
            maxActiveTasks: this.options.maxActiveTasks,
            history: Object.freeze([ ...this.#history ]),
        })
    }

    dispose(): Promise<void> {

        if (this.#disposePromise !== undefined) return this.#disposePromise
        this.#disposePromise = this.#dispose()
        return this.#disposePromise
    }

    /** @internal */
    cancelTask(record: TaskRecord, reason?: unknown): WorkerCancellationKind | 'none' {

        if (isTerminal(record.state)) return 'none'
        if (record.state === 'queued') {
            this.#removeQueued(record)
            record.cancellationKind = 'queued'
            this.#settleError(record, taskCancellationError(record, 'queued', reason))
            return 'queued'
        }
        if (record.cancellation === 'hard') {
            if (this.options.isolation !== 'task' || record.worker === undefined) {
                throw workerDiagnosticError({
                    code: 'WORKER_TRANSFER_INVALID',
                    severity: 'error',
                    phase: 'worker-task',
                    subject: { kind: 'WorkerTask', id: record.id },
                    message: 'Hard cancellation requires task-isolated worker ownership.',
                    expected: { isolation: 'task' },
                    actual: { isolation: this.options.isolation },
                    groupId: this.id,
                    taskId: record.id,
                    cancellationKind: 'hard',
                    retriable: false,
                })
            }
            record.cancellationKind = 'hard'
            this.#terminateHost(record.worker, taskTerminationError(record, 'hard', reason))
            return 'hard'
        }
        if (record.cancellation === 'non-cooperative') return 'none'
        record.cancellationRequested = true
        record.cancellationKind = 'cooperative'
        record.worker?.cancel(record.id, reason === undefined ? undefined : String(reason))
        return 'cooperative'
    }

    /** @internal */
    reprioritizeTask(record: TaskRecord, priority: Partial<WorkerTaskPriority>): boolean {

        if (record.state !== 'queued') return false
        record.priority = normalizePriority(priority, record.priority)
        this.#system.schedule()
        return true
    }

    /** @internal */
    runContext<Input, Output>(
        context: WorkerContextHandle,
        operation: string,
        input: Input,
        options: Omit<WorkerTaskDescriptor<Input>, 'module' | 'operation' | 'input'>
    ): WorkerTaskHandle<Output> {

        return this.#enqueue<Input, Output>({
            module: context.inspect().moduleId,
            operation,
            input,
            ...options,
        }, context)
    }

    /** @internal */
    async contextControl(
        host: WorkerHost,
        create: (requestId: string) => WorkerControlInboundMessage
    ): Promise<WorkerControlOutboundMessage> {

        if (host.terminated) throw contextLostError(this.id, host.id, 'unknown', 'unknown')
        const requestId = this.#system.nextId('worker-control')
        try {
            return await host.control(create(requestId))
        } catch (error) {
            if (error instanceof HostControlError) {
                throw remoteDiagnosticError({
                    group: this,
                    host,
                    remote: error.remote,
                    phase: 'worker-context',
                    subject: { kind: 'WorkerContext', id: requestId },
                })
            }
            throw error
        }
    }

    /** @internal */
    removeContext(context: WorkerContextHandle): void {

        const facts = context.inspect()
        this.#contexts.delete(facts.id)
        this.#recordHistory({
            kind: 'context-disposed',
            contextId: facts.id,
            workerId: facts.workerId,
        })
        const host = this.#hosts.get(facts.workerId)
        if (host !== undefined) this.#armIdle(host)
    }

    /** @internal */
    hostCountWithStarting(): number {

        return this.#hosts.size + this.#startingHosts
    }

    /** @internal */
    minimumHostCount(): number {

        return this.options.size.min
    }

    /** @internal */
    addStartingHost(): void {

        this.#startingHosts++
    }

    /** @internal */
    addHost(host: WorkerHost): void {

        this.#startingHosts--
        this.#hosts.set(host.id, host)
        this.#recordHistory({ kind: 'worker-created', workerId: host.id })
    }

    /** @internal */
    failStartingHost(): void {

        this.#startingHosts = Math.max(0, this.#startingHosts - 1)
    }

    /** @internal */
    dispatchOne(): boolean {

        if (this.#state !== 'active' || this.#activeTaskCount >= this.options.maxActiveTasks ||
            this.#queue.length === 0) return false
        const idleHosts = [ ...this.#hosts.values() ].filter(host => host.dispatchable)
        if (idleHosts.length === 0) {
            if (this.hostCountWithStarting() < this.options.size.max) {
                this.#system.tryCreateHost(this)
            }
            return false
        }
        const ordered = [ ...this.#queue ].sort((left, right) => this.#compareTasks(left, right))
        let selected: TaskRecord | undefined
        let host: WorkerHost | undefined
        for (const candidate of ordered) {
            const candidateHost = candidate.affinityWorkerId === undefined
                ? idleHosts[0]
                : idleHosts.find(value => value.id === candidate.affinityWorkerId)
            if (candidateHost !== undefined) {
                selected = candidate
                host = candidateHost
                break
            }
        }
        if (selected === undefined || host === undefined) return false
        this.#removeQueued(selected)
        this.#clearIdle(host)
        selected.state = 'running'
        selected.startedAt = now()
        selected.worker = host
        selected.workerId = host.id
        this.#activeTaskCount++
        this.#recordHistory({ kind: 'started', taskId: selected.id, workerId: host.id })
        host.dispatch(selected)
        return true
    }

    /** @internal */
    handleTaskResult(host: WorkerHost, record: TaskRecord, message: WorkerTaskOutboundMessage): void {

        this.#activeTaskCount = Math.max(0, this.#activeTaskCount - 1)
        if (record.staleRequested || this.#isGenerationStale(record)) {
            record.cancellationKind = 'stale'
            this.#settleError(record, taskStaleError(record))
        } else if (record.cancellationRequested ||
            (message.kind === 'task-error' && message.cancelled)) {
            record.cancellationKind = 'cooperative'
            this.#settleError(record, taskCancellationError(
                record,
                'cooperative',
                message.kind === 'task-error' ? message.error.message : undefined
            ))
        } else if (message.kind === 'task-result') {
            this.#settleSuccess(record, message.value)
        } else {
            this.#settleError(record, remoteDiagnosticError({
                group: this,
                host,
                remote: message.error,
                record,
                phase: 'worker-task',
                subject: { kind: 'WorkerTask', id: record.id },
            }))
        }
        if (this.options.isolation === 'task') {
            this.#terminateHost(host)
        } else {
            this.#armIdle(host)
        }
        this.#system.schedule()
    }

    /** @internal */
    handleHostFailure(host: WorkerHost, remote: WorkerRemoteError): WorkerFailure {

        const record = host.activeTask
        const error = record === undefined
            ? workerDiagnosticError({
                code: host.initialized ? 'WORKER_TERMINATED' : 'WORKER_MODULE_LOAD_FAILED',
                severity: 'error',
                phase: host.initialized ? 'worker-system' : 'worker-module',
                subject: { kind: 'WorkerHost', id: host.id },
                message: remote.message,
                actual: remoteFacts(remote),
                groupId: this.id,
                workerId: host.id,
                retriable: true,
                ...(remote.stack === undefined ? {} : { remoteStack: remote.stack }),
            })
            : taskTerminationError(record, 'hard', remote.message, remote)
        if (record === undefined) {
            this.#recordHistory({
                kind: 'diagnostic',
                workerId: host.id,
                code: error.diagnostic.code,
            })
        }
        this.#terminateHost(host, error)
        if (host.initialized && this.#state === 'active' &&
            this.#hosts.size + this.#startingHosts < this.options.size.min) {
            this.#system.tryCreateHost(this)
        }
        this.#system.schedule()
        return error
    }

    /** @internal */
    hostIdle(host: WorkerHost): void {

        this.#armIdle(host)
        this.#system.capacityChanged()
        this.#system.schedule()
    }

    /** @internal */
    reclaimableHosts(): readonly WorkerHost[] {

        if (this.#hosts.size <= this.options.size.min) return []
        return [ ...this.#hosts.values() ].filter(host =>
            host.dispatchable && host.contextIds.size === 0
        )
    }

    /** @internal */
    reclaimHost(host: WorkerHost): void {

        this.#terminateHost(host)
    }

    /** @internal */
    groupState(): 'active' | 'disposing' | 'disposed' {

        return this.#state
    }

    /** @internal */
    latestGeneration(staleKey: string): number | undefined {

        return this.#latestGenerations.get(staleKey)
    }

    #enqueue<Input, Output>(
        descriptor: WorkerTaskDescriptor<Input>,
        context?: WorkerContextHandle
    ): WorkerTaskHandle<Output> {

        this.#assertActive()
        if (this.#queue.length >= this.options.maxQueuedTasks) {
            throw workerDiagnosticError({
                code: 'WORKER_QUEUE_SATURATED',
                severity: 'error',
                phase: 'worker-group',
                subject: { kind: 'WorkerGroup', id: this.id },
                message: `Worker group ${this.id} queue reached its configured capacity.`,
                expected: { maximumQueuedTasks: this.options.maxQueuedTasks },
                actual: { queuedTasks: this.#queue.length },
                groupId: this.id,
                retriable: true,
            })
        }
        const module = this.#requireModule(descriptor.module)
        validateTaskDescriptor(descriptor)
        if (descriptor.cancellation === 'hard' && this.options.isolation !== 'task') {
            throw descriptorError(
                'WorkerTask',
                descriptor.operation,
                'Hard cancellation requires task isolation.',
                { isolation: 'task' },
                { isolation: this.options.isolation }
            )
        }
        if (this.options.isolation === 'shared' &&
            descriptor.cancellation === 'non-cooperative') {
            throw descriptorError(
                'WorkerTask',
                descriptor.operation,
                'Shared isolation accepts only cooperative tasks.',
                { cancellation: 'cooperative' },
                { cancellation: 'non-cooperative' }
            )
        }
        const id = this.#system.nextId('worker-task')
        let resolveResult!: (value: unknown) => void
        let rejectResult!: (reason: unknown) => void
        const result = new Promise<unknown>((resolve, reject) => {
            resolveResult = resolve
            rejectResult = reject
        })
        const record: TaskRecord = {
            id,
            group: this,
            module,
            operation: descriptor.operation,
            input: descriptor.input,
            transfer: Object.freeze([ ...(descriptor.transfer ?? []) ]),
            priority: normalizePriority(descriptor.priority),
            cancellation: descriptor.cancellation ?? 'cooperative',
            enqueueSequence: this.#system.nextSequence(),
            enqueuedAt: now(),
            state: 'queued',
            cancellationRequested: false,
            staleRequested: false,
            resolve: resolveResult,
            reject: rejectResult,
            result,
            ...(descriptor.generation === undefined ? {} : { generation: descriptor.generation }),
            ...(descriptor.staleKey === undefined ? {} : { staleKey: descriptor.staleKey }),
            ...(descriptor.deadlineMs === undefined ? {} : { deadlineMs: descriptor.deadlineMs }),
            ...(context === undefined ? {} : {
                contextId: context.contextId(),
                affinityWorkerId: context.affinityHost().id,
            }),
        }
        this.#records.set(id, record)
        const handle = WorkerTaskHandle.create<Output>(this, record)
        if (record.staleKey !== undefined && record.generation !== undefined) {
            const current = this.#latestGenerations.get(record.staleKey)
            if (current !== undefined && record.generation < current) {
                record.cancellationKind = 'stale'
                this.#settleError(record, taskStaleError(record))
                return handle
            }
            if (current === undefined || record.generation > current) {
                this.#latestGenerations.set(record.staleKey, record.generation)
                this.#supersede(record.staleKey, record.generation)
            }
        }
        this.#queue.push(record)
        this.#recordHistory({ kind: 'queued', taskId: id })
        this.#system.schedule()
        return handle
    }

    #supersede(staleKey: string, generation: number): void {

        for (const candidate of this.#records.values()) {
            if (candidate.staleKey !== staleKey || candidate.generation === undefined ||
                candidate.generation >= generation || isTerminal(candidate.state)) continue
            candidate.staleRequested = true
            candidate.cancellationKind = 'stale'
            if (candidate.state === 'queued') {
                this.#removeQueued(candidate)
                this.#settleError(candidate, taskStaleError(candidate))
            } else {
                candidate.worker?.cancel(candidate.id, 'superseded-generation')
            }
        }
    }

    #isGenerationStale(record: TaskRecord): boolean {

        return record.staleKey !== undefined && record.generation !== undefined &&
            this.#latestGenerations.get(record.staleKey) !== record.generation
    }

    #compareTasks(left: TaskRecord, right: TaskRecord): number {

        const leftPriority = effectivePriority(left, this.#system.agingIntervalMs)
        const rightPriority = effectivePriority(right, this.#system.agingIntervalMs)
        return rightPriority.rank - leftPriority.rank ||
            rightPriority.score - leftPriority.score ||
            left.enqueueSequence - right.enqueueSequence
    }

    #settleSuccess(record: TaskRecord, value: unknown): void {

        if (isTerminal(record.state)) return
        record.state = 'succeeded'
        record.completedAt = now()
        this.#completedTaskCount++
        this.#records.delete(record.id)
        this.#recordHistory({
            kind: 'completed',
            taskId: record.id,
            ...(record.workerId === undefined ? {} : { workerId: record.workerId }),
        })
        record.resolve(value)
        releaseTaskInputs(record)
    }

    #settleError(record: TaskRecord, error: WorkerFailure): void {

        if (isTerminal(record.state)) return
        const code = error.diagnostic.code
        record.state = code === 'WORKER_TASK_CANCELLED'
            ? 'cancelled'
            : code === 'WORKER_TASK_STALE'
                ? 'stale'
                : code === 'WORKER_TERMINATED'
                    ? 'terminated'
                    : 'failed'
        record.completedAt = now()
        if (record.state === 'cancelled') this.#cancelledTaskCount++
        else if (record.state === 'stale') this.#staleTaskCount++
        else this.#failedTaskCount++
        this.#records.delete(record.id)
        this.#recordHistory({
            kind: record.state === 'cancelled' ? 'cancelled' : record.state === 'stale' ? 'stale' : 'diagnostic',
            taskId: record.id,
            code,
            ...(record.workerId === undefined ? {} : { workerId: record.workerId }),
        })
        record.reject(error)
        releaseTaskInputs(record)
    }

    #removeQueued(record: TaskRecord): void {

        const index = this.#queue.indexOf(record)
        if (index >= 0) this.#queue.splice(index, 1)
    }

    async #obtainContextHost(): Promise<WorkerHost> {

        const existing = [ ...this.#hosts.values() ]
            .filter(host => !host.terminated)
            .sort((left, right) => left.contextIds.size - right.contextIds.size)[0]
        if (existing !== undefined) return existing
        return await this.#system.createHost(this)
    }

    #terminateHost(host: WorkerHost, activeError?: WorkerFailure): void {

        if (!this.#hosts.has(host.id)) return
        this.#clearIdle(host)
        const active = host.activeTask
        host.terminate(activeError)
        this.#hosts.delete(host.id)
        this.#terminatedWorkerCount++
        this.#recordHistory({ kind: 'worker-terminated', workerId: host.id })
        if (active !== undefined) {
            this.#activeTaskCount = Math.max(0, this.#activeTaskCount - 1)
            this.#settleError(active, activeError ?? taskTerminationError(active, 'hard'))
        }
        for (const contextId of host.contextIds) {
            const context = this.#contexts.get(contextId)
            if (context !== undefined) {
                context.lose(contextLostError(
                    this.id,
                    host.id,
                    context.inspect().moduleId,
                    contextId
                ))
            }
        }
        this.#system.hostReleased(host)
    }

    #armIdle(host: WorkerHost): void {

        this.#clearIdle(host)
        if (this.#state !== 'active' || !host.dispatchable || host.contextIds.size > 0 ||
            this.#queue.length > 0 || this.#hosts.size <= this.options.size.min) return
        const timer = setTimeout(() => {
            this.#idleTimers.delete(host.id)
            if (host.dispatchable && host.contextIds.size === 0 &&
                this.#hosts.size > this.options.size.min && this.#queue.length === 0) {
                this.#terminateHost(host)
            }
        }, this.options.idleTimeoutMs)
        this.#idleTimers.set(host.id, timer)
    }

    #clearIdle(host: WorkerHost): void {

        const timer = this.#idleTimers.get(host.id)
        if (timer !== undefined) clearTimeout(timer)
        this.#idleTimers.delete(host.id)
    }

    async #warm(): Promise<void> {

        const hosts: Promise<WorkerHost>[] = []
        for (let index = 0; index < this.options.size.min; index++) {
            hosts.push(this.#system.createHost(this))
        }
        await Promise.all(hosts)
    }

    async #dispose(): Promise<void> {

        if (this.#state === 'disposed') return
        this.#state = 'disposing'
        for (const record of [ ...this.#queue ]) {
            this.#removeQueued(record)
            this.#settleError(record, groupDisposedError(this.id, record))
        }
        for (const host of [ ...this.#hosts.values() ]) {
            const active = host.activeTask
            this.#terminateHost(
                host,
                active === undefined ? undefined : groupDisposedError(this.id, active)
            )
        }
        await Promise.allSettled([ ...this.#contexts.values() ].map(context =>
            context.disposeFromGroup()
        ))
        this.#state = 'disposed'
        this.#system.removeGroup(this)
    }

    #requireModule(id: string): WorkerModuleDescriptor {

        const module = this.#modules.get(id)
        if (module === undefined) {
            throw workerDiagnosticError({
                code: 'WORKER_MODULE_LOAD_FAILED',
                severity: 'error',
                phase: 'worker-module',
                subject: { kind: 'WorkerModule', id },
                message: `Worker module ${id} is not registered in group ${this.id}.`,
                expected: { moduleIds: [ ...this.#modules.keys() ] },
                actual: { moduleId: id },
                groupId: this.id,
                moduleId: id,
                retriable: false,
            })
        }
        return module
    }

    #assertActive(): void {

        if (this.#state === 'active') return
        throw groupDisposedError(this.id)
    }

    #recordHistory(input: Omit<WorkerHistoryEntry, 'sequence' | 'groupId'>): void {

        const entry = Object.freeze({
            sequence: this.#system.nextSequence(),
            groupId: this.id,
            ...input,
        })
        this.#history.push(entry)
        if (this.#history.length > this.#system.maxHistory) {
            this.#history.splice(0, this.#history.length - this.#system.maxHistory)
        }
        this.#system.record(entry)
    }
}

export class WorkerSystem {

    readonly id: string
    readonly maxWorkers: number
    readonly maxHistory: number
    readonly agingIntervalMs: number
    readonly bootstrapUrl: URL
    readonly #workerFactory: WorkerEndpointFactory
    readonly #moduleResolver: WorkerModuleResolver | undefined
    readonly #groups = new Map<string, WorkerGroup>()
    readonly #hosts = new Set<WorkerHost>()
    readonly #history: WorkerHistoryEntry[] = []
    readonly #capacityWaiters: (() => void)[] = []
    #disposed = false
    #sequence = 0
    #hostSequence = 0
    #schedulePending = false
    #creatingGroups = new Set<string>()
    #startingHostCount = 0
    #disposePromise: Promise<void> | undefined
    #roundRobinCursor = 0

    constructor(options: WorkerSystemOptions = {}) {

        this.id = `worker-system-${++systemSequence}`
        this.maxWorkers = positiveInteger(options.maxWorkers ?? defaultWorkerCount(), 'maxWorkers')
        this.maxHistory = nonNegativeInteger(options.maxHistory ?? 64, 'maxHistory')
        this.agingIntervalMs = positiveInteger(options.agingIntervalMs ?? 2_000, 'agingIntervalMs')
        this.bootstrapUrl = options.bootstrapUrl ?? new URL('./worker-bootstrap.js', import.meta.url)
        this.#workerFactory = options.workerFactory ?? defaultWorkerFactory
        this.#moduleResolver = captureModuleResolver(options.moduleResolver, this.id)
    }

    createGroup(options: WorkerGroupOptions): WorkerGroup {

        this.#assertActive()
        if (this.#groups.has(options.id)) {
            throw descriptorError('WorkerGroup', options.id, 'Worker group ids must be unique per system.')
        }
        const reservedMinimum = [ ...this.#groups.values() ]
            .reduce((sum, group) => sum + group.minimumHostCount(), 0) + options.size.min
        if (reservedMinimum > this.maxWorkers) {
            throw descriptorError(
                'WorkerSystem',
                this.id,
                'Worker group minimum sizes exceed the system worker budget.',
                { maximum: this.maxWorkers },
                { requestedMinimum: reservedMinimum }
            )
        }
        const modules = options.modules.map(module => this.#resolveModule(module))
        const group = WorkerGroup.create(this, options, modules)
        this.#groups.set(group.id, group)
        return group
    }

    #resolveModule(module: WorkerModuleReference): WorkerModuleDescriptor {

        if (!isWorkerModuleContract(module)) return module
        if (this.#moduleResolver === undefined) {
            throw workerDiagnosticError({
                code: 'WORKER_DESCRIPTOR_INVALID',
                severity: 'error',
                phase: 'worker-module',
                subject: { kind: 'WorkerModule', id: module.id },
                message: `Worker module ${module.id}@${module.version} requires a module resolver.`,
                expected: { moduleResolver: 'WorkerModuleResolver' },
                actual: { moduleResolver: undefined },
                retriable: false,
            })
        }
        const resolved = this.#moduleResolver.resolve(module)
        if (resolved === null || typeof resolved !== 'object' ||
            resolved.id !== module.id || resolved.version !== module.version ||
            !(resolved.url instanceof URL)) {
            throw workerDiagnosticError({
                code: 'WORKER_DESCRIPTOR_INVALID',
                severity: 'error',
                phase: 'worker-module',
                subject: { kind: 'WorkerModule', id: module.id },
                message: 'Worker module resolver returned a different module identity.',
                expected: { id: module.id, version: module.version },
                actual: resolved,
                retriable: false,
            })
        }
        return resolved
    }

    inspect(): WorkerSystemFacts {

        const groups = [ ...this.#groups.values() ].map(group => group.inspect())
        return Object.freeze({
            id: this.id,
            disposed: this.#disposed,
            maxWorkers: this.maxWorkers,
            workerCount: this.#hosts.size,
            groupCount: groups.length,
            queuedTaskCount: groups.reduce((sum, group) => sum + group.queuedTaskCount, 0),
            activeTaskCount: groups.reduce((sum, group) => sum + group.activeTaskCount, 0),
            contextCount: groups.reduce((sum, group) => sum + group.contextCount, 0),
            history: Object.freeze([ ...this.#history ]),
        })
    }

    dispose(): Promise<void> {

        if (this.#disposePromise !== undefined) return this.#disposePromise
        this.#disposePromise = this.#dispose()
        return this.#disposePromise
    }

    /** @internal */
    nextId(prefix: string): string {

        return `${this.id}:${prefix}-${this.nextSequence()}`
    }

    /** @internal */
    nextSequence(): number {

        return ++this.#sequence
    }

    /** @internal */
    record(entry: WorkerHistoryEntry): void {

        if (this.maxHistory === 0) return
        this.#history.push(entry)
        if (this.#history.length > this.maxHistory) {
            this.#history.splice(0, this.#history.length - this.maxHistory)
        }
    }

    /** @internal */
    schedule(): void {

        if (this.#disposed || this.#schedulePending) return
        this.#schedulePending = true
        queueMicrotask(() => this.#pump())
    }

    /** @internal */
    async createHost(group: WorkerGroup): Promise<WorkerHost> {

        this.#assertActive()
        if (group.groupState() !== 'active') throw groupDisposedError(group.id)
        await this.#reserveCapacity(group)
        if (group.groupState() !== 'active') {
            this.#releaseStartingReservation(group)
            throw groupDisposedError(group.id)
        }
        const hostId = `${this.id}:worker-${++this.#hostSequence}`
        let endpoint: WorkerEndpoint
        try {
            endpoint = this.#workerFactory(this.bootstrapUrl, {
                type: 'module',
                name: `${group.id}:${hostId}`,
            })
        } catch (error) {
            this.#releaseStartingReservation(group)
            throw workerDiagnosticError({
                code: 'WORKER_MODULE_LOAD_FAILED',
                severity: 'error',
                phase: 'worker-system',
                subject: { kind: 'WorkerHost', id: hostId },
                message: `Worker host ${hostId} could not be created.`,
                actual: serializeUnknownError(error),
                groupId: group.id,
                workerId: hostId,
                retriable: true,
            }, error)
        }
        const host = new WorkerHost(
            hostId,
            group,
            endpoint,
            {
                taskResult: (host, record, message) => group.handleTaskResult(host, record, message),
                failed: (host, error) => group.handleHostFailure(host, error),
                idle: host => group.hostIdle(host),
            }
        )
        this.#startingHostCount--
        this.#hosts.add(host)
        group.addHost(host)
        try {
            await host.ready
        } catch (error) {
            if (isScratchDiagnosticError(error) && error.diagnostic.domain === 'worker') throw error
            const remote = error instanceof HostControlError
                ? error.remote
                : { name: 'Error', message: error instanceof Error ? error.message : String(error) }
            throw group.handleHostFailure(host, remote)
        }
        this.schedule()
        return host
    }

    /** @internal */
    tryCreateHost(group: WorkerGroup): void {

        if (this.#disposed || this.#creatingGroups.has(group.id) ||
            group.hostCountWithStarting() >= group.options.size.max) return
        this.#creatingGroups.add(group.id)
        void this.createHost(group)
            .catch(() => undefined)
            .finally(() => {
                this.#creatingGroups.delete(group.id)
                this.schedule()
            })
    }

    /** @internal */
    hostReleased(host: WorkerHost): void {

        this.#hosts.delete(host)
        this.#wakeCapacity()
        this.schedule()
    }

    /** @internal */
    removeGroup(group: WorkerGroup): void {

        if (this.#groups.get(group.id) === group) this.#groups.delete(group.id)
        this.#wakeCapacity()
    }

    /** @internal */
    capacityChanged(): void {

        this.#wakeCapacity()
    }

    async #reserveCapacity(group: WorkerGroup): Promise<void> {

        while (!this.#disposed && this.#hosts.size + this.#startingHostCount >= this.maxWorkers) {
            if (group.groupState() !== 'active') throw groupDisposedError(group.id)
            const victim = this.#reclaimableHost(group)
            if (victim !== undefined) {
                victim.group.reclaimHost(victim)
                continue
            }
            await new Promise<void>(resolve => this.#capacityWaiters.push(resolve))
        }
        this.#assertActive()
        if (group.groupState() !== 'active') throw groupDisposedError(group.id)
        this.#startingHostCount++
        group.addStartingHost()
    }

    #reclaimableHost(requester: WorkerGroup): WorkerHost | undefined {

        return [ ...this.#hosts ]
            .filter(host => host.group !== requester && host.group.reclaimableHosts().includes(host))
            .sort((left, right) =>
                right.group.inspect().workerCount - left.group.inspect().workerCount ||
                left.id.localeCompare(right.id)
            )[0]
    }

    #wakeCapacity(): void {

        for (const resolve of this.#capacityWaiters.splice(0)) resolve()
    }

    #releaseStartingReservation(group: WorkerGroup): void {

        group.failStartingHost()
        this.#startingHostCount = Math.max(0, this.#startingHostCount - 1)
        this.#wakeCapacity()
    }

    #pump(): void {

        this.#schedulePending = false
        if (this.#disposed) return
        const groups = [ ...this.#groups.values() ].filter(group => group.groupState() === 'active')
        if (groups.length === 0) return
        let progress = true
        while (progress) {
            progress = false
            for (let offset = 0; offset < groups.length; offset++) {
                const index = (this.#roundRobinCursor + offset) % groups.length
                if (groups[index]!.dispatchOne()) progress = true
            }
            this.#roundRobinCursor = (this.#roundRobinCursor + 1) % groups.length
        }
    }

    async #dispose(): Promise<void> {

        if (this.#disposed) return
        this.#disposed = true
        this.#wakeCapacity()
        await Promise.allSettled([ ...this.#groups.values() ].map(group => group.dispose()))
        this.#groups.clear()
        for (const host of [ ...this.#hosts ]) host.terminate()
        this.#hosts.clear()
    }

    #assertActive(): void {

        if (!this.#disposed) return
        throw workerDiagnosticError({
            code: 'WORKER_SYSTEM_DISPOSED',
            severity: 'error',
            phase: 'worker-system',
            subject: { kind: 'WorkerSystem', id: this.id },
            message: `Worker system ${this.id} is disposed.`,
            retriable: false,
        })
    }
}

class WorkerHost {

    readonly id: string
    readonly group: WorkerGroup
    readonly ready: Promise<void>
    readonly contextIds = new Set<string>()
    readonly #endpoint: WorkerEndpoint
    readonly #events: HostEvents
    readonly #controls = new Map<string, {
        resolve: (message: WorkerControlOutboundMessage) => void
        reject: (reason: unknown) => void
    }>()
    readonly #controlWaiters: (() => void)[] = []
    readonly #messageListener: (event: MessageEvent<unknown> | ErrorEvent) => void
    readonly #errorListener: (event: MessageEvent<unknown> | ErrorEvent) => void
    readonly #messageErrorListener: (event: MessageEvent<unknown> | ErrorEvent) => void
    #readyResolve!: () => void
    #readyReject!: (reason: unknown) => void
    #readySettled = false
    #readySucceeded = false
    #controlBusy = false
    #controlReservations = 0
    #activeTask: TaskRecord | undefined
    terminated = false

    constructor(
        id: string,
        group: WorkerGroup,
        endpoint: WorkerEndpoint,
        events: HostEvents
    ) {

        this.id = id
        this.group = group
        this.#endpoint = endpoint
        this.#events = events
        this.ready = new Promise<void>((resolve, reject) => {
            this.#readyResolve = resolve
            this.#readyReject = reject
        })
        this.#messageListener = event => {
            if ('data' in event) this.#receive(event.data as WorkerOutboundMessage)
        }
        this.#errorListener = event => {
            if ('preventDefault' in event) event.preventDefault()
            const error = 'error' in event && event.error instanceof Error ? event.error : undefined
            this.#fail({
                name: error?.name ?? 'WorkerError',
                message: 'message' in event ? event.message : 'Worker host failed.',
                ...(error?.stack === undefined ? {} : { stack: error.stack }),
            })
        }
        this.#messageErrorListener = () => this.#fail({
            name: 'DataCloneError',
            message: 'Worker host emitted a message deserialization error.',
            code: 'WORKER_TRANSFER_INVALID',
        })
        endpoint.addEventListener('message', this.#messageListener)
        endpoint.addEventListener('error', this.#errorListener)
        endpoint.addEventListener('messageerror', this.#messageErrorListener)
        const modules = group.options.modules.map(module => Object.freeze({
            id: module.id,
            version: module.version,
            url: module.url.href,
        }))
        try {
            endpoint.postMessage(Object.freeze({
                kind: 'initialize',
                hostId: id,
                groupId: group.id,
                modules: Object.freeze(modules),
            }))
        } catch (error) {
            this.#fail({ name: 'WorkerError', message: String(error) })
        }
    }

    get dispatchable(): boolean {

        return !this.terminated && this.#readySucceeded && this.#activeTask === undefined &&
            !this.#controlBusy && this.#controlReservations === 0
    }

    get initialized(): boolean {

        return this.#readySucceeded
    }

    get activeTask(): TaskRecord | undefined {

        return this.#activeTask
    }

    dispatch(record: TaskRecord): void {

        if (!this.dispatchable) throw new TypeError(`Worker host ${this.id} is not dispatchable.`)
        this.#activeTask = record
        const task = {
            id: record.id,
            groupId: this.group.id,
            moduleId: record.module.id,
            moduleVersion: record.module.version,
            operation: record.operation,
            input: record.input,
            ...(record.contextId === undefined ? {} : { contextId: record.contextId }),
            ...(record.generation === undefined ? {} : { generation: record.generation }),
        }
        try {
            this.#endpoint.postMessage({ kind: 'run', task }, record.transfer)
        } catch (error) {
            const message: WorkerTaskOutboundMessage = {
                kind: 'task-error',
                taskId: record.id,
                cancelled: false,
                error: {
                    name: error instanceof Error ? error.name : 'DataCloneError',
                    message: error instanceof Error ? error.message : String(error),
                    code: 'WORKER_TRANSFER_INVALID',
                },
            }
            this.#completeTask(message)
        }
    }

    cancel(taskId: string, reason?: unknown): void {

        if (this.terminated || this.#activeTask?.id !== taskId) return
        const message = reason === undefined
            ? { kind: 'cancel', taskId }
            : { kind: 'cancel', taskId, reason }
        this.#endpoint.postMessage(message)
    }

    async control(message: WorkerControlInboundMessage): Promise<WorkerControlOutboundMessage> {

        this.#controlReservations++
        await this.ready
        await new Promise<void>(resolve => {
            this.#controlWaiters.push(resolve)
            this.#drainControl()
        })
        try {
            const requestId = 'requestId' in message ? message.requestId : undefined
            if (requestId === undefined) throw new TypeError('Worker control message requires requestId.')
            return await new Promise<WorkerControlOutboundMessage>((resolve, reject) => {
                this.#controls.set(requestId, { resolve, reject })
                try {
                    this.#endpoint.postMessage(message)
                } catch (error) {
                    this.#controls.delete(requestId)
                    reject(error)
                }
            })
        } finally {
            this.#controlBusy = false
            this.#drainControl()
            if (this.dispatchable) this.#events.idle(this)
        }
    }

    terminate(reason?: unknown): void {

        if (this.terminated) return
        this.terminated = true
        this.#endpoint.removeEventListener('message', this.#messageListener)
        this.#endpoint.removeEventListener('error', this.#errorListener)
        this.#endpoint.removeEventListener('messageerror', this.#messageErrorListener)
        this.#endpoint.terminate()
        if (!this.#readySettled) {
            this.#readySettled = true
            this.#readyReject(reason ?? new Error(`Worker host ${this.id} terminated during initialization.`))
        }
        for (const control of this.#controls.values()) control.reject(reason)
        this.#controls.clear()
        this.#controlWaiters.splice(0).forEach(resolve => resolve())
    }

    #receive(message: WorkerOutboundMessage): void {

        if (this.terminated) return
        if (message.kind === 'ready') {
            if (!this.#readySettled) {
                this.#readySettled = true
                this.#readySucceeded = true
                this.#readyResolve()
                this.#events.idle(this)
            }
            return
        }
        if (message.kind === 'initialization-error') {
            const remote = message.error ?? { name: 'Error', message: 'Worker initialization failed.' }
            if (!this.#readySettled) {
                this.#readySettled = true
                this.#readyReject(new HostControlError(remote))
            }
            return
        }
        if ((message.kind === 'task-result' || message.kind === 'task-error') &&
            this.#activeTask?.id === message.taskId) {
            this.#completeTask(message)
            return
        }
        if ('requestId' in message) {
            const control = this.#controls.get(message.requestId)
            if (control === undefined) return
            this.#controls.delete(message.requestId)
            if (message.kind === 'control-error') {
                control.reject(new HostControlError(
                    message.error ?? { name: 'Error', message: 'Worker control failed.' }
                ))
            } else {
                control.resolve(message)
            }
        }
    }

    #completeTask(message: WorkerTaskOutboundMessage): void {

        const record = this.#activeTask
        if (record === undefined) return
        this.#activeTask = undefined
        this.#events.taskResult(this, record, message)
        this.#drainControl()
        if (this.dispatchable) this.#events.idle(this)
    }

    #drainControl(): void {

        if (this.terminated || this.#controlBusy || this.#activeTask !== undefined ||
            this.#controlWaiters.length === 0) return
        this.#controlBusy = true
        this.#controlReservations = Math.max(0, this.#controlReservations - 1)
        this.#controlWaiters.shift()!()
    }

    #fail(error: WorkerRemoteError): void {

        if (this.terminated) return
        this.#events.failed(this, error)
    }
}

class HostControlError extends Error {

    readonly remote: WorkerRemoteError

    constructor(remote: WorkerRemoteError) {

        super(remote.message)
        this.remote = remote
    }
}

function normalizePriority(
    input: Partial<WorkerTaskPriority> | undefined,
    fallback: WorkerTaskPriority = DEFAULT_PRIORITY
): WorkerTaskPriority {

    const priorityClass = input?.class ?? fallback.class
    const score = input?.score ?? fallback.score
    if (!(priorityClass in PRIORITY_RANK) || !Number.isFinite(score)) {
        throw descriptorError('WorkerTask', 'priority', 'Worker task priority is invalid.')
    }
    return Object.freeze({ class: priorityClass, score })
}

function effectivePriority(record: TaskRecord, agingIntervalMs: number) {

    const agePromotion = Math.floor(Math.max(0, now() - record.enqueuedAt) / agingIntervalMs)
    const deadlinePromotion = record.deadlineMs !== undefined && now() >= record.deadlineMs ? 2 : 0
    return {
        rank: Math.min(2, PRIORITY_RANK[record.priority.class] + agePromotion + deadlinePromotion),
        score: record.priority.score,
    }
}

function validateGroupOptions(
    options: WorkerGroupOptions,
    modules: readonly WorkerModuleDescriptor[]
): void {

    const ids = new Set<string>()
    const valid = typeof options.id === 'string' && options.id.length > 0 &&
        [ 'shared', 'group', 'task' ].includes(options.isolation) &&
        nonNegativeSafeInteger(options.size.min) && positiveSafeInteger(options.size.max) &&
        options.size.min <= options.size.max && positiveSafeInteger(options.maxQueuedTasks) &&
        positiveSafeInteger(options.maxActiveTasks) && options.maxActiveTasks <= options.size.max &&
        nonNegativeSafeInteger(options.idleTimeoutMs) && modules.length > 0 &&
        modules.every(module => {
            const accepted = typeof module.id === 'string' && module.id.length > 0 &&
                typeof module.version === 'string' && module.version.length > 0 &&
                module.url instanceof URL && !ids.has(module.id)
            ids.add(module.id)
            return accepted
        })
    if (!valid) throw descriptorError('WorkerGroup', options.id, 'Worker group descriptor is invalid.')
}

function validateTaskDescriptor<Input>(descriptor: WorkerTaskDescriptor<Input>): void {

    if (typeof descriptor.operation !== 'string' || descriptor.operation.length === 0 ||
        (descriptor.generation !== undefined && !nonNegativeSafeInteger(descriptor.generation)) ||
        (descriptor.staleKey !== undefined && (descriptor.staleKey.length === 0 || descriptor.generation === undefined)) ||
        (descriptor.deadlineMs !== undefined && !Number.isFinite(descriptor.deadlineMs)) ||
        (descriptor.cancellation !== undefined &&
            ![ 'cooperative', 'non-cooperative', 'hard' ].includes(descriptor.cancellation))) {
        throw descriptorError('WorkerTask', descriptor.operation, 'Worker task descriptor is invalid.')
    }
    const seen = new Set<Transferable>()
    for (const transferable of descriptor.transfer ?? []) {
        if (seen.has(transferable)) {
            throw workerDiagnosticError({
                code: 'WORKER_TRANSFER_INVALID',
                severity: 'error',
                phase: 'worker-transfer',
                subject: { kind: 'WorkerTask', id: descriptor.operation },
                message: 'Worker task transfer list contains duplicate ownership entries.',
                retriable: false,
            })
        }
        seen.add(transferable)
    }
}

function freezeGroupOptions(
    options: WorkerGroupOptions,
    modules: readonly WorkerModuleDescriptor[]
): ResolvedWorkerGroupOptions {

    return Object.freeze({
        ...options,
        modules: Object.freeze(modules.map(freezeModule)),
        size: Object.freeze({ ...options.size }),
    })
}

function freezeModule(module: WorkerModuleDescriptor): WorkerModuleDescriptor {

    return Object.freeze({ id: module.id, version: module.version, url: new URL(module.url.href) })
}

function captureModuleResolver(
    resolver: WorkerModuleResolver | undefined,
    systemId: string
): WorkerModuleResolver | undefined {

    if (resolver === undefined) return undefined
    const resolve = resolver?.resolve
    if (typeof resolve !== 'function') {
        throw descriptorError(
            'WorkerSystem',
            systemId,
            'Worker module resolver must provide resolve(contract).',
            { resolve: 'function' },
            resolver
        )
    }
    return Object.freeze({
        resolve: (contract: WorkerModuleContract) => resolve.call(resolver, contract),
    })
}

function taskFacts(record: TaskRecord): WorkerTaskFacts {

    return Object.freeze({
        id: record.id,
        groupId: record.group.id,
        moduleId: record.module.id,
        moduleVersion: record.module.version,
        operation: record.operation,
        enqueueSequence: record.enqueueSequence,
        state: record.state,
        priority: record.priority,
        cancellation: record.cancellation,
        enqueuedAt: record.enqueuedAt,
        ...(record.cancellationKind === undefined ? {} : { cancellationKind: record.cancellationKind }),
        ...(record.workerId === undefined ? {} : { workerId: record.workerId }),
        ...(record.generation === undefined ? {} : { generation: record.generation }),
        ...(record.staleKey === undefined ? {} : { staleKey: record.staleKey }),
        ...(record.deadlineMs === undefined ? {} : { deadlineMs: record.deadlineMs }),
        ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
        ...(record.completedAt === undefined ? {} : { completedAt: record.completedAt }),
    })
}

function taskCancellationError(
    record: TaskRecord,
    kind: 'queued' | 'cooperative',
    reason?: unknown
): WorkerFailure {

    return workerDiagnosticError({
        code: 'WORKER_TASK_CANCELLED',
        severity: 'error',
        phase: 'worker-task',
        subject: { kind: 'WorkerTask', id: record.id },
        message: reason === undefined ? `Worker task ${record.id} was cancelled.` : String(reason),
        groupId: record.group.id,
        moduleId: record.module.id,
        moduleVersion: record.module.version,
        operation: record.operation,
        taskId: record.id,
        cancellationKind: kind,
        retriable: true,
        ...(record.worker === undefined ? {} : { workerId: record.worker.id }),
    })
}

function taskStaleError(record: TaskRecord): WorkerFailure {

    const latestGeneration = record.staleKey === undefined
        ? undefined
        : record.group.latestGeneration(record.staleKey)
    return workerDiagnosticError({
        code: 'WORKER_TASK_STALE',
        severity: 'error',
        phase: 'worker-task',
        subject: { kind: 'WorkerTask', id: record.id },
        message: `Worker task ${record.id} belongs to an obsolete generation.`,
        actual: record.generation === undefined ? {} : { generation: record.generation },
        ...(record.staleKey === undefined ? {} : { expected: {
            staleKey: record.staleKey,
            ...(latestGeneration === undefined ? {} : { generation: latestGeneration }),
        } }),
        groupId: record.group.id,
        moduleId: record.module.id,
        moduleVersion: record.module.version,
        operation: record.operation,
        taskId: record.id,
        cancellationKind: 'stale',
        retriable: false,
        ...(record.worker === undefined ? {} : { workerId: record.worker.id }),
    })
}

function taskTerminationError(
    record: TaskRecord,
    kind: 'hard',
    reason?: unknown,
    remote?: WorkerRemoteError
): WorkerFailure {

    return workerDiagnosticError({
        code: 'WORKER_TERMINATED',
        severity: 'error',
        phase: 'worker-task',
        subject: { kind: 'WorkerTask', id: record.id },
        message: reason === undefined ? `Worker host for task ${record.id} was terminated.` : String(reason),
        groupId: record.group.id,
        moduleId: record.module.id,
        moduleVersion: record.module.version,
        operation: record.operation,
        taskId: record.id,
        cancellationKind: kind,
        retriable: true,
        ...(remote === undefined ? {} : { actual: remoteFacts(remote) }),
        ...(record.worker === undefined ? {} : { workerId: record.worker.id }),
        ...(remote?.stack === undefined ? {} : { remoteStack: remote.stack }),
    }, remote)
}

function groupDisposedError(groupId: string, record?: TaskRecord): WorkerFailure {

    return workerDiagnosticError({
        code: 'WORKER_GROUP_DISPOSED',
        severity: 'error',
        phase: 'worker-group',
        subject: { kind: 'WorkerGroup', id: groupId },
        message: `Worker group ${groupId} is disposed.`,
        groupId,
        ...(record === undefined ? {} : {
            moduleId: record.module.id,
            moduleVersion: record.module.version,
            operation: record.operation,
            taskId: record.id,
        }),
        retriable: false,
    })
}

function contextLostError(
    groupId: string,
    workerId: string,
    moduleId: string,
    contextId: string
): WorkerFailure {

    return workerDiagnosticError({
        code: 'WORKER_CONTEXT_LOST',
        severity: 'error',
        phase: 'worker-context',
        subject: { kind: 'WorkerContext', id: contextId },
        message: `Worker context ${contextId} was lost with host ${workerId}.`,
        groupId,
        workerId,
        moduleId,
        retriable: true,
    })
}

function unexpectedControlResponse(
    groupId: string,
    workerId: string,
    expectedKind: string,
    actualKind: string
): WorkerFailure {

    return workerDiagnosticError({
        code: 'WORKER_TRANSFER_INVALID',
        severity: 'error',
        phase: 'worker-transfer',
        subject: { kind: 'WorkerHost', id: workerId },
        message: `Worker host ${workerId} returned an unexpected control response.`,
        expected: { kind: expectedKind },
        actual: { kind: actualKind },
        groupId,
        workerId,
        retriable: false,
    })
}

function remoteDiagnosticError(input: Readonly<{
    group: WorkerGroup
    host: WorkerHost
    remote: WorkerRemoteError
    phase: 'worker-task' | 'worker-context'
    subject: Readonly<{ kind: 'WorkerTask' | 'WorkerContext', id: string }>
    record?: TaskRecord
}>): WorkerFailure {

    const code = WORKER_CODES.has(input.remote.code ?? '')
        ? input.remote.code as WorkerDiagnosticCode
        : input.phase === 'worker-task' ? 'WORKER_TASK_FAILED' : 'WORKER_CONTEXT_LOST'
    return workerDiagnosticError({
        code,
        severity: 'error',
        phase: input.phase,
        subject: input.subject,
        message: input.remote.message,
        actual: remoteFacts(input.remote),
        groupId: input.group.id,
        workerId: input.host.id,
        retriable: code === 'WORKER_TERMINATED' || code === 'WORKER_CONTEXT_LOST',
        ...(input.record === undefined ? {} : {
            moduleId: input.record.module.id,
            moduleVersion: input.record.module.version,
            operation: input.record.operation,
            taskId: input.record.id,
        }),
        ...(input.remote.stack === undefined ? {} : { remoteStack: input.remote.stack }),
    }, input.remote)
}

function remoteFacts(remote: WorkerRemoteError): WorkerRemoteErrorFacts {

    return Object.freeze({
        remoteName: remote.name,
        remoteMessage: remote.message,
        ...(remote.code === undefined ? {} : { remoteCode: remote.code }),
    })
}

function descriptorError(
    kind: 'WorkerSystem' | 'WorkerGroup' | 'WorkerTask',
    id: string,
    message: string,
    expected?: unknown,
    actual?: unknown
): WorkerFailure {

    return workerDiagnosticError({
        code: 'WORKER_DESCRIPTOR_INVALID',
        severity: 'error',
        phase: kind === 'WorkerTask' ? 'worker-task' : kind === 'WorkerGroup' ? 'worker-group' : 'worker-system',
        subject: { kind, id },
        message,
        ...(expected === undefined ? {} : { expected }),
        ...(actual === undefined ? {} : { actual }),
        retriable: false,
    })
}

function serializeUnknownError(error: unknown): Readonly<{ name: string, message: string }> {

    return Object.freeze({
        name: error instanceof Error ? error.name : 'Error',
        message: error instanceof Error ? error.message : String(error),
    })
}

function isTerminal(state: WorkerTaskState): boolean {

    return state === 'succeeded' || state === 'failed' || state === 'cancelled' ||
        state === 'stale' || state === 'terminated'
}

function releaseTaskInputs(record: TaskRecord): void {

    record.input = undefined
    record.transfer = EMPTY_TRANSFER
    delete record.worker
}

function positiveInteger(value: number, name: string): number {

    if (!positiveSafeInteger(value)) throw new TypeError(`${name} must be a positive integer.`)
    return value
}

function nonNegativeInteger(value: number, name: string): number {

    if (!nonNegativeSafeInteger(value)) throw new TypeError(`${name} must be a non-negative integer.`)
    return value
}

function positiveSafeInteger(value: unknown): value is number {

    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function nonNegativeSafeInteger(value: unknown): value is number {

    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function defaultWorkerCount(): number {

    const concurrency = typeof navigator === 'undefined' ? 4 : navigator.hardwareConcurrency || 4
    return Math.max(1, Math.min(concurrency, 4))
}

function defaultWorkerFactory(
    url: URL,
    options: Readonly<{ type: 'module', name: string }>
): WorkerEndpoint {

    if (typeof Worker === 'undefined') {
        throw new TypeError('Worker is unavailable; provide an explicit workerFactory for this environment.')
    }
    return new Worker(url, options)
}

function now(): number {

    return typeof performance === 'undefined' ? Date.now() : performance.now()
}
