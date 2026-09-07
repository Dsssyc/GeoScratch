import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'

// Actual temporal playback is essential: warming only at the final model time
// cannot reproduce scars left by the moving cancellation curve in raw history.
const base = process.env.FLOW_HISTORY_RECOVERY_BASE ?? 'http://127.0.0.1:5173'
const output = process.env.FLOW_HISTORY_RECOVERY_OUTPUT ?? '/tmp/flow-field-history-recovery'
await mkdir(output,{recursive:true})
const browser = await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-webgpu']})
try {
    const page = await browser.newPage({viewport:{width:1512,height:861},deviceScaleFactor:2})
    const errors = []
    page.on('pageerror',e => errors.push(e.message))
    page.on('console',m => { if (m.type()==='error') errors.push(m.text()) })
    await page.route('**/flowField/map.ts*',async route => {
        const response = await route.fetch(), body = await response.text()
        const marker = 'center: FLOW_FIELD_MAP_DEFAULTS.center'
        assert.ok(body.includes(marker))
        await route.fulfill({response,body:body.replace(marker,'center: [121.05903696380413,31.742548034700167]')})
    })
    await page.goto(`${base}/flowField/index.html?proof=1&rate=0.000000001&zoom=12`)
    await page.waitForFunction(() => document.body.dataset.status==='ready' &&
        window.__FLOW_FIELD_PROOF__?.facts()?.lastFrame.presentationReady,undefined,{timeout:90000})
    const start = await page.evaluate(() => {
        const p = window.__FLOW_FIELD_PROOF__, start = p.facts().renderer.particles.encodedSteps
        p.seek(14.05)
        return start
    })
    await page.waitForFunction(start => {
        const f = window.__FLOW_FIELD_PROOF__.facts()
        return f.lastFrame.presentationReady && f.lastFrame.temporal.lowerSampleKey==='t14' &&
            f.renderer.particles.encodedSteps>=start+240 && f.workers.activeTaskCount===0
    },start,{timeout:90000})
    const warm = await page.evaluate(() => {
        const p = window.__FLOW_FIELD_PROOF__
        p.setPresentation({view:'particles',sample:'interpolated',trails:true,contour:false,boundary:'sdf',sdfFeatherTexels:.35})
        p.setRate(.2)
        return p.facts().renderer.particles.resetCount
    })
    await page.waitForFunction(() => {
        const p = window.__FLOW_FIELD_PROOF__
        if (p.facts().lastFrame.temporal.presentedModelTime<14.93) return false
        p.pause()
        return true
    },undefined,{timeout:30000})
    const results = []
    for (const boundary of ['sdf','hard','sdf']) {
        await page.locator('[data-flow-control="boundary"]').selectOption(boundary)
        await page.waitForFunction(boundary => {
            const f = window.__FLOW_FIELD_PROOF__.facts()
            return f.renderer.history.boundary===boundary && f.lastFrame.presentationReady &&
                f.frames.observedFrameCount>=f.frames.submittedFrameCount
        },boundary,{timeout:30000})
        const facts = await page.evaluate(() => {
            const f = window.__FLOW_FIELD_PROOF__.facts()
            return {time:f.lastFrame.temporal.presentedModelTime,ready:f.lastFrame.presentationReady,
                steps:f.renderer.particles.encodedSteps,resets:f.renderer.particles.resetCount,
                workers:f.workers.activeTaskCount,pages:f.lastFrame.demand.candidatePages.map(p => p.tile.matrixId),
                history:f.renderer.history,cleared:f.lastFrame.history.cleared}
        })
        assert.ok(facts.time>=14.93 && facts.time<14.99,'Observe this cancellation sweep, not a later recovered time')
        assert.equal(facts.resets,warm)
        assert.equal(facts.workers,0)
        assert.equal(facts.cleared,false)
        assert.ok(facts.pages.length>0 && facts.pages.every(z => z==='10'))
        const path = `${output}/${results.length}-${boundary}.png`
        const png = await page.screenshot({path,style:'#FlowFieldControls,.maplibregl-control-container{visibility:hidden!important}'})
        const regions = await page.evaluate(async b64 => {
            const image = new Image(); image.src=`data:image/png;base64,${b64}`; await image.decode()
            const canvas = document.createElement('canvas'); canvas.width=image.width; canvas.height=image.height
            const context = canvas.getContext('2d'); context.drawImage(image,0,0)
            // Logical pixels, fixed constructor camera. These interior boxes
            // exclude banks and include the three user-reported swept scars.
            return [[435,96,215,82],[875,211,230,290],[1045,538,150,78]].map(([x,y,w,h]) => {
                const bytes = context.getImageData(x*2,y*2,w*2,h*2).data
                let dark=0,blue=0
                for (let i=0;i<bytes.length;i+=4) { if (bytes[i+2]<45) dark++; blue+=bytes[i+2] }
                return {box:[x,y,w,h],darkFraction:dark/(w*h*4),meanBlue:blue/(w*h*4)}
            })
        },png.toString('base64'))
        results.push({boundary,path,facts,regions})
    }
    const cleanup = await page.evaluate(() => window.__FLOW_FIELD_PROOF__.dispose())
    assert.deepEqual(cleanup.cleanupFailures,[])
    assert.deepEqual(errors,[])
    console.log(JSON.stringify({output,results,errors}))
    for (const result of results) for (const [index,region] of result.regions.entries()) {
        assert.ok(region.meanBlue>70,'Establish populated interior ink, not merely a dark uniform image')
        // The lower box includes naturally sparse streamlines: its pre-fix
        // swept scar occupied over 10%, versus 2-3% ordinary gaps after repair.
        assert.ok(region.darkFraction<(index===2?.06:.012),
            `Persistent swept scar in ${result.boundary}/${region.box}: ${region.darkFraction}`)
    }
} finally { await browser.close() }
