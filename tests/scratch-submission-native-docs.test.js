import { expect } from 'chai'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function read(...parts) {

    return fs.readFileSync(path.join(root, ...parts), 'utf8')
}

describe('scratch submission native outcome documentation', () => {

    it('publishes the public completion contract in every user README', () => {

        for (const file of [
            [ 'README.md' ],
            [ 'README_zh.md' ],
            [ 'packages', 'geoscratch', 'README.md' ],
            [ 'packages', 'geoscratch', 'README_zh.md' ],
        ]) {
            const document = read(...file)

            for (const marker of [
                "submissionScopes: 'summary'",
                'maxPendingNativeObservations',
                "nativeSubmissionDetail: 'step'",
                'submitted.nativeOutcome',
                'SubmittedWork.done',
                'indeterminate',
                'lifecycle',
                'mapping',
                'host copy',
            ]) {
                expect(document, `${file.join('/')} ${marker}`).to.include(marker)
            }
        }
    })

    it('keeps the bilingual vision modules on the same implemented model', () => {

        const documents = language => ({
            runtime: read('docs', 'vision', 'scratch-api', '01-runtime-surface', language),
            resources: read('docs', 'vision', 'scratch-api', '02-resources', language),
            bindings: read('docs', 'vision', 'scratch-api', '03-bindings', language),
            commands: read('docs', 'vision', 'scratch-api', '04-pipelines-commands', language),
            submissions: read(
                'docs',
                'vision',
                'scratch-api',
                '05-passes-submissions-scheduler',
                language
            ),
            transfers: read('docs', 'vision', 'scratch-api', '07-transfers-epochs', language),
            diagnostics: read(
                'docs',
                'vision',
                'scratch-api',
                '09-diagnostics-validation',
                language
            ),
        })

        for (const language of [ 'README.md', 'README_zh.md' ]) {
            const vision = documents(language)

            for (const marker of [
                'submissionScopes',
                'maxPendingNativeObservations',
                'currentPendingNativeObservations',
                'currentEffectfulSubmittedWork',
            ]) {
                expect(vision.runtime, `${language} runtime ${marker}`).to.include(marker)
            }
            for (const marker of [
                "'indeterminate'",
                'SCRATCH_COMMAND_RESOURCE_CONTENT_INDETERMINATE',
                'SCRATCH_QUERY_SLOT_CONTENT_INDETERMINATE',
                'SCRATCH_PASS_ATTACHMENT_CONTENT_INDETERMINATE',
            ]) {
                expect(vision.resources, `${language} resources ${marker}`).to.include(marker)
            }
            for (const marker of [
                'BufferRegion',
                'TextureViewSpec',
                'prepareGeneration',
                'dynamicOffsets',
                'externalTexture',
            ]) {
                expect(vision.bindings, `${language} bindings ${marker}`).to.include(marker)
            }
            expect(vision.commands).to.include('bind-set-preparation')
            expect(vision.commands).to.include('prepare()')
            expect(vision.commands).not.to.include('lazy bind-group creation')
            for (const marker of [
                'SubmittedWork.nativeOutcome',
                'SubmittedWork.done',
                "'no-native-work'",
                "'observed-succeeded'",
                "'observed-failed'",
                "'unobserved'",
                "'observation-failed'",
                "nativeSubmissionDetail: 'step'",
                'enclosing-operation-family',
                'exact-operation',
                'lifecycle-recheck',
                'temporal-correlation',
            ]) {
                expect(vision.submissions, `${language} submissions ${marker}`).to.include(marker)
            }
            for (const marker of [
                'direct readback',
                'ordered readback',
                'nativeOutcome',
                'indeterminate',
                'unobserved',
                'SCRATCH_READBACK_SOURCE_CONTENT_INDETERMINATE',
            ]) {
                expect(vision.transfers, `${language} transfers ${marker}`).to.include(marker)
            }
            for (const marker of [
                'version 5',
                'bind-set-preparation',
                'submission-native-observation',
                'SCRATCH_SUBMISSION_NATIVE_OBSERVATION_BUDGET_EXCEEDED',
                'SCRATCH_SUBMISSION_NATIVE_VALIDATION_FAILED',
                'SCRATCH_SUBMISSION_NATIVE_OUT_OF_MEMORY',
                'enclosing-operation-family',
                'exact-operation',
                'temporal-correlation',
            ]) {
                expect(vision.diagnostics, `${language} diagnostics ${marker}`).to.include(marker)
            }

            for (const nonGoal of [
                'mapped leases',
                'texture readback',
                'external-texture frame lifetime',
                'tracked dynamic values',
                'render graph',
                'raw-device tracking',
            ]) {
                expect(vision.submissions, `${language} non-goal ${nonGoal}`).to.include(nonGoal)
            }
        }
    })

    it('keeps the living review honest about implemented and pending evidence', () => {

        const review = read('docs', 'review', 'scratch-api-intelligent-friendly-review.md')

        expect(review).to.include('Implementation and bilingual contract are now present')
        expect(review).to.include('submission slice remains resolved by ADR-035')
        expect(review).to.include('ADR-038')
        expect(review).to.include('complete native-call inventory')
        expect(review).to.match(/real\s+delayed-validation Chrome evidence,[\s\S]*are now recorded/)
        expect(review).to.match(/fixed-baseline parity/)
        expect(review).to.match(/strict\s+re-review/)
        expect(review).not.to.match(/Keep\s+this item open/)
    })

    it('publishes executable source, stress, benchmark, and headed-browser evidence', () => {

        const audit = read(
            'docs',
            'review',
            'scratch-submission-native-provenance-audit.md'
        )
        const performance = read(
            'docs',
            'review',
            'scratch-submission-native-provenance-performance.md'
        )
        const stress = read('tests', 'stress', 'scratch-submission-native-provenance.mjs')
        const benchmark = read(
            'tests',
            'benchmarks',
            'scratch-submission-native-provenance.mjs'
        )
        const browser = read('tests', 'browser', 'scratch-submission-native-provenance.mjs')

        for (const marker of [
            '41 source call sites',
            'Chrome 150.0.7871.115',
            'encoder-finish',
            'There is no fabricated',
            'Goal-start `a69c79a` parity matrix',
        ]) {
            expect(audit, marker).to.include(marker)
        }
        for (const marker of [
            '20,000 summary and 20,000 off submissions',
            'All 55 rounds verified',
            'Chrome 150.0.7871.115',
            'Apple Metal 3',
            '11-page regression matrix',
            '[2, 4, 6, 8]',
            'does not identify the draw command',
        ]) {
            expect(performance, marker).to.include(marker)
        }
        expect(stress).to.include('20_000')
        expect(stress).to.include('maxPendingNativeObservations')
        expect(benchmark).to.include("profile('detailed-many-commands-immediate'")
        expect(benchmark).to.include('timingThresholdsEnforced: false')
        expect(browser).to.include('validateDelayedValidationProbe')
        expect(browser).to.include('claimedCommandOutcome')
        expect(browser).to.include("stage === 'encoder-finish'")
    })

    it('locks the current clean-cut parity runner and resolved integration record', () => {

        const runner = read(
            'tests',
            'audits',
            'scratch-persistent-binding-views-final-parity.mjs'
        )
        const audit = read(
            'docs',
            'review',
            'scratch-persistent-binding-views-final-audit.md'
        )
        const integration = read(
            'docs',
            'review',
            'scratch-dev-feature-provenance-integration-audit.md'
        )

        for (const marker of [
            '26c6d8875caea7612e573dfb4e33e1340a016d46',
            '20bb393df570ff1914a6789e9bd422d59ddfecc8',
            'goalStartPublicMemberReplacements',
            'goalStartChangedPublicMemberReplacements',
            'productionEmitParity',
            'officialSpecificationEvidence',
            'behaviorTestContracts',
            'nativeCopyQuadrants',
        ]) {
            expect(runner, marker).to.include(marker)
        }
        for (const marker of [
            'Goal-start TypeScript behavior and public symbols',
            'Historical JavaScript feature inventory',
            'Target clean-cut behavior',
            '20,000 + 20,000',
            'Chrome 150.0.7871.115',
            'Apple Metal 3',
            'Fresh-Context Strict Review',
            '11 ordinary examples',
        ]) {
            expect(audit, marker).to.include(marker)
        }
        for (const marker of [
            '71717c4',
            'b9cd70d',
            '0057b88',
            '635 passing / 7 failing',
            'byte-for-byte identical',
            'Rejected as a stale rollback',
            'unaLoo/dev',
            'e4133c4',
            '17 commits',
            'MapRef',
            'No test files found',
            'unresolved Git conflict markers',
            'not deleted or pushed',
        ]) {
            expect(integration, marker).to.include(marker)
        }
        expect(integration).to.include('standalone submission final-parity check is superseded')
    })

    it('makes every ordinary completion proof inspect native outcome and done', () => {

        for (const example of [
            'helloTriangle',
            'helloVertexBuffer',
            'uniformTriangle',
            'computeReadback',
            'textureSampling',
            'renderToTexture',
            'indirectExecution',
            'readinessPolicies',
            'submissionOrder',
            'externalImageUpload',
            'textureResize',
        ]) {
            const source = read('examples', example, 'main.js')

            expect(source, `${example} native outcome`).to.include('.nativeOutcome')
            expect(source, `${example} completion`).to.include('.done')
            expect(source, `${example} observed success`).to.include('observed-succeeded')
        }
    })

    it('leaves all three legacy example implementations byte-for-byte unchanged', () => {

        const expected = new Map([
            [ 'm_demLayer', 'ef22fcc37b806a62873ad1324db120ef6baf23acc5a0eb944cda7a0b8904a576' ],
            [ 'm_flowLayer', '60988379cbe94f8c0b295e84552603196275697c6ed1469cbcda760d838c62ee' ],
            [ 'x_helloGAW', '079750fca1070e31a2bf41ff781db08db4aa7085873dd32a7048c781360a8ed3' ],
        ])

        for (const [ example, digest ] of expected) {
            const source = read('examples', example, 'main.js')
            const actual = crypto.createHash('sha256').update(source).digest('hex')

            expect(actual, example).to.equal(digest)
        }
    })
})
