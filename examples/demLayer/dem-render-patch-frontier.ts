import {
    layoutCodec,
} from 'geoscratch/scratch'
import type {
    BindLayout,
    BindLayoutEntry,
    BindSet,
    BufferRegion,
    BufferResource,
    ClearBufferCommand,
    ComputePassSpec,
    ComputePipeline,
    DispatchCommand,
    GPURuntime,
    Program,
    ShaderModule,
    SubmissionBuilder,
    UploadCommand,
} from 'geoscratch/scratch'
import {
    gpuTileFrontierRenderWgslModule,
} from 'geoscratch/geo'
import type {
    GpuTileFrontierFrame,
    GpuTileFrontierRenderTemplate,
} from 'geoscratch/geo'

export const DEM_MAX_RENDER_MATRIX_LEVEL = 14
export const DEM_MAX_RENDER_EXTRA_LEVELS = 4

const WORKGROUP_SIZE = 64
const DRAW_ARGUMENT_BYTES = 16
const DRAW_ARGUMENT_COUNT = 2
const STATE_BYTES = 16
const bufferUsage = globalThis.GPUBufferUsage ?? Object.freeze({
    COPY_DST: 0x08,
    COPY_SRC: 0x04,
    UNIFORM: 0x40,
    STORAGE: 0x80,
    INDIRECT: 0x100,
})

const renderPatchCodec = layoutCodec({
    name: 'DemRenderPatch',
    fields: [
        { name: 'matrixLevel', type: 'u32' },
        { name: 'tileRow', type: 'u32' },
        { name: 'tileCol', type: 'u32' },
        { name: 'samplingLevel', type: 'u32' },
        { name: 'sourceMatrixLevel', type: 'u32' },
        { name: 'sourceTileRow', type: 'u32' },
        { name: 'sourceTileCol', type: 'u32' },
        { name: 'sourceCompactIndex', type: 'u32' },
    ],
}, { usage: [ 'storage', 'readback' ] })

const renderPatchPolicyCodec = layoutCodec({
    name: 'DemRenderPatchPolicy',
    fields: [
        { name: 'dataMaximumMatrixLevel', type: 'u32' },
        { name: 'renderMaximumMatrixLevel', type: 'u32' },
        { name: 'maximumExtraLevels', type: 'u32' },
        { name: 'maximumRenderPatches', type: 'u32' },
        { name: 'minimumElevationMeters', type: 'f32' },
        { name: 'maximumElevationMeters', type: 'f32' },
        { name: 'coordinateBits', type: 'u32' },
        { name: 'lodMapVertexCount', type: 'u32' },
        { name: 'terrainVertexCount', type: 'u32' },
        { name: 'reserved0', type: 'u32' },
        { name: 'reserved1', type: 'u32' },
        { name: 'reserved2', type: 'u32' },
    ],
}, { usage: [ 'uniform', 'storage', 'readback' ] })

type Disposable = { dispose(): void }
type BufferBindingType = 'uniform' | 'read-storage' | 'storage'

type DrawTemplateId = 'lod-map' | 'terrain'

export type DemRenderPatchRenderTemplate = Readonly<{
    frontierId: string
    parity: 0 | 1
    templateId: DrawTemplateId
    mapMeta: BufferResource
    visibleInstances: BufferResource
    drawArgument: Readonly<{
        resource: BufferResource
        region: BufferRegion
        offset: number
        size: 16
    }>
}>

type ParityResources = Readonly<{
    parity: 0 | 1
    source: GpuTileFrontierRenderTemplate
    renderPatches: BufferResource
    state: BufferResource
    drawArguments: BufferResource
}>

type ParityCommands = Readonly<{
    reset: DispatchCommand
    expand: DispatchCommand
    finalize: DispatchCommand
}>

