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
const tileServerRoot = resolve(examplesRoot, 'underwaterTerrain/tile-server')
const viteEntry = resolve(repositoryRoot, 'node_modules/vite/bin/vite.js')
const workerBuildEntry = resolve(
    repositoryRoot,
    'packages/geoscratch/bin/geoscratch-worker.mjs'
)
const tileBuildEntry = resolve(tileServerRoot, '.venv/bin/dem-tile-build')
const tileServeEntry = resolve(tileServerRoot, '.venv/bin/dem-tile-serve')
const timeout = positiveInteger(process.env.GEO_VIRTUAL_RASTER_DEM_TIMEOUT_MS, 120_000)
const headless = process.env.GEO_VIRTUAL_RASTER_DEM_HEADLESS === '1'
const viteMode = process.env.GEO_VIRTUAL_RASTER_DEM_VITE_MODE === 'preview'
    ? 'preview'
    : 'dev'
const outputDirectory = resolve(
    process.env.GEO_VIRTUAL_RASTER_DEM_OUTPUT ?? '/tmp/geoscratch-virtual-raster-dem'
)
const vitePort = await findAvailablePort()
const tilePort = await findAvailablePort()
const baseUrl = `http://127.0.0.1:${vitePort}`
const tileBaseUrl = `http://127.0.0.1:${tilePort}`
const cacheNamespace = `geoscratch-dem-proof-${vitePort}-${Date.now()}`
const operationalAtlasPages = 64
const tightAtlasPages = 2
const defaultCamera = Object.freeze({ center: [ 120.980697, 31.684162 ], zoom: 10 })
const pageBoundaryCamera = Object.freeze({
    center: [ 120.9375, 31.684162 ],
    zoom: 11,
})
const westCamera = Object.freeze({ center: [ 120.80, 31.68 ], zoom: 11 })
const eastCamera = Object.freeze({ center: [ 121.72, 31.65 ], zoom: 11 })
const northCamera = Object.freeze({ center: [ 120.98, 31.98 ], zoom: 11 })
const southCamera = Object.freeze({ center: [ 120.98, 31.64 ], zoom: 11 })
const churnWestCamera = Object.freeze({ center: [ 120.55, 31.65 ], zoom: 11 })
const churnSouthCamera = Object.freeze({ center: [ 120.98, 31.34 ], zoom: 11 })
const zoomedOutCamera = Object.freeze({ center: defaultCamera.center, zoom: 9 })

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
    if (viteMode === 'dev') {
        await runCommand(process.execPath, [
            workerBuildEntry,
            'build',
            '--config',
            './worker-modules.ts',
        ], examplesRoot)
    }
    build = await runCommand(tileBuildEntry, [], tileServerRoot)
    tileServer = startProcess(tileServeEntry, [ '--port', String(tilePort) ], tileServerRoot)
    await waitForHttpProcess(tileServer, `${tileBaseUrl}/health`, 'DEM tile server')
    vite = startProcess(process.execPath, [
        viteEntry,
        ...(viteMode === 'preview' ? [ 'preview' ] : []),
        '--host',
        '127.0.0.1',
        '--port',
        String(vitePort),
        '--strictPort',
    ], examplesRoot)
    await waitForHttpProcess(vite, `${baseUrl}/underwaterTerrain/index.html`, 'Vite')
    browser = await chromium.launch({
        channel: 'chrome',
        headless,
        args: [ '--enable-unsafe-webgpu' ],
    })
    browserVersion = await browser.version()
    proof = viteMode === 'preview'
        ? await runStaticWorkerDeploymentSmoke(browser)
        : await runProof(browser)
} catch (error) {
    fatalError = serializeError(error)
} finally {
    await cleanup('Chrome', async() => {
        if (browser !== undefined) await withTimeout(browser.close(), 15_000, 'Chrome shutdown')
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
for (const failure of cleanupFailures) failures.push(failure)
const result = {
    schemaVersion: 1,
    status: failures.length === 0 ? 'passed' : 'failed',
    headed: !headless,
    browserVersion,
    baseUrl,
    tileBaseUrl,
    atlasPages: {
        operational: operationalAtlasPages,
        tight: tightAtlasPages,
    },
    outputDirectory,
    viteMode,
    sourceHash: parseBuildHash(build?.stdout),
    proof: summarizeProof(proof),
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

    const budget = await runBudgetLimitedProof(activeBrowser)
    const terminalFailure = await runTerminalFailureProof(activeBrowser)
    const cancellation = await runCancellationProof(activeBrowser)
    const streaming = await runStreamingProof(activeBrowser)
    return { ...streaming, budget, terminalFailure, cancellation }
}

async function runStaticWorkerDeploymentSmoke(activeBrowser) {

    const manifestUrl = new URL('/scratch-workers/manifest.json', baseUrl)
    const manifestResponse = await fetch(manifestUrl, { cache: 'no-cache' })
    const manifest = await manifestResponse.json()
    const context = await activeBrowser.newContext({
        viewport: { width: 960, height: 720 },
        deviceScaleFactor: 1,
    })
    const page = await context.newPage()
    const events = observePage(page)
    try {
        const url = `${baseUrl}/underwaterTerrain/index.html?cache=none` +
            `&tileServer=${encodeURIComponent(tileBaseUrl)}`
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout })
        const facts = await waitForStaticWorkerDeployment(page, events)
        const captureFacts = await capture(page, 'static-worker-deployment')
        return {
            kind: 'static-worker-deployment-smoke',
            facts,
            manifest: {
                url: manifestUrl.href,
                status: manifestResponse.status,
                contentType: manifestResponse.headers.get('content-type') ?? '',
                body: manifest,
            },
            capture: captureFacts,
            events,
        }
    } finally {
        await context.close()
    }
}

async function waitForStaticWorkerDeployment(page, events) {

    const deadline = Date.now() + timeout
    let lastFacts
    while (Date.now() < deadline) {
        const facts = await readFacts(page)
        lastFacts = facts
        if (facts.status === 'error') {
            throw new Error(facts.error ?? 'Underwater Terrain page failed')
        }
        if (facts.status === 'ready' && events.workerManifestResponses.length > 0 &&
            events.workerArtifactResponses.length > 0 &&
            events.workerBootstrapResponses.length > 0 && events.tileRequests.length > 0) {
            return facts
        }
        await delay(16)
    }
    throw new Error(`Timed out waiting for static Worker deployment: ${JSON.stringify({
        status: lastFacts?.status,
        error: lastFacts?.error,
        workerManifestResponses: events.workerManifestResponses,
        workerArtifactResponses: events.workerArtifactResponses,
        workerBootstrapResponses: events.workerBootstrapResponses,
        tileRequestCount: events.tileRequests.length,
    })}`)
}

async function runBudgetLimitedProof(activeBrowser) {

    const context = await activeBrowser.newContext({
        viewport: { width: 960, height: 720 },
        deviceScaleFactor: 1,
    })
    const page = await context.newPage()
    const events = observePage(page)
    try {
        const url = `${baseUrl}/underwaterTerrain/index.html?proof=1&atlasPages=${tightAtlasPages}` +
            `&cache=none&tileServer=${encodeURIComponent(tileBaseUrl)}`
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout })
        const first = await waitForStableFacts(page, facts => cameraMatches(facts, zoomedOutCamera))
        const firstCapture = await capture(page, 'tight-budget-first')
        const repeated = await moveAndWait(page, first, zoomedOutCamera)
        const repeatedCapture = await capture(page, 'tight-budget-repeat')
        const cleanupPair = await disposeTwice(page)
        return {
            first,
            repeated,
            captures: { first: firstCapture, repeated: repeatedCapture },
            cleanupPair,
            terminalStatus: await page.locator('#GPUFrame').getAttribute('data-status'),
            events,
        }
    } finally {
        await context.close()
    }
}

