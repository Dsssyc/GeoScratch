import {
    type BindLayout,
    type BindLayoutEntry,
    type BindSet,
    type BufferResource,
    type ClearBufferCommand,
    type ComputePassSpec,
    type ComputePipeline,
    type DispatchCommand,
    type GPURuntime,
    type Program,
    type ReadbackCommand,
    type SubmissionBuilder,
    type SubmittedWork,
    type UploadCommand,
} from '../scratch/index.js'
import { throwGeoDiagnostic } from './diagnostics.js'
import {
    gpuWebMercatorQuadCoverPatchCodec,
    gpuWebMercatorQuadCoverSharedWgslModule,
    gpuWebMercatorQuadCoverStateCodec,
} from './gpu-web-mercator-quad-cover-layout.js'
import {
    assertGpuWebMercatorQuadCoverFrameEncoded,
    type GpuWebMercatorQuadCover,
    type GpuWebMercatorQuadCoverFrame,
} from './gpu-web-mercator-quad-cover.js'
import {
    gpuWebMercatorQuadDemandCodec,
    gpuWebMercatorQuadDemandLimitCodec,
    gpuWebMercatorQuadDemandPolicyCodec,
    gpuWebMercatorQuadDemandStateCodec,
} from './gpu-web-mercator-quad-demand-layout.js'
import { GPU_WEB_MERCATOR_QUAD_DEMAND_WGSL } from './gpu-web-mercator-quad-demand-wgsl.js'
import type { TileMatrixCoverage } from './tile-matrix.js'
import { WebMercatorQuad } from './web-mercator-quad.js'

const BUFFER_COPY_DST = 0x08
const BUFFER_COPY_SRC = 0x04
const BUFFER_UNIFORM = 0x40
const BUFFER_STORAGE = 0x80

type Disposable = { dispose(): void }
type BufferBindingType = 'uniform' | 'read-storage' | 'storage'

export type GpuWebMercatorQuadProjectedDemand = Readonly<{
    desiredSampleLevel: number
    sourceLevelCeiling: number
    requestMatrixLevel: number
    tileRow: number
    tileCol: number
    priority: number
    decisionFrameEpoch: number
    residencySnapshotEpoch: number
}>

export type GpuWebMercatorQuadDemandProjectionDescriptor = Readonly<{
    cover: GpuWebMercatorQuadCover
    sourceCoverage: TileMatrixCoverage
    maximumDemands: number
}>

export type GpuWebMercatorQuadDemandProjectionFrame = Readonly<{
    kind: 'gpu-web-mercator-quad-demand-projection-frame'
    projectionId: string
    coverId: string
    frameEpoch: number
    residencySnapshotEpoch: number
    parity: 0 | 1
}>

export type GpuWebMercatorQuadDemandProjectionFeedback = Readonly<{
    kind: 'gpu-web-mercator-quad-demand-projection-feedback'
    projectionId: string
    coverId: string
    submissionId: string
    frameEpoch: number
    demandCount: number
    overflowCount: number
    sourceLevelCeiling: number
    demands: readonly GpuWebMercatorQuadProjectedDemand[]
}>

export type GpuWebMercatorQuadDemandProjectionCommands = Readonly<{
    project: DispatchCommand
    stateFeedback: ReadbackCommand
    demandFeedback: ReadbackCommand
}>

export type GpuWebMercatorQuadDemandProjectionFacts = Readonly<{
    id: string
    runtimeId: string
    coverId: string
    disposed: boolean
    minimumSourceMatrixLevel: number
    sourceMaximumMatrixLevel: number
    maximumDemands: number
    sourceLimitCount: number
    parity: readonly Readonly<{
        parity: 0 | 1
        stateBufferId: string
        demandBufferId: string
        commandIds: readonly string[]
    }>[]
}>

export type GpuWebMercatorQuadDemandProjectionIdentityObjects = Readonly<{
    resources: readonly BufferResource[]
    uploads: readonly UploadCommand[]
    bindLayouts: readonly BindLayout[]
    bindSets: readonly BindSet[]
    programs: readonly Program[]
    pipelines: readonly ComputePipeline[]
    passes: readonly ComputePassSpec[]
    commands: readonly (ClearBufferCommand | DispatchCommand | ReadbackCommand)[]
}>

