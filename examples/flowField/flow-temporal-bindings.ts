import { createWebMercatorVirtualRasterSamplerBinding } from 'geoscratch/geo'
import type { WebMercatorVirtualRasterSamplerBinding } from 'geoscratch/geo'
import type {
    BindLayout,
    BindSet,
    BufferResource,
    GPURuntime,
    TextureResource,
} from 'geoscratch/scratch'
import type {
    FlowTemporalReadyCapture,
    FlowTemporalRuntimeCapture,
    FlowTemporalRuntimeWindow,
} from './flow-temporal-runtime-window.ts'
import {
    temporalVelocityWgslModule,
} from './temporal-velocity-raster.ts'
import type {
    TemporalVelocityWgslModule,
} from './temporal-velocity-raster.ts'
import type {
    FlowVelocitySampleRuntime,
} from './velocity-source.ts'

export type FlowTemporalBindingRuntime = FlowVelocitySampleRuntime

type ReadyPairCapture = FlowTemporalReadyCapture<FlowTemporalBindingRuntime>
type NonReadyPairCapture = Exclude<
    FlowTemporalRuntimeCapture<FlowTemporalBindingRuntime>,
    ReadyPairCapture
>

export type FlowTemporalReadyBindingFrame = Readonly<{
    state: 'ready'
    temporal: ReadyPairCapture
    requestedRevision: number
    pairGeneration: number
    bindSet: BindSet
    /** Endpoint page table/atlas pairs come first; immutable metadata follows when present. */
    resources: readonly [
        BufferResource,
        TextureResource,
        BufferResource,
        TextureResource,
        ...([] | [BufferResource, BufferResource]),
    ]
    progress: number
    requestedLevel: number
    sampleRegistration: 'global-texel-lattice' | 'pixel-center'
    release(): void
}>

export type FlowTemporalBindingFrame =
    | FlowTemporalReadyBindingFrame
    | NonReadyPairCapture

export type FlowTemporalBindingFacts = Readonly<{
    kind: 'flow-temporal-bindings'
    pairGeneration: number
    windowPairGeneration: number
    levelCount: number
    refreshCount: number
    activeFrameCount: number
    retiredBindingCount: number
    suspending: boolean
    ownsWindow: false
    disposed: boolean
}>

export type FlowTemporalBindings = Readonly<{
    module: TemporalVelocityWgslModule
    wgsl: string
    layout: BindLayout
    readonly pairGeneration: number
    prepareFrame(requestedLevel: number): Promise<FlowTemporalBindingFrame>
    suspend(): Promise<void>
    facts(): FlowTemporalBindingFacts
    dispose(): Promise<void>
}>

export type FlowTemporalBindingsOptions = Readonly<{
    window: FlowTemporalRuntimeWindow<FlowTemporalBindingRuntime>
    wrapper?: string
}>

type BindingState = {
    pairGeneration: number
    capture: ReadyPairCapture
    bindSet: BindSet
    resources: FlowTemporalReadyBindingFrame['resources']
    samplerBindings: readonly WebMercatorVirtualRasterSamplerBinding[]
    frameCount: number
    retiring: boolean
    released: boolean
}

/** Reports only a window generation race while an asynchronous BindSet refresh was pending. */
export class FlowTemporalBindingSupersededError extends Error {

    constructor(message: string) {
        super(message)
        this.name = 'FlowTemporalBindingSupersededError'
    }
}

