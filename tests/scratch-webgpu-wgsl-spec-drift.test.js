import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { expect } from 'chai'
import ts from 'typescript'
import {
    canonicalManifestJson,
    compareWebGpuNormativeSources,
    createNormativeInventoryManifest,
    extractCapabilityDependencyEntries,
    extractProposalWatchlistEntries,
    extractWebGpuIdlEntries,
    extractWebGpuTypesEntries,
    extractWgslNormativeEntries,
    normativeBaseline,
    sha256,
    validateNormativeInventory,
} from '../scripts/scratch-webgpu-wgsl-normative-inventory.mjs'
import {
    createScratchNormativeArtifacts,
    normativeArtifactPaths,
} from '../scripts/refresh-scratch-webgpu-wgsl-baseline.mjs'

const webGpuIdlFixture = `
<script type=idl>
[Exposed=(Window, Worker)]
interface GPUFixture {
    readonly attribute unsigned long size;
    undefined execute(optional unsigned long count = 1);
};

dictionary GPUFixtureDescriptor {
    required unsigned long size;
};

enum GPUFixtureMode {
    "first",
    "second",
};

typedef unsigned long GPUFixtureFlags;
</script>
`

const webGpuTypesFixture = `
interface GPUFixture {
    readonly size: number;
    execute(count?: number): undefined;
}

interface GPUFixtureDescriptor {
    size: number;
}

type GPUFixtureMode = "first" | "second";
type GPUFixtureFlags = number;
`

const wgslFixture = `
# Directives # {#directives}
## Extensions ## {#extensions}
### Enable Extensions ### {#enable-extensions-sec}
<table class='data'>
  <caption>Enable-extensions</caption>
  <tr><td><dfn noexport dfn-for="extension">\`fixture_enable\`</dfn>
      <td>[[WebGPU#fixture-feature|"fixture-feature"]]
      <td>Enables the <a for=attribute lt=fixture_attr>attribute</a>.
</table>

### Language Extensions ### {#language-extensions-sec}
<table class='data'>
  <caption>Language extensions</caption>
  <tr><td><dfn for="language_extension">fixture_language</dfn>
      <td>Adds the [[#fixtureBuiltin-builtin|fixtureBuiltin]] built-in function.
</table>

# Declaration and Scope # {#declaration-and-scope}
# Types # {#types}
### Scalar Types ### {#scalar-types}
### Vector Types ### {#vector-types}
### Matrix Types ### {#matrix-types}
### Atomic Types ### {#atomic-types}
### Array Types ### {#array-types}
### Structure Types ### {#struct-types}
## Buffer Types ## {#buffer-types}
## Texture and Sampler Types ## {#texture-sampler-types}
### Texel Formats ### {#texel-formats}
<dfn noexport dfn-for="texel format">rgba8unorm</dfn>

# Variable and Value Declarations # {#var-and-value}
# Statements # {#statements}
## Control Flow ## {#control-flow}
# Attributes # {#attributes}
<dfn noexport dfn-for="attribute">\`fixture_attr\`</dfn>
# Entry Points # {#entry-points}
## Shader Interface ## {#shader-interface}
#### Interpolation #### {#interpolation}
<dfn for="interpolation type" export>flat</dfn>
<dfn for="interpolation sampling" export>center</dfn>
##### \`fixture_value\` ##### {#fixture-value-builtin-value}
<dfn noexport dfn-for="built-in values">fixture_value</dfn>

# Memory # {#memory}
## Memory Access Mode ## {#memory-access-mode}
<dfn noexport dfn-for="access">read</dfn>
## Address Spaces ## {#address-space}
<dfn noexport dfn-for="address spaces">storage</dfn>
## Memory Layout ## {#memory-layouts}
### Alignment and Size ### {#alignment-and-size}
### Address Space Layout Constraints ### {#address-space-layout-constraints}

# Execution # {#execution}
## Limits ## {#limits}
<table class='data'>
  <caption>Quantifiable shader complexity limits</caption>
  <tr><td>Maximum fixture nesting depth<td>15
</table>
## Diagnostics ## {#diagnostics}
<dfn noexport dfn-for="trigger">fixture_uniformity</dfn>
# Built-in Functions # {#builtin-functions}
### \`fixtureBuiltin\` ### {#fixtureBuiltin-builtin}
`

