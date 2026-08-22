import {
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
    type SubmissionAuthority,
    type SubmissionAuthorityStamp,
    type SubmissionBuilder,
    type SubmittedWork,
    type UploadCommand,
} from '../scratch/index.js'
import { throwGeoDiagnostic } from './diagnostics.js'
import type { GeoViewSnapshot } from './geo-view.js'
import {
    gpuWebMercatorQuadCoverDemandCodec,
    gpuWebMercatorQuadCoverLimitCodec,
    gpuWebMercatorQuadCoverLookupEntryCodec,
    gpuWebMercatorQuadCoverMapMetaCodec,
    gpuWebMercatorQuadCoverPatchCodec,
    gpuWebMercatorQuadCoverPolicyCodec,
    gpuWebMercatorQuadCoverSharedWgslModule,
    gpuWebMercatorQuadCoverStateCodec,
} from './gpu-web-mercator-quad-cover-layout.js'
import { GPU_WEB_MERCATOR_QUAD_COVER_WGSL } from './gpu-web-mercator-quad-cover-wgsl.js'
import type { WebMercatorPlanarTileSpatialProfile } from './tile-spatial-profile.js'
import { WebMercatorQuad } from './web-mercator-quad.js'

const BUFFER_COPY_DST = 0x08
const BUFFER_COPY_SRC = 0x04
const BUFFER_UNIFORM = 0x40
const BUFFER_STORAGE = 0x80
const BUFFER_INDIRECT = 0x100
const DRAW_ARGUMENT_BYTES = 16

type Disposable = { dispose(): void }
type BufferBindingType = 'uniform' | 'read-storage' | 'storage'

export type GpuWebMercatorQuadCoverPolicy = Readonly<{
    minimumMatrixLevel: number
    maximumMatrixLevel: number
    sourceMaximumMatrixLevel: number
    maximumPatches: number
    cellsPerPatchEdge: number
    maximumCellSpanPixels: number
    variableLodPitchThresholdRadians: number
}>

export type GpuWebMercatorQuadCoverDescriptor = Readonly<{
    spatialProfile: WebMercatorPlanarTileSpatialProfile
    policy: GpuWebMercatorQuadCoverPolicy
    elevationRangeMeters: readonly [number, number]
    vertexCount: number
}>

export type GpuWebMercatorQuadCoverViewToken = Readonly<{
    kind: 'gpu-web-mercator-quad-cover-view-token'
    coverId: string
    frameEpoch: number
    residencySnapshotEpoch: number
    parity: 0 | 1
    readonly isDisposed: boolean
    dispose(): void
}>

export type GpuWebMercatorQuadCoverFrame = Readonly<{
    kind: 'gpu-web-mercator-quad-cover-frame'
    coverId: string
    frameEpoch: number
    residencySnapshotEpoch: number
    parity: 0 | 1
    visibleInstances: BufferResource
}>

export type GpuWebMercatorQuadCoverRenderTemplate = Readonly<{
    coverId: string
    parity: 0 | 1
    templateId: 'patch-mesh'
    mapMeta: BufferResource
    visibleInstances: BufferResource
    coverLookup: BufferResource
    drawArgument: Readonly<{
        resource: BufferResource
        region: BufferRegion
        offset: 0
        size: 16
    }>
}>

export type GpuWebMercatorQuadCoverDemand = Readonly<{
    desiredSampleLevel: number
    sourceLevelCeiling: number
    requestMatrixLevel: number
    tileRow: number
    tileCol: number
    priority: number
    decisionFrameEpoch: number
    residencySnapshotEpoch: number
}>

export type GpuWebMercatorQuadCoverSelectionFacts = Readonly<{
    frameEpoch: number
    candidateCount: number
    patchCount: number
    demandCount: number
    descriptorOverflowCount: number
    lookupOverflowCount: number
    demandOverflowCount: number
    minimumMatrixLevel?: number
    maximumMatrixLevel?: number
    maximumAdjacentLevelDelta: number
    finestMatrixLevel: number
    sourceLevelCeiling: number
    selectionMode: 'uniform' | 'variable'
    minimumCellSpanPixels?: number
    maximumCellSpanPixels?: number
}>

export type GpuWebMercatorQuadCoverFeedback =
    GpuWebMercatorQuadCoverSelectionFacts & Readonly<{
        kind: 'gpu-web-mercator-quad-cover-feedback'
        coverId: string
        submissionId: string
        demands: readonly GpuWebMercatorQuadCoverDemand[]
    }>

export type GpuWebMercatorQuadCoverCommands = Readonly<{
    generate: DispatchCommand
    stateFeedback: ReadbackCommand
    demandFeedback: ReadbackCommand
}>

export type GpuWebMercatorQuadCoverFacts = Readonly<{
    id: string
    runtimeId: string
    selectionPath: 'gpu-camera-inverse-webmercatorquad-cover'
    disposed: boolean
    policy: GpuWebMercatorQuadCoverPolicy
    lookupCapacity: number
    coverageLimitCount: number
    parity: readonly Readonly<{
        parity: 0 | 1
        mapMetaBufferId: string
        patchBufferId: string
        lookupBufferId: string
        stateBufferId: string
        demandBufferId: string
        drawArgumentBufferId: string
        commandIds: readonly string[]
    }>[]
}>

export type GpuWebMercatorQuadCoverIdentityObjects = Readonly<{
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
    mapMeta: BufferResource
    patches: BufferResource
    lookup: BufferResource
    state: BufferResource
    demands: BufferResource
    drawArguments: BufferResource
}>

type ParityTemplate = Readonly<{
    resources: ParityResources
    bindSet: BindSet
    commands: GpuWebMercatorQuadCoverCommands
    renderTemplate: GpuWebMercatorQuadCoverRenderTemplate
}>

