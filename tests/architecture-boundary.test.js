import { expect } from 'chai'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8')
const readJson = (...parts) => JSON.parse(read(...parts))
const exists = (...parts) => fs.existsSync(path.join(root, ...parts))

describe('architecture boundaries', () => {

    it('records the default runtime and package boundary history', () => {

        const adr = read('docs', 'decisions', 'ADR-004-default-runtime-and-package-boundaries.md')

        expect(adr).to.include('default global runtime')
        expect(adr).to.include('superseded by ADR-006')
        expect(adr).to.include('StartDash')
    })

    it('keeps package public entrypoints explicit through dist outputs', () => {

        const pkg = readJson('packages', 'geoscratch', 'package.json')
        const adr = read('docs', 'decisions', 'ADR-006-scratch-typescript-source-dist-boundary.md')

        expect(Object.keys(pkg.exports)).to.deep.equal([
            '.',
            './scratch',
            './geo',
            './package.json',
        ])
        expect(pkg.exports).to.not.have.property('./src/*')
        expect(pkg.exports).to.not.have.property('./worker')
        expect(pkg.exports).to.not.have.property('./geometry')
        expect(adr).to.include('dist outputs')
    })

    it('records the Geo TypeScript source-first boundary', () => {

        expect(exists(
            'docs',
            'decisions',
            'ADR-054-geo-typescript-source-dist-boundary.md',
        )).to.equal(true)

        const adr = read('docs', 'decisions', 'ADR-054-geo-typescript-source-dist-boundary.md')

        expect(adr).to.include('TypeScript source-first')
        expect(adr).to.include('projection')
        expect(adr).to.include('dist/geo')
    })
})
