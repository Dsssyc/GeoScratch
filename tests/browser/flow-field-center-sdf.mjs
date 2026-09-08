import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { chromium } from 'playwright'
import { WebMercatorQuad, tileMatrixCoverage, webMercatorVirtualRasterField } from 'geoscratch/geo'
import { temporalVelocityWgslModule } from '../../examples/flowField/temporal-velocity-raster.ts'
import { flowScreenProjectionWgsl } from '../../examples/flowField/flow-screen-projection.ts'

const read=name=>readFile(new URL(`../../examples/flowField/shaders/${name}.wgsl`,import.meta.url),'utf8')
const [wrapper,distance,activity,boundary,history,displaySupport,centerDistance,centerBoundary]=await Promise.all([
    'temporal-velocity','boundary-distance','boundary-activity','boundary-sdf','history','presentation-support',
    'boundary-center-distance','boundary-center',
].map(read))
const model=webMercatorVirtualRasterField({
    id:'center-boundary-proof',addressSpaceId:'center-boundary-proof-space',sourceRevision:'v1',
    coverage:tileMatrixCoverage({tileMatrixSet:WebMercatorQuad,limits:[
        {matrixId:'1',minTileRow:0,maxTileRow:0,minTileCol:0,maxTileCol:1},
        {matrixId:'0',minTileRow:0,maxTileRow:0,minTileCol:0,maxTileCol:0},
    ]}),
    geographicBounds:[-179.9,0,179.9,85],coordinateBits:52,
    fieldKind:'vector',channels:2,sampleType:'float32',gpuFormat:'rg32float',interpolation:'linear',
})
const temporal=temporalVelocityWgslModule(model,model,{group:1,
    currentPageTableBinding:0,currentAtlasBinding:1,nextPageTableBinding:2,nextAtlasBinding:3,
    sampleRegistration:'pixel-center',activitySupport:'nearest-texel-zero',transitionTexels:4,wrapper})
