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
    LayoutCodec,
    LayoutFixedFieldDescriptor,
    Program,
    ProgramBufferLayoutRequirement,
    ShaderModule,
    SubmissionBuilder,
    TextureResource,
    UploadCommand,
} from 'geoscratch/scratch'
import type { TemporalVelocityWgslModule } from './temporal-velocity-raster.ts'


export type FlowSpawnSample = Readonly<{
    available: boolean
    speed: number
}>

export type FlowSpawnReferenceIndex<Candidate> = Readonly<{
    candidates: readonly Candidate[]
    count: number
    capacity: number
    dormant: boolean
}>

/** CPU reference for the bounded GPU support-cell compaction contract. */
export function compactFlowSpawnCandidates<Candidate>(input: Readonly<{
    candidates: readonly Candidate[]
    samples: readonly FlowSpawnSample[]
    activitySpawn: number
    capacity: number
}>): FlowSpawnReferenceIndex<Candidate> {

    if (!Array.isArray(input?.candidates) || !Array.isArray(input?.samples) ||
        input.candidates.length !== input.samples.length ||
        !Number.isFinite(input.activitySpawn) || input.activitySpawn < 0 ||
        !Number.isSafeInteger(input.capacity) || input.capacity < 0) {
        throw new TypeError('Flow spawn compaction requires aligned samples and bounded capacity')
    }
    const candidates: Candidate[] = []
    for (let index = 0; index < input.candidates.length; index++) {
        const sample = input.samples[index]
        if (typeof sample?.available !== 'boolean' ||
            !Number.isFinite(sample.speed) || sample.speed < 0) {
            throw new TypeError(`Flow spawn sample ${index} is invalid`)
        }
        if (!sample.available || sample.speed < input.activitySpawn) continue
        if (candidates.length === input.capacity) {
            throw new RangeError('Flow spawn index capacity was exceeded')
        }
        candidates.push(input.candidates[index]!)
    }
    const immutableCandidates = Object.freeze(candidates)
    return Object.freeze({
        candidates: immutableCandidates,
        count: immutableCandidates.length,
        capacity: input.capacity,
        dormant: immutableCandidates.length === 0,
    })
}

/** Selects one compacted support cell without whole-domain rejection sampling. */
export function selectFlowSpawnCandidate<Candidate>(
    index: FlowSpawnReferenceIndex<Candidate>,
    randomState: number
): Candidate | undefined {

    if (!Number.isSafeInteger(randomState) || randomState < 0 || randomState > 0xffff_ffff ||
        !Array.isArray(index?.candidates) || !Number.isSafeInteger(index?.count) ||
        index.count !== index.candidates.length || !Number.isSafeInteger(index?.capacity) ||
        index.capacity < index.count || index.dormant !== (index.count === 0)) {
        throw new TypeError('Flow spawn selection requires a coherent bounded index and u32 state')
    }
    return index.count === 0 ? undefined : index.candidates[randomState % index.count]
}

export const FLOW_SPAWN_CANDIDATE_BYTE_LENGTH = 32
const FLOW_SPAWN_WORKGROUP_SIZE = 64
const U32_BYTE_LENGTH = 4
const U32_MAX = 0xffff_ffff

export type FlowSpawnTemporalBinding = Readonly<{
    module: TemporalVelocityWgslModule
    bindLayout: BindLayout
    bindSet: BindSet
    resources: readonly (BufferResource | TextureResource)[]
}>

export type FlowSpawnSnapshotParameters = Readonly<{
    generation: number
    currentSnapshotEpoch: number
    nextSnapshotEpoch: number
    progress: number
    activitySpawn: number
    activityKill: number
}>

export type FlowSpawnIndexOptions = Readonly<{
    runtime: GPURuntime
    maximumCandidateCount: number
    capacity: number
    temporal: FlowSpawnTemporalBinding
}>

export type FlowSpawnIndexFrame = Readonly<{
    candidateCount: number
    generation: number
    currentSnapshotEpoch: number
    nextSnapshotEpoch: number
    dispatchWorkgroups: number
}>

export type FlowSpawnIndexFacts = Readonly<{
    maximumCandidateCount: number
    capacity: number
    candidateByteLength: 32
    candidateCount: number
    dispatchWorkgroups: number
    generation: number
    currentSnapshotEpoch: number
    nextSnapshotEpoch: number
    cpuReadback: false
    gpuCountAuthoritative: true
    disposed: boolean
}>

export type FlowSpawnIndexResources = Readonly<{
    candidates: BufferRegion
    counter: BufferRegion
    output: BufferRegion
    overflow: BufferRegion
}>

