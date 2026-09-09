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
    type SubmissionAuthority,
    type SubmissionAuthorityStamp,
    type SubmissionBuilder,
    type SubmittedWork,
    type UploadCommand,
} from '../scratch/index.js'
import { throwGeoDiagnostic } from './diagnostics.js'
import type { GeoViewSnapshot } from './geo-view.js'
import {
    gpuWebMercatorQuadCoverLimitCodec,
    gpuWebMercatorQuadCoverLookupEntryCodec,
    gpuWebMercatorQuadCoverMapMetaCodec,
    gpuWebMercatorQuadCoverPatchCodec,
    gpuWebMercatorQuadCoverPolicyCodec,
    gpuWebMercatorQuadCoverSharedWgslModule,
    gpuWebMercatorQuadCoverStateCodec,
    gpuWebMercatorQuadCoverVerticalBoundsCodec,
} from './gpu-web-mercator-quad-cover-layout.js'
import { gpuWebMercatorQuadCoverCandidates } from './gpu-web-mercator-quad-cover-candidates.js'
import { GPU_WEB_MERCATOR_QUAD_COVER_NEIGHBORS_WGSL } from './gpu-web-mercator-quad-cover-neighbors-wgsl.js'
import { GPU_WEB_MERCATOR_QUAD_COVER_WGSL } from './gpu-web-mercator-quad-cover-wgsl.js'
import type { WebMercatorPlanarTileSpatialProfile } from './tile-spatial-profile.js'
import { WebMercatorQuad } from './web-mercator-quad.js'

const BUFFER_COPY_DST = 0x08
const BUFFER_COPY_SRC = 0x04
const BUFFER_UNIFORM = 0x40
const BUFFER_STORAGE = 0x80
const BUFFER_INDIRECT = 0x100

type Disposable = { dispose(): void }
type BufferBindingType = 'uniform' | 'read-storage' | 'storage'

/** Immutable conservative vertical range for one standard WebMercatorQuad tile. */
export type WebMercatorTileVerticalBounds = Readonly<{
    matrixLevel: number
    tileRow: number
    tileCol: number
    minimumVerticalMeters: number
    maximumVerticalMeters: number
}>

export type GpuWebMercatorQuadCoverPolicy = Readonly<{
    minimumMatrixLevel: number
    maximumMatrixLevel: number
    maximumPatches: number
    cellsPerPatchEdge: number
    maximumCellSpanReferencePixels: number
    refinementTolerance: number
}>

export type GpuWebMercatorQuadCoverDescriptor = Readonly<{
    spatialProfile: WebMercatorPlanarTileSpatialProfile
    policy: GpuWebMercatorQuadCoverPolicy
    verticalRangeMeters: readonly [number, number]
    /** Hard input enumeration budget; defaults to max(16384, 64 * maximumPatches). */
    maximumCandidates?: number
    verticalBounds?: readonly WebMercatorTileVerticalBounds[]
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
    patches: BufferResource
}>

export type GpuWebMercatorQuadCoverTemplate = Readonly<{
    coverId: string
    parity: 0 | 1
    mapMeta: BufferResource
    patches: BufferResource
    coverLookup: BufferResource
    state: BufferResource
}>

export type GpuWebMercatorQuadCoverSelectionFacts = Readonly<{
    frameEpoch: number
    candidateCount: number
    patchCount: number
    descriptorOverflowCount: number
    lookupOverflowCount: number
    minimumMatrixLevel?: number
    maximumMatrixLevel?: number
    maximumAdjacentLevelDelta: number
    finestMatrixLevel: number
    minimumCellSpanReferencePixels?: number
    maximumCellSpanReferencePixels?: number
}>

export type GpuWebMercatorQuadCoverFeedback =
    GpuWebMercatorQuadCoverSelectionFacts & Readonly<{
        kind: 'gpu-web-mercator-quad-cover-feedback'
        coverId: string
        submissionId: string
    }>

export type GpuWebMercatorQuadCoverCommands = Readonly<{
    evaluate: DispatchCommand
    generate: DispatchCommand
    stateFeedback: ReadbackCommand
}>

