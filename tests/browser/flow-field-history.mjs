import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { WebMercatorQuad, tileMatrixCoverage, webMercatorVirtualRasterField } from 'geoscratch/geo'
import { flowScreenProjectionWgsl } from '../../examples/flowField/flow-screen-projection.ts'
import { temporalVelocityWgslModule } from '../../examples/flowField/temporal-velocity-raster.ts'

const model = webMercatorVirtualRasterField({
    id:'history-proof',addressSpaceId:'history-proof-space',sourceRevision:'v1',
    coverage:tileMatrixCoverage({tileMatrixSet:WebMercatorQuad,
        limits:[{matrixId:'0',minTileRow:0,maxTileRow:0,minTileCol:0,maxTileCol:0}]}),
    geographicBounds:[-180,-85,180,85],coordinateBits:52,
    fieldKind:'vector',channels:2,sampleType:'float32',gpuFormat:'rg32float',interpolation:'linear',
})
const read = name => readFile(new URL(`../../examples/flowField/shaders/${name}.wgsl`,import.meta.url),'utf8')
const [historyShader,presentationSupportShader,supportShader,hardShader,wrapper] = await Promise.all([
    'history','presentation-support','history-support','hard-boundary','temporal-velocity',
].map(read))
const projection = flowScreenProjectionWgsl(model.addressCodec)
const uniformStruct = historyShader.match(/struct FlowFieldHistoryUniform \{[\s\S]*?\n\};/)?.[0]
assert.ok(uniformStruct,'Read the actual shared uniform ABI')
assert.ok(!historyShader.includes('FlowHistory_coverage('),'Raw retention cannot destroy ink from current support')
const temporal = temporalVelocityWgslModule(model,model,{
    group:1,currentPageTableBinding:0,currentAtlasBinding:1,nextPageTableBinding:2,nextAtlasBinding:3,
    sampleRegistration:'pixel-center',activitySupport:'nearest-texel-zero',wrapper,
})
// Reuse the actual generated wide-fixed position adapter, without its unrelated
// texture sampler wrappers. The stub below controls texel values explicitly.
const registrationStart=temporal.code.indexOf('const FlowVelocityRegistration_half_texel')
const registrationEnd=temporal.code.indexOf('fn FlowVelocityRegistration_current_resolution(')
assert.ok(registrationStart>=0 && registrationEnd>registrationStart)
const registration=temporal.code.slice(registrationStart,registrationEnd)
const camera = model.addressCodec.fromProjected([13_360_000.125,3_503_000.25]).fixed.limbs
const fixture = `
struct FlowVelocityTemporal { progress:f32, activityKill:f32, }
struct FlowVelocitySample { status:u32, velocity:vec2f, speed:f32, advectable:bool, resolved_level:u32, }
struct FixtureTexel { status:u32, value:vec4f, resolved_level:u32, }
@group(1) @binding(0) var<uniform> testVelocity:vec4f;
@group(1) @binding(1) var<storage,read_write> testSampleCalls:atomic<u32>;
@group(1) @binding(2) var<uniform> testSupport:vec4f;
const FlowVelocity_nearest_zero_gate = true;
const FlowVelocityCurrent_level_count=1u;
const FlowVelocityCurrent_page_size=vec2u(256u);
const FlowVelocityCurrent_matrix=array<u32,1>(0u);
const FlowVelocityCurrent_minimum_texel=array<vec2u,1>(vec2u(0u));
const FlowVelocityCurrent_maximum_texel=array<vec2u,1>(vec2u(255u));
const FlowVelocityNext_minimum_texel=array<vec2u,1>(vec2u(0u));
const FlowVelocityNext_maximum_texel=array<vec2u,1>(vec2u(255u));
fn fixture_center(p:vec2i,l:u32,next:bool)->FixtureTexel {
    let mode=u32(testSupport.x);
    if (mode==0u) { return FixtureTexel(u32(testVelocity.z),vec4f(testVelocity.xy,0,0),l); }
    var v=select(vec2f(1,0),vec2f(-1,0),next);
    let selected=(p.x%2==0 && p.y%2==1);
    if ((mode==2u && selected) || (mode==3u && next)) { v=vec2f(0); }
    if (mode==4u && selected) { v=vec2f(0.0001,0); }
    if (mode==5u && selected) { return FixtureTexel(1u,vec4f(v,0,0),l+1u); }
    if (mode==6u && selected) { return FixtureTexel(4u,vec4f(v,0,0),l); }
    if (mode==7u && selected) { return FixtureTexel(0u,vec4f(v,0,0),l); }
    if (mode==8u && p.x%2==1 && p.y%2==1) { v=vec2f(0); }
    if (mode==9u && !next && selected) { v=vec2f(0); }
    if ((mode==9u && next) || (mode==10u && !next)) {
        v=vec2f(f32(p.x)-212.84394530223088,f32(p.y)-105.12276504995907);
    }
    return FixtureTexel(1u,vec4f(v,0,0),l);
}
fn FlowVelocityCurrent_load_global(p:vec2i,l:u32)->FixtureTexel { return fixture_center(p,l,false); }
fn FlowVelocityNext_load_global(p:vec2i,l:u32)->FixtureTexel { return fixture_center(p,l,true); }
fn FlowVelocity_source_contains(position:FlowVelocityAddressFixedPosition)->bool {
    let x=position.axes[0];
    return testVelocity.w<1.5 && !(testVelocity.w>0.5 &&
        (x.high>${camera[0].high}u || (x.high==${camera[0].high}u && x.low>=${camera[0].low}u)));
}
fn FlowVelocity_sample(position:FlowVelocityAddressFixedPosition,level:u32,temporal:FlowVelocityTemporal)->FlowVelocitySample {
    atomicAdd(&testSampleCalls,1u);
    let speed=length(testVelocity.xy);let x=position.axes[0];
    let outside=testVelocity.w>0.5 &&
        (x.high>${camera[0].high}u || (x.high==${camera[0].high}u && x.low>=${camera[0].low}u));
    return FlowVelocitySample(select(u32(testVelocity.z),0u,outside),testVelocity.xy,speed,speed>0.0 && speed>=temporal.activityKill,level);
}`
const stub = model.addressCodec.wgslModule({namespace:'FlowVelocityAddress'})+'\n'+registration+'\n'+fixture+'\n'+projection+'\n'
const testHard = stub+uniformStruct+'\n'+presentationSupportShader+'\n'+supportShader+'\n'+hardShader
const realHard = temporal.code+'\n'+projection+'\n'+uniformStruct+'\n'+presentationSupportShader+'\n'+supportShader+'\n'+hardShader
const emptyGuard = hardShader.match(/^\s*if \(color\.a == 0\.0[^\n]*\n/m)?.[0]
assert.ok(emptyGuard,'The presentation skips sampling transparent or empty ink')
const eagerHard = stub+uniformStruct+'\n'+presentationSupportShader+'\n'+supportShader+'\n'+hardShader.replace(emptyGuard,'\n')
const legacyHard = testHard.replace('const FlowVelocity_nearest_zero_gate = true;', 'const FlowVelocity_nearest_zero_gate = false;')
const legacyEagerHard = eagerHard.replace('const FlowVelocity_nearest_zero_gate = true;', 'const FlowVelocity_nearest_zero_gate = false;')
// Counterfactual only: reinsert the former destructive support check into a
// separate raw-history pipeline to prove why a transient zero left a scar.
const legacyRaw = stub+presentationSupportShader+'\n'+supportShader+'\n'+historyShader.replace('    return faded;',
    '    if (FlowHistory_coverage(input.texcoords) <= 0.0) { return vec4f(0.0); }\n    return faded;')
const fixtures = [
    {name:'moving',velocity:[1,0,1,0]},
    {name:'fallback-moving',velocity:[1,0,2,0]},
    {name:'fallback-zero-unknown',velocity:[0,0,2,0]},
    {name:'outside-source',velocity:[0,0,0,2],hidden:true,calls:0,eagerCalls:0},
    {name:'zero-even-with-zero-threshold',velocity:[0,0,1,0],threshold:0,hidden:true},
    {name:'unavailable',velocity:[1,0,0,0]},
    {name:'no-data-unknown',velocity:[1,0,3,0]},
    {name:'failed',velocity:[1,0,4,0],hidden:true},
    {name:'below-threshold',velocity:[0.0001,0,1,0],hidden:true},
    {name:'common-interior-current-zero',velocity:[0,0,1,0],support:1},
    {name:'common-interior-current-low',velocity:[0.0001,0,1,0],support:1},
    {name:'common-interior-zero-kill',velocity:[0,0,1,0],support:1,threshold:0},
    {name:'common-interior-empty-ink',velocity:[0,0,1,0],support:1,pixels:Array(32).fill(0),calls:0},
    {name:'one-dry-corner',velocity:[0,0,1,0],support:2,progress:.5,weighted:true},
    {name:'one-dry-endpoint',velocity:[0,0,1,0],support:3,progress:.5,weighted:true},
    {name:'one-dry-endpoint-at-dry-time',velocity:[0,0,1,0],support:3,progress:1,hidden:true},
    {name:'one-weak-corner',velocity:[0,0,1,0],support:4,progress:.5,weighted:true},
    {name:'one-coarse-corner',velocity:[0,0,1,0],support:5,hidden:true},
    {name:'one-failed-corner',velocity:[0,0,1,0],support:6,hidden:true},
    {name:'one-unknown-corner',velocity:[0,0,1,0],support:7,hidden:true},
    {name:'both-owning-centers-zero',velocity:[0,0,1,0],support:8,hidden:true},
    {name:'shared-spatial-zero-pair-before',velocity:[0,0,1,0],support:9,progress:1},
    {name:'shared-spatial-zero-pair-after',velocity:[0,0,1,0],support:10,progress:0},
    {name:'shared-spatial-zero-before-limit',velocity:[0,0,1,0],support:9,progress:.999999,weighted:true},
    {name:'shared-spatial-zero-after-limit',velocity:[0,0,1,0],support:10,progress:.000001},
    {name:'common-interior-current-failed',velocity:[0,0,4,0],support:1,hidden:true},
    {name:'legacy-current-zero-with-supported-corners',velocity:[0,0,1,0],support:1,legacy:true,hidden:true},
    {name:'no-camera-drift',velocity:[1,0,1,0],reproject:true},
    {name:'low-limb-camera-shift',velocity:[1,0,1,0],reproject:true,centerShift:0.25,calls:7},
    {name:'empty-history',velocity:[1,0,1,0],pixels:Array(32).fill(0),calls:0},
    {name:'faded-to-cutoff',velocity:[1,0,1,0],
        pixels:Array.from({length:32},(_,index)=>index%4===3?255:2),calls:0},
    {name:'above-cutoff',velocity:[1,0,1,0],
        pixels:Array.from({length:32},(_,index)=>[3,0,0,255][index%4])},
    {name:'transparent-colored-history',velocity:[1,0,1,0],
        pixels:Array.from({length:32},(_,index)=>[180,50,5,0][index%4]),calls:0},
    {name:'invalid-history-projection',velocity:[1,0,1,0],reproject:true,historyValid:false,calls:0},
    {name:'invalid-current-ground',velocity:[1,0,1,0],groundInvalid:true,calls:0,eagerCalls:0,hidden:true},
    {name:'reprojected-source-empty',velocity:[1,0,1,0],reproject:true,centerShift:0.25,
        pixels:[16,255,128,255,...Array(28).fill(0)],calls:0},
    {name:'reprojected-source-populated',velocity:[1,0,1,0],reproject:true,centerShift:0.25,
        pixels:[...Array(4).fill(0),40,255,128,255,...Array(24).fill(0)],calls:1},
    {name:'current-boundary-after-reprojection',velocity:[1,0,1,1],reproject:true,centerShift:0.25,calls:4,eagerCalls:4},
]
const server = createServer((_request,response)=>response.end('<!doctype html><title>Flow raw retention and hard visibility proof</title>'))
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
let browser
try {
    browser = await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-webgpu']})
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    const proof = await page.evaluate(async ({historyShader,testHard,eagerHard,legacyHard,legacyEagerHard,legacyRaw,realHard,camera,fixtures})=>{
        const adapter=await navigator.gpu.requestAdapter()
        if(!adapter)throw new Error('WebGPU adapter unavailable')
        const device=await adapter.requestDevice(),owned=[],errors=[]
        device.addEventListener('uncapturederror',event=>errors.push(event.error.message))
        device.pushErrorScope('validation')
        try {
            const layout0=device.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.FRAGMENT,buffer:{type:'uniform',minBindingSize:352}}]})
            const layout1=device.createBindGroupLayout({entries:[
                {binding:0,visibility:GPUShaderStage.FRAGMENT,buffer:{type:'uniform',minBindingSize:16}},
                {binding:1,visibility:GPUShaderStage.FRAGMENT,buffer:{type:'storage',minBindingSize:4}},
                {binding:2,visibility:GPUShaderStage.FRAGMENT,buffer:{type:'uniform',minBindingSize:16}},
            ]})
            const layout2=device.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:'float'}}]})
            const layout=device.createPipelineLayout({bindGroupLayouts:[layout0,layout1,layout2]})
            async function pipeline(code,depth=false,explicit=true) {
                const module=device.createShaderModule({code})
                const compilation=(await module.getCompilationInfo()).messages.filter(value=>value.type==='error')
                if(compilation.length)throw new Error(compilation.map(value=>value.message).join('\n'))
                return await device.createRenderPipelineAsync({layout:explicit?layout:'auto',
                    vertex:{module,entryPoint:'vMain'},fragment:{module,entryPoint:'fMain',targets:[{format:'rgba8unorm'}]},
                    primitive:{topology:'triangle-strip'},
                    ...(depth?{depthStencil:{format:'depth32float',depthWriteEnabled:false,depthCompare:'less'}}:{}),
                })
            }
            // Real source composition compiles separately from the instrumented
            // fake sample values. Raw retention compiles with no Flow module.
            await pipeline(realHard,false,false)
            const rawPipeline=await pipeline(historyShader,true)
            const hardPipeline=await pipeline(testHard)
            const eagerPipeline=await pipeline(eagerHard)
            const legacyHardPipeline=await pipeline(legacyHard)
            const legacyEagerPipeline=await pipeline(legacyEagerHard)
            const legacyPipeline=await pipeline(legacyRaw,true)
            const freshPipeline=await pipeline(`
@vertex fn vMain(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
    let p=array<vec2f,4>(vec2f(-1,-1),vec2f(-1,1),vec2f(1,-1),vec2f(1,1));return vec4f(p[i],0,1);
}
@fragment fn fMain()->@location(0) vec4f {return vec4f(0.2,0.6,0.8,1);}`,false,false)
            const buffer=(data,usage)=>{
                const value=device.createBuffer({size:data.byteLength,usage:usage|GPUBufferUsage.COPY_DST})
                device.queue.writeBuffer(value,0,data);owned.push(value);return value
            }
            const readBuffer=size=>{const value=device.createBuffer({size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});owned.push(value);return value}
            const size={width:8,height:1}
            const texture=(format='rgba8unorm')=>{
                const value=device.createTexture({size,format,usage:format==='depth32float'?GPUTextureUsage.RENDER_ATTACHMENT:
                    GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.COPY_SRC|GPUTextureUsage.RENDER_ATTACHMENT})
                owned.push(value);return value
            }
            const history=texture(),rawA=texture(),rawB=texture(),visible=texture(),legacy=texture(),depth=texture('depth32float')
            const initial=new Uint8Array(32)
            for(let x=0;x<8;x++)initial.set([16+x*24,255,128,255],x*4)
            const calls=buffer(new Uint32Array(1),GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC)
            function uniform(fixture={}) {
                const bytes=new ArrayBuffer(352),view=new DataView(bytes)
                const put=(offset,value)=>view.setFloat32(offset,value,true)
                const vec=(offset,values)=>values.forEach((value,index)=>put(offset+index*4,value))
                put(0,0.996);put(4,1/255);put(8,2);put(12,fixture.historyValid===false?0:1);put(16,fixture.reproject?1:0)
                const identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],previous=[...identity],inverse=[...identity]
                previous[10]=0;previous[14]=0.5;inverse[10]=fixture.groundInvalid?1:-1
                vec(32,previous);vec(96,identity);vec(160,inverse)
                vec(224,[13_360_000,3_503_000,0.5]);vec(240,[0.125-(fixture.centerShift??0),0.25,0])
                vec(256,[13_360_000,3_503_000,0.5]);vec(272,[0.125,0.25,0])
                vec(288,[8,1]);vec(296,[8,1])
                camera.flatMap(axis=>[axis.low,axis.high]).forEach((value,index)=>view.setUint32(304+index*4,value,true))
                vec(320,[0.5,0]);put(332,fixture.progress??(fixture.support===1?.5:0));put(336,fixture.threshold??0.001);put(340,0.25)
                const resource=buffer(bytes,GPUBufferUsage.UNIFORM)
                return device.createBindGroup({layout:layout0,entries:[{binding:0,resource:{buffer:resource}}]})
            }
            function velocity(values,support=0) {
                const resource=buffer(new Float32Array(values),GPUBufferUsage.UNIFORM)
                const centers=buffer(new Float32Array([support,0,0,0]),GPUBufferUsage.UNIFORM)
                return device.createBindGroup({layout:layout1,entries:[{binding:0,resource:{buffer:resource}},{binding:1,resource:{buffer:calls}},
                    {binding:2,resource:{buffer:centers}}]})
            }
            function draw(encoder,pipeline,input,target,config,source,withDepth=false) {
                const pass=encoder.beginRenderPass({colorAttachments:[{view:target.createView(),loadOp:'clear',storeOp:'store',clearValue:[0,0,0,0]}],
                    ...(withDepth?{depthStencilAttachment:{view:depth.createView(),depthLoadOp:'clear',depthStoreOp:'store',depthClearValue:1}}:{})})
                pass.setPipeline(pipeline)
                if(config)pass.setBindGroup(0,config)
                if(source)pass.setBindGroup(1,source)
                if(input)pass.setBindGroup(2,device.createBindGroup({layout:layout2,entries:[{binding:0,resource:input.createView()}]}))
                pass.draw(4);pass.end()
            }
            const copy=(encoder,texture,read,index)=>encoder.copyTextureToBuffer({texture},{buffer:read,offset:index*256,bytesPerRow:256},size)
            const results=[]
            for(const fixture of fixtures) {
                device.queue.writeTexture({texture:history},fixture.pixels?new Uint8Array(fixture.pixels):initial,{bytesPerRow:32},size)
                const config=uniform(fixture),source=velocity(fixture.velocity,fixture.support),pixelsRead=readBuffer(3*256),countRead=readBuffer(12)
                const encoder=device.createCommandEncoder();encoder.clearBuffer(calls)
                draw(encoder,rawPipeline,history,rawA,config,source,true)
                copy(encoder,rawA,pixelsRead,0);encoder.copyBufferToBuffer(calls,0,countRead,0,4)
                draw(encoder,fixture.legacy?legacyHardPipeline:hardPipeline,rawA,visible,config,source)
                copy(encoder,visible,pixelsRead,1);encoder.copyBufferToBuffer(calls,0,countRead,4,4)
                encoder.clearBuffer(calls)
                draw(encoder,fixture.legacy?legacyEagerPipeline:eagerPipeline,rawA,visible,config,source)
                copy(encoder,visible,pixelsRead,2);encoder.copyBufferToBuffer(calls,0,countRead,8,4)
                device.queue.submit([encoder.finish()])
                await Promise.all([pixelsRead.mapAsync(GPUMapMode.READ),countRead.mapAsync(GPUMapMode.READ)])
                const bytes=new Uint8Array(pixelsRead.getMappedRange()),counts=new Uint32Array(countRead.getMappedRange())
                results.push({name:fixture.name,raw:Array.from(bytes.slice(0,32)),hard:Array.from(bytes.slice(256,288)),
                    eager:Array.from(bytes.slice(512,544)),rawCalls:counts[0],hardCalls:counts[1],eagerCalls:counts[2]})
                pixelsRead.unmap();countRead.unmap()
            }
            // Real texture chain: current zero hides both old/fresh ink only at
            // presentation. Recovery reads rawB, never the black visible target.
            device.queue.writeTexture({texture:history},initial,{bytesPerRow:32},size)
            const config=uniform(),zero=velocity([0,0,1,0]),moving=velocity([1,0,1,0])
            const chainRead=readBuffer(9*256),encoder=device.createCommandEncoder()
            draw(encoder,rawPipeline,history,rawA,config,zero,true);copy(encoder,rawA,chainRead,0)
            draw(encoder,hardPipeline,rawA,visible,config,zero);copy(encoder,visible,chainRead,1)
            draw(encoder,rawPipeline,rawA,rawB,config,zero,true)
            draw(encoder,hardPipeline,rawB,visible,config,moving);copy(encoder,visible,chainRead,2)
            draw(encoder,legacyPipeline,history,legacy,config,zero,true);copy(encoder,legacy,chainRead,3)
            draw(encoder,hardPipeline,legacy,visible,config,moving);copy(encoder,visible,chainRead,4)
            let source=rawB,target=rawA
            for(let step=2;step<256;step++) {draw(encoder,rawPipeline,source,target,config,zero,true);[source,target]=[target,source]}
            copy(encoder,source,chainRead,5)
            draw(encoder,hardPipeline,source,visible,config,moving);copy(encoder,visible,chainRead,6)
            draw(encoder,freshPipeline,undefined,rawA);copy(encoder,rawA,chainRead,7)
            draw(encoder,hardPipeline,rawA,visible,config,zero);copy(encoder,visible,chainRead,8)
            device.queue.submit([encoder.finish()]);await chainRead.mapAsync(GPUMapMode.READ)
            const chainBytes=new Uint8Array(chainRead.getMappedRange())
            const chain=Array.from({length:9},(_,index)=>Array.from(chainBytes.slice(index*256,index*256+32)))
            chainRead.unmap();await device.queue.onSubmittedWorkDone()
            const validation=await device.popErrorScope()
            if(validation)throw new Error(validation.message)
            if(errors.length)throw new Error(errors.join('\n'))
            return {results,chain,errors}
        } finally {owned.forEach(value=>value.destroy());device.destroy()}
    },{historyShader,testHard,eagerHard,legacyHard,legacyEagerHard,legacyRaw,realHard,camera,fixtures})
    const initial=Array.from({length:32},(_,index)=>[16+Math.floor(index/4)*24,255,128,255][index%4])
    const faded=decay(initial),row=name=>proof.results.find(value=>value.name===name)
    for(const fixture of fixtures) {
        const result=row(fixture.name)
        let raw=decay(fixture.pixels??initial)
        if(fixture.reproject && fixture.historyValid===false)raw=Array(32).fill(0)
        else if(fixture.centerShift)raw=[...raw.slice(4),0,0,0,0]
        assert.deepEqual(result.raw,raw,`${fixture.name}: support cannot alter raw retention`)
        assert.equal(result.rawCalls,0,`${fixture.name}: raw retention must never sample velocity`)
        const expected=raw.map((value,index)=>index%4!==3?value:
            Math.round(value*expectedCoverage(fixture,Math.floor(index/4))))
        if(fixture.weighted) {
            result.hard.forEach((value,index)=>assert.ok(Math.abs(value-expected[index])<=(index%4===3?1:0),
                `${fixture.name}: only alpha receives the independently calculated continuous coverage`))
        } else assert.deepEqual(result.hard,expected,`${fixture.name}: final current-space visibility`)
        assert.deepEqual(result.eager,result.hard,`${fixture.name}: empty-ink optimization preserves visible output`)
        assert.equal(result.hardCalls,fixture.calls??8,`${fixture.name}: only visible ink needs final velocity sampling`)
        assert.equal(result.eagerCalls,fixture.eagerCalls??8,`${fixture.name}: eager counterfactual`)
    }
    assert.deepEqual(row('shared-spatial-zero-pair-before').hard,row('shared-spatial-zero-pair-after').hard,
        'A shared stationary endpoint cannot jump when the other pair member has a dry corner')
    assert.deepEqual(row('shared-spatial-zero-before-limit').hard,row('shared-spatial-zero-after-limit').hard,
        'Near-endpoint weighted coverage converges to the same quantized visible ink')
    assert.deepEqual(proof.chain[0],faded,'A current zero must leave the decayed raw texture intact')
    assert.deepEqual(proof.chain[1],faded.map((value,index)=>index%4===3?0:value),'Unsupported current zero must remain invisible')
    assert.deepEqual(proof.chain[2],decay(faded),'Motion recovery restores the surviving raw ink')
    assert.deepEqual(proof.chain[3],Array(32).fill(0),'Old destructive raw cleanup erases the same ink')
    assert.deepEqual(proof.chain[4],Array(32).fill(0),'Old cleanup cannot recover after support returns')
    assert.deepEqual(proof.chain[5],Array(32).fill(0),'Raw ink expires after a bounded number of ordinary decay steps')
    assert.deepEqual(proof.chain[6],Array(32).fill(0),'Expired ink cannot reappear when support recovers')
    assert.deepEqual(proof.chain[7],Array.from({length:32},(_,index)=>[51,153,204,255][index%4]),'Freshly composed segments remain in raw storage')
    assert.deepEqual(proof.chain[8],proof.chain[7].map((value,index)=>index%4===3?0:value),'The final hard gate also clips fresh segment alpha')
    console.log(JSON.stringify({status:'passed',realTemporalPipeline:'compiled',rawPipeline:'standalone',
        cases:proof.results.map(({name,rawCalls,hardCalls,eagerCalls})=>({name,rawCalls,hardCalls,eagerCalls})),
        chain:{zeroHidden:true,recoveryRestored:true,legacyScarConfirmed:true,expirySteps:256,freshSegmentsClipped:true},errors:proof.errors}))
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve))}

function decay(pixels) {
    const result=pixels.map(value=>Math.floor(value*0.996))
    for(let index=0;index<result.length;index+=4)if(Math.max(...result.slice(index,index+3))<=1)result.fill(0,index,index+4)
    return result
}

// Continuous pixel-center support oracle; no production helper code is copied.
function expectedCoverage(fixture,pixel) {
    if(fixture.hidden)return 0
    if(fixture.name==='current-boundary-after-reprojection')return pixel<4?1:0
    if(!fixture.weighted)return 1
    const progress=fixture.progress??.5
    if(fixture.support===3)return 1-progress
    const world=2*Math.PI*6378137
    const centerX=(13360000.125+(pixel+.5)/8*2-1)/world*256+128-.5
    const centerY=128-3503000.25/world*256-.5
    const fx=centerX-Math.floor(centerX),fy=centerY-Math.floor(centerY)
    const partial=1-(1-fx)*(1-fy) // non-owning top-left corner only
    return fixture.support===9?partial*(1-progress)+progress:partial
}
