import { expect } from 'chai'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

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
        expect(classifyFlowParticle({ ...base, ageSteps: 100 })).to.equal('retire')
        expect(classifyFlowParticle({ ...base, stagnantSteps: 20 })).to.equal('retire')
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
        expect(simulation).to.include('FlowVelocityAddress_advance_meters')
        expect(simulation.match(/FlowVelocity_sample\(/g).length).to.be.greaterThan(2)
        expect(simulation).to.include('flowParticleConfig.legacy_displacement_scale')
        expect(simulation).to.include('f32(flowParticleConfig.substeps)')
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
        const particles = await createFlowParticles({
            runtime,
            maximumCount: 1024,
            simulationShader: read(
                'examples',
                'flowField',
                'shaders',
                'particle-simulation.compute.wgsl'
            ),
            temporal: {
                wgsl: '// temporal sampler',
                layout: temporalLayout,
                frame: () => ({
                    bindSet: temporalSet,
                    resources: [ temporalResource ],
                    progress: 0.25,
                    requestedLevel: 2,
                }),
            },
            spawn: {
                wgsl: '// spawn index',
                layout: spawnLayout,
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
        }
        const builder = fakeBuilder(events)

        particles.encode(builder, spawn)

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
        expect(events).to.include('builder:clear')
        expect(events).to.include('builder:upload')
        expect(runtime.lastDispatch.count.workgroups).to.deep.equal([ 4, 1, 1 ])
        expect(runtime.lastDispatch.bindSets.map(binding => binding.set)).to.deep.equal([
            runtime.ownedBindSet,
            temporalSet,
            spawnSet,
        ])
        expect(runtime.readbackCount).to.equal(0)

        particles.dispose()
        particles.dispose()
        expect(particles.facts().disposed).to.equal(true)
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
        expect(prepared.bindings.resources).to.deep.equal([ counter, output ])
        expect(prepared.module.wgsl).to.include('fn FlowSpawnIndex_select(')
        expect(prepared.module.wgsl).to.include('atomicLoad(&flowParticleSpawnCount.value)')
        expect(prepared.module.wgsl).to.include('texel_step_quanta: u32')
        expect(prepared.module.wgsl).to.include('requested_level: u32')
        expect(prepared.module.wgsl).to.include('random_x % candidate.texel_step_quanta')
        expect(prepared.module.wgsl).to.include('random_y % candidate.texel_step_quanta')
        expect(prepared.module.wgsl).to.include('FlowVelocityAddress_advance_i32')
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

function fakeBuilder(events) {

    return {
        upload() { events.push('builder:upload'); return this },
        clear() { events.push('builder:clear'); return this },
        compute() { events.push('builder:compute'); return this },
    }
}
