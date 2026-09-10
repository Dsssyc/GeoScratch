import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import process from 'node:process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const examplesRoot = resolve(repositoryRoot, 'examples')
const viteEntry = resolve(repositoryRoot, 'node_modules/vite/bin/vite.js')
const workerBuildEntry = resolve(
    repositoryRoot,
    'packages/geoscratch/bin/geoscratch-worker.mjs'
)
const tileServerRoot = resolve(examplesRoot, 'underwaterTerrain/tile-server')
const tileBuildEntry = resolve(tileServerRoot, '.venv/bin/dem-tile-build')
const tileServeEntry = resolve(tileServerRoot, '.venv/bin/dem-tile-serve')
const timeout = positiveInteger(
    process.env.UNDERWATER_TERRAIN_BROWSER_TIMEOUT_MS,
    120_000
)
const browserShutdownTimeout = 5_000
const headless = process.env.UNDERWATER_TERRAIN_HEADLESS === '1'
const outputDirectory = resolve(
    process.env.UNDERWATER_TERRAIN_BROWSER_OUTPUT ?? '/tmp/geoscratch-underwater-terrain-browser'
)
const port = process.env.UNDERWATER_TERRAIN_BROWSER_PORT === undefined
    ? await findAvailablePort()
    : positiveInteger(process.env.UNDERWATER_TERRAIN_BROWSER_PORT)
const baseUrl = `http://127.0.0.1:${port}`
const tilePort = process.env.UNDERWATER_TERRAIN_TILE_PORT === undefined
    ? await findAvailablePort()
    : positiveInteger(process.env.UNDERWATER_TERRAIN_TILE_PORT)
const tileBaseUrl = `http://127.0.0.1:${tilePort}`
const expectedStageOrder = Object.freeze([
    'inverse-cover-compute',
    'source-demand-compute',
    'patch-draw-compute',
    'terrain',
])
const requiredProvenanceNames = Object.freeze([
    'cover-map-meta-to-cover-compute',
    'cover-patches-to-terrain-draw',
    'cover-lookup-to-terrain-draw',
    'patch-draw-indirect-to-terrain-draw',
])
const cameraCenter = Object.freeze([ 120.980697, 31.684162 ])
const cameraScenarios = Object.freeze([
    scenario('flat-z9', 9, 0, 0),
    scenario('flat-z10', 10, 0, 0),
    scenario('flat-z12', 12, 0, 0),
    scenario('flat-z14', 14, 0, 0),
    scenario('pitch45-bearing90-z9', 9, 45, 90),
    scenario('pitch45-bearing225-z10', 10, 45, 225),
    scenario('pitch70-bearing0-z9', 9, 70, 0),
    scenario('pitch70-bearing90-z10', 10, 70, 90),
    scenario('pitch70-bearing90-z14', 14, 70, 90),
    scenario('pitch85-bearing90-z9', 9, 85, 90),
    scenario('pitch85-bearing225-z10', 10, 85, 225),
    scenario('mobile-pitch70-bearing90-z10', 10, 70, 90, {
        width: 390, height: 844,
    }),
])
const failureScenarios = Object.freeze([
    'after-map-acquisition',
    'invalid-terrain-shader-wgsl',
])

await mkdir(outputDirectory, { recursive: true })
let cogBuild
let tileServer
let vite
let browserServer
let browser
let browserVersion
let browserClosed = false
let browserShutdownMode = 'not-started'
let adapter
let normalProof
let failureProofs
let fatalError
let cleanupError
let serverClosed = false
let tileServerClosed = false

try {
    await runCommand(process.execPath, [
        workerBuildEntry,
        'build',
        '--config',
        './worker-modules.ts',
    ], examplesRoot)
    cogBuild = await runCommand(tileBuildEntry, [], tileServerRoot)
    tileServer = startTileServer(tilePort)
    await waitForHttpProcess(tileServer, `${tileBaseUrl}/health`, 'DEM tile server')
    vite = startVite(port)
    await waitForVite(vite, `${baseUrl}/underwaterTerrain/index.html`)
    browserServer = await chromium.launchServer({
        channel: 'chrome',
        headless,
        args: [ '--enable-unsafe-webgpu' ],
    })
    browser = await chromium.connect(browserServer.wsEndpoint())
    browserVersion = await browser.version()
    const verified = await verifyUnderwaterTerrain(browser)
    adapter = verified.adapter
    normalProof = verified.proof
    failureProofs = []
    for (const scenario of failureScenarios) {
        failureProofs.push(await verifyFailureScenario(browser, scenario))
    }
} catch (error) {
    fatalError = serializeError(error)
} finally {
    const cleanupFailures = []
    try {
        if (browserServer !== undefined) {
            browserShutdownMode = await stopBrowserServer(browserServer)
        }
        browserClosed = true
    } catch (error) {
        cleanupFailures.push(serializeError(error))
    }
    try {
        if (vite !== undefined) await stopProcess(vite, 'Vite')
    } catch (error) {
        cleanupFailures.push(serializeError(error))
    }
    try {
        if (tileServer !== undefined) await stopProcess(tileServer, 'DEM tile server')
    } catch (error) {
        cleanupFailures.push(serializeError(error))
    }
    try {
        serverClosed = await waitForPortClosed(port)
    } catch (error) {
        cleanupFailures.push(serializeError(error))
    }
    try {
        tileServerClosed = await waitForPortClosed(tilePort)
    } catch (error) {
        cleanupFailures.push(serializeError(error))
    }
    if (cleanupFailures.length > 0) cleanupError = cleanupFailures.join('\n')
}

