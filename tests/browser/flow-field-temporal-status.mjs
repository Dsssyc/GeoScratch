import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { chromium } from 'playwright'

// Exercise the shipped temporal wrapper on a native GPU. Only the lower-level
// page samplers are fixtures, so retry provenance and unavailable arbitration
// run through the same FlowVelocity_sample function as the example.
const wrapper = await readFile(new URL(
    '../../examples/flowField/shaders/temporal-velocity.wgsl', import.meta.url
), 'utf8')
const levelCount = 4
const sample = (status, level, velocity = [ 3, 4 ]) => ({ status, level, velocity })
const fixtures = []
function add(name, overrides = {}, expected = {}) {
    const fixture = {
        name, requested: 0, inside: true, progress: 0.5, kill: 0,
        current: Array.from({ length: levelCount }, (_, level) => sample(1, level, [ 2, 4 ])),
        next: Array.from({ length: levelCount }, (_, level) => sample(1, level, [ 4, 4 ])),
        ...overrides,
        expected: { status: 1, level: 0, velocity: [ 3, 4 ], advectable: true, ...expected },
    }
    fixtures.push(fixture)
    return fixture
}

add('exact resident interpolation')
add('explicit coarse request is resident', { requested: 2 }, { level: 2 })
const single = add('single fallback keeps provenance', {}, { status: 2, level: 1 })
single.next[0] = sample(2, 1)
const repeated = add('repeated common-level fallback keeps provenance', {}, { status: 2, level: 3 })
repeated.current[0] = sample(2, 1)
repeated.next[1] = sample(2, 3)
const coarseZero = add('coarse zero remains fallback', {}, {
    status: 2, level: 1, velocity: [ 0, 0 ], advectable: false,
})
coarseZero.current[0] = sample(2, 1)
coarseZero.current[1] = sample(1, 1, [ 0, 0 ])
coarseZero.next[1] = sample(1, 1, [ 0, 0 ])
const exactZero = add('resident zero remains valid but cannot advect', {}, {
    velocity: [ 0, 0 ], advectable: false,
})
exactZero.current[0] = sample(1, 0, [ 0, 0 ])
exactZero.next[0] = sample(1, 0, [ 0, 0 ])
const cancelled = add('opposing resident velocities cancel without becoming missing', {}, {
    velocity: [ 0, 0 ], advectable: false,
})
cancelled.current[0] = sample(1, 0, [ -2, 0 ])
cancelled.next[0] = sample(1, 0, [ 2, 0 ])
for (const status of [ 0, 3, 4 ]) {
    for (const side of [ 'current', 'next' ]) {
        const unavailable = add(`${side} status ${status} cannot borrow the other sample`, {
            // A zero interpolation weight does not make an unavailable endpoint
            // valid; an exact time selection uses the same runtime on both sides.
            progress: side === 'current' ? 1 : 0,
        }, { status, velocity: [ 0, 0 ], advectable: false })
        unavailable[side][0] = sample(status, 0, [ 99, 99 ])
    }
}
const fallbackMissing = add('missing after fallback remains missing', {}, {
    status: 0, level: 1, velocity: [ 0, 0 ], advectable: false,
})
fallbackMissing.next[0] = sample(2, 1)
fallbackMissing.current[1] = sample(0, 1)
const failurePriority = add('failure dominates missing', {}, {
    status: 4, velocity: [ 0, 0 ], advectable: false,
})
failurePriority.current[0] = sample(0, 0)
failurePriority.next[0] = sample(4, 0)
const noDataPriority = add('no-data dominates missing', {}, {
    status: 3, velocity: [ 0, 0 ], advectable: false,
})
noDataPriority.current[0] = sample(3, 0)
noDataPriority.next[0] = sample(0, 0)
add('outside source remains missing', { inside: false }, {
    status: 0, velocity: [ 0, 0 ], advectable: false,
})
add('invalid requested level fails', { requested: levelCount }, {
    status: 4, level: levelCount, velocity: [ 0, 0 ], advectable: false,
})
const invalidResolution = add('backward resolution fails', { requested: 1 }, {
    status: 4, level: 1, velocity: [ 0, 0 ], advectable: false,
})
invalidResolution.current[1] = sample(2, 0)
invalidResolution.next[1] = sample(2, 0)

const fixtureCode = `
struct FlowVelocityAddressFixedPosition { fixture: u32, }
struct TestSample { value: vec2f, status: u32, resolved_level: u32, }
struct TestControl { requested: u32, inside: u32, progress: f32, kill: f32, }
const FlowVelocityCurrent_level_count = ${levelCount}u;
@group(0) @binding(0) var<storage, read> controls: array<TestControl>;
@group(0) @binding(1) var<storage, read> samples: array<TestSample>;
@group(0) @binding(2) var<storage, read_write> output: array<u32>;
fn FlowVelocity_source_contains(position: FlowVelocityAddressFixedPosition) -> bool {
    return controls[position.fixture].inside == 1u;
}
fn FlowVelocityRegistration_position(position: FlowVelocityAddressFixedPosition, level: u32) -> FlowVelocityAddressFixedPosition {
    return position;
}
fn FlowVelocityRegistration_sample_current(position: FlowVelocityAddressFixedPosition, level: u32) -> TestSample {
    return samples[position.fixture * ${levelCount * 2}u + level * 2u];
}
fn FlowVelocityRegistration_sample_next(position: FlowVelocityAddressFixedPosition, level: u32) -> TestSample {
    return samples[position.fixture * ${levelCount * 2}u + level * 2u + 1u];
}
`
const compute = `${fixtureCode}\n${wrapper}\n
@compute @workgroup_size(1) fn test(@builtin(global_invocation_id) id: vec3u) {
    let control = controls[id.x];
    let result = FlowVelocity_sample(FlowVelocityAddressFixedPosition(id.x), control.requested,
        FlowVelocityTemporal(control.progress, control.kill));
    let base = id.x * 6u;
    output[base] = result.status;
    output[base + 1u] = result.resolved_level;
    output[base + 2u] = select(0u, 1u, result.advectable);
    output[base + 3u] = bitcast<u32>(result.velocity.x);
    output[base + 4u] = bitcast<u32>(result.velocity.y);
    output[base + 5u] = bitcast<u32>(result.speed);
}`