type ParityResources = Readonly<{
    parity: 0 | 1
    state: BufferResource
    demands: BufferResource
}>

type ParityTemplate = Readonly<{
    resources: ParityResources
    bindSet: BindSet
    commands: GpuWebMercatorQuadDemandProjectionCommands
}>

type FrameRecord = Readonly<{
    owner: GpuWebMercatorQuadDemandProjection
    coverFrame: GpuWebMercatorQuadCoverFrame
    template: ParityTemplate
}>

const frameRecords = new WeakMap<GpuWebMercatorQuadDemandProjectionFrame, FrameRecord>()
const encodedBuilders = new WeakMap<SubmissionBuilder, GpuWebMercatorQuadDemandProjectionFrame>()
const capturedBuilders = new WeakSet<SubmissionBuilder>()
let nextProjectionId = 1

/** Projects one geometry-cover frame into bounded source-tile demand on the GPU. */
export class GpuWebMercatorQuadDemandProjection {

    readonly runtime: GPURuntime
    readonly id: string
    readonly descriptor: GpuWebMercatorQuadDemandProjectionDescriptor
    readonly #pass: ComputePassSpec
    readonly #templates: readonly [ParityTemplate, ParityTemplate]
    readonly #initializationClears: readonly ClearBufferCommand[]
    readonly #initializationUploads: readonly UploadCommand[]
    readonly #identity: GpuWebMercatorQuadDemandProjectionIdentityObjects
    readonly #owned: readonly Disposable[]
    readonly #minimumSourceMatrixLevel: number
    readonly #sourceMaximumMatrixLevel: number
    #disposed = false

    private constructor(
        runtime: GPURuntime,
        descriptor: GpuWebMercatorQuadDemandProjectionDescriptor,
        state: Readonly<{
            pass: ComputePassSpec
            templates: readonly [ParityTemplate, ParityTemplate]
            initializationClears: readonly ClearBufferCommand[]
            initializationUploads: readonly UploadCommand[]
            identity: GpuWebMercatorQuadDemandProjectionIdentityObjects
            owned: readonly Disposable[]
            minimumSourceMatrixLevel: number
            sourceMaximumMatrixLevel: number
        }>
    ) {

        this.runtime = runtime
        this.id = `geo-gpu-web-mercator-quad-demand-${nextProjectionId++}`
        this.descriptor = descriptor
        this.#pass = state.pass
        this.#templates = state.templates
        this.#initializationClears = state.initializationClears
        this.#initializationUploads = state.initializationUploads
        this.#identity = state.identity
        this.#owned = state.owned
        this.#minimumSourceMatrixLevel = state.minimumSourceMatrixLevel
        this.#sourceMaximumMatrixLevel = state.sourceMaximumMatrixLevel
        Object.preventExtensions(this)
    }