assert.equal(model.addressSpace.matrixId(0),'1')
assert.equal(model.addressSpace.matrixId(1),'0')
const uniformStruct=history.match(/struct FlowFieldHistoryUniform \{[\s\S]*?\n\};/)?.[0]
assert.ok(uniformStruct,'Use actual production uniform ABI')
const code=[temporal.code,flowScreenProjectionWgsl(model.addressCodec),uniformStruct,displaySupport,
    distance,activity,boundary,centerDistance,centerBoundary,`
struct ProbeResult { value:vec4f, state:vec4f, address:vec4f, centerSample:vec4f, }
@group(3) @binding(0) var<storage,read> probes:array<FlowVelocityAddressFixedPosition>;
@group(3) @binding(1) var<storage,read_write> results:array<ProbeResult>;
@compute @workgroup_size(64)
fn test_center_boundary(@builtin(global_invocation_id) id:vec3u) {
    if(id.x>=arrayLength(&probes)){return;}
    let position=probes[id.x];let level=boundaryUniform.requestedLevel;
    let flow=FlowVelocity_sample(position,level,FlowVelocityTemporal(boundaryUniform.progress,boundaryUniform.activityKill));
    let centerFlow=FlowVelocity_sample_centers(position,level,FlowVelocityTemporal(boundaryUniform.progress,boundaryUniform.activityKill));
    let registered=FlowVelocityRegistration_position(position,level);
    let address=FlowVelocityAddress_address(registered,FlowVelocityCurrent_matrix[level]);
    let base=vec2f(address.tile*FlowVelocityCurrent_page_size+address.texel);
    results[id.x]=ProbeResult(
        vec4f(FlowCenter_coverage(position),FlowBoundary_hard_coverage(position,level),flow.speed,f32(flow.status)),
        vec4f(select(0.0,1.0,FlowBoundary_exact_residency(position,level)),select(0.0,1.0,flow.advectable),f32(flow.resolved_level),0.0),
        vec4f(base,address.sub_texel),
        vec4f(centerFlow.speed,select(0.0,1.0,centerFlow.advectable),f32(centerFlow.status),f32(centerFlow.resolved_level)));
}`].join('\n')
const texelQuanta=model.addressCodec.worldQuanta/512n
const position=(x,y)=>model.addressCodec.fromWorldQuanta([
    BigInt(Math.round(x*Number(texelQuanta))),BigInt(Math.round(y*Number(texelQuanta))),
])
const table=new Uint32Array(model.addressSpace.pageTableEntryCount*8)
let rightEntry
for(const col of [0,1]) {
    const compact=model.addressCodec.address(position(col*256+.5,65.5),'1').compactIndex
    assert.notEqual(compact,undefined)
    // Reverse physical atlas slots; global adjacency must not become atlas adjacency.
    table.set([1-col,0,0,1,0,0,0,0],compact*8)
    if(col===1)rightEntry=compact
}
const parentEntry=model.addressCodec.address(position(256,65.5),'0').compactIndex
assert.notEqual(parentEntry,undefined)
table.set([2,0,1,1,0,0,0,0],parentEntry*8)
function velocity(field,x,y) {
    if(field==='zero')return 0
    if(field==='wet')return 2
    if(field==='reverse')return -2
    if(field==='at-kill')return 1
    if(field==='below-kill')return .5
    if(field==='diagonal')return y<=x-191?2:0
    if(field==='shifted-hole')return x===256&&y===65?0:2
    const result=x===254&&y===65?0:2
    return field==='reverse-hole'?-result:result
}
const fixtures=[
    {name:'hole',lower:'hole',upper:'hole',alpha:.277},
    {name:'hole-late',lower:'hole',upper:'hole',alpha:.95294},
    {name:'diagonal-seams',lower:'diagonal',upper:'diagonal',alpha:.277},
    {name:'wet-reversal',lower:'wet',upper:'reverse',alpha:.5},
    {name:'hole-reversal',lower:'hole',upper:'reverse-hole',alpha:.5},
    ...[0,.25,.5,.75,1].map(alpha=>({name:`growth-${alpha}`,lower:'zero',upper:'wet',alpha})),
    {name:'pair-before',lower:'hole',upper:'diagonal',alpha:1},
    {name:'pair-after',lower:'diagonal',upper:'shifted-hole',alpha:0},
    {name:'missing-lower-halo',lower:'hole',upper:'hole',alpha:.277,missing:[0]},
    {name:'missing-upper-halo',lower:'hole',upper:'hole',alpha:.277,missing:[1]},
    {name:'missing-both-halo',lower:'hole',upper:'hole',alpha:.277,missing:[0,1]},
    {name:'wet-with-missing-outer-halo',lower:'wet',upper:'wet',alpha:.277,missing:[0,1]},
    {name:'dry-with-missing-outer-halo',lower:'zero',upper:'zero',alpha:.277,missing:[0,1]},
    {name:'at-kill',lower:'at-kill',upper:'at-kill',alpha:.277,kill:1},
    {name:'below-kill',lower:'below-kill',upper:'below-kill',alpha:.277,kill:1},
    {name:'coarse-lower',lower:'wet',upper:'wet',alpha:.277,coarse:[0]},
    {name:'coarse-upper',lower:'wet',upper:'wet',alpha:.277,coarse:[1]},
    {name:'coarse-reversal',lower:'wet',upper:'reverse',alpha:.5,coarse:[0,1]},
]
const epsilon=1/4096
const probes=[
    {name:'dry-source-center',x:254.5,y:65.5},
    {name:'old-zero-square-corner',x:254.9,y:65.1},
    {name:'missing-halo-only',x:255.25,y:65.25},
    {name:'missing-bilinear-corner',x:255.75,y:65.25},
    {name:'physical-left',x:256-epsilon,y:65.25},
    {name:'physical-right',x:256+epsilon,y:65.25},
    {name:'center-cell-left',x:256.5-epsilon,y:65.25},
    {name:'center-cell-exact',x:256.5,y:65.25},
    {name:'center-cell-right',x:256.5+epsilon,y:65.25},
    {name:'interior',x:252.5,y:63.5},
    {name:'last-quantum-before-tile',x:256-1/Number(texelQuanta),y:65.25,
        quanta:[256n*texelQuanta-1n,BigInt(65.25*Number(texelQuanta))]},
]
for(let y=0;y<=16;y++)for(let x=0;x<=32;x++)probes.push({name:`grid-${x}-${y}`,x:253.5+x/8,y:64.5+y/8})
const positions=probes.flatMap(probe=>(probe.quanta?model.addressCodec.fromWorldQuanta(probe.quanta):position(probe.x,probe.y))
    .fixed.limbs.flatMap(axis=>[axis.low,axis.high]))
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
const cases=fixtures.map(fixture=>{
    const bytes=new Uint8Array(352),config=new DataView(bytes.buffer)
    config.setFloat32(332,fixture.alpha,true);config.setFloat32(336,fixture.kill??.001,true);config.setFloat32(340,.25,true)
    const pages=[0,1].map(endpoint=>{
        const value=table.slice();if(fixture.missing?.includes(endpoint))value[rightEntry*8+3]=0
        if(fixture.coarse?.includes(endpoint))value.set([2,0,1,2,0,0,0,0],rightEntry*8)
        return [...value]
    })
    return {...fixture,uniform:[...bytes],pages}
})

