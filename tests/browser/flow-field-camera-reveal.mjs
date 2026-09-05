import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { mat4 } from 'wgpu-matrix'

const base = process.env.FLOW_REVEAL_BASE ?? 'http://127.0.0.1:5173'
const browser = await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-webgpu']})
const results = []
try {
    for (const refill of [false, true]) {
        const page = await browser.newPage({viewport:{width:1440,height:900}})
        const errors = []
        page.on('pageerror', error => errors.push(error.message))
        page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
        if (!refill) await page.route('**/flowField/shaders/particle-simulation.compute.wgsl*', async route => {
            const response = await route.fetch(), body = await response.text()
            const quota = 'let quota = FlowSpawnIndex_refill_quota(flowParticleConfig.particle_count);'
            assert.ok(body.includes(quota))
            await route.fulfill({response, body:body.replace(quota, 'let quota = 0u;')})
        })
        await page.goto(`${base}/flowField/index.html?proof=1&rate=0.001&zoom=10`)
        await page.waitForFunction(() => document.body.dataset.status === 'error' ||
            (window.__FLOW_FIELD_PROOF__?.facts()?.renderer.particles.encodedSteps ?? 0) >= 180,
        undefined, {timeout:90000})
        assert.equal(await page.locator('body').getAttribute('data-status'), 'ready')
        const toggle = page.locator('[data-flow-control="play-pause"]')
        await toggle.click()
        const old = await page.evaluate(() => window.__FLOW_FIELD_PROOF__.facts().lastFrame.view)
        await page.mouse.move(550,500)
        await page.mouse.down({button:'right'})
        await page.mouse.move(550,395,{steps:8})
        await page.mouse.up({button:'right'})
        await page.waitForFunction(() => {
            const f = window.__FLOW_FIELD_PROOF__.facts()
            return f.workers.activeTaskCount === 0 && !f.renderer.viewDemand.pending &&
                f.lastFrame.view.cameraPitchRadians > 1 && f.renderer.particles.viewRefillCount > 0
        }, undefined, {timeout:60000})
        const before = await page.evaluate(() => {
            const f = window.__FLOW_FIELD_PROOF__.facts()
            return {view:f.lastFrame.view, particles:f.renderer.particles}
        })
        const shots = []
        for (const ticks of [4, 60]) {
            const start = await page.evaluate(() => window.__FLOW_FIELD_PROOF__.facts().renderer.particles.encodedSteps)
            await toggle.click()
            await page.waitForFunction(start => window.__FLOW_FIELD_PROOF__.facts().renderer.particles.encodedSteps >= start,
                start + ticks)
            await toggle.click()
            const facts = await page.evaluate(() => window.__FLOW_FIELD_PROOF__.facts().renderer.particles)
            assert.equal(facts.viewRefillCount, before.particles.viewRefillCount, 'Stationary playback must not keep refilling')
            assert.equal(facts.resetCount, before.particles.resetCount, 'Camera reveal must not clear all particles')
            shots.push({ticks:facts.encodedSteps - start, png:(await page.screenshot({
                style:'#FlowFieldControls{visibility:hidden!important}',
            })).toString('base64')})
        }
        await page.locator('[data-flow-control="view"]').selectOption('speed')
        await page.waitForTimeout(200)
        const speed = (await page.screenshot({style:'#FlowFieldControls{visibility:hidden!important}'})).toString('base64')
        const inverse = Array.from(mat4.inverse(before.view.clipFromRelativeWorld,new Float64Array(16)))
        const coverage = await page.evaluate(async ({old, view, inverse, shots, speed}) => {
            const pixels = async b64 => {
                const image = new Image(); image.src = 'data:image/png;base64,' + b64; await image.decode()
                const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height
                const ctx = canvas.getContext('2d'); ctx.drawImage(image,0,0)
                return ctx.getImageData(0,0,canvas.width,canvas.height).data
            }
            const colored = (bytes, index) => Math.max(bytes[index],bytes[index+1],bytes[index+2]) -
                Math.min(bytes[index],bytes[index+1],bytes[index+2]) > 25
            const mul = (matrix, vector) => [0,1,2,3].map(row =>
                vector.reduce((sum,value,column) => sum + matrix[column*4+row]*value, 0))
            const truth = await pixels(speed), mask = [], width = 1440, height = 900
            for (let y=0;y<height;y++) for (let x=0;x<width;x++) {
                const index = (y*width+x)*4
                if (!colored(truth,index)) continue
                const ndc = [(x+0.5)/width*2-1,1-(y+0.5)/height*2]
                const a=mul(inverse,[...ndc,0,1]), b=mul(inverse,[...ndc,1,1])
                const near=a.slice(0,3).map(value=>value/a[3]), far=b.slice(0,3).map(value=>value/b[3])
                const t=(-view.cameraHigh[2]-view.cameraLow[2]-near[2])/(far[2]-near[2])
                if(t<0||t>1) continue
                const relative=near.map((value,k)=>value+(far[k]-value)*t+
                    view.cameraHigh[k]-old.cameraHigh[k]+view.cameraLow[k]-old.cameraLow[k])
                const clip=mul(old.clipFromRelativeWorld,[...relative,1])
                if(clip[3]>0&&Math.abs(clip[0])<=clip[3]&&Math.abs(clip[1])<=clip[3]) continue
                mask.push(index)
            }
            const lit=[]
            for(const shot of shots){const bytes=await pixels(shot.png);lit.push(mask.filter(index=>colored(bytes,index)).length)}
            return {newValidPixels:mask.length, early:lit[0], settled:lit[1], earlyToSettled:lit[0]/lit[1]}
        }, {old,view:before.view,inverse,shots,speed})
        assert.ok(coverage.newValidPixels > 10000, 'Pitch must expose a substantial valid region')
        if (refill) {
            await page.locator('[data-flow-control="view"]').selectOption('particles')
            await toggle.click()
            await page.waitForTimeout(300)
            const beforeSweep = await page.evaluate(() => window.__FLOW_FIELD_PROOF__.facts().renderer.particles)
            await page.mouse.move(550,500)
            await page.mouse.down({button:'right'})
            for (let step=0;step<15;step++) {
                await page.mouse.move(550+step*2,500+step*2)
                await page.waitForTimeout(50)
            }
            await page.mouse.up({button:'right'})
            await page.waitForTimeout(400)
            const settled = await page.evaluate(() => window.__FLOW_FIELD_PROOF__.facts().renderer.particles)
            await page.waitForTimeout(300)
            const steady = await page.evaluate(() => window.__FLOW_FIELD_PROOF__.facts().renderer.particles)
            assert.equal(steady.resetCount,beforeSweep.resetCount,'Continuous pitch must preserve the particle pool')
            assert.equal(steady.viewRefillCount,settled.viewRefillCount,'Refill must stop after the camera settles')
            assert.ok(steady.encodedSteps>settled.encodedSteps,'Normal animation must continue after refill')
            await toggle.click()
        }
        assert.deepEqual(errors, [])
        const cleanup=await page.evaluate(()=>window.__FLOW_FIELD_PROOF__.dispose())
        assert.equal(cleanup.cleanupFailures.length,0)
        results.push({refill,ticks:shots.map(shot=>shot.ticks),...coverage,errors})
        await page.close()
    }
    assert.ok(results[1].earlyToSettled > 0.75, 'New view must receive a visible first cohort promptly')
    assert.ok(results[1].earlyToSettled > results[0].earlyToSettled + 0.1,
        'Targeted refill must outperform natural retirement at the same camera')
    console.log(JSON.stringify({status:'passed',results}))
} finally {
    await browser.close()
}
