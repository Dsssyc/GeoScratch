import type {
    BindLayout,
    BindSet,
    BufferResource,
    TextureResource,
} from 'geoscratch/scratch'
import type {
    FlowVelocityTimeRuntime,
} from './velocity-source.ts'
import {
    temporalVelocityWgslModule,
} from './temporal-velocity-raster.ts'
import type {
    TemporalVelocityRaster,
    TemporalVelocityWgslModule,
} from './temporal-velocity-raster.ts'

export type FlowTemporalBindingFrame = Readonly<{
    bindSet: BindSet
    resources: readonly [
        BufferResource,
        TextureResource,
        BufferResource,
        TextureResource,
    ]
    progress: number
    requestedLevel: number
}>

export type FlowTemporalBindingFacts = Readonly<{
    kind: 'flow-temporal-bindings'
    generation: number
    temporalGeneration: number
    requestedLevel: number
    levelCount: number
    refreshCount: number
    ownsTemporal: false
    disposed: boolean
}>

export type FlowTemporalBindings = Readonly<{
    module: TemporalVelocityWgslModule
    wgsl: string
    layout: BindLayout
    readonly generation: number
    setRequestedLevel(level: number): void
    refresh(): Promise<boolean>
    frame(): FlowTemporalBindingFrame
    facts(): FlowTemporalBindingFacts
    dispose(): void
}>

export type FlowTemporalBindingsOptions = Readonly<{
    temporal: TemporalVelocityRaster<FlowVelocityTimeRuntime>
    requestedLevel?: number
    wrapper?: string
}>

type ActiveBindingState = Readonly<{
    generation: number
    bindSet: BindSet
    resources: FlowTemporalBindingFrame['resources']
}>

/** Owns one stable temporal layout and generation-specific current/next BindSet. */
export async function createFlowTemporalBindings(
    options: FlowTemporalBindingsOptions
): Promise<FlowTemporalBindings> {

    const temporal = options?.temporal
    const snapshot = temporal?.snapshot?.()
    const current = temporal?.current
    const next = temporal?.next
    const runtime = current?.gpu?.runtime
    if (snapshot === undefined || runtime === undefined || next?.gpu?.runtime !== runtime) {
        throw new TypeError('Flow temporal bindings require two same-runtime velocity slots')
    }
    const wrapper = options.wrapper ??
        (await import('./shaders/temporal-velocity.wgsl?raw')).default
    const module = createModule(current, next, wrapper)
    const levelCount = current.model.addressSpace.levelCount
    let requestedLevel = options.requestedLevel ?? 0
    validateRequestedLevel(requestedLevel, levelCount)
    const layout = await runtime.createBindLayout({
        label: 'Flow Field temporal velocity layout',
        group: 1,
        entries: [
            {
                binding: 0,
                name: 'currentPageTable',
                type: 'read-storage',
                visibility: [ 'compute' ],
            },
            {
                binding: 1,
                name: 'currentAtlas',
                type: 'texture',
                sampleType: 'unfilterable-float',
                viewDimension: '2d',
                visibility: [ 'compute' ],
            },
            {
                binding: 2,
                name: 'nextPageTable',
                type: 'read-storage',
                visibility: [ 'compute' ],
            },
            {
                binding: 3,
                name: 'nextAtlas',
                type: 'texture',
                sampleType: 'unfilterable-float',
                viewDimension: '2d',
                visibility: [ 'compute' ],
            },
        ],
    })
    let active: ActiveBindingState
    try {
        active = await createActiveState(temporal, layout, snapshot.generation)
    } catch (error) {
        layout.dispose()
        throw error
    }
    let refreshCount = 0
    let disposed = false

    function setRequestedLevel(level: number): void {

        assertActive()
        validateRequestedLevel(level, levelCount)
        requestedLevel = level
    }

    async function refresh(): Promise<boolean> {

        assertActive()
        const nextSnapshot = temporal.snapshot()
        if (nextSnapshot.generation === active.generation) return false
        validateRequestedLevel(requestedLevel, temporal.current.model.addressSpace.levelCount)
        const rotatedModule = createModule(temporal.current, temporal.next, wrapper)
        if (rotatedModule.code !== module.code) {
            throw new TypeError('Flow temporal rotation changed the stable WGSL contract')
        }
        const replacement = await createActiveState(
            temporal,
            layout,
            nextSnapshot.generation
        )
        const retired = active
        active = replacement
        refreshCount++
        retired.bindSet.dispose()
        return true
    }

    function frame(): FlowTemporalBindingFrame {

        assertActive()
        const currentSnapshot = temporal.snapshot()
        if (currentSnapshot.generation !== active.generation) {
            throw new Error('Flow temporal bindings require refresh after runtime rotation')
        }
        if (!Number.isFinite(currentSnapshot.progress) || currentSnapshot.progress < 0 ||
            currentSnapshot.progress > 1) {
            throw new RangeError('Flow temporal progress must remain within [0, 1]')
        }
        return Object.freeze({
            bindSet: active.bindSet,
            resources: active.resources,
            progress: currentSnapshot.progress,
            requestedLevel,
        })
    }

    function facts(): FlowTemporalBindingFacts {

        const temporalGeneration = disposed
            ? active.generation
            : temporal.snapshot().generation
        return Object.freeze({
            kind: 'flow-temporal-bindings',
            generation: active.generation,
            temporalGeneration,
            requestedLevel,
            levelCount,
            refreshCount,
            ownsTemporal: false,
            disposed,
        })
    }

    function dispose(): void {

        if (disposed) return
        disposed = true
        active.bindSet.dispose()
        layout.dispose()
    }

    function assertActive(): void {

        if (disposed) throw new Error('Flow temporal bindings are disposed')
    }

    return Object.freeze({
        module,
        wgsl: module.code,
        layout,
        get generation() { return active.generation },
        setRequestedLevel,
        refresh,
        frame,
        facts,
        dispose,
    })
}

