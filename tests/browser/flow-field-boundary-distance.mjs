import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { chromium } from 'playwright'

const source = await readFile(new URL('../../examples/flowField/shaders/boundary-distance.wgsl', import.meta.url), 'utf8')
const corners = [[0, 0], [1, 0], [1, 1], [0, 1]]
const edgeCenters = [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]]
const segmentsByMask = Array.from({ length: 16 }, (_, mask) => contourSegments(mask))
const legacyBaseline = process.argv.includes('--legacy-baseline')
const coverageWidths = [0.05, 0.25, 0.35]
const divisions = 16
const probes = []
const lookup = new Map()
for (let mask = 0; mask < 16; mask++) {
    for (let y = 0; y <= divisions; y++) for (let x = 0; x <= divisions; x++) {
        lookup.set(`${mask}/${x}/${y}`, probes.length)
        probes.push({ mask, p: [x / divisions, y / divisions], kind: 0 })
    }
}
const bandDistances = [-1, -0.25, -1e-6, 0, 1e-6, 0.0625, 0.125, 0.1875, 0.25 - 1e-6, 0.25, 0.25 + 1e-6, 1]
for (const distance of bandDistances) probes.push({ mask: 0, p: [distance, 0], kind: 1 })
const originalProbeCount = probes.length
function neighborhoodProbe(masks, p) {
    const index = probes.length
    probes.push({ mask: masks[4], masks, p, kind: 2 })
    return index
}
// Every 4x4 binary vertex arrangement produces nine mutually consistent cells.
for (let bits = 0; bits < 65536; bits++) {
    const vertices = Array.from({ length: 16 }, (_, index) => bits >> index & 1)
    neighborhoodProbe(neighborhoodMasks(vertices, 4), [0.125, 0.5])
}
let randomState = 0x9137ab21
function random() {
    randomState ^= randomState << 13
    randomState ^= randomState >>> 17
    randomState ^= randomState << 5
    return (randomState >>> 0) / 0x100000000
}
for (let index = 0; index < 1024; index++) {
    const vertices = Array.from({ length: 16 }, () => Number(random() >= 0.5))
    neighborhoodProbe(neighborhoodMasks(vertices, 4), [Math.floor(random() * 1025) / 1024, Math.floor(random() * 1025) / 1024])
}
const sharedEdges = []
function sharedPair(left, right, orientation, phase, epsilon = 0) {
    const a = neighborhoodProbe(left, orientation === 'vertical' ? [1 - epsilon, phase] : [phase, 1 - epsilon])
    const b = neighborhoodProbe(right, orientation === 'vertical' ? [epsilon, phase] : [phase, epsilon])
    sharedEdges.push({ a, b, epsilon })
    return { a, b }
}
for (const orientation of ['vertical', 'horizontal']) {
    const width = orientation === 'vertical' ? 5 : 4
    for (let index = 0; index < 256; index++) {
        const vertices = Array.from({ length: 20 }, () => Number(random() >= 0.5))
        const a = neighborhoodMasks(vertices, width)
        const b = neighborhoodMasks(vertices, width, orientation === 'vertical' ? 1 : 0,
            orientation === 'horizontal' ? 1 : 0)
        for (const phase of [0.125, 0.25, 0.5, 0.75, 0.875]) {
            sharedPair(a, b, orientation, phase)
            sharedPair(a, b, orientation, phase, 1 / 4096)
        }
    }
}
// The reported opacity seam: a horizontal segment ends where its neighbor's
// diagonal becomes closer. Old cell-local distance ignores that closer segment.
const counterexampleVertices = Array(20).fill(0)
counterexampleVertices[6] = counterexampleVertices[7] = 1
const counterLeft = neighborhoodMasks(counterexampleVertices, 5)
const counterRight = neighborhoodMasks(counterexampleVertices, 5, 1)
assert.equal(counterLeft[4], 3)
assert.equal(counterRight[4], 1)
const counterexample = sharedPair(counterLeft, counterRight, 'vertical', 0.25)
const finiteSegmentProbe = neighborhoodProbe(counterRight, [0.125, 0.5])
const input = new Uint8Array(probes.length * 64)
const values = new DataView(input.buffer)
for (const [index, probe] of probes.entries()) {
    values.setFloat32(index * 64, probe.p[0], true)
    values.setFloat32(index * 64 + 4, probe.p[1], true)
    values.setUint32(index * 64 + 8, probe.mask, true)
    values.setUint32(index * 64 + 12, probe.kind, true)
    probe.masks?.forEach((mask, cell) => values.setUint32(index * 64 + 16 + cell * 4, mask, true))
}
const code = source + `
struct Probe { p: vec2f, corners: u32, kind: u32, masks: array<u32, 9>, pad0: u32, pad1: u32, pad2: u32, }
@group(0) @binding(0) var<storage, read> probes: array<Probe>;
@group(0) @binding(1) var<storage, read_write> output: array<vec4f>;
@compute @workgroup_size(64)
fn test_boundary_distance(@builtin(global_invocation_id) id: vec3u) {
    if (id.x >= arrayLength(&probes)) { return; }
    let probe = probes[id.x];
    var distance = probe.p.x;
    if (probe.kind != 1u) { distance = FlowBoundary_distance(probe.p, probe.corners); }
    let local_distance = distance;
    if (probe.kind == 2u) {
        distance = ${legacyBaseline ? 'local_distance' : 'FlowBoundary_neighborhood_distance(probe.p, probe.masks)'};
    }
    output[id.x] = vec4f(distance, FlowBoundary_inner_coverage(distance, 0.25),
        local_distance, FlowBoundary_inner_coverage(local_distance, 0.25));
}`
const server = createServer((_request, response) => response.end('<!doctype html><title>Flow boundary distance proof</title>'))
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let browser
try {
    browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu'] })
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    const proof = await page.evaluate(async ({ code, inputBase64 }) => {
        const binary = atob(inputBase64)
        const input = Uint8Array.from(binary, character => character.charCodeAt(0))
        const adapter = await navigator.gpu.requestAdapter()
        if (adapter === null) throw new Error('WebGPU adapter unavailable')
        const device = await adapter.requestDevice()
        const errors = []
        device.addEventListener('uncapturederror', event => errors.push(event.error.message))
        device.pushErrorScope('validation')
        const module = device.createShaderModule({ code })
        const compilation = (await module.getCompilationInfo()).messages.filter(message => message.type === 'error')
        if (compilation.length) throw new Error(compilation.map(message => message.message).join('\n'))
        const pipeline = await device.createComputePipelineAsync({ layout: 'auto',
            compute: { module, entryPoint: 'test_boundary_distance' } })
        const inputs = device.createBuffer({ size: input.length, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
        device.queue.writeBuffer(inputs, 0, input)
        const output = device.createBuffer({ size: input.length / 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC })
        const readback = device.createBuffer({ size: input.length / 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
        const bindings = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
            { binding: 0, resource: { buffer: inputs } }, { binding: 1, resource: { buffer: output } },
        ] })
        const encoder = device.createCommandEncoder()
        const pass = encoder.beginComputePass()
        pass.setPipeline(pipeline)
        pass.setBindGroup(0, bindings)
        pass.dispatchWorkgroups(Math.ceil(input.length / 64 / 64))
        pass.end()
        encoder.copyBufferToBuffer(output, 0, readback, 0, input.length / 4)
        device.queue.submit([encoder.finish()])
        await readback.mapAsync(GPUMapMode.READ)
        const result = Array.from(new Float32Array(readback.getMappedRange()))
        readback.unmap()
        for (const resource of [inputs, output, readback]) resource.destroy()
        const validation = await device.popErrorScope()
        if (validation !== null) throw new Error(validation.message)
        if (errors.length) throw new Error(errors.join('\n'))
        device.destroy()
        return { result, errors, readbacks: 1 }
    }, { code, inputBase64: Buffer.from(input).toString('base64') })
    const result = index => proof.result.slice(index * 4, index * 4 + 4)
    const sample = (mask, x, y) => result(lookup.get(`${mask}/${x}/${y}`)).slice(0, 2)
    let maximumDistanceError = 0
    for (const [index, probe] of probes.entries()) {
        const expectedDistance = probe.kind === 1 ? probe.p[0]
            : probe.kind === 2 && !legacyBaseline ? neighborhoodDistance(probe.p, probe.masks)
                : polygonDistance(probe.p, probe.mask)
        const [distance, coverage, localDistance] = result(index)
        maximumDistanceError = Math.max(maximumDistanceError, Math.abs(distance - expectedDistance))
        assert.ok(Math.abs(distance - expectedDistance) < 2e-6,
            `mask ${probe.mask} p=${probe.p}: distance ${distance} != ${expectedDistance}`)
        const t = Math.max(0, Math.min(1, expectedDistance / 0.25))
        assert.ok(Math.abs(coverage - t * t * (3 - 2 * t)) < 3e-6,
            `mask ${probe.mask} p=${probe.p}: quarter-texel coverage ${coverage}`)
        assert.ok(coverage >= 0 && coverage <= 1)
        if (expectedDistance <= 0) assert.equal(coverage, 0)
        if (expectedDistance >= 0.25) assert.equal(coverage, 1)
        if (probe.kind === 2) {
            assert.ok(Math.abs(localDistance - polygonDistance(probe.p, probe.mask)) < 2e-6,
                'The control remains the old cell-local distance')
            if (!legacyBaseline) {
                assert.ok(Math.abs(distance) <= 0.350001, 'Neighborhood distance is explicitly truncated')
                for (const width of coverageWidths) assert.ok(
                    Math.abs(innerCoverage(distance, width) - innerCoverage(expectedDistance, width)) < 7e-5,
                    `CPU coverage for width ${width} agrees with independently measured geometry`)
            }
        }
    }
    for (let mask = 0; mask < 16; mask++) {
        const rotated = ((mask << 1) | (mask >> 3)) & 15
        const reflected = ((mask & 1) << 1) | ((mask & 2) >> 1) | ((mask & 4) << 1) | ((mask & 8) >> 1)
        for (let y = 0; y <= divisions; y++) for (let x = 0; x <= divisions; x++) {
            const original = sample(mask, x, y)
            for (const transformed of [sample(rotated, divisions - y, x), sample(reflected, divisions - x, y)]) {
                original.forEach((value, channel) => assert.ok(Math.abs(value - transformed[channel]) < 2e-6,
                    `mask ${mask} at ${x},${y}: rotation/reflection symmetry`))
            }
        }
    }
    assert.deepEqual(sample(3, 8, 8), [0, 0], 'Straight top/bottom contour is at half a texel')
    assert.deepEqual(sample(6, 12, 8), [0.25, 1], 'One-texel strip has a fully opaque inner core')
    assert.deepEqual(sample(9, 4, 8), [0.25, 1], 'Opposite strip edge preserves the same core')
    assert.deepEqual(sample(6, 10, 8), [0.125, 0.5], 'Strip feather stays in its quarter-texel band')
    assert.ok(sample(1, 0, 0)[0] > 0.25, 'Isolated source-texel center remains fully inside')
    assert.equal(sample(1, 6, 6)[1], 0, 'Convex corner is chamfered, not blurred outward')
    assert.ok(sample(14, 0, 0)[0] < 0 && sample(14, 12, 12)[0] > 0, 'A dry corner/hole keeps its sign')
    for (const mask of [5, 10]) {
        assert.ok(sample(mask, 8, 8)[0] < -0.35, 'Ambiguous active diagonals must remain disconnected')
        assert.equal(sample(mask, 8, 8)[1], 0)
    }
    const before = result(counterexample.a), after = result(counterexample.b)
    const oldCoverageJump = Math.abs(before[3] - after[3])
    assert.ok(oldCoverageJump > 0.2, 'The old mask3/mask1 control must reproduce the reported opacity jump')
    let maximumSharedEdgeJump = 0
    if (!legacyBaseline) {
        assert.ok(Math.abs(before[0] - Math.sqrt(1 / 32)) < 2e-6, 'The neighboring diagonal is closer than the local straight segment')
        assert.ok(Math.abs(before[0] - after[0]) < 2e-6, 'Counterexample distance is now continuous')
        assert.ok(result(finiteSegmentProbe)[0] < -0.08,
            'An adjacent horizontal segment must not become an infinite line with a false zero')
        for (const { a, b, epsilon } of sharedEdges) {
            const left = result(a)[0], right = result(b)[0]
            assert.ok(Math.abs(left - right) <= 2 * epsilon + 3e-6,
                `Legal shared edge ${a}/${b}: signed distance is continuous and 1-Lipschitz`)
            for (const width of coverageWidths) {
                const jump = Math.abs(innerCoverage(left, width) - innerCoverage(right, width))
                if (epsilon === 0) maximumSharedEdgeJump = Math.max(maximumSharedEdgeJump, jump)
                assert.ok(jump <= 1.5 / width * 2 * epsilon + 8e-5,
                    `Shared-edge coverage for width ${width} must not have a cell seam`)
            }
        }
    }
    console.log(JSON.stringify({ status: legacyBaseline ? 'legacy-discontinuity-confirmed' : 'passed',
        patterns: 16, spatialProbes: 16 * 17 * 17, bandProbes: bandDistances.length,
        exhaustiveVertexPatterns: 65536, neighborhoodProbes: probes.length - originalProbeCount,
        sharedEdgePairs: sharedEdges.length, oldCoverageJump,
        maximumSharedEdgeJump: legacyBaseline ? null : maximumSharedEdgeJump,
        cpuCoverageWidths: coverageWidths, maximumDistanceError, readbacks: proof.readbacks, errors: proof.errors }))
} finally {
    await browser?.close()
    await new Promise(resolve => server.close(resolve))
}

// Independent geometry oracle: build crossing segments and active polygons from
// corner bits, then use point-in-polygon plus Euclidean segment distance. It does
// not duplicate the production shader's 16-case signed-distance switch.
function polygonDistance(point, mask) {
    if (mask === 0) return -1
    if (mask === 15) return 1
    const active = corners.map((_point, index) => (mask & (1 << index)) !== 0)
    const crossing = edgeCenters.flatMap((point, index) => active[index] !== active[(index + 1) % 4] ? [point] : [])
    const segments = [], polygons = []
    if (crossing.length === 4) {
        for (let index = 0; index < 4; index++) if (active[index]) {
            const before = edgeCenters[(index + 3) % 4], after = edgeCenters[index]
            segments.push([before, after])
            polygons.push([corners[index], after, before])
        }
    } else {
        segments.push(crossing)
        const polygon = []
        for (let index = 0; index < 4; index++) {
            if (active[index]) polygon.push(corners[index])
            if (active[index] !== active[(index + 1) % 4]) polygon.push(edgeCenters[index])
        }
        polygons.push(polygon)
    }
    const distance = Math.min(...segments.map(([a, b]) => {
        const dx = b[0] - a[0], dy = b[1] - a[1]
        const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (dx * dx + dy * dy)))
        return Math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dy)
    }))
    if (distance < 1e-12) return 0
    const inside = polygons.some(polygon => {
        let crossings = 0
        for (let index = 0; index < polygon.length; index++) {
            const a = polygon[index], b = polygon[(index + 1) % polygon.length]
            // Cell-edge probes are inside whenever they touch an active polygon.
            const cross = (point[0] - a[0]) * (b[1] - a[1]) - (point[1] - a[1]) * (b[0] - a[0])
            if (Math.abs(cross) < 1e-12 && point[0] >= Math.min(a[0], b[0]) && point[0] <= Math.max(a[0], b[0]) &&
                point[1] >= Math.min(a[1], b[1]) && point[1] <= Math.max(a[1], b[1])) return true
            if ((a[1] > point[1]) !== (b[1] > point[1]) &&
                point[0] < a[0] + (point[1] - a[1]) * (b[0] - a[0]) / (b[1] - a[1])) crossings++
        }
        return crossings % 2 === 1
    })
    return distance * (inside ? 1 : -1)
}

