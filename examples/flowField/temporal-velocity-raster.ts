import {
    webMercatorVirtualRasterWgslModule,
} from 'geoscratch/geo'
import type {
    VirtualRasterRuntimePublication,
    WebMercatorVirtualRasterField,
} from 'geoscratch/geo'
import type {
    BufferRegion,
    SubmissionBuilder,
    SubmittedWork,
    TextureViewSpec,
} from 'geoscratch/scratch'
import {
    createVelocityTimeRuntime,
} from './velocity-source.ts'
import type {
    FlowVelocityTimeRuntime,
    FlowVelocityTimeRuntimeOptions,
} from './velocity-source.ts'

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

export type FlowTemporalVelocityRasterOptions = Omit<
    FlowVelocityTimeRuntimeOptions,
    'timeIndex'
> & Readonly<{
    framesPerTime: number
    initialTimeIndex?: number
}>

export type TemporalVelocityBindResources = Readonly<{
    generation: number
    current: Readonly<{
        timeIndex: number
        pageTable: BufferRegion
        atlas: TextureViewSpec
    }>
    next: Readonly<{
        timeIndex: number
        pageTable: BufferRegion
        atlas: TextureViewSpec
    }>
}>

export type TemporalVelocityPublicationPair = Readonly<{
    generation: number
    currentTimeIndex: number
    nextTimeIndex: number
    current: VirtualRasterRuntimePublication
    next: VirtualRasterRuntimePublication
}>

export type TemporalVelocityRaster<Runtime> = Readonly<{
    readonly current: Runtime
    readonly next: Runtime
    readonly prefetch: Runtime
    snapshot(): TemporalVelocitySnapshot
    activeBindResources(): TemporalVelocityBindResources
    recordPublication(
        timeIndex: number,
        snapshotEpoch: number,
        generation?: number
    ): TemporalVelocitySnapshot
    setPendingPublications(
        current: VirtualRasterRuntimePublication,
        next: VirtualRasterRuntimePublication
    ): TemporalVelocityPublicationPair
    pendingPublication(): TemporalVelocityPublicationPair | undefined
    encodePending(builder: SubmissionBuilder): SubmissionBuilder
    acknowledgePending(submitted: SubmittedWork): Promise<TemporalVelocitySnapshot>
    advance(): Promise<TemporalVelocitySnapshot>
    advanceFrame(): Promise<TemporalVelocitySnapshot>
    dispose(): Promise<void>
}>

export type TemporalVelocityWgslOptions = Readonly<{
    group: number
    currentPageTableBinding: number
    currentAtlasBinding: number
    nextPageTableBinding: number
    nextAtlasBinding: number
    wrapper: string
    transitionTexels?: number
}>

export type TemporalVelocityWgslModule = Readonly<{
    kind: 'temporal-velocity-wgsl-module'
    code: string
    bindings: Readonly<{
        group: number
        current: Readonly<{ pageTable: number, atlas: number }>
        next: Readonly<{ pageTable: number, atlas: number }>
    }>
}>

type VelocitySlot<Runtime> = {
    timeIndex: number
    runtime: Runtime
    snapshotEpoch: number
}

type PublicationRuntime = Readonly<{
    gpu: Readonly<{
        pageTable: Readonly<{ region(): BufferRegion }>
        atlasView: TextureViewSpec
        encode(builder: SubmissionBuilder, update: VirtualRasterRuntimePublication['update']): unknown
    }>
    acknowledge(
        publication: VirtualRasterRuntimePublication,
        submitted: SubmittedWork
    ): Promise<void>
}>

type PendingPublicationState = {
    pair: TemporalVelocityPublicationPair
    encoded: boolean
    currentAcknowledged: boolean
    nextAcknowledged: boolean
}

export function createTemporalVelocityRaster(
    options: FlowTemporalVelocityRasterOptions
): Promise<TemporalVelocityRaster<FlowVelocityTimeRuntime>>
export function createTemporalVelocityRaster<Runtime>(
    options: TemporalVelocityRasterOptions<Runtime>
): Promise<TemporalVelocityRaster<Runtime>>

