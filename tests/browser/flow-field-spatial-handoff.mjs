import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'

const base = process.env.FLOW_SPATIAL_BASE ?? 'http://127.0.0.1:5173'
const output = process.env.FLOW_SPATIAL_OUTPUT ?? '/tmp/flow-field-spatial-handoff'
await mkdir(output, {recursive:true})
const browser = await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-webgpu']})
let release
let releaseSeek
try {
    const page = await browser.newPage({viewport:{width:1440,height:900}})
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    await page.goto(`${base}/flowField/index.html?proof=1&rate=0.001&zoom=11`)
    await page.waitForFunction(() => document.body.dataset.status === 'error' ||
        (window.__FLOW_FIELD_PROOF__?.facts()?.lastFrame.presentationReady &&
            window.__FLOW_FIELD_PROOF__.facts().renderer.particles.encodedSteps > 100),
    undefined, {timeout:90000})
    async function facts() {
        return await page.evaluate(() => {
            const f = window.__FLOW_FIELD_PROOF__.facts(), frame = f.lastFrame
            return {
                state:document.body.dataset.status, ready:frame.presentationReady,
                particlesAdvancing:frame.particlesAdvancing,
                frames:f.frames.observedFrameCount, steps:f.renderer.particles.encodedSteps,
                resets:f.renderer.particles.resetCount, refills:f.renderer.particles.viewRefillCount,
                pair:f.temporalWindow.pairGeneration, workers:f.workers.activeTaskCount,
                level:frame.demand?.requestedLevel, history:frame.history,
                pitch:frame.view?.cameraPitchRadians,
                windowState:f.temporalWindow.state,
                lower:frame.temporal?.lowerSampleKey, upper:frame.temporal?.upperSampleKey,
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
    const allTiles = /\/tiles\/WebMercatorQuad\//
    await page.route(allTiles, async route => {
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
    assert.equal(held.particlesAdvancing,true,'Incomplete camera coverage must not stop all local simulation')
    assert.equal(held.history.cleared,false)
    assert.equal(held.resets,baseline.resets)
    assert.equal(held.refills,baseline.refills)
    assert.ok(firstImage.colored>20000,'Previously visible flow must not be erased')
    await page.waitForTimeout(350)
    const waiting = await facts(), secondImage = await image('still-held')
    assert.equal(waiting.ready,false)
    assert.equal(waiting.particlesAdvancing,true)
    assert.ok(waiting.steps>held.steps,'Reliable positions must keep advancing while other pages are blocked')
    assert.equal(waiting.resets,baseline.resets)
    assert.equal(waiting.refills,baseline.refills,'An incomplete view must not consume the reveal baseline')
    assert.equal(waiting.history.cleared,false)
    assert.equal(waiting.presented,held.presented)
    assert.ok(secondImage.colored>10000,'Blocked pages must not immediately erase all previous ink')
    assert.notEqual(secondImage.hash,firstImage.hash,
        'Partial particle history should evolve and fade instead of freezing an unchanged image')

    await page.mouse.move(700,600)
    await page.mouse.down()
    await page.mouse.move(725,600,{steps:8})
    await page.mouse.up()
    await page.waitForTimeout(200)
    const panned = await facts(), pannedImage = await image('held-pan')
    assert.equal(panned.state,'loading')
    assert.equal(panned.ready,false)
    assert.equal(panned.particlesAdvancing,true)
    assert.ok(panned.steps>waiting.steps)
    assert.equal(panned.resets,baseline.resets)
    assert.equal(panned.refills,baseline.refills)
    assert.equal(panned.history.cleared,false)
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
    await page.unroute(allTiles)

    // A deliberate seek is different from an ordinary camera update. Even once
    // t10/t11 safety runtimes are ready, the pending visual reset must keep old
    // ink retained until the new pair's complete view can replace it atomically.
    let blockedSeekRequests = 0
    const seekGate = new Promise(resolve => { releaseSeek = resolve })
    await page.route(/\/tiles\/WebMercatorQuad\/t1[01]\/(?!4\/)/, async route => {
        blockedSeekRequests++
        await seekGate
        await route.continue().catch(() => undefined)
    })
    const time = page.locator('[data-flow-control="time"]')
    await time.fill('10.5')
    await time.dispatchEvent('change')
    await page.waitForFunction(() => {
        const f = window.__FLOW_FIELD_PROOF__.facts()
        return f.temporalWindow.state === 'ready' &&
            f.lastFrame.temporal?.lowerSampleKey === 't10' &&
            f.lastFrame.temporal?.upperSampleKey === 't11' &&
            f.lastFrame.presentationReady === false && f.workers.activeTaskCount > 0 &&
            !f.lastFrame.history?.cameraChanged
    },undefined,{timeout:60000})
    const seekHeld = await facts(), seekHeldImage = await image('seek-held')
    assert.ok(blockedSeekRequests>0,'Block detail pages after the seek safety cover becomes ready')
    assert.equal(seekHeld.state,'loading')
    assert.equal(seekHeld.windowState,'ready','Test the reset gate, not an unconstructed runtime')
    assert.equal(seekHeld.particlesAdvancing,false,'Pending seek reset must block new ink from the old particle pool')
    assert.equal(seekHeld.resets,recovered.resets,'Do not clear the old pool before replacement is ready')
    assert.equal(seekHeld.refills,recovered.refills)
    assert.equal(seekHeld.history.cleared,false)
    assert.ok(seekHeldImage.colored>10000,'Keep the old image while the new pair is incomplete')
    await page.waitForTimeout(350)
    const seekWaiting = await facts(), seekWaitingImage = await image('seek-still-held')
    assert.equal(seekWaiting.ready,false)
    assert.equal(seekWaiting.particlesAdvancing,false)
    assert.equal(seekWaiting.steps,seekHeld.steps)
    assert.equal(seekWaiting.resets,seekHeld.resets)
    assert.equal(seekWaiting.refills,seekHeld.refills)
    assert.equal(seekWaiting.presented,seekHeld.presented)
    assert.equal(seekWaitingImage.hash,seekHeldImage.hash,
        'Explicit reset loading must neither decay old ink nor write new segments')
    releaseSeek()
    await page.waitForFunction(() => {
        const f = window.__FLOW_FIELD_PROOF__.facts()
        return document.body.dataset.status === 'ready' && f.workers.activeTaskCount === 0 &&
            f.lastFrame.temporal?.lowerSampleKey === 't10' &&
            f.lastFrame.temporal?.upperSampleKey === 't11' && f.lastFrame.presentationReady
    },undefined,{timeout:60000})
    const seekRecovered = await facts()
    assert.equal(seekRecovered.particlesAdvancing,true)
    assert.equal(seekRecovered.resets,seekHeld.resets+1,'Apply exactly one seek reset before resumed simulation')
    assert.ok(seekRecovered.steps>seekHeld.steps)
    assert.notEqual(seekRecovered.presented,seekHeld.presented)
    const cleanup = await page.evaluate(() => window.__FLOW_FIELD_PROOF__.dispose())
    assert.equal(cleanup.cleanupFailures.length,0)
    const disposed = await page.evaluate(() => {
        const f = window.__FLOW_FIELD_PROOF__.facts()
        return {window:f.temporalWindow,activeTasks:f.workers.activeTaskCount}
    })
    assert.equal(disposed.window.ownedRuntimeCount,0)
    assert.equal(disposed.window.pendingCreationCount,0)
    assert.equal(disposed.window.activeCaptureCount,0)
    assert.equal(disposed.activeTasks,0)
    assert.deepEqual(errors,[])
    console.log(JSON.stringify({status:'passed',blockedRequests,baseline,held,waiting,panned,recovered,
        firstImage,secondImage,pannedImage,finalImage,blockedSeekRequests,seekHeld,seekWaiting,
        seekHeldImage,seekWaitingImage,seekRecovered,disposed,errors}))
} finally {
    release?.()
    releaseSeek?.()
    await browser.close()
}