const capabilityWebGpuFixture = `
# Optional Features # {#optional-features}
<h3 id=feature-base data-dfn-type=enum-value data-dfn-for=GPUFeatureName>
\`"feature-base"\`
</h3>
<h3 id=feature-parent data-dfn-type=enum-value data-dfn-for=GPUFeatureName>
\`"feature-parent"\`
</h3>
Enabling {{GPUFeatureName/"feature-parent"}} at device creation will enable
{{GPUFeatureName/"feature-base"}}.

## Adapter Capability Guarantees ## {#adapter-capability-guarantees}
- At least one of the following must be true:
    - {{GPUFeatureName/"compression-a"}} is supported.
    - Both {{GPUFeatureName/"compression-b"}} and
      {{GPUFeatureName/"compression-c"}} are supported.
- If {{GPUFeatureName/"compression-a-sliced"}}
  is supported, then {{GPUFeatureName/"compression-a"}} must be supported.

## Limits ## {#limits}
<table class=data dfn-type=attribute dfn-for="supported limits">
  <tr><td><dfn>maxFixtureSize</dfn>
      <td>GPUSize32 <td>maximum <td>64
</table>

## Texture Format Capabilities ## {#texture-format-caps}
<table class=data>
  <tr>
    <td>{{GPUTextureFormat/fixture-format}}
    <td>If {{GPUFeatureName/"feature-base"}} is enabled
</table>

<h3 id=unrelated-feature data-dfn-type=enum-value data-dfn-for=GPUFeatureName>
\`"unrelated-feature"\`
</h3>
{{GPUFeatureName/"unrelated-feature"}}
`

const capabilityWgslFixture = `
### Enable Extensions ### {#enable-extensions-sec}
<table class='data'>
  <caption>Enable-extensions</caption>
  <tr><td><dfn noexport dfn-for="extension">\`fixture_base\`</dfn>
      <td>[[WebGPU#feature-base|"feature-base"]]
      <td>Base.
  <tr><td><dfn noexport dfn-for="extension">\`fixture_parent\`</dfn>
      <td>[[WebGPU#feature-parent|"feature-parent"]]
      <td>Must be enabled together with the
          [=extension/fixture_base=] extension.
</table>

### Language Extensions ### {#language-extensions-sec}
<table class='data'>
  <caption>Language extensions</caption>
  <tr><td><dfn for="language_extension">fixture_language</dfn>
      <td>Requires the [=extension/fixture_base=] extension.
</table>
`

const proposalFixture = `
### Status: Merged
<!-- SECTION status-merged -->
* [landed](landed.md)

### Status: Draft
<!-- SECTION status-draft -->
* [future](future.md)

### Status: Inactive
<!-- SECTION status-inactive -->
* [paused](paused.md)

### Status: Obsolete
<!-- SECTION status-obsolete -->
* [retired](retired.md)
`

const wgslBuiltInRequirementFixture = `
### Enable Extensions ### {#enable-extensions-sec}
<table class='data'>
  <caption>Enable-extensions</caption>
  <tr><td><dfn noexport dfn-for="extension">\`fixture_group\`</dfn>
      <td>[[WebGPU#fixture-group|"fixture-group"]]
      <td>Enables [[#builtin-inputs-outputs|fixture built-in values]]
          and [[#fixture-group-builtins|fixture built-in functions]].
</table>

#### Built-in Inputs and Outputs #### {#builtin-inputs-outputs}
<dfn noexport dfn-for="built-in values">ordinary_value</dfn>
<dfn noexport dfn-for="built-in values">group_value</dfn>
<table class='data'>
  <caption>Built-in input and output values</caption>
  <tr><td>[=built-in values/ordinary_value=]<td>
  <tr><td>[=built-in values/group_value=]
      <td>[=extension/fixture_group=]
</table>

# Built-in Functions # {#builtin-functions}
#### Fixture Group Built-ins #### {#fixture-group-builtins}
##### \`fixtureGroup\` ##### {#fixtureGroup-builtin}
`

