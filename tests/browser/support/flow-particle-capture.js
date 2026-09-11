// Diagnostic-only capture: copies one actual input/output and then requires the application to stop.
(() => {
 const a=window.__flowCapture={requested:false,capture:null,errors:[],owned:[]}
 const shaders=new WeakMap(),pipelines=new WeakMap(),groups=new WeakMap(),layouts=new WeakMap(),pipelineLayouts=new WeakMap(),commands=new WeakMap()
 const request=GPUAdapter.prototype.requestDevice
 GPUAdapter.prototype.requestDevice=async function(desc={}){
  a.adapterLimits={maxStorageBuffersPerShaderStage:this.limits.maxStorageBuffersPerShaderStage,maxComputeInvocationsPerWorkgroup:this.limits.maxComputeInvocationsPerWorkgroup}
  a.adapterInfo={vendor:this.info.vendor,architecture:this.info.architecture,device:this.info.device,description:this.info.description}
  const device=await request.call(this,{...desc,requiredFeatures:[...new Set([...(desc.requiredFeatures??[]),'timestamp-query'])]})
  a.device=device;a.limits={maxStorageBuffersPerShaderStage:device.limits.maxStorageBuffersPerShaderStage}
  device.addEventListener('uncapturederror',e=>a.errors.push(e.error.message))
  const buffer=device.createBuffer.bind(device)
  device.createBuffer=d=>buffer({...d,usage:d.usage&3?d.usage:d.usage|GPUBufferUsage.COPY_SRC})
  const shader=device.createShaderModule.bind(device)
  device.createShaderModule=d=>{const m=shader(d);shaders.set(m,d);return m}
  const layout=device.createBindGroupLayout.bind(device)
  device.createBindGroupLayout=d=>{const l=layout(d);layouts.set(l,{...d,entries:[...d.entries]});return l}
  const pl=device.createPipelineLayout.bind(device)
  device.createPipelineLayout=d=>{const l=pl(d);pipelineLayouts.set(l,d);return l}
  const pipeline=device.createComputePipelineAsync.bind(device)
  device.createComputePipelineAsync=async d=>{const p=await pipeline(d);pipelines.set(p,d);return p}
  const group=device.createBindGroup.bind(device)
  device.createBindGroup=d=>{
   const g=group(d);groups.set(g,{...d,entries:[...d.entries]})
   if(d.label?.startsWith('Flow Field particle simulation bindings'))a.particleGroup=g
   return g
  }
  const createEncoder=device.createCommandEncoder.bind(device)
  device.createCommandEncoder=d=>{
   const e=createEncoder(d),begin=e.beginComputePass.bind(e),finish=e.finish.bind(e)
   let captured
   e.beginComputePass=d=>{
    const wanted=a.requested&&d?.label?.startsWith('Flow Field particle simulation pass')&&!a.capture
    if(!wanted)return begin(d)
    a.requested=false
    const record=captured=a.capture={groups:[],buffers:new Map(),ready:false}
    const clone=b=>{let c=record.buffers.get(b);if(c)return c;c=buffer({label:'Diagnostic snapshot '+b.label,size:b.size,usage:b.usage|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST});a.owned.push(c);e.copyBufferToBuffer(b,0,c,0,b.size);record.buffers.set(b,c);return c}
    const group0=groups.get(a.particleGroup)
    if(!group0)throw new Error('Particle group was not captured')
    for(const entry of group0.entries)if(entry.resource?.buffer)clone(entry.resource.buffer)
    const pass=begin(d),setPipeline=pass.setPipeline.bind(pass),setGroup=pass.setBindGroup.bind(pass),dispatch=pass.dispatchWorkgroups.bind(pass),end=pass.end.bind(pass)
    pass.setPipeline=p=>{record.pipeline=p;record.pipelineDescriptor=pipelines.get(p);record.code=shaders.get(record.pipelineDescriptor.compute.module).code;return setPipeline(p)}
    pass.setBindGroup=(i,g,...args)=>{record.groups[i]=groups.get(g);return setGroup(i,g,...args)}
    pass.dispatchWorkgroups=(...args)=>{record.dispatch=args;return dispatch(...args)}
    pass.end=()=>{
     end()
     for(const g of record.groups)for(const entry of g.entries)if(entry.resource?.buffer)clone(entry.resource.buffer)
     record.groupLayouts=record.groups.map(g=>layouts.get(g.layout))
     record.pipelineLayoutDescriptor=pipelineLayouts.get(record.pipelineDescriptor.layout)
     const particle=group0.entries.find(x=>x.binding===1).resource.buffer
     record.gold=buffer({size:particle.size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC});a.owned.push(record.gold);e.copyBufferToBuffer(particle,0,record.gold,0,particle.size)
    }
    return pass
   }
   e.finish=d=>{const c=finish(d);if(captured)commands.set(c,captured);return c}
   return e
  }
  const submit=device.queue.submit.bind(device.queue)
  device.queue.submit=xs=>{const list=[...xs];const r=submit(list);for(const x of list){const c=commands.get(x);if(c)device.queue.onSubmittedWorkDone().then(()=>{c.ready=true},error=>{c.error=String(error)})}return r}
  a.metadata={shaders,pipelines,groups,layouts,pipelineLayouts}
  return device
 }
})()