async function runTerminalFailureProof(activeBrowser) {

    const context = await activeBrowser.newContext({
        viewport: { width: 960, height: 720 },
        deviceScaleFactor: 1,
    })
    let failedTileUrl
    await context.route(`${tileBaseUrl}/tiles/**`, async route => {
        const url = new URL(route.request().url())
        const match = /^\/tiles\/WebMercatorQuad\/(\d+)\/\d+\/\d+\.png$/.exec(url.pathname)
        if (failedTileUrl === undefined && Number(match?.[1]) > 9) {
            failedTileUrl = url.href
            await route.fulfill({
                status: 404,
                contentType: 'application/json',
                body: JSON.stringify({ code: 'DEM_TILE_MISSING' }),
            })
            return
        }
        await route.continue()
    })
    const page = await context.newPage()
    const events = observePage(page)
    try {
        const url = `${baseUrl}/underwaterTerrain/index.html?proof=1&atlasPages=${operationalAtlasPages}` +
            `&cache=none&tileServer=${encodeURIComponent(tileBaseUrl)}`
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout })
        const facts = await waitForStableFacts(page, current => {
            const virtualRaster = parseJson(current.virtualRaster)
            return failedTileUrl !== undefined &&
                virtualRaster?.residency?.failedCount > 0 &&
                virtualRaster?.scheduler?.failedRequestCount > 0
        })
        const captureFacts = await capture(page, 'terminal-child-404')
        const cleanupPair = await disposeTwice(page)
        return {
            facts,
            capture: captureFacts,
            failedTileUrl,
            cleanupPair,
            terminalStatus: await page.locator('#GPUFrame').getAttribute('data-status'),
            events,
        }
    } finally {
        await context.close()
    }
}

async function disposeTwice(page) {

    return await page.evaluate(async() => {
        const first = window.__UNDERWATER_TERRAIN_PROOF__.dispose()
        const second = window.__UNDERWATER_TERRAIN_PROOF__.dispose()
        const reports = await Promise.all([ first, second ])
        return {
            reports,
            equivalent: JSON.stringify(reports[0]) === JSON.stringify(reports[1]),
        }
    })
}

async function runCancellationProof(activeBrowser) {

    const context = await activeBrowser.newContext({
        viewport: { width: 960, height: 720 },
        deviceScaleFactor: 1,
    })
    let tileDelayMs = 600
    let delayedDetailedRequestCount = 0
    await context.route(`${tileBaseUrl}/tiles/**`, async route => {
        const path = new URL(route.request().url()).pathname
        const matrixLevel = Number(
            /^\/tiles\/WebMercatorQuad\/(\d+)\/\d+\/\d+\.png$/.exec(path)?.[1]
        )
        const capturedDelay = matrixLevel >= 10 ? tileDelayMs : 0
        if (capturedDelay > 0) {
            delayedDetailedRequestCount++
            await delay(capturedDelay)
            delayedDetailedRequestCount--
        }
        try {
            await route.continue()
        } catch {
            // An obsolete Worker fetch can be aborted while the proof delays it.
        }
    })
    const page = await context.newPage()
    const events = observePage(page)
    try {
        const url = `${baseUrl}/underwaterTerrain/index.html?proof=1&atlasPages=${operationalAtlasPages}` +
            `&cache=none&tileServer=${encodeURIComponent(tileBaseUrl)}`
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout })
        const before = await waitForDemandActivity(
            page,
            () => delayedDetailedRequestCount > 0
        )
        await page.evaluate(async(cameras) => {
            for (const camera of cameras) {
                window.__UNDERWATER_TERRAIN_PROOF__.moveCamera(camera)
                await new Promise(resolvePromise => setTimeout(resolvePromise, 80))
            }
        }, [ westCamera, northCamera, southCamera, eastCamera ])
        tileDelayMs = 0
        const facts = await waitForStableFacts(page, current => cameraMatches(current, eastCamera))
        const cleanupPair = await disposeTwice(page)
        return {
            before,
            facts,
            cleanupPair,
            terminalStatus: await page.locator('#GPUFrame').getAttribute('data-status'),
            terminalError: await page.locator('#GPUFrame').getAttribute('data-error'),
            events,
        }
    } finally {
        await context.close()
    }
}

async function runStreamingProof(activeBrowser) {

    const context = await activeBrowser.newContext({
        viewport: { width: 960, height: 720 },
        deviceScaleFactor: 1,
    })
    let tileDelayMs = 0
    await context.route(`${tileBaseUrl}/tiles/**`, async route => {
        const capturedDelay = tileDelayMs
        if (capturedDelay > 0) await delay(capturedDelay)
        try {
            await route.continue()
        } catch {
            // An obsolete Worker fetch can be aborted while the proof delays it.
        }
    })
    const page = await context.newPage()
    const events = observePage(page)
    try {
        const url = `${baseUrl}/underwaterTerrain/index.html?proof=1&atlasPages=${operationalAtlasPages}` +
            `&cache=persistent&cacheNamespace=${encodeURIComponent(cacheNamespace)}` +
            '&cacheLifecycle=durable-reuse&cacheMaxMiB=128&cacheMaxEntries=2048' +
            '&cachePersistence=request' +
            `&tileServer=${encodeURIComponent(tileBaseUrl)}`
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout })
        const initial = await waitForStableFacts(page)
        const initialCapture = await capture(page, 'initial')

        const detailed = await moveAndWait(page, initial, defaultCamera)
        const detailedCapture = await capture(page, 'zoom-in')

        const boundary = await moveAndWait(page, detailed, pageBoundaryCamera)
        const boundaryCapture = await capture(page, 'page-boundary')

        tileDelayMs = 150
        await page.evaluate(async(cameras) => {
            for (const camera of cameras) {
                window.__UNDERWATER_TERRAIN_PROOF__.moveCamera(camera)
                await new Promise(resolvePromise => setTimeout(resolvePromise, 25))
            }
        }, [ eastCamera, churnWestCamera, northCamera, churnSouthCamera, eastCamera ])
        tileDelayMs = 0
        const churn = await waitForStableFacts(page, facts => (
            cameraMatches(facts, eastCamera)
        ))
        const churnCapture = await capture(page, 'rapid-churn-east')

        const west = await moveAndWait(page, churn, westCamera)
        const westCapture = await capture(page, 'west-pan')

        const north = await moveAndWait(page, west, northCamera)
        const northCapture = await capture(page, 'north-pan')

        const south = await moveAndWait(page, north, southCamera)
        const southCapture = await capture(page, 'south-pan')

        const zoomedOut = await moveAndWait(page, south, zoomedOutCamera)
        const zoomedOutCapture = await capture(page, 'zoom-out')

        const returned = await moveAndWait(page, zoomedOut, pageBoundaryCamera)
        const returnedCapture = await capture(page, 'camera-return')

        const repeated = await moveAndWait(page, returned, pageBoundaryCamera)
        const repeatedCapture = await capture(page, 'static-repeat')

        const resizeGeneration = Number(repeated.resizeGeneration)
        await page.setViewportSize({ width: 800, height: 600 })
        const resized = await waitForStableFacts(page, facts => (
            Number(facts.resizeGeneration) > resizeGeneration
        ))
        const resizedCapture = await capture(page, 'resized')

        const statsResponse = await fetch(`${tileBaseUrl}/stats`)
        const tileStatsBeforeReload = await statsResponse.json()
        const drained = await page.evaluate(async() => (
            await window.__UNDERWATER_TERRAIN_PROOF__.pauseAndDrain()
        ))
        const cleanupPair = await page.evaluate(async() => {
            const first = window.__UNDERWATER_TERRAIN_PROOF__.dispose()
            const second = window.__UNDERWATER_TERRAIN_PROOF__.dispose()
            const reports = await Promise.all([ first, second ])
            return {
                reports,
                equivalent: JSON.stringify(reports[0]) === JSON.stringify(reports[1]),
            }
        })
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout })
        const reload = await waitForStableFacts(page)
        const tileStatsAfterReload = await (await fetch(`${tileBaseUrl}/stats`)).json()
        const reloadCleanupPair = await page.evaluate(async() => {
            const first = window.__UNDERWATER_TERRAIN_PROOF__.dispose()
            const second = window.__UNDERWATER_TERRAIN_PROOF__.dispose()
            const reports = await Promise.all([ first, second ])
            return {
                reports,
                equivalent: JSON.stringify(reports[0]) === JSON.stringify(reports[1]),
            }
        })
        return {
            facts: {
                initial,
                detailed,
                boundary,
                churn,
                west,
                north,
                south,
                zoomedOut,
                returned,
                repeated,
                resized,
                drained,
            },
            reload,
            captures: {
                initial: initialCapture,
                detailed: detailedCapture,
                boundary: boundaryCapture,
                churn: churnCapture,
                west: westCapture,
                north: northCapture,
                south: southCapture,
                zoomedOut: zoomedOutCapture,
                returned: returnedCapture,
                repeated: repeatedCapture,
                resized: resizedCapture,
            },
            tileStats: tileStatsAfterReload,
            tileStatsBeforeReload,
            cleanupPair,
            reloadCleanupPair,
            terminalStatus: await page.locator('#GPUFrame').getAttribute('data-status'),
            events,
        }
    } finally {
        await context.close()
    }
}

