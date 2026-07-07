import { UUID } from '../core/utils/uuid.js'
import { BindLayout, BindSet } from './binding.js'
import { BufferResource } from './buffer.js'
import { BeginOcclusionQueryCommand, CopyCommand, DispatchCommand, DrawCommand, EndOcclusionQueryCommand, ResolveQuerySetCommand, TextureUploadCommand, UploadCommand } from './command.js'
import { throwScratchDiagnostic } from './diagnostics.js'
import { ComputePassSpec, RenderPassSpec } from './pass.js'
import { ComputePipeline, RenderPipeline } from './pipeline.js'
import { Program } from './program.js'
import { QuerySetResource } from './query-set.js'
import { ReadbackOperation } from './readback.js'
import { SamplerResource } from './sampler.js'
import { SubmissionBuilder } from './submission.js'
import { Surface } from './surface.js'
import { TextureResource } from './texture.js'
import type { BindLayoutDescriptor, BindSetBindings, BindSetOptions } from './binding.js'
import type { BufferResourceDescriptor } from './buffer.js'
import type { BeginOcclusionQueryCommandDescriptor, CopyCommandDescriptor, DispatchCommandDescriptor, DrawCommandDescriptor, EndOcclusionQueryCommandDescriptor, ResolveQuerySetCommandDescriptor, TextureUploadCommandDescriptor, UploadCommandDescriptor } from './command.js'
import type { DiagnosticSubject } from './diagnostics.js'
import type { ComputePassSpecDescriptor, RenderPassSpecDescriptor } from './pass.js'
import type { ComputePipelineDescriptor, RenderPipelineDescriptor } from './pipeline.js'
import type { ProgramDescriptor } from './program.js'
import type { QuerySetResourceDescriptor } from './query-set.js'
import type { ReadbackOperationDescriptor } from './readback.js'
import type { Resource } from './resource.js'
import type { SamplerResourceDescriptor } from './sampler.js'
import type { SubmissionBuilderOptions } from './submission.js'
import type { SurfaceOptions } from './surface.js'
import type { TextureResourceDescriptor } from './texture.js'

const runtimeToken = Symbol('ScratchRuntime')

export type ScratchRuntimeCreateOptions = {
    gpu?: GPU
    label?: string
    powerPreference?: GPUPowerPreference
    forceFallbackAdapter?: boolean
    requiredFeatures?: Iterable<GPUFeatureName>
    requiredLimits?: Record<string, number>
}

type ScratchRuntimeConstructorOptions = ScratchRuntimeCreateOptions & {
    gpu: GPU
    adapter: GPUAdapter
    device: GPUDevice
}

export interface ScratchRuntime {
    id: string
    label?: string
    gpu: GPU
    adapter: GPUAdapter
    device: GPUDevice
    queue: GPUQueue
    adapterFeatures: GPUSupportedFeatures
    adapterLimits: GPUSupportedLimits
    deviceFeatures: GPUSupportedFeatures
    deviceLimits: GPUSupportedLimits
    isDisposed: boolean
    isDeviceLost: boolean
    deviceLostInfo?: GPUDeviceLostInfo
    _resources: Set<Resource>
    _surfaces: Set<Surface>
}

export class ScratchRuntime {

    private constructor(token: symbol, options: ScratchRuntimeConstructorOptions) {

        if (token !== runtimeToken) {
            throwScratchDiagnostic({
                code: 'SCRATCH_RUNTIME_CONSTRUCTOR_PRIVATE',
                severity: 'error',
                phase: 'runtime',
                subject: { kind: 'ScratchRuntime' },
                message: 'ScratchRuntime must be created with ScratchRuntime.create().',
                hints: [ 'Use await ScratchRuntime.create(options).' ],
            })
        }

        this.id = `scratch-runtime-${UUID()}`
        if (options.label !== undefined) this.label = options.label
        this.gpu = options.gpu
        this.adapter = options.adapter
        this.device = options.device
        this.queue = options.device.queue
        this.adapterFeatures = options.adapter.features
        this.adapterLimits = options.adapter.limits
        this.deviceFeatures = options.device.features
        this.deviceLimits = options.device.limits
        this.isDisposed = false
        this.isDeviceLost = false
        this._resources = new Set()
        this._surfaces = new Set()

        if (options.device.lost && typeof options.device.lost.then === 'function') {
            options.device.lost.then((info) => {
                this.isDeviceLost = true
                this.deviceLostInfo = info
            })
        }
    }

