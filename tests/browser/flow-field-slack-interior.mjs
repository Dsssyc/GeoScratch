import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const base=process.env.FLOW_SLACK_BASE ?? 'http://127.0.0.1:5173'
const output=process.env.FLOW_SLACK_OUTPUT ?? '/tmp/flow-field-slack-interior'
await mkdir(output,{recursive:true})
const support=await readFile(new URL('../../examples/flowField/shaders/history-support.wgsl',import.meta.url),'utf8')
// Diagnostic only in this isolated page. Hard mode does not normally use the
// feather uniform: .05 restores the old strict gate, .35 exposes raw ink, .25
// executes the unmodified production rule. Particle thresholds never change.
const marker='    return FlowPresentation_coverage('
assert.ok(support.includes(marker))
const instrumented=support.replace(marker,`
    if (cleanupUniform.presentationFeather < 0.1) {
        let flow = FlowVelocity_sample(ground.position, cleanupUniform.requestedLevel,
            FlowVelocityTemporal(cleanupUniform.progress, cleanupUniform.activityKill));
        if (flow.status == 4u) { return 0.0; }
        if (flow.status != 1u) { return select(0.0, 1.0, FlowVelocity_source_contains(ground.position)); }
        return select(0.0, 1.0, flow.advectable && flow.speed > 0.0);
    }
    if (cleanupUniform.presentationFeather > 0.3) { return 1.0; }
${marker}`)
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-webgpu']})
try {
    for(const target of [22.62915,22.68668]) {
        const page=await browser.newPage({viewport:{width:768,height:600},deviceScaleFactor:2})
        const errors=[]
        page.on('pageerror',e=>errors.push(e.message))
        page.on('console',m=>{if(m.type()==='error')errors.push(m.text())})
        await page.route('**/flowField/map.ts*',async route=>{
            const response=await route.fetch(),body=await response.text()
            assert.ok(body.includes('center: FLOW_FIELD_MAP_DEFAULTS.center'))
            await route.fulfill({response,body:body.replace('center: FLOW_FIELD_MAP_DEFAULTS.center',
                'center: [121.2234,31.7079]')})
        })
        await page.route('**/flowField/shaders/history-support.wgsl*',route=>route.fulfill({
            contentType:'text/javascript',body:`export default ${JSON.stringify(instrumented)}`,
        }))
        await page.goto(`${base}/flowField/?proof=1&rate=0.000000001&zoom=14`)
        await page.waitForFunction(()=>document.body.dataset.status==='ready' &&
            window.__FLOW_FIELD_PROOF__?.facts()?.lastFrame.presentationReady,undefined,{timeout:90000})
        const start=await page.evaluate(()=>{
            const p=window.__FLOW_FIELD_PROOF__,steps=p.facts().renderer.particles.encodedSteps
            p.seek(22.5);return steps
        })
        await page.waitForFunction(start=>{
            const f=window.__FLOW_FIELD_PROOF__.facts()
            return f.lastFrame.presentationReady && f.lastFrame.temporal.lowerSampleKey==='t22' &&
                f.workers.activeTaskCount===0 && f.renderer.particles.encodedSteps>=start+240
        },start,{timeout:90000})
        await page.evaluate(()=>window.__FLOW_FIELD_PROOF__.setRate(.2))
        await page.waitForFunction(target=>{
            const p=window.__FLOW_FIELD_PROOF__
            if(p.facts().lastFrame.temporal.presentedModelTime<target)return false
            p.pause();return true
        },target,{timeout:15000})
        await settled()
        const shots=[]
        for(const [name,boundary,feather] of [
            ['strict-before','hard',.05],['a-supported','hard',.25],['raw','hard',.35],
            ['strict-after','hard',.05],['b-supported','sdf',.25],
        ]) {
            const observed=await page.evaluate(()=>window.__FLOW_FIELD_PROOF__.facts().frames.observedFrameCount)
            await page.evaluate(({boundary,feather})=>window.__FLOW_FIELD_PROOF__.setPresentation({
                view:'particles',sample:'interpolated',trails:true,contour:false,boundary,sdfFeatherTexels:feather,
            }),{boundary,feather})
            await page.waitForFunction(({boundary,feather,observed})=>{
                const f=window.__FLOW_FIELD_PROOF__.facts()
                return f.renderer.history.boundary===boundary && f.renderer.history.sdfFeatherTexels===feather &&
                    f.frames.observedFrameCount>observed
            },{boundary,feather,observed},{timeout:30000})
            await settled()
            const facts=await page.evaluate(()=>{
                const f=window.__FLOW_FIELD_PROOF__.facts()
                return {time:f.lastFrame.temporal.presentedModelTime,ready:f.lastFrame.presentationReady,
                    pages:f.lastFrame.demand.candidatePages.map(p=>p.tile),workers:f.workers.activeTaskCount,
                    steps:f.renderer.particles.encodedSteps,resets:f.renderer.particles.resetCount,
                    camera:JSON.stringify([f.lastFrame.view.clipFromRelativeWorld,f.lastFrame.view.cameraHigh,
                        f.lastFrame.view.cameraLow,f.lastFrame.view.referenceViewport]),history:f.renderer.history}
            })
            const path=`${output}/${target}-${name}.png`
            const png=await page.screenshot({path,style:'#FlowFieldControls,.maplibregl-control-container{visibility:hidden!important}'})
            shots.push({name,path,facts,png:png.toString('base64')})
        }
        const first=shots[0].facts
        for(const {facts} of shots) {
            assert.equal(facts.time,first.time)
            assert.ok(facts.time>=target && facts.time<target+.03)
            assert.equal(facts.resets,first.resets,'Display controls must not reset particle state')
            assert.equal(facts.camera,first.camera)
            assert.ok(facts.ready && facts.workers===0)
            assert.ok(facts.pages.length>0 && facts.pages.every(p=>p.matrixId==='10'))
        }
        const counts=await page.evaluate(async ({shots,target})=>{
            const pixels=[];let width
            for(const shot of shots) {
                const img=new Image();img.src=`data:image/png;base64,${shot.png}`;await img.decode()
                const c=document.createElement('canvas');c.width=img.width;c.height=img.height;width=img.width
                const ctx=c.getContext('2d');ctx.drawImage(img,0,0)
                pixels.push(ctx.getImageData(0,0,c.width,c.height).data)
            }
            const [old,a,raw,back,b]=pixels,roi=target<22.65?[630,460,180,260]:[745,460,180,260]
            const dark=(v,i)=>v[i]===16 && v[i+1]===20 && v[i+2]===24
            let stableHole=0,aRestored=0,bRestored=0
            for(let y=roi[1];y<roi[1]+roi[3];y++)for(let x=roi[0];x<roi[0]+roi[2];x++) {
                const i=(y*width+x)*4
                if(raw[i+2]<80 || !dark(old,i) || !dark(back,i))continue
                stableHole++
                if(a[i+2]>60)aRestored++
                if(b[i+2]>60)bRestored++
            }
            return {roi,stableHole,aRestored,bRestored}
        },{shots,target})
        const cleanup=await page.evaluate(()=>window.__FLOW_FIELD_PROOF__.dispose())
        assert.deepEqual(cleanup.cleanupFailures,[])
        assert.deepEqual(errors,[])
        console.log(JSON.stringify({target,counts,shots:shots.map(({name,path,facts})=>({name,path,
            time:facts.time,steps:facts.steps,resets:facts.resets,boundary:facts.history.boundary,
            feather:facts.history.sdfFeatherTexels,ready:facts.ready,workers:facts.workers,
            pageCount:facts.pages.length,sourceMatrixIds:[...new Set(facts.pages.map(p=>p.matrixId))]})),errors}))
        assert.ok(counts.stableHole>32,'Reproduce a populated-but-clipped hole with the old rule')
        assert.ok(counts.aRestored/counts.stableHole>.95,'A must preserve finite existing interior ink')
        assert.ok(counts.bRestored/counts.stableHole>.95,'B must use the same stationary support authority')
        await page.close()

        async function settled() {
            await page.waitForFunction(()=>{
                const f=window.__FLOW_FIELD_PROOF__.facts()
                return !f.timeline.playing && f.lastFrame.presentationReady &&
                    Math.abs(f.lastFrame.temporal.presentedModelTime-f.timeline.modelTime)<1e-8 &&
                    f.frames.observedFrameCount>=f.frames.submittedFrameCount
            },undefined,{timeout:30000})
        }
    }
} finally {await browser.close()}
