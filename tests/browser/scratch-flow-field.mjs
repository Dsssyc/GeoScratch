import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { chromium } from 'playwright'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const examplesRoot = resolve(root, 'examples')
const viteEntry = resolve(root, 'node_modules/vite/bin/vite.js')
const tileServer = resolve(
    root, 'examples/flowField/tile-server/.venv/bin/flow-field-tile-serve'
)
const tileManifest = resolve(root, 'examples/flowField/tile-server/cache/manifest.json')
const workerManifest = resolve(root, 'examples/public/scratch-workers/manifest.json')
const timeout = positiveInteger(process.env.FLOW_FIELD_BROWSER_TIMEOUT_MS, 180_000)
const requiredFrames = positiveInteger(process.env.FLOW_FIELD_PROOF_FRAMES, 56)
const headless = process.env.FLOW_FIELD_BROWSER_HEADLESS !== '0'
const outputDirectory = resolve(
    process.env.FLOW_FIELD_BROWSER_OUTPUT ?? '/tmp/geoscratch-flow-field-browser'
)

if (requiredFrames < 56) {
    throw new RangeError('FLOW_FIELD_PROOF_FRAMES must cover two 27-slice cycles')
}
await Promise.all([ access(tileServer), access(tileManifest), access(workerManifest) ])
await mkdir(outputDirectory, { recursive: true })

const vitePort = await availablePort()
let tilePort = await availablePort()
while (tilePort === vitePort) tilePort = await availablePort()
const viteBase = `http://127.0.0.1:${vitePort}`
const tileBase = `http://127.0.0.1:${tilePort}`
const vite = startProcess(process.execPath, [
    viteEntry,
    '--host', '127.0.0.1',
    '--port', String(vitePort),
], examplesRoot)
const tiles = startProcess(tileServer, [ '--port', String(tilePort) ], root)
let browser
let result
let failure
const cleanupFailures = []

try {
    await Promise.all([
        waitForHttp(`${viteBase}/flowField/index.html`, vite, timeout),
        waitForHttp(`${tileBase}/health`, tiles, timeout),
    ])
    browser = await chromium.launch({
        channel: 'chrome',
        headless,
        args: [ '--enable-unsafe-webgpu' ],
    })
    result = await verify(browser)
} catch (error) {
    failure = serializeError(error)
} finally {
    if (browser !== undefined) {
        try { await browser.close() } catch (error) { cleanupFailures.push(serializeError(error)) }
    }
    for (const processHandle of [ vite, tiles ]) {
        try { await stopProcess(processHandle) } catch (error) {
            cleanupFailures.push(serializeError(error))
        }
    }
}

