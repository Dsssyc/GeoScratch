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
        const require = (condition,message) => { if (!condition) throw new Error(message) }
        const runtime = await GPURuntime.create({label:'Flow retained actual graph proof'})
        const owned = [], own = value => (owned.push(value),value)
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
            const temporalLayout = own(await runtime.createBindLayout({group:1,entries:[
                {binding:0,name:'testVelocity',type:'uniform',visibility:['fragment'],minBindingSize:16},
            ]}))
            const temporalSet = own(await runtime.createBindSet(temporalLayout,{testVelocity:region}))
            const prepared = {state:'ready',bindSet:temporalSet,resources:[velocity],requestedLevel:0,progress:0}
            // The stub keeps the real public address ABI and every production
            // shader compiles. B's reconstruction is disabled for this graph
            // ownership proof; the B mathematics has its own native tests.
            const temporal = model.addressCodec.wgslModule({namespace:'FlowVelocityAddress'}) + `
struct FlowVelocityTemporal { progress:f32, activityKill:f32, }
struct FlowVelocitySample { status:u32, velocity:vec2f, speed:f32, advectable:bool, resolved_level:u32, }
struct FixtureTexel { status:u32, value:vec4f, resolved_level:u32, }
@group(1) @binding(0) var<uniform> testVelocity:vec4f;
const FlowVelocity_nearest_zero_gate=false;
const FlowVelocityCurrent_level_count=1u;
const FlowVelocityCurrent_page_size=vec2u(256u);
const FlowVelocityCurrent_matrix=array<u32,1>(0u);
const FlowVelocityCurrent_minimum_texel=array<vec2u,1>(vec2u(0u));
const FlowVelocityCurrent_maximum_texel=array<vec2u,1>(vec2u(255u));
fn FlowVelocityCurrent_load_global(p:vec2i,l:u32)->FixtureTexel { return FixtureTexel(1u,testVelocity,l); }
fn FlowVelocityNext_load_global(p:vec2i,l:u32)->FixtureTexel { return FixtureTexel(1u,testVelocity,l); }
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
            async function submit({values=[1,0,1,0],seed=false,retained=false,shift=0,inspector=false,boundary='hard',feather=.25}={}) {
                await new Promise(resolve=>requestAnimationFrame(resolve))
                velocityCodec.write(velocityBytes,{value:values})
                const builder=runtime.createSubmission({validation:'throw'})
                if (!retained) builder.upload(upload)
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
            history.dispose();history=undefined
            // Verify the graph released its own textures/buffer but not the
            // borrowed temporal buffer. All other graph objects dispose below.
            const graphResources=runtime.diagnostics.snapshot().resources
            require(graphResources.length===1 && graphResources[0].id===velocity.id,
                `History leaked owned resources: ${JSON.stringify(graphResources)}`)
            const stats={submissions,initial:energy(initial),recovery:energy(recovery),half:halfEnergy,
                resumed:energy(resumed),retainedABAExact:true,sdfCases,expired:energy(expired),facts}
            for(const resource of owned.reverse()) resource.dispose()
            owned.length=0
            const final=runtime.diagnostics.snapshot()
            require(final.resources.length===0 && final.pendingOperations.length===0,'All owned resources and operations must settle')
            require(runtime.diagnostics.exportEvidence().incidents.length===0,'No GPU incident may be hidden by successful pixel checks')
            runtime.dispose()
            return {...stats,cleanup:{resources:final.resources.length,pending:final.pendingOperations.length,runtimeDisposed:runtime.isDisposed}}
        } finally {
            history?.dispose()
            for(const resource of owned.reverse()) resource.dispose()
            runtime.dispose()
        }
    },{scratchUrl,geoUrl})
    assert.deepEqual(errors,[])
    console.log(JSON.stringify({status:'passed',proof,errors},null,2))
} finally { await browser.close() }
