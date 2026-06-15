import { expect } from 'chai'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()

describe('HTTP client dependency removal', () => {

    it('does not depend on the removed HTTP client package', () => {

        const forbidden = ['ax', 'ios'].join('')
        const trackedFiles = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
            .trim()
            .split('\n')
            .filter(Boolean)
            .filter(file => !file.startsWith('tests/http-client-removal.test.js'))

        const offenders = trackedFiles.filter(file => {

            const source = fs.readFileSync(path.join(root, file), 'utf8').toLowerCase()
            return source.includes(forbidden)
        })

        expect(offenders).to.deep.equal([])
    })
})
