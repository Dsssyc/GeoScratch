import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { chromium } from 'playwright'
import { WebMercatorQuad, tileMatrixCoverage, webMercatorVirtualRasterField } from 'geoscratch/geo'
import { temporalVelocityWgslModule } from '../../examples/flowField/temporal-velocity-raster.ts'
import { flowScreenProjectionWgsl } from '../../examples/flowField/flow-screen-projection.ts'

const read = name => readFile(new URL(`../../examples/flowField/shaders/${name}.wgsl`, import.meta.url), 'utf8')
const [wrapper, distance, sdf, presentation, history] = await Promise.all([
    'temporal-velocity', 'boundary-distance', 'boundary-sdf', 'presentation', 'history',
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
const code = [temporal.code, flowScreenProjectionWgsl(model.addressCodec), uniformStruct, distance, sdf].join('\n')
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
function atlas(kind, endpoint) {
    const pixels = new Float32Array(512 * 256 * 2)
    for (let y = 0; y < 256; y++) for (let x = 0; x < 512; x++) {
        let velocity = x === 256 || x === 258 || (x === 254 && y === 65) ? 0 : 2
        if (kind === 'future' && endpoint === 1 && x === 256) velocity = 2
        if (kind === 'cancel' && endpoint === 1) velocity = -velocity
        const atlasX = (1 - Math.floor(x / 256)) * 256 + x % 256
        pixels[(y * 512 + atlasX) * 2] = velocity
    }
    return [...pixels]
}
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
    uniform.setFloat32(336, 0.000001, true)
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
    const proof = await page.evaluate(async ({ code, presentation, cases, ink, width, height }) => {
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
        const uniformLayout = device.createBindGroupLayout({ entries: [
            { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        ] })
        const temporalLayout = device.createBindGroupLayout({ entries: [
            { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
            { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
            { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
            { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
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
        const size = width * height * 4
        const readback = device.createBuffer({ size: size * (cases.length * 3 + 1),
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
        }
        encoder.copyTextureToBuffer({ texture: history }, { buffer: readback,
            offset: cases.length * 3 * size, bytesPerRow: width * 4 }, [width, height])
        device.queue.submit([encoder.finish()])
        await readback.mapAsync(GPUMapMode.READ)
        const bytes = new Uint8Array(readback.getMappedRange())
        const outputs = cases.map((_fixture, index) => [0, 1, 2].map(variant =>
            Array.from(bytes.slice((index * 3 + variant) * size, (index * 3 + variant + 1) * size))))
        const raw = Array.from(bytes.slice(cases.length * 3 * size))
        readback.unmap()
        readback.destroy()
        owned.forEach(resource => resource.destroy())
        const validation = await device.popErrorScope()
        if (validation) throw new Error(validation.message)
        if (errors.length) throw new Error(errors.join('\n'))
        device.destroy()
        return { outputs, raw, errors, readbacks: 1 }
    }, { code, presentation, cases, ink: [...ink], width, height })
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
    assert.equal(alpha(2, 73, 20), rawAlpha(73, 20), 'Current alpha .277 activates the future source texel')
    for (let offset = 3; offset < byteLength; offset += 4) assert.equal(proof.outputs[3][1][offset], 0,
        'Opposite endpoints cancel now; endpoint-union support must not survive')
    for (let x = 56; x <= 71; x++) assert.equal(alpha(4, x, 20), rawAlpha(x, 20),
        'Missing neighbor across reversed atlas seam falls back to unchanged A')
    assert.ok(summaries[0].reducedPixels > 100, 'B must be a nontrivial boundary presentation')
    console.log(JSON.stringify({ status: 'passed', cases: summaries, realVirtualRaster: true,
        reversedAtlasPages: 2, rawHistoryUnchanged: true, readbacks: proof.readbacks, errors: proof.errors }))
} finally {
    await browser?.close()
    await new Promise(resolve => server.close(resolve))
}
