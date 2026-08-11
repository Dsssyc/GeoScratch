import {
    layoutCodec,
    type BindLayout,
    type BindLayoutEntry,
    type BindSet,
    type BufferRegion,
    type BufferResource,
    type ClearBufferCommand,
    type ComputePassSpec,
    type ComputePipeline,
    type DispatchCommand,
    type GPURuntime,
    type Program,
    type ReadbackCommand,
    type ShaderModule,
    type SubmissionBuilder,
    type SubmittedWork,
    type UploadCommand,
} from '../scratch/index.js'
import {
    gpuTileFrontierRenderWgslModule,
} from './gpu-tile-frontier-layout.js'
import type {
    GpuTileFrontierFrame,
    GpuTileFrontierRenderTemplate,
} from './gpu-tile-frontier.js'
import {
    createGeoDiagnostic,
    GeoDiagnosticError,
} from './diagnostics.js'
import { GPU_RENDER_PATCH_FRONTIER_WGSL } from './gpu-render-patch-frontier-wgsl.js'

export const GPU_RENDER_PATCH_MAXIMUM_MATRIX_LEVEL = 14
export const GPU_RENDER_PATCH_MAXIMUM_EXTRA_LEVELS = 4
export const GPU_RENDER_PATCH_DEFAULT_CELLS_PER_EDGE = 64
export const GPU_RENDER_PATCH_DEFAULT_MAXIMUM_CELL_SPAN_PIXELS = 8
export const GPU_RENDER_PATCH_BALANCE_PASS_COUNT = GPU_RENDER_PATCH_MAXIMUM_MATRIX_LEVEL
const GPU_RENDER_PATCH_DEFAULT_MAXIMUM_COUNT_RATIO = 3
const GPU_RENDER_PATCH_BIAS_STEPS_PER_LEVEL = 4
const GPU_RENDER_PATCH_BIAS_STEP_COUNT =
    GPU_RENDER_PATCH_MAXIMUM_EXTRA_LEVELS * GPU_RENDER_PATCH_BIAS_STEPS_PER_LEVEL + 1
const GPU_RENDER_PATCH_DEFAULT_BUDGET_HYSTERESIS_RATIO = 0.75

const WORKGROUP_SIZE = 64
const BALANCE_WORKGROUP_SIZE = 256
const DRAW_ARGUMENT_BYTES = 16
const DRAW_ARGUMENT_COUNT = 1
const STATE_TRIAL_COUNTS_OFFSET_WORDS = 13
const STATE_UNBALANCED_PATCH_COUNT_OFFSET_WORDS =
    STATE_TRIAL_COUNTS_OFFSET_WORDS + GPU_RENDER_PATCH_BIAS_STEP_COUNT
const STATE_BALANCE_SPLIT_COUNT_OFFSET_WORDS =
    STATE_UNBALANCED_PATCH_COUNT_OFFSET_WORDS + 1
const STATE_MAXIMUM_ADJACENT_LEVEL_DELTA_OFFSET_WORDS =
    STATE_BALANCE_SPLIT_COUNT_OFFSET_WORDS + 1
const STATE_BALANCE_PASS_COUNT_OFFSET_WORDS =
    STATE_MAXIMUM_ADJACENT_LEVEL_DELTA_OFFSET_WORDS + 1
const STATE_BALANCE_SCRATCH_COUNT_OFFSET_WORDS =
    STATE_BALANCE_PASS_COUNT_OFFSET_WORDS + 1
const STATE_WORDS = STATE_BALANCE_SCRATCH_COUNT_OFFSET_WORDS + 1
const STATE_BYTES = STATE_WORDS * Uint32Array.BYTES_PER_ELEMENT
const LOOKUP_ENTRY_BYTES = 8
const BUFFER_COPY_DST = 0x08
const BUFFER_COPY_SRC = 0x04
const BUFFER_UNIFORM = 0x40
const BUFFER_STORAGE = 0x80
const BUFFER_INDIRECT = 0x100

const renderPatchCodec = layoutCodec({
    name: 'GpuRenderPatch',
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
    name: 'GpuRenderPatchPolicy',
    fields: [
        { name: 'dataMaximumMatrixLevel', type: 'u32' },
        { name: 'renderMaximumMatrixLevel', type: 'u32' },
        { name: 'maximumExtraLevels', type: 'u32' },
        { name: 'maximumRenderPatches', type: 'u32' },
        { name: 'minimumElevationMeters', type: 'f32' },
        { name: 'maximumElevationMeters', type: 'f32' },
        { name: 'coordinateBits', type: 'u32' },
        { name: 'vertexCount', type: 'u32' },
        { name: 'renderPatchLookupCapacity', type: 'u32' },
        { name: 'cellsPerPatchEdge', type: 'u32' },
        { name: 'maximumCellSpanPixels', type: 'f32' },
        { name: 'maximumPatchCountRatio', type: 'f32' },
        { name: 'biasStepsPerLevel', type: 'u32' },
        { name: 'biasStepCount', type: 'u32' },
        { name: 'budgetHysteresisRatio', type: 'f32' },
        { name: 'balancePassCount', type: 'u32' },
    ],
}, { usage: [ 'uniform', 'storage', 'readback' ] })

type Disposable = { dispose(): void }
type BufferBindingType = 'uniform' | 'read-storage' | 'storage'

export type GpuRenderPatchRenderTemplate = Readonly<{
    frontierId: string
    parity: 0 | 1
    templateId: 'patch-mesh'
    mapMeta: BufferResource
    visibleInstances: BufferResource
    renderPatchLookup: BufferResource
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
    renderPatchLookup: BufferResource
    balancePatches: BufferResource
    balancePatchLookup: BufferResource
    state: BufferResource
    drawArguments: BufferResource
}>

export type GpuRenderPatchCommands = Readonly<{
    clearLookup: ClearBufferCommand
    reset: DispatchCommand
    count: DispatchCommand
    select: DispatchCommand
    expand: DispatchCommand
    balance: DispatchCommand
    resetFinalDiagnostics: DispatchCommand
    validate: DispatchCommand
    finalize: DispatchCommand
    feedback: ReadbackCommand
}>

