import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import ts from 'typescript'
import { fileURLToPath } from 'node:url'
import {
    webGpuManifestPath,
    wgslManifestPath,
} from './scratch-webgpu-wgsl-parity-manifest.mjs'
import {
    normativeArtifactPaths,
} from './refresh-scratch-webgpu-wgsl-baseline.mjs'

const root = process.cwd()
const manifestRoot = path.join(root, 'docs', 'review', 'manifests')

export const wgslEnableExtensionManifestPath = path.join(
    manifestRoot,
    'scratch-wgsl-enable-extensions-2026-07-16.json'
)
export const currentCoverageManifestPath = path.join(
    manifestRoot,
    'scratch-webgpu-wgsl-current-coverage.json'
)

export const currentSpecRefresh = Object.freeze({
    refreshedOn: '2026-07-24',
    webgpu: Object.freeze({
        publication: 'W3C Candidate Recommendation Draft, 14 July 2026',
        url: 'https://www.w3.org/TR/2026/CRD-webgpu-20260714/',
        sha256: '23b38cef5e23be710ef865b800f63e5874edd03bb08bbecfa8ac5b3020b47d30',
    }),
    wgsl: Object.freeze({
        publication: 'W3C Candidate Recommendation Draft, 16 July 2026',
        url: 'https://www.w3.org/TR/2026/CRD-WGSL-20260716/',
        sha256: '2ae2de9464930086cb7c611951262bfd4c989a312802e30162cfd246567d66aa',
    }),
    gpuwebEditor: Object.freeze({
        frozenBaselineCommit: '99d2ded3335433260fd756abacc2d2b280999b8d',
        refreshedCommit: 'b33e6efb182d11156851271586563cc77575059c',
        url:
            'https://github.com/gpuweb/gpuweb/commit/b33e6efb182d11156851271586563cc77575059c',
        sourceUrl:
            'https://raw.githubusercontent.com/gpuweb/gpuweb/b33e6efb182d11156851271586563cc77575059c/spec/index.bs',
        observedOn: '2026-07-24',
        normativeDelta: false,
        delta: Object.freeze([
            Object.freeze({
                commit: 'b33e6efb182d11156851271586563cc77575059c',
                subject: '[bindless] Rename insert/removeBinding to insert/remove (#6341)',
                scope: 'non-normative draft proposal',
            }),
        ]),
    }),
    gpuwebTypes: Object.freeze({
        repositoryCommit: '9ba8a0618e1efad8e1ee444ef6ecfae761b2bc30',
        url:
            'https://github.com/gpuweb/types/commit/9ba8a0618e1efad8e1ee444ef6ecfae761b2bc30',
        sourceUrl:
            'https://raw.githubusercontent.com/gpuweb/types/9ba8a0618e1efad8e1ee444ef6ecfae761b2bc30/dist/index.d.ts',
        observedOn: '2026-07-24',
        packageVersion: '0.1.71',
        declarationSha256:
            'd2e5cfb2397ec8cacfd30de0e6f7992eb7db7b02cc83b7c43ef58bcd5aa88bc3',
    }),
    proposalIndex: Object.freeze({
        url:
            'https://github.com/gpuweb/gpuweb/tree/b33e6efb182d11156851271586563cc77575059c/proposals',
        sourceUrl:
            'https://raw.githubusercontent.com/gpuweb/gpuweb/b33e6efb182d11156851271586563cc77575059c/proposals/README.md',
        observedOn: '2026-07-24',
        readmeSha256:
            '25d168b6796672bb1037933cddc31468fd10f7b7aa2f2196b7681d9f20213018',
        draftProposalsInScope: false,
    }),
})

const evidence = Object.freeze([
    evidenceRecord(
        'webgpu-runtime-capabilities',
        'Explicit adapter/device requests, immutable capability facts, queue ownership, and device-loss lifecycle.',
        [ 'packages/geoscratch/src/scratch/runtime.ts', 'packages/geoscratch/src/scratch/runtime-authority.ts' ],
        [ 'tests/scratch-runtime.test.js', 'tests/scratch-closed-brand-authority.test.js' ],
        [ 'ScratchRuntime', 'ScratchRuntimeCreateOptions', 'ScratchRuntimeRequestFacts' ],
        [ 'requestAdapter', 'requestDevice', 'device.lost' ]
    ),
    evidenceRecord(
        'webgpu-surface-presentation',
        'Explicit Surface configuration and attempt-local current-texture leases preserve presentation semantics.',
        [ 'packages/geoscratch/src/scratch/surface.ts', 'packages/geoscratch/src/scratch/temporal-texture.ts' ],
        [ 'tests/scratch-surface.test.js', 'tests/scratch-temporal-texture.test.js' ],
        [ 'Surface', 'SurfaceOptions', 'SurfaceTextureLease', 'SurfaceTextureView' ],
        [ 'GPUCanvasContext.configure', 'GPUCanvasContext.getCurrentTexture', 'GPUTexture.createView' ]
    ),
    evidenceRecord(
        'webgpu-resource-lifetime',
        'Logical resource identity, runtime ownership, allocation versions, content epochs, and disposal are explicit.',
        [ 'packages/geoscratch/src/scratch/resource.ts', 'packages/geoscratch/src/scratch/native-allocation.ts' ],
        [ 'tests/scratch-resource.test.js', 'tests/scratch-resource-views.test.js' ],
        [ 'Resource', 'ResourceState' ],
        [ 'GPUObjectBase.label', 'GPUBuffer.destroy', 'GPUTexture.destroy' ]
    ),
    evidenceRecord(
        'webgpu-buffer-mapping',
        'Buffer allocation, regions, host mapping authority, and GPU upload paths are managed without implicit synchronization.',
        [
            'packages/geoscratch/src/scratch/buffer.ts',
            'packages/geoscratch/src/scratch/buffer-mapping.ts',
            'packages/geoscratch/src/scratch/command.ts',
        ],
        [
            'tests/scratch-buffer-mapping.test.js',
            'tests/scratch-buffer-mapping-contract.test.js',
            'tests/scratch-binding-upload.test.js',
        ],
        [ 'BufferResource', 'BufferRegion', 'MappedBufferLease', 'UploadCommand' ],
        [ 'createBuffer', 'mapAsync', 'getMappedRange', 'unmap', 'writeBuffer' ]
    ),
    evidenceRecord(
        'webgpu-texture-resource',
        'Texture allocation, replacement, view descriptors, formats, sizes, usages, and subresource identity are explicit.',
        [ 'packages/geoscratch/src/scratch/texture.ts', 'packages/geoscratch/src/scratch/texture-format-capabilities.ts' ],
        [ 'tests/scratch-texture-resize.test.js', 'tests/scratch-texture-sampler.test.js' ],
        [ 'TextureResource', 'TextureViewSpec', 'TextureResourceDescriptor' ],
        [ 'createTexture', 'GPUTexture.createView', 'GPUTexture.destroy' ]
    ),
    evidenceRecord(
        'webgpu-sampler',
        'Sampler descriptors and allocation failures are represented by a runtime-owned SamplerResource.',
        [ 'packages/geoscratch/src/scratch/sampler.ts', 'packages/geoscratch/src/scratch/supporting-object-creation.ts' ],
        [ 'tests/scratch-texture-sampler.test.js', 'tests/scratch-supporting-object-acknowledgement.test.js' ],
        [ 'SamplerResource', 'SamplerResourceDescriptor' ],
        [ 'createSampler' ]
    ),
    evidenceRecord(
        'webgpu-bindings',
        'Explicit BindLayout and BindSet contracts retain native binding types, dynamic offsets, and preparation authority.',
        [
            'packages/geoscratch/src/scratch/binding.ts',
            'packages/geoscratch/src/scratch/binding-ownership.ts',
            'packages/geoscratch/src/scratch/command.ts',
        ],
        [
            'tests/scratch-bind-dynamic-offsets.test.js',
            'tests/scratch-bind-set-preparation.test.js',
            'tests/scratch-command-binding-access.test.js',
        ],
        [ 'BindLayout', 'BindSet', 'BindLayoutDescriptor', 'BindSetBindings' ],
        [ 'createBindGroupLayout', 'createBindGroup', 'setBindGroup' ]
    ),
    evidenceRecord(
        'webgpu-shader-program',
        'Caller-authored WGSL, ShaderModule acknowledgement, Program stage contracts, compilation information, and explicit capabilities are preserved.',
        [
            'packages/geoscratch/src/scratch/shader-module.ts',
            'packages/geoscratch/src/scratch/program.ts',
            'packages/geoscratch/src/scratch/shader-inspection.ts',
        ],
        [
            'tests/scratch-shader-module.test.js',
            'tests/scratch-program.test.js',
            'tests/scratch-shader-inspection.test.js',
        ],
        [ 'ShaderModule', 'Program', 'ProgramDescriptor', 'inspectShader' ],
        [ 'createShaderModule', 'getCompilationInfo' ]
    ),
    evidenceRecord(
        'webgpu-pipelines',
        'Render and compute pipelines retain native state, optional fragment semantics, explicit layouts, async creation, and validation.',
        [
            'packages/geoscratch/src/scratch/pipeline.ts',
            'packages/geoscratch/src/scratch/pipeline-creation.ts',
            'packages/geoscratch/src/scratch/pipeline-compilation.ts',
        ],
        [
            'tests/scratch-pipeline-decomposition.test.js',
            'tests/scratch-render-pipeline-async.test.js',
            'tests/scratch-compute-pipeline-async.test.js',
        ],
        [ 'ScratchRenderPipeline', 'ScratchComputePipeline', 'ScratchRenderPipelineDescriptor', 'ScratchComputePipelineDescriptor' ],
        [
            'createRenderPipeline',
            'createRenderPipelineAsync',
            'createComputePipeline',
            'createComputePipelineAsync',
            'createPipelineLayout',
        ]
    ),
    evidenceRecord(
        'webgpu-pass-state',
        'Persistent render/compute pass specs and command state retain native attachment, timestamp, viewport, scissor, stencil, blend, and draw semantics.',
        [
            'packages/geoscratch/src/scratch/pass.ts',
            'packages/geoscratch/src/scratch/command.ts',
            'packages/geoscratch/src/scratch/submission.ts',
        ],
        [
            'tests/scratch-render-pass-native-parity.test.js',
            'tests/scratch-depth-stencil-attachments.test.js',
            'tests/scratch-render-state-clear.test.js',
        ],
        [ 'RenderPassSpec', 'ComputePassSpec', 'DrawCommand', 'DispatchCommand' ],
        [ 'beginRenderPass', 'beginComputePass', 'draw', 'drawIndexed', 'dispatchWorkgroups' ]
    ),
    evidenceRecord(
        'webgpu-command-encoding',
        'Standalone command-encoder operations are explicit immutable Commands selected by SubmissionBuilder.',
        [ 'packages/geoscratch/src/scratch/command.ts', 'packages/geoscratch/src/scratch/submission.ts' ],
        [ 'tests/scratch-render-state-clear.test.js', 'tests/scratch-pass-submission.test.js' ],
        [ 'ClearBufferCommand', 'SubmissionBuilder' ],
        [ 'clearBuffer', 'createCommandEncoder', 'finish' ]
    ),
    evidenceRecord(
        'webgpu-copy-upload',
        'All four native GPU copy quadrants plus explicit queue uploads are expressed without CPU roundtrips.',
        [ 'packages/geoscratch/src/scratch/command.ts' ],
        [
            'tests/scratch-copy-command.test.js',
            'tests/scratch-binding-upload.test.js',
            'tests/scratch-texture-transfer-readback.test.js',
        ],
        [ 'CopyCommand', 'UploadCommand', 'TextureUploadCommand' ],
        [
            'copyBufferToBuffer',
            'copyBufferToTexture',
            'copyTextureToBuffer',
            'copyTextureToTexture',
            'writeBuffer',
            'writeTexture',
        ]
    ),
    evidenceRecord(
        'webgpu-external-image-upload',
        'External image uploads preserve native source, origin, color-space, alpha, flip, destination, and extent contracts.',
        [ 'packages/geoscratch/src/scratch/command.ts' ],
        [ 'tests/scratch-external-image-upload.test.js', 'tests/scratch-external-image-upload-docs.test.js' ],
        [ 'ExternalImageUploadCommand', 'ExternalImageUploadCommandDescriptor' ],
        [ 'copyExternalImageToTexture' ]
    ),
    evidenceRecord(
        'webgpu-submission',
        'SubmissionBuilder and SubmittedWork own explicit order, command encoding, queue completion, epochs, readiness, and native observation.',
        [
            'packages/geoscratch/src/scratch/submission.ts',
            'packages/geoscratch/src/scratch/submission-native-observation.ts',
        ],
        [
            'tests/scratch-pass-submission.test.js',
            'tests/scratch-submission-queue-order.test.js',
            'tests/scratch-submission-native-observation.test.js',
        ],
        [ 'SubmissionBuilder', 'SubmittedWork', 'SubmissionStepKind' ],
        [ 'createCommandEncoder', 'GPUCommandEncoder.finish', 'queue.submit', 'onSubmittedWorkDone' ]
    ),
    evidenceRecord(
        'webgpu-readback',
        'Buffer and texture readback use explicit operations, GPU copies, staging/mapping leases, retention bounds, and structured outcomes.',
        [
            'packages/geoscratch/src/scratch/readback.ts',
            'packages/geoscratch/src/scratch/texture-readback.ts',
            'packages/geoscratch/src/scratch/readback-lease.ts',
            'packages/geoscratch/src/scratch/readback-mapping.ts',
        ],
        [
            'tests/scratch-readback-command.test.js',
            'tests/scratch-readback-mapping.test.js',
            'tests/scratch-texture-transfer-readback.test.js',
        ],
        [ 'ReadbackOperation', 'ReadbackCommand', 'MappedReadbackLease', 'TextureReadbackSource' ],
        [ 'copyBufferToBuffer', 'copyTextureToBuffer', 'mapAsync', 'getMappedRange', 'unmap' ]
    ),
    evidenceRecord(
        'webgpu-query',
        'Indexed timestamp/occlusion QuerySetResource slots and resolve commands retain native query lifecycle and availability.',
        [ 'packages/geoscratch/src/scratch/query-set.ts', 'packages/geoscratch/src/scratch/command.ts' ],
        [ 'tests/scratch-query-set.test.js', 'tests/scratch-occlusion-query.test.js' ],
        [ 'QuerySetResource', 'ResolveQuerySetCommand', 'BeginOcclusionQueryCommand', 'EndOcclusionQueryCommand' ],
        [ 'createQuerySet', 'beginOcclusionQuery', 'endOcclusionQuery', 'resolveQuerySet' ]
    ),
    evidenceRecord(
        'webgpu-external-texture',
        'External texture import, binding, expiry, runtime provenance, and attempt-local realization are managed explicitly.',
        [ 'packages/geoscratch/src/scratch/temporal-texture.ts', 'packages/geoscratch/src/scratch/binding.ts' ],
        [ 'tests/scratch-temporal-texture.test.js', 'tests/scratch-command-binding-access.test.js' ],
        [ 'ExternalTextureBinding', 'ExternalTextureBindingDescriptor', 'ExternalTextureBindLayoutEntry' ],
        [ 'importExternalTexture', 'createBindGroup' ]
    ),
    evidenceRecord(
        'webgpu-render-bundle-debug',
        'Render bundle encoding/execution and pass/bundle debug commands lower to native operations with lifecycle diagnostics.',
        [
            'packages/geoscratch/src/scratch/render-bundle.ts',
            'packages/geoscratch/src/scratch/debug-command.ts',
        ],
        [ 'tests/scratch-render-bundle-debug.test.js' ],
        [ 'RenderBundle', 'BundleDrawCommand', 'ExecuteRenderBundlesCommand', 'DebugCommand' ],
        [
            'createRenderBundleEncoder',
            'GPURenderBundleEncoder.finish',
            'executeBundles',
            'pushDebugGroup',
            'popDebugGroup',
            'insertDebugMarker',
        ]
    ),
    evidenceRecord(
        'webgpu-diagnostics',
        'Validation, internal, OOM, uncaptured, device-loss, and operation provenance are retained as bounded structured diagnostics.',
        [
            'packages/geoscratch/src/scratch/diagnostics.ts',
            'packages/geoscratch/src/scratch/runtime-diagnostics.ts',
            'packages/geoscratch/src/scratch/gpu-operation.ts',
            'packages/geoscratch/src/scratch/supporting-object-creation.ts',
        ],
        [
            'tests/scratch-diagnostics.test.js',
            'tests/scratch-gpu-operation-provenance.test.js',
            'tests/scratch-submission-native-observation.test.js',
        ],
        [ 'ScratchDiagnostic', 'ScratchDiagnosticError', 'ScratchRuntimeDiagnostics' ],
        [ 'pushErrorScope', 'popErrorScope', 'uncapturederror', 'device.lost' ]
    ),
    evidenceRecord(
        'webgpu-numeric-domains',
        'WebIDL numeric aliases without standalone GPU behavior are range-checked where they enter explicit Scratch descriptors.',
        [
            'packages/geoscratch/src/scratch/runtime.ts',
            'packages/geoscratch/src/scratch/command.ts',
            'packages/geoscratch/src/scratch/pipeline.ts',
            'packages/geoscratch/src/scratch/submission.ts',
        ],
        [
            'tests/types/public-api.ts',
            'tests/scratch-pipeline-command.test.js',
            'tests/scratch-render-pass-native-parity.test.js',
        ],
        [ 'BufferRegionDescriptor', 'CopyCommandDescriptor', 'DrawCommandDescriptor', 'TextureResourceDescriptor' ],
        [ 'createRenderPipeline', 'beginRenderPass', 'copyBufferToTexture', 'copyTextureToBuffer' ]
    ),
    evidenceRecord(
        'webidl-non-capability',
        'Nominal brands and declaration-only helpers are frozen as not-applicable rather than counted as workload capabilities.',
        [ 'scripts/scratch-webgpu-wgsl-parity-manifest.mjs' ],
        [ 'tests/audits/scratch-webgpu-wgsl-managed-parity.mjs' ],
        [],
        []
    ),
    evidenceRecord(
        'wgsl-recursive-layout',
        'Recursive LayoutCodec artifacts cover scalar/vector/matrix shapes, f16, arrays, structs, atomics, member attributes, runtime roots, BufferView contracts, packing, accessors, and readback ABI.',
        [
            'packages/geoscratch/src/scratch/layout-codec.ts',
            'packages/geoscratch/src/scratch/layout-artifact.ts',
            'packages/geoscratch/src/scratch/program.ts',
            'packages/geoscratch/src/scratch/shader-module.ts',
            'packages/geoscratch/src/scratch/pipeline-creation.ts',
        ],
        [
            'tests/scratch-recursive-layout-codec.test.js',
            'tests/scratch-program-layout-requirements.test.js',
            'tests/scratch-layout-readback-operation.test.js',
        ],
        [ 'LayoutCodec', 'LayoutArtifact', 'LayoutBufferViewContract', 'Program' ],
        [ 'LayoutCodec.pack', 'LayoutCodec.wgsl', 'createShaderModule', 'createRenderPipeline', 'createComputePipeline' ]
    ),
    evidenceRecord(
        'wgsl-caller-authored-source',
        'WGSL syntax, control flow, built-ins, address spaces, pointers, opaque types, and entry points remain lossless caller-authored Program source.',
        [
            'packages/geoscratch/src/scratch/shader-module.ts',
            'packages/geoscratch/src/scratch/program.ts',
            'packages/geoscratch/src/scratch/pipeline-creation.ts',
        ],
        [ 'tests/scratch-shader-module.test.js', 'tests/scratch-program.test.js' ],
        [ 'ShaderModule', 'ShaderModuleSourcePart', 'Program', 'ProgramDescriptor' ],
        [ 'createShaderModule', 'getCompilationInfo', 'createRenderPipeline', 'createComputePipeline' ]
    ),
    evidenceRecord(
        'wgsl-language-contract',
        'WGSL language extensions are declared separately through Program.requiredLanguageFeatures and checked against an immutable Runtime language-feature snapshot.',
        [ 'packages/geoscratch/src/scratch/runtime.ts', 'packages/geoscratch/src/scratch/program.ts' ],
        [ 'tests/scratch-program-layout-requirements.test.js', 'tests/scratch-immediate-data.test.js' ],
        [ 'ScratchRuntime', 'ScratchRuntimeRequestFacts', 'Program', 'ProgramDescriptor' ],
        [ 'createShaderModule', 'createRenderPipeline', 'createComputePipeline' ]
    ),
    evidenceRecord(
        'wgsl-enable-contract',
        'WGSL enable directives remain caller-authored while matching GPU features and formal dependencies are declared explicitly by Runtime and Program.',
        [
            'packages/geoscratch/src/scratch/feature-contract.ts',
            'packages/geoscratch/src/scratch/runtime.ts',
            'packages/geoscratch/src/scratch/program.ts',
        ],
        [
            'tests/scratch-runtime.test.js',
            'tests/scratch-program.test.js',
            'tests/scratch-webgpu-wgsl-current-coverage.test.js',
        ],
        [ 'ScratchRuntime', 'ScratchRuntimeRequestFacts', 'Program', 'ShaderModuleSourcePart' ],
        [ 'requestDevice', 'createShaderModule', 'createRenderPipeline', 'createComputePipeline' ],
        [ 'tests/browser/scratch-wgsl-capability-matrix.mjs' ]
    ),
    evidenceRecord(
        'wgsl-immediate-data',
        'The immediate_address_space language contract is coupled to explicit pipeline byte size and per-command submission snapshots.',
        [ 'packages/geoscratch/src/scratch/pipeline.ts', 'packages/geoscratch/src/scratch/command.ts' ],
        [ 'tests/scratch-immediate-data.test.js' ],
        [ 'Program', 'CommandImmediateData', 'ScratchRenderPipelineDescriptor' ],
        [ 'setImmediates' ]
    ),
])

