import { expect } from 'chai'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const moduleUrl = pathToFileURL(path.join(
    process.cwd(),
    'examples',
    'flowField',
    'flow-spawn-index.ts'
)).href
const sourcePath = path.join(process.cwd(), 'examples', 'flowField', 'flow-spawn-index.ts')
const shaderPath = path.join(
    process.cwd(), 'examples', 'flowField', 'shaders', 'spawn-index.compute.wgsl'
)

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

    it('owns fixed bounded GPU candidate counter output and overflow storage', () => {

        const source = fs.readFileSync(sourcePath, 'utf8')
        expect(source).to.include('export const FLOW_SPAWN_CANDIDATE_BYTE_LENGTH = 32')
        expect(source).to.include("label: 'Flow Field spawn candidates'")
        expect(source).to.include("label: 'Flow Field spawn counter'")
        expect(source).to.include("label: 'Flow Field spawn output'")
        expect(source).to.include("label: 'Flow Field spawn overflow'")
        expect(source).to.include('maximumCandidateCount * FLOW_SPAWN_CANDIDATE_BYTE_LENGTH')
        expect(source).to.include('capacity * FLOW_SPAWN_CANDIDATE_BYTE_LENGTH')
        expect(source).not.to.match(/runtime\.(?:device|queue)/)
        expect(source).not.to.match(/ReadbackCommand|createReadback|\.readback\(/)
    })

    it('injects one temporal sampler layout bind set and its declared resource reads', () => {

        const source = fs.readFileSync(sourcePath, 'utf8')
        expect(source).to.include('temporal: FlowSpawnTemporalBinding')
        expect(source).to.include('temporal.module.code')
        expect(source).to.include('temporal.bindLayout')
        expect(source).to.include('{ set: temporal.bindSet }')
        expect(source).to.include('...currentReads(temporal.resources)')
        expect(source).to.include('bindLayouts: [ spawnLayout, temporal.bindLayout ]')
        expect(source).not.to.include('temporal.bindSet.dispose()')
        expect(source).not.to.include('temporal.bindLayout.dispose()')
    })

    it('clears counters before one bounded compute pass and never uploads particle state', () => {

        const source = fs.readFileSync(sourcePath, 'utf8')
        const candidateUpload = source.indexOf('builder.upload(candidateUpload)')
        const uniformUpload = source.indexOf('builder.upload(uniformUpload)')
        const clearCounter = source.indexOf('builder.clear(clearCounter)')
        const clearOverflow = source.indexOf('builder.clear(clearOverflow)')
        const compute = source.indexOf('builder.compute(pass, [ dispatch ])')
        expect(candidateUpload).to.be.greaterThan(-1)
        expect(uniformUpload).to.be.greaterThan(candidateUpload)
        expect(clearCounter).to.be.greaterThan(uniformUpload)
        expect(clearOverflow).to.be.greaterThan(clearCounter)
        expect(compute).to.be.greaterThan(clearOverflow)
        expect(source).to.include('nextCandidateCount * FLOW_SPAWN_CANDIDATE_BYTE_LENGTH')
        expect(source).to.include('cpuReadback: false')
        expect(source).not.to.match(/particle/i)
    })

    it('compacts temporal speed support atomically and hard-signals overflow', () => {

        const shader = fs.readFileSync(shaderPath, 'utf8')
        expect(shader).to.include('var<storage, read> candidates')
        expect(shader).to.include('var<storage, read_write> counter')
        expect(shader).to.include('var<storage, read_write> output')
        expect(shader).to.include('var<storage, read_write> overflow')
        expect(shader).to.include('FlowVelocity_sample(')
        expect(shader).to.include('sample.speed < spawnUniform.activitySpawn')
        expect(shader).to.include('let outputIndex = atomicAdd(&counter.value, 1u)')
        expect(shader).to.include('atomicStore(&overflow.value, 1u)')
        expect(shader).not.to.match(/particle|textureStore|readback/i)
    })
})