function neighborhoodMasks(vertices, width, startX = 0, startY = 0) {
    const masks = []
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) {
        const origin = (startY + y) * width + startX + x
        masks.push(vertices[origin] | vertices[origin + 1] << 1 |
            vertices[origin + width + 1] << 2 | vertices[origin + width] << 3)
    }
    return masks
}

function contourSegments(mask) {
    const active = corners.map((_point, index) => (mask & (1 << index)) !== 0)
    const crossing = edgeCenters.flatMap((point, index) => active[index] !== active[(index + 1) % 4] ? [point] : [])
    if (crossing.length === 0) return []
    if (crossing.length === 2) return [crossing]
    return active.flatMap((inside, index) => inside ? [[edgeCenters[(index + 3) % 4], edgeCenters[index]]] : [])
}

function neighborhoodDistance(point, masks) {
    const sign = Math.sign(polygonDistance(point, masks[4]))
    if (sign === 0) return 0
    let squaredDistance = 0.35 ** 2
    for (let index = 0; index < 9; index++) {
        const x = index % 3 - 1, y = Math.floor(index / 3) - 1
        for (const [start, end] of segmentsByMask[masks[index]]) {
            // Translate actual finite segments into the common query coordinate
            // system; never evaluate signed/local formulas outside their cell.
            const a = [start[0] + x, start[1] + y], b = [end[0] + x, end[1] + y]
            const dx = b[0] - a[0], dy = b[1] - a[1]
            const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (dx * dx + dy * dy)))
            squaredDistance = Math.min(squaredDistance, (point[0] - a[0] - t * dx) ** 2 + (point[1] - a[1] - t * dy) ** 2)
        }
    }
    return sign * Math.sqrt(squaredDistance)
}

function innerCoverage(distance, width) {
    const t = Math.max(0, Math.min(1, distance / width))
    return t * t * (3 - 2 * t)
}
