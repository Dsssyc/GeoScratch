import assert from 'node:assert/strict'
import {createFlowParticleRender} from '../examples/flowField/flow-particle-render.ts'

describe('Flow particle raster ownership',()=>{
    it('derives target-pixel width from reference pixels and uploads before drawing',async()=>{
        await fixture(async f=>{
            const render=await createFlowParticleRender(f.options),builder=f.builder()
            render.encode(builder,{width:128,height:80},[64,40])
            assert.deepEqual([...builder.steps[0].data],[128,80,1,.5])
            assert.equal(builder.steps.length,1)
            render.encode(f.builder(),{width:64,height:40},[64,40])
            assert.deepEqual([...f.upload.data],[64,40,.5,.5])
            render.dispose();render.dispose()
            assert.ok(f.owned.every(r=>r.disposed))
            assert.equal(f.borrowed.some(r=>r.disposed),false)
        })
    })
    it('rejects invalid preparation before recording work and cannot revive disposal',async()=>{
        await fixture(async f=>{
            const render=await createFlowParticleRender(f.options)
            for(const [size,reference] of [[{width:0,height:8},[8,8]],[{width:8,height:8},[0,8]],[{width:8.5,height:8},[8,8]]]){
                const b=f.builder();assert.throws(()=>render.encode(b,size,reference));assert.equal(b.steps.length,0)
            }
            assert.throws(()=>render.encode({...f.builder(),isSubmitted:true},{width:8,height:8},[8,8]))
            assert.throws(()=>render.encode({...f.builder(),runtime:{}},{width:8,height:8},[8,8]))
            render.dispose();assert.throws(()=>render.encode(f.builder(),{width:8,height:8},[8,8]))
        })
    })
    it('releases partially created raster resources while preserving borrowed inputs',async()=>{
        await fixture(async f=>{
            f.options.runtime.createShaderModule=async()=>{throw new Error('compile failed')}
            await assert.rejects(createFlowParticleRender(f.options),/compile failed/)
            assert.ok(f.owned.length>0&&f.owned.every(r=>r.disposed))
            assert.equal(f.borrowed.some(r=>r.disposed),false)
        })
    })
})

async function fixture(run){
    const previous={fetch:globalThis.fetch,usage:globalThis.GPUBufferUsage},owned=[],runtime={}
    globalThis.fetch=async()=>({ok:true,text:async()=>''})
    globalThis.GPUBufferUsage??={COPY_DST:8,UNIFORM:64}
    const leaf=descriptor=>{const r={...descriptor,runtime,disposed:false,dispose(){this.disposed=true},region(){return{resource:this}}};owned.push(r);return r}
    for(const name of ['createBuffer','createBindLayout','createBindSet','createShaderModule','createRenderPipeline'])runtime[name]=async descriptor=>leaf(descriptor)
    for(const name of ['createProgram','createDrawCommand'])runtime[name]=descriptor=>leaf(descriptor)
    let upload
    runtime.createUploadCommand=descriptor=>(upload=leaf(descriptor))
    const particles={runtime,size:112,region(){return{resource:this}}},uniform={runtime}
    const layout={runtime,group:1,entries:[{name:'contourView',type:'uniform',minBindingSize:112}]},set={runtime,layout}
    const f={options:{runtime,particles:{maximumCount:2,resources:{particles}},view:{bindLayout:layout,bindSet:set,resources:[uniform]}},owned,borrowed:[particles,uniform,layout,set],get upload(){return upload},builder(){return{runtime,isSubmitted:false,steps:[],upload(command){this.steps.push(command)}}}}
    try{await run(f)}finally{globalThis.fetch=previous.fetch;if(previous.usage===undefined)delete globalThis.GPUBufferUsage;else globalThis.GPUBufferUsage=previous.usage}
}
