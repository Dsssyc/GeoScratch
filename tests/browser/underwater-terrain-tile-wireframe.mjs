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
const headless = process.env.UNDERWATER_TERRAIN_HEADLESS === '1'
const outputDirectory = resolve(
    process.env.UNDERWATER_TERRAIN_TILE_WIREFRAME_OUTPUT ??
        '/tmp/geoscratch-underwater-terrain-tile-wireframe'
)
const renderingStorageKey = 'geoscratch.examples.underwaterTerrain.rendering.v1'
const camera = Object.freeze({
    center: Object.freeze([ 120.980697, 31.684162 ]),
    zoom: 10,
    pitch: 70,
    bearing: 90,
})
const vitePort = await findAvailablePort()
let tilePort = await findAvailablePort()
while (tilePort === vitePort) tilePort = await findAvailablePort()
const baseUrl = `http://127.0.0.1:${vitePort}`
const tileBaseUrl = `http://127.0.0.1:${tilePort}`

await mkdir(outputDirectory, { recursive: true })
let build
let tileServer
let vite
let browser
let browserVersion
let proof
let fatalError
const cleanupFailures = []

try {
    await runCommand(process.execPath, [
        workerBuildEntry,
        'build',
        '--config',
        './worker-modules.ts',
    ], examplesRoot)
    build = await runCommand(tileBuildEntry, [], tileServerRoot)
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
        ...await runWireframeProof(browser),
        zoomMonotonicity: await runZoomMonotonicityProof(browser),
    })
} catch (error) {
    fatalError = serializeError(error)
} finally {
    await cleanup('Chrome', async() => {
        if (browser !== undefined) await closeBrowser(browser)
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
    schemaVersion: 1,
    status: failures.length === 0 ? 'passed' : 'failed',
    headed: !headless,
    browserVersion,
    baseUrl,
    tileBaseUrl,
    outputDirectory,
    sourceHash: parseBuildHash(build?.stdout),
    camera,
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

async function runWireframeProof(activeBrowser) {

    const context = await activeBrowser.newContext({
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 1,
    })
    const page = await context.newPage()
    const events = observePage(page)
    try {
        const parameters = new URLSearchParams({
            proof: '1',
            cache: 'none',
            tileServer: tileBaseUrl,
        })
        await page.goto(`${baseUrl}/underwaterTerrain/?${parameters}`, {
            waitUntil: 'domcontentloaded',
            timeout,
        })
        await page.locator('#GPUFrame[data-status="ready"]').waitFor({ timeout })
        const loaded = await readFacts(page)
        await page.evaluate(value => window.__UNDERWATER_TERRAIN_PROOF__.moveCamera(value), camera)
        const baseline = await waitForStableMode(page, 'shaded', loaded.observedFrames)
        const shadedCapture = await captureState(page, 'shaded')

        await page.locator('[data-underwater-terrain-control="tile-wireframe"] .tp-ckbv_w').click()
        const wireframe = await waitForStableMode(
            page,
            'tile-wireframe',
            baseline.observedFrames,
            camera
        )
        const wireframeCapture = await captureState(page, 'tile-wireframe')

        const topDownCamera = Object.freeze({
            ...camera,
            zoom: 10.25,
            pitch: 0,
            bearing: 0,
        })
        const canonicalTopDown = []
        let previous = wireframe
        for (const [ name, zoom ] of [
            [ 'from-coarse', topDownCamera.zoom - 0.6 ],
            [ 'from-fine', topDownCamera.zoom + 0.6 ],
        ]) {
            const approachCamera = Object.freeze({ ...topDownCamera, zoom })
            await page.evaluate(
                value => window.__UNDERWATER_TERRAIN_PROOF__.moveCamera(value),
                approachCamera
            )
            const approached = await waitForStableMode(
                page,
                'tile-wireframe',
                previous.observedFrames,
                approachCamera
            )
            await page.evaluate(
                value => window.__UNDERWATER_TERRAIN_PROOF__.moveCamera(value),
                topDownCamera
            )
            const converged = await waitForStableMode(
                page,
                'tile-wireframe',
                approached.observedFrames,
                topDownCamera
            )
            const capture = await captureState(page, `canonical-top-down-${name}`)
            canonicalTopDown.push(Object.freeze({ ...converged, capture }))
            previous = converged
        }

        const cameraTracking = await runCameraTrackingProof(page, topDownCamera)
        const tracked = await waitForStableMode(
            page,
            'tile-wireframe',
            previous.observedFrames,
            cameraTracking.finalCamera
        )
        previous = tracked

        const motionStability = []
        const pitchedCamera = Object.freeze({ ...camera, pitch: 80 })
        for (const zoom of [ 10.02, 10.04, 10.06, 13.66, 13.70, 13.84 ]) {
            const motionCamera = Object.freeze({ ...pitchedCamera, zoom })
            await page.evaluate(
                value => window.__UNDERWATER_TERRAIN_PROOF__.moveCamera(value),
                motionCamera
            )
            const facts = await waitForStableMode(
                page,
                'tile-wireframe',
                previous.observedFrames,
                motionCamera
            )
            motionStability.push(facts)
            previous = facts
        }

        const pitchBudgetPriority = []
        for (const pitch of [ 55, 58, 61 ]) {
            const pitchCamera = Object.freeze({
                ...camera,
                zoom: 10,
                pitch,
                bearing: 90,
            })
            await page.evaluate(
                value => window.__UNDERWATER_TERRAIN_PROOF__.moveCamera(value),
                pitchCamera
            )
            const facts = await waitForStableMode(
                page,
                'tile-wireframe',
                previous.observedFrames,
                pitchCamera
            )
            pitchBudgetPriority.push(facts)
            previous = facts
        }

        const refinement = []
        for (const zoom of [ 11, 12, 14 ]) {
            const refinementCamera = Object.freeze({ ...camera, zoom })
            await page.evaluate(
                value => window.__UNDERWATER_TERRAIN_PROOF__.moveCamera(value),
                refinementCamera
            )
            const facts = await waitForStableMode(
                page,
                'tile-wireframe',
                previous.observedFrames,
                refinementCamera
            )
            const capture = await captureState(page, `tile-wireframe-z${zoom}`)
            refinement.push(Object.freeze({ ...facts, capture }))
            previous = facts
        }

        await page.locator('[data-underwater-terrain-control="tile-wireframe"] .tp-ckbv_w').click()
        const restored = await waitForStableMode(
            page,
            'shaded',
            previous.observedFrames,
            Object.freeze({ ...camera, zoom: 14 })
        )
        const restoredCapture = await captureState(page, 'restored-shaded')
        return Object.freeze({
            url: page.url(),
            baseline: Object.freeze({ ...baseline, capture: shadedCapture }),
            wireframe: Object.freeze({ ...wireframe, capture: wireframeCapture }),
            canonicalTopDown: Object.freeze(canonicalTopDown),
            cameraTracking,
            motionStability: Object.freeze(motionStability),
            pitchBudgetPriority: Object.freeze(pitchBudgetPriority),
            refinement: Object.freeze(refinement),
            restored: Object.freeze({ ...restored, capture: restoredCapture }),
            events,
        })
    } finally {
        await context.close()
    }
}

async function runCameraTrackingProof(page, baseCamera) {

    return await page.evaluate(async({ baseCamera, frameCount, longitudeStep }) => {
        const proof = window.__UNDERWATER_TERRAIN_PROOF__
        const canvas = document.querySelector('#GPUFrame')
        if (proof === undefined || !(canvas instanceof HTMLCanvasElement)) {
            throw new Error('Underwater Terrain tracking proof is unavailable')
        }
        const parseCamera = () => {
            try { return JSON.parse(canvas.dataset.cameraView ?? 'null') } catch { return null }
        }
        const samples = []
        let issuedIndex = -1
        await new Promise(resolve => {
            const tick = () => {
                if (issuedIndex >= 0) {
                    const submitted = parseCamera()
                    const submittedIndex = submitted === null
                        ? -1
                        : Math.round(
                            (submitted.center[0] - baseCamera.center[0]) / longitudeStep
                        )
                    samples.push({
                        issuedIndex,
                        submittedIndex,
                        submissionLagFrames: issuedIndex - submittedIndex,
                        inFlightFrames:
                            Number(canvas.dataset.frames) -
                            Number(canvas.dataset.observedFrames),
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
        return {
            frameCount,
            maximumSubmissionLagFrames: Math.max(
                ...samples.map(sample => sample.submissionLagFrames)
            ),
            maximumInFlightFrames: Math.max(
                ...samples.map(sample => sample.inFlightFrames)
            ),
            samples,
            finalCamera,
        }
    }, {
        baseCamera,
        frameCount: 90,
        longitudeStep: 0.00002,
    })
}

async function runZoomMonotonicityProof(activeBrowser) {

    const context = await activeBrowser.newContext({
        viewport: { width: 1512, height: 860 },
        deviceScaleFactor: 2,
    })
    const page = await context.newPage()
    const events = observePage(page)
    try {
        const parameters = new URLSearchParams({
            proof: '1',
            cache: 'none',
            tileServer: tileBaseUrl,
        })
        await page.goto(`${baseUrl}/underwaterTerrain/?${parameters}`, {
            waitUntil: 'domcontentloaded',
            timeout,
        })
        await page.locator('#GPUFrame[data-status="ready"]').waitFor({ timeout })
        let previous = await readFacts(page)
        const samples = []
        for (const zoom of [ 12, 12.25, 12.5, 12.75, 13, 13.25, 13.5, 13.75, 14 ]) {
            const view = Object.freeze({
                ...camera,
                zoom,
                pitch: 0,
                bearing: 0,
            })
            await page.evaluate(
                value => window.__UNDERWATER_TERRAIN_PROOF__.moveCamera(value),
                view
            )
            const facts = await waitForStableMode(
                page,
                'shaded',
                previous.observedFrames,
                view
            )
            samples.push(facts)
            previous = facts
        }
        return Object.freeze({
            viewport: Object.freeze({ width: 1512, height: 860, deviceScaleFactor: 2 }),
            samples: Object.freeze(samples),
            events,
        })
    } finally {
        await context.close()
    }
}

async function waitForStableMode(
    page,
    presentation,
    afterObservedFrames,
    expectedCamera = camera
) {

    await page.waitForFunction(({ expectedPresentation, afterFrames, expectedCamera }) => {
        const canvas = document.querySelector('#GPUFrame')
        if (!(canvas instanceof HTMLCanvasElement)) return false
        const facts = canvas.dataset
        const parse = value => {
            try { return JSON.parse(value ?? 'null') } catch { return null }
        }
        const frontier = parse(facts.frontier)
        const renderPatches = parse(facts.renderPatchFeedback)
        const virtualRaster = parse(facts.virtualRaster)
        const cameraView = parse(facts.cameraView)
        const cameraMatches = cameraView !== null &&
            Math.abs(cameraView.zoom - expectedCamera.zoom) < 1e-6 &&
            Math.abs(cameraView.pitch - expectedCamera.pitch) < 1e-6 &&
            Math.abs(cameraView.bearing - expectedCamera.bearing) < 1e-6
        const virtualRasterIdle = virtualRaster?.residency?.stagedCount === 0 &&
            virtualRaster?.residency?.stagingBytes === 0 &&
            virtualRaster?.scheduler?.activeRequestCount === 0 &&
            virtualRaster?.scheduler?.queuedRequestCount === 0 &&
            virtualRaster?.worker?.pendingCandidateCount === 0 &&
            virtualRaster?.worker?.system?.activeTaskCount === 0 &&
            virtualRaster?.worker?.system?.queuedTaskCount === 0 &&
            virtualRaster?.gpu?.stagedSnapshotEpoch === undefined
        return facts.status === 'ready' &&
            facts.terrainPresentation === expectedPresentation &&
            Number(facts.observedFrames) > afterFrames &&
            Number(facts.frames) === Number(facts.observedFrames) &&
            Number(facts.currentPendingNativeObservations) === 0 &&
            facts.frontierConverged === 'true' &&
            frontier?.convergenceState === 'converged' &&
            frontier?.demandCount === 0 &&
            frontier?.staleGenerationCount === 0 &&
            renderPatches?.selectedPatchCount > 0 &&
            renderPatches?.descriptorOverflowCount === 0 &&
            renderPatches?.lookupOverflowCount === 0 &&
            facts.uncapturedErrors === '0' &&
            facts.deviceLosses === '0' &&
            cameraMatches && virtualRasterIdle
    }, {
        expectedPresentation: presentation,
        afterFrames: afterObservedFrames,
        expectedCamera,
    }, { timeout })
    return await readFacts(page)
}

async function readFacts(page) {

    return await page.evaluate(key => {
        const canvas = document.querySelector('#GPUFrame')
        if (!(canvas instanceof HTMLCanvasElement)) throw new Error('DEM canvas is missing')
        const parse = value => {
            try { return JSON.parse(value ?? 'null') } catch { return null }
        }
        const checkbox = document.querySelector('[data-underwater-terrain-control="tile-wireframe"] input')
        const graphContract = parse(canvas.dataset.graphContract)
        const frontier = parse(canvas.dataset.frontier)
        const renderPatchFeedback = parse(canvas.dataset.renderPatchFeedback)
        return {
            terrainPresentation: canvas.dataset.terrainPresentation,
            frames: Number(canvas.dataset.frames),
            observedFrames: Number(canvas.dataset.observedFrames),
            stableIdentityHash: canvas.dataset.currentStableIdentityHash,
            identityFacts: parse(canvas.dataset.currentIdentityFacts),
            persistentFacts: parse(canvas.dataset.persistentFacts),
            graphContract: graphContract === null ? null : {
                dataMaximumMatrixLevel: graphContract.dataMaximumMatrixLevel,
                renderMaximumMatrixLevel: graphContract.renderMaximumMatrixLevel,
                terrainVertexCount: graphContract.terrainVertexCount,
                countPath: graphContract.countPath,
                selectionPath: graphContract.selectionPath,
                renderPatches: graphContract.renderPatches,
                commandIds: graphContract.commandIds,
            },
            frontier: frontier === null ? null : {
                visibleInstanceCount: frontier.visibleInstanceCount,
                levels: frontier.levels,
                convergenceState: frontier.convergenceState,
                demandCount: frontier.demandCount,
                staleGenerationCount: frontier.staleGenerationCount,
            },
            cameraView: parse(canvas.dataset.cameraView),
            dataLevelRange: parse(canvas.dataset.levelRange),
            renderPatchCount: Number(canvas.dataset.renderPatchCount),
            renderPatchLevelRange: parse(canvas.dataset.renderPatchLevelRange),
            renderPatchCellSpanRange: parse(canvas.dataset.renderPatchCellSpanRange),
            renderPatchDescriptorOverflowCount: Number(
                canvas.dataset.renderPatchDescriptorOverflowCount
            ),
            renderPatchLookupOverflowCount: Number(
                canvas.dataset.renderPatchLookupOverflowCount
            ),
            renderPatchFrameEpoch: Number(canvas.dataset.renderPatchFrameEpoch),
            renderPatchFeedback,
            tileWireframeChecked: checkbox instanceof HTMLInputElement
                ? checkbox.checked
                : undefined,
            renderingStorage: parse(window.localStorage.getItem(key)),
            diagnostics: {
                uncapturedErrors: Number(canvas.dataset.uncapturedErrors),
                deviceLosses: Number(canvas.dataset.deviceLosses),
                incidents: Number(canvas.dataset.diagnosticIncidents),
                bounded: canvas.dataset.diagnosticsBounded === 'true',
            },
        }
    }, renderingStorageKey)
}

async function captureState(page, name) {

    await page.waitForTimeout(250)
    const pagePath = resolve(outputDirectory, `${name}.png`)
    const canvasPath = resolve(outputDirectory, `${name}-canvas.png`)
    const pagePng = await page.screenshot({ path: pagePath })
    const canvasPng = await page.locator('#GPUFrame').screenshot({
        path: canvasPath,
        style: '#UnderwaterTerrainControlPanel { visibility: hidden !important; }',
    })
    return Object.freeze({
        page: Object.freeze({
            path: pagePath,
            sha256: sha256(pagePng),
            byteLength: pagePng.byteLength,
        }),
        canvas: Object.freeze({
            path: canvasPath,
            sha256: sha256(canvasPng),
            byteLength: canvasPng.byteLength,
        }),
        pixels: await inspectWireframePixels(page, canvasPng),
    })
}

async function inspectWireframePixels(page, png) {

    return await page.evaluate(async(encoded) => {
        const image = new Image()
        image.src = `data:image/png;base64,${encoded}`
        await image.decode()
        const canvas = document.createElement('canvas')
        canvas.width = image.naturalWidth
        canvas.height = image.naturalHeight
        const context = canvas.getContext('2d', { willReadFrequently: true })
        if (context === null) throw new Error('Pixel inspection context is unavailable')
        context.drawImage(image, 0, 0)
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
        const clusters = new Map()
        const coloredMask = new Uint8Array(canvas.width * canvas.height)
        const quadrants = [
            { name: 'north-west', coloredPixels: 0, totalPixels: 0 },
            { name: 'north-east', coloredPixels: 0, totalPixels: 0 },
            { name: 'south-west', coloredPixels: 0, totalPixels: 0 },
            { name: 'south-east', coloredPixels: 0, totalPixels: 0 },
        ]
        let coloredPixels = 0
        let nonDarkPixels = 0
        let transparentPixels = 0
        for (let index = 0; index < pixels.length; index += 4) {
            const pixelIndex = index / 4
            const x = pixelIndex % canvas.width
            const y = Math.floor(pixelIndex / canvas.width)
            const quadrant = quadrants[
                (y >= canvas.height / 2 ? 2 : 0) + (x >= canvas.width / 2 ? 1 : 0)
            ]
            quadrant.totalPixels++
            const red = pixels[index]
            const green = pixels[index + 1]
            const blue = pixels[index + 2]
            const alpha = pixels[index + 3]
            const maximum = Math.max(red, green, blue)
            const minimum = Math.min(red, green, blue)
            if (maximum > 20) nonDarkPixels++
            if (alpha === 0) transparentPixels++
            if (maximum < 80 || maximum - minimum < 20) continue
            coloredPixels++
            quadrant.coloredPixels++
            coloredMask[pixelIndex] = 1
            const scale = 5 / maximum
            const key = [ red, green, blue ]
                .map(channel => Math.round(channel * scale))
                .join(':')
            clusters.set(key, (clusters.get(key) ?? 0) + 1)
        }
        const minimumClusterPixels = Math.max(12, Math.floor(coloredPixels * 0.0005))
        const retainedClusters = [ ...clusters.entries() ]
            .filter(([, count ]) => count >= minimumClusterPixels)
            .sort((left, right) => right[1] - left[1])
        const totalPixels = canvas.width * canvas.height
        let colorTransitions = 0
        let comparableEdges = 0
        for (let y = 0; y < canvas.height; y++) {
            for (let x = 0; x < canvas.width; x++) {
                const index = y * canvas.width + x
                if (x > 0) {
                    comparableEdges++
                    if (coloredMask[index] !== coloredMask[index - 1]) colorTransitions++
                }
                if (y > 0) {
                    comparableEdges++
                    if (coloredMask[index] !== coloredMask[index - canvas.width]) {
                        colorTransitions++
                    }
                }
            }
        }
        return {
            width: canvas.width,
            height: canvas.height,
            coloredPixels,
            coloredRatio: coloredPixels / totalPixels,
            nonDarkPixels,
            transparentPixels,
            colorTransitions,
            colorTransitionRatio: colorTransitions / comparableEdges,
            colorClusterCount: retainedClusters.length,
            leadingColorClusters: retainedClusters.slice(0, 12),
            quadrants: quadrants.map(quadrant => ({
                ...quadrant,
                coloredRatio: quadrant.coloredPixels / quadrant.totalPixels,
            })),
        }
    }, png.toString('base64'))
}

function validateProof(value, processState) {

    const failures = []
    if (value === undefined) return [ 'DEM tile wireframe proof was not produced' ]
    const {
        baseline,
        wireframe,
        canonicalTopDown,
        cameraTracking,
        motionStability,
        pitchBudgetPriority,
        refinement,
        restored,
        zoomMonotonicity,
    } = value
    expect(failures,
        baseline?.terrainPresentation === 'shaded' &&
        baseline.tileWireframeChecked === false &&
        wireframe?.terrainPresentation === 'tile-wireframe' &&
        wireframe.tileWireframeChecked === true &&
        restored?.terrainPresentation === 'shaded' &&
        restored.tileWireframeChecked === false,
    'checkbox and submitted terrain presentation did not complete both live switches')

    expect(failures,
        baseline?.stableIdentityHash !== undefined &&
        baseline.stableIdentityHash === wireframe?.stableIdentityHash &&
        wireframe.stableIdentityHash === restored?.stableIdentityHash &&
        JSON.stringify(baseline.identityFacts) === JSON.stringify(wireframe.identityFacts) &&
        JSON.stringify(wireframe.identityFacts) === JSON.stringify(restored.identityFacts) &&
        baseline.identityFacts?.programs === 11 &&
        baseline.identityFacts?.pipelines === 11 &&
        baseline.identityFacts?.commands === 36,
    'live presentation switching rebuilt or replaced the persistent Underwater Terrain graph')

    expect(failures,
        baseline?.persistentFacts?.pipelines === wireframe?.persistentFacts?.pipelines &&
        wireframe.persistentFacts?.pipelines === restored?.persistentFacts?.pipelines &&
        baseline.persistentFacts?.resources === wireframe.persistentFacts?.resources &&
        wireframe.persistentFacts?.resources === restored.persistentFacts?.resources,
    'live presentation switching changed runtime persistent resource counts')

    const canonicalCuts = canonicalTopDown ?? []
    const canonicalSignatures = canonicalCuts.map(sample => ({
        selectedPatchCount: sample?.renderPatchFeedback?.selectedPatchCount,
        minimumMatrixLevel: sample?.renderPatchFeedback?.minimumMatrixLevel,
        maximumMatrixLevel: sample?.renderPatchFeedback?.maximumMatrixLevel,
        selectedBiasStep: sample?.renderPatchFeedback?.selectedBiasStep,
        unbalancedPatchCount: sample?.renderPatchFeedback?.unbalancedPatchCount,
        balanceSplitCount: sample?.renderPatchFeedback?.balanceSplitCount,
        sourceLevels: sample?.frontier?.levels,
        sourceVisibleCount: sample?.frontier?.visibleInstanceCount,
        canvasHash: sample?.capture?.canvas?.sha256,
    }))
    expect(failures,
        canonicalSignatures.length === 2 &&
        JSON.stringify(canonicalSignatures[0]) === JSON.stringify(canonicalSignatures[1]),
    `the same settled top-down camera retained a history-dependent render cut: ${JSON.stringify(
        canonicalSignatures
    )}`)

    const canonicalDensitySpreads = canonicalCuts.map(sample => {
        const ratios = sample?.capture?.pixels?.quadrants?.map(
            quadrant => quadrant.coloredRatio
        ) ?? []
        return ratios.length === 4
            ? Math.max(...ratios) / Math.min(...ratios)
            : Number.POSITIVE_INFINITY
    })
    expect(failures,
        canonicalDensitySpreads.length === 2 &&
        canonicalDensitySpreads.every(spread => spread <= 1.25),
    `settled top-down render-patch density was directionally biased: ${JSON.stringify(
        canonicalCuts.map((sample, index) => ({
            spread: canonicalDensitySpreads[index],
            quadrants: sample?.capture?.pixels?.quadrants,
            feedback: sample?.renderPatchFeedback,
        }))
    )}`)

    expect(failures,
        cameraTracking?.frameCount === 90 &&
        cameraTracking.samples?.length === 90 &&
        cameraTracking.maximumSubmissionLagFrames <= 1,
    `WebGPU camera submissions lagged the map during continuous drag: ${JSON.stringify({
        maximumSubmissionLagFrames: cameraTracking?.maximumSubmissionLagFrames,
        samples: cameraTracking?.samples,
    })}`)

    expect(failures,
        cameraTracking?.maximumInFlightFrames <= 2,
    `continuous camera tracking exceeded its low-latency native in-flight budget: ${JSON.stringify({
        maximumInFlightFrames: cameraTracking?.maximumInFlightFrames,
    })}`)

    const zoomSamples = zoomMonotonicity?.samples ?? []
    const zoomRegressions = zoomSamples.slice(1).flatMap((sample, index) => {
        const previous = zoomSamples[index]
        const previousRange = previous?.renderPatchLevelRange
        const currentRange = sample?.renderPatchLevelRange
        if (!Array.isArray(previousRange) || !Array.isArray(currentRange) ||
            currentRange[0] < previousRange[0] || currentRange[1] < previousRange[1]) {
            return [ {
                from: previous?.cameraView?.zoom,
                to: sample?.cameraView?.zoom,
                previousRange,
                currentRange,
                previousBias: previous?.renderPatchFeedback?.selectedBiasStep,
                currentBias: sample?.renderPatchFeedback?.selectedBiasStep,
                previousSourceLevels: previous?.frontier?.levels,
                currentSourceLevels: sample?.frontier?.levels,
            } ]
        }
        return []
    })
    expect(failures,
        zoomSamples.length === 9 && zoomRegressions.length === 0,
    `settled top-down zoom-in reintroduced coarser render patches: ${JSON.stringify(
        zoomRegressions
    )}`)

    expect(failures,
        baseline?.graphContract?.commandIds?.drawTerrain?.shaded?.length === 2 &&
        baseline.graphContract.commandIds.drawTerrain['tile-wireframe']?.length === 2 &&
        baseline.graphContract.commandIds.renderPatches?.length === 2 &&
        baseline.graphContract.commandIds.renderPatches.every(ids => ids.length === 11) &&
        baseline.graphContract.dataMaximumMatrixLevel === 10 &&
        baseline.graphContract.renderMaximumMatrixLevel === 14 &&
        baseline.graphContract.renderPatches?.renderRootCount >= 1,
    'graph contract does not expose both persistent parity command sets')

    const refinementDataLevels = [ wireframe, ...(refinement ?? []) ].map(sample => (
        sample?.dataLevelRange?.[1]
    ))
    const refinementHashes = [ wireframe, ...(refinement ?? []) ].map(sample => (
        sample?.capture?.canvas?.sha256
    ))
    const requestedDataLevels = value.events?.tileRequestLevels ?? []
    expect(failures,
        baseline.graphContract?.renderPatches?.selectionPath ===
            'gpu-balanced-error-cohort-filled-render-root-local-cell-projection' &&
        baseline.graphContract.renderPatches.maximumCellSpanPixels === 8 &&
        baseline.graphContract.renderPatches.nominalPatchSpanPixels === 512 &&
        !Object.hasOwn(
            baseline.graphContract.renderPatches,
            'refinementHysteresisLevels'
        ) &&
        baseline.graphContract.renderPatches.balancePassCount === 14 &&
        baseline.graphContract.renderPatches.balanceWorkgroupSize === 256 &&
        baseline.graphContract.renderPatches.budgetFillWorkgroupSize === 1 &&
        baseline.graphContract.renderPatches.renderPatchLookupCapacity >
            baseline.graphContract.renderPatches.maximumRenderPatches &&
        refinementDataLevels.every(level => Number.isInteger(level) && level <= 10) &&
        new Set(refinementHashes).size === 4 &&
        requestedDataLevels.length > 0 &&
        requestedDataLevels.every(level => Number.isInteger(level) && level <= 10),
    `render-patch LoD did not refine independently: ${JSON.stringify({
        refinementDataLevels,
        refinementHashes,
        requestedDataLevels,
    })}`)

    const patchSamples = [
        baseline,
        wireframe,
        ...canonicalCuts,
        ...(motionStability ?? []),
        ...(pitchBudgetPriority ?? []),
        ...zoomSamples,
        ...(refinement ?? []),
        restored,
    ]
    expect(failures,
        patchSamples.every(sample => (
            Number.isSafeInteger(sample?.renderPatchCount) &&
            sample.renderPatchCount > 0 &&
            sample.renderPatchCount <=
                baseline.graphContract.renderPatches.maximumRenderPatches &&
            sample.renderPatchFeedback?.selectedPatchCount === sample.renderPatchCount &&
            sample.renderPatchFeedback?.requestedPatchCount >=
                sample.renderPatchFeedback?.unbalancedPatchCount &&
            sample.renderPatchFeedback?.basePatchCount <=
                sample.renderPatchFeedback?.unbalancedPatchCount &&
            sample.renderPatchFeedback?.budgetFillSplitCount >= 0 &&
            sample.renderPatchFeedback?.budgetLimitedRefinementCount >= 0 &&
            sample.renderPatchFeedback?.budgetLimitedRefinementCount <=
                sample.renderPatchFeedback?.unbalancedPatchCount &&
            (sample.renderPatchFeedback?.budgetFillSplitCount > 0 ||
                sample.renderPatchFeedback?.basePatchCount ===
                    sample.renderPatchFeedback?.unbalancedPatchCount) &&
            sample.renderPatchCount ===
                sample.renderPatchFeedback?.unbalancedPatchCount +
                    sample.renderPatchFeedback?.balanceSplitCount * 3 &&
            sample.renderPatchFeedback?.balanceOverheadPatchCount ===
                sample.renderPatchFeedback?.balanceSplitCount * 3 &&
            sample.renderPatchFeedback?.maximumAdjacentLevelDelta <= 1 &&
            sample.renderPatchFeedback?.balancePassCount === 14 &&
            sample.renderPatchFeedback?.baselinePatchBudget >= 1 &&
            sample.renderPatchFeedback?.framePatchBudget >=
                sample.renderPatchFeedback?.baselinePatchBudget &&
            (sample.renderPatchFeedback?.budgetLimitedByMinimumTrial === true ||
                sample.renderPatchFeedback?.unbalancedPatchCount <=
                    sample.renderPatchFeedback?.framePatchBudget) &&
            sample.renderPatchDescriptorOverflowCount === 0 &&
            sample.renderPatchLookupOverflowCount === 0 &&
            sample.renderPatchFeedback?.frameEpoch === sample.renderPatchFrameEpoch &&
            Array.isArray(sample.renderPatchLevelRange) &&
            sample.renderPatchLevelRange[0] >= 4 &&
            sample.renderPatchLevelRange[1] <= 14 &&
            Array.isArray(sample.renderPatchCellSpanRange) &&
            sample.renderPatchCellSpanRange[0] >= 0 &&
            sample.renderPatchCellSpanRange[1] <= 65_535
        )),
    `render-patch feedback was missing, stale, or overflowed: ${JSON.stringify(
        patchSamples.map(sample => ({
            count: sample?.renderPatchCount,
            levels: sample?.renderPatchLevelRange,
            cellSpans: sample?.renderPatchCellSpanRange,
            descriptorOverflow: sample?.renderPatchDescriptorOverflowCount,
            lookupOverflow: sample?.renderPatchLookupOverflowCount,
            frameEpoch: sample?.renderPatchFrameEpoch,
        }))
    )}`)

    expect(failures,
        patchSamples.some(sample => (
            sample?.renderPatchFeedback?.balanceSplitCount > 0 &&
            sample.renderPatchFeedback.balanceOverheadPatchCount > 0 &&
            sample.renderPatchFeedback.maximumAdjacentLevelDelta === 1
        )),
    'no mixed-LoD camera exercised final render-patch balancing')

    const transientSamples = motionStability?.slice(0, 3) ?? []
    const transientFrontiers = transientSamples.map(sample => ({
        visibleInstanceCount: sample?.frontier?.visibleInstanceCount,
        levels: sample?.frontier?.levels,
        demandCount: sample?.frontier?.demandCount,
        convergenceState: sample?.frontier?.convergenceState,
    }))
    const transientCounts = transientSamples.map(sample => sample?.renderPatchCount)
    const transientMaximumLevels = transientSamples.map(
        sample => sample?.renderPatchLevelRange?.[1]
    )
    expect(failures,
        transientSamples.length === 3 &&
        new Set(transientFrontiers.map(JSON.stringify)).size === 1 &&
        transientFrontiers.every(frontier => (
            frontier.demandCount === 0 && frontier.convergenceState === 'converged'
        )) &&
        transientCounts[1] <= Math.max(transientCounts[0], transientCounts[2]) &&
        transientMaximumLevels[1] <= Math.max(
            transientMaximumLevels[0],
            transientMaximumLevels[2]
        ),
    `stable source frontier produced a transient render-patch refinement: ${JSON.stringify({
        frontiers: transientFrontiers,
        counts: transientCounts,
        maximumLevels: transientMaximumLevels,
    })}`)

    const nearPlaneSamples = motionStability?.slice(3) ?? []
    expect(failures,
        nearPlaneSamples.length === 3 &&
        nearPlaneSamples.every(sample => sample?.renderPatchCellSpanRange?.[1] < 65_535),
    `near-plane motion produced a projected-cell-span sentinel: ${JSON.stringify(
        nearPlaneSamples.map(sample => ({
            zoom: sample?.cameraView?.zoom,
            levels: sample?.renderPatchLevelRange,
            cellSpans: sample?.renderPatchCellSpanRange,
        }))
    )}`)

    const pitchPrioritySamples = pitchBudgetPriority ?? []
    const pitchPriorityMaximumLevels = pitchPrioritySamples.map(
        sample => sample?.renderPatchLevelRange?.[1]
    )
    expect(failures,
        pitchPrioritySamples.length === 3 &&
        pitchPriorityMaximumLevels.slice(1).every((level, index) => (
            level >= pitchPriorityMaximumLevels[index]
        )) &&
        pitchPrioritySamples.every(sample => (
            sample?.renderPatchFeedback?.basePatchCount <=
                sample?.renderPatchFeedback?.unbalancedPatchCount &&
            sample?.renderPatchFeedback?.budgetFillSplitCount >= 0 &&
            sample?.renderPatchFeedback?.budgetLimitedRefinementCount >= 0
        )),
    `pitch growth discarded high-priority detail while leaving render budget unused: ${JSON.stringify(
        pitchPrioritySamples.map(sample => ({
            pitch: sample?.cameraView?.pitch,
            levels: sample?.renderPatchLevelRange,
            frameBudget: sample?.renderPatchFeedback?.framePatchBudget,
            unbalancedPatchCount: sample?.renderPatchFeedback?.unbalancedPatchCount,
            budgetFillSplitCount: sample?.renderPatchFeedback?.budgetFillSplitCount,
            budgetLimitedRefinementCount:
                sample?.renderPatchFeedback?.budgetLimitedRefinementCount,
        }))
    )}`)

    expect(failures,
        patchSamples.some(sample => (
            sample?.renderPatchFeedback?.budgetFillSplitCount > 0 &&
            sample.renderPatchFeedback.basePatchCount <
                sample.renderPatchFeedback.unbalancedPatchCount
        )),
    'no camera exercised complete error-cohort filling between the uniform base cut and balance')

    expect(failures,
        wireframe?.renderPatchFeedback?.unbalancedPatchCount <=
            wireframe?.renderPatchFeedback?.framePatchBudget &&
        wireframe.renderPatchCount <= wireframe.renderPatchFeedback.framePatchBudget +
            wireframe.renderPatchFeedback.balanceOverheadPatchCount &&
        wireframe.renderPatchLevelRange?.[0] >
            baseline.graphContract.renderPatches.minimumRootMatrixLevel &&
        wireframe.renderPatchLevelRange?.[1] <= 11 &&
        wireframe.renderPatchCellSpanRange?.[1] <= 8 * 2 **
            wireframe.renderPatchFeedback.selectedBiasLevels,
    `zoom-10 pitched geometry remained over-dense: ${JSON.stringify({
        count: wireframe?.renderPatchCount,
        levels: wireframe?.renderPatchLevelRange,
        cellSpans: wireframe?.renderPatchCellSpanRange,
    })}`)

    const pixels = wireframe?.capture?.pixels
    expect(failures,
        pixels?.coloredPixels > 2_000 &&
        pixels.colorClusterCount >= 4 &&
        pixels.coloredRatio > 0.002 &&
        pixels.coloredRatio < 0.75 &&
        pixels.colorTransitionRatio > 0.04 &&
        pixels.nonDarkPixels > 10_000,
    `wireframe pixels did not prove sparse multicolor tile edges: ${JSON.stringify(pixels)}`)

    expect(failures,
        baseline?.capture?.page?.byteLength > 20_000 &&
        wireframe?.capture?.page?.byteLength > 20_000 &&
        restored?.capture?.page?.byteLength > 20_000 &&
        baseline.capture.canvas.sha256 !== wireframe.capture.canvas.sha256 &&
        wireframe.capture.canvas.sha256 !== restored.capture.canvas.sha256,
    'shaded, wireframe, and restored captures were blank or visually indistinguishable')

    expect(failures,
        wireframe?.renderingStorage?.version === 1 &&
        wireframe.renderingStorage.tileWireframe === true &&
        restored?.renderingStorage?.version === 1 &&
        restored.renderingStorage.tileWireframe === false,
    'live rendering preference was not persisted independently across both switches')

    for (const [ name, state ] of Object.entries({ baseline, wireframe, restored })) {
        expect(failures,
            state?.diagnostics?.uncapturedErrors === 0 &&
            state.diagnostics.deviceLosses === 0 &&
            state.diagnostics.incidents === 0 &&
            state.diagnostics.bounded,
        `${name} retained a WebGPU diagnostic failure`)
    }
    expect(failures, unexpectedEvents(value.events).length === 0,
        `browser emitted failures: ${JSON.stringify(unexpectedEvents(value.events))}`)
    expect(failures, unexpectedEvents(zoomMonotonicity?.events).length === 0,
        `zoom proof emitted failures: ${JSON.stringify(
            unexpectedEvents(zoomMonotonicity?.events)
        )}`)
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
        httpFailures: [],
        tileRequests: [],
        tileRequestLevels: [],
        tileRequestCount: 0,
    }
    page.on('console', message => {
        if (message.type() === 'error') pushBounded(events.consoleFailures, message.text())
    })
    page.on('pageerror', error => pushBounded(events.pageErrors, serializeError(error)))
    page.on('response', response => {
        const url = new URL(response.url())
        const tileMatch = /^\/tiles\/WebMercatorQuad\/(\d+)\/\d+\/\d+\.png$/.exec(
            url.pathname
        )
        if (url.origin === tileBaseUrl && tileMatch !== null) {
            pushBounded(events.tileRequests, response.url())
            events.tileRequestCount++
            const matrixLevel = Number(tileMatch[1])
            if (!events.tileRequestLevels.includes(matrixLevel)) {
                events.tileRequestLevels.push(matrixLevel)
                events.tileRequestLevels.sort((left, right) => left - right)
            }
        }
        if (response.status() >= 400) {
            pushBounded(events.httpFailures, `${response.status()} ${response.url()}`)
        }
    })
    return events
}

function unexpectedEvents(events) {

    if (events === undefined) return [ 'missing browser event ledger' ]
    return [ ...events.consoleFailures, ...events.pageErrors, ...events.httpFailures ]
}

function startProcess(command, arguments_, cwd) {

    const child = spawn(command, arguments_, {
        cwd,
        env: { ...process.env, FORCE_COLOR: '0' },
        stdio: [ 'ignore', 'pipe', 'pipe' ],
    })
    const state = { child, stdout: '', stderr: '', spawnError: undefined }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { state.stdout = appendBounded(state.stdout, chunk) })
    child.stderr.on('data', chunk => { state.stderr = appendBounded(state.stderr, chunk) })
    child.on('error', error => { state.spawnError = error })
    return state
}

async function runCommand(command, arguments_, cwd) {

    const state = startProcess(command, arguments_, cwd)
    await waitForExit(state.child, timeout)
    if (state.spawnError !== undefined) throw state.spawnError
    if (state.child.exitCode !== 0) {
        throw new Error(`${command} failed:\n${state.stderr}\n${state.stdout}`)
    }
    return { exitCode: state.child.exitCode, stdout: state.stdout, stderr: state.stderr }
}

async function waitForHttpProcess(state, url, label) {

    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
        if (state.spawnError !== undefined) throw state.spawnError
        if (state.child.exitCode !== null) {
            throw new Error(`${label} exited before readiness with code ${state.child.exitCode}`)
        }
        try {
            const response = await fetch(url, { signal: AbortSignal.timeout(1_000) })
            const ready = response.ok
            await response.body?.cancel()
            if (ready) return
        } catch {
            // Managed service is still starting.
        }
        await delay(100)
    }
    throw new Error(`Timed out waiting for ${label} at ${url}`)
}

async function stopProcess(state, label) {

    if (state.child.exitCode !== null || state.child.signalCode !== null) return
    state.child.kill('SIGTERM')
    try {
        await waitForExit(state.child, 5_000)
    } catch {
        state.child.kill('SIGKILL')
        try {
            await waitForExit(state.child, 5_000)
        } catch {
            throw new Error(`${label} process ${state.child.pid} did not stop`)
        }
    }
}

async function waitForExit(child, milliseconds) {

    if (child.exitCode !== null || child.signalCode !== null) return
    await new Promise((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => {
            child.off('exit', onExit)
            child.off('error', onError)
            rejectPromise(new Error(`Process ${child.pid} did not exit within ${milliseconds} ms`))
        }, milliseconds)
        const onExit = () => {
            clearTimeout(timer)
            child.off('error', onError)
            resolvePromise()
        }
        const onError = () => {
            clearTimeout(timer)
            child.off('exit', onExit)
            resolvePromise()
        }
        child.once('exit', onExit)
        child.once('error', onError)
    })
}

async function cleanup(label, action) {

    try {
        await action()
    } catch (error) {
        cleanupFailures.push(`${label} cleanup failed: ${serializeError(error)}`)
    }
}

async function findAvailablePort() {

    const server = createServer()
    await new Promise((resolvePromise, rejectPromise) => {
        server.once('error', rejectPromise)
        server.listen(0, '127.0.0.1', resolvePromise)
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Port selection failed')
    await new Promise((resolvePromise, rejectPromise) => {
        server.close(error => error === undefined ? resolvePromise() : rejectPromise(error))
    })
    return address.port
}

async function canConnect(port) {

    return await new Promise(resolvePromise => {
        const socket = createConnection({ host: '127.0.0.1', port })
        const settle = connected => {
            socket.removeAllListeners()
            socket.destroy()
            resolvePromise(connected)
        }
        socket.setTimeout(500, () => settle(false))
        socket.once('connect', () => settle(true))
        socket.once('error', () => settle(false))
    })
}

function parseBuildHash(output) {

    try { return JSON.parse(output).sourceHash } catch { return undefined }
}

function processOutput(state) {

    if (state === undefined) return undefined
    return {
        pid: state.child.pid,
        exitCode: state.child.exitCode,
        signalCode: state.child.signalCode,
        stdout: state.stdout,
        stderr: state.stderr,
    }
}

function positiveInteger(value, fallback) {

    if (value === undefined) return fallback
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new TypeError(`Expected a positive integer, received ${value}`)
    }
    return parsed
}

function appendBounded(current, chunk) {

    return `${current}${chunk}`.slice(-16_384)
}

function pushBounded(target, value) {

    if (target.length < 32) target.push(value)
}

function sha256(value) {

    return createHash('sha256').update(value).digest('hex')
}

function serializeError(error) {

    return error instanceof Error ? error.stack ?? error.message : String(error)
}

async function withTimeout(promise, milliseconds, label) {

    let timer
    try {
        return await Promise.race([
            promise,
            new Promise((resolvePromise, rejectPromise) => {
                timer = setTimeout(
                    () => rejectPromise(new Error(`${label} exceeded ${milliseconds} ms`)),
                    milliseconds
                )
            }),
        ])
    } finally {
        clearTimeout(timer)
    }
}

async function closeBrowser(activeBrowser) {

    const closing = activeBrowser.close()
    try {
        await withTimeout(closing, 15_000, 'Chrome shutdown')
    } catch (error) {
        if (!activeBrowser.isConnected()) return
        await delay(2_000)
        if (!activeBrowser.isConnected()) return
        throw error
    }
}

function delay(milliseconds) {

    return new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds))
}
