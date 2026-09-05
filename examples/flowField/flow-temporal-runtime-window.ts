import type {
    FlowFieldDataset,
    FlowFieldRuntimeSample,
    FlowFieldSampleAdjacency,
} from './flow-dataset.ts'
import type { FlowTimeSelection } from './flow-timeline.ts'

export type FlowTemporalDirection = -1 | 0 | 1

export type FlowTemporalRequestResult =
    | Readonly<{ status: 'ready', revision: number, pairGeneration: number }>
    | Readonly<{ status: 'gap', revision: number }>
    | Readonly<{ status: 'superseded', revision: number }>
    | Readonly<{ status: 'failed', revision: number, error: unknown }>
    | Readonly<{ status: 'disposed', revision: number }>

export type FlowTemporalRequestTicket = Readonly<{
    revision: number
    selection: FlowTimeSelection
    settled: Promise<FlowTemporalRequestResult>
}>

export type FlowTemporalRuntimeWindowSnapshot = Readonly<{
    kind: 'flow-temporal-runtime-window'
    state: 'loading' | 'ready' | 'gap' | 'failed' | 'disposed'
    requestedRevision: number
    pairGeneration: number
    direction: FlowTemporalDirection
    selection: FlowTimeSelection | undefined
    activeSampleKeys: readonly string[]
    candidateSampleKeys: readonly string[]
    prefetchSampleKey: string | undefined
    prefetchState: 'idle' | 'loading' | 'ready' | 'failed'
    prefetchFailure: unknown | undefined
    ownedRuntimeCount: number
    pendingCreationCount: number
    activeCaptureCount: number
    requestsStopped: boolean
    failureCode:
        | 'factory-unresponsive'
        | 'runtime-cleanup-failed'
        | 'runtime-failed'
        | undefined
    disposed: boolean
}>

export type FlowTemporalRuntimeWindowTermination =
    | Readonly<{
        status: 'fatal'
        failureCode: 'factory-unresponsive' | 'runtime-cleanup-failed'
        error: unknown
    }>
    | Readonly<{ status: 'stopped' }>

export type FlowTemporalReadyCapture<Runtime extends object> = Readonly<{
    state: 'ready'
    requestedRevision: number
    pairGeneration: number
    selection: Exclude<FlowTimeSelection, Readonly<{ kind: 'gap' }>>
    alpha: number
    lower: Readonly<{ sample: FlowFieldRuntimeSample, runtime: Runtime }>
    upper: Readonly<{ sample: FlowFieldRuntimeSample, runtime: Runtime }>
    release(): void
}>

/** Borrows one safety-ready lookahead runtime until submitted work has settled. */
export type FlowTemporalPrefetchCapture<Runtime extends object> = Readonly<{
    sample: FlowFieldRuntimeSample
    runtime: Runtime
    release(): void
}>

export type FlowTemporalRuntimeCapture<Runtime extends object> =
    | FlowTemporalReadyCapture<Runtime>
    | Readonly<{
        state: 'loading'
        requestedRevision: number
        selection: FlowTimeSelection | undefined
    }>
    | Readonly<{
        state: 'gap'
        requestedRevision: number
        selection: Extract<FlowTimeSelection, Readonly<{ kind: 'gap' }>>
    }>
    | Readonly<{
        state: 'failed'
        requestedRevision: number
        selection: FlowTimeSelection | undefined
        failureCode: 'factory-unresponsive' | 'runtime-cleanup-failed' | 'runtime-failed'
        error: unknown
    }>

export type FlowReadyRuntimeFactoryContext = Readonly<{
    signal: AbortSignal
    attemptId: string
}>

export type FlowTemporalRuntimeWindowOptions<Runtime extends object> = Readonly<{
    datasetIdentity: Readonly<{
        datasetId: string
        sourceHash: string
        contentVersion: string
    }>
    timeAxis: FlowFieldDataset['timeAxis']
    maxOwnedRuntimes: 4
    maxCreationSettleMs: number
    createReadyRuntime(
        sample: FlowFieldRuntimeSample,
        context: FlowReadyRuntimeFactoryContext
    ): Promise<Runtime>
    stopRuntimeRequests(runtime: Runtime): Promise<void>
    disposeRuntime(runtime: Runtime): Promise<void>
}>

export type FlowTemporalRuntimeWindow<Runtime extends object> = Readonly<{
    request(
        selection: FlowTimeSelection,
        direction: FlowTemporalDirection
    ): FlowTemporalRequestTicket
    termination: Promise<FlowTemporalRuntimeWindowTermination>
    prefetch(sample: FlowFieldRuntimeSample | undefined): void
    capturePrefetch(): FlowTemporalPrefetchCapture<Runtime> | undefined
    rejectPrefetch(runtime: Runtime, error: unknown): void
    snapshot(): FlowTemporalRuntimeWindowSnapshot
    capture(): FlowTemporalRuntimeCapture<Runtime>
    stopRequests(): Promise<void>
    dispose(): Promise<void>
}>

type Deferred<Value> = {
    promise: Promise<Value>
    resolve(value: Value): void
    settled: boolean
}

type TicketState = {
    public: FlowTemporalRequestTicket
    deferred: Deferred<FlowTemporalRequestResult>
}

type RuntimeLease<Runtime extends object> = {
    sample: FlowFieldRuntimeSample
    runtime: Runtime
    references: number
    reusable: boolean
    disposed: boolean
}

type RuntimePair<Runtime extends object> = {
    key: string
    selection: Exclude<FlowTimeSelection, Readonly<{ kind: 'gap' }>>
    leases: readonly RuntimeLease<Runtime>[]
    lower: RuntimeLease<Runtime>
    upper: RuntimeLease<Runtime>
    captures: number
    retiring: boolean
    released: boolean
}

type PairWork<Runtime extends object> = {
    id: number
    key: string
    revision: number
    direction: FlowTemporalDirection
    selection: Exclude<FlowTimeSelection, Readonly<{ kind: 'gap' }>>
    controller: AbortController
    promise: Promise<void>
    leases: RuntimeLease<Runtime>[]
    failure?: unknown
}