const evidenceById = new Map(evidence.map(record => [ record.id, record ]))

const entryProofProfiles = Object.freeze({
    'runtime-adapter': proofProfile(
        'ScratchRuntime performs explicit adapter and device acquisition.',
        [ 'ScratchRuntime', 'ScratchRuntimeCreateOptions' ],
        [
            operationProof(
                'requestAdapter',
                'packages/geoscratch/src/scratch/runtime.ts'
            ),
            operationProof(
                'requestDevice',
                'packages/geoscratch/src/scratch/runtime.ts'
            ),
        ]
    ),
    'runtime-request-adapter': proofProfile(
        'ScratchRuntimeCreateOptions preserves explicit adapter acquisition inputs.',
        [ 'ScratchRuntime', 'ScratchRuntimeCreateOptions' ],
        [
            operationProof(
                'requestAdapter',
                'packages/geoscratch/src/scratch/runtime.ts'
            ),
        ]
    ),
    'runtime-request-device': proofProfile(
        'ScratchRuntimeCreateOptions preserves explicit device acquisition inputs.',
        [ 'ScratchRuntime', 'ScratchRuntimeCreateOptions' ],
        [
            operationProof(
                'requestDevice',
                'packages/geoscratch/src/scratch/runtime.ts'
            ),
        ]
    ),
    'runtime-capabilities': proofProfile(
        'ScratchRuntime exposes immutable adapter and device capability facts.',
        [ 'ScratchRuntime', 'ScratchRuntimeRequestFacts' ],
        [
            operationProof(
                'adapterFeatures',
                'packages/geoscratch/src/scratch/runtime.ts'
            ),
            operationProof(
                'deviceFeatures',
                'packages/geoscratch/src/scratch/runtime.ts'
            ),
        ]
    ),
    'runtime-adapter-info': proofProfile(
        'ScratchRuntime exposes an immutable adapter information snapshot.',
        [ 'ScratchAdapterInfoSnapshot', 'ScratchRuntime' ],
        [
            operationProof(
                'adapterInfo',
                'packages/geoscratch/src/scratch/runtime.ts'
            ),
        ]
    ),
    'runtime-wgsl-features': proofProfile(
        'ScratchRuntime exposes immutable WGSL language-feature facts.',
        [ 'ScratchRuntime', 'ScratchRuntimeRequestFacts' ],
        [
            operationProof(
                'wgslLanguageFeatures',
                'packages/geoscratch/src/scratch/runtime.ts'
            ),
        ]
    ),
    'runtime-supported-limits': proofProfile(
        'ScratchRuntime exposes immutable adapter and device limit facts.',
        [ 'ScratchRuntime', 'ScratchRuntimeRequestFacts' ],
        [
            operationProof(
                'adapter.limits',
                'packages/geoscratch/src/scratch/runtime.ts'
            ),
            operationProof(
                'device.limits',
                'packages/geoscratch/src/scratch/runtime.ts'
            ),
        ]
    ),
    'runtime-device-loss': proofProfile(
        'ScratchRuntime owns the device-loss lifecycle and its structured facts.',
        [ 'ScratchDeviceLostInfo', 'ScratchRuntime' ],
        [
            operationProof(
                'device.lost',
                'packages/geoscratch/src/scratch/runtime.ts'
            ),
        ]
    ),
    'runtime-device-lifecycle': proofProfile(
        'ScratchRuntime owns explicit native device disposal and device-loss observation.',
        [ 'ScratchDeviceLostInfo', 'ScratchRuntime' ],
        [
            operationProof(
                'device.destroy',
                'packages/geoscratch/src/scratch/runtime.ts'
            ),
            operationProof(
                'device.lost',
                'packages/geoscratch/src/scratch/runtime.ts'
            ),
        ]
    ),
    'surface-presentation': proofProfile(
        'Surface owns explicit canvas configuration and presentation leases.',
        [ 'Surface', 'SurfaceOptions', 'SurfaceTextureLease' ],
        [
            operationProof(
                'GPUCanvasContext.configure',
                'packages/geoscratch/src/scratch/surface.ts'
            ),
            operationProof(
                'GPUCanvasContext.getCurrentTexture',
                'packages/geoscratch/src/scratch/temporal-texture.ts'
            ),
        ]
    ),
    'surface-configuration': proofProfile(
        'SurfaceOptions preserves explicit native canvas configuration.',
        [ 'Surface', 'SurfaceOptions' ],
        [
            operationProof(
                'GPUCanvasContext.configure',
                'packages/geoscratch/src/scratch/surface.ts'
            ),
        ]
    ),
    'resource-lifetime': proofProfile(
        'Resource identity and native allocation disposal are explicit.',
        [ 'Resource', 'ResourceState' ],
        [
            operationProof(
                'destroy',
                'packages/geoscratch/src/scratch/native-allocation.ts'
            ),
        ]
    ),
    'buffer-resource': proofProfile(
        'BufferResource and BufferRegion preserve allocation, usage, and range semantics.',
        [ 'BufferRegion', 'BufferResource' ],
        [
            operationProof(
                'createBuffer',
                'packages/geoscratch/src/scratch/buffer.ts'
            ),
        ]
    ),
    'buffer-mapping': proofProfile(
        'MappedBufferLease provides explicit bounded host mapping authority.',
        [ 'BufferRegion', 'BufferResource', 'MappedBufferLease' ],
        [
            operationProof(
                'mapAsync',
                'packages/geoscratch/src/scratch/buffer-mapping.ts'
            ),
            operationProof(
                'getMappedRange',
                'packages/geoscratch/src/scratch/buffer-mapping.ts'
            ),
            operationProof(
                'unmap',
                'packages/geoscratch/src/scratch/buffer-mapping.ts'
            ),
        ]
    ),
    'texture-resource': proofProfile(
        'TextureResource and TextureViewSpec preserve texture allocation and view semantics.',
        [ 'TextureResource', 'TextureViewSpec' ],
        [
            operationProof(
                'createTexture',
                'packages/geoscratch/src/scratch/texture.ts'
            ),
            operationProof(
                'GPUTexture.createView',
                'packages/geoscratch/src/scratch/texture.ts'
            ),
        ]
    ),
    'texture-allocation': proofProfile(
        'TextureResource preserves explicit native texture allocation facts.',
        [ 'TextureResource' ],
        [
            operationProof(
                'createTexture',
                'packages/geoscratch/src/scratch/texture.ts'
            ),
        ]
    ),
    'texture-view': proofProfile(
        'TextureViewSpec preserves explicit native texture-view selection.',
        [ 'TextureResource', 'TextureViewSpec' ],
        [
            operationProof(
                'GPUTexture.createView',
                'packages/geoscratch/src/scratch/texture.ts'
            ),
        ]
    ),
    sampler: proofProfile(
        'SamplerResource preserves the native sampler descriptor contract.',
        [ 'SamplerResource', 'SamplerResourceDescriptor' ],
        [
            operationProof(
                'createSampler',
                'packages/geoscratch/src/scratch/sampler.ts'
            ),
        ]
    ),
    'binding-layout': proofProfile(
        'BindLayout preserves explicit native binding ABI declarations.',
        [ 'BindLayout', 'BindLayoutDescriptor' ],
        [
            operationProof(
                'createBindGroupLayout',
                'packages/geoscratch/src/scratch/binding.ts'
            ),
        ]
    ),
    'binding-set': proofProfile(
        'BindSet preserves concrete resource binding and preparation authority.',
        [ 'BindLayout', 'BindSet', 'BindSetBindings' ],
        [
            operationProof(
                'createBindGroup',
                'packages/geoscratch/src/scratch/binding.ts'
            ),
        ]
    ),
    'binding-command': proofProfile(
        'Draw, Dispatch, and RenderBundle commands bind prepared BindSets explicitly.',
        [ 'BindSet', 'DispatchCommand', 'DrawCommand' ],
        [
            operationProof(
                'setBindGroup',
                'packages/geoscratch/src/scratch/command.ts'
            ),
        ]
    ),
    'shader-program': proofProfile(
        'ShaderModule and Program preserve caller-authored WGSL and compilation evidence.',
        [ 'Program', 'ShaderModule', 'ShaderModuleSourcePart' ],
        [
            operationProof(
                'createShaderModule',
                'packages/geoscratch/src/scratch/shader-module.ts'
            ),
            operationProof(
                'getCompilationInfo',
                'packages/geoscratch/src/scratch/shader-module.ts'
            ),
        ]
    ),
    'shader-module-create': proofProfile(
        'ShaderModule preserves caller-authored WGSL and explicit compilation inputs.',
        [ 'Program', 'ShaderModule', 'ShaderModuleSourcePart' ],
        [
            operationProof(
                'createShaderModule',
                'packages/geoscratch/src/scratch/shader-module.ts'
            ),
        ]
    ),
    'shader-compilation-info': proofProfile(
        'ShaderModuleCompilationReport preserves native compilation messages and locations.',
        [ 'ShaderModule', 'ShaderModuleCompilationReport' ],
        [
            operationProof(
                'getCompilationInfo',
                'packages/geoscratch/src/scratch/shader-module.ts'
            ),
        ]
    ),
    'pipeline-state': proofProfile(
        'Scratch render and compute pipelines preserve explicit stable pipeline state.',
        [
            'ScratchComputePipeline',
            'ScratchComputePipelineDescriptor',
            'ScratchRenderPipeline',
            'ScratchRenderPipelineDescriptor',
        ],
        [
            operationProof(
                'createRenderPipelineAsync',
                'packages/geoscratch/src/scratch/pipeline-creation.ts'
            ),
            operationProof(
                'createComputePipelineAsync',
                'packages/geoscratch/src/scratch/pipeline-creation.ts'
            ),
        ]
    ),
    'pipeline-layout': proofProfile(
        'Scratch pipeline descriptors preserve explicit native pipeline layout construction.',
        [
            'ScratchComputePipelineDescriptor',
            'ScratchRenderPipelineDescriptor',
        ],
        [
            operationProof(
                'createPipelineLayout',
                'packages/geoscratch/src/scratch/pipeline-creation.ts'
            ),
        ]
    ),
    'pipeline-render': proofProfile(
        'ScratchRenderPipeline preserves render pipeline state through acknowledged async creation.',
        [ 'ScratchRenderPipeline', 'ScratchRenderPipelineDescriptor' ],
        [
            operationProof(
                'createRenderPipelineAsync',
                'packages/geoscratch/src/scratch/pipeline-creation.ts'
            ),
        ]
    ),
    'pipeline-compute': proofProfile(
        'ScratchComputePipeline preserves compute pipeline state through acknowledged async creation.',
        [ 'ScratchComputePipeline', 'ScratchComputePipelineDescriptor' ],
        [
            operationProof(
                'createComputePipelineAsync',
                'packages/geoscratch/src/scratch/pipeline-creation.ts'
            ),
        ]
    ),
    'pipeline-compare-function': proofProfile(
        'Scratch render pipelines and samplers preserve native comparison functions.',
        [
            'SamplerResource',
            'SamplerResourceDescriptor',
            'ScratchRenderPipeline',
            'ScratchRenderPipelineDescriptor',
        ],
        [
            operationProof(
                'createRenderPipelineAsync',
                'packages/geoscratch/src/scratch/pipeline-creation.ts'
            ),
            operationProof(
                'createSampler',
                'packages/geoscratch/src/scratch/sampler.ts'
            ),
        ]
    ),
    'pipeline-vertex-buffer-layout': proofProfile(
        'ScratchRenderPipelineDescriptor preserves native vertex buffer layouts.',
        [ 'ScratchRenderPipeline', 'ScratchRenderPipelineDescriptor' ],
        [
            operationProof(
                'createRenderPipelineAsync',
                'packages/geoscratch/src/scratch/pipeline-creation.ts'
            ),
        ]
    ),
    'render-pass': proofProfile(
        'RenderPassSpec and DrawCommand preserve render pass and draw semantics.',
        [ 'DrawCommand', 'RenderPassSpec' ],
        [
            operationProof(
                'beginRenderPass',
                'packages/geoscratch/src/scratch/submission.ts'
            ),
        ]
    ),
    'compute-pass': proofProfile(
        'ComputePassSpec and DispatchCommand preserve compute pass and dispatch semantics.',
        [ 'ComputePassSpec', 'DispatchCommand' ],
        [
            operationProof(
                'beginComputePass',
                'packages/geoscratch/src/scratch/submission.ts'
            ),
        ]
    ),
    'render-command': proofProfile(
        'DrawCommand preserves explicit native render command encoding.',
        [ 'DrawCommand' ],
        [
            operationProof(
                'draw',
                'packages/geoscratch/src/scratch/command.ts'
            ),
            operationProof(
                'drawIndexed',
                'packages/geoscratch/src/scratch/command.ts'
            ),
        ]
    ),
    'command-encoding': proofProfile(
        'SubmissionBuilder owns explicit command encoder construction and finish.',
        [ 'SubmissionBuilder' ],
        [
            operationProof(
                'createCommandEncoder',
                'packages/geoscratch/src/scratch/submission.ts'
            ),
            operationProof(
                'GPUCommandEncoder.finish',
                'packages/geoscratch/src/scratch/submission.ts'
            ),
        ]
    ),
    'command-encoder-create': proofProfile(
        'SubmissionBuilder owns explicit native command encoder construction.',
        [ 'SubmissionBuilder' ],
        [
            operationProof(
                'createCommandEncoder',
                'packages/geoscratch/src/scratch/submission.ts'
            ),
        ]
    ),
    'submission-command-buffer': proofProfile(
        'SubmissionBuilder produces native command buffers and SubmittedWork retains their observation.',
        [ 'SubmissionBuilder', 'SubmittedWork' ],
        [
            operationProof(
                'GPUCommandEncoder.finish',
                'packages/geoscratch/src/scratch/submission.ts'
            ),
        ]
    ),
    'copy-command': proofProfile(
        'CopyCommand preserves all four native GPU copy quadrants without a CPU roundtrip.',
        [ 'CopyCommand' ],
        [
            operationProof(
                'copyBufferToBuffer',
                'packages/geoscratch/src/scratch/command.ts'
            ),
            operationProof(
                'copyBufferToTexture',
                'packages/geoscratch/src/scratch/command.ts'
            ),
            operationProof(
                'copyTextureToBuffer',
                'packages/geoscratch/src/scratch/command.ts'
            ),
            operationProof(
                'copyTextureToTexture',
                'packages/geoscratch/src/scratch/command.ts'
            ),
        ]
    ),
    'copy-texture-info': proofProfile(
        'Copy and upload commands preserve native texel-copy texture selection for encoder and queue operations.',
        [
            'CopyCommand',
            'ExternalImageUploadCommand',
            'TextureCopyCommandSourceDescriptor',
            'TextureUploadCommand',
        ],
        [
            operationProof(
                'copyBufferToTexture',
                'packages/geoscratch/src/scratch/command.ts'
            ),
            operationProof(
                'copyExternalImageToTexture',
                'packages/geoscratch/src/scratch/command.ts'
            ),
            operationProof(
                'copyTextureToBuffer',
                'packages/geoscratch/src/scratch/command.ts'
            ),
            operationProof(
                'copyTextureToTexture',
                'packages/geoscratch/src/scratch/command.ts'
            ),
            operationProof(
                'writeTexture',
                'packages/geoscratch/src/scratch/command.ts'
            ),
        ]
    ),
    'copy-buffer-info': proofProfile(
        'CopyCommand buffer endpoints preserve native texel-copy buffer layout.',
        [ 'BufferCopyCommandSourceDescriptor', 'CopyCommand' ],
        [
            operationProof(
                'copyBufferToTexture',
                'packages/geoscratch/src/scratch/command.ts'
            ),
            operationProof(
                'copyTextureToBuffer',
                'packages/geoscratch/src/scratch/command.ts'
            ),
        ]
    ),
    'external-image-copy': proofProfile(
        'ExternalImageUploadCommand preserves native external image copy semantics.',
        [ 'ExternalImageUploadCommand', 'ExternalImageUploadCommandDescriptor' ],
        [
            operationProof(
                'copyExternalImageToTexture',
                'packages/geoscratch/src/scratch/command.ts'
            ),
        ]
    ),
    submission: proofProfile(
        'SubmissionBuilder and SubmittedWork preserve explicit queue order and completion.',
        [ 'SubmissionBuilder', 'SubmittedWork' ],
        [
            operationProof(
                'queue.submit',
                'packages/geoscratch/src/scratch/submission.ts'
            ),
            operationProof(
                'onSubmittedWorkDone',
                'packages/geoscratch/src/scratch/submission.ts'
            ),
        ]
    ),
    readback: proofProfile(
        'ReadbackOperation preserves GPU copy and bounded host mapping lifecycle.',
        [ 'MappedReadbackLease', 'ReadbackOperation' ],
        [
            operationProof(
                'copyTextureToBuffer',
                'packages/geoscratch/src/scratch/texture-readback.ts'
            ),
            operationProof(
                'mapAsync',
                'packages/geoscratch/src/scratch/readback-mapping.ts'
            ),
        ]
    ),
    query: proofProfile(
        'QuerySetResource and explicit query commands preserve indexed native query semantics.',
        [ 'QuerySetResource', 'ResolveQuerySetCommand' ],
        [
            operationProof(
                'createQuerySet',
                'packages/geoscratch/src/scratch/query-set.ts'
            ),
            operationProof(
                'resolveQuerySet',
                'packages/geoscratch/src/scratch/command.ts'
            ),
        ]
    ),
    'query-create': proofProfile(
        'QuerySetResource preserves indexed native query allocation semantics.',
        [ 'QuerySetResource' ],
        [
            operationProof(
                'createQuerySet',
                'packages/geoscratch/src/scratch/query-set.ts'
            ),
        ]
    ),
    'compute-pass-timestamp': proofProfile(
        'ComputePassSpec preserves explicit timestamp writes against QuerySetResource slots.',
        [ 'ComputePassSpec', 'QuerySetResource' ],
        [
            operationProof(
                'beginComputePass',
                'packages/geoscratch/src/scratch/submission.ts'
            ),
        ]
    ),
    'render-pass-timestamp': proofProfile(
        'RenderPassSpec preserves explicit timestamp writes against QuerySetResource slots.',
        [ 'QuerySetResource', 'RenderPassSpec' ],
        [
            operationProof(
                'beginRenderPass',
                'packages/geoscratch/src/scratch/submission.ts'
            ),
        ]
    ),
    'external-texture': proofProfile(
        'ExternalTextureBinding preserves import, binding, expiry, and attempt-local realization.',
        [ 'ExternalTextureBinding', 'ExternalTextureBindLayoutEntry' ],
        [
            operationProof(
                'importExternalTexture',
                'packages/geoscratch/src/scratch/temporal-texture.ts'
            ),
        ]
    ),
    'render-bundle-create': proofProfile(
        'ScratchRuntime and RenderBundle preserve native render bundle construction.',
        [ 'RenderBundle', 'RenderBundleDescriptor', 'ScratchRuntime' ],
        [
            operationProof(
                'createRenderBundleEncoder',
                'packages/geoscratch/src/scratch/render-bundle.ts'
            ),
        ]
    ),
    'render-bundle-execute': proofProfile(
        'ExecuteRenderBundlesCommand preserves native render bundle execution.',
        [ 'ExecuteRenderBundlesCommand', 'RenderBundle' ],
        [
            operationProof(
                'executeBundles',
                'packages/geoscratch/src/scratch/render-bundle.ts'
            ),
        ]
    ),
    'render-bundle': proofProfile(
        'RenderBundle preserves native bundle layout, commands, and finish semantics.',
        [ 'RenderBundle', 'RenderBundleDescriptor' ],
        [
            operationProof(
                'createRenderBundleEncoder',
                'packages/geoscratch/src/scratch/render-bundle.ts'
            ),
            operationProof(
                'GPURenderBundleEncoder.finish',
                'packages/geoscratch/src/scratch/render-bundle.ts'
            ),
        ]
    ),
    'render-bundle-finish': proofProfile(
        'RenderBundle preserves native render-bundle finish semantics.',
        [ 'RenderBundle', 'RenderBundleDescriptor' ],
        [
            operationProof(
                'GPURenderBundleEncoder.finish',
                'packages/geoscratch/src/scratch/render-bundle.ts'
            ),
        ]
    ),
    'debug-command': proofProfile(
        'DebugCommand preserves native debug groups and markers.',
        [ 'DebugCommand' ],
        [
            operationProof(
                'pushDebugGroup',
                'packages/geoscratch/src/scratch/debug-command.ts'
            ),
            operationProof(
                'popDebugGroup',
                'packages/geoscratch/src/scratch/debug-command.ts'
            ),
            operationProof(
                'insertDebugMarker',
                'packages/geoscratch/src/scratch/debug-command.ts'
            ),
        ]
    ),
    diagnostics: proofProfile(
        'ScratchDiagnostic preserves validation, internal, OOM, uncaptured, and device-loss evidence.',
        [ 'ScratchDiagnostic', 'ScratchDiagnosticError', 'ScratchRuntimeDiagnostics' ],
        [
            operationProof(
                'pushErrorScope',
                'packages/geoscratch/src/scratch/supporting-object-creation.ts'
            ),
            operationProof(
                'popErrorScope',
                'packages/geoscratch/src/scratch/supporting-object-creation.ts'
            ),
        ]
    ),
    'diagnostic-error-facts': proofProfile(
        'ScratchDiagnostic preserves structured native GPU error facts.',
        [ 'ScratchDiagnostic', 'ScratchDiagnosticError', 'ScratchRuntimeDiagnostics' ],
        [
            operationProof(
                'serializeNativeGpuError',
                'packages/geoscratch/src/scratch/gpu-operation.ts'
            ),
        ]
    ),
    'numeric-domain': proofProfile(
        'Scratch descriptors range-check WebIDL numeric domains at explicit GPU operation boundaries.',
        [ 'CopyCommandDescriptor', 'DrawCommandDescriptor' ],
        [
            operationProof(
                'copyBufferToTexture',
                'packages/geoscratch/src/scratch/command.ts'
            ),
            operationProof(
                'draw',
                'packages/geoscratch/src/scratch/command.ts'
            ),
        ]
    ),
    'wgsl-source': proofProfile(
        'Caller-authored WGSL remains lossless through ShaderModule and Program.',
        [ 'Program', 'ShaderModule', 'ShaderModuleSourcePart' ],
        [
            operationProof(
                'createShaderModule',
                'packages/geoscratch/src/scratch/shader-module.ts'
            ),
            operationProof(
                'getCompilationInfo',
                'packages/geoscratch/src/scratch/shader-module.ts'
            ),
        ]
    ),
    'wgsl-layout': proofProfile(
        'LayoutCodec and Program preserve host-shareable WGSL layout and accessor contracts.',
        [ 'LayoutArtifact', 'LayoutCodec', 'Program' ],
        [
            operationProof(
                'LayoutCodec.pack',
                'packages/geoscratch/src/scratch/layout-codec.ts'
            ),
            operationProof(
                'LayoutCodec.wgsl',
                'packages/geoscratch/src/scratch/layout-codec.ts'
            ),
        ]
    ),
    'wgsl-pipeline-interface': proofProfile(
        'Program and Scratch pipelines preserve WGSL entry-point and pipeline interface semantics.',
        [ 'Program', 'ScratchComputePipeline', 'ScratchRenderPipeline' ],
        [
            operationProof(
                'createRenderPipelineAsync',
                'packages/geoscratch/src/scratch/pipeline-creation.ts'
            ),
            operationProof(
                'createComputePipelineAsync',
                'packages/geoscratch/src/scratch/pipeline-creation.ts'
            ),
        ]
    ),
    'wgsl-binding': proofProfile(
        'Program, LayoutCodec, and BindLayout preserve WGSL resource binding contracts.',
        [ 'BindLayout', 'LayoutCodec', 'Program' ],
        [
            operationProof(
                'createBindGroupLayout',
                'packages/geoscratch/src/scratch/binding.ts'
            ),
            operationProof(
                'createShaderModule',
                'packages/geoscratch/src/scratch/shader-module.ts'
            ),
        ]
    ),
    'wgsl-texture-binding': proofProfile(
        'Program, BindLayout, and TextureResource preserve WGSL texture and format contracts.',
        [ 'BindLayout', 'Program', 'TextureResource' ],
        [
            operationProof(
                'createBindGroupLayout',
                'packages/geoscratch/src/scratch/binding.ts'
            ),
            operationProof(
                'createTexture',
                'packages/geoscratch/src/scratch/texture.ts'
            ),
        ]
    ),
    'wgsl-diagnostics': proofProfile(
        'ShaderModule compilation evidence is normalized into Scratch diagnostics.',
        [ 'ScratchDiagnostic', 'ShaderModule' ],
        [
            operationProof(
                'getCompilationInfo',
                'packages/geoscratch/src/scratch/shader-module.ts'
            ),
        ]
    ),
    'wgsl-capability': proofProfile(
        'Program declares WGSL language requirements against immutable Runtime capabilities.',
        [ 'Program', 'ScratchRuntime', 'ScratchRuntimeRequestFacts' ],
        [
            operationProof(
                'createShaderModule',
                'packages/geoscratch/src/scratch/shader-module.ts'
            ),
            operationProof(
                'wgslLanguageFeatures',
                'packages/geoscratch/src/scratch/runtime.ts'
            ),
        ]
    ),
    'wgsl-enable': proofProfile(
        'Caller-authored WGSL enable directives retain explicit Program and Runtime feature contracts.',
        [ 'Program', 'ScratchRuntime', 'ShaderModuleSourcePart' ],
        [
            operationProof(
                'requestDevice',
                'packages/geoscratch/src/scratch/runtime.ts'
            ),
            operationProof(
                'createShaderModule',
                'packages/geoscratch/src/scratch/shader-module.ts'
            ),
        ]
    ),
    'wgsl-immediate': proofProfile(
        'Program, Pipeline, and CommandImmediateData preserve immediate-address-space semantics.',
        [ 'CommandImmediateData', 'Program', 'ScratchRenderPipelineDescriptor' ],
        [
            operationProof(
                'setImmediates',
                'packages/geoscratch/src/scratch/command.ts'
            ),
        ]
    ),
})

