import { expect } from 'chai'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function read(...parts) {

    return fs.readFileSync(path.join(root, ...parts), 'utf8')
}

describe('scratch GPU operation provenance documentation', () => {

    it('keeps ADR-032 accepted and records every locked design boundary', () => {

        const adr = read('docs', 'decisions', 'ADR-032-scratch-gpu-operation-provenance.md')

        expect(adr).to.match(/## Status\s+\nAccepted/)
        expect(adr).to.include('ordinary Promises')
        expect(adr).to.include('No synchronous compatibility path')
        expect(adr).to.include('Current facts and retained history are separate')
        expect(adr).to.include('bounded')
        expect(adr).to.include('OOM')
        expect(adr).to.include('physical VRAM')
        expect(adr).to.include('per-submission')
        expect(adr).to.include('Raw WebGPU')
        expect(adr).to.include('read-only after creation')
        expect(adr).to.include('resource-disposal')
    })

    it('completes every required audit dimension with executable evidence', () => {

        const audit = read('docs', 'review', 'scratch-gpu-operation-provenance-audit.md')
        const completedRows = audit.match(/^\| \d+ \|.*\| Complete \|$/gm) ?? []

        expect(completedRows).to.have.length(22)
        for (let row = 1; row <= 22; row++) {
            expect(audit, `audit row ${row}`).to.match(
                new RegExp(`^\\| ${row} \\|.*\\| Complete \\|$`, 'm')
            )
        }
        expect(audit).to.not.match(/\| (Pending|Incomplete|Blocked) \|/)
        for (const dimension of [
            'Current runtime facts',
            'Default operation history',
            'Incident history',
            'Deep capture',
            'Initial public buffer',
            'Initial public texture',
            'Texture replacement',
            'Scoped native validation',
            'OOM identifies',
            'synchronous native exception',
            'Device loss',
            'Uncaptured errors',
            'Pressure evidence',
            'Public TypeScript',
            'clean cut',
            'Every native buffer/texture',
            'Performance decisions',
            'Agent-facing evidence',
        ]) {
            expect(audit).to.include(dimension)
        }
    })

    it('inventories every current native buffer and texture creation call site', () => {

        const audit = read('docs', 'review', 'scratch-gpu-operation-provenance-audit.md')
        const callSites = nativeAllocationCallSites(
            path.join(root, 'packages', 'geoscratch', 'src')
        )
        const inventoryRows = audit.match(/^\| N\d+ \|.*\|$/gm) ?? []

        expect(callSites).to.have.length(16)
        expect(inventoryRows).to.have.length(16)
        for (const callSite of callSites) {
            expect(audit, callSite).to.include(`\`${callSite}\``)
        }
        expect(inventoryRows.filter(row => row.includes('Covered by this goal'))).to.have.length(3)
        expect(inventoryRows.filter(row => row.includes('Acknowledged readback staging'))).to.have.length(1)
        expect(inventoryRows.filter(row => row.includes('Internal deferred allocation'))).to.have.length(0)
        expect(inventoryRows.filter(row => row.includes('Raw native escape hatch'))).to.have.length(12)
        expect(inventoryRows.filter(row => row.includes('Unresolved defect'))).to.have.length(0)
    })

    it('records every required performance and browser measurement boundary', () => {

        const report = read(
            'docs',
            'review',
            'scratch-gpu-operation-provenance-performance.md'
        )

        for (const evidence of [
            'History capacity zero',
            'Default bounded recorder',
            'Steady-state overwrite',
            'Capture with full descriptors',
            'Capture with stacks',
            'Promise And Record Inventory',
            'After 10000 allocation cycles',
            'After 20000 allocation cycles',
            'Chrome WebGPU Evidence',
            '`textureResize` desktop',
            '`submissionOrder`',
            '`externalImageUpload`',
            '`readinessPolicies`',
            '`indirectExecution`',
            '`scratch_textureSampling`',
            '`scratch_renderToTexture`',
            'Actual queue-work completion',
        ]) {
            expect(report).to.include(evidence)
        }
        expect(report).to.include('not a portable percentage claim')
        expect(report).to.include('not a heap guarantee')
        expect(report).to.include('not part of these allocation numbers')
    })

    it('promotes browser diagnostic and canvas evidence into failing gates', () => {

        const verifier = read('tests', 'browser', 'scratch-gpu-operation-provenance.mjs')

        expect(verifier).to.include('result.allocationProbe.failures')
        expect(verifier).to.include('retained lifecycle subscribers')
        expect(verifier).to.include('default records retained full descriptors')
        expect(verifier).to.include('canvas appears blank')
        expect(verifier).to.include('quantizedColorCount')
        expect(verifier).to.include('requestFailures.length > 0')
    })

    it('makes benchmark bounds and the browser port executable reproduction gates', () => {

        const benchmark = read('tests', 'benchmarks', 'scratch-gpu-operation-provenance.mjs')
        const report = read(
            'docs',
            'review',
            'scratch-gpu-operation-provenance-performance.md'
        )

        expect(benchmark).to.include('verifyBenchmarkProfileSample')
        expect(benchmark).to.include('verifyLongRunResult')
        expect(benchmark).to.include("status: 'passed'")
        expect(benchmark).to.include('timingThresholdsEnforced: false')
        expect(report).to.include('--strictPort')
        expect(report).to.include('exits non-zero')
    })
})

function nativeAllocationCallSites(directory) {

    const result = []
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name)
        if (entry.isDirectory()) {
            result.push(...nativeAllocationCallSites(absolute))
            continue
        }
        if (!entry.isFile() || !/\.(?:js|ts)$/.test(entry.name)) continue

        const relative = path.relative(root, absolute).split(path.sep).join('/')
        for (const [ index, line ] of read(relative).split('\n').entries()) {
            if (line.includes('device.createBuffer(') || line.includes('device.createTexture(')) {
                result.push(`${relative}:${index + 1}`)
            }
        }
    }
    return result.sort()
}