async function moveAndWait(page, before, camera) {

    const previousFrames = Number(before.observedFrames)
    await page.evaluate(value => window.__UNDERWATER_TERRAIN_PROOF__.moveCamera(value), camera)
    return await waitForStableFacts(page, facts => (
        Number(facts.observedFrames) > previousFrames && cameraMatches(facts, camera)
    ))
}

function cameraMatches(facts, camera) {

    const view = parseJson(facts.cameraView)
    return Math.abs(view?.zoom - camera.zoom) < 1e-6 &&
        Math.abs(view?.center?.[0] - camera.center[0]) < 1e-9 &&
        Math.abs(view?.center?.[1] - camera.center[1]) < 1e-9
}

function frontierSignature(facts) {

    const frontier = parseJson(facts.frontier)
    return JSON.stringify({
        activeFrontierCount: frontier?.activeFrontierCount,
        visibleInstanceCount: frontier?.visibleInstanceCount,
        refineCandidateCount: frontier?.refineCandidateCount,
        coarsenCandidateCount: frontier?.coarsenCandidateCount,
        coarsenGracePendingCount: frontier?.coarsenGracePendingCount,
        demandCount: frontier?.demandCount,
        fallbackCount: frontier?.fallbackCount,
        budgetLimitedCount: frontier?.budgetLimitedCount,
        maximumObservedSse: frontier?.maximumObservedSse,
        minimumSelectedMatrixLevel: frontier?.minimumSelectedMatrixLevel,
        maximumSelectedMatrixLevel: frontier?.maximumSelectedMatrixLevel,
        convergenceState: frontier?.convergenceState,
    })
}

async function waitForStableFacts(page, additional = () => true) {

    const deadline = Date.now() + timeout
    let lastFacts
    while (Date.now() < deadline) {
        const facts = await readFacts(page)
        lastFacts = facts
        if (facts.status === 'error') {
            throw new Error(facts.error ?? 'Underwater Terrain page failed')
        }
        const virtualRaster = parseJson(facts.virtualRaster)
        const frontier = parseJson(facts.frontier)
        const terminalFrontier = frontier?.convergenceState === 'converged' ||
            frontier?.convergenceState === 'budget-limited'
        if (facts.status === 'ready' && Number(facts.frames) === Number(facts.observedFrames) &&
            terminalFrontier && frontier?.demandCount === 0 &&
            virtualRaster?.residency?.stagedCount === 0 &&
            virtualRaster?.residency?.stagingBytes === 0 &&
            virtualRaster?.scheduler?.activeRequestCount === 0 &&
            virtualRaster?.scheduler?.queuedRequestCount === 0 &&
            virtualRaster?.worker?.pendingCandidateCount === 0 &&
            virtualRaster?.worker?.senderDecodedByteLength === 0 &&
            virtualRaster?.worker?.system?.activeTaskCount === 0 &&
            virtualRaster?.worker?.system?.queuedTaskCount === 0 &&
            virtualRaster?.worker?.group?.activeTaskCount === 0 &&
            virtualRaster?.worker?.group?.queuedTaskCount === 0 &&
            virtualRaster?.gpu?.stagedSnapshotEpoch === undefined &&
            Number(facts.currentPendingNativeObservations) === 0 && additional(facts)) {
            return facts
        }
        await delay(16)
    }
    const virtualRaster = parseJson(lastFacts?.virtualRaster)
    throw new Error(`Timed out waiting for a stable DEM virtual-raster frame: ${JSON.stringify({
        status: lastFacts?.status,
        frames: lastFacts?.frames,
        observedFrames: lastFacts?.observedFrames,
        virtualRequestedPageCount: lastFacts?.virtualRequestedPageCount,
        frontier: parseJson(lastFacts?.frontier),
        residency: virtualRaster?.residency,
        scheduler: virtualRaster?.scheduler,
        worker: virtualRaster?.worker,
        gpu: virtualRaster?.gpu,
    })}`)
}

async function waitForDemandActivity(page, additional = () => true) {

    const deadline = Date.now() + timeout
    let lastFacts
    while (Date.now() < deadline) {
        const facts = await readFacts(page)
        lastFacts = facts
        if (facts.status === 'error') {
            throw new Error(facts.error ?? 'Underwater Terrain page failed')
        }
        const virtualRaster = parseJson(facts.virtualRaster)
        if (facts.status === 'ready' &&
            virtualRaster?.scheduler?.activeRequestCount > 0 &&
            virtualRaster?.worker?.system?.activeTaskCount > 0 && additional()) {
            return facts
        }
        await delay(16)
    }
    const virtualRaster = parseJson(lastFacts?.virtualRaster)
    throw new Error(`Timed out waiting for active DEM demand: ${JSON.stringify({
        status: lastFacts?.status,
        scheduler: virtualRaster?.scheduler,
        worker: virtualRaster?.worker,
    })}`)
}

async function readFacts(page) {

    return await page.evaluate(() => ({ ...document.querySelector('#GPUFrame')?.dataset }))
}

