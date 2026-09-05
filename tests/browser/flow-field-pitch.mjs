import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { mat4 } from 'wgpu-matrix'

const base = process.env.FLOW_PITCH_BASE ?? 'http://127.0.0.1:5173'
const output = process.env.FLOW_PITCH_OUTPUT ?? '/tmp/flow-field-pitch'
const tiles = process.env.FLOW_PITCH_TILES ?? 'http://127.0.0.1:8788'
await mkdir(output,{recursive:true})
const browser = await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-webgpu']})
try {
    const page = await browser.newPage({viewport:{width:1440,height:900}})
    const errors = []
    page.on('pageerror', error=>errors.push(error.message))
    page.on('console', message=> {if(message.type()==='error') errors.push(message.text())})
    await page.goto(`${base}/flowField/index.html?proof=1&rate=0.001&zoom=10&view=speed&tileServer=${encodeURIComponent(tiles)}`)
    await page.waitForFunction(() => document.body.dataset.status === 'error' ||
        (window.__FLOW_FIELD_PROOF__?.facts()?.frames.observedFrameCount ?? 0) > 30,
        undefined,{timeout:90000})
    await page.locator('[data-flow-control="play-pause"]').click()
    await page.locator('[data-flow-control="time"]').fill('6.93')
    await page.locator('[data-flow-control="time"]').dispatchEvent('change')
    let finalView
    const views = []
    for (const amount of [0,80,30,30]) {
        if(amount) {
            await page.mouse.move(550,500)
            await page.mouse.down({button:'right'})
            await page.mouse.move(550,500-amount,{steps:10})
            await page.mouse.up({button:'right'})
        }
        await page.waitForTimeout(1500)
        const value = await page.evaluate(()=> {
            const facts = window.__FLOW_FIELD_PROOF__.facts()
            const frame = facts.lastFrame
            const matrices = {}
            for (const page of frame?.demand?.candidatePages ?? []) {
                const id = page.tile.matrixId
                matrices[id] = (matrices[id] ?? 0)+1
            }
            return {status:document.body.dataset.status,error:document.querySelector('#GPUFrame').dataset.error,
                view:frame?.view,requestedLevel:frame?.demand?.requestedLevel,matrices,
                pages:frame?.demand?.candidatePages?.length,temporal:frame?.temporal,
                feedback: facts.renderer.viewDemand,observed:facts.frames.observedFrameCount}
        })
        const pitch = Math.round((value.view?.cameraPitchRadians??0)*180/Math.PI)
        assert.equal(value.status, 'ready', value.error)
        assert.ok(value.pages <= 47)
        assert.ok(value.requestedLevel <= 1, `Pitch ${pitch} lost foreground detail: ${JSON.stringify(value.matrices)}`)
        finalView = value.view
        await page.screenshot({path:`${output}/pitch-${pitch}.png`,style:'#FlowFieldControls {visibility:hidden !important}'})
        views.push({pitch, matrices:value.matrices,pages:value.pages,requestedLevel:value.requestedLevel})
    }
    assert.ok(views[0].pitch<=1,'Initial view must be top-down')
    assert.ok(views[1].pitch>=40 && views[1].pitch<70,'First drag must produce a pitched view')
    assert.ok(views[2].pitch>views[1].pitch,'Second drag must increase pitch')
    assert.ok(views.at(-1).pitch>=80,'Final view must exercise the horizon at high pitch')
    const initialSteps = await page.evaluate(()=>window.__FLOW_FIELD_PROOF__.facts().renderer.particles.encodedSteps)
    await page.locator('[data-flow-control="view"]').selectOption('particles')
    await page.locator('[data-flow-control="play-pause"]').click()
    await page.waitForFunction(steps=>document.body.dataset.status==='error'||
        window.__FLOW_FIELD_PROOF__.facts().renderer.particles.encodedSteps>=steps+30,
        initialSteps,{timeout:30000})
    await page.locator('[data-flow-control="play-pause"]').click()
    const particlePng=await page.screenshot({path:`${output}/particles-85.png`,style:'#FlowFieldControls {visibility:hidden !important}'})
    const particlePixels=await page.evaluate(async base64=> {
        const image=new Image(); image.src=`data:image/png;base64,${base64}`; await image.decode()
        const canvas=document.createElement('canvas'); canvas.width=image.width; canvas.height=image.height
        const ctx=canvas.getContext('2d'); ctx.drawImage(image,0,0)
        const bytes=ctx.getImageData(0,0,image.width,image.height).data
        let count=0
        for(let i=0;i<bytes.length;i+=4) {
            if(Math.max(bytes[i],bytes[i+1],bytes[i+2])-Math.min(bytes[i],bytes[i+1],bytes[i+2])>25) count++
        }
        return count
    },particlePng.toString('base64'))
    assert.ok(particlePixels>100,'Pitched particles disappeared')
    await page.locator('[data-flow-control="time"]').fill('6.93')
    await page.locator('[data-flow-control="time"]').dispatchEvent('change')
    await page.locator('[data-flow-control="view"]').selectOption('speed')
    await page.evaluate(()=>window.__FLOW_FIELD_PROOF__.pauseAndDrain())
    const png = await page.screenshot({path:`${output}/speed-final.png`,style:'#FlowFieldControls {visibility:hidden !important}'})
    const probes = await page.evaluate(async base64=> {
        const image = new Image()
        image.src = `data:image/png;base64,${base64}`
        await image.decode()
        const canvas = document.createElement('canvas')
        canvas.width=image.width; canvas.height=image.height
        const ctx=canvas.getContext('2d'); ctx.drawImage(image,0,0)
        const pixels=ctx.getImageData(0,0,image.width,image.height).data
        const probes=[]
        for(let y=320;y<860;y+=13) for(let x=30;x<1400;x+=47) {
            const rgb=Array.from(pixels.slice((y*image.width+x)*4,(y*image.width+x)*4+3))
            if(Math.max(...rgb)-Math.min(...rgb)>25) probes.push({x,y,rgb})
        }
        return probes
    },png.toString('base64'))
    assert.ok(probes.length >= 10, 'Pitched Speed image has insufficient valid field pixels')
    const manifest = await (await fetch(`${tiles}/manifest.json`)).json()
    const matrix = 10 - views.at(-1).requestedLevel
    const inverse = mat4.inverse(finalView.clipFromRelativeWorld,new Float64Array(16))
    const cache = new Map()
    const limits=manifest.tileMatrixSet.limits.find(limit=>limit.matrixId===String(matrix))
    const maximumErrors=[]
    for(const probe of probes.filter((_value,index)=>index%Math.max(1,Math.floor(probes.length/30))===0)) {
        const world = groundAt(probe.x+0.5,probe.y+0.5,finalView,inverse)
        const lower=await velocityAt(world,matrix,'t06',limits,cache)
        const upper=await velocityAt(world,matrix,'t07',limits,cache)
        assert.ok(lower&&upper,'Colored Speed pixel is outside the published COG coverage')
        const speed=Math.hypot(lower[0]*.07+upper[0]*.93,lower[1]*.07+upper[1]*.93)
        assert.ok(speed>0,'Speed colored a zero-velocity COG pixel')
        const color=referenceColor(speed/manifest.maximumSpeed)
        const expected=color.map((value,i)=>value*.5+[16,20,24][i]*.5)
        maximumErrors.push(Math.max(...expected.map((value,i)=>Math.abs(value-probe.rgb[i]))))
    }
    assert.ok(maximumErrors.length>=10)
    assert.ok(Math.max(...maximumErrors)<=3, `Pitched speed differs from COG samples: ${JSON.stringify(maximumErrors)}`)
    const cleanup=await page.evaluate(()=>window.__FLOW_FIELD_PROOF__.dispose())
    assert.equal(cleanup.cleanupFailures.length,0)
    assert.deepEqual(errors,[])
    console.log(JSON.stringify({status:'passed',views,particlePixels,speedPixelProbes:maximumErrors.length,
        maximumColorError:Math.max(...maximumErrors),errors}))
} finally { await browser.close() }

