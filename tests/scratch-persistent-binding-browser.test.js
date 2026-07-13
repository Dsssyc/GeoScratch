import { expect } from 'chai'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const runner = path.join(
    process.cwd(),
    'tests',
    'browser',
    'scratch-persistent-binding-views.mjs'
)

describe('Scratch persistent binding browser gate', () => {

    it('keeps the headed public-package WebGPU proof complete', () => {

        const source = fs.readFileSync(runner, 'utf8')

        expect(source).to.include("const headless = process.env.SCRATCH_BINDING_BROWSER_HEADLESS === '1'")
        expect(source).to.include("channel: 'chrome'")
        expect(source).to.include("packages/geoscratch/dist/index.js")
        expect(source).to.include('dynamicOffsets')
        expect(source).to.include('SCRATCH_BIND_SET_STALE')
        expect(source).to.include('allocationVersionAfter')
        expect(source).to.include("access: 'write-only'")
        expect(source).to.include("access: 'read-only'")
        expect(source).to.include("access: 'read-write'")
        expect(source).to.include("type: 'occlusion'")
        expect(source).to.include("type: 'timestamp'")
        expect(source).to.include('SCRATCH_PIPELINE_SHADER_COMPILATION_FAILED')
        expect(source).to.include('probe.diagnostics.version !== 5')
        expect(source).to.include('consoleFailures.length > 0')
        expect(source).to.include('probe.uncaptured.length > 0')
    })

    it('remains syntactically executable', () => {

        execFileSync(process.execPath, [ '--check', runner ], {
            cwd: process.cwd(),
            stdio: 'pipe',
        })
    })
})
