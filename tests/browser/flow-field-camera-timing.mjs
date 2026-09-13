import assert from 'node:assert/strict'
import {mkdir,writeFile} from 'node:fs/promises'
import {chromium} from 'playwright'
import {launchSecondaryBrowser} from '../experiments/terrain-cover-placement/secondary-browser.mjs'
const output=process.env.FLOW_CAMERA_TIMING_OUTPUT??'/tmp/geoscratch-flow-camera-timing'
await mkdir(output,{recursive:true})
const native=process.env.FLOW_CAMERA_TIMING_NATIVE==='1'
const dpr=Number(process.env.FLOW_CAMERA_TIMING_DPR??2)
assert.ok([1,2].includes(dpr))
const viewport={width:1760,height:880}
const managed=native?await launchSecondaryBrowser({deviceScaleFactor:dpr,viewport}):undefined
const browser=managed?.browser??await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-webgpu']})
const context=await browser.newContext({viewport,deviceScaleFactor:dpr})
const page=await context.newPage()
let initialized=false,verified=false
const results=[]
const delays=process.env.FLOW_CAMERA_TIMING_DELAY===undefined?[0,40]:[Number(process.env.FLOW_CAMERA_TIMING_DELAY)]
assert.ok(delays.every(value=>value===0||value===40))
try{
    for(const quality of ['native','balanced'])for(const delay of delays){
        const errors=[]
        page.removeAllListeners('pageerror')
        page.on('pageerror',e=>errors.push(e.message))
        if(!initialized){
            await page.addInitScript(()=>{
                const delay=Number(new URL(location.href).searchParams.get('probeDelay')??0)
                const records=[],hosts=[],starts=new Map()
                const p=window.__cameraLag={enabled:false,records,hosts,starts,map:undefined,lastQueued:undefined,
                    start(frame,capture,kind){starts.set(frame,{time:performance.now(),capture,kind})},
                    queued(frame,capture,work){
                        if(!this.enabled)return
                        const now=performance.now(),start=starts.get(frame)
                        const actual=this.map.project(capture.view.center)
                        const wanted=[innerWidth/2,innerHeight/2]
                        const record={frame,kind:start?.kind,queued:now,age:start?now-start.time:null,center:capture.view.center,
                            queuedSkew:Math.hypot(actual.x-wanted[0],actual.y-wanted[1])}
                        this.lastQueued=record;records.push(record)
                        work.nativeOutcome.then(()=>{record.observed=performance.now()},()=>{})
                    }}
                let api
                Object.defineProperty(window,'maplibregl',{configurable:true,get:()=>api,set(value){
                    api=value;const Native=value.Map
                    value.Map=class extends Native{constructor(options){super(options);p.map=this
                        this.on('render',()=>{if(!p.enabled)return
                            const q=p.lastQueued,pos=q&&this.project(q.center)
                            hosts.push({time:performance.now(),queued:q?.frame,
                                skew:pos?Math.hypot(pos.x-innerWidth/2,pos.y-innerHeight/2):undefined})
                        })}}
                }})
                const done=GPUQueue.prototype.onSubmittedWorkDone
                GPUQueue.prototype.onSubmittedWorkDone=function(){
                    const work=done.call(this)
                    return p.enabled&&delay>0?Promise.all([work,new Promise(resolve=>setTimeout(resolve,delay))]).then(()=>undefined):work
                }
            })
            await page.route('**/flowField/flow-renderer.ts*',async route=>{
                const response=await route.fetch();let body=await response.text()
                const signature='async function render(frameNumber, capture, timeline, wallTime) {'
                assert.ok(body.includes(signature))
                body=body.replace(signature,signature+'\nwindow.__cameraLag.start(frameNumber,capture,"content");')
                const cameraSignature=['function tryPresentCamera(frameNumber, capture) {','let tryPresentCamera = function(frameNumber, capture) {'].find(value=>body.includes(value))
                if(body.includes('tryPresentCamera'))assert.ok(cameraSignature)
                if(cameraSignature)body=body.replace(cameraSignature,cameraSignature+'\nwindow.__cameraLag.start(frameNumber,capture,"camera");')
                const submit='const submitted = builder.submit();'
                assert.ok(body.includes(submit))
                body=body.replaceAll(submit,submit+'\nif(typeof capture!=="undefined"&&typeof frameNumber!=="undefined")window.__cameraLag.queued(frameNumber,capture,submitted);')
                await route.fulfill({response,body})
            })
            initialized=true
        }
        await page.goto(`http://127.0.0.1:5173/flowField/?proof=1&rate=0.000000001&zoom=9&trailQuality=${quality}&probeDelay=${delay}`)
        await page.waitForFunction(()=>{
            const f=window.__FLOW_FIELD_PROOF__?.facts()
            return f?.lastFrame.presentationReady&&f.workers.activeTaskCount===0&&f.renderer.particles.encodedSteps>90
        },undefined,{timeout:90000})
        await page.mouse.move(400,400);await page.mouse.down()
        await page.evaluate(()=>window.__cameraLag.enabled=true)
        for(let i=1;i<=120;i++){
            await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(resolve)))
            await page.mouse.move(400+i*3,400+30*Math.sin(i/120*Math.PI))
        }
        await page.mouse.up()
        const r=await page.evaluate(()=>{
            const p=window.__cameraLag;p.enabled=false
            return {records:p.records,hosts:p.hosts,frames:window.__FLOW_FIELD_PROOF__.facts().frames}
        })
        const percentile=(array,p)=>array.sort((a,b)=>a-b)[Math.floor((array.length-1)*p)]
        const summary={quality,delay,frames:r.records.length,hosts:r.hosts.length,
            contentFrames:r.records.filter(value=>value.kind==='content').length,
            cameraFrames:r.records.filter(value=>value.kind==='camera').length,
            presentationsPerSecond:r.records.length*1000/(r.hosts.at(-1).time-r.hosts[0].time),
            captureAgeP50:percentile(r.records.map(v=>v.age),.5),captureAgeP95:percentile(r.records.map(v=>v.age),.95),
            queuedSkewP95:percentile(r.records.map(v=>v.queuedSkew),.95),
            hostSkewP95:percentile(r.hosts.map(v=>v.skew).filter(Number.isFinite),.95),errors}
        assert.ok(r.records.every(value=>value.age!==null),'Every queued frame must have its actual capture timestamp')
        results.push({summary,...r});console.log(JSON.stringify(summary))
        const cleanup=await page.evaluate(()=>window.__FLOW_FIELD_PROOF__.dispose())
        assert.deepEqual(cleanup.cleanupFailures,[]);assert.deepEqual(errors,[])
        await page.goto('about:blank')
    }
    await managed?.verifyPlacement()
    verified=true
}finally{
    await browser.close()
    await writeFile(`${output}/report.json`,JSON.stringify({status:verified?'observed':'failed',native,dpr,display:managed?.evidence,results},null,2))
}
