import crypto from 'node:crypto'
import ts from 'typescript'

export const normativeBaseline = Object.freeze({
    observedOn: '2026-07-25',
    gpuwebCommit: 'b33e6efb182d11156851271586563cc77575059c',
    gpuwebTypesCommit:
        '9ba8a0618e1efad8e1ee444ef6ecfae761b2bc30',
    refreshAttempt: Object.freeze({
        status: 'partial',
        retryCount: 0,
        failedSource: 'gpuweb/types raw declaration',
        reason:
            'The single bounded refresh reached official publication and repository metadata, then the raw gpuweb/types request timed out. No network retry is permitted by the Goal.',
    }),
    webgpu: Object.freeze({
        publication:
            'W3C Candidate Recommendation Draft, 14 July 2026',
        publicationUrl:
            'https://www.w3.org/TR/2026/CRD-webgpu-20260714/',
        publicationSha256:
            '23b38cef5e23be710ef865b800f63e5874edd03bb08bbecfa8ac5b3020b47d30',
        repositoryUrl: 'https://github.com/gpuweb/gpuweb',
        files: Object.freeze([
            Object.freeze({
                path: 'spec/index.bs',
                sha256:
                    '39beba36023c6b9081c2a45f4e01db3fcb555517d350d5d30910dc91f0b3e408',
            }),
            Object.freeze({
                path: 'spec/sections/copies.bs',
                sha256:
                    'ff03e128d21f18ecbb30b9fea9e3fbd61718c73cc6636ace718907a4cebcf1d8',
            }),
            Object.freeze({
                path: 'spec/sections/privacy-and-security.bs',
                sha256:
                    '9e1bcc0389d21fea6015ed72377fe94f012f4aa07cff32c0d1bc0bde03cc4b2c',
            }),
        ]),
    }),
    wgsl: Object.freeze({
        publication:
            'W3C Candidate Recommendation Draft, 16 July 2026',
        publicationUrl:
            'https://www.w3.org/TR/2026/CRD-WGSL-20260716/',
        publicationSha256:
            '2ae2de9464930086cb7c611951262bfd4c989a312802e30162cfd246567d66aa',
        repositoryUrl: 'https://github.com/gpuweb/gpuweb',
        files: Object.freeze([
            Object.freeze({
                path: 'wgsl/index.bs',
                sha256:
                    '73b68a97453b8b385535f63772bfdba067a86e617cbe3725adc0f3e2d02b0e2d',
            }),
        ]),
    }),
    types: Object.freeze({
        package: '@webgpu/types',
        packageVersion: '0.1.71',
        repositoryUrl: 'https://github.com/gpuweb/types',
        files: Object.freeze([
            Object.freeze({
                path: 'dist/index.d.ts',
                sha256:
                    'd2e5cfb2397ec8cacfd30de0e6f7992eb7db7b02cc83b7c43ef58bcd5aa88bc3',
            }),
        ]),
    }),
    proposals: Object.freeze({
        repositoryUrl:
            'https://github.com/gpuweb/gpuweb/tree/b33e6efb182d11156851271586563cc77575059c/proposals',
        files: Object.freeze([
            Object.freeze({
                path: 'proposals/README.md',
                sha256:
                    '25d168b6796672bb1037933cddc31468fd10f7b7aa2f2196b7681d9f20213018',
            }),
        ]),
    }),
})

const webGpuOwnerPattern =
    /^(?:GPU|WGSL|NavigatorGPU|Navigator|WorkerNavigator)/

const wgslRequiredFamilies = Object.freeze([
    'access-modes',
    'address-spaces',
    'attributes',
    'built-in-functions',
    'built-in-values',
    'capability-rules',
    'control-flow',
    'declarations',
    'diagnostics',
    'directives',
    'enable-extensions',
    'entry-points',
    'interpolation',
    'language-extensions',
    'layouts',
    'limits',
    'shader-interface',
    'textures-formats',
    'types',
])

