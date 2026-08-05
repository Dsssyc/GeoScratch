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
const tileServerRoot = resolve(examplesRoot, 'demLayer/tile-server')
const tileBuildEntry = resolve(tileServerRoot, '.venv/bin/dem-tile-build')
const tileServeEntry = resolve(tileServerRoot, '.venv/bin/dem-tile-serve')
const timeout = positiveInteger(process.env.DEM_LAYER_BROWSER_TIMEOUT_MS, 120_000)
const outputDirectory = resolve(
    process.env.DEM_LAYER_BROWSER_OUTPUT ?? '/tmp/geoscratch-dem-layer-browser'
)
const port = process.env.DEM_LAYER_BROWSER_PORT === undefined
    ? await findAvailablePort()
    : positiveInteger(process.env.DEM_LAYER_BROWSER_PORT)
const baseUrl = `http://127.0.0.1:${port}`
const tilePort = process.env.DEM_LAYER_TILE_PORT === undefined
    ? await findAvailablePort()
    : positiveInteger(process.env.DEM_LAYER_TILE_PORT)
const tileBaseUrl = `http://127.0.0.1:${tilePort}`
const expectedStageOrder = Object.freeze([ 'lod-map', 'terrain' ])
const requiredProvenanceNames = Object.freeze([
    'node-level-upload-to-lod-draw',
    'lod-arguments-upload-to-lod-draw',
    'node-box-upload-to-terrain-draw',
    'terrain-arguments-upload-to-terrain-draw',
    'lod-map-pass-to-terrain-draw',
])
const failureScenarios = Object.freeze([
    'after-map-acquisition',
    'invalid-terrain-shader-wgsl',
])

await mkdir(outputDirectory, { recursive: true })
let cogBuild
let tileServer
let vite
let browser
let browserVersion
let browserClosed = false
let adapter
let normalProof
let failureProofs
let fatalError
let cleanupError
let serverClosed = false
let tileServerClosed = false

