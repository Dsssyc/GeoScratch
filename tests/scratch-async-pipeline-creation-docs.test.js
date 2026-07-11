import { expect } from 'chai'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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
        const runtime = read('packages', 'geoscratch', 'src', 'scratch', 'runtime.ts')

        expect(pipeline).to.include('createRenderPipelineAsync(')
        expect(pipeline).to.include('createComputePipelineAsync(')
        expect(pipeline).not.to.match(/\.createRenderPipeline\(/)
        expect(pipeline).not.to.match(/\.createComputePipeline\(/)
        expect(runtime).not.to.include('new RenderPipeline(')
        expect(runtime).not.to.include('new ComputePipeline(')
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
})
