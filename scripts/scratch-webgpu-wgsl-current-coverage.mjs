import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import {
    createWebGpuManifest,
    createWgslManifest,
    webGpuManifestPath,
    wgslManifestPath,
} from './scratch-webgpu-wgsl-parity-manifest.mjs'

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

const enableExtensionContracts = Object.freeze([
    enableExtension('clip_distances', 'clip-distances'),
    enableExtension('dual_source_blending', 'dual-source-blending'),
    enableExtension('f16', 'shader-f16'),
    enableExtension('primitive_index', 'primitive-index'),
    enableExtension(
        'subgroup_size_control',
        'subgroup-size-control',
        [ 'subgroups' ],
        [
            Object.freeze({
                feature: 'subgroup-size-control',
                requiredFeature: 'subgroups',
            }),
        ]
    ),
    enableExtension('subgroups', 'subgroups'),
])

export function createWgslEnableExtensionManifest() {

    const entries = enableExtensionContracts.map(contract => ({
        ...contract,
        source: {
            publication: currentSpecRefresh.wgsl.publication,
            url: `${currentSpecRefresh.wgsl.url}#extension-${contract.extension}`,
            anchor: `extension-${contract.extension}`,
            gpuFeatureUrls: contract.requiredFeatures.map(feature => (
                `${currentSpecRefresh.webgpu.url}#dom-gpufeaturename-${feature}`
            )),
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
            directive: `enable ${contract.extension};`,
            publicSymbols: evidenceById.get('wgsl-enable-contract').publicSymbols,
        },
        nativeLowering: {
            kind: 'wgsl-compilation',
            sourcePaths: evidenceById.get('wgsl-enable-contract').sourcePaths,
            operations: evidenceById.get('wgsl-enable-contract').nativeOperations,
        },
        evidenceIds: [ 'wgsl-enable-contract' ],
    }))

    return {
        schemaVersion: 1,
        purpose: 'Current formal WGSL enable-extension to WebGPU feature contracts',
        baseline: currentSpecRefresh,
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

    const webgpu = createWebGpuManifest()
    const wgsl = createWgslManifest()
    const enableExtensions = createWgslEnableExtensionManifest()
    const entries = [
        ...webgpu.entries.map(entry => currentWebGpuEntry(webgpu, entry)),
        ...wgsl.entries.map(entry => currentWgslEntry(wgsl, entry)),
        ...enableExtensions.entries.map(currentEnableExtensionEntry),
    ].sort((left, right) => left.id.localeCompare(right.id))
    const byClassification = countBy(
        entries,
        entry => entry.current.classification
    )
    const byStatus = countBy(entries, entry => entry.current.status)

    return {
        schemaVersion: 1,
        purpose: 'Current managed WebGPU and WGSL expression and evidence closure',
        baseline: currentSpecRefresh,
        frozenManifests: {
            webgpu: relative(webGpuManifestPath),
            wgsl: relative(wgslManifestPath),
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
            webgpuEntryCount: webgpu.entries.length,
            wgslBaselineEntryCount: wgsl.entries.length,
            wgslEnableExtensionEntryCount: enableExtensions.entries.length,
            unresolvedCount: byStatus.unresolved ?? 0,
            byStatus,
            byClassification,
        },
    }
}

function currentWebGpuEntry(manifest, entry) {

    const coverage = webGpuCoverage(entry)
    return currentEntry({
        domain: 'webgpu',
        manifest,
        entry,
        coverage,
        source: {
            publication: manifest.baseline.publication,
            url: manifest.baseline.url,
            anchor: entry.id,
            declarationSignatureHashes: entry.signatureHashes,
        },
        requirements: webGpuRequirements(entry),
    })
}

function currentWgslEntry(manifest, entry) {

    const evidenceId = wgslEvidenceId(entry)
    const languageFeature = entry.kind === 'language-extension'
        ? entry.id.slice('language-extension.'.length)
        : undefined
    const requiresF16 = entry.id.includes('<f16>') || entry.id === 'host-type.scalar.f16'
    return currentEntry({
        domain: 'wgsl',
        manifest,
        entry,
        coverage: {
            ruleId: `wgsl:${entry.kind}`,
            evidenceIds: [ evidenceId ],
        },
        source: {
            publication: manifest.baseline.publication,
            url: wgslSourceUrl(entry),
            anchor: entry.id,
        },
        requirements: {
            deviceFeatures: requiresF16 ? [ 'shader-f16' ] : [],
            languageFeatures: languageFeature === undefined ? [] : [ languageFeature ],
            limits: [],
            dependencies: [],
            conditions: [],
            policy:
                languageFeature === undefined
                    ? 'Layout-derived requirements are explicit Program facts.'
                    : 'Language extensions are checked against Runtime.wgslLanguageFeatures.',
        },
    })
}

function currentEnableExtensionEntry(entry) {

    return {
        id: entry.id,
        domain: 'wgsl',
        kind: 'enable-extension',
        source: entry.source,
        goalStart: {
            status: 'omitted-from-frozen-baseline',
            rationale: 'The formal enable-extension row was missing from the frozen 65-entry WGSL manifest.',
        },
        current: entry.current,
        expression: entry.expression,
        nativeLowering: entry.nativeLowering,
        coverageRule: 'wgsl:enable-extension',
        requirements: {
            deviceFeatures: entry.requiredFeatures,
            languageFeatures: entry.requiredLanguageFeatures,
            limits: [],
            dependencies: entry.dependencies,
            conditions: [],
            policy: 'Scratch never parses WGSL or injects required device features.',
        },
        evidenceIds: entry.evidenceIds,
    }
}

function currentEntry({
    domain,
    manifest,
    entry,
    coverage,
    source,
    requirements,
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
    const goalStart = entry.classification
    const notApplicable = goalStart.status === 'not-applicable'
    const classification = notApplicable
        ? 'not-applicable'
        : goalStart.status === 'known-target-gap'
            ? 'managed-first-class'
            : goalStart.status
    const status = notApplicable ? 'not-applicable' : 'managed'
    const callerWgsl = domain === 'wgsl' && (
        entry.kind === 'language-extension' ||
        entry.kind === 'shader-semantic-domain'
    )
    const rationale = goalStart.status === 'known-target-gap'
        ? `Resolved after the frozen baseline: ${evidenceRecords
            .map(record => record.claim)
            .join(' ')}`
        : goalStart.rationale
    const publicSymbols = uniqueSorted(
        evidenceRecords.flatMap(record => record.publicSymbols)
    )
    const sourcePaths = uniqueSorted(
        evidenceRecords.flatMap(record => record.sourcePaths)
    )
    const nativeOperations = uniqueSorted(
        evidenceRecords.flatMap(record => record.nativeOperations)
    )

    return {
        id: entry.id,
        domain,
        kind: entry.kind,
        source,
        goalStart,
        coverageRule: coverage.ruleId,
        current: {
            status,
            classification,
            rationale,
        },
        expression: {
            mode: notApplicable
                ? 'not-applicable'
                : callerWgsl
                    ? 'caller-authored-wgsl'
                    : 'scratch-api',
            publicSymbols: notApplicable ? [] : publicSymbols,
            contract: notApplicable
                ? rationale
                : evidenceRecords.map(record => record.claim).join(' '),
        },
        nativeLowering: {
            kind: notApplicable
                ? 'none'
                : callerWgsl
                    ? 'wgsl-compilation'
                    : 'native-call-or-descriptor',
            sourcePaths: notApplicable ? [] : sourcePaths,
            operations: notApplicable ? [] : nativeOperations,
        },
        requirements,
        evidenceIds: coverage.evidenceIds,
    }
}

function webGpuCoverage(entry) {

    if (entry.classification.status === 'not-applicable') {
        return coverageRule('webgpu:not-applicable', 'webidl-non-capability')
    }
    const familyEvidence = {
        'external-texture': 'webgpu-external-texture',
        'render-bundle-debug': 'webgpu-render-bundle-debug',
        'shader-module-pipeline': 'webgpu-shader-program',
        'optional-fragment': 'webgpu-pipelines',
        'surface-texture-lease': 'webgpu-surface-presentation',
        'runtime-capabilities': 'webgpu-runtime-capabilities',
        'texture-transfer': 'webgpu-copy-upload',
    }[entry.classification.family]
    if (familyEvidence !== undefined) {
        return coverageRule(
            `webgpu:frozen-family:${entry.classification.family}`,
            familyEvidence
        )
    }

    const id = entry.id
    const owner = entry.owner
    const member = entry.member
    const exactRules = {
        'interface.GPU': [ 'webgpu:gpu-interface', 'webgpu-runtime-capabilities' ],
        'GPU.requestAdapter': [ 'webgpu:gpu-request-adapter', 'webgpu-runtime-capabilities' ],
        'GPU.getPreferredCanvasFormat': [ 'webgpu:preferred-canvas-format', 'webgpu-surface-presentation' ],
        'GPU.wgslLanguageFeatures': [ 'webgpu:wgsl-language-features', 'webgpu-runtime-capabilities' ],
        'GPUBindingCommandsMixin.setBindGroup': [ 'webgpu:set-bind-group', 'webgpu-bindings' ],
        'GPUBindingCommandsMixin.setImmediates': [ 'webgpu:set-immediates', 'wgsl-immediate-data' ],
        'interface.GPUBindingCommandsMixin': [
            'webgpu:binding-command-interface',
            [ 'webgpu-bindings', 'wgsl-immediate-data' ],
        ],
        'interface.GPUCommandsMixin': [ 'webgpu:debug-command-interface', 'webgpu-render-bundle-debug' ],
        'interface.GPURenderCommandsMixin': [
            'webgpu:render-command-interface',
            [ 'webgpu-pass-state', 'webgpu-pipelines' ],
        ],
        'GPURenderCommandsMixin.setPipeline': [ 'webgpu:render-set-pipeline', 'webgpu-pipelines' ],
        'GPUCommandEncoder.beginComputePass': [ 'webgpu:begin-compute-pass', 'webgpu-pass-state' ],
        'GPUCommandEncoder.beginRenderPass': [ 'webgpu:begin-render-pass', 'webgpu-pass-state' ],
        'GPUCommandEncoder.clearBuffer': [ 'webgpu:clear-buffer', 'webgpu-command-encoding' ],
        'GPUCommandEncoder.finish': [ 'webgpu:finish-command-encoder', 'webgpu-submission' ],
        'GPUCommandEncoder.resolveQuerySet': [ 'webgpu:resolve-query-set', 'webgpu-query' ],
        'GPUCommandEncoder.copyTextureToBuffer': [
            'webgpu:texture-readback-copy',
            [ 'webgpu-copy-upload', 'webgpu-readback' ],
        ],
        'GPUComputePassDescriptor.timestampWrites': [ 'webgpu:compute-timestamp-writes', 'webgpu-query' ],
        'GPURenderPassDescriptor.timestampWrites': [ 'webgpu:render-timestamp-writes', 'webgpu-query' ],
    }[id]
    if (exactRules !== undefined) {
        return coverageRule(exactRules[0], exactRules[1])
    }
    if (owner === 'GPURenderCommandsMixin') {
        return coverageRule('webgpu:render-command-method', 'webgpu-pass-state')
    }
    if (/GPU(Validation|Internal|OutOfMemory)Error|GPUUncapturedErrorEvent/.test(owner)) {
        return coverageRule('webgpu:error-diagnostics', 'webgpu-diagnostics')
    }
    if (owner === 'GPUDevice' && [ 'pushErrorScope', 'popErrorScope', 'onuncapturederror' ].includes(member)) {
        return coverageRule('webgpu:device-error-diagnostics', 'webgpu-diagnostics')
    }
    if (/ExternalTexture/.test(owner) || member === 'importExternalTexture') {
        return coverageRule('webgpu:external-texture', 'webgpu-external-texture')
    }
    if (/RenderBundle|DebugCommands/.test(owner)) {
        return coverageRule('webgpu:render-bundle-debug', 'webgpu-render-bundle-debug')
    }
    if (/ShaderModule|Compilation/.test(owner)) {
        return coverageRule('webgpu:shader-module', 'webgpu-shader-program')
    }
    if (/QuerySet|QueryType|TimestampWrites/.test(owner)) {
        return coverageRule('webgpu:query', 'webgpu-query')
    }
    if (/Canvas/.test(owner)) {
        return coverageRule('webgpu:canvas', 'webgpu-surface-presentation')
    }
    if (/BindGroup|BindingResource|BindingLayout|ShaderStage/.test(owner)) {
        return coverageRule('webgpu:binding', 'webgpu-bindings')
    }
    if (/Sampler/.test(owner)) {
        return coverageRule('webgpu:sampler', 'webgpu-sampler')
    }
    if (/Buffer/.test(owner) && !/TexelCopyBuffer|ImageCopyBuffer/.test(owner)) {
        return coverageRule('webgpu:buffer', 'webgpu-buffer-mapping')
    }
    if (/Texture/.test(owner) && !/ExternalTexture|StorageTextureBinding|TextureBindingLayout/.test(owner)) {
        return coverageRule('webgpu:texture', 'webgpu-texture-resource')
    }
    if (/RenderPass|ComputePass/.test(owner)) {
        return coverageRule('webgpu:pass-state', 'webgpu-pass-state')
    }
    if (
        /Pipeline|ProgrammableStage|Primitive|Blend|ColorTarget|ColorWrite|Depth|Stencil|Multisample|Vertex|CullMode|FrontFace|CompareFunction/.test(owner)
    ) {
        return coverageRule('webgpu:pipeline-state', 'webgpu-pipelines')
    }
    if (/CopyExternalImage/.test(owner) || /GPUImageCopyExternalImage/.test(owner)) {
        return coverageRule('webgpu:external-image-copy', 'webgpu-external-image-upload')
    }
    if (
        /CommandEncoder|CommandBuffer|CommandsMixin|TexelCopy|ImageCopy|Origin|Extent/.test(owner)
    ) {
        return coverageRule('webgpu:copy-command', 'webgpu-copy-upload')
    }
    if (owner === 'GPUQueue') {
        if (member === 'copyExternalImageToTexture') {
            return coverageRule('webgpu:queue-external-image', 'webgpu-external-image-upload')
        }
        if (member === 'writeBuffer' || member === 'writeTexture') {
            return coverageRule('webgpu:queue-write', 'webgpu-copy-upload')
        }
        return coverageRule('webgpu:queue-submission', 'webgpu-submission')
    }
    if (owner === 'GPUDevice') {
        const allocationEvidence = {
            createBuffer: 'webgpu-buffer-mapping',
            createTexture: 'webgpu-texture-resource',
            createSampler: 'webgpu-sampler',
            createBindGroupLayout: 'webgpu-bindings',
            createBindGroup: 'webgpu-bindings',
            createPipelineLayout: 'webgpu-pipelines',
            createShaderModule: 'webgpu-shader-program',
            createComputePipeline: 'webgpu-pipelines',
            createComputePipelineAsync: 'webgpu-pipelines',
            createRenderPipeline: 'webgpu-pipelines',
            createRenderPipelineAsync: 'webgpu-pipelines',
            createCommandEncoder: 'webgpu-submission',
            createQuerySet: 'webgpu-query',
        }[member]
        return coverageRule(
            allocationEvidence === undefined
                ? 'webgpu:device-runtime'
                : `webgpu:device:${member}`,
            allocationEvidence ?? 'webgpu-runtime-capabilities'
        )
    }
    if (/GPU(Adapter|AdapterInfo|DeviceDescriptor|DeviceLost|FeatureName|Supported|RequestAdapter|PowerPreference)|Navigator|WGSLLanguageFeatures/.test(owner)) {
        return coverageRule('webgpu:runtime-capability', 'webgpu-runtime-capabilities')
    }
    if (/GPUObject/.test(owner)) {
        return coverageRule('webgpu:object-lifecycle', 'webgpu-resource-lifetime')
    }
    if (/GPUMapMode/.test(owner)) {
        return coverageRule('webgpu:map-mode', 'webgpu-buffer-mapping')
    }
    if (id.startsWith('GPUExternal')) {
        return coverageRule('webgpu:external-value', 'webgpu-external-texture')
    }

    const exactValueEvidence = {
        'interface.GPUColorDict': 'webgpu-pass-state',
        'GPUColorDict.r': 'webgpu-pass-state',
        'GPUColorDict.g': 'webgpu-pass-state',
        'GPUColorDict.b': 'webgpu-pass-state',
        'GPUColorDict.a': 'webgpu-pass-state',
        'interface.GPUError': 'webgpu-diagnostics',
        'GPUError.message': 'webgpu-diagnostics',
        'interface.GPUFragmentState': 'webgpu-pipelines',
        'GPUFragmentState.targets': 'webgpu-pipelines',
        'type.GPUAddressMode': 'webgpu-sampler',
        'type.GPUColor': 'webgpu-pass-state',
        'type.GPUErrorFilter': 'webgpu-diagnostics',
        'type.GPUFilterMode': 'webgpu-sampler',
        'type.GPUFlagsConstant': 'webgpu-numeric-domains',
        'type.GPUIndex32': 'webgpu-pass-state',
        'type.GPUIndexFormat': 'webgpu-pass-state',
        'type.GPUIntegerCoordinate': 'webgpu-numeric-domains',
        'type.GPUIntegerCoordinateOut': 'webgpu-numeric-domains',
        'type.GPULoadOp': 'webgpu-pass-state',
        'type.GPUMipmapFilterMode': 'webgpu-sampler',
        'type.GPUQueueDescriptor': 'webgpu-runtime-capabilities',
        'type.GPUSampleMask': 'webgpu-pipelines',
        'type.GPUSignedOffset32': 'webgpu-numeric-domains',
        'type.GPUSize32': 'webgpu-numeric-domains',
        'type.GPUSize32Out': 'webgpu-numeric-domains',
        'type.GPUSize64': 'webgpu-numeric-domains',
        'type.GPUSize64Out': 'webgpu-numeric-domains',
        'type.GPUStoreOp': 'webgpu-pass-state',
    }[id]
    if (exactValueEvidence !== undefined) {
        return coverageRule('webgpu:explicit-value-domain', exactValueEvidence)
    }
    throw new Error(`Unresolved WebGPU coverage rule for ${entry.id}`)
}

function webGpuRequirements(entry) {

    const deviceFeatures = []
    const languageFeatures = []
    const limits = entry.owner === 'GPUSupportedLimits'
        ? [ entry.member ]
        : []
    const dependencies = []
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
        conditions.push(...textureFormatRequirementConditions())
    }

    return {
        deviceFeatures: uniqueSorted(deviceFeatures),
        languageFeatures: uniqueSorted(languageFeatures),
        limits: uniqueSorted(limits),
        dependencies,
        conditions,
        policy:
            conditions.length === 0
                ? 'Required features and limits remain explicit at Runtime, Program, and descriptor boundaries.'
                : 'Unconditional requirements are listed directly; value-dependent native requirements are preserved as explicit conditions.',
    }
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

function textureFormatRequirementConditions() {

    return [
        requirementCondition(
            'the selected format is BC-compressed',
            [ 'texture-compression-bc' ]
        ),
        requirementCondition(
            'the selected format is ETC2/EAC-compressed',
            [ 'texture-compression-etc2' ]
        ),
        requirementCondition(
            'the selected format is ASTC-compressed',
            [ 'texture-compression-astc' ]
        ),
        requirementCondition(
            'a BC-compressed format is used by a sliced 3D texture',
            [ 'texture-compression-bc', 'texture-compression-bc-sliced-3d' ]
        ),
        requirementCondition(
            'an ASTC-compressed format is used by a sliced 3D texture',
            [ 'texture-compression-astc', 'texture-compression-astc-sliced-3d' ]
        ),
        requirementCondition(
            'the selected format is depth32float-stencil8',
            [ 'depth32float-stencil8' ]
        ),
        requirementCondition(
            'bgra8unorm is used with STORAGE_BINDING',
            [ 'bgra8unorm-storage' ]
        ),
        requirementCondition(
            'an r32float, rg32float, or rgba32float texture is filterable',
            [ 'float32-filterable' ]
        ),
        requirementCondition(
            'an r32float, rg32float, or rgba32float color target is blended',
            [ 'float32-blendable' ]
        ),
        requirementCondition(
            'rg11b10ufloat is used as a render attachment',
            [],
            [],
            [],
            [],
            [
                [ 'rg11b10ufloat-renderable' ],
                [ 'texture-formats-tier1' ],
                [ 'texture-formats-tier2' ],
            ]
        ),
        requirementCondition(
            'a texture-formats-tier1 storage/render format is selected',
            [],
            [],
            [],
            [],
            [
                [ 'texture-formats-tier1' ],
                [ 'texture-formats-tier2' ],
            ]
        ),
        requirementCondition(
            'a texture-formats-tier2-only format or capability is selected',
            [ 'texture-formats-tier2' ],
            [],
            [],
            [
                {
                    feature: 'texture-formats-tier2',
                    requiredFeature: 'texture-formats-tier1',
                },
            ]
        ),
    ]
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
        dependencies,
        ...(deviceFeatureAlternatives.length > 0
            ? { deviceFeatureAlternatives }
            : {}),
    }
}

function coverageRule(ruleId, evidenceIds) {

    return {
        ruleId,
        evidenceIds: Array.isArray(evidenceIds)
            ? evidenceIds
            : [ evidenceIds ],
    }
}

function uniqueSorted(values) {

    return [ ...new Set(values) ].sort()
}

function wgslEvidenceId(entry) {

    if (entry.classification.status === 'not-applicable') return 'webidl-non-capability'
    if (entry.classification.family === 'wgsl-layout') return 'wgsl-recursive-layout'
    if (entry.id === 'language-extension.immediate_address_space') {
        return 'wgsl-immediate-data'
    }
    if (entry.kind === 'language-extension') return 'wgsl-language-contract'
    if (entry.kind === 'shader-semantic-domain') {
        if (entry.id === 'shader-domain.external-textures') return 'webgpu-external-texture'
        if (entry.id === 'shader-domain.textures-samplers') return 'webgpu-bindings'
        return 'wgsl-caller-authored-source'
    }
    return 'wgsl-recursive-layout'
}

function wgslSourceUrl(entry) {

    if (entry.kind === 'language-extension') {
        const name = entry.id.slice('language-extension.'.length)
        return `${currentSpecRefresh.wgsl.url}#language_extension-${name}`
    }
    if (entry.kind === 'shader-semantic-domain') {
        return `${currentSpecRefresh.wgsl.url}#language-concepts`
    }
    return `${currentSpecRefresh.wgsl.url}#memory-layouts`
}

function enableExtension(extension, feature, dependencies = [], dependencyFacts = []) {

    return Object.freeze({
        id: `enable-extension.${extension}`,
        extension,
        requiredFeatures: Object.freeze([ feature, ...dependencies ].sort()),
        dependencies: Object.freeze(dependencyFacts),
    })
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
