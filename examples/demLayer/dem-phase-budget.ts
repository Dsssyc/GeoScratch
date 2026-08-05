import type {
    WorkerTaskPriority,
    WorkerTaskPriorityClass,
} from 'geoscratch/worker'

export type DemWorkerPhase = 'network' | 'decode'

export type DemPhaseBudgetDescriptor = Readonly<{
    maxNetworkRequests: number
    maxDecodeTasks: number
    maxQueuedTasks: number
}>

export type DemPhaseBudgetLaneFacts = Readonly<{
    limit: number
    activeCount: number
    queuedCount: number
    maxActiveCount: number
    maxQueuedCount: number
}>

export type DemPhaseBudgetFacts = Readonly<{
    disposed: boolean
    network: DemPhaseBudgetLaneFacts
    decode: DemPhaseBudgetLaneFacts
}>

export type DemPhasePermit = Readonly<{
    release(): void
}>

export type DemPhasePermitRequest = Readonly<{
    result: Promise<DemPhasePermit>
    cancel(reason?: unknown): boolean
    reprioritize(priority: Partial<WorkerTaskPriority>): boolean
    inspect(): Readonly<{ phase: DemWorkerPhase, state: 'queued' | 'active' | 'cancelled' | 'released' }>
}>

type PermitState = 'queued' | 'active' | 'cancelled' | 'released'

type PermitRecord = {
    sequence: number
    phase: DemWorkerPhase
    priority: WorkerTaskPriority
    state: PermitState
    resolve: (permit: DemPhasePermit) => void
    reject: (reason: unknown) => void
}

type Lane = {
    limit: number
    activeCount: number
    maxActiveCount: number
    maxQueuedCount: number
    queue: PermitRecord[]
}

const PRIORITY_RANK: Readonly<Record<WorkerTaskPriorityClass, number>> = Object.freeze({
    background: 0,
    'user-visible': 1,
    critical: 2,
})

export class DemPhaseBudget {

    readonly maxQueuedTasks: number
    readonly #lanes: Record<DemWorkerPhase, Lane>
    #disposed = false
    #sequence = 0
    #disposePromise: Promise<void> | undefined
    #resolveDispose: (() => void) | undefined

    constructor(descriptor: DemPhaseBudgetDescriptor) {

        if (!positiveSafeInteger(descriptor.maxNetworkRequests) ||
            !positiveSafeInteger(descriptor.maxDecodeTasks) ||
            !positiveSafeInteger(descriptor.maxQueuedTasks)) {
            throw new TypeError('DEM phase budgets must be positive safe integers')
        }
        this.maxQueuedTasks = descriptor.maxQueuedTasks
        this.#lanes = {
            network: lane(descriptor.maxNetworkRequests),
            decode: lane(descriptor.maxDecodeTasks),
        }
    }

    acquire(
        phase: DemWorkerPhase,
        priority: WorkerTaskPriority
    ): DemPhasePermitRequest {

        if (this.#disposed) throw new Error('DEM phase budget is disposed')
        const target = this.#lanes[phase]
        if (target === undefined) throw new TypeError(`Unknown DEM worker phase: ${phase}`)
        const normalizedPriority = normalizePriority(priority)
        if (target.activeCount >= target.limit && target.queue.length >= this.maxQueuedTasks) {
            const error = new Error(`DEM ${phase} phase queue reached its configured capacity`) as Error & {
                code: string
            }
            error.code = 'DEM_PHASE_QUEUE_SATURATED'
            throw error
        }
        let resolveResult!: (permit: DemPhasePermit) => void
        let rejectResult!: (reason: unknown) => void
        const result = new Promise<DemPhasePermit>((resolve, reject) => {
            resolveResult = resolve
            rejectResult = reject
        })
        const record: PermitRecord = {
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

    inspect(): DemPhaseBudgetFacts {

        return Object.freeze({
            disposed: this.#disposed,
            network: laneFacts(this.#lanes.network),
            decode: laneFacts(this.#lanes.decode),
        })
    }

    dispose(): Promise<void> {

        if (this.#disposePromise !== undefined) return this.#disposePromise
        this.#disposed = true
        for (const target of Object.values(this.#lanes)) {
            for (const record of target.queue.splice(0)) {
                record.state = 'cancelled'
                record.reject(abortError('DEM phase budget disposed'))
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

    #pump(target: Lane): void {

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

    #cancel(record: PermitRecord, reason?: unknown): boolean {

        if (record.state !== 'queued') return false
        const target = this.#lanes[record.phase]
        const index = target.queue.indexOf(record)
        if (index >= 0) target.queue.splice(index, 1)
        record.state = 'cancelled'
        record.reject(abortError(reason))
        return true
    }

    #reprioritize(
        record: PermitRecord,
        priority: Partial<WorkerTaskPriority>
    ): boolean {

        if (record.state !== 'queued') return false
        record.priority = normalizePriority(priority, record.priority)
        this.#lanes[record.phase].queue.sort(compareRecords)
        return true
    }

    #activeCount(): number {

        return this.#lanes.network.activeCount + this.#lanes.decode.activeCount
    }

    #settleDispose(): void {

        if (!this.#disposed || this.#activeCount() !== 0) return
        this.#resolveDispose?.()
        this.#resolveDispose = undefined
    }
}

function lane(limit: number): Lane {

    return {
        limit,
        activeCount: 0,
        maxActiveCount: 0,
        maxQueuedCount: 0,
        queue: [],
    }
}

function laneFacts(value: Lane): DemPhaseBudgetLaneFacts {

    return Object.freeze({
        limit: value.limit,
        activeCount: value.activeCount,
        queuedCount: value.queue.length,
        maxActiveCount: value.maxActiveCount,
        maxQueuedCount: value.maxQueuedCount,
    })
}

function normalizePriority(
    input: Partial<WorkerTaskPriority>,
    fallback: WorkerTaskPriority = Object.freeze({ class: 'user-visible', score: 0 })
): WorkerTaskPriority {

    const priorityClass = input.class ?? fallback.class
    const score = input.score ?? fallback.score
    if (!(priorityClass in PRIORITY_RANK) || !Number.isFinite(score)) {
        throw new TypeError('DEM phase priority is invalid')
    }
    return Object.freeze({ class: priorityClass, score })
}

function compareRecords(left: PermitRecord, right: PermitRecord): number {

    return PRIORITY_RANK[right.priority.class] - PRIORITY_RANK[left.priority.class] ||
        right.priority.score - left.priority.score ||
        left.sequence - right.sequence
}

function abortError(reason?: unknown): Error {

    const error = new Error(reason === undefined ? 'DEM phase request cancelled' : String(reason))
    error.name = 'AbortError'
    return error
}

function positiveSafeInteger(value: number): boolean {

    return Number.isSafeInteger(value) && value > 0
}
