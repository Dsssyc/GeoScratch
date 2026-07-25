import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

export const STRUCTURED_PROOF_SCHEMA_VERSION = 4
export const coverageManifestSchemaPath =
    'docs/review/manifests/scratch-webgpu-wgsl-current-coverage.schema.json'

export const structuredProofKinds = Object.freeze([
    'browser-execution',
    'constructor-call',
    'descriptor-field',
    'function-call',
    'layout-contract',
    'n-a-composition',
    'property-read',
    'property-write',
    'public-export',
    'scratch-operation',
    'type-declaration',
    'type-member',
    'wgsl-contract',
])

const structuredProofKindSet = new Set(structuredProofKinds)
const packageEntrypointPath = 'packages/geoscratch/src/index.ts'
const managedScratchSourcePrefix = 'packages/geoscratch/src/scratch/'
const webGpuTypesPath = 'node_modules/@webgpu/types/dist/index.d.ts'
const wgslBrowserMatrixPath =
    'tests/browser/scratch-wgsl-capability-matrix.mjs'

const operationDefinitions = [
    call(
        'packages/geoscratch/src/scratch/binding.ts',
        'createBindGroup',
        'createBindGroup',
        [ 'GPUDevice' ]
    ),
    call(
        'packages/geoscratch/src/scratch/binding.ts',
        'createBindGroupLayout',
        'createBindGroupLayout',
        [ 'GPUDevice' ]
    ),
    call(
        'packages/geoscratch/src/scratch/binding.ts',
        'getBindGroupLayout',
        'getBindGroupLayout',
        [ 'GPURenderPipeline', 'GPUComputePipeline' ]
    ),
    call(
        'packages/geoscratch/src/scratch/buffer-mapping.ts',
        'getMappedRange',
        'getMappedRange',
        [ 'GPUBuffer' ]
    ),
    call(
        'packages/geoscratch/src/scratch/buffer-mapping.ts',
        'mapAsync',
        'mapAsync',
        [ 'GPUBuffer' ]
    ),
    call(
        'packages/geoscratch/src/scratch/buffer-mapping.ts',
        'unmap',
        'unmap',
        [ 'GPUBuffer' ]
    ),
    call(
        'packages/geoscratch/src/scratch/buffer.ts',
        'createBuffer',
        'createBuffer',
        [ 'GPUDevice' ]
    ),
    call(
        'packages/geoscratch/src/scratch/buffer.ts',
        'destroy',
        'destroy',
        [ 'GPUBuffer' ]
    ),
    call(
        'packages/geoscratch/src/scratch/command.ts',
        'beginOcclusionQuery',
        'beginOcclusionQuery',
        [ 'GPURenderPassEncoder' ]
    ),
    call(
        'packages/geoscratch/src/scratch/command.ts',
        'clearBuffer',
        'clearBuffer',
        [ 'GPUCommandEncoder' ]
    ),
    call(
        'packages/geoscratch/src/scratch/command.ts',
        'copyBufferToBuffer',
        'copyBufferToBuffer',
        [ 'GPUCommandEncoder' ]
    ),
    call(
        'packages/geoscratch/src/scratch/command.ts',
        'copyBufferToTexture',
        'copyBufferToTexture',
        [ 'GPUCommandEncoder' ]
    ),
    call(
        'packages/geoscratch/src/scratch/command.ts',
        'copyExternalImageToTexture',
        'copyExternalImageToTexture',
        [ 'GPUQueue' ]
    ),
    call(
        'packages/geoscratch/src/scratch/command.ts',
        'copyTextureToBuffer',
        'copyTextureToBuffer',
        [ 'GPUCommandEncoder' ]
    ),
    call(
        'packages/geoscratch/src/scratch/command.ts',
        'copyTextureToTexture',
        'copyTextureToTexture',
        [ 'GPUCommandEncoder' ]
    ),
    call(
        'packages/geoscratch/src/scratch/command.ts',
        'dispatchWorkgroups',
        'dispatchWorkgroups',
        [ 'GPUComputePassEncoder' ]
    ),
    call(
        'packages/geoscratch/src/scratch/command.ts',
        'dispatchWorkgroupsIndirect',
        'dispatchWorkgroupsIndirect',
        [ 'GPUComputePassEncoder' ]
    ),
    call(
        'packages/geoscratch/src/scratch/command.ts',
        'draw',
        'draw',
        [ 'GPURenderPassEncoder', 'GPURenderBundleEncoder' ]
    ),
    call(
        'packages/geoscratch/src/scratch/command.ts',
        'drawIndexed',
        'drawIndexed',
        [ 'GPURenderPassEncoder', 'GPURenderBundleEncoder' ]
    ),
    call(
        'packages/geoscratch/src/scratch/command.ts',
        'drawIndexedIndirect',
        'drawIndexedIndirect',
        [ 'GPURenderPassEncoder', 'GPURenderBundleEncoder' ]
    ),
    call(
        'packages/geoscratch/src/scratch/command.ts',
        'drawIndirect',
        'drawIndirect',
        [ 'GPURenderPassEncoder', 'GPURenderBundleEncoder' ]
    ),
    call(
        'packages/geoscratch/src/scratch/command.ts',
        'endOcclusionQuery',
        'endOcclusionQuery',
        [ 'GPURenderPassEncoder' ]
    ),
    call(
        'packages/geoscratch/src/scratch/command.ts',
        'resolveQuerySet',
        'resolveQuerySet',
        [ 'GPUCommandEncoder' ]
    ),
    call(
        'packages/geoscratch/src/scratch/command.ts',
        'setBindGroup',
        'setBindGroup',
        [
            'GPURenderPassEncoder',
            'GPUComputePassEncoder',
            'GPURenderBundleEncoder',
        ]
    ),
    call(
        'packages/geoscratch/src/scratch/command.ts',
        'setBlendConstant',
        'setBlendConstant',
        [ 'GPURenderPassEncoder' ]
    ),
    call(
        'packages/geoscratch/src/scratch/command.ts',
        'setImmediates',
        'setImmediates',
        [
            'GPURenderPassEncoder',
            'GPUComputePassEncoder',
            'GPURenderBundleEncoder',
        ]
    ),
    call(
        'packages/geoscratch/src/scratch/command.ts',
        'setIndexBuffer',
        'setIndexBuffer',
        [ 'GPURenderPassEncoder', 'GPURenderBundleEncoder' ]
    ),
    call(
        'packages/geoscratch/src/scratch/command.ts',
        'setPipeline',
        'setPipeline',
        [
            'GPURenderPassEncoder',
            'GPUComputePassEncoder',
            'GPURenderBundleEncoder',
        ]
    ),
    call(
        'packages/geoscratch/src/scratch/command.ts',
        'setScissorRect',
        'setScissorRect',
        [ 'GPURenderPassEncoder' ]
    ),
    call(
        'packages/geoscratch/src/scratch/command.ts',
        'setStencilReference',
        'setStencilReference',
        [ 'GPURenderPassEncoder' ]
    ),
    call(
        'packages/geoscratch/src/scratch/command.ts',
        'setVertexBuffer',
        'setVertexBuffer',
        [ 'GPURenderPassEncoder', 'GPURenderBundleEncoder' ]
    ),
    call(
        'packages/geoscratch/src/scratch/command.ts',
        'setViewport',
        'setViewport',
        [ 'GPURenderPassEncoder' ]
    ),
    call(
        'packages/geoscratch/src/scratch/command.ts',
        'writeBuffer',
        'writeBuffer',
        [ 'GPUQueue' ]
    ),
    call(
        'packages/geoscratch/src/scratch/command.ts',
        'writeTexture',
        'writeTexture',
        [ 'GPUQueue' ]
    ),
    call(
        'packages/geoscratch/src/scratch/debug-command.ts',
        'insertDebugMarker',
        'insertDebugMarker',
        [
            'Readonly<{ pushDebugGroup?: (label: string) => unknown; ' +
            'popDebugGroup?: () => unknown; insertDebugMarker?: ' +
            '(label: string) => unknown; }>',
        ]
    ),
    call(
        'packages/geoscratch/src/scratch/debug-command.ts',
        'popDebugGroup',
        'popDebugGroup',
        [
            'Readonly<{ pushDebugGroup?: (label: string) => unknown; ' +
            'popDebugGroup?: () => unknown; insertDebugMarker?: ' +
            '(label: string) => unknown; }>',
        ]
    ),
    call(
        'packages/geoscratch/src/scratch/debug-command.ts',
        'pushDebugGroup',
        'pushDebugGroup',
        [
            'Readonly<{ pushDebugGroup?: (label: string) => unknown; ' +
            'popDebugGroup?: () => unknown; insertDebugMarker?: ' +
            '(label: string) => unknown; }>',
        ]
    ),
    scratchOperation(
        'packages/geoscratch/src/scratch/gpu-operation.ts',
        'serializeNativeGpuError',
        'serializeNativeGpuError'
    ),
    scratchMember(
        'packages/geoscratch/src/scratch/layout-codec.ts',
        'LayoutCodec.pack',
        'LayoutCodec',
        'pack'
    ),
    scratchMember(
        'packages/geoscratch/src/scratch/layout-codec.ts',
        'LayoutCodec.wgslAccessors',
        'LayoutCodec',
        'wgslAccessors'
    ),
    scratchOperation(
        'packages/geoscratch/src/scratch/native-allocation.ts',
        'createScratchNativeLabel',
        'createScratchNativeLabel'
    ),
    call(
        'packages/geoscratch/src/scratch/native-allocation.ts',
        'destroy',
        'destroy',
        [ '{ destroy(): void; }' ]
    ),
    call(
        'packages/geoscratch/src/scratch/pipeline-creation.ts',
        'createComputePipelineAsync',
        'createComputePipelineAsync',
        [ 'GPUDevice' ]
    ),
    call(
        'packages/geoscratch/src/scratch/pipeline-creation.ts',
        'createPipelineLayout',
        'createPipelineLayout',
        [ 'GPUDevice' ]
    ),
    call(
        'packages/geoscratch/src/scratch/pipeline-creation.ts',
        'createRenderPipelineAsync',
        'createRenderPipelineAsync',
        [ 'GPUDevice' ]
    ),
    call(
        'packages/geoscratch/src/scratch/query-set.ts',
        'createQuerySet',
        'createQuerySet',
        [ 'GPUDevice' ]
    ),
    call(
        'packages/geoscratch/src/scratch/query-set.ts',
        'destroy',
        'destroy',
        [ 'GPUQuerySet' ]
    ),
    call(
        'packages/geoscratch/src/scratch/readback-mapping.ts',
        'mapAsync',
        'mapAsync',
        [ 'GPUBuffer' ]
    ),
    call(
        'packages/geoscratch/src/scratch/render-bundle.ts',
        'GPURenderBundleEncoder.finish',
        'finish',
        [ 'GPURenderBundleEncoder' ]
    ),
    call(
        'packages/geoscratch/src/scratch/render-bundle.ts',
        'createRenderBundleEncoder',
        'createRenderBundleEncoder',
        [ 'GPUDevice' ]
    ),
    call(
        'packages/geoscratch/src/scratch/render-bundle.ts',
        'executeBundles',
        'executeBundles',
        [ 'GPURenderPassEncoder' ]
    ),
    call(
        'packages/geoscratch/src/scratch/runtime-diagnostics.ts',
        'uncapturederror',
        'addEventListener',
        [ 'GPUDevice' ],
        [ { index: 0, value: 'uncapturederror' } ]
    ),
    propertyRead(
        'packages/geoscratch/src/scratch/runtime.ts',
        'adapter.features',
        'features',
        [ 'GPUAdapter' ]
    ),
    propertyRead(
        'packages/geoscratch/src/scratch/runtime.ts',
        'adapter.limits',
        'limits',
        [ 'GPUAdapter' ]
    ),
    scratchMember(
        'packages/geoscratch/src/scratch/runtime.ts',
        'adapterFeatures',
        'ScratchRuntime',
        'adapterFeatures'
    ),
    scratchMember(
        'packages/geoscratch/src/scratch/runtime.ts',
        'adapterInfo',
        'ScratchRuntime',
        'adapterInfo'
    ),
    call(
        'packages/geoscratch/src/scratch/runtime.ts',
        'device.destroy',
        'destroy',
        [ 'GPUDevice' ]
    ),
    propertyRead(
        'packages/geoscratch/src/scratch/runtime.ts',
        'device.features',
        'features',
        [ 'GPUDevice' ]
    ),
    propertyRead(
        'packages/geoscratch/src/scratch/runtime.ts',
        'device.limits',
        'limits',
        [ 'GPUDevice' ]
    ),
    propertyRead(
        'packages/geoscratch/src/scratch/runtime.ts',
        'device.lost',
        'lost',
        [ 'GPUDevice' ]
    ),
    scratchMember(
        'packages/geoscratch/src/scratch/runtime.ts',
        'deviceFeatures',
        'ScratchRuntime',
        'deviceFeatures'
    ),
    call(
        'packages/geoscratch/src/scratch/runtime.ts',
        'requestAdapter',
        'requestAdapter',
        [ 'GPU' ]
    ),
    call(
        'packages/geoscratch/src/scratch/runtime.ts',
        'requestDevice',
        'requestDevice',
        [ 'GPUAdapter' ]
    ),
    propertyRead(
        'packages/geoscratch/src/scratch/runtime.ts',
        'wgslLanguageFeatures',
        'wgslLanguageFeatures',
        [ 'GPU' ]
    ),
    call(
        'packages/geoscratch/src/scratch/sampler.ts',
        'createSampler',
        'createSampler',
        [ 'GPUDevice' ]
    ),
    call(
        'packages/geoscratch/src/scratch/shader-module.ts',
        'createShaderModule',
        'createShaderModule',
        [ 'GPUDevice' ]
    ),
    call(
        'packages/geoscratch/src/scratch/shader-module.ts',
        'getCompilationInfo',
        'getCompilationInfo',
        [ 'GPUShaderModule' ]
    ),
    call(
        'packages/geoscratch/src/scratch/submission.ts',
        'GPUCommandEncoder.finish',
        'finish',
        [ 'GPUCommandEncoder' ]
    ),
    call(
        'packages/geoscratch/src/scratch/submission.ts',
        'beginComputePass',
        'beginComputePass',
        [ 'GPUCommandEncoder' ]
    ),
    call(
        'packages/geoscratch/src/scratch/submission.ts',
        'beginRenderPass',
        'beginRenderPass',
        [ 'GPUCommandEncoder' ]
    ),
    call(
        'packages/geoscratch/src/scratch/submission.ts',
        'createCommandEncoder',
        'createCommandEncoder',
        [ 'GPUDevice' ]
    ),
    call(
        'packages/geoscratch/src/scratch/submission.ts',
        'end',
        'end',
        [ 'GPUComputePassEncoder', 'GPURenderPassEncoder' ]
    ),
    call(
        'packages/geoscratch/src/scratch/submission.ts',
        'onSubmittedWorkDone',
        'onSubmittedWorkDone',
        [ 'GPUQueue' ]
    ),
    call(
        'packages/geoscratch/src/scratch/submission.ts',
        'queue.submit',
        'submit',
        [ 'GPUQueue' ]
    ),
    call(
        'packages/geoscratch/src/scratch/supporting-object-creation.ts',
        'popErrorScope',
        'popErrorScope',
        [ 'GPUDevice' ]
    ),
    call(
        'packages/geoscratch/src/scratch/supporting-object-creation.ts',
        'pushErrorScope',
        'pushErrorScope',
        [ 'GPUDevice' ]
    ),
    call(
        'packages/geoscratch/src/scratch/surface.ts',
        'GPUCanvasContext.configure',
        'configure',
        [ 'GPUCanvasContext' ]
    ),
    call(
        'packages/geoscratch/src/scratch/surface.ts',
        'configure',
        'configure',
        [ 'GPUCanvasContext' ]
    ),
    call(
        'packages/geoscratch/src/scratch/surface.ts',
        'getConfiguration',
        'getConfiguration',
        [ 'GPUCanvasContext' ]
    ),
    call(
        'packages/geoscratch/src/scratch/surface.ts',
        'getPreferredCanvasFormat',
        'getPreferredCanvasFormat',
        [ 'GPU' ]
    ),
    call(
        'packages/geoscratch/src/scratch/surface.ts',
        'unconfigure',
        'unconfigure',
        [ 'GPUCanvasContext' ]
    ),
    call(
        'packages/geoscratch/src/scratch/temporal-texture.ts',
        'GPUCanvasContext.getCurrentTexture',
        'getCurrentTexture',
        [ 'GPUCanvasContext' ]
    ),
    call(
        'packages/geoscratch/src/scratch/temporal-texture.ts',
        'getCurrentTexture',
        'getCurrentTexture',
        [ 'GPUCanvasContext' ]
    ),
    call(
        'packages/geoscratch/src/scratch/temporal-texture.ts',
        'importExternalTexture',
        'importExternalTexture',
        [ 'GPUDevice' ]
    ),
    call(
        'packages/geoscratch/src/scratch/texture.ts',
        'GPUTexture.createView',
        'createView',
        [ 'GPUTexture' ]
    ),
    call(
        'packages/geoscratch/src/scratch/texture.ts',
        'createTexture',
        'createTexture',
        [ 'GPUDevice' ]
    ),
    call(
        'packages/geoscratch/src/scratch/texture.ts',
        'destroy',
        'destroy',
        [ 'GPUTexture' ]
    ),
]

