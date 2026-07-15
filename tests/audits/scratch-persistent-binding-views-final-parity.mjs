import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { Socket } from 'node:net'
import ts from 'typescript'

const goalBaseline = '26c6d8875caea7612e573dfb4e33e1340a016d46'
const historicalJavaScript = '20bb393df570ff1914a6789e9bd422d59ddfecc8'
const cleanThirtySixthReviewCheckpoint = '4926648e8258fcb6a58e6746704c708beab611e6'
const cleanThirtySeventhReviewCheckpoint = '3d5f4d73c64eb5cc1108cd26fa31fec546badb3d'
const cleanThirtyEighthReviewCheckpoint = 'c9cfad3decd3380c2d03509482b549d3275e1c1c'
const acceptanceMode = process.env.SCRATCH_FINAL_AUDIT === '1'
const expectedFocusedAcceptancePasses = 479
const expectedFullSuitePasses = 877
const expectedFullSuitePending = 2
const expectedFullSuiteTests = expectedFullSuitePasses + expectedFullSuitePending
const expectedFullSuitePendingIdentities = Object.freeze([
    Object.freeze({
        file: 'tests/scratch-persistent-binding-browser.test.js',
        fullTitle: 'Scratch persistent binding browser gate executes the headed acceptance proof when the browser gate is enabled',
    }),
    Object.freeze({
        file: 'tests/scratch-persistent-binding-final-parity.test.js',
        fullTitle: 'Scratch persistent binding final parity executes every acceptance gate when final audit mode is enabled',
    }),
])
const officialSpecificationSource =
    'https://raw.githubusercontent.com/gpuweb/gpuweb/main/spec/index.bs'
const officialCopiesSpecificationSource =
    'https://raw.githubusercontent.com/gpuweb/gpuweb/main/spec/sections/copies.bs'
const officialWebIdlSource =
    'https://raw.githubusercontent.com/whatwg/webidl/main/index.bs'
const officialSpecification = Object.freeze({
    resourceBinding: 'https://gpuweb.github.io/gpuweb/#resource-binding',
    textureViews: 'https://gpuweb.github.io/gpuweb/#texture-view-creation',
    copies: 'https://gpuweb.github.io/gpuweb/#copies',
    querySets: 'https://gpuweb.github.io/gpuweb/#query-sets',
    source: officialSpecificationSource,
    copiesSource: officialCopiesSpecificationSource,
    webIdlSource: officialWebIdlSource,
})
const webGpuTypesPath = 'node_modules/@webgpu/types/dist/index.d.ts'
const webGpuTypesPackagePath = 'node_modules/@webgpu/types/package.json'
const webGpuTypesSource = fs.readFileSync(webGpuTypesPath, 'utf8')
const webGpuTypesPackage = JSON.parse(fs.readFileSync(webGpuTypesPackagePath, 'utf8'))

const currentPaths = Object.freeze({
    packageIndex: 'packages/geoscratch/src/index.ts',
    scratchIndex: 'packages/geoscratch/src/scratch/index.ts',
    scratchShim: 'packages/geoscratch/src/scratch.ts',
    runtime: 'packages/geoscratch/src/scratch/runtime.ts',
    surface: 'packages/geoscratch/src/scratch/surface.ts',
    resource: 'packages/geoscratch/src/scratch/resource.ts',
    buffer: 'packages/geoscratch/src/scratch/buffer.ts',
    texture: 'packages/geoscratch/src/scratch/texture.ts',
    textureFormatCapabilities: 'packages/geoscratch/src/scratch/texture-format-capabilities.ts',
    layoutCodec: 'packages/geoscratch/src/scratch/layout-codec.ts',
    sampler: 'packages/geoscratch/src/scratch/sampler.ts',
    querySet: 'packages/geoscratch/src/scratch/query-set.ts',
    binding: 'packages/geoscratch/src/scratch/binding.ts',
    program: 'packages/geoscratch/src/scratch/program.ts',
    pipeline: 'packages/geoscratch/src/scratch/pipeline.ts',
    command: 'packages/geoscratch/src/scratch/command.ts',
    pass: 'packages/geoscratch/src/scratch/pass.ts',
    shaderInspection: 'packages/geoscratch/src/scratch/shader-inspection.ts',
    readback: 'packages/geoscratch/src/scratch/readback.ts',
    supportingObjectCreation: 'packages/geoscratch/src/scratch/supporting-object-creation.ts',
    supportingObjectFailure: 'packages/geoscratch/src/scratch/supporting-object-failure.ts',
    submission: 'packages/geoscratch/src/scratch/submission.ts',
    gpuOperation: 'packages/geoscratch/src/scratch/gpu-operation.ts',
    runtimeDiagnostics: 'packages/geoscratch/src/scratch/runtime-diagnostics.ts',
})
const baselinePaths = Object.freeze(Object.fromEntries(
    Object.entries(currentPaths).filter(([ name ]) =>
        name !== 'scratchShim' &&
        name !== 'textureFormatCapabilities' &&
        name !== 'supportingObjectCreation' &&
        name !== 'supportingObjectFailure'
    )
))
const historicalPaths = Object.freeze({
    packageIndex: 'packages/geoscratch/src/index.js',
    packageTypes: 'packages/geoscratch/src/index.d.ts',
    scratchIndex: 'packages/geoscratch/src/scratch/index.js',
    runtime: 'packages/geoscratch/src/scratch/runtime.js',
    resource: 'packages/geoscratch/src/scratch/resource.js',
    buffer: 'packages/geoscratch/src/scratch/buffer.js',
    texture: 'packages/geoscratch/src/scratch/texture.js',
    sampler: 'packages/geoscratch/src/scratch/sampler.js',
    querySet: 'packages/geoscratch/src/scratch/query-set.js',
    binding: 'packages/geoscratch/src/scratch/binding.js',
    program: 'packages/geoscratch/src/scratch/program.js',
    pipeline: 'packages/geoscratch/src/scratch/pipeline.js',
    command: 'packages/geoscratch/src/scratch/command.js',
    pass: 'packages/geoscratch/src/scratch/pass.js',
    readback: 'packages/geoscratch/src/scratch/readback.js',
    submission: 'packages/geoscratch/src/scratch/submission.js',
})

const ordinaryExamples = Object.freeze([
    'computeReadback',
    'externalImageUpload',
    'helloTriangle',
    'helloVertexBuffer',
    'indirectExecution',
    'readinessPolicies',
    'renderToTexture',
    'submissionOrder',
    'textureResize',
    'textureSampling',
    'uniformTriangle',
])
const legacyExamples = Object.freeze([ 'm_demLayer', 'm_flowLayer', 'x_helloGAW' ])
const historicalTypeInventory = Object.freeze([
    { name: 'BufferResourceDescriptor', classification: 'restored', current: 'BufferResourceDescriptor' },
    { name: 'NormalizedDrawVertexBufferBinding', classification: 'internal', current: null },
    { name: 'ProgramDescriptor', classification: 'restored', current: 'ProgramDescriptor' },
    { name: 'ProgramEntryPoints', classification: 'restored', current: 'ProgramEntryPoints' },
    { name: 'QuerySetResourceDescriptor', classification: 'restored', current: 'QuerySetResourceDescriptor' },
    { name: 'QuerySetType', classification: 'restored', current: 'QuerySetType' },
    { name: 'ResourceOptions', classification: 'internal', current: null },
    { name: 'SamplerResourceDescriptor', classification: 'restored', current: 'SamplerResourceDescriptor' },
    { name: 'ScratchComputePipelineDescriptor', classification: 'restored', current: 'ScratchComputePipelineDescriptor' },
    { name: 'ScratchDiagnosticInput', classification: 'restored', current: 'ScratchDiagnosticInput' },
    { name: 'ScratchRenderPipelineDescriptor', classification: 'restored', current: 'ScratchRenderPipelineDescriptor' },
    { name: 'SurfaceFormat', classification: 'restored', current: 'SurfaceFormat' },
    { name: 'SurfaceOptions', classification: 'restored', current: 'SurfaceOptions' },
    { name: 'SurfaceSize', classification: 'restored', current: 'SurfaceSize' },
    { name: 'TextureUploadLayout', classification: 'restored', current: 'TextureUploadLayout' },
    { name: 'TextureUploadOrigin', classification: 'restored', current: 'TextureUploadOrigin' },
    { name: 'TextureUploadSize', classification: 'restored', current: 'TextureUploadSize' },
    { name: 'TypedArrayConstructor', classification: 'internal', current: null },
])

assertAncestor(goalBaseline)
assertCommit(historicalJavaScript)
const auditTarget = Object.freeze({
    commit: currentCommit(),
    workingTree: workingTreeEvidence(),
})
if (acceptanceMode) {
    assertParity(
        auditTarget.workingTree.clean,
        'acceptance requires a clean Git working tree so the reported commit identifies every audited byte'
    )
}
const productionBootstrap = await prepareProductionBootstrap()
assertParity(
    productionBootstrap.status === 'passed' || productionBootstrap.status === 'not-needed',
    `production bootstrap failed: ${JSON.stringify(productionBootstrap)}`
)

const baseline = loadSourcesAt(goalBaseline, baselinePaths)
const historical = loadSourcesAt(historicalJavaScript, historicalPaths)
const current = loadCurrentSources(currentPaths)
const currentScratchTree = loadCurrentScratchTree()
const baselineScratchTree = loadGitScratchTree(goalBaseline)
const historicalScratchTree = loadGitScratchTree(historicalJavaScript)
const currentScratchSource = Object.values(currentScratchTree).join('\n')
const baselineScratchSource = Object.values(baselineScratchTree).join('\n')
const historicalScratchSource = Object.values(historicalScratchTree).join('\n')
const scratchOwnedInstanceofAuthorities = Object.freeze([
    'BeginOcclusionQueryCommand',
    'BindLayout',
    'BindSet',
    'BufferRegion',
    'BufferResource',
    'ComputePassSpec',
    'ComputePipeline',
    'CopyCommand',
    'DispatchCommand',
    'DrawCommand',
    'EndOcclusionQueryCommand',
    'ExternalImageUploadCommand',
    'LayoutCodec',
    'Program',
    'QuerySetResource',
    'ReadbackCommand',
    'RenderPassSpec',
    'RenderPipeline',
    'ResolveQuerySetCommand',
    'SamplerResource',
    'ScratchDiagnosticError',
    'TextureUploadCommand',
    'TextureResource',
    'TextureViewSpec',
    'UploadCommand',
])
const openScratchOwnedInstanceofSites = Object.freeze(Object.entries(currentScratchTree)
    .flatMap(([ sourcePath, source ]) => [ ...source.matchAll(/\binstanceof\s+([A-Za-z_$][A-Za-z0-9_$]*)/g) ]
        .filter(match => scratchOwnedInstanceofAuthorities.includes(match[1]))
        .map(match => Object.freeze({
            path: sourcePath,
            line: source.slice(0, match.index).split('\n').length,
            authority: match[1],
        }))))