try {
    cogBuild = await runCommand(tileBuildEntry, [], tileServerRoot)
    tileServer = startTileServer(tilePort)
    await waitForHttpProcess(tileServer, `${tileBaseUrl}/health`, 'DEM tile server')
    vite = startVite(port)
    await waitForVite(vite, `${baseUrl}/demLayer/index.html`)
    browser = await chromium.launch({
        channel: 'chrome',
        headless: false,
        args: [ '--enable-unsafe-webgpu' ],
    })
    browserVersion = await browser.version()
    const verified = await verifyNormalDem(browser)
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
        if (browser !== undefined) await withTimeout(browser.close(), 5_000, 'Chrome shutdown')
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
    headed: true,
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

async function verifyNormalDem(activeBrowser) {

    const context = await activeBrowser.newContext({
        viewport: { width: 960, height: 720 },
        deviceScaleFactor: 1,
    })
    const page = await context.newPage()
    const events = observePage(page)

    try {
        await page.goto(
            `${baseUrl}/demLayer/index.html?proof=1&tileServer=${encodeURIComponent(tileBaseUrl)}`,
            {
            waitUntil: 'domcontentloaded',
            timeout,
            }
        )
        await waitForDemFacts(page, facts => (
            facts.status === 'ready' &&
            Number(facts.observedFrames) >= 1 &&
            Number(facts.currentPendingNativeObservations) === 0
        ))

        const initialFacts = await readDemFacts(page)
        const adapterFacts = await readRuntimeAdapterFacts(page, initialFacts)
        const initialPath = resolve(outputDirectory, 'dem-initial.png')
        const initialPng = await page.locator('#GPUFrame').screenshot({ path: initialPath })

        await page.evaluate(() => {
            window.__DEM_LAYER_PROOF__.moveCamera({
                center: [ 120.980697, 31.684162 ],
                zoom: 10,
            })
        })
        await waitForDemFacts(page, facts => (
            facts.status === 'ready' &&
            Number(facts.observedFrames) > Number(initialFacts.observedFrames) &&
            Number(facts.visibleNodeCount) !== Number(initialFacts.visibleNodeCount) &&
            Number(facts.currentPendingNativeObservations) === 0
        ))

        const movedFacts = await readDemFacts(page)
        const movedPath = resolve(outputDirectory, 'dem-moved.png')
        const movedPng = await page.locator('#GPUFrame').screenshot({ path: movedPath })
        const movementPixels = await inspectPixelPair(page, initialPng, movedPng)

        const resizeGeneration = Number(movedFacts.resizeGeneration)
        await page.setViewportSize({ width: 800, height: 600 })
        await waitForDemFacts(page, facts => (
            facts.status === 'ready' &&
            Number(facts.resizeGeneration) > resizeGeneration &&
            Number(facts.observedFrames) > Number(movedFacts.observedFrames) &&
            Number(facts.currentPendingNativeObservations) === 0
        ))

        const resizedFacts = await readDemFacts(page)
        const resizedPath = resolve(outputDirectory, 'dem-resized.png')
        const resizedPng = await page.locator('#GPUFrame').screenshot({ path: resizedPath })
        const resizedPixels = await inspectPixels(page, resizedPng)
        const drainedFacts = await page.evaluate(async() => {
            return await window.__DEM_LAYER_PROOF__.pauseAndDrain()
        })
        const cleanupPair = await page.evaluate(async() => {
            const first = window.__DEM_LAYER_PROOF__.dispose()
            const second = window.__DEM_LAYER_PROOF__.dispose()
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
                initialFacts,
                movedFacts,
                resizedFacts,
                drainedFacts,
                cleanupPair,
                terminalStatus,
                screenshots: {
                    initial: initialPath,
                    moved: movedPath,
                    resized: resizedPath,
                },
                pixelHashes: {
                    initial: sha256(initialPng),
                    moved: sha256(movedPng),
                    resized: sha256(resizedPng),
                },
                pixels: {
                    initial: movementPixels.first,
                    moved: movementPixels.second,
                    resized: resizedPixels,
                    movement: movementPixels.difference,
                },
                ...events,
            },
        }
    } finally {
        await context.close()
    }
}

async function verifyFailureScenario(activeBrowser, scenario) {

    const context = await activeBrowser.newContext({
        viewport: { width: 960, height: 720 },
        deviceScaleFactor: 1,
    })
    const page = await context.newPage()
    const events = observePage(page)

    try {
        const url = `${baseUrl}/demLayer/index.html?proof=1&fault=${scenario}` +
            `&tileServer=${encodeURIComponent(tileBaseUrl)}`
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout })
        await page.waitForFunction(() => {
            return document.querySelector('#GPUFrame')?.dataset.initFailureProof !== undefined
        }, undefined, { timeout })
        const facts = await readDemFacts(page)
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
    const completeImageRequests = []
    page.on('console', (message) => {
        if (message.type() === 'error') pushBounded(consoleFailures, message.text())
        if (message.type() === 'warning') pushBounded(consoleWarnings, message.text())
    })
    page.on('pageerror', error => pushBounded(pageErrors, serializeError(error)))
    page.on('requestfailed', request => pushBounded(
        requestFailures,
        `${request.method()} ${request.url()}: ${request.failure()?.errorText ?? 'unknown failure'}`
    ))
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

async function waitForDemFacts(page, predicate) {

    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
        const facts = await readDemFacts(page)
        if (facts.status === 'error') {
            throw new Error([
                facts.error ?? 'DEM Layer failed.',
                facts.diagnostic === undefined ? undefined : `diagnostic=${facts.diagnostic}`,
            ].filter(Boolean).join('\n'))
        }
        if (predicate(facts)) return facts
        await delay(16)
    }
    throw new Error('Timed out waiting for DEM Layer proof facts.')
}

