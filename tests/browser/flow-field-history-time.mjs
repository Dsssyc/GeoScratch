import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { chromium } from 'playwright'
import { layoutCodec } from 'geoscratch/scratch'

// Real raw-history fragment and rgba8unorm ping-pong targets. The reference
// fragment preserves the former one-tick floor/cutoff equation independently.
const source=await readFile(new URL('../../examples/flowField/shaders/history.wgsl',import.meta.url),'utf8')
const uniform=source.match(/struct FlowFieldHistoryUniform \{([\s\S]*?)\n\};/)?.[1]
assert.ok(uniform,'Read the production history uniform declaration')
const fields=[...uniform.matchAll(/\s*(\w+)\s*:\s*(\w+)\s*,/g)].map(([,name,type])=>({name,type}))
const codec=layoutCodec({name:'FlowFieldHistoryUniform',fields},{usage:['uniform']})
assert.equal(codec.artifact.byteLength,352,'The trailing time counter must fit the existing ABI padding')
assert.equal(codec.artifact.fields.find(field=>field.name==='decaySteps')?.offset,344,'Use the actual trailing u32 at byte 344')
assert.equal(codec.artifact.fields.find(field=>field.name==='decaySteps')?.type.wgslType,'u32')
const fragmentStart=source.indexOf('@fragment')
assert.ok(fragmentStart>0)
const legacy=source.slice(0,fragmentStart)+`
@fragment
fn fMain(input:VertexOutput)->@location(0) vec4f {
    let dim=vec2f(textureDimensions(historyTexture,0));
    let pixel=vec2i(correctedPixel(dim*input.texcoords,dim));
    let color=textureLoad(historyTexture,pixel,0);
    let faded=floor(255.0*color*cleanupUniform.trailDecay)/255.0;
    let residual=max(max(faded.r,faded.g),faded.b);
    if(residual<=cleanupUniform.trailCutoff){return vec4f(0.0);}
    return faded;
}`
const width=256,height=8,byteLength=width*height*4,ink=new Uint8Array(byteLength)
for(let value=0;value<256;value++) {
    const patterns=[
        [value,value,value,value],[value,0,0,255],[0,value,0,255],[0,0,value,255],
        [255,64,32,value],[value,255-value,value*73%256,value*19%256],
        [1,0,0,value],[0,0,0,value],
    ]
    patterns.forEach((pixel,row)=>ink.set(pixel,(row*width+value)*4))
}
const identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]
const baseValues=Object.fromEntries(fields.map(({name,type})=>[name,type==='mat4x4f'?identity:
    type.startsWith('vec')?Array(Number(type[3])).fill(0):0]))
Object.assign(baseValues,{trailDecay:.996,trailCutoff:1/255,historyMode:0,historyValid:1,
    previousViewport:[width,height],currentViewport:[width,height]})
const configs={}
for(const steps of [0,1,2,3,7])configs[`steps-${steps}`]=[...codec.pack({...baseValues,decaySteps:steps})]
const shifted=identity.slice();shifted[12]=2/width
configs['zero-reproject']=[...codec.pack({...baseValues,decaySteps:0,historyMode:2,historyReprojecting:1,previousMatrix:shifted})]
configs['zero-invalid-reproject']=[...codec.pack({...baseValues,decaySteps:0,historyMode:2,historyReprojecting:1,historyValid:0})]
const repeat=(count,steps)=>Array(count).fill(`steps-${steps}`)
const runs=[
    {name:'legacy-one',legacy:true,steps:repeat(1,1)},
    {name:'legacy-two',legacy:true,steps:repeat(2,1)},
    {name:'legacy-three',legacy:true,steps:repeat(3,1)},
    {name:'zero',steps:repeat(1,0)},
    {name:'zero-many',steps:repeat(120,0)},
    {name:'one',steps:repeat(1,1)},
    {name:'two',steps:repeat(1,2)},
    {name:'three',steps:repeat(1,3)},
    {name:'capped-seven',steps:repeat(1,7)},
    {name:'hz30',steps:repeat(60,2)},
    {name:'hz60',steps:repeat(120,1)},
    {name:'hz120',steps:Array.from({length:240},(_,index)=>`steps-${index%2}`)},
    {name:'hz20',steps:repeat(40,3)},
    {name:'legacy-120',legacy:true,steps:repeat(120,1)},
    {name:'finite-expiry',steps:repeat(120,3)},
    {name:'zero-reproject',steps:['zero-reproject']},
    {name:'zero-invalid-reproject',steps:['zero-invalid-reproject']},
]

