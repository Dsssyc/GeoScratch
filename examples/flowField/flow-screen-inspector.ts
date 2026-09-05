import { layoutCodec } from 'geoscratch/scratch'
import type {
    BindLayout, BindSet, DrawCommand, GPURuntime, SubmissionBuilder,
} from 'geoscratch/scratch'
import type { GeoViewSnapshot, WebMercatorVirtualRasterField } from 'geoscratch/geo'
import type { FlowTemporalReadyBindingFrame } from './flow-temporal-bindings.ts'
import type { FlowFieldPresentation } from './flow-presentation.ts'
import { flowFieldPresentation } from './flow-presentation.ts'
import { flowScreenProjectionWgsl, flowScreenViewValues } from './flow-screen-projection.ts'
import inspectorShader from './shaders/screen-inspector.wgsl?raw'

export type FlowScreenInspectorOptions = Readonly<{
    runtime: GPURuntime
    temporal: Readonly<{ wgsl: string, layout: BindLayout }>
    model: WebMercatorVirtualRasterField
    maximumSpeed: number
}>

export type FlowScreenInspector = Readonly<{
    encode(
        builder: SubmissionBuilder,
        view: GeoViewSnapshot,
        temporal: FlowTemporalReadyBindingFrame,
        presentation: FlowFieldPresentation
    ): DrawCommand
    dispose(): void
}>