const operationRegistry = new Map()
for (const definition of operationDefinitions) {
    const key = operationKey(
        definition.sourcePath,
        definition.operation
    )
    if (operationRegistry.has(key)) {
        throw new Error(`Duplicate structured operation definition ${key}`)
    }
    operationRegistry.set(key, Object.freeze(definition))
}

export function structuredOperationProof(operation, sourcePath) {

    const definition = operationRegistry.get(
        operationKey(sourcePath, operation)
    )
    if (definition === undefined) {
        throw new Error(
            `Unknown structured operation ${operation} in ${sourcePath}`
        )
    }
    return cloneJson(definition)
}

export function structuredOperationRegistryFacts() {

    return Object.freeze({
        operationCount: operationRegistry.size,
        keys: Object.freeze([ ...operationRegistry.keys() ].sort()),
        proofKinds: structuredProofKinds,
    })
}

export function createEntryProofEvidence({
    domain,
    entry,
    publicSymbols,
    proofProfile,
    status,
    requirements,
    normativeManifest,
}) {

    if (status === 'not-applicable') {
        return [
            {
                kind: 'n-a-composition',
                operation: `${entry.id} host composition`,
                sourcePath: normativeManifest,
                selector: {
                    normativeId: entry.id,
                    hostInterface: entry.owner,
                    mixin: entry.member,
                    reasonCode: 'host-dom-composition',
                },
            },
        ]
    }
    if (status === 'unresolved') return []

    const evidence = []
    for (const symbol of publicSymbols) {
        evidence.push({
            kind: 'public-export',
            operation: `${symbol} public export`,
            sourcePath: packageEntrypointPath,
            selector: { exportName: symbol },
        })
        evidence.push({
            kind: 'scratch-operation',
            operation: `${symbol} Scratch declaration`,
            sourcePath: packageEntrypointPath,
            selector: { exportName: symbol },
        })
    }

    if (domain === 'webgpu') {
        evidence.push(webGpuTypeEvidence(entry))
    } else {
        evidence.push(wgslContractEvidence(entry))
        if (proofProfile === 'wgsl-layout') {
            evidence.push(layoutContractEvidence(entry))
        }
        if (
            entry.kind === 'enable-extension' ||
            entry.kind === 'language-extension'
        ) {
            evidence.push(browserExecutionEvidence(
                entry,
                requirements
            ))
        }
    }
    return sortEvidence(evidence)
}

export function createRepositoryProofContext({
    root = process.cwd(),
    additionalSourcePaths = [],
} = {}) {

    const absoluteRoot = path.resolve(root)
    const configPath = path.join(
        absoluteRoot,
        'packages/geoscratch/tsconfig.build.json'
    )
    const configFile = ts.readConfigFile(configPath, ts.sys.readFile)
    if (configFile.error !== undefined) {
        throw new Error(formatTypeScriptDiagnostic(configFile.error))
    }
    const config = ts.parseJsonConfigFileContent(
        configFile.config,
        ts.sys,
        path.dirname(configPath)
    )
    if (config.errors.length > 0) {
        throw new Error(config.errors.map(
            formatTypeScriptDiagnostic
        ).join('\n'))
    }
    const requiredPaths = [
        packageEntrypointPath,
        webGpuTypesPath,
        wgslBrowserMatrixPath,
        ...additionalSourcePaths,
    ]
    const additionalRoots = requiredPaths.map(relativePath =>
        resolveRepositoryPath(absoluteRoot, relativePath)
    )
    const rootNames = uniqueSorted([
        ...config.fileNames,
        ...additionalRoots,
    ])
    const program = ts.createProgram({
        rootNames,
        options: {
            ...config.options,
            allowJs: true,
            checkJs: false,
            noEmit: true,
        },
    })
    return Object.freeze({
        root: absoluteRoot,
        program,
        checker: program.getTypeChecker(),
    })
}

export function assertStructuredEvidence(context, evidence) {

    validateStructuredEvidence(evidence, 'structuredEvidence')
    const absolutePath = resolveRepositoryPath(
        context.root,
        evidence.sourcePath
    )
    if (evidence.kind === 'n-a-composition') {
        assertNotApplicableComposition(evidence)
        return
    }
    const sourceFile = context.program.getSourceFile(absolutePath)
    if (sourceFile === undefined) {
        throw new Error(
            `${evidence.operation} sourcePath is not in the TypeScript Program: ` +
            evidence.sourcePath
        )
    }
    const matches = findEvidenceMatches(context, sourceFile, evidence)
    if (matches.length === 0) {
        throw new Error(
            `${evidence.operation} did not resolve in ${evidence.sourcePath}`
        )
    }
}

