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
    SubmittedWork,
    SubmissionBuilder,
    TextureResource,
    UploadCommand,
} from 'geoscratch/scratch'
import type { TemporalVelocityWgslModule } from './temporal-velocity-raster.ts'
import type { FlowTemporalReadyBindingFrame } from './flow-temporal-bindings.ts'


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

export type FlowSpawnTemporalFrame = FlowTemporalReadyBindingFrame

export type FlowSpawnTemporalBinding = Readonly<{
    module: TemporalVelocityWgslModule
    layout: BindLayout
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
    subcellSide?: 1 | 2 | 4
    temporal: FlowSpawnTemporalBinding
}>

export type FlowSpawnIndexFrame = Readonly<{
    candidateCount: number
    generation: number
    currentSnapshotEpoch: number
    nextSnapshotEpoch: number
    dispatchWorkgroups: number
    buildRevision: number
    built: boolean
    reused: boolean
}>

/** An opaque identity for one privately owned, immutable copy of packed candidates. */
export type FlowSpawnCandidates = Readonly<{
    kind: 'flow-spawn-candidates'
    byteLength: number
}>

const preparedCandidateBytes = new WeakMap<FlowSpawnCandidates, Uint8Array>()

/** Copies candidates once; callers cannot mutate the retained bytes through this artifact. */
export function prepareFlowSpawnCandidates(input: ArrayBufferView): FlowSpawnCandidates {
    if (!ArrayBuffer.isView(input) || input.byteLength % FLOW_SPAWN_CANDIDATE_BYTE_LENGTH !== 0) {
        throw new RangeError('Flow spawn candidates require complete packed records')
    }
    const bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength).slice()
    const prepared = Object.freeze({ kind: 'flow-spawn-candidates' as const, byteLength: bytes.byteLength })
    preparedCandidateBytes.set(prepared, bytes)
    return prepared
}

export type FlowSpawnIndexFacts = Readonly<{
    maximumCandidateCount: number
    capacity: number
    candidateByteLength: 32
    candidateCount: number
    dispatchWorkgroups: number
    subcellSide: 1 | 2 | 4
    buildCount: number
    cacheHitCount: number
    /** Full candidate-content comparisons; stable prepared identities need none. */
    candidateComparisonCount: number
    cacheState: 'empty' | 'encoded' | 'observing' | 'ready' | 'failed'
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
        candidateBytes: ArrayBufferView | FlowSpawnCandidates,
        candidateCount: number,
        snapshot: FlowSpawnSnapshotParameters,
        temporal: FlowSpawnTemporalFrame
    ): FlowSpawnIndexFrame
    /** Commits a built support index only after its owning native submission succeeds. */
    observe(frame: FlowSpawnIndexFrame, submitted: SubmittedWork): Promise<void>
    facts(): FlowSpawnIndexFacts
    dispose(): void
}>

type SpawnUniformValues = {
    candidateCount: number
    capacity: number
    generation: number
    subcellSide: number
    progress: number
    activitySpawn: number
    activityKill: number
    reservedF32: number
}

