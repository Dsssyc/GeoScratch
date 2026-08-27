import { expect } from 'chai'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const moduleUrl = pathToFileURL(path.join(
    process.cwd(),
    'examples',
    'flowField',
    'flow-spawn-index.ts'
)).href

describe('Flow Field spawn index reference', () => {

    it('compacts only available candidates at or above the spawn threshold', async() => {

        const { compactFlowSpawnCandidates } = await import(moduleUrl)
        const candidates = [ 'a', 'b', 'c', 'd' ]
        const compacted = compactFlowSpawnCandidates({
            candidates,
            samples: [
                { available: true, speed: 0.5 },
                { available: false, speed: 2 },
                { available: true, speed: 0.099 },
                { available: true, speed: 0.1 },
            ],
            activitySpawn: 0.1,
            capacity: 4,
        })

        expect(compacted).to.deep.equal({
            candidates: [ 'a', 'd' ],
            count: 2,
            capacity: 4,
            dormant: false,
        })
        expect(Object.isFrozen(compacted)).to.equal(true)
        expect(Object.isFrozen(compacted.candidates)).to.equal(true)
    })

    it('represents empty support as dormant without rejection sampling', async() => {

        const { compactFlowSpawnCandidates, selectFlowSpawnCandidate } =
            await import(`${moduleUrl}?empty=1`)
        const compacted = compactFlowSpawnCandidates({
            candidates: [ 'a' ],
            samples: [ { available: true, speed: 0 } ],
            activitySpawn: 0.1,
            capacity: 2,
        })
        expect(compacted).to.deep.equal({
            candidates: [],
            count: 0,
            capacity: 2,
            dormant: true,
        })
        expect(selectFlowSpawnCandidate(compacted, 123)).to.equal(undefined)
    })

    it('selects deterministically from the compacted index', async() => {

        const { selectFlowSpawnCandidate } = await import(`${moduleUrl}?select=1`)
        const index = Object.freeze({
            candidates: Object.freeze([ 'a', 'b', 'c' ]),
            count: 3,
            capacity: 3,
            dormant: false,
        })
        expect(selectFlowSpawnCandidate(index, 0)).to.equal('a')
        expect(selectFlowSpawnCandidate(index, 4)).to.equal('b')
        expect(selectFlowSpawnCandidate(index, 0xffff_ffff)).to.equal('a')
    })

    it('hard-fails capacity instead of truncating active cells', async() => {

        const { compactFlowSpawnCandidates } = await import(`${moduleUrl}?overflow=1`)
        expect(() => compactFlowSpawnCandidates({
            candidates: [ 'a', 'b' ],
            samples: [
                { available: true, speed: 1 },
                { available: true, speed: 1 },
            ],
            activitySpawn: 0.1,
            capacity: 1,
        })).to.throw('Flow spawn index capacity was exceeded')
    })
})
