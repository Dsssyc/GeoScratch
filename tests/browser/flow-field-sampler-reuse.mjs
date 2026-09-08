import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { chromium } from 'playwright'
import { WebMercatorQuad,tileMatrixCoverage,webMercatorVirtualRasterField } from 'geoscratch/geo'
import { temporalVelocityWgslModule } from '../../examples/flowField/temporal-velocity-raster.ts'

const wrapper=await readFile(new URL('../../examples/flowField/shaders/temporal-velocity.wgsl',import.meta.url),'utf8')
const model=webMercatorVirtualRasterField({id:'sampler-reuse-proof',addressSpaceId:'sampler-reuse-space',sourceRevision:'v1',
    coverage:tileMatrixCoverage({tileMatrixSet:WebMercatorQuad,limits:[
        {matrixId:'2',minTileRow:1,maxTileRow:2,minTileCol:1,maxTileCol:2},
        {matrixId:'1',minTileRow:0,maxTileRow:1,minTileCol:0,maxTileCol:1},
        {matrixId:'0',minTileRow:0,maxTileRow:0,minTileCol:0,maxTileCol:0},
    ]}),geographicBounds:[-90,-66.51326044311186,90,66.51326044311186],coordinateBits:52,
    fieldKind:'vector',channels:2,sampleType:'float32',gpuFormat:'rg32float',interpolation:'linear'})
assert.equal(model.addressSpace.levelCount,3)
const optimized=temporalVelocityWgslModule(model,model,{group:1,currentPageTableBinding:0,currentAtlasBinding:1,
    nextPageTableBinding:2,nextAtlasBinding:3,transitionTexels:4,sampleRegistration:'pixel-center',activitySupport:'nearest-texel-zero',wrapper}).code

// Frozen 8e38f5f no-NoData registration oracle. It deliberately retains the
// preflight -> core sample_level path, on the SAME real generated Geo samplers.
function oldAdapter(slot) {
    const sampler=slot==='current'?'FlowVelocityCurrent':'FlowVelocityNext'
    return `
fn Fixture_${slot}_resolution(position:FlowVelocityAddressFixedPosition,level:u32)->vec2u {
    let address=FlowVelocityAddress_address(position,${sampler}_matrix[level]);
    let base=vec2i(address.tile*${sampler}_page_size+address.texel);
    let tl=${sampler}_resolution_global(base,level);let tr=${sampler}_resolution_global(base+vec2i(1,0),level);
    let bl=${sampler}_resolution_global(base+vec2i(0,1),level);let br=${sampler}_resolution_global(base+vec2i(1,1),level);
    if(tl.x==4u||tr.x==4u||bl.x==4u||br.x==4u){return vec2u(4u,level);}
    if(tl.x==0u||tr.x==0u||bl.x==0u||br.x==0u){return vec2u(0u,level);}
    if(tl.x==3u||tr.x==3u||bl.x==3u||br.x==3u){return vec2u(3u,level);}
    return vec2u(max(max(tl.x,tr.x),max(bl.x,br.x)),max(max(tl.y,tr.y),max(bl.y,br.y)));
}
fn FlowVelocityRegistration_sample_${slot}(position:FlowVelocityAddressFixedPosition,level:u32)->${sampler}Sample {
    let resolution=Fixture_${slot}_resolution(position,level);
    if(resolution.x==4u){return ${sampler}_failed(level);}
    if(resolution.x==0u){return ${sampler}_missing(level);}
    if(resolution.x==3u){return ${sampler}Sample(vec4f(0.0),3u,level,level);}
    if(resolution.y<level||resolution.y>=${sampler}_level_count){return ${sampler}_failed(level);}
    if(resolution.y>level){return ${sampler}Sample(vec4f(0.0),2u,level,resolution.y);}
    if(level+1u<${sampler}_level_count&&${sampler}_edge_blend_weight(position,level)<1.0f){
        return ${sampler}Sample(vec4f(0.0),2u,level,level+1u);
    }
    return ${sampler}_sample_level(position,level);
}`
}
const previous=optimized.replace('fn FlowVelocityRegistration_sample_current(', 'fn Fixture_unused_current(')
    .replace('fn FlowVelocityRegistration_sample_next(', 'fn Fixture_unused_next(')+oldAdapter('current')+oldAdapter('next')
