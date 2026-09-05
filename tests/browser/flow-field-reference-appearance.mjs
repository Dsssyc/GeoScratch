import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'

const base = process.env.FLOW_FIELD_COMPARE_URL ?? 'http://127.0.0.1:5173'
const output = process.env.FLOW_FIELD_COMPARE_OUTPUT ?? '/tmp/flow-field-reference-appearance'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu'] })
try {
    for (const name of ['flowLayer', 'flowField']) {
        const page = await browser.newPage({ viewport: {width: 960, height: 720} })
        const errors = []
        page.on('pageerror', error => errors.push(error.message))
        await page.goto(`${base}/${name}/index.html?proof=1&rate=0.001&zoom=9`)
        await page.waitForFunction(name => {
            if (document.body.dataset.status === 'error') return true
            return name === 'flowLayer'
                ? Number(window.__FLOW_LAYER_PROOF__?.facts()?.observedFrames) >= 60
                : (window.__FLOW_FIELD_PROOF__?.facts()?.frames?.observedFrameCount ?? 0) >= 60
        }, name, { timeout: 120000 })
        if (name === 'flowLayer') await page.evaluate(() => window.__FLOW_LAYER_PROOF__.pauseAndDrain())
        else await page.locator('[data-flow-control="play-pause"]').click()
        const status = await page.locator('#GPUFrame').getAttribute('data-status')
        const facts = await page.evaluate(name => {
            if (name === 'flowLayer') return window.__FLOW_LAYER_PROOF__.facts()
            const value = window.__FLOW_FIELD_PROOF__.facts()
            return { timeline: value.timeline, particles: value.renderer.particles,
                temporal: value.lastFrame.temporal, requestedLevel: value.lastFrame.demand?.requestedLevel,
                history: value.lastFrame.history, spawn: value.renderer.spawn }
        }, name)
        await page.screenshot({ path: `${output}/${name}.png`, style: '#FlowFieldControls { visibility: hidden !important }' })
        console.log(JSON.stringify({ name, status, facts, errors, image: `${output}/${name}.png` }))
        if (errors.length > 0 || status === 'error') throw new Error(`${name} failed to render`)
        await page.evaluate(name => name === 'flowLayer'
            ? window.__FLOW_LAYER_PROOF__.dispose() : window.__FLOW_FIELD_PROOF__.dispose(), name)
        await page.close()
    }
} finally {
    await browser.close()
}
