import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { chromium } from 'playwright'
import { WebMercatorQuad, tileMatrixCoverage, webMercatorVirtualRasterField } from 'geoscratch/geo'
import { temporalVelocityWgslModule } from '../../examples/flowField/temporal-velocity-raster.ts'

const model = webMercatorVirtualRasterField({
    id: 'flow-zero-footprint-proof', addressSpaceId: 'flow-zero-footprint-space', sourceRevision: 'v1',
    coverage: tileMatrixCoverage({ tileMatrixSet: WebMercatorQuad, limits: [
        { matrixId: '1', minTileRow: 0, maxTileRow: 0, minTileCol: 0, maxTileCol: 1 },
    ] }),
    // Use a bounded source, as the example does; longitude 180 wraps to -180
    // in canonical positions and is not this cross-page footprint test's boundary.
    geographicBounds: [-179.9, 0, 179.9, 85], coordinateBits: 52,
    fieldKind: 'vector', channels: 2, sampleType: 'float32', gpuFormat: 'rg32float', interpolation: 'linear',
})
const wrapper = await readFile(new URL('../../examples/flowField/shaders/temporal-velocity.wgsl', import.meta.url), 'utf8')
const options = { group: 1, currentPageTableBinding: 0, currentAtlasBinding: 1,
    nextPageTableBinding: 2, nextAtlasBinding: 3, sampleRegistration: 'pixel-center', wrapper }
const guarded = temporalVelocityWgslModule(model, model, { ...options, activitySupport: 'nearest-texel-zero' })
const legacy = temporalVelocityWgslModule(model, model, options)
assert.equal(guarded.activitySupport, 'nearest-texel-zero')
assert.equal(legacy.activitySupport, 'bilinear')

