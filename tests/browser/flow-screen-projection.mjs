import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import {
    WebMercatorQuad, tileMatrixCoverage, webMercatorQuadAddressCodec, webMercatorVirtualRasterField,
} from 'geoscratch/geo'
import { flowScreenProjectionWgsl } from '../../examples/flowField/flow-screen-projection.ts'
import { temporalVelocityWgslModule } from '../../examples/flowField/temporal-velocity-raster.ts'
import { mat4 } from 'wgpu-matrix'

const coverage = tileMatrixCoverage({
    tileMatrixSet: WebMercatorQuad,
    limits: [ { matrixId: '4', minTileRow: 0, maxTileRow: 15, minTileCol: 0, maxTileCol: 15 } ],
})
const vectors = [
    { origin: [ 120, 30 ], delta: [ 20_000, -45_000 ], valid: true },
    { origin: [ 120, 30 ], delta: [ -20_000, 45_000 ], valid: true },
    { origin: [ 120, 30 ], delta: [ 19, 20 ], valid: true },
    { origin: [ 179.999, 0 ], delta: [ 20_000, 0 ], valid: true },
    { origin: [ 0, 85 ], delta: [ 0, -1_000_000 ], valid: false },
    { origin: [ 0, 0 ], delta: [ 1, 1 ], valid: true },
    { origin: [ 0, 0 ], delta: [ 50_000_000, 0 ], valid: false },
    { origin: [ 0, 0 ], delta: [ 0, 0 ], valid: true, uv: [0.5, 0.5] },
    { origin: [ 0, 0 ], delta: [ 2_000_000, -2_000_000 ], valid: true, uv: [0.6, 0.4] },
]
const inversePerspective = Array.from(mat4.inverse(mat4.perspective(
    Math.PI / 2, 1, 100, 20_000_000, new Float64Array(16)
), new Float64Array(16)))
const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html')
    response.end('<!doctype html>')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let browser
