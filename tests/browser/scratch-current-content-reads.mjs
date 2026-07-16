import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import process from 'node:process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const examplesRoot = resolve(repositoryRoot, 'examples')
const viteEntry = resolve(repositoryRoot, 'node_modules/vite/bin/vite.js')
const outputDirectory = resolve(
    process.env.SCRATCH_CURRENT_CONTENT_BROWSER_OUTPUT ??
        '/tmp/geoscratch-current-content-browser'
)
const timeout = positiveInteger(
    process.env.SCRATCH_CURRENT_CONTENT_BROWSER_TIMEOUT_MS,
    60_000
)
const port = process.env.SCRATCH_CURRENT_CONTENT_BROWSER_PORT === undefined
    ? await findAvailablePort()
    : positiveInteger(process.env.SCRATCH_CURRENT_CONTENT_BROWSER_PORT)
const baseUrl = `http://127.0.0.1:${port}`

await mkdir(outputDirectory, { recursive: true })
const vite = startVite(port)
let browser
let adapter
let proof
let browserVersion
let fatalError
let cleanupError
let serverClosed = false

try {
    await waitForVite(vite, `${baseUrl}/uniformTriangle/index.html`)
    browser = await chromium.launch({
        channel: 'chrome',
        headless: false,
        args: [ '--enable-unsafe-webgpu' ],
    })
    browserVersion = await browser.version()
    const verified = await verifyCurrentContentReads(browser)
    adapter = verified.adapter
    proof = verified.proof
} catch (error) {
    fatalError = serializeError(error)
} finally {
    const cleanupFailures = []
    try {
        if (browser !== undefined) await withTimeout(browser.close(), 5_000, 'Chrome shutdown')
    } catch (error) {
        cleanupFailures.push(serializeError(error))
    }
    try {
        await stopVite(vite)
    } catch (error) {
        cleanupFailures.push(serializeError(error))
    }
    try {
        serverClosed = await waitForPortClosed(port)
    } catch (error) {
        cleanupFailures.push(serializeError(error))
    }
    if (cleanupFailures.length > 0) cleanupError = cleanupFailures.join('\n')
}

