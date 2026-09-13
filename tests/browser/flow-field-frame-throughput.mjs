import assert from 'node:assert/strict'
import {mkdir,writeFile} from 'node:fs/promises'
import {execFileSync} from 'node:child_process'
import {chromium} from 'playwright'
import {launchSecondaryBrowser} from '../experiments/terrain-cover-placement/secondary-browser.mjs'

// Run alone. Change only the admission bound in an isolated page response, with
// identical Native rendering and source inputs. Production has no benchmark flag.
const base=process.env.FLOW_FRAME_THROUGHPUT_BASE??'http://127.0.0.1:5173'
const native=process.env.FLOW_FRAME_THROUGHPUT_NATIVE==='1'
const output=process.env.FLOW_FRAME_THROUGHPUT_OUTPUT??'/tmp/geoscratch-flow-frame-throughput'
const viewport={width:1760,height:880}
const managed=native?await launchSecondaryBrowser({deviceScaleFactor:2,viewport}):undefined
const browser=managed?.browser??await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-webgpu']})
const results=[]
let verified=false,bound=2
try{
    await mkdir(output,{recursive:true})
    const context=await browser.newContext({viewport,deviceScaleFactor:2})
    const page=await context.newPage(),errors=[]
    page.on('pageerror',e=>errors.push(e.message))
    page.on('console',m=>{if(m.type()==='error')errors.push(m.text())})
    await page.route('**/flowField/flow-renderer.ts*',async route=>{
        const response=await route.fetch(),body=await response.text()
        const declaration='export const FLOW_FIELD_MAXIMUM_IN_FLIGHT_FRAMES = 2;'
        assert.equal(body.split(declaration).length,2)
        await route.fulfill({response,body:body.replace(declaration,`export const FLOW_FIELD_MAXIMUM_IN_FLIGHT_FRAMES = ${bound};`)})
    })
    await page.addInitScript(()=>{
        const state=window.__throughput={enabled:false,submissions:0,completionMs:[]}
        const submit=GPUQueue.prototype.submit,done=GPUQueue.prototype.onSubmittedWorkDone
        GPUQueue.prototype.submit=function(buffers){if(state.enabled)state.submissions++;return submit.call(this,buffers)}
        GPUQueue.prototype.onSubmittedWorkDone=function(){
            const started=performance.now(),record=state.enabled
            return done.call(this).then(()=>{if(record&&state.enabled)state.completionMs.push(performance.now()-started)})
        }
    })
    for(bound of [1,2,2,1]){
        await page.goto(`${base}/flowField/?proof=1&rate=0.000000001&zoom=9&trailQuality=native`)
        await page.waitForFunction(()=>window.__FLOW_FIELD_PROOF__?.facts()?.lastFrame.presentationReady,undefined,{timeout:90000})
        await page.evaluate(()=>window.__FLOW_FIELD_PROOF__.seek(.277))
        const anchor=await page.evaluate(()=>window.__FLOW_FIELD_PROOF__.facts().renderer.particles.simulatedReferenceSteps)
        await page.waitForFunction(anchor=>{
            const f=window.__FLOW_FIELD_PROOF__.facts()
            return f.lastFrame.presentationReady&&f.workers.activeTaskCount===0&&
                f.renderer.particles.simulatedReferenceSteps>anchor+120&&
                !f.renderer.history.centerCache.pending&&f.renderer.spawn.cacheState==='ready'
        },anchor,{timeout:90000})
        const result=await page.evaluate(async bound=>{
            const facts=()=>{
                const f=window.__FLOW_FIELD_PROOF__.facts()
                return {steps:f.renderer.particles.encodedSteps,referenceSteps:f.renderer.particles.simulatedReferenceSteps,
                    submitted:f.frames.submittedFrameCount,observed:f.frames.observedFrameCount,
                    inFlight:f.renderer.inFlightFrameCount,maximum:f.renderer.maximumInFlightFrames,
                    comparisons:f.renderer.spawn.candidateComparisonCount,spatialBuilds:f.renderer.viewDemand.buildCount,
                    workers:f.workers.activeTaskCount,historySize:f.renderer.history.size,
                    presentationSize:f.renderer.presentationSize,lower:f.lastFrame.temporal.lowerSampleKey,
                    upper:f.lastFrame.temporal.upperSampleKey}
            }
            const before=facts(),timestamps=[],inFlight=[]
            window.__throughput.enabled=true
            let active=true,handle
            const tick=time=>{if(active){timestamps.push(time);inFlight.push(facts().inFlight);handle=requestAnimationFrame(tick)}}
            handle=requestAnimationFrame(tick)
            const started=performance.now()
            await new Promise(resolve=>setTimeout(resolve,7000))
            const elapsed=performance.now()-started,after=facts()
            window.__throughput.enabled=false;active=false;cancelAnimationFrame(handle)
            const percentile=(values,p)=>values.sort((a,b)=>a-b)[Math.floor((values.length-1)*p)]
            return {bound,elapsedMs:elapsed,before,after,
                updatesPerSecond:(after.steps-before.steps)*1000/elapsed,
                observedPerSecond:(after.observed-before.observed)*1000/elapsed,
                referenceStepsPerSecond:(after.referenceSteps-before.referenceSteps)*1000/elapsed,
                rafPerSecond:timestamps.length*1000/elapsed,peakInFlight:Math.max(...inFlight),
                nativeSubmissions:window.__throughput.submissions,
                queueCompletionP50Ms:percentile(window.__throughput.completionMs,.5),
                queueCompletionP95Ms:percentile(window.__throughput.completionMs,.95)}
        },bound)
        assert.equal(result.before.maximum,bound);assert.ok(result.peakInFlight<=bound)
        assert.equal(result.before.workers,0);assert.equal(result.after.workers,0)
        assert.equal(result.before.comparisons,result.after.comparisons)
        assert.equal(result.before.spatialBuilds,result.after.spatialBuilds)
        assert.equal(result.after.lower,'t00');assert.equal(result.after.upper,'t01')
        assert.deepEqual(result.after.historySize,{width:3520,height:1760})
        assert.deepEqual(result.after.presentationSize,result.after.historySize)
        assert.ok(Math.abs(result.nativeSubmissions-(result.after.submitted-result.before.submitted))<=1)
        results.push(result)
        console.log(JSON.stringify({bound,updatesPerSecond:result.updatesPerSecond,rafPerSecond:result.rafPerSecond,peakInFlight:result.peakInFlight}))
        const cleanup=await page.evaluate(()=>window.__FLOW_FIELD_PROOF__.dispose())
        assert.deepEqual(cleanup.cleanupFailures,[])
    }
    assert.deepEqual(errors,[])
    await managed?.verifyPlacement()
    verified=true
}finally{
    await browser.close()
    await writeFile(`${output}/report.json`,JSON.stringify({status:verified?'observed':'failed',native,
        head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),display:managed?.evidence,results},null,2))
}
