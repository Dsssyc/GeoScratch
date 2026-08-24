import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const examplesRoot = resolve(repositoryRoot, 'examples')
const tileServerRoot = resolve(examplesRoot, 'underwaterTerrain/tile-server')
const viteEntry = resolve(repositoryRoot, 'node_modules/vite/bin/vite.js')
const workerBuildEntry = resolve(
    repositoryRoot,
    'packages/geoscratch/bin/geoscratch-worker.mjs'
)
const tileBuildEntry = resolve(tileServerRoot, '.venv/bin/dem-tile-build')
const tileServeEntry = resolve(tileServerRoot, '.venv/bin/dem-tile-serve')
const timeout = positiveInteger(
    process.env.UNDERWATER_TERRAIN_TILE_WIREFRAME_TIMEOUT_MS,
    120_000
)
const headless = process.env.UNDERWATER_TERRAIN_HEADLESS !== '0'
const viewportWidth = positiveInteger(
    process.env.UNDERWATER_TERRAIN_TILE_WIREFRAME_VIEWPORT_WIDTH,
    1280
)
const viewportHeight = positiveInteger(
    process.env.UNDERWATER_TERRAIN_TILE_WIREFRAME_VIEWPORT_HEIGHT,
    800
)
const outputDirectory = resolve(
    process.env.UNDERWATER_TERRAIN_TILE_WIREFRAME_OUTPUT ??
        '/tmp/geoscratch-underwater-terrain-inverse-cover'
)
const camera = Object.freeze({
    center: Object.freeze([ 120.980697, 31.684162 ]),
    zoom: 10,
    pitch: 0,
    bearing: 0,
})
const pitchedCamera = Object.freeze({
    ...camera,
    zoom: 10.25,
    pitch: 70,
    bearing: 90,
})
const oddParityTopDownCamera = Object.freeze({
    ...camera,
    zoom: 13.25,
    bearing: 180,
})
const oddParityPitchedCamera = Object.freeze({
    ...oddParityTopDownCamera,
    pitch: 70,
})
const pitchSweepCameras = Object.freeze({
    topDown: Object.freeze({ ...oddParityTopDownCamera, bearing: 0, pitch: 0 }),
    before60: Object.freeze({ ...oddParityTopDownCamera, bearing: 0, pitch: 59.9 }),
    at60: Object.freeze({ ...oddParityTopDownCamera, bearing: 0, pitch: 60 }),
    after60: Object.freeze({ ...oddParityTopDownCamera, bearing: 0, pitch: 60.1 }),
    high: Object.freeze({ ...oddParityTopDownCamera, bearing: 0, pitch: 70 }),
})
const vitePort = await findAvailablePort()
let tilePort = await findAvailablePort()
while (tilePort === vitePort) tilePort = await findAvailablePort()
const baseUrl = `http://127.0.0.1:${vitePort}`
const tileBaseUrl = `http://127.0.0.1:${tilePort}`

await mkdir(outputDirectory, { recursive: true })
let tileServer
let vite
let browser
let proof
let browserVersion
let fatalError
const cleanupFailures = []

try {
    await runCommand('npm', [ '--workspace', 'geoscratch', 'run', 'build' ], repositoryRoot)
    await runCommand(process.execPath, [
        workerBuildEntry,
        'build',
        '--config',
        './worker-modules.ts',
    ], examplesRoot)
    await runCommand(tileBuildEntry, [], tileServerRoot)
    tileServer = startProcess(tileServeEntry, [ '--port', String(tilePort) ], tileServerRoot)
    await waitForHttpProcess(tileServer, `${tileBaseUrl}/health`, 'DEM tile server')
    vite = startProcess(process.execPath, [
        viteEntry,
        '--host',
        '127.0.0.1',
        '--port',
        String(vitePort),
        '--strictPort',
    ], examplesRoot)
    await waitForHttpProcess(vite, `${baseUrl}/underwaterTerrain/`, 'Vite')
    browser = await chromium.launch({
        channel: 'chrome',
        headless,
        args: [ '--enable-unsafe-webgpu' ],
    })
    browserVersion = await browser.version()
    proof = Object.freeze({
        ...await runProof(browser),
        dprInvariance: await runDprInvariance(browser),
    })
} catch (error) {
    fatalError = serializeError(error)
} finally {
    await cleanup('Chrome', async() => {
        if (browser !== undefined) await browser.close()
    })
    await cleanup('Vite', async() => {
        if (vite !== undefined) await stopProcess(vite, 'Vite')
    })
    await cleanup('DEM tile server', async() => {
        if (tileServer !== undefined) await stopProcess(tileServer, 'DEM tile server')
    })
}

