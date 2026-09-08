import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { chromium } from 'playwright'

// Independent polygon-distance and Bernstein-weight oracles. The circle fixture
// uses samples of a real circle SDF, not a binary silhouette labelled as a circle.
const probes=[],centerCases=[],sharedEdges=[],sharedCorners=[],timeEndpoints=[]
const add=probe=>(probes.push(probe),probes.length-1)
const centers=[[1,1],[2,1],[1,2],[2,2]],clamp=value=>Math.max(0,Math.min(1,value))
let seed=0x584930ab
function random(){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return (seed>>>0)/0x100000000}
function supportPatch(mask,nextMask,center) {
    const values=Array.from({length:16},()=>[Number(random()>.5),Number(random()>.5)])
    for(let y=0;y<3;y++)for(let x=0;x<3;x++) {
        const bit=x+y*3,index=center[0]+x-1+(center[1]+y-1)*4
        values[index]=[mask>>bit&1,nextMask>>bit&1]
    }
    return values
}
function segmentDistance(p,a,b) {
    const dx=b[0]-a[0],dy=b[1]-a[1]
    const t=clamp(((p[0]-a[0])*dx+(p[1]-a[1])*dy)/(dx*dx+dy*dy))
    return Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy)
}
function squareDistance(p,x,y) {
    const corners=[[x-.5,y-.5],[x+.5,y-.5],[x+.5,y+.5],[x-.5,y+.5]]
    if(p[0]>=x-.5&&p[0]<=x+.5&&p[1]>=y-.5&&p[1]<=y+.5)return 0
    return Math.min(...corners.map((a,index)=>segmentDistance(p,a,corners[(index+1)%4])))
}
function centerDistance(support,center) {
    const owner=support[center[0]+center[1]*4]
    return owner.map((inside,channel)=>{
        let nearest=1.5
        // Scan all 16 squares, including those outside the implementation's
        // 3x3. Their distance cannot affect this truncated center sample.
        support.forEach((value,index)=>{
            if(value[channel]!==inside)nearest=Math.min(nearest,squareDistance(center,index%4,Math.floor(index/4)))
        })
        return inside?nearest:-nearest
    })
}
function reconstruction(q,p,smooth) {
    const weights=p.map(value=>{const f=clamp(value);return smooth?3*f*f*(1-f)+f*f*f:f})
    const [x,y]=weights
    return q[0]*(1-x)*(1-y)+q[1]*x*(1-y)+q[2]*(1-x)*y+q[3]*x*y
}
function valuesFor(probe) {
    if(probe.kind!==2)return [probe.current,probe.next??probe.current]
    const values=centers.map(center=>centerDistance(probe.support,center))
    return [values.map(value=>value[0]),values.map(value=>value[1])]
}
function crossing(q,direction,smooth) {
    assert.ok(reconstruction(q,[0,0],smooth)>0&&reconstruction(q,direction,smooth)<0,'Crossing fixture brackets zero')
    let low=0,high=1
    for(let i=0;i<56;i++) {
        const mid=(low+high)/2
        if(reconstruction(q,direction.map(value=>value*mid),smooth)>0)low=mid
        else high=mid
    }
    return (low+high)/2
}
function expected(probe) {
    if(probe.kind===0)return [...centerDistance(probe.support,probe.center),0,0]
    if(probe.kind===3) {
        const linear=crossing(probe.current,probe.p,false),smooth=crossing(probe.current,probe.p,true)
        return [linear,smooth,linear*Math.hypot(...probe.p),smooth*Math.hypot(...probe.p)]
    }
    const [current,next]=valuesFor(probe),alpha=probe.alpha??0
    const mixed=current.map((value,index)=>value*(1-alpha)+next[index]*alpha)
    return [reconstruction(current,probe.p,false),reconstruction(current,probe.p,true),
        reconstruction(mixed,probe.p,false),reconstruction(mixed,probe.p,true)]
}

for(let mask=0;mask<512;mask++) {
    const group=[]
    for(const center of centers)group.push(add({kind:0,support:supportPatch(mask,mask^0x129,center),center}))
    centerCases.push(group)
}
const allWet=add({kind:0,center:[1,1],support:Array.from({length:16},()=>[1,1])})
const allDry=add({kind:0,center:[2,2],support:Array.from({length:16},()=>[0,0])})
const axis=add({kind:0,center:[1,1],support:supportPatch(511^(1<<3),1<<3,[1,1])})
const diagonal=add({kind:0,center:[1,1],support:supportPatch(511^1,1,[1,1])})
const distanceLimit=add({kind:0,center:[1,1],support:Array.from({length:16},(_,index)=>index===3?[0,1]:[1,0])})

