import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { chromium } from 'playwright'
import { WebMercatorQuad, tileMatrixCoverage, webMercatorVirtualRasterField } from 'geoscratch/geo'
import { temporalVelocityWgslModule } from '../../examples/flowField/temporal-velocity-raster.ts'
import { flowScreenProjectionWgsl } from '../../examples/flowField/flow-screen-projection.ts'

const read = name => readFile(new URL(`../../examples/flowField/shaders/${name}.wgsl`, import.meta.url), 'utf8')
const [wrapper, distance, activity, sdf, presentation, history, support] = await Promise.all([
    'temporal-velocity', 'boundary-distance', 'boundary-activity', 'boundary-sdf', 'presentation', 'history', 'presentation-support',
].map(read))
const model = webMercatorVirtualRasterField({
    id: 'boundary-sdf-proof', addressSpaceId: 'boundary-sdf-proof-space', sourceRevision: 'v1',
    coverage: tileMatrixCoverage({ tileMatrixSet: WebMercatorQuad, limits: [
        { matrixId: '1', minTileRow: 0, maxTileRow: 0, minTileCol: 0, maxTileCol: 1 },
    ] }),
    geographicBounds: [-179.9, 0, 179.9, 85], coordinateBits: 52,
    fieldKind: 'vector', channels: 2, sampleType: 'float32', gpuFormat: 'rg32float', interpolation: 'linear',
})
const temporal = temporalVelocityWgslModule(model, model, { group: 1,
    currentPageTableBinding: 0, currentAtlasBinding: 1, nextPageTableBinding: 2, nextAtlasBinding: 3,
    sampleRegistration: 'pixel-center', activitySupport: 'nearest-texel-zero', wrapper })
