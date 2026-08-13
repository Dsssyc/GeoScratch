import { createHash } from 'node:crypto'
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Application, ReflectionKind, TSConfigReader, TypeDocReader } from 'typedoc'

const FRONT_MATTER_BOUNDARY = '---'
const API_DOCS_DIRECTORY = 'docs/api'
const PUBLIC_ENTRYPOINTS = Object.freeze([
    Object.freeze({
        id: 'geoscratch/scratch',
        source: 'packages/geoscratch/src/scratch.ts',
    }),
    Object.freeze({
        id: 'geoscratch/geo',
        source: 'packages/geoscratch/src/geo/index.ts',
    }),
])
const RUNTIME_KINDS = new Set([ 'Class', 'Function', 'Variable', 'Enum' ])

export async function generateApiDocumentation(rootDir) {
    const entrypoints = []
    for (const descriptor of PUBLIC_ENTRYPOINTS) {
        entrypoints.push(await reflectEntrypoint(rootDir, descriptor))
    }
    const facts = Object.freeze({
        schemaVersion: 1,
        generator: Object.freeze({ name: 'GeoScratch API documentation', version: 1 }),
        entrypoints: Object.freeze(entrypoints),
    })
    const generated = renderGeneratedFiles(facts)
    return Object.freeze({ facts, generated })
}

export async function writeGeneratedFiles(rootDir, generated) {
    if (!(generated instanceof Map)) {
        throw new TypeError('Generated API files must be supplied as a Map')
    }
    for (const [ relative, content ] of generated) {
        const absolute = path.join(rootDir, relative)
        await mkdir(path.dirname(absolute), { recursive: true })
        await writeFile(absolute, content)
    }
}

export async function refreshTranslationDigests(rootDir) {
    const docsRoot = path.join(rootDir, API_DOCS_DIRECTORY)
    const paths = (await markdownFiles(docsRoot))
        .filter(relative => !relative.startsWith('reference/'))
        .sort()
    const documents = new Map()
    for (const relative of paths) {
        const absolute = path.join(docsRoot, relative)
        documents.set(relative, parseApiDocument(relative, await readFile(absolute, 'utf8')))
    }

    const updated = []
    for (const canonical of documents.values()) {
        if (canonical.metadata.canonical !== true) continue
        const relative = translatedPath(canonical.relativePath)
        const translation = documents.get(relative)
        if (translation === undefined || translation.metadata.canonical !== false) {
            throw new Error(
                `Canonical API document ${canonical.relativePath} is missing Chinese translation ` +
                relative
            )
        }
        const resolved = normalizedRelative(path.join(
            path.dirname(relative),
            translation.metadata.translationOf
        ))
        if (resolved !== canonical.relativePath) {
            throw new Error(
                `Translation ${relative} points to ${resolved}, expected ${canonical.relativePath}`
            )
        }
        const digest = canonicalDocumentDigest(canonical.text)
        if (translation.metadata.canonicalDigest === digest) continue
        const next = translation.text.replace(
            /^canonicalDigest: [a-f0-9]{64}$/m,
            `canonicalDigest: ${digest}`
        )
        if (next === translation.text) {
            throw new Error(`Translation ${relative} has no replaceable canonicalDigest`)
        }
        await writeFile(path.join(docsRoot, relative), next)
        updated.push(relative)
    }
    return Object.freeze(updated)
}

export function undocumentedRuntimeSymbols(facts) {
    validateFacts(facts)
    return Object.freeze(facts.entrypoints.flatMap(entrypoint =>
        entrypoint.symbols
            .filter(symbol => RUNTIME_KINDS.has(symbol.kind) && symbol.summary.length === 0)
            .map(symbol => symbol.id)
    ))
}

export function parseApiDocument(relativePath, text) {
    if (typeof text !== 'string' || !text.startsWith(`${FRONT_MATTER_BOUNDARY}\n`)) {
        throw new Error(`API document ${relativePath} requires strict front matter`)
    }
    const closing = text.indexOf(`\n${FRONT_MATTER_BOUNDARY}\n`, FRONT_MATTER_BOUNDARY.length + 1)
    if (closing < 0) {
        throw new Error(`API document ${relativePath} has unterminated front matter`)
    }
    const header = text.slice(FRONT_MATTER_BOUNDARY.length + 1, closing)
    const body = text.slice(closing + FRONT_MATTER_BOUNDARY.length + 2)
    const metadata = parseFrontMatter(relativePath, header)
    return Object.freeze({ relativePath, metadata, body, text })
}

