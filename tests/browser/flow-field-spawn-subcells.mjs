import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { chromium } from 'playwright'
import { WebMercatorQuad, webMercatorQuadAddressCodec, tileMatrixCoverage } from 'geoscratch/geo'
import { prepareFlowParticleSpawnBindings } from '../../examples/flowField/flow-particles.ts'

const codec = webMercatorQuadAddressCodec({ coordinateBits: 32, coverage: tileMatrixCoverage({
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
    capacity: 64,
    resources: { counter: { buffer: {} }, output: { buffer: {} } },
    facts: () => ({ disposed: false, cpuReadback: false }),
})
const address = codec.wgslModule({ namespace: 'FlowVelocityAddress' })
const compact = await readFile(new URL(
    '../../examples/flowField/shaders/spawn-index.compute.wgsl', import.meta.url
), 'utf8')
// The temporal module owns nearest-texel support semantics. This fixture supplies
// two exact endpoint footprints; it intentionally does not depend on alpha.
const compactCode = `${address}
@group(1) @binding(0) var<uniform> testPattern: vec4u;
fn FlowVelocity_spawn_possible(position: FlowVelocityAddressFixedPosition, level: u32) -> bool {
    let pixel = vec2u(position.axes[0].low - 1000u, position.axes[1].low - 2000u) / 16u;
    if (any(pixel >= vec2u(8u))) { return false; }
    let lower = testPattern.x < 8u && pixel.y >= testPattern.x && pixel.y < testPattern.x + testPattern.z;
    let upper = testPattern.y < 8u && pixel.y >= testPattern.y && pixel.y < testPattern.y + testPattern.z;
    return lower || upper;
}
${compact}`
const selectCode = `${address}
fn FlowParticles_random(value: u32) -> u32 {
    var state = select(value, 0x9e3779b9u, value == 0u);
    state ^= state << 13u; state ^= state >> 17u; state ^= state << 5u;
    return state;
}
${prepared.module.wgsl}
@group(0) @binding(0) var<storage, read_write> selections: array<vec4u>;
@compute @workgroup_size(64)
fn selectSubcell(@builtin(global_invocation_id) id: vec3u) {
    if (id.x >= arrayLength(&selections)) { return; }
    let selected = FlowSpawnIndex_select(FlowParticles_random(id.x + 1u));
    selections[id.x] = vec4u(
        (selected.position.axes[0].low - 1000u) / 16u,
        (selected.position.axes[1].low - 2000u) / 16u,
        selected.available, selected.requested_level,
    );
}`
prepared.dispose()
const cases = []
for (const side of [1, 2, 4]) {
    for (const width of [1, 2]) {
        for (let row = 0; row + width <= 8; row++) {
            cases.push({ name: `side-${side}-width-${width}-phase-${row}`, side, width, lower: row, upper: 99 })
        }
    }
    for (let row = 0; row < 4; row++) {
        cases.push({ name: `side-${side}-future-only-phase-${row}`, side, width: 1, lower: 99, upper: row })
    }
    cases.push({ name: `side-${side}-disjoint-endpoint-union`, side, width: 1, lower: 0, upper: 7 })
    cases.push({ name: `side-${side}-empty`, side, width: 1, lower: 99, upper: 99 })
}
const server = createServer((_request, response) => response.end('<!doctype html><title>Flow spawn subcell proof</title>'))
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let browser
try {
    browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu'] })
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    const results = await page.evaluate(async ({ compactCode, selectCode, cases }) => {
        const adapter = await navigator.gpu.requestAdapter()
        if (adapter === null) throw new Error('WebGPU adapter unavailable')
        const device = await adapter.requestDevice()
        device.pushErrorScope('validation')
        async function pipeline(code, entryPoint) {
            const module = device.createShaderModule({ code })
            const errors = (await module.getCompilationInfo()).messages.filter(value => value.type === 'error')
            if (errors.length) throw new Error(errors.map(value => value.message).join('\n'))
            return await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint } })
        }
        const compactPipeline = await pipeline(compactCode, 'compactSpawnIndex')
        const selectPipeline = await pipeline(selectCode, 'selectSubcell')
        const results = []
        for (const fixture of cases) {
            const owned = []
            function buffer(bytes, usage = GPUBufferUsage.STORAGE) {
                const result = device.createBuffer({ size: bytes.byteLength,
                    usage: usage | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST })
                device.queue.writeBuffer(result, 0, bytes)
                owned.push(result)
                return result
            }
            const side = fixture.side
            const edge = 8 / side
            const candidateCount = edge * edge
            const candidateBytes = new Uint8Array(candidateCount * 32)
            const candidates = new DataView(candidateBytes.buffer)
            for (let index = 0; index < candidateCount; index++) {
                candidates.setUint32(index * 32, 1000 + (index % edge) * side * 16, true)
                candidates.setUint32(index * 32 + 8, 2000 + Math.floor(index / edge) * side * 16, true)
                candidates.setUint32(index * 32 + 16, side * 16, true)
            }
            const uniform = new ArrayBuffer(32)
            const uniformValues = new DataView(uniform)
            uniformValues.setUint32(0, candidateCount, true)
            uniformValues.setUint32(4, 64, true)
            uniformValues.setUint32(8, 1, true)
            uniformValues.setUint32(12, side, true)
            const config = buffer(uniform, GPUBufferUsage.UNIFORM)
            const input = buffer(candidateBytes)
            const counter = buffer(new Uint32Array(1))
            const output = buffer(new Uint8Array(64 * 32))
            const overflow = buffer(new Uint32Array(1))
            const pattern = buffer(new Uint32Array([fixture.lower, fixture.upper, fixture.width, 0]), GPUBufferUsage.UNIFORM)
            const selections = buffer(new Uint32Array(512 * 4))
            const group = (pipeline, index, buffers) => device.createBindGroup({
                layout: pipeline.getBindGroupLayout(index),
                entries: buffers.map((value, binding) => ({ binding, resource: { buffer: value } })),
            })
            const compactGroups = [group(compactPipeline, 0, [config, input, counter, output, overflow]),
                group(compactPipeline, 1, [pattern])]
            const selectGroups = [group(selectPipeline, 0, [selections]), group(selectPipeline, 1, []),
                group(selectPipeline, 2, [counter, output])]
            const read = device.createBuffer({ size: 16 + 64 * 32 + 512 * 16,
                usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
            const encoder = device.createCommandEncoder()
            for (const [pipeline, groups, workgroups] of [[compactPipeline, compactGroups, 1],
                [selectPipeline, selectGroups, 8]]) {
                const pass = encoder.beginComputePass()
                pass.setPipeline(pipeline)
                groups.forEach((value, index) => pass.setBindGroup(index, value))
                pass.dispatchWorkgroups(workgroups)
                pass.end()
            }
            encoder.copyBufferToBuffer(counter, 0, read, 0, 4)
            encoder.copyBufferToBuffer(overflow, 0, read, 4, 4)
            encoder.copyBufferToBuffer(output, 0, read, 16, 64 * 32)
            encoder.copyBufferToBuffer(selections, 0, read, 16 + 64 * 32, 512 * 16)
            device.queue.submit([encoder.finish()])
            await read.mapAsync(GPUMapMode.READ)
            const view = new DataView(read.getMappedRange())
            const count = view.getUint32(0, true)
            const records = Array.from({ length: Math.min(count, 64) }, (_, index) => ({
                x: (view.getUint32(16 + index * 32, true) - 1000) / 16,
                y: (view.getUint32(16 + index * 32 + 8, true) - 2000) / 16,
                word: view.getUint32(16 + index * 32 + 28, true),
            })).sort((a, b) => a.y - b.y || a.x - b.x)
            const choices = Array.from({ length: 512 }, (_, index) => {
                const offset = 16 + 64 * 32 + index * 16
                return [view.getUint32(offset, true), view.getUint32(offset + 4, true),
                    view.getUint32(offset + 8, true)]
            })
            results.push({ name: fixture.name, count, overflow: view.getUint32(4, true), records, choices })
            read.unmap()
            read.destroy()
            owned.forEach(value => value.destroy())
        }
        const validation = await device.popErrorScope()
        device.destroy()
        if (validation !== null) throw new Error(validation.message)
        return results
    }, { compactCode, selectCode, cases })
    for (const [index, result] of results.entries()) {
        const fixture = cases[index]
        const supported = y => [fixture.lower, fixture.upper].some(row => row < 8 && y >= row && y < row + fixture.width)
        const expected = []
        for (let y = 0; y < 8; y += fixture.side) {
            for (let x = 0; x < 8; x += fixture.side) {
                let mask = 0
                for (let localY = 0; localY < fixture.side; localY++) {
                    for (let localX = 0; localX < fixture.side; localX++) {
                        if (supported(y + localY)) mask |= 1 << (localY * fixture.side + localX)
                    }
                }
                if (mask) expected.push({ x, y, word: mask | (Math.log2(fixture.side) << 16) })
            }
        }
        assert.equal(result.overflow, 0, fixture.name)
        assert.equal(result.count, expected.length, fixture.name)
        assert.deepEqual(result.records, expected, `${fixture.name}: every source-texel footprint survives compaction`)
        for (const [x, y, available] of result.choices) {
            assert.equal(available, expected.length ? 1 : 0, fixture.name)
            if (available) assert.ok(x < 8 && y < 8 && supported(y), `${fixture.name}: jitter must stay within an occupied subcell`)
        }
    }
    console.log(JSON.stringify({ status: 'passed', cases: cases.length, recordBytes: 32,
        choicesPerCase: 512, subcellSides: [1, 2, 4] }))
} finally {
    await browser?.close()
    await new Promise(resolve => server.close(resolve))
}
