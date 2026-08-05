import { expect } from 'chai'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const allowlistPath = 'docs/review/manifests/scratch-foundation-legacy-name-allowlist.json'
const publicManifestPath = 'docs/review/manifests/scratch-foundation-public-symbols.json'
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8')
const readJson = relativePath => JSON.parse(read(relativePath))

const scanRoots = [
    'AGENTS.md',
    'README.md',
    'README_zh.md',
    'packages/geoscratch/src',
    'packages/geoscratch/README.md',
    'packages/geoscratch/README_zh.md',
    'examples',
    'scripts',
    'tests',
    'docs/vision',
    'docs/review',
    'docs/decisions',
    'docs/superpowers/plans',
]
const scannedExtensions = new Set([ '.ts', '.js', '.mjs', '.md', '.json', '.html' ])

describe('Scratch foundation docs', () => {

    it('documents the accepted two-concept topology', () => {

        const adr = read('docs/decisions/ADR-057-scratch-foundation-public-topology.md')
        const topology = read('docs/vision/scratch-foundation-public-topology.md')

        for (const fact of [
            "`geoscratch/scratch`",
            "`geoscratch/geo`",
            '`GPURuntime`',
            '`WorkerSystem`',
            'Geo from the Scratch',
            'ADR-056',
            'Goal 2',
            'Goal 3',
        ]) {
            expect(adr, fact).to.include(fact)
        }
        expect(adr).to.include('supersedes ADR-056 only for Worker public topology')
        for (const decision of [ 'ADR-057', 'ADR-058', 'ADR-059' ]) {
            expect(topology, decision).to.include(decision)
        }
    })

    it('uses only the three approved package import forms in user-facing docs', () => {

        const readmes = [
            'README.md',
            'README_zh.md',
            'packages/geoscratch/README.md',
            'packages/geoscratch/README_zh.md',
        ]
        for (const relativePath of readmes) {
            const source = read(relativePath)
            expect(source, relativePath).to.not.include('geoscratch/' + 'worker')
            expect(source, relativePath).to.not.include('geoscratch/' + 'geometry')
            expect(source, relativePath).to.include("from 'geoscratch/scratch'")
            expect(source, relativePath).to.include("from 'geoscratch/geo'")
            expect(source, relativePath).to.include("from 'geoscratch'")
            expect(source, relativePath).to.include('GPURuntime')
            expect(source, relativePath).to.include('WorkerSystem')
            expect(source, relativePath).to.include('TypeScript source-first')

            for (const specifier of rootImportSpecifiers(source)) {
                expect(specifier, `${relativePath} root import`).to.deep.equal([
                    'geo',
                    'scratch',
                ])
            }
        }
    })

    it('keeps every historical name occurrence on an exact live allowlist', () => {

        expect(fs.existsSync(path.join(root, allowlistPath)), allowlistPath).to.equal(true)
        const allowlist = readJson(allowlistPath)
        const publicManifest = readJson(publicManifestPath)
        const legacySymbols = [
            ...publicManifest.entries
                .filter(entry => entry.disposition === 'rename')
                .map(entry => entry.name),
            publicManifest.entries.find(entry => (
                entry.disposition === 'remove' && entry.name.endsWith('DiagnosticError')
            )).name,
            publicManifest.entries.find(entry => (
                entry.disposition === 'remove' && entry.name.startsWith('createWorker')
            )).name,
            'geoscratch/' + 'worker',
            'geoscratch/' + 'geometry',
        ]
        const uniqueLegacySymbols = [ ...new Set(legacySymbols) ].sort()
        const scannedFiles = collectFiles(scanRoots)
            .filter(relativePath => relativePath !== allowlistPath)
        const occurrences = new Set()

        for (const relativePath of scannedFiles) {
            const source = read(relativePath)
            for (const symbol of uniqueLegacySymbols) {
                if (containsToken(source, symbol)) {
                    occurrences.add(entryKey(relativePath, symbol))
                }
            }
        }

        expect(allowlist).to.deep.include({
            schemaVersion: 1,
            entries: allowlist.entries,
        })
        expect(allowlist.entries).to.be.an('array')
        const allowlisted = new Set()
        for (const entry of allowlist.entries) {
            expect(Object.keys(entry).sort(), JSON.stringify(entry)).to.deep.equal([
                'path',
                'reason',
                'symbol',
            ])
            expect(entry.path).to.be.a('string').and.not.empty
            expect(entry.symbol).to.be.a('string').and.not.empty
            expect(entry.reason).to.be.a('string').and.not.empty
            expect(entry.path).to.not.match(/[?*{}[\]]/)
            expect(uniqueLegacySymbols, entry.symbol).to.include(entry.symbol)
            const key = entryKey(entry.path, entry.symbol)
            expect(allowlisted.has(key), `duplicate allowlist entry ${key}`).to.equal(false)
            allowlisted.add(key)
        }

        expect([ ...occurrences ].sort()).to.deep.equal([ ...allowlisted ].sort())
    })
})

function rootImportSpecifiers(source) {

    const imports = []
    const pattern = /import\s*{([^}]+)}\s*from\s*['"]geoscratch['"]/g
    for (const match of source.matchAll(pattern)) {
        imports.push(match[1].split(',').map(name => name.trim()).filter(Boolean).sort())
    }
    const anyRootImport = /import\s+[^\n;]+\s+from\s*['"]geoscratch['"]/g
    expect(source.match(anyRootImport)?.length ?? 0).to.equal(imports.length)
    return imports
}

function collectFiles(entries) {

    const files = []
    for (const relativePath of entries) {
        const absolutePath = path.join(root, relativePath)
        const stat = fs.statSync(absolutePath)
        if (stat.isFile()) {
            files.push(relativePath)
            continue
        }
        for (const entry of fs.readdirSync(absolutePath, { withFileTypes: true })) {
            const child = path.posix.join(relativePath, entry.name)
            if (entry.isDirectory()) {
                files.push(...collectFiles([ child ]))
            } else if (scannedExtensions.has(path.extname(entry.name))) {
                files.push(child)
            }
        }
    }
    return files.sort()
}

function containsToken(source, symbol) {

    if (symbol.includes('/')) return source.includes(symbol)
    const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`).test(source)
}

function entryKey(relativePath, symbol) {

    return `${relativePath}\u0000${symbol}`
}