async function capture(page, name) {

    const path = resolve(outputDirectory, `${name}.png`)
    const png = await page.locator('#GPUFrame').screenshot({
        path,
        style: '#UnderwaterTerrainControlPanel { visibility: hidden !important; }',
    })
    return {
        path,
        hash: createHash('sha256').update(png).digest('hex'),
        pixels: await inspectPixels(page, png),
    }
}

async function inspectPixels(page, png) {

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
        let nonBackground = 0
        let nonFiniteEquivalent = 0
        let minimum = 255
        let maximum = 0
        for (let index = 0; index < pixels.length; index += 4) {
            const red = pixels[index]
            const green = pixels[index + 1]
            const blue = pixels[index + 2]
            minimum = Math.min(minimum, red, green, blue)
            maximum = Math.max(maximum, red, green, blue)
            if (Math.abs(red - 16) + Math.abs(green - 20) + Math.abs(blue - 24) >= 12) {
                nonBackground++
            }
            if (pixels[index + 3] === 0) nonFiniteEquivalent++
        }
        const contrast = (first, second) => (
            Math.abs(pixels[first] - pixels[second]) +
            Math.abs(pixels[first + 1] - pixels[second + 1]) +
            Math.abs(pixels[first + 2] - pixels[second + 2]) >= 36
        )
        const minimumX = Math.floor(canvas.width * 0.05)
        const maximumX = Math.ceil(canvas.width * 0.95)
        const minimumY = Math.floor(canvas.height * 0.05)
        const maximumY = Math.ceil(canvas.height * 0.85)
        let maxVerticalContrastRun = 0
        for (let x = minimumX + 1; x < maximumX; x++) {
            let run = 0
            for (let y = minimumY; y < maximumY; y++) {
                const current = (y * canvas.width + x) * 4
                run = contrast(current, current - 4) ? run + 1 : 0
                maxVerticalContrastRun = Math.max(maxVerticalContrastRun, run)
            }
        }
        let maxHorizontalContrastRun = 0
        for (let y = minimumY + 1; y < maximumY; y++) {
            let run = 0
            for (let x = minimumX; x < maximumX; x++) {
                const current = (y * canvas.width + x) * 4
                run = contrast(current, current - canvas.width * 4) ? run + 1 : 0
                maxHorizontalContrastRun = Math.max(maxHorizontalContrastRun, run)
            }
        }
        return {
            width: canvas.width,
            height: canvas.height,
            nonBackground,
            transparentPixels: nonFiniteEquivalent,
            channelRange: maximum - minimum,
            maxVerticalContrastRun,
            maxHorizontalContrastRun,
        }
    }, png.toString('base64'))
}

