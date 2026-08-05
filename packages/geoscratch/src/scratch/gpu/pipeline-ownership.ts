import { diagnosticsControllerFor } from './runtime-diagnostics.js'
import type { ScratchGpuPipelineOperationRecord } from './gpu-operation.js'
import type { ComputePipeline, RenderPipeline } from './pipeline.js'
import type { ScratchRuntime } from './runtime.js'

type RuntimePipeline = RenderPipeline | ComputePipeline

const runtimePipelines = new WeakMap<ScratchRuntime, Set<RuntimePipeline>>()

export function registerRuntimePipeline(
    runtime: ScratchRuntime,
    pipeline: RuntimePipeline,
    creationOperation: ScratchGpuPipelineOperationRecord
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
    runtime: ScratchRuntime,
    pipeline: RuntimePipeline
): void {

    runtimePipelines.get(runtime)?.delete(pipeline)
    diagnosticsControllerFor(runtime).unregisterPipeline(pipeline.id)
}

export function runtimePipelineSnapshot(runtime: ScratchRuntime): readonly RuntimePipeline[] {

    return Object.freeze([ ...(runtimePipelines.get(runtime) ?? []) ])
}

export function runtimePipelineCount(runtime: ScratchRuntime): number {

    return runtimePipelines.get(runtime)?.size ?? 0
}

function runtimePipelineSetFor(runtime: ScratchRuntime): Set<RuntimePipeline> {

    let pipelines = runtimePipelines.get(runtime)
    if (pipelines === undefined) {
        pipelines = new Set()
        runtimePipelines.set(runtime, pipelines)
    }
    return pipelines
}