export function validateCoverageManifestV4(manifest) {

    assertPlainObject(manifest, 'manifest')
    assertExactKeys(manifest, [
        'baseline',
        'currentClassificationValues',
        'entries',
        'evidence',
        'frozenManifests',
        'normativeManifests',
        'proofSystem',
        'purpose',
        'schema',
        'schemaVersion',
        'statusValues',
        'summary',
    ], 'manifest')
    if (manifest.schemaVersion !== STRUCTURED_PROOF_SCHEMA_VERSION) {
        throw new TypeError(
            `manifest.schemaVersion must be ${STRUCTURED_PROOF_SCHEMA_VERSION}`
        )
    }
    assertNonEmptyString(manifest.purpose, 'manifest.purpose')
    if (manifest.schema !== coverageManifestSchemaPath) {
        throw new TypeError(
            `manifest.schema must be ${coverageManifestSchemaPath}`
        )
    }
    validateBaseline(manifest.baseline)
    assertExactStringMap(manifest.normativeManifests, [
        'dependencies',
        'proposals',
        'webgpu',
        'wgsl',
    ], 'manifest.normativeManifests')
    assertExactStringMap(manifest.frozenManifests, [
        'webgpuHistoricalBaseline',
        'wgslHistoricalBaseline',
    ], 'manifest.frozenManifests')
    assertExactStringArray(
        manifest.currentClassificationValues,
        [
            'managed-first-class',
            'managed-semantic-equivalent',
            'not-applicable',
            'unresolved',
        ],
        'manifest.currentClassificationValues'
    )
    assertExactStringArray(
        manifest.statusValues,
        [ 'managed', 'not-applicable', 'unresolved' ],
        'manifest.statusValues'
    )
    validateProofSystem(manifest.proofSystem)
    assertArray(manifest.evidence, 'manifest.evidence')
    for (const [ index, record ] of manifest.evidence.entries()) {
        validateEvidenceRecord(record, `manifest.evidence[${index}]`)
    }
    assertUniqueBy(
        manifest.evidence,
        record => record.id,
        'manifest.evidence ids'
    )
    assertArray(manifest.entries, 'manifest.entries')
    for (const [ index, entry ] of manifest.entries.entries()) {
        validateCoverageEntry(entry, `manifest.entries[${index}]`)
    }
    assertUniqueBy(
        manifest.entries,
        entry => entry.id,
        'manifest.entries ids'
    )
    validateSummary(manifest.summary)
    return manifest
}

