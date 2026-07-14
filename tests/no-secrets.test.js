import { expect } from 'chai'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

const textFilePattern = /\.(css|d\.ts|html|js|json|md|ts|wgsl|yaml|yml)$/
const mapboxTokenPattern = /\b(?:pk|sk)\.[A-Za-z0-9._-]{20,}/

describe('secret hygiene', () => {

    it('keeps Mapbox tokens out of tracked text files', () => {

        const files = execFileSync('git', [
            'ls-files',
            '--cached',
            '--others',
            '--exclude-standard',
            '-z',
        ], { encoding: 'utf8' })
            .split('\0')
            .filter(Boolean)
            .filter(file => fs.existsSync(file))

        const offenders = []

        for (const file of files) {
            if (!textFilePattern.test(file)) {
                continue
            }

            const source = fs.readFileSync(file, 'utf8')
            if (mapboxTokenPattern.test(source)) {
                offenders.push(file)
            }
        }

        expect(offenders).to.deep.equal([])
    })

    it('keeps local env files ignored', () => {

        const ignored = execFileSync('git', ['check-ignore', 'examples/.env.local'], { encoding: 'utf8' })
            .trim()

        expect(ignored).to.equal('examples/.env.local')
    })
})
