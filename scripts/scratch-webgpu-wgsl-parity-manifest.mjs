import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const typesPath = path.join(root, 'node_modules', '@webgpu', 'types', 'dist', 'index.d.ts')
const manifestRoot = path.join(root, 'docs', 'review', 'manifests')

export const baseline = Object.freeze({
    webgpu: Object.freeze({
        publication: 'W3C Candidate Recommendation Draft, 14 July 2026',
        url: 'https://www.w3.org/TR/2026/CRD-webgpu-20260714/',
        sha256: '23b38cef5e23be710ef865b800f63e5874edd03bb08bbecfa8ac5b3020b47d30',
    }),
    wgsl: Object.freeze({
        publication: 'W3C Candidate Recommendation Draft, 16 July 2026',
        url: 'https://www.w3.org/TR/2026/CRD-WGSL-20260716/',
        sha256: '2ae2de9464930086cb7c611951262bfd4c989a312802e30162cfd246567d66aa',
    }),
    gpuwebEditorCommit: '99d2ded3335433260fd756abacc2d2b280999b8d',
    gpuwebTypesRepositoryCommit: '9ba8a0618e1efad8e1ee444ef6ecfae761b2bc30',
    webgpuTypes: Object.freeze({
        version: '0.1.71',
        npmGitHead: 'acad56b8107ba88841b7753df5a8d7c27d33e916',
        declarationSha256: 'd2e5cfb2397ec8cacfd30de0e6f7992eb7db7b02cc83b7c43ef58bcd5aa88bc3',
    }),
})

export const classificationValues = Object.freeze([
    'managed-first-class',
    'managed-semantic-equivalent',
    'known-target-gap',
    'not-applicable',
    'newly-discovered-gap',
])

export const targetFamilies = Object.freeze([
    'external-texture',
    'render-bundle-debug',
    'shader-module-pipeline',
    'optional-fragment',
    'surface-texture-lease',
    'runtime-capabilities',
    'texture-transfer',
    'wgsl-layout',
])

const helperOwners = new Set([
    'GPUCanvasConfigurationOut',
    'GPUExtent3DDictStrict',
    'GPUOrigin2DDictStrict',
])
const helperAliases = new Set([
    'GPUAllowSharedBufferSource',
    'GPUExtent3DStrict',
    'GPUImageCopyBuffer',
    'GPUImageCopyExternalImage',
    'GPUImageCopyExternalImageSource',
    'GPUImageCopyTexture',
    'GPUImageCopyTextureTagged',
    'GPUImageDataLayout',
    'GPUOrigin2DStrict',
])
const firstClassOwnerPatterns = [
    /^GPUBuffer/,
    /^GPUTexture/,
    /^GPUSampler/,
    /^GPUQuerySet/,
    /^GPUBindGroup/,
    /^GPUPipelineLayout/,
    /^GPUCommandEncoder/,
    /^GPUComputePass/,
    /^GPURenderPass/,
    /^GPUQueue/,
    /^GPUVertex/,
    /^GPUDepthStencil/,
    /^GPUStencil/,
    /^GPUBlend/,
    /^GPUColorTarget/,
    /^GPUMultisample/,
    /^GPUPrimitive/,
    /^GPUTexelCopy/,
    /^GPUCopyExternalImage/,
    /^GPUCanvasConfiguration/,
    /^GPUCanvasToneMapping/,
]