    static async create(
        runtime: GPURuntime,
        input: GpuWebMercatorQuadDemandProjectionDescriptor
    ): Promise<GpuWebMercatorQuadDemandProjection> {

        const descriptor = snapshotDescriptor(runtime, input)
        const limits = descriptor.sourceCoverage.limits.map(limit => ({
            minTileRow: limit.minTileRow,
            maxTileRow: limit.maxTileRow,
            minTileCol: limit.minTileCol,
            maxTileCol: limit.maxTileCol,
        }))
        const minimumSourceMatrixLevel = Number(
            descriptor.sourceCoverage.limits[0]!.matrixId
        )
        const sourceMaximumMatrixLevel = Number(
            descriptor.sourceCoverage.limits.at(-1)!.matrixId
        )
        const demandBytes = checkedProduct(
            descriptor.maximumDemands,
            gpuWebMercatorQuadDemandCodec.byteLength()
        )
        const owned: Disposable[] = []
        const own = <Value extends Disposable>(value: Value): Value => {
            owned.push(value)
            return value
        }
        try {
            const policy = own(await runtime.createBuffer({
                label: 'GPU WebMercatorQuad demand policy',
                size: gpuWebMercatorQuadDemandPolicyCodec.byteLength(),
                usage: BUFFER_COPY_DST | BUFFER_UNIFORM,
            }))
            const sourceLimits = own(await runtime.createBuffer({
                label: 'GPU WebMercatorQuad demand source limits',
                size: limits.length * gpuWebMercatorQuadDemandLimitCodec.byteLength(),
                usage: BUFFER_COPY_DST | BUFFER_STORAGE,
            }))
            const policyUpload = own(runtime.createUploadCommand({
                label: 'Upload GPU WebMercatorQuad demand policy',
                target: policy.region({ layout: gpuWebMercatorQuadDemandPolicyCodec.artifact }),
                data: gpuWebMercatorQuadDemandPolicyCodec.pack({
                    minimumSourceMatrixLevel,
                    sourceMaximumMatrixLevel,
                    maximumDemands: descriptor.maximumDemands,
                    coordinateBits: descriptor.cover.descriptor.spatialProfile.coordinateBits,
                }),
            }))
            const limitsUpload = own(runtime.createUploadCommand({
                label: 'Upload GPU WebMercatorQuad demand source limits',
                target: sourceLimits.region({
                    layout: gpuWebMercatorQuadDemandLimitCodec.artifact,
                }),
                data: gpuWebMercatorQuadDemandLimitCodec.uploadView(limits),
            }))
            const coverTemplates = descriptor.cover.templates()
            const parityResources = await Promise.all([ 0, 1 ].map(async parityValue => {
                const parity = parityValue as 0 | 1
                return Object.freeze({
                    parity,
                    state: own(await runtime.createBuffer({
                        label: `GPU WebMercatorQuad demand state ${parity}`,
                        size: gpuWebMercatorQuadDemandStateCodec.byteLength(),
                        usage: BUFFER_COPY_DST | BUFFER_COPY_SRC | BUFFER_STORAGE,
                    })),
                    demands: own(await runtime.createBuffer({
                        label: `GPU WebMercatorQuad projected demands ${parity}`,
                        size: demandBytes,
                        usage: BUFFER_COPY_DST | BUFFER_COPY_SRC | BUFFER_STORAGE,
                    })),
                }) satisfies ParityResources
            })) as unknown as readonly [ParityResources, ParityResources]
            const initializationClears = Object.freeze(parityResources.flatMap(resources =>
                [ resources.state, resources.demands ].map((resource, index) =>
                    own(runtime.createClearBufferCommand({
                        label: `Clear GPU WebMercatorQuad demand ${resources.parity} resource ${index}`,
                        target: resource.region(),
                    }))
                )
            ))
            const coverShared = gpuWebMercatorQuadCoverSharedWgslModule()
            const shader = own(await runtime.createShaderModule({
                label: 'GPU WebMercatorQuad demand projection shader',
                sourceParts: [ {
                    label: 'GPU WebMercatorQuad demand projection ABI',
                    code: [
                        coverShared.code,
                        gpuWebMercatorQuadCoverStateCodec.wgslAccessors({
                            namespace: 'GpuWebMercatorQuadCoverState',
                        }),
                        gpuWebMercatorQuadDemandPolicyCodec.wgslAccessors({
                            namespace: 'GpuWebMercatorQuadDemandPolicy',
                        }),
                        gpuWebMercatorQuadDemandLimitCodec.wgslAccessors({
                            namespace: 'GpuWebMercatorQuadDemandLimit',
                        }),
                        gpuWebMercatorQuadDemandStateCodec.wgslAccessors({
                            namespace: 'GpuWebMercatorQuadDemandState',
                        }),
                        gpuWebMercatorQuadDemandCodec.wgslAccessors({
                            namespace: 'GpuWebMercatorQuadDemand',
                        }),
                    ].join('\n'),
                    layoutDependencies: [
                        ...coverShared.layoutDependencies,
                        gpuWebMercatorQuadCoverStateCodec.artifact,
                        gpuWebMercatorQuadDemandPolicyCodec.artifact,
                        gpuWebMercatorQuadDemandLimitCodec.artifact,
                        gpuWebMercatorQuadDemandStateCodec.artifact,
                        gpuWebMercatorQuadDemandCodec.artifact,
                    ],
                }, {
                    label: 'GPU WebMercatorQuad demand projection kernel',
                    code: GPU_WEB_MERCATOR_QUAD_DEMAND_WGSL,
                } ],
            }))
            const layout = own(await runtime.createBindLayout({
                label: 'GPU WebMercatorQuad demand projection layout',
                group: 0,
                entries: [
                    binding(0, 'mapMeta', 'uniform', coverTemplates[0].mapMeta.size),
                    binding(1, 'demandPolicy', 'uniform', policy.size),
                    binding(2, 'sourceLimits', 'read-storage', sourceLimits.size),
                    binding(3, 'coverPatches', 'read-storage', coverTemplates[0].patches.size),
                    binding(4, 'coverState', 'read-storage', coverTemplates[0].state.size),
                    binding(5, 'projectionState', 'storage',
                        gpuWebMercatorQuadDemandStateCodec.byteLength()),
                    binding(6, 'projectedDemands', 'storage', demandBytes),
                ],
            }))
            const program = own(runtime.createProgram({
                label: 'GPU WebMercatorQuad demand projection program',
                compute: { module: shader, entryPoint: 'projectWebMercatorQuadDemands' },
            }))
            const pipeline = own(await runtime.createComputePipeline({
                label: 'GPU WebMercatorQuad demand projection pipeline',
                program,
                layout: { mode: 'explicit', bindLayouts: [ layout ] },
            }))
            const pass = own(runtime.createComputePass({
                label: 'GPU WebMercatorQuad demand projection stage',
            }))
            const templates = await Promise.all(parityResources.map(async resources => {
                const coverTemplate = coverTemplates[resources.parity]
                const bindSet = own(await runtime.createBindSet(layout, {
                    mapMeta: coverTemplate.mapMeta.region(),
                    demandPolicy: policy.region({
                        layout: gpuWebMercatorQuadDemandPolicyCodec.artifact,
                    }),
                    sourceLimits: sourceLimits.region({
                        layout: gpuWebMercatorQuadDemandLimitCodec.artifact,
                    }),
                    coverPatches: coverTemplate.patches.region({
                        layout: gpuWebMercatorQuadCoverPatchCodec.artifact,
                    }),
                    coverState: coverTemplate.state.region({
                        layout: gpuWebMercatorQuadCoverStateCodec.artifact,
                    }),
                    projectionState: resources.state.region({
                        layout: gpuWebMercatorQuadDemandStateCodec.artifact,
                    }),
                    projectedDemands: resources.demands.region({
                        layout: gpuWebMercatorQuadDemandCodec.artifact,
                    }),
                }, { label: `GPU WebMercatorQuad demand bindings ${resources.parity}` }))
                const project = own(runtime.createDispatchCommand({
                    label: `Project GPU WebMercatorQuad demands ${resources.parity}`,
                    pipeline,
                    bindSets: [ { set: bindSet } ],
                    count: { workgroups: [ 1, 1, 1 ] },
                    resources: currentAccess([
                        coverTemplate.mapMeta,
                        policy,
                        sourceLimits,
                        coverTemplate.patches,
                        coverTemplate.state,
                        resources.state,
                        resources.demands,
                    ], [ resources.state, resources.demands ]),
                    whenMissing: 'throw',
                }))
                const stateFeedback = own(await runtime.createReadbackCommand({
                    label: `Read GPU WebMercatorQuad demand state ${resources.parity}`,
                    source: {
                        region: resources.state.region({
                            layout: gpuWebMercatorQuadDemandStateCodec.artifact,
                        }),
                        contentEpoch: 'current-at-step',
                    },
                    retain: 'consume-on-read',
                    whenMissing: 'throw',
                }))
                const demandFeedback = own(await runtime.createReadbackCommand({
                    label: `Read GPU WebMercatorQuad demands ${resources.parity}`,
                    source: {
                        region: resources.demands.region({
                            layout: gpuWebMercatorQuadDemandCodec.artifact,
                        }),
                        contentEpoch: 'current-at-step',
                    },
                    retain: 'consume-on-read',
                    whenMissing: 'throw',
                }))
                return Object.freeze({
                    resources,
                    bindSet,
                    commands: Object.freeze({ project, stateFeedback, demandFeedback }),
                })
            })) as unknown as readonly [ParityTemplate, ParityTemplate]
            const initializationUploads = Object.freeze([ policyUpload, limitsUpload ])
            const identity = Object.freeze({
                resources: Object.freeze([
                    policy,
                    sourceLimits,
                    ...parityResources.flatMap(resources => [
                        resources.state,
                        resources.demands,
                    ]),
                ]),
                uploads: initializationUploads,
                bindLayouts: Object.freeze([ layout ]),
                bindSets: Object.freeze(templates.map(template => template.bindSet)),
                programs: Object.freeze([ program ]),
                pipelines: Object.freeze([ pipeline ]),
                passes: Object.freeze([ pass ]),
                commands: Object.freeze([
                    ...initializationClears,
                    ...templates.flatMap(template => [
                        template.commands.project,
                        template.commands.stateFeedback,
                        template.commands.demandFeedback,
                    ]),
                ]),
            }) satisfies GpuWebMercatorQuadDemandProjectionIdentityObjects
            return new GpuWebMercatorQuadDemandProjection(runtime, descriptor, {
                pass,
                templates,
                initializationClears,
                initializationUploads,
                identity,
                owned: Object.freeze([ ...owned ]),
                minimumSourceMatrixLevel,
                sourceMaximumMatrixLevel,
            })
        } catch (error) {
            disposeReverse(owned)
            throw error
        }
    }