export function canonicalDocumentDigest(text) {
    const parsed = parseApiDocument('canonical-document', text)
    if (parsed.metadata.canonical !== true) {
        throw new Error('canonicalDocumentDigest requires a canonical API document')
    }
    return createHash('sha256').update(normalizeNewlines(parsed.body)).digest('hex')
}

export async function validateApiDocuments({ rootDir, facts }) {
    validateFacts(facts)
    const docsRoot = path.join(rootDir, API_DOCS_DIRECTORY)
    const paths = (await markdownFiles(docsRoot))
        .filter(relative => !relative.startsWith('reference/'))
        .sort()
    const documents = new Map()
    for (const relative of paths) {
        const text = await readFile(path.join(docsRoot, relative), 'utf8')
        documents.set(relative, parseApiDocument(relative, text))
    }

    const canonicalDocuments = [ ...documents.values() ]
        .filter(document => document.metadata.canonical === true)
    const translations = [ ...documents.values() ]
        .filter(document => document.metadata.canonical === false)
    validateDocumentIds(canonicalDocuments, translations)
    validateTranslationPairs(documents, canonicalDocuments)
    await validateLinks(docsRoot, documents)
    validateReachability(documents, canonicalDocuments)
    const coveredSymbolCount = validateApiCoverage(canonicalDocuments, facts)

    return Object.freeze({
        canonicalPageCount: canonicalDocuments.length,
        translationPageCount: translations.length,
        coveredSymbolCount,
    })
}

export async function checkGeneratedFiles(rootDir, generated) {
    if (!(generated instanceof Map)) {
        throw new TypeError('Generated API files must be supplied as a Map')
    }
    const stale = []
    const missing = []
    for (const [ relative, expected ] of [ ...generated.entries() ].sort(([ a ], [ b ]) =>
        a.localeCompare(b)
    )) {
        const absolute = path.join(rootDir, relative)
        let actual
        try {
            actual = await readFile(absolute, 'utf8')
        } catch (error) {
            if (error?.code === 'ENOENT') {
                missing.push(relative)
                continue
            }
            throw error
        }
        if (actual !== expected) stale.push(relative)
    }
    return Object.freeze({
        clean: stale.length === 0 && missing.length === 0,
        stale: Object.freeze(stale),
        missing: Object.freeze(missing),
    })
}

async function reflectEntrypoint(rootDir, descriptor) {
    const app = await Application.bootstrap({
        entryPoints: [ path.join(rootDir, descriptor.source) ],
        tsconfig: path.join(rootDir, 'packages/geoscratch/tsconfig.build.json'),
        name: descriptor.id,
        plugin: [],
        emit: 'none',
        skipErrorChecking: false,
        logLevel: 'Warn',
        validation: {
            invalidLink: true,
            notDocumented: false,
            notExported: false,
        },
    }, [ new TSConfigReader(), new TypeDocReader() ])
    const project = await app.convert()
    if (project === undefined) {
        throw new Error(`TypeDoc could not convert ${descriptor.id}`)
    }
    app.validate(project)
    if (app.logger.hasErrors()) {
        throw new Error(`TypeDoc validation failed for ${descriptor.id}`)
    }
    const symbols = (project.children ?? []).map(reflection => normalizeSymbol(
        descriptor.id,
        reflection
    )).sort((left, right) => left.name.localeCompare(right.name))
    return Object.freeze({
        id: descriptor.id,
        source: descriptor.source,
        symbols: Object.freeze(symbols),
    })
}

function normalizeSymbol(entrypointId, reflection) {
    const sources = unique((reflection.sources ?? [])
        .map(source => normalizedRelative(source.fileName))
        .filter(source => source.startsWith('packages/geoscratch/src/')))
    if (sources.length === 0) {
        throw new Error(`Public API symbol ${entrypointId}#${reflection.name} has no package source`)
    }
    const locations = unique((reflection.sources ?? [])
        .filter(source => source.fileName !== undefined && source.line !== undefined)
        .map(source => `${normalizedRelative(source.fileName)}:${source.line}`))
    const kind = ReflectionKind.singularString(reflection.kind)
    const summary = reflectionSummary(reflection)
    const signatures = normalizeSignatures(reflection)
    const members = (reflection.children ?? []).map(normalizeMember)
        .sort((left, right) => left.name.localeCompare(right.name))
    return Object.freeze({
        id: `${entrypointId}#${reflection.name}`,
        name: reflection.name,
        kind,
        source: sources[0],
        sources: Object.freeze(sources),
        locations: Object.freeze(locations),
        summary,
        declaration: renderDeclaration(reflection, kind),
        ...(signatures.length === 0 ? {} : { signatures: Object.freeze(signatures) }),
        ...(members.length === 0 ? {} : { members: Object.freeze(members) }),
    })
}

