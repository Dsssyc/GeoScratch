import { expect } from 'chai'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function read(...parts) {

    return fs.readFileSync(path.join(root, ...parts), 'utf8')
}

describe('scratch async pipeline creation documentation', () => {

    it('accepts ADR-033 with the complete source-free async boundary', () => {

        const adr = read('docs', 'decisions', 'ADR-033-scratch-async-pipeline-creation.md')

        expect(adr).to.match(/## Status\s+\nAccepted/)
        for (const contract of [
            'Promise-only public pipeline creation',
            'createRenderPipelineAsync()',
            'createComputePipelineAsync()',
            'before the first `await`',
            'does not assume settlement order',
            'version 2',
            'resource/pipeline target unions',
            '64 retained messages',
            '4096 UTF-16 code units',
            '64 KiB',
            'SubmissionBuilder.submit()',
            'Legacy boundary',
        ]) {
            expect(adr).to.include(contract)
        }
        expect(adr).to.match(/Complete WGSL source and source excerpts\s+are forbidden/)
        expect(adr).to.include('sourceExcerptRedacted')
        expect(adr).to.include('eight UTF-16 code units')
        expect(adr).to.include('XID_Start')
        expect(adr).to.include('leading-dot literals')
        expect(adr).to.include('lifecycle native-error')
    })

    it('keeps English and Chinese vision modules on the same target contract', () => {

        for (const directory of [
            '00-overview',
            '01-runtime-surface',
            '04-pipelines-commands',
            '08-programs-codecs',
            '09-diagnostics-validation',
        ]) {
            const english = read('docs', 'vision', 'scratch-api', directory, 'README.md')
            const chinese = read('docs', 'vision', 'scratch-api', directory, 'README_zh.md')

            for (const term of [ 'Promise', 'pipeline', 'compilation', 'source', 'submission' ]) {
                expect(english, `${directory} English ${term}`).to.match(new RegExp(term, 'i'))
                expect(chinese, `${directory} Chinese ${term}`).to.match(new RegExp(term, 'i'))
            }
        }
    })

    it('removes every immediate Scratch pipeline creation path', () => {

        const pipeline = read('packages', 'geoscratch', 'src', 'scratch', 'pipeline.ts')
        const creation = read('packages', 'geoscratch', 'src', 'scratch', 'pipeline-creation.ts')
        const runtime = read('packages', 'geoscratch', 'src', 'scratch', 'runtime.ts')

        const pipelineCalls = propertyCallNames(pipeline, 'pipeline.ts')
        const creationCalls = propertyCallNames(creation, 'pipeline-creation.ts')
        expect(creationCalls).to.include('createRenderPipelineAsync')
        expect(creationCalls).to.include('createComputePipelineAsync')
        expect([ ...pipelineCalls, ...creationCalls ].filter(name => [
            'createRenderPipeline',
            'createComputePipeline',
        ].includes(name))).to.deep.equal([])
        expect(runtime).not.to.include('new RenderPipeline(')
        expect(runtime).not.to.include('new ComputePipeline(')
        expect(runtime).not.to.include('_pipelines')
        expect(runtime).not.to.include('_registerPipeline')
        expect(runtime).not.to.include('_unregisterPipeline')
    })

    it('keeps compilation and pipeline work out of submission source', () => {

        const submission = read('packages', 'geoscratch', 'src', 'scratch', 'submission.ts')

        for (const forbidden of [
            'createShaderModule',
            'createPipelineLayout',
            'createRenderPipeline',
            'createComputePipeline',
            'getCompilationInfo',
            'pushErrorScope',
            'popErrorScope',
            'beginOperation',
        ]) {
            expect(submission).not.to.include(forbidden)
        }
    })

    it('publishes the async public example, audit, and reproducible evidence', () => {

        for (const readmeName of [ 'README.md', 'README_zh.md' ]) {
            const readme = read(readmeName)
            expect(readme).to.include('const runtime = await ScratchRuntime.create(')
            expect(readme).to.include('const pipeline = await runtime.createRenderPipeline(')
            expect(readme).not.to.include('scr.renderPipeline(')
        }
        expect(read('examples', 'README.md')).to.include(
            'Scratch examples must also `await` render and compute pipeline creation.'
        )

        const audit = read(
            'docs',
            'review',
            'scratch-async-pipeline-creation-audit.md'
        )
        for (const contract of [
            'Status: Complete',
            'Native Scratch Pipeline Call Inventory',
            'Public Factory And Constructor Inventory',
            'Consumer And Legacy Inventory',
            'Old-To-New Functional Parity',
            'Official Specification Review',
        ]) {
            expect(audit).to.include(contract)
        }

        const performance = read(
            'docs',
            'review',
            'scratch-async-pipeline-creation-performance.md'
        )
        for (const contract of [
            'Status: Complete',
            'CPU issue',
            'async settlement',
            'render',
            'compute',
            'empty',
            'populated',
            'cache-dependent',
            'lifecycle subscribers',
            'no universal overhead percentage',
        ]) {
            expect(performance.toLowerCase()).to.include(contract.toLowerCase())
        }

        expect(read('tests', 'benchmarks', 'scratch-async-pipeline-creation.mjs'))
            .to.include('verifyBenchmarkResult')
        expect(read('tests', 'browser', 'scratch-async-pipeline-creation.mjs'))
            .to.include('analyzeScreenshotPixels')
    })
})

function propertyCallNames(source, fileName) {

    const sourceFile = ts.createSourceFile(
        fileName,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS
    )
    const names = []
    const visit = (node) => {
        if (
            ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(node.expression)
        ) {
            names.push(node.expression.name.text)
        }
        ts.forEachChild(node, visit)
    }
    visit(sourceFile)
    return names
}
