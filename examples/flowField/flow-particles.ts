import type {
    BindLayout,
    BindSet,
    BufferRegion,
    BufferResource,
    ClearBufferCommand,
    ComputePassSpec,
    DispatchCommand,
    GPURuntime,
    Program,
    ShaderModule,
    ComputePipeline,
    SubmissionBuilder,
    TextureResource,
    UploadCommand,
} from 'geoscratch/scratch'
import type { FlowTemporalReadyBindingFrame } from './flow-temporal-bindings.ts'
import type { GeoViewSnapshot, WebMercatorQuadAddressCodec } from 'geoscratch/geo'
import { flowRenderViewValues } from './flow-render-view.ts'
import { flowScreenProjectionWgsl } from './flow-screen-projection.ts'

export const FLOW_PARTICLE_RECORD_BYTES = 56
export const FLOW_PARTICLE_MAXIMUM_COUNT = 262_144
export const FLOW_PARTICLE_LEGACY_DISPLACEMENT_SCALE = 50

type FlowParticleGpuResource = BufferResource | TextureResource

export type FlowParticleTemporalFrame = FlowTemporalReadyBindingFrame

export type FlowParticleTemporalBindings = Readonly<{
    wgsl: string
    layout: BindLayout
}>

export type FlowParticleSpawnModule = Readonly<{
    wgsl: string
    layout: BindLayout
    capacity: number
}>

export type FlowParticleSpawnBindings = Readonly<{
    bindSet: BindSet
    resources: readonly FlowParticleGpuResource[]
    refill: Readonly<{
        resources: readonly [BufferResource, BufferResource]
        clear: ClearBufferCommand
        initializeIndices: ClearBufferCommand
    }>
}>

export type FlowParticleSpawnIndexResources = Readonly<{
    capacity: number
    resources: Readonly<{
        counter: BufferRegion
        output: BufferRegion
    }>
    facts(): Readonly<{
        disposed: boolean
        cpuReadback: false
    }>
}>

export type PreparedFlowParticleSpawnBindings = Readonly<{
    module: FlowParticleSpawnModule
    bindings: FlowParticleSpawnBindings
    dispose(): void
}>

export type FlowParticleFacts = Readonly<{
    kind: 'flow-particles'
    disposed: boolean
    maximumCount: number
    recordBytes: 56
    particleBytes: number
    encodedSteps: number
    initialized: boolean
    active: null
    dormant: null
    retired: null
    countersObservation: 'gpu-only-unobserved'
    cpuMirrorBytes: 0
    readbackCount: 0
    lastSpawnCount: null
    lastSpawnDormant: null
    legacyDisplacementScale: 50
    resetPending: boolean
    resetCount: number
    /** Encoded reveal-index passes, not a CPU-observed count of replaced GPU particles. */
    viewRefillCount: number
}>

export type FlowParticles = Readonly<{
    maximumCount: number
    resources: Readonly<{
        particles: BufferResource
        counters: BufferResource
        config: BufferResource
    }>
    commands: Readonly<{
        initializeParticles: ClearBufferCommand
        clearCounters: ClearBufferCommand
        readonly simulation?: DispatchCommand
    }>
    encode(
        builder: SubmissionBuilder,
        spawn: FlowParticleSpawnBindings,
        temporal: FlowParticleTemporalFrame,
        view?: GeoViewSnapshot
    ): void
    /** Defers canonical state clearing to the next encoded simulation tick. */
    reset(): void
    /** Seeds newly visible support on the next tick, bounded to one quarter of slots. */
    refillView(previousView: GeoViewSnapshot): void
    facts(): FlowParticleFacts
    dispose(): void
}>

export type FlowParticlesOptions = Readonly<{
    runtime: GPURuntime
    maximumCount?: number
    maximumSpeed?: number
    addressCodec: WebMercatorQuadAddressCodec
    simulationShader: string
    temporal: FlowParticleTemporalBindings
    spawn: FlowParticleSpawnModule
    activitySpawn: number
    activityKill: number
    timeStep: number
    substeps: number
    maximumAgeSteps: number
    maximumStagnantSteps: number
    minimumDisplacementMeters: number
}>

const BUFFER_COPY_DST = 0x08
const BUFFER_UNIFORM = 0x40
const BUFFER_STORAGE = 0x80
const CONFIG_BYTES = 272
const COUNTER_BYTES = 16
const WORKGROUP_SIZE = 256

