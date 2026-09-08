import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { chromium } from 'playwright'
import { WebMercatorQuad,tileMatrixCoverage,webMercatorVirtualRasterField } from 'geoscratch/geo'
import { temporalVelocityWgslModule } from '../../examples/flowField/temporal-velocity-raster.ts'

const read=name=>readFile(new URL(`../../examples/flowField/shaders/${name}.wgsl`,import.meta.url),'utf8')
const [wrapper,build]=await Promise.all(['temporal-velocity','center-cache-build'].map(read))
const model=webMercatorVirtualRasterField({id:'cache-lane-proof',addressSpaceId:'cache-lane-proof-space',sourceRevision:'v1',
    coverage:tileMatrixCoverage({tileMatrixSet:WebMercatorQuad,limits:[
        {matrixId:'1',minTileRow:0,maxTileRow:0,minTileCol:0,maxTileCol:1},
        {matrixId:'0',minTileRow:0,maxTileRow:0,minTileCol:0,maxTileCol:0},
    ]}),geographicBounds:[-179.9,0,179.9,85],coordinateBits:52,
    fieldKind:'vector',channels:2,sampleType:'float32',gpuFormat:'rg32float',interpolation:'linear'})
const temporal=temporalVelocityWgslModule(model,model,{group:1,currentPageTableBinding:0,currentAtlasBinding:1,
    nextPageTableBinding:2,nextAtlasBinding:3,sampleRegistration:'pixel-center',activitySupport:'nearest-texel-zero',wrapper}).code
// Independent pre-reuse full-builder oracle. It computes both bytes, never reads
// old records and derives the encoded distance from point-to-square geometry.
const previous=`
struct FlowCenterCacheConfig {level:u32,pageCount:u32,lookupCount:u32,kill:f32,}
@group(0) @binding(0) var<uniform> config:FlowCenterCacheConfig;
@group(2) @binding(0) var<storage,read> jobs:array<vec4u>;
@group(2) @binding(1) var<storage,read_write> records:array<u32>;
fn old_support(global:vec2i)->vec2u {
    var result=vec2u(32u);
    if(all(global>=vec2i(FlowVelocityCurrent_minimum_texel[config.level]))&&all(global<=vec2i(FlowVelocityCurrent_maximum_texel[config.level]))) {
        let value=FlowVelocityCurrent_load_global(global,config.level);
        if(value.status==1u&&value.resolved_level==config.level){let speed=length(value.value.xy);result.x=select(0u,1u,speed>0.0&&speed>=config.kill);}
    }
    if(all(global>=vec2i(FlowVelocityNext_minimum_texel[config.level]))&&all(global<=vec2i(FlowVelocityNext_maximum_texel[config.level]))) {
        let value=FlowVelocityNext_load_global(global,config.level);
        if(value.status==1u&&value.resolved_level==config.level){let speed=length(value.value.xy);result.y=select(0u,1u,speed>0.0&&speed>=config.kill);}
    }
    return result;
}
@compute @workgroup_size(8,8)
fn FlowCenterCache_build(@builtin(global_invocation_id) id:vec3u) {
    if(id.x>=257u||id.y>=257u||id.z>=config.pageCount){return;}
    let job=jobs[id.z];let global=vec2i(job.xy*256u+id.xy);let owner=old_support(global);
    var distanceSquared=vec2f(2.25);var unknown=vec2u(0u);
    for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){
        if(x==0&&y==0){continue;}
        let other=old_support(global+vec2i(x,y));
        unknown|=select(vec2u(0u),vec2u(64u),other==vec2u(32u));
        let delta=max(abs(vec2f(f32(x),f32(y)))-vec2f(.5),vec2f(0.0));
        distanceSquared=select(distanceSquared,min(distanceSquared,vec2f(dot(delta,delta))),(other^owner)==vec2u(1u));
    }}
    let code=select(vec2u(round(distanceSquared*4.0))|unknown|select(vec2u(0u),vec2u(16u),owner==vec2u(0u)),vec2u(32u),owner==vec2u(32u));
    records[job.z*66049u+id.y*257u+id.x]=code.x|(code.y<<8u);
}`
let countedTemporal=temporal
for(const [namespace,lane] of [['FlowVelocityCurrent','x'],['FlowVelocityNext','y']]) {
    countedTemporal=countedTemporal.replace(`fn ${namespace}_load_global(`,`fn Fixture_${namespace}_load_global(`)
    countedTemporal+=`
fn ${namespace}_load_global(p:vec2i,l:u32)->${namespace}Sample {fixtureCalls.${lane}++;return Fixture_${namespace}_load_global(p,l);}
`
}
const countedBuild=build.replace(/(flowCenterCacheOutput\[outputIndex\] = [^;]+;)/g,
    '$1\n    fixtureCounts[outputIndex]=fixtureCalls;')
