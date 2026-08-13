export type LifetimeState = 'active' | 'disposing' | 'disposed'
export type LifetimeCleanupPhase = 'stop' | 'settle' | 'release'
export type LifetimeActionRun = () => unknown | PromiseLike<unknown>

export type LifetimeScopeOptions = Readonly<{
    label?: string
}>

export type LifetimeOwnership<T> = Readonly<{
    label: string
    release(value: T): unknown | PromiseLike<unknown>
}>

export type LifetimeDeferredAction = Readonly<{
    cancel(): boolean
    readonly isActive: boolean
}>

export type LifetimeCleanupAction = Readonly<{
    phase: Exclude<LifetimeCleanupPhase, 'settle'>
    label: string
    status: 'fulfilled' | 'rejected'
}>

export type LifetimeCleanupFailure = Readonly<{
    phase: LifetimeCleanupPhase
    label: string
    error: unknown
}>

export type LifetimeCleanupReport = Readonly<{
    primaryFailure: unknown
    cleanupInvocationCount: number
    pendingObservationsBefore: number
    pendingObservationsAfter: number
    retainedActionCount: number
    cleanupActions: readonly LifetimeCleanupAction[]
    cleanupFailures: readonly LifetimeCleanupFailure[]
}>

export type LifetimeScopeSnapshot = Readonly<{
    label: string
    state: LifetimeState
    activeActionCount: number
    pendingObservationCount: number
}>

export type LifetimeStoppedError = Error & Readonly<{
    code: 'SCRATCH_LIFETIME_STOPPED'
    scopeLabel: string
}>

type DeferredAction = {
    id: number
    label: string
    run?: LifetimeActionRun
    active: boolean
}

type ObservationSettlement =
    | Readonly<{ status: 'fulfilled', value: unknown }>
    | Readonly<{ status: 'rejected', error: unknown }>

type ObservationEntry = {
    id: number
    label: string
    settlement: Promise<ObservationSettlement>
    rejectionReported: boolean
}

export class LifetimeScope {

    readonly #abortController = new AbortController()
    readonly #label: string
    readonly #stopActions: DeferredAction[] = []
    readonly #releaseActions: DeferredAction[] = []
    readonly #pendingObservations = new Map<number, ObservationEntry>()
    readonly #cleanupActions: LifetimeCleanupAction[] = []
    readonly #cleanupFailures: LifetimeCleanupFailure[] = []
    #nextActionId = 1
    #nextObservationId = 1
    #state: LifetimeState = 'active'
    #disposal?: Promise<LifetimeCleanupReport>
    #primaryFailure: unknown
    #stopError?: LifetimeStoppedError
    #cleanupInvocationCount = 0

    constructor({ label = 'lifetime' }: LifetimeScopeOptions = {}) {

        assertLabel(label, 'Lifetime scope')
        this.#label = label
    }

    get signal(): AbortSignal {

        return this.#abortController.signal
    }

    assertActive(): void {

        if (this.#state !== 'active') throw this.#lifecycleStopError()
    }

    isStopError(error: unknown): error is LifetimeStoppedError {

        return (error as { code?: unknown } | null | undefined)?.code ===
            'SCRATCH_LIFETIME_STOPPED'
    }

    own<T>(value: T, ownership: LifetimeOwnership<T>): T {

        this.assertActive()
        if (value === undefined || value === null) {
            throw new TypeError('Lifetime-owned value must be defined')
        }
        assertOwnership(ownership)
        this.deferRelease({
            label: ownership.label,
            run: () => ownership.release(value),
        })
        return value
    }

    acquire<T>(
        acquisition: T | PromiseLike<T>,
        ownership: LifetimeOwnership<T>
    ): Promise<T> {

        this.assertActive()
        assertOwnership(ownership)
        const guarded = Promise.resolve(acquisition).then(async value => {
            if (this.#state !== 'active') {
                await this.#recordAction(
                    'release',
                    `late-${ownership.label}`,
                    () => ownership.release(value)
                )
                throw this.#lifecycleStopError()
            }
            return this.own(value, ownership)
        })
        return this.track(guarded, `${ownership.label}-acquisition`)
    }

    deferStop(action: Readonly<{
        label: string
        run: LifetimeActionRun
    }>): LifetimeDeferredAction {

        return this.#registerAction(this.#stopActions, action)
    }

    deferRelease(action: Readonly<{
        label: string
        run: LifetimeActionRun
    }>): LifetimeDeferredAction {

        return this.#registerAction(this.#releaseActions, action)
    }