const webGpuGapSelectors = Object.freeze([
    {
        family: 'external-texture',
        matches: entry => (
            entry.owner?.startsWith('GPUExternalTexture') ||
            entry.id === 'type.GPUBindingResource' ||
            entry.id === 'GPUBindGroupLayoutEntry.externalTexture' ||
            entry.id === 'GPUDevice.importExternalTexture'
        ),
    },
    {
        family: 'render-bundle-debug',
        matches: entry => (
            entry.owner?.startsWith('GPURenderBundle') ||
            entry.owner === 'GPUDebugCommandsMixin' ||
            entry.owner === 'GPURenderPassLayout' ||
            entry.id === 'GPUDevice.createRenderBundleEncoder' ||
            entry.id === 'GPURenderPassEncoder.executeBundles'
        ),
    },
    {
        family: 'shader-module-pipeline',
        matches: entry => (
            entry.owner?.startsWith('GPUShaderModule') ||
            entry.id === 'GPUDevice.createShaderModule' ||
            entry.id === 'GPUProgrammableStage.module' ||
            entry.id === 'GPUPipelineBase.getBindGroupLayout' ||
            entry.id === 'GPUPipelineDescriptorBase.layout' ||
            entry.id === 'type.GPUAutoLayoutMode'
        ),
    },
    {
        family: 'optional-fragment',
        matches: entry => entry.id === 'GPURenderPipelineDescriptor.fragment',
    },
    {
        family: 'surface-texture-lease',
        matches: entry => entry.id === 'GPUCanvasContext.getCurrentTexture',
    },
    {
        family: 'runtime-capabilities',
        matches: entry => (
            entry.owner === 'GPUAdapterInfo' ||
            entry.id === 'GPURequestAdapterOptions.featureLevel' ||
            entry.id === 'GPURequestAdapterOptions.xrCompatible' ||
            entry.id === 'GPUDeviceDescriptor.defaultQueue'
        ),
    },
    {
        family: 'texture-transfer',
        matches: entry => (
            entry.id === 'GPUQueue.writeTexture' ||
            entry.id === 'GPUTexelCopyTextureInfo.aspect'
        ),
    },
])

export const webGpuManifestPath = path.join(
    manifestRoot,
    'scratch-webgpu-2026-07-14.json'
)
export const wgslManifestPath = path.join(
    manifestRoot,
    'scratch-wgsl-2026-07-16.json'
)

export function createWebGpuManifest() {

    const source = fs.readFileSync(typesPath, 'utf8')
    const declarationSha256 = sha256(source)
    if (declarationSha256 !== baseline.webgpuTypes.declarationSha256) {
        throw new Error(
            `@webgpu/types declaration hash drifted: ${declarationSha256}`
        )
    }

    const sourceFile = ts.createSourceFile(
        typesPath,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS
    )
    const entries = collectWebGpuEntries(sourceFile)
        .map(entry => Object.freeze({
            ...entry,
            classification: classifyWebGpuEntry(entry),
        }))
        .sort((left, right) => left.id.localeCompare(right.id))

    return Object.freeze({
        schemaVersion: 1,
        purpose: 'Frozen managed WebGPU declaration-member capability classification',
        baseline: {
            ...baseline.webgpu,
            gpuwebEditorCommit: baseline.gpuwebEditorCommit,
            gpuwebTypesRepositoryCommit: baseline.gpuwebTypesRepositoryCommit,
            webgpuTypes: baseline.webgpuTypes,
        },
        classificationValues,
        targetFamilies: targetFamilies.slice(0, 7),
        targetCapabilities: [
            targetCapability(
                'external-texture',
                'Managed GPUExternalTexture import, binding, expiry, and provenance'
            ),
            targetCapability(
                'render-bundle-debug',
                'Native RenderBundle encoding/execution and public debug commands'
            ),
            targetCapability(
                'shader-module-pipeline',
                'First-class ShaderModule, separate stage modules, and native auto layout'
            ),
            targetCapability(
                'optional-fragment',
                'Fragmentless and no-color-output render pipelines'
            ),
            targetCapability(
                'surface-texture-lease',
                'Submission-scoped current Surface texture use beyond attachments'
            ),
            targetCapability(
                'runtime-capabilities',
                'Adapter/device/queue request parity and immutable capability facts'
            ),
            targetCapability(
                'texture-transfer',
                'Texture upload aspect, direct texture readback, and mapped readback lease'
            ),
        ],
        entries,
        summary: summarize(entries),
    })
}