export function extractWebGpuIdlEntries(source) {

    assertSource(source, 'WebGPU IDL')
    const entries = new Map()
    const unresolved = []
    const blocks = extractIdlBlocks(source)

    if (blocks.length === 0) {
        unresolved.push({
            reason: 'missing-idl-blocks',
            sourceAnchor: 'webgpu-idl',
        })
    }

    for (const block of blocks) {
        const clean = stripIdlComments(block.source)
        const consumedRanges = []
        const definitionPattern =
            /\b(partial\s+)?(callback\s+interface|interface\s+mixin|interface|dictionary|namespace|enum)\s+([A-Za-z_]\w*)[^{};]*\{/g
        let match
        while ((match = definitionPattern.exec(clean)) !== null) {
            const openIndex = clean.indexOf('{', match.index)
            const closeIndex = findMatchingDelimiter(clean, openIndex, '{', '}')
            if (closeIndex === -1) {
                unresolved.push({
                    reason: 'unterminated-idl-definition',
                    owner: match[3],
                    sourceAnchor: block.sourceAnchor,
                })
                break
            }
            const declarationEnd = findDeclarationEnd(clean, closeIndex + 1)
            consumedRanges.push([ match.index, declarationEnd ])
            const declarationKind = match[2]
            const owner = match[3]
            const ownerKind = declarationKind === 'enum'
                ? 'enum'
                : declarationKind === 'dictionary'
                    ? 'dictionary'
                    : declarationKind.includes('mixin')
                        ? 'interface-mixin'
                        : declarationKind
            addIdentity(entries, {
                id: declarationKind === 'enum'
                    ? `type.${owner}`
                    : `interface.${owner}`,
                kind: declarationKind === 'enum'
                    ? 'type-alias'
                    : 'interface',
                owner,
                sourceKind: ownerKind,
                sourceAnchor: block.sourceAnchor,
                crossSourceComparable: true,
            })

            if (declarationKind !== 'enum') {
                const body = clean.slice(openIndex + 1, closeIndex)
                for (const memberSource of splitTopLevel(body, ';')) {
                    const member = parseIdlMember(memberSource)
                    if (member === undefined) continue
                    if (member.unsupported !== undefined) {
                        unresolved.push({
                            reason: 'unsupported-idl-member',
                            owner,
                            sourceAnchor: block.sourceAnchor,
                            source: normalizeWhitespace(member.unsupported),
                        })
                        continue
                    }
                    addIdentity(entries, {
                        id: `${owner}.${member.name}`,
                        kind: member.kind,
                        owner,
                        member: member.name,
                        sourceKind: member.sourceKind,
                        sourceAnchor: block.sourceAnchor,
                        crossSourceComparable:
                            member.crossSourceComparable !== false,
                    })
                }
            }
            definitionPattern.lastIndex = declarationEnd
        }

        const remainder = maskRanges(clean, consumedRanges)
        for (const typedef of remainder.matchAll(
            /\btypedef\s+[^;{}]+\s+([A-Za-z_]\w*)\s*;/g
        )) {
            addIdentity(entries, {
                id: `type.${typedef[1]}`,
                kind: 'type-alias',
                owner: typedef[1],
                sourceKind: 'typedef',
                sourceAnchor: block.sourceAnchor,
                crossSourceComparable: true,
            })
        }
        for (const callback of remainder.matchAll(
            /\bcallback\s+(?!interface\b)([A-Za-z_]\w*)\s*=[^;]+;/g
        )) {
            addIdentity(entries, {
                id: `type.${callback[1]}`,
                kind: 'type-alias',
                owner: callback[1],
                sourceKind: 'callback',
                sourceAnchor: block.sourceAnchor,
                crossSourceComparable: true,
            })
        }
        for (const include of remainder.matchAll(
            /\b([A-Za-z_]\w*)\s+includes\s+([A-Za-z_]\w*)\s*;/g
        )) {
            addIdentity(entries, {
                id: `includes.${include[1]}.${include[2]}`,
                kind: 'includes',
                owner: include[1],
                member: include[2],
                sourceKind: 'includes',
                sourceAnchor: block.sourceAnchor,
                crossSourceComparable: false,
            })
        }
    }

    return {
        entries: finalizeIdentities(entries),
        unresolved: sortUnresolved(unresolved),
    }
}

export function extractWebGpuTypesEntries(source) {

    assertSource(source, '@webgpu/types declarations')
    const entries = new Map()
    const unresolved = []
    const sourceFile = ts.createSourceFile(
        'index.d.ts',
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS
    )

    for (const diagnostic of sourceFile.parseDiagnostics) {
        unresolved.push({
            reason: 'typescript-parse-diagnostic',
            sourceAnchor: 'types-index',
            message: ts.flattenDiagnosticMessageText(
                diagnostic.messageText,
                '\n'
            ),
        })
    }

    for (const statement of sourceFile.statements) {
        if (
            ts.isInterfaceDeclaration(statement) &&
            webGpuOwnerPattern.test(statement.name.text)
        ) {
            const owner = statement.name.text
            addIdentity(entries, {
                id: `interface.${owner}`,
                kind: 'interface',
                owner,
                sourceKind: 'typescript-interface',
                sourceAnchor: 'types-index',
                crossSourceComparable: true,
            })
            for (const member of statement.members) {
                const name = typesDeclarationName(member.name, sourceFile)
                if (name === undefined) {
                    unresolved.push({
                        reason: 'unsupported-types-member-name',
                        owner,
                        sourceAnchor: 'types-index',
                        source: normalizeWhitespace(member.getText(sourceFile)),
                    })
                    continue
                }
                const helper = name === '__brand'
                addIdentity(entries, {
                    id: `${owner}.${name}`,
                    kind: typesMemberKind(member),
                    owner,
                    member: name,
                    sourceKind: 'typescript-member',
                    sourceAnchor: 'types-index',
                    crossSourceComparable: !helper,
                    helper,
                })
            }
        } else if (
            ts.isTypeAliasDeclaration(statement) &&
            /^(?:GPU|WGSL)/.test(statement.name.text)
        ) {
            addIdentity(entries, {
                id: `type.${statement.name.text}`,
                kind: 'type-alias',
                owner: statement.name.text,
                sourceKind: 'typescript-type-alias',
                sourceAnchor: 'types-index',
                crossSourceComparable: true,
            })
        }
    }

    return {
        entries: finalizeIdentities(entries),
        unresolved: sortUnresolved(unresolved),
    }
}

export function compareWebGpuNormativeSources(specEntries, typesEntries) {

    const specIds = comparableIds(specEntries)
    const typesIds = comparableIds(typesEntries)
    const specOnlyIds = difference(specIds, typesIds)
    const typesOnlyIds = difference(typesIds, specIds)
    const matchedIds = intersection(specIds, typesIds)

    return {
        status:
            specOnlyIds.length === 0 && typesOnlyIds.length === 0
                ? 'matched'
                : 'unresolved',
        matchedIds,
        specOnlyIds,
        typesOnlyIds,
        ignoredSpecIds: ignoredIds(specEntries),
        ignoredTypesIds: ignoredIds(typesEntries),
    }
}

export function extractWgslNormativeEntries(source) {

    assertSource(source, 'WGSL specification')
    const entries = new Map()
    const unresolved = []
    const headings = extractHeadings(source)
    const requirementReferences = []

    for (const heading of headings) {
        if (isExplicitNamedUnitHeading(heading)) continue

        addWgslEntry(entries, {
            id: `semantic-section.${heading.anchor}`,
            kind: 'semantic-section',
            family: wgslSectionFamily(heading.anchor, heading.title),
            name: stripMarkup(heading.title),
            sourceAnchor: heading.anchor,
            sourceIndex: heading.index,
        })
    }

    for (const grammar of source.matchAll(
        /path:\s*syntax\/([A-Za-z0-9_]+)\.syntax\.bs\.include/g
    )) {
        const name = grammar[1]
        addWgslEntry(entries, {
            id: `grammar.${name}`,
            kind: 'grammar-production',
            family: grammarFamily(name),
            name,
            sourceAnchor: nearestHeadingAnchor(headings, grammar.index),
            sourceIndex: grammar.index,
        })
    }

    const enableTable = extractCaptionTable(source, 'Enable-extensions')
    if (enableTable === undefined) {
        unresolved.push({
            reason: 'missing-wgsl-enable-extension-table',
            sourceAnchor: 'enable-extensions-sec',
        })
    } else {
        for (const row of splitHtmlRows(enableTable.source)) {
            const name = extractDfnName(row, 'extension')
            if (name === undefined) continue
            const feature = extractFeatureName(row)
            if (feature === undefined) {
                unresolved.push({
                    reason: 'missing-enable-extension-feature',
                    name,
                    sourceAnchor: `extension-${name}`,
                })
                continue
            }
            const companions = uniqueSorted(
                [ ...row.matchAll(/\[=extension\/([A-Za-z0-9_]+)=\]/g) ]
                    .map(match => match[1])
                    .filter(value => value !== name)
            )
            const requirements = emptyRequirements()
            requirements.enableExtensions = [ name ]
            requirements.deviceFeatures = [ feature ]
            requirements.dependencies = companions.map(companion => ({
                kind: 'enable-extension-companion',
                extension: name,
                requiredExtension: companion,
            }))
            addWgslEntry(entries, {
                id: `enable-extension.${name}`,
                kind: 'enable-extension',
                family: 'enable-extensions',
                name,
                sourceAnchor: `extension-${name}`,
                sourceIndex: enableTable.index,
                requirements,
                description: normalizedCellText(row),
            })
            requirementReferences.push({
                row,
                requirements,
                sourceIndex: enableTable.index,
            })
        }
    }

    const languageTable = extractCaptionTable(source, 'Language extensions')
    if (languageTable === undefined) {
        unresolved.push({
            reason: 'missing-wgsl-language-extension-table',
            sourceAnchor: 'language-extensions-sec',
        })
    } else {
        for (const row of splitHtmlRows(languageTable.source)) {
            const name = extractDfnName(row, 'language_extension')
            if (name === undefined) continue
            const requirements = emptyRequirements()
            requirements.languageFeatures = [ name ]
            addWgslEntry(entries, {
                id: `language-extension.${name}`,
                kind: 'language-extension',
                family: 'language-extensions',
                name,
                sourceAnchor: `language_extension-${name}`,
                sourceIndex: languageTable.index,
                requirements,
                description: normalizedCellText(row),
            })
            requirementReferences.push({
                row,
                requirements,
                sourceIndex: languageTable.index,
            })
        }
    }

    for (const match of source.matchAll(
        /<dfn\b[^>]*dfn-for=(?:"|')?attribute(?:"|')?[^>]*>([\s\S]*?)<\/dfn>/gi
    )) {
        const name = stripMarkup(match[1])
        addWgslEntry(entries, namedWgslEntry(
            'attribute',
            'attribute',
            'attributes',
            name,
            attributeAnchor(name),
            match.index
        ))
    }

    for (const match of source.matchAll(
        /<dfn\b[^>]*dfn-for=(?:"|')?built-in values(?:"|')?[^>]*>([\s\S]*?)<\/dfn>/gi
    )) {
        const name = stripMarkup(match[1])
        addWgslEntry(entries, namedWgslEntry(
            'built-in-value',
            'built-in-value',
            'built-in-values',
            name,
            builtInValueAnchor(name),
            match.index
        ))
    }

    for (const match of source.matchAll(
        /<dfn\b[^>]*dfn-for=(?:"|')?access(?:"|')?[^>]*>([\s\S]*?)<\/dfn>/gi
    )) {
        const name = stripMarkup(match[1])
        addWgslEntry(entries, namedWgslEntry(
            'access-mode',
            'access-mode',
            'access-modes',
            name,
            'memory-access-mode',
            match.index
        ))
    }

    for (const match of source.matchAll(
        /<dfn\b[^>]*dfn-for=(?:"|')?address spaces(?:"|')?[^>]*>([\s\S]*?)<\/dfn>/gi
    )) {
        const name = stripMarkup(match[1])
        addWgslEntry(entries, namedWgslEntry(
            'address-space',
            'address-space',
            'address-spaces',
            name,
            'address-space',
            match.index
        ))
    }

    const texelNames = new Set()
    for (const match of source.matchAll(
        /\[=texel format\/([A-Za-z0-9_]+)=\]/g
    )) {
        texelNames.add(match[1])
    }
    for (const match of source.matchAll(
        /<dfn\b[^>]*dfn-for=(?:"|')?texel format(?:"|')?[^>]*>([\s\S]*?)<\/dfn>/gi
    )) {
        texelNames.add(stripMarkup(match[1]))
    }
    for (const name of [ ...texelNames ].sort()) {
        addWgslEntry(entries, namedWgslEntry(
            'texel-format',
            'texel-format',
            'textures-formats',
            name,
            'texel-formats',
            source.indexOf(`texel format/${name}`)
        ))
    }

    for (const heading of headings) {
        const builtInName = backtickName(heading.title)
        if (
            builtInName === undefined ||
            !heading.anchor.toLowerCase().includes('builtin') ||
            heading.anchor.toLowerCase().includes('builtin-value')
        ) {
            continue
        }
        addWgslEntry(entries, namedWgslEntry(
            'built-in-function',
            'built-in-function',
            'built-in-functions',
            builtInName,
            heading.anchor,
            heading.index
        ))
    }

    applyReferencedRequirements(
        entries,
        headings,
        requirementReferences
    )
    applyImplicitNamedRequirements(entries)

    const result = {
        entries: finalizeWgslEntries(entries),
        unresolved: sortUnresolved(unresolved),
    }
    return result
}

export function extractProposalWatchlistEntries(source) {

    assertSource(source, 'GPUWeb proposal index')
    const entries = []
    for (const status of [ 'merged', 'draft', 'inactive', 'obsolete' ]) {
        const marker = `<!-- SECTION status-${status} -->`
        const start = source.indexOf(marker)
        if (start === -1) continue
        const next = source.indexOf('<!-- SECTION status-', start + marker.length)
        const section = source.slice(
            start + marker.length,
            next === -1 ? source.length : next
        )
        for (const match of section.matchAll(
            /^\s*\*\s+\[([^\]]+)\]\(([^)]+)\)\s*$/gm
        )) {
            entries.push({
                id: match[1],
                status,
                href: match[2],
            })
        }
    }
    return entries
}

export function validateNormativeInventory(inventory) {

    if (
        inventory === null ||
        typeof inventory !== 'object' ||
        !Array.isArray(inventory.entries) ||
        !Array.isArray(inventory.unresolved)
    ) {
        throw new TypeError('Normative inventory must contain entries and unresolved arrays')
    }
    const ids = new Set()
    for (const entry of inventory.entries) {
        if (
            typeof entry.id !== 'string' ||
            entry.id.length === 0 ||
            typeof entry.kind !== 'string' ||
            entry.kind.length === 0 ||
            typeof entry.sourceAnchor !== 'string' ||
            entry.sourceAnchor.length === 0
        ) {
            throw new Error('Normative inventory contains an incomplete entry')
        }
        if (ids.has(entry.id)) {
            throw new Error(`Duplicate normative inventory entry: ${entry.id}`)
        }
        ids.add(entry.id)
    }

    if (inventory.domain === 'wgsl') {
        const families = new Set(
            inventory.entries.map(entry => entry.family)
        )
        const missing = wgslRequiredFamilies.filter(
            family => !families.has(family)
        )
        if (missing.length > 0) {
            throw new Error(
                `WGSL normative inventory is missing required families: ${missing.join(', ')}`
            )
        }
    }
    return inventory
}

export function createNormativeInventoryManifest({
    id,
    domain,
    source,
    extraction,
    comparison,
}) {

    if (typeof id !== 'string' || id.length === 0) {
        throw new TypeError('Normative inventory manifest id is required')
    }
    if (!new Set([ 'webgpu', 'wgsl' ]).has(domain)) {
        throw new TypeError(`Unsupported normative inventory domain: ${domain}`)
    }
    validateManifestSource(source)
    validateNormativeInventory({
        domain,
        entries: extraction.entries,
        unresolved: extraction.unresolved,
    })

    const unresolvedCount =
        extraction.unresolved.length +
        (comparison?.status === 'unresolved'
            ? comparison.specOnlyIds.length + comparison.typesOnlyIds.length
            : 0)
    const byKind = countBy(extraction.entries, entry => entry.kind)
    const byFamily = countBy(extraction.entries, entry => entry.family)
    return {
        schemaVersion: 2,
        id,
        domain,
        status: unresolvedCount === 0 ? 'complete' : 'unresolved',
        source: sortObjectKeys(source),
        ...(comparison === undefined
            ? {}
            : { crossSourceComparison: comparison }),
        entries: extraction.entries,
        unresolved: extraction.unresolved,
        summary: {
            entryCount: extraction.entries.length,
            unresolvedCount,
            enableExtensionCount: byKind['enable-extension'] ?? 0,
            languageExtensionCount: byKind['language-extension'] ?? 0,
            byKind,
            byFamily,
        },
    }
}

export function canonicalManifestJson(value) {

    return `${JSON.stringify(sortObjectKeys(value))}\n`
}

export function sha256(value) {

    return crypto.createHash('sha256').update(value).digest('hex')
}

function extractIdlBlocks(source) {

    const headings = extractHeadings(source)
    const blocks = []
    for (const match of source.matchAll(
        /<script\s+type=(?:"|')?idl(?:"|')?[^>]*>([\s\S]*?)<\/script>/gi
    )) {
        blocks.push({
            source: match[1],
            sourceAnchor: nearestHeadingAnchor(headings, match.index),
        })
    }
    return blocks
}

function parseIdlMember(source) {

    let value = stripExtendedAttributes(source).trim()
    if (value.length === 0) return undefined

    const attribute = value.match(
        /^(?:stringifier\s+)?(?:readonly\s+)?attribute\s+[\s\S]*?\s+([A-Za-z_]\w*)$/
    )
    if (attribute !== null) {
        return {
            name: attribute[1],
            kind: 'property',
            sourceKind: 'attribute',
        }
    }

    const constant = value.match(
        /^const\s+[\s\S]*?\s+([A-Za-z_]\w*)\s*=[\s\S]+$/
    )
    if (constant !== null) {
        return {
            name: constant[1],
            kind: 'property',
            sourceKind: 'constant',
        }
    }

    if (/^(?:readonly\s+)?(?:setlike|maplike|iterable)\s*</.test(value)) {
        const collectionKind = value.match(
            /(?:setlike|maplike|iterable)/
        )[0]
        return {
            name: `[[${collectionKind}]]`,
            kind: 'collection',
            sourceKind: collectionKind,
            crossSourceComparable: false,
        }
    }

    if (value.includes('(') && value.endsWith(')')) {
        const open = value.indexOf('(')
        const prefix = value.slice(0, open)
        const methodName = prefix.match(/([A-Za-z_]\w*)\s*$/)
        if (methodName !== null) {
            return {
                name: methodName[1],
                kind: 'method',
                sourceKind: 'operation',
            }
        }
    }

    const dictionaryMember = value
        .replace(/^required\s+/, '')
        .replace(/\s*=[\s\S]*$/, '')
        .match(/([A-Za-z_]\w*)\s*$/)
    if (
        dictionaryMember !== null &&
        !/^(?:serializer|stringifier|legacycaller)\b/.test(value)
    ) {
        return {
            name: dictionaryMember[1],
            kind: 'property',
            sourceKind: 'dictionary-member',
        }
    }

    return { unsupported: value }
}

function stripExtendedAttributes(value) {

    let result = value.trim()
    while (result.startsWith('[')) {
        const close = findMatchingDelimiter(result, 0, '[', ']')
        if (close === -1) return result
        result = result.slice(close + 1).trim()
    }
    return result
}

function addIdentity(entries, input) {

    const existing = entries.get(input.id)
    if (existing === undefined) {
        entries.set(input.id, {
            ...input,
            declarationCount: 1,
            sourceAnchors: new Set([ input.sourceAnchor ]),
        })
        return
    }
    existing.declarationCount += 1
    existing.sourceAnchors.add(input.sourceAnchor)
    existing.crossSourceComparable =
        existing.crossSourceComparable && input.crossSourceComparable
}

function finalizeIdentities(entries) {

    return [ ...entries.values() ]
        .map(entry => ({
            id: entry.id,
            kind: entry.kind,
            owner: entry.owner,
            ...(entry.member === undefined ? {} : { member: entry.member }),
            sourceKind: entry.sourceKind,
            sourceAnchor: [ ...entry.sourceAnchors ].sort()[0],
            sourceAnchors: [ ...entry.sourceAnchors ].sort(),
            declarationCount: entry.declarationCount,
            crossSourceComparable: entry.crossSourceComparable,
            ...(entry.helper === true ? { helper: true } : {}),
        }))
        .sort(compareIds)
}

function addWgslEntry(entries, input) {

    if (
        typeof input.name === 'string' &&
        input.name.length === 0
    ) {
        return
    }
    const requirements = normalizeRequirements(
        input.requirements ?? emptyRequirements()
    )
    const existing = entries.get(input.id)
    if (existing === undefined) {
        entries.set(input.id, {
            ...input,
            sourceAnchors: new Set([ input.sourceAnchor ]),
            requirements,
        })
        return
    }
    existing.sourceAnchors.add(input.sourceAnchor)
    existing.requirements = mergeRequirements(
        existing.requirements,
        requirements
    )
}

function finalizeWgslEntries(entries) {

    return [ ...entries.values() ]
        .map(entry => ({
            id: entry.id,
            kind: entry.kind,
            family: entry.family,
            name: entry.name,
            sourceAnchor: [ ...entry.sourceAnchors ].sort()[0],
            sourceAnchors: [ ...entry.sourceAnchors ].sort(),
            requirements: normalizeRequirements(entry.requirements),
            ...(entry.description === undefined
                ? {}
                : { description: entry.description }),
        }))
        .sort(compareIds)
}

function namedWgslEntry(
    prefix,
    kind,
    family,
    name,
    sourceAnchor,
    sourceIndex
) {

    return {
        id: `${prefix}.${name}`,
        kind,
        family,
        name,
        sourceAnchor,
        sourceIndex,
    }
}

function applyReferencedRequirements(entries, headings, references) {

    for (const reference of references) {
        const directAnchors = [
            ...reference.row.matchAll(/\[\[#([^|\]]+)/g),
        ].map(match => match[1])
        const namedIds = semanticReferenceIds(reference.row)

        for (const entry of entries.values()) {
            if (
                directAnchors.includes(entry.sourceAnchor) ||
                entry.sourceAnchors !== undefined &&
                    directAnchors.some(anchor => entry.sourceAnchors.has(anchor)) ||
                namedIds.has(entry.id) ||
                directAnchors.some(anchor =>
                    sourceIndexIsWithinSection(
                        entry.sourceIndex,
                        anchor,
                        headings,
                        reference.row
                    )
                )
            ) {
                entry.requirements = mergeRequirements(
                    entry.requirements,
                    reference.requirements
                )
            }
        }
    }
}

function sourceIndexIsWithinSection(index, anchor, headings) {

    if (!Number.isInteger(index)) return false
    const sectionIndex = headings.findIndex(
        heading => heading.anchor === anchor
    )
    if (sectionIndex === -1) return false
    const section = headings[sectionIndex]
    const next = headings.slice(sectionIndex + 1).find(
        heading => heading.level <= section.level
    )
    return index >= section.index &&
        index < (next?.index ?? Number.POSITIVE_INFINITY)
}

function semanticReferenceIds(source) {

    const ids = new Set()
    const mappings = [
        [ /attribute\/([A-Za-z0-9_]+)/g, 'attribute' ],
        [ /built-in values\/([A-Za-z0-9_]+)/g, 'built-in-value' ],
        [ /address spaces\/([A-Za-z0-9_]+)/g, 'address-space' ],
        [ /access\/([A-Za-z0-9_]+)/g, 'access-mode' ],
        [ /texel format\/([A-Za-z0-9_]+)/g, 'texel-format' ],
    ]
    for (const [ pattern, prefix ] of mappings) {
        for (const match of source.matchAll(pattern)) {
            ids.add(`${prefix}.${match[1]}`)
        }
    }
    return ids
}

function applyImplicitNamedRequirements(entries) {

    const f16 = emptyRequirements()
    f16.enableExtensions = [ 'f16' ]
    f16.deviceFeatures = [ 'shader-f16' ]
    for (const entry of entries.values()) {
        if (
            entry.name === 'f16' ||
            entry.id.includes('<f16>') ||
            entry.id.includes('.f16')
        ) {
            entry.requirements = mergeRequirements(entry.requirements, f16)
        }
        if (
            entry.id === 'address-space.immediate' ||
            entry.id === 'semantic-section.immediate-address-space'
        ) {
            const immediate = emptyRequirements()
            immediate.languageFeatures = [ 'immediate_address_space' ]
            entry.requirements = mergeRequirements(
                entry.requirements,
                immediate
            )
        }
    }
}

function emptyRequirements() {

    return {
        enableExtensions: [],
        languageFeatures: [],
        deviceFeatures: [],
        limits: [],
        dependencies: [],
        conditions: [],
    }
}

function normalizeRequirements(requirements) {

    return {
        enableExtensions: uniqueSorted(requirements.enableExtensions ?? []),
        languageFeatures: uniqueSorted(requirements.languageFeatures ?? []),
        deviceFeatures: uniqueSorted(requirements.deviceFeatures ?? []),
        limits: uniqueSorted(requirements.limits ?? []),
        dependencies: uniqueObjects(requirements.dependencies ?? []),
        conditions: uniqueObjects(requirements.conditions ?? []),
    }
}

function mergeRequirements(left, right) {

    return normalizeRequirements({
        enableExtensions: [
            ...left.enableExtensions,
            ...right.enableExtensions,
        ],
        languageFeatures: [
            ...left.languageFeatures,
            ...right.languageFeatures,
        ],
        deviceFeatures: [
            ...left.deviceFeatures,
            ...right.deviceFeatures,
        ],
        limits: [ ...left.limits, ...right.limits ],
        dependencies: [ ...left.dependencies, ...right.dependencies ],
        conditions: [ ...left.conditions, ...right.conditions ],
    })
}

function extractHeadings(source) {

    const headings = []
    for (const match of source.matchAll(
        /^(#{1,6})\s+(.+?)\s+\{#([A-Za-z0-9_.:-]+)\}\s*$/gm
    )) {
        headings.push({
            level: match[1].length,
            title: match[2],
            anchor: match[3],
            index: match.index,
        })
    }
    return headings
}

function isExplicitNamedUnitHeading(heading) {

    const anchor = heading.anchor.toLowerCase()
    return (
        anchor.endsWith('-attr') ||
        anchor.includes('builtin-value') ||
        (
            anchor.includes('builtin') &&
            backtickName(heading.title) !== undefined
        )
    )
}

function wgslSectionFamily(anchor, title) {

    const value = `${anchor} ${title}`.toLowerCase()
    if (/enable-extension/.test(value)) return 'capability-rules'
    if (/language-extension|extension/.test(value)) return 'capability-rules'
    if (/directive/.test(value)) return 'directives'
    if (/diagnostic/.test(value)) return 'diagnostics'
    if (/limit/.test(value)) return 'limits'
    if (/interpolat/.test(value)) return 'interpolation'
    if (/shader-interface|resource-interface|inputs-outputs/.test(value)) {
        return 'shader-interface'
    }
    if (/entry-point|shader-stage/.test(value)) return 'entry-points'
    if (/memory-layout|alignment-and-size|layout-constraint|runtime-sized-array/.test(value)) {
        return 'layouts'
    }
    if (/address-space/.test(value)) return 'address-spaces'
    if (/access-mode/.test(value)) return 'access-modes'
    if (/texture|sampler|texel-format/.test(value)) return 'textures-formats'
    if (/type|memory-view|host-shareable|storable/.test(value)) return 'types'
    if (/statement|control-flow|behaviors/.test(value)) return 'control-flow'
    if (/declaration|scope|function/.test(value)) return 'declarations'
    if (/attribute/.test(value)) return 'attributes'
    if (/built-in value/.test(value)) return 'built-in-values'
    if (/built-in function/.test(value)) return 'built-in-functions'
    return 'language-semantics'
}

function grammarFamily(name) {

    if (name.includes('directive')) return 'directives'
    if (name.includes('attr')) return 'attributes'
    if (
        name.includes('statement') ||
        name.includes('clause') ||
        name.includes('continuing')
    ) {
        return 'control-flow'
    }
    if (
        name.includes('decl') ||
        name === 'param' ||
        name === 'param_list'
    ) {
        return 'declarations'
    }
    if (name.includes('type')) return 'types'
    return 'language-semantics'
}

function extractCaptionTable(source, caption) {

    const captionIndex = source.indexOf(`<caption>${caption}</caption>`)
    if (captionIndex === -1) return undefined
    const start = source.lastIndexOf('<table', captionIndex)
    const end = source.indexOf('</table>', captionIndex)
    if (start === -1 || end === -1) return undefined
    return {
        source: source.slice(start, end + '</table>'.length),
        index: start,
    }
}

function splitHtmlRows(table) {

    return table
        .split(/<tr\b[^>]*>/i)
        .slice(1)
}

function extractDfnName(row, owner) {

    const pattern = new RegExp(
        `<dfn\\b[^>]*(?:dfn-for|for)=(?:\"|')?${owner}(?:\"|')?[^>]*>([\\s\\S]*?)<\\/dfn>`,
        'i'
    )
    const match = row.match(pattern)
    return match === null ? undefined : stripMarkup(match[1])
}

function extractFeatureName(row) {

    const cells = row.split(/<td\b[^>]*>/i).slice(1)
    const featureCell = cells[1] ?? ''
    const patterns = [
        /GPUFeatureName\/["']([^"']+)["']/,
        /\|\s*["']([^"']+)["']/,
        /["']([a-z0-9]+(?:-[a-z0-9]+)+)["']/,
    ]
    for (const pattern of patterns) {
        const match = featureCell.match(pattern)
        if (match !== null) return match[1]
    }
    return undefined
}

function normalizedCellText(row) {

    return normalizeWhitespace(stripMarkup(row))
}

function attributeAnchor(name) {

    return `${name.replaceAll('_', '-')}-attr`
}

function builtInValueAnchor(name) {

    return `${name.replaceAll('_', '-')}-builtin-value`
}

function backtickName(title) {

    return title.match(/`([^`]+)`/)?.[1]
}

function stripMarkup(value) {

    return decodeEntities(value)
        .replace(/<[^>]+>/g, '')
        .replaceAll('`', '')
        .replace(/^["']|["']$/g, '')
        .trim()
}

function decodeEntities(value) {

    return value
        .replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>')
        .replaceAll('&amp;', '&')
        .replaceAll('&quot;', '"')
}

function nearestHeadingAnchor(headings, index) {

    let result = 'spec-root'
    for (const heading of headings) {
        if (heading.index > index) break
        result = heading.anchor
    }
    return result
}

function findMatchingDelimiter(source, start, open, close) {

    let depth = 0
    let quote
    for (let index = start; index < source.length; index += 1) {
        const character = source[index]
        if (quote !== undefined) {
            if (character === '\\') {
                index += 1
            } else if (character === quote) {
                quote = undefined
            }
            continue
        }
        if (character === '"' || character === "'") {
            quote = character
        } else if (character === open) {
            depth += 1
        } else if (character === close) {
            depth -= 1
            if (depth === 0) return index
        }
    }
    return -1
}

function findDeclarationEnd(source, start) {

    const semicolon = source.indexOf(';', start)
    return semicolon === -1 ? start : semicolon + 1
}

function splitTopLevel(source, delimiter) {

    const values = []
    let start = 0
    let quote
    const depths = { '(': 0, '[': 0, '{': 0, '<': 0 }
    const closeToOpen = { ')': '(', ']': '[', '}': '{', '>': '<' }
    for (let index = 0; index < source.length; index += 1) {
        const character = source[index]
        if (quote !== undefined) {
            if (character === '\\') index += 1
            else if (character === quote) quote = undefined
            continue
        }
        if (character === '"' || character === "'") {
            quote = character
            continue
        }
        if (character in depths) depths[character] += 1
        else if (character in closeToOpen) {
            depths[closeToOpen[character]] -= 1
        } else if (
            character === delimiter &&
            Object.values(depths).every(depth => depth === 0)
        ) {
            values.push(source.slice(start, index))
            start = index + 1
        }
    }
    values.push(source.slice(start))
    return values
}

function maskRanges(source, ranges) {

    const characters = [ ...source ]
    for (const [ start, end ] of ranges) {
        for (let index = start; index < end; index += 1) {
            characters[index] = ' '
        }
    }
    return characters.join('')
}

function stripIdlComments(source) {

    return source
        .replace(/\/\*[\s\S]*?\*\//g, match => ' '.repeat(match.length))
        .replace(/\/\/[^\n]*/g, match => ' '.repeat(match.length))
}

function typesDeclarationName(name, sourceFile) {

    if (name === undefined) return undefined
    if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) {
        return name.text
    }
    if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
        return name.text
    }
    return name.getText(sourceFile)
}

function typesMemberKind(member) {

    if (
        ts.isMethodSignature(member) ||
        ts.isCallSignatureDeclaration(member) ||
        ts.isConstructSignatureDeclaration(member)
    ) {
        return 'method'
    }
    return 'property'
}

function comparableIds(entries) {

    return entries
        .filter(entry => entry.crossSourceComparable !== false)
        .map(entry => entry.id)
        .sort()
}

function ignoredIds(entries) {

    return entries
        .filter(entry => entry.crossSourceComparable === false)
        .map(entry => entry.id)
        .sort()
}

function difference(left, right) {

    const rightSet = new Set(right)
    return left.filter(value => !rightSet.has(value))
}

function intersection(left, right) {

    const rightSet = new Set(right)
    return left.filter(value => rightSet.has(value))
}

function compareIds(left, right) {

    return left.id.localeCompare(right.id)
}

function sortUnresolved(values) {

    return [ ...values ].sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right))
    )
}

function uniqueSorted(values) {

    return [ ...new Set(values) ].sort()
}

function uniqueObjects(values) {

    const byJson = new Map(
        values.map(value => [ JSON.stringify(sortObjectKeys(value)), value ])
    )
    return [ ...byJson ]
        .sort(([ left ], [ right ]) => left.localeCompare(right))
        .map(([, value ]) => value)
}

function sortObjectKeys(value) {

    if (Array.isArray(value)) return value.map(sortObjectKeys)
    if (value === null || typeof value !== 'object') return value
    return Object.fromEntries(
        Object.keys(value)
            .sort()
            .map(key => [ key, sortObjectKeys(value[key]) ])
    )
}

function validateManifestSource(source) {

    if (
        source === null ||
        typeof source !== 'object' ||
        typeof source.publicationUrl !== 'string' ||
        !source.publicationUrl.startsWith('https://') ||
        typeof source.repositoryCommit !== 'string' ||
        source.repositoryCommit.length === 0 ||
        !Array.isArray(source.files) ||
        source.files.length === 0
    ) {
        throw new TypeError(
            'Normative inventory source requires publicationUrl, repositoryCommit, and files'
        )
    }
    for (const file of source.files) {
        if (
            typeof file.path !== 'string' ||
            file.path.length === 0 ||
            typeof file.sha256 !== 'string' ||
            !/^[a-f0-9]{64}$/.test(file.sha256)
        ) {
            throw new TypeError(
                'Each normative source file requires a path and SHA-256'
            )
        }
    }
}

function countBy(values, select) {

    const counts = {}
    for (const value of values) {
        const key = select(value)
        if (typeof key !== 'string' || key.length === 0) continue
        counts[key] = (counts[key] ?? 0) + 1
    }
    return Object.fromEntries(
        Object.entries(counts).sort(([ left ], [ right ]) =>
            left.localeCompare(right)
        )
    )
}

function normalizeWhitespace(value) {

    return value.replace(/\s+/g, ' ').trim()
}

function assertSource(value, name) {

    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new TypeError(`${name} source must be a non-empty string`)
    }
}
