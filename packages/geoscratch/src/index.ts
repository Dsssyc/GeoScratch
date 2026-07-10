export { ScratchObject } from './core/object/object.js'
export {
    ScratchRuntime,
    Surface,
    ScratchDiagnosticError,
    createScratchDiagnostic,
    createScratchDiagnosticReport,
    Resource,
    BufferResource,
    TextureResource,
    SamplerResource,
    QuerySetResource,
    BindLayout,
    BindSet,
    LayoutCodec,
    layoutCodec,
    Program,
    inspectShader,
    RenderPipeline as ScratchRenderPipeline,
    ComputePipeline as ScratchComputePipeline,
    BeginOcclusionQueryCommand,
    EndOcclusionQueryCommand,
    DrawCommand,
    DispatchCommand,
    TextureUploadCommand,
    UploadCommand,
    CopyCommand,
    ReadbackCommand,
    ResolveQuerySetCommand,
    RenderPassSpec,
    ComputePassSpec,
    ReadbackOperation,
    SubmissionBuilder,
    SubmittedWork,
} from './scratch/index.js'
export type {
    BeginOcclusionQueryCommandDescriptor,
    BindLayoutDescriptor,
    BindLayoutEntry,
    BindSetBindings,
    BindSetOptions,
    BindVisibility,
    BufferCopyCommandSourceDescriptor,
    BufferToBufferCopyCommandDescriptor,
    BufferToTextureCopyCommandDescriptor,
    CommandDynamicOffsets,
    CommandResourceAccessDescriptor,
    CommandResourceReadDescriptor,
    CopyCommandDescriptor,
    CopyCommandSourceDescriptor,
    DispatchCount,
    DispatchCommandDescriptor,
    DrawCount,
    DrawCommandDescriptor,
    DrawIndexBufferBinding,
    DrawVertexBufferBinding,
    EndOcclusionQueryCommandDescriptor,
    QuerySetSlotReadDescriptor,
    QuerySetSlotState,
    ReadbackCommandDescriptor,
    ReadbackCommandResultOptions,
    ReadbackOperationDescriptor,
    ReadbackRange,
    ReadbackRetentionPolicy,
    ReadbackState,
    ComputePassSpecDescriptor,
    RenderCommand,
    RenderPassColorAttachmentSpec,
    RenderPassDepthStencilAttachmentSpec,
    RenderPassSpecDescriptor,
    ResourceState,
    ResourceReadinessPolicy,
    ScratchDiagnostic,
    ScratchDiagnosticReport,
    SamplerBindLayoutEntry,
    IndirectCommandCount,
    StaticDispatchCount,
    StaticDrawCount,
    StaticIndexedDrawCount,
    StorageBindLayoutEntry,
    TextureBindLayoutEntry,
    TextureCopyCommandSourceDescriptor,
    TextureCopyOrigin,
    TextureCopySize,
    TextureToBufferCopyCommandDescriptor,
    TextureToTextureCopyCommandDescriptor,
    TexelCopyBufferLayout,
    TextureUploadCommandDescriptor,
    UniformBindLayoutEntry,
    UploadCommandDescriptor,
    ResolveQuerySetCommandDescriptor,
    ResolveQuerySetSourceDescriptor,
    LayoutArtifact,
    LayoutCodecOptions,
    LayoutCodecUsage,
    LayoutFieldArtifact,
    LayoutFieldDescriptor,
    LayoutFieldType,
    LayoutPrimitiveType,
    LayoutReadbackView,
    LayoutScalarType,
    LayoutSpec,
    LayoutUploadView,
    LayoutUsageCompatibility,
    LayoutVectorType,
    LayoutWriteOptions,
    ProgramBufferLayoutRequirement,
    ShaderBindLayoutComparisonOptions,
    ShaderBinding,
    ShaderBindingResourceType,
    ShaderInspection,
    ShaderInspectionInput,
    ShaderInspectionOptions,
    SubmissionBuilderOptions,
    SubmittedResourceEpoch,
    SubmissionResourceAccess,
    SubmissionResourceAccessKind,
    SubmissionStepKind,
    SubmissionValidationMode,
    TimestampWritesSpec,
} from './scratch/index.js'

import getDevice from './gpu/context/device.js'
export { getDevice }
export { Device, StartDash, device } from './gpu/context/device.js'

export { Buffer } from './gpu/buffer/buffer.js'
export { vertexBuffer, VertexBuffer } from './gpu/buffer/vertexBuffer.js'
export { storageBuffer, StorageBuffer } from './gpu/buffer/storageBuffer.js'
export { uniformBuffer, UniformBuffer } from './gpu/buffer/uniformBuffer.js'
export { indexBuffer, IndexBuffer } from './gpu/buffer/indexBuffer.js'
export { indirectBuffer, IndirectBuffer } from './gpu/buffer/indirectBuffer.js'
export { mapBuffer, MapBuffer } from './gpu/buffer/mapBuffer.js'


export { ArrayRef, aRef } from './core/data/arrayRef.js'
export { BlockRef, bRef } from './core/data/blockRef.js'
export { boundingBox2D, BoundingBox2D } from './core/box/boundingBox2D.js'
export { GeoQuadNode2D, Node2D } from './geo/tiling/geoQuadNode2D.js'

export { sampler, Sampler } from './gpu/sampler/sampler.js'
export { texture, Texture } from './gpu/texture/texture.js'
export { screen, Screen } from './gpu/texture/screen.js'
export { shader, Shader } from './gpu/shader/shader.js'

export { binding, Binding } from './gpu/binding/binding.js'

export { renderPipeline, RenderPipeline } from './gpu/pipeline/renderPipeline.js'
export { computePipeline, ComputePipeline } from './gpu/pipeline/computePipeline.js'

export { renderPass, RenderPass } from './gpu/pass/renderPass.js'
export { computePass, ComputePass } from './gpu/pass/computePass.js'

import director, { Director } from './gpu/director/director.js'
export { director, Director }

import monitor, { Monitor } from './gpu/monitor/monitor.js'
export { monitor, Monitor }

export {
	NoBlending,
    NormalBlending,
    AdditiveBlending,
    PremultipliedBlending,
} from './gpu/blending/blending.js'

import imageLoader from './loaders/image/imageLoader.js'
export { imageLoader }
import shaderLoader from './loaders/shader/shaderLoader.js'
export { shaderLoader }

export { sphere } from './geometry/sphere/sphere.js'
export { plane } from './geometry/plane/plane.js'
export { randomNonZeroBetweenMinusOneAndOne } from './core/math/random.js'
export {
	vec2, vec3, vec4, mat3, mat4, utils, quat,
} from './core/math/wgpu-matrix.module.js'

export {
	Numeric,
	i32, asI32, I32,
	u32, asU32, U32,
	f32, asF32, F32,
	vec2i, asVec2i, Vec2i,
	vec2u, asVec2u, Vec2u,
	vec2f, asVec2f, Vec2f,
	vec3f, asVec3f, Vec3f,
	vec4f, asVec4f, Vec4f,
	mat3f, Mat3f,
	mat4f, Mat4f
} from './core/numericType/numericType.js'

export { MercatorCoordinate } from './geo/mercatorCoordinate.js'


export { UUID } from './core/utils/uuid.js'

export { bloomPass, BloomPass } from './effects/postprocess/bloomPass.js'
export { fxaaPass, FXAAPass } from './effects/postprocess/fxaaPass.js'

export { LocalTerrain } from './applications/terrain/localTerrain.js'
