import {
    type BindLayout,
    type BindSet,
    type BufferRegion,
    type BufferResource,
    type ClearBufferCommand,
    type ComputePassSpec,
    type ComputePipeline,
    type DispatchCommand,
    type GPURuntime,
    type Program,
    type ShaderModule,
    type UploadCommand,
} from '../scratch/index.js'
import { throwGeoDiagnostic } from './diagnostics.js'
import {
    gpuTileFrontierEntryCodec,
    gpuTileFrontierLayouts,
    gpuTileFrontierMapMetaCodec,
    validateGpuTileFrontierDescriptor,
    type GpuTileFrontierDescriptor,
    type GpuTileFrontierDrawTemplate,
    type GpuTileFrontierView,
} from './gpu-tile-frontier-layout.js'
import {
    createGpuTileFrontierWgsl,
    gpuTileFrontierEntryPoints,
    gpuTileFrontierWgslBindings,
    GPU_TILE_FRONTIER_SCAN_BLOCK_SIZE,
    GPU_TILE_FRONTIER_WORKGROUP_SIZE,
    type GpuTileFrontierEntryPoint,
} from './gpu-tile-frontier-wgsl.js'
import { VirtualRasterGpuState } from './virtual-raster-gpu.js'
import {
    VirtualRasterSnapshot,
    physicalPagesForSnapshot,
} from './virtual-raster.js'

const BUFFER_COPY_DST = 0x08
const BUFFER_UNIFORM = 0x40
const BUFFER_STORAGE = 0x80
const BUFFER_INDIRECT = 0x100
const U32_MAX = 0xffff_ffff
const DISPATCH_ARGUMENT_BYTES = 12
const DRAW_ARGUMENT_BYTES = 16
const LOOKUP_WORDS = 4
const DECISION_WORDS = 16
const PREFIX_WORDS = 8
const COUNTER_WORDS = 32
const SLOT_TABLE_WORDS = 12

let nextFrontierId = 1

export type GpuTileFrontierResourceGraph = Readonly<{
    mapMeta: BufferResource
    policy: BufferResource
    levelMetrics: BufferResource
    frontierA: BufferResource
    frontierB: BufferResource
    frontierLookup: BufferResource
    dispatchArgumentsA: BufferResource
    dispatchArgumentsB: BufferResource
    visibilityFlags: BufferResource
    decisionFlags: BufferResource
    prefixScanScratch: BufferResource
    visibleInstancesA: BufferResource
    visibleInstancesB: BufferResource
    demands: BufferResource
    retirements: BufferResource
    counters: BufferResource
    diagnostics: BufferResource
    drawArgumentsA: BufferResource
    drawArgumentsB: BufferResource
}>

export type GpuTileFrontierFrame = Readonly<{
    kind: 'gpu-tile-frontier-frame'
    frontierId: string
    frameEpoch: number
    parity: 0 | 1
    source: 'A' | 'B'
    target: 'A' | 'B'
    pass: ComputePassSpec
    commands: readonly DispatchCommand[]
    currentFrontier: BufferResource
    nextFrontier: BufferResource
    currentDispatchArguments: BufferResource
    nextDispatchArguments: BufferResource
    visibleInstances: BufferResource
    drawArguments: BufferResource
}>

export type GpuTileFrontierDrawArgument = Readonly<{
    frontierId: string
    frameEpoch: number
    templateId: string
    resource: BufferResource
    region: BufferRegion
    offset: number
    size: 16
}>

export type GpuTileFrontierSeed = Readonly<{
    snapshot: VirtualRasterSnapshot
    snapshotEpoch: number
    clears: readonly ClearBufferCommand[]
    uploads: readonly UploadCommand[]
    commands: readonly (ClearBufferCommand | UploadCommand)[]
}>

export type GpuTileFrontierViewUpload = Readonly<{
    frameEpoch: number
    residencySnapshotEpoch: number
    resource: BufferResource
    command: UploadCommand
    data: Uint8Array
}>

export type GpuTileFrontierCoreFacts = Readonly<{
    id: string
    runtimeId: string
    addressSpaceId: string
    disposed: boolean
    seededSnapshotEpoch?: number
    lastViewFrameEpoch?: number
    capacities: Readonly<{
        activeTiles: number
        demands: number
        physicalSlots: number
        transitionReservePages: number
        lookupEntries: number
        scanBlocks: number
        drawTemplates: number
    }>
    resources: GpuTileFrontierResourceGraph
    bufferBytes: Readonly<Record<keyof GpuTileFrontierResourceGraph, number>>
    parityTemplates: readonly Readonly<{
        parity: 0 | 1
        source: 'A' | 'B'
        target: 'A' | 'B'
        commandIds: readonly string[]
    }>[]
}>

type Disposable = { dispose(): void }

type ParityTemplate = Readonly<{
    parity: 0 | 1
    source: 'A' | 'B'
    target: 'A' | 'B'
    commands: readonly DispatchCommand[]
    currentFrontier: BufferResource
    nextFrontier: BufferResource
    currentDispatchArguments: BufferResource
    nextDispatchArguments: BufferResource
    visibleInstances: BufferResource
    drawArguments: BufferResource
    drawRegions: ReadonlyMap<string, BufferRegion>
}>

type CreationState = Readonly<{
    resources: GpuTileFrontierResourceGraph
    pass: ComputePassSpec
    parityTemplates: readonly [ParityTemplate, ParityTemplate]
    owned: readonly Disposable[]
    mapBytes: Uint8Array
    mapUpload: UploadCommand
    seedFrontierBytes: Uint8Array
    seedDispatchWords: Uint32Array
    seedCounterWords: Uint32Array
    seedClears: readonly ClearBufferCommand[]
    seedUploads: readonly UploadCommand[]
    capacities: Readonly<{
        lookupEntries: number
        scanBlocks: number
    }>
}>

type FrameRecord = Readonly<{
    owner: GpuTileFrontier
    template: ParityTemplate
}>

const frameRecords = new WeakMap<GpuTileFrontierFrame, FrameRecord>()

export class GpuTileFrontier {

    readonly runtime: GPURuntime
    readonly id: string
    readonly descriptor: GpuTileFrontierDescriptor
    readonly #resources: GpuTileFrontierResourceGraph
    readonly #pass: ComputePassSpec
    readonly #parityTemplates: readonly [ParityTemplate, ParityTemplate]
    readonly #owned: readonly Disposable[]
    readonly #mapBytes: Uint8Array
    readonly #mapUpload: UploadCommand
    readonly #seedFrontierBytes: Uint8Array
    readonly #seedDispatchWords: Uint32Array
    readonly #seedCounterWords: Uint32Array
    readonly #seedClears: readonly ClearBufferCommand[]
    readonly #seedUploads: readonly UploadCommand[]
    readonly #lookupCapacity: number
    readonly #scanBlockCount: number
    #disposed = false
    #seed: GpuTileFrontierSeed | undefined
    #lastViewFrameEpoch: number | undefined

