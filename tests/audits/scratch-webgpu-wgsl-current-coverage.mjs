import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import ts from 'typescript'
import * as currentCoverageModule from '../../scripts/scratch-webgpu-wgsl-current-coverage.mjs'
import {
    createWebGpuManifest,
    createWgslManifest,
    webGpuManifestPath,
    wgslManifestPath,
} from '../../scripts/scratch-webgpu-wgsl-parity-manifest.mjs'
import {
    normativeArtifactPaths,
} from '../../scripts/refresh-scratch-webgpu-wgsl-baseline.mjs'

const pointerProofCaseNames = [
    'unrestricted-pointer',
    'pointer-composite',
]
const {
    createCurrentCoverageManifest,
    createWgslEnableExtensionManifest,
    currentCoverageManifestPath,
    wgslEnableExtensionManifestPath,
} = currentCoverageModule

const unrestrictedPointerProofSource = `
requires unrestricted_pointer_parameters;

@group(0) @binding(0)
var<storage, read_write> outputValues: u32;

fn writeThroughStoragePointer(
    destination: ptr<storage, u32, read_write>,
    value: u32
) {
    *destination = value;
}

@compute @workgroup_size(1)
fn csMain() {
    writeThroughStoragePointer(&outputValues, 103u);
}
`

const pointerCompositeProofSource = `
requires pointer_composite_access;

@group(0) @binding(0)
var<storage, read_write> outputValues: array<u32>;

@compute @workgroup_size(1)
fn csMain() {
    var localValues = array<u32, 4>(101u, 102u, 104u, 105u);
    let valuesPointer = &localValues;
    outputValues[0] = valuesPointer[2u];
}
`

const root = process.cwd()
const current = readJson(currentCoverageManifestPath)
const enableExtensions = readJson(wgslEnableExtensionManifestPath)
const generatedCurrent = createCurrentCoverageManifest()
const generatedEnableExtensions = createWgslEnableExtensionManifest()
const frozenWebGpu = readJson(webGpuManifestPath)
const frozenWgsl = readJson(wgslManifestPath)
const normativeWebGpu = readJson(normativeArtifactPaths.webgpu)
const normativeWgsl = readJson(normativeArtifactPaths.wgsl)
const capabilityDependencies = readJson(normativeArtifactPaths.dependencies)
const proposalWatchlist = readJson(normativeArtifactPaths.proposals)
const knownDeviceFeatures = collectStringLiteralTypeMembers(
    'node_modules/@webgpu/types/dist/index.d.ts',
    'GPUFeatureName'
)
const knownEnableExtensions = new Set(
    normativeWgsl.entries
        .filter(entry => entry.kind === 'enable-extension')
        .map(entry => entry.name)
)
const knownLanguageFeatures = new Set(
    normativeWgsl.entries
        .filter(entry => entry.kind === 'language-extension')
        .map(entry => entry.name)
)
const knownLimits = new Set(
    normativeWebGpu.entries
        .filter(entry =>
            entry.owner === 'GPUSupportedLimits' &&
            entry.kind === 'property'
        )
        .map(entry => entry.member)
)
const knownDependencies = new Set(
    capabilityDependencies.entries.map(entry => entry.id)
)
const generatedFrozenWebGpu = createWebGpuManifest()
const generatedFrozenWgsl = createWgslManifest()
const evidenceById = new Map(
    current.evidence.map(record => [ record.id, record ])
)
const evidenceUseCounts = new Map()
for (const entry of current.entries) {
    for (const evidenceId of entry.evidenceIds ?? []) {
        evidenceUseCounts.set(
            evidenceId,
            (evidenceUseCounts.get(evidenceId) ?? 0) + 1
        )
    }
}

const requiredRuntimeExports = [
    'BindLayout',
    'BindSet',
    'BufferResource',
    'CopyCommand',
    'LayoutCodec',
    'Program',
    'ReadbackOperation',
    'RenderBundle',
    'ScratchRuntime',
    'ShaderModule',
    'SubmissionBuilder',
    'Surface',
    'TextureResource',
]
const [ packageEntrypoint, scratchEntrypoint ] = await Promise.all([
    import('geoscratch'),
    import('geoscratch/scratch'),
])
const packageRuntimeExportNames = Object.keys(packageEntrypoint).sort()
const scratchRuntimeExportNames = Object.keys(scratchEntrypoint).sort()
const packageSourceExportNames = collectNamedExports(
    'packages/geoscratch/src/index.ts'
)
const pointerProofCases = tryExtractSemanticCases(
    'tests/browser/scratch-wgsl-capability-matrix.mjs',
    pointerProofCaseNames
)