    track<T>(observation: T | PromiseLike<T>, label = 'pending-observation'): Promise<T> {

        if (this.#state === 'disposed') throw this.#lifecycleStopError()
        assertLabel(label, 'Lifetime observation')

        const id = this.#nextObservationId++
        const promise = Promise.resolve(observation)
        const entry: ObservationEntry = {
            id,
            label,
            rejectionReported: false,
            settlement: promise.then<ObservationSettlement, ObservationSettlement>(
                value => Object.freeze({ status: 'fulfilled', value }),
                (error: unknown) => Object.freeze({ status: 'rejected', error })
            ).finally(() => {
                if (this.#state === 'active') this.#pendingObservations.delete(id)
            }),
        }
        this.#pendingObservations.set(id, entry)
        return promise
    }

    async drain(): Promise<LifetimeScopeSnapshot> {

        while (this.#pendingObservations.size > 0) {
            await this.#settle([ ...this.#pendingObservations.values() ])
        }
        return this.snapshot()
    }

    dispose(failure?: unknown): Promise<LifetimeCleanupReport> {

        if (this.#disposal !== undefined) return this.#disposal
        this.#state = 'disposing'
        this.#primaryFailure = failure
        this.#cleanupInvocationCount = 1
        const pendingAtDisposal = this.#pendingObservations.size
        this.#abortController.abort(this.#lifecycleStopError())
        this.#disposal = this.#disposeOnce(pendingAtDisposal)
        return this.#disposal
    }

    snapshot(): LifetimeScopeSnapshot {

        return Object.freeze({
            label: this.#label,
            state: this.#state,
            activeActionCount: [ ...this.#stopActions, ...this.#releaseActions ]
                .filter(action => action.active).length,
            pendingObservationCount: this.#pendingObservations.size,
        })
    }

    #lifecycleStopError(): LifetimeStoppedError {

        if (this.#stopError !== undefined) return this.#stopError
        const error = new Error(
            `Lifetime scope ${this.#label} disposal has started`
        ) as LifetimeStoppedError
        error.name = 'LifetimeStoppedError'
        Object.defineProperties(error, {
            code: { value: 'SCRATCH_LIFETIME_STOPPED', enumerable: true },
            scopeLabel: { value: this.#label, enumerable: true },
        })
        this.#stopError = error
        return error
    }

    #registerAction(
        actions: DeferredAction[],
        { label, run }: Readonly<{ label: string, run: LifetimeActionRun }>
    ): LifetimeDeferredAction {

        this.assertActive()
        assertLabel(label, 'Lifetime action')
        if (typeof run !== 'function') throw new TypeError('Lifetime action must be a function')

        const action: DeferredAction = {
            id: this.#nextActionId++,
            label,
            run,
            active: true,
        }
        actions.push(action)
        return Object.freeze({
            cancel() {
                if (!action.active) return false
                action.active = false
                delete action.run
                return true
            },
            get isActive() {
                return action.active
            },
        })
    }

    async #recordAction(
        phase: Exclude<LifetimeCleanupPhase, 'settle'>,
        label: string,
        run: LifetimeActionRun
    ): Promise<void> {

        try {
            await run()
            this.#cleanupActions.push(Object.freeze({ phase, label, status: 'fulfilled' }))
        } catch (error) {
            this.#cleanupActions.push(Object.freeze({ phase, label, status: 'rejected' }))
            this.#cleanupFailures.push(Object.freeze({ phase, label, error }))
        }
    }

    async #runActions(
        actions: DeferredAction[],
        phase: Exclude<LifetimeCleanupPhase, 'settle'>
    ): Promise<void> {

        for (let index = actions.length - 1; index >= 0; index--) {
            const action = actions[index]!
            if (!action.active) continue
            action.active = false
            const run = action.run!
            delete action.run
            await this.#recordAction(phase, action.label, run)
        }
    }

    async #settle(entries: readonly ObservationEntry[]): Promise<void> {

        const settlements = await Promise.all(entries.map(entry => entry.settlement))
        for (let index = 0; index < settlements.length; index++) {
            const entry = entries[index]!
            const settlement = settlements[index]!
            this.#pendingObservations.delete(entry.id)
            if (settlement.status !== 'rejected' ||
                entry.rejectionReported ||
                this.isStopError(settlement.error) ||
                settlement.error === this.#primaryFailure) continue
            entry.rejectionReported = true
            this.#cleanupFailures.push(Object.freeze({
                phase: 'settle',
                label: entry.label,
                error: settlement.error,
            }))
        }
    }

    async #disposeOnce(pendingObservationsBefore: number): Promise<LifetimeCleanupReport> {

        await this.#runActions(this.#stopActions, 'stop')
        await this.drain()
        await this.#runActions(this.#releaseActions, 'release')

        this.#stopActions.length = 0
        this.#releaseActions.length = 0
        this.#pendingObservations.clear()
        this.#state = 'disposed'

        return Object.freeze({
            primaryFailure: this.#primaryFailure,
            cleanupInvocationCount: this.#cleanupInvocationCount,
            pendingObservationsBefore,
            pendingObservationsAfter: this.#pendingObservations.size,
            retainedActionCount: 0,
            cleanupActions: Object.freeze([ ...this.#cleanupActions ]),
            cleanupFailures: Object.freeze([ ...this.#cleanupFailures ]),
        })
    }
}

function assertOwnership<T>(ownership: LifetimeOwnership<T>): void {

    if (ownership === null || typeof ownership !== 'object') {
        throw new TypeError('Lifetime ownership must be an object')
    }
    assertLabel(ownership.label, 'Lifetime ownership')
    if (typeof ownership.release !== 'function') {
        throw new TypeError('Lifetime ownership release must be a function')
    }
}

function assertLabel(label: string, subject: string): void {

    if (typeof label !== 'string' || label.length === 0) {
        throw new TypeError(`${subject} label must be a non-empty string`)
    }
}