function validateProof(value, processState) {

    if (value?.kind === 'static-worker-deployment-smoke') {
        return validateStaticWorkerDeployment(value, processState)
    }
    const failures = []
    if (value === undefined) return [ 'DEM virtual-raster proof was not produced' ]
    const samples = Object.entries(value.facts).filter(([ name ]) => name !== 'drained')
    const identityHashes = new Set()
    for (const [ name, facts ] of samples) {
        if (facts.status !== 'ready') failures.push(`${name} frame was not ready`)
        if (facts.cacheMode !== 'persistent' || facts.cacheLifecycle !== 'durable-reuse' ||
            facts.cacheNamespace !== cacheNamespace ||
            facts.cacheMaxPayloadBytes !== String(128 * 1024 * 1024) ||
            facts.cacheMaxEntries !== '2048' || facts.cachePersistenceRequested !== 'true') {
            failures.push(`${name} frame did not publish the configured cache lifecycle`)
        }
        if (facts.uncapturedErrors !== '0' || facts.deviceLosses !== '0' ||
            facts.diagnosticIncidents !== '0') {
            failures.push(`${name} frame retained a WebGPU diagnostic failure`)
        }
        identityHashes.add(facts.currentStableIdentityHash)
        const virtualRaster = parseJson(facts.virtualRaster)
        const residency = virtualRaster?.residency
        const scheduler = virtualRaster?.scheduler
        const worker = virtualRaster?.worker
        const phaseBudget = worker?.phaseBudget
        const gpu = virtualRaster?.gpu
        const frontier = parseJson(facts.frontier)
        if (facts.selectionPath !== 'gpu-resident-active-frontier' ||
            facts.countPath !== 'gpu-produced-indirect-arguments' ||
            facts.cpuSelectionUploadCount !== '0' ||
            frontier?.demandCount !== 0 ||
            (frontier?.convergenceState !== 'converged' &&
                frontier?.convergenceState !== 'budget-limited') ||
            frontier?.activeFrontierCount < 1 || frontier?.visibleInstanceCount < 1 ||
            frontier?.staleGenerationCount !== 0 || frontier?.frontierOverflow !== false ||
            frontier?.demandOverflow !== false || frontier?.visibleOverflow !== false) {
            failures.push(`${name} frame violated the GPU frontier terminal contract`)
        }
        if (virtualRaster?.coordinateEncoding !== 'wide-fixed' ||
            virtualRaster?.coordinateBits !== 40 ||
            virtualRaster?.tileMatrixSetId !== 'WebMercatorQuad' ||
            virtualRaster?.sourceOrientation !== 'north-up-row-major' ||
            virtualRaster?.tileOrientation !== 'north-up-row-major' ||
            virtualRaster?.cachePolicy !== 'persistent' ||
            virtualRaster?.demandStopped !== false || virtualRaster?.stopped !== false ||
            residency?.pinnedCount !== 1 ||
            residency?.residentCount < 1 || residency?.residentCount > operationalAtlasPages ||
            residency?.maxPhysicalPages !== operationalAtlasPages || residency?.stagedCount !== 0 ||
            residency?.stagingBytes !== 0 ||
            residency?.failedCount !== 0 || residency?.staleResponseCount !== 0 ||
            residency?.history?.length > 64) {
            failures.push(`${name} frame violated bounded virtual-raster residency`)
        }
        if (scheduler?.activeRequestCount !== 0 || scheduler?.queuedRequestCount !== 0 ||
            scheduler?.activeNetworkCount !== 0 || scheduler?.activeDecodeCount !== 0 ||
            scheduler?.failedRequestCount !== 0 || scheduler?.history?.length > 64 ||
            worker?.pendingCandidateCount !== 0 || worker?.senderDecodedByteLength !== 0 ||
            worker?.cache?.mode !== 'persistent' ||
            worker?.cache?.payloadBytes > 128 * 1024 * 1024 ||
            worker?.cache?.entryCount > 2048 ||
            phaseBudget?.lanes?.network?.limit !== 2 ||
            phaseBudget?.lanes?.decode?.limit !== 1 ||
            phaseBudget?.lanes?.network?.activeCount !== 0 ||
            phaseBudget?.lanes?.network?.queuedCount !== 0 ||
            phaseBudget?.lanes?.decode?.activeCount !== 0 ||
            phaseBudget?.lanes?.decode?.queuedCount !== 0 ||
            phaseBudget?.lanes?.network?.maxActiveCount < 1 ||
            phaseBudget?.lanes?.network?.maxActiveCount > phaseBudget?.lanes?.network?.limit ||
            phaseBudget?.lanes?.decode?.maxActiveCount < 1 ||
            phaseBudget?.lanes?.decode?.maxActiveCount > phaseBudget?.lanes?.decode?.limit ||
            phaseBudget?.lanes?.network?.maxQueuedCount > 24 ||
            phaseBudget?.lanes?.decode?.maxQueuedCount > 24 ||
            worker?.workerFactsObservation !== 'live' ||
            worker?.contextPool?.state !== 'active' ||
            worker?.contextPool?.systemOwnership !== 'owned' ||
            worker?.contextPool?.contexts?.some(context => context.state !== 'active') !== false ||
            worker?.group?.queuedTaskCount !== 0 || worker?.group?.activeTaskCount !== 0 ||
            worker?.group?.failedTaskCount !== 0 ||
            worker?.group?.history?.length > 64 || worker?.system?.queuedTaskCount !== 0 ||
            worker?.system?.activeTaskCount !== 0 || worker?.system?.history?.length > 64 ||
            worker?.group?.workerCount < 1 ||
            worker?.group?.workerCount > worker?.system?.maxWorkers ||
            worker?.group?.maxActiveTasks > worker?.system?.maxWorkers ||
            gpu?.maxPhysicalPages !== operationalAtlasPages || gpu?.pageTableEntryCount !== 49 ||
            gpu?.stagedSnapshotEpoch !== undefined) {
            failures.push(`${name} frame violated bounded Worker/cache/GPU state`)
        }
    }
    if (identityHashes.size !== 1) {
        failures.push('persistent Underwater Terrain graph identity changed')
    }

    const budgetFirst = value.budget?.first
    const budgetRepeated = value.budget?.repeated
    const budgetFrontier = parseJson(budgetFirst?.frontier)
    const budgetVirtual = parseJson(budgetFirst?.virtualRaster)
    if (budgetFirst?.status !== 'ready' || !cameraMatches(budgetFirst, zoomedOutCamera) ||
        budgetFrontier?.convergenceState !== 'budget-limited' ||
        budgetFrontier?.budgetLimitedCount < 1 || budgetFrontier?.demandCount !== 0 ||
        budgetFrontier?.activeFrontierCount !== 1 ||
        budgetFrontier?.visibleInstanceCount < 1 ||
        budgetFrontier?.staleGenerationCount !== 0 ||
        budgetVirtual?.residency?.maxPhysicalPages !== tightAtlasPages ||
        budgetVirtual?.residency?.residentCount !== 1 ||
        frontierSignature(budgetFirst) !== frontierSignature(budgetRepeated) ||
        value.budget?.captures?.first?.hash !== value.budget?.captures?.repeated?.hash) {
        failures.push('two-page atlas did not terminate on a stable visible parent cover')
    }
    if (!value.budget?.cleanupPair?.equivalent || value.budget?.terminalStatus !== 'disposed' ||
        unexpectedEvents(value.budget?.events).length !== 0) {
        failures.push('tight-budget proof did not dispose without browser failures')
    }

    const terminalFacts = value.terminalFailure?.facts
    const terminalFrontier = parseJson(terminalFacts?.frontier)
    const failedVirtual = parseJson(terminalFacts?.virtualRaster)
    const terminalHistory = failedVirtual?.scheduler?.history ?? []
    const failedRequestOccurrences = value.terminalFailure?.events?.tileRequests?.filter(url => (
        url === value.terminalFailure.failedTileUrl
    )).length
    if (terminalFacts?.status !== 'ready' ||
        typeof value.terminalFailure?.failedTileUrl !== 'string' ||
        failedVirtual?.residency?.failedCount < 1 ||
        failedVirtual?.scheduler?.failedRequestCount !== 1 ||
        terminalFrontier?.convergenceState !== 'converged' ||
        terminalFrontier?.demandCount !== 0 || terminalFrontier?.fallbackCount < 1 ||
        terminalFrontier?.visibleInstanceCount < 1 ||
        terminalFrontier?.staleGenerationCount !== 0 || failedRequestOccurrences !== 1) {
        failures.push(`terminal child 404 did not publish one failed page and retain parent cover: ${JSON.stringify({
            failedTileUrl: value.terminalFailure?.failedTileUrl,
            failedRequestOccurrences,
            residencyFailedCount: failedVirtual?.residency?.failedCount,
            schedulerFailedRequestCount: failedVirtual?.scheduler?.failedRequestCount,
            failedHistory: terminalHistory.filter(entry => entry.kind === 'failed'),
            frontier: terminalFrontier,
        })}`)
    }
    const terminalUnexpectedEvents = unexpectedEvents(value.terminalFailure?.events, {
        allowedHttpUrl: value.terminalFailure?.failedTileUrl,
    })
    if (!value.terminalFailure?.cleanupPair?.equivalent ||
        value.terminalFailure?.terminalStatus !== 'disposed' ||
        terminalUnexpectedEvents.length !== 0) {
        failures.push('terminal-failure proof retained lifecycle or browser failures')
    }

    const cancellationBefore = parseJson(value.cancellation?.before?.virtualRaster)
    const cancellationFacts = value.cancellation?.facts
    const cancellationAfter = parseJson(cancellationFacts?.virtualRaster)
    const cancellationObserved =
        cancellationAfter?.scheduler?.cancellationCount >
            cancellationBefore?.scheduler?.cancellationCount ||
        cancellationAfter?.scheduler?.staleResultCount >
            cancellationBefore?.scheduler?.staleResultCount ||
        cancellationAfter?.worker?.group?.cancelledTaskCount >
            cancellationBefore?.worker?.group?.cancelledTaskCount
    if (cancellationFacts?.status !== 'ready' || !cameraMatches(cancellationFacts, eastCamera) ||
        !cancellationObserved || cancellationAfter?.residency?.staleResponseCount !== 0 ||
        cancellationAfter?.scheduler?.activeRequestCount !== 0 ||
        cancellationAfter?.scheduler?.queuedRequestCount !== 0) {
        failures.push(`camera replacement did not cancel or reject obsolete Worker demand: ${JSON.stringify({
            before: {
                cancellationCount: cancellationBefore?.scheduler?.cancellationCount,
                staleResultCount: cancellationBefore?.scheduler?.staleResultCount,
                cancelledTaskCount: cancellationBefore?.worker?.group?.cancelledTaskCount,
            },
            after: {
                cancellationCount: cancellationAfter?.scheduler?.cancellationCount,
                staleResultCount: cancellationAfter?.scheduler?.staleResultCount,
                cancelledTaskCount: cancellationAfter?.worker?.group?.cancelledTaskCount,
                staleResponseCount: cancellationAfter?.residency?.staleResponseCount,
            },
        })}`)
    }
    if (!value.cancellation?.cleanupPair?.equivalent ||
        value.cancellation?.terminalStatus !== 'disposed' ||
        unexpectedEvents(value.cancellation?.events).length !== 0) {
        failures.push(`camera-replacement proof retained lifecycle or browser failures: ${JSON.stringify({
            cleanupEquivalent: value.cancellation?.cleanupPair?.equivalent,
            terminalStatus: value.cancellation?.terminalStatus,
            terminalError: value.cancellation?.terminalError,
            unexpectedEvents: unexpectedEvents(value.cancellation?.events),
        })}`)
    }

    const detailedVirtual = parseJson(value.facts.detailed.virtualRaster)
    const boundaryVirtual = parseJson(value.facts.boundary.virtualRaster)
    const churnVirtual = parseJson(value.facts.churn.virtualRaster)
    const zoomedOutVirtual = parseJson(value.facts.zoomedOut.virtualRaster)
    const returnedVirtual = parseJson(value.facts.returned.virtualRaster)
    if (detailedVirtual?.residency?.fallbackCount < 1 ||
        boundaryVirtual?.residency?.fallbackCount < detailedVirtual.residency.fallbackCount) {
        failures.push('parent fallback was not observable under the two-page atlas')
    }
    if (churnVirtual?.residency?.staleResponseCount !== 0 ||
        !cameraMatches(value.facts.churn, eastCamera)) {
        failures.push('obsolete camera demand overwrote the final GPU camera view')
    }
    for (const [ name, camera ] of [
        [ 'west', westCamera ],
        [ 'north', northCamera ],
        [ 'south', southCamera ],
    ]) {
        if (!cameraMatches(value.facts[name], camera)) {
            failures.push(`${name} camera did not produce its GPU frontier view`)
        }
    }
    if (frontierSignature(value.facts.boundary) !== frontierSignature(value.facts.returned) ||
        frontierSignature(value.facts.returned) !== frontierSignature(value.facts.repeated)) {
        failures.push('camera roundtrip did not restore the canonical GPU frontier')
    }
    if (value.captures.boundary.hash !== value.captures.returned.hash ||
        value.captures.returned.hash !== value.captures.repeated.hash) {
        failures.push('camera roundtrip or repeated static frame changed terrain pixels')
    }
    if (returnedVirtual?.worker?.networkRequestCount !==
            zoomedOutVirtual?.worker?.networkRequestCount ||
        returnedVirtual?.worker?.decodedPageCount !==
            zoomedOutVirtual?.worker?.decodedPageCount) {
        failures.push('camera return reloaded already resident or persistent raw payloads')
    }
    for (const [ name, captureFacts ] of Object.entries(value.captures)) {
        if (captureFacts.pixels.nonBackground < 5_000 ||
            captureFacts.pixels.channelRange < 8 ||
            captureFacts.pixels.transparentPixels !== 0 ||
            captureFacts.pixels.maxVerticalContrastRun > 96 ||
            captureFacts.pixels.maxHorizontalContrastRun > 96) {
            failures.push(`${name} capture was blank, uniform, seamed, or propagated invalid positions`)
        }
    }
    if (value.captures.detailed.hash === value.captures.boundary.hash ||
        value.captures.boundary.hash === value.captures.churn.hash ||
        value.captures.churn.hash === value.captures.west.hash ||
        value.captures.north.hash === value.captures.south.hash ||
        value.captures.south.hash === value.captures.zoomedOut.hash) {
        failures.push('pan/zoom/page-boundary captures did not change')
    }
    if (value.tileStats?.tileRequests < 3 || value.tileStats?.cogWindowReads < 3 ||
        value.tileStats?.tileFailures !== 0 || value.tileStats?.tileNotFound !== 0) {
        failures.push('COG tile service did not provide multiple clean window reads')
    }
    const reloadVirtual = parseJson(value.reload?.virtualRaster)
    if (value.reload?.status !== 'ready' || reloadVirtual?.worker?.cache?.mode !== 'persistent' ||
        reloadVirtual?.worker?.cache?.hitCount < 1 ||
        reloadVirtual?.worker?.networkRequestCount !== 0 ||
        reloadVirtual?.worker?.decodedPageCount !== 0 ||
        reloadVirtual?.worker?.pendingCandidateCount !== 0 ||
        value.tileStats?.tileRequests !== value.tileStatsBeforeReload?.tileRequests ||
        value.tileStats?.cogWindowReads !== value.tileStatsBeforeReload?.cogWindowReads) {
        failures.push('new DEM Worker lifecycle did not restore raw pages without network or image decode')
    }
    const standardTiles = new Set(value.events.tileRequests.filter(url => (
        /^\/tiles\/WebMercatorQuad\/\d+\/\d+\/\d+\.png$/.test(new URL(url).pathname)
    )))
    if (standardTiles.size < 3 || value.events.completeImageRequests.length !== 0 ||
        value.events.legacyTileRequests.length !== 0 ||
        standardTiles.size !== new Set(value.events.tileRequests).size) {
        failures.push('browser tile traffic did not prove the clean-cut HTTP path')
    }
    if (value.events.consoleFailures.length !== 0 || value.events.consoleWarnings.length !== 0 ||
        value.events.pageErrors.length !== 0 || value.events.requestFailures.length !== 0 ||
        value.events.httpFailures.length !== 0) {
        failures.push(
            'Underwater Terrain page emitted an unexpected console, page, or network failure'
        )
    }
    if (value.facts.drained.pendingObservationCount !== '0' ||
        value.facts.drained.currentPendingNativeObservations !== '0' ||
        value.facts.drained.currentEffectfulSubmittedWork !== '0') {
        failures.push('Underwater Terrain page did not drain all tracked and native work')
    }
    if (!value.cleanupPair.equivalent || !value.reloadCleanupPair?.equivalent ||
        value.terminalStatus !== 'disposed') {
        failures.push('Underwater Terrain lifecycle disposal was not idempotent and terminal')
    }
    const cleanup = value.cleanupPair.reports?.[0]
    if (cleanup?.report?.cleanupInvocationCount !== 1 ||
        cleanup?.report?.pendingObservationsAfter !== 0 ||
        cleanup?.report?.cleanupFailures?.length !== 0 ||
        cleanup?.lifecycle?.state !== 'disposed') {
        failures.push('Underwater Terrain lifecycle retained work or cleanup failures')
    }
    const terminalVirtual = cleanup?.virtualRaster
    if (terminalVirtual?.demandStopped !== true || terminalVirtual?.stopped !== true ||
        terminalVirtual?.residency?.disposed !== true ||
        terminalVirtual?.scheduler?.disposed !== true ||
        terminalVirtual?.worker?.disposed !== true ||
        terminalVirtual?.worker?.pendingCandidateCount !== 0 ||
        terminalVirtual?.worker?.senderDecodedByteLength !== 0 ||
        terminalVirtual?.worker?.cache?.mode !== 'persistent' ||
        terminalVirtual?.worker?.phaseBudget?.disposed !== true ||
        terminalVirtual?.worker?.phaseBudget?.lanes?.network?.activeCount !== 0 ||
        terminalVirtual?.worker?.phaseBudget?.lanes?.network?.queuedCount !== 0 ||
        terminalVirtual?.worker?.phaseBudget?.lanes?.decode?.activeCount !== 0 ||
        terminalVirtual?.worker?.phaseBudget?.lanes?.decode?.queuedCount !== 0 ||
        terminalVirtual?.worker?.workerFactsObservation !==
            'last-observed-before-disposal' ||
        terminalVirtual?.worker?.workers?.some(worker => (
            worker.cache.mode !== 'persistent' ||
            worker.cache.activeOperationCount !== 0 || worker.pendingCandidateCount !== 0 ||
            worker.senderDecodedByteLength !== 0
        )) !== false ||
        terminalVirtual?.worker?.contextPool?.state !== 'disposed' ||
        terminalVirtual?.worker?.contextPool?.disposalMode !== 'remote-finalized' ||
        terminalVirtual?.worker?.contextPool?.contexts?.some(context => (
            context.state !== 'disposed'
        )) !== false ||
        terminalVirtual?.worker?.system?.disposed !== true ||
        terminalVirtual?.worker?.system?.workerCount !== 0 ||
        terminalVirtual?.worker?.system?.queuedTaskCount !== 0 ||
        terminalVirtual?.worker?.system?.activeTaskCount !== 0 ||
        terminalVirtual?.worker?.system?.contextCount !== 0 ||
        terminalVirtual?.worker?.group?.state !== 'disposed' ||
        terminalVirtual?.worker?.group?.workerCount !== 0 ||
        terminalVirtual?.worker?.group?.queuedTaskCount !== 0 ||
        terminalVirtual?.worker?.group?.activeTaskCount !== 0 ||
        terminalVirtual?.worker?.group?.contextCount !== 0) {
        failures.push(
            'Underwater Terrain cleanup retained Worker, request, staging, or residency ownership'
        )
    }
    const reloadCleanup = value.reloadCleanupPair?.reports?.[0]
    if (reloadCleanup?.report?.cleanupInvocationCount !== 1 ||
        reloadCleanup?.report?.cleanupFailures?.length !== 0 ||
        reloadCleanup?.lifecycle?.state !== 'disposed' ||
        reloadCleanup?.virtualRaster?.worker?.disposed !== true) {
        failures.push('reloaded Underwater Terrain lifecycle did not dispose cleanly')
    }
    const cleanupActions = cleanup?.report?.cleanupActions ?? []
    const demandStop = cleanupActions.findIndex(action => (
        action.phase === 'stop' && action.label === 'dem-virtual-raster-demand'
    ))
    const streamingRelease = cleanupActions.findIndex(action => (
        action.phase === 'release' && action.label === 'dem-virtual-raster-streaming'
    ))
    const runtimeRelease = cleanupActions.findIndex(action => (
        action.phase === 'release' && action.label === 'scratch-runtime'
    ))
    if (demandStop < 0 || streamingRelease <= demandStop || runtimeRelease <= streamingRelease) {
        failures.push(
            'Underwater Terrain cleanup did not stop demand before releasing Workers and Scratch'
        )
    }
    if (!processState.browserClosed || !processState.viteClosed || !processState.tileServerClosed) {
        failures.push('managed browser or service process remained reachable')
    }
    return failures
}