export type FlowSpawnIndex = Readonly<{
    capacity: number
    resources: FlowSpawnIndexResources
    encode(
        builder: SubmissionBuilder,
        candidateBytes: ArrayBufferView,
        candidateCount: number,
        snapshot: FlowSpawnSnapshotParameters
    ): FlowSpawnIndexFrame
    facts(): FlowSpawnIndexFacts
    dispose(): void
}>

type SpawnUniformValues = {
    candidateCount: number
    capacity: number
    generation: number
    reservedU32: number
    progress: number
    activitySpawn: number
    activityKill: number
    reservedF32: number
}

type OwnedSpawnGraph = Readonly<{
    buffers: readonly BufferResource[]
    uploads: readonly UploadCommand[]
    clears: readonly ClearBufferCommand[]
    bindLayout: BindLayout
    bindSet: BindSet
    shaderModule: ShaderModule
    program: Program
    pipeline: ComputePipeline
    pass: ComputePassSpec
    dispatch: DispatchCommand
}>

/** Creates one fixed-capacity GPU support-cell compaction graph. */
export async function createFlowSpawnIndex(
    options: FlowSpawnIndexOptions
): Promise<FlowSpawnIndex> {
    const runtime = options?.runtime
    if (!(runtime instanceof GPURuntime)) {
        throw new TypeError('Flow spawn index requires a GPURuntime')
    }
    const maximumCandidateCount = positiveInteger(
        options.maximumCandidateCount,
        'maximumCandidateCount'
    )
    const capacity = positiveInteger(options.capacity, 'capacity')
    if (capacity > maximumCandidateCount) {
        throw new RangeError('Flow spawn capacity cannot exceed its candidate capacity')
    }
    const temporal: FlowSpawnTemporalBinding = options.temporal
    validateTemporalBinding(runtime, temporal)
    const localShader = await fetchTextAsset(
        new URL('./shaders/spawn-index.compute.wgsl', import.meta.url)
    )
    const candidateStaging = new Uint8Array(
        maximumCandidateCount * FLOW_SPAWN_CANDIDATE_BYTE_LENGTH
    )
    const uniformCodec = spawnUniformCodec()
    const uniformBytes = uniformCodec.pack(spawnUniformValues(0, capacity, {
        generation: 1,
        currentSnapshotEpoch: 1,
        nextSnapshotEpoch: 1,
        progress: 0,
        activitySpawn: 1,
        activityKill: 0,
    }))
    const candidates = await runtime.createBuffer({
        label: 'Flow Field spawn candidates',
        size: maximumCandidateCount * FLOW_SPAWN_CANDIDATE_BYTE_LENGTH,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE,
    })
    const counter = await runtime.createBuffer({
        label: 'Flow Field spawn counter',
        size: U32_BYTE_LENGTH,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE,
    })
    const output = await runtime.createBuffer({
        label: 'Flow Field spawn output',
        size: capacity * FLOW_SPAWN_CANDIDATE_BYTE_LENGTH,
        usage: GPUBufferUsage.STORAGE,
    })
    const overflow = await runtime.createBuffer({
        label: 'Flow Field spawn overflow',
        size: U32_BYTE_LENGTH,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE,
    })
    const uniform = await runtime.createBuffer({
        label: 'Flow Field spawn uniform',
        size: uniformBytes.byteLength,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.UNIFORM,
    })
    const resources: FlowSpawnIndexResources = Object.freeze({
        candidates: candidates.region(),
        counter: counter.region(),
        output: output.region(),
        overflow: overflow.region(),
    })
    const uniformRegion = uniform.region({ layout: uniformCodec.artifact })
    const candidateUpload = runtime.createUploadCommand({
        label: 'Upload Flow Field spawn candidates',
        target: resources.candidates,
        data: candidateStaging,
    })
    const uniformUpload = runtime.createUploadCommand({
        label: 'Upload Flow Field spawn uniform',
        target: uniformRegion,
        data: uniformBytes,
    })
    const clearCounter = runtime.createClearBufferCommand({
        label: 'Clear Flow Field spawn counter',
        target: resources.counter,
    })
    const clearOverflow = runtime.createClearBufferCommand({
        label: 'Clear Flow Field spawn overflow',
        target: resources.overflow,
    })
    const spawnLayout = await runtime.createBindLayout({
        label: 'Flow Field spawn index layout',
        group: 0,
        entries: [
            {
                binding: 0,
                name: 'spawnUniform',
                type: 'uniform',
                visibility: [ 'compute' ],
                minBindingSize: uniformCodec.byteLength(),
            },
            {
                binding: 1,
                name: 'candidates',
                type: 'read-storage',
                visibility: [ 'compute' ],
                minBindingSize: FLOW_SPAWN_CANDIDATE_BYTE_LENGTH,
            },
            {
                binding: 2,
                name: 'counter',
                type: 'storage',
                visibility: [ 'compute' ],
                minBindingSize: U32_BYTE_LENGTH,
            },
            {
                binding: 3,
                name: 'output',
                type: 'storage',
                visibility: [ 'compute' ],
                minBindingSize: FLOW_SPAWN_CANDIDATE_BYTE_LENGTH,
            },
            {
                binding: 4,
                name: 'overflow',
                type: 'storage',
                visibility: [ 'compute' ],
                minBindingSize: U32_BYTE_LENGTH,
            },
        ],
    })
    const spawnSet = await runtime.createBindSet(spawnLayout, {
        spawnUniform: uniformRegion,
        candidates: resources.candidates,
        counter: resources.counter,
        output: resources.output,
        overflow: resources.overflow,
    }, { label: 'Flow Field spawn index resources' })
    const shaderModule = await runtime.createShaderModule({
        label: 'Flow Field spawn index shader',
        sourceParts: [
            { code: temporal.module.code },
            { code: localShader },
        ],
    })
    const requirement: ProgramBufferLayoutRequirement = {
        group: 0,
        binding: 0,
        type: 'uniform',
        hasDynamicOffset: false,
        layout: uniformCodec.artifact,
    }
    const program = runtime.createProgram({
        label: 'Flow Field spawn index program',
        compute: { module: shaderModule, entryPoint: 'compactSpawnIndex' },
        layoutRequirements: [ requirement ],
    })
    const pipeline = await runtime.createComputePipeline({
        label: 'Flow Field spawn index pipeline',
        program,
        layout: { mode: 'explicit', bindLayouts: [ spawnLayout, temporal.bindLayout ] },
    })
    const pass = runtime.createComputePass({ label: 'Flow Field spawn index pass' })
    const dispatchWorkgroups = Math.ceil(maximumCandidateCount / FLOW_SPAWN_WORKGROUP_SIZE)
    const dispatch = runtime.createDispatchCommand({
        label: 'Compact Flow Field spawn index',
        pipeline,
        bindSets: [ { set: spawnSet }, { set: temporal.bindSet } ],
        count: { workgroups: [ dispatchWorkgroups ] },
        resources: {
            read: [
                { resource: candidates, contentEpoch: 'current-at-step' },
                { resource: uniform, contentEpoch: 'current-at-step' },
                ...currentReads(temporal.resources),
            ],
            write: [ counter, output, overflow ],
        },
        whenMissing: 'throw',
    })
    const graph: OwnedSpawnGraph = Object.freeze({
        buffers: Object.freeze([ candidates, counter, output, overflow, uniform ]),
        uploads: Object.freeze([ candidateUpload, uniformUpload ]),
        clears: Object.freeze([ clearCounter, clearOverflow ]),
        bindLayout: spawnLayout,
        bindSet: spawnSet,
        shaderModule,
        program,
        pipeline,
        pass,
        dispatch,
    })
    let candidateCount = 0
    let generation = 0
    let currentSnapshotEpoch = 0
    let nextSnapshotEpoch = 0
    let disposed = false

    function encode(
        builder: SubmissionBuilder,
        packedCandidates: ArrayBufferView,
        nextCandidateCount: number,
        snapshot: FlowSpawnSnapshotParameters
    ): FlowSpawnIndexFrame {
        assertActive()
        if (builder?.runtime !== runtime) {
            throw new TypeError('Flow spawn index requires a same-runtime SubmissionBuilder')
        }
        if (!ArrayBuffer.isView(packedCandidates) ||
            !Number.isSafeInteger(nextCandidateCount) || nextCandidateCount < 0 ||
            nextCandidateCount > maximumCandidateCount ||
            packedCandidates.byteLength !==
                nextCandidateCount * FLOW_SPAWN_CANDIDATE_BYTE_LENGTH) {
            throw new RangeError('Flow spawn candidate bytes must match a bounded record count')
        }
        validateSnapshot(snapshot)
        candidateStaging.fill(0)
        candidateStaging.set(new Uint8Array(
            packedCandidates.buffer,
            packedCandidates.byteOffset,
            packedCandidates.byteLength
        ))
        uniformCodec.write(
            uniformBytes,
            spawnUniformValues(nextCandidateCount, capacity, snapshot)
        )
        builder.upload(candidateUpload)
        builder.upload(uniformUpload)
        builder.clear(clearCounter)
        builder.clear(clearOverflow)
        builder.compute(pass, [ dispatch ])
        candidateCount = nextCandidateCount
        generation = snapshot.generation
        currentSnapshotEpoch = snapshot.currentSnapshotEpoch
        nextSnapshotEpoch = snapshot.nextSnapshotEpoch
        return Object.freeze({
            candidateCount,
            generation,
            currentSnapshotEpoch,
            nextSnapshotEpoch,
            dispatchWorkgroups,
        })
    }

    function facts(): FlowSpawnIndexFacts {
        return Object.freeze({
            maximumCandidateCount,
            capacity,
            candidateByteLength: FLOW_SPAWN_CANDIDATE_BYTE_LENGTH,
            candidateCount,
            dispatchWorkgroups,
            generation,
            currentSnapshotEpoch,
            nextSnapshotEpoch,
            cpuReadback: false,
            gpuCountAuthoritative: true,
            disposed,
        })
    }

    function dispose(): void {
        if (disposed) return
        disposed = true
        graph.dispatch.dispose()
        graph.pass.dispose()
        graph.pipeline.dispose()
        graph.program.dispose()
        graph.shaderModule.dispose()
        graph.bindSet.dispose()
        graph.bindLayout.dispose()
        for (const clear of graph.clears) clear.dispose()
        for (const upload of graph.uploads) upload.dispose()
        for (const buffer of graph.buffers) buffer.dispose()
    }

    function assertActive(): void {
        if (disposed) throw new Error('Flow spawn index is disposed')
    }

    return Object.freeze({ capacity, resources, encode, facts, dispose })
}

