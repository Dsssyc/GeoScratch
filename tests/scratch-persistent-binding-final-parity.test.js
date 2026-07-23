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
            'programReadonlyPublicContracts',
            'programPipelineFactSnapshot',
            'runtimeProgramLifecycleAuthority',
            'runtimeAuthority',
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
            'prepareProductionBootstrap',
            'productionBootstrapBuild',
            'dist-missing',
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
            'const cleanThirtySixthReviewCheckpoint = \'4926648e8258fcb6a58e6746704c708beab611e6\'',
            'const cleanThirtySeventhReviewCheckpoint = \'3d5f4d73c64eb5cc1108cd26fa31fec546badb3d\'',
            'const cleanThirtyEighthReviewCheckpoint = \'c9cfad3decd3380c2d03509482b549d3275e1c1c\'',
            'const cleanThirtyNinthReviewCheckpoint = \'01f26da07ffb4fddd7c389cd388ea0c4307a09a6\'',
            'const cleanProgramFactSnapshotPredecessor = \'ae9986d4cc1d7edacccd7ba0b4e15cd58a38dfdf\'',
            'const expectedFocusedAcceptancePasses = 491',
            'const expectedFullSuitePasses = 889',
            'const expectedFullSuitePending = 2',
            'const expectedFullSuitePendingIdentities',
            'propertyCallsInClass',
            'behaviorTestContract',
            'const focusedAcceptanceTestFiles = [ ...new Set([',
            '...behaviorTestContracts.map(contract => contract.file.replace(/^tests\\//, \'\'))',
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
            'rejects a non-owner Surface alias before presentation effects',
            'rejects a forged Surface alias with shadowed public methods before pass effects',
            'performs the final Surface configuration read before encoder creation',
            'preserves native Surface usage, view format, color, and tone-mapping capabilities',
            'deep-locks normalized PassSpec attachments before reusable submission',
            'snapshots Surface attachment view descriptors when the PassSpec is created',
            'rejects identical compute timestamp write indices before encoder creation',
            'rejects identical render timestamp write indices before encoder creation',
            'rejects a disposed compute timestamp query set before encoder creation',
            'rejects a disposed render timestamp query set before attachment or encoder creation',
            'executes the documented all-aspect occlusion pass contract',
            'rejects a disposed render occlusion query set before attachment or encoder creation',
            'SCRATCH_SURFACE_CONTEXT_IN_USE',
            'SCRATCH_SURFACE_CONTEXT_NOT_OWNED',
            'SCRATCH_SURFACE_CONFIGURATION_FAILED',
            'SCRATCH_SURFACE_CONFIGURATION_STALE',
            'SCRATCH_SURFACE_UNCONFIGURE_FAILED',
            'surfaceContextOwners',
            'ADR-039-scratch-exclusive-surface-context-ownership.md',
            'ADR-040-scratch-lifecycle-authority-stamps.md',
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
            'rejects mipmapped one-dimensional textures before native issue',
            'rejects render-attachment one-dimensional textures',
            'oneDimensionalTextureMipmapRestriction',
            'oneDimensionalMaximumMipLevelCount',
            'compatibilityBoundTextureFullArrayLayers',
            'settles scopes and preserves all causal failures across simultaneous lifecycle changes',
            'keeps the acknowledged native sampler identity immutable',
            'keeps acknowledged query facts and native allocation identity immutable',
            'keeps BufferResource native allocation identity authoritative through its prototype',
            'keeps BindSet preparation state authoritative through its prototype',
            'keeps BindLayout lifecycle authority immutable through its prototype',
            'locks Draw and Dispatch label facts as immutable own properties',
            'freezes every executable command prototype authority',
            'rejects a forged sampler after constructor Symbol.hasInstance replacement',
            'rejects a forged texture before native copy encoding after constructor replacement',
            'rejects prototype-derived BindLayout identities before native binding creation',
            'rejects prototype-derived Program identities before native pipeline creation',
            'keeps Program identity and runtime ownership authoritative after public mutation attempts',
            'keeps Program disposal authoritative after public mutation attempts',
            'revalidates caller-owned Program required features before future native pipeline work',
            'rejects render Program disposal during caller-owned fact snapshot before native work',
            'rejects compute Program disposal during caller-owned fact snapshot before native work',
            'rejects render Program disposal during pipeline descriptor snapshot before native work',
            'rejects compute Program disposal during pipeline descriptor snapshot before native work',
            'keeps disposed lifecycle authority after public assertActive shadowing',
            'keeps device-loss lifecycle authority after public assertActive shadowing',
            'keeps downstream runtime authority after public assertActive shadowing',
            'keeps render Pipeline Program lifecycle authoritative after public assertion shadowing',
            'keeps compute Pipeline Program lifecycle authoritative after public assertion shadowing',
            'Runtime lifecycle authority is package-internal',
            'Program lifecycle authority stamps are package-internal',
            'rejects prototype-derived Pipeline and BindSet identities before command creation',
            'rejects prototype-derived pass and command identities before native submission effects',
            'does not use open instanceof checks as Scratch-owned internal brands',
            'rejects noncanonical raw resource descriptor integers before native issue',
            'rejects color attachment metadata and surface view descriptor divergence',
            'rejects invalid TextureResource attachment views and transient operations',
            'rejects overlapping color attachment regions while permitting disjoint 3d slices',
            'rejects depth-stencil formats in color attachment slots before encoder creation',
            'rejects invalid depth attachment views, clear values, and transient operations',
            'rejects invalid, unaligned, and disposed uploads with structured diagnostics',
            'rejects direct buffer uploads on a queue not owned by the command runtime',
            'rejects direct texture uploads on a queue not owned by the command runtime',
            'freezes one resolve slot snapshot for readiness and native encoding',
            'keeps construction facts and disposal immutable for every command family',
            'accepts the WGSL u32 boundary and rejects unsafe layout-size arithmetic',
            'rejects direct execution on a queue that is not owned by the command runtime',
            'rejects invalid descriptors and unaligned regions with structured diagnostics',
            'revalidates readback source usage against replacement allocations before staging copy effects',
            'revalidates query resolve usage against replacement allocations before encoder effects',
            'revalidates every fixed-function buffer usage against replacement allocations before encoder effects',
            'rejects unaligned direct readback regions before staging allocation',
            'rejects invalid and unaligned vertex buffer bindings with structured diagnostics',
            'defaults depth clear to one and accepts inclusive unit-range boundaries',
            'retains lifecycle recheck as secondary evidence beside a native preparation failure',
            'retains simultaneous lifecycle failures and links device-loss incidents',
            'snapshots Program layout requirements into immutable pipeline command contracts',
            'revalidates buffer bounds, usage, and alignment before binding a replacement allocation',
            'revalidates every buffer copy source region against replacement bounds before encoder effects',
            'revalidates a persistent 3d attachment depthSlice after allocation replacement',
            'accepts native-valid depth-only pipelines and render passes',
            'normalizes only complete finite GPUColor values before encoder creation',
            'accepts the GPUStencilValue maximum and rejects larger values before encoding',
            'enforces GPUSize32 bounds for both native buffer-texture copy layouts',
            'describes only BufferRegion-based copy shapes in structured diagnostics',
            'enforces GPUSize32 bounds for texture upload row layouts',
            'preserves full 2d-array bindings and rejects layer subsets on compatibility devices',
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
            'objectSameDeviceValidity',
            'gpuStencilValueEnforceRange',
            'completeFiniteGpuColorShape',
            'renderPipelineAttachmentPresence',
            'renderPassAttachmentPresence',
            'renderAttachmentDepthSlice',
            'colorAttachmentRenderableFormat',
            'pairwiseColorAttachmentRegions',
            'canvasContextGetConfiguration',
            'canvasTransientAttachmentRejected',
            'canvasConfigureCommitsConfiguration',
            'canvasUnconfigureClearsConfiguration',
            'textureMaximumMipLevelCount',
            'timestampWriteIndicesDistinct',
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
            '12 ordinary examples',
            '2 legacy examples',
            '`externalTexture`',
            'Fresh-Context Strict Review',
            'production bootstrap build',
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
            ordinaryExampleCount: 15,
            legacyExampleCount: 0,
        })
        expect(result.publicSurface.missingBaselineValues).to.deep.equal([])
        expect(result.publicSurface.missingHistoricalValues).to.deep.equal([])
        expect(result.publicSurface.historicalTypeInventory).to.have.length(18)
        expect(result.publicSurface.historicalTypeInventory.every(entry => entry.status === 'passed')).to.equal(true)
        expect(result.publicSurface.publicMemberParity).to.deep.include({
            goalStartCount: 357,
            finalCount: 400,
            status: 'passed',
        })
        expect(result.publicSurface.publicMemberParity.missingGoalStart).to.have.length(21)
        expect(result.publicSurface.publicMemberParity.changedGoalStart).to.have.length(11)
        expect(result.publicSurface.programReadonlyPublicContracts.map(
            contract => contract.id
        )).to.deep.equal([ 'Program.runtime', 'Program.id', 'Program.isDisposed' ])
        expect(result.publicSurface.programReadonlyPublicContracts.every(
            contract => contract.status === 'passed'
        )).to.equal(true)
        expect(result.publicSurface.programPipelineFactSnapshot).to.deep.include({
            status: 'passed',
            packageExported: false,
        })
        expect(result.publicSurface.programPipelineFactSnapshot.mutablePlannerReads).to.deep.equal([])
        expect(result.publicSurface.productionEmitParity).to.deep.include({
            status: 'passed',
            emittedJavaScriptCount: 96,
            emittedDeclarationCount: 96,
            declarationSignatureCount: 3689,
        })
        expect(result.publicSurface.productionEmitParity.files).to.have.length(192)
        expect(result.publicSurface.productionEmitParity.files.every(entry => entry.exactMatch)).to.equal(true)
        expect(result.diagnostics).to.deep.include({ schemaVersion: 5 })
        expect(result.diagnostics.unexpectedMissing).to.deep.equal([])
        expect(result.officialBindingMatrix.status).to.equal('passed')
        expect(result.officialBindingMatrix.nativeLowering.status).to.equal('passed')
        expect(result.officialBindingMatrix.externalTextureBoundary.intentionallyExcluded).to.equal(true)
        expect(result.nativeCopyQuadrants.every(entry => (
            entry.status === 'passed' && entry.gpuSide && entry.astResolvedCallCount === 1
        ))).to.equal(true)
        expect(result.publicSurface.closedBrandAuthority).to.deep.include({ status: 'passed' })
        expect(result.publicSurface.closedBrandAuthority.authorities).to.have.length(25)
        expect(result.publicSurface.closedBrandAuthority.openInstanceofSites).to.deep.equal([])
        expect(result.publicSurface.closedBrandAuthority.openDuckTypedAuthoritySites).to.deep.equal([])
        expect(Object.values(result.publicSurface.closedBrandAuthority.guards).every(Boolean)).to.equal(true)
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
            oneDimensionalSingleMip: true,
            supportingObjectCausality: true,
            nativeRegionAlignment: true,
            attachmentViewContracts: true,
            passSpecImmutability: true,
            timestampWriteIndices: true,
            programRequirementSnapshots: true,
            programExamplesUseBufferRegions: true,
            layoutCodecDiagnosticsCurrent: true,
            visionDiagnosticInventoryCurrent: true,
            storageBufferAccessCurrent: true,
            bufferResourcePrototypeAuthority: true,
            persistentBindingPrototypeAuthority: true,
            commandPrototypeAuthority: true,
            closedBrandAuthority: true,
            thirtySixthReviewAcceptanceRecorded: true,
            thirtySeventhReviewAcceptanceRecorded: true,
            thirtyEighthReviewAcceptanceRecorded: true,
            thirtyNinthReviewAcceptanceRecorded: true,
            boundedClosureProtocol: true,
            firstBoundedReviewCorrection: true,
            programFactSnapshotPredecessorAcceptanceRecorded: true,
            programFactSnapshotTerminalAdjudication: true,
            currentAcceptanceCounts: true,
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
        const provenanceIntegrationReview = fs.readFileSync(path.join(
            root,
            'docs',
            'review',
            'scratch-dev-feature-provenance-integration-audit.md'
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
        expect(provenanceIntegrationReview).to.include(
            'Current replacement: schema v5 and acknowledged explicit BindSet preparation.'
        )
        expect(provenanceIntegrationReview).to.not.include(
            '- schema-v4 submission targets, discriminated native locations, bounded current'
        )
        expect(provenanceIntegrationReview).to.not.include(
            '- explicit deferred sampler/query-set/bind-layout and independent lazy'
        )
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
        expect(result.productionBootstrap).to.deep.include({
            status: 'passed',
            reason: 'acceptance',
        })
        expect(result.executionEvidence.commandGates.productionBootstrapBuild).to.deep.include({
            status: 'passed',
            exitCode: 0,
        })
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
            tests: 484,
            passes: 484,
            failures: 0,
            pending: 0,
        })
        expect(result.executionEvidence.fullSuite).to.deep.include({
            status: 'passed',
            tests: 884,
            passes: 882,
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