export type GpuRenderPatchFrontierFacts = Readonly<{
    id: string
    selectionPath: 'gpu-balanced-normalized-projected-grid-render-patches'
    disposed: boolean
    dataMaximumMatrixLevel: number
    maximumMatrixLevel: number
    maximumExtraLevels: number
    maximumSourceTiles: number
    maximumRenderPatches: number
    maximumCellSpanPixels: number
    maximumPatchCountRatio: number
    biasStepsPerLevel: number
    biasStepCount: number
    refinementHysteresisLevels: number
    budgetHysteresisRatio: number
    nominalPatchSpanPixels: number
    cellsPerPatchEdge: number
    renderPatchBytes: number
    renderPatchLookupCapacity: number
    renderPatchLookupBytes: number
    balancePassCount: number
    balanceWorkgroupSize: number
    drawArgumentBytes: number
    workgroupSize: number
    parity: readonly Readonly<{
        parity: 0 | 1
        sourceBufferId: string
        renderPatchBufferId: string
        renderPatchLookupBufferId: string
        balancePatchBufferId: string
        balancePatchLookupBufferId: string
        stateBufferId: string
        drawArgumentBufferId: string
        commandIds: readonly string[]
    }>[]
}>

export type GpuRenderPatchIdentityObjects = Readonly<{
    resources: readonly BufferResource[]
    uploads: readonly UploadCommand[]
    bindLayouts: readonly BindLayout[]
    bindSets: readonly BindSet[]
    programs: readonly Program[]
    pipelines: readonly ComputePipeline[]
    passes: readonly ComputePassSpec[]
    commands: readonly (ClearBufferCommand | DispatchCommand | ReadbackCommand)[]
}>

export type GpuRenderPatchSelectionFacts = Readonly<{
    selectedPatchCount: number
    descriptorOverflowCount: number
    lookupOverflowCount: number
    minimumMatrixLevel?: number
    maximumMatrixLevel?: number
    minimumCellSpanPixels?: number
    maximumCellSpanPixels?: number
    frameEpoch: number
    baselinePatchBudget: number
    framePatchBudget: number
    requestedPatchCount: number
    minimumTrialPatchCount: number
    sourceRootPatchCount: number
    selectedBiasStep: number
    selectedBiasLevels: number
    budgetLimitedByMinimumTrial: boolean
    unbalancedPatchCount: number
    balanceSplitCount: number
    balanceOverheadPatchCount: number
    maximumAdjacentLevelDelta: number
    balancePassCount: number
}>

export type GpuRenderPatchFeedback = Readonly<GpuRenderPatchSelectionFacts & {
    kind: 'gpu-render-patch-feedback'
    frontierId: string
    submissionId: string
}>

export class GpuRenderPatchFeedbackStaleError extends GeoDiagnosticError {

    constructor(expectedFrameEpoch: number, actualFrameEpoch: number) {

        super(createGeoDiagnostic({
            code: 'GEO_GPU_RENDER_PATCH_FEEDBACK_STALE',
            phase: 'selection',
            subject: { kind: 'gpu-render-patch-feedback' },
            message: `GPU render-patch frame epoch is stale: expected ${expectedFrameEpoch}, ` +
                `received ${actualFrameEpoch}`,
            expected: { frameEpoch: expectedFrameEpoch },
            actual: { frameEpoch: actualFrameEpoch },
        }))
        this.name = 'GpuRenderPatchFeedbackStaleError'
    }
}

export type GpuRenderPatchFrontier = Readonly<{
    id: string
    initialize(builder: SubmissionBuilder): SubmissionBuilder
    encode(builder: SubmissionBuilder, frame: GpuTileFrontierFrame): SubmissionBuilder
    capture(builder: SubmissionBuilder, frame: GpuTileFrontierFrame): SubmissionBuilder
    feedback(
        frame: GpuTileFrontierFrame,
        submitted: SubmittedWork
    ): Promise<GpuRenderPatchFeedback>
    renderTemplates(): readonly [
        GpuRenderPatchRenderTemplate,
        GpuRenderPatchRenderTemplate,
    ]
    commandsFor(frame: GpuTileFrontierFrame): GpuRenderPatchCommands
    facts(): GpuRenderPatchFrontierFacts
    identityObjects(): GpuRenderPatchIdentityObjects
    dispose(): void
}>

export type GpuRenderPatchFrontierDescriptor = Readonly<{
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
    vertexCount: number
    cellsPerPatchEdge?: number
    maximumCellSpanPixels?: number
    maximumPatchCountRatio?: number
    budgetHysteresisRatio?: number
}>

let nextRenderPatchFrontierId = 1

