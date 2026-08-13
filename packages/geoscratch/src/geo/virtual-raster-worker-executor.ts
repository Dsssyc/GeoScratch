import {
    TaskPhaseBudget,
    WorkerSystem,
    type TaskPhaseBudgetFacts,
    type TaskPhasePermit,
    type TaskPhasePermitRequest,
    type WorkerContextHandle,
    type WorkerGroup,
    type WorkerGroupFacts,
    type WorkerModuleReference,
    type WorkerSystemFacts,
    type WorkerTaskHandle,
    type WorkerTaskPriority,
    type WorkerTaskState,
} from '../scratch/index.js'
import { throwGeoDiagnostic } from './diagnostics.js'
import type {
    VirtualRasterPageDemand,
    VirtualRasterRequestExecution,
    VirtualRasterRequestExecutor,
    VirtualRasterRequestFailureClassification,
} from './virtual-raster-demand.js'
import type { VirtualRasterPageIdentity } from './virtual-raster.js'
import type { VirtualRasterPageTransfer } from './virtual-raster-transfer.js'

export type VirtualRasterWorkerPhase = 'network' | 'decode'

export type VirtualRasterWorkerCandidate = Readonly<{
    candidateId: string
    page: VirtualRasterPageIdentity
}>

export type VirtualRasterWorkerLookupResult = Readonly<{
    status: 'hit' | 'miss'
    candidateId?: string
}>

export type VirtualRasterWorkerContextDescriptor<Init> = Readonly<{
    key: string
    init: Init
    restore?: unknown
}>

export type VirtualRasterWorkerOperationNames = Readonly<{
    lookup: string
    fetch: string
    decode: string
    transfer: string
    accept: string
    discard: string
    facts: string
}>

export type VirtualRasterWorkerExecutorDescriptor<
    Candidate extends VirtualRasterWorkerCandidate,
    Init,
    WorkerFacts,
> = Readonly<{
    id: string
    system: WorkerSystem
    module: WorkerModuleReference
    workerCount: number
    maxRequests: number
    phaseLimits: Readonly<Record<VirtualRasterWorkerPhase, number>>
    context(index: number, count: number): VirtualRasterWorkerContextDescriptor<Init>
    candidate(demand: VirtualRasterPageDemand, sequence: number): Candidate
    initialFacts(index: number): WorkerFacts
    operations?: Partial<VirtualRasterWorkerOperationNames>
    staleKey?(candidate: Candidate): string
    classifyFailure?(
        error: unknown,
        candidate: Candidate
    ): VirtualRasterRequestFailureClassification | undefined
    disposedFacts?(facts: WorkerFacts, index: number): WorkerFacts
    maxHistory?: number
    idleTimeoutMs?: number
}>

export type VirtualRasterWorkerExecutorFacts<WorkerFacts> = Readonly<{
    kind: 'virtual-raster-worker-executor'
    id: string
    disposed: boolean
    system: WorkerSystemFacts
    group: WorkerGroupFacts
    workers: readonly WorkerFacts[]
    phaseBudget: TaskPhaseBudgetFacts<VirtualRasterWorkerPhase>
}>

export type VirtualRasterWorkerExecutor<WorkerFacts> = VirtualRasterRequestExecutor & Readonly<{
    refreshFacts(): Promise<VirtualRasterWorkerExecutorFacts<WorkerFacts>>
    inspect(): VirtualRasterWorkerExecutorFacts<WorkerFacts>
    dispose(): Promise<void>
}>

type WorkerExecutorContext<WorkerFacts> = WorkerContextHandle<WorkerFacts>

type ExecutorState<WorkerFacts> = {
    disposed: boolean
    disposePromise?: Promise<void>
    workerFacts: WorkerFacts[]
    requestSequence: number
}

const DEFAULT_OPERATIONS: VirtualRasterWorkerOperationNames = Object.freeze({
    lookup: 'lookup',
    fetch: 'fetch',
    decode: 'decode',
    transfer: 'transfer',
    accept: 'accept',
    discard: 'discard',
    facts: 'facts',
})