const quads=[]
for(let mask=0;mask<16;mask++)quads.push(Array.from({length:4},(_,index)=>mask>>index&1?.5:-.5))
for(const value of [-1.5,-.5,0,.5,1.5])quads.push(Array(4).fill(value))
for(let i=0;i<96;i++)quads.push(Array.from({length:4},()=>random()*3-1.5))
const centerInterpolation=[]
for(const current of quads) {
    for(let y=0;y<=16;y++)for(let x=0;x<=16;x++)add({kind:1,current,p:[x/16,y/16]})
    for(const [index,p] of [[0,[0,0]],[1,[1,0]],[2,[0,1]],[3,[1,1]]]) {
        centerInterpolation.push({probe:add({kind:1,current,p}),value:current[index]})
    }
    for(const p of [[-.25,.5],[1.25,.5],[.5,-.25],[.5,1.25]])add({kind:1,current,p})
}
function quad(grid,width,x,y) {return [grid[x+y*width],grid[x+1+y*width],grid[x+(y+1)*width],grid[x+1+(y+1)*width]]}
for(let arrangement=0;arrangement<128;arrangement++) {
    const grid=Array.from({length:9},()=>random()*3-1.5)
    for(const orientation of ['vertical','horizontal'])for(let i=0;i<=16;i++) {
        const phase=i/16,current=quad(grid,3,0,0)
        const other=quad(grid,3,orientation==='vertical'?1:0,orientation==='horizontal'?1:0)
        const a=add({kind:1,current,p:orientation==='vertical'?[1,phase]:[phase,1]})
        const b=add({kind:1,current:other,p:orientation==='vertical'?[0,phase]:[phase,0]})
        sharedEdges.push([a,b])
    }
    sharedCorners.push([[0,0,[1,1]],[1,0,[0,1]],[0,1,[1,0]],[1,1,[0,0]]]
        .map(([x,y,p])=>add({kind:1,current:quad(grid,3,x,y),p})))
}
for(let arrangement=0;arrangement<128;arrangement++) {
    const support=Array.from({length:16},()=>[Number(random()>.5),Number(random()>.5)])
    for(const p of [[0,0],[1,0],[0,1],[1,1],[.17,.73],[.5,.5],[.92,.21]]) {
        const group=[]
        for(let step=0;step<=16;step++)group.push(add({kind:2,support,p,alpha:step/16}))
        timeEndpoints.push(group)
    }
}
const circle=[.5,-.5,-.5,.5-Math.SQRT2]
const circleAxis=add({kind:3,current:circle,p:[1,0]})
const circleDiagonal=add({kind:3,current:circle,p:[1,1]})
const offsetPlane=add({kind:3,current:[.25,-.75,.25,-.75],p:[1,0]})