const clamp=value=>Math.max(0,Math.min(1,value))
function lineDistance(p,a,b) {
    const dx=b[0]-a[0],dy=b[1]-a[1],t=clamp(((p[0]-a[0])*dx+(p[1]-a[1])*dy)/(dx*dx+dy*dy))
    return Math.hypot(p[0]-a[0]-dx*t,p[1]-a[1]-dy*t)
}
function rectangleDistance(p,x,y) {
    const corners=[[x,y],[x+1,y],[x+1,y+1],[x,y+1]]
    if(p[0]>=x&&p[0]<=x+1&&p[1]>=y&&p[1]<=y+1)return 0
    return Math.min(...corners.map((a,index)=>lineDistance(p,a,corners[(index+1)%4])))
}
function supportAt(fixture,endpoint,x,y) {
    if(x<0||x>=512||y<0||y>=256||fixture.missing?.includes(endpoint)&&x>=256)return null
    const speed=Math.abs(velocity(endpoint?fixture.upper:fixture.lower,x,y))
    return Number(speed>0&&speed>=(fixture.kill??.001))
}
function centerVelocityOracle(fixture,probe) {
    const base=[Math.floor(probe.x-.5),Math.floor(probe.y-.5)]
    const x=probe.x-.5-base[0],y=probe.y-.5-base[1]
    const weights=[(1-x)*(1-y),x*(1-y),(1-x)*y,x*y]
    const endpoints=[fixture.lower,fixture.upper].map(field=>weights.reduce((sum,weight,index)=>
        sum+weight*velocity(field,base[0]+index%2,base[1]+Math.floor(index/2)),0))
    const alpha=Math.fround(fixture.alpha)
    return Math.abs(endpoints[0]*(1-alpha)+endpoints[1]*alpha)
}
function coverageOracle(fixture,probe,row,smoothed) {
    if(row[4]===0)return row[1]
    const base=[Math.floor(probe.x-.5),Math.floor(probe.y-.5)]
    const endpointDistances=[]
    for(let endpoint=0;endpoint<2;endpoint++) {
        const centers=[[base[0],base[1]],[base[0]+1,base[1]],[base[0],base[1]+1],[base[0]+1,base[1]+1]]
        const bits=centers.map(([x,y])=>supportAt(fixture,endpoint,x,y))
        if(bits.includes(null))return row[1]
        endpointDistances.push({centers,bits})
    }
    if(endpointDistances.every(value=>value.bits.every(bit=>bit===1)))return 1
    if(endpointDistances.every(value=>value.bits.every(bit=>bit===0)))return 0
    // Mixed patches require the complete 4x4 halo at both endpoints.
    for(let endpoint=0;endpoint<2;endpoint++)for(let y=base[1]-1;y<=base[1]+2;y++)for(let x=base[0]-1;x<=base[0]+2;x++) {
        if(supportAt(fixture,endpoint,x,y)===null)return row[1]
    }
    const distances=endpointDistances.map(({centers,bits},endpoint)=>centers.map(([x,y],index)=>{
        let distance=1.5
        for(let gy=base[1]-1;gy<=base[1]+2;gy++)for(let gx=base[0]-1;gx<=base[0]+2;gx++) {
            if(supportAt(fixture,endpoint,gx,gy)!==bits[index])distance=Math.min(distance,rectangleDistance([x+.5,y+.5],gx,gy))
        }
        return bits[index]?distance:-distance
    }))
    const weights=[probe.x-.5-base[0],probe.y-.5-base[1]].map(value=>smoothed?3*value*value-2*value*value*value:value)
    const [x,y]=weights,w=[(1-x)*(1-y),x*(1-y),(1-x)*y,x*y]
    const alpha=Math.fround(fixture.alpha)
    const reconstructed=w.reduce((sum,value,index)=>sum+value*(distances[0][index]*(1-alpha)+distances[1][index]*alpha),0)
    const t=clamp((reconstructed+.25)/.5)
    return 3*t*t-2*t*t*t
}

