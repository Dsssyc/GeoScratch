import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'

// Run against separately served immutable v2/v3 data, never modify a live dataset.
const base = process.env.FLOW_BOUNDARY_BASE ?? 'http://127.0.0.1:5173'
const sources = [process.env.FLOW_BOUNDARY_OLD ?? 'http://127.0.0.1:8788',
    process.env.FLOW_BOUNDARY_NEW ?? 'http://127.0.0.1:8789']
const output = process.env.FLOW_BOUNDARY_OUTPUT ?? '/tmp/flow-field-boundary-source'
await mkdir(output, {recursive:true})
const browser = await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-webgpu']})
const results = []
try {
    for (const [index, source] of sources.entries()) {
        const manifest = await (await fetch(`${source}/manifest.json`)).json()
        assert.equal(manifest.construction.adapterVersion, `flow-cog-wmq-rg32f-v${index + 2}`)
        const page = await browser.newPage({viewport:{width:1440,height:900}})
        const errors = []
        page.on('pageerror', error=>errors.push(error.message))
        page.on('console', message=>{if(message.type()==='error')errors.push(message.text())})
        await page.goto(`${base}/flowField/index.html?proof=1&rate=0.001&zoom=10&view=speed&tileServer=${encodeURIComponent(source)}`)
        await page.waitForFunction(()=>document.body.dataset.status==='ready',undefined,{timeout:60000})
        await page.locator('[data-flow-control="play-pause"]').click()
        await page.locator('[data-flow-control="time"]').fill('10.277')
        await page.locator('[data-flow-control="time"]').dispatchEvent('change')
        // Use the fixed constructor camera. Drag inertia depends on event timing
        // and would make the two source coverage measurements incomparable.
        await page.waitForFunction(()=>document.body.dataset.status==='ready' &&
            window.__FLOW_FIELD_PROOF__.facts().lastFrame.temporal?.presentedModelTime===10.277 &&
            window.__FLOW_FIELD_PROOF__.facts().workers.activeTaskCount===0,
        undefined,{timeout:60000})
        const style = '#FlowFieldControls,.maplibregl-control-container{visibility:hidden!important}'
        async function capture(name) {
            const png = await page.screenshot({path:`${output}/v${index+2}-${name}.png`,style})
            return await page.evaluate(async data=>{
                const image = new Image();image.src='data:image/png;base64,'+data;await image.decode()
                const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height
                const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0)
                const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data
                let colored=0
                for(let i=0;i<pixels.length;i+=4) if(Math.max(pixels[i],pixels[i+1],pixels[i+2])-
                    Math.min(pixels[i],pixels[i+1],pixels[i+2])>25)colored++
                return colored
            },png.toString('base64'))
        }
        const speedPixels = await capture('speed')
        const view = await page.evaluate(()=>window.__FLOW_FIELD_PROOF__.facts().lastFrame.view)
        await page.locator('[data-flow-control="view"]').selectOption('particles')
        await page.locator('[data-flow-control="play-pause"]').click()
        await page.waitForFunction(()=>window.__FLOW_FIELD_PROOF__.facts().renderer.particles.encodedSteps>=180,
            undefined,{timeout:60000})
        const start = await page.evaluate(()=>window.__FLOW_FIELD_PROOF__.facts().renderer.spawn)
        await page.waitForTimeout(1000)
        const end = await page.evaluate(()=>window.__FLOW_FIELD_PROOF__.facts().renderer.spawn)
        assert.equal(end.buildCount,start.buildCount,'Alpha-only animation must reuse the observed endpoint union')
        assert.ok(end.cacheHitCount>start.cacheHitCount)
        await page.locator('[data-flow-control="play-pause"]').click()
        const particlePixels = await capture('particles')
        const cleanup = await page.evaluate(()=>window.__FLOW_FIELD_PROOF__.dispose())
        assert.deepEqual(cleanup.cleanupFailures,[])
        assert.equal(await page.evaluate(()=>window.__FLOW_FIELD_PROOF__.facts().temporalWindow.ownedRuntimeCount),0)
        assert.deepEqual(errors,[])
        results.push({version:index+2,contentVersion:manifest.contentVersion,speedPixels,particlePixels,
            camera:[view.clipFromRelativeWorld,view.cameraHigh,view.cameraLow],spawn:end,errors})
        await page.close()
    }
    assert.deepEqual(results[0].camera,results[1].camera,'Compare exactly the same camera')
    assert.ok(results[1].speedPixels>results[0].speedPixels*1.03,'The new source should restore represented field coverage')
    assert.ok(results[1].particlePixels>results[0].particlePixels*1.03,'Restored support must also appear as particles')
    console.log(JSON.stringify({status:'passed',output,results:results.map(({camera,...value})=>value)}))
} finally {
    await browser.close()
}