function validate(rows,native) {
    let maximumError=0,maximumSharedEdgeJump=0,maximumTemporalLinearityError=0
    for(const [index,probe] of probes.entries()) {
        const oracle=expected(probe),actual=rows[index]
        actual.forEach((value,channel)=>{
            const error=Math.abs(value-oracle[channel]);maximumError=Math.max(maximumError,error)
            assert.ok(Number.isFinite(value)&&error<1.2e-6,`${index}/${channel}: kind ${probe.kind}, ${value} != ${oracle[channel]}`)
        })
        if(probe.kind===1||probe.kind===2) {
            const [current,next]=valuesFor(probe),alpha=probe.alpha??0
            const mixed=current.map((value,index)=>value*(1-alpha)+next[index]*alpha)
            for(const [offset,values] of [[0,current],[2,mixed]])for(let channel=offset;channel<offset+2;channel++) {
                assert.ok(actual[channel]>=Math.min(...values)-1e-6&&actual[channel]<=Math.max(...values)+1e-6,'Interpolation cannot overshoot center distances')
            }
        }
    }
    for(const group of centerCases)for(const probe of group.slice(1))for(let channel=0;channel<2;channel++) {
        assert.ok(Math.abs(rows[group[0]][channel]-rows[probe][channel])<1e-7,'Center distances are independent of tile-local placement and out-of-stencil values')
    }
    assert.deepEqual(rows[allWet],[1.5,1.5,0,0],'Uniform wet endpoints saturate at +1.5')
    assert.deepEqual(rows[allDry],[-1.5,-1.5,0,0],'Uniform dry endpoints saturate at -1.5')
    assert.deepEqual(rows[axis],[.5,-.5,0,0],'Axis-adjacent opposite square is half a texel away')
    assert.ok(Math.abs(rows[diagonal][0]-Math.SQRT1_2)<1e-7&&Math.abs(rows[diagonal][1]+Math.SQRT1_2)<1e-7,'Diagonal opposite square uses Euclidean corner distance')
    assert.deepEqual(rows[distanceLimit],[1.5,-1.5,0,0],'Opposite square beyond the local stencil cannot change truncated distance')
    for(const {probe,value} of centerInterpolation)for(const actual of rows[probe]) {
        assert.ok(Math.abs(actual-value)<1e-7,'Both kernels preserve exact source-center values')
    }
    for(const [a,b] of sharedEdges)for(let channel=0;channel<4;channel++) {
        const jump=Math.abs(rows[a][channel]-rows[b][channel]);maximumSharedEdgeJump=Math.max(maximumSharedEdgeJump,jump)
        assert.ok(jump<3e-7,'Adjacent reconstruction cells share one edge value')
    }
    for(const group of sharedCorners)for(const probe of group.slice(1))for(let channel=0;channel<4;channel++) {
        assert.ok(Math.abs(rows[group[0]][channel]-rows[probe][channel])<1e-7,'Four reconstruction cells agree at shared source center')
    }
    for(const group of timeEndpoints)for(let step=0;step<group.length;step++)for(let channel=0;channel<2;channel++) {
        const alpha=step/16,start=rows[group[0]][channel],end=rows[group[16]][channel+2]
        const error=Math.abs(rows[group[step]][channel+2]-(start*(1-alpha)+end*alpha))
        maximumTemporalLinearityError=Math.max(maximumTemporalLinearityError,error)
        assert.ok(error<5e-7,'Explicit time-endpoint distance interpolation is continuous, linear, and exact at its endpoints')
    }
    for(const value of rows[circleAxis])assert.ok(Math.abs(value-.5)<1e-7,'Circle axis radius remains 0.5')
    assert.ok(Math.abs(rows[circleDiagonal][2]-.38411)<2e-5,'Linear reconstruction of the true circle samples has a shorter diagonal radius')
    assert.ok(Math.abs(rows[circleDiagonal][3]-.48441)<2e-5,'Smooth reconstruction moves the true-circle toy contour nearer radius 0.5')
    assert.ok(Math.abs(rows[offsetPlane][0]-.25)<1e-7&&Math.abs(rows[offsetPlane][1]-.32635)<2e-5,
        'Smooth weights also move an off-center plane: they are a shape prior, not exact SDF reconstruction')
    return {native,totalProbes:probes.length,sourcePatterns:512,sourceCenterPlacements:4,centerInterpolation: centerInterpolation.length,
        sharedEdgePairs:sharedEdges.length,sharedCorners:sharedCorners.length,temporalSequences:timeEndpoints.length,
        maximumError,maximumSharedEdgeJump,maximumTemporalLinearityError,
        circleAxisRadius:rows[circleAxis].slice(2),circleDiagonalRadius:rows[circleDiagonal].slice(2),offsetPlaneCrossing:rows[offsetPlane].slice(0,2)}
}

