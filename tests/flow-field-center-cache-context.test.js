import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { expect } from 'chai'
import ts from 'typescript'
import { virtualRasterAddressSpace } from 'geoscratch/geo'

const directory=new URL('../examples/flowField/',import.meta.url)
let source=await readFile(new URL('flow-center-cache.ts',directory),'utf8')
for(const [name,file] of [['buildShader','center-cache-build.wgsl'],['sampleShader','center-cache-sample.wgsl']]) {
    const shader=await readFile(new URL(`shaders/${file}`,directory),'utf8')
    source=source.replace(new RegExp(`import ${name} from '[^']+'`),`const ${name} = ${JSON.stringify(shader)}`)
}
source=source.replace("'./flow-center-cache-plan.ts'",JSON.stringify(new URL('flow-center-cache-plan.ts',directory).href))
// Compile the real owner; only Vite's raw-asset imports are injected for Node.
const javascript=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText
const {createFlowCenterCache}=await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`)

describe('Flow center cache endpoint contexts',()=>{
    it('commits only after native observation, then performs a validated whole-key hit',async()=>{
        await fixture(async f=>{
            const gate=deferred(),first=f.encode(f.a,f.b)
            expect(f.flags()).to.equal(0)
            expect(()=>f.encode(f.a,f.b)).to.throw('unobserved')
            const work=first.submit({native:gate.promise}),observing=f.cache.observe(work)
            expect(f.cache.facts()).to.include({pending:true,buildCount:1,reuseCount:0})
            expect(()=>f.encode(f.a,f.b)).to.throw('unobserved')
            gate.resolve({status:'observed-succeeded'});await observing
            const reused=f.encode(f.a,f.b)
            expect(reused.steps).to.have.length(0)
            await f.cache.observe(reused.submit())
            expect(f.cache.facts()).to.include({buildCount:1,reuseCount:1,rebuiltEndpointCount:2,reusedEndpointCount:0,pending:false})
        })
    })

    it('rebuilds only the endpoint whose whole residency epoch changed, including its halo',async()=>{
        await fixture(async f=>{
            await f.run(f.a,f.b)
            f.a.epoch++
            await f.run(f.a,f.b)
            expect(f.cache.facts().lastReuseSelectors).to.deep.equal([0,2])
            expect(f.flags()).to.equal(8)
            f.b.epoch++
            await f.run(f.a,f.b)
            expect(f.cache.facts().lastReuseSelectors).to.deep.equal([1,0])
            expect(f.cache.facts()).to.include({buildCount:3,rebuiltEndpointCount:4,reusedEndpointCount:2})
        })
    })

    it('moves bytes across forward, reverse and aliased runtime roles',async()=>{
        await fixture(async f=>{
            await f.run(f.a,f.b)
            await f.run(f.b,f.c)
            expect(f.cache.facts().lastReuseSelectors).to.deep.equal([2,0])
            await f.run(f.c,f.b)
            expect(f.cache.facts().lastReuseSelectors).to.deep.equal([2,1])
            expect(f.flags()).to.equal(6)
            await f.run(f.b,f.b)
            expect(f.cache.facts().lastReuseSelectors).to.deep.equal([2,2])
            expect(f.flags()).to.equal(10)
            const clone={...f.b}
            await f.run(clone,f.b)
            expect(f.cache.facts().lastReuseSelectors).to.deep.equal([0,2],'Equal ids/epochs/resources do not replace runtime object identity')
        })
    })

    it('invalidates only the changed source allocation when plan and other endpoint stay stable',async()=>{
        await fixture(async f=>{
            await f.run(f.a,f.b)
            f.a.table.allocationVersion++
            await f.run(f.a,f.b)
            expect(f.cache.facts().lastReuseSelectors).to.deep.equal([0,2])
            f.b.atlas.allocationVersion++
            await f.run(f.a,f.b)
            expect(f.cache.facts().lastReuseSelectors).to.deep.equal([1,0])
        })
    })

    it('never copies records across a changed page plan or source level, and safely disables empty plans',async()=>{
        await fixture(async f=>{
            await f.run(f.a,f.b)
            const reordered=f.encode(f.a,f.b,{indices:[1,0]})
            expect(reordered.steps).to.have.length(0)
            await f.cache.observe(reordered.submit())
            await f.run(f.a,f.b,{indices:[1]})
            expect(f.cache.facts().lastReuseSelectors).to.deep.equal([0,0])
            await f.run(f.a,f.b,{level:1,indices:[0]})
            expect(f.cache.facts().lastReuseSelectors).to.deep.equal([0,0])
            const empty=f.encode(f.a,f.b,{level:1,indices:[]})
            expect(empty.steps.filter(step=>step.kind==='compute')).to.have.length(0)
            await f.cache.observe(empty.submit())
            expect(f.cache.facts()).to.include({pageCount:0,pending:false})
            expect([...f.upload('Upload Flow center lookup').data].every(value=>value===0)).to.equal(true)
        })
    })

    it('checks owned content epochs and allocation versions even on the whole-key fast path',async()=>{
        for(const label of ['Flow center cache config','Flow center cache lookup','Flow center distance records']) {
            for(const field of ['contentEpoch','allocationVersion'])await fixture(async f=>{
                await f.run(f.a,f.b)
                f.resource(label)[field]++
                await f.run(f.a,f.b)
                expect(f.cache.facts().lastReuseSelectors).to.deep.equal([0,0],`${label}/${field}`)
                expect(f.cache.facts()).to.include({buildCount:2,reuseCount:0,rebuiltEndpointCount:4,reusedEndpointCount:0})
            })
        }
    })

    it('rejects writes between submission and observation, including writes during native settlement',async()=>{
        await fixture(async f=>{
            const build=f.encode(f.a,f.b),work=build.submit()
            f.resource('Flow center distance records').contentEpoch++
            await assert.rejects(f.cache.observe(work),/produced resource versions/)
            expect(()=>f.encode(f.a,f.b)).to.throw('unobserved')
        })
        await fixture(async f=>{
            await f.run(f.a,f.b)
            f.a.epoch++
            const gate=deferred(),build=f.encode(f.a,f.b),work=build.submit({native:gate.promise})
            const observing=f.cache.observe(work)
            f.resource('Flow center distance records').contentEpoch++
            gate.resolve({status:'observed-succeeded'})
            await assert.rejects(observing,/changed before build observation/)
            await f.run(f.a,f.b)
            expect(f.cache.facts().lastReuseSelectors).to.deep.equal([0,0])
        })
    })

    it('pins copied input bytes to the confirmed epoch before the new GPU producer can overwrite them',async()=>{
        for(const sameBuilder of [false,true])await fixture(async f=>{
            await f.run(f.a,f.b)
            const records=f.resource('Flow center distance records'),epoch=records.contentEpoch
            f.a.epoch++
            const build=f.encode(f.a,f.b)
            const dispatch=build.steps.find(step=>step.kind==='compute').command
            expect(dispatch.resources.read.find(value=>value.resource===records).contentEpoch).to.equal(epoch)
            if(sameBuilder)build.steps.unshift({kind:'upload',command:{id:'clobber',target:{buffer:records}}})
            else records.contentEpoch++
            expect(()=>build.submit()).to.throw('stale content epoch')
            expect(build.isSubmitted).to.equal(false)
            expect(()=>f.encode(f.a,f.b)).to.throw('unobserved')
        })
        await fixture(async f=>{
            const build=f.encode(f.a,f.b),records=f.resource('Flow center distance records')
            expect(build.steps.find(step=>step.kind==='compute').command.resources.read
                .find(value=>value.resource===records).contentEpoch).to.equal('current-at-step')
            await f.cache.observe(build.submit())
        })
    })

    it('invalidates partially overwritten output after any unsuccessful or rejected native submission',async()=>{
        for(const native of [{status:'observed-failed'},{status:'unobserved'},{status:'no-native-work'}])await fixture(async f=>{
            await f.run(f.a,f.b);f.a.epoch++
            const build=f.encode(f.a,f.b)
            expect(f.cache.facts().lastReuseSelectors).to.deep.equal([0,2])
            await assert.rejects(f.cache.observe(build.submit({native:Promise.resolve(native)})),/not observed successful/)
            await f.run(f.a,f.b)
            expect(f.cache.facts().lastReuseSelectors).to.deep.equal([0,0])
        })
        await fixture(async f=>{
            const build=f.encode(f.a,f.b)
            await assert.rejects(f.cache.observe(build.submit({native:Promise.reject(new Error('native rejected'))})),/native rejected/)
            await f.run(f.a,f.b)
            expect(f.cache.facts().lastReuseSelectors).to.deep.equal([0,0])
        })
    })

    it('requires the actual producer versions for empty-plan receipts and rejects another in-flight receipt',async()=>{
        await fixture(async f=>{
            const old=await f.run(f.a,f.b)
            const empty=f.encode(f.a,f.b,{indices:[]}),current=empty.submit()
            await assert.rejects(f.cache.observe(old),/produced resource versions/)
            await f.cache.observe(current)
            const gate=deferred(),next=f.encode(f.a,f.b),work=next.submit({native:gate.promise})
            const observing=f.cache.observe(work)
            await assert.rejects(f.cache.observe(old),/another submission/)
            gate.resolve({status:'observed-succeeded'});await observing
        })
    })

    it('rejects omitted GPU builds and unsubmitted/abandoned plans without labelling them reusable',async()=>{
        await fixture(async f=>{
            const build=f.encode(f.a,f.b)
            await assert.rejects(f.cache.observe({runtime:f.runtime}),/encoded build/)
            await assert.rejects(f.cache.observe(build.submit({skipCompute:true})),/encoded build/)
            expect(()=>f.encode(f.a,f.b)).to.throw('unobserved')
        })
        await fixture(async f=>{
            f.encode(f.a,f.b)
            expect(()=>f.encode(f.a,f.b)).to.throw('unobserved')
            f.cache.dispose()
            expect(f.cache.facts()).to.include({disposed:true,pending:false})
        })
    })

    it('does not revive a disposed owner after late native success',async()=>{
        await fixture(async f=>{
            const gate=deferred(),work=f.encode(f.a,f.b).submit({native:gate.promise}),observing=f.cache.observe(work)
            f.cache.dispose();gate.resolve({status:'observed-succeeded'});await observing
            expect(f.cache.facts()).to.include({disposed:true,pending:false})
            expect(()=>f.encode(f.a,f.b)).to.throw('unobserved')
        })
    })
})

function deferred() {let resolve;const promise=new Promise(accept=>{resolve=accept});return {promise,resolve}}
async function fixture(run) {
    let serial=0
    const owned=[],buffers=[],uploads=[]
    const own=descriptor=>{
        const value={...descriptor,id:`object-${serial++}`,disposals:0,dispose(){this.disposals++}}
        owned.push(value);return value
    }
    const runtime={
        async createBuffer(descriptor){
            const value=own({...descriptor,contentEpoch:0,allocationVersion:1})
            value.region=()=>({buffer:value,size:value.size});buffers.push(value);return value
        },
        async createBindLayout(descriptor){return own({...descriptor,runtime})},
        async createBindSet(layout,bindings){return own({layout,bindings,runtime})},
        async createShaderModule(descriptor){return own(descriptor)},createProgram:own,
        async createComputePipeline(descriptor){return own(descriptor)},createComputePass:own,
        createClearBufferCommand(descriptor){return own(descriptor)},
        createUploadCommand(descriptor){const value=own(descriptor);uploads.push(value);return value},
        createDispatchCommand:own,
    }
    function endpoint(name) {
        const addressSpace=virtualRasterAddressSpace({id:`endpoint-${name}`,dimensions:2,extent:[512,256],pageSize:[256,256],levelCount:2})
        return {addressSpace,epoch:1,table:{id:`${name}-table`,allocationVersion:1},atlas:{id:`${name}-atlas`,allocationVersion:1}}
    }
    const a=endpoint('a'),b=endpoint('b'),c=endpoint('c')
    const temporal={wgsl:'',layout:await runtime.createBindLayout({group:1,entries:[]})}
    const cache=await createFlowCenterCache({runtime,temporal,addressSpace:a.addressSpace,capacity:2,activityKill:.001})
    function builder() {
        return {runtime,isSubmitted:false,steps:[],
            clear(command){this.steps.push({kind:'clear',command});return this},
            upload(command){this.steps.push({kind:'upload',command});return this},
            compute(pass,commands){for(const command of commands)this.steps.push({kind:'compute',command});return this},
            submit({native=Promise.resolve({status:'observed-succeeded'}),skipCompute=false}={}) {
                const shadow=new Map()
                const epoch=resource=>shadow.get(resource)??resource.contentEpoch
                for(const {kind,command} of this.steps) {
                    if(kind==='compute') {
                        if(skipCompute)continue
                        for(const read of command.resources.read)if(typeof read.contentEpoch==='number'&&read.contentEpoch!==epoch(read.resource)) {
                            throw new Error('stale content epoch')
                        }
                        for(const resource of command.resources.write)shadow.set(resource,epoch(resource)+1)
                    } else shadow.set(command.target.buffer,epoch(command.target.buffer)+1)
                }
                this.isSubmitted=true
                const resourceAccesses=[],executionOutcomes=[],producerEpochs=[]
                const produced=(resource,commandId)=>{
                    resource.contentEpoch++
                    producerEpochs.push({resourceId:resource.id,contentEpoch:resource.contentEpoch,allocationVersion:resource.allocationVersion,producedBy:{commandId}})
                }
                for(const {kind,command} of this.steps) {
                    if(kind==='compute') {
                        if(skipCompute)continue
                        executionOutcomes.push({outcomeKind:'command',status:'executed',executedCommandId:command.id})
                        for(const resource of command.resources.write)produced(resource,command.id)
                    } else {
                        if(kind==='upload')resourceAccesses.push({stepKind:'upload',commandId:command.id})
                        produced(command.target.buffer,command.id)
                    }
                }
                return {runtime,id:`submitted-${serial++}`,resourceAccesses,executionOutcomes,producerEpochs,done:Promise.resolve(),nativeOutcome:native}
            },
        }
    }
    const api={a,b,c,cache,runtime,
        resource:label=>buffers.find(value=>value.label===label),upload:label=>uploads.find(value=>value.label===label),
        flags:()=>uploads.find(value=>value.label==='Upload Flow center jobs').data[3],
        encode(lower,upper,{level=0,indices=[0,1]}={}) {
            const work=builder(),available=lower.addressSpace.pages().filter(page=>page.level===level)
            const prepared={state:'ready',requestedLevel:level,bindSet:{runtime,layout:temporal.layout},
                temporal:{lower:{runtime:lower},upper:{runtime:upper}},resources:[lower.table,lower.atlas,upper.table,upper.atlas]}
            const input={pages:indices.map(index=>available[index]),lowerSnapshot:{addressSpace:lower.addressSpace,epoch:lower.epoch},upperSnapshot:{addressSpace:upper.addressSpace,epoch:upper.epoch}}
            cache.encode(work,prepared,input);return work
        },
        async run(lower,upper,options){const work=api.encode(lower,upper,options).submit();await cache.observe(work);return work},
    }
    try {await run(api)} finally {
        cache.dispose();cache.dispose();temporal.layout.dispose()
        for(const resource of owned)expect(resource.disposals,resource.label??resource.id).to.equal(1)
    }
}
