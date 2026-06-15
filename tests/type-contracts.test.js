import { expect } from 'chai'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8')
const exists = (...parts) => fs.existsSync(path.join(root, ...parts))
const readJson = (...parts) => JSON.parse(read(...parts))

describe('type contracts', () => {

    it('keeps the public API typecheck entrypoint wired', () => {

        expect(readJson('package.json').scripts.typecheck).to.equal('tsc -p tsconfig.types.json')
        expect(exists('tests', 'types', 'public-api.ts')).to.equal(true)
    })
})