const failures = validateResult({
    adapter,
    normalProof,
    failureProofs,
    fatalError,
    cleanupError,
    browserClosed,
    serverClosed,
    tileServerClosed,
})
const result = {
    schemaVersion: 1,
    browserVersion,
    headed: !headless,
    baseUrl,
    tileBaseUrl,
    outputDirectory,
    cogBuild,
    vite: {
        pid: vite?.child.pid,
        exitCode: vite?.child.exitCode,
        signalCode: vite?.child.signalCode,
        serverClosed,
        stdout: failures.length === 0 ? undefined : vite?.stdout,
        stderr: failures.length === 0 ? undefined : vite?.stderr,
    },
    tileServer: {
        pid: tileServer?.child.pid,
        exitCode: tileServer?.child.exitCode,
        signalCode: tileServer?.child.signalCode,
        serverClosed: tileServerClosed,
        stdout: failures.length === 0 ? undefined : tileServer?.stdout,
        stderr: failures.length === 0 ? undefined : tileServer?.stderr,
    },
    browserClosed,
    browserShutdownMode,
    adapter,
    normalProof: normalProof === undefined ? undefined : summarizeNormalProof(normalProof),
    failureProofs: failureProofs?.map(summarizeFailureProof),
    fatalError,
    cleanupError,
    status: failures.length === 0 ? 'passed' : 'failed',
    failures,
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
if (failures.length > 0) process.exitCode = 1

async function verifyUnderwaterTerrain(activeBrowser) {

    const context = await activeBrowser.newContext({
        viewport: { width: 1024, height: 768 },
        deviceScaleFactor: 1,
    })
    const page = await context.newPage()
    const events = observePage(page)

    try {
        await page.goto(
            `${baseUrl}/underwaterTerrain/index.html?proof=1&tileServer=${encodeURIComponent(tileBaseUrl)}`,
            {
            waitUntil: 'domcontentloaded',
            timeout,
            }
        )
        const loadedFacts = await waitForUnderwaterTerrainFacts(page, facts => (
            facts.status === 'ready' && Number(facts.observedFrames) >= 1
        ))
        const adapterFacts = await readRuntimeAdapterFacts(page, loadedFacts)
        const cameraAbaTransition = await captureCameraAbaTransition(page)
        const rapidCameraTransition = await captureRapidCameraTransition(page)
        const scenarios = []
        for (const definition of cameraScenarios) {
            scenarios.push(await captureConvergedCamera(page, definition))
        }

        const lastFacts = scenarios.at(-1).facts.at(-1)
        const resizeGeneration = Number(lastFacts.resizeGeneration)
        await page.setViewportSize({ width: 800, height: 600 })
        const resizedFacts = await waitForConvergedFacts(page, facts => (
            Number(facts.resizeGeneration) > resizeGeneration
        ))
        const resizedPath = resolve(outputDirectory, 'underwater-terrain-resized.png')
        const resizedPng = await page.locator('#GPUFrame').screenshot({ path: resizedPath })
        const resizedPixels = await inspectPixels(page, resizedPng)
        const drainedFacts = await page.evaluate(async() => {
            return await window.__UNDERWATER_TERRAIN_PROOF__.pauseAndDrain()
        })
        const cleanupPair = await page.evaluate(async() => {
            const first = window.__UNDERWATER_TERRAIN_PROOF__.dispose()
            const second = window.__UNDERWATER_TERRAIN_PROOF__.dispose()
            const reports = await Promise.all([ first, second ])
            return {
                reports,
                equivalentReports: JSON.stringify(reports[0]) === JSON.stringify(reports[1]),
            }
        })
        const terminalStatus = await page.locator('#GPUFrame').getAttribute('data-status')

        return {
            adapter: adapterFacts,
            proof: {
                cameraAbaTransition,
                rapidCameraTransition,
                scenarios,
                resizedFacts,
                drainedFacts,
                cleanupPair,
                terminalStatus,
                screenshots: {
                    resized: resizedPath,
                },
                pixelHashes: {
                    resized: sha256(resizedPng),
                },
                pixels: {
                    resized: resizedPixels,
                },
                ...events,
            },
        }
    } finally {
        await context.close()
    }
}

async function captureCameraAbaTransition(page) {

    const cameraA = Object.freeze({
        center: cameraCenter,
        zoom: 9.5,
        pitch: 30,
        bearing: 35,
    })
    const cameraB = Object.freeze({
        center: [ cameraCenter[0] + 0.04, cameraCenter[1] - 0.03 ],
        zoom: 10.25,
        pitch: 70,
        bearing: 145,
    })
    const issued = await page.evaluate(async({ cameraA, cameraB, timeoutMs }) => {
        const proof = window.__UNDERWATER_TERRAIN_PROOF__
        const canvas = document.querySelector('#GPUFrame')
        if (proof === undefined || !(canvas instanceof HTMLCanvasElement)) {
            throw new Error('Underwater Terrain ABA proof is unavailable')
        }
        return await new Promise((resolve, reject) => {
            let phase = 'first-a'
            let firstAFrame = -1
            let cameraBFrame = -1
            const timer = setTimeout(() => {
                observer.disconnect()
                reject(new Error(`Timed out during camera ABA transition at ${phase}`))
            }, timeoutMs)
            const matches = (actual, expected) => actual !== null &&
                Math.abs(actual.center[0] - expected.center[0]) < 1e-8 &&
                Math.abs(actual.center[1] - expected.center[1]) < 1e-8 &&
                Math.abs(actual.zoom - expected.zoom) < 1e-6 &&
                Math.abs(actual.pitch - expected.pitch) < 1e-6
            const observer = new MutationObserver(() => {
                let camera
                try { camera = JSON.parse(canvas.dataset.cameraView ?? 'null') } catch { return }
                if (phase === 'first-a' && matches(camera, cameraA)) {
                    firstAFrame = Number(canvas.dataset.frames)
                    phase = 'camera-b'
                    proof.moveCamera(cameraB)
                } else if (phase === 'camera-b' && matches(camera, cameraB)) {
                    cameraBFrame = Number(canvas.dataset.frames)
                    phase = 'final-a'
                    proof.moveCamera(cameraA)
                    observer.disconnect()
                    clearTimeout(timer)
                    resolve({ firstAFrame, cameraBFrame })
                }
            })
            observer.observe(canvas, {
                attributes: true,
                attributeFilter: [ 'data-camera-view' ],
            })
            proof.moveCamera(cameraA)
        })
    }, { cameraA, cameraB, timeoutMs: timeout })
    const finalFacts = await waitForConvergedFacts(page, facts => (
        Number(facts.observedFrames) > issued.cameraBFrame && cameraMatches(facts, cameraA)
    ))
    const previousFrames = Number(finalFacts.observedFrames)
    await page.evaluate(camera => window.__UNDERWATER_TERRAIN_PROOF__.moveCamera(camera), cameraA)
    const repeatedFacts = await waitForConvergedFacts(page, facts => (
        Number(facts.observedFrames) > previousFrames && cameraMatches(facts, cameraA)
    ))
    return Object.freeze({
        cameraA,
        cameraB,
        issued,
        finalFacts,
        repeatedFacts,
        signatures: Object.freeze([
            coverSignature(finalFacts),
            coverSignature(repeatedFacts),
        ]),
    })
}

async function captureRapidCameraTransition(page) {

    const beforeResize = await readUnderwaterTerrainFacts(page)
    await page.setViewportSize({ width: 1512, height: 982 })
    await waitForConvergedFacts(page, facts => (
        Number(facts.resizeGeneration) > Number(beforeResize.resizeGeneration)
    ))
    const beforeSequence = await readUnderwaterTerrainFacts(page)
    let finalCamera
    const stepCount = 84
    for (let index = 0; index < stepCount; index++) {
        const phase = index % 28
        finalCamera = {
            center: [
                cameraCenter[0] + Math.sin(index * 0.37) * 0.18,
                cameraCenter[1] + Math.cos(index * 0.23) * 0.12,
            ],
            zoom: 8.5 + ((index * 7) % 24) / 4,
            pitch: phase < 14 ? phase * 6.2 : (27 - phase) * 6.2,
            bearing: ((index * 47) % 360) - 180,
        }
        await page.evaluate(camera => window.__UNDERWATER_TERRAIN_PROOF__.moveCamera(camera), finalCamera)
        await delay(5)
    }
    const finalFacts = await waitForConvergedFacts(page, facts => (
        Number(facts.observedFrames) > Number(beforeSequence.observedFrames) &&
        cameraMatches(facts, finalCamera)
    ))
    const transitionResizeGeneration = Number(finalFacts.resizeGeneration)
    await page.setViewportSize({ width: 1024, height: 768 })
    const restoredFacts = await waitForConvergedFacts(page, facts => (
        Number(facts.resizeGeneration) > transitionResizeGeneration
    ))
    return Object.freeze({
        stepCount,
        finalCamera: Object.freeze(finalCamera),
        finalFacts,
        restoredFacts,
    })
}

function scenario(name, zoom, pitch, bearing, viewport) {

    return Object.freeze({
        name,
        camera: Object.freeze({ center: cameraCenter, zoom, pitch, bearing }),
        viewport: viewport === undefined ? undefined : Object.freeze({ ...viewport }),
    })
}

async function captureConvergedCamera(page, definition) {

    if (definition.viewport !== undefined) {
        const current = await readUnderwaterTerrainFacts(page)
        const resizeGeneration = Number(current.resizeGeneration)
        await page.setViewportSize(definition.viewport)
        await waitForConvergedFacts(page, facts => (
            Number(facts.resizeGeneration) > resizeGeneration
        ))
    }
    const before = await readUnderwaterTerrainFacts(page)
    const facts = []
    const signatures = []
    await page.evaluate(camera => window.__UNDERWATER_TERRAIN_PROOF__.moveCamera(camera), definition.camera)
    let current = await waitForConvergedFacts(page, value => (
        Number(value.observedFrames) > Number(before.observedFrames) &&
        cameraMatches(value, definition.camera)
    ))
    facts.push(current)
    signatures.push(coverSignature(current))
    const firstPath = resolve(outputDirectory, `${definition.name}-stable-first.png`)
    const firstPng = await page.locator('#GPUFrame').screenshot({ path: firstPath })

    for (let repetition = 0; repetition < 2; repetition++) {
        const previousFrames = Number(current.observedFrames)
        await page.evaluate(camera => window.__UNDERWATER_TERRAIN_PROOF__.moveCamera(camera), definition.camera)
        current = await waitForConvergedFacts(page, value => (
            Number(value.observedFrames) > previousFrames && cameraMatches(value, definition.camera)
        ))
        facts.push(current)
        signatures.push(coverSignature(current))
    }

    const finalPath = resolve(outputDirectory, `${definition.name}-stable-final.png`)
    const finalPng = await page.locator('#GPUFrame').screenshot({ path: finalPath })
    return {
        ...definition,
        facts,
        signatures,
        screenshots: { first: firstPath, final: finalPath },
        pixelHashes: { first: sha256(firstPng), final: sha256(finalPng) },
        pixels: await inspectPixelPair(page, firstPng, finalPng),
    }
}

async function waitForConvergedFacts(page, additional = () => true) {

    return await waitForUnderwaterTerrainFacts(page, facts => {
        const cover = parseJsonOrUndefined(facts.coverFeedback)
        const demand = parseJsonOrUndefined(facts.demandFeedback)
        const virtualRaster = parseJsonOrUndefined(facts.virtualRaster)
        return facts.status === 'ready' &&
            facts.coverConverged === 'true' &&
            facts.convergenceState === 'converged' &&
            cover?.patchCount > 0 &&
            cover?.descriptorOverflowCount === 0 &&
            cover?.lookupOverflowCount === 0 &&
            demand?.overflowCount === 0 &&
            cover?.maximumAdjacentLevelDelta <= 1 &&
            Number(facts.frames) === Number(facts.observedFrames) &&
            Number(facts.currentPendingNativeObservations) === 0 &&
            virtualRasterIdle(virtualRaster) && additional(facts)
    })
}

function virtualRasterIdle(value) {

    return value?.residency?.stagedCount === 0 &&
        value?.residency?.stagingBytes === 0 &&
        value?.scheduler?.activeRequestCount === 0 &&
        value?.scheduler?.queuedRequestCount === 0 &&
        value?.worker?.pendingCandidateCount === 0 &&
        value?.worker?.senderDecodedByteLength === 0 &&
        value?.worker?.system?.activeTaskCount === 0 &&
        value?.worker?.system?.queuedTaskCount === 0 &&
        value?.worker?.group?.activeTaskCount === 0 &&
        value?.worker?.group?.queuedTaskCount === 0 &&
        value?.gpu?.stagedSnapshotEpoch === undefined
}

function cameraMatches(facts, expected) {

    const actual = parseJsonOrUndefined(facts.cameraView)
    return Math.abs((actual?.center?.[0] ?? Infinity) - expected.center[0]) < 1e-8 &&
        Math.abs((actual?.center?.[1] ?? Infinity) - expected.center[1]) < 1e-8 &&
        Math.abs((actual?.zoom ?? Infinity) - expected.zoom) < 1e-6 &&
        Math.abs((actual?.pitch ?? Infinity) - expected.pitch) < 1e-6 &&
        bearingDistance(actual?.bearing, expected.bearing) < 1e-6
}

function bearingDistance(left, right) {

    if (!Number.isFinite(left) || !Number.isFinite(right)) return Infinity
    const difference = Math.abs(left - right) % 360
    return Math.min(difference, 360 - difference)
}

function coverSignature(facts) {

    const cover = parseJsonOrUndefined(facts.coverFeedback)
    const demand = parseJsonOrUndefined(facts.demandFeedback)
    const camera = parseJsonOrUndefined(facts.cameraView)
    return JSON.stringify({
        candidateCount: cover?.candidateCount,
        patchCount: cover?.patchCount,
        demandCount: demand?.demandCount,
        minimumMatrixLevel: cover?.minimumMatrixLevel,
        maximumMatrixLevel: cover?.maximumMatrixLevel,
        maximumAdjacentLevelDelta: cover?.maximumAdjacentLevelDelta,
        finestMatrixLevel: cover?.finestMatrixLevel,
        sourceLevelCeiling: demand?.sourceLevelCeiling,
        demands: demand?.demands?.map(entry => ({
            desiredSampleLevel: entry.desiredSampleLevel,
            sourceLevelCeiling: entry.sourceLevelCeiling,
            requestMatrixLevel: entry.requestMatrixLevel,
            tileRow: entry.tileRow,
            tileCol: entry.tileCol,
            priority: entry.priority,
        })),
        camera,
    })
}

async function verifyFailureScenario(activeBrowser, scenario) {

    const context = await activeBrowser.newContext({
        viewport: { width: 960, height: 720 },
        deviceScaleFactor: 1,
    })
    const page = await context.newPage()
    const events = observePage(page)

    try {
        const url = `${baseUrl}/underwaterTerrain/index.html?proof=1&fault=${scenario}` +
            `&tileServer=${encodeURIComponent(tileBaseUrl)}`
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout })
        await page.waitForFunction(() => {
            return document.querySelector('#GPUFrame')?.dataset.initFailureProof !== undefined
        }, undefined, { timeout })
        const facts = await readUnderwaterTerrainFacts(page)
        return {
            scenario,
            facts,
            proof: JSON.parse(facts.initFailureProof),
            ...events,
        }
    } finally {
        await context.close()
    }
}

