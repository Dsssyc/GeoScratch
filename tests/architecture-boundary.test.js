import { expect } from 'chai'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8')
const readJson = (...parts) => JSON.parse(read(...parts))

describe('architecture boundaries', () => {

    it('records the default runtime and package boundary decision', () => {

        const adr = read('docs', 'decisions', 'ADR-004-default-runtime-and-package-boundaries.md')

        expect(adr).to.include('default global runtime')
        expect(adr).to.include('deprecated compatibility aperture')
        expect(adr).to.include('StartDash')
    })

    it('keeps package public entrypoints explicit while src wildcard remains compatibility-only', () => {

        const pkg = readJson('packages', 'geoscratch', 'package.json')

        expect(pkg.exports).to.include.keys([ '.', './scratch', './geo', './geometry', './package.json' ])
        expect(pkg.exports['./src/*']).to.equal('./src/*')
    })
})