async function readDemFacts(page) {

    return await page.evaluate(() => {
        const target = document.querySelector('#GPUFrame')
        if (!(target instanceof HTMLCanvasElement)) throw new Error('DEM Layer canvas is missing.')
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
            for (let index = 0; index < value.pixels.length; index += 4) {
                const red = value.pixels[index]
                const green = value.pixels[index + 1]
                const blue = value.pixels[index + 2]
                const pixelIndex = index / 4
                const y = Math.floor(pixelIndex / value.width)
                minimumChannel = Math.min(minimumChannel, red, green, blue)
                maximumChannel = Math.max(maximumChannel, red, green, blue)
                if (Math.max(red, green, blue) > 8) nonDarkPixels++
                if (y < value.height - 32 &&
                    Math.abs(red - 16) + Math.abs(green - 20) + Math.abs(blue - 24) >= 12) {
                    nonBackgroundPixels++
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
            }
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
            for (let index = 0; index < value.pixels.length; index += 4) {
                const red = value.pixels[index]
                const green = value.pixels[index + 1]
                const blue = value.pixels[index + 2]
                const pixelIndex = index / 4
                const y = Math.floor(pixelIndex / value.width)
                minimumChannel = Math.min(minimumChannel, red, green, blue)
                maximumChannel = Math.max(maximumChannel, red, green, blue)
                if (Math.max(red, green, blue) > 8) nonDarkPixels++
                if (y < value.height - 32 &&
                    Math.abs(red - 16) + Math.abs(green - 20) + Math.abs(blue - 24) >= 12) {
                    nonBackgroundPixels++
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
            }
        }
        const first = await decode(firstBase64)
        const second = await decode(secondBase64)
        if (first.width !== second.width || first.height !== second.height) {
            throw new Error('DEM movement screenshots have different dimensions.')
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
        failures.push('ScratchRuntime did not acquire a WebGPU adapter')
    }
    if (result.normalProof === undefined) {
        failures.push('normal DEM proof was not produced')
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

    const initial = proof.initialFacts
    const moved = proof.movedFacts
    const resized = proof.resizedFacts
    const drained = proof.drainedFacts
    validateDemFacts('initial', initial, failures)
    validateDemFacts('moved', moved, failures)
    validateDemFacts('resized', resized, failures)
    validateDemFacts('drained', drained, failures, 'stopped')

    const initialSelection = parseJson(initial.selection, 'initial selection', failures)
    const movedSelection = parseJson(moved.selection, 'moved selection', failures)
    const resizedSelection = parseJson(resized.selection, 'resized selection', failures)
    if (initialSelection?.visibleNodeCount !== 24 || initialSelection?.levelRange?.[0] !== 9) {
        failures.push('initial controlled zoom did not preserve the legacy zoom-9 LoD facts')
    }
    if (movedSelection?.visibleNodeCount !== 56 || movedSelection?.levelRange?.[1] !== 10) {
        failures.push('controlled camera zoom did not produce the expected zoom-10 LoD facts')
    }
    if (JSON.stringify(selectionParityFacts(movedSelection)) !==
        JSON.stringify(selectionParityFacts(resizedSelection))) {
        failures.push('resize changed CPU LoD selection without a camera change')
    }

    for (const facts of [ initial, moved, resized, drained ]) {
        if (facts.currentStableIdentityHash !== initial.currentStableIdentityHash ||
            facts.currentStableIdentityCount !== initial.currentStableIdentityCount ||
            facts.currentIdentityFacts !== initial.currentIdentityFacts) {
            failures.push('persistent DEM graph identity changed')
            break
        }
    }
    validatePersistentCounts(initial, resized, failures)

    if (Number(resized.resizeGeneration) !== Number(moved.resizeGeneration) + 1) {
        failures.push('browser resize did not produce exactly one resize generation')
    }
    const resize = parseJson(resized.lastResizeFacts, 'resize facts', failures)
    if (resize?.resizeGeneration !== Number(resized.resizeGeneration) ||
        resize?.staleBindSetCount !== 0 || resize?.preparedBindSetCount !== 0 ||
        resize?.depthAllocationVersion !== 2) {
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
    if (frameWork?.active !== 0) failures.push('DEM frame scheduler remained active after drain')

    if (!proof.cleanupPair?.equivalentReports || proof.cleanupPair.reports?.length !== 2) {
        failures.push('double disposal did not return two equivalent cleanup reports')
    } else {
        validateCleanup(proof.cleanupPair.reports[0], [
            'dem-frame-scheduler',
            'window-resize-listener',
            'map-render-listener',
            'dem-virtual-raster-streaming',
            'pagehide-listener',
            'maplibre-map',
            'scratch-runtime',
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

    for (const [ label, sample ] of [
        [ 'initial', proof.pixels.initial ],
        [ 'moved', proof.pixels.moved ],
        [ 'resized', proof.pixels.resized ],
    ]) {
        if (sample.nonBackgroundPixels < 1_000 || sample.nonTransparentPixels < 100 ||
            sample.channelRange < 8 || sample.meanLuma < 0.05) {
            failures.push(`${label} DEM screenshot was blank or visually uniform`)
        }
    }
    if (proof.pixelHashes.initial === proof.pixelHashes.moved ||
        proof.pixels.movement.changedPixels < 100 ||
        proof.pixels.movement.meanRgbDelta < 0.01) {
        failures.push('controlled camera change did not change enough terrain pixels')
    }
    if (proof.completeImageRequests.length > 0) {
        failures.push('normal DEM page requested the complete dem.png asset')
    }
    if (proof.tileRequests.length === 0) {
        failures.push('normal DEM page did not request COG-backed HTTP tiles')
    }
    validateCleanEvents('normal DEM page', proof, failures, 0)
}

function validateDemFacts(label, facts, failures, expectedStatus = 'ready') {

    if (facts.status !== expectedStatus) failures.push(`${label} status was ${facts.status}`)
    if (facts.proofMode !== 'true') failures.push(`${label} deterministic proof mode was not active`)
    if (facts.adapterAcquired !== 'true') failures.push(`${label} runtime adapter was not acquired`)
    if (facts.stageOrder !== expectedStageOrder.join('|') || facts.stageCount !== '2') {
        failures.push(`${label} stage order was incorrect`)
    }
    const count = Number(facts.visibleNodeCount)
    if (!Number.isSafeInteger(count) || count < 0 || count > 5_000) {
        failures.push(`${label} visible node count was outside 0..5000`)
    }
    if (facts.diagnosticsBounded !== 'true') failures.push(`${label} diagnostics were not bounded`)
    if (facts.diagnosticIncidents !== '0') failures.push(`${label} retained a diagnostic incident`)
    if (facts.uncapturedErrors !== '0') failures.push(`${label} reported an uncaptured GPU error`)
    if (facts.deviceLosses !== '0') failures.push(`${label} reported device loss`)

    const identity = parseJson(facts.currentIdentityFacts, `${label} identity facts`, failures)
    const expectedIdentityCounts = {
        count: 46,
        resources: 16,
        uploads: 12,
        bindLayouts: 5,
        bindSets: 5,
        programs: 2,
        pipelines: 2,
        passes: 2,
        commands: 2,
    }
    for (const [ name, expected ] of Object.entries(expectedIdentityCounts)) {
        if (identity?.[name] !== expected) {
            failures.push(`${label} current identity ${name} was not ${expected}`)
        }
    }
    if (identity?.hash !== facts.currentStableIdentityHash ||
        String(identity?.count) !== facts.currentStableIdentityCount) {
        failures.push(`${label} current identity hash/count publication was inconsistent`)
    }

    const stageActivity = parseJson(facts.stageActivity, `${label} stage activity`, failures)
    for (const name of expectedStageOrder) {
        if (stageActivity?.[name] !== Number(facts.frames)) {
            failures.push(`${label} ${name} activity did not match submitted frames`)
        }
    }
    const provenance = parseJson(facts.provenance, `${label} provenance`, failures)
    if (!Array.isArray(provenance) || provenance.length !== requiredProvenanceNames.length) {
        failures.push(`${label} provenance did not contain five exact chains`)
    } else {
        for (const [ index, chain ] of provenance.entries()) {
            if (chain.name !== requiredProvenanceNames[index]) {
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
    if (contract?.countPath !== 'uploaded-indirect-arguments' ||
        contract?.maxNodes !== 5_000 || contract?.terrainVertexCount !== 24_576 ||
        JSON.stringify(contract?.stageOrder) !== JSON.stringify(expectedStageOrder)) {
        failures.push(`${label} persistent graph contract drifted`)
    }
    if (contract?.virtualRaster?.completeImageUpload !== false ||
        contract?.virtualRaster?.crossPageFiltering !== 'logical-bilinear' ||
        contract?.virtualRaster?.coordinateEncoding !== 'cell-local-f32') {
        failures.push(`${label} virtual raster graph contract drifted`)
    }
    validateVirtualRasterFacts(label, facts, failures)
}

function validateVirtualRasterFacts(label, facts, failures) {

    const virtualRaster = parseJson(facts.virtualRaster, `${label} virtual raster facts`, failures)
    const residency = virtualRaster?.residency
    const gpu = virtualRaster?.gpu
    const maximumPages = Number(facts.maxPhysicalPages)
    if (!Number.isSafeInteger(maximumPages) || maximumPages < 2 || maximumPages > 18) {
        failures.push(`${label} physical page budget was invalid`)
    }
    if (virtualRaster?.coordinateEncoding !== 'cell-local-f32' ||
        !Number.isFinite(virtualRaster?.coordinateQuantum) ||
        !Array.isArray(virtualRaster?.failedPageKeys) ||
        virtualRaster.failedPageKeys.length !== 0) {
        failures.push(`${label} virtual raster precision or failure facts were invalid`)
    }
    if (residency?.residentCount < 1 || residency?.residentCount > maximumPages ||
        residency?.pinnedCount !== 1 || residency?.cpuBytes > residency?.maxCpuBytes ||
        residency?.maxPhysicalPages !== maximumPages || residency?.failedCount !== 0 ||
        residency?.staleResponseCount !== 0 || residency?.history?.length > 64) {
        failures.push(`${label} virtual raster residency exceeded its finite contract`)
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
    for (const [ name, expected ] of [
        [ 'resources', 16 ],
        [ 'bindLayouts', 5 ],
        [ 'bindSets', 5 ],
        [ 'pipelines', 2 ],
    ]) {
        if (first?.[name] !== expected || second?.[name] !== expected) {
            failures.push(`persistent ${name} count changed or was not ${expected}`)
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
            proof?.primaryFailure?.code !== 'DEM_LAYER_INJECTED_FAILURE') {
            failures.push(`${prefix} lost the pre-runtime acquisition boundary or primary failure`)
        }
        if (proof?.runtimeEvidence !== undefined || proof?.captureReport !== undefined) {
            failures.push(`${prefix} fabricated GPU evidence before runtime acquisition`)
        }
        validateCleanup(proof, [ 'pagehide-listener', 'maplibre-map' ], failures)
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
        compilation?.sourcePartCount !== 2 ||
        compilation?.retainedSourcePartCount !== 2 ||
        compilation?.errorCount < 1) {
        failures.push(`${prefix} did not retain the two localized source-part compilation report`)
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
    if (evidenceText.includes('demInjectedFailure') || /"source"\s*:/.test(evidenceText)) {
        failures.push(`${prefix} exported raw WGSL source evidence`)
    }
    validateCleanup(proof, [
        'dem-virtual-raster-streaming',
        'pagehide-listener',
        'maplibre-map',
        'scratch-runtime',
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

    const selection = facts => parseJsonOrUndefined(facts.selection)
    const resize = parseJsonOrUndefined(proof.resizedFacts.lastResizeFacts)
    return {
        initial: summarizeFacts(proof.initialFacts, selection(proof.initialFacts)),
        moved: summarizeFacts(proof.movedFacts, selection(proof.movedFacts)),
        resized: {
            ...summarizeFacts(proof.resizedFacts, selection(proof.resizedFacts)),
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
        httpFailures: proof.httpFailures,
        requestCount: proof.requests.length,
        tileRequestCount: proof.tileRequests.length,
        completeImageRequestCount: proof.completeImageRequests.length,
    }
}

function summarizeFacts(facts, selection) {

    return {
        status: facts.status,
        frames: Number(facts.frames),
        observedFrames: Number(facts.observedFrames),
        visibleNodeCount: Number(facts.visibleNodeCount),
        levelRange: selection?.levelRange,
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

function selectionParityFacts(selection) {

    if (selection === undefined) return undefined
    return {
        candidateCount: selection.candidateCount,
        selectedCount: selection.selectedCount,
        cappedCount: selection.cappedCount,
        droppedCount: selection.droppedCount,
        visibleNodeCount: selection.visibleNodeCount,
        tileBox: selection.tileBox,
        levelRange: selection.levelRange,
        sectorRange: selection.sectorRange,
        nodeLevels: selection.nodeLevels,
        nodeBoxes: selection.nodeBoxes,
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
            visibleNodeCount: proof.graphState.visibleNodeCount,
            stageActivity: proof.graphState.stageActivity,
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
