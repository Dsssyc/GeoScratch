import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { expect } from 'chai'
import ts from 'typescript'
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

    it('pins each pointer language proof to a native-valid source shape', () => {

        const cases = extractSemanticCases(
            'tests/browser/scratch-wgsl-capability-matrix.mjs',
            [ 'unrestricted-pointer', 'pointer-composite' ]
        )

        expect({
            unrestrictedPointer:
                unrestrictedPointerProofSourceIsConformant(
                    cases.get('unrestricted-pointer')
                ),
            pointerComposite:
                pointerCompositeProofSourceIsConformant(
                    cases.get('pointer-composite')
                ),
        }).to.deep.equal({
            unrestrictedPointer: true,
            pointerComposite: true,
        })
    })
})

function unrestrictedPointerProofSourceIsConformant(proof) {

    const source = proof?.source ?? ''
    return (
        proof?.expected === 103 &&
        source.includes('requires unrestricted_pointer_parameters;') &&
        /destination\s*:\s*ptr<storage,\s*u32,\s*read_write>/.test(source) &&
        /\*destination\s*=\s*value\s*;/.test(source) &&
        /writeThroughStoragePointer\s*\(\s*&outputValues\s*,\s*103u\s*\)/
            .test(source) &&
        !/\btarget\s*:/.test(source)
    )
}

function pointerCompositeProofSourceIsConformant(proof) {

    const source = proof?.source ?? ''
    return (
        proof?.expected === 104 &&
        source.includes('requires pointer_composite_access;') &&
        /var\s+localValues\s*=\s*array<u32,\s*4>\s*\(/.test(source) &&
        /let\s+valuesPointer\s*=\s*&localValues\s*;/.test(source) &&
        /outputValues\s*\[\s*0u?\s*\]\s*=\s*valuesPointer\s*\[\s*2u\s*\]\s*;/
            .test(source) &&
        !/\*\s*valuesPointer\b/.test(source) &&
        !/&\s*[A-Za-z_]\w*\s*\.\s*[xyzwrgba]{1,4}\b/.test(source)
    )
}

function extractSemanticCases(relativePath, requiredNames) {

    const absolutePath = path.join(process.cwd(), relativePath)
    const source = fs.readFileSync(absolutePath, 'utf8')
    const file = ts.createSourceFile(
        relativePath,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JS
    )
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
        if (!ts.isPropertyAssignment(property)) continue
        const caseName = staticPropertyName(property.name)
        if (!required.has(caseName)) continue
        if (cases.has(caseName)) {
            throw new Error(`Duplicate semantic case ${caseName}`)
        }
        if (!ts.isObjectLiteralExpression(property.initializer)) {
            throw new Error(`Semantic case ${caseName} must be an object literal`)
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