const codes=[temporal+'\n'+previous,temporal+'\n'+build,countedTemporal+`
var<private> fixtureCalls:vec2u;
@group(2) @binding(2) var<storage,read_write> fixtureCounts:array<vec2u>;
`+countedBuild]
const table=new Uint32Array(model.addressSpace.pageTableEntryCount*8)
let rightEntry
const quanta=model.addressCodec.worldQuanta/512n
const position=(x,y)=>model.addressCodec.fromWorldQuanta([BigInt(x*Number(quanta)),BigInt(y*Number(quanta))])
for(const col of [0,1]) {
    const index=model.addressCodec.address(position(col*256+.5,65.5),'1').compactIndex
    table.set([1-col,0,0,1,0,0,0,0],index*8);if(col===1)rightEntry=index
}
const parent=model.addressCodec.address(position(256,65.5),'0').compactIndex
table.set([2,0,1,1,0,0,0,0],parent*8)
function source(field,missing=false) {
    const pages=table.slice();if(missing)pages[rightEntry*8+3]=0
    return {field,pages:[...pages]}
}
const a=source('a'),b=source('b'),c=source('c'),d=source('d'),unknown=source('b',true)
const scenarios=[
    {name:'lower-change',before:[a,b],after:[c,b],selectors:[0,2]},
    {name:'upper-change',before:[a,b],after:[a,c],selectors:[1,0]},
    {name:'forward-pair',before:[a,b],after:[b,c],selectors:[2,0]},
    {name:'reverse-pair',before:[a,b],after:[b,a],selectors:[2,1]},
    {name:'aliased-pair',before:[a,b],after:[b,b],selectors:[2,2]},
    {name:'previous-alias',before:[a,a],after:[a,c],selectors:[1,0]},
    {name:'retain-unknown-lower',before:[a,unknown],after:[unknown,c],selectors:[2,0]},
    {name:'retain-unknown-upper',before:[unknown,a],after:[c,unknown],selectors:[0,1]},
    {name:'both-change',before:[a,b],after:[c,d],selectors:[0,0]},
    {name:'plan-change',before:[a,b],after:[a,b],selectors:[0,0],onePage:true},
]
function wet(field,x,y) {
    if(field==='a')return (x+y)%31>2
    if(field==='b')return x%29>3&&y%37>3
    if(field==='c')return (x-y+512)%23>5
    return (x+y)%31<=2||x%29<=3
}
const assets={}
for(const field of ['a','b','c','d']) {
    const pixels=new Float32Array(768*256*2)
    for(let y=0;y<256;y++)for(let x=0;x<512;x++) {
        const atlasX=(1-Math.floor(x/256))*256+x%256
        pixels[(y*768+atlasX)*2]=wet(field,x,y)?2:0
    }
    for(let y=0;y<256;y++)for(let x=0;x<256;x++)pixels[(y*768+512+x)*2]=wet(field,x*2,y*2)?2:0
    assets[field]=Buffer.from(pixels.buffer).toString('base64')
}
const server=createServer((_request,response)=>response.end('<!doctype html><title>Flow cache endpoint reuse proof</title>'))
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
let browser
try {
    browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-webgpu']})
    const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`)
    const result=await page.evaluate(async ({codes,scenarios,assets,lookupCount,benchmark})=>{
        const adapter=await navigator.gpu.requestAdapter();if(!adapter)throw new Error('WebGPU unavailable')
        const timing=benchmark&&adapter.features.has('timestamp-query')
        const device=await adapter.requestDevice({requiredFeatures:timing?['timestamp-query']:[]}),owned=[],errors=[]
        device.addEventListener('uncapturederror',event=>errors.push(event.error.message));device.pushErrorScope('validation')
        try {
            const buffer=(bytes,usage)=>{const value=device.createBuffer({size:bytes.byteLength,usage:usage|GPUBufferUsage.COPY_DST});owned.push(value);device.queue.writeBuffer(value,0,bytes);return value}
            const visibility=GPUShaderStage.COMPUTE
            const layouts=[device.createBindGroupLayout({entries:[{binding:0,visibility,buffer:{type:'uniform'}}]}),
                device.createBindGroupLayout({entries:[{binding:0,visibility,buffer:{type:'read-only-storage'}},{binding:1,visibility,texture:{sampleType:'unfilterable-float'}},
                    {binding:2,visibility,buffer:{type:'read-only-storage'}},{binding:3,visibility,texture:{sampleType:'unfilterable-float'}}]}),
                device.createBindGroupLayout({entries:[{binding:0,visibility,buffer:{type:'read-only-storage'}},{binding:1,visibility,buffer:{type:'storage'}},
                    {binding:2,visibility,buffer:{type:'storage'}}]})]
            const layout=device.createPipelineLayout({bindGroupLayouts:layouts}),pipelines=[]
            for(const code of codes) {
                const module=device.createShaderModule({code}),messages=(await module.getCompilationInfo()).messages.filter(value=>value.type==='error')
                if(messages.length)throw new Error(messages.map(value=>value.message).join('\n'))
                pipelines.push(await device.createComputePipelineAsync({layout,compute:{module,entryPoint:'FlowCenterCache_build'}}))
            }
            const textures={}
            for(const [field,base64] of Object.entries(assets)) {
                const texture=device.createTexture({size:[768,256],format:'rg32float',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});owned.push(texture)
                device.queue.writeTexture({texture},Uint8Array.from(atob(base64),c=>c.charCodeAt(0)),{bytesPerRow:6144},[768,256]);textures[field]=texture
            }
            function fields(sources) {
                const tables=sources.map(source=>buffer(new Uint32Array(source.pages),GPUBufferUsage.STORAGE))
                return device.createBindGroup({layout:layouts[1],entries:[{binding:0,resource:{buffer:tables[0]}},{binding:1,resource:textures[sources[0].field].createView()},
                    {binding:2,resource:{buffer:tables[1]}},{binding:3,resource:textures[sources[1].field].createView()}]})
            }
            function config(count) {
                const bytes=new ArrayBuffer(16),view=new DataView(bytes)
                view.setUint32(4,count,true);view.setUint32(8,lookupCount,true);view.setFloat32(12,.001,true)
                return device.createBindGroup({layout:layouts[0],entries:[{binding:0,resource:{buffer:buffer(bytes,GPUBufferUsage.UNIFORM)}}]})
            }
            const pageSize=66049,recordBytes=2*pageSize*4
            const buffers=Array.from({length:4},()=>buffer(new Uint8Array(recordBytes),GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC))
            const [seed,oldFull,newFull,reused]=buffers
            const calls=buffer(new Uint8Array(recordBytes*2),GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC)
            function outputGroup(records,jobs) {
                return device.createBindGroup({layout:layouts[2],entries:[{binding:0,resource:{buffer:jobs}},{binding:1,resource:{buffer:records}},{binding:2,resource:{buffer:calls}}]})
            }
            const fullJobs=buffer(new Uint32Array([1,0,1,0,0,0,0,0]),GPUBufferUsage.STORAGE),fullConfig=config(2)
            const rowBytes=recordBytes*5
            const readback=device.createBuffer({size:scenarios.length*rowBytes,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});owned.push(readback)
            const encoded=[]
            function dispatch(encoder,pipeline,uniform,source,output,count,timestamps) {
                const pass=encoder.beginComputePass(timestamps?{timestampWrites:timestamps}:{})
                pass.setPipeline(pipeline);pass.setBindGroup(0,uniform);pass.setBindGroup(1,source);pass.setBindGroup(2,output)
                pass.dispatchWorkgroups(33,33,count);pass.end()
            }
            const encoder=device.createCommandEncoder()
            for(const [index,scenario] of scenarios.entries()) {
                const before=fields(scenario.before),after=fields(scenario.after),count=scenario.onePage?1:2,uniform=config(count)
                const plainJobs=buffer(new Uint32Array(scenario.onePage?[1,0,0,0,0,0,0,0]:[1,0,1,0,0,0,0,0]),GPUBufferUsage.STORAGE)
                const flag=scenario.selectors[0]|(scenario.selectors[1]<<2)
                const reuseJobs=buffer(new Uint32Array(scenario.onePage?[1,0,0,flag,0,0,0,0]:[1,0,1,flag,0,0,0,flag]),GPUBufferUsage.STORAGE)
                dispatch(encoder,pipelines[0],fullConfig,before,outputGroup(seed,fullJobs),2)
                encoder.copyBufferToBuffer(seed,0,reused,0,recordBytes)
                dispatch(encoder,pipelines[0],uniform,after,outputGroup(oldFull,plainJobs),count)
                dispatch(encoder,pipelines[1],uniform,after,outputGroup(newFull,plainJobs),count)
                const reusableGroup=outputGroup(reused,reuseJobs)
                dispatch(encoder,pipelines[2],uniform,after,reusableGroup,count)
                for(const [offset,source] of [[0,oldFull],[1,newFull],[2,reused]])encoder.copyBufferToBuffer(source,0,readback,index*rowBytes+offset*recordBytes,recordBytes)
                encoder.copyBufferToBuffer(calls,0,readback,index*rowBytes+3*recordBytes,recordBytes*2)
                encoded.push({scenario,before,after,count,uniform,plainGroup:outputGroup(reused,plainJobs),reuseGroup:reusableGroup})
            }
            device.queue.submit([encoder.finish()]);await readback.mapAsync(GPUMapMode.READ)
            const words=new Uint32Array(readback.getMappedRange()),counts=[];let comparedRecords=0
            for(const [index,scenario] of scenarios.entries()) {
                const base=index*rowBytes/4,length=(scenario.onePage?1:2)*pageSize,sums=[0,0]
                for(let record=0;record<length;record++) {
                    const old=words[base+record],full=words[base+recordBytes/4+record],reuse=words[base+recordBytes/2+record]
                    if(old!==full||full!==reuse)throw new Error(`${scenario.name}/${record}: packed old=${old} full=${full} reuse=${reuse}`)
                    sums[0]+=words[base+3*recordBytes/4+record*2];sums[1]+=words[base+3*recordBytes/4+record*2+1];comparedRecords++
                }
                for(let lane=0;lane<2;lane++) {
                    if(scenario.selectors[lane]!==0&&sums[lane]!==0)throw new Error(`${scenario.name}: reused lane ${lane} still loads UV`)
                    if(scenario.selectors[lane]===0&&sums[lane]===0)throw new Error(`${scenario.name}: fresh lane ${lane} has no source reads`)
                }
                counts.push({name:scenario.name,selectors:scenario.selectors,sourceLoads:sums})
            }
            readback.unmap()
            const benchmarks=[]
            if(timing) {
                const queries=device.createQuerySet({type:'timestamp',count:2});owned.push(queries)
                const resolve=device.createBuffer({size:16,usage:GPUBufferUsage.QUERY_RESOLVE|GPUBufferUsage.COPY_SRC});owned.push(resolve)
                const times=device.createBuffer({size:16,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});owned.push(times)
                for(const entry of encoded.filter(value=>['lower-change','forward-pair','reverse-pair','both-change'].includes(value.scenario.name))) {
                    const samples=[[],[]];let invalid=0
                    for(let i=0;i<28;i++) {
                        const mode=[0,1,1,0][i%4],encoder=device.createCommandEncoder()
                        dispatch(encoder,pipelines[0],fullConfig,entry.before,outputGroup(seed,fullJobs),2)
                        encoder.copyBufferToBuffer(seed,0,reused,0,recordBytes)
                        // The same counter-free current shader compares selectors=0
                        // with reuse selectors; the oracle and counters are proof-only.
                        dispatch(encoder,pipelines[1],entry.uniform,entry.after,mode===0?entry.plainGroup:entry.reuseGroup,entry.count,
                            {querySet:queries,beginningOfPassWriteIndex:0,endOfPassWriteIndex:1})
                        encoder.resolveQuerySet(queries,0,2,resolve,0);encoder.copyBufferToBuffer(resolve,0,times,0,16);device.queue.submit([encoder.finish()])
                        await times.mapAsync(GPUMapMode.READ);const pair=new BigUint64Array(times.getMappedRange())
                        const valid=pair[1]>pair[0]&&pair[0]>0n,ms=valid?Number(pair[1]-pair[0])/1e6:0;times.unmap()
                        if(i>=4){if(valid)samples[mode].push(ms);else invalid++}
                    }
                    const summary=values=>{const sorted=[...values].sort((a,b)=>a-b);return {samples:values.length,
                        meanMs:values.length?values.reduce((sum,value)=>sum+value,0)/values.length:null,
                        p50Ms:values.length?sorted[Math.floor(sorted.length/2)]:null}}
                    benchmarks.push({name:entry.scenario.name,full:summary(samples[0]),reuse:summary(samples[1]),invalidTimestamps:invalid})
                }
            }
            await device.queue.onSubmittedWorkDone();const validation=await device.popErrorScope()
            if(validation)throw new Error(validation.message);if(errors.length)throw new Error(errors.join('\n'))
            return {comparedRecords,counts,benchmarks,timestampStatus:benchmark?(timing?'measured':'unsupported'):'not-requested',errors}
        } finally {for(const resource of owned)resource.destroy();device.destroy()}
    },{codes,scenarios,assets,lookupCount:table.length/8,benchmark:process.argv.includes('--benchmark')})
    assert.ok(result.comparedRecords>1_000_000)
    console.log(JSON.stringify({status:'passed',...result}))
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve))}
