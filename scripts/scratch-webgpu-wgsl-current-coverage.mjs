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
        packageVersion: '0.1.71',
        declarationSha256:
            'd2e5cfb2397ec8cacfd30de0e6f7992eb7db7b02cc83b7c43ef58bcd5aa88bc3',
    }),
    proposalIndex: Object.freeze({
        url: 'https://github.com/gpuweb/gpuweb/tree/main/proposals',
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
        [ 'requestAdapter', 'requestDevice', 'device.lost', 'queue.submit' ]
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
        [ 'packages/geoscratch/src/scratch/binding.ts', 'packages/geoscratch/src/scratch/binding-ownership.ts' ],
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
        [ 'RenderPipeline', 'ComputePipeline', 'RenderPipelineDescriptor', 'ComputePipelineDescriptor' ],
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
        [ 'packages/geoscratch/src/scratch/pass.ts', 'packages/geoscratch/src/scratch/command.ts' ],
        [
            'tests/scratch-render-pass-native-parity.test.js',
            'tests/scratch-depth-stencil-attachments.test.js',
            'tests/scratch-render-state-clear.test.js',
        ],
        [ 'RenderPassSpec', 'ComputePassSpec', 'DrawCommand', 'DispatchCommand' ],
        [ 'beginRenderPass', 'beginComputePass', 'draw', 'drawIndexed', 'dispatchWorkgroups' ]
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
        'webgpu-descriptor-values',
        'WebGPU scalar aliases, dictionaries, enums, labels, flags, colors, origins, extents, and indirect values are retained in explicit Scratch descriptors.',
        [
            'packages/geoscratch/src/scratch/runtime.ts',
            'packages/geoscratch/src/scratch/command.ts',
            'packages/geoscratch/src/scratch/pipeline.ts',
        ],
        [
            'tests/types/public-api.ts',
            'tests/scratch-pipeline-command.test.js',
            'tests/scratch-render-pass-native-parity.test.js',
        ],
        [ 'ProgramDescriptor', 'RenderPipelineDescriptor', 'CopyCommandDescriptor', 'RenderPassSpecDescriptor' ],
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
        [ 'ScratchRuntime.wgslLanguageFeatures', 'Program.requiredLanguageFeatures' ],
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
        [ 'ScratchRuntime.requiredFeatures', 'Program.requiredFeatures', 'ShaderModuleSourcePart' ],
        [ 'requestDevice', 'createShaderModule', 'createRenderPipeline', 'createComputePipeline' ],
        [ 'tests/browser/scratch-wgsl-capability-matrix.mjs' ]
    ),
    evidenceRecord(
        'wgsl-immediate-data',
        'The immediate_address_space language contract is coupled to explicit pipeline byte size and per-command submission snapshots.',
        [ 'packages/geoscratch/src/scratch/pipeline.ts', 'packages/geoscratch/src/scratch/command.ts' ],
        [ 'tests/scratch-immediate-data.test.js' ],
        [ 'Program.requiredLanguageFeatures', 'CommandImmediateData', 'RenderPipelineDescriptor' ],
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

    const evidenceId = webGpuEvidenceId(entry)
    return currentEntry({
        domain: 'webgpu',
        manifest,
        entry,
        evidenceId,
        source: {
            publication: manifest.baseline.publication,
            url: manifest.baseline.url,
            anchor: entry.id,
            declarationSignatureHashes: entry.signatureHashes,
        },
        requirements: {
            deviceFeatures: [],
            languageFeatures: [],
            limits: entry.owner === 'GPUSupportedLimits' ? [ entry.member ] : [],
            dependencies: [],
            policy: 'Required features and limits remain explicit at Runtime, Program, and descriptor boundaries.',
        },
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
        evidenceId,
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
        requirements: {
            deviceFeatures: entry.requiredFeatures,
            languageFeatures: entry.requiredLanguageFeatures,
            limits: [],
            dependencies: entry.dependencies,
            policy: 'Scratch never parses WGSL or injects required device features.',
        },
        evidenceIds: entry.evidenceIds,
    }
}

function currentEntry({
    domain,
    manifest,
    entry,
    evidenceId,
    source,
    requirements,
}) {

    const evidenceRecordValue = evidenceById.get(evidenceId)
    if (evidenceRecordValue === undefined) {
        throw new Error(`Unknown evidence id: ${evidenceId}`)
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
        ? `Resolved after the frozen baseline: ${evidenceRecordValue.claim}`
        : goalStart.rationale

    return {
        id: entry.id,
        domain,
        kind: entry.kind,
        source,
        goalStart,
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
            publicSymbols: notApplicable ? [] : evidenceRecordValue.publicSymbols,
            contract: notApplicable ? rationale : evidenceRecordValue.claim,
        },
        nativeLowering: {
            kind: notApplicable
                ? 'none'
                : callerWgsl
                    ? 'wgsl-compilation'
                    : 'native-call-or-descriptor',
            sourcePaths: notApplicable ? [] : evidenceRecordValue.sourcePaths,
            operations: notApplicable ? [] : evidenceRecordValue.nativeOperations,
        },
        requirements,
        evidenceIds: [ evidenceId ],
    }
}

function webGpuEvidenceId(entry) {

    if (entry.classification.status === 'not-applicable') return 'webidl-non-capability'
    const familyEvidence = {
        'external-texture': 'webgpu-external-texture',
        'render-bundle-debug': 'webgpu-render-bundle-debug',
        'shader-module-pipeline': 'webgpu-shader-program',
        'optional-fragment': 'webgpu-pipelines',
        'surface-texture-lease': 'webgpu-surface-presentation',
        'runtime-capabilities': 'webgpu-runtime-capabilities',
        'texture-transfer': 'webgpu-copy-upload',
    }[entry.classification.family]
    if (familyEvidence !== undefined) return familyEvidence

    const id = entry.id
    const owner = entry.owner
    const member = entry.member
    if (/GPU(Validation|Internal|OutOfMemory)Error|GPUUncapturedErrorEvent/.test(owner)) {
        return 'webgpu-diagnostics'
    }
    if (owner === 'GPUDevice' && [ 'pushErrorScope', 'popErrorScope', 'onuncapturederror' ].includes(member)) {
        return 'webgpu-diagnostics'
    }
    if (/ExternalTexture/.test(owner) || member === 'importExternalTexture') {
        return 'webgpu-external-texture'
    }
    if (/RenderBundle|DebugCommands/.test(owner)) return 'webgpu-render-bundle-debug'
    if (/ShaderModule|Compilation/.test(owner)) return 'webgpu-shader-program'
    if (/QuerySet|QueryType|TimestampWrites/.test(owner)) return 'webgpu-query'
    if (/Canvas/.test(owner)) return 'webgpu-surface-presentation'
    if (/BindGroup|BindingCommands|BindingResource|BindingLayout|ShaderStage/.test(owner)) {
        return 'webgpu-bindings'
    }
    if (/Sampler/.test(owner)) return 'webgpu-sampler'
    if (/Buffer/.test(owner) && !/TexelCopyBuffer|ImageCopyBuffer/.test(owner)) {
        return 'webgpu-buffer-mapping'
    }
    if (/Texture/.test(owner) && !/ExternalTexture|StorageTextureBinding|TextureBindingLayout/.test(owner)) {
        return 'webgpu-texture-resource'
    }
    if (/RenderPass|ComputePass|RenderCommands/.test(owner)) return 'webgpu-pass-state'
    if (
        /Pipeline|ProgrammableStage|Primitive|Blend|ColorTarget|ColorWrite|Depth|Stencil|Multisample|Vertex|CullMode|FrontFace|CompareFunction/.test(owner)
    ) return 'webgpu-pipelines'
    if (/CopyExternalImage/.test(owner) || /GPUImageCopyExternalImage/.test(owner)) {
        return 'webgpu-external-image-upload'
    }
    if (id === 'GPUCommandEncoder.copyTextureToBuffer') {
        return 'webgpu-readback'
    }
    if (
        /CommandEncoder|CommandBuffer|CommandsMixin|TexelCopy|ImageCopy|Origin|Extent/.test(owner)
    ) return 'webgpu-copy-upload'
    if (owner === 'GPUQueue') {
        if (member === 'copyExternalImageToTexture') return 'webgpu-external-image-upload'
        if (member === 'writeBuffer' || member === 'writeTexture') return 'webgpu-copy-upload'
        return 'webgpu-submission'
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
        return allocationEvidence ?? 'webgpu-runtime-capabilities'
    }
    if (/GPU(Adapter|AdapterInfo|DeviceDescriptor|DeviceLost|FeatureName|Supported|RequestAdapter|PowerPreference)|Navigator|WGSLLanguageFeatures/.test(owner)) {
        return 'webgpu-runtime-capabilities'
    }
    if (/GPUObject/.test(owner)) return 'webgpu-resource-lifetime'
    if (/GPUMapMode/.test(owner)) return 'webgpu-buffer-mapping'
    if (id.startsWith('GPUExternal')) return 'webgpu-external-texture'
    return 'webgpu-descriptor-values'
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
