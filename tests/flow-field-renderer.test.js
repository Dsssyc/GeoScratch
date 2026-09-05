import { expect } from 'chai'
import fs from 'node:fs'
import path from 'node:path'

const sourcePath = path.join(
    process.cwd(), 'examples', 'flowField', 'flow-renderer.ts'
)

describe('Flow Field renderer composition', () => {

    it('publishes and acknowledges every unique captured runtime exactly once', () => {

        const source = fs.readFileSync(sourcePath, 'utf8')
        expect(source).to.include('uniqueCaptureRuntimes(temporal.temporal)')
        expect(source).to.include('runtime.publish()')
        expect(source).to.include('active.gpu.encode(builder, publication.update)')
        expect(source).to.include('runtime.acknowledge(publication, submitted)')
        expect(source).to.include('Promise.allSettled([')
        expect(source).to.not.match(/\.prefetch|advanceFrame|framesPerTime/)
    })

    it('orders publication support simulation contour history and submission explicitly', () => {

        const source = fs.readFileSync(sourcePath, 'utf8')
        const publish = source.indexOf('encodePublications(builder, publications)')
        const demand = source.indexOf('const demandFrame = demand.encode(builder, view, prepared.temporal)')
        const pack = source.indexOf('const candidates = packFlowCandidateCells(')
        const spawn = source.indexOf('spawn.encode(')
        const particles = source.indexOf('particles.encode(builder, particleSpawn.bindings, prepared, view)')
        const contour = source.indexOf('contour.encode(builder, candidates')
        const history = source.indexOf('history.encode(builder, view')
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

    it('keeps time selection external and releases its frame capture after all observers', () => {

        const source = fs.readFileSync(sourcePath, 'utf8')
        expect(source).to.include('timeline: FlowTimelineSnapshot')
        expect(source).to.include('assertFlowTemporalCapture(timeline, prepared.temporal)')
        expect(source).to.include('await temporalBindings.prepareFrame(requestedLevel)')
        expect(source).to.include('error instanceof FlowTemporalBindingSupersededError')
        expect(source).to.include("if (prepared.state === 'failed') throw prepared.error")
        expect(source).to.include('settleFrameObservations(')
        expect(source).to.include('prepared.release()')
        expect(source).to.include('reconciliations.members')
        expect(source).to.not.include('temporal.advance')
        expect(source).to.not.include('initialize()')
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
        expect(source).to.include('async function flushResidency()')
        expect(source).to.include('async function suspendTemporal()')
        expect(source).to.include('await temporalBindings.suspend()')
        expect(source).to.include('residency flush requires an idle renderer')
        const flush = source.indexOf('async function flushResidency()')
        const lock = source.indexOf('constructionInFlight = new Promise', flush)
        const prepare = source.indexOf('temporalBindings.prepareFrame(requestedLevel)', flush)
        expect(lock).to.be.greaterThan(flush)
        expect(prepare).to.be.greaterThan(lock)
        expect(source).to.not.match(/runtime\.(?:device|queue)/)
        expect(source).to.not.match(/packages\/geoscratch\/src|flowLayer/)
        expect(source).to.not.match(/boundary(?:Texture|Feature)|depthTexture|wetMask|SDF/)
    })
})
