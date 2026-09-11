import {
    GPURuntime,
    layoutCodec,
} from 'geoscratch/scratch'
import type {
    BindLayout,
    BindSet,
    BufferRegion,
    BufferResource,
    ClearBufferCommand,
    CommandResourceReadDescriptor,
    ComputePassSpec,
    ComputePipeline,
    DispatchCommand,
    DrawCommand,
    LayoutCodec,
    LayoutFixedFieldDescriptor,
    Program,
    ProgramBufferLayoutRequirement,
    ReadbackCommand,
    RenderPipeline,
    ShaderModule,
    SubmissionBuilder,
    SubmittedWork,
    TextureResource,
    UploadCommand,
} from 'geoscratch/scratch'
import type { TemporalVelocityWgslModule } from './temporal-velocity-raster.ts'
import type { FlowTemporalReadyBindingFrame } from './flow-temporal-bindings.ts'

export type FlowContourPoint = readonly [number, number]
export type FlowContourSegment = readonly [FlowContourPoint, FlowContourPoint]

const CASE_EDGES: Readonly<Record<number, readonly (readonly [number, number])[]>> =
    Object.freeze({
        0: [],
        1: [ [ 3, 0 ] ],
        2: [ [ 0, 1 ] ],
        3: [ [ 3, 1 ] ],
        4: [ [ 1, 2 ] ],
        6: [ [ 0, 2 ] ],
        7: [ [ 3, 2 ] ],
        8: [ [ 2, 3 ] ],
        9: [ [ 0, 2 ] ],
        11: [ [ 1, 2 ] ],
        12: [ [ 1, 3 ] ],
        13: [ [ 0, 1 ] ],
        14: [ [ 3, 0 ] ],
        15: [],
    })

/** Evaluates one bilinear cell using top-left, top-right, bottom-right, bottom-left values. */
export function flowContourSegments(
    inputValues: readonly number[],
    threshold: number
): readonly FlowContourSegment[] {

    if (!Array.isArray(inputValues) || inputValues.length !== 4 ||
        inputValues.some(value => !Number.isFinite(value)) || !Number.isFinite(threshold)) {
        throw new TypeError('Flow contour requires four finite corner values and one threshold')
    }
    const values = inputValues.map(value => value - threshold)
    const code = values.reduce((result, value, index) =>
        result | (value >= 0 ? 1 << index : 0), 0)
    const edgePairs = code === 5 || code === 10
        ? ambiguousEdges(code, values)
        : CASE_EDGES[code]!
    return Object.freeze(edgePairs.map(pair => Object.freeze([
        edgePoint(pair[0], values),
        edgePoint(pair[1], values),
    ]) as FlowContourSegment))
}

/** Assigns each logical contour cell to the page containing its top-left texel. */
export function ownsFlowContourCell(input: Readonly<{
    cellX: number
    cellY: number
    pageCol: number
    pageRow: number
    pageSize: number
    globalWidth: number
    globalHeight: number
}>): boolean {

    for (const value of [
        input?.cellX,
        input?.cellY,
        input?.pageCol,
        input?.pageRow,
        input?.pageSize,
        input?.globalWidth,
        input?.globalHeight,
    ]) {
        if (!Number.isSafeInteger(value) || value < 0) {
            throw new TypeError('Flow contour ownership requires non-negative integer facts')
        }
    }
    if (input.pageSize === 0 || input.globalWidth === 0 || input.globalHeight === 0) {
        throw new RangeError('Flow contour dimensions must be positive')
    }
    if (input.cellX >= input.globalWidth - 1 || input.cellY >= input.globalHeight - 1) {
        return false
    }
    const originX = input.pageCol * input.pageSize
    const originY = input.pageRow * input.pageSize
    return input.cellX >= originX && input.cellX < originX + input.pageSize &&
        input.cellY >= originY && input.cellY < originY + input.pageSize
}

/** Computes the hard two-segment-per-cell capacity bound without truncation. */
export function flowContourCapacity(input: Readonly<{
    candidateCellCount: number
    segmentCapacity: number
}>): Readonly<{
    requiredMaximum: number
    capacity: number
    overflow: boolean
}> {

    if (!Number.isSafeInteger(input?.candidateCellCount) || input.candidateCellCount < 0 ||
        !Number.isSafeInteger(input?.segmentCapacity) || input.segmentCapacity < 0 ||
        input.candidateCellCount > Math.floor(Number.MAX_SAFE_INTEGER / 2)) {
        throw new RangeError('Flow contour capacity requires bounded non-negative integers')
    }
    const requiredMaximum = input.candidateCellCount * 2
    return Object.freeze({
        requiredMaximum,
        capacity: input.segmentCapacity,
        overflow: requiredMaximum > input.segmentCapacity,
    })
}