describe('Scratch normative WebGPU and WGSL inventory extraction', () => {

    it('pins the one-shot source observation and its partial refresh fact', () => {

        expect(normativeBaseline).to.deep.include({
            observedOn: '2026-07-25',
            gpuwebCommit:
                'b33e6efb182d11156851271586563cc77575059c',
            gpuwebTypesCommit:
                '9ba8a0618e1efad8e1ee444ef6ecfae761b2bc30',
        })
        expect(normativeBaseline.refreshAttempt).to.deep.include({
            status: 'partial',
            retryCount: 0,
            failedSource: 'W3C WebGPU publication page',
        })
        expect(normativeBaseline.webgpu.files.map(file => file.path))
            .to.deep.equal([
                'spec/index.bs',
                'spec/sections/copies.bs',
                'spec/sections/privacy-and-security.bs',
            ])
        expect(normativeBaseline.wgsl.files.map(file => file.path))
            .to.deep.equal([ 'wgsl/index.bs' ])
    })

    it('extracts stable WebGPU IDL and declaration identities', () => {

        const idl = extractWebGpuIdlEntries(webGpuIdlFixture)
        const types = extractWebGpuTypesEntries(webGpuTypesFixture)

        expect(idl.unresolved).to.deep.equal([])
        expect(types.unresolved).to.deep.equal([])
        expect(idl.entries.map(entry => entry.id)).to.deep.equal([
            'GPUFixture.execute',
            'GPUFixture.size',
            'GPUFixtureDescriptor.size',
            'interface.GPUFixture',
            'interface.GPUFixtureDescriptor',
            'type.GPUFixtureFlags',
            'type.GPUFixtureMode',
        ])
        expect(types.entries.map(entry => entry.id)).to.deep.equal(
            idl.entries.map(entry => entry.id)
        )
    })

    it('reports every cross-source mismatch instead of accepting one authority', () => {

        const idl = extractWebGpuIdlEntries(webGpuIdlFixture)
        const types = extractWebGpuTypesEntries(
            webGpuTypesFixture.replace(
                'readonly size: number;',
                'readonly byteLength: number;'
            )
        )
        const comparison = compareWebGpuNormativeSources(
            idl.entries,
            types.entries
        )

        expect(comparison.status).to.equal('unresolved')
        expect(comparison.specOnlyIds).to.deep.equal([ 'GPUFixture.size' ])
        expect(comparison.typesOnlyIds).to.deep.equal([
            'GPUFixture.byteLength',
        ])
    })

    it('reports equivalent IDL and TypeScript declaration representations', () => {

        const comparison = compareWebGpuNormativeSources(
            [
                {
                    id: 'interface.GPUEmptyDescriptor',
                    crossSourceComparable: true,
                },
            ],
            [
                {
                    id: 'type.GPUEmptyDescriptor',
                    crossSourceComparable: true,
                },
            ]
        )

        expect(comparison.status).to.equal('matched')
        expect(comparison.representationDifferences).to.deep.equal([
            {
                identity: 'declaration.GPUEmptyDescriptor',
                specIds: [ 'interface.GPUEmptyDescriptor' ],
                typesIds: [ 'type.GPUEmptyDescriptor' ],
                reason:
                    'Equivalent WebIDL and TypeScript root declaration representations.',
            },
        ])
    })

    it('turns unsupported IDL constructs into unresolved extraction facts', () => {

        const result = extractWebGpuIdlEntries(`
            <script type=idl>
            interface GPUUnsupported {
                serializer;
            };
            </script>
        `)

        expect(result.entries.map(entry => entry.id)).to.deep.equal([
            'interface.GPUUnsupported',
        ])
        expect(result.unresolved).to.have.length(1)
        expect(result.unresolved[0]).to.deep.include({
            owner: 'GPUUnsupported',
            reason: 'unsupported-idl-member',
        })
    })

    it('extracts named WGSL units without broad semantic-domain aliases', () => {

        const result = extractWgslNormativeEntries(wgslFixture)
        const ids = result.entries.map(entry => entry.id)

        expect(result.unresolved).to.deep.equal([])
        expect(ids).to.include.members([
            'enable-extension.fixture_enable',
            'language-extension.fixture_language',
            'attribute.fixture_attr',
            'built-in-value.fixture_value',
            'built-in-function.fixtureBuiltin',
            'texel-format.rgba8unorm',
            'access-mode.read',
            'address-space.storage',
            'semantic-section.control-flow',
            'semantic-section.alignment-and-size',
            'wgsl-limit.maximum-fixture-nesting-depth',
            'diagnostic-rule.fixture_uniformity',
            'interpolation-type.flat',
            'interpolation-sampling.center',
        ])
        expect(ids.includes('shader-domain.functions-builtins')).to.equal(false)
        expect(result.entries.find(
            entry => entry.id === 'enable-extension.fixture_enable'
        )?.requirements.deviceFeatures).to.deep.equal([ 'fixture-feature' ])
        expect(result.entries.find(
            entry => entry.id === 'built-in-function.fixtureBuiltin'
        )?.requirements.languageFeatures).to.deep.equal([
            'fixture_language',
        ])
    })

    it('fails inventory validation when a required WGSL family disappears', () => {

        const result = extractWgslNormativeEntries(
            wgslFixture.replace(
                '## Address Spaces ## {#address-space}',
                '## Removed Concept ## {#removed-concept}'
            ).replace(
                '<dfn noexport dfn-for="address spaces">storage</dfn>',
                ''
            )
        )

        expect(() => validateNormativeInventory({
            domain: 'wgsl',
            entries: result.entries,
            unresolved: result.unresolved,
        })).to.throw(/address-space/)
    })

    it('attributes a built-in value feature from its normative row only', () => {

        const result = extractWgslNormativeEntries(
            wgslBuiltInRequirementFixture
        )
        const entries = new Map(
            result.entries.map(entry => [ entry.id, entry ])
        )

        expect(entries.get('built-in-value.ordinary_value')
            .requirements.deviceFeatures).to.deep.equal([])
        expect(entries.get('built-in-value.group_value')
            .requirements).to.deep.include({
            enableExtensions: [ 'fixture_group' ],
            deviceFeatures: [ 'fixture-group' ],
        })
        expect(entries.get('built-in-function.fixtureGroup')
            .requirements.deviceFeatures).to.deep.equal([
            'fixture-group',
        ])
    })

    it('extracts proposal states without treating proposals as normative', () => {

        expect(extractProposalWatchlistEntries(proposalFixture)).to.deep.equal([
            { id: 'landed', status: 'merged', href: 'landed.md' },
            { id: 'future', status: 'draft', href: 'future.md' },
            { id: 'paused', status: 'inactive', href: 'paused.md' },
            { id: 'retired', status: 'obsolete', href: 'retired.md' },
        ])
    })

    it('keeps capability dependency categories and preflight semantics distinct', () => {

        const result = extractCapabilityDependencyEntries({
            webGpuSource: capabilityWebGpuFixture,
            wgslSource: capabilityWgslFixture,
        })
        const entries = new Map(
            result.entries.map(entry => [ entry.id, entry ])
        )

        expect(result.unresolved).to.deep.equal([])
        expect(entries.get('enable-to-feature.fixture_parent')).to.deep.include({
            kind: 'enable-to-device-feature',
            extension: 'fixture_parent',
            feature: 'feature-parent',
            callerPreflight: true,
        })
        expect(entries.get(
            'caller-companion.feature-parent.feature-base'
        )).to.deep.include({
            kind: 'caller-declared-companion',
            feature: 'feature-parent',
            requiredFeature: 'feature-base',
            callerPreflight: true,
        })
        expect(entries.get(
            'native-implication.feature-parent.feature-base'
        )).to.deep.include({
            kind: 'native-feature-implication',
            feature: 'feature-parent',
            impliedFeature: 'feature-base',
            callerPreflight: false,
        })
        expect(entries.get(
            'support-prerequisite.compression-a-sliced.compression-a'
        )).to.deep.include({
            kind: 'adapter-support-prerequisite',
            callerPreflight: false,
        })
        expect(entries.get('feature-alternative.adapter-compression'))
            .to.deep.include({
                kind: 'feature-alternatives',
                callerPreflight: false,
            })
        expect(entries.get('format-condition.fixture-format'))
            .to.deep.include({
                kind: 'format-specific-condition',
                format: 'fixture-format',
                requiredFeatures: [ 'feature-base' ],
                callerPreflight: false,
            })
        expect(entries.get('webgpu-limit.maxFixtureSize')).to.deep.include({
            kind: 'limit-bound-capability',
            limit: 'maxFixtureSize',
            callerPreflight: false,
        })
        expect(entries.get(
            'language-to-enable.fixture_language.fixture_base'
        )).to.deep.include({
            kind: 'language-to-enable-prerequisite',
            languageFeature: 'fixture_language',
            requiredEnableExtension: 'fixture_base',
            callerPreflight: false,
        })
    })

    it('serializes manifests deterministically and keeps extraction offline', () => {

        expect(canonicalManifestJson({
            z: 2,
            entries: [ { id: 'b' }, { id: 'a' } ],
            a: 1,
        })).to.equal(
            '{"a":1,"entries":[{"id":"b"},{"id":"a"}],"z":2}\n'
        )

        const moduleSource = parseTypeScriptSource(
            'scripts/scratch-webgpu-wgsl-normative-inventory.mjs'
        )
        expect(importsNetworkModule(moduleSource)).to.equal(false)
        expect(callsIdentifier(moduleSource, 'fetch')).to.equal(false)
    })

    it('builds a normalized manifest envelope with source-file hashes', () => {

        const extraction = extractWgslNormativeEntries(wgslFixture)
        const manifest = createNormativeInventoryManifest({
            id: 'scratch-wgsl-normative-inventory-fixture',
            domain: 'wgsl',
            source: {
                publicationUrl: 'https://example.test/wgsl/',
                repositoryCommit: '0123456789abcdef',
                files: [
                    {
                        path: 'wgsl/index.bs',
                        sha256: 'a'.repeat(64),
                    },
                ],
            },
            extraction,
        })

        expect(manifest).to.deep.include({
            schemaVersion: 2,
            id: 'scratch-wgsl-normative-inventory-fixture',
            domain: 'wgsl',
            status: 'complete',
        })
        expect(manifest.summary).to.deep.include({
            entryCount: extraction.entries.length,
            unresolvedCount: 0,
            enableExtensionCount: 1,
            languageExtensionCount: 1,
        })
        expect(canonicalManifestJson(manifest)).to.equal(
            canonicalManifestJson(createNormativeInventoryManifest({
                id: 'scratch-wgsl-normative-inventory-fixture',
                domain: 'wgsl',
                source: manifest.source,
                extraction,
            }))
        )
    })

    it('rebuilds all checked artifacts byte-for-byte and rejects source drift', () => {

        const webGpuSource = `${webGpuIdlFixture}\n${capabilityWebGpuFixture}`
        const sourceFacts = {
            observedOn: '2026-07-25',
            gpuwebCommit: 'fixture-gpuweb',
            gpuwebTypesCommit: 'fixture-types',
            webgpu: {
                publicationUrl: 'https://example.test/webgpu/',
                files: [
                    {
                        path: 'spec/index.bs',
                        sha256: sha256(webGpuSource),
                    },
                ],
            },
            wgsl: {
                publicationUrl: 'https://example.test/wgsl/',
                files: [
                    {
                        path: 'wgsl/index.bs',
                        sha256: sha256(wgslFixture),
                    },
                ],
            },
            types: {
                packageVersion: 'fixture',
                files: [
                    {
                        path: 'dist/index.d.ts',
                        sha256: sha256(webGpuTypesFixture),
                    },
                ],
            },
            proposals: {
                files: [
                    {
                        path: 'proposals/README.md',
                        sha256: sha256(proposalFixture),
                    },
                ],
            },
        }
        const input = {
            sourceFacts,
            webGpuFiles: [
                { path: 'spec/index.bs', source: webGpuSource },
            ],
            wgslFiles: [
                { path: 'wgsl/index.bs', source: wgslFixture },
            ],
            typesFile: {
                path: 'dist/index.d.ts',
                source: webGpuTypesFixture,
            },
            proposalFile: {
                path: 'proposals/README.md',
                source: proposalFixture,
            },
        }

        const first = createScratchNormativeArtifacts(input)
        const second = createScratchNormativeArtifacts(input)

        expect(Object.keys(first)).to.deep.equal([
            'webgpu',
            'wgsl',
            'dependencies',
            'proposals',
        ])
        expect(canonicalManifestJson(first)).to.equal(
            canonicalManifestJson(second)
        )
        expect(first.webgpu.crossSourceComparison.status).to.equal('matched')
        expect(first.proposals.normative).to.equal(false)
        expect(first.proposals.summary.byStatus).to.deep.equal({
            draft: 1,
            inactive: 1,
            merged: 1,
            obsolete: 1,
        })

        expect(() => createScratchNormativeArtifacts({
            ...input,
            typesFile: {
                ...input.typesFile,
                source: `${webGpuTypesFixture}\n// drift`,
            },
        })).to.throw(/SHA-256 mismatch/)
    })

    it('checks in the complete fine-grained normative artifacts', () => {

        const webgpu = readJson(normativeArtifactPaths.webgpu)
        const wgsl = readJson(normativeArtifactPaths.wgsl)
        const dependencies = readJson(normativeArtifactPaths.dependencies)
        const proposals = readJson(normativeArtifactPaths.proposals)

        expect(webgpu.status).to.equal('complete')
        expect(webgpu.summary.entryCount).to.equal(582)
        expect(webgpu.crossSourceComparison).to.deep.include({
            status: 'matched',
            specOnlyIds: [],
            typesOnlyIds: [],
        })
        expect(webgpu.crossSourceComparison.representationDifferences)
            .to.have.length(6)

        expect(wgsl.status).to.equal('complete')
        expect(wgsl.summary).to.deep.include({
            entryCount: 662,
            enableExtensionCount: 6,
            languageExtensionCount: 12,
            unresolvedCount: 0,
        })
        expect(wgsl.summary.byKind['built-in-function']).to.equal(167)
        expect(wgsl.entries.some(
            entry => entry.id === 'built-in-function.textureSample'
        )).to.equal(true)
        expect(wgsl.entries.some(
            entry => entry.id === 'built-in-function.builtin'
        )).to.equal(false)
        expect(wgsl.entries.some(
            entry => entry.id === 'shader-domain.functions-builtins'
        )).to.equal(false)

        expect(dependencies.status).to.equal('complete')
        expect(dependencies.summary).to.deep.include({
            entryCount: 155,
            callerCompanionPreflightCount: 1,
            unresolvedCount: 0,
        })
        expect(dependencies.entries
            .filter(entry =>
                entry.kind === 'caller-declared-companion'
            )
            .map(entry => ({
                feature: entry.feature,
                requiredFeature: entry.requiredFeature,
            }))).to.deep.equal([
            {
                feature: 'subgroup-size-control',
                requiredFeature: 'subgroups',
            },
        ])

        expect(proposals).to.deep.include({
            status: 'complete',
            normative: false,
        })
        expect(proposals.summary.byStatus).to.deep.equal({
            draft: 11,
            inactive: 2,
            merged: 8,
            obsolete: 2,
        })
        expect(proposals.conflicts.map(entry => entry.proposal))
            .to.deep.equal([ 'subgroup-id' ])
    })

    it('keeps runtime preflight equal to caller-declared companions only', () => {

        const dependencies = readJson(normativeArtifactPaths.dependencies)
        const expected = dependencies.entries
            .filter(entry =>
                entry.kind === 'caller-declared-companion' &&
                entry.callerPreflight
            )
            .map(entry => ({
                feature: entry.feature,
                requiredFeature: entry.requiredFeature,
            }))
        const contract = parseTypeScriptSource(
            'packages/geoscratch/src/scratch/gpu/feature-contract.ts'
        )
        const actual = staticFrozenObjectArray(
            contract,
            'featureDependencies'
        )

        expect(actual).to.deep.equal(expected)
        expect(dependencies.entries
            .filter(entry => entry.kind === 'native-feature-implication')
            .every(entry => !entry.callerPreflight)).to.equal(true)
    })
})