export function createWgslEnableExtensionManifest() {

    const wgsl = readJson(normativeArtifactPaths.wgsl)
    const dependencies = readJson(normativeArtifactPaths.dependencies)
    const entries = wgsl.entries
        .filter(entry => entry.kind === 'enable-extension')
        .map((entry) => {
            const requirements = currentWgslRequirements(
                entry,
                dependencies
            )
            return {
                id: entry.id,
                extension: entry.name,
                requiredFeatures: requirements.deviceFeatures,
                dependencies: requirements.dependencies,
                source: {
                    publication: currentSpecRefresh.wgsl.publication,
                    url:
                        `${wgsl.source.publicationUrl}#` +
                        entry.sourceAnchor,
                    anchor: entry.sourceAnchor,
                    gpuFeatureUrls: requirements.deviceFeatures.map(
                        feature => (
                            `${currentSpecRefresh.webgpu.url}` +
                            `#dom-gpufeaturename-${feature}`
                        )
                    ),
                },
                requiredLanguageFeatures: [],
                current: {
                    status: 'managed',
                    classification: 'managed-semantic-equivalent',
                    rationale:
                        'Caller-authored WGSL enable directive plus explicit Runtime and Program GPU feature contracts preserve native semantics.',
                },
                expression: {
                    mode: 'caller-authored-wgsl',
                    directive: `enable ${entry.name};`,
                    publicSymbols:
                        evidenceById.get('wgsl-enable-contract').publicSymbols,
                },
                nativeLowering: {
                    kind: 'wgsl-compilation',
                    sourcePaths:
                        evidenceById.get('wgsl-enable-contract').sourcePaths,
                    operations:
                        evidenceById.get('wgsl-enable-contract').nativeOperations,
                },
                evidenceIds: [ 'wgsl-enable-contract' ],
            }
        })

    return {
        schemaVersion: 3,
        purpose:
            'Current formal WGSL enable-extension to WebGPU feature contracts derived from the normative inventory',
        baseline: currentSpecRefresh,
        normativeManifest: relative(normativeArtifactPaths.wgsl),
        dependencyManifest: relative(normativeArtifactPaths.dependencies),
        entries,
        summary: {
            entryCount: entries.length,
            dependencyCount: entries.reduce(
                (count, entry) => count + entry.dependencies.length,
                0
            ),
        },
    }
}

export function createCurrentCoverageManifest() {

    const webgpu = readJson(normativeArtifactPaths.webgpu)
    const wgsl = readJson(normativeArtifactPaths.wgsl)
    const dependencies = readJson(normativeArtifactPaths.dependencies)
    const frozenWebgpu = readJson(webGpuManifestPath)
    const frozenWgsl = readJson(wgslManifestPath)
    const historicalWebgpu = historicalEntries(frozenWebgpu)
    const historicalWgsl = historicalEntries(frozenWgsl)
    const entries = [
        ...webgpu.entries.map(entry => currentWebGpuEntry({
            manifest: webgpu,
            entry,
            dependencies,
            goalStart: historicalGoalStart(
                entry,
                historicalWebgpu,
                'WebGPU'
            ),
        })),
        ...wgsl.entries.map(entry => currentWgslEntry({
            manifest: wgsl,
            entry,
            dependencies,
            goalStart: historicalGoalStart(
                entry,
                historicalWgsl,
                'WGSL'
            ),
        })),
    ].sort((left, right) => left.id.localeCompare(right.id))
    const byClassification = countBy(
        entries,
        entry => entry.current.classification
    )
    const byStatus = countBy(entries, entry => entry.current.status)

    return {
        schemaVersion: 3,
        purpose:
            'Current managed WebGPU and WGSL expression and evidence closure sourced from fixed normative inventories',
        baseline: currentSpecRefresh,
        normativeManifests: {
            webgpu: relative(normativeArtifactPaths.webgpu),
            wgsl: relative(normativeArtifactPaths.wgsl),
            dependencies: relative(normativeArtifactPaths.dependencies),
            proposals: relative(normativeArtifactPaths.proposals),
        },
        frozenManifests: {
            webgpuHistoricalBaseline: relative(webGpuManifestPath),
            wgslHistoricalBaseline: relative(wgslManifestPath),
        },
        currentClassificationValues: [
            'managed-first-class',
            'managed-semantic-equivalent',
            'not-applicable',
            'unresolved',
        ],
        statusValues: [ 'managed', 'not-applicable', 'unresolved' ],
        evidence,
        entries,
        summary: {
            entryCount: entries.length,
            webgpuNormativeEntryCount: webgpu.entries.length,
            wgslNormativeEntryCount: wgsl.entries.length,
            frozenWebgpuHistoricalEntryCount:
                frozenWebgpu.entries.length,
            frozenWgslHistoricalEntryCount: frozenWgsl.entries.length,
            unresolvedCount: byStatus.unresolved ?? 0,
            byStatus,
            byClassification,
        },
    }
}

function currentWebGpuEntry({
    manifest,
    entry,
    dependencies,
    goalStart,
}) {

    const coverage = webGpuCoverage(entry)
    return currentEntry({
        domain: 'webgpu',
        entry,
        goalStart,
        coverage,
        source: {
            publication: currentSpecRefresh.webgpu.publication,
            url:
                `${manifest.source.publicationUrl}#` +
                entry.sourceAnchor,
            anchor: entry.sourceAnchor,
            normativeManifest: relative(normativeArtifactPaths.webgpu),
        },
        requirements: webGpuRequirements(entry, dependencies),
        expressionMode:
            entry.kind === 'includes' || entry.kind === 'collection'
                ? 'scratch-semantic-contract'
                : 'scratch-api',
        nativeLoweringKind:
            entry.kind === 'includes' || entry.kind === 'collection'
                ? 'native-semantic-equivalence'
                : 'native-call-or-descriptor',
    })
}

