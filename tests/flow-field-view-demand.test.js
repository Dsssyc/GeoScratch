import { expect } from 'chai'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createGeoViewSnapshot } from 'geoscratch/geo'

const sourcePath = path.join(process.cwd(), 'examples', 'flowField', 'flow-view-demand.ts')
const moduleUrl = pathToFileURL(sourcePath).href

function view(frameEpoch, residencySnapshotEpoch) {

    return createGeoViewSnapshot({
        id: `flow-view-${frameEpoch}`,
        clipFromRelativeWorld: [
            1, 0, 0, 0,
            0, 1, 0, 0,
            0, 0, 1, 0,
            0, 0, 0, 1,
        ],
        cameraHigh: [ 0, 0, 1 ],
        cameraLow: [ 0, 0, 0 ],
        referenceViewport: [ 1280, 720 ],
        verticalFovRadians: Math.PI / 3,
        cameraLatitudeRadians: 0.5,
        cameraPitchRadians: 0.4,
        zoomHint: 8,
        frameEpoch,
        residencySnapshotEpoch,
    })
}

describe('Flow Field public GPU view demand', () => {

    it('seeds a frozen empty batch with current view provenance', async() => {

        const { flowProjectedDemandBatch } = await import(moduleUrl)
        const current = view(7, 3)
        const batch = flowProjectedDemandBatch(current, undefined)

        expect(batch).to.deep.equal({
            kind: 'flow-projected-demand-batch',
            frameEpoch: 7,
            residencySnapshotEpoch: 3,
            overflowCount: 0,
            demands: [],
        })
        expect(Object.isFrozen(batch)).to.equal(true)
        expect(Object.isFrozen(batch.demands)).to.equal(true)
    })

    it('rebases last settled spatial demands onto current view provenance', async() => {

        const { flowProjectedDemandBatch } = await import(`${moduleUrl}?rebase=1`)
        const current = view(8, 4)
        const feedback = Object.freeze({
            kind: 'gpu-web-mercator-quad-demand-projection-feedback',
            projectionId: 'projection',
            coverId: 'cover',
            submissionId: 'submission',
            frameEpoch: 7,
            demandCount: 1,
            overflowCount: 0,
            sourceLevelCeiling: 9,
            demands: Object.freeze([ Object.freeze({
                desiredSampleLevel: 9,
                sourceLevelCeiling: 9,
                requestMatrixLevel: 8,
                tileRow: 103,
                tileCol: 213,
                priority: 17,
                decisionFrameEpoch: 7,
                residencySnapshotEpoch: 3,
            }) ]),
        })
        const batch = flowProjectedDemandBatch(current, feedback)

        expect(batch.frameEpoch).to.equal(8)
        expect(batch.residencySnapshotEpoch).to.equal(4)
        expect(batch.demands).to.deep.equal([ {
            ...feedback.demands[0],
            decisionFrameEpoch: 8,
            residencySnapshotEpoch: 4,
        } ])
        expect(Object.isFrozen(batch.demands[0])).to.equal(true)
    })

    it('constructs the current public cover and projection with one flat range', () => {

        const source = fs.readFileSync(sourcePath, 'utf8')
        expect(source).to.include('GpuWebMercatorQuadCover.create(runtime')
        expect(source).to.include('GpuWebMercatorQuadDemandProjection.create(runtime')
        expect(source).to.include('gpuWebMercatorQuadCoverPolicy(options.policy)')
        expect(source).to.include('verticalRangeMeters: [ 0, 0 ]')
        expect(source).not.to.include('verticalBounds:')
        expect(source).not.to.match(/runtime\.(?:device|queue)/)
        expect(source).not.to.match(/fakeSubmitted|as SubmittedWork|submitted = \{/)
        expect(source).not.to.match(/flowLayer|packages\/geoscratch\/src/)
    })

    it('encodes initialize cover projection and both captures in public order', () => {

        const source = fs.readFileSync(sourcePath, 'utf8')
        const initializeCover = source.indexOf('cover.initialize(builder)')
        const encodeCover = source.indexOf('cover.encode(builder, coverFrame)')
        const initializeProjection = source.indexOf('projection.initialize(builder)')
        const encodeProjection = source.indexOf('projection.encode(builder, demandFrame)')
        const captureCover = source.indexOf('cover.capture(builder, coverFrame)')
        const captureProjection = source.indexOf('projection.capture(builder, demandFrame)')
        expect(initializeCover).to.be.greaterThan(-1)
        expect(encodeCover).to.be.greaterThan(initializeCover)
        expect(initializeProjection).to.be.greaterThan(initializeCover)
        expect(encodeProjection).to.be.greaterThan(initializeProjection)
        expect(captureCover).to.be.greaterThan(encodeProjection)
        expect(captureProjection).to.be.greaterThan(captureCover)
        expect(source).to.include('return flowProjectedDemandBatch(view, latestDemandFeedback)')
    })

    it('settles only from a real submitted receipt and publishes feedback for the next frame', () => {

        const source = fs.readFileSync(sourcePath, 'utf8')
        expect(source).to.include('async function observe(submitted: SubmittedWork)')
        expect(source).to.include('cover.feedback(active.coverFrame, submitted)')
        expect(source).to.include('projection.feedback(active.demandFrame, submitted)')
        expect(source).to.include('latestDemandFeedback = demandFeedback')
        expect(source).to.include('function settlement()')
        expect(source).to.include('viewToken.dispose()')
        expect(source).to.include('projection.dispose()')
        expect(source).to.include('cover.dispose()')
    })
})