function normalizeSignatures(reflection) {
    const signatures = [
        ...(reflection.signatures ?? []),
        ...(reflection.getSignature === undefined ? [] : [ reflection.getSignature ]),
        ...(reflection.setSignature === undefined ? [] : [ reflection.setSignature ]),
    ]
    return signatures.map(signature => {
        const parameters = (signature.parameters ?? []).map(parameter => {
            const optional = parameter.flags?.isOptional ? '?' : ''
            const rest = parameter.flags?.isRest ? '...' : ''
            const defaultValue = parameter.defaultValue === undefined
                ? ''
                : ` = ${parameter.defaultValue}`
            return `${rest}${parameter.name}${optional}: ${renderType(parameter.type)}${defaultValue}`
        }).join(', ')
        const typeParameters = (signature.typeParameters ?? []).map(parameter =>
            renderTypeParameter(parameter)
        ).join(', ')
        const generics = typeParameters.length === 0 ? '' : `<${typeParameters}>`
        return `${reflection.name}${generics}(${parameters}): ${renderType(signature.type)}`
    })
}

function normalizeMember(reflection) {
    const kind = ReflectionKind.singularString(reflection.kind)
    const signatures = normalizeSignatures(reflection)
    const members = (reflection.children ?? []).map(normalizeMember)
        .sort((left, right) => left.name.localeCompare(right.name))
    return Object.freeze({
        name: reflection.name,
        kind,
        modifiers: Object.freeze(reflectionModifiers(reflection)),
        summary: reflectionSummary(reflection),
        declaration: renderDeclaration(reflection, kind),
        ...(signatures.length === 0 ? {} : { signatures: Object.freeze(signatures) }),
        ...(members.length === 0 ? {} : { members: Object.freeze(members) }),
    })
}

function reflectionModifiers(reflection) {
    if (typeof reflection.flags?.toObject !== 'function') return []
    return Object.entries(reflection.flags.toObject())
        .filter(([, enabled ]) => enabled === true)
        .map(([ name ]) => name.replace(/^is/, '').toLowerCase())
        .sort()
}

function renderDeclaration(reflection, kind) {
    const typeParameters = (reflection.typeParameters ?? []).map(renderTypeParameter).join(', ')
    const generics = typeParameters.length === 0 ? '' : `<${typeParameters}>`
    const type = renderType(reflection.type)
    switch (kind) {
        case 'Type Alias': return `type ${reflection.name}${generics} = ${type}`
        case 'Variable': return `const ${reflection.name}: ${type}`
        case 'Property': return `${reflection.name}: ${type}`
        case 'Class': return `class ${reflection.name}${generics}`
        case 'Interface': return `interface ${reflection.name}${generics}`
        case 'Enum': return `enum ${reflection.name}`
        default: return `${kind} ${reflection.name}${generics}`
    }
}

function renderTypeParameter(parameter) {
    const constraint = parameter.type === undefined ? '' : ` extends ${renderType(parameter.type)}`
    const fallback = parameter.default === undefined ? '' : ` = ${renderType(parameter.default)}`
    return `${parameter.name}${constraint}${fallback}`
}

function renderType(type) {
    if (type === undefined) return 'unknown'
    if (typeof type.toString === 'function') return type.toString()
    switch (type.type) {
        case 'intrinsic': return type.name
        case 'literal': return JSON.stringify(type.value)
        case 'reference': {
            const argumentsText = (type.typeArguments ?? []).map(renderType)
            return `${type.name}${argumentsText.length === 0 ? '' : `<${argumentsText.join(', ')}>`}`
        }
        case 'array': return `${renderType(type.elementType)}[]`
        case 'union': return type.types.map(renderType).join(' | ')
        case 'intersection': return type.types.map(renderType).join(' & ')
        case 'tuple': return `[${type.elements.map(renderType).join(', ')}]`
        case 'optional': return `${renderType(type.elementType)}?`
        case 'rest': return `...${renderType(type.elementType)}`
        case 'reflection': return '{ ... }'
        case 'unknown': return 'unknown'
        default: return type.name ?? type.type ?? 'unknown'
    }
}

