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
    type SubmissionBuilder,
    type UploadCommand,
    layoutCodec,
} from '../scratch/index.js'
import { throwGeoDiagnostic } from './diagnostics.js'
import { gpuWebMercatorQuadCoverStateCodec } from './gpu-web-mercator-quad-cover-layout.js'
import type {
    GpuWebMercatorQuadCover,
    GpuWebMercatorQuadCoverFrame,
} from './gpu-web-mercator-quad-cover.js'

const BUFFER_COPY_DST = 0x08
const BUFFER_UNIFORM = 0x40
const BUFFER_STORAGE = 0x80
const BUFFER_INDIRECT = 0x100
const DRAW_ARGUMENT_BYTES = 16

const patchDrawPolicyCodec = layoutCodec({
    name: 'GpuWebMercatorQuadPatchDrawPolicy',
    fields: [ { name: 'vertexCount', type: 'u32' } ],
}, { usage: [ 'uniform', 'storage', 'readback' ] })

const PATCH_DRAW_WGSL = String.raw`
@group(0) @binding(0)
var<uniform> patchDrawPolicy: GpuWebMercatorQuadPatchDrawPolicy;
@group(0) @binding(1)
var<storage, read> coverState: GpuWebMercatorQuadCoverState;
@group(0) @binding(2)
var<storage, read_write> drawArguments: array<u32>;

@compute @workgroup_size(1)
fn prepareWebMercatorQuadPatchDraw() {
    drawArguments[0] = patchDrawPolicy.vertexCount;
    drawArguments[1] = coverState.patchCount;
    drawArguments[2] = 0u;
    drawArguments[3] = 0u;
}
`

type Disposable = { dispose(): void }

export type GpuWebMercatorQuadPatchDrawDescriptor = Readonly<{
    cover: GpuWebMercatorQuadCover
    vertexCount: number
}>

export type GpuWebMercatorQuadPatchDrawFrame = Readonly<{
    kind: 'gpu-web-mercator-quad-patch-draw-frame'
    patchDrawId: string
    coverId: string
    frameEpoch: number
    parity: 0 | 1
    drawArgument: Readonly<{
        resource: BufferResource
        region: BufferRegion
        offset: 0
        size: 16
    }>
}>

export type GpuWebMercatorQuadPatchDrawTemplate = Readonly<{
    parity: 0 | 1
    drawArgument: GpuWebMercatorQuadPatchDrawFrame['drawArgument']
}>

export type GpuWebMercatorQuadPatchDrawFacts = Readonly<{
    id: string
    runtimeId: string
    coverId: string
    vertexCount: number
    disposed: boolean
    parity: readonly Readonly<{
        parity: 0 | 1
        drawArgumentBufferId: string
        commandId: string
    }>[]
}>

export type GpuWebMercatorQuadPatchDrawIdentityObjects = Readonly<{
    resources: readonly BufferResource[]
    uploads: readonly UploadCommand[]
    bindLayouts: readonly BindLayout[]
    bindSets: readonly BindSet[]
    programs: readonly Program[]
    pipelines: readonly ComputePipeline[]
    passes: readonly ComputePassSpec[]
    commands: readonly (ClearBufferCommand | DispatchCommand)[]
}>

type ParityTemplate = Readonly<{
    parity: 0 | 1
    drawArguments: BufferResource
    drawArgument: GpuWebMercatorQuadPatchDrawFrame['drawArgument']
    bindSet: BindSet
    command: DispatchCommand
}>

type FrameRecord = Readonly<{
    owner: GpuWebMercatorQuadPatchDraw
    coverFrame: GpuWebMercatorQuadCoverFrame
    template: ParityTemplate
}>

const frameRecords = new WeakMap<GpuWebMercatorQuadPatchDrawFrame, FrameRecord>()
const encodedBuilders = new WeakMap<SubmissionBuilder, GpuWebMercatorQuadPatchDrawFrame>()
let nextPatchDrawId = 1

/** Prepares consumer-owned draw-indirect arguments from one GPU cover patch count. */
export class GpuWebMercatorQuadPatchDraw {