function program(source,counting) {
    let code=source
    if(counting)for(const name of ['FlowVelocityCurrent','FlowVelocityNext']) {
        code=code.replace(`fn ${name}_resolution_global(`,`fn Fixture_${name}_resolution_global(`)
            .replace(`fn ${name}_load_global(`,`fn Fixture_${name}_load_global(`)
            .replace(`let raw = textureLoad(${name}_atlas,`,`fixtureTexelLoads++; let raw = textureLoad(${name}_atlas,`)
        code+=`
fn ${name}_resolution_global(p:vec2i,l:u32)->vec2u {fixtureResolutionCalls++;return Fixture_${name}_resolution_global(p,l);}
fn ${name}_load_global(p:vec2i,l:u32)->${name}Sample {fixtureLoadCalls++;return Fixture_${name}_load_global(p,l);}
`
    }
    return code+`
struct FixtureConfig { requested:u32, progress:f32, kill:f32, owner:u32, }
@group(0) @binding(0) var<uniform> fixtureConfig:FixtureConfig;
@group(2) @binding(0) var<storage,read> fixturePositions:array<FlowVelocityAddressFixedPosition>;
${counting?`
var<private> fixtureResolutionCalls:u32;var<private> fixtureLoadCalls:u32;var<private> fixtureTexelLoads:u32;
struct FixtureResult {value:vec4f,info:vec4u,counts:vec4u,}
@group(2) @binding(1) var<storage,read_write> fixtureResults:array<FixtureResult>;
`:'@group(2) @binding(1) var<storage,read_write> fixtureResults:array<vec4f>;'}
@compute @workgroup_size(64)
fn test_sampler(@builtin(global_invocation_id) id:vec3u) {
    if(id.x>=arrayLength(&fixturePositions)){return;}
    ${counting?'fixtureResolutionCalls=0u;fixtureLoadCalls=0u;fixtureTexelLoads=0u;':''}
    let p=fixturePositions[id.x];let t=FlowVelocityTemporal(fixtureConfig.progress,fixtureConfig.kill);
    var sample:FlowVelocitySample;
    if(fixtureConfig.owner!=0u){sample=FlowVelocity_sample(p,fixtureConfig.requested,t);}
    else{sample=FlowVelocity_sample_centers(p,fixtureConfig.requested,t);}
    ${counting?`fixtureResults[id.x]=FixtureResult(vec4f(sample.velocity,sample.speed,f32(sample.status)),
        vec4u(sample.resolved_level,select(0u,1u,sample.advectable),fixtureResolutionCalls,fixtureLoadCalls),
        vec4u(fixtureTexelLoads,0u,0u,0u));`:'fixtureResults[id.x]=vec4f(sample.velocity,sample.speed,f32(sample.status));'}
}`
}
const quanta=model.addressCodec.worldQuanta/1024n
const position=(x,y)=>model.addressCodec.fromWorldQuanta([BigInt(Math.round(x*Number(quanta))),BigInt(Math.round(y*Number(quanta)))])
const pages=model.addressSpace.pages(),table=new Uint32Array(model.addressSpace.pageTableEntryCount*8)
const slotFor=page=>(model.addressSpace.tableIndex(page)*5+2)%pages.length
for(const page of pages) {
    const slot=slotFor(page);table.set([slot%3,Math.floor(slot/3),page.level,1,0,0,0,0],model.addressSpace.tableIndex(page)*8)
}
const fine=pages.filter(page=>page.level===0)
assert.equal(fine.length,4)
function setStatus(target,page,status,resolved) {
    const ancestor=resolved===undefined? page : resolved===2?model.addressSpace.page({level:2,x:0,y:0}):model.addressSpace.parent(page)
    const slot=slotFor(ancestor)
    target.splice(model.addressSpace.tableIndex(page)*8,8,slot%3,Math.floor(slot/3),resolved??page.level,status,0,0,0,0)
}
const fixtures=[]
function add(name,{field='gradient',requested=0,progress=.277,mutate}={}) {
    const fixture={name,field,requested,progress,pages:[[...table],[...table]]}
    mutate?.(fixture.pages);fixtures.push(fixture);return fixture
}
add('fully-resident')
add('owner-zero',{field:'owner-zero'})
add('reversal',{field:'reversal',progress:.5})
add('coarse-request',{requested:1})
add('last-level',{requested:2})
add('invalid-level',{requested:3})
for(const endpoint of [0,1])for(const status of [0,4,3,2])for(let corner=0;corner<4;corner++) {
    add(`endpoint-${endpoint}-status-${status}-corner-${corner}`,{mutate:tables=>setStatus(tables[endpoint],fine[corner],status,status===2?1:undefined)})
}
const rightTop=fine.find(page=>page.coordinates[0]===2&&page.coordinates[1]===1)
assert.ok(rightTop)
add('mixed-fallback',{mutate:tables=>setStatus(tables[0],rightTop,2,1)})
add('transition',{mutate:tables=>setStatus(tables[1],rightTop,2,1)})
add('repeat-common-level',{mutate:tables=>{
    for(const page of fine)setStatus(tables[0],page,2,1)
    for(const page of pages.filter(page=>page.level===1))setStatus(tables[1],page,2,2)
}})
for(const [label,statuses] of [['failed-before-missing',[4,0]],['missing-before-three',[0,3]],['three-before-fallback',[3,2]]]) {
    add(label,{mutate:tables=>statuses.forEach((status,index)=>setStatus(tables[0],fine[index],status,status===2?1:undefined))})
}
add('cross-endpoint-three-before-missing',{mutate:tables=>{setStatus(tables[0],fine[0],0);setStatus(tables[1],fine[0],3)}})
add('metadata-three-before-invalid-level',{mutate:tables=>{
    setStatus(tables[0],fine[0],3);tables[0][model.addressSpace.tableIndex(fine[0])*8+2]=3
}})
add('invalid-resolved-level',{mutate:tables=>{
    setStatus(tables[0],fine[0],2,1);tables[0][model.addressSpace.tableIndex(fine[0])*8+2]=3
}})
const probes=[
    {name:'interior',x:400.25,y:430.75},{name:'four-page-seam',x:512,y:512},
    {name:'zero-owner-corner',x:511.9,y:512.1},{name:'zero-source-center',x:511.5,y:512.5},
    {name:'mixed-page',x:600.25,y:400.75},{name:'transition-only',x:510.75,y:400.75},
    {name:'source-west',x:256,y:400.25},{name:'source-north',x:400.25,y:256},
    {name:'source-east',x:768,y:400.25},{name:'source-south',x:400.25,y:768},
    {name:'outside-west',x:255,y:400.25},{name:'outside-north',x:400.25,y:255},
]
for(const delta of [-1/Number(quanta),0,1/Number(quanta),-.25,.25])for(const axis of [0,1]) {
    probes.push({name:`half-texel-${axis}-${delta}`,x:512.5+(axis===0?delta:0),y:512.5+(axis===1?delta:0)})
}
const positions=probes.flatMap(probe=>position(probe.x,probe.y).fixed.limbs.flatMap(axis=>[axis.low,axis.high]))
const assets={}
for(const field of ['gradient','owner-zero','reversal'])for(const endpoint of [0,1]) {
    const pixels=new Float32Array(768*768*2)
    for(const page of pages)for(let y=0;y<256;y++)for(let x=0;x<256;x++) {
        const gx=page.coordinates[0]*256+x,gy=page.coordinates[1]*256+y,l=page.level
        let u=1+gx/512+gy/1024+l*8,v=-2+gx/1024-gy/512-l*4
        if(endpoint===1) {
            if(field==='reversal'){u=-u;v=-v}
            else{u=-.5+gx/1024-gy/2048-l*4;v=.5+gx/2048+gy/512+l*2}
        }
        if(field==='owner-zero'&&l===0&&gx===511&&gy===512){u=0;v=0}
        const slot=slotFor(page),offset=((Math.floor(slot/3)*256+y)*768+(slot%3)*256+x)*2
        pixels.set([u,v],offset)
    }
    assets[`${field}-${endpoint}`]=Buffer.from(pixels.buffer).toString('base64')
}
const cases=fixtures.flatMap((fixture,index)=>[false,true].flatMap(owner=>[0,fixture.progress,1].map(progress=>({
    fixture:index,owner,progress,name:`${fixture.name}/${owner?'A-B':'C-D'}/${progress}`,
}))))
const server=createServer((_request,response)=>response.end('<!doctype html><title>Flow registered sampler reuse proof</title>'))
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
let browser
try {
    browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-webgpu']})
    const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`)
    const proof=await page.evaluate(async ({codes,fixtures,cases,positions,assets})=>{
        const adapter=await navigator.gpu.requestAdapter();if(!adapter)throw new Error('WebGPU unavailable')
        const device=await adapter.requestDevice(),owned=[],errors=[]
        device.addEventListener('uncapturederror',event=>errors.push(event.error.message));device.pushErrorScope('validation')
        try {
            const buffer=(data,usage)=>{const b=device.createBuffer({size:data.byteLength,usage:usage|GPUBufferUsage.COPY_DST});owned.push(b);device.queue.writeBuffer(b,0,data);return b}
            const visibility=GPUShaderStage.COMPUTE
            const layouts=[device.createBindGroupLayout({entries:[{binding:0,visibility,buffer:{type:'uniform'}}]}),
                device.createBindGroupLayout({entries:[{binding:0,visibility,buffer:{type:'read-only-storage'}},{binding:1,visibility,texture:{sampleType:'unfilterable-float'}},
                    {binding:2,visibility,buffer:{type:'read-only-storage'}},{binding:3,visibility,texture:{sampleType:'unfilterable-float'}}]}),
                device.createBindGroupLayout({entries:[{binding:0,visibility,buffer:{type:'read-only-storage'}},{binding:1,visibility,buffer:{type:'storage'}}]})]
            const pipelineLayout=device.createPipelineLayout({bindGroupLayouts:layouts}),pipelines=[]
            for(const code of codes) {
                const module=device.createShaderModule({code}),messages=(await module.getCompilationInfo()).messages.filter(message=>message.type==='error')
                if(messages.length)throw new Error(messages.map(message=>message.message).join('\n'))
                pipelines.push(await device.createComputePipelineAsync({layout:pipelineLayout,compute:{module,entryPoint:'test_sampler'}}))
            }
            const textures={}
            for(const [key,base64] of Object.entries(assets)) {
                const texture=device.createTexture({size:[768,768],format:'rg32float',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});owned.push(texture)
                device.queue.writeTexture({texture},Uint8Array.from(atob(base64),c=>c.charCodeAt(0)),{bytesPerRow:6144},[768,768]);textures[key]=texture
            }
            const groups=fixtures.map(fixture=>{
                const tables=fixture.pages.map(value=>buffer(new Uint32Array(value),GPUBufferUsage.STORAGE))
                return device.createBindGroup({layout:layouts[1],entries:[{binding:0,resource:{buffer:tables[0]}},{binding:1,resource:textures[`${fixture.field}-0`].createView()},
                    {binding:2,resource:{buffer:tables[1]}},{binding:3,resource:textures[`${fixture.field}-1`].createView()}]})
            })
            const count=positions.length/4,bytes=count*48,positionBuffer=buffer(new Uint32Array(positions),GPUBufferUsage.STORAGE)
            const output=buffer(new Uint8Array(bytes),GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC)
            const outputGroup=device.createBindGroup({layout:layouts[2],entries:[{binding:0,resource:{buffer:positionBuffer}},{binding:1,resource:{buffer:output}}]})
            const readback=device.createBuffer({size:cases.length*2*bytes,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});owned.push(readback)
            const encoder=device.createCommandEncoder()
            for(const [index,entry] of cases.entries()) {
                const config=new ArrayBuffer(16),view=new DataView(config)
                view.setUint32(0,fixtures[entry.fixture].requested,true);view.setFloat32(4,entry.progress,true);view.setFloat32(8,.001,true);view.setUint32(12,Number(entry.owner),true)
                const uniform=buffer(config,GPUBufferUsage.UNIFORM)
                const control=device.createBindGroup({layout:layouts[0],entries:[{binding:0,resource:{buffer:uniform}}]})
                for(let mode=0;mode<2;mode++) {
                    const pass=encoder.beginComputePass();pass.setPipeline(pipelines[mode]);pass.setBindGroup(0,control);pass.setBindGroup(1,groups[entry.fixture]);pass.setBindGroup(2,outputGroup)
                    pass.dispatchWorkgroups(Math.ceil(count/64));pass.end();encoder.copyBufferToBuffer(output,0,readback,(index*2+mode)*bytes,bytes)
                }
            }
            device.queue.submit([encoder.finish()]);await readback.mapAsync(GPUMapMode.READ)
            const data=new DataView(readback.getMappedRange())
            const rows=cases.map((_,index)=>[0,1].map(mode=>Array.from({length:count},(_,probe)=>{
                const base=((index*2+mode)*count+probe)*48
                return Array.from({length:12},(_,word)=>word<4?data.getFloat32(base+word*4,true):data.getUint32(base+word*4,true))
            })))
            readback.unmap();await device.queue.onSubmittedWorkDone();const validation=await device.popErrorScope()
            if(validation)throw new Error(validation.message);if(errors.length)throw new Error(errors.join('\n'))
            return {rows,errors,readbacks:1}
        } finally {for(const resource of owned)resource.destroy();device.destroy()}
    },{codes:[program(previous,true),program(optimized,true)],fixtures,cases,positions,assets})
    let maximumValueDifference=0
    for(const [index,entry] of cases.entries())for(let probe=0;probe<probes.length;probe++) {
        const [old,value]=proof.rows[index].map(rows=>rows[probe])
        assert.deepEqual(value.slice(3,6),old.slice(3,6),`${entry.name}/${probes[probe].name}: exact status, resolved level and advectability`)
        for(let channel=0;channel<3;channel++) {
            const difference=Math.abs(value[channel]-old[channel]);maximumValueDifference=Math.max(maximumValueDifference,difference)
            assert.ok(difference<4e-6,`${entry.name}/${probes[probe].name}: source interpolation differs by ${difference}`)
        }
    }
    const row=(name,probe,owner=false,progress=.277)=>proof.rows[cases.findIndex(entry=>fixtures[entry.fixture].name===name&&entry.owner===owner&&entry.progress===progress)]
        .map(values=>values[probes.findIndex(entry=>entry.name===probe)])
    const counts=[]
    for(const [name,probe] of [['fully-resident','interior'],['mixed-fallback','mixed-page'],['transition','transition-only']]) {
        const [old,value]=row(name,probe)
        counts.push({name,old:{resolution:old[6],load:old[7],texel:old[8]},optimized:{resolution:value[6],load:value[7],texel:value[8]}})
        assert.ok(value[6]+value[7]<old[6]+old[7],`${name}: fewer real Geo page-resolving helper calls`)
    }
    assert.deepEqual(counts[0].old,{resolution:16,load:8,texel:8})
    assert.deepEqual(counts[0].optimized,{resolution:0,load:8,texel:8})
    const cornerA=row('owner-zero','zero-owner-corner',true)[1],cornerC=row('owner-zero','zero-owner-corner')[1]
    assert.equal(cornerA[2],0);assert.ok(cornerC[2]>0,'C/D must retain positive center interpolation where A/B veto a zero owner')
    assert.equal(row('owner-zero','zero-source-center')[1][2],0)
    assert.equal(row('reversal','interior',false,.5)[1][2],0)
    console.log(JSON.stringify({status:'parity-passed',fixtures:fixtures.length,cases:cases.length,positions:probes.length,
        comparedSamples:cases.length*probes.length,maximumValueDifference,counts,readbacks:proof.readbacks,errors:proof.errors}))
    if(process.argv.includes('--benchmark')) {
        const queryCount=32768
        const scenarios=['fully-resident','mixed-fallback','transition'].map(name=>{
            const samples=[]
            for(let i=0;i<queryCount;i++) {
                const x=name==='transition'?508.75+(i%128)/256:(name==='mixed-fallback'?544:320)+(i%128)/4
                const y=350+(Math.floor(i/128)%128)/4
                samples.push(...position(x,y).fixed.limbs.flatMap(axis=>[axis.low,axis.high]))
            }
            return {name,fixture:fixtures.find(fixture=>fixture.name===name),positions:samples}
        })
        const timingCodes=[program(previous,false),program(optimized,false)]
        assert.ok(timingCodes.every(code=>!code.includes('fixtureResolutionCalls')&&!code.includes('fixtureLoadCalls')&&!code.includes('fixtureTexelLoads')),
            'Timestamp programs contain no diagnostic counters')
        const timing=await page.evaluate(async ({codes,scenarios,assets,queryCount})=>{
            const adapter=await navigator.gpu.requestAdapter();if(!adapter)throw new Error('WebGPU unavailable')
            if(!adapter.features.has('timestamp-query'))return {status:'unsupported',reason:'timestamp-query unavailable'}
            const device=await adapter.requestDevice({requiredFeatures:['timestamp-query']}),owned=[],errors=[]
            device.addEventListener('uncapturederror',event=>errors.push(event.error.message));device.pushErrorScope('validation')
            try {
                const buffer=(data,usage)=>{const value=device.createBuffer({size:data.byteLength,usage:usage|GPUBufferUsage.COPY_DST});owned.push(value);device.queue.writeBuffer(value,0,data);return value}
                const visibility=GPUShaderStage.COMPUTE
                const layouts=[device.createBindGroupLayout({entries:[{binding:0,visibility,buffer:{type:'uniform'}}]}),
                    device.createBindGroupLayout({entries:[{binding:0,visibility,buffer:{type:'read-only-storage'}},{binding:1,visibility,texture:{sampleType:'unfilterable-float'}},
                        {binding:2,visibility,buffer:{type:'read-only-storage'}},{binding:3,visibility,texture:{sampleType:'unfilterable-float'}}]}),
                    device.createBindGroupLayout({entries:[{binding:0,visibility,buffer:{type:'read-only-storage'}},{binding:1,visibility,buffer:{type:'storage'}}]})]
                const pipelineLayout=device.createPipelineLayout({bindGroupLayouts:layouts}),pipelines=[]
                for(const code of codes) {
                    const module=device.createShaderModule({code}),messages=(await module.getCompilationInfo()).messages.filter(value=>value.type==='error')
                    if(messages.length)throw new Error(messages.map(value=>value.message).join('\n'))
                    pipelines.push(await device.createComputePipelineAsync({layout:pipelineLayout,compute:{module,entryPoint:'test_sampler'}}))
                }
                const textures=[]
                for(const base64 of assets) {
                    const value=device.createTexture({size:[768,768],format:'rg32float',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});owned.push(value)
                    device.queue.writeTexture({texture:value},Uint8Array.from(atob(base64),c=>c.charCodeAt(0)),{bytesPerRow:6144},[768,768]);textures.push(value)
                }
                const config=new ArrayBuffer(16),view=new DataView(config)
                view.setFloat32(4,.277,true);view.setFloat32(8,.001,true)
                const uniform=buffer(config,GPUBufferUsage.UNIFORM)
                const control=device.createBindGroup({layout:layouts[0],entries:[{binding:0,resource:{buffer:uniform}}]})
                const output=buffer(new Uint8Array(queryCount*16),GPUBufferUsage.STORAGE)
                const queries=device.createQuerySet({type:'timestamp',count:2});owned.push(queries)
                const resolved=device.createBuffer({size:16,usage:GPUBufferUsage.QUERY_RESOLVE|GPUBufferUsage.COPY_SRC});owned.push(resolved)
                const readback=device.createBuffer({size:16,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});owned.push(readback)
                const measurements=[]
                for(const scenario of scenarios) {
                    const tables=scenario.fixture.pages.map(value=>buffer(new Uint32Array(value),GPUBufferUsage.STORAGE))
                    const fields=device.createBindGroup({layout:layouts[1],entries:[{binding:0,resource:{buffer:tables[0]}},{binding:1,resource:textures[0].createView()},
                        {binding:2,resource:{buffer:tables[1]}},{binding:3,resource:textures[1].createView()}]})
                    const positions=buffer(new Uint32Array(scenario.positions),GPUBufferUsage.STORAGE)
                    const resultGroup=device.createBindGroup({layout:layouts[2],entries:[{binding:0,resource:{buffer:positions}},{binding:1,resource:{buffer:output}}]})
                    const samples=[[],[]]
                    // ABBA order, four warm-up passes then 24 measured passes.
                    for(let i=0;i<28;i++) {
                        const mode=[0,1,1,0][i%4],encoder=device.createCommandEncoder()
                        const pass=encoder.beginComputePass({timestampWrites:{querySet:queries,beginningOfPassWriteIndex:0,endOfPassWriteIndex:1}})
                        pass.setPipeline(pipelines[mode]);pass.setBindGroup(0,control);pass.setBindGroup(1,fields);pass.setBindGroup(2,resultGroup)
                        pass.dispatchWorkgroups(queryCount/64);pass.end();encoder.resolveQuerySet(queries,0,2,resolved,0)
                        encoder.copyBufferToBuffer(resolved,0,readback,0,16);device.queue.submit([encoder.finish()])
                        await readback.mapAsync(GPUMapMode.READ);const times=new BigUint64Array(readback.getMappedRange())
                        const ms=Number(times[1]-times[0])/1e6;readback.unmap()
                        if(i>=4)samples[mode].push(ms)
                    }
                    const summarize=values=>{
                        const sorted=[...values].sort((a,b)=>a-b)
                        return {meanMs:values.reduce((sum,value)=>sum+value,0)/values.length,p50Ms:(sorted[5]+sorted[6])/2,samples:values.length}
                    }
                    measurements.push({name:scenario.name,previous:summarize(samples[0]),optimized:summarize(samples[1])})
                }
                await device.queue.onSubmittedWorkDone();const validation=await device.popErrorScope()
                if(validation)throw new Error(validation.message);if(errors.length)throw new Error(errors.join('\n'))
                return {status:'measured',counterFree:true,queryCount,measurements,errors}
            } finally {for(const resource of owned)resource.destroy();device.destroy()}
        },{codes:timingCodes,scenarios,assets:[assets['gradient-0'],assets['gradient-1']],queryCount})
        console.log(JSON.stringify({benchmark:'registered-sampler-reuse',...timing}))
    }
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve))}