/** Adapts GPU-authoritative spawn counter/output resources into particle bindings. */
export async function prepareFlowParticleSpawnBindings(
    runtime: GPURuntime,
    index: FlowParticleSpawnIndexResources
): Promise<PreparedFlowParticleSpawnBindings> {

    const facts = index?.facts?.()
    if (!positiveInteger(index?.capacity) || facts?.disposed !== false ||
        facts.cpuReadback !== false || index.resources?.counter?.buffer === undefined ||
        index.resources?.output?.buffer === undefined) {
        throw new TypeError('Flow particle spawn bindings require one live GPU spawn index')
    }
    const owned: { dispose(): void }[] = []
    const own = <T extends { dispose(): void }>(value: T): T => {
        owned.push(value)
        return value
    }
    try {
        const refillCount = own(await runtime.createBuffer({
            label: 'Flow Field revealed spawn counters',
            size: 8,
            usage: BUFFER_STORAGE | BUFFER_COPY_DST,
        }))
        const refillIndices = own(await runtime.createBuffer({
            label: 'Flow Field revealed spawn indices',
            size: index.capacity * 4,
            usage: BUFFER_STORAGE | BUFFER_COPY_DST,
        }))
        const layout = own(await runtime.createBindLayout({
            label: 'Flow Field particle spawn selection layout',
            group: 2,
            entries: [
                {
                    binding: 0,
                    name: 'flowParticleSpawnCount',
                    type: 'read-storage',
                    visibility: [ 'compute' ],
                    minBindingSize: 4,
                },
                {
                    binding: 1,
                    name: 'flowParticleSpawnCandidates',
                    type: 'read-storage',
                    visibility: [ 'compute' ],
                    minBindingSize: 32,
                },
                {
                    binding: 2,
                    name: 'flowParticleSpawnRefillCount',
                    type: 'storage',
                    visibility: [ 'compute' ],
                    minBindingSize: 8,
                },
                {
                    binding: 3,
                    name: 'flowParticleSpawnRefillIndices',
                    type: 'storage',
                    visibility: [ 'compute' ],
                    minBindingSize: 4,
                },
            ],
        }))
        const bindSet = own(await runtime.createBindSet(layout, {
            flowParticleSpawnCount: index.resources.counter,
            flowParticleSpawnCandidates: index.resources.output,
            flowParticleSpawnRefillCount: refillCount.region(),
            flowParticleSpawnRefillIndices: refillIndices.region(),
        }, { label: 'Flow Field particle spawn selection bindings' }))
        const clear = own(runtime.createClearBufferCommand({
            label: 'Clear Flow Field revealed spawn counters',
            target: refillCount.region(),
        }))
        const initializeIndices = own(runtime.createClearBufferCommand({
            label: 'Initialize Flow Field revealed spawn indices',
            target: refillIndices.region(),
        }))
        const refillResources = Object.freeze([refillCount, refillIndices]) as
            readonly [BufferResource, BufferResource]
        let disposed = false
        return Object.freeze({
            module: Object.freeze({
                wgsl: particleSpawnSelectionWgsl(),
                layout,
                capacity: index.capacity,
            }),
            bindings: Object.freeze({
                bindSet,
                resources: Object.freeze([
                    index.resources.counter.buffer,
                    index.resources.output.buffer,
                    ...refillResources,
                ]),
                refill: Object.freeze({ resources: refillResources, clear, initializeIndices }),
            }),
            dispose() {

                if (disposed) return
                disposed = true
                for (const resource of owned.reverse()) resource.dispose()
                owned.length = 0
            },
        })
    } catch (error) {
        for (const resource of owned.reverse()) resource.dispose()
        throw error
    }
}

