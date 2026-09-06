import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { chromium } from 'playwright'
import { WebMercatorQuad, webMercatorQuadAddressCodec, tileMatrixCoverage } from 'geoscratch/geo'
import { flowScreenProjectionWgsl } from '../../examples/flowField/flow-screen-projection.ts'

const addressCodec = webMercatorQuadAddressCodec({
    coordinateBits: 52,
    coverage: tileMatrixCoverage({
        tileMatrixSet: WebMercatorQuad,
        limits: [ { matrixId: '0', minTileCol: 0, maxTileCol: 0, minTileRow: 0, maxTileRow: 0 } ],
    }),
})
const particleShader = await readFile(new URL(
    '../../examples/flowField/shaders/particle-simulation.compute.wgsl', import.meta.url
), 'utf8')
const renderShader = await readFile(new URL(
    '../../examples/flowField/shaders/particle-render.wgsl', import.meta.url
), 'utf8')
const fixtureShader = `
struct FlowVelocityTemporal { progress: f32, activity_kill: f32, }
struct FlowVelocitySample { velocity: vec2f, speed: f32, status: u32, advectable: bool, }
struct FlowSpawnIndexSelection {
    position: FlowVelocityAddressFixedPosition, requested_level: u32, available: u32,
}
@group(1) @binding(0) var<uniform> test_velocity: vec4f;
@group(1) @binding(1) var<uniform> test_spawn_position: vec4u;
@group(1) @binding(2) var<uniform> test_field_state: vec4u;
@group(1) @binding(3) var<uniform> test_boundary: vec4u;
fn FlowTest_after_boundary(position: FlowVelocityAddressFixedPosition) -> bool {
    let x = position.axes[0];
    return x.high > test_boundary.y || (x.high == test_boundary.y && x.low >= test_boundary.x);
}
fn FlowVelocity_source_contains(position: FlowVelocityAddressFixedPosition) -> bool {
    return test_field_state.x != 0u &&
        !((test_field_state.z & 2u) != 0u && FlowTest_after_boundary(position));
}
fn FlowVelocity_sample(position: FlowVelocityAddressFixedPosition, level: u32, temporal: FlowVelocityTemporal) -> FlowVelocitySample {
    let after = (test_field_state.z & 1u) != 0u && FlowTest_after_boundary(position);
    let velocity = select(test_velocity.xy, vec2f(0.0), after && (test_field_state.z & 4u) != 0u);
    let speed = length(velocity);
    // Match the real sampler's source-domain contract independently of its status fixture.
    let status = select(0u, select(u32(test_velocity.z), test_field_state.y, after),
        FlowVelocity_source_contains(position));
    return FlowVelocitySample(velocity, speed, status, speed >= temporal.activity_kill);
}
fn FlowSpawnIndex_select(seed: u32) -> FlowSpawnIndexSelection {
    var position: FlowVelocityAddressFixedPosition;
    position.axes[0] = FlowVelocityAddressFixedAxis(test_spawn_position.x, test_spawn_position.y);
    position.axes[1] = FlowVelocityAddressFixedAxis(test_spawn_position.z, test_spawn_position.w);
    return FlowSpawnIndexSelection(position, 0u, u32(test_velocity.w));
}
fn FlowSpawnIndex_select_refill(seed: u32) -> FlowSpawnIndexSelection {
    return FlowSpawnIndex_select(seed);
}
fn FlowSpawnIndex_candidate_count() -> u32 { return 0u; }
fn FlowSpawnIndex_candidate_center(index: u32) -> FlowVelocityAddressAdvance {
    var position: FlowVelocityAddressFixedPosition;
    return FlowVelocityAddressAdvance(position, 0u);
}
fn FlowSpawnIndex_record_visible(index: u32, revealed: bool) {}
fn FlowSpawnIndex_refill_quota(particle_count: u32) -> u32 { return particle_count / 4u; }
`
const shader = addressCodec.wgslModule({ namespace: 'FlowVelocityAddress' }) + '\n' +
    flowScreenProjectionWgsl(addressCodec) + '\n' + fixtureShader + '\n' + particleShader