/** Owns one stable temporal layout and pair-generation BindSet leases. */
export async function createFlowTemporalBindings(
    options: FlowTemporalBindingsOptions
): Promise<FlowTemporalBindings> {

    const window = options?.window
    if (typeof window?.capture !== 'function' || typeof window.snapshot !== 'function') {
        throw new TypeError('Flow temporal bindings require one runtime window')
    }
    const wrapper = options.wrapper ??
        (await import('./shaders/temporal-velocity.wgsl?raw')).default
    const initialCapture = window.capture()
    if (initialCapture.state !== 'ready') {
        throw new TypeError('Flow temporal bindings require an initially ready runtime pair')
    }
    let module: TemporalVelocityWgslModule
    let runtime: GPURuntime
    try {
        module = createModule(initialCapture, wrapper)
        runtime = requireSharedRuntime(initialCapture)
    } catch (error) {
        initialCapture.release()
        throw error
    }
    let layout: BindLayout
    try {
        layout = await runtime.createBindLayout({
            label: 'Flow Field temporal velocity layout',
            group: 1,
            entries: [
                {
                    binding: 0,
                    name: 'currentPageTable',
                    type: 'read-storage',
                    visibility: [ 'compute', 'fragment' ],
                },
                {
                    binding: 1,
                    name: 'currentAtlas',
                    type: 'texture',
                    sampleType: 'unfilterable-float',
                    viewDimension: '2d',
                    visibility: [ 'compute', 'fragment' ],
                },
                {
                    binding: 2,
                    name: 'nextPageTable',
                    type: 'read-storage',
                    visibility: [ 'compute', 'fragment' ],
                },
                {
                    binding: 3,
                    name: 'nextAtlas',
                    type: 'texture',
                    sampleType: 'unfilterable-float',
                    viewDimension: '2d',
                    visibility: [ 'compute', 'fragment' ],
                },
                { binding: 4, name: 'currentMetadata', type: 'uniform', visibility: [ 'compute', 'fragment' ] },
                { binding: 5, name: 'nextMetadata', type: 'uniform', visibility: [ 'compute', 'fragment' ] },
            ],
        })
    } catch (error) {
        initialCapture.release()
        throw error
    }
    let active: BindingState | undefined
    try {
        active = await createBindingState(
            initialCapture,
            layout,
            module,
            wrapper,
            runtime
        )
    } catch (error) {
        layout.dispose()
        throw error
    }
    let levelCount = initialCapture.lower.runtime.model.addressSpace.levelCount
    const retired = new Set<BindingState>()
    const retirementWaiters = new Set<() => void>()
    const cleanupFailures: unknown[] = []
    let refreshCount = 0
    let disposed = false
    let preparing: Promise<FlowTemporalBindingFrame> | undefined
    let suspendPromise: Promise<void> | undefined
    let disposePromise: Promise<void> | undefined

    function prepareFrame(requestedLevel: number): Promise<FlowTemporalBindingFrame> {

        assertActive()
        if (suspendPromise !== undefined) {
            throw new Error('Flow temporal bindings are being suspended')
        }
        if (preparing !== undefined) {
            throw new Error('Flow temporal bindings permit one frame preparation at a time')
        }
        const capture = window.capture()
        try {
            validateRequestedLevel(requestedLevel, capture.state === 'ready'
                ? capture.lower.runtime.model.addressSpace.levelCount : levelCount)
        } catch (error) {
            if (capture.state === 'ready') capture.release()
            throw error
        }
        let tracked: Promise<FlowTemporalBindingFrame>
        tracked = prepareFrameOnce(requestedLevel, capture).finally(() => {
            if (preparing === tracked) preparing = undefined
        })
        preparing = tracked
        return tracked
    }

    async function prepareFrameOnce(
        requestedLevel: number, capture: FlowTemporalRuntimeCapture<FlowTemporalBindingRuntime>
    ): Promise<FlowTemporalBindingFrame> {

        let frameCapture = capture
        if (frameCapture.state !== 'ready') {
            if (frameCapture.state === 'gap' && active !== undefined) {
                const prior = active
                active = undefined
                retire(prior)
            }
            return frameCapture
        }
        if (active?.pairGeneration !== frameCapture.pairGeneration) {
            const replacement = await createBindingState(
                frameCapture,
                layout,
                module,
                wrapper,
                runtime
            )
            const current = window.snapshot()
            if (disposed || current.state !== 'ready' ||
                current.pairGeneration !== replacement.pairGeneration) {
                releaseBindingState(replacement)
                if (disposed) throw new Error('Flow temporal bindings are disposed')
                throw new FlowTemporalBindingSupersededError(
                    'Flow temporal runtime pair changed during binding refresh'
                )
            }
            const prior = active
            active = replacement
            levelCount = replacement.capture.lower.runtime.model.addressSpace.levelCount
            refreshCount++
            if (prior !== undefined) retire(prior)
            frameCapture = window.capture()
            if (frameCapture.state !== 'ready' ||
                frameCapture.pairGeneration !== replacement.pairGeneration) {
                if (frameCapture.state === 'ready') frameCapture.release()
                throw new FlowTemporalBindingSupersededError(
                    'Flow temporal runtime pair changed before frame capture'
                )
            }
        }
        const state = active
        if (state === undefined || state.pairGeneration !== frameCapture.pairGeneration) {
            frameCapture.release()
            throw new Error('Flow temporal bindings require refresh for the current pair')
        }
        if (frameCapture.lower.runtime.source.sampleRegistration !== module.sampleRegistration ||
            frameCapture.upper.runtime.source.sampleRegistration !== module.sampleRegistration) {
            frameCapture.release()
            throw new TypeError('Flow temporal frame registration changed after binding creation')
        }
        state.frameCount++
        let released = false
        return Object.freeze({
            state: 'ready' as const,
            temporal: frameCapture,
            requestedRevision: frameCapture.requestedRevision,
            pairGeneration: frameCapture.pairGeneration,
            bindSet: state.bindSet,
            resources: state.resources,
            progress: frameCapture.alpha,
            requestedLevel,
            sampleRegistration: module.sampleRegistration,
            release() {

                if (released) return
                released = true
                try {
                    frameCapture.release()
                } catch (error) {
                    recordCleanupFailure(error)
                }
                state.frameCount--
                if (state.frameCount < 0) {
                    recordCleanupFailure(
                        new Error('Flow temporal binding frame count underflowed')
                    )
                    return
                }
                if (state.retiring && state.frameCount === 0) releaseBindingState(state)
            },
        })
    }

    function retire(state: BindingState): void {

        if (state.retiring) return
        state.retiring = true
        retired.add(state)
        if (state.frameCount === 0) releaseBindingState(state)
    }

    function releaseBindingState(state: BindingState): void {

        if (state.released) return
        state.released = true
        retired.delete(state)
        try {
            state.bindSet.dispose()
        } catch (error) {
            recordCleanupFailure(error)
        }
        for (const binding of state.samplerBindings) {
            try { binding.dispose() } catch (error) { recordCleanupFailure(error) }
        }
        try {
            state.capture.release()
        } catch (error) {
            recordCleanupFailure(error)
        }
        if (retired.size === 0) {
            for (const resolve of retirementWaiters) resolve()
            retirementWaiters.clear()
        }
    }

    function facts(): FlowTemporalBindingFacts {

        const snapshot = window.snapshot()
        return Object.freeze({
            kind: 'flow-temporal-bindings' as const,
            pairGeneration: active?.pairGeneration ?? 0,
            windowPairGeneration: snapshot.pairGeneration,
            levelCount,
            refreshCount,
            activeFrameCount: (active?.frameCount ?? 0) + [ ...retired ]
                .reduce((count, state) => count + state.frameCount, 0),
            retiredBindingCount: retired.size,
            suspending: suspendPromise !== undefined,
            ownsWindow: false as const,
            disposed,
        })
    }

    function suspend(): Promise<void> {

        assertActive()
        if (suspendPromise !== undefined) return suspendPromise
        let tracked: Promise<void>
        tracked = suspendOnce().finally(() => {
            if (suspendPromise === tracked) suspendPromise = undefined
        })
        suspendPromise = tracked
        return tracked
    }

    async function suspendOnce(): Promise<void> {

        if (preparing !== undefined) await Promise.allSettled([ preparing ])
        if (active !== undefined) {
            const prior = active
            active = undefined
            retire(prior)
        }
        if (cleanupFailures.length > 0) {
            throw new AggregateError(
                [ ...cleanupFailures ],
                'Flow temporal bindings failed to suspend'
            )
        }
    }

    function dispose(): Promise<void> {

        if (disposePromise !== undefined) return disposePromise
        disposed = true
        disposePromise = disposeAll()
        return disposePromise
    }

    async function disposeAll(): Promise<void> {

        if (suspendPromise !== undefined) await Promise.allSettled([ suspendPromise ])
        if (preparing !== undefined) await Promise.allSettled([ preparing ])
        if (active !== undefined) {
            const prior = active
            active = undefined
            retire(prior)
        }
        while (retired.size > 0) {
            await new Promise<void>(resolve => { retirementWaiters.add(resolve) })
        }
        try {
            layout.dispose()
        } catch (error) {
            recordCleanupFailure(error)
        }
        if (cleanupFailures.length > 0) {
            throw new AggregateError(
                [ ...cleanupFailures ],
                'Flow temporal binding disposal failed'
            )
        }
    }

    function recordCleanupFailure(error: unknown): void {

        if (!cleanupFailures.includes(error)) cleanupFailures.push(error)
    }

    function assertActive(): void {

        if (disposed) throw new Error('Flow temporal bindings are disposed')
        if (cleanupFailures.length > 0) {
            throw new AggregateError(
                [ ...cleanupFailures ],
                'Flow temporal bindings have a cleanup failure'
            )
        }
    }

    return Object.freeze({
        module,
        wgsl: module.code,
        layout,
        get pairGeneration() { return active?.pairGeneration ?? 0 },
        prepareFrame,
        suspend,
        facts,
        dispose,
    })
}

