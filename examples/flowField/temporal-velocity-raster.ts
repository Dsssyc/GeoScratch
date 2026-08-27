export type TemporalVelocitySnapshot = Readonly<{
    generation: number
    currentTimeIndex: number
    nextTimeIndex: number
    prefetchTimeIndex: number
    frameInTime: number
    framesPerTime: number
    progress: number
    temporalResidencyEpoch: number
    currentSnapshotEpoch: number
    nextSnapshotEpoch: number
}>

export type TemporalVelocityRasterOptions<Runtime> = Readonly<{
    fieldCount: number
    framesPerTime: number
    initialTimeIndex?: number
    createRuntime(timeIndex: number, signal: AbortSignal): Promise<Runtime>
    disposeRuntime(runtime: Runtime): Promise<void>
}>

export type TemporalVelocityRaster<Runtime> = Readonly<{
    readonly current: Runtime
    readonly next: Runtime
    readonly prefetch: Runtime
    snapshot(): TemporalVelocitySnapshot
    recordPublication(timeIndex: number, snapshotEpoch: number): TemporalVelocitySnapshot
    advanceFrame(): Promise<TemporalVelocitySnapshot>
    dispose(): Promise<void>
}>

type VelocitySlot<Runtime> = {
    timeIndex: number
    runtime: Runtime
    snapshotEpoch: number
}

