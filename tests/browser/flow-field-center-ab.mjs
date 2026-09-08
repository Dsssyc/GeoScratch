import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'

const base = process.env.FLOW_CENTER_BASE ?? 'http://127.0.0.1:5173'
const output = process.env.FLOW_CENTER_OUTPUT ?? '/tmp/flow-field-center-ab'
await mkdir(output, {recursive:true})
const browser = await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-webgpu']})
const errors = [], measurements = [], shots = []
try {
    const page = await browser.newPage({viewport:{width:1200,height:800},deviceScaleFactor:2})
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type()==='error') errors.push(message.text()) })
    // Same real z10 dataset and a fixed small dry feature, independent of user camera.
    await page.route('**/flowField/map.ts*', async route => {
        const response = await route.fetch(), body = await response.text()
        assert.ok(body.includes('center: FLOW_FIELD_MAP_DEFAULTS.center'))
        await route.fulfill({response,body:body.replace('center: FLOW_FIELD_MAP_DEFAULTS.center',
            'center: [120.95947265625,31.764953615111956]')})
    })
    await page.goto(`${base}/flowField/?proof=1&rate=0.000000001&zoom=14`)
    await page.waitForFunction(() => document.body.dataset.status==='error' ||
        window.__FLOW_FIELD_PROOF__?.facts()?.lastFrame.presentationReady,undefined,{timeout:90000})
    assert.equal(await page.locator('body').getAttribute('data-status'),'ready',JSON.stringify(errors))
    const start = await page.evaluate(() => {
        const p=window.__FLOW_FIELD_PROOF__, n=p.facts().renderer.particles.encodedSteps
        p.seek(7.95294); return n
    })
    await page.waitForFunction(start => {
        const f=window.__FLOW_FIELD_PROOF__.facts()
        return f.lastFrame.presentationReady && f.lastFrame.temporal.lowerSampleKey==='t07' &&
            f.workers.activeTaskCount===0 && f.renderer.particles.encodedSteps>=start+100
    },start,{timeout:90000})
    const control = name => page.locator(`[data-flow-control="${name}"]`)
    const facts = () => page.evaluate(() => {
        const f=window.__FLOW_FIELD_PROOF__.facts()
        return {time:f.lastFrame.temporal.presentedModelTime,steps:f.renderer.particles.encodedSteps,
            resets:f.renderer.particles.resetCount,centers:f.renderer.particles.centerSamples,
            boundary:f.renderer.history.boundary,ready:f.lastFrame.presentationReady,
            extraBytes:f.renderer.history.sdfExtraTextureBytes,cleared:f.lastFrame.history?.cleared,
            camera:JSON.stringify(f.lastFrame.view.clipFromRelativeWorld)}
    })
    async function select(mode) {
        await control('boundary').selectOption(mode)
        await page.waitForFunction(mode => {
            const f=window.__FLOW_FIELD_PROOF__.facts()
            return f.lastFrame.presentationReady && f.renderer.history.boundary===mode &&
                f.renderer.particles.centerSamples===mode.startsWith('sdf-center-')
        },mode,{timeout:30000})
    }
    for (const mode of ['hard','sdf','sdf-center-linear','sdf-center-smooth']) {
        await select(mode)
        const before=await facts()
        await page.waitForTimeout(3000)
        const after=await facts(), updates=after.steps-before.steps
        assert.ok(updates>30,`${mode}: animation must keep advancing`)
        assert.equal(after.resets,before.resets)
        measurements.push({mode,updates,seconds:3,stepsPerSecond:updates/3})
    }
    await page.evaluate(() => window.__FLOW_FIELD_PROOF__.pause())
    await page.waitForFunction(() => {
        const f=window.__FLOW_FIELD_PROOF__.facts()
        return !f.timeline.playing && f.frames.observedFrameCount>=f.frames.submittedFrameCount
    })
    const paused=await facts()
    for (const mode of ['hard','sdf','sdf-center-linear','sdf-center-smooth','sdf-center-linear','hard']) {
        await select(mode)
        const snapshot=await facts()
        assert.equal(snapshot.resets,paused.resets,'Mode controls preserve canonical particle slots')
        assert.equal(snapshot.camera,paused.camera)
        assert.equal(snapshot.time,paused.time)
        assert.equal(snapshot.extraBytes,0)
        assert.equal(snapshot.cleared,false)
        const path=`${output}/${shots.length}-${mode}.png`
        await page.screenshot({path,style:'#FlowFieldControls,.maplibregl-control-container{visibility:hidden!important}'})
        shots.push({path,...snapshot})
    }
    await select('sdf-center-smooth')
    await page.screenshot({path:`${output}/controls.png`})
    await control('view').selectOption('status')
    assert.equal(await control('boundary').isDisabled(),true)
    assert.equal(await control('feather').isDisabled(),true)
    await control('view').selectOption('particles')
    await select('sdf-center-smooth')
    const beforeMove=await facts()
    await page.mouse.move(600,350)
    await page.mouse.down({button:'right'})
    await page.mouse.move(640,510,{steps:20})
    await page.mouse.up({button:'right'})
    await page.mouse.wheel(0,-250)
    await page.waitForFunction(before => {
        const f=window.__FLOW_FIELD_PROOF__.facts()
        return f.lastFrame.presentationReady && f.renderer.particles.encodedSteps>before.steps &&
            JSON.stringify(f.lastFrame.view.clipFromRelativeWorld)!==before.camera
    },beforeMove,{timeout:60000})
    await page.setViewportSize({width:900,height:650})
    await page.waitForFunction(() => window.__FLOW_FIELD_PROOF__.facts().renderer.history.size.width===1800)
    await page.evaluate(() => { const p=window.__FLOW_FIELD_PROOF__;p.seek(7.99);p.setRate(1);p.play() })
    await page.waitForFunction(() => {
        const f=window.__FLOW_FIELD_PROOF__.facts()
        return f.lastFrame.presentationReady && f.lastFrame.temporal.lowerSampleKey==='t08' &&
            f.renderer.particles.centerSamples
    },undefined,{timeout:60000})
    const cleanup=await page.evaluate(() => window.__FLOW_FIELD_PROOF__.dispose())
    assert.deepEqual(cleanup.cleanupFailures,[])
    assert.deepEqual(errors,[])
    console.log(JSON.stringify({output,measurements,shots,cleanup,errors},null,2))
} finally { await browser.close() }