export type DemRenderPatchFrontierFacts = Readonly<{
    id: string
    selectionPath: 'gpu-expanded-render-patches'
    disposed: boolean
    dataMaximumMatrixLevel: number
    maximumMatrixLevel: number
    maximumExtraLevels: number
    maximumSourceTiles: number
    maximumRenderPatches: number
    renderPatchBytes: number
    drawArgumentBytes: number
    workgroupSize: number
    parity: readonly Readonly<{
        parity: 0 | 1
        sourceBufferId: string
        renderPatchBufferId: string
        stateBufferId: string
        drawArgumentBufferId: string
        commandIds: readonly string[]
    }>[]
}>

type IdentityObjects = Readonly<{
    resources: readonly BufferResource[]
    uploads: readonly UploadCommand[]
    bindLayouts: readonly BindLayout[]
    bindSets: readonly BindSet[]
    programs: readonly Program[]
    pipelines: readonly ComputePipeline[]
    passes: readonly ComputePassSpec[]
    commands: readonly (ClearBufferCommand | DispatchCommand)[]
}>

export type DemRenderPatchFrontier = Readonly<{
    id: string
    initialize(builder: SubmissionBuilder): SubmissionBuilder
    encode(builder: SubmissionBuilder, frame: GpuTileFrontierFrame): SubmissionBuilder
    renderTemplates(id: DrawTemplateId): readonly [
        DemRenderPatchRenderTemplate,
        DemRenderPatchRenderTemplate,
    ]
    commandsFor(frame: GpuTileFrontierFrame): ParityCommands
    facts(): DemRenderPatchFrontierFacts
    identityObjects(): IdentityObjects
    dispose(): void
}>

export type DemRenderPatchFrontierOptions = Readonly<{
    sourceTemplates: readonly [
        GpuTileFrontierRenderTemplate,
        GpuTileFrontierRenderTemplate,
    ]
    maximumSourceTiles: number
    dataMaximumMatrixLevel: number
    renderMaximumMatrixLevel?: number
    maximumExtraLevels?: number
    coordinateBits: number
    elevationRangeMeters: readonly [number, number]
    terrainVertexCount: number
    shader: string
}>

let nextRenderPatchFrontierId = 1

export function demRenderPatchTargetMatrixLevel(
    sourceMatrixLevel: number,
    zoomHint: number,
    options: Readonly<{
        maximumMatrixLevel?: number
        maximumExtraLevels?: number
    }> = {}
): number {

    if (!Number.isInteger(sourceMatrixLevel) || sourceMatrixLevel < 0) {
        throw new TypeError('DEM render-patch source matrix level must be a non-negative integer')
    }
    if (!Number.isFinite(zoomHint) || zoomHint < 0) {
        throw new TypeError('DEM render-patch zoom hint must be a finite non-negative number')
    }
    const maximumMatrixLevel = options.maximumMatrixLevel ?? DEM_MAX_RENDER_MATRIX_LEVEL
    const maximumExtraLevels = options.maximumExtraLevels ?? DEM_MAX_RENDER_EXTRA_LEVELS
    if (!Number.isInteger(maximumMatrixLevel) || maximumMatrixLevel < sourceMatrixLevel) {
        throw new TypeError('DEM render-patch maximum matrix level is invalid')
    }
    if (!Number.isInteger(maximumExtraLevels) || maximumExtraLevels < 0 ||
        maximumExtraLevels > DEM_MAX_RENDER_EXTRA_LEVELS) {
        throw new TypeError('DEM render-patch maximum extra levels is invalid')
    }
    return Math.max(sourceMatrixLevel, Math.min(
        maximumMatrixLevel,
        sourceMatrixLevel + maximumExtraLevels,
        Math.ceil(zoomHint)
    ))
}

export function demRenderPatchWgslModule() {

    const frontier = gpuTileFrontierRenderWgslModule()
    return Object.freeze({
        code: [
            frontier.code,
            renderPatchCodec.wgslAccessors({ namespace: 'DemRenderPatch' }),
        ].join('\n'),
        layoutDependencies: Object.freeze([
            ...frontier.layoutDependencies,
            renderPatchCodec.artifact,
        ]),
    })
}

