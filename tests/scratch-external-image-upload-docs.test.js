import { expect } from 'chai'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8')

describe('scratch external image upload documentation', () => {

    const visionModules = [
        '04-pipelines-commands',
        '05-passes-submissions-scheduler',
        '07-transfers-epochs',
        '09-diagnostics-validation',
    ]

    it('keeps the English and Chinese vision modules on the same native contract', () => {

        for (const module of visionModules) {
            const english = read('docs', 'vision', 'scratch-api', module, 'README.md')
            const chinese = read('docs', 'vision', 'scratch-api', module, 'README_zh.md')

            for (const contract of [
                'ExternalImageUploadCommand',
                'copyExternalImageToTexture',
                "uploadKind: 'external-image'",
            ]) {
                expect(english, `${module} English ${contract}`).to.include(contract)
                expect(chinese, `${module} Chinese ${contract}`).to.include(contract)
            }
        }
    })

    it('documents queue actions, zero-area effects, and stable diagnostics', () => {

        const submissions = read('docs', 'vision', 'scratch-api', '05-passes-submissions-scheduler', 'README.md')
        const transfers = read('docs', 'vision', 'scratch-api', '07-transfers-epochs', 'README.md')
        const diagnostics = read('docs', 'vision', 'scratch-api', '09-diagnostics-validation', 'README.md')

        expect(submissions).to.include("kind: 'external-image-upload'")
        expect(submissions).to.include('only after the native queue call succeeds')
        expect(transfers).to.include('zero-width or zero-height')
        expect(transfers).to.include('does not advance `contentEpoch`')
        expect(transfers).to.include('no `writeTexture()` fallback')
        expect(diagnostics).to.include('SCRATCH_COMMAND_EXTERNAL_IMAGE_UPLOAD_INVALID')
        expect(diagnostics).to.include('SCRATCH_COMMAND_EXTERNAL_IMAGE_UPLOAD_FAILED')
        expect(diagnostics).to.include('ScratchDiagnosticError.cause')
    })

    it('records the contributor boundary and both user-facing example catalogs', () => {

        const agents = read('AGENTS.md')
        const readme = read('README.md')
        const readmeZh = read('README_zh.md')

        expect(agents).to.include('`ExternalImageUploadCommand`')
        expect(agents).to.include('`GPUQueue.copyExternalImageToTexture()`')
        expect(agents).to.include('must not lower through CPU pixel extraction or `writeTexture()`')
        expect(readme).to.include('| External Image Upload | `examples/externalImageUpload/` |')
        expect(readmeZh).to.include('| External Image Upload | `examples/externalImageUpload/` |')
    })

    it('keeps ADR-030 accepted and completes every native-parity audit row', () => {

        const adr = read('docs', 'decisions', 'ADR-030-scratch-external-image-upload-queue-action.md')
        const audit = read('docs', 'review', 'scratch-external-image-upload-audit.md')

        expect(adr).to.include('# ADR-030:')
        expect(adr).to.match(/## Status\s+\nAccepted/)
        expect(audit).to.include('No unresolved native-parity rows remain.')
        expect(audit).to.include('official/native contract')
        expect(audit).to.include('public Scratch representation')
        expect(audit).to.include('implementation location')
        expect(audit).to.include('test evidence')
        expect(audit).to.include('documentation evidence')
        for (let row = 1; row <= 15; row++) {
            expect(audit, `audit row ${row}`).to.match(new RegExp(`^\\| ${row} \\|.*\\| Complete \\|$`, 'm'))
        }
        expect(audit).to.not.match(/\| (Pending|Incomplete|Blocked) \|/)
    })
})

