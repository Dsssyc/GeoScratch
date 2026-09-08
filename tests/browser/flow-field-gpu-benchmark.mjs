import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { execFileSync } from 'node:child_process'

// Isolated headless native-GPU measurement. Run without other benchmark workloads.
// Timestamp pass durations are not system utilization or the frame critical path.
const head = execFileSync('git',['rev-parse','--short','HEAD'],{encoding:'utf8'}).trim()
const modified = execFileSync('git',['diff','--name-only','HEAD'],{encoding:'utf8'}).trim().split('\n').filter(Boolean)
const dpr = Number(process.env.FLOW_GPU_BENCH_DPR ?? 2)
assert.ok(Number.isFinite(dpr) && dpr >= 1 && dpr <= 3, 'DPR must be within [1, 3]')
const browser = await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-webgpu']})

function installAudit() {
    const audit = window.__gpuAudit = { enabled:false, records:[], errors:[], submissions:0, sampled:0, support:[], encoders:0, pending:new Set() }
    const request = GPUAdapter.prototype.requestDevice
    GPUAdapter.prototype.requestDevice = async function(descriptor={}) {
        const features = [...(descriptor.requiredFeatures ?? [])]
        if (this.features.has('timestamp-query') && !features.includes('timestamp-query')) features.push('timestamp-query')
        const device = await request.call(this,{...descriptor,requiredFeatures:features})
        audit.support.push(device.features.has('timestamp-query'))
        if (!device.features.has('timestamp-query')) return device
        device.addEventListener('uncapturederror',e=>audit.errors.push(e.error.message))
        const commandRecords = new WeakMap()
        const createEncoder = device.createCommandEncoder.bind(device)
        let sequence=0x6d2b79f5
        device.createCommandEncoder = descriptor => {
            const encoder=createEncoder(descriptor)
            if (!audit.enabled) return encoder
            audit.encoders++
            // Pseudorandom admission avoids aliasing a fixed number of encoders/frame.
            sequence ^= sequence << 13; sequence ^= sequence >>> 17; sequence ^= sequence << 5
            if ((sequence >>> 0) % 7 !== 0 || audit.records.length >= 2048 || audit.pending.size >= 8) return encoder
            const querySet=device.createQuerySet({type:'timestamp',count:128})
            const resolved=device.createBuffer({size:1024,usage:GPUBufferUsage.QUERY_RESOLVE|GPUBufferUsage.COPY_SRC})
            const read=device.createBuffer({size:1024,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST})
            const passes=[]
            for (const method of ['beginComputePass','beginRenderPass']) {
                const begin=encoder[method].bind(encoder)
                encoder[method]=(desc={})=>{
                    if(desc.timestampWrites || passes.length>=64) return begin(desc)
                    const index=passes.length*2
                    const pass=begin({...desc,timestampWrites:{querySet,beginningOfPassWriteIndex:index,endOfPassWriteIndex:index+1}})
                    const info={label:desc.label??method,pipelines:[],commands:[]}
                    passes.push(info)
                    const set=pass.setPipeline.bind(pass)
                    pass.setPipeline=p=>{info.pipelines.push(p.label);return set(p)}
                    for(const operation of ['draw','drawIndexed','drawIndirect','drawIndexedIndirect','dispatchWorkgroups','dispatchWorkgroupsIndirect']) {
                        if(!pass[operation])continue
                        const original=pass[operation].bind(pass)
                        pass[operation]=(...args)=>{info.commands.push([operation,...args.map(x=>typeof x==='number'?x:'buffer')]);return original(...args)}
                    }
                    return pass
                }
            }
            const finish=encoder.finish.bind(encoder)
            encoder.finish=desc=>{
                if(passes.length) {
                    encoder.resolveQuerySet(querySet,0,passes.length*2,resolved,0)
                    encoder.copyBufferToBuffer(resolved,0,read,0,passes.length*16)
                }
                const buffer=finish(desc)
                commandRecords.set(buffer,{querySet,resolved,read,passes})
                return buffer
            }
            return encoder
        }
        const submit=device.queue.submit.bind(device.queue)
        device.queue.submit=buffers=>{
            const list=[...buffers]
            const answer=submit(list)
            if(audit.enabled)audit.submissions++
            for(const buffer of list) {
                const r=commandRecords.get(buffer)
                if(!r)continue
                commandRecords.delete(buffer)
                const destroy=()=>{r.read.destroy();r.resolved.destroy();r.querySet.destroy()}
                if(!r.passes.length){destroy();continue}
                audit.sampled++
                const mapping=r.read.mapAsync(GPUMapMode.READ).then(()=>{
                    const times=new BigUint64Array(r.read.getMappedRange())
                    const measured=r.passes.map((p,i)=>({...p,ms:Number(times[i*2+1]-times[i*2])/1e6}))
                    const visible=r.passes.findIndex(p=>p.label.startsWith('Flow Field visible '))
                    const present=r.passes.findIndex(p=>p.label==='Flow Field history presentation')
                    // Pass intervals may overlap on tile-based GPUs. Measure the
                    // contiguous display interval instead of adding pass durations.
                    const displayMs=visible<0?undefined:Number(times[(present<0?visible:present)*2+1]-times[visible*2])/1e6
                    const overlapCount=r.passes.reduce((n,_p,i)=>n+Number(i>0&&times[i*2]<times[(i-1)*2+1]),0)
                    audit.records.push({passes:measured,displayMs,overlapCount})
                    r.read.unmap();destroy()
                }).catch(error=>{audit.errors.push(String(error));destroy()}).finally(()=>audit.pending.delete(mapping))
                audit.pending.add(mapping)
            }
            return answer
        }
        return device
    }
}