/** Owns a bounded current/next/prefetch window over immutable velocity runtimes. */
export async function createTemporalVelocityRaster<Runtime>(
    options: TemporalVelocityRasterOptions<Runtime>
): Promise<TemporalVelocityRaster<Runtime>> {

    const fieldCount = requirePositiveInteger(options?.fieldCount, 'fieldCount')
    const framesPerTime = requirePositiveInteger(options?.framesPerTime, 'framesPerTime')
    const initialTimeIndex = options?.initialTimeIndex ?? 0
    if (fieldCount < 3 || !validTimeIndex(initialTimeIndex, fieldCount) ||
        typeof options?.createRuntime !== 'function' ||
        typeof options?.disposeRuntime !== 'function') {
        throw new TypeError(
            'Temporal velocity requires at least three fields, a valid initial time, and runtime ownership callbacks'
        )
    }

    const created: Runtime[] = []
    const abortController = new AbortController()
    let current: VelocitySlot<Runtime>
    let next: VelocitySlot<Runtime>
    let prefetch: VelocitySlot<Runtime>
    try {
        current = await createSlot(initialTimeIndex)
        next = await createSlot(wrapTime(initialTimeIndex + 1, fieldCount))
        prefetch = await createSlot(wrapTime(initialTimeIndex + 2, fieldCount))
    } catch (error) {
        const failures = await disposeAll(created)
        if (failures.length > 0) {
            throw new AggregateError([ error, ...failures ], 'Temporal velocity initialization failed')
        }
        throw error
    }

    let generation = 1
    let frameInTime = 0
    let temporalResidencyEpoch = 0
    let stopping = false
    let disposed = false
    let disposePromise: Promise<void> | undefined
    let advancePromise: Promise<TemporalVelocitySnapshot> | undefined

    async function createSlot(timeIndex: number): Promise<VelocitySlot<Runtime>> {

        const runtime = await options.createRuntime(timeIndex, abortController.signal)
        created.push(runtime)
        return { timeIndex, runtime, snapshotEpoch: 0 }
    }

    function snapshot(): TemporalVelocitySnapshot {

        assertActive()
        return readSnapshot()
    }

    function readSnapshot(): TemporalVelocitySnapshot {

        return Object.freeze({
            generation,
            currentTimeIndex: current.timeIndex,
            nextTimeIndex: next.timeIndex,
            prefetchTimeIndex: prefetch.timeIndex,
            frameInTime,
            framesPerTime,
            progress: framesPerTime === 1 ? 1 : frameInTime / (framesPerTime - 1),
            temporalResidencyEpoch,
            currentSnapshotEpoch: current.snapshotEpoch,
            nextSnapshotEpoch: next.snapshotEpoch,
        })
    }

    function recordPublication(timeIndex: number, snapshotEpoch: number): TemporalVelocitySnapshot {

        assertActive()
        if (!Number.isSafeInteger(snapshotEpoch) || snapshotEpoch <= 0) {
            throw new RangeError('Velocity snapshot epochs must be positive safe integers')
        }
        const slot = timeIndex === current.timeIndex
            ? current
            : timeIndex === next.timeIndex
                ? next
                : undefined
        if (slot === undefined) {
            if (timeIndex === prefetch.timeIndex) {
                throw new Error('Prefetch publication cannot enter the active temporal pair')
            }
            throw new RangeError(`Velocity publication time ${timeIndex} is not active`)
        }
        if (snapshotEpoch <= slot.snapshotEpoch) {
            throw new RangeError('Velocity snapshot epochs must increase monotonically')
        }
        slot.snapshotEpoch = snapshotEpoch
        temporalResidencyEpoch++
        return readSnapshot()
    }

    function advanceFrame(): Promise<TemporalVelocitySnapshot> {

        assertActive()
        if (advancePromise !== undefined) return advancePromise
        advancePromise = advanceOnce().finally(() => { advancePromise = undefined })
        return advancePromise
    }

    async function advanceOnce(): Promise<TemporalVelocitySnapshot> {

        if (frameInTime < framesPerTime - 1) {
            frameInTime++
            return readSnapshot()
        }

        const nextPrefetchIndex = wrapTime(prefetch.timeIndex + 1, fieldCount)
        const replacement = await createSlot(nextPrefetchIndex)
        const retired = current
        current = next
        next = prefetch
        prefetch = replacement
        generation++
        frameInTime = 0
        await disposeTracked(retired.runtime)
        return readSnapshot()
    }

    function dispose(): Promise<void> {

        if (disposePromise !== undefined) return disposePromise
        stopping = true
        abortController.abort(new Error('Temporal velocity disposal requested'))
        disposePromise = disposeOnce()
        return disposePromise
    }

    async function disposeOnce(): Promise<void> {

        if (disposed) return
        const failures: unknown[] = []
        const pendingAdvance = advancePromise
        if (pendingAdvance !== undefined) {
            try {
                await pendingAdvance
            } catch (error) {
                if (error !== abortController.signal.reason) failures.push(error)
            }
        }
        disposed = true
        const runtimes = [ current.runtime, next.runtime, prefetch.runtime ]
        failures.push(...await disposeAll(runtimes))
        if (failures.length > 0) {
            throw new AggregateError(failures, 'Temporal velocity disposal failed')
        }
    }

    async function disposeTracked(runtime: Runtime): Promise<void> {

        const index = created.indexOf(runtime)
        if (index < 0) throw new Error('Temporal velocity runtime ownership is unavailable')
        created.splice(index, 1)
        await options.disposeRuntime(runtime)
    }

    async function disposeAll(runtimes: readonly Runtime[]): Promise<unknown[]> {

        const failures: unknown[] = []
        for (const runtime of [ ...new Set(runtimes) ]) {
            const index = created.indexOf(runtime)
            if (index < 0) continue
            created.splice(index, 1)
            try {
                await options.disposeRuntime(runtime)
            } catch (error) {
                failures.push(error)
            }
        }
        return failures
    }

    function assertActive(): void {

        if (stopping || disposed) throw new Error('Temporal velocity raster is disposed')
    }

    return Object.freeze({
        get current() { return current.runtime },
        get next() { return next.runtime },
        get prefetch() { return prefetch.runtime },
        snapshot,
        recordPublication,
        advanceFrame,
        dispose,
    })
}

function requirePositiveInteger(value: number, label: string): number {

    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError(`${label} must be a positive safe integer`)
    }
    return value
}

function validTimeIndex(value: number, fieldCount: number): boolean {

    return Number.isSafeInteger(value) && value >= 0 && value < fieldCount
}

function wrapTime(value: number, fieldCount: number): number {

    return ((value % fieldCount) + fieldCount) % fieldCount
}
