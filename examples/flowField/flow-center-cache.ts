import type { VirtualRasterAddressSpace, VirtualRasterPageIdentity, VirtualRasterSnapshot } from 'geoscratch/geo'
import type { BindLayout, BindSet, BufferResource, DispatchCommand, GPURuntime, SubmissionBuilder, SubmittedWork } from 'geoscratch/scratch'
import type { FlowTemporalReadyBindingFrame } from './flow-temporal-bindings.ts'
import { FLOW_CENTER_CACHE_EDGE, flowCenterCachePlan } from './flow-center-cache-plan.ts'
import buildShader from './shaders/center-cache-build.wgsl?raw'
import sampleShader from './shaders/center-cache-sample.wgsl?raw'

export type FlowCenterCacheInput = Readonly<{
    pages: readonly VirtualRasterPageIdentity[]
    lowerSnapshot: VirtualRasterSnapshot
    upperSnapshot: VirtualRasterSnapshot
}>

export type FlowCenterCacheFacts = Readonly<{
    capacity: number
    bufferBytes: number
    pageCount: number
    buildCount: number
    reuseCount: number
    /** Endpoint lanes rebuilt/copied by encoded build batches, not whole-key cache hits. */
    rebuiltEndpointCount: number
    reusedEndpointCount: number
    /** Each lane is 0=fresh, 1=previous lower, 2=previous upper. */
    lastReuseSelectors: readonly [number, number]
    pending: boolean
    disposed: boolean
}>

export type FlowCenterCache = Readonly<{
    wgsl: string
    layout: BindLayout
    bindSet: BindSet
    resources: readonly BufferResource[]
    encode(builder: SubmissionBuilder, prepared: FlowTemporalReadyBindingFrame, input?: FlowCenterCacheInput): void
    observe(submitted: SubmittedWork): Promise<void>
    facts(): FlowCenterCacheFacts
    dispose(): void
}>

