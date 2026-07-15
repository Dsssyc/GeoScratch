import * as scr from 'geoscratch'
import * as scratchCompat from 'geoscratch/scratch'
import { MercatorCoordinate } from 'geoscratch/geo'
import { plane, sphere } from 'geoscratch/geometry'

declare const typedImageBitmap: ImageBitmap
declare const typedImageData: ImageData
declare const typedImageElement: HTMLImageElement
declare const typedVideoElement: HTMLVideoElement
declare const typedVideoFrame: VideoFrame
declare const typedCanvasElement: HTMLCanvasElement
declare const typedOffscreenCanvas: OffscreenCanvas
declare const typedPipelineCompilationReport: scr.PipelineCompilationReport
declare const typedBufferResourceDescriptor: scr.BufferResourceDescriptor
declare const typedDiagnosticInput: scr.ScratchDiagnosticInput
declare const typedProgramDescriptor: scr.ProgramDescriptor
declare const typedProgramEntryPoints: scr.ProgramEntryPoints
declare const typedRenderPipelineDescriptor: scr.ScratchRenderPipelineDescriptor
declare const typedComputePipelineDescriptor: scr.ScratchComputePipelineDescriptor
declare const typedSurfaceFormat: scr.SurfaceFormat
declare const typedSurfaceOptions: scr.SurfaceOptions
declare const typedSurfaceSize: scr.SurfaceSize
declare const typedTextureUploadLayout: scr.TextureUploadLayout
declare const typedTextureUploadOrigin: scr.TextureUploadOrigin
declare const typedTextureUploadSize: scr.TextureUploadSize
const compatBufferResourceDescriptor: scratchCompat.BufferResourceDescriptor = typedBufferResourceDescriptor
const compatDiagnosticInput: scratchCompat.ScratchDiagnosticInput = typedDiagnosticInput
const compatProgramDescriptor: scratchCompat.ProgramDescriptor = typedProgramDescriptor
const compatProgramEntryPoints: scratchCompat.ProgramEntryPoints = typedProgramEntryPoints
const compatRenderPipelineDescriptor: scratchCompat.ScratchRenderPipelineDescriptor = typedRenderPipelineDescriptor
const compatComputePipelineDescriptor: scratchCompat.ScratchComputePipelineDescriptor = typedComputePipelineDescriptor
const compatSurfaceFormat: scratchCompat.SurfaceFormat = typedSurfaceFormat
const compatSurfaceOptions: scratchCompat.SurfaceOptions = typedSurfaceOptions
const compatSurfaceSize: scratchCompat.SurfaceSize = typedSurfaceSize
const compatTextureUploadLayout: scratchCompat.TextureUploadLayout = typedTextureUploadLayout
const compatTextureUploadOrigin: scratchCompat.TextureUploadOrigin = typedTextureUploadOrigin
const compatTextureUploadSize: scratchCompat.TextureUploadSize = typedTextureUploadSize
const typedPendingOperationKind: scr.ScratchPendingGpuOperationFact['kind'] = 'buffer-allocation'
// @ts-expect-error Disposal records are instantaneous and cannot be pending
const invalidPendingOperationKind: scr.ScratchPendingGpuOperationFact['kind'] = 'resource-disposal'

const startResult: Promise<GPUDevice | undefined> = scr.StartDash()
const device: GPUDevice = scr.getDevice()

const screen = scr.screen({
    canvas: document.createElement('canvas'),
})
const createdScreen: scr.Screen = scr.Screen.create({
    canvas: document.createElement('canvas'),
})

const pass = scr.renderPass({
    name: 'typed render pass',
    colorAttachments: [ { colorResource: screen } ],
})

const shader = scr.shader({
    name: 'typed shader',
    codeFunc: () => '@vertex fn vMain() -> @builtin(position) vec4f { return vec4f(); } @fragment fn fMain() -> @location(0) vec4f { return vec4f(); }',
})

const pipeline = scr.renderPipeline({
    name: 'typed pipeline',
    shader: { module: shader },
})

const binding = scr.binding({
    name: 'typed binding',
    range: () => [ 3 ],
})

pass.add(pipeline, binding)

const mercator = MercatorCoordinate.fromLonLat([ 0, 0 ])
const planeGeometry = plane(2)
const sphereGeometry = sphere(1, 8, 4)