if(process.argv.includes('--prepare-only')) {
    console.log(JSON.stringify({status:'fixtures-prepared',uniformBytes:codec.artifact.byteLength,decayStepsOffset:344,
        byteValues:256,rgbaPatterns:8,runs:runs.length,renderPasses:runs.reduce((sum,run)=>sum+run.steps.length,0)}))
} else {
    const server=createServer((_request,response)=>response.end('<!doctype html><title>Flow quantized history clock proof</title>'))
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
    let browser
    try {
        browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-webgpu']})
        const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`)
        const proof=await page.evaluate(async ({source,legacy,configs,runs,ink,width,height})=>{
            const adapter=await navigator.gpu.requestAdapter();if(!adapter)throw new Error('WebGPU adapter unavailable')
            const device=await adapter.requestDevice(),owned=[],errors=[]
            device.addEventListener('uncapturederror',event=>errors.push(event.error.message));device.pushErrorScope('validation')
            try {
                const uniforms=device.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.FRAGMENT,buffer:{type:'uniform',minBindingSize:352}}]})
                const empty=device.createBindGroupLayout({entries:[]}),emptyGroup=device.createBindGroup({layout:empty,entries:[]})
                const textures=device.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:'float'}}]})
                const layout=device.createPipelineLayout({bindGroupLayouts:[uniforms,empty,textures]})
                const pipelines=[]
                for(const code of [source,legacy]) {
                    const module=device.createShaderModule({code})
                    const messages=(await module.getCompilationInfo()).messages.filter(message=>message.type==='error')
                    if(messages.length)throw new Error(messages.map(message=>message.message).join('\n'))
                    pipelines.push(await device.createRenderPipelineAsync({layout,vertex:{module,entryPoint:'vMain'},
                        fragment:{module,entryPoint:'fMain',targets:[{format:'rgba8unorm'}]},primitive:{topology:'triangle-strip'}}))
                }
                const uniformGroups={}
                for(const [name,bytes] of Object.entries(configs)) {
                    const buffer=device.createBuffer({size:352,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});owned.push(buffer)
                    device.queue.writeBuffer(buffer,0,new Uint8Array(bytes))
                    uniformGroups[name]=device.createBindGroup({layout:uniforms,entries:[{binding:0,resource:{buffer}}]})
                }
                const texture=()=>{
                    const value=device.createTexture({size:[width,height],format:'rgba8unorm',
                        usage:GPUTextureUsage.COPY_SRC|GPUTextureUsage.COPY_DST|GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.RENDER_ATTACHMENT})
                    owned.push(value);return value
                }
                const original=texture(),pingpong=[texture(),texture()]
                device.queue.writeTexture({texture:original},new Uint8Array(ink),{bytesPerRow:width*4},[width,height])
                const sourceGroups=pingpong.map(value=>device.createBindGroup({layout:textures,entries:[{binding:0,resource:value.createView()}]}))
                const bytesPerImage=width*height*4
                const readback=device.createBuffer({size:bytesPerImage*runs.length,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});owned.push(readback)
                const encoder=device.createCommandEncoder();let renderPasses=0
                for(const [runIndex,run] of runs.entries()) {
                    encoder.copyTextureToTexture({texture:original},{texture:pingpong[0]},[width,height])
                    let sourceIndex=0
                    for(const config of run.steps) {
                        const target=1-sourceIndex
                        const pass=encoder.beginRenderPass({colorAttachments:[{view:pingpong[target].createView(),
                            clearValue:[0,0,0,0],loadOp:'clear',storeOp:'store'}]})
                        pass.setPipeline(pipelines[run.legacy?1:0]);pass.setBindGroup(0,uniformGroups[config]);pass.setBindGroup(1,emptyGroup)
                        pass.setBindGroup(2,sourceGroups[sourceIndex]);pass.draw(4);pass.end()
                        sourceIndex=target;renderPasses++
                    }
                    encoder.copyTextureToBuffer({texture:pingpong[sourceIndex]},
                        {buffer:readback,offset:runIndex*bytesPerImage,bytesPerRow:width*4},[width,height])
                }
                device.queue.submit([encoder.finish()]);await readback.mapAsync(GPUMapMode.READ)
                const bytes=new Uint8Array(readback.getMappedRange())
                const outputs=Object.fromEntries(runs.map((run,index)=>[run.name,Array.from(bytes.slice(index*bytesPerImage,(index+1)*bytesPerImage))]))
                readback.unmap();await device.queue.onSubmittedWorkDone();const validation=await device.popErrorScope()
                if(validation)throw new Error(validation.message);if(errors.length)throw new Error(errors.join('\n'))
                return {outputs,renderPasses,readbacks:1,errors}
            } finally {for(const resource of owned)resource.destroy();device.destroy()}
        },{source,legacy,configs,runs,ink:[...ink],width,height})
        const out=proof.outputs
        assert.deepEqual(out.zero,[...ink],'Zero reference ticks preserve every channel, including below-cutoff and black-RGB ink')
        assert.deepEqual(out['zero-many'],out.zero,'Repeated zero-tick displays do not introduce quantization decay')
        for(const [actual,expected] of [['one','legacy-one'],['two','legacy-two'],['three','legacy-three'],
            ['capped-seven','three'],['hz60','legacy-120'],['hz30','hz60'],['hz120','hz60'],['hz20','hz60']]) {
            assert.deepEqual(out[actual],out[expected],`${actual} is byte-identical to ${expected}`)
        }
        assert.ok(out.hz60.some(value=>value>0),'Equal-wall-time comparison must still have visible ink, not merely compare expired zeros')
        assert.ok(out['finite-expiry'].every(value=>value===0),'All 256 levels and channel combinations expire in finite reference time')
        assert.deepEqual(out.two.slice(3*4,4*4),[0,0,0,0],'Two quantized ticks must not collapse to one exponential decay/floor')
        for(const run of runs.filter(run=>!run.name.includes('reproject')))for(let index=0;index<ink.length;index++) {
            assert.ok(out[run.name][index]<=ink[index],`${run.name}: decay cannot brighten a channel`)
        }
        const moved=new Uint8Array(byteLength)
        for(let y=0;y<height;y++)for(let x=0;x<width-1;x++)moved.set(ink.slice((y*width+x+1)*4,(y*width+x+2)*4),(y*width+x)*4)
        assert.deepEqual(out['zero-reproject'],[...moved],'Zero ticks still perform the original camera reprojection before identity decay')
        assert.ok(out['zero-invalid-reproject'].every(value=>value===0),'Zero ticks cannot bypass invalid-history projection clearing')
        console.log(JSON.stringify({status:'passed',uniformBytes:codec.artifact.byteLength,decayStepsOffset:344,byteValues:256,rgbaPatterns:8,
            referenceTicksAtComparison:120,equivalentRates:[20,30,60,120],finiteExpiryTicks:360,
            maximumRateDifference:0,maximumLegacyDifference:0,renderPasses:proof.renderPasses,readbacks:proof.readbacks,errors:proof.errors}))
    } finally {await browser?.close();await new Promise(resolve=>server.close(resolve))}
}