// Two real pages deliberately use reversed atlas slots, exercising compact page
// addresses and cross-page interpolation instead of assuming a flat texture.
const texelQuanta = model.addressCodec.worldQuanta / 512n
const position = (x, y) => model.addressCodec.fromWorldQuanta([
    BigInt(Math.round(x * Number(texelQuanta))), BigInt(Math.round(y * Number(texelQuanta))),
])
const pageTable = new Uint32Array(model.addressSpace.pageTableEntryCount * 8)
for (const col of [0, 1]) {
    const address = model.addressCodec.address(position(col * 256 + 0.5, 128.5), '1')
    assert.notEqual(address.compactIndex, undefined)
    pageTable.set([1 - col, 0, 0, 1, 0, 0, 0, 0], address.compactIndex * 8)
}
function stored(endpoint, x, y) {
    if (x >= 320 && x <= 321 && y >= 192 && y <= 193) return endpoint === 0 ? [6, 2] : [-6, -2]
    if (x === 256) return endpoint === 1 && y === 128 ? [8, 4] : [0, 0]
    return [Math.fround(2 + x / 512), Math.fround(1 + y / 256)]
}
const atlases = [0, 1].map(endpoint => {
    const pixels = new Float32Array(512 * 256 * 2)
    for (let y = 0; y < 256; y++) for (let x = 0; x < 512; x++) {
        const atlasX = (1 - Math.floor(x / 256)) * 256 + x % 256
        pixels.set(stored(endpoint, x, y), (y * 512 + atlasX) * 2)
    }
    return pixels
})
function bilinear(endpoint, x, y) {
    const left = Math.floor(x - 0.5), top = Math.floor(y - 0.5)
    const fx = x - 0.5 - left, fy = y - 0.5 - top
    return [0, 1].map(channel => {
        const a = stored(endpoint, left, top)[channel] * (1 - fx) + stored(endpoint, left + 1, top)[channel] * fx
        const b = stored(endpoint, left, top + 1)[channel] * (1 - fx) + stored(endpoint, left + 1, top + 1)[channel] * fx
        return a * (1 - fy) + b * fy
    })
}
const cases = []
const fractions = [...Array.from({ length: 32 }, (_, i) => i / 32), 1 - 1 / 65536]
for (const x of fractions) for (const y of [0, 0.25, 0.5, 0.75, 1 - 1 / 65536]) {
    cases.push({ name: `zero-strip-${x}-${y}`, x: 256 + x, y: 64 + y, alpha: 0.277, kind: 'zero', possible: false })
}
for (const x of [255.5, 255.625, 255.875, 256 - 1 / 65536, 257, 257.125, 257.375, 257.75]) {
    cases.push({ name: `active-neighbor-${x}`, x, y: 64.5, alpha: 0.277, kind: 'active', possible: true })
}
for (const x of [256.125, 256.5, 256.875]) {
    cases.push({ name: `t10-zero-t11-active-${x}`, x, y: 128.5, alpha: 0.277, kind: 'transition', possible: true })
}
cases.push({ name: 'future-support-at-alpha-zero', x: 256.5, y: 128.5, alpha: 0, kind: 'transition', possible: true })
cases.push({ name: 'opposite-endpoints-cancel', x: 320.5, y: 192.5, alpha: 0.5, kind: 'active', possible: true })
const input = new Uint8Array(cases.length * 32)
const inputView = new DataView(input.buffer)
for (const [index, test] of cases.entries()) {
    position(test.x, test.y).fixed.limbs.flatMap(axis => [axis.low, axis.high])
        .forEach((limb, axis) => inputView.setUint32(index * 32 + axis * 4, limb, true))
    inputView.setFloat32(index * 32 + 16, test.alpha, true)
}
const kernel = `
struct Probe { position: FlowVelocityAddressFixedPosition, temporal: vec4f, }
struct Result { velocity: vec2f, speed: f32, status: u32,
    advectable: u32, possible: u32, resolved: u32, reserved: u32, }
@group(0) @binding(0) var<storage, read> probes: array<Probe>;
@group(0) @binding(1) var<storage, read_write> results: array<Result>;
@compute @workgroup_size(64)
fn test_zero_footprint(@builtin(global_invocation_id) id: vec3u) {
    if (id.x >= arrayLength(&probes)) { return; }
    let probe = probes[id.x];
    let sample = FlowVelocity_sample(probe.position, 0u, FlowVelocityTemporal(probe.temporal.x, 0.0));
    results[id.x] = Result(sample.velocity, sample.speed, sample.status,
        select(0u, 1u, sample.advectable), select(0u, 1u, FlowVelocity_spawn_possible(probe.position, 0u)),
        sample.resolved_level, 0u);
}`
const server = createServer((_request, response) => response.end('<!doctype html><title>Flow zero footprint proof</title>'))
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let browser
try {
    browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu'] })
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    const proof = await page.evaluate(async ({ codes, input, pageTable, atlases }) => {
        const adapter = await navigator.gpu.requestAdapter()
        if (adapter === null) throw new Error('WebGPU adapter unavailable')
        const device = await adapter.requestDevice()
        const uncaptured = []
        device.addEventListener('uncapturederror', event => uncaptured.push(event.error.message))
        device.pushErrorScope('validation')
        const owned = []
        const buffer = (data, usage) => {
            const target = device.createBuffer({ size: data.byteLength, usage: usage | GPUBufferUsage.COPY_DST })
            device.queue.writeBuffer(target, 0, data)
            owned.push(target)
            return target
        }
        const probes = buffer(new Uint8Array(input), GPUBufferUsage.STORAGE)
        const tables = [0, 1].map(() => buffer(new Uint32Array(pageTable), GPUBufferUsage.STORAGE))
        const textures = atlases.map(pixels => {
            const texture = device.createTexture({ size: [512, 256], format: 'rg32float',
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST })
            device.queue.writeTexture({ texture }, new Float32Array(pixels), { bytesPerRow: 4096 }, [512, 256])
            owned.push(texture)
            return texture
        })
        const outputs = codes.map(() => buffer(new Uint8Array(input.length), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC))
        const readback = device.createBuffer({ size: input.length * codes.length,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
        const layouts = [
            device.createBindGroupLayout({ entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
            ] }),
            device.createBindGroupLayout({ entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
            ] }),
        ]
        const layout = device.createPipelineLayout({ bindGroupLayouts: layouts })
        const encoder = device.createCommandEncoder()
        for (const [index, code] of codes.entries()) {
            const module = device.createShaderModule({ code })
            const errors = (await module.getCompilationInfo()).messages.filter(message => message.type === 'error')
            if (errors.length) throw new Error(errors.map(error => error.message).join('\n'))
            const pipeline = await device.createComputePipelineAsync({ layout, compute: { module, entryPoint: 'test_zero_footprint' } })
            const group0 = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
                { binding: 0, resource: { buffer: probes } }, { binding: 1, resource: { buffer: outputs[index] } },
            ] })
            const group1 = device.createBindGroup({ layout: pipeline.getBindGroupLayout(1), entries: [
                { binding: 0, resource: { buffer: tables[0] } }, { binding: 1, resource: textures[0].createView() },
                { binding: 2, resource: { buffer: tables[1] } }, { binding: 3, resource: textures[1].createView() },
            ] })
            const pass = encoder.beginComputePass()
            pass.setPipeline(pipeline)
            pass.setBindGroup(0, group0)
            pass.setBindGroup(1, group1)
            pass.dispatchWorkgroups(Math.ceil(input.length / 32 / 64))
            pass.end()
            encoder.copyBufferToBuffer(outputs[index], 0, readback, index * input.length, input.length)
        }
        device.queue.submit([encoder.finish()])
        await readback.mapAsync(GPUMapMode.READ)
        const result = new DataView(readback.getMappedRange())
        const samples = codes.map((_code, variant) => Array.from({ length: input.length / 32 }, (_, index) => {
            const base = variant * input.length + index * 32
            return { velocity: [result.getFloat32(base, true), result.getFloat32(base + 4, true)],
                speed: result.getFloat32(base + 8, true), status: result.getUint32(base + 12, true),
                advectable: result.getUint32(base + 16, true), possible: result.getUint32(base + 20, true),
                resolved: result.getUint32(base + 24, true) }
        }))
        readback.unmap()
        readback.destroy()
        owned.forEach(resource => resource.destroy())
        const validation = await device.popErrorScope()
        if (validation !== null) throw new Error(validation.message)
        if (uncaptured.length) throw new Error(uncaptured.join('\n'))
        device.destroy()
        return { samples, validationErrors: 0, deviceErrors: uncaptured, readbacks: 1 }
    }, { codes: [guarded.code + kernel, legacy.code + kernel], input: [...input],
        pageTable: [...pageTable], atlases: atlases.map(pixels => [...pixels]) })
    let legacyFilledZeroSamples = 0
    for (const [index, test] of cases.entries()) {
        const a = bilinear(0, test.x, test.y), b = bilinear(1, test.x, test.y)
        const oldExpected = a.map((value, channel) => value * (1 - test.alpha) + b[channel] * test.alpha)
        const expected = test.kind === 'zero' ? [0, 0] : test.kind === 'transition'
            ? b.map(value => value * test.alpha) : oldExpected
        for (const [variant, target] of [expected, oldExpected].entries()) {
            const sample = proof.samples[variant][index]
            assert.equal(sample.status, 1, `${test.name}: resident data`)
            assert.equal(sample.resolved, 0, `${test.name}: source level`)
            assert.equal(sample.possible, Number(test.possible), `${test.name}: endpoint support union`)
            target.forEach((value, channel) => assert.ok(Math.abs(sample.velocity[channel] - value) < 2e-5,
                `${test.name} variant ${variant} channel ${channel}: ${sample.velocity[channel]} != ${value}`))
        }
        if (test.kind === 'zero') {
            assert.deepEqual(proof.samples[0][index].velocity, [0, 0], `${test.name}: whole zero footprint`)
            assert.equal(proof.samples[0][index].advectable, 0)
            if (proof.samples[1][index].speed > 0) legacyFilledZeroSamples++
        }
        if (test.name === 'future-support-at-alpha-zero' || test.name === 'opposite-endpoints-cancel') {
            assert.deepEqual(proof.samples[0][index].velocity, [0, 0], test.name)
            assert.equal(proof.samples[0][index].advectable, 0, test.name)
            assert.equal(proof.samples[0][index].possible, 1, test.name)
        }
    }
    assert.ok(legacyFilledZeroSamples > 150, 'The ungated control must demonstrate bilinear activation of the zero strip')
    console.log(JSON.stringify({ status: 'passed', probesPerVariant: cases.length, zeroFootprintProbes: fractions.length * 5,
        legacyFilledZeroSamples, pageTableEntries: pageTable.length / 8, atlasFormat: 'rg32float',
        validationErrors: proof.validationErrors, deviceErrors: proof.deviceErrors, readbacks: proof.readbacks }))
} finally {
    await browser?.close()
    await new Promise(resolve => server.close(resolve))
}
