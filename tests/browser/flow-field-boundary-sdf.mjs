import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { chromium } from 'playwright'
import { WebMercatorQuad, tileMatrixCoverage, webMercatorVirtualRasterField } from 'geoscratch/geo'
import { temporalVelocityWgslModule } from '../../examples/flowField/temporal-velocity-raster.ts'
import { flowScreenProjectionWgsl } from '../../examples/flowField/flow-screen-projection.ts'

const read = name => readFile(new URL(`../../examples/flowField/shaders/${name}.wgsl`, import.meta.url), 'utf8')
const [wrapper, distance, activity, sdf, presentation, history] = await Promise.all([
    'temporal-velocity', 'boundary-distance', 'boundary-activity', 'boundary-sdf', 'presentation', 'history',
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
const code = [temporal.code, flowScreenProjectionWgsl(model.addressCodec), uniformStruct, distance, activity, sdf].join('\n')
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
function atlas(kind, endpoint) {
    const varies = ['future', 'cancel', 'pair-before', 'pair-after', 'uniform-growth', 'tiny-alpha-zero-owner', 'quantum-zero-owner'].includes(kind)
    const key = `${kind}:${varies ? endpoint : 0}`
    if (atlasCache.has(key)) return atlasCache.get(key)
    const pixels = new Float32Array(512 * 256 * 2)
    for (let y = 0; y < 256; y++) for (let x = 0; x < 512; x++) {
        const velocity = storedVelocity(kind, endpoint, x, y)
        const atlasX = (1 - Math.floor(x / 256)) * 256 + x % 256
        pixels[(y * 512 + atlasX) * 2] = velocity
    }
    const result = [...pixels]
    atlasCache.set(key, result)
    return result
}
function storedVelocity(kind, endpoint, x, y) {
    if (kind === 'uniform-slow') return 2.5
    if (kind === 'uniform-zero-kill') return 0.5
    if (kind === 'zero') return 0
    if (kind === 'uniform-growth') return endpoint === 0 ? 0 : 10
    if (kind === 'pair-before') return endpoint === 0 ? 100 : 2.5
    if (kind === 'pair-after') return endpoint === 0 ? 2.5 : -50
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
const epsilon = 1 / 4096
const coverageProbes = [
    { name: 'junction-left', x: 256.5 - epsilon, y: 64.75 },
    { name: 'junction-edge', x: 256.5, y: 64.75 },
    { name: 'junction-right', x: 256.5 + epsilon, y: 64.75 },
    { name: 'physical-page-left', x: 256 - epsilon, y: 64.875 },
    { name: 'physical-page-right', x: 256 + epsilon, y: 64.875 },
    { name: 'far-unknown-halo', x: 255.125, y: 64.5625 },
    { name: 'near-unknown-halo', x: 255.25, y: 64.5625 },
    { name: 'spatial-cancel-zero', x: 256, y: 64.875 },
    { name: 'spatial-cancel-partial', x: 256 + 1 / 2048, y: 64.875 },
    { name: 'nearest-tie-both-axes', x: 256, y: 65 },
    { name: 'last-canonical-quantum-before-tile', x: 256 - 1 / Number(texelQuanta), y: 65,
        quanta: [256n * texelQuanta - 1n, 65n * texelQuanta] },
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
    { name: 'uniform-slow-no-double-fade', kind: 'uniform-slow', alpha: 0.277, kill: 1 },
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
    { name: 'pre-cancellation-fade', kind: 'cancel', alpha: 0.49 },
    { name: 'post-cancellation-reappearance', kind: 'cancel', alpha: 0.51 },
    { name: 'canonical-quantum-zero-owner', kind: 'quantum-zero-owner', alpha: 1e-9, kill: 0 },
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
    for (let offset = 3; offset < byteLength; offset += 4) assert.equal(proof.outputs[3][1][offset], 0,
        'Opposite endpoints cancel now; endpoint-union support must not survive')
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
                `${fixture.name}/${probe.name}: coverage ${coverage} != independent finite-segment oracle ${expected}`)
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
    assert.equal(proof.coverage[6][6][1], 1, 'Near-halo test isolates a missing neighbor, not the sampled footprint')
    assert.equal(proof.coverage[6][6][0], 1, 'Relevant unknown halo falls back to unmodified A')
    const widthCoverage = [7, 5, 8].map(index => ({ width: cases[index].feather ?? 0.25,
        coverage: proof.coverage[index][3][0] }))
    assert.equal(widthCoverage[0].coverage, 1, 'Distance .125 is fully inside the .05 band')
    assert.ok(widthCoverage[0].coverage > widthCoverage[1].coverage &&
        widthCoverage[1].coverage > widthCoverage[2].coverage, 'Wider feather changes actual source-aligned display coverage')
    const indexOf = name => cases.findIndex(fixture => fixture.name === name)
    const slow = indexOf('uniform-slow-no-double-fade')
    for (const observed of proof.coverage[slow]) assert.equal(observed[0], 0.5,
        'Uniform q=.5 must remain .5, not multiply by point gain into .25')
    for (let offset = 3; offset < byteLength; offset += 4) assert.equal(proof.outputs[slow][1][offset], ink[offset] / 2,
        'Real uniform slow-flow B fragment is half opaque')
    assert.deepEqual(proof.outputs[indexOf('zero-kill-valid-moving')][1], expectedInk,
        'Kill zero with valid motion must not call undefined smoothstep(0,0,...)')
    for (const observed of proof.coverage[indexOf('zero-kill-exact-zero')]) assert.equal(observed[0], 0,
        'Kill zero still excludes exact zero velocity')
    const spatial = proof.coverage[indexOf('spatial-cancel-saturated-centers')]
    assert.equal(spatial[7][0], 0, 'Saturated source-center q must not bypass point-level exact cancellation')
    assert.equal(spatial[7][2], 0)
    assert.ok(spatial[8][0] > 0 && spatial[8][0] < 1 && spatial[8][2] > 0.001 && spatial[8][2] < 0.004,
        'Saturated source-center fast path must use the sampler for sub-four-kill point speed')
    const tiny = proof.coverage[indexOf('tiny-alpha-zero-owner-fast-path')][9]
    assert.equal(tiny[1], 1)
    assert.equal(tiny[2], 0, 'The actual sampler gates the zero next BR owner at both .5 registration ties')
    assert.equal(tiny[0], 0, 'Float-rounded q=1 must not bypass the nearest-zero gate in the opaque fast path')
    const quantum = proof.coverage[indexOf('canonical-quantum-zero-owner')][10]
    assert.equal(quantum[4], 1, 'The actual wide-fixed fraction rounds to f32 one')
    assert.equal(quantum[5], 0.5, 'Rounded registration alone would incorrectly choose the next texel')
    assert.ok(quantum[6] === 0 && quantum[7] === 255, 'Integer owning corner preserves the original left-tile texel')
    assert.equal(quantum[1], 1)
    assert.equal(quantum[2], 0, 'The real sampler retains the canonical zero owner despite the rounded fraction')
    assert.equal(quantum[0], 0, 'The presentation fast path agrees with that canonical zero owner')
    assert.deepEqual(proof.outputs[indexOf('shared-sample-before')][1], proof.outputs[indexOf('shared-sample-after')][1],
        'Shared-sample B pixels do not depend on the other time endpoint amplitude/direction')
    assert.deepEqual(proof.coverage[indexOf('shared-sample-before')], proof.coverage[indexOf('shared-sample-after')])
    const unknownLow = proof.coverage[indexOf('unknown-halo-no-point-cap')][6]
    assert.equal(unknownLow[1], 1, 'Unknown-halo low-speed test keeps the actual central footprint resident')
    assert.ok(unknownLow[2] > 1 && unknownLow[2] < 4, 'Point gain would be fractional here')
    assert.equal(unknownLow[0], 1, 'Unknown halo must fall back to A before applying a point-gain cap')
    const growth = ['uniform-growth-quarter', 'uniform-growth-half', 'uniform-growth-three-quarter'].map(name => {
        const index = indexOf(name), expected = cases[index].alpha
        for (const observed of proof.coverage[index]) assert.equal(observed[0], expected,
            `${name}: a whole-region birth must fade continuously rather than switch at q=.5`)
        return { progress: expected, coverage: proof.coverage[index][0][0] }
    })
    const beforeCancellation = proof.coverage[indexOf('pre-cancellation-fade')]
    const afterCancellation = proof.coverage[indexOf('post-cancellation-reappearance')]
    assert.ok(beforeCancellation.some(observed => observed[0] > 0 && observed[0] < 0.1),
        'Actual B fades before the unchanged reliable-zero kill')
    beforeCancellation.forEach((observed, index) => assert.ok(Math.abs(observed[0] - afterCancellation[index][0]) < 4e-5,
        'Symmetric recovery after cancellation uses current vectors, not a retained endpoint SDF'))
    console.log(JSON.stringify({ status: 'passed', cases: summaries, realVirtualRaster: true,
        reversedAtlasPages: 2, rawHistoryUnchanged: true, coverageProbeCount: cases.length * coverageProbes.length,
        maximumCoverageError, widthCoverage, futureCoverage, uniformGrowth: growth, lazyUnknownHalo: { knownFar: knownFar[0], missingFar: missingFar[0],
            nearFallback: proof.coverage[6][6][0] }, readbacks: proof.readbacks, errors: proof.errors }))
} finally {
    await browser?.close()
    await new Promise(resolve => server.close(resolve))
}

function coverageOracle(fixture, probe) {
    const { x, y } = probe
    const baseX = Math.floor(x - 0.5), baseY = Math.floor(y - 0.5)
    // Registered sub-texel weights are f32 in the public shader. In particular,
    // a position one canonical quantum below a tile can round to the exact half
    // weight even while its integer owning texel remains on the original side.
    const point = [Math.fround(x - 0.5 - baseX), Math.fround(y - 0.5 - baseY)]
    const progress = Math.fround(fixture.alpha), kill = Math.fround(fixture.kill ?? 0.000001)
    const mixed = (a, b) => a * (1 - progress) + b * progress
    const field = endpoint => {
        if (storedVelocity(fixture.kind, endpoint, Math.floor(x), Math.floor(y)) === 0) return 0
        const top = storedVelocity(fixture.kind, endpoint, baseX, baseY) * (1 - point[0]) +
            storedVelocity(fixture.kind, endpoint, baseX + 1, baseY) * point[0]
        const bottom = storedVelocity(fixture.kind, endpoint, baseX, baseY + 1) * (1 - point[0]) +
            storedVelocity(fixture.kind, endpoint, baseX + 1, baseY + 1) * point[0]
        return top * (1 - point[1]) + bottom * point[1]
    }
    const pointGain = speedGain(Math.abs(mixed(field(0), field(1))), kill)
    if (pointGain === 0) return 0
    const activity = []
    for (let row = -1; row <= 2; row++) for (let col = -1; col <= 2; col++) {
        activity.push(activityOracle(storedVelocity(fixture.kind, 0, baseX + col, baseY + row),
            storedVelocity(fixture.kind, 1, baseX + col, baseY + row), progress, kill))
    }
    // Integrate the independently reconstructed binary coverage over every
    // constant-mask interval, then cap once by the current point's speed gain.
    const thresholds = [...new Set([0, 1, ...activity])].sort((a, b) => a - b)
    let coverage = 0
    for (let index = 1; index < thresholds.length; index++) {
        const threshold = thresholds[index], masks = []
        for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) {
            const origin = row * 4 + col
            masks.push(Number(activity[origin] >= threshold) | Number(activity[origin + 1] >= threshold) << 1 |
                Number(activity[origin + 5] >= threshold) << 2 | Number(activity[origin + 4] >= threshold) << 3)
        }
        coverage += (threshold - thresholds[index - 1]) * binaryCoverageOracle(point, masks, fixture.feather ?? 0.25)
    }
    return Math.min(coverage, pointGain)
}

function binaryCoverageOracle(point, masks, feather) {
    const geometry = mask => {
        const corners = [[0, 0], [1, 0], [1, 1], [0, 1]]
        const edges = [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]]
        const active = corners.map((_corner, index) => (mask & (1 << index)) !== 0)
        const crossing = edges.flatMap((edge, index) => active[index] !== active[(index + 1) % 4] ? [edge] : [])
        if (!crossing.length) return { segments: [], polygons: mask === 15 ? [corners] : [] }
        if (crossing.length === 4) return {
            segments: active.flatMap((inside, index) => inside ? [[edges[(index + 3) % 4], edges[index]]] : []),
            polygons: active.flatMap((inside, index) => inside ? [[corners[index], edges[index], edges[(index + 3) % 4]]] : []),
        }
        const polygon = []
        for (let index = 0; index < 4; index++) {
            if (active[index]) polygon.push(corners[index])
            if (active[index] !== active[(index + 1) % 4]) polygon.push(edges[index])
        }
        return { segments: [crossing], polygons: [polygon] }
    }
    let distance = 0.35
    for (const [index, mask] of masks.entries()) {
        for (const [a, b] of geometry(mask).segments) {
            const p = [point[0] - (index % 3 - 1), point[1] - (Math.floor(index / 3) - 1)]
            const dx = b[0] - a[0], dy = b[1] - a[1]
            const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)))
            distance = Math.min(distance, Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy))
        }
    }
    const inside = geometry(masks[4]).polygons.some(polygon => {
        let crossing = 0
        for (let index = 0; index < polygon.length; index++) {
            const a = polygon[index], b = polygon[(index + 1) % polygon.length]
            const cross = (point[0] - a[0]) * (b[1] - a[1]) - (point[1] - a[1]) * (b[0] - a[0])
            if (Math.abs(cross) < 1e-12 && point[0] >= Math.min(a[0], b[0]) && point[0] <= Math.max(a[0], b[0]) &&
                point[1] >= Math.min(a[1], b[1]) && point[1] <= Math.max(a[1], b[1])) return true
            if ((a[1] > point[1]) !== (b[1] > point[1]) &&
                point[0] < a[0] + (point[1] - a[1]) * (b[0] - a[0]) / (b[1] - a[1])) crossing++
        }
        return crossing % 2 === 1
    })
    if (!inside) return 0
    const width = Math.max(0.05, Math.min(0.35, feather))
    const t = Math.max(0, Math.min(1, distance / width))
    return t * t * (3 - 2 * t)
}

function smoothUnit(value) {
    const t = Math.max(0, Math.min(1, value))
    return t * t * (3 - 2 * t)
}

function speedGain(speed, kill) {
    if (speed <= kill || speed <= 0) return 0
    if (kill <= 0) return 1
    return smoothUnit((speed - kill) / (3 * kill))
}

function activityOracle(lower, upper, progress, kill) {
    const s0 = Math.abs(lower), s1 = Math.abs(upper)
    const a0 = speedGain(s0, kill), a1 = speedGain(s1, kill)
    if (progress <= 0) return a0
    if (progress >= 1) return a1
    const expected = Math.max(s0 - kill, 0) * (1 - progress) + Math.max(s1 - kill, 0) * progress
    if (expected <= 0) return 0
    const excess = Math.max(Math.abs(lower * (1 - progress) + upper * progress) - kill, 0)
    return Math.max(0, Math.min(1, (a0 * (1 - progress) + a1 * progress) * smoothUnit(excess / expected / 0.15)))
}
