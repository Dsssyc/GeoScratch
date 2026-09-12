import type {
    BufferResource,
    DrawCommand,
    GPURuntime,
    SubmissionBuilder,
    SurfaceSize,
} from 'geoscratch/scratch'
import type { FlowParticles } from './flow-particles.ts'
import { FLOW_PARTICLE_RECORD_BYTES } from './flow-particles.ts'
import type { FlowRenderViewBinding } from './flow-render-view.ts'
import { FLOW_RENDER_VIEW_UNIFORM_BYTE_LENGTH } from './flow-render-view.ts'

export type FlowParticleRenderOptions = Readonly<{
    runtime: GPURuntime
    particles: Pick<FlowParticles, 'maximumCount' | 'resources'>
    view: FlowRenderViewBinding
    targetFormat?: GPUTextureFormat
    maximumSpeed?: number
}>

export type FlowParticleRender = Readonly<{
    draw: DrawCommand
    /** Snapshot target-pixel coverage inputs before particle compute and the draw. */
    encode(builder: SubmissionBuilder, size: SurfaceSize, referenceViewport: readonly number[]): void
    dispose(): void
}>

/** Trail centerline width in camera reference pixels, independent of history DPR. */
export const FLOW_PARTICLE_LINE_WIDTH_REFERENCE_PIXELS = 0.5

const NORMAL_BLEND: Readonly<GPUBlendState> = Object.freeze({
    color: {
        operation: 'add' as const,
        srcFactor: 'src-alpha' as const,
        dstFactor: 'one-minus-src-alpha' as const,
    },
    alpha: {
        operation: 'add' as const,
        srcFactor: 'one' as const,
        dstFactor: 'one-minus-src-alpha' as const,
    },
})

