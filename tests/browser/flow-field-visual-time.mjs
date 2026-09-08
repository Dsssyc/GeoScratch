import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const base=process.env.FLOW_VISUAL_TIME_BASE ?? 'http://127.0.0.1:5173'
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-webgpu']})
const results=[]
try {
    for(const hz of [60,30]) {
        const page=await browser.newPage({viewport:{width:1000,height:700},deviceScaleFactor:1})
        const errors=[]
        page.on('pageerror',error=>errors.push(error.message))
        page.on('console',message=>{if(message.type()==='error')errors.push(message.text())})
        if(hz===30)await page.addInitScript(()=>{
            const request=window.requestAnimationFrame.bind(window),cancel=window.cancelAnimationFrame.bind(window)
            const pending=new Map();let sequence=0,bucket=-1,acceptedTime=-1
            window.requestAnimationFrame=callback=>{
                const token=++sequence
                const tick=time=>{
                    if(!pending.has(token))return
                    const next=Math.floor((time+.25)/(1000/30))
                    if(time===acceptedTime||next>bucket){bucket=next;acceptedTime=time;pending.delete(token);callback(time)}
                    else pending.set(token,request(tick))
                }
                pending.set(token,request(tick));return token
            }
            window.cancelAnimationFrame=token=>{const handle=pending.get(token);if(handle!==undefined){pending.delete(token);cancel(handle)}}
        })
        await page.goto(`${base}/flowField/?proof=1&rate=0.000000001&zoom=9`)
        await page.waitForFunction(()=>document.body.dataset.status==='error'||document.body.dataset.status==='ready'&&window.__FLOW_FIELD_PROOF__?.facts()?.lastFrame.presentationReady,
            undefined,{timeout:90000})
        assert.equal(await page.locator('body').getAttribute('data-status'),'ready',errors.join('\n'))
        const start=await page.evaluate(()=>{
            const p=window.__FLOW_FIELD_PROOF__,n=p.facts().renderer.particles.encodedSteps
            p.seek(.277);p.setPresentation({view:'particles',sample:'interpolated',trails:true,contour:false,
                boundary:'sdf-center-linear',sdfFeatherTexels:.25});return n
        })
        await page.waitForFunction(start=>{
            const f=window.__FLOW_FIELD_PROOF__.facts();return f.lastFrame.presentationReady&&f.workers.activeTaskCount===0&&f.renderer.particles.encodedSteps>start+90
        },start,{timeout:90000})
        const read=()=>page.evaluate(()=>{
            const f=window.__FLOW_FIELD_PROOF__.facts()
            return {wall:performance.now(),steps:f.renderer.particles.encodedSteps,reference:f.renderer.particles.simulatedReferenceSteps,
                frame:f.renderer.frameCount,playing:f.timeline.playing,visual:f.renderer.visualTime,decay:f.renderer.history.decaySteps}
        })
        const before=await read();await page.waitForTimeout(3000);const after=await read()
        const referencePerSecond=(after.reference-before.reference)*1000/(after.wall-before.wall)
        const updatesPerSecond=(after.steps-before.steps)*1000/(after.wall-before.wall)
        assert.ok(referencePerSecond>57&&referencePerSecond<63,'Accepted visual seconds do not depend on update frequency')
        if(hz===30)assert.ok(updatesPerSecond>26&&updatesPerSecond<34,'The lower-cadence witness really runs at about 30 Hz')
        await page.evaluate(()=>window.__FLOW_FIELD_PROOF__.pause())
        const settled=()=>page.waitForFunction(()=>{
            const f=window.__FLOW_FIELD_PROOF__.facts()
            return !f.timeline.playing&&f.lastFrame.presentationReady&&f.frames.observedFrameCount>=f.frames.submittedFrameCount&&
                f.lastFrame.visualTime?.referenceSteps===0&&f.lastFrame.temporal?.presentedModelTime===f.timeline.modelTime
        })
        await settled();const paused=await read()
        const shot=()=>page.screenshot({style:'#FlowFieldControls,.maplibregl-control-container{visibility:hidden!important}'})
        const original=await shot()
        for(const mode of ['sdf-center-smooth','sdf-center-linear','sdf-center-smooth','sdf-center-linear']) {
            await page.locator('[data-flow-control="boundary"]').selectOption(mode)
            await page.waitForFunction(mode=>window.__FLOW_FIELD_PROOF__.facts().renderer.history.boundary===mode,mode)
            await settled();const current=await read()
            assert.equal(current.steps,paused.steps)
            assert.equal(current.reference,paused.reference)
            assert.equal(current.visual.referenceSteps,0)
            assert.equal(current.decay,0)
        }
        assert.ok(original.equals(await shot()),'C-D-C paused display controls neither decay nor add ink')
        await page.waitForTimeout(350)
        await page.evaluate(()=>window.__FLOW_FIELD_PROOF__.play())
        await page.waitForFunction(frame=>window.__FLOW_FIELD_PROOF__.facts().renderer.frameCount>frame,paused.frame)
        // A longer pause must not appear as a burst of historical simulation debt.
        await page.waitForFunction(steps=>window.__FLOW_FIELD_PROOF__.facts().renderer.particles.encodedSteps>steps,paused.steps)
        const resumed=await read()
        assert.ok(resumed.reference-paused.reference<=6,'Resume admits only fresh bounded time, not paused catch-up')
        const cleanup=await page.evaluate(()=>window.__FLOW_FIELD_PROOF__.dispose())
        assert.deepEqual(cleanup.cleanupFailures,[]);assert.equal(cleanup.pendingObservationsAfter,0);assert.deepEqual(errors,[])
        results.push({hz,updatesPerSecond,referencePerSecond,pausedZeroTime:true,pausedImageExact:true,resumeReferenceSteps:resumed.reference-paused.reference,errors})
        await page.close()
    }
    console.log(JSON.stringify({status:'passed',results}))
} finally {await browser.close()}
