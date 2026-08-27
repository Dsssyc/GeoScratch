import { expect } from 'chai'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const moduleUrl = pathToFileURL(path.join(
    process.cwd(),
    'examples',
    'flowField',
    'flow-particle-policy.ts'
)).href

describe('Flow Field particle lifecycle policy', () => {

    it('derives finite hysteresis thresholds from the velocity field maximum', async() => {

        const { flowActivityThresholds } = await import(moduleUrl)
        expect(flowActivityThresholds({ maximumSpeed: 4 })).to.deep.equal({
            spawn: 0.004,
            kill: 0.002,
            spawnRatio: 0.001,
            killRatio: 0.0005,
        })
        expect(() => flowActivityThresholds({ maximumSpeed: 0 }))
            .to.throw('maximumSpeed must be positive and finite')
        expect(() => flowActivityThresholds({
            maximumSpeed: 4,
            spawnRatio: 0.0001,
            killRatio: 0.0005,
        })).to.throw('spawnRatio must be greater than killRatio')
    })

    it('retires unavailable, unsupported, expired, and stagnant particles', async() => {

        const { classifyFlowParticle } = await import(`${moduleUrl}?classify=1`)
        const base = {
            available: true,
            speed: 0.5,
            ageSteps: 10,
            stagnantSteps: 2,
            activityKill: 0.1,
            maximumAgeSteps: 100,
            maximumStagnantSteps: 20,
        }
        expect(classifyFlowParticle(base)).to.equal('alive')
        expect(classifyFlowParticle({ ...base, available: false })).to.equal('retire')
        expect(classifyFlowParticle({ ...base, speed: 0.099 })).to.equal('retire')
        expect(classifyFlowParticle({ ...base, ageSteps: 100 })).to.equal('retire')
        expect(classifyFlowParticle({ ...base, stagnantSteps: 20 })).to.equal('retire')
    })

    it('uses displacement hysteresis without creating an immortal near-zero state', async() => {

        const { nextStagnantSteps } = await import(`${moduleUrl}?stagnant=1`)
        expect(nextStagnantSteps({
            previous: 4,
            displacementMeters: 0.001,
            minimumDisplacementMeters: 0.01,
        })).to.equal(5)
        expect(nextStagnantSteps({
            previous: 4,
            displacementMeters: 0.02,
            minimumDisplacementMeters: 0.01,
        })).to.equal(0)
        expect(nextStagnantSteps({
            previous: Number.MAX_SAFE_INTEGER,
            displacementMeters: 0,
            minimumDisplacementMeters: 0.01,
        })).to.equal(Number.MAX_SAFE_INTEGER)
    })

    it('rebirths without connecting the retired and replacement positions', async() => {

        const { rebirthFlowParticle, dormantFlowParticle } = await import(`${moduleUrl}?rebirth=1`)
        const position = Object.freeze([ 11, 22, 33, 44 ])
        const reborn = rebirthFlowParticle(position, 123)
        expect(reborn).to.deep.equal({
            current: position,
            previous: position,
            velocity: [ 0, 0 ],
            ageSteps: 0,
            stagnantSteps: 0,
            randomState: 123,
            state: 'active',
        })
        expect(reborn.current).to.equal(reborn.previous)
        expect(Object.isFrozen(reborn)).to.equal(true)
        expect(dormantFlowParticle(456)).to.deep.equal({
            current: [ 0, 0, 0, 0 ],
            previous: [ 0, 0, 0, 0 ],
            velocity: [ 0, 0 ],
            ageSteps: 0,
            stagnantSteps: 0,
            randomState: 456,
            state: 'dormant',
        })
    })
})