function validateStaticWorkerDeployment(value, processState) {

    const failures = []
    const manifest = value.manifest?.body
    const module = manifest?.modules?.[0]
    const expectedArtifactUrl = typeof module?.url === 'string'
        ? new URL(module.url, value.manifest.url).href
        : undefined
    const successfulJavaScript = response => response.status === 200 &&
        /(?:java|ecma)script/i.test(response.contentType)
    if (value.facts?.status !== 'ready') {
        failures.push('production Underwater Terrain page was not ready')
    }
    if (value.manifest?.status !== 200 ||
        !/application\/json/i.test(value.manifest?.contentType ?? '') ||
        manifest?.kind !== 'geoscratch-worker-module-manifest' ||
        manifest?.schemaVersion !== 1 || manifest?.modules?.length !== 1 ||
        module?.id !== 'geoscratch-dem-tile' || module?.version !== '2' ||
        !/^\.\/geoscratch-dem-tile-[0-9a-f]{12}\.js$/.test(module?.url ?? '') ||
        !/^[0-9a-f]{64}$/.test(module?.sha256 ?? '')) {
        failures.push('production Worker manifest was not the strict content-addressed DEM catalog')
    }
    if (!value.events.workerManifestResponses.some(response => (
        response.status === 200 && /application\/json/i.test(response.contentType)
    ))) {
        failures.push('production application did not load the Worker manifest')
    }
    if (expectedArtifactUrl === undefined ||
        !value.events.workerArtifactResponses.some(response => (
            response.url === expectedArtifactUrl && successfulJavaScript(response)
        ))) {
        failures.push('production Worker did not import the manifest-selected hashed artifact')
    }
    if (!value.events.workerBootstrapResponses.some(successfulJavaScript)) {
        failures.push('production Worker bootstrap did not load as JavaScript')
    }
    if (value.events.tileRequests.length < 1 || value.events.legacyTileRequests.length !== 0 ||
        value.events.completeImageRequests.length !== 0) {
        failures.push('production DEM Worker did not issue the clean WebMercatorQuad tile path')
    }
    if (value.capture?.pixels?.nonBackground < 5_000 ||
        value.capture?.pixels?.channelRange < 8 ||
        value.capture?.pixels?.transparentPixels !== 0) {
        failures.push('production Underwater Terrain canvas was blank, uniform, or transparent')
    }
    if (unexpectedEvents(value.events).length !== 0) {
        failures.push('production Worker deployment emitted browser or network failures')
    }
    if (!processState.browserClosed || !processState.viteClosed || !processState.tileServerClosed) {
        failures.push('production deployment smoke retained a managed browser or service')
    }
    return failures
}