type NormalizedTimeAxis = Readonly<{
    samples: ReadonlyMap<string, FlowFieldRuntimeSample>
    adjacency: ReadonlyMap<string, FlowFieldSampleAdjacency>
}>

class FactoryUnresponsiveError extends Error {
    readonly code = 'factory-unresponsive'
}

/** Owns a latest-selection pair and optional lookahead within one four-runtime budget. */
export function createFlowTemporalRuntimeWindow<Runtime extends object>(
    options: FlowTemporalRuntimeWindowOptions<Runtime>
): FlowTemporalRuntimeWindow<Runtime> {

    const identity = normalizeDatasetIdentity(options?.datasetIdentity)
    const timeAxis = normalizeTimeAxis(options?.timeAxis)
    if (options?.maxOwnedRuntimes !== 4) {
        throw new TypeError('Flow temporal runtime maxOwnedRuntimes must be exactly 4')
    }
    if (!Number.isFinite(options.maxCreationSettleMs) ||
        options.maxCreationSettleMs <= 0) {
        throw new TypeError('Flow temporal runtime creation timeout must be positive')
    }
    if (typeof options.createReadyRuntime !== 'function' ||
        typeof options.stopRuntimeRequests !== 'function' ||
        typeof options.disposeRuntime !== 'function') {
        throw new TypeError('Flow temporal runtime window requires ownership callbacks')
    }

    const ownerId = `${identity.datasetId}:${identity.sourceHash}:${identity.contentVersion}`
    const leases = new Map<string, RuntimeLease<Runtime>>()
    const ownedRuntimes = new Set<Runtime>()
    const runtimeOwners = new WeakMap<Runtime, string>()
    const stopRuntimePromises = new WeakMap<Runtime, Promise<void>>()
    const disposalPromises = new WeakMap<Runtime, Promise<void>>()
    const retirements = new Set<Promise<void>>()
    const prefetchRetirements = new Set<Promise<void>>()
    const retiringPairs = new Set<RuntimePair<Runtime>>()
    const captureWaiters = new Set<Deferred<void>>()
    const capacityWaiters = new Set<Deferred<void>>()
    const lateSettlements = new Set<Promise<void>>()
    const backgroundFailures = new Set<unknown>()
    const termination = createDeferred<FlowTemporalRuntimeWindowTermination>()
    let requestedRevision = 0
    let pairGeneration = 0
    let workSequence = 0
    let attemptSequence = 0
    let direction: FlowTemporalDirection = 0
    let selection: FlowTimeSelection | undefined
    let state: FlowTemporalRuntimeWindowSnapshot['state'] = 'loading'
    let failure: Readonly<{
        code: 'factory-unresponsive' | 'runtime-cleanup-failed' | 'runtime-failed'
        error: unknown
    }> | undefined
    let active: RuntimePair<Runtime> | undefined
    let candidate: PairWork<Runtime> | undefined
    let prefetchSample: FlowFieldRuntimeSample | undefined
    let prefetchState: FlowTemporalRuntimeWindowSnapshot['prefetchState'] = 'idle'
    let prefetchFailure: unknown | undefined
    let prefetched: RuntimePair<Runtime> | undefined
    let prefetchWork: PairWork<Runtime> | undefined
    let prefetchPumpPromise: Promise<void> | undefined
    let latestTicket: TicketState | undefined
    let pumpPromise: Promise<void> | undefined
    let disposed = false
    let requestsStopped = false
    let stopRequestsPromise: Promise<void> | undefined
    let disposePromise: Promise<void> | undefined
    let pendingCreationCount = 0

    function request(
        requestedSelection: FlowTimeSelection,
        requestedDirection: FlowTemporalDirection
    ): FlowTemporalRequestTicket {

        assertRequestable()
        const acceptedSelection = validateSelection(requestedSelection, timeAxis)
        const acceptedDirection = normalizeDirection(requestedDirection)
        if (acceptedDirection !== direction) {
            clearPrefetch('Flow temporal direction changed', true)
        }
        settleTicket(latestTicket, 'superseded')
        const ticket = createTicket(++requestedRevision, acceptedSelection)
        latestTicket = ticket
        selection = acceptedSelection
        direction = acceptedDirection
        failure = undefined

        if (acceptedSelection.kind === 'gap') {
            state = 'gap'
            clearPrefetch('Flow temporal selection changed to a gap')
            cancelCandidate('Flow temporal selection changed to a gap')
            if (active !== undefined) {
                const retired = active
                active = undefined
                retirePair(retired)
            }
            settleTicket(ticket, 'gap')
            return ticket.public
        }

        const requestedPairKey = selectionPairKey(acceptedSelection)
        if (active?.key === requestedPairKey) {
            active.selection = acceptedSelection
            state = 'ready'
            cancelCandidate('Flow temporal selection returned to the active pair')
            if (prefetchSample === undefined) {
                clearPrefetch('Flow foreground no longer needs joined lookahead')
            } else {
                const joined = prefetchWork?.selection
                if (joined?.kind === 'exact' && joined.sample.sampleKey !== prefetchSample.sampleKey) {
                    prefetchWork!.controller.abort(new Error('Flow foreground abandoned joined lookahead'))
                }
                if (prefetched !== undefined && prefetched.lower.sample.sampleKey !== prefetchSample.sampleKey) {
                    retirePrefetched()
                }
            }
            settleTicket(ticket, 'ready')
            schedulePrefetchPump()
            return ticket.public
        }
        if (candidate?.key === requestedPairKey) {
            candidate.revision = requestedRevision
            candidate.direction = acceptedDirection
            candidate.selection = acceptedSelection
            state = 'loading'
            return ticket.public
        }

        state = 'loading'
        cancelCandidate('Flow temporal selection was superseded')
        const available = candidateSamples(acceptedSelection).map(sample =>
            leases.get(sample.sampleKey)
        )
        if (available.every(lease => lease !== undefined && lease.reusable && !lease.disposed)) {
            const acquired = available as RuntimeLease<Runtime>[]
            for (const lease of acquired) lease.references++
            activatePair(acceptedSelection, acquired)
            return ticket.public
        }
        if (prefetchSample === undefined || !candidateSamples(acceptedSelection)
            .some(sample => sample.sampleKey === prefetchSample?.sampleKey)) {
            clearPrefetch('Flow foreground selection takes priority over lookahead')
        }
        schedulePump()
        return ticket.public
    }

    function snapshot(): FlowTemporalRuntimeWindowSnapshot {

        return Object.freeze({
            kind: 'flow-temporal-runtime-window' as const,
            state,
            requestedRevision,
            pairGeneration,
            direction,
            selection,
            activeSampleKeys: Object.freeze(active === undefined
                ? []
                : active.leases.map(lease => lease.sample.sampleKey)),
            candidateSampleKeys: Object.freeze(candidate === undefined
                ? []
                : candidateSamples(candidate.selection).map(sample => sample.sampleKey)),
            prefetchSampleKey: prefetchSample?.sampleKey,
            prefetchState,
            prefetchFailure,
            ownedRuntimeCount: ownedRuntimes.size,
            pendingCreationCount,
            activeCaptureCount: (active?.captures ?? 0) + (prefetched?.captures ?? 0) + [ ...retiringPairs ]
                .reduce((count, pair) => count + pair.captures, 0),
            requestsStopped,
            failureCode: failure?.code,
            disposed,
        })
    }

    function capture(): FlowTemporalRuntimeCapture<Runtime> {

        if (disposed) throw new Error('Flow temporal runtime window is disposed')
        if (state === 'gap' && selection?.kind === 'gap') {
            return Object.freeze({
                state: 'gap' as const,
                requestedRevision,
                selection,
            })
        }
        if (state === 'failed' && failure !== undefined) {
            return Object.freeze({
                state: 'failed' as const,
                requestedRevision,
                selection,
                failureCode: failure.code,
                error: failure.error,
            })
        }
        if (state !== 'ready' || active === undefined || selection === undefined ||
            selection.kind === 'gap') {
            return Object.freeze({
                state: 'loading' as const,
                requestedRevision,
                selection,
            })
        }
        const pair = active
        const readySelection = selection
        pair.captures++
        let released = false
        return Object.freeze({
            state: 'ready' as const,
            requestedRevision,
            pairGeneration,
            selection: readySelection,
            alpha: readySelection.kind === 'exact' ? 0 : readySelection.alpha,
            lower: Object.freeze({ sample: pair.lower.sample, runtime: pair.lower.runtime }),
            upper: Object.freeze({ sample: pair.upper.sample, runtime: pair.upper.runtime }),
            release() {

                if (released) return
                released = true
                pair.captures--
                if (pair.captures < 0) {
                    throw new Error('Flow temporal runtime capture count underflowed')
                }
                if (pair.retiring && pair.captures === 0) retirePair(pair)
            },
        })
    }

    function prefetch(sample: FlowFieldRuntimeSample | undefined): void {

        assertRequestable()
        const accepted = sample === undefined ? undefined : requireSample(sample, timeAxis.samples)
        if (accepted?.sampleKey === prefetchSample?.sampleKey) return
        clearPrefetch('Flow temporal lookahead was superseded')
        if (accepted === undefined) return
        prefetchSample = accepted
        prefetchState = 'loading'
        schedulePrefetchPump()
    }

    function capturePrefetch(): FlowTemporalPrefetchCapture<Runtime> | undefined {

        if (disposed) throw new Error('Flow temporal runtime window is disposed')
        if (requestsStopped || prefetchState !== 'ready' || prefetched === undefined) return
        const pair = prefetched
        pair.captures++
        let released = false
        return Object.freeze({
            sample: pair.lower.sample,
            runtime: pair.lower.runtime,
            release() {

                if (released) return
                released = true
                pair.captures--
                if (pair.retiring && pair.captures === 0) retirePair(pair)
            },
        })
    }

    function rejectPrefetch(runtime: Runtime, error: unknown): void {

        if (disposed || requestsStopped || prefetched?.lower.runtime !== runtime ||
            prefetched.lower.sample.sampleKey !== prefetchSample?.sampleKey ||
            foregroundNeeds(prefetched.lower.sample.sampleKey) ||
            active?.leases.some(lease => lease.runtime === runtime)) return
        prefetched.lower.reusable = false
        prefetchState = 'failed'
        prefetchFailure = error
        retirePrefetched()
    }

    function clearPrefetch(reason: string, force = false): void {

        prefetchSample = undefined
        prefetchState = 'idle'
        prefetchFailure = undefined
        const pendingSample = prefetchWork?.selection.kind === 'exact'
            ? prefetchWork.selection.sample : undefined
        if (force || pendingSample === undefined || !foregroundNeeds(pendingSample.sampleKey)) {
            prefetchWork?.controller.abort(new Error(reason))
        }
        if (prefetched !== undefined &&
            (force || !foregroundNeeds(prefetched.lower.sample.sampleKey))) {
            retirePrefetched()
        }
        signalCapacityChange()
    }

    function foregroundNeeds(sampleKey: string): boolean {

        return !disposed && !requestsStopped && state === 'loading' &&
            selection !== undefined && selection.kind !== 'gap' &&
            candidateSamples(selection).some(sample => sample.sampleKey === sampleKey)
    }

    function retirePrefetched(): void {

        if (prefetched === undefined) return
        const retired = prefetched
        prefetched = undefined
        const cleanup = retirePair(retired)
        if (cleanup !== undefined) {
            prefetchRetirements.add(cleanup)
            void cleanup.then(
                () => { prefetchRetirements.delete(cleanup) },
                () => { prefetchRetirements.delete(cleanup) },
            )
        }
    }

    function schedulePrefetchPump(): void {

        if (prefetchPumpPromise !== undefined || disposed || requestsStopped ||
            state !== 'ready' || candidate !== undefined || prefetchState !== 'loading' ||
            prefetchSample === undefined) return
        let tracked: Promise<void>
        tracked = preparePrefetch().finally(() => {
            if (prefetchPumpPromise === tracked) prefetchPumpPromise = undefined
            schedulePrefetchPump()
        })
        prefetchPumpPromise = tracked
        void tracked.catch(recordCleanupFailure)
    }

    async function preparePrefetch(): Promise<void> {

        const sample = prefetchSample!
        const selected = Object.freeze({ kind: 'exact' as const, modelTime: sample.modelTime, sample })
        const work: PairWork<Runtime> = {
            id: ++workSequence,
            key: selectionPairKey(selected),
            revision: requestedRevision,
            direction,
            selection: selected,
            controller: new AbortController(),
            promise: Promise.resolve(),
            leases: [],
        }
        prefetchWork = work
        work.promise = (async() => {
            let lease: RuntimeLease<Runtime> | undefined
            try {
                await waitForCapacity([ sample ], work)
                lease = await acquireLease(sample, work)
                if (work.controller.signal.aborted || disposed || requestsStopped ||
                    (prefetchSample?.sampleKey !== sample.sampleKey &&
                        !foregroundNeeds(sample.sampleKey))) {
                    const cleanup = await releaseLeases([ lease ])
                    if (cleanup.length > 0) {
                        throw new AggregateError(cleanup, 'Flow lookahead cleanup failed')
                    }
                    return
                }
                // A joined old holder may have survived a change of speculative intent.
                // It must retain its retirement path even if foreground returned elsewhere.
                retirePrefetched()
                prefetched = createPair(selected, [ lease ])
                if (prefetchSample?.sampleKey === sample.sampleKey) prefetchState = 'ready'
            } catch (error) {
                if (error instanceof FactoryUnresponsiveError) {
                    enterFailure(error, 'factory-unresponsive')
                } else if (lease !== undefined) {
                    recordCleanupFailure(error)
                } else if (!disposed && !requestsStopped &&
                    prefetchSample?.sampleKey === sample.sampleKey &&
                    (work.failure !== undefined || !work.controller.signal.aborted)) {
                    // Optional preparation never fails the current pair or retries each frame.
                    prefetchState = 'failed'
                    prefetchFailure = error
                }
            } finally {
                if (prefetchWork === work) prefetchWork = undefined
            }
        })()
        await work.promise
    }

    function cancelCandidate(reason: string): void {

        if (candidate === undefined || candidate.controller.signal.aborted) return
        candidate.controller.abort(new Error(reason))
        signalCapacityChange()
    }

    function schedulePump(): void {

        if (pumpPromise !== undefined) return
        let tracked: Promise<void>
        tracked = pump().finally(() => {
            if (pumpPromise === tracked) pumpPromise = undefined
            if (!disposed && !requestsStopped && state === 'loading' &&
                candidate === undefined &&
                selection !== undefined && selection.kind !== 'gap') {
                schedulePump()
            }
            schedulePrefetchPump()
        })
        pumpPromise = tracked
        void pumpPromise.catch(error => {
            backgroundFailures.add(error)
            enterFailure(error)
        })
    }

    async function pump(): Promise<void> {

        const previous = candidate
        if (previous !== undefined) {
            await previous.promise
            if (candidate === previous) candidate = undefined
        }
        if (disposed || requestsStopped || failure?.code === 'factory-unresponsive' ||
            selection === undefined || selection.kind === 'gap' || state !== 'loading') {
            return
        }
        const currentSelection = selection
        const work: PairWork<Runtime> = {
            id: ++workSequence,
            key: selectionPairKey(currentSelection),
            revision: requestedRevision,
            direction,
            selection: currentSelection,
            controller: new AbortController(),
            promise: Promise.resolve(),
            leases: [],
        }
        candidate = work
        work.promise = prepareCandidate(work)
        await work.promise
        if (candidate === work) candidate = undefined
    }

    async function prepareCandidate(work: PairWork<Runtime>): Promise<void> {

        const selectedSamples = candidateSamples(work.selection)
        try {
            // A matching factory is joined before acquiring; an unrelated one has
            // been cancelled by request and must release its budget first.
            if (prefetchWork !== undefined) await prefetchWork.promise
            if (prefetchRetirements.size > 0) await Promise.all([ ...prefetchRetirements ])
            await waitForCapacity(selectedSamples, work)
        } catch (error) {
            if (!work.controller.signal.aborted && !disposed && !requestsStopped) {
                enterFailure(error)
            }
            return
        }
        const settlements = await Promise.allSettled(
            selectedSamples.map(sample => acquireLease(sample, work))
        )
        const acquired = settlements.flatMap(settlement =>
            settlement.status === 'fulfilled' ? [ settlement.value ] : []
        )
        work.leases.push(...acquired)
        const failures = settlements.flatMap(settlement =>
            settlement.status === 'rejected' ? [ settlement.reason ] : []
        )
        if (failures.length > 0 || work.controller.signal.aborted || disposed ||
            requestsStopped) {
            const cleanupFailures = await releaseLeases(acquired)
            const error = failures[0] ?? work.controller.signal.reason ??
                new Error('Flow temporal runtime candidate was disposed')
            const combined = aggregate(
                error,
                cleanupFailures,
                'Flow temporal runtime candidate failed'
            )
            if (cleanupFailures.length > 0) {
                enterFailure(combined, 'runtime-cleanup-failed')
            } else if (failures.some(
                candidateFailure => candidateFailure instanceof FactoryUnresponsiveError
            )) {
                enterFailure(combined, 'factory-unresponsive')
            } else if (!disposed && !requestsStopped &&
                work.revision === requestedRevision &&
                (work.failure !== undefined || !work.controller.signal.aborted)) {
                enterFailure(combined)
            }
            return
        }
        if (candidate !== work || work.controller.signal.aborted || disposed ||
            requestsStopped ||
            failure !== undefined || state !== 'loading' ||
            latestTicket === undefined || latestTicket.deferred.settled ||
            latestTicket.public.revision !== requestedRevision ||
            work.key !== selectionPairKey(work.selection) ||
            selection === undefined || selection.kind === 'gap' ||
            work.key !== selectionPairKey(selection)) {
            const cleanupFailures = await releaseLeases(acquired)
            if (cleanupFailures.length > 0) {
                enterFailure(
                    new AggregateError(
                        cleanupFailures,
                        'Flow temporal stale candidate cleanup failed'
                    ),
                    'runtime-cleanup-failed'
                )
            }
            return
        }
        activatePair(work.selection, acquired)
    }

    function createPair(
        selected: Exclude<FlowTimeSelection, Readonly<{ kind: 'gap' }>>,
        acquired: readonly RuntimeLease<Runtime>[]
    ): RuntimePair<Runtime> {

        const byKey = new Map(acquired.map(lease => [ lease.sample.sampleKey, lease ]))
        const lowerSample = selected.kind === 'exact' ? selected.sample : selected.lower
        const upperSample = selected.kind === 'exact' ? selected.sample : selected.upper
        const lower = byKey.get(lowerSample.sampleKey)
        const upper = byKey.get(upperSample.sampleKey)
        if (lower === undefined || upper === undefined) {
            throw new Error('Flow temporal runtime candidate is incomplete')
        }
        return {
            key: selectionPairKey(selected),
            selection: selected,
            leases: Object.freeze([ ...new Set([ lower, upper ]) ]),
            lower,
            upper,
            captures: 0,
            retiring: false,
            released: false,
        }
    }

    function activatePair(
        selected: Exclude<FlowTimeSelection, Readonly<{ kind: 'gap' }>>,
        acquired: readonly RuntimeLease<Runtime>[]
    ): void {

        const pair = createPair(selected, acquired)
        const retired = active
        active = pair
        pairGeneration++
        state = 'ready'
        selection = selected
        settleTicket(latestTicket, 'ready')
        if (retired !== undefined) retirePair(retired)
        if (prefetchSample !== undefined && pair.leases.some(lease =>
            lease.sample.sampleKey === prefetchSample?.sampleKey
        )) {
            prefetchSample = undefined
            prefetchState = 'idle'
            prefetchFailure = undefined
        }
        if (prefetched !== undefined && pair.leases.includes(prefetched.lower)) {
            retirePrefetched()
        }
        schedulePrefetchPump()
    }

    async function acquireLease(
        sample: FlowFieldRuntimeSample,
        work: PairWork<Runtime>
    ): Promise<RuntimeLease<Runtime>> {

        const existing = leases.get(sample.sampleKey)
        if (existing !== undefined && existing.reusable && !existing.disposed) {
            existing.references++
            return existing
        }
        if (ownedRuntimes.size + pendingCreationCount >= options.maxOwnedRuntimes) {
            throw new Error('Flow temporal runtime ownership exceeds its four-runtime budget')
        }
        pendingCreationCount++
        const attemptId = `${ownerId}:pair-${work.id}:attempt-${++attemptSequence}:` +
            sample.sampleKey
        let timedOut = false
        let timeout: ReturnType<typeof setTimeout> | undefined
        const raw = Promise.resolve().then(() => options.createReadyRuntime(sample, {
            signal: work.controller.signal,
            attemptId,
        }))
        try {
            const runtime = await Promise.race([
                raw,
                new Promise<never>((_resolve, reject) => {
                    timeout = setTimeout(() => {
                        timedOut = true
                        reject(new FactoryUnresponsiveError(
                            `Flow temporal runtime factory did not settle for ${sample.sampleKey}`
                        ))
                    }, options.maxCreationSettleMs)
                }),
            ])
            claimRuntime(runtime, attemptId)
            if (work.controller.signal.aborted || disposed || requestsStopped || timedOut) {
                try {
                    await disposeOwnedRuntime(runtime)
                } catch (error) {
                    recordCleanupFailure(error)
                    throw error
                }
                throw work.controller.signal.reason ?? new FactoryUnresponsiveError(
                    `Flow temporal runtime factory completed too late for ${sample.sampleKey}`
                )
            }
            const lease: RuntimeLease<Runtime> = {
                sample,
                runtime,
                references: 1,
                reusable: true,
                disposed: false,
            }
            runtimeOwners.set(runtime, sample.sampleKey)
            leases.set(sample.sampleKey, lease)
            return lease
        } catch (error) {
            if (timedOut) trackLateSettlement(raw)
            if (!work.controller.signal.aborted) {
                work.failure = error
                work.controller.abort(error)
                signalCapacityChange()
            }
            throw error
        } finally {
            if (timeout !== undefined) clearTimeout(timeout)
            pendingCreationCount--
        }
    }

    function trackLateSettlement(raw: Promise<Runtime>): void {

        let tracked: Promise<void>
        tracked = raw.then(
            async runtime => {
                claimRuntime(runtime, 'late-factory-completion')
                await disposeOwnedRuntime(runtime)
            },
            () => undefined,
        ).finally(() => { lateSettlements.delete(tracked) })
        lateSettlements.add(tracked)
        void tracked.catch(error => {
            recordCleanupFailure(error)
        })
    }

    function retirePair(pair: RuntimePair<Runtime>): Promise<void> | undefined {

        pair.retiring = true
        retiringPairs.add(pair)
        if (pair.captures !== 0 || pair.released) return
        pair.released = true
        retiringPairs.delete(pair)
        const cleanup = trackRetirement(releaseLeases(pair.leases))
        if (retiringPairs.size === 0) {
            for (const waiter of captureWaiters) {
                waiter.settled = true
                waiter.resolve()
            }
            captureWaiters.clear()
        }
        return cleanup
    }

    function trackRetirement(cleanup: Promise<unknown[]>): Promise<void> {

        let tracked: Promise<void>
        tracked = cleanup.then(cleanupFailures => {
            if (cleanupFailures.length > 0) {
                throw new AggregateError(
                    cleanupFailures,
                    'Flow temporal runtime retirement failed'
                )
            }
        }).finally(() => { retirements.delete(tracked) })
        retirements.add(tracked)
        void tracked.catch(error => {
            backgroundFailures.add(error)
            enterFailure(error, 'runtime-cleanup-failed')
        })
        return tracked
    }

    async function releaseLeases(
        values: readonly RuntimeLease<Runtime>[]
    ): Promise<unknown[]> {

        const failures: unknown[] = []
        for (const lease of new Set(values)) {
            lease.references--
            if (lease.references < 0) {
                failures.push(new Error('Flow temporal runtime lease count underflowed'))
                continue
            }
            if (lease.references !== 0 || lease.disposed) continue
            lease.disposed = true
            try {
                await disposeOwnedRuntime(lease.runtime)
                if (leases.get(lease.sample.sampleKey) === lease) {
                    leases.delete(lease.sample.sampleKey)
                }
            } catch (error) {
                failures.push(error)
            }
        }
        return failures
    }

    function disposeRuntimeOnce(runtime: Runtime): Promise<void> {

        const existing = disposalPromises.get(runtime)
        if (existing !== undefined) return existing
        const disposing = Promise.resolve().then(() => options.disposeRuntime(runtime))
        disposalPromises.set(runtime, disposing)
        return disposing
    }

    function stopRuntimeRequestsOnce(runtime: Runtime): Promise<void> {

        const existing = stopRuntimePromises.get(runtime)
        if (existing !== undefined) return existing
        const stopping = Promise.resolve().then(() => options.stopRuntimeRequests(runtime))
        stopRuntimePromises.set(runtime, stopping)
        return stopping
    }

    function claimRuntime(runtime: Runtime, owner: string): void {

        const priorOwner = runtimeOwners.get(runtime)
        if (priorOwner !== undefined) {
            throw new Error(
                `Flow temporal runtime factory reused an owned runtime from ${priorOwner}`
            )
        }
        runtimeOwners.set(runtime, owner)
        ownedRuntimes.add(runtime)
    }

    async function disposeOwnedRuntime(runtime: Runtime): Promise<void> {

        const failures: unknown[] = []
        try {
            await stopRuntimeRequestsOnce(runtime)
        } catch (error) {
            failures.push(error)
        }
        try {
            await disposeRuntimeOnce(runtime)
            ownedRuntimes.delete(runtime)
        } catch (error) {
            failures.push(error)
        }
        signalCapacityChange()
        if (failures.length === 1) throw failures[0]
        if (failures.length > 1) {
            throw new AggregateError(failures, 'Flow temporal runtime cleanup failed')
        }
    }

    function recordCleanupFailure(error: unknown): void {

        backgroundFailures.add(error)
        enterFailure(error, 'runtime-cleanup-failed')
    }

    function enterFailure(
        error: unknown,
        code: 'factory-unresponsive' | 'runtime-cleanup-failed' | 'runtime-failed' =
            'runtime-failed'
    ): void {

        if (code !== 'runtime-failed') {
            backgroundFailures.add(error)
            resolveFatalTermination(code, error)
        }
        if (disposed) return
        if (failure?.code === 'factory-unresponsive' ||
            failure?.code === 'runtime-cleanup-failed') return
        failure = Object.freeze({ code, error })
        state = 'failed'
        settleTicket(latestTicket, 'failed', error)
        cancelCandidate('Flow temporal runtime entered a failed state')
        clearPrefetch('Flow temporal runtime entered a failed state')
        signalCapacityChange()
    }

    function resolveFatalTermination(
        code: 'factory-unresponsive' | 'runtime-cleanup-failed',
        error: unknown
    ): void {

        if (termination.settled) return
        termination.settled = true
        termination.resolve(Object.freeze({
            status: 'fatal' as const,
            failureCode: code,
            error,
        }))
    }

    function stopRequests(): Promise<void> {

        if (stopRequestsPromise !== undefined) return stopRequestsPromise
        requestsStopped = true
        settleTicket(latestTicket, 'disposed')
        cancelCandidate('Flow temporal runtime requests were stopped')
        clearPrefetch('Flow temporal runtime requests were stopped')
        signalCapacityChange()
        const stopping = Promise.allSettled(
            [ ...ownedRuntimes ].map(stopRuntimeRequestsOnce)
        ).then(settlements => {
            const failures = settlements.flatMap(result =>
                result.status === 'rejected' ? [ result.reason ] : []
            )
            if (failures.length > 0) {
                const failure = new AggregateError(
                    failures,
                    'Flow temporal runtime request shutdown failed'
                )
                enterFailure(failure, 'runtime-cleanup-failed')
                throw failure
            }
        })
        stopRequestsPromise = stopping
        return stopping
    }

    function dispose(): Promise<void> {

        if (disposePromise !== undefined) return disposePromise
        const stopping = stopRequests()
        disposed = true
        state = 'disposed'
        if (active !== undefined) {
            const retired = active
            active = undefined
            retirePair(retired)
        }
        disposePromise = disposeAll(stopping)
        return disposePromise
    }

    async function disposeAll(stopping: Promise<void>): Promise<void> {

        const failures = new Set<unknown>(backgroundFailures)
        const stopSettlement = await Promise.allSettled([ stopping ])
        if (stopSettlement[0]?.status === 'rejected') {
            failures.add(stopSettlement[0].reason)
        }
        if (pumpPromise !== undefined) {
            const settlement = await Promise.allSettled([ pumpPromise ])
            if (settlement[0]?.status === 'rejected') failures.add(settlement[0].reason)
        }
        if (prefetchPumpPromise !== undefined) {
            const settlement = await Promise.allSettled([ prefetchPumpPromise ])
            if (settlement[0]?.status === 'rejected') failures.add(settlement[0].reason)
        }
        while (retiringPairs.size > 0) {
            const waiter = createDeferred<void>()
            captureWaiters.add(waiter)
            await waiter.promise
        }
        while (retirements.size > 0) {
            const settlements = await Promise.allSettled([ ...retirements ])
            for (const result of settlements) {
                if (result.status === 'rejected') failures.add(result.reason)
            }
        }
        while (lateSettlements.size > 0) {
            const settlements = await Promise.allSettled([ ...lateSettlements ])
            for (const result of settlements) {
                if (result.status === 'rejected') failures.add(result.reason)
            }
        }
        for (const error of backgroundFailures) failures.add(error)
        if (failures.size > 0) {
            resolveFatalTermination(
                failure?.code === 'factory-unresponsive'
                    ? 'factory-unresponsive'
                    : 'runtime-cleanup-failed',
                failures.size === 1
                    ? [ ...failures ][0]
                    : new AggregateError(
                        [ ...failures ],
                        'Flow temporal runtime window disposal failed'
                    )
            )
            throw new AggregateError(
                [ ...failures ],
                'Flow temporal runtime window disposal failed'
            )
        }
        if (!termination.settled) {
            termination.settled = true
            termination.resolve(Object.freeze({ status: 'stopped' as const }))
        }
    }

    function assertRequestable(): void {

        if (disposed) throw new Error('Flow temporal runtime window is disposed')
        if (requestsStopped) throw new Error('Flow temporal runtime requests are stopped')
        if (failure?.code === 'factory-unresponsive' ||
            failure?.code === 'runtime-cleanup-failed') {
            throw new Error(`Flow temporal runtime window is fatal: ${failure.code}`)
        }
    }

    function createTicket(
        revision: number,
        acceptedSelection: FlowTimeSelection
    ): TicketState {

        const deferred = createDeferred<FlowTemporalRequestResult>()
        return {
            public: Object.freeze({
                revision,
                selection: acceptedSelection,
                settled: deferred.promise,
            }),
            deferred,
        }
    }

    function settleTicket(
        ticket: TicketState | undefined,
        status: FlowTemporalRequestResult['status'],
        error?: unknown
    ): void {

        if (ticket === undefined || ticket.deferred.settled) return
        ticket.deferred.settled = true
        if (status === 'ready') {
            ticket.deferred.resolve(Object.freeze({
                status,
                revision: ticket.public.revision,
                pairGeneration,
            }))
        } else if (status === 'failed') {
            ticket.deferred.resolve(Object.freeze({
                status,
                revision: ticket.public.revision,
                error,
            }))
        } else {
            ticket.deferred.resolve(Object.freeze({
                status,
                revision: ticket.public.revision,
            }))
        }
    }

    return Object.freeze({
        request,
        prefetch,
        capturePrefetch,
        rejectPrefetch,
        termination: termination.promise,
        snapshot,
        capture,
        stopRequests,
        dispose,
    })

    async function waitForCapacity(
        selectedSamples: readonly FlowFieldRuntimeSample[],
        work: PairWork<Runtime>
    ): Promise<void> {

        while (true) {
            if (work.controller.signal.aborted) throw work.controller.signal.reason
            if (disposed) throw new Error('Flow temporal runtime window is disposed')
            if (requestsStopped) throw new Error('Flow temporal runtime requests are stopped')
            const missingCount = new Set(
                selectedSamples
                    .map(sample => sample.sampleKey)
                    .filter(sampleKey => {
                        const lease = leases.get(sampleKey)
                        return lease === undefined || !lease.reusable || lease.disposed
                    })
            ).size
            if (ownedRuntimes.size + pendingCreationCount + missingCount <=
                options.maxOwnedRuntimes) return
            const waiter = createDeferred<void>()
            capacityWaiters.add(waiter)
            const abort = () => {
                if (waiter.settled) return
                waiter.settled = true
                waiter.resolve()
            }
            work.controller.signal.addEventListener('abort', abort, { once: true })
            await waiter.promise
            work.controller.signal.removeEventListener('abort', abort)
            capacityWaiters.delete(waiter)
        }
    }

    function signalCapacityChange(): void {

        for (const waiter of capacityWaiters) {
            if (waiter.settled) continue
            waiter.settled = true
            waiter.resolve()
        }
        capacityWaiters.clear()
    }
}