export const FLOW_CONTOUR_CANDIDATE_BYTE_LENGTH = 32
export const FLOW_CONTOUR_SEGMENT_BYTE_LENGTH = 32
export const FLOW_CONTOUR_INDIRECT_BYTE_LENGTH = 16
export const FLOW_CONTOUR_OVERFLOW_BYTE_LENGTH = 4
export const FLOW_CONTOUR_VIEW_UNIFORM_BYTE_LENGTH = 112

const FLOW_CONTOUR_WORKGROUP_SIZE = 64
const MAXIMUM_CONTOUR_CANDIDATES = 65_535 * FLOW_CONTOUR_WORKGROUP_SIZE
const BUFFER_COPY_SRC = 0x04
const BUFFER_COPY_DST = 0x08
const BUFFER_UNIFORM = 0x40
const BUFFER_STORAGE = 0x80
const BUFFER_INDIRECT = 0x100

export type FlowContourTemporalBinding = Readonly<{
    module: TemporalVelocityWgslModule
    layout: BindLayout
}>

export type FlowContourViewBinding = Readonly<{
    bindLayout: BindLayout
    bindSet: BindSet
    resources: readonly (BufferResource | TextureResource)[]
}>

export type FlowContourSnapshotParameters = Readonly<{
    generation: number
    currentSnapshotEpoch: number
    nextSnapshotEpoch: number
    progress: number
    activityKill: number
}>

export type FlowContourOptions = Readonly<{
    runtime: GPURuntime
    targetFormat: GPUTextureFormat
    maximumCandidateCount: number
    segmentCapacity: number
    temporal: FlowContourTemporalBinding
    view: FlowContourViewBinding
}>

export type FlowContourFrame = Readonly<{
    candidateCount: number
    segmentCapacity: number
    generation: number
    currentSnapshotEpoch: number
    nextSnapshotEpoch: number
    dispatchWorkgroups: number
}>

export type FlowContourFacts = FlowContourFrame & Readonly<{
    maximumCandidateCount: number
    candidateByteLength: 32
    segmentByteLength: 32
    indirectByteLength: 16
    overflowByteLength: 4
    viewUniformByteLength: 112
    disposed: boolean
}>

export type FlowContourResources = Readonly<{
    candidates: BufferRegion
    segments: BufferRegion
    indirect: BufferRegion
    overflow: BufferRegion
}>

export type FlowContour = Readonly<{
    draw: DrawCommand
    resources: FlowContourResources
    encode(
        builder: SubmissionBuilder,
        candidateBytes: ArrayBufferView,
        candidateCount: number,
        snapshot: FlowContourSnapshotParameters,
        temporal: FlowTemporalReadyBindingFrame
    ): FlowContourFrame
    observeOverflow(submitted: SubmittedWork): Promise<void>
    facts(): FlowContourFacts
    dispose(): void
}>

type ContourUniformValues = {
    candidateCount: number
    segmentCapacity: number
    generation: number
    reservedU32: number
    progress: number
    activityKill: number
    currentSnapshotEpoch: number
    nextSnapshotEpoch: number
}

type OwnedContourGraph = Readonly<{
    buffers: readonly BufferResource[]
    uploads: readonly UploadCommand[]
    clearOverflow: ClearBufferCommand
    clearSegments: ClearBufferCommand
    bindLayouts: readonly BindLayout[]
    bindSets: readonly BindSet[]
    shaderModules: readonly ShaderModule[]
    programs: readonly Program[]
    computePipeline: ComputePipeline
    renderPipeline: RenderPipeline
    computePass: ComputePassSpec
    draw: DrawCommand
    overflowReadback: ReadbackCommand
}>

