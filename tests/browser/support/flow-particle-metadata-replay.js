window.replayFlowSamplerMetadata = async function(geoUrl, recordedReference) {
    const geo = await import(geoUrl)
    const {temporalVelocityWgslModule} = await import('/flowField/temporal-velocity-raster.ts')
    const wrapperResponse = await fetch('/flowField/shaders/temporal-velocity.wgsl')
    if (!wrapperResponse.ok) throw new Error('Temporal shader asset unavailable')
    const wrapper = await wrapperResponse.text()
    const a = window.__flowCapture, c = a.capture, d = a.device, own = value => (a.owned.push(value), value)
    const create = (size, usage) => own(d.createBuffer({size, usage}))
    const read = async buffer => {
        const target = create(buffer.size, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST)
        const e = d.createCommandEncoder(); e.copyBufferToBuffer(buffer, 0, target, 0, buffer.size); d.queue.submit([e.finish()])
        await target.mapAsync(GPUMapMode.READ); const result = target.getMappedRange().slice(0); target.unmap(); return result
    }
    const hash = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('')
    const coverage = geo.tileMatrixCoverage({tileMatrixSet:geo.WebMercatorQuad, limits:[{matrixId:'0',minTileCol:0,maxTileCol:0,minTileRow:0,maxTileRow:0}]})
    const dummy = geo.webMercatorVirtualRasterField({id:'decode',addressSpaceId:'decode',sourceRevision:'1',coverage,
        geographicBounds:[-120,-40,120,40],fieldKind:'vector',channels:2,sampleType:'float32',gpuFormat:'rg32float',interpolation:'linear'})
    const codec = geo.prepareWebMercatorVirtualRasterSampler(dummy).layout
    const models = []
    for (const binding of [4,5]) {
        const original = c.groups[1].entries.find(e => e.binding === binding).resource.buffer
        const bytes = await read(c.buffers.get(original)), data = codec.createReadbackView(bytes).toObject()
        if (data.decoding[1] !== 0) throw new Error('Expected the Flow no-NoData sampling family')
        const coverage = geo.tileMatrixCoverage({tileMatrixSet:geo.WebMercatorQuad, limits:data.levels.slice(0,data.dimensions[0]).map(level => ({
            matrixId:String(level.mapping[0]),minTileCol:level.tileBounds[0],minTileRow:level.tileBounds[1],maxTileCol:level.tileBounds[2],maxTileRow:level.tileBounds[3],
        }))})
        const address = geo.webMercatorQuadAddressCodec({coverage,coordinateBits:data.dimensions[3]})
        const coordinate = words => geo.WebMercatorQuad.unproject(address.toProjected(address.fromWorldQuanta([
            BigInt(words[0]) + (BigInt(words[1]) << 32n), BigInt(words[2]) + (BigInt(words[3]) << 32n),
        ])))
        const nw = coordinate(data.sourceWestNorth), se = coordinate(data.sourceEastSouth)
        const model = geo.webMercatorVirtualRasterField({id:'captured-'+binding,addressSpaceId:'captured-'+binding,sourceRevision:'1',coverage,
            coordinateBits:data.dimensions[3], geographicBounds:[nw[0],se[1],se[0],nw[1]],fieldKind:'vector',channels:2,sampleType:'float32',gpuFormat:'rg32float',
            interpolation:'linear',scale:data.scale.slice(0,2),offset:data.offset.slice(0,2)})
        if (await hash(geo.prepareWebMercatorVirtualRasterSampler(model).pack()) !== await hash(bytes)) {
            throw new Error('Captured source interpretation did not reconstruct byte-exactly')
        }
        models.push(model)
    }
    const options = {group:1,currentPageTableBinding:0,currentAtlasBinding:1,nextPageTableBinding:2,nextAtlasBinding:3,
        sampleRegistration:'pixel-center',activitySupport:'nearest-texel-zero',wrapper}
    const metadataCode = temporalVelocityWgslModule(...models,{...options,currentMetadataBinding:4,nextMetadataBinding:5}).code
    const constantCode = temporalVelocityWgslModule(...models,options).code
    if (!c.code.includes(metadataCode)) throw new Error('Captured shader does not contain the stable metadata module')
    const referenceCode = c.code.replace(metadataCode,constantCode)
    const cases = models[0].coverage.limits.map(limit => {
        const matrix=Number(limit.matrixId),offset=models[0].coverage.index({matrixId:limit.matrixId,tileCol:limit.minTileCol,tileRow:limit.minTileRow})
        return `case ${matrix}u: { if(any(tile<vec2u(${limit.minTileCol}u,${limit.minTileRow}u)) || any(tile>vec2u(${limit.maxTileCol}u,${limit.maxTileRow}u))){return FlowVelocityAddress_not_covered;}
            let local=tile-vec2u(${limit.minTileCol}u,${limit.minTileRow}u);return ${offset}u+local.y*${limit.maxTileCol-limit.minTileCol+1}u+local.x; }`
    })
    const start=referenceCode.indexOf('fn FlowVelocityAddress_compact_index(')
    if(start<0)throw new Error('Constant coverage reference is missing')
    let end=referenceCode.indexOf('{',start)+1,depth=1
    while(depth){const ch=referenceCode[end++];if(ch==='{')depth++;if(ch==='}')depth--}
    const switched=referenceCode.slice(0,start)+`fn FlowVelocityAddress_compact_index(matrix:u32,tile:vec2u)->u32{switch(matrix){${cases.join('\n')}default:{return FlowVelocityAddress_not_covered;}}}`+referenceCode.slice(end)
    const work = new Map()
    for (const [original,snapshot] of c.buffers) work.set(original,create(snapshot.size,snapshot.usage|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC))
    const layouts = c.groupLayouts.map(desc => d.createBindGroupLayout(desc))
    const groups = c.groups.map((group,i) => d.createBindGroup({layout:layouts[i],entries:group.entries.map(entry => ({...entry,
        resource:entry.resource?.buffer ? {...entry.resource,buffer:work.get(entry.resource.buffer)} : entry.resource,
    }))}))
    const layout = d.createPipelineLayout({bindGroupLayouts:layouts})
    const particle = work.get(c.groups[0].entries.find(e => e.binding === 1).resource.buffer)
    const configBytes = await read(c.buffers.get(c.groups[0].entries.find(e => e.binding === 0).resource.buffer))
    const config = new DataView(configBytes), count=config.getUint32(0,true)
    if (config.getUint32(56,true)!==0) throw new Error('Replay requires a stationary frame without pending reveal refill')
    const gold = await hash(await read(c.gold))
    const queries = own(d.createQuerySet({type:'timestamp',count:2}))
    const resolved = create(16,GPUBufferUsage.QUERY_RESOLVE|GPUBufferUsage.COPY_SRC)
    const timing = create(16,GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ)
    const variants=[]
    const descriptions=[['constant-256',referenceCode,256],['switch-256',switched,256],['metadata-256',c.code,256],
        ['constant-64',referenceCode,64],['switch-64',switched,64],['metadata-64',c.code,64],
        ...(recordedReference?[['recorded-original-256',recordedReference,256]]:[])]
    for(const [name,source,wg] of descriptions) {
        const marker='@compute @workgroup_size(256)\nfn FlowParticles_simulate'
        if(!source.includes(marker))throw new Error('Unknown particle simulation workgroup declaration')
        const module=d.createShaderModule({code:source.replace(marker,`@compute @workgroup_size(${wg})\nfn FlowParticles_simulate`)})
        const errors=(await module.getCompilationInfo()).messages.filter(m=>m.type==='error')
        if(errors.length)throw new Error(errors.map(m=>m.message).join('\n'))
        variants.push({name,wg,pipeline:await d.createComputePipelineAsync({layout,compute:{module,entryPoint:'FlowParticles_simulate'}}),samples:[]})
    }
    async function run(variant) {
        const e=d.createCommandEncoder()
        for(const [original,snapshot] of c.buffers)e.copyBufferToBuffer(snapshot,0,work.get(original),0,snapshot.size)
        const pass=e.beginComputePass({timestampWrites:{querySet:queries,beginningOfPassWriteIndex:0,endOfPassWriteIndex:1}})
        pass.setPipeline(variant.pipeline);groups.forEach((group,i)=>pass.setBindGroup(i,group));pass.dispatchWorkgroups(Math.ceil(count/variant.wg));pass.end()
        e.resolveQuerySet(queries,0,2,resolved,0);e.copyBufferToBuffer(resolved,0,timing,0,16);d.queue.submit([e.finish()])
        await timing.mapAsync(GPUMapMode.READ);const values=new BigUint64Array(timing.getMappedRange())
        const ms=Number(values[1]-values[0])/1e6;timing.unmap();return ms
    }
    for(const variant of variants){await run(variant);variant.sha256=await hash(await read(particle));if(variant.sha256!==gold)throw new Error('Particle output mismatch: '+variant.name)}
    const order=[...variants.keys(),...[...variants.keys()].reverse()]
    for(let round=0;round<6;round++)for(const i of order){const ms=await run(variants[i]);if(round)variants[i].samples.push(ms)}
    if(a.errors.length)throw new Error(a.errors.join('\n'))
    return {count,gold,adapter:a.adapterInfo,recordedReferenceSha256:recordedReference?await hash(new TextEncoder().encode(recordedReference)):undefined,
        config:{level:config.getUint32(4,true),referenceSteps:config.getFloat32(160,true),wholeSteps:config.getFloat32(164,true)},
        variants:variants.map(({name,wg,samples,sha256})=>{const sorted=[...samples].sort((a,b)=>a-b);return {name,wg,sha256,samples,
            meanMs:samples.reduce((a,b)=>a+b,0)/samples.length,p50Ms:sorted[Math.floor(sorted.length/2)]}}),errors:a.errors}
}