export function decodeGpuRenderPatchState(
    bytes: Uint8Array,
    options: Readonly<{
        maximumRenderPatches: number
        expectedFrameEpoch?: number
    }>
): GpuRenderPatchSelectionFacts {

    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== STATE_BYTES) {
        throw new TypeError(`GPU render-patch feedback must contain ${STATE_BYTES} bytes`)
    }
    if (!Number.isSafeInteger(options?.maximumRenderPatches) ||
        options.maximumRenderPatches < 1) {
        throw new TypeError('GPU render-patch feedback capacity must be positive')
    }
    if (options.expectedFrameEpoch !== undefined &&
        (!Number.isSafeInteger(options.expectedFrameEpoch) || options.expectedFrameEpoch < 0)) {
        throw new TypeError('GPU render-patch expected frame epoch must be non-negative')
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const word = (index: number) => view.getUint32(index * 4, true)
    const attemptedPatchCount = word(0)
    const descriptorOverflowCount = word(1)
    const lookupOverflowCount = word(2)
    const minimumMatrixLevel = word(3)
    const maximumMatrixLevel = word(4)
    const minimumCellSpanQ8 = word(5)
    const maximumCellSpanQ8 = word(6)
    const frameEpoch = word(7)
    const baselinePatchBudget = word(8)
    const framePatchBudget = word(9)
    const requestedPatchCount = word(10)
    const selectedBiasStep = word(11)
    const minimumTrialPatchCount = word(12)
    const trialCounts = Array.from(
        { length: GPU_RENDER_PATCH_BIAS_STEP_COUNT },
        (_, index) => word(STATE_TRIAL_COUNTS_OFFSET_WORDS + index)
    )
    const unbalancedPatchCount = word(STATE_UNBALANCED_PATCH_COUNT_OFFSET_WORDS)
    const balanceSplitCount = word(STATE_BALANCE_SPLIT_COUNT_OFFSET_WORDS)
    const maximumAdjacentLevelDelta = word(
        STATE_MAXIMUM_ADJACENT_LEVEL_DELTA_OFFSET_WORDS
    )
    const balancePassCount = word(STATE_BALANCE_PASS_COUNT_OFFSET_WORDS)
    const balanceScratchCount = word(STATE_BALANCE_SCRATCH_COUNT_OFFSET_WORDS)
    const sourceRootPatchCount = trialCounts.at(-1)!
    const observedMinimumTrialPatchCount = Math.min(...trialCounts)
    const minimumTrialBiasStep = trialCounts.indexOf(observedMinimumTrialPatchCount)
    if (options.expectedFrameEpoch !== undefined && frameEpoch !== options.expectedFrameEpoch) {
        throw new GpuRenderPatchFeedbackStaleError(options.expectedFrameEpoch, frameEpoch)
    }
    const selectedPatchCount = Math.min(attemptedPatchCount, options.maximumRenderPatches)
    if (attemptedPatchCount > options.maximumRenderPatches ||
        balanceScratchCount > options.maximumRenderPatches ||
        descriptorOverflowCount !== 0) {
        throw new RangeError('GPU balanced render-patch capacity was exceeded')
    }
    if (maximumAdjacentLevelDelta > 1) {
        throw new RangeError(
            'GPU render-patch cut violates the level-difference-one invariant'
        )
    }
    if (baselinePatchBudget < 1 || framePatchBudget < baselinePatchBudget ||
        framePatchBudget > options.maximumRenderPatches ||
        selectedBiasStep >= GPU_RENDER_PATCH_BIAS_STEP_COUNT ||
        requestedPatchCount !== trialCounts[0] ||
        minimumTrialPatchCount !== observedMinimumTrialPatchCount ||
        unbalancedPatchCount !== trialCounts[selectedBiasStep] ||
        attemptedPatchCount !== unbalancedPatchCount + balanceSplitCount * 3 ||
        balancePassCount !== GPU_RENDER_PATCH_BALANCE_PASS_COUNT ||
        (minimumTrialPatchCount <= framePatchBudget &&
            unbalancedPatchCount > framePatchBudget) ||
        (minimumTrialPatchCount > framePatchBudget &&
            (selectedBiasStep !== minimumTrialBiasStep ||
                unbalancedPatchCount !== minimumTrialPatchCount))) {
        throw new RangeError(`GPU render-patch budget feedback is inconsistent: ${JSON.stringify({
            attemptedPatchCount,
            unbalancedPatchCount,
            balanceSplitCount,
            maximumAdjacentLevelDelta,
            balancePassCount,
            baselinePatchBudget,
            framePatchBudget,
            requestedPatchCount,
            selectedBiasStep,
            minimumTrialPatchCount,
            sourceRootPatchCount,
            trialCounts,
        })}`)
    }
    const budgetFacts = {
        baselinePatchBudget,
        framePatchBudget,
        requestedPatchCount,
        minimumTrialPatchCount,
        sourceRootPatchCount,
        selectedBiasStep,
        selectedBiasLevels: selectedBiasStep / GPU_RENDER_PATCH_BIAS_STEPS_PER_LEVEL,
        budgetLimitedByMinimumTrial: minimumTrialPatchCount > framePatchBudget,
        unbalancedPatchCount,
        balanceSplitCount,
        balanceOverheadPatchCount: selectedPatchCount - unbalancedPatchCount,
        maximumAdjacentLevelDelta,
        balancePassCount,
    }
    if (selectedPatchCount === 0) {
        return Object.freeze({
            selectedPatchCount,
            descriptorOverflowCount,
            lookupOverflowCount,
            frameEpoch,
            ...budgetFacts,
        })
    }
    if (minimumMatrixLevel === 0xffff_ffff ||
        minimumMatrixLevel > maximumMatrixLevel ||
        minimumCellSpanQ8 === 0xffff_ffff ||
        minimumCellSpanQ8 > maximumCellSpanQ8) {
        throw new RangeError('GPU render-patch feedback ranges are invalid')
    }
    return Object.freeze({
        selectedPatchCount,
        descriptorOverflowCount,
        lookupOverflowCount,
        minimumMatrixLevel,
        maximumMatrixLevel,
        minimumCellSpanPixels: minimumCellSpanQ8 / 256,
        maximumCellSpanPixels: maximumCellSpanQ8 / 256,
        frameEpoch,
        ...budgetFacts,
    })
}

function gpuRenderPatchLookupCapacity(
    maximumSourceTiles: number,
    maximumExtraLevels: number
): number {

    if (!Number.isSafeInteger(maximumSourceTiles) || maximumSourceTiles < 1) {
        throw new TypeError('GPU render-patch maximum source tiles must be positive')
    }
    if (!Number.isInteger(maximumExtraLevels) || maximumExtraLevels < 0 ||
        maximumExtraLevels > GPU_RENDER_PATCH_MAXIMUM_EXTRA_LEVELS) {
        throw new TypeError('GPU render-patch maximum extra levels is invalid')
    }
    const required = maximumSourceTiles * 4 ** maximumExtraLevels * 2
    let capacity = 1
    while (capacity < required) capacity *= 2
    if (!Number.isSafeInteger(capacity) || capacity > 0x4000_0000) {
        throw new RangeError('GPU render-patch lookup capacity exceeds supported bounds')
    }
    return capacity
}

export function gpuRenderPatchWgslModule() {

    const frontier = gpuTileFrontierRenderWgslModule()
    return Object.freeze({
        code: [
            frontier.code,
            renderPatchCodec.wgslAccessors({ namespace: 'GpuRenderPatch' }),
            `
fn GpuRenderPatch_lookupKey(matrixLevel: u32, tileRow: u32, tileCol: u32) -> u32 {
    return 1u + (matrixLevel << 28u) + (tileRow << 14u) + tileCol;
}

fn GpuRenderPatch_lookupSlot(key: u32, probe: u32, capacity: u32) -> u32 {
    var hash = key;
    hash = (hash ^ (hash >> 16u)) * 0x7feb352du;
    hash = (hash ^ (hash >> 15u)) * 0x846ca68bu;
    hash = hash ^ (hash >> 16u);
    return (hash + probe) & (capacity - 1u);
}
`,
        ].join('\n'),
        layoutDependencies: Object.freeze([
            ...frontier.layoutDependencies,
            renderPatchCodec.artifact,
        ]),
    })
}