export function verifyCoverageManifestProofs(manifest, {
    root = process.cwd(),
} = {}) {

    validateCoverageManifestV4(manifest)
    const proofSourcePaths = uniqueSorted(
        manifest.entries.flatMap(entry => [
            ...entry.proof.evidence,
            ...entry.nativeLowering.operationEvidence,
        ]).map(item => item.sourcePath)
    )
    const context = createRepositoryProofContext({
        root,
        additionalSourcePaths: proofSourcePaths,
    })
    const normativeWebGpu = readJsonAt(
        root,
        manifest.normativeManifests.webgpu
    )
    const normativeWgsl = readJsonAt(
        root,
        manifest.normativeManifests.wgsl
    )
    const dependencies = readJsonAt(
        root,
        manifest.normativeManifests.dependencies
    )
    const frozenWebGpu = readJsonAt(
        root,
        manifest.frozenManifests.webgpuHistoricalBaseline
    )
    const frozenWgsl = readJsonAt(
        root,
        manifest.frozenManifests.wgslHistoricalBaseline
    )
    const expected = new Map([
        ...normativeWebGpu.entries.map(entry => [
            entry.id,
            { ...entry, domain: 'webgpu' },
        ]),
        ...normativeWgsl.entries.map(entry => [
            entry.id,
            { ...entry, domain: 'wgsl' },
        ]),
    ])
    if (expected.size !== manifest.entries.length) {
        throw new Error(
            `Normative inventory closure expected ${expected.size} entries, ` +
            `received ${manifest.entries.length}`
        )
    }
    const evidenceIds = new Set(
        manifest.evidence.map(record => record.id)
    )
    const knownDependencies = new Set(
        dependencies.entries.map(entry => entry.id)
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
    const knownDeviceFeatures = collectStringLiteralMembers(
        context,
        webGpuTypesPath,
        'GPUFeatureName'
    )

    for (const entry of manifest.entries) {
        const normative = expected.get(entry.id)
        if (normative === undefined) {
            throw new Error(`Unknown normative entry ${entry.id}`)
        }
        if (
            normative.domain !== entry.domain ||
            normative.kind !== entry.kind
        ) {
            throw new Error(
                `${entry.id} has incorrect normative domain or kind`
            )
        }
        verifyNormativeSourceBinding(entry, normative, manifest)
        expected.delete(entry.id)
        if (
            entry.proof.selector.id !== entry.id ||
            entry.proof.selector.domain !== entry.domain ||
            entry.proof.selector.entryKind !== entry.kind
        ) {
            throw new Error(
                `${entry.id} proof selector does not match its inventory entry`
            )
        }
        for (const evidenceId of entry.evidenceIds) {
            if (!evidenceIds.has(evidenceId)) {
                throw new Error(
                    `${entry.id} references unknown evidence ${evidenceId}`
                )
            }
        }
        verifyRequirementValues(entry, {
            knownDependencies,
            knownDeviceFeatures,
            knownEnableExtensions,
            knownLanguageFeatures,
            knownLimits,
        })
        verifyEntryProofBindings(entry, normative)
        for (const item of [
            ...entry.proof.evidence,
            ...entry.nativeLowering.operationEvidence,
        ]) {
            assertStructuredEvidence(context, item)
        }
    }
    if (expected.size > 0) {
        throw new Error(
            `Missing normative entries: ${[ ...expected.keys() ].join(', ')}`
        )
    }
    verifySummaryClosure(manifest, {
        normativeWebGpu,
        normativeWgsl,
        frozenWebGpu,
        frozenWgsl,
    })
}

const schemaString = Object.freeze({ type: 'string', minLength: 1 })
const schemaBoolean = Object.freeze({ type: 'boolean' })
const schemaCount = Object.freeze({
    type: 'integer',
    minimum: 0,
})
const schemaStringArray = Object.freeze({
    type: 'array',
    items: schemaString,
    uniqueItems: true,
})

function schemaObject(properties, required = Object.keys(properties)) {

    return {
        type: 'object',
        additionalProperties: false,
        required,
        properties,
    }
}

function evidenceSchema(kind, selector) {

    return schemaObject({
        kind: { const: kind },
        operation: schemaString,
        sourcePath: schemaString,
        selector,
    })
}

export const coverageManifestSchemaV4 = Object.freeze({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: coverageManifestSchemaPath,
    title: 'Scratch WebGPU and WGSL current coverage manifest',
    ...schemaObject({
        schemaVersion: { const: STRUCTURED_PROOF_SCHEMA_VERSION },
        schema: { const: coverageManifestSchemaPath },
        purpose: schemaString,
        baseline: { $ref: '#/$defs/baseline' },
        normativeManifests: schemaObject({
            dependencies: schemaString,
            proposals: schemaString,
            webgpu: schemaString,
            wgsl: schemaString,
        }),
        frozenManifests: schemaObject({
            webgpuHistoricalBaseline: schemaString,
            wgslHistoricalBaseline: schemaString,
        }),
        currentClassificationValues: {
            type: 'array',
            prefixItems: [
                { const: 'managed-first-class' },
                { const: 'managed-semantic-equivalent' },
                { const: 'not-applicable' },
                { const: 'unresolved' },
            ],
            minItems: 4,
            maxItems: 4,
        },
        statusValues: {
            type: 'array',
            prefixItems: [
                { const: 'managed' },
                { const: 'not-applicable' },
                { const: 'unresolved' },
            ],
            minItems: 3,
            maxItems: 3,
        },
        proofSystem: { $ref: '#/$defs/proofSystem' },
        evidence: {
            type: 'array',
            items: { $ref: '#/$defs/evidenceRecord' },
            uniqueItems: true,
        },
        entries: {
            type: 'array',
            items: { $ref: '#/$defs/entry' },
            uniqueItems: true,
        },
        summary: { $ref: '#/$defs/summary' },
    }),
    $defs: {
        stringArray: schemaStringArray,
        baseline: schemaObject({
            refreshedOn: schemaString,
            webgpu: { $ref: '#/$defs/specBaseline' },
            wgsl: { $ref: '#/$defs/specBaseline' },
            gpuwebEditor: schemaObject({
                frozenBaselineCommit: schemaString,
                refreshedCommit: schemaString,
                url: schemaString,
                sourceUrl: schemaString,
                observedOn: schemaString,
                normativeDelta: schemaBoolean,
                delta: {
                    type: 'array',
                    items: schemaObject({
                        commit: schemaString,
                        subject: schemaString,
                        scope: schemaString,
                    }),
                    uniqueItems: true,
                },
            }),
            gpuwebTypes: schemaObject({
                repositoryCommit: schemaString,
                url: schemaString,
                sourceUrl: schemaString,
                observedOn: schemaString,
                packageVersion: schemaString,
                declarationSha256: schemaString,
            }),
            proposalIndex: schemaObject({
                url: schemaString,
                sourceUrl: schemaString,
                observedOn: schemaString,
                readmeSha256: schemaString,
                draftProposalsInScope: schemaBoolean,
            }),
        }),
        specBaseline: schemaObject({
            publication: schemaString,
            url: schemaString,
            sha256: schemaString,
        }),
        proofSystem: schemaObject({
            engine: { const: 'typescript-ast-type-aware' },
            rawNativeHandlesManaged: { const: false },
            selectorKinds: {
                type: 'array',
                prefixItems: structuredProofKinds.map(value => ({
                    const: value,
                })),
                minItems: structuredProofKinds.length,
                maxItems: structuredProofKinds.length,
            },
        }),
        evidenceRecord: schemaObject({
            id: schemaString,
            claim: schemaString,
            sourcePaths: { $ref: '#/$defs/stringArray' },
            testPaths: { $ref: '#/$defs/stringArray' },
            browserPaths: { $ref: '#/$defs/stringArray' },
            publicSymbols: { $ref: '#/$defs/stringArray' },
        }),
        argumentLiteral: schemaObject({
            index: schemaCount,
            value: {
                type: [ 'string', 'number', 'boolean', 'null' ],
            },
        }),
        structuredEvidence: {
            oneOf: [
                evidenceSchema('function-call', schemaObject({
                    member: schemaString,
                    receiverTypes: {
                        $ref: '#/$defs/stringArray',
                    },
                    argumentLiterals: {
                        type: 'array',
                        items: { $ref: '#/$defs/argumentLiteral' },
                        uniqueItems: true,
                    },
                }, [ 'member', 'receiverTypes' ])),
                evidenceSchema('constructor-call', schemaObject({
                    constructorTypes: {
                        $ref: '#/$defs/stringArray',
                    },
                })),
                evidenceSchema('property-read', schemaObject({
                    member: schemaString,
                    receiverTypes: {
                        $ref: '#/$defs/stringArray',
                    },
                })),
                evidenceSchema('property-write', schemaObject({
                    member: schemaString,
                    receiverTypes: {
                        $ref: '#/$defs/stringArray',
                    },
                })),
                evidenceSchema('descriptor-field', schemaObject({
                    field: schemaString,
                    ownerTypes: {
                        $ref: '#/$defs/stringArray',
                    },
                })),
                evidenceSchema('public-export', schemaObject({
                    exportName: schemaString,
                })),
                evidenceSchema('scratch-operation', {
                    oneOf: [
                        schemaObject({
                            exportName: schemaString,
                        }),
                        schemaObject({
                            symbolName: schemaString,
                            member: schemaString,
                        }, [ 'symbolName' ]),
                    ],
                }),
                evidenceSchema('wgsl-contract', schemaObject({
                    contractId: schemaString,
                    descriptorType: schemaString,
                    nativeMember: schemaString,
                    nativeReceiverTypes: {
                        $ref: '#/$defs/stringArray',
                    },
                    payloadField: schemaString,
                    payloadPath: {
                        $ref: '#/$defs/stringArray',
                    },
                })),
                evidenceSchema('layout-contract', schemaObject({
                    exportName: schemaString,
                    members: { $ref: '#/$defs/stringArray' },
                })),
                evidenceSchema('browser-execution', schemaObject({
                    collection: schemaString,
                    contractKey: schemaString,
                    proofName: schemaString,
                    requiredFeatures: {
                        $ref: '#/$defs/stringArray',
                    },
                    resultCollection: schemaString,
                    runnerNames: { $ref: '#/$defs/stringArray' },
                })),
                evidenceSchema('n-a-composition', schemaObject({
                    hostInterface: schemaString,
                    mixin: schemaString,
                    normativeId: schemaString,
                    reasonCode: {
                        const: 'host-dom-composition',
                    },
                })),
                evidenceSchema('type-declaration', schemaObject({
                    typeName: schemaString,
                })),
                evidenceSchema('type-member', schemaObject({
                    ownerType: schemaString,
                    member: schemaString,
                    memberKind: {
                        enum: [ 'method', 'property' ],
                    },
                })),
            ],
        },
        normativeSelector: schemaObject({
            kind: { const: 'normative-entry' },
            id: schemaString,
            domain: { enum: [ 'webgpu', 'wgsl' ] },
            entryKind: schemaString,
        }),
        proof: schemaObject({
            granularity: { const: 'entry' },
            profile: schemaString,
            selector: { $ref: '#/$defs/normativeSelector' },
            evidence: {
                type: 'array',
                items: { $ref: '#/$defs/structuredEvidence' },
                uniqueItems: true,
            },
        }),
        entrySource: schemaObject({
            publication: schemaString,
            url: schemaString,
            anchor: schemaString,
            normativeManifest: schemaString,
        }),
        goalStart: schemaObject({
            status: schemaString,
            rationale: schemaString,
            family: schemaString,
        }, [ 'status', 'rationale' ]),
        current: schemaObject({
            status: {
                enum: [ 'managed', 'not-applicable', 'unresolved' ],
            },
            classification: {
                enum: [
                    'managed-first-class',
                    'managed-semantic-equivalent',
                    'not-applicable',
                    'unresolved',
                ],
            },
            rationale: schemaString,
        }),
        expression: schemaObject({
            mode: schemaString,
            publicSymbols: { $ref: '#/$defs/stringArray' },
            contract: schemaString,
        }),
        nativeLowering: schemaObject({
            kind: {
                enum: [
                    'native-call-or-descriptor',
                    'native-semantic-equivalence',
                    'none',
                    'wgsl-compilation',
                ],
            },
            sourcePaths: { $ref: '#/$defs/stringArray' },
            operations: { $ref: '#/$defs/stringArray' },
            operationEvidence: {
                type: 'array',
                items: { $ref: '#/$defs/structuredEvidence' },
                uniqueItems: true,
            },
        }),
        requirementCondition: schemaObject({
            when: schemaString,
            deviceFeatures: { $ref: '#/$defs/stringArray' },
            languageFeatures: { $ref: '#/$defs/stringArray' },
            limits: { $ref: '#/$defs/stringArray' },
            dependencies: { $ref: '#/$defs/stringArray' },
            deviceFeatureAlternatives: {
                type: 'array',
                items: { $ref: '#/$defs/stringArray' },
                uniqueItems: true,
            },
        }, [
            'when',
            'deviceFeatures',
            'languageFeatures',
            'limits',
            'dependencies',
        ]),
        requirements: schemaObject({
            enableExtensions: { $ref: '#/$defs/stringArray' },
            deviceFeatures: { $ref: '#/$defs/stringArray' },
            languageFeatures: { $ref: '#/$defs/stringArray' },
            limits: { $ref: '#/$defs/stringArray' },
            dependencies: { $ref: '#/$defs/stringArray' },
            conditions: {
                type: 'array',
                items: { $ref: '#/$defs/requirementCondition' },
                uniqueItems: true,
            },
            policy: schemaString,
        }),
        entry: schemaObject({
            id: schemaString,
            domain: { enum: [ 'webgpu', 'wgsl' ] },
            kind: schemaString,
            source: { $ref: '#/$defs/entrySource' },
            goalStart: { $ref: '#/$defs/goalStart' },
            coverageRule: schemaString,
            proof: { $ref: '#/$defs/proof' },
            current: { $ref: '#/$defs/current' },
            expression: { $ref: '#/$defs/expression' },
            nativeLowering: { $ref: '#/$defs/nativeLowering' },
            requirements: { $ref: '#/$defs/requirements' },
            evidenceIds: { $ref: '#/$defs/stringArray' },
        }),
        countMap: {
            type: 'object',
            propertyNames: schemaString,
            additionalProperties: schemaCount,
        },
        summary: schemaObject({
            entryCount: schemaCount,
            webgpuNormativeEntryCount: schemaCount,
            wgslNormativeEntryCount: schemaCount,
            frozenWebgpuHistoricalEntryCount: schemaCount,
            frozenWgslHistoricalEntryCount: schemaCount,
            unresolvedCount: schemaCount,
            byStatus: { $ref: '#/$defs/countMap' },
            byClassification: { $ref: '#/$defs/countMap' },
        }),
    },
})

function findEvidenceMatches(context, sourceFile, evidence) {

    switch (evidence.kind) {
        case 'public-export':
            return findPublicExportMatches(context, sourceFile, evidence)
        case 'scratch-operation':
            return findScratchOperationMatches(context, sourceFile, evidence)
        case 'function-call':
            return findFunctionCallMatches(context, sourceFile, evidence)
        case 'constructor-call':
            return findConstructorCallMatches(sourceFile, evidence)
        case 'property-read':
        case 'property-write':
            return findPropertyAccessMatches(
                context,
                sourceFile,
                evidence
            )
        case 'descriptor-field':
            return findDescriptorFieldMatches(
                context,
                sourceFile,
                evidence
            )
        case 'type-declaration':
            return findTypeDeclarationMatches(sourceFile, evidence)
        case 'type-member':
            return findTypeMemberMatches(sourceFile, evidence)
        case 'wgsl-contract':
            return findWgslContractMatches(context, sourceFile, evidence)
        case 'layout-contract':
            return findLayoutContractMatches(sourceFile, evidence)
        case 'browser-execution':
            return findBrowserExecutionMatches(sourceFile, evidence)
        default:
            throw new TypeError(`unknown proof kind ${evidence.kind}`)
    }
}

function findPublicExportMatches(context, sourceFile, evidence) {

    const moduleSymbol = context.checker.getSymbolAtLocation(sourceFile)
    if (moduleSymbol === undefined) return []
    const exported = context.checker.getExportsOfModule(moduleSymbol)
        .find(symbol => symbol.name === evidence.selector.exportName)
    if (exported === undefined) return []
    const target = resolveAliasedSymbol(context.checker, exported)
    return target.declarations ?? []
}

function findScratchOperationMatches(context, sourceFile, evidence) {

    const selector = evidence.selector
    if (selector.exportName !== undefined) {
        return findPublicExportMatches(context, sourceFile, {
            selector: { exportName: selector.exportName },
        }).filter(declaration =>
            isScratchSourceDeclaration(context.root, declaration)
        )
    }
    const matches = []
    visit(sourceFile, node => {
        if (declarationName(node) !== selector.symbolName) return
        if (selector.member === undefined) {
            matches.push(node)
            return
        }
        if (!hasDeclaredMember(node, selector.member)) return
        matches.push(node)
    })
    return matches
}

function findFunctionCallMatches(context, sourceFile, evidence) {

    const selector = evidence.selector
    const matches = []
    visit(sourceFile, node => {
        if (!ts.isCallExpression(node)) return
        const call = callTarget(node)
        if (call.member !== selector.member) return
        if (
            selector.receiverTypes.length > 0 &&
            (
                call.receiver === undefined ||
                !typeMatches(
                    context.checker,
                    call.receiver,
                    selector.receiverTypes
                )
            )
        ) {
            return
        }
        if (
            selector.receiverTypes.length === 0 &&
            call.receiver !== undefined
        ) {
            return
        }
        if (!argumentsMatch(node.arguments, selector.argumentLiterals ?? [])) {
            return
        }
        matches.push(node)
    })
    return matches
}

function findConstructorCallMatches(sourceFile, evidence) {

    const expected = new Set(evidence.selector.constructorTypes)
    const matches = []
    visit(sourceFile, node => {
        if (!ts.isNewExpression(node)) return
        const name = staticExpressionName(node.expression)
        if (name !== undefined && expected.has(name)) matches.push(node)
    })
    return matches
}

function findPropertyAccessMatches(context, sourceFile, evidence) {

    const selector = evidence.selector
    const expectWrite = evidence.kind === 'property-write'
    const matches = []
    visit(sourceFile, node => {
        if (!ts.isPropertyAccessExpression(node)) return
        if (node.name.text !== selector.member) return
        if (isWriteAccess(node) !== expectWrite) return
        if (!typeMatches(
            context.checker,
            node.expression,
            selector.receiverTypes
        )) {
            return
        }
        matches.push(node)
    })
    return matches
}

function findDescriptorFieldMatches(context, sourceFile, evidence) {

    const selector = evidence.selector
    const matches = []
    visit(sourceFile, node => {
        if (
            (
                ts.isPropertySignature(node) ||
                ts.isPropertyDeclaration(node) ||
                ts.isMethodSignature(node)
            ) &&
            staticPropertyName(node.name) === selector.field
        ) {
            const owner = enclosingTypeName(node)
            if (
                owner !== undefined &&
                selector.ownerTypes.includes(owner)
            ) {
                matches.push(node)
            }
            return
        }
        if (
            !ts.isPropertyAssignment(node) &&
            !ts.isShorthandPropertyAssignment(node)
        ) {
            return
        }
        if (staticPropertyName(node.name) !== selector.field) return
        const objectLiteral = node.parent
        if (!ts.isObjectLiteralExpression(objectLiteral)) return
        const contextual = context.checker.getContextualType(objectLiteral)
        const declared = declaredObjectLiteralType(
            context.checker,
            objectLiteral
        )
        if (
            [ contextual, declared ].some(type =>
                type !== undefined &&
                typeValueMatches(
                    context.checker,
                    type,
                    selector.ownerTypes
                )
            )
        ) {
            matches.push(node)
        }
    })
    return matches
}

function findTypeDeclarationMatches(sourceFile, evidence) {

    const matches = []
    visit(sourceFile, node => {
        if (
            (
                ts.isInterfaceDeclaration(node) ||
                ts.isTypeAliasDeclaration(node) ||
                ts.isClassDeclaration(node) ||
                ts.isEnumDeclaration(node)
            ) &&
            node.name?.text === evidence.selector.typeName
        ) {
            matches.push(node)
        }
    })
    return matches
}

function findTypeMemberMatches(sourceFile, evidence) {

    const selector = evidence.selector
    const matches = []
    visit(sourceFile, node => {
        if (
            !ts.isInterfaceDeclaration(node) &&
            !ts.isClassDeclaration(node) &&
            !ts.isTypeAliasDeclaration(node)
        ) {
            return
        }
        if (node.name?.text !== selector.ownerType) return
        const members = typeDeclarationMembers(node)
        for (const member of members) {
            if (staticPropertyName(member.name) !== selector.member) {
                continue
            }
            if (
                selector.memberKind === 'method' &&
                !ts.isMethodSignature(member) &&
                !ts.isMethodDeclaration(member)
            ) {
                continue
            }
            if (
                selector.memberKind === 'property' &&
                !ts.isPropertySignature(member) &&
                !ts.isPropertyDeclaration(member)
            ) {
                continue
            }
            matches.push(member)
        }
    })
    return matches
}

function findWgslContractMatches(context, sourceFile, evidence) {

    const selector = evidence.selector
    const descriptors = []
    visit(sourceFile, node => {
        if (
            !ts.isVariableDeclaration(node) ||
            !ts.isIdentifier(node.name) ||
            node.initializer === undefined ||
            !ts.isObjectLiteralExpression(node.initializer)
        ) {
            return
        }
        const declaredType = node.type === undefined
            ? undefined
            : context.checker.getTypeFromTypeNode(node.type)
        if (
            declaredType === undefined ||
            !typeValueMatches(
                context.checker,
                declaredType,
                [ selector.descriptorType ]
            )
        ) {
            return
        }
        const payload = objectProperty(
            node.initializer,
            selector.payloadField
        )
        if (
            payload === undefined ||
            !ts.isPropertyAssignment(payload) ||
            !expressionPathMatches(
                payload.initializer,
                selector.payloadPath
            )
        ) {
            return
        }
        descriptors.push({
            declaration: node,
            symbol: context.checker.getSymbolAtLocation(node.name),
        })
    })
    if (descriptors.length === 0) return []

    const matches = []
    visit(sourceFile, node => {
        if (!ts.isCallExpression(node)) return
        const call = callTarget(node)
        if (
            call.member !== selector.nativeMember ||
            call.receiver === undefined ||
            !typeMatches(
                context.checker,
                call.receiver,
                selector.nativeReceiverTypes
            )
        ) {
            return
        }
        const linked = node.arguments.some(argument => {
            if (!ts.isIdentifier(argument)) return false
            const symbol = context.checker.getSymbolAtLocation(argument)
            return descriptors.some(item =>
                item.symbol !== undefined &&
                symbol === item.symbol
            )
        })
        if (linked) matches.push(node)
    })
    return matches
}

function findLayoutContractMatches(sourceFile, evidence) {

    const selector = evidence.selector
    const matches = []
    visit(sourceFile, node => {
        if (
            !ts.isClassDeclaration(node) ||
            node.name?.text !== selector.exportName
        ) {
            return
        }
        const members = new Set(
            node.members.map(member => staticPropertyName(member.name))
        )
        if (selector.members.every(member => members.has(member))) {
            matches.push(node)
        }
    })
    return matches
}

function findBrowserExecutionMatches(sourceFile, evidence) {

    const selector = evidence.selector
    const contracts = findStaticContractCollection(
        sourceFile,
        selector.collection
    )
    const contract = contracts.find(item =>
        item[selector.contractKey] === selector.proofName
    )
    if (
        contract === undefined ||
        !deepEqual(
            contract.requiredFeatures,
            selector.requiredFeatures
        )
    ) {
        return []
    }
    const loops = []
    visit(sourceFile, node => {
        if (
            !ts.isForOfStatement(node) ||
            !ts.isIdentifier(node.expression) ||
            node.expression.text !== selector.collection
        ) {
            return
        }
        const loopVariable = forOfVariableName(node)
        if (loopVariable === undefined) return
        let runnerFound = false
        let resultFound = false
        visit(node.statement, child => {
            if (!ts.isCallExpression(child)) return
            const target = callTarget(child)
            if (
                selector.runnerNames.includes(target.member) &&
                child.arguments.some(argument =>
                    ts.isIdentifier(argument) &&
                    argument.text === loopVariable
                )
            ) {
                runnerFound = true
            }
            if (
                target.member === 'push' &&
                target.receiver !== undefined &&
                ts.isIdentifier(target.receiver) &&
                target.receiver.text === selector.resultCollection
            ) {
                resultFound = true
            }
        })
        if (runnerFound && resultFound) loops.push(node)
    })
    return loops
}

function validateCoverageEntry(entry, location) {

    assertPlainObject(entry, location)
    assertExactKeys(entry, [
        'coverageRule',
        'current',
        'domain',
        'evidenceIds',
        'expression',
        'goalStart',
        'id',
        'kind',
        'nativeLowering',
        'proof',
        'requirements',
        'source',
    ], location)
    assertNonEmptyString(entry.id, `${location}.id`)
    if (![ 'webgpu', 'wgsl' ].includes(entry.domain)) {
        throw new TypeError(`${location}.domain is invalid`)
    }
    assertNonEmptyString(entry.kind, `${location}.kind`)
    assertNonEmptyString(entry.coverageRule, `${location}.coverageRule`)
    validateEntrySource(entry.source, `${location}.source`)
    validateGoalStart(entry.goalStart, `${location}.goalStart`)
    validateEntryProof(entry.proof, entry, `${location}.proof`)
    validateCurrent(entry.current, `${location}.current`)
    validateExpression(entry.expression, `${location}.expression`)
    validateNativeLowering(
        entry.nativeLowering,
        `${location}.nativeLowering`
    )
    validateRequirements(entry.requirements, `${location}.requirements`)
    assertStringArray(entry.evidenceIds, `${location}.evidenceIds`, {
        nonEmpty: true,
        sorted: true,
        unique: true,
    })
    validateManagedProofChain(entry, location)
}

function validateEntryProof(proof, entry, location) {

    assertPlainObject(proof, location)
    assertExactKeys(
        proof,
        [ 'evidence', 'granularity', 'profile', 'selector' ],
        location
    )
    if (proof.granularity !== 'entry') {
        throw new TypeError(`${location}.granularity must be entry`)
    }
    assertNonEmptyString(proof.profile, `${location}.profile`)
    assertPlainObject(proof.selector, `${location}.selector`)
    assertExactKeys(proof.selector, [
        'domain',
        'entryKind',
        'id',
        'kind',
    ], `${location}.selector`)
    if (proof.selector.kind !== 'normative-entry') {
        throw new TypeError(
            `${location}.selector.kind must be normative-entry`
        )
    }
    if (
        proof.selector.id !== entry.id ||
        proof.selector.domain !== entry.domain ||
        proof.selector.entryKind !== entry.kind
    ) {
        throw new TypeError(
            `${location}.selector must match the containing entry`
        )
    }
    assertArray(proof.evidence, `${location}.evidence`)
    proof.evidence.forEach((item, index) =>
        validateStructuredEvidence(
            item,
            `${location}.evidence[${index}]`
        )
    )
    assertUniqueEvidence(proof.evidence, `${location}.evidence`)
}

function validateStructuredEvidence(evidence, location) {

    assertPlainObject(evidence, location)
    assertExactKeys(
        evidence,
        [ 'kind', 'operation', 'selector', 'sourcePath' ],
        location
    )
    if (!structuredProofKindSet.has(evidence.kind)) {
        throw new TypeError(
            `${location} has unknown proof kind ${String(evidence.kind)}`
        )
    }
    assertNonEmptyString(evidence.operation, `${location}.operation`)
    assertRepositoryRelativePath(
        evidence.sourcePath,
        `${location}.sourcePath`
    )
    validateSelector(
        evidence.kind,
        evidence.selector,
        `${location}.selector`
    )
}

function validateSelector(kind, selector, location) {

    assertPlainObject(selector, location)
    switch (kind) {
        case 'function-call':
            assertExactKeys(
                selector,
                [ 'member', 'receiverTypes' ],
                location,
                [ 'argumentLiterals' ]
            )
            assertNonEmptyString(selector.member, `${location}.member`)
            assertStringArray(
                selector.receiverTypes,
                `${location}.receiverTypes`,
                { sorted: true, unique: true }
            )
            if (selector.argumentLiterals !== undefined) {
                validateArgumentLiterals(
                    selector.argumentLiterals,
                    `${location}.argumentLiterals`
                )
            }
            return
        case 'constructor-call':
            assertExactKeys(selector, [ 'constructorTypes' ], location)
            assertStringArray(
                selector.constructorTypes,
                `${location}.constructorTypes`,
                { nonEmpty: true, sorted: true, unique: true }
            )
            return
        case 'property-read':
        case 'property-write':
            assertExactKeys(
                selector,
                [ 'member', 'receiverTypes' ],
                location
            )
            assertNonEmptyString(selector.member, `${location}.member`)
            assertStringArray(
                selector.receiverTypes,
                `${location}.receiverTypes`,
                { nonEmpty: true, sorted: true, unique: true }
            )
            return
        case 'descriptor-field':
            assertExactKeys(
                selector,
                [ 'field', 'ownerTypes' ],
                location
            )
            assertNonEmptyString(selector.field, `${location}.field`)
            assertStringArray(
                selector.ownerTypes,
                `${location}.ownerTypes`,
                { nonEmpty: true, sorted: true, unique: true }
            )
            return
        case 'public-export':
            assertExactKeys(selector, [ 'exportName' ], location)
            assertNonEmptyString(
                selector.exportName,
                `${location}.exportName`
            )
            return
        case 'scratch-operation':
            assertExactKeys(
                selector,
                [],
                location,
                [ 'exportName', 'member', 'symbolName' ]
            )
            if (
                (selector.exportName === undefined) ===
                (selector.symbolName === undefined)
            ) {
                throw new TypeError(
                    `${location} requires exactly one of exportName or symbolName`
                )
            }
            if (selector.exportName !== undefined) {
                assertNonEmptyString(
                    selector.exportName,
                    `${location}.exportName`
                )
            }
            if (selector.symbolName !== undefined) {
                assertNonEmptyString(
                    selector.symbolName,
                    `${location}.symbolName`
                )
            }
            if (selector.member !== undefined) {
                assertNonEmptyString(
                    selector.member,
                    `${location}.member`
                )
            }
            return
        case 'wgsl-contract':
            assertExactKeys(selector, [
                'contractId',
                'descriptorType',
                'nativeMember',
                'nativeReceiverTypes',
                'payloadField',
                'payloadPath',
            ], location)
            for (const key of [
                'contractId',
                'descriptorType',
                'nativeMember',
                'payloadField',
            ]) {
                assertNonEmptyString(selector[key], `${location}.${key}`)
            }
            assertStringArray(
                selector.nativeReceiverTypes,
                `${location}.nativeReceiverTypes`,
                { nonEmpty: true, sorted: true, unique: true }
            )
            assertStringArray(
                selector.payloadPath,
                `${location}.payloadPath`,
                { nonEmpty: true }
            )
            return
        case 'layout-contract':
            assertExactKeys(
                selector,
                [ 'exportName', 'members' ],
                location
            )
            assertNonEmptyString(
                selector.exportName,
                `${location}.exportName`
            )
            assertStringArray(
                selector.members,
                `${location}.members`,
                { nonEmpty: true, sorted: true, unique: true }
            )
            return
        case 'browser-execution':
            assertExactKeys(selector, [
                'collection',
                'contractKey',
                'proofName',
                'requiredFeatures',
                'resultCollection',
                'runnerNames',
            ], location)
            for (const key of [
                'collection',
                'contractKey',
                'proofName',
                'resultCollection',
            ]) {
                assertNonEmptyString(selector[key], `${location}.${key}`)
            }
            assertStringArray(
                selector.requiredFeatures,
                `${location}.requiredFeatures`,
                { sorted: true, unique: true }
            )
            assertStringArray(
                selector.runnerNames,
                `${location}.runnerNames`,
                { nonEmpty: true, sorted: true, unique: true }
            )
            return
        case 'n-a-composition':
            assertExactKeys(selector, [
                'hostInterface',
                'mixin',
                'normativeId',
                'reasonCode',
            ], location)
            for (const key of [
                'hostInterface',
                'mixin',
                'normativeId',
                'reasonCode',
            ]) {
                assertNonEmptyString(selector[key], `${location}.${key}`)
            }
            return
        case 'type-declaration':
            assertExactKeys(selector, [ 'typeName' ], location)
            assertNonEmptyString(
                selector.typeName,
                `${location}.typeName`
            )
            return
        case 'type-member':
            assertExactKeys(
                selector,
                [ 'member', 'memberKind', 'ownerType' ],
                location
            )
            assertNonEmptyString(
                selector.ownerType,
                `${location}.ownerType`
            )
            assertNonEmptyString(
                selector.member,
                `${location}.member`
            )
            if (![ 'method', 'property' ].includes(selector.memberKind)) {
                throw new TypeError(`${location}.memberKind is invalid`)
            }
            return
        default:
            throw new TypeError(`${location} has unknown proof kind ${kind}`)
    }
}

function validateManagedProofChain(entry, location) {

    const kinds = new Set(entry.proof.evidence.map(item => item.kind))
    if (entry.current.status === 'managed') {
        if (
            !kinds.has('public-export') ||
            !kinds.has('scratch-operation') ||
            entry.nativeLowering.operationEvidence.length === 0
        ) {
            throw new TypeError(
                `${location} has an incomplete managed proof chain`
            )
        }
        if (
            entry.domain === 'wgsl' &&
            !kinds.has('wgsl-contract')
        ) {
            throw new TypeError(
                `${location} has no WGSL payload contract`
            )
        }
        if (
            entry.domain === 'wgsl' &&
            (
                entry.kind === 'enable-extension' ||
                entry.kind === 'language-extension'
            ) &&
            !kinds.has('browser-execution')
        ) {
            throw new TypeError(
                `${location} has no browser execution proof`
            )
        }
    }
    if (
        entry.current.status === 'not-applicable' &&
        (
            entry.proof.evidence.length !== 1 ||
            !kinds.has('n-a-composition') ||
            entry.nativeLowering.operationEvidence.length !== 0
        )
    ) {
        throw new TypeError(
            `${location} has an invalid not-applicable proof chain`
        )
    }
}

function validateNativeLowering(lowering, location) {

    assertPlainObject(lowering, location)
    assertExactKeys(lowering, [
        'kind',
        'operationEvidence',
        'operations',
        'sourcePaths',
    ], location)
    assertNonEmptyString(lowering.kind, `${location}.kind`)
    assertStringArray(
        lowering.sourcePaths,
        `${location}.sourcePaths`,
        { sorted: true, unique: true }
    )
    assertStringArray(
        lowering.operations,
        `${location}.operations`,
        { sorted: true, unique: true }
    )
    assertArray(
        lowering.operationEvidence,
        `${location}.operationEvidence`
    )
    lowering.operationEvidence.forEach((item, index) =>
        validateStructuredEvidence(
            item,
            `${location}.operationEvidence[${index}]`
        )
    )
    assertUniqueEvidence(
        lowering.operationEvidence,
        `${location}.operationEvidence`
    )
    const operations = uniqueSorted(
        lowering.operationEvidence.map(item => item.operation)
    )
    const sourcePaths = uniqueSorted(
        lowering.operationEvidence.map(item => item.sourcePath)
    )
    if (!deepEqual(operations, lowering.operations)) {
        throw new TypeError(
            `${location}.operations do not match operationEvidence`
        )
    }
    if (!deepEqual(sourcePaths, lowering.sourcePaths)) {
        throw new TypeError(
            `${location}.sourcePaths do not match operationEvidence`
        )
    }
}

function validateRequirements(requirements, location) {

    assertPlainObject(requirements, location)
    assertExactKeys(requirements, [
        'conditions',
        'dependencies',
        'deviceFeatures',
        'enableExtensions',
        'languageFeatures',
        'limits',
        'policy',
    ], location)
    for (const key of [
        'dependencies',
        'deviceFeatures',
        'enableExtensions',
        'languageFeatures',
        'limits',
    ]) {
        assertStringArray(
            requirements[key],
            `${location}.${key}`,
            { sorted: true, unique: true }
        )
    }
    assertNonEmptyString(requirements.policy, `${location}.policy`)
    assertArray(requirements.conditions, `${location}.conditions`)
    requirements.conditions.forEach((condition, index) => {
        const conditionLocation = `${location}.conditions[${index}]`
        assertPlainObject(condition, conditionLocation)
        assertExactKeys(condition, [
            'dependencies',
            'deviceFeatures',
            'languageFeatures',
            'limits',
            'when',
        ], conditionLocation, [ 'deviceFeatureAlternatives' ])
        assertNonEmptyString(
            condition.when,
            `${conditionLocation}.when`
        )
        for (const key of [
            'dependencies',
            'deviceFeatures',
            'languageFeatures',
            'limits',
        ]) {
            assertStringArray(
                condition[key],
                `${conditionLocation}.${key}`,
                { sorted: true, unique: true }
            )
        }
        if (condition.deviceFeatureAlternatives !== undefined) {
            assertArray(
                condition.deviceFeatureAlternatives,
                `${conditionLocation}.deviceFeatureAlternatives`
            )
            condition.deviceFeatureAlternatives.forEach(
                (alternative, alternativeIndex) =>
                    assertStringArray(
                        alternative,
                        `${conditionLocation}.deviceFeatureAlternatives[` +
                        `${alternativeIndex}]`,
                        { nonEmpty: true, sorted: true, unique: true }
                    )
            )
        }
    })
}

function verifyEntryProofBindings(entry, normative) {

    const publicExports = uniqueSorted(
        entry.proof.evidence
            .filter(item => item.kind === 'public-export')
            .map(item => item.selector.exportName)
    )
    if (!deepEqual(publicExports, entry.expression.publicSymbols)) {
        throw new Error(
            `${entry.id} public export proof does not match expression symbols`
        )
    }
    const scratchSymbols = uniqueSorted(
        entry.proof.evidence
            .filter(item => item.kind === 'scratch-operation')
            .map(item =>
                item.selector.exportName ??
                item.selector.symbolName
            )
    )
    if (!deepEqual(scratchSymbols, entry.expression.publicSymbols)) {
        throw new Error(
            `${entry.id} Scratch operation proof does not match expression symbols`
        )
    }
    if (entry.current.status === 'managed') {
        for (const proof of entry.nativeLowering.operationEvidence) {
            if (!proof.sourcePath.startsWith(managedScratchSourcePrefix)) {
                throw new Error(
                    `${entry.id} native lowering points outside managed ` +
                    `Scratch source: ${proof.sourcePath}`
                )
            }
        }
    }
    for (const proof of entry.proof.evidence) {
        if (
            proof.kind === 'browser-execution' &&
            !deepEqual(
                proof.selector.requiredFeatures,
                entry.requirements.deviceFeatures
            )
        ) {
            throw new Error(
                `${entry.id} browser proof requirements do not match`
            )
        }
    }
    const expected = createEntryProofEvidence({
        domain: entry.domain,
        entry: normative,
        publicSymbols: entry.expression.publicSymbols,
        proofProfile: entry.proof.profile,
        status: entry.current.status,
        requirements: entry.requirements,
        normativeManifest: entry.source.normativeManifest,
    })
    if (!deepEqual(entry.proof.evidence, expected)) {
        if (entry.domain === 'webgpu') {
            throw new Error(
                `${entry.id} WebGPU type proof does not match its normative entry`
            )
        }
        if (entry.current.status === 'not-applicable') {
            throw new Error(
                `${entry.id} N/A composition proof does not match its entry`
            )
        }
        throw new Error(
            `${entry.id} WGSL contract proof does not match its normative entry`
        )
    }
}

function verifyNormativeSourceBinding(entry, normative, manifest) {

    const baseline = entry.domain === 'webgpu'
        ? manifest.baseline.webgpu
        : manifest.baseline.wgsl
    const normativeManifest = entry.domain === 'webgpu'
        ? manifest.normativeManifests.webgpu
        : manifest.normativeManifests.wgsl
    const expected = {
        publication: baseline.publication,
        url: `${baseline.url}#${normative.sourceAnchor}`,
        anchor: normative.sourceAnchor,
        normativeManifest,
    }
    if (!deepEqual(entry.source, expected)) {
        throw new Error(
            `${entry.id} normative source does not match its inventory entry`
        )
    }
}

function verifySummaryClosure(manifest, {
    normativeWebGpu,
    normativeWgsl,
    frozenWebGpu,
    frozenWgsl,
}) {

    const summary = manifest.summary
    const expected = {
        entryCount: manifest.entries.length,
        webgpuNormativeEntryCount: normativeWebGpu.entries.length,
        wgslNormativeEntryCount: normativeWgsl.entries.length,
        frozenWebgpuHistoricalEntryCount: frozenWebGpu.entries.length,
        frozenWgslHistoricalEntryCount: frozenWgsl.entries.length,
        unresolvedCount: manifest.entries.filter(
            entry => entry.current.status === 'unresolved'
        ).length,
        byStatus: countEntriesBy(
            manifest.entries,
            entry => entry.current.status
        ),
        byClassification: countEntriesBy(
            manifest.entries,
            entry => entry.current.classification
        ),
    }
    if (!deepEqual(summary, expected)) {
        throw new Error('manifest summary does not match its entries')
    }
}

function countEntriesBy(entries, select) {

    const counts = {}
    for (const entry of entries) {
        const value = select(entry)
        counts[value] = (counts[value] ?? 0) + 1
    }
    return counts
}

function verifyRequirementValues(entry, known) {

    const requirements = [
        entry.requirements,
        ...entry.requirements.conditions,
    ]
    for (const requirement of requirements) {
        assertValuesKnown(
            requirement.dependencies,
            known.knownDependencies,
            `${entry.id}.dependencies`
        )
        assertValuesKnown(
            requirement.deviceFeatures,
            known.knownDeviceFeatures,
            `${entry.id}.deviceFeatures`
        )
        assertValuesKnown(
            requirement.languageFeatures,
            known.knownLanguageFeatures,
            `${entry.id}.languageFeatures`
        )
        assertValuesKnown(
            requirement.limits,
            known.knownLimits,
            `${entry.id}.limits`
        )
        if (requirement.enableExtensions !== undefined) {
            assertValuesKnown(
                requirement.enableExtensions,
                known.knownEnableExtensions,
                `${entry.id}.enableExtensions`
            )
        }
        for (
            const alternative of
            requirement.deviceFeatureAlternatives ?? []
        ) {
            assertValuesKnown(
                alternative,
                known.knownDeviceFeatures,
                `${entry.id}.deviceFeatureAlternatives`
            )
        }
    }
}

function webGpuTypeEvidence(entry) {

    if (entry.kind === 'method' && entry.member === 'constructor') {
        return {
            kind: 'constructor-call',
            operation: `${entry.id} structured diagnostic construction`,
            sourcePath:
                'packages/geoscratch/src/scratch/diagnostics.ts',
            selector: {
                constructorTypes: [ 'ScratchDiagnosticError' ],
            },
        }
    }
    if (entry.kind === 'property') {
        if (entry.sourceKind === 'dictionary') {
            return {
                kind: 'descriptor-field',
                operation: `${entry.owner}.${entry.member} type contract`,
                sourcePath: webGpuTypesPath,
                selector: {
                    field: entry.member,
                    ownerTypes: [ entry.owner ],
                },
            }
        }
        return {
            kind: 'type-member',
            operation: `${entry.owner}.${entry.member} type contract`,
            sourcePath: webGpuTypesPath,
            selector: {
                ownerType: entry.owner,
                member: entry.member,
                memberKind: 'property',
            },
        }
    }
    if (entry.kind === 'method') {
        return {
            kind: 'type-member',
            operation: `${entry.owner}.${entry.member} type contract`,
            sourcePath: webGpuTypesPath,
            selector: {
                ownerType: entry.owner,
                member: entry.member,
                memberKind: 'method',
            },
        }
    }
    return {
        kind: 'type-declaration',
        operation: `${entry.owner} type contract`,
        sourcePath: webGpuTypesPath,
        selector: { typeName: entry.owner },
    }
}

function wgslContractEvidence(entry) {

    return {
        kind: 'wgsl-contract',
        operation: `${entry.id} caller-authored WGSL lowering`,
        sourcePath:
            'packages/geoscratch/src/scratch/shader-module.ts',
        selector: {
            contractId: entry.id,
            descriptorType: 'GPUShaderModuleDescriptor',
            payloadField: 'code',
            payloadPath: [ 'sourceSnapshot', 'combinedSource' ],
            nativeMember: 'createShaderModule',
            nativeReceiverTypes: [ 'GPUDevice' ],
        },
    }
}

function layoutContractEvidence(entry) {

    return {
        kind: 'layout-contract',
        operation: `${entry.id} layout codec contract`,
        sourcePath:
            'packages/geoscratch/src/scratch/layout-codec.ts',
        selector: {
            exportName: 'LayoutCodec',
            members: [
                'createReadbackView',
                'pack',
                'wgslAccessors',
            ],
        },
    }
}

function browserExecutionEvidence(entry, requirements) {

    const enable = entry.kind === 'enable-extension'
    return {
        kind: 'browser-execution',
        operation: `${entry.id} browser execution`,
        sourcePath: wgslBrowserMatrixPath,
        selector: {
            proofName: entry.name,
            collection: enable
                ? 'enableContracts'
                : 'languageContracts',
            contractKey: enable ? 'extension' : 'name',
            requiredFeatures: [ ...requirements.deviceFeatures ],
            runnerNames: enable
                ? [
                    'runF16LayoutProof',
                    'runRenderEnableProof',
                    'runSubgroupProof',
                    'runSubgroupSizeProof',
                ]
                : [
                    'runImmediateProof',
                    'runLanguageSemanticProof',
                ],
            resultCollection: enable
                ? 'enableResults'
                : 'languageResults',
        },
    }
}

function assertNotApplicableComposition(evidence) {

    const selector = evidence.selector
    const expected = {
        'includes.Navigator.NavigatorGPU': 'Navigator',
        'includes.WorkerNavigator.NavigatorGPU': 'WorkerNavigator',
    }
    if (
        selector.reasonCode !== 'host-dom-composition' ||
        selector.mixin !== 'NavigatorGPU' ||
        expected[selector.normativeId] !== selector.hostInterface
    ) {
        throw new Error(
            `${evidence.operation} did not resolve as an allowed N/A composition`
        )
    }
}

function validateProofSystem(system) {

    assertPlainObject(system, 'manifest.proofSystem')
    assertExactKeys(system, [
        'engine',
        'rawNativeHandlesManaged',
        'selectorKinds',
    ], 'manifest.proofSystem')
    if (system.engine !== 'typescript-ast-type-aware') {
        throw new TypeError('manifest.proofSystem.engine is invalid')
    }
    if (system.rawNativeHandlesManaged !== false) {
        throw new TypeError(
            'manifest.proofSystem.rawNativeHandlesManaged must be false'
        )
    }
    assertExactStringArray(
        system.selectorKinds,
        structuredProofKinds,
        'manifest.proofSystem.selectorKinds'
    )
}

function validateEvidenceRecord(record, location) {

    assertPlainObject(record, location)
    assertExactKeys(record, [
        'browserPaths',
        'claim',
        'id',
        'publicSymbols',
        'sourcePaths',
        'testPaths',
    ], location)
    assertNonEmptyString(record.id, `${location}.id`)
    assertNonEmptyString(record.claim, `${location}.claim`)
    for (const key of [
        'browserPaths',
        'publicSymbols',
        'sourcePaths',
        'testPaths',
    ]) {
        assertStringArray(record[key], `${location}.${key}`, {
            sorted: true,
            unique: true,
        })
    }
}

function validateEntrySource(source, location) {

    assertPlainObject(source, location)
    assertExactKeys(source, [
        'anchor',
        'normativeManifest',
        'publication',
        'url',
    ], location)
    for (const key of Object.keys(source)) {
        assertNonEmptyString(source[key], `${location}.${key}`)
    }
}

function validateGoalStart(goalStart, location) {

    assertPlainObject(goalStart, location)
    assertExactKeys(goalStart, [
        'rationale',
        'status',
    ], location, [ 'family' ])
    assertNonEmptyString(goalStart.status, `${location}.status`)
    assertNonEmptyString(goalStart.rationale, `${location}.rationale`)
    if (goalStart.family !== undefined) {
        assertNonEmptyString(goalStart.family, `${location}.family`)
    }
}

function validateCurrent(current, location) {

    assertPlainObject(current, location)
    assertExactKeys(
        current,
        [ 'classification', 'rationale', 'status' ],
        location
    )
    if (![
        'managed',
        'not-applicable',
        'unresolved',
    ].includes(current.status)) {
        throw new TypeError(`${location}.status is invalid`)
    }
    if (![
        'managed-first-class',
        'managed-semantic-equivalent',
        'not-applicable',
        'unresolved',
    ].includes(current.classification)) {
        throw new TypeError(`${location}.classification is invalid`)
    }
    assertNonEmptyString(current.rationale, `${location}.rationale`)
}

function validateExpression(expression, location) {

    assertPlainObject(expression, location)
    assertExactKeys(
        expression,
        [ 'contract', 'mode', 'publicSymbols' ],
        location
    )
    assertNonEmptyString(expression.mode, `${location}.mode`)
    assertNonEmptyString(expression.contract, `${location}.contract`)
    assertStringArray(
        expression.publicSymbols,
        `${location}.publicSymbols`,
        { sorted: true, unique: true }
    )
}

function validateBaseline(baseline) {

    assertPlainObject(baseline, 'manifest.baseline')
    assertExactKeys(baseline, [
        'gpuwebEditor',
        'gpuwebTypes',
        'proposalIndex',
        'refreshedOn',
        'webgpu',
        'wgsl',
    ], 'manifest.baseline')
    assertNonEmptyString(
        baseline.refreshedOn,
        'manifest.baseline.refreshedOn'
    )
    assertExactKeys(baseline.webgpu, [
        'publication',
        'sha256',
        'url',
    ], 'manifest.baseline.webgpu')
    assertExactKeys(baseline.wgsl, [
        'publication',
        'sha256',
        'url',
    ], 'manifest.baseline.wgsl')
    assertExactKeys(baseline.gpuwebEditor, [
        'delta',
        'frozenBaselineCommit',
        'normativeDelta',
        'observedOn',
        'refreshedCommit',
        'sourceUrl',
        'url',
    ], 'manifest.baseline.gpuwebEditor')
    assertExactKeys(baseline.gpuwebTypes, [
        'declarationSha256',
        'observedOn',
        'packageVersion',
        'repositoryCommit',
        'sourceUrl',
        'url',
    ], 'manifest.baseline.gpuwebTypes')
    assertExactKeys(baseline.proposalIndex, [
        'draftProposalsInScope',
        'observedOn',
        'readmeSha256',
        'sourceUrl',
        'url',
    ], 'manifest.baseline.proposalIndex')
}

function validateSummary(summary) {

    assertPlainObject(summary, 'manifest.summary')
    assertExactKeys(summary, [
        'byClassification',
        'byStatus',
        'entryCount',
        'frozenWebgpuHistoricalEntryCount',
        'frozenWgslHistoricalEntryCount',
        'unresolvedCount',
        'webgpuNormativeEntryCount',
        'wgslNormativeEntryCount',
    ], 'manifest.summary')
    for (const key of [
        'entryCount',
        'frozenWebgpuHistoricalEntryCount',
        'frozenWgslHistoricalEntryCount',
        'unresolvedCount',
        'webgpuNormativeEntryCount',
        'wgslNormativeEntryCount',
    ]) {
        if (!Number.isSafeInteger(summary[key]) || summary[key] < 0) {
            throw new TypeError(`manifest.summary.${key} must be a count`)
        }
    }
    assertCountMap(
        summary.byClassification,
        'manifest.summary.byClassification'
    )
    assertCountMap(summary.byStatus, 'manifest.summary.byStatus')
}

function validateArgumentLiterals(values, location) {

    assertArray(values, location)
    values.forEach((value, index) => {
        const itemLocation = `${location}[${index}]`
        assertPlainObject(value, itemLocation)
        assertExactKeys(value, [ 'index', 'value' ], itemLocation)
        if (!Number.isSafeInteger(value.index) || value.index < 0) {
            throw new TypeError(`${itemLocation}.index is invalid`)
        }
        if (
            typeof value.value !== 'string' &&
            typeof value.value !== 'number' &&
            typeof value.value !== 'boolean' &&
            value.value !== null
        ) {
            throw new TypeError(`${itemLocation}.value is not a literal`)
        }
    })
}

function collectStringLiteralMembers(
    context,
    sourcePath,
    typeName
) {

    const absolutePath = resolveRepositoryPath(context.root, sourcePath)
    const sourceFile = context.program.getSourceFile(absolutePath)
    if (sourceFile === undefined) {
        throw new Error(`${sourcePath} is missing from the TypeScript Program`)
    }
    const values = new Set()
    visit(sourceFile, node => {
        if (
            !ts.isTypeAliasDeclaration(node) ||
            node.name.text !== typeName
        ) {
            return
        }
        collectLiteralTypeValues(node.type, values)
    })
    if (values.size === 0) {
        throw new Error(`${typeName} has no string literal members`)
    }
    return values
}

function collectLiteralTypeValues(node, values) {

    if (ts.isUnionTypeNode(node)) {
        node.types.forEach(type => collectLiteralTypeValues(type, values))
        return
    }
    if (
        ts.isLiteralTypeNode(node) &&
        ts.isStringLiteral(node.literal)
    ) {
        values.add(node.literal.text)
    }
}

function call(sourcePath, operation, member, receiverTypes, argumentLiterals) {

    return {
        kind: 'function-call',
        operation,
        sourcePath,
        selector: {
            member,
            receiverTypes: uniqueSorted(receiverTypes),
            ...(argumentLiterals === undefined
                ? {}
                : { argumentLiterals }),
        },
    }
}

function propertyRead(
    sourcePath,
    operation,
    member,
    receiverTypes
) {

    return {
        kind: 'property-read',
        operation,
        sourcePath,
        selector: {
            member,
            receiverTypes: uniqueSorted(receiverTypes),
        },
    }
}

function scratchOperation(sourcePath, operation, symbolName) {

    return {
        kind: 'scratch-operation',
        operation,
        sourcePath,
        selector: { symbolName },
    }
}

function scratchMember(
    sourcePath,
    operation,
    symbolName,
    member
) {

    return {
        kind: 'scratch-operation',
        operation,
        sourcePath,
        selector: { symbolName, member },
    }
}

function operationKey(sourcePath, operation) {

    return `${sourcePath}\u0000${operation}`
}

function callTarget(node) {

    if (ts.isPropertyAccessExpression(node.expression)) {
        return {
            member: node.expression.name.text,
            receiver: node.expression.expression,
        }
    }
    if (ts.isElementAccessExpression(node.expression)) {
        const member = staticLiteralValue(
            node.expression.argumentExpression
        )
        return {
            member: typeof member === 'string' ? member : undefined,
            receiver: node.expression.expression,
        }
    }
    if (ts.isIdentifier(node.expression)) {
        return { member: node.expression.text }
    }
    return {}
}

function typeMatches(checker, node, expectedTypes) {

    return typeValueMatches(
        checker,
        checker.getTypeAtLocation(node),
        expectedTypes
    )
}

function typeValueMatches(checker, type, expectedTypes) {

    const actual = new Set()
    collectTypeNames(checker, type, actual)
    return expectedTypes.some(expected => actual.has(expected))
}

function collectTypeNames(checker, type, names) {

    names.add(checker.typeToString(type))
    if (type.symbol !== undefined) names.add(type.symbol.name)
    if (type.aliasSymbol !== undefined) names.add(type.aliasSymbol.name)
    if (type.isUnionOrIntersection()) {
        type.types.forEach(member =>
            collectTypeNames(checker, member, names)
        )
    }
    const target = type.target
    if (target !== undefined && target !== type) {
        collectTypeNames(checker, target, names)
    }
}

function argumentsMatch(argumentsList, expected) {

    return expected.every(item =>
        item.index < argumentsList.length &&
        staticLiteralValue(argumentsList[item.index]) === item.value
    )
}

function staticLiteralValue(node) {

    if (
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node)
    ) {
        return node.text
    }
    if (ts.isNumericLiteral(node)) return Number(node.text)
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false
    if (node.kind === ts.SyntaxKind.NullKeyword) return null
    return undefined
}

