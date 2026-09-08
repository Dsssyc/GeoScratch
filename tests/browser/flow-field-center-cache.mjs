import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { chromium } from 'playwright'
import { WebMercatorQuad, tileMatrixCoverage, webMercatorVirtualRasterField } from 'geoscratch/geo'
import { temporalVelocityWgslModule } from '../../examples/flowField/temporal-velocity-raster.ts'
import { flowScreenProjectionWgsl } from '../../examples/flowField/flow-screen-projection.ts'

const read=name=>readFile(new URL(`../../examples/flowField/shaders/${name}.wgsl`,import.meta.url),'utf8')
const [wrapper,history,displaySupport,distance,activity,boundary,centerDistance,centerBoundary,build,cached]=await Promise.all([
    'temporal-velocity','history','presentation-support','boundary-distance','boundary-activity','boundary-sdf',
    'boundary-center-distance','boundary-center','center-cache-build','center-cache-sample',
].map(read))
const model=webMercatorVirtualRasterField({
    id:'center-cache-proof',addressSpaceId:'center-cache-proof-space',sourceRevision:'v1',
    coverage:tileMatrixCoverage({tileMatrixSet:WebMercatorQuad,limits:[
        {matrixId:'1',minTileRow:0,maxTileRow:0,minTileCol:0,maxTileCol:1},
        {matrixId:'0',minTileRow:0,maxTileRow:0,minTileCol:0,maxTileCol:0},
    ]}),geographicBounds:[-179.9,0,179.9,85],coordinateBits:52,
    fieldKind:'vector',channels:2,sampleType:'float32',gpuFormat:'rg32float',interpolation:'linear',
})
const temporal=temporalVelocityWgslModule(model,model,{group:1,currentPageTableBinding:0,currentAtlasBinding:1,
    nextPageTableBinding:2,nextAtlasBinding:3,sampleRegistration:'pixel-center',activitySupport:'nearest-texel-zero',transitionTexels:4,wrapper})