export function createWgslManifest() {

    const entries = [
        ...wgslLanguageExtensionEntries(),
        ...wgslHostTypeEntries(),
        ...wgslSemanticDomainEntries(),
    ].sort((left, right) => left.id.localeCompare(right.id))

    return Object.freeze({
        schemaVersion: 1,
        purpose: 'Frozen managed WGSL language-feature and scoped type/layout classification',
        baseline: {
            ...baseline.wgsl,
            gpuwebEditorCommit: baseline.gpuwebEditorCommit,
        },
        classificationValues,
        targetFamilies: [ 'wgsl-layout' ],
        targetCapabilities: [
            targetCapability(
                'wgsl-layout',
                'Recursive host-shareable LayoutCodec and buffer_view semantic closure'
            ),
        ],
        entries,
        summary: summarize(entries),
    })
}

function collectWebGpuEntries(sourceFile) {

    const grouped = new Map()

    for (const statement of sourceFile.statements) {
        if (
            ts.isInterfaceDeclaration(statement) &&
            /^(?:GPU|NavigatorGPU|Navigator|WorkerNavigator)/.test(statement.name.text)
        ) {
            const owner = statement.name.text
            addEntry(grouped, {
                id: `interface.${owner}`,
                kind: 'interface',
                owner,
                member: undefined,
                signature: interfaceHeader(statement, sourceFile),
            })
            for (const member of statement.members) {
                const memberName = declarationName(member.name, sourceFile)
                if (memberName === undefined) continue
                addEntry(grouped, {
                    id: `${owner}.${memberName}`,
                    kind: memberKind(member),
                    owner,
                    member: memberName,
                    signature: normalizeSignature(member.getText(sourceFile)),
                })
            }
        } else if (
            ts.isTypeAliasDeclaration(statement) &&
            /^(?:GPU|WGSL)/.test(statement.name.text)
        ) {
            addEntry(grouped, {
                id: `type.${statement.name.text}`,
                kind: 'type-alias',
                owner: statement.name.text,
                member: undefined,
                signature: normalizeSignature(statement.getText(sourceFile)),
            })
        }
    }

    return Array.from(grouped.values(), entry => ({
        id: entry.id,
        kind: entry.kind,
        owner: entry.owner,
        ...(entry.member === undefined ? {} : { member: entry.member }),
        declarationCount: entry.signatures.size,
        signatureHashes: Array.from(entry.signatures)
            .sort()
            .map(signature => sha256(signature)),
    }))
}

function addEntry(grouped, input) {

    const existing = grouped.get(input.id)
    if (existing !== undefined) {
        existing.signatures.add(input.signature)
        return
    }
    grouped.set(input.id, {
        id: input.id,
        kind: input.kind,
        owner: input.owner,
        member: input.member,
        signatures: new Set([ input.signature ]),
    })
}

function classifyWebGpuEntry(entry) {

    if (entry.member === '__brand') {
        return classification(
            'not-applicable',
            undefined,
            '@webgpu/types nominal-brand helper; not a WebGPU workload capability'
        )
    }
    if (helperOwners.has(entry.owner) || helperAliases.has(entry.owner)) {
        return classification(
            'not-applicable',
            undefined,
            '@webgpu/types compatibility or strictness helper outside the normative WebGPU IDL'
        )
    }
    if (
        entry.id === 'GPUDevice.addEventListener' ||
        entry.id === 'GPUDevice.removeEventListener' ||
        entry.owner === 'Navigator' ||
        entry.owner === 'WorkerNavigator'
    ) {
        return classification(
            'not-applicable',
            undefined,
            'DOM integration glue; Scratch owns managed runtime diagnostics instead of duplicating EventTarget'
        )
    }

    const gap = webGpuGapSelectors.find(selector => selector.matches(entry))
    if (gap !== undefined) {
        return classification(
            'known-target-gap',
            gap.family,
            'Frozen baseline gap assigned to this goal'
        )
    }

    if (
        entry.owner === 'GPU' ||
        entry.owner === 'GPUAdapter' ||
        entry.owner === 'GPUDevice' ||
        entry.owner === 'GPUCanvasContext' ||
        entry.owner === 'GPURequestAdapterOptions' ||
        entry.owner === 'GPUDeviceDescriptor' ||
        firstClassOwnerPatterns.some(pattern => pattern.test(entry.owner))
    ) {
        return classification(
            'managed-first-class',
            undefined,
            'Expressed through a current Scratch runtime, resource, binding, command, pass, or submission contract'
        )
    }

    return classification(
        'managed-semantic-equivalent',
        undefined,
        'The native workload is expressible through managed Scratch composition without exposing this raw object member'
    )
}