function currentWgslEntry({
    manifest,
    entry,
    dependencies,
    goalStart,
}) {

    const coverage = {
        ...wgslCoverage(entry),
        proofProfile: wgslProofProfile(entry),
    }
    return currentEntry({
        domain: 'wgsl',
        entry,
        goalStart,
        coverage,
        source: {
            publication: currentSpecRefresh.wgsl.publication,
            url:
                `${manifest.source.publicationUrl}#` +
                entry.sourceAnchor,
            anchor: entry.sourceAnchor,
            normativeManifest: relative(normativeArtifactPaths.wgsl),
        },
        requirements: currentWgslRequirements(entry, dependencies),
        expressionMode:
            coverage.classification === 'managed-first-class'
                ? 'scratch-api-and-caller-authored-wgsl'
                : 'caller-authored-wgsl',
        nativeLoweringKind: 'wgsl-compilation',
    })
}

function currentEntry({
    domain,
    entry,
    goalStart,
    coverage,
    source,
    requirements,
    expressionMode,
    nativeLoweringKind,
}) {

    const evidenceRecords = coverage.evidenceIds.map((evidenceId) => {
        const record = evidenceById.get(evidenceId)
        if (record === undefined) {
            throw new Error(`Unknown evidence id: ${evidenceId}`)
        }
        return record
    })
    if (evidenceRecords.length === 0) {
        throw new Error(`Coverage rule ${coverage.ruleId} has no evidence`)
    }
    const classification = coverage.classification
    const notApplicable = classification === 'not-applicable'
    const unresolved = classification === 'unresolved'
    const status = notApplicable
        ? 'not-applicable'
        : unresolved
            ? 'unresolved'
            : 'managed'
    const proof = resolveEntryProof({
        domain,
        entry,
        coverage,
        classification,
    })
    const rationale = coverage.rationale ?? proof.contract
    const publicSymbols = proof.publicSymbols
    const operationEvidence = proof.operationEvidence
    const sourcePaths = uniqueSorted(
        operationEvidence.map(item => item.sourcePath)
    )
    const nativeOperations = uniqueSorted(
        operationEvidence.map(item => item.operation)
    )

    return {
        id: entry.id,
        domain,
        kind: entry.kind,
        source,
        goalStart,
        coverageRule: coverage.ruleId,
        proof: proof.scope,
        current: {
            status,
            classification,
            rationale,
        },
        expression: {
            mode:
                notApplicable || unresolved
                    ? status
                    : expressionMode,
            publicSymbols:
                notApplicable || unresolved ? [] : publicSymbols,
            contract: notApplicable || unresolved
                ? rationale
                : proof.contract,
        },
        nativeLowering: {
            kind: notApplicable || unresolved
                ? 'none'
                : nativeLoweringKind,
            sourcePaths:
                notApplicable || unresolved ? [] : sourcePaths,
            operations:
                notApplicable || unresolved ? [] : nativeOperations,
            operationEvidence:
                notApplicable || unresolved ? [] : operationEvidence,
        },
        requirements,
        evidenceIds: coverage.evidenceIds,
    }
}

function resolveEntryProof({
    domain,
    entry,
    coverage,
    classification,
}) {

    const profile =
        coverage.entryProof ??
        entryProofProfiles[coverage.proofProfile]
    if (profile === undefined) {
        throw new Error(
            `Unknown entry proof profile ${coverage.proofProfile} for ${entry.id}`
        )
    }
    const semanticEquivalent =
        classification === 'managed-semantic-equivalent'
    const contract = semanticEquivalent
        ? `${entry.id}: ${profile.claim} Scratch replaces the raw member shape with an explicit locally-verifiable contract while preserving the native GPU capability without hidden state or a CPU roundtrip.`
        : `${entry.id}: ${profile.claim} The managed path remains explicit and lowers directly to the listed native operation evidence.`
    return {
        scope: proofScope(entry, coverage.proofProfile),
        contract,
        publicSymbols: [ ...profile.publicSymbols ],
        operationEvidence: profile.operationEvidence.map(item => ({
            operation: item.operation,
            sourcePath: item.sourcePath,
        })),
    }
}

function proofScope(entry, profile) {

    return {
        granularity: 'entry',
        profile,
        selector: { id: entry.id },
    }
}

const wgslAccessModeProofProfiles = Object.freeze({
    'access-mode.read': 'wgsl-binding',
    'access-mode.read_write': 'wgsl-binding',
    'access-mode.write': 'wgsl-binding',
})

const wgslAddressSpaceProofProfiles = Object.freeze({
    'address-space.function': 'wgsl-source',
    'address-space.handle': 'wgsl-binding',
    'address-space.immediate': 'wgsl-immediate',
    'address-space.private': 'wgsl-source',
    'address-space.storage': 'wgsl-binding',
    'address-space.uniform': 'wgsl-binding',
    'address-space.workgroup': 'wgsl-source',
})

const wgslAddressAndAccessSectionProofProfiles = Object.freeze({
    'semantic-section.address-space': 'wgsl-source',
    'semantic-section.memory-access-mode': 'wgsl-binding',
})

const wgslTypeSectionProofProfiles = Object.freeze({
    'semantic-section.abstract-types': 'wgsl-source',
    'semantic-section.alltypes-type': 'wgsl-source',
    'semantic-section.array-types': 'wgsl-source',
    'semantic-section.atomic-types': 'wgsl-source',
    'semantic-section.bool-type': 'wgsl-source',
    'semantic-section.buffer-types': 'wgsl-binding',
    'semantic-section.component-reference-from-vector-memory-view':
        'wgsl-source',
    'semantic-section.composite-types': 'wgsl-source',
    'semantic-section.constructible-types': 'wgsl-source',
    'semantic-section.enumeration-types': 'wgsl-source',
    'semantic-section.fixed-footprint-types': 'wgsl-source',
    'semantic-section.floating-point-types': 'wgsl-source',
    'semantic-section.host-shareable-types': 'wgsl-layout',
    'semantic-section.integer-types': 'wgsl-source',
    'semantic-section.matrix-types': 'wgsl-source',
    'semantic-section.memory-views': 'wgsl-layout',
    'semantic-section.plain-types-section': 'wgsl-source',
    'semantic-section.predeclared-types': 'wgsl-source',
    'semantic-section.ref-ptr-types': 'wgsl-source',
    'semantic-section.scalar-types': 'wgsl-source',
    'semantic-section.storable-types': 'wgsl-source',
    'semantic-section.struct-types': 'wgsl-source',
    'semantic-section.text-wgsl-media-type': 'wgsl-source',
    'semantic-section.type-aliases': 'wgsl-source',
    'semantic-section.type-checking-section': 'wgsl-source',
    'semantic-section.type-expr': 'wgsl-source',
    'semantic-section.type-specifiers': 'wgsl-source',
    'semantic-section.types': 'wgsl-source',
    'semantic-section.typing-tables-section': 'wgsl-source',
    'semantic-section.vector-types': 'wgsl-source',
})

function wgslProofProfile(entry) {

    if (entry.kind === 'enable-extension') return 'wgsl-enable'
    if (entry.kind === 'language-extension') {
        return entry.name === 'immediate_address_space'
            ? 'wgsl-immediate'
            : 'wgsl-capability'
    }
    if (entry.kind === 'access-mode') {
        return finiteWgslProofProfile(
            wgslAccessModeProofProfiles,
            entry,
            'access mode'
        )
    }
    if (entry.kind === 'address-space') {
        return finiteWgslProofProfile(
            wgslAddressSpaceProofProfiles,
            entry,
            'address space'
        )
    }
    const kindProfiles = {
        attribute: 'wgsl-pipeline-interface',
        'built-in-function': 'wgsl-source',
        'built-in-value': 'wgsl-pipeline-interface',
        'diagnostic-rule': 'wgsl-diagnostics',
        'grammar-production': 'wgsl-source',
        'interpolation-sampling': 'wgsl-pipeline-interface',
        'interpolation-type': 'wgsl-pipeline-interface',
        'texel-format': 'wgsl-texture-binding',
        'wgsl-limit': 'wgsl-capability',
    }
    if (kindProfiles[entry.kind] !== undefined) {
        return kindProfiles[entry.kind]
    }
    if (entry.kind !== 'semantic-section') {
        throw new Error(`Unresolved WGSL proof kind for ${entry.id}`)
    }
    if (
        entry.family === 'access-modes' ||
        entry.family === 'address-spaces'
    ) {
        return finiteWgslProofProfile(
            wgslAddressAndAccessSectionProofProfiles,
            entry,
            'address/access section'
        )
    }
    if (entry.family === 'types') {
        return finiteWgslProofProfile(
            wgslTypeSectionProofProfiles,
            entry,
            'type section'
        )
    }
    const familyProfiles = {
        attributes: 'wgsl-pipeline-interface',
        'built-in-functions': 'wgsl-source',
        'built-in-values': 'wgsl-pipeline-interface',
        'capability-rules': 'wgsl-capability',
        'control-flow': 'wgsl-source',
        declarations: 'wgsl-source',
        diagnostics: 'wgsl-diagnostics',
        directives: 'wgsl-source',
        'enable-extensions': 'wgsl-enable',
        'entry-points': 'wgsl-pipeline-interface',
        interpolation: 'wgsl-pipeline-interface',
        'language-extensions': 'wgsl-capability',
        'language-semantics': 'wgsl-source',
        layouts: 'wgsl-layout',
        limits: 'wgsl-capability',
        'shader-interface': 'wgsl-pipeline-interface',
        'textures-formats': 'wgsl-texture-binding',
    }
    const profile = familyProfiles[entry.family]
    if (profile === undefined) {
        throw new Error(
            `Unresolved WGSL proof family ${entry.family} for ${entry.id}`
        )
    }
    return profile
}

function finiteWgslProofProfile(profiles, entry, family) {

    const profile = profiles[entry.id]
    if (profile === undefined) {
        throw new Error(
            `Unresolved WGSL ${family} proof profile for ${entry.id}`
        )
    }
    return profile
}

function historicalEntries(manifest) {

    return new Map(manifest.entries.map(entry => [ entry.id, entry ]))
}

function historicalGoalStart(entry, historical, domain) {

    const exact = historical.get(entry.id)
    if (exact !== undefined) return exact.classification

    const declarationMatch = entry.id.match(/^interface\.([A-Za-z_]\w*)$/)
    if (declarationMatch !== null) {
        const alias = historical.get(`type.${declarationMatch[1]}`)
        if (alias !== undefined) return alias.classification
    }
    return {
        status: 'not-in-historical-baseline',
        rationale:
            `${domain} normative unit was not represented as an individual entry in the frozen historical manifest.`,
    }
}