const cases = [
    { name: 'equator-east-wide-step', latitude: 0, velocity: [ 2, 0 ] },
    { name: 'midlatitude-north-wide-step', latitude: 45, velocity: [ 0, 2 ] },
    { name: 'southern-west-south', latitude: -60, velocity: [ -2, -1 ] },
    { name: 'highlatitude-east-north', latitude: 80, velocity: [ 1, 1 ] },
    { name: 'zero-velocity-dies', latitude: 45, velocity: [ 0, 0 ], dead: true },
    { name: 'zero-velocity-zero-threshold-dies', latitude: 45, velocity: [ 0, 0 ], kill: 0, dead: true },
    { name: 'unavailable-in-source-holds', latitude: 45, velocity: [ 1, 1 ], status: 0, pending: true },
    { name: 'missing-in-source-holds', latitude: 45, velocity: [ 1, 1 ], status: 3, pending: true },
    { name: 'missing-does-not-consume-stagnation', latitude: 45, velocity: [ 1, 1 ],
        status: 3, stagnant: 19, pending: true, steps: [ {}, {}, {} ] },
    { name: 'fallback-zero-holds', latitude: 45, velocity: [ 0, 0 ], status: 2, pending: true },
    { name: 'fallback-zero-zero-threshold-holds', latitude: 45, velocity: [ 0, 0 ], status: 2, kill: 0, pending: true },
    { name: 'fallback-nonadvectable-holds', latitude: 45, velocity: [ 0.0001, 0 ], status: 2, pending: true },
    { name: 'resident-nonadvectable-dies', latitude: 45, velocity: [ 0.0001, 0 ], dead: true },
    { name: 'outside-source-unavailable-dies', latitude: 45, velocity: [ 1, 1 ], status: 0, insideSource: false, dead: true },
    { name: 'outside-source-moving-dies', latitude: 45, velocity: [ 1, 1 ], insideSource: false, dead: true },
    { name: 'invalid-sample-dies', latitude: 45, velocity: [ 1, 1 ], status: 4, dead: true },
    { name: 'later-unknown-substep-rolls-back', latitude: 45, velocity: [ 2, 0 ], substeps: 4,
        boundaryOffsetMeters: 60, advanceStatus: 3, pending: true },
    { name: 'later-fallback-zero-substep-rolls-back', latitude: 45, velocity: [ 2, 0 ], substeps: 4,
        boundaryOffsetMeters: 60, advanceStatus: 2, advanceZero: true, pending: true },
    { name: 'later-outside-source-substep-dies', latitude: 45, velocity: [ 2, 0 ], substeps: 4,
        boundaryOffsetMeters: 60, outsideAfterBoundary: true, dead: true },
    { name: 'pending-resumes-without-bridge', latitude: 45, velocity: [ 1, 0 ], age: 7, stagnant: 5,
        steps: [ { status: 3 }, { status: 1 } ], resumed: true },
    { name: 'pending-expires-at-age-bound', latitude: 45, velocity: [ 1, 0 ], age: 2, maximumAge: 3,
        status: 3, steps: [ {}, {} ], expires: true, dead: true },
    { name: 'pending-age-saturates-without-wrap', latitude: 45, velocity: [ 1, 0 ],
        age: 0xfffffffe, maximumAge: 0xffffffff, status: 0, steps: [ {}, {} ], expires: true, dead: true },
    { name: 'unknown-cannot-spawn', latitude: 45, velocity: [ 1, 0 ], status: 3,
        initialState: 0, spawnAvailable: true, dead: true, expectedRetired: 0 },
    { name: 'leaving-viewport-dies', latitude: 45, velocity: [ 2, 0 ], viewRadius: 20, dead: true },
    { name: 'bounded-random-retirement', latitude: 45, velocity: [ 1, 0 ], count: 4096 },
    { name: 'natural-rebirth-without-view-refill', latitude: 45, velocity: [ 1, 0 ], count: 4096, rebirth: true },
    { name: 'bounded-quarter-view-refill', latitude: 45, velocity: [ 1, 0 ], count: 4096, rebirth: true, refill: true },
    { name: 'next-camera-refill-cohort', latitude: 45, velocity: [ 1, 0 ], count: 4096, rebirth: true, refill: true, seed: 2 },
].map(entry => {
    const origin = addressCodec.fromLonLat([ 120, entry.latitude ]).fixed.limbs
        .flatMap(axis => [ axis.low, axis.high ])
    const boundary = BigInt(origin[0]) + (BigInt(origin[1]) << 32n) +
        BigInt(Math.round((entry.boundaryOffsetMeters ?? 60) / addressCodec.quantumMeters))
    return {
        ...entry, origin,
        previous: (entry.pending || entry.resumed || entry.expires)
            ? [ origin[0] - 1, ...origin.slice(1) ] : origin,
        boundary: [ Number(boundary & 0xffffffffn), Number(boundary >> 32n), 0, 0 ],
        spawnPosition: addressCodec.fromLonLat([ 121, entry.latitude ]).fixed.limbs
            .flatMap(axis => [ axis.low, axis.high ]),
    }
})
const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html')
    response.end('<!doctype html><title>Flow particle numerical proof</title>')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let browser