const server=createServer((_request,response)=>response.end('<!doctype html><title>Flow center-boundary VT proof</title>'))
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
let browser
try {
    browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-webgpu']})
    const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`)
    const proof=await page.evaluate(async ({code,positions,cases,atlases})=>{
        const adapter=await navigator.gpu.requestAdapter();if(!adapter)throw new Error('WebGPU adapter unavailable')
        const device=await adapter.requestDevice(),owned=[],errors=[]
        device.addEventListener('uncapturederror',event=>errors.push(event.error.message));device.pushErrorScope('validation')
        try {
            const buffer=(data,usage)=>{
                const value=device.createBuffer({size:data.byteLength,usage:usage|GPUBufferUsage.COPY_DST})
                owned.push(value);device.queue.writeBuffer(value,0,data);return value
            }
            const fieldTextures={}
            for(const [field,base64] of Object.entries(atlases)) {
                const texture=device.createTexture({size:[768,256],format:'rg32float',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST})
                owned.push(texture);fieldTextures[field]=texture
                device.queue.writeTexture({texture},Uint8Array.from(atob(base64),character=>character.charCodeAt(0)),{bytesPerRow:6144},[768,256])
            }
            const visibility=GPUShaderStage.COMPUTE
            const uniformLayout=device.createBindGroupLayout({entries:[{binding:0,visibility,buffer:{type:'uniform'}}]})
            const temporalLayout=device.createBindGroupLayout({entries:[
                {binding:0,visibility,buffer:{type:'read-only-storage'}},{binding:1,visibility,texture:{sampleType:'unfilterable-float'}},
                {binding:2,visibility,buffer:{type:'read-only-storage'}},{binding:3,visibility,texture:{sampleType:'unfilterable-float'}},
            ]})
            const emptyLayout=device.createBindGroupLayout({entries:[]}),emptyGroup=device.createBindGroup({layout:emptyLayout,entries:[]})
            const probeLayout=device.createBindGroupLayout({entries:[
                {binding:0,visibility,buffer:{type:'read-only-storage'}},{binding:1,visibility,buffer:{type:'storage'}},
            ]})
            const module=device.createShaderModule({code})
            const compilation=(await module.getCompilationInfo()).messages.filter(message=>message.type==='error')
            if(compilation.length)throw new Error(compilation.map(message=>message.message).join('\n'))
            const layout=device.createPipelineLayout({bindGroupLayouts:[uniformLayout,temporalLayout,emptyLayout,probeLayout]})
            const pipelines=[]
            for(const smoothed of [false,true])pipelines.push(await device.createComputePipelineAsync({layout,
                compute:{module,entryPoint:'test_center_boundary',constants:{FLOW_CENTER_SMOOTH:Number(smoothed)}}}))
            const count=positions.length/4,probeBytes=count*64
            const positionsBuffer=buffer(new Uint32Array(positions),GPUBufferUsage.STORAGE)
            const readback=device.createBuffer({size:cases.length*2*probeBytes,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST})
            owned.push(readback)
            const encoder=device.createCommandEncoder()
            for(const [caseIndex,fixture] of cases.entries()) {
                const config=buffer(new Uint8Array(fixture.uniform),GPUBufferUsage.UNIFORM)
                const tables=fixture.pages.map(value=>buffer(new Uint32Array(value),GPUBufferUsage.STORAGE))
                const uniformGroup=device.createBindGroup({layout:uniformLayout,entries:[{binding:0,resource:{buffer:config}}]})
                const temporalGroup=device.createBindGroup({layout:temporalLayout,entries:[
                    {binding:0,resource:{buffer:tables[0]}},{binding:1,resource:fieldTextures[fixture.lower].createView()},
                    {binding:2,resource:{buffer:tables[1]}},{binding:3,resource:fieldTextures[fixture.upper].createView()},
                ]})
                for(let variant=0;variant<2;variant++) {
                    const output=buffer(new Uint8Array(probeBytes),GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC)
                    const group=device.createBindGroup({layout:probeLayout,entries:[
                        {binding:0,resource:{buffer:positionsBuffer}},{binding:1,resource:{buffer:output}},
                    ]})
                    const pass=encoder.beginComputePass();pass.setPipeline(pipelines[variant]);pass.setBindGroup(0,uniformGroup)
                    pass.setBindGroup(1,temporalGroup);pass.setBindGroup(2,emptyGroup);pass.setBindGroup(3,group)
                    pass.dispatchWorkgroups(Math.ceil(count/64));pass.end()
                    encoder.copyBufferToBuffer(output,0,readback,(caseIndex*2+variant)*probeBytes,probeBytes)
                }
            }
            device.queue.submit([encoder.finish()]);await readback.mapAsync(GPUMapMode.READ)
            const values=new Float32Array(readback.getMappedRange())
            const rows=cases.map((_,caseIndex)=>[0,1].map(variant=>Array.from({length:count},(_,index)=>
                Array.from(values.slice(((caseIndex*2+variant)*count+index)*16,((caseIndex*2+variant)*count+index+1)*16)))))
            readback.unmap();await device.queue.onSubmittedWorkDone()
            const validation=await device.popErrorScope();if(validation)throw new Error(validation.message)
            if(errors.length)throw new Error(errors.join('\n'))
            return {rows,errors,readbacks:1}
        } finally {for(const resource of owned)resource.destroy();device.destroy()}
    },{code,positions,cases,atlases})
    let maximumCoverageError=0,maximumSeamJump=0,maximumCenterVelocityError=0
    const row=(name,probe,variant)=>proof.rows[fixtures.findIndex(value=>value.name===name)][variant][probes.findIndex(value=>value.name===probe)]
    for(const [caseIndex,fixture] of fixtures.entries())for(let variant=0;variant<2;variant++) {
        for(const [probeIndex,probe] of probes.entries()) {
            const value=proof.rows[caseIndex][variant][probeIndex],expected=coverageOracle(fixture,probe,value,variant===1)
            const error=Math.abs(value[0]-expected);maximumCoverageError=Math.max(maximumCoverageError,error)
            assert.ok(Number.isFinite(value[0])&&value[0]>=0&&value[0]<=1,'Finite normalized coverage')
            assert.ok(error<5e-5,`${fixture.name}/${probe.name}/${variant}: ${value[0]} != polygon-distance interpolation oracle ${expected}`)
            assert.equal(value[14],value[3],'Center sampling preserves the original actual VT availability status')
            assert.equal(value[15],value[6],'Center sampling preserves the original common resolved level')
            if(!fixture.missing&&!fixture.coarse)assert.equal(value[3],1,'Fully resident actual VT samples retain ready status')
            if(value[14]===1) {
                const velocityError=Math.abs(value[12]-centerVelocityOracle(fixture,probe))
                maximumCenterVelocityError=Math.max(maximumCenterVelocityError,velocityError)
                assert.ok(velocityError<2e-6,`${fixture.name}/${probe.name}: actual center velocity matches independent bilinear U/V and time interpolation`)
            }
            if(probe.name!=='last-quantum-before-tile') {
                assert.ok(Math.abs(value[8]-Math.floor(probe.x-.5))<1e-7&&Math.abs(value[9]-Math.floor(probe.y-.5))<1e-7,'Actual wide-fixed pixel-center registration chooses the correct source-center cell')
            }
        }
    }
    const keyResults=[]
    for(let variant=0;variant<2;variant++) {
        const center=row('hole','dry-source-center',variant),corner=row('hole','old-zero-square-corner',variant)
        assert.equal(center[0],0,'A zero source-center sample stays fully clipped')
        assert.equal(center[2],0);assert.equal(center[5],0,'Center-zero velocity remains non-advectable')
        assert.equal(center[12],0);assert.equal(center[13],0,'The real C/D sampler preserves death at an exactly zero source center')
        assert.equal(corner[1],0,'The old owner-square A mask clips its dry corner')
        assert.ok(corner[0]>.05,'Center reconstruction can move the contour inside a formerly clipped owner-square corner')
        assert.equal(corner[2],0,'The A sampler zeros the whole original dry-owner square')
        assert.ok(Math.abs(corner[12]-1.28)<2e-6&&corner[13]===1,'The actual C/D sampler uses positive bilinear center velocity in the reconstructed corner')
        const reversal=row('wet-reversal','interior',variant)
        assert.equal(reversal[0],1,'Common supported footprint is opaque at exact tidal cancellation')
        assert.equal(reversal[2],0);assert.equal(reversal[5],0,'Presentation does not make zero-velocity particles advectable')
        assert.equal(reversal[12],0);assert.equal(reversal[13],0,'The actual C/D sampler still kills zero-velocity tidal reversal particles')
        for(const name of ['missing-lower-halo','missing-upper-halo','missing-both-halo']) {
            const halo=row(name,'missing-halo-only',variant),missing=row(name,'missing-bilinear-corner',variant)
            assert.equal(halo[4],1,'The halo-only fixture first proves an exactly resident 2x2 velocity footprint')
            assert.equal(halo[0],halo[1],'An unknown 4x4 halo uses A, not an invented dry seed')
            assert.equal(missing[4],0,'The missing-footprint fixture fails the actual resolution preflight')
            assert.equal(missing[0],missing[1],'Missing current/next velocity resolution uses A')
            assert.equal(missing[12],0);assert.equal(missing[13],0,'Missing C/D velocity remains unavailable and non-advectable')
        }
        for(const name of ['coarse-lower','coarse-upper','coarse-reversal']) {
            const coarse=row(name,'missing-bilinear-corner',variant)
            assert.equal(coarse[4],0,'A fine/coarse common-level transition cannot define a new fine boundary')
            assert.deepEqual([coarse[3],coarse[6],coarse[14],coarse[15]],[2,1,2,1],'Both samplers negotiate the actual shared parent level with fallback provenance')
            assert.equal(coarse[0],coarse[1],'Common-level fallback keeps the original A presentation policy')
            assert.equal(coarse[12],name==='coarse-reversal'?0:2,'Actual shared-parent center velocity is sampled correctly')
            assert.equal(coarse[13],name==='coarse-reversal'?0:1,'Parent fallback cannot revive exact reversal particles')
        }
        assert.equal(row('wet-with-missing-outer-halo','missing-halo-only',variant)[0],1,'An all-wet 2x2 may skip an irrelevant unknown outer halo')
        assert.equal(row('dry-with-missing-outer-halo','missing-halo-only',variant)[0],0,'An all-dry 2x2 may skip an irrelevant unknown outer halo')
        assert.equal(row('at-kill','interior',variant)[0],1,'A positive source velocity equal to kill remains supported')
        assert.equal(row('below-kill','interior',variant)[0],0,'Source endpoint support obeys the existing kill threshold')
        for(const probe of probes)assert.ok(Math.abs(row('pair-before',probe.name,variant)[0]-row('pair-after',probe.name,variant)[0])<1e-7,'A shared source time has identical coverage on both pair joins')
        for(const [a,b] of [['physical-left','physical-right'],['center-cell-left','center-cell-right']]) {
            const jump=Math.abs(row('diagonal-seams',a,variant)[0]-row('diagonal-seams',b,variant)[0]);maximumSeamJump=Math.max(maximumSeamJump,jump)
            assert.ok(jump<.004,'No physical-atlas or reconstruction-cell seam jump')
        }
        const growth=[0,.25,.5,.75,1].map(alpha=>row(`growth-${alpha}`,'interior',variant)[0])
        assert.deepEqual(growth,[0,0,.5,1,1],'Uniform endpoint SDFs morph continuously through zero, without a vector cancellation dry gate')
        keyResults.push({variant:variant===0?'C-linear':'D-smooth',dryCenter:center[0],oldSquareCorner:corner[0],
            cornerCenterSample:corner.slice(12),dryCenterSample:center.slice(12),reversalCenterSample:reversal.slice(12),growth})
    }
    assert.ok(Math.abs(keyResults[0].oldSquareCorner-keyResults[1].oldSquareCorner)>.05,'C and D produce observably different reconstructed contours')
    console.log(JSON.stringify({status:'passed',fixtures:fixtures.length,probes:probes.length,variants:2,totalProbes:fixtures.length*probes.length*2,
        maximumCoverageError,maximumSeamJump,maximumCenterVelocityError,keyResults,readbacks:proof.readbacks,errors:proof.errors}))
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve))}