function observePage(page) {

    const consoleFailures = []
    const consoleWarnings = []
    const pageErrors = []
    const requestFailures = []
    const httpFailures = []
    const requests = []
    const tileRequests = []
    const cancelledTileRequests = []
    const completeImageRequests = []
    page.on('console', (message) => {
        if (message.type() === 'error') pushBounded(consoleFailures, message.text())
        if (message.type() === 'warning') pushBounded(consoleWarnings, message.text())
    })
    page.on('pageerror', error => pushBounded(pageErrors, serializeError(error)))
    page.on('requestfailed', request => {
        const failure = `${request.method()} ${request.url()}: ` +
            `${request.failure()?.errorText ?? 'unknown failure'}`
        const parsed = new URL(request.url())
        if (parsed.origin === tileBaseUrl && parsed.pathname.startsWith('/tiles/') &&
            /abort|cancel/i.test(request.failure()?.errorText ?? '')) {
            pushBounded(cancelledTileRequests, failure)
            return
        }
        pushBounded(requestFailures, failure)
    })
    page.on('request', (request) => {
        const url = request.url()
        pushBounded(requests, url)
        const parsed = new URL(url)
        if (parsed.origin === tileBaseUrl && parsed.pathname.startsWith('/tiles/')) {
            pushBounded(tileRequests, url)
        }
        if (parsed.pathname.endsWith('/assets/dem.png')) {
            pushBounded(completeImageRequests, url)
        }
    })
    page.on('response', (response) => {
        if (response.status() >= 400) {
            pushBounded(httpFailures, `${response.status()} ${response.request().method()} ${response.url()}`)
        }
    })
    return {
        consoleFailures,
        consoleWarnings,
        pageErrors,
        requestFailures,
        httpFailures,
        requests,
        tileRequests,
        cancelledTileRequests,
        completeImageRequests,
    }
}

async function readRuntimeAdapterFacts(page, facts) {

    return await page.evaluate((serializedAdapter) => ({
        available: navigator.gpu !== undefined,
        runtimeAdapterAcquired: document.querySelector('#GPUFrame')?.dataset.adapterAcquired === 'true',
        runtime: JSON.parse(serializedAdapter),
    }), facts.adapter)
}

async function waitForUnderwaterTerrainFacts(page, predicate) {

    const deadline = Date.now() + timeout
    let lastFacts
    while (Date.now() < deadline) {
        const facts = await readUnderwaterTerrainFacts(page)
        lastFacts = facts
        if (facts.status === 'error') {
            throw new Error([
                facts.error ?? 'Underwater Terrain failed.',
                facts.diagnostic === undefined ? undefined : `diagnostic=${facts.diagnostic}`,
            ].filter(Boolean).join('\n'))
        }
        if (predicate(facts)) return facts
        await delay(16)
    }
    throw new Error(
        `Timed out waiting for Underwater Terrain proof facts: ${JSON.stringify(waitFacts(lastFacts))}`
    )
}

function waitFacts(facts) {

    if (facts === undefined) return undefined
    const cover = parseJsonOrUndefined(facts.coverFeedback)
    const virtualRaster = parseJsonOrUndefined(facts.virtualRaster)
    return {
        status: facts.status,
        frames: Number(facts.frames),
        observedFrames: Number(facts.observedFrames),
        currentPendingNativeObservations: Number(facts.currentPendingNativeObservations),
        frameWork: parseJsonOrUndefined(facts.frameWork),
        cameraView: parseJsonOrUndefined(facts.cameraView),
        cover,
        virtualRaster: virtualRaster === undefined ? undefined : {
            residency: selectFacts(virtualRaster.residency, [
                'demandGeneration',
                'snapshotEpoch',
                'stagedCount',
                'stagingBytes',
                'residentCount',
                'failedCount',
                'staleResponseCount',
            ]),
            scheduler: selectFacts(virtualRaster.scheduler, [
                'generation',
                'demandedPageCount',
                'activeRequestCount',
                'queuedRequestCount',
                'completedRequestCount',
                'failedRequestCount',
                'staleResultCount',
                'cancellationCount',
            ]),
            worker: {
                ...selectFacts(virtualRaster.worker, [
                    'pendingCandidateCount',
                    'senderDecodedByteLength',
                    'networkRequestCount',
                    'decodedPageCount',
                    'acceptedCandidateCount',
                    'discardedCandidateCount',
                ]),
                system: selectFacts(virtualRaster.worker?.system, [
                    'activeTaskCount',
                    'queuedTaskCount',
                    'completedTaskCount',
                    'cancelledTaskCount',
                ]),
                group: selectFacts(virtualRaster.worker?.group, [
                    'activeTaskCount',
                    'queuedTaskCount',
                    'completedTaskCount',
                    'cancelledTaskCount',
                ]),
            },
            gpu: virtualRaster.gpu,
        },
    }
}

function selectFacts(value, names) {

    if (value === undefined || value === null) return value
    return Object.fromEntries(names.map(name => [ name, value[name] ]))
}

async function readUnderwaterTerrainFacts(page) {

    return await page.evaluate(() => {
        const target = document.querySelector('#GPUFrame')
        if (!(target instanceof HTMLCanvasElement)) throw new Error('Underwater Terrain canvas is missing.')
        return { ...target.dataset }
    })
}

