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
const proofFrames = positiveInteger(process.env.HELLO_GAW_PROOF_FRAMES, 240)
const timeout = positiveInteger(process.env.HELLO_GAW_BROWSER_TIMEOUT_MS, 90_000)
const outputDirectory = resolve(
    process.env.HELLO_GAW_BROWSER_OUTPUT ?? '/tmp/geoscratch-hello-gaw-browser'
)
const port = process.env.HELLO_GAW_BROWSER_PORT === undefined
    ? await findAvailablePort()
    : positiveInteger(process.env.HELLO_GAW_BROWSER_PORT)
const baseUrl = `http://127.0.0.1:${port}`

if (proofFrames < 240) throw new TypeError('HELLO_GAW_PROOF_FRAMES must be at least 240.')

await mkdir(outputDirectory, { recursive: true })
const vite = startVite(port)
let browser
let browserVersion
let adapter
let proof
let fatalError
let cleanupError
let serverClosed = false

try {
    await waitForVite(vite, `${baseUrl}/helloGAW/index.html`)
    browser = await chromium.launch({
        channel: 'chrome',
        headless: false,
        args: [ '--enable-unsafe-webgpu' ],
    })
    browserVersion = await browser.version()
    const verified = await verifyHelloGaw(browser)
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

const failures = validateResult({ adapter, proof, fatalError, cleanupError, serverClosed })
const result = {
    schemaVersion: 1,
    browserVersion,
    headed: true,
    proofFrames,
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

async function verifyHelloGaw(activeBrowser) {

    const context = await activeBrowser.newContext({
        viewport: { width: 960, height: 720 },
        deviceScaleFactor: 1,
    })
    const page = await context.newPage()
    const consoleFailures = []
    const consoleWarnings = []
    const pageErrors = []
    const requestFailures = []
    const httpFailures = []
    page.on('console', (message) => {
        if (message.type() === 'error') pushBounded(consoleFailures, message.text())
        if (message.type() === 'warning') pushBounded(consoleWarnings, message.text())
    })
    page.on('pageerror', error => pushBounded(pageErrors, serializeError(error)))
    page.on('requestfailed', request => pushBounded(
        requestFailures,
        `${request.method()} ${request.url()}: ${request.failure()?.errorText ?? 'unknown failure'}`
    ))
    page.on('response', (response) => {
        if (response.status() >= 400) {
            pushBounded(httpFailures, `${response.status()} ${response.request().method()} ${response.url()}`)
        }
    })

    try {
        await page.goto(`${baseUrl}/helloGAW/index.html?proof=1`, {
            waitUntil: 'domcontentloaded',
            timeout,
        })
        const adapterFacts = await readAdapterFacts(page)
        const firstTarget = Math.floor(proofFrames / 2)
        const motionStartTarget = Math.max(1, firstTarget - 12)
        await waitForFrames(page, motionStartTarget, motionStartTarget)

        const canvas = page.locator('#GPUFrame')
        const motionStartPath = resolve(outputDirectory, 'hello-gaw-motion-start.png')
        const motionStartPng = await canvas.screenshot({ path: motionStartPath })

        await waitForFrames(page, firstTarget, firstTarget)
        const beforeResizeFacts = await readProofFacts(page)
        const beforeResizePath = resolve(outputDirectory, 'hello-gaw-before-resize.png')
        const beforeResizePng = await canvas.screenshot({ path: beforeResizePath })
        const beforeResizePixels = await inspectPixelPair(page, motionStartPng, beforeResizePng)

        const resizeStartFrame = Number(beforeResizeFacts.frames)
        const resizeStartGeneration = Number(beforeResizeFacts.resizeGeneration)
        await page.setViewportSize({ width: 800, height: 600 })
        await page.waitForFunction((generation) => {
            const canvasElement = document.querySelector('#GPUFrame')
            return Number(canvasElement?.dataset.resizeGeneration) > generation
        }, resizeStartGeneration, { timeout })
        const finalTarget = resizeStartFrame + (proofFrames - firstTarget)
        await waitForFrames(page, finalTarget, finalTarget)

        const afterResizeFacts = await readProofFacts(page)
        const afterResizePath = resolve(outputDirectory, 'hello-gaw-after-resize.png')
        const afterResizePng = await canvas.screenshot({ path: afterResizePath })
        const afterResizePixels = await inspectPixels(page, afterResizePng)

        return {
            adapter: adapterFacts,
            proof: {
                targets: {
                    beforeResize: firstTarget,
                    afterResize: proofFrames - firstTarget,
                    finalFrame: finalTarget,
                },
                beforeResizeFacts,
                afterResizeFacts,
                screenshots: {
                    motionStart: motionStartPath,
                    beforeResize: beforeResizePath,
                    afterResize: afterResizePath,
                },
                pixels: {
                    motionStart: beforeResizePixels.first,
                    beforeResize: beforeResizePixels.second,
                    afterResize: afterResizePixels,
                    animation: beforeResizePixels.difference,
                },
                consoleFailures,
                consoleWarnings,
                pageErrors,
                requestFailures,
                httpFailures,
            },
        }
    } finally {
        await context.close()
    }
}

async function readAdapterFacts(page) {

    return await page.evaluate(async() => {
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
                maxStorageBuffersPerShaderStage: currentAdapter.limits.maxStorageBuffersPerShaderStage,
            },
        }
    })
}

