import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import {
    WebMercatorQuad, tileMatrixCoverage, webMercatorQuadAddressCodec,
} from 'geoscratch/geo'
import { flowScreenProjectionWgsl, flowScreenViewValues } from '../../examples/flowField/flow-screen-projection.ts'

const base = process.env.FLOW_PITCH_PROJECTION_BASE ?? 'http://127.0.0.1:5173'
const viewport = { width: 1440, height: 900 }
const points = [[0.5, 0.5], [0.5, 0.7], [0.5, 0.9], [0.1, 0.9], [0.9, 0.9]]
const codec = webMercatorQuadAddressCodec({
    coordinateBits: 52,
    coverage: tileMatrixCoverage({
        tileMatrixSet: WebMercatorQuad,
        limits: [{ matrixId: '10', minTileRow: 0, maxTileRow: 1023,
            minTileCol: 0, maxTileCol: 1023 }],
    }),
})
const worldWidth = codec.quantumMeters * 2 ** codec.coordinateBits
const results = []
const browser = await chromium.launch({
    channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu'],
})

try {
    for (const dpr of [1, 2]) {
        const context = await browser.newContext({ viewport, deviceScaleFactor: dpr })
        const page = await context.newPage()
        const errors = []
        page.on('pageerror', error => errors.push(error.message))
        page.on('console', message => {
            if (message.type() === 'error') errors.push(message.text())
        })
        try {
            // Exercise the actual map factory and camera modules without starting the
            // particle application or depending on a local Flow data server.
            await page.route('**/flowField/main.ts', route => route.fulfill({
                contentType: 'text/javascript', body: 'export {}',
            }))
            await page.goto(`${base}/flowField/index.html`)
            await page.evaluate(async () => {
                const { createFlowFieldMap } = await import('/flowField/map.ts')
                const canvas = document.getElementById('GPUFrame')
                canvas.width = Math.round(innerWidth * devicePixelRatio)
                canvas.height = Math.round(innerHeight * devicePixelRatio)
                window.__FLOW_PITCH_MAP__ = createFlowFieldMap(canvas, { proof: true, zoom: 10 })
            })
            await page.waitForFunction(() => window.__FLOW_PITCH_MAP__.isStyleLoaded())

            for (const pitch of [0, 60, 75, 85]) {
                const facts = await page.evaluate(async ({ pitch, points }) => {
                    const { flowFieldViewAdapter } = await import('/flowField/map.ts')
                    const map = window.__FLOW_PITCH_MAP__
                    map.jumpTo({ pitch })
                    const camera = flowFieldViewAdapter.camera({
                        map,
                        referenceViewport: { width: map.transform.width, height: map.transform.height },
                        minimumElevationMeters: 0,
                    })
                    const view = flowFieldViewAdapter.read(camera, {
                        frameEpoch: 1, residencySnapshotEpoch: 1,
                    })
                    const canvas = document.getElementById('GPUFrame')
                    const ground = points.map(uv => {
                        const screen = [uv[0] * map.transform.width, uv[1] * map.transform.height]
                        const lonLat = map.unproject(screen)
                        const projected = maplibregl.MercatorCoordinate.fromLngLat(lonLat)
                        return { uv, screen, lonLat: [lonLat.lng, lonLat.lat],
                            mercator: [projected.x, projected.y] }
                    })
                    return { camera, view, ground, canvas: [canvas.width, canvas.height] }
                }, { pitch, points })
                const camera = facts.camera.cameraHigh.map((high, i) => high + facts.camera.cameraLow[i])
                const screenView = flowScreenViewValues(facts.view, codec)
                const declarations = points.map((uv, index) => `if (id.x == ${index}u) {
                    let ground = FlowScreen_ground_position(vec2f(${uv.join(', ')}),
                        mat4x4f(${screenView.relativeWorldFromClip.join(', ')}),
                        vec2u(${screenView.cameraX.map(value => `${value}u`).join(', ')}),
                        vec2u(${screenView.cameraY.map(value => `${value}u`).join(', ')}),
                        vec2f(${screenView.cameraZ.join(', ')}));
                    output[id.x * 5u] = ground.position.axes[0].low;
                    output[id.x * 5u + 1u] = ground.position.axes[0].high;
                    output[id.x * 5u + 2u] = ground.position.axes[1].low;
                    output[id.x * 5u + 3u] = ground.position.axes[1].high;
                    output[id.x * 5u + 4u] = ground.valid;
                }`).join('\n')
                const code = `${codec.wgslModule({ namespace: 'FlowVelocityAddress' })}
                    ${flowScreenProjectionWgsl(codec)}
                    @group(0) @binding(0) var<storage, read_write> output: array<u32>;
                    @compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3u) {
                        ${declarations}
                    }`
                const output = await page.evaluate(runNativeProbe, { code, count: points.length })
                const measured = facts.ground.map((point, index) => {
                    const label = `DPR ${dpr}, pitch ${pitch}, UV ${point.uv}`
                    assert.ok(point.lonLat.every(Number.isFinite), `${label}: finite MapLibre ground`)
                    assert.ok(point.mercator.every(value => value >= 0 && value <= 1),
                        `${label}: ground is inside the canonical world`)
                    const values = output.slice(index * 5, index * 5 + 5)
                    assert.equal(values[4], 1, `${label}: native ground validity`)
                    const projected = [
                        Number(BigInt(values[0]) + (BigInt(values[1]) << 32n)) * codec.quantumMeters - worldWidth / 2,
                        worldWidth / 2 - Number(BigInt(values[2]) + (BigInt(values[3]) << 32n)) * codec.quantumMeters,
                    ]
                    const expected = [(point.mercator[0] - 0.5) * worldWidth,
                        (0.5 - point.mercator[1]) * worldWidth]
                    const worldErrorMeters = Math.hypot(...projected.map((value, i) => value - expected[i]))
                    assert.ok(worldErrorMeters < 0.05, `${label}: world error ${worldErrorMeters} m`)
                    const clip = multiply(facts.camera.clipFromRelativeWorld,
                        [projected[0] - camera[0], projected[1] - camera[1], -camera[2], 1])
                    assert.ok(clip[3] > 0 && clip[2] >= 0 && clip[2] <= clip[3],
                        `${label}: projected ground is in the visible depth interval`)
                    const screen = [(clip[0] / clip[3] + 1) * viewport.width / 2,
                        (1 - clip[1] / clip[3]) * viewport.height / 2]
                    const screenErrorPixels = Math.hypot(...screen.map((value, i) => value - point.screen[i]))
                    assert.ok(screenErrorPixels < 0.001, `${label}: screen error ${screenErrorPixels} px`)
                    return { uv: point.uv, worldErrorMeters, screenErrorPixels }
                })
                assert.deepEqual(facts.camera.referenceViewport, [viewport.width, viewport.height])
                assert.deepEqual(facts.canvas, [viewport.width * dpr, viewport.height * dpr])
                const result = { dpr, pitch, points: measured }
                if (dpr === 2) assert.deepEqual(measured,
                    results.find(item => item.dpr === 1 && item.pitch === pitch).points,
                    `Pitch ${pitch}: DPR must not change ground or reference-pixel projection`)
                results.push(result)
            }
            assert.deepEqual(errors, [])
        } finally {
            await page.evaluate(() => window.__FLOW_PITCH_MAP__?.remove()).catch(() => undefined)
            await context.close()
        }
    }
    console.log(JSON.stringify({
        status: 'passed', points: results.length * points.length,
        maximumWorldErrorMeters: Math.max(...results.flatMap(item => item.points.map(point => point.worldErrorMeters))),
        maximumScreenErrorPixels: Math.max(...results.flatMap(item => item.points.map(point => point.screenErrorPixels))),
        results,
    }))
} finally {
    await browser.close()
}