function candidateSamples(
    selection: Exclude<FlowTimeSelection, Readonly<{ kind: 'gap' }>>
): readonly FlowFieldRuntimeSample[] {

    return selection.kind === 'exact'
        ? Object.freeze([ selection.sample ])
        : Object.freeze([ selection.lower, selection.upper ])
}

function selectionPairKey(
    selection: Exclude<FlowTimeSelection, Readonly<{ kind: 'gap' }>>
): string {

    return selection.kind === 'exact'
        ? JSON.stringify([ selection.sample.sampleKey ])
        : JSON.stringify([ selection.lower.sampleKey, selection.upper.sampleKey ])
}

function validateSelection(
    selection: FlowTimeSelection,
    axis: NormalizedTimeAxis
): FlowTimeSelection {

    if (selection?.kind === 'exact') {
        const sample = requireSample(selection.sample, axis.samples)
        if (!Number.isFinite(selection.modelTime) || selection.modelTime !== sample.modelTime) {
            throw new TypeError('Flow exact selection does not match its sample time')
        }
        return Object.freeze({
            kind: 'exact' as const,
            modelTime: selection.modelTime,
            sample,
        })
    }
    if (selection?.kind === 'interpolated') {
        const lower = requireSample(selection.lower, axis.samples)
        const upper = requireSample(selection.upper, axis.samples)
        const edge = axis.adjacency.get(adjacencyKey(lower.sampleKey, upper.sampleKey))
        const expectedAlpha = (selection.modelTime - lower.modelTime) /
            (upper.modelTime - lower.modelTime)
        if (!Number.isFinite(selection.modelTime) || lower.modelTime >= upper.modelTime ||
            !Number.isFinite(selection.alpha) || selection.alpha <= 0 || selection.alpha >= 1 ||
            selection.alpha !== expectedAlpha || edge?.kind !== 'interpolable') {
            throw new TypeError('Flow interpolated selection is invalid')
        }
        return Object.freeze({
            kind: 'interpolated' as const,
            modelTime: selection.modelTime,
            lower,
            upper,
            alpha: selection.alpha,
        })
    }
    if (selection?.kind === 'gap') {
        const lower = requireSample(selection.lower, axis.samples)
        const upper = requireSample(selection.upper, axis.samples)
        const edge = axis.adjacency.get(adjacencyKey(lower.sampleKey, upper.sampleKey))
        if (!Number.isFinite(selection.modelTime) ||
            !(lower.modelTime < selection.modelTime && selection.modelTime < upper.modelTime) ||
            selection.reason !== 'omitted-source-samples' || edge?.kind !== 'gap') {
            throw new TypeError('Flow gap selection is invalid')
        }
        return Object.freeze({
            kind: 'gap' as const,
            modelTime: selection.modelTime,
            lower,
            upper,
            reason: 'omitted-source-samples' as const,
        })
    }
    throw new TypeError('Flow temporal runtime request requires a time selection')
}

