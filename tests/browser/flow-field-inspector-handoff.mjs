import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createHash } from 'node:crypto'

const base = process.env.FLOW_HANDOFF_BASE ?? 'http://127.0.0.1:5173'
const browser = await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-webgpu']})
let releaseSafety, releaseDetail
try {
    const page = await browser.newPage({viewport:{width:960,height:720}})
    const errors = []
    page.on('pageerror',error=>errors.push(error.message))
    page.on('console',message=>{if(message.type()==='error') errors.push(message.text())})
    await page.goto(`${base}/flowField/index.html?proof=1&view=status&rate=0.001&zoom=10`)
    await page.waitForFunction(()=>{
        const f=window.__FLOW_FIELD_PROOF__?.facts()
        return f?.lastFrame?.presentationReady===true && f.workers.activeTaskCount===0
    },undefined,{timeout:60000})
    await page.locator('[data-flow-control="play-pause"]').click()
    async function imageFacts() {
        const png=await page.screenshot({clip:{x:260,y:120,width:400,height:300},
            style:'#FlowFieldControls {visibility:hidden!important}'})
        const visible=await page.evaluate(async b64=>{
            const image=new Image();image.src='data:image/png;base64,'+b64;await image.decode()
            const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height
            const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0)
            const bytes=ctx.getImageData(0,0,image.width,image.height).data
            let lit=0,green=0
            for(let i=0;i<bytes.length;i+=4){
                if(Math.max(bytes[i],bytes[i+1],bytes[i+2])>35) lit++
                if(bytes[i+1]>80&&bytes[i+1]>bytes[i]*1.5)green++
            }
            const f=window.__FLOW_FIELD_PROOF__.facts()
            return {lit,green,state:document.body.dataset.status,window:f.temporalWindow.state,
                pair:f.temporalWindow.pairGeneration,
                ready:f.lastFrame.presentationReady??false,owned:f.temporalWindow.ownedRuntimeCount,
                presented:document.querySelector('[data-flow-control="presented"]').textContent}
        },png.toString('base64'))
        return {...visible,hash:createHash('sha256').update(png).digest('hex')}
    }
    const baseline=await imageFacts()
    assert.ok(baseline.green>1000)
    const safetyGate=new Promise(resolve=>{releaseSafety=resolve})
    const detailGate=new Promise(resolve=>{releaseDetail=resolve})
    await page.route(/\/tiles\/WebMercatorQuad\/t1[01]\//,async route=>{
        await (route.request().url().includes('/4/')?safetyGate:detailGate)
        await route.continue().catch(()=>undefined)
    })
    await page.locator('[data-flow-control="time"]').fill('10.5')
    await page.locator('[data-flow-control="time"]').dispatchEvent('change')
    await page.waitForFunction(()=>window.__FLOW_FIELD_PROOF__.facts().lastFrame.state==='loading')
    const waiting=await imageFacts()
    assert.equal(waiting.hash,baseline.hash,'Window loading must retain the diagnostic image')
    assert.equal(waiting.presented,baseline.presented)
    releaseSafety()
    await page.waitForFunction(()=>{
        const f=window.__FLOW_FIELD_PROOF__.facts()
        return f.temporalWindow.state==='ready' && f.lastFrame.state==='rendered' &&
            f.lastFrame.temporal.lowerSampleKey==='t10'
    },undefined,{timeout:30000})
    const coarse=await imageFacts()
    assert.equal(coarse.state,'loading')
    assert.equal(coarse.ready,false)
    assert.equal(coarse.hash,baseline.hash,'Safety-only pages must not replace the complete image')
    assert.equal(coarse.presented,baseline.presented)
    assert.ok(coarse.owned<=4)
    const observedBeforeMode=await page.evaluate(()=>window.__FLOW_FIELD_PROOF__.facts().frames.observedFrameCount)
    await page.locator('[data-flow-control="view"]').selectOption('speed')
    await page.waitForFunction(count=>window.__FLOW_FIELD_PROOF__.facts().frames.observedFrameCount>count,
        observedBeforeMode)
    const modeChange=await imageFacts()
    assert.equal(modeChange.state,'loading')
    assert.equal(modeChange.lit,0,'An explicit mode change must not mislabel the retained status image as Speed')
    await page.locator('[data-flow-control="view"]').selectOption('status')
    releaseDetail()
    await page.waitForFunction(()=>{
        const f=window.__FLOW_FIELD_PROOF__.facts()
        return f.lastFrame.presentationReady===true && f.workers.activeTaskCount===0
    },undefined,{timeout:30000})
    const complete=await imageFacts()
    assert.equal(complete.state,'ready')
    assert.ok(complete.green>1000)
    assert.ok(complete.presented.includes('10.5'))

    // Exercise two ordinary adjacent transitions, without a synthetic network delay.
    await page.unroute(/\/tiles\/WebMercatorQuad\/t1[01]\//)
    await page.locator('[data-flow-control="rate"]').selectOption('0.2')
    await page.locator('[data-flow-control="play-pause"]').click()
    const natural=[]
    const readyPairs=new Set()
    for(let i=0;i<80;i++){
        const image=await imageFacts()
        if(image.state==='ready') readyPairs.add(image.pair)
        natural.push({state:image.state,pair:image.pair,lit:image.lit,green:image.green})
        assert.ok(image.lit>100000,'An ordinary transition exposed the bare background')
        assert.ok(image.green>1000,'An ordinary transition replaced moving data with coarse zero')
        await page.waitForTimeout(100)
    }
    assert.ok(readyPairs.size>=3,'Default playback must complete at least two adjacent handoffs')
    await page.locator('[data-flow-control="play-pause"]').click()
    const cleanup=await page.evaluate(()=>window.__FLOW_FIELD_PROOF__.dispose())
    assert.equal(cleanup.cleanupFailures.length,0)
    assert.deepEqual(errors,[])
    console.log(JSON.stringify({status:'passed',baseline,waiting,coarse,modeChange,complete,
        naturalSamples:natural.length,readyPairs:[...readyPairs],
        minimumLitPixels:Math.min(...natural.map(frame=>frame.lit)),
        minimumMovingPixels:Math.min(...natural.map(frame=>frame.green)),errors}))
} finally {
    releaseSafety?.();releaseDetail?.()
    await browser.close()
}