const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html')
    response.end('<!doctype html><title>Flow temporal status proof</title>')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let browser
try {
    browser = await chromium.launch({ channel: 'chrome', headless: true, args: [ '--enable-unsafe-webgpu' ] })
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    const results = await page.evaluate(async ({ compute, fixtures, levelCount }) => {
        const adapter = await navigator.gpu.requestAdapter()
        if (adapter === null) throw new Error('Native WebGPU adapter unavailable')
        const device = await adapter.requestDevice()
        device.pushErrorScope('validation')
        const module = device.createShaderModule({ code: compute })
        const messages = (await module.getCompilationInfo()).messages
            .filter(message => message.type === 'error')
        if (messages.length > 0) throw new Error(messages.map(message => message.message).join('\n'))
        const pipeline = await device.createComputePipelineAsync({
            layout: 'auto', compute: { module, entryPoint: 'test' },
        })
        const controlBytes = new ArrayBuffer(fixtures.length * 16)
        const sampleBytes = new ArrayBuffer(fixtures.length * levelCount * 2 * 16)
        const controls = new DataView(controlBytes)
        const samples = new DataView(sampleBytes)
        fixtures.forEach((fixture, index) => {
            controls.setUint32(index * 16, fixture.requested, true)
            controls.setUint32(index * 16 + 4, fixture.inside ? 1 : 0, true)
            controls.setFloat32(index * 16 + 8, fixture.progress, true)
            controls.setFloat32(index * 16 + 12, fixture.kill, true)
            for (let level = 0; level < levelCount; level++) {
                for (const [ side, sideIndex ] of [ [ 'current', 0 ], [ 'next', 1 ] ]) {
                    const sample = fixture[side][level]
                    const offset = (index * levelCount * 2 + level * 2 + sideIndex) * 16
                    samples.setFloat32(offset, sample.velocity[0], true)
                    samples.setFloat32(offset + 4, sample.velocity[1], true)
                    samples.setUint32(offset + 8, sample.status, true)
                    samples.setUint32(offset + 12, sample.level, true)
                }
            }
        })
        const upload = bytes => {
            const buffer = device.createBuffer({
                size: bytes.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            })
            device.queue.writeBuffer(buffer, 0, bytes)
            return buffer
        }
        const controlBuffer = upload(controlBytes)
        const sampleBuffer = upload(sampleBytes)
        const byteLength = fixtures.length * 24
        const output = device.createBuffer({ size: byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC })
        const readback = device.createBuffer({ size: byteLength, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
        const bindGroup = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
            { binding: 0, resource: { buffer: controlBuffer } },
            { binding: 1, resource: { buffer: sampleBuffer } },
            { binding: 2, resource: { buffer: output } },
        ] })
        const encoder = device.createCommandEncoder()
        const pass = encoder.beginComputePass()
        pass.setPipeline(pipeline)
        pass.setBindGroup(0, bindGroup)
        pass.dispatchWorkgroups(fixtures.length)
        pass.end()
        encoder.copyBufferToBuffer(output, 0, readback, 0, byteLength)
        device.queue.submit([ encoder.finish() ])
        await readback.mapAsync(GPUMapMode.READ)
        const values = new DataView(readback.getMappedRange())
        const results = fixtures.map((fixture, index) => {
            const offset = index * 24
            return {
                name: fixture.name,
                status: values.getUint32(offset, true),
                level: values.getUint32(offset + 4, true),
                advectable: values.getUint32(offset + 8, true) === 1,
                velocity: [ values.getFloat32(offset + 12, true), values.getFloat32(offset + 16, true) ],
                speed: values.getFloat32(offset + 20, true),
            }
        })
        readback.unmap()
        for (const resource of [ controlBuffer, sampleBuffer, output, readback ]) resource.destroy()
        const error = await device.popErrorScope()
        device.destroy()
        if (error !== null) throw new Error(error.message)
        return results
    }, { compute, fixtures, levelCount })
    for (const [ index, result ] of results.entries()) {
        const { name, expected } = fixtures[index]
        assert.deepEqual({ status: result.status, level: result.level,
            velocity: result.velocity, advectable: result.advectable }, expected, name)
        assert.ok(Math.abs(result.speed - Math.hypot(...expected.velocity)) < 1e-6, `${name}: speed`)
    }
    console.log(JSON.stringify({ status: 'passed', cases: results }))
} finally {
    await browser?.close()
    await new Promise(resolve => server.close(resolve))
}
