import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { chromium } from 'playwright'

// Isolate support-coverage reconstruction from the final current-sample veto,
// presentation, camera motion and frame rate. Actual zero stays a shader/particle
// condition, not a reason to dim a persistent support footprint in advance.
// Real-data cases use only two z10 spatial pages at five times, never the full COG.
const base = process.env.FLOW_BOUNDARY_TIME_BASE ?? 'http://127.0.0.1:8788'
const tolerance = 5e-5
const widths = [0.05,0.25,0.35]
const probes = [], sharedEdges = [], exchanges = [], joins = [], sweeps = []
const f32 = Math.fround
let seed = 0x703191ab
function random() {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5
    return (seed >>> 0)/0x100000000
}
function clamp(value,low=0,high=1) { return Math.max(low,Math.min(high,value)) }
function smooth(value) { const t=clamp(value); return t*t*(3-2*t) }
function speed(vector) { return Math.hypot(...vector) }
function gain(value,kill) { return Number(value>0 && value>=kill) }
function activity(current,next,alpha,kill) {
    const s0=speed(current),s1=speed(next)
    if (gain(s0,kill)===gain(s1,kill)) return gain(s0,kill)
    if (alpha===0) return gain(s0,kill)
    if (alpha===1) return gain(s1,kill)
    const expected=(1-alpha)*Math.max(s0-kill,0)+alpha*Math.max(s1-kill,0)
    if (expected<=0) return 0
    const actual=speed(current.map((value,index)=>value*(1-alpha)+next[index]*alpha))
    return ((1-alpha)*gain(s0,kill)+alpha*gain(s1,kill))*smooth(Math.max(actual-kill,0)/expected/0.15)
}
const corners=[[0,0],[1,0],[1,1],[0,1]]
const midpoint=(a,b)=>a.map((value,index)=>(value+b[index])/2)
const edgeCenters=corners.map((point,index)=>midpoint(point,corners[(index+1)%4]))
function contour(mask) {
    const bits=corners.map((_,index)=>Boolean(mask&(1<<index)))
    const crossed=bits.flatMap((value,index)=>value!==bits[(index+1)%4]?[index]:[])
    if (crossed.length===2) return [[edgeCenters[crossed[0]],edgeCenters[crossed[1]]]]
    if (crossed.length===4) return bits.flatMap((value,index)=>value?
        [[edgeCenters[(index+3)%4],edgeCenters[index]]]:[])
    return []
}
function polygons(mask) {
    if (mask===0) return []
    if (mask===5 || mask===10) return corners.flatMap((point,index)=>mask&(1<<index)?
        [[point,edgeCenters[index],edgeCenters[(index+3)%4]]]:[])
    const polygon=[]
    for (let index=0;index<4;index++) {
        if (mask&(1<<index)) polygon.push(corners[index])
        if (Boolean(mask&(1<<index))!==Boolean(mask&(1<<((index+1)%4)))) polygon.push(edgeCenters[index])
    }
    return [polygon]
}
const segments=Array.from({length:16},(_,mask)=>contour(mask))
const regions=Array.from({length:16},(_,mask)=>polygons(mask))
function inside(point,polygon) {
    return polygon.every((a,index)=>{
        const b=polygon[(index+1)%polygon.length]
        return (b[0]-a[0])*(point[1]-a[1])-(b[1]-a[1])*(point[0]-a[0])>=-1e-12
    })
}
function segmentDistance(point,a,b) {
    const dx=b[0]-a[0],dy=b[1]-a[1]
    const t=clamp(((point[0]-a[0])*dx+(point[1]-a[1])*dy)/(dx*dx+dy*dy))
    return Math.hypot(point[0]-a[0]-t*dx,point[1]-a[1]-t*dy)
}
function masksFrom(bits) {
    return Array.from({length:9},(_,index)=>{
        const origin=index%3+Math.floor(index/3)*4
        return Number(bits[origin])|Number(bits[origin+1])<<1|
            Number(bits[origin+5])<<2|Number(bits[origin+4])<<3
    })
}
function binaryCoverage(point,bits,feather) {
    const masks=masksFrom(bits)
    if (!regions[masks[4]].some(polygon=>inside(point,polygon))) return 0
    let nearest=0.35
    for (let index=0;index<9;index++) {
        const local=[point[0]-(index%3-1),point[1]-(Math.floor(index/3)-1)]
        for (const [a,b] of segments[masks[index]]) nearest=Math.min(nearest,segmentDistance(local,a,b))
    }
    return smooth(nearest/clamp(feather,0.05,0.35))
}
function integralCoverage(point,q,feather) {
    // General oracle: integrate the complete [0,1] threshold partition. No
    // central min/max optimization and no endpoint-SDF interpolation shortcut.
    const thresholds=[...new Set([0,1,...q])].sort((a,b)=>a-b)
    let coverage=0
    for (let index=1;index<thresholds.length;index++) {
        const lower=thresholds[index-1],upper=thresholds[index]
        const theta=(lower+upper)/2
        coverage+=(upper-lower)*binaryCoverage(point,q.map(value=>value>=theta),feather)
    }
    return coverage
}
function add(input) {
    const current=(input.current??Array.from({length:16},()=>[0,0])).map(v=>v.map(f32))
    const next=(input.next??current).map(v=>v.map(f32))
    const probe={p:(input.p??[0.125,0.125]).map(f32),feather:f32(input.feather??0.25),
        alpha:f32(input.alpha??0),kill:f32(input.kill??0.01),mode:input.q===undefined?1:0,
        current,next,q:input.q?.map(f32),label:input.label??'math'}
    probe.expectedQ=probe.q??current.map((value,index)=>activity(value,next[index],probe.alpha,probe.kill))
    probe.expected=integralCoverage(probe.p,probe.expectedQ,probe.feather)
    const binary=probe.q?probe.q.map(value=>value>=0.5):current.map((value,index)=>{
        const s=speed(value.map((channel,axis)=>channel*(1-probe.alpha)+next[index][axis]*probe.alpha))
        return s>0 && s>=probe.kill
    })
    probe.old=binaryCoverage(probe.p,binary,probe.feather)
    probes.push(probe)
    return probes.length-1
}
function patch(values,width,x=0,y=0) {
    return Array.from({length:16},(_,index)=>values[(Math.floor(index/4)+y)*width+index%4+x])
}
for (const feather of widths) {
    for (const q of [0,0.001,0.123,0.5,0.999,1]) for (const p of [[0,0],[0.25,0.4],[0.5,0.5],[1,0.75]]) {
        add({q:Array(16).fill(q),p,feather,label:'uniform'})
        const varying=Array.from({length:16},random)
        for (const index of [5,6,9,10]) varying[index]=q
        add({q:varying,p,feather,label:'uniform-central'})
    }
    for (let mask=0;mask<16;mask++) for (let outer=0;outer<4;outer++) {
        const q=Array.from({length:16},()=>Number(random()>.5))
        ;[5,6,10,9].forEach((index,bit)=>{q[index]=Number(Boolean(mask&(1<<bit)))})
        for (const p of [[0,0],[0.125,0.5],[0.5,0.5],[0.875,0.25]]) add({q,p,feather,label:'binary'})
    }
    for (let index=0;index<128;index++) add({q:Array.from({length:16},random),
        p:[random(),random()],feather,label:'random'})
}
for (let index=0;index<128;index++) {
    const q=Array.from({length:16},random),center=0.1+random()*0.8,epsilon=1e-5
    q[5]=center-epsilon;q[6]=center+epsilon
    const swapped=[...q];[swapped[5],swapped[6]]=[swapped[6],swapped[5]]
    exchanges.push([add({q,label:'order-before'}),add({q:swapped,label:'order-after'})])
}
for (const orientation of ['vertical','horizontal']) for (let index=0;index<96;index++) {
    const width=orientation==='vertical'?5:4,values=Array.from({length:20},random)
    const a=patch(values,width),b=patch(values,width,orientation==='vertical'?1:0,orientation==='horizontal'?1:0)
    for (const phase of [0.125,0.5,0.875]) for (const feather of widths) {
        sharedEdges.push([add({q:a,p:orientation==='vertical'?[1,phase]:[phase,1],feather,label:'shared-a'}),
            add({q:b,p:orientation==='vertical'?[0,phase]:[phase,0],feather,label:'shared-b'})])
    }
}
const uniform=vector=>Array.from({length:16},()=>vector)
function addSweep(name,current,next,kill=0.01,options={}) {
    const alphas=new Set(Array.from({length:1001},(_,index)=>index/1000))
    if (options.denseCenter!==undefined) for (let index=-500;index<=500;index++) {
        alphas.add(clamp(options.denseCenter+index/100000))
    }
    for (const point of options.breakpoints??[]) for (const offset of [-1e-5,-1e-6,-1e-7,0,1e-7,1e-6,1e-5]) {
        alphas.add(clamp(point+offset))
    }
    const ordered=[...new Set([...alphas].map(f32))].sort((a,b)=>a-b)
    const ids=ordered.map(alpha=>add({current,next,alpha,kill,p:options.p??[0.125,0.125],label:name}))
    sweeps.push({name,ids,expectLargeOldJump:options.expectLargeOldJump??true,
        real:options.real??false,expectedMonotone:options.expectedMonotone})
}
addSweep('dry-to-wet',uniform([0,0]),uniform([1,0]),0.01,{expectedMonotone:'up'})
addSweep('wet-to-dry',uniform([1,0]),uniform([0,0]),0.01,{expectedMonotone:'down'})
addSweep('opposite-cancellation',uniform([1,0]),uniform([-1,0]),0.01,{denseCenter:0.5})
addSweep('unequal-reversal',uniform([0.2,0]),uniform([-1,0]),0.01,{denseCenter:1/6})
addSweep('weak-positive-kill-crossing',uniform([0.005,0]),uniform([0.03,0]))
const diagonalA=Array.from({length:16},(_,index)=>(index%4+Math.floor(index/4))%2?[0,0]:[0.5,0])
const diagonalB=diagonalA.map(v=>v[0]===0?[0.8,0]:[0,0])
addSweep('saddle-swap',diagonalA,diagonalB,0.01,{p:[0.5,0.5]})
addSweep('zero-kill-growth',uniform([0,0]),uniform([1,0]),0,{expectedMonotone:'up'})
addSweep('zero-kill-reversal',uniform([1,0]),uniform([-1,0]),0,{denseCenter:0.5})
addSweep('zero-kill-all-dry',uniform([0,0]),uniform([0,0]),0,{expectLargeOldJump:false})
for (let index=0;index<32;index++) {
    const current=Array.from({length:16},()=>[random()*2-1,random()*2-1])
    const shared=Array.from({length:16},()=>{const value=random();return value<.25?[0,0]:value<.5?[.02,0]:[.1+value,0]})
    const next=Array.from({length:16},()=>[random()*0.2-0.1,random()*0.2-0.1])
    const left=add({current,next:shared,alpha:1,label:'pair-join-left'})
    const right=add({current:shared,next,alpha:0,label:'pair-join-right'})
    const before=add({current,next:shared,alpha:1-1e-6,label:'pair-join-before'})
    const after=add({current:shared,next,alpha:1e-6,label:'pair-join-after'})
    joins.push({left,right,before,after})
}
const realData=process.argv.includes('--synthetic-only')?undefined:await addRealSweeps()
const cpuSummary=validate(probes.map(probe=>({coverage:probe.expected,binary:probe.old,q:probe.expectedQ,
    gain0:gain(speed(probe.current[5]),probe.kill),gain1:gain(speed(probe.next[5]),probe.kill)})),false)