type SpawnBuildRecord = {
    key: string
    bindSet: BindSet
    commandId: string | undefined
    candidates: FlowSpawnCandidates | undefined
    submittedId?: string
    observing?: Promise<void>
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
    const subcellSide = options.subcellSide ?? 4
    if (subcellSide !== 1 && subcellSide !== 2 && subcellSide !== 4) {
        throw new RangeError('Flow spawn subcellSide must be 1, 2, or 4')
    }
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
    const uniformBytes = uniformCodec.pack(spawnUniformValues(0, capacity, subcellSide, {
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
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE,
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
    const clearOutput = runtime.createClearBufferCommand({
        label: 'Initialize Flow Field spawn output',
        target: resources.output,
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
        layout: { mode: 'explicit', bindLayouts: [ spawnLayout, temporal.layout ] },
    })
    const pass = runtime.createComputePass({ label: 'Flow Field spawn index pass' })
    const dispatchWorkgroups = Math.ceil(maximumCandidateCount / FLOW_SPAWN_WORKGROUP_SIZE)
    const graph: OwnedSpawnGraph = Object.freeze({
        buffers: Object.freeze([ candidates, counter, output, overflow, uniform ]),
        uploads: Object.freeze([ candidateUpload, uniformUpload ]),
        clears: Object.freeze([ clearCounter, clearOverflow, clearOutput ]),
        bindLayout: spawnLayout,
        bindSet: spawnSet,
        shaderModule,
        program,
        pipeline,
        pass,
    })
    let lastDispatch: DispatchCommand | undefined
    let lastTemporalSet: BindSet | undefined
    let candidateCount = 0
    let generation = 0
    let currentSnapshotEpoch = 0
    let nextSnapshotEpoch = 0
    let buildCount = 0
    let cacheHitCount = 0
    let candidateComparisonCount = 0
    let cacheState: FlowSpawnIndexFacts['cacheState'] = 'empty'
    let committedKey: string | undefined
    let committedCandidates: FlowSpawnCandidates | undefined
    let committedResources: readonly Readonly<{
        resource: BufferResource
        contentEpoch: number
        allocationVersion: number
    }>[] = []
    let latestBuild: SpawnBuildRecord | undefined
    const frameRecords = new WeakMap<FlowSpawnIndexFrame, SpawnBuildRecord>()
    let disposed = false

    function encode(
        builder: SubmissionBuilder,
        packedCandidates: ArrayBufferView | FlowSpawnCandidates,
        nextCandidateCount: number,
        snapshot: FlowSpawnSnapshotParameters,
        temporalFrame: FlowSpawnTemporalFrame
    ): FlowSpawnIndexFrame {
        assertActive()
        if (builder?.runtime !== runtime) {
            throw new TypeError('Flow spawn index requires a same-runtime SubmissionBuilder')
        }
        const prepared = ArrayBuffer.isView(packedCandidates) ? undefined : packedCandidates
        const bytes = prepared === undefined && ArrayBuffer.isView(packedCandidates)
            ? new Uint8Array(packedCandidates.buffer, packedCandidates.byteOffset, packedCandidates.byteLength)
            : preparedCandidateBytes.get(prepared!)
        if (bytes === undefined ||
            !Number.isSafeInteger(nextCandidateCount) || nextCandidateCount < 0 ||
            nextCandidateCount > maximumCandidateCount ||
            bytes.byteLength !==
                nextCandidateCount * FLOW_SPAWN_CANDIDATE_BYTE_LENGTH) {
            throw new RangeError('Flow spawn candidate bytes must match a bounded record count')
        }
        if (nextCandidateCount > capacity) {
            throw new RangeError('Flow spawn capacity must cover every input group without truncation')
        }
        validateSnapshot(snapshot)
        validateTemporalFrame(runtime, temporal.layout, temporalFrame)
        if (temporalFrame.pairGeneration !== snapshot.generation ||
            temporalFrame.progress !== snapshot.progress) {
            throw new Error('Flow spawn index temporal frame progress is stale')
        }
        if (cacheState === 'observing') {
            throw new Error('Flow spawn index requires its previous observation to settle')
        }
        // Raw views remain mutable. Only a privately owned preparation artifact
        // permits identity reuse; alpha alone does not change endpoint support.
        const key = [snapshot.generation, snapshot.currentSnapshotEpoch,
            snapshot.nextSnapshotEpoch, nextCandidateCount, subcellSide].join(':')
        const reused = cacheState === 'ready' && committedKey === key &&
            lastTemporalSet === temporalFrame.bindSet && candidateCount === nextCandidateCount &&
            candidatesMatch() && committedResources.every(value =>
                value.resource.contentEpoch === value.contentEpoch &&
                value.resource.allocationVersion === value.allocationVersion)
        candidateCount = nextCandidateCount
        generation = snapshot.generation
        currentSnapshotEpoch = snapshot.currentSnapshotEpoch
        nextSnapshotEpoch = snapshot.nextSnapshotEpoch
        if (reused) {
            cacheHitCount++
            committedCandidates = prepared
            return ticket(undefined, key, temporalFrame.bindSet, prepared)
        }
        committedKey = undefined
        committedCandidates = undefined
        committedResources = []
        cacheState = 'encoded'
        lastDispatch?.dispose()
        lastTemporalSet = temporalFrame.bindSet
        lastDispatch = runtime.createDispatchCommand({
            label: 'Compact Flow Field spawn index',
            pipeline,
            bindSets: [ { set: spawnSet }, { set: temporalFrame.bindSet } ],
            count: { workgroups: [ dispatchWorkgroups ] },
            resources: {
                read: [
                    { resource: candidates, contentEpoch: 'current-at-step' },
                    { resource: uniform, contentEpoch: 'current-at-step' },
                    { resource: counter, contentEpoch: 'current-at-step' },
                    { resource: output, contentEpoch: 'current-at-step' },
                    { resource: overflow, contentEpoch: 'current-at-step' },
                    ...currentReads(temporalFrame.resources),
                ],
                write: [ counter, output, overflow ],
            },
            whenMissing: 'throw',
        })
        candidateStaging.fill(0)
        candidateStaging.set(bytes)
        uniformCodec.write(
            uniformBytes,
            spawnUniformValues(nextCandidateCount, capacity, subcellSide, snapshot)
        )
        builder.upload(candidateUpload)
        builder.upload(uniformUpload)
        // Reinitialize on every actual build so abandoned or failed submissions
        // cannot leave a CPU-only "initialized" flag ahead of GPU ownership.
        builder.clear(clearOutput)
        builder.clear(clearCounter)
        builder.clear(clearOverflow)
        builder.compute(pass, [ lastDispatch ])
        buildCount++
        return ticket(lastDispatch.id, key, temporalFrame.bindSet, prepared)

        function candidatesMatch(): boolean {
            if (prepared !== undefined && prepared === committedCandidates) return true
            candidateComparisonCount++
            return equalCandidateBytes(candidateStaging, bytes!)
        }
    }

    function ticket(commandId: string | undefined, key: string, bindSet: BindSet,
        candidates: FlowSpawnCandidates | undefined): FlowSpawnIndexFrame {
        const frame = Object.freeze({
            candidateCount,
            generation,
            currentSnapshotEpoch,
            nextSnapshotEpoch,
            dispatchWorkgroups: commandId === undefined ? 0 : dispatchWorkgroups,
            buildRevision: buildCount,
            built: commandId !== undefined,
            reused: commandId === undefined,
        })
        const record = { key, bindSet, commandId, candidates }
        frameRecords.set(frame, record)
        if (commandId !== undefined) latestBuild = record
        return frame
    }

    function observe(frame: FlowSpawnIndexFrame, submitted: SubmittedWork): Promise<void> {
        assertActive()
        const record = frameRecords.get(frame)
        if (record === undefined || submitted?.runtime !== runtime ||
            typeof submitted.id !== 'string') {
            throw new TypeError('Flow spawn observation requires its owned frame and same-runtime submission')
        }
        if (record.observing !== undefined) {
            if (record.submittedId !== submitted.id) {
                throw new Error('Flow spawn frame was observed with another submission')
            }
            return record.observing
        }
        record.submittedId = submitted.id
        if (frame.built && latestBuild === record) cacheState = 'observing'
        record.observing = (async() => {
            if (frame.built && !submitted.executionOutcomes.some(value =>
                value.outcomeKind === 'command' && value.status === 'executed' &&
                value.executedCommandId === record.commandId)) {
                throw new Error('Flow spawn observation submission did not execute its build command')
            }
            const [outcome] = await Promise.all([submitted.nativeOutcome, submitted.done])
            if (outcome.status !== 'observed-succeeded' &&
                !(frame.reused && outcome.status === 'no-native-work')) {
                throw new Error(`Flow spawn native build was ${outcome.status}`)
            }
            if (!frame.built || latestBuild !== record || disposed) return
            const produced = [counter, output, overflow].map(resource => {
                // One submission records both initialization clears and the later
                // dispatch write. Adopt the build's final epoch, not the first write.
                const epoch = submitted.producerEpochs.find(value => value.resourceId === resource.id &&
                    value.producedBy.commandId === record.commandId &&
                    value.contentEpoch === resource.contentEpoch)
                if (epoch === undefined || epoch.producedBy.commandId !== record.commandId ||
                    resource.contentEpoch !== epoch.contentEpoch ||
                    resource.allocationVersion !== epoch.allocationVersion) {
                    throw new Error('Flow spawn observation lost its output publication ownership')
                }
                return { resource, contentEpoch: epoch.contentEpoch,
                    allocationVersion: epoch.allocationVersion }
            })
            committedKey = record.key
            committedCandidates = record.candidates
            committedResources = produced
            cacheState = 'ready'
        })().catch(error => {
            if (latestBuild === record) {
                committedKey = undefined
                committedCandidates = undefined
                committedResources = []
                cacheState = 'failed'
            }
            throw error
        })
        return record.observing
    }

    function facts(): FlowSpawnIndexFacts {
        return Object.freeze({
            maximumCandidateCount,
            capacity,
            candidateByteLength: FLOW_SPAWN_CANDIDATE_BYTE_LENGTH,
            candidateCount,
            dispatchWorkgroups,
            subcellSide,
            buildCount,
            cacheHitCount,
            candidateComparisonCount,
            cacheState,
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
        committedCandidates = undefined
        latestBuild = undefined
        lastDispatch?.dispose()
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

    return Object.freeze({ capacity, resources, encode, observe, facts, dispose })
}

function spawnUniformCodec(): LayoutCodec {
    const fields: LayoutFixedFieldDescriptor[] = [
        { name: 'candidateCount', type: 'u32' },
        { name: 'capacity', type: 'u32' },
        { name: 'generation', type: 'u32' },
        { name: 'subcellSide', type: 'u32' },
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
    subcellSide: number,
    snapshot: FlowSpawnSnapshotParameters
): SpawnUniformValues {
    return {
        candidateCount,
        capacity,
        generation: snapshot.generation,
        subcellSide,
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
        temporal.layout?.runtime !== runtime || temporal.layout.group !== 1) {
        throw new TypeError(
            'Flow spawn index requires one stable group-1 temporal sampler provider'
        )
    }
}

function validateTemporalFrame(
    runtime: GPURuntime,
    layout: BindLayout,
    frame: FlowSpawnTemporalFrame
): void {
    if (frame?.state !== 'ready' || frame.bindSet?.runtime !== runtime ||
        frame.bindSet.layout !== layout ||
        !Array.isArray(frame.resources) || frame.resources.length !== 4 ||
        frame.resources.some(resource => resource?.runtime !== runtime) ||
        !Number.isSafeInteger(frame.requestedRevision) || frame.requestedRevision <= 0 ||
        !Number.isSafeInteger(frame.pairGeneration) || frame.pairGeneration <= 0 ||
        !Number.isSafeInteger(frame.requestedLevel) || frame.requestedLevel < 0 ||
        !Number.isFinite(frame.progress) || frame.progress < 0 || frame.progress > 1) {
        throw new TypeError('Flow spawn index temporal frame bindings are invalid')
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

function equalCandidateBytes(owned: Uint8Array, input: Uint8Array): boolean {
    if (input.byteOffset % 4 === 0 && input.byteLength % 4 === 0) {
        const left = new Uint32Array(owned.buffer, owned.byteOffset, input.byteLength / 4)
        const right = new Uint32Array(input.buffer, input.byteOffset, input.byteLength / 4)
        for (let index = 0; index < right.length; index++) {
            if (left[index] !== right[index]) return false
        }
    } else {
        for (let index = 0; index < input.byteLength; index++) {
            if (owned[index] !== input[index]) return false
        }
    }
    return true
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