const processFacts = {
    browserClosed: browser === undefined || !browser.isConnected(),
    viteClosed: !await canConnect(vitePort),
    tileServerClosed: !await canConnect(tilePort),
}
const failures = validateProof(proof, processFacts)
if (fatalError !== undefined) failures.unshift(`browser proof failed: ${fatalError}`)
failures.push(...cleanupFailures)
const result = {
    schemaVersion: 2,
    status: failures.length === 0 ? 'passed' : 'failed',
    headed: !headless,
    browserVersion,
    baseUrl,
    tileBaseUrl,
    outputDirectory,
    proof,
    processFacts,
    fatalError,
    cleanupFailures,
    failures,
    processOutput: failures.length === 0 ? undefined : {
        tileServer: processOutput(tileServer),
        vite: processOutput(vite),
    },
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
if (failures.length > 0) process.exitCode = 1

async function runProof(activeBrowser) {

    const context = await activeBrowser.newContext({
        viewport: { width: viewportWidth, height: viewportHeight },
        deviceScaleFactor: 1,
    })
    const page = await context.newPage()
    const events = observePage(page)
    try {
        await page.goto(
            `${baseUrl}/underwaterTerrain/?proof=1&cache=none&tileServer=${encodeURIComponent(
                tileBaseUrl
            )}`,
            { waitUntil: 'domcontentloaded', timeout }
        )
        await page.locator('#GPUFrame[data-status="ready"]').waitFor({ timeout })
        let previous = await readFacts(page)

        const baseline = await settle(page, 'shaded', previous.observedFrames, camera)
        const shadedCapture = await capture(page, 'shaded')
        previous = baseline

        const pitchedShaded = await settle(
            page,
            'shaded',
            previous.observedFrames,
            pitchedCamera
        )
        const shadedTracking = await cameraTracking(page, pitchedCamera)
        previous = await settle(
            page,
            'shaded',
            pitchedShaded.observedFrames,
            shadedTracking.finalCamera
        )

        await page.locator(
            '[data-underwater-terrain-control="tile-wireframe"] .tp-ckbv_w'
        ).click()
        const wireframe = await settle(
            page,
            'tile-wireframe',
            previous.observedFrames,
            pitchedCamera
        )
        const wireframeCapture = await capture(page, 'wireframe')
        const wireframeTracking = await cameraTracking(page, pitchedCamera)
        previous = await settle(
            page,
            'tile-wireframe',
            wireframe.observedFrames,
            wireframeTracking.finalCamera
        )

        const canonical = []
        for (const approachZoom of [ 9.5, 11 ]) {
            const approach = Object.freeze({ ...camera, zoom: approachZoom })
            previous = await settle(
                page,
                'tile-wireframe',
                previous.observedFrames,
                approach
            )
            const target = Object.freeze({ ...camera, zoom: 10.25 })
            previous = await settle(
                page,
                'tile-wireframe',
                previous.observedFrames,
                target
            )
            canonical.push(Object.freeze({
                ...previous,
                capture: await capture(page, `canonical-${approachZoom}`),
            }))
        }

        const zoomSamples = []
        for (const zoom of [ 10, 11, 12, 13, 14 ]) {
            previous = await settle(
                page,
                'tile-wireframe',
                previous.observedFrames,
                Object.freeze({ ...camera, zoom })
            )
            zoomSamples.push(previous)
        }

        const pitchSweep = {}
        for (const [ label, pitchCamera ] of Object.entries(pitchSweepCameras)) {
            previous = await settle(
                page,
                'tile-wireframe',
                previous.observedFrames,
                pitchCamera
            )
            pitchSweep[label] = Object.freeze({
                ...previous,
                ...(label === 'topDown' ? {
                    capture: await capture(page, 'wide-top-down'),
                } : {}),
            })
        }
        const continuousPitchSweep = []
        for (let pitch = 0; pitch <= 85; pitch++) {
            previous = await settle(
                page,
                'tile-wireframe',
                previous.observedFrames,
                Object.freeze({ ...camera, pitch })
            )
            continuousPitchSweep.push(Object.freeze({
                pitch,
                patchCount: previous.coverPatchCount,
                levelRange: previous.coverLevelRange,
                descriptorOverflowCount:
                    previous.coverFeedback?.descriptorOverflowCount,
                lookupOverflowCount: previous.coverFeedback?.lookupOverflowCount,
                maximumAdjacentLevelDelta:
                    previous.coverFeedback?.maximumAdjacentLevelDelta,
            }))
        }
        previous = await settle(
            page,
            'tile-wireframe',
            previous.observedFrames,
            Object.freeze({ ...oddParityTopDownCamera, bearing: 0 })
        )
        const oddParityBearingZero = Object.freeze({
            ...previous,
            capture: await capture(page, 'odd-parity-bearing-0'),
        })
        previous = await settle(
            page,
            'tile-wireframe',
            previous.observedFrames,
            oddParityTopDownCamera
        )
        const oddParityDirect = Object.freeze({
            ...previous,
            capture: await capture(page, 'odd-parity-direct'),
        })
        previous = await settle(
            page,
            'tile-wireframe',
            previous.observedFrames,
            oddParityPitchedCamera
        )
        previous = await settle(
            page,
            'tile-wireframe',
            previous.observedFrames,
            oddParityTopDownCamera
        )
        const oddParityReturned = Object.freeze({
            ...previous,
            capture: await capture(page, 'odd-parity-returned'),
        })
        const oddParityTopDown = Object.freeze({
            bearingZero: oddParityBearingZero,
            direct: oddParityDirect,
            returned: oddParityReturned,
        })

        await page.locator(
            '[data-underwater-terrain-control="tile-wireframe"] .tp-ckbv_w'
        ).click()
        const restored = await settle(
            page,
            'shaded',
            previous.observedFrames,
            camera
        )
        const restoredCapture = await capture(page, 'restored')
        return Object.freeze({
            baseline: Object.freeze({ ...baseline, capture: shadedCapture }),
            pitchedShaded,
            wireframe: Object.freeze({ ...wireframe, capture: wireframeCapture }),
            canonical: Object.freeze(canonical),
            zoomSamples: Object.freeze(zoomSamples),
            pitchSweep: Object.freeze(pitchSweep),
            continuousPitchSweep: Object.freeze(continuousPitchSweep),
            oddParityTopDown,
            shadedTracking,
            wireframeTracking,
            restored: Object.freeze({ ...restored, capture: restoredCapture }),
            events,
        })
    } finally {
        await context.close()
    }
}

async function runDprInvariance(activeBrowser) {
    const viewport = Object.freeze({ width: 960, height: 640 })
    const samples = []
    for (const deviceScaleFactor of [ 1, 1.25, 1.5, 2, 3 ]) {
        const context = await activeBrowser.newContext({
            viewport,
            deviceScaleFactor,
        })
        const page = await context.newPage()
        const events = observePage(page)
        try {
            await page.goto(
                `${baseUrl}/underwaterTerrain/?proof=1&cache=none&tileServer=${encodeURIComponent(
                    tileBaseUrl
                )}`,
                { waitUntil: 'domcontentloaded', timeout }
            )
            await page.locator('#GPUFrame[data-status="ready"]').waitFor({ timeout })
            const initial = await readFacts(page)
            const settled = await settle(
                page,
                'shaded',
                initial.observedFrames,
                camera
            )
            const dimensions = await page.evaluate(() => {
                const canvas = document.querySelector('#GPUFrame')
                if (!(canvas instanceof HTMLCanvasElement)) {
                    throw new Error('Underwater Terrain DPR canvas is missing')
                }
                return {
                    devicePixelRatio,
                    client: [ canvas.clientWidth, canvas.clientHeight ],
                    presentation: [ canvas.width, canvas.height ],
                }
            })
            const feedback = settled.coverFeedback
            const demandFeedback = settled.demandFeedback
            samples.push(Object.freeze({
                requestedDeviceScaleFactor: deviceScaleFactor,
                ...dimensions,
                referenceViewport: settled.cameraView?.referenceViewport,
                signature: Object.freeze({
                    candidateCount: feedback?.candidateCount,
                    patchCount: feedback?.patchCount,
                    minimumMatrixLevel: feedback?.minimumMatrixLevel,
                    maximumMatrixLevel: feedback?.maximumMatrixLevel,
                    finestMatrixLevel: feedback?.finestMatrixLevel,
                    maximumAdjacentLevelDelta: feedback?.maximumAdjacentLevelDelta,
                    demands: demandFeedback?.demands?.map(demand => [
                        demand.desiredSampleLevel,
                        demand.requestMatrixLevel,
                        demand.tileRow,
                        demand.tileCol,
                    ]),
                }),
                events,
            }))
        } finally {
            await context.close()
        }
    }
    return Object.freeze({ viewport, samples: Object.freeze(samples) })
}

async function settle(page, presentation, afterObservedFrames, nextCamera) {

    await page.evaluate(
        value => window.__UNDERWATER_TERRAIN_PROOF__.moveCamera(value),
        nextCamera
    )
    await page.waitForFunction(({ presentation, afterObservedFrames, nextCamera }) => {
        const canvas = document.querySelector('#GPUFrame')
        if (!(canvas instanceof HTMLCanvasElement)) return false
        const data = canvas.dataset
        const parse = value => {
            try { return JSON.parse(value ?? 'null') } catch { return null }
        }
        const cover = parse(data.coverFeedback)
        const demand = parse(data.demandFeedback)
        const raster = parse(data.virtualRaster)
        const observedCamera = parse(data.cameraView)
        const cameraMatches = observedCamera !== null &&
            Math.abs(observedCamera.zoom - nextCamera.zoom) < 1e-6 &&
            Math.abs(observedCamera.pitch - nextCamera.pitch) < 1e-6 &&
            Math.abs(observedCamera.bearing - nextCamera.bearing) < 1e-6
        const rasterIdle = raster?.residency?.stagedCount === 0 &&
            raster?.scheduler?.activeRequestCount === 0 &&
            raster?.scheduler?.queuedRequestCount === 0 &&
            raster?.worker?.pendingCandidateCount === 0 &&
            raster?.worker?.system?.activeTaskCount === 0 &&
            raster?.worker?.system?.queuedTaskCount === 0
        return data.status === 'ready' &&
            data.terrainPresentation === presentation &&
            Number(data.observedFrames) > afterObservedFrames &&
            Number(data.frames) === Number(data.observedFrames) &&
            Number(data.currentPendingNativeObservations) === 0 &&
            data.coverConverged === 'true' &&
            cover?.patchCount > 0 &&
            cover?.descriptorOverflowCount === 0 &&
            cover?.lookupOverflowCount === 0 &&
            demand?.overflowCount === 0 &&
            cover?.maximumAdjacentLevelDelta <= 1 &&
            data.uncapturedErrors === '0' &&
            data.deviceLosses === '0' &&
            cameraMatches && rasterIdle
    }, { presentation, afterObservedFrames, nextCamera }, { timeout })
    return readFacts(page)
}

async function readFacts(page) {

    return page.evaluate(() => {
        const canvas = document.querySelector('#GPUFrame')
        if (!(canvas instanceof HTMLCanvasElement)) {
            throw new Error('Underwater Terrain canvas is missing')
        }
        const parse = value => {
            try { return JSON.parse(value ?? 'null') } catch { return null }
        }
        const data = canvas.dataset
        const virtualRaster = parse(data.virtualRaster)
        const checkbox = document.querySelector(
            '[data-underwater-terrain-control="tile-wireframe"] input'
        )
        return {
            terrainPresentation: data.terrainPresentation,
            tileWireframeChecked: checkbox instanceof HTMLInputElement
                ? checkbox.checked
                : undefined,
            frames: Number(data.frames),
            observedFrames: Number(data.observedFrames),
            stableIdentityHash: data.currentStableIdentityHash,
            identityFacts: parse(data.currentIdentityFacts),
            persistentFacts: parse(data.persistentFacts),
            graphContract: parse(data.graphContract),
            coverFeedback: parse(data.coverFeedback),
            demandFeedback: parse(data.demandFeedback),
            coverLevelRange: parse(data.coverLevelRange),
            coverPatchCount: Number(data.coverPatchCount),
            sourceDemandCount: Number(data.sourceDemandCount),
            convergenceState: data.convergenceState,
            cameraView: parse(data.cameraView),
            virtualRaster: virtualRaster === null ? null : {
                residency: {
                    residentCount: virtualRaster.residency?.residentCount,
                    stagedCount: virtualRaster.residency?.stagedCount,
                    fallbackCount: virtualRaster.residency?.fallbackCount,
                },
                scheduler: {
                    activeRequestCount: virtualRaster.scheduler?.activeRequestCount,
                    queuedRequestCount: virtualRaster.scheduler?.queuedRequestCount,
                    completedRequestCount: virtualRaster.scheduler?.completedRequestCount,
                    cancellationCount: virtualRaster.scheduler?.cancellationCount,
                },
                worker: {
                    networkRequestCount: virtualRaster.worker?.networkRequestCount,
                    decodedPageCount: virtualRaster.worker?.decodedPageCount,
                    pendingCandidateCount: virtualRaster.worker?.pendingCandidateCount,
                },
            },
            diagnostics: {
                uncapturedErrors: Number(data.uncapturedErrors),
                deviceLosses: Number(data.deviceLosses),
                incidents: Number(data.diagnosticIncidents),
                bounded: data.diagnosticsBounded === 'true',
            },
        }
    })
}

async function cameraTracking(page, baseCamera) {

    return page.evaluate(async({ baseCamera, frameCount, longitudeStep }) => {
        const proof = window.__UNDERWATER_TERRAIN_PROOF__
        const canvas = document.querySelector('#GPUFrame')
        if (proof === undefined || !(canvas instanceof HTMLCanvasElement)) {
            throw new Error('Underwater Terrain tracking proof is unavailable')
        }
        proof.resetFrameTiming()
        const samples = []
        const frameIntervals = []
        let previousTimestamp
        let issuedIndex = -1
        await new Promise(resolve => {
            const tick = timestamp => {
                if (previousTimestamp !== undefined) {
                    frameIntervals.push(timestamp - previousTimestamp)
                }
                previousTimestamp = timestamp
                if (issuedIndex >= 0) {
                    const cameraView = JSON.parse(canvas.dataset.cameraView ?? 'null')
                    const submittedIndex = cameraView === null
                        ? -1
                        : Math.round(
                            (cameraView.center[0] - baseCamera.center[0]) / longitudeStep
                        )
                    samples.push({
                        issuedIndex,
                        submittedIndex,
                        lag: issuedIndex - submittedIndex,
                        inFlight: Number(canvas.dataset.frames) -
                            Number(canvas.dataset.observedFrames),
                        patchCount: Number(canvas.dataset.coverPatchCount),
                        candidateCount: Number(canvas.dataset.coverCandidateCount),
                        pendingNative: Number(canvas.dataset.currentPendingNativeObservations),
                    })
                }
                if (issuedIndex + 1 >= frameCount) {
                    resolve(undefined)
                    return
                }
                issuedIndex++
                proof.moveCamera({
                    ...baseCamera,
                    center: [
                        baseCamera.center[0] + longitudeStep * issuedIndex,
                        baseCamera.center[1],
                    ],
                })
                requestAnimationFrame(tick)
            }
            requestAnimationFrame(tick)
        })
        const finalCamera = {
            ...baseCamera,
            center: [
                baseCamera.center[0] + longitudeStep * (frameCount - 1),
                baseCamera.center[1],
            ],
        }
        const transitions = samples.filter((sample, index) =>
            index === 0 || sample.submittedIndex !== samples[index - 1].submittedIndex
        )
        const percentile = (values, fraction) => {
            const sorted = [ ...values ].sort((left, right) => left - right)
            return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0
        }
        return {
            frameCount,
            sampleCount: samples.length,
            finalCamera,
            frameIntervalP50Ms: percentile(frameIntervals, 0.5),
            frameIntervalP95Ms: percentile(frameIntervals, 0.95),
            lagP95: percentile(samples.map(sample => sample.lag), 0.95),
            maximumLag: Math.max(...samples.map(sample => sample.lag)),
            maximumInFlight: Math.max(...samples.map(sample => sample.inFlight)),
            submissionTransitionCount: transitions.length,
            staleTransitionCount: transitions.filter(
                sample => sample.submittedIndex !== sample.issuedIndex
            ).length,
            frameTiming: proof.frameTiming(),
        }
    }, {
        baseCamera,
        frameCount: 90,
        longitudeStep: 0.00002,
    })
}

async function capture(page, name) {

    await page.waitForTimeout(200)
    const pagePath = resolve(outputDirectory, `${name}.png`)
    const canvasPath = resolve(outputDirectory, `${name}-canvas.png`)
    const pagePng = await page.screenshot({ path: pagePath })
    const canvasPng = await page.locator('#GPUFrame').screenshot({
        path: canvasPath,
        style: '#UnderwaterTerrainControlPanel { visibility: hidden !important; }',
    })
    const pixels = await analyzePng(page, canvasPng)
    return Object.freeze({
        page: { path: pagePath, sha256: sha256(pagePng), byteLength: pagePng.byteLength },
        canvas: {
            path: canvasPath,
            sha256: sha256(canvasPng),
            byteLength: canvasPng.byteLength,
        },
        pixels,
    })
}

async function analyzePng(page, png) {

    return page.evaluate(async base64 => {
        const image = new Image()
        image.src = `data:image/png;base64,${base64}`
        await image.decode()
        const canvas = document.createElement('canvas')
        canvas.width = image.width
        canvas.height = image.height
        const context = canvas.getContext('2d', { willReadFrequently: true })
        context.drawImage(image, 0, 0)
        const bytes = context.getImageData(0, 0, image.width, image.height).data
        let nonDark = 0
        let colored = 0
        const clusters = new Set()
        for (let index = 0; index < bytes.length; index += 4) {
            const red = bytes[index]
            const green = bytes[index + 1]
            const blue = bytes[index + 2]
            const maximum = Math.max(red, green, blue)
            const minimum = Math.min(red, green, blue)
            if (maximum > 24) nonDark++
            if (maximum > 70 && maximum - minimum > 24) {
                colored++
                clusters.add(
                    `${Math.floor(red / 32)}/${Math.floor(green / 32)}/${Math.floor(blue / 32)}`
                )
            }
        }
        return {
            width: image.width,
            height: image.height,
            nonDarkPixels: nonDark,
            coloredPixels: colored,
            coloredRatio: colored / (image.width * image.height),
            colorClusterCount: clusters.size,
        }
    }, png.toString('base64'))
}

function validateProof(value, processState) {

    const failures = []
    if (value === undefined) return [ 'Underwater Terrain inverse-cover proof was not produced' ]
    const {
        baseline,
        pitchedShaded,
        wireframe,
        canonical = [],
        zoomSamples = [],
        pitchSweep,
        continuousPitchSweep = [],
        oddParityTopDown,
        shadedTracking,
        wireframeTracking,
        restored,
        dprInvariance,
        events,
    } = value
    expect(failures,
        baseline?.terrainPresentation === 'shaded' &&
        wireframe?.terrainPresentation === 'tile-wireframe' &&
        restored?.terrainPresentation === 'shaded' &&
        wireframe.tileWireframeChecked === true &&
        restored.tileWireframeChecked === false,
    'presentation switching did not settle')
    expect(failures,
        baseline?.stableIdentityHash === wireframe?.stableIdentityHash &&
        wireframe?.stableIdentityHash === restored?.stableIdentityHash,
    'presentation switching changed persistent graph identity')
    expect(failures,
        baseline?.graphContract?.selectionPath ===
            'gpu-camera-inverse-webmercatorquad-cover' &&
        baseline.graphContract.sourceMaximumMatrixLevel === 10 &&
        baseline.graphContract.coverMaximumMatrixLevel === 14 &&
        baseline.graphContract.commandIds?.cover?.length === 2 &&
        baseline.graphContract.commandIds.cover.every(ids => ids.length === 2) &&
        baseline.graphContract.commandIds?.demandProjection?.length === 2 &&
        baseline.graphContract.commandIds.demandProjection.every(ids => ids.length === 3) &&
        baseline.graphContract.commandIds?.patchDraw?.length === 2,
    'graph contract does not expose the inverse-cover authority')

    const samples = [
        baseline,
        pitchedShaded,
        wireframe,
        ...canonical,
        ...zoomSamples,
        ...Object.values(pitchSweep ?? {}),
        oddParityTopDown?.bearingZero,
        oddParityTopDown?.direct,
        oddParityTopDown?.returned,
        restored,
    ]
    for (const [ index, sample ] of samples.entries()) {
        const feedback = sample?.coverFeedback
        const demandFeedback = sample?.demandFeedback
        expect(failures,
            feedback?.patchCount > 0 &&
            feedback.patchCount === sample.coverPatchCount &&
            feedback.descriptorOverflowCount === 0 &&
            feedback.lookupOverflowCount === 0 &&
            feedback.maximumAdjacentLevelDelta <= 1 &&
            demandFeedback?.overflowCount === 0 &&
            demandFeedback.sourceLevelCeiling === 10 &&
            demandFeedback.frameEpoch === feedback.frameEpoch &&
            demandFeedback.demandCount === sample.sourceDemandCount &&
            demandFeedback.demands.every(demand =>
                demand.requestMatrixLevel <= demand.sourceLevelCeiling
            ),
        `cover sample ${index} violated bounded standard-cover facts`)
        expect(failures,
            sample?.diagnostics?.uncapturedErrors === 0 &&
            sample?.diagnostics?.deviceLosses === 0 &&
            sample?.diagnostics?.incidents === 0 &&
            sample?.diagnostics?.bounded,
        `cover sample ${index} retained a WebGPU diagnostic failure`)
    }

    const signatures = canonical.map(sample => JSON.stringify({
        patchCount: sample.coverFeedback?.patchCount,
        candidateCount: sample.coverFeedback?.candidateCount,
        minimumMatrixLevel: sample.coverFeedback?.minimumMatrixLevel,
        maximumMatrixLevel: sample.coverFeedback?.maximumMatrixLevel,
        finestMatrixLevel: sample.coverFeedback?.finestMatrixLevel,
        maximumAdjacentLevelDelta: sample.coverFeedback?.maximumAdjacentLevelDelta,
        canvasHash: sample.capture?.canvas?.sha256,
    }))
    expect(failures,
        signatures.length === 2 && signatures[0] === signatures[1],
    `identical settled cameras produced different covers: ${JSON.stringify(signatures)}`)

    const zoomRegressions = zoomSamples.slice(1).flatMap((sample, index) => {
        const previous = zoomSamples[index]?.coverLevelRange
        const current = sample?.coverLevelRange
        return Array.isArray(previous) && Array.isArray(current) &&
            current[0] >= previous[0] && current[1] >= previous[1]
            ? []
            : [ { previous, current } ]
    })
    expect(failures,
        zoomSamples.length === 5 && zoomRegressions.length === 0,
    `zoom-in coarsened the inverse cover: ${JSON.stringify(zoomRegressions)}`)
    const nearSixty = [
        pitchSweep?.before60,
        pitchSweep?.at60,
        pitchSweep?.after60,
    ]
    const nearSixtyCounts = nearSixty.map(sample => sample?.coverPatchCount)
    const minimumNearSixtyCount = Math.min(...nearSixtyCounts)
    const maximumNearSixtyCount = Math.max(...nearSixtyCounts)
    expect(failures,
        nearSixty.every(sample =>
            sample?.coverFeedback?.selectionMode === undefined &&
            sample?.coverFeedback?.maximumAdjacentLevelDelta <= 1
        ) &&
        maximumNearSixtyCount - minimumNearSixtyCount <=
            Math.max(8, Math.ceil(minimumNearSixtyCount * 0.5)),
    `60-degree pitch sweep retained a mode cliff: ${JSON.stringify(nearSixtyCounts)}`)
    const continuousPitchRegressions = continuousPitchSweep.slice(1).flatMap(
        (sample, index) => sample.patchCount >= continuousPitchSweep[index].patchCount
            ? []
            : [ {
                previous: continuousPitchSweep[index],
                current: sample,
            } ]
    )
    expect(failures,
        continuousPitchSweep.length === 86 &&
        continuousPitchRegressions.length === 0 &&
        continuousPitchSweep.every(sample =>
            sample.patchCount > 0 && sample.patchCount <= 96 &&
            sample.descriptorOverflowCount === 0 &&
            sample.lookupOverflowCount === 0 &&
            sample.maximumAdjacentLevelDelta <= 1
        ),
    `continuous pitch coarsened or overflowed the cover: ${JSON.stringify(
        continuousPitchRegressions
    )}`)
    const oddBearingZero = oddParityTopDown?.bearingZero
    const oddDirect = oddParityTopDown?.direct
    const oddReturned = oddParityTopDown?.returned
    const oddSignature = sample => JSON.stringify({
        patchCount: sample?.coverFeedback?.patchCount,
        candidateCount: sample?.coverFeedback?.candidateCount,
        minimumMatrixLevel: sample?.coverFeedback?.minimumMatrixLevel,
        maximumMatrixLevel: sample?.coverFeedback?.maximumMatrixLevel,
        finestMatrixLevel: sample?.coverFeedback?.finestMatrixLevel,
        maximumAdjacentLevelDelta: sample?.coverFeedback?.maximumAdjacentLevelDelta,
    })
    expect(failures,
        oddSignature(oddBearingZero) === oddSignature(oddDirect),
    'odd-parity top-down cover changed under a 180-degree bearing')
    expect(failures,
        oddSignature(oddDirect) === oddSignature(oddReturned) &&
        oddDirect?.capture?.canvas?.sha256 === oddReturned?.capture?.canvas?.sha256,
    'odd-parity top-down cover depended on navigation history')
    expect(failures,
        oddDirect?.coverPatchCount > 0 && oddDirect.coverPatchCount <= 96 &&
        oddDirect.coverFeedback?.maximumAdjacentLevelDelta <= 1,
    'odd-parity top-down cover exceeded density or adjacency gates')
    expect(failures,
        pitchedShaded?.coverPatchCount <= 96 &&
        wireframe?.coverPatchCount <= 96,
    'pitched inverse cover exceeded its density gate')

    const dprSamples = dprInvariance?.samples ?? []
    const dprSignatures = dprSamples.map(sample => JSON.stringify(sample.signature))
    expect(failures,
        dprSamples.length === 5 && new Set(dprSignatures).size === 1,
    `DPR changed the settled cover or demand: ${JSON.stringify(dprSamples)}`)
    for (const sample of dprSamples) {
        const scale = sample.requestedDeviceScaleFactor
        expect(failures,
            Math.abs(sample.devicePixelRatio - scale) < 1e-6 &&
            sample.referenceViewport?.[0] === dprInvariance.viewport.width &&
            sample.referenceViewport?.[1] === dprInvariance.viewport.height &&
            sample.client?.[0] === dprInvariance.viewport.width &&
            sample.client?.[1] === dprInvariance.viewport.height &&
            sample.presentation?.[0] === Math.floor(dprInvariance.viewport.width * scale) &&
            sample.presentation?.[1] === Math.floor(dprInvariance.viewport.height * scale) &&
            unexpectedEvents(sample.events).length === 0,
        `DPR presentation/reference separation failed: ${JSON.stringify(sample)}`)
    }

    for (const [ name, tracking ] of [
        [ 'shaded', shadedTracking ],
        [ 'wireframe', wireframeTracking ],
    ]) {
        expect(failures,
            tracking?.frameCount === 90 &&
            tracking.sampleCount === 90 &&
            tracking.submissionTransitionCount >= 65 &&
            tracking.staleTransitionCount === 0 &&
            tracking.frameIntervalP95Ms <= 20 &&
            tracking.lagP95 <= 1 &&
            tracking.maximumLag <= 2 &&
            tracking.maximumInFlight <= 2 &&
            tracking.frameTiming?.construction?.p95Ms <= 4 &&
            tracking.frameTiming?.observation?.p95Ms <= 25,
        `${name} camera tracking exceeded latency gates: ${JSON.stringify(tracking)}`)
    }

    expect(failures,
        wireframe?.capture?.pixels?.coloredPixels > 2_000 &&
        wireframe.capture.pixels.colorClusterCount >= 4 &&
        wireframe.capture.pixels.coloredRatio > 0.002,
    `wireframe pixels did not prove multicolor standard tiles: ${JSON.stringify(
        wireframe?.capture?.pixels
    )}`)
    expect(failures,
        baseline?.capture?.pixels?.nonDarkPixels > 10_000 &&
        restored?.capture?.pixels?.nonDarkPixels > 10_000,
    'shaded terrain canvas was blank')
    expect(failures,
        events.tileRequestLevels.length > 0 &&
        events.tileRequestLevels.every(level => level <= 10),
    `source requests exceeded z10: ${JSON.stringify(events.tileRequestLevels)}`)
    expect(failures,
        unexpectedEvents(events).length === 0,
    `browser emitted failures: ${JSON.stringify(unexpectedEvents(events))}`)
    expect(failures,
        processState.browserClosed && processState.viteClosed && processState.tileServerClosed,
    'managed Chrome, Vite, or tile server remained reachable')
    return failures
}

function expect(failures, condition, message) {

    if (!condition) failures.push(message)
}

function observePage(page) {

    const events = {
        consoleFailures: [],
        pageErrors: [],
        requestFailures: [],
        cancelledTileRequests: [],
        tileRequestLevels: [],
    }
    page.on('console', message => {
        if (message.type() === 'error') events.consoleFailures.push(message.text())
    })
    page.on('pageerror', error => events.pageErrors.push(serializeError(error)))
    page.on('requestfailed', request => {
        const failure = {
            url: request.url(),
            errorText: request.failure()?.errorText,
        }
        const path = new URL(request.url()).pathname
        if (path.startsWith('/tiles/WebMercatorQuad/') &&
            /abort|cancel/i.test(failure.errorText ?? '')) {
            events.cancelledTileRequests.push(failure)
            return
        }
        events.requestFailures.push(failure)
    })
    page.on('response', response => {
        const match = new URL(response.url()).pathname.match(
            /\/tiles\/WebMercatorQuad\/(\d+)\//
        )
        if (match !== null) events.tileRequestLevels.push(Number(match[1]))
    })
    return events
}

function unexpectedEvents(events) {

    return [
        ...(events?.consoleFailures ?? []),
        ...(events?.pageErrors ?? []),
        ...(events?.requestFailures ?? []),
    ]
}

function sha256(value) {

    return createHash('sha256').update(value).digest('hex')
}

function runCommand(command, args, cwd) {

    return new Promise((resolvePromise, rejectPromise) => {
        const child = spawn(command, args, {
            cwd,
            env: process.env,
            stdio: [ 'ignore', 'pipe', 'pipe' ],
        })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', chunk => { stdout += chunk })
        child.stderr.on('data', chunk => { stderr += chunk })
        child.on('error', rejectPromise)
        child.on('exit', code => {
            if (code === 0) resolvePromise({ stdout, stderr })
            else rejectPromise(new Error(
                `${command} ${args.join(' ')} exited ${code}: ${stderr || stdout}`
            ))
        })
    })
}

function startProcess(command, args, cwd) {

    const child = spawn(command, args, {
        cwd,
        env: process.env,
        stdio: [ 'ignore', 'pipe', 'pipe' ],
    })
    const state = { child, stdout: '', stderr: '' }
    child.stdout.on('data', chunk => { state.stdout += chunk })
    child.stderr.on('data', chunk => { state.stderr += chunk })
    return state
}

async function waitForHttpProcess(state, url, label) {

    const startedAt = Date.now()
    while (Date.now() - startedAt < timeout) {
        if (state.child.exitCode !== null || state.child.signalCode !== null) {
            throw new Error(`${label} exited early: ${state.stderr || state.stdout}`)
        }
        try {
            const response = await fetch(url)
            if (response.ok) return
        } catch {
            // Startup polling continues until the bounded timeout.
        }
        await delay(100)
    }
    throw new Error(`${label} did not become ready at ${url}`)
}

async function stopProcess(state, label) {

    if (state.child.exitCode !== null || state.child.signalCode !== null) return
    state.child.kill('SIGTERM')
    await Promise.race([
        new Promise(resolvePromise => state.child.once('exit', resolvePromise)),
        delay(5_000).then(() => {
            if (state.child.exitCode === null && state.child.signalCode === null) {
                state.child.kill('SIGKILL')
            }
        }),
    ])
    if (state.child.exitCode === null && state.child.signalCode === null) {
        throw new Error(`${label} did not stop`)
    }
}

async function cleanup(label, action) {

    try {
        await action()
    } catch (error) {
        cleanupFailures.push(`${label} cleanup failed: ${serializeError(error)}`)
    }
}

function processOutput(state) {

    return state === undefined ? undefined : {
        stdout: state.stdout.slice(-8_000),
        stderr: state.stderr.slice(-8_000),
        exitCode: state.child.exitCode,
    }
}

function delay(milliseconds) {

    return new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds))
}

function positiveInteger(value, fallback) {

    const parsed = Number(value)
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

function serializeError(error) {

    return error instanceof Error
        ? `${error.name}: ${error.message}\n${error.stack ?? ''}`
        : String(error)
}

function findAvailablePort() {

    return new Promise((resolvePromise, rejectPromise) => {
        const server = createServer()
        server.unref()
        server.on('error', rejectPromise)
        server.listen(0, '127.0.0.1', () => {
            const address = server.address()
            const port = typeof address === 'object' && address !== null
                ? address.port
                : undefined
            server.close(error => {
                if (error !== undefined) rejectPromise(error)
                else if (port === undefined) rejectPromise(new Error('No available port'))
                else resolvePromise(port)
            })
        })
    })
}

function canConnect(port) {

    return new Promise(resolvePromise => {
        const socket = createConnection({ host: '127.0.0.1', port })
        socket.once('connect', () => {
            socket.destroy()
            resolvePromise(true)
        })
        socket.once('error', () => resolvePromise(false))
        socket.setTimeout(300, () => {
            socket.destroy()
            resolvePromise(false)
        })
    })
}
