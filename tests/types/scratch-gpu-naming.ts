import * as scratch from '../../packages/geoscratch/dist/scratch/index.js'

declare const runtime: scratch.GPURuntime
declare const diagnostics: scratch.GPURuntimeDiagnostics
declare const capture: scratch.GPUDiagnosticCapture
declare const renderPipeline: scratch.RenderPipeline
declare const computePipeline: scratch.ComputePipeline
declare const renderDescriptor: scratch.RenderPipelineDescriptor
declare const computeDescriptor: scratch.ComputePipelineDescriptor
declare const incident: scratch.GPUIncidentReport
declare const operation: scratch.GPUOperationRecord

const runtimePromise: Promise<scratch.GPURuntime> = scratch.GPURuntime.create()
const runtimeDiagnostics: scratch.GPURuntimeDiagnostics = runtime.diagnostics
const diagnosticCapture: scratch.GPUDiagnosticCapture = diagnostics.capture()
const renderRuntime: scratch.GPURuntime = renderPipeline.runtime
const computeRuntime: scratch.GPURuntime = computePipeline.runtime

void runtimePromise
void runtimeDiagnostics
void diagnosticCapture
void capture
void renderRuntime
void computeRuntime
void renderDescriptor
void computeDescriptor
void incident
void operation

// @ts-expect-error ScratchRuntime was removed by the GPU naming clean cut
scratch.ScratchRuntime
// @ts-expect-error ScratchRuntimeDiagnostics was removed by the GPU naming clean cut
scratch.ScratchRuntimeDiagnostics
// @ts-expect-error ScratchDiagnosticCapture was removed by the GPU naming clean cut
scratch.ScratchDiagnosticCapture
// @ts-expect-error ScratchRenderPipeline was removed by the GPU naming clean cut
scratch.ScratchRenderPipeline
// @ts-expect-error ScratchComputePipeline was removed by the GPU naming clean cut
scratch.ScratchComputePipeline
// @ts-expect-error GPURuntime has no public constructor
new scratch.GPURuntime()