async function useScratchFoundation(gpu: GPU, canvas: HTMLCanvasElement) {

    const runtime: scr.ScratchRuntime = await scr.ScratchRuntime.create({
        gpu,
        label: 'typed scratch runtime',
        requiredFeatures: [ 'timestamp-query' ],
        requiredLimits: { maxBufferSize: 1024 },
        diagnostics: {
            submissionScopes: 'summary',
            maxPendingNativeObservations: 8,
        },
    })
    const diagnostics: scr.ScratchRuntimeDiagnostics = runtime.diagnostics
    const compatDiagnostics: scratchCompat.ScratchRuntimeDiagnostics = diagnostics
    const diagnosticsSnapshot: scr.ScratchRuntimeDiagnosticsSnapshot = diagnostics.snapshot()
    const compatDiagnosticsSnapshot: scratchCompat.ScratchRuntimeDiagnosticsSnapshot = diagnosticsSnapshot
    const diagnosticsEvidence: scr.ScratchRuntimeDiagnosticsEvidence = diagnostics.exportEvidence()
    const compatDiagnosticsEvidence: scratchCompat.ScratchRuntimeDiagnosticsEvidence = diagnosticsEvidence
    const operationRecords: readonly scr.ScratchGpuOperationRecord[] = diagnostics.operations({
        kind: 'buffer-allocation',
        targetKind: 'resource',
        sequenceFrom: 1,
    })
    const pipelineOperationRecords: readonly scr.ScratchGpuOperationRecord[] = diagnostics.operations({
        kind: 'render-pipeline-creation',
        targetKind: 'pipeline',
        pipelineId: 'pipeline-id',
    })
    const submissionOperationRecords: readonly scr.ScratchGpuOperationRecord[] = diagnostics.operations({
        kind: 'submission-native-observation',
        targetKind: 'submission',
        submissionId: 'submission-id',
        nativeLocationKind: 'pass-command',
        nativeStage: 'command-encode',
        nativeOutcomeStatus: 'observed-failed',
    })
    const bindLayoutOperationRecords: readonly scr.ScratchGpuOperationRecord[] = diagnostics.operations({
        kind: 'bind-layout-allocation',
        targetKind: 'bind-layout',
        bindLayoutId: 'bind-layout-id',
    })
    const bindSetPreparationRecords: readonly scr.ScratchGpuOperationRecord[] = diagnostics.operations({
        kind: 'bind-set-preparation',
        targetKind: 'bind-set',
        bindSetId: 'bind-set-id',
        preparationStage: 'bind-group-acknowledgement',
    })
    const querySetOperationRecords: readonly scr.ScratchGpuOperationRecord[] = diagnostics.operations({
        resourceKind: 'QuerySetResource',
    })
    const operationTarget: scr.ScratchGpuOperationTarget | undefined = operationRecords[0]?.target
    if (operationTarget?.kind === 'resource') {
        const operationResourceId: string = operationTarget.resourceId
        // @ts-expect-error Resource targets do not fabricate pipeline identity
        operationTarget.pipelineId
    }
    if (pipelineOperationRecords[0]?.target.kind === 'pipeline') {
        const operationPipelineId: string = pipelineOperationRecords[0].target.pipelineId
        // @ts-expect-error Pipeline targets do not fabricate allocation versions
        pipelineOperationRecords[0].target.allocationVersion
    }
    const disposalRecords: readonly scr.ScratchGpuOperationRecord[] = diagnostics.operations({
        kind: 'resource-disposal',
    })
    const incidentRecords: readonly scr.ScratchGpuIncidentReport[] = diagnostics.incidents({
        kind: 'allocation-failure',
        targetKind: 'resource',
        sequenceFrom: 1,
    })
    const submissionIncidentRecords: readonly scr.ScratchGpuIncidentReport[] = diagnostics.incidents({
        kind: 'submission-failure',
        targetKind: 'submission',
        submissionId: 'submission-id',
        nativeLocationKind: 'queue-action',
        nativeStage: 'queue-submit',
    })
    const currentPipelineFacts: readonly scr.ScratchRuntimePipelineFact[] = diagnosticsSnapshot.pipelines
    const currentBindLayoutFacts: readonly scr.ScratchRuntimeBindLayoutFact[] = diagnosticsSnapshot.bindLayouts
    const currentResourceFacts: readonly scr.ScratchRuntimeResourceFact[] = diagnosticsSnapshot.resources
    for (const fact of currentResourceFacts) {
        if (fact.resourceKind === 'SamplerResource') {
            // @ts-expect-error Sampler facts do not fabricate scalar content epochs
            fact.contentEpoch
            // @ts-expect-error Sampler facts do not fabricate logical footprint
            fact.logicalFootprintBytes
        } else if (fact.resourceKind === 'QuerySetResource') {
            const slotFacts: readonly scr.QuerySetSlotSnapshot[] = fact.slots
            // @ts-expect-error QuerySet facts do not fabricate scalar content state
            fact.state
        } else {
            const contentEpoch: number = fact.contentEpoch
            const logicalFootprintBytes: number = fact.logicalFootprintBytes
        }
    }
    const evidenceSchemaVersion: 5 = diagnosticsEvidence.version
    const snapshotSchemaVersion: 5 = diagnosticsSnapshot.version
    const submissionScopeMode: scr.ScratchSubmissionScopeMode =
        diagnosticsSnapshot.submissionNative.submissionScopes
    const pendingNativeObservationBudget: number =
        diagnosticsSnapshot.submissionNative.maxPendingNativeObservations
    const compatPipelineCompilationReport: scratchCompat.PipelineCompilationReport = typedPipelineCompilationReport
    const compilationMessageSourceRedacted: boolean | undefined =
        typedPipelineCompilationReport.messages[0]?.sourceExcerptRedacted
    const nativeErrorSourceRedacted: boolean | undefined =
        incidentRecords[0]?.nativeError?.sourceExcerptRedacted
    const deviceLostInfo: scr.ScratchDeviceLostInfo | undefined = runtime.deviceLostInfo
    const compatDeviceLostInfo: scratchCompat.ScratchDeviceLostInfo | undefined = deviceLostInfo
    const nativeDeviceLossMessageOmitted: true | undefined =
        compatDeviceLostInfo?.nativeMessageOmitted
    const diagnosticCapture: scr.ScratchDiagnosticCapture = diagnostics.capture({
        maxOperations: 8,
        maxDurationMs: 100,
        maxEvidenceBytes: 4096,
        includeStacks: true,
        includeDescriptors: true,
        nativeSubmissionDetail: 'step',
    })
    const diagnosticCaptureReport: scr.ScratchDiagnosticCaptureReport = diagnosticCapture.stop()
    // @ts-expect-error Runtime native device ownership is read-only
    runtime.device = runtime.device
    // @ts-expect-error Runtime queue ownership is read-only
    runtime.queue = runtime.queue
    // @ts-expect-error Runtime disposal state is read-only
    runtime.isDisposed = false
    // @ts-expect-error Runtime device-loss state is read-only
    runtime.isDeviceLost = false
    // @ts-expect-error Retained runtime device-loss facts are read-only
    runtime.deviceLostInfo = undefined
    // @ts-expect-error Runtime diagnostics are read-only
    runtime.diagnostics = compatDiagnostics
    // @ts-expect-error Runtime pipeline ownership is package-internal
    runtime._pipelines
    // @ts-expect-error Runtime pipeline registration is package-internal
    runtime._registerPipeline
    // @ts-expect-error Runtime pipeline unregistration is package-internal
    runtime._unregisterPipeline
    // @ts-expect-error Runtime diagnostics cannot be externally constructed
    new scr.ScratchRuntimeDiagnostics()
    // @ts-expect-error Capture sessions cannot be externally constructed
    new scr.ScratchDiagnosticCapture()

    const surface: scr.Surface = runtime.createSurface(canvas, {
        format: 'preferred',
        usage: 0x14,
        viewFormats: [ 'bgra8unorm-srgb' ],
        colorSpace: 'display-p3',
        toneMapping: { mode: 'extended' },
        alphaMode: 'opaque',
        size: { width: 2, height: 2 },
    })
    const surfaceUsage: GPUTextureUsageFlags = surface.usage
    const surfaceViewFormats: readonly GPUTextureFormat[] = surface.viewFormats
    const surfaceColorSpace: PredefinedColorSpace = surface.colorSpace
    const surfaceToneMapping: Readonly<GPUCanvasToneMapping> | undefined = surface.toneMapping
    void surfaceUsage
    void surfaceViewFormats
    void surfaceColorSpace
    void surfaceToneMapping
    // @ts-expect-error Surface context ownership is read-only
    surface.context = surface.context
    // @ts-expect-error Surface runtime ownership is read-only
    surface.runtime = runtime
    // @ts-expect-error Surface configuration observations are read-only
    surface.format = 'rgba8unorm'
    // @ts-expect-error Surface native configuration observations are read-only
    surface.usage = 0x10
    // @ts-expect-error Surface native configuration observations are read-only
    surface.viewFormats = []
    // @ts-expect-error Surface native configuration observations are read-only
    surface.colorSpace = 'srgb'
    // @ts-expect-error Surface native configuration observations are read-only
    surface.toneMapping = { mode: 'standard' }
    // @ts-expect-error Surface lifecycle observations are read-only
    surface.isDisposed = false

    const buffer: scr.BufferResource = await runtime.createBuffer({
        label: 'typed scratch buffer',
        size: 16,
        usage: 1,
    })
    const wholeBufferRegion: scr.BufferRegion = buffer.region()
    const slicedBufferRegion: scr.BufferRegion = buffer.region({ offset: 4, size: 8 })
    const normalizedSubregion: scr.BufferRegion = slicedBufferRegion.subregion({ offset: 4 })
    const regionOffset: number = normalizedSubregion.offset
    const regionSize: number = normalizedSubregion.size
    // @ts-expect-error BufferRegion construction is closed
    new scr.BufferRegion()
    // @ts-expect-error BufferRegion facts are immutable
    wholeBufferRegion.offset = 4
    const resourceState: scr.ResourceState = buffer.state
    const readyResourceState: scr.ResourceState = 'ready'
    // @ts-expect-error disposal is lifecycle state, not scalar content state
    const disposedResourceState: scr.ResourceState = 'disposed'
    const resourceReady: boolean = buffer.isReady
    const compatResourceState: scratchCompat.ResourceState = resourceState
    const uniformBuffer: scr.BufferResource = await runtime.createBuffer({
        label: 'typed scratch uniform buffer',
        size: 16,
        usage: 0x8 | 0x40,
    })
    const vertexBuffer: scr.BufferResource = await runtime.createBuffer({
        label: 'typed scratch vertex buffer',
        size: 24,
        usage: 0x20 | 0x8,
    })
    const indexBuffer: scr.BufferResource = await runtime.createBuffer({
        label: 'typed scratch index buffer',
        size: 8,
        usage: 0x10 | 0x8,
    })
    const indirectBuffer: scr.BufferResource = await runtime.createBuffer({
        label: 'typed scratch indirect buffer',
        size: 32,
        usage: 0x100 | 0x80,
    })
    const storageInput: scr.BufferResource = await runtime.createBuffer({
        label: 'typed scratch storage input',
        size: 16,
        usage: 0x8 | 0x80,
    })
    const storageOutput: scr.BufferResource = await runtime.createBuffer({
        label: 'typed scratch storage output',
        size: 16,
        usage: 0x4 | 0x8 | 0x80,
    })
    const uniformRegion = uniformBuffer.region()
    const vertexRegion = vertexBuffer.region()
    const indexRegion = indexBuffer.region({ size: 6 })
    const indirectRegion = indirectBuffer.region()
    const storageInputRegion = storageInput.region()
    const storageOutputRegion = storageOutput.region()
    const uniformRead: scr.CommandResourceReadDescriptor = {
        resource: uniformBuffer,
        contentEpoch: uniformBuffer.contentEpoch,
    }
    const vertexRead: scr.CommandResourceReadDescriptor = {
        resource: vertexBuffer,
        contentEpoch: vertexBuffer.contentEpoch,
    }
    const indexRead: scr.CommandResourceReadDescriptor = {
        resource: indexBuffer,
        contentEpoch: indexBuffer.contentEpoch,
    }
    const indirectRead: scr.CommandResourceReadDescriptor = {
        resource: indirectBuffer,
        contentEpoch: indirectBuffer.contentEpoch,
    }
    const storageInputRead: scr.CommandResourceReadDescriptor = {
        resource: storageInput,
        contentEpoch: storageInput.contentEpoch,
    }
    const storageOutputRead: scr.CommandResourceReadDescriptor = {
        resource: storageOutput,
        contentEpoch: storageOutput.contentEpoch,
    }
    const compatStorageInputRead: scratchCompat.CommandResourceReadDescriptor = {
        resource: storageInput,
        contentEpoch: storageInput.contentEpoch,
    }
    const copySource: scr.BufferCopyCommandSourceDescriptor = {
        region: storageOutputRegion,
        contentEpoch: storageOutput.contentEpoch,
    }
    const genericCopySource: scr.CopyCommandSourceDescriptor = copySource
    const compatCopySource: scratchCompat.CopyCommandSourceDescriptor = copySource
    const queryDestination: scr.BufferResource = await runtime.createBuffer({
        label: 'typed scratch query destination',
        size: 256,
        usage: 0x4 | 0x200,
    })
    const objectTextureSize: scr.TextureResourceSize = { width: 2, height: 2 }
    const tupleTextureSize: scr.TextureResourceSize = [ 2, 2, 1 ]
    const compatTextureSize: scratchCompat.TextureResourceSize = tupleTextureSize
    const scratchTexture: scr.TextureResource = await runtime.createTexture({
        label: 'typed scratch texture',
        size: objectTextureSize,
        format: 'rgba8unorm',
        usage: 0x1 | 0x2 | 0x4 | 0x10,
        viewFormats: [ 'rgba8unorm-srgb' ],
        textureBindingViewDimension: '2d',
    })
    const scratchTextureCopyTarget: scr.TextureResource = await runtime.createTexture({
        label: 'typed scratch texture copy target',
        size: { width: 2, height: 2 },
        format: 'rgba8unorm',
        usage: 0x2 | 0x4,
    })
    const textureCopySource: scr.TextureCopyCommandSourceDescriptor = {
        resource: scratchTexture,
        contentEpoch: scratchTexture.contentEpoch,
    }
    const textureCopyOrigin: scr.TextureCopyOrigin = [ 0, 0 ]
    const textureCopySize: scr.TextureCopySize = { width: 2, height: 2 }
    const compatTextureCopySource: scratchCompat.TextureCopyCommandSourceDescriptor = textureCopySource
    const scratchDepthTexture: scr.TextureResource = await runtime.createTexture({
        label: 'typed scratch depth texture',
        size: { width: 2, height: 2 },
        format: 'depth24plus',
        usage: 0x4 | 0x10,
    })
    const samplerDescriptor: scr.SamplerResourceDescriptor = {
        label: 'typed scratch sampler',
        magFilter: 'nearest',
        minFilter: 'nearest',
    }
    const scratchSamplerPromise: Promise<scr.SamplerResource> = runtime.createSampler(samplerDescriptor)
    const scratchSampler: scr.SamplerResource = await scratchSamplerPromise
    const scratchSamplerAliasPromise: Promise<scr.SamplerResource> = runtime.sampler()
    // @ts-expect-error SamplerResource construction is closed
    new scr.SamplerResource(runtime, {})
    // @ts-expect-error SamplerResource has no static construction bypass
    scr.SamplerResource.create(runtime, {})
    // @ts-expect-error SamplerResource has no scalar content state
    scratchSampler.state
    // @ts-expect-error SamplerResource has no scalar content epoch
    scratchSampler.contentEpoch
    // @ts-expect-error SamplerResource has no readiness
    scratchSampler.isReady
    const defaultTextureViewSpec: scr.TextureViewSpec = scratchTexture.view()
    const explicitTextureViewSpec: scr.TextureViewSpec = scratchTexture.view({
        dimension: '2d',
        baseMipLevel: 0,
        mipLevelCount: 1,
        baseArrayLayer: 0,
        arrayLayerCount: 1,
    })
    const normalizedViewDescriptor: scr.NormalizedTextureViewDescriptor = explicitTextureViewSpec.descriptor
    // @ts-expect-error TextureViewSpec construction is closed
    new scr.TextureViewSpec()
    // @ts-expect-error TextureViewSpec descriptors are immutable
    normalizedViewDescriptor.baseMipLevel = 1
    // @ts-expect-error Native texture views are Scratch-owned preparation artifacts
    scratchTexture.createView()
    await scratchTexture.resize(compatTextureSize)
    // @ts-expect-error TextureResource descriptor is read-only
    scratchTexture.descriptor = scratchTexture.descriptor
    // @ts-expect-error Allocation transitions are internal lifecycle operations
    scratchTexture._replaceAllocation({})
    // @ts-expect-error Content transitions are internal lifecycle operations
    scratchTexture._advanceContentEpoch()
    // @ts-expect-error TextureResource physical allocation fields are read-only
    scratchTexture.gpuTexture = scratchTexture.gpuTexture
    // @ts-expect-error TextureResource normalized size is read-only
    scratchTexture.size = { width: 4, height: 4, depthOrArrayLayers: 1 }
    // @ts-expect-error TextureResource width is read-only
    scratchTexture.width = 4
    // @ts-expect-error TextureResource height is read-only
    scratchTexture.height = 4
    // @ts-expect-error TextureResource depthOrArrayLayers is read-only
    scratchTexture.depthOrArrayLayers = 2
    // @ts-expect-error TextureResource format is read-only
    scratchTexture.format = 'bgra8unorm'
    // @ts-expect-error TextureResource usage is read-only
    scratchTexture.usage = 0
    // @ts-expect-error TextureResource dimension is read-only
    scratchTexture.dimension = '3d'
    // @ts-expect-error TextureResource mipLevelCount is read-only
    scratchTexture.mipLevelCount = 2
    // @ts-expect-error TextureResource sampleCount is read-only
    scratchTexture.sampleCount = 4
    // @ts-expect-error TextureResource allocationVersion is read-only
    scratchTexture.allocationVersion = 2
    // @ts-expect-error TextureResource contentEpoch is read-only
    scratchTexture.contentEpoch = 1

    const scratchResource: scr.Resource = scratchTexture
    // @ts-expect-error Resource is abstract and direct construction is closed
    new scr.Resource(runtime)
    // @ts-expect-error Base Resource has no scalar content state
    scratchResource.state
    // @ts-expect-error Base Resource has no scalar content epoch
    scratchResource.contentEpoch
    // @ts-expect-error Base Resource has no readiness
    scratchResource.isReady
    // @ts-expect-error Resource runtime owner is read-only
    scratchResource.runtime = runtime
    // @ts-expect-error Resource logical id is read-only
    scratchResource.id = 'forged-resource-id'
    // @ts-expect-error Resource label is read-only
    scratchResource.label = 'forged label'
    // @ts-expect-error Resource kind is read-only
    scratchResource.resourceKind = 'ForgedResource'
    // @ts-expect-error Resource lifecycle state is read-only
    scratchResource.isDisposed = true
    // @ts-expect-error Resource allocationVersion is read-only
    scratchResource.allocationVersion = 2
    // @ts-expect-error Resource transition helpers are not package API
    scr.replaceResourceAllocation(scratchResource, scratchResource.descriptor)
    // @ts-expect-error Resource transition helpers are not package API
    scr.advanceResourceContentEpoch(scratchResource)
    // @ts-expect-error Resource transition helpers are not package API
    scr.setResourceContentState(scratchResource, 'ready', 1)
    // @ts-expect-error Texture view preparation is not package API
    scr.prepareTextureViewDescriptor(scratchTexture, {})
    // @ts-expect-error Texture binding view preparation is not package API
    scr.prepareTextureBindingViewDescriptor(scratchTexture, {})
    // @ts-expect-error Render attachment preflight is not package API
    scr.validateRenderPassAttachments(undefined as never)

    const diagnostic: scr.ScratchDiagnostic = scr.createScratchDiagnostic({
        code: 'SCRATCH_RESOURCE_WRONG_RUNTIME',
        severity: 'error',
        phase: 'resource',
        subject: { kind: 'Resource', id: buffer.id },
        message: 'typed diagnostic',
        hints: [ 'typed hint' ],
    })
    const report: scr.ScratchDiagnosticReport = scr.createScratchDiagnosticReport([ diagnostic ])
    const error = new scr.ScratchDiagnosticError(diagnostic, report)

    const codec: scr.LayoutCodec = scr.layoutCodec({
        label: 'typed layout codec',
        name: 'TypedUniforms',
        fields: [
            { name: 'position', type: 'vec3f' },
            { name: 'flags', type: { element: 'u32', count: 3 } },
            { name: 'transform', type: 'mat4x4f' },
        ],
    }, {
        usage: [ 'uniform', 'storage', 'readback' ],
    })
    const packed: Uint8Array = codec.pack({
        position: [ 1, 2, 3 ],
        flags: [ 1, 2, 3 ],
        transform: [
            1, 0, 0, 0,
            0, 1, 0, 0,
            0, 0, 1, 0,
            0, 0, 0, 1,
        ],
    })
    const uploadView = codec.uploadView({
        position: [ 1, 2, 3 ],
        flags: [ 1, 2, 3 ],
        transform: [
            1, 0, 0, 0,
            0, 1, 0, 0,
            0, 0, 1, 0,
            0, 0, 0, 1,
        ],
    })
    const typedReadback = codec.createReadbackView(packed)
    const wgslAccessors: string = codec.wgslAccessors({ namespace: 'TypedUniformsLayout' })
    const artifactByteLength: number = codec.artifact.byteLength
    const artifactAbiHash: string = codec.artifact.abiHash
    const artifactSchemaHash: string = codec.artifact.schemaHash
    // @ts-expect-error structuralHash was removed without an alias
    codec.artifact.structuralHash
    const typedRegion: scr.BufferRegion = buffer.region({
        offset: 0,
        size: codec.artifact.stride,
        layout: codec.artifact,
    })
    const reinterpretedRegion: scr.BufferRegion = typedRegion.interpretAs(codec.artifact)
    const regionElementCount: number | undefined = reinterpretedRegion.elementCount
    const usageCompatibility: scr.LayoutUsageCompatibility = codec.artifact.usageCompatibility
    const readbackCount: number = typedReadback.count
    const readbackObject: Record<string, unknown> = typedReadback.toObject()
    const layoutBuffer: scr.BufferResource = await runtime.createBuffer({
        label: 'typed scratch layout buffer',
        size: codec.artifact.stride * 2,
        usage: 0x8 | 0x80,
    })
    const layoutBufferRegion = layoutBuffer.region({
        size: codec.artifact.stride * 2,
        layout: codec.artifact,
    })
    const bufferLayout: scr.LayoutArtifact | undefined = layoutBufferRegion.layout
    const bufferElementCount: number | undefined = layoutBufferRegion.elementCount
    // @ts-expect-error BufferResource is a raw byte container
    layoutBuffer.layout
    // @ts-expect-error BufferResource has no element interpretation
    layoutBuffer.elementCount
    // @ts-expect-error BufferResource has no layout byte length
    layoutBuffer.layoutByteLength
    // @ts-expect-error BufferResource has no layout subject
    layoutBuffer.layoutSubject
    runtime.createBuffer({
        size: 16,
        usage: 0x80,
        // @ts-expect-error BufferResource descriptors cannot carry a layout
        layout: codec.artifact,
    })
    const programBufferRequirement: scr.ProgramBufferLayoutRequirement = {
        group: 0,
        binding: 0,
        name: 'uniforms',
        type: 'uniform',
        visibility: [ 'vertex', 'fragment' ],
        hasDynamicOffset: false,
        layout: codec.artifact,
    }
    const compatProgramBufferRequirement: scratchCompat.ProgramBufferLayoutRequirement = programBufferRequirement

    buffer.assertRuntime(runtime)

    const program: scr.Program = runtime.createProgram({
        label: 'typed program',
        modules: [
            '@vertex fn vsMain() -> @builtin(position) vec4f { return vec4f(); } @fragment fn fsMain() -> @location(0) vec4f { return vec4f(); }',
        ],
        entryPoints: {
            vertex: 'vsMain',
            fragment: 'fsMain',
        },
        layoutRequirements: [ programBufferRequirement ],
    })
    const normalizedRequirement: scr.ProgramBufferLayoutRequirement = program.layoutRequirements[0]
    // @ts-expect-error Program runtime ownership is readonly
    program.runtime = runtime
    // @ts-expect-error Program identity is readonly
    program.id = 'changed-program-id'
    // @ts-expect-error Program disposal is a readonly lifecycle observation
    program.isDisposed = false
    const bindLayoutDescriptor: scr.BindLayoutDescriptor = {
        label: 'typed bind layout',
        group: 0,
        entries: [
            {
                binding: 0,
                name: 'uniforms',
                type: 'uniform',
                visibility: [ 'vertex', 'fragment' ],
            },
        ],
    }
    const bindLayoutPromise: Promise<scr.BindLayout> = runtime.createBindLayout(bindLayoutDescriptor)
    const bindLayout: scr.BindLayout = await bindLayoutPromise
    const bindLayoutAliasPromise: Promise<scr.BindLayout> = runtime.bindLayout({ group: 0, entries: [] })
    // @ts-expect-error BindLayout construction is closed
    new scr.BindLayout(runtime, bindLayoutDescriptor)
    // @ts-expect-error BindLayout has no static construction bypass
    scr.BindLayout.create(runtime, bindLayoutDescriptor)
    // @ts-expect-error acknowledged BindLayout ABI facts are immutable
    bindLayout.group = 1
    // @ts-expect-error acknowledged BindLayout entries cannot be replaced
    bindLayout.entries = []
    const bindSetPromise: Promise<scr.BindSet> = runtime.createBindSet(bindLayout, {
        uniforms: uniformRegion,
    }, {
        label: 'typed bind set',
    })
    const bindSet: scr.BindSet = await bindSetPromise
    const storageLayout: scr.BindLayout = await runtime.createBindLayout({
        label: 'typed storage layout',
        group: 1,
        entries: [
            {
                binding: 0,
                name: 'inputValues',
                type: 'read-storage',
                visibility: [ 'compute' ],
            },
            {
                binding: 1,
                name: 'outputValues',
                type: 'storage',
                visibility: [ 'compute' ],
            },
        ],
    })
    const storageSet: scr.BindSet = await runtime.createBindSet(storageLayout, {
        inputValues: storageInputRegion,
        outputValues: storageOutputRegion,
    })
    // @ts-expect-error normalized BindSet bindings are immutable
    storageSet.bindings.clear()
    const dynamicStorageLayout: scr.BindLayout = await runtime.createBindLayout({
        label: 'typed dynamic storage layout',
        group: 3,
        entries: [
            {
                binding: 0,
                name: 'dynamicInputValues',
                type: 'read-storage',
                visibility: [ 'compute' ],
                hasDynamicOffset: true,
            },
            {
                binding: 1,
                name: 'dynamicOutputValues',
                type: 'storage',
                visibility: [ 'compute' ],
                hasDynamicOffset: true,
            },
        ],
    })
    const dynamicStorageSet: scr.BindSet = await runtime.createBindSet(dynamicStorageLayout, {
        dynamicInputValues: storageInputRegion,
        dynamicOutputValues: storageOutputRegion,
    })
    const compatDynamicUniformEntry: scratchCompat.UniformBindLayoutEntry = {
        binding: 0,
        name: 'compatDynamicUniforms',
        type: 'uniform',
        visibility: [ 'vertex' ],
        hasDynamicOffset: true,
    }
    const compatDynamicInvocation: scratchCompat.CommandBindSetInvocation = {
        set: dynamicStorageSet,
        dynamicOffsets: {
            dynamicInputValues: 256,
            dynamicOutputValues: 512,
        },
    }
    const textureLayout: scr.BindLayout = await runtime.createBindLayout({
        label: 'typed texture layout',
        group: 2,
        entries: [
            {
                binding: 0,
                name: 'colorTexture',
                type: 'texture',
                sampleType: 'float',
                viewDimension: '2d',
                visibility: [ 'fragment' ],
            },
            {
                binding: 1,
                name: 'colorSampler',
                type: 'sampler',
                samplerType: 'filtering',
                visibility: [ 'fragment' ],
            },
        ],
    })
    const textureSet: scr.BindSet = await runtime.createBindSet(textureLayout, {
        colorTexture: defaultTextureViewSpec,
        colorSampler: scratchSampler,
    })
    const upload: scr.UploadCommand = runtime.createUploadCommand({
        target: uniformRegion,
        data: new Float32Array([ 1, 0, 0, 1 ]),
    })
    const layoutUpload: scr.UploadCommand = runtime.createUploadCommand({
        target: layoutBufferRegion,
        data: uploadView,
    })
    const uploadLayout: scr.LayoutArtifact | undefined = layoutUpload.layout
    const textureUpload: scr.TextureUploadCommand = runtime.createTextureUploadCommand({
        target: scratchTexture,
        data: new Uint8Array(16),
        layout: { bytesPerRow: 8, rowsPerImage: 2 },
        size: { width: 2, height: 2 },
    })
    // @ts-expect-error buffer upload disposal state is read-only
    upload.isDisposed = false
    // @ts-expect-error buffer upload runtime is immutable
    upload.runtime = runtime
    // @ts-expect-error buffer upload target is immutable
    upload.target = uniformRegion
    // @ts-expect-error texture upload disposal state is read-only
    textureUpload.isDisposed = false
    // @ts-expect-error normalized texture upload layout is immutable
    textureUpload.layout.bytesPerRow = 256
    const externalImageSources: GPUCopyExternalImageSource[] = [
        typedImageBitmap,
        typedImageData,
        typedImageElement,
        typedVideoElement,
        typedVideoFrame,
        typedCanvasElement,
        typedOffscreenCanvas,
    ]
    const externalImageSourceOrigin: scr.ExternalImageUploadSourceOrigin = [ 0, 0 ]
    const externalImageUploadSize: scr.ExternalImageUploadSize = { width: 2, height: 2 }
    const externalImageUploadDescriptors: scr.ExternalImageUploadCommandDescriptor[] = externalImageSources.map(source => ({
        source,
        sourceOrigin: externalImageSourceOrigin,
        flipY: true,
        target: scratchTexture,
        origin: { x: 0, y: 0, z: 0 },
        mipLevel: 0,
        colorSpace: 'srgb',
        premultipliedAlpha: false,
        size: externalImageUploadSize,
    }))
    const compatExternalImageUploadDescriptor: scratchCompat.ExternalImageUploadCommandDescriptor = externalImageUploadDescriptors[0]
    const externalImageUpload: scr.ExternalImageUploadCommand = runtime.createExternalImageUploadCommand(externalImageUploadDescriptors[0])
    const externalImageUploadAlias: scratchCompat.ExternalImageUploadCommand = runtime.externalImageUploadCommand(compatExternalImageUploadDescriptor)
    // @ts-expect-error ExternalImageUploadCommand requires its native descriptor
    new scr.ExternalImageUploadCommand(runtime)
    const bufferUploadKind: 'buffer' = upload.uploadKind
    const textureUploadKind: 'texture' = textureUpload.uploadKind
    const externalImageUploadKind: 'external-image' = externalImageUpload.uploadKind
    const canonicalExternalImageSourceInfo: GPUCopyExternalImageSourceInfo = {
        source: externalImageUpload.source,
        origin: externalImageUpload.sourceOrigin,
        flipY: externalImageUpload.flipY,
    }
    const canonicalExternalImageDestInfo: GPUCopyExternalImageDestInfo = {
        texture: externalImageUpload.target.gpuTexture,
        origin: externalImageUpload.origin,
        mipLevel: externalImageUpload.mipLevel,
        aspect: 'all',
        colorSpace: externalImageUpload.colorSpace,
        premultipliedAlpha: externalImageUpload.premultipliedAlpha,
    }
    // @ts-expect-error external image upload source identity is immutable
    externalImageUpload.source = typedImageData
    // @ts-expect-error normalized external source origin is immutable
    externalImageUpload.sourceOrigin.x = 1
    const copy: scr.CopyCommand = runtime.createCopyCommand({
        label: 'typed scratch copy',
        source: genericCopySource,
        target: storageInputRegion,
        whenMissing: 'throw',
    })
    // @ts-expect-error copy disposal state is read-only
    copy.isDisposed = false
    // @ts-expect-error copy target is immutable
    copy.target = uniformRegion
    const texelCopyBufferLayout: scr.TexelCopyBufferLayout = {
        bytesPerRow: 256,
        rowsPerImage: 2,
    }
    const compatTexelCopyBufferLayout: scratchCompat.TexelCopyBufferLayout = texelCopyBufferLayout
    const bufferCopyDescriptor: scr.BufferToBufferCopyCommandDescriptor = {
        source: copySource,
        target: storageInputRegion,
        whenMissing: 'throw',
    }
    const copyAlias: scr.CopyCommand = runtime.copyCommand({
        source: compatCopySource,
        target: storageInputRegion,
        whenMissing: 'throw',
    })
    const textureCopyDescriptor: scr.TextureToTextureCopyCommandDescriptor = {
        label: 'typed scratch texture copy',
        source: textureCopySource,
        sourceOrigin: textureCopyOrigin,
        sourceMipLevel: 0,
        sourceAspect: 'all',
        target: scratchTextureCopyTarget,
        targetOrigin: { x: 0, y: 0 },
        targetMipLevel: 0,
        targetAspect: 'all',
        size: textureCopySize,
        whenMissing: 'throw',
    }
    const textureCopy: scr.CopyCommand = runtime.createCopyCommand(textureCopyDescriptor)
    const compatTextureCopyDescriptor: scratchCompat.TextureToTextureCopyCommandDescriptor = textureCopyDescriptor
    const textureCopyAlias: scratchCompat.CopyCommand = runtime.copyCommand(compatTextureCopyDescriptor)
    const bufferToTextureDescriptor: scr.BufferToTextureCopyCommandDescriptor = {
        label: 'typed scratch buffer-to-texture copy',
        source: copySource,
        sourceLayout: texelCopyBufferLayout,
        target: scratchTextureCopyTarget,
        targetOrigin: textureCopyOrigin,
        targetMipLevel: 0,
        targetAspect: 'all',
        size: textureCopySize,
        whenMissing: 'throw',
    }
    const compatBufferToTextureDescriptor: scratchCompat.BufferToTextureCopyCommandDescriptor = bufferToTextureDescriptor
    const textureToBufferDescriptor: scr.TextureToBufferCopyCommandDescriptor = {
        label: 'typed scratch texture-to-buffer copy',
        source: textureCopySource,
        sourceOrigin: textureCopyOrigin,
        sourceMipLevel: 0,
        sourceAspect: 'all',
        target: storageInputRegion,
        targetLayout: texelCopyBufferLayout,
        size: textureCopySize,
        whenMissing: 'throw',
    }
    const compatTextureToBufferDescriptor: scratchCompat.TextureToBufferCopyCommandDescriptor = textureToBufferDescriptor
    const copyKind: 'buffer-to-buffer' | 'texture-to-texture' | 'buffer-to-texture' | 'texture-to-buffer' = textureCopy.copyKind
    const compatCopyKind: 'buffer-to-buffer' | 'texture-to-texture' | 'buffer-to-texture' | 'texture-to-buffer' = textureCopyAlias.copyKind
    const querySetDescriptor: scr.QuerySetResourceDescriptor = {
        label: 'typed timestamp queries',
        type: 'timestamp',
        count: 2,
    }
    const querySetPromise: Promise<scr.QuerySetResource> = runtime.createQuerySet(querySetDescriptor)
    const querySet: scr.QuerySetResource = await querySetPromise
    // @ts-expect-error QuerySetResource construction is closed
    new scr.QuerySetResource(runtime, querySetDescriptor)
    // @ts-expect-error QuerySetResource has no static construction bypass
    scr.QuerySetResource.create(runtime, querySetDescriptor)
    const querySlot: scr.QuerySetSlotSnapshot = querySet.slot(0)
    const querySlots: readonly scr.QuerySetSlotSnapshot[] = querySet.slots()
    const querySlotState: scr.QuerySetSlotState = querySlot.state
    // @ts-expect-error QuerySetResource has no scalar content state
    querySet.state
    // @ts-expect-error QuerySetResource has no scalar content epoch
    querySet.contentEpoch
    // @ts-expect-error QuerySetResource has no readiness
    querySet.isReady
    // @ts-expect-error Query slot snapshots are immutable
    querySlot.contentEpoch = 2
    const querySlotRead: scr.QuerySetSlotReadDescriptor = {
        index: 0,
        contentEpoch: 1,
    }
    const queryResolveSource: scr.ResolveQuerySetSourceDescriptor = {
        querySet,
        slots: [
            querySlotRead,
            { index: 1, contentEpoch: 1 },
        ],
    }
    // @ts-expect-error normalized query slot reads are immutable
    querySlotRead.index = 1
    // @ts-expect-error normalized resolve slot arrays are immutable
    queryResolveSource.slots.push({ index: 1, contentEpoch: 1 })
    const querySetAlias: scr.QuerySetResource = await runtime.querySet({
        type: 'occlusion',
        count: 1,
    })
    const beginOcclusion: scr.BeginOcclusionQueryCommand = runtime.createBeginOcclusionQueryCommand({
        label: 'typed begin occlusion',
        querySet: querySetAlias,
        index: 0,
    })
    const beginOcclusionAlias: scr.BeginOcclusionQueryCommand = runtime.beginOcclusionQueryCommand({
        querySet: querySetAlias,
        index: 0,
    })
    const endOcclusion: scr.EndOcclusionQueryCommand = runtime.createEndOcclusionQueryCommand({
        label: 'typed end occlusion',
    })
    const endOcclusionAlias: scr.EndOcclusionQueryCommand = runtime.endOcclusionQueryCommand()
    // @ts-expect-error begin occlusion disposal state is read-only
    beginOcclusion.isDisposed = false
    // @ts-expect-error begin occlusion slot is immutable
    beginOcclusion.index = 1
    // @ts-expect-error end occlusion disposal state is read-only
    endOcclusion.isDisposed = false
    // @ts-expect-error end occlusion runtime is immutable
    endOcclusion.runtime = runtime
    const resolveQueries: scr.ResolveQuerySetCommand = runtime.createResolveQuerySetCommand({
        label: 'typed query resolve',
        source: queryResolveSource,
        destination: queryDestination.region({ size: 16 }),
        whenMissing: 'throw',
    })
    // @ts-expect-error resolve disposal state is read-only
    resolveQueries.isDisposed = false
    // @ts-expect-error resolve destination is immutable
    resolveQueries.destination = queryDestination.region({ size: 16 })
    // @ts-expect-error normalized resolve source is immutable
    resolveQueries.source = queryResolveSource
    // @ts-expect-error native resolve range is derived from the immutable source
    resolveQueries.firstQuery = 1
    const resolveAlias: scr.ResolveQuerySetCommand = runtime.resolveQuerySetCommand({
        source: {
            querySet,
            slots: [
                { index: 0, contentEpoch: 1 },
            ],
        },
        destination: queryDestination.region({ size: 8 }),
        whenMissing: 'throw',
    })
    const resolveSourceQuerySet: scr.QuerySetResource = resolveQueries.source.querySet
    const resolveSourceSlotEpoch: number = resolveQueries.source.slots[0].contentEpoch
    const scratchPipelinePromise: Promise<scr.ScratchRenderPipeline> = runtime.createRenderPipeline({
        label: 'typed scratch pipeline',
        program,
        bindLayouts: [ bindLayout ],
        vertexBuffers: [
            {
                arrayStride: 8,
                attributes: [
                    { shaderLocation: 0, offset: 0, format: 'float32x2' },
                ],
            },
        ],
        targets: [ { format: surface.format } ],
    })
    const scratchPipeline: scr.ScratchRenderPipeline = await scratchPipelinePromise
    const scratchPipelineAlias: scr.ScratchRenderPipeline = await runtime.renderPipeline({
        program,
        targets: [ { format: surface.format } ],
    })
    const compatRenderPipeline: scratchCompat.ScratchRenderPipeline = scratchPipelineAlias
    // @ts-expect-error Pipeline construction is runtime-owned and asynchronous
    new scr.ScratchRenderPipeline(runtime, { program, targets: [ { format: surface.format } ] })
    const draw: scr.DrawCommand = runtime.createDrawCommand({
        pipeline: scratchPipeline,
        bindSets: [ { set: bindSet } ],
        vertexBuffers: [
            { slot: 0, region: vertexRegion },
        ],
        count: { vertexCount: 3 },
        resources: {
            read: [ uniformRead, vertexRead ],
            write: [],
        },
        whenMissing: 'throw',
    })
    const drawReadiness: scr.CommandReadinessDescriptor<scr.DrawCommand> = {
        whenMissing: 'use-fallback',
        fallback: draw,
    }
    const compatDrawReadiness: scratchCompat.CommandReadinessDescriptor<scratchCompat.DrawCommand> = drawReadiness
    const fallbackDraw: scr.DrawCommand = runtime.createDrawCommand({
        pipeline: scratchPipeline,
        bindSets: [ { set: bindSet } ],
        vertexBuffers: [
            { slot: 0, region: vertexRegion },
        ],
        count: { vertexCount: 3 },
        resources: {
            read: [ uniformRead, vertexRead ],
            write: [],
        },
        whenMissing: 'use-fallback',
        fallback: draw,
    })
    // @ts-expect-error use-fallback requires a fallback command
    runtime.createDrawCommand({
        pipeline: scratchPipeline,
        count: { vertexCount: 3 },
        resources: { read: [], write: [] },
        whenMissing: 'use-fallback',
    })
    // @ts-expect-error non-fallback policies forbid fallback commands
    runtime.createDrawCommand({
        pipeline: scratchPipeline,
        count: { vertexCount: 3 },
        resources: { read: [], write: [] },
        whenMissing: 'skip-command',
        fallback: draw,
    })
    const staticIndexedCount: scr.StaticIndexedDrawCount = { indexCount: 3 }
    const indirectCount: scr.IndirectCommandCount = { indirect: indirectRegion }
    const drawCount: scr.DrawCount = staticIndexedCount
    const dispatchCount: scr.DispatchCount = indirectCount
    const indexBinding: scr.DrawIndexBufferBinding = {
        region: indexRegion,
        format: 'uint16',
    }
    const compatStaticIndexedCount: scratchCompat.StaticIndexedDrawCount = staticIndexedCount
    const compatIndirectCount: scratchCompat.IndirectCommandCount = indirectCount
    const compatDrawCount: scratchCompat.DrawCount = drawCount
    const compatDispatchCount: scratchCompat.DispatchCount = dispatchCount
    const compatIndexBinding: scratchCompat.DrawIndexBufferBinding = indexBinding
    const indexedDraw: scr.DrawCommand = runtime.createDrawCommand({
        pipeline: scratchPipeline,
        indexBuffer: indexBinding,
        count: drawCount,
        resources: {
            read: [ uniformRead, indexRead ],
            write: [],
        },
        whenMissing: 'throw',
    })
    const indirectDraw: scr.DrawCommand = runtime.createDrawCommand({
        pipeline: scratchPipeline,
        count: indirectCount,
        resources: {
            read: [ uniformRead, indirectRead ],
            write: [],
        },
        whenMissing: 'throw',
    })
    const indexedIndirectDraw: scr.DrawCommand = runtime.createDrawCommand({
        pipeline: scratchPipeline,
        indexBuffer: indexBinding,
        count: indirectCount,
        resources: {
            read: [ uniformRead, indexRead, indirectRead ],
            write: [],
        },
        whenMissing: 'throw',
    })
    // @ts-expect-error indexed counts require an index buffer
    runtime.createDrawCommand({
        pipeline: scratchPipeline,
        count: staticIndexedCount,
        resources: { read: [ indexRead ], write: [] },
        whenMissing: 'throw',
    })
    // @ts-expect-error static non-indexed counts forbid an index buffer
    runtime.createDrawCommand({
        pipeline: scratchPipeline,
        indexBuffer: indexBinding,
        count: { vertexCount: 3 },
        resources: { read: [ indexRead ], write: [] },
        whenMissing: 'throw',
    })
    runtime.createDrawCommand({
        pipeline: scratchPipeline,
        // @ts-expect-error direct and indirect draw count fields are mutually exclusive
        count: { vertexCount: 3, indirect: indirectBuffer },
        resources: { read: [ indirectRead ], write: [] },
        whenMissing: 'throw',
    })
    runtime.createDrawCommand({
        pipeline: scratchPipeline,
        // @ts-expect-error vertex and indexed count fields are mutually exclusive
        count: { vertexCount: 3, indexCount: 3 },
        resources: { read: [], write: [] },
        whenMissing: 'throw',
    })
    // @ts-expect-error command count is immutable after construction
    draw.count = { vertexCount: 6 }
    // @ts-expect-error command resource declarations are immutable after construction
    draw.resources = { read: [], write: [] }
    // @ts-expect-error normalized command read declarations are immutable
    draw.resources.read.push(indirectRead)
    // @ts-expect-error normalized index bindings are immutable
    indexedDraw.indexBuffer!.buffer = indexBuffer
    // @ts-expect-error command disposal state is read-only
    draw.isDisposed = false
    const drawResources: scr.CommandResourceAccessDescriptor = draw.resources
    const drawReadResource: scr.Resource = drawResources.read[0].resource
    const drawReadContentEpoch: number = drawResources.read[0].contentEpoch
    const compatDraw: scratchCompat.DrawCommand = draw
    const compatIndexedDraw: scratchCompat.DrawCommand = indexedDraw
    const compatIndirectDraw: scratchCompat.DrawCommand = indirectDraw
    const compatIndexedIndirectDraw: scratchCompat.DrawCommand = indexedIndirectDraw
    const compatDrawResources: scratchCompat.CommandResourceAccessDescriptor = compatDraw.resources
    const compatDrawReadResource: scratchCompat.Resource = compatDrawResources.read[0].resource
    const compatDrawReadContentEpoch: number = compatDrawResources.read[0].contentEpoch
    const compatQuerySlotState: scratchCompat.QuerySetSlotState = querySet.slot(0).state
    const compatQueryResolveSource: scratchCompat.ResolveQuerySetSourceDescriptor = resolveQueries.source
    const passSpec: scr.RenderPassSpec = runtime.createRenderPass({
        color: [ {
            target: surface,
            load: 'clear',
            store: 'store',
            clear: { r: 0, g: 0, b: 0, a: 1 },
        } ],
        timestampWrites: {
            querySet,
            begin: 0,
            end: 1,
        },
        occlusionQuerySet: querySetAlias,
    })
    // @ts-expect-error normalized render pass attachment arrays are immutable
    passSpec.color = []
    // @ts-expect-error normalized render pass attachments are immutable
    passSpec.color[0].store = 'discard'
    // @ts-expect-error normalized render pass timestamp writes are immutable
    passSpec.timestampWrites!.begin = 1
    // @ts-expect-error render pass disposal state is read-only
    passSpec.isDisposed = false
    const textureTargetPass: scr.RenderPassSpec = runtime.createRenderPass({
        color: [ {
            target: defaultTextureViewSpec,
            load: 'clear',
            store: 'store',
            clear: [ 0, 0, 0, 1 ],
        } ],
    })
    const depthAttachment: scr.RenderPassDepthStencilAttachmentSpec = {
        target: scratchDepthTexture.view(),
        depthLoad: 'clear',
        depthStore: 'store',
        depthClear: 1,
    }
    const compatDepthAttachment: scratchCompat.RenderPassDepthStencilAttachmentSpec = depthAttachment
    const depthPassDescriptor: scr.RenderPassSpecDescriptor = {
        color: [ {
            target: defaultTextureViewSpec,
            load: 'clear',
            store: 'store',
        } ],
        depth: depthAttachment,
    }
    const compatDepthPassDescriptor: scratchCompat.RenderPassSpecDescriptor = depthPassDescriptor
    const depthPass: scr.RenderPassSpec = runtime.createRenderPass(depthPassDescriptor)
    const depthPassTarget: scr.TextureViewSpec | undefined = depthPass.depth?.target
    const depthPassLoad: GPULoadOp | undefined = depthPass.depth?.depthLoad
    const compatDepthPass: scratchCompat.RenderPassSpec = runtime.createRenderPass(compatDepthPassDescriptor)
    // @ts-expect-error normalized depth attachments are immutable
    depthPass.depth!.depthStore = 'discard'
    const compatDepthPassTarget: scratchCompat.TextureViewSpec | undefined = compatDepthPass.depth?.target
    const compatDepthLoad: GPULoadOp | undefined = compatDepthAttachment.depthLoad
    const computeProgram: scr.Program = runtime.createProgram({
        modules: [
            '@group(1) @binding(0) var<storage, read> inputValues: array<f32>; @group(1) @binding(1) var<storage, read_write> outputValues: array<f32>; @compute @workgroup_size(4) fn csMain(@builtin(global_invocation_id) id: vec3u) { outputValues[id.x] = inputValues[id.x]; }',
        ],
        entryPoints: {
            compute: 'csMain',
        },
    })
    const shaderInspectionInput: scr.ShaderInspectionInput = computeProgram
    const shaderInspectionOptions: scr.ShaderInspectionOptions = { program: computeProgram }
    const shaderInspection: scr.ShaderInspection = scr.inspectShader(shaderInspectionInput, shaderInspectionOptions)
    const shaderBinding: scr.ShaderBinding | undefined = shaderInspection.bindings[0]
    const shaderBindingType: scr.ShaderBindingResourceType | undefined = shaderBinding?.type
    const shaderComparisonOptions: scr.ShaderBindLayoutComparisonOptions = {
        program: computeProgram,
        suppress: [
            {
                code: 'SCRATCH_BIND_SHADER_INDEX_MISMATCH',
                group: 3,
                binding: 0,
            },
        ],
    }
    const shaderComparisonReport: scr.ScratchDiagnosticReport = shaderInspection.compareBindLayouts([ storageLayout ], shaderComparisonOptions)
    const compatShaderInspectionInput: scratchCompat.ShaderInspectionInput = computeProgram
    const compatShaderInspectionOptions: scratchCompat.ShaderInspectionOptions = { program: computeProgram }
    const compatShaderInspection: scratchCompat.ShaderInspection = scratchCompat.inspectShader(compatShaderInspectionInput, compatShaderInspectionOptions)
    const compatShaderBinding: scratchCompat.ShaderBinding | undefined = compatShaderInspection.bindings[0]
    const compatShaderBindingType: scratchCompat.ShaderBindingResourceType | undefined = compatShaderBinding?.type
    const compatShaderComparisonOptions: scratchCompat.ShaderBindLayoutComparisonOptions = {
        suppress: [
            {
                group: 9,
                binding: 9,
            },
        ],
    }
    const compatShaderReport: scratchCompat.ScratchDiagnosticReport = scratchCompat.inspectShader([
        '@group(9) @binding(9) var<uniform> camera: Camera;',
    ]).compareBindLayouts([], compatShaderComparisonOptions)
    const computePipelinePromise: Promise<scr.ScratchComputePipeline> = runtime.createComputePipeline({
        program: computeProgram,
        bindLayouts: [ storageLayout ],
    })
    const computePipeline: scr.ScratchComputePipeline = await computePipelinePromise
    const computePipelineAlias: scr.ScratchComputePipeline = await runtime.computePipeline({
        program: computeProgram,
        bindLayouts: [ storageLayout ],
    })
    const compatComputePipeline: scratchCompat.ScratchComputePipeline = computePipelineAlias
    // @ts-expect-error Pipeline construction is runtime-owned and asynchronous
    new scr.ScratchComputePipeline(runtime, { program: computeProgram })
    runtime.createDispatchCommand({
        pipeline: computePipeline,
        // @ts-expect-error direct and indirect dispatch count fields are mutually exclusive
        count: { workgroups: [ 1 ], indirect: indirectBuffer },
        resources: { read: [ indirectRead ], write: [] },
        whenMissing: 'throw',
    })
    const dynamicComputePipeline: scr.ScratchComputePipeline = await runtime.createComputePipeline({
        program: computeProgram,
        bindLayouts: [ dynamicStorageLayout ],
    })
    const dispatch: scr.DispatchCommand = runtime.createDispatchCommand({
        pipeline: computePipeline,
        bindSets: [ { set: storageSet } ],
        count: { workgroups: [ 1 ] },
        resources: {
            read: [ storageInputRead, storageOutputRead ],
            write: [ storageOutput ],
        },
        whenMissing: 'throw',
    })
    const dispatchReadiness: scr.CommandReadinessDescriptor<scr.DispatchCommand> = {
        whenMissing: 'use-fallback',
        fallback: dispatch,
    }
    const compatDispatchReadiness: scratchCompat.CommandReadinessDescriptor<scratchCompat.DispatchCommand> = dispatchReadiness
    const fallbackDispatch: scr.DispatchCommand = runtime.createDispatchCommand({
        pipeline: computePipeline,
        bindSets: [ { set: storageSet } ],
        count: { workgroups: [ 1 ] },
        resources: {
            read: [ storageInputRead, storageOutputRead ],
            write: [ storageOutput ],
        },
        whenMissing: 'use-fallback',
        fallback: dispatch,
    })
    // @ts-expect-error use-fallback requires a fallback command
    runtime.createDispatchCommand({
        pipeline: computePipeline,
        count: { workgroups: [ 1 ] },
        resources: { read: [], write: [] },
        whenMissing: 'use-fallback',
    })
    // @ts-expect-error non-fallback policies forbid fallback commands
    runtime.createDispatchCommand({
        pipeline: computePipeline,
        count: { workgroups: [ 1 ] },
        resources: { read: [], write: [] },
        whenMissing: 'skip-pass',
        fallback: dispatch,
    })
    runtime.createDrawCommand({
        pipeline: scratchPipeline,
        count: { vertexCount: 3 },
        resources: { read: [], write: [] },
        whenMissing: 'use-fallback',
        // @ts-expect-error DrawCommand fallback must also be a DrawCommand
        fallback: dispatch,
    })
    runtime.createDispatchCommand({
        pipeline: computePipeline,
        count: { workgroups: [ 1 ] },
        resources: { read: [], write: [] },
        whenMissing: 'use-fallback',
        // @ts-expect-error DispatchCommand fallback must also be a DispatchCommand
        fallback: draw,
    })
    const indirectDispatch: scr.DispatchCommand = runtime.createDispatchCommand({
        pipeline: computePipeline,
        bindSets: [ { set: storageSet } ],
        count: dispatchCount,
        resources: {
            read: [ storageInputRead, storageOutputRead, indirectRead ],
            write: [ storageOutput ],
        },
        whenMissing: 'throw',
    })
    const dynamicDispatch: scr.DispatchCommand = runtime.createDispatchCommand({
        pipeline: dynamicComputePipeline,
        bindSets: [ {
            set: dynamicStorageSet,
            dynamicOffsets: {
                dynamicInputValues: 256,
                dynamicOutputValues: 512,
            },
        } ],
        count: { workgroups: [ 1 ] },
        resources: {
            read: [ storageInputRead, storageOutputRead ],
            write: [ storageOutput ],
        },
        whenMissing: 'throw',
    })
    const compatDynamicDispatchDescriptor: scratchCompat.DispatchCommandDescriptor = {
        pipeline: dynamicComputePipeline,
        bindSets: [ compatDynamicInvocation ],
        count: { workgroups: [ 1 ] },
        resources: {
            read: [ compatStorageInputRead, storageOutputRead ],
            write: [ storageOutput ],
        },
        whenMissing: 'throw',
    }
    const compatDynamicDispatch: scratchCompat.DispatchCommand = runtime.createDispatchCommand(compatDynamicDispatchDescriptor)
    const computePass: scr.ComputePassSpec = runtime.createComputePass({
        timestampWrites: {
            querySet,
            begin: 0,
        },
    })
    // @ts-expect-error normalized compute pass timestamp writes are immutable
    computePass.timestampWrites!.begin = 1
    // @ts-expect-error compute pass disposal state is read-only
    computePass.isDisposed = false
    const renderCommands: scr.RenderCommand[] = [ beginOcclusion, draw, endOcclusion ]
    const validationMode: scr.SubmissionValidationMode = 'warn'
    const compatValidationMode: scratchCompat.SubmissionValidationMode = 'off'
    const submissionOptions: scr.SubmissionBuilderOptions = { validation: validationMode }
    const compatSubmissionOptions: scratchCompat.SubmissionBuilderOptions = { validation: compatValidationMode }
    // @ts-expect-error queue replay is package-internal submission lowering
    upload._writeToQueue(runtime.queue)
    // @ts-expect-error logical upload commitment is package-internal submission lowering
    upload._commitLogicalWrite()
    // @ts-expect-error texture queue replay is package-internal submission lowering
    textureUpload._writeToQueue(runtime.queue)
    // @ts-expect-error texture logical commitment is package-internal submission lowering
    textureUpload._commitLogicalWrite()
    const builder: scr.SubmissionBuilder = runtime.createSubmission(submissionOptions)
    const submitted: scr.SubmittedWork = builder.upload(upload).upload(textureUpload).upload(externalImageUpload).compute(computePass, [ dispatch ]).copy(copy).copy(copyAlias).resolve(resolveQueries).resolve(resolveAlias).render(passSpec, renderCommands).submit()
    const nativeOutcome: Promise<scr.ScratchSubmissionNativeOutcome> = submitted.nativeOutcome
    const compatNativeOutcome: Promise<scratchCompat.ScratchSubmissionNativeOutcome> = nativeOutcome
    const readbackNativeOutcome: scr.ScratchReadbackNativeOutcome = {
        version: 5,
        readbackId: 'readback-id',
        mode: 'off',
        status: 'unobserved',
        locations: [],
        outcomes: [],
        omittedLocationCount: 0,
        omittedOutcomeCount: 0,
    }
    const compatReadbackNativeOutcome: scratchCompat.ScratchReadbackNativeOutcome = readbackNativeOutcome
    // @ts-expect-error direct readback native outcomes cannot fabricate submission locations
    readbackNativeOutcome.locations[0] = { kind: 'submission', submissionId: submitted.id }
    const indeterminateResourceState: scr.ResourceState = 'indeterminate'
    const indeterminateQuerySlotState: scr.QuerySetSlotState = 'indeterminate'
    const potentialWrites: readonly scr.SubmittedPotentialWrite[] = submitted.potentialWrites
    // @ts-expect-error SubmittedWork construction is package-private
    new scr.SubmittedWork(runtime)
    // @ts-expect-error SubmittedWork reports expose readonly diagnostic arrays
    submitted.report.diagnostics.push(diagnostic)
    // @ts-expect-error SubmittedWork diagnostic facts are deeply readonly
    submitted.diagnostics[0]!.code = 'FORGED'
    // @ts-expect-error SubmittedWork resource access facts are deeply readonly
    submitted.resourceAccesses[0]!.contentEpochBefore = 999
    // @ts-expect-error SubmittedWork producer origins are deeply readonly
    submitted.producerEpochs[0]!.producedBy.stepIndex = 999
    // @ts-expect-error SubmittedWork execution facts are deeply readonly
    submitted.executionOutcomes[0]!.status = 'executed'
    // @ts-expect-error SubmittedWork readback links are deeply readonly
    submitted.readbacks[0]!.operationId = 'forged'
    // @ts-expect-error SubmittedWork potential-write facts are deeply readonly
    submitted.potentialWrites[0]!.contentEpoch = 999
    const resourceAccesses: readonly scr.SubmissionResourceAccess[] = submitted.resourceAccesses
    const producerEpochs: readonly scr.SubmittedResourceEpoch[] = submitted.producerEpochs
    const diagnosticSubject: scr.DiagnosticSubject = storageInput.subject
    const missingResource: scr.SubmissionMissingResource = {
        resourceId: storageInput.id,
        resourceKind: storageInput.resourceKind,
        subject: diagnosticSubject,
        requiredContentEpoch: storageInput.contentEpoch,
        simulatedState: storageInput.state,
        simulatedContentEpoch: storageInput.contentEpoch,
        allocationVersion: storageInput.allocationVersion,
    }
    const readinessAttempt: scr.SubmissionCommandReadinessAttempt = {
        commandId: dispatch.id,
        commandKind: 'dispatch',
        policy: dispatch.whenMissing,
        missing: [ missingResource ],
    }
    const commandExecutionOutcome: scr.SubmissionCommandExecutionOutcome = {
        outcomeKind: 'command',
        stepIndex: 0,
        stepKind: 'compute',
        passId: computePass.id,
        requestedCommandId: dispatch.id,
        requestedCommandKind: 'dispatch',
        status: 'executed',
        executedCommandId: dispatch.id,
        attempts: [ readinessAttempt ],
    }
    const passExecutionOutcome: scr.SubmissionPassExecutionOutcome = {
        outcomeKind: 'pass',
        stepIndex: 0,
        stepKind: 'compute',
        passId: computePass.id,
        status: 'executed',
        requestedCommandIds: [ dispatch.id ],
        encodedCommandIds: [ dispatch.id ],
    }
    const executionOutcome: scr.SubmissionExecutionOutcome = commandExecutionOutcome
    const executionOutcomes: readonly scr.SubmissionExecutionOutcome[] = submitted.executionOutcomes
    const compatDiagnosticSubject: scratchCompat.DiagnosticSubject = diagnosticSubject
    const compatMissingResource: scratchCompat.SubmissionMissingResource = missingResource
    const compatReadinessAttempt: scratchCompat.SubmissionCommandReadinessAttempt = readinessAttempt
    const compatCommandExecutionOutcome: scratchCompat.SubmissionCommandExecutionOutcome = commandExecutionOutcome
    const compatPassExecutionOutcome: scratchCompat.SubmissionPassExecutionOutcome = passExecutionOutcome
    const compatExecutionOutcome: scratchCompat.SubmissionExecutionOutcome = executionOutcome
    const compatExecutionOutcomes: readonly scratchCompat.SubmissionExecutionOutcome[] = submitted.executionOutcomes
    // @ts-expect-error execution outcomes are immutable after submission
    submitted.executionOutcomes = []
    const accessKind: scr.SubmissionResourceAccessKind | undefined = resourceAccesses[0]?.access
    const stepKind: scr.SubmissionStepKind | undefined = resourceAccesses[0]?.stepKind
    const producedStepKind: scr.SubmissionStepKind | undefined = producerEpochs[0]?.producedBy.stepKind
    const compatResourceAccesses: readonly scratchCompat.SubmissionResourceAccess[] = submitted.resourceAccesses
    const compatProducerEpochs: readonly scratchCompat.SubmittedResourceEpoch[] = submitted.producerEpochs
    const compatAccessKind: scratchCompat.SubmissionResourceAccessKind | undefined = compatResourceAccesses[0]?.access
    const compatStepKind: scratchCompat.SubmissionStepKind | undefined = compatProducerEpochs[0]?.producedBy.stepKind
    const compatBuilder: scratchCompat.SubmissionBuilder = runtime.createSubmission(compatSubmissionOptions)
    const readbackCommandDescriptor: scr.ReadbackCommandDescriptor = {
        label: 'typed ordered readback',
        source: { region: storageOutputRegion, contentEpoch: storageOutput.contentEpoch },
        retain: 'until-dispose',
        whenMissing: 'throw',
    }
    const compatReadbackCommandDescriptor: scratchCompat.ReadbackCommandDescriptor = readbackCommandDescriptor
    const readbackCommandPromise: Promise<scr.ReadbackCommand> = runtime.createReadbackCommand(readbackCommandDescriptor)
    const readbackCommandAliasPromise: Promise<scratchCompat.ReadbackCommand> = runtime.readbackCommand(compatReadbackCommandDescriptor)
    const readbackCommand: scr.ReadbackCommand = await readbackCommandPromise
    const readbackCommandAlias: scratchCompat.ReadbackCommand = await readbackCommandAliasPromise
    const orderedSubmitted: scr.SubmittedWork = runtime.submission()
        .readback(readbackCommand)
        .readback(readbackCommandAlias)
        .submit()
    const readbackCommandResultOptions: scr.ReadbackCommandResultOptions = { after: orderedSubmitted }
    const compatReadbackCommandResultOptions: scratchCompat.ReadbackCommandResultOptions = readbackCommandResultOptions
    const orderedReadback: scr.ReadbackOperation = readbackCommand.result(readbackCommandResultOptions)
    const compatOrderedReadback: scratchCompat.ReadbackOperation = readbackCommandAlias.result(compatReadbackCommandResultOptions)
    const readbackStepKind: scr.SubmissionStepKind = 'readback'
    const submittedReadbackLinks: readonly scr.SubmittedReadbackLink[] = orderedSubmitted.readbacks
    const compatSubmittedReadbackLinks: readonly scratchCompat.SubmittedReadbackLink[] = submittedReadbackLinks
    const readbackRetention: scr.ReadbackRetentionPolicy = 'until-dispose'
    const compatReadbackRetention: scratchCompat.ReadbackRetentionPolicy = 'consume-on-read'
    const readbackDescriptor: scr.ReadbackOperationDescriptor = {
        source: storageOutputRegion,
        after: submitted,
        retain: readbackRetention,
    }
    const compatReadbackDescriptor: scratchCompat.ReadbackOperationDescriptor = {
        source: storageOutputRegion,
        retain: compatReadbackRetention,
    }
    const readback: scr.ReadbackOperation = runtime.createReadback({
        source: storageOutputRegion,
        after: submitted,
        retain: readbackRetention,
    })
    const readbackLayout: scr.LayoutArtifact | undefined = readback.layout
    const readbackRetain: scr.ReadbackRetentionPolicy = readback.retain
    const readbackIsResultRetained: boolean = readback.isResultRetained
    const readbackRetainedByteLength: number | undefined = readback.retainedByteLength
    const readbackBytes: Promise<Uint8Array> = readback.toBytes()
    const readbackValues: Promise<Float32Array> = readback.toArray(Float32Array)
    const readbackLayoutView: Promise<scr.LayoutReadbackView> = readback.toLayoutView()
    const readbackProducerEpoch: scr.SubmittedResourceEpoch | undefined = readback.producerEpoch
    const compatReadback: scratchCompat.ReadbackOperation = readback
    const compatReadbackRetain: scratchCompat.ReadbackRetentionPolicy = compatReadback.retain
    const compatReadbackLayoutView: Promise<scratchCompat.LayoutReadbackView> = compatReadback.toLayoutView()
    const compatReadbackProducerEpoch: scratchCompat.SubmittedResourceEpoch | undefined = compatReadback.producerEpoch

    void surface
    void resourceState
    void resourceReady
    void compatResourceState
    void uniformRead
    void vertexRead
    void storageInputRead
    void compatStorageInputRead
    void copySource
    void genericCopySource
    void compatCopySource
    void textureCopySource
    void textureCopyOrigin
    void textureCopySize
    void compatTextureCopySource
    void textureSet
    void textureTargetPass
    void depthAttachment
    void compatDepthAttachment
    void depthPassDescriptor
    void compatDepthPassDescriptor
    void depthPass
    void depthPassTarget
    void depthPassLoad
    void compatDepthPass
    void compatDepthPassTarget
    void compatDepthLoad
    void dynamicStorageLayout
    void dynamicStorageSet
    void compatDynamicUniformEntry
    void dynamicComputePipeline
    void dynamicDispatch
    void compatDynamicDispatch
    void copy
    void bufferCopyDescriptor
    void copyAlias
    void textureCopyDescriptor
    void textureCopy
    void compatTextureCopyDescriptor
    void textureCopyAlias
    void texelCopyBufferLayout
    void compatTexelCopyBufferLayout
    void bufferToTextureDescriptor
    void compatBufferToTextureDescriptor
    void textureToBufferDescriptor
    void compatTextureToBufferDescriptor
    void copyKind
    void compatCopyKind
    void querySet
    void querySetAlias
    void querySlot
    void querySlots
    void querySlotState
    void querySlotRead
    void queryResolveSource
    void resolveSourceQuerySet
    void resolveSourceSlotEpoch
    void compatQuerySlotState
    void compatQueryResolveSource
    void normalizedRequirement
    void compatProgramBufferRequirement
    void beginOcclusion
    void beginOcclusionAlias
    void endOcclusion
    void endOcclusionAlias
    void drawResources
    void drawReadResource
    void drawReadContentEpoch
    void compatDrawResources
    void compatDrawReadResource
    void compatDrawReadContentEpoch
    void resolveQueries
    void resolveAlias
    void compatDiagnosticsSnapshot
    void compatDiagnosticsEvidence
    void operationRecords
    void incidentRecords
    void diagnosticCaptureReport
    void error
    void submitted
    void resourceAccesses
    void producerEpochs
    void missingResource
    void readinessAttempt
    void passExecutionOutcome
    void executionOutcomes
    void compatDiagnosticSubject
    void compatMissingResource
    void compatReadinessAttempt
    void compatCommandExecutionOutcome
    void compatPassExecutionOutcome
    void compatExecutionOutcome
    void compatExecutionOutcomes
    void accessKind
    void stepKind
    void producedStepKind
    void compatResourceAccesses
    void compatProducerEpochs
    void compatAccessKind
    void compatStepKind
    void readbackCommandDescriptor
    void compatReadbackCommandDescriptor
    void orderedSubmitted
    void orderedReadback
    void compatOrderedReadback
    void readbackStepKind
    void readbackRetention
    void compatReadbackRetention
    void readbackDescriptor
    void compatReadbackDescriptor
    void readbackBytes
    void readbackValues
    void readbackLayout
    void readbackRetain
    void readbackIsResultRetained
    void readbackRetainedByteLength
    void readbackLayoutView
    void readbackProducerEpoch
    void compatReadback
    void compatReadbackRetain
    void compatReadbackLayoutView
    void compatReadbackProducerEpoch
    void shaderInspection
    void shaderInspectionInput
    void shaderInspectionOptions
    void shaderBinding
    void shaderBindingType
    void shaderComparisonOptions
    void shaderComparisonReport
    void externalImageSources
    void externalImageSourceOrigin
    void externalImageUploadSize
    void externalImageUploadDescriptors
    void compatExternalImageUploadDescriptor
    void externalImageUpload
    void externalImageUploadAlias
    void bufferUploadKind
    void textureUploadKind
    void externalImageUploadKind
    void canonicalExternalImageSourceInfo
    void canonicalExternalImageDestInfo
    void compatShaderInspection
    void compatShaderInspectionInput
    void compatShaderInspectionOptions
    void compatShaderBinding
    void compatShaderBindingType
    void compatShaderComparisonOptions
    void compatShaderReport
}

void startResult
void device
void screen
void createdScreen
void mercator
void planeGeometry
void sphereGeometry
void useScratchFoundation
