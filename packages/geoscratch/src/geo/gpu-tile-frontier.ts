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
    type SubmissionAuthority,
    type SubmissionAuthorityStamp,
    type SubmissionBuilder,
    type UploadCommand,
} from '../scratch/index.js'
import {
    appendSubmissionBuilderOpaqueSteps,
    submissionBuilderOpaqueSequenceMatches,
    type SubmissionBuilderOpaqueSequence,
} from '../scratch/gpu/submission.js'
import { throwGeoDiagnostic } from './diagnostics.js'
import {
    compareGpuTileFrontierPathOrder,
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
import {
    VirtualRasterGpuState,
    virtualRasterResidencySubmissionStamp,
} from './virtual-raster-gpu.js'
import {
    VirtualRasterSnapshot,
    physicalPagesForSnapshot,
} from './virtual-raster.js'

const BUFFER_COPY_DST = 0x08
const BUFFER_COPY_SRC = 0x04
const BUFFER_UNIFORM = 0x40
const BUFFER_STORAGE = 0x80
const BUFFER_INDIRECT = 0x100
const U32_MAX = 0xffff_ffff
const DISPATCH_ARGUMENT_BYTES = 12
const DRAW_ARGUMENT_BYTES = 16
const LOOKUP_WORDS = 4
const DECISION_WORDS = 18
const PREFIX_WORDS = 8
const COUNTER_WORDS = 32
const SLOT_TABLE_WORDS = 12

let nextFrontierId = 1

type GpuTileFrontierResourceGraph = Readonly<{
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
    feedbackOutput: BufferResource
    drawArgumentsA: BufferResource
    drawArgumentsB: BufferResource
}>

export type GpuTileFrontierFeedbackSection = Readonly<{
    bufferId: string
    offset: number
    byteLength: number
    capacity: number
}>

export type GpuTileFrontierFeedbackLayout = Readonly<{
    byteLength: number
    demands: GpuTileFrontierFeedbackSection
    retirements: GpuTileFrontierFeedbackSection
    counters: GpuTileFrontierFeedbackSection
    diagnostics: GpuTileFrontierFeedbackSection
}>

export type GpuTileFrontierFeedbackOutput = Readonly<{
    bufferId: string
    layout: GpuTileFrontierFeedbackLayout
}>

export type GpuTileFrontierFrame = Readonly<{
    kind: 'gpu-tile-frontier-frame'
    frontierId: string
    frameEpoch: number
    parity: 0 | 1
    source: 'A' | 'B'
    target: 'A' | 'B'
    visibleInstances: BufferResource
    feedbackOutput: GpuTileFrontierFeedbackOutput
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

export type GpuTileFrontierRenderTemplate = Readonly<{
    frontierId: string
    parity: 0 | 1
    source: 'A' | 'B'
    target: 'A' | 'B'
    templateId: string
    mapMeta: BufferResource
    visibleInstances: BufferResource
    drawArgument: Readonly<{
        resource: BufferResource
        region: BufferRegion
        offset: number
        size: 16
    }>
}>

export type GpuTileFrontierSeed = Readonly<{
    snapshot: VirtualRasterSnapshot
    snapshotEpoch: number
    clears: readonly ClearBufferCommand[]
    uploads: readonly UploadCommand[]
    commands: readonly (ClearBufferCommand | UploadCommand)[]
}>

export type GpuTileFrontierViewToken = Readonly<{
    kind: 'gpu-tile-frontier-view-token'
    frontierId: string
    frameEpoch: number
    residencySnapshotEpoch: number
    readonly isDisposed: boolean
    dispose(): void
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
    bufferBytes: Readonly<Record<keyof GpuTileFrontierResourceGraph, number>>
    feedbackOutput: GpuTileFrontierFeedbackOutput
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
    feedbackResource: BufferResource
    drawRegions: ReadonlyMap<string, BufferRegion>
    feedbackOutput: GpuTileFrontierFeedbackOutput
}>

type CreationState = Readonly<{
    resources: GpuTileFrontierResourceGraph
    pass: ComputePassSpec
    parityTemplates: readonly [ParityTemplate, ParityTemplate]
    owned: readonly Disposable[]
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
    view: ViewTokenRecord
    pass: ComputePassSpec
    residencySnapshotEpoch: number
}>

const frameRecords = new WeakMap<GpuTileFrontierFrame, FrameRecord>()
const encodedBuilderRecords = new WeakMap<SubmissionBuilder, Readonly<{
    owner: GpuTileFrontier
    frame: GpuTileFrontierFrame
    sequence: SubmissionBuilderOpaqueSequence
}>>()

type ViewTokenRecord = {
    owner: GpuTileFrontier
    acknowledgementSerial: number
    command: UploadCommand
    viewStamp: SubmissionAuthorityStamp
    residencyStamp: SubmissionAuthorityStamp
    sequenceStamp: SubmissionAuthorityStamp
    disposed: boolean
}

const viewTokenRecords = new WeakMap<GpuTileFrontierViewToken, ViewTokenRecord>()

type FeedbackOwner = Disposable

type FrontierFeedbackRecord = {
    gpuState: VirtualRasterGpuState
    feedbackResource: BufferResource
    feedbackOutput: GpuTileFrontierFeedbackOutput
    sequenceAuthority: SubmissionAuthority
    owners: Set<FeedbackOwner>
    disposed: boolean
}

const frontierFeedbackRecords = new WeakMap<GpuTileFrontier, FrontierFeedbackRecord>()

export class GpuTileFrontier {

    readonly runtime: GPURuntime
    readonly id: string
    readonly #descriptor: GpuTileFrontierDescriptor
    readonly #resources: GpuTileFrontierResourceGraph
    readonly #pass: ComputePassSpec
    readonly #parityTemplates: readonly [ParityTemplate, ParityTemplate]
    readonly #owned: readonly Disposable[]
    readonly #seedFrontierBytes: Uint8Array
    readonly #seedDispatchWords: Uint32Array
    readonly #seedCounterWords: Uint32Array
    readonly #seedClears: readonly ClearBufferCommand[]
    readonly #seedUploads: readonly UploadCommand[]
    readonly #lookupCapacity: number
    readonly #scanBlockCount: number
    readonly #viewAuthority: SubmissionAuthority
    readonly #frontierSequenceAuthority: SubmissionAuthority
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
        this.#descriptor = descriptor
        this.#resources = state.resources
        this.#pass = state.pass
        this.#parityTemplates = state.parityTemplates
        this.#owned = state.owned
        this.#seedFrontierBytes = state.seedFrontierBytes
        this.#seedDispatchWords = state.seedDispatchWords
        this.#seedCounterWords = state.seedCounterWords
        this.#seedClears = state.seedClears
        this.#seedUploads = state.seedUploads
        this.#lookupCapacity = state.capacities.lookupEntries
        this.#scanBlockCount = state.capacities.scanBlocks
        this.#viewAuthority = runtime.createSubmissionAuthority({
            label: `${this.id} view`,
        })
        this.#frontierSequenceAuthority = runtime.createSubmissionAuthority({
            label: `${this.id} frontier sequence`,
        })
        frontierFeedbackRecords.set(this, {
            gpuState: descriptor.gpuState,
            feedbackResource: state.resources.feedbackOutput,
            feedbackOutput: state.parityTemplates[0].feedbackOutput,
            sequenceAuthority: this.#frontierSequenceAuthority,
            owners: new Set(),
            disposed: false,
        })
        Object.preventExtensions(this)
    }

    get descriptor(): GpuTileFrontierDescriptor {

        return this.#descriptor
    }

    static async create(
        runtime: GPURuntime,
        descriptor: GpuTileFrontierDescriptor
    ): Promise<GpuTileFrontier> {

        const stableDescriptor = snapshotDescriptor(descriptor)
        const bounds = validateCreation(runtime, stableDescriptor)
        const wgsl = createGpuTileFrontierWgsl(
            stableDescriptor,
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
            const feedbackOutput = createFeedbackOutput(resources.feedbackOutput, bounds.feedbackLayout)
            const policyUpload = own(runtime.createUploadCommand({
                label: 'Upload GPU tile frontier policy',
                target: resources.policy.region({
                    layout: gpuTileFrontierLayouts.policy.codec.artifact,
                }),
                data: gpuTileFrontierLayouts.policy.codec.uploadView(stableDescriptor.policy),
            }))
            const levelMetricsUpload = own(runtime.createUploadCommand({
                label: 'Upload GPU tile frontier level metrics',
                target: resources.levelMetrics.region({
                    layout: gpuTileFrontierLayouts.levelMetric.codec.artifact,
                }),
                data: gpuTileFrontierLayouts.levelMetric.codec.uploadView(stableDescriptor.levelMetrics),
            }))
            const seedFrontierBytes = new Uint8Array(
                stableDescriptor.roots.length * gpuTileFrontierLayouts.frontierEntry.byteSize
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
                target: feedbackSectionRegion(
                    resources.feedbackOutput,
                    bounds.feedbackLayout.counters
                ),
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
                resources.feedbackOutput,
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
                stableDescriptor.gpuState,
                bounds,
                own
            )
            const parityTemplates = createParityTemplates(
                stableDescriptor.drawTemplates,
                resources,
                feedbackOutput,
                kernels
            )
            return new GpuTileFrontier(runtime, stableDescriptor, {
                resources,
                pass,
                parityTemplates,
                owned: Object.freeze([ ...owned ]),
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

    writeView(view: GpuTileFrontierView): GpuTileFrontierViewToken {

        this.#assertActive()
        validateView(this, view)
        const authority = this.descriptor.gpuState.facts()
        const uploadView = gpuTileFrontierMapMetaCodec.uploadView(mapMetaRecord(
            this.descriptor,
            view
        ))
        const command = this.runtime.createUploadCommand({
            label: `Upload GPU tile frontier view ${view.frameEpoch}`,
            target: this.#resources.mapMeta.region({
                layout: gpuTileFrontierLayouts.mapMeta.codec.artifact,
            }),
            data: uploadView,
        })
        let viewStamp: SubmissionAuthorityStamp
        let residencyStamp: SubmissionAuthorityStamp
        let sequenceStamp: SubmissionAuthorityStamp
        try {
            residencyStamp = virtualRasterResidencySubmissionStamp(this.descriptor.gpuState)
            sequenceStamp = this.#frontierSequenceAuthority.stamp()
            viewStamp = this.#viewAuthority.advance()
        } catch (error) {
            command.dispose()
            throw error
        }
        const record: ViewTokenRecord = {
            owner: this,
            acknowledgementSerial: authority.acknowledgementSerial,
            command,
            viewStamp,
            residencyStamp,
            sequenceStamp,
            disposed: false,
        }
        const token = Object.freeze({
            kind: 'gpu-tile-frontier-view-token' as const,
            frontierId: this.id,
            frameEpoch: view.frameEpoch,
            residencySnapshotEpoch: view.residencySnapshotEpoch,
            get isDisposed() { return record.disposed },
            dispose() {
                if (record.disposed) return
                record.disposed = true
                command.dispose()
            },
        })
        viewTokenRecords.set(token, record)
        this.#lastViewFrameEpoch = view.frameEpoch
        return token
    }

    frame(viewToken: GpuTileFrontierViewToken): GpuTileFrontierFrame {

        this.#assertActive()
        const record = viewTokenRecords.get(viewToken)
        const authority = this.descriptor.gpuState.facts()
        if (record?.owner !== this || record.disposed || record.command.isDisposed ||
            viewToken.frontierId !== this.id ||
            viewToken.residencySnapshotEpoch !== authority.snapshotEpoch ||
            record.acknowledgementSerial !== authority.acknowledgementSerial ||
            record.viewStamp.revision !== this.#viewAuthority.revision ||
            record.sequenceStamp.revision !== this.#frontierSequenceAuthority.revision) {
            return invalidFrontier(this, 'GPU tile frontier frame requires a live owned view from current residency authority.', {
                frontierId: this.id,
                residencySnapshotEpoch: authority.snapshotEpoch,
                acknowledgementSerial: authority.acknowledgementSerial,
            }, {
                frontierId: viewToken?.frontierId,
                residencySnapshotEpoch: viewToken?.residencySnapshotEpoch,
                acknowledgementSerial: record?.acknowledgementSerial,
                viewRevision: record?.viewStamp.revision,
                currentViewRevision: this.#viewAuthority.revision,
                sequenceRevision: record?.sequenceStamp.revision,
                currentSequenceRevision: this.#frontierSequenceAuthority.revision,
                disposed: record?.disposed ?? record?.command?.isDisposed,
            })
        }
        const frameEpoch = viewToken.frameEpoch
        const template = this.#parityTemplates[record.sequenceStamp.revision & 1]!
        const frame = Object.freeze({
            kind: 'gpu-tile-frontier-frame' as const,
            frontierId: this.id,
            frameEpoch,
            parity: template.parity,
            source: template.source,
            target: template.target,
            visibleInstances: template.visibleInstances,
            feedbackOutput: template.feedbackOutput,
        })
        frameRecords.set(frame, Object.freeze({
            owner: this,
            template,
            view: record,
            pass: this.#pass,
            residencySnapshotEpoch: viewToken.residencySnapshotEpoch,
        }))
        return frame
    }

    encode(builder: SubmissionBuilder, frame: GpuTileFrontierFrame): SubmissionBuilder {

        this.#assertActive()
        const record = frameRecords.get(frame)
        const authority = this.descriptor.gpuState.facts()
        if (builder?.runtime !== this.runtime || builder.isSubmitted ||
            encodedBuilderRecords.has(builder) || record?.owner !== this ||
            frame.frontierId !== this.id || record.view.disposed ||
            record.view.command.isDisposed ||
            record.view.acknowledgementSerial !== authority.acknowledgementSerial ||
            record.view.viewStamp.revision !== this.#viewAuthority.revision ||
            record.view.sequenceStamp.revision !== this.#frontierSequenceAuthority.revision) {
            return invalidFrontier(this, 'GPU tile frontier encoding requires a current owned frame and builder.', {
                frontierId: this.id,
                runtimeId: this.runtime.id,
                acknowledgementSerial: authority.acknowledgementSerial,
                viewRevision: this.#viewAuthority.revision,
                sequenceRevision: this.#frontierSequenceAuthority.revision,
            }, {
                frontierId: frame?.frontierId,
                runtimeId: builder?.runtime?.id,
                acknowledgementSerial: record?.view.acknowledgementSerial,
                viewRevision: record?.view.viewStamp.revision,
                sequenceRevision: record?.view.sequenceStamp.revision,
                disposed: record?.view.disposed ?? record?.view.command.isDisposed,
                submitted: builder?.isSubmitted,
                alreadyEncoded: builder === undefined
                    ? false
                    : encodedBuilderRecords.has(builder),
            })
        }
        builder
            .require(record.view.residencyStamp)
            .require(record.view.viewStamp)
        const sequence = appendSubmissionBuilderOpaqueSteps(builder, [
            {
                label: 'GPU tile frontier view upload',
                step: { kind: 'upload', command: record.view.command },
            },
            {
                label: 'GPU tile frontier compute',
                step: {
                    kind: 'compute',
                    passSpec: this.#pass,
                    commands: [ ...record.template.commands ],
                },
            },
        ])
        builder.consume(record.view.sequenceStamp)
        encodedBuilderRecords.set(builder, Object.freeze({ owner: this, frame, sequence }))
        return builder
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

    renderTemplates(id: string): readonly [
        GpuTileFrontierRenderTemplate,
        GpuTileFrontierRenderTemplate,
    ] {

        this.#assertActive()
        const templateIndex = this.descriptor.drawTemplates.findIndex(template => template.id === id)
        if (templateIndex < 0) {
            return invalidFrontier(this, 'GPU tile frontier render template id is not declared.', {
                templateIds: this.descriptor.drawTemplates.map(template => template.id),
            }, { templateId: id })
        }
        return Object.freeze(this.#parityTemplates.map(template => {
            const region = template.drawRegions.get(id)!
            return Object.freeze({
                frontierId: this.id,
                parity: template.parity,
                source: template.source,
                target: template.target,
                templateId: id,
                mapMeta: this.#resources.mapMeta,
                visibleInstances: template.visibleInstances,
                drawArgument: Object.freeze({
                    resource: template.drawArguments,
                    region,
                    offset: templateIndex * DRAW_ARGUMENT_BYTES,
                    size: DRAW_ARGUMENT_BYTES as 16,
                }),
            })
        }) as [GpuTileFrontierRenderTemplate, GpuTileFrontierRenderTemplate])
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
            bufferBytes: Readonly<Record<keyof GpuTileFrontierResourceGraph, number>>
            feedbackOutput: GpuTileFrontierFeedbackOutput
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
            bufferBytes: Object.freeze(Object.fromEntries(
                Object.entries(this.#resources).map(([ name, resource ]) => [ name, resource.size ])
            ) as Record<keyof GpuTileFrontierResourceGraph, number>),
            feedbackOutput: this.#parityTemplates[0].feedbackOutput,
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
        const feedback = frontierFeedbackRecords.get(this)
        if (feedback !== undefined) {
            feedback.disposed = true
            for (const owner of [ ...feedback.owners ]) owner.dispose()
            feedback.owners.clear()
        }
        this.#viewAuthority.dispose()
        this.#frontierSequenceAuthority.dispose()
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

Object.freeze(GpuTileFrontier.prototype)

export type GpuTileFrontierFeedbackAccess = Readonly<{
    gpuState: VirtualRasterGpuState
    resource: BufferResource
    region: BufferRegion
    output: GpuTileFrontierFeedbackOutput
    sequenceRevision: number
}>

/** @internal Package-owned feedback capability; not exported by geo/index. */
export function gpuTileFrontierFeedbackAccess(
    frontier: GpuTileFrontier
): GpuTileFrontierFeedbackAccess {

    const record = frontierFeedbackRecords.get(frontier)
    if (record === undefined || record.disposed) {
        return invalidFrontier(frontier, 'GPU tile frontier feedback requires an active frontier.', {
            frontier: 'active GpuTileFrontier',
        }, { frontierId: frontier?.id, disposed: record?.disposed })
    }
    return Object.freeze({
        gpuState: record.gpuState,
        resource: record.feedbackResource,
        region: record.feedbackResource.region(),
        output: record.feedbackOutput,
        sequenceRevision: record.sequenceAuthority.revision,
    })
}

export type GpuTileFrontierFeedbackFrameAccess = Readonly<{
    pass: ComputePassSpec
    commands: readonly DispatchCommand[]
    viewCommand: UploadCommand
    sequenceRevision: number
    residencySnapshotEpoch: number
}>

/** @internal Package-owned frame provenance for bounded feedback scheduling. */
export function gpuTileFrontierFeedbackFrameAccess(
    frontier: GpuTileFrontier,
    frame: GpuTileFrontierFrame
): GpuTileFrontierFeedbackFrameAccess {

    gpuTileFrontierFeedbackAccess(frontier)
    const record = frameRecords.get(frame)
    if (record?.owner !== frontier || frame.frontierId !== frontier.id) {
        return invalidFrontier(frontier, 'GPU tile frontier feedback requires an owned frame.', {
            frontierId: frontier.id,
        }, { frontierId: frame?.frontierId })
    }
    return Object.freeze({
        pass: record.pass,
        commands: record.template.commands,
        viewCommand: record.view.command,
        sequenceRevision: record.view.sequenceStamp.revision,
        residencySnapshotEpoch: record.residencySnapshotEpoch,
    })
}

/** @internal Reports whether the exact frontier frame encoded this builder once. */
export function gpuTileFrontierFeedbackEncodingMatches(
    frontier: GpuTileFrontier,
    builder: SubmissionBuilder,
    frame: GpuTileFrontierFrame
): boolean {

    const record = encodedBuilderRecords.get(builder)
    return record?.owner === frontier && record.frame === frame &&
        submissionBuilderOpaqueSequenceMatches(builder, record.sequence)
}

/** @internal Registers a bounded frontier-owned feedback lifecycle. */
export function registerGpuTileFrontierFeedbackOwner(
    frontier: GpuTileFrontier,
    owner: FeedbackOwner
): void {

    const record = frontierFeedbackRecords.get(frontier)
    if (record === undefined || record.disposed) {
        return invalidFrontier(frontier, 'GPU tile frontier feedback owner requires an active frontier.', {
            frontier: 'active GpuTileFrontier',
        }, { frontierId: frontier?.id, disposed: record?.disposed })
    }
    record.owners.add(owner)
}

/** @internal Releases a frontier-owned feedback lifecycle registration. */
export function unregisterGpuTileFrontierFeedbackOwner(
    frontier: GpuTileFrontier,
    owner: FeedbackOwner
): void {

    frontierFeedbackRecords.get(frontier)?.owners.delete(owner)
}

export type GpuTileFrontierTestFrameAccess = Readonly<{
    pass: ComputePassSpec
    commands: readonly DispatchCommand[]
    viewCommand: UploadCommand
    mapMeta: BufferResource
    currentFrontier: BufferResource
    nextFrontier: BufferResource
    currentDispatchArguments: BufferResource
    nextDispatchArguments: BufferResource
    visibleInstances: BufferResource
    feedbackOutput: BufferResource
    drawArguments: BufferResource
}>

/** @internal Test-only explicit Scratch capability recovery; not exported by geo/index. */
export function gpuTileFrontierTestFrameAccess(
    frontier: GpuTileFrontier,
    frame: GpuTileFrontierFrame
): GpuTileFrontierTestFrameAccess {

    const record = frameRecords.get(frame)
    if (record?.owner !== frontier || frame.frontierId !== frontier.id) {
        return invalidFrontier(frontier, 'GPU tile frontier test access requires an owned frame.', {
            frontierId: frontier.id,
        }, { frontierId: frame?.frontierId })
    }
    const template = record.template
    return Object.freeze({
        pass: record.pass,
        commands: template.commands,
        viewCommand: record.view.command,
        mapMeta: record.view.command.target.buffer,
        currentFrontier: template.currentFrontier,
        nextFrontier: template.nextFrontier,
        currentDispatchArguments: template.currentDispatchArguments,
        nextDispatchArguments: template.nextDispatchArguments,
        visibleInstances: template.visibleInstances,
        feedbackOutput: template.feedbackResource,
        drawArguments: template.drawArguments,
    })
}

type CreationBounds = Readonly<{
    lookupCapacity: number
    scanBlockCount: number
    bufferBytes: Readonly<Record<keyof GpuTileFrontierResourceGraph, number>>
    feedbackLayout: PackedFeedbackLayout
}>

type PackedFeedbackSection = Readonly<{
    offset: number
    byteLength: number
    capacity: number
}>

type PackedFeedbackLayout = Readonly<{
    byteLength: number
    demands: PackedFeedbackSection
    retirements: PackedFeedbackSection
    counters: PackedFeedbackSection
    diagnostics: PackedFeedbackSection
}>

function snapshotDescriptor(
    descriptor: GpuTileFrontierDescriptor
): GpuTileFrontierDescriptor {

    validateGpuTileFrontierDescriptor(descriptor)
    return Object.freeze({
        gpuState: descriptor.gpuState,
        addressCodec: descriptor.addressCodec,
        policy: Object.freeze({ ...descriptor.policy }),
        levelMetrics: Object.freeze(descriptor.levelMetrics.map(metric =>
            Object.freeze({ ...metric })
        )),
        roots: Object.freeze([ ...descriptor.roots ].sort(
            compareGpuTileFrontierPathOrder
        )),
        drawTemplates: Object.freeze(descriptor.drawTemplates.map(template =>
            Object.freeze({ ...template })
        )),
    })
}

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
    if (runtime.isDisposed || descriptor.gpuState.slotTable.isDisposed ||
        descriptor.gpuState.pageTable.isDisposed) {
        return capacityInvalid('GPU tile frontier requires active caller-owned GPU objects.', {
            runtimeDisposed: false,
            slotTableDisposed: false,
            pageTableDisposed: false,
        }, {
            runtimeDisposed: runtime.isDisposed,
            slotTableDisposed: descriptor.gpuState.slotTable.isDisposed,
            pageTableDisposed: descriptor.gpuState.pageTable.isDisposed,
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
    const maximumStorageBytes = numberLimit(runtime.deviceLimits.maxStorageBufferBindingSize)
    if (descriptor.gpuState.slotTable.size > maximumStorageBytes) {
        return capacityInvalid('GPU tile frontier borrowed slot table exceeds the device storage binding limit.', {
            maxStorageBufferBindingSize: maximumStorageBytes,
        }, { slotTableBytes: descriptor.gpuState.slotTable.size })
    }
    if (descriptor.gpuState.pageTable.size > maximumStorageBytes) {
        return capacityInvalid('GPU tile frontier borrowed page table exceeds the device storage binding limit.', {
            maxStorageBufferBindingSize: maximumStorageBytes,
        }, { pageTableBytes: descriptor.gpuState.pageTable.size })
    }
    const lookupCapacity = nextPowerOfTwo(checkedProduct(active, 2))
    const scanBlockCount = ceilDivide(active, GPU_TILE_FRONTIER_SCAN_BLOCK_SIZE)
    const entryBytes = gpuTileFrontierLayouts.frontierEntry.byteSize
    const visibleBytes = gpuTileFrontierLayouts.visibleInstance.byteSize
    const demandBytes = gpuTileFrontierLayouts.demand.byteSize
    const feedbackLayout = createPackedFeedbackLayout(runtime, descriptor, entryBytes, demandBytes)
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
        feedbackOutput: feedbackLayout.byteLength,
        drawArgumentsA: checkedProduct(descriptor.drawTemplates.length, DRAW_ARGUMENT_BYTES),
        drawArgumentsB: checkedProduct(descriptor.drawTemplates.length, DRAW_ARGUMENT_BYTES),
    }
    validateDeviceBounds(
        runtime,
        bufferBytes,
        feedbackLayout,
        lookupCapacity,
        scanBlockCount,
        active
    )
    return Object.freeze({
        lookupCapacity,
        scanBlockCount,
        bufferBytes: Object.freeze(bufferBytes),
        feedbackLayout,
    })
}

function createPackedFeedbackLayout(
    runtime: GPURuntime,
    descriptor: GpuTileFrontierDescriptor,
    entryBytes: number,
    demandBytes: number
): PackedFeedbackLayout {

    const alignment = Math.max(
        4,
        numberLimit(runtime.deviceLimits.minStorageBufferOffsetAlignment)
    )
    const demands = packedSection(
        0,
        checkedProduct(descriptor.policy.maximumDemands, demandBytes),
        descriptor.policy.maximumDemands
    )
    const retirements = packedSection(
        alignTo(demands.offset + demands.byteLength, alignment),
        checkedProduct(descriptor.policy.maximumActiveTiles, entryBytes),
        descriptor.policy.maximumActiveTiles
    )
    const counters = packedSection(
        alignTo(retirements.offset + retirements.byteLength, alignment),
        COUNTER_WORDS * 4,
        COUNTER_WORDS
    )
    const diagnostics = packedSection(
        alignTo(counters.offset + counters.byteLength, alignment),
        gpuTileFrontierLayouts.diagnostics.byteSize,
        1
    )
    return Object.freeze({
        byteLength: alignTo(diagnostics.offset + diagnostics.byteLength, 4),
        demands,
        retirements,
        counters,
        diagnostics,
    })
}

function packedSection(
    offset: number,
    byteLength: number,
    capacity: number
): PackedFeedbackSection {

    return Object.freeze({ offset, byteLength, capacity })
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
    feedbackLayout: PackedFeedbackLayout,
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
            : role === 'feedbackOutput'
                ? maximumBufferBytes
                : maximumStorageBytes
        if (byteLength <= maximumBufferBytes && byteLength <= bindingMaximum) continue
        return capacityInvalid('GPU tile frontier buffer exceeds a device binding limit.', {
            maximumBufferBytes,
            bindingMaximum,
        }, { role, byteLength })
    }
    for (const [ role, section ] of Object.entries(feedbackLayout)) {
        if (role === 'byteLength' || typeof section === 'number' ||
            section.byteLength <= maximumStorageBytes) continue
        return capacityInvalid('GPU tile frontier feedback section exceeds a device storage binding limit.', {
            maxStorageBufferBindingSize: maximumStorageBytes,
        }, { role, byteLength: section.byteLength })
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
        feedbackOutput: await create(
            'feedbackOutput',
            BUFFER_STORAGE | BUFFER_COPY_SRC
        ),
        drawArgumentsA: await create('drawArgumentsA', BUFFER_STORAGE | BUFFER_INDIRECT),
        drawArgumentsB: await create('drawArgumentsB', BUFFER_STORAGE | BUFFER_INDIRECT),
    })
}

type ResourceRole = keyof GpuTileFrontierResourceGraph |
    'slotTable' |
    'pageTable' |
    'demands' |
    'retirements' |
    'counters' |
    'diagnostics'
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
                minBindingSize: regionForRole(
                    binding.role,
                    0,
                    resources,
                    gpuState,
                    bounds.feedbackLayout
                ).size,
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
            bounds.feedbackLayout,
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
            bounds.feedbackLayout,
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
    feedbackLayout: PackedFeedbackLayout,
    own: <Value extends Disposable>(value: Value) => Value
): Promise<DispatchCommand> {

    const bound = Object.fromEntries(definition.bindings.map(binding => [
        binding.name,
        regionForRole(binding.role, parity, resources, gpuState, feedbackLayout),
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
    const pages = binding('pageTable', 'read-storage', 'pageTable')
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
        { entryPoint: 'evaluateFrontier', label: 'Evaluate GPU tile frontier', bindings: [ map, policy, metrics, current, slots, pages, visibility, decisionWrite, countersWrite ], count: 'indirect' },
        { entryPoint: 'selectBudgets', label: 'Select GPU tile frontier budgets', bindings: [ map, policy, metrics, current, slots, lookupRead, decisionWrite, countersWrite ], count: [ 1, 1, 1 ] },
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
    feedbackOutput: GpuTileFrontierFeedbackOutput,
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
            feedbackResource: resources.feedbackOutput,
            feedbackOutput,
            drawRegions: new Map(drawTemplates.map((template, index) => [
                template.id,
                drawArguments.region({ offset: index * DRAW_ARGUMENT_BYTES, size: DRAW_ARGUMENT_BYTES }),
            ])),
        })
    }
    return Object.freeze([ create(0), create(1) ])
}

function createFeedbackOutput(
    resource: BufferResource,
    packed: PackedFeedbackLayout
): GpuTileFrontierFeedbackOutput {

    const section = (value: PackedFeedbackSection): GpuTileFrontierFeedbackSection =>
        Object.freeze({
            bufferId: resource.id,
            offset: value.offset,
            byteLength: value.byteLength,
            capacity: value.capacity,
        })
    return Object.freeze({
        bufferId: resource.id,
        layout: Object.freeze({
            byteLength: packed.byteLength,
            demands: section(packed.demands),
            retirements: section(packed.retirements),
            counters: section(packed.counters),
            diagnostics: section(packed.diagnostics),
        }),
    })
}

function feedbackSectionRegion(
    resource: BufferResource,
    section: PackedFeedbackSection,
    artifact?: Parameters<BufferRegion['interpretAs']>[0]
): BufferRegion {

    return artifact === undefined
        ? resource.region({ offset: section.offset, size: section.byteLength })
        : resource.region({
            offset: section.offset,
            size: section.byteLength,
            layout: artifact,
        })
}

function resourceForRole(
    role: ResourceRole,
    parity: 0 | 1,
    resources: GpuTileFrontierResourceGraph,
    gpuState: VirtualRasterGpuState
): BufferResource {

    if (role === 'slotTable') return gpuState.slotTable
    if (role === 'pageTable') return gpuState.pageTable
    if (role === 'demands' || role === 'retirements' ||
        role === 'counters' || role === 'diagnostics') return resources.feedbackOutput
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
    gpuState: VirtualRasterGpuState,
    feedbackLayout: PackedFeedbackLayout
): BufferRegion {

    const resource = resourceForRole(role, parity, resources, gpuState)
    if (role === 'demands') {
        return feedbackSectionRegion(
            resource,
            feedbackLayout.demands,
            gpuTileFrontierLayouts.demand.codec.artifact
        )
    }
    if (role === 'retirements') {
        return feedbackSectionRegion(
            resource,
            feedbackLayout.retirements,
            gpuTileFrontierLayouts.frontierEntry.codec.artifact
        )
    }
    if (role === 'counters') {
        return feedbackSectionRegion(resource, feedbackLayout.counters)
    }
    if (role === 'diagnostics') {
        return feedbackSectionRegion(
            resource,
            feedbackLayout.diagnostics,
            gpuTileFrontierLayouts.diagnostics.codec.artifact
        )
    }
    const artifact = role === 'mapMeta'
        ? gpuTileFrontierLayouts.mapMeta.codec.artifact
        : role === 'policy'
            ? gpuTileFrontierLayouts.policy.codec.artifact
            : role === 'levelMetrics'
                ? gpuTileFrontierLayouts.levelMetric.codec.artifact
                : role === 'frontierA' || role === 'frontierB'
                    ? gpuTileFrontierLayouts.frontierEntry.codec.artifact
                    : role === 'visibleInstancesB'
                        ? gpuTileFrontierLayouts.visibleInstance.codec.artifact
                    : undefined
    return artifact === undefined ? resource.region() : resource.region({ layout: artifact })
}

function validateSeedSnapshot(
    frontier: GpuTileFrontier,
    snapshot: VirtualRasterSnapshot
): readonly Record<string, unknown>[] {

    if (!(snapshot instanceof VirtualRasterSnapshot) ||
        snapshot.addressSpace !== frontier.descriptor.gpuState.addressSpace ||
        !frontier.descriptor.gpuState.acknowledges(snapshot) ||
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
            expectedContentEpoch: resolved.contentEpoch,
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

function mapMetaRecord(
    descriptor: GpuTileFrontierDescriptor,
    view: GpuTileFrontierView
): Record<string, unknown> {

    const matrix = view.clipFromRelativeWorld
    const camera = descriptor.addressCodec.fromProjected([
        view.cameraHigh[0] + view.cameraLow[0],
        view.cameraHigh[1] + view.cameraLow[1],
    ]).fixed.limbs
    return {
        clipFromRelativeWorld: [
            [ matrix[0], matrix[1], matrix[2], matrix[3] ],
            [ matrix[4], matrix[5], matrix[6], matrix[7] ],
            [ matrix[8], matrix[9], matrix[10], matrix[11] ],
            [ matrix[12], matrix[13], matrix[14], matrix[15] ],
        ],
        cameraHigh: view.cameraHigh,
        cameraLow: view.cameraLow,
        cameraFixedLow: [ camera[0]!.low, camera[1]!.low ],
        cameraFixedHigh: [ camera[0]!.high, camera[1]!.high ],
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

function alignTo(value: number, alignment: number): number {

    if (!Number.isSafeInteger(value) || value < 0 ||
        !Number.isSafeInteger(alignment) || alignment <= 0) {
        return capacityInvalid('GPU tile frontier feedback alignment requires bounded integers.', {
            value: 'non-negative safe integer',
            alignment: 'positive safe integer',
        }, { value, alignment })
    }
    const result = Math.ceil(value / alignment) * alignment
    if (!Number.isSafeInteger(result) || result > U32_MAX) {
        return capacityInvalid('GPU tile frontier feedback alignment exceeded bounded u32 storage.', {
            result: 'u32',
        }, { value, alignment, result })
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
