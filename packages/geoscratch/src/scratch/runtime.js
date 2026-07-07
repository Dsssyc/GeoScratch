import { UUID } from '../core/utils/uuid.js'
import { BindLayout, BindSet } from './binding.js'
import { BufferResource } from './buffer.js'
import { DispatchCommand, DrawCommand, TextureUploadCommand, UploadCommand } from './command.js'
import { throwScratchDiagnostic } from './diagnostics.js'
import { ComputePassSpec, RenderPassSpec } from './pass.js'
import { ComputePipeline, RenderPipeline } from './pipeline.js'
import { Program } from './program.js'
import { ReadbackOperation } from './readback.js'
import { SamplerResource } from './sampler.js'
import { SubmissionBuilder } from './submission.js'
import { Surface } from './surface.js'
import { TextureResource } from './texture.js'

const runtimeToken = Symbol('ScratchRuntime')

export class ScratchRuntime {

    constructor(token, options = {}) {

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
        this.label = options.label
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
        this.deviceLostInfo = undefined
        this._resources = new Set()
        this._surfaces = new Set()

        if (options.device.lost && typeof options.device.lost.then === 'function') {
            options.device.lost.then((info) => {
                this.isDeviceLost = true
                this.deviceLostInfo = info
            })
        }
    }

    static async create(options = {}) {

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
            label: options.label,
        })
    }

    get subject() {

        const subject = {
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

    createSurface(canvas, options = {}) {

        this.assertActive()
        return new Surface(this, canvas, options)
    }

    surface(canvas, options = {}) {

        return this.createSurface(canvas, options)
    }

    createBuffer(descriptor) {

        this.assertActive()
        return new BufferResource(this, descriptor)
    }

    buffer(descriptor) {

        return this.createBuffer(descriptor)
    }

    createTexture(descriptor) {

        this.assertActive()
        return new TextureResource(this, descriptor)
    }

    texture(descriptor) {

        return this.createTexture(descriptor)
    }

    createSampler(descriptor) {

        this.assertActive()
        return new SamplerResource(this, descriptor)
    }

    sampler(descriptor) {

        return this.createSampler(descriptor)
    }

    createBindLayout(descriptor) {

        this.assertActive()
        return new BindLayout(this, descriptor)
    }

    bindLayout(descriptor) {

        return this.createBindLayout(descriptor)
    }

    createBindSet(layout, bindings, options) {

        this.assertActive()
        return new BindSet(this, layout, bindings, options)
    }

    bindSet(layout, bindings, options) {

        return this.createBindSet(layout, bindings, options)
    }

    createProgram(descriptor) {

        this.assertActive()
        return new Program(this, descriptor)
    }

    program(descriptor) {

        return this.createProgram(descriptor)
    }

    createRenderPipeline(descriptor) {

        this.assertActive()
        return new RenderPipeline(this, descriptor)
    }

    renderPipeline(descriptor) {

        return this.createRenderPipeline(descriptor)
    }

    createComputePipeline(descriptor) {

        this.assertActive()
        return new ComputePipeline(this, descriptor)
    }

    computePipeline(descriptor) {

        return this.createComputePipeline(descriptor)
    }

    createDrawCommand(descriptor) {

        this.assertActive()
        return new DrawCommand(this, descriptor)
    }

    drawCommand(descriptor) {

        return this.createDrawCommand(descriptor)
    }

    createDispatchCommand(descriptor) {

        this.assertActive()
        return new DispatchCommand(this, descriptor)
    }

    dispatchCommand(descriptor) {

        return this.createDispatchCommand(descriptor)
    }

    createUploadCommand(descriptor) {

        this.assertActive()
        return new UploadCommand(this, descriptor)
    }

    uploadCommand(descriptor) {

        return this.createUploadCommand(descriptor)
    }

    createTextureUploadCommand(descriptor) {

        this.assertActive()
        return new TextureUploadCommand(this, descriptor)
    }

    textureUploadCommand(descriptor) {

        return this.createTextureUploadCommand(descriptor)
    }

    createRenderPass(descriptor) {

        this.assertActive()
        return new RenderPassSpec(this, descriptor)
    }

    renderPass(descriptor) {

        return this.createRenderPass(descriptor)
    }

    createComputePass(descriptor) {

        this.assertActive()
        return new ComputePassSpec(this, descriptor)
    }

    computePass(descriptor) {

        return this.createComputePass(descriptor)
    }

    createReadback(descriptor) {

        this.assertActive()
        return new ReadbackOperation(this, descriptor)
    }

    readback(descriptor) {

        return this.createReadback(descriptor)
    }

    createSubmission(options = {}) {

        this.assertActive()
        return new SubmissionBuilder(this, options)
    }

    submission(options = {}) {

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

    _registerResource(resource) {

        this._resources.add(resource)
    }

    _unregisterResource(resource) {

        this._resources.delete(resource)
    }

    _registerSurface(surface) {

        this._surfaces.add(surface)
    }

    _unregisterSurface(surface) {

        this._surfaces.delete(surface)
    }
}

function createAdapterOptions(options) {

    const adapterOptions = {}

    if (options.powerPreference !== undefined) adapterOptions.powerPreference = options.powerPreference
    if (options.forceFallbackAdapter !== undefined) adapterOptions.forceFallbackAdapter = options.forceFallbackAdapter

    return Object.keys(adapterOptions).length ? adapterOptions : undefined
}

function createDeviceDescriptor(options) {

    const descriptor = {}

    if (options.label !== undefined) descriptor.label = options.label
    if (options.requiredFeatures !== undefined) descriptor.requiredFeatures = options.requiredFeatures
    if (options.requiredLimits !== undefined) descriptor.requiredLimits = options.requiredLimits

    return descriptor
}