const webGpuExactRules = Object.freeze({
    'interface.GPU': webGpuRule(
        'webgpu:gpu-interface',
        'webgpu-runtime-capabilities',
        'runtime-adapter'
    ),
    'GPU.requestAdapter': webGpuOperationRule(
        'webgpu:gpu-request-adapter',
        'webgpu-runtime-capabilities',
        'runtime-adapter',
        [
            operationProof(
                'requestAdapter',
                'packages/geoscratch/src/scratch/runtime.ts'
            ),
        ]
    ),
    'GPU.getPreferredCanvasFormat': webGpuOperationRule(
        'webgpu:preferred-canvas-format',
        'webgpu-surface-presentation',
        'surface-presentation',
        [
            operationProof(
                'getPreferredCanvasFormat',
                'packages/geoscratch/src/scratch/surface.ts'
            ),
        ]
    ),
    'GPU.wgslLanguageFeatures': webGpuRule(
        'webgpu:wgsl-language-features',
        'webgpu-runtime-capabilities',
        'runtime-wgsl-features'
    ),
    'GPUAdapter.requestDevice': webGpuOperationRule(
        'webgpu:adapter:requestDevice',
        'webgpu-runtime-capabilities',
        'runtime-adapter',
        [
            operationProof(
                'requestDevice',
                'packages/geoscratch/src/scratch/runtime.ts'
            ),
        ]
    ),
    'GPUAdapter.features': webGpuOperationRule(
        'webgpu:adapter:features',
        'webgpu-runtime-capabilities',
        'runtime-capabilities',
        [
            operationProof(
                'adapter.features',
                'packages/geoscratch/src/scratch/runtime.ts'
            ),
        ]
    ),
    'GPUAdapter.info': webGpuOperationRule(
        'webgpu:adapter:info',
        'webgpu-runtime-capabilities',
        'runtime-adapter-info',
        [
            operationProof(
                'adapterInfo',
                'packages/geoscratch/src/scratch/runtime.ts'
            ),
        ]
    ),
    'GPUAdapter.isFallbackAdapter': webGpuOperationRule(
        'webgpu:adapter:isFallbackAdapter',
        'webgpu-runtime-capabilities',
        'runtime-adapter-info',
        [
            operationProof(
                'adapterInfo',
                'packages/geoscratch/src/scratch/runtime.ts'
            ),
        ]
    ),
    'GPUAdapter.limits': webGpuOperationRule(
        'webgpu:adapter:limits',
        'webgpu-runtime-capabilities',
        'runtime-supported-limits',
        [
            operationProof(
                'adapter.limits',
                'packages/geoscratch/src/scratch/runtime.ts'
            ),
        ]
    ),
    'GPUBuffer.destroy': webGpuOperationRule(
        'webgpu:buffer:destroy',
        'webgpu-buffer-mapping',
        'buffer-resource',
        [
            operationProof(
                'destroy',
                'packages/geoscratch/src/scratch/buffer.ts'
            ),
        ]
    ),
    'GPUBuffer.getMappedRange': webGpuOperationRule(
        'webgpu:buffer:getMappedRange',
        'webgpu-buffer-mapping',
        'buffer-mapping',
        [
            operationProof(
                'getMappedRange',
                'packages/geoscratch/src/scratch/buffer-mapping.ts'
            ),
        ]
    ),
    'GPUBuffer.mapAsync': webGpuOperationRule(
        'webgpu:buffer:mapAsync',
        'webgpu-buffer-mapping',
        'buffer-mapping',
        [
            operationProof(
                'mapAsync',
                'packages/geoscratch/src/scratch/buffer-mapping.ts'
            ),
        ]
    ),
    'GPUBuffer.mapState': webGpuOperationRule(
        'webgpu:buffer:mapState',
        'webgpu-buffer-mapping',
        'buffer-mapping',
        [
            operationProof(
                'mapAsync',
                'packages/geoscratch/src/scratch/buffer-mapping.ts'
            ),
            operationProof(
                'unmap',
                'packages/geoscratch/src/scratch/buffer-mapping.ts'
            ),
        ]
    ),
    'GPUBuffer.unmap': webGpuOperationRule(
        'webgpu:buffer:unmap',
        'webgpu-buffer-mapping',
        'buffer-mapping',
        [
            operationProof(
                'unmap',
                'packages/geoscratch/src/scratch/buffer-mapping.ts'
            ),
        ]
    ),
    'GPUCanvasContext.configure': webGpuOperationRule(
        'webgpu:canvas-context:configure',
        'webgpu-surface-presentation',
        'surface-presentation',
        [
            operationProof(
                'configure',
                'packages/geoscratch/src/scratch/surface.ts'
            ),
        ]
    ),
    'GPUCanvasContext.getConfiguration': webGpuOperationRule(
        'webgpu:canvas-context:getConfiguration',
        'webgpu-surface-presentation',
        'surface-presentation',
        [
            operationProof(
                'getConfiguration',
                'packages/geoscratch/src/scratch/surface.ts'
            ),
        ]
    ),
    'GPUCanvasContext.getCurrentTexture': webGpuOperationRule(
        'webgpu:canvas-context:getCurrentTexture',
        'webgpu-surface-presentation',
        'surface-presentation',
        [
            operationProof(
                'getCurrentTexture',
                'packages/geoscratch/src/scratch/temporal-texture.ts'
            ),
        ]
    ),
    'GPUCanvasContext.unconfigure': webGpuOperationRule(
        'webgpu:canvas-context:unconfigure',
        'webgpu-surface-presentation',
        'surface-presentation',
        [
            operationProof(
                'unconfigure',
                'packages/geoscratch/src/scratch/surface.ts'
            ),
        ]
    ),
    'GPUBindingCommandsMixin.setBindGroup': webGpuRule(
        'webgpu:binding-command:setBindGroup',
        'webgpu-bindings',
        'binding-command'
    ),
    'GPUBindingCommandsMixin.setImmediates': webGpuRule(
        'webgpu:binding-command:setImmediates',
        'wgsl-immediate-data',
        'wgsl-immediate'
    ),
    'interface.GPUBindingCommandsMixin': webGpuRule(
        'webgpu:binding-command-interface',
        [ 'webgpu-bindings', 'wgsl-immediate-data' ],
        'binding-command'
    ),
    'interface.GPUCommandsMixin': webGpuRule(
        'webgpu:debug-command-interface',
        'webgpu-render-bundle-debug',
        'debug-command'
    ),
    'interface.GPURenderCommandsMixin': webGpuRule(
        'webgpu:render-command-interface',
        [ 'webgpu-pass-state', 'webgpu-pipelines' ],
        'render-command'
    ),
    'GPUCommandEncoder.beginComputePass': webGpuRule(
        'webgpu:command-encoder:beginComputePass',
        'webgpu-pass-state',
        'compute-pass'
    ),
    'GPUCommandEncoder.beginRenderPass': webGpuRule(
        'webgpu:command-encoder:beginRenderPass',
        'webgpu-pass-state',
        'render-pass'
    ),
    'GPUCommandEncoder.clearBuffer': webGpuOperationRule(
        'webgpu:command-encoder:clearBuffer',
        'webgpu-command-encoding',
        'command-encoding',
        [
            operationProof(
                'clearBuffer',
                'packages/geoscratch/src/scratch/command.ts'
            ),
        ],
        { publicSymbols: [ 'ClearBufferCommand' ] }
    ),
    'GPUCommandEncoder.finish': webGpuRule(
        'webgpu:command-encoder:finish',
        'webgpu-submission',
        'submission-command-buffer'
    ),
    'GPUCommandEncoder.resolveQuerySet': webGpuOperationRule(
        'webgpu:command-encoder:resolveQuerySet',
        'webgpu-query',
        'query',
        [
            operationProof(
                'resolveQuerySet',
                'packages/geoscratch/src/scratch/command.ts'
            ),
        ],
        {
            publicSymbols: [
                'QuerySetResource',
                'ResolveQuerySetCommand',
            ],
        }
    ),
    'GPUCommandEncoder.copyBufferToBuffer': webGpuOperationRule(
        'webgpu:command-encoder:copyBufferToBuffer',
        'webgpu-copy-upload',
        'copy-command',
        [
            operationProof(
                'copyBufferToBuffer',
                'packages/geoscratch/src/scratch/command.ts'
            ),
        ]
    ),
    'GPUCommandEncoder.copyBufferToTexture': webGpuOperationRule(
        'webgpu:command-encoder:copyBufferToTexture',
        'webgpu-copy-upload',
        'copy-command',
        [
            operationProof(
                'copyBufferToTexture',
                'packages/geoscratch/src/scratch/command.ts'
            ),
        ]
    ),
    'GPUCommandEncoder.copyTextureToBuffer': webGpuOperationRule(
        'webgpu:command-encoder:copyTextureToBuffer',
        [ 'webgpu-copy-upload', 'webgpu-readback' ],
        'copy-command',
        [
            operationProof(
                'copyTextureToBuffer',
                'packages/geoscratch/src/scratch/command.ts'
            ),
        ]
    ),
    'GPUCommandEncoder.copyTextureToTexture': webGpuOperationRule(
        'webgpu:command-encoder:copyTextureToTexture',
        'webgpu-copy-upload',
        'copy-command',
        [
            operationProof(
                'copyTextureToTexture',
                'packages/geoscratch/src/scratch/command.ts'
            ),
        ]
    ),
    'GPUComputePassDescriptor.timestampWrites': webGpuRule(
        'webgpu:compute-pass:timestampWrites',
        [ 'webgpu-pass-state', 'webgpu-query' ],
        'compute-pass-timestamp'
    ),
    'GPURenderPassDescriptor.timestampWrites': webGpuRule(
        'webgpu:render-pass:timestampWrites',
        [ 'webgpu-pass-state', 'webgpu-query' ],
        'render-pass-timestamp'
    ),
    'GPURenderPassEncoder.executeBundles': webGpuRule(
        'webgpu:render-pass:executeBundles',
        'webgpu-render-bundle-debug',
        'render-bundle-execute'
    ),
    'GPUComputePassEncoder.dispatchWorkgroups': webGpuOperationRule(
        'webgpu:compute-pass:dispatchWorkgroups',
        'webgpu-pass-state',
        'compute-pass',
        [
            operationProof(
                'dispatchWorkgroups',
                'packages/geoscratch/src/scratch/command.ts'
            ),
        ],
        { publicSymbols: [ 'DispatchCommand' ] }
    ),
    'GPUComputePassEncoder.dispatchWorkgroupsIndirect':
        webGpuOperationRule(
            'webgpu:compute-pass:dispatchWorkgroupsIndirect',
            'webgpu-pass-state',
            'compute-pass',
            [
                operationProof(
                    'dispatchWorkgroupsIndirect',
                    'packages/geoscratch/src/scratch/command.ts'
                ),
            ],
            { publicSymbols: [ 'DispatchCommand' ] }
        ),
    'GPUComputePassEncoder.end': webGpuOperationRule(
        'webgpu:compute-pass:end',
        'webgpu-pass-state',
        'compute-pass',
        [
            operationProof(
                'end',
                'packages/geoscratch/src/scratch/submission.ts'
            ),
        ]
    ),
    'GPUComputePassEncoder.setPipeline': webGpuOperationRule(
        'webgpu:compute-pass:setPipeline',
        [ 'webgpu-pass-state', 'webgpu-pipelines' ],
        'compute-pass',
        [
            operationProof(
                'setPipeline',
                'packages/geoscratch/src/scratch/command.ts'
            ),
        ],
        {
            publicSymbols: [
                'DispatchCommand',
                'ScratchComputePipeline',
            ],
        }
    ),
    'GPUDebugCommandsMixin.insertDebugMarker': webGpuOperationRule(
        'webgpu:debug-command:insertDebugMarker',
        'webgpu-render-bundle-debug',
        'debug-command',
        [
            operationProof(
                'insertDebugMarker',
                'packages/geoscratch/src/scratch/debug-command.ts'
            ),
        ]
    ),
    'GPUDebugCommandsMixin.popDebugGroup': webGpuOperationRule(
        'webgpu:debug-command:popDebugGroup',
        'webgpu-render-bundle-debug',
        'debug-command',
        [
            operationProof(
                'popDebugGroup',
                'packages/geoscratch/src/scratch/debug-command.ts'
            ),
        ]
    ),
    'GPUDebugCommandsMixin.pushDebugGroup': webGpuOperationRule(
        'webgpu:debug-command:pushDebugGroup',
        'webgpu-render-bundle-debug',
        'debug-command',
        [
            operationProof(
                'pushDebugGroup',
                'packages/geoscratch/src/scratch/debug-command.ts'
            ),
        ]
    ),
    'interface.GPUDevice': webGpuOperationRule(
        'webgpu:device:interface',
        'webgpu-runtime-capabilities',
        'runtime-device-lifecycle',
        [
            operationProof(
                'device.lost',
                'packages/geoscratch/src/scratch/runtime.ts'
            ),
        ]
    ),
    'GPUDevice.adapterInfo': webGpuOperationRule(
        'webgpu:device:adapterInfo',
        'webgpu-runtime-capabilities',
        'runtime-adapter-info',
        [
            operationProof(
                'adapterInfo',
                'packages/geoscratch/src/scratch/runtime.ts'
            ),
        ]
    ),
    'GPUDevice.features': webGpuOperationRule(
        'webgpu:device:features',
        'webgpu-runtime-capabilities',
        'runtime-capabilities',
        [
            operationProof(
                'device.features',
                'packages/geoscratch/src/scratch/runtime.ts'
            ),
        ]
    ),
    'GPUDevice.createBindGroup': webGpuRule(
        'webgpu:device:createBindGroup',
        'webgpu-bindings',
        'binding-set'
    ),
    'GPUDevice.createBindGroupLayout': webGpuRule(
        'webgpu:device:createBindGroupLayout',
        'webgpu-bindings',
        'binding-layout'
    ),
    'GPUDevice.createBuffer': webGpuRule(
        'webgpu:device:createBuffer',
        'webgpu-buffer-mapping',
        'buffer-resource'
    ),
    'GPUDevice.createCommandEncoder': webGpuOperationRule(
        'webgpu:device:createCommandEncoder',
        'webgpu-submission',
        'command-encoding',
        [
            operationProof(
                'createCommandEncoder',
                'packages/geoscratch/src/scratch/submission.ts'
            ),
        ]
    ),
    'GPUDevice.createComputePipeline': webGpuRule(
        'webgpu:device:createComputePipeline',
        'webgpu-pipelines',
        'pipeline-compute',
        'managed-semantic-equivalent'
    ),
    'GPUDevice.createComputePipelineAsync': webGpuRule(
        'webgpu:device:createComputePipelineAsync',
        'webgpu-pipelines',
        'pipeline-compute'
    ),
    'GPUDevice.createPipelineLayout': webGpuOperationRule(
        'webgpu:device:createPipelineLayout',
        'webgpu-pipelines',
        'pipeline-state',
        [
            operationProof(
                'createPipelineLayout',
                'packages/geoscratch/src/scratch/pipeline-creation.ts'
            ),
        ]
    ),
    'GPUDevice.createQuerySet': webGpuOperationRule(
        'webgpu:device:createQuerySet',
        'webgpu-query',
        'query',
        [
            operationProof(
                'createQuerySet',
                'packages/geoscratch/src/scratch/query-set.ts'
            ),
        ]
    ),
    'GPUDevice.createRenderBundleEncoder': webGpuRule(
        'webgpu:device:createRenderBundleEncoder',
        'webgpu-render-bundle-debug',
        'render-bundle-create'
    ),
    'GPUDevice.createRenderPipeline': webGpuRule(
        'webgpu:device:createRenderPipeline',
        'webgpu-pipelines',
        'pipeline-render',
        'managed-semantic-equivalent'
    ),
    'GPUDevice.createRenderPipelineAsync': webGpuRule(
        'webgpu:device:createRenderPipelineAsync',
        'webgpu-pipelines',
        'pipeline-render'
    ),
    'GPUDevice.createSampler': webGpuRule(
        'webgpu:device:createSampler',
        'webgpu-sampler',
        'sampler'
    ),
    'GPUDevice.createShaderModule': webGpuOperationRule(
        'webgpu:device:createShaderModule',
        'webgpu-shader-program',
        'shader-program',
        [
            operationProof(
                'createShaderModule',
                'packages/geoscratch/src/scratch/shader-module.ts'
            ),
        ]
    ),
    'GPUDevice.createTexture': webGpuOperationRule(
        'webgpu:device:createTexture',
        'webgpu-texture-resource',
        'texture-resource',
        [
            operationProof(
                'createTexture',
                'packages/geoscratch/src/scratch/texture.ts'
            ),
        ]
    ),
    'GPUDevice.destroy': webGpuOperationRule(
        'webgpu:device:destroy',
        'webgpu-runtime-capabilities',
        'runtime-device-lifecycle',
        [
            operationProof(
                'device.destroy',
                'packages/geoscratch/src/scratch/runtime.ts'
            ),
        ]
    ),
    'GPUDevice.importExternalTexture': webGpuRule(
        'webgpu:device:importExternalTexture',
        'webgpu-external-texture',
        'external-texture'
    ),
    'GPUDevice.limits': webGpuOperationRule(
        'webgpu:device:limits',
        'webgpu-runtime-capabilities',
        'runtime-supported-limits',
        [
            operationProof(
                'device.limits',
                'packages/geoscratch/src/scratch/runtime.ts'
            ),
        ]
    ),
    'GPUDevice.lost': webGpuRule(
        'webgpu:device:lost',
        'webgpu-runtime-capabilities',
        'runtime-device-loss'
    ),
    'GPUDevice.queue': webGpuRule(
        'webgpu:device:queue',
        'webgpu-submission',
        'submission',
        'managed-semantic-equivalent'
    ),
    'GPUDevice.onuncapturederror': webGpuOperationRule(
        'webgpu:device:onuncapturederror',
        'webgpu-diagnostics',
        'diagnostics',
        [
            operationProof(
                'uncapturederror',
                'packages/geoscratch/src/scratch/runtime-diagnostics.ts'
            ),
        ],
        { classification: 'managed-semantic-equivalent' }
    ),
    'GPUDevice.popErrorScope': webGpuOperationRule(
        'webgpu:device:popErrorScope',
        'webgpu-diagnostics',
        'diagnostics',
        [
            operationProof(
                'popErrorScope',
                'packages/geoscratch/src/scratch/supporting-object-creation.ts'
            ),
        ],
        { classification: 'managed-semantic-equivalent' }
    ),
    'GPUDevice.pushErrorScope': webGpuOperationRule(
        'webgpu:device:pushErrorScope',
        'webgpu-diagnostics',
        'diagnostics',
        [
            operationProof(
                'pushErrorScope',
                'packages/geoscratch/src/scratch/supporting-object-creation.ts'
            ),
        ],
        { classification: 'managed-semantic-equivalent' }
    ),
    'GPUQueue.copyExternalImageToTexture': webGpuRule(
        'webgpu:queue:copyExternalImageToTexture',
        'webgpu-external-image-upload',
        'external-image-copy'
    ),
    'GPUQueue.onSubmittedWorkDone': webGpuOperationRule(
        'webgpu:queue:onSubmittedWorkDone',
        'webgpu-submission',
        'submission',
        [
            operationProof(
                'onSubmittedWorkDone',
                'packages/geoscratch/src/scratch/submission.ts'
            ),
        ]
    ),
    'GPUQueue.submit': webGpuOperationRule(
        'webgpu:queue:submit',
        'webgpu-submission',
        'submission',
        [
            operationProof(
                'queue.submit',
                'packages/geoscratch/src/scratch/submission.ts'
            ),
        ]
    ),
    'GPUQueue.writeBuffer': webGpuOperationRule(
        'webgpu:queue:writeBuffer',
        'webgpu-copy-upload',
        'copy-command',
        [
            operationProof(
                'writeBuffer',
                'packages/geoscratch/src/scratch/command.ts'
            ),
        ],
        { publicSymbols: [ 'UploadCommand' ] }
    ),
    'GPUQueue.writeTexture': webGpuOperationRule(
        'webgpu:queue:writeTexture',
        'webgpu-copy-upload',
        'copy-command',
        [
            operationProof(
                'writeTexture',
                'packages/geoscratch/src/scratch/command.ts'
            ),
        ],
        { publicSymbols: [ 'TextureUploadCommand' ] }
    ),
    'GPUObjectBase.label': webGpuOperationRule(
        'webgpu:object:label',
        'webgpu-resource-lifetime',
        'resource-lifetime',
        [
            operationProof(
                'createScratchNativeLabel',
                'packages/geoscratch/src/scratch/native-allocation.ts'
            ),
        ],
        { classification: 'managed-semantic-equivalent' }
    ),
    'GPUPipelineBase.getBindGroupLayout': webGpuOperationRule(
        'webgpu:pipeline:getBindGroupLayout',
        [ 'webgpu-bindings', 'webgpu-pipelines' ],
        'binding-layout',
        [
            operationProof(
                'getBindGroupLayout',
                'packages/geoscratch/src/scratch/binding.ts'
            ),
        ],
        {
            publicSymbols: [
                'BindLayout',
                'ScratchComputePipeline',
                'ScratchRenderPipeline',
            ],
        }
    ),
    'GPUQuerySet.destroy': webGpuOperationRule(
        'webgpu:query:destroy',
        'webgpu-query',
        'query',
        [
            operationProof(
                'destroy',
                'packages/geoscratch/src/scratch/query-set.ts'
            ),
        ],
        { publicSymbols: [ 'QuerySetResource' ] }
    ),
    'GPURenderBundleEncoder.finish': webGpuOperationRule(
        'webgpu:render-bundle:finish',
        'webgpu-render-bundle-debug',
        'render-bundle',
        [
            operationProof(
                'GPURenderBundleEncoder.finish',
                'packages/geoscratch/src/scratch/render-bundle.ts'
            ),
        ]
    ),
    'GPURenderCommandsMixin.draw': webGpuOperationRule(
        'webgpu:render-command:draw',
        'webgpu-pass-state',
        'render-command',
        [
            operationProof(
                'draw',
                'packages/geoscratch/src/scratch/command.ts'
            ),
        ]
    ),
    'GPURenderCommandsMixin.drawIndexed': webGpuOperationRule(
        'webgpu:render-command:drawIndexed',
        'webgpu-pass-state',
        'render-command',
        [
            operationProof(
                'drawIndexed',
                'packages/geoscratch/src/scratch/command.ts'
            ),
        ]
    ),
    'GPURenderCommandsMixin.drawIndexedIndirect':
        webGpuOperationRule(
            'webgpu:render-command:drawIndexedIndirect',
            'webgpu-pass-state',
            'render-command',
            [
                operationProof(
                    'drawIndexedIndirect',
                    'packages/geoscratch/src/scratch/command.ts'
                ),
            ]
        ),
    'GPURenderCommandsMixin.drawIndirect': webGpuOperationRule(
        'webgpu:render-command:drawIndirect',
        'webgpu-pass-state',
        'render-command',
        [
            operationProof(
                'drawIndirect',
                'packages/geoscratch/src/scratch/command.ts'
            ),
        ]
    ),
    'GPURenderCommandsMixin.setIndexBuffer': webGpuOperationRule(
        'webgpu:render-command:setIndexBuffer',
        'webgpu-pass-state',
        'render-command',
        [
            operationProof(
                'setIndexBuffer',
                'packages/geoscratch/src/scratch/command.ts'
            ),
        ]
    ),
    'GPURenderCommandsMixin.setPipeline': webGpuOperationRule(
        'webgpu:render-command:setPipeline',
        [ 'webgpu-pass-state', 'webgpu-pipelines' ],
        'render-command',
        [
            operationProof(
                'setPipeline',
                'packages/geoscratch/src/scratch/command.ts'
            ),
        ],
        {
            publicSymbols: [
                'DrawCommand',
                'ScratchRenderPipeline',
            ],
        }
    ),
    'GPURenderCommandsMixin.setVertexBuffer': webGpuOperationRule(
        'webgpu:render-command:setVertexBuffer',
        'webgpu-pass-state',
        'render-command',
        [
            operationProof(
                'setVertexBuffer',
                'packages/geoscratch/src/scratch/command.ts'
            ),
        ]
    ),
    'GPURenderPassEncoder.beginOcclusionQuery':
        webGpuOperationRule(
            'webgpu:render-pass:beginOcclusionQuery',
            'webgpu-query',
            'query',
            [
                operationProof(
                    'beginOcclusionQuery',
                    'packages/geoscratch/src/scratch/command.ts'
                ),
            ],
            {
                publicSymbols: [
                    'BeginOcclusionQueryCommand',
                    'QuerySetResource',
                ],
            }
        ),
    'GPURenderPassEncoder.end': webGpuOperationRule(
        'webgpu:render-pass:end',
        'webgpu-pass-state',
        'render-pass',
        [
            operationProof(
                'end',
                'packages/geoscratch/src/scratch/submission.ts'
            ),
        ]
    ),
    'GPURenderPassEncoder.endOcclusionQuery':
        webGpuOperationRule(
            'webgpu:render-pass:endOcclusionQuery',
            'webgpu-query',
            'query',
            [
                operationProof(
                    'endOcclusionQuery',
                    'packages/geoscratch/src/scratch/command.ts'
                ),
            ],
            { publicSymbols: [ 'EndOcclusionQueryCommand' ] }
        ),
    'GPURenderPassEncoder.setBlendConstant': webGpuOperationRule(
        'webgpu:render-pass:setBlendConstant',
        'webgpu-pass-state',
        'render-pass',
        [
            operationProof(
                'setBlendConstant',
                'packages/geoscratch/src/scratch/command.ts'
            ),
        ]
    ),
    'GPURenderPassEncoder.setScissorRect': webGpuOperationRule(
        'webgpu:render-pass:setScissorRect',
        'webgpu-pass-state',
        'render-pass',
        [
            operationProof(
                'setScissorRect',
                'packages/geoscratch/src/scratch/command.ts'
            ),
        ]
    ),
    'GPURenderPassEncoder.setStencilReference':
        webGpuOperationRule(
            'webgpu:render-pass:setStencilReference',
            'webgpu-pass-state',
            'render-pass',
            [
                operationProof(
                    'setStencilReference',
                    'packages/geoscratch/src/scratch/command.ts'
                ),
            ]
        ),
    'GPURenderPassEncoder.setViewport': webGpuOperationRule(
        'webgpu:render-pass:setViewport',
        'webgpu-pass-state',
        'render-pass',
        [
            operationProof(
                'setViewport',
                'packages/geoscratch/src/scratch/command.ts'
            ),
        ]
    ),
    'GPUShaderModule.getCompilationInfo': webGpuOperationRule(
        'webgpu:shader-module:getCompilationInfo',
        'webgpu-shader-program',
        'shader-program',
        [
            operationProof(
                'getCompilationInfo',
                'packages/geoscratch/src/scratch/shader-module.ts'
            ),
        ]
    ),
    'GPUTexture.createView': webGpuOperationRule(
        'webgpu:texture:createView',
        'webgpu-texture-resource',
        'texture-resource',
        [
            operationProof(
                'GPUTexture.createView',
                'packages/geoscratch/src/scratch/texture.ts'
            ),
        ]
    ),
    'GPUTexture.destroy': webGpuOperationRule(
        'webgpu:texture:destroy',
        'webgpu-texture-resource',
        'texture-resource',
        [
            operationProof(
                'destroy',
                'packages/geoscratch/src/scratch/texture.ts'
            ),
        ]
    ),
    'GPUInternalError.constructor': webGpuOperationRule(
        'webgpu:diagnostics:internal-error-constructor',
        'webgpu-diagnostics',
        'diagnostics',
        [
            operationProof(
                'serializeNativeGpuError',
                'packages/geoscratch/src/scratch/gpu-operation.ts'
            ),
        ],
        { classification: 'managed-semantic-equivalent' }
    ),
    'GPUOutOfMemoryError.constructor': webGpuOperationRule(
        'webgpu:diagnostics:out-of-memory-error-constructor',
        'webgpu-diagnostics',
        'diagnostics',
        [
            operationProof(
                'serializeNativeGpuError',
                'packages/geoscratch/src/scratch/gpu-operation.ts'
            ),
        ],
        { classification: 'managed-semantic-equivalent' }
    ),
    'GPUPipelineError.constructor': webGpuOperationRule(
        'webgpu:diagnostics:pipeline-error-constructor',
        'webgpu-diagnostics',
        'diagnostics',
        [
            operationProof(
                'serializeNativeGpuError',
                'packages/geoscratch/src/scratch/gpu-operation.ts'
            ),
        ],
        { classification: 'managed-semantic-equivalent' }
    ),
    'GPUUncapturedErrorEvent.constructor': webGpuOperationRule(
        'webgpu:diagnostics:uncaptured-error-event-constructor',
        'webgpu-diagnostics',
        'diagnostics',
        [
            operationProof(
                'serializeNativeGpuError',
                'packages/geoscratch/src/scratch/gpu-operation.ts'
            ),
        ],
        { classification: 'managed-semantic-equivalent' }
    ),
    'GPUValidationError.constructor': webGpuOperationRule(
        'webgpu:diagnostics:validation-error-constructor',
        'webgpu-diagnostics',
        'diagnostics',
        [
            operationProof(
                'serializeNativeGpuError',
                'packages/geoscratch/src/scratch/gpu-operation.ts'
            ),
        ],
        { classification: 'managed-semantic-equivalent' }
    ),
    'interface.GPUCommandBuffer': webGpuRule(
        'webgpu:submission:command-buffer',
        'webgpu-submission',
        'submission-command-buffer',
        'managed-semantic-equivalent'
    ),
    'interface.GPUCommandBufferDescriptor': webGpuRule(
        'webgpu:submission:command-buffer',
        'webgpu-submission',
        'submission-command-buffer',
        'managed-semantic-equivalent'
    ),
    'interface.GPUVertexBufferLayout': webGpuRule(
        'webgpu:pipeline:vertex-buffer-layout',
        'webgpu-pipelines',
        'pipeline-vertex-buffer-layout'
    ),
    'interface.GPUTexelCopyTextureInfo': webGpuRule(
        'webgpu:copy:texture-info',
        'webgpu-copy-upload',
        'copy-texture-info'
    ),
    'interface.GPUSupportedLimits': webGpuRule(
        'webgpu:runtime:supported-limits',
        'webgpu-runtime-capabilities',
        'runtime-supported-limits',
        'managed-semantic-equivalent'
    ),
})

