import { readFile } from 'node:fs/promises'
import { expect } from 'chai'

describe('Worker bootstrap deployment', () => {

    it('emits as a standalone browser module without static sibling imports', async() => {

        const source = await readFile(new URL(
            '../packages/geoscratch/dist/worker/worker-bootstrap.js',
            import.meta.url
        ), 'utf8')

        expect(source).not.to.match(/^\s*import\s/m)
    })
})