function groundAt(x,y,view,inverse) {
    const ndc=[x/view.referenceViewport[0]*2-1,1-y/view.referenceViewport[1]*2]
    const point=z=> {
        const vector=[...ndc,z,1]
        const h=Array.from({length:4},(_,row)=>vector.reduce((sum,v,column)=>sum+inverse[column*4+row]*v,0))
        return h.slice(0,3).map(value=>value/h[3])
    }
    const near=point(0),far=point(1)
    const t=(-(view.cameraHigh[2]+view.cameraLow[2])-near[2])/(far[2]-near[2])
    return [0,1].map(i=>view.cameraHigh[i]+view.cameraLow[i]+near[i]+(far[i]-near[i])*t)
}

async function velocityAt(world,matrix,sample,limit,cache) {
    const size=2**matrix*256, span=40075016.68557849
    const position=[(world[0]/span+.5)*size-.5,(.5-world[1]/span)*size-.5]
    const origin=position.map(Math.floor), fraction=position.map((v,i)=>v-origin[i])
    const values=[]
    for(const [dx,dy] of [[0,0],[1,0],[0,1],[1,1]]) {
        const x=origin[0]+dx,y=origin[1]+dy,col=Math.floor(x/256),row=Math.floor(y/256)
        if(col<limit.minTileCol||col>limit.maxTileCol||row<limit.minTileRow||row>limit.maxTileRow) return undefined
        const key=`${sample}/${matrix}/${row}/${col}`
        if(!cache.has(key)) {
            const response=await fetch(`${tiles}/tiles/WebMercatorQuad/${key}.rg32f`)
            assert.equal(response.status,200)
            cache.set(key,new DataView(await response.arrayBuffer()))
        }
        const offset=((y%256)*256+x%256)*8
        values.push([cache.get(key).getFloat32(offset,true),cache.get(key).getFloat32(offset+4,true)])
    }
    return [0,1].map(i=> (values[0][i]*(1-fraction[0])+values[1][i]*fraction[0])*(1-fraction[1])+
        (values[2][i]*(1-fraction[0])+values[3][i]*fraction[0])*fraction[1])
}

function referenceColor(value) {
    const ramp=[0x3288bd,0x66c2a5,0xabdda4,0xe6f598,0xfee08b,0xfdae61,0xf46d43,0xd53e4f]
    const position=Math.max(0,Math.min(value*8,7)),a=Math.floor(position),b=Math.min(a+1,7)
    return [16,8,0].map(shift=>((ramp[a]>>shift)&255)*(1-position+a)+((ramp[b]>>shift)&255)*(position-a))
}