const checks = {
    currentManifestUsesEntryProofSchema:
        current.schemaVersion === 3 &&
        generatedCurrent.schemaVersion === 3,
    currentManifestReproducible: deepEqual(current, generatedCurrent),
    enableExtensionManifestReproducible:
        deepEqual(enableExtensions, generatedEnableExtensions),
    frozenWebGpuManifestUnchanged:
        deepEqual(frozenWebGpu, generatedFrozenWebGpu),
    frozenWgslManifestUnchanged:
        deepEqual(frozenWgsl, generatedFrozenWgsl),
    exactEntryCounts:
        current.summary.entryCount === 1244 &&
        current.summary.webgpuNormativeEntryCount === 582 &&
        current.summary.wgslNormativeEntryCount === 662 &&
        current.summary.frozenWebgpuHistoricalEntryCount === 591 &&
        current.summary.frozenWgslHistoricalEntryCount === 65,
    exactCurrentClassifications:
        current.summary.byClassification['managed-first-class'] === 668 &&
        current.summary.byClassification['managed-semantic-equivalent'] === 574 &&
        current.summary.byClassification['not-applicable'] === 2 &&
        (current.summary.byClassification.unresolved ?? 0) === 0,
    exactCurrentStatuses:
        current.summary.byStatus.managed === 1242 &&
        current.summary.byStatus['not-applicable'] === 2 &&
        (current.summary.byStatus.unresolved ?? 0) === 0 &&
        current.summary.unresolvedCount === 0,
    normativeInventoryClosure:
        currentEntriesCloseNormativeInventories(),
    normativeAuthorityIsExplicit:
        normativeAuthorityIsExplicit(),
    uniqueEntryIds:
        new Set(current.entries.map(entry => entry.id)).size ===
        current.entries.length,
    completeEntryShape: current.entries.every(entryShapeIsComplete),
    exactEvidenceAttributionRegressions:
        evidenceAttributionRegressionsPass(),
    heterogeneousOwnerProfilesAreSplit:
        heterogeneousOwnerProfilesAreSplit(),
    intentionalSemanticEquivalentsRemainExplicit:
        intentionalSemanticEquivalentsRemainExplicit(),
    managedEntryEvidenceIsEntrySpecific:
        current.entries.every(entryEvidenceIsEntrySpecific),
    webGpuMethodsHaveExactOperationEvidence:
        webGpuMethodsHaveExactOperationEvidence(),
    unknownDeviceMemberFailsClosed:
        unknownDeviceMemberFailsClosed(),
    allEvidenceIdsResolve: current.entries.every(entry =>
        entry.evidenceIds.length > 0 &&
        entry.evidenceIds.every(id => evidenceById.has(id))
    ),
    allEvidenceRecordsAreUsed:
        current.evidence.every(record =>
            (evidenceUseCounts.get(record.id) ?? 0) > 0
        ),
    allCoverageRulesAreExplicit:
        current.entries.every(entry =>
            typeof entry.coverageRule === 'string' &&
            entry.coverageRule.length > 0 &&
            !/fallback|catch[- ]?all/i.test(entry.coverageRule)
        ) &&
        !current.evidence.some(record =>
            record.id === 'webgpu-descriptor-values'
        ),
    webGpuClassifierUsesFiniteMappings:
        webGpuClassifierUsesFiniteMappings(),
    allWebGpuMethodsUseExactRules:
        normativeWebGpu.entries
            .filter(entry => entry.kind === 'method')
            .every(entry =>
                currentCoverageModule.hasWebGpuExactRule?.(entry.id) === true
            ),
    evidenceIsLocatedAndBounded:
        current.evidence.every(evidenceIsLocatedAndBounded),
    evidenceNativeOperationsResolve:
        current.evidence.every(evidenceNativeOperationsResolve),
    entryNativeOperationsResolve:
        current.entries.every(entryNativeOperationsResolve),
    evidencePublicSymbolsAreExported:
        current.evidence.every(record =>
            record.publicSymbols.every(symbol =>
                packageSourceExportNames.has(symbol)
            )
        ),
    entryPublicSymbolsAreExported:
        current.entries.every(entry =>
            entry.expression.publicSymbols.every(symbol =>
                packageSourceExportNames.has(symbol)
            )
        ),
    managedEntriesHavePublicExpression:
        current.entries
            .filter(entry => entry.current.status === 'managed')
            .every(entry =>
                entry.expression.publicSymbols.length > 0 &&
                entry.nativeLowering.sourcePaths.length > 0 &&
                entry.nativeLowering.operations.length > 0 &&
                entry.nativeLowering.kind !== 'none'
            ),
    noRawEscapeHatchLaundering:
        current.entries
            .filter(entry => entry.current.status === 'managed')
            .every(entry => !managedEntryUsesRawEscapeHatch(entry)),
    notApplicableEntriesAreExplained:
        current.entries
            .filter(entry => entry.current.status === 'not-applicable')
            .every(entry =>
                entry.current.classification === 'not-applicable' &&
                entry.current.rationale.length > 0 &&
                entry.expression.mode === 'not-applicable' &&
                entry.nativeLowering.kind === 'none'
            ),
    capabilityRequirementsAreComplete:
        current.entries.every(requirementContractIsComplete) &&
        sensitiveCapabilityRequirementsArePresent(),
    requirementValuesAreTypedKnownAndUnique:
        current.entries.every(requirementValuesAreTypedKnownAndUnique),
    invalidRequirementContractsFailClosed:
        invalidRequirementContractsFailClosed(),
    exactEnableExtensionContracts:
        deepEqual(
            enableExtensions.entries.map(enableContractFact),
            [
                {
                    extension: 'clip_distances',
                    requiredFeatures: [ 'clip-distances' ],
                    dependencies: [],
                },
                {
                    extension: 'dual_source_blending',
                    requiredFeatures: [ 'dual-source-blending' ],
                    dependencies: [],
                },
                {
                    extension: 'f16',
                    requiredFeatures: [ 'shader-f16' ],
                    dependencies: [],
                },
                {
                    extension: 'primitive_index',
                    requiredFeatures: [ 'primitive-index' ],
                    dependencies: [],
                },
                {
                    extension: 'subgroup_size_control',
                    requiredFeatures: [ 'subgroup-size-control', 'subgroups' ],
                    dependencies: [
                        'caller-companion.subgroup-size-control.subgroups',
                    ],
                },
                {
                    extension: 'subgroups',
                    requiredFeatures: [ 'subgroups' ],
                    dependencies: [],
                },
            ]
        ),
    enableAndLanguageFeaturesRemainSeparate:
        enableAndLanguageRequirementsMatchInventory(),
    proposalsRemainNonNormative:
        proposalsRemainNonNormative(),
    dependencyPreflightHasOneAuthority:
        featureDependencySourceIsShared(),
    dependencyDiagnosticDocumented:
        dependencyDiagnosticIsDocumented(),
    browserMatrixIsManagedAndSelfContained:
        browserMatrixIsManagedAndSelfContained(),
    unrestrictedPointerProofSourceIsConformant:
        unrestrictedPointerProofSourceIsConformant(
            pointerProofCases.cases.get('unrestricted-pointer')
        ),
    pointerCompositeProofSourceIsConformant:
        pointerCompositeProofSourceIsConformant(
            pointerProofCases.cases.get('pointer-composite')
        ),
    requiredPublicExportsPresent:
        [ packageEntrypoint, scratchEntrypoint ].every(entrypoint =>
            requiredRuntimeExports.every(name => name in entrypoint)
        ),
    exactRuntimeEntrypointParity:
        deepEqual(packageRuntimeExportNames, scratchRuntimeExportNames),
    exactDeclarationEntrypointParity:
        declarationEntrypointParityIsExact(),
}

const failures = Object.entries(checks)
    .filter(([, passed ]) => !passed)
    .map(([ name ]) => name)