/** Creates a fixed-capacity GPU marching-squares product with indirect line drawing. */
export async function createFlowContour(options: FlowContourOptions): Promise<FlowContour> {

    const runtime = options?.runtime
    if (!(runtime instanceof GPURuntime)) {
        throw new TypeError('Flow contour requires a GPURuntime')
    }
    const maximumCandidateCount = boundedPositiveInteger(
        options.maximumCandidateCount,
        MAXIMUM_CONTOUR_CANDIDATES,
        'maximumCandidateCount'
    )
    const segmentCapacity = boundedPositiveInteger(
        options.segmentCapacity,
        0x7fff_ffff,
        'segmentCapacity'
    )
    if (typeof options.targetFormat !== 'string' || options.targetFormat.length === 0) {
        throw new TypeError('Flow contour requires one render target format')
    }
    const temporal: FlowContourTemporalBinding = options.temporal
    const view: FlowContourViewBinding = options.view
    validateTemporalBinding(runtime, temporal)
    validateViewBinding(runtime, view)

    const uniformCodec = contourUniformCodec()
    const initialSnapshot = Object.freeze({
        generation: 1,
        currentSnapshotEpoch: 1,
        nextSnapshotEpoch: 1,
        progress: 0,
        activityKill: 0,
    })
    const uniformBytes = uniformCodec.pack(contourUniformValues(
        0,
        segmentCapacity,
        initialSnapshot
    ))
    const candidateStaging = new Uint8Array(
        maximumCandidateCount * FLOW_CONTOUR_CANDIDATE_BYTE_LENGTH
    )
    const candidates = await runtime.createBuffer({
        label: 'Flow Field contour candidates',
        size: candidateStaging.byteLength,
        usage: BUFFER_COPY_DST | BUFFER_STORAGE,
    })
    const uniform = await runtime.createBuffer({
        label: 'Flow Field contour uniform',
        size: uniformBytes.byteLength,
        usage: BUFFER_COPY_DST | BUFFER_UNIFORM,
    })
    const segments = await runtime.createBuffer({
        label: 'Flow Field contour segments',
        size: segmentCapacity * FLOW_CONTOUR_SEGMENT_BYTE_LENGTH,
        usage: BUFFER_COPY_DST | BUFFER_STORAGE,
    })
    const indirect = await runtime.createBuffer({
        label: 'Flow Field contour indirect arguments',
        size: FLOW_CONTOUR_INDIRECT_BYTE_LENGTH,
        usage: BUFFER_COPY_DST | BUFFER_STORAGE | BUFFER_INDIRECT,
    })
    const overflow = await runtime.createBuffer({
        label: 'Flow Field contour overflow',
        size: FLOW_CONTOUR_OVERFLOW_BYTE_LENGTH,
        usage: BUFFER_COPY_SRC | BUFFER_COPY_DST | BUFFER_STORAGE,
    })
    const resources: FlowContourResources = Object.freeze({
        candidates: candidates.region(),
        segments: segments.region(),
        indirect: indirect.region(),
        overflow: overflow.region(),
    })
    const uniformRegion = uniform.region({ layout: uniformCodec.artifact })
    const uniformUpload = runtime.createUploadCommand({
        label: 'Upload Flow Field contour uniform',
        target: uniformRegion,
        data: uniformBytes,
    })
    const candidateUpload = runtime.createUploadCommand({
        label: 'Upload Flow Field contour candidates',
        target: resources.candidates,
        data: candidateStaging,
    })
    const indirectReset = runtime.createUploadCommand({
        label: 'Reset Flow Field contour indirect arguments',
        target: indirect.region(),
        data: new Uint32Array([ 0, 1, 0, 0 ]),
    })
    const clearOverflow = runtime.createClearBufferCommand({
        label: 'Clear Flow Field contour overflow',
        target: overflow.region(),
    })
    const clearSegments = runtime.createClearBufferCommand({
        label: 'Initialize Flow Field contour segments',
        target: segments.region(),
    })
    const computeLayout = await runtime.createBindLayout({
        label: 'Flow Field contour compute layout',
        group: 0,
        entries: [
            {
                binding: 0,
                name: 'contourUniform',
                type: 'uniform',
                visibility: [ 'compute' ],
                minBindingSize: uniformCodec.byteLength(),
            },
            {
                binding: 1,
                name: 'candidateCells',
                type: 'read-storage',
                visibility: [ 'compute' ],
                minBindingSize: FLOW_CONTOUR_CANDIDATE_BYTE_LENGTH,
            },
            {
                binding: 2,
                name: 'segments',
                type: 'storage',
                visibility: [ 'compute' ],
                minBindingSize: FLOW_CONTOUR_SEGMENT_BYTE_LENGTH,
            },
            {
                binding: 3,
                name: 'indirect',
                type: 'storage',
                visibility: [ 'compute' ],
                minBindingSize: FLOW_CONTOUR_INDIRECT_BYTE_LENGTH,
            },
            {
                binding: 4,
                name: 'overflow',
                type: 'storage',
                visibility: [ 'compute' ],
                minBindingSize: FLOW_CONTOUR_OVERFLOW_BYTE_LENGTH,
            },
        ],
    })
    const computeSet = await runtime.createBindSet(computeLayout, {
        contourUniform: uniformRegion,
        candidateCells: resources.candidates,
        segments: resources.segments,
        indirect: resources.indirect,
        overflow: resources.overflow,
    }, { label: 'Flow Field contour compute resources' })
    const segmentLayout = await runtime.createBindLayout({
        label: 'Flow Field contour segment layout',
        group: 0,
        entries: [ {
            binding: 0,
            name: 'segments',
            type: 'read-storage',
            visibility: [ 'vertex' ],
            minBindingSize: FLOW_CONTOUR_SEGMENT_BYTE_LENGTH,
        } ],
    })
    const segmentSet = await runtime.createBindSet(segmentLayout, {
        segments: resources.segments,
    }, { label: 'Flow Field contour draw segments' })
    const [ computeShader, renderShader ] = await Promise.all([
        fetchTextAsset(new URL('./shaders/contour.compute.wgsl', import.meta.url)),
        fetchTextAsset(new URL('./shaders/contour.wgsl', import.meta.url)),
    ])
    const computeModule = await runtime.createShaderModule({
        label: 'Flow Field contour compute shader',
        sourceParts: [
            { code: temporal.module.code },
            { code: computeShader },
        ],
    })
    const renderModule = await runtime.createShaderModule({
        label: 'Flow Field contour render shader',
        sourceParts: [ { code: renderShader } ],
    })
    const requirement: ProgramBufferLayoutRequirement = {
        group: 0,
        binding: 0,
        type: 'uniform',
        hasDynamicOffset: false,
        layout: uniformCodec.artifact,
    }
    const computeProgram = runtime.createProgram({
        label: 'Flow Field contour compute program',
        compute: { module: computeModule, entryPoint: 'generateFlowContour' },
        layoutRequirements: [ requirement ],
    })
    const renderProgram = runtime.createProgram({
        label: 'Flow Field contour render program',
        vertex: { module: renderModule, entryPoint: 'vContour' },
        fragment: { module: renderModule, entryPoint: 'fContour' },
    })
    const computePipeline = await runtime.createComputePipeline({
        label: 'Flow Field contour compute pipeline',
        program: computeProgram,
        layout: { mode: 'explicit', bindLayouts: [ computeLayout, temporal.layout ] },
    })
    const renderPipeline = await runtime.createRenderPipeline({
        label: 'Flow Field contour line pipeline',
        program: renderProgram,
        layout: { mode: 'explicit', bindLayouts: [ segmentLayout, view.bindLayout ] },
        targets: [ { format: options.targetFormat } ],
        primitive: { topology: 'line-list' },
    })
    const computePass = runtime.createComputePass({ label: 'Flow Field contour compute pass' })
    const dispatchWorkgroups = Math.ceil(maximumCandidateCount / FLOW_CONTOUR_WORKGROUP_SIZE)
    const draw = runtime.createDrawCommand({
        label: 'Draw Flow Field contour',
        pipeline: renderPipeline,
        bindSets: [ { set: segmentSet }, { set: view.bindSet } ],
        count: { indirect: indirect.region() },
        resources: {
            read: [
                { resource: segments, contentEpoch: 'current-at-step' },
                { resource: indirect, contentEpoch: 'current-at-step' },
                ...currentReads(view.resources),
            ],
            write: [],
        },
        whenMissing: 'throw',
    })
    const overflowReadback = await runtime.createReadbackCommand({
        label: 'Observe Flow Field contour overflow',
        source: {
            region: overflow.region(),
            contentEpoch: 'current-at-step',
        },
        retain: 'consume-on-read',
        whenMissing: 'throw',
    })
    const graph: OwnedContourGraph = Object.freeze({
        buffers: Object.freeze([ candidates, uniform, segments, indirect, overflow ]),
        uploads: Object.freeze([ candidateUpload, uniformUpload, indirectReset ]),
        clearOverflow,
        clearSegments,
        bindLayouts: Object.freeze([ computeLayout, segmentLayout ]),
        bindSets: Object.freeze([ computeSet, segmentSet ]),
        shaderModules: Object.freeze([ computeModule, renderModule ]),
        programs: Object.freeze([ computeProgram, renderProgram ]),
        computePipeline,
        renderPipeline,
        computePass,
        draw,
        overflowReadback,
    })
    let generate: DispatchCommand | undefined
    let temporalSet: BindSet | undefined
    let segmentsInitialized = false
    let candidateCount = 0
    let generation = 0
    let currentSnapshotEpoch = 0
    let nextSnapshotEpoch = 0
    let disposed = false

    function encode(
        builder: SubmissionBuilder,
        packedCandidates: ArrayBufferView,
        nextCandidateCount: number,
        snapshot: FlowContourSnapshotParameters,
        temporalFrame: FlowTemporalReadyBindingFrame
    ): FlowContourFrame {

        assertActive()
        if (builder?.runtime !== runtime) {
            throw new TypeError('Flow contour requires a same-runtime SubmissionBuilder')
        }
        if (!ArrayBuffer.isView(packedCandidates) ||
            !Number.isSafeInteger(nextCandidateCount) || nextCandidateCount < 0 ||
            nextCandidateCount > maximumCandidateCount ||
            packedCandidates.byteLength !==
                nextCandidateCount * FLOW_CONTOUR_CANDIDATE_BYTE_LENGTH) {
            throw new RangeError('Flow contour candidate bytes must match a bounded record count')
        }
        validateSnapshot(snapshot)
        validateTemporalFrame(runtime, temporal, temporalFrame)
        if (temporalFrame.pairGeneration !== snapshot.generation ||
            temporalFrame.progress !== snapshot.progress) {
            throw new Error('Flow contour temporal frame progress is stale')
        }
        if (generate === undefined || temporalSet !== temporalFrame.bindSet) {
            generate?.dispose()
            temporalSet = temporalFrame.bindSet
            generate = runtime.createDispatchCommand({
                label: 'Generate Flow Field contour',
                pipeline: computePipeline,
                bindSets: [ { set: computeSet }, { set: temporalFrame.bindSet } ],
                count: { workgroups: [ dispatchWorkgroups ] },
                resources: {
                    read: [
                        { resource: candidates, contentEpoch: 'current-at-step' },
                        { resource: uniform, contentEpoch: 'current-at-step' },
                        { resource: segments, contentEpoch: 'current-at-step' },
                        { resource: indirect, contentEpoch: 'current-at-step' },
                        { resource: overflow, contentEpoch: 'current-at-step' },
                        ...currentReads(temporalFrame.resources),
                    ],
                    write: [ segments, indirect, overflow ],
                },
                whenMissing: 'throw',
            })
        }
        candidateStaging.fill(0)
        candidateStaging.set(new Uint8Array(
            packedCandidates.buffer,
            packedCandidates.byteOffset,
            packedCandidates.byteLength
        ))
        uniformCodec.write(
            uniformBytes,
            contourUniformValues(nextCandidateCount, segmentCapacity, snapshot)
        )
        builder.upload(candidateUpload)
        builder.upload(uniformUpload)
        builder.upload(indirectReset)
        if (!segmentsInitialized) {
            builder.clear(clearSegments)
            segmentsInitialized = true
        }
        builder.clear(clearOverflow)
        builder.compute(computePass, [ generate ])
        builder.readback(overflowReadback)
        candidateCount = nextCandidateCount
        generation = snapshot.generation
        currentSnapshotEpoch = snapshot.currentSnapshotEpoch
        nextSnapshotEpoch = snapshot.nextSnapshotEpoch
        return Object.freeze({
            candidateCount,
            segmentCapacity,
            generation,
            currentSnapshotEpoch,
            nextSnapshotEpoch,
            dispatchWorkgroups,
        })
    }

    async function observeOverflow(submitted: SubmittedWork): Promise<void> {

        assertActive()
        if (submitted?.runtime !== runtime) {
            throw new TypeError('Flow contour overflow requires a same-runtime submission')
        }
        const values = await overflowReadback.result({ after: submitted }).toArray(Uint32Array)
        assertFlowContourOverflow(values)
    }

    function facts(): FlowContourFacts {

        return Object.freeze({
            maximumCandidateCount,
            segmentCapacity,
            candidateByteLength: FLOW_CONTOUR_CANDIDATE_BYTE_LENGTH,
            segmentByteLength: FLOW_CONTOUR_SEGMENT_BYTE_LENGTH,
            indirectByteLength: FLOW_CONTOUR_INDIRECT_BYTE_LENGTH,
            overflowByteLength: FLOW_CONTOUR_OVERFLOW_BYTE_LENGTH,
            viewUniformByteLength: FLOW_CONTOUR_VIEW_UNIFORM_BYTE_LENGTH,
            candidateCount,
            generation,
            currentSnapshotEpoch,
            nextSnapshotEpoch,
            dispatchWorkgroups,
            disposed,
        })
    }

    function dispose(): void {

        if (disposed) return
        disposed = true
        graph.overflowReadback.dispose()
        graph.draw.dispose()
        generate?.dispose()
        graph.computePass.dispose()
        graph.renderPipeline.dispose()
        graph.computePipeline.dispose()
        for (const program of graph.programs) program.dispose()
        for (const shaderModule of graph.shaderModules) shaderModule.dispose()
        for (const bindSet of graph.bindSets) bindSet.dispose()
        for (const bindLayout of graph.bindLayouts) bindLayout.dispose()
        graph.clearOverflow.dispose()
        graph.clearSegments.dispose()
        for (const upload of graph.uploads) upload.dispose()
        for (const buffer of graph.buffers) buffer.dispose()
    }

    function assertActive(): void {

        if (disposed) throw new Error('Flow contour is disposed')
    }

    return Object.freeze({ draw, resources, encode, observeOverflow, facts, dispose })
}

