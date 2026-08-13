import {
    TaskPhaseBudget,
    WorkerContextPool,
    WorkerSystem,
    type TaskPhaseBudgetFacts,
    type TaskPhasePermit,
    type TaskPhasePermitRequest,
    type WorkerGroupFacts,
    type WorkerContextPoolFacts,
    type WorkerContextPoolSystem,
    type WorkerContextProtocol,
    type WorkerModuleReference,
    type WorkerModuleProtocol,
    type WorkerNoOperations,
    type WorkerOperationProtocol,
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

export type VirtualRasterWorkerProtocol<
    Candidate extends VirtualRasterWorkerCandidate,
    WorkerFacts,
    FetchResult = unknown,
> = Readonly<{
    lookup: WorkerOperationProtocol<Candidate, VirtualRasterWorkerLookupResult>
    fetch: WorkerOperationProtocol<Candidate, FetchResult>
    decode: WorkerOperationProtocol<
        Readonly<{ candidateId: string }>,
        VirtualRasterPageTransfer
    >
    transfer: WorkerOperationProtocol<
        Readonly<{ candidateId: string }>,
        VirtualRasterPageTransfer
    >
    accept: WorkerOperationProtocol<Readonly<{ candidateId: string }>, WorkerFacts>
    discard: WorkerOperationProtocol<Readonly<{ candidateId: string }>, WorkerFacts>
    facts: WorkerOperationProtocol<null, WorkerFacts>
}>

export type VirtualRasterWorkerModuleProtocol<
    Candidate extends VirtualRasterWorkerCandidate,
    Init,
    WorkerFacts,
    FetchResult = unknown,
> = WorkerModuleProtocol<
    WorkerNoOperations,
    WorkerContextProtocol<
        Init,
        VirtualRasterWorkerProtocol<Candidate, WorkerFacts, FetchResult>
    >
>

export type VirtualRasterWorkerExecutorDescriptor<
    Candidate extends VirtualRasterWorkerCandidate,
    Init,
    WorkerFacts,
> = Readonly<{
    id: string
    system: WorkerContextPoolSystem
    module: WorkerModuleReference
    workerCount: number
    maxRequests: number
    phaseLimits: Readonly<Record<VirtualRasterWorkerPhase, number>>
    context(index: number, count: number): VirtualRasterWorkerContextDescriptor<Init>
    candidate(demand: VirtualRasterPageDemand, sequence: number): Candidate
    staleKey?(candidate: Candidate): string
    classifyFailure?(
        error: unknown,
        candidate: Candidate
    ): VirtualRasterRequestFailureClassification | undefined
    idleTimeoutMs?: number
    disposeGraceMs?: number
}>

export type VirtualRasterWorkerExecutorFacts<WorkerFacts> = Readonly<{
    kind: 'virtual-raster-worker-executor'
    id: string
    disposed: boolean
    system: WorkerSystemFacts
    group: WorkerGroupFacts
    contextPool: WorkerContextPoolFacts
    workerFactsObservation: 'live' | 'last-observed-before-disposal'
    workers: readonly WorkerFacts[]
    phaseBudget: TaskPhaseBudgetFacts<VirtualRasterWorkerPhase>
}>

export type VirtualRasterWorkerExecutor<WorkerFacts> = VirtualRasterRequestExecutor & Readonly<{
    refreshFacts(): Promise<VirtualRasterWorkerExecutorFacts<WorkerFacts>>
    inspect(): VirtualRasterWorkerExecutorFacts<WorkerFacts>
    dispose(): Promise<void>
}>

type ExecutorState<WorkerFacts> = {
    disposed: boolean
    disposePromise?: Promise<void>
    workerFacts: WorkerFacts[]
    requestSequence: number
}

/** Adapts retained Scratch Worker contexts and phase budgets into raster page requests. */
export async function createVirtualRasterWorkerExecutor<
    Candidate extends VirtualRasterWorkerCandidate,
    Init,
    WorkerFacts,
>(
    descriptor: VirtualRasterWorkerExecutorDescriptor<Candidate, Init, WorkerFacts>
): Promise<VirtualRasterWorkerExecutor<WorkerFacts>> {

    validateDescriptor(descriptor)
    const phaseBudget = new TaskPhaseBudget<VirtualRasterWorkerPhase>({
        id: `${descriptor.id}.phases`,
        limits: descriptor.phaseLimits,
        maxQueuedTasks: descriptor.maxRequests,
    })
    type Operations = VirtualRasterWorkerProtocol<Candidate, WorkerFacts>
    let contextPool: WorkerContextPool<WorkerFacts, Operations> | undefined
    let workerFacts: WorkerFacts[]
    try {
        contextPool = await WorkerContextPool.create<Init, WorkerFacts, Operations>({
            id: descriptor.id,
            system: descriptor.system,
            module: descriptor.module,
            size: descriptor.workerCount,
            maxQueuedTasks: Math.max(16, descriptor.maxRequests * 4),
            maxActiveTasks: descriptor.workerCount,
            idleTimeoutMs: descriptor.idleTimeoutMs ?? 30_000,
            ...(descriptor.disposeGraceMs === undefined
                ? {}
                : { disposeGraceMs: descriptor.disposeGraceMs }),
            context: descriptor.context,
        })
        workerFacts = await Promise.all(Array.from(
            { length: descriptor.workerCount },
            (_value, index) => contextPool!.run(
                index,
                'facts',
                null,
                {
                    priority: { class: 'background', score: -1 },
                    cancellation: 'cooperative',
                }
            ).result
        ))
    } catch (error) {
        const cleanup = await Promise.allSettled([
            ...(contextPool === undefined ? [] : [ contextPool.dispose() ]),
            phaseBudget.dispose(),
        ])
        const cleanupFailures = cleanup
            .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
            .map(result => result.reason)
        if (cleanupFailures.length > 0) {
            throw new AggregateError(
                [ error, ...cleanupFailures ],
                `Virtual Raster Worker executor ${descriptor.id} initialization and cleanup failed`
            )
        }
        throw error
    }
    const activeContextPool = contextPool
    const state: ExecutorState<WorkerFacts> = {
        disposed: false,
        workerFacts,
        requestSequence: 0,
    }

    function inspect(): VirtualRasterWorkerExecutorFacts<WorkerFacts> {

        const poolFacts = activeContextPool.inspect()
        return Object.freeze({
            kind: 'virtual-raster-worker-executor',
            id: descriptor.id,
            disposed: state.disposed,
            system: poolFacts.system,
            group: poolFacts.group,
            contextPool: poolFacts,
            workerFactsObservation: state.disposed
                ? 'last-observed-before-disposal'
                : 'live',
            workers: Object.freeze([ ...state.workerFacts ]),
            phaseBudget: phaseBudget.inspect(),
        })
    }

    async function refreshFacts(): Promise<VirtualRasterWorkerExecutorFacts<WorkerFacts>> {

        if (!state.disposed) {
            state.workerFacts = await Promise.all(state.workerFacts.map((_facts, index) =>
                activeContextPool.run(index, 'facts', null, {
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
        try {
            await activeContextPool.dispose()
        } catch (error) {
            failures.push(error)
        }
        try {
            await phaseBudgetDisposal
        } catch (error) {
            failures.push(error)
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
            const contextIndex = stableShard(demand.page.key, state.workerFacts.length)
            const candidate = descriptor.candidate(demand, ++state.requestSequence)
            validateCandidate(descriptor.id, demand, candidate)
            return createExecution({
                id: descriptor.id,
                contextPool: activeContextPool,
                contextIndex,
                demand,
                candidate,
                phaseBudget,
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
    contextPool,
    contextIndex,
    demand,
    candidate,
    phaseBudget,
    staleKey,
    classifyFailure,
    updateFacts,
}: Readonly<{
    id: string
    contextPool: WorkerContextPool<
        WorkerFacts,
        VirtualRasterWorkerProtocol<Candidate, WorkerFacts>
    >
    contextIndex: number
    demand: VirtualRasterPageDemand
    candidate: Candidate
    phaseBudget: TaskPhaseBudget<VirtualRasterWorkerPhase>
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

    type Operations = VirtualRasterWorkerProtocol<Candidate, WorkerFacts>
    const run = async<Name extends keyof Operations & string>(
        operation: Name,
        input: Operations[Name]['input']
    ): Promise<Operations[Name]['output']> => {

        if (cancelled) throw cancelledError(candidate.page.key)
        const task = contextPool.run(contextIndex, operation, input, {
            priority,
            cancellation: 'cooperative',
            generation: demand.generation,
            staleKey,
            ...(demand.deadlineMs === undefined ? {} : { deadlineMs: demand.deadlineMs }),
        })
        currentTask = task as WorkerTaskHandle<unknown>
        return await task.result
    }

    const runPhase = async<Name extends 'fetch' | 'decode'>(
        nextPhase: VirtualRasterWorkerPhase,
        operation: Name,
        input: Operations[Name]['input']
    ): Promise<Operations[Name]['output']> => {

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
            return await run(operation, input)
        } finally {
            permit.release()
            phasePermit = undefined
            phaseRequest = undefined
        }
    }

    const result = (async(): Promise<VirtualRasterPageTransfer> => {

        try {
            const lookup = await run('lookup', candidate)
            validateLookup(id, candidate, lookup)
            let transfer: VirtualRasterPageTransfer
            if (lookup.status === 'miss') {
                await runPhase('network', 'fetch', candidate)
                transfer = await runPhase('decode', 'decode', {
                    candidateId: candidate.candidateId,
                })
            } else {
                transfer = await run('transfer', {
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
        settlementPromise = contextPool.run(
            contextIndex,
            kind,
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

function validateDescriptor<
    Candidate extends VirtualRasterWorkerCandidate,
    Init,
    WorkerFacts,
>(descriptor: VirtualRasterWorkerExecutorDescriptor<Candidate, Init, WorkerFacts>): void {

    const valid = typeof descriptor?.id === 'string' && descriptor.id.length > 0 &&
        validWorkerSystemOwnership(descriptor.system) &&
        typeof descriptor.module?.id === 'string' && descriptor.module.id.length > 0 &&
        typeof descriptor.module?.version === 'string' && descriptor.module.version.length > 0 &&
        positiveInteger(descriptor.workerCount) &&
        workerCountFitsSystem(descriptor.workerCount, descriptor.system) &&
        positiveInteger(descriptor.maxRequests) &&
        positiveInteger(descriptor.phaseLimits?.network) &&
        positiveInteger(descriptor.phaseLimits?.decode) &&
        typeof descriptor.context === 'function' &&
        typeof descriptor.candidate === 'function' &&
        (descriptor.idleTimeoutMs === undefined || positiveInteger(descriptor.idleTimeoutMs)) &&
        (descriptor.disposeGraceMs === undefined || positiveInteger(descriptor.disposeGraceMs))
    if (valid) return
    invalidExecutor(
        typeof descriptor?.id === 'string' && descriptor.id.length > 0
            ? descriptor.id
            : 'invalid-virtual-raster-worker-executor',
        'A Virtual Raster Worker executor requires explicit WorkerSystem ownership and finite worker, request, and phase budgets.',
        descriptor
    )
}

function workerCountFitsSystem(count: number, system: WorkerContextPoolSystem): boolean {

    if (system.ownership === 'borrowed') return count <= system.system.maxWorkers
    return system.options?.maxWorkers === undefined || count <= system.options.maxWorkers
}

function validWorkerSystemOwnership(system: WorkerContextPoolSystem | undefined): boolean {

    return system?.ownership === 'borrowed'
        ? system.system instanceof WorkerSystem
        : system?.ownership === 'owned' &&
            (system.options === undefined ||
                (typeof system.options === 'object' && system.options !== null))
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
