import type {
    BindLayout,
    BindSet,
    BufferResource,
    DrawCommand,
    GPURuntime,
    Program,
    RenderPipeline,
    ShaderModule,
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
}>

export type FlowParticleRender = Readonly<{
    draw: DrawCommand
    dispose(): void
}>

type OwnedParticleRenderGraph = Readonly<{
    particleLayout: BindLayout
    particleSet: BindSet
    shader: ShaderModule
    program: Program
    pipeline: RenderPipeline
    draw: DrawCommand
}>

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

/** Creates one borrowed-particle line draw suitable for the rgba8unorm history pass. */
export async function createFlowParticleRender(
    options: FlowParticleRenderOptions
): Promise<FlowParticleRender> {

    const runtime = options?.runtime
    const particleCount = options?.particles?.maximumCount
    const particleBuffer = options?.particles?.resources?.particles
    const view: FlowRenderViewBinding = options.view
    const viewEntry = view?.bindLayout?.entries[0]
    const targetFormat = options.targetFormat ?? 'rgba8unorm'
    if (runtime === undefined || !Number.isSafeInteger(particleCount) || particleCount <= 0 ||
        particleBuffer?.runtime !== runtime ||
        particleBuffer.size !== particleCount * FLOW_PARTICLE_RECORD_BYTES ||
        view?.bindLayout?.runtime !== runtime || view.bindLayout.group !== 1 ||
        viewEntry?.name !== 'contourView' || viewEntry.type !== 'uniform' ||
        viewEntry.minBindingSize < FLOW_RENDER_VIEW_UNIFORM_BYTE_LENGTH ||
        view.bindSet?.runtime !== runtime || view.bindSet.layout !== view.bindLayout ||
        view.resources.length !== 1 || view.resources[0].runtime !== runtime ||
        typeof targetFormat !== 'string' || targetFormat.length === 0) {
        throw new TypeError('Flow particle render requires canonical particles and shared view binding')
    }
    const particleLayout = await runtime.createBindLayout({
        label: 'Flow Field particle render layout',
        group: 0,
        entries: [ {
            binding: 0,
            name: 'flowParticleRenderRecords',
            type: 'read-storage',
            visibility: [ 'vertex' ],
            minBindingSize: particleCount * FLOW_PARTICLE_RECORD_BYTES,
        } ],
    })
    const particleSet = await runtime.createBindSet(particleLayout, {
        flowParticleRenderRecords: particleBuffer.region(),
    }, { label: 'Flow Field particle render records' })
    const shaderSource = await fetchTextAsset(
        new URL('./shaders/particle-render.wgsl', import.meta.url)
    )
    const shader = await runtime.createShaderModule({
        label: 'Flow Field particle render shader',
        sourceParts: [ { code: shaderSource } ],
    })
    const program = runtime.createProgram({
        label: 'Flow Field particle render program',
        vertex: { module: shader, entryPoint: 'vParticle' },
        fragment: { module: shader, entryPoint: 'fParticle' },
    })
    const pipeline = await runtime.createRenderPipeline({
        label: 'Flow Field particle line pipeline',
        program,
        layout: { mode: 'explicit', bindLayouts: [ particleLayout, view.bindLayout ] },
        targets: [ { format: targetFormat, blend: NORMAL_BLEND } ],
        primitive: { topology: 'line-list' },
    })
    const draw = runtime.createDrawCommand({
        label: 'Draw Flow Field particle lines',
        pipeline,
        bindSets: [ { set: particleSet }, { set: view.bindSet } ],
        count: { vertexCount: particleCount * 2 },
        resources: {
            read: [
                { resource: particleBuffer, contentEpoch: 'current-at-step' },
                ...currentReads(view.resources),
            ],
            write: [],
        },
        whenMissing: 'throw',
    })
    const graph: OwnedParticleRenderGraph = Object.freeze({
        particleLayout,
        particleSet,
        shader,
        program,
        pipeline,
        draw,
    })
    let disposed = false

    function dispose(): void {

        if (disposed) return
        disposed = true
        graph.draw.dispose()
        graph.pipeline.dispose()
        graph.program.dispose()
        graph.shader.dispose()
        graph.particleSet.dispose()
        graph.particleLayout.dispose()
    }

    return Object.freeze({ draw, dispose })
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