async function createBindingState(
    capture: ReadyPairCapture,
    layout: BindLayout,
    stableModule: TemporalVelocityWgslModule,
    wrapper: string,
    runtime: GPURuntime
): Promise<BindingState> {

    const samplerBindings: WebMercatorVirtualRasterSamplerBinding[] = []
    try {
        if (requireSharedRuntime(capture) !== runtime) {
            throw new TypeError('Flow temporal runtime pair changed its GPURuntime')
        }
        const rotated = createModule(capture, wrapper)
        if (rotated.code !== stableModule.code ||
            rotated.sampleRegistration !== stableModule.sampleRegistration) {
            throw new TypeError('Flow temporal rotation changed the stable WGSL contract')
        }
        const lower = capture.lower.runtime
        const upper = capture.upper.runtime
        const currentBinding = await createWebMercatorVirtualRasterSamplerBinding(lower.model, lower.gpu)
        samplerBindings.push(currentBinding)
        const nextBinding = lower === upper ? currentBinding
            : await createWebMercatorVirtualRasterSamplerBinding(upper.model, upper.gpu)
        if (nextBinding !== currentBinding) samplerBindings.push(nextBinding)
        const lowerPageTable = currentBinding.pageTable
        const upperPageTable = nextBinding.pageTable
        const bindSet = await runtime.createBindSet(layout, {
            currentPageTable: lowerPageTable,
            currentAtlas: currentBinding.atlas,
            nextPageTable: upperPageTable,
            nextAtlas: nextBinding.atlas,
            currentMetadata: currentBinding.metadata,
            nextMetadata: nextBinding.metadata,
        }, { label: `Flow Field temporal velocity pair ${capture.pairGeneration}` })
        return {
            pairGeneration: capture.pairGeneration,
            capture,
            bindSet,
            samplerBindings,
            resources: Object.freeze([
                lowerPageTable.buffer,
                currentBinding.atlas.texture,
                upperPageTable.buffer,
                nextBinding.atlas.texture,
                currentBinding.metadata.buffer,
                nextBinding.metadata.buffer,
            ] as [BufferResource, TextureResource, BufferResource, TextureResource, BufferResource, BufferResource]),
            frameCount: 0,
            retiring: false,
            released: false,
        }
    } catch (error) {
        const failures: unknown[] = [error]
        for (const binding of samplerBindings) {
            try { binding.dispose() } catch (failure) { failures.push(failure) }
        }
        try { capture.release() } catch (failure) { failures.push(failure) }
        if (failures.length > 1) throw new AggregateError(failures, 'Flow temporal binding creation cleanup failed')
        throw error
    }
}

