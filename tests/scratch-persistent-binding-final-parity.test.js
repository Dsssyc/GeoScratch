import { expect } from 'chai'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const runner = path.join(root, 'tests', 'audits', 'scratch-persistent-binding-views-final-parity.mjs')
const review = path.join(root, 'docs', 'review', 'scratch-persistent-binding-views-final-audit.md')
const goalBaseline = '26c6d8875caea7612e573dfb4e33e1340a016d46'
const historicalJavaScript = '20bb393df570ff1914a6789e9bd422d59ddfecc8'

describe('Scratch persistent binding final parity', () => {

    it('locks the fixed baselines, official capability matrix, and final review contract', () => {

        const source = fs.readFileSync(runner, 'utf8')
        const audit = fs.readFileSync(review, 'utf8')
        const browserGate = fs.readFileSync(
            path.join(root, 'tests', 'scratch-persistent-binding-browser.test.js'),
            'utf8'
        )

        for (const marker of [
            goalBaseline,
            historicalJavaScript,
            'https://gpuweb.github.io/gpuweb/#resource-binding',
            'https://gpuweb.github.io/gpuweb/#texture-view-creation',
            'https://gpuweb.github.io/gpuweb/#copies',
            'https://gpuweb.github.io/gpuweb/#query-sets',
            'https://raw.githubusercontent.com/gpuweb/gpuweb/main/spec/sections/copies.bs',
            'copyBufferToBuffer',
            'copyTextureToTexture',
            'copyBufferToTexture',
            'copyTextureToBuffer',
            'externalTextureBoundary',
            'historicalTypeInventory',
            'publicClassMemberInventory',
            'goalStartPublicMemberReplacements',
            'goalStartChangedPublicMemberReplacements',
            'RenderPassSpec.createRenderPassDescriptor:method',
            'emitCurrentProductionOutputs',
            'auditProductionEmit',
            'typeAliasStringUnion',
            'auditVisionDiagnosticDocumentation',
            'legacyLayoutDecisionUsesCurrentReplacement',
            'fetchOfficialSpecificationEvidence',
            'stripBikeshedComments',
            'runAcceptanceEvidence',
            'workingTreeEvidence',
            'acceptance requires a clean Git working tree',
            'acceptance requires the same clean Git target after the complete execution sequence',
            'runNegativeBrowserTargetProbe',
            'negativeBrowserTarget',
            'ERR_CONNECTION_REFUSED',
            'finalRepository',
            'officialWebIdlSource',
            'clampedUnsignedShort',
            'nearestEvenInteger',
            'const expectedFocusedAcceptancePasses = 406',
            'const expectedFullSuitePasses = 829',
            'const expectedFullSuitePending = 2',
            'const expectedFullSuitePendingIdentities',
            'propertyCallsInClass',
            'behaviorTestContract',
            'claims each canvas context exclusively until the owning Surface is disposed',
            'releases an uncommitted canvas-context claim after configure fails',
            'rolls back logical and canvas facts after synchronous reconfigure failure',
            'rejects forged Surface aliases before lifecycle or presentation effects',
            'releases the privately claimed context after public identity and lifecycle drift',
            'rejects external canvas-context drift before borrowing a current texture',
            'releases Surface ownership even when native unconfigure fails',
            'continues runtime cleanup after Surface unconfigure fails',
            'rejects a non-owner Surface alias before presentation effects',
            'SCRATCH_SURFACE_CONTEXT_IN_USE',
            'SCRATCH_SURFACE_CONTEXT_NOT_OWNED',
            'SCRATCH_SURFACE_CONFIGURATION_FAILED',
            'SCRATCH_SURFACE_CONFIGURATION_STALE',
            'SCRATCH_SURFACE_UNCONFIGURE_FAILED',
            'surfaceContextOwners',
            'ADR-039-scratch-exclusive-surface-context-ownership.md',
            'requires read-write storage buffers in both read and write declarations',
            'rejects empty read-write storage buffers during submission readiness validation',
            'allows equal multisample texture copies only on core devices',
            'requires full physical subresources for depth-stencil texture copies',
            'allows compressed texture copies only on core devices',
            'uses physical block-aligned mip extents for compressed texture copies',
            'copies every native color texel-block footprint between buffers and textures',
            'applies native depth-stencil aspect footprints and direction limits',
            'rejects invalid copy ranges and every same-buffer copy',
            'creates complete immutable TextureViewSpecs and preflights usage capabilities without native views',
            'settles scopes and preserves causal failures across lifecycle changes',
            'rejects noncanonical raw resource descriptor integers before native issue',
            'rejects color attachment metadata and surface view descriptor divergence',
            'rejects invalid TextureResource attachment views and transient operations',
            'rejects overlapping color attachment regions while permitting disjoint 3d slices',
            'rejects depth-stencil formats in color attachment slots before encoder creation',
            'rejects invalid depth attachment views, clear values, and transient operations',
            'rejects invalid, unaligned, and disposed uploads with structured diagnostics',
            'rejects invalid descriptors and unaligned regions with structured diagnostics',
            'revalidates readback source usage against replacement allocations before staging copy effects',
            'revalidates query resolve usage against replacement allocations before encoder effects',
            'revalidates every fixed-function buffer usage against replacement allocations before encoder effects',
            'rejects unaligned direct readback regions before staging allocation',
            'rejects invalid and unaligned vertex buffer bindings with structured diagnostics',
            'defaults depth clear to one and accepts inclusive unit-range boundaries',
            'retains lifecycle recheck as secondary evidence beside a native preparation failure',
            'revalidates buffer bounds, usage, and alignment before binding a replacement allocation',
            'revalidates every buffer copy source region against replacement bounds before encoder effects',
            'revalidates a persistent 3d attachment depthSlice after allocation replacement',
            'accepts native-valid depth-only pipelines and render passes',
            'normalizes only complete finite GPUColor values before encoder creation',
            'accepts the GPUStencilValue maximum and rejects larger values before encoding',
            'enforces GPUSize32 bounds for both native buffer-texture copy layouts',
            'describes only BufferRegion-based copy shapes in structured diagnostics',
            'enforces GPUSize32 bounds for texture upload row layouts',
            'runCommandGate',
            'withManagedExamplesServer',
            'scratch-readback-staging-mapping.mjs',
            'pipelineLayoutGroupIndex',
            'pipelineLayoutAggregateBindingLimits',
            'bufferCopyDistinctResources',
            'textureViewTransientUsage',
            'textureViewRenderableFormat',
            'textureViewStorageFormat',
            'renderableTextureViewUsage',
            'transientColorAttachmentOperations',
            'transientDepthAttachmentOperations',
            'depthClearUnitRange',
            'writeBufferContentsAlignment',
            'writeBufferOffsetAlignment',
            'vertexBufferOffsetAlignment',
            'bufferCopyOffsetAndSizeAlignment',
            'gpuSizeAndCoordinateEnforceRange',
            'gpuSize32EnforceRange',
            'gpuStencilValueEnforceRange',
            'completeFiniteGpuColorShape',
            'renderPipelineAttachmentPresence',
            'renderPassAttachmentPresence',
            'renderAttachmentDepthSlice',
            'colorAttachmentRenderableFormat',
            'pairwiseColorAttachmentRegions',
            'canvasContextGetConfiguration',
            'canvasConfigureCommitsConfiguration',
            'canvasUnconfigureClearsConfiguration',
            'depthStencilFullPhysicalSubresource',
            'compatibilityCompressedTextureRestriction',
            'wholeTexelBlockCopies',
            'rowsPerImageUsesBlockRows',
            'linearCopyUsesBlockFootprint',
            'depthStencilSingleAspect',
            'depthStencilBufferOffsetAlignment',
            'depthStencilCopyCapabilityTable',
            'textureToBufferCompatibilityCompressedRestriction',
            'textureFormatParity',
            'schemaVersion: 5',
            'ordinaryExampleCount: ordinaryExamples.length',
            'legacyExampleCount: legacyExamples.length',
        ]) {
            expect(source, marker).to.include(marker)
        }
        expect(source).not.to.include('SCRATCH_FINAL_AUDIT_NEGATIVE_BROWSER_BASE_URL')
        expect(source).not.to.include('negativeBrowserBaseUrl')
        expect(source).not.to.include("status: 'external'")
        expect(source).not.to.include('const explicitBaseUrl')

        for (const marker of [
            'Goal-start TypeScript behavior and public symbols',
            'Historical JavaScript feature inventory',
            'Target clean-cut behavior',
            'Intentional breaking replacement',
            '20,000 + 20,000',
            'Chrome 150.0.7871.115',
            'Apple Metal 3',
            '11 ordinary examples',
            '3 legacy examples',
            '`externalTexture`',
            'Fresh-Context Strict Review',
        ]) {
            expect(audit, marker).to.include(marker)
        }
        expect(browserGate).to.include("process.env.SCRATCH_BINDING_BROWSER_GATE !== '1') this.skip()")
        expect(browserGate).to.include('execFileSync(process.execPath, [ runner ]')
    })

    it('runs the fixed-history structural audit without claiming acceptance', function() {

        this.timeout(120_000)
        if (!commitAvailable(goalBaseline) || !commitAvailable(historicalJavaScript)) this.skip()

        const output = execFileSync(process.execPath, [ runner ], {
            cwd: root,
            encoding: 'utf8',
            env: {
                ...process.env,
                SCRATCH_FINAL_AUDIT: '0',
            },
        })
        const result = JSON.parse(output)

        expect(result.baseline).to.equal(goalBaseline)
        expect(result.historicalJavaScript).to.equal(historicalJavaScript)
        expect(result.target).to.deep.include({
            commit: execFileSync('git', [ 'rev-parse', 'HEAD' ], {
                cwd: root,
                encoding: 'utf8',
            }).trim(),
        })
        expect(result.target.workingTree.clean)
            .to.equal(result.target.workingTree.entries.length === 0)
        expect(result.target.workingTree.porcelainSha256).to.match(/^[a-f0-9]{64}$/)
        expect(result.verification).to.deep.include({
            mode: 'structural',
            status: 'incomplete',
            capabilityRowCount: 11,
            officialBindingRowCount: 6,
            nativeCopyQuadrantCount: 4,
            ordinaryExampleCount: 11,
            legacyExampleCount: 3,
        })
        expect(result.publicSurface.missingBaselineValues).to.deep.equal([])
        expect(result.publicSurface.missingHistoricalValues).to.deep.equal([])
        expect(result.publicSurface.historicalTypeInventory).to.have.length(18)
        expect(result.publicSurface.historicalTypeInventory.every(entry => entry.status === 'passed')).to.equal(true)
        expect(result.publicSurface.publicMemberParity).to.deep.include({
            goalStartCount: 357,
            finalCount: 378,
            status: 'passed',
        })
        expect(result.publicSurface.publicMemberParity.missingGoalStart).to.have.length(21)
        expect(result.publicSurface.publicMemberParity.changedGoalStart).to.have.length(10)
        expect(result.publicSurface.productionEmitParity).to.deep.include({
            status: 'passed',
            emittedJavaScriptCount: 102,
            emittedDeclarationCount: 102,
        })
        expect(result.publicSurface.productionEmitParity.files).to.have.length(204)
        expect(result.publicSurface.productionEmitParity.files.every(entry => entry.exactMatch)).to.equal(true)
        expect(result.diagnostics).to.deep.include({ schemaVersion: 5 })
        expect(result.diagnostics.unexpectedMissing).to.deep.equal([])
        expect(result.officialBindingMatrix.status).to.equal('passed')
        expect(result.officialBindingMatrix.nativeLowering.status).to.equal('passed')
        expect(result.officialBindingMatrix.externalTextureBoundary.intentionallyExcluded).to.equal(true)
        expect(result.nativeCopyQuadrants.every(entry => (
            entry.status === 'passed' && entry.gpuSide && entry.astResolvedCallCount === 1
        ))).to.equal(true)
        expect(result.testEvidence.status).to.equal('passed')
        expect(result.executionEvidence.status).to.equal('not-run')
        expect(result.officialSpecificationEvidence.status).to.equal('not-run')
        expect(result.testEvidence.referencedFiles.every(entry => entry.exists)).to.equal(true)
        expect(result.testEvidence.behaviorContracts.every(entry => entry.status === 'passed')).to.equal(true)
        expect(result.examples).to.deep.include({
            status: 'passed',
            demFlowSeparate: true,
            helloMapAbsent: true,
        })
        expect(result.documentation.status).to.equal('passed')
        expect(result.documentation.resourceStateParity.status).to.equal('passed')
        expect(result.documentation.visionDiagnosticParity).to.deep.include({
            status: 'passed',
            unsupportedCodes: [],
            undocumentedCodes: [],
        })
        expect(result.documentation.visionDiagnosticParity.documentedCodes).to.have.length(
            result.documentation.visionDiagnosticParity.implementedCodeCount
        )
        expect(result.documentation.visionDiagnosticParity.rows).to.not.be.empty
        expect(result.documentation.visionDiagnosticParity.rows.every(
            entry => entry.status === 'passed'
        )).to.equal(true)
        expect(result.documentation.checks).to.deep.include({
            canonicalResourceDescriptors: true,
            supportingObjectCausality: true,
            nativeRegionAlignment: true,
            attachmentViewContracts: true,
            programExamplesUseBufferRegions: true,
            layoutCodecDiagnosticsCurrent: true,
            visionDiagnosticInventoryCurrent: true,
            storageBufferAccessCurrent: true,
            supersededLayoutDecisionsCurrent: true,
            obsoleteSubmissionAuditRemoved: true,
            activeReviewReferencesCurrentAudit: true,
        })
    })

    it('keeps every active document and audit on the final clean-cut contract', () => {

        const vision08 = fs.readFileSync(path.join(
            root,
            'docs',
            'vision',
            'scratch-api',
            '08-programs-codecs',
            'README.md'
        ), 'utf8')
        const vision08Zh = fs.readFileSync(path.join(
            root,
            'docs',
            'vision',
            'scratch-api',
            '08-programs-codecs',
            'README_zh.md'
        ), 'utf8')
        const vision09 = fs.readFileSync(path.join(
            root,
            'docs',
            'vision',
            'scratch-api',
            '09-diagnostics-validation',
            'README.md'
        ), 'utf8')
        const vision09Zh = fs.readFileSync(path.join(
            root,
            'docs',
            'vision',
            'scratch-api',
            '09-diagnostics-validation',
            'README_zh.md'
        ), 'utf8')

        for (const source of [ vision08, vision08Zh ]) {
            const bufferDescriptors = source.match(/scratch\.buffer\(\{[\s\S]*?\n\}\)/g) ?? []
            expect(bufferDescriptors).to.not.be.empty
            for (const descriptor of bufferDescriptors) {
                expect(descriptor).to.not.match(/\blayout\s*:/)
            }
            expect(source).to.include('.region({')
            expect(source).to.include('layout: pointCodec.artifact')
        }
        for (const source of [ vision09, vision09Zh ]) {
            expect(source).to.not.include('SCRATCH_CODEC_STRUCTURAL_HASH_MISMATCH')
            expect(source).to.not.include('SCRATCH_QUERY_INDEX_OUT_OF_RANGE')
            expect(source).to.include('SCRATCH_LAYOUT_ABI_MISMATCH')
            expect(source).to.include('SCRATCH_CODEC_SCHEMA_MISMATCH')
            expect(source).to.include('SCRATCH_QUERY_SLOT_INDEX_INVALID')
        }
        expectCurrentReplacementDecision(
            'ADR-008-scratch-buffer-layout-artifact-integration.md',
            'Superseded by ADR-036',
            [ '`BufferResource` is a raw container', 'BufferRegion', 'abiHash', 'schemaHash' ]
        )
        expectCurrentReplacementDecision(
            'ADR-009-scratch-program-layout-requirements.md',
            'Superseded in part by ADR-036',
            [ 'ProgramBufferLayoutRequirement', 'BufferRegion', 'abiHash', 'schemaHash' ]
        )
        expectCurrentReplacementDecision(
            'ADR-010-scratch-layout-aware-readback.md',
            'Superseded in part by ADR-036',
            [ 'BufferRegion', 'toLayoutView()', 'source region' ]
        )
        expect(fs.existsSync(path.join(
            root,
            'docs',
            'review',
            'scratch-submission-native-final-parity-audit.md'
        ))).to.equal(false)
        expect(fs.existsSync(path.join(
            root,
            'tests',
            'audits',
            'scratch-submission-native-final-parity.mjs'
        ))).to.equal(false)
    })

    it('executes every acceptance gate when final audit mode is enabled', function() {

        if (process.env.SCRATCH_FINAL_AUDIT !== '1') this.skip()
        this.timeout(600_000)

        const output = execFileSync(process.execPath, [ runner ], {
            cwd: root,
            encoding: 'utf8',
            env: {
                ...process.env,
                SCRATCH_FINAL_AUDIT: '1',
            },
        })
        const result = JSON.parse(output)

        expect(result.verification).to.deep.include({
            mode: 'acceptance',
            status: 'passed',
        })
        expect(result.target.workingTree).to.deep.include({
            clean: true,
            entries: [],
        })
        expect(result.officialSpecificationEvidence.status).to.equal('passed')
        expect(result.officialSpecificationEvidence.enumParity.every(entry => entry.status === 'passed')).to.equal(true)
        expect(result.officialSpecificationEvidence.textureFormatParity).to.deep.include({
            status: 'passed',
        })
        expect(result.executionEvidence).to.deep.include({ status: 'passed' })
        expect(result.executionEvidence.commandGates).to.deep.include({ status: 'passed' })
        expect(result.executionEvidence.commandGates.typecheck).to.deep.include({
            status: 'passed',
            exitCode: 0,
        })
        expect(result.executionEvidence.commandGates.build).to.deep.include({
            status: 'passed',
            exitCode: 0,
        })
        expect(result.executionEvidence.commandGates.diffCheck).to.deep.include({
            status: 'passed',
            exitCode: 0,
        })
        expect(result.executionEvidence.mocha).to.deep.include({
            status: 'passed',
            tests: 394,
            passes: 394,
            failures: 0,
            pending: 0,
        })
        expect(result.executionEvidence.fullSuite).to.deep.include({
            status: 'passed',
            tests: 819,
            passes: 817,
            failures: 0,
            pending: 2,
        })
        expect(result.executionEvidence.fullSuite.pendingIdentities).to.deep.equal([
            {
                file: 'tests/scratch-persistent-binding-browser.test.js',
                fullTitle: 'Scratch persistent binding browser gate executes the headed acceptance proof when the browser gate is enabled',
            },
            {
                file: 'tests/scratch-persistent-binding-final-parity.test.js',
                fullTitle: 'Scratch persistent binding final parity executes every acceptance gate when final audit mode is enabled',
            },
        ])
        expect(result.executionEvidence.stress).to.deep.include({
            status: 'passed',
            iterationsPerSteadyState: 20_000,
        })
        expect(result.executionEvidence.browser).to.deep.include({
            status: 'passed',
            headless: false,
        })
        expect(result.executionEvidence.exampleMatrix).to.deep.include({
            status: 'passed',
            headless: false,
            exampleCount: 11,
        })
        expect(result.executionEvidence.exampleMatrix.examples).to.have.length(11)
        expect(result.executionEvidence.server).to.deep.include({
            status: 'passed',
            mode: 'managed',
        })
        expect(result.executionEvidence.server.stop.status).to.equal('passed')
        expect(result.executionEvidence.negativeBrowserTarget).to.deep.include({
            status: 'passed',
            baseUrl: 'http://127.0.0.1:65534',
            connectionRefused: true,
        })
        expect(result.executionEvidence.negativeBrowserTarget.exitCode).to.not.equal(0)
        expect(result.executionEvidence.finalRepository).to.deep.include({
            status: 'passed',
            commit: result.target.commit,
        })
        expect(result.executionEvidence.finalRepository.workingTree).to.deep.include({
            clean: true,
            entries: [],
        })

    })
})

function commitAvailable(commit) {

    try {
        execFileSync('git', [ 'cat-file', '-e', `${commit}^{commit}` ], {
            cwd: root,
            stdio: 'ignore',
        })
        return true
    } catch {
        return false
    }
}

function decisionStatus(fileName) {

    const source = fs.readFileSync(path.join(root, 'docs', 'decisions', fileName), 'utf8')
    return source.match(/## Status\s+([^#]+)/)?.[1].trim() ?? ''
}

function expectCurrentReplacementDecision(fileName, status, markers) {

    const source = fs.readFileSync(path.join(root, 'docs', 'decisions', fileName), 'utf8')
    expect(decisionStatus(fileName)).to.include(status)
    expect(source).to.include('## Historical Decision')
    expect(source).to.include('## Current Replacement')
    expect(source).to.not.match(/^## Decision\s*$/m)
    for (const marker of markers) expect(source).to.include(marker)
}