function reflectionSummary(reflection) {
    const direct = commentText(reflection.comment?.summary)
    if (direct.length > 0) return direct
    for (const signature of reflection.signatures ?? []) {
        const summary = commentText(signature.comment?.summary)
        if (summary.length > 0) return summary
    }
    return ''
}

function commentText(parts) {
    if (!Array.isArray(parts)) return ''
    return parts.map(part => part.text ?? '').join('').replace(/\s+/g, ' ').trim()
}

function renderGeneratedFiles(facts) {
    const result = new Map()
    const allFacts = `${JSON.stringify(facts, null, 2)}\n`
    result.set('docs/api/reference/api-docs.json', allFacts)
    for (const entrypoint of facts.entrypoints) {
        const slug = entrypoint.id.endsWith('/scratch') ? 'scratch' : 'geo'
        result.set(
            `docs/api/reference/${slug}-api.json`,
            `${JSON.stringify({ schemaVersion: 1, entrypoint }, null, 2)}\n`
        )
        result.set(`docs/api/reference/${slug}.md`, renderReference(entrypoint))
    }
    return result
}

function renderReference(entrypoint) {
    const grouped = new Map()
    for (const symbol of entrypoint.symbols) {
        const values = grouped.get(symbol.source) ?? []
        values.push(symbol)
        grouped.set(symbol.source, values)
    }
    const lines = [
        '<!-- Generated by scripts/api-docs.mjs. Do not edit. -->',
        '',
        `# ${entrypoint.id} API Reference`,
        '',
        `Public symbols: ${entrypoint.symbols.length}.`,
        '',
    ]
    for (const source of [ ...grouped.keys() ].sort()) {
        lines.push(`## \`${source}\``, '')
        for (const symbol of grouped.get(source)) {
            lines.push(`### \`${symbol.name}\``, '', `Kind: \`${symbol.kind}\`.`)
            if (symbol.summary.length > 0) lines.push('', symbol.summary)
            lines.push('', '```ts', symbol.declaration, '```')
            if (symbol.signatures !== undefined) {
                lines.push('', '```ts', ...symbol.signatures, '```')
            }
            if (symbol.members !== undefined) {
                lines.push('', 'Members:', '')
                for (const member of symbol.members) {
                    const modifiers = member.modifiers.length === 0
                        ? ''
                        : ` (${member.modifiers.join(', ')})`
                    lines.push(`- \`${member.name}\`: \`${member.declaration}\`${modifiers}`)
                    for (const signature of member.signatures ?? []) {
                        lines.push(`  - \`${signature}\``)
                    }
                }
            }
            lines.push('')
        }
    }
    return `${lines.join('\n').trimEnd()}\n`
}

function parseFrontMatter(relativePath, header) {
    const metadata = {}
    let currentList
    for (const [ index, rawLine ] of header.split('\n').entries()) {
        if (rawLine.startsWith('  - ')) {
            if (currentList === undefined) {
                throw new Error(
                    `API document ${relativePath} has an orphan list item on line ${index + 2}`
                )
            }
            metadata[currentList].push(parseScalar(rawLine.slice(4)))
            continue
        }
        currentList = undefined
        const separator = rawLine.indexOf(':')
        if (separator <= 0) {
            throw new Error(`API document ${relativePath} has invalid front matter`)
        }
        const key = rawLine.slice(0, separator).trim()
        const rawValue = rawLine.slice(separator + 1).trim()
        if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key) || key in metadata) {
            throw new Error(`API document ${relativePath} has invalid or duplicate key ${key}`)
        }
        if (rawValue.length === 0) {
            metadata[key] = []
            currentList = key
        } else {
            metadata[key] = parseScalar(rawValue)
        }
    }
    validateMetadata(relativePath, metadata)
    return Object.freeze(Object.fromEntries(Object.entries(metadata).map(([ key, value ]) => [
        key,
        Array.isArray(value) ? Object.freeze(value) : value,
    ])))
}

function parseScalar(value) {
    if (value === 'true') return true
    if (value === 'false') return false
    return value
}

