import assert from 'node:assert/strict'
import { chromium } from 'playwright'

// Run alone: other GPU workloads invalidate this relative, high-DPR benchmark.
// The counterfactual is injected only into an isolated page, never into source.
const base = process.env.FLOW_MOTION_BASE ?? 'http://127.0.0.1:5173'
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu'] })
const results = []
try {
    for (const variant of ['reference', 'eager-support', 'current']) {
        const page = await browser.newPage({ viewport: { width: 1512, height: 861 }, deviceScaleFactor: 2 })
        const errors = []
        page.on('pageerror', error => errors.push(error.message))
        page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
        if (variant === 'eager-support') {
            await page.route('**/flowField/shaders/hard-boundary.wgsl*', async route => {
                const response = await route.fetch()
                const body = await response.text()
                const guard = 'if (!FlowHistory_supported(input.texcoords)) { return vec4f(0.0); }'
                const first = 'let dimensions = vec2i(textureDimensions(historyTexture, 0));'
                assert.ok(body.includes(guard) && body.includes(first))
                await route.fulfill({ response, body: body.replace(guard, '').replace(first, `${guard} ${first}`) })
            })
        }
        const name = variant === 'reference' ? 'flowLayer' : 'flowField'
        await page.goto(`${base}/${name}/index.html?proof=1&rate=0.001&zoom=9`)
        await page.waitForFunction(reference => reference
            ? Number(window.__FLOW_LAYER_PROOF__?.facts()?.observedFrames) >= 60
            : (window.__FLOW_FIELD_PROOF__?.facts()?.renderer.particles.encodedSteps ?? 0) >= 60,
        variant === 'reference', { timeout: 90000 })
        const samples = await page.evaluate(async reference => {
            const samples = []
            for (let index = 0; index <= 8; index++) {
                const facts = reference ? window.__FLOW_LAYER_PROOF__.facts() : window.__FLOW_FIELD_PROOF__.facts()
                samples.push({
                    wallTime: performance.now(),
                    steps: Number(reference ? facts.observedFrames : facts.renderer.particles.encodedSteps),
                    state: document.body.dataset.status,
                })
                if (index < 8) await new Promise(resolve => setTimeout(resolve, 500))
            }
            return samples
        }, variant === 'reference')
        assert.ok(samples.every(sample => sample.state === 'ready'), 'Measure resident playback, not tile loading')
        assert.deepEqual(errors, [])
        const first = samples[0], last = samples.at(-1)
        const stepsPerSecond = (last.steps - first.steps) * 1000 / (last.wallTime - first.wallTime)
        const cleanup = await page.evaluate(reference => reference
            ? window.__FLOW_LAYER_PROOF__.dispose() : window.__FLOW_FIELD_PROOF__.dispose(), variant === 'reference')
        if (variant !== 'reference') assert.equal(cleanup.cleanupFailures.length, 0)
        results.push({ variant, stepsPerSecond, samples, errors })
        await page.close()
    }
    console.log(JSON.stringify({
        status: 'observed', viewport: [1512, 861], deviceScaleFactor: 2, results,
        currentToReference: results[2].stepsPerSecond / results[0].stepsPerSecond,
        currentToEagerSupport: results[2].stepsPerSecond / results[1].stepsPerSecond,
    }))
} finally {
    await browser.close()
}
