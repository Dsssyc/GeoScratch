import { workerDiagnosticError } from './diagnostics.js'
import type {
    WorkerTaskPriority,
    WorkerTaskPriorityClass,
} from './worker-system.js'

export type TaskPhaseBudgetDescriptor<Phase extends string> = Readonly<{
    id: string
    limits: Readonly<Record<Phase, number>>
    maxQueuedTasks: number
}>

export type TaskPhaseBudgetLaneFacts = Readonly<{
    limit: number
    activeCount: number
    queuedCount: number
    maxActiveCount: number
    maxQueuedCount: number
}>

export type TaskPhaseBudgetFacts<Phase extends string> = Readonly<{
    kind: 'task-phase-budget'
    id: string
    disposed: boolean
    maxQueuedTasks: number
    lanes: Readonly<Record<Phase, TaskPhaseBudgetLaneFacts>>
}>

export type TaskPhasePermit = Readonly<{
    release(): void
}>

export type TaskPhasePermitRequest<Phase extends string> = Readonly<{
    result: Promise<TaskPhasePermit>
    cancel(reason?: unknown): boolean
    reprioritize(priority: Partial<WorkerTaskPriority>): boolean
    inspect(): Readonly<{
        phase: Phase
        state: 'queued' | 'active' | 'cancelled' | 'released'
    }>
}>

type PermitState = 'queued' | 'active' | 'cancelled' | 'released'

type PermitRecord<Phase extends string> = {
    sequence: number
    phase: Phase
    priority: WorkerTaskPriority
    state: PermitState
    resolve: (permit: TaskPhasePermit) => void
    reject: (reason: unknown) => void
}

type Lane<Phase extends string> = {
    limit: number
    activeCount: number
    maxActiveCount: number
    maxQueuedCount: number
    queue: PermitRecord<Phase>[]
}

const PRIORITY_RANK: Readonly<Record<WorkerTaskPriorityClass, number>> = Object.freeze({
    background: 0,
    'user-visible': 1,
    critical: 2,
})

/** Enforces independent prioritized concurrency limits for named phases of asynchronous tasks. */
export class TaskPhaseBudget<Phase extends string> {

    readonly kind = 'task-phase-budget' as const
    readonly id: string
    readonly maxQueuedTasks: number
    readonly #phaseKeys: readonly Phase[]
    readonly #lanes = new Map<Phase, Lane<Phase>>()
    #disposed = false
    #sequence = 0
    #disposePromise: Promise<void> | undefined
    #resolveDispose: (() => void) | undefined

    constructor(descriptor: TaskPhaseBudgetDescriptor<Phase>) {

        const id = descriptor?.id
        const limitEntries = descriptor?.limits === null ||
            typeof descriptor?.limits !== 'object'
            ? []
            : Object.entries(descriptor.limits) as [Phase, number][]
        if (typeof id !== 'string' || id.length === 0 || limitEntries.length === 0 ||
            !positiveSafeInteger(descriptor.maxQueuedTasks) ||
            limitEntries.some(([ phase, limit ]) =>
                phase.length === 0 || !positiveSafeInteger(limit)
            )) {
            throw phaseBudgetError(
                'WORKER_DESCRIPTOR_INVALID',
                typeof id === 'string' && id.length > 0 ? id : 'invalid-task-phase-budget',
                'A task phase budget requires an id, at least one named phase, and positive bounded capacities.',
                {
                    id: 'non-empty string',
                    limits: 'non-empty record of positive safe integers',
                    maxQueuedTasks: 'positive safe integer',
                },
                descriptor
            )
        }
        this.id = id
        this.maxQueuedTasks = descriptor.maxQueuedTasks
        this.#phaseKeys = Object.freeze(limitEntries.map(([ phase ]) => phase))
        for (const [ phase, limit ] of limitEntries) this.#lanes.set(phase, lane(limit))
    }

    acquire(
        phase: Phase,
        priority: WorkerTaskPriority
    ): TaskPhasePermitRequest<Phase> {

        if (this.#disposed) {
            throw phaseBudgetError(
                'WORKER_GROUP_DISPOSED',
                this.id,
                'A disposed task phase budget cannot acquire another permit.',
                { disposed: false },
                { disposed: true, phase }
            )
        }
        const target = this.#lanes.get(phase)
        if (target === undefined) {
            throw phaseBudgetError(
                'WORKER_DESCRIPTOR_INVALID',
                this.id,
                'The requested phase is not declared by this task phase budget.',
                { phases: this.#phaseKeys },
                { phase }
            )
        }
        const normalizedPriority = normalizePriority(this.id, priority)
        if (target.activeCount >= target.limit && target.queue.length >= this.maxQueuedTasks) {
            throw phaseBudgetError(
                'WORKER_QUEUE_SATURATED',
                this.id,
                'The task phase queue reached its configured capacity.',
                { maximumQueuedTasks: this.maxQueuedTasks },
                { phase, queuedTasks: target.queue.length }
            )
        }
        let resolveResult!: (permit: TaskPhasePermit) => void
        let rejectResult!: (reason: unknown) => void
        const result = new Promise<TaskPhasePermit>((resolve, reject) => {
            resolveResult = resolve
            rejectResult = reject
        })
        const record: PermitRecord<Phase> = {
            sequence: ++this.#sequence,
            phase,
            priority: normalizedPriority,
            state: 'queued',
            resolve: resolveResult,
            reject: rejectResult,
        }
        target.queue.push(record)
        this.#pump(target)
        target.maxQueuedCount = Math.max(target.maxQueuedCount, target.queue.length)
        return Object.freeze({
            result,
            cancel: reason => this.#cancel(record, reason),
            reprioritize: next => this.#reprioritize(record, next),
            inspect: () => Object.freeze({ phase: record.phase, state: record.state }),
        })
    }

    inspect(): TaskPhaseBudgetFacts<Phase> {

        const entries = this.#phaseKeys.map(phase => [
            phase,
            laneFacts(this.#lanes.get(phase)!),
        ] as const)
        return Object.freeze({
            kind: this.kind,
            id: this.id,
            disposed: this.#disposed,
            maxQueuedTasks: this.maxQueuedTasks,
            lanes: Object.freeze(Object.fromEntries(entries)) as Readonly<
                Record<Phase, TaskPhaseBudgetLaneFacts>
            >,
        })
    }

