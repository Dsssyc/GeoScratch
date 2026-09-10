import { expect } from 'chai'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const manifest = JSON.parse(readFileSync(new URL('./fixtures/camera-cover-gpu-reference.json', import.meta.url)))

describe('frozen GPU camera-cover reference', () => {
    it('preserves the independent selector, demand, draw and shader implementation', () => {
        for (const [path, expected] of Object.entries(manifest.files)) {
            const bytes = readFileSync(new URL(`../${path}`, import.meta.url))
            expect(createHash('sha256').update(bytes).digest('hex'), path).to.equal(expected)
        }
    })
})