function staticExpressionName(expression) {

    if (ts.isIdentifier(expression)) return expression.text
    if (ts.isPropertyAccessExpression(expression)) {
        return expression.name.text
    }
    return undefined
}

function isWriteAccess(node) {

    const parent = node.parent
    if (
        ts.isBinaryExpression(parent) &&
        parent.left === node &&
        parent.operatorToken.kind >=
            ts.SyntaxKind.FirstAssignment &&
        parent.operatorToken.kind <=
            ts.SyntaxKind.LastAssignment
    ) {
        return true
    }
    return (
        (
            ts.isPrefixUnaryExpression(parent) ||
            ts.isPostfixUnaryExpression(parent)
        ) &&
        (
            parent.operator === ts.SyntaxKind.PlusPlusToken ||
            parent.operator === ts.SyntaxKind.MinusMinusToken
        )
    )
}

function declaredObjectLiteralType(checker, objectLiteral) {

    const parent = objectLiteral.parent
    if (
        ts.isVariableDeclaration(parent) &&
        parent.initializer === objectLiteral &&
        parent.type !== undefined
    ) {
        return checker.getTypeFromTypeNode(parent.type)
    }
    if (
        ts.isAsExpression(parent) ||
        ts.isTypeAssertionExpression(parent) ||
        ts.isSatisfiesExpression(parent)
    ) {
        return checker.getTypeFromTypeNode(parent.type)
    }
    return undefined
}