    private constructor(
        runtime: GPURuntime,
        descriptor: GpuTileFrontierDescriptor,
        state: CreationState
    ) {

        this.runtime = runtime
        this.id = `geo-gpu-tile-frontier-${nextFrontierId++}`
        this.descriptor = descriptor
        this.#resources = state.resources
        this.#pass = state.pass
        this.#parityTemplates = state.parityTemplates
        this.#owned = state.owned
        this.#mapBytes = state.mapBytes
        this.#mapUpload = state.mapUpload
        this.#seedFrontierBytes = state.seedFrontierBytes
        this.#seedDispatchWords = state.seedDispatchWords
        this.#seedCounterWords = state.seedCounterWords
        this.#seedClears = state.seedClears
        this.#seedUploads = state.seedUploads
        this.#lookupCapacity = state.capacities.lookupEntries
        this.#scanBlockCount = state.capacities.scanBlocks
    }

    static async create(
        runtime: GPURuntime,
        descriptor: GpuTileFrontierDescriptor
    ): Promise<GpuTileFrontier> {

        const bounds = validateCreation(runtime, descriptor)
        const wgsl = createGpuTileFrontierWgsl(
            descriptor,
            bounds.lookupCapacity,
            bounds.scanBlockCount
        )
        const owned: Disposable[] = []
        const own = <Value extends Disposable>(value: Value): Value => {
            owned.push(value)
            return value
        }
        try {
            const resources = await createResources(runtime, bounds.bufferBytes, own)
            const mapView = gpuTileFrontierMapMetaCodec.uploadView(mapMetaRecord(zeroView()))
            const mapBytes = mapView.bytes
            const mapUpload = own(runtime.createUploadCommand({
                label: 'Upload GPU tile frontier view',
                target: resources.mapMeta.region({
                    layout: gpuTileFrontierLayouts.mapMeta.codec.artifact,
                }),
                data: mapView,
            }))
            const policyUpload = own(runtime.createUploadCommand({
                label: 'Upload GPU tile frontier policy',
                target: resources.policy.region({
                    layout: gpuTileFrontierLayouts.policy.codec.artifact,
                }),
                data: gpuTileFrontierLayouts.policy.codec.uploadView(descriptor.policy),
            }))
            const levelMetricsUpload = own(runtime.createUploadCommand({
                label: 'Upload GPU tile frontier level metrics',
                target: resources.levelMetrics.region({
                    layout: gpuTileFrontierLayouts.levelMetric.codec.artifact,
                }),
                data: gpuTileFrontierLayouts.levelMetric.codec.uploadView(descriptor.levelMetrics),
            }))
            const seedFrontierBytes = new Uint8Array(
                descriptor.roots.length * gpuTileFrontierLayouts.frontierEntry.byteSize
            )
            const seedFrontierUpload = own(runtime.createUploadCommand({
                label: 'Upload GPU tile frontier roots',
                target: resources.frontierA.region({
                    size: seedFrontierBytes.byteLength,
                    layout: gpuTileFrontierLayouts.frontierEntry.codec.artifact,
                }),
                data: layoutUpload(seedFrontierBytes, gpuTileFrontierLayouts.frontierEntry.codec.artifact),
            }))
            const seedDispatchWords = new Uint32Array(3)
            const seedDispatchUpload = own(runtime.createUploadCommand({
                label: 'Upload GPU tile frontier seed dispatch',
                target: resources.dispatchArgumentsA.region(),
                data: seedDispatchWords,
            }))
            const seedCounterWords = new Uint32Array(COUNTER_WORDS)
            const seedCountersUpload = own(runtime.createUploadCommand({
                label: 'Upload GPU tile frontier seed counters',
                target: resources.counters.region(),
                data: seedCounterWords,
            }))
            const seedClears = Object.freeze([
                resources.frontierA,
                resources.frontierB,
                resources.frontierLookup,
                resources.dispatchArgumentsA,
                resources.dispatchArgumentsB,
                resources.visibilityFlags,
                resources.decisionFlags,
                resources.prefixScanScratch,
                resources.visibleInstancesA,
                resources.visibleInstancesB,
                resources.demands,
                resources.retirements,
                resources.counters,
                resources.diagnostics,
                resources.drawArgumentsA,
                resources.drawArgumentsB,
            ].map((resource, index) => own(runtime.createClearBufferCommand({
                label: `Clear GPU tile frontier seed resource ${index}`,
                target: resource.region(),
            }))))
            const seedUploads = Object.freeze([
                policyUpload,
                levelMetricsUpload,
                seedFrontierUpload,
                seedDispatchUpload,
                seedCountersUpload,
            ])
            const shader = own(await runtime.createShaderModule({
                label: 'GPU tile frontier kernels',
                sourceParts: [ {
                    label: 'GPU tile frontier shared ABI and kernels',
                    code: wgsl.code,
                    layoutDependencies: wgsl.layoutDependencies,
                } ],
            }))
            const pass = own(runtime.createComputePass({ label: 'GPU tile frontier pass' }))
            const kernels = await createKernels(
                runtime,
                shader,
                resources,
                descriptor.gpuState,
                bounds,
                own
            )
            const parityTemplates = createParityTemplates(descriptor.drawTemplates, resources, kernels)
            return new GpuTileFrontier(runtime, descriptor, {
                resources,
                pass,
                parityTemplates,
                owned: Object.freeze([ ...owned ]),
                mapBytes,
                mapUpload,
                seedFrontierBytes,
                seedDispatchWords,
                seedCounterWords,
                seedClears,
                seedUploads,
                capacities: Object.freeze({
                    lookupEntries: bounds.lookupCapacity,
                    scanBlocks: bounds.scanBlockCount,
                }),
            })
        } catch (error) {
            disposeReverse(owned)
            throw error
        }
    }

