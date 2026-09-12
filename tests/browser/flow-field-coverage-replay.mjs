import assert from 'node:assert/strict'
import {writeFile,mkdir} from 'node:fs/promises'
import {execFileSync} from 'node:child_process'
import {launchSecondaryBrowser} from '../experiments/terrain-cover-placement/secondary-browser.mjs'
import {chromium} from 'playwright'

// Replay one paused real frame with identical resources. The direct variant
// removes only the certified-one shortcut, retaining complete A semantics.
const viewport={width:1760,height:880},output=process.env.FLOW_COVERAGE_OUTPUT??'output/flow-field-coverage-replay'
await mkdir(output,{recursive:true})
const managed=process.env.FLOW_COVERAGE_NATIVE==='1'?await launchSecondaryBrowser({deviceScaleFactor:2,viewport}):undefined
const browser=managed?.browser??await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-webgpu']})
const context=await browser.newContext({deviceScaleFactor:2,viewport}),page=await context.newPage(),report={head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()}
page.on('pageerror',e=>console.log('PAGE_ERROR '+e.message))
page.on('console',m=>{if(m.type()==='error')console.log('PAGE_CONSOLE '+m.text())})
try{
    await page.addInitScript(()=>{
        const a=window.__coverageReplay={errors:[],last:null},shaders=new WeakMap(),pipelines=new WeakMap(),views=new WeakMap()
        const request=GPUAdapter.prototype.requestDevice
        GPUAdapter.prototype.requestDevice=async function(desc={}){
            const d=await request.call(this,{...desc,requiredFeatures:[...new Set([...(desc.requiredFeatures??[]),'timestamp-query'])]});a.device=d
            d.addEventListener('uncapturederror',e=>a.errors.push(e.error.message))
            const texture=d.createTexture.bind(d);d.createTexture=desc=>{const t=texture({...desc,usage:desc.usage|GPUTextureUsage.COPY_SRC});const view=t.createView.bind(t);t.createView=desc=>{const v=view(desc);views.set(v,t);return v};return t}
            const shader=d.createShaderModule.bind(d);d.createShaderModule=desc=>{const m=shader(desc);shaders.set(m,desc);return m}
            const pipeline=d.createRenderPipelineAsync.bind(d);d.createRenderPipelineAsync=async desc=>{const p=await pipeline(desc);pipelines.set(p,desc);return p}
            const create=d.createCommandEncoder.bind(d)
            d.createCommandEncoder=desc=>{const e=create(desc),begin=e.beginRenderPass.bind(e);e.beginRenderPass=desc=>{
                const p=begin(desc);if(!desc.label?.startsWith('Flow Field visible '))return p
                const record={descriptor:desc,groups:[]};a.last=record
                const set=p.setPipeline.bind(p),bind=p.setBindGroup.bind(p)
                p.setPipeline=v=>{record.pipeline=v;record.pipelineDescriptor=pipelines.get(v);record.code=shaders.get(record.pipelineDescriptor.fragment.module).code;return set(v)}
                p.setBindGroup=(i,g,...args)=>{record.groups[i]=g;return bind(i,g,...args)}
                record.texture=views.get(desc.colorAttachments[0].view);return p
            };return e}
            return d
        }
    })
    await page.goto('http://127.0.0.1:5173/flowField/?proof=1&trailQuality=native&rate=0.000000001&zoom=9')
    await page.waitForFunction(()=>document.body.dataset.status==='error'||window.__FLOW_FIELD_PROOF__?.facts()?.lastFrame.presentationReady,undefined,{timeout:90000})
    assert.notEqual(await page.locator('body').getAttribute('data-status'),'error',await page.locator('#GPUFrame').getAttribute('data-error'))
    await page.evaluate(()=>window.__FLOW_FIELD_PROOF__.seek(.277))
    const anchor=await page.evaluate(()=>window.__FLOW_FIELD_PROOF__.facts().renderer.particles.simulatedReferenceSteps)
    await page.waitForFunction(anchor=>{const f=window.__FLOW_FIELD_PROOF__.facts();return f.lastFrame.presentationReady&&f.workers.activeTaskCount===0&&f.renderer.particles.simulatedReferenceSteps>anchor+180},anchor,{timeout:90000})
    await page.evaluate(()=>window.__FLOW_FIELD_PROOF__.pauseAndDrain())
    report.replay=await page.evaluate(async()=>{
        const a=window.__coverageReplay,c=a.last,d=a.device,owned=[],own=v=>(owned.push(v),v),buffer=(size,usage)=>own(d.createBuffer({size,usage})),w=c.texture.width,h=c.texture.height
        const facts=()=>{const f=window.__FLOW_FIELD_PROOF__.facts();return {temporal:f.lastFrame.temporal,observed:f.frames.observedFrameCount,steps:f.renderer.particles.encodedSteps,workers:f.workers.activeTaskCount,surface:f.renderer.presentationSize,history:f.renderer.history.size}}
        const before=facts()
        const read=async t=>{const stride=Math.ceil(w*4/256)*256,b=buffer(stride*h,GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST),e=d.createCommandEncoder();e.copyTextureToBuffer({texture:t},{buffer:b,bytesPerRow:stride},[w,h]);d.queue.submit([e.finish()]);await b.mapAsync(GPUMapMode.READ);const source=new Uint8Array(b.getMappedRange()),out=new Uint8Array(w*h*4);for(let y=0;y<h;y++)out.set(source.subarray(y*stride,y*stride+w*4),y*w*4);b.unmap();return out}
        const gold=await read(c.texture),hash=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join(''),goldHash=await hash(gold)
        const target=own(d.createTexture({size:[w,h],format:'rgba8unorm',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC})),view=target.createView()
        const marker='if (FlowCoverageCached_fullSupport(position, level, kill)) { return 1.0; }'
        if(c.code.split(marker).length!==2)throw new Error('Full-support shortcut changed')
        const code=c.code.replace(marker,''),module=d.createShaderModule({code}),desc=c.pipelineDescriptor
        const other=await d.createRenderPipelineAsync({...desc,vertex:{...desc.vertex,module},fragment:{...desc.fragment,module}})
        const queries=own(d.createQuerySet({type:'timestamp',count:2})),resolved=buffer(16,GPUBufferUsage.QUERY_RESOLVE|GPUBufferUsage.COPY_SRC),times=buffer(16,GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ)
        const variants=[{name:'cached',pipeline:c.pipeline,samples:[]},{name:'direct',pipeline:other,samples:[]}]
        async function run(v){const e=d.createCommandEncoder(),p=e.beginRenderPass({colorAttachments:[{view,loadOp:'clear',storeOp:'store',clearValue:[0,0,0,0]}],timestampWrites:{querySet:queries,beginningOfPassWriteIndex:0,endOfPassWriteIndex:1}});p.setPipeline(v.pipeline);c.groups.forEach((g,i)=>p.setBindGroup(i,g));p.draw(4);p.end();e.resolveQuerySet(queries,0,2,resolved,0);e.copyBufferToBuffer(resolved,0,times,0,16);d.queue.submit([e.finish()]);await times.mapAsync(GPUMapMode.READ);const t=new BigUint64Array(times.getMappedRange()),ms=Number(t[1]-t[0])/1e6;times.unmap();return ms}
        await run(variants[0]);const replayHash=await hash(await read(target));if(replayHash!==goldHash)throw new Error('Original replay does not match last visible texture')
        await run(variants[1]);const directHash=await hash(await read(target))
        if(directHash!==goldHash)throw new Error('Cached presentation differs from complete direct coverage')
        for(let round=0;round<7;round++)for(const i of [0,1,1,0]){const ms=await run(variants[i]);if(round)variants[i].samples.push(ms)}
        await run(variants[0]);const finalReplayHash=await hash(await read(target)),after=facts()
        if(finalReplayHash!==goldHash||JSON.stringify(before)!==JSON.stringify(after))throw new Error('Frozen replay changed during timing')
        const result={width:w,height:h,before,after,shaderSha256:await hash(new TextEncoder().encode(c.code)),goldHash,replayHash,directHash,finalReplayHash,variants:variants.map(({pipeline,...v})=>({...v,meanMs:v.samples.reduce((s,x)=>s+x,0)/v.samples.length,p50Ms:[...v.samples].sort((x,y)=>x-y)[Math.floor(v.samples.length/2)]})),errors:a.errors}
        for(const x of owned)x.destroy();return result
    })
    assert.deepEqual(report.replay.errors,[]);console.log(JSON.stringify(report.replay))
    await page.evaluate(()=>window.__FLOW_FIELD_PROOF__.dispose());await managed?.verifyPlacement();report.status='passed'
}catch(error){report.error=String(error);report.failure=await page.evaluate(()=>({status:document.body.dataset.status,error:document.querySelector('#GPUFrame')?.dataset.error,gpuErrors:window.__coverageReplay?.errors})).catch(()=>undefined);throw error}finally{await browser.close();report.display=managed?.evidence??{mode:'headless',closed:true};await writeFile(`${output}/report.json`,JSON.stringify(report,null,2))}