function validateMetadata(relativePath, metadata) {
    if (typeof metadata.docId !== 'string' || !/^[a-z][a-z0-9.-]*$/.test(metadata.docId)) {
        throw new Error(`API document ${relativePath} requires a stable docId`)
    }
    if (typeof metadata.canonical !== 'boolean') {
        throw new Error(`API document ${relativePath} requires canonical: true or false`)
    }
    const allowed = metadata.canonical
        ? new Set([ 'docId', 'canonical', 'apiSources', 'apiSymbols' ])
        : new Set([ 'docId', 'canonical', 'translationOf', 'canonicalDigest' ])
    for (const key of Object.keys(metadata)) {
        if (!allowed.has(key)) {
            throw new Error(`API document ${relativePath} has unsupported metadata ${key}`)
        }
    }
    if (metadata.canonical) {
        if (!Array.isArray(metadata.apiSources) ||
            metadata.apiSources.some(value => typeof value !== 'string' || value.length === 0)) {
            throw new Error(`Canonical API document ${relativePath} requires apiSources`)
        }
        if (metadata.apiSymbols !== undefined && (!Array.isArray(metadata.apiSymbols) ||
            metadata.apiSymbols.some(value => typeof value !== 'string' || value.length === 0))) {
            throw new Error(`Canonical API document ${relativePath} has invalid apiSymbols`)
        }
    } else if (typeof metadata.translationOf !== 'string' ||
        !/^[a-f0-9]{64}$/.test(metadata.canonicalDigest)) {
        throw new Error(
            `Translated API document ${relativePath} requires translationOf and canonicalDigest`
        )
    }
}

function validateDocumentIds(canonicalDocuments, translations) {
    const ids = new Map()
    for (const document of canonicalDocuments) {
        const previous = ids.get(document.metadata.docId)
        if (previous !== undefined) {
            throw new Error(
                `API documentation has duplicate canonical docId ${document.metadata.docId}: ` +
                `${previous} and ${document.relativePath}`
            )
        }
        ids.set(document.metadata.docId, document.relativePath)
    }
    const translationIds = new Set()
    for (const translation of translations) {
        if (translationIds.has(translation.metadata.docId)) {
            throw new Error(
                `API documentation has duplicate translation docId ${translation.metadata.docId}`
            )
        }
        translationIds.add(translation.metadata.docId)
    }
}

function validateTranslationPairs(documents, canonicalDocuments) {
    const pairedTranslations = new Set()
    for (const canonical of canonicalDocuments) {
        const expectedPath = translatedPath(canonical.relativePath)
        const translation = documents.get(expectedPath)
        if (translation === undefined || translation.metadata.canonical !== false) {
            throw new Error(
                `Canonical API document ${canonical.relativePath} is missing Chinese translation ` +
                expectedPath
            )
        }
        const resolved = normalizedRelative(path.join(
            path.dirname(translation.relativePath),
            translation.metadata.translationOf
        ))
        if (resolved !== canonical.relativePath) {
            throw new Error(
                `Translation ${translation.relativePath} points to ${resolved}, expected ` +
                canonical.relativePath
            )
        }
        const digest = canonicalDocumentDigest(canonical.text)
        if (translation.metadata.canonicalDigest !== digest) {
            throw new Error(
                `Translation ${translation.relativePath} has stale canonicalDigest for ` +
                canonical.relativePath
            )
        }
        pairedTranslations.add(translation.relativePath)
    }
    for (const translation of [ ...documents.values() ].filter(
        document => document.metadata.canonical === false
    )) {
        if (!pairedTranslations.has(translation.relativePath)) {
            throw new Error(`Translation ${translation.relativePath} has no canonical counterpart`)
        }
    }
}

async function validateLinks(docsRoot, documents) {
    for (const document of documents.values()) {
        for (const target of markdownLinks(document.body)) {
            if (externalLink(target) || target.startsWith('#') || target.startsWith('api:')) continue
            const withoutFragment = target.split('#', 1)[0]
            if (withoutFragment.length === 0) continue
            const relative = normalizedRelative(path.join(
                path.dirname(document.relativePath),
                decodeURIComponent(withoutFragment)
            ))
            if (relative.startsWith('../') || path.isAbsolute(relative)) {
                throw new Error(
                    `API document ${document.relativePath} has escaping relative link ${target}`
                )
            }
            try {
                await access(path.join(docsRoot, relative))
            } catch {
                throw new Error(
                    `API document ${document.relativePath} has broken relative link ${target}`
                )
            }
        }
    }
}