    stageSeed(snapshot: VirtualRasterSnapshot): GpuTileFrontierSeed {

        this.#assertActive()
        if (this.#seed?.snapshot === snapshot) return this.#seed
        if (this.#seed !== undefined) {
            return invalidFrontier(
                this,
                'GPU tile frontier seed is immutable after its acknowledged snapshot is staged.',
                { snapshotEpoch: this.#seed.snapshotEpoch },
                { snapshotEpoch: snapshot?.epoch }
            )
        }
        const entries = validateSeedSnapshot(this, snapshot)
        gpuTileFrontierEntryCodec.write(this.#seedFrontierBytes, entries)
        this.#seedDispatchWords.fill(0)
        this.#seedDispatchWords[0] = ceilDivide(entries.length, GPU_TILE_FRONTIER_WORKGROUP_SIZE)
        this.#seedDispatchWords[1] = 1
        this.#seedDispatchWords[2] = 1
        this.#seedCounterWords.fill(0)
        this.#seedCounterWords[0] = entries.length
        const commands = Object.freeze([ ...this.#seedClears, ...this.#seedUploads ])
        this.#seed = Object.freeze({
            snapshot,
            snapshotEpoch: snapshot.epoch,
            clears: this.#seedClears,
            uploads: this.#seedUploads,
            commands,
        })
        return this.#seed
    }

    writeView(view: GpuTileFrontierView): GpuTileFrontierViewUpload {

        this.#assertActive()
        validateView(this, view)
        gpuTileFrontierMapMetaCodec.write(this.#mapBytes, mapMetaRecord(view))
        this.#lastViewFrameEpoch = view.frameEpoch
        return Object.freeze({
            frameEpoch: view.frameEpoch,
            residencySnapshotEpoch: view.residencySnapshotEpoch,
            resource: this.#resources.mapMeta,
            command: this.#mapUpload,
            data: this.#mapBytes,
        })
    }

    frame(frameEpoch: number): GpuTileFrontierFrame {

        this.#assertActive()
        if (!u32(frameEpoch)) {
            return invalidFrontier(this, 'GPU tile frontier frame epochs must fit u32.', {
                frameEpoch: 'u32',
            }, { frameEpoch })
        }
        if (this.#lastViewFrameEpoch !== undefined && this.#lastViewFrameEpoch !== frameEpoch) {
            return invalidFrontier(this, 'GPU tile frontier frame must match the latest packed view.', {
                frameEpoch: this.#lastViewFrameEpoch,
            }, { frameEpoch })
        }
        const template = this.#parityTemplates[frameEpoch & 1]!
        const frame = Object.freeze({
            kind: 'gpu-tile-frontier-frame' as const,
            frontierId: this.id,
            frameEpoch,
            parity: template.parity,
            source: template.source,
            target: template.target,
            pass: this.#pass,
            commands: template.commands,
            currentFrontier: template.currentFrontier,
            nextFrontier: template.nextFrontier,
            currentDispatchArguments: template.currentDispatchArguments,
            nextDispatchArguments: template.nextDispatchArguments,
            visibleInstances: template.visibleInstances,
            drawArguments: template.drawArguments,
        })
        frameRecords.set(frame, Object.freeze({ owner: this, template }))
        return frame
    }

    drawArgument(frame: GpuTileFrontierFrame, id: string): GpuTileFrontierDrawArgument {

        this.#assertActive()
        const record = frameRecords.get(frame)
        if (record?.owner !== this || frame.frontierId !== this.id) {
            return invalidFrontier(this, 'GPU tile frontier draw arguments require an owned frame.', {
                frontierId: this.id,
            }, { frontierId: frame?.frontierId })
        }
        const templateIndex = this.descriptor.drawTemplates.findIndex(template => template.id === id)
        const region = record.template.drawRegions.get(id)
        if (templateIndex < 0 || region === undefined) {
            return invalidFrontier(this, 'GPU tile frontier draw template id is not declared.', {
                templateIds: this.descriptor.drawTemplates.map(template => template.id),
            }, { templateId: id })
        }
        const offset = templateIndex * DRAW_ARGUMENT_BYTES
        return Object.freeze({
            frontierId: this.id,
            frameEpoch: frame.frameEpoch,
            templateId: id,
            resource: record.template.drawArguments,
            region,
            offset,
            size: DRAW_ARGUMENT_BYTES,
        })
    }

    facts(): GpuTileFrontierCoreFacts {

        const facts: {
            id: string
            runtimeId: string
            addressSpaceId: string
            disposed: boolean
            seededSnapshotEpoch?: number
            lastViewFrameEpoch?: number
            capacities: GpuTileFrontierCoreFacts['capacities']
            resources: GpuTileFrontierResourceGraph
            bufferBytes: Readonly<Record<keyof GpuTileFrontierResourceGraph, number>>
            parityTemplates: GpuTileFrontierCoreFacts['parityTemplates']
        } = {
            id: this.id,
            runtimeId: this.runtime.id,
            addressSpaceId: this.descriptor.gpuState.addressSpace.id,
            disposed: this.#disposed,
            capacities: Object.freeze({
                activeTiles: this.descriptor.policy.maximumActiveTiles,
                demands: this.descriptor.policy.maximumDemands,
                physicalSlots: this.descriptor.gpuState.maxPhysicalPages,
                transitionReservePages: this.descriptor.policy.transitionReservePages,
                lookupEntries: this.#lookupCapacity,
                scanBlocks: this.#scanBlockCount,
                drawTemplates: this.descriptor.drawTemplates.length,
            }),
            resources: this.#resources,
            bufferBytes: Object.freeze(Object.fromEntries(
                Object.entries(this.#resources).map(([ name, resource ]) => [ name, resource.size ])
            ) as Record<keyof GpuTileFrontierResourceGraph, number>),
            parityTemplates: Object.freeze(this.#parityTemplates.map(template => Object.freeze({
                parity: template.parity,
                source: template.source,
                target: template.target,
                commandIds: Object.freeze(template.commands.map(command => command.id)),
            }))),
        }
        if (this.#seed !== undefined) facts.seededSnapshotEpoch = this.#seed.snapshotEpoch
        if (this.#lastViewFrameEpoch !== undefined) facts.lastViewFrameEpoch = this.#lastViewFrameEpoch
        return Object.freeze(facts)
    }

    dispose(): void {

        if (this.#disposed) return
        this.#disposed = true
        disposeReverse(this.#owned)
    }

    #assertActive(): void {

        if (this.#disposed) {
            return throwGeoDiagnostic({
                code: 'GEO_GPU_TILE_FRONTIER_DISPOSED',
                phase: 'selection',
                subject: { kind: 'gpu-tile-frontier', id: this.id },
                message: 'GPU tile frontier is disposed.',
            })
        }
    }
}

type CreationBounds = Readonly<{
    lookupCapacity: number
    scanBlockCount: number
    bufferBytes: Readonly<Record<keyof GpuTileFrontierResourceGraph, number>>
}>

function validateCreation(
    runtime: GPURuntime,
    descriptor: GpuTileFrontierDescriptor
): CreationBounds {

    validateGpuTileFrontierDescriptor(descriptor)
    if (!(descriptor.gpuState instanceof VirtualRasterGpuState) ||
        descriptor.gpuState.runtime !== runtime) {
        return throwGeoDiagnostic({
            code: 'GEO_GPU_TILE_FRONTIER_INVALID',
            phase: 'selection',
            subject: { kind: 'gpu-tile-frontier' },
            message: 'GPU tile frontier and Virtual Raster GPU state must share one runtime.',
            expected: { runtimeId: runtime?.id, gpuState: 'VirtualRasterGpuState' },
            actual: {
                runtimeId: descriptor.gpuState?.runtime?.id,
                gpuState: descriptor.gpuState?.constructor?.name,
            },
        })
    }
    if (runtime.isDisposed || descriptor.gpuState.slotTable.isDisposed) {
        return capacityInvalid('GPU tile frontier requires active caller-owned GPU objects.', {
            runtimeDisposed: false,
            slotTableDisposed: false,
        }, {
            runtimeDisposed: runtime.isDisposed,
            slotTableDisposed: descriptor.gpuState.slotTable.isDisposed,
        })
    }
    validateCoverageBounds(descriptor)
    const active = descriptor.policy.maximumActiveTiles
    const reserve = descriptor.policy.transitionReservePages
    const physicalSlots = descriptor.gpuState.maxPhysicalPages
    if (active + reserve > physicalSlots) {
        return capacityInvalid(
            'GPU tile frontier active and transition capacities exceed physical residency slots.',
            { maximumActiveTilesPlusReserve: `<= ${physicalSlots}` },
            { maximumActiveTiles: active, transitionReservePages: reserve }
        )
    }
    const expectedSlotBytes = checkedProduct(physicalSlots, SLOT_TABLE_WORDS * 4)
    if (descriptor.gpuState.slotTable.size < expectedSlotBytes) {
        return capacityInvalid('GPU tile frontier slot table is smaller than its declared capacity.', {
            slotTableBytes: expectedSlotBytes,
        }, { slotTableBytes: descriptor.gpuState.slotTable.size })
    }
    const lookupCapacity = nextPowerOfTwo(checkedProduct(active, 2))
    const scanBlockCount = ceilDivide(active, GPU_TILE_FRONTIER_SCAN_BLOCK_SIZE)
    const entryBytes = gpuTileFrontierLayouts.frontierEntry.byteSize
    const visibleBytes = gpuTileFrontierLayouts.visibleInstance.byteSize
    const demandBytes = gpuTileFrontierLayouts.demand.byteSize
    const bufferBytes: Record<keyof GpuTileFrontierResourceGraph, number> = {
        mapMeta: gpuTileFrontierLayouts.mapMeta.byteSize,
        policy: gpuTileFrontierLayouts.policy.byteSize,
        levelMetrics: checkedProduct(
            descriptor.levelMetrics.length,
            gpuTileFrontierLayouts.levelMetric.byteSize
        ),
        frontierA: checkedProduct(active, entryBytes),
        frontierB: checkedProduct(active, entryBytes),
        frontierLookup: checkedProduct(lookupCapacity, LOOKUP_WORDS * 4),
        dispatchArgumentsA: DISPATCH_ARGUMENT_BYTES,
        dispatchArgumentsB: DISPATCH_ARGUMENT_BYTES,
        visibilityFlags: checkedProduct(active, 4),
        decisionFlags: checkedProduct(active, DECISION_WORDS * 4),
        prefixScanScratch: checkedProduct(active + scanBlockCount, PREFIX_WORDS * 4),
        visibleInstancesA: checkedProduct(active, visibleBytes),
        visibleInstancesB: checkedProduct(active, visibleBytes),
        demands: checkedProduct(descriptor.policy.maximumDemands, demandBytes),
        retirements: checkedProduct(active, entryBytes),
        counters: COUNTER_WORDS * 4,
        diagnostics: gpuTileFrontierLayouts.diagnostics.byteSize,
        drawArgumentsA: checkedProduct(descriptor.drawTemplates.length, DRAW_ARGUMENT_BYTES),
        drawArgumentsB: checkedProduct(descriptor.drawTemplates.length, DRAW_ARGUMENT_BYTES),
    }
    validateDeviceBounds(runtime, bufferBytes, lookupCapacity, scanBlockCount, active)
    return Object.freeze({
        lookupCapacity,
        scanBlockCount,
        bufferBytes: Object.freeze(bufferBytes),
    })
}

function validateCoverageBounds(descriptor: GpuTileFrontierDescriptor): void {

    const coverage = descriptor.addressCodec.coverage
    for (const metric of descriptor.levelMetrics) {
        const matrixId = String(metric.matrixLevel)
        const limit = coverage.limit(matrixId)
        if (limit === undefined) {
            return descriptorInvalid(
                'GPU tile frontier coverage must contain every selected matrix level.',
                { matrixId, coverageLimit: 'present' },
                { matrixId, coverageLimit: undefined }
            )
        }
        const first = coverage.index({
            matrixId,
            tileRow: limit.minTileRow,
            tileCol: limit.minTileCol,
        })
        const last = coverage.index({
            matrixId,
            tileRow: limit.maxTileRow,
            tileCol: limit.maxTileCol,
        })
        if (!u32(first) || !u32(last) || last < first) {
            return capacityInvalid(
                'GPU tile frontier compact coverage indexes must fit u32.',
                { matrixId, first: 'u32', last: 'ordered u32' },
                { matrixId, first, last }
            )
        }
    }
}

function validateDeviceBounds(
    runtime: GPURuntime,
    bufferBytes: Readonly<Record<keyof GpuTileFrontierResourceGraph, number>>,
    lookupCapacity: number,
    scanBlockCount: number,
    active: number
): void {

    const limits = runtime.deviceLimits
    const maximumStorageBytes = numberLimit(limits.maxStorageBufferBindingSize)
    const maximumUniformBytes = numberLimit(limits.maxUniformBufferBindingSize)
    const maximumBufferBytes = numberLimit(limits.maxBufferSize)
    for (const [ role, byteLength ] of Object.entries(bufferBytes)) {
        const bindingMaximum = role === 'mapMeta' || role === 'policy'
            ? maximumUniformBytes
            : maximumStorageBytes
        if (byteLength <= maximumBufferBytes && byteLength <= bindingMaximum) continue
        return capacityInvalid('GPU tile frontier buffer exceeds a device binding limit.', {
            maximumBufferBytes,
            bindingMaximum,
        }, { role, byteLength })
    }
    const maximumWorkgroups = numberLimit(limits.maxComputeWorkgroupsPerDimension)
    const directWorkgroups = [
        ceilDivide(active, GPU_TILE_FRONTIER_WORKGROUP_SIZE),
        ceilDivide(lookupCapacity, GPU_TILE_FRONTIER_WORKGROUP_SIZE),
        scanBlockCount,
    ]
    if (directWorkgroups.some(value => value > maximumWorkgroups)) {
        return capacityInvalid('GPU tile frontier dispatch dimensions exceed the device limit.', {
            maxComputeWorkgroupsPerDimension: maximumWorkgroups,
        }, { directWorkgroups })
    }
    if (numberLimit(limits.maxStorageBuffersPerShaderStage) < 8 ||
        numberLimit(limits.maxBindGroups) < 1 ||
        numberLimit(limits.maxBindingsPerBindGroup) <= gpuTileFrontierWgslBindings.nextDispatchArguments) {
        return capacityInvalid('GPU tile frontier requires its bounded compute binding footprint.', {
            maxStorageBuffersPerShaderStage: '>= 8',
            maxBindGroups: '>= 1',
            maxBindingsPerBindGroup: `> ${gpuTileFrontierWgslBindings.nextDispatchArguments}`,
        }, {
            maxStorageBuffersPerShaderStage: limits.maxStorageBuffersPerShaderStage,
            maxBindGroups: limits.maxBindGroups,
            maxBindingsPerBindGroup: limits.maxBindingsPerBindGroup,
        })
    }
}

async function createResources(
    runtime: GPURuntime,
    sizes: Readonly<Record<keyof GpuTileFrontierResourceGraph, number>>,
    own: <Value extends Disposable>(value: Value) => Value
): Promise<GpuTileFrontierResourceGraph> {

    const create = async(
        role: keyof GpuTileFrontierResourceGraph,
        usage: number
    ): Promise<BufferResource> => own(await runtime.createBuffer({
        label: `GPU tile frontier ${role}`,
        size: sizes[role],
        usage: usage | BUFFER_COPY_DST,
    }))
    return Object.freeze({
        mapMeta: await create('mapMeta', BUFFER_UNIFORM),
        policy: await create('policy', BUFFER_UNIFORM),
        levelMetrics: await create('levelMetrics', BUFFER_STORAGE),
        frontierA: await create('frontierA', BUFFER_STORAGE),
        frontierB: await create('frontierB', BUFFER_STORAGE),
        frontierLookup: await create('frontierLookup', BUFFER_STORAGE),
        dispatchArgumentsA: await create('dispatchArgumentsA', BUFFER_STORAGE | BUFFER_INDIRECT),
        dispatchArgumentsB: await create('dispatchArgumentsB', BUFFER_STORAGE | BUFFER_INDIRECT),
        visibilityFlags: await create('visibilityFlags', BUFFER_STORAGE),
        decisionFlags: await create('decisionFlags', BUFFER_STORAGE),
        prefixScanScratch: await create('prefixScanScratch', BUFFER_STORAGE),
        visibleInstancesA: await create('visibleInstancesA', BUFFER_STORAGE),
        visibleInstancesB: await create('visibleInstancesB', BUFFER_STORAGE),
        demands: await create('demands', BUFFER_STORAGE),
        retirements: await create('retirements', BUFFER_STORAGE),
        counters: await create('counters', BUFFER_STORAGE),
        diagnostics: await create('diagnostics', BUFFER_STORAGE),
        drawArgumentsA: await create('drawArgumentsA', BUFFER_STORAGE | BUFFER_INDIRECT),
        drawArgumentsB: await create('drawArgumentsB', BUFFER_STORAGE | BUFFER_INDIRECT),
    })
}

type ResourceRole = keyof GpuTileFrontierResourceGraph | 'slotTable'
type BindingType = 'uniform' | 'read-storage' | 'storage'
type KernelBinding = Readonly<{
    name: string
    binding: number
    type: BindingType
    role: ResourceRole
}>
type KernelDefinition = Readonly<{
    entryPoint: GpuTileFrontierEntryPoint
    label: string
    bindings: readonly KernelBinding[]
    count: 'indirect' | readonly [number, number, number]
}>

type KernelPair = Readonly<{
    even: DispatchCommand
    odd: DispatchCommand
}>

async function createKernels(
    runtime: GPURuntime,
    shader: ShaderModule,
    resources: GpuTileFrontierResourceGraph,
    gpuState: VirtualRasterGpuState,
    bounds: CreationBounds,
    own: <Value extends Disposable>(value: Value) => Value
): Promise<ReadonlyMap<GpuTileFrontierEntryPoint, KernelPair>> {

    const definitions = kernelDefinitions(bounds, resources, gpuState)
    const result = new Map<GpuTileFrontierEntryPoint, KernelPair>()
    for (const definition of definitions) {
        const layout = own(await runtime.createBindLayout({
            label: `${definition.label} layout`,
            group: 0,
            entries: definition.bindings.map(binding => ({
                binding: binding.binding,
                name: binding.name,
                type: binding.type,
                visibility: [ 'compute' ],
                minBindingSize: resourceForRole(binding.role, 0, resources, gpuState).size,
            })),
        }))
        const program = own(runtime.createProgram({
            label: `${definition.label} program`,
            compute: { module: shader, entryPoint: definition.entryPoint },
        }))
        const pipeline = own(await runtime.createComputePipeline({
            label: `${definition.label} pipeline`,
            program,
            layout: { mode: 'explicit', bindLayouts: [ layout ] },
        }))
        const even = await createKernelCommand(
            runtime,
            definition,
            pipeline,
            layout,
            0,
            resources,
            gpuState,
            own
        )
        const odd = await createKernelCommand(
            runtime,
            definition,
            pipeline,
            layout,
            1,
            resources,
            gpuState,
            own
        )
        result.set(definition.entryPoint, Object.freeze({ even, odd }))
    }
    return result
}

async function createKernelCommand(
    runtime: GPURuntime,
    definition: KernelDefinition,
    pipeline: ComputePipeline,
    layout: BindLayout,
    parity: 0 | 1,
    resources: GpuTileFrontierResourceGraph,
    gpuState: VirtualRasterGpuState,
    own: <Value extends Disposable>(value: Value) => Value
): Promise<DispatchCommand> {

    const bound = Object.fromEntries(definition.bindings.map(binding => [
        binding.name,
        regionForRole(binding.role, parity, resources, gpuState),
    ]))
    const bindSet = own(await runtime.createBindSet(layout, bound, {
        label: `${definition.label} ${parity === 0 ? 'A to B' : 'B to A'} bindings`,
    }))
    const reads: BufferResource[] = []
    const writes: BufferResource[] = []
    for (const binding of definition.bindings) {
        const resource = resourceForRole(binding.role, parity, resources, gpuState)
        reads.push(resource)
        if (binding.type === 'storage') writes.push(resource)
    }
    const currentDispatch = parity === 0
        ? resources.dispatchArgumentsA
        : resources.dispatchArgumentsB
    if (definition.count === 'indirect') reads.push(currentDispatch)
    return own(runtime.createDispatchCommand({
        label: definition.label,
        pipeline,
        bindSets: [ { set: bindSet } ],
        count: definition.count === 'indirect'
            ? { indirect: currentDispatch.region() }
            : { workgroups: [
                definition.count[0],
                definition.count[1],
                definition.count[2],
            ] },
        resources: {
            read: uniqueResources(reads).map(resource => ({
                resource,
                contentEpoch: 'current-at-step' as const,
            })),
            write: uniqueResources(writes),
        },
        whenMissing: 'throw',
    }))
}

function kernelDefinitions(
    bounds: CreationBounds,
    resources: GpuTileFrontierResourceGraph,
    gpuState: VirtualRasterGpuState
): readonly KernelDefinition[] {

    void resources
    void gpuState
    const b = gpuTileFrontierWgslBindings
    const binding = (name: string, type: BindingType, role: ResourceRole): KernelBinding => ({
        name,
        binding: b[name as keyof typeof b],
        type,
        role,
    })
    const map = binding('mapMeta', 'uniform', 'mapMeta')
    const policy = binding('policy', 'uniform', 'policy')
    const metrics = binding('levelMetrics', 'read-storage', 'levelMetrics')
    const current = binding('currentFrontier', 'read-storage', 'frontierA')
    const next = binding('nextFrontier', 'storage', 'frontierB')
    const slots = binding('slotTable', 'read-storage', 'slotTable')
    const lookupWrite = binding('lookupWrite', 'storage', 'frontierLookup')
    const lookupRead = binding('lookupRead', 'read-storage', 'frontierLookup')
    const currentDispatch = binding('currentDispatchArguments', 'storage', 'dispatchArgumentsA')
    const visibility = binding('visibilityFlags', 'storage', 'visibilityFlags')
    const decisionWrite = binding('decisionWrite', 'storage', 'decisionFlags')
    const decisionRead = binding('decisionRead', 'read-storage', 'decisionFlags')
    const prefixWrite = binding('prefixWrite', 'storage', 'prefixScanScratch')
    const prefixRead = binding('prefixRead', 'read-storage', 'prefixScanScratch')
    const visible = binding('visibleOutput', 'storage', 'visibleInstancesB')
    const demand = binding('demandOutput', 'storage', 'demands')
    const retire = binding('retireOutput', 'storage', 'retirements')
    const countersWrite = binding('countersWrite', 'storage', 'counters')
    const countersRead = binding('countersRead', 'read-storage', 'counters')
    const diagnostics = binding('diagnosticsOutput', 'storage', 'diagnostics')
    const draw = binding('drawArgumentsOutput', 'storage', 'drawArgumentsB')
    const nextDispatch = binding('nextDispatchArguments', 'storage', 'dispatchArgumentsB')
    const activeGroups = ceilDivide(
        resources.frontierA.size / gpuTileFrontierLayouts.frontierEntry.byteSize,
        GPU_TILE_FRONTIER_WORKGROUP_SIZE
    )
    return Object.freeze([
        { entryPoint: 'resetFrontier', label: 'Reset GPU tile frontier', bindings: [ map, currentDispatch, visibility, decisionWrite, prefixWrite, countersWrite ], count: [ activeGroups, 1, 1 ] },
        { entryPoint: 'clearLookup', label: 'Clear GPU tile frontier lookup', bindings: [ lookupWrite ], count: [ ceilDivide(bounds.lookupCapacity, GPU_TILE_FRONTIER_WORKGROUP_SIZE), 1, 1 ] },
        { entryPoint: 'buildLookup', label: 'Build GPU tile frontier lookup', bindings: [ map, current, lookupWrite, countersWrite ], count: 'indirect' },
        { entryPoint: 'evaluateFrontier', label: 'Evaluate GPU tile frontier', bindings: [ map, policy, metrics, current, slots, visibility, decisionWrite, countersWrite ], count: 'indirect' },
        { entryPoint: 'selectBudgets', label: 'Select GPU tile frontier budgets', bindings: [ map, policy, current, slots, lookupRead, decisionWrite, countersWrite ], count: [ 1, 1, 1 ] },
        { entryPoint: 'resolveTransitions', label: 'Resolve GPU tile frontier transitions', bindings: [ map, policy, metrics, current, slots, visibility, decisionWrite, countersWrite ], count: 'indirect' },
        { entryPoint: 'balanceNeighbors', label: 'Balance GPU tile frontier neighbors', bindings: [ map, policy, current, lookupRead, visibility, decisionWrite, countersWrite ], count: 'indirect' },
        { entryPoint: 'scanBlocks', label: 'Scan GPU tile frontier blocks', bindings: [ decisionRead, prefixWrite, countersRead ], count: [ bounds.scanBlockCount, 1, 1 ] },
        { entryPoint: 'scanBlockSums', label: 'Scan GPU tile frontier block sums', bindings: [ current, decisionRead, prefixWrite, countersWrite ], count: [ 1, 1, 1 ] },
        { entryPoint: 'addScanOffsets', label: 'Add GPU tile frontier scan offsets', bindings: [ prefixWrite, countersRead ], count: [ bounds.scanBlockCount, 1, 1 ] },
        { entryPoint: 'compactOutputs', label: 'Compact GPU tile frontier outputs', bindings: [ map, policy, metrics, current, slots, decisionRead, prefixRead, next, visible, demand ], count: 'indirect' },
        { entryPoint: 'finalizeArguments', label: 'Finalize GPU tile frontier arguments', bindings: [ map, policy, current, decisionRead, prefixRead, retire, countersWrite, diagnostics, draw, nextDispatch ], count: [ 1, 1, 1 ] },
    ] satisfies readonly KernelDefinition[])
}

function createParityTemplates(
    drawTemplates: readonly GpuTileFrontierDrawTemplate[],
    resources: GpuTileFrontierResourceGraph,
    kernels: ReadonlyMap<GpuTileFrontierEntryPoint, KernelPair>
): readonly [ParityTemplate, ParityTemplate] {

    const create = (parity: 0 | 1): ParityTemplate => {
        const source = parity === 0 ? 'A' : 'B'
        const target = parity === 0 ? 'B' : 'A'
        const drawArguments = parity === 0 ? resources.drawArgumentsB : resources.drawArgumentsA
        const commands = Object.freeze(gpuTileFrontierEntryPoints.map(entryPoint => {
            const pair = kernels.get(entryPoint)
            if (pair === undefined) throw new TypeError(`Missing GPU tile frontier kernel: ${entryPoint}`)
            return parity === 0 ? pair.even : pair.odd
        }))
        return Object.freeze({
            parity,
            source,
            target,
            commands,
            currentFrontier: parity === 0 ? resources.frontierA : resources.frontierB,
            nextFrontier: parity === 0 ? resources.frontierB : resources.frontierA,
            currentDispatchArguments: parity === 0
                ? resources.dispatchArgumentsA
                : resources.dispatchArgumentsB,
            nextDispatchArguments: parity === 0
                ? resources.dispatchArgumentsB
                : resources.dispatchArgumentsA,
            visibleInstances: parity === 0
                ? resources.visibleInstancesB
                : resources.visibleInstancesA,
            drawArguments,
            drawRegions: new Map(drawTemplates.map((template, index) => [
                template.id,
                drawArguments.region({ offset: index * DRAW_ARGUMENT_BYTES, size: DRAW_ARGUMENT_BYTES }),
            ])),
        })
    }
    return Object.freeze([ create(0), create(1) ])
}

function resourceForRole(
    role: ResourceRole,
    parity: 0 | 1,
    resources: GpuTileFrontierResourceGraph,
    gpuState: VirtualRasterGpuState
): BufferResource {

    if (role === 'slotTable') return gpuState.slotTable
    if (role === 'frontierA') return parity === 0 ? resources.frontierA : resources.frontierB
    if (role === 'frontierB') return parity === 0 ? resources.frontierB : resources.frontierA
    if (role === 'dispatchArgumentsA') {
        return parity === 0 ? resources.dispatchArgumentsA : resources.dispatchArgumentsB
    }
    if (role === 'dispatchArgumentsB') {
        return parity === 0 ? resources.dispatchArgumentsB : resources.dispatchArgumentsA
    }
    if (role === 'visibleInstancesB') {
        return parity === 0 ? resources.visibleInstancesB : resources.visibleInstancesA
    }
    if (role === 'drawArgumentsB') {
        return parity === 0 ? resources.drawArgumentsB : resources.drawArgumentsA
    }
    return resources[role]
}

function regionForRole(
    role: ResourceRole,
    parity: 0 | 1,
    resources: GpuTileFrontierResourceGraph,
    gpuState: VirtualRasterGpuState
): BufferRegion {

    const resource = resourceForRole(role, parity, resources, gpuState)
    const artifact = role === 'mapMeta'
        ? gpuTileFrontierLayouts.mapMeta.codec.artifact
        : role === 'policy'
            ? gpuTileFrontierLayouts.policy.codec.artifact
            : role === 'levelMetrics'
                ? gpuTileFrontierLayouts.levelMetric.codec.artifact
                : role === 'frontierA' || role === 'frontierB' || role === 'retirements'
                    ? gpuTileFrontierLayouts.frontierEntry.codec.artifact
                    : role === 'visibleInstancesB'
                        ? gpuTileFrontierLayouts.visibleInstance.codec.artifact
                        : role === 'demands'
                            ? gpuTileFrontierLayouts.demand.codec.artifact
                            : role === 'diagnostics'
                                ? gpuTileFrontierLayouts.diagnostics.codec.artifact
                                : undefined
    return artifact === undefined ? resource.region() : resource.region({ layout: artifact })
}

function validateSeedSnapshot(
    frontier: GpuTileFrontier,
    snapshot: VirtualRasterSnapshot
): readonly Record<string, unknown>[] {

    if (!(snapshot instanceof VirtualRasterSnapshot) ||
        snapshot.addressSpace !== frontier.descriptor.gpuState.addressSpace ||
        frontier.descriptor.gpuState.facts().snapshotEpoch !== snapshot.epoch ||
        !u32(snapshot.epoch)) {
        return invalidFrontier(frontier, 'GPU tile frontier seed requires the acknowledged GPU snapshot.', {
            addressSpaceId: frontier.descriptor.gpuState.addressSpace.id,
            snapshotEpoch: frontier.descriptor.gpuState.facts().snapshotEpoch,
        }, {
            addressSpaceId: snapshot?.addressSpace?.id,
            snapshotEpoch: snapshot?.epoch,
        })
    }
    let physicalPages: ReadonlyMap<number, Readonly<{
        page: { key: string }
        generation: number
        contentEpoch: number
    }>>
    try {
        physicalPages = physicalPagesForSnapshot(snapshot)
    } catch {
        return invalidFrontier(frontier, 'GPU tile frontier seed requires an owned Virtual Raster snapshot.', {
            snapshot: 'VirtualRasterSnapshot with physical ownership facts',
        }, snapshot)
    }
    return Object.freeze(frontier.descriptor.roots.map(root => {
        const resolved = snapshot.resolve(root)
        const physical = resolved.physicalSlot === undefined
            ? undefined
            : physicalPages.get(resolved.physicalSlot)
        if (resolved.status !== 'resident' ||
            resolved.resolvedPage?.key !== root.key ||
            !u32(resolved.physicalSlot) ||
            !u32(resolved.generation) ||
            !u32(resolved.contentEpoch) ||
            physical?.page.key !== root.key ||
            physical.generation !== resolved.generation ||
            physical.contentEpoch !== resolved.contentEpoch ||
            root.tile === undefined ||
            resolved.physicalSlot >= frontier.descriptor.gpuState.maxPhysicalPages) {
            return invalidFrontier(frontier, 'Every GPU tile frontier root must resolve to acknowledged owned content.', {
                root: root.key,
                status: 'resident',
            }, { resolved, physical })
        }
        const matrixLevel = Number(root.tile.matrixId)
        const compactIndex = frontier.descriptor.addressCodec.coverage.index(root.tile)
        if (!u32(matrixLevel) || !u32(root.level) ||
            !u32(root.tile.tileRow) || !u32(root.tile.tileCol) || !u32(compactIndex)) {
            return invalidFrontier(frontier, 'GPU tile frontier roots require numeric u32 matrix ids.', {
                matrixId: 'u32 string',
                rootLevel: 'u32',
                tileCoordinates: 'u32',
                compactIndex: 'u32',
            }, { root, compactIndex })
        }
        return {
            physicalSlot: resolved.physicalSlot,
            expectedGeneration: resolved.generation,
            samplingLevel: root.level,
            matrixLevel,
            tileRow: root.tile.tileRow,
            tileCol: root.tile.tileCol,
            compactIndex,
            previousLodState: 0,
            transitionState: 0,
            lastDemandEpoch: 0,
            childDemandMask: 0,
            residencySnapshotEpoch: snapshot.epoch,
        }
    }))
}

function validateView(frontier: GpuTileFrontier, view: GpuTileFrontierView): void {

    const matrix = view?.clipFromRelativeWorld
    const finite = (values: ArrayLike<number>): boolean =>
        Array.from(values).every(value => Number.isFinite(value))
    const acknowledgedEpoch = frontier.descriptor.gpuState.facts().snapshotEpoch
    if (typeof view !== 'object' || view === null ||
        matrix?.length !== 16 || !finite(matrix) ||
        view.cameraHigh?.length !== 3 || !finite(view.cameraHigh) ||
        view.cameraLow?.length !== 3 || !finite(view.cameraLow) ||
        view.viewport?.length !== 2 || !finite(view.viewport) ||
        view.viewport[0] <= 0 || view.viewport[1] <= 0 ||
        !Number.isFinite(view.verticalFovRadians) ||
        view.verticalFovRadians <= 0 || view.verticalFovRadians >= Math.PI ||
        !Number.isFinite(view.cameraLatitudeRadians) ||
        Math.abs(view.cameraLatitudeRadians) > Math.PI / 2 ||
        !Number.isFinite(view.zoomHint) ||
        !u32(view.frameEpoch) || !u32(view.residencySnapshotEpoch) ||
        view.residencySnapshotEpoch !== acknowledgedEpoch) {
        return invalidFrontier(frontier, 'GPU tile frontier view facts are invalid or stale.', {
            matrixLength: 16,
            cameraTupleLength: 3,
            viewport: 'positive finite pair',
            frameEpoch: 'u32',
            residencySnapshotEpoch: acknowledgedEpoch,
        }, view)
    }
}

function zeroView(): GpuTileFrontierView {

    return {
        clipFromRelativeWorld: new Float32Array(16),
        cameraHigh: [ 0, 0, 0 ],
        cameraLow: [ 0, 0, 0 ],
        viewport: [ 1, 1 ],
        verticalFovRadians: 1,
        cameraLatitudeRadians: 0,
        zoomHint: 0,
        frameEpoch: 0,
        residencySnapshotEpoch: 0,
    }
}

function mapMetaRecord(view: GpuTileFrontierView): Record<string, unknown> {

    const matrix = view.clipFromRelativeWorld
    return {
        clipFromRelativeWorld: [
            [ matrix[0], matrix[1], matrix[2], matrix[3] ],
            [ matrix[4], matrix[5], matrix[6], matrix[7] ],
            [ matrix[8], matrix[9], matrix[10], matrix[11] ],
            [ matrix[12], matrix[13], matrix[14], matrix[15] ],
        ],
        cameraHigh: view.cameraHigh,
        cameraLow: view.cameraLow,
        viewport: view.viewport,
        verticalFovRadians: view.verticalFovRadians,
        cameraLatitudeRadians: view.cameraLatitudeRadians,
        zoomHint: view.zoomHint,
        frameEpoch: view.frameEpoch,
        residencySnapshotEpoch: view.residencySnapshotEpoch,
    }
}

function layoutUpload(bytes: Uint8Array, artifact: Parameters<BufferRegion['interpretAs']>[0]) {

    return Object.freeze({
        bytes,
        byteOffset: bytes.byteOffset,
        byteLength: bytes.byteLength,
        artifact,
    })
}

function uniqueResources(resources: readonly BufferResource[]): BufferResource[] {

    return [ ...new Map(resources.map(resource => [ resource.id, resource ])).values() ]
}

function disposeReverse(disposables: readonly Disposable[]): void {

    for (let index = disposables.length - 1; index >= 0; index--) {
        try {
            disposables[index]!.dispose()
        } catch {
            // Disposal remains best-effort after the first creation/lifecycle failure.
        }
    }
}

function checkedProduct(left: number, right: number): number {

    const result = left * right
    if (!Number.isSafeInteger(result) || result <= 0 || result > U32_MAX) {
        return capacityInvalid('GPU tile frontier byte-size arithmetic exceeded bounded u32 storage.', {
            result: 'positive safe u32',
        }, { left, right, result })
    }
    return result
}

function nextPowerOfTwo(value: number): number {

    let result = 1
    while (result < value) {
        result *= 2
        if (!Number.isSafeInteger(result) || result > 0x8000_0000) {
            return capacityInvalid('GPU tile frontier lookup capacity exceeded bounded power-of-two storage.', {
                lookupCapacity: '<= 2^31',
            }, { requestedCapacity: value })
        }
    }
    return result
}

function ceilDivide(value: number, divisor: number): number {

    return Math.floor((value + divisor - 1) / divisor)
}

function numberLimit(value: number | undefined): number {

    return value === undefined ? Number.MAX_SAFE_INTEGER : Number(value)
}

function u32(value: unknown): value is number {

    return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= U32_MAX
}

function capacityInvalid(message: string, expected: unknown, actual: unknown): never {

    return throwGeoDiagnostic({
        code: 'GEO_GPU_TILE_FRONTIER_CAPACITY_EXCEEDED',
        phase: 'selection',
        subject: { kind: 'gpu-tile-frontier' },
        message,
        expected,
        actual,
    })
}

function descriptorInvalid(message: string, expected: unknown, actual: unknown): never {

    return throwGeoDiagnostic({
        code: 'GEO_GPU_TILE_FRONTIER_INVALID',
        phase: 'selection',
        subject: { kind: 'gpu-tile-frontier' },
        message,
        expected,
        actual,
    })
}

function invalidFrontier(
    frontier: Pick<GpuTileFrontier, 'id'>,
    message: string,
    expected: unknown,
    actual: unknown
): never {

    return throwGeoDiagnostic({
        code: 'GEO_GPU_TILE_FRONTIER_INVALID',
        phase: 'selection',
        subject: { kind: 'gpu-tile-frontier', id: frontier.id },
        message,
        expected,
        actual,
    })
}