async function waitForFrames(page, submittedFrames, observedFrames) {

    await page.waitForFunction(({ submitted, observed }) => {
        const facts = document.querySelector('#GPUFrame')?.dataset
        if (facts?.status === 'error') throw new Error(facts.error ?? 'Hello GAW failed.')
        return facts?.status === 'ready' &&
            Number(facts.frames) >= submitted &&
            Number(facts.observedFrames) >= observed
    }, { submitted: submittedFrames, observed: observedFrames }, { timeout })
}

async function readProofFacts(page) {

    return await page.evaluate(() => {
        const target = document.querySelector('#GPUFrame')
        if (!(target instanceof HTMLCanvasElement)) throw new Error('Hello GAW canvas is missing.')
        return { ...target.dataset }
    })
}

async function inspectPixels(page, png) {

    return await page.evaluate(async(base64) => {
        const image = new Image()
        image.src = `data:image/png;base64,${base64}`
        await image.decode()
        const target = document.createElement('canvas')
        target.width = image.naturalWidth
        target.height = image.naturalHeight
        const context = target.getContext('2d', { willReadFrequently: true })
        if (!context) throw new Error('Pixel inspection context is unavailable.')
        context.drawImage(image, 0, 0)
        const pixels = context.getImageData(0, 0, target.width, target.height).data
        let minimumChannel = 255
        let maximumChannel = 0
        let nonDarkPixels = 0
        let lumaSum = 0
        for (let index = 0; index < pixels.length; index += 4) {
            const red = pixels[index]
            const green = pixels[index + 1]
            const blue = pixels[index + 2]
            minimumChannel = Math.min(minimumChannel, red, green, blue)
            maximumChannel = Math.max(maximumChannel, red, green, blue)
            if (Math.max(red, green, blue) > 8) nonDarkPixels++
            lumaSum += red * 0.2126 + green * 0.7152 + blue * 0.0722
        }
        return {
            width: target.width,
            height: target.height,
            nonDarkPixels,
            channelRange: maximumChannel - minimumChannel,
            meanLuma: lumaSum / (target.width * target.height),
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
        const summarize = decoded => {
            let minimumChannel = 255
            let maximumChannel = 0
            let nonDarkPixels = 0
            let lumaSum = 0
            for (let index = 0; index < decoded.pixels.length; index += 4) {
                const red = decoded.pixels[index]
                const green = decoded.pixels[index + 1]
                const blue = decoded.pixels[index + 2]
                minimumChannel = Math.min(minimumChannel, red, green, blue)
                maximumChannel = Math.max(maximumChannel, red, green, blue)
                if (Math.max(red, green, blue) > 8) nonDarkPixels++
                lumaSum += red * 0.2126 + green * 0.7152 + blue * 0.0722
            }
            return {
                width: decoded.width,
                height: decoded.height,
                nonDarkPixels,
                channelRange: maximumChannel - minimumChannel,
                meanLuma: lumaSum / (decoded.width * decoded.height),
            }
        }
        const first = await decode(firstBase64)
        const second = await decode(secondBase64)
        if (first.width !== second.width || first.height !== second.height) {
            throw new Error('Animation screenshots have different dimensions.')
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
    if (!result.serverClosed) failures.push(`managed Vite port ${port} remained open after cleanup`)
    if (result.adapter?.available !== true) failures.push('navigator.gpu was unavailable')
    if (result.adapter?.adapterAvailable !== true) failures.push('WebGPU adapter was unavailable')
    if (result.proof === undefined) return failures

    const { beforeResizeFacts: before, afterResizeFacts: after, pixels } = result.proof
    validateFacts('before resize', before, failures)
    validateFacts('after resize', after, failures)
    if (Number(before.frames) < result.proof.targets.beforeResize) {
        failures.push('fewer than 120 frames were submitted before resize')
    }
    if (Number(before.observedFrames) < result.proof.targets.beforeResize) {
        failures.push('fewer than 120 frames were observed before resize')
    }
    if (Number(after.frames) - Number(before.frames) < result.proof.targets.afterResize) {
        failures.push('fewer than 120 frames were submitted after resize')
    }
    if (Number(after.observedFrames) < result.proof.targets.finalFrame) {
        failures.push('fewer than 120 additional frames were observed after resize')
    }
    if (Number(after.resizeGeneration) !== Number(before.resizeGeneration) + 1) {
        failures.push('browser resize did not produce exactly one resize generation')
    }
    if (before.stableIdentityHash !== after.stableIdentityHash) {
        failures.push('persistent graph identities changed across resize')
    }
    if (before.sizeDependentIdentityHash === after.sizeDependentIdentityHash) {
        failures.push('size-dependent dispatch commands were not rebuilt on resize')
    }
    for (const [ name, sample ] of [
        [ 'motion start', pixels.motionStart ],
        [ 'before resize', pixels.beforeResize ],
        [ 'after resize', pixels.afterResize ],
    ]) {
        if (sample.nonDarkPixels < 20_000 || sample.channelRange < 100 || sample.meanLuma < 2) {
            failures.push(`${name} screenshot was blank or visually uniform`)
        }
    }
    if (pixels.animation.changedPixels < 10_000 || pixels.animation.meanRgbDelta < 1) {
        failures.push('earth animation did not produce enough changing pixels')
    }
    if (result.proof.consoleFailures.length > 0) failures.push('browser emitted console errors')
    if (result.proof.pageErrors.length > 0) failures.push('browser emitted page errors')
    if (result.proof.requestFailures.length > 0) failures.push('browser emitted request failures')
    if (result.proof.httpFailures.length > 0) failures.push('browser received HTTP 4xx/5xx responses')
    return failures
}

function validateFacts(label, facts, failures) {

    if (facts.status !== 'ready') failures.push(`${label} status was ${facts.status}`)
    if (facts.stageOrder !== 'simulation-indexing|scene|bloom|fxaa|presentation') {
        failures.push(`${label} stage order was incorrect`)
    }
    if (facts.stageCount !== '5') failures.push(`${label} stage count was not five`)
    if (facts.sceneCommandCount !== '5') failures.push(`${label} scene command count was not five`)
    if (facts.bloomCommandCount !== '17') failures.push(`${label} Bloom command count was not 17`)
    if (facts.proofMode !== 'true' || facts.fixedTimestep !== 'true') {
        failures.push(`${label} deterministic proof mode was not active`)
    }
    if (facts.seed !== '0x6d2b79f5') failures.push(`${label} deterministic seed was incorrect`)
    if (facts.producerReadMatch !== 'true') failures.push(`${label} producer/read check failed`)
    if (facts.indirectGpuOnly !== 'true') failures.push(`${label} indirect path was not GPU-only`)
    if (facts.diagnosticsBounded !== 'true') failures.push(`${label} diagnostics were not bounded`)
    if (facts.diagnosticIncidents !== '0') failures.push(`${label} diagnostics retained an incident`)
    if (facts.uncapturedErrors !== '0') failures.push(`${label} reported an uncaptured GPU error`)
    if (facts.deviceLosses !== '0') failures.push(`${label} reported device loss`)

    let provenance
    try {
        provenance = JSON.parse(facts.provenance)
    } catch {
        failures.push(`${label} provenance was not valid JSON`)
        return
    }
    if (!Array.isArray(provenance) || provenance.length !== 6) {
        failures.push(`${label} provenance did not contain six required chains`)
        return
    }
    for (const chain of provenance) {
        if (chain.declaredContentEpoch !== 'current-at-step') {
            failures.push(`${label} ${chain.name} lost current-at-step`)
        }
        if (chain.producerContentEpoch !== chain.readContentEpoch) {
            failures.push(`${label} ${chain.name} producer/read epochs differed`)
        }
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

async function waitForVite(vite, url) {

    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
        if (vite.spawnError !== undefined) throw vite.spawnError
        if (vite.child.exitCode !== null) {
            throw new Error(`Vite exited before readiness with code ${vite.child.exitCode}.`)
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