/** Adapts retained Scratch Worker contexts and phase budgets into raster page requests. */
export async function createVirtualRasterWorkerExecutor<
    Candidate extends VirtualRasterWorkerCandidate,
    Init,
    WorkerFacts,
>(
    descriptor: VirtualRasterWorkerExecutorDescriptor<Candidate, Init, WorkerFacts>
): Promise<VirtualRasterWorkerExecutor<WorkerFacts>> {

    validateDescriptor(descriptor)
    const operations = normalizeOperations(descriptor.operations)
    const group = createWorkerGroup(descriptor)
    try {
        await group.ready
    } catch (error) {
        await group.dispose()
        throw error
    }
    const contexts: WorkerExecutorContext<WorkerFacts>[] = []
    try {
        for (let index = 0; index < descriptor.workerCount; index++) {
            const context = descriptor.context(index, descriptor.workerCount)
            validateContextDescriptor(descriptor.id, context, index)
            contexts.push(await group.openContext<Init, WorkerFacts>({
                module: descriptor.module.id,
                key: context.key,
                init: context.init,
                ...(context.restore === undefined ? {} : { restore: context.restore }),
            }))
        }
    } catch (error) {
        await group.dispose()
        throw error
    }
    const phaseBudget = new TaskPhaseBudget<VirtualRasterWorkerPhase>({
        id: `${descriptor.id}.phases`,
        limits: descriptor.phaseLimits,
        maxQueuedTasks: descriptor.maxRequests,
    })
    const state: ExecutorState<WorkerFacts> = {
        disposed: false,
        workerFacts: contexts.map((_context, index) => descriptor.initialFacts(index)),
        requestSequence: 0,
    }

    function inspect(): VirtualRasterWorkerExecutorFacts<WorkerFacts> {

        return Object.freeze({
            kind: 'virtual-raster-worker-executor',
            id: descriptor.id,
            disposed: state.disposed,
            system: descriptor.system.inspect(),
            group: group.inspect(),
            workers: Object.freeze([ ...state.workerFacts ]),
            phaseBudget: phaseBudget.inspect(),
        })
    }

    async function refreshFacts(): Promise<VirtualRasterWorkerExecutorFacts<WorkerFacts>> {

        if (!state.disposed) {
            state.workerFacts = await Promise.all(contexts.map(context =>
                context.run<null, WorkerFacts>(operations.facts, null, {
                    priority: { class: 'background', score: -1 },
                    cancellation: 'cooperative',
                }).result
            ))
        }
        return inspect()
    }

    async function disposeOnce(): Promise<void> {

        if (state.disposed) return
        state.disposed = true
        const failures: unknown[] = []
        const phaseBudgetDisposal = phaseBudget.dispose()
        const contextSettlements = await Promise.allSettled(
            contexts.map(context => context.dispose())
        )
        for (const settlement of contextSettlements) {
            if (settlement.status === 'rejected') failures.push(settlement.reason)
        }
        try {
            await group.dispose()
        } catch (error) {
            failures.push(error)
        }
        try {
            await phaseBudgetDisposal
        } catch (error) {
            failures.push(error)
        }
        if (descriptor.disposedFacts !== undefined) {
            state.workerFacts = state.workerFacts.map(descriptor.disposedFacts)
        }
        if (failures.length > 0) {
            throw new AggregateError(
                failures,
                `Virtual Raster Worker executor ${descriptor.id} disposal failed`
            )
        }
    }

    return Object.freeze({
        request(demand: VirtualRasterPageDemand) {

            if (state.disposed) {
                return invalidExecutor(
                    descriptor.id,
                    'A disposed Virtual Raster Worker executor cannot accept requests.',
                    { disposed: true, pageKey: demand?.page?.key }
                )
            }
            const contextIndex = stableShard(demand.page.key, contexts.length)
            const candidate = descriptor.candidate(demand, ++state.requestSequence)
            validateCandidate(descriptor.id, demand, candidate)
            return createExecution({
                id: descriptor.id,
                context: contexts[contextIndex]!,
                contextIndex,
                demand,
                candidate,
                phaseBudget,
                operations,
                staleKey: descriptor.staleKey?.(candidate) ?? candidate.page.key,
                ...(descriptor.classifyFailure === undefined
                    ? {}
                    : { classifyFailure: descriptor.classifyFailure }),
                updateFacts: facts => { state.workerFacts[contextIndex] = facts },
            })
        },
        refreshFacts,
        inspect,
        dispose() {

            state.disposePromise ??= disposeOnce()
            return state.disposePromise
        },
    })
}