const webGpuOwnerRules = createWebGpuOwnerRules([
    webGpuOwnerRule(
        [
            'GPUAdapter',
            'GPUFeatureName',
            'GPUSupportedFeatures',
        ],
        'webgpu:runtime-capability',
        'webgpu-runtime-capabilities',
        'runtime-capabilities'
    ),
    webGpuOwnerRule(
        [ 'GPUAdapterInfo' ],
        'webgpu:runtime-adapter-info',
        'webgpu-runtime-capabilities',
        'runtime-adapter-info'
    ),
    webGpuOwnerRule(
        [ 'NavigatorGPU' ],
        'webgpu:navigator-gpu',
        'webgpu-runtime-capabilities',
        'runtime-request-adapter'
    ),
    webGpuOwnerRule(
        [ 'WGSLLanguageFeatures' ],
        'webgpu:wgsl-language-features',
        'webgpu-runtime-capabilities',
        'runtime-wgsl-features'
    ),
    webGpuOwnerRule(
        [
            'GPUDeviceDescriptor',
            'GPUQueueDescriptor',
        ],
        'webgpu:runtime-device-request',
        'webgpu-runtime-capabilities',
        'runtime-request-device'
    ),
    webGpuOwnerRule(
        [
            'GPUPowerPreference',
            'GPURequestAdapterOptions',
        ],
        'webgpu:runtime-adapter-request',
        'webgpu-runtime-capabilities',
        'runtime-request-adapter'
    ),
    webGpuOwnerRule(
        [ 'GPUDeviceLostInfo', 'GPUDeviceLostReason' ],
        'webgpu:runtime-device-loss',
        'webgpu-runtime-capabilities',
        'runtime-device-loss'
    ),
    webGpuOwnerRule(
        [ 'GPUSupportedLimits' ],
        'webgpu:runtime-supported-limits',
        'webgpu-runtime-capabilities',
        'runtime-supported-limits'
    ),
    webGpuOwnerRule(
        [
            'GPUCanvasAlphaMode',
            'GPUCanvasConfiguration',
            'GPUCanvasToneMapping',
            'GPUCanvasToneMappingMode',
        ],
        'webgpu:surface-configuration',
        'webgpu-surface-presentation',
        'surface-configuration'
    ),
    webGpuOwnerRule(
        [ 'GPUCanvasContext' ],
        'webgpu:surface-context',
        'webgpu-surface-presentation',
        'surface-presentation'
    ),
    webGpuOwnerRule(
        [ 'GPUObjectBase', 'GPUObjectDescriptorBase' ],
        'webgpu:object-lifecycle',
        'webgpu-resource-lifetime',
        'resource-lifetime'
    ),
    webGpuOwnerRule(
        [
            'GPUBuffer',
            'GPUBufferDescriptor',
            'GPUBufferUsage',
            'GPUBufferUsageFlags',
        ],
        'webgpu:buffer-resource',
        'webgpu-buffer-mapping',
        'buffer-resource'
    ),
    webGpuOwnerRule(
        [ 'GPUBufferDynamicOffset' ],
        'webgpu:binding-command:dynamic-offset',
        'webgpu-bindings',
        'binding-command'
    ),
    webGpuOwnerRule(
        [ 'GPUBufferMapState', 'GPUMapMode', 'GPUMapModeFlags' ],
        'webgpu:buffer-mapping',
        'webgpu-buffer-mapping',
        'buffer-mapping'
    ),
    webGpuOwnerRule(
        [
            'GPUBindGroup',
            'GPUBindGroupDescriptor',
            'GPUBindGroupEntry',
            'GPUBindingResource',
            'GPUBufferBinding',
        ],
        'webgpu:binding-set',
        'webgpu-bindings',
        'binding-set'
    ),
    webGpuOwnerRule(
        [
            'GPUBindGroupLayout',
            'GPUBindGroupLayoutDescriptor',
            'GPUBindGroupLayoutEntry',
            'GPUBufferBindingLayout',
            'GPUBufferBindingType',
            'GPUExternalTextureBindingLayout',
            'GPUSamplerBindingLayout',
            'GPUSamplerBindingType',
            'GPUShaderStage',
            'GPUShaderStageFlags',
            'GPUStorageTextureAccess',
            'GPUStorageTextureBindingLayout',
            'GPUTextureBindingLayout',
            'GPUTextureSampleType',
        ],
        'webgpu:binding-layout',
        'webgpu-bindings',
        'binding-layout'
    ),
    webGpuOwnerRule(
        [
            'GPUTexture',
            'GPUTextureDescriptor',
            'GPUTextureDimension',
            'GPUTextureFormat',
            'GPUTextureUsage',
            'GPUTextureUsageFlags',
        ],
        'webgpu:texture-allocation',
        'webgpu-texture-resource',
        'texture-allocation'
    ),
    webGpuOwnerRule(
        [
            'GPUTextureAspect',
            'GPUTextureView',
            'GPUTextureViewDescriptor',
            'GPUTextureViewDimension',
        ],
        'webgpu:texture-view',
        'webgpu-texture-resource',
        'texture-view'
    ),
    webGpuOwnerRule(
        [
            'GPUAddressMode',
            'GPUFilterMode',
            'GPUMipmapFilterMode',
            'GPUSampler',
            'GPUSamplerDescriptor',
        ],
        'webgpu:sampler',
        'webgpu-sampler',
        'sampler'
    ),
    webGpuOwnerRule(
        [
            'GPUAutoLayoutMode',
            'GPUPipelineBase',
            'GPUPipelineConstantValue',
            'GPUPipelineDescriptorBase',
            'GPUProgrammableStage',
        ],
        'webgpu:pipeline-state',
        'webgpu-pipelines',
        'pipeline-state'
    ),
    webGpuOwnerRule(
        [ 'GPUPipelineLayout', 'GPUPipelineLayoutDescriptor' ],
        'webgpu:pipeline-layout',
        'webgpu-pipelines',
        'pipeline-layout'
    ),
    webGpuOwnerRule(
        [
            'GPUComputePipeline',
            'GPUComputePipelineDescriptor',
        ],
        'webgpu:compute-pipeline-state',
        'webgpu-pipelines',
        'pipeline-compute'
    ),
    webGpuOwnerRule(
        [
            'GPUBlendComponent',
            'GPUBlendFactor',
            'GPUBlendOperation',
            'GPUBlendState',
            'GPUColorTargetState',
            'GPUColorWrite',
            'GPUColorWriteFlags',
            'GPUCullMode',
            'GPUDepthBias',
            'GPUDepthStencilState',
            'GPUFragmentState',
            'GPUFrontFace',
            'GPUMultisampleState',
            'GPUPrimitiveState',
            'GPUPrimitiveTopology',
            'GPURenderPipeline',
            'GPURenderPipelineDescriptor',
            'GPUSampleMask',
            'GPUStencilFaceState',
            'GPUStencilOperation',
            'GPUStencilValue',
            'GPUVertexAttribute',
            'GPUVertexBufferLayout',
            'GPUVertexFormat',
            'GPUVertexState',
            'GPUVertexStepMode',
        ],
        'webgpu:render-pipeline-state',
        'webgpu-pipelines',
        'pipeline-render'
    ),
    webGpuOwnerRule(
        [ 'GPUCompareFunction' ],
        'webgpu:compare-function',
        [ 'webgpu-pipelines', 'webgpu-sampler' ],
        'pipeline-compare-function'
    ),
    webGpuOwnerRule(
        [
            'GPUColor',
            'GPUColorDict',
            'GPUIndex32',
            'GPUIndexFormat',
            'GPULoadOp',
            'GPURenderPassColorAttachment',
            'GPURenderPassDepthStencilAttachment',
            'GPURenderPassDescriptor',
            'GPURenderPassEncoder',
            'GPURenderPassLayout',
            'GPUStoreOp',
        ],
        'webgpu:render-pass',
        'webgpu-pass-state',
        'render-pass'
    ),
    webGpuOwnerRule(
        [ 'GPUComputePassDescriptor', 'GPUComputePassEncoder' ],
        'webgpu:compute-pass',
        'webgpu-pass-state',
        'compute-pass'
    ),
    webGpuOwnerRule(
        [
            'GPUQuerySet',
            'GPUQuerySetDescriptor',
            'GPUQueryType',
        ],
        'webgpu:query-create',
        'webgpu-query',
        'query-create'
    ),
    webGpuOwnerRule(
        [ 'GPUComputePassTimestampWrites' ],
        'webgpu:compute-pass-timestamp',
        [ 'webgpu-pass-state', 'webgpu-query' ],
        'compute-pass-timestamp'
    ),
    webGpuOwnerRule(
        [ 'GPURenderPassTimestampWrites' ],
        'webgpu:render-pass-timestamp',
        [ 'webgpu-pass-state', 'webgpu-query' ],
        'render-pass-timestamp'
    ),
    webGpuOwnerRule(
        [
            'GPUShaderModule',
            'GPUShaderModuleCompilationHint',
            'GPUShaderModuleDescriptor',
        ],
        'webgpu:shader-module-create',
        'webgpu-shader-program',
        'shader-module-create'
    ),
    webGpuOwnerRule(
        [
            'GPUCompilationInfo',
            'GPUCompilationMessage',
            'GPUCompilationMessageType',
        ],
        'webgpu:shader-compilation-info',
        'webgpu-shader-program',
        'shader-compilation-info'
    ),
    webGpuOwnerRule(
        [
            'GPUCommandBuffer',
            'GPUCommandBufferDescriptor',
        ],
        'webgpu:command-buffer',
        'webgpu-submission',
        'submission-command-buffer'
    ),
    webGpuOwnerRule(
        [
            'GPUCommandEncoder',
            'GPUCommandEncoderDescriptor',
        ],
        'webgpu:command-encoder-create',
        'webgpu-submission',
        'command-encoder-create'
    ),
    webGpuOwnerRule(
        [
            'GPUExtent3D',
            'GPUExtent3DDict',
            'GPUOrigin2D',
            'GPUOrigin2DDict',
            'GPUOrigin3D',
            'GPUOrigin3DDict',
            'GPUTexelCopyTextureInfo',
        ],
        'webgpu:copy-texture-info',
        'webgpu-copy-upload',
        'copy-texture-info'
    ),
    webGpuOwnerRule(
        [
            'GPUTexelCopyBufferInfo',
            'GPUTexelCopyBufferLayout',
        ],
        'webgpu:copy-buffer-info',
        'webgpu-copy-upload',
        'copy-buffer-info'
    ),
    webGpuOwnerRule(
        [
            'GPUCopyExternalImageDestInfo',
            'GPUCopyExternalImageSource',
            'GPUCopyExternalImageSourceInfo',
        ],
        'webgpu:external-image-copy',
        'webgpu-external-image-upload',
        'external-image-copy'
    ),
    webGpuOwnerRule(
        [
            'GPUExternalTexture',
            'GPUExternalTextureDescriptor',
        ],
        'webgpu:external-texture',
        'webgpu-external-texture',
        'external-texture'
    ),
    webGpuOwnerRule(
        [
            'GPURenderBundle',
            'GPURenderBundleDescriptor',
        ],
        'webgpu:render-bundle-finish',
        'webgpu-render-bundle-debug',
        'render-bundle-finish'
    ),
    webGpuOwnerRule(
        [
            'GPURenderBundleEncoder',
            'GPURenderBundleEncoderDescriptor',
        ],
        'webgpu:render-bundle-create',
        'webgpu-render-bundle-debug',
        'render-bundle-create'
    ),
    webGpuOwnerRule(
        [ 'GPUCommandsMixin', 'GPUDebugCommandsMixin' ],
        'webgpu:debug-command',
        'webgpu-render-bundle-debug',
        'debug-command'
    ),
    webGpuOwnerRule(
        [ 'GPURenderCommandsMixin' ],
        'webgpu:render-command',
        'webgpu-pass-state',
        'render-command'
    ),
    webGpuOwnerRule(
        [ 'GPUBindingCommandsMixin' ],
        'webgpu:binding-command',
        'webgpu-bindings',
        'binding-command'
    ),
    webGpuOwnerRule(
        [ 'GPUQueue' ],
        'webgpu:submission',
        'webgpu-submission',
        'submission'
    ),
    webGpuOwnerRule(
        [ 'GPUErrorFilter' ],
        'webgpu:error-scope-filter',
        'webgpu-diagnostics',
        'diagnostics'
    ),
    webGpuOwnerRule(
        [
            'GPUError',
            'GPUInternalError',
            'GPUOutOfMemoryError',
            'GPUPipelineError',
            'GPUPipelineErrorInit',
            'GPUPipelineErrorReason',
            'GPUUncapturedErrorEvent',
            'GPUUncapturedErrorEventInit',
            'GPUValidationError',
        ],
        'webgpu:diagnostic-error-facts',
        'webgpu-diagnostics',
        'diagnostic-error-facts'
    ),
    webGpuOwnerRule(
        [
            'GPUFlagsConstant',
            'GPUIntegerCoordinate',
            'GPUIntegerCoordinateOut',
            'GPUSignedOffset32',
            'GPUSize32',
            'GPUSize32Out',
            'GPUSize64',
            'GPUSize64Out',
        ],
        'webgpu:numeric-domain',
        'webgpu-numeric-domains',
        'numeric-domain'
    ),
])

