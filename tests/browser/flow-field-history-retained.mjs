import assert from 'node:assert/strict'
import { chromium } from 'playwright'

// Exercise the real example-owned graph, not a reimplementation of its pass
// order. The only synthetic input is a uniform temporal field and fresh ink.
const base = process.env.FLOW_HISTORY_RETAINED_BASE ?? 'http://127.0.0.1:5173'
async function facadeFrom(module, exportedName) {
    const response = await fetch(`${base}${module}`)
    assert.ok(response.ok, `Vite must serve ${module}`)
    const body = await response.text()
    const imports = [...body.matchAll(/import\s*\{([^}]+)\}\s*from\s*"([^"]+)"/g)]
    const match = imports.find(value => value[1].includes(exportedName))
    assert.ok(match, `Discover Vite's public facade resolution for ${exportedName}`)
    return new URL(match[2], base).href
}
const scratchUrl = await facadeFrom('/flowField/flow-history.ts', 'GPURuntime')
const geoUrl = await facadeFrom('/flowField/temporal-velocity-raster.ts', 'webMercatorVirtualRasterWgslModule')
const browser = await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-webgpu']})
try {
    const page = await browser.newPage({viewport:{width:128,height:64},deviceScaleFactor:1})
    const errors = []
    page.on('pageerror',error => errors.push(error.message))
    page.on('console',message => { if (message.type()==='error') errors.push(message.text()) })
    await page.route('**/__flow_history_retained_proof.html',route => route.fulfill({
        contentType:'text/html',body:'<!doctype html><title>Flow history retained proof</title><canvas id="proof" width="32" height="8"></canvas>',
    }))
    await page.goto(`${base}/__flow_history_retained_proof.html`)
    const proof = await page.evaluate(async ({scratchUrl,geoUrl}) => {
        const {GPURuntime,layoutCodec} = await import(scratchUrl)
        const {WebMercatorQuad,tileMatrixCoverage,webMercatorVirtualRasterField} = await import(geoUrl)
        const {createFlowHistory} = await import('/flowField/flow-history.ts')
        const {flowPixelCenterRegistrationWgslModule} = await import('/flowField/flow-pixel-center-registration.ts')
        const require = (condition,message) => { if (!condition) throw new Error(message) }
        const runtime = await GPURuntime.create({label:'Flow retained actual graph proof'})
        const owned = [], own = value => (owned.push(value),value)
        const nativeSubmit = GPUQueue.prototype.submit
        let nativeSubmissions = 0
        GPUQueue.prototype.submit = function (buffers) { nativeSubmissions++;return nativeSubmit.call(this,buffers) }
        let history
        try {
            const canvas = document.querySelector('#proof')
            const surface = own(runtime.createSurface(canvas,{format:'rgba8unorm',alphaMode:'premultiplied'}))
            surface.resize({width:32,height:8})
            const model = webMercatorVirtualRasterField({
                id:'retained-proof',addressSpaceId:'retained-proof-space',sourceRevision:'v1',
                coverage:tileMatrixCoverage({tileMatrixSet:WebMercatorQuad,
                    limits:[{matrixId:'0',minTileRow:0,maxTileRow:0,minTileCol:0,maxTileCol:0}]}),
                geographicBounds:[-180,-85,180,85],coordinateBits:52,
                fieldKind:'vector',channels:2,sampleType:'float32',gpuFormat:'rg32float',interpolation:'linear',
            })
            const center = model.addressCodec.fromProjected([13_360_000.125,3_503_000.25]).fixed.limbs[0]
            const velocityCodec = layoutCodec({name:'FixtureVelocity',fields:[{name:'value',type:'vec4f'}]}, {usage:['uniform']})
            const velocityBytes = velocityCodec.pack({value:[1,0,1,0]})
            const velocity = own(await runtime.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}))
            const region = velocity.region({layout:velocityCodec.artifact})
            const upload = own(runtime.createUploadCommand({target:region,data:velocityBytes}))
            const supportBytes = velocityCodec.pack({value:[0,0,0,0]})
            const support = own(await runtime.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}))
            const supportRegion = support.region({layout:velocityCodec.artifact})
            const supportUpload = own(runtime.createUploadCommand({target:supportRegion,data:supportBytes}))
            const temporalLayout = own(await runtime.createBindLayout({group:1,entries:[
                {binding:0,name:'testVelocity',type:'uniform',visibility:['fragment'],minBindingSize:16},
                {binding:1,name:'testSupport',type:'uniform',visibility:['fragment'],minBindingSize:16},
            ]}))
            const temporalSet = own(await runtime.createBindSet(temporalLayout,{testVelocity:region,testSupport:supportRegion}))
            const prepared = {state:'ready',bindSet:temporalSet,resources:[velocity,support],requestedLevel:0,progress:0}
            const registrationModule=flowPixelCenterRegistrationWgslModule(model,{namespace:'FlowVelocityRegistration',
                addressNamespace:'FlowVelocityAddress',currentSamplerNamespace:'FlowVelocityCurrent',nextSamplerNamespace:'FlowVelocityNext'})
            const registrationEnd=registrationModule.code.indexOf('fn FlowVelocityRegistration_sample_current(')
            require(registrationEnd>0,'Use the production wide-fixed half-texel position adapter')
            // The stub keeps the real public address ABI and every production
            // shader compiles. B's reconstruction is disabled for this graph
            // ownership proof; the B mathematics has its own native tests.
            const temporal = model.addressCodec.wgslModule({namespace:'FlowVelocityAddress'}) +
                '\n'+registrationModule.code.slice(0,registrationEnd)+`
struct FlowVelocityTemporal { progress:f32, activityKill:f32, }
struct FlowVelocitySample { status:u32, velocity:vec2f, speed:f32, advectable:bool, resolved_level:u32, }
struct FixtureTexel { status:u32, value:vec4f, resolved_level:u32, }
@group(1) @binding(0) var<uniform> testVelocity:vec4f;
@group(1) @binding(1) var<uniform> testSupport:vec4f;
const FlowVelocity_nearest_zero_gate=false;
const FlowVelocityCurrent_level_count=1u;
const FlowVelocityNext_level_count=1u;
const FlowVelocityCurrent_page_size=vec2u(256u);
const FlowVelocityCurrent_matrix=array<u32,1>(0u);
const FlowVelocityCurrent_minimum_texel=array<vec2u,1>(vec2u(0u));
const FlowVelocityCurrent_maximum_texel=array<vec2u,1>(vec2u(255u));
const FlowVelocityNext_minimum_texel=array<vec2u,1>(vec2u(0u));
const FlowVelocityNext_maximum_texel=array<vec2u,1>(vec2u(255u));
fn fixture_center(p:vec2i,l:u32,next:bool)->FixtureTexel {
    let mode=u32(testSupport.x);
    if (mode==0u) { return FixtureTexel(1u,vec4f(testVelocity.xy,0,0),l); }
    var v=select(vec2f(1,0),vec2f(-1,0),next);
    if (mode==9u && !next && p.x%2==0 && p.y%2==1) { v=vec2f(0); }
    if ((mode==9u && next) || (mode==10u && !next)) {
        v=vec2f(f32(p.x)-212.84394530223088,f32(p.y)-105.12276504995907);
    }
    return FixtureTexel(1u,vec4f(v,0,0),l);
}
fn FlowVelocityCurrent_load_global(p:vec2i,l:u32)->FixtureTexel {
    return fixture_center(p,l,false);
}
fn FlowVelocityNext_load_global(p:vec2i,l:u32)->FixtureTexel {
    return fixture_center(p,l,true);
}
fn FlowVelocityCurrent_resolution_global(p:vec2i,l:u32)->vec2u { return vec2u(u32(testVelocity.z),l); }
fn FlowVelocityNext_resolution_global(p:vec2i,l:u32)->vec2u { return vec2u(u32(testVelocity.z),l); }
fn FlowVelocityCurrent_edge_blend_weight(p:FlowVelocityAddressFixedPosition,l:u32)->f32 { return 1.0; }
fn FlowVelocityNext_edge_blend_weight(p:FlowVelocityAddressFixedPosition,l:u32)->f32 { return 1.0; }
fn FlowVelocity_source_contains(p:FlowVelocityAddressFixedPosition)->bool { return true; }
fn FlowVelocity_sample(p:FlowVelocityAddressFixedPosition,l:u32,t:FlowVelocityTemporal)->FlowVelocitySample {
    let x=p.axes[0];
    let right=x.high>${center.high}u || (x.high==${center.high}u && x.low>=${center.low}u);
    let v=select(testVelocity.xy,vec2f(0),testVelocity.w>0.5 && right);
    return FlowVelocitySample(u32(testVelocity.z),v,length(v),length(v)>0.0 && length(v)>=t.activityKill,l);
}`
            history = await createFlowHistory({runtime,surface,size:surface.size,addressCodec:model.addressCodec,
                temporal:{wgsl:temporal,layout:temporalLayout},activityKill:.001,trailDecay:.9})
            const freshModule = own(await runtime.createShaderModule({sourceParts:[{code:`
@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
    let p=array<vec2f,4>(vec2f(-1,-1),vec2f(-1,1),vec2f(1,-1),vec2f(1,1));return vec4f(p[i],0,1);
}
@fragment fn fs(@builtin(position) p:vec4f)->@location(0) vec4f {
    return vec4f(0.2+p.x/64.0,0.6,0.8,1.0);
}`}]}))
            const freshProgram = own(runtime.createProgram({vertex:{module:freshModule,entryPoint:'vs'},fragment:{module:freshModule,entryPoint:'fs'}}))
            const freshPipeline = own(await runtime.createRenderPipeline({program:freshProgram,targets:[{format:'rgba8unorm'}],
                primitive:{topology:'triangle-strip'},depthStencil:{format:'depth32float',depthWriteEnabled:false,depthCompare:'less'}}))
            const fresh = own(runtime.createDrawCommand({pipeline:freshPipeline,count:{vertexCount:4},resources:{read:[],write:[]},whenMissing:'throw'}))
            let width=32,height=8,submissions=0
            const view = shift => ({kind:'geo-view-snapshot',
                clipFromRelativeWorld:[1,0,0,0,0,1,0,0,0,0,-1,0,0,0,0,1],
                cameraHigh:[13_360_000,3_503_000,.5],cameraLow:[.125+shift,.25,0],referenceViewport:[width,height]})
            async function submit({values=[1,0,1,0],seed=false,retained=false,shift=0,inspector=false,boundary='hard',feather=.25,
                commonInterior=false,coverageMode=commonInterior?1:0,progress=prepared.progress}={}) {
                await new Promise(resolve=>requestAnimationFrame(resolve))
                velocityCodec.write(velocityBytes,{value:values})
                velocityCodec.write(supportBytes,{value:[coverageMode,0,0,0]})
                prepared.progress=progress
                const builder=runtime.createSubmission({validation:'throw'})
                if (!retained) builder.upload(upload).upload(supportUpload)
                const frame=retained ? history.presentRetained(builder,view(shift))
                    : history.encode(builder,view(shift),seed?[fresh]:[],true,inspector?undefined:prepared,boundary,feather)
                const work=builder.submit()
                // Read the actual presented Surface. Raw textures remain private.
                // Snapshot in the acquisition task, before awaiting native scopes:
                // the browser may expire/clear its swap-chain image at a frame end.
                const copy=document.createElement('canvas');copy.width=width;copy.height=height
                const context=copy.getContext('2d');context.drawImage(canvas,0,0)
                const pixels=Array.from(context.getImageData(0,0,width,height).data)
                const [outcome]=await Promise.all([work.nativeOutcome,work.done])
                require(outcome.status==='observed-succeeded',`Native submission failed: ${JSON.stringify(outcome)}`)
                submissions++
                return {frame,facts:history.facts(),pixels}
            }
            const rgb = result => result.pixels.filter((_,index)=>index%4!==3)
            const energy = result => rgb(result).reduce((sum,value)=>sum+value,0)
            const same = (a,b) => a.pixels.every((value,index)=>value===b.pixels[index])
            const initial = await submit({seed:true})
            require(energy(initial)>50_000,`Fixture must contain visible fresh ink: ${energy(initial)}, ${initial.pixels.slice(0,16)}`)
            const zero = await submit({values:[0,0,1,0]})
            require(energy(zero)===0,'Reliable current zero must hide the final Surface')
            const zeroRetained = await submit({retained:true})
            require(same(zero,zeroRetained),'Unavailable presentation must not expose hidden raw ink')
            require(zero.facts.nextDirection===zeroRetained.facts.nextDirection,'Retained cannot advance raw direction')
            const recovery = await submit()
            require(energy(recovery)>energy(initial)*.55,'Raw ink must recover after zero without reseeding')
            require(energy(recovery)<energy(initial)*.85,'Recovery must include finite normal decay')
            const next = await submit()
            require(next.frame.target!==recovery.frame.target,'Exercise both raw composition directions')
            require(energy(next)>energy(recovery)*.65,'The clipped display must not replace next raw history')
            const half = await submit({values:[1,0,1,1]})
            const halfEnergy=energy(half)
            require(halfEnergy>energy(next)*.2 && halfEnergy<energy(next)*.7,'Establish mixed hidden and visible ink')
            const beforeDirection=half.facts.nextDirection
            const retainedA = await submit({retained:true})
            const retainedB = await submit({retained:true,shift:.25})
            const retainedA2 = await submit({retained:true})
            require(same(half,retainedA),'Ready to retained preserves the already clipped image')
            require(!same(retainedA,retainedB),'Retained camera movement must reproject visible ink')
            require(same(retainedA,retainedA2),'Retained A-B-A must avoid accumulated resampling or decay')
            require([retainedA,retainedB,retainedA2].every(result=>result.facts.nextDirection===beforeDirection),
                'Retained camera frames must not advance raw ownership')
            // Retirement of presentation commands does not dispose their borrowed
            // temporal set: reusing exactly that set must recover the whole raw field.
            const resumed = await submit()
            require(energy(resumed)>halfEnergy*1.35,'Ready resumption recovers hidden half from untouched raw')
            const sdfZero = await submit({values:[0,0,1,0],boundary:'sdf'})
            require(energy(sdfZero)===0,'B fallback must keep A reliable-zero visibility')
            require(same(sdfZero,await submit({retained:true})),'B retained cannot expose hidden raw')
            const inspector = await submit({values:[0,0,1,0],inspector:true})
            require(energy(inspector)>halfEnergy,'Inspector without a prepared pair remains unfiltered')
            const sdfCases = []
            for (const fixture of [
                {name:'failed',status:4,hidden:true,feather:.05},
                {name:'unknown-zero',status:0,hidden:false,feather:.15},
                {name:'fallback-zero',status:2,hidden:false,feather:.35},
                {name:'reliable-zero',status:1,hidden:true,feather:.25},
            ]) {
                const before=history.facts().sdfPresentationCount
                const ready=await submit({values:[0,0,fixture.status,0],boundary:'sdf',feather:fixture.feather})
                require(fixture.hidden ? energy(ready)===0 : energy(ready)>10_000,
                    `B ${fixture.name} must distinguish reliable invisibility from unknown support`)
                require(ready.facts.sdfPresentationCount===before+1,'An admitted B presentation increments exactly once')
                const retained=await submit({retained:true})
                require(same(ready,retained),`Retained B ${fixture.name} must preserve last visible pixels`)
                for (const result of [ready,retained]) {
                    require(result.frame.boundary==='sdf' && result.facts.boundary==='sdf',
                        `B ${fixture.name} frame and facts retain the last visible boundary`)
                    require(result.frame.sdfFeatherTexels===fixture.feather && result.facts.sdfFeatherTexels===fixture.feather,
                        `B ${fixture.name} frame and facts retain the last visible feather`)
                }
                require(retained.facts.sdfPresentationCount===ready.facts.sdfPresentationCount,
                    'Replaying a clipped B image is not a new SDF presentation')
                require(retained.facts.nextDirection===ready.facts.nextDirection,
                    'B retained presentation cannot advance raw ownership')
                sdfCases.push({name:fixture.name,energy:energy(ready),feather:fixture.feather,
                    sdfPresentationCount:ready.facts.sdfPresentationCount})
            }
            history.reset()
            const reset = await submit({retained:true})
            require(reset.frame.cleared && energy(reset)===0,'Reset invalidates retained visible image immediately')
            const emptyReady = await submit()
            require(energy(emptyReady)===0,'Reset also clears both raw directions before the next ready step')
            await submit({seed:true})
            width=40;height=10
            surface.resize({width,height});await history.resize({width,height})
            const resized = await submit({retained:true})
            require(resized.frame.cleared && energy(resized)===0,'Resize cannot retain an old image')
            const resizeSeed = await submit({seed:true})
            require(energy(resizeSeed)>50_000,'Stable resized bindings must resume with fresh ink')
            require(same(resizeSeed,await submit({retained:true})),'Resized retained commands use prepared current views')
            // Exhaust raw with no fresh content under zero support, then recover.
            for(let i=0;i<64;i++) await submit({values:[0,0,1,0]})
            const expired = await submit()
            require(energy(expired)===0,'Hidden raw still expires finitely and cannot resurrect forever')
            const facts=history.facts()
            history.dispose()
            // A second actual graph exercises v3 source-supported stationary ink.
            // Current UV is exactly zero/non-advectable, but both endpoint
            // footprints are reliable and moving in opposite directions.
            prepared.progress=.5
            history=await createFlowHistory({runtime,surface,size:surface.size,addressCodec:model.addressCodec,
                temporal:{wgsl:temporal.replace('FlowVelocity_nearest_zero_gate=false;', 'FlowVelocity_nearest_zero_gate=true;'),layout:temporalLayout},
                activityKill:.001,trailDecay:.9})
            const interiorA=await submit({values:[0,0,1,0],seed:true,commonInterior:true})
            require(energy(interiorA)>50_000,'A preserves visible ink in common interior at true current zero')
            const interiorB=await submit({values:[0,0,1,0],boundary:'sdf',commonInterior:true})
            require(energy(interiorB)>energy(interiorA)*.75,'B shares common-interior visibility instead of punching a zero-speed hole')
            const interiorRetained=await submit({retained:true})
            require(same(interiorB,interiorRetained),'Retained preserves the last common-interior B image')
            require(interiorRetained.facts.sdfPresentationCount===interiorB.facts.sdfPresentationCount,
                'Retained common-interior display does not count as another SDF application')
            const interiorFailed=await submit({values:[0,0,4,0],boundary:'sdf',commonInterior:true})
            require(energy(interiorFailed)===0,'Failed current sampling cannot borrow the common-interior exemption')
            const bothDry=await submit({values:[0,0,1,0]})
            require(energy(bothDry)===0,'Both endpoint footprints zero still hide v3 ink')
            const interiorRecovered=await submit({values:[0,0,1,0],commonInterior:true})
            require(energy(interiorRecovered)>20_000,'Common-interior visibility recovers surviving raw without a reset')
            for(const boundary of ['hard','sdf']) {
                const before=await submit({values:[0,0,1,0],seed:true,coverageMode:9,progress:1,boundary})
                const after=await submit({values:[0,0,1,0],seed:true,coverageMode:10,progress:0,boundary})
                require(same(before,after),`${boundary}: identical raw ink at a shared spatial-zero endpoint has identical visibility`)
                require(!before.frame.cleared && !after.frame.cleared,`${boundary}: pair-join coverage does not reset history`)
            }
            prepared.progress=.5
            for(let i=0;i<64;i++) await submit({values:[0,0,1,0],commonInterior:true})
            const interiorExpired=await submit({values:[0,0,1,0],boundary:'sdf',commonInterior:true})
            require(energy(interiorExpired)===0,'Common interior must not preserve expired ink or create immortal still trails')
            // Compare an actual upload -> compute -> current-at-step draw through
            // the array route and the synchronous producer, using the same graph.
            const producerOwned=[], ownProducer=value=>(producerOwned.push(value),value)
            const generatedInk=ownProducer(await runtime.createBuffer({size:16,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST}))
            const initializeInk=ownProducer(runtime.createUploadCommand({target:generatedInk.region(),data:new Float32Array(4)}))
            const computeLayout=ownProducer(await runtime.createBindLayout({group:0,entries:[
                {binding:0,name:'inputValue',type:'uniform',visibility:['compute'],minBindingSize:16},
                {binding:1,name:'outputValue',type:'storage',visibility:['compute'],minBindingSize:16},
            ]}))
            const computeSet=ownProducer(await runtime.createBindSet(computeLayout,{inputValue:region,outputValue:generatedInk.region()}))
            const computeModule=ownProducer(await runtime.createShaderModule({sourceParts:[{code:`
@group(0) @binding(0) var<uniform> inputValue:vec4f;
@group(0) @binding(1) var<storage,read_write> outputValue:vec4f;
@compute @workgroup_size(1) fn main() { outputValue=vec4f(inputValue.x,0.6,0.8,1); }
`}]}))
            const computeProgram=ownProducer(runtime.createProgram({compute:{module:computeModule,entryPoint:'main'}}))
            const computePipeline=ownProducer(await runtime.createComputePipeline({program:computeProgram,
                layout:{mode:'explicit',bindLayouts:[computeLayout]}}))
            const computePass=ownProducer(runtime.createComputePass({label:'Content producer compute'}))
            const compute=ownProducer(runtime.createDispatchCommand({pipeline:computePipeline,bindSets:[{set:computeSet}],
                count:{workgroups:[1]},resources:{read:[velocity,generatedInk].map(resource=>({resource,contentEpoch:'current-at-step'})),
                    write:[generatedInk]},whenMissing:'throw'}))
            const inkLayout=ownProducer(await runtime.createBindLayout({group:0,entries:[
                {binding:0,name:'outputValue',type:'read-storage',visibility:['fragment'],minBindingSize:16},
            ]}))
            const inkSet=ownProducer(await runtime.createBindSet(inkLayout,{outputValue:generatedInk.region()}))
            const inkModule=ownProducer(await runtime.createShaderModule({sourceParts:[{code:`
@group(0) @binding(0) var<storage,read> outputValue:vec4f;
@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
    let p=array<vec2f,4>(vec2f(-1,-1),vec2f(-1,1),vec2f(1,-1),vec2f(1,1));return vec4f(p[i],0,1);
}
@fragment fn fs()->@location(0) vec4f { return outputValue; }
`}]}))
            const inkProgram=ownProducer(runtime.createProgram({vertex:{module:inkModule,entryPoint:'vs'},fragment:{module:inkModule,entryPoint:'fs'}}))
            const inkPipeline=ownProducer(await runtime.createRenderPipeline({program:inkProgram,layout:{mode:'explicit',bindLayouts:[inkLayout]},
                targets:[{format:'rgba8unorm'}],primitive:{topology:'triangle-strip'},
                depthStencil:{format:'depth32float',depthWriteEnabled:false,depthCompare:'less'}}))
            const inkDraw=ownProducer(runtime.createDrawCommand({pipeline:inkPipeline,bindSets:[{set:inkSet}],count:{vertexCount:4},
                resources:{read:[{resource:generatedInk,contentEpoch:'current-at-step'}],write:[]},whenMissing:'throw'}))
            async function producerFrame(deferred,boundary,value) {
                history.reset()
                await new Promise(resolve=>requestAnimationFrame(resolve))
                velocityCodec.write(velocityBytes,{value:[value,0,1,0]})
                velocityCodec.write(supportBytes,{value:[0,0,0,0]})
                const builder=runtime.createSubmission({validation:'throw'})
                let calls=0
                const produce=sameBuilder=>{
                    calls++
                    require(sameBuilder===builder,'Content receives the exact caller builder')
                    if (deferred) require(builder.steps.length===1 && builder.steps[0].kind==='upload',
                        'History upload must precede content preparation; no history pass may precede it')
                    sameBuilder.upload(upload).upload(supportUpload).upload(initializeInk).compute(computePass,[compute])
                    return [inkDraw]
                }
                history.encode(builder,view(0),deferred?produce:produce(builder),true,prepared,boundary,.25)
                require(calls===1,'A content producer is invoked exactly once')
                const before=nativeSubmissions,work=builder.submit()
                const copy=document.createElement('canvas');copy.width=width;copy.height=height
                const context=copy.getContext('2d');context.drawImage(canvas,0,0)
                const pixels=Array.from(context.getImageData(0,0,width,height).data)
                const [outcome]=await Promise.all([work.nativeOutcome,work.done])
                require(outcome.status==='observed-succeeded','Actual producer graph must succeed')
                submissions++
                return {pixels,nativeSubmissions:nativeSubmissions-before}
            }
            const producerCases=[]
            for (const boundary of ['hard','sdf','sdf-center-linear','sdf-center-smooth']) {
                for (const value of [.2,.6]) {
                    const array=await producerFrame(false,boundary,value)
                    const deferred=await producerFrame(true,boundary,value)
                    require(same(array,deferred),`${boundary}: upload scheduling must preserve every Surface byte`)
                    require(deferred.pixels[0]===Math.round(value*255),
                        `${boundary}/${value}: draw must read this frame's computed value, got ${deferred.pixels[0]}`)
                    require(array.nativeSubmissions===2 && deferred.nativeSubmissions===1,
                        `${boundary}: equivalent work must consolidate native submits 2 -> 1`)
                    producerCases.push({boundary,value,arrayNative:array.nativeSubmissions,producerNative:deferred.nativeSubmissions,exact:true})
                }
            }
            const beforeFailures=JSON.stringify(history.facts())
            const expectProducerFailure=(callback,pattern)=>{
                const builder=runtime.createSubmission({validation:'throw'})
                let caught
                try { history.encode(builder,view(.25),callback,false,prepared,'sdf-center-linear') } catch(error) { caught=error }
                require(caught && pattern.test(caught.message),'Reject producer contract violations synchronously')
                require(JSON.stringify(history.facts())===beforeFailures,'Failed content cannot advance history state')
            }
            expectProducerFailure(()=>{throw new Error('fixture producer failure')},/fixture producer failure/)
            for (const value of [undefined,null,{},Promise.resolve([])]) {
                expectProducerFailure(()=>value,/synchronously return/)
            }
            expectProducerFailure(()=>Promise.reject(new Error('invalid async producer')),/synchronously return/)
            expectProducerFailure(()=>history.resize({width:16,height:8}),/synchronously return/)
            for (const operation of [()=>history.reset(),()=>history.dispose(),
                ()=>history.presentRetained(runtime.createSubmission(),view(0))]) {
                expectProducerFailure(()=>{operation();return []},/cannot reenter/)
            }
            let premature
            expectProducerFailure(builder=>{premature=builder.submit();return []},/must not submit/)
            await Promise.all([premature.nativeOutcome,premature.done])
            // Failed builders are abandoned, not submitted/retried. Retained
            // presentation remains unchanged, and a new valid producer can resume.
            const retainedAfterFailure=await submit({retained:true})
            const retainedAgain=await submit({retained:true})
            require(same(retainedAfterFailure,retainedAgain),'Producer failure cannot advance or decay retained ink')
            const recoveredProducer=await producerFrame(true,'hard',.2)
            require(recoveredProducer.pixels[0]===51,'Producer guard is released after all failure paths')
            for (const resource of producerOwned.reverse()) resource.dispose()
            history.dispose();history=undefined
            // Verify the graph released its own textures/buffer but not the
            // borrowed temporal buffers. All other graph objects dispose below.
            const graphResources=runtime.diagnostics.snapshot().resources
            require(graphResources.length===2 && graphResources.every(value=>value.id===velocity.id || value.id===support.id),
                `History leaked owned resources: ${JSON.stringify(graphResources)}`)
            const stats={submissions,initial:energy(initial),recovery:energy(recovery),half:halfEnergy,
                resumed:energy(resumed),retainedABAExact:true,sdfCases,expired:energy(expired),facts,
                commonInterior:{hard:energy(interiorA),sdf:energy(interiorB),recovered:energy(interiorRecovered),
                    sharedEndpointABExact:true,expired:energy(interiorExpired)},
                contentProducer:{cases:producerCases,failuresPreserveHistory:true,retainedExact:true}}
            for(const resource of owned.reverse()) resource.dispose()
            owned.length=0
            const final=runtime.diagnostics.snapshot()
            require(final.resources.length===0 && final.pendingOperations.length===0,'All owned resources and operations must settle')
            require(runtime.diagnostics.exportEvidence().incidents.length===0,'No GPU incident may be hidden by successful pixel checks')
            runtime.dispose()
            return {...stats,cleanup:{resources:final.resources.length,pending:final.pendingOperations.length,runtimeDisposed:runtime.isDisposed}}
        } finally {
            GPUQueue.prototype.submit=nativeSubmit
            history?.dispose()
            for(const resource of owned.reverse()) resource.dispose()
            runtime.dispose()
        }
    },{scratchUrl,geoUrl})
    assert.deepEqual(errors,[])
    console.log(JSON.stringify({status:'passed',proof,errors},null,2))
} finally { await browser.close() }
