import { expect } from 'chai'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
    canonicalDocumentDigest,
    checkGeneratedFiles,
    generateApiDocumentation,
    parseApiDocument,
    refreshTranslationDigests,
    undocumentedRuntimeSymbols,
    validateApiDocuments,
} from '../scripts/api-docs-lib.mjs'

describe('API documentation knowledge system', () => {
    let root

    beforeEach(async() => {
        root = await mkdtemp(path.join(tmpdir(), 'geoscratch-api-docs-'))
    })

    afterEach(async() => {
        await rm(root, { recursive: true, force: true })
    })

    it('digests the canonical body rather than mutable translation metadata', () => {
        const first = canonicalDocumentDigest(documentText({
            docId: 'scratch.worker',
            canonical: true,
            apiSources: [ 'packages/geoscratch/src/scratch/worker/module.ts' ],
            body: '# Worker\n\nWorker facts.\n',
        }))
        const second = canonicalDocumentDigest(documentText({
            docId: 'scratch.worker',
            canonical: true,
            apiSources: [ 'packages/geoscratch/src/scratch/worker/module.ts' ],
            body: '# Worker\n\nChanged Worker facts.\n',
        }))

        expect(first).to.match(/^[a-f0-9]{64}$/)
        expect(second).to.not.equal(first)
    })

    it('parses the strict front matter used by canonical and translated pages', () => {
        const parsed = parseApiDocument('scratch/worker.md', documentText({
            docId: 'scratch.worker',
            canonical: true,
            apiSources: [
                'packages/geoscratch/src/scratch/worker/module.ts',
                'packages/geoscratch/src/scratch/worker/worker-system.ts',
            ],
            body: '# Worker\n',
        }))

        expect(parsed.metadata).to.deep.equal({
            docId: 'scratch.worker',
            canonical: true,
            apiSources: [
                'packages/geoscratch/src/scratch/worker/module.ts',
                'packages/geoscratch/src/scratch/worker/worker-system.ts',
            ],
        })
        expect(parsed.body).to.equal('# Worker\n')
    })

    it('accepts a complete reachable bilingual document graph with exact API coverage', async() => {
        await writeValidFixture(root)

        const report = await validateApiDocuments({
            rootDir: root,
            facts: fixtureFacts(),
        })

        expect(report.canonicalPageCount).to.equal(3)
        expect(report.translationPageCount).to.equal(3)
        expect(report.coveredSymbolCount).to.equal(2)
    })

    it('rejects missing translations and stale translation digests', async() => {
        await writeValidFixture(root)
        await rm(path.join(root, 'docs/api/scratch/worker_zh.md'))

        await expectRejected(
            validateApiDocuments({ rootDir: root, facts: fixtureFacts() }),
            'missing Chinese translation'
        )

        await writeValidFixture(root)
        const canonicalPath = path.join(root, 'docs/api/scratch/worker.md')
        const current = await readFile(canonicalPath, 'utf8')
        await writeFile(canonicalPath, current.replace('Worker facts.', 'New Worker facts.'))

        await expectRejected(
            validateApiDocuments({ rootDir: root, facts: fixtureFacts() }),
            'stale canonicalDigest'
        )
    })

    it('rejects duplicate canonical ids, broken links, and unreachable pages', async() => {
        await writeValidFixture(root)
        await writePair(root, 'scratch/duplicate', {
            docId: 'scratch.worker',
            apiSources: [],
            body: '# Duplicate\n',
        })

        await expectRejected(
            validateApiDocuments({ rootDir: root, facts: fixtureFacts() }),
            'duplicate canonical docId'
        )

        await writeValidFixture(root)
        const workerPath = path.join(root, 'docs/api/scratch/worker.md')
        await writeFile(workerPath, (await readFile(workerPath, 'utf8')) + '\n[Missing](./missing.md)\n')
        await refreshTranslationDigest(root, 'scratch/worker')

        await expectRejected(
            validateApiDocuments({ rootDir: root, facts: fixtureFacts() }),
            'broken relative link'
        )

        await writeValidFixture(root)
        const scratchIndex = path.join(root, 'docs/api/scratch/README.md')
        await writeFile(scratchIndex, (await readFile(scratchIndex, 'utf8')).replace(
            '\n[Worker](./worker.md)\n',
            '\n'
        ))
        await refreshTranslationDigest(root, 'scratch/README')

        await expectRejected(
            validateApiDocuments({ rootDir: root, facts: fixtureFacts() }),
            'unreachable canonical page'
        )
    })

    it('rejects unknown, missing, and multiply assigned API source coverage', async() => {
        await writeValidFixture(root)
        const workerPath = path.join(root, 'docs/api/scratch/worker.md')
        await writeFile(workerPath, (await readFile(workerPath, 'utf8')).replace(
            'packages/geoscratch/src/scratch/worker/worker-system.ts',
            'packages/geoscratch/src/scratch/worker/unknown.ts'
        ))
        await refreshTranslationDigest(root, 'scratch/worker')

        await expectRejected(
            validateApiDocuments({ rootDir: root, facts: fixtureFacts() }),
            'unknown apiSources entry'
        )

        await writeValidFixture(root)
        const current = await readFile(workerPath, 'utf8')
        await writeFile(workerPath, current.replace(
            '  - packages/geoscratch/src/scratch/worker/worker-system.ts\n',
            ''
        ))
        await refreshTranslationDigest(root, 'scratch/worker')

        await expectRejected(
            validateApiDocuments({ rootDir: root, facts: fixtureFacts() }),
            'uncovered public API source'
        )

        await writeValidFixture(root)
        const scratchIndex = path.join(root, 'docs/api/scratch/README.md')
        await writeFile(scratchIndex, (await readFile(scratchIndex, 'utf8')).replace(
            'apiSources:\n',
            'apiSources:\n  - packages/geoscratch/src/scratch/worker/worker-system.ts\n'
        ))
        await refreshTranslationDigest(root, 'scratch/README')

        await expectRejected(
            validateApiDocuments({ rootDir: root, facts: fixtureFacts() }),
            'assigned to multiple canonical pages'
        )
    })

    it('reports stale generated files without modifying them', async() => {
        const generated = new Map([
            [ 'docs/api/reference/scratch-api.json', '{"schemaVersion":1}\n' ],
            [ 'docs/api/reference/scratch.md', '# Scratch API\n' ],
        ])
        await mkdir(path.join(root, 'docs/api/reference'), { recursive: true })
        await writeFile(
            path.join(root, 'docs/api/reference/scratch-api.json'),
            '{"schemaVersion":0}\n'
        )
        await writeFile(path.join(root, 'docs/api/reference/scratch.md'), '# Scratch API\n')

        const before = await readFile(
            path.join(root, 'docs/api/reference/scratch-api.json'),
            'utf8'
        )
        const report = await checkGeneratedFiles(root, generated)
        const after = await readFile(
            path.join(root, 'docs/api/reference/scratch-api.json'),
            'utf8'
        )

        expect(report.stale).to.deep.equal([ 'docs/api/reference/scratch-api.json' ])
        expect(after).to.equal(before)
    })

    it('refreshes translation digests only through the explicit translation operation', async() => {
        await writeValidFixture(root)
        const canonicalPath = path.join(root, 'docs/api/scratch/worker.md')
        await writeFile(
            canonicalPath,
            (await readFile(canonicalPath, 'utf8')).replace('Worker facts.', 'Updated facts.')
        )

        const updated = await refreshTranslationDigests(root)

        expect(updated).to.deep.equal([ 'scratch/worker_zh.md' ])
        const report = await validateApiDocuments({ rootDir: root, facts: fixtureFacts() })
        expect(report.translationPageCount).to.equal(3)
    })

    it('reports only undocumented public runtime values', () => {
        const facts = fixtureFacts()
        const changed = {
            ...facts,
            entrypoints: [ {
                ...facts.entrypoints[0],
                symbols: facts.entrypoints[0].symbols.map(symbol =>
                    symbol.name === 'WorkerSystem' ? { ...symbol, summary: '' } : symbol
                ).concat({
                    id: 'geoscratch/scratch#WorkerOptions',
                    name: 'WorkerOptions',
                    kind: 'Type alias',
                    source: 'packages/geoscratch/src/scratch/worker/worker-system.ts',
                    summary: '',
                }),
            } ],
        }

        expect(undocumentedRuntimeSymbols(changed)).to.deep.equal([
            'geoscratch/scratch#WorkerSystem',
        ])
    })

    it('reflects every real public entrypoint deterministically', async function() {
        this.timeout(30_000)
        const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

        const first = await generateApiDocumentation(repositoryRoot)
        const second = await generateApiDocumentation(repositoryRoot)

        expect(JSON.stringify(first.facts)).to.equal(JSON.stringify(second.facts))
        expect(first.facts.entrypoints.map(entrypoint => entrypoint.id)).to.deep.equal([
            'geoscratch/scratch',
            'geoscratch/geo',
        ])
        const ids = first.facts.entrypoints.flatMap(entrypoint =>
            entrypoint.symbols.map(symbol => symbol.id)
        )
        expect(ids).to.include('geoscratch/scratch#WorkerSystem')
        expect(ids).to.include('geoscratch/geo#createVirtualRasterRuntime')
        expect(new Set(ids).size).to.equal(ids.length)
        const workerSystem = first.facts.entrypoints[0].symbols.find(
            symbol => symbol.name === 'WorkerSystem'
        )
        expect(workerSystem.declaration).to.equal('class WorkerSystem')
        expect(workerSystem.members.map(member => member.name)).to.include('createGroup')
        expect(workerSystem.members.find(member => member.name === 'createGroup').signatures[0])
            .to.include('options: WorkerGroupOptions')
    })
})

