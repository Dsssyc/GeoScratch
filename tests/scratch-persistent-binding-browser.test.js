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
        expect(source).to.include('SCRATCH_SHADER_MODULE_COMPILATION_FAILED')
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

    it('executes the headed acceptance proof when the browser gate is enabled', function() {

        if (process.env.SCRATCH_BINDING_BROWSER_GATE !== '1') this.skip()
        this.timeout(120_000)

        const output = execFileSync(process.execPath, [ runner ], {
            cwd: process.cwd(),
            encoding: 'utf8',
            env: {
                ...process.env,
                SCRATCH_BINDING_BROWSER_HEADLESS: '0',
            },
        })
        const result = JSON.parse(output)

        expect(result).to.deep.include({
            status: 'passed',
            headless: false,
        })
        expect(result.browserVersion).to.be.a('string').and.not.equal('')
        expect(result.adapter.info.vendor).to.be.a('string').and.not.equal('')
        expect(result.probe.main.initial.values).to.deep.equal([ 17, 33 ])
        expect(result.probe.main.replacement).to.deep.include({
            staleState: 'stale',
            preparedState: 'prepared',
            generationBefore: 1,
            generationAfter: 2,
            outputValue: 17,
        })
        expect(result.probe.main.replacement.storagePixel).to.deep.equal([ 17, 0, 0, 255 ])
        expect(result.probe.readOnlyStorage).to.deep.include({ status: 'passed', value: 41 })
        expect(result.probe.readWriteStorage).to.deep.include({ status: 'passed', value: 6 })
        expect(result.probe.occlusion).to.deep.include({ status: 'passed', positive: true })
        expect(result.probe.timestamp).to.deep.include({ status: 'passed', monotonic: true })
        expect(result.probe.diagnostics).to.deep.include({
            version: 5,
            jsonRoundTrip: true,
            pendingOperationCount: 0,
        })
        expect(result.probe.consoleFailures).to.deep.equal([])
        expect(result.probe.pageErrors).to.deep.equal([])
        expect(result.probe.requestFailures).to.deep.equal([])
        expect(result.probe.uncaptured).to.deep.equal([])
        expect(result.failures).to.deep.equal([])
    })
})