async function createActiveState(
    temporal: TemporalVelocityRaster<FlowVelocityTimeRuntime>,
    layout: BindLayout,
    expectedGeneration: number
): Promise<ActiveBindingState> {

    const bindings = temporal.activeBindResources()
    if (bindings.generation !== expectedGeneration) {
        throw new Error('Flow temporal binding resources changed during refresh')
    }
    const runtime = temporal.current.gpu.runtime
    const bindSet = await runtime.createBindSet(layout, {
        currentPageTable: bindings.current.pageTable,
        currentAtlas: bindings.current.atlas,
        nextPageTable: bindings.next.pageTable,
        nextAtlas: bindings.next.atlas,
    }, { label: `Flow Field temporal velocity generation ${expectedGeneration}` })
    return Object.freeze({
        generation: expectedGeneration,
        bindSet,
        resources: Object.freeze([
            bindings.current.pageTable.buffer,
            bindings.current.atlas.texture,
            bindings.next.pageTable.buffer,
            bindings.next.atlas.texture,
        ] as [BufferResource, TextureResource, BufferResource, TextureResource]),
    })
}

function createModule(
    current: FlowVelocityTimeRuntime,
    next: FlowVelocityTimeRuntime,
    wrapper: string
): TemporalVelocityWgslModule {

    return temporalVelocityWgslModule(current.model, next.model, {
        group: 1,
        currentPageTableBinding: 0,
        currentAtlasBinding: 1,
        nextPageTableBinding: 2,
        nextAtlasBinding: 3,
        wrapper,
    })
}

function validateRequestedLevel(level: number, levelCount: number): void {

    if (!Number.isSafeInteger(level) || level < 0 || level >= levelCount) {
        throw new RangeError(
            `Flow temporal requested level must be within [0, ${levelCount - 1}]`
        )
    }
}
