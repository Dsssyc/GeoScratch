import { UUID } from '../core/utils/uuid.js'
import {
    createBindLayout as createScratchBindLayout,
    createBindSet as createScratchBindSet,
} from './binding.js'
import { runtimeBindLayoutSnapshot, runtimeBindSetSnapshot } from './binding-ownership.js'
import { BufferResource, createBufferResource } from './buffer.js'
import {
    BeginOcclusionQueryCommand,
    ClearBufferCommand,
    CopyCommand,
    createReadbackCommand as createScratchReadbackCommand,
    DispatchCommand,
    DrawCommand,
    EndOcclusionQueryCommand,
    ExternalImageUploadCommand,
    ReadbackCommand,
    ResolveQuerySetCommand,
    TextureUploadCommand,
    UploadCommand,
} from './command.js'
import { throwScratchDiagnostic } from './diagnostics.js'
import { ComputePassSpec, RenderPassSpec } from './pass.js'
import {
    createComputePipeline as createScratchComputePipeline,
    createRenderPipeline as createScratchRenderPipeline,
} from './pipeline.js'
import { runtimePipelineSnapshot } from './pipeline-ownership.js'
import { Program } from './program.js'
import { createQuerySetResource, QuerySetResource } from './query-set.js'
import { createReadbackOperation, ReadbackOperation } from './readback.js'
import {
    normalizeScratchReadbackPolicy,
    runtimeReadbackCommandSnapshot,
    runtimeReadbackOperationSnapshot,
} from './readback-ownership.js'
import {
    normalizeScratchRuntimeDiagnosticsOptions,
    registerRuntimeDiagnostics,
    retainDeviceLostInfo,
    ScratchRuntimeDiagnosticsController,
} from './runtime-diagnostics.js'
import {
    assertScratchRuntimeActive,
    disposeScratchRuntimeAuthority,
    initializeScratchRuntimeAuthority,
    loseScratchRuntimeAuthority,
    scratchRuntimeAuthoritySubject,
    scratchRuntimeDeviceLostInfo,
    scratchRuntimeIsDeviceLost,
    scratchRuntimeIsDisposed,
} from './runtime-authority.js'
import { createSamplerResource, SamplerResource } from './sampler.js'
import { SubmissionBuilder } from './submission.js'
import { Surface } from './surface.js'
import { createTextureResource, TextureResource } from './texture.js'
import type { BindLayout, BindLayoutDescriptor, BindSetBindings, BindSetOptions } from './binding.js'
import type { BufferResourceDescriptor } from './buffer.js'
import type { BeginOcclusionQueryCommandDescriptor, ClearBufferCommandDescriptor, CopyCommandDescriptor, DispatchCommandDescriptor, DrawCommandDescriptor, EndOcclusionQueryCommandDescriptor, ExternalImageUploadCommandDescriptor, ReadbackCommandDescriptor, ResolveQuerySetCommandDescriptor, TextureUploadCommandDescriptor, UploadCommandDescriptor } from './command.js'
import type { DiagnosticSubject } from './diagnostics.js'
import type { ComputePassSpecDescriptor, RenderPassSpecDescriptor } from './pass.js'
import type {
    ComputePipeline,
    ComputePipelineDescriptor,
    RenderPipeline,
    RenderPipelineDescriptor,
} from './pipeline.js'
import type { ProgramDescriptor } from './program.js'
import type { QuerySetResourceDescriptor } from './query-set.js'
import type { ReadbackOperationDescriptor } from './readback.js'
import type { ScratchReadbackOptions, ScratchReadbackPolicy } from './readback-ownership.js'
import type { Resource } from './resource.js'
import type {
    ScratchRuntimeDiagnostics,
    ScratchRuntimeDiagnosticsOptions,
    ScratchDeviceLostInfo,
    NormalizedScratchRuntimeDiagnosticsOptions,
} from './runtime-diagnostics.js'
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
    diagnostics?: ScratchRuntimeDiagnosticsOptions
    readback?: ScratchReadbackOptions
}

