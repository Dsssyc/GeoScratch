import { expect } from 'chai'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8')

describe('scratch texture resize documentation', () => {

    const visionModules = [
        '01-runtime-surface',
        '02-resources',
        '03-bindings',
        '04-pipelines-commands',
        '05-passes-submissions-scheduler',
        '07-transfers-epochs',
        '09-diagnostics-validation',
    ]

    it('keeps the English and Chinese vision modules on the same replacement contract', () => {

        for (const module of visionModules) {
            const english = read('docs', 'vision', 'scratch-api', module, 'README.md')
            const chinese = read('docs', 'vision', 'scratch-api', module, 'README_zh.md')

            for (const contract of [
                'TextureResource.resize()',
                'allocationVersion',
                'contentEpoch',
            ]) {
                expect(english, `${module} English ${contract}`).to.include(contract)
                expect(chinese, `${module} Chinese ${contract}`).to.include(contract)
            }
        }
    })

    it('documents explicit surface coordination and removes the obsolete size-provider shape', () => {

        const runtime = read('docs', 'vision', 'scratch-api', '01-runtime-surface', 'README.md')
        const resources = read('docs', 'vision', 'scratch-api', '02-resources', 'README.md')
        const resourcesZh = read('docs', 'vision', 'scratch-api', '02-resources', 'README_zh.md')
        const kernel = read('docs', 'vision', 'scratch-graphics-kernel.md')

        expect(runtime).to.include('target.resize(surface.size)')
        expect(runtime).to.include('does not install a `ResizeObserver`')
        expect(resources).to.include('create-before-swap')
        expect(resources).to.include('state = empty')
        expect(resources).to.not.include('sceneColor.invalidateSize()')
        expect(resources).to.not.include('size: derived(() => surface.size')
        expect(resourcesZh).to.not.include('sceneColor.invalidateSize()')
        expect(resourcesZh).to.not.include('size: derived(() => surface.size')
        expect(kernel).to.not.include('texture formats and size providers')
    })

    it('documents downstream resolution, provenance, and stable diagnostics', () => {

        const bindings = read('docs', 'vision', 'scratch-api', '03-bindings', 'README.md')
        const commands = read('docs', 'vision', 'scratch-api', '04-pipelines-commands', 'README.md')
        const submissions = read('docs', 'vision', 'scratch-api', '05-passes-submissions-scheduler', 'README.md')
        const transfers = read('docs', 'vision', 'scratch-api', '07-transfers-epochs', 'README.md')
        const diagnostics = read('docs', 'vision', 'scratch-api', '09-diagnostics-validation', 'README.md')

        expect(bindings).to.include('exactly one replacement bind group')
        expect(bindings).to.include('allocation-scoped')
        expect(commands).to.include('resource-lifecycle operation')
        expect(commands).to.include('current physical texture')
        expect(submissions).to.include('does not add a submission step')
        expect(submissions).to.include('immutable historical record')
        expect(transfers).to.include('allocationVersion = previous allocationVersion + 1')
        expect(transfers).to.include('contentEpoch = previous contentEpoch')
        expect(transfers).to.include('SCRATCH_READBACK_SOURCE_ALLOCATION_STALE')
        expect(diagnostics).to.include('SCRATCH_RESOURCE_DESCRIPTOR_INVALID')
        expect(diagnostics).to.include('SCRATCH_RESOURCE_ALLOCATION_REPLACEMENT_FAILED')
        expect(diagnostics).to.include('asynchronous WebGPU validation')
    })

    it('keeps a strict canonical WebGPU declaration-consumer gate', () => {

        const packageJson = JSON.parse(read('package.json'))
        const config = JSON.parse(read('tsconfig.webgpu-types.json'))

        expect(packageJson.devDependencies).to.have.property(
            'typescript-webgpu',
            'npm:typescript@^5.9.3'
        )
        expect(packageJson.scripts.typecheck).to.include('npm run typecheck:webgpu')
        expect(packageJson.scripts['typecheck:webgpu']).to.include('typescript-webgpu/bin/tsc')
        expect(config.compilerOptions).to.include({
            strict: true,
            exactOptionalPropertyTypes: true,
            noEmit: true,
            skipLibCheck: false,
        })
        expect(config.compilerOptions.types).to.deep.equal([ '@webgpu/types' ])
    })

    it('records the contributor boundary and user-facing browser proof', () => {

        const agents = read('AGENTS.md')
        const examples = read('examples', 'README.md')
        const readme = read('README.md')
        const readmeZh = read('README_zh.md')
        const review = read('docs', 'review', 'scratch-api-intelligent-friendly-review.md')

        expect(agents).to.include('`TextureResource.resize()`')
        expect(agents).to.include('must not wait for queue completion')
        expect(examples).to.include('`textureResize/`')
        expect(examples).to.include('exact padded readback bytes')
        expect(readme).to.include('| Texture Resize | `examples/textureResize/` |')
        expect(readmeZh).to.include('| Texture Resize | `examples/textureResize/` |')
        expect(review).to.include('### Texture Allocation Replacement And Resize Invalidation')
    })

    it('keeps ADR-031 accepted and completes exactly 17 evidence-backed audit rows', () => {

        const adr = read('docs', 'decisions', 'ADR-031-scratch-texture-allocation-replacement.md')
        const audit = read('docs', 'review', 'scratch-texture-resize-audit.md')

        expect(adr).to.include('# ADR-031:')
        expect(adr).to.match(/## Status\s+\nAccepted/)
        expect(audit).to.include('No unresolved texture-resize rows remain.')
        expect(audit).to.include('official/vision contract')
        expect(audit).to.include('public Scratch representation')
        expect(audit).to.include('implementation location')
        expect(audit).to.include('test evidence')
        expect(audit).to.include('browser evidence')
        expect(audit).to.include('documentation evidence')

        const completedRows = audit.match(/^\| \d+ \|.*\| Complete \|$/gm) ?? []
        expect(completedRows).to.have.length(17)
        for (let row = 1; row <= 17; row++) {
            expect(audit, `audit row ${row}`).to.match(new RegExp(`^\\| ${row} \\|.*\\| Complete \\|$`, 'm'))
        }
        expect(audit).to.not.match(/\| (Pending|Incomplete|Blocked) \|/)
    })
})