export async function createGpuRenderPatchFrontier(
    runtime: GPURuntime,
    options: GpuRenderPatchFrontierDescriptor
): Promise<GpuRenderPatchFrontier> {

    const descriptor = validateOptions(runtime, options)
    const id = `gpu-render-patch-frontier-${nextRenderPatchFrontierId++}`
    const maximumRenderPatches = descriptor.maximumSourceTiles *
        4 ** descriptor.maximumExtraLevels
    const renderPatchLookupCapacity = gpuRenderPatchLookupCapacity(
        descriptor.maximumSourceTiles,
        descriptor.maximumExtraLevels
    )
    const renderPatchBytes = maximumRenderPatches * renderPatchCodec.byteLength()
    const renderPatchLookupBytes = renderPatchLookupCapacity * LOOKUP_ENTRY_BYTES
    const owned: Disposable[] = []
    const own = <Value extends Disposable>(value: Value): Value => {
        owned.push(value)
        return value
    }
    let disposed = false
    const encodedFrames = new WeakMap<SubmissionBuilder, GpuTileFrontierFrame>()
    const capturedBuilders = new WeakSet<SubmissionBuilder>()

    try {
        const policy = own(await runtime.createBuffer({
            label: 'GPU render-patch policy',
            size: renderPatchPolicyCodec.byteLength(),
            usage: BUFFER_COPY_DST | BUFFER_UNIFORM,
        }))
        const policyUpload = own(runtime.createUploadCommand({
            label: 'Upload GPU render-patch policy',
            target: policy.region({ layout: renderPatchPolicyCodec.artifact }),
            data: renderPatchPolicyCodec.pack({
                dataMaximumMatrixLevel: descriptor.dataMaximumMatrixLevel,
                renderMaximumMatrixLevel: descriptor.renderMaximumMatrixLevel,
                maximumExtraLevels: descriptor.maximumExtraLevels,
                maximumRenderPatches,
                minimumElevationMeters: descriptor.elevationRangeMeters[0],
                maximumElevationMeters: descriptor.elevationRangeMeters[1],
                coordinateBits: descriptor.coordinateBits,
                vertexCount: descriptor.vertexCount,
                renderPatchLookupCapacity,
                cellsPerPatchEdge: descriptor.cellsPerPatchEdge,
                maximumCellSpanPixels: descriptor.maximumCellSpanPixels,
                maximumPatchCountRatio: descriptor.maximumPatchCountRatio,
                biasStepsPerLevel: GPU_RENDER_PATCH_BIAS_STEPS_PER_LEVEL,
                biasStepCount: GPU_RENDER_PATCH_BIAS_STEP_COUNT,
                budgetHysteresisRatio: descriptor.budgetHysteresisRatio,
                balancePassCount: GPU_RENDER_PATCH_BALANCE_PASS_COUNT,
            }),
        }))
        const parityResources = await Promise.all(descriptor.sourceTemplates.map(
            async(source, parityValue): Promise<ParityResources> => {
                const parity = parityValue as 0 | 1
                return Object.freeze({
                    parity,
                    source,
                    renderPatches: own(await runtime.createBuffer({
                        label: `GPU render patches ${parity}`,
                        size: renderPatchBytes,
                        usage: BUFFER_COPY_DST | BUFFER_STORAGE,
                    })),
                    renderPatchLookup: own(await runtime.createBuffer({
                        label: `GPU render-patch lookup ${parity}`,
                        size: renderPatchLookupBytes,
                        usage: BUFFER_COPY_DST | BUFFER_STORAGE,
                    })),
                    balancePatches: own(await runtime.createBuffer({
                        label: `GPU balanced render-patch scratch ${parity}`,
                        size: renderPatchBytes,
                        usage: BUFFER_COPY_DST | BUFFER_STORAGE,
                    })),
                    balancePatchLookup: own(await runtime.createBuffer({
                        label: `GPU balanced render-patch lookup scratch ${parity}`,
                        size: renderPatchLookupBytes,
                        usage: BUFFER_COPY_DST | BUFFER_STORAGE,
                    })),
                    state: own(await runtime.createBuffer({
                        label: `GPU render-patch state ${parity}`,
                        size: STATE_BYTES,
                        usage: BUFFER_COPY_DST | BUFFER_COPY_SRC |
                            BUFFER_STORAGE,
                    })),
                    drawArguments: own(await runtime.createBuffer({
                        label: `GPU render-patch draw arguments ${parity}`,
                        size: DRAW_ARGUMENT_BYTES * DRAW_ARGUMENT_COUNT,
                        usage: BUFFER_COPY_DST | BUFFER_STORAGE |
                            BUFFER_INDIRECT,
                    })),
                })
            }
        )) as unknown as readonly [ParityResources, ParityResources]
        const initializationClears = Object.freeze(parityResources.flatMap(resources => [
            own(runtime.createClearBufferCommand({
                label: `Clear GPU render patches ${resources.parity}`,
                target: resources.renderPatches.region(),
            })),
            own(runtime.createClearBufferCommand({
                label: `Clear GPU balanced render-patch scratch ${resources.parity}`,
                target: resources.balancePatches.region(),
            })),
            own(runtime.createClearBufferCommand({
                label: `Clear GPU balanced render-patch lookup scratch ${resources.parity}`,
                target: resources.balancePatchLookup.region(),
            })),
            own(runtime.createClearBufferCommand({
                label: `Clear GPU render-patch state ${resources.parity}`,
                target: resources.state.region(),
            })),
            own(runtime.createClearBufferCommand({
                label: `Clear GPU render-patch draw arguments ${resources.parity}`,
                target: resources.drawArguments.region(),
            })),
        ]))
        const shared = gpuRenderPatchWgslModule()
        const shader = own(await runtime.createShaderModule({
            label: 'GPU render-patch frontier shader',
            sourceParts: [
                {
                    label: 'GPU render-patch shared ABI',
                    code: [
                        shared.code,
                        renderPatchPolicyCodec.wgslAccessors({
                            namespace: 'GpuRenderPatchPolicy',
                        }),
                    ].join('\n'),
                    layoutDependencies: [
                        ...shared.layoutDependencies,
                        renderPatchPolicyCodec.artifact,
                    ],
                },
                { label: 'GPU render-patch kernels', code: GPU_RENDER_PATCH_FRONTIER_WGSL },
            ],
        }))
        const pass = own(runtime.createComputePass({
            label: 'GPU render-patch frontier stage',
        }))
        const resetKernel = await createKernel(
            runtime,
            shader,
            'resetRenderPatches',
            'GPU reset render patches',
            [
                binding(0, 'mapMeta', 'uniform', descriptor.sourceTemplates[0].mapMeta.size),
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
        const countKernel = await createKernel(
            runtime,
            shader,
            'countRenderPatchTrials',
            'GPU count render-patch trials',
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
                binding(5, 'renderPatchState', 'storage', STATE_BYTES),
                binding(
                    10,
                    'previousRenderPatchLookup',
                    'read-storage',
                    renderPatchLookupBytes
                ),
            ],
            own
        )
        const selectKernel = await createKernel(
            runtime,
            shader,
            'selectRenderPatchBudget',
            'GPU select render-patch budget',
            [
                binding(0, 'mapMeta', 'uniform', descriptor.sourceTemplates[0].mapMeta.size),
                binding(1, 'renderPatchPolicy', 'uniform', renderPatchPolicyCodec.byteLength()),
                binding(5, 'renderPatchState', 'storage', STATE_BYTES),
            ],
            own
        )
        const expandKernel = await createKernel(
            runtime,
            shader,
            'expandRenderPatches',
            'GPU expand render patches',
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
                binding(
                    7,
                    'renderPatchLookup',
                    'storage',
                    renderPatchLookupBytes
                ),
                binding(
                    10,
                    'previousRenderPatchLookup',
                    'read-storage',
                    renderPatchLookupBytes
                ),
            ],
            own
        )
        const balanceKernel = await createKernel(
            runtime,
            shader,
            'balanceRenderPatches',
            'GPU balance render-patch cut',
            [
                binding(1, 'renderPatchPolicy', 'uniform', renderPatchPolicyCodec.byteLength()),
                binding(4, 'renderPatches', 'storage', renderPatchBytes),
                binding(5, 'renderPatchState', 'storage', STATE_BYTES),
                binding(
                    7,
                    'renderPatchLookup',
                    'storage',
                    renderPatchLookupBytes
                ),
                binding(8, 'balancePatches', 'storage', renderPatchBytes),
                binding(
                    9,
                    'balancePatchLookup',
                    'storage',
                    renderPatchLookupBytes
                ),
            ],
            own
        )
        const resetFinalDiagnosticsKernel = await createKernel(
            runtime,
            shader,
            'resetFinalRenderPatchDiagnostics',
            'GPU reset final render-patch diagnostics',
            [ binding(5, 'renderPatchState', 'storage', STATE_BYTES) ],
            own
        )
        const validateKernel = await createKernel(
            runtime,
            shader,
            'validateFinalRenderPatchCut',
            'GPU validate final render-patch cut',
            [
                binding(0, 'mapMeta', 'uniform', descriptor.sourceTemplates[0].mapMeta.size),
                binding(1, 'renderPatchPolicy', 'uniform', renderPatchPolicyCodec.byteLength()),
                binding(4, 'renderPatches', 'storage', renderPatchBytes),
                binding(5, 'renderPatchState', 'storage', STATE_BYTES),
                binding(
                    7,
                    'renderPatchLookup',
                    'storage',
                    renderPatchLookupBytes
                ),
                binding(
                    9,
                    'balancePatchLookup',
                    'storage',
                    renderPatchLookupBytes
                ),
            ],
            own
        )
        const finalizeKernel = await createKernel(
            runtime,
            shader,
            'finalizeRenderPatches',
            'GPU finalize render patches',
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
            const previousResources = parityResources[resources.parity === 0 ? 1 : 0]
            const resetSet = own(await runtime.createBindSet(resetKernel.layout, {
                mapMeta: resources.source.mapMeta.region(),
                renderPatchPolicy: policy.region({ layout: renderPatchPolicyCodec.artifact }),
                renderPatchState: resources.state.region(),
                drawArguments: resources.drawArguments.region(),
            }, { label: `GPU reset render patches ${resources.parity}` }))
            const countSet = own(await runtime.createBindSet(countKernel.layout, {
                mapMeta: resources.source.mapMeta.region(),
                renderPatchPolicy: policy.region({ layout: renderPatchPolicyCodec.artifact }),
                sourceVisibleInstances: resources.source.visibleInstances.region(),
                sourceDrawArguments: resources.source.drawArgument.region,
                renderPatchState: resources.state.region(),
                previousRenderPatchLookup: previousResources.renderPatchLookup.region(),
            }, { label: `GPU count render-patch trials ${resources.parity}` }))
            const selectSet = own(await runtime.createBindSet(selectKernel.layout, {
                mapMeta: resources.source.mapMeta.region(),
                renderPatchPolicy: policy.region({ layout: renderPatchPolicyCodec.artifact }),
                renderPatchState: resources.state.region(),
            }, { label: `GPU select render-patch budget ${resources.parity}` }))
            const expandSet = own(await runtime.createBindSet(expandKernel.layout, {
                mapMeta: resources.source.mapMeta.region(),
                renderPatchPolicy: policy.region({ layout: renderPatchPolicyCodec.artifact }),
                sourceVisibleInstances: resources.source.visibleInstances.region(),
                sourceDrawArguments: resources.source.drawArgument.region,
                renderPatches: resources.renderPatches.region({
                    layout: renderPatchCodec.artifact,
                }),
                renderPatchState: resources.state.region(),
                renderPatchLookup: resources.renderPatchLookup.region(),
                previousRenderPatchLookup: previousResources.renderPatchLookup.region(),
            }, { label: `GPU expand render patches ${resources.parity}` }))
            const balanceSet = own(await runtime.createBindSet(balanceKernel.layout, {
                renderPatchPolicy: policy.region({ layout: renderPatchPolicyCodec.artifact }),
                renderPatches: resources.renderPatches.region({
                    layout: renderPatchCodec.artifact,
                }),
                renderPatchState: resources.state.region(),
                renderPatchLookup: resources.renderPatchLookup.region(),
                balancePatches: resources.balancePatches.region({
                    layout: renderPatchCodec.artifact,
                }),
                balancePatchLookup: resources.balancePatchLookup.region(),
            }, { label: `GPU balance render-patch cut ${resources.parity}` }))
            const resetFinalDiagnosticsSet = own(await runtime.createBindSet(
                resetFinalDiagnosticsKernel.layout,
                { renderPatchState: resources.state.region() },
                { label: `GPU reset final render-patch diagnostics ${resources.parity}` }
            ))
            const validateSet = own(await runtime.createBindSet(validateKernel.layout, {
                mapMeta: resources.source.mapMeta.region(),
                renderPatchPolicy: policy.region({ layout: renderPatchPolicyCodec.artifact }),
                renderPatches: resources.renderPatches.region({
                    layout: renderPatchCodec.artifact,
                }),
                renderPatchState: resources.state.region(),
                renderPatchLookup: resources.renderPatchLookup.region(),
                balancePatchLookup: resources.balancePatchLookup.region(),
            }, { label: `GPU validate final render-patch cut ${resources.parity}` }))
            const finalizeSet = own(await runtime.createBindSet(finalizeKernel.layout, {
                renderPatchPolicy: policy.region({ layout: renderPatchPolicyCodec.artifact }),
                renderPatchState: resources.state.region(),
                drawArguments: resources.drawArguments.region(),
            }, { label: `GPU finalize render patches ${resources.parity}` }))
            bindSets.push(
                resetSet,
                countSet,
                selectSet,
                expandSet,
                balanceSet,
                resetFinalDiagnosticsSet,
                validateSet,
                finalizeSet
            )
            const clearLookup = own(runtime.createClearBufferCommand({
                label: `Clear GPU render-patch lookup ${resources.parity}`,
                target: resources.renderPatchLookup.region(),
            }))
            const reset = own(runtime.createDispatchCommand({
                label: `Reset GPU render patches ${resources.parity}`,
                pipeline: resetKernel.pipeline,
                bindSets: [ { set: resetSet } ],
                count: { workgroups: [ 1, 1, 1 ] },
                resources: currentAccess(
                    [
                        resources.source.mapMeta,
                        policy,
                        resources.state,
                        resources.drawArguments,
                    ],
                    [ resources.state, resources.drawArguments ]
                ),
                whenMissing: 'throw',
            }))
            const expand = own(runtime.createDispatchCommand({
                label: `Expand GPU render patches ${resources.parity}`,
                pipeline: expandKernel.pipeline,
                bindSets: [ { set: expandSet } ],
                count: {
                    workgroups: [
                        Math.ceil(maximumRenderPatches / WORKGROUP_SIZE),
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
                    resources.renderPatchLookup,
                    previousResources.renderPatchLookup,
                ], [
                    resources.renderPatches,
                    resources.state,
                    resources.renderPatchLookup,
                ]),
                whenMissing: 'throw',
            }))
            const balance = own(runtime.createDispatchCommand({
                label: `Balance GPU render-patch cut ${resources.parity}`,
                pipeline: balanceKernel.pipeline,
                bindSets: [ { set: balanceSet } ],
                count: { workgroups: [ 1, 1, 1 ] },
                resources: currentAccess([
                    policy,
                    resources.renderPatches,
                    resources.state,
                    resources.renderPatchLookup,
                    resources.balancePatches,
                    resources.balancePatchLookup,
                ], [
                    resources.renderPatches,
                    resources.state,
                    resources.renderPatchLookup,
                    resources.balancePatches,
                    resources.balancePatchLookup,
                ]),
                whenMissing: 'throw',
            }))
            const count = own(runtime.createDispatchCommand({
                label: `Count GPU render-patch trials ${resources.parity}`,
                pipeline: countKernel.pipeline,
                bindSets: [ { set: countSet } ],
                count: {
                    workgroups: [
                        Math.ceil(maximumRenderPatches / WORKGROUP_SIZE),
                        1,
                        1,
                    ],
                },
                resources: currentAccess([
                    resources.source.mapMeta,
                    policy,
                    resources.source.visibleInstances,
                    resources.source.drawArgument.resource,
                    resources.state,
                    previousResources.renderPatchLookup,
                ], [ resources.state ]),
                whenMissing: 'throw',
            }))
            const select = own(runtime.createDispatchCommand({
                label: `Select GPU render-patch budget ${resources.parity}`,
                pipeline: selectKernel.pipeline,
                bindSets: [ { set: selectSet } ],
                count: { workgroups: [ 1, 1, 1 ] },
                resources: currentAccess(
                    [ resources.source.mapMeta, policy, resources.state ],
                    [ resources.state ]
                ),
                whenMissing: 'throw',
            }))
            const resetFinalDiagnostics = own(runtime.createDispatchCommand({
                label: `Reset final GPU render-patch diagnostics ${resources.parity}`,
                pipeline: resetFinalDiagnosticsKernel.pipeline,
                bindSets: [ { set: resetFinalDiagnosticsSet } ],
                count: { workgroups: [ 1, 1, 1 ] },
                resources: currentAccess(
                    [ resources.state ],
                    [ resources.state ]
                ),
                whenMissing: 'throw',
            }))
            const validate = own(runtime.createDispatchCommand({
                label: `Validate final GPU render-patch cut ${resources.parity}`,
                pipeline: validateKernel.pipeline,
                bindSets: [ { set: validateSet } ],
                count: {
                    workgroups: [
                        Math.ceil(maximumRenderPatches / WORKGROUP_SIZE),
                        1,
                        1,
                    ],
                },
                resources: currentAccess([
                    resources.source.mapMeta,
                    policy,
                    resources.renderPatches,
                    resources.state,
                    resources.renderPatchLookup,
                    resources.balancePatchLookup,
                ], [
                    resources.renderPatches,
                    resources.state,
                    resources.renderPatchLookup,
                    resources.balancePatchLookup,
                ]),
                whenMissing: 'throw',
            }))
            const finalize = own(runtime.createDispatchCommand({
                label: `Finalize GPU render patches ${resources.parity}`,
                pipeline: finalizeKernel.pipeline,
                bindSets: [ { set: finalizeSet } ],
                count: { workgroups: [ 1, 1, 1 ] },
                resources: currentAccess(
                    [ policy, resources.state, resources.drawArguments ],
                    [ resources.state, resources.drawArguments ]
                ),
                whenMissing: 'throw',
            }))
            const feedback = own(await runtime.createReadbackCommand({
                label: `Read GPU render-patch feedback ${resources.parity}`,
                source: {
                    region: resources.state.region(),
                    contentEpoch: 'current-at-step',
                },
                retain: 'consume-on-read',
                whenMissing: 'throw',
            }))
            return Object.freeze({
                clearLookup,
                reset,
                count,
                select,
                expand,
                balance,
                resetFinalDiagnostics,
                validate,
                finalize,
                feedback,
            })
        })) as unknown as readonly [GpuRenderPatchCommands, GpuRenderPatchCommands]
        const programs = Object.freeze([
            resetKernel.program,
            countKernel.program,
            selectKernel.program,
            expandKernel.program,
            balanceKernel.program,
            resetFinalDiagnosticsKernel.program,
            validateKernel.program,
            finalizeKernel.program,
        ])
        const pipelines = Object.freeze([
            resetKernel.pipeline,
            countKernel.pipeline,
            selectKernel.pipeline,
            expandKernel.pipeline,
            balanceKernel.pipeline,
            resetFinalDiagnosticsKernel.pipeline,
            validateKernel.pipeline,
            finalizeKernel.pipeline,
        ])
        const layouts = Object.freeze([
            resetKernel.layout,
            countKernel.layout,
            selectKernel.layout,
            expandKernel.layout,
            balanceKernel.layout,
            resetFinalDiagnosticsKernel.layout,
            validateKernel.layout,
            finalizeKernel.layout,
        ])

        const renderTemplates = Object.freeze(
            parityResources.map(resources => {
                const offset = 0
                return Object.freeze({
                    frontierId: id,
                    parity: resources.parity,
                    templateId: 'patch-mesh' as const,
                    mapMeta: resources.source.mapMeta,
                    visibleInstances: resources.renderPatches,
                    renderPatchLookup: resources.renderPatchLookup,
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
                GpuRenderPatchRenderTemplate,
                GpuRenderPatchRenderTemplate,
            ]
        )
        const identity: GpuRenderPatchIdentityObjects = Object.freeze({
            resources: Object.freeze([
                policy,
                ...parityResources.flatMap(resources => [
                    resources.renderPatches,
                    resources.renderPatchLookup,
                    resources.balancePatches,
                    resources.balancePatchLookup,
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
                    parity.clearLookup,
                    parity.reset,
                    parity.count,
                    parity.select,
                    parity.expand,
                    parity.balance,
                    parity.resetFinalDiagnostics,
                    parity.validate,
                    parity.finalize,
                    parity.feedback,
                ]),
            ]),
        })

        const frontier: GpuRenderPatchFrontier = Object.freeze({
            id,
            initialize(builder: SubmissionBuilder) {
                assertActive(disposed)
                if (builder.runtime !== runtime || builder.isSubmitted) {
                    throw new TypeError('GPU render-patch initialization requires a live owned builder')
                }
                for (const command of initializationClears) builder.clear(command)
                for (const parityCommands of commands) {
                    builder.clear(parityCommands.clearLookup)
                }
                builder.upload(policyUpload)
                return builder
            },
            encode(builder: SubmissionBuilder, frame: GpuTileFrontierFrame) {
                assertActive(disposed)
                const parity = frame?.parity
                if (builder.runtime !== runtime || builder.isSubmitted ||
                    (parity !== 0 && parity !== 1) ||
                    frame.frontierId !== descriptor.sourceTemplates[parity].frontierId) {
                    throw new TypeError('GPU render-patch encoding requires the current source frontier frame')
                }
                const selected = commands[parity]
                builder.clear(selected.clearLookup)
                builder.compute(pass, [
                    selected.reset,
                    selected.count,
                    selected.select,
                    selected.expand,
                    selected.balance,
                    selected.resetFinalDiagnostics,
                    selected.validate,
                    selected.finalize,
                ])
                encodedFrames.set(builder, frame)
                return builder
            },
            capture(builder: SubmissionBuilder, frame: GpuTileFrontierFrame) {
                assertActive(disposed)
                const parity = frame?.parity
                const encoded = encodedFrames.get(builder)
                if (builder.runtime !== runtime || builder.isSubmitted ||
                    (parity !== 0 && parity !== 1) ||
                    encoded !== frame || capturedBuilders.has(builder)) {
                    throw new TypeError(
                        'GPU render-patch capture requires one matching encoded frame'
                    )
                }
                capturedBuilders.add(builder)
                return builder.readback(commands[parity].feedback)
            },
            async feedback(frame: GpuTileFrontierFrame, submitted: SubmittedWork) {
                assertActive(disposed)
                const parity = frame?.parity
                if ((parity !== 0 && parity !== 1) ||
                    frame.frontierId !== descriptor.sourceTemplates[parity].frontierId ||
                    submitted?.runtime !== runtime) {
                    throw new TypeError(
                        'GPU render-patch feedback requires an owned frame submission'
                    )
                }
                const command = commands[parity].feedback
                if (!submitted.readbacks.some(link => link.commandId === command.id)) {
                    throw new TypeError(
                        'GPU render-patch feedback submission does not contain its readback'
                    )
                }
                const bytes = await command.result({ after: submitted }).toBytes()
                const facts = decodeGpuRenderPatchState(bytes, {
                    maximumRenderPatches,
                    expectedFrameEpoch: frame.frameEpoch,
                })
                return Object.freeze({
                    kind: 'gpu-render-patch-feedback' as const,
                    frontierId: id,
                    submissionId: submitted.id,
                    ...facts,
                })
            },
            renderTemplates() {
                assertActive(disposed)
                return renderTemplates
            },
            commandsFor(frame: GpuTileFrontierFrame) {
                assertActive(disposed)
                const parity = frame?.parity
                if ((parity !== 0 && parity !== 1) ||
                    frame.frontierId !== descriptor.sourceTemplates[parity].frontierId) {
                    throw new TypeError('GPU render-patch commands require an owned source frame')
                }
                return commands[parity]
            },
            facts() {
                return Object.freeze({
                    id,
                    selectionPath: 'gpu-balanced-normalized-projected-grid-render-patches' as const,
                    disposed,
                    dataMaximumMatrixLevel: descriptor.dataMaximumMatrixLevel,
                    maximumMatrixLevel: descriptor.renderMaximumMatrixLevel,
                    maximumExtraLevels: descriptor.maximumExtraLevels,
                    maximumSourceTiles: descriptor.maximumSourceTiles,
                    maximumRenderPatches,
                    maximumCellSpanPixels: descriptor.maximumCellSpanPixels,
                    maximumPatchCountRatio: descriptor.maximumPatchCountRatio,
                    biasStepsPerLevel: GPU_RENDER_PATCH_BIAS_STEPS_PER_LEVEL,
                    biasStepCount: GPU_RENDER_PATCH_BIAS_STEP_COUNT,
                    refinementHysteresisLevels:
                        1 / GPU_RENDER_PATCH_BIAS_STEPS_PER_LEVEL,
                    budgetHysteresisRatio: descriptor.budgetHysteresisRatio,
                    nominalPatchSpanPixels: descriptor.cellsPerPatchEdge *
                        descriptor.maximumCellSpanPixels,
                    cellsPerPatchEdge: descriptor.cellsPerPatchEdge,
                    renderPatchBytes,
                    renderPatchLookupCapacity,
                    renderPatchLookupBytes,
                    balancePassCount: GPU_RENDER_PATCH_BALANCE_PASS_COUNT,
                    balanceWorkgroupSize: BALANCE_WORKGROUP_SIZE,
                    drawArgumentBytes: DRAW_ARGUMENT_BYTES * DRAW_ARGUMENT_COUNT,
                    workgroupSize: WORKGROUP_SIZE,
                    parity: Object.freeze(parityResources.map(resources => Object.freeze({
                        parity: resources.parity,
                        sourceBufferId: resources.source.visibleInstances.id,
                        renderPatchBufferId: resources.renderPatches.id,
                        renderPatchLookupBufferId: resources.renderPatchLookup.id,
                        balancePatchBufferId: resources.balancePatches.id,
                        balancePatchLookupBufferId: resources.balancePatchLookup.id,
                        stateBufferId: resources.state.id,
                        drawArgumentBufferId: resources.drawArguments.id,
                        commandIds: Object.freeze([
                            commands[resources.parity].clearLookup.id,
                            commands[resources.parity].reset.id,
                            commands[resources.parity].count.id,
                            commands[resources.parity].select.id,
                            commands[resources.parity].expand.id,
                            commands[resources.parity].balance.id,
                            commands[resources.parity].resetFinalDiagnostics.id,
                            commands[resources.parity].validate.id,
                            commands[resources.parity].finalize.id,
                            commands[resources.parity].feedback.id,
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
    options: GpuRenderPatchFrontierDescriptor
): Required<GpuRenderPatchFrontierDescriptor> {

    const renderMaximumMatrixLevel = options.renderMaximumMatrixLevel ??
        GPU_RENDER_PATCH_MAXIMUM_MATRIX_LEVEL
    const maximumExtraLevels = options.maximumExtraLevels ?? GPU_RENDER_PATCH_MAXIMUM_EXTRA_LEVELS
    const cellsPerPatchEdge = options.cellsPerPatchEdge ??
        GPU_RENDER_PATCH_DEFAULT_CELLS_PER_EDGE
    const maximumCellSpanPixels = options.maximumCellSpanPixels ??
        GPU_RENDER_PATCH_DEFAULT_MAXIMUM_CELL_SPAN_PIXELS
    const maximumPatchCountRatio = options.maximumPatchCountRatio ??
        GPU_RENDER_PATCH_DEFAULT_MAXIMUM_COUNT_RATIO
    const budgetHysteresisRatio = options.budgetHysteresisRatio ??
        GPU_RENDER_PATCH_DEFAULT_BUDGET_HYSTERESIS_RATIO
    if (runtime === undefined || typeof runtime.createBuffer !== 'function') {
        throw new TypeError('GPU render-patch frontier requires GPURuntime')
    }
    if (options.sourceTemplates?.length !== 2 ||
        options.sourceTemplates.some((template, parity) => (
            template?.parity !== parity || template.mapMeta === undefined ||
            template.visibleInstances === undefined || template.drawArgument === undefined
        ))) {
        throw new TypeError('GPU render-patch frontier requires two source parity templates')
    }
    for (const [ name, value ] of [
        [ 'maximumSourceTiles', options.maximumSourceTiles ],
        [ 'dataMaximumMatrixLevel', options.dataMaximumMatrixLevel ],
        [ 'renderMaximumMatrixLevel', renderMaximumMatrixLevel ],
        [ 'maximumExtraLevels', maximumExtraLevels ],
        [ 'coordinateBits', options.coordinateBits ],
        [ 'vertexCount', options.vertexCount ],
        [ 'cellsPerPatchEdge', cellsPerPatchEdge ],
    ] as const) {
        if (!Number.isInteger(value) || value < 0) {
            throw new TypeError(`GPU render-patch ${name} must be a non-negative integer`)
        }
    }
    if (options.maximumSourceTiles < 1 || options.vertexCount < 1 ||
        renderMaximumMatrixLevel < options.dataMaximumMatrixLevel ||
        renderMaximumMatrixLevel > GPU_RENDER_PATCH_MAXIMUM_MATRIX_LEVEL ||
        maximumExtraLevels > GPU_RENDER_PATCH_MAXIMUM_EXTRA_LEVELS ||
        maximumExtraLevels > renderMaximumMatrixLevel ||
        options.coordinateBits <= renderMaximumMatrixLevel) {
        throw new TypeError('GPU render-patch policy bounds are invalid')
    }
    if (options.elevationRangeMeters?.length !== 2 ||
        options.elevationRangeMeters.some(value => !Number.isFinite(value)) ||
        options.elevationRangeMeters[0] > options.elevationRangeMeters[1]) {
        throw new TypeError('GPU render-patch elevation range is invalid')
    }
    if (!Number.isFinite(maximumCellSpanPixels) || maximumCellSpanPixels <= 0) {
        throw new TypeError('GPU render-patch maximum cell span must be positive and finite')
    }
    if (!Number.isFinite(maximumPatchCountRatio) || maximumPatchCountRatio < 1 ||
        !Number.isFinite(budgetHysteresisRatio) || budgetHysteresisRatio < 0 ||
        budgetHysteresisRatio > 1) {
        throw new TypeError('GPU render-patch budget policy is invalid')
    }
    return Object.freeze({
        ...options,
        sourceTemplates: options.sourceTemplates,
        renderMaximumMatrixLevel,
        maximumExtraLevels,
        cellsPerPatchEdge,
        maximumCellSpanPixels,
        maximumPatchCountRatio,
        budgetHysteresisRatio,
    })
}

function assertActive(disposed: boolean) {

    if (disposed) throw new Error('GPU render-patch frontier is disposed')
}
