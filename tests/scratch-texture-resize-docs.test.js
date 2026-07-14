import { expect } from 'chai'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8')

describe('scratch texture resize documentation', () => {

    const contractsByModule = {
        '01-runtime-surface': [
            'TextureResource.resize()',
            'allocationVersion',
            'contentEpoch',
            'await set.prepare()',
        ],
        '02-resources': [
            'TextureResource.resize()',
            'BufferRegion',
            'TextureViewSpec',
            'allocationVersion',
            'contentEpoch',
            'prepare()',
        ],
        '03-bindings': [
            'BufferRegion',
            'TextureViewSpec',
            'await colorSet.prepare()',
            'preparationState',
            'prepareGeneration',
        ],
        '04-pipelines-commands': [
            'TextureResource.resize()',
            'TextureViewSpec',
            'bind-set-preparation',
            'prepared snapshot',
        ],
        '05-passes-submissions-scheduler': [
            'TextureResource.resize()',
            'TextureViewSpec',
            'allocationVersion',
            'contentEpoch',
        ],
        '07-transfers-epochs': [
            'TextureResource.resize()',
            'BufferRegion',
            'TextureViewSpec',
            'allocationVersion',
            'contentEpoch',
            'prepare()',
        ],
        '09-diagnostics-validation': [
            'Schema v5',
            'BufferRegion',
            'TextureViewSpec',
            'bind-set-preparation',
        ],
    }

    it('keeps the English and Chinese vision modules on the same replacement contract', () => {

        for (const [module, contracts] of Object.entries(contractsByModule)) {
            const english = read('docs', 'vision', 'scratch-api', module, 'README.md')
            const chinese = read('docs', 'vision', 'scratch-api', module, 'README_zh.md')

            for (const contract of contracts) {
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
        expect(resources).to.include('marks content empty')
        expect(resources).to.include('same-size resize is a true no-op')
        expect(resources).to.include('returns a frozen `TextureViewSpec`')
        expect(resources).to.include('never calls native `createView()`')
        expect(resources).to.include('dependent BindSets become stale and require explicit preparation')
        expect(resourcesZh).to.include('same-size resize 是真正的 no-op')
        expect(resourcesZh).to.include('返回 frozen `TextureViewSpec`')
        expect(resourcesZh).to.include('不会调用 native `createView()`')
        expect(resourcesZh).to.include('dependent BindSet 变为 stale 并要求显式 preparation')
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

        expect(bindings).to.include('await colorSet.prepare()')
        expect(bindings).to.include('preparationState')
        expect(bindings).to.include('prepareGeneration')
        expect(bindings).to.include('allocation-scoped')
        expect(bindings).to.include('Submission never prepares, waits, retries, or repairs it')
        expect(bindings).to.include('Content writes do not change native binding shape')
        expect(bindings).to.not.include('exactly one replacement bind group')
        expect(bindings).to.not.include('binding-time only')
        expect(commands).to.include('resource-lifecycle operation')
        expect(commands).to.include('TextureViewSpec')
        expect(commands).to.include('current physical texture')
        expect(commands).to.include('BindSet preparation')
        expect(commands).to.include('prepared snapshot')
        expect(commands).to.include('Submission never creates a texture view or bind group')
        expect(commands).to.include('Render attachments accept native-renderable `2d`, `2d-array`, and `3d` views')
        expect(commands).to.include('Submission revalidates the view and `depthSlice` against the current allocation')
        expect(commands).to.include('without applying texture-binding-only constraints')
        expect(submissions).to.include('does not add a submission step')
        expect(submissions).to.include('immutable historical record')
        expect(submissions).to.include('before command encoder creation or ledger mutation')
        expect(submissions).to.include('mismatched current render extents/sample counts')
        expect(transfers).to.include('allocationVersion = previous allocationVersion + 1')
        expect(transfers).to.include('contentEpoch = previous contentEpoch')
        expect(transfers).to.include('explicit acknowledged `prepare()`')
        expect(transfers).to.include('SCRATCH_READBACK_SOURCE_ALLOCATION_STALE')
        expect(diagnostics).to.include('SCRATCH_RESOURCE_DESCRIPTOR_INVALID')
        expect(diagnostics).to.include('SCRATCH_TEXTURE_REPLACEMENT_VALIDATION_FAILED')
        expect(diagnostics).to.include('Promise resolves only after validation and OOM scopes acknowledge')
        expect(diagnostics).to.include('transient-attachment')
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

    it('records the contributor routing and user-facing browser proof', () => {

        const agents = read('AGENTS.md')
        const examples = read('examples', 'README.md')
        const readme = read('README.md')
        const readmeZh = read('README_zh.md')
        const review = read('docs', 'review', 'scratch-api-intelligent-friendly-review.md')

        expect(agents).to.include('docs/vision/scratch-api/')
        expect(agents).to.include('logical resources with allocation versions and content epochs')
        expect(agents).to.include('explicit CPU/GPU transfer operations')
        expect(agents).to.include('Do not create prose-only validation errors')
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
        expect(audit).to.include('writable/shadowable escape hatches')
        expect(audit).to.include('package-exported transition helper')
        expect(audit).to.include('non-vacuous current-allocation ledger evidence')

        const completedRows = audit.match(/^\| \d+ \|.*\| Complete \|$/gm) ?? []
        expect(completedRows).to.have.length(17)
        for (let row = 1; row <= 17; row++) {
            expect(audit, `audit row ${row}`).to.match(new RegExp(`^\\| ${row} \\|.*\\| Complete \\|$`, 'm'))
        }
        expect(audit).to.not.match(/\| (Pending|Incomplete|Blocked) \|/)
    })
})