/** Creates bounded canonical particle resources and a reusable simulation graph. */
export async function createFlowParticles(
    options: FlowParticlesOptions
): Promise<FlowParticles> {

    validateOptions(options)
    const runtime = options.runtime
    const maximumCount = options.maximumCount ?? FLOW_PARTICLE_MAXIMUM_COUNT
    const owned: { dispose(): void }[] = []
    const own = <T extends { dispose(): void }>(value: T): T => {
        owned.push(value)
        return value
    }
    let lastSimulation: DispatchCommand | undefined
    let lastRefillSimulation: DispatchCommand | undefined
    let lastRefillIndex: DispatchCommand | undefined
    let lastTemporalSet: BindSet | undefined
    let lastSpawnSet: BindSet | undefined
    try {
        const particles = own(await runtime.createBuffer({
            label: 'Flow Field canonical particles',
            size: maximumCount * FLOW_PARTICLE_RECORD_BYTES,
            usage: BUFFER_STORAGE | BUFFER_COPY_DST,
        }))
        const counters = own(await runtime.createBuffer({
            label: 'Flow Field particle GPU counters',
            size: COUNTER_BYTES,
            usage: BUFFER_STORAGE | BUFFER_COPY_DST,
        }))
        const config = own(await runtime.createBuffer({
            label: 'Flow Field particle simulation config',
            size: CONFIG_BYTES,
            usage: BUFFER_UNIFORM | BUFFER_COPY_DST,
        }))
        const configBytes = new Uint8Array(CONFIG_BYTES)
        const configUpload = own(runtime.createUploadCommand({
            label: 'Upload Flow Field particle config',
            target: config.region(),
            data: configBytes,
        }))
        const layout = own(await runtime.createBindLayout({
            label: 'Flow Field particle simulation layout',
            group: 0,
            entries: [
                {
                    binding: 0,
                    name: 'flowParticleConfig',
                    type: 'uniform',
                    visibility: [ 'compute' ],
                    minBindingSize: CONFIG_BYTES,
                },
                {
                    binding: 1,
                    name: 'flowParticles',
                    type: 'storage',
                    visibility: [ 'compute' ],
                    minBindingSize: maximumCount * FLOW_PARTICLE_RECORD_BYTES,
                },
                {
                    binding: 2,
                    name: 'flowParticleCounters',
                    type: 'storage',
                    visibility: [ 'compute' ],
                    minBindingSize: COUNTER_BYTES,
                },
            ],
        }))
        const bindSet = own(await runtime.createBindSet(layout, {
            flowParticleConfig: config.region(),
            flowParticles: particles.region(),
            flowParticleCounters: counters.region(),
        }, { label: 'Flow Field particle simulation bindings' }))
        const shader = own(await runtime.createShaderModule({
            label: 'Flow Field particle simulation shader',
            sourceParts: [
                { code: options.temporal.wgsl },
                { code: flowScreenProjectionWgsl(options.addressCodec) },
                { code: options.spawn.wgsl },
                { code: options.simulationShader },
            ],
        }))
        const program = own(runtime.createProgram({
            label: 'Flow Field particle simulation program',
            compute: { module: shader, entryPoint: 'FlowParticles_simulate' },
        }))
        const pipeline = own(await runtime.createComputePipeline({
            label: 'Flow Field particle simulation pipeline',
            program,
            layout: {
                mode: 'explicit',
                bindLayouts: [ layout, options.temporal.layout, options.spawn.layout ],
            },
        }))
        const refillSimulationProgram = own(runtime.createProgram({
            label: 'Flow Field refill simulation program',
            compute: { module: shader, entryPoint: 'FlowParticles_simulate',
                constants: { FLOW_PARTICLES_REFILL_ENABLED: 1 } },
        }))
        const refillSimulationPipeline = own(await runtime.createComputePipeline({
            label: 'Flow Field refill simulation pipeline',
            program: refillSimulationProgram,
            layout: { mode: 'explicit', bindLayouts: [ layout, options.temporal.layout, options.spawn.layout ] },
        }))
        const refillProgram = own(runtime.createProgram({
            label: 'Flow Field revealed spawn index program',
            compute: { module: shader, entryPoint: 'FlowParticles_build_refill_index' },
        }))
        const refillPipeline = own(await runtime.createComputePipeline({
            label: 'Flow Field revealed spawn index pipeline',
            program: refillProgram,
            layout: { mode: 'explicit', bindLayouts: [ layout, options.temporal.layout, options.spawn.layout ] },
        }))
        const pass = own(runtime.createComputePass({
            label: 'Flow Field particle simulation pass',
        }))
        const initializeParticles = own(runtime.createClearBufferCommand({
            label: 'Initialize Flow Field particle state',
            target: particles.region(),
        }))
        const clearCounters = own(runtime.createClearBufferCommand({
            label: 'Clear Flow Field particle counters',
            target: counters.region(),
        }))

        let disposed = false
        let initialized = false
        let encodedSteps = 0
        let resetPending = false
        let resetCount = 0
        let viewRefillPending: GeoViewSnapshot | undefined
        let viewRefillCount = 0

        function encode(
            builder: SubmissionBuilder,
            spawn: FlowParticleSpawnBindings,
            temporal: FlowParticleTemporalFrame,
            view?: GeoViewSnapshot
        ): void {

            assertActive()
            validateFrame(temporal, options.temporal.layout, 'temporal')
            validateSpawn(spawn, options.spawn.layout)
            const refill = initialized && !resetPending ? viewRefillPending : undefined
            writeParticleConfig(
                configBytes,
                options,
                maximumCount,
                temporal,
                encodedSteps + 1,
                view,
                refill
            )
            if (lastSimulation === undefined || lastTemporalSet !== temporal.bindSet ||
                lastSpawnSet !== spawn.bindSet) {
                lastSimulation?.dispose()
                lastRefillSimulation?.dispose()
                lastRefillIndex?.dispose()
                lastTemporalSet = temporal.bindSet
                lastSpawnSet = spawn.bindSet
                const makeSimulation = (selectedPipeline: ComputePipeline, label: string) => runtime.createDispatchCommand({
                    label,
                    pipeline: selectedPipeline,
                    bindSets: [
                        { set: bindSet },
                        { set: temporal.bindSet },
                        { set: spawn.bindSet },
                    ],
                    count: {
                        workgroups: [ Math.ceil(maximumCount / WORKGROUP_SIZE), 1, 1 ],
                    },
                    resources: {
                        read: dedupeResources([
                            config,
                            particles,
                            counters,
                            ...temporal.resources,
                            ...spawn.resources,
                        ]).map(resource => ({
                            resource,
                            contentEpoch: 'current-at-step' as const,
                        })),
                        write: [ particles, counters, ...spawn.refill.resources ],
                    },
                    whenMissing: 'throw',
                })
                lastSimulation = makeSimulation(pipeline, 'Simulate Flow Field canonical particles')
                lastRefillSimulation = makeSimulation(refillSimulationPipeline, 'Simulate Flow Field revealed particles')
                lastRefillIndex = runtime.createDispatchCommand({
                    label: 'Index newly visible Flow Field support',
                    pipeline: refillPipeline,
                    bindSets: [{ set: bindSet }, { set: temporal.bindSet }, { set: spawn.bindSet }],
                    count: { workgroups: [ Math.ceil(options.spawn.capacity / WORKGROUP_SIZE), 1, 1 ] },
                    resources: {
                        read: dedupeResources([config, particles, counters, ...temporal.resources, ...spawn.resources])
                            .map(resource => ({resource, contentEpoch: 'current-at-step' as const})),
                        write: [particles, counters, ...spawn.refill.resources],
                    },
                    whenMissing: 'throw',
                })
            }
            if (!initialized || resetPending) {
                builder.clear(initializeParticles)
                builder.clear(spawn.refill.clear)
                builder.clear(spawn.refill.initializeIndices)
                initialized = true
                resetPending = false
            }
            builder.upload(configUpload)
            builder.clear(clearCounters)
            if (refill !== undefined) {
                builder.clear(spawn.refill.clear)
                builder.compute(pass, [lastRefillIndex!])
            }
            builder.compute(pass, [ refill === undefined ? lastSimulation : lastRefillSimulation! ])
            viewRefillPending = undefined
            if (refill !== undefined) viewRefillCount++
            encodedSteps++
        }

        function reset(): void {

            assertActive()
            resetPending = true
            resetCount++
        }

        function refillView(previousView: GeoViewSnapshot): void {
            assertActive()
            // Validate immutable camera facts; keep the earliest pending view.
            flowRenderViewValues(previousView, options.addressCodec)
            viewRefillPending ??= previousView
        }

        function facts(): FlowParticleFacts {

            return Object.freeze({
                kind: 'flow-particles',
                disposed,
                maximumCount,
                recordBytes: FLOW_PARTICLE_RECORD_BYTES,
                particleBytes: maximumCount * FLOW_PARTICLE_RECORD_BYTES,
                encodedSteps,
                initialized,
                active: null,
                dormant: null,
                retired: null,
                countersObservation: 'gpu-only-unobserved',
                cpuMirrorBytes: 0,
                readbackCount: 0,
                lastSpawnCount: null,
                lastSpawnDormant: null,
                legacyDisplacementScale: FLOW_PARTICLE_LEGACY_DISPLACEMENT_SCALE,
                resetPending,
                resetCount,
                viewRefillCount,
            })
        }

        function dispose(): void {

            if (disposed) return
            disposed = true
            lastSimulation?.dispose()
            lastRefillSimulation?.dispose()
            lastRefillIndex?.dispose()
            for (const value of owned.reverse()) value.dispose()
            owned.length = 0
        }

        function assertActive(): void {

            if (disposed) throw new Error('Flow particles are disposed')
        }

        const commands = Object.freeze({
            initializeParticles,
            clearCounters,
            get simulation() { return lastSimulation },
        })
        return Object.freeze({
            maximumCount,
            resources: Object.freeze({ particles, counters, config }),
            commands,
            encode,
            reset,
            refillView,
            facts,
            dispose,
        })
    } catch (error) {
        lastSimulation?.dispose()
        lastRefillSimulation?.dispose()
        lastRefillIndex?.dispose()
        for (const value of owned.reverse()) value.dispose()
        throw error
    }
}