const failures = validateResult({
    adapter,
    proof,
    fatalError,
    cleanupError,
    serverClosed,
})
const result = {
    schemaVersion: 1,
    browserVersion,
    headed: true,
    baseUrl,
    outputDirectory,
    vite: {
        pid: vite.child.pid,
        exitCode: vite.child.exitCode,
        signalCode: vite.child.signalCode,
        serverClosed,
        stdout: failures.length === 0 ? undefined : vite.stdout,
        stderr: failures.length === 0 ? undefined : vite.stderr,
    },
    adapter,
    proof,
    fatalError,
    cleanupError,
    status: failures.length === 0 ? 'passed' : 'failed',
    failures,
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
if (failures.length > 0) process.exitCode = 1

async function verifyCurrentContentReads(activeBrowser) {

    const context = await activeBrowser.newContext({
        viewport: { width: 960, height: 720 },
        deviceScaleFactor: 1,
    })
    const page = await context.newPage()
    const consoleFailures = []
    const pageErrors = []
    const requestFailures = []
    const httpFailures = []
    page.on('console', (message) => {
        if (message.type() === 'error') pushBounded(consoleFailures, message.text())
    })
    page.on('pageerror', (error) => pushBounded(pageErrors, serializeError(error)))
    page.on('requestfailed', (request) => pushBounded(
        requestFailures,
        `${request.method()} ${request.url()}: ${request.failure()?.errorText ?? 'unknown failure'}`
    ))
    page.on('response', (response) => {
        if (response.status() < 400) return
        pushBounded(httpFailures, `${response.status()} ${response.request().method()} ${response.url()}`)
    })

    try {
        await page.goto(`${baseUrl}/uniformTriangle/index.html`, {
            waitUntil: 'domcontentloaded',
            timeout,
        })
        const adapterFacts = await page.evaluate(async() => {
            if (!navigator.gpu) return { available: false, adapterAvailable: false }
            const currentAdapter = await navigator.gpu.requestAdapter({
                powerPreference: 'high-performance',
            })
            if (!currentAdapter) return { available: true, adapterAvailable: false }
            const info = currentAdapter.info ?? {}
            return {
                available: true,
                adapterAvailable: true,
                info: {
                    vendor: info.vendor ?? '',
                    architecture: info.architecture ?? '',
                    device: info.device ?? '',
                    description: info.description ?? '',
                },
                features: [ ...currentAdapter.features ].sort(),
                limits: {
                    maxBufferSize: currentAdapter.limits.maxBufferSize,
                    maxBindGroups: currentAdapter.limits.maxBindGroups,
                },
            }
        })

        await page.waitForFunction(() => {
            const status = document.querySelector('#GPUFrame')?.dataset.status
            return status === 'ready' || status === 'error'
        }, undefined, { timeout })

        const canvas = page.locator('#GPUFrame')
        const firstFacts = await readProofFacts(page)
        const firstScreenshot = resolve(outputDirectory, 'uniform-triangle-frame-1.png')
        const firstPng = await canvas.screenshot({ path: firstScreenshot })
        const firstPixels = await inspectPngPixels(page, firstPng)

        await page.waitForTimeout(450)

        const finalFacts = await readProofFacts(page)
        const finalScreenshot = resolve(outputDirectory, 'uniform-triangle-frame-2.png')
        const finalPng = await canvas.screenshot({ path: finalScreenshot })
        const finalPixels = await inspectPngPixels(page, finalPng)

        return {
            adapter: adapterFacts,
            proof: {
                firstFacts,
                finalFacts,
                screenshots: {
                    first: firstScreenshot,
                    final: finalScreenshot,
                },
                pixels: {
                    first: firstPixels,
                    final: finalPixels,
                    centerDelta: colorDelta(firstPixels.center, finalPixels.center),
                    firstCenterBackgroundDelta: colorDelta(firstPixels.center, firstPixels.corner),
                    finalCenterBackgroundDelta: colorDelta(finalPixels.center, finalPixels.corner),
                },
                consoleFailures,
                pageErrors,
                requestFailures,
                httpFailures,
            },
        }
    } finally {
        await context.close()
    }
}

async function readProofFacts(page) {

    return await page.evaluate(() => {
        const canvas = document.querySelector('#GPUFrame')
        if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Uniform triangle canvas is missing.')
        return { ...canvas.dataset }
    })
}

async function inspectPngPixels(page, png) {

    return await page.evaluate(async(base64) => {
        const image = new Image()
        image.src = `data:image/png;base64,${base64}`
        await image.decode()
        const canvas = document.createElement('canvas')
        canvas.width = image.naturalWidth
        canvas.height = image.naturalHeight
        const context = canvas.getContext('2d', { willReadFrequently: true })
        if (!context) throw new Error('2D screenshot inspection context is unavailable.')
        context.drawImage(image, 0, 0)
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
        const sample = (x, y) => {
            const index = (y * canvas.width + x) * 4
            return [ pixels[index], pixels[index + 1], pixels[index + 2], pixels[index + 3] ]
        }
        let minimumChannel = 255
        let maximumChannel = 0
        for (let index = 0; index < pixels.length; index += 4) {
            minimumChannel = Math.min(
                minimumChannel,
                pixels[index],
                pixels[index + 1],
                pixels[index + 2]
            )
            maximumChannel = Math.max(
                maximumChannel,
                pixels[index],
                pixels[index + 1],
                pixels[index + 2]
            )
        }
        return {
            width: canvas.width,
            height: canvas.height,
            center: sample(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2)),
            corner: sample(
                Math.max(0, Math.floor(canvas.width * 0.05)),
                Math.max(0, Math.floor(canvas.height * 0.05))
            ),
            channelRange: maximumChannel - minimumChannel,
        }
    }, png.toString('base64'))
}

