import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const base=process.env.FLOW_CACHE_COHERENCE_BASE??'http://127.0.0.1:5173'
async function facade(module,symbol) {
    const response=await fetch(`${base}${module}`);assert.ok(response.ok)
    const imports=[...(await response.text()).matchAll(/import\s*\{([^}]+)\}\s*from\s*"([^"]+)"/g)]
    const match=imports.find(value=>value[1].includes(symbol));assert.ok(match,`Public facade for ${symbol}`)
    return new URL(match[2],base).href
}
const scratch=await facade('/flowField/flow-history.ts','GPURuntime')
const geo=await facade('/flowField/temporal-velocity-raster.ts','webMercatorVirtualRasterWgslModule')
const wrapper=await readFile(new URL('../../examples/flowField/shaders/temporal-velocity.wgsl',import.meta.url),'utf8')
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-webgpu']})
try {
    const page=await browser.newPage()
    await page.route('**/__flow_cache_coherence.html',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Flow cache producer coherence</title>'}))
    await page.goto(`${base}/__flow_cache_coherence.html`)
    const result=await page.evaluate(async ({scratch,geo,wrapper})=>{
        const {GPURuntime}=await import(scratch)
        const {WebMercatorQuad,tileMatrixCoverage,webMercatorVirtualRasterField}=await import(geo)
        const {createFlowCenterCache}=await import('/flowField/flow-center-cache.ts')
        const {temporalVelocityWgslModule}=await import('/flowField/temporal-velocity-raster.ts')
        const runtime=await GPURuntime.create({label:'Flow cache exact prior producer proof'}),owned=[],caches=[]
        const own=value=>(owned.push(value),value),require=(value,message)=>{if(!value)throw new Error(message)}
        async function settle(work) {
            const [,outcome]=await Promise.all([work.done,work.nativeOutcome])
            require(outcome.status==='observed-succeeded','Native source initialization must succeed')
        }
        try {
            const model=webMercatorVirtualRasterField({id:'cache-coherence',addressSpaceId:'cache-coherence-space',sourceRevision:'v1',
                coverage:tileMatrixCoverage({tileMatrixSet:WebMercatorQuad,limits:[{matrixId:'0',minTileRow:0,maxTileRow:0,minTileCol:0,maxTileCol:0}]}),
                geographicBounds:[-180,-85,180,85],coordinateBits:52,fieldKind:'vector',channels:2,sampleType:'float32',gpuFormat:'rg32float',interpolation:'linear'})
            const layout=own(await runtime.createBindLayout({group:1,entries:[
                {binding:0,name:'currentPageTable',type:'read-storage',visibility:['compute','fragment']},
                {binding:1,name:'currentAtlas',type:'texture',sampleType:'unfilterable-float',viewDimension:'2d',visibility:['compute','fragment']},
                {binding:2,name:'nextPageTable',type:'read-storage',visibility:['compute','fragment']},
                {binding:3,name:'nextAtlas',type:'texture',sampleType:'unfilterable-float',viewDimension:'2d',visibility:['compute','fragment']},
            ]}))
            const tables=[],atlases=[],initial=runtime.createSubmission({validation:'throw'})
            for(let endpoint=0;endpoint<2;endpoint++) {
                const table=own(await runtime.createBuffer({size:32,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST}))
                const atlas=own(await runtime.createTexture({size:{width:256,height:256},format:'rg32float',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST}))
                const pixels=new Float32Array(256*256*2);for(let i=0;i<pixels.length;i+=2)pixels[i]=2+endpoint
                initial.upload(own(runtime.createUploadCommand({target:table.region(),data:new Uint32Array([0,0,0,1,0,0,0,0])})))
                initial.upload(own(runtime.createTextureUploadCommand({target:atlas,data:pixels,layout:{bytesPerRow:2048,rowsPerImage:256},size:{width:256,height:256}})))
                tables.push(table);atlases.push(atlas)
            }
            await settle(initial.submit())
            const bindSet=own(await runtime.createBindSet(layout,{currentPageTable:tables[0].region(),currentAtlas:atlases[0].view(),nextPageTable:tables[1].region(),nextAtlas:atlases[1].view()}))
            const module=temporalVelocityWgslModule(model,model,{group:1,currentPageTableBinding:0,currentAtlasBinding:1,nextPageTableBinding:2,nextAtlasBinding:3,
                sampleRegistration:'pixel-center',activitySupport:'nearest-texel-zero',wrapper})
            const lower={addressSpace:model.addressSpace},upper={addressSpace:model.addressSpace}
            const prepared={state:'ready',requestedLevel:0,bindSet,resources:[tables[0],atlases[0],tables[1],atlases[1]],temporal:{lower:{runtime:lower},upper:{runtime:upper}}}
            const input=(lowerEpoch,upperEpoch)=>({pages:model.addressSpace.pages(),lowerSnapshot:{addressSpace:model.addressSpace,epoch:lowerEpoch},upperSnapshot:{addressSpace:model.addressSpace,epoch:upperEpoch}})
            const checks=[]
            for(const mode of ['same-builder-prior-write','external-encode-submit-write','fresh-build-prior-write']) {
                const cache=await createFlowCenterCache({runtime,temporal:{wgsl:module.code,layout},addressSpace:model.addressSpace,capacity:1,activityKill:.001});caches.push(cache)
                const first=runtime.createSubmission({validation:'throw'});cache.encode(first,prepared,input(1,1));await cache.observe(first.submit())
                const records=cache.resources[2],epoch=records.contentEpoch
                const clobber=own(runtime.createUploadCommand({target:records.region({offset:0,size:4}),data:new Uint32Array([0])}))
                const work=runtime.createSubmission({validation:'throw'})
                if(mode!=='external-encode-submit-write')work.upload(clobber)
                cache.encode(work,prepared,input(2,mode==='fresh-build-prior-write'?2:1))
                require(JSON.stringify(cache.facts().lastReuseSelectors)===JSON.stringify(mode==='fresh-build-prior-write'?[0,0]:[0,2]),'Fixture must actually select its copied upper lane')
                if(mode==='external-encode-submit-write')await settle(runtime.createSubmission({validation:'throw'}).upload(clobber).submit())
                if(mode==='fresh-build-prior-write') {
                    await cache.observe(work.submit())
                    checks.push({mode,status:'accepted-fresh-only'})
                } else {
                    let error
                    try {work.submit()} catch(cause) {error=cause}
                    const codes=error?.report?.diagnostics?.map(value=>value.code)??[]
                    require(codes.includes('SCRATCH_SUBMISSION_STALE_READ'),`Expected genuine Scratch stale-read validation: ${String(error)}`)
                    require(!work.isSubmitted,'Stale copied input is rejected before native submission')
                    require(records.contentEpoch===epoch+(mode==='external-encode-submit-write'?1:0),'Rejected submission cannot overwrite copied-byte provenance')
                    checks.push({mode,status:'rejected-before-submit',code:'SCRATCH_SUBMISSION_STALE_READ'})
                }
                cache.dispose();require(cache.facts().disposed&&!cache.facts().pending,'Abandoned cache cannot retain reusable pending state')
            }
            return {checks}
        } finally {
            for(const cache of caches)cache.dispose()
            for(const value of owned.reverse())value.dispose()
            await runtime.dispose()
        }
    },{scratch,geo,wrapper})
    assert.equal(result.checks.length,3)
    console.log(JSON.stringify({status:'passed',...result}))
} finally {await browser.close()}
