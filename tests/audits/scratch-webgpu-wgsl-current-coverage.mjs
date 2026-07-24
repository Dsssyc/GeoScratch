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

const root = process.cwd()
const current = readJson(currentCoverageManifestPath)
const enableExtensions = readJson(wgslEnableExtensionManifestPath)
const generatedCurrent = createCurrentCoverageManifest()
const generatedEnableExtensions = createWgslEnableExtensionManifest()
const frozenWebGpu = readJson(webGpuManifestPath)
const frozenWgsl = readJson(wgslManifestPath)
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

const checks = {
    currentManifestReproducible: deepEqual(current, generatedCurrent),
    enableExtensionManifestReproducible:
        deepEqual(enableExtensions, generatedEnableExtensions),
    frozenWebGpuManifestUnchanged:
        deepEqual(frozenWebGpu, generatedFrozenWebGpu),
    frozenWgslManifestUnchanged:
        deepEqual(frozenWgsl, generatedFrozenWgsl),
    exactEntryCounts:
        current.summary.entryCount === 662 &&
        current.summary.webgpuEntryCount === 591 &&
        current.summary.wgslBaselineEntryCount === 65 &&
        current.summary.wgslEnableExtensionEntryCount === 6,
    exactCurrentClassifications:
        current.summary.byClassification['managed-first-class'] === 415 &&
        current.summary.byClassification['managed-semantic-equivalent'] === 193 &&
        current.summary.byClassification['not-applicable'] === 54 &&
        (current.summary.byClassification.unresolved ?? 0) === 0,
    exactCurrentStatuses:
        current.summary.byStatus.managed === 608 &&
        current.summary.byStatus['not-applicable'] === 54 &&
        (current.summary.byStatus.unresolved ?? 0) === 0 &&
        current.summary.unresolvedCount === 0,
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
        enableExtensions.entries.every(entry =>
            entry.requiredLanguageFeatures.length === 0
        ) &&
        current.entries
            .filter(entry => entry.kind === 'language-extension')
            .every(entry =>
                entry.requirements.languageFeatures.length === 1 &&
                entry.requirements.deviceFeatures.length === 0
            ),
    dependencyPreflightHasOneAuthority:
        featureDependencySourceIsShared(),
    dependencyDiagnosticDocumented:
        dependencyDiagnosticIsDocumented(),
    browserMatrixIsManagedAndSelfContained:
        browserMatrixIsManagedAndSelfContained(),
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
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
if (failures.length > 0) process.exitCode = 1

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
        used <= 100
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

function relative(absolute) {

    return path.relative(root, absolute).split(path.sep).join('/')
}