    static async create(options: ScratchRuntimeCreateOptions = {}) {

        const gpu = options.gpu ?? globalThis.navigator?.gpu

        if (!gpu || typeof gpu.requestAdapter !== 'function') {
            throwScratchDiagnostic({
                code: 'SCRATCH_RUNTIME_DEVICE_UNAVAILABLE',
                severity: 'error',
                phase: 'runtime',
                subject: { kind: 'ScratchRuntime' },
                message: 'WebGPU is unavailable for ScratchRuntime creation.',
                expected: { gpu: 'GPU with requestAdapter()' },
                actual: { gpu: gpu === undefined ? 'undefined' : typeof gpu },
                hints: [ 'Pass an explicit GPU object or run in a WebGPU-capable environment.' ],
            })
        }

        const adapterOptions = createAdapterOptions(options)
        const adapter = await gpu.requestAdapter(adapterOptions)

        if (!adapter || typeof adapter.requestDevice !== 'function') {
            throwScratchDiagnostic({
                code: 'SCRATCH_RUNTIME_DEVICE_UNAVAILABLE',
                severity: 'error',
                phase: 'runtime',
                subject: { kind: 'ScratchRuntime' },
                message: 'WebGPU adapter is unavailable for ScratchRuntime creation.',
                expected: { adapter: 'GPUAdapter with requestDevice()' },
                actual: { adapter: adapter === undefined || adapter === null ? String(adapter) : typeof adapter },
            })
        }

        const deviceDescriptor = createDeviceDescriptor(options)
        const device = await adapter.requestDevice(deviceDescriptor)

        if (!device) {
            throwScratchDiagnostic({
                code: 'SCRATCH_RUNTIME_DEVICE_UNAVAILABLE',
                severity: 'error',
                phase: 'runtime',
                subject: { kind: 'ScratchRuntime' },
                message: 'WebGPU device is unavailable for ScratchRuntime creation.',
                expected: { device: 'GPUDevice' },
                actual: { device: String(device) },
            })
        }

        return new ScratchRuntime(runtimeToken, {
            gpu,
            adapter,
            device,
            ...(options.label !== undefined ? { label: options.label } : {}),
        })
    }

    get subject(): DiagnosticSubject {

        const subject: DiagnosticSubject = {
            kind: 'ScratchRuntime',
            id: this.id,
        }
        if (this.label !== undefined) subject.label = this.label

        return subject
    }

    assertActive() {

        if (this.isDisposed) {
            throwScratchDiagnostic({
                code: 'SCRATCH_RUNTIME_DISPOSED',
                severity: 'error',
                phase: 'runtime',
                subject: this.subject,
                message: 'ScratchRuntime has been disposed.',
                hints: [ 'Create a new ScratchRuntime before creating resources or surfaces.' ],
            })
        }

        if (this.isDeviceLost) {
            throwScratchDiagnostic({
                code: 'SCRATCH_RUNTIME_DEVICE_LOST',
                severity: 'error',
                phase: 'runtime',
                subject: this.subject,
                message: 'ScratchRuntime device has been lost.',
                actual: this.deviceLostInfo,
                hints: [ 'Create a replacement runtime or wait for a future rehydration API.' ],
            })
        }
    }

    createSurface(canvas: HTMLCanvasElement | OffscreenCanvas, options: SurfaceOptions = {}) {

        this.assertActive()
        return new Surface(this, canvas, options)
    }

