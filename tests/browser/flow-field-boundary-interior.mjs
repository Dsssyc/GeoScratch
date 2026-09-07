import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'

// A full-resolution interior regression, independent of B's implementation.
// Compare persistent ink against a separately captured background. A display
// toggle admits a particle step, so neither image equality nor one bright pixel
// establishes preservation of the original interior flow.
const base = process.env.FLOW_BOUNDARY_INTERIOR_BASE ?? 'http://127.0.0.1:5173'
const tileBase = process.env.FLOW_BOUNDARY_INTERIOR_TILES ?? 'http://127.0.0.1:8788'
const output = process.env.FLOW_BOUNDARY_INTERIOR_OUTPUT ?? '/tmp/flow-field-boundary-interior'
const viewport = {width:1512,height:861}, deviceScaleFactor = 2
const modelTime = 23.54772
const witnesses = [
    {
        name:'interior-primary', center:[121.07963562011719,31.75678011033563], pixel:[103,167],
        expectedCurrent:[0.7833012938499451,-0.33850356936454773],
        expectedNext:[-0.620028018951416,0.26816967129707336],
    },
    {
        name:'interior-strong-cancellation', center:[120.97663879394531,31.781298465181326], pixel:[28,146],
        expectedCurrent:[1.108889102935791,-0.20044852793216705],
        expectedNext:[-0.932784378528595,0.16739162802696228],
    },
]
const manifestResponse = await fetch(`${tileBase}/manifest.json`)
assert.equal(manifestResponse.status,200)
const manifest = await manifestResponse.json()
assert.equal(manifest.representation.activitySupport,'nearest-texel-zero')
const kill = manifest.maximumSpeed*0.0005
const fields = [], sourcePages = []
for (const sampleKey of ['t23','t24']) {
    const record = manifest.pages.find(page => page.sampleKey===sampleKey && page.matrixId==='10' &&
        page.tileRow===416 && page.tileCol===856)
    assert.ok(record,'The exact z10 witness page must be declared')
    const response = await fetch(`${tileBase}/${record.path}`)
    assert.equal(response.status,200)
    const bytes = Buffer.from(await response.arrayBuffer())
    assert.equal(bytes.length,524288)
    assert.equal(createHash('sha256').update(bytes).digest('hex'),record.sha256)
    fields.push(new Float32Array(bytes.buffer,bytes.byteOffset,bytes.byteLength/4))
    sourcePages.push({path:record.path,sha256:record.sha256,bytes:bytes.length})
}
for (const witness of witnesses) {
    const offset = (witness.pixel[1]*256+witness.pixel[0])*2
    const current = Array.from(fields[0].subarray(offset,offset+2))
    const next = Array.from(fields[1].subarray(offset,offset+2))
    assert.deepEqual(current,witness.expectedCurrent,'Freeze the diagnosed source vectors, not a new B formula')
    assert.deepEqual(next,witness.expectedNext)
    const alpha = Math.fround(modelTime-23)
    const velocity = current.map((value,index) => value*(1-alpha)+next[index]*alpha)
    const speed = Math.hypot(...velocity)
    assert.ok(speed>4*kill,'The witness is above even the full absolute-speed display-gain threshold')
    assert.ok(current[0]*next[0]+current[1]*next[1]<0,'The fixture contains opposing endpoints')
    witness.source = {tile:[10,416,856],pixel:witness.pixel,current,next,alpha,velocity,speed,
        kill,speedOverKill:speed/kill}
}
await mkdir(output,{recursive:true})
const browser = await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-webgpu']})
const results = []
try {
    for (const witness of witnesses) {
        const page = await browser.newPage({viewport,deviceScaleFactor})
        const errors = []
        page.on('pageerror',error => errors.push(error.message))
        page.on('console',message => { if (message.type()==='error') errors.push(message.text()) })
        await page.route('**/flowField/map.ts*',async route => {
            const response = await route.fetch(), body = await response.text()
            const marker = 'center: FLOW_FIELD_MAP_DEFAULTS.center'
            assert.ok(body.includes(marker),'Install a fixed constructor camera only in this isolated page')
            await route.fulfill({response,body:body.replace(marker,`center: ${JSON.stringify(witness.center)}`)})
        })
        await page.goto(`${base}/flowField/index.html?proof=1&rate=0.000000001&zoom=13&tileServer=${encodeURIComponent(tileBase)}`)
        await page.waitForFunction(() => document.body.dataset.status==='error' ||
            (document.body.dataset.status==='ready' && window.__FLOW_FIELD_PROOF__?.facts()?.lastFrame.presentationReady),
        undefined,{timeout:90000})
        assert.equal(await page.locator('body').getAttribute('data-status'),'ready')
        const start = await page.evaluate(time => {
            const proof = window.__FLOW_FIELD_PROOF__, steps = proof.facts().renderer.particles.encodedSteps
            proof.seek(time)
            return steps
        },modelTime)
        await page.waitForFunction(start => {
            const f = window.__FLOW_FIELD_PROOF__.facts()
            return f.lastFrame.presentationReady && f.lastFrame.temporal?.lowerSampleKey==='t23' &&
                f.lastFrame.temporal?.upperSampleKey==='t24' &&
                f.renderer.particles.encodedSteps>=start+240 && f.workers.activeTaskCount===0
        },start,{timeout:90000})
        const control = name => page.locator(`[data-flow-control="${name}"]`)
        await control('play-pause').click()
        await settled()
        const baseline = await facts()
        assert.equal(baseline.playing,false)
        assert.equal(baseline.boundary,'hard')
        assert.equal(baseline.feather,0.25)
        assert.equal(baseline.zoom,13)
        assert.ok(Math.abs(baseline.modelTime-modelTime)<1e-6)
        assert.ok(baseline.pages.length>0 && baseline.pages.every(page => page.matrixId==='10'),
            'The complete view must request actual z10 pages, not coarse substitutes')
        assert.ok(baseline.pages.some(page => page.tileRow===416 && page.tileCol===856))
        const background = await capture('background',true)
        const before = await capture('a-before')
        await changeBoundary('sdf')
        const soft = await capture('b-interior')
        await changeBoundary('hard')
        const after = await capture('a-after')
        for (const shot of [background,before,soft,after]) {
            assert.equal(shot.facts.camera,baseline.camera)
            assert.equal(shot.facts.modelTime,baseline.modelTime)
            assert.equal(shot.facts.resets,baseline.resets,'A-B-A must not reset the particle pool')
            assert.equal(shot.facts.cleared,false,'A-B-A must not erase the raw history')
            assert.equal(shot.facts.pair,baseline.pair)
            assert.equal(shot.facts.ready,true)
            assert.equal(shot.facts.workers,0)
        }
        assert.ok(soft.facts.steps>before.facts.steps && after.facts.steps>soft.facts.steps,
            'Account for the admitted particle step of each display toggle')
        const regions = await compareInk(page,[background.png,before.png,soft.png,after.png])

        // Diagnostics deliberately run after the A-B-A comparison because a view
        // switch may reset history. Resident green proves the target pixels are
        // exact source data, independently of view-wide readiness facts.
        await control('view').selectOption('status')
        await settled()
        const status = await capture('sample-status')
        const resident = await statusFraction(page,status.png)
        assert.equal(status.facts.boundary,'hard')
        assert.ok(resident.fraction>=0.98,'At least 98% of the 33x33 ROI must be exact-resident nonzero status')
        const cleanup = await page.evaluate(() => window.__FLOW_FIELD_PROOF__.dispose())
        assert.deepEqual(cleanup.cleanupFailures,[])
        const final = await page.evaluate(() => {
            const f = window.__FLOW_FIELD_PROOF__.facts()
            return {window:f.temporalWindow,activeTasks:f.workers.activeTaskCount}
        })
        assert.equal(final.window.ownedRuntimeCount,0)
        assert.equal(final.window.pendingCreationCount,0)
        assert.equal(final.window.activeCaptureCount,0)
        assert.equal(final.activeTasks,0)
        assert.deepEqual(errors,[])
        const result = {name:witness.name,center:witness.center,source:witness.source,baseline,
            screenshots:[background,before,soft,after,status].map(({path,facts}) => ({path,facts})),
            regions,resident,final,errors}
        results.push(result)
        console.log(JSON.stringify({status:'observed',...result}))
        await page.close()

        async function facts() {
            return await page.evaluate(() => {
                const f = window.__FLOW_FIELD_PROOF__.facts(), frame = f.lastFrame
                return {modelTime:f.timeline.modelTime,playing:f.timeline.playing,
                    steps:f.renderer.particles.encodedSteps,resets:f.renderer.particles.resetCount,
                    observed:f.frames.observedFrameCount,ready:frame.presentationReady,
                    cleared:frame.history?.cleared,boundary:f.renderer.history.boundary,
                    feather:f.renderer.history.sdfFeatherTexels,pair:f.temporalWindow.pairGeneration,
                    workers:f.workers.activeTaskCount,requestedLevel:frame.demand?.requestedLevel,
                    zoom:frame.view?.zoomHint,pages:frame.demand?.candidatePages.map(page => page.tile),
                    camera:JSON.stringify([frame.view?.clipFromRelativeWorld,frame.view?.cameraHigh,
                        frame.view?.cameraLow,frame.view?.referenceViewport])}
            })
        }
        async function settled() {
            await page.waitForFunction(() => {
                const f = window.__FLOW_FIELD_PROOF__.facts()
                return document.body.dataset.status==='ready' && f.lastFrame.presentationReady &&
                    f.workers.activeTaskCount===0 && f.frames.observedFrameCount>=f.frames.submittedFrameCount
            },undefined,{timeout:60000})
        }
        async function changeBoundary(boundary) {
            const previous = await facts()
            await control('boundary').selectOption(boundary)
            await page.waitForFunction(({boundary,observed}) => {
                const f = window.__FLOW_FIELD_PROOF__.facts()
                return f.renderer.history.boundary===boundary && f.lastFrame.presentationReady &&
                    f.frames.observedFrameCount>observed && f.frames.observedFrameCount>=f.frames.submittedFrameCount
            },{boundary,observed:previous.observed},{timeout:30000})
        }
        async function capture(name,hideInk=false) {
            const path = `${output}/${witness.name}-${name}.png`
            const png = await page.screenshot({path,style:
                '#FlowFieldControls,.maplibregl-control-container{visibility:hidden!important}'+
                (hideInk?'#GPUFrame{visibility:hidden!important}':'')})
            return {path,png:png.toString('base64'),facts:await facts()}
        }
    }
    // Keep both diagnostic outputs and dispose both pages before rejecting the
    // old implementation, so one failed witness does not hide the second one.
    for (const result of results) for (const region of result.regions) {
        assert.ok(region.stableInkPixels>=Math.max(16,region.pixels*0.1),
            `${result.name}/${region.side}: A must contain enough persistent interior ink`)
        assert.ok(region.aBefore.meanSignal>8 && region.aAfter.meanSignal>8,
            `${result.name}/${region.side}: establish signal above the captured background`)
        assert.ok(region.meanRetainedFraction>=0.75,
            `${result.name}/${region.side}: B retained only ${(100*region.meanRetainedFraction).toFixed(1)}% of persistent A ink`)
        assert.ok(region.survivingFractionAtHalf>=0.8,
            `${result.name}/${region.side}: B must preserve most interior ink pixels, not merely a nonzero maximum`)
    }
    console.log(JSON.stringify({status:'passed',viewport,deviceScaleFactor,modelTime,
        dataset:manifest.contentVersion,sourcePages,results:results.map(result => ({name:result.name,regions:result.regions})),
        comparison:'Background-subtracted persistent interior ink across A-B-A; one admitted step per toggle, not bit-exact pixels'}))
} finally {
    await browser.close()
}

