import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import {
    WebMercatorQuad, tileMatrixCoverage, webMercatorVirtualRasterField,
    prepareWebMercatorVirtualRasterSampler, webMercatorVirtualRasterWgslModule,
} from 'geoscratch/geo'

const cases = [
    {id:'A', matrices:[0,1,2], bounds:[-60,-40,60,40], format:'rg32float', channels:2},
    {id:'B', matrices:[0,3], bounds:[45,-30,80,30], format:'rg32float', channels:2, noData:-777, scale:2, offset:-3},
    {id:'C', matrices:[0,1], bounds:[-120,-40,-60,40], format:'r8unorm', channels:1, noData:255, scale:2, offset:-4},
]
const options={namespace:'Probe',addressNamespace:'Address',group:0,pageTableBinding:0,atlasBinding:1}
const kernel=`
struct Query { position:AddressFixedPosition, level:u32, padding:vec3u, }
struct Result { value:vec4f, facts:vec4u, }
@group(1) @binding(0) var<storage,read> queries:array<Query>;
@group(1) @binding(1) var<storage,read_write> results:array<Result>;
@compute @workgroup_size(64) fn probe(@builtin(global_invocation_id) id:vec3u) {
    if(id.x>=arrayLength(&queries)){return;}
    let q=queries[id.x];let sample=Probe_sample_compute(q.position,q.level);
    results[id.x]=Result(sample.value,vec4u(sample.status,sample.requested_level,sample.resolved_level,0u));
}`
const fixtures=cases.map(spec=>{
    const [west,south,east,north]=spec.bounds
    const coverage=tileMatrixCoverage({tileMatrixSet:WebMercatorQuad,limits:spec.matrices.map(matrix=>{
        const matrixId=String(matrix),a=WebMercatorQuad.tileFromLonLat([west,north],matrixId),b=WebMercatorQuad.tileFromLonLat([east,south],matrixId)
        return {matrixId,minTileCol:a.tileCol,maxTileCol:b.tileCol,minTileRow:a.tileRow,maxTileRow:b.tileRow}
    })})
    const model=webMercatorVirtualRasterField({id:spec.id,addressSpaceId:spec.id,sourceRevision:'1',coverage,geographicBounds:spec.bounds,
        coordinateBits:40,fieldKind:spec.channels===1?'scalar':'vector',channels:spec.channels,sampleType:spec.format==='r8unorm'?'unorm8':'float32',gpuFormat:spec.format,
        interpolation:'linear',...(spec.noData===undefined?{}:{noData:spec.noData}),scale:spec.scale??1,offset:spec.offset??0})
    const pages=model.addressSpace.pages(),columns=Math.ceil(Math.sqrt(pages.length)),rows=Math.ceil(pages.length/columns)
    const width=columns*256,height=rows*256,slot=page=>(model.addressSpace.tableIndex(page)+1)%pages.length
    const pixels=spec.format==='r8unorm'?new Uint8Array(width*height):new Float32Array(width*height*spec.channels)
    const table=new Uint32Array(pages.length*8)
    for(const page of pages){
        const s=slot(page);table.set([s%columns,Math.floor(s/columns),page.level,1,0,0,page.level,1],model.addressSpace.tableIndex(page)*8)
        for(let y=0;y<256;y++)for(let x=0;x<256;x++){
            const base=((Math.floor(s/columns)*256+y)*width+s%columns*256+x)*spec.channels
            for(let c=0;c<spec.channels;c++)pixels[base+c]=(x===128&&y===128&&spec.noData!==undefined)?spec.noData:
                spec.format==='r8unorm'?(x+y+page.level*13)%200:1+x/256-y/512+page.level*4+c/2
        }
    }
    const points=[]
    for(const page of pages)for(const [x,y] of [[.25,.75],[127.5,128.5],[128.25,128.25],[255.75,128.25],[255.5,255.5]]){
        const matrix=Number(page.tile.matrixId),shift=40-matrix-8
        const fixed=model.addressCodec.fromWorldQuanta([BigInt(Math.round((page.coordinates[0]*256+x)*2**shift)),BigInt(Math.round((page.coordinates[1]*256+y)*2**shift))])
        points.push({limbs:fixed.fixed.limbs.flatMap(axis=>[axis.low,axis.high]),level:page.level})
    }
    // Query's vec3 padding starts at byte 32; the whole structure has 48-byte stride.
    const queries=new Uint32Array(points.length*12)
    points.forEach((p,i)=>{queries.set(p.limbs,i*12);queries[i*12+4]=p.level})
    const scenarios=[{name:'resident',table:[...table]}]
    for(const status of [0,4,2]){
        const changed=table.slice(),fine=pages.find(p=>p.level===0),parent=model.addressSpace.parent(fine)
        const base=model.addressSpace.tableIndex(fine)*8
        if(status===2&&parent){const s=slot(parent);changed.set([s%columns,Math.floor(s/columns),parent.level,2,0,0,0,1],base)}
        else changed[base+3]=status===2?0:status
        scenarios.push({name:'status-'+status,table:[...changed]})
    }
    const prepared=prepareWebMercatorVirtualRasterSampler(model)
    return {id:spec.id,reference:webMercatorVirtualRasterWgslModule(model,options).code+kernel,
        dynamic:webMercatorVirtualRasterWgslModule(model,{...options,metadataBinding:2}).code+kernel,
        metadata:[...prepared.pack()],queries:[...queries],count:points.length,width,height,format:spec.format,
        bytesPerPixel:spec.channels*(spec.format==='r8unorm'?1:4),pixels:[...new Uint8Array(pixels.buffer)],scenarios}
})
assert(fixtures.every(f=>f.dynamic===fixtures[0].dynamic),'Source interpretation leaked into the shader')
const server=createServer((_req,res)=>res.end('<!doctype html><title>Raster sampler metadata proof</title>'))
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
let browser
try{
    browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-webgpu']})
    const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`)
    const result=await page.evaluate(async fixtures=>{
        const adapter=await navigator.gpu.requestAdapter();if(!adapter)throw new Error('WebGPU unavailable')
        const device=await adapter.requestDevice(),owned=[],errors=[],evidence=[]
        device.addEventListener('uncapturederror',event=>errors.push(event.error.message));device.pushErrorScope('validation')
        const buffer=(data,usage)=>{const b=device.createBuffer({size:data.byteLength,usage:usage|GPUBufferUsage.COPY_DST});owned.push(b);device.queue.writeBuffer(b,0,data);return b}
        try{
            const visibility=GPUShaderStage.COMPUTE
            const bindings=device.createBindGroupLayout({entries:[
                {binding:0,visibility,buffer:{type:'read-only-storage'}},{binding:1,visibility,texture:{sampleType:'unfilterable-float'}},
                {binding:2,visibility,buffer:{type:'uniform'}}]})
            const outputs=device.createBindGroupLayout({entries:[{binding:0,visibility,buffer:{type:'read-only-storage'}},{binding:1,visibility,buffer:{type:'storage'}}]})
            const layout=device.createPipelineLayout({bindGroupLayouts:[bindings,outputs]})
            let dynamicPipelineCount=0
            const pipeline=async code=>{
                const module=device.createShaderModule({code}),errors=(await module.getCompilationInfo()).messages.filter(m=>m.type==='error')
                if(errors.length)throw new Error(errors.map(e=>e.message).join('\n'))
                return device.createComputePipelineAsync({layout,compute:{module,entryPoint:'probe'}})
            }
            const dynamic=await pipeline(fixtures[0].dynamic);dynamicPipelineCount++
            const bundles=[]
            for(const f of fixtures){
                const texture=device.createTexture({size:[f.width,f.height],format:f.format,usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});owned.push(texture)
                device.queue.writeTexture({texture},new Uint8Array(f.pixels),{bytesPerRow:f.width*f.bytesPerPixel},[f.width,f.height])
                const table=buffer(new Uint32Array(f.scenarios[0].table),GPUBufferUsage.STORAGE),metadata=buffer(new Uint8Array(f.metadata),GPUBufferUsage.UNIFORM)
                const input=buffer(new Uint32Array(f.queries),GPUBufferUsage.STORAGE),output=buffer(new Uint8Array(f.count*32),GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC)
                const bind=device.createBindGroup({layout:bindings,entries:[{binding:0,resource:{buffer:table}},{binding:1,resource:texture.createView()},{binding:2,resource:{buffer:metadata}}]})
                const io=device.createBindGroup({layout:outputs,entries:[{binding:0,resource:{buffer:input}},{binding:1,resource:{buffer:output}}]})
                bundles.push({f,table,metadata,output,bind,io,reference:await pipeline(f.reference)})
            }
            // Reuse A's original resources after other coverages and decoding configurations.
            for(const i of [0,1,2,0]){
                const b=bundles[i],f=b.f
                for(const scenario of f.scenarios){
                    device.queue.writeBuffer(b.table,0,new Uint32Array(scenario.table))
                    const read=device.createBuffer({size:f.count*64,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});owned.push(read)
                    const e=device.createCommandEncoder()
                    for(const [index,p] of [b.reference,dynamic].entries()){
                        const pass=e.beginComputePass();pass.setPipeline(p);pass.setBindGroup(0,b.bind);pass.setBindGroup(1,b.io);pass.dispatchWorkgroups(Math.ceil(f.count/64));pass.end()
                        e.copyBufferToBuffer(b.output,0,read,index*f.count*32,f.count*32)
                    }
                    device.queue.submit([e.finish()]);await read.mapAsync(GPUMapMode.READ)
                    const words=new Uint32Array(read.getMappedRange()),half=words.length/2
                    let mismatch=0;for(let j=0;j<half;j++)if(words[j]!==words[half+j])mismatch++
                    if(mismatch)throw new Error(`${f.id}/${scenario.name}: ${mismatch} different words`)
                    const statuses={};let fallbackSamples=0
                    for(let j=0;j<f.count;j++){const s=words[half+j*8+4];statuses[s]=(statuses[s]??0)+1;if(words[half+j*8+6]>words[half+j*8+5])fallbackSamples++}
                    if(scenario.name==='status-2'&&fallbackSamples===0)throw new Error('Fallback was not exercised')
                    evidence.push({source:f.id,scenario:scenario.name,samples:f.count,mismatch,statuses,fallbackSamples});read.unmap()
                }
            }
            await device.queue.onSubmittedWorkDone();const error=await device.popErrorScope();if(error)throw new Error(error.message)
            if(errors.length)throw new Error(errors.join('\n'))
            return {dynamicPipelineCount,sourceOrder:['A','B','C','A'],evidence,errors}
        }finally{for(const resource of owned)resource.destroy();device.destroy()}
    },fixtures)
    assert.equal(result.dynamicPipelineCount,1)
    await mkdir('output/geo-raster-sampler-metadata',{recursive:true})
    await writeFile('output/geo-raster-sampler-metadata/report.json',JSON.stringify(result,null,2))
    console.log(JSON.stringify(result))
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve))}
