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
    const indexBuffer: scr.BufferResource = runtime.createBuffer({
        label: 'typed scratch index buffer',
        size: 8,
        usage: 0x10 | 0x8,
    })
    const indirectBuffer: scr.BufferResource = runtime.createBuffer({
        label: 'typed scratch indirect buffer',
        size: 32,
        usage: 0x100 | 0x80,
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
    // @ts-expect-error normalized BindSet bindings are immutable
    storageSet.bindings.clear()
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
        sourceOffset: 0,
        target: storageInput,
        targetOffset: 0,
        byteLength: 16,
        whenMissing: 'throw',
    })
    const texelCopyBufferLayout: scr.TexelCopyBufferLayout = {
        offset: 0,
        bytesPerRow: 256,
        rowsPerImage: 2,
    }
    const compatTexelCopyBufferLayout: scratchCompat.TexelCopyBufferLayout = texelCopyBufferLayout
    const bufferCopyDescriptor: scr.BufferToBufferCopyCommandDescriptor = {
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
        target: storageInput,
        targetLayout: texelCopyBufferLayout,
        size: textureCopySize,
        whenMissing: 'throw',
    }
    const compatTextureToBufferDescriptor: scratchCompat.TextureToBufferCopyCommandDescriptor = textureToBufferDescriptor
    const copyKind: 'buffer-to-buffer' | 'texture-to-texture' | 'buffer-to-texture' | 'texture-to-buffer' = textureCopy.copyKind
    const compatCopyKind: 'buffer-to-buffer' | 'texture-to-texture' | 'buffer-to-texture' | 'texture-to-buffer' = textureCopyAlias.copyKind
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
    const drawReadiness: scr.CommandReadinessDescriptor<scr.DrawCommand> = {
        whenMissing: 'use-fallback',
        fallback: draw,
    }
    const compatDrawReadiness: scratchCompat.CommandReadinessDescriptor<scratchCompat.DrawCommand> = drawReadiness
    const fallbackDraw: scr.DrawCommand = runtime.createDrawCommand({
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
    const indirectCount: scr.IndirectCommandCount = { indirect: indirectBuffer, offset: 0 }
    const drawCount: scr.DrawCount = staticIndexedCount
    const dispatchCount: scr.DispatchCount = indirectCount
    const indexBinding: scr.DrawIndexBufferBinding = {
        buffer: indexBuffer,
        format: 'uint16',
        offset: 0,
        size: 6,
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
    runtime.createDispatchCommand({
        pipeline: computePipeline,
        // @ts-expect-error direct and indirect dispatch count fields are mutually exclusive
        count: { workgroups: [ 1 ], indirect: indirectBuffer },
        resources: { read: [ indirectRead ], write: [] },
        whenMissing: 'throw',
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
    const dispatchReadiness: scr.CommandReadinessDescriptor<scr.DispatchCommand> = {
        whenMissing: 'use-fallback',
        fallback: dispatch,
    }
    const compatDispatchReadiness: scratchCompat.CommandReadinessDescriptor<scratchCompat.DispatchCommand> = dispatchReadiness
    const fallbackDispatch: scr.DispatchCommand = runtime.createDispatchCommand({
        pipeline: computePipeline,
        bindSets: [ storageSet ],
        count: { workgroups: [ 1 ] },
        resources: {
            read: [ storageInputRead ],
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
        bindSets: [ storageSet ],
        count: dispatchCount,
        resources: {
            read: [ storageInputRead, indirectRead ],
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
    // @ts-expect-error queue replay is package-internal submission lowering
    upload._writeToQueue(runtime.queue)
    // @ts-expect-error logical upload commitment is package-internal submission lowering
    upload._commitLogicalWrite()
    // @ts-expect-error texture queue replay is package-internal submission lowering
    textureUpload._writeToQueue(runtime.queue)
    // @ts-expect-error texture logical commitment is package-internal submission lowering
    textureUpload._commitLogicalWrite()
    const builder: scr.SubmissionBuilder = runtime.createSubmission(submissionOptions)
    const submitted: scr.SubmittedWork = builder.upload(upload).upload(textureUpload).compute(computePass, [ dispatch ]).copy(copy).copy(copyAlias).resolve(resolveQueries).resolve(resolveAlias).render(passSpec, renderCommands).submit()
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
        source: { resource: storageOutput, contentEpoch: storageOutput.contentEpoch },
        range: { offset: 0, byteLength: 16 },
        retain: 'until-dispose',
        whenMissing: 'throw',
    }
    const compatReadbackCommandDescriptor: scratchCompat.ReadbackCommandDescriptor = readbackCommandDescriptor
    const readbackCommand: scr.ReadbackCommand = runtime.createReadbackCommand(readbackCommandDescriptor)
    const readbackCommandAlias: scratchCompat.ReadbackCommand = runtime.readbackCommand(compatReadbackCommandDescriptor)
    const orderedSubmitted: scr.SubmittedWork = runtime.submission()
        .readback(readbackCommand)
        .readback(readbackCommandAlias)
        .submit()
    const readbackCommandResultOptions: scr.ReadbackCommandResultOptions = { after: orderedSubmitted }
    const compatReadbackCommandResultOptions: scratchCompat.ReadbackCommandResultOptions = readbackCommandResultOptions
    const orderedReadback: scr.ReadbackOperation = readbackCommand.result(readbackCommandResultOptions)
    const compatOrderedReadback: scratchCompat.ReadbackOperation = readbackCommandAlias.result(compatReadbackCommandResultOptions)
    const readbackStepKind: scr.SubmissionStepKind = 'readback'
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