function expressionPathMatches(expression, expectedPath) {

    const actual = []
    let current = expression
    while (ts.isPropertyAccessExpression(current)) {
        actual.unshift(current.name.text)
        current = current.expression
    }
    if (ts.isIdentifier(current)) actual.unshift(current.text)
    return deepEqual(actual, expectedPath)
}

function objectProperty(objectLiteral, name) {

    const matches = objectLiteral.properties.filter(property =>
        (
            ts.isPropertyAssignment(property) ||
            ts.isShorthandPropertyAssignment(property)
        ) &&
        staticPropertyName(property.name) === name
    )
    return matches.length === 1 ? matches[0] : undefined
}

function findStaticContractCollection(sourceFile, collectionName) {

    const matches = []
    visit(sourceFile, node => {
        if (
            !ts.isVariableDeclaration(node) ||
            !ts.isIdentifier(node.name) ||
            node.name.text !== collectionName ||
            !ts.isArrayLiteralExpression(node.initializer)
        ) {
            return
        }
        matches.push(node.initializer)
    })
    if (matches.length !== 1) return []
    const contracts = []
    for (const element of matches[0].elements) {
        if (!ts.isObjectLiteralExpression(element)) return []
        const contract = {}
        for (const property of element.properties) {
            if (!ts.isPropertyAssignment(property)) return []
            const name = staticPropertyName(property.name)
            if (name === undefined) return []
            if (ts.isArrayLiteralExpression(property.initializer)) {
                const values = property.initializer.elements.map(
                    staticLiteralValue
                )
                if (values.some(value => value === undefined)) return []
                contract[name] = values
            } else {
                const value = staticLiteralValue(property.initializer)
                if (value === undefined) return []
                contract[name] = value
            }
        }
        contracts.push(contract)
    }
    return contracts
}

