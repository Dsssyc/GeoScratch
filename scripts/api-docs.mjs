#!/usr/bin/env node

import process from 'node:process'

import {
    checkGeneratedFiles,
    generateApiDocumentation,
    refreshTranslationDigests,
    undocumentedRuntimeSymbols,
    validateApiDocuments,
    writeGeneratedFiles,
} from './api-docs-lib.mjs'

const rootDir = process.cwd()
const command = process.argv[2]

try {
    switch (command) {
        case 'generate':
            await generate(rootDir)
            break
        case 'translations':
            await translations(rootDir)
            break
        case 'check':
            await check(rootDir)
            break
        default:
            throw new Error('Usage: node scripts/api-docs.mjs <generate|translations|check>')
    }
} catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
}

async function generate(root) {
    const { facts, generated } = await generateApiDocumentation(root)
    await writeGeneratedFiles(root, generated)
    console.log(
        `Generated ${generated.size} API fact files for ${symbolCount(facts)} public symbols.`
    )
}

async function translations(root) {
    const updated = await refreshTranslationDigests(root)
    console.log(
        updated.length === 0
            ? 'All Chinese translation digests are current.'
            : `Updated ${updated.length} Chinese translation digest(s): ${updated.join(', ')}`
    )
}

async function check(root) {
    const { facts, generated } = await generateApiDocumentation(root)
    const undocumented = undocumentedRuntimeSymbols(facts)
    if (undocumented.length > 0) {
        throw new Error([
            `${undocumented.length} public runtime symbol(s) lack a source TSDoc summary:`,
            ...undocumented.map(symbol => `- ${symbol}`),
        ].join('\n'))
    }
    const generatedReport = await checkGeneratedFiles(root, generated)
    if (!generatedReport.clean) {
        throw new Error([
            'Generated API facts are stale. Run npm run docs:generate.',
            ...generatedReport.missing.map(file => `- missing: ${file}`),
            ...generatedReport.stale.map(file => `- stale: ${file}`),
        ].join('\n'))
    }
    const report = await validateApiDocuments({ rootDir: root, facts })
    console.log(
        `API docs verified: ${report.coveredSymbolCount} symbols, ` +
        `${report.canonicalPageCount} canonical pages, ` +
        `${report.translationPageCount} translations.`
    )
}

function symbolCount(facts) {
    return facts.entrypoints.reduce((total, entrypoint) => total + entrypoint.symbols.length, 0)
}