function requireSample(
    value: FlowFieldRuntimeSample,
    samples: ReadonlyMap<string, FlowFieldRuntimeSample>
): FlowFieldRuntimeSample {

    const sample = samples.get(value?.sampleKey)
    if (sample === undefined || value.timeIndex !== sample.timeIndex ||
        value.modelTime !== sample.modelTime ||
        value.sourceHash !== sample.sourceHash || value.unit !== sample.unit ||
        value.phase !== sample.phase) {
        throw new TypeError('Flow temporal selection contains an unknown sample')
    }
    return sample
}

function normalizeTimeAxis(
    axis: FlowFieldDataset['timeAxis']
): NormalizedTimeAxis {

    if (!Array.isArray(axis?.samples) || axis.samples.length === 0 ||
        typeof axis.unit !== 'string' || axis.unit.length === 0 ||
        typeof axis.phase !== 'string' || axis.phase.length === 0 ||
        !Number.isSafeInteger(axis.sourceSampleCount) || axis.sourceSampleCount < 1 ||
        axis.sourceSampleCount < axis.samples.length) {
        throw new TypeError('Flow temporal runtime window requires a normalized time axis')
    }
    const values = new Map<string, FlowFieldRuntimeSample>()
    let previousModelTime = -Infinity
    let previousTimeIndex = -1
    for (const sample of axis.samples) {
        const interval = typeof sample?.modelTime === 'number'
            ? sample.modelTime - previousModelTime
            : Number.NaN
        if (!Number.isSafeInteger(sample?.timeIndex) || sample.timeIndex < 0 ||
            sample.timeIndex >= axis.sourceSampleCount ||
            sample.sampleKey !== `t${String(sample.timeIndex).padStart(2, '0')}` ||
            sample.timeIndex <= previousTimeIndex ||
            values.has(sample.sampleKey) || !Number.isFinite(sample.modelTime) ||
            (previousTimeIndex >= 0 && (!Number.isFinite(interval) || interval <= 0)) ||
            sample.unit !== axis.unit || sample.phase !== axis.phase ||
            !/^[0-9a-f]{64}$/.test(sample.sourceHash)) {
            throw new TypeError('Flow temporal runtime samples are invalid')
        }
        values.set(sample.sampleKey, Object.freeze({ ...sample }))
        previousModelTime = sample.modelTime
        previousTimeIndex = sample.timeIndex
    }
    const totalSpan = axis.samples.at(-1)!.modelTime - axis.samples[0]!.modelTime
    if (!Number.isFinite(totalSpan)) {
        throw new TypeError('Flow temporal runtime model-time span must be finite')
    }
    if (!Array.isArray(axis.adjacency) || axis.adjacency.length !== axis.samples.length - 1) {
        throw new TypeError('Flow temporal runtime adjacency is invalid')
    }
    const adjacency = new Map<string, FlowFieldSampleAdjacency>()
    for (const [ index, edge ] of axis.adjacency.entries()) {
        const lower = axis.samples[index]!
        const upper = axis.samples[index + 1]!
        const consecutive = upper.timeIndex === lower.timeIndex + 1
        const validEdge = edge?.lowerSampleKey === lower.sampleKey &&
            edge.upperSampleKey === upper.sampleKey && (
                (consecutive && edge.kind === 'interpolable' &&
                    edge.interpolation === 'component-wise-linear') ||
                (!consecutive && edge.kind === 'gap' && edge.interpolation === 'none' &&
                    edge.reason === 'omitted-source-samples')
            )
        if (!validEdge) {
            throw new TypeError('Flow temporal runtime adjacency is invalid')
        }
        adjacency.set(
            adjacencyKey(lower.sampleKey, upper.sampleKey),
            Object.freeze({ ...edge })
        )
    }
    return Object.freeze({ samples: values, adjacency })
}

