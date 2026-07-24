import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import ts from 'typescript'
import {
    createCurrentCoverageManifest,
    createWgslEnableExtensionManifest,
    currentCoverageManifestPath,
    wgslEnableExtensionManifestPath,
} from '../../scripts/scratch-webgpu-wgsl-current-coverage.mjs'
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
        current.summary.byClassification['managed-first-class'] === 683 &&
        current.summary.byClassification['managed-semantic-equivalent'] === 559 &&
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
    evidenceIsLocatedAndBounded:
        current.evidence.every(evidenceIsLocatedAndBounded),
    evidenceNativeOperationsResolve:
        current.evidence.every(evidenceNativeOperationsResolve),
    evidencePublicSymbolsAreExported:
        current.evidence.every(record =>
            record.publicSymbols.every(symbol =>
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
                        {
                            feature: 'subgroup-size-control',
                            requiredFeature: 'subgroups',
                        },
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
        !/fallback|catch[- ]?all/i.test(source)
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
        [ 'managed', 'not-applicable', 'unresolved' ]
            .includes(entry.current.status) &&
        typeof entry.current.rationale === 'string' &&
        entry.current.rationale.length > 0 &&
        typeof entry.expression === 'object' &&
        Array.isArray(entry.expression.publicSymbols) &&
        typeof entry.nativeLowering === 'object' &&
        Array.isArray(entry.nativeLowering.sourcePaths) &&
        Array.isArray(entry.nativeLowering.operations) &&
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
    const expressionText = JSON.stringify(entry.expression).toLowerCase()
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
