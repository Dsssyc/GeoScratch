import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { chromium } from 'playwright'

// Support is a union of source-texel squares. The independent oracle below
// measures rectangle polygon edges; it never uses center-marching diamonds.
const widths=[.05,.25,.35],divisions=16,probes=[],lookup=new Map(),sharedEdges=[],sharedCorners=[]
const add=probe=>(probes.push(probe),probes.length-1)
for(let mask=0;mask<512;mask++)for(let y=0;y<=divisions;y++)for(let x=0;x<=divisions;x++) {
    lookup.set(`${mask}/${x}/${y}`,add({mask,p:[x/divisions,y/divisions],kind:0}))
}
for(const d of [-1,-.25,-1e-6,0,1e-6,.025,.05,.125,.25,.35,1])add({mask:0,p:[d,0],kind:1})
for(let y=-1;y<=1;y++)for(let x=-1;x<=1;x++) {
    for(const px of [-1.5,-1,-.125,0,.125,.5,.875,1,1.125,2,2.5]) {
        for(const py of [-1.5,-.125,0,.125,.5,1,1.125,2.5])add({p:[px,py],offset:[x,y],kind:2})
    }
}
let seed=0x9137ab21
function random(){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return (seed>>>0)/0x100000000}
function patch(values,width,x=0,y=0) {
    let mask=0
    for(let row=0;row<3;row++)for(let col=0;col<3;col++)mask|=values[(row+y)*width+col+x]<<(row*3+col)
    return mask
}
for(const orientation of ['vertical','horizontal']) {
    const width=orientation==='vertical'?4:3
    for(let arrangement=0;arrangement<4096;arrangement++) {
        const values=Array.from({length:12},(_,index)=>arrangement>>index&1)
        const a=patch(values,width),b=patch(values,width,orientation==='vertical'?1:0,orientation==='horizontal'?1:0)
        const phases=arrangement<256?[0,.25,.5,.75,1]:[.5]
        for(const phase of phases)for(const epsilon of [0,1/4096]) {
            const left=add({mask:a,p:orientation==='vertical'?[1-epsilon,phase]:[phase,1-epsilon],kind:0})
            const right=add({mask:b,p:orientation==='vertical'?[epsilon,phase]:[phase,epsilon],kind:0})
            sharedEdges.push({a:left,b:right,epsilon})
        }
    }
}
for(let arrangement=0;arrangement<512;arrangement++) {
    const values=Array.from({length:16},()=>Number(random()>=.5)),group=[]
    for(const [x,y,p] of [[0,0,[1,1]],[1,0,[0,1]],[0,1,[1,0]],[1,1,[0,0]]]) {
        group.push(add({mask:patch(values,4,x,y),p,kind:0}))
    }
    sharedCorners.push(group)
}
const ownerOnly=1<<4
const convexRegression=add({mask:ownerOnly,p:[.26,.26],kind:0})
const straightRegression=add({mask:511^(1<<3),p:[.125,.5],kind:0})
const diagonalDryRegression=add({mask:511^(1<<0),p:[.125,.125],kind:0})
function segmentDistance(p,a,b) {
    const d=[b[0]-a[0],b[1]-a[1]]
    const t=Math.max(0,Math.min(1,((p[0]-a[0])*d[0]+(p[1]-a[1])*d[1])/(d[0]*d[0]+d[1]*d[1])))
    return Math.hypot(p[0]-a[0]-t*d[0],p[1]-a[1]-t*d[1])
}
function rectangleDistance(p,offset) {
    const [x,y]=offset
    if(p[0]>=x&&p[0]<=x+1&&p[1]>=y&&p[1]<=y+1)return 0
    const corners=[[x,y],[x+1,y],[x+1,y+1],[x,y+1]]
    return Math.min(...corners.map((a,index)=>segmentDistance(p,a,corners[(index+1)%4])))
}
function binaryDistance(p,mask) {
    if(!(mask&ownerOnly))return 0
    let distance=.35
    for(let index=0;index<9;index++)if(!(mask&(1<<index))) {
        distance=Math.min(distance,rectangleDistance(p,[index%3-1,Math.floor(index/3)-1]))
    }
    return distance
}
function coverage(distance,width) {const t=Math.max(0,Math.min(1,distance/width));return t*t*(3-2*t)}
function expected(probe) {
    const d=probe.kind===1?probe.p[0]:probe.kind===2?rectangleDistance(probe.p,probe.offset):binaryDistance(probe.p,probe.mask)
    return [d,...widths.map(width=>coverage(d,width))]
}
function transformMask(mask,transform) {
    let result=0
    for(let i=0;i<9;i++)if(mask&(1<<i)){const [x,y]=transform(i%3,Math.floor(i/3));result|=1<<(x+y*3)}
    return result
}
function validate(rows,native) {
    let maximumDistanceError=0,maximumCoverageError=0,maximumSharedEdgeJump=0
    for(const [index,probe] of probes.entries()) {
        const oracle=expected(probe),observed=rows[index]
        maximumDistanceError=Math.max(maximumDistanceError,Math.abs(observed[0]-oracle[0]))
        assert.ok(Math.abs(observed[0]-oracle[0])<3e-6,`${index}: square-union distance differs from polygon oracle`)
        for(let channel=1;channel<4;channel++) {
            const error=Math.abs(observed[channel]-oracle[channel]);maximumCoverageError=Math.max(maximumCoverageError,error)
            assert.ok(error<8e-6,`${index}: width ${widths[channel-1]} coverage differs`)
            assert.ok(observed[channel]>=0&&observed[channel]<=1,'Normalized coverage')
        }
    }
    const sample=(mask,x,y)=>rows[lookup.get(`${mask}/${x}/${y}`)]
    for(let mask=0;mask<512;mask++) {
        const rotate=transformMask(mask,(x,y)=>[2-y,x]),reflect=transformMask(mask,(x,y)=>[2-x,y])
        for(let y=0;y<=divisions;y++)for(let x=0;x<=divisions;x++) {
            const original=sample(mask,x,y)
            for(const other of [sample(rotate,divisions-y,x),sample(reflect,divisions-x,y)]) {
                original.forEach((value,index)=>assert.ok(Math.abs(value-other[index])<8e-6,'Square-union rotation/reflection symmetry'))
            }
        }
    }
    for(const {a,b,epsilon} of sharedEdges) {
        assert.ok(Math.abs(rows[a][0]-rows[b][0])<=2*epsilon+3e-6,'Shared edge distance is continuous and 1-Lipschitz')
        for(let index=1;index<4;index++) {
            const jump=Math.abs(rows[a][index]-rows[b][index])
            if(epsilon===0)maximumSharedEdgeJump=Math.max(maximumSharedEdgeJump,jump)
            assert.ok(jump<=1.5/widths[index-1]*2*epsilon+8e-5,'Shared-edge coverage has no owner seam')
        }
    }
    for(const group of sharedCorners)for(const index of group.slice(1)) {
        rows[group[0]].forEach((value,channel)=>assert.ok(Math.abs(value-rows[index][channel])<8e-6,'Four owner views agree at their shared corner'))
    }
    assert.equal(rows[convexRegression][2],1,'An isolated texel owns its full square core: no center-diamond chamfer')
    assert.ok(Math.abs(rows[straightRegression][2]-.5)<3e-6,'Straight boundary feather lies inside the wet owner square')
    assert.ok(Math.abs(rows[diagonalDryRegression][0]-Math.SQRT2*.125)<3e-6,'Diagonal dry square produces Euclidean corner distance')
    assert.deepEqual(sample(ownerOnly,16,8),[0,0,0,0],'Wet-to-dry shared boundary has zero coverage')
    const wetEdge=sample(ownerOnly|(1<<5),16,8)
    assert.ok(Math.abs(wetEdge[0]-.35)<3e-6&&wetEdge.slice(1).every(value=>value===1),'Adjacent wet owners have no artificial seam')
    assert.deepEqual(sample(511^ownerOnly,8,8),[0,0,0,0],'Eight wet neighbors cannot fill a dry owner')
    return {native,patterns:512,spatialProbes:512*17*17,totalProbes:probes.length,sharedEdgePairs:sharedEdges.length,
        sharedCorners:sharedCorners.length,maximumDistanceError,maximumCoverageError,maximumSharedEdgeJump}
}
if(process.argv.includes('--cpu-only')) {
    console.log(JSON.stringify({status:'cpu-oracle-passed',...validate(probes.map(expected),false)}))
} else {
    const source=await readFile(new URL('../../examples/flowField/shaders/boundary-distance.wgsl',import.meta.url),'utf8')
    assert.ok(source.includes('fn FlowBoundary_square_distance('),'Owner-square geometry helper must exist')
    const input=new Uint8Array(probes.length*32),data=new DataView(input.buffer)
    probes.forEach((probe,index)=>{
        const offset=index*32
        ;[...probe.p,...(probe.offset??[0,0])].forEach((value,word)=>data.setFloat32(offset+word*4,value,true))
        data.setUint32(offset+16,probe.mask??0,true);data.setUint32(offset+20,probe.kind,true)
    })
    const code=source+`
struct Probe { p:vec2f, offset:vec2f, mask:u32, kind:u32, pad:vec2u, }
@group(0) @binding(0) var<storage,read> probes:array<Probe>;
@group(0) @binding(1) var<storage,read_write> output:array<vec4f>;
@compute @workgroup_size(64)
fn test_boundary_distance(@builtin(global_invocation_id) id:vec3u) {
    if(id.x>=arrayLength(&probes)){return;}
    let probe=probes[id.x];var d=probe.p.x;var q:array<f32,9>;
    if(probe.kind==0u) {
        d=0.35;
        for(var i=0u;i<9u;i++) {
            q[i]=select(0.0,1.0,(probe.mask&(1u<<i))!=0u);
            if(q[i]==0.0){d=min(d,FlowBoundary_square_distance(probe.p,vec2f(f32(i%3u)-1.0,f32(i/3u)-1.0)));}
        }
        if(q[4]==0.0){d=0.0;}
        output[id.x]=vec4f(d,FlowBoundary_continuous_coverage(probe.p,q,0.05),
            FlowBoundary_continuous_coverage(probe.p,q,0.25),FlowBoundary_continuous_coverage(probe.p,q,0.35));
    } else {
        if(probe.kind==2u){d=FlowBoundary_square_distance(probe.p,probe.offset);}
        output[id.x]=vec4f(d,FlowBoundary_inner_coverage(d,0.05),FlowBoundary_inner_coverage(d,0.25),FlowBoundary_inner_coverage(d,0.35));
    }
}`
    const server=createServer((_request,response)=>response.end('<!doctype html><title>Flow owner-square boundary proof</title>'))
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
                const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'test_boundary_distance'}})
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
