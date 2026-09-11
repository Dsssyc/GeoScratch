import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const base = process.env.FLOW_NORMAL_BASE ?? 'http://127.0.0.1:5173'
const tiles = process.env.FLOW_NORMAL_TILES ?? new URL('/api/flow', base).href
const url = new URL('/flowField/', base)
if (process.env.FLOW_NORMAL_TILES) url.searchParams.set('tileServer', tiles)
assert.equal(url.searchParams.has('proof'), false)
// A valid local PNG supplies deterministic raster responses. The production
// normal style, sources, MapLibre lifecycle and frame driver remain unchanged.
const raster = await readFile(new URL('../../docs/assets/icons/icon_dark.png', import.meta.url))
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu'] })
let releaseManifest, releaseRaster
try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    await page.addInitScript(() => {
        const probe = { styleLoads: [], idles: [], errors: [], createdAt: 0, normalSource: false }
        window.__FLOW_NORMAL_STARTUP__ = probe
        let api
        Object.defineProperty(window, 'maplibregl', {
            configurable: true,
            get: () => api,
            set(value) {
                api = value
                const NativeMap = value.Map
                value.Map = class extends NativeMap {
                    constructor(options) {
                        super(options)
                        window.__FLOW_NORMAL_MAP__ = this
                        probe.createdAt = performance.now()
                        probe.normalSource = Boolean(options.style?.sources?.cartoDarkMatter)
                        this.on('style.load', () => probe.styleLoads.push(performance.now()))
                        this.on('idle', () => probe.idles.push(performance.now()))
                        this.on('error', event => probe.errors.push(event.error?.message ?? String(event.error)))
                    }
                }
            },
        })
    })
    const manifestGate = new Promise(resolve => { releaseManifest = resolve })
    const rasterGate = new Promise(resolve => { releaseRaster = resolve })
    let rasterRequests = 0
    const manifestUrl = new URL('manifest.json', `${tiles.replace(/\/$/, '')}/`).href
    const manifestRoute = async route => {
        await manifestGate
        await route.continue().catch(() => undefined)
    }
    await page.route(manifestUrl, manifestRoute)
    await page.route(/^https:\/\/[abcd]\.basemaps\.cartocdn\.com\/dark_all\/.*\.png(?:\?.*)?$/, async route => {
        rasterRequests++
        await rasterGate
        await route.fulfill({ status: 200, contentType: 'image/png', body: raster,
            headers: { 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=3600' } })
            .catch(() => undefined)
    })
    await page.goto(url.href, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => window.__FLOW_NORMAL_STARTUP__?.styleLoads.length > 0,
        undefined, { timeout: 30000 })
    // Dataset/GPU preparation begins only after the style.load edge has passed.
    releaseManifest()
    await page.waitForFunction(() => window.__FLOW_FIELD_PROOF__?.facts() !== undefined ||
        document.body.dataset.status === 'error', undefined, { timeout: 90000 })
    const blocked = await facts()
    assert.equal(blocked.error, undefined, JSON.stringify(blocked))
    assert.equal(blocked.normalSource, true)
    assert.equal(blocked.styleLoads.length, 1)
    assert.equal(blocked.styleLoaded, false, 'Raster requests must still block full style readiness')
    assert.equal(blocked.layerAttached, false, 'Driver must not attach before its existing readiness gate')
    assert.equal(blocked.observedFrames, 0)
    assert.equal(blocked.particleSteps, 0)
    assert.ok(rasterRequests > 0, 'Normal CARTO raster requests must exercise the delayed-source path')

    releaseRaster()
    await waitForFrames()
    const resumed = await facts()
    assert.equal(resumed.error, undefined, JSON.stringify(resumed))
    assert.equal(resumed.status, 'ready')
    assert.equal(resumed.layerAttached, true)
    assert.equal(resumed.styleLoads.length, 1, 'Recovery must not require a second style.load event')
    assert.ok(resumed.idles.length >= 1, 'Source settlement must produce a MapLibre idle event')
    assert.ok(resumed.observedFrames >= 5 && resumed.particleSteps >= 5)
    assert.deepEqual(resumed.mapErrors, [])
    const firstCleanup = await page.evaluate(() => window.__FLOW_FIELD_PROOF__.dispose())
    assert.deepEqual(firstCleanup.cleanupFailures, [])

    // Same browser context and local data, now with no artificial source delay.
    // Playwright routing disables HTTP cache; this is explicitly a warm-data /
    // immediate-raster reload proof, not a claim of HTTP cache hits.
    await page.unroute(manifestUrl, manifestRoute)
    const requestsBeforeReload = rasterRequests
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitForFrames()
    const reloaded = await facts()
    assert.equal(reloaded.error, undefined, JSON.stringify(reloaded))
    assert.equal(reloaded.status, 'ready')
    assert.equal(reloaded.normalSource, true)
    assert.equal(reloaded.layerAttached, true)
    assert.ok(reloaded.observedFrames >= 5 && reloaded.particleSteps >= 5)
    assert.deepEqual(reloaded.mapErrors, [])
    assert.ok(rasterRequests > requestsBeforeReload, 'Reload must keep the real normal raster source')
    const reloadCleanup = await page.evaluate(() => window.__FLOW_FIELD_PROOF__.dispose())
    assert.deepEqual(reloadCleanup.cleanupFailures, [])
    assert.deepEqual(errors, [])
    console.log(JSON.stringify({ status: 'passed', url: url.href, blocked, resumed, reloaded,
        reloadMode: 'same-context-warm-data-immediate-raster', rasterRequests, errors }))

    async function waitForFrames() {
        await page.waitForFunction(() => {
            const state = window.__FLOW_FIELD_PROOF__?.facts()
            return document.body.dataset.status === 'error' ||
                (document.body.dataset.status === 'ready' && state?.lastFrame.presentationReady &&
                    (state?.frames.observedFrameCount ?? 0) >= 5 &&
                    (state?.renderer.particles.encodedSteps ?? 0) >= 5)
        }, undefined, { timeout: 90000 })
    }

    async function facts() {
        return await page.evaluate(() => {
            const value = window.__FLOW_FIELD_PROOF__?.facts()
            const probe = window.__FLOW_NORMAL_STARTUP__
            const map = window.__FLOW_NORMAL_MAP__
            return { status: document.body.dataset.status,
                error: document.querySelector('#GPUFrame')?.dataset.error,
                normalSource: probe?.normalSource, styleLoads: probe?.styleLoads, idles: probe?.idles,
                mapErrors: probe?.errors, styleLoaded: map?.isStyleLoaded(),
                layerAttached: map?.getLayer('flow-field-maplibre-frames') !== undefined,
                observedFrames: value?.frames.observedFrameCount,
                particleSteps: value?.renderer.particles.encodedSteps }
        })
    }
} finally {
    releaseManifest?.()
    releaseRaster?.()
    await browser.close()
}
