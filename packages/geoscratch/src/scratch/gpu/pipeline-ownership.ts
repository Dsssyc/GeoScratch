import { diagnosticsControllerFor } from './runtime-diagnostics.js'
import type { GPUPipelineOperationRecord } from './gpu-operation.js'
import type { ComputePipeline, RenderPipeline } from './pipeline.js'
import type { GPURuntime } from './runtime.js'

type RuntimePipeline = RenderPipeline | ComputePipeline

const runtimePipelines = new WeakMap<GPURuntime, Set<RuntimePipeline>>()

export function registerRuntimePipeline(
    runtime: GPURuntime,
    pipeline: RuntimePipeline,
    creationOperation: GPUPipelineOperationRecord
): void {

    const pipelines = runtimePipelineSetFor(runtime)
    if (pipelines.has(pipeline)) {
        throw new TypeError(`Pipeline ${pipeline.id} is already owned by its runtime.`)
    }

    diagnosticsControllerFor(runtime).registerPipeline({
        ...(pipeline.label !== undefined ? { label: pipeline.label } : {}),
        creationOperation,
    })
    pipelines.add(pipeline)
}

export function unregisterRuntimePipeline(
    runtime: GPURuntime,
    pipeline: RuntimePipeline
): void {

    runtimePipelines.get(runtime)?.delete(pipeline)
    diagnosticsControllerFor(runtime).unregisterPipeline(pipeline.id)
}

export function runtimePipelineSnapshot(runtime: GPURuntime): readonly RuntimePipeline[] {

    return Object.freeze([ ...(runtimePipelines.get(runtime) ?? []) ])
}

export function runtimePipelineCount(runtime: GPURuntime): number {

    return runtimePipelines.get(runtime)?.size ?? 0
}

function runtimePipelineSetFor(runtime: GPURuntime): Set<RuntimePipeline> {

    let pipelines = runtimePipelines.get(runtime)
    if (pipelines === undefined) {
        pipelines = new Set()
        runtimePipelines.set(runtime, pipelines)
    }
    return pipelines
}
