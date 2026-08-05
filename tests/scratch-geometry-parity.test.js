import { createHash } from 'node:crypto'
import { expect } from 'chai'
import {
    plane as scratchPlane,
    sphere as scratchSphere,
} from '../packages/geoscratch/dist/scratch/index.js'

const hash = value => createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex')

const cases = [
    {
        label: 'plane(0)',
        scratch: () => scratchPlane(0),
        expected: 'fcbaddf9c8b86764363c623109a280788aab2f49d4c3b93488bacaa3ab253f58',
    },
    {
        label: 'plane(2)',
        scratch: () => scratchPlane(2),
        expected: '1cb90b38eed1c34efefb641cec29653a6236c70964244f7a8a2a520c628d9058',
    },
    {
        label: 'plane(6)',
        scratch: () => scratchPlane(6),
        expected: 'cd6e5be6682be080e083c09938ef385fcdd523084f0c2515f18cad0f0a92807a',
    },
    {
        label: 'sphere()',
        scratch: () => scratchSphere(),
        expected: '6e3c5099fe0e290e245161f6879d6fa4582abb54ff9e5ebde76e65605c10791e',
    },
    {
        label: 'sphere(1, 8, 4)',
        scratch: () => scratchSphere(1, 8, 4),
        expected: 'f13ef65c02cb94d1fcc06878a3c86168346f1e2055bba587a9479bb499b6899b',
    },
    {
        label: 'sphere(1, 8, 4, .2, 3, .1, 1.7)',
        scratch: () => scratchSphere(1, 8, 4, .2, 3, .1, 1.7),
        expected: '09a77f5de3465b78e39e2e2c27006fe5e0fa9579bf9f18f1e0bcee31fa3aacb8',
    },
]

describe('scratch geometry parity', () => {

    for (const testCase of cases) {
        it(`preserves ${testCase.label} byte facts`, () => {

            const scratchHash = hash(testCase.scratch())

            expect(scratchHash).to.equal(testCase.expected)
        })
    }
})