const normativeWebGpuEntriesById = new Map(
    readJson(normativeArtifactPaths.webgpu).entries.map(entry => [
        entry.id,
        entry,
    ])
)

export function classifyWebGpuEntry(entry) {

    return webGpuCoverage(entry)
}

export function classifyWgslEntry(entry) {

    return {
        ...wgslCoverage(entry),
        proofProfile: wgslProofProfile(entry),
    }
}

export function hasWebGpuOwnerRule(owner) {

    return webGpuOwnerRules.has(owner)
}

export function hasWebGpuExactRule(id) {

    return webGpuExactRules[id] !== undefined
}

function webGpuCoverage(entry) {

    const canonical = normativeWebGpuEntriesById.get(entry?.id)
    if (canonical === undefined) {
        throw new Error(`Unknown WebGPU normative entry ${entry?.id}`)
    }
    for (const field of [ 'kind', 'owner', 'member' ]) {
        if (entry[field] !== canonical[field]) {
            throw new Error(
                `${entry.id} ${field} does not match the normative inventory`
            )
        }
    }
    entry = canonical
    if (entry.kind === 'includes') {
        const includeRules = {
            GPUObjectBase: webGpuRule(
                'webgpu:include:object-lifecycle',
                'webgpu-resource-lifetime',
                'resource-lifetime',
                'managed-semantic-equivalent'
            ),
            GPUCommandsMixin: webGpuRule(
                'webgpu:include:debug-commands',
                'webgpu-render-bundle-debug',
                'debug-command',
                'managed-semantic-equivalent'
            ),
            GPUDebugCommandsMixin: webGpuRule(
                'webgpu:include:debug-commands',
                'webgpu-render-bundle-debug',
                'debug-command',
                'managed-semantic-equivalent'
            ),
            GPUBindingCommandsMixin: webGpuRule(
                'webgpu:include:binding-commands',
                [ 'webgpu-bindings', 'wgsl-immediate-data' ],
                'binding-command',
                'managed-semantic-equivalent'
            ),
            GPUPipelineBase: webGpuRule(
                'webgpu:include:pipeline-base',
                'webgpu-pipelines',
                'pipeline-state',
                'managed-semantic-equivalent'
            ),
            GPURenderCommandsMixin: webGpuRule(
                'webgpu:include:render-commands',
                [ 'webgpu-pass-state', 'webgpu-pipelines' ],
                'render-command',
                'managed-semantic-equivalent'
            ),
        }[entry.member]
        if (includeRules !== undefined) {
            return coverageFromWebGpuRule(includeRules)
        }
        if (entry.member === 'NavigatorGPU') {
            return coverageRule(
                'webgpu:include:navigator-integration',
                'webidl-non-capability',
                'not-applicable',
                'Navigator and WorkerNavigator mixin composition is host DOM integration; ScratchRuntime owns adapter acquisition without exposing DOM composition as a workload capability.',
                'runtime-adapter'
            )
        }
        throw new Error(`Unresolved WebGPU include rule for ${entry.id}`)
    }
    if (entry.kind === 'collection') {
        if (
            entry.owner !== 'GPUSupportedFeatures' &&
            entry.owner !== 'WGSLLanguageFeatures'
        ) {
            throw new Error(
                `Unresolved WebGPU collection rule for ${entry.id}`
            )
        }
        return coverageFromWebGpuRule(webGpuRule(
            'webgpu:capability-collection',
            'webgpu-runtime-capabilities',
            'runtime-capabilities',
            'managed-semantic-equivalent'
        ))
    }

    const exact = webGpuExactRules[entry.id]
    if (exact !== undefined) return coverageFromWebGpuRule(exact)

    const owner = webGpuOwnerRules.get(entry.owner)
    if (owner !== undefined) return coverageFromWebGpuRule(owner)

    throw new Error(`Unresolved WebGPU coverage rule for ${entry.id}`)
}

const wgslProofProfileCoverage = Object.freeze({
    'wgsl-binding': Object.freeze({
        evidenceIds: Object.freeze([
            'wgsl-caller-authored-source',
            'webgpu-bindings',
            'webgpu-shader-program',
        ]),
        classification: 'managed-first-class',
    }),
    'wgsl-immediate': Object.freeze({
        evidenceIds: Object.freeze([
            'wgsl-caller-authored-source',
            'wgsl-immediate-data',
            'webgpu-pipelines',
        ]),
        classification: 'managed-first-class',
    }),
    'wgsl-layout': Object.freeze({
        evidenceIds: Object.freeze([
            'wgsl-caller-authored-source',
            'wgsl-recursive-layout',
            'webgpu-bindings',
        ]),
        classification: 'managed-first-class',
    }),
    'wgsl-source': Object.freeze({
        evidenceIds: Object.freeze([
            'wgsl-caller-authored-source',
            'webgpu-shader-program',
        ]),
        classification: 'managed-semantic-equivalent',
    }),
})

function wgslCoverageFromProofProfile(entry, ruleId) {

    const profile = wgslProofProfile(entry)
    const coverage = wgslProofProfileCoverage[profile]
    if (coverage === undefined) {
        throw new Error(
            `No WGSL coverage contract for proof profile ${profile}`
        )
    }
    return coverageRule(
        ruleId,
        coverage.evidenceIds,
        coverage.classification
    )
}

function wgslCoverage(entry) {

    if (entry.kind === 'enable-extension') {
        return coverageRule(
            'wgsl:enable-extension',
            [
                'wgsl-enable-contract',
                'webgpu-runtime-capabilities',
                'webgpu-shader-program',
            ],
            'managed-semantic-equivalent'
        )
    }
    if (entry.kind === 'language-extension') {
        if (entry.name === 'immediate_address_space') {
            return coverageRule(
                'wgsl:language-extension:immediate-data',
                [
                    'wgsl-language-contract',
                    'wgsl-immediate-data',
                    'webgpu-runtime-capabilities',
                ],
                'managed-first-class'
            )
        }
        return coverageRule(
            'wgsl:language-extension',
            [
                'wgsl-language-contract',
                'webgpu-runtime-capabilities',
                'webgpu-shader-program',
            ],
            'managed-semantic-equivalent'
        )
    }
    if (
        entry.kind === 'access-mode' ||
        entry.kind === 'address-space'
    ) {
        return wgslCoverageFromProofProfile(
            entry,
            `wgsl:${entry.kind}:${entry.id}`
        )
    }

    const kindRules = {
        attribute: [
            'wgsl:attribute',
            [
                'wgsl-caller-authored-source',
                'webgpu-shader-program',
                'webgpu-bindings',
                'webgpu-pipelines',
                'wgsl-recursive-layout',
            ],
            'managed-semantic-equivalent',
        ],
        'built-in-function': [
            'wgsl:built-in-function',
            [
                'wgsl-caller-authored-source',
                'webgpu-shader-program',
            ],
            'managed-semantic-equivalent',
        ],
        'built-in-value': [
            'wgsl:built-in-value',
            [
                'wgsl-caller-authored-source',
                'webgpu-shader-program',
                'webgpu-pipelines',
            ],
            'managed-semantic-equivalent',
        ],
        'diagnostic-rule': [
            'wgsl:diagnostic-rule',
            [
                'wgsl-caller-authored-source',
                'webgpu-shader-program',
                'webgpu-diagnostics',
            ],
            'managed-first-class',
        ],
        'grammar-production': [
            'wgsl:grammar-production',
            [
                'wgsl-caller-authored-source',
                'webgpu-shader-program',
            ],
            'managed-semantic-equivalent',
        ],
        'interpolation-sampling': [
            'wgsl:interpolation-sampling',
            [
                'wgsl-caller-authored-source',
                'webgpu-shader-program',
                'webgpu-pipelines',
            ],
            'managed-first-class',
        ],
        'interpolation-type': [
            'wgsl:interpolation-type',
            [
                'wgsl-caller-authored-source',
                'webgpu-shader-program',
                'webgpu-pipelines',
            ],
            'managed-first-class',
        ],
        'texel-format': [
            'wgsl:texel-format',
            [
                'wgsl-caller-authored-source',
                'webgpu-shader-program',
                'webgpu-bindings',
                'webgpu-texture-resource',
            ],
            'managed-first-class',
        ],
        'wgsl-limit': [
            'wgsl:limit',
            [
                'wgsl-caller-authored-source',
                'webgpu-runtime-capabilities',
                'webgpu-shader-program',
            ],
            'managed-first-class',
        ],
    }[entry.kind]
    if (kindRules !== undefined) {
        return coverageRule(
            kindRules[0],
            kindRules[1],
            kindRules[2]
        )
    }
    if (entry.kind !== 'semantic-section') {
        throw new Error(`Unresolved WGSL kind for ${entry.id}`)
    }
    if (
        entry.family === 'access-modes' ||
        entry.family === 'address-spaces' ||
        entry.family === 'types'
    ) {
        return wgslCoverageFromProofProfile(
            entry,
            `wgsl:semantic-section:${entry.id}`
        )
    }

    const familyRules = {
        attributes: [
            [ 'wgsl-caller-authored-source', 'webgpu-shader-program', 'webgpu-bindings', 'webgpu-pipelines' ],
            'managed-semantic-equivalent',
        ],
        'built-in-functions': [
            [ 'wgsl-caller-authored-source', 'webgpu-shader-program' ],
            'managed-semantic-equivalent',
        ],
        'built-in-values': [
            [ 'wgsl-caller-authored-source', 'webgpu-shader-program', 'webgpu-pipelines' ],
            'managed-semantic-equivalent',
        ],
        'capability-rules': [
            [ 'wgsl-caller-authored-source', 'webgpu-runtime-capabilities', 'webgpu-shader-program' ],
            'managed-first-class',
        ],
        'control-flow': [
            [ 'wgsl-caller-authored-source', 'webgpu-shader-program' ],
            'managed-semantic-equivalent',
        ],
        declarations: [
            [ 'wgsl-caller-authored-source', 'webgpu-shader-program' ],
            'managed-semantic-equivalent',
        ],
        diagnostics: [
            [ 'wgsl-caller-authored-source', 'webgpu-shader-program', 'webgpu-diagnostics' ],
            'managed-first-class',
        ],
        directives: [
            [ 'wgsl-caller-authored-source', 'webgpu-shader-program' ],
            'managed-semantic-equivalent',
        ],
        'enable-extensions': [
            [ 'wgsl-enable-contract', 'webgpu-runtime-capabilities', 'webgpu-shader-program' ],
            'managed-semantic-equivalent',
        ],
        'entry-points': [
            [ 'wgsl-caller-authored-source', 'webgpu-shader-program', 'webgpu-pipelines', 'webgpu-bindings' ],
            'managed-first-class',
        ],
        interpolation: [
            [ 'wgsl-caller-authored-source', 'webgpu-shader-program', 'webgpu-pipelines' ],
            'managed-first-class',
        ],
        'language-extensions': [
            [ 'wgsl-language-contract', 'webgpu-runtime-capabilities', 'webgpu-shader-program' ],
            'managed-semantic-equivalent',
        ],
        'language-semantics': [
            [ 'wgsl-caller-authored-source', 'webgpu-shader-program' ],
            'managed-semantic-equivalent',
        ],
        layouts: [
            [ 'wgsl-caller-authored-source', 'wgsl-recursive-layout', 'webgpu-bindings' ],
            'managed-first-class',
        ],
        limits: [
            [ 'wgsl-caller-authored-source', 'webgpu-runtime-capabilities', 'webgpu-shader-program' ],
            'managed-first-class',
        ],
        'shader-interface': [
            [ 'wgsl-caller-authored-source', 'webgpu-shader-program', 'webgpu-pipelines', 'webgpu-bindings' ],
            'managed-first-class',
        ],
        'textures-formats': [
            [ 'wgsl-caller-authored-source', 'webgpu-shader-program', 'webgpu-bindings', 'webgpu-texture-resource' ],
            'managed-first-class',
        ],
    }[entry.family]
    if (familyRules === undefined) {
        throw new Error(
            `Unresolved WGSL semantic family ${entry.family} for ${entry.id}`
        )
    }
    return coverageRule(
        `wgsl:semantic-section:${entry.family}`,
        familyRules[0],
        familyRules[1]
    )
}

const normalizedRequirementKeys = Object.freeze([
    'conditions',
    'dependencies',
    'deviceFeatures',
    'enableExtensions',
    'languageFeatures',
    'limits',
    'policy',
])

const wgslRequirementSourceKeys = Object.freeze(
    normalizedRequirementKeys.filter(key => key !== 'policy')
)

const requirementConditionKeys = Object.freeze([
    'dependencies',
    'deviceFeatureAlternatives',
    'deviceFeatures',
    'languageFeatures',
    'limits',
    'when',
])

export function assertWgslRequirementSource(source, entryId) {

    if (
        source === null ||
        typeof source !== 'object' ||
        Array.isArray(source)
    ) {
        throw new TypeError(`${entryId} WGSL requirements must be an object`)
    }
    assertExactObjectKeys(
        source,
        wgslRequirementSourceKeys,
        `${entryId}.requirements`
    )
    for (const key of wgslRequirementSourceKeys) {
        if (
            source[key] !== undefined &&
            !Array.isArray(source[key])
        ) {
            throw new TypeError(
                `${entryId}.requirements.${key} must be an array`
            )
        }
    }
    for (
        let conditionIndex = 0;
        conditionIndex < (source.conditions?.length ?? 0);
        conditionIndex += 1
    ) {
        const condition = source.conditions[conditionIndex]
        const location =
            `${entryId}.requirements.conditions[${conditionIndex}]`
        if (
            condition === null ||
            typeof condition !== 'object' ||
            Array.isArray(condition)
        ) {
            throw new TypeError(`${location} must be an object`)
        }
        assertExactObjectKeys(
            condition,
            requirementConditionKeys,
            location
        )
    }
    return source
}

function currentWgslRequirements(entry, dependencyManifest) {

    const source = entry.requirements
    assertWgslRequirementSource(source, entry.id)
    const enableExtensions = [ ...(source.enableExtensions ?? []) ]
    const deviceFeatures = [ ...(source.deviceFeatures ?? []) ]
    const languageFeatures = [ ...(source.languageFeatures ?? []) ]
    const limits = [ ...(source.limits ?? []) ]
    const dependencyIds = (source.dependencies ?? []).map(dependency =>
        resolveDependencyId(dependency, dependencyManifest, entry.id)
    )
    const conditions = [ ...(source.conditions ?? []) ]

    for (const dependency of dependencyManifest.entries) {
        if (
            dependency.kind === 'caller-declared-companion' &&
            enableExtensions.includes(dependency.extension)
        ) {
            enableExtensions.push(dependency.requiredExtension)
            deviceFeatures.push(
                dependency.feature,
                dependency.requiredFeature
            )
            dependencyIds.push(dependency.id)
        } else if (
            dependency.kind === 'language-to-device-prerequisite' &&
            languageFeatures.includes(dependency.languageFeature)
        ) {
            deviceFeatures.push(dependency.requiredFeature)
            dependencyIds.push(dependency.id)
        } else if (
            dependency.kind === 'language-to-enable-prerequisite' &&
            languageFeatures.includes(dependency.languageFeature)
        ) {
            enableExtensions.push(
                dependency.requiredEnableExtension
            )
            dependencyIds.push(dependency.id)
        }
    }

    const requirements = {
        enableExtensions: uniqueSorted(enableExtensions),
        deviceFeatures: uniqueSorted(deviceFeatures),
        languageFeatures: uniqueSorted(languageFeatures),
        limits: uniqueSorted(limits),
        dependencies: uniqueSorted(dependencyIds),
        conditions: normalizeRequirementConditions(
            conditions,
            dependencyManifest,
            entry.id
        ),
        policy:
            'Caller-authored WGSL is preserved verbatim; enable extensions, language features, device features, limits, and companion requirements remain explicit Program and Runtime facts.',
    }
    assertCoverageRequirements(requirements, entry.id)
    return requirements
}