type ScratchRuntimeConstructorOptions = ScratchRuntimeCreateOptions & {
    gpu: GPU
    adapter: GPUAdapter
    device: GPUDevice
    readbackPolicy: ScratchReadbackPolicy
    diagnosticsPolicy: NormalizedScratchRuntimeDiagnosticsOptions
}

export interface ScratchRuntime {
    readonly id: string
    readonly label?: string
    readonly gpu: GPU
    readonly adapter: GPUAdapter
    readonly device: GPUDevice
    readonly queue: GPUQueue
    readonly adapterFeatures: GPUSupportedFeatures
    readonly adapterLimits: GPUSupportedLimits
    readonly deviceFeatures: GPUSupportedFeatures
    readonly deviceLimits: GPUSupportedLimits
    readonly wgslLanguageFeatures: readonly string[]
    readonly diagnostics: ScratchRuntimeDiagnostics
    readonly readbackPolicy: ScratchReadbackPolicy
    _resources: Set<Resource>
    _surfaces: Set<Surface>
}

export class ScratchRuntime {

    #diagnosticsController: ScratchRuntimeDiagnosticsController

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

        initializeScratchRuntimeAuthority(this)
        Object.defineProperties(this, {
            id: immutableRuntimeProperty(`scratch-runtime-${UUID()}`),
            label: immutableRuntimeProperty(options.label),
            gpu: immutableRuntimeProperty(options.gpu),
            adapter: immutableRuntimeProperty(options.adapter),
            device: immutableRuntimeProperty(options.device),
            queue: immutableRuntimeProperty(options.device.queue),
            adapterFeatures: immutableRuntimeProperty(options.adapter.features),
            adapterLimits: immutableRuntimeProperty(options.adapter.limits),
            deviceFeatures: immutableRuntimeProperty(options.device.features),
            deviceLimits: immutableRuntimeProperty(options.device.limits),
            wgslLanguageFeatures: immutableRuntimeProperty(
                snapshotWgslLanguageFeatures(options.gpu)
            ),
            readbackPolicy: immutableRuntimeProperty(options.readbackPolicy),
            isDisposed: immutableRuntimeGetter(() => scratchRuntimeIsDisposed(this)),
            isDeviceLost: immutableRuntimeGetter(() => scratchRuntimeIsDeviceLost(this)),
            deviceLostInfo: immutableRuntimeGetter(() => scratchRuntimeDeviceLostInfo(this)),
        })
        this._resources = new Set()
        this._surfaces = new Set()
        this.#diagnosticsController = new ScratchRuntimeDiagnosticsController(
            this,
            options.device,
            options.diagnosticsPolicy,
            options.readbackPolicy
        )
        registerRuntimeDiagnostics(this, this.#diagnosticsController)
        Object.defineProperty(this, 'diagnostics', {
            value: this.#diagnosticsController.facade,
            enumerable: true,
            writable: false,
            configurable: false,
        })

        if (options.device.lost && typeof options.device.lost.then === 'function') {
            options.device.lost.then((info) => {
                loseScratchRuntimeAuthority(this, retainDeviceLostInfo(info))
                this.#diagnosticsController.recordDeviceLoss(info)
                for (const readback of runtimeReadbackOperationSnapshot(this)) {
                    readback.cancel('device-lost')
                }
                for (const command of runtimeReadbackCommandSnapshot(this)) {
                    command.dispose()
                }
            })
        }
    }

    get isDisposed(): boolean {

        return scratchRuntimeIsDisposed(this)
    }

    get isDeviceLost(): boolean {

        return scratchRuntimeIsDeviceLost(this)
    }

    get deviceLostInfo(): ScratchDeviceLostInfo | undefined {

        return scratchRuntimeDeviceLostInfo(this)
    }

    static async create(options: ScratchRuntimeCreateOptions = {}) {

        const readbackPolicy = normalizeScratchReadbackPolicy(options.readback, options.label)
        const diagnosticsPolicy = normalizeScratchRuntimeDiagnosticsOptions(
            options.diagnostics,
            options.label
        )
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
            readbackPolicy,
            diagnosticsPolicy,
            ...(options.label !== undefined ? { label: options.label } : {}),
            ...(options.diagnostics !== undefined ? { diagnostics: options.diagnostics } : {}),
        })
    }

    get subject(): DiagnosticSubject {

        return scratchRuntimeAuthoritySubject(this)
    }

    assertActive() {

        assertScratchRuntimeActive(this)
    }

    createSurface(canvas: HTMLCanvasElement | OffscreenCanvas, options: SurfaceOptions = {}) {

        assertScratchRuntimeActive(this)
        return new Surface(this, canvas, options)
    }

    surface(canvas: HTMLCanvasElement | OffscreenCanvas, options: SurfaceOptions = {}) {

        return this.createSurface(canvas, options)
    }

    async createBuffer(descriptor: BufferResourceDescriptor): Promise<BufferResource> {

        assertScratchRuntimeActive(this)
        return createBufferResource(this, descriptor)
    }

    buffer(descriptor: BufferResourceDescriptor): Promise<BufferResource> {

        return this.createBuffer(descriptor)
    }

    async createTexture(descriptor: TextureResourceDescriptor): Promise<TextureResource> {

        assertScratchRuntimeActive(this)
        return createTextureResource(this, descriptor)
    }

    texture(descriptor: TextureResourceDescriptor): Promise<TextureResource> {

        return this.createTexture(descriptor)
    }

    async createSampler(descriptor?: SamplerResourceDescriptor): Promise<SamplerResource> {

        assertScratchRuntimeActive(this)
        return createSamplerResource(this, descriptor)
    }

    sampler(descriptor?: SamplerResourceDescriptor): Promise<SamplerResource> {

        return this.createSampler(descriptor)
    }

    async createQuerySet(descriptor: QuerySetResourceDescriptor): Promise<QuerySetResource> {

        assertScratchRuntimeActive(this)
        return createQuerySetResource(this, descriptor)
    }

    querySet(descriptor: QuerySetResourceDescriptor): Promise<QuerySetResource> {

        return this.createQuerySet(descriptor)
    }

    async createBindLayout(descriptor: BindLayoutDescriptor): Promise<BindLayout> {

        assertScratchRuntimeActive(this)
        return createScratchBindLayout(this, descriptor)
    }

    bindLayout(descriptor: BindLayoutDescriptor): Promise<BindLayout> {

        return this.createBindLayout(descriptor)
    }

    async createBindSet(
        layout: BindLayout,
        bindings: BindSetBindings,
        options?: BindSetOptions
    ): Promise<import('./binding.js').BindSet> {

        assertScratchRuntimeActive(this)
        return createScratchBindSet(this, layout, bindings, options)
    }

    bindSet(
        layout: BindLayout,
        bindings: BindSetBindings,
        options?: BindSetOptions
    ): Promise<import('./binding.js').BindSet> {

        return this.createBindSet(layout, bindings, options)
    }

    createProgram(descriptor: ProgramDescriptor) {

        assertScratchRuntimeActive(this)
        return new Program(this, descriptor)
    }

    program(descriptor: ProgramDescriptor) {

        return this.createProgram(descriptor)
    }

    async createRenderPipeline(descriptor: RenderPipelineDescriptor): Promise<RenderPipeline> {

        assertScratchRuntimeActive(this)
        return createScratchRenderPipeline(this, descriptor)
    }

    renderPipeline(descriptor: RenderPipelineDescriptor): Promise<RenderPipeline> {

        return this.createRenderPipeline(descriptor)
    }

    async createComputePipeline(descriptor: ComputePipelineDescriptor): Promise<ComputePipeline> {

        assertScratchRuntimeActive(this)
        return createScratchComputePipeline(this, descriptor)
    }

    computePipeline(descriptor: ComputePipelineDescriptor): Promise<ComputePipeline> {

        return this.createComputePipeline(descriptor)
    }

    createDrawCommand(descriptor: DrawCommandDescriptor) {

        assertScratchRuntimeActive(this)
        return new DrawCommand(this, descriptor)
    }

    drawCommand(descriptor: DrawCommandDescriptor) {

        return this.createDrawCommand(descriptor)
    }

    createBeginOcclusionQueryCommand(descriptor: BeginOcclusionQueryCommandDescriptor) {

        assertScratchRuntimeActive(this)
        return new BeginOcclusionQueryCommand(this, descriptor)
    }

    beginOcclusionQueryCommand(descriptor: BeginOcclusionQueryCommandDescriptor) {

        return this.createBeginOcclusionQueryCommand(descriptor)
    }

    createEndOcclusionQueryCommand(descriptor?: EndOcclusionQueryCommandDescriptor) {

        assertScratchRuntimeActive(this)
        return new EndOcclusionQueryCommand(this, descriptor)
    }

    endOcclusionQueryCommand(descriptor?: EndOcclusionQueryCommandDescriptor) {

        return this.createEndOcclusionQueryCommand(descriptor)
    }

    createDispatchCommand(descriptor: DispatchCommandDescriptor) {

        assertScratchRuntimeActive(this)
        return new DispatchCommand(this, descriptor)
    }

    dispatchCommand(descriptor: DispatchCommandDescriptor) {

        return this.createDispatchCommand(descriptor)
    }

    createUploadCommand(descriptor: UploadCommandDescriptor) {

        assertScratchRuntimeActive(this)
        return new UploadCommand(this, descriptor)
    }

    uploadCommand(descriptor: UploadCommandDescriptor) {

        return this.createUploadCommand(descriptor)
    }

    createClearBufferCommand(descriptor: ClearBufferCommandDescriptor) {

        assertScratchRuntimeActive(this)
        return new ClearBufferCommand(this, descriptor)
    }

    clearBufferCommand(descriptor: ClearBufferCommandDescriptor) {

        return this.createClearBufferCommand(descriptor)
    }

    createCopyCommand(descriptor: CopyCommandDescriptor) {

        assertScratchRuntimeActive(this)
        return new CopyCommand(this, descriptor)
    }

    copyCommand(descriptor: CopyCommandDescriptor) {

        return this.createCopyCommand(descriptor)
    }

    async createReadbackCommand(descriptor: ReadbackCommandDescriptor): Promise<ReadbackCommand> {

        assertScratchRuntimeActive(this)
        return createScratchReadbackCommand(this, descriptor)
    }

    readbackCommand(descriptor: ReadbackCommandDescriptor): Promise<ReadbackCommand> {

        return this.createReadbackCommand(descriptor)
    }

    createResolveQuerySetCommand(descriptor: ResolveQuerySetCommandDescriptor) {

        assertScratchRuntimeActive(this)
        return new ResolveQuerySetCommand(this, descriptor)
    }

    resolveQuerySetCommand(descriptor: ResolveQuerySetCommandDescriptor) {

        return this.createResolveQuerySetCommand(descriptor)
    }

    createTextureUploadCommand(descriptor: TextureUploadCommandDescriptor) {

        assertScratchRuntimeActive(this)
        return new TextureUploadCommand(this, descriptor)
    }

    textureUploadCommand(descriptor: TextureUploadCommandDescriptor) {

        return this.createTextureUploadCommand(descriptor)
    }

    createExternalImageUploadCommand(descriptor: ExternalImageUploadCommandDescriptor) {

        assertScratchRuntimeActive(this)
        return new ExternalImageUploadCommand(this, descriptor)
    }

    externalImageUploadCommand(descriptor: ExternalImageUploadCommandDescriptor) {

        return this.createExternalImageUploadCommand(descriptor)
    }

    createRenderPass(descriptor: RenderPassSpecDescriptor) {

        assertScratchRuntimeActive(this)
        return new RenderPassSpec(this, descriptor)
    }

    renderPass(descriptor: RenderPassSpecDescriptor) {

        return this.createRenderPass(descriptor)
    }

    createComputePass(descriptor?: ComputePassSpecDescriptor) {

        assertScratchRuntimeActive(this)
        return new ComputePassSpec(this, descriptor)
    }

    computePass(descriptor?: ComputePassSpecDescriptor) {

        return this.createComputePass(descriptor)
    }

    createReadback(descriptor: ReadbackOperationDescriptor) {

        assertScratchRuntimeActive(this)
        return createReadbackOperation(this, descriptor)
    }

    readback(descriptor: ReadbackOperationDescriptor) {

        return this.createReadback(descriptor)
    }

    createSubmission(options: SubmissionBuilderOptions = {}) {

        assertScratchRuntimeActive(this)
        return new SubmissionBuilder(this, options)
    }

    submission(options: SubmissionBuilderOptions = {}) {

        return this.createSubmission(options)
    }

    dispose() {

        if (!disposeScratchRuntimeAuthority(this)) return

        const failures: unknown[] = []
        const dispose = (action: () => void) => {
            try {
                action()
            } catch (error) {
                failures.push(error)
            }
        }

        for (const surface of [ ...this._surfaces ]) {
            dispose(() => surface.dispose())
        }

        for (const pipeline of runtimePipelineSnapshot(this)) {
            dispose(() => pipeline.dispose())
        }

        for (const bindSet of runtimeBindSetSnapshot(this)) {
            dispose(() => bindSet.dispose())
        }

        for (const layout of runtimeBindLayoutSnapshot(this)) {
            dispose(() => layout.dispose())
        }

        for (const readback of runtimeReadbackOperationSnapshot(this)) {
            dispose(() => readback.dispose())
        }

        for (const command of runtimeReadbackCommandSnapshot(this)) {
            dispose(() => command.dispose())
        }

        for (const resource of [ ...this._resources ]) {
            dispose(() => resource.dispose())
        }

        dispose(() => this.#diagnosticsController.dispose())

        if (this.device && typeof this.device.destroy === 'function') {
            dispose(() => this.device.destroy())
        }

        if (failures.length > 0) throw failures[0]
    }

    _registerResource(resource: Resource): void {

        this._resources.add(resource)
        this.#diagnosticsController.registerResource(resource)
    }

    _unregisterResource(resource: Resource): void {

        this._resources.delete(resource)
        this.#diagnosticsController.unregisterResource(resource)
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

function immutableRuntimeProperty<T>(value: T): PropertyDescriptor {

    return {
        value,
        enumerable: true,
        writable: false,
        configurable: false,
    }
}

function immutableRuntimeGetter<T>(get: () => T): PropertyDescriptor {

    return {
        get,
        enumerable: true,
        configurable: false,
    }
}

function createDeviceDescriptor(options: ScratchRuntimeCreateOptions): GPUDeviceDescriptor {

    const descriptor: GPUDeviceDescriptor = {}

    if (options.label !== undefined) descriptor.label = options.label
    if (options.requiredFeatures !== undefined) descriptor.requiredFeatures = Array.from(options.requiredFeatures)
    if (options.requiredLimits !== undefined) descriptor.requiredLimits = options.requiredLimits

    return descriptor
}

function snapshotWgslLanguageFeatures(gpu: GPU): readonly string[] {

    const features = gpu.wgslLanguageFeatures
    if (features === undefined) return Object.freeze([])

    const names = new Set<string>()
    for (const feature of features) {
        if (typeof feature === 'string') names.add(feature)
    }
    return Object.freeze([ ...names ].sort())
}
