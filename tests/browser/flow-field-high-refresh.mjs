import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { chromium } from 'playwright'
import { launchSecondaryBrowser } from '../experiments/terrain-cover-placement/secondary-browser.mjs'

// Run alone. Native mode owns one background Chrome on a verified high-refresh
// non-main display. Headless results do not claim native 144 Hz presentation.
const base = process.env.FLOW_HIGH_REFRESH_BASE ?? 'http://127.0.0.1:5173'
const native = process.env.FLOW_HIGH_REFRESH_NATIVE === '1'
const output = process.env.FLOW_HIGH_REFRESH_OUTPUT ?? '/tmp/geoscratch-flow-high-refresh'
const viewport = {width:1760,height:880}
const managed = native ? await launchSecondaryBrowser({deviceScaleFactor:2,viewport}) : undefined
const browser = managed?.browser ?? await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-webgpu']})
const results = []
let verified = false
try {
    await mkdir(output,{recursive:true})
    const context = await browser.newContext({viewport,deviceScaleFactor:2})
    const page = await context.newPage()
    const errors = []
    page.on('pageerror',error=>errors.push(error.message))
    page.on('console',message=>{if(message.type()==='error')errors.push(message.text())})
    await page.goto(`${base}/flowField/?proof=1&rate=0.000000001&zoom=9`)
    await page.waitForFunction(()=>window.__FLOW_FIELD_PROOF__?.facts()?.lastFrame.presentationReady,
        undefined,{timeout:90000})
    await page.evaluate(()=>window.__FLOW_FIELD_PROOF__.seek(.277))
    for (const quality of ['native','balanced','balanced','native']) {
        await page.locator('[data-flow-control="trail-quality"]').selectOption(quality)
        const anchor = await page.evaluate(()=>window.__FLOW_FIELD_PROOF__.facts().renderer.particles.simulatedReferenceSteps)
        await page.waitForFunction(anchor=>{
            const f=window.__FLOW_FIELD_PROOF__.facts()
            return f.lastFrame.presentationReady&&f.workers.activeTaskCount===0&&
                f.renderer.particles.simulatedReferenceSteps>anchor+120
        },anchor,{timeout:90000})
        const result = await page.evaluate(async quality=>{
            const facts=()=>{
                const f=window.__FLOW_FIELD_PROOF__.facts()
                return {steps:f.renderer.particles.encodedSteps,referenceSteps:f.renderer.particles.simulatedReferenceSteps,
                    observed:f.frames.observedFrameCount,workers:f.workers.activeTaskCount,
                    comparisons:f.renderer.spawn.candidateComparisonCount,spatialBuilds:f.renderer.viewDemand.buildCount,
                    presentationSize:f.renderer.presentationSize,historySize:f.renderer.history.size}
            }
            const before=facts(),timestamps=[]
            let active=true,handle
            const tick=time=>{if(active){timestamps.push(time);handle=requestAnimationFrame(tick)}}
            handle=requestAnimationFrame(tick)
            const started=performance.now()
            await new Promise(resolve=>setTimeout(resolve,7000))
            const elapsed=performance.now()-started,after=facts()
            active=false;cancelAnimationFrame(handle)
            const intervals=timestamps.slice(1).map((value,index)=>value-timestamps[index]).sort((a,b)=>a-b)
            return {quality,elapsedMs:elapsed,updatesPerSecond:(after.steps-before.steps)*1000/elapsed,
                observedPerSecond:(after.observed-before.observed)*1000/elapsed,
                referenceStepsPerSecond:(after.referenceSteps-before.referenceSteps)*1000/elapsed,
                rafPerSecond:timestamps.length*1000/elapsed,rafP95Ms:intervals[Math.floor(intervals.length*.95)],
                dpr:devicePixelRatio,viewport:[innerWidth,innerHeight],before,after}
        },quality)
        assert.equal(result.before.workers,0)
        assert.equal(result.after.workers,0)
        assert.equal(result.before.comparisons,result.after.comparisons)
        assert.equal(result.before.spatialBuilds,result.after.spatialBuilds)
        assert.deepEqual(result.after.presentationSize,{width:3520,height:1760})
        assert.deepEqual(result.after.historySize,quality==='native'
            ?{width:3520,height:1760}:{width:1760,height:880})
        results.push(result)
        console.log(JSON.stringify({quality,updatesPerSecond:result.updatesPerSecond,rafPerSecond:result.rafPerSecond}))
    }
    const cleanup=await page.evaluate(()=>window.__FLOW_FIELD_PROOF__.dispose())
    assert.deepEqual(cleanup.cleanupFailures,[])
    assert.deepEqual(errors,[])
    await managed?.verifyPlacement()
    verified = true
} finally {
    await browser.close()
    await writeFile(`${output}/report.json`,JSON.stringify({status:verified?'observed':'failed',native,
        head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
        modifiedFiles:execFileSync('git',['diff','--name-only','HEAD'],{encoding:'utf8'}).trim().split('\n').filter(Boolean),
        display:managed?.evidence,results},null,2))
}