async function inspectPixels(page, png) {

    return await page.evaluate(async(base64) => {
        const decoded = await decodePng(base64)
        return summarizePixels(decoded)

        async function decodePng(encoded) {
            const image = new Image()
            image.src = `data:image/png;base64,${encoded}`
            await image.decode()
            const target = document.createElement('canvas')
            target.width = image.naturalWidth
            target.height = image.naturalHeight
            const context = target.getContext('2d', { willReadFrequently: true })
            if (!context) throw new Error('Pixel inspection context is unavailable.')
            context.drawImage(image, 0, 0)
            return {
                width: target.width,
                height: target.height,
                pixels: context.getImageData(0, 0, target.width, target.height).data,
            }
        }

        function summarizePixels(value) {
            let minimumChannel = 255
            let maximumChannel = 0
            let nonDarkPixels = 0
            let nonBackgroundPixels = 0
            let nonTransparentPixels = 0
            let lumaSum = 0
            const terrainByBand = [ 0, 0, 0 ]
            const pixelsByBand = [ 0, 0, 0 ]
            const proofHeight = Math.max(1, value.height - 32)
            let terrainMinX = value.width
            let terrainMaxX = -1
            let terrainMinY = proofHeight
            let terrainMaxY = -1
            for (let index = 0; index < value.pixels.length; index += 4) {
                const red = value.pixels[index]
                const green = value.pixels[index + 1]
                const blue = value.pixels[index + 2]
                const pixelIndex = index / 4
                const x = pixelIndex % value.width
                const y = Math.floor(pixelIndex / value.width)
                const terrain = y < proofHeight &&
                    Math.abs(red - 16) + Math.abs(green - 20) + Math.abs(blue - 24) >= 12
                minimumChannel = Math.min(minimumChannel, red, green, blue)
                maximumChannel = Math.max(maximumChannel, red, green, blue)
                if (Math.max(red, green, blue) > 8) nonDarkPixels++
                if (y < proofHeight) {
                    const band = Math.min(2, Math.floor(y * 3 / proofHeight))
                    pixelsByBand[band]++
                    if (terrain) terrainByBand[band]++
                }
                if (terrain) {
                    nonBackgroundPixels++
                    terrainMinX = Math.min(terrainMinX, x)
                    terrainMaxX = Math.max(terrainMaxX, x)
                    terrainMinY = Math.min(terrainMinY, y)
                    terrainMaxY = Math.max(terrainMaxY, y)
                }
                if (value.pixels[index + 3] > 0) nonTransparentPixels++
                lumaSum += red * 0.2126 + green * 0.7152 + blue * 0.0722
            }
            return {
                width: value.width,
                height: value.height,
                nonDarkPixels,
                nonBackgroundPixels,
                nonTransparentPixels,
                channelRange: maximumChannel - minimumChannel,
                meanLuma: lumaSum / (value.width * value.height),
                terrainBands: bandFacts(terrainByBand, pixelsByBand),
                terrainBounds: boundsFacts(),
            }

            function boundsFacts() {
                if (terrainMaxX < terrainMinX || terrainMaxY < terrainMinY) return null
                const width = terrainMaxX - terrainMinX + 1
                const height = terrainMaxY - terrainMinY + 1
                return {
                    minX: terrainMinX,
                    maxX: terrainMaxX,
                    minY: terrainMinY,
                    maxY: terrainMaxY,
                    width,
                    height,
                    horizontalRatio: width / value.width,
                    verticalRatio: height / proofHeight,
                }
            }
        }

        function bandFacts(terrain, totals) {
            return [ 'far', 'middle', 'near' ].map((name, index) => ({
                name,
                terrainPixels: terrain[index],
                ratio: terrain[index] / Math.max(1, totals[index]),
            }))
        }
    }, png.toString('base64'))
}

async function inspectPixelPair(page, firstPng, secondPng) {

    return await page.evaluate(async({ firstBase64, secondBase64 }) => {
        const decode = async(base64) => {
            const image = new Image()
            image.src = `data:image/png;base64,${base64}`
            await image.decode()
            const target = document.createElement('canvas')
            target.width = image.naturalWidth
            target.height = image.naturalHeight
            const context = target.getContext('2d', { willReadFrequently: true })
            if (!context) throw new Error('Pixel comparison context is unavailable.')
            context.drawImage(image, 0, 0)
            return {
                width: target.width,
                height: target.height,
                pixels: context.getImageData(0, 0, target.width, target.height).data,
            }
        }
        const summarize = (value) => {
            let minimumChannel = 255
            let maximumChannel = 0
            let nonDarkPixels = 0
            let nonBackgroundPixels = 0
            let nonTransparentPixels = 0
            let lumaSum = 0
            const terrainByBand = [ 0, 0, 0 ]
            const pixelsByBand = [ 0, 0, 0 ]
            const proofHeight = Math.max(1, value.height - 32)
            let terrainMinX = value.width
            let terrainMaxX = -1
            let terrainMinY = proofHeight
            let terrainMaxY = -1
            for (let index = 0; index < value.pixels.length; index += 4) {
                const red = value.pixels[index]
                const green = value.pixels[index + 1]
                const blue = value.pixels[index + 2]
                const pixelIndex = index / 4
                const x = pixelIndex % value.width
                const y = Math.floor(pixelIndex / value.width)
                const terrain = y < proofHeight &&
                    Math.abs(red - 16) + Math.abs(green - 20) + Math.abs(blue - 24) >= 12
                minimumChannel = Math.min(minimumChannel, red, green, blue)
                maximumChannel = Math.max(maximumChannel, red, green, blue)
                if (Math.max(red, green, blue) > 8) nonDarkPixels++
                if (y < proofHeight) {
                    const band = Math.min(2, Math.floor(y * 3 / proofHeight))
                    pixelsByBand[band]++
                    if (terrain) terrainByBand[band]++
                }
                if (terrain) {
                    nonBackgroundPixels++
                    terrainMinX = Math.min(terrainMinX, x)
                    terrainMaxX = Math.max(terrainMaxX, x)
                    terrainMinY = Math.min(terrainMinY, y)
                    terrainMaxY = Math.max(terrainMaxY, y)
                }
                if (value.pixels[index + 3] > 0) nonTransparentPixels++
                lumaSum += red * 0.2126 + green * 0.7152 + blue * 0.0722
            }
            return {
                width: value.width,
                height: value.height,
                nonDarkPixels,
                nonBackgroundPixels,
                nonTransparentPixels,
                channelRange: maximumChannel - minimumChannel,
                meanLuma: lumaSum / (value.width * value.height),
                terrainBands: [ 'far', 'middle', 'near' ].map((name, band) => ({
                    name,
                    terrainPixels: terrainByBand[band],
                    ratio: terrainByBand[band] / Math.max(1, pixelsByBand[band]),
                })),
                terrainBounds: terrainMaxX < terrainMinX || terrainMaxY < terrainMinY
                    ? null
                    : {
                        minX: terrainMinX,
                        maxX: terrainMaxX,
                        minY: terrainMinY,
                        maxY: terrainMaxY,
                        width: terrainMaxX - terrainMinX + 1,
                        height: terrainMaxY - terrainMinY + 1,
                        horizontalRatio: (terrainMaxX - terrainMinX + 1) / value.width,
                        verticalRatio: (terrainMaxY - terrainMinY + 1) / proofHeight,
                    },
            }
        }
        const first = await decode(firstBase64)
        const second = await decode(secondBase64)
        if (first.width !== second.width || first.height !== second.height) {
            throw new Error('Underwater Terrain movement screenshots have different dimensions.')
        }
        let changedPixels = 0
        let totalRgbDelta = 0
        let maximumRgbDelta = 0
        for (let index = 0; index < first.pixels.length; index += 4) {
            const delta = Math.abs(first.pixels[index] - second.pixels[index]) +
                Math.abs(first.pixels[index + 1] - second.pixels[index + 1]) +
                Math.abs(first.pixels[index + 2] - second.pixels[index + 2])
            if (delta >= 6) changedPixels++
            totalRgbDelta += delta
            maximumRgbDelta = Math.max(maximumRgbDelta, delta)
        }
        return {
            first: summarize(first),
            second: summarize(second),
            difference: {
                changedPixels,
                meanRgbDelta: totalRgbDelta / (first.width * first.height),
                maximumRgbDelta,
            },
        }
    }, {
        firstBase64: firstPng.toString('base64'),
        secondBase64: secondPng.toString('base64'),
    })
}

function validateResult(result) {

    const failures = []
    if (result.fatalError !== undefined) failures.push(`browser probe failed: ${result.fatalError}`)
    if (result.cleanupError !== undefined) failures.push(`cleanup failed: ${result.cleanupError}`)
    if (!result.browserClosed) failures.push('managed Chrome did not close')
    if (!result.serverClosed) failures.push(`managed Vite port ${port} remained open after cleanup`)
    if (!result.tileServerClosed) {
        failures.push(`managed DEM tile port ${tilePort} remained open after cleanup`)
    }
    if (result.adapter?.available !== true) failures.push('navigator.gpu was unavailable')
    if (result.adapter?.runtimeAdapterAcquired !== true) {
        failures.push('GPURuntime did not acquire a WebGPU adapter')
    }
    if (result.normalProof === undefined) {
        failures.push('normal Underwater Terrain proof was not produced')
    } else {
        validateNormalProof(result.normalProof, failures)
    }
    if (result.failureProofs === undefined) {
        failures.push('failure scenario proofs were not produced')
    } else {
        if (result.failureProofs.length !== failureScenarios.length) {
            failures.push('failure scenario proof count was not exactly two')
        }
        for (const failureProof of result.failureProofs) validateFailureProof(failureProof, failures)
    }
    return failures
}

