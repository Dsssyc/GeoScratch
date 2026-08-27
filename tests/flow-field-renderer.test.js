import { expect } from 'chai'
import fs from 'node:fs'
import path from 'node:path'
import { flowEncodedTemporalSnapshot } from '../examples/flowField/flow-frame-provenance.ts'

const sourcePath = path.join(
    process.cwd(), 'examples', 'flowField', 'flow-renderer.ts'
)

describe('Flow Field renderer composition', () => {

    it('binds frame provenance to the publications sampled in the same submission', () => {

        const acknowledged = Object.freeze({
            generation: 1,
            currentTimeIndex: 0,
            nextTimeIndex: 1,
            prefetchTimeIndex: 2,
            frameInTime: 0,
            framesPerTime: 2,
            progress: 0,
            temporalResidencyEpoch: 5,
            currentSnapshotEpoch: 7,
            nextSnapshotEpoch: 8,
        })
        expect(flowEncodedTemporalSnapshot(acknowledged, 9, 8)).to.deep.equal({
            ...acknowledged,
            temporalResidencyEpoch: 6,
            currentSnapshotEpoch: 9,
            nextSnapshotEpoch: 8,
        })
        expect(() => flowEncodedTemporalSnapshot(acknowledged, 6, 8))
            .to.throw(/backwards/i)
    })

    it('initializes and acknowledges exactly three bounded temporal runtimes', () => {

        const source = fs.readFileSync(sourcePath, 'utf8')
        expect(source).to.include('temporal.current.initialize()')
        expect(source).to.include('temporal.next.initialize()')
        expect(source).to.include('temporal.prefetch.initialize()')
        expect(source).to.include('temporal.setPendingPublications(')
        expect(source).to.include('temporal.encodePending(initialBuilder)')
        expect(source).to.include('temporal.acknowledgePending(initialSubmitted)')
        expect(source).to.include('temporal.prefetch.acknowledge(')
        expect(source).to.include('temporal.recordPrefetchPublication(')
    })

    it('orders publication support simulation contour history and submission explicitly', () => {

        const source = fs.readFileSync(sourcePath, 'utf8')
        const publish = source.indexOf('temporal.encodePending(builder)')
        const demand = source.indexOf('const demandFrame = demand.encode(builder, view)')
        const pack = source.indexOf('const candidates = packFlowCandidateCells(')
        const spawn = source.indexOf('spawn.encode(builder, candidates')
        const particles = source.indexOf('particles.encode(builder, particleSpawn.bindings)')
        const contour = source.indexOf('contour.encode(builder, candidates')
        const history = source.indexOf('const historyFrame = history.encode(builder, view')
        const submit = source.indexOf('const submitted = builder.submit()', publish)

        expect(publish).to.be.greaterThan(-1)
        expect(demand).to.be.greaterThan(publish)
        expect(pack).to.be.greaterThan(demand)
        expect(spawn).to.be.greaterThan(pack)
        expect(particles).to.be.greaterThan(spawn)
        expect(contour).to.be.greaterThan(particles)
        expect(history).to.be.greaterThan(contour)
        expect(submit).to.be.greaterThan(history)
        expect(source.match(/packFlowCandidateCells\(/g)).to.have.length(1)
    })

    it('rotates only after observation and latest demand settlement', () => {

        const source = fs.readFileSync(sourcePath, 'utf8')
        const native = source.indexOf('observeFlowSubmittedWork(submitted)')
        const demand = source.indexOf('encodedTemporal.frameInTime ===')
        const advance = source.indexOf('const advanced = await temporal.advanceFrame()')
        const initialize = source.indexOf('const publication = await prefetchRuntime.initialize()')
        const refresh = source.indexOf('await activeBindings.refresh()')

        expect(native).to.be.greaterThan(-1)
        expect(demand).to.be.greaterThan(native)
        expect(advance).to.be.greaterThan(demand)
        expect(initialize).to.be.greaterThan(advance)
        expect(refresh).to.be.greaterThan(initialize)
    })

    it('uses only velocity-derived products and public package entrypoints', () => {

        const source = fs.readFileSync(sourcePath, 'utf8')
        expect(source).to.include('flowActivityThresholds')
        expect(source).to.include('createFlowSpawnIndex')
        expect(source).to.include('createFlowContour')
        expect(source).to.include('createFlowHistory')
        expect(source).to.include('permits exactly one frame in flight')
        expect(source).to.include('await frameInFlight')
        expect(source).to.include('viewDemandProducer.maxDemands')
        expect(source).to.include('needsFollowUp: false')
        expect(source).to.not.match(/runtime\.(?:device|queue)/)
        expect(source).to.not.match(/packages\/geoscratch\/src|flowLayer/)
        expect(source).to.not.match(/boundary(?:Texture|Feature)|depthTexture|wetMask|SDF/)
    })
})
