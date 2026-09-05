import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'
import assert from 'node:assert/strict'

const base = process.env.FLOW_CAMERA_BASE ?? 'http://127.0.0.1:5173'
const output = process.env.FLOW_CAMERA_OUTPUT ?? '/tmp/flow-field-camera'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu'] })
try {
    const page = await browser.newPage({ viewport: {width: 1440, height: 900} })
    const errors = []
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`${base}/flowField/index.html?proof=1&rate=0.001&zoom=9`)
    await page.waitForFunction(() => document.body.dataset.status === 'error' ||
        (window.__FLOW_FIELD_PROOF__?.facts()?.renderer?.particles?.encodedSteps ?? 0) >= 3,
        undefined, {timeout: 90000})
    async function facts(label) {
        const value = await page.evaluate(() => {
            const value = window.__FLOW_FIELD_PROOF__?.facts()
            return {
                status: document.body.dataset.status, error: document.querySelector('#GPUFrame')?.dataset.error,
                frames: value?.frames?.observedFrameCount,
                simulationSteps: value?.renderer?.particles?.encodedSteps,
                pair: value?.temporalWindow?.pairGeneration,
                ready: value?.lastFrame?.presentationReady,
                camera: value?.lastFrame?.view?.cameraHigh,
                zoom: value?.lastFrame?.view?.zoomHint,
                pageCount: value?.lastFrame?.demand?.candidatePages?.length,
            }
        })
        console.log(JSON.stringify({label, ...value}))
        return value
    }
    const initial = await facts('initial')
    assert.equal(initial.status, 'ready')
    const start = performance.now()
    await page.waitForTimeout(2000)
    const steady = await facts('after-2s')
    const stepsPerSecond = (steady.simulationSteps - initial.simulationSteps) / ((performance.now() - start) / 1000)
    assert.ok(stepsPerSecond >= 30, `Steady visual ticks were only ${stepsPerSecond}/s`)
    await page.mouse.move(580, 350)
    for (const delta of [-300, -500, 500, 800, 1200]) {
        await page.mouse.wheel(0, delta)
        await page.waitForTimeout(1000)
        const value = await facts(`wheel-${delta}`)
        assert.notEqual(value.status, 'error')
        assert.ok(value.pageCount <= 47)
        await page.screenshot({path:`${output}/wheel-${delta}.png`})
    }
    await page.mouse.wheel(0, -1800)
    await page.waitForTimeout(1000)
    await page.locator('[data-flow-control="play-pause"]').click()
    const paused = await facts('paused')
    await page.mouse.move(580, 350)
    await page.mouse.wheel(0, -300)
    await page.waitForTimeout(1000)
    const pausedZoom = await facts('paused-zoom')
    assert.ok(pausedZoom.zoom > paused.zoom)
    assert.notDeepEqual(pausedZoom.camera, paused.camera)

    let releaseTiles
    const tileGate = new Promise(resolve => { releaseTiles = resolve })
    await page.route(/\/tiles\/WebMercatorQuad\/t1[01]\//, async route => {
        await tileGate
        await route.continue().catch(() => undefined)
    })
    const time = page.locator('[data-flow-control="time"]')
    await time.fill('10.5')
    await time.dispatchEvent('change')
    await page.waitForFunction(() => window.__FLOW_FIELD_PROOF__.facts().temporalWindow.state === 'loading')
    const screenshotStyle = {style:'#FlowFieldControls, .maplibregl-control-container {visibility:hidden !important}'}
    const before = await page.screenshot(screenshotStyle)
    const waiting = await facts('waiting-before-zoom')
    await page.mouse.move(580, 350)
    await page.mouse.wheel(0, 500)
    await page.waitForTimeout(1200)
    const after = await page.screenshot({...screenshotStyle, path:`${output}/waiting-after-zoom.png`})
    const changedPixels = await page.evaluate(async images => {
        const pixels = await Promise.all(images.map(async base64 => {
            const image = new Image()
            image.src = `data:image/png;base64,${base64}`
            await image.decode()
            const canvas = document.createElement('canvas')
            canvas.width = image.width; canvas.height = image.height
            const context = canvas.getContext('2d')
            context.drawImage(image, 0, 0)
            return context.getImageData(0, 0, image.width, image.height).data
        }))
        let changed = 0
        for (let i=0;i<pixels[0].length;i+=4) {
            if (Math.abs(pixels[0][i]-pixels[1][i]) + Math.abs(pixels[0][i+1]-pixels[1][i+1]) +
                Math.abs(pixels[0][i+2]-pixels[1][i+2]) > 15) changed++
        }
        return changed
    }, [before.toString('base64'),after.toString('base64')])
    const waitingAfter = await facts('waiting-after-zoom')
    assert.equal(waitingAfter.status, 'loading')
    assert.ok(waitingAfter.frames > waiting.frames)
    assert.ok(changedPixels > 100, `Retained flow was stuck on screen: ${changedPixels} changed pixels`)
    releaseTiles()
    await page.waitForFunction(() => document.body.dataset.status === 'ready', undefined, {timeout:30000})
    const cleanup = await page.evaluate(() => window.__FLOW_FIELD_PROOF__?.dispose())
    assert.equal(cleanup.cleanupFailures.length, 0)
    await page.close()
    const extremeViews = []
    for (const zoom of [3, 14, 18]) {
        const extreme = await browser.newPage({viewport:{width:1440,height:900}})
        await extreme.goto(`${base}/flowField/index.html?proof=1&rate=0.001&zoom=${zoom}`)
        await extreme.waitForFunction(() => ['ready','error'].includes(document.body.dataset.status),
            undefined,{timeout:30000})
        const result = await extreme.evaluate(() => ({
            status: document.body.dataset.status,
            pages: window.__FLOW_FIELD_PROOF__?.facts()?.lastFrame?.demand?.candidatePages?.length,
            error: document.querySelector('#GPUFrame')?.dataset.error,
        }))
        extremeViews.push({zoom,...result})
        assert.equal(result.status, 'ready', result.error)
        assert.ok(result.pages <= 47)
        const report = await extreme.evaluate(() => window.__FLOW_FIELD_PROOF__.dispose())
        assert.equal(report.cleanupFailures.length, 0)
        await extreme.close()
    }
    assert.deepEqual(errors, [])
    console.log(JSON.stringify({status:'passed',stepsPerSecond,changedPixels,extremeViews,errors}))
} finally {
    await browser.close()
}
