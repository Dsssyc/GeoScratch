import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import {
    WebMercatorQuad, tileMatrixCoverage, webMercatorVirtualRasterField,
} from 'geoscratch/geo'
import { flowScreenProjectionWgsl } from '../../examples/flowField/flow-screen-projection.ts'
import { temporalVelocityWgslModule } from '../../examples/flowField/temporal-velocity-raster.ts'

const model = webMercatorVirtualRasterField({
    id: 'history-proof', addressSpaceId: 'history-proof-space', sourceRevision: 'v1',
    coverage: tileMatrixCoverage({
        tileMatrixSet: WebMercatorQuad,
        limits: [ { matrixId: '0', minTileRow: 0, maxTileRow: 0, minTileCol: 0, maxTileCol: 0 } ],
    }),
    geographicBounds: [ -180, -85, 180, 85 ], coordinateBits: 52,
    fieldKind: 'vector', channels: 2, sampleType: 'float32', gpuFormat: 'rg32float', interpolation: 'linear',
})
const historyShader = await readFile(new URL('../../examples/flowField/shaders/history.wgsl', import.meta.url), 'utf8')
const historySupportShader = await readFile(new URL('../../examples/flowField/shaders/history-support.wgsl', import.meta.url), 'utf8')
const projectionShader = flowScreenProjectionWgsl(model.addressCodec)
const temporal = temporalVelocityWgslModule(model, model, {
    group: 1, currentPageTableBinding: 0, currentAtlasBinding: 1, nextPageTableBinding: 2, nextAtlasBinding: 3,
    sampleRegistration: 'pixel-center',
    wrapper: await readFile(new URL('../../examples/flowField/shaders/temporal-velocity.wgsl', import.meta.url), 'utf8'),
})
const camera = model.addressCodec.fromProjected([ 13_360_000.125, 3_503_000.25 ]).fixed.limbs
const fixture = `
struct FlowVelocityTemporal { progress: f32, activityKill: f32, }
struct FlowVelocitySample { status: u32, velocity: vec2f, speed: f32, advectable: bool, }
@group(1) @binding(0) var<uniform> testVelocity: vec4f;
@group(1) @binding(1) var<storage, read_write> testSampleCalls: atomic<u32>;
fn FlowVelocity_source_contains(position: FlowVelocityAddressFixedPosition) -> bool {
    let x = position.axes[0];
    return testVelocity.w < 1.5 && !(testVelocity.w > 0.5 &&
        (x.high > ${camera[0].high}u || (x.high == ${camera[0].high}u && x.low >= ${camera[0].low}u)));
}
fn FlowVelocity_sample(position: FlowVelocityAddressFixedPosition, level: u32, temporal: FlowVelocityTemporal) -> FlowVelocitySample {
    atomicAdd(&testSampleCalls, 1u);
    let speed = length(testVelocity.xy);
    let x = position.axes[0];
    let outside = testVelocity.w > 0.5 &&
        (x.high > ${camera[0].high}u || (x.high == ${camera[0].high}u && x.low >= ${camera[0].low}u));
    return FlowVelocitySample(select(u32(testVelocity.z), 0u, outside), testVelocity.xy, speed, speed >= temporal.activityKill);
}`
const testCode = model.addressCodec.wgslModule({ namespace: 'FlowVelocityAddress' }) + '\n' +
    fixture + '\n' + projectionShader + '\n' + historySupportShader + '\n' + historyShader
// Rebuild the previous eager order only in this proof. Equal output is required,
// while the counter makes the original unnecessary temporal work observable.
const supportGuard = '    if (!FlowHistory_supported(input.texcoords)) { return vec4f(0.0); }'
assert.equal(historyShader.split(supportGuard).length, 2)
const eagerHistoryShader = historyShader.replace(`${supportGuard}\n`, '')
    .replace('fn fMain(input: VertexOutput) -> @location(0) vec4f {',
        `fn fMain(input: VertexOutput) -> @location(0) vec4f {\n${supportGuard}`)
