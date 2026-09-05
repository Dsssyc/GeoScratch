import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const base=process.env.FLOW_PREFETCH_FAILURE_BASE??'http://127.0.0.1:5173'
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-webgpu']})
let release
try {
    const page=await browser.newPage({viewport:{width:960,height:720}})
    const errors=[];page.on('pageerror',error=>errors.push(error.message))
    let failedRequests=0
    const future=/\/tiles\/WebMercatorQuad\/t02\/(?!4\/)/
    await page.route(future,route=>{
        failedRequests++
        return route.fulfill({status:404,body:'Intentional future-page failure'})
    })
    await page.goto(`${base}/flowField/index.html?proof=1&rate=0.001&zoom=10`)
    await page.waitForFunction(()=>window.__FLOW_FIELD_PROOF__?.facts()?.temporalWindow.prefetchState==='failed',
        undefined,{timeout:60000})
    await page.waitForTimeout(200)
    const before=await page.evaluate(()=>window.__FLOW_FIELD_PROOF__.facts().renderer.particles.encodedSteps)
    const failed=failedRequests
    await page.waitForTimeout(350)
    assert.equal(await page.locator('body').getAttribute('data-status'),'ready')
    assert.ok(await page.evaluate(before=>window.__FLOW_FIELD_PROOF__.facts().renderer.particles.encodedSteps>before,before))
    assert.equal(failedRequests,failed,'A failed speculative sample must not retry each frame')
    assert.ok(failed>0)
    await page.locator('[data-flow-control="play-pause"]').click()
    await page.unroute(future)
    await page.locator('[data-flow-control="time"]').fill('1.5')
    await page.locator('[data-flow-control="time"]').dispatchEvent('change')
    await page.waitForFunction(()=>document.body.dataset.status==='ready'&&
        window.__FLOW_FIELD_PROOF__.facts().lastFrame.temporal?.upperSampleKey==='t02',undefined,{timeout:60000})
    const repaired=await page.evaluate(()=>window.__FLOW_FIELD_PROOF__.facts().temporalWindow)
    assert.deepEqual(repaired.activeSampleKeys,['t01','t02'])
    assert.equal(repaired.state,'ready')
    const cleanup=await page.evaluate(()=>window.__FLOW_FIELD_PROOF__.dispose())
    assert.equal(cleanup.cleanupFailures.length,0)
    assert.equal(await page.evaluate(()=>window.__FLOW_FIELD_PROOF__.facts().temporalWindow.ownedRuntimeCount),0)
    assert.deepEqual(errors,[])
    await page.close()

    const pending=await browser.newPage({viewport:{width:960,height:720}})
    const gate=new Promise(resolve=>{release=resolve})
    let blocked=0
    await pending.route(future,async route=>{blocked++;await gate;await route.continue().catch(()=>undefined)})
    await pending.goto(`${base}/flowField/index.html?proof=1&rate=0.001&zoom=10`)
    await pending.waitForFunction(()=>window.__FLOW_FIELD_PROOF__?.facts()?.temporalWindow.prefetchState==='ready'&&
        window.__FLOW_FIELD_PROOF__.facts().workers.activeTaskCount>0,undefined,{timeout:60000})
    assert.ok(blocked>0)
    const stopped=await pending.evaluate(()=>window.__FLOW_FIELD_PROOF__.dispose())
    assert.equal(stopped.cleanupFailures.length,0)
    const final=await pending.evaluate(()=>window.__FLOW_FIELD_PROOF__.facts().temporalWindow)
    assert.equal(final.ownedRuntimeCount,0)
    assert.equal(final.pendingCreationCount,0)
    assert.equal(final.activeCaptureCount,0)
    console.log(JSON.stringify({status:'passed',failedRequests,blocked,foreground:repaired.activeSampleKeys,final}))
} finally {
    release?.()
    await browser.close()
}