/** Rejects any observed GPU overflow instead of accepting a truncated contour. */
export function assertFlowContourOverflow(values: Uint32Array): void {

    if (!(values instanceof Uint32Array) || values.length !== 1) {
        throw new TypeError('Flow contour overflow observation must contain one u32')
    }
    if (values[0] !== 0) {
        throw new RangeError('Flow contour segment capacity was exceeded')
    }
}

function contourUniformCodec(): LayoutCodec {

    const fields: LayoutFixedFieldDescriptor[] = [
        { name: 'candidateCount', type: 'u32' },
        { name: 'segmentCapacity', type: 'u32' },
        { name: 'generation', type: 'u32' },
        { name: 'reservedU32', type: 'u32' },
        { name: 'progress', type: 'f32' },
        { name: 'activityKill', type: 'f32' },
        { name: 'currentSnapshotEpoch', type: 'u32' },
        { name: 'nextSnapshotEpoch', type: 'u32' },
    ]
    return layoutCodec({ name: 'FlowContourUniform', fields }, { usage: [ 'uniform' ] })
}

function contourUniformValues(
    candidateCount: number,
    segmentCapacity: number,
    snapshot: FlowContourSnapshotParameters
): ContourUniformValues {

    return {
        candidateCount,
        segmentCapacity,
        generation: snapshot.generation,
        reservedU32: 0,
        progress: snapshot.progress,
        activityKill: snapshot.activityKill,
        currentSnapshotEpoch: snapshot.currentSnapshotEpoch,
        nextSnapshotEpoch: snapshot.nextSnapshotEpoch,
    }
}

