import assert from 'node:assert/strict'
import { chromium } from 'playwright'

// Real example/GPU smoke proof, not the control-panel-only contour checkbox test.
const base = process.env.FLOW_CONTOUR_ORDER_BASE ?? 'http://127.0.0.1:5173'
const timeout = 90000
const browser = await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-webgpu']})
try {
    const page = await browser.newPage({viewport:{width:1000,height:700},deviceScaleFactor:1})
    const errors = [], stages = []
    page.on('pageerror',error=>errors.push(error.message))
    page.on('console',message=>{if(message.type()==='error') errors.push(message.text())})
    await page.goto(`${base}/flowField/?proof=1&rate=0.000000001&zoom=9`)
    await page.waitForFunction(()=>document.body.dataset.status==='error'||
        document.body.dataset.status==='ready'&&window.__FLOW_FIELD_PROOF__?.facts()?.lastFrame.presentationReady,
    undefined,{timeout})
    assert.equal(await page.locator('body').getAttribute('data-status'),'ready',errors.join('\n'))
    const control = name => page.locator(`[data-flow-control="${name}"]`)
    const read = () => page.evaluate(()=>{
        const f = window.__FLOW_FIELD_PROOF__.facts()
        return {state:document.body.dataset.status,frame:f.renderer.frameCount,
            observed:f.frames.observedFrameCount,submitted:f.frames.submittedFrameCount,
            ready:f.lastFrame.presentationReady,playing:f.timeline.playing,
            steps:f.renderer.particles.encodedSteps,reference:f.renderer.particles.simulatedReferenceSteps,
            referenceSteps:f.lastFrame.visualTime?.referenceSteps,
            temporal:f.lastFrame.temporal,contour:f.renderer.contour,
            view:document.querySelector('[data-flow-control="view"]').value,
            contourEnabled:document.querySelector('[data-flow-control="contour"]').checked}
    })
    async function settle(afterFrame = -1, paused = false) {
        const result = await page.waitForFunction(({afterFrame,paused})=>{
            const f = window.__FLOW_FIELD_PROOF__.facts()
            const settled = document.body.dataset.status==='error'||document.body.dataset.status==='ready'&&
                f.renderer.frameCount>afterFrame&&f.lastFrame.presentationReady&&f.workers.activeTaskCount===0&&
                f.frames.observedFrameCount>=f.frames.submittedFrameCount&&
                (!paused||!f.timeline.playing&&f.lastFrame.visualTime?.referenceSteps===0)
            if (!settled) return false
            // Capture at the settled boundary; another live frame may start before
            // a separate evaluate call, so do not reread this witness afterwards.
            return {state:document.body.dataset.status,frame:f.renderer.frameCount,
                observed:f.frames.observedFrameCount,submitted:f.frames.submittedFrameCount,
                ready:f.lastFrame.presentationReady,playing:f.timeline.playing,
                steps:f.renderer.particles.encodedSteps,reference:f.renderer.particles.simulatedReferenceSteps,
                referenceSteps:f.lastFrame.visualTime?.referenceSteps,
                temporal:f.lastFrame.temporal,contour:f.renderer.contour,
                view:document.querySelector('[data-flow-control="view"]').value,
                contourEnabled:document.querySelector('[data-flow-control="contour"]').checked}
        },{afterFrame,paused},{timeout})
        const state = await result.jsonValue()
        await result.dispose()
        assert.equal(state.state,'ready',errors.join('\n'))
        assert.deepEqual(errors,[],'Completed frame includes native work and contour overflow observation')
        return state
    }
    function requireContour(state) {
        assert.equal(state.contourEnabled,true)
        assert.ok(state.contour.candidateCount>0,'The real contour producer received visible candidate cells')
        assert.equal(state.contour.generation,state.temporal.pairGeneration)
        assert.equal(state.contour.currentSnapshotEpoch,state.temporal.lowerSnapshotEpoch)
        assert.equal(state.contour.nextSnapshotEpoch,state.temporal.upperSnapshotEpoch)
        assert.ok(state.observed>=state.submitted,'Contour overflow observation settled with the frame')
    }

    const before = await read()
    await page.evaluate(()=>{
        const p = window.__FLOW_FIELD_PROOF__
        p.seek(.277)
        p.setPresentation({view:'particles',sample:'interpolated',trails:true,contour:true,
            boundary:'sdf-center-linear',sdfFeatherTexels:.25})
    })
    await page.waitForFunction(steps=>window.__FLOW_FIELD_PROOF__.facts().renderer.particles.encodedSteps>steps+24,
        before.steps,{timeout})
    const playing = await settle(before.frame)
    requireContour(playing)
    assert.equal(playing.playing,true)
    assert.ok(playing.reference>before.reference)
    stages.push({name:'particles-playing',...playing})

    await page.evaluate(()=>window.__FLOW_FIELD_PROOF__.pause())
    const paused = await settle(playing.frame,true)
    requireContour(paused)
    stages.push({name:'particles-paused',...paused})
    function requirePaused(state) {
        assert.equal(state.playing,false)
        assert.equal(state.steps,paused.steps,'Paused presentation cannot run particle simulation')
        assert.equal(state.reference,paused.reference,'Paused presentation cannot accrue visual time')
        assert.equal(state.referenceSteps,0)
    }
    for (const view of ['status','speed']) {
        const previous = await read()
        await control('view').selectOption(view)
        const state = await settle(previous.frame,true)
        requireContour(state)
        requirePaused(state)
        assert.equal(state.view,view)
        stages.push({name:`${view}-contour`,...state})
    }

    // Isolate the GPU canvas from asynchronously loaded basemap tiles and controls.
    // Compare this frozen frame against itself; no stored or perceptual golden.
    const image = () => page.screenshot({style:
        'canvas:not(#GPUFrame),#FlowFieldControls,.maplibregl-control-container{visibility:hidden!important}'})
    const withContour = await image(), on = await read()
    await control('contour').uncheck()
    const off = await settle(on.frame,true)
    requirePaused(off)
    assert.equal(off.contourEnabled,false)
    const withoutContour = await image()
    await control('contour').check()
    const restored = await settle(off.frame,true)
    requireContour(restored)
    requirePaused(restored)
    const restoredImage = await image()
    assert.ok(!withContour.equals(withoutContour),'Contour must contribute actual visible GPU pixels')
    assert.ok(withContour.equals(restoredImage),'Paused contour on/off/on returns to the same image')
    stages.push({name:'speed-contour-off',...off},{name:'speed-contour-restored',...restored})

    await control('contour').uncheck()
    await control('view').selectOption('particles')
    const final = await settle(restored.frame,true)
    requirePaused(final)
    assert.equal(final.contourEnabled,false)
    stages.push({name:'particles-contour-off',...final})
    const cleanup = await page.evaluate(()=>window.__FLOW_FIELD_PROOF__.dispose())
    assert.deepEqual(cleanup.cleanupFailures,[])
    assert.equal(cleanup.pendingObservationsAfter,0)
    assert.deepEqual(errors,[])
    console.log(JSON.stringify({status:'passed',stages,overlayVisible:true,pausedOverlayABAExact:true,
        pendingObservationsAfter:cleanup.pendingObservationsAfter,errors}))
} finally { await browser.close() }
