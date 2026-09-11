import assert from 'node:assert/strict'
import {readFile,mkdir,writeFile} from 'node:fs/promises'
import {launchSecondaryBrowser} from '../experiments/terrain-cover-placement/secondary-browser.mjs'
import {chromium} from 'playwright'

const base='http://127.0.0.1:5173',output='output/flow-field-metadata-replay'
const recordedReference=process.env.FLOW_SAMPLER_REFERENCE_SHADER
    ? await readFile(process.env.FLOW_SAMPLER_REFERENCE_SHADER,'utf8') : undefined
await mkdir(output,{recursive:true})
const source=await (await fetch(base+'/flowField/temporal-velocity-raster.ts')).text()
const geoUrl=/import\s*\{[^}]*webMercatorVirtualRasterWgslModule[^}]*\}\s*from\s*"([^"]+)"/.exec(source)?.[1]
assert(geoUrl,'Vite Geo facade was not found')
const viewport={width:1760,height:880}
const managed=process.env.FLOW_SAMPLER_NATIVE==='1'
    ? await launchSecondaryBrowser({deviceScaleFactor:2,viewport}) : undefined
const browser=managed?.browser??await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-webgpu']})
const context=await browser.newContext({deviceScaleFactor:2,viewport}),page=await context.newPage(),report={}
try{
    await page.addInitScript({content:await readFile(new URL('./support/flow-particle-capture.js',import.meta.url),'utf8')})
    await page.goto(base+'/flowField/?proof=1&trailQuality=native&rate=0.000000001&zoom=9')
    await page.waitForFunction(()=>window.__FLOW_FIELD_PROOF__?.facts()?.lastFrame.presentationReady,undefined,{timeout:90000})
    await page.evaluate(()=>window.__FLOW_FIELD_PROOF__.seek(.277))
    const anchor=await page.evaluate(()=>window.__FLOW_FIELD_PROOF__.facts().renderer.particles.simulatedReferenceSteps)
    await page.waitForFunction(anchor=>{const f=window.__FLOW_FIELD_PROOF__.facts();return f.lastFrame.presentationReady&&f.workers.activeTaskCount===0&&f.renderer.particles.simulatedReferenceSteps>anchor+180},anchor,{timeout:90000})
    await page.evaluate(()=>window.__flowCapture.requested=true)
    await page.waitForFunction(()=>window.__flowCapture.capture?.ready||window.__flowCapture.capture?.error,undefined,{timeout:30000})
    await page.evaluate(()=>window.__FLOW_FIELD_PROOF__.pauseAndDrain())
    report.before=await page.evaluate(()=>{const f=window.__FLOW_FIELD_PROOF__.facts();return {frames:f.frames,history:f.renderer.history.size,surface:f.renderer.presentationSize,workers:f.workers.activeTaskCount}})
    assert.deepEqual(report.before.history,{width:3520,height:1760});assert.deepEqual(report.before.surface,report.before.history)
    await page.addScriptTag({content:await readFile(new URL('./support/flow-particle-metadata-replay.js',import.meta.url),'utf8')})
    report.replay=await page.evaluate(({url,reference})=>window.replayFlowSamplerMetadata(url,reference),{url:geoUrl,reference:recordedReference})
    await page.evaluate(async()=>{for(const r of window.__flowCapture.owned)r.destroy();await window.__FLOW_FIELD_PROOF__.dispose()})
    await managed?.verifyPlacement();report.status='passed';console.log(JSON.stringify(report.replay))
}finally{await browser.close();report.display=managed?.evidence??{mode:'headless',viewport,deviceScaleFactor:2,closed:true};await writeFile(output+'/report.json',JSON.stringify(report,null,2))}