function validateNormalProof(proof, failures) {

    const scenarios = proof.scenarios ?? []
    const cameraAbaTransition = proof.cameraAbaTransition
    const rapidCameraTransition = proof.rapidCameraTransition
    const resized = proof.resizedFacts
    const drained = proof.drainedFacts
    if (scenarios.length !== cameraScenarios.length) {
        failures.push('normal Underwater Terrain proof did not run every camera scenario')
    }
    const allFacts = []
    if (cameraAbaTransition?.issued?.firstAFrame < 1 ||
        cameraAbaTransition?.issued?.cameraBFrame <= cameraAbaTransition.issued.firstAFrame ||
        cameraAbaTransition?.signatures?.length !== 2 ||
        new Set(cameraAbaTransition.signatures).size !== 1) {
        failures.push('camera A-B-A replacement reused an obsolete decision episode')
    } else {
        validateUnderwaterTerrainFacts(
            'camera A-B-A final decision',
            cameraAbaTransition.finalFacts,
            failures
        )
        validateUnderwaterTerrainFacts(
            'camera A-B-A repeated decision',
            cameraAbaTransition.repeatedFacts,
            failures
        )
        allFacts.push(cameraAbaTransition.finalFacts, cameraAbaTransition.repeatedFacts)
    }
    if (rapidCameraTransition?.stepCount !== 84 ||
        !cameraMatches(
            rapidCameraTransition?.finalFacts ?? {},
            rapidCameraTransition?.finalCamera ?? {}
        )) {
        failures.push('rapid pitched-to-top-down camera transition did not complete')
    } else {
        validateUnderwaterTerrainFacts(
            'rapid pitched-to-top-down transition',
            rapidCameraTransition.finalFacts,
            failures
        )
        validateUnderwaterTerrainFacts(
            'rapid transition restored viewport',
            rapidCameraTransition.restoredFacts,
            failures
        )
        allFacts.push(
            rapidCameraTransition.finalFacts,
            rapidCameraTransition.restoredFacts
        )
    }
    for (const result of scenarios) {
        if (result.facts?.length !== 3 || result.signatures?.length !== 3) {
            failures.push(`${result.name} did not retain three stable frames`)
            continue
        }
        allFacts.push(...result.facts)
        for (const facts of result.facts) {
            validateUnderwaterTerrainFacts(result.name, facts, failures)
        }
        if (new Set(result.signatures).size !== 1) {
            failures.push(
                `${result.name} cover facts changed across identical camera frames: ` +
                result.signatures.join(' -> ')
            )
        }
        if (result.pixelHashes.first !== result.pixelHashes.final) {
            failures.push(`${result.name} pixels changed across identical converged frames`)
        }
        for (const sample of [ result.pixels.first, result.pixels.second ]) {
            if (sample.nonBackgroundPixels < 1_000 || sample.channelRange < 8 ||
                sample.meanLuma < 0.05) {
                failures.push(`${result.name} screenshot was blank or visually uniform`)
            }
            if (result.camera.pitch >= 70 && (sample.terrainBounds === null ||
                sample.terrainBounds.horizontalRatio < 0.5 ||
                sample.terrainBounds.verticalRatio < 0.05)) {
                failures.push(`${result.name} high-pitch terrain projection was too narrow`)
            }
        }
        const finalFacts = result.facts.at(-1)
        if (!cameraMatches(finalFacts, result.camera)) {
            failures.push(`${result.name} did not publish the requested MapLibre camera`)
        }
        if (result.viewport !== undefined) {
            const camera = parseJsonOrUndefined(finalFacts.cameraView)
            if (camera?.referenceViewport?.[0] !== result.viewport.width ||
                camera?.referenceViewport?.[1] !== result.viewport.height) {
                failures.push(`${result.name} did not publish the requested viewport`)
            }
        }
    }
    const coverProofs = scenarios.flatMap(result => result.facts.map(facts => (
        parseJsonOrUndefined(facts.coverFeedback)
    )))
    const pitchedMultiLevelProofs = coverProofs.filter(feedback => (
        feedback?.minimumMatrixLevel < feedback?.maximumMatrixLevel &&
        feedback?.maximumAdjacentLevelDelta === 1
    ))
    if (pitchedMultiLevelProofs.length === 0) {
        failures.push('no camera scenario exercised the multi-level inverse cover')
    }
    const balanceProofs = coverProofs.filter(feedback => (
        feedback?.maximumAdjacentLevelDelta === 1 &&
        feedback?.patchCount > 1
    ))
    if (balanceProofs.length === 0) {
        failures.push('no camera scenario exercised final inverse-cover balancing')
    }
    validateUnderwaterTerrainFacts('resized', resized, failures)
    validateUnderwaterTerrainFacts('drained', drained, failures, 'stopped')
    allFacts.push(resized, drained)
    const initial = allFacts[0]
    for (const facts of allFacts) {
        if (facts.currentStableIdentityHash !== initial?.currentStableIdentityHash ||
            facts.currentStableIdentityCount !== initial?.currentStableIdentityCount ||
            facts.currentIdentityFacts !== initial?.currentIdentityFacts) {
            failures.push('persistent Underwater Terrain graph identity changed')
            break
        }
    }
    if (initial !== undefined) validatePersistentCounts(initial, resized, failures)

    const beforeResize = scenarios.at(-1)?.facts?.at(-1)
    if (Number(resized.resizeGeneration) !== Number(beforeResize?.resizeGeneration) + 1) {
        failures.push('browser resize did not produce exactly one resize generation')
    }
    const previousResize = parseJson(
        beforeResize?.lastResizeFacts,
        'pre-resize facts',
        failures
    )
    const resize = parseJson(resized.lastResizeFacts, 'resize facts', failures)
    if (resize?.resizeGeneration !== Number(resized.resizeGeneration) ||
        resize?.staleBindSetCount !== 0 || resize?.preparedBindSetCount !== 0 ||
        resize?.depthAllocationVersion !== previousResize?.depthAllocationVersion + 1) {
        failures.push('Surface/depth resize or stale-BindSet acknowledgement was incorrect')
    }
    if (resized.staleBindSetPreparationCount !== '0') {
        failures.push('resize unexpectedly prepared an unrelated BindSet')
    }

    if (drained.pendingObservationCount !== '0') {
        failures.push('SubmittedWork observations were still pending after drain')
    }
    if (drained.currentPendingNativeObservations !== '0') {
        failures.push('native observations were still pending after drain')
    }
    if (drained.currentEffectfulSubmittedWork !== '0') {
        failures.push('effectful SubmittedWork remained after drain')
    }
    const frameWork = parseJson(drained.frameWork, 'drained frame work', failures)
    if (frameWork?.active !== 0) {
        failures.push('Underwater Terrain frame scheduler remained active after drain')
    }
    const deduplicatedInvalidations = Number(drained.deduplicatedFrameInvalidations)
    const latestCaptureRevision = Number(drained.latestFrameCaptureRevision)
    const submittedCaptureRevision = Number(drained.submittedFrameCaptureRevision)
    if (!Number.isSafeInteger(deduplicatedInvalidations) || deduplicatedInvalidations < 0 ||
        !Number.isSafeInteger(latestCaptureRevision) || latestCaptureRevision < 0 ||
        !Number.isSafeInteger(submittedCaptureRevision) || submittedCaptureRevision < 0 ||
        latestCaptureRevision !== submittedCaptureRevision) {
        failures.push('Underwater Terrain host-capture revisions did not drain to one latest state')
    }

    if (!proof.cleanupPair?.equivalentReports || proof.cleanupPair.reports?.length !== 2) {
        failures.push('double disposal did not return two equivalent cleanup reports')
    } else {
        validateCleanup(proof.cleanupPair.reports[0], [
            'underwater-terrain-frame-scheduler',
            'underwater-terrain-presentation-control',
            'dem-virtual-raster-demand',
            'pagehide-listener',
            'underwater-terrain-control-panel',
            'underwater-terrain-inverse-cover',
            'dem-virtual-raster-streaming',
            'scratch-runtime',
            'maplibre-map',
        ], failures)
        const lifecycle = proof.cleanupPair.reports[0]?.lifecycle
        if (lifecycle?.state !== 'disposed' || lifecycle?.ownsMap || lifecycle?.ownsRuntime ||
            lifecycle?.pendingObservationCount !== 0) {
            failures.push('normal cleanup retained a lifecycle owner')
        }
    }
    if (proof.terminalStatus !== 'disposed') {
        failures.push(`terminal page status was ${proof.terminalStatus}`)
    }

    for (const [ label, sample ] of [ [ 'resized', proof.pixels.resized ] ]) {
        if (sample.nonBackgroundPixels < 1_000 || sample.nonTransparentPixels < 100 ||
            sample.channelRange < 8 || sample.meanLuma < 0.05) {
            failures.push(`${label} Underwater Terrain screenshot was blank or visually uniform`)
        }
    }
    if (scenarios.length >= 2 && scenarios[0].pixelHashes.final === scenarios[1].pixelHashes.final) {
        failures.push('zoom 9 and zoom 10 produced identical terrain pixels')
    }
    if (proof.completeImageRequests.length > 0) {
        failures.push('normal Underwater Terrain page requested the complete dem.png asset')
    }
    if (proof.tileRequests.length === 0) {
        failures.push('normal Underwater Terrain page did not request COG-backed HTTP tiles')
    }
    validateCleanEvents('normal Underwater Terrain page', proof, failures, 0)
}

