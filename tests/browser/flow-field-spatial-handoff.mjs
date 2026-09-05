import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'

const base = process.env.FLOW_SPATIAL_BASE ?? 'http://127.0.0.1:5173'
const output = process.env.FLOW_SPATIAL_OUTPUT ?? '/tmp/flow-field-spatial-handoff'
await mkdir(output, {recursive:true})
const browser = await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-webgpu']})
let release
try {
    const page = await browser.newPage({viewport:{width:1440,height:900}})
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    await page.goto(`${base}/flowField/index.html?proof=1&rate=0.001&zoom=11`)
    await page.waitForFunction(() => document.body.dataset.status === 'error' ||
        (window.__FLOW_FIELD_PROOF__?.facts()?.renderer.particles.encodedSteps ?? 0) > 100,
    undefined, {timeout:90000})
    async function facts() {
        return await page.evaluate(() => {
            const f = window.__FLOW_FIELD_PROOF__.facts(), frame = f.lastFrame
            return {
                state:document.body.dataset.status, ready:frame.presentationReady,
                frames:f.frames.observedFrameCount, steps:f.renderer.particles.encodedSteps,
                resets:f.renderer.particles.resetCount, refills:f.renderer.particles.viewRefillCount,
                pair:f.temporalWindow.pairGeneration, workers:f.workers.activeTaskCount,
                level:frame.demand?.requestedLevel, history:frame.history,
                pitch:frame.view?.cameraPitchRadians,
                presented:document.querySelector('[data-flow-control="presented"]').textContent,
            }
        })
    }
    async function image(label) {
        const png = await page.screenshot({path:`${output}/${label}.png`,
            style:'#FlowFieldControls,.maplibregl-control-container{visibility:hidden!important}'})
        const colored = await page.evaluate(async b64 => {
            const image = new Image(); image.src = 'data:image/png;base64,'+b64; await image.decode()
            const canvas = document.createElement('canvas'); canvas.width=image.width; canvas.height=image.height
            const ctx = canvas.getContext('2d'); ctx.drawImage(image,0,0)
            const bytes = ctx.getImageData(0,0,canvas.width,canvas.height).data
            let colored=0
            for(let i=0;i<bytes.length;i+=4) {
                if(Math.max(bytes[i],bytes[i+1],bytes[i+2])-Math.min(bytes[i],bytes[i+1],bytes[i+2])>25)colored++
            }
            return colored
        }, png.toString('base64'))
        return {colored,hash:createHash('sha256').update(png).digest('hex')}
    }
    const baseline = await facts()
    assert.equal(baseline.state,'ready')
    let blockedRequests = 0
    const tileGate = new Promise(resolve => { release = resolve })
    await page.route(/\/tiles\/WebMercatorQuad\//, async route => {
        blockedRequests++
        await tileGate
        await route.continue().catch(() => undefined)
    })
    await page.mouse.move(550,500)
    await page.mouse.down({button:'right'})
    await page.mouse.move(550,385,{steps:16})
    await page.mouse.up({button:'right'})
    await page.waitForFunction(() => {
        const f=window.__FLOW_FIELD_PROOF__.facts()
        return f.lastFrame.view?.cameraPitchRadians>1.1 &&
            f.workers.activeTaskCount>0 && !f.lastFrame.history?.cameraChanged
    },undefined,{timeout:30000})
    const held = await facts(), firstImage = await image('held')
    assert.ok(blockedRequests>0,'Pitch must request uncached view pages')
    assert.equal(held.pair,baseline.pair,'Reproduce inside the same temporal pair')
    assert.notEqual(held.level,baseline.level,'Pitch must change the requested LoD')
    assert.equal(held.state,'loading','An admitted time pair must not bypass spatial readiness')
    assert.equal(held.ready,false)
    assert.equal(held.history.cleared,false)
    assert.equal(held.resets,baseline.resets)
    assert.equal(held.refills,baseline.refills)
    assert.ok(firstImage.colored>20000,'Previously visible flow must not be erased')
    await page.waitForTimeout(350)
    const waiting = await facts(), secondImage = await image('still-held')
    assert.equal(waiting.steps,held.steps,'Unready view data must not evolve or retire particles')
    assert.equal(waiting.presented,held.presented)
    assert.equal(secondImage.hash,firstImage.hash,'Retained ink must not decay while the camera is still')

    await page.mouse.move(700,600)
    await page.mouse.down()
    await page.mouse.move(725,600,{steps:8})
    await page.mouse.up()
    await page.waitForTimeout(200)
    const panned = await facts(), pannedImage = await image('held-pan')
    assert.equal(panned.state,'loading')
    assert.equal(panned.steps,held.steps)
    assert.equal(panned.resets,baseline.resets)
    assert.ok(pannedImage.colored>10000)
    assert.notEqual(pannedImage.hash,firstImage.hash,'Retained history must follow the camera')

    // Residency completion must wake even a paused application without another input.
    await page.locator('[data-flow-control="play-pause"]').click()
    release()
    await page.waitForFunction(() => document.body.dataset.status === 'ready' &&
        window.__FLOW_FIELD_PROOF__.facts().workers.activeTaskCount===0,undefined,{timeout:60000})
    const recovered = await facts(), finalImage = await image('recovered')
    assert.equal(recovered.ready,true)
    assert.equal(recovered.pair,baseline.pair)
    assert.ok(recovered.steps>held.steps)
    assert.equal(recovered.resets,baseline.resets)
    assert.ok(recovered.refills>held.refills)
    assert.ok(finalImage.colored>20000)
    const cleanup = await page.evaluate(() => window.__FLOW_FIELD_PROOF__.dispose())
    assert.equal(cleanup.cleanupFailures.length,0)
    assert.deepEqual(errors,[])
    console.log(JSON.stringify({status:'passed',blockedRequests,baseline,held,waiting,panned,recovered,
        firstImage,secondImage,pannedImage,finalImage,errors}))
} finally {
    release?.()
    await browser.close()
}