function adjacencyKey(lowerSampleKey: string, upperSampleKey: string): string {

    return JSON.stringify([ lowerSampleKey, upperSampleKey ])
}

function normalizeDatasetIdentity(
    value: FlowTemporalRuntimeWindowOptions<object>['datasetIdentity']
): FlowTemporalRuntimeWindowOptions<object>['datasetIdentity'] {

    if (typeof value?.datasetId !== 'string' || value.datasetId.length === 0 ||
        !/^[0-9a-f]{64}$/.test(value.sourceHash) ||
        typeof value.contentVersion !== 'string' || value.contentVersion.length === 0) {
        throw new TypeError('Flow temporal runtime dataset identity is invalid')
    }
    return Object.freeze({ ...value })
}

function normalizeDirection(value: FlowTemporalDirection): FlowTemporalDirection {

    if (value !== -1 && value !== 0 && value !== 1) {
        throw new TypeError('Flow temporal direction must be -1, 0, or 1')
    }
    return value
}

function createDeferred<Value>(): Deferred<Value> {

    let resolvePromise!: (value: Value) => void
    const promise = new Promise<Value>(resolve => { resolvePromise = resolve })
    return { promise, resolve: resolvePromise, settled: false }
}

function aggregate(primary: unknown, cleanup: readonly unknown[], message: string): unknown {

    return cleanup.length === 0 ? primary : new AggregateError([ primary, ...cleanup ], message)
}
