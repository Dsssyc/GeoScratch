import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const base = process.env.FLOW_LOOKAHEAD_BASE ?? 'http://127.0.0.1:5173'
const browser = await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-webgpu']})
try {
    const page = await browser.newPage({viewport:{width:1512,height:861},deviceScaleFactor:2})
    const errors=[]
    page.on('pageerror',error=>errors.push(error.message))
    page.on('console',message=>{if(message.type()==='error')errors.push(message.text())})
    await page.goto(`${base}/flowField/index.html?proof=1&rate=0.2&zoom=10`)
    async function waitWarm() {
        await page.waitForFunction(()=>document.body.dataset.status==='error'||
            (window.__FLOW_FIELD_PROOF__?.facts()?.renderer.prefetch?.pagesResident===true &&
                window.__FLOW_FIELD_PROOF__.facts().renderer.prefetch.sampleKey===
                    window.__FLOW_FIELD_PROOF__.facts().temporalWindow.prefetchSampleKey &&
                window.__FLOW_FIELD_PROOF__.facts().lastFrame.presentationReady===true),undefined,{timeout:60000})
        assert.equal(await page.locator('body').getAttribute('data-status'),'ready')
    }
    async function measure(duration) {
        return await page.evaluate(async duration=>{
            const start=performance.now(),warm=new Set(),events=[],gaps=[]
            let lastStep,firstStep,lastProgress=start,lastKeys,loading=0,maxOwned=0,changedViews=0,viewKey
            return await new Promise(resolve=>{
                const read=()=>{
                    const now=performance.now(),f=window.__FLOW_FIELD_PROOF__.facts(),frame=f.lastFrame
                    const step=f.renderer.particles.encodedSteps
                    const prefetch=f.renderer.prefetch
                    if(prefetch?.pagesResident)warm.add(prefetch.sampleKey)
                    const keys=f.temporalWindow.activeSampleKeys
                    if(lastKeys && keys.join(',')!==lastKeys.join(',')) {
                        events.push({ms:now-start,keys,prepared:keys.filter(key=>!lastKeys.includes(key)).every(key=>warm.has(key)),
                            model:f.timeline.modelTime,ready:frame.presentationReady})
                    }
                    const key=JSON.stringify([frame.view?.clipFromRelativeWorld,frame.view?.cameraHigh,frame.view?.cameraLow])
                    viewKey??=key
                    if(key!==viewKey)changedViews++
                    maxOwned=Math.max(maxOwned,f.temporalWindow.ownedRuntimeCount+f.temporalWindow.pendingCreationCount)
                    if(document.body.dataset.status!=='ready')loading++
                    firstStep??=step
                    if(lastStep!==undefined&&step!==lastStep){
                        const elapsed=now-lastProgress
                        if(elapsed>100)gaps.push(elapsed)
                        lastProgress=now
                    }
                    lastKeys=[...keys];lastStep=step
                    if(now-start>=duration)resolve({events,gaps,loading,maxOwned,changedViews,
                        stepsPerSecond:(step-firstStep)*1000/(now-start),warmed:[...warm]})
                    else requestAnimationFrame(read)
                };read()
            })
        },duration)
    }
    await waitWarm()
    const forward=await measure(22000)
    assert.ok(forward.events.length>=4,'Observe multiple ordinary forward handoffs')
    assert.ok(forward.events.every(event=>event.prepared),'New endpoints must have view pages before activation')
    assert.equal(forward.loading,0,'Prepared transitions must not buffer')
    assert.equal(forward.gaps.length,0,'Prepared playback must not have the old half-second pauses')
    assert.equal(forward.changedViews,0)
    assert.ok(forward.maxOwned<=4)
    await page.locator('[data-flow-control="rate"]').selectOption('-0.2')
    await waitWarm()
    const reverse=await measure(11500)
    assert.ok(reverse.events.length>=2)
    assert.ok(reverse.events.every(event=>event.prepared))
    assert.equal(reverse.loading,0)
    assert.equal(reverse.gaps.length,0)
    assert.ok(reverse.maxOwned<=4)
    await page.locator('[data-flow-control="play-pause"]').click()
    await page.waitForFunction(()=>window.__FLOW_FIELD_PROOF__.facts().temporalWindow.prefetchState==='idle')
    const cleanup=await page.evaluate(()=>window.__FLOW_FIELD_PROOF__.dispose())
    assert.equal(cleanup.cleanupFailures.length,0)
    const final=await page.evaluate(()=>window.__FLOW_FIELD_PROOF__.facts().temporalWindow)
    assert.equal(final.ownedRuntimeCount,0)
    assert.equal(final.pendingCreationCount,0)
    assert.equal(final.activeCaptureCount,0)
    assert.deepEqual(errors,[])
    console.log(JSON.stringify({status:'passed',forward,reverse,final,errors}))
} finally {
    await browser.close()
}
