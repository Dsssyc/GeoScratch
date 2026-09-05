import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { chromium } from 'playwright'
import { WebMercatorQuad, webMercatorQuadAddressCodec, tileMatrixCoverage } from 'geoscratch/geo'
import { flowScreenProjectionWgsl } from '../../examples/flowField/flow-screen-projection.ts'
import { prepareFlowParticleSpawnBindings } from '../../examples/flowField/flow-particles.ts'

const codec = webMercatorQuadAddressCodec({ coordinateBits: 52, coverage: tileMatrixCoverage({
    tileMatrixSet: WebMercatorQuad,
    limits: [{ matrixId: '0', minTileCol: 0, maxTileCol: 0, minTileRow: 0, maxTileRow: 0 }],
}) })
const fakeRuntime = {
    async createBuffer({ size }) {
        const buffer = { size, dispose() {}, region() { return { buffer, size } } }
        return buffer
    },
    async createBindLayout(descriptor) { return { ...descriptor, dispose() {} } },
    async createBindSet() { return { dispose() {} } },
    createClearBufferCommand() { return { dispose() {} } },
}
const prepared = await prepareFlowParticleSpawnBindings(fakeRuntime, {
    capacity: 25,
    resources: { counter: { buffer: {} }, output: { buffer: {} } },
    facts: () => ({ disposed: false, cpuReadback: false }),
})
const particleShader = await readFile(new URL(
    '../../examples/flowField/shaders/particle-simulation.compute.wgsl', import.meta.url
), 'utf8')
const shader = [codec.wgslModule({ namespace: 'FlowVelocityAddress' }), flowScreenProjectionWgsl(codec), `
struct FlowVelocityTemporal { progress: f32, activity_kill: f32, }
struct FlowVelocitySample { velocity: vec2f, speed: f32, status: u32, advectable: bool, }
fn FlowVelocity_sample(position: FlowVelocityAddressFixedPosition, level: u32,
    temporal: FlowVelocityTemporal) -> FlowVelocitySample {
    return FlowVelocitySample(vec2f(1.0, 0.0), 1.0, 1u, true);
}
`, prepared.module.wgsl, particleShader, `
@compute @workgroup_size(1)
fn test_reveal_quota() {
    atomicStore(&flowParticleCounters.reserved_count,
        FlowSpawnIndex_refill_quota(flowParticleConfig.particle_count));
}
`].join('\n')
prepared.dispose()

