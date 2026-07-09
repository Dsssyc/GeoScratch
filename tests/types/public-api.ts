import * as scr from 'geoscratch'
import * as scratchCompat from 'geoscratch/scratch'
import { MercatorCoordinate } from 'geoscratch/geo'
import { plane, sphere } from 'geoscratch/geometry'

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
    })

    const surface: scr.Surface = runtime.createSurface(canvas, {
        format: 'preferred',
        alphaMode: 'opaque',
        size: { width: 2, height: 2 },
    })

    const buffer: scr.BufferResource = runtime.createBuffer({
        label: 'typed scratch buffer',
        size: 16,
        usage: 1,
    })
    const resourceState: scr.ResourceState = buffer.state
    const resourceReady: boolean = buffer.isReady
    const compatResourceState: scratchCompat.ResourceState = resourceState
    const uniformBuffer: scr.BufferResource = runtime.createBuffer({
        label: 'typed scratch uniform buffer',
        size: 16,
        usage: 0x8 | 0x40,
    })
    const vertexBuffer: scr.BufferResource = runtime.createBuffer({
        label: 'typed scratch vertex buffer',
        size: 24,
        usage: 0x20 | 0x8,
    })
    const storageInput: scr.BufferResource = runtime.createBuffer({
        label: 'typed scratch storage input',
        size: 16,
        usage: 0x8 | 0x80,
    })
    const storageOutput: scr.BufferResource = runtime.createBuffer({
        label: 'typed scratch storage output',
        size: 16,
        usage: 0x4 | 0x80,
    })
    const uniformRead: scr.CommandResourceReadDescriptor = {
        resource: uniformBuffer,
        contentEpoch: uniformBuffer.contentEpoch,
    }
    const vertexRead: scr.CommandResourceReadDescriptor = {
        resource: vertexBuffer,
        contentEpoch: vertexBuffer.contentEpoch,
    }
    const storageInputRead: scr.CommandResourceReadDescriptor = {
        resource: storageInput,
        contentEpoch: storageInput.contentEpoch,
    }
    const compatStorageInputRead: scratchCompat.CommandResourceReadDescriptor = {
        resource: storageInput,
        contentEpoch: storageInput.contentEpoch,
    }
    const copySource: scr.BufferCopyCommandSourceDescriptor = {
        resource: storageOutput,
        contentEpoch: storageOutput.contentEpoch,
    }
    const genericCopySource: scr.CopyCommandSourceDescriptor = copySource
    const compatCopySource: scratchCompat.CopyCommandSourceDescriptor = copySource
    const queryDestination: scr.BufferResource = runtime.createBuffer({
        label: 'typed scratch query destination',
        size: 256,
        usage: 0x4 | 0x200,
    })
    const scratchTexture: scr.TextureResource = runtime.createTexture({
        label: 'typed scratch texture',
        size: { width: 2, height: 2 },
        format: 'rgba8unorm',
        usage: 0x1 | 0x2 | 0x4 | 0x10,
    })
    const scratchTextureCopyTarget: scr.TextureResource = runtime.createTexture({
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
    const scratchDepthTexture: scr.TextureResource = runtime.createTexture({
        label: 'typed scratch depth texture',
        size: { width: 2, height: 2 },
        format: 'depth24plus',
        usage: 0x4 | 0x10,
    })
    const scratchSampler: scr.SamplerResource = runtime.createSampler({
        label: 'typed scratch sampler',
        magFilter: 'nearest',
        minFilter: 'nearest',
    })
    const scratchTextureView: GPUTextureView = scratchTexture.createView()

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
    const usageCompatibility: scr.LayoutUsageCompatibility = codec.artifact.usageCompatibility
    const readbackCount: number = typedReadback.count
    const readbackObject: Record<string, unknown> = typedReadback.toObject()
    const layoutBuffer: scr.BufferResource = runtime.createBuffer({
        label: 'typed scratch layout buffer',
        size: codec.artifact.stride * 2,
        usage: 0x8 | 0x80,
        layout: codec.artifact,
        elementCount: 2,
    })
    const bufferLayout: scr.LayoutArtifact | undefined = layoutBuffer.layout
    const bufferElementCount: number | undefined = layoutBuffer.elementCount
    const bufferLayoutByteLength: number | undefined = layoutBuffer.layoutByteLength
    const bufferLayoutSubject: unknown = layoutBuffer.layoutSubject
    const programBufferRequirement: scr.ProgramBufferLayoutRequirement = {
        group: 0,
        binding: 0,
        name: 'uniforms',
        type: 'uniform',
        visibility: [ 'vertex', 'fragment' ],
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
    const bindLayout: scr.BindLayout = runtime.createBindLayout({
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
    })
    const bindSet: scr.BindSet = runtime.createBindSet(bindLayout, {
        uniforms: uniformBuffer,
    }, {
        label: 'typed bind set',
    })
    const storageLayout: scr.BindLayout = runtime.createBindLayout({
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
    const storageSet: scr.BindSet = runtime.createBindSet(storageLayout, {
        inputValues: storageInput,
        outputValues: storageOutput,
    })
    const dynamicStorageLayout: scr.BindLayout = runtime.createBindLayout({
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
    const dynamicStorageSet: scr.BindSet = runtime.createBindSet(dynamicStorageLayout, {
        dynamicInputValues: storageInput,
        dynamicOutputValues: storageOutput,
    })
    const compatDynamicUniformEntry: scratchCompat.UniformBindLayoutEntry = {
        binding: 0,
        name: 'compatDynamicUniforms',
        type: 'uniform',
        visibility: [ 'vertex' ],
        hasDynamicOffset: true,
    }
    const compatDynamicDispatchOffsets: scratchCompat.DispatchCommandDescriptor['dynamicOffsets'] = {
        3: [ 256, 512 ],
    }
    const textureLayout: scr.BindLayout = runtime.createBindLayout({
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
    const textureSet: scr.BindSet = runtime.createBindSet(textureLayout, {
        colorTexture: scratchTexture,
        colorSampler: scratchSampler,
    })
    const upload: scr.UploadCommand = runtime.createUploadCommand({
        target: uniformBuffer,
        data: new Float32Array([ 1, 0, 0, 1 ]),
        offset: 0,
    })
    const layoutUpload: scr.UploadCommand = runtime.createUploadCommand({
        target: layoutBuffer,
        data: uploadView,
        layout: codec.artifact,
        offset: 0,
    })
    const uploadLayout: scr.LayoutArtifact | undefined = layoutUpload.layout
    const textureUpload: scr.TextureUploadCommand = runtime.createTextureUploadCommand({
        target: scratchTexture,
        data: new Uint8Array(16),
        layout: { bytesPerRow: 8, rowsPerImage: 2 },
        size: { width: 2, height: 2 },
    })
    const copy: scr.CopyCommand = runtime.createCopyCommand({
        label: 'typed scratch copy',
        source: genericCopySource,
        sourceOffset: 0,
        target: storageInput,
        targetOffset: 0,
        byteLength: 16,
        whenMissing: 'throw',
    })
    const bufferCopyDescriptor: scr.BufferCopyCommandDescriptor = {
        source: copySource,
        target: storageInput,
        byteLength: 16,
        whenMissing: 'throw',
    }
    const copyAlias: scr.CopyCommand = runtime.copyCommand({
        source: compatCopySource,
        target: storageInput,
        byteLength: 16,
        whenMissing: 'throw',
    })
    const textureCopyDescriptor: scr.TextureCopyCommandDescriptor = {
        label: 'typed scratch texture copy',
        source: textureCopySource,
        sourceOrigin: textureCopyOrigin,
        target: scratchTextureCopyTarget,
        targetOrigin: { x: 0, y: 0 },
        size: textureCopySize,
        whenMissing: 'throw',
    }
    const textureCopy: scr.CopyCommand = runtime.createCopyCommand(textureCopyDescriptor)
    const compatTextureCopyDescriptor: scratchCompat.TextureCopyCommandDescriptor = textureCopyDescriptor
    const textureCopyAlias: scratchCompat.CopyCommand = runtime.copyCommand(compatTextureCopyDescriptor)
    const copyKind: 'buffer-to-buffer' | 'texture-to-texture' = textureCopy.copyKind
    const compatCopyKind: 'buffer-to-buffer' | 'texture-to-texture' = textureCopyAlias.copyKind
    const querySet: scr.QuerySetResource = runtime.createQuerySet({
        label: 'typed timestamp queries',
        type: 'timestamp',
        count: 2,
    })
    const querySlotState: scr.QuerySetSlotState | undefined = querySet.slotStates[0]
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
    const querySetAlias: scr.QuerySetResource = runtime.querySet({
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
    const resolveQueries: scr.ResolveQuerySetCommand = runtime.createResolveQuerySetCommand({
        label: 'typed query resolve',
        source: queryResolveSource,
        destination: queryDestination,
        destinationOffset: 0,
        whenMissing: 'throw',
    })
    const resolveAlias: scr.ResolveQuerySetCommand = runtime.resolveQuerySetCommand({
        source: {
            querySet,
            slots: [
                { index: 0, contentEpoch: 1 },
            ],
        },
        destination: queryDestination,
        whenMissing: 'throw',
    })
    const resolveSourceQuerySet: scr.QuerySetResource = resolveQueries.source.querySet
    const resolveSourceSlotEpoch: number = resolveQueries.source.slots[0].contentEpoch
    const scratchPipeline: scr.ScratchRenderPipeline = runtime.createRenderPipeline({
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
    const draw: scr.DrawCommand = runtime.createDrawCommand({
        pipeline: scratchPipeline,
        bindSets: [ bindSet ],
        vertexBuffers: [
            { slot: 0, buffer: vertexBuffer, offset: 0, size: 24 },
        ],
        count: { vertexCount: 3 },
        resources: {
            read: [ uniformRead, vertexRead ],
            write: [],
        },
        whenMissing: 'throw',
    })
    const drawResources: scr.CommandResourceAccessDescriptor = draw.resources
    const drawReadResource: scr.Resource = drawResources.read[0].resource
    const drawReadContentEpoch: number = drawResources.read[0].contentEpoch
    const compatDraw: scratchCompat.DrawCommand = draw
    const compatDrawResources: scratchCompat.CommandResourceAccessDescriptor = compatDraw.resources
    const compatDrawReadResource: scratchCompat.Resource = compatDrawResources.read[0].resource
    const compatDrawReadContentEpoch: number = compatDrawResources.read[0].contentEpoch
    const compatQuerySlotState: scratchCompat.QuerySetSlotState | undefined = querySet.slotStates[0]
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
    const textureTargetPass: scr.RenderPassSpec = runtime.createRenderPass({
        color: [ {
            target: scratchTexture,
            load: 'clear',
            store: 'store',
            clear: [ 0, 0, 0, 1 ],
        } ],
    })
    const depthAttachment: scr.RenderPassDepthStencilAttachmentSpec = {
        target: scratchDepthTexture,
        depthLoad: 'clear',
        depthStore: 'store',
        depthClear: 1,
    }
    const compatDepthAttachment: scratchCompat.RenderPassDepthStencilAttachmentSpec = depthAttachment
    const depthPassDescriptor: scr.RenderPassSpecDescriptor = {
        color: [ {
            target: scratchTexture,
            load: 'clear',
            store: 'store',
        } ],
        depth: depthAttachment,
    }
    const compatDepthPassDescriptor: scratchCompat.RenderPassSpecDescriptor = depthPassDescriptor
    const depthPass: scr.RenderPassSpec = runtime.createRenderPass(depthPassDescriptor)
    const depthPassTarget: scr.TextureResource | undefined = depthPass.depth?.target
    const depthPassLoad: GPULoadOp | undefined = depthPass.depth?.depthLoad
    const compatDepthPass: scratchCompat.RenderPassSpec = runtime.createRenderPass(compatDepthPassDescriptor)
    const compatDepthPassTarget: scratchCompat.TextureResource | undefined = compatDepthPass.depth?.target
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
    const computePipeline: scr.ScratchComputePipeline = runtime.createComputePipeline({
        program: computeProgram,
        bindLayouts: [ storageLayout ],
    })
    const dynamicComputePipeline: scr.ScratchComputePipeline = runtime.createComputePipeline({
        program: computeProgram,
        bindLayouts: [ dynamicStorageLayout ],
    })
    const dispatch: scr.DispatchCommand = runtime.createDispatchCommand({
        pipeline: computePipeline,
        bindSets: [ storageSet ],
        count: { workgroups: [ 1 ] },
        resources: {
            read: [ storageInputRead ],
            write: [ storageOutput ],
        },
        whenMissing: 'throw',
    })
    const dynamicDispatch: scr.DispatchCommand = runtime.createDispatchCommand({
        pipeline: dynamicComputePipeline,
        bindSets: [ dynamicStorageSet ],
        count: { workgroups: [ 1 ] },
        resources: {
            read: [ storageInputRead ],
            write: [ storageOutput ],
        },
        whenMissing: 'throw',
        dynamicOffsets: {
            3: [ 256, 512 ],
        },
    })
    const compatDynamicDispatchDescriptor: scratchCompat.DispatchCommandDescriptor = {
        pipeline: dynamicComputePipeline,
        bindSets: [ dynamicStorageSet ],
        count: { workgroups: [ 1 ] },
        resources: {
            read: [ compatStorageInputRead ],
            write: [ storageOutput ],
        },
        whenMissing: 'throw',
        dynamicOffsets: compatDynamicDispatchOffsets,
    }
    const compatDynamicDispatch: scratchCompat.DispatchCommand = runtime.createDispatchCommand(compatDynamicDispatchDescriptor)
    const computePass: scr.ComputePassSpec = runtime.createComputePass({
        timestampWrites: {
            querySet,
            begin: 0,
        },
    })
    const renderCommands: scr.RenderCommand[] = [ beginOcclusion, draw, endOcclusion ]
    const validationMode: scr.SubmissionValidationMode = 'warn'
    const compatValidationMode: scratchCompat.SubmissionValidationMode = 'off'
    const submissionOptions: scr.SubmissionBuilderOptions = { validation: validationMode }
    const compatSubmissionOptions: scratchCompat.SubmissionBuilderOptions = { validation: compatValidationMode }
    const builder: scr.SubmissionBuilder = runtime.createSubmission(submissionOptions)
    const submitted: scr.SubmittedWork = builder.upload(upload).upload(textureUpload).compute(computePass, [ dispatch ]).copy(copy).copy(copyAlias).resolve(resolveQueries).resolve(resolveAlias).render(passSpec, renderCommands).submit()
    const resourceAccesses: readonly scr.SubmissionResourceAccess[] = submitted.resourceAccesses
    const producerEpochs: readonly scr.SubmittedResourceEpoch[] = submitted.producerEpochs
    const accessKind: scr.SubmissionResourceAccessKind | undefined = resourceAccesses[0]?.access
    const stepKind: scr.SubmissionStepKind | undefined = resourceAccesses[0]?.stepKind
    const producedStepKind: scr.SubmissionStepKind | undefined = producerEpochs[0]?.producedBy.stepKind
    const compatResourceAccesses: readonly scratchCompat.SubmissionResourceAccess[] = submitted.resourceAccesses
    const compatProducerEpochs: readonly scratchCompat.SubmittedResourceEpoch[] = submitted.producerEpochs
    const compatAccessKind: scratchCompat.SubmissionResourceAccessKind | undefined = compatResourceAccesses[0]?.access
    const compatStepKind: scratchCompat.SubmissionStepKind | undefined = compatProducerEpochs[0]?.producedBy.stepKind
    const compatBuilder: scratchCompat.SubmissionBuilder = runtime.createSubmission(compatSubmissionOptions)
    const readbackRetention: scr.ReadbackRetentionPolicy = 'until-dispose'
    const compatReadbackRetention: scratchCompat.ReadbackRetentionPolicy = 'consume-on-read'
    const readbackDescriptor: scr.ReadbackOperationDescriptor = {
        source: storageOutput,
        after: submitted,
        range: { offset: 0, byteLength: 16 },
        retain: readbackRetention,
    }
    const compatReadbackDescriptor: scratchCompat.ReadbackOperationDescriptor = {
        source: storageOutput,
        retain: compatReadbackRetention,
    }
    const readback: scr.ReadbackOperation = runtime.createReadback({
        source: storageOutput,
        after: submitted,
        range: { offset: 0, byteLength: 16 },
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
    void scratchTextureView
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
    void copyKind
    void compatCopyKind
    void querySet
    void querySetAlias
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
    void error
    void submitted
    void resourceAccesses
    void producerEpochs
    void accessKind
    void stepKind
    void producedStepKind
    void compatResourceAccesses
    void compatProducerEpochs
    void compatAccessKind
    void compatStepKind
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