function validateUnderwaterTerrainFacts(label, facts, failures, expectedStatus = 'ready') {

    if (facts.status !== expectedStatus) failures.push(`${label} status was ${facts.status}`)
    if (facts.proofMode !== 'true') failures.push(`${label} deterministic proof mode was not active`)
    if (facts.adapterAcquired !== 'true') failures.push(`${label} runtime adapter was not acquired`)
    if (facts.stageOrder !== expectedStageOrder.join('|') ||
        facts.stageCount !== String(expectedStageOrder.length)) {
        failures.push(`${label} stage order was incorrect`)
    }
    const count = Number(facts.coverPatchCount)
    if (!Number.isSafeInteger(count) || count < 1 || count > 5_000) {
        failures.push(`${label} cover patch count was outside 1..5000`)
    }
    if (facts.selectionPath !== 'gpu-camera-inverse-webmercatorquad-cover' ||
        facts.countPath !== 'gpu-produced-indirect-arguments' ||
        facts.cpuSelectionUploadCount !== '0') {
        failures.push(`${label} did not use the clean GPU selection/count path`)
    }
    if (facts.diagnosticsBounded !== 'true') failures.push(`${label} diagnostics were not bounded`)
    if (facts.diagnosticIncidents !== '0') failures.push(`${label} retained a diagnostic incident`)
    if (facts.uncapturedErrors !== '0') failures.push(`${label} reported an uncaptured GPU error`)
    if (facts.deviceLosses !== '0') failures.push(`${label} reported device loss`)

    const identity = parseJson(facts.currentIdentityFacts, `${label} identity facts`, failures)
    if (identity?.hash !== facts.currentStableIdentityHash ||
        String(identity?.count) !== facts.currentStableIdentityCount ||
        identity?.resources < 1 || identity?.commands < 1) {
        failures.push(`${label} current identity hash/count publication was inconsistent`)
    }

    const provenance = parseJson(facts.provenance, `${label} provenance`, failures)
    if (!Array.isArray(provenance) ||
        provenance.length !== requiredProvenanceNames.length) {
        failures.push(`${label} provenance did not contain the exact required chains`)
    } else {
        for (const [ index, chain ] of provenance.entries()) {
            const expectedName = requiredProvenanceNames[index]
            if (chain.name !== expectedName) {
                failures.push(`${label} provenance chain ${index} was incorrect`)
            }
            if (chain.declaredContentEpoch !== 'current-at-step') {
                failures.push(`${label} ${chain.name} lost current-at-step`)
            }
            if (chain.producerContentEpoch !== chain.readContentEpoch) {
                failures.push(`${label} ${chain.name} producer/read epochs differed`)
            }
            if (chain.producerStepIndex >= chain.consumerStepIndex) {
                failures.push(`${label} ${chain.name} producer did not precede its consumer`)
            }
        }
    }
    const contract = parseJson(facts.graphContract, `${label} graph contract`, failures)
    if (contract?.countPath !== 'gpu-produced-indirect-arguments' ||
        contract?.selectionPath !== 'gpu-camera-inverse-webmercatorquad-cover' ||
        contract?.sourceMaximumMatrixLevel !== 10 ||
        contract?.coverMaximumMatrixLevel !== 14 ||
        contract?.cover?.selectionPath !==
            'gpu-camera-inverse-webmercatorquad-cover' ||
        contract?.cover?.policy?.maximumMatrixLevel !== 14 ||
        contract?.cover?.policy?.cellsPerPatchEdge !== 128 ||
        contract?.cover?.policy?.maximumCellSpanReferencePixels !== 5 ||
        contract?.cover?.policy?.refinementTolerance !== 0.005 ||
        contract?.cover?.policy?.maximumPatches < count ||
        contract?.cover?.lookupCapacity <= contract?.cover?.policy?.maximumPatches ||
        contract?.cover?.coverageLimitCount < 1 ||
        contract?.cover?.verticalBoundsMode !== 'hierarchy' ||
        contract?.cover?.verticalBoundCount !== 49 ||
        contract?.demandProjection?.sourceMaximumMatrixLevel !== 10 ||
        contract?.demandProjection?.maximumDemands < count ||
        contract?.patchDraw?.elementCount !== 98_304 ||
        contract?.terrainElementCount !== 98_304 ||
        JSON.stringify(contract?.stageOrder) !== JSON.stringify(expectedStageOrder)) {
        failures.push(`${label} persistent graph contract drifted`)
    }
    parseJson(facts.cameraView, `${label} camera view`, failures)
    const cover = parseJson(facts.coverFeedback, `${label} cover feedback`, failures)
    const demandFeedback = parseJson(
        facts.demandFeedback,
        `${label} demand feedback`,
        failures
    )
    const coverLevelRange = parseJson(
        facts.coverLevelRange,
        `${label} cover level range`,
        failures
    )
    const demandLevelsAreValid = Array.isArray(demandFeedback?.demands) &&
        demandFeedback.demands.every(
        demand => demand?.sourceLevelCeiling === 10 &&
            demand?.requestMatrixLevel <= demand.sourceLevelCeiling &&
            demand?.desiredSampleLevel >= demand.requestMatrixLevel &&
            demand?.desiredSampleLevel <= 14 &&
            demand?.decisionFrameEpoch === demandFeedback.frameEpoch
    )
    if (cover?.patchCount !== count ||
        cover?.candidateCount < cover?.patchCount ||
        cover?.descriptorOverflowCount !== 0 ||
        cover?.lookupOverflowCount !== 0 ||
        cover?.maximumAdjacentLevelDelta > 1 ||
        cover?.finestMatrixLevel > 14 ||
        cover?.frameEpoch !== Number(facts.coverFrameEpoch) ||
        !Array.isArray(coverLevelRange) ||
        coverLevelRange[0] !== cover?.minimumMatrixLevel ||
        coverLevelRange[1] !== cover?.maximumMatrixLevel ||
        demandFeedback?.demandCount !== Number(facts.sourceDemandCount) ||
        demandFeedback?.demands?.length !== demandFeedback?.demandCount ||
        demandFeedback?.overflowCount !== 0 ||
        demandFeedback?.sourceLevelCeiling !== 10 ||
        demandFeedback?.frameEpoch !== cover?.frameEpoch ||
        !demandLevelsAreValid) {
        failures.push(`${label} inverse-cover feedback was inconsistent`)
    }
    if (contract?.virtualRaster?.completeImageUpload !== false ||
        contract?.virtualRaster?.crossPageFiltering !== 'logical-bilinear' ||
        contract?.virtualRaster?.coordinateEncoding !== 'wide-fixed') {
        failures.push(`${label} virtual raster graph contract drifted`)
    }
    if (expectedStatus === 'ready' && (facts.coverConverged !== 'true' ||
        facts.convergenceState !== 'converged')) {
        failures.push(`${label} GPU inverse cover did not converge`)
    }
    validateVirtualRasterFacts(label, facts, failures)
}

function validateVirtualRasterFacts(label, facts, failures) {

    const virtualRaster = parseJson(facts.virtualRaster, `${label} virtual raster facts`, failures)
    const residency = virtualRaster?.residency
    const residencyAudit = parseJson(facts.residencyAudit, `${label} residency audit`, failures)
    const gpu = virtualRaster?.gpu
    const maximumPages = Number(facts.maxPhysicalPages)
    if (!Number.isSafeInteger(maximumPages) || maximumPages < 2 || maximumPages > 64) {
        failures.push(`${label} physical page budget was invalid`)
    }
    if (virtualRaster?.coordinateEncoding !== 'wide-fixed' ||
        virtualRaster?.coordinateBits !== 40 ||
        !Number.isFinite(virtualRaster?.coordinateQuantumMeters) ||
        virtualRaster.coordinateQuantumMeters <= 0 || residency?.failedCount !== 0) {
        failures.push(`${label} virtual raster precision or failure facts were invalid`)
    }
    if (residency?.residentCount < 1 || residency?.residentCount > maximumPages ||
        residency?.pinnedCount !== 1 || residency?.stagingBytes > residency?.maxStagingBytes ||
        residency?.maxPhysicalPages !== maximumPages || residency?.failedCount !== 0 ||
        !Number.isSafeInteger(residencyAudit?.retiredStagedPageCount) ||
        residencyAudit.retiredStagedPageCount < 0 ||
        residency?.staleResponseCount !== residencyAudit.retiredStagedPageCount ||
        residencyAudit?.rejectedStaleOperationCount !== 0 ||
        residencyAudit?.unrequiredUploadCount !== 0 || residency?.history?.length > 64) {
        failures.push(`${label} virtual raster residency exceeded its finite contract: ${JSON.stringify({
            maximumPages,
            residentCount: residency?.residentCount,
            pinnedCount: residency?.pinnedCount,
            maxPhysicalPages: residency?.maxPhysicalPages,
            failedCount: residency?.failedCount,
            staleResponseCount: residency?.staleResponseCount,
            residencyAudit,
            historyLength: residency?.history?.length,
        })}`)
    }
    if (gpu?.maxPhysicalPages !== maximumPages || gpu?.snapshotEpoch !== residency?.snapshotEpoch ||
        gpu?.pageTableEntryCount < 1 || gpu?.pageTableBytes < 1) {
        failures.push(`${label} GPU virtual raster snapshot facts were inconsistent`)
    }
    if (Number(facts.virtualSnapshotEpoch) !== residency?.snapshotEpoch ||
        Number(facts.virtualRequestedPageCount) < 0) {
        failures.push(`${label} published virtual raster frame facts were inconsistent`)
    }
}