function webGpuRequirements(entry, dependencyManifest) {

    const deviceFeatures = []
    const languageFeatures = []
    const limits =
        entry.owner === 'GPUSupportedLimits' &&
        entry.kind === 'property' &&
        typeof entry.member === 'string'
        ? [ entry.member ]
        : []
    const conditions = []
    const id = entry.id

    if (id === 'GPUPrimitiveState.unclippedDepth') {
        conditions.push(requirementCondition(
            'unclippedDepth is true',
            [ 'depth-clip-control' ]
        ))
    }
    if (
        id === 'GPUComputePassDescriptor.timestampWrites' ||
        id === 'GPURenderPassDescriptor.timestampWrites'
    ) {
        conditions.push(requirementCondition(
            'timestampWrites is provided',
            [ 'timestamp-query' ]
        ))
    }
    if (
        entry.owner === 'GPUComputePassTimestampWrites' ||
        entry.owner === 'GPURenderPassTimestampWrites'
    ) {
        deviceFeatures.push('timestamp-query')
    }
    if (
        id === 'GPUQuerySetDescriptor.type' ||
        id === 'type.GPUQueryType'
    ) {
        conditions.push(requirementCondition(
            'the selected query type is "timestamp"',
            [ 'timestamp-query' ]
        ))
    }
    if (id === 'GPUTextureViewDescriptor.swizzle') {
        conditions.push(requirementCondition(
            'swizzle is not the identity "rgba"',
            [ 'texture-component-swizzle' ]
        ))
    }
    if (id === 'GPUPipelineLayoutDescriptor.immediateSize') {
        conditions.push(requirementCondition(
            'immediateSize is greater than zero',
            [],
            [ 'immediate_address_space' ],
            [ 'maxImmediateSize' ]
        ))
    }
    if (id === 'GPUBindingCommandsMixin.setImmediates') {
        languageFeatures.push('immediate_address_space')
        limits.push('maxImmediateSize')
    }
    if (
        id === 'type.GPUBlendFactor' ||
        id === 'GPUBlendComponent.srcFactor' ||
        id === 'GPUBlendComponent.dstFactor'
    ) {
        conditions.push(requirementCondition(
            'a src1, one-minus-src1, src1-alpha, or one-minus-src1-alpha factor is selected',
            [ 'dual-source-blending' ]
        ))
    }
    if (
        id === 'GPURenderCommandsMixin.drawIndirect' ||
        id === 'GPURenderCommandsMixin.drawIndexedIndirect'
    ) {
        conditions.push(requirementCondition(
            'the indirect argument firstInstance value is non-zero',
            [ 'indirect-first-instance' ]
        ))
    }
    if (entryCarriesTextureFormat(entry)) {
        conditions.push(
            ...textureFormatRequirementConditions(dependencyManifest)
        )
    }

    const requirements = {
        enableExtensions: [],
        deviceFeatures: uniqueSorted(deviceFeatures),
        languageFeatures: uniqueSorted(languageFeatures),
        limits: uniqueSorted(limits),
        dependencies: [],
        conditions,
        policy:
            conditions.length === 0
                ? 'Required features and limits remain explicit at Runtime, Program, and descriptor boundaries.'
                : 'Unconditional requirements are listed directly; value-dependent native requirements are preserved as explicit conditions.',
    }
    assertCoverageRequirements(requirements, entry.id)
    return requirements
}

function entryCarriesTextureFormat(entry) {

    return (
        entry.id === 'type.GPUTextureFormat' ||
        entry.id === 'GPUTextureDescriptor.format' ||
        entry.id === 'GPUTextureDescriptor.viewFormats' ||
        entry.id === 'GPUTextureViewDescriptor.format' ||
        entry.id === 'GPUStorageTextureBindingLayout.format' ||
        entry.id === 'GPUColorTargetState.format'
    )
}

function textureFormatRequirementConditions(dependencyManifest) {

    const supportPrerequisites = new Map(
        dependencyManifest.entries
            .filter(entry =>
                entry.kind === 'adapter-support-prerequisite'
            )
            .map(entry => [
                entry.feature,
                entry,
            ])
    )
    return dependencyManifest.entries
        .filter(entry => entry.kind === 'format-specific-condition')
        .flatMap(entry => entry.requiredFeatures.map((feature) => {
            const prerequisite = supportPrerequisites.get(feature)
            const conditionDependencies = prerequisite === undefined
                ? []
                : [ prerequisite.id ]
            return requirementCondition(
                `the selected format is ${entry.format} and the capability gated by ${feature} is used`,
                prerequisite === undefined
                    ? [ feature ]
                    : [ prerequisite.requiredSupportedFeature, feature ],
                [],
                [],
                conditionDependencies
            )
        }))
        .sort((left, right) => left.when.localeCompare(right.when))
}

function requirementCondition(
    when,
    deviceFeatures = [],
    languageFeatures = [],
    limits = [],
    dependencies = [],
    deviceFeatureAlternatives = []
) {

    return {
        when,
        deviceFeatures: uniqueSorted(deviceFeatures),
        languageFeatures: uniqueSorted(languageFeatures),
        limits: uniqueSorted(limits),
        dependencies: uniqueSorted(dependencies),
        ...(deviceFeatureAlternatives.length > 0
            ? {
                deviceFeatureAlternatives: uniqueObjects(
                    deviceFeatureAlternatives.map(uniqueSorted)
                ),
            }
            : {}),
    }
}

function normalizeRequirementConditions(
    conditions,
    dependencyManifest,
    entryId
) {

    return uniqueObjects(conditions.map((condition) => {
        if (
            condition === null ||
            typeof condition !== 'object' ||
            Array.isArray(condition)
        ) {
            throw new TypeError(
                `${entryId} contains an invalid requirement condition`
            )
        }
        return requirementCondition(
            condition.when,
            condition.deviceFeatures,
            condition.languageFeatures,
            condition.limits,
            (condition.dependencies ?? []).map(dependency =>
                resolveDependencyId(
                    dependency,
                    dependencyManifest,
                    entryId
                )
            ),
            condition.deviceFeatureAlternatives
        )
    }))
}

function resolveDependencyId(dependency, dependencyManifest, entryId) {

    if (typeof dependency === 'string') {
        if (
            dependencyManifest.entries.some(entry =>
                entry.id === dependency
            )
        ) {
            return dependency
        }
        throw new TypeError(
            `${entryId} references unknown dependency ${dependency}`
        )
    }
    if (
        dependency === null ||
        typeof dependency !== 'object' ||
        Array.isArray(dependency)
    ) {
        throw new TypeError(
            `${entryId} contains an invalid dependency reference`
        )
    }
    const matches = dependencyManifest.entries.filter((candidate) => {
        if (
            dependency.kind === 'enable-extension-companion' &&
            candidate.kind === 'caller-declared-companion'
        ) {
            return (
                candidate.extension === dependency.extension &&
                candidate.requiredExtension ===
                    dependency.requiredExtension
            )
        }
        return Object.entries(dependency).every(([ key, value ]) =>
            candidate[key] === value
        )
    })
    if (matches.length !== 1) {
        throw new TypeError(
            `${entryId} dependency reference resolves to ${matches.length} facts`
        )
    }
    return matches[0].id
}

export function assertCoverageRequirements(requirements, entryId) {

    if (
        requirements === null ||
        typeof requirements !== 'object' ||
        Array.isArray(requirements)
    ) {
        throw new TypeError(`${entryId} requirements must be an object`)
    }
    assertExactObjectKeys(
        requirements,
        normalizedRequirementKeys,
        `${entryId}.requirements`
    )
    const authorities = coverageRequirementAuthorities()
    assertKnownStringArray(
        requirements.enableExtensions,
        authorities.enableExtensions,
        `${entryId}.enableExtensions`
    )
    assertKnownStringArray(
        requirements.deviceFeatures,
        authorities.deviceFeatures,
        `${entryId}.deviceFeatures`
    )
    assertKnownStringArray(
        requirements.languageFeatures,
        authorities.languageFeatures,
        `${entryId}.languageFeatures`
    )
    assertKnownStringArray(
        requirements.limits,
        authorities.limits,
        `${entryId}.limits`
    )
    assertKnownStringArray(
        requirements.dependencies,
        authorities.dependencies,
        `${entryId}.dependencies`
    )
    if (!Array.isArray(requirements.conditions)) {
        throw new TypeError(`${entryId}.conditions must be an array`)
    }
    assertUniqueValues(requirements.conditions, `${entryId}.conditions`)
    for (
        let conditionIndex = 0;
        conditionIndex < requirements.conditions.length;
        conditionIndex += 1
    ) {
        const condition = requirements.conditions[conditionIndex]
        const location = `${entryId}.conditions[${conditionIndex}]`
        if (
            condition === null ||
            typeof condition !== 'object' ||
            Array.isArray(condition) ||
            typeof condition.when !== 'string' ||
            condition.when.length === 0
        ) {
            throw new TypeError(`${location} is invalid`)
        }
        assertExactObjectKeys(
            condition,
            requirementConditionKeys,
            location
        )
        assertKnownStringArray(
            condition.deviceFeatures,
            authorities.deviceFeatures,
            `${location}.deviceFeatures`
        )
        assertKnownStringArray(
            condition.languageFeatures,
            authorities.languageFeatures,
            `${location}.languageFeatures`
        )
        assertKnownStringArray(
            condition.limits,
            authorities.limits,
            `${location}.limits`
        )
        assertKnownStringArray(
            condition.dependencies,
            authorities.dependencies,
            `${location}.dependencies`
        )
        if (condition.deviceFeatureAlternatives !== undefined) {
            if (
                !Array.isArray(condition.deviceFeatureAlternatives) ||
                condition.deviceFeatureAlternatives.length === 0
            ) {
                throw new TypeError(
                    `${location}.deviceFeatureAlternatives must be a non-empty array`
                )
            }
            assertUniqueValues(
                condition.deviceFeatureAlternatives,
                `${location}.deviceFeatureAlternatives`
            )
            condition.deviceFeatureAlternatives.forEach(
                (alternative, alternativeIndex) => {
                    if (alternative.length === 0) {
                        throw new TypeError(
                            `${location}.deviceFeatureAlternatives[${alternativeIndex}] must be non-empty`
                        )
                    }
                    assertKnownStringArray(
                        alternative,
                        authorities.deviceFeatures,
                        `${location}.deviceFeatureAlternatives[${alternativeIndex}]`
                    )
                }
            )
        }
    }
    if (
        typeof requirements.policy !== 'string' ||
        requirements.policy.length === 0
    ) {
        throw new TypeError(`${entryId}.policy must be a non-empty string`)
    }
    return requirements
}

function assertExactObjectKeys(value, allowedKeys, location) {

    const allowed = new Set(allowedKeys)
    const unknownKeys = Object.keys(value)
        .filter(key => !allowed.has(key))
        .sort()
    if (unknownKeys.length > 0) {
        throw new TypeError(
            `${location} contains unknown keys: ${unknownKeys.join(', ')}`
        )
    }
}

function coverageRule(
    ruleId,
    evidenceIds,
    classification = 'managed-first-class',
    rationale,
    proofProfile,
    entryProof
) {

    return {
        ruleId,
        evidenceIds: uniqueSorted(
            Array.isArray(evidenceIds)
                ? evidenceIds
                : [ evidenceIds ]
        ),
        classification,
        proofProfile,
        ...(entryProof === undefined ? {} : { entryProof }),
        ...(rationale === undefined ? {} : { rationale }),
    }
}

function webGpuRule(
    ruleId,
    evidenceIds,
    proofProfile,
    classification = 'managed-first-class',
    rationale,
    entryProof
) {

    return Object.freeze({
        ruleId,
        evidenceIds: Object.freeze(
            uniqueSorted(
                Array.isArray(evidenceIds)
                    ? evidenceIds
                    : [ evidenceIds ]
            )
        ),
        proofProfile,
        classification,
        ...(entryProof === undefined ? {} : { entryProof }),
        ...(rationale === undefined ? {} : { rationale }),
    })
}

function webGpuOperationRule(
    ruleId,
    evidenceIds,
    profileName,
    operationEvidence,
    options = {}
) {

    const baseProfile = entryProofProfiles[profileName]
    if (baseProfile === undefined) {
        throw new TypeError(`Unknown WebGPU proof profile ${profileName}`)
    }
    return webGpuRule(
        ruleId,
        evidenceIds,
        profileName,
        options.classification,
        options.rationale,
        proofProfile(
            baseProfile.claim,
            options.publicSymbols ?? baseProfile.publicSymbols,
            operationEvidence
        )
    )
}

function webGpuOwnerRule(
    owners,
    ruleId,
    evidenceIds,
    proofProfile,
    classification = 'managed-first-class'
) {

    return Object.freeze({
        owners: Object.freeze([ ...owners ]),
        rule: webGpuRule(
            ruleId,
            evidenceIds,
            proofProfile,
            classification
        ),
    })
}

function createWebGpuOwnerRules(groups) {

    const rules = new Map()
    for (const group of groups) {
        for (const owner of group.owners) {
            if (rules.has(owner)) {
                throw new TypeError(
                    `Duplicate WebGPU owner rule for ${owner}`
                )
            }
            rules.set(owner, group.rule)
        }
    }
    return rules
}

function coverageFromWebGpuRule(rule) {

    return coverageRule(
        rule.ruleId,
        rule.evidenceIds,
        rule.classification,
        rule.rationale,
        rule.proofProfile,
        rule.entryProof
    )
}

let cachedRequirementAuthorities

function coverageRequirementAuthorities() {

    if (cachedRequirementAuthorities !== undefined) {
        return cachedRequirementAuthorities
    }
    const wgsl = readJson(normativeArtifactPaths.wgsl)
    const webgpu = readJson(normativeArtifactPaths.webgpu)
    const dependencies = readJson(normativeArtifactPaths.dependencies)
    cachedRequirementAuthorities = Object.freeze({
        enableExtensions: new Set(
            wgsl.entries
                .filter(entry => entry.kind === 'enable-extension')
                .map(entry => entry.name)
        ),
        languageFeatures: new Set(
            wgsl.entries
                .filter(entry => entry.kind === 'language-extension')
                .map(entry => entry.name)
        ),
        deviceFeatures: readStringLiteralTypeMembers(
            path.join(
                root,
                'node_modules',
                '@webgpu',
                'types',
                'dist',
                'index.d.ts'
            ),
            'GPUFeatureName'
        ),
        limits: new Set(
            webgpu.entries
                .filter(entry =>
                    entry.owner === 'GPUSupportedLimits' &&
                    entry.kind === 'property'
                )
                .map(entry => entry.member)
        ),
        dependencies: new Set(
            dependencies.entries.map(entry => entry.id)
        ),
    })
    return cachedRequirementAuthorities
}

function readStringLiteralTypeMembers(filePath, typeName) {

    const source = fs.readFileSync(filePath, 'utf8')
    const file = ts.createSourceFile(
        filePath,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS
    )
    const declarations = file.statements.filter(statement =>
        ts.isTypeAliasDeclaration(statement) &&
        statement.name.text === typeName
    )
    if (declarations.length !== 1) {
        throw new TypeError(
            `Expected one ${typeName} declaration, found ${declarations.length}`
        )
    }
    const type = declarations[0].type
    const members = ts.isUnionTypeNode(type) ? type.types : [ type ]
    return new Set(members.map((member) => {
        if (
            !ts.isLiteralTypeNode(member) ||
            !ts.isStringLiteral(member.literal)
        ) {
            throw new TypeError(
                `${typeName} contains a non-string member`
            )
        }
        return member.literal.text
    }))
}

function assertKnownStringArray(values, authority, location) {

    if (!Array.isArray(values)) {
        throw new TypeError(`${location} must be an array`)
    }
    for (const value of values) {
        if (
            typeof value !== 'string' ||
            value.length === 0 ||
            !authority.has(value)
        ) {
            throw new TypeError(
                `${location} contains invalid value ${String(value)}`
            )
        }
    }
    if (new Set(values).size !== values.length) {
        throw new TypeError(`${location} contains duplicate values`)
    }
    const sorted = [ ...values ].sort()
    if (JSON.stringify(values) !== JSON.stringify(sorted)) {
        throw new TypeError(`${location} must be sorted`)
    }
}

function assertUniqueValues(values, location) {

    const jsonValues = values.map(value => JSON.stringify(value))
    if (new Set(jsonValues).size !== jsonValues.length) {
        throw new TypeError(`${location} contains duplicate values`)
    }
}

function proofProfile(claim, publicSymbols, operationEvidence) {

    return Object.freeze({
        claim,
        publicSymbols: Object.freeze(uniqueSorted(publicSymbols)),
        operationEvidence: Object.freeze(
            operationEvidence
                .map(item => Object.freeze({ ...item }))
                .sort((left, right) =>
                    left.operation.localeCompare(right.operation) ||
                    left.sourcePath.localeCompare(right.sourcePath)
                )
        ),
    })
}

function operationProof(operation, sourcePath) {

    return Object.freeze({ operation, sourcePath })
}

function uniqueSorted(values) {

    return [ ...new Set(values) ].sort()
}

function uniqueObjects(values) {

    const byJson = new Map(
        values.map(value => [ JSON.stringify(value), value ])
    )
    return [ ...byJson ]
        .sort(([ left ], [ right ]) => left.localeCompare(right))
        .map(([, value ]) => value)
}

function evidenceRecord(
    id,
    claim,
    sourcePaths,
    testPaths,
    publicSymbols,
    nativeOperations,
    browserPaths = []
) {

    return Object.freeze({
        id,
        claim,
        sourcePaths: Object.freeze(sourcePaths),
        testPaths: Object.freeze(testPaths),
        browserPaths: Object.freeze(browserPaths),
        publicSymbols: Object.freeze(publicSymbols),
        nativeOperations: Object.freeze(nativeOperations),
    })
}

function countBy(values, select) {

    const counts = {}
    for (const value of values) {
        const key = select(value)
        counts[key] = (counts[key] ?? 0) + 1
    }
    return counts
}

function relative(absolute) {

    return path.relative(root, absolute).split(path.sep).join('/')
}

function readJson(file) {

    return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function writeManifest(targetPath, manifest) {

    fs.mkdirSync(path.dirname(targetPath), { recursive: true })
    fs.writeFileSync(targetPath, `${JSON.stringify(manifest)}\n`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    writeManifest(
        wgslEnableExtensionManifestPath,
        createWgslEnableExtensionManifest()
    )
    writeManifest(currentCoverageManifestPath, createCurrentCoverageManifest())
}