    initialize(builder: SubmissionBuilder): SubmissionBuilder {

        this.#assertActive()
        if (builder?.runtime !== this.runtime || builder.isSubmitted) {
            return invalidProjection(this, 'Demand initialization requires one live owning builder.',
                { runtimeId: this.runtime.id, submitted: false },
                { runtimeId: builder?.runtime?.id, submitted: builder?.isSubmitted })
        }
        for (const command of this.#initializationClears) builder.clear(command)
        for (const command of this.#initializationUploads) builder.upload(command)
        return builder
    }

    frame(coverFrame: GpuWebMercatorQuadCoverFrame): GpuWebMercatorQuadDemandProjectionFrame {

        this.#assertActive()
        this.descriptor.cover.commandsFor(coverFrame)
        if (coverFrame?.coverId !== this.descriptor.cover.id ||
            (coverFrame.parity !== 0 && coverFrame.parity !== 1)) {
            return invalidProjection(this, 'Demand projection requires one frame from its cover.',
                { coverId: this.descriptor.cover.id },
                { coverId: coverFrame?.coverId, parity: coverFrame?.parity })
        }
        const frame = Object.freeze({
            kind: 'gpu-web-mercator-quad-demand-projection-frame' as const,
            projectionId: this.id,
            coverId: coverFrame.coverId,
            frameEpoch: coverFrame.frameEpoch,
            residencySnapshotEpoch: coverFrame.residencySnapshotEpoch,
            parity: coverFrame.parity,
        })
        frameRecords.set(frame, Object.freeze({
            owner: this,
            coverFrame,
            template: this.#templates[coverFrame.parity],
        }))
        return frame
    }

    encode(
        builder: SubmissionBuilder,
        frame: GpuWebMercatorQuadDemandProjectionFrame
    ): SubmissionBuilder {

        this.#assertActive()
        const record = frameRecords.get(frame)
        if (builder?.runtime !== this.runtime || builder.isSubmitted ||
            encodedBuilders.has(builder) || record?.owner !== this) {
            return invalidProjection(this, 'Demand encoding requires one owned frame and live builder.',
                { runtimeId: this.runtime.id, submitted: false },
                { runtimeId: builder?.runtime?.id, submitted: builder?.isSubmitted })
        }
        assertGpuWebMercatorQuadCoverFrameEncoded(
            this.descriptor.cover,
            builder,
            record.coverFrame
        )
        builder.compute(this.#pass, [ record.template.commands.project ])
        encodedBuilders.set(builder, frame)
        return builder
    }

    capture(
        builder: SubmissionBuilder,
        frame: GpuWebMercatorQuadDemandProjectionFrame
    ): SubmissionBuilder {

        this.#assertActive()
        const record = frameRecords.get(frame)
        if (builder?.runtime !== this.runtime || builder.isSubmitted ||
            encodedBuilders.get(builder) !== frame || capturedBuilders.has(builder) ||
            record?.owner !== this) {
            return invalidProjection(this, 'Demand capture requires its matching encoded frame.',
                { encoded: true, captured: false },
                { encoded: encodedBuilders.get(builder)?.projectionId,
                    captured: capturedBuilders.has(builder) })
        }
        capturedBuilders.add(builder)
        builder.readback(record.template.commands.stateFeedback)
        builder.readback(record.template.commands.demandFeedback)
        return builder
    }

    async feedback(
        frame: GpuWebMercatorQuadDemandProjectionFrame,
        submitted: SubmittedWork
    ): Promise<GpuWebMercatorQuadDemandProjectionFeedback> {

        this.#assertActive()
        const record = frameRecords.get(frame)
        if (record?.owner !== this || submitted?.runtime !== this.runtime) {
            return invalidProjection(this, 'Demand feedback requires one owned frame submission.',
                { runtimeId: this.runtime.id }, { runtimeId: submitted?.runtime?.id })
        }
        for (const command of [
            record.template.commands.stateFeedback,
            record.template.commands.demandFeedback,
        ]) {
            if (!submitted.readbacks.some(link => link.commandId === command.id)) {
                return invalidProjection(this, 'Demand feedback is missing a required readback.',
                    { commandId: command.id },
                    { commandIds: submitted.readbacks.map(link => link.commandId) })
            }
        }
        const [ stateBytes, demandBytes ] = await Promise.all([
            record.template.commands.stateFeedback.result({ after: submitted }).toBytes(),
            record.template.commands.demandFeedback.result({ after: submitted }).toBytes(),
        ])
        const decoded = decodeGpuWebMercatorQuadDemandProjectionFeedback(
            stateBytes,
            demandBytes,
            {
                expectedFrameEpoch: frame.frameEpoch,
                maximumDemands: this.descriptor.maximumDemands,
                sourceLevelCeiling: this.#sourceMaximumMatrixLevel,
            }
        )
        return Object.freeze({
            kind: 'gpu-web-mercator-quad-demand-projection-feedback' as const,
            projectionId: this.id,
            coverId: frame.coverId,
            submissionId: submitted.id,
            ...decoded,
        })
    }

    commandsFor(
        frame: GpuWebMercatorQuadDemandProjectionFrame
    ): GpuWebMercatorQuadDemandProjectionCommands {

        this.#assertActive()
        const record = frameRecords.get(frame)
        if (record?.owner !== this) {
            return invalidProjection(this, 'Demand commands require one owned frame.',
                { projectionId: this.id }, { projectionId: frame?.projectionId })
        }
        return record.template.commands
    }

    facts(): GpuWebMercatorQuadDemandProjectionFacts {

        return Object.freeze({
            id: this.id,
            runtimeId: this.runtime.id,
            coverId: this.descriptor.cover.id,
            disposed: this.#disposed,
            minimumSourceMatrixLevel: this.#minimumSourceMatrixLevel,
            sourceMaximumMatrixLevel: this.#sourceMaximumMatrixLevel,
            maximumDemands: this.descriptor.maximumDemands,
            sourceLimitCount: this.descriptor.sourceCoverage.limits.length,
            parity: Object.freeze(this.#templates.map(template => Object.freeze({
                parity: template.resources.parity,
                stateBufferId: template.resources.state.id,
                demandBufferId: template.resources.demands.id,
                commandIds: Object.freeze([
                    template.commands.project.id,
                    template.commands.stateFeedback.id,
                    template.commands.demandFeedback.id,
                ]),
            }))),
        })
    }