function writeParticleConfig(
    bytes: Uint8Array,
    options: FlowParticlesOptions,
    maximumCount: number,
    temporal: FlowParticleTemporalFrame,
    frameSeed: number,
    frameView?: GeoViewSnapshot,
    refillView?: GeoViewSnapshot
): void {

    bytes.fill(0)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    view.setUint32(0, maximumCount, true)
    view.setUint32(4, temporal.requestedLevel, true)
    view.setUint32(8, options.substeps, true)
    view.setUint32(12, options.maximumAgeSteps, true)
    view.setUint32(16, options.maximumStagnantSteps, true)
    view.setUint32(20, frameSeed, true)
    view.setFloat32(24, temporal.progress, true)
    view.setFloat32(28, options.activitySpawn, true)
    view.setFloat32(32, options.activityKill, true)
    view.setFloat32(36, options.timeStep, true)
    view.setFloat32(40, options.minimumDisplacementMeters, true)
    view.setFloat32(44, FLOW_PARTICLE_LEGACY_DISPLACEMENT_SCALE, true)
    view.setFloat32(48, options.maximumSpeed ?? 1, true)
    view.setUint32(56, refillView === undefined ? 0 : 1, true)
    if (frameView !== undefined) {
        const camera = flowRenderViewValues(frameView, options.addressCodec)
        view.setUint32(52, 1, true)
        camera.clipFromRelativeWorld.forEach((value, index) => {
            view.setFloat32(64 + index * 4, value, true)
        })
        camera.cameraX.forEach((value, index) => view.setUint32(128 + index * 4, value, true))
        camera.cameraY.forEach((value, index) => view.setUint32(136 + index * 4, value, true))
        camera.cameraZ.forEach((value, index) => view.setFloat32(144 + index * 4, value, true))
        view.setFloat32(152, camera.metersPerQuantum, true)
    }
    if (refillView !== undefined) {
        const previous = flowRenderViewValues(refillView, options.addressCodec)
        previous.clipFromRelativeWorld.forEach((value, index) => view.setFloat32(176 + index * 4, value, true))
        previous.cameraX.forEach((value, index) => view.setUint32(240 + index * 4, value, true))
        previous.cameraY.forEach((value, index) => view.setUint32(248 + index * 4, value, true))
        previous.cameraZ.forEach((value, index) => view.setFloat32(256 + index * 4, value, true))
    }
}