    readonly runtime: GPURuntime
    readonly id: string
    readonly descriptor: GpuWebMercatorQuadPatchDrawDescriptor
    readonly #pass: ComputePassSpec
    readonly #templates: readonly [ParityTemplate, ParityTemplate]
    readonly #initializationClears: readonly ClearBufferCommand[]
    readonly #initializationUploads: readonly UploadCommand[]
    readonly #identity: GpuWebMercatorQuadPatchDrawIdentityObjects
    readonly #owned: readonly Disposable[]
    #disposed = false

    private constructor(
        runtime: GPURuntime,
        descriptor: GpuWebMercatorQuadPatchDrawDescriptor,
        state: Readonly<{
            pass: ComputePassSpec
            templates: readonly [ParityTemplate, ParityTemplate]
            initializationClears: readonly ClearBufferCommand[]
            initializationUploads: readonly UploadCommand[]
            identity: GpuWebMercatorQuadPatchDrawIdentityObjects
            owned: readonly Disposable[]
        }>
    ) {

        this.runtime = runtime
        this.id = `geo-gpu-web-mercator-quad-patch-draw-${nextPatchDrawId++}`
        this.descriptor = descriptor
        this.#pass = state.pass
        this.#templates = state.templates
        this.#initializationClears = state.initializationClears
        this.#initializationUploads = state.initializationUploads
        this.#identity = state.identity
        this.#owned = state.owned
        Object.preventExtensions(this)
    }