export async function createDemRenderPatchFrontier(
    runtime: GPURuntime,
    options: DemRenderPatchFrontierOptions
): Promise<DemRenderPatchFrontier> {

    const descriptor = validateOptions(runtime, options)
    const id = `dem-render-patch-frontier-${nextRenderPatchFrontierId++}`
    const maximumRenderPatches = descriptor.maximumSourceTiles *
        4 ** descriptor.maximumExtraLevels
    const renderPatchBytes = maximumRenderPatches * renderPatchCodec.byteLength()
    const owned: Disposable[] = []
    const own = <Value extends Disposable>(value: Value): Value => {
        owned.push(value)
        return value
    }
    let disposed = false

    try {
        const policy = own(await runtime.createBuffer({
            label: 'DEM render-patch policy',
            size: renderPatchPolicyCodec.byteLength(),
            usage: bufferUsage.COPY_DST | bufferUsage.UNIFORM,
        }))
        const policyUpload = own(runtime.createUploadCommand({
            label: 'Upload DEM render-patch policy',
            target: policy.region({ layout: renderPatchPolicyCodec.artifact }),
            data: renderPatchPolicyCodec.pack({
                dataMaximumMatrixLevel: descriptor.dataMaximumMatrixLevel,
                renderMaximumMatrixLevel: descriptor.renderMaximumMatrixLevel,
                maximumExtraLevels: descriptor.maximumExtraLevels,
                maximumRenderPatches,
                minimumElevationMeters: descriptor.elevationRangeMeters[0],
                maximumElevationMeters: descriptor.elevationRangeMeters[1],
                coordinateBits: descriptor.coordinateBits,
                lodMapVertexCount: 4,
                terrainVertexCount: descriptor.terrainVertexCount,
                reserved0: 0,
                reserved1: 0,
                reserved2: 0,
            }),
        }))
        const parityResources = await Promise.all(descriptor.sourceTemplates.map(
            async(source, parityValue): Promise<ParityResources> => {
                const parity = parityValue as 0 | 1
                return Object.freeze({
                    parity,
                    source,
                    renderPatches: own(await runtime.createBuffer({
                        label: `DEM render patches ${parity}`,
                        size: renderPatchBytes,
                        usage: bufferUsage.COPY_DST | bufferUsage.STORAGE,
                    })),
                    state: own(await runtime.createBuffer({
                        label: `DEM render-patch state ${parity}`,
                        size: STATE_BYTES,
                        usage: bufferUsage.COPY_DST | bufferUsage.COPY_SRC |
                            bufferUsage.STORAGE,
                    })),
                    drawArguments: own(await runtime.createBuffer({
                        label: `DEM render-patch draw arguments ${parity}`,
                        size: DRAW_ARGUMENT_BYTES * DRAW_ARGUMENT_COUNT,
                        usage: bufferUsage.COPY_DST | bufferUsage.STORAGE |
                            bufferUsage.INDIRECT,
                    })),
                })
            }
        )) as unknown as readonly [ParityResources, ParityResources]
        const initializationClears = Object.freeze(parityResources.flatMap(resources => [
            own(runtime.createClearBufferCommand({
                label: `Clear DEM render patches ${resources.parity}`,
                target: resources.renderPatches.region(),
            })),
            own(runtime.createClearBufferCommand({
                label: `Clear DEM render-patch state ${resources.parity}`,
                target: resources.state.region(),
            })),
            own(runtime.createClearBufferCommand({
                label: `Clear DEM render-patch draw arguments ${resources.parity}`,
                target: resources.drawArguments.region(),
            })),
        ]))
        const shared = gpuTileFrontierRenderWgslModule()
        const shader = own(await runtime.createShaderModule({
            label: 'DEM render-patch frontier shader',
            sourceParts: [
                {
                    label: 'DEM render-patch shared ABI',
                    code: [
                        shared.code,
                        renderPatchCodec.wgslAccessors({ namespace: 'DemRenderPatch' }),
                        renderPatchPolicyCodec.wgslAccessors({
                            namespace: 'DemRenderPatchPolicy',
                        }),
                    ].join('\n'),
                    layoutDependencies: [
                        ...shared.layoutDependencies,
                        renderPatchCodec.artifact,
                        renderPatchPolicyCodec.artifact,
                    ],
                },
                { label: 'DEM render-patch kernels', code: descriptor.shader },
            ],
        }))
        const pass = own(runtime.createComputePass({
            label: 'DEM render-patch frontier stage',
        }))
        const resetKernel = await createKernel(
            runtime,
            shader,
            'resetRenderPatches',
            'DEM reset render patches',
            [
                binding(1, 'renderPatchPolicy', 'uniform', renderPatchPolicyCodec.byteLength()),
                binding(5, 'renderPatchState', 'storage', STATE_BYTES),
                binding(
                    6,
                    'drawArguments',
                    'storage',
                    DRAW_ARGUMENT_BYTES * DRAW_ARGUMENT_COUNT
                ),
            ],
            own
        )
        const expandKernel = await createKernel(
            runtime,
            shader,
            'expandRenderPatches',
            'DEM expand render patches',
            [
                binding(0, 'mapMeta', 'uniform', descriptor.sourceTemplates[0].mapMeta.size),
                binding(1, 'renderPatchPolicy', 'uniform', renderPatchPolicyCodec.byteLength()),
                binding(
                    2,
                    'sourceVisibleInstances',
                    'read-storage',
                    descriptor.sourceTemplates[0].visibleInstances.size
                ),
                binding(3, 'sourceDrawArguments', 'read-storage', DRAW_ARGUMENT_BYTES),
                binding(4, 'renderPatches', 'storage', renderPatchBytes),
                binding(5, 'renderPatchState', 'storage', STATE_BYTES),
            ],
            own
        )
        const finalizeKernel = await createKernel(
            runtime,
            shader,
            'finalizeRenderPatches',
            'DEM finalize render patches',
            [
                binding(1, 'renderPatchPolicy', 'uniform', renderPatchPolicyCodec.byteLength()),
                binding(5, 'renderPatchState', 'storage', STATE_BYTES),
                binding(
                    6,
                    'drawArguments',
                    'storage',
                    DRAW_ARGUMENT_BYTES * DRAW_ARGUMENT_COUNT
                ),
            ],
            own
        )
        const bindSets: BindSet[] = []
        const commands = await Promise.all(parityResources.map(async resources => {
            const resetSet = own(await runtime.createBindSet(resetKernel.layout, {
                renderPatchPolicy: policy.region({ layout: renderPatchPolicyCodec.artifact }),
                renderPatchState: resources.state.region(),
                drawArguments: resources.drawArguments.region(),
            }, { label: `DEM reset render patches ${resources.parity}` }))
            const expandSet = own(await runtime.createBindSet(expandKernel.layout, {
                mapMeta: resources.source.mapMeta.region(),
                renderPatchPolicy: policy.region({ layout: renderPatchPolicyCodec.artifact }),
                sourceVisibleInstances: resources.source.visibleInstances.region(),
                sourceDrawArguments: resources.source.drawArgument.region,
                renderPatches: resources.renderPatches.region({
                    layout: renderPatchCodec.artifact,
                }),
                renderPatchState: resources.state.region(),
            }, { label: `DEM expand render patches ${resources.parity}` }))
            const finalizeSet = own(await runtime.createBindSet(finalizeKernel.layout, {
                renderPatchPolicy: policy.region({ layout: renderPatchPolicyCodec.artifact }),
                renderPatchState: resources.state.region(),
                drawArguments: resources.drawArguments.region(),
            }, { label: `DEM finalize render patches ${resources.parity}` }))
            bindSets.push(resetSet, expandSet, finalizeSet)
            const reset = own(runtime.createDispatchCommand({
                label: `Reset DEM render patches ${resources.parity}`,
                pipeline: resetKernel.pipeline,
                bindSets: [ { set: resetSet } ],
                count: { workgroups: [ 1, 1, 1 ] },
                resources: currentAccess(
                    [ policy, resources.state, resources.drawArguments ],
                    [ resources.state, resources.drawArguments ]
                ),
                whenMissing: 'throw',
            }))
            const expand = own(runtime.createDispatchCommand({
                label: `Expand DEM render patches ${resources.parity}`,
                pipeline: expandKernel.pipeline,
                bindSets: [ { set: expandSet } ],
                count: {
                    workgroups: [
                        Math.ceil(descriptor.maximumSourceTiles / WORKGROUP_SIZE),
                        1,
                        1,
                    ],
                },
                resources: currentAccess([
                    resources.source.mapMeta,
                    policy,
                    resources.source.visibleInstances,
                    resources.source.drawArgument.resource,
                    resources.renderPatches,
                    resources.state,
                ], [ resources.renderPatches, resources.state ]),
                whenMissing: 'throw',
            }))
            const finalize = own(runtime.createDispatchCommand({
                label: `Finalize DEM render patches ${resources.parity}`,
                pipeline: finalizeKernel.pipeline,
                bindSets: [ { set: finalizeSet } ],
                count: { workgroups: [ 1, 1, 1 ] },
                resources: currentAccess(
                    [ policy, resources.state, resources.drawArguments ],
                    [ resources.state, resources.drawArguments ]
                ),
                whenMissing: 'throw',
            }))
            return Object.freeze({ reset, expand, finalize })
        })) as unknown as readonly [ParityCommands, ParityCommands]
        const programs = Object.freeze([
            resetKernel.program,
            expandKernel.program,
            finalizeKernel.program,
        ])
        const pipelines = Object.freeze([
            resetKernel.pipeline,
            expandKernel.pipeline,
            finalizeKernel.pipeline,
        ])
        const layouts = Object.freeze([
            resetKernel.layout,
            expandKernel.layout,
            finalizeKernel.layout,
        ])

        const templates = (templateId: DrawTemplateId) => Object.freeze(
            parityResources.map(resources => {
                const offset = templateId === 'lod-map' ? 0 : DRAW_ARGUMENT_BYTES
                return Object.freeze({
                    frontierId: id,
                    parity: resources.parity,
                    templateId,
                    mapMeta: resources.source.mapMeta,
                    visibleInstances: resources.renderPatches,
                    drawArgument: Object.freeze({
                        resource: resources.drawArguments,
                        region: resources.drawArguments.region({
                            offset,
                            size: DRAW_ARGUMENT_BYTES,
                        }),
                        offset,
                        size: DRAW_ARGUMENT_BYTES as 16,
                    }),
                })
            }) as unknown as [
                DemRenderPatchRenderTemplate,
                DemRenderPatchRenderTemplate,
            ]
        )
        const renderTemplates = Object.freeze({
            'lod-map': templates('lod-map'),
            terrain: templates('terrain'),
        })
        const identity: IdentityObjects = Object.freeze({
            resources: Object.freeze([
                policy,
                ...parityResources.flatMap(resources => [
                    resources.renderPatches,
                    resources.state,
                    resources.drawArguments,
                ]),
            ]),
            uploads: Object.freeze([ policyUpload ]),
            bindLayouts: layouts,
            bindSets: Object.freeze([ ...bindSets ]),
            programs,
            pipelines,
            passes: Object.freeze([ pass ]),
            commands: Object.freeze([
                ...initializationClears,
                ...commands.flatMap(parity => [
                    parity.reset,
                    parity.expand,
                    parity.finalize,
                ]),
            ]),
        })

        const frontier: DemRenderPatchFrontier = Object.freeze({
            id,
            initialize(builder: SubmissionBuilder) {
                assertActive(disposed)
                if (builder.runtime !== runtime || builder.isSubmitted) {
                    throw new TypeError('DEM render-patch initialization requires a live owned builder')
                }
                for (const command of initializationClears) builder.clear(command)
                builder.upload(policyUpload)
                return builder
            },
            encode(builder: SubmissionBuilder, frame: GpuTileFrontierFrame) {
                assertActive(disposed)
                const parity = frame?.parity
                if (builder.runtime !== runtime || builder.isSubmitted ||
                    (parity !== 0 && parity !== 1) ||
                    frame.frontierId !== descriptor.sourceTemplates[parity].frontierId) {
                    throw new TypeError('DEM render-patch encoding requires the current source frontier frame')
                }
                const selected = commands[parity]
                return builder.compute(pass, [
                    selected.reset,
                    selected.expand,
                    selected.finalize,
                ])
            },
            renderTemplates(templateId: DrawTemplateId) {
                assertActive(disposed)
                const selected = renderTemplates[templateId]
                if (selected === undefined) {
                    throw new TypeError(`Unknown DEM render-patch template ${templateId}`)
                }
                return selected
            },
            commandsFor(frame: GpuTileFrontierFrame) {
                assertActive(disposed)
                const parity = frame?.parity
                if ((parity !== 0 && parity !== 1) ||
                    frame.frontierId !== descriptor.sourceTemplates[parity].frontierId) {
                    throw new TypeError('DEM render-patch commands require an owned source frame')
                }
                return commands[parity]
            },
            facts() {
                return Object.freeze({
                    id,
                    selectionPath: 'gpu-expanded-render-patches' as const,
                    disposed,
                    dataMaximumMatrixLevel: descriptor.dataMaximumMatrixLevel,
                    maximumMatrixLevel: descriptor.renderMaximumMatrixLevel,
                    maximumExtraLevels: descriptor.maximumExtraLevels,
                    maximumSourceTiles: descriptor.maximumSourceTiles,
                    maximumRenderPatches,
                    renderPatchBytes,
                    drawArgumentBytes: DRAW_ARGUMENT_BYTES * DRAW_ARGUMENT_COUNT,
                    workgroupSize: WORKGROUP_SIZE,
                    parity: Object.freeze(parityResources.map(resources => Object.freeze({
                        parity: resources.parity,
                        sourceBufferId: resources.source.visibleInstances.id,
                        renderPatchBufferId: resources.renderPatches.id,
                        stateBufferId: resources.state.id,
                        drawArgumentBufferId: resources.drawArguments.id,
                        commandIds: Object.freeze([
                            commands[resources.parity].reset.id,
                            commands[resources.parity].expand.id,
                            commands[resources.parity].finalize.id,
                        ]),
                    }))),
                })
            },
            identityObjects: () => identity,
            dispose() {
                if (disposed) return
                disposed = true
                for (const value of [ ...owned ].reverse()) value.dispose()
            },
        })
        return frontier
    } catch (error) {
        for (const value of [ ...owned ].reverse()) value.dispose()
        throw error
    }
}

