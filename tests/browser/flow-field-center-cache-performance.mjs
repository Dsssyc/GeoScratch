import assert from 'node:assert/strict'
import { chromium } from 'playwright'

// Run alone. Fixed source time/camera/DPR; only the local cache is disabled in
// the direct counterfactual. No user tab or production source is changed.
const base=process.env.FLOW_CENTER_CACHE_BASE ?? 'http://127.0.0.1:5173'
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-webgpu']})
const results=[]
try {
    for(const variant of ['reference','direct','cached']) {
        const reference=variant==='reference'
        const page=await browser.newPage({viewport:{width:1512,height:861},deviceScaleFactor:2})
        const errors=[]
        page.on('pageerror',error=>errors.push(error.message))
        page.on('console',message=>{if(message.type()==='error')errors.push(message.text())})
        if(reference)await page.route('**/flowLayer/flow-layer.ts*',async route=>{
            const response=await route.fetch(),body=await response.text()
            assert.ok(body.includes('advanceFieldState(graph, state);'))
            assert.ok(body.includes('progressRate: state.progress / (FRAMES_PER_FIELD - 1)'))
            await route.fulfill({response,body:body.replace('advanceFieldState(graph, state);','')
                .replace('progressRate: state.progress / (FRAMES_PER_FIELD - 1)','progressRate: 0.277')})
        })
        if(variant==='direct')await page.route('**/flowField/flow-renderer.ts*',async route=>{
            const response=await route.fetch(),body=await response.text()
            const marker='centerCache: { addressSpace: model.addressSpace, capacity: Math.min(FLOW_CENTER_CACHE_MAX_PAGES, maximumCandidatePages) }'
            assert.ok(body.includes(marker))
            await route.fulfill({response,body:body.replace(marker,'centerCache: void 0')})
        })
        await page.goto(`${base}/${reference?'flowLayer':'flowField'}/?proof=1&rate=0.000000001&zoom=9`)
        await page.waitForFunction(reference=>document.body.dataset.status==='error'||(reference
            ? window.__FLOW_LAYER_PROOF__?.facts()?.observedFrames>=75
            : window.__FLOW_FIELD_PROOF__?.facts()?.lastFrame.presentationReady),reference,{timeout:90000})
        assert.equal(await page.locator('body').getAttribute('data-status'),'ready',errors.join('\n'))
        if(!reference) {
            const before=await page.evaluate(()=>{
                const p=window.__FLOW_FIELD_PROOF__,n=p.facts().renderer.particles.encodedSteps
                p.seek(.277);p.setPresentation({view:'particles',sample:'interpolated',trails:true,contour:false,
                    boundary:'sdf-center-linear',sdfFeatherTexels:.25});return n
            })
            await page.waitForFunction(before=>{
                const f=window.__FLOW_FIELD_PROOF__.facts()
                return document.body.dataset.status==='error'||f.lastFrame.presentationReady&&f.workers.activeTaskCount===0&&f.renderer.particles.encodedSteps>before+90
            },before,{timeout:90000})
            assert.equal(await page.locator('body').getAttribute('data-status'),'ready',errors.join('\n'))
        }
        const result=await page.evaluate(async reference=>{
            const read=()=>{
                const f=reference?window.__FLOW_LAYER_PROOF__.facts():window.__FLOW_FIELD_PROOF__.facts()
                return reference?{steps:Number(f.observedFrames)}:{steps:f.renderer.particles.encodedSteps,
                    cache:f.renderer.history.centerCache,ready:f.lastFrame.presentationReady,workers:f.workers.activeTaskCount}
            }
            const start=performance.now(),before=read()
            await new Promise(resolve=>setTimeout(resolve,4000))
            const end=performance.now(),after=read()
            return {stepsPerSecond:(after.steps-before.steps)*1000/(end-start),before,after}
        },reference)
        if(!reference){assert.equal(result.before.ready,true);assert.equal(result.after.ready,true);assert.equal(result.after.workers,0)}
        if(variant==='cached') {
            assert.ok(result.before.cache.buildCount>0)
            assert.equal(result.after.cache.buildCount,result.before.cache.buildCount,'Changing alpha must reuse center records')
            assert.ok(result.after.cache.reuseCount>result.before.cache.reuseCount)
            await page.evaluate(()=>window.__FLOW_FIELD_PROOF__.pause())
            const count=result.after.cache.buildCount
            for(const boundary of ['sdf-center-smooth','sdf-center-linear']) {
                await page.locator('[data-flow-control="boundary"]').selectOption(boundary)
                await page.waitForFunction(boundary=>window.__FLOW_FIELD_PROOF__.facts().renderer.history.boundary===boundary,boundary)
                assert.equal(await page.evaluate(()=>window.__FLOW_FIELD_PROOF__.facts().renderer.history.centerCache.buildCount),count)
            }
            await page.evaluate(()=>{const p=window.__FLOW_FIELD_PROOF__;p.seek(1.277);p.play()})
            await page.waitForFunction(count=>{
                const f=window.__FLOW_FIELD_PROOF__.facts()
                return f.lastFrame.presentationReady&&f.lastFrame.temporal.lowerSampleKey==='t01'&&f.renderer.history.centerCache.buildCount>count
            },count,{timeout:90000})
        }
        const cleanup=await page.evaluate(reference=>reference?window.__FLOW_LAYER_PROOF__.dispose():window.__FLOW_FIELD_PROOF__.dispose(),reference)
        if(!reference){assert.deepEqual(cleanup.cleanupFailures,[]);assert.equal(cleanup.pendingObservationsAfter,0)}
        assert.deepEqual(errors,[])
        results.push({variant,...result,errors});await page.close()
    }
    const [reference,direct,cached]=results.map(value=>value.stepsPerSecond)
    console.log(JSON.stringify({results,cachedToReference:cached/reference,cachedToDirect:cached/direct}))
    assert.ok(cached>=reference*.85,'Resident center-cache cadence should approach frozen Flow Layer')
    if(direct<reference*.8)assert.ok(cached>direct*1.3,'A measured fragment bottleneck must improve materially')
} finally {await browser.close()}