function parseTypeScriptSource(relativePath) {

    const source = fs.readFileSync(
        path.join(process.cwd(), relativePath),
        'utf8'
    )
    const file = ts.createSourceFile(
        relativePath,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JS
    )
    expect(file.parseDiagnostics).to.have.length(0)
    return file
}

function staticFrozenObjectArray(sourceFile, variableName) {

    const declarations = []
    visitTypeScript(sourceFile, node => {
        if (
            ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.name.text === variableName &&
            node.initializer !== undefined
        ) {
            declarations.push(node.initializer)
        }
    })
    if (declarations.length !== 1) return []
    const array = unwrapObjectFreeze(declarations[0])
    if (!ts.isArrayLiteralExpression(array)) return []
    const values = []
    for (const element of array.elements) {
        const object = unwrapObjectFreeze(element)
        if (!ts.isObjectLiteralExpression(object)) return []
        const value = {}
        for (const property of object.properties) {
            if (
                !ts.isPropertyAssignment(property) ||
                !ts.isStringLiteral(property.initializer)
            ) {
                return []
            }
            const name = staticPropertyName(property.name)
            if (name === undefined) return []
            value[name] = property.initializer.text
        }
        values.push(value)
    }
    return values
}

function unwrapObjectFreeze(expression) {

    if (
        ts.isCallExpression(expression) &&
        expression.arguments.length === 1 &&
        ts.isPropertyAccessExpression(expression.expression) &&
        ts.isIdentifier(expression.expression.expression) &&
        expression.expression.expression.text === 'Object' &&
        expression.expression.name.text === 'freeze'
    ) {
        return expression.arguments[0]
    }
    return expression
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

function importsNetworkModule(sourceFile) {

    return sourceFile.statements.some(statement =>
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        (
            statement.moduleSpecifier.text === 'node:http' ||
            statement.moduleSpecifier.text === 'node:https'
        )
    )
}

function callsIdentifier(sourceFile, name) {

    let found = false
    visitTypeScript(sourceFile, node => {
        if (
            ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === name
        ) {
            found = true
        }
    })
    return found
}

function visitTypeScript(node, callback) {

    callback(node)
    ts.forEachChild(node, child =>
        visitTypeScript(child, callback)
    )
}

function readJson(file) {

    return JSON.parse(fs.readFileSync(file, 'utf8'))
}