function validateTemporalBinding(runtime: GPURuntime, temporal: FlowContourTemporalBinding): void {

    if (temporal?.module?.kind !== 'temporal-velocity-wgsl-module' ||
        typeof temporal.module.code !== 'string' ||
        !temporal.module.code.includes('fn FlowVelocity_sample(') ||
        temporal.module.bindings.group !== 1 ||
        temporal.layout?.runtime !== runtime || temporal.layout.group !== 1) {
        throw new TypeError(
            'Flow contour requires one group-1 temporal sampler and its declared resources'
        )
    }
}

function validateTemporalFrame(
    runtime: GPURuntime,
    temporal: FlowContourTemporalBinding,
    frame: FlowTemporalReadyBindingFrame
): void {

    if (frame?.state !== 'ready' || frame.bindSet?.runtime !== runtime ||
        frame.bindSet.layout !== temporal.layout ||
        !Array.isArray(frame.resources) || frame.resources.length !== (temporal.module.bindings.current?.metadata === undefined ? 4 : 6) ||
        frame.resources.some(resource => resource?.runtime !== runtime) ||
        !Number.isSafeInteger(frame.requestedRevision) || frame.requestedRevision <= 0 ||
        !Number.isSafeInteger(frame.pairGeneration) || frame.pairGeneration <= 0 ||
        !Number.isSafeInteger(frame.requestedLevel) || frame.requestedLevel < 0 ||
        !Number.isFinite(frame.progress) || frame.progress < 0 || frame.progress > 1) {
        throw new TypeError(
            'Flow contour requires one current temporal set and its declared resources'
        )
    }
}