try {
    browser = await chromium.launch({ channel: 'chrome', headless: true, args: [ '--enable-unsafe-webgpu' ] })
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    const proof = await page.evaluate(async ({ shader, renderShader, cases, quantum }) => {
        const adapter = await navigator.gpu.requestAdapter()
        if (adapter === null) throw new Error('WebGPU adapter unavailable')
        const device = await adapter.requestDevice()
        device.pushErrorScope('validation')
        const module = device.createShaderModule({ code: shader })
        const compilation = await module.getCompilationInfo()
        const errors = compilation.messages.filter(message => message.type === 'error')
        if (errors.length > 0) throw new Error(errors.map(error => error.message).join('\n'))
        const pipeline = await device.createComputePipelineAsync({
            layout: 'auto', compute: { module, entryPoint: 'FlowParticles_simulate',
                constants: { FLOW_PARTICLES_REFILL_ENABLED: 1 } },
        })
        const results = []
        for (const fixture of cases) {
            const count = fixture.count ?? 1
            const configBytes = new ArrayBuffer(272)
            const config = new DataView(configBytes)
            config.setUint32(0, count, true)
            config.setUint32(8, fixture.substeps ?? 1, true)
            config.setUint32(12, fixture.maximumAge ?? 3600, true)
            config.setUint32(16, 20, true)
            config.setUint32(20, fixture.seed ?? 1, true)
            config.setFloat32(28, 0.002, true)
            config.setFloat32(32, fixture.kill ?? 0.001, true)
            config.setFloat32(36, 1, true)
            config.setFloat32(40, 0.01, true)
            config.setFloat32(44, 50, true)
            config.setFloat32(48, 4, true)
            config.setUint32(56, fixture.refill ? 1 : 0, true)
            if (fixture.viewRadius !== undefined) {
                config.setUint32(52, 1, true)
                config.setFloat32(64, 1 / fixture.viewRadius, true)
                config.setFloat32(84, 1 / fixture.viewRadius, true)
                config.setFloat32(104, 1, true)
                config.setFloat32(120, 0.5, true)
                config.setFloat32(124, 1, true)
                fixture.origin.forEach((limb, index) => config.setUint32(128 + index * 4, limb, true))
                config.setFloat32(152, quantum, true)
            }
            const records = new ArrayBuffer(count * 56)
            const record = new DataView(records)
            for (let index = 0; index < count; index++) {
                fixture.origin.forEach((limb, limbIndex) => {
                    record.setUint32(index * 56 + limbIndex * 4, limb, true)
                    record.setUint32(index * 56 + 16 + limbIndex * 4, fixture.previous[limbIndex], true)
                })
                if (fixture.pending || fixture.resumed || fixture.expires) {
                    record.setFloat32(index * 56 + 32, 1, true)
                }
                record.setUint32(index * 56 + 48, count > 1 ? (index + 1) * 7919 : 0x12345678, true)
                record.setUint32(index * 56 + 40, fixture.age ?? 0, true)
                record.setUint32(index * 56 + 44, fixture.stagnant ?? 0, true)
                record.setUint32(index * 56 + 52, fixture.initialState ?? 1, true)
            }
            const buffer = (data, usage) => {
                const target = device.createBuffer({ size: data.byteLength, usage: usage | GPUBufferUsage.COPY_DST })
                device.queue.writeBuffer(target, 0, data)
                return target
            }
            const configBuffer = buffer(configBytes, GPUBufferUsage.UNIFORM)
            const particles = buffer(records, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC)
            const counters = buffer(new Uint32Array(4), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC)
            const velocity = buffer(new Float32Array([
                ...fixture.velocity, fixture.status ?? 1, fixture.rebirth || fixture.spawnAvailable ? 1 : 0,
            ]), GPUBufferUsage.UNIFORM)
            const spawnPosition = buffer(new Uint32Array(fixture.spawnPosition), GPUBufferUsage.UNIFORM)
            const fieldState = buffer(new Uint32Array([
                fixture.insideSource === false ? 0 : 1,
                fixture.advanceStatus ?? 1,
                (fixture.advanceStatus === undefined ? 0 : 1) |
                    (fixture.outsideAfterBoundary ? 2 : 0) | (fixture.advanceZero ? 4 : 0),
                0,
            ]), GPUBufferUsage.UNIFORM)
            const boundary = buffer(new Uint32Array(fixture.boundary), GPUBufferUsage.UNIFORM)
            const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
                { binding: 0, resource: { buffer: configBuffer } },
                { binding: 1, resource: { buffer: particles } },
                { binding: 2, resource: { buffer: counters } },
            ] })
            const sampleGroup = device.createBindGroup({ layout: pipeline.getBindGroupLayout(1), entries: [
                { binding: 0, resource: { buffer: velocity } },
                { binding: 1, resource: { buffer: spawnPosition } },
                { binding: 2, resource: { buffer: fieldState } },
                { binding: 3, resource: { buffer: boundary } },
            ] })
            const output = device.createBuffer({ size: records.byteLength + 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
            const steps = []
            let observed
            for (const [stepIndex, step] of (fixture.steps ?? [ {} ]).entries()) {
                if (stepIndex > 0) output.unmap()
                device.queue.writeBuffer(velocity, 0, new Float32Array([
                    ...fixture.velocity, step.status ?? fixture.status ?? 1,
                    fixture.rebirth || fixture.spawnAvailable ? 1 : 0,
                ]))
                const encoder = device.createCommandEncoder()
                encoder.clearBuffer(counters)
                const pass = encoder.beginComputePass()
                pass.setPipeline(pipeline)
                pass.setBindGroup(0, group)
                pass.setBindGroup(1, sampleGroup)
                pass.dispatchWorkgroups(Math.ceil(count / 256))
                pass.end()
                encoder.copyBufferToBuffer(particles, 0, output, 0, records.byteLength)
                encoder.copyBufferToBuffer(counters, 0, output, records.byteLength, 16)
                device.queue.submit([ encoder.finish() ])
                await output.mapAsync(GPUMapMode.READ)
                observed = new DataView(output.getMappedRange())
                const snapshot = observed
                steps.push({
                    current: [ 0, 1, 2, 3 ].map(index => snapshot.getUint32(index * 4, true)),
                    previous: [ 0, 1, 2, 3 ].map(index => snapshot.getUint32(16 + index * 4, true)),
                    velocity: [ snapshot.getFloat32(32, true), snapshot.getFloat32(36, true) ],
                    age: snapshot.getUint32(40, true),
                    stagnant: snapshot.getUint32(44, true),
                    state: snapshot.getUint32(52, true),
                    counters: [ 0, 1, 2 ].map(index => snapshot.getUint32(records.byteLength + index * 4, true)),
                })
            }
            const axis = offset => BigInt(observed.getUint32(offset, true)) +
                (BigInt(observed.getUint32(offset + 4, true)) << 32n)
            const originalAxis = index => BigInt(fixture.origin[index]) +
                (BigInt(fixture.origin[index + 1]) << 32n)
            let refill
            if (fixture.rebirth) {
                refill = { reborn: 0, forcedReborn: 0, naturalRetirements: 0, mismatches: 0, bridges: 0 }
                let cohort = Math.imul(fixture.seed ?? 1, 0x9e3779b9) >>> 0
                cohort = (cohort ^ (cohort << 13)) >>> 0
                cohort = (cohort ^ (cohort >>> 17)) >>> 0
                cohort = (cohort ^ (cohort << 5)) >>> 0
                const cohortOffset = cohort % count
                refill.cohortOffset = cohortOffset
                for (let index = 0; index < count; index++) {
                    let random = (((index + 1) * 7919) ^ (fixture.seed ?? 1)) >>> 0
                    if (random === 0) random = 0x9e3779b9
                    random = (random ^ (random << 13)) >>> 0
                    random = (random ^ (random >>> 17)) >>> 0
                    random = (random ^ (random << 5)) >>> 0
                    const natural = (random >>> 8) / 16777216 < Math.fround(0.003 + 0.001 / 4)
                    const forced = Boolean(fixture.refill) && (index + cohortOffset) % count < count / 4
                    const expectedRebirth = natural || forced
                    if (natural) refill.naturalRetirements++
                    const offset = index * 56
                    const current = [ 0, 1, 2, 3 ].map(limb => observed.getUint32(offset + limb * 4, true))
                    const previous = [ 0, 1, 2, 3 ].map(limb => observed.getUint32(offset + 16 + limb * 4, true))
                    const reborn = observed.getUint32(offset + 40, true) === 0
                    if (reborn) refill.reborn++
                    if (forced && reborn) refill.forcedReborn++
                    if (reborn !== expectedRebirth || observed.getUint32(offset + 52, true) !== 1) {
                        refill.mismatches++
                    }
                    if (reborn) {
                        if (current.some((limb, i) => limb !== fixture.spawnPosition[i]) ||
                            previous.some((limb, i) => limb !== current[i]) ||
                            observed.getFloat32(offset + 32, true) !== 0 ||
                            observed.getFloat32(offset + 36, true) !== 0) refill.bridges++
                    } else if (previous.some((limb, i) => limb !== fixture.origin[i]) ||
                        observed.getUint32(offset + 40, true) !== 1) refill.mismatches++
                }
            }
            results.push({
                name: fixture.name,
                displacement: [ Number(axis(0) - originalAxis(0)) * quantum,
                    -Number(axis(8) - originalAxis(2)) * quantum ],
                state: observed.getUint32(52, true),
                counters: [ 0, 1, 2 ].map(index => observed.getUint32(records.byteLength + index * 4, true)),
                steps,
                ...(refill === undefined ? {} : { refill }),
            })
            output.unmap()
            for (const resource of [ configBuffer, particles, counters, velocity, spawnPosition,
                fieldState, boundary, output ]) resource.destroy()
        }
        const renderModule = device.createShaderModule({
            code: `const FLOW_PARTICLE_MAXIMUM_SPEED = 4.0f;\n${renderShader}`,
        })
        const renderPipeline = await device.createRenderPipelineAsync({
            layout: 'auto',
            vertex: { module: renderModule, entryPoint: 'vParticle' },
            fragment: { module: renderModule, entryPoint: 'fParticle', targets: [ { format: 'rgba8unorm' } ] },
            primitive: { topology: 'line-list' },
            depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' },
        })
        const origin = cases[0].origin
        const renderRecord = new ArrayBuffer(56)
        const renderData = new DataView(renderRecord)
        origin.forEach((limb, index) => {
            renderData.setUint32(index * 4, limb, true)
            renderData.setUint32(16 + index * 4, limb, true)
        })
        const east = BigInt(origin[0]) + (BigInt(origin[1]) << 32n)
        const halfMeter = BigInt(Math.round(0.5 / quantum))
        const putEast = (offset, value) => {
            renderData.setUint32(offset, Number(value & 0xffffffffn), true)
            renderData.setUint32(offset + 4, Number(value >> 32n), true)
        }
        putEast(0, east + halfMeter)
        putEast(16, east - halfMeter)
        renderData.setUint32(52, 1, true)
        const renderBuffer = device.createBuffer({ size: 56, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
        const viewBytes = new ArrayBuffer(112)
        const renderView = new DataView(viewBytes)
        for (const offset of [ 0, 20, 40, 60 ]) renderView.setFloat32(offset, 1, true)
        renderView.setFloat32(56, 0.5, true)
        origin.forEach((limb, index) => renderView.setUint32(64 + index * 4, limb, true))
        renderView.setFloat32(88, quantum, true)
        const viewBuffer = device.createBuffer({ size: 112, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
        device.queue.writeBuffer(viewBuffer, 0, viewBytes)
        const particleGroup = device.createBindGroup({ layout: renderPipeline.getBindGroupLayout(0), entries: [
            { binding: 0, resource: { buffer: renderBuffer } },
        ] })
        const viewGroup = device.createBindGroup({ layout: renderPipeline.getBindGroupLayout(1), entries: [
            { binding: 0, resource: { buffer: viewBuffer } },
        ] })
        const colors = []
        for (const speed of [ 0, 0.25, 0.5, 1, 2, 3, 4 ]) {
            renderData.setFloat32(32, speed, true)
            device.queue.writeBuffer(renderBuffer, 0, renderRecord)
            const target = device.createTexture({ size: [ 16, 16 ], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC })
            const depth = device.createTexture({ size: [ 16, 16 ], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT })
            const pixels = device.createBuffer({ size: 256 * 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
            const encoder = device.createCommandEncoder()
            const pass = encoder.beginRenderPass({
                colorAttachments: [ { view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [ 0, 0, 0, 0 ] } ],
                depthStencilAttachment: { view: depth.createView(), depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 1 },
            })
            pass.setPipeline(renderPipeline)
            pass.setBindGroup(0, particleGroup)
            pass.setBindGroup(1, viewGroup)
            pass.draw(2)
            pass.end()
            encoder.copyTextureToBuffer({ texture: target }, { buffer: pixels, bytesPerRow: 256 }, [ 16, 16 ])
            device.queue.submit([ encoder.finish() ])
            await pixels.mapAsync(GPUMapMode.READ)
            const bytes = new Uint8Array(pixels.getMappedRange())
            let color
            for (let y = 0; y < 16; y++) {
                for (let x = 0; x < 16; x++) {
                    const offset = y * 256 + x * 4
                    if (bytes[offset + 3] > 0) color = Array.from(bytes.slice(offset, offset + 4))
                }
            }
            colors.push({ speed, color })
            pixels.unmap()
            pixels.destroy()
            target.destroy()
            depth.destroy()
        }
        renderBuffer.destroy()
        viewBuffer.destroy()
        const validation = await device.popErrorScope()
        if (validation !== null) throw new Error(validation.message)
        device.destroy()
        return { results, colors }
    }, { shader, renderShader, cases, quantum: addressCodec.quantumMeters })
    const cohorts = proof.results.filter(result => result.refill?.forcedReborn > 0)
    const cohortSlots = offset => new Set(Array.from({length:4096}, (_v,index) => index)
        .filter(index => (index + offset) % 4096 < 1024))
    const firstCohort = cohortSlots(cohorts[0].refill.cohortOffset)
    const nextCohort = cohortSlots(cohorts[1].refill.cohortOffset)
    assert.ok([...firstCohort].filter(index => nextCohort.has(index)).length < 512,
        'Consecutive camera refills must not immediately retire the same newborn cohort')
    for (const [ index, result ] of proof.results.entries()) {
        const fixture = cases[index]
        if (fixture.pending || fixture.resumed || fixture.expires) {
            const held = result.steps[0]
            assert.equal(held.state, 1, `${fixture.name}: pending slot remains active`)
            assert.deepEqual(held.current, fixture.origin, `${fixture.name}: no partial substep publication`)
            assert.deepEqual(held.previous, fixture.origin, `${fixture.name}: no bridge while waiting`)
            assert.deepEqual(held.velocity, [ 0, 0 ], `${fixture.name}: waiting is not moving`)
            assert.equal(held.age, (fixture.age ?? 0) + 1, `${fixture.name}: waiting consumes bounded lifetime`)
            assert.equal(held.stagnant, fixture.stagnant ?? 0, `${fixture.name}: waiting is not real stagnation`)
            assert.deepEqual(held.counters, [ 1, 0, 0 ], `${fixture.name}: no missing-data retirement or birth`)
        }
        if (fixture.resumed) {
            assert.deepEqual(result.steps[1].previous, fixture.origin, `${fixture.name}: resume begins at retained origin`)
            assert.equal(result.steps[1].age, fixture.age + 2, `${fixture.name}: lifetime continues across residency`)
            assert.equal(result.steps[1].stagnant, 0, `${fixture.name}: real displacement clears stagnation`)
            assert.deepEqual(result.steps[1].counters, [ 1, 0, 0 ], `${fixture.name}: resume does not rebirth`)
        }
        if (fixture.dead) {
            assert.equal(result.state, 0, fixture.name)
            assert.deepEqual(result.counters, [ 0, 1, fixture.expectedRetired ?? 1 ], fixture.name)
        } else if (fixture.pending) {
            assert.ok(result.displacement.every(value => value === 0), `${fixture.name}: canonical position is unchanged`)
            for (const [stepIndex, held] of result.steps.entries()) {
                assert.deepEqual(held.previous, held.current, `${fixture.name}: every waiting frame suppresses its segment`)
                assert.deepEqual(held.velocity, [ 0, 0 ], fixture.name)
                assert.equal(held.age, (fixture.age ?? 0) + stepIndex + 1, fixture.name)
                assert.equal(held.stagnant, fixture.stagnant ?? 0, fixture.name)
                assert.deepEqual(held.counters, [ 1, 0, 0 ], fixture.name)
            }
        } else if (fixture.rebirth) {
            assert.equal(result.refill.mismatches, 0, `${fixture.name}: exact natural/forced slot ownership`)
            assert.equal(result.refill.bridges, 0, `${fixture.name}: replacements must start with a zero-length segment`)
            assert.equal(result.refill.forcedReborn, fixture.refill ? fixture.count / 4 : 0, fixture.name)
            assert.ok(result.refill.naturalRetirements > 4 && result.refill.naturalRetirements < 40, fixture.name)
            assert.equal(result.counters[0], fixture.count, fixture.name)
            assert.equal(result.counters[1], 0, fixture.name)
            assert.equal(result.counters[2], result.refill.reborn, fixture.name)
            if (fixture.refill) {
                assert.ok(result.refill.reborn >= fixture.count / 4 &&
                    result.refill.reborn <= fixture.count / 4 + result.refill.naturalRetirements, fixture.name)
            } else assert.equal(result.refill.reborn, result.refill.naturalRetirements, fixture.name)
        } else if (fixture.count !== undefined) {
            assert.ok(result.counters[2] > 4 && result.counters[2] < 40, `${fixture.name}: ${result.counters}`)
            assert.equal(result.counters[0] + result.counters[1], fixture.count)
        } else {
            assert.equal(result.state, 1, fixture.name)
            const scale = 6378137 / 6371000 / Math.cos(fixture.latitude * Math.PI / 180)
            fixture.velocity.forEach((velocity, axis) => {
                const expected = velocity * 50 * scale
                assert.ok(Math.abs(result.displacement[axis] - expected) < 0.005,
                    `${fixture.name} axis ${axis}: expected ${expected}, got ${result.displacement[axis]}`)
            })
        }
    }
    const ramp = [ 0x3288bd, 0x66c2a5, 0xabdda4, 0xe6f598, 0xfee08b, 0xfdae61, 0xf46d43, 0xd53e4f ]
    for (const { speed, color } of proof.colors) {
        assert.ok(color, `Particle line at speed ${speed} must rasterize`)
        const position = Math.min(speed / 4 * 8, 7)
        const lower = Math.floor(position)
        const upper = Math.min(lower + 1, 7)
        for (const [ channel, shift ] of [ 16, 8, 0 ].entries()) {
            const low = ramp[lower] >> shift & 255
            const high = ramp[upper] >> shift & 255
            assert.ok(Math.abs(color[channel] - (low + (high - low) * (position - lower))) <= 1,
                `Reference palette mismatch at speed ${speed}, channel ${channel}`)
        }
        assert.equal(color[3], 128, 'Particle fragment alpha is 0.5')
    }
    process.stdout.write(`${JSON.stringify({ status: 'passed', coordinateBits: 52, ...proof }, null, 2)}\n`)
} finally {
    await browser?.close()
    await new Promise(resolve => server.close(resolve))
}