type Kernel = Readonly<{
    layout: BindLayout
    program: Program
    pipeline: ComputePipeline
}>

async function createKernel(
    runtime: GPURuntime,
    shader: ShaderModule,
    entryPoint: string,
    label: string,
    entries: readonly BindLayoutEntry[],
    own: <Value extends Disposable>(value: Value) => Value
): Promise<Kernel> {

    const layout = own(await runtime.createBindLayout({
        label: `${label} layout`,
        group: 0,
        entries,
    }))
    const program = own(runtime.createProgram({
        label: `${label} program`,
        compute: { module: shader, entryPoint },
    }))
    const pipeline = own(await runtime.createComputePipeline({
        label: `${label} pipeline`,
        program,
        layout: { mode: 'explicit', bindLayouts: [ layout ] },
    }))
    return Object.freeze({ layout, program, pipeline })
}

function binding(
    bindingIndex: number,
    name: string,
    type: BufferBindingType,
    minBindingSize: number
): BindLayoutEntry {

    return Object.freeze({
        binding: bindingIndex,
        name,
        type,
        visibility: [ 'compute' ] as const,
        minBindingSize,
    }) as BindLayoutEntry
}

function currentAccess(
    reads: readonly BufferResource[],
    writes: readonly BufferResource[]
) {

    return {
        read: uniqueResources(reads).map(resource => ({
            resource,
            contentEpoch: 'current-at-step' as const,
        })),
        write: uniqueResources(writes),
    }
}

