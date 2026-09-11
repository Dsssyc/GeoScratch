import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const base = process.env.FLOW_TRAIL_QUALITY_BASE ?? 'http://127.0.0.1:5173'
const output = process.env.FLOW_TRAIL_QUALITY_OUTPUT ?? '/tmp/geoscratch-flow-trail-quality'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu'] })
const results = []
try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    await page.addInitScript(() => {
        window.__FLOW_TRAIL_ALLOCATIONS__ = []
        const create = GPUDevice.prototype.createTexture
        GPUDevice.prototype.createTexture = function (descriptor) {
            if (/^Flow Field (history [AB]|particle overlap depth)/.test(descriptor.label ?? '')) {
                const size = descriptor.size
                window.__FLOW_TRAIL_ALLOCATIONS__.push({
                    width: size.width ?? size[0], height: size.height ?? size[1],
                })
            }
            return create.call(this, descriptor)
        }
    })
    await page.goto(`${base}/flowField/?proof=1&rate=0.000001&zoom=9`)
    await ready(page)
    await settleTrails(page)
    const balanced = await facts(page)
    assert.deepEqual(balanced.surface, {width:2560,height:1600})
    assert.deepEqual(balanced.history, {width:1280,height:800})
    assert.equal(balanced.quality, 'balanced')
    assert.equal(balanced.comparisons, 0)
    const allocations = await page.evaluate(() => window.__FLOW_TRAIL_ALLOCATIONS__)
    assert.ok(allocations.length >= 3, 'Observe both history textures and overlap depth')
    assert.ok(allocations.every(size => size.width === 1280 && size.height === 800),
        'Balanced allocation must be bounded from construction, not only after first resize')
    results.push({ name: 'balanced', ...balanced })
    await page.screenshot({ path: `${output}/balanced.png` })

    await page.locator('[data-flow-control="trail-quality"]').selectOption('native')
    await ready(page, {width:2560,height:1600})
    await settleTrails(page)
    const native = await facts(page)
    assert.deepEqual(native.surface, balanced.surface)
    assert.equal(native.resets, balanced.resets, 'Quality must not reset particle state')
    assert.equal(native.spatialBuilds, balanced.spatialBuilds, 'Quality must not change GPU cover')
    assert.deepEqual(native.pages, balanced.pages, 'Quality must not change source demands')
    results.push({ name: 'native', ...native })
    await page.screenshot({ path: `${output}/native.png` })

    await page.locator('[data-flow-control="play-pause"]').click()
    await page.waitForFunction(() => !window.__FLOW_FIELD_PROOF__.facts().timeline.playing &&
        window.__FLOW_FIELD_PROOF__.facts().frames.inFlightFrameCount === 0)
    const paused = await facts(page)
    await page.locator('[data-flow-control="trail-quality"]').selectOption('balanced')
    await ready(page, {width:1280,height:800})
    const resized = await facts(page)
    assert.equal(resized.steps, paused.steps, 'Paused quality changes must not simulate')
    assert.equal(resized.resets, paused.resets)
    assert.equal(resized.visualSteps, 0)
    assert.equal(resized.spatialBuilds, balanced.spatialBuilds)
    results.push({ name: 'paused-quality-change', ...resized })

    await page.locator('[data-flow-control="view"]').selectOption('status')
    await ready(page, {width:2560,height:1600})
    assert.equal(await page.locator('[data-flow-control="trail-quality"]').isDisabled(), true)
    results.push({ name: 'native-inspection', ...await facts(page) })
    await page.locator('[data-flow-control="view"]').selectOption('particles')
    await page.locator('[data-flow-control="play-pause"]').click()
    await ready(page, {width:1280,height:800})

    for (const boundary of ['sdf', 'sdf-center-linear', 'sdf-center-smooth', 'hard']) {
        await page.locator('[data-flow-control="boundary"]').selectOption(boundary)
        await ready(page, {width:1280,height:800})
        assert.deepEqual((await facts(page)).surface, balanced.surface)
    }
    await page.evaluate(() => window.__FLOW_FIELD_PROOF__.seek(1.277))
    await page.waitForFunction(() => {
        const f = window.__FLOW_FIELD_PROOF__.facts()
        return f.lastFrame.temporal?.lowerSampleKey === 't01' && f.lastFrame.presentationReady &&
            f.workers.activeTaskCount === 0
    }, undefined, { timeout: 90_000 })
    await page.setViewportSize({width:1440,height:900})
    await ready(page, {width:1440,height:900})
    const changed = await facts(page)
    assert.deepEqual(changed.surface, {width:2880,height:1800})
    assert.ok(changed.spatialBuilds > balanced.spatialBuilds)
    results.push({ name: 'resized-time-pair', ...changed })
    const cleanup = await page.evaluate(() => window.__FLOW_FIELD_PROOF__.dispose())
    assert.deepEqual(cleanup.cleanupFailures, [])
    assert.equal((await page.evaluate(() => window.__FLOW_FIELD_PROOF__.facts())).temporalWindow.ownedRuntimeCount, 0)
    assert.deepEqual(errors, [])
    const report = { status: 'passed', results, errors }
    await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2))
    console.log(JSON.stringify({status:report.status,output,cases:results.map(value => value.name)}))
} finally {
    await browser.close()
}

async function ready(page, size) {
    await page.waitForFunction(size => {
        const f = window.__FLOW_FIELD_PROOF__?.facts()
        if (document.body.dataset.status === 'error') return true
        return f?.lastFrame.presentationReady && f.workers.activeTaskCount === 0 &&
            f.frames.inFlightFrameCount === 0 && (!size ||
                f.renderer.history.size.width === size.width && f.renderer.history.size.height === size.height)
    }, size, { timeout: 90_000 })
    assert.equal(await page.locator('body').getAttribute('data-status'), 'ready',
        await page.locator('#GPUFrame').getAttribute('data-error'))
}

async function settleTrails(page) {
    const start = await page.evaluate(() => window.__FLOW_FIELD_PROOF__.facts().renderer.particles.simulatedReferenceSteps)
    await page.waitForFunction(start => window.__FLOW_FIELD_PROOF__.facts()
        .renderer.particles.simulatedReferenceSteps > start + 120, start, { timeout: 30_000 })
}

async function facts(page) {
    return page.evaluate(() => {
        const f = window.__FLOW_FIELD_PROOF__.facts()
        return {
            quality: document.querySelector('[data-flow-control="trail-quality"]').value,
            surface: f.renderer.presentationSize,
            history: f.renderer.history.size,
            spatialBuilds: f.renderer.viewDemand.buildCount,
            comparisons: f.renderer.spawn.candidateComparisonCount,
            resets: f.renderer.particles.resetCount,
            steps: f.renderer.particles.encodedSteps,
            visualSteps: f.renderer.visualTime.referenceSteps,
            pages: f.lastFrame.demand?.candidatePages,
        }
    })
}