function forOfVariableName(statement) {

    const declarationList = statement.initializer
    if (
        !ts.isVariableDeclarationList(declarationList) ||
        declarationList.declarations.length !== 1
    ) {
        return undefined
    }
    const declaration = declarationList.declarations[0]
    return ts.isIdentifier(declaration.name)
        ? declaration.name.text
        : undefined
}

function declarationName(node) {

    if (
        ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isEnumDeclaration(node)
    ) {
        return node.name?.text
    }
    return undefined
}

function hasDeclaredMember(node, name) {

    return typeDeclarationMembers(node).some(member =>
        staticPropertyName(member.name) === name
    )
}

function typeDeclarationMembers(node) {

    if (
        ts.isClassDeclaration(node) ||
        ts.isInterfaceDeclaration(node)
    ) {
        return [ ...node.members ]
    }
    if (
        ts.isTypeAliasDeclaration(node) &&
        ts.isTypeLiteralNode(node.type)
    ) {
        return [ ...node.type.members ]
    }
    return []
}

function enclosingTypeName(node) {

    let current = node.parent
    while (current !== undefined) {
        if (
            ts.isInterfaceDeclaration(current) ||
            ts.isClassDeclaration(current) ||
            ts.isTypeAliasDeclaration(current)
        ) {
            return current.name?.text
        }
        current = current.parent
    }
    return undefined
}

