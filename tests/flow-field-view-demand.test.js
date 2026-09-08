import { expect } from 'chai'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { createGeoViewSnapshot, GpuWebMercatorQuadCover, GpuWebMercatorQuadDemandProjection } from 'geoscratch/geo'

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
        expect(source).to.include('projection.feedback(active.demandFrame!, submitted)')
        expect(source).to.include('latestDemandFeedback = demandFeedback')
        expect(source).to.include('function settlement()')
        expect(source).to.include('viewToken?.dispose()')
        expect(source).to.include('projection.dispose()')
        expect(source).to.include('cover.dispose()')
    })

    it('compares stable view identity and every camera fact but excludes frame/residency epochs', async() => {
        const { flowViewDecisionEquals } = await import(moduleUrl)
        const first = decisionView(1)
        expect(flowViewDecisionEquals(first,decisionView(2))).to.equal(true)
        for (const change of [
            {id:'different-view'}, {zoomHint:9}, {verticalFovRadians:1},
            {cameraLatitudeRadians:.7}, {cameraPitchRadians:.8},
            {referenceViewport:[1280,721]}, {cameraHigh:[0,0,2]}, {cameraLow:[.01,0,0]},
            {clipFromRelativeWorld:[2,...first.clipFromRelativeWorld.slice(1)]},
        ]) expect(flowViewDecisionEquals(first,decisionView(2,change))).to.equal(false)
    })

    it('reuses observed spatial feedback without GPU work and rebases only the current demand batch', async() => {
        await adapterFixture(async fixture => {
            const {adapter,calls,encode,receipt} = fixture
            const first = encode(decisionView(10))
            expect(first.batch.demands).to.have.length(0)
            expect(adapter.hasFeedbackFor(first.view)).to.equal(false)
            const settlement = await adapter.observe(receipt(first.builder))
            expect(calls.filter(call => call === 'capture')).to.have.length(3)
            expect(adapter.hasFeedbackFor(decisionView(11))).to.equal(true)
            const before = calls.length
            const next = encode(decisionView(11))
            expect(calls).to.have.length(before,'Reuse does not upload/encode/capture a cover or projection')
            expect(next.frame.coverFrame).to.equal(first.frame.coverFrame)
            expect(next.frame.frameEpoch).to.equal(11)
            expect(next.frame.residencySnapshotEpoch).to.equal(111)
            expect(next.batch.demands[0]).to.deep.equal({...settlement.demandFeedback.demands[0],
                decisionFrameEpoch:11,residencySnapshotEpoch:111})
            const reused = await adapter.observe(receipt(next.builder,'no-native-work'))
            expect(reused).to.equal(settlement,'No fake new GPU feedback or source-view provenance')
            expect(reused.sourceView).to.equal(first.view)
            expect(reused.coverFeedback.frameEpoch).to.equal(10)
            expect(reused.demandFeedback.frameEpoch).to.equal(10)
            expect(await adapter.settlement()).to.equal(settlement)
            expect(adapter.facts()).to.include({buildCount:1,reuseCount:1,latestSettledFrameEpoch:10,pending:false})
            const latest = encode(decisionView(12))
            await adapter.observe(receipt(latest.builder))
            expect(adapter.facts()).to.include({buildCount:1,reuseCount:2})
        })
    })

    it('rebuilds changed decisions and A-B-A, while temporal/presentation-only captures reuse', async() => {
        await adapterFixture(async fixture => {
            let epoch = 1
            const run = async changed => {
                const frame = fixture.encode(decisionView(epoch++,changed))
                await fixture.adapter.observe(fixture.receipt(frame.builder))
            }
            await run()
            await run()
            expect(fixture.adapter.facts()).to.include({buildCount:1,reuseCount:1})
            for (const changed of [{cameraLow:[1,0,0]}, undefined,
                {cameraPitchRadians:.8}, {verticalFovRadians:1}, {referenceViewport:[640,480]},
                {zoomHint:10}, {id:'another-view'}]) await run(changed)
            expect(fixture.adapter.facts()).to.include({buildCount:8,reuseCount:1})
            expect(fixture.calls.filter(call => call === 'capture')).to.have.length(24)
        })
    })

    it('never reuses staged or unobserved feedback and keeps hook ownership strict', async() => {
        await adapterFixture(async fixture => {
            const {adapter,newBuilder,receipt,gate} = fixture
            const current = decisionView(1), builder = newBuilder()
            const frame = adapter.cover.encode(builder,current)
            expect(() => adapter.cover.encode(newBuilder(),current)).to.throw('unsettled')
            expect(() => adapter.projection.encode(newBuilder(),frame,current)).to.throw('staged')
            expect(() => adapter.projection.encode(builder,frame,decisionView(1))).to.throw('staged')
            adapter.projection.encode(builder,frame,current)
            const native = gate({status:'observed-succeeded'})
            const observing = adapter.observe(receipt(builder,native.promise))
            expect(adapter.hasFeedbackFor(current)).to.equal(false)
            expect(() => fixture.encode(decisionView(2))).to.throw('unsettled')
            native.resolve({status:'observed-succeeded'})
            await observing
            const reused = fixture.encode(decisionView(2))
            expect(() => adapter.projection.encode(reused.builder,frame,current)).to.throw('staged')
            await adapter.observe(receipt(reused.builder))
            expect(adapter.facts()).to.include({buildCount:1,reuseCount:1})
        })
    })

    it('rejects failed/unobserved reuse receipts and rebuilds after any native rejection', async() => {
        await adapterFixture(async fixture => {
            for (const status of ['observed-failed','observation-failed','unobserved']) {
                const good = fixture.encode(decisionView(1))
                await fixture.adapter.observe(fixture.receipt(good.builder))
                const reused = fixture.encode(decisionView(2))
                await assert.rejects(fixture.adapter.observe(fixture.receipt(reused.builder,status)),/did not succeed/)
                expect(fixture.adapter.hasFeedbackFor(decisionView(2))).to.equal(false)
                expect(fixture.adapter.facts().pending).to.equal(false)
            }
            const good = fixture.encode(decisionView(3))
            await fixture.adapter.observe(fixture.receipt(good.builder))
            const reused = fixture.encode(decisionView(4))
            await assert.rejects(fixture.adapter.observe(fixture.receipt(reused.builder,
                Promise.reject(new Error('native observation rejected')))),/native observation rejected/)
            expect(fixture.adapter.hasFeedbackFor(decisionView(4))).to.equal(false)
            const rebuilding = fixture.encode(decisionView(5))
            await fixture.adapter.observe(fixture.receipt(rebuilding.builder))
            expect(fixture.adapter.facts()).to.include({buildCount:5,reuseCount:4})
        })
    })

    it('rejects unsubmitted/foreign receipts, cover overflow and no-native-work builds', async() => {
        await adapterFixture(async fixture => {
            const first = fixture.encode(decisionView(1))
            await assert.rejects(fixture.adapter.observe({runtime:fixture.runtime}),/owning SubmittedWork/)
            await assert.rejects(fixture.adapter.observe({runtime:{}}),/owning SubmittedWork/)
            await assert.rejects(fixture.adapter.observe(fixture.receipt(first.builder,'no-native-work')),/did not succeed/)
            expect(fixture.adapter.hasFeedbackFor(first.view)).to.equal(false)
            for (const field of ['descriptorOverflowCount','lookupOverflowCount']) {
                fixture.state[field] = 1
                const next = fixture.encode(decisionView(2))
                await assert.rejects(fixture.adapter.observe(fixture.receipt(next.builder)),/capacity was exceeded/)
                expect(fixture.adapter.hasFeedbackFor(next.view)).to.equal(false)
                fixture.state[field] = 0
            }
            const final = fixture.encode(decisionView(3))
            await fixture.adapter.observe(fixture.receipt(final.builder))
            expect(fixture.adapter.facts()).to.include({buildCount:4,reuseCount:0})
        })
    })

    it('preserves observed projection overflow for downstream complete-source fallback on every reuse', async() => {
        await adapterFixture(async fixture => {
            fixture.state.overflowCount = 3
            const first = fixture.encode(decisionView(1))
            const settled = await fixture.adapter.observe(fixture.receipt(first.builder))
            expect(settled.demandFeedback.overflowCount).to.equal(3)
            for (const epoch of [2,3]) {
                const next = fixture.encode(decisionView(epoch))
                expect(next.batch.overflowCount).to.equal(3)
                expect(next.batch.frameEpoch).to.equal(epoch)
                expect(next.batch.residencySnapshotEpoch).to.equal(epoch + 100)
                expect(next.batch.demands[0].decisionFrameEpoch).to.equal(epoch)
                expect(next.batch.demands[0].residencySnapshotEpoch).to.equal(epoch + 100)
                expect(await fixture.adapter.observe(fixture.receipt(next.builder))).to.equal(settled)
            }
            expect(fixture.adapter.facts()).to.include({buildCount:1,reuseCount:2})
        })
    })

    it('rejects projection after submission even when the spatial decision could be reused', async() => {
        await adapterFixture(async fixture => {
            const first = fixture.encode(decisionView(1))
            await fixture.adapter.observe(fixture.receipt(first.builder))
            const current = decisionView(2), builder = fixture.newBuilder()
            const frame = fixture.adapter.cover.encode(builder,current)
            fixture.receipt(builder,'no-native-work')
            expect(() => fixture.adapter.projection.encode(builder,frame,current)).to.throw('staged')
            expect(fixture.adapter.facts()).to.include({buildCount:1,reuseCount:0,pending:true})
        })
    })

    it('disposes staged/reused/unobserved ownership without reviving late feedback', async() => {
        for (const phase of ['staged','pending','observing','reused']) await adapterFixture(async fixture => {
            const current = decisionView(1), builder = fixture.newBuilder()
            const frame = fixture.adapter.cover.encode(builder,current)
            if (phase !== 'staged') fixture.adapter.projection.encode(builder,frame,current)
            let observing
            if (phase === 'observing') {
                const native = fixture.gate({status:'observed-succeeded'})
                observing = fixture.adapter.observe(fixture.receipt(builder,native.promise))
                const disposing = fixture.adapter.dispose()
                native.resolve({status:'observed-succeeded'})
                await disposing
            } else if (phase === 'reused') {
                await fixture.adapter.observe(fixture.receipt(builder))
                fixture.encode(decisionView(2))
            }
            await fixture.adapter.dispose()
            if (observing) await observing
            expect(fixture.adapter.hasFeedbackFor(current)).to.equal(false)
            expect(fixture.adapter.facts()).to.include({disposed:true,pending:false})
            expect(fixture.calls.filter(call => call === 'token:dispose')).to.have.length(1)
            expect(fixture.calls.filter(call => call === 'cover:dispose')).to.have.length(1)
            expect(fixture.calls.filter(call => call === 'projection:dispose')).to.have.length(1)
            await assert.rejects(fixture.adapter.observe(fixture.receipt(builder)),/disposed/)
        })
    })
})