function validateResult(result) {

    const failures = []
    if (result.fatalError !== undefined) failures.push(`browser probe failed: ${result.fatalError}`)
    if (result.cleanupError !== undefined) failures.push(`cleanup failed: ${result.cleanupError}`)
    if (!result.serverClosed) failures.push(`managed Vite port ${port} remained open after cleanup`)
    if (result.adapter?.available !== true) failures.push('navigator.gpu was unavailable')
    if (result.adapter?.adapterAvailable !== true) failures.push('WebGPU adapter was unavailable')
    if (result.proof === undefined) return failures

    const { firstFacts, finalFacts, pixels } = result.proof
    for (const [ name, facts ] of [ [ 'first', firstFacts ], [ 'final', finalFacts ] ]) {
        if (facts.status !== 'ready') failures.push(`${name} example status was ${facts.status}`)
        if (Number(facts.frames) < 120) failures.push(`${name} proof observed fewer than 120 submitted frames`)
        if (Number(facts.observedFrames) < 120) failures.push(`${name} proof observed fewer than 120 settled frames`)
        if (facts.stableObjects !== 'true') failures.push(`${name} persistent-object identity check failed`)
        if (facts.declarationStable !== 'true') failures.push(`${name} command declaration drifted`)
        if (facts.producerReadMatch !== 'true') failures.push(`${name} producer/read epoch check failed`)
        if (facts.epochMonotonic !== 'true') failures.push(`${name} resolved epoch was not monotonic`)
        if (facts.declaredContentEpoch !== 'current-at-step') {
            failures.push(`${name} ledger lost the current-at-step declaration`)
        }
        if (facts.resolvedContentEpoch !== facts.producerContentEpoch) {
            failures.push(`${name} resolved and producer epochs differ`)
        }
        if (facts.resourceAccessFrozen !== 'true') failures.push(`${name} access fact was mutable`)
        if (facts.resourceAccessSerializable !== 'true') failures.push(`${name} access fact was not serializable`)
        if (facts.uncapturedErrors !== '0') failures.push(`${name} example captured a GPU error`)
    }

    for (const id of [ 'uploadCommandId', 'drawCommandId', 'bindSetId', 'pipelineId', 'passId' ]) {
        if (!firstFacts[id]) failures.push(`first proof omitted ${id}`)
        if (firstFacts[id] !== finalFacts[id]) failures.push(`${id} changed between browser samples`)
    }
    if (Number(finalFacts.frames) <= Number(firstFacts.frames)) {
        failures.push('animation did not submit additional frames between screenshots')
    }
    if (Number(finalFacts.resolvedContentEpoch) <= Number(firstFacts.resolvedContentEpoch)) {
        failures.push('current-at-step did not resolve a later epoch between screenshots')
    }
    if (pixels.first.channelRange < 20 || pixels.final.channelRange < 20) {
        failures.push('canvas screenshots were blank or visually uniform')
    }
    if (pixels.firstCenterBackgroundDelta < 30 || pixels.finalCenterBackgroundDelta < 30) {
        failures.push('triangle center was not visibly distinct from the clear color')
    }
    if (pixels.centerDelta < 20) failures.push('animated triangle color did not change between screenshots')
    if (result.proof.consoleFailures.length > 0) failures.push('browser emitted console errors')
    if (result.proof.pageErrors.length > 0) failures.push('browser emitted page errors')
    if (result.proof.requestFailures.length > 0) failures.push('browser emitted request failures')
    if (result.proof.httpFailures.length > 0) failures.push('browser received failing HTTP responses')
    return failures
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

async function waitForVite(vite, url) {

    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
        if (vite.spawnError !== undefined) throw vite.spawnError
        if (vite.child.exitCode !== null) {
            throw new Error(`Vite exited before readiness with code ${vite.child.exitCode}.`)
        }
        try {
            const remainingMs = Math.max(1, deadline - Date.now())
            const response = await fetch(url, {
                signal: AbortSignal.timeout(Math.min(1_000, remainingMs)),
            })
            const ready = response.ok
            await response.body?.cancel()
            if (ready) return
        } catch {
            // The listener is not ready yet.
        }
        await delay(100)
    }
    throw new Error(`Timed out waiting for managed Vite at ${url}.`)
}

async function stopVite(vite) {

    if (vite.child.exitCode !== null || vite.child.signalCode !== null) return
    vite.child.kill('SIGTERM')
    try {
        await waitForExit(vite.child, 5_000)
    } catch {
        vite.child.kill('SIGKILL')
        await waitForExit(vite.child, 5_000)
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
        const settle = (connected) => {
            socket.removeAllListeners()
            socket.destroy()
            resolvePromise(connected)
        }
        socket.setTimeout(500, () => settle(false))
        socket.once('connect', () => settle(true))
        socket.once('error', () => settle(false))
    })
}

function colorDelta(left, right) {

    return Math.abs(left[0] - right[0]) +
        Math.abs(left[1] - right[1]) +
        Math.abs(left[2] - right[2])
}

function positiveInteger(value, fallback) {

    if (value === undefined && fallback !== undefined) return fallback
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new TypeError(`Expected a positive integer, received ${value}.`)
    }
    return parsed
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
