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
        expect(manifest.entries.some(entry =>
            entry.current.status === 'managed' &&
            entry.expression.publicSymbols.some(symbol =>
                symbol === 'ScratchRuntime.device' ||
                symbol === 'ScratchRuntime.queue'
            )
        )).to.equal(false)
    })
})