const eagerCode = testCode.slice(0, -historyShader.length) + eagerHistoryShader
const realCode = temporal.code + '\n' + projectionShader + '\n' + historySupportShader + '\n' + historyShader
const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html')
    response.end('<!doctype html><title>Flow history GPU proof</title>')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let browser
try {
    browser = await chromium.launch({ channel: 'chrome', headless: true, args: [ '--enable-unsafe-webgpu' ] })
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    const proof = await page.evaluate(async ({ testCode, eagerCode, realCode, camera }) => {
        const adapter = await navigator.gpu.requestAdapter()
        if (!adapter) throw new Error('WebGPU adapter unavailable')
        const device = await adapter.requestDevice()
        device.pushErrorScope('validation')
        const pipeline = async code => {
            const module = device.createShaderModule({ code })
            const errors = (await module.getCompilationInfo()).messages.filter(message => message.type === 'error')
            if (errors.length) throw new Error(errors.map(message => message.message).join('\n'))
            return await device.createRenderPipelineAsync({
                layout: 'auto', vertex: { module, entryPoint: 'vMain' },
                fragment: { module, entryPoint: 'fMain', targets: [ { format: 'rgba8unorm' } ] },
                primitive: { topology: 'triangle-strip' },
                depthStencil: { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'less' },
            })
        }
        await pipeline(realCode)
        const testPipeline = await pipeline(testCode)
        const eagerPipeline = await pipeline(eagerCode)
        const buffer = (data, usage) => {
            const target = device.createBuffer({ size: data.byteLength, usage: usage | GPUBufferUsage.COPY_DST })
            device.queue.writeBuffer(target, 0, data)
            return target
        }
        const size = { width: 8, height: 1 }
        const historyPixels = new Uint8Array(8 * 4)
        for (let x = 0; x < 8; x++) historyPixels.set([ 16 + x * 24, 255, 128, 255 ], x * 4)
        const history = device.createTexture({ size, format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST })
        device.queue.writeTexture({ texture: history }, historyPixels, { bytesPerRow: 32 }, size)
        const output = device.createTexture({ size, format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC })
        const depth = device.createTexture({ size, format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT })
        const results = []
        const fixtures = [
            { name: 'moving', velocity: [ 1, 0, 1, 0 ] },
            { name: 'fallback-moving', velocity: [ 1, 0, 2, 0 ] },
            { name: 'fallback-zero-unknown', velocity: [ 0, 0, 2, 0 ] },
            { name: 'outside-source', velocity: [ 0, 0, 0, 2 ] },
            { name: 'zero-even-with-zero-threshold', velocity: [ 0, 0, 1, 0 ], threshold: 0 },
            { name: 'unavailable', velocity: [ 1, 0, 0, 0 ] },
            { name: 'missing', velocity: [ 1, 0, 3, 0 ] },
            { name: 'invalid', velocity: [ 1, 0, 4, 0 ] },
            { name: 'below-threshold', velocity: [ 0.0001, 0, 1, 0 ] },
            { name: 'no-camera-drift', velocity: [ 1, 0, 1, 0 ], reproject: true },
            { name: 'low-limb-camera-shift', velocity: [ 1, 0, 1, 0 ], reproject: true, centerShift: 0.25 },
            { name: 'empty-history', velocity: [ 1, 0, 1, 0 ], pixels: Array(32).fill(0), sampleCalls: 0 },
            { name: 'faded-to-cutoff', velocity: [ 1, 0, 1, 0 ],
                pixels: Array.from({ length: 32 }, (_, index) => index % 4 === 3 ? 255 : 2), sampleCalls: 0 },
            { name: 'above-cutoff', velocity: [ 1, 0, 1, 0 ],
                pixels: Array.from({ length: 32 }, (_, index) => [ 3, 0, 0, 255 ][index % 4]), sampleCalls: 8 },
            { name: 'invalid-history-projection', velocity: [ 1, 0, 1, 0 ],
                reproject: true, historyValid: false, sampleCalls: 0 },
            { name: 'reprojected-source-empty', velocity: [ 1, 0, 1, 0 ],
                reproject: true, centerShift: 0.25,
                pixels: [ 16, 255, 128, 255, ...Array(28).fill(0) ], sampleCalls: 0 },
            { name: 'reprojected-source-populated', velocity: [ 1, 0, 1, 0 ],
                reproject: true, centerShift: 0.25,
                pixels: [ ...Array(4).fill(0), 40, 255, 128, 255, ...Array(24).fill(0) ], sampleCalls: 1 },
            { name: 'current-boundary-after-reprojection', velocity: [ 1, 0, 1, 1 ],
                reproject: true, centerShift: 0.25, sampleCalls: 7 },
        ]
        for (const fixture of fixtures.flatMap(value => [
            { ...value, implementation: 'optimized', pipeline: testPipeline },
            { ...value, implementation: 'eager-control', pipeline: eagerPipeline },
        ])) {
            const testPipeline = fixture.pipeline
            const historySet = device.createBindGroup({ layout: testPipeline.getBindGroupLayout(2), entries: [ { binding: 0, resource: history.createView() } ] })
            device.queue.writeTexture({ texture: history },
                fixture.pixels === undefined ? historyPixels : new Uint8Array(fixture.pixels),
                { bytesPerRow: 32 }, size)
            const bytes = new ArrayBuffer(352)
            const values = new DataView(bytes)
            const f32 = (offset, value) => values.setFloat32(offset, value, true)
            const vector = (offset, value) => value.forEach((component, index) => f32(offset + index * 4, component))
            f32(0, 0.996)
            f32(4, 1 / 255)
            f32(8, 2)
            f32(12, fixture.historyValid === false ? 0 : 1)
            f32(16, fixture.reproject ? 1 : 0)
            const identity = [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 ]
            const previous = [ ...identity ]
            previous[10] = 0
            previous[14] = 0.5
            vector(32, previous)
            vector(96, identity)
            const inverse = [ ...identity ]
            inverse[10] = -1
            vector(160, inverse)
            vector(224, [ 13_360_000, 3_503_000, 0.5 ])
            vector(240, [ 0.125, 0.25, 0 ])
            vector(256, [ 13_360_000, 3_503_000, 0.5 ])
            vector(272, [ 0.125 + (fixture.centerShift ?? 0), 0.25, 0 ])
            vector(288, [ 8, 1 ])
            vector(296, [ 8, 1 ])
            camera.flatMap(axis => [ axis.low, axis.high ]).forEach((limb, index) => values.setUint32(304 + index * 4, limb, true))
            vector(320, [ 0.5, 0 ])
            f32(336, fixture.threshold ?? 0.001)
            const uniform = buffer(bytes, GPUBufferUsage.UNIFORM)
            const velocity = buffer(new Float32Array(fixture.velocity), GPUBufferUsage.UNIFORM)
            const sampleCalls = buffer(new Uint32Array(1), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC)
            const read = device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
            const sampleCallsRead = device.createBuffer({ size: 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
            const uniformSet = device.createBindGroup({ layout: testPipeline.getBindGroupLayout(0), entries: [ { binding: 0, resource: { buffer: uniform } } ] })
            const velocitySet = device.createBindGroup({ layout: testPipeline.getBindGroupLayout(1), entries: [
                { binding: 0, resource: { buffer: velocity } },
                { binding: 1, resource: { buffer: sampleCalls } },
            ] })
            const encoder = device.createCommandEncoder()
            const pass = encoder.beginRenderPass({
                colorAttachments: [ { view: output.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [ 0, 0, 0, 0 ] } ],
                depthStencilAttachment: { view: depth.createView(), depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 1 },
            })
            pass.setPipeline(testPipeline)
            pass.setBindGroup(0, uniformSet)
            pass.setBindGroup(1, velocitySet)
            pass.setBindGroup(2, historySet)
            pass.draw(4)
            pass.end()
            encoder.copyTextureToBuffer({ texture: output }, { buffer: read, bytesPerRow: 256 }, size)
            encoder.copyBufferToBuffer(sampleCalls, 0, sampleCallsRead, 0, 4)
            device.queue.submit([ encoder.finish() ])
            await Promise.all([ read.mapAsync(GPUMapMode.READ), sampleCallsRead.mapAsync(GPUMapMode.READ) ])
            results.push({
                name: fixture.name,
                implementation: fixture.implementation,
                pixels: Array.from(new Uint8Array(read.getMappedRange()).slice(0, 32)),
                sampleCalls: new Uint32Array(sampleCallsRead.getMappedRange())[0],
                expectedSampleCalls: fixture.sampleCalls ?? (fixture.centerShift === undefined ? 8 : 7),
            })
            read.unmap()
            sampleCallsRead.unmap()
            for (const resource of [ uniform, velocity, sampleCalls, read, sampleCallsRead ]) resource.destroy()
        }
        for (const resource of [ history, output, depth ]) resource.destroy()
        const error = await device.popErrorScope()
        device.destroy()
        if (error) throw new Error(error.message)
        return results
    }, { testCode, eagerCode, realCode, camera })
    const optimized = proof.filter(result => result.implementation === 'optimized')
    const eager = proof.filter(result => result.implementation === 'eager-control')
    const row = name => optimized.find(result => result.name === name).pixels
    const expected = Array.from({ length: 32 }, (_, index) => Math.floor([ 16 + Math.floor(index / 4) * 24, 255, 128, 255 ][index % 4] * 0.996))
    assert.deepEqual(row('moving'), expected)
    assert.deepEqual(row('fallback-moving'), expected)
    for (const name of ['unavailable', 'missing', 'fallback-zero-unknown']) {
        assert.deepEqual(row(name), expected, `${name} must retain ink with finite decay`)
    }
    for (const name of [ 'zero-even-with-zero-threshold', 'outside-source', 'invalid', 'below-threshold' ]) {
        assert.deepEqual(row(name), Array(32).fill(0), name)
    }
    assert.deepEqual(row('no-camera-drift'), expected)
    assert.deepEqual(row('low-limb-camera-shift'), [ ...expected.slice(4), 0, 0, 0, 0 ])
    for (const name of [ 'empty-history', 'faded-to-cutoff', 'invalid-history-projection', 'reprojected-source-empty' ]) {
        assert.deepEqual(row(name), Array(32).fill(0), name)
    }
    assert.deepEqual(row('above-cutoff'), Array.from({ length: 32 }, (_, index) => [ 2, 0, 0, Math.floor(255 * 0.996) ][index % 4]))
    assert.deepEqual(row('reprojected-source-populated'), [ ...expected.slice(4, 8), ...Array(28).fill(0) ])
    assert.deepEqual(row('current-boundary-after-reprojection'), [ ...expected.slice(4, 20), ...Array(16).fill(0) ])
    for (const result of optimized) {
        assert.equal(result.sampleCalls, result.expectedSampleCalls, `${result.name} temporal sample count`)
        const control = eager.find(value => value.name === result.name)
        assert.deepEqual(result.pixels, control.pixels, `${result.name} must preserve eager-order output`)
        assert.equal(control.sampleCalls, 8, `${result.name} eager-order control must sample every pixel`)
    }
    console.log(JSON.stringify({ status: 'passed', realTemporalPipeline: 'passed',
        eagerControlSamplesPerCase: 8,
        cases: optimized.map(({ name, sampleCalls }) => ({ name, sampleCalls })) }))
} finally {
    await browser?.close()
    await new Promise(resolve => server.close(resolve))
}