function validateOptions(options: FlowParticlesOptions): void {

    const maximumCount = options?.maximumCount ?? FLOW_PARTICLE_MAXIMUM_COUNT
    if (options?.runtime === undefined || !positiveInteger(maximumCount) ||
        !positiveFinite(Math.fround(options.maximumSpeed ?? 1)) ||
        options.addressCodec === undefined ||
        maximumCount > FLOW_PARTICLE_MAXIMUM_COUNT ||
        typeof options.simulationShader !== 'string' || options.simulationShader.length === 0 ||
        typeof options.temporal?.wgsl !== 'string' || options.temporal.wgsl.length === 0 ||
        options.temporal.layout?.group !== 1 ||
        typeof options.spawn?.wgsl !== 'string' || options.spawn.wgsl.length === 0 ||
        !positiveInteger(options.spawn.capacity) ||
        options.spawn.layout?.group !== 2 || !nonNegativeFinite(options.activityKill) ||
        !positiveFinite(options.activitySpawn) ||
        options.activitySpawn <= options.activityKill || !positiveFinite(options.timeStep) ||
        !positiveInteger(options.substeps) || options.substeps > 16 ||
        !positiveInteger(options.maximumAgeSteps) ||
        !positiveInteger(options.maximumStagnantSteps) ||
        !positiveFinite(options.minimumDisplacementMeters)) {
        throw new TypeError('Flow particles require bounded public GPU and lifecycle contracts')
    }
}