function summarizeProof(value) {

    if (value === undefined) return undefined
    if (value.kind === 'static-worker-deployment-smoke') {
        return {
            kind: value.kind,
            status: value.facts?.status,
            manifest: {
                status: value.manifest?.status,
                contentType: value.manifest?.contentType,
                kind: value.manifest?.body?.kind,
                schemaVersion: value.manifest?.body?.schemaVersion,
                modules: value.manifest?.body?.modules,
            },
            workerManifestResponses: value.events.workerManifestResponses,
            workerArtifactResponses: value.events.workerArtifactResponses,
            workerBootstrapResponses: value.events.workerBootstrapResponses,
            tileRequestCount: value.events.tileRequests.length,
            capture: value.capture,
            eventCounts: Object.fromEntries(Object.entries(value.events).map(([ name, events ]) => [
                name,
                events.length,
            ])),
        }
    }
    const terminal = value.cleanupPair.reports?.[0]?.virtualRaster
    const summarizeFacts = facts => {
        const virtualRaster = parseJson(facts.virtualRaster)
        const frontier = parseJson(facts.frontier)
        const camera = parseJson(facts.cameraView)
        return {
            status: facts.status,
            frames: Number(facts.frames),
            visibleNodeCount: Number(facts.visibleNodeCount),
            camera,
            frontier: frontier == null ? undefined : {
                activeFrontierCount: frontier.activeFrontierCount,
                visibleInstanceCount: frontier.visibleInstanceCount,
                demandCount: frontier.demandCount,
                fallbackCount: frontier.fallbackCount,
                budgetLimitedCount: frontier.budgetLimitedCount,
                coarsenGracePendingCount: frontier.coarsenGracePendingCount,
                levelRange: [
                    frontier.minimumSelectedMatrixLevel,
                    frontier.maximumSelectedMatrixLevel,
                ],
                convergenceState: frontier.convergenceState,
            },
            snapshotEpoch: virtualRaster?.residency?.snapshotEpoch,
            residentCount: virtualRaster?.residency?.residentCount,
            fallbackCount: virtualRaster?.residency?.fallbackCount,
            evictionCount: virtualRaster?.residency?.evictionCount,
            stagingBytes: virtualRaster?.residency?.stagingBytes,
            cancellationCount: virtualRaster?.scheduler?.cancellationCount,
            staleResultCount: virtualRaster?.scheduler?.staleResultCount,
            cacheHitCount: virtualRaster?.worker?.cache?.hitCount,
            decodedPageCount: virtualRaster?.worker?.decodedPageCount,
            networkRequestCount: virtualRaster?.worker?.networkRequestCount,
            pendingCandidateCount: virtualRaster?.worker?.pendingCandidateCount,
            senderDecodedByteLength: virtualRaster?.worker?.senderDecodedByteLength,
            phaseBudget: virtualRaster?.worker?.phaseBudget,
        }
    }
    return {
        facts: Object.fromEntries(Object.entries(value.facts).map(([ name, facts ]) => [
            name,
            name === 'drained' ? {
                status: facts.status,
                pendingObservationCount: Number(facts.pendingObservationCount),
                currentPendingNativeObservations: Number(facts.currentPendingNativeObservations),
                currentEffectfulSubmittedWork: Number(facts.currentEffectfulSubmittedWork),
            } : summarizeFacts(facts),
        ])),
        captures: value.captures,
        tileStats: value.tileStats,
        tileStatsBeforeReload: value.tileStatsBeforeReload,
        reload: summarizeFacts(value.reload),
        budget: value.budget === undefined ? undefined : {
            first: summarizeFacts(value.budget.first),
            repeated: summarizeFacts(value.budget.repeated),
            captures: value.budget.captures,
            cleanupEquivalent: value.budget.cleanupPair?.equivalent,
            terminalStatus: value.budget.terminalStatus,
        },
        terminalFailure: value.terminalFailure === undefined ? undefined : {
            facts: summarizeFacts(value.terminalFailure.facts),
            failedTileUrl: value.terminalFailure.failedTileUrl,
            capture: value.terminalFailure.capture,
            cleanupEquivalent: value.terminalFailure.cleanupPair?.equivalent,
            terminalStatus: value.terminalFailure.terminalStatus,
        },
        cancellation: value.cancellation === undefined ? undefined : {
            before: summarizeFacts(value.cancellation.before),
            facts: summarizeFacts(value.cancellation.facts),
            cleanupEquivalent: value.cancellation.cleanupPair?.equivalent,
            terminalStatus: value.cancellation.terminalStatus,
            terminalError: value.cancellation.terminalError,
            cancelledTileRequestCount: value.cancellation.events?.cancelledTileRequests?.length,
        },
        cleanupEquivalent: value.cleanupPair.equivalent,
        reloadCleanupEquivalent: value.reloadCleanupPair.equivalent,
        cleanupTerminalVirtualRaster: terminal === undefined ? undefined : {
            demandStopped: terminal.demandStopped,
            stopped: terminal.stopped,
            residency: {
                disposed: terminal.residency.disposed,
                residentCount: terminal.residency.residentCount,
                stagedCount: terminal.residency.stagedCount,
                stagingBytes: terminal.residency.stagingBytes,
            },
            scheduler: {
                disposed: terminal.scheduler.disposed,
                activeRequestCount: terminal.scheduler.activeRequestCount,
                queuedRequestCount: terminal.scheduler.queuedRequestCount,
            },
            worker: {
                disposed: terminal.worker.disposed,
                pendingCandidateCount: terminal.worker.pendingCandidateCount,
                senderDecodedByteLength: terminal.worker.senderDecodedByteLength,
                cacheBytes: terminal.worker.cache.payloadBytes,
                phaseBudget: terminal.worker.phaseBudget,
                workerFactsObservation: terminal.worker.workerFactsObservation,
                contextPool: {
                    state: terminal.worker.contextPool.state,
                    disposalMode: terminal.worker.contextPool.disposalMode,
                    disposedContextCount: terminal.worker.contextPool.contexts.filter(context => (
                        context.state === 'disposed'
                    )).length,
                },
                system: {
                    disposed: terminal.worker.system.disposed,
                    workerCount: terminal.worker.system.workerCount,
                    contextCount: terminal.worker.system.contextCount,
                },
                group: {
                    state: terminal.worker.group.state,
                    workerCount: terminal.worker.group.workerCount,
                    contextCount: terminal.worker.group.contextCount,
                },
            },
        },
        terminalStatus: value.terminalStatus,
        eventCounts: Object.fromEntries(Object.entries(value.events).map(([ name, events ]) => [
            name,
            events.length,
        ])),
    }
}

