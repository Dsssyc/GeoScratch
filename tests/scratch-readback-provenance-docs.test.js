import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect } from 'chai'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function read(...segments) {

    return fs.readFileSync(path.join(root, ...segments), 'utf8')
}

describe('scratch readback staging and mapping documentation', () => {

    it('keeps the four bilingual vision modules on the implemented contract', () => {

        const modules = [
            '01-runtime-surface',
            '05-passes-submissions-scheduler',
            '07-transfers-epochs',
            '09-diagnostics-validation',
        ]
        const documents = modules.flatMap(module => [
            read('docs', 'vision', 'scratch-api', module, 'README.md'),
            read('docs', 'vision', 'scratch-api', module, 'README_zh.md'),
        ])
        const joined = documents.join('\n')

        for (const marker of [
            'maxPendingOperations',
            'maxStagingBytes',
            'readback-staging-allocation',
            'readback-mapping',
            'readback-staging-release',
            'SCRATCH_READBACK_MAPPING_VALIDATION_FAILED',
            'SCRATCH_READBACK_CLEANUP_FAILED',
            'enclosing-operation-family',
        ]) {
            expect(joined).to.include(marker)
        }
        expect(read('docs', 'vision', 'scratch-api', '05-passes-submissions-scheduler', 'README.md'))
            .to.include('type SubmittedReadbackLink')
        expect(read('docs', 'vision', 'scratch-api', '05-passes-submissions-scheduler', 'README_zh.md'))
            .to.include('type SubmittedReadbackLink')
        for (const language of [ 'README.md', 'README_zh.md' ]) {
            const transfers = read('docs', 'vision', 'scratch-api', '07-transfers-epochs', language)
            const diagnostics = read('docs', 'vision', 'scratch-api', '09-diagnostics-validation', language)
            expect(transfers).to.include('const readParticles = await runtime.readbackCommand({')
            expect(transfers).to.include("retain: 'consume-on-read'")
            expect(transfers).not.to.include('staging-budget policy remain future work')
            expect(transfers).to.include('maxPendingOperations')
            expect(transfers).to.include('maxStagingBytes')
            expect(transfers).to.match(/historical\s+result lookup/)
            expect(diagnostics).to.include('version 3')
            expect(diagnostics).to.include("| { kind: 'command'; commandId: string; commandKind: 'readback' }")
            expect(diagnostics).to.include("| 'lifecycle-recheck'")
        }
    })

    it('publishes the same public readback boundary in every user README', () => {

        for (const file of [
            [ 'README.md' ],
            [ 'README_zh.md' ],
            [ 'packages', 'geoscratch', 'README.md' ],
            [ 'packages', 'geoscratch', 'README_zh.md' ],
        ]) {
            const document = read(...file)
            expect(document).to.include('await runtime.createReadbackCommand({')
            expect(document).to.include('SubmittedWork.done')
            expect(document).to.include('maxStagingBytes')
            expect(document).to.include('SCRATCH_READBACK_MAPPING_VALIDATION_FAILED')
        }
    })

    it('keeps every ordinary ordered-readback example on the Promise-only factory', () => {

        for (const example of [
            'externalImageUpload',
            'submissionOrder',
            'textureResize',
        ]) {
            const source = read('examples', example, 'main.js')
            expect(source).to.match(/const\s+readback\s*=\s*await\s+runtime\.createReadbackCommand\(/)
        }
    })

    it('publishes reproducible stress, benchmark, and headed-browser evidence', () => {

        const performance = read(
            'docs',
            'review',
            'scratch-readback-staging-mapping-performance.md'
        )
        const stress = read('tests', 'stress', 'scratch-readback-staging-mapping.mjs')
        const benchmark = read('tests', 'benchmarks', 'scratch-readback-staging-mapping.mjs')
        const browser = read('tests', 'browser', 'scratch-readback-staging-mapping.mjs')

        for (const marker of [
            '20,000 direct operations',
            '5,000 ordered reuses',
            'direct-mapping-history-disabled',
            'ordered-factory-history-disabled',
            'submission-no-readback-history-disabled',
            'Chrome 150.0.7871.115',
            '11-page regression matrix',
        ]) {
            expect(performance).to.include(marker)
        }
        expect(stress).to.include('20_000')
        expect(stress).to.include('5_000')
        expect(benchmark).to.include("profile('direct-mapping-deep-capture'")
        expect(benchmark).to.include("profile('submission-no-readback-history-disabled'")
        for (const example of [
            'scratch_computeReadback',
            'externalImageUpload',
            'submissionOrder',
            'textureResize',
        ]) {
            expect(browser).to.include(`name: '${example}'`)
        }
        expect(browser).to.include("headless = process.env.SCRATCH_READBACK_BROWSER_HEADLESS === '1'")
    })

    it('keeps the fixed-baseline final parity audit reproducible without requiring Git history in npm test', () => {

        const audit = read('docs', 'review', 'scratch-readback-final-parity-audit.md')
        const runner = read('tests', 'audits', 'scratch-readback-final-parity.mjs')

        for (const marker of [
            '20bb393df570ff1914a6789e9bd422d59ddfecc8',
            'f3e73062bb352009a2118bf9960de062b1296ebe',
            'preserved JavaScript behavior checks: 12/12',
            'preserved Goal-start TypeScript behavior checks: 16/16',
            'explicit ADR-034 replacements: 10/10',
            'could incidentally retry',
            'intentionally not part of default `npm test`',
        ]) {
            expect(audit).to.include(marker)
        }
        expect(runner).to.include("const jsBaseline = '20bb393df570ff1914a6789e9bd422d59ddfecc8'")
        expect(runner).to.include("const goalBaseline = 'f3e73062bb352009a2118bf9960de062b1296ebe'")
        expect(runner).to.include('assertAncestor(goalBaseline)')
        expect(runner).to.include("'ReadbackStagingSlot', 'ReadbackMappingTransaction', 'ReadbackCommandClaim'")
    })
})
