import assert from 'node:assert/strict'
import { chromium } from 'playwright'

// Run alone. This checks simulation admission per submitted frame, not machine FPS.
const base = process.env.FLOW_CAMERA_CONTINUITY_BASE ?? 'http://127.0.0.1:5173'
const browser = await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-webgpu']})
const results = []
try {
    for (const gesture of ['stationary', 'pan', 'pitch', 'wheel', 'wheel-time']) {
        const page = await browser.newPage({viewport:{width:1440,height:900}})
        const errors = []
        const requests = []
        let measuring = false
        page.on('pageerror', error => errors.push(error.message))
        page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
        page.on('request', request => {
            if (measuring && /\/tiles\/WebMercatorQuad\//.test(request.url())) {
                requests.push(new URL(request.url()).pathname)
            }
        })
        const rate = gesture === 'wheel-time' ? 0.2 : 0.001
        await page.goto(`${base}/flowField/index.html?proof=1&rate=${rate}&zoom=10`)
        await page.waitForFunction(() => {
            const f = window.__FLOW_FIELD_PROOF__?.facts()
            return document.body.dataset.status === 'error' ||
                (f?.lastFrame.presentationReady && f.renderer.particles.encodedSteps >= 30 &&
                    f.renderer.prefetch?.pagesResident && f.workers.activeTaskCount === 0)
        }, undefined, {timeout:90000})
        assert.equal(await page.locator('body').getAttribute('data-status'), 'ready')
        await page.mouse.move(550,500)
        if (gesture === 'pan' || gesture === 'pitch') {
            await page.mouse.down({button:gesture === 'pitch' ? 'right' : 'left'})
        }

        // Record each submitted frame once. Repeated rAF polls of the same frame
        // cannot dilute incomplete/paused-frame counts with duplicate observations.
        await page.evaluate(() => {
            const read = () => {
                const f = window.__FLOW_FIELD_PROOF__.facts(), frame = f.lastFrame
                return {
                    wallTime:performance.now(),
                    submitted:f.frames.submittedFrameCount,
                    observed:f.frames.observedFrameCount,
                    rendererFrame:f.renderer.frameCount,
                    steps:f.renderer.particles.encodedSteps,
                    resets:f.renderer.particles.resetCount,
                    pair:f.temporalWindow.pairGeneration,
                    state:frame.state,
                    complete:frame.presentationReady === true,
                    cleared:frame.history?.cleared === true,
                    pitch:frame.view?.cameraPitchRadians,
                    zoom:frame.view?.zoomHint,
                    camera:JSON.stringify([frame.view?.clipFromRelativeWorld,
                        frame.view?.cameraHigh,frame.view?.cameraLow]),
                    owned:f.temporalWindow.ownedRuntimeCount + f.temporalWindow.pendingCreationCount,
                    status:document.body.dataset.status,
                }
            }
            const start = read()
            const probe = {
                start, end:start, records:[], submissions:new Set(), observations:new Set(),
                seenFrames:new Set([start.rendererFrame]), stopped:false, handle:0,
            }
            const sample = () => {
                const value = read()
                if (value.submitted > start.submitted) probe.submissions.add(value.submitted)
                if (value.observed > start.observed) probe.observations.add(value.observed)
                if (!probe.seenFrames.has(value.rendererFrame)) {
                    probe.seenFrames.add(value.rendererFrame)
                    probe.records.push(value)
                }
                probe.end = value
                if (!probe.stopped) probe.handle = requestAnimationFrame(sample)
            }
            probe.finish = () => {
                probe.stopped = true
                cancelAnimationFrame(probe.handle)
                sample()
                return {
                    start:probe.start, end:probe.end, records:probe.records,
                    uniqueSubmitted:[...probe.submissions], uniqueObserved:[...probe.observations],
                }
            }
            window.__FLOW_CAMERA_CONTINUITY_PROBE__ = probe
            probe.handle = requestAnimationFrame(sample)
        })
        measuring = true
        if (gesture === 'stationary') {
            await page.waitForTimeout(2400)
        } else {
            for (let index = 1; index <= 144; index++) {
                // One real input per browser animation opportunity, without
                // accessing or replacing the application's MapLibre instance.
                await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)))
                const progress = index / 144
                if (gesture === 'pan') {
                    await page.mouse.move(550 + 70 * progress, 500 + 8 * Math.sin(progress * Math.PI * 2))
                } else if (gesture === 'pitch') {
                    await page.mouse.move(550, 500 - 105 * progress)
                } else {
                    await page.mouse.wheel(0, index <= 72 ? -6 : 6)
                }
            }
        }
        const measured = await page.evaluate(() => {
            const value = window.__FLOW_CAMERA_CONTINUITY_PROBE__.finish()
            delete window.__FLOW_CAMERA_CONTINUITY_PROBE__
            return value
        })
        measuring = false
        if (gesture === 'pan' || gesture === 'pitch') {
            await page.mouse.up({button:gesture === 'pitch' ? 'right' : 'left'})
        }
        const {start, end, records} = measured
        const rendered = records.filter(value => value.state === 'rendered')
        let previous = start
        let changedCameraFrames = 0
        let stoppedRenderedFrames = 0
        for (const value of records) {
            if (value.camera !== previous.camera) changedCameraFrames++
            if (value.state === 'rendered' && value.steps === previous.steps) stoppedRenderedFrames++
            previous = value
        }
        const cleanup = await page.evaluate(() => window.__FLOW_FIELD_PROOF__.dispose())
        const final = await page.evaluate(() => {
            const f = window.__FLOW_FIELD_PROOF__.facts()
            return {window:f.temporalWindow, activeTasks:f.workers.activeTaskCount}
        })
        const result = {
            gesture,
            durationMs:end.wallTime - start.wallTime,
            submittedFrames:end.submitted - start.submitted,
            observedFrames:end.observed - start.observed,
            uniqueSubmitted:measured.uniqueSubmitted.length,
            uniqueObserved:measured.uniqueObserved.length,
            renderedFrames:rendered.length,
            incompleteFrames:rendered.filter(value => !value.complete).length,
            changedCameraFrames,
            stoppedRenderedFrames,
            simulationSteps:end.steps - start.steps,
            stepsPerSubmittedFrame:(end.steps - start.steps) / (end.submitted - start.submitted),
            advancingRenderedFraction:1 - stoppedRenderedFrames / rendered.length,
            resetDelta:end.resets - start.resets,
            clearedFrames:records.filter(value => value.cleared).length,
            pairChanged:records.some(value => value.pair !== start.pair),
            maximumOwned:Math.max(start.owned, ...records.map(value => value.owned)),
            pitchRange:[Math.min(...rendered.map(value => value.pitch)), Math.max(...rendered.map(value => value.pitch))],
            zoomRange:[Math.min(...rendered.map(value => value.zoom)), Math.max(...rendered.map(value => value.zoom))],
            requests:{count:requests.length, uniqueCount:new Set(requests).size},
            cleanupFailures:cleanup.cleanupFailures,
            final,
            errors,
        }
        results.push(result)
        console.log(JSON.stringify({status:'observed', ...result}))
        await page.close()
    }

    // Assert after recording every gesture, so the old implementation's red run
    // still reports stationary, pan, pitch and wheel evidence independently.
    for (const result of results) {
        const label = result.gesture
        assert.ok(result.renderedFrames >= 20, `${label}: collect enough distinct rendered frames`)
        assert.ok(result.uniqueSubmitted >= 20 && result.uniqueObserved >= 20,
            `${label}: observe actual submissions and native completion`)
        assert.ok(result.stepsPerSubmittedFrame > 0.85,
            `${label}: only ${result.stepsPerSubmittedFrame.toFixed(3)} particle steps per submitted frame`)
        assert.ok(result.advancingRenderedFraction > 0.85,
            `${label}: ${result.stoppedRenderedFrames}/${result.renderedFrames} rendered frames froze simulation`)
        if (label === 'stationary') assert.equal(result.changedCameraFrames, 0)
        else assert.ok(result.changedCameraFrames > result.renderedFrames * 0.3,
            `${label}: the camera must actually change throughout the measured gesture`)
        if (label === 'pitch') assert.ok(result.pitchRange[1] - result.pitchRange[0] > 0.8)
        if (label.startsWith('wheel')) assert.ok(result.zoomRange[1] - result.zoomRange[0] > 0.15)
        assert.equal(result.resetDelta, 0, `${label}: camera input must not reset the particle pool`)
        assert.equal(result.clearedFrames, 0, `${label}: camera input must not clear the history`)
        assert.equal(result.pairChanged, label === 'wheel-time',
            `${label}: only the default-rate wheel run must cross a temporal handoff`)
        assert.ok(result.maximumOwned <= 4)
        assert.deepEqual(result.cleanupFailures, [])
        assert.equal(result.final.window.ownedRuntimeCount, 0)
        assert.equal(result.final.window.pendingCreationCount, 0)
        assert.equal(result.final.window.activeCaptureCount, 0)
        assert.equal(result.final.activeTasks, 0)
        assert.deepEqual(result.errors, [])
    }
    console.log(JSON.stringify({status:'passed', gestures:results.map(value => value.gesture)}))
} finally {
    await browser.close()
}
