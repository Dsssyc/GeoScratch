import path from 'node:path'
import process from 'node:process'
import { expect } from 'chai'
import {
    createCurrentCoverageManifest,
} from '../scripts/scratch-webgpu-wgsl-current-coverage.mjs'
import {
    assertStructuredEvidence,
    coverageManifestSchemaV4,
    createRepositoryProofContext,
    validateCoverageManifestV4,
    verifyCoverageManifestProofs,
} from '../scripts/scratch-webgpu-wgsl-structured-proof.mjs'

const fixturePath =
    'tests/fixtures/scratch-structured-proof.ts'
const runtimePath =
    'packages/geoscratch/src/scratch/runtime.ts'
const entrypointPath =
    'packages/geoscratch/src/index.ts'

describe('Scratch structured WebGPU and WGSL normative proofs', () => {

    let context

    before(() => {

        context = createRepositoryProofContext({
            root: process.cwd(),
            additionalSourcePaths: [ fixturePath ],
        })
    })

    it('accepts typed calls, construction, properties, and descriptor fields', () => {

        const evidence = [
            {
                kind: 'function-call',
                operation: 'CorrectReceiver.execute',
                sourcePath: fixturePath,
                selector: {
                    member: 'execute',
                    receiverTypes: [ 'CorrectReceiver' ],
                },
            },
            {
                kind: 'constructor-call',
                operation: 'URL.constructor',
                sourcePath: fixturePath,
                selector: {
                    constructorTypes: [ 'URL' ],
                },
            },
            {
                kind: 'property-write',
                operation: 'DescriptorFixture.size.write',
                sourcePath: fixturePath,
                selector: {
                    member: 'size',
                    receiverTypes: [ 'DescriptorFixture' ],
                },
            },
            {
                kind: 'property-read',
                operation: 'GPUAdapterInfo.isFallbackAdapter',
                sourcePath: runtimePath,
                selector: {
                    member: 'isFallbackAdapter',
                    receiverTypes: [ 'Partial<GPUAdapterInfo>' ],
                },
            },
            {
                kind: 'descriptor-field',
                operation: 'GPUBufferDescriptor.size',
                sourcePath:
                    'packages/geoscratch/src/scratch/buffer.ts',
                selector: {
                    field: 'size',
                    ownerTypes: [ 'GPUBufferDescriptor' ],
                },
            },
        ]

        for (const item of evidence) {
            expect(() => assertStructuredEvidence(context, item))
                .not.to.throw()
        }
    })

    it('rejects comments, ordinary strings, wrong receivers, and wrong files', () => {

        const invalidEvidence = [
            {
                kind: 'function-call',
                operation: 'comment-only',
                sourcePath: fixturePath,
                selector: {
                    member: 'commentOnlyOperation',
                    receiverTypes: [],
                },
            },
            {
                kind: 'function-call',
                operation: 'string-only',
                sourcePath: fixturePath,
                selector: {
                    member: 'stringOnlyOperation',
                    receiverTypes: [],
                },
            },
            {
                kind: 'function-call',
                operation: 'wrong-receiver',
                sourcePath: fixturePath,
                selector: {
                    member: 'wrongReceiverOnly',
                    receiverTypes: [ 'CorrectReceiver' ],
                },
            },
            {
                kind: 'function-call',
                operation: 'wrong-file',
                sourcePath: runtimePath,
                selector: {
                    member: 'execute',
                    receiverTypes: [ 'CorrectReceiver' ],
                },
            },
        ]

        for (const item of invalidEvidence) {
            expect(() => assertStructuredEvidence(context, item))
                .to.throw('did not resolve')
        }
    })

    it('resolves public exports through the TypeScript module graph', () => {

        expect(() => assertStructuredEvidence(context, {
            kind: 'public-export',
            operation: 'ScratchRuntime export',
            sourcePath: entrypointPath,
            selector: {
                exportName: 'ScratchRuntime',
            },
        })).not.to.throw()
        expect(() => assertStructuredEvidence(context, {
            kind: 'public-export',
            operation: 'MissingScratchExport export',
            sourcePath: entrypointPath,
            selector: {
                exportName: 'MissingScratchExport',
            },
        })).to.throw('did not resolve')
    })

    it('validates schema v4 strictly and verifies every repository proof', () => {

        const manifest = createCurrentCoverageManifest()

        expect(manifest.schemaVersion).to.equal(4)
        expect(() => validateCoverageManifestV4(manifest)).not.to.throw()
        expect(() => verifyCoverageManifestProofs(manifest, {
            root: process.cwd(),
        })).not.to.throw()
    }).timeout(10_000)

    it('publishes a recursively strict external schema and deterministic output', () => {

        assertEveryObjectSchemaIsStrict(coverageManifestSchemaV4)
        const first = JSON.stringify(createCurrentCoverageManifest())
        const second = JSON.stringify(createCurrentCoverageManifest())

        expect(second).to.equal(first)
    })

    it('fails closed on unknown fields, proof kinds, selectors, and duplicates', () => {

        const manifest = createCurrentCoverageManifest()
        const unknownField = structuredClone(manifest)
        unknownField.entries[0].proof.unknown = true
        expect(() => validateCoverageManifestV4(unknownField))
            .to.throw('unknown key')

        const unknownKind = structuredClone(manifest)
        unknownKind.entries.find(entry =>
            entry.current.status === 'managed'
        ).proof.evidence[0].kind = 'unknown-proof-kind'
        expect(() => validateCoverageManifestV4(unknownKind))
            .to.throw('unknown proof kind')

        const unknownSelector = structuredClone(manifest)
        unknownSelector.entries.find(entry =>
            entry.current.status === 'managed'
        ).proof.evidence[0].selector.unknown = true
        expect(() => validateCoverageManifestV4(unknownSelector))
            .to.throw('unknown key')

        const duplicate = structuredClone(manifest)
        const managed = duplicate.entries.find(entry =>
            entry.current.status === 'managed'
        )
        managed.proof.evidence.push(structuredClone(managed.proof.evidence[0]))
        expect(() => validateCoverageManifestV4(duplicate))
            .to.throw('duplicate proof evidence')
    })

    it('rejects raw-device-only managed paths and unbound WGSL execution proofs', () => {

        const rawOnly = structuredClone(createCurrentCoverageManifest())
        const managedWebGpu = rawOnly.entries.find(entry =>
            entry.domain === 'webgpu' &&
            entry.current.status === 'managed'
        )
        const rawEvidence = {
            kind: 'function-call',
            operation: 'createBuffer',
            sourcePath: fixturePath,
            selector: {
                member: 'createBuffer',
                receiverTypes: [ 'GPUDevice' ],
            },
        }
        managedWebGpu.nativeLowering = {
            kind: 'native-call-or-descriptor',
            sourcePaths: [ fixturePath ],
            operations: [ 'createBuffer' ],
            operationEvidence: [ rawEvidence ],
        }
        expect(() => verifyCoverageManifestProofs(rawOnly, {
            root: process.cwd(),
        })).to.throw('outside managed Scratch source')

        const unboundWgsl = structuredClone(createCurrentCoverageManifest())
        const languageExtension = unboundWgsl.entries.find(entry =>
            entry.domain === 'wgsl' &&
            entry.kind === 'language-extension'
        )
        languageExtension.proof.evidence =
            languageExtension.proof.evidence.filter(item =>
                item.kind !== 'browser-execution'
            )
        expect(() => validateCoverageManifestV4(unboundWgsl))
            .to.throw('browser execution proof')
    })

    it('requires executable browser proof for every managed WGSL entry', () => {

        const manifest = createCurrentCoverageManifest()
        const managedWgsl = manifest.entries.filter(entry =>
            entry.domain === 'wgsl' &&
            entry.current.status === 'managed'
        )

        expect(managedWgsl).to.have.length(662)
        for (const entry of managedWgsl) {
            expect(
                entry.proof.evidence.some(item =>
                    item.kind === 'browser-execution'
                ),
                entry.id
            ).to.equal(true)
        }

        const unbound = structuredClone(manifest)
        const generic = unbound.entries.find(entry =>
            entry.domain === 'wgsl' &&
            entry.proof.profile === 'wgsl-source' &&
            entry.requirements.deviceFeatures.length === 0 &&
            entry.requirements.enableExtensions.length === 0 &&
            entry.requirements.languageFeatures.length === 0 &&
            entry.requirements.limits.length === 0
        )
        generic.proof.evidence = generic.proof.evidence.filter(item =>
            item.kind !== 'browser-execution'
        )
        expect(() => validateCoverageManifestV4(unbound))
            .to.throw('browser execution proof')
    })

    it('binds browser execution results to the runner return value', () => {

        const baseSelector = {
            normativeId: 'semantic-section.types',
            proofProfile: 'wgsl-source',
            proofName: 'wgsl-source',
            contractKey: 'name',
            requiredConditions: [],
            requiredEnableExtensions: [],
            requiredFeatures: [],
            requiredLanguageFeatures: [],
            requiredLimits: [],
            requiredDependencies: [],
            runnerNames: [ 'runProfileFixture' ],
        }

        expect(() => assertStructuredEvidence(context, {
            kind: 'browser-execution',
            operation: 'correct browser dataflow',
            sourcePath: fixturePath,
            selector: {
                ...baseSelector,
                collection: 'correctProfileContracts',
                resultCollection: 'correctProfileResults',
            },
        })).not.to.throw()

        expect(() => assertStructuredEvidence(context, {
            kind: 'browser-execution',
            operation: 'wrong browser dataflow',
            sourcePath: fixturePath,
            selector: {
                ...baseSelector,
                collection: 'wrongProfileContracts',
                resultCollection: 'wrongProfileResults',
            },
        })).to.throw('did not resolve')
    })

    it('rejects WGSL payloads and capability results that are not bound', () => {

        expect(() => assertStructuredEvidence(context, {
            kind: 'wgsl-contract',
            operation: 'unbound WGSL payload',
            sourcePath:
                'packages/geoscratch/src/scratch/shader-module.ts',
            selector: {
                contractId: 'fixture.unbound',
                descriptorType: 'GPUShaderModuleDescriptor',
                payloadField: 'code',
                payloadPath: [ 'ordinaryString', 'notCompiled' ],
                nativeMember: 'createShaderModule',
                nativeReceiverTypes: [ 'GPUDevice' ],
            },
        })).to.throw('did not resolve')

        const manifest = structuredClone(createCurrentCoverageManifest())
        const subgroup = manifest.entries.find(entry =>
            entry.id === 'language-extension.subgroup_id'
        )
        subgroup.proof.evidence.find(item =>
            item.kind === 'browser-execution'
        ).selector.requiredFeatures = []
        expect(() => verifyCoverageManifestProofs(manifest, {
            root: process.cwd(),
        })).to.throw('browser proof requirements do not match')

        const wrongContract = structuredClone(
            createCurrentCoverageManifest()
        )
        const wgslEntry = wrongContract.entries.find(entry =>
            entry.domain === 'wgsl'
        )
        wgslEntry.proof.evidence.find(item =>
            item.kind === 'wgsl-contract'
        ).selector.contractId = 'semantic-section.types'
        expect(() => verifyCoverageManifestProofs(wrongContract, {
            root: process.cwd(),
        })).to.throw('WGSL contract proof does not match')
    }).timeout(10_000)

    it('rejects a valid type node assigned to the wrong normative entry', () => {

        const manifest = structuredClone(createCurrentCoverageManifest())
        const adapterInfo = manifest.entries.find(entry =>
            entry.id === 'GPUAdapterInfo.isFallbackAdapter'
        )
        const typeProof = adapterInfo.proof.evidence.find(item =>
            item.kind === 'type-member'
        )
        typeProof.selector.member = 'vendor'
        expect(() => verifyCoverageManifestProofs(manifest, {
            root: process.cwd(),
        })).to.throw('WebGPU type proof does not match')
    }).timeout(10_000)

    it('binds every adapter-info member to its exact native extraction', () => {

        const manifest = createCurrentCoverageManifest()
        const expectedKinds = new Map([
            [ 'architecture', 'function-call' ],
            [ 'description', 'function-call' ],
            [ 'device', 'function-call' ],
            [ 'isFallbackAdapter', 'property-read' ],
            [ 'subgroupMaxSize', 'function-call' ],
            [ 'subgroupMinSize', 'function-call' ],
            [ 'vendor', 'function-call' ],
        ])

        for (const [ member, kind ] of expectedKinds) {
            const entry = manifest.entries.find(candidate =>
                candidate.id === `GPUAdapterInfo.${member}`
            )
            const exact = entry.nativeLowering.operationEvidence.find(item =>
                item.operation === `adapterInfo.${member}`
            )

            expect(exact, entry.id).to.include({
                kind,
                sourcePath:
                    'packages/geoscratch/src/scratch/runtime.ts',
            })
            if (kind === 'property-read') {
                expect(exact.selector).to.deep.equal({
                    member,
                    receiverTypes: [ 'Partial<GPUAdapterInfo>' ],
                })
            } else {
                expect(exact.selector.argumentLiterals).to.deep.equal([
                    { index: 2, value: member },
                ])
            }
        }
    })

    it('rejects normative source and summary facts assigned to the wrong entry', () => {

        const wrongSource = structuredClone(createCurrentCoverageManifest())
        wrongSource.entries[0].source.anchor = 'wrong-anchor'
        expect(() => verifyCoverageManifestProofs(wrongSource, {
            root: process.cwd(),
        })).to.throw('normative source does not match')

        const wrongSummary = structuredClone(
            createCurrentCoverageManifest()
        )
        wrongSummary.summary.entryCount -= 1
        expect(() => verifyCoverageManifestProofs(wrongSummary, {
            root: process.cwd(),
        })).to.throw('summary does not match')
    }).timeout(10_000)

    it('fails closed on missing, duplicate, and misassigned inventory entries', () => {

        const missing = structuredClone(createCurrentCoverageManifest())
        missing.entries.pop()
        expect(() => verifyCoverageManifestProofs(missing, {
            root: process.cwd(),
        })).to.throw('Normative inventory closure')

        const duplicate = structuredClone(createCurrentCoverageManifest())
        duplicate.entries.push(structuredClone(duplicate.entries[0]))
        expect(() => validateCoverageManifestV4(duplicate))
            .to.throw('duplicate values')

        const misassigned = structuredClone(
            createCurrentCoverageManifest()
        )
        const entry = misassigned.entries.find(candidate =>
            candidate.domain === 'webgpu' &&
            candidate.kind === 'method'
        )
        entry.kind = 'property'
        entry.proof.selector.entryKind = 'property'
        expect(() => verifyCoverageManifestProofs(misassigned, {
            root: process.cwd(),
        })).to.throw('incorrect normative domain or kind')
    }).timeout(10_000)

    it('rejects evidence that points outside the declared repository source', () => {

        expect(() => assertStructuredEvidence(context, {
            kind: 'function-call',
            operation: 'outside-root',
            sourcePath: path.join('..', 'outside.ts'),
            selector: {
                member: 'execute',
                receiverTypes: [ 'CorrectReceiver' ],
            },
        })).to.throw('repository-relative')
    })
})

function assertEveryObjectSchemaIsStrict(schema) {

    visitSchema(schema, (node) => {
        if (node.type === 'object') {
            expect(node).to.have.own.property('additionalProperties')
        }
    })
}

function visitSchema(node, callback) {

    if (node === null || typeof node !== 'object') return
    callback(node)
    for (const value of Object.values(node)) {
        if (Array.isArray(value)) {
            value.forEach(item => visitSchema(item, callback))
        } else {
            visitSchema(value, callback)
        }
    }
}