function validatePersistentCounts(before, after, failures) {

    const first = parseJson(before.persistentFacts, 'initial persistent facts', failures)
    const second = parseJson(after.persistentFacts, 'resized persistent facts', failures)
    for (const name of [ 'resources', 'bindLayouts', 'bindSets', 'pipelines' ]) {
        if (!Number.isSafeInteger(first?.[name]) || first[name] !== second?.[name]) {
            failures.push(`persistent ${name} count changed across resize`)
        }
    }
}

function validateFailureProof(result, failures) {

    const prefix = `failure ${result.scenario}`
    if (!failureScenarios.includes(result.scenario)) {
        failures.push(`${prefix} was not a configured scenario`)
        return
    }
    if (result.facts.status !== 'error') failures.push(`${prefix} status was not error`)
    if (result.facts.failureScenario !== result.scenario) {
        failures.push(`${prefix} published the wrong scenario`)
    }
    const proof = result.proof
    if (proof?.scenario !== result.scenario || proof?.reachedCount !== 1 ||
        proof?.mapAcquiredCount !== 1) {
        failures.push(`${prefix} did not reach its acquisition boundary exactly once`)
    }
    validateCleanEvents(prefix, result, failures, 1)

    if (result.scenario === 'after-map-acquisition') {
        if (proof?.rasterAcquiredCount !== 0 ||
            proof?.primaryFailure?.code !== 'UNDERWATER_TERRAIN_INJECTED_FAILURE') {
            failures.push(`${prefix} lost the pre-runtime acquisition boundary or primary failure`)
        }
        if (proof?.runtimeEvidence !== undefined || proof?.captureReport !== undefined) {
            failures.push(`${prefix} fabricated GPU evidence before runtime acquisition`)
        }
        validateCleanup(proof, [
            'pagehide-listener',
            'underwater-terrain-control-panel',
            'maplibre-map',
        ], failures)
        return
    }

    if (proof?.rasterAcquiredCount !== 1) {
        failures.push(`${prefix} did not acquire exactly one virtual raster`)
    }
    if (proof?.diagnostic?.code !== 'SCRATCH_SHADER_MODULE_COMPILATION_FAILED') {
        failures.push(`${prefix} did not retain the ShaderModule compilation failure`)
    }
    const target = proof?.incident?.target
    if (target?.kind !== 'shader-module' || typeof target?.shaderModuleId !== 'string') {
        failures.push(`${prefix} did not localize the terrain ShaderModule`)
    }
    const compilation = proof?.incident?.shaderModuleCompilationReport
    if (compilation?.shaderModuleId !== target?.shaderModuleId ||
        compilation?.sourceHash !== target?.sourceHash ||
        compilation?.sourcePartCount !== 3 ||
        compilation?.retainedSourcePartCount !== 3 ||
        compilation?.errorCount < 1) {
        failures.push(`${prefix} did not retain the three localized source-part compilation report`)
    }
    if (proof?.captureBounds?.maxOperations !== 1 ||
        proof?.captureBounds?.maxDurationMs !== 2_000 ||
        proof?.captureBounds?.maxEvidenceBytes !== 65_536) {
        failures.push(`${prefix} deep capture bounds drifted`)
    }
    const capture = proof?.captureReport
    if (!Array.isArray(capture?.operations) || capture.operations.length !== 1 ||
        capture.retainedEvidenceBytes > 65_536 ||
        capture.stoppedAtMs - capture.startedAtMs > 2_000) {
        failures.push(`${prefix} deep capture exceeded its finite bounds`)
    }
    if (!Number.isSafeInteger(proof?.runtimeEvidenceByteLength) ||
        proof.runtimeEvidenceByteLength > proof.runtimeEvidenceMaxBytes) {
        failures.push(`${prefix} runtime evidence exceeded its finite bound`)
    }
    if (proof?.retainsWgslSource !== false) failures.push(`${prefix} retained WGSL source`)
    const evidenceText = JSON.stringify(proof?.runtimeEvidence)
    if (evidenceText.includes('underwaterTerrainInjectedFailure') || /"source"\s*:/.test(evidenceText)) {
        failures.push(`${prefix} exported raw WGSL source evidence`)
    }
    validateCleanup(proof, [
        'dem-virtual-raster-demand',
        'pagehide-listener',
        'underwater-terrain-control-panel',
        'dem-virtual-raster-streaming',
        'scratch-runtime',
        'maplibre-map',
    ], failures)
}

function validateCleanup(container, expectedLabels, failures) {

    const cleanup = container?.cleanup ?? container?.report
    if (cleanup?.cleanupInvocationCount !== 1) failures.push('cleanup did not run exactly once')
    if (cleanup?.pendingObservationsAfter !== 0) failures.push('cleanup retained pending observations')
    if (cleanup?.retainedActionCount !== 0) failures.push('cleanup retained registered actions')
    if (!Array.isArray(cleanup?.cleanupFailures) || cleanup.cleanupFailures.length !== 0) {
        failures.push('cleanup reported a secondary failure')
    }
    const labels = cleanup?.cleanupActions?.map(action => action.label)
    if (JSON.stringify(labels) !== JSON.stringify(expectedLabels)) {
        failures.push(`cleanup order was ${JSON.stringify(labels)}`)
    }
    if (cleanup?.cleanupActions?.some(action => action.status !== 'fulfilled')) {
        failures.push('cleanup contained an unfulfilled action')
    }
}

function validateCleanEvents(label, events, failures, expectedConsoleFailures) {

    if (events.consoleFailures.length !== expectedConsoleFailures) {
        failures.push(`${label} emitted ${events.consoleFailures.length} console errors`)
    }
    if (events.consoleWarnings.length > 0) failures.push(`${label} emitted console warnings`)
    if (events.pageErrors.length > 0) failures.push(`${label} emitted page errors`)
    if (events.requestFailures.length > 0) failures.push(`${label} emitted request failures`)
    if (events.httpFailures.length > 0) failures.push(`${label} received HTTP 4xx/5xx responses`)
}

function summarizeNormalProof(proof) {

    const resize = parseJsonOrUndefined(proof.resizedFacts.lastResizeFacts)
    return {
        cameraAbaTransition: {
            cameraA: proof.cameraAbaTransition.cameraA,
            cameraB: proof.cameraAbaTransition.cameraB,
            issued: proof.cameraAbaTransition.issued,
            stableSignatureCount: new Set(proof.cameraAbaTransition.signatures).size,
            final: summarizeFacts(proof.cameraAbaTransition.finalFacts),
        },
        rapidCameraTransition: {
            stepCount: proof.rapidCameraTransition.stepCount,
            finalCamera: proof.rapidCameraTransition.finalCamera,
            final: summarizeFacts(proof.rapidCameraTransition.finalFacts),
            restored: summarizeFacts(proof.rapidCameraTransition.restoredFacts),
        },
        scenarios: proof.scenarios.map(result => ({
            name: result.name,
            camera: result.camera,
            viewport: result.viewport,
            stableFrameCount: result.facts.length,
            stableSignatureCount: new Set(result.signatures).size,
            signatures: new Set(result.signatures).size === 1 ? undefined : result.signatures,
            final: summarizeFacts(result.facts.at(-1)),
            screenshots: result.screenshots,
            pixelHashes: result.pixelHashes,
            pixels: result.pixels,
        })),
        resized: {
            ...summarizeFacts(proof.resizedFacts),
            resize,
        },
        drained: {
            status: proof.drainedFacts.status,
            pendingObservationCount: Number(proof.drainedFacts.pendingObservationCount),
            currentPendingNativeObservations: Number(
                proof.drainedFacts.currentPendingNativeObservations
            ),
            currentEffectfulSubmittedWork: Number(
                proof.drainedFacts.currentEffectfulSubmittedWork
            ),
            frameWork: parseJsonOrUndefined(proof.drainedFacts.frameWork),
            deduplicatedFrameInvalidations: Number(
                proof.drainedFacts.deduplicatedFrameInvalidations
            ),
            latestFrameCaptureRevision: Number(
                proof.drainedFacts.latestFrameCaptureRevision
            ),
            submittedFrameCaptureRevision: Number(
                proof.drainedFacts.submittedFrameCaptureRevision
            ),
        },
        cleanup: summarizeCleanupProof(proof.cleanupPair.reports?.[0]),
        terminalStatus: proof.terminalStatus,
        screenshots: proof.screenshots,
        pixelHashes: proof.pixelHashes,
        pixels: proof.pixels,
        consoleFailures: proof.consoleFailures,
        consoleWarnings: proof.consoleWarnings,
        pageErrors: proof.pageErrors,
        requestFailures: proof.requestFailures,
        cancelledTileRequestCount: proof.cancelledTileRequests.length,
        httpFailures: proof.httpFailures,
        requestCount: proof.requests.length,
        tileRequestCount: proof.tileRequests.length,
        completeImageRequestCount: proof.completeImageRequests.length,
    }
}

