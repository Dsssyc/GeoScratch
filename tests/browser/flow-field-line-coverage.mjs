import assert from 'node:assert/strict'
import {readFile,mkdir,writeFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import {chromium} from 'playwright'

const source=await readFile(new URL('../../examples/flowField/shaders/particle-render.wgsl',import.meta.url),'utf8')
const reference=await readFile(new URL('../fixtures/flow-particle-line-reference.wgsl',import.meta.url),'utf8')
const output=process.env.FLOW_LINE_COVERAGE_OUTPUT??'/tmp/geoscratch-flow-line-coverage'
await mkdir(output,{recursive:true})
const server=createServer((_q,r)=>r.end('<!doctype html><title>Flow line coverage proof</title>'))
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-webgpu']})
try{
    const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`)
    const proof=await page.evaluate(async({source,reference})=>{
        const adapter=await navigator.gpu.requestAdapter(),d=await adapter.requestDevice(),errors=[]
        d.addEventListener('uncapturederror',e=>errors.push(e.error.message));d.pushErrorScope('validation')
        const blend={color:{operation:'add',srcFactor:'src-alpha',dstFactor:'one-minus-src-alpha'},alpha:{operation:'add',srcFactor:'one',dstFactor:'one-minus-src-alpha'}}
        const pipelines=[]
        for(const [i,code] of [reference,source].entries()){
            const module=d.createShaderModule({code:'const FLOW_PARTICLE_MAXIMUM_SPEED = 1.0f;\n'+code})
            pipelines.push(await d.createRenderPipelineAsync({layout:'auto',vertex:{module,entryPoint:'vParticle'},fragment:{module,entryPoint:'fParticle',targets:[{format:'rgba8unorm',blend}]},primitive:{topology:i?'triangle-strip':'line-list'},...(i?{}:{depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'less'}})}))
        }
        const record=d.createBuffer({size:112,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST}),view=d.createBuffer({size:112,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),raster=d.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST})
        const viewBytes=new Float32Array(28);viewBytes.set([2/64,0,0,0,0,2/64,0,0,0,0,1,0,-1,1,.5,1]);viewBytes[22]=1/65536;d.queue.writeBuffer(view,0,viewBytes)
        const groups=pipelines.map((p,i)=>[d.createBindGroup({layout:p.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:record}}]}),d.createBindGroup({layout:p.getBindGroupLayout(1),entries:[{binding:0,resource:{buffer:view}}]}),...(i?[d.createBindGroup({layout:p.getBindGroupLayout(2),entries:[{binding:0,resource:{buffer:raster}}]})]:[])])
        async function render(size,angle,phase,segments=1,length=36,active=true,analytic=true,options={}){
            const target=d.createTexture({size:[size,size],format:'rgba8unorm',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC}),depth=d.createTexture({size:[size,size],format:'depth32float',usage:GPUTextureUsage.RENDER_ATTACHMENT})
            const targetView=target.createView(),depthView=depth.createView(),scale=size/64
            viewBytes.set(options.perspective?[.01,0,.04,.04,0,.01,0,0,0,0,0,0,-.2,.1025,-.6,-.5]:[2/64,0,0,0,0,2/64,0,0,0,0,1,0,-1,1,.5,1]);d.queue.writeBuffer(view,0,viewBytes)
            d.queue.writeBuffer(raster,0,new Float32Array([size,size,.5*scale,.5]))
            const count=options.overlapShift===undefined?1:2
            for(let step=0;step<segments;step++){
                const bytes=new ArrayBuffer(count*56),v=new DataView(bytes),a=angle*Math.PI/180
                for(let instance=0;instance<count;instance++){
                    const slot=options.reverse?count-1-instance:instance
                    for(const [offset,t] of [[0,(step+1)/segments],[16,step/segments]]){
                        v.setUint32(instance*56+offset,Math.round((10+phase+length*t*Math.cos(a))*65536),true)
                        v.setUint32(instance*56+offset+8,Math.round((10+phase+length*t*Math.sin(a)+slot*(options.overlapShift??0))*65536),true)
                    }
                    v.setFloat32(instance*56+32,1,true);v.setUint32(instance*56+52,Number(active),true)
                }
                d.queue.writeBuffer(record,0,bytes)
                const e=d.createCommandEncoder(),p=e.beginRenderPass({colorAttachments:[{view:targetView,loadOp:step?'load':'clear',storeOp:'store',clearValue:[0,0,0,0]}],...(analytic?{}:{depthStencilAttachment:{view:depthView,depthLoadOp:'clear',depthStoreOp:'discard',depthClearValue:1}})})
                const i=Number(analytic);p.setPipeline(pipelines[i]);groups[i].forEach((g,j)=>p.setBindGroup(j,g));p.draw(analytic?4:2,count);p.end();d.queue.submit([e.finish()])
            }
            const out=d.createBuffer({size:size*size*4,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST}),e=d.createCommandEncoder()
            e.copyTextureToBuffer({texture:target},{buffer:out,bytesPerRow:size*4},[size,size]);d.queue.submit([e.finish()]);await out.mapAsync(GPUMapMode.READ)
            const bytes=new Uint8Array(out.getMappedRange()).slice(),levels=new Set(),bounds=[size,size,-1,-1];let density=0,covered=0,soft=0
            for(let i=3;i<bytes.length;i+=4){const alpha=bytes[i];if(alpha){covered++;levels.add(alpha);density-=Math.log(1-alpha/255);if(alpha<127)soft++;const p=(i-3)/4,x=p%size,y=Math.floor(p/size);bounds[0]=Math.min(bounds[0],x);bounds[1]=Math.min(bounds[1],y);bounds[2]=Math.max(bounds[2],x);bounds[3]=Math.max(bounds[3],y)}}
            out.unmap();out.destroy();target.destroy();depth.destroy()
            return {size,angle,phase,segments,length,active,analytic,covered,soft,bounds,levels:[...levels].sort((a,b)=>a-b),area:density/Math.log(2),bytes:[...bytes]}
        }
        const results=[],splits=[]
        for(const size of [64,128])for(const angle of [0,25,45,65,90])for(const phase of [0,.25,.5,.75]){
            const r=await render(size,angle,phase);const {bytes,...facts}=r;results.push(facts)
            if(size===128&&phase===.25){const split=await render(size,angle,phase,4);splits.push({angle,maxByteDifference:Math.max(...r.bytes.map((b,i)=>Math.abs(b-split.bytes[i])))})}
        }
        const tiny=await render(128,25,.25,1,.125),dormant=await render(128,25,.25,1,36,false),zero=await render(128,25,.25,1,0)
        const old=await render(128,25,.25,1,36,true,false)
        const forward=await render(128,0,.75-1/65536,1,36,true,true,{overlapShift:-.5+1/65536})
        const reverse=await render(128,0,.75-1/65536,1,36,true,true,{overlapShift:-.5+1/65536,reverse:true})
        const overlap={maxByteDifference:Math.max(...forward.bytes.map((v,i)=>Math.abs(v-reverse.bytes[i]))),alpha:[forward.bytes[(20*128+40)*4+3],reverse.bytes[(20*128+40)*4+3]]}
        const near=await render(128,0,.25,1,36,true,true,{perspective:true}),nearReference=await render(128,0,.25,1,36,true,false,{perspective:true})
        const validation=await d.popErrorScope();if(validation)errors.push(validation.message)
        for(const b of [record,view,raster])b.destroy();d.destroy()
        return {results,splits,overlap,near:{bounds:near.bounds,covered:near.covered,referenceBounds:nearReference.bounds,referenceCovered:nearReference.covered},tiny:{covered:tiny.covered,area:tiny.area},dormant:dormant.covered,zero:zero.covered,reference:{covered:old.covered,soft:old.soft,levels:old.levels},errors}
    },{source,reference})
    await writeFile(`${output}/report.json`,JSON.stringify(proof,null,2))
    assert.deepEqual(proof.errors,[])
    assert.equal(proof.dormant,0);assert.equal(proof.zero,0);assert.ok(proof.tiny.covered>0)
    assert.equal(proof.reference.soft,0,'The frozen native line has hard coverage')
    assert.ok(proof.overlap.maxByteDifference<=1&&proof.overlap.alpha.every(a=>a>=127),'A nearly transparent first halo cannot occlude the second line')
    assert.ok(proof.near.covered>0&&proof.near.referenceCovered>0,'Camera-plane crossings retain the visible segment')
    assert.ok(proof.near.bounds.every((v,i)=>Math.abs(v-proof.near.referenceBounds[i])<=1),'Homogeneous clipping agrees with native line clipping bounds')
    for(const r of proof.results){
        assert.ok(r.soft>0,'Analytic lines retain partial pixel coverage')
        assert.ok(r.levels.at(-1)<=128,'Coverage cannot exceed reference opacity')
        const expected=36*.5*(r.size/64)**2
        assert.ok(Math.abs(r.area/expected-1)<.15,`Bound line energy across angle, phase and DPR: ${JSON.stringify(r)}`)
    }
    assert.ok(proof.splits.every(r=>r.maxByteDifference<=3),'Segment subdivision preserves coverage within rgba8 rounding')
    console.log(JSON.stringify({status:'passed',cases:proof.results.length,splits:proof.splits,overlap:proof.overlap,near:proof.near,tiny:proof.tiny,reference:proof.reference,output}))
}finally{await browser.close();await new Promise(r=>server.close(r))}