const uniformStruct=history.match(/struct FlowFieldHistoryUniform \{[\s\S]*?\n\};/)?.[0]
assert.ok(uniformStruct)
// These fixture limits deliberately exclude source row zero, so generated cache
// records exercise unknown owners at the source boundary as well as tile misses.
assert.ok(temporal.code.includes('FlowVelocityCurrent_minimum_texel = array<vec2u, 2>(vec2u(0u, 1u)'))
const buildCode=temporal.code+'\n'+build
// Instrument entry counts only; original function bodies and generated samplers
// stay intact. This catches a "cached" path that silently always calls direct.
const probeCode=[temporal.code,flowScreenProjectionWgsl(model.addressCodec),uniformStruct,displaySupport,distance,activity,
    boundary.replace('fn FlowBoundary_hard_coverage(', 'fn Fixture_hard_coverage('),centerDistance,
    centerBoundary.replace('fn FlowCenter_coverage(', 'fn Fixture_direct_coverage('),cached,`
var<private> fixtureDirectCalls:u32;
var<private> fixtureHardCalls:u32;
fn FlowCenter_coverage(position:FlowVelocityAddressFixedPosition)->f32 {
    fixtureDirectCalls++;return Fixture_direct_coverage(position);
}
fn FlowBoundary_hard_coverage(position:FlowVelocityAddressFixedPosition,level:u32)->f32 {
    fixtureHardCalls++;return Fixture_hard_coverage(position,level);
}
@group(2) @binding(1) var<storage,read> fixturePositions:array<FlowVelocityAddressFixedPosition>;
@group(2) @binding(2) var<storage,read_write> fixtureResults:array<vec4f>;
@compute @workgroup_size(64)
fn test_cached_boundary(@builtin(global_invocation_id) id:vec3u) {
    if(id.x>=arrayLength(&fixturePositions)){return;}
    let position=fixturePositions[id.x];
    fixtureDirectCalls=0u;fixtureHardCalls=0u;
    let value=FlowCenterCached_coverage(position);
    let directCalls=fixtureDirectCalls;let hardCalls=fixtureHardCalls;
    fixtureResults[id.x*2u]=vec4f(value,Fixture_direct_coverage(position),
        Fixture_hard_coverage(position,boundaryUniform.requestedLevel),f32(directCalls));
    let sample=FlowVelocity_sample_centers(position,boundaryUniform.requestedLevel,
        FlowVelocityTemporal(boundaryUniform.progress,boundaryUniform.activityKill));
    fixtureResults[id.x*2u+1u]=vec4f(f32(hardCalls),f32(sample.status),f32(sample.resolved_level),sample.speed);
}`].join('\n')
const quanta=model.addressCodec.worldQuanta/512n
const position=(x,y)=>model.addressCodec.fromWorldQuanta([BigInt(Math.round(x*Number(quanta))),BigInt(Math.round(y*Number(quanta)))])
const table=new Uint32Array(model.addressSpace.pageTableEntryCount*8),lookup=new Uint32Array(model.addressSpace.pageTableEntryCount)
let rightEntry
for(const col of [0,1]) {
    const index=model.addressCodec.address(position(col*256+.5,65.5),'1').compactIndex
    assert.notEqual(index,undefined);table.set([1-col,0,0,1,0,0,0,0],index*8)
    lookup[index]=col+1
    if(col===1)rightEntry=index
}
const parent=model.addressCodec.address(position(256,65.5),'0').compactIndex
assert.notEqual(parent,undefined);table.set([2,0,1,1,0,0,0,0],parent*8)
function velocity(field,x,y) {
    if(field==='zero')return 0
    if(field==='wet')return 2
    if(field==='reverse')return -2
    if(field==='diagonal')return y<=x-191?2:0
    if(field==='shifted')return x===256&&y===65?0:2
    return x===254&&y===65?0:2
}
const fixtures=[
    {name:'hole',lower:'hole',upper:'hole'},
    {name:'diagonal',lower:'diagonal',upper:'diagonal'},
    {name:'reversal',lower:'wet',upper:'reverse'},
    {name:'growth',lower:'zero',upper:'wet'},
    {name:'join-before',lower:'hole',upper:'diagonal'},
    {name:'join-after',lower:'diagonal',upper:'shifted'},
    {name:'missing-lower',lower:'hole',upper:'hole',missing:[0]},
    {name:'missing-upper',lower:'hole',upper:'hole',missing:[1]},
    {name:'wet-unknown-halo',lower:'wet',upper:'wet',missing:[0,1]},
    {name:'dry-unknown-halo',lower:'zero',upper:'zero',missing:[0,1]},
    {name:'growth-unknown-halo',lower:'zero',upper:'wet',missing:[0,1]},
    {name:'coarse-lower',lower:'wet',upper:'wet',coarse:[0]},
    {name:'coarse-upper-reversal',lower:'wet',upper:'reverse',coarse:[1]},
].map(fixture=>({...fixture,pages:[0,1].map(endpoint=>{
    const pages=table.slice()
    if(fixture.missing?.includes(endpoint))pages[rightEntry*8+3]=0
    if(fixture.coarse?.includes(endpoint))pages.set([2,0,1,2,0,0,0,0],rightEntry*8)
    return [...pages]
})}))
const probes=[
    {name:'dry-center',x:254.5,y:65.5},{name:'square-corner',x:254.9,y:65.1},
    {name:'halo-only',x:255.25,y:65.25},{name:'missing-footprint',x:255.75,y:65.25},
    {name:'physical-left',x:256-1/4096,y:65.25},{name:'physical-right',x:256+1/4096,y:65.25},
    {name:'cache-page-left',x:256.5-1/4096,y:65.25},{name:'cache-page-right',x:256.5+1/4096,y:65.25},
    {name:'interior',x:252.5,y:63.5},{name:'source-edge',x:.5,y:1.5},
]
for(let y=0;y<=16;y++)for(let x=0;x<=32;x++)probes.push({name:`grid-${x}-${y}`,x:253.5+x/8,y:64.5+y/8})
const positions=probes.flatMap(probe=>position(probe.x,probe.y).fixed.limbs.flatMap(axis=>[axis.low,axis.high]))
const atlases={}
for(const field of new Set(fixtures.flatMap(fixture=>[fixture.lower,fixture.upper]))) {
    const pixels=new Float32Array(768*256*2)
    for(let y=0;y<256;y++)for(let x=0;x<512;x++) {
        const atlasX=(1-Math.floor(x/256))*256+x%256
        pixels[(y*768+atlasX)*2]=velocity(field,x,y)
    }
    for(let y=0;y<256;y++)for(let x=0;x<256;x++)pixels[(y*768+512+x)*2]=velocity(field,x*2,y*2)
    atlases[field]=Buffer.from(pixels.buffer).toString('base64')
}
const alphas=[0,.25,.5,.75,1],modes=['normal','disabled','lookup-miss','slot-miss','slot-out-of-range','level-mismatch','kill-mismatch']
const cases=[]
fixtures.forEach((fixture,fixtureIndex)=>{
    for(const mode of fixture.name==='hole'?modes:['normal'])for(const alpha of alphas)for(const smoothed of [false,true]) {
        const bytes=new Uint8Array(352),uniform=new DataView(bytes.buffer)
        uniform.setFloat32(332,alpha,true);uniform.setFloat32(336,.001,true);uniform.setFloat32(340,.25,true)
        const cacheBytes=new Uint8Array(16),config=new DataView(cacheBytes.buffer)
        config.setUint32(0,mode==='level-mismatch'?1:0,true);config.setUint32(4,mode==='disabled'?0:2,true)
        config.setUint32(8,mode==='lookup-miss'?0:lookup.length,true);config.setFloat32(12,mode==='kill-mismatch'?1:.001,true)
        const selectedLookup=lookup.slice()
        if(mode==='slot-miss')selectedLookup.fill(0)
        if(mode==='slot-out-of-range')selectedLookup.fill(3)
        cases.push({fixtureIndex,name:fixture.name,mode,alpha,smoothed,uniform:[...bytes],config:[...cacheBytes],lookup:[...selectedLookup]})
    }
})
function supportAt(fixture,endpoint,x,y) {
    if(x<0||x>511||y<1||y>255||(fixture.missing?.includes(endpoint)||fixture.coarse?.includes(endpoint))&&x>=256)return undefined
    return Number(Math.abs(velocity(endpoint?fixture.upper:fixture.lower,x,y))>=.001)
}
function expectedByte(fixture,endpoint,x,y) {
    const owner=supportAt(fixture,endpoint,x,y)
    if(owner===undefined)return 32
    let squared=9,unknown=false
    for(let gy=y-1;gy<=y+1;gy++)for(let gx=x-1;gx<=x+1;gx++) {
        const other=supportAt(fixture,endpoint,gx,gy)
        if(other===undefined){unknown=true;continue}
        if(other===owner)continue
        // Independent point-to-opposite closed square distance at integer centers.
        const nearestX=Math.max(gx-.5,Math.min(gx+.5,x)),nearestY=Math.max(gy-.5,Math.min(gy+.5,y))
        squared=Math.min(squared,Math.round(4*((x-nearestX)**2+(y-nearestY)**2)))
    }
    return squared|(owner?0:16)|(unknown?64:0)
}
const recordProbes=[]
for(const slot of [0,1]) {
    for(const y of [0,1,2,63,64,65,66,254,255,256])for(let x=0;x<=256;x++)recordProbes.push({slot,x,y})
    for(let y=0;y<=256;y++)for(const x of [0,1,254,255,256])recordProbes.push({slot,x,y})
}
if(process.argv.includes('--prepare-only')) {
    console.log(JSON.stringify({status:'fixtures-prepared',fixtures:fixtures.length,cases:cases.length,positions:probes.length,recordProbes:recordProbes.length}))
} else {
    const server=createServer((_request,response)=>response.end('<!doctype html><title>Flow center cache GPU proof</title>'))
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
    let browser
    try {
        browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-webgpu']})
        const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`)
        const proof=await page.evaluate(async ({buildCode,probeCode,fixtures,cases,positions,atlases,lookupLength})=>{
            const adapter=await navigator.gpu.requestAdapter();if(!adapter)throw new Error('WebGPU unavailable')
            const device=await adapter.requestDevice(),owned=[],errors=[]
            device.addEventListener('uncapturederror',event=>errors.push(event.error.message));device.pushErrorScope('validation')
            try {
                const buffer=(data,usage)=>{const result=device.createBuffer({size:data.byteLength,usage:usage|GPUBufferUsage.COPY_DST});owned.push(result);device.queue.writeBuffer(result,0,data);return result}
                const visibility=GPUShaderStage.COMPUTE
                const uniformLayout=device.createBindGroupLayout({entries:[{binding:0,visibility,buffer:{type:'uniform'}}]})
                const fieldLayout=device.createBindGroupLayout({entries:[
                    {binding:0,visibility,buffer:{type:'read-only-storage'}},{binding:1,visibility,texture:{sampleType:'unfilterable-float'}},
                    {binding:2,visibility,buffer:{type:'read-only-storage'}},{binding:3,visibility,texture:{sampleType:'unfilterable-float'}},
                ]})
                const buildLayout=device.createBindGroupLayout({entries:[
                    {binding:0,visibility,buffer:{type:'read-only-storage'}},{binding:1,visibility,buffer:{type:'storage'}},
                ]})
                const probeLayout=device.createBindGroupLayout({entries:[
                    {binding:1,visibility,buffer:{type:'read-only-storage'}},{binding:2,visibility,buffer:{type:'storage'}},
                ]})
                const cacheLayout=device.createBindGroupLayout({entries:[
                    {binding:0,visibility,buffer:{type:'uniform'}},{binding:1,visibility,buffer:{type:'read-only-storage'}},
                    {binding:2,visibility,buffer:{type:'read-only-storage'}},
                ]})
                async function shader(code) {
                    const module=device.createShaderModule({code}),messages=(await module.getCompilationInfo()).messages.filter(value=>value.type==='error')
                    if(messages.length)throw new Error(messages.map(value=>value.message).join('\n'));return module
                }
                const builder=await device.createComputePipelineAsync({layout:device.createPipelineLayout({bindGroupLayouts:[uniformLayout,fieldLayout,buildLayout]}),
                    compute:{module:await shader(buildCode),entryPoint:'FlowCenterCache_build'}})
                const sampleModule=await shader(probeCode),pipelines=[]
                for(const smoothed of [false,true])pipelines.push(await device.createComputePipelineAsync({
                    layout:device.createPipelineLayout({bindGroupLayouts:[uniformLayout,fieldLayout,probeLayout,cacheLayout]}),
                    compute:{module:sampleModule,entryPoint:'test_cached_boundary',constants:{FLOW_CENTER_SMOOTH:Number(smoothed)}}}))
                const textures={}
                for(const [name,base64] of Object.entries(atlases)) {
                    const texture=device.createTexture({size:[768,256],format:'rg32float',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST})
                    owned.push(texture);textures[name]=texture
                    device.queue.writeTexture({texture},Uint8Array.from(atob(base64),c=>c.charCodeAt(0)),{bytesPerRow:6144},[768,256])
                }
                const pageRecords=257*257,cacheBytes=2*pageRecords*4,count=positions.length/4,rowBytes=count*32
                const records=buffer(new Uint8Array(cacheBytes),GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC)
                const jobs=buffer(new Uint32Array([1,0,1,0,0,0,0,0]),GPUBufferUsage.STORAGE)
                const buildGroup=device.createBindGroup({layout:buildLayout,entries:[{binding:0,resource:{buffer:jobs}},{binding:1,resource:{buffer:records}}]})
                const buildBytes=new ArrayBuffer(16),config=new DataView(buildBytes)
                config.setUint32(4,2,true);config.setUint32(8,lookupLength,true);config.setFloat32(12,.001,true)
                const configBuffer=buffer(buildBytes,GPUBufferUsage.UNIFORM)
                const buildUniform=device.createBindGroup({layout:uniformLayout,entries:[{binding:0,resource:{buffer:configBuffer}}]})
                const positionsBuffer=buffer(new Uint32Array(positions),GPUBufferUsage.STORAGE)
                const readback=device.createBuffer({size:fixtures.length*cacheBytes+cases.length*rowBytes,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});owned.push(readback)
                const encoder=device.createCommandEncoder();let builds=0
                for(const [fixtureIndex,fixture] of fixtures.entries()) {
                    const tables=fixture.pages.map(value=>buffer(new Uint32Array(value),GPUBufferUsage.STORAGE))
                    const fields=device.createBindGroup({layout:fieldLayout,entries:[
                        {binding:0,resource:{buffer:tables[0]}},{binding:1,resource:textures[fixture.lower].createView()},
                        {binding:2,resource:{buffer:tables[1]}},{binding:3,resource:textures[fixture.upper].createView()},
                    ]})
                    const pass=encoder.beginComputePass();pass.setPipeline(builder);pass.setBindGroup(0,buildUniform);pass.setBindGroup(1,fields);pass.setBindGroup(2,buildGroup)
                    pass.dispatchWorkgroups(33,33,2);pass.end();builds++
                    encoder.copyBufferToBuffer(records,0,readback,fixtureIndex*cacheBytes,cacheBytes)
                    for(const [caseIndex,entry] of cases.entries()) {
                        if(entry.fixtureIndex!==fixtureIndex)continue
                        const uniform=buffer(new Uint8Array(entry.uniform),GPUBufferUsage.UNIFORM)
                        const cacheConfig=buffer(new Uint8Array(entry.config),GPUBufferUsage.UNIFORM)
                        const lookup=buffer(new Uint32Array(entry.lookup),GPUBufferUsage.STORAGE)
                        const output=buffer(new Uint8Array(rowBytes),GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC)
                        const uniformGroup=device.createBindGroup({layout:uniformLayout,entries:[{binding:0,resource:{buffer:uniform}}]})
                        const probeGroup=device.createBindGroup({layout:probeLayout,entries:[{binding:1,resource:{buffer:positionsBuffer}},{binding:2,resource:{buffer:output}}]})
                        const cacheGroup=device.createBindGroup({layout:cacheLayout,entries:[{binding:0,resource:{buffer:cacheConfig}},
                            {binding:1,resource:{buffer:lookup}},{binding:2,resource:{buffer:records}}]})
                        const sample=encoder.beginComputePass();sample.setPipeline(pipelines[Number(entry.smoothed)]);sample.setBindGroup(0,uniformGroup)
                        sample.setBindGroup(1,fields);sample.setBindGroup(2,probeGroup);sample.setBindGroup(3,cacheGroup)
                        sample.dispatchWorkgroups(Math.ceil(count/64));sample.end()
                        encoder.copyBufferToBuffer(output,0,readback,fixtures.length*cacheBytes+caseIndex*rowBytes,rowBytes)
                    }
                }
                device.queue.submit([encoder.finish()]);await readback.mapAsync(GPUMapMode.READ)
                const mapped=readback.getMappedRange()
                const packed=new Uint32Array(mapped,0,fixtures.length*cacheBytes/4)
                const values=new Float32Array(mapped,fixtures.length*cacheBytes,cases.length*rowBytes/4)
                const recordResults=fixtures.map((_,index)=>Array.from(packed.slice(index*2*pageRecords,(index+1)*2*pageRecords)))
                const rows=cases.map((_,caseIndex)=>Array.from({length:count},(_,index)=>Array.from(values.slice((caseIndex*count+index)*8,(caseIndex*count+index+1)*8))))
                readback.unmap();await device.queue.onSubmittedWorkDone();const validation=await device.popErrorScope()
                if(validation)throw new Error(validation.message);if(errors.length)throw new Error(errors.join('\n'))
                return {recordResults,rows,builds,errors,readbacks:1}
            } finally {for(const value of owned)value.destroy();device.destroy()}
        },{buildCode,probeCode,fixtures,cases,positions,atlases,lookupLength:lookup.length})
        let maximumCoverageDifference=0,cachedReads=0,directMisses=0,sourceFallbacks=0
        for(const [fixtureIndex,fixture] of fixtures.entries())for(const {slot,x,y} of recordProbes) {
            const packed=proof.recordResults[fixtureIndex][slot*66049+y*257+x]
            const expected=expectedByte(fixture,0,slot*256+x,y)|(expectedByte(fixture,1,slot*256+x,y)<<8)
            assert.equal(packed,expected,`${fixture.name}/slot${slot}/${x},${y}: packed record preserves distance, owner, and unknown-halo semantics`)
        }
        for(const [caseIndex,entry] of cases.entries())for(const [probeIndex,probe] of probes.entries()) {
            const row=proof.rows[caseIndex][probeIndex],difference=Math.abs(row[0]-row[1])
            maximumCoverageDifference=Math.max(maximumCoverageDifference,difference)
            assert.ok(Number.isFinite(row[0])&&difference<2e-6,`${entry.name}/${entry.mode}/${entry.alpha}/${entry.smoothed}/${probe.name}: cache ${row[0]} != direct ${row[1]}`)
            if(entry.mode!=='normal'){assert.equal(row[3],1,'Cache misses use the direct C/D authority');directMisses++}
            else if(row[3]===0){cachedReads++;if(row[4]>0)sourceFallbacks++}
        }
        const result=(name,probe,alpha,smoothed)=>proof.rows[cases.findIndex(entry=>entry.name===name&&entry.mode==='normal'&&entry.alpha===alpha&&entry.smoothed===smoothed)][probes.findIndex(value=>value.name===probe)]
        for(const smoothed of [false,true])for(const alpha of alphas) {
            for(const name of ['hole','diagonal','growth','reversal']) {
                const row=result(name,'square-corner',alpha,smoothed)
                assert.equal(row[3],0,'A known cache hit never re-runs direct center reconstruction')
                assert.equal(row[4],0,'Fully known cached source support never invokes A')
            }
            for(const name of ['missing-lower','missing-upper','growth-unknown-halo']) {
                const row=result(name,'halo-only',alpha,smoothed)
                assert.equal(row[3],0);assert.equal(row[4],1,'Mixed known owners with an unknown outer halo preserve A fallback')
                assert.equal(row[0],row[2])
            }
            for(const [name,coverage] of [['wet-unknown-halo',1],['dry-unknown-halo',0]]) {
                const row=result(name,'halo-only',alpha,smoothed)
                assert.equal(row[0],coverage);assert.equal(row[3],0);assert.equal(row[4],0,'Same-sign owner early-out ignores unknown outer halo')
            }
            for(const name of ['coarse-lower','coarse-upper-reversal']) {
                const row=result(name,'missing-footprint',alpha,smoothed)
                assert.equal(row[3],0);assert.equal(row[4],1);assert.equal(row[5],2);assert.equal(row[6],1)
                assert.equal(row[0],row[2],'Common-level fallback overrides cached fine-center shape')
            }
        }
        for(const smoothed of [false,true])for(const probe of probes)assert.ok(Math.abs(result('join-before',probe.name,1,smoothed)[0]-result('join-after',probe.name,0,smoothed)[0])<1e-7,'Cached endpoint distance is identical across time-pair joins')
        assert.equal(proof.builds,fixtures.length,'Alpha, C/D kernel, and lookup-only variants reuse each cache build')
        console.log(JSON.stringify({status:'passed',fixtures:fixtures.length,cacheBuilds:proof.builds,displayCases:cases.length,totalProbes:cases.length*probes.length,
            packedRecordProbes:fixtures.length*recordProbes.length,maximumCoverageDifference,cachedReads,directMisses,sourceFallbacks,readbacks:proof.readbacks,errors:proof.errors}))
    } finally {await browser?.close();await new Promise(resolve=>server.close(resolve))}
}