    identityObjects(): GpuWebMercatorQuadDemandProjectionIdentityObjects {

        this.#assertActive()
        return this.#identity
    }

    dispose(): void {

        if (this.#disposed) return
        this.#disposed = true
        disposeReverse(this.#owned)
    }

    #assertActive(): void {

        if (this.#disposed) {
            return invalidProjection(this, 'GPU WebMercatorQuad demand projection is disposed.',
                { disposed: false }, { disposed: true })
        }
    }
}

Object.freeze(GpuWebMercatorQuadDemandProjection.prototype)

/** Decodes bounded source-demand feedback and throws GeoDiagnosticError for invalid records. */
export function decodeGpuWebMercatorQuadDemandProjectionFeedback(
    stateBytes: Uint8Array,
    demandBytes: Uint8Array,
    options: Readonly<{
        expectedFrameEpoch: number
        maximumDemands: number
        sourceLevelCeiling: number
    }>
): Readonly<{
    frameEpoch: number
    demandCount: number
    overflowCount: number
    sourceLevelCeiling: number
    demands: readonly GpuWebMercatorQuadProjectedDemand[]
}> {

    const stateSize = gpuWebMercatorQuadDemandStateCodec.byteLength()
    const demandStride = gpuWebMercatorQuadDemandCodec.byteLength()
    if (!(stateBytes instanceof Uint8Array) || stateBytes.byteLength !== stateSize ||
        !(demandBytes instanceof Uint8Array) || demandBytes.byteLength % demandStride !== 0) {
        return throwGeoDiagnostic({
            code: 'GEO_WEB_MERCATOR_DEMAND_FEEDBACK_INVALID',
            phase: 'demand', subject: { kind: 'web-mercator-quad-demand-projection' },
            message: 'Demand feedback requires complete state and demand records.',
            expected: { stateSize, demandStride },
            actual: { reason: 'byte-length', stateSize: stateBytes?.byteLength,
                demandSize: demandBytes?.byteLength },
        })
    }
    const state = new DataView(stateBytes.buffer, stateBytes.byteOffset, stateBytes.byteLength)
    const frameEpoch = state.getUint32(0, true)
    const demandCount = state.getUint32(4, true)
    const overflowCount = state.getUint32(8, true)
    const sourceLevelCeiling = state.getUint32(12, true)
    const reason = frameEpoch !== options.expectedFrameEpoch ? 'frame-epoch' :
        demandCount > options.maximumDemands ||
        demandCount > demandBytes.byteLength / demandStride ? 'demand-capacity' :
        overflowCount !== 0 ? 'overflow' :
        sourceLevelCeiling !== options.sourceLevelCeiling ? 'source-ceiling' : undefined
    if (reason !== undefined) {
        return throwGeoDiagnostic({
            code: 'GEO_WEB_MERCATOR_DEMAND_FEEDBACK_INVALID',
            phase: 'demand', subject: { kind: 'web-mercator-quad-demand-projection' },
            message: 'Demand feedback is stale, incomplete, or inconsistent.',
            expected: options,
            actual: { reason, frameEpoch, demandCount, overflowCount, sourceLevelCeiling },
        })
    }
    const view = new DataView(demandBytes.buffer, demandBytes.byteOffset, demandBytes.byteLength)
    const demands = Array.from({ length: demandCount }, (_, index) => {
        const base = index * demandStride
        return Object.freeze({
            desiredSampleLevel: view.getUint32(base, true),
            sourceLevelCeiling: view.getUint32(base + 4, true),
            requestMatrixLevel: view.getUint32(base + 8, true),
            tileRow: view.getUint32(base + 12, true),
            tileCol: view.getUint32(base + 16, true),
            priority: view.getUint32(base + 20, true),
            decisionFrameEpoch: view.getUint32(base + 24, true),
            residencySnapshotEpoch: view.getUint32(base + 28, true),
        })
    })
    const identities = new Set<string>()
    for (const [ index, demand ] of demands.entries()) {
        const matrixWidth = 2 ** demand.requestMatrixLevel
        const identity = `${demand.requestMatrixLevel}/${demand.tileRow}/${demand.tileCol}`
        if (demand.desiredSampleLevel > 24 || demand.requestMatrixLevel > 24 ||
            demand.desiredSampleLevel < demand.requestMatrixLevel ||
            demand.sourceLevelCeiling !== options.sourceLevelCeiling ||
            demand.requestMatrixLevel > demand.sourceLevelCeiling ||
            demand.tileRow >= matrixWidth || demand.tileCol >= matrixWidth ||
            demand.decisionFrameEpoch !== options.expectedFrameEpoch ||
            identities.has(identity)) {
            return throwGeoDiagnostic({
                code: 'GEO_WEB_MERCATOR_DEMAND_FEEDBACK_INVALID',
                phase: 'demand', subject: { kind: 'web-mercator-quad-demand-projection' },
                message: 'A demand record has invalid identity, provenance, or duplicates.',
                expected: options, actual: { reason: 'record', index, demand },
            })
        }
        identities.add(identity)
    }
    return Object.freeze({
        frameEpoch,
        demandCount,
        overflowCount,
        sourceLevelCeiling,
        demands: Object.freeze(demands),
    })
}

function snapshotDescriptor(
    runtime: GPURuntime,
    input: GpuWebMercatorQuadDemandProjectionDescriptor
): GpuWebMercatorQuadDemandProjectionDescriptor {

    const cover = input?.cover
    const sourceCoverage = input?.sourceCoverage
    const limits = sourceCoverage?.limits
    if (cover?.runtime !== runtime || sourceCoverage?.tileMatrixSet !== WebMercatorQuad ||
        !Array.isArray(limits) || limits.length === 0 ||
        !positiveSafeInteger(input.maximumDemands) ||
        input.maximumDemands > cover?.descriptor?.policy?.maximumPatches) {
        return invalidProjection(
            { id: 'uninitialized' },
            'Demand projection requires one owning cover, WebMercator source coverage, and bounded capacity.',
            { runtimeId: runtime?.id, maximumDemands: '1..cover.maximumPatches' },
            input
        )
    }
    const minimum = Number(limits[0]!.matrixId)
    const contiguous = limits.every((limit, index) =>
        Number(limit.matrixId) === minimum + index
    )
    const maximum = Number(limits.at(-1)!.matrixId)
    if (!contiguous || minimum < 0 ||
        minimum > cover.descriptor.policy.minimumMatrixLevel ||
        maximum >= cover.descriptor.spatialProfile.coordinateBits) {
        return invalidProjection(
            { id: 'uninitialized' },
            'Demand source coverage must contain contiguous supported matrix levels.',
            {
                maximumMinimumLevel: cover.descriptor.policy.minimumMatrixLevel,
                coordinateBits: cover.descriptor.spatialProfile.coordinateBits,
            },
            limits
        )
    }
    return Object.freeze({ cover, sourceCoverage, maximumDemands: input.maximumDemands })
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

function uniqueResources(resources: readonly BufferResource[]): BufferResource[] {

    return [ ...new Map(resources.map(resource => [ resource.id, resource ])).values() ]
}

function positiveSafeInteger(value: number): boolean {

    return Number.isSafeInteger(value) && value > 0
}

function checkedProduct(left: number, right: number): number {

    const result = left * right
    if (!Number.isSafeInteger(result) || result <= 0 || result > 0xffff_ffff) {
        throw new RangeError('GPU WebMercatorQuad demand buffer size exceeds u32 bounds')
    }
    return result
}

function disposeReverse(values: readonly Disposable[]): void {

    for (let index = values.length - 1; index >= 0; index--) {
        try {
            values[index]!.dispose()
        } catch {
            // Best-effort cleanup continues after creation or lifecycle failure.
        }
    }
}

function invalidProjection(
    projection: Pick<GpuWebMercatorQuadDemandProjection, 'id'>,
    message: string,
    expected: unknown,
    actual: unknown
): never {

    return throwGeoDiagnostic({
        code: 'GEO_WEB_MERCATOR_DEMAND_PROJECTION_INVALID',
        phase: 'demand',
        subject: { kind: 'web-mercator-quad-demand-projection', id: projection.id },
        message,
        expected,
        actual,
    })
}