function createExecution<Candidate extends VirtualRasterWorkerCandidate, WorkerFacts>({
    id,
    context,
    contextIndex,
    demand,
    candidate,
    phaseBudget,
    operations,
    staleKey,
    classifyFailure,
    updateFacts,
}: Readonly<{
    id: string
    context: WorkerExecutorContext<WorkerFacts>
    contextIndex: number
    demand: VirtualRasterPageDemand
    candidate: Candidate
    phaseBudget: TaskPhaseBudget<VirtualRasterWorkerPhase>
    operations: VirtualRasterWorkerOperationNames
    staleKey: string
    classifyFailure?: (
        error: unknown,
        candidate: Candidate
    ) => VirtualRasterRequestFailureClassification | undefined
    updateFacts(facts: WorkerFacts): void
}>): VirtualRasterRequestExecution {

    let currentTask: WorkerTaskHandle<unknown> | undefined
    let phaseRequest: TaskPhasePermitRequest<VirtualRasterWorkerPhase> | undefined
    let phasePermit: TaskPhasePermit | undefined
    let phase: 'cache' | VirtualRasterWorkerPhase = 'cache'
    let terminalState: WorkerTaskState = 'queued'
    let priority = demand.priority
    let cancelled = false
    let settlement: 'accept' | 'discard' | undefined
    let settlementPromise: Promise<void> | undefined

    const run = async<Input, Output>(operation: string, input: Input): Promise<Output> => {

        if (cancelled) throw cancelledError(candidate.page.key)
        const task = context.run<Input, Output>(operation, input, {
            priority,
            cancellation: 'cooperative',
            generation: demand.generation,
            staleKey,
            ...(demand.deadlineMs === undefined ? {} : { deadlineMs: demand.deadlineMs }),
        })
        currentTask = task as WorkerTaskHandle<unknown>
        return await task.result
    }

    const runPhase = async<Input, Output>(
        nextPhase: VirtualRasterWorkerPhase,
        operation: string,
        input: Input
    ): Promise<Output> => {

        phase = nextPhase
        currentTask = undefined
        const request = phaseBudget.acquire(nextPhase, priority)
        phaseRequest = request
        const permit = await request.result
        phasePermit = permit
        if (cancelled) {
            permit.release()
            phasePermit = undefined
            throw cancelledError(candidate.page.key)
        }
        try {
            return await run<Input, Output>(operation, input)
        } finally {
            permit.release()
            phasePermit = undefined
            phaseRequest = undefined
        }
    }

    const result = (async(): Promise<VirtualRasterPageTransfer> => {

        try {
            const lookup = await run<Candidate, VirtualRasterWorkerLookupResult>(
                operations.lookup,
                candidate
            )
            validateLookup(id, candidate, lookup)
            let transfer: VirtualRasterPageTransfer
            if (lookup.status === 'miss') {
                await runPhase<Candidate, unknown>('network', operations.fetch, candidate)
                transfer = await runPhase<
                    Readonly<{ candidateId: string }>,
                    VirtualRasterPageTransfer
                >('decode', operations.decode, { candidateId: candidate.candidateId })
            } else {
                transfer = await run<
                    Readonly<{ candidateId: string }>,
                    VirtualRasterPageTransfer
                >(operations.transfer, {
                    candidateId: lookup.candidateId ?? candidate.candidateId,
                })
            }
            terminalState = 'succeeded'
            return transfer
        } catch (error) {
            terminalState = currentTask?.inspect().state ?? (cancelled ? 'cancelled' : 'failed')
            throw error
        }
    })()

    function settle(kind: 'accept' | 'discard'): Promise<void> {

        if (settlementPromise !== undefined) {
            return settlement === kind
                ? settlementPromise
                : Promise.reject(new Error(
                    `Virtual Raster candidate ${candidate.candidateId} already settled as ${settlement}`
                ))
        }
        settlement = kind
        settlementPromise = context.run<Readonly<{ candidateId: string }>, WorkerFacts>(
            operations[kind],
            { candidateId: candidate.candidateId },
            {
                priority: { class: 'critical', score: Number.MAX_SAFE_INTEGER },
                cancellation: 'cooperative',
            }
        ).result.then(updateFacts)
        return settlementPromise
    }

    return Object.freeze({
        result,
        cancel(reason?: unknown) {

            cancelled = true
            const phaseCancelled = phaseRequest?.cancel(reason) ?? false
            const taskCancellation = currentTask?.cancel(reason) ?? 'none'
            if (taskCancellation !== 'none') return taskCancellation
            return phaseCancelled ? 'queued' : 'none'
        },
        reprioritize(next: Partial<WorkerTaskPriority>) {

            const phaseReprioritized = phaseRequest?.reprioritize(next) ?? false
            const taskReprioritized = currentTask?.reprioritize(next) ?? false
            priority = Object.freeze({
                class: next.class ?? priority.class,
                score: next.score ?? priority.score,
            })
            return phaseReprioritized || taskReprioritized
        },
        accept: () => settle('accept'),
        discard: () => settle('discard'),
        ...(classifyFailure === undefined ? {} : {
            classifyFailure: (error: unknown) => classifyFailure(error, candidate),
        }),
        inspect: () => Object.freeze({
            state: phaseRequest?.inspect().state === 'queued'
                ? 'queued'
                : currentTask?.inspect().state ?? (phasePermit === undefined
                    ? terminalState
                    : 'running'),
            phase,
            contextIndex,
        }),
    })
}

