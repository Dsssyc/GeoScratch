import { expect } from 'chai'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8')
const exists = (...parts) => fs.existsSync(path.join(root, ...parts))

describe('DEM flow history reprojection', () => {

    it('records the history reprojection decision as a new ADR', () => {

        expect(exists('docs', 'decisions', 'ADR-002-dem-flow-history-reprojection.md')).to.equal(true)

        const adr = read('docs', 'decisions', 'ADR-002-dem-flow-history-reprojection.md')

        expect(adr).to.include('# ADR-002: Reproject DEM Flow History During Camera Movement')
        expect(adr).to.include('screen-space reverse reprojection')
        expect(adr).to.include('Do not introduce a world-space or vector trail buffer')
        expect(adr).to.include('historyMode')
        expect(adr).to.include('reverse gather')
        expect(adr).to.include('Mercator `z=0` plane')
    })

    it('keeps ADR-001 history while superseding its camera movement decision', () => {

        const adr = read('docs', 'decisions', 'ADR-001-dem-flow-layer-artifact-cleanup.md')

        expect(adr).to.include('Mask cleanup remains accepted.')
        expect(adr).to.include('Camera movement handling is superseded by ADR-002.')
    })
})