function createModule(
    capture: ReadyPairCapture,
    wrapper: string
): TemporalVelocityWgslModule {

    const lower = capture.lower.runtime
    const upper = capture.upper.runtime
    const sampleRegistration = lower.source.sampleRegistration
    const activitySupport = lower.source.representation?.activitySupport ?? 'bilinear'
    if (upper.source.sampleRegistration !== sampleRegistration ||
        (upper.source.representation?.activitySupport ?? 'bilinear') !== activitySupport) {
        throw new TypeError('Flow temporal samples require one shared registration')
    }
    return temporalVelocityWgslModule(lower.model, upper.model, {
        group: 1,
        currentPageTableBinding: 0,
        currentAtlasBinding: 1,
        nextPageTableBinding: 2,
        nextAtlasBinding: 3,
        currentMetadataBinding: 4,
        nextMetadataBinding: 5,
        wrapper,
        sampleRegistration,
        activitySupport,
    })
}

function requireSharedRuntime(capture: ReadyPairCapture): GPURuntime {

    const lower = capture.lower.runtime.gpu.runtime
    const upper = capture.upper.runtime.gpu.runtime
    if (lower === undefined || upper !== lower) {
        throw new TypeError('Flow temporal bindings require one shared GPURuntime')
    }
    return lower
}

function validateRequestedLevel(level: number, levelCount: number): void {

    if (!Number.isSafeInteger(level) || level < 0 || level >= levelCount) {
        throw new RangeError(
            `Flow temporal requested level must be within [0, ${levelCount - 1}]`
        )
    }
}