function summarizeFacts(facts) {

    const coverFeedback = parseJsonOrUndefined(facts.coverFeedback)
    return {
        status: facts.status,
        frames: Number(facts.frames),
        observedFrames: Number(facts.observedFrames),
        coverPatchCount: Number(facts.coverPatchCount),
        coverCandidateCount: Number(facts.coverCandidateCount),
        sourceDemandCount: Number(facts.sourceDemandCount),
        coverLevelRange: parseJsonOrUndefined(facts.coverLevelRange),
        convergenceState: facts.convergenceState,
        coverFeedback,
        demandFeedback: parseJsonOrUndefined(facts.demandFeedback),
        residencyAudit: parseJsonOrUndefined(facts.residencyAudit),
        cameraView: parseJsonOrUndefined(facts.cameraView),
        stableIdentityCount: Number(facts.currentStableIdentityCount),
        stableIdentityHash: facts.currentStableIdentityHash,
        identityFacts: parseJsonOrUndefined(facts.currentIdentityFacts),
        provenance: parseJsonOrUndefined(facts.provenance),
        persistentFacts: parseJsonOrUndefined(facts.persistentFacts),
        diagnosticIncidents: Number(facts.diagnosticIncidents),
        uncapturedErrors: Number(facts.uncapturedErrors),
        deviceLosses: Number(facts.deviceLosses),
    }
}

function summarizeFailureProof(result) {

    const proof = result.proof
    const compilation = proof?.incident?.shaderModuleCompilationReport
    const capture = proof?.captureReport
    return {
        scenario: result.scenario,
        facts: {
            status: result.facts.status,
            error: result.facts.error,
            failureScenario: result.facts.failureScenario,
        },
        proof: {
            schemaVersion: proof?.schemaVersion,
            scenario: proof?.scenario,
            reachedCount: proof?.reachedCount,
            mapAcquiredCount: proof?.mapAcquiredCount,
            rasterAcquiredCount: proof?.rasterAcquiredCount,
            primaryFailure: proof?.primaryFailure,
            diagnosticCode: proof?.diagnostic?.code,
            incident: proof?.incident === undefined ? undefined : {
                diagnosticCode: proof.incident.diagnosticCode,
                target: proof.incident.target,
                outcomeCodes: proof.incident.outcomes?.map(outcome => outcome.diagnosticCode),
                shaderModuleCompilationReport: compilation === undefined ? undefined : {
                    shaderModuleId: compilation.shaderModuleId,
                    sourceHash: compilation.sourceHash,
                    sourcePartCount: compilation.sourcePartCount,
                    retainedSourcePartCount: compilation.retainedSourcePartCount,
                    errorCount: compilation.errorCount,
                    retainedEvidenceBytes: compilation.retainedEvidenceBytes,
                },
            },
            runtimeEvidenceByteLength: proof?.runtimeEvidenceByteLength,
            runtimeEvidenceMaxBytes: proof?.runtimeEvidenceMaxBytes,
            captureBounds: proof?.captureBounds,
            captureReport: capture === undefined ? undefined : {
                stopReason: capture.stopReason,
                operationCount: capture.operations?.length,
                retainedEvidenceBytes: capture.retainedEvidenceBytes,
                omittedOperations: capture.omittedOperations,
                durationMs: capture.stoppedAtMs - capture.startedAtMs,
            },
            retainsWgslSource: proof?.retainsWgslSource,
            cleanup: summarizeCleanupReport(proof?.cleanup),
        },
        consoleFailures: result.consoleFailures,
        consoleWarnings: result.consoleWarnings,
        pageErrors: result.pageErrors,
        requestFailures: result.requestFailures,
        httpFailures: result.httpFailures,
    }
}

function parseJson(value, label, failures) {

    try {
        return JSON.parse(value)
    } catch {
        failures.push(`${label} was not valid JSON`)
        return undefined
    }
}

function summarizeCleanupProof(proof) {

    if (proof === undefined) return undefined
    return {
        report: summarizeCleanupReport(proof.report),
        lifecycle: proof.lifecycle,
        graphState: proof.graphState === undefined ? undefined : {
            initialized: proof.graphState.initialized,
            frame: proof.graphState.frame,
            size: proof.graphState.size,
            resizeGeneration: proof.graphState.resizeGeneration,
            staleBindSetPreparationCount: proof.graphState.staleBindSetPreparationCount,
            lastResizeFacts: proof.graphState.lastResizeFacts,
            coverPatchCount: proof.graphState.coverPatchCount,
            coverCandidateCount: proof.graphState.coverCandidateCount,
            convergenceState: proof.graphState.convergenceState,
        },
    }
}

function summarizeCleanupReport(report) {

    if (report === undefined) return undefined
    return {
        primaryFailure: report.primaryFailure,
        cleanupInvocationCount: report.cleanupInvocationCount,
        pendingObservationsBefore: report.pendingObservationsBefore,
        pendingObservationsAfter: report.pendingObservationsAfter,
        retainedActionCount: report.retainedActionCount,
        cleanupActions: report.cleanupActions,
        cleanupFailures: report.cleanupFailures,
    }
}

function parseJsonOrUndefined(value) {

    try {
        return JSON.parse(value)
    } catch {
        return undefined
    }
}

function startVite(selectedPort) {

    const child = spawn(process.execPath, [
        viteEntry,
        '--host',
        '127.0.0.1',
        '--port',
        String(selectedPort),
        '--strictPort',
    ], {
        cwd: examplesRoot,
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

function startTileServer(selectedPort) {

    return startProcess(tileServeEntry, [
        '--host',
        '127.0.0.1',
        '--port',
        String(selectedPort),
    ], tileServerRoot)
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
        throw new Error([
            `${command} exited with code ${state.child.exitCode}.`,
            state.stderr,
            state.stdout,
        ].filter(Boolean).join('\n'))
    }
    return {
        command,
        exitCode: state.child.exitCode,
        stdout: state.stdout,
        stderr: state.stderr,
    }
}

async function waitForVite(viteState, url) {

    await waitForHttpProcess(viteState, url, 'Vite')
}

async function waitForHttpProcess(state, url, label) {

    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
        if (state.spawnError !== undefined) throw state.spawnError
        if (state.child.exitCode !== null) {
            throw new Error(`${label} exited before readiness with code ${state.child.exitCode}.`)
        }
        try {
            const response = await fetch(url, { signal: AbortSignal.timeout(1_000) })
            const ready = response.ok
            await response.body?.cancel()
            if (ready) return
        } catch {
            // The managed listener is not ready yet.
        }
        await delay(100)
    }
    throw new Error(`Timed out waiting for managed ${label} at ${url}.`)
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

async function stopBrowserServer(server) {

    const child = server.process()
    if (child.exitCode !== null || child.signalCode !== null) return 'already-closed'
    try {
        await withTimeout(server.close(), browserShutdownTimeout, 'Chrome graceful shutdown')
        return 'graceful'
    } catch (gracefulError) {
        if (child.exitCode === null && child.signalCode === null) {
            try {
                await withTimeout(server.kill(), browserShutdownTimeout, 'Chrome forced shutdown')
            } catch (forcedError) {
                throw new AggregateError(
                    [ gracefulError, forcedError ],
                    `Chrome process ${child.pid} did not stop`
                )
            }
        }
        await waitForExit(child, browserShutdownTimeout)
        return 'forced'
    }
}

async function waitForExit(child, waitMs) {

    if (child.exitCode !== null || child.signalCode !== null) return
    await new Promise((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => {
            child.off('exit', onExit)
            rejectPromise(new Error(`Process ${child.pid} did not exit within ${waitMs} ms.`))
        }, waitMs)
        const onExit = () => {
            clearTimeout(timer)
            resolvePromise()
        }
        child.once('exit', onExit)
    })
}

async function findAvailablePort() {

    const server = createServer()
    await new Promise((resolvePromise, rejectPromise) => {
        server.once('error', rejectPromise)
        server.listen(0, '127.0.0.1', resolvePromise)
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Failed to select a Vite port.')
    await new Promise((resolvePromise, rejectPromise) => {
        server.close(error => error === undefined ? resolvePromise() : rejectPromise(error))
    })
    return address.port
}

async function waitForPortClosed(selectedPort) {

    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
        if (!await canConnect(selectedPort)) return true
        await delay(100)
    }
    return false
}

async function canConnect(selectedPort) {

    return await new Promise((resolvePromise) => {
        const socket = createConnection({ host: '127.0.0.1', port: selectedPort })
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

function positiveInteger(value, fallback) {

    if (value === undefined && fallback !== undefined) return fallback
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new TypeError(`Expected a positive integer, received ${value}.`)
    }
    return parsed
}

function sha256(value) {

    return createHash('sha256').update(value).digest('hex')
}

function appendBounded(current, chunk) {

    return `${current}${chunk}`.slice(-16_384)
}

function pushBounded(target, value) {

    if (target.length < 32) target.push(value)
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
                    () => rejectPromise(new Error(`${label} exceeded ${milliseconds} ms.`)),
                    milliseconds
                )
            }),
        ])
    } finally {
        clearTimeout(timer)
    }
}

function delay(milliseconds) {

    return new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds))
}