if (process.argv.includes('--cpu-only')) {
    console.log(JSON.stringify({status:'cpu-oracle-passed',probes:probes.length,realData,...cpuSummary}))
} else {
    const read=name=>readFile(new URL(`../../examples/flowField/shaders/${name}.wgsl`,import.meta.url),'utf8')
    const [activitySource,distanceSource]=await Promise.all([read('boundary-activity'),read('boundary-distance')])
    assert.ok(activitySource.includes('fn FlowBoundary_support_weight('),'The support helper must exist before native verification')
    assert.ok(distanceSource.includes('fn FlowBoundary_continuous_coverage('),'The continuous coverage helper must exist')
    const bytes=new Uint8Array(probes.length*352),view=new DataView(bytes.buffer)
    for (const [index,probe] of probes.entries()) {
        const offset=index*352
        ;[...probe.p,probe.feather,probe.alpha,probe.kill].forEach((value,word)=>view.setFloat32(offset+word*4,value,true))
        view.setUint32(offset+20,probe.mode,true)
        probe.current.flat().forEach((value,word)=>view.setFloat32(offset+32+word*4,value,true))
        probe.next.flat().forEach((value,word)=>view.setFloat32(offset+160+word*4,value,true))
        probe.q?.forEach((value,word)=>view.setFloat32(offset+288+word*4,value,true))
    }
    const code=activitySource+'\n'+distanceSource+`
struct Probe { p:vec2f, feather:f32, alpha:f32, kill:f32, mode:u32, pad:vec2u,
    current:array<vec2f,16>, next:array<vec2f,16>, q:array<f32,16>, }
struct Result { coverage:f32, binary:f32, q:array<f32,16>, gain0:f32, gain1:f32, }
@group(0) @binding(0) var<storage,read> probes:array<Probe>;
@group(0) @binding(1) var<storage,read_write> results:array<Result>;
@compute @workgroup_size(64)
fn test_boundary_time(@builtin(global_invocation_id) id:vec3u) {
    if (id.x>=arrayLength(&probes)) { return; }
    let probe=probes[id.x]; var q=probe.q; var supportBits:array<u32,16>;
    for(var i=0u;i<16u;i++) {
        if(probe.mode==1u) {
            q[i]=FlowBoundary_support_weight(probe.current[i],probe.next[i],probe.alpha,probe.kill);
            let s=length(mix(probe.current[i],probe.next[i],probe.alpha));
            supportBits[i]=select(0u,1u,s>0.0 && s>=probe.kill);
        } else { supportBits[i]=select(0u,1u,q[i]>=0.5); }
    }
    var masks:array<u32,9>;
    for(var i=0u;i<9u;i++) { let o=i%3u+(i/3u)*4u;
        masks[i]=supportBits[o]|(supportBits[o+1u]<<1u)|(supportBits[o+5u]<<2u)|(supportBits[o+4u]<<3u); }
    results[id.x].coverage=FlowBoundary_continuous_coverage(probe.p,q,probe.feather);
    results[id.x].binary=FlowBoundary_inner_coverage(FlowBoundary_neighborhood_distance(probe.p,masks),probe.feather);
    results[id.x].q=q;
    results[id.x].gain0=FlowBoundary_endpoint_support(length(probe.current[5]),probe.kill);
    results[id.x].gain1=FlowBoundary_endpoint_support(length(probe.next[5]),probe.kill);
}`
    const server=createServer((_request,response)=>response.end('<!doctype html><title>Flow time-continuous boundary proof</title>'))
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
    let browser
    try {
        browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-webgpu']})
        const page=await browser.newPage()
        await page.goto(`http://127.0.0.1:${server.address().port}`)
        const observed=await page.evaluate(async ({code,base64,count})=>{
            const adapter=await navigator.gpu.requestAdapter()
            if (!adapter) throw new Error('WebGPU adapter unavailable')
            const device=await adapter.requestDevice(),errors=[],owned=[]
            device.addEventListener('uncapturederror',event=>errors.push(event.error.message))
            device.pushErrorScope('validation')
            try {
                const module=device.createShaderModule({code})
                const compilation=(await module.getCompilationInfo()).messages.filter(value=>value.type==='error')
                if(compilation.length) throw new Error(compilation.map(value=>value.message).join('\n'))
                const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'test_boundary_time'}})
                const input=Uint8Array.from(atob(base64),value=>value.charCodeAt(0))
                const make=(size,usage)=>{const value=device.createBuffer({size,usage});owned.push(value);return value}
                const source=make(input.length,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST)
                const output=make(count*80,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC)
                const readback=make(count*80,GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ)
                device.queue.writeBuffer(source,0,input)
                const bindings=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[
                    {binding:0,resource:{buffer:source}},{binding:1,resource:{buffer:output}}]})
                const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass()
                pass.setPipeline(pipeline);pass.setBindGroup(0,bindings);pass.dispatchWorkgroups(Math.ceil(count/64));pass.end()
                encoder.copyBufferToBuffer(output,0,readback,0,count*80)
                device.queue.submit([encoder.finish()])
                await readback.mapAsync(GPUMapMode.READ)
                const values=Array.from(new Float32Array(readback.getMappedRange()))
                readback.unmap()
                await device.queue.onSubmittedWorkDone()
                const validation=await device.popErrorScope()
                if(validation) throw new Error(validation.message)
                if(errors.length) throw new Error(errors.join('\n'))
                return {values,errors,readbacks:1}
            } finally { for(const value of owned)value.destroy();device.destroy() }
        },{code,base64:Buffer.from(bytes).toString('base64'),count:probes.length})
        const values=probes.map((_,index)=>{const row=observed.values.slice(index*20,index*20+20)
            return {coverage:row[0],binary:row[1],q:row.slice(2,18),gain0:row[18],gain1:row[19]}})
        const summary=validate(values,true)
        console.log(JSON.stringify({status:'passed',probes:probes.length,realData,...summary,
            errors:observed.errors,readbacks:observed.readbacks,
            scope:'Native helpers plus bounded source U/V sweeps, not full application rendering'}))
    } finally {await browser?.close();await new Promise(resolve=>server.close(resolve))}
}

