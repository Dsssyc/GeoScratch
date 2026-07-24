import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { expect } from 'chai'
import {
    canonicalManifestJson,
    compareWebGpuNormativeSources,
    createNormativeInventoryManifest,
    extractProposalWatchlistEntries,
    extractWebGpuIdlEntries,
    extractWebGpuTypesEntries,
    extractWgslNormativeEntries,
    normativeBaseline,
    validateNormativeInventory,
} from '../scripts/scratch-webgpu-wgsl-normative-inventory.mjs'

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
## Diagnostics ## {#diagnostics}
# Built-in Functions # {#builtin-functions}
### \`fixtureBuiltin\` ### {#fixtureBuiltin-builtin}
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
            failedSource: 'gpuweb/types raw declaration',
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
        ])
        expect(ids.some(id => id.includes('functions-builtins'))).to.equal(false)
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

    it('extracts proposal states without treating proposals as normative', () => {

        expect(extractProposalWatchlistEntries(proposalFixture)).to.deep.equal([
            { id: 'landed', status: 'merged', href: 'landed.md' },
            { id: 'future', status: 'draft', href: 'future.md' },
            { id: 'paused', status: 'inactive', href: 'paused.md' },
            { id: 'retired', status: 'obsolete', href: 'retired.md' },
        ])
    })

    it('serializes manifests deterministically and keeps extraction offline', () => {

        expect(canonicalManifestJson({
            z: 2,
            entries: [ { id: 'b' }, { id: 'a' } ],
            a: 1,
        })).to.equal(
            '{"a":1,"entries":[{"id":"b"},{"id":"a"}],"z":2}\n'
        )

        const moduleSource = fs.readFileSync(path.join(
            process.cwd(),
            'scripts',
            'scratch-webgpu-wgsl-normative-inventory.mjs'
        ), 'utf8')
        expect(moduleSource).not.to.match(
            /node:https|node:http|\bfetch\s*\(|raw\.githubusercontent/
        )
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
})