function validateViewBinding(runtime: GPURuntime, view: FlowContourViewBinding): void {

    const entry = view?.bindLayout?.entries?.[0]
    if (view?.bindLayout?.runtime !== runtime || view.bindLayout.group !== 1 ||
        view.bindLayout.entries.length !== 1 || entry?.binding !== 0 ||
        entry.name !== 'contourView' || entry.type !== 'uniform' ||
        !entry.visibility.includes('vertex') ||
        entry.minBindingSize < FLOW_CONTOUR_VIEW_UNIFORM_BYTE_LENGTH ||
        view.bindSet?.runtime !== runtime || view.bindSet.layout !== view.bindLayout ||
        !Array.isArray(view.resources) || view.resources.length !== 1 ||
        view.resources[0]?.runtime !== runtime) {
        throw new TypeError(
            'Flow contour view requires one group-1 camera-relative 112-byte uniform binding'
        )
    }
}

function validateSnapshot(snapshot: FlowContourSnapshotParameters): void {

    if (!Number.isSafeInteger(snapshot?.generation) || snapshot.generation <= 0 ||
        !Number.isSafeInteger(snapshot.currentSnapshotEpoch) ||
        snapshot.currentSnapshotEpoch <= 0 ||
        !Number.isSafeInteger(snapshot.nextSnapshotEpoch) || snapshot.nextSnapshotEpoch <= 0 ||
        !Number.isFinite(snapshot.progress) || snapshot.progress < 0 || snapshot.progress > 1 ||
        !Number.isFinite(snapshot.activityKill) || snapshot.activityKill < 0) {
        throw new TypeError('Flow contour temporal snapshot parameters are invalid or stale')
    }
}