const uniformStruct = history.match(/struct FlowFieldHistoryUniform \{[\s\S]*?\n\};/)?.[0]
assert.ok(uniformStruct, 'Use the actual history uniform ABI')
const code = [temporal.code, flowScreenProjectionWgsl(model.addressCodec), uniformStruct, support, distance, activity, sdf].join('\n')
const width = 128, height = 64, byteLength = width * height * 4
const texelQuanta = model.addressCodec.worldQuanta / 512n
const texelMeters = Number(texelQuanta) * model.addressCodec.quantumMeters
const position = (x, y) => model.addressCodec.fromWorldQuanta([
    BigInt(Math.round(x * Number(texelQuanta))), BigInt(Math.round(y * Number(texelQuanta))),
])
const camera = position(256, 65).fixed.limbs.flatMap(axis => [axis.low, axis.high])
const table = new Uint32Array(model.addressSpace.pageTableEntryCount * 8)
let rightEntry
for (const col of [0, 1]) {
    const compact = model.addressCodec.address(position(col * 256 + 0.5, 65.5), '1').compactIndex
    assert.notEqual(compact, undefined)
    table.set([1 - col, 0, 0, 1, 0, 0, 0, 0], compact * 8)
    if (col === 1) rightEntry = compact
}
const atlasCache = new Map()
// Observed t23/t24 z10/416/856 texel (103,167) velocities, embedded in a
// synthetic UNIFORM atlas. This tests their display semantics, not screenshot
// geography or the spatial structure of the original source page.
const representativeT23 = {
    lower: [0.7833012938499451, -0.33850356936454773],
    upper: [-0.620028018951416, 0.26816967129707336],
    kill: 3.6185970390454907 * 0.0005,
}
function atlas(kind, endpoint) {
    const varies = ['future', 'cancel', 'pair-before', 'pair-after', 'uniform-growth', 'tiny-alpha-zero-owner', 'quantum-zero-owner', 'representative-t23-t24'].includes(kind)
    const key = `${kind}:${varies ? endpoint : 0}`
    if (atlasCache.has(key)) return atlasCache.get(key)
    const pixels = new Float32Array(512 * 256 * 2)
    for (let y = 0; y < 256; y++) for (let x = 0; x < 512; x++) {
        const atlasX = (1 - Math.floor(x / 256)) * 256 + x % 256
        pixels.set(storedVector(kind, endpoint, x, y), (y * 512 + atlasX) * 2)
    }
    const result = [...pixels]
    atlasCache.set(key, result)
    return result
}
function storedVelocity(kind, endpoint, x, y) {
    if (kind === 'uniform-slow') return 2
    if (kind === 'uniform-at-kill') return 1
    if (kind === 'uniform-zero-kill') return 0.5
    if (kind === 'zero') return 0
    if (kind === 'uniform-growth') return endpoint === 0 ? 0 : 10
    if (kind === 'pair-before') return endpoint === 0 ? 100 : 1.25
    if (kind === 'pair-after') return endpoint === 0 ? 1.25 : -50
    if (kind === 'spatial-cancel') return x < 256 ? 2 : -2
    if (kind === 'tiny-alpha-zero-owner') {
        return endpoint === 0 ? (x < 256 ? 2 : -2) : (x === 256 && y === 65 ? 0 : 1e8)
    }
    if (kind === 'quantum-zero-owner') {
        return endpoint === 0 ? (x < 256 ? 2 : -2) : (x === 255 && y === 65 ? 0 : 1e8)
    }
    if (kind === 'junction-low') return y === 64 && (x === 255 || x === 256) ? 2.5 : 0
    if (kind === 'junction') return y === 64 && (x === 255 || x === 256) ? 2 : 0
    let velocity = x === 256 || x === 258 || (x === 254 && y === 65) ? 0 : 2
    if (kind === 'future' && endpoint === 1 && x === 256) velocity = 2
    if (kind === 'cancel' && endpoint === 1) velocity = -velocity
    return velocity
}
function storedVector(kind, endpoint, x, y) {
    if (kind === 'representative-t23-t24') return endpoint === 0 ? representativeT23.lower : representativeT23.upper
    return [storedVelocity(kind, endpoint, x, y), 0]
}
const epsilon = 1 / 4096
const coverageProbes = [
    { name: 'junction-left', x: 256.5 - epsilon, y: 64.75 },
    { name: 'junction-edge', x: 256.5, y: 64.75 },
    { name: 'junction-right', x: 256.5 + epsilon, y: 64.75 },
    { name: 'physical-page-left', x: 256 - epsilon, y: 64.875 },
    { name: 'physical-page-right', x: 256 + epsilon, y: 64.875 },
    { name: 'far-unknown-halo', x: 255.125, y: 64.5625 },
    { name: 'near-unknown-halo', x: 255.8, y: 64.875 },
    { name: 'spatial-cancel-zero', x: 256, y: 64.875 },
    { name: 'spatial-cancel-partial', x: 256 + 1 / 2048, y: 64.875 },
    { name: 'nearest-tie-both-axes', x: 256, y: 65 },
    { name: 'last-canonical-quantum-before-tile', x: 256 - 1 / Number(texelQuanta), y: 65,
        quanta: [256n * texelQuanta - 1n, 65n * texelQuanta] },
    { name: 'dry-corner-inside', x: 254.999, y: 65.001 },
    { name: 'dry-corner-outside', x: 255.001, y: 65.001 },
    { name: 'dry-corner-diagonal', x: 255.001, y: 64.999 },
    { name: 'dry-side-inside', x: 254.999, y: 65.1 },
    { name: 'dry-side-outside', x: 255.001, y: 65.1 },
    { name: 'dry-corner-arc-a', x: 255.07, y: 64.76 },
    { name: 'dry-corner-arc-b', x: 255.24, y: 64.93 },
]
const probePositions = coverageProbes.flatMap(probe => (probe.quanta
    ? model.addressCodec.fromWorldQuanta(probe.quanta) : position(probe.x, probe.y)).fixed.limbs
    .flatMap(axis => [axis.low, axis.high]))