if(process.argv.includes('--cpu-only')) {
    console.log(JSON.stringify({status:'cpu-oracle-passed',...validate(probes.map(expected),false)}))
} else {
    const source=await readFile(new URL('../../examples/flowField/shaders/boundary-center-distance.wgsl',import.meta.url),'utf8')
    const input=new Uint8Array(probes.length*192),data=new DataView(input.buffer)
    probes.forEach((probe,index)=>{
        const offset=index*192
        ;(probe.support??Array.from({length:16},()=>[0,0])).flat().forEach((value,word)=>data.setFloat32(offset+word*4,value,true))
        ;(probe.current??[0,0,0,0]).forEach((value,word)=>data.setFloat32(offset+128+word*4,value,true))
        ;(probe.next??probe.current??[0,0,0,0]).forEach((value,word)=>data.setFloat32(offset+144+word*4,value,true))
        ;(probe.p??[0,0]).forEach((value,word)=>data.setFloat32(offset+160+word*4,value,true))
        ;(probe.center??[1,1]).forEach((value,word)=>data.setUint32(offset+168+word*4,value,true))
        data.setFloat32(offset+176,probe.alpha??0,true);data.setUint32(offset+180,probe.kind,true)
    })
    const code=source+`
struct Probe {
    support:array<vec2f,16>, current:vec4f, next:vec4f,
    p:vec2f, center:vec2u, alpha:f32, kind:u32, pad:vec2u,
}
@group(0) @binding(0) var<storage,read> probes:array<Probe>;
@group(0) @binding(1) var<storage,read_write> output:array<vec4f>;
fn test_crossing(q:vec4f,direction:vec2f,useSmooth:bool)->f32 {
    var low=0.0;var high=1.0;
    for(var i=0u;i<32u;i++) {
        let middle=(low+high)*0.5;
        if(FlowCenter_reconstruct(q,direction*middle,useSmooth)>0.0){low=middle;}else{high=middle;}
    }
    return (low+high)*0.5;
}
@compute @workgroup_size(64)
fn test_center_distance(@builtin(global_invocation_id) id:vec3u) {
    if(id.x>=arrayLength(&probes)){return;}
    let probe=probes[id.x];
    if(probe.kind==0u){output[id.x]=vec4f(FlowCenter_distance(probe.center,probe.support),0.0,0.0);return;}
    if(probe.kind==3u) {
        let linear=test_crossing(probe.current,probe.p,false);let smoothed=test_crossing(probe.current,probe.p,true);
        output[id.x]=vec4f(linear,smoothed,linear*length(probe.p),smoothed*length(probe.p));return;
    }
    var current=probe.current;var next=probe.next;
    if(probe.kind==2u) {
        let d00=FlowCenter_distance(vec2u(1u,1u),probe.support);let d10=FlowCenter_distance(vec2u(2u,1u),probe.support);
        let d01=FlowCenter_distance(vec2u(1u,2u),probe.support);let d11=FlowCenter_distance(vec2u(2u,2u),probe.support);
        current=vec4f(d00.x,d10.x,d01.x,d11.x);next=vec4f(d00.y,d10.y,d01.y,d11.y);
    }
    let mixed=mix(current,next,probe.alpha);
    output[id.x]=vec4f(FlowCenter_reconstruct(current,probe.p,false),FlowCenter_reconstruct(current,probe.p,true),
        FlowCenter_reconstruct(mixed,probe.p,false),FlowCenter_reconstruct(mixed,probe.p,true));
}`
    const server=createServer((_request,response)=>response.end('<!doctype html><title>Flow center-distance reconstruction proof</title>'))
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
    let browser
    try {
        browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-webgpu']})
        const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`)
        const proof=await page.evaluate(async ({code,inputBase64,count})=>{
            const adapter=await navigator.gpu.requestAdapter();if(!adapter)throw new Error('WebGPU adapter unavailable')
            const device=await adapter.requestDevice(),owned=[],errors=[]
            device.addEventListener('uncapturederror',event=>errors.push(event.error.message));device.pushErrorScope('validation')
            try {
                const module=device.createShaderModule({code})
                const compilation=(await module.getCompilationInfo()).messages.filter(message=>message.type==='error')
                if(compilation.length)throw new Error(compilation.map(message=>message.message).join('\n'))
                const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'test_center_distance'}})
                const make=(size,usage)=>{const resource=device.createBuffer({size,usage});owned.push(resource);return resource}
                const bytes=Uint8Array.from(atob(inputBase64),c=>c.charCodeAt(0))
                const input=make(bytes.length,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST)
                const output=make(count*16,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC)
                const readback=make(count*16,GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ)
                device.queue.writeBuffer(input,0,bytes)
                const bind=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[
                    {binding:0,resource:{buffer:input}},{binding:1,resource:{buffer:output}}]})
                const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass()
                pass.setPipeline(pipeline);pass.setBindGroup(0,bind);pass.dispatchWorkgroups(Math.ceil(count/64));pass.end()
                encoder.copyBufferToBuffer(output,0,readback,0,count*16);device.queue.submit([encoder.finish()])
                await readback.mapAsync(GPUMapMode.READ);const result=Array.from(new Float32Array(readback.getMappedRange()));readback.unmap()
                await device.queue.onSubmittedWorkDone();const validation=await device.popErrorScope()
                if(validation)throw new Error(validation.message);if(errors.length)throw new Error(errors.join('\n'))
                return {result,errors,readbacks:1}
            } finally {for(const resource of owned)resource.destroy();device.destroy()}
        },{code,inputBase64:Buffer.from(input).toString('base64'),count:probes.length})
        const rows=probes.map((_,index)=>proof.result.slice(index*4,index*4+4))
        console.log(JSON.stringify({status:'passed',...validate(rows,true),readbacks:proof.readbacks,errors:proof.errors}))
    } finally {await browser?.close();await new Promise(resolve=>server.close(resolve))}
}