function uniqueResources(values: readonly BufferResource[]): BufferResource[] {

    return [ ...new Map(values.map(value => [ value.id, value ])).values() ]
}

function validateOptions(
    runtime: GPURuntime,
    options: DemRenderPatchFrontierOptions
): Required<DemRenderPatchFrontierOptions> {

    const renderMaximumMatrixLevel = options.renderMaximumMatrixLevel ??
        DEM_MAX_RENDER_MATRIX_LEVEL
    const maximumExtraLevels = options.maximumExtraLevels ?? DEM_MAX_RENDER_EXTRA_LEVELS
    if (runtime === undefined || typeof runtime.createBuffer !== 'function') {
        throw new TypeError('DEM render-patch frontier requires GPURuntime')
    }
    if (options.sourceTemplates?.length !== 2 ||
        options.sourceTemplates.some((template, parity) => (
            template?.parity !== parity || template.mapMeta === undefined ||
            template.visibleInstances === undefined || template.drawArgument === undefined
        ))) {
        throw new TypeError('DEM render-patch frontier requires two source parity templates')
    }
    for (const [ name, value ] of [
        [ 'maximumSourceTiles', options.maximumSourceTiles ],
        [ 'dataMaximumMatrixLevel', options.dataMaximumMatrixLevel ],
        [ 'renderMaximumMatrixLevel', renderMaximumMatrixLevel ],
        [ 'maximumExtraLevels', maximumExtraLevels ],
        [ 'coordinateBits', options.coordinateBits ],
        [ 'terrainVertexCount', options.terrainVertexCount ],
    ] as const) {
        if (!Number.isInteger(value) || value < 0) {
            throw new TypeError(`DEM render-patch ${name} must be a non-negative integer`)
        }
    }
    if (options.maximumSourceTiles < 1 || options.terrainVertexCount < 1 ||
        renderMaximumMatrixLevel < options.dataMaximumMatrixLevel ||
        maximumExtraLevels > DEM_MAX_RENDER_EXTRA_LEVELS ||
        maximumExtraLevels > renderMaximumMatrixLevel ||
        options.coordinateBits <= renderMaximumMatrixLevel) {
        throw new TypeError('DEM render-patch policy bounds are invalid')
    }
    if (options.elevationRangeMeters?.length !== 2 ||
        options.elevationRangeMeters.some(value => !Number.isFinite(value)) ||
        options.elevationRangeMeters[0] > options.elevationRangeMeters[1]) {
        throw new TypeError('DEM render-patch elevation range is invalid')
    }
    if (typeof options.shader !== 'string' || options.shader.trim() === '') {
        throw new TypeError('DEM render-patch shader source is required')
    }
    return Object.freeze({
        ...options,
        sourceTemplates: options.sourceTemplates,
        renderMaximumMatrixLevel,
        maximumExtraLevels,
    })
}

function assertActive(disposed: boolean) {

    if (disposed) throw new Error('DEM render-patch frontier is disposed')
}