type ViewRecord = {
    owner: GpuWebMercatorQuadCover
    command: UploadCommand
    viewStamp: SubmissionAuthorityStamp
    sequenceStamp: SubmissionAuthorityStamp
    parity: 0 | 1
    disposed: boolean
}

type FrameRecord = Readonly<{
    owner: GpuWebMercatorQuadCover
    view: ViewRecord
    template: ParityTemplate
}>

const viewRecords = new WeakMap<GpuWebMercatorQuadCoverViewToken, ViewRecord>()
const frameRecords = new WeakMap<GpuWebMercatorQuadCoverFrame, FrameRecord>()
const encodedBuilders = new WeakMap<SubmissionBuilder, GpuWebMercatorQuadCoverFrame>()
const capturedBuilders = new WeakSet<SubmissionBuilder>()
let nextCoverId = 1

/**
 * Validates immutable projected-cell quality, pitch boundary, source-ceiling,
 * and capacity facts for one camera-derived standard WebMercatorQuad cover.
 */
export function gpuWebMercatorQuadCoverPolicy(
    input: GpuWebMercatorQuadCoverPolicy
): GpuWebMercatorQuadCoverPolicy {

    if (!level(input?.minimumMatrixLevel) ||
        !level(input?.maximumMatrixLevel) ||
        !level(input?.sourceMaximumMatrixLevel) ||
        input.minimumMatrixLevel > input.sourceMaximumMatrixLevel ||
        input.sourceMaximumMatrixLevel > input.maximumMatrixLevel ||
        !positiveSafeInteger(input.maximumPatches) ||
        !positiveSafeInteger(input.cellsPerPatchEdge) ||
        !positiveFinite(input.maximumCellSpanPixels) ||
        !Number.isFinite(input.variableLodPitchThresholdRadians) ||
        input.variableLodPitchThresholdRadians < 0 ||
        input.variableLodPitchThresholdRadians > Math.PI / 2) {
        return throwGeoDiagnostic({
            code: 'GEO_WEB_MERCATOR_COVER_POLICY_INVALID',
            phase: 'selection',
            subject: { kind: 'web-mercator-quad-cover' },
            message: 'A WebMercatorQuad cover policy requires ordered levels, projected-cell quality, a pitch boundary, and a positive patch capacity.',
            expected: {
                levels: '0 <= minimum <= sourceMaximum <= maximum <= 24',
                maximumPatches: 'positive safe integer',
                cellsPerPatchEdge: 'positive safe integer',
                maximumCellSpanPixels: 'positive finite number',
                variableLodPitchThresholdRadians: '[0, PI / 2]',
            },
            actual: input,
        })
    }
    return Object.freeze({ ...input })
}

function level(value: number): boolean {

    return Number.isSafeInteger(value) && value >= 0 && value <= 24
}

function positiveSafeInteger(value: number): boolean {

    return Number.isSafeInteger(value) && value > 0
}

function positiveFinite(value: number): boolean {

    return Number.isFinite(value) && value > 0
}

/** Owns the bounded GPU graph that derives one standard WebMercatorQuad view cover. */
export class GpuWebMercatorQuadCover {

    readonly runtime: GPURuntime
    readonly id: string
    readonly descriptor: GpuWebMercatorQuadCoverDescriptor
    readonly #policy: BufferResource
    readonly #coverageLimits: BufferResource
    readonly #pass: ComputePassSpec
    readonly #templates: readonly [ParityTemplate, ParityTemplate]
    readonly #initializationClears: readonly ClearBufferCommand[]
    readonly #initializationUploads: readonly UploadCommand[]
    readonly #identity: GpuWebMercatorQuadCoverIdentityObjects
    readonly #owned: readonly Disposable[]
    readonly #viewAuthority: SubmissionAuthority
    readonly #sequenceAuthority: SubmissionAuthority
    readonly #lookupCapacity: number
    readonly #views = new Set<ViewRecord>()
    #disposed = false