/** Owns a bounded, GPU-derived pair cache; source pages and snapshots remain borrowed. */
export async function createFlowCenterCache(options: Readonly<{
    runtime: GPURuntime
    temporal: Readonly<{ wgsl: string, layout: BindLayout }>
    addressSpace: VirtualRasterAddressSpace
    capacity: number
    activityKill: number
}>): Promise<FlowCenterCache> {
    const { runtime, temporal, addressSpace, capacity } = options
    const initialPlan = flowCenterCachePlan(addressSpace, capacity, [], 0)
    if (!Number.isFinite(options.activityKill) || options.activityKill < 0 ||
        temporal.layout.runtime !== runtime || temporal.layout.group !== 1) {
        throw new TypeError('Flow center cache requires finite support and same-runtime temporal bindings')
    }
    const kill = Math.fround(options.activityKill)
    const owned: { dispose(): void }[] = []
    const own = <T extends { dispose(): void }>(value: T): T => (owned.push(value), value)
    let command: DispatchCommand | undefined
    try {
        const configBytes = new Uint8Array(16)
        const jobsBytes = initialPlan.jobs
        const lookupBytes = initialPlan.lookup
        const config = own(await runtime.createBuffer({label:'Flow center cache config',size:16,usage:0x40|0x08}))
        const jobs = own(await runtime.createBuffer({label:'Flow center cache jobs',size:jobsBytes.byteLength,usage:0x80|0x08}))
        const lookup = own(await runtime.createBuffer({label:'Flow center cache lookup',size:lookupBytes.byteLength,usage:0x80|0x08}))
        const records = own(await runtime.createBuffer({label:'Flow center distance records',
            size:capacity * FLOW_CENTER_CACHE_EDGE ** 2 * 4,usage:0x80|0x08}))
        const initialize = own(runtime.createClearBufferCommand({label:'Initialize Flow center records',target:records.region()}))
        const configUpload = own(runtime.createUploadCommand({label:'Upload Flow center config',target:config.region(),data:configBytes}))
        const jobsUpload = own(runtime.createUploadCommand({label:'Upload Flow center jobs',target:jobs.region(),data:jobsBytes}))
        const lookupUpload = own(runtime.createUploadCommand({label:'Upload Flow center lookup',target:lookup.region(),data:lookupBytes}))
        const configLayout = own(await runtime.createBindLayout({group:0,entries:[
            {binding:0,name:'flowCenterCacheBuildConfig',type:'uniform',visibility:['compute'],minBindingSize:16},
        ]}))
        const configSet = own(await runtime.createBindSet(configLayout,{flowCenterCacheBuildConfig:config.region()}))
        const outputLayout = own(await runtime.createBindLayout({group:2,entries:[
            {binding:0,name:'flowCenterCacheJobs',type:'read-storage',visibility:['compute']},
            {binding:1,name:'flowCenterCacheOutput',type:'storage',visibility:['compute']},
        ]}))
        const outputSet = own(await runtime.createBindSet(outputLayout,{
            flowCenterCacheJobs:jobs.region(),flowCenterCacheOutput:records.region(),
        }))
        const layout = own(await runtime.createBindLayout({group:3,entries:[
            {binding:0,name:'flowCenterCacheConfig',type:'uniform',visibility:['fragment'],minBindingSize:16},
            {binding:1,name:'flowCenterCacheLookup',type:'read-storage',visibility:['fragment']},
            {binding:2,name:'flowCenterCacheRecords',type:'read-storage',visibility:['fragment']},
        ]}))
        const bindSet = own(await runtime.createBindSet(layout,{
            flowCenterCacheConfig:config.region(),flowCenterCacheLookup:lookup.region(),flowCenterCacheRecords:records.region(),
        }))
        const module = own(await runtime.createShaderModule({label:'Flow center cache builder',
            sourceParts:[{code:temporal.wgsl},{code:buildShader}]}))
        const program = own(runtime.createProgram({label:'Flow center cache build program',compute:{module,entryPoint:'FlowCenterCache_build'}}))
        const pipeline = own(await runtime.createComputePipeline({label:'Flow center cache build pipeline',program,
            layout:{mode:'explicit',bindLayouts:[configLayout,temporal.layout,outputLayout]}}))
        const pass = own(runtime.createComputePass({label:'Build Flow center distances'}))
        const resources = Object.freeze([config,lookup,records])
        type Endpoint = { runtime: object, snapshotEpoch: number | undefined, allocations: string }
        type Context = { planKey: string, lower: Endpoint, upper: Endpoint }
        type Version = { resource: BufferResource, contentEpoch: number, allocationVersion: number }
        let committed: { context: Context, versions: readonly Version[] } | undefined
        let pending: { context: Context, commandId?: string, initializationId?: string, builder: SubmissionBuilder,
            observing?: Promise<void>, submittedId?: string } | undefined
        let disposed = false, initialized = false, pageCount = 0, buildCount = 0, reuseCount = 0
        let rebuiltEndpointCount = 0, reusedEndpointCount = 0
        let lastReuseSelectors: readonly [number, number] = Object.freeze([0,0] as const)

        function versionsMatch(versions: readonly Version[]) {
            return versions.every(value => value.resource.contentEpoch === value.contentEpoch &&
                value.resource.allocationVersion === value.allocationVersion)
        }

        function version(resource: BufferResource): Version {
            return {resource,contentEpoch:resource.contentEpoch,allocationVersion:resource.allocationVersion}
        }

        function sameEndpoint(left: Endpoint, right: Endpoint) {
            return left.runtime === right.runtime && left.snapshotEpoch === right.snapshotEpoch &&
                left.allocations === right.allocations
        }

        function encode(builder: SubmissionBuilder, prepared: FlowTemporalReadyBindingFrame, input?: FlowCenterCacheInput) {
            if (disposed || pending !== undefined || builder.runtime !== runtime || builder.isSubmitted || prepared.bindSet.runtime !== runtime) {
                throw new Error('Flow center cache requires one live, unobserved owning frame')
            }
            const lower = prepared.temporal.lower.runtime, upper = prepared.temporal.upper.runtime
            if (input && (input.lowerSnapshot.addressSpace !== lower.addressSpace || input.upperSnapshot.addressSpace !== upper.addressSpace)) {
                throw new TypeError('Flow center cache snapshots must belong to the exact captured runtimes')
            }
            const plan = flowCenterCachePlan(lower.addressSpace,capacity,input?.pages ?? [],prepared.requestedLevel)
            if (plan.lookup.length !== lookupBytes.length) throw new Error('Flow center cache source coverage changed')
            const allocations = (offset: number) => prepared.resources.slice(offset,offset+2)
                .map(resource => `${resource.id}@${resource.allocationVersion}`).join(',')
            const context: Context = {planKey:plan.key,
                lower:{runtime:lower,snapshotEpoch:input?.lowerSnapshot.epoch,allocations:allocations(0)},
                upper:{runtime:upper,snapshotEpoch:input?.upperSnapshot.epoch,allocations:allocations(2)}}
            const confirmed = committed !== undefined && versionsMatch(committed.versions) ? committed : undefined
            const previous = confirmed?.context
            const samePlan = previous?.planKey === context.planKey
            if (samePlan && sameEndpoint(previous!.lower,context.lower) && sameEndpoint(previous!.upper,context.upper)) {
                reuseCount++
                return
            }
            const reuseLane = (endpoint: Endpoint, preferred: 0 | 1): number => {
                if (!samePlan || endpoint.snapshotEpoch === undefined) return 0
                const old = [previous!.lower,previous!.upper]
                if (sameEndpoint(old[preferred]!,endpoint)) return preferred+1
                const other = 1-preferred
                return sameEndpoint(old[other]!,endpoint) ? other+1 : 0
            }
            const selectors: readonly [number,number] = Object.freeze([
                reuseLane(context.lower,0),reuseLane(context.upper,1),
            ] as const)
            const copiedRecordEpoch = selectors.some(value=>value!==0)
                ? confirmed!.versions.find(value=>value.resource===records)!.contentEpoch : undefined
            // Failed or abandoned builds can never leave a reusable CPU label.
            committed = undefined
            pageCount = plan.pageCount
            const view = new DataView(configBytes.buffer)
            view.setUint32(0,prepared.requestedLevel,true)
            view.setUint32(4,pageCount,true)
            view.setUint32(8,lookupBytes.length,true)
            view.setFloat32(12,kill,true)
            jobsBytes.set(plan.jobs)
            const reuseFlags = selectors[0] | (selectors[1] << 2)
            for (let slot=0;slot<pageCount;slot++) jobsBytes[slot*4+3] = reuseFlags
            lookupBytes.set(plan.lookup)
            try {
                const initializationId = initialized ? undefined : initialize.id
                if (!initialized) { builder.clear(initialize); initialized=true }
                builder.upload(configUpload).upload(lookupUpload)
                command?.dispose()
                command = undefined
                if (pageCount > 0) {
                    builder.upload(jobsUpload)
                    command = runtime.createDispatchCommand({label:'Build source-center distance cache',pipeline,
                        bindSets:[{set:configSet},{set:prepared.bindSet},{set:outputSet}],
                        count:{workgroups:[33,33,pageCount]},
                        resources:{read:[config,jobs,records,...new Set(prepared.resources)].map(resource=>({resource,
                            // A copied byte depends on this exact previous producer,
                            // including writes inserted between encode and submit.
                            contentEpoch:resource===records && copiedRecordEpoch!==undefined ? copiedRecordEpoch : 'current-at-step' as const})),
                            write:[records]},whenMissing:'throw'})
                    builder.compute(pass,[command])
                    buildCount++
                    rebuiltEndpointCount += selectors.filter(value=>value===0).length
                    reusedEndpointCount += selectors.filter(value=>value!==0).length
                }
                lastReuseSelectors = selectors
                pending = {context,commandId:command?.id,initializationId,builder}
            } catch(error) {
                initialized=false
                throw error
            }
        }

        function observe(submitted: SubmittedWork): Promise<void> {
            const active = pending
            if (!active) return Promise.resolve()
            if (active.observing) return active.submittedId===submitted?.id ? active.observing
                : Promise.reject(new Error('Flow center cache build was observed with another submission'))
            if (submitted?.runtime !== runtime || !active.builder.isSubmitted) {
                return Promise.reject(new Error('Flow center cache observation requires its encoded build'))
            }
            const submittedUploads = new Set(submitted.resourceAccesses.filter(access=>access.stepKind==='upload').map(access=>access.commandId))
            if (active.commandId &&
                !submitted.executionOutcomes.some(outcome=>outcome.outcomeKind==='command' && outcome.status==='executed' && outcome.executedCommandId===active.commandId) ||
                !submittedUploads.has(configUpload.id) || !submittedUploads.has(lookupUpload.id) ||
                active.commandId && !submittedUploads.has(jobsUpload.id)) {
                return Promise.reject(new Error('Flow center cache observation requires its encoded build'))
            }
            const versions = resources.map(version)
            const expected = [[config,configUpload.id],[lookup,lookupUpload.id],
                ...(active.commandId ? [[jobs,jobsUpload.id],[records,active.commandId]] :
                    active.initializationId ? [[records,active.initializationId]] : [])] as [BufferResource,string][]
            const produced = expected.map(([resource,commandId]) => ({...version(resource),commandId}))
            if (produced.some(value=>!submitted.producerEpochs.some(epoch=>epoch.resourceId===value.resource.id &&
                epoch.contentEpoch===value.contentEpoch && epoch.allocationVersion===value.allocationVersion &&
                epoch.producedBy.commandId===value.commandId))) {
                return Promise.reject(new Error('Flow center cache observation lost its produced resource versions'))
            }
            active.submittedId=submitted.id
            active.observing = Promise.all([submitted.done,submitted.nativeOutcome]).then(([,outcome])=>{
                if (outcome.status !== 'observed-succeeded') throw new Error('Flow center cache build was not observed successful')
                if (disposed) return
                if (!versionsMatch(versions) || !versionsMatch(produced)) {
                    throw new Error('Flow center cache resources changed before build observation')
                }
                committed = {context:active.context,versions}
            }).catch(error=>{
                committed=undefined
                initialized=false
                throw error
            }).finally(()=>{if(pending===active)pending=undefined})
            return active.observing
        }

        function facts(): FlowCenterCacheFacts {
            return Object.freeze({capacity,bufferBytes:records.size+jobsBytes.byteLength+lookupBytes.byteLength+16,
                pageCount,buildCount,reuseCount,rebuiltEndpointCount,reusedEndpointCount,lastReuseSelectors,
                pending:pending!==undefined,disposed})
        }
        function dispose() {
            if (disposed) return
            disposed=true
            committed=undefined
            pending=undefined
            command?.dispose()
            for(const value of owned.reverse())value.dispose()
        }
        return Object.freeze({wgsl:sampleShader,layout,bindSet,resources,encode,observe,facts,dispose})
    } catch(error) {
        command?.dispose()
        for(const value of owned.reverse())value.dispose()
        throw error
    }
}