export type GpuWebMercatorQuadCoverFacts = Readonly<{
    id: string
    runtimeId: string
    selectionPath: 'gpu-camera-inverse-webmercatorquad-cover'
    disposed: boolean
    policy: GpuWebMercatorQuadCoverPolicy
    lookupCapacity: number
    candidateCapacity: number
    candidateWorkspaceBytes: number
    coverageLimitCount: number
    verticalBoundsMode: 'global' | 'hierarchy'
    verticalBoundCount: number
    verticalBoundsBufferId: string
    parity: readonly Readonly<{
        parity: 0 | 1
        mapMetaBufferId: string
        patchBufferId: string
        lookupBufferId: string
        stateBufferId: string
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
    candidates: BufferResource
}>

type ParityTemplate = Readonly<{
    resources: ParityResources
    bindSet: BindSet
    evaluateBindSet: BindSet
    commands: GpuWebMercatorQuadCoverCommands
    template: GpuWebMercatorQuadCoverTemplate
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
 * Validates immutable projected-cell quality and capacity facts for one
 * camera-derived standard WebMercatorQuad cover.
 */
export function gpuWebMercatorQuadCoverPolicy(
    input: GpuWebMercatorQuadCoverPolicy
): GpuWebMercatorQuadCoverPolicy {

    if (!level(input?.minimumMatrixLevel) ||
        !level(input?.maximumMatrixLevel) ||
        input.minimumMatrixLevel > input.maximumMatrixLevel ||
        !positiveSafeInteger(input.maximumPatches) ||
        !positiveSafeInteger(input.cellsPerPatchEdge) ||
        !positiveFinite(input.maximumCellSpanReferencePixels) ||
        !Number.isFinite(input.refinementTolerance) ||
        input.refinementTolerance < 0 || input.refinementTolerance > 0.1) {
        return throwGeoDiagnostic({
            code: 'GEO_WEB_MERCATOR_COVER_POLICY_INVALID',
            phase: 'selection',
            subject: { kind: 'web-mercator-quad-cover' },
            message: 'A WebMercatorQuad cover policy requires ordered levels, projected-cell quality, and a positive patch capacity.',
            expected: {
                levels: '0 <= minimum <= maximum <= 24',
                maximumPatches: 'positive safe integer',
                cellsPerPatchEdge: 'positive safe integer',
                maximumCellSpanReferencePixels: 'positive finite number',
                refinementTolerance: '[0, 0.1]',
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

function nonNegativeSafeInteger(value: number): boolean {

    return Number.isSafeInteger(value) && value >= 0
}

function positiveFinite(value: number): boolean {

    return Number.isFinite(value) && value > 0
}

/** Owns the bounded GPU graph that derives one standard WebMercatorQuad view cover. */
export class GpuWebMercatorQuadCover {

    readonly runtime: GPURuntime
    readonly id: string
    readonly descriptor: GpuWebMercatorQuadCoverDescriptor
    readonly #verticalBounds: BufferResource
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
            verticalBounds: BufferResource
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
        this.#verticalBounds = state.verticalBounds
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
        let verticalBoundsOffset = 0
        const limits = descriptor.spatialProfile.coverage.limits.map(limit => {
            const record = {
                minTileRow: limit.minTileRow,
                maxTileRow: limit.maxTileRow,
                minTileCol: limit.minTileCol,
                maxTileCol: limit.maxTileCol,
                verticalBoundsOffset,
            }
            verticalBoundsOffset += (limit.maxTileRow - limit.minTileRow + 1) *
                (limit.maxTileCol - limit.minTileCol + 1)
            return record
        })
        const verticalBoundsMode = descriptor.verticalBounds === undefined
            ? 'global' as const
            : 'hierarchy' as const
        const verticalBoundRecords = descriptor.verticalBounds?.map(bounds => ({
            minimumVerticalMeters: bounds.minimumVerticalMeters,
            maximumVerticalMeters: bounds.maximumVerticalMeters,
        })) ?? [ {
            minimumVerticalMeters: descriptor.verticalRangeMeters[0],
            maximumVerticalMeters: descriptor.verticalRangeMeters[1],
        } ]
        const patchBytes = checkedProduct(
            descriptor.policy.maximumPatches,
            gpuWebMercatorQuadCoverPatchCodec.byteLength()
        )
        const lookupBytes = checkedProduct(
            lookupCapacity,
            gpuWebMercatorQuadCoverLookupEntryCodec.byteLength()
        )
        const candidateBytes = checkedProduct(
            Math.max(descriptor.maximumCandidates!, descriptor.policy.maximumPatches), 4
        )
        const closureRounds = descriptor.policy.maximumPatches * (
            descriptor.policy.maximumMatrixLevel - descriptor.policy.minimumMatrixLevel + 1
        )
        if (!Number.isSafeInteger(closureRounds) || closureRounds > 0xffff_ffff) {
            return throwGeoDiagnostic({
                code: 'GEO_WEB_MERCATOR_COVER_CLOSURE_BUDGET_INVALID',
                phase: 'selection', subject: { kind: 'web-mercator-quad-cover' },
                message: 'The indexed closure work budget must fit a u32 counter.',
                expected: { maximumRounds: 'u32' }, actual: { maximumRounds: closureRounds },
            })
        }
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
                label: 'GPU WebMercatorQuad geometry coverage limits',
                size: limits.length * gpuWebMercatorQuadCoverLimitCodec.byteLength(),
                usage: BUFFER_COPY_DST | BUFFER_STORAGE,
            }))
            const verticalBoundsBuffer = own(await runtime.createBuffer({
                label: 'GPU WebMercatorQuad vertical bounds',
                size: verticalBoundRecords.length *
                    gpuWebMercatorQuadCoverVerticalBoundsCodec.byteLength(),
                usage: BUFFER_COPY_DST | BUFFER_STORAGE,
            }))
            const policyUpload = own(runtime.createUploadCommand({
                label: 'Upload GPU WebMercatorQuad cover policy',
                target: policy.region({
                    layout: gpuWebMercatorQuadCoverPolicyCodec.artifact,
                }),
                data: gpuWebMercatorQuadCoverPolicyCodec.pack({
                    ...descriptor.policy,
                    coordinateBits: descriptor.spatialProfile.coordinateBits,
                    lookupCapacity,
                    boundsMaximumMatrixLevel: Number(
                        descriptor.spatialProfile.coverage.limits.at(-1)!.matrixId
                    ),
                    verticalBoundsMode: verticalBoundsMode === 'hierarchy' ? 1 : 0,
                    minimumVerticalMeters: descriptor.verticalRangeMeters[0],
                    maximumVerticalMeters: descriptor.verticalRangeMeters[1],
                }),
            }))
            const limitsUpload = own(runtime.createUploadCommand({
                label: 'Upload GPU WebMercatorQuad geometry coverage limits',
                target: coverageLimits.region({
                    layout: gpuWebMercatorQuadCoverLimitCodec.artifact,
                }),
                data: gpuWebMercatorQuadCoverLimitCodec.uploadView(limits),
            }))
            const verticalBoundsUpload = own(runtime.createUploadCommand({
                label: 'Upload GPU WebMercatorQuad vertical bounds',
                target: verticalBoundsBuffer.region({
                    layout: gpuWebMercatorQuadCoverVerticalBoundsCodec.artifact,
                }),
                data: gpuWebMercatorQuadCoverVerticalBoundsCodec.uploadView(
                    verticalBoundRecords
                ),
            }))
            const parityResources = await settleCoverCreation([ 0, 1 ].map(
                async parityValue => {
                    const parity = parityValue as 0 | 1
                    return Object.freeze({
                        parity,
                        mapMeta: own(await runtime.createBuffer({
                            label: `GPU WebMercatorQuad cover map metadata ${parity}`,
                            size: gpuWebMercatorQuadCoverMapMetaCodec.byteLength(),
                            usage: BUFFER_COPY_DST | BUFFER_UNIFORM | BUFFER_INDIRECT,
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
                        candidates: own(await runtime.createBuffer({
                            label: `GPU WebMercatorQuad candidate workspace ${parity}`,
                            size: candidateBytes,
                            usage: BUFFER_COPY_DST | BUFFER_STORAGE,
                        })),
                        state: own(await runtime.createBuffer({
                            label: `GPU WebMercatorQuad cover state ${parity}`,
                            size: gpuWebMercatorQuadCoverStateCodec.byteLength(),
                            usage: BUFFER_COPY_DST | BUFFER_COPY_SRC | BUFFER_STORAGE,
                        })),
                    }) satisfies ParityResources
                }
            )) as unknown as readonly [ParityResources, ParityResources]
            const initializationClears = Object.freeze(parityResources.flatMap(resources => [
                resources.patches,
                resources.lookup,
                resources.state,
                resources.candidates,
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
                            gpuWebMercatorQuadCoverVerticalBoundsCodec.wgslAccessors({
                                namespace: 'GpuWebMercatorQuadCoverVerticalBounds',
                            }),
                            gpuWebMercatorQuadCoverLookupEntryCodec.wgslAccessors({
                                namespace: 'GpuWebMercatorQuadCoverLookupEntry',
                            }),
                            gpuWebMercatorQuadCoverStateCodec.wgslAccessors({
                                namespace: 'GpuWebMercatorQuadCoverState',
                            }),
                        ].join('\n'),
                        layoutDependencies: [
                            ...shared.layoutDependencies,
                            gpuWebMercatorQuadCoverPolicyCodec.artifact,
                            gpuWebMercatorQuadCoverLimitCodec.artifact,
                            gpuWebMercatorQuadCoverVerticalBoundsCodec.artifact,
                            gpuWebMercatorQuadCoverLookupEntryCodec.artifact,
                            gpuWebMercatorQuadCoverStateCodec.artifact,
                        ],
                    },
                    {
                        label: 'GPU WebMercatorQuad inverse-cover kernel',
                        code: GPU_WEB_MERCATOR_QUAD_COVER_WGSL +
                            GPU_WEB_MERCATOR_QUAD_COVER_NEIGHBORS_WGSL,
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
                    binding(
                        3,
                        'verticalBounds',
                        'read-storage',
                        verticalBoundsBuffer.size
                    ),
                    binding(4, 'coverPatches', 'storage', patchBytes),
                    binding(5, 'coverLookup', 'storage', lookupBytes),
                    binding(
                        6,
                        'coverState',
                        'storage',
                        gpuWebMercatorQuadCoverStateCodec.byteLength()
                    ),
                    binding(7, 'coverCandidates', 'storage', candidateBytes),
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
            const evaluateLayout = own(await runtime.createBindLayout({
                label: 'GPU WebMercatorQuad candidate evaluation layout',
                group: 0,
                entries: [
                    binding(0, 'mapMeta', 'uniform', gpuWebMercatorQuadCoverMapMetaCodec.byteLength()),
                    binding(1, 'coverPolicy', 'uniform', gpuWebMercatorQuadCoverPolicyCodec.byteLength()),
                    binding(2, 'coverageLimits', 'read-storage', coverageLimits.size),
                    binding(3, 'verticalBounds', 'read-storage', verticalBoundsBuffer.size),
                    binding(7, 'coverCandidates', 'storage', candidateBytes),
                ],
            }))
            const evaluateProgram = own(runtime.createProgram({
                label: 'GPU WebMercatorQuad candidate evaluation program',
                compute: { module: shader, entryPoint: 'evaluateWebMercatorQuadCandidates' },
            }))
            const evaluatePipeline = own(await runtime.createComputePipeline({
                label: 'GPU WebMercatorQuad parallel candidate pipeline',
                program: evaluateProgram,
                layout: { mode: 'explicit', bindLayouts: [ evaluateLayout ] },
            }))
            const pass = own(runtime.createComputePass({
                label: 'GPU WebMercatorQuad inverse-cover stage',
            }))
            const templates = await settleCoverCreation(parityResources.map(
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
                        verticalBounds: verticalBoundsBuffer.region({
                            layout: gpuWebMercatorQuadCoverVerticalBoundsCodec.artifact,
                        }),
                        coverPatches: resources.patches.region({
                            layout: gpuWebMercatorQuadCoverPatchCodec.artifact,
                        }),
                        coverLookup: resources.lookup.region({
                            layout: gpuWebMercatorQuadCoverLookupEntryCodec.artifact,
                        }),
                        coverCandidates: resources.candidates.region(),
                        coverState: resources.state.region({
                            layout: gpuWebMercatorQuadCoverStateCodec.artifact,
                        }),
                    }, {
                        label: `GPU WebMercatorQuad inverse-cover bindings ${resources.parity}`,
                    }))
                    const evaluateBindSet = own(await runtime.createBindSet(evaluateLayout, {
                        mapMeta: resources.mapMeta.region({ layout: gpuWebMercatorQuadCoverMapMetaCodec.artifact }),
                        coverPolicy: policy.region({ layout: gpuWebMercatorQuadCoverPolicyCodec.artifact }),
                        coverageLimits: coverageLimits.region({ layout: gpuWebMercatorQuadCoverLimitCodec.artifact }),
                        verticalBounds: verticalBoundsBuffer.region({ layout: gpuWebMercatorQuadCoverVerticalBoundsCodec.artifact }),
                        coverCandidates: resources.candidates.region(),
                    }, { label: `GPU WebMercatorQuad candidate bindings ${resources.parity}` }))
                    const evaluate = own(runtime.createDispatchCommand({
                        label: `Evaluate GPU WebMercatorQuad candidates ${resources.parity}`,
                        pipeline: evaluatePipeline,
                        bindSets: [ { set: evaluateBindSet } ],
                        count: { indirect: resources.mapMeta.region({
                            offset: gpuWebMercatorQuadCoverMapMetaCodec.artifact.fields
                                .find(field => field.name === 'candidateDispatch')!.offset,
                            size: 12,
                        }) },
                        resources: currentAccess([
                            resources.mapMeta, policy, coverageLimits, verticalBoundsBuffer, resources.candidates,
                        ], [ resources.candidates ]),
                        whenMissing: 'throw',
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
                            verticalBoundsBuffer,
                            resources.patches,
                            resources.lookup,
                            resources.state,
                            resources.candidates,
                        ], [
                            resources.patches,
                            resources.lookup,
                            resources.state,
                            resources.candidates,
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
                    const template = {
                        coverId: '',
                        parity: resources.parity,
                        mapMeta: resources.mapMeta,
                        patches: resources.patches,
                        coverLookup: resources.lookup,
                        state: resources.state,
                    } as GpuWebMercatorQuadCoverTemplate
                    return Object.freeze({
                        resources,
                        bindSet,
                        evaluateBindSet,
                        commands: Object.freeze({
                            evaluate,
                            generate,
                            stateFeedback,
                        }),
                        template,
                    })
                }
            )) as unknown as readonly [ParityTemplate, ParityTemplate]
            const initializationUploads = Object.freeze([
                policyUpload,
                limitsUpload,
                verticalBoundsUpload,
            ])
            const identity: GpuWebMercatorQuadCoverIdentityObjects = Object.freeze({
                resources: Object.freeze([
                    policy,
                    coverageLimits,
                    verticalBoundsBuffer,
                    ...parityResources.flatMap(resources => [
                        resources.mapMeta,
                        resources.patches,
                        resources.lookup,
                        resources.state,
                        resources.candidates,
                    ]),
                ]),
                uploads: initializationUploads,
                bindLayouts: Object.freeze([ layout, evaluateLayout ]),
                bindSets: Object.freeze(templates.flatMap(template => [ template.bindSet, template.evaluateBindSet ])),
                programs: Object.freeze([ program, evaluateProgram ]),
                pipelines: Object.freeze([ pipeline, evaluatePipeline ]),
                passes: Object.freeze([ pass ]),
                commands: Object.freeze([
                    ...initializationClears,
                    ...templates.flatMap(template => [
                        template.commands.evaluate,
                        template.commands.generate,
                        template.commands.stateFeedback,
                    ]),
                ]),
            })
            const cover = new GpuWebMercatorQuadCover(runtime, descriptor, {
                verticalBounds: verticalBoundsBuffer,
                pass,
                templates,
                initializationClears,
                initializationUploads,
                identity,
                owned: Object.freeze([ ...owned ]),
                lookupCapacity,
            })
            for (const template of templates) {
                ;(template.template as { coverId: string }).coverId = cover.id
                Object.freeze(template.template)
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
        const metadata = mapMetaRecord(this.descriptor, view)
        const sequenceStamp = this.#sequenceAuthority.stamp()
        const parity = (sequenceStamp.revision & 1) as 0 | 1
        const template = this.#templates[parity]
        const command = this.runtime.createUploadCommand({
            label: `Upload GPU WebMercatorQuad cover view ${view.frameEpoch}`,
            target: template.resources.mapMeta.region({
                layout: gpuWebMercatorQuadCoverMapMetaCodec.artifact,
            }),
            data: gpuWebMercatorQuadCoverMapMetaCodec.uploadView(
                metadata
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
            patches: template.resources.patches,
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
        builder.compute(this.#pass, [
            record.template.commands.evaluate, record.template.commands.generate,
        ])
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
        if (!submitted.readbacks.some(link => link.commandId === commands.stateFeedback.id)) {
            return invalidCover(
                this,
                'Cover feedback submission is missing its state readback.',
                { commandId: commands.stateFeedback.id },
                { readbackCommandIds: submitted.readbacks.map(link => link.commandId) }
            )
        }
        const stateBytes = await commands.stateFeedback
            .result({ after: submitted }).toBytes()
        const decoded = decodeGpuWebMercatorQuadCoverFeedback(stateBytes, {
            expectedFrameEpoch: frame.frameEpoch,
            maximumPatches: this.descriptor.policy.maximumPatches,
        })
        return Object.freeze({
            kind: 'gpu-web-mercator-quad-cover-feedback' as const,
            coverId: this.id,
            submissionId: submitted.id,
            ...decoded,
        })
    }

    templates(): readonly [
        GpuWebMercatorQuadCoverTemplate,
        GpuWebMercatorQuadCoverTemplate,
    ] {

        this.#assertActive()
        return Object.freeze(this.#templates.map(template =>
            template.template
        )) as unknown as readonly [
            GpuWebMercatorQuadCoverTemplate,
            GpuWebMercatorQuadCoverTemplate,
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
            candidateCapacity: this.descriptor.maximumCandidates!,
            candidateWorkspaceBytes: 8 * Math.max(this.descriptor.maximumCandidates!,
                this.descriptor.policy.maximumPatches),
            coverageLimitCount: this.descriptor.spatialProfile.coverage.limits.length,
            verticalBoundsMode: this.descriptor.verticalBounds === undefined
                ? 'global' as const
                : 'hierarchy' as const,
            verticalBoundCount: this.descriptor.verticalBounds?.length ?? 0,
            verticalBoundsBufferId: this.#verticalBounds.id,
            parity: Object.freeze(this.#templates.map(template => Object.freeze({
                parity: template.resources.parity,
                mapMetaBufferId: template.resources.mapMeta.id,
                patchBufferId: template.resources.patches.id,
                lookupBufferId: template.resources.lookup.id,
                stateBufferId: template.resources.state.id,
                commandIds: Object.freeze([
                    template.commands.evaluate.id,
                    template.commands.generate.id,
                    template.commands.stateFeedback.id,
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

/** @internal Validates one same-builder downstream consumer of an encoded cover frame. */
export function assertGpuWebMercatorQuadCoverFrameEncoded(
    cover: GpuWebMercatorQuadCover,
    builder: SubmissionBuilder,
    frame: GpuWebMercatorQuadCoverFrame
): void {

    const record = frameRecords.get(frame)
    if (record?.owner !== cover || builder?.runtime !== cover.runtime ||
        builder.isSubmitted || encodedBuilders.get(builder) !== frame) {
        return invalidCover(
            cover,
            'A cover consumer requires its matching frame encoded in the same live builder.',
            { coverId: cover.id, runtimeId: cover.runtime.id, encoded: true },
            {
                coverId: frame?.coverId,
                runtimeId: builder?.runtime?.id,
                submitted: builder?.isSubmitted,
                encodedCoverId: encodedBuilders.get(builder)?.coverId,
            }
        )
    }
}

/** Validates bounded cover feedback and omits level/span ranges for a successful empty cut. */
export function decodeGpuWebMercatorQuadCoverFeedback(
    stateBytes: Uint8Array,
    options: Readonly<{
        expectedFrameEpoch: number
        maximumPatches: number
    }>
): GpuWebMercatorQuadCoverSelectionFacts {

    const stateSize = gpuWebMercatorQuadCoverStateCodec.byteLength()
    if (!(stateBytes instanceof Uint8Array) || stateBytes.byteLength !== stateSize) {
        throw new TypeError('GPU WebMercatorQuad cover feedback byte length is invalid')
    }
    const state = new DataView(
        stateBytes.buffer,
        stateBytes.byteOffset,
        stateBytes.byteLength
    )
    const word = (index: number) => state.getUint32(index * 4, true)
    const frameEpoch = word(0)
    const candidateCount = word(1)
    const patchCount = word(2)
    const descriptorOverflowCount = word(3)
    const lookupOverflowCount = word(4)
    const minimumMatrixLevel = word(5)
    const maximumMatrixLevel = word(6)
    const maximumAdjacentLevelDelta = word(7)
    const finestMatrixLevel = word(8)
    const minimumCellSpanQ8 = word(9)
    const maximumCellSpanQ8 = word(10)
    if (frameEpoch !== options.expectedFrameEpoch ||
        patchCount > options.maximumPatches ||
        descriptorOverflowCount !== 0 ||
        lookupOverflowCount !== 0 ||
        maximumAdjacentLevelDelta > 1 ||
        (patchCount > 0 && (
            minimumCellSpanQ8 > maximumCellSpanQ8 ||
            minimumMatrixLevel === 0xffff_ffff ||
            minimumMatrixLevel > maximumMatrixLevel ||
            maximumMatrixLevel > finestMatrixLevel
        ))) {
        throw new RangeError(`GPU WebMercatorQuad cover feedback is inconsistent: ${JSON.stringify({
            frameEpoch,
            candidateCount,
            patchCount,
            descriptorOverflowCount,
            lookupOverflowCount,
            minimumMatrixLevel,
            maximumMatrixLevel,
            maximumAdjacentLevelDelta,
            finestMatrixLevel,
            minimumCellSpanQ8,
            maximumCellSpanQ8,
        })}`)
    }
    const facts: {
        frameEpoch: number
        candidateCount: number
        patchCount: number
        descriptorOverflowCount: number
        lookupOverflowCount: number
        maximumAdjacentLevelDelta: number
        finestMatrixLevel: number
        minimumMatrixLevel?: number
        maximumMatrixLevel?: number
        minimumCellSpanReferencePixels?: number
        maximumCellSpanReferencePixels?: number
    } = {
        frameEpoch,
        candidateCount,
        patchCount,
        descriptorOverflowCount,
        lookupOverflowCount,
        maximumAdjacentLevelDelta,
        finestMatrixLevel,
    }
    if (patchCount > 0) {
        facts.minimumMatrixLevel = minimumMatrixLevel
        facts.maximumMatrixLevel = maximumMatrixLevel
        facts.minimumCellSpanReferencePixels = minimumCellSpanQ8 / 256
        facts.maximumCellSpanReferencePixels = maximumCellSpanQ8 / 256
    }
    return Object.freeze(facts)
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
    const maximumCandidates = input.maximumCandidates ?? Math.max(16384, policy.maximumPatches * 64)
    if (!positiveSafeInteger(maximumCandidates) || maximumCandidates > 0xffff_ffff) {
        return throwGeoDiagnostic({
            code: 'GEO_WEB_MERCATOR_COVER_CANDIDATE_BUDGET_INVALID',
            phase: 'selection',
            subject: { kind: 'web-mercator-quad-cover' },
            message: 'Cover input enumeration requires an explicit positive u32 candidate budget.',
            expected: { maximumCandidates: 'positive u32' },
            actual: { maximumCandidates },
        })
    }
    const limits = spatialProfile.coverage.limits
    const boundsMaximumMatrixLevel = Number(limits.at(-1)?.matrixId)
    const expectedLimitCount = boundsMaximumMatrixLevel - policy.minimumMatrixLevel + 1
    const contiguousLimits = limits.length === expectedLimitCount &&
        limits.every((limit, index) =>
            Number(limit.matrixId) === policy.minimumMatrixLevel + index
        )
    if (!contiguousLimits ||
        policy.maximumMatrixLevel >= spatialProfile.coordinateBits ||
        input.verticalRangeMeters?.length !== 2 ||
        input.verticalRangeMeters.some(value => !Number.isFinite(value)) ||
        input.verticalRangeMeters[0] > input.verticalRangeMeters[1]) {
        return throwGeoDiagnostic({
            code: 'GEO_WEB_MERCATOR_COVER_DESCRIPTOR_INVALID',
            phase: 'selection',
            subject: { kind: 'web-mercator-quad-cover' },
            message: 'GPU WebMercatorQuad cover descriptor facts are inconsistent.',
            expected: {
                contiguousCoverageLevels: [
                    policy.minimumMatrixLevel,
                    boundsMaximumMatrixLevel,
                ],
                maximumMatrixLevel: `< coordinateBits ${spatialProfile.coordinateBits}`,
                verticalRangeMeters: 'ordered finite pair',
            },
            actual: input,
        })
    }
    const verticalRangeMeters = Object.freeze([
        input.verticalRangeMeters[0],
        input.verticalRangeMeters[1],
    ]) as readonly [number, number]
    const verticalBounds = snapshotVerticalBounds(
        input.verticalBounds,
        limits,
        verticalRangeMeters
    )
    return Object.freeze({
        spatialProfile,
        policy,
        maximumCandidates,
        verticalRangeMeters,
        ...(verticalBounds === undefined ? {} : { verticalBounds }),
    })
}

function snapshotVerticalBounds(
    input: readonly WebMercatorTileVerticalBounds[] | undefined,
    limits: WebMercatorPlanarTileSpatialProfile['coverage']['limits'],
    globalRange: readonly [number, number]
): readonly WebMercatorTileVerticalBounds[] | undefined {

    if (input === undefined) return undefined
    const expected = limits.flatMap(limit =>
        Array.from(
            { length: limit.maxTileRow - limit.minTileRow + 1 },
            (_, rowOffset) => Array.from(
                { length: limit.maxTileCol - limit.minTileCol + 1 },
                (_, colOffset) => `${limit.matrixId}/` +
                    `${limit.minTileRow + rowOffset}/${limit.minTileCol + colOffset}`
            )
        ).flat()
    )
    const valid = input.length === expected.length && input.every((entry, index) =>
        level(entry?.matrixLevel) && nonNegativeSafeInteger(entry?.tileRow) &&
        nonNegativeSafeInteger(entry?.tileCol) &&
        `${entry.matrixLevel}/${entry.tileRow}/${entry.tileCol}` === expected[index] &&
        Number.isFinite(entry.minimumVerticalMeters) &&
        Number.isFinite(entry.maximumVerticalMeters) &&
        entry.minimumVerticalMeters <= entry.maximumVerticalMeters &&
        entry.minimumVerticalMeters >= globalRange[0] &&
        entry.maximumVerticalMeters <= globalRange[1]
    )
    if (!valid) {
        return throwGeoDiagnostic({
            code: 'GEO_WEB_MERCATOR_COVER_VERTICAL_BOUNDS_INVALID',
            phase: 'selection',
            subject: { kind: 'web-mercator-quad-cover' },
            message: 'WebMercatorQuad vertical bounds must exactly cover declared tiles.',
            expected: { tileKeys: expected, globalRange },
            actual: input,
        })
    }
    return Object.freeze(input.map(entry => Object.freeze({ ...entry })))
}

function validateView(view: GeoViewSnapshot): void {

    if (view?.kind !== 'geo-view-snapshot') {
        throw new TypeError('GPU WebMercatorQuad cover requires GeoViewSnapshot')
    }
}

function mapMetaRecord(
    descriptor: GpuWebMercatorQuadCoverDescriptor,
    view: GeoViewSnapshot
): Record<string, unknown> {

    const profile = descriptor.spatialProfile
    const candidates = gpuWebMercatorQuadCoverCandidates(descriptor, view)
    if (!Number.isSafeInteger(candidates.candidateCount) ||
        candidates.candidateCount > descriptor.maximumCandidates!) {
        return throwGeoDiagnostic({
            code: 'GEO_WEB_MERCATOR_COVER_CANDIDATE_CAPACITY_EXCEEDED',
            phase: 'selection',
            subject: { kind: 'web-mercator-quad-cover', viewId: view.id },
            message: 'The conservative cover input domain exceeds its declared enumeration budget.',
            expected: { maximumCandidates: descriptor.maximumCandidates },
            actual: { candidateCount: candidates.candidateCount,
                conservativeFallback: candidates.conservativeFallback,
                fallbackReasons: candidates.fallbackReasons },
        })
    }
    const candidateWindows = Array.from({ length: 25 }, () => [0, 0, 0, 0])
    for (const window of candidates.windows) {
        candidateWindows[window.matrixLevel] = window.count === 0
            ? [0, 0, 0, window.offset]
            : [window.minTileRow, window.minTileCol,
                window.maxTileCol - window.minTileCol + 1, window.offset + window.count]
    }
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
        frameEpoch: view.frameEpoch,
        residencySnapshotEpoch: view.residencySnapshotEpoch,
        candidateDispatch: [
            Math.min(65535, Math.ceil(candidates.refinementCandidateCount / 64)),
            Math.max(1, Math.ceil(Math.ceil(candidates.refinementCandidateCount / 64) / 65535)),
            1,
        ],
        refinementCandidateCount: candidates.refinementCandidateCount,
        candidateWindows,
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

async function settleCoverCreation<Value>(parts: readonly Promise<Value>[]): Promise<Value[]> {

    // A rejected parity must not start cleanup while another parity can still
    // acquire resources. Keep initial creation concurrent, then settle every
    // producer before the owning catch releases the complete acquired set.
    const settled = await Promise.allSettled(parts)
    const failures = settled.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'GPU WebMercatorQuad cover creation failed')
    return settled.map(result => (result as PromiseFulfilledResult<Value>).value)
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
