import { expect } from 'chai'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { WebMercatorQuad, WebMercatorQuadAddressCodec, tileMatrixCoverage, virtualRasterAddressSpace } from 'geoscratch/geo'

const moduleUrl = pathToFileURL(path.join(
    process.cwd(),
    'examples',
    'flowField',
    'flow-particle-policy.ts'
)).href
const particlesModuleUrl = pathToFileURL(path.join(
    process.cwd(),
    'examples',
    'flowField',
    'flow-particles.ts'
)).href
const read = (...parts) => fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8')

describe('Flow Field particle lifecycle policy', () => {

    it('derives finite hysteresis thresholds from the velocity field maximum', async() => {

        const { flowActivityThresholds } = await import(moduleUrl)
        expect(flowActivityThresholds({ maximumSpeed: 4 })).to.deep.equal({
            spawn: 0.004,
            kill: 0.002,
            spawnRatio: 0.001,
            killRatio: 0.0005,
        })
        expect(() => flowActivityThresholds({ maximumSpeed: 0 }))
            .to.throw('maximumSpeed must be positive and finite')
        expect(() => flowActivityThresholds({
            maximumSpeed: 4,
            spawnRatio: 0.0001,
            killRatio: 0.0005,
        })).to.throw('spawnRatio must be greater than killRatio')
    })

    it('retires unavailable, unsupported, expired, and stagnant particles', async() => {

        const { classifyFlowParticle } = await import(`${moduleUrl}?classify=1`)
        const base = {
            available: true,
            speed: 0.5,
            ageSteps: 10,
            stagnantSteps: 2,
            activityKill: 0.1,
            maximumAgeSteps: 100,
            maximumStagnantSteps: 20,
        }
        expect(classifyFlowParticle(base)).to.equal('alive')
        expect(classifyFlowParticle({ ...base, available: false })).to.equal('retire')
        expect(classifyFlowParticle({ ...base, speed: 0.099 })).to.equal('retire')
        expect(classifyFlowParticle({ ...base, speed: 0, activityKill: 0 })).to.equal('retire')
        expect(classifyFlowParticle({ ...base, ageSteps: 100 })).to.equal('retire')
        expect(classifyFlowParticle({ ...base, stagnantSteps: 20 })).to.equal('retire')
    })

    it('normalizes stagnant duration and retirement hazard to 60 Hz reference time', async() => {
        const { nextStagnantSteps, flowParticleDropProbability } = await import(moduleUrl)
        for (const hz of [30,60,120]) {
            let stagnant = 0, surviving = 1
            const referenceSteps = 60 / hz
            for (let index = 0; index < hz; index++) {
                const elapsedSteps = Math.floor((index + 1) * referenceSteps) - Math.floor(index * referenceSteps)
                stagnant = nextStagnantSteps({previous:stagnant,displacementMeters:.1 * referenceSteps,
                    minimumDisplacementMeters:.25,referenceSteps,elapsedSteps})
                surviving *= 1 - flowParticleDropProbability(.004,referenceSteps)
                expect(nextStagnantSteps({previous:10,displacementMeters:.3 * referenceSteps,
                    minimumDisplacementMeters:.25,referenceSteps,elapsedSteps})).to.equal(0)
            }
            expect(stagnant).to.equal(60)
            expect(surviving).to.be.closeTo(Math.pow(.996,60),1e-12)
        }
        expect(flowParticleDropProbability(.00325,1)).to.equal(.00325)
        expect(flowParticleDropProbability(0,.5)).to.equal(0)
        expect(flowParticleDropProbability(1,2)).to.equal(1)
        for (const referenceSteps of [null,0,-1,4,Infinity,NaN,'1']) {
            expect(() => flowParticleDropProbability(.004,referenceSteps)).to.throw(RangeError)
            expect(() => nextStagnantSteps({previous:1,displacementMeters:0,
                minimumDisplacementMeters:.25,referenceSteps})).to.throw(TypeError)
        }
        for (const elapsedSteps of [null,-1,.5,4,Infinity,NaN,'1']) {
            expect(() => nextStagnantSteps({previous:1,displacementMeters:0,
                minimumDisplacementMeters:.25,elapsedSteps})).to.throw(TypeError)
        }
    })

    it('uses displacement hysteresis without creating an immortal near-zero state', async() => {

        const { nextStagnantSteps } = await import(`${moduleUrl}?stagnant=1`)
        expect(nextStagnantSteps({
            previous: 4,
            displacementMeters: 0.001,
            minimumDisplacementMeters: 0.01,
        })).to.equal(5)
        expect(nextStagnantSteps({
            previous: 4,
            displacementMeters: 0.02,
            minimumDisplacementMeters: 0.01,
        })).to.equal(0)
        expect(nextStagnantSteps({
            previous: Number.MAX_SAFE_INTEGER,
            displacementMeters: 0,
            minimumDisplacementMeters: 0.01,
        })).to.equal(Number.MAX_SAFE_INTEGER)
    })

    it('rebirths without connecting the retired and replacement positions', async() => {

        const { rebirthFlowParticle, dormantFlowParticle } = await import(`${moduleUrl}?rebirth=1`)
        const position = Object.freeze([ 11, 22, 33, 44 ])
        const reborn = rebirthFlowParticle(position, 123)
        expect(reborn).to.deep.equal({
            current: position,
            previous: position,
            velocity: [ 0, 0 ],
            ageSteps: 0,
            stagnantSteps: 0,
            randomState: 123,
            state: 'active',
        })
        expect(reborn.current).to.equal(reborn.previous)
        expect(Object.isFrozen(reborn)).to.equal(true)
        expect(dormantFlowParticle(456)).to.deep.equal({
            current: [ 0, 0, 0, 0 ],
            previous: [ 0, 0, 0, 0 ],
            velocity: [ 0, 0 ],
            ageSteps: 0,
            stagnantSteps: 0,
            randomState: 456,
            state: 'dormant',
        })
    })

    it('locks one 56-byte canonical particle ABI and absorbing GPU lifecycle', () => {

        const source = read('examples', 'flowField', 'flow-particles.ts')
        const simulation = read(
            'examples',
            'flowField',
            'shaders',
            'particle-simulation.compute.wgsl'
        )
        const render = read('examples', 'flowField', 'shaders', 'particles.wgsl')

        expect(source).to.include('FLOW_PARTICLE_RECORD_BYTES = 56')
        expect(source).to.include('FLOW_PARTICLE_MAXIMUM_COUNT = 262_144')
        expect(simulation).to.include('struct FlowParticle {')
        expect(simulation).to.include('current: FlowVelocityAddressFixedPosition')
        expect(simulation).to.include('previous: FlowVelocityAddressFixedPosition')
        expect(simulation).to.include('velocity: vec2f')
        expect(simulation).to.include('age_steps: u32')
        expect(simulation).to.include('stagnant_steps: u32')
        expect(simulation).to.include('random_state: u32')
        expect(simulation).to.include('lifecycle_state: u32')
        expect(simulation).to.include('FlowScreen_advance_meters')
        expect(simulation.match(/FlowParticles_sample\(/g).length).to.be.greaterThan(2)
        expect(simulation).to.include('FlowVelocity_sample_centers(position, level, temporal)')
        expect(simulation).to.include('flowParticleConfig.legacy_displacement_scale')
        expect(simulation).to.include('f32(steps)')
        expect(simulation).to.include('FlowParticles_predicted_substeps(')
        expect(simulation).to.include('flowParticleConfig.visual_time.z')
        expect(simulation).to.include('(*particle).current = selection.position;')
        expect(simulation).to.include('(*particle).previous = selection.position;')
        expect(simulation).to.include(
            '(*particle).lifecycle_state = FLOW_PARTICLE_DORMANT;'
        )
        expect(render).to.include('previous: FlowVelocityAddressFixedPosition')
        expect(render).to.include('current: FlowVelocityAddressFixedPosition')
        expect(source).to.not.match(
            /ReadbackCommand|createReadbackCommand|getMappedRange|mapAsync|\.readback\(/
        )
        expect(source).to.not.match(/new\s+(?:Float32Array|Uint32Array)\s*\(\s*maximumCount/)
        expect(source).to.not.match(/runtime\.(?:device|queue)/)
    })

    it('assembles bounded Scratch commands with injected temporal and spawn bindings', async() => {

        const { createFlowParticles } = await import(`${particlesModuleUrl}?gpu=1`)
        const events = []
        const runtime = fakeRuntime(events)
        const temporalLayout = Object.freeze({ group: 1 })
        const spawnLayout = Object.freeze({ group: 2 })
        const temporalResource = fakeResource('temporal')
        const spawnResource = fakeResource('spawn')
        const temporalSet = Object.freeze({ layout: temporalLayout })
        const spawnSet = Object.freeze({ layout: spawnLayout })
        const coverage = tileMatrixCoverage({tileMatrixSet:WebMercatorQuad,limits:[2,5,9].map(matrixId => ({
            matrixId:String(matrixId),minTileCol:0,maxTileCol:0,minTileRow:0,maxTileRow:0,
        }))})
        const addressSpace = virtualRasterAddressSpace({id:'particle-source-cell',coverage})
        const particles = await createFlowParticles({
            runtime,
            maximumCount: 1024,
            addressCodec: new WebMercatorQuadAddressCodec({coordinateBits:52,coverage}),
            maximumSpeed: 4,
            simulationShader: read(
                'examples',
                'flowField',
                'shaders',
                'particle-simulation.compute.wgsl'
            ),
            temporal: {
                wgsl: '// temporal sampler',
                layout: temporalLayout,
            },
            spawn: {
                wgsl: '// spawn index',
                layout: spawnLayout,
                capacity: 1024,
            },
            activitySpawn: 0.2,
            activityKill: 0.1,
            timeStep: 0.5,
            substeps: 2,
            maximumAgeSteps: 100,
            maximumStagnantSteps: 20,
            minimumDisplacementMeters: 0.01,
        })
        const spawn = {
            bindSet: spawnSet,
            resources: [ spawnResource ],
            refill: {
                resources: [ fakeResource('refill-count'), fakeResource('refill-indices') ],
                clear: { kind: 'refill-clear' },
                initializeIndices: { kind: 'refill-initialize-indices' },
            },
        }
        const previousView = particleView()
        const builder = fakeBuilder(events)
        const temporalFrame = Object.freeze({
            state: 'ready',
            temporal:{lower:{runtime:{addressSpace}}},
            requestedRevision: 7,
            pairGeneration: 3,
            bindSet: temporalSet,
            resources: Object.freeze([ temporalResource ]),
            progress: 0.25,
            requestedLevel: 2,
            sampleRegistration: 'pixel-center',
            release() {},
        })

        // Initialization already repopulates every slot; a queued view refill
        // must be consumed without replacing an extra quarter on the next tick.
        particles.refillView(previousView)
        particles.refillView(previousView)
        particles.encode(builder, spawn, temporalFrame)

        expect(particles.maximumCount).to.equal(1024)
        expect(particles.resources.particles.size).to.equal(1024 * 56)
        expect(particles.facts()).to.deep.include({
            recordBytes: 56,
            encodedSteps: 1,
            active: null,
            dormant: null,
            retired: null,
            countersObservation: 'gpu-only-unobserved',
            cpuMirrorBytes: 0,
            readbackCount: 0,
            lastSpawnCount: null,
            lastSpawnDormant: null,
        })
        expect(events.filter(event => event === 'builder:compute')).to.have.length(1)
        expect(builder.dispatches).to.deep.equal(['Simulate Flow Field canonical particles'])
        expect(events).to.include('builder:clear')
        expect(events).to.include('builder:upload')
        expect(runtime.lastDispatch.count.workgroups).to.deep.equal([ 4, 1, 1 ])
        expect(runtime.lastDispatch.bindSets.map(binding => binding.set)).to.deep.equal([
            runtime.ownedBindSet,
            temporalSet,
            spawnSet,
        ])
        expect(runtime.readbackCount).to.equal(0)
        const config = new DataView(runtime.configUpload.data.buffer)
        expect(config.byteLength).to.equal(272)
        expect(config.getFloat32(48, true)).to.equal(4)
        expect(config.getUint32(52, true)).to.equal(0)
        expect(config.getUint32(56, true)).to.equal(0)
        expect(config.getUint32(60, true)).to.equal(0)
        expect(config.getFloat32(160, true)).to.equal(1)
        expect(config.getFloat32(164, true)).to.equal(1)
        expect(config.getFloat32(168, true)).to.equal(Math.fround(WebMercatorQuad.matrix('2').cellSize))
        expect(particles.facts().simulatedReferenceSteps).to.equal(1)
        expect(particles.facts().viewRefillCount).to.equal(0)
        expect(read('examples', 'flowField', 'flow-particles.ts'))
            .to.not.include('options.temporal.frame()')

        const initialClears = events.filter(event => event === 'builder:clear').length
        particles.encode(builder, spawn, temporalFrame)
        expect(events.filter(event => event === 'builder:clear')).to.have.length(initialClears + 1)
        const beforeReset = events.length
        particles.reset()
        particles.reset()
        expect(events).to.have.length(beforeReset)
        expect(particles.facts()).to.include({ resetPending: true, resetCount: 2 })
        particles.encode(builder, spawn, temporalFrame)
        expect(events.filter(event => event === 'builder:clear')).to.have.length(initialClears + 5)
        expect(particles.facts()).to.include({ resetPending: false, encodedSteps: 3 })

        const beforeRefill = events.length
        const beforeRefillClears = events.filter(event => event === 'builder:clear').length
        const beforeRefillDispatches = builder.dispatches.length
        particles.refillView(previousView)
        particles.refillView({ ...previousView, clipFromRelativeWorld: [
            2, ...previousView.clipFromRelativeWorld.slice(1),
        ] })
        expect(events).to.have.length(beforeRefill)
        expect(particles.facts().viewRefillCount).to.equal(0)
        particles.encode(builder, spawn, temporalFrame)
        expect(config.getUint32(56, true)).to.equal(1)
        expect(config.getUint32(60, true)).to.equal(0)
        expect(config.getFloat32(176, true)).to.equal(1)
        expect(particles.facts()).to.include({ encodedSteps: 4, viewRefillCount: 1 })
        // Refill clears lifecycle + revealed-index counters, never particle state.
        expect(events.filter(event => event === 'builder:clear'))
            .to.have.length(beforeRefillClears + 2)
        expect(builder.dispatches.slice(beforeRefillDispatches)).to.deep.equal([
            'Index newly visible Flow Field support', 'Simulate Flow Field revealed particles',
        ])
        expect(builder.clears.at(-1)).to.equal(spawn.refill.clear)
        expect(builder.clears.slice(-2)).to.not.include(particles.commands.initializeParticles)
        particles.encode(builder, spawn, temporalFrame)
        expect(config.getUint32(56, true)).to.equal(0)
        expect(particles.facts()).to.include({ encodedSteps: 5, viewRefillCount: 1 })
        expect(builder.dispatches.length).to.equal(beforeRefillDispatches + 3)
        expect(builder.dispatches.at(-1)).to.equal('Simulate Flow Field canonical particles')

        // A full reset supersedes a view refill regardless of enqueue order.
        for (const refillFirst of [ true, false ]) {
            const clears = events.filter(event => event === 'builder:clear').length
            if (refillFirst) particles.refillView(previousView)
            particles.reset()
            if (!refillFirst) particles.refillView(previousView)
            particles.encode(builder, spawn, temporalFrame)
            expect(config.getUint32(56, true)).to.equal(0)
            expect(particles.facts().viewRefillCount).to.equal(1)
            expect(events.filter(event => event === 'builder:clear')).to.have.length(clears + 4)
            particles.encode(builder, spawn, temporalFrame)
            expect(config.getUint32(56, true)).to.equal(0)
            expect(particles.facts().viewRefillCount).to.equal(1)
        }

        const referenceBeforeTiming = particles.facts().simulatedReferenceSteps
        for (const [referenceSteps,elapsedSteps] of [[.5,0],[.5,1],[1,1],[2,2],[3,3]]) {
            particles.encode(builder,spawn,temporalFrame,undefined,true,referenceSteps,elapsedSteps)
            expect(config.getFloat32(36,true)).to.equal(.5 * referenceSteps)
            expect(config.getUint32(8,true)).to.equal(2)
            expect(config.getUint32(60,true)).to.equal(1)
            expect(config.getFloat32(160,true)).to.equal(referenceSteps)
            expect(config.getFloat32(164,true)).to.equal(elapsedSteps)
            expect(config.getFloat32(168,true)).to.equal(Math.fround(WebMercatorQuad.matrix('2').cellSize))
        }
        expect(particles.facts().simulatedReferenceSteps).to.equal(referenceBeforeTiming + 7)
        const encoded = particles.facts().encodedSteps
        const bytesBeforeInvalid = [...new Uint8Array(config.buffer)]
        for (const referenceSteps of [0,-1,3.1,Infinity,NaN,null,'1']) {
            expect(() => particles.encode(builder,spawn,temporalFrame,undefined,false,referenceSteps,1)).to.throw(RangeError)
        }
        for (const elapsedSteps of [-1,.5,4,Infinity,NaN,null,'1']) {
            expect(() => particles.encode(builder,spawn,temporalFrame,undefined,false,1,elapsedSteps)).to.throw(RangeError)
        }
        expect(particles.facts().encodedSteps).to.equal(encoded)
        expect([...new Uint8Array(config.buffer)]).to.deep.equal(bytesBeforeInvalid)
        particles.encode(builder,spawn,temporalFrame)
        expect(config.getFloat32(36,true)).to.equal(.5)
        expect(config.getUint32(60,true)).to.equal(0)
        expect(config.getFloat32(160,true)).to.equal(1)
        expect(config.getFloat32(164,true)).to.equal(1)
        for (const [requestedLevel,matrixId] of [[0,'9'],[1,'5'],[2,'2']]) {
            particles.encode(builder,spawn,{...temporalFrame,requestedLevel},undefined,true,2,2)
            expect(config.getFloat32(168,true)).to.equal(Math.fround(WebMercatorQuad.matrix(matrixId).cellSize))
            expect(config.getUint32(8,true)).to.equal(2,'Base substeps are not ceil(reference time)')
        }
        const beforeInvalidLevel = [...new Uint8Array(config.buffer)]
        expect(() => particles.encode(builder,spawn,{...temporalFrame,requestedLevel:3})).to.throw()
        expect([...new Uint8Array(config.buffer)]).to.deep.equal(beforeInvalidLevel)

        particles.dispose()
        particles.dispose()
        expect(particles.facts().disposed).to.equal(true)
        expect(() => particles.reset()).to.throw('disposed')
        expect(() => particles.refillView(previousView)).to.throw('disposed')
    })

    it('adapts public FlowSpawnIndex counter/output resources without CPU observation', async() => {

        const { prepareFlowParticleSpawnBindings } =
            await import(`${particlesModuleUrl}?spawn-bindings=1`)
        const runtime = fakeRuntime([])
        const counter = fakeResource('spawn-counter')
        const output = fakeResource('spawn-output')
        counter.region = () => ({ buffer: counter, size: 4 })
        output.region = () => ({ buffer: output, size: 32 * 64 })
        const prepared = await prepareFlowParticleSpawnBindings(runtime, {
            capacity: 64,
            resources: {
                counter: counter.region(),
                output: output.region(),
            },
            facts: () => ({ disposed: false, cpuReadback: false }),
        })

        expect(prepared.module.layout.group).to.equal(2)
        expect(prepared.module.layout.entries[0].type).to.equal('read-storage')
        expect(prepared.module.capacity).to.equal(64)
        expect(prepared.bindings.resources).to.deep.equal([
            counter, output, ...prepared.bindings.refill.resources,
        ])
        expect(prepared.bindings.refill.resources.map(resource => resource.size)).to.deep.equal([8, 256])
        expect(prepared.module.layout.entries.slice(2).map(entry => entry.type))
            .to.deep.equal(['storage', 'storage'])
        expect(prepared.bindings.refill.clear.descriptor.target.buffer)
            .to.equal(prepared.bindings.refill.resources[0])
        expect(prepared.bindings.refill.initializeIndices.descriptor.target.buffer)
            .to.equal(prepared.bindings.refill.resources[1])
        expect(prepared.module.wgsl).to.include('fn FlowSpawnIndex_select(')
        expect(prepared.module.wgsl).to.include('flowParticleSpawnCount.value')
        expect(prepared.module.wgsl).to.include('var<storage, read> flowParticleSpawnCount')
        expect(prepared.module.wgsl).to.not.include('atomicLoad(&flowParticleSpawnCount.value)')
        expect(prepared.module.wgsl).to.include('texel_step_quanta: u32')
        expect(prepared.module.wgsl).to.include('requested_level: u32')
        expect(prepared.module.wgsl).to.include('random_x % subcell_step')
        expect(prepared.module.wgsl).to.include('countOneBits(occupancy)')
        expect(prepared.module.wgsl).to.include('firstTrailingBit(occupancy)')
        expect(prepared.module.wgsl).to.include('random_y % subcell_step')
        expect(prepared.module.wgsl).to.include('FlowVelocityAddress_advance_i32')
        expect(prepared.module.wgsl).to.include('fn FlowSpawnIndex_candidate_count(')
        expect(prepared.module.wgsl).to.include('fn FlowSpawnIndex_candidate_center(')
        expect(prepared.module.wgsl).to.include('fn FlowSpawnIndex_record_visible(')
        expect(prepared.module.wgsl).to.include('fn FlowSpawnIndex_refill_quota(')
        expect(prepared.module.wgsl).to.include('fn FlowSpawnIndex_select_refill(')
        expect(prepared.module.wgsl).to.not.include('* 50.0f')
        expect(read(
            'examples', 'flowField', 'shaders', 'particle-simulation.compute.wgsl'
        )).to.include('selection.requested_level')
        expect(prepared.module.wgsl).to.not.match(/readback|cpu/i)
        prepared.dispose()
        prepared.dispose()
    })
})

function fakeResource(id) {

    return {
        id,
        contentEpoch: 0,
        size: 16,
        region: () => ({ buffer: undefined, size: 16 }),
        dispose() {},
    }
}

function fakeRuntime(events) {

    const runtime = {
        readbackCount: 0,
        lastDispatch: undefined,
        ownedBindSet: undefined,
        async createBuffer(descriptor) {

            const resource = fakeResource(descriptor.label)
            resource.size = descriptor.size
            resource.region = () => ({ buffer: resource, size: descriptor.size })
            return resource
        },
        async createBindLayout(descriptor) {

            return { ...descriptor, dispose() {} }
        },
        async createBindSet(layout, bindings) {

            runtime.ownedBindSet = { layout, bindings, dispose() {} }
            return runtime.ownedBindSet
        },
        async createShaderModule(descriptor) {

            return { descriptor, dispose() {} }
        },
        createProgram(descriptor) {

            return { descriptor, dispose() {} }
        },
        async createComputePipeline(descriptor) {

            return { descriptor, dispose() {} }
        },
        createComputePass(descriptor) {

            return { descriptor, dispose() {} }
        },
        createUploadCommand(descriptor) {

            runtime.configUpload = descriptor
            return { descriptor, dispose() {} }
        },
        createClearBufferCommand(descriptor) {

            return { descriptor, dispose() {} }
        },
        createDispatchCommand(descriptor) {

            runtime.lastDispatch = { ...descriptor, dispose() {} }
            return runtime.lastDispatch
        },
        createReadbackCommand() {

            runtime.readbackCount++
            throw new Error('particle slice must not create readback')
        },
    }
    return runtime
}

function particleAddressCodec() {

    return new WebMercatorQuadAddressCodec({
        coordinateBits: 52,
        coverage: tileMatrixCoverage({
            tileMatrixSet: WebMercatorQuad,
            limits: [ { matrixId: '0', minTileCol: 0, maxTileCol: 0, minTileRow: 0, maxTileRow: 0 } ],
        }),
    })
}

function particleView() {

    return Object.freeze({
        kind: 'geo-view-snapshot',
        clipFromRelativeWorld: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        cameraHigh: [0, 0, 1],
        cameraLow: [0, 0, 0],
    })
}

function fakeBuilder(events) {

    return {
        dispatches: [],
        clears: [],
        upload() { events.push('builder:upload'); return this },
        clear(command) { events.push('builder:clear'); this.clears.push(command); return this },
        compute(_pass, commands) {
            events.push('builder:compute')
            this.dispatches.push(...commands.map(command => command.label))
            return this
        },
    }
}