function createWorkerGroup<
    Candidate extends VirtualRasterWorkerCandidate,
    Init,
    WorkerFacts,
>(descriptor: VirtualRasterWorkerExecutorDescriptor<Candidate, Init, WorkerFacts>): WorkerGroup {

    return descriptor.system.createGroup({
        id: descriptor.id,
        modules: [ descriptor.module ],
        isolation: 'group',
        size: { min: descriptor.workerCount, max: descriptor.workerCount },
        maxQueuedTasks: Math.max(16, descriptor.maxRequests * 4),
        maxActiveTasks: descriptor.workerCount,
        idleTimeoutMs: descriptor.idleTimeoutMs ?? 30_000,
    })
}

function validateDescriptor<
    Candidate extends VirtualRasterWorkerCandidate,
    Init,
    WorkerFacts,
>(descriptor: VirtualRasterWorkerExecutorDescriptor<Candidate, Init, WorkerFacts>): void {

    const valid = typeof descriptor?.id === 'string' && descriptor.id.length > 0 &&
        descriptor.system instanceof WorkerSystem &&
        typeof descriptor.module?.id === 'string' && descriptor.module.id.length > 0 &&
        typeof descriptor.module?.version === 'string' && descriptor.module.version.length > 0 &&
        positiveInteger(descriptor.workerCount) &&
        descriptor.workerCount <= descriptor.system.maxWorkers &&
        positiveInteger(descriptor.maxRequests) &&
        positiveInteger(descriptor.phaseLimits?.network) &&
        positiveInteger(descriptor.phaseLimits?.decode) &&
        typeof descriptor.context === 'function' &&
        typeof descriptor.candidate === 'function' &&
        typeof descriptor.initialFacts === 'function' &&
        (descriptor.maxHistory === undefined || nonNegativeInteger(descriptor.maxHistory)) &&
        (descriptor.idleTimeoutMs === undefined || positiveInteger(descriptor.idleTimeoutMs))
    if (valid) return
    invalidExecutor(
        typeof descriptor?.id === 'string' && descriptor.id.length > 0
            ? descriptor.id
            : 'invalid-virtual-raster-worker-executor',
        'A Virtual Raster Worker executor requires one borrowed WorkerSystem and finite worker, request, and phase budgets.',
        descriptor
    )
}