function unexpectedEvents(events, options = {}) {

    if (events === undefined) return [ 'missing browser events' ]
    const httpFailures = events.httpFailures.filter(event => (
        options.allowedHttpUrl === undefined || !event.endsWith(options.allowedHttpUrl)
    ))
    return [
        ...events.consoleFailures,
        ...events.consoleWarnings,
        ...events.pageErrors,
        ...events.requestFailures,
        ...httpFailures,
    ]
}

function observePage(page) {

    const events = {
        consoleFailures: [],
        consoleWarnings: [],
        pageErrors: [],
        requestFailures: [],
        cancelledTileRequests: [],
        httpFailures: [],
        tileRequests: [],
        legacyTileRequests: [],
        completeImageRequests: [],
        workerManifestResponses: [],
        workerArtifactResponses: [],
        workerBootstrapResponses: [],
    }
    page.on('console', (message) => {
        if (message.type() === 'error') pushBounded(events.consoleFailures, message.text())
        if (message.type() === 'warning') pushBounded(events.consoleWarnings, message.text())
    })
    page.on('pageerror', error => pushBounded(events.pageErrors, serializeError(error)))
    page.on('requestfailed', request => {
        const failure = `${request.method()} ${request.url()}: ` +
            `${request.failure()?.errorText ?? 'unknown'}`
        const url = new URL(request.url())
        if (url.origin === tileBaseUrl &&
            /^\/tiles\/WebMercatorQuad\/\d+\/\d+\/\d+\.png$/.test(url.pathname) &&
            /abort|cancel/i.test(request.failure()?.errorText ?? '')) {
            pushBounded(events.cancelledTileRequests, failure)
            return
        }
        pushBounded(events.requestFailures, failure)
    })
    page.on('response', (response) => {
        const url = new URL(response.url())
        const responseFacts = {
            url: url.href,
            status: response.status(),
            contentType: response.headers()['content-type'] ?? '',
            resourceType: response.request().resourceType(),
        }
        if (url.pathname === '/scratch-workers/manifest.json') {
            pushBounded(events.workerManifestResponses, responseFacts)
        }
        if (/\/scratch-workers\/[A-Za-z0-9._-]+-[0-9a-f]{12}\.js$/.test(url.pathname)) {
            pushBounded(events.workerArtifactResponses, responseFacts)
        }
        if (/\/assets\/worker-bootstrap-[A-Za-z0-9_-]+\.js$/.test(url.pathname)) {
            pushBounded(events.workerBootstrapResponses, responseFacts)
        }
        if (response.status() >= 400) {
            pushBounded(events.httpFailures, `${response.status()} ${response.url()}`)
        }
    })
    page.on('request', (request) => {
        const url = new URL(request.url())
        if (url.origin === tileBaseUrl && url.pathname.startsWith('/tiles/')) {
            pushBounded(events.tileRequests, url.href)
            if (!/^\/tiles\/WebMercatorQuad\/\d+\/\d+\/\d+\.png$/.test(url.pathname)) {
                pushBounded(events.legacyTileRequests, url.href)
            }
        }
        if (url.pathname.endsWith('/assets/dem.png')) {
            pushBounded(events.completeImageRequests, url.href)
        }
    })
    return events
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

    try {
        return JSON.parse(output).sourceHash
    } catch {
        return undefined
    }
}

function parseJson(value) {

    try {
        return JSON.parse(value)
    } catch {
        return undefined
    }
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

    if (target.length < 64) target.push(value)
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

function delay(milliseconds) {

    return new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds))
}