const result = {
    schemaVersion: 1,
    status: failures.length === 0 ? 'passed' : 'failed',
    checks,
    failures,
    manifests: {
        current: {
            path: relative(currentCoverageManifestPath),
            summary: current.summary,
        },
        enableExtensions: {
            path: relative(wgslEnableExtensionManifestPath),
            summary: enableExtensions.summary,
        },
        normative: {
            webgpu: {
                path: relative(normativeArtifactPaths.webgpu),
                summary: normativeWebGpu.summary,
            },
            wgsl: {
                path: relative(normativeArtifactPaths.wgsl),
                summary: normativeWgsl.summary,
            },
            dependencies: {
                path: relative(normativeArtifactPaths.dependencies),
                summary: capabilityDependencies.summary,
            },
            proposals: {
                path: relative(normativeArtifactPaths.proposals),
                summary: proposalWatchlist.summary,
            },
        },
        frozen: {
            webgpu: {
                path: relative(webGpuManifestPath),
                summary: frozenWebGpu.summary,
            },
            wgsl: {
                path: relative(wgslManifestPath),
                summary: frozenWgsl.summary,
            },
        },
    },
    evidenceUseCounts: Object.fromEntries(
        [ ...evidenceUseCounts.entries() ].sort(
            ([ left ], [ right ]) => left.localeCompare(right)
        )
    ),
    publicEntrypoints: {
        requiredPackage: requiredRuntimeExports.filter(
            name => name in packageEntrypoint
        ),
        requiredScratch: requiredRuntimeExports.filter(
            name => name in scratchEntrypoint
        ),
        packageRuntimeValueCount: packageRuntimeExportNames.length,
        scratchRuntimeValueCount: scratchRuntimeExportNames.length,
        missingFromPackage: scratchRuntimeExportNames.filter(
            name => !packageRuntimeExportNames.includes(name)
        ),
        missingFromScratch: packageRuntimeExportNames.filter(
            name => !scratchRuntimeExportNames.includes(name)
        ),
        sourceDeclarationExportCount: packageSourceExportNames.size,
        compatibilityShim: 'export-all',
    },
    pointerProofSources: {
        extractionError: pointerProofCases.error,
        caseNames: [ ...pointerProofCases.cases.keys() ].sort(),
    },
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
if (failures.length > 0) process.exitCode = 1

function currentEntriesCloseNormativeInventories() {

    const expected = [
        ...normativeWebGpu.entries.map(entry => ({
            id: entry.id,
            domain: 'webgpu',
            anchor: entry.sourceAnchor,
            manifest: relative(normativeArtifactPaths.webgpu),
        })),
        ...normativeWgsl.entries.map(entry => ({
            id: entry.id,
            domain: 'wgsl',
            anchor: entry.sourceAnchor,
            manifest: relative(normativeArtifactPaths.wgsl),
        })),
    ].sort((left, right) => left.id.localeCompare(right.id))
    const actual = current.entries.map(entry => ({
        id: entry.id,
        domain: entry.domain,
        anchor: entry.source.anchor,
        manifest: entry.source.normativeManifest,
    }))
    return deepEqual(actual, expected)
}

function normativeAuthorityIsExplicit() {

    const source = readText(
        'scripts/scratch-webgpu-wgsl-current-coverage.mjs'
    )
    return (
        deepEqual(
            Object.keys(current.normativeManifests).sort(),
            [ 'dependencies', 'proposals', 'webgpu', 'wgsl' ]
        ) &&
        deepEqual(
            Object.keys(current.frozenManifests).sort(),
            [ 'webgpuHistoricalBaseline', 'wgslHistoricalBaseline' ]
        ) &&
        !/\bcreateWgslManifest\s*\(/.test(source) &&
        !/\benableExtensionContracts\b/.test(source) &&
        !source.includes('shader-semantic-domain') &&
        !/catch[- ]?all/i.test(source)
    )
}

function webGpuClassifierUsesFiniteMappings() {

    const source = readText(
        'scripts/scratch-webgpu-wgsl-current-coverage.mjs'
    )
    return (
        source.includes('webGpuOwnerRules') &&
        source.includes('webGpuExactRules') &&
        !source.includes('/Buffer/.test(owner)') &&
        !source.includes('/Texture/.test(owner)') &&
        !source.includes('/RenderPass|ComputePass/.test(owner)') &&
        !source.includes("allocationEvidence ?? 'webgpu-runtime-capabilities'")
    )
}

function enableAndLanguageRequirementsMatchInventory() {

    if (!enableExtensions.entries.every(entry =>
        entry.requiredLanguageFeatures.length === 0
    )) {
        return false
    }
    const languageDevice = new Map()
    const languageEnable = new Map()
    for (const dependency of capabilityDependencies.entries) {
        if (dependency.kind === 'language-to-device-prerequisite') {
            const features = languageDevice.get(
                dependency.languageFeature
            ) ?? []
            features.push(dependency.requiredFeature)
            languageDevice.set(dependency.languageFeature, features)
        } else if (
            dependency.kind === 'language-to-enable-prerequisite'
        ) {
            const extensions = languageEnable.get(
                dependency.languageFeature
            ) ?? []
            extensions.push(dependency.requiredEnableExtension)
            languageEnable.set(dependency.languageFeature, extensions)
        }
    }
    return current.entries
        .filter(entry => entry.kind === 'language-extension')
        .every((entry) => {
            const languageFeature = entry.id.slice(
                'language-extension.'.length
            )
            return (
                deepEqual(
                    entry.requirements.languageFeatures,
                    [ languageFeature ]
                ) &&
                deepEqual(
                    entry.requirements.deviceFeatures,
                    uniqueSorted(
                        languageDevice.get(languageFeature) ?? []
                    )
                ) &&
                deepEqual(
                    entry.requirements.enableExtensions,
                    uniqueSorted(
                        languageEnable.get(languageFeature) ?? []
                    )
                )
            )
        })
}

function proposalsRemainNonNormative() {

    const proposalIds = new Set(
        proposalWatchlist.entries.map(entry => entry.id)
    )
    return (
        proposalWatchlist.normative === false &&
        proposalWatchlist.status === 'complete' &&
        proposalWatchlist.unresolved.length === 0 &&
        current.entries.every(entry => !proposalIds.has(entry.id)) &&
        proposalWatchlist.entries
            .filter(entry => entry.status !== 'merged')
            .every(entry => entry.normative === false)
    )
}

function evidenceAttributionRegressionsPass() {

    const entries = new Map(current.entries.map(entry => [ entry.id, entry ]))
    return (
        entryProofMatches(entries, 'GPUDevice.createRenderBundleEncoder', {
            coverageRule: 'webgpu:device:createRenderBundleEncoder',
            profile: 'render-bundle-create',
            evidenceIds: [ 'webgpu-render-bundle-debug' ],
            publicSymbols: [
                'RenderBundle',
                'RenderBundleDescriptor',
                'ScratchRuntime',
            ],
            operations: [ 'createRenderBundleEncoder' ],
            sourcePaths: [
                'packages/geoscratch/src/scratch/render-bundle.ts',
            ],
        }) &&
        entryProofMatches(entries, 'GPURenderPassEncoder.executeBundles', {
            coverageRule: 'webgpu:render-pass:executeBundles',
            profile: 'render-bundle-execute',
            evidenceIds: [ 'webgpu-render-bundle-debug' ],
            publicSymbols: [
                'ExecuteRenderBundlesCommand',
                'RenderBundle',
            ],
            operations: [ 'executeBundles' ],
            sourcePaths: [
                'packages/geoscratch/src/scratch/render-bundle.ts',
            ],
        }) &&
        entryProofMatches(entries, 'interface.GPUCommandBufferDescriptor', {
            coverageRule: 'webgpu:submission:command-buffer',
            profile: 'submission-command-buffer',
            evidenceIds: [ 'webgpu-submission' ],
            publicSymbols: [ 'SubmissionBuilder', 'SubmittedWork' ],
            operations: [ 'GPUCommandEncoder.finish' ],
            sourcePaths: [
                'packages/geoscratch/src/scratch/submission.ts',
            ],
        }) &&
        entryProofMatches(entries, 'interface.GPUVertexBufferLayout', {
            coverageRule: 'webgpu:pipeline:vertex-buffer-layout',
            profile: 'pipeline-vertex-buffer-layout',
            evidenceIds: [ 'webgpu-pipelines' ],
            publicSymbols: [
                'ScratchRenderPipeline',
                'ScratchRenderPipelineDescriptor',
            ],
            operations: [ 'createRenderPipelineAsync' ],
            sourcePaths: [
                'packages/geoscratch/src/scratch/pipeline-creation.ts',
            ],
        }) &&
        entryProofMatches(entries, 'interface.GPUTexelCopyTextureInfo', {
            coverageRule: 'webgpu:copy:texture-info',
            profile: 'copy-texture-info',
            evidenceIds: [ 'webgpu-copy-upload' ],
            publicSymbols: [ 'CopyCommand', 'TextureCopyCommandSourceDescriptor' ],
            operations: [
                'copyBufferToTexture',
                'copyTextureToBuffer',
                'copyTextureToTexture',
            ],
            sourcePaths: [
                'packages/geoscratch/src/scratch/command.ts',
            ],
        }) &&
        entryProofMatches(entries, 'interface.GPUSupportedLimits', {
            coverageRule: 'webgpu:runtime:supported-limits',
            profile: 'runtime-supported-limits',
            evidenceIds: [ 'webgpu-runtime-capabilities' ],
            publicSymbols: [ 'ScratchRuntime', 'ScratchRuntimeRequestFacts' ],
            operations: [ 'adapter.limits', 'device.limits' ],
            sourcePaths: [
                'packages/geoscratch/src/scratch/runtime.ts',
            ],
        }) &&
        deepEqual(
            entries.get('interface.GPUSupportedLimits')
                ?.requirements.limits,
            []
        )
    )
}

function intentionalSemanticEquivalentsRemainExplicit() {

    const ids = [
        'GPUDevice.createComputePipeline',
        'GPUDevice.createRenderPipeline',
        'GPUDevice.onuncapturederror',
        'GPUDevice.popErrorScope',
        'GPUDevice.pushErrorScope',
        'GPUDevice.queue',
        'GPUInternalError.constructor',
        'GPUObjectBase.label',
        'GPUOutOfMemoryError.constructor',
        'GPUPipelineError.constructor',
        'GPUUncapturedErrorEvent.constructor',
        'GPUValidationError.constructor',
        'interface.GPUCommandBuffer',
        'interface.GPUCommandBufferDescriptor',
        'interface.GPUSupportedLimits',
    ]
    const entries = new Map(current.entries.map(entry => [ entry.id, entry ]))
    return ids.every(id =>
        entries.get(id)?.current.classification ===
            'managed-semantic-equivalent'
    )
}

function heterogeneousOwnerProfilesAreSplit() {

    const entries = new Map(current.entries.map(entry => [ entry.id, entry ]))
    const expected = new Map([
        [
            'GPUBindGroupDescriptor.entries',
            [ 'binding-set', [ 'createBindGroup' ] ],
        ],
        [
            'GPUBindGroupLayoutDescriptor.entries',
            [ 'binding-layout', [ 'createBindGroupLayout' ] ],
        ],
        [
            'GPUComputePipelineDescriptor.compute',
            [ 'pipeline-compute', [ 'createComputePipelineAsync' ] ],
        ],
        [
            'GPURenderPipelineDescriptor.vertex',
            [ 'pipeline-render', [ 'createRenderPipelineAsync' ] ],
        ],
        [
            'GPUComputePassTimestampWrites.querySet',
            [ 'compute-pass-timestamp', [ 'beginComputePass' ] ],
        ],
        [
            'GPURenderPassTimestampWrites.querySet',
            [ 'render-pass-timestamp', [ 'beginRenderPass' ] ],
        ],
        [
            'GPUShaderModuleDescriptor.code',
            [ 'shader-module-create', [ 'createShaderModule' ] ],
        ],
        [
            'GPUCompilationMessage.message',
            [ 'shader-compilation-info', [ 'getCompilationInfo' ] ],
        ],
        [
            'GPUTextureDescriptor.size',
            [ 'texture-allocation', [ 'createTexture' ] ],
        ],
        [
            'GPUTextureViewDescriptor.dimension',
            [ 'texture-view', [ 'GPUTexture.createView' ] ],
        ],
        [
            'interface.GPUCommandEncoderDescriptor',
            [ 'command-encoder-create', [ 'createCommandEncoder' ] ],
        ],
        [
            'interface.GPURenderBundleDescriptor',
            [ 'render-bundle-finish', [ 'GPURenderBundleEncoder.finish' ] ],
        ],
        [
            'interface.GPURenderBundleEncoderDescriptor',
            [ 'render-bundle-create', [ 'createRenderBundleEncoder' ] ],
        ],
        [
            'interface.GPUExternalTextureBindingLayout',
            [ 'binding-layout', [ 'createBindGroupLayout' ] ],
        ],
        [
            'GPUTexelCopyTextureInfo.texture',
            [
                'copy-texture-info',
                [
                    'copyBufferToTexture',
                    'copyTextureToBuffer',
                    'copyTextureToTexture',
                ],
            ],
        ],
    ])
    return [ ...expected ].every(([ id, [ profile, operations ] ]) => {
        const entry = entries.get(id)
        return (
            entry?.proof.profile === profile &&
            deepEqual(entry.nativeLowering.operations, operations)
        )
    })
}

function entryProofMatches(entries, id, expected) {

    const entry = entries.get(id)
    return (
        entry !== undefined &&
        entry.proof !== undefined &&
        entry.coverageRule === expected.coverageRule &&
        entry.proof.granularity === 'entry' &&
        entry.proof.profile === expected.profile &&
        deepEqual(entry.proof.selector, { id }) &&
        deepEqual(entry.evidenceIds, expected.evidenceIds) &&
        deepEqual(entry.expression.publicSymbols, expected.publicSymbols) &&
        deepEqual(entry.nativeLowering.operations, expected.operations) &&
        deepEqual(entry.nativeLowering.sourcePaths, expected.sourcePaths)
    )
}

function entryEvidenceIsEntrySpecific(entry) {

    if (
        entry.proof === undefined ||
        !Array.isArray(entry.nativeLowering.operationEvidence)
    ) {
        return false
    }
    if (entry.domain === 'webgpu') {
        if (
            entry.proof.granularity !== 'entry' ||
            !deepEqual(entry.proof.selector, { id: entry.id })
        ) {
            return false
        }
    } else if (entry.kind === 'semantic-section') {
        if (
            entry.proof.granularity !== 'normative-family' ||
            !deepEqual(entry.proof.selector, {
                kind: entry.kind,
                family: normativeWgsl.entries.find(
                    candidate => candidate.id === entry.id
                )?.family,
            })
        ) {
            return false
        }
    } else if (
        entry.proof.granularity !== 'normative-kind' ||
        !deepEqual(entry.proof.selector, { kind: entry.kind })
    ) {
        return false
    }

    if (entry.current.status !== 'managed') {
        return (
            entry.nativeLowering.operationEvidence.length === 0 &&
            entry.nativeLowering.operations.length === 0 &&
            entry.nativeLowering.sourcePaths.length === 0
        )
    }
    const operationEvidence = entry.nativeLowering.operationEvidence
    return (
        entry.expression.contract.includes(entry.id) &&
        operationEvidence.length > 0 &&
        new Set(operationEvidence.map(item =>
            `${item.operation}\0${item.sourcePath}`
        )).size === operationEvidence.length &&
        deepEqual(
            entry.nativeLowering.operations,
            uniqueSorted(operationEvidence.map(item => item.operation))
        ) &&
        deepEqual(
            entry.nativeLowering.sourcePaths,
            uniqueSorted(operationEvidence.map(item => item.sourcePath))
        )
    )
}

function unknownDeviceMemberFailsClosed() {

    const classify = currentCoverageModule.classifyWebGpuEntry
    return (
        typeof classify === 'function' &&
        currentCoverageModule.hasWebGpuOwnerRule?.('GPUDevice') ===
            false &&
        throws(() => classify({
            id: 'GPUDevice.unknownFutureMember',
            kind: 'method',
            owner: 'GPUDevice',
            member: 'unknownFutureMember',
            sourceAnchor: 'device',
        }))
    )
}

function webGpuMethodsHaveExactOperationEvidence() {

    const entries = new Map(current.entries.map(entry => [ entry.id, entry ]))
    const semanticOperationOverrides = new Map([
        [ 'GPUDevice.createComputePipeline', 'createComputePipelineAsync' ],
        [ 'GPUDevice.createRenderPipeline', 'createRenderPipelineAsync' ],
        [ 'GPUInternalError.constructor', 'serializeNativeGpuError' ],
        [ 'GPUOutOfMemoryError.constructor', 'serializeNativeGpuError' ],
        [ 'GPUPipelineError.constructor', 'serializeNativeGpuError' ],
        [ 'GPUUncapturedErrorEvent.constructor', 'serializeNativeGpuError' ],
        [ 'GPUValidationError.constructor', 'serializeNativeGpuError' ],
    ])
    return normativeWebGpu.entries
        .filter(entry => entry.kind === 'method')
        .every((entry) => {
            const operationEvidence =
                entries.get(entry.id)?.nativeLowering.operationEvidence
            const expectedOperation =
                semanticOperationOverrides.get(entry.id) ?? entry.member
            return (
                currentCoverageModule.hasWebGpuExactRule?.(entry.id) ===
                    true &&
                operationEvidence?.length === 1 &&
                operationEvidence[0].operation
                    .split('.').at(-1) === expectedOperation
            )
        })
}

function entryShapeIsComplete(entry) {

    return (
        typeof entry.id === 'string' &&
        entry.id.length > 0 &&
        typeof entry.domain === 'string' &&
        typeof entry.kind === 'string' &&
        typeof entry.source === 'object' &&
        typeof entry.source.url === 'string' &&
        entry.source.url.startsWith('https://') &&
        typeof entry.source.anchor === 'string' &&
        entry.source.anchor.length > 0 &&
        typeof entry.source.normativeManifest === 'string' &&
        entry.source.normativeManifest.length > 0 &&
        typeof entry.goalStart === 'object' &&
        typeof entry.goalStart.status === 'string' &&
        typeof entry.goalStart.rationale === 'string' &&
        entry.goalStart.rationale.length > 0 &&
        typeof entry.coverageRule === 'string' &&
        entry.coverageRule.length > 0 &&
        typeof entry.proof === 'object' &&
        [ 'entry', 'normative-kind', 'normative-family' ]
            .includes(entry.proof.granularity) &&
        typeof entry.proof.profile === 'string' &&
        entry.proof.profile.length > 0 &&
        typeof entry.proof.selector === 'object' &&
        [ 'managed', 'not-applicable', 'unresolved' ]
            .includes(entry.current.status) &&
        typeof entry.current.rationale === 'string' &&
        entry.current.rationale.length > 0 &&
        typeof entry.expression === 'object' &&
        Array.isArray(entry.expression.publicSymbols) &&
        typeof entry.nativeLowering === 'object' &&
        Array.isArray(entry.nativeLowering.sourcePaths) &&
        Array.isArray(entry.nativeLowering.operations) &&
        Array.isArray(entry.nativeLowering.operationEvidence) &&
        typeof entry.requirements === 'object' &&
        Array.isArray(entry.requirements.enableExtensions) &&
        Array.isArray(entry.requirements.deviceFeatures) &&
        Array.isArray(entry.requirements.languageFeatures) &&
        Array.isArray(entry.requirements.limits) &&
        Array.isArray(entry.requirements.dependencies) &&
        Array.isArray(entry.requirements.conditions) &&
        typeof entry.requirements.policy === 'string' &&
        entry.requirements.policy.length > 0 &&
        Array.isArray(entry.evidenceIds)
    )
}

function evidenceIsLocatedAndBounded(record) {

    const used = evidenceUseCounts.get(record.id) ?? 0
    const paths = [
        ...record.sourcePaths,
        ...record.testPaths,
        ...record.browserPaths,
    ]
    return (
        typeof record.id === 'string' &&
        record.id.length > 0 &&
        !/catch[- ]?all/i.test(record.id) &&
        typeof record.claim === 'string' &&
        record.claim.length > 0 &&
        !/catch[- ]?all/i.test(record.claim) &&
        record.sourcePaths.length > 0 &&
        record.testPaths.length > 0 &&
        paths.every(relativePath =>
            fs.existsSync(path.join(root, relativePath))
        ) &&
        used > 0 &&
        record.sourcePaths.length <= 5 &&
        record.testPaths.length <= 3 &&
        record.browserPaths.length <= 1
    )
}

function evidenceNativeOperationsResolve(record) {

    const source = record.sourcePaths.map(readText).join('\n')
    return record.nativeOperations.every((operation) => {
        const token = operation.split('.').at(-1)
        return typeof token === 'string' && source.includes(token)
    })
}

function entryNativeOperationsResolve(entry) {

    if (!Array.isArray(entry.nativeLowering.operationEvidence)) return false
    return entry.nativeLowering.operationEvidence.every((item) => {
        if (
            typeof item.operation !== 'string' ||
            item.operation.length === 0 ||
            typeof item.sourcePath !== 'string' ||
            item.sourcePath.length === 0 ||
            !entry.nativeLowering.operations.includes(item.operation) ||
            !entry.nativeLowering.sourcePaths.includes(item.sourcePath)
        ) {
            return false
        }
        const token = item.operation.split('.').at(-1)
        return (
            typeof token === 'string' &&
            fs.existsSync(path.join(root, item.sourcePath)) &&
            readText(item.sourcePath).includes(token)
        )
    })
}

function requirementContractIsComplete(entry) {

    return entry.requirements.conditions.every(condition => (
        typeof condition.when === 'string' &&
        condition.when.length > 0 &&
        Array.isArray(condition.deviceFeatures) &&
        Array.isArray(condition.languageFeatures) &&
        Array.isArray(condition.limits) &&
        Array.isArray(condition.dependencies) &&
        (
            condition.deviceFeatureAlternatives === undefined ||
            (
                Array.isArray(condition.deviceFeatureAlternatives) &&
                condition.deviceFeatureAlternatives.length > 0 &&
                condition.deviceFeatureAlternatives.every(alternative =>
                    Array.isArray(alternative) &&
                    alternative.length > 0
                )
            )
        ) &&
        (
            condition.deviceFeatures.length > 0 ||
            condition.languageFeatures.length > 0 ||
            condition.limits.length > 0 ||
            condition.dependencies.length > 0 ||
            (condition.deviceFeatureAlternatives?.length ?? 0) > 0
        )
    ))
}

function requirementValuesAreTypedKnownAndUnique(entry) {

    const direct = entry.requirements
    return (
        knownStringArray(direct.enableExtensions, knownEnableExtensions) &&
        knownStringArray(direct.deviceFeatures, knownDeviceFeatures) &&
        knownStringArray(direct.languageFeatures, knownLanguageFeatures) &&
        knownStringArray(direct.limits, knownLimits) &&
        knownStringArray(direct.dependencies, knownDependencies) &&
        direct.conditions.every(condition =>
            knownStringArray(
                condition.deviceFeatures,
                knownDeviceFeatures
            ) &&
            knownStringArray(
                condition.languageFeatures,
                knownLanguageFeatures
            ) &&
            knownStringArray(condition.limits, knownLimits) &&
            knownStringArray(
                condition.dependencies,
                knownDependencies
            ) &&
            (
                condition.deviceFeatureAlternatives === undefined ||
                (
                    Array.isArray(condition.deviceFeatureAlternatives) &&
                    uniqueJsonValues(
                        condition.deviceFeatureAlternatives
                    ) &&
                    condition.deviceFeatureAlternatives.every(
                        alternative =>
                            knownStringArray(
                                alternative,
                                knownDeviceFeatures
                            )
                    )
                )
            )
        )
    )
}

function invalidRequirementContractsFailClosed() {

    const assertRequirements =
        currentCoverageModule.assertCoverageRequirements
    if (typeof assertRequirements !== 'function') return false
    const valid = {
        enableExtensions: [],
        deviceFeatures: [],
        languageFeatures: [],
        limits: [],
        dependencies: [],
        conditions: [],
        policy: 'test requirement contract',
    }
    return (
        doesNotThrow(() => assertRequirements(valid, 'test.valid')) &&
        throws(() => assertRequirements({
            ...valid,
            limits: [ null ],
        }, 'test.null-limit')) &&
        throws(() => assertRequirements({
            ...valid,
            limits: [ 'maxBufferSize', 'maxBufferSize' ],
        }, 'test.duplicate-limit')) &&
        throws(() => assertRequirements({
            ...valid,
            deviceFeatures: [ 'not-a-webgpu-feature' ],
        }, 'test.unknown-feature')) &&
        throws(() => assertRequirements({
            ...valid,
            limits: [ 'notAWebGpuLimit' ],
        }, 'test.unknown-limit')) &&
        throws(() => assertRequirements({
            ...valid,
            conditions: [
                {
                    when: 'invalid condition',
                    deviceFeatures: [],
                    languageFeatures: [],
                    limits: [],
                    dependencies: [ null ],
                },
            ],
        }, 'test.null-condition-dependency'))
    )
}

function knownStringArray(values, authority) {

    return (
        Array.isArray(values) &&
        values.every(value =>
            typeof value === 'string' &&
            value.length > 0 &&
            authority.has(value)
        ) &&
        new Set(values).size === values.length &&
        deepEqual(values, [ ...values ].sort())
    )
}

function uniqueJsonValues(values) {

    return (
        new Set(values.map(value => JSON.stringify(value))).size ===
        values.length
    )
}

function sensitiveCapabilityRequirementsArePresent() {

    const entries = new Map(current.entries.map(entry => [ entry.id, entry ]))
    const hasCondition = (id, expected) =>
        entries.get(id)?.requirements.conditions.some(condition =>
            deepEqual(condition, expected)
        ) === true
    const textureFormatConditions =
        entries.get('type.GPUTextureFormat')?.requirements.conditions ?? []
    const textureFeatureText = JSON.stringify(textureFormatConditions)
    return (
        entries.get('GPU.requestAdapter')?.evidenceIds[0] ===
            'webgpu-runtime-capabilities' &&
        entries.get('GPU.getPreferredCanvasFormat')?.evidenceIds[0] ===
            'webgpu-surface-presentation' &&
        entries.get('GPU.wgslLanguageFeatures')?.evidenceIds[0] ===
            'webgpu-runtime-capabilities' &&
        entries.get('GPUBindingCommandsMixin.setImmediates')?.evidenceIds[0] ===
            'wgsl-immediate-data' &&
        hasCondition('GPUPrimitiveState.unclippedDepth', {
            when: 'unclippedDepth is true',
            deviceFeatures: [ 'depth-clip-control' ],
            languageFeatures: [],
            limits: [],
            dependencies: [],
        }) &&
        hasCondition('GPUComputePassDescriptor.timestampWrites', {
            when: 'timestampWrites is provided',
            deviceFeatures: [ 'timestamp-query' ],
            languageFeatures: [],
            limits: [],
            dependencies: [],
        }) &&
        hasCondition('GPUTextureViewDescriptor.swizzle', {
            when: 'swizzle is not the identity "rgba"',
            deviceFeatures: [ 'texture-component-swizzle' ],
            languageFeatures: [],
            limits: [],
            dependencies: [],
        }) &&
        textureFeatureText.includes('texture-compression-bc') &&
        textureFeatureText.includes('texture-compression-etc2') &&
        textureFeatureText.includes('texture-compression-astc') &&
        textureFeatureText.includes('depth32float-stencil8') &&
        textureFeatureText.includes('bgra8unorm-storage') &&
        textureFeatureText.includes('float32-filterable') &&
        textureFeatureText.includes('float32-blendable') &&
        textureFeatureText.includes('texture-formats-tier1') &&
        textureFeatureText.includes('texture-formats-tier2')
    )
}

function managedEntryUsesRawEscapeHatch(entry) {

    const forbidden = [
        'scratchruntime.device',
        'scratchruntime.queue',
        'runtime.device',
        'runtime.queue',
        'gpudevice',
        'gpuqueue',
        'raw escape',
        'escape hatch',
    ]
    const expressionText = JSON.stringify({
        ...entry.expression,
        contract: entry.expression.contract.replaceAll(entry.id, ''),
    }).toLowerCase()
    return forbidden.some(value => expressionText.includes(value.toLowerCase()))
}

function enableContractFact(entry) {

    return {
        extension: entry.extension,
        requiredFeatures: entry.requiredFeatures,
        dependencies: entry.dependencies,
    }
}

function featureDependencySourceIsShared() {

    const contract = readText(
        'packages/geoscratch/src/scratch/feature-contract.ts'
    )
    const runtime = readText('packages/geoscratch/src/scratch/runtime.ts')
    const program = readText('packages/geoscratch/src/scratch/program.ts')
    return (
        contract.includes("feature: 'subgroup-size-control'") &&
        contract.includes("requiredFeature: 'subgroups'") &&
        runtime.includes("from './feature-contract.js'") &&
        program.includes("from './feature-contract.js'") &&
        runtime.includes('findMissingScratchFeatureDependency') &&
        program.includes('findMissingScratchFeatureDependency') &&
        !runtime.includes("requiredFeatures.push('subgroups')") &&
        !program.includes("requiredFeatures.push('subgroups')")
    )
}

function dependencyDiagnosticIsDocumented() {

    const english = readText(
        'docs/vision/scratch-api/09-diagnostics-validation/README.md'
    )
    const chinese = readText(
        'docs/vision/scratch-api/09-diagnostics-validation/README_zh.md'
    )
    const programsEnglish = readText(
        'docs/vision/scratch-api/08-programs-codecs/README.md'
    )
    const programsChinese = readText(
        'docs/vision/scratch-api/08-programs-codecs/README_zh.md'
    )
    return [ english, chinese, programsEnglish, programsChinese ].every(
        source => source.includes(
            'SCRATCH_PROGRAM_FEATURE_DEPENDENCY_MISSING'
        )
    )
}

function browserMatrixIsManagedAndSelfContained() {

    const source = readText(
        'tests/browser/scratch-wgsl-capability-matrix.mjs'
    )
    return (
        source.includes("headless: false") &&
        source.includes('ScratchRuntime.create') &&
        source.includes('runtime.createShaderModule') &&
        source.includes('runtime.createProgram') &&
        source.includes('runtime.createComputePipeline') &&
        source.includes('runtime.createRenderPipeline') &&
        source.includes('runtime.createReadback') &&
        source.includes('startVite') &&
        source.includes('stopVite') &&
        source.includes('expectedEnableProofNames') &&
        source.includes('expectedLanguageProofNames') &&
        source.includes('dot4U8Packed') &&
        source.includes('ptr<storage') &&
        source.includes('@builtin(subgroup_id)') &&
        source.includes('diagnostic(error, subgroup_uniformity)') &&
        source.includes('texture_storage_2d<r32uint, read_write>') &&
        source.includes('texture_storage_2d<r16unorm, write>') &&
        source.includes('@builtin(global_invocation_index)') &&
        source.includes('let localTexture') &&
        source.includes('powerPreference: adapterPowerPreference') &&
        source.includes('events.consoleErrors.length') &&
        !source.includes('runLanguageDirectiveProof') &&
        !source.includes('runtime.device.create') &&
        !source.includes('runtime.queue.')
    )
}

function unrestrictedPointerProofSourceIsConformant(proof) {

    const source = proof?.source ?? ''
    return (
        proof?.expected === 103 &&
        normalizeWgslSource(source) ===
            normalizeWgslSource(unrestrictedPointerProofSource)
    )
}

function pointerCompositeProofSourceIsConformant(proof) {

    const source = proof?.source ?? ''
    return (
        proof?.expected === 104 &&
        normalizeWgslSource(source) ===
            normalizeWgslSource(pointerCompositeProofSource)
    )
}

function tryExtractSemanticCases(relativePath, requiredNames) {

    try {
        return {
            cases: extractSemanticCases(relativePath, requiredNames),
            error: undefined,
        }
    } catch (error) {
        return {
            cases: new Map(),
            error: error instanceof Error ? error.message : String(error),
        }
    }
}

function extractSemanticCases(relativePath, requiredNames) {

    const source = readText(relativePath)
    const file = ts.createSourceFile(
        relativePath,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JS
    )
    if (file.parseDiagnostics.length > 0) {
        throw new Error(
            `${relativePath} has ${file.parseDiagnostics.length} parse diagnostics`
        )
    }
    const declarations = []
    visit(file)

    function visit(node) {

        if (
            ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.name.text === 'semanticCases'
        ) {
            declarations.push(node)
        }
        ts.forEachChild(node, visit)
    }

    if (declarations.length !== 1) {
        throw new Error(
            `Expected one semanticCases declaration, found ${declarations.length}`
        )
    }
    const initializer = declarations[0].initializer
    if (!ts.isObjectLiteralExpression(initializer)) {
        throw new Error('semanticCases must be an object literal')
    }

    const required = new Set(requiredNames)
    const cases = new Map()
    for (const property of initializer.properties) {
        if (!ts.isPropertyAssignment(property)) {
            throw new Error(
                'semanticCases must contain only static property assignments'
            )
        }
        const caseName = staticPropertyName(property.name)
        if (caseName === undefined) {
            throw new Error(
                'semanticCases must contain only static property assignments'
            )
        }
        if (!required.has(caseName)) continue
        if (cases.has(caseName)) {
            throw new Error(`Duplicate semantic case ${caseName}`)
        }
        if (!ts.isObjectLiteralExpression(property.initializer)) {
            throw new Error(`Semantic case ${caseName} must be an object literal`)
        }
        const propertyNames = property.initializer.properties.map(
            selectedProperty => {
                if (!ts.isPropertyAssignment(selectedProperty)) {
                    throw new Error(
                        `Semantic case ${caseName} must have exactly static ` +
                        'source and expected properties'
                    )
                }
                return staticPropertyName(selectedProperty.name)
            }
        )
        if (
            propertyNames.length !== 2 ||
            !propertyNames.includes('source') ||
            !propertyNames.includes('expected') ||
            propertyNames.some(name => name === undefined)
        ) {
            throw new Error(
                `Semantic case ${caseName} must have exactly static ` +
                'source and expected properties'
            )
        }
        const sourceProperty = findProperty(property.initializer, 'source')
        const expectedProperty = findProperty(property.initializer, 'expected')
        if (
            sourceProperty === undefined ||
            !ts.isNoSubstitutionTemplateLiteral(sourceProperty.initializer)
        ) {
            throw new Error(
                `Semantic case ${caseName} must have a static source template`
            )
        }
        if (
            expectedProperty === undefined ||
            !ts.isNumericLiteral(expectedProperty.initializer)
        ) {
            throw new Error(
                `Semantic case ${caseName} must have a numeric expected value`
            )
        }
        cases.set(caseName, {
            source: sourceProperty.initializer.text,
            expected: Number(expectedProperty.initializer.text),
        })
    }
    for (const requiredName of required) {
        if (!cases.has(requiredName)) {
            throw new Error(`Missing semantic case ${requiredName}`)
        }
    }
    return cases
}

function normalizeWgslSource(source) {

    return source.replace(/\r\n?/g, '\n').trim()
}

function findProperty(object, name) {

    const matches = object.properties.filter(property =>
        ts.isPropertyAssignment(property) &&
        staticPropertyName(property.name) === name
    )
    if (matches.length > 1) {
        throw new Error(`Duplicate property ${name}`)
    }
    return matches[0]
}

function staticPropertyName(name) {

    if (
        ts.isIdentifier(name) ||
        ts.isStringLiteral(name) ||
        ts.isNoSubstitutionTemplateLiteral(name)
    ) {
        return name.text
    }
    return undefined
}

function declarationEntrypointParityIsExact() {

    const sourceShim = readText('packages/geoscratch/src/scratch.ts').trim()
    const emittedShim = readText('packages/geoscratch/dist/scratch.d.ts').trim()
    return (
        sourceShim === "export * from './index.js'" &&
        emittedShim === "export * from './index.js';"
    )
}

function collectNamedExports(relativePath) {

    const source = readText(relativePath)
    const file = ts.createSourceFile(
        relativePath,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS
    )
    const names = new Set()
    for (const statement of file.statements) {
        if (
            !ts.isExportDeclaration(statement) ||
            statement.exportClause === undefined ||
            !ts.isNamedExports(statement.exportClause)
        ) {
            continue
        }
        for (const element of statement.exportClause.elements) {
            names.add(element.name.text)
        }
    }
    return names
}

function collectStringLiteralTypeMembers(relativePath, typeName) {

    const source = readText(relativePath)
    const file = ts.createSourceFile(
        relativePath,
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
        throw new Error(
            `Expected one ${typeName} declaration, found ${declarations.length}`
        )
    }
    const type = declarations[0].type
    const members = ts.isUnionTypeNode(type) ? type.types : [ type ]
    const values = members.map((member) => {
        if (
            !ts.isLiteralTypeNode(member) ||
            !ts.isStringLiteral(member.literal)
        ) {
            throw new Error(`${typeName} contains a non-string member`)
        }
        return member.literal.text
    })
    return new Set(values)
}

function throws(operation) {

    try {
        operation()
        return false
    } catch {
        return true
    }
}

function doesNotThrow(operation) {

    try {
        operation()
        return true
    } catch {
        return false
    }
}

function readJson(absolute) {

    return JSON.parse(fs.readFileSync(absolute, 'utf8'))
}

function readText(relativePath) {

    return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

function deepEqual(left, right) {

    return JSON.stringify(left) === JSON.stringify(right)
}

function uniqueSorted(values) {

    return [ ...new Set(values) ].sort()
}

function relative(absolute) {

    return path.relative(root, absolute).split(path.sep).join('/')
}