const openScratchOwnedDuckAuthoritySites = Object.freeze(Object.entries(currentScratchTree)
    .flatMap(([ sourcePath, source ]) => [
        ...source.matchAll(/typeof\s+[A-Za-z_$][A-Za-z0-9_$.]*\.assertRuntime\s*!==?\s*['"]function['"]/g),
    ].map(match => Object.freeze({
        path: sourcePath,
        line: source.slice(0, match.index).split('\n').length,
    }))))
const closedBrandGuards = Object.freeze({
    BeginOcclusionQueryCommand: current.command.includes("commandBrands.set(this, 'begin-occlusion-query')") &&
        current.submission.includes('isRenderCommand(command)'),
    BindLayout: current.binding.includes('if (!isBindLayout(layout))') &&
        current.pipeline.includes('if (!isBindLayout(layout))') &&
        current.shaderInspection.includes('if (!isBindLayout(layout))'),
    BindSet: current.command.includes('if (!isBindSet(bindSet))'),
    BufferRegion: current.buffer.includes('isBufferRegion('),
    BufferResource: current.buffer.includes('isBufferResource('),
    ComputePassSpec: current.pass.includes('isComputePassSpec(') &&
        current.submission.includes('!isRenderPassSpec(passSpec) && !isComputePassSpec(passSpec)'),
    ComputePipeline: current.pipeline.includes('isComputePipeline(') &&
        current.command.includes('if (!isComputePipeline(pipeline))'),
    CopyCommand: current.command.includes("commandBrands.set(this, 'copy')") &&
        current.submission.includes('if (!isCopyCommand(command))'),
    DispatchCommand: current.command.includes("commandBrands.set(this, 'dispatch')") &&
        current.submission.includes('if (!isDispatchCommand(command))'),
    DrawCommand: current.command.includes("commandBrands.set(this, 'draw')") &&
        current.submission.includes('isRenderCommand(command)'),
    EndOcclusionQueryCommand: current.command.includes("commandBrands.set(this, 'end-occlusion-query')") &&
        current.submission.includes('isRenderCommand(command)'),
    ExternalImageUploadCommand: current.command.includes("commandBrands.set(this, 'external-image-upload')") &&
        current.submission.includes('if (!isUploadCommand(command))'),
    LayoutCodec: current.layoutCodec.includes('isLayoutCodec('),
    Program: current.pipeline.split('if (!isProgram(program))').length === 3 &&
        current.shaderInspection.includes('if (!isProgram(program))'),
    QuerySetResource: current.querySet.includes('isQuerySetResource('),
    ReadbackCommand: current.command.includes("commandBrands.set(this, 'readback')") &&
        current.submission.includes('if (!isReadbackCommand(command))'),
    RenderPassSpec: current.pass.includes('isRenderPassSpec(') &&
        current.submission.includes('!isRenderPassSpec(passSpec) && !isComputePassSpec(passSpec)'),
    RenderPipeline: current.pipeline.includes('isRenderPipeline(') &&
        current.command.includes('if (!isRenderPipeline(pipeline))'),
    ResolveQuerySetCommand: current.command.includes("commandBrands.set(this, 'resolve-query-set')") &&
        current.submission.includes('if (!isResolveQuerySetCommand(command))'),
    SamplerResource: current.sampler.includes('isSamplerResource('),
    ScratchDiagnosticError: currentScratchSource.includes('isScratchDiagnosticError('),
    TextureUploadCommand: current.command.includes("commandBrands.set(this, 'texture-upload')") &&
        current.submission.includes('if (!isUploadCommand(command))'),
    TextureResource: current.texture.includes('isTextureResource('),
    TextureViewSpec: current.texture.includes('isTextureViewSpec('),
    UploadCommand: current.command.includes("commandBrands.set(this, 'buffer-upload')") &&
        current.submission.includes('if (!isUploadCommand(command))'),
})
const closedBrandAuthority = Object.freeze({
    authorities: scratchOwnedInstanceofAuthorities,
    openInstanceofSites: openScratchOwnedInstanceofSites,
    openDuckTypedAuthoritySites: openScratchOwnedDuckAuthoritySites,
    guards: closedBrandGuards,
    status: openScratchOwnedInstanceofSites.length === 0 &&
        openScratchOwnedDuckAuthoritySites.length === 0 &&
        Object.values(closedBrandGuards).every(Boolean)
        ? 'passed'
        : 'failed',
})
const goalStartProductionDeclarations = emitProductionDeclarationsAt(goalBaseline)
const emittedProductionOutputs = emitCurrentProductionOutputs()
const goalStartScratchDeclarations = scratchDeclarationTree(goalStartProductionDeclarations)
const finalScratchDeclarations = scratchDeclarationTree(emittedProductionOutputs)
const finalDocs = loadCurrentSources({
    runtimeSurface: 'docs/vision/scratch-api/01-runtime-surface/README.md',
    runtimeSurfaceZh: 'docs/vision/scratch-api/01-runtime-surface/README_zh.md',
    resources: 'docs/vision/scratch-api/02-resources/README.md',
    resourcesZh: 'docs/vision/scratch-api/02-resources/README_zh.md',
    bindings: 'docs/vision/scratch-api/03-bindings/README.md',
    bindingsZh: 'docs/vision/scratch-api/03-bindings/README_zh.md',
    commands: 'docs/vision/scratch-api/04-pipelines-commands/README.md',
    commandsZh: 'docs/vision/scratch-api/04-pipelines-commands/README_zh.md',
    passes: 'docs/vision/scratch-api/05-passes-submissions-scheduler/README.md',
    passesZh: 'docs/vision/scratch-api/05-passes-submissions-scheduler/README_zh.md',
    transfers: 'docs/vision/scratch-api/07-transfers-epochs/README.md',
    transfersZh: 'docs/vision/scratch-api/07-transfers-epochs/README_zh.md',
    programs: 'docs/vision/scratch-api/08-programs-codecs/README.md',
    programsZh: 'docs/vision/scratch-api/08-programs-codecs/README_zh.md',
    diagnostics: 'docs/vision/scratch-api/09-diagnostics-validation/README.md',
    diagnosticsZh: 'docs/vision/scratch-api/09-diagnostics-validation/README_zh.md',
    legacyResourceDecision: 'docs/decisions/ADR-008-scratch-buffer-layout-artifact-integration.md',
    legacyProgramDecision: 'docs/decisions/ADR-009-scratch-program-layout-requirements.md',
    legacyReadbackDecision: 'docs/decisions/ADR-010-scratch-layout-aware-readback.md',
    resourceDecision: 'docs/decisions/ADR-036-scratch-resource-views-and-layout-compatibility.md',
    bindingDecision: 'docs/decisions/ADR-037-scratch-supporting-object-acknowledgement-and-bind-set-preparation.md',
    diagnosticsDecision: 'docs/decisions/ADR-038-scratch-diagnostics-schema-v5.md',
    surfaceDecision: 'docs/decisions/ADR-039-scratch-exclusive-surface-context-ownership.md',
    finalAudit: 'docs/review/scratch-persistent-binding-views-final-audit.md',
})
const activeReviewSource = loadMarkdownDirectory('docs/review')
const externalImageUploadTestSource = fs.readFileSync(
    'tests/scratch-external-image-upload.test.js',
    'utf8'
)
const externalImageQueueOwnershipTest = testCaseSource(
    externalImageUploadTestSource,
    'tests/scratch-external-image-upload.test.js',
    'rejects direct execution on a queue that is not owned by the command runtime'
)

const capabilityRows = [
    capability({
        id: 'runtime-surface',
        goalStart: hasAll(baseline.runtime, [ 'static async create', 'createSurface(', 'createSubmission(' ]),
        historical: hasAll(historical.runtime, [ 'static async create', 'createSurface(', 'createSubmission(' ]),
        target: 'Explicit async runtime with independent synchronous Surface and SubmissionBuilder descriptions',
        final: hasAll(current.runtime, [ 'static async create', 'createSurface(', 'createSubmission(' ]) &&
            hasAll(current.surface, [
                'surfaceContextOwners',
                'surfaceStates',
                'claimSurfaceContext(',
                'SCRATCH_SURFACE_CONTEXT_IN_USE',
                'releaseSurfaceContext(',
                'assertSurfaceContextOwner(',
                'assertSurfaceConfigurationCurrent(',
                'captureCurrentSurfaceConfiguration(',
                'prepareSurfaceAttachment(',
                'SCRATCH_SURFACE_CONFIGURATION_FAILED',
                'SCRATCH_SURFACE_UNCONFIGURE_FAILED',
                'TEXTURE_USAGE_TRANSIENT_ATTACHMENT',
                '(usage & TEXTURE_USAGE_TRANSIENT_ATTACHMENT) === 0',
            ]),
        implementation: 'scratch/runtime.ts, scratch/surface.ts, scratch/submission.ts',
        tests: 'scratch-runtime.test.js, scratch-surface.test.js, scratch-submitted-work-epochs.test.js',
        docs: 'scratch-graphics-kernel.md and scratch-api/01-runtime-surfaces',
        replacement: 'preserved and strengthened',
    }),
    capability({
        id: 'resource-semantics',
        goalStart: hasAll(baseline.resource, [ 'allocationVersion', 'contentEpoch', 'isReady' ]),
        historical: hasAll(historical.resource, [ 'allocationVersion', 'contentEpoch', 'export class Resource' ]),
        historicalNote: 'The JavaScript source exposed allocation/content epochs before readiness moved onto content-bearing resources.',
        target: 'Allocation lifecycle on every resource; scalar content facts only on buffers/textures; indexed query facts',
        final: hasAll(current.resource, [ 'export interface ContentResource', 'contentFactsFor(', 'allocationVersion' ]) &&
            !current.sampler.includes('contentEpoch') &&
            hasAll(current.querySet, [ 'slot(index:', 'slots():', 'contentEpoch' ]) &&
            hasAll(current.buffer, [
                'Number.isSafeInteger(descriptor.size)',
                'descriptor.usage > GPU_FLAGS_MAX',
            ]) &&
            hasAll(current.texture, [
                'value > GPU_INTEGER_COORDINATE_MAX',
                'usage > GPU_FLAGS_MAX',
            ]),
        implementation: 'scratch/resource.ts, scratch/sampler.ts, scratch/query-set.ts',
        tests: 'scratch-resource.test.js, scratch-query-set.test.js, scratch-occlusion-query.test.js, scratch-supporting-object-acknowledgement.test.js',
        docs: 'scratch-api/02-resources and ADR-036',
        replacement: 'universal ResourceState narrowed to content-bearing resources',
    }),
    capability({
        id: 'layout-codec',
        goalStart: hasAll(baseline.layoutCodec, [ 'structuralHash', 'pack(', 'wgslAccessors(', 'createReadbackView(' ]),
        historical: 'not-applicable',
        historicalNote: 'The fixed pre-TypeScript JavaScript snapshot predates LayoutCodec.',
        target: 'Collision-safe physical ABI and semantic schema identities with CPU/WGSL/readback helpers preserved',
        final: hasAll(current.layoutCodec, [ 'abiHash', 'schemaHash', 'abiCanonical', 'schemaCanonical', 'layoutCanonicalSignatures', 'pack(', 'wgslAccessors(', 'createReadbackView(' ]) &&
            !current.layoutCodec.includes('structuralHash'),
        implementation: 'scratch/layout-codec.ts',
        tests: 'scratch-layout-codec.test.js and scratch-resource-views.test.js',
        docs: 'scratch-api/02-resources and ADR-036',
        replacement: 'structuralHash -> abiHash plus schemaHash; no alias',
    }),
    capability({
        id: 'buffer-ranges',
        goalStart: hasAll(baseline.buffer, [ 'layout?: LayoutArtifact', 'layoutByteLength', 'elementCount' ]),
        historical: historical.buffer.includes('export class BufferResource'),
        target: 'Raw BufferResource plus immutable normalized BufferRegion as the sole public byte-range unit',
        final: hasAll(current.buffer, [
            'export type BufferResourceDescriptor = GPUBufferDescriptor',
            'export class BufferRegion',
            'region(descriptor:',
            'subregion(',
            'interpretAs(',
        ]) && !/export type BufferResourceDescriptor\s*=\s*Readonly<\{/.test(current.buffer),
        implementation: 'scratch/buffer.ts and every range-consuming command descriptor',
        tests: 'scratch-resource-views.test.js, scratch-buffer-layout-artifact.test.js',
        docs: 'scratch-api/02-resources and ADR-036',
        replacement: 'resource-global layout and ad hoc range descriptors -> BufferRegion',
    }),
    capability({
        id: 'texture-views',
        goalStart: hasAll(baseline.texture, [ 'createView(', 'GPUTextureView', '#viewCache' ]),
        historical: historical.texture.includes('createView('),
        target: 'Frozen logical TextureViewSpec with private candidate-local native view preparation',
        final: hasAll(current.texture, [ 'export class TextureViewSpec', 'view(descriptor:', 'Object.preventExtensions(this)' ]) &&
            !current.texture.includes('#viewCache') &&
            hasAll(current.textureFormatCapabilities, [
                'textureFormatIsRenderable(',
                'textureFormatSupportsStorageBinding(',
                'storageTextureFormatCapabilities(',
            ]) &&
            hasAll(current.binding, [ 'textureViewPreparationCandidates(', 'gpuTexture.createView(descriptor)' ]),
        implementation: 'scratch/texture.ts, scratch/texture-format-capabilities.ts, and scratch/binding.ts',
        tests: 'scratch-resource-views.test.js and scratch-bind-set-preparation.test.js',
        docs: 'scratch-api/02-resources, scratch-api/03-bindings, ADR-036, ADR-037',
        replacement: 'public allocation-scoped GPUTextureView -> logical TextureViewSpec',
    }),
    capability({
        id: 'supporting-object-acknowledgement',
        goalStart: hasAll(baseline.runtime, [ 'createSampler(', 'createQuerySet(', 'createBindLayout(' ]) &&
            !/async createSampler/.test(baseline.runtime),
        historical: hasAll(historical.runtime, [ 'createSampler(', 'createQuerySet(', 'createBindLayout(' ]),
        target: 'Promise-only acknowledged SamplerResource, QuerySetResource, and BindLayout factories',
        final: hasAll(current.runtime, [ 'async createSampler(', 'async createQuerySet(', 'async createBindLayout(' ]) &&
            current.sampler.includes('issueSupportingObjectCreation(') &&
            current.querySet.includes('issueSupportingObjectCreation(') &&
            hasAll(current.binding, [ 'beginSupportingObjectCreation<', 'issueSupportingObjectCreation(' ]) &&
            hasAll(current.supportingObjectCreation, [
                'const scopes = Promise.all(pendingScopes)',
                'recheckSupportingObjectLifecycle',
                "observedFailure('native-exception'",
            ]) &&
            hasAll(current.supportingObjectFailure, [
                "'native-exception': 0",
                "'scope-failure': 1",
                "'runtime-disposed': 5",
                "'device-lost': 6",
            ]),
        implementation: 'scratch/sampler.ts, scratch/query-set.ts, scratch/binding.ts',
        tests: 'scratch-supporting-object-acknowledgement.test.js',
        docs: 'scratch-api/03-bindings and ADR-037',
        replacement: 'synchronous native constructor paths -> acknowledged runtime transactions',
    }),
    capability({
        id: 'persistent-bind-sets',
        goalStart: hasAll(baseline.binding, [ 'getBindGroup()', 'hasStaleAllocationVersions()', 'createBindGroup(' ]),
        historical: hasAll(historical.binding, [ 'getBindGroup()', 'hasStaleAllocationVersions()', 'createBindGroup(' ]),
        target: 'Initially prepared BindSet with explicit allocation-bound prepare and no submission repair',
        final: hasAll(current.binding, [ 'prepare(): Promise<void>', 'captureBindSetSnapshot(', 'preparedBindGroupFor(', 'await bindSet.prepare()' ]) &&
            hasAll(current.binding, [
                'failures.push(...bindSetLifecycleFailures(bindSet))',
                'function bindSetLifecycleFailures(',
                'seenResources',
            ]) &&
            !current.binding.includes('getBindGroup()') &&
            !current.submission.includes('.prepare()'),
        implementation: 'scratch/binding.ts and scratch/command.ts',
        tests: 'scratch-bind-set-preparation.test.js and scratch-persistent-binding-performance.test.js',
        docs: 'scratch-api/03-bindings and ADR-037',
        replacement: 'lazy getBindGroup rebuild -> explicit single-flight prepare transaction',
    }),
    capability({
        id: 'program-command-binding-contract',
        goalStart: hasAll(baseline.program, [ 'ProgramBufferLayoutRequirement', 'structuralHash' ]) &&
            baseline.command.includes('CommandDynamicOffsets'),
        historical: hasAll(historical.program, [ 'export class Program', 'this.modules', 'this.entryPoints', 'this.requiredFeatures' ]),
        historicalNote: 'Program ownership and entry-point behavior are preserved; layout requirements were added after the JavaScript snapshot.',
        target: 'Pipeline-snapshotted Program schema requirements plus immutable command-owned named dynamic offsets',
        final: hasAll(current.program, [ 'abiHash', 'schemaHash', 'ProgramBufferLayoutRequirement' ]) &&
            hasAll(current.pipeline, [
                'pipelineProgramLayoutRequirements',
                'layoutRequirements: readonly ProgramBufferLayoutRequirement[]',
                'programLayoutRequirementsForPipeline(',
            ]) &&
            hasAll(current.command, [
                'CommandBindSetInvocation',
                'dynamicOffsets',
                'commandDynamicOffsetContracts',
                'entries: offsets.entries',
                'nativeOffsets: offsets.native',
                'programLayoutRequirementsForPipeline(command.pipeline)',
            ]) &&
            !exportedTypeNames(current.scratchIndex).includes('CommandDynamicOffsets'),
        implementation: 'scratch/program.ts, scratch/command.ts, scratch/binding.ts',
        tests: 'scratch-bind-dynamic-offsets.test.js, scratch-command-binding-access.test.js, scratch-program-layout-requirements.test.js, and scratch-compute-pipeline-async.test.js',
        docs: 'scratch-api/03-bindings and ADR-036/ADR-037',
        replacement: 'structural hash and descriptor-level offsets -> schema-aware command invocation',
    }),
    capability({
        id: 'commands-passes-submission',
        goalStart: hasAll(baseline.command, [ 'DrawCommand', 'DispatchCommand', 'CopyCommand', 'ReadbackCommand' ]) &&
            hasAll(baseline.submission, [ 'submit() {', 'queueTimeline', 'contentEpoch' ]),
        historical: hasAll(historical.command, [ 'DrawCommand', 'DispatchCommand', 'CopyCommand' ]) &&
            historical.submission.includes('submit()'),
        target: 'Stable commands and pass specs retain explicit order, readiness, epoch, and native observation semantics',
        final: hasAll(current.command, [ 'DrawCommand', 'DispatchCommand', 'CopyCommand', 'ReadbackCommand' ]) &&
            hasAll(current.submission, [ 'submit() {', 'queueTimeline', 'contentEpoch', 'beginSubmissionNativeObservation(' ]) &&
            hasAll(current.pass, [
                'TextureViewSpec',
                'validateRenderAttachmentView(',
                'validateSurfaceAttachmentViewDescriptor(',
                'normalizeColorAttachmentOperations(',
                'normalizeColorClearValue(',
                'validateRenderPassHasAttachment(',
                'normalizeColorAttachmentDepthSlice(',
                'validateColorRenderableAttachmentFormat(',
                'validateDisjointColorAttachmentRegions(pass, regions)',
                'normalizeDepthClearValue(',
                "normalized.depthLoad === 'clear' ? 1 : undefined",
                'lockRenderPassSpecContract(',
                'lockComputePassSpecContract(',
                'Object.preventExtensions(pass)',
            ]) &&
            hasAll(current.pipeline, [
                'validateRenderPipelineHasAttachment(',
                'targets.length > 0 || depthStencil !== undefined',
            ]) &&
            hasAll(current.command, [ 'region.offset % 4 !== 0', "reason: 'writeBufferAlignment'" ]),
        implementation: 'scratch/command.ts, scratch/pass.ts, scratch/submission.ts',
        tests: 'scratch-command-lifecycle.test.js, scratch-submission-queue-order.test.js, scratch-submitted-work-epochs.test.js, scratch-pass-submission.test.js, scratch-depth-stencil-attachments.test.js, scratch-pipeline-command.test.js, scratch-native-indirect-execution.test.js',
        docs: 'scratch-api/05-passes-submissions-scheduler',
        replacement: 'buffer ranges and pass targets migrated to BufferRegion/TextureViewSpec',
    }),
    capability({
        id: 'readback-query-transfer',
        goalStart: hasAll(baseline.readback, [ 'toBytes()', 'toArray<', 'toLayoutView()' ]) &&
            hasAll(baseline.command, [ 'copyBufferToBuffer(', 'copyTextureToTexture(', 'copyBufferToTexture(', 'copyTextureToBuffer(' ]),
        historical: hasAll(historical.readback, [ 'toBytes()', 'toArray(' ]) &&
            historical.command.includes('copyBufferToBuffer('),
        historicalNote: 'Raw/typed readback and buffer copies are preserved; layout views and the other native copy quadrants were added later.',
        target: 'BufferRegion-based upload/readback/query resolve with all native GPU copy quadrants preserved',
        final: hasAll(current.readback, [ 'source: BufferRegion', 'toBytes()', 'toArray<', 'toLayoutView()' ]) &&
            hasAll(current.command, [
                'copyBufferToBuffer(',
                'copyTextureToTexture(',
                'copyBufferToTexture(',
                'copyTextureToBuffer(',
                "throwReadbackCommandSourceDiagnostic(runtime, subject, source, 'copyAlignment')",
                "reason: 'writeBufferAlignment'",
            ]) &&
            current.readback.includes('source.offset % 4 !== 0 || source.size % 4 !== 0'),
        implementation: 'scratch/command.ts, scratch/readback.ts, scratch/submission.ts',
        tests: 'scratch-copy-command.test.js, scratch-texture-sampler.test.js, scratch-readback-epochs.test.js, scratch-binding-upload.test.js, scratch-readback-command.test.js, scratch-layout-readback-operation.test.js, browser binding proof',
        docs: 'scratch-api/04-transfers-readback-queries',
        replacement: 'ReadbackRange and whole-buffer overloads -> BufferRegion',
    }),
    capability({
        id: 'diagnostics-v5',
        goalStart: /version: 4/.test(baseline.gpuOperation) && /version: 4/.test(baseline.runtimeDiagnostics),
        historical: /SCRATCH_/.test(historicalScratchSource),
        target: 'Bounded schema v5 with discriminated resource/supporting-object targets and no v4 writer',
        final: /version: 5/.test(current.gpuOperation) && /version: 5/.test(current.runtimeDiagnostics) &&
            !/version:\s*4/.test(currentScratchSource) &&
            hasAll(current.gpuOperation, [ "kind: 'bind-layout'", "kind: 'bind-set'", 'ScratchGpuQuerySetSlotFact' ]),
        implementation: 'scratch/gpu-operation.ts and scratch/runtime-diagnostics.ts',
        tests: 'scratch-gpu-operation-provenance.test.js and scratch-supporting-object-acknowledgement.test.js',
        docs: 'scratch-api/09-diagnostics-validation and ADR-038',
        replacement: 'schema v4 -> schema v5 without adapter or dual output',
    }),
]

const baselineValueExports = exportNames(baseline.scratchIndex, 'value')
const currentValueExports = exportNames(current.scratchIndex, 'value')
const historicalValueExports = exportNames(historical.scratchIndex, 'value')
const baselineMissingValues = difference(baselineValueExports, currentValueExports)
const historicalMissingValues = difference(historicalValueExports, currentValueExports)

const baselineTypeReplacements = Object.freeze({
    CommandDynamicOffsets: 'CommandBindSetInvocation',
    ReadbackRange: 'BufferRegion',
})
const baselineMissingTypes = difference(
    exportedTypeNames(baseline.scratchIndex),
    exportedTypeNames(current.scratchIndex)
)
const expectedBaselineMissingTypes = Object.keys(baselineTypeReplacements).sort()

const currentPackageTypes = exportedTypeNames(current.packageIndex)
const historicalPackageTypes = publicExportNames(historical.packageTypes)
const classifiedHistoricalTypes = historicalTypeInventory.map(entry => Object.freeze({
    ...entry,
    historicalPresent: historicalPackageTypes.includes(entry.name),
    finalPresent: entry.current === null
        ? !currentPackageTypes.includes(entry.name)
        : currentPackageTypes.includes(entry.current),
    status: historicalPackageTypes.includes(entry.name) && (entry.current === null
        ? !currentPackageTypes.includes(entry.name)
        : currentPackageTypes.includes(entry.current))
        ? 'passed'
        : 'failed',
}))

const goalStartPublicMembers = publicClassMemberInventory(goalStartScratchDeclarations)
const historicalPublicMethods = publicClassMemberInventory(historicalScratchTree)
    .filter(entry => [ 'method', 'get', 'set' ].includes(entry.kind))
const finalPublicMembers = publicClassMemberInventory(finalScratchDeclarations)
const finalPublicMemberById = new Map(finalPublicMembers.map(entry => [ entry.id, entry ]))
const finalPublicMethodIds = finalPublicMembers
    .filter(entry => [ 'method', 'get', 'set' ].includes(entry.kind))
    .map(entry => entry.id)
const missingGoalStartPublicMembers = goalStartPublicMembers
    .filter(entry => !finalPublicMemberById.has(entry.id))
const changedGoalStartPublicMembers = goalStartPublicMembers
    .filter(entry => finalPublicMemberById.has(entry.id))
    .filter(entry => entry.signature !== finalPublicMemberById.get(entry.id).signature)
    .map(entry => Object.freeze({
        id: entry.id,
        before: entry.signature,
        after: finalPublicMemberById.get(entry.id).signature,
        file: entry.file,
    }))
const missingHistoricalPublicMethods = historicalPublicMethods
    .filter(entry => !finalPublicMethodIds.includes(entry.id))
const goalStartPublicMemberReplacements = Object.freeze({
    'BindLayout.constructor:constructor': 'Promise-only ScratchRuntime.createBindLayout()',
    'BindSet.constructor:constructor': 'Promise-only ScratchRuntime.createBindSet() with initial preparation',
    'BindSet.getBindGroup:method': 'explicit prepare() plus private preparedBindGroupFor()',
    'BindSet.hasStaleAllocationVersions:method': 'preparationState allocation-snapshot comparison',
    'BufferResource.elementCount:property': 'BufferRegion interpretation owns elementCount',
    'BufferResource.layout:property': 'BufferRegion interpretation owns LayoutCodec',
    'BufferResource.layoutByteLength:property': 'BufferRegion interpretation owns layout byte length',
    'BufferResource.layoutSubject:get': 'BufferRegion.subject and region-owned layout witness',
    'QuerySetResource._advanceSlotContentEpoch:method': 'module-private advanceQuerySetSlotEpoch()',
    'QuerySetResource.constructor:constructor': 'Promise-only ScratchRuntime.createQuerySet()',
    'QuerySetResource.static.create:method': 'Promise-only ScratchRuntime.createQuerySet()',
    'ReadbackCommand.range:get': 'ReadbackCommand.source.region BufferRegion',
    'ReadbackOperation.range:get': 'ReadbackOperation.source BufferRegion',
    'RenderPassSpec.createRenderPassDescriptor:method': 'submission-scoped lowerRenderPassDescriptor()',
    'Resource.constructor:constructor': 'protected subclass allocation lifecycle',
    'Resource.contentEpoch:get': 'content-bearing BufferResource/TextureResource and indexed query slots',
    'Resource.isReady:get': 'content-bearing BufferResource/TextureResource only',
    'Resource.state:get': 'content-bearing BufferResource/TextureResource only',
    'SamplerResource.constructor:constructor': 'Promise-only ScratchRuntime.createSampler()',
    'SamplerResource.static.create:method': 'Promise-only ScratchRuntime.createSampler()',
    'TextureResource.createView:method': 'logical TextureResource.view() returning TextureViewSpec',
})
const goalStartChangedPublicMemberReplacements = Object.freeze({
    'BindLayout.entrySubject:method': 'accept unknown input so invalid descriptors still receive structured diagnostics',
    'ReadbackOperation.source:get': 'whole BufferResource source -> explicit BufferRegion source',
    'ScratchRuntime.bindLayout:method': 'Promise-only acknowledged BindLayout factory',
    'ScratchRuntime.bindSet:method': 'Promise-only initially prepared BindSet factory',
    'ScratchRuntime.createBindLayout:method': 'Promise-only acknowledged BindLayout factory',
    'ScratchRuntime.createBindSet:method': 'Promise-only initially prepared BindSet factory',
    'ScratchRuntime.createQuerySet:method': 'Promise-only acknowledged QuerySetResource factory',
    'ScratchRuntime.createSampler:method': 'Promise-only acknowledged SamplerResource factory',
    'ScratchRuntime.querySet:method': 'Promise-only acknowledged QuerySetResource factory',
    'ScratchRuntime.sampler:method': 'Promise-only acknowledged SamplerResource factory',
})
const historicalPublicMethodReplacements = Object.freeze({
    'BindSet.getBindGroup:method': 'explicit prepare() plus private preparedBindGroupFor()',
    'BindSet.hasStaleAllocationVersions:method': 'preparationState allocation-snapshot comparison',
    'BufferResource.static.create:method': 'Promise-only ScratchRuntime.createBuffer()',
    'QuerySetResource._advanceSlotContentEpoch:method': 'module-private advanceQuerySetSlotEpoch()',
    'QuerySetResource.assertRuntime:method': 'inherited Resource.assertRuntime()',
    'QuerySetResource.assertUsable:method': 'inherited Resource.assertUsable()',
    'QuerySetResource.static.create:method': 'Promise-only ScratchRuntime.createQuerySet()',
    'ReadbackOperation._assertConsumable:method': 'module-private readback operation state validation',
    'ReadbackOperation._consumeBytes:method': 'module-private readback materialization transaction',
    'RenderPassSpec.createRenderPassDescriptor:method': 'submission-scoped lowerRenderPassDescriptor()',
    'Resource._advanceContentEpoch:method': 'module-private advanceResourceContentEpoch()',
    'Resource._replaceAllocation:method': 'module-private replaceResourceAllocation()',
    'SamplerResource.static.create:method': 'Promise-only ScratchRuntime.createSampler()',
    'TextureResource._replaceAllocation:method': 'module-private transactional replacement helper',
    'TextureResource.createView:method': 'logical TextureResource.view() returning TextureViewSpec',
    'TextureResource.static.create:method': 'Promise-only ScratchRuntime.createTexture()',
})
const publicMemberParity = Object.freeze({
    compilerVersion: ts.version,
    goalStartCount: goalStartPublicMembers.length,
    historicalMethodCount: historicalPublicMethods.length,
    finalCount: finalPublicMembers.length,
    missingGoalStart: missingGoalStartPublicMembers,
    changedGoalStart: changedGoalStartPublicMembers,
    missingHistorical: missingHistoricalPublicMethods,
    goalStartReplacements: goalStartPublicMemberReplacements,
    goalStartChangedReplacements: goalStartChangedPublicMemberReplacements,
    historicalReplacements: historicalPublicMethodReplacements,
    goalStartSignatureManifestHash: sha256(JSON.stringify(goalStartPublicMembers)),
    finalSignatureManifestHash: sha256(JSON.stringify(finalPublicMembers)),
    status: equalSets(
        missingGoalStartPublicMembers.map(entry => entry.id),
        Object.keys(goalStartPublicMemberReplacements)
    ) && equalSets(
        changedGoalStartPublicMembers.map(entry => entry.id),
        Object.keys(goalStartChangedPublicMemberReplacements)
    ) && equalSets(
        missingHistoricalPublicMethods.map(entry => entry.id),
        Object.keys(historicalPublicMethodReplacements)
    ) ? 'passed' : 'failed',
})

const baselineDiagnosticCodes = diagnosticCodes(baselineScratchSource)
const currentDiagnosticCodes = diagnosticCodes(currentScratchSource)
const missingBaselineDiagnostics = difference(baselineDiagnosticCodes, currentDiagnosticCodes)
const diagnosticReplacements = Object.freeze({
    SCRATCH_CODEC_STRUCTURAL_HASH_MISMATCH: [
        'SCRATCH_LAYOUT_ABI_MISMATCH',
        'SCRATCH_CODEC_SCHEMA_MISMATCH',
    ],
    SCRATCH_READBACK_RANGE_INVALID: [
        'SCRATCH_BUFFER_REGION_RANGE_INVALID',
        'SCRATCH_BUFFER_REGION_LAYOUT_INVALID',
    ],
})

const referencedTestFiles = [ ...new Set(capabilityRows.flatMap(row =>
    row.tests.match(/scratch-[a-z0-9-]+\.test\.js/g) ?? []
)) ].sort()
const referencedTestEvidence = referencedTestFiles.map(file => Object.freeze({
    file: `tests/${file}`,
    exists: fs.existsSync(`tests/${file}`),
    includedByDefaultMochaPattern: true,
    status: fs.existsSync(`tests/${file}`) ? 'passed' : 'failed',
}))
const behaviorTestContracts = [
    behaviorTestContract('tests/scratch-closed-brand-authority.test.js', [
        'rejects a forged sampler after constructor Symbol.hasInstance replacement',
        'rejects a forged texture before native copy encoding after constructor replacement',
        'rejects prototype-derived BindLayout identities before native binding creation',
        'rejects prototype-derived Program identities before native pipeline creation',
        'rejects prototype-derived Pipeline and BindSet identities before command creation',
        'rejects prototype-derived pass and command identities before native submission effects',
        'does not use open instanceof checks as Scratch-owned internal brands',
    ]),
    behaviorTestContract('tests/scratch-surface.test.js', [
        'rejects transient Surface usage before native canvas configuration',
        'claims each canvas context exclusively until the owning Surface is disposed',
        'releases an uncommitted canvas-context claim after configure fails',
        'rolls back logical and canvas facts after synchronous reconfigure failure',
        'verifies and rolls back native state when post-configure observation fails',
        'revalidates exact ownership after materializing Surface configuration inputs',
        'rejects a configuration candidate invalidated by reentrant reconfiguration',
        'rejects a silently coerced canvas size without publishing candidate facts',
        'reports a silently rejected canvas rollback as incomplete',
        'commits reconfiguration through private state when public observations are frozen',
        'rejects forged Surface aliases before lifecycle or presentation effects',
        'keeps private ownership authoritative when public identity and lifecycle writes are attempted',
        'rejects external canvas-context drift before borrowing a current texture',
        'rejects every external native configuration field drift against the committed snapshot',
        'releases ownership when public Surface observations are frozen during disposal',
        'releases Surface ownership even when native unconfigure fails',
        'continues runtime cleanup after Surface unconfigure fails',
    ]),
    behaviorTestContract('tests/scratch-bind-dynamic-offsets.test.js', [
        'revalidates frozen dynamic offsets against the current replacement allocation',
    ]),
    behaviorTestContract('tests/scratch-bind-set-preparation.test.js', [
        'keeps the binding snapshot implementation immutable through its prototype',
        'keeps BindSet preparation state authoritative through its prototype',
        'keeps BindLayout lifecycle authority immutable through its prototype',
        'prepares the complete core buffer, sampler, sampled-texture, and storage-texture families',
        'supports storage textures across every native-valid view dimension',
        'supports every sampled view dimension and the native multisample contract',
        'rejects incompatible sampler, sampled texture, and storage texture shapes before native issue',
        'keeps unchanged preparation checks free of snapshot reconstruction',
        'retains lifecycle recheck as secondary evidence beside a native preparation failure',
        'retains simultaneous lifecycle failures and links device-loss incidents',
        'revalidates buffer bounds, usage, and alignment before binding a replacement allocation',
    ]),
    behaviorTestContract('tests/scratch-supporting-object-acknowledgement.test.js', [
        'normalizes every native field and rejects deterministic sampler violations before native issue',
        'keeps the acknowledged native sampler identity immutable',
        'rejects prototype replacement of the acknowledged native sampler identity',
        'keeps acknowledged query facts and native allocation identity immutable',
        'rejects prototype replacement of acknowledged query facts and native identity',
        'preflights group, binding, stage, feature, and slot limits without a native call',
        'settles scopes and preserves all causal failures across simultaneous lifecycle changes',
    ]),
    behaviorTestContract('tests/scratch-compute-pipeline-async.test.js', [
        'rejects local validation through a Promise without native or operation effects',
        'creates one ready immutable wrapper through the native async compute path',
    ]),
    behaviorTestContract('tests/scratch-resource-views.test.js', [
        'keeps BufferResource native allocation identity authoritative through its prototype',
        'creates complete immutable TextureViewSpecs and preflights usage capabilities without native views',
        'rejects mipmapped one-dimensional textures before native issue',
        'rejects render-attachment one-dimensional textures',
    ]),
    behaviorTestContract('tests/scratch-resource.test.js', [
        'rejects noncanonical raw resource descriptor integers before native issue',
    ]),
    behaviorTestContract('tests/scratch-pass-submission.test.js', [
        'rejects color attachment metadata and surface view descriptor divergence',
        'rejects invalid TextureResource attachment views and transient operations',
        'revalidates a persistent 3d attachment depthSlice after allocation replacement',
        'rejects overlapping color attachment regions while permitting disjoint 3d slices',
        'rejects a non-owner Surface alias before presentation effects',
        'rejects a forged Surface alias with shadowed public methods before pass effects',
        'performs the final Surface configuration read before encoder creation',
        'preserves native Surface usage, view format, color, and tone-mapping capabilities',
        'deep-locks normalized PassSpec attachments before reusable submission',
        'snapshots Surface attachment view descriptors when the PassSpec is created',
        'rejects depth-stencil formats in color attachment slots before encoder creation',
    ]),
    behaviorTestContract('tests/scratch-depth-stencil-attachments.test.js', [
        'defaults depth clear to one and accepts inclusive unit-range boundaries',
        'accepts native-valid depth-only pipelines and render passes',
        'normalizes only complete finite GPUColor values before encoder creation',
        'accepts the GPUStencilValue maximum and rejects larger values before encoding',
        'rejects invalid depth attachment views, clear values, and transient operations',
    ]),
    behaviorTestContract('tests/scratch-binding-upload.test.js', [
        'rejects invalid, unaligned, and disposed uploads with structured diagnostics',
        'rejects direct buffer uploads on a queue not owned by the command runtime',
        'requires COPY_DST and revalidates replacement usage before upload queue effects',
    ]),
    behaviorTestContract('tests/scratch-readback-command.test.js', [
        'rejects invalid descriptors and unaligned regions with structured diagnostics',
        'revalidates readback source usage against replacement allocations before staging copy effects',
    ]),
    behaviorTestContract('tests/scratch-query-set.test.js', [
        'freezes one resolve slot snapshot for readiness and native encoding',
        'rejects a disposed compute timestamp query set before encoder creation',
        'rejects a disposed render timestamp query set before attachment or encoder creation',
        'rejects identical compute timestamp write indices before encoder creation',
        'rejects identical render timestamp write indices before encoder creation',
        'revalidates query resolve usage against replacement allocations before encoder effects',
    ]),
    behaviorTestContract('tests/scratch-occlusion-query.test.js', [
        'executes the documented all-aspect occlusion pass contract',
        'rejects a disposed render occlusion query set before attachment or encoder creation',
    ]),
    behaviorTestContract('tests/scratch-native-indirect-execution.test.js', [
        'revalidates every fixed-function buffer usage against replacement allocations before encoder effects',
    ]),
    behaviorTestContract('tests/scratch-layout-readback-operation.test.js', [
        'rejects unaligned direct readback regions before staging allocation',
    ]),
    behaviorTestContract('tests/scratch-pipeline-command.test.js', [
        'rejects invalid and unaligned vertex buffer bindings with structured diagnostics',
    ]),
    behaviorTestContract('tests/scratch-copy-command.test.js', [
        'copies buffer ranges through an explicit submission copy step',
        'copies texture regions through an explicit submission copy step',
        'copies buffer texel layouts into texture regions through an explicit submission copy step',
        'copies texture regions into buffer texel layouts through an explicit submission copy step',
        'validates 3d copy depth against each physical mip extent',
        'allows same-texture copies only across disjoint native subresources',
        'accepts native copy-compatible linear and srgb texture formats',
        'allows equal multisample texture copies only on core devices',
        'requires full physical subresources for depth-stencil texture copies',
        'allows compressed texture copies only on core devices',
        'uses physical block-aligned mip extents for compressed texture copies',
        'copies every native color texel-block footprint between buffers and textures',
        'applies native depth-stencil aspect footprints and direction limits',
        'enforces GPUSize32 bounds for both native buffer-texture copy layouts',
        'describes only BufferRegion-based copy shapes in structured diagnostics',
        'revalidates every buffer copy usage against replacement allocations before encoder effects',
        'revalidates every buffer copy source region against replacement bounds before encoder effects',
        'rejects invalid copy ranges and every same-buffer copy',
    ]),
    behaviorTestContract('tests/scratch-texture-sampler.test.js', [
        'preserves full 2d-array bindings and rejects layer subsets on compatibility devices',
        'enforces GPUSize32 bounds for texture upload row layouts',
        'rejects direct texture uploads on a queue not owned by the command runtime',
    ]),
    behaviorTestContract('tests/scratch-layout-codec.test.js', [
        'reports portable uniform compatibility from WGSL address-space constraints',
        'accepts the WGSL u32 boundary and rejects unsafe layout-size arithmetic',
    ]),
    behaviorTestContract('tests/scratch-command-lifecycle.test.js', [
        'keeps construction facts and disposal immutable for every legacy command family',
        'shadows absent normalized facts against inherited command mutation',
        'locks Draw and Dispatch label facts as immutable own properties',
        'freezes every executable command prototype authority',
    ]),
    behaviorTestContract('tests/scratch-command-binding-access.test.js', [
        'requires read-write storage buffers in both read and write declarations',
        'rejects empty read-write storage buffers during submission readiness validation',
    ]),
    behaviorTestContract('tests/scratch-program-layout-requirements.test.js', [
        'snapshots Program layout requirements into immutable pipeline command contracts',
    ]),
]
const focusedAcceptanceTestFiles = [ ...new Set([
    ...referencedTestFiles,
    ...behaviorTestContracts.map(contract => contract.file.replace(/^tests\//, '')),
]) ].sort()
const packageTestScript = JSON.parse(fs.readFileSync('package.json', 'utf8')).scripts?.test
const testEvidence = Object.freeze({
    referencedFiles: referencedTestEvidence,
    focusedAcceptanceFiles: focusedAcceptanceTestFiles,
    behaviorContracts: behaviorTestContracts,
    defaultMochaPattern: packageTestScript,
    status: referencedTestEvidence.every(entry => entry.status === 'passed') &&
        behaviorTestContracts.every(entry => entry.status === 'passed') &&
        typeof packageTestScript === 'string' &&
        packageTestScript.includes('mocha "tests/**/*.test.js"')
        ? 'passed'
        : 'failed',
})

const canonicalWebGpuTypes = Object.freeze({
    bufferBindingTypes: typeAliasStringUnion(webGpuTypesSource, 'GPUBufferBindingType'),
    samplerBindingTypes: typeAliasStringUnion(webGpuTypesSource, 'GPUSamplerBindingType'),
    textureSampleTypes: typeAliasStringUnion(webGpuTypesSource, 'GPUTextureSampleType'),
    textureViewDimensions: typeAliasStringUnion(webGpuTypesSource, 'GPUTextureViewDimension'),
    storageTextureAccess: typeAliasStringUnion(webGpuTypesSource, 'GPUStorageTextureAccess'),
    queryTypes: typeAliasStringUnion(webGpuTypesSource, 'GPUQueryType'),
    textureFormats: typeAliasStringUnion(webGpuTypesSource, 'GPUTextureFormat'),
})
const localWebGpuTypesEvidence = Object.freeze({
    package: webGpuTypesPackage.name,
    version: webGpuTypesPackage.version,
    repository: webGpuTypesPackage.repository,
    declarationPath: webGpuTypesPath,
    declarationHash: sha256(webGpuTypesSource),
    generatedFrom: 'GPUWeb Bikeshed specification via gpuweb/types',
})
const officialBindingMatrix = [
    matrixRow(
        'buffer types',
        canonicalWebGpuTypes.bufferBindingTypes,
        extractStringSet(current.binding, 'BUFFER_BINDING_TYPES')
            .map(value => value === 'read-storage' ? 'read-only-storage' : value)
    ),
    matrixRow(
        'sampler types',
        canonicalWebGpuTypes.samplerBindingTypes,
        extractStringSet(current.binding, 'SAMPLER_BINDING_TYPES')
    ),
    matrixRow(
        'sampled texture sample types',
        canonicalWebGpuTypes.textureSampleTypes,
        extractStringSet(current.binding, 'TEXTURE_SAMPLE_TYPES')
    ),
    matrixRow(
        'sampled texture view dimensions',
        canonicalWebGpuTypes.textureViewDimensions,
        extractStringSet(current.binding, 'TEXTURE_VIEW_DIMENSIONS')
    ),
    matrixRow(
        'storage texture access',
        canonicalWebGpuTypes.storageTextureAccess,
        extractStringSet(current.binding, 'STORAGE_TEXTURE_ACCESS')
    ),
    matrixRow(
        'storage texture view dimensions',
        canonicalWebGpuTypes.textureViewDimensions.filter(
            dimension => dimension !== 'cube' && dimension !== 'cube-array'
        ),
        extractStringSet(current.binding, 'STORAGE_TEXTURE_VIEW_DIMENSIONS')
    ),
]
const bindingLoweringProperties = assignedPropertiesInFunction(
    current.binding,
    'lowerBindLayoutEntry',
    'lowered'
)
const bindingLowering = Object.freeze({
    expected: [ 'buffer', 'sampler', 'storageTexture', 'texture' ],
    actual: bindingLoweringProperties,
    status: equalSets(
        bindingLoweringProperties,
        [ 'buffer', 'sampler', 'storageTexture', 'texture' ]
    ) ? 'passed' : 'failed',
})
const externalTextureBoundary = Object.freeze({
    officialMember: 'externalTexture',
    intentionallyExcluded: !current.binding.includes("type: 'external-texture'") &&
        finalDocs.bindings.includes('`externalTexture` is deliberately excluded'),
    reason: 'separate frame/task lifetime contract required',
    status: !current.binding.includes("type: 'external-texture'") &&
        finalDocs.bindings.includes('`externalTexture` is deliberately excluded')
        ? 'passed'
        : 'failed',
})

const goalStartCopyCalls = propertyCallsInClass(baseline.command, 'CopyCommand', 'commandEncoder')
const historicalCopyCalls = propertyCallsInClass(historical.command, 'CopyCommand', 'commandEncoder')
const finalCopyCalls = propertyCallsInClass(current.command, 'CopyCommand', 'commandEncoder')
const finalCopyCpuCalls = propertyCallsInClass(current.command, 'CopyCommand')
    .filter(method => [ 'mapAsync', 'getMappedRange', 'readBuffer' ].includes(method))
const nativeCopyQuadrants = [
    'copyBufferToBuffer',
    'copyTextureToTexture',
    'copyBufferToTexture',
    'copyTextureToBuffer',
].map(method => Object.freeze({
    method,
    goalStart: goalStartCopyCalls.includes(method),
    historical: historicalCopyCalls.includes(method),
    historicalExpected: method === 'copyBufferToBuffer',
    historicalDisposition: method === 'copyBufferToBuffer'
        ? 'preserved'
        : 'added-after-historical-snapshot',
    final: finalCopyCalls.includes(method),
    gpuSide: finalCopyCpuCalls.length === 0,
    astResolvedCallCount: finalCopyCalls.filter(call => call === method).length,
    status: goalStartCopyCalls.includes(method) &&
        historicalCopyCalls.includes(method) === (method === 'copyBufferToBuffer') &&
        finalCopyCalls.filter(call => call === method).length === 1 &&
        finalCopyCpuCalls.length === 0
        ? 'passed'
        : 'failed',
}))

const productionEmitParity = auditProductionEmit(emittedProductionOutputs)

const sourceFirst = Object.freeze({
    scratchFiles: Object.keys(currentScratchTree).sort(),
    sameSourceJavaScript: Object.keys(currentScratchTree).filter(path => path.endsWith('.js')),
    handwrittenDeclarations: Object.keys(currentScratchTree).filter(path => path.endsWith('.d.ts')),
    status: Object.keys(currentScratchTree).every(path => path.endsWith('.ts')) ? 'passed' : 'failed',
})

const exampleAudit = auditExamples()
const resourceStateParity = auditResourceStateDocumentation()
const currentLayoutDiagnosticCodes = scratchLayoutDiagnosticCodes(currentScratchSource)
const visionDiagnosticParity = auditVisionDiagnosticDocumentation()
const documentationAudit = Object.freeze({
    exclusiveSurfaceOwnership: [ finalDocs.runtimeSurface, finalDocs.runtimeSurfaceZh ].every(source =>
        hasAll(source, [
            'GPUCanvasContext',
            'getConfiguration()',
            'SCRATCH_SURFACE_CONTEXT_IN_USE',
            'SCRATCH_SURFACE_CONTEXT_NOT_OWNED',
            'SCRATCH_SURFACE_CONFIGURATION_FAILED',
            'SCRATCH_SURFACE_CONFIGURATION_STALE',
            'SCRATCH_SURFACE_UNCONFIGURE_FAILED',
            'TRANSIENT_ATTACHMENT',
            'candidate transaction',
            'dispose',
        ])
    ) && finalDocs.runtimeSurface.includes('exactly one live `Surface`') &&
    finalDocs.runtimeSurface.includes('before') &&
    finalDocs.runtimeSurfaceZh.includes('一个 live `Surface`') &&
    finalDocs.runtimeSurfaceZh.includes('之后才') &&
    hasAll(finalDocs.surfaceDecision, [
        '## Status',
        'Accepted',
        'WeakMap<GPUCanvasContext, Surface>',
        'exactly one live Scratch `Surface` owner',
        'getConfiguration()',
        'synchronously forbids usage containing',
        'finally',
    ]),
    resourceViews: hasAll(finalDocs.resources, [ 'BufferRegion', 'TextureViewSpec', 'abiHash', 'schemaHash' ]),
    bufferResourcePrototypeAuthority:
        hasAll(finalDocs.resources, [ '`gpuBuffer`', 'private-backed', 'prototype is frozen' ]) &&
        hasAll(finalDocs.resourcesZh, [ '`gpuBuffer`', 'private state', 'prototype', '被冻结' ]),
    oneDimensionalSingleMip:
        hasAll(finalDocs.resources, [ '`1d`', 'cannot have mipmaps', '`mipLevelCount` must be `1`' ]) &&
        hasAll(finalDocs.resourcesZh, [ '`1d`', '不能拥有 mipmap', '`mipLevelCount` 必须为 `1`' ]),
    canonicalResourceDescriptors: [ finalDocs.resources, finalDocs.resourcesZh ].every(source =>
        hasAll(source, [ 'GPUSize64', 'GPUIntegerCoordinate', 'GPUFlagsConstant', 'canonical' ])
    ),
    explicitPreparation: hasAll(finalDocs.bindings, [ 'prepare()', 'stale', 'Submission never prepares' ]),
    supportingObjectCausality: [ finalDocs.bindings, finalDocs.bindingsZh ].every(source =>
        hasAll(source, [ 'native issue', 'scope', 'lifecycle', 'secondary' ])
    ) && finalDocs.bindings.includes('not mutually exclusive') &&
        finalDocs.bindingsZh.includes('不是互斥') &&
        [ finalDocs.bindings, finalDocs.bindingsZh, finalDocs.diagnostics, finalDocs.diagnosticsZh ]
            .every(source => hasAll(source, [
                'device-loss',
                'exact-operation',
                'supporting-object-failure',
                'cancelled',
            ])) &&
        hasAll(finalDocs.bindingDecision, [
            'cannot short-circuit',
            'secondary evidence',
            'runtime-wide `device-loss` incident',
            '`exact-operation` `supporting-object-failure` incident',
        ]),
    compatibilityTextureLayerBindings: [ finalDocs.bindings, finalDocs.bindingsZh ].every(source =>
        hasAll(source, [
            'core-features-and-limits',
            'sampled',
            'storage',
            'baseArrayLayer: 0',
            'arrayLayerCount',
            'layer-subset',
        ])
    ) && hasAll(finalDocs.bindingDecision, [
        'core-features-and-limits',
        'baseArrayLayer',
        'arrayLayerCount',
        'depthOrArrayLayers',
        'layer-subset views',
    ]),
    nativeRegionAlignment: [
        finalDocs.commands,
        finalDocs.commandsZh,
        finalDocs.transfers,
        finalDocs.transfersZh,
    ].every(source => hasAll(source, [ 'BufferRegion', '4-byte' ])),
    immutableCommandLifecycle: [ finalDocs.commands, finalDocs.commandsZh ].every(source =>
        hasAll(source, [
            'command construction facts',
            'public property',
            'payload',
            '`isDisposed`',
            '`dispose()`',
            'property shadowing',
            '`ResolveQuerySetCommand`',
            'source snapshot',
            '`firstQuery`',
            '`queryCount`',
            'prototype',
            'own',
            '`undefined`',
        ])
    ),
    immutableBindingSnapshot: [ finalDocs.bindings, finalDocs.bindingsZh ].every(source =>
        hasAll(source, [
            'read-only snapshot',
            'private map',
            'prototype',
            '`get()`',
            '`values()`',
            'slot table',
        ])
    ),
    uploadQueueOwnership: [ finalDocs.transfers, finalDocs.transfersZh ].every(source =>
        hasAll(source, [
            '`ScratchRuntime.queue`',
            'foreign queue',
            '`writeBuffer()`',
            '`writeTexture()`',
            '`copyExternalImageToTexture()`',
            '`SCRATCH_COMMAND_WRONG_RUNTIME`',
            '`actual.queueOwnedByRuntime: false`',
            'same-device object-validity',
        ])
    ) && [ finalDocs.diagnostics, finalDocs.diagnosticsZh ].every(source =>
        hasAll(source, [
            'immediate upload variant',
            '`SCRATCH_COMMAND_WRONG_RUNTIME`',
            '`actual.queueOwnedByRuntime: false`',
        ]) && !source.includes('target, queue ownership, lifecycle')
    ) && hasAll(current.command, [ 'validateUploadCommandQueueOwner(command, queue)' ]) &&
        hasAll(externalImageQueueOwnershipTest, [
            'command.execute(fixtureB.queue)',
            'SCRATCH_COMMAND_WRONG_RUNTIME',
            'queueOwnedByRuntime: false',
        ]) &&
        !externalImageQueueOwnershipTest.includes('SCRATCH_COMMAND_EXTERNAL_IMAGE_UPLOAD_INVALID'),
    safeLayoutArithmetic: [ finalDocs.resources, finalDocs.resourcesZh ].every(source =>
        hasAll(source, [
            'array count',
            'alignment round-up',
            'JavaScript safe integer',
            'WGSL `u32`',
            '`0xffffffff`',
            '`SCRATCH_LAYOUT_UNSUPPORTED_FORMAT`',
            '`LayoutArtifact`',
        ])
    ) && [ finalDocs.diagnostics, finalDocs.diagnosticsZh ].every(source =>
        hasAll(source, [
            '`actual.reason`',
            '`actual.operation`',
            '`actual.safeIntegerMax`',
            '`actual.wgslU32Max`',
            '`LayoutArtifact`',
        ])
    ),
    portableUniformCompatibility: [
        finalDocs.resources,
        finalDocs.resourcesZh,
        finalDocs.programs,
        finalDocs.programsZh,
    ].every(source => hasAll(source, [
        '`usageCompatibility.uniform`',
        '`uniform_buffer_standard_layout`',
        '`arrayStride`',
        '16',
        'host-shareable/storage ABI',
    ])),
    supportingObjectNativeIdentity: [ finalDocs.resources, finalDocs.resourcesZh ].every(source =>
        hasAll(source, [
            '`gpuSampler`',
            '`gpuQuerySet`',
            'private',
            'immutable',
            'native handle',
            'prototype',
            'frozen',
        ])
    ),
    persistentBindingPrototypeAuthority:
        [ finalDocs.bindings, finalDocs.bindingsZh ].every(source => hasAll(source, [
            '`BindLayout.prototype`',
            '`BindSet.prototype`',
            '`preparationState`',
            '`assertPrepared()`',
            'stale allocation snapshot',
        ])),
    commandPrototypeAuthority:
        [ finalDocs.commands, finalDocs.commandsZh ].every(source => hasAll(source, [
            '`label`',
            'command prototype',
            'lifecycle',
            'encoding',
            'module',
        ])),
    closedBrandAuthority:
        [ finalDocs.resources, finalDocs.resourcesZh ].every(source => hasAll(source, [
            'module-private',
            '`WeakSet`',
            '`instanceof`',
            '`Symbol.hasInstance`',
            '`Object.create(',
        ])) &&
        [ finalDocs.bindings, finalDocs.bindingsZh ].every(source => hasAll(source, [
            'module-private',
            '`WeakMap`',
            '`isBindLayout()`',
            '`isBindSet()`',
            '`assertRuntime()`',
            '`Object.create(',
        ])) &&
        [ finalDocs.commands, finalDocs.commandsZh ].every(source => hasAll(source, [
            'module-private',
            '`WeakMap`',
            '`isRenderPipeline()`',
            '`isComputePipeline()`',
            '`isBindSet()`',
            '`instanceof`',
            '`Object.create(',
        ])) &&
        [ finalDocs.passes, finalDocs.passesZh ].every(source => hasAll(source, [
            'module-private',
            '`WeakMap`',
            '`isRenderPassSpec()`',
            '`isComputePassSpec()`',
            '`assertRuntime()`',
            '`Object.create(',
        ])) &&
        [ finalDocs.programs, finalDocs.programsZh ].every(source => hasAll(source, [
            'module-private',
            '`WeakSet`',
            '`isProgram()`',
            'Pipeline',
            'Shader inspection',
            '`Object.create(',
        ])) &&
        [ finalDocs.diagnostics, finalDocs.diagnosticsZh ].every(source => hasAll(source, [
            'module-private',
            '`WeakSet`',
            '`instanceof`',
            '`Symbol.hasInstance`',
            '`Object.create(',
        ])) && closedBrandAuthority.status === 'passed',
    attachmentViewContracts: [ finalDocs.passes, finalDocs.passesZh ].every(source =>
        hasAll(source, [
            'RENDER_ATTACHMENT',
            'TRANSIENT_ATTACHMENT',
            '`2d-array`',
            '`3d`',
            '`depthSlice`',
            'current logical mip depth',
            'color-renderable',
            'pairwise disjoint',
            'GPUStencilValue',
            'GPUSize32',
            'clear',
            'discard',
            'depthClear',
            '[0, 1]',
        ]) &&
        !source.includes('single 2D mip/layer view') &&
        !source.includes('one `2d` mip-level array layer')
    ),
    passSpecImmutability: [ finalDocs.passes, finalDocs.passesZh ].every(source =>
        hasAll(source, [ 'PassSpec', 'timestamp', 'lifecycle', 'mutation' ])
    ),
    timestampWriteIndices: [ finalDocs.passes, finalDocs.passesZh ].every(source =>
        hasAll(source, [ 'timestampWrites', 'begin', 'end', 'distinct' ])
    ),
    querySetLifecyclePreflight: [ finalDocs.passes, finalDocs.passesZh ].every(source =>
        hasAll(source, [
            'pass-owned',
            'QuerySetResource',
            'lifecycle',
            'attachment view',
            'command encoder',
            'current-use',
        ])
    ),
    programRequirementSnapshots: [ finalDocs.programs, finalDocs.programsZh ].every(source =>
        hasAll(source, [ 'Pipeline', 'layoutRequirements', 'snapshot', 'Command' ])
    ) && hasAll(finalDocs.bindingDecision, [ 'Pipeline requirement snapshot', 'mutable Program property' ]),
    nativeCopies: hasAll(finalDocs.transfers, [ 'copyBufferToBuffer', 'copyTextureToTexture', 'copyBufferToTexture', 'copyTextureToBuffer' ]),
    occlusionDocumentationUsesRenderableDepthView: [
        finalDocs.transfers,
        finalDocs.transfersZh,
    ].every(source => {
        const start = source.indexOf('const visibilityQueries')
        const end = source.indexOf('const drawTileWithVisibility')
        const snippet = source.slice(start, end)
        return start >= 0 &&
            end > start &&
            snippet.includes('target: depth.view(),') &&
            !snippet.includes("aspect: 'depth-only'")
    }),
    nativeTexelBlockCopies: [ finalDocs.transfers, finalDocs.transfersZh ].every(source =>
        hasAll(source, [
            '95',
            'texel block',
            'rowsPerImage',
            'GPUSize32',
            '0xffffffff',
            'depth32float-stencil8',
            'core-features-and-limits',
            'no CPU round trip',
        ])
    ),
    diagnosticsV5: hasAll(finalDocs.diagnostics, [ 'version 5', 'bind-set-preparation' ]),
    acceptedDecisions: hasAll(finalDocs.resourceDecision, [ '## Status', 'Accepted' ]) &&
        hasAll(finalDocs.bindingDecision, [ '## Status', 'Accepted' ]) &&
        hasAll(finalDocs.diagnosticsDecision, [ '## Status', 'Accepted' ]) &&
        hasAll(finalDocs.surfaceDecision, [ '## Status', 'Accepted' ]),
    thirtySixthReviewAcceptanceRecorded: hasAll(finalDocs.finalAudit, [
        'Clean thirty-sixth-review checkpoint acceptance (`4926648`)',
        cleanThirtySixthReviewCheckpoint,
        'focused acceptance passed 467/467',
        'complete suite reported 865 passing',
    ]),
    thirtySeventhReviewAcceptanceRecorded: hasAll(finalDocs.finalAudit, [
        'Clean thirty-seventh-review checkpoint acceptance (`3d5f4d7`)',
        cleanThirtySeventhReviewCheckpoint,
        'focused acceptance passed 472/472',
        'complete suite reported 870 passing',
    ]),
    thirtyEighthReviewAcceptanceRecorded: hasAll(finalDocs.finalAudit, [
        'Clean thirty-eighth-review checkpoint acceptance (`c9cfad3`)',
        cleanThirtyEighthReviewCheckpoint,
        'focused acceptance passed 475/475',
        'complete suite reported 873 passing',
    ]),
    currentAcceptanceCounts: hasAll(finalDocs.finalAudit, [
        'executes exactly 479',
        'complete suite to report exactly 877 passing',
    ]),
    resourceStateParity: resourceStateParity.status === 'passed',
    programExamplesUseBufferRegions: [ finalDocs.programs, finalDocs.programsZh ]
        .every(programExampleUsesBufferRegion),
    layoutCodecDiagnosticsCurrent: [ finalDocs.diagnostics, finalDocs.diagnosticsZh ]
        .every(source => equalSets(scratchLayoutDiagnosticCodes(source), currentLayoutDiagnosticCodes)),
    visionDiagnosticInventoryCurrent: visionDiagnosticParity.status === 'passed',
    storageBufferAccessCurrent: [ finalDocs.bindings, finalDocs.bindingsZh ].every(source =>
        hasAll(source, [
            'read-write storage',
            '`resources.read`',
            '`resources.write`',
            'upload',
        ])
    ),
    supersededLayoutDecisionsCurrent:
        legacyLayoutDecisionUsesCurrentReplacement(
            finalDocs.legacyResourceDecision,
            'Superseded by ADR-036',
            [ '`BufferResource` is a raw container', 'BufferRegion', 'abiHash', 'schemaHash' ]
        ) &&
        legacyLayoutDecisionUsesCurrentReplacement(
            finalDocs.legacyProgramDecision,
            'Superseded in part by ADR-036',
            [ 'ProgramBufferLayoutRequirement', 'BufferRegion', 'abiHash', 'schemaHash' ]
        ) &&
        legacyLayoutDecisionUsesCurrentReplacement(
            finalDocs.legacyReadbackDecision,
            'Superseded in part by ADR-036',
            [ 'BufferRegion', 'toLayoutView()', 'source region' ]
        ),
    obsoleteSubmissionAuditRemoved:
        !fs.existsSync('docs/review/scratch-submission-native-final-parity-audit.md') &&
        !fs.existsSync('tests/audits/scratch-submission-native-final-parity.mjs'),
    activeReviewReferencesCurrentAudit:
        !activeReviewSource.includes('scratch-submission-native-final-parity') &&
        activeReviewSource.includes('scratch-persistent-binding-views-final-audit.md') &&
        activeReviewSource.includes(
            'Current replacement: schema v5 and acknowledged explicit BindSet preparation.'
        ) &&
        activeReviewSource.includes(
            'Current replacement: supporting-object and pipeline creation use acknowledged operations.'
        ) &&
        activeReviewSource.includes(
            'Current replacement: persistent bindings use explicit `TextureViewSpec` values and acknowledged `BindSet.prepare()`.'
        ) &&
        !activeReviewSource.includes(
            '- schema-v4 submission targets, discriminated native locations, bounded current'
        ) &&
        !activeReviewSource.includes(
            '- explicit deferred sampler/query-set/bind-layout and independent lazy'
        ) &&
        !activeReviewSource.includes(
            'Internal staging allocation, samplers, query sets, bindings, pipelines, encoders, queue operations, mapping, and submission-level native attribution remain explicit deferred families.'
        ) &&
        !activeReviewSource.includes(
            'Bind sets derive views from their layout dimension'
        ) &&
        !activeReviewSource.includes(
            'Compatibility-mode bind preflight re-derives omitted `textureBindingViewDimension`'
        ),
    submissionViewOwnership: [ finalDocs.commands, finalDocs.commandsZh ].every(source =>
        hasAll(source, [
            'persistent binding',
            'attachment',
            'submission-scoped',
            'TextureViewSpec',
        ]) &&
        !source.includes('Submission never creates a texture view or bind group') &&
        !source.includes('Submission\n\u7edd\u4e0d\u521b\u5efa texture view \u6216 bind group')
    ),
})
const documentationStatus = Object.values(documentationAudit).every(Boolean)
const officialSpecificationEvidence = acceptanceMode
    ? await fetchOfficialSpecificationEvidence(canonicalWebGpuTypes)
    : Object.freeze({
        status: 'not-run',
        source: officialSpecificationSource,
        webIdlSource: officialWebIdlSource,
    })
const executionEvidence = acceptanceMode
    ? await runAcceptanceEvidence(
        focusedAcceptanceTestFiles,
        behaviorTestContracts,
        productionBootstrap
    )
    : Object.freeze({ status: 'not-run' })

assertParity(
    capabilityRows.every(row => row.status === 'passed'),
    `capability rows failed: ${failedRows(capabilityRows)}`
)
assertParity(baselineMissingValues.length === 0, `Goal-start value exports missing: ${baselineMissingValues}`)
assertParity(historicalMissingValues.length === 0, `historical value exports missing: ${historicalMissingValues}`)
assertParity(
    equalSets(baselineMissingTypes, expectedBaselineMissingTypes),
    `Goal-start type replacements drifted: ${JSON.stringify(baselineMissingTypes)}`
)
for (const [ removed, replacement ] of Object.entries(baselineTypeReplacements)) {
    assertParity(
        publicExportNames(current.scratchIndex).includes(replacement),
        `${removed} replacement ${replacement} is not exported`
    )
}
assertParity(
    classifiedHistoricalTypes.every(entry => entry.status === 'passed'),
    `historical type classifications failed: ${failedRows(classifiedHistoricalTypes)}`
)
assertParity(
    publicMemberParity.status === 'passed',
    `public member dispositions failed: ${JSON.stringify(publicMemberParity)}`
)
assertParity(
    testEvidence.status === 'passed',
    `referenced behavioral test evidence failed: ${JSON.stringify(testEvidence)}`
)
assertParity(
    equalSets(missingBaselineDiagnostics, Object.keys(diagnosticReplacements)),
    `Goal-start diagnostic replacements drifted: ${JSON.stringify(missingBaselineDiagnostics)}`
)
for (const replacements of Object.values(diagnosticReplacements)) {
    assertParity(
        replacements.every(code => currentDiagnosticCodes.includes(code)),
        `replacement diagnostic missing: ${JSON.stringify(replacements)}`
    )
}
assertParity(
    officialBindingMatrix.every(row => row.status === 'passed') &&
        bindingLowering.status === 'passed' &&
        externalTextureBoundary.intentionallyExcluded,
    `official binding matrix failed: ${failedRows(officialBindingMatrix)}`
)
assertParity(
    nativeCopyQuadrants.every(row => row.status === 'passed'),
    `native copy parity failed: ${failedRows(nativeCopyQuadrants)}`
)
assertParity(
    productionEmitParity.status === 'passed',
    `production emit parity failed: ${JSON.stringify(productionEmitParity.failures)}`
)
assertParity(
    closedBrandAuthority.status === 'passed',
    `closed brand authority failed: ${JSON.stringify(closedBrandAuthority)}`
)
assertParity(sourceFirst.status === 'passed', 'Scratch source-first boundary failed')
assertParity(exampleAudit.status === 'passed', `example audit failed: ${exampleAudit.failures.join(', ')}`)
assertParity(documentationStatus, `documentation audit failed: ${JSON.stringify(documentationAudit)}`)
assertParity(!currentScratchSource.includes('structuralHash'), 'structuralHash remains in Scratch source')
assertParity(!/version:\s*4/.test(currentScratchSource), 'schema v4 output remains in Scratch source')
if (acceptanceMode) {
    assertParity(
        officialSpecificationEvidence.status === 'passed',
        `official specification evidence failed: ${JSON.stringify(officialSpecificationEvidence)}`
    )
    assertParity(
        executionEvidence.status === 'passed',
        `acceptance execution failed: ${JSON.stringify(executionEvidence)}`
    )
}

const result = {
    schemaVersion: 1,
    baseline: goalBaseline,
    historicalJavaScript,
    target: auditTarget,
    productionBootstrap,
    officialSpecification,
    capabilityRows,
    publicSurface: {
        baselineValueExportCount: baselineValueExports.length,
        historicalValueExportCount: historicalValueExports.length,
        finalValueExportCount: currentValueExports.length,
        missingBaselineValues: baselineMissingValues,
        missingHistoricalValues: historicalMissingValues,
        goalStartTypeReplacements: baselineTypeReplacements,
        historicalTypeInventory: classifiedHistoricalTypes,
        publicMemberParity,
        productionEmitParity,
        sourceFirst,
        closedBrandAuthority,
    },
    diagnostics: {
        goalStartCodeCount: baselineDiagnosticCodes.length,
        finalCodeCount: currentDiagnosticCodes.length,
        intentionalReplacements: diagnosticReplacements,
        unexpectedMissing: missingBaselineDiagnostics.filter(
            code => !(code in diagnosticReplacements)
        ),
        schemaVersion: 5,
    },
    officialBindingMatrix: {
        canonicalTypes: localWebGpuTypesEvidence,
        rows: officialBindingMatrix,
        nativeLowering: bindingLowering,
        externalTextureBoundary,
        status: officialBindingMatrix.every(row => row.status === 'passed') &&
            bindingLowering.status === 'passed' &&
            externalTextureBoundary.intentionallyExcluded
            ? 'passed'
            : 'failed',
    },
    nativeCopyQuadrants,
    testEvidence,
    officialSpecificationEvidence,
    executionEvidence,
    examples: exampleAudit,
    documentation: {
        checks: documentationAudit,
        resourceStateParity,
        visionDiagnosticParity,
        status: documentationStatus ? 'passed' : 'failed',
    },
    sourceHashes: {
        goalStart: sha256(baselineScratchSource),
        historicalJavaScript: sha256(historicalScratchSource),
        final: sha256(currentScratchSource),
    },
    verification: {
        mode: acceptanceMode ? 'acceptance' : 'structural',
        status: acceptanceMode ? 'passed' : 'incomplete',
        capabilityRowCount: capabilityRows.length,
        officialBindingRowCount: officialBindingMatrix.length,
        nativeCopyQuadrantCount: nativeCopyQuadrants.length,
        ordinaryExampleCount: ordinaryExamples.length,
        legacyExampleCount: legacyExamples.length,
    },
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)

function capability(input) {
    const historicalPasses = input.historical === true || input.historical === 'not-applicable'
    const status = input.goalStart && historicalPasses && input.final ? 'passed' : 'failed'
    return Object.freeze({ ...input, status })
}

function matrixRow(name, expected, actual) {
    const normalizedExpected = [ ...expected ].sort()
    const normalizedActual = [ ...actual ].sort()
    return Object.freeze({
        name,
        expected: normalizedExpected,
        actual: normalizedActual,
        status: equalSets(normalizedExpected, normalizedActual) ? 'passed' : 'failed',
    })
}

function emitProductionDeclarationsAt(commit) {
    const configPath = 'packages/geoscratch/tsconfig.build.json'
    const absoluteConfigPath = path.resolve(configPath)
    const config = JSON.parse(gitShow(commit, configPath))
    const parsed = ts.parseJsonConfigFileContent(
        config,
        ts.sys,
        path.dirname(absoluteConfigPath),
        undefined,
        absoluteConfigPath
    )
    if (parsed.errors.length > 0) throw new Error(formatTypeScriptDiagnostics(parsed.errors))
    const sourcePaths = execFileSync(
        'git',
        [ 'ls-tree', '-r', '--name-only', commit, 'packages/geoscratch/src' ],
        { encoding: 'utf8' }
    ).trim().split('\n').filter(fileName => /\.(?:ts|js)$/.test(fileName))
    const virtualSources = new Map(sourcePaths.map(fileName => [
        path.resolve(fileName),
        gitShow(commit, fileName),
    ]))
    const host = ts.createCompilerHost(parsed.options)
    const readFile = host.readFile.bind(host)
    const fileExists = host.fileExists.bind(host)
    const sourceRoot = `${path.resolve('packages/geoscratch/src')}${path.sep}`
    host.readFile = fileName => {
        const absolutePath = path.resolve(fileName)
        if (virtualSources.has(absolutePath)) return virtualSources.get(absolutePath)
        return absolutePath.startsWith(sourceRoot) ? undefined : readFile(fileName)
    }
    host.fileExists = fileName => {
        const absolutePath = path.resolve(fileName)
        return virtualSources.has(absolutePath) ||
            (!absolutePath.startsWith(sourceRoot) && fileExists(fileName))
    }
    const outputs = new Map()
    const program = ts.createProgram([ ...virtualSources.keys() ], parsed.options, host)
    const emit = program.emit(undefined, (fileName, data) => {
        if (fileName.endsWith('.d.ts')) outputs.set(path.resolve(fileName), data)
    }, undefined, true)
    const diagnostics = [ ...ts.getPreEmitDiagnostics(program), ...emit.diagnostics ]
        .filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)
    if (diagnostics.length > 0) throw new Error(formatTypeScriptDiagnostics(diagnostics))
    return outputs
}

function scratchDeclarationTree(outputs) {
    const scratchRoot = `${path.resolve('packages/geoscratch/dist/scratch')}${path.sep}`
    return Object.fromEntries([ ...outputs.entries() ]
        .filter(([ fileName ]) => fileName.startsWith(scratchRoot) && fileName.endsWith('.d.ts'))
        .map(([ fileName, source ]) => [ relativeWorkspacePath(fileName), source ]))
}

function emitCurrentProductionOutputs() {
    const configPath = path.resolve('packages/geoscratch/tsconfig.build.json')
    const config = ts.readConfigFile(configPath, ts.sys.readFile)
    if (config.error !== undefined) throw new Error(formatTypeScriptDiagnostics([ config.error ]))
    const parsed = ts.parseJsonConfigFileContent(
        config.config,
        ts.sys,
        path.dirname(configPath),
        undefined,
        configPath
    )
    if (parsed.errors.length > 0) throw new Error(formatTypeScriptDiagnostics(parsed.errors))

    const outputs = new Map()
    const host = ts.createCompilerHost(parsed.options)
    const program = ts.createProgram(parsed.fileNames, parsed.options, host)
    const emit = program.emit(undefined, (fileName, data) => {
        if (fileName.endsWith('.js') || fileName.endsWith('.d.ts')) {
            outputs.set(path.resolve(fileName), data)
        }
    })
    const diagnostics = [ ...ts.getPreEmitDiagnostics(program), ...emit.diagnostics ]
        .filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)
    if (diagnostics.length > 0) throw new Error(formatTypeScriptDiagnostics(diagnostics))
    return outputs
}

function auditProductionEmit(outputs) {
    const distRoot = path.resolve('packages/geoscratch/dist')
    const emittedPaths = [ ...outputs.keys() ].sort()
    const actualPaths = listFiles(distRoot)
        .filter(fileName => fileName.endsWith('.js') || fileName.endsWith('.d.ts'))
        .map(fileName => path.resolve(fileName))
        .sort()
    const missing = difference(emittedPaths, actualPaths).map(relativeWorkspacePath)
    const stale = difference(actualPaths, emittedPaths).map(relativeWorkspacePath)
    const files = emittedPaths.map(fileName => {
        const emitted = outputs.get(fileName)
        const actualExists = fs.existsSync(fileName)
        const actual = actualExists ? fs.readFileSync(fileName, 'utf8') : undefined
        const exactMatch = actual === emitted
        return Object.freeze({
            path: relativeWorkspacePath(fileName),
            kind: fileName.endsWith('.d.ts') ? 'declaration' : 'javascript',
            actualExists,
            exactMatch,
            emittedHash: sha256(emitted),
            actualHash: actual === undefined ? undefined : sha256(actual),
            status: actualExists && exactMatch ? 'passed' : 'failed',
        })
    })
    const emittedJavaScriptCount = files.filter(entry => entry.kind === 'javascript').length
    const emittedDeclarationCount = files.filter(entry => entry.kind === 'declaration').length
    const signatureManifest = declarationSignatureManifest(outputs)
    const failures = [
        ...missing.map(fileName => `missing:${fileName}`),
        ...stale.map(fileName => `stale:${fileName}`),
        ...files.filter(entry => !entry.exactMatch).map(entry => `mismatch:${entry.path}`),
    ]
    return Object.freeze({
        emittedJavaScriptCount,
        emittedDeclarationCount,
        declarationSignatureCount: signatureManifest.entries.length,
        declarationSignatureManifestHash: signatureManifest.hash,
        files,
        missing,
        stale,
        failures,
        status: failures.length === 0 && emittedJavaScriptCount === emittedDeclarationCount
            ? 'passed'
            : 'failed',
    })
}

function formatTypeScriptDiagnostics(diagnostics) {
    return ts.formatDiagnostics(diagnostics, {
        getCanonicalFileName: fileName => fileName,
        getCurrentDirectory: () => process.cwd(),
        getNewLine: () => '\n',
    })
}

function declarationSignatureManifest(outputs) {
    const entries = []
    for (const [ fileName, source ] of outputs) {
        if (!fileName.endsWith('.d.ts')) continue
        const file = parseSource(source, fileName)
        walk(file, node => {
            if (!isDeclarationSignatureNode(node)) return
            entries.push([
                relativeWorkspacePath(fileName),
                ts.SyntaxKind[node.kind],
                normalizedNodeText(node, file),
            ].join('|'))
        })
    }
    entries.sort()
    return Object.freeze({
        entries,
        hash: sha256(JSON.stringify(entries)),
    })
}

function isDeclarationSignatureNode(node) {
    return ts.isClassDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isEnumDeclaration(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isVariableStatement(node) ||
        ts.isModuleDeclaration(node) ||
        ts.isMethodSignature(node) ||
        ts.isPropertySignature(node) ||
        ts.isCallSignatureDeclaration(node) ||
        ts.isConstructSignatureDeclaration(node) ||
        ts.isIndexSignatureDeclaration(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isPropertyDeclaration(node) ||
        ts.isConstructorDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node)
}

function relativeWorkspacePath(fileName) {
    return path.relative(process.cwd(), path.resolve(fileName)).split(path.sep).join('/')
}

function typeAliasStringUnion(source, aliasName) {
    const file = parseSource(source, `${aliasName}.d.ts`)
    const values = []
    for (const statement of file.statements) {
        if (!ts.isTypeAliasDeclaration(statement) || statement.name.text !== aliasName) continue
        collectStringLiteralTypes(statement.type, values)
    }
    assertParity(values.length > 0, `string union ${aliasName} was not found`)
    return [ ...new Set(values) ].sort()
}

function collectStringLiteralTypes(node, values) {
    if (ts.isUnionTypeNode(node)) {
        for (const type of node.types) collectStringLiteralTypes(type, values)
        return
    }
    if (ts.isLiteralTypeNode(node) && ts.isStringLiteralLike(node.literal)) {
        values.push(node.literal.text)
    }
}

function markdownTypeAliasStringUnion(markdown, aliasName) {
    const match = markdown.match(new RegExp(`type\\s+${aliasName}\\s*=\\s*([^\\n]+)`))
    assertParity(match !== null, `Markdown type alias ${aliasName} was not found`)
    return typeAliasStringUnion(`type ${aliasName} = ${match[1]}`, aliasName)
}

function auditResourceStateDocumentation() {
    const target = [ 'empty', 'indeterminate', 'ready' ]
    const resource = typeAliasStringUnion(current.resource, 'ResourceState')
    const querySlot = typeAliasStringUnion(current.querySet, 'QuerySetSlotState')
    const english = markdownTypeAliasStringUnion(finalDocs.resources, 'ResourceState')
    const chinese = markdownTypeAliasStringUnion(finalDocs.resourcesZh, 'ResourceState')
    const rows = [
        matrixRow('ResourceState target', target, resource),
        matrixRow('QuerySetSlotState target', target, querySlot),
        matrixRow('English ResourceState documentation', resource, english),
        matrixRow('Chinese ResourceState documentation', resource, chinese),
    ]
    const disposalSeparate = finalDocs.resources.includes('resource.isDisposed') &&
        finalDocs.resources.includes('never folded into scalar or indexed content state') &&
        finalDocs.resourcesZh.includes('resource.isDisposed') &&
        finalDocs.resourcesZh.includes('不会混入 scalar 或 indexed content state')
    return Object.freeze({
        rows,
        disposalSeparate,
        status: rows.every(row => row.status === 'passed') && disposalSeparate
            ? 'passed'
            : 'failed',
    })
}

function programExampleUsesBufferRegion(source) {
    const bufferDescriptors = source.match(/scratch\.buffer\(\{[\s\S]*?\n\}\)/g) ?? []
    return bufferDescriptors.length > 0 &&
        bufferDescriptors.every(descriptor => !/\blayout\s*:/.test(descriptor)) &&
        hasAll(source, [
            'const pointBuffer = await scratch.buffer({',
            'const points = pointBuffer.region({',
            'layout: pointCodec.artifact',
        ])
}

function scratchLayoutDiagnosticCodes(source) {
    return [ ...new Set(source.match(/SCRATCH_(?:LAYOUT|CODEC)_[A-Z_]+/g) ?? []) ].sort()
}

function scratchDiagnosticCodes(source) {
    return [ ...new Set(source.match(/SCRATCH_[A-Z0-9_]+/g) ?? []) ].sort()
}

function auditVisionDiagnosticDocumentation() {
    const root = 'docs/vision/scratch-api'
    const implemented = scratchDiagnosticCodes(currentScratchSource)
    const implementedSet = new Set(implemented)
    const documented = new Set()
    const rows = fs.readdirSync(root, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => {
            const englishPath = path.join(root, entry.name, 'README.md')
            const chinesePath = path.join(root, entry.name, 'README_zh.md')
            if (!fs.existsSync(englishPath) || !fs.existsSync(chinesePath)) {
                return Object.freeze({
                    module: entry.name,
                    englishExists: fs.existsSync(englishPath),
                    chineseExists: fs.existsSync(chinesePath),
                    status: 'failed',
                })
            }
            const english = scratchDiagnosticCodes(fs.readFileSync(englishPath, 'utf8'))
            const chinese = scratchDiagnosticCodes(fs.readFileSync(chinesePath, 'utf8'))
            for (const code of english) documented.add(code)
            for (const code of chinese) documented.add(code)
            const unsupported = [ ...new Set([ ...english, ...chinese ]) ]
                .filter(code => !implementedSet.has(code))
                .sort()
            return Object.freeze({
                module: entry.name,
                english,
                chinese,
                unsupported,
                status: equalSets(english, chinese) && unsupported.length === 0
                    ? 'passed'
                    : 'failed',
            })
        })
        .sort((left, right) => left.module.localeCompare(right.module))
    const unsupportedCodes = [ ...documented ]
        .filter(code => !implementedSet.has(code))
        .sort()
    const undocumentedCodes = implemented
        .filter(code => !documented.has(code))
        .sort()
    return Object.freeze({
        implementedCodeCount: implemented.length,
        documentedCodes: Object.freeze([ ...documented ].sort()),
        unsupportedCodes: Object.freeze(unsupportedCodes),
        undocumentedCodes: Object.freeze(undocumentedCodes),
        rows: Object.freeze(rows),
        status: rows.length > 0 &&
            rows.every(row => row.status === 'passed') &&
            unsupportedCodes.length === 0 &&
            undocumentedCodes.length === 0
            ? 'passed'
            : 'failed',
    })
}

function legacyLayoutDecisionUsesCurrentReplacement(source, status, markers) {
    return decisionStatus(source).includes(status) &&
        source.includes('## Historical Decision') &&
        source.includes('## Current Replacement') &&
        !/^## Decision\s*$/m.test(source) &&
        hasAll(source, markers)
}

function decisionStatus(source) {
    return source.match(/## Status\s+([^#]+)/)?.[1].trim() ?? ''
}

function loadMarkdownDirectory(directory) {
    return fs.readdirSync(directory, { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
        .map(entry => fs.readFileSync(path.join(directory, entry.name), 'utf8'))
        .join('\n')
}

async function fetchOfficialSpecificationEvidence(canonicalTypes) {
    const source = fetchOfficialSource(officialSpecificationSource)
    const copiesSource = fetchOfficialSource(officialCopiesSpecificationSource)
    const webIdlSource = fetchOfficialSource(officialWebIdlSource)
    const combinedSource = `${source}\n${copiesSource}`
    const normalizedCombinedSource = combinedSource.replace(/\s+/g, ' ')
    const normalizedWebIdlSource = webIdlSource.replace(/\s+/g, ' ')
    const enumPairs = [
        [ 'GPUBufferBindingType', canonicalTypes.bufferBindingTypes ],
        [ 'GPUSamplerBindingType', canonicalTypes.samplerBindingTypes ],
        [ 'GPUTextureSampleType', canonicalTypes.textureSampleTypes ],
        [ 'GPUTextureViewDimension', canonicalTypes.textureViewDimensions ],
        [ 'GPUStorageTextureAccess', canonicalTypes.storageTextureAccess ],
        [ 'GPUQueryType', canonicalTypes.queryTypes ],
    ]
    const enumParity = enumPairs.map(([ name, expected ]) =>
        matrixRow(name, expected, bikeshedEnumStringValues(source, name))
    )
    const textureFormatParity = matrixRow(
        'GPUTextureFormat',
        canonicalTypes.textureFormats,
        bikeshedEnumStringValues(source, 'GPUTextureFormat')
    )
    const requiredMarkers = Object.freeze({
        resourceBindingEnums: 'enum GPUBufferBindingType',
        objectSameDeviceValidity:
            '|object|.{{GPUObjectBase/[[device]]}} must equal |targetObject|.{{GPUObjectBase/[[device]]}}.',
        storageTextureDimensionRestriction:
            '{{GPUTextureViewDimension/"cube"}} or {{GPUTextureViewDimension/"cube-array"}}',
        physicalMipExtent: '<dfn dfn>physical miplevel-specific texture extent</dfn>',
        threeDimensionalMipDepth:
            '[=GPUExtent3D/depthOrArrayLayers=] &Gt; |mipLevel|)',
        copyCompatibleFormats: 'must be [=copy-compatible=]',
        disjointTextureSubresources:
            'the [$set of subresources for texture copy$](|destination|, |copySize|) are disjoint',
        equalTextureSampleCounts:
            '|srcTexture|.{{GPUTexture/sampleCount}} is equal to |dstTexture|.{{GPUTexture/sampleCount}}',
        compatibilityTextureSampleCounts:
            '{{GPUTexture/sampleCount}} and |destination|.{{GPUTexelCopyTextureInfo/texture}}.{{GPUTexture/sampleCount}} must be 1.',
        depthStencilFullPhysicalSubresource:
            'The [=GPUTexelCopyTextureInfo physical subresource size=] of |texelCopyTextureInfo| is equal to |copySize| if either of the following conditions is true: - |texelCopyTextureInfo|.{{GPUTexelCopyTextureInfo/texture}}.{{GPUTexture/format}} is a depth-stencil format.',
        multisampleFullPhysicalSubresource:
            '- |texelCopyTextureInfo|.{{GPUTexelCopyTextureInfo/texture}}.{{GPUTexture/sampleCount}} &gt; 1.',
        compatibilityCompressedTextureRestriction:
            '- |source|.{{GPUTexelCopyTextureInfo/texture}}.{{GPUTexture/format}} must not be a [=compressed format=]. - |destination|.{{GPUTexelCopyTextureInfo/texture}}.{{GPUTexture/format}} must not be a [=compressed format=].',
        wholeTexelBlockCopies:
            'Operations that copy between byte arrays and textures always operate on whole [=texel block=].',
        rowsPerImageUsesBlockRows:
            'Number of [=texel block rows=] per single [=texel image=] of the [=texture=].',
        linearCopyUsesBlockFootprint:
            '|bytesInLastRow| be |widthInBlocks| &times; the [=texel block copy footprint=] of |format|.',
        depthStencilSingleAspect:
            'must refer to a single aspect of |texture|.{{GPUTexture/format}}.',
        depthStencilBufferOffsetAlignment:
            'Set |offsetAlignment| to 4.',
        depthStencilCopyCapabilityTable:
            '<th>Valid [=texel copy=] source <th>Valid [=texel copy=] destination <th>[=Texel block copy footprint=] (Bytes)',
        textureToBufferCompatibilityCompressedRestriction:
            '[$validating texture buffer copy$](|source|, |destination|, |dataLength|, |copySize|, {{GPUTextureUsage/COPY_SRC}}, |aligned|) returns `true`. - <div class=compatmode> If device.{{device/[[features]]}} does not [=list/contain=] {{GPUFeatureName/"core-features-and-limits"}}: - |source|.{{GPUTexelCopyTextureInfo/texture}}.{{GPUTexture/format}} must not be a [=compressed format=].',
        bufferToBuffer: 'copyBufferToBuffer(source, sourceOffset, destination, destinationOffset, size)',
        textureToTexture: 'copyTextureToTexture(source, destination, copySize)',
        bufferToTexture: 'copyBufferToTexture(source, destination, copySize)',
        textureToBuffer: 'copyTextureToBuffer(source, destination, copySize)',
        pipelineLayoutGroupIndex:
            'with the `N`th element corresponding with `@group(N)`.',
        pipelineLayoutNullableSlots:
            'required sequence<GPUBindGroupLayout?> bindGroupLayouts;',
        pipelineLayoutNullInitialization:
            'Let |bindGroupLayouts| be a [=list=] of `null` {{GPUBindGroupLayout}}s',
        pipelineLayoutAggregateBindingLimits:
            '|allEntries| must not [=exceeds the binding slot limits|exceed the binding slot limits=] of |limits|.',
        bufferCopyDistinctResources:
            '|source| and |destination| are not the same {{GPUBuffer}}.',
        textureViewTransientUsage:
            '|descriptor|.{{GPUTextureViewDescriptor/usage}} must be exactly |this|.{{GPUTexture/usage}}.',
        textureViewRenderableFormat:
            '|descriptor|.{{GPUTextureViewDescriptor/format}} must be a [=renderable format=].',
        textureViewStorageFormat:
            'with {{GPUTextureUsage/STORAGE_BINDING}} capability for at least one access mode.',
        renderableTextureViewUsage:
            '|descriptor|.{{GPUTextureViewDescriptor/usage}} must contain {{GPUTextureUsage/RENDER_ATTACHMENT}}.',
        renderableTextureViewAllAspects:
            '|descriptor|.{{GPUTextureViewDescriptor/aspect}} must refer to all [=aspects=]',
        transientColorAttachmentOperations:
            '|this|.{{GPURenderPassColorAttachment/loadOp}} |must| be {{GPULoadOp/"clear"}}. 1. |this|.{{GPURenderPassColorAttachment/storeOp}} |must| be {{GPUStoreOp/"discard"}}.',
        transientDepthAttachmentOperations:
            '|this|.{{GPURenderPassDepthStencilAttachment/depthLoadOp}} |must| be {{GPULoadOp/"clear"}}. 1. |this|.{{GPURenderPassDepthStencilAttachment/depthStoreOp}} |must| be {{GPUStoreOp/"discard"}}.',
        depthClearUnitRange:
            '|this|.{{GPURenderPassDepthStencilAttachment/depthClearValue}} |must| [=map/exist|be provided=] and |must| be between 0.0 and 1.0, inclusive.',
        renderPipelineAttachmentPresence:
            'There must exist at least one attachment, either: - A non-`null` value in |descriptor|.{{GPURenderPipelineDescriptor/fragment}}.{{GPUFragmentState/targets}}, or - A |descriptor|.{{GPURenderPipelineDescriptor/depthStencil}}.',
        renderPassAttachmentPresence:
            'There must exist at least one attachment, either: - A non-`null` value in |this|.{{GPURenderPassDescriptor/colorAttachments}}, or - A |this|.{{GPURenderPassDescriptor/depthStencilAttachment}}.',
        renderAttachmentDepthSlice:
            '|this|.{{GPURenderPassColorAttachment/depthSlice}} |must| [=map/exist|be provided=] and |must| be &lt; the [=GPUExtent3D/depthOrArrayLayers=] of the [=logical miplevel-specific texture extent=]',
        colorAttachmentRenderableFormat:
            '|renderViewDescriptor|.{{GPUTextureViewDescriptor/format}} |must| be a [=color renderable format=].',
        pairwiseColorAttachmentRegions:
            'The set of texture regions in |attachmentRegions| must be pairwise disjoint. That is, no two texture regions may overlap.',
        canvasContextGetConfiguration:
            'GPUCanvasConfiguration? getConfiguration();',
        canvasTransientAttachmentRejected:
            '|configuration|.{{GPUCanvasConfiguration/usage}} includes the {{GPUTextureUsage/TRANSIENT_ATTACHMENT}} bit, throw a {{TypeError}}.',
        canvasConfigureCommitsConfiguration:
            'Set |this|.{{GPUCanvasContext/[[configuration]]}} to |configuration|.',
        canvasUnconfigureClearsConfiguration:
            'Set |this|.{{GPUCanvasContext/[[configuration]]}} to `null`.',
        textureMaximumMipLevelCount:
            '|descriptor|.{{GPUTextureDescriptor/mipLevelCount}} must be &le; [$maximum mipLevel count$](|descriptor|.{{GPUTextureDescriptor/dimension}}, |descriptor|.{{GPUTextureDescriptor/size}}).',
        oneDimensionalTextureMipmapRestriction:
            '{{GPUTextureDimension/"1d"}} textures cannot have mipmaps, be multisampled, use compressed or depth/stencil formats, or be used as a render target.',
        oneDimensionalMaximumMipLevelCount:
            ': {{GPUTextureDimension/"1d"}} :: Return 1.',
        compatibilityBoundTextureFullArrayLayers:
            '- |descriptor|.{{GPUTextureViewDescriptor/baseArrayLayer}} must be `0`. - |descriptor|.{{GPUTextureViewDescriptor/arrayLayerCount}} must be equal to |textureView|.{{GPUTextureView/[[texture]]}}.{{GPUTexture/depthOrArrayLayers}}.',
        timestampWriteIndicesDistinct:
            '- No two may be equal. - Each must be &lt; |timestampWrites|.`querySet`.{{GPUQuerySet/count}}.',
        writeBufferContentsAlignment:
            '|contentsSize|, converted to bytes, is a multiple of 4 bytes.',
        writeBufferOffsetAlignment:
            '|bufferOffset|, converted to bytes, is a multiple of 4 bytes.',
        vertexBufferOffsetAlignment:
            '|offset| must be a multiple of 4. - |offset| + |size| must be &le; |bufferSize|.',
        bufferCopyOffsetAndSizeAlignment:
            '- |size| is a multiple of 4. - |offset| is a multiple of 4.',
        gpuSizeAndCoordinateEnforceRange:
            'typedef [EnforceRange] unsigned long long GPUSize64; typedef [EnforceRange] unsigned long GPUIntegerCoordinate;',
        gpuSize32EnforceRange:
            'typedef [EnforceRange] unsigned long GPUSize32;',
        gpuStencilValueEnforceRange:
            'typedef [EnforceRange] unsigned long GPUStencilValue;',
        completeFiniteGpuColorShape:
            'dictionary GPUColorDict { required double r; required double g; required double b; required double a; }; typedef (sequence<double> or GPUColorDict) GPUColor;',
        textureFormatsTier2IncludesTier1:
            'Enabling {{GPUFeatureName/"texture-formats-tier2"}} at device creation will enable {{GPUFeatureName/"texture-formats-tier1"}}.',
        textureFormatsTier1IncludesRg11b10Renderable:
            'Enabling {{GPUFeatureName/"texture-formats-tier1"}} at device creation will enable {{GPUFeatureName/"rg11b10ufloat-renderable"}}.',
        clampedUnsignedShort: '[Clamp] unsigned short maxAnisotropy = 1;',
        maxAnisotropyMinimum:
            '|descriptor|.{{GPUSamplerDescriptor/maxAnisotropy}} &ge; 1.',
        anisotropyLinearFilters:
            '- If |descriptor|.{{GPUSamplerDescriptor/maxAnisotropy}} &gt; 1:',
    })
    const markerChecks = Object.entries(requiredMarkers).map(([ name, marker ]) => Object.freeze({
        name,
        present: normalizedCombinedSource.includes(marker.replace(/\s+/g, ' ')),
        status: normalizedCombinedSource.includes(marker.replace(/\s+/g, ' ')) ? 'passed' : 'failed',
    }))
    const requiredWebIdlMarkers = Object.freeze({
        clampToRange:
            'Set |x| to <a abstract-op>min</a>(<a abstract-op>max</a>(|x|, |lowerBound|), |upperBound|).',
        nearestEvenInteger:
            'Round |x| to the nearest integer, choosing the even integer if it lies halfway between two, and choosing +0 rather than −0.',
        nonFiniteFallback:
            'If |x| is <emu-val>NaN</emu-val>, +0, +∞, or −∞, then return +0.',
    })
    const webIdlMarkerChecks = Object.entries(requiredWebIdlMarkers).map(([ name, marker ]) =>
        Object.freeze({
            name,
            present: normalizedWebIdlSource.includes(marker.replace(/\s+/g, ' ')),
            status: normalizedWebIdlSource.includes(marker.replace(/\s+/g, ' '))
                ? 'passed'
                : 'failed',
        })
    )
    const status = source.length > 500_000 &&
        copiesSource.length > 10_000 &&
        webIdlSource.length > 100_000 &&
        enumParity.every(row => row.status === 'passed') &&
        textureFormatParity.status === 'passed' &&
        markerChecks.every(row => row.status === 'passed') &&
        webIdlMarkerChecks.every(row => row.status === 'passed')
        ? 'passed'
        : 'failed'
    return Object.freeze({
        source: officialSpecificationSource,
        copiesSource: officialCopiesSpecificationSource,
        httpStatus: 200,
        byteLength: Buffer.byteLength(source),
        sha256: sha256(source),
        copiesByteLength: Buffer.byteLength(copiesSource),
        copiesSha256: sha256(copiesSource),
        webIdlSource: officialWebIdlSource,
        webIdlByteLength: Buffer.byteLength(webIdlSource),
        webIdlSha256: sha256(webIdlSource),
        enumParity,
        textureFormatParity,
        markerChecks,
        webIdlMarkerChecks,
        status,
    })
}

function fetchOfficialSource(sourceUrl) {

    return execFileSync('curl', [
        '--fail',
        '--location',
        '--silent',
        '--show-error',
        '--retry',
        '3',
        '--retry-all-errors',
        '--connect-timeout',
        '15',
        '--max-time',
        '90',
        '--user-agent',
        'GeoScratch final parity audit',
        sourceUrl,
    ], {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
    })
}

function bikeshedEnumStringValues(source, enumName) {
    const match = source.match(new RegExp(`enum\\s+${enumName}\\s*\\{([\\s\\S]*?)\\};`))
    assertParity(match !== null, `GPUWeb enum ${enumName} was not found`)
    const enumBody = stripBikeshedComments(match[1])
    return [ ...new Set(
        [ ...enumBody.matchAll(/"([^"]+)"/g) ].map(value => value[1])
    ) ].sort()
}

function stripBikeshedComments(source) {

    return source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '')
}

async function prepareProductionBootstrap() {

    const distRoot = path.resolve('packages/geoscratch/dist')
    const reason = acceptanceMode
        ? 'acceptance'
        : fs.existsSync(distRoot)
            ? 'dist-present'
            : 'dist-missing'
    if (reason === 'dist-present') {
        return Object.freeze({
            status: 'not-needed',
            reason,
        })
    }

    const serverPreflight = await auditManagedServerEndpoint('http://127.0.0.1:4173')
    if (serverPreflight.status === 'failed') {
        return Object.freeze({
            status: 'failed',
            reason,
            serverPreflight,
        })
    }

    const productionBootstrapBuild = runCommandGate('npm', [
        '--workspace',
        'geoscratch',
        'run',
        'build',
    ])
    return Object.freeze({
        status: productionBootstrapBuild.status,
        reason,
        serverPreflight,
        productionBootstrapBuild,
    })
}

async function runAcceptanceEvidence(testFiles, contracts, productionBootstrap) {

    const managedBaseUrl = 'http://127.0.0.1:4173'
    const unavailableBrowserBaseUrl = 'http://127.0.0.1:65534'
    const serverPreflight = await auditManagedServerEndpoint(managedBaseUrl)
    if (serverPreflight.status === 'failed') {
        return Object.freeze({
            serverPreflight,
            status: 'failed',
        })
    }

    const typecheck = runCommandGate('npm', [ 'run', 'typecheck' ])
    const build = runCommandGate('npm', [ 'run', 'build' ])
    const diffCheck = runCommandGate('git', [ 'diff', '--check' ])
    const commandGates = Object.freeze({
        productionBootstrapBuild: productionBootstrap.productionBootstrapBuild,
        typecheck,
        build,
        diffCheck,
        status: [
            productionBootstrap.productionBootstrapBuild,
            typecheck,
            build,
            diffCheck,
        ].every(gate => gate?.status === 'passed')
            ? 'passed'
            : 'failed',
    })
    if (commandGates.status === 'failed') {
        return Object.freeze({
            serverPreflight,
            commandGates,
            status: 'failed',
        })
    }

    const browserEvidence = await withManagedExamplesServer(
        managedBaseUrl,
        () => Object.freeze({
            ...runBrowserAcceptance(managedBaseUrl),
            negativeBrowserTarget: runNegativeBrowserTargetProbe(unavailableBrowserBaseUrl),
        })
    )
    const { browser, exampleMatrix, negativeBrowserTarget, server } = browserEvidence

    const focusedTestFiles = testFiles.map(file => `tests/${file}`)
    const mochaReport = runMochaJson(focusedTestFiles)
    const passedTitles = mochaReport.passes.map(test => test.title)
    const requiredTitles = contracts.flatMap(contract => contract.requiredNames)
    const missingRequiredTitles = difference(requiredTitles, passedTitles)
    const mocha = Object.freeze({
        status: mochaReport.stats.tests === expectedFocusedAcceptancePasses &&
            mochaReport.stats.passes === expectedFocusedAcceptancePasses &&
            mochaReport.stats.failures === 0 &&
            mochaReport.stats.pending === 0 &&
            missingRequiredTitles.length === 0
            ? 'passed'
            : 'failed',
        tests: mochaReport.stats.tests,
        passes: mochaReport.stats.passes,
        failures: mochaReport.stats.failures,
        pending: mochaReport.stats.pending,
        durationMs: mochaReport.stats.duration,
        files: focusedTestFiles,
        missingRequiredTitles,
    })

    const fullSuiteFiles = listFiles('tests')
        .filter(file => file.endsWith('.test.js'))
        .sort()
    const fullSuiteReport = runMochaJson(fullSuiteFiles)
    const pendingIdentities = fullSuiteReport.pending
        .map(mochaTestIdentity)
        .sort((left, right) => testIdentityKey(left).localeCompare(testIdentityKey(right)))
    const fullSuite = Object.freeze({
        status: fullSuiteReport.stats.tests === expectedFullSuiteTests &&
            fullSuiteReport.stats.passes === expectedFullSuitePasses &&
            fullSuiteReport.stats.failures === 0 &&
            fullSuiteReport.stats.pending === expectedFullSuitePending &&
            JSON.stringify(pendingIdentities) === JSON.stringify(expectedFullSuitePendingIdentities)
            ? 'passed'
            : 'failed',
        tests: fullSuiteReport.stats.tests,
        passes: fullSuiteReport.stats.passes,
        failures: fullSuiteReport.stats.failures,
        pending: fullSuiteReport.stats.pending,
        durationMs: fullSuiteReport.stats.duration,
        files: fullSuiteFiles,
        pendingIdentities,
    })

    const stressReport = runJsonProgram('tests/stress/scratch-persistent-binding-views.mjs')
    const steadyStates = [ stressReport.firstSteadyState, stressReport.secondSteadyState ]
    const stressPassed = stressReport.verification?.status === 'passed' &&
        stressReport.environment?.iterationsPerSteadyState >= 20_000 &&
        steadyStates.every(phase =>
            phase.dynamicOffsetNameMapReads === 0 &&
            phase.snapshotSerializations === 0 &&
            phase.bindingOrderSorts === 0 &&
            phase.bindGroupIdentityChanges === 0 &&
            phase.nativeOffsetIdentityChanges === 0 &&
            phase.bindSetMutated === false
        ) &&
        stressReport.replacement?.concurrentPromiseShared === true &&
        stressReport.replacement?.generationAfter === stressReport.replacement?.generationBefore + 1 &&
        stressReport.replacement?.bindGroupsCreated === 1 &&
        stressReport.replacement?.textureViewsCreated === 1 &&
        stressReport.terminal?.pendingOperationCount === 0
    const stress = Object.freeze({
        status: stressPassed ? 'passed' : 'failed',
        iterationsPerSteadyState: stressReport.environment?.iterationsPerSteadyState,
        firstMicrosecondsPerCycle: stressReport.firstSteadyState?.microsecondsPerCycle,
        secondMicrosecondsPerCycle: stressReport.secondSteadyState?.microsecondsPerCycle,
        firstSteadyState: stressReport.firstSteadyState,
        replacement: stressReport.replacement,
        secondSteadyState: stressReport.secondSteadyState,
        terminal: stressReport.terminal,
    })
    const finalWorkingTree = workingTreeEvidence()
    const finalCommit = currentCommit()
    const finalRepository = Object.freeze({
        commit: finalCommit,
        workingTree: finalWorkingTree,
        status: finalCommit === auditTarget.commit && finalWorkingTree.clean
            ? 'passed'
            : 'failed',
        requirement: 'acceptance requires the same clean Git target after the complete execution sequence',
    })

    return Object.freeze({
        serverPreflight,
        commandGates,
        mocha,
        fullSuite,
        stress,
        browser,
        exampleMatrix,
        negativeBrowserTarget,
        server,
        finalRepository,
        status: commandGates.status === 'passed' &&
            [ browser, exampleMatrix, negativeBrowserTarget, mocha, fullSuite, stress ].every(
                entry => entry.status === 'passed'
            ) &&
            server.status === 'passed' &&
            finalRepository.status === 'passed'
            ? 'passed'
            : 'failed',
    })
}

function runCommandGate(command, args) {

    const startedAt = Date.now()
    const result = spawnSync(command, args, {
        cwd: process.cwd(),
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        env: {
            ...process.env,
            SCRATCH_FINAL_AUDIT: '0',
            SCRATCH_BINDING_BROWSER_GATE: '0',
        },
    })
    const stdout = result.stdout ?? ''
    const stderr = result.stderr ?? ''
    const passed = result.error === undefined && result.status === 0
    return Object.freeze({
        command: [ command, ...args ],
        status: passed ? 'passed' : 'failed',
        exitCode: result.status,
        signal: result.signal,
        durationMs: Date.now() - startedAt,
        stdoutSha256: sha256(stdout),
        stderrSha256: sha256(stderr),
        ...(passed ? {} : {
            error: result.error?.message,
            stdoutTail: stdout.slice(-4_096),
            stderrTail: stderr.slice(-4_096),
        }),
    })
}

function runBrowserAcceptance(baseUrl) {

    const browserReport = runJsonProgram('tests/browser/scratch-persistent-binding-views.mjs', {
        SCRATCH_BINDING_BROWSER_HEADLESS: '0',
        SCRATCH_BINDING_BROWSER_BASE_URL: baseUrl,
    })
    const browserPassed = browserReport.status === 'passed' &&
        browserReport.headless === false &&
        browserReport.failures.length === 0
    const browser = Object.freeze({
        status: browserPassed ? 'passed' : 'failed',
        headless: browserReport.headless,
        browserVersion: browserReport.browserVersion,
        baseUrl: browserReport.baseUrl,
        adapter: browserReport.adapter,
        probe: browserReport.probe,
        failures: browserReport.failures,
    })

    const matrixReport = runJsonProgram('tests/browser/scratch-readback-staging-mapping.mjs', {
        SCRATCH_READBACK_BROWSER_HEADLESS: '0',
        SCRATCH_READBACK_BROWSER_BASE_URL: baseUrl,
    })
    const matrixNames = matrixReport.examples.map(example => example.name)
    const matrixPassed = matrixReport.status === 'passed' &&
        matrixReport.headless === false &&
        matrixReport.failures.length === 0 &&
        matrixReport.examples.length === ordinaryExamples.length &&
        equalSets(matrixNames, ordinaryExamples) &&
        matrixReport.examples.every(example => example.failures.length === 0)
    const exampleMatrix = Object.freeze({
        status: matrixPassed ? 'passed' : 'failed',
        headless: matrixReport.headless,
        browserVersion: matrixReport.browserVersion,
        baseUrl: matrixReport.baseUrl,
        adapter: matrixReport.adapter,
        exampleCount: matrixReport.examples.length,
        examples: matrixReport.examples.map(example => Object.freeze({
            name: example.name,
            facts: example.facts,
            visual: example.visual,
            failures: example.failures,
        })),
        failures: matrixReport.failures,
    })

    return Object.freeze({ browser, exampleMatrix })
}

function runNegativeBrowserTargetProbe(baseUrl) {

    const startedAt = Date.now()
    const result = spawnSync(process.execPath, [
        path.resolve('tests/browser/scratch-persistent-binding-views.mjs'),
    ], {
        cwd: process.cwd(),
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        env: {
            ...process.env,
            SCRATCH_BINDING_BROWSER_HEADLESS: '0',
            SCRATCH_BINDING_BROWSER_BASE_URL: baseUrl,
        },
    })
    const stdout = result.stdout ?? ''
    const stderr = result.stderr ?? ''
    const combinedOutput = `${stdout}\n${stderr}`
    const connectionRefused = combinedOutput.includes('ERR_CONNECTION_REFUSED')
    const passed = result.error === undefined &&
        result.status !== null &&
        result.status !== 0 &&
        connectionRefused

    return Object.freeze({
        status: passed ? 'passed' : 'failed',
        baseUrl,
        exitCode: result.status,
        signal: result.signal,
        connectionRefused,
        durationMs: Date.now() - startedAt,
        stdoutSha256: sha256(stdout),
        stderrSha256: sha256(stderr),
        ...(passed ? {} : {
            error: result.error?.message,
            stdoutTail: stdout.slice(-4_096),
            stderrTail: stderr.slice(-4_096),
        }),
    })
}

async function auditManagedServerEndpoint(baseUrl) {

    const endpoint = new URL(baseUrl)
    const port = Number(endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80))
    const listening = await tcpEndpointIsOpen(endpoint.hostname, port)
    return Object.freeze({
        status: listening ? 'failed' : 'passed',
        mode: 'managed',
        baseUrl,
        portAvailableBeforeBuild: !listening,
    })
}

function tcpEndpointIsOpen(host, port) {

    return new Promise(resolve => {
        const socket = new Socket()
        let settled = false
        const settle = (value) => {
            if (settled) return
            settled = true
            socket.destroy()
            resolve(value)
        }
        socket.setTimeout(500)
        socket.once('connect', () => settle(true))
        socket.once('timeout', () => settle(false))
        socket.once('error', () => settle(false))
        socket.connect(port, host)
    })
}

async function withManagedExamplesServer(baseUrl, action) {

    const endpoint = new URL(baseUrl)
    const port = endpoint.port || (endpoint.protocol === 'https:' ? '443' : '80')
    const logs = { stdout: '', stderr: '' }
    const child = spawn(process.execPath, [
        path.resolve('node_modules/vite/bin/vite.js'),
        '--host',
        endpoint.hostname,
        '--port',
        port,
        '--strictPort',
    ], {
        cwd: path.resolve('examples'),
        detached: true,
        env: process.env,
        stdio: [ 'ignore', 'pipe', 'pipe' ],
    })
    child.stdout.on('data', chunk => {
        logs.stdout = boundedServerLog(logs.stdout, chunk)
    })
    child.stderr.on('data', chunk => {
        logs.stderr = boundedServerLog(logs.stderr, chunk)
    })

    const startedAt = Date.now()
    let readyAt
    let output
    let stop
    try {
        await waitForManagedServer(baseUrl, child, logs)
        readyAt = Date.now()
        output = action(baseUrl)
    } finally {
        stop = await stopManagedServer(child)
    }

    return Object.freeze({
        ...output,
        server: Object.freeze({
            status: stop.status === 'passed' ? 'passed' : 'failed',
            mode: 'managed',
            baseUrl,
            startupDurationMs: readyAt - startedAt,
            lifecycleDurationMs: Date.now() - startedAt,
            stdoutSha256: sha256(logs.stdout),
            stderrSha256: sha256(logs.stderr),
            stop,
        }),
    })
}

function boundedServerLog(current, chunk) {

    return `${current}${String(chunk)}`.slice(-16_384)
}

async function waitForManagedServer(baseUrl, child, logs) {

    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(
                `Managed examples server exited before readiness (${child.exitCode}).\n${logs.stderr}`
            )
        }
        try {
            const response = await fetch(`${baseUrl}/helloTriangle/index.html`)
            await response.arrayBuffer()
            if (response.ok) return
        } catch {
            // The strict-port child is still starting.
        }
        await delay(200)
    }
    throw new Error(`Managed examples server did not become ready.\n${logs.stderr}`)
}

async function stopManagedServer(child) {

    if (child.exitCode !== null) {
        return Object.freeze({
            status: child.exitCode === 0 ? 'passed' : 'failed',
            exitCode: child.exitCode,
            signal: child.signalCode,
        })
    }

    const exit = new Promise(resolve => {
        child.once('exit', (exitCode, signal) => resolve({ exitCode, signal }))
    })
    try {
        process.kill(-child.pid, 'SIGTERM')
    } catch {
        child.kill('SIGTERM')
    }
    let result = await Promise.race([ exit, delay(5_000).then(() => undefined) ])
    if (result === undefined) {
        try {
            process.kill(-child.pid, 'SIGKILL')
        } catch {
            child.kill('SIGKILL')
        }
        result = await exit
    }
    return Object.freeze({
        status: result.signal === 'SIGTERM' || result.signal === 'SIGKILL' || result.exitCode === 0
            ? 'passed'
            : 'failed',
        exitCode: result.exitCode,
        signal: result.signal,
    })
}

function delay(milliseconds) {

    return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function runMochaJson(testFiles) {
    const output = execFileSync(process.execPath, [
        path.resolve('node_modules/mocha/bin/mocha.js'),
        ...testFiles,
        '--reporter',
        'json',
        '--timeout',
        '120000',
    ], {
        cwd: process.cwd(),
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        env: {
            ...process.env,
            SCRATCH_FINAL_AUDIT: '0',
            SCRATCH_BINDING_BROWSER_GATE: '0',
        },
    })
    return JSON.parse(output)
}

function mochaTestIdentity(test) {
    const file = typeof test?.file === 'string'
        ? path.relative(process.cwd(), test.file).split(path.sep).join('/')
        : ''
    return Object.freeze({
        file,
        fullTitle: typeof test?.fullTitle === 'string' ? test.fullTitle : '',
    })
}

function testIdentityKey(identity) {

    return `${identity.file}\u0000${identity.fullTitle}`
}

function runJsonProgram(program, additionalEnvironment = {}) {
    const output = execFileSync(process.execPath, [ path.resolve(program) ], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, ...additionalEnvironment },
    })
    return JSON.parse(output)
}

function auditExamples() {
    const failures = []
    const directories = fs.readdirSync('examples', { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
    const runnable = directories.filter(name =>
        fs.existsSync(`examples/${name}/index.html`) && fs.existsSync(`examples/${name}/main.js`)
    ).sort()
    const expectedRunnable = [ ...ordinaryExamples, ...legacyExamples ].sort()
    if (!equalSets(runnable, expectedRunnable)) failures.push('runnable example inventory drifted')

    for (const name of ordinaryExamples) {
        const source = fs.readFileSync(`examples/${name}/main.js`, 'utf8')
        if (!/from\s+['"]geoscratch['"]/.test(source)) failures.push(`${name} does not import geoscratch`)
        if (source.includes('packages/geoscratch/src') || source.includes('../packages/')) {
            failures.push(`${name} reaches into library source`)
        }
        if (/getBindGroup\(|\.createView\(|new\s+(?:BindLayout|BindSet|SamplerResource|QuerySetResource)\b/.test(source)) {
            failures.push(`${name} uses a removed persistent binding API`)
        }
    }

    const browser = fs.readFileSync('examples/index.html', 'utf8')
    for (const name of legacyExamples) {
        const match = browser.match(new RegExp(`data-id="${name}"[\\s\\S]*?<\\/a>`))?.[0] ?? ''
        if (!match.includes('(legacy)')) failures.push(`${name} lacks legacy label`)
    }
    if (directories.some(name => name.startsWith('scratch_'))) failures.push('scratch-prefixed example remains')
    if (directories.some(name => /hello.?map/i.test(name))) failures.push('Hello Map was restored')
    if (!directories.includes('m_demLayer') || !directories.includes('m_flowLayer')) {
        failures.push('DEM and Flow are not separate examples')
    }
    const targetAudit = fs.readFileSync('tests/scratch-examples-target-api.test.js', 'utf8')
    if (!targetAudit.includes('uses only persistent binding views and Promise-only supporting factories')) {
        failures.push('ordinary example AST target audit is missing')
    }

    return Object.freeze({
        ordinary: ordinaryExamples,
        legacy: legacyExamples,
        runnable,
        demFlowSeparate: true,
        helloMapAbsent: true,
        failures,
        status: failures.length === 0 ? 'passed' : 'failed',
    })
}

function loadSourcesAt(commit, paths) {
    return Object.fromEntries(Object.entries(paths).map(([ name, path ]) => [
        name,
        gitShow(commit, path),
    ]))
}

function loadCurrentSources(paths) {
    return Object.fromEntries(Object.entries(paths).map(([ name, path ]) => [
        name,
        fs.readFileSync(path, 'utf8'),
    ]))
}

function loadCurrentScratchTree() {
    return Object.fromEntries(listFiles('packages/geoscratch/src/scratch')
        .filter(path => /\.(?:ts|js)$/.test(path) || path.endsWith('.d.ts'))
        .map(path => [ path, fs.readFileSync(path, 'utf8') ]))
}

function loadGitScratchTree(commit) {
    const files = execFileSync(
        'git',
        [ 'ls-tree', '-r', '--name-only', commit, 'packages/geoscratch/src/scratch' ],
        { encoding: 'utf8' }
    ).trim().split('\n').filter(Boolean)
    return Object.fromEntries(files
        .filter(path => /\.(?:ts|js)$/.test(path) || path.endsWith('.d.ts'))
        .map(path => [ path, gitShow(commit, path) ]))
}

function listFiles(directory) {
    const files = []
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const path = `${directory}/${entry.name}`
        if (entry.isDirectory()) files.push(...listFiles(path))
        else files.push(path)
    }
    return files
}

function gitShow(commit, path) {
    return execFileSync('git', [ 'show', `${commit}:${path}` ], { encoding: 'utf8' })
}

function assertAncestor(commit) {
    try {
        execFileSync('git', [ 'merge-base', '--is-ancestor', commit, 'HEAD' ])
    } catch {
        throw new Error(`Goal baseline ${commit} is not an ancestor of HEAD.`)
    }
}

function assertCommit(commit) {
    try {
        execFileSync('git', [ 'cat-file', '-e', `${commit}^{commit}` ])
    } catch {
        throw new Error(`Historical JavaScript commit ${commit} is unavailable.`)
    }
}

function currentCommit() {
    return execFileSync('git', [ 'rev-parse', 'HEAD' ], { encoding: 'utf8' }).trim()
}

function workingTreeEvidence() {

    const porcelain = execFileSync(
        'git',
        [ 'status', '--porcelain=v1', '--untracked-files=all' ],
        { encoding: 'utf8' }
    )
    const entries = Object.freeze(porcelain.split('\n').filter(Boolean))
    return Object.freeze({
        clean: entries.length === 0,
        porcelainSha256: sha256(porcelain),
        entries,
    })
}

function exportNames(source, mode) {
    const names = new Set()
    const file = parseSource(source, mode === 'type' ? 'exports.d.ts' : 'exports.ts')
    for (const statement of file.statements) {
        if (ts.isExportDeclaration(statement) && statement.exportClause !== undefined) {
            if (!ts.isNamedExports(statement.exportClause)) continue
            for (const element of statement.exportClause.elements) {
                const itemIsType = statement.isTypeOnly || element.isTypeOnly
                if ((mode === 'type') === itemIsType) names.add(element.name.text)
            }
            continue
        }
        if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue
        const declarationName = namedDeclarationText(statement)
        if (declarationName === undefined) continue
        const typeDeclaration = ts.isInterfaceDeclaration(statement) ||
            ts.isTypeAliasDeclaration(statement)
        const valueDeclaration = ts.isClassDeclaration(statement) ||
            ts.isEnumDeclaration(statement) ||
            ts.isFunctionDeclaration(statement) ||
            ts.isModuleDeclaration(statement)
        if (mode === 'type' && (typeDeclaration || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement))) {
            names.add(declarationName)
        }
        if (mode === 'value' && valueDeclaration) names.add(declarationName)
        if (mode === 'value' && ts.isVariableStatement(statement)) {
            for (const declaration of statement.declarationList.declarations) {
                if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text)
            }
        }
    }
    return [ ...names ].sort()
}

function exportedTypeNames(source) {
    return exportNames(source, 'type')
}

function publicExportNames(source) {
    return [ ...new Set([
        ...exportNames(source, 'value'),
        ...exportedTypeNames(source),
    ]) ].sort()
}

function diagnosticCodes(source) {
    return [ ...new Set(source.match(/SCRATCH_[A-Z0-9_]+/g) ?? []) ].sort()
}

function extractStringSet(source, name) {
    const file = parseSource(source, 'binding.ts')
    let values = []
    walk(file, node => {
        if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || node.name.text !== name) return
        const initializer = node.initializer
        if (
            initializer === undefined ||
            !ts.isNewExpression(initializer) ||
            !ts.isIdentifier(initializer.expression) ||
            initializer.expression.text !== 'Set' ||
            initializer.arguments === undefined ||
            !ts.isArrayLiteralExpression(initializer.arguments[0])
        ) return
        values = initializer.arguments[0].elements
            .filter(ts.isStringLiteralLike)
            .map(element => element.text)
    })
    return values
}

function publicClassMemberInventory(tree) {
    const entries = []
    for (const [ fileName, source ] of Object.entries(tree)) {
        const file = parseSource(source, fileName)
        walk(file, node => {
            if (
                !ts.isClassDeclaration(node) ||
                node.name === undefined ||
                !hasModifier(node, ts.SyntaxKind.ExportKeyword)
            ) return
            for (const member of node.members) {
                const kind = ts.isMethodDeclaration(member)
                    ? 'method'
                    : ts.isGetAccessorDeclaration(member)
                        ? 'get'
                        : ts.isSetAccessorDeclaration(member)
                            ? 'set'
                            : ts.isPropertyDeclaration(member)
                                ? 'property'
                                : ts.isConstructorDeclaration(member)
                                    ? 'constructor'
                                    : undefined
                if (
                    kind === undefined ||
                    hasModifier(member, ts.SyntaxKind.PrivateKeyword) ||
                    hasModifier(member, ts.SyntaxKind.ProtectedKeyword) ||
                    ('name' in member && member.name !== undefined &&
                        ts.isPrivateIdentifier(member.name))
                ) continue
                const memberName = kind === 'constructor'
                    ? 'constructor'
                    : propertyNameText(member.name, file)
                if (memberName === undefined) continue
                const staticPrefix = hasModifier(member, ts.SyntaxKind.StaticKeyword) ? 'static.' : ''
                entries.push(Object.freeze({
                    id: `${node.name.text}.${staticPrefix}${memberName}:${kind}`,
                    className: node.name.text,
                    memberName,
                    kind,
                    static: staticPrefix.length > 0,
                    signature: classMemberSignature(member, file),
                    file: fileName,
                }))
            }
        })
    }
    const grouped = new Map()
    for (const entry of entries) {
        const current = grouped.get(entry.id)
        if (current === undefined) {
            grouped.set(entry.id, { ...entry, signatures: [ entry.signature ] })
        } else {
            current.signatures.push(entry.signature)
        }
    }
    return [ ...grouped.values() ]
        .map(entry => Object.freeze({
            ...entry,
            signatures: undefined,
            signature: [ ...new Set(entry.signatures) ].sort().join(' || '),
        }))
        .sort((left, right) => left.id.localeCompare(right.id))
}

function classMemberSignature(member, file) {
    const flags = [
        hasModifier(member, ts.SyntaxKind.StaticKeyword) ? 'static' : undefined,
        hasModifier(member, ts.SyntaxKind.ReadonlyKeyword) ? 'readonly' : undefined,
        'questionToken' in member && member.questionToken !== undefined ? 'optional' : undefined,
        hasModifier(member, ts.SyntaxKind.AbstractKeyword) ? 'abstract' : undefined,
    ].filter(Boolean).join(' ')
    if (ts.isPropertyDeclaration(member)) {
        return `${flags}|${normalizedNodeText(member.type, file, 'implicit')}`
    }
    const typeParameters = 'typeParameters' in member
        ? member.typeParameters?.map(parameter => normalizedNodeText(parameter, file)).join(',') ?? ''
        : ''
    const parameters = 'parameters' in member
        ? member.parameters.map(parameter => parameterSignature(parameter, file)).join(',')
        : ''
    const returnType = ts.isConstructorDeclaration(member) || ts.isSetAccessorDeclaration(member)
        ? 'void'
        : normalizedNodeText(member.type, file, 'implicit')
    return `${flags}|<${typeParameters}>(${parameters}):${returnType}`
}

function parameterSignature(parameter, file) {
    const flags = [
        parameter.dotDotDotToken === undefined ? undefined : '...',
        hasModifier(parameter, ts.SyntaxKind.ReadonlyKeyword) ? 'readonly ' : undefined,
    ].filter(Boolean).join('')
    const optional = parameter.questionToken !== undefined || parameter.initializer !== undefined
        ? '?'
        : ''
    return `${flags}${normalizedNodeText(parameter.name, file)}${optional}:` +
        normalizedNodeText(parameter.type, file, 'implicit')
}

function normalizedNodeText(node, file, fallback = '') {
    return node === undefined ? fallback : node.getText(file).replace(/\s+/g, ' ').trim()
}

function assignedPropertiesInFunction(source, functionName, receiverName) {
    const file = parseSource(source, 'binding.ts')
    const properties = []
    walk(file, node => {
        if (!ts.isFunctionDeclaration(node) || node.name?.text !== functionName || node.body === undefined) return
        walk(node.body, child => {
            if (
                !ts.isBinaryExpression(child) ||
                child.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
                !ts.isPropertyAccessExpression(child.left) ||
                !ts.isIdentifier(child.left.expression) ||
                child.left.expression.text !== receiverName
            ) return
            properties.push(child.left.name.text)
        })
    })
    return [ ...new Set(properties) ].sort()
}

function propertyCallsInClass(source, className, receiverName) {
    const file = parseSource(source, 'command.ts')
    const calls = []
    walk(file, node => {
        if (!ts.isClassDeclaration(node) || node.name?.text !== className) return
        walk(node, child => {
            if (!ts.isCallExpression(child) || !ts.isPropertyAccessExpression(child.expression)) return
            if (
                receiverName !== undefined &&
                (!ts.isIdentifier(child.expression.expression) ||
                    child.expression.expression.text !== receiverName)
            ) return
            calls.push(child.expression.name.text)
        })
    })
    return calls.sort()
}

function behaviorTestContract(file, requiredNames) {
    const exists = fs.existsSync(file)
    const actualNames = exists ? testCaseNames(fs.readFileSync(file, 'utf8'), file) : []
    const missing = difference(requiredNames, actualNames)
    return Object.freeze({
        file,
        requiredNames,
        missing,
        status: exists && missing.length === 0 ? 'passed' : 'failed',
    })
}

function testCaseNames(source, fileName) {
    const file = parseSource(source, fileName)
    const names = []
    walk(file, node => {
        if (
            !ts.isCallExpression(node) ||
            !ts.isIdentifier(node.expression) ||
            node.expression.text !== 'it' ||
            !ts.isStringLiteralLike(node.arguments[0])
        ) return
        names.push(node.arguments[0].text)
    })
    return names.sort()
}

function testCaseSource(source, fileName, title) {

    const file = parseSource(source, fileName)
    let result = ''
    walk(file, node => {
        if (
            result !== '' ||
            !ts.isCallExpression(node) ||
            !ts.isIdentifier(node.expression) ||
            node.expression.text !== 'it' ||
            !ts.isStringLiteralLike(node.arguments[0]) ||
            node.arguments[0].text !== title
        ) return
        result = node.getText(file)
    })
    return result
}

function parseSource(source, fileName) {
    const scriptKind = fileName.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS
    return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind)
}

function walk(node, visitor) {
    visitor(node)
    ts.forEachChild(node, child => walk(child, visitor))
}

function hasModifier(node, kind) {
    return node.modifiers?.some(modifier => modifier.kind === kind) ?? false
}

function namedDeclarationText(node) {
    return 'name' in node && node.name !== undefined && ts.isIdentifier(node.name)
        ? node.name.text
        : undefined
}

function propertyNameText(name, file) {
    if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
        return name.text
    }
    return ts.isComputedPropertyName(name) ? name.expression.getText(file) : undefined
}

function hasAll(source, markers) {
    return markers.every(marker => source.includes(marker))
}

function difference(left, right) {
    const rightSet = new Set(right)
    return [ ...left ].filter(value => !rightSet.has(value)).sort()
}

function equalSets(left, right) {
    return JSON.stringify([ ...new Set(left) ].sort()) ===
        JSON.stringify([ ...new Set(right) ].sort())
}

function sha256(value) {
    return createHash('sha256').update(value).digest('hex')
}

function failedRows(rows) {
    return rows
        .filter(row => row.status !== 'passed')
        .map(row => JSON.stringify({
            name: row.id ?? row.name,
            goalStart: row.goalStart,
            historical: row.historical,
            final: row.final,
            expected: row.expected,
            actual: row.actual,
            missingDeclarationValues: row.missingDeclarationValues,
            extraDeclarationValues: row.extraDeclarationValues,
            missingDeclarationTypes: row.missingDeclarationTypes,
            extraDeclarationTypes: row.extraDeclarationTypes,
        }))
        .join(', ')
}

function assertParity(condition, message) {
    if (!condition) throw new Error(message)
}
