import assert from 'node:assert/strict'
import {mkdir,writeFile} from 'node:fs/promises'
import {chromium} from 'playwright'

const output=process.env.FLOW_CAMERA_LATENCY_OUTPUT??'/tmp/geoscratch-flow-camera-latency'
const disabled=process.env.FLOW_CAMERA_LATENCY_DISABLE_FAST==='1'
await mkdir(output,{recursive:true})
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-webgpu']})
const results=[]
try{
    for(const quality of ['native','balanced'])for(const contour of [false,true]){
        const name=`${quality}${contour?'-contour':''}`
        const page=await browser.newPage({viewport:{width:960,height:640},deviceScaleFactor:2}),errors=[]
        page.on('pageerror',e=>errors.push(e.message))
        await page.addInitScript(()=>{
            const state=window.__cameraGate={map:undefined,armed:false,resolve:undefined,nativeComplete:false,submissions:0}
            let api
            Object.defineProperty(window,'maplibregl',{configurable:true,get:()=>api,set(value){
                api=value;const Native=value.Map
                value.Map=class extends Native{constructor(options){super(options);state.map=this}}
            }})
            const done=GPUQueue.prototype.onSubmittedWorkDone,submit=GPUQueue.prototype.submit
            GPUQueue.prototype.submit=function(buffers){state.submissions++;return submit.call(this,buffers)}
            GPUQueue.prototype.onSubmittedWorkDone=function(){
                const native=done.call(this)
                if(!state.armed)return native
                state.armed=false
                const hold=new Promise(resolve=>{state.resolve=resolve})
                return Promise.all([native.then(()=>{state.nativeComplete=true}),hold]).then(()=>undefined)
            }
        })
        if(disabled)await page.route('**/flowField/application.ts*',async route=>{
            const response=await route.fetch(),body=await response.text()
            const call='renderer.tryPresentCamera(frameNumber, captured)'
            assert.ok(body.includes(call))
            await route.fulfill({response,body:body.replace(call,'undefined')})
        })
        try{
            await page.goto(`http://127.0.0.1:5173/flowField/?proof=1&rate=0.000000001&zoom=9&trailQuality=${quality}`)
            await page.waitForFunction(()=>{const f=window.__FLOW_FIELD_PROOF__?.facts();return f?.lastFrame.presentationReady&&f.workers.activeTaskCount===0&&f.renderer.particles.encodedSteps>90},undefined,{timeout:90000})
            if(contour){
                await page.locator('[data-flow-control="contour"]').check()
                await page.waitForFunction(()=>window.__FLOW_FIELD_PROOF__.facts().renderer.contour.candidateCount>0)
            }
            await page.evaluate(()=>window.__FLOW_FIELD_PROOF__.pause())
            await idle(page)
            await page.evaluate(()=>{
                const g=window.__cameraGate;g.armed=true
                g.map.jumpTo({center:g.map.unproject([innerWidth/2-8,innerHeight/2])})
            })
            await page.waitForFunction(()=>window.__cameraGate.nativeComplete&&window.__FLOW_FIELD_PROOF__.facts().renderer.inFlightFrameCount>=1)
            const held=await facts(page)
            const screenshot=()=>page.screenshot({style:'#FlowFieldControls,.maplibregl-control-container{visibility:hidden!important}'})
            const before=await screenshot()
            await page.evaluate(()=>{
                const map=window.__cameraGate.map
                map.jumpTo({center:map.unproject([innerWidth/2-80,innerHeight/2])})
            })
            await page.waitForFunction(previous=>{
                const f=window.__FLOW_FIELD_PROOF__.facts()
                return f.renderer.cameraPresentationCount>previous&&f.lastFrame.state==='presented'
            },held.cameraFrames,{timeout:5000})
            const shifted=await facts(page),after=await screenshot()
            assert.equal(shifted.contentFrames,held.contentFrames,'Pending spatial observation cannot be overwritten')
            assert.equal(shifted.spatialBuilds,held.spatialBuilds)
            assert.equal(shifted.steps,held.steps,'Camera-only frames cannot simulate paused particles')
            assert.equal(shifted.resets,held.resets)
            assert.equal(shifted.historyGeneration,held.historyGeneration)
            assert.ok(shifted.inFlight<=2)
            assert.equal(shifted.activeFrames,1,'Only the held content frame retains a temporal lease')
            const pixels=await page.evaluate(async images=>{
                const decoded=await Promise.all(images.map(async bytes=>{
                    const image=new Image();image.src='data:image/png;base64,'+bytes;await image.decode()
                    const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height
                    const context=canvas.getContext('2d');context.drawImage(image,0,0)
                    return {width:image.width,height:image.height,data:context.getImageData(0,0,image.width,image.height).data}
                }))
                const [a,b]=decoded;let shifted=0,unchanged=0,channels=0,lit=0
                const dx=160
                for(let y=20;y<a.height-20;y++)for(let x=dx+20;x<a.width-20;x++){
                    const i=(y*a.width+x)*4,j=(y*a.width+x-dx)*4
                    if(Math.max(a.data[j],a.data[j+1],a.data[j+2])>45)lit++
                    for(let c=0;c<3;c++){shifted+=Math.abs(b.data[i+c]-a.data[j+c]);unchanged+=Math.abs(b.data[i+c]-a.data[i+c]);channels++}
                }
                return {shiftedMeanError:shifted/channels,unshiftedMeanError:unchanged/channels,litPixels:lit}
            },[before.toString('base64'),after.toString('base64')])
            assert.ok(pixels.litPixels>1000)
            assert.ok(pixels.shiftedMeanError<2&&pixels.shiftedMeanError<pixels.unshiftedMeanError*.1,
                `Visible flow must translate with the map while completion is held: ${JSON.stringify(pixels)}`)
            await writeFile(`${output}/${name}-before.png`,before)
            await writeFile(`${output}/${name}-after.png`,after)
            await page.evaluate(()=>window.__cameraGate.resolve())
            await idle(page)
            const final=await facts(page)
            assert.ok(final.contentFrames>held.contentFrames,'Paused camera movement must converge to new spatial content')
            assert.ok(final.spatialBuilds>held.spatialBuilds)
            assert.equal(final.steps,held.steps)
            const cleanup=await page.evaluate(()=>window.__FLOW_FIELD_PROOF__.dispose())
            assert.deepEqual(cleanup.cleanupFailures,[]);assert.deepEqual(errors,[])
            results.push({quality,contour,held,shifted,final,pixels})
            console.log(JSON.stringify({quality,contour,status:'passed',pixels}))
        }finally{
            await page.evaluate(()=>window.__cameraGate.resolve?.()).catch(()=>{})
            await page.close()
        }
    }
    await writeFile(`${output}/report.json`,JSON.stringify({status:'passed',results},null,2))
}finally{await browser.close()}

async function idle(page){
    await page.waitForFunction(()=>{const f=window.__FLOW_FIELD_PROOF__.facts();return !f.timeline.playing&&!f.frames.rendering&&f.frames.inFlightFrameCount===0&&f.lastFrame.state==='rendered'&&f.lastFrame.presentationReady},undefined,{timeout:30000})
}
async function facts(page){return page.evaluate(()=>{
    const f=window.__FLOW_FIELD_PROOF__.facts()
    return {contentFrames:f.renderer.contentFrameCount,cameraFrames:f.renderer.cameraPresentationCount,
        spatialBuilds:f.renderer.viewDemand.buildCount,steps:f.renderer.particles.encodedSteps,
        resets:f.renderer.particles.resetCount,historyGeneration:f.renderer.history.resizeGeneration,
        inFlight:f.renderer.inFlightFrameCount,activeFrames:f.renderer.temporal.activeFrameCount}
})}