function wgslLanguageExtensionEntries() {

    const extensions = [
        'readonly_and_readwrite_storage_textures',
        'packed_4x8_integer_dot_product',
        'unrestricted_pointer_parameters',
        'pointer_composite_access',
        'uniform_buffer_standard_layout',
        'subgroup_id',
        'subgroup_uniformity',
        'texture_and_sampler_let',
        'texture_formats_tier1',
        'linear_indexing',
        'immediate_address_space',
        'buffer_view',
    ]

    return extensions.map(name => {
        const isLayoutTarget = [
            'buffer_view',
            'uniform_buffer_standard_layout',
        ].includes(name)
        const isImmediate = name === 'immediate_address_space'
        return wgslEntry(
            `language-extension.${name}`,
            'language-extension',
            isLayoutTarget
                ? classification(
                    'known-target-gap',
                    'wgsl-layout',
                    'Program can name the feature, but LayoutCodec does not yet model its ABI interaction'
                )
                : isImmediate
                    ? classification(
                        'managed-first-class',
                        undefined,
                        'Implemented by Program requirements, pipeline immediate size, and command immediate data'
                    )
                    : classification(
                        'managed-semantic-equivalent',
                        undefined,
                        'Caller-authored WGSL and explicit Program language-feature requirements preserve native semantics'
                    )
        )
    })
}

function wgslHostTypeEntries() {

    const entries = []
    for (const scalar of [ 'i32', 'u32', 'f32', 'f16' ]) {
        entries.push(wgslEntry(
            `host-type.scalar.${scalar}`,
            'host-shareable-type',
            scalar === 'f16'
                ? layoutGap('f16 storage bytes and shader-f16 requirements are not modeled')
                : layoutManaged('Current scalar LayoutCodec support')
        ))
    }
    for (const component of [ 'i32', 'u32', 'f32', 'f16' ]) {
        for (const width of [ 2, 3, 4 ]) {
            entries.push(wgslEntry(
                `host-type.vector.vec${width}<${component}>`,
                'host-shareable-type',
                component === 'f16'
                    ? layoutGap('f16 vector ABI and feature requirements are not modeled')
                    : layoutManaged('Current numeric vector LayoutCodec support')
            ))
        }
    }
    for (const component of [ 'f32', 'f16' ]) {
        for (const columns of [ 2, 3, 4 ]) {
            for (const rows of [ 2, 3, 4 ]) {
                const current = component === 'f32' && columns === 4 && rows === 4
                entries.push(wgslEntry(
                    `host-type.matrix.mat${columns}x${rows}<${component}>`,
                    'host-shareable-type',
                    current
                        ? layoutManaged('Current mat4x4f LayoutCodec support')
                        : layoutGap('Complete matrix-shape and component ABI is not modeled')
                ))
            }
        }
    }

    for (const [ id, rationale ] of [
        [ 'host-type.structure', 'Nested recursive structures are not modeled' ],
        [ 'host-type.fixed-array', 'Arrays are limited to primitive fixed-footprint elements' ],
        [ 'host-type.runtime-array', 'Runtime-sized storage tails and binding-derived counts are not modeled' ],
        [ 'host-type.atomic-i32', 'Storage-only atomic restrictions and accessors are not modeled' ],
        [ 'host-type.atomic-u32', 'Storage-only atomic restrictions and accessors are not modeled' ],
        [ 'member-layout.align', 'Explicit @align member layout is not modeled' ],
        [ 'member-layout.size', 'Explicit @size member layout is not modeled' ],
        [ 'buffer-type.fixed', 'Fixed-size buffer<N> and buffer-view built-ins are not modeled' ],
        [ 'buffer-type.runtime', 'Runtime buffer types and dynamic bounds are not modeled' ],
        [ 'usage-compatibility.recursive', 'Recursive uniform/storage/vertex/readback/immediate compatibility is incomplete' ],
    ]) {
        entries.push(wgslEntry(id, 'layout-semantic', layoutGap(rationale)))
    }

    entries.push(wgslEntry(
        'host-type.bool',
        'non-host-layout-type',
        classification(
            'not-applicable',
            undefined,
            'WGSL bool is not an ordinary numeric host-shareable LayoutCodec field and must be rejected'
        )
    ))
    return entries
}

