import assert from 'node:assert/strict'
import {mkdir,writeFile} from 'node:fs/promises'
import {chromium} from 'playwright'

const output=process.env.FLOW_FRAME_PIPELINE_OUTPUT??'/tmp/geoscratch-flow-frame-pipeline'
await mkdir(output,{recursive:true})
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-webgpu']})
const results=[]
try{
    for(const scenario of ['reverse-observation','resize','camera','temporal','contour','dispose','dispose-during-construction','native-failure']){
        const page=await browser.newPage({viewport:{width:960,height:640},deviceScaleFactor:2}),errors=[]
        page.on('pageerror',e=>errors.push(e.message))
        await page.addInitScript(()=>{
            const state=window.__flightProof={remaining:0,gates:[],disposed:false,disposal:undefined,nativeSubmissions:0}
            const submit=GPUQueue.prototype.submit
            GPUQueue.prototype.submit=function(buffers){state.nativeSubmissions++;return submit.call(this,buffers)}
            const done=GPUQueue.prototype.onSubmittedWorkDone
            GPUQueue.prototype.onSubmittedWorkDone=function(){
                const native=done.call(this)
                if(state.remaining<=0)return native
                state.remaining--
                let resolve,reject
                const hold=new Promise((yes,no)=>{resolve=yes;reject=no})
                state.gates.push({resolve,reject})
                return Promise.all([native,hold]).then(()=>undefined)
            }
        })
        await page.goto('http://127.0.0.1:5173/flowField/?proof=1&rate=0.000000001&zoom=9&trailQuality=native')
        await page.waitForFunction(()=>{
            const f=window.__FLOW_FIELD_PROOF__?.facts()
            return document.body.dataset.status==='error'||f?.lastFrame.presentationReady&&f.workers.activeTaskCount===0&&
                f.renderer.particles.simulatedReferenceSteps>120&&!f.renderer.history.centerCache.pending&&f.renderer.spawn.cacheState==='ready'
        },undefined,{timeout:90000})
        assert.equal(await page.locator('body').getAttribute('data-status'),'ready')
        if(scenario==='contour'){
            await page.locator('[data-flow-control="contour"]').check()
            await page.waitForFunction(()=>window.__FLOW_FIELD_PROOF__.facts().renderer.contour.candidateCount>0,undefined,{timeout:30000})
        }
        const count=scenario==='contour'?1:2
        const before=await page.evaluate(count=>{window.__flightProof.remaining=count;return window.__FLOW_FIELD_PROOF__.facts().frames.submittedFrameCount},count)
        await page.waitForFunction(count=>window.__flightProof.gates.length===count&&window.__FLOW_FIELD_PROOF__.facts().frames.inFlightFrameCount===count,count,{timeout:30000})
        const held=await facts(page)
        assert.equal(held.rendererInFlight,count);assert.equal(held.activeFrames,count)
        assert.ok(held.submitted>=before+count)
        await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,120)))
        assert.equal((await facts(page)).submitted,held.submitted,'A third frame cannot pass the two-slot budget')

        if(scenario==='reverse-observation'){
            await page.evaluate(()=>window.__FLOW_FIELD_PROOF__.pause())
            await page.evaluate(()=>window.__flightProof.gates[1].resolve())
            await page.waitForFunction(submitted=>{const f=window.__FLOW_FIELD_PROOF__.facts();return f.frames.submittedFrameCount>submitted&&!f.frames.rendering&&f.frames.inFlightFrameCount===1&&f.renderer.visualTime.referenceSteps===0},held.submitted,{timeout:30000})
            const newer=await facts(page)
            await page.evaluate(()=>window.__flightProof.gates[0].resolve())
            await idle(page)
            const final=await facts(page)
            assert.deepEqual(final.presented,newer.presented,'Older completion cannot replace the newer observed time')
            assert.equal(final.steps,held.steps,'Paused queued work cannot advance particles')
            results.push({scenario,held,newer,final})
            const cleanup=await page.evaluate(()=>window.__FLOW_FIELD_PROOF__.dispose());assert.deepEqual(cleanup.cleanupFailures,[])
        }else if(['resize','camera','temporal'].includes(scenario)){
            await page.evaluate(()=>window.__FLOW_FIELD_PROOF__.pause())
            if(scenario==='resize')await page.locator('[data-flow-control="trail-quality"]').selectOption('balanced')
            else if(scenario==='temporal')await page.evaluate(()=>window.__FLOW_FIELD_PROOF__.seek(1.277))
            else {await page.mouse.move(180,350);await page.mouse.down();await page.mouse.move(220,370,{steps:3});await page.mouse.up()}
            assert.deepEqual((await facts(page)).history,held.history)
            await page.evaluate(()=>window.__flightProof.gates[0].resolve())
            await page.waitForFunction(()=>window.__FLOW_FIELD_PROOF__.facts().frames.rendering,undefined,{timeout:30000})
            const waiting=await facts(page)
            assert.deepEqual(waiting.history,held.history,'Resize must wait for both old native frames')
            assert.equal(waiting.spatialBuilds,held.spatialBuilds,'Spatial rebuild cannot overwrite an outstanding reused cut')
            await page.evaluate(()=>window.__flightProof.gates[1].resolve())
            await idle(page)
            const final=await facts(page)
            if(scenario==='resize')assert.deepEqual(final.history,{width:960,height:640})
            if(scenario==='camera')assert.ok(final.spatialBuilds>held.spatialBuilds)
            if(scenario==='temporal')assert.equal(final.presented.lowerSampleKey,'t01')
            assert.equal(final.steps,held.steps)
            if(scenario!=='temporal')assert.equal(final.resets,held.resets)
            results.push({scenario,held,waiting,final})
            const cleanup=await page.evaluate(()=>window.__FLOW_FIELD_PROOF__.dispose());assert.deepEqual(cleanup.cleanupFailures,[])
        }else if(scenario==='contour'){
            await page.evaluate(()=>window.__FLOW_FIELD_PROOF__.pause())
            await page.evaluate(()=>window.__flightProof.gates[0].resolve())
            await idle(page)
            const final=await facts(page)
            results.push({scenario,held,final})
            const cleanup=await page.evaluate(()=>window.__FLOW_FIELD_PROOF__.dispose());assert.deepEqual(cleanup.cleanupFailures,[])
        }else{
            if(scenario==='dispose-during-construction'){
                await page.evaluate(()=>window.__FLOW_FIELD_PROOF__.pause())
                await page.locator('[data-flow-control="trail-quality"]').selectOption('balanced')
                await page.evaluate(()=>window.__flightProof.gates[0].resolve())
                await page.waitForFunction(()=>window.__FLOW_FIELD_PROOF__.facts().frames.rendering,undefined,{timeout:30000})
                assert.equal((await facts(page)).rendererInFlight,1)
            }
            if(scenario==='native-failure'){
                await page.evaluate(()=>window.__flightProof.gates[0].reject(new Error('Injected native completion failure')))
                await page.waitForFunction(()=>window.__FLOW_FIELD_PROOF__.facts().frames.state==='stopped',undefined,{timeout:30000})
            }
            await page.evaluate(()=>{
                window.__flightProof.disposal=window.__FLOW_FIELD_PROOF__.dispose().then(value=>{window.__flightProof.disposed=true;return value})
            })
            await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,60)))
            assert.equal(await page.evaluate(()=>window.__flightProof.disposed),false,'Disposal retains the pending native frame')
            await page.evaluate(()=>window.__flightProof.gates[1].resolve())
            if(scenario==='dispose'){
                await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,60)))
                assert.equal(await page.evaluate(()=>window.__flightProof.disposed),false)
                await page.evaluate(()=>window.__flightProof.gates[0].resolve())
            }
            const cleanup=await page.evaluate(()=>window.__flightProof.disposal)
            const final=await facts(page)
            assert.equal(final.rendererInFlight,0);assert.equal(final.activeFrames,0)
            assert.equal(final.ownedRuntimes,0)
            if(scenario!=='native-failure')assert.deepEqual(cleanup.cleanupFailures,[])
            if(scenario==='dispose-during-construction'){
                assert.equal(final.nativeSubmissions,held.nativeSubmissions,'Stopped construction cannot submit new native work')
                assert.deepEqual(final.history,held.history,'Stopped construction cannot resize history')
            }
            results.push({scenario,held,final,cleanupFailures:cleanup.cleanupFailures})
        }
        assert.deepEqual(errors,[])
        await page.close()
        console.log(JSON.stringify({scenario,status:'passed'}))
    }
    await writeFile(`${output}/report.json`,JSON.stringify({status:'passed',results},null,2))
}finally{await browser.close()}

async function idle(page){
    await page.waitForFunction(()=>{const f=window.__FLOW_FIELD_PROOF__.facts();return !f.timeline.playing&&!f.frames.rendering&&f.frames.inFlightFrameCount===0},undefined,{timeout:30000})
}
async function facts(page){
    return page.evaluate(()=>{const f=window.__FLOW_FIELD_PROOF__.facts();return {
        submitted:f.frames.submittedFrameCount,observed:f.frames.observedFrameCount,rendererInFlight:f.renderer.inFlightFrameCount,
        activeFrames:f.renderer.temporal.activeFrameCount,history:f.renderer.history.size,presented:f.presented,
        steps:f.renderer.particles.encodedSteps,resets:f.renderer.particles.resetCount,ownedRuntimes:f.temporalWindow.ownedRuntimeCount,
        spatialBuilds:f.renderer.viewDemand.buildCount,
        nativeSubmissions:window.__flightProof.nativeSubmissions,
    }})
}
