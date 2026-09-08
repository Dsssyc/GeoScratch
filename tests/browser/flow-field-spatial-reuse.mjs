import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const browser = await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-webgpu']})
try {
    const page = await browser.newPage({viewport:{width:1200,height:800},deviceScaleFactor:1})
    const errors = []
    page.on('pageerror',error=>errors.push(error.message))
    page.on('console',message=>{if(message.type()==='error')errors.push(message.text())})
    await page.goto('http://127.0.0.1:5173/flowField/?proof=1&rate=0.000000001&zoom=9')
    await page.waitForFunction(()=>document.body.dataset.status==='error'||
        document.body.dataset.status==='ready'&&window.__FLOW_FIELD_PROOF__?.facts()?.renderer.viewDemand.reuseCount>30,
    undefined,{timeout:90000})
    assert.equal(await page.locator('body').getAttribute('data-status'),'ready',errors.join('\n'))
    const read = () => page.evaluate(()=>{
        const f=window.__FLOW_FIELD_PROOF__.facts(),v=f.lastFrame.view,d=f.lastFrame.demand
        return {frame:f.renderer.frameCount,observed:f.frames.observedFrameCount,steps:f.renderer.particles.encodedSteps,
            builds:f.renderer.viewDemand.buildCount,reuses:f.renderer.viewDemand.reuseCount,
            ready:f.lastFrame.presentationReady,workers:f.workers.activeTaskCount,playing:f.timeline.playing,
            pair:f.lastFrame.temporal?.lowerSampleKey,epoch:v?.residencySnapshotEpoch,
            demandFrame:d?.view.frameEpoch,viewFrame:v?.frameEpoch,
            pages:JSON.stringify(d?.candidatePages.map(page=>[page.tile?.key,page.level])),
            addressSpace:d?.candidatePages[0]?.addressSpaceId,viewport:v?.referenceViewport,
            camera:JSON.stringify([v?.clipFromRelativeWorld,v?.cameraHigh,v?.cameraLow]),
            reset:f.renderer.particles.resetCount}
    })
    const settled = () => page.waitForFunction(()=>{
        const f=window.__FLOW_FIELD_PROOF__.facts()
        return document.body.dataset.status==='ready'&&f.lastFrame.presentationReady&&f.workers.activeTaskCount===0&&
            f.frames.observedFrameCount>=f.frames.submittedFrameCount
    },undefined,{timeout:90000})
    async function cameraSettled() {
        for(let attempt=0;attempt<30;attempt++) {
            await settled()
            const before=await read()
            await page.waitForTimeout(150)
            const after=await read()
            if(before.camera===after.camera&&before.builds===after.builds&&after.ready)return
        }
        throw new Error('The final camera decision did not settle')
    }
    const initial=await read()
    await page.waitForTimeout(2000)
    const steady=await read()
    assert.equal(steady.builds,initial.builds,'Stationary playback must not rebuild the spatial decision')
    assert.ok(steady.reuses>initial.reuses+30)
    assert.ok(steady.steps>initial.steps+30,'Spatial reuse must not freeze advection')
    assert.equal(steady.pages,initial.pages)
    assert.equal(steady.demandFrame,steady.viewFrame,'Reuse must carry the current demand provenance')

    await page.evaluate(()=>window.__FLOW_FIELD_PROOF__.pause())
    await settled()
    const paused=await read()
    await page.locator('[data-flow-control="boundary"]').selectOption('sdf-center-linear')
    await settled()
    const style=await read()
    assert.equal(style.builds,paused.builds)
    assert.equal(style.steps,paused.steps)

    await page.evaluate(()=>window.__FLOW_FIELD_PROOF__.seek(1.277))
    await page.waitForFunction(()=>window.__FLOW_FIELD_PROOF__.facts().lastFrame.temporal?.lowerSampleKey==='t01',undefined,{timeout:90000})
    await settled()
    const temporal=await read()
    assert.equal(temporal.builds,paused.builds,'New temporal runtimes and publication epochs do not redefine the view')
    assert.equal(temporal.pages,paused.pages)
    assert.notEqual(temporal.addressSpace,paused.addressSpace,'Spatial reuse must still bind pages to the new temporal runtime')
    assert.equal(temporal.demandFrame,temporal.viewFrame)
    assert.equal(temporal.playing,false)

    await page.mouse.move(480,480)
    await page.mouse.down()
    await page.mouse.move(540,480,{steps:16})
    await page.mouse.up()
    await page.waitForFunction(builds=>window.__FLOW_FIELD_PROOF__.facts().renderer.viewDemand.buildCount>builds,temporal.builds)
    await cameraSettled()
    const pan=await read()
    assert.ok(pan.builds>temporal.builds,'Changed camera rebuilds even when paused')
    assert.notEqual(pan.camera,temporal.camera)
    assert.equal(pan.steps,temporal.steps)
    await page.mouse.move(540,480)
    await page.mouse.down({button:'right'})
    await page.mouse.move(540,425,{steps:16})
    await page.mouse.up({button:'right'})
    await page.waitForFunction(builds=>window.__FLOW_FIELD_PROOF__.facts().renderer.viewDemand.buildCount>builds,pan.builds)
    await cameraSettled()
    const pitch=await read()
    assert.ok(pitch.builds>pan.builds)
    assert.notEqual(pitch.camera,pan.camera)
    await page.setViewportSize({width:1100,height:750})
    await page.waitForFunction(()=>window.__FLOW_FIELD_PROOF__.facts().lastFrame.view?.referenceViewport[0]===1100)
    await cameraSettled()
    const resized=await read()
    assert.ok(resized.builds>pitch.builds)
    assert.deepEqual(resized.viewport,[1100,750])
    await page.evaluate(()=>window.__FLOW_FIELD_PROOF__.play())
    await page.waitForFunction(steps=>window.__FLOW_FIELD_PROOF__.facts().renderer.particles.encodedSteps>steps+40,resized.steps)
    const resumed=await read()
    assert.equal(resumed.builds,resized.builds,'A settled final view remains reusable after resume')
    assert.ok(resumed.reuses>resized.reuses+30)
    assert.equal(resumed.demandFrame,resumed.viewFrame)
    const cleanup=await page.evaluate(()=>window.__FLOW_FIELD_PROOF__.dispose())
    assert.deepEqual(cleanup.cleanupFailures,[])
    assert.equal(cleanup.pendingObservationsAfter,0)
    assert.deepEqual(errors,[])
    const compact=f=>({...f,pages:undefined,camera:undefined})
    console.log(JSON.stringify({status:'passed',initial:compact(initial),steady:compact(steady),style:compact(style),
        temporal:compact(temporal),pan:compact(pan),pitch:compact(pitch),resized:compact(resized),resumed:compact(resumed),errors}))
} finally {await browser.close()}
