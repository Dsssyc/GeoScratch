import { expect } from 'chai'
import {
    createCurrentCoverageManifest,
    createWgslEnableExtensionManifest,
} from '../scripts/scratch-webgpu-wgsl-current-coverage.mjs'

const expectedEnableContracts = [
    {
        id: 'enable-extension.clip_distances',
        extension: 'clip_distances',
        requiredFeatures: [ 'clip-distances' ],
        dependencies: [],
    },
    {
        id: 'enable-extension.dual_source_blending',
        extension: 'dual_source_blending',
        requiredFeatures: [ 'dual-source-blending' ],
        dependencies: [],
    },
    {
        id: 'enable-extension.f16',
        extension: 'f16',
        requiredFeatures: [ 'shader-f16' ],
        dependencies: [],
    },
    {
        id: 'enable-extension.primitive_index',
        extension: 'primitive_index',
        requiredFeatures: [ 'primitive-index' ],
        dependencies: [],
    },
    {
        id: 'enable-extension.subgroup_size_control',
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
        id: 'enable-extension.subgroups',
        extension: 'subgroups',
        requiredFeatures: [ 'subgroups' ],
        dependencies: [],
    },
]

describe('Scratch current WebGPU and WGSL coverage manifests', () => {

    it('models all formal WGSL enable extensions without mixing language extensions', () => {

        const manifest = createWgslEnableExtensionManifest()

        expect(manifest.entries.map(entry => ({
            id: entry.id,
            extension: entry.extension,
            requiredFeatures: entry.requiredFeatures,
            dependencies: entry.dependencies,
        }))).to.deep.equal(expectedEnableContracts)
        expect(manifest.entries).to.have.length(6)
        expect(manifest.entries.every(entry =>
            entry.requiredLanguageFeatures.length === 0
        )).to.equal(true)
    })

    it('closes all 662 current entries with resolvable bounded evidence', () => {

        const manifest = createCurrentCoverageManifest()
        const evidenceIds = new Set(manifest.evidence.map(evidence => evidence.id))

        expect(manifest.summary).to.deep.include({
            entryCount: 662,
            webgpuEntryCount: 591,
            wgslBaselineEntryCount: 65,
            wgslEnableExtensionEntryCount: 6,
            unresolvedCount: 0,
        })
        expect(new Set(manifest.entries.map(entry => entry.id)).size).to.equal(662)
        expect(manifest.entries.every(entry =>
            entry.evidenceIds.length > 0 &&
            entry.evidenceIds.every(id => evidenceIds.has(id))
        )).to.equal(true)
        expect(manifest.entries
            .filter(entry => entry.domain === 'webgpu')
            .every(entry =>
                typeof entry.coverageRule === 'string' &&
                entry.coverageRule.length > 0 &&
                !entry.coverageRule.includes('fallback')
            )).to.equal(true)
        expect(evidenceIds.has('webgpu-descriptor-values')).to.equal(false)
        expect(manifest.entries.some(entry =>
            entry.current.status === 'managed' &&
            entry.expression.publicSymbols.some(symbol =>
                symbol === 'ScratchRuntime.device' ||
                symbol === 'ScratchRuntime.queue'
            )
        )).to.equal(false)
    })

    it('uses exact capability families instead of catch-all evidence', () => {

        const manifest = createCurrentCoverageManifest()
        const entries = new Map(manifest.entries.map(entry => [ entry.id, entry ]))

        expect(entries.get('GPU.requestAdapter').evidenceIds).to.deep.equal([
            'webgpu-runtime-capabilities',
        ])
        expect(entries.get('GPU.getPreferredCanvasFormat').evidenceIds).to.deep.equal([
            'webgpu-surface-presentation',
        ])
        expect(entries.get('GPU.wgslLanguageFeatures').evidenceIds).to.deep.equal([
            'webgpu-runtime-capabilities',
        ])
        expect(entries.get('GPUBindingCommandsMixin.setImmediates').evidenceIds)
            .to.deep.equal([ 'wgsl-immediate-data' ])
        expect(entries.get('GPUBindingCommandsMixin.setBindGroup').evidenceIds)
            .to.deep.equal([ 'webgpu-bindings' ])
        expect(entries.get('GPUTextureViewDescriptor.swizzle').evidenceIds)
            .to.deep.equal([ 'webgpu-texture-resource' ])
        expect(entries.get('GPUComputePassDescriptor.timestampWrites').evidenceIds)
            .to.deep.equal([ 'webgpu-query' ])
    })

    it('retains value-dependent WebGPU feature, language, and limit contracts', () => {

        const manifest = createCurrentCoverageManifest()
        const entries = new Map(manifest.entries.map(entry => [ entry.id, entry ]))

        expect(entries.get('GPUPrimitiveState.unclippedDepth').requirements.conditions)
            .to.deep.include({
                when: 'unclippedDepth is true',
                deviceFeatures: [ 'depth-clip-control' ],
                languageFeatures: [],
                limits: [],
                dependencies: [],
            })
        expect(entries.get('GPUComputePassDescriptor.timestampWrites').requirements.conditions)
            .to.deep.include({
                when: 'timestampWrites is provided',
                deviceFeatures: [ 'timestamp-query' ],
                languageFeatures: [],
                limits: [],
                dependencies: [],
            })
        expect(entries.get('GPUTextureViewDescriptor.swizzle').requirements.conditions)
            .to.deep.include({
                when: 'swizzle is not the identity "rgba"',
                deviceFeatures: [ 'texture-component-swizzle' ],
                languageFeatures: [],
                limits: [],
                dependencies: [],
            })
        expect(entries.get('GPUPipelineLayoutDescriptor.immediateSize').requirements.conditions)
            .to.deep.include({
                when: 'immediateSize is greater than zero',
                deviceFeatures: [],
                languageFeatures: [ 'immediate_address_space' ],
                limits: [ 'maxImmediateSize' ],
                dependencies: [],
            })
        expect(entries.get('type.GPUTextureFormat').requirements.conditions)
            .to.have.length.greaterThan(5)
    })

    it('pins every refreshed external source to immutable provenance', () => {

        const manifest = createCurrentCoverageManifest()
        const baseline = manifest.baseline

        expect(baseline.gpuwebEditor.url).to.equal(
            `https://github.com/gpuweb/gpuweb/commit/${baseline.gpuwebEditor.refreshedCommit}`
        )
        expect(baseline.gpuwebEditor.sourceUrl).to.include(
            baseline.gpuwebEditor.refreshedCommit
        )
        expect(baseline.gpuwebTypes.url).to.equal(
            `https://github.com/gpuweb/types/commit/${baseline.gpuwebTypes.repositoryCommit}`
        )
        expect(baseline.proposalIndex.url).to.include(
            baseline.gpuwebEditor.refreshedCommit
        )
        expect(baseline.proposalIndex.sourceUrl).to.include(
            baseline.gpuwebEditor.refreshedCommit
        )
    })
})
