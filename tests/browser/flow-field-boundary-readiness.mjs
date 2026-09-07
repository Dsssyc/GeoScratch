import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { chromium } from 'playwright'
import { WebMercatorQuad, tileMatrixCoverage, webMercatorVirtualRasterField } from 'geoscratch/geo'
import { temporalVelocityWgslModule } from '../../examples/flowField/temporal-velocity-raster.ts'
import { flowScreenProjectionWgsl } from '../../examples/flowField/flow-screen-projection.ts'

// Real generated page-table, cross-page bilinear, parent and edge-blend paths.
// Instrument only function entrances; their actual sampler bodies are unchanged.
const read=name=>readFile(new URL(`../../examples/flowField/shaders/${name}.wgsl`,import.meta.url),'utf8')
const [wrapper,history,support,distance,activity,sdf]=await Promise.all([
    'temporal-velocity','history','presentation-support','boundary-distance','boundary-activity','boundary-sdf',
].map(read))
const gate=sdf.slice(sdf.indexOf('fn FlowBoundary_exact_residency('),sdf.indexOf('fn FlowBoundary_coverage('))
assert.ok(gate.includes('FlowVelocityCurrent_resolution_global('))
assert.ok(gate.includes('FlowVelocityNext_edge_blend_weight('))
assert.doesNotMatch(gate,/_load_global\(|FlowVelocity_sample\(|Registration_(current|next)_resolution/,
    'The gate uses public metadata operations, not texture sampling or private adapter helpers')
const model=webMercatorVirtualRasterField({
    id:'boundary-readiness-proof',addressSpaceId:'boundary-readiness-space',sourceRevision:'v1',
    coverage:tileMatrixCoverage({tileMatrixSet:WebMercatorQuad,limits:[
        {matrixId:'1',minTileRow:0,maxTileRow:1,minTileCol:0,maxTileCol:1},
        {matrixId:'0',minTileRow:0,maxTileRow:0,minTileCol:0,maxTileCol:0},
    ]}),geographicBounds:[-179.9,-85,179.9,85],coordinateBits:52,
    fieldKind:'vector',channels:2,sampleType:'float32',gpuFormat:'rg32float',interpolation:'linear',
})
assert.equal(model.addressSpace.levelCount,2)
assert.equal(model.addressSpace.matrixId(0),'1')
assert.equal(model.addressSpace.matrixId(1),'0')
const quanta=model.addressCodec.worldQuanta/512n
const position=(x,y)=>model.addressCodec.fromWorldQuanta([
    BigInt(Math.round(x*Number(quanta))),BigInt(Math.round(y*Number(quanta))),
])
const table=new Uint32Array(model.addressSpace.pageTableEntryCount*8),fineEntries=[]
for(let row=0;row<2;row++)for(let col=0;col<2;col++) {
    const entry=model.addressCodec.address(position(col*256+.5,row*256+.5),'1').compactIndex
    assert.notEqual(entry,undefined);fineEntries.push(entry)
    table.set([row*2+col,0,0,1,0,0,0,0],entry*8)
}
const coarseEntry=model.addressCodec.address(position(256,256),'0').compactIndex
assert.notEqual(coarseEntry,undefined);table.set([4,0,1,1,0,0,0,0],coarseEntry*8)
const cases=[]
function add(name,options={}) {
    const fixture={name,current:[...table],next:[...table],point:[256,256],requested:0,
        mode:'v3',field:'moving',gate:true,status:1,resolved:0,...options}
    cases.push(fixture);return fixture
}
add('four-fine-corners')
add('resident-zero-still-exact',{field:'zero'})
add('resident-opposite-vectors-still-exact',{field:'opposite'})
for(const endpoint of ['current','next'])for(const [label,status] of [['missing',0],['failed',4],['coarse',2]]) {
    for(let corner=0;corner<4;corner++) {
        const fixture=add(`${endpoint}-${label}-corner-${corner}`,{gate:false,status,resolved:status===2?1:0})
        fixture[endpoint].splice(fineEntries[corner]*8,8,...(status===2?[4,0,1,2,0,0,0,0]:[0,0,0,status,0,0,0,0]))
    }
}
for(const endpoint of ['current','next','both']) {
    // Registered x=254.25: all four samples lie in the left fine page,
    // but its neighboring right page is coarse, inside the 4-texel blend band.
    const fixture=add(`${endpoint}-adjacent-coarse-blend`,{point:[254.75,64.75],gate:false,status:2,resolved:1,edgeOnly:endpoint})
    for(const side of endpoint==='both'?['current','next']:[endpoint])fixture[side].splice(fineEntries[1]*8,8,4,0,1,2,0,0,0,0)
}
const outsideBand=add('adjacent-coarse-outside-transition-band',{point:[250.75,64.75]})
outsideBand.current.splice(fineEntries[1]*8,8,4,0,1,2,0,0,0,0)
const missingNeighbor=add('unqueried-adjacent-missing-is-not-a-coarse-transition',{point:[254.75,64.75]})
missingNeighbor.next.splice(fineEntries[1]*8,8,0,0,0,0,0,0,0,0)
const last=add('last-level-does-not-query-edge-blend',{requested:1,resolved:1})
for(const side of ['current','next'])for(const entry of fineEntries)last[side].splice(entry*8,8,4,0,1,2,0,0,0,0)
add('legacy-pixel-center-defers-to-A',{mode:'legacy-pixel-center'})
add('legacy-global-adapter-compiles-and-defers-to-A',{mode:'legacy-global'})
const struct=history.match(/struct FlowFieldHistoryUniform \{[\s\S]*?\n\};/)?.[0]
assert.ok(struct)
const commonInstrumentation=`
@group(3) @binding(0) var<storage,read> probePosition:FlowVelocityAddressFixedPosition;
@group(3) @binding(1) var<storage,read_write> result:array<atomic<u32>>;
fn FlowVelocity_sample(p:FlowVelocityAddressFixedPosition,l:u32,t:FlowVelocityTemporal)->FlowVelocitySample {
    atomicAdd(&result[5],1u);return Fixture_actual_velocity_sample(p,l,t);
}
fn FlowPresentation_coverage(p:FlowVelocityAddressFixedPosition,l:u32,a:f32,k:f32)->f32 {
    atomicAdd(&result[6],1u);return Fixture_actual_presentation_coverage(p,l,a,k);
}
fn FlowVelocityCurrent_edge_blend_weight(p:FlowVelocityAddressFixedPosition,l:u32)->f32 {
    atomicAdd(&result[7],1u);return Fixture_current_edge_blend_weight(p,l);
}
fn FlowVelocityNext_edge_blend_weight(p:FlowVelocityAddressFixedPosition,l:u32)->f32 {
    atomicAdd(&result[8],1u);return Fixture_next_edge_blend_weight(p,l);
}
@compute @workgroup_size(1)
fn test_readiness() {
    let p=probePosition;let l=boundaryUniform.requestedLevel;
    let exact=FlowBoundary_exact_residency(p,l);
    atomicStore(&result[0],select(0u,1u,exact));
    atomicStore(&result[9],atomicLoad(&result[5]));
    atomicStore(&result[10],atomicLoad(&result[7]));atomicStore(&result[11],atomicLoad(&result[8]));
    let actual=FlowVelocity_sample(p,l,FlowVelocityTemporal(boundaryUniform.progress,boundaryUniform.activityKill));
    atomicStore(&result[1],actual.status);atomicStore(&result[2],actual.resolved_level);
    atomicStore(&result[18],select(0u,1u,actual.advectable));atomicStore(&result[19],bitcast<u32>(actual.speed));
    let before=atomicLoad(&result[5]);let beforeA=atomicLoad(&result[6]);
    atomicStore(&result[3],bitcast<u32>(FlowBoundary_coverage(p)));
    atomicStore(&result[12],atomicLoad(&result[5])-before);atomicStore(&result[13],atomicLoad(&result[6])-beforeA);
    atomicStore(&result[4],bitcast<u32>(Fixture_actual_presentation_coverage(p,l,boundaryUniform.progress,boundaryUniform.activityKill)));
    let registered=FlowVelocityRegistration_position(p,l);
    atomicStore(&result[14],bitcast<u32>(Fixture_current_edge_blend_weight(registered,l)));
    atomicStore(&result[15],bitcast<u32>(Fixture_next_edge_blend_weight(registered,l)));
    let address=FlowVelocityAddress_address(registered,FlowVelocityCurrent_matrix[l]);
    let base=vec2i(address.tile*FlowVelocityCurrent_page_size+address.texel);
    var currentFine=0u;var nextFine=0u;
    for(var i=0u;i<4u;i++) {
        let global=base+vec2i(i32(i%2u),i32(i/2u));
        currentFine+=select(0u,1u,all(FlowVelocityCurrent_resolution_global(global,l)==vec2u(1u,l)));
        nextFine+=select(0u,1u,all(FlowVelocityNext_resolution_global(global,l)==vec2u(1u,l)));
    }
    atomicStore(&result[16],currentFine);atomicStore(&result[17],nextFine);
}`
const codes={}
for(const mode of ['v3','legacy-pixel-center','legacy-global']) {
    const temporal=temporalVelocityWgslModule(model,model,{group:1,currentPageTableBinding:0,currentAtlasBinding:1,
        nextPageTableBinding:2,nextAtlasBinding:3,wrapper,transitionTexels:4,
        sampleRegistration:mode==='legacy-global'?'global-texel-lattice':'pixel-center',
        activitySupport:mode==='v3'?'nearest-texel-zero':'bilinear'})
    const sampled=temporal.code.replace('fn FlowVelocity_sample(', 'fn Fixture_actual_velocity_sample(')
        .replace('fn FlowVelocityCurrent_edge_blend_weight(', 'fn Fixture_current_edge_blend_weight(')
        .replace('fn FlowVelocityNext_edge_blend_weight(', 'fn Fixture_next_edge_blend_weight(')
    codes[mode]=[sampled,flowScreenProjectionWgsl(model.addressCodec),struct,
        support.replace('fn FlowPresentation_coverage(', 'fn Fixture_actual_presentation_coverage('),
        distance,activity,sdf,commonInstrumentation].join('\n')
}
for(const fixture of cases) {
    fixture.limbs=position(...fixture.point).fixed.limbs.flatMap(axis=>[axis.low,axis.high])
}
if(process.argv.includes('--prepare-only')) {
    console.log(JSON.stringify({status:'fixtures-prepared',cases:cases.length,levels:['1','0'],pages:model.addressSpace.pageTableEntryCount}))
} else {
    const server=createServer((_req,res)=>res.end('<!doctype html><title>Flow exact-residency proof</title>'))
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
    let browser
    try {
        browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-webgpu']})
        const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`)
        const proof=await page.evaluate(async ({codes,cases})=>{
            const adapter=await navigator.gpu.requestAdapter();if(!adapter)throw new Error('WebGPU unavailable')
            const device=await adapter.requestDevice(),owned=[],errors=[]
            device.addEventListener('uncapturederror',e=>errors.push(e.error.message));device.pushErrorScope('validation')
            try {
                const layouts=[
                    device.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.COMPUTE,buffer:{type:'uniform',minBindingSize:352}}]}),
                    device.createBindGroupLayout({entries:[
                        {binding:0,visibility:GPUShaderStage.COMPUTE,buffer:{type:'read-only-storage'}},
                        {binding:1,visibility:GPUShaderStage.COMPUTE,texture:{sampleType:'unfilterable-float'}},
                        {binding:2,visibility:GPUShaderStage.COMPUTE,buffer:{type:'read-only-storage'}},
                        {binding:3,visibility:GPUShaderStage.COMPUTE,texture:{sampleType:'unfilterable-float'}},
                    ]}),
                    device.createBindGroupLayout({entries:[]}),
                    device.createBindGroupLayout({entries:[
                        {binding:0,visibility:GPUShaderStage.COMPUTE,buffer:{type:'read-only-storage'}},
                        {binding:1,visibility:GPUShaderStage.COMPUTE,buffer:{type:'storage'}},
                    ]}),
                ]
                const layout=device.createPipelineLayout({bindGroupLayouts:layouts})
                const pipeline={}
                for(const [mode,code] of Object.entries(codes)) {
                    const module=device.createShaderModule({code})
                    const messages=(await module.getCompilationInfo()).messages.filter(v=>v.type==='error')
                    if(messages.length)throw new Error(`${mode}: ${messages.map(v=>v.message).join('\n')}`)
                    pipeline[mode]=await device.createComputePipelineAsync({layout,compute:{module,entryPoint:'test_readiness'}})
                }
                const buffer=(data,usage)=>{const b=device.createBuffer({size:data.byteLength,usage:usage|GPUBufferUsage.COPY_DST});owned.push(b);device.queue.writeBuffer(b,0,data);return b}
                const atlases={}
                for(const u of [2,-2,0]) {
                    const pixels=new Float32Array(1280*256*2);for(let i=0;i<pixels.length;i+=2)pixels[i]=u
                    const texture=device.createTexture({size:[1280,256],format:'rg32float',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST})
                    owned.push(texture);device.queue.writeTexture({texture},pixels,{bytesPerRow:1280*8},[1280,256]);atlases[u]=texture
                }
                const observed=[]
                for(const fixture of cases) {
                    const p=pipeline[fixture.mode],uniform=new ArrayBuffer(352),view=new DataView(uniform)
                    view.setUint32(328,fixture.requested,true);view.setFloat32(332,.5,true)
                    view.setFloat32(336,.001,true);view.setFloat32(340,.35,true)
                    const controls=buffer(uniform,GPUBufferUsage.UNIFORM)
                    const lower=buffer(new Uint32Array(fixture.current),GPUBufferUsage.STORAGE),upper=buffer(new Uint32Array(fixture.next),GPUBufferUsage.STORAGE)
                    const position=buffer(new Uint32Array(fixture.limbs),GPUBufferUsage.STORAGE)
                    const output=buffer(new Uint32Array(20),GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC)
                    const readback=device.createBuffer({size:80,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});owned.push(readback)
                    const groups=[
                        device.createBindGroup({layout:p.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:controls}}]}),
                        device.createBindGroup({layout:p.getBindGroupLayout(1),entries:[
                            {binding:0,resource:{buffer:lower}},{binding:1,resource:atlases[fixture.field==='zero'?0:2].createView()},
                            {binding:2,resource:{buffer:upper}},{binding:3,resource:atlases[fixture.field==='zero'?0:fixture.field==='opposite'?-2:2].createView()}]}),
                        device.createBindGroup({layout:p.getBindGroupLayout(2),entries:[]}),
                        device.createBindGroup({layout:p.getBindGroupLayout(3),entries:[{binding:0,resource:{buffer:position}},{binding:1,resource:{buffer:output}}]}),
                    ]
                    const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(p)
                    groups.forEach((group,index)=>pass.setBindGroup(index,group));pass.dispatchWorkgroups(1);pass.end()
                    encoder.copyBufferToBuffer(output,0,readback,0,80);device.queue.submit([encoder.finish()]);await readback.mapAsync(GPUMapMode.READ)
                    const mapped=readback.getMappedRange()
                    const raw=new Uint32Array(mapped),f=new Float32Array(mapped)
                    observed.push({name:fixture.name,gate:raw[0]===1,status:raw[1],resolved:raw[2],coverage:f[3],hard:f[4],
                        gateVelocityCalls:raw[9],gateEdgeCalls:[raw[10],raw[11]],bVelocityCalls:raw[12],bHardCalls:raw[13],
                        edgeWeights:[f[14],f[15]],fineCorners:[raw[16],raw[17]],advectable:raw[18]===1,speed:f[19]})
                    readback.unmap()
                }
                await device.queue.onSubmittedWorkDone();const validation=await device.popErrorScope()
                if(validation)throw new Error(validation.message);if(errors.length)throw new Error(errors.join('\n'))
                return {observed,errors}
            } finally {for(const resource of owned)resource.destroy();device.destroy()}
        },{codes,cases})
        for(const [index,result] of proof.observed.entries()) {
            const fixture=cases[index]
            assert.deepEqual([result.gate,result.status,result.resolved],[fixture.gate,fixture.status,fixture.resolved],fixture.name)
            assert.equal(result.gate,result.status===1&&result.resolved===fixture.requested,`${fixture.name}: metadata proof agrees with actual generated sampler`)
            assert.equal(result.gateVelocityCalls,0,'Metadata gate never evaluates a velocity sample')
            const positive=fixture.mode==='v3'&&fixture.gate
            assert.equal(result.bHardCalls,positive?0:1,`${fixture.name}: only rejected or legacy boundaries defer to A`)
            assert.equal(result.bVelocityCalls,positive?0:1,`${fixture.name}: positive B path avoids the full velocity sampler`)
            assert.ok(Math.abs(result.coverage-result.hard)<1e-6,`${fixture.name}: B agrees with A for these homogeneous source fixtures`)
            if(fixture.field==='zero')assert.equal(result.coverage,0)
            if(fixture.field==='opposite')assert.ok(!result.advectable&&result.coverage===1)
            if(fixture.edgeOnly) {
                assert.deepEqual(result.fineCorners,[4,4],'Edge transition counterexample has four fine corners at both endpoints')
                for(const [side,at] of [['current',0],['next',1]]) {
                    assert.equal(result.edgeWeights[at]<1,fixture.edgeOnly===side||fixture.edgeOnly==='both')
                }
            }
            if(fixture.requested===1)assert.deepEqual(result.gateEdgeCalls,[0,0],'Last-level gate must skip edge blending')
        }
        console.log(JSON.stringify({status:'passed',cases:proof.observed,errors:proof.errors}))
    } finally {await browser?.close();await new Promise(resolve=>server.close(resolve))}
}
