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
const tileServerRoot = resolve(examplesRoot, 'demLayer/tile-server')
const viteEntry = resolve(repositoryRoot, 'node_modules/vite/bin/vite.js')
const tileBuildEntry = resolve(tileServerRoot, '.venv/bin/dem-tile-build')
const tileServeEntry = resolve(tileServerRoot, '.venv/bin/dem-tile-serve')
const timeout = positiveInteger(process.env.GEO_VIRTUAL_RASTER_DEM_TIMEOUT_MS, 120_000)
const outputDirectory = resolve(
    process.env.GEO_VIRTUAL_RASTER_DEM_OUTPUT ?? '/tmp/geoscratch-virtual-raster-dem'
)
const vitePort = await findAvailablePort()
const tilePort = await findAvailablePort()
const baseUrl = `http://127.0.0.1:${vitePort}`
const tileBaseUrl = `http://127.0.0.1:${tilePort}`
const defaultCamera = Object.freeze({ center: [ 120.980697, 31.684162 ], zoom: 10 })
const sourceFeatureRow = 256
const logicalFeatureY = 558 - 1 - sourceFeatureRow
const pageBoundaryCamera = Object.freeze({
    center: [
        120.04373606134682 + (121.96623240116922 - 120.04373606134682) * 0.5,
        31.173901952209487 +
            (32.08401085804678 - 31.173901952209487) * logicalFeatureY / 558,
    ],
    zoom: 11,
})
const eastCamera = Object.freeze({ center: [ 121.72, 31.78 ], zoom: 11 })
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
    await waitForHttpProcess(vite, `${baseUrl}/demLayer/index.html`, 'Vite')
    browser = await chromium.launch({
        channel: 'chrome',
        headless: false,
        args: [ '--enable-unsafe-webgpu' ],
    })
    browserVersion = await browser.version()
    proof = await runProof(browser)
} catch (error) {
    fatalError = serializeError(error)
} finally {
    await cleanup('Chrome', async() => {
        if (browser !== undefined) await withTimeout(browser.close(), 5_000, 'Chrome shutdown')
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
    headed: true,
    browserVersion,
    baseUrl,
    tileBaseUrl,
    atlasPages: 2,
    outputDirectory,
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

    const context = await activeBrowser.newContext({
        viewport: { width: 960, height: 720 },
        deviceScaleFactor: 1,
    })
    const page = await context.newPage()
    const events = observePage(page)
    try {
        const url = `${baseUrl}/demLayer/index.html?proof=1&atlasPages=2` +
            `&tileServer=${encodeURIComponent(tileBaseUrl)}`
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout })
        const initial = await waitForStableFacts(page)
        const initialCapture = await capture(page, 'initial')

        const detailed = await moveAndWait(page, initial, defaultCamera)
        const detailedCapture = await capture(page, 'zoom-in')

        const boundary = await moveAndWait(page, detailed, pageBoundaryCamera)
        const boundaryCapture = await capture(page, 'page-boundary')

        const east = await moveAndWait(page, boundary, eastCamera)
        const eastCapture = await capture(page, 'east-pan')

        const zoomedOut = await moveAndWait(page, east, zoomedOutCamera)
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
        const tileStats = await statsResponse.json()
        const drained = await page.evaluate(async() => (
            await window.__DEM_LAYER_PROOF__.pauseAndDrain()
        ))
        const cleanupPair = await page.evaluate(async() => {
            const first = window.__DEM_LAYER_PROOF__.dispose()
            const second = window.__DEM_LAYER_PROOF__.dispose()
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
                east,
                zoomedOut,
                returned,
                repeated,
                resized,
                drained,
            },
            captures: {
                initial: initialCapture,
                detailed: detailedCapture,
                boundary: boundaryCapture,
                east: eastCapture,
                zoomedOut: zoomedOutCapture,
                returned: returnedCapture,
                repeated: repeatedCapture,
                resized: resizedCapture,
            },
            tileStats,
            cleanupPair,
            terminalStatus: await page.locator('#GPUFrame').getAttribute('data-status'),
            events,
        }
    } finally {
        await context.close()
    }
}

async function moveAndWait(page, before, camera) {

    const previousFrames = Number(before.observedFrames)
    await page.evaluate(value => window.__DEM_LAYER_PROOF__.moveCamera(value), camera)
    return await waitForStableFacts(page, facts => (
        Number(facts.observedFrames) > previousFrames && selectionMatchesCamera(facts, camera)
    ))
}