try {
    for(const variant of (process.env.FLOW_GPU_BENCH_VARIANTS??'layer,field-C').split(',')) {
        assert.ok(['layer','field-C','field-A','field-C-original'].includes(variant),'Unknown benchmark variant')
        const reference=variant==='layer'
        const page=await browser.newPage({viewport:{width:1512,height:861},deviceScaleFactor:dpr})
        const errors=[]
        page.on('pageerror',e=>errors.push(e.message))
        page.on('console',m=>{if(m.type()==='error')errors.push(m.text())})
        await page.addInitScript(installAudit)
        if(variant==='field-C-original') {
            const original=execFileSync('git',['show','9b3a4e1:examples/flowField/shaders/center-cache-sample.wgsl'],{encoding:'utf8'})
            await page.route('**/flowField/shaders/center-cache-sample.wgsl*',route=>
                route.fulfill({status:200,contentType:'text/javascript',body:`export default ${JSON.stringify(original)};`}))
        }
        if(reference)await page.route('**/flowLayer/flow-layer.ts*',async route=>{
            const response=await route.fetch(),body=await response.text()
            assert.ok(body.includes('advanceFieldState(graph, state);'))
            await route.fulfill({response,body:body.replace('advanceFieldState(graph, state);','')
                .replace('progressRate: state.progress / (FRAMES_PER_FIELD - 1)','progressRate: 0.277')})
        })
        await page.goto(`http://127.0.0.1:5173/${reference?'flowLayer':'flowField'}/?proof=1&rate=0.000000001&zoom=9`)
        await page.waitForFunction(reference=>document.body.dataset.status==='error'||document.body.dataset.status==='ready'&&(reference
            ?window.__FLOW_LAYER_PROOF__?.facts()?.observedFrames>120
            :window.__FLOW_FIELD_PROOF__?.facts()?.lastFrame.presentationReady),reference,{timeout:90000})
        assert.equal(await page.locator('body').getAttribute('data-status'),'ready',errors.join('\n'))
        if(!reference){
            const before=await page.evaluate(variant=>{
                const p=window.__FLOW_FIELD_PROOF__,n=p.facts().renderer.particles.encodedSteps
                p.seek(.277);p.setPresentation({view:'particles',sample:'interpolated',trails:true,contour:false,
                    boundary:variant.startsWith('field-A')?'hard':'sdf-center-linear',sdfFeatherTexels:.25});return n
            },variant)
            await page.waitForFunction(before=>{const f=window.__FLOW_FIELD_PROOF__.facts();return f.lastFrame.presentationReady&&f.workers.activeTaskCount===0&&f.renderer.particles.encodedSteps>before+150},before,{timeout:90000})
        }
        const result=await page.evaluate(async reference=>{
            const facts=()=>{const f=reference?window.__FLOW_LAYER_PROOF__.facts():window.__FLOW_FIELD_PROOF__.facts();return reference?{frames:f.observedFrames}:{frames:f.renderer.particles.encodedSteps,reference:f.renderer.particles.simulatedReferenceSteps,cache:f.renderer.history.centerCache,ready:f.lastFrame.presentationReady,workers:f.workers.activeTaskCount,viewDemand:f.renderer.viewDemand}}
            const before=facts(),start=performance.now();window.__gpuAudit.enabled=true
            await new Promise(resolve=>setTimeout(resolve,7000))
            window.__gpuAudit.enabled=false;const end=performance.now(),after=facts()
            await Promise.all([...window.__gpuAudit.pending])
            const audit=window.__gpuAudit,groups={}
            for(const r of audit.records)for(const p of r.passes){const name=(p.label+' | '+p.pipelines.join(' + ')).replace(/ \[scratch:[^\]]+\]/g,'');(groups[name]??=[]).push(p)}
            const stats=values=>{const a=[...values].sort((a,b)=>a-b);return {mean:a.reduce((s,x)=>s+x,0)/a.length,p50:a[Math.floor(a.length*.5)],p95:a[Math.floor(a.length*.95)],n:a.length}}
            return {fps:(after.frames-before.frames)*1000/(end-start),before,after,support:audit.support,errors:audit.errors,
                encoders:audit.encoders,submissions:audit.submissions,sampledEncoderCount:audit.records.length,
                overlappingPassPairs:audit.records.reduce((n,r)=>n+r.overlapCount,0),
                displaySpanMs:reference?undefined:stats(audit.records.filter(r=>r.displayMs!==undefined).map(r=>r.displayMs)),
                groups:Object.entries(groups).map(([name,list])=>({name,...stats(list.map(p=>p.ms)),commands:list[0].commands}))}
        },reference)
        assert.deepEqual(result.errors,[])
        assert.deepEqual(errors,[])
        assert.ok(result.support.length>0&&result.support.every(Boolean),'Native timestamp-query is required')
        assert.ok(result.sampledEncoderCount >= 20, 'Collect enough native timing samples')
        if(!reference)assert.ok(result.before.ready&&result.after.ready&&result.before.workers===0&&result.after.workers===0,'Measure resident steady state')
        console.log(JSON.stringify({head,modified,variant,zoom:9,dpr,...result,pageErrors:errors}))
        const cleanup=await page.evaluate(reference=>reference?window.__FLOW_LAYER_PROOF__.dispose():window.__FLOW_FIELD_PROOF__.dispose(),reference)
        if(!reference){assert.deepEqual(cleanup.cleanupFailures,[]);assert.equal(cleanup.pendingObservationsAfter,0)}
        await page.close()
    }
} finally {await browser.close()}