function validateReachability(documents, canonicalDocuments) {
    const root = documents.get('README.md')
    if (root === undefined || root.metadata.canonical !== true) {
        throw new Error('API documentation requires canonical docs/api/README.md')
    }
    const reachable = new Set()
    const queue = [ root.relativePath ]
    while (queue.length > 0) {
        const currentPath = queue.shift()
        if (reachable.has(currentPath)) continue
        reachable.add(currentPath)
        const current = documents.get(currentPath)
        if (current === undefined) continue
        for (const target of markdownLinks(current.body)) {
            if (externalLink(target) || target.startsWith('#') || target.startsWith('api:')) continue
            const withoutFragment = target.split('#', 1)[0]
            if (!withoutFragment.endsWith('.md')) continue
            const linked = normalizedRelative(path.join(path.dirname(currentPath), withoutFragment))
            const linkedDocument = documents.get(linked)
            if (linkedDocument?.metadata.canonical === true) queue.push(linked)
        }
    }
    for (const document of canonicalDocuments) {
        if (!reachable.has(document.relativePath)) {
            throw new Error(`API documentation has unreachable canonical page ${document.relativePath}`)
        }
    }
}

function validateApiCoverage(canonicalDocuments, facts) {
    const symbols = facts.entrypoints.flatMap(entrypoint => entrypoint.symbols)
    const symbolsById = new Map(symbols.map(symbol => [ symbol.id, symbol ]))
    const publicSources = new Set(symbols.map(symbol => normalizedRelative(symbol.source)))
    const assignments = new Map()
    for (const document of canonicalDocuments) {
        for (const source of document.metadata.apiSources) {
            const normalized = normalizedRelative(source)
            if (!publicSources.has(normalized)) {
                throw new Error(
                    `Canonical API document ${document.relativePath} has unknown apiSources entry ` +
                    source
                )
            }
            const previous = assignments.get(normalized)
            if (previous !== undefined) {
                throw new Error(
                    `Public API source ${normalized} is assigned to multiple canonical pages: ` +
                    `${previous} and ${document.relativePath}`
                )
            }
            assignments.set(normalized, document.relativePath)
        }
        for (const symbolId of document.metadata.apiSymbols ?? []) {
            if (!symbolsById.has(symbolId)) {
                throw new Error(
                    `Canonical API document ${document.relativePath} references unknown API symbol ` +
                    symbolId
                )
            }
        }
        for (const target of markdownLinks(document.body)) {
            if (!target.startsWith('api:')) continue
            const symbolId = target.slice('api:'.length)
            if (!symbolsById.has(symbolId)) {
                throw new Error(
                    `Canonical API document ${document.relativePath} references unknown API symbol ` +
                    symbolId
                )
            }
        }
    }
    for (const source of publicSources) {
        if (!assignments.has(source)) {
            throw new Error(`API documentation has uncovered public API source ${source}`)
        }
    }
    return symbols.length
}

function validateFacts(facts) {
    if (facts?.schemaVersion !== 1 || !Array.isArray(facts.entrypoints) ||
        facts.entrypoints.some(entrypoint => typeof entrypoint?.id !== 'string' ||
            !Array.isArray(entrypoint.symbols) || entrypoint.symbols.some(symbol =>
                typeof symbol?.id !== 'string' || typeof symbol?.source !== 'string'
            ))) {
        throw new TypeError('API documentation validation requires schema version 1 facts')
    }
}

function translatedPath(canonicalPath) {
    return canonicalPath.endsWith('.md')
        ? `${canonicalPath.slice(0, -3)}_zh.md`
        : `${canonicalPath}_zh.md`
}

function markdownLinks(body) {
    const links = []
    const pattern = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
    for (const match of body.matchAll(pattern)) links.push(match[1])
    return links
}

function externalLink(target) {
    return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) && !target.startsWith('api:')
}

async function markdownFiles(root) {
    const result = []
    async function visit(directory, prefix) {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const relative = normalizedRelative(path.join(prefix, entry.name))
            if (entry.isDirectory()) {
                await visit(path.join(directory, entry.name), relative)
            } else if (entry.isFile() && entry.name.endsWith('.md')) {
                result.push(relative)
            }
        }
    }
    await visit(root, '')
    return result
}

function normalizedRelative(value) {
    return value.split(path.sep).join('/').replace(/^\.\//, '')
}

function normalizeNewlines(value) {
    return value.replace(/\r\n/g, '\n')
}

function unique(values) {
    return [ ...new Set(values) ].sort()
}