/** Prepares a replacement history-image draw, borrowing the exact temporal frame lease. */
export async function createFlowScreenInspector(options: FlowScreenInspectorOptions): Promise<FlowScreenInspector> {
    const { runtime, model, maximumSpeed } = options
    if (runtime === undefined || options.temporal?.layout.runtime !== runtime ||
        model?.kind !== 'web-mercator-virtual-raster-field' ||
        !Number.isFinite(maximumSpeed) || maximumSpeed <= 0) {
        throw new TypeError('Flow screen inspector requires one runtime, temporal layout and finite speed range')
    }
    const owned: { dispose(): void }[] = []
    const own = <T extends { dispose(): void }>(resource: T): T => {
        owned.push(resource)
        return resource
    }
    let draw: DrawCommand | undefined
    let previousSet: BindSet | undefined
    let disposed = false

    function dispose(): void {
        if (disposed) return
        disposed = true
        const failures: unknown[] = []
        try { draw?.dispose() } catch (error) { failures.push(error) }
        draw = undefined
        previousSet = undefined
        for (const resource of owned.reverse()) {
            try { resource.dispose() } catch (error) { failures.push(error) }
        }
        if (failures.length > 0) throw new AggregateError(failures, 'Flow screen inspector cleanup failed')
    }

    try {
        const codec = layoutCodec({ name: 'FlowScreenInspectorUniform', fields: [
            { name: 'relativeWorldFromClip', type: 'mat4x4f' },
            { name: 'cameraX', type: 'vec2u' },
            { name: 'cameraY', type: 'vec2u' },
            { name: 'cameraZ', type: 'vec2f' },
            { name: 'requestedLevel', type: 'u32' },
            { name: 'viewMode', type: 'u32' },
            { name: 'progress', type: 'f32' },
            { name: 'maximumSpeed', type: 'f32' },
            { name: 'sampleMode', type: 'u32' },
            { name: 'reserved', type: 'u32' },
        ] }, { usage: [ 'uniform' ] })
        const bytes = new Uint8Array(codec.byteLength())
        const uniform = own(await runtime.createBuffer({
            label: 'Flow Field screen inspector uniform',
            size: bytes.byteLength,
            usage: 0x08 | 0x40,
        }))
        const region = uniform.region({ layout: codec.artifact })
        const upload = own(runtime.createUploadCommand({
            label: 'Upload Flow Field screen inspector view', target: region, data: bytes,
        }))
        const layout = own(await runtime.createBindLayout({
            label: 'Flow Field screen inspector layout', group: 0,
            entries: [ {
                binding: 0, name: 'flowScreenInspector', type: 'uniform',
                visibility: [ 'fragment' ], minBindingSize: bytes.byteLength,
            } ],
        }))
        const set = own(await runtime.createBindSet(layout, { flowScreenInspector: region }))
        const shader = own(await runtime.createShaderModule({
            label: 'Flow Field direct virtual-raster screen inspector',
            sourceParts: [
                { code: options.temporal.wgsl },
                { code: flowScreenProjectionWgsl(model.addressCodec) },
                { code: inspectorShader },
            ],
        }))
        const program = own(runtime.createProgram({
            label: 'Flow Field screen inspector program',
            vertex: { module: shader, entryPoint: 'FlowScreenInspector_vertex' },
            fragment: { module: shader, entryPoint: 'FlowScreenInspector_fragment' },
            layoutRequirements: [ {
                group: 0, binding: 0, type: 'uniform', hasDynamicOffset: false,
                layout: codec.artifact,
            } ],
        }))
        const pipeline = own(await runtime.createRenderPipeline({
            label: 'Flow Field screen inspector pipeline', program,
            layout: { mode: 'explicit', bindLayouts: [ layout, options.temporal.layout ] },
            // Store straight RGBA; the history presenter applies alpha once at the Surface.
            targets: [ { format: 'rgba8unorm' } ],
            primitive: { topology: 'triangle-list' },
            depthStencil: { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'always' },
        }))

        function encode(
            builder: SubmissionBuilder,
            view: GeoViewSnapshot,
            temporal: FlowTemporalReadyBindingFrame,
            presentation: FlowFieldPresentation
        ): DrawCommand {
            if (disposed) throw new Error('Flow screen inspector is disposed')
            const selected = flowFieldPresentation(presentation)
            if (selected.view === 'particles') {
                throw new TypeError('Flow screen inspector requires an inspection view')
            }
            if (builder?.runtime !== runtime || temporal?.state !== 'ready' ||
                temporal.bindSet.layout !== options.temporal.layout ||
                temporal.bindSet.preparationState !== 'prepared' ||
                temporal.pairGeneration !== temporal.temporal.pairGeneration ||
                !Number.isInteger(temporal.requestedLevel) || temporal.requestedLevel < 0 ||
                temporal.requestedLevel >= model.addressSpace.levelCount ||
                !Number.isFinite(temporal.progress) || temporal.progress < 0 || temporal.progress > 1) {
                throw new TypeError('Flow screen inspector requires the current ready temporal frame and runtime')
            }
            codec.write(bytes, {
                ...flowScreenViewValues(view, model.addressCodec),
                requestedLevel: temporal.requestedLevel,
                progress: temporal.progress,
                maximumSpeed,
                viewMode: [ 'speed', 'direction', 'u', 'v', 'status' ].indexOf(selected.view),
                sampleMode: [ 'interpolated', 'lower', 'upper', 'delta' ].indexOf(selected.sample),
                reserved: 0,
            })
            if (draw === undefined || previousSet !== temporal.bindSet) {
                draw?.dispose()
                draw = runtime.createDrawCommand({
                    label: `Inspect Flow Field temporal pair ${temporal.pairGeneration}`,
                    pipeline,
                    bindSets: [ { set }, { set: temporal.bindSet } ],
                    count: { vertexCount: 3 },
                    resources: {
                        read: [ uniform, ...new Set(temporal.resources) ].map(resource => ({
                            resource, contentEpoch: 'current-at-step' as const,
                        })),
                        write: [],
                    },
                    whenMissing: 'throw',
                })
                previousSet = temporal.bindSet
            }
            builder.upload(upload)
            return draw
        }
        return Object.freeze({ encode, dispose })
    } catch (error) {
        try { dispose() } catch (cleanup) {
            throw new AggregateError([ error, cleanup ], 'Flow screen inspector construction failed')
        }
        throw error
    }
}