function currentReads(
    resources: readonly (BufferResource | TextureResource)[]
): CommandResourceReadDescriptor[] {

    const unique = new Map(resources.map(resource => [ resource.id, resource ]))
    return [ ...unique.values() ].map(resource => ({
        resource,
        contentEpoch: 'current-at-step',
    }))
}

async function fetchTextAsset(url: URL): Promise<string> {

    const response = await fetch(url)
    if (!response.ok) {
        throw new Error(`Flow contour shader request failed with HTTP ${response.status}`)
    }
    return response.text()
}

function boundedPositiveInteger(value: number, maximum: number, name: string): number {

    if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
        throw new RangeError(`Flow contour ${name} must be a bounded positive integer`)
    }
    return value
}

function ambiguousEdges(
    code: 5 | 10,
    values: readonly number[]
): readonly (readonly [number, number])[] {

    const determinant = values[0]! * values[2]! - values[1]! * values[3]!
    if (code === 5) {
        return determinant >= 0
            ? [ [ 0, 1 ], [ 2, 3 ] ]
            : [ [ 3, 0 ], [ 1, 2 ] ]
    }
    return determinant >= 0
        ? [ [ 3, 0 ], [ 1, 2 ] ]
        : [ [ 0, 1 ], [ 2, 3 ] ]
}

function edgePoint(edge: number, values: readonly number[]): FlowContourPoint {

    switch (edge) {
        case 0: return Object.freeze([ interpolation(values[0]!, values[1]!), 0 ])
        case 1: return Object.freeze([ 1, interpolation(values[1]!, values[2]!) ])
        case 2: return Object.freeze([ 1 - interpolation(values[2]!, values[3]!), 1 ])
        case 3: return Object.freeze([ 0, 1 - interpolation(values[3]!, values[0]!) ])
        default: throw new RangeError(`Unknown Flow contour edge ${edge}`)
    }
}

function interpolation(first: number, second: number): number {

    const denominator = first - second
    if (denominator === 0) return 0.5
    return Math.min(1, Math.max(0, first / denominator))
}