    dispose(): Promise<void> {

        if (this.#disposePromise !== undefined) return this.#disposePromise
        this.#disposed = true
        for (const target of this.#lanes.values()) {
            for (const record of target.queue.splice(0)) {
                record.state = 'cancelled'
                record.reject(abortError('Task phase budget disposed'))
            }
        }
        if (this.#activeCount() === 0) {
            this.#disposePromise = Promise.resolve()
        } else {
            this.#disposePromise = new Promise(resolve => {
                this.#resolveDispose = resolve
            })
        }
        return this.#disposePromise
    }

    #pump(target: Lane<Phase>): void {

        if (this.#disposed) return
        target.queue.sort(compareRecords)
        while (target.activeCount < target.limit && target.queue.length > 0) {
            const record = target.queue.shift()!
            if (record.state !== 'queued') continue
            record.state = 'active'
            target.activeCount++
            target.maxActiveCount = Math.max(target.maxActiveCount, target.activeCount)
            let released = false
            record.resolve(Object.freeze({
                release: () => {
                    if (released) return
                    released = true
                    record.state = 'released'
                    target.activeCount--
                    this.#pump(target)
                    this.#settleDispose()
                },
            }))
        }
    }

    #cancel(record: PermitRecord<Phase>, reason?: unknown): boolean {

        if (record.state !== 'queued') return false
        const target = this.#lanes.get(record.phase)!
        const index = target.queue.indexOf(record)
        if (index >= 0) target.queue.splice(index, 1)
        record.state = 'cancelled'
        record.reject(abortError(reason))
        return true
    }

    #reprioritize(
        record: PermitRecord<Phase>,
        priority: Partial<WorkerTaskPriority>
    ): boolean {

        if (record.state !== 'queued') return false
        record.priority = normalizePriority(this.id, priority, record.priority)
        this.#lanes.get(record.phase)!.queue.sort(compareRecords)
        return true
    }

    #activeCount(): number {

        let active = 0
        for (const target of this.#lanes.values()) active += target.activeCount
        return active
    }

    #settleDispose(): void {

        if (!this.#disposed || this.#activeCount() !== 0) return
        this.#resolveDispose?.()
        this.#resolveDispose = undefined
    }
}

function lane<Phase extends string>(limit: number): Lane<Phase> {

    return {
        limit,
        activeCount: 0,
        maxActiveCount: 0,
        maxQueuedCount: 0,
        queue: [],
    }
}

function laneFacts<Phase extends string>(value: Lane<Phase>): TaskPhaseBudgetLaneFacts {

    return Object.freeze({
        limit: value.limit,
        activeCount: value.activeCount,
        queuedCount: value.queue.length,
        maxActiveCount: value.maxActiveCount,
        maxQueuedCount: value.maxQueuedCount,
    })
}

function normalizePriority(
    id: string,
    input: Partial<WorkerTaskPriority>,
    fallback: WorkerTaskPriority = Object.freeze({ class: 'user-visible', score: 0 })
): WorkerTaskPriority {

    const priorityClass = input.class ?? fallback.class
    const score = input.score ?? fallback.score
    if (!(priorityClass in PRIORITY_RANK) || !Number.isFinite(score)) {
        throw phaseBudgetError(
            'WORKER_DESCRIPTOR_INVALID',
            id,
            'A task phase permit requires a finite known Worker priority.',
            { classes: Object.keys(PRIORITY_RANK), score: 'finite number' },
            input
        )
    }
    return Object.freeze({ class: priorityClass, score })
}

function compareRecords<Phase extends string>(
    left: PermitRecord<Phase>,
    right: PermitRecord<Phase>
): number {

    return PRIORITY_RANK[right.priority.class] - PRIORITY_RANK[left.priority.class] ||
        right.priority.score - left.priority.score ||
        left.sequence - right.sequence
}

function phaseBudgetError(
    code: 'WORKER_DESCRIPTOR_INVALID' | 'WORKER_QUEUE_SATURATED' | 'WORKER_GROUP_DISPOSED',
    id: string,
    message: string,
    expected: unknown,
    actual: unknown
) {

    return workerDiagnosticError({
        code,
        severity: 'error',
        phase: 'worker-task',
        subject: { kind: 'TaskPhaseBudget', id },
        message,
        expected,
        actual,
    })
}

function abortError(reason?: unknown): Error {

    const error = new Error(reason === undefined ? 'Task phase request cancelled' : String(reason))
    error.name = 'AbortError'
    return error
}

function positiveSafeInteger(value: number): boolean {

    return Number.isSafeInteger(value) && value > 0
}