const failures = validate(result, failure, cleanupFailures)
const report = {
    schemaVersion: 1,
    headed: !headless,
    requiredFrames,
    viteBase,
    tileBase,
    outputDirectory,
    result: summarizeResult(result),
    failure,
    cleanupFailures,
    status: failures.length === 0 ? 'passed' : 'failed',
    failures,
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
if (failures.length > 0) process.exitCode = 1

async function verify(activeBrowser) {

    const context = await activeBrowser.newContext({
        viewport: { width: 960, height: 720 },
        deviceScaleFactor: 1,
    })
    const catalogPage = await context.newPage()
    await catalogPage.goto(`${viteBase}/?sample=flowField`, {
        waitUntil: 'domcontentloaded',
        timeout,
    })
    const catalog = await catalogPage.evaluate(() => {
        const active = document.querySelector('.example-link.is-active')
        return {
            activeId: active?.getAttribute('data-id'),
            title: document.querySelector('#stage-title')?.textContent,
            source: document.querySelector('#source-link')?.getAttribute('href'),
            standalone: document.querySelector('#standalone-link')?.getAttribute('href'),
            frame: document.querySelector('#example-frame')?.getAttribute('src'),
        }
    })
    await catalogPage.close()

    const page = await context.newPage()
    const consoleIssues = []
    const pageErrors = []
    const requestFailures = []
    const flowRequests = []
    page.on('console', message => {
        if (message.type() === 'warning' || message.type() === 'error') {
            consoleIssues.push(`${message.type()}:${message.text()}`)
        }
    })
    page.on('pageerror', error => { pageErrors.push(error.message) })
    page.on('requestfailed', request => {
        requestFailures.push(`${request.url()}:${request.failure()?.errorText ?? 'unknown'}`)
    })
    page.on('request', request => {
        if (request.url().startsWith(tileBase)) flowRequests.push(request.url())
    })
    await page.goto(
        `${viteBase}/flowField/index.html?proof=1&framesPerTime=1&` +
        `tileServer=${encodeURIComponent(tileBase)}`,
        { waitUntil: 'domcontentloaded', timeout }
    )
    await page.waitForFunction(minimum => {
        const status = document.body.dataset.status
        if (status === 'error') return true
        return (window.__FLOW_FIELD_PROOF__?.facts()?.frames?.observedFrameCount ?? 0) >= minimum
    }, requiredFrames, { timeout })
    const status = await page.locator('#GPUFrame').getAttribute('data-status')
    const error = await page.locator('#GPUFrame').getAttribute('data-error')
    const diagnostic = await page.locator('#GPUFrame').getAttribute('data-diagnostic')
    const drained = await page.evaluate(async() => {
        return await window.__FLOW_FIELD_PROOF__.pauseAndDrain()
    })
    const screenshot = await page.locator('#GPUFrame').screenshot()
    const screenshotPath = resolve(outputDirectory, 'flow-field.png')
    await writeFile(screenshotPath, screenshot)
    const pixels = await inspectPixels(page, screenshot)
    const cleanup = await page.evaluate(async() => {
        return await window.__FLOW_FIELD_PROOF__.dispose()
    })
    const terminalStatus = await page.locator('#GPUFrame').getAttribute('data-status')
    const stats = await (await fetch(`${tileBase}/stats`)).json()
    await context.close()
    return {
        catalog,
        status,
        error,
        diagnostic,
        drained,
        cleanup,
        terminalStatus,
        pixels,
        screenshotPath,
        network: {
            requestCount: flowRequests.length,
            uniqueRequestCount: new Set(flowRequests).size,
            timeLabels: [ ...new Set(flowRequests.flatMap(url =>
                /\/WebMercatorQuad\/(t\d{2})\//.exec(url)?.slice(1) ?? []
            )) ].sort(),
            forbidden: flowRequests.filter(url =>
                /boundary|depth|wet|sdf|vector.?feature/i.test(url)
            ),
            unexpected: flowRequests.filter(url => {
                const path = new URL(url).pathname
                return path !== '/manifest.json' &&
                    !/^\/tiles\/WebMercatorQuad\/t\d{2}\/\d+\/\d+\/\d+\.rg32f$/.test(path)
            }),
        },
        stats,
        consoleIssues,
        pageErrors,
        requestFailures,
    }
}

function validate(observed, topLevelFailure, cleanupFailures) {

    const failures = []
    if (topLevelFailure !== undefined) failures.push(topLevelFailure)
    if (cleanupFailures.length > 0) failures.push(...cleanupFailures)
    if (observed === undefined) return failures
    if (observed.catalog.activeId !== 'flowField' || observed.catalog.title !== 'Flow Field' ||
        observed.catalog.source !== './flowField/main.ts' ||
        observed.catalog.standalone !== './flowField/' ||
        !observed.catalog.frame?.includes('/flowField/')) {
        failures.push(`catalog:${JSON.stringify(observed.catalog)}`)
    }
    if (observed.status !== 'ready' || observed.error !== null || observed.diagnostic !== null) {
        failures.push(`page:${observed.status}:${observed.error ?? observed.diagnostic}`)
    }
    const renderer = observed.drained?.renderer
    const temporal = renderer?.temporalWindow
    if (observed.drained?.paused !== true ||
        Number(observed.drained?.frames?.observedFrameCount) < requiredFrames ||
        Number(temporal?.generation) < 55 ||
        Number(temporal?.currentSnapshotEpoch) <= 0 ||
        Number(temporal?.nextSnapshotEpoch) <= 0 ||
        Number(renderer?.temporal?.refreshCount) < 54) {
        failures.push('temporal cycles did not remain live and epoch-complete')
    }
    if (renderer?.spawn?.cpuReadback !== false ||
        renderer?.particles?.cpuMirrorBytes !== 0 ||
        renderer?.particles?.readbackCount !== 0 ||
        renderer?.contour?.candidateCount <= 0 ||
        renderer?.history?.hasPreviousView !== true) {
        failures.push('GPU-derived support, particle, contour, or history facts are incomplete')
    }
    for (const runtime of Object.values(renderer?.runtimes ?? {})) {
        if (runtime.scheduler.activeRequestCount !== 0 || runtime.scheduler.queuedRequestCount !== 0 ||
            runtime.residency.stagingBytes !== 0) {
            failures.push(`runtime did not drain:${runtime.id}`)
        }
    }
    const diagnostics = observed.drained?.diagnostics
    if (diagnostics?.submissionNative?.currentPendingNativeObservations !== 0 ||
        diagnostics?.recorder?.retainedIncidentCount !== 0 ||
        diagnostics?.aggregates?.uncapturedErrors !== 0 ||
        diagnostics?.aggregates?.deviceLosses !== 0 ||
        diagnostics?.readbackMemory?.activeMappings !== 0) {
        failures.push('GPU diagnostics did not remain clean and bounded')
    }
    if (observed.pixels.nonDarkPixels < 1_000 || observed.pixels.channelRange < 32) {
        failures.push(`rendered pixels are empty:${JSON.stringify(observed.pixels)}`)
    }
    if (observed.network.requestCount === 0 || observed.network.timeLabels.length !== 27 ||
        observed.network.forbidden.length > 0 || observed.network.unexpected.length > 0) {
        failures.push(`velocity-only network contract failed:${JSON.stringify(observed.network)}`)
    }
    if (observed.consoleIssues.length > 0 || observed.pageErrors.length > 0 ||
        observed.requestFailures.length > 0) {
        failures.push('browser emitted console, page, or request failures')
    }
    if (observed.cleanup?.pendingObservationsAfter !== 0 ||
        observed.cleanup?.cleanupFailures?.length !== 0 || observed.terminalStatus !== 'disposed') {
        failures.push('page lifecycle did not drain and dispose exactly')
    }
    return failures
}

function summarizeResult(observed) {

    if (observed === undefined) return undefined
    const renderer = observed.drained?.renderer
    return {
        catalog: observed.catalog,
        status: observed.status,
        error: observed.error,
        diagnostic: observed.diagnostic,
        frames: observed.drained?.frames,
        temporalWindow: renderer?.temporalWindow,
        temporal: renderer?.temporal,
        spawn: renderer?.spawn,
        particles: renderer?.particles,
        contour: renderer?.contour,
        history: renderer?.history,
        runtimes: Object.fromEntries(Object.entries(renderer?.runtimes ?? {}).map(
            ([ name, runtime ]) => [ name, {
                id: runtime.id,
                activeRequestCount: runtime.scheduler.activeRequestCount,
                queuedRequestCount: runtime.scheduler.queuedRequestCount,
                stagingBytes: runtime.residency.stagingBytes,
                residentCount: runtime.residency.residentCount,
            } ]
        )),
        diagnostics: {
            currentPendingNativeObservations:
                observed.drained?.diagnostics?.submissionNative?.currentPendingNativeObservations,
            retainedIncidentCount:
                observed.drained?.diagnostics?.recorder?.retainedIncidentCount,
            uncapturedErrors: observed.drained?.diagnostics?.aggregates?.uncapturedErrors,
            deviceLosses: observed.drained?.diagnostics?.aggregates?.deviceLosses,
            activeMappings: observed.drained?.diagnostics?.readbackMemory?.activeMappings,
        },
        cleanup: observed.cleanup,
        terminalStatus: observed.terminalStatus,
        pixels: observed.pixels,
        screenshotPath: observed.screenshotPath,
        network: observed.network,
        stats: observed.stats,
        consoleIssues: observed.consoleIssues,
        pageErrors: observed.pageErrors,
        requestFailures: observed.requestFailures,
    }
}

async function inspectPixels(page, png) {

    return await page.evaluate(async base64 => {
        const image = new Image()
        image.src = `data:image/png;base64,${base64}`
        await image.decode()
        const canvas = document.createElement('canvas')
        canvas.width = image.naturalWidth
        canvas.height = image.naturalHeight
        const context = canvas.getContext('2d', { willReadFrequently: true })
        if (context === null) throw new Error('Flow Field pixel context is unavailable')
        context.drawImage(image, 0, 0)
        const data = context.getImageData(0, 0, canvas.width, canvas.height).data
        let minimum = 255
        let maximum = 0
        let nonDarkPixels = 0
        for (let index = 0; index < data.length; index += 4) {
            const localMaximum = Math.max(data[index], data[index + 1], data[index + 2])
            const localMinimum = Math.min(data[index], data[index + 1], data[index + 2])
            minimum = Math.min(minimum, localMinimum)
            maximum = Math.max(maximum, localMaximum)
            if (localMaximum > 8) nonDarkPixels++
        }
        return { width: canvas.width, height: canvas.height, nonDarkPixels,
            channelRange: maximum - minimum }
    }, png.toString('base64'))
}

function startProcess(command, arguments_, cwd) {

    const child = spawn(command, arguments_, { cwd, stdio: [ 'ignore', 'pipe', 'pipe' ] })
    const state = { child, stdout: '', stderr: '' }
    child.stdout.on('data', chunk => { state.stdout += chunk })
    child.stderr.on('data', chunk => { state.stderr += chunk })
    return state
}

async function stopProcess(state) {

    if (state.child.exitCode !== null) return
    state.child.kill('SIGTERM')
    const exited = await Promise.race([
        new Promise(resolveExit => state.child.once('exit', () => resolveExit(true))),
        delay(5_000).then(() => false),
    ])
    if (exited) return
    state.child.kill('SIGKILL')
    await new Promise(resolveExit => state.child.once('exit', resolveExit))
}

async function waitForHttp(url, processState, maximumMs) {

    const started = Date.now()
    while (Date.now() - started < maximumMs) {
        if (processState.child.exitCode !== null) {
            throw new Error(`process exited before ${url}: ${processState.stderr}`)
        }
        try {
            const response = await fetch(url)
            if (response.ok) return
        } catch {}
        await delay(50)
    }
    throw new Error(`timed out waiting for ${url}`)
}

function availablePort() {

    return new Promise((resolvePort, reject) => {
        const server = createServer()
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
            const address = server.address()
            if (address === null || typeof address === 'string') {
                server.close()
                reject(new Error('available port address is unavailable'))
                return
            }
            server.close(error => error === undefined ? resolvePort(address.port) : reject(error))
        })
    })
}

function positiveInteger(value, fallback) {

    if (value === undefined) return fallback
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new RangeError('Flow Field browser integer option is invalid')
    }
    return parsed
}

function serializeError(error) {

    return error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error)
}

function delay(milliseconds) {

    return new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds))
}