async function compareInk(page,images) {
    return await page.evaluate(async images => {
        const regions = [9,33].map(side => ({side,pixels:side*side,images:[]}))
        for (const b64 of images) {
            const image = new Image();image.src=`data:image/png;base64,${b64}`;await image.decode()
            const canvas = document.createElement('canvas');canvas.width=image.width;canvas.height=image.height
            const context = canvas.getContext('2d');context.drawImage(image,0,0)
            for (const region of regions) {
                const radius=(region.side-1)/2
                region.images.push(Array.from(context.getImageData(Math.floor(image.width/2)-radius,
                    Math.floor(image.height/2)-radius,region.side,region.side).data))
            }
            canvas.width=0;canvas.height=0
        }
        return regions.map(region => {
            const [background,a,b,returned]=region.images
            const signal=values => Array.from({length:region.pixels},(_,index) =>
                [0,1,2].reduce((sum,channel) => sum+Math.abs(values[index*4+channel]-background[index*4+channel]),0))
            const aSignal=signal(a),bSignal=signal(b),returnSignal=signal(returned)
            const stats=(values,energy) => ({meanRgb:[0,1,2].map(channel =>
                values.reduce((sum,value,index)=>sum+(index%4===channel?value:0),0)/region.pixels),
                meanSignal:energy.reduce((sum,value)=>sum+value,0)/region.pixels,
                inkPixels:energy.filter(value=>value>=8).length})
            const stable=Array.from({length:region.pixels},(_,index)=>index)
                .filter(index=>aSignal[index]>=8 && returnSignal[index]>=8)
            const retained=stable.map(index=>Math.min(1,bSignal[index]/Math.min(aSignal[index],returnSignal[index])))
            return {side:region.side,pixels:region.pixels,stableInkPixels:stable.length,
                aBefore:stats(a,aSignal),b:stats(b,bSignal),aAfter:stats(returned,returnSignal),
                meanRetainedFraction:retained.length?retained.reduce((sum,value)=>sum+value,0)/retained.length:0,
                survivingFractionAtHalf:retained.length?retained.filter(value=>value>=0.5).length/retained.length:0}
        })
    },images)
}

async function statusFraction(page,b64) {
    return await page.evaluate(async b64 => {
        const image = new Image();image.src=`data:image/png;base64,${b64}`;await image.decode()
        const canvas = document.createElement('canvas');canvas.width=image.width;canvas.height=image.height
        const context = canvas.getContext('2d');context.drawImage(image,0,0)
        const bytes = context.getImageData(Math.floor(image.width/2)-16,Math.floor(image.height/2)-16,33,33).data
        let resident=0
        for (let index=0;index<bytes.length;index+=4) {
            const r=bytes[index],g=bytes[index+1],b=bytes[index+2]
            if(g>75 && g>r*1.5 && g>b*1.05)resident++
        }
        canvas.width=0;canvas.height=0
        return {resident,pixels:33*33,fraction:resident/(33*33)}
    },b64)
}