function fixtureFacts() {
    return Object.freeze({
        schemaVersion: 1,
        entrypoints: Object.freeze([
            Object.freeze({
                id: 'geoscratch/scratch',
                source: 'packages/geoscratch/src/scratch.ts',
                symbols: Object.freeze([
                    Object.freeze({
                        id: 'geoscratch/scratch#WorkerSystem',
                        name: 'WorkerSystem',
                        kind: 'Class',
                        source: 'packages/geoscratch/src/scratch/worker/worker-system.ts',
                        summary: 'Runs explicitly grouped Worker tasks.',
                    }),
                    Object.freeze({
                        id: 'geoscratch/scratch#defineWorkerModuleContract',
                        name: 'defineWorkerModuleContract',
                        kind: 'Function',
                        source: 'packages/geoscratch/src/scratch/worker/module.ts',
                        summary: 'Defines one stable Worker module identity.',
                    }),
                ]),
            }),
        ]),
    })
}

async function writeValidFixture(root) {
    await rm(path.join(root, 'docs/api'), { recursive: true, force: true })
    await mkdir(path.join(root, 'docs/api/scratch'), { recursive: true })
    await writePair(root, 'README', {
        docId: 'api',
        apiSources: [],
        body: '# API\n\n[Scratch](./scratch/README.md)\n',
    })
    await writePair(root, 'scratch/README', {
        docId: 'scratch',
        apiSources: [],
        body: '# Scratch\n\n[Worker](./worker.md)\n',
    })
    await writePair(root, 'scratch/worker', {
        docId: 'scratch.worker',
        apiSources: [
            'packages/geoscratch/src/scratch/worker/module.ts',
            'packages/geoscratch/src/scratch/worker/worker-system.ts',
        ],
        body: '# Worker\n\nWorker facts.\n',
    })
}