    static async create(
        runtime: GPURuntime,
        input: GpuWebMercatorQuadPatchDrawDescriptor
    ): Promise<GpuWebMercatorQuadPatchDraw> {

        const descriptor = snapshotDescriptor(runtime, input)
        const owned: Disposable[] = []
        const own = <Value extends Disposable>(value: Value): Value => {
            owned.push(value)
            return value
        }
        try {
            const policy = own(await runtime.createBuffer({
                label: 'GPU WebMercatorQuad patch draw policy',
                size: patchDrawPolicyCodec.byteLength(),
                usage: BUFFER_COPY_DST | BUFFER_UNIFORM,
            }))
            const policyUpload = own(runtime.createUploadCommand({
                label: 'Upload GPU WebMercatorQuad patch draw policy',
                target: policy.region({ layout: patchDrawPolicyCodec.artifact }),
                data: patchDrawPolicyCodec.pack({ vertexCount: descriptor.vertexCount }),
            }))
            const coverTemplates = descriptor.cover.templates()
            const drawArguments = await Promise.all([ 0, 1 ].map(async parity =>
                own(await runtime.createBuffer({
                    label: `GPU WebMercatorQuad patch draw arguments ${parity}`,
                    size: DRAW_ARGUMENT_BYTES,
                    usage: BUFFER_COPY_DST | BUFFER_STORAGE | BUFFER_INDIRECT,
                }))
            )) as unknown as readonly [BufferResource, BufferResource]
            const initializationClears = Object.freeze(drawArguments.map((resource, parity) =>
                own(runtime.createClearBufferCommand({
                    label: `Clear GPU WebMercatorQuad patch draw arguments ${parity}`,
                    target: resource.region(),
                }))
            ))
            const shader = own(await runtime.createShaderModule({
                label: 'GPU WebMercatorQuad patch draw shader',
                sourceParts: [ {
                    label: 'GPU WebMercatorQuad patch draw ABI',
                    code: [
                        patchDrawPolicyCodec.wgslAccessors({
                            namespace: 'GpuWebMercatorQuadPatchDrawPolicy',
                        }),
                        gpuWebMercatorQuadCoverStateCodec.wgslAccessors({
                            namespace: 'GpuWebMercatorQuadCoverState',
                        }),
                    ].join('\n'),
                    layoutDependencies: [
                        patchDrawPolicyCodec.artifact,
                        gpuWebMercatorQuadCoverStateCodec.artifact,
                    ],
                }, {
                    label: 'GPU WebMercatorQuad patch draw kernel',
                    code: PATCH_DRAW_WGSL,
                } ],
            }))
            const layout = own(await runtime.createBindLayout({
                label: 'GPU WebMercatorQuad patch draw layout',
                group: 0,
                entries: [
                    {
                        binding: 0,
                        name: 'patchDrawPolicy',
                        type: 'uniform',
                        visibility: [ 'compute' ],
                        minBindingSize: policy.size,
                    },
                    {
                        binding: 1,
                        name: 'coverState',
                        type: 'read-storage',
                        visibility: [ 'compute' ],
                        minBindingSize: coverTemplates[0].state.size,
                    },
                    {
                        binding: 2,
                        name: 'drawArguments',
                        type: 'storage',
                        visibility: [ 'compute' ],
                        minBindingSize: DRAW_ARGUMENT_BYTES,
                    },
                ],
            }))
            const program = own(runtime.createProgram({
                label: 'GPU WebMercatorQuad patch draw program',
                compute: { module: shader, entryPoint: 'prepareWebMercatorQuadPatchDraw' },
            }))
            const pipeline = own(await runtime.createComputePipeline({
                label: 'GPU WebMercatorQuad patch draw pipeline',
                program,
                layout: { mode: 'explicit', bindLayouts: [ layout ] },
            }))
            const pass = own(runtime.createComputePass({
                label: 'GPU WebMercatorQuad patch draw stage',
            }))
            const templates = await Promise.all(drawArguments.map(
                async (resource, parityValue) => {
                    const parity = parityValue as 0 | 1
                    const coverTemplate = coverTemplates[parity]
                    const bindSet = own(await runtime.createBindSet(layout, {
                        patchDrawPolicy: policy.region({ layout: patchDrawPolicyCodec.artifact }),
                        coverState: coverTemplate.state.region({
                            layout: gpuWebMercatorQuadCoverStateCodec.artifact,
                        }),
                        drawArguments: resource.region(),
                    }, { label: `GPU WebMercatorQuad patch draw bindings ${parity}` }))
                    const command = own(runtime.createDispatchCommand({
                        label: `Prepare GPU WebMercatorQuad patch draw ${parity}`,
                        pipeline,
                        bindSets: [ { set: bindSet } ],
                        count: { workgroups: [ 1, 1, 1 ] },
                        resources: {
                            read: [
                                coverTemplate.state,
                                policy,
                                resource,
                            ].map(currentRead),
                            write: [ resource ],
                        },
                        whenMissing: 'throw',
                    }))
                    const drawArgument = Object.freeze({
                        resource,
                        region: resource.region({ offset: 0, size: DRAW_ARGUMENT_BYTES }),
                        offset: 0 as const,
                        size: DRAW_ARGUMENT_BYTES as 16,
                    })
                    return Object.freeze({
                        parity,
                        drawArguments: resource,
                        drawArgument,
                        bindSet,
                        command,
                    })
                }
            )) as unknown as readonly [ParityTemplate, ParityTemplate]
            const identity = Object.freeze({
                resources: Object.freeze([ policy, ...drawArguments ]),
                uploads: Object.freeze([ policyUpload ]),
                bindLayouts: Object.freeze([ layout ]),
                bindSets: Object.freeze(templates.map(template => template.bindSet)),
                programs: Object.freeze([ program ]),
                pipelines: Object.freeze([ pipeline ]),
                passes: Object.freeze([ pass ]),
                commands: Object.freeze([
                    ...initializationClears,
                    ...templates.map(template => template.command),
                ]),
            }) satisfies GpuWebMercatorQuadPatchDrawIdentityObjects
            return new GpuWebMercatorQuadPatchDraw(runtime, descriptor, {
                pass,
                templates,
                initializationClears,
                initializationUploads: Object.freeze([ policyUpload ]),
                identity,
                owned: Object.freeze([ ...owned ]),
            })
        } catch (error) {
            disposeReverse(owned)
            throw error
        }
    }