/** Owns a bounded current/next/prefetch window over immutable velocity runtimes. */
export async function createTemporalVelocityRaster<Runtime>(
    options: TemporalVelocityRasterOptions<Runtime> | FlowTemporalVelocityRasterOptions
): Promise<TemporalVelocityRaster<Runtime>> {

    const injected = isInjectedOptions(options)
    const fieldCount = requirePositiveInteger(
        injected ? options.fieldCount : options.manifest.times.length,
        'fieldCount'
    )
    const framesPerTime = requirePositiveInteger(options?.framesPerTime, 'framesPerTime')
    const initialTimeIndex = options?.initialTimeIndex ?? 0
    const createRuntime = injected
        ? options.createRuntime
        : async(timeIndex: number, signal: AbortSignal) => {
            if (signal.aborted) throw signal.reason
            const {
                framesPerTime: _framesPerTime,
                initialTimeIndex: _initialTimeIndex,
                ...runtimeOptions
            } = options
            const runtime = await createVelocityTimeRuntime({
                ...runtimeOptions,
                timeIndex,
            })
            if (!signal.aborted) return runtime as Runtime
            await runtime.dispose()
            throw signal.reason
        }
    const disposeRuntime = injected
        ? options.disposeRuntime
        : async(runtime: Runtime) => {
            await (runtime as FlowVelocityTimeRuntime).dispose()
        }
    if (fieldCount < 3 || !validTimeIndex(initialTimeIndex, fieldCount) ||
        typeof createRuntime !== 'function' || typeof disposeRuntime !== 'function') {
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
    let pending: PendingPublicationState | undefined

    async function createSlot(timeIndex: number): Promise<VelocitySlot<Runtime>> {

        const runtime = await createRuntime(timeIndex, abortController.signal)
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

    function activeBindResources(): TemporalVelocityBindResources {

        assertActive()
        const currentRuntime = publicationRuntime(current.runtime)
        const nextRuntime = publicationRuntime(next.runtime)
        return Object.freeze({
            generation,
            current: Object.freeze({
                timeIndex: current.timeIndex,
                pageTable: currentRuntime.gpu.pageTable.region(),
                atlas: currentRuntime.gpu.atlasView,
            }),
            next: Object.freeze({
                timeIndex: next.timeIndex,
                pageTable: nextRuntime.gpu.pageTable.region(),
                atlas: nextRuntime.gpu.atlasView,
            }),
        })
    }

    function recordPublication(
        timeIndex: number,
        snapshotEpoch: number,
        publicationGeneration = generation
    ): TemporalVelocitySnapshot {

        assertActive()
        if (publicationGeneration !== generation) {
            throw new Error('Velocity publication belongs to a stale generation')
        }
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

    function setPendingPublications(
        currentPublication: VirtualRasterRuntimePublication,
        nextPublication: VirtualRasterRuntimePublication
    ): TemporalVelocityPublicationPair {

        assertActive()
        if (pending !== undefined) {
            throw new Error('Temporal velocity publication is already pending')
        }
        if (currentPublication === undefined || nextPublication === undefined) {
            throw new TypeError('Temporal velocity requires current and next publications')
        }
        const pair = Object.freeze({
            generation,
            currentTimeIndex: current.timeIndex,
            nextTimeIndex: next.timeIndex,
            current: currentPublication,
            next: nextPublication,
        })
        pending = {
            pair,
            encoded: false,
            currentAcknowledged: false,
            nextAcknowledged: false,
        }
        return pair
    }

    function pendingPublication(): TemporalVelocityPublicationPair | undefined {

        return pending?.pair
    }

    function encodePending(builder: SubmissionBuilder): SubmissionBuilder {

        assertActive()
        const active = requirePending()
        if (active.encoded) throw new Error('Temporal velocity publication is already encoded')
        if (active.pair.generation !== generation) {
            throw new Error('Temporal velocity publication belongs to a stale generation')
        }
        publicationRuntime(current.runtime).gpu.encode(builder, active.pair.current.update)
        publicationRuntime(next.runtime).gpu.encode(builder, active.pair.next.update)
        active.encoded = true
        return builder
    }

    async function acknowledgePending(submitted: SubmittedWork): Promise<TemporalVelocitySnapshot> {

        assertActive()
        const active = requirePending()
        if (!active.encoded) throw new Error('Temporal velocity publication must be encoded first')
        if (active.pair.generation !== generation) {
            throw new Error('Temporal velocity publication belongs to a stale generation')
        }
        const attempts: Promise<void>[] = []
        const members: ('current' | 'next')[] = []
        if (!active.currentAcknowledged) {
            members.push('current')
            attempts.push(publicationRuntime(current.runtime).acknowledge(
                active.pair.current,
                submitted
            ))
        }
        if (!active.nextAcknowledged) {
            members.push('next')
            attempts.push(publicationRuntime(next.runtime).acknowledge(
                active.pair.next,
                submitted
            ))
        }
        const settlements = await Promise.allSettled(attempts)
        const failures: unknown[] = []
        for (const [ index, settlement ] of settlements.entries()) {
            if (settlement.status === 'rejected') {
                failures.push(settlement.reason)
            } else if (members[index] === 'current') {
                active.currentAcknowledged = true
            } else {
                active.nextAcknowledged = true
            }
        }
        if (active.currentAcknowledged) {
            recordAcknowledgedEpoch(current, active.pair.current.snapshotEpoch)
        }
        if (active.nextAcknowledged) {
            recordAcknowledgedEpoch(next, active.pair.next.snapshotEpoch)
        }
        if (failures.length > 0) {
            throw new AggregateError(failures, 'Temporal velocity publication acknowledgment failed')
        }
        pending = undefined
        return readSnapshot()
    }

    function advance(): Promise<TemporalVelocitySnapshot> {

        return advanceFrame()
    }

    function advanceFrame(): Promise<TemporalVelocitySnapshot> {

        assertActive()
        if (pending !== undefined) {
            throw new Error('Temporal velocity publication is pending')
        }
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
        pending = undefined
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
        await disposeRuntime(runtime)
    }

    async function disposeAll(runtimes: readonly Runtime[]): Promise<unknown[]> {

        const failures: unknown[] = []
        for (const runtime of [ ...new Set(runtimes) ]) {
            const index = created.indexOf(runtime)
            if (index < 0) continue
            created.splice(index, 1)
            try {
                await disposeRuntime(runtime)
            } catch (error) {
                failures.push(error)
            }
        }
        return failures
    }

    function assertActive(): void {

        if (stopping || disposed) throw new Error('Temporal velocity raster is disposed')
    }

    function requirePending(): PendingPublicationState {

        if (pending === undefined) throw new Error('Temporal velocity publication is not pending')
        return pending
    }

    function recordAcknowledgedEpoch(slot: VelocitySlot<Runtime>, snapshotEpoch: number): void {

        if (!Number.isSafeInteger(snapshotEpoch) || snapshotEpoch <= 0) {
            throw new RangeError('Velocity snapshot epochs must be positive safe integers')
        }
        if (snapshotEpoch < slot.snapshotEpoch) {
            throw new RangeError('Velocity snapshot epochs must increase monotonically')
        }
        if (snapshotEpoch === slot.snapshotEpoch) return
        slot.snapshotEpoch = snapshotEpoch
        temporalResidencyEpoch++
    }

    return Object.freeze({
        get current() { return current.runtime },
        get next() { return next.runtime },
        get prefetch() { return prefetch.runtime },
        snapshot,
        activeBindResources,
        recordPublication,
        setPendingPublications,
        pendingPublication,
        encodePending,
        acknowledgePending,
        advance,
        advanceFrame,
        dispose,
    })
}

/** Generates two public WebMercator samplers plus the example-local temporal wrapper. */
export function temporalVelocityWgslModule(
    current: WebMercatorVirtualRasterField,
    next: WebMercatorVirtualRasterField,
    options: TemporalVelocityWgslOptions
): TemporalVelocityWgslModule {

    assertCompatibleModels(current, next)
    const bindings = [
        options?.currentPageTableBinding,
        options?.currentAtlasBinding,
        options?.nextPageTableBinding,
        options?.nextAtlasBinding,
    ]
    if (!Number.isSafeInteger(options?.group) || options.group < 0 ||
        bindings.some(value => !Number.isSafeInteger(value) || Number(value) < 0) ||
        new Set(bindings).size !== bindings.length || typeof options.wrapper !== 'string' ||
        !options.wrapper.includes('fn FlowVelocity_sample(')) {
        throw new TypeError('Temporal velocity WGSL requires distinct bindings and its sample wrapper')
    }
    const addressNamespace = 'FlowVelocityAddress'
    const sharedAddress = current.addressCodec.wgslModule({ namespace: addressNamespace })
    const currentModule = webMercatorVirtualRasterWgslModule(current, {
        namespace: 'FlowVelocityCurrent',
        addressNamespace,
        group: options.group,
        pageTableBinding: options.currentPageTableBinding,
        atlasBinding: options.currentAtlasBinding,
        ...(options.transitionTexels === undefined
            ? {}
            : { transitionTexels: options.transitionTexels }),
    })
    const nextModule = webMercatorVirtualRasterWgslModule(next, {
        namespace: 'FlowVelocityNext',
        addressNamespace,
        group: options.group,
        pageTableBinding: options.nextPageTableBinding,
        atlasBinding: options.nextAtlasBinding,
        ...(options.transitionTexels === undefined
            ? {}
            : { transitionTexels: options.transitionTexels }),
    })
    const prefix = sharedAddress + '\n\n'
    if (!currentModule.code.startsWith(prefix) || !nextModule.code.startsWith(prefix)) {
        throw new TypeError('Temporal velocity models do not share one public address module')
    }
    return Object.freeze({
        kind: 'temporal-velocity-wgsl-module',
        code: [
            sharedAddress,
            currentModule.code.slice(prefix.length),
            nextModule.code.slice(prefix.length),
            options.wrapper,
        ].join('\n\n'),
        bindings: Object.freeze({
            group: options.group,
            current: Object.freeze({
                pageTable: options.currentPageTableBinding,
                atlas: options.currentAtlasBinding,
            }),
            next: Object.freeze({
                pageTable: options.nextPageTableBinding,
                atlas: options.nextAtlasBinding,
            }),
        }),
    })
}

function isInjectedOptions<Runtime>(
    options: TemporalVelocityRasterOptions<Runtime> | FlowTemporalVelocityRasterOptions
): options is TemporalVelocityRasterOptions<Runtime> {

    return typeof (options as Partial<TemporalVelocityRasterOptions<Runtime>>)?.createRuntime ===
        'function'
}

function publicationRuntime<Runtime>(runtime: Runtime): PublicationRuntime {

    const candidate = runtime as unknown as Partial<PublicationRuntime>
    if (candidate?.gpu?.pageTable?.region === undefined ||
        candidate.gpu.atlasView === undefined || typeof candidate.gpu.encode !== 'function' ||
        typeof candidate.acknowledge !== 'function') {
        throw new TypeError('Temporal velocity GPU hooks require a Flow velocity time runtime')
    }
    return candidate as PublicationRuntime
}

function assertCompatibleModels(
    current: WebMercatorVirtualRasterField,
    next: WebMercatorVirtualRasterField
): void {

    const currentLimits = current?.coverage?.limits
    const nextLimits = next?.coverage?.limits
    if (current?.kind !== 'web-mercator-virtual-raster-field' ||
        next?.kind !== 'web-mercator-virtual-raster-field' ||
        current.plane.fieldKind !== 'vector' || next.plane.fieldKind !== 'vector' ||
        current.plane.channels !== 2 || next.plane.channels !== 2 ||
        current.plane.sampleType !== 'float32' || next.plane.sampleType !== 'float32' ||
        current.plane.gpuFormat !== 'rg32float' || next.plane.gpuFormat !== 'rg32float' ||
        current.addressCodec.coordinateBits !== next.addressCodec.coordinateBits ||
        JSON.stringify(current.geographicBounds) !== JSON.stringify(next.geographicBounds) ||
        JSON.stringify(currentLimits) !== JSON.stringify(nextLimits)) {
        throw new TypeError('Temporal velocity WGSL requires compatible two-channel time models')
    }
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