    surface(canvas: HTMLCanvasElement | OffscreenCanvas, options: SurfaceOptions = {}) {

        return this.createSurface(canvas, options)
    }

    createBuffer(descriptor: BufferResourceDescriptor) {

        this.assertActive()
        return new BufferResource(this, descriptor)
    }

    buffer(descriptor: BufferResourceDescriptor) {

        return this.createBuffer(descriptor)
    }

    createTexture(descriptor: TextureResourceDescriptor) {

        this.assertActive()
        return new TextureResource(this, descriptor)
    }

    texture(descriptor: TextureResourceDescriptor) {

        return this.createTexture(descriptor)
    }

    createSampler(descriptor?: SamplerResourceDescriptor) {

        this.assertActive()
        return new SamplerResource(this, descriptor)
    }

    sampler(descriptor?: SamplerResourceDescriptor) {

        return this.createSampler(descriptor)
    }

    createQuerySet(descriptor: QuerySetResourceDescriptor) {

        this.assertActive()
        return new QuerySetResource(this, descriptor)
    }

    querySet(descriptor: QuerySetResourceDescriptor) {

        return this.createQuerySet(descriptor)
    }

    createBindLayout(descriptor: BindLayoutDescriptor) {

        this.assertActive()
        return new BindLayout(this, descriptor)
    }

    bindLayout(descriptor: BindLayoutDescriptor) {

        return this.createBindLayout(descriptor)
    }

    createBindSet(layout: BindLayout, bindings: BindSetBindings, options?: BindSetOptions) {

        this.assertActive()
        return new BindSet(this, layout, bindings, options)
    }

    bindSet(layout: BindLayout, bindings: BindSetBindings, options?: BindSetOptions) {

        return this.createBindSet(layout, bindings, options)
    }

    createProgram(descriptor: ProgramDescriptor) {

        this.assertActive()
        return new Program(this, descriptor)
    }

    program(descriptor: ProgramDescriptor) {

        return this.createProgram(descriptor)
    }

    createRenderPipeline(descriptor: RenderPipelineDescriptor) {

        this.assertActive()
        return new RenderPipeline(this, descriptor)
    }

    renderPipeline(descriptor: RenderPipelineDescriptor) {

        return this.createRenderPipeline(descriptor)
    }

    createComputePipeline(descriptor: ComputePipelineDescriptor) {

        this.assertActive()
        return new ComputePipeline(this, descriptor)
    }

    computePipeline(descriptor: ComputePipelineDescriptor) {

        return this.createComputePipeline(descriptor)
    }

    createDrawCommand(descriptor: DrawCommandDescriptor) {

        this.assertActive()
        return new DrawCommand(this, descriptor)
    }

    drawCommand(descriptor: DrawCommandDescriptor) {

        return this.createDrawCommand(descriptor)
    }

    createBeginOcclusionQueryCommand(descriptor: BeginOcclusionQueryCommandDescriptor) {

        this.assertActive()
        return new BeginOcclusionQueryCommand(this, descriptor)
    }

    beginOcclusionQueryCommand(descriptor: BeginOcclusionQueryCommandDescriptor) {

        return this.createBeginOcclusionQueryCommand(descriptor)
    }

    createEndOcclusionQueryCommand(descriptor?: EndOcclusionQueryCommandDescriptor) {

        this.assertActive()
        return new EndOcclusionQueryCommand(this, descriptor)
    }

    endOcclusionQueryCommand(descriptor?: EndOcclusionQueryCommandDescriptor) {

        return this.createEndOcclusionQueryCommand(descriptor)
    }

    createDispatchCommand(descriptor: DispatchCommandDescriptor) {

        this.assertActive()
        return new DispatchCommand(this, descriptor)
    }

    dispatchCommand(descriptor: DispatchCommandDescriptor) {

        return this.createDispatchCommand(descriptor)
    }