    initialize(builder: SubmissionBuilder): SubmissionBuilder {

        this.#assertActive()
        if (builder?.runtime !== this.runtime || builder.isSubmitted) {
            return invalidPatchDraw(this, 'Patch draw initialization requires one live owning builder.',
                { runtimeId: this.runtime.id, submitted: false },
                { runtimeId: builder?.runtime?.id, submitted: builder?.isSubmitted })
        }
        for (const command of this.#initializationClears) builder.clear(command)
        for (const command of this.#initializationUploads) builder.upload(command)
        return builder
    }

    frame(coverFrame: GpuWebMercatorQuadCoverFrame): GpuWebMercatorQuadPatchDrawFrame {

        this.#assertActive()
        if (coverFrame?.coverId !== this.descriptor.cover.id ||
            (coverFrame.parity !== 0 && coverFrame.parity !== 1)) {
            return invalidPatchDraw(this, 'Patch draw requires one frame from its cover.',
                { coverId: this.descriptor.cover.id },
                { coverId: coverFrame?.coverId, parity: coverFrame?.parity })
        }
        const template = this.#templates[coverFrame.parity]
        const frame = Object.freeze({
            kind: 'gpu-web-mercator-quad-patch-draw-frame' as const,
            patchDrawId: this.id,
            coverId: coverFrame.coverId,
            frameEpoch: coverFrame.frameEpoch,
            parity: coverFrame.parity,
            drawArgument: template.drawArgument,
        })
        frameRecords.set(frame, Object.freeze({ owner: this, coverFrame, template }))
        return frame
    }

    encode(
        builder: SubmissionBuilder,
        frame: GpuWebMercatorQuadPatchDrawFrame
    ): SubmissionBuilder {

        this.#assertActive()
        const record = frameRecords.get(frame)
        if (builder?.runtime !== this.runtime || builder.isSubmitted ||
            encodedBuilders.has(builder) || record?.owner !== this) {
            return invalidPatchDraw(this, 'Patch draw encoding requires one owned frame and live builder.',
                { runtimeId: this.runtime.id, submitted: false },
                { runtimeId: builder?.runtime?.id, submitted: builder?.isSubmitted })
        }
        builder.compute(this.#pass, [ record.template.command ])
        encodedBuilders.set(builder, frame)
        return builder
    }

    templates(): readonly [
        GpuWebMercatorQuadPatchDrawTemplate,
        GpuWebMercatorQuadPatchDrawTemplate,
    ] {

        this.#assertActive()
        return Object.freeze(this.#templates.map(template => Object.freeze({
            parity: template.parity,
            drawArgument: template.drawArgument,
        }))) as unknown as readonly [
            GpuWebMercatorQuadPatchDrawTemplate,
            GpuWebMercatorQuadPatchDrawTemplate,
        ]
    }

    facts(): GpuWebMercatorQuadPatchDrawFacts {

        return Object.freeze({
            id: this.id,
            runtimeId: this.runtime.id,
            coverId: this.descriptor.cover.id,
            vertexCount: this.descriptor.vertexCount,
            disposed: this.#disposed,
            parity: Object.freeze(this.#templates.map(template => Object.freeze({
                parity: template.parity,
                drawArgumentBufferId: template.drawArguments.id,
                commandId: template.command.id,
            }))),
        })
    }

    identityObjects(): GpuWebMercatorQuadPatchDrawIdentityObjects {

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
            return invalidPatchDraw(this, 'GPU WebMercatorQuad patch draw is disposed.',
                { disposed: false }, { disposed: true })
        }
    }
}

Object.freeze(GpuWebMercatorQuadPatchDraw.prototype)

function snapshotDescriptor(
    runtime: GPURuntime,
    input: GpuWebMercatorQuadPatchDrawDescriptor
): GpuWebMercatorQuadPatchDrawDescriptor {

    if (input?.cover?.runtime !== runtime || !positiveSafeInteger(input.vertexCount) ||
        input.vertexCount > 0xffff_ffff) {
        return invalidPatchDraw(
            { id: 'uninitialized' },
            'Patch draw requires one owning cover and a positive u32 vertex count.',
            { runtimeId: runtime?.id, vertexCount: 'positive u32' },
            input
        )
    }
    return Object.freeze({ cover: input.cover, vertexCount: input.vertexCount })
}

function currentRead(resource: BufferResource) {

    return { resource, contentEpoch: 'current-at-step' as const }
}

function positiveSafeInteger(value: number): boolean {

    return Number.isSafeInteger(value) && value > 0
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

function invalidPatchDraw(
    patchDraw: Pick<GpuWebMercatorQuadPatchDraw, 'id'>,
    message: string,
    expected: unknown,
    actual: unknown
): never {

    return throwGeoDiagnostic({
        code: 'GEO_WEB_MERCATOR_PATCH_DRAW_INVALID',
        phase: 'selection',
        subject: { kind: 'web-mercator-quad-patch-draw', id: patchDraw.id },
        message,
        expected,
        actual,
    })
}