function validate(values,native) {
    let maximumCoverageError=0,maximumActivityError=0,maximumSharedEdgeJump=0
    for (const [index,probe] of probes.entries()) {
        const result=values[index]
        assert.ok([result.coverage,...result.q,result.gain0,result.gain1].every(value=>Number.isFinite(value)&&value>=-1e-6&&value<=1.000001),`${index} ${probe.label}: finite normalized outputs`)
        maximumCoverageError=Math.max(maximumCoverageError,Math.abs(result.coverage-probe.expected))
        assert.ok(Math.abs(result.coverage-probe.expected)<tolerance,`${index} ${probe.label}: coverage ${result.coverage} != oracle ${probe.expected}`)
        for(let center=0;center<16;center++) {
            const error=Math.abs(result.q[center]-probe.expectedQ[center]);maximumActivityError=Math.max(maximumActivityError,error)
            assert.ok(error<tolerance,`${index} ${probe.label}: activity center ${center} differs from current-U/V oracle`)
            if (probe.mode===1 && gain(speed(probe.current[center]),probe.kill) && gain(speed(probe.next[center]),probe.kill)) {
                assert.equal(result.q[center],1,`${index}: persistent support is not a relative-speed opacity map`)
            }
        }
        assert.ok(Math.abs(result.gain0-gain(speed(probe.current[5]),probe.kill))<tolerance)
        assert.ok(Math.abs(result.gain1-gain(speed(probe.next[5]),probe.kill))<tolerance)
        if (probe.label==='binary') assert.ok(Math.abs(result.coverage-result.binary)<tolerance,'Binary activity exactly retains the old B basis')
        if (probe.label==='uniform'||probe.label==='uniform-central') assert.ok(Math.abs(result.coverage-probe.q[5])<tolerance,'Uniform central activity integrates to its own value')
    }
    for (const [a,b] of exchanges) {
        const bound=probes[a].expectedQ.reduce((sum,value,index)=>sum+Math.abs(value-probes[b].expectedQ[index]),0)
        assert.ok(Math.abs(values[a].coverage-values[b].coverage)<=bound+2*tolerance,'Threshold-order exchange must be continuous')
    }
    for (const [a,b] of sharedEdges) {
        const jump=Math.abs(values[a].coverage-values[b].coverage);maximumSharedEdgeJump=Math.max(maximumSharedEdgeJump,jump)
        assert.ok(jump<2*tolerance,'Integrated binary contours must agree on a shared cell edge')
    }
    for (const {left,right,before,after} of joins) {
        assert.ok(Math.abs(values[left].coverage-values[right].coverage)<tolerance,'The shared sample must join exactly across different time pairs')
        for(const [limit,near] of [[left,before],[right,after]]) {
            const bound=probes[limit].expectedQ.reduce((sum,value,index)=>sum+Math.abs(value-probes[near].expectedQ[index]),0)
            assert.ok(Math.abs(values[limit].coverage-values[near].coverage)<=bound+2*tolerance,'The pair join must also have matching one-sided limits')
        }
    }
    const sweepResults=sweeps.map(sweep=>{
        let maximumNewJump=0,maximumOldJump=0
        for(let i=1;i<sweep.ids.length;i++) {
            const a=sweep.ids[i-1],b=sweep.ids[i],delta=values[b].coverage-values[a].coverage
            const bound=probes[a].expectedQ.reduce((sum,value,index)=>sum+Math.abs(value-probes[b].expectedQ[index]),0)
            maximumNewJump=Math.max(maximumNewJump,Math.abs(delta))
            maximumOldJump=Math.max(maximumOldJump,Math.abs(values[b].binary-values[a].binary))
            assert.ok(Math.abs(delta)<=bound+2*tolerance,`${sweep.name}: continuous threshold-integral bound`)
            if(sweep.expectedMonotone==='up')assert.ok(delta>=-tolerance,`${sweep.name}: monotone emergence`)
            if(sweep.expectedMonotone==='down')assert.ok(delta<=tolerance,`${sweep.name}: monotone disappearance`)
        }
        if(sweep.expectLargeOldJump) {
            assert.ok(maximumOldJump>0.5,`${sweep.name}: control must actually expose a binary temporal jump`)
            assert.ok(maximumNewJump<maximumOldJump*0.25,`${sweep.name}: continuous construction must reduce the binary jump substantially`)
        }
        if(sweep.name==='opposite-cancellation'||sweep.name==='zero-kill-reversal') {
            const middle=sweep.ids.find(index=>probes[index].alpha===0.5)
            assert.equal(values[middle].coverage,1,
                'Persistent support stays intact; full-shader tests must independently veto actual zero velocity')
        }
        return {name:sweep.name,real:sweep.real,samples:sweep.ids.length,maximumNewJump,maximumOldJump}
    })
    return {native,maximumCoverageError,maximumActivityError,maximumSharedEdgeJump,
        sortExchanges:exchanges.length,sharedEdgePairs:sharedEdges.length,timePairJoins:joins.length,sweeps:sweepResults}
}