function validateContextDescriptor<Init>(
    id: string,
    context: VirtualRasterWorkerContextDescriptor<Init>,
    index: number
): void {

    if (context !== null && typeof context === 'object' &&
        typeof context.key === 'string' && context.key.length > 0 &&
        'init' in context) return
    invalidExecutor(id, 'A Virtual Raster Worker context requires a key and init payload.', {
        index,
        context,
    })
}

function validateCandidate<Candidate extends VirtualRasterWorkerCandidate>(
    id: string,
    demand: VirtualRasterPageDemand,
    candidate: Candidate
): void {

    if (candidate !== null && typeof candidate === 'object' &&
        typeof candidate.candidateId === 'string' && candidate.candidateId.length > 0 &&
        candidate.page?.kind === 'virtual-raster-page' &&
        candidate.page.key === demand.page.key) return
    invalidExecutor(id, 'A Worker candidate must identify the exact demanded Virtual Raster page.', {
        demandedPageKey: demand.page.key,
        candidate,
    })
}

function validateLookup<Candidate extends VirtualRasterWorkerCandidate>(
    id: string,
    candidate: Candidate,
    lookup: VirtualRasterWorkerLookupResult
): void {

    if (lookup !== null && typeof lookup === 'object' &&
        (lookup.status === 'hit' || lookup.status === 'miss') &&
        (lookup.candidateId === undefined ||
            (typeof lookup.candidateId === 'string' && lookup.candidateId.length > 0))) return
    invalidExecutor(id, 'A Worker lookup must report a cache hit or miss.', {
        candidateId: candidate.candidateId,
        lookup,
    })
}

function normalizeOperations(
    operations: Partial<VirtualRasterWorkerOperationNames> | undefined
): VirtualRasterWorkerOperationNames {

    const result = { ...DEFAULT_OPERATIONS, ...operations }
    if (Object.values(result).every(value => typeof value === 'string' && value.length > 0)) {
        return Object.freeze(result)
    }
    return invalidExecutor(
        'invalid-virtual-raster-worker-operations',
        'Virtual Raster Worker operation names must be non-empty strings.',
        operations
    )
}

function stableShard(key: string, count: number): number {

    let hash = 0x811c9dc5
    for (let index = 0; index < key.length; index++) {
        hash ^= key.charCodeAt(index)
        hash = Math.imul(hash, 0x01000193)
    }
    return (hash >>> 0) % count
}

function cancelledError(pageKey: string): Error {

    const error = new Error(`Virtual Raster page ${pageKey} request was cancelled`)
    error.name = 'AbortError'
    return error
}

function invalidExecutor(id: string, message: string, actual: unknown): never {

    return throwGeoDiagnostic({
        code: 'GEO_VIRTUAL_RASTER_WORKER_EXECUTOR_INVALID',
        phase: 'source',
        subject: { kind: 'VirtualRasterWorkerExecutor', id },
        message,
        actual,
    })
}

function positiveInteger(value: unknown): value is number {

    return Number.isSafeInteger(value) && Number(value) > 0
}

function nonNegativeInteger(value: unknown): value is number {

    return Number.isSafeInteger(value) && Number(value) >= 0
}