function decisionView(epoch, changed = {}) {
    return createGeoViewSnapshot({...view(epoch,epoch + 100),id:'flow-stable-view',...changed})
}

// These public-owner fixtures test adapter orchestration, not native GPU geometry
// or SubmittedWork creation. Real cover/projection/browser proofs remain separate.
async function adapterFixture(run) {
    const createCover = GpuWebMercatorQuadCover.create
    const createProjection = GpuWebMercatorQuadDemandProjection.create
    const calls = [], gates = [], state = {}
    const runtime = {id:'view-demand-runtime'}
    let serial = 0, adapter
    const cover = {
        id:'cover', initialize() {calls.push('cover:initialize')},
        writeView(view) {
            calls.push('cover:writeView')
            let disposed = false
            return {view,get isDisposed() {return disposed},dispose() {
                if (!disposed) {disposed = true; calls.push('token:dispose')}
            }}
        },
        frame(token) {return Object.freeze({coverId:'cover',frameEpoch:token.view.frameEpoch,view:token.view})},
        encode() {calls.push('cover:encode')}, capture() {calls.push('capture')},
        async feedback(frame,submitted) {
            calls.push('cover:feedback')
            return Object.freeze({kind:'gpu-web-mercator-quad-cover-feedback',coverId:'cover',
                submissionId:submitted.id,frameEpoch:frame.frameEpoch,
                descriptorOverflowCount:state.descriptorOverflowCount ?? 0,
                lookupOverflowCount:state.lookupOverflowCount ?? 0})
        },
        dispose() {calls.push('cover:dispose')},
    }
    const projection = {
        id:'projection',initialize() {calls.push('projection:initialize')},frame:frame => frame,
        encode() {calls.push('projection:encode')}, capture() {calls.push('capture','capture')},
        async feedback(frame,submitted) {
            calls.push('projection:feedback')
            return Object.freeze({kind:'gpu-web-mercator-quad-demand-projection-feedback',
                projectionId:'projection',coverId:'cover',submissionId:submitted.id,frameEpoch:frame.frameEpoch,
                overflowCount:state.overflowCount ?? 0,demands:Object.freeze([Object.freeze({
                    desiredSampleLevel:9,sourceLevelCeiling:9,requestMatrixLevel:8,tileRow:103,tileCol:213,
                    priority:17,decisionFrameEpoch:frame.frameEpoch,residencySnapshotEpoch:frame.view.residencySnapshotEpoch,
                })])})
        },
        dispose() {calls.push('projection:dispose')},
    }
    GpuWebMercatorQuadCover.create = async() => cover
    GpuWebMercatorQuadDemandProjection.create = async() => projection
    try {
        const {createFlowViewDemandAdapter} = await import(moduleUrl)
        adapter = await createFlowViewDemandAdapter({runtime,spatialProfile:{},sourceCoverage:{},maximumDemands:16,
            policy:{minimumMatrixLevel:0,maximumMatrixLevel:14,maximumPatches:16,cellsPerPatchEdge:128,
                maximumCellSpanReferencePixels:5,refinementTolerance:.005}})
        const newBuilder = () => ({runtime,isSubmitted:false,id:`builder-${serial++}`})
        await run({adapter,runtime,calls,state,newBuilder,
            encode(view) {
                const builder = newBuilder(), frame = adapter.cover.encode(builder,view)
                return {view,builder,frame,batch:adapter.projection.encode(builder,frame,view)}
            },
            receipt(builder,status = 'observed-succeeded') {
                builder.isSubmitted = true
                return {runtime,id:`submitted-${serial++}`,done:Promise.resolve(),
                    nativeOutcome:typeof status === 'string' ? Promise.resolve({status}) : status}
            },
            gate(defaultValue) {
                let resolve
                const promise = new Promise(accept => {resolve = accept})
                gates.push(() => resolve(defaultValue))
                return {promise,resolve}
            },
        })
    } finally {
        for (const release of gates) release()
        try {await adapter?.dispose()} finally {
            GpuWebMercatorQuadCover.create = createCover
            GpuWebMercatorQuadDemandProjection.create = createProjection
        }
    }
}