function multiply(matrix, vector) {
    return [0, 1, 2, 3].map(row => [0, 1, 2, 3].reduce(
        (sum, column) => sum + matrix[column * 4 + row] * vector[column], 0))
}

async function runNativeProbe({ code, count }) {
    const adapter = await navigator.gpu.requestAdapter()
    if (!adapter) throw new Error('Flow pitch projection requires a native WebGPU adapter')
    const device = await adapter.requestDevice()
    let output
    let readback
    let mapped = false
    try {
        device.pushErrorScope('validation')
        const module = device.createShaderModule({ code })
        const pipeline = await device.createComputePipelineAsync({
            layout: 'auto', compute: { module, entryPoint: 'main' },
        })
        output = device.createBuffer({
            size: count * 20, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        })
        readback = device.createBuffer({
            size: count * 20, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        })
        const bindings = device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [{ binding: 0, resource: { buffer: output } }],
        })
        const encoder = device.createCommandEncoder()
        const pass = encoder.beginComputePass()
        pass.setPipeline(pipeline)
        pass.setBindGroup(0, bindings)
        pass.dispatchWorkgroups(count)
        pass.end()
        encoder.copyBufferToBuffer(output, 0, readback, 0, count * 20)
        device.queue.submit([encoder.finish()])
        await readback.mapAsync(GPUMapMode.READ)
        mapped = true
        const values = [...new Uint32Array(readback.getMappedRange())]
        const error = await device.popErrorScope()
        if (error) throw new Error(error.message)
        return values
    } finally {
        if (mapped) readback.unmap()
        readback?.destroy()
        output?.destroy()
        device.destroy()
    }
}