/** Owns an analytic-coverage quad draw and raster uniforms; particles and view stay borrowed. */
export async function createFlowParticleRender(
    options: FlowParticleRenderOptions
): Promise<FlowParticleRender> {

    const runtime = options?.runtime
    const particleCount = options?.particles?.maximumCount
    const particleBuffer = options?.particles?.resources?.particles
    const view: FlowRenderViewBinding = options.view
    const viewEntry = view?.bindLayout?.entries[0]
    const targetFormat = options.targetFormat ?? 'rgba8unorm'
    const maximumSpeed = options.maximumSpeed ?? 1
    if (runtime === undefined || !Number.isSafeInteger(particleCount) || particleCount <= 0 ||
        particleBuffer?.runtime !== runtime ||
        particleBuffer.size !== particleCount * FLOW_PARTICLE_RECORD_BYTES ||
        view?.bindLayout?.runtime !== runtime || view.bindLayout.group !== 1 ||
        viewEntry?.name !== 'contourView' || viewEntry.type !== 'uniform' ||
        viewEntry.minBindingSize < FLOW_RENDER_VIEW_UNIFORM_BYTE_LENGTH ||
        view.bindSet?.runtime !== runtime || view.bindSet.layout !== view.bindLayout ||
        view.resources.length !== 1 || view.resources[0].runtime !== runtime ||
        typeof targetFormat !== 'string' || targetFormat.length === 0 ||
        !Number.isFinite(Math.fround(maximumSpeed)) || Math.fround(maximumSpeed) <= 0) {
        throw new TypeError('Flow particle render requires canonical particles and shared view binding')
    }
    const owned: { dispose(): void }[] = []
    const own = <T extends { dispose(): void }>(value: T): T => (owned.push(value), value)
    try {
        const particleLayout = own(await runtime.createBindLayout({
            label: 'Flow Field particle render layout',
            group: 0,
            entries: [ {
                binding: 0,
                name: 'flowParticleRenderRecords',
                type: 'read-storage',
                visibility: [ 'vertex' ],
                minBindingSize: particleCount * FLOW_PARTICLE_RECORD_BYTES,
            } ],
        }))
        const particleSet = own(await runtime.createBindSet(particleLayout, {
            flowParticleRenderRecords: particleBuffer.region(),
        }, { label: 'Flow Field particle render records' }))
        const rasterBytes = new Float32Array(4)
        const raster = own(await runtime.createBuffer({label:'Flow Field particle raster uniform',size:16,
            usage:GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST}))
        const rasterUpload = own(runtime.createUploadCommand({label:'Upload Flow particle raster',target:raster.region(),data:rasterBytes}))
        const rasterLayout = own(await runtime.createBindLayout({group:2,entries:[{
            binding:0,name:'flowParticleRaster',type:'uniform',visibility:['vertex','fragment'],minBindingSize:16,
        }]}))
        const rasterSet = own(await runtime.createBindSet(rasterLayout,{flowParticleRaster:raster.region()}))
        const shaderSource = await fetchTextAsset(
            new URL('./shaders/particle-render.wgsl', import.meta.url)
        )
        const shader = own(await runtime.createShaderModule({
            label: 'Flow Field particle render shader',
            sourceParts: [
                { code: `const FLOW_PARTICLE_MAXIMUM_SPEED = ${Math.fround(maximumSpeed)}f;` },
                { code: shaderSource },
            ],
        }))
        const program = own(runtime.createProgram({
            label: 'Flow Field particle render program',
            vertex: { module: shader, entryPoint: 'vParticle' },
            fragment: { module: shader, entryPoint: 'fParticle' },
        }))
        const pipeline = own(await runtime.createRenderPipeline({
            label: 'Flow Field particle line pipeline',
            program,
            layout: { mode: 'explicit', bindLayouts: [ particleLayout, view.bindLayout, rasterLayout ] },
            targets: [ { format: targetFormat, blend: NORMAL_BLEND } ],
            primitive: { topology: 'triangle-strip' },
        }))
        const draw = own(runtime.createDrawCommand({
            label: 'Draw Flow Field particle lines',
            pipeline,
            bindSets: [ { set: particleSet }, { set: view.bindSet }, { set: rasterSet } ],
            count: { vertexCount: 4, instanceCount: particleCount },
            resources: {
                read: [
                    { resource: particleBuffer, contentEpoch: 'current-at-step' },
                    { resource: raster, contentEpoch: 'current-at-step' },
                    ...currentReads(view.resources),
                ],
                write: [],
            },
            whenMissing: 'throw',
        }))
        let disposed = false

        function dispose(): void {

            if (disposed) return
            disposed = true
            for (const resource of owned.reverse()) resource.dispose()
        }

        return Object.freeze({ draw, dispose, encode(builder: SubmissionBuilder, size: SurfaceSize, referenceViewport: readonly number[]) {
            if (disposed || builder.runtime !== runtime || builder.isSubmitted ||
                !Number.isSafeInteger(size.width) || size.width <= 0 || !Number.isSafeInteger(size.height) || size.height <= 0 ||
                referenceViewport.length !== 2 || referenceViewport.some(value=>!Number.isFinite(value)||value<=0)) {
                throw new TypeError('Flow particle raster preparation requires a live builder and positive view dimensions')
            }
            const lineWidth = Math.fround(FLOW_PARTICLE_LINE_WIDTH_REFERENCE_PIXELS * size.width / referenceViewport[0]!)
            if (!Number.isFinite(lineWidth) || lineWidth <= 0) throw new RangeError('Flow line width must fit positive f32 target pixels')
            rasterBytes.set([size.width,size.height,lineWidth,0.5])
            builder.upload(rasterUpload)
        } })
    } catch (error) {
        for (const resource of owned.reverse()) resource.dispose()
        throw error
    }
}

function currentReads(resources: readonly BufferResource[]) {

    return [ ...new Map(resources.map(resource => [ resource.id, resource ])).values() ]
        .map(resource => ({ resource, contentEpoch: 'current-at-step' as const }))
}

async function fetchTextAsset(url: URL): Promise<string> {

    const response = await fetch(url)
    if (!response.ok) {
        throw new Error(`Flow particle render shader request failed with HTTP ${response.status}`)
    }
    return response.text()
}