const probeCode = code + `
struct CoverageProbeResult { sample: vec4f, registration: vec4f, }
@group(3) @binding(0) var<storage, read> coverageProbes: array<FlowVelocityAddressFixedPosition>;
@group(3) @binding(1) var<storage, read_write> coverageResults: array<CoverageProbeResult>;
@compute @workgroup_size(64)
fn test_boundary_coverage(@builtin(global_invocation_id) id: vec3u) {
    if (id.x >= arrayLength(&coverageProbes)) { return; }
    let position = coverageProbes[id.x];
    let sample = FlowVelocity_sample(position, boundaryUniform.requestedLevel,
        FlowVelocityTemporal(boundaryUniform.progress, boundaryUniform.activityKill));
    let address = FlowVelocityAddress_address(position, FlowVelocityCurrent_matrix[boundaryUniform.requestedLevel]);
    let offset = address.sub_texel - vec2f(0.5);
    coverageResults[id.x] = CoverageProbeResult(
        vec4f(FlowBoundary_coverage(position), f32(sample.status), sample.speed, f32(sample.resolved_level)),
        vec4f(address.sub_texel.x, fract(offset.x), -floor(offset.x), f32(address.texel.x)));
}`
// Fixed synthetic hard ink, including exact transparent holes. It is never
// mutated between field fixtures or A/B/A; this isolates final display policy.
const ink = new Uint8Array(byteLength)
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if ((x + y * 3) % 11 !== 0) ink.set([32 + x % 64, 128 + y, 210, 192], (y * width + x) * 4)
}
const cases = [
    { name: 'resident-strip-and-hole', kind: 'same', alpha: 0.277 },
    { name: 'future-alpha-zero', kind: 'future', alpha: 0 },
    { name: 'future-alpha-0277', kind: 'future', alpha: 0.277 },
    { name: 'opposite-cancellation', kind: 'cancel', alpha: 0.5 },
    { name: 'unknown-neighbor', kind: 'same', alpha: 0.277, missing: true },
    { name: 'resident-shared-edge', kind: 'junction', alpha: 0.277 },
    { name: 'lazy-unknown-halo', kind: 'junction', alpha: 0.277, missing: true },
    { name: 'shared-edge-narrow-feather', kind: 'junction', alpha: 0.277, feather: 0.05 },
    { name: 'shared-edge-wide-feather', kind: 'junction', alpha: 0.277, feather: 0.35 },
    { name: 'uniform-two-k-supported', kind: 'uniform-slow', alpha: 0.277, kill: 1 },
    { name: 'zero-kill-valid-moving', kind: 'uniform-zero-kill', alpha: 0.277, kill: 0 },
    { name: 'zero-kill-exact-zero', kind: 'zero', alpha: 0.277, kill: 0 },
    { name: 'spatial-cancel-saturated-centers', kind: 'spatial-cancel', alpha: 0.277, kill: 0.001 },
    { name: 'shared-sample-before', kind: 'pair-before', alpha: 1, kill: 1 },
    { name: 'shared-sample-after', kind: 'pair-after', alpha: 0, kill: 1 },
    { name: 'unknown-halo-no-point-cap', kind: 'junction-low', alpha: 0.277, kill: 1, missing: true },
    { name: 'uniform-growth-quarter', kind: 'uniform-growth', alpha: 0.25, kill: 1 },
    { name: 'uniform-growth-half', kind: 'uniform-growth', alpha: 0.5, kill: 1 },
    { name: 'uniform-growth-three-quarter', kind: 'uniform-growth', alpha: 0.75, kill: 1 },
    { name: 'tiny-alpha-zero-owner-fast-path', kind: 'tiny-alpha-zero-owner', alpha: 1e-9, kill: 0 },
    { name: 'pre-cancellation-supported', kind: 'cancel', alpha: 0.49 },
    { name: 'post-cancellation-reappearance', kind: 'cancel', alpha: 0.51 },
    { name: 'canonical-quantum-zero-owner', kind: 'quantum-zero-owner', alpha: 1e-9, kill: 0 },
    { name: 'uniform-at-kill-supported', kind: 'uniform-at-kill', alpha: 0.277, kill: 1 },
    { name: 'representative-t23-t24-uniform', kind: 'representative-t23-t24', alpha: 0.54772, kill: representativeT23.kill },
    { name: 'owner-hole-wide', kind: 'same', alpha: 0.95294, feather: 0.35 },
].map(fixture => {
    const bytes = new Uint8Array(352)
    const uniform = new DataView(bytes.buffer)
    // Source window x=[252,260], y=[63,67], with sixteen output pixels/texel.
    uniform.setFloat32(160, texelMeters * 4, true)
    uniform.setFloat32(180, texelMeters * 2, true)
    uniform.setFloat32(200, -2, true)
    uniform.setFloat32(220, 1, true)
    camera.forEach((limb, index) => uniform.setUint32(304 + index * 4, limb, true))
    uniform.setFloat32(320, 1, true)
    uniform.setFloat32(332, fixture.alpha, true)
    uniform.setFloat32(336, fixture.kill ?? 0.000001, true)
    uniform.setFloat32(340, fixture.feather ?? 0.25, true)
    const pages = table.slice()
    if (fixture.missing) pages[rightEntry * 8 + 3] = 0
    return { ...fixture, uniform: [...bytes], pages: [...pages], atlases: [atlas(fixture.kind, 0), atlas(fixture.kind, 1)] }
})
const server = createServer((_request, response) => response.end('<!doctype html><title>Flow boundary SDF presentation proof</title>'))
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let browser
try {
    browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu'] })
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    const proof = await page.evaluate(async ({ code, probeCode, probePositions, presentation, cases, ink, width, height }) => {
        const adapter = await navigator.gpu.requestAdapter()
        if (!adapter) throw new Error('WebGPU adapter unavailable')
        const device = await adapter.requestDevice()
        const errors = []
        device.addEventListener('uncapturederror', event => errors.push(event.error.message))
        device.pushErrorScope('validation')
        const owned = []
        const buffer = (data, usage) => {
            const value = device.createBuffer({ size: data.byteLength, usage: usage | GPUBufferUsage.COPY_DST })
            device.queue.writeBuffer(value, 0, data)
            owned.push(value)
            return value
        }
        const texture = (size, format, pixels, bytesPerRow) => {
            const value = device.createTexture({ size, format,
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC })
            device.queue.writeTexture({ texture: value }, pixels, { bytesPerRow }, size)
            owned.push(value)
            return value
        }
        const history = texture([width, height], 'rgba8unorm', new Uint8Array(ink), width * 4)
        const fieldVisibility = GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE
        const uniformLayout = device.createBindGroupLayout({ entries: [
            { binding: 0, visibility: fieldVisibility, buffer: { type: 'uniform' } },
        ] })
        const temporalLayout = device.createBindGroupLayout({ entries: [
            { binding: 0, visibility: fieldVisibility, buffer: { type: 'read-only-storage' } },
            { binding: 1, visibility: fieldVisibility, texture: { sampleType: 'unfilterable-float' } },
            { binding: 2, visibility: fieldVisibility, buffer: { type: 'read-only-storage' } },
            { binding: 3, visibility: fieldVisibility, texture: { sampleType: 'unfilterable-float' } },
        ] })
        const historyLayout = device.createBindGroupLayout({ entries: [
            { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        ] })
        const historyGroup = device.createBindGroup({ layout: historyLayout,
            entries: [{ binding: 0, resource: history.createView() }] })
        async function pipeline(source, layouts) {
            const module = device.createShaderModule({ code: source })
            const compilation = (await module.getCompilationInfo()).messages.filter(message => message.type === 'error')
            if (compilation.length) throw new Error(compilation.map(message => message.message).join('\n'))
            return await device.createRenderPipelineAsync({
                layout: device.createPipelineLayout({ bindGroupLayouts: layouts }),
                vertex: { module, entryPoint: 'vMain' },
                // Unblended target exposes the actual fragment RGBA. Production
                // applies its ordinary Surface source-alpha blend afterward.
                fragment: { module, entryPoint: 'fMain', targets: [{ format: 'rgba8unorm' }] },
                primitive: { topology: 'triangle-strip' },
            })
        }
        const hard = await pipeline(presentation, [historyLayout])
        const soft = await pipeline(code, [uniformLayout, temporalLayout, historyLayout])
        const probeLayout = device.createBindGroupLayout({ entries: [
            { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
            { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        ] })
        const probeModule = device.createShaderModule({ code: probeCode })
        const probeErrors = (await probeModule.getCompilationInfo()).messages.filter(message => message.type === 'error')
        if (probeErrors.length) throw new Error(probeErrors.map(message => message.message).join('\n'))
        const probePipeline = await device.createComputePipelineAsync({
            layout: device.createPipelineLayout({ bindGroupLayouts: [uniformLayout, temporalLayout, historyLayout, probeLayout] }),
            compute: { module: probeModule, entryPoint: 'test_boundary_coverage' },
        })
        const positions = buffer(new Uint32Array(probePositions), GPUBufferUsage.STORAGE)
        const probeCount = probePositions.length / 4, probeBytes = probeCount * 32
        const size = width * height * 4
        const probeOffset = size * (cases.length * 3 + 1)
        const readback = device.createBuffer({ size: probeOffset + cases.length * probeBytes,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
        const encoder = device.createCommandEncoder()
        for (const [caseIndex, fixture] of cases.entries()) {
            const config = buffer(new Uint8Array(fixture.uniform), GPUBufferUsage.UNIFORM)
            const tables = [0, 1].map(() => buffer(new Uint32Array(fixture.pages), GPUBufferUsage.STORAGE))
            const atlases = fixture.atlases.map(pixels => texture([512, 256], 'rg32float', new Float32Array(pixels), 4096))
            const uniformGroup = device.createBindGroup({ layout: uniformLayout,
                entries: [{ binding: 0, resource: { buffer: config } }] })
            const temporalGroup = device.createBindGroup({ layout: temporalLayout, entries: [
                { binding: 0, resource: { buffer: tables[0] } }, { binding: 1, resource: atlases[0].createView() },
                { binding: 2, resource: { buffer: tables[1] } }, { binding: 3, resource: atlases[1].createView() },
            ] })
            for (let variant = 0; variant < 3; variant++) {
                const target = device.createTexture({ size: [width, height], format: 'rgba8unorm',
                    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC })
                owned.push(target)
                const pass = encoder.beginRenderPass({ colorAttachments: [{ view: target.createView(),
                    loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] })
                pass.setPipeline(variant === 1 ? soft : hard)
                if (variant === 1) {
                    pass.setBindGroup(0, uniformGroup)
                    pass.setBindGroup(1, temporalGroup)
                    pass.setBindGroup(2, historyGroup)
                } else pass.setBindGroup(0, historyGroup)
                pass.draw(4)
                pass.end()
                encoder.copyTextureToBuffer({ texture: target }, { buffer: readback,
                    offset: (caseIndex * 3 + variant) * size, bytesPerRow: width * 4 }, [width, height])
            }
            const probeOutput = buffer(new Uint8Array(probeBytes), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC)
            const probeGroup = device.createBindGroup({ layout: probeLayout, entries: [
                { binding: 0, resource: { buffer: positions } }, { binding: 1, resource: { buffer: probeOutput } },
            ] })
            const pass = encoder.beginComputePass()
            pass.setPipeline(probePipeline)
            pass.setBindGroup(0, uniformGroup)
            pass.setBindGroup(1, temporalGroup)
            pass.setBindGroup(2, historyGroup)
            pass.setBindGroup(3, probeGroup)
            pass.dispatchWorkgroups(Math.ceil(probeCount / 64))
            pass.end()
            encoder.copyBufferToBuffer(probeOutput, 0, readback, probeOffset + caseIndex * probeBytes, probeBytes)
        }
        encoder.copyTextureToBuffer({ texture: history }, { buffer: readback,
            offset: cases.length * 3 * size, bytesPerRow: width * 4 }, [width, height])
        device.queue.submit([encoder.finish()])
        await readback.mapAsync(GPUMapMode.READ)
        const bytes = new Uint8Array(readback.getMappedRange())
        const outputs = cases.map((_fixture, index) => [0, 1, 2].map(variant =>
            Array.from(bytes.slice((index * 3 + variant) * size, (index * 3 + variant + 1) * size))))
        const raw = Array.from(bytes.slice(cases.length * 3 * size, probeOffset))
        const coverageValues = new Float32Array(bytes.buffer, probeOffset, cases.length * probeCount * 8)
        const coverage = cases.map((_fixture, index) => Array.from({ length: probeCount }, (_, probe) =>
            Array.from(coverageValues.slice((index * probeCount + probe) * 8, (index * probeCount + probe + 1) * 8))))
        readback.unmap()
        readback.destroy()
        owned.forEach(resource => resource.destroy())
        const validation = await device.popErrorScope()
        if (validation) throw new Error(validation.message)
        if (errors.length) throw new Error(errors.join('\n'))
        device.destroy()
        return { outputs, raw, coverage, errors, readbacks: 1 }
    }, { code, probeCode, probePositions, presentation, cases, ink: [...ink], width, height })
    const expectedInk = [...ink]
    assert.deepEqual(proof.raw, expectedInk, 'B never writes soft coverage into raw history')
    const summaries = []
    for (const [index, fixture] of cases.entries()) {
        const [a, b, again] = proof.outputs[index]
        assert.deepEqual(a, expectedInk, `${fixture.name}: A copies original raw ink`)
        assert.deepEqual(again, a, `${fixture.name}: A/B/A is byte-identical`)
        let reduced = 0
        for (let offset = 0; offset < byteLength; offset += 4) {
            assert.deepEqual(b.slice(offset, offset + 3), a.slice(offset, offset + 3), `${fixture.name}: unchanged RGB`)
            assert.ok(b[offset + 3] <= a[offset + 3], `${fixture.name}: inner coverage never adds opacity`)
            if (a[offset + 3] === 0) assert.deepEqual(b.slice(offset, offset + 4), [0, 0, 0, 0])
            if (b[offset + 3] < a[offset + 3]) reduced++
        }
        summaries.push({ name: fixture.name, reducedPixels: reduced })
    }
    const alpha = (caseIndex, x, y) => proof.outputs[caseIndex][1][(y * width + x) * 4 + 3]
    const rawAlpha = (x, y) => ink[(y * width + x) * 4 + 3]
    for (let x = 84; x <= 91; x++) assert.equal(alpha(0, x, 20), rawAlpha(x, 20), 'One-cell strip opaque core survives')
    assert.ok(alpha(0, 80, 20) < rawAlpha(80, 20), 'A straight source-texel edge has an inward feather')
    assert.ok(rawAlpha(73, 20) > 0, 'The temporal support probe must contain original ink')
    assert.equal(alpha(1, 73, 20), 0, 'Future-only source texel is unsupported at alpha zero')
    const futurePixel = { x: 252 + 73.5 / 16, y: 63 + 20.5 / 16 }
    const futureCoverage = coverageOracle(cases[2], futurePixel)
    assert.ok(alpha(2, 73, 20) > 0 && alpha(2, 73, 20) < rawAlpha(73, 20),
        'A newly active source texel now has continuous coverage, not immediate full opacity')
    assert.ok(Math.abs(alpha(2, 73, 20) - rawAlpha(73, 20) * futureCoverage) <= 1,
        'Actual fragment output integrates current alpha .277 support')
    assert.ok(alpha(3,88,20)>0,'Existing interior ink survives zero current velocity; particles still use actual velocity')
    assert.equal(alpha(3,73,20),0,'A stored-zero owning footprint remains empty in both endpoint fields')
    for (let x = 56; x <= 71; x++) assert.equal(alpha(4, x, 20), rawAlpha(x, 20),
        'Missing neighbor across reversed atlas seam falls back to unchanged A')
    assert.ok(summaries[0].reducedPixels > 100, 'B must be a nontrivial boundary presentation')
    let maximumCoverageError = 0
    for (const [index, fixture] of cases.entries()) {
        if (fixture.missing) continue
        for (const [probeIndex, probe] of coverageProbes.entries()) {
            const [coverage, status, _speed, resolved] = proof.coverage[index][probeIndex]
            const expected = coverageOracle(fixture, probe)
            maximumCoverageError = Math.max(maximumCoverageError, Math.abs(coverage - expected))
            assert.equal(status, 1, `${fixture.name}/${probe.name}: real same-level VT sample`)
            assert.equal(resolved, 0)
            assert.ok(Math.abs(coverage - expected) < 4e-5,
                `${fixture.name}/${probe.name}: coverage ${coverage} != independent square-union oracle ${expected}`)
        }
    }
    for (const index of [5, 7, 8]) {
        const left = proof.coverage[index][0][0], right = proof.coverage[index][2][0]
        assert.ok(Math.abs(left - right) < 1.5 / (cases[index].feather ?? 0.25) * 2 * epsilon + 5e-5,
            `${cases[index].name}: no old mask3/mask1 coverage jump across the source-center boundary`)
        assert.ok(Math.abs(proof.coverage[index][3][0] - proof.coverage[index][4][0]) < 4e-5,
            `${cases[index].name}: reverse physical atlas slots must not introduce a page seam`)
    }
    const knownFar = proof.coverage[5][5], missingFar = proof.coverage[6][5]
    assert.ok(knownFar[0] > 0 && knownFar[0] < 1, 'Far-halo probe must exercise actual feathering')
    assert.equal(missingFar[1], 1, 'The center footprint itself remains resident')
    assert.ok(missingFar[2] > 0, 'Far-halo support must not be a trivial dry sample')
    assert.ok(Math.abs(missingFar[0] - coverageOracle(cases[5], coverageProbes[5])) < 4e-5,
        'An unrelated missing cell beyond the .35 band must not replace B with A')
    assert.ok(proof.coverage[5][6][0] < 1, 'Known nearby halo produces a nontrivial distance')
    assert.ok(proof.coverage[6][6][1]!==1, 'A relevant square across the page edge also belongs to the actual sampled footprint')
    assert.equal(proof.coverage[6][6][0], 1, 'Relevant unknown halo falls back to unmodified A')
    const widthCoverage = [7, 5, 8].map(index => ({ width: cases[index].feather ?? 0.25,
        coverage: proof.coverage[index][3][0] }))
    assert.equal(widthCoverage[0].coverage, 1, 'Distance .125 is fully inside the .05 band')
    assert.ok(widthCoverage[0].coverage > widthCoverage[1].coverage &&
        widthCoverage[1].coverage > widthCoverage[2].coverage, 'Wider feather changes actual source-aligned display coverage')
    const indexOf = name => cases.findIndex(fixture => fixture.name === name)
    const slow = indexOf('uniform-two-k-supported')
    for (const observed of proof.coverage[slow]) assert.equal(observed[0], 1,
        'Uniform persistent motion at 2k is supported, not a global low-opacity hole')
    assert.deepEqual(proof.outputs[slow][1], expectedInk, 'Uniform 2k interior retains all original ink')
    const atKill = indexOf('uniform-at-kill-supported')
    for (const observed of proof.coverage[atKill]) assert.equal(observed[0], 1,
        'The existing nonzero speed>=kill equality remains legal')
    assert.deepEqual(proof.outputs[atKill][1], expectedInk)
    assert.deepEqual(proof.outputs[indexOf('zero-kill-valid-moving')][1], expectedInk,
        'Kill zero with valid motion must not call undefined smoothstep(0,0,...)')
    for (const observed of proof.coverage[indexOf('zero-kill-exact-zero')]) assert.equal(observed[0], 0,
        'Kill zero still excludes exact zero velocity')
    const spatial = proof.coverage[indexOf('spatial-cancel-saturated-centers')]
    assert.equal(spatial[7][0], 1, 'A supported source interior retains finite ink through spatial cancellation')
    assert.equal(spatial[7][2], 0)
    assert.ok(spatial[8][2] > 0.001 && spatial[8][2] < 0.004)
    assert.equal(spatial[8][0], 1, 'Supported interior speed above kill is not dimmed merely for falling below 4k')
    const tiny = proof.coverage[indexOf('tiny-alpha-zero-owner-fast-path')][9]
    assert.equal(tiny[1], 1)
    assert.equal(tiny[2], 0, 'The actual sampler gates the zero next BR owner at both .5 registration ties')
    assert.equal(tiny[0], 1, 'The supported lower endpoint retains history at tiny alpha without changing actual zero velocity')
    const quantum = proof.coverage[indexOf('canonical-quantum-zero-owner')][10]
    assert.equal(quantum[4], 1, 'The actual wide-fixed fraction rounds to f32 one')
    assert.equal(quantum[5], 0.5, 'Rounded registration alone would incorrectly choose the next texel')
    assert.ok(quantum[6] === 0 && quantum[7] === 255, 'Integer owning corner preserves the original left-tile texel')
    assert.equal(quantum[1], 1)
    assert.equal(quantum[2], 0, 'The real sampler retains the canonical zero owner despite the rounded fraction')
    assert.equal(quantum[0], 1, 'The supported lower endpoint retains history; upper zero ownership still governs actual motion')
    assert.deepEqual(proof.outputs[indexOf('shared-sample-before')][1], proof.outputs[indexOf('shared-sample-after')][1],
        'Shared-sample B pixels do not depend on the other time endpoint amplitude/direction')
    assert.deepEqual(proof.coverage[indexOf('shared-sample-before')], proof.coverage[indexOf('shared-sample-after')])
    assert.deepEqual(proof.outputs[indexOf('shared-sample-before')][1], expectedInk,
        'A weak shared sample at 1.25k stays fully supported regardless of its other neighbor')
    const unknownLow = proof.coverage[indexOf('unknown-halo-no-point-cap')][6]
    assert.ok(unknownLow[1]!==1, 'Unknown neighbor makes the actual common-level sample unavailable')
    assert.equal(unknownLow[0], 1, 'Unknown halo must still fall back to A without inferring dry support')
    const growth = ['uniform-growth-quarter', 'uniform-growth-half', 'uniform-growth-three-quarter'].map(name => {
        const index = indexOf(name), expected = cases[index].alpha
        for (const observed of proof.coverage[index]) assert.equal(observed[0], expected,
            `${name}: a whole-region birth must fade continuously rather than switch at q=.5`)
        return { progress: expected, coverage: proof.coverage[index][0][0] }
    })
    const beforeCancellation = proof.coverage[indexOf('pre-cancellation-supported')]
    const afterCancellation = proof.coverage[indexOf('post-cancellation-reappearance')]
    assert.deepEqual(proof.outputs[indexOf('pre-cancellation-supported')][1], proof.outputs[0][1],
        'Two supported endpoints keep the original spatial boundary while current velocity remains legal')
    assert.deepEqual(proof.outputs[indexOf('post-cancellation-reappearance')][1], proof.outputs[0][1])
    beforeCancellation.forEach((observed, index) => assert.ok(Math.abs(observed[0] - afterCancellation[index][0]) < 4e-5,
        'Symmetric recovery after real cancellation restores persistent support without a global opacity fade'))
    const representativeIndex = indexOf('representative-t23-t24-uniform')
    const representative = proof.coverage[representativeIndex]
    for (const observed of representative) {
        assert.equal(observed[0], 1, 'Representative opposed t23/t24 endpoints must not dim their supported interior')
        assert.ok(observed[2] / representativeT23.kill > 8.7 && observed[2] / representativeT23.kill < 8.9,
            'The synthetic atlas uses the observed still-legal roughly 8.8k vector mixture')
    }
    assert.deepEqual(proof.outputs[representativeIndex][1], expectedInk)
    const hole=proof.coverage[indexOf('owner-hole-wide')]
    assert.equal(hole[11][0],0,'The complete dry owner square remains empty')
    assert.ok(hole[12][0]>0 && hole[12][0]<.0001,'Corner outside must approach zero, not jump from 0 to 1')
    assert.ok(hole[13][0]>0 && hole[13][0]<.0001,'Diagonal corner uses distance to the actual square vertex')
    assert.equal(hole[14][0],0)
    assert.ok(hole[15][0]>0 && hole[15][0]<.0001,'Dry side must not retain the former 0-to-.906 jump')
    assert.ok(Math.abs(hole[16][0]-hole[17][0])<1e-5,'Equal-radius samples around a dry corner have equal coverage')
    assert.ok(Math.abs(hole[16][0]-smoothUnit(.25/.35))<1e-5)
    console.log(JSON.stringify({ status: 'passed', cases: summaries, realVirtualRaster: true,
        reversedAtlasPages: 2, rawHistoryUnchanged: true, coverageProbeCount: cases.length * coverageProbes.length,
        maximumCoverageError, widthCoverage, futureCoverage, uniformGrowth: growth,
        dryCorner:hole.slice(11).map((sample,index)=>({name:coverageProbes[11+index].name,coverage:sample[0],status:sample[1]})),
        representativeSourceVelocitiesInUniformAtlas: { speed: representative[0][2], speedOverKill: representative[0][2] / representativeT23.kill, coverage: representative[0][0] },
        lazyUnknownHalo: { knownFar: knownFar[0], missingFar: missingFar[0],
            nearFallback: proof.coverage[6][6][0] }, readbacks: proof.readbacks, errors: proof.errors }))
} finally {
    await browser?.close()
    await new Promise(resolve => server.close(resolve))
}

function coverageOracle(fixture, probe) {
    const { x, y } = probe, ownerX=Math.floor(x), ownerY=Math.floor(y)
    const point=[Math.fround(x-ownerX),Math.fround(y-ownerY)]
    const progress=Math.fround(fixture.alpha), kill=Math.fround(fixture.kill??0.000001)
    const weights=[]
    for(let row=-1;row<=1;row++) for(let col=-1;col<=1;col++) {
        weights.push(supportWeightOracle(storedVector(fixture.kind,0,ownerX+col,ownerY+row),
            storedVector(fixture.kind,1,ownerX+col,ownerY+row),progress,kill))
    }
    // Independent integration over the full threshold partition. Each active
    // sample occupies its original square; no second current-velocity gate.
    const thresholds=[...new Set([0,1,...weights])].sort((a,b)=>a-b)
    let coverage=0
    for(let index=1;index<thresholds.length;index++) {
        const threshold=(thresholds[index]+thresholds[index-1])/2
        coverage+=(thresholds[index]-thresholds[index-1])*
            binaryCoverageOracle(point,weights.map(q=>q>=threshold),fixture.feather??0.25)
    }
    return coverage
}

function binaryCoverageOracle(point, wet, feather) {
    if(!wet[4]) return 0
    let distance=Infinity
    for(let index=0;index<9;index++) {
        if(wet[index]) continue
        const left=index%3-1,top=Math.floor(index/3)-1
        // Nearest point in a closed rectangle, independent of the WGSL helper.
        const nearest=[Math.max(left,Math.min(left+1,point[0])),
            Math.max(top,Math.min(top+1,point[1]))]
        distance=Math.min(distance,Math.hypot(point[0]-nearest[0],point[1]-nearest[1]))
    }
    return smoothUnit(distance/Math.max(.05,Math.min(.35,feather)))
}

function smoothUnit(value) {
    const t = Math.max(0, Math.min(1, value))
    return t * t * (3 - 2 * t)
}

function endpointSupport(speed, kill) {
    return Number(speed > 0 && speed >= kill)
}

function supportWeightOracle(lower, upper, progress, kill) {
    const s0 = Math.hypot(...lower), s1 = Math.hypot(...upper)
    const a0 = endpointSupport(s0, kill), a1 = endpointSupport(s1, kill)
    if (progress <= 0) return a0
    if (progress >= 1) return a1
    if (a0 && a1) return 1
    if (!a0 && !a1) return 0
    const expected = Math.max(s0 - kill, 0) * (1 - progress) + Math.max(s1 - kill, 0) * progress
    if (expected <= 0) return 0
    const interpolated = lower.map((value, channel) => value * (1 - progress) + upper[channel] * progress)
    const excess = Math.max(Math.hypot(...interpolated) - kill, 0)
    return Math.max(0, Math.min(1, (a0 * (1 - progress) + a1 * progress) * smoothUnit(excess / expected / 0.15)))
}