function spawnUniformCodec(): LayoutCodec {
    const fields: LayoutFixedFieldDescriptor[] = [
        { name: 'candidateCount', type: 'u32' },
        { name: 'capacity', type: 'u32' },
        { name: 'generation', type: 'u32' },
        { name: 'reservedU32', type: 'u32' },
        { name: 'progress', type: 'f32' },
        { name: 'activitySpawn', type: 'f32' },
        { name: 'activityKill', type: 'f32' },
        { name: 'reservedF32', type: 'f32' },
    ]
    return layoutCodec({ name: 'FlowSpawnUniform', fields }, { usage: [ 'uniform' ] })
}

function spawnUniformValues(
    candidateCount: number,
    capacity: number,
    snapshot: FlowSpawnSnapshotParameters
): SpawnUniformValues {
    return {
        candidateCount,
        capacity,
        generation: snapshot.generation,
        reservedU32: 0,
        progress: snapshot.progress,
        activitySpawn: snapshot.activitySpawn,
        activityKill: snapshot.activityKill,
        reservedF32: 0,
    }
}

function validateTemporalBinding(runtime: GPURuntime, temporal: FlowSpawnTemporalBinding): void {
    if (temporal?.module?.kind !== 'temporal-velocity-wgsl-module' ||
        typeof temporal.module.code !== 'string' ||
        !temporal.module.code.includes('fn FlowVelocity_sample(') ||
        temporal.module.bindings.group !== 1 ||
        temporal.bindLayout?.runtime !== runtime || temporal.bindLayout.group !== 1 ||
        temporal.bindSet?.runtime !== runtime || temporal.bindSet.layout !== temporal.bindLayout ||
        !Array.isArray(temporal.resources) || temporal.resources.length !== 4 ||
        temporal.resources.some(resource => resource?.runtime !== runtime)) {
        throw new TypeError(
            'Flow spawn index requires one group-1 temporal sampler and four declared resources'
        )
    }
}