function staticPropertyName(name) {

    if (name === undefined) return undefined
    if (
        ts.isIdentifier(name) ||
        ts.isStringLiteral(name) ||
        ts.isNumericLiteral(name) ||
        ts.isNoSubstitutionTemplateLiteral(name)
    ) {
        return name.text
    }
    return undefined
}

function resolveAliasedSymbol(checker, symbol) {

    const seen = new Set()
    let current = symbol
    while (
        (current.flags & ts.SymbolFlags.Alias) !== 0 &&
        !seen.has(current)
    ) {
        seen.add(current)
        current = checker.getAliasedSymbol(current)
    }
    return current
}

function isScratchSourceDeclaration(root, declaration) {

    const sourcePath = path.resolve(declaration.getSourceFile().fileName)
    const scratchRoot = path.join(
        path.resolve(root),
        'packages/geoscratch/src/scratch'
    )
    return (
        sourcePath === scratchRoot ||
        sourcePath.startsWith(`${scratchRoot}${path.sep}`)
    )
}

function visit(node, callback) {

    callback(node)
    ts.forEachChild(node, child => visit(child, callback))
}

function assertRepositoryRelativePath(value, location) {

    assertNonEmptyString(value, location)
    if (
        path.isAbsolute(value) ||
        value.includes('\\') ||
        value.split('/').some(segment =>
            segment === '' ||
            segment === '.' ||
            segment === '..'
        )
    ) {
        throw new TypeError(`${location} must be repository-relative`)
    }
}

function resolveRepositoryPath(root, relativePath) {

    assertRepositoryRelativePath(relativePath, 'sourcePath')
    const absoluteRoot = path.resolve(root)
    const absolutePath = path.resolve(absoluteRoot, relativePath)
    if (
        absolutePath !== absoluteRoot &&
        !absolutePath.startsWith(`${absoluteRoot}${path.sep}`)
    ) {
        throw new TypeError('sourcePath must be repository-relative')
    }
    if (!fs.existsSync(absolutePath)) {
        throw new Error(`sourcePath does not exist: ${relativePath}`)
    }
    return absolutePath
}

function assertPlainObject(value, location) {

    if (
        value === null ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Object.prototype
    ) {
        throw new TypeError(`${location} must be a plain object`)
    }
}

function assertExactKeys(
    value,
    requiredKeys,
    location,
    optionalKeys = []
) {

    const allowed = new Set([ ...requiredKeys, ...optionalKeys ])
    for (const key of Object.keys(value)) {
        if (!allowed.has(key)) {
            throw new TypeError(`${location} has unknown key ${key}`)
        }
    }
    for (const key of requiredKeys) {
        if (!Object.hasOwn(value, key)) {
            throw new TypeError(`${location} is missing key ${key}`)
        }
    }
}

function assertNonEmptyString(value, location) {

    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`${location} must be a non-empty string`)
    }
}

function assertArray(value, location) {

    if (!Array.isArray(value)) {
        throw new TypeError(`${location} must be an array`)
    }
}

function assertStringArray(value, location, {
    nonEmpty = false,
    sorted = false,
    unique = false,
} = {}) {

    assertArray(value, location)
    if (nonEmpty && value.length === 0) {
        throw new TypeError(`${location} must not be empty`)
    }
    for (const item of value) {
        assertNonEmptyString(item, location)
    }
    if (unique && new Set(value).size !== value.length) {
        throw new TypeError(`${location} contains duplicate values`)
    }
    if (sorted && !deepEqual(value, [ ...value ].sort())) {
        throw new TypeError(`${location} must be sorted`)
    }
}

function assertExactStringArray(value, expected, location) {

    assertStringArray(value, location, { unique: true })
    if (!deepEqual(value, expected)) {
        throw new TypeError(`${location} does not match its authority`)
    }
}

function assertExactStringMap(value, keys, location) {

    assertPlainObject(value, location)
    assertExactKeys(value, keys, location)
    for (const key of keys) {
        assertRepositoryRelativePath(value[key], `${location}.${key}`)
    }
}

function assertCountMap(value, location) {

    assertPlainObject(value, location)
    for (const [ key, count ] of Object.entries(value)) {
        assertNonEmptyString(key, `${location} key`)
        if (!Number.isSafeInteger(count) || count < 0) {
            throw new TypeError(`${location}.${key} must be a count`)
        }
    }
}

function assertUniqueEvidence(values, location) {

    const serialized = values.map(value => JSON.stringify(value))
    if (new Set(serialized).size !== serialized.length) {
        throw new TypeError(`${location} contains duplicate proof evidence`)
    }
}

function assertUniqueBy(values, select, location) {

    const keys = values.map(select)
    if (new Set(keys).size !== keys.length) {
        throw new TypeError(`${location} contains duplicate values`)
    }
}

function assertValuesKnown(values, known, location) {

    for (const value of values) {
        if (!known.has(value)) {
            throw new Error(`${location} contains unknown value ${value}`)
        }
    }
}

function readJsonAt(root, relativePath) {

    return JSON.parse(fs.readFileSync(
        resolveRepositoryPath(root, relativePath),
        'utf8'
    ))
}

function sortEvidence(values) {

    return values.sort((left, right) =>
        left.kind.localeCompare(right.kind) ||
        left.operation.localeCompare(right.operation) ||
        left.sourcePath.localeCompare(right.sourcePath)
    )
}

function uniqueSorted(values) {

    return [ ...new Set(values) ].sort()
}

function cloneJson(value) {

    return JSON.parse(JSON.stringify(value))
}

function deepEqual(left, right) {

    return JSON.stringify(left) === JSON.stringify(right)
}

function formatTypeScriptDiagnostic(diagnostic) {

    return ts.flattenDiagnosticMessageText(
        diagnostic.messageText,
        '\n'
    )
}