async function writePair(root, relativeBase, { docId, apiSources, body }) {
    const canonicalRelative = `${relativeBase}.md`
    const translationRelative = `${relativeBase}_zh.md`
    const canonical = documentText({ docId, canonical: true, apiSources, body })
    const digest = canonicalDocumentDigest(canonical)
    const translation = translatedDocumentText({
        docId: `${docId}.zh`,
        translationOf: `./${path.basename(canonicalRelative)}`,
        canonicalDigest: digest,
        body: body.replace(/^# (.+)$/m, '# $1 中文'),
    })
    const canonicalPath = path.join(root, 'docs/api', canonicalRelative)
    const translationPath = path.join(root, 'docs/api', translationRelative)
    await mkdir(path.dirname(canonicalPath), { recursive: true })
    await writeFile(canonicalPath, canonical)
    await writeFile(translationPath, translation)
}

async function refreshTranslationDigest(root, relativeBase) {
    const canonicalPath = path.join(root, 'docs/api', `${relativeBase}.md`)
    const translationPath = path.join(root, 'docs/api', `${relativeBase}_zh.md`)
    const digest = canonicalDocumentDigest(await readFile(canonicalPath, 'utf8'))
    const translation = await readFile(translationPath, 'utf8')
    await writeFile(
        translationPath,
        translation.replace(/canonicalDigest: [a-f0-9]{64}/, `canonicalDigest: ${digest}`)
    )
}

function documentText({ docId, canonical, apiSources, body }) {
    return [
        '---',
        `docId: ${docId}`,
        `canonical: ${canonical}`,
        'apiSources:',
        ...apiSources.map(source => `  - ${source}`),
        '---',
        body,
    ].join('\n')
}

function translatedDocumentText({ docId, translationOf, canonicalDigest, body }) {
    return [
        '---',
        `docId: ${docId}`,
        'canonical: false',
        `translationOf: ${translationOf}`,
        `canonicalDigest: ${canonicalDigest}`,
        '---',
        body,
    ].join('\n')
}

async function expectRejected(promise, message) {
    try {
        await promise
    } catch (error) {
        expect(error).to.be.instanceOf(Error)
        expect(error.message).to.include(message)
        return
    }
    throw new Error(`Expected rejection containing ${message}`)
}