async function addRealSweeps() {
    const response=await fetch(`${base}/manifest.json`);assert.equal(response.status,200)
    const manifest=await response.json()
    assert.equal(manifest.representation.activitySupport,'nearest-texel-zero','Real proof expects the active v3 dataset')
    const kill=manifest.maximumSpeed*0.0005,width=512,fields=[]
    for(let time=0;time<5;time++) {
        const combined=new Float32Array(256*width*2)
        for(const col of [856,857]) {
            const record=manifest.pages.find(page=>page.sampleKey===`t${String(time).padStart(2,'0')}`&&page.matrixId==='10'&&page.tileRow===416&&page.tileCol===col)
            assert.ok(record,'Bounded reference page is declared')
            const page=await fetch(`${base}/${record.path}`);assert.equal(page.status,200)
            const bytes=Buffer.from(await page.arrayBuffer());assert.equal(bytes.length,524288)
            assert.equal(createHash('sha256').update(bytes).digest('hex'),record.sha256)
            const values=new Float32Array(bytes.buffer,bytes.byteOffset,bytes.length/4)
            for(let row=0;row<256;row++)combined.set(values.subarray(row*512,(row+1)*512),row*width*2+(col-856)*512)
        }
        fields.push(combined)
    }
    const choices=[]
    for(const [time,kind] of [[0,'growth'],[0,'opposed'],[1,'shrink'],[2,'opposed'],[3,'positive-cross']]) {
        const a=fields[time],b=fields[time+1];let chosen
        for(let row=1;row<254&&!chosen;row++)for(let col=1;col<510;col++) {
            const index=(row*width+col)*2,current=[a[index],a[index+1]],next=[b[index],b[index+1]]
            const s0=speed(current),s1=speed(next),dx=next[0]-current[0],dy=next[1]-current[1],den=dx*dx+dy*dy
            const minimumAlpha=den?clamp(-(current[0]*dx+current[1]*dy)/den):0
            const minimumSpeed=Math.hypot(current[0]+dx*minimumAlpha,current[1]+dy*minimumAlpha)
            const qualifies=kind==='growth'?s0===0&&s1>4*kill:kind==='shrink'?s1===0&&s0>4*kill:
                kind==='opposed'?s0>4*kill&&s1>4*kill&&minimumSpeed<kill*.5&&minimumAlpha>.1&&minimumAlpha<.9:
                    s0>0&&s1>0&&(s0>=kill)!==(s1>=kill)
            if(qualifies){chosen={row,col,s0,s1,minimumAlpha,minimumSpeed};break}
        }
        assert.ok(chosen,`A ${kind} fixture exists in the bounded source pages for t${time}`)
        const at=field=>Array.from({length:16},(_,index)=>{
            const offset=((chosen.row-1+Math.floor(index/4))*width+chosen.col-1+index%4)*2
            return [field[offset],field[offset+1]]
        })
        const current=at(a),next=at(b),d=current[5].map((v,i)=>next[5][i]-v)
        const qa=d[0]*d[0]+d[1]*d[1],qb=2*(current[5][0]*d[0]+current[5][1]*d[1]),qc=chosen.s0**2-kill**2
        const discriminant=qb*qb-4*qa*qc
        const roots=qa&&discriminant>0?[-1,1].map(sign=>(-qb+sign*Math.sqrt(discriminant))/(2*qa)).filter(v=>v>0&&v<1):[]
        const name=`real-t${time}-t${time+1}-${kind}`
        addSweep(name,current,next,kill,{p:[0,0],breakpoints:roots,denseCenter:kind==='opposed'?chosen.minimumAlpha:undefined,real:true})
        addSweep(`${name}-fractional`,current,next,kill,{p:[0.125,0.125],breakpoints:roots,real:true})
        choices.push({name,...chosen,globalTexel:[856*256+chosen.col,416*256+chosen.row],thresholdRoots:roots})
    }
    return {contentVersion:manifest.contentVersion,maximumSpeed:manifest.maximumSpeed,kill,
        spatialPages:[[10,416,856],[10,416,857]],times:['t00','t01','t02','t03','t04'],
        uniqueTileBytes:5*2*524288,choices,scope:'Representative source patches, not an exact screenshot camera'}
}