function wgslSemanticDomainEntries() {

    return [
        [ 'shader-domain.abstract-numerics', 'Abstract numeric values are shader-only and not host ABI fields' ],
        [ 'shader-domain.pointers-references', 'Pointers and references remain caller-authored WGSL semantics' ],
        [ 'shader-domain.textures-samplers', 'Opaque texture and sampler types belong to binding contracts' ],
        [ 'shader-domain.external-textures', 'External textures belong to binding contracts and attempt-local authority' ],
        [ 'shader-domain.control-flow', 'WGSL statements and control flow remain caller-authored source' ],
        [ 'shader-domain.functions-builtins', 'Functions and built-ins remain caller-authored source' ],
        [ 'shader-domain.entry-points', 'Entry-point language semantics remain caller-authored Program contracts' ],
        [ 'shader-domain.address-spaces', 'Non-host address-space semantics remain caller-authored WGSL' ],
    ].map(([ id, rationale ]) => wgslEntry(
        id,
        'shader-semantic-domain',
        classification('managed-semantic-equivalent', undefined, rationale)
    ))
}

function layoutManaged(rationale) {

    return classification('managed-first-class', undefined, rationale)
}

function layoutGap(rationale) {

    return classification('known-target-gap', 'wgsl-layout', rationale)
}

function wgslEntry(id, kind, entryClassification) {

    return Object.freeze({
        id,
        kind,
        classification: entryClassification,
    })
}

function targetCapability(family, description) {

    return Object.freeze({
        family,
        description,
        classification: 'known-target-gap',
    })
}

function classification(status, family, rationale) {

    return Object.freeze({
        status,
        ...(family === undefined ? {} : { family }),
        rationale,
    })
}

function summarize(entries) {

    const byClassification = Object.fromEntries(
        classificationValues.map(value => [ value, 0 ])
    )
    const byFamily = Object.fromEntries(targetFamilies.map(value => [ value, 0 ]))
    for (const entry of entries) {
        byClassification[entry.classification.status] += 1
        if (entry.classification.family !== undefined) {
            byFamily[entry.classification.family] += 1
        }
    }
    return Object.freeze({
        entryCount: entries.length,
        byClassification,
        byFamily: Object.fromEntries(
            Object.entries(byFamily).filter(([, count ]) => count > 0)
        ),
    })
}

function interfaceHeader(statement, sourceFile) {

    const heritage = statement.heritageClauses
        ?.map(clause => normalizeSignature(clause.getText(sourceFile)))
        .join(' ') ?? ''
    return normalizeSignature(`interface ${statement.name.text} ${heritage}`)
}

function declarationName(name, sourceFile) {

    if (name === undefined) return undefined
    if (
        ts.isIdentifier(name) ||
        ts.isStringLiteral(name) ||
        ts.isNumericLiteral(name)
    ) return name.text
    return normalizeSignature(name.getText(sourceFile))
}

function memberKind(member) {

    if (ts.isMethodSignature(member)) return 'method'
    if (ts.isPropertySignature(member)) return 'property'
    if (ts.isCallSignatureDeclaration(member)) return 'call'
    if (ts.isIndexSignatureDeclaration(member)) return 'index'
    return ts.SyntaxKind[member.kind]
}

function normalizeSignature(value) {

    return value.replace(/\s+/g, ' ').trim()
}

function sha256(value) {

    return crypto.createHash('sha256').update(value).digest('hex')
}

function writeManifest(targetPath, manifest) {

    fs.mkdirSync(path.dirname(targetPath), { recursive: true })
    fs.writeFileSync(targetPath, `${JSON.stringify(manifest)}\n`)
}

if (process.argv.includes('--write')) {
    writeManifest(webGpuManifestPath, createWebGpuManifest())
    writeManifest(wgslManifestPath, createWgslManifest())
}
