import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect } from 'chai'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const scratchRoot = path.join(root, 'packages', 'geoscratch', 'src', 'scratch')
const readbackFiles = [
    'readback.ts',
    'readback-staging.ts',
    'readback-mapping.ts',
    'command.ts',
    'submission.ts',
]

function read(...segments) {

    return fs.readFileSync(path.join(root, ...segments), 'utf8')
}

function callSites(pattern) {

    const sites = []
    for (const file of readbackFiles) {
        const source = fs.readFileSync(path.join(scratchRoot, file), 'utf8')
        for (const [index, line] of source.split('\n').entries()) {
            if (pattern.test(line)) {
                sites.push(`packages/geoscratch/src/scratch/${file}:${index + 1}`)
            }
        }
    }
    return sites
}

describe('scratch readback source and attribution audit', () => {

    it('routes staging allocation and mapping through one shared transaction each', () => {

        const allocations = callSites(/\b(?:device|runtime\.device)\.createBuffer\s*\(/)
        const mappings = callSites(/\bbuffer\.mapAsync\s*\(/)

        expect(allocations).to.deep.equal([
            allocations.find(site => site.includes('/readback-staging.ts:')),
        ])
        expect(mappings).to.deep.equal([
            mappings.find(site => site.includes('/readback-mapping.ts:')),
        ])
        expect(read('packages', 'geoscratch', 'src', 'scratch', 'submission.ts'))
            .not.to.match(/\.createBuffer\s*\(/)
        expect(read('packages', 'geoscratch', 'src', 'scratch', 'readback.ts'))
            .not.to.match(/await\s+(?:this\.)?after\.done/)
        expect(read('packages', 'geoscratch', 'src', 'scratch', 'readback.ts'))
            .not.to.include('SCRATCH_READBACK_MAP_FAILED')
    })

    it('keeps constructors and native staging ownership outside the public surface', () => {

        const command = read('packages', 'geoscratch', 'src', 'scratch', 'command.ts')
        const readback = read('packages', 'geoscratch', 'src', 'scratch', 'readback.ts')
        const runtime = read('packages', 'geoscratch', 'src', 'scratch', 'runtime.ts')

        expect(command).to.include('private constructor(')
        expect(readback).to.include('private constructor(')
        expect(runtime).to.match(/async createReadbackCommand\([^)]*\): Promise<ReadbackCommand>/)
        expect(runtime).to.match(/readbackCommand\([^)]*\): Promise<ReadbackCommand>/)
        expect(readback).not.to.match(/get\s+stagingBuffer\s*\(/)
    })

    it('publishes exact native call sites and honest attribution classes', () => {

        const audit = read('docs', 'review', 'scratch-readback-staging-mapping-audit.md')
        const nativeSites = [
            ...callSites(/\b(?:device|runtime\.device)\.createBuffer\s*\(/),
            ...callSites(/\bbuffer\.mapAsync\s*\(/),
        ]

        for (const site of nativeSites) expect(audit).to.include(`\`${site}\``)
        for (const marker of [
            'Exact operation',
            'Enclosing operation family',
            'Temporal correlation',
            'Unknown',
            'Logical staging bytes are not physical residency',
            '20,000 direct operations',
            '5,000 ordered reuses',
            '11-page regression matrix',
        ]) {
            expect(audit).to.include(marker)
        }
        expect(audit.match(/^\| R\d+ \|.*\|$/gm)).to.have.length(18)
    })
})
