import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'

const base = process.env.FLOW_BOUNDARY_AB_BASE ?? 'http://127.0.0.1:5173'
const output = process.env.FLOW_BOUNDARY_AB_OUTPUT ?? '/tmp/flow-field-boundary-ab'
const deviceScaleFactor = Number(process.env.FLOW_BOUNDARY_AB_DPR ?? 2)
assert.ok(Number.isFinite(deviceScaleFactor) && deviceScaleFactor > 0 && deviceScaleFactor <= 4,
    'FLOW_BOUNDARY_AB_DPR must be positive and at most four')
await mkdir(output, {recursive:true})
const browser = await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-webgpu']})
const errors = []
try {
    let page
    const attempts = []
    for (const zoom of [12]) {
        page = await browser.newPage({viewport:{width:1440,height:900},deviceScaleFactor})
        page.on('pageerror', error => errors.push(error.message))
        page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
        // A fixed constructor camera keeps cross-run GPU measurements comparable.
        // An initial drag's inertia varies with load and changes covered source cells.
        await page.route('**/flowField/map.ts*', async route => {
            const response = await route.fetch(), body = await response.text()
            assert.ok(body.includes('center: FLOW_FIELD_MAP_DEFAULTS.center'))
            await route.fulfill({response,body:body.replace('center: FLOW_FIELD_MAP_DEFAULTS.center',
                'center: [121.05903696380413, 31.742548034700167]')})
        })
        await page.goto(`${base}/flowField/index.html?proof=1&rate=0.001&zoom=${zoom}`)
        await page.waitForFunction(() => {
            const f = window.__FLOW_FIELD_PROOF__?.facts()
            return document.body.dataset.status === 'error' ||
                (f?.lastFrame.presentationReady && f.renderer.particles.encodedSteps >= 60)
        },undefined,{timeout:90000})
        assert.equal(await page.locator('body').getAttribute('data-status'),'ready')
        const preview = await page.screenshot({style:'#FlowFieldControls,.maplibregl-control-container{visibility:hidden!important}'})
        const colored = await coloredPixels(page,preview)
        attempts.push({zoom,colored})
        if (colored >= 500 || zoom === 12) {
            assert.ok(colored >= 500,'The A/B camera must contain visible flow')
            break
        }
        const cleanup = await page.evaluate(() => window.__FLOW_FIELD_PROOF__.dispose())
        assert.deepEqual(cleanup.cleanupFailures,[])
        await page.close()
    }
    await page.waitForFunction(() => {
        const f = window.__FLOW_FIELD_PROOF__.facts()
        return f.lastFrame.presentationReady && !f.lastFrame.history?.cameraChanged &&
            f.workers.activeTaskCount === 0
    },undefined,{timeout:60000})
    const control = name => page.locator(`[data-flow-control="${name}"]`)
    async function facts() {
        return await page.evaluate(() => {
            const f = window.__FLOW_FIELD_PROOF__.facts(), frame = f.lastFrame
            return {
                modelTime:f.timeline.modelTime, playing:f.timeline.playing,
                frame:f.renderer.frameCount, observed:f.frames.observedFrameCount,
                steps:f.renderer.particles.encodedSteps, resets:f.renderer.particles.resetCount,
                boundary:f.renderer.history.boundary,
                sdfPresentationCount:f.renderer.history.sdfPresentationCount,
                sdfFeatherTexels:f.renderer.history.sdfFeatherTexels,
                sdfExtraTextureBytes:f.renderer.history.sdfExtraTextureBytes,
                resizeGeneration:f.renderer.history.resizeGeneration,
                size:{...f.renderer.history.size},
                historyCleared:frame.history?.cleared,
                camera:JSON.stringify([frame.view?.clipFromRelativeWorld,
                    frame.view?.cameraHigh,frame.view?.cameraLow,frame.view?.referenceViewport]),
                zoom:frame.view?.zoomHint, pitch:frame.view?.cameraPitchRadians,
                pair:f.temporalWindow.pairGeneration, ready:frame.presentationReady,
            }
        })
    }
    async function screenshot(name) {
        const before = await facts()
        const path = `${output}/${name}.png`
        const png = await page.screenshot({path,style:'#FlowFieldControls,.maplibregl-control-container{visibility:hidden!important}'})
        const colored = await coloredPixels(page,png)
        assert.ok(colored>50,`${name}: the centered screenshot must contain flow`)
        const after = await facts()
        assert.equal(after.camera,before.camera,'Each comparison screenshot uses a stationary camera')
        assert.equal(after.modelTime,before.modelTime,'Model time is held for the comparison screenshot')
        return {path,colored,before,after}
    }
    async function waitBoundary(boundary) {
        await page.waitForFunction(boundary => {
            const f = window.__FLOW_FIELD_PROOF__.facts()
            return f.renderer.history.boundary === boundary && f.lastFrame.presentationReady
        },boundary,{timeout:60000})
    }
    async function measure(label, action, {pausedClock = true, throughput = false} = {}) {
        await page.evaluate(() => {
            const f = window.__FLOW_FIELD_PROOF__.facts()
            const monitor = {start:performance.now(),steps:f.renderer.particles.encodedSteps,
                observed:f.frames.observedFrameCount,frame:f.renderer.frameCount,
                lastFrame:f.renderer.frameCount,clearedFrames:[],resets:new Set([f.renderer.particles.resetCount]),
                modelTimes:new Set([f.timeline.modelTime]),cameras:new Set(),stopped:false,handle:0}
            function poll() {
                const current = window.__FLOW_FIELD_PROOF__.facts(), frame = current.lastFrame
                if (current.renderer.frameCount !== monitor.lastFrame) {
                    if (frame.history?.cleared) monitor.clearedFrames.push(current.renderer.frameCount)
                    monitor.resets.add(current.renderer.particles.resetCount)
                    monitor.modelTimes.add(current.timeline.modelTime)
                    monitor.cameras.add(JSON.stringify([frame.view?.clipFromRelativeWorld,
                        frame.view?.cameraHigh,frame.view?.cameraLow]))
                    monitor.lastFrame = current.renderer.frameCount
                }
                if (!monitor.stopped) monitor.handle = requestAnimationFrame(poll)
            }
            monitor.finish = () => {
                monitor.stopped = true
                cancelAnimationFrame(monitor.handle)
                poll()
                const current = window.__FLOW_FIELD_PROOF__.facts()
                const elapsed = performance.now()-monitor.start
                return {
                    elapsedMs:elapsed,steps:current.renderer.particles.encodedSteps-monitor.steps,
                    observedFrames:current.frames.observedFrameCount-monitor.observed,
                    renderedFrames:current.renderer.frameCount-monitor.frame,
                    clearedFrames:monitor.clearedFrames,resetCounts:[...monitor.resets],
                    modelTimes:[...monitor.modelTimes],uniqueCameras:monitor.cameras.size,
                }
            }
            window.__FLOW_BOUNDARY_AB_MONITOR__ = monitor
            monitor.handle = requestAnimationFrame(poll)
        })
        await action()
        const measurement = await page.evaluate(() => {
            const result = window.__FLOW_BOUNDARY_AB_MONITOR__.finish()
            delete window.__FLOW_BOUNDARY_AB_MONITOR__
            return result
        })
        assert.ok(measurement.steps > 0,`${label}: the action must admit at least one particle step`)
        assert.deepEqual(measurement.clearedFrames,[],`${label}: must not clear history`)
        assert.equal(measurement.resetCounts.length,1,`${label}: must not reset particles`)
        if (pausedClock) assert.equal(measurement.modelTimes.length,1,`${label}: model time remains paused`)
        const {modelTimes,...observed} = measurement
        const result = {label,...observed,modelTimeRange:[Math.min(...modelTimes),Math.max(...modelTimes)]}
        if (throughput) {
            result.stepsPerSecond = measurement.steps*1000/measurement.elapsedMs
            result.minimumStepsPerSecond = 15
            assert.ok(result.stepsPerSecond>15,`${label}: playing throughput must exceed 15 steps/s, not a single admitted step`)
            assert.ok(modelTimes.length>1,`${label}: throughput must be measured while the model clock plays`)
            assert.equal(measurement.uniqueCameras,1,`${label}: throughput uses one fixed camera`)
        }
        return result
    }

    assert.equal(await control('boundary').inputValue(),'hard','A is the default')
    assert.equal(await control('boundary').isDisabled(),false)
    assert.equal(await control('feather').isDisabled(),true)
    assert.equal(await control('feather').inputValue(),'0.25')
    const beforePause = await facts()
    const aAdmission = await measure('Pause at A',async () => {
        await control('play-pause').click()
        await page.waitForFunction(before => {
            const f = window.__FLOW_FIELD_PROOF__.facts()
            return !f.timeline.playing && f.renderer.particles.encodedSteps>before.steps &&
                f.frames.observedFrameCount>before.observed
        },beforePause)
    },{pausedClock:false})
    const paused = await facts()
    assert.equal(paused.boundary,'hard')
    assert.equal(paused.sdfExtraTextureBytes,0)
    const a = await screenshot('a-hard')
    const bAdmission = await measure('Paused A to B',async () => {
        await control('boundary').selectOption('sdf')
        await waitBoundary('sdf')
        await page.waitForTimeout(150)
    })
    const b = await screenshot('b-sdf')
    assert.equal(b.after.playing,false)
    assert.ok(b.after.steps>a.after.steps,'The paused B toggle admits a particle step; it does not imply autonomous animation')
    assert.ok(b.after.sdfPresentationCount>a.after.sdfPresentationCount)
    assert.equal(b.after.sdfExtraTextureBytes,0)
    assert.equal(await control('feather').isDisabled(),false)
    const featherChecks = []
    for (const width of [0.05,0.35,0.25]) {
        const admission = await measure(`Paused feather ${width}`,async () => {
            await page.evaluate(width => {
                const slider = document.querySelector('[data-flow-control="feather"]')
                slider.valueAsNumber = width
                slider.dispatchEvent(new Event('input',{bubbles:true}))
            },width)
            await page.waitForFunction(width => {
                const f = window.__FLOW_FIELD_PROOF__.facts()
                return f.renderer.history.boundary==='sdf' &&
                    f.renderer.history.sdfFeatherTexels===width && f.lastFrame.presentationReady
            },width)
            await page.waitForTimeout(100)
        })
        const observed = await facts()
        assert.equal(observed.sdfFeatherTexels,width)
        assert.equal(observed.resets,paused.resets)
        assert.equal(observed.historyCleared,false)
        assert.equal(observed.modelTime,paused.modelTime)
        assert.equal(observed.camera,paused.camera)
        assert.equal(await control('feather-value').textContent(),`${width.toFixed(2)} texel`)
        assert.equal(await control('feather').getAttribute('aria-valuetext'),`${width.toFixed(2)} source texel`)
        await screenshot(`b-sdf-feather-${width}`)
        featherChecks.push({width,admission,observed})
    }
    await page.screenshot({path:`${output}/feather-controls.png`})
    const returnAdmission = await measure('Paused B to A',async () => {
        await control('boundary').selectOption('hard')
        await waitBoundary('hard')
        await page.waitForTimeout(150)
    })
    const returned = await screenshot('a-hard-return')
    assert.equal(await control('feather').isDisabled(),true)
    assert.equal(await control('feather').inputValue(),'0.25')
    for (const shot of [a,b,returned]) {
        assert.equal(shot.after.modelTime,paused.modelTime)
        assert.equal(shot.after.camera,paused.camera)
        assert.equal(shot.after.resets,paused.resets,'A-B-A is not a particle reset')
        assert.equal(shot.after.pair,paused.pair,'A-B-A is not a temporal seek')
    }

    // FPS evidence comes only from playing, stationary-camera intervals. The
    // paused toggles above deliberately test admission, not continuous cadence.
    await control('rate').selectOption('0.001')
    await control('play-pause').click()
    await page.waitForFunction(() => window.__FLOW_FIELD_PROOF__.facts().timeline.playing)
    await waitBoundary('hard')
    const aPerformance = await measure('A playing stationary',async () => {
        await page.waitForTimeout(2000)
    },{pausedClock:false,throughput:true})
    await control('boundary').selectOption('sdf')
    await waitBoundary('sdf')
    const bPerformance = await measure('B playing stationary',async () => {
        await page.waitForTimeout(2000)
    },{pausedClock:false,throughput:true})
    await control('play-pause').click()
    await page.waitForFunction(() => !window.__FLOW_FIELD_PROOF__.facts().timeline.playing)

    await control('boundary').selectOption('sdf')
    await waitBoundary('sdf')
    // Preserve a non-default width through diagnostic views; B must remain off
    // there even though the user's particle-display preference remains 0.35.
    const retainedFeather = await measure('Paused feather retained across views',async () => {
        await page.evaluate(() => {
            const slider = document.querySelector('[data-flow-control="feather"]')
            slider.valueAsNumber = 0.35
            slider.dispatchEvent(new Event('input',{bubbles:true}))
        })
        await page.waitForFunction(() => window.__FLOW_FIELD_PROOF__.facts().renderer.history.sdfFeatherTexels===0.35)
    })
    await control('view').selectOption('status')
    await waitBoundary('hard')
    assert.equal(await control('boundary').isDisabled(),true)
    assert.equal(await control('boundary').inputValue(),'sdf','Inspection preserves the selection but does not apply B')
    assert.equal(await control('feather').isDisabled(),true)
    assert.equal(await control('feather').inputValue(),'0.35')
    assert.ok((await control('legend').textContent()).includes('Unfiltered diagnostics'))
    const status = await facts()
    await page.waitForTimeout(200)
    assert.equal((await facts()).sdfPresentationCount,status.sdfPresentationCount,'Sample status must not use the SDF final pass')
    await control('view').selectOption('particles')
    await waitBoundary('sdf')
    assert.equal(await control('boundary').isDisabled(),false)
    assert.equal(await control('boundary').inputValue(),'sdf')
    assert.equal(await control('feather').isDisabled(),false)
    assert.equal(await control('feather').inputValue(),'0.35')
    assert.equal((await facts()).sdfFeatherTexels,0.35)
    // The view-mode change intentionally resets the pool. Begin camera checks
    // only after that reset has been applied; camera input itself must not reset.
    await page.waitForTimeout(200)
    // Exercise SDF draw ownership through ordinary prepared-BindSet replacement,
    // not a seek or an artificially fast clock. The camera remains stationary.
    const beforeHandoff = await facts()
    await control('rate').selectOption('1')
    await control('play-pause').click()
    const handoff = await page.evaluate(async () => {
        const started = performance.now(), first = window.__FLOW_FIELD_PROOF__.facts()
        const startSdf = first.renderer.history.sdfPresentationCount
        const initialReset = first.renderer.particles.resetCount
        const observedPairs = [], pairKeys = new Set(), resetCounts = new Set([initialReset])
        let maximumOwned = 0
        return await new Promise(resolve => {
            function sample() {
                const f = window.__FLOW_FIELD_PROOF__.facts(), frame = f.lastFrame
                maximumOwned = Math.max(maximumOwned,
                    f.temporalWindow.ownedRuntimeCount + f.temporalWindow.pendingCreationCount)
                resetCounts.add(f.renderer.particles.resetCount)
                if (frame.state === 'rendered' && f.renderer.history.boundary === 'sdf') {
                    const key = `${frame.temporal.lowerSampleKey}/${frame.temporal.upperSampleKey}`
                    if (!pairKeys.has(key)) {
                        pairKeys.add(key)
                        observedPairs.push({key,modelTime:frame.temporal.presentedModelTime,
                            sdfPresentationCount:f.renderer.history.sdfPresentationCount,
                            resets:f.renderer.particles.resetCount})
                    }
                }
                if (performance.now()-started >= 3500) {
                    resolve({elapsedMs:performance.now()-started,observedPairs,maximumOwned,
                        resetCounts:[...resetCounts],sdfStart:startSdf,
                        sdfEnd:f.renderer.history.sdfPresentationCount,
                        startModelTime:first.timeline.modelTime,endModelTime:f.timeline.modelTime,
                        stepDelta:f.renderer.particles.encodedSteps-first.renderer.particles.encodedSteps})
                } else requestAnimationFrame(sample)
            }
            sample()
        })
    })
    assert.ok(handoff.observedPairs.length>=3,'B must render at least two natural time-pair handoffs')
    assert.deepEqual(handoff.resetCounts,[beforeHandoff.resets],'Natural handoff must retain the particle pool')
    assert.ok(handoff.maximumOwned<=4,'SDF prepared-BindSet captures must respect the runtime budget')
    assert.ok(handoff.sdfEnd>handoff.sdfStart)
    assert.ok(handoff.stepDelta>0)
    assert.ok(handoff.endModelTime>handoff.startModelTime+2)
    for (let index=1;index<handoff.observedPairs.length;index++) {
        assert.ok(handoff.observedPairs[index].sdfPresentationCount>
            handoff.observedPairs[index-1].sdfPresentationCount)
    }
    await control('play-pause').click()
    await page.waitForFunction(() => !window.__FLOW_FIELD_PROOF__.facts().timeline.playing)
    await waitBoundary('sdf')
    const beforeCamera = await facts()
    const pitchCheck = await measure('B continuous pitch',async () => {
        await page.mouse.move(550,500)
        await page.mouse.down({button:'right'})
        for (let index=1;index<=72;index++) {
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)))
            await page.mouse.move(550,500-105*index/72)
        }
        await page.mouse.up({button:'right'})
    })
    const wheelCheck = await measure('B continuous wheel',async () => {
        await page.mouse.move(550,400)
        for (let index=0;index<48;index++) {
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)))
            await page.mouse.wheel(0,index<24?-12:12)
        }
    })
    const afterCamera = await facts()
    assert.ok(pitchCheck.uniqueCameras>1)
    assert.ok(wheelCheck.uniqueCameras>1)
    assert.equal(afterCamera.resets,beforeCamera.resets)
    assert.equal(afterCamera.pair,beforeCamera.pair)
    assert.equal(afterCamera.modelTime,beforeCamera.modelTime)
    // Resizing legitimately invalidates history storage. Unlike A/B toggles,
    // this section permits clearing/reset, and checks both borrowed history
    // BindSets are prepared again before the SDF presentation continues.
    const resizes = []
    for (const viewport of [{width:1280,height:800},{width:1440,height:900}]) {
        const before = await facts()
        await page.setViewportSize(viewport)
        await page.waitForFunction(({generation,steps,width,height}) => {
            const f = window.__FLOW_FIELD_PROOF__.facts()
            return f.renderer.history.resizeGeneration>generation &&
                f.renderer.history.size.width===width && f.renderer.history.size.height===height &&
                f.renderer.history.boundary==='sdf' && f.lastFrame.presentationReady &&
                f.renderer.particles.encodedSteps>steps
        },{generation:before.resizeGeneration,steps:before.steps,
            width:Math.round(viewport.width*deviceScaleFactor),height:Math.round(viewport.height*deviceScaleFactor)},
        {timeout:60000})
        await page.waitForTimeout(200)
        const after = await facts()
        assert.equal(after.boundary,'sdf')
        assert.ok(after.sdfPresentationCount>before.sdfPresentationCount)
        assert.ok(after.steps>before.steps)
        assert.equal(after.modelTime,before.modelTime)
        assert.equal(after.sdfExtraTextureBytes,0)
        resizes.push({viewport,before,after})
    }
    const cleanup = await page.evaluate(() => window.__FLOW_FIELD_PROOF__.dispose())
    assert.deepEqual(cleanup.cleanupFailures,[])
    const final = await page.evaluate(() => {
        const f = window.__FLOW_FIELD_PROOF__.facts()
        return {window:f.temporalWindow,activeTasks:f.workers.activeTaskCount,history:f.renderer.history}
    })
    assert.equal(final.window.ownedRuntimeCount,0)
    assert.equal(final.window.pendingCreationCount,0)
    assert.equal(final.window.activeCaptureCount,0)
    assert.equal(final.activeTasks,0)
    assert.equal(final.history.disposed,true)
    assert.equal(final.history.sdfExtraTextureBytes,0)
    assert.deepEqual(errors,[])
    console.log(JSON.stringify({status:'passed',viewport:{width:1440,height:900},deviceScaleFactor,
        attempts,screenshots:[a,b,returned],
        comparison:'Fixed model time/camera; each display toggle may advance the admitted particle step, not bit-exact',
        admissionChecks:[aAdmission,bAdmission,returnAdmission],featherChecks,retainedFeather,
        performance:[aPerformance,bPerformance],cameraChecks:[pitchCheck,wheelCheck],
        statusView:status,handoff,afterCamera,resizes,final,errors}))
} finally {
    await browser.close()
}

async function coloredPixels(page, png) {
    return await page.evaluate(async b64 => {
        const image = new Image()
        image.src = `data:image/png;base64,${b64}`
        await image.decode()
        const canvas = document.createElement('canvas')
        canvas.width = image.width; canvas.height = image.height
        const context = canvas.getContext('2d')
        context.drawImage(image,0,0)
        const bytes = context.getImageData(0,0,image.width,image.height).data
        let count = 0
        for (let i=0;i<bytes.length;i+=4) {
            if (Math.max(bytes[i],bytes[i+1],bytes[i+2])-Math.min(bytes[i],bytes[i+1],bytes[i+2])>25) count++
        }
        return count
    },png.toString('base64'))
}