function validateSnapshot(snapshot: FlowSpawnSnapshotParameters): void {
    if (!Number.isSafeInteger(snapshot?.generation) || snapshot.generation <= 0 ||
        snapshot.generation > U32_MAX ||
        !Number.isSafeInteger(snapshot.currentSnapshotEpoch) ||
        snapshot.currentSnapshotEpoch <= 0 ||
        !Number.isSafeInteger(snapshot.nextSnapshotEpoch) || snapshot.nextSnapshotEpoch <= 0 ||
        !Number.isFinite(snapshot.progress) || snapshot.progress < 0 || snapshot.progress > 1 ||
        !Number.isFinite(snapshot.activitySpawn) ||
        !Number.isFinite(snapshot.activityKill) || snapshot.activityKill < 0 ||
        snapshot.activitySpawn <= snapshot.activityKill) {
        throw new TypeError('Flow spawn snapshot parameters are invalid or stale')
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
        throw new Error(`Flow spawn shader request failed with HTTP ${response.status}`)
    }
    return response.text()
}

function positiveInteger(value: number, label: string): number {
    if (!Number.isSafeInteger(value) || value <= 0 || value > U32_MAX) {
        throw new RangeError(`Flow spawn ${label} must be a positive u32 integer`)
    }
    return value
}