function validateFrame(
    frame: FlowParticleTemporalFrame,
    layout: BindLayout,
    name: string
): void {

    if (frame?.state !== 'ready' || frame.bindSet?.layout !== layout ||
        !Array.isArray(frame.resources) ||
        !Number.isFinite(frame.progress) || frame.progress < 0 || frame.progress > 1 ||
        !Number.isSafeInteger(frame.requestedRevision) || frame.requestedRevision <= 0 ||
        !Number.isSafeInteger(frame.pairGeneration) || frame.pairGeneration <= 0 ||
        !nonNegativeInteger(frame.requestedLevel)) {
        throw new TypeError(`Flow particle ${name} bindings are invalid`)
    }
}

function validateSpawn(
    spawn: FlowParticleSpawnBindings,
    layout: BindLayout
): void {

    if (spawn?.bindSet?.layout !== layout || !Array.isArray(spawn.resources) ||
        !Array.isArray(spawn.refill?.resources) || spawn.refill.resources.length !== 2 ||
        spawn.refill.clear === undefined || spawn.refill.initializeIndices === undefined) {
        throw new TypeError('Flow particle spawn bindings are invalid')
    }
}

function dedupeResources(resources: readonly FlowParticleGpuResource[]): FlowParticleGpuResource[] {

    return [ ...new Set(resources) ]
}