const all = Array.from({ length: 25 }, (_, index) => index)
const middle = [6, 7, 8, 11, 12, 13, 16, 17, 18]
const cases = [
    { name: 'expansion-capped-quarter', current: [0, 0, 250, 250], previous: [0, 0, 150, 150],
        visible: 25, revealed: all.filter(index => !middle.includes(index)), quota: 25 },
    { name: 'small-reveal-proportional-ceiling', current: [0, 0, 250, 250], previous: [-30, 0, 205, 250],
        particleCount: 103, visible: 25, revealed: [4, 9, 14, 19, 24], quota: 21 },
    { name: 'contraction-no-new-support', current: [0, 0, 150, 150], previous: [0, 0, 250, 250],
        visible: 9, revealed: [], quota: 0 },
    { name: 'same-view-no-new-support', current: [0, 0, 250, 250], previous: [0, 0, 250, 250],
        visible: 25, revealed: [], quota: 0 },
    { name: 'no-visible-support', current: [10000, 0, 150, 150], previous: [0, 0, 250, 250],
        visible: 0, revealed: [], quota: 0 },
    { name: 'shifted-high-low-camera-limbs', base: [-15999999.125, 7000000.625],
        current: [100.375, -99.875, 160, 160], previous: [0, 0, 110, 110],
        visible: 9, revealed: [2, 3, 4, 9, 14], quota: 25 },
].map(fixture => {
    const base = fixture.base ?? [13200000.375, 3500000.125]
    const limbs = point => codec.fromProjected(point).fixed.limbs.flatMap(axis => [axis.low, axis.high])
    const candidateBytes = new Uint8Array(25 * 32)
    const candidates = new DataView(candidateBytes.buffer)
    for (let index = 0; index < 25; index++) {
        limbs([base[0] + (index % 5 - 2) * 100, base[1] + (Math.floor(index / 5) - 2) * 100])
            .forEach((limb, axis) => candidates.setUint32(index * 32 + axis * 4, limb, true))
        candidates.setUint32(index * 32 + 16, 8, true)
        candidates.setUint32(index * 32 + 24, index + 1, true)
    }
    const bytes = new Uint8Array(272)
    const config = new DataView(bytes.buffer)
    config.setUint32(0, fixture.particleCount ?? 100, true)
    config.setUint32(52, 1, true)
    config.setUint32(56, 1, true)
    config.setFloat32(152, codec.quantumMeters, true)
    for (const [camera, matrixOffset, positionOffset, heightOffset, height] of [
        [fixture.current, 64, 128, 144, [150.25, 0.125]],
        [fixture.previous, 176, 240, 256, [800.5, 0.0625]],
    ]) {
        config.setFloat32(matrixOffset, 1 / camera[2], true)
        config.setFloat32(matrixOffset + 20, 1 / camera[3], true)
        config.setFloat32(matrixOffset + 40, 0.001, true)
        config.setFloat32(matrixOffset + 56, 0.5 + (height[0] + height[1]) * 0.001, true)
        config.setFloat32(matrixOffset + 60, 1, true)
        limbs([base[0] + camera[0], base[1] + camera[1]])
            .forEach((limb, index) => config.setUint32(positionOffset + index * 4, limb, true))
        height.forEach((value, index) => config.setFloat32(heightOffset + index * 4, value, true))
    }
    return { ...fixture, candidateBytes: [...candidateBytes], configBytes: [...bytes] }
})
const server = createServer((_request, response) => response.end('<!doctype html><title>Flow reveal index proof</title>'))
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let browser
try {
    browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu'] })
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    const results = await page.evaluate(async ({ shader, cases }) => {
        const adapter = await navigator.gpu.requestAdapter()
        if (adapter === null) throw new Error('WebGPU adapter unavailable')
        const device = await adapter.requestDevice()
        device.pushErrorScope('validation')
        const module = device.createShaderModule({ code: shader })
        const errors = (await module.getCompilationInfo()).messages.filter(message => message.type === 'error')
        if (errors.length) throw new Error(errors.map(error => error.message).join('\n'))
        const entry = (binding, type) => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type } })
        const layouts = [
            device.createBindGroupLayout({ entries: [entry(0, 'uniform'), entry(1, 'storage'), entry(2, 'storage')] }),
            device.createBindGroupLayout({ entries: [] }),
            device.createBindGroupLayout({ entries: [entry(0, 'read-only-storage'), entry(1, 'read-only-storage'),
                entry(2, 'storage'), entry(3, 'storage')] }),
        ]
        const layout = device.createPipelineLayout({ bindGroupLayouts: layouts })
        const pipelines = await Promise.all(['FlowParticles_build_refill_index', 'test_reveal_quota'].map(entryPoint =>
            device.createComputePipelineAsync({ layout, compute: { module, entryPoint } })))
        const results = []
        for (const fixture of cases) {
            const resources = []
            const buffer = (data, usage = GPUBufferUsage.STORAGE) => {
                const target = device.createBuffer({ size: data.byteLength,
                    usage: usage | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC })
                device.queue.writeBuffer(target, 0, data)
                resources.push(target)
                return target
            }
            const config = buffer(new Uint8Array(fixture.configBytes), GPUBufferUsage.UNIFORM)
            const particles = buffer(new Uint8Array(56))
            const counters = buffer(new Uint32Array(4))
            const count = buffer(new Uint32Array([25]))
            const candidates = buffer(new Uint8Array(fixture.candidateBytes))
            const refillCount = buffer(new Uint32Array([0, 0]))
            const refillIndices = buffer(new Uint32Array(25).fill(0xffffffff))
            const group = (index, buffers) => device.createBindGroup({ layout: layouts[index],
                entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })) })
            const groups = [group(0, [config, particles, counters]), group(1, []),
                group(2, [count, candidates, refillCount, refillIndices])]
            const output = device.createBuffer({ size: 124, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
            const encoder = device.createCommandEncoder()
            for (const pipeline of pipelines) {
                const pass = encoder.beginComputePass()
                pass.setPipeline(pipeline)
                groups.forEach((group, index) => pass.setBindGroup(index, group))
                pass.dispatchWorkgroups(1)
                pass.end()
            }
            encoder.copyBufferToBuffer(refillCount, 0, output, 0, 8)
            encoder.copyBufferToBuffer(refillIndices, 0, output, 8, 100)
            encoder.copyBufferToBuffer(counters, 0, output, 108, 16)
            device.queue.submit([encoder.finish()])
            await output.mapAsync(GPUMapMode.READ)
            const observed = new Uint32Array(output.getMappedRange())
            results.push({ name: fixture.name, visible: observed[0], revealed: observed[1],
                indices: Array.from(observed.slice(2, 2 + Math.min(observed[1], 25))).sort((a, b) => a - b),
                quota: observed[30] })
            output.unmap()
            output.destroy()
            resources.forEach(resource => resource.destroy())
        }
        const validation = await device.popErrorScope()
        if (validation !== null) throw new Error(validation.message)
        device.destroy()
        return results
    }, { shader, cases })
    for (const [index, result] of results.entries()) {
        const expected = cases[index]
        assert.equal(result.visible, expected.visible, `${expected.name}: visible count`)
        assert.equal(result.revealed, expected.revealed.length, `${expected.name}: revealed count`)
        assert.deepEqual(result.indices, expected.revealed, `${expected.name}: exact revealed candidates`)
        assert.equal(result.quota, expected.quota, `${expected.name}: proportional bounded quota`)
    }
    process.stdout.write(`${JSON.stringify({ status: 'passed', results }, null, 2)}\n`)
} finally {
    await browser?.close()
    await new Promise(resolve => server.close(resolve))
}