try {
    browser = await chromium.launch({ channel: 'chrome', headless: true, args: [ '--enable-unsafe-webgpu' ] })
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    const results = []
    for (const coordinateBits of [ 32, 40, 52 ]) {
        const codec = webMercatorQuadAddressCodec({ coverage, coordinateBits })
        const declarations = vectors.map((vector, index) => {
            const axes = codec.fromLonLat(vector.origin).fixed.limbs
            if (vector.uv) return `if (id.x == ${index}u) {
                let ground = FlowScreen_ground_position(vec2f(${vector.uv.join(', ')}),
                    mat4x4f(${inversePerspective.map(value => `${value}`).join(', ')}),
                    vec2u(${axes[0].low}u, ${axes[0].high}u),
                    vec2u(${axes[1].low}u, ${axes[1].high}u), vec2f(10000000.0f, 0.0f));
                output[id.x * 5u] = ground.position.axes[0].low;
                output[id.x * 5u + 1u] = ground.position.axes[0].high;
                output[id.x * 5u + 2u] = ground.position.axes[1].low;
                output[id.x * 5u + 3u] = ground.position.axes[1].high;
                output[id.x * 5u + 4u] = ground.valid;
            }`
            return `if (id.x == ${index}u) {
                let result = FlowScreen_advance_meters(
                    FlowVelocityAddressFixedPosition(array<FlowVelocityAddressFixedAxis, 2>(
                        FlowVelocityAddressFixedAxis(${axes[0].low}u, ${axes[0].high}u),
                        FlowVelocityAddressFixedAxis(${axes[1].low}u, ${axes[1].high}u))),
                    vec2f(${vector.delta[0]}.0f, ${vector.delta[1]}.0f));
                output[id.x * 5u] = result.position.axes[0].low;
                output[id.x * 5u + 1u] = result.position.axes[0].high;
                output[id.x * 5u + 2u] = result.position.axes[1].low;
                output[id.x * 5u + 3u] = result.position.axes[1].high;
                output[id.x * 5u + 4u] = result.north_south_valid;
            }`
        }).join('\n')
        const compute = `${codec.wgslModule({ namespace: 'FlowVelocityAddress' })}
            ${flowScreenProjectionWgsl(codec)}
            @group(0) @binding(0) var<storage, read_write> output: array<u32>;
            @compute @workgroup_size(1) fn test(@builtin(global_invocation_id) id: vec3u) {
                ${declarations}
            }`
        const values = await page.evaluate(async ({ compute, count }) => {
            const adapter = await navigator.gpu.requestAdapter()
            if (!adapter) throw new Error('No native WebGPU adapter')
            const device = await adapter.requestDevice()
            device.pushErrorScope('validation')
            const module = device.createShaderModule({ code: compute })
            const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'test' } })
            const output = device.createBuffer({ size: count * 20, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC })
            const read = device.createBuffer({ size: count * 20, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
            const set = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [ { binding: 0, resource: { buffer: output } } ] })
            const encoder = device.createCommandEncoder()
            const pass = encoder.beginComputePass()
            pass.setPipeline(pipeline)
            pass.setBindGroup(0, set)
            pass.dispatchWorkgroups(count)
            pass.end()
            encoder.copyBufferToBuffer(output, 0, read, 0, count * 20)
            device.queue.submit([ encoder.finish() ])
            await read.mapAsync(GPUMapMode.READ)
            const values = Array.from(new Uint32Array(read.getMappedRange()))
            read.unmap()
            read.destroy()
            output.destroy()
            const error = await device.popErrorScope()
            device.destroy()
            if (error) throw new Error(error.message)
            return values
        }, { compute, count: vectors.length })
        for (let index = 0; index < vectors.length; index++) {
            const vector = vectors[index]
            const row = values.slice(index * 5, index * 5 + 5)
            assert.equal(row[4], vector.valid ? 1 : 0, `${coordinateBits}-bit vector ${index} validity`)
            if (!vector.valid) continue
            const actual = [ BigInt(row[0]) + (BigInt(row[1]) << 32n), BigInt(row[2]) + (BigInt(row[3]) << 32n) ]
            const origin = codec.toWorldQuanta(codec.fromLonLat(vector.origin))
            const world = 2n ** BigInt(coordinateBits)
            const difference = actual.map((axis, i) => {
                let delta = axis - origin[i]
                if (i === 0 && delta < -world / 2n) delta += world
                if (i === 0 && delta > world / 2n) delta -= world
                return Number(delta) * codec.quantumMeters
            })
            for (let i = 0; i < 2; i++) {
                const tolerance = codec.quantumMeters + Math.abs(vector.delta[i]) * 4e-7
                assert.ok(Math.abs(difference[i] - vector.delta[i]) <= tolerance,
                    `${coordinateBits}-bit vector ${index}: ${difference[i]} vs ${vector.delta[i]}`)
            }
        }
        results.push({ coordinateBits, vectors: vectors.length, status: 'passed' })
    }
    const model = webMercatorVirtualRasterField({
        id: 'inspector-proof', addressSpaceId: 'inspector-proof-space', sourceRevision: 'v1',
        coverage, geographicBounds: [ -180, -85, 180, 85 ], coordinateBits: 52,
        fieldKind: 'vector', channels: 2, sampleType: 'float32', gpuFormat: 'rg32float', interpolation: 'linear',
    })
    const temporal = temporalVelocityWgslModule(model, model, {
        group: 1, currentPageTableBinding: 0, currentAtlasBinding: 1, nextPageTableBinding: 2, nextAtlasBinding: 3,
        sampleRegistration: 'pixel-center',
        wrapper: await readFile(new URL('../../examples/flowField/shaders/temporal-velocity.wgsl', import.meta.url), 'utf8'),
    })
    const code = temporal.code + '\n' + flowScreenProjectionWgsl(model.addressCodec) + '\n' +
        await readFile(new URL('../../examples/flowField/shaders/screen-inspector.wgsl', import.meta.url), 'utf8')
    const compilation = await page.evaluate(async code => {
        const adapter = await navigator.gpu.requestAdapter()
        const device = await adapter.requestDevice()
        device.pushErrorScope('validation')
        const module = device.createShaderModule({ code })
        const messages = Array.from((await module.getCompilationInfo()).messages).filter(message => message.type === 'error').map(message => message.message)
        await device.createRenderPipelineAsync({
            layout: 'auto', vertex: { module, entryPoint: 'FlowScreenInspector_vertex' },
            fragment: { module, entryPoint: 'FlowScreenInspector_fragment', targets: [ { format: 'rgba8unorm' } ] },
        })
        const error = await device.popErrorScope()
        device.destroy()
        if (error) messages.push(error.message)
        return messages
    }, code)
    assert.deepEqual(compilation, [])
    console.log(JSON.stringify({ status: 'passed', displacement: results, inspectorPipeline: 'passed' }))
} finally {
    await browser?.close()
    await new Promise(resolve => server.close(resolve))
}