function selectionMatchesCamera(facts, camera) {

    const selection = parseJson(facts.selection)
    return Math.abs(selection?.zoomLevel - camera.zoom) < 1e-6 &&
        Math.abs(selection?.cameraPos?.[0] - camera.center[0]) < 1e-9 &&
        Math.abs(selection?.cameraPos?.[1] - camera.center[1]) < 1e-9
}

async function waitForStableFacts(page, additional = () => true) {

    const deadline = Date.now() + timeout
    let lastFacts
    while (Date.now() < deadline) {
        const facts = await readFacts(page)
        lastFacts = facts
        if (facts.status === 'error') throw new Error(facts.error ?? 'DEM page failed')
        const virtualRaster = parseJson(facts.virtualRaster)
        if (facts.status === 'ready' && Number(facts.frames) === Number(facts.observedFrames) &&
            virtualRaster?.residency?.pendingCount === 0 &&
            virtualRaster?.residency?.stagedCount === 0 &&
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
        residency: virtualRaster?.residency,
    })}`)
}

async function readFacts(page) {

    return await page.evaluate(() => ({ ...document.querySelector('#GPUFrame')?.dataset }))
}

async function capture(page, name) {

    const path = resolve(outputDirectory, `${name}.png`)
    const png = await page.locator('#GPUFrame').screenshot({ path })
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
        return {
            width: canvas.width,
            height: canvas.height,
            nonBackground,
            transparentPixels: nonFiniteEquivalent,
            channelRange: maximum - minimum,
        }
    }, png.toString('base64'))
}

function validateProof(value, processState) {

    const failures = []
    if (value === undefined) return [ 'DEM virtual-raster proof was not produced' ]
    const samples = Object.entries(value.facts).filter(([ name ]) => name !== 'drained')
    const identityHashes = new Set()
    for (const [ name, facts ] of samples) {
        if (facts.status !== 'ready') failures.push(`${name} frame was not ready`)
        if (facts.uncapturedErrors !== '0' || facts.deviceLosses !== '0' ||
            facts.diagnosticIncidents !== '0') {
            failures.push(`${name} frame retained a WebGPU diagnostic failure`)
        }
        identityHashes.add(facts.currentStableIdentityHash)
        const virtualRaster = parseJson(facts.virtualRaster)
        const residency = virtualRaster?.residency
        if (virtualRaster?.coordinateEncoding !== 'cell-local-f32' ||
            virtualRaster?.failedPageKeys?.length !== 0 || residency?.pinnedCount !== 1 ||
            residency?.residentCount < 1 || residency?.residentCount > 2 ||
            residency?.maxPhysicalPages !== 2 || residency?.cpuBytes > residency?.maxCpuBytes ||
            residency?.failedCount !== 0 || residency?.staleResponseCount !== 0 ||
            residency?.history?.length > 64) {
            failures.push(`${name} frame violated bounded virtual-raster residency`)
        }
    }
    if (identityHashes.size !== 1) failures.push('persistent DEM graph identity changed')

    const detailedVirtual = parseJson(value.facts.detailed.virtualRaster)
    const boundaryVirtual = parseJson(value.facts.boundary.virtualRaster)
    const eastVirtual = parseJson(value.facts.east.virtualRaster)
    if (detailedVirtual?.residency?.fallbackCount < 1 ||
        boundaryVirtual?.residency?.fallbackCount < detailedVirtual.residency.fallbackCount) {
        failures.push('parent fallback was not observable under the two-page atlas')
    }
    if (eastVirtual?.residency?.evictionCount < 1) {
        failures.push('cross-page pan did not force deterministic atlas eviction')
    }
    const boundarySelection = parseJson(value.facts.boundary.selection)
    const returnedSelection = parseJson(value.facts.returned.selection)
    if (JSON.stringify(boundarySelection) !== JSON.stringify(returnedSelection)) {
        failures.push('camera roundtrip did not restore canonical terrain selection')
    }
    if (value.captures.boundary.hash !== value.captures.returned.hash ||
        value.captures.returned.hash !== value.captures.repeated.hash) {
        failures.push('camera roundtrip or repeated static frame changed terrain pixels')
    }
    for (const [ name, captureFacts ] of Object.entries(value.captures)) {
        if (captureFacts.pixels.nonBackground < 5_000 ||
            captureFacts.pixels.channelRange < 8 ||
            captureFacts.pixels.transparentPixels !== 0) {
            failures.push(`${name} capture was blank, uniform, or propagated invalid positions`)
        }
    }
    if (value.captures.detailed.hash === value.captures.boundary.hash ||
        value.captures.boundary.hash === value.captures.east.hash ||
        value.captures.east.hash === value.captures.zoomedOut.hash) {
        failures.push('pan/zoom/page-boundary captures did not change')
    }
    if (value.tileStats?.tileRequests < 3 || value.tileStats?.cogWindowReads < 3 ||
        value.tileStats?.tileFailures !== 0 || value.tileStats?.tileNotFound !== 0) {
        failures.push('COG tile service did not provide multiple clean window reads')
    }
    if (value.events.tileRequests.length < 3 || value.events.completeImageRequests.length !== 0) {
        failures.push('browser tile traffic did not prove the clean-cut HTTP path')
    }
    if (value.events.consoleFailures.length !== 0 || value.events.consoleWarnings.length !== 0 ||
        value.events.pageErrors.length !== 0 || value.events.requestFailures.length !== 0 ||
        value.events.httpFailures.length !== 0) {
        failures.push('DEM browser page emitted an unexpected console, page, or network failure')
    }
    if (value.facts.drained.pendingObservationCount !== '0' ||
        value.facts.drained.currentPendingNativeObservations !== '0' ||
        value.facts.drained.currentEffectfulSubmittedWork !== '0') {
        failures.push('DEM page did not drain all tracked and native work')
    }
    if (!value.cleanupPair.equivalent || value.terminalStatus !== 'disposed') {
        failures.push('DEM lifecycle disposal was not idempotent and terminal')
    }
    const cleanup = value.cleanupPair.reports?.[0]
    if (cleanup?.report?.cleanupInvocationCount !== 1 ||
        cleanup?.report?.pendingObservationsAfter !== 0 ||
        cleanup?.report?.cleanupFailures?.length !== 0 ||
        cleanup?.lifecycle?.state !== 'disposed') {
        failures.push('DEM lifecycle retained work or cleanup failures')
    }
    if (!processState.browserClosed || !processState.viteClosed || !processState.tileServerClosed) {
        failures.push('managed browser or service process remained reachable')
    }
    return failures
}

function summarizeProof(value) {

    if (value === undefined) return undefined
    const summarizeFacts = facts => {
        const virtualRaster = parseJson(facts.virtualRaster)
        const selection = parseJson(facts.selection)
        return {
            status: facts.status,
            frames: Number(facts.frames),
            visibleNodeCount: Number(facts.visibleNodeCount),
            geometryLodRange: selection?.levelRange,
            requestedLodRange: parseJson(facts.virtualPlan)?.requestedLodRange,
            snapshotEpoch: virtualRaster?.residency?.snapshotEpoch,
            residentCount: virtualRaster?.residency?.residentCount,
            fallbackCount: virtualRaster?.residency?.fallbackCount,
            evictionCount: virtualRaster?.residency?.evictionCount,
            pageRequestCount: virtualRaster?.residency?.pageRequestCount,
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
        cleanupEquivalent: value.cleanupPair.equivalent,
        terminalStatus: value.terminalStatus,
        eventCounts: Object.fromEntries(Object.entries(value.events).map(([ name, events ]) => [
            name,
            events.length,
        ])),
    }
}

function observePage(page) {

    const events = {
        consoleFailures: [],
        consoleWarnings: [],
        pageErrors: [],
        requestFailures: [],
        httpFailures: [],
        tileRequests: [],
        completeImageRequests: [],
    }
    page.on('console', (message) => {
        if (message.type() === 'error') pushBounded(events.consoleFailures, message.text())
        if (message.type() === 'warning') pushBounded(events.consoleWarnings, message.text())
    })
    page.on('pageerror', error => pushBounded(events.pageErrors, serializeError(error)))
    page.on('requestfailed', request => pushBounded(
        events.requestFailures,
        `${request.method()} ${request.url()}: ${request.failure()?.errorText ?? 'unknown'}`
    ))
    page.on('response', (response) => {
        if (response.status() >= 400) {
            pushBounded(events.httpFailures, `${response.status()} ${response.url()}`)
        }
    })
    page.on('request', (request) => {
        const url = new URL(request.url())
        if (url.origin === tileBaseUrl && url.pathname.startsWith('/tiles/')) {
            pushBounded(events.tileRequests, url.href)
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
            rejectPromise(new Error(`Process ${child.pid} did not exit within ${milliseconds} ms`))
        }, milliseconds)
        const onExit = () => {
            clearTimeout(timer)
            resolvePromise()
        }
        child.once('exit', onExit)
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