    private constructor(
        runtime: GPURuntime,
        descriptor: GpuWebMercatorQuadCoverDescriptor,
        state: Readonly<{
            policy: BufferResource
            coverageLimits: BufferResource
            pass: ComputePassSpec
            templates: readonly [ParityTemplate, ParityTemplate]
            initializationClears: readonly ClearBufferCommand[]
            initializationUploads: readonly UploadCommand[]
            identity: GpuWebMercatorQuadCoverIdentityObjects
            owned: readonly Disposable[]
            lookupCapacity: number
        }>
    ) {

        this.runtime = runtime
        this.id = `geo-gpu-web-mercator-quad-cover-${nextCoverId++}`
        this.descriptor = descriptor
        this.#policy = state.policy
        this.#coverageLimits = state.coverageLimits
        this.#pass = state.pass
        this.#templates = state.templates
        this.#initializationClears = state.initializationClears
        this.#initializationUploads = state.initializationUploads
        this.#identity = state.identity
        this.#owned = state.owned
        this.#lookupCapacity = state.lookupCapacity
        this.#viewAuthority = runtime.createSubmissionAuthority({
            label: `${this.id} view`,
        })
        this.#sequenceAuthority = runtime.createSubmissionAuthority({
            label: `${this.id} sequence`,
        })
        Object.preventExtensions(this)
    }

    static async create(
        runtime: GPURuntime,
        input: GpuWebMercatorQuadCoverDescriptor
    ): Promise<GpuWebMercatorQuadCover> {

        const descriptor = snapshotDescriptor(runtime, input)
        const lookupCapacity = nextPowerOfTwo(descriptor.policy.maximumPatches * 2)
        const limits = descriptor.spatialProfile.coverage.limits.map(limit => ({
            matrixLevel: Number(limit.matrixId),
            minTileRow: limit.minTileRow,
            maxTileRow: limit.maxTileRow,
            minTileCol: limit.minTileCol,
            maxTileCol: limit.maxTileCol,
        }))
        const patchBytes = checkedProduct(
            descriptor.policy.maximumPatches,
            gpuWebMercatorQuadCoverPatchCodec.byteLength()
        )
        const lookupBytes = checkedProduct(
            lookupCapacity,
            gpuWebMercatorQuadCoverLookupEntryCodec.byteLength()
        )
        const demandBytes = checkedProduct(
            descriptor.policy.maximumPatches,
            gpuWebMercatorQuadCoverDemandCodec.byteLength()
        )
        const owned: Disposable[] = []
        const own = <Value extends Disposable>(value: Value): Value => {
            owned.push(value)
            return value
        }
        try {
            const policy = own(await runtime.createBuffer({
                label: 'GPU WebMercatorQuad cover policy',
                size: gpuWebMercatorQuadCoverPolicyCodec.byteLength(),
                usage: BUFFER_COPY_DST | BUFFER_UNIFORM,
            }))
            const coverageLimits = own(await runtime.createBuffer({
                label: 'GPU WebMercatorQuad source coverage limits',
                size: limits.length * gpuWebMercatorQuadCoverLimitCodec.byteLength(),
                usage: BUFFER_COPY_DST | BUFFER_STORAGE,
            }))
            const policyUpload = own(runtime.createUploadCommand({
                label: 'Upload GPU WebMercatorQuad cover policy',
                target: policy.region({
                    layout: gpuWebMercatorQuadCoverPolicyCodec.artifact,
                }),
                data: gpuWebMercatorQuadCoverPolicyCodec.pack({
                    ...descriptor.policy,
                    demandCapacity: descriptor.policy.maximumPatches,
                    coverageLimitCount: limits.length,
                    coordinateBits: descriptor.spatialProfile.coordinateBits,
                    vertexCount: descriptor.vertexCount,
                    lookupCapacity,
                    minimumElevationMeters: descriptor.elevationRangeMeters[0],
                    maximumElevationMeters: descriptor.elevationRangeMeters[1],
                    cellsPerPatchEdge: descriptor.policy.cellsPerPatchEdge,
                    maximumCellSpanPixels: descriptor.policy.maximumCellSpanPixels,
                    variableLodPitchThresholdRadians:
                        descriptor.policy.variableLodPitchThresholdRadians,
                    reserved0: 0,
                }),
            }))
            const limitsUpload = own(runtime.createUploadCommand({
                label: 'Upload GPU WebMercatorQuad source coverage limits',
                target: coverageLimits.region({
                    layout: gpuWebMercatorQuadCoverLimitCodec.artifact,
                }),
                data: gpuWebMercatorQuadCoverLimitCodec.uploadView(limits),
            }))
            const parityResources = await Promise.all([ 0, 1 ].map(
                async parityValue => {
                    const parity = parityValue as 0 | 1
                    return Object.freeze({
                        parity,
                        mapMeta: own(await runtime.createBuffer({
                            label: `GPU WebMercatorQuad cover map metadata ${parity}`,
                            size: gpuWebMercatorQuadCoverMapMetaCodec.byteLength(),
                            usage: BUFFER_COPY_DST | BUFFER_UNIFORM,
                        })),
                        patches: own(await runtime.createBuffer({
                            label: `GPU WebMercatorQuad cover patches ${parity}`,
                            size: patchBytes,
                            usage: BUFFER_COPY_DST | BUFFER_STORAGE,
                        })),
                        lookup: own(await runtime.createBuffer({
                            label: `GPU WebMercatorQuad cover lookup ${parity}`,
                            size: lookupBytes,
                            usage: BUFFER_COPY_DST | BUFFER_STORAGE,
                        })),
                        state: own(await runtime.createBuffer({
                            label: `GPU WebMercatorQuad cover state ${parity}`,
                            size: gpuWebMercatorQuadCoverStateCodec.byteLength(),
                            usage: BUFFER_COPY_DST | BUFFER_COPY_SRC | BUFFER_STORAGE,
                        })),
                        demands: own(await runtime.createBuffer({
                            label: `GPU WebMercatorQuad cover demands ${parity}`,
                            size: demandBytes,
                            usage: BUFFER_COPY_DST | BUFFER_COPY_SRC | BUFFER_STORAGE,
                        })),
                        drawArguments: own(await runtime.createBuffer({
                            label: `GPU WebMercatorQuad cover draw arguments ${parity}`,
                            size: DRAW_ARGUMENT_BYTES,
                            usage: BUFFER_COPY_DST | BUFFER_STORAGE | BUFFER_INDIRECT,
                        })),
                    }) satisfies ParityResources
                }
            )) as unknown as readonly [ParityResources, ParityResources]
            const initializationClears = Object.freeze(parityResources.flatMap(resources => [
                resources.patches,
                resources.lookup,
                resources.state,
                resources.demands,
                resources.drawArguments,
            ].map((resource, index) => own(runtime.createClearBufferCommand({
                label: `Clear GPU WebMercatorQuad cover ${resources.parity} resource ${index}`,
                target: resource.region(),
            })))))
            const shared = gpuWebMercatorQuadCoverSharedWgslModule()
            const shader = own(await runtime.createShaderModule({
                label: 'GPU WebMercatorQuad inverse-cover shader',
                sourceParts: [
                    {
                        label: 'GPU WebMercatorQuad inverse-cover ABI',
                        code: [
                            shared.code,
                            gpuWebMercatorQuadCoverPolicyCodec.wgslAccessors({
                                namespace: 'GpuWebMercatorQuadCoverPolicy',
                            }),
                            gpuWebMercatorQuadCoverLimitCodec.wgslAccessors({
                                namespace: 'GpuWebMercatorQuadCoverLimit',
                            }),
                            gpuWebMercatorQuadCoverLookupEntryCodec.wgslAccessors({
                                namespace: 'GpuWebMercatorQuadCoverLookupEntry',
                            }),
                            gpuWebMercatorQuadCoverStateCodec.wgslAccessors({
                                namespace: 'GpuWebMercatorQuadCoverState',
                            }),
                            gpuWebMercatorQuadCoverDemandCodec.wgslAccessors({
                                namespace: 'GpuWebMercatorQuadCoverDemand',
                            }),
                        ].join('\n'),
                        layoutDependencies: [
                            ...shared.layoutDependencies,
                            gpuWebMercatorQuadCoverPolicyCodec.artifact,
                            gpuWebMercatorQuadCoverLimitCodec.artifact,
                            gpuWebMercatorQuadCoverLookupEntryCodec.artifact,
                            gpuWebMercatorQuadCoverStateCodec.artifact,
                            gpuWebMercatorQuadCoverDemandCodec.artifact,
                        ],
                    },
                    {
                        label: 'GPU WebMercatorQuad inverse-cover kernel',
                        code: GPU_WEB_MERCATOR_QUAD_COVER_WGSL,
                    },
                ],
            }))
            const layout = own(await runtime.createBindLayout({
                label: 'GPU WebMercatorQuad inverse-cover layout',
                group: 0,
                entries: [
                    binding(
                        0,
                        'mapMeta',
                        'uniform',
                        gpuWebMercatorQuadCoverMapMetaCodec.byteLength()
                    ),
                    binding(
                        1,
                        'coverPolicy',
                        'uniform',
                        gpuWebMercatorQuadCoverPolicyCodec.byteLength()
                    ),
                    binding(2, 'coverageLimits', 'read-storage', coverageLimits.size),
                    binding(3, 'coverPatches', 'storage', patchBytes),
                    binding(4, 'coverLookup', 'storage', lookupBytes),
                    binding(
                        5,
                        'coverState',
                        'storage',
                        gpuWebMercatorQuadCoverStateCodec.byteLength()
                    ),
                    binding(6, 'coverDemands', 'storage', demandBytes),
                    binding(7, 'drawArguments', 'storage', DRAW_ARGUMENT_BYTES),
                ],
            }))
            const program = own(runtime.createProgram({
                label: 'GPU WebMercatorQuad inverse-cover program',
                compute: {
                    module: shader,
                    entryPoint: 'generateWebMercatorQuadCover',
                },
            }))
            const pipeline = own(await runtime.createComputePipeline({
                label: 'GPU WebMercatorQuad inverse-cover pipeline',
                program,
                layout: { mode: 'explicit', bindLayouts: [ layout ] },
            }))
            const pass = own(runtime.createComputePass({
                label: 'GPU WebMercatorQuad inverse-cover stage',
            }))
            const templates = await Promise.all(parityResources.map(
                async resources => {
                    const bindSet = own(await runtime.createBindSet(layout, {
                        mapMeta: resources.mapMeta.region({
                            layout: gpuWebMercatorQuadCoverMapMetaCodec.artifact,
                        }),
                        coverPolicy: policy.region({
                            layout: gpuWebMercatorQuadCoverPolicyCodec.artifact,
                        }),
                        coverageLimits: coverageLimits.region({
                            layout: gpuWebMercatorQuadCoverLimitCodec.artifact,
                        }),
                        coverPatches: resources.patches.region({
                            layout: gpuWebMercatorQuadCoverPatchCodec.artifact,
                        }),
                        coverLookup: resources.lookup.region({
                            layout: gpuWebMercatorQuadCoverLookupEntryCodec.artifact,
                        }),
                        coverState: resources.state.region({
                            layout: gpuWebMercatorQuadCoverStateCodec.artifact,
                        }),
                        coverDemands: resources.demands.region({
                            layout: gpuWebMercatorQuadCoverDemandCodec.artifact,
                        }),
                        drawArguments: resources.drawArguments.region(),
                    }, {
                        label: `GPU WebMercatorQuad inverse-cover bindings ${resources.parity}`,
                    }))
                    const generate = own(runtime.createDispatchCommand({
                        label: `Generate GPU WebMercatorQuad inverse cover ${resources.parity}`,
                        pipeline,
                        bindSets: [ { set: bindSet } ],
                        count: { workgroups: [ 1, 1, 1 ] },
                        resources: currentAccess([
                            resources.mapMeta,
                            policy,
                            coverageLimits,
                            resources.patches,
                            resources.lookup,
                            resources.state,
                            resources.demands,
                            resources.drawArguments,
                        ], [
                            resources.patches,
                            resources.lookup,
                            resources.state,
                            resources.demands,
                            resources.drawArguments,
                        ]),
                        whenMissing: 'throw',
                    }))
                    const stateFeedback = own(await runtime.createReadbackCommand({
                        label: `Read GPU WebMercatorQuad cover state ${resources.parity}`,
                        source: {
                            region: resources.state.region({
                                layout: gpuWebMercatorQuadCoverStateCodec.artifact,
                            }),
                            contentEpoch: 'current-at-step',
                        },
                        retain: 'consume-on-read',
                        whenMissing: 'throw',
                    }))
                    const demandFeedback = own(await runtime.createReadbackCommand({
                        label: `Read GPU WebMercatorQuad cover demands ${resources.parity}`,
                        source: {
                            region: resources.demands.region({
                                layout: gpuWebMercatorQuadCoverDemandCodec.artifact,
                            }),
                            contentEpoch: 'current-at-step',
                        },
                        retain: 'consume-on-read',
                        whenMissing: 'throw',
                    }))
                    const renderTemplate = {
                        coverId: '',
                        parity: resources.parity,
                        templateId: 'patch-mesh' as const,
                        mapMeta: resources.mapMeta,
                        visibleInstances: resources.patches,
                        coverLookup: resources.lookup,
                        drawArgument: Object.freeze({
                            resource: resources.drawArguments,
                            region: resources.drawArguments.region({
                                offset: 0,
                                size: DRAW_ARGUMENT_BYTES,
                            }),
                            offset: 0 as const,
                            size: DRAW_ARGUMENT_BYTES as 16,
                        }),
                    } as GpuWebMercatorQuadCoverRenderTemplate
                    return Object.freeze({
                        resources,
                        bindSet,
                        commands: Object.freeze({
                            generate,
                            stateFeedback,
                            demandFeedback,
                        }),
                        renderTemplate,
                    })
                }
            )) as unknown as readonly [ParityTemplate, ParityTemplate]
            const initializationUploads = Object.freeze([ policyUpload, limitsUpload ])
            const identity: GpuWebMercatorQuadCoverIdentityObjects = Object.freeze({
                resources: Object.freeze([
                    policy,
                    coverageLimits,
                    ...parityResources.flatMap(resources => [
                        resources.mapMeta,
                        resources.patches,
                        resources.lookup,
                        resources.state,
                        resources.demands,
                        resources.drawArguments,
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
                        template.commands.generate,
                        template.commands.stateFeedback,
                        template.commands.demandFeedback,
                    ]),
                ]),
            })
            const cover = new GpuWebMercatorQuadCover(runtime, descriptor, {
                policy,
                coverageLimits,
                pass,
                templates,
                initializationClears,
                initializationUploads,
                identity,
                owned: Object.freeze([ ...owned ]),
                lookupCapacity,
            })
            for (const template of templates) {
                ;(template.renderTemplate as { coverId: string }).coverId = cover.id
                Object.freeze(template.renderTemplate)
            }
            return cover
        } catch (error) {
            disposeReverse(owned)
            throw error
        }
    }

    initialize(builder: SubmissionBuilder): SubmissionBuilder {

        this.#assertActive()
        if (builder?.runtime !== this.runtime || builder.isSubmitted) {
            return invalidCover(
                this,
                'Cover initialization requires one live builder from the owning runtime.',
                { runtimeId: this.runtime.id, submitted: false },
                { runtimeId: builder?.runtime?.id, submitted: builder?.isSubmitted }
            )
        }
        for (const command of this.#initializationClears) builder.clear(command)
        for (const command of this.#initializationUploads) builder.upload(command)
        return builder
    }

    writeView(view: GeoViewSnapshot): GpuWebMercatorQuadCoverViewToken {

        this.#assertActive()
        validateView(view)
        const sequenceStamp = this.#sequenceAuthority.stamp()
        const parity = (sequenceStamp.revision & 1) as 0 | 1
        const template = this.#templates[parity]
        const command = this.runtime.createUploadCommand({
            label: `Upload GPU WebMercatorQuad cover view ${view.frameEpoch}`,
            target: template.resources.mapMeta.region({
                layout: gpuWebMercatorQuadCoverMapMetaCodec.artifact,
            }),
            data: gpuWebMercatorQuadCoverMapMetaCodec.uploadView(
                mapMetaRecord(this.descriptor.spatialProfile, view)
            ),
        })
        let viewStamp: SubmissionAuthorityStamp
        try {
            viewStamp = this.#viewAuthority.advance()
        } catch (error) {
            command.dispose()
            throw error
        }
        const record: ViewRecord = {
            owner: this,
            command,
            viewStamp,
            sequenceStamp,
            parity,
            disposed: false,
        }
        const token = Object.freeze({
            kind: 'gpu-web-mercator-quad-cover-view-token' as const,
            coverId: this.id,
            frameEpoch: view.frameEpoch,
            residencySnapshotEpoch: view.residencySnapshotEpoch,
            parity,
            get isDisposed() { return record.disposed },
            dispose: () => {
                if (record.disposed) return
                record.disposed = true
                this.#views.delete(record)
                command.dispose()
            },
        })
        this.#views.add(record)
        viewRecords.set(token, record)
        return token
    }

    frame(token: GpuWebMercatorQuadCoverViewToken): GpuWebMercatorQuadCoverFrame {

        this.#assertActive()
        const record = viewRecords.get(token)
        if (record?.owner !== this || record.disposed || record.command.isDisposed ||
            token.coverId !== this.id ||
            record.viewStamp.revision !== this.#viewAuthority.revision ||
            record.sequenceStamp.revision !== this.#sequenceAuthority.revision) {
            return invalidCover(
                this,
                'Cover frame creation requires the current live owned view token.',
                {
                    coverId: this.id,
                    viewRevision: this.#viewAuthority.revision,
                    sequenceRevision: this.#sequenceAuthority.revision,
                },
                {
                    coverId: token?.coverId,
                    viewRevision: record?.viewStamp.revision,
                    sequenceRevision: record?.sequenceStamp.revision,
                    disposed: record?.disposed ?? record?.command?.isDisposed,
                }
            )
        }
        const template = this.#templates[record.parity]
        const frame = Object.freeze({
            kind: 'gpu-web-mercator-quad-cover-frame' as const,
            coverId: this.id,
            frameEpoch: token.frameEpoch,
            residencySnapshotEpoch: token.residencySnapshotEpoch,
            parity: record.parity,
            visibleInstances: template.resources.patches,
        })
        frameRecords.set(frame, Object.freeze({
            owner: this,
            view: record,
            template,
        }))
        return frame
    }

    encode(
        builder: SubmissionBuilder,
        frame: GpuWebMercatorQuadCoverFrame
    ): SubmissionBuilder {

        this.#assertActive()
        const record = frameRecords.get(frame)
        if (builder?.runtime !== this.runtime || builder.isSubmitted ||
            encodedBuilders.has(builder) || record?.owner !== this ||
            frame.coverId !== this.id || record.view.disposed ||
            record.view.command.isDisposed ||
            record.view.viewStamp.revision !== this.#viewAuthority.revision ||
            record.view.sequenceStamp.revision !== this.#sequenceAuthority.revision) {
            return invalidCover(
                this,
                'Cover encoding requires one current owned frame and live builder.',
                {
                    coverId: this.id,
                    runtimeId: this.runtime.id,
                    submitted: false,
                },
                {
                    coverId: frame?.coverId,
                    runtimeId: builder?.runtime?.id,
                    submitted: builder?.isSubmitted,
                }
            )
        }
        builder.require(record.view.viewStamp)
        builder.upload(record.view.command)
        builder.compute(this.#pass, [ record.template.commands.generate ])
        builder.consume(record.view.sequenceStamp)
        encodedBuilders.set(builder, frame)
        return builder
    }

    capture(
        builder: SubmissionBuilder,
        frame: GpuWebMercatorQuadCoverFrame
    ): SubmissionBuilder {

        this.#assertActive()
        const record = frameRecords.get(frame)
        if (builder?.runtime !== this.runtime || builder.isSubmitted ||
            encodedBuilders.get(builder) !== frame || capturedBuilders.has(builder) ||
            record?.owner !== this) {
            return invalidCover(
                this,
                'Cover feedback capture requires its matching encoded frame.',
                { coverId: this.id, encoded: true, captured: false },
                {
                    coverId: frame?.coverId,
                    encoded: encodedBuilders.get(builder)?.coverId,
                    captured: capturedBuilders.has(builder),
                }
            )
        }
        capturedBuilders.add(builder)
        builder.readback(record.template.commands.stateFeedback)
        builder.readback(record.template.commands.demandFeedback)
        return builder
    }

    async feedback(
        frame: GpuWebMercatorQuadCoverFrame,
        submitted: SubmittedWork
    ): Promise<GpuWebMercatorQuadCoverFeedback> {

        this.#assertActive()
        const record = frameRecords.get(frame)
        if (record?.owner !== this || submitted?.runtime !== this.runtime ||
            frame.coverId !== this.id) {
            return invalidCover(
                this,
                'Cover feedback requires one owned frame submission.',
                { coverId: this.id, runtimeId: this.runtime.id },
                { coverId: frame?.coverId, runtimeId: submitted?.runtime?.id }
            )
        }
        const commands = record.template.commands
        for (const command of [ commands.stateFeedback, commands.demandFeedback ]) {
            if (!submitted.readbacks.some(link => link.commandId === command.id)) {
                return invalidCover(
                    this,
                    'Cover feedback submission is missing a required readback.',
                    { commandId: command.id },
                    { readbackCommandIds: submitted.readbacks.map(link => link.commandId) }
                )
            }
        }
        const [ stateBytes, demandBytes ] = await Promise.all([
            commands.stateFeedback.result({ after: submitted }).toBytes(),
            commands.demandFeedback.result({ after: submitted }).toBytes(),
        ])
        const decoded = decodeGpuWebMercatorQuadCoverFeedback(stateBytes, demandBytes, {
            expectedFrameEpoch: frame.frameEpoch,
            maximumPatches: this.descriptor.policy.maximumPatches,
            sourceLevelCeiling: this.descriptor.policy.sourceMaximumMatrixLevel,
        })
        return Object.freeze({
            kind: 'gpu-web-mercator-quad-cover-feedback' as const,
            coverId: this.id,
            submissionId: submitted.id,
            ...decoded,
        })
    }

    renderTemplates(): readonly [
        GpuWebMercatorQuadCoverRenderTemplate,
        GpuWebMercatorQuadCoverRenderTemplate,
    ] {

        this.#assertActive()
        return Object.freeze(this.#templates.map(template =>
            template.renderTemplate
        )) as unknown as readonly [
            GpuWebMercatorQuadCoverRenderTemplate,
            GpuWebMercatorQuadCoverRenderTemplate,
        ]
    }

    commandsFor(frame: GpuWebMercatorQuadCoverFrame): GpuWebMercatorQuadCoverCommands {

        this.#assertActive()
        const record = frameRecords.get(frame)
        if (record?.owner !== this) {
            return invalidCover(
                this,
                'Cover commands require one owned frame.',
                { coverId: this.id },
                { coverId: frame?.coverId }
            )
        }
        return record.template.commands
    }

    facts(): GpuWebMercatorQuadCoverFacts {

        return Object.freeze({
            id: this.id,
            runtimeId: this.runtime.id,
            selectionPath: 'gpu-camera-inverse-webmercatorquad-cover' as const,
            disposed: this.#disposed,
            policy: this.descriptor.policy,
            lookupCapacity: this.#lookupCapacity,
            coverageLimitCount: this.descriptor.spatialProfile.coverage.limits.length,
            parity: Object.freeze(this.#templates.map(template => Object.freeze({
                parity: template.resources.parity,
                mapMetaBufferId: template.resources.mapMeta.id,
                patchBufferId: template.resources.patches.id,
                lookupBufferId: template.resources.lookup.id,
                stateBufferId: template.resources.state.id,
                demandBufferId: template.resources.demands.id,
                drawArgumentBufferId: template.resources.drawArguments.id,
                commandIds: Object.freeze([
                    template.commands.generate.id,
                    template.commands.stateFeedback.id,
                    template.commands.demandFeedback.id,
                ]),
            }))),
        })
    }

    identityObjects(): GpuWebMercatorQuadCoverIdentityObjects {

        this.#assertActive()
        return this.#identity
    }

    dispose(): void {

        if (this.#disposed) return
        this.#disposed = true
        for (const view of [ ...this.#views ]) {
            view.disposed = true
            view.command.dispose()
        }
        this.#views.clear()
        this.#viewAuthority.dispose()
        this.#sequenceAuthority.dispose()
        disposeReverse(this.#owned)
    }

    #assertActive(): void {

        if (this.#disposed) {
            return invalidCover(
                this,
                'GPU WebMercatorQuad cover is disposed.',
                { disposed: false },
                { disposed: true }
            )
        }
    }
}

Object.freeze(GpuWebMercatorQuadCover.prototype)

/** Decodes and validates bounded inverse-cover state and desired-page feedback. */
export function decodeGpuWebMercatorQuadCoverFeedback(
    stateBytes: Uint8Array,
    demandBytes: Uint8Array,
    options: Readonly<{
        expectedFrameEpoch: number
        maximumPatches: number
        sourceLevelCeiling: number
    }>
): Readonly<GpuWebMercatorQuadCoverSelectionFacts & {
    demands: readonly GpuWebMercatorQuadCoverDemand[]
}> {

    const stateSize = gpuWebMercatorQuadCoverStateCodec.byteLength()
    const demandStride = gpuWebMercatorQuadCoverDemandCodec.byteLength()
    if (!(stateBytes instanceof Uint8Array) || stateBytes.byteLength !== stateSize ||
        !(demandBytes instanceof Uint8Array) ||
        demandBytes.byteLength % demandStride !== 0) {
        throw new TypeError('GPU WebMercatorQuad cover feedback byte lengths are invalid')
    }
    const demandCapacity = demandBytes.byteLength / demandStride
    const state = new DataView(
        stateBytes.buffer,
        stateBytes.byteOffset,
        stateBytes.byteLength
    )
    const word = (index: number) => state.getUint32(index * 4, true)
    const frameEpoch = word(0)
    const candidateCount = word(1)
    const patchCount = word(2)
    const demandCount = word(3)
    const descriptorOverflowCount = word(4)
    const lookupOverflowCount = word(5)
    const demandOverflowCount = word(6)
    const minimumMatrixLevel = word(7)
    const maximumMatrixLevel = word(8)
    const maximumAdjacentLevelDelta = word(9)
    const finestMatrixLevel = word(10)
    const sourceLevelCeiling = word(11)
    const selectionModeWord = word(12)
    const minimumCellSpanQ8 = word(13)
    const maximumCellSpanQ8 = word(14)
    const selectionMode = selectionModeWord === 0
        ? 'uniform' as const
        : selectionModeWord === 1
            ? 'variable' as const
            : undefined
    if (frameEpoch !== options.expectedFrameEpoch ||
        patchCount > options.maximumPatches ||
        demandCount > demandCapacity ||
        descriptorOverflowCount !== 0 ||
        lookupOverflowCount !== 0 ||
        demandOverflowCount !== 0 ||
        maximumAdjacentLevelDelta > 1 ||
        selectionMode === undefined ||
        minimumCellSpanQ8 > maximumCellSpanQ8 ||
        sourceLevelCeiling !== options.sourceLevelCeiling ||
        (patchCount > 0 && (
            minimumMatrixLevel === 0xffff_ffff ||
            minimumMatrixLevel > maximumMatrixLevel ||
            maximumMatrixLevel > finestMatrixLevel
        ))) {
        throw new RangeError(`GPU WebMercatorQuad cover feedback is inconsistent: ${JSON.stringify({
            frameEpoch,
            candidateCount,
            patchCount,
            demandCount,
            descriptorOverflowCount,
            lookupOverflowCount,
            demandOverflowCount,
            minimumMatrixLevel,
            maximumMatrixLevel,
            maximumAdjacentLevelDelta,
            finestMatrixLevel,
            sourceLevelCeiling,
            selectionModeWord,
            minimumCellSpanQ8,
            maximumCellSpanQ8,
        })}`)
    }
    const demandView = new DataView(
        demandBytes.buffer,
        demandBytes.byteOffset,
        demandBytes.byteLength
    )
    const demands = Array.from({ length: demandCount }, (_, index) => {
        const base = index * demandStride
        return Object.freeze({
            desiredSampleLevel: demandView.getUint32(base, true),
            sourceLevelCeiling: demandView.getUint32(base + 4, true),
            requestMatrixLevel: demandView.getUint32(base + 8, true),
            tileRow: demandView.getUint32(base + 12, true),
            tileCol: demandView.getUint32(base + 16, true),
            priority: demandView.getUint32(base + 20, true),
            decisionFrameEpoch: demandView.getUint32(base + 24, true),
            residencySnapshotEpoch: demandView.getUint32(base + 28, true),
        })
    })
    const facts: {
        frameEpoch: number
        candidateCount: number
        patchCount: number
        demandCount: number
        descriptorOverflowCount: number
        lookupOverflowCount: number
        demandOverflowCount: number
        maximumAdjacentLevelDelta: number
        finestMatrixLevel: number
        sourceLevelCeiling: number
        selectionMode: 'uniform' | 'variable'
        minimumMatrixLevel?: number
        maximumMatrixLevel?: number
        minimumCellSpanPixels?: number
        maximumCellSpanPixels?: number
    } = {
        frameEpoch,
        candidateCount,
        patchCount,
        demandCount,
        descriptorOverflowCount,
        lookupOverflowCount,
        demandOverflowCount,
        maximumAdjacentLevelDelta,
        finestMatrixLevel,
        sourceLevelCeiling,
        selectionMode,
    }
    if (patchCount > 0) {
        facts.minimumMatrixLevel = minimumMatrixLevel
        facts.maximumMatrixLevel = maximumMatrixLevel
        facts.minimumCellSpanPixels = minimumCellSpanQ8 / 256
        facts.maximumCellSpanPixels = maximumCellSpanQ8 / 256
    }
    return Object.freeze({
        ...facts,
        demands: Object.freeze(demands),
    })
}

function snapshotDescriptor(
    runtime: GPURuntime,
    input: GpuWebMercatorQuadCoverDescriptor
): GpuWebMercatorQuadCoverDescriptor {

    if (runtime === undefined || typeof runtime.createBuffer !== 'function') {
        throw new TypeError('GPU WebMercatorQuad cover requires GPURuntime')
    }
    const spatialProfile = input?.spatialProfile
    if (spatialProfile?.kind !== 'tile-spatial-profile' ||
        spatialProfile.coverage?.tileMatrixSet !== WebMercatorQuad ||
        spatialProfile.addressCodec?.coverage !== spatialProfile.coverage) {
        return throwGeoDiagnostic({
            code: 'GEO_WEB_MERCATOR_COVER_PROFILE_INVALID',
            phase: 'selection',
            subject: { kind: 'web-mercator-quad-cover' },
            message: 'A GPU WebMercatorQuad cover requires one matching WebMercator planar profile.',
            expected: { tileMatrixSetId: WebMercatorQuad.id },
            actual: {
                kind: spatialProfile?.kind,
                tileMatrixSetId: spatialProfile?.coverage?.tileMatrixSet?.id,
            },
        })
    }
    const policy = gpuWebMercatorQuadCoverPolicy(input.policy)
    const expectedLimitCount =
        policy.sourceMaximumMatrixLevel - policy.minimumMatrixLevel + 1
    const limits = spatialProfile.coverage.limits
    const contiguousLimits = limits.length === expectedLimitCount &&
        limits.every((limit, index) =>
            Number(limit.matrixId) === policy.minimumMatrixLevel + index
        )
    if (!contiguousLimits ||
        policy.maximumMatrixLevel >= spatialProfile.coordinateBits ||
        input.elevationRangeMeters?.length !== 2 ||
        input.elevationRangeMeters.some(value => !Number.isFinite(value)) ||
        input.elevationRangeMeters[0] > input.elevationRangeMeters[1] ||
        !positiveSafeInteger(input.vertexCount)) {
        return throwGeoDiagnostic({
            code: 'GEO_WEB_MERCATOR_COVER_DESCRIPTOR_INVALID',
            phase: 'selection',
            subject: { kind: 'web-mercator-quad-cover' },
            message: 'GPU WebMercatorQuad cover descriptor facts are inconsistent.',
            expected: {
                contiguousCoverageLevels: [
                    policy.minimumMatrixLevel,
                    policy.sourceMaximumMatrixLevel,
                ],
                maximumMatrixLevel: `< coordinateBits ${spatialProfile.coordinateBits}`,
                elevationRangeMeters: 'ordered finite pair',
                vertexCount: 'positive safe integer',
            },
            actual: input,
        })
    }
    return Object.freeze({
        spatialProfile,
        policy,
        elevationRangeMeters: Object.freeze([
            input.elevationRangeMeters[0],
            input.elevationRangeMeters[1],
        ]) as readonly [number, number],
        vertexCount: input.vertexCount,
    })
}

function validateView(view: GeoViewSnapshot): void {

    if (view?.kind !== 'geo-view-snapshot') {
        throw new TypeError('GPU WebMercatorQuad cover requires GeoViewSnapshot')
    }
}

function mapMetaRecord(
    profile: WebMercatorPlanarTileSpatialProfile,
    view: GeoViewSnapshot
): Record<string, unknown> {

    const matrix = view.clipFromRelativeWorld
    const camera = profile.encodeCamera([
        view.cameraHigh[0] + view.cameraLow[0],
        view.cameraHigh[1] + view.cameraLow[1],
    ])
    return {
        clipFromRelativeWorld: [
            [ matrix[0], matrix[1], matrix[2], matrix[3] ],
            [ matrix[4], matrix[5], matrix[6], matrix[7] ],
            [ matrix[8], matrix[9], matrix[10], matrix[11] ],
            [ matrix[12], matrix[13], matrix[14], matrix[15] ],
        ],
        cameraHigh: view.cameraHigh,
        cameraLow: view.cameraLow,
        cameraFixedLow: camera.low,
        cameraFixedHigh: camera.high,
        referenceViewport: view.referenceViewport,
        verticalFovRadians: view.verticalFovRadians,
        cameraLatitudeRadians: view.cameraLatitudeRadians,
        zoomHint: view.zoomHint,
        frameEpoch: view.frameEpoch,
        residencySnapshotEpoch: view.residencySnapshotEpoch,
        cameraPitchRadians: view.cameraPitchRadians,
    }
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

function nextPowerOfTwo(value: number): number {

    let result = 1
    while (result < value) result *= 2
    if (!Number.isSafeInteger(result) || result > 0x4000_0000) {
        throw new RangeError('GPU WebMercatorQuad cover lookup capacity is unsupported')
    }
    return result
}

function checkedProduct(left: number, right: number): number {

    const result = left * right
    if (!Number.isSafeInteger(result) || result <= 0 || result > 0xffff_ffff) {
        throw new RangeError('GPU WebMercatorQuad cover buffer size exceeds u32 bounds')
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

function invalidCover(
    cover: Pick<GpuWebMercatorQuadCover, 'id'>,
    message: string,
    expected: unknown,
    actual: unknown
): never {

    return throwGeoDiagnostic({
        code: 'GEO_WEB_MERCATOR_COVER_INVALID',
        phase: 'selection',
        subject: { kind: 'web-mercator-quad-cover', id: cover.id },
        message,
        expected,
        actual,
    })
}