function particleSpawnSelectionWgsl(): string {

    return `struct FlowParticleSpawnCandidate {
    origin: FlowVelocityAddressFixedPosition,
    texel_step_quanta: u32,
    requested_level: u32,
    identity: u32,
    reserved: u32,
}

struct FlowParticleSpawnCandidates {
    values: array<FlowParticleSpawnCandidate>,
}

struct FlowParticleSpawnCount {
    value: u32,
}

struct FlowParticleSpawnRefillCount {
    visible: atomic<u32>,
    revealed: atomic<u32>,
}

struct FlowParticleSpawnRefillIndices {
    values: array<u32>,
}

struct FlowSpawnIndexSelection {
    position: FlowVelocityAddressFixedPosition,
    requested_level: u32,
    available: u32,
}

@group(2) @binding(0) var<storage, read> flowParticleSpawnCount:
    FlowParticleSpawnCount;
@group(2) @binding(1) var<storage, read> flowParticleSpawnCandidates:
    FlowParticleSpawnCandidates;
@group(2) @binding(2) var<storage, read_write> flowParticleSpawnRefillCount:
    FlowParticleSpawnRefillCount;
@group(2) @binding(3) var<storage, read_write> flowParticleSpawnRefillIndices:
    FlowParticleSpawnRefillIndices;

fn FlowSpawnIndex_candidate_count() -> u32 {
    return min(
        flowParticleSpawnCount.value,
        arrayLength(&flowParticleSpawnCandidates.values),
    );
}

fn FlowSpawnIndex_candidate_center(index: u32) -> FlowVelocityAddressAdvance {
    if (index >= FlowSpawnIndex_candidate_count()) {
        var invalid_position: FlowVelocityAddressFixedPosition;
        return FlowVelocityAddressAdvance(invalid_position, 0u);
    }
    let candidate = flowParticleSpawnCandidates.values[index];
    if (candidate.texel_step_quanta == 0u || candidate.texel_step_quanta > 0x7fffffffu) {
        return FlowVelocityAddressAdvance(candidate.origin, 0u);
    }
    let half_step = i32(candidate.texel_step_quanta / 2u);
    return FlowVelocityAddress_advance_i32(candidate.origin, vec2i(half_step));
}

fn FlowSpawnIndex_record_visible(index: u32, revealed: bool) {
    atomicAdd(&flowParticleSpawnRefillCount.visible, 1u);
    if (!revealed) { return; }
    let output_index = atomicAdd(&flowParticleSpawnRefillCount.revealed, 1u);
    if (output_index < arrayLength(&flowParticleSpawnRefillIndices.values)) {
        flowParticleSpawnRefillIndices.values[output_index] = index;
    }
}

fn FlowSpawnIndex_refill_quota(particle_count: u32) -> u32 {
    let visible = atomicLoad(&flowParticleSpawnRefillCount.visible);
    let revealed = min(atomicLoad(&flowParticleSpawnRefillCount.revealed),
        arrayLength(&flowParticleSpawnRefillIndices.values));
    if (visible == 0u || revealed == 0u) { return 0u; }
    return min(particle_count / 4u,
        u32(ceil(f32(particle_count) * f32(revealed) / f32(visible))));
}

fn FlowSpawnIndex_select_candidate(index: u32, random_state: u32) -> FlowSpawnIndexSelection {
    if (index >= FlowSpawnIndex_candidate_count()) {
        var empty_position: FlowVelocityAddressFixedPosition;
        return FlowSpawnIndexSelection(empty_position, 0u, 0u);
    }
    let candidate = flowParticleSpawnCandidates.values[index];
    if (candidate.texel_step_quanta == 0u || candidate.texel_step_quanta > 0x7fffffffu) {
        var invalid_position: FlowVelocityAddressFixedPosition;
        return FlowSpawnIndexSelection(invalid_position, candidate.requested_level, 0u);
    }
    let random_x = FlowParticles_random(random_state ^ candidate.identity);
    let random_y = FlowParticles_random(random_x + 0x9e3779b9u);
    let side_log2 = candidate.reserved >> 16u;
    let side = 1u << min(side_log2, 2u);
    let valid_bits = (1u << (side * side)) - 1u;
    var occupancy = candidate.reserved & valid_bits;
    if (side_log2 > 2u || occupancy == 0u ||
        candidate.texel_step_quanta % side != 0u) {
        return FlowSpawnIndexSelection(candidate.origin, candidate.requested_level, 0u);
    }
    let subcell_step = candidate.texel_step_quanta / side;
    if (subcell_step == 0u) {
        return FlowSpawnIndexSelection(candidate.origin, candidate.requested_level, 0u);
    }
    let choice = FlowParticles_random(random_y) % countOneBits(occupancy);
    for (var rank = 0u; rank < choice; rank++) { occupancy &= occupancy - 1u; }
    let subcell = firstTrailingBit(occupancy);
    let offset = vec2i(
        i32((subcell % side) * subcell_step + random_x % subcell_step),
        i32((subcell / side) * subcell_step + random_y % subcell_step),
    );
    let advanced = FlowVelocityAddress_advance_i32(candidate.origin, offset);
    return FlowSpawnIndexSelection(
        advanced.position,
        candidate.requested_level,
        advanced.north_south_valid,
    );
}

fn FlowSpawnIndex_select(random_state: u32) -> FlowSpawnIndexSelection {
    let count = FlowSpawnIndex_candidate_count();
    if (count == 0u) {
        var empty_position: FlowVelocityAddressFixedPosition;
        return FlowSpawnIndexSelection(empty_position, 0u, 0u);
    }
    return FlowSpawnIndex_select_candidate(random_state % count, random_state);
}

fn FlowSpawnIndex_select_refill(random_state: u32) -> FlowSpawnIndexSelection {
    let count = min(atomicLoad(&flowParticleSpawnRefillCount.revealed),
        arrayLength(&flowParticleSpawnRefillIndices.values));
    if (count == 0u) {
        var empty_position: FlowVelocityAddressFixedPosition;
        return FlowSpawnIndexSelection(empty_position, 0u, 0u);
    }
    return FlowSpawnIndex_select_candidate(
        flowParticleSpawnRefillIndices.values[random_state % count], random_state);
}`
}

function positiveInteger(value: unknown): value is number {

    return Number.isSafeInteger(value) && Number(value) > 0
}

function nonNegativeInteger(value: unknown): value is number {

    return Number.isSafeInteger(value) && Number(value) >= 0
}

function positiveFinite(value: unknown): value is number {

    return Number.isFinite(value) && Number(value) > 0
}

function nonNegativeFinite(value: unknown): value is number {

    return Number.isFinite(value) && Number(value) >= 0
}
