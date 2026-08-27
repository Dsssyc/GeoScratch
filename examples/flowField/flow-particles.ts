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

export const FLOW_PARTICLE_RECORD_BYTES = 56
export const FLOW_PARTICLE_MAXIMUM_COUNT = 262_144
export const FLOW_PARTICLE_LEGACY_DISPLACEMENT_SCALE = 50

type FlowParticleGpuResource = BufferResource | TextureResource

export type FlowParticleTemporalFrame = Readonly<{
    bindSet: BindSet
    resources: readonly FlowParticleGpuResource[]
    progress: number
    requestedLevel: number
}>

export type FlowParticleTemporalBindings = Readonly<{
    wgsl: string
    layout: BindLayout
    frame(): FlowParticleTemporalFrame
}>

export type FlowParticleSpawnModule = Readonly<{
    wgsl: string
    layout: BindLayout
}>

export type FlowParticleSpawnBindings = Readonly<{
    bindSet: BindSet
    resources: readonly FlowParticleGpuResource[]
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
    encode(builder: SubmissionBuilder, spawn: FlowParticleSpawnBindings): void
    facts(): FlowParticleFacts
    dispose(): void
}>

export type FlowParticlesOptions = Readonly<{
    runtime: GPURuntime
    maximumCount?: number
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
const CONFIG_BYTES = 64
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
    const layout = await runtime.createBindLayout({
        label: 'Flow Field particle spawn selection layout',
        group: 2,
        entries: [
            {
                binding: 0,
                name: 'flowParticleSpawnCount',
                type: 'storage',
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
        ],
    })
    let bindSet: BindSet
    try {
        bindSet = await runtime.createBindSet(layout, {
            flowParticleSpawnCount: index.resources.counter,
            flowParticleSpawnCandidates: index.resources.output,
        }, { label: 'Flow Field particle spawn selection bindings' })
    } catch (error) {
        layout.dispose()
        throw error
    }
    let disposed = false
    return Object.freeze({
        module: Object.freeze({
            wgsl: particleSpawnSelectionWgsl(),
            layout,
        }),
        bindings: Object.freeze({
            bindSet,
            resources: Object.freeze([
                index.resources.counter.buffer,
                index.resources.output.buffer,
            ]),
        }),
        dispose() {

            if (disposed) return
            disposed = true
            bindSet.dispose()
            layout.dispose()
        },
    })
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

        function encode(builder: SubmissionBuilder, spawn: FlowParticleSpawnBindings): void {

            assertActive()
            const temporal = options.temporal.frame()
            validateFrame(temporal, options.temporal.layout, 'temporal')
            validateSpawn(spawn, options.spawn.layout)
            writeParticleConfig(
                configBytes,
                options,
                maximumCount,
                temporal,
                encodedSteps + 1
            )
            if (lastSimulation === undefined || lastTemporalSet !== temporal.bindSet ||
                lastSpawnSet !== spawn.bindSet) {
                lastSimulation?.dispose()
                lastTemporalSet = temporal.bindSet
                lastSpawnSet = spawn.bindSet
                lastSimulation = runtime.createDispatchCommand({
                    label: 'Simulate Flow Field canonical particles',
                    pipeline,
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
                            ...temporal.resources,
                            ...spawn.resources,
                        ]).map(resource => ({
                            resource,
                            contentEpoch: 'current-at-step' as const,
                        })),
                        write: [ particles, counters ],
                    },
                    whenMissing: 'throw',
                })
            }
            if (!initialized) {
                builder.clear(initializeParticles)
                initialized = true
            }
            builder.upload(configUpload)
            builder.clear(clearCounters)
            builder.compute(pass, [ lastSimulation ])
            encodedSteps++
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
            })
        }

        function dispose(): void {

            if (disposed) return
            disposed = true
            lastSimulation?.dispose()
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
            facts,
            dispose,
        })
    } catch (error) {
        lastSimulation?.dispose()
        for (const value of owned.reverse()) value.dispose()
        throw error
    }
}

function writeParticleConfig(
    bytes: Uint8Array,
    options: FlowParticlesOptions,
    maximumCount: number,
    temporal: FlowParticleTemporalFrame,
    frameSeed: number
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
}

function validateOptions(options: FlowParticlesOptions): void {

    const maximumCount = options?.maximumCount ?? FLOW_PARTICLE_MAXIMUM_COUNT
    if (options?.runtime === undefined || !positiveInteger(maximumCount) ||
        maximumCount > FLOW_PARTICLE_MAXIMUM_COUNT ||
        typeof options.simulationShader !== 'string' || options.simulationShader.length === 0 ||
        typeof options.temporal?.wgsl !== 'string' || options.temporal.wgsl.length === 0 ||
        options.temporal.layout?.group !== 1 || typeof options.temporal.frame !== 'function' ||
        typeof options.spawn?.wgsl !== 'string' || options.spawn.wgsl.length === 0 ||
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

    if (frame?.bindSet?.layout !== layout || !Array.isArray(frame.resources) ||
        !Number.isFinite(frame.progress) || frame.progress < 0 || frame.progress > 1 ||
        !nonNegativeInteger(frame.requestedLevel)) {
        throw new TypeError(`Flow particle ${name} bindings are invalid`)
    }
}

function validateSpawn(
    spawn: FlowParticleSpawnBindings,
    layout: BindLayout
): void {

    if (spawn?.bindSet?.layout !== layout || !Array.isArray(spawn.resources)) {
        throw new TypeError('Flow particle spawn bindings are invalid')
    }
}

function dedupeResources(resources: readonly FlowParticleGpuResource[]): FlowParticleGpuResource[] {

    return [ ...new Set(resources) ]
}

function particleSpawnSelectionWgsl(): string {

    return `struct FlowParticleSpawnCandidate {
    position: FlowVelocityAddressFixedPosition,
    requested_level: u32,
    identity: u32,
    reserved: vec2u,
}

struct FlowParticleSpawnCandidates {
    values: array<FlowParticleSpawnCandidate>,
}

struct FlowParticleSpawnAtomic {
    value: atomic<u32>,
}

struct FlowSpawnIndexSelection {
    position: FlowVelocityAddressFixedPosition,
    available: u32,
}

@group(2) @binding(0) var<storage, read_write> flowParticleSpawnCount:
    FlowParticleSpawnAtomic;
@group(2) @binding(1) var<storage, read> flowParticleSpawnCandidates:
    FlowParticleSpawnCandidates;

fn FlowParticleSpawn_unit(value: u32) -> f32 {
    return f32(value & 0xffffu) / 65535.0f;
}

fn FlowSpawnIndex_select(random_state: u32) -> FlowSpawnIndexSelection {
    let count = min(
        atomicLoad(&flowParticleSpawnCount.value),
        arrayLength(&flowParticleSpawnCandidates.values),
    );
    if (count == 0u) {
        var empty_position: FlowVelocityAddressFixedPosition;
        return FlowSpawnIndexSelection(empty_position, 0u);
    }
    let candidate = flowParticleSpawnCandidates.values[random_state % count];
    let jitter_seed = random_state * 1664525u + candidate.identity + 1013904223u;
    let jitter = vec2f(
        FlowParticleSpawn_unit(jitter_seed) - 0.5f,
        FlowParticleSpawn_unit(jitter_seed >> 16u) - 0.5f,
    ) * 50.0f;
    let advanced = FlowVelocityAddress_advance_meters(candidate.position, jitter);
    return FlowSpawnIndexSelection(
        advanced.position,
        advanced.north_south_valid,
    );
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