    createUploadCommand(descriptor: UploadCommandDescriptor) {

        this.assertActive()
        return new UploadCommand(this, descriptor)
    }

    uploadCommand(descriptor: UploadCommandDescriptor) {

        return this.createUploadCommand(descriptor)
    }

    createCopyCommand(descriptor: CopyCommandDescriptor) {

        this.assertActive()
        return new CopyCommand(this, descriptor)
    }

    copyCommand(descriptor: CopyCommandDescriptor) {

        return this.createCopyCommand(descriptor)
    }

    createResolveQuerySetCommand(descriptor: ResolveQuerySetCommandDescriptor) {

        this.assertActive()
        return new ResolveQuerySetCommand(this, descriptor)
    }

    resolveQuerySetCommand(descriptor: ResolveQuerySetCommandDescriptor) {

        return this.createResolveQuerySetCommand(descriptor)
    }

    createTextureUploadCommand(descriptor: TextureUploadCommandDescriptor) {

        this.assertActive()
        return new TextureUploadCommand(this, descriptor)
    }

    textureUploadCommand(descriptor: TextureUploadCommandDescriptor) {

        return this.createTextureUploadCommand(descriptor)
    }

    createRenderPass(descriptor: RenderPassSpecDescriptor) {

        this.assertActive()
        return new RenderPassSpec(this, descriptor)
    }

    renderPass(descriptor: RenderPassSpecDescriptor) {

        return this.createRenderPass(descriptor)
    }

    createComputePass(descriptor?: ComputePassSpecDescriptor) {

        this.assertActive()
        return new ComputePassSpec(this, descriptor)
    }

    computePass(descriptor?: ComputePassSpecDescriptor) {

        return this.createComputePass(descriptor)
    }

    createReadback(descriptor: ReadbackOperationDescriptor) {

        this.assertActive()
        return new ReadbackOperation(this, descriptor)
    }

    readback(descriptor: ReadbackOperationDescriptor) {

        return this.createReadback(descriptor)
    }

    createSubmission(options: SubmissionBuilderOptions = {}) {

        this.assertActive()
        return new SubmissionBuilder(this, options)
    }

    submission(options: SubmissionBuilderOptions = {}) {

        return this.createSubmission(options)
    }

    dispose() {

        if (this.isDisposed) return

        for (const surface of [ ...this._surfaces ]) {
            surface.dispose()
        }

        for (const resource of [ ...this._resources ]) {
            resource.dispose()
        }

        if (this.device && typeof this.device.destroy === 'function') {
            this.device.destroy()
        }

        this.isDisposed = true
    }

    _registerResource(resource: Resource): void {

        this._resources.add(resource)
    }

    _unregisterResource(resource: Resource): void {

        this._resources.delete(resource)
    }

    _registerSurface(surface: Surface): void {

        this._surfaces.add(surface)
    }

    _unregisterSurface(surface: Surface): void {

        this._surfaces.delete(surface)
    }
}

function createAdapterOptions(options: ScratchRuntimeCreateOptions): GPURequestAdapterOptions | undefined {

    const adapterOptions: GPURequestAdapterOptions = {}

    if (options.powerPreference !== undefined) adapterOptions.powerPreference = options.powerPreference
    if (options.forceFallbackAdapter !== undefined) adapterOptions.forceFallbackAdapter = options.forceFallbackAdapter

    return Object.keys(adapterOptions).length ? adapterOptions : undefined
}

function createDeviceDescriptor(options: ScratchRuntimeCreateOptions): GPUDeviceDescriptor {

    const descriptor: GPUDeviceDescriptor = {}

    if (options.label !== undefined) descriptor.label = options.label
    if (options.requiredFeatures !== undefined) descriptor.requiredFeatures = Array.from(options.requiredFeatures)
    if (options.requiredLimits !== undefined) descriptor.requiredLimits = options.requiredLimits

    return descriptor
}
