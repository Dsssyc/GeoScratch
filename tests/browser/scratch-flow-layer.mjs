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
const proofFrames = positiveInteger(process.env.FLOW_LAYER_PROOF_FRAMES, 660)
const timeout = positiveInteger(process.env.FLOW_LAYER_BROWSER_TIMEOUT_MS, 120_000)
const outputDirectory = resolve(
    process.env.FLOW_LAYER_BROWSER_OUTPUT ?? '/tmp/geoscratch-flow-layer-browser'
)
const port = process.env.FLOW_LAYER_BROWSER_PORT === undefined
    ? await findAvailablePort()
    : positiveInteger(process.env.FLOW_LAYER_BROWSER_PORT)
const baseUrl = `http://127.0.0.1:${port}`
const expectedStageOrder = Object.freeze([
    'voronoi-field',
    'particle-simulation',
    'history-particles',
    'flow-visualization',
    'history-presentation',
])
const requiredProvenanceNames = Object.freeze([
    'voronoi-to-simulation',
    'simulation-to-particle-draw',
    'history-to-presentation',
])
const failureScenarios = Object.freeze([
    'after-worker-acquisition',
    'invalid-simulation-pipeline-wgsl',
])

if (proofFrames < 660) throw new TypeError('FLOW_LAYER_PROOF_FRAMES must be at least 660.')

await mkdir(outputDirectory, { recursive: true })
const vite = startVite(port)
let browser
let browserVersion
let adapter
let normalProof
let failureProofs
let fatalError
let cleanupError
let serverClosed = false

try {
    await waitForVite(vite, `${baseUrl}/flowLayer/index.html`)
    browser = await chromium.launch({
        channel: 'chrome',
        headless: false,
        args: [ '--enable-unsafe-webgpu' ],
    })
    browserVersion = await browser.version()
    const verified = await verifyNormalFlow(browser)
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
    normalProof,
    failureProofs,
    fatalError,
    cleanupError,
    serverClosed,
})
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
    normalProof,
    failureProofs: failureProofs?.map(summarizeFailureResult),
    fatalError,
    cleanupError,
    status: failures.length === 0 ? 'passed' : 'failed',
    failures,
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
if (failures.length > 0) process.exitCode = 1

async function verifyNormalFlow(activeBrowser) {

    const context = await activeBrowser.newContext({
        viewport: { width: 960, height: 720 },
        deviceScaleFactor: 1,
    })
    const page = await context.newPage()
    const events = observePage(page)

    try {
        await page.goto(`${baseUrl}/flowLayer/index.html?proof=1&arrows=1`, {
            waitUntil: 'domcontentloaded',
            timeout,
        })
        const adapterFacts = await readAdapterFacts(page)
        await waitForFlowFacts(page, facts => (
            facts.status === 'ready' &&
            Number(facts.observedFrames) >= 120 &&
            Number(facts.currentPendingNativeObservations) === 0
        ))

        const beforeInteractionFacts = await readFlowFacts(page)
        const beforeInteractionPath = resolve(outputDirectory, 'flow-before-interaction.png')
        const beforeInteractionPng = await page.locator('#GPUFrame').screenshot({
            path: beforeInteractionPath,
        })

        const mapBounds = await page.locator('#map').boundingBox()
        if (mapBounds === null) throw new Error('Flow MapLibre interaction surface is missing.')
        const beforeMove = {
            cameraMoveCount: Number(beforeInteractionFacts.cameraMoveCount),
            cameraSettleCount: Number(beforeInteractionFacts.cameraSettleCount),
            historyReprojectionFrames: Number(beforeInteractionFacts.historyReprojectionFrames),
        }
        const centerX = mapBounds.x + mapBounds.width / 2
        const centerY = mapBounds.y + mapBounds.height / 2
        await page.mouse.move(centerX, centerY)
        await page.mouse.down()
        await page.mouse.move(centerX + 80, centerY + 40, { steps: 8 })
        await page.mouse.up()
        await waitForFlowFacts(page, facts => (
            Number(facts.cameraMoveCount) > beforeMove.cameraMoveCount &&
            Number(facts.cameraSettleCount) > beforeMove.cameraSettleCount &&
            Number(facts.historyReprojectionFrames) > beforeMove.historyReprojectionFrames &&
            Number(facts.observedFrames) >= Number(beforeInteractionFacts.observedFrames) + 30
        ))

        const afterMotionFacts = await readFlowFacts(page)
        const afterMotionPath = resolve(outputDirectory, 'flow-after-motion.png')
        const afterMotionPng = await page.locator('#GPUFrame').screenshot({ path: afterMotionPath })
        const animationPixels = await inspectPixelPair(
            page,
            beforeInteractionPng,
            afterMotionPng
        )

        const resizeGeneration = Number(afterMotionFacts.resizeGeneration)
        await page.setViewportSize({ width: 800, height: 600 })
        await waitForFlowFacts(page, facts => (
            Number(facts.resizeGeneration) > resizeGeneration &&
            Number(facts.observedFrames) >= proofFrames &&
            Number(facts.workerTransitions) >= 1 &&
            Number(facts.workerPending) === 0 &&
            Number(facts.currentPendingNativeObservations) === 0
        ))

        const afterResizeFacts = await readFlowFacts(page)
        const afterResizePath = resolve(outputDirectory, 'flow-after-resize.png')
        const afterResizePng = await page.locator('#GPUFrame').screenshot({ path: afterResizePath })
        const afterResizePixels = await inspectPixels(page, afterResizePng)
        const drainedFacts = await page.evaluate(async() => {
            return await window.__FLOW_LAYER_PROOF__.pauseAndDrain()
        })
        const cleanupPair = await page.evaluate(async() => {
            return await Promise.all([
                window.__FLOW_LAYER_PROOF__.dispose(),
                window.__FLOW_LAYER_PROOF__.dispose(),
            ])
        })
        const terminalStatus = await page.locator('#GPUFrame').getAttribute('data-status')

        return {
            adapter: adapterFacts,
            proof: {
                beforeInteractionFacts,
                afterMotionFacts,
                afterResizeFacts,
                drainedFacts,
                cleanupPair,
                terminalStatus,
                screenshots: {
                    beforeInteraction: beforeInteractionPath,
                    afterMotion: afterMotionPath,
                    afterResize: afterResizePath,
                },
                pixels: {
                    beforeInteraction: animationPixels.first,
                    afterMotion: animationPixels.second,
                    afterResize: afterResizePixels,
                    animation: animationPixels.difference,
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
        const url = `${baseUrl}/flowLayer/index.html?proof=1&fault=${scenario}`
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout })
        await page.waitForFunction(() => {
            return document.querySelector('#GPUFrame')?.dataset.initFailureProof !== undefined
        }, undefined, { timeout })
        const facts = await readFlowFacts(page)
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
    return { consoleFailures, consoleWarnings, pageErrors, requestFailures, httpFailures }
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

async function waitForFlowFacts(page, predicate) {

    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
        const facts = await readFlowFacts(page)
        if (facts.status === 'error') throw new Error(facts.error ?? 'Flow Layer failed.')
        if (predicate(facts)) return facts
        await delay(16)
    }
    throw new Error('Timed out waiting for Flow Layer proof facts.')
}

async function readFlowFacts(page) {

    return await page.evaluate(() => {
        const target = document.querySelector('#GPUFrame')
        if (!(target instanceof HTMLCanvasElement)) throw new Error('Flow Layer canvas is missing.')
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
        let nonTransparentPixels = 0
        let lumaSum = 0
        for (let index = 0; index < pixels.length; index += 4) {
            const red = pixels[index]
            const green = pixels[index + 1]
            const blue = pixels[index + 2]
            minimumChannel = Math.min(minimumChannel, red, green, blue)
            maximumChannel = Math.max(maximumChannel, red, green, blue)
            if (Math.max(red, green, blue) > 8) nonDarkPixels++
            if (pixels[index + 3] > 0) nonTransparentPixels++
            lumaSum += red * 0.2126 + green * 0.7152 + blue * 0.0722
        }
        return {
            width: target.width,
            height: target.height,
            nonDarkPixels,
            nonTransparentPixels,
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
        const summarize = (decoded) => {
            let minimumChannel = 255
            let maximumChannel = 0
            let nonDarkPixels = 0
            let nonTransparentPixels = 0
            let lumaSum = 0
            for (let index = 0; index < decoded.pixels.length; index += 4) {
                const red = decoded.pixels[index]
                const green = decoded.pixels[index + 1]
                const blue = decoded.pixels[index + 2]
                minimumChannel = Math.min(minimumChannel, red, green, blue)
                maximumChannel = Math.max(maximumChannel, red, green, blue)
                if (Math.max(red, green, blue) > 8) nonDarkPixels++
                if (decoded.pixels[index + 3] > 0) nonTransparentPixels++
                lumaSum += red * 0.2126 + green * 0.7152 + blue * 0.0722
            }
            return {
                width: decoded.width,
                height: decoded.height,
                nonDarkPixels,
                nonTransparentPixels,
                channelRange: maximumChannel - minimumChannel,
                meanLuma: lumaSum / (decoded.width * decoded.height),
            }
        }
        const first = await decode(firstBase64)
        const second = await decode(secondBase64)
        if (first.width !== second.width || first.height !== second.height) {
            throw new Error('Flow animation screenshots have different dimensions.')
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
    if (result.normalProof !== undefined) validateNormalProof(result.normalProof, failures)
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

function summarizeFailureResult(result) {

    const proof = result.proof
    const compilation = proof?.incident?.compilationReport
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
            workerAcquiredCount: proof?.workerAcquiredCount,
            primaryFailure: proof?.primaryFailure,
            diagnostic: proof?.diagnostic === undefined ? undefined : {
                code: proof.diagnostic.code,
                phase: proof.diagnostic.phase,
                subject: proof.diagnostic.subject,
                actual: proof.diagnostic.actual,
            },
            incident: proof?.incident === undefined ? undefined : {
                diagnosticCode: proof.incident.diagnosticCode,
                target: proof.incident.target,
                outcomeCodes: proof.incident.outcomes?.map(outcome => outcome.diagnosticCode),
                compilationReport: compilation === undefined ? undefined : {
                    pipelineId: compilation.pipelineId,
                    programId: compilation.programId,
                    combinedSourceHash: compilation.combinedSourceHash,
                    moduleCount: compilation.moduleCount,
                    retainedModuleCount: compilation.retainedModuleCount,
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
            cleanup: proof?.cleanup,
        },
        consoleFailures: result.consoleFailures,
        consoleWarnings: result.consoleWarnings,
        pageErrors: result.pageErrors,
        requestFailures: result.requestFailures,
        httpFailures: result.httpFailures,
    }
}

function validateNormalProof(proof, failures) {

    const before = proof.beforeInteractionFacts
    const motion = proof.afterMotionFacts
    const after = proof.afterResizeFacts
    const drained = proof.drainedFacts
    for (const [ label, facts ] of [
        [ 'before interaction', before ],
        [ 'after motion', motion ],
        [ 'after resize', after ],
    ]) validateFlowFacts(label, facts, failures)

    if (Number(after.frames) < proofFrames || Number(after.observedFrames) < proofFrames) {
        failures.push(`normal proof did not observe at least ${proofFrames} frames`)
    }
    if (Number(after.workerTransitions) < 1) failures.push('worker-fed field never transitioned')
    if (after.workerFailures !== '0') failures.push('worker reported a field-load failure')
    if (Number(motion.cameraMoveCount) <= Number(before.cameraMoveCount)) {
        failures.push('camera movement was not observed')
    }
    if (Number(motion.cameraSettleCount) <= Number(before.cameraSettleCount)) {
        failures.push('camera settlement was not observed')
    }
    if (Number(motion.historyReprojectionFrames) <= Number(before.historyReprojectionFrames)) {
        failures.push('camera movement did not exercise history reprojection')
    }
    if (Number(after.resizeGeneration) !== Number(motion.resizeGeneration) + 1) {
        failures.push('browser resize did not produce exactly one resize generation')
    }
    if (before.stableIdentityHash !== motion.stableIdentityHash ||
        motion.stableIdentityHash !== after.stableIdentityHash ||
        after.stableIdentityHash !== drained.stableIdentityHash) {
        failures.push('persistent Flow graph identities changed')
    }
    if (before.stableIdentityCount !== after.stableIdentityCount) {
        failures.push('persistent Flow graph identity count changed')
    }
    validatePersistentCounts(before, after, failures)

    if (drained.status !== 'stopped') failures.push(`drained status was ${drained.status}`)
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
    if (frameWork?.active !== 0) failures.push('frame scheduler remained active after drain')

    if (!Array.isArray(proof.cleanupPair) || proof.cleanupPair.length !== 2) {
        failures.push('at-most-once cleanup pair was not produced')
    } else {
        const [ first, second ] = proof.cleanupPair
        if (JSON.stringify(first) !== JSON.stringify(second)) {
            failures.push('concurrent cleanup callers observed different reports')
        }
        validateCleanup(first, [
            'pagehide-listener',
            'flow-frame-scheduler',
            'flow-camera-listeners',
            'flow-worker-listeners',
            'flow-worker',
            'maplibre-map',
            'scratch-runtime',
        ], failures)
        if (first?.lifecycle?.state !== 'disposed' ||
            first?.lifecycle?.ownsWorker ||
            first?.lifecycle?.ownsMap ||
            first?.lifecycle?.ownsRuntime) {
            failures.push('normal cleanup retained a lifecycle owner')
        }
    }
    if (proof.terminalStatus !== 'disposed') {
        failures.push(`terminal page status was ${proof.terminalStatus}`)
    }

    for (const [ label, sample ] of [
        [ 'before interaction', proof.pixels.beforeInteraction ],
        [ 'after motion', proof.pixels.afterMotion ],
        [ 'after resize', proof.pixels.afterResize ],
    ]) {
        if (sample.nonDarkPixels < 500 || sample.nonTransparentPixels < 500 ||
            sample.channelRange < 20 || sample.meanLuma < 0.1) {
            failures.push(`${label} Flow screenshot was blank or visually uniform`)
        }
    }
    if (proof.pixels.animation.changedPixels < 500 ||
        proof.pixels.animation.meanRgbDelta < 0.05) {
        failures.push('Flow animation did not produce enough changing pixels')
    }
    validateCleanEvents('normal Flow page', proof, failures, 0)
}

function validateFlowFacts(label, facts, failures) {

    if (facts.status !== 'ready') failures.push(`${label} status was ${facts.status}`)
    if (facts.stageOrder !== expectedStageOrder.join('|')) {
        failures.push(`${label} stage order was incorrect`)
    }
    if (facts.stageCount !== '5') failures.push(`${label} stage count was not five`)
    if (facts.particleCount !== '262144') failures.push(`${label} particle count drifted`)
    if (facts.particleBlockSize !== '16') failures.push(`${label} particle block size drifted`)
    if (facts.historyDirectionCount !== '2') failures.push(`${label} history direction count drifted`)
    if (facts.proofMode !== 'true' || facts.fixedTimestep !== 'true') {
        failures.push(`${label} deterministic proof mode was not active`)
    }
    if (facts.seed !== '0x6d2b79f5') failures.push(`${label} deterministic seed was incorrect`)
    if (facts.historyMode !== 'reproject') failures.push(`${label} history mode was not reproject`)
    if (facts.diagnosticsBounded !== 'true') failures.push(`${label} diagnostics were not bounded`)
    if (facts.diagnosticIncidents !== '0') failures.push(`${label} retained a diagnostic incident`)
    if (facts.uncapturedErrors !== '0') failures.push(`${label} reported an uncaptured GPU error`)
    if (facts.deviceLosses !== '0') failures.push(`${label} reported device loss`)

    const operationCount = Number(facts.diagnosticOperations)
    const operationCapacity = Number(facts.diagnosticOperationCapacity)
    const evidenceBytes = Number(facts.diagnosticEvidenceBytes)
    const evidenceCapacity = Number(facts.diagnosticEvidenceByteCapacity)
    if (!Number.isSafeInteger(operationCount) || operationCount < 0 ||
        !Number.isSafeInteger(operationCapacity) || operationCapacity <= 0 ||
        operationCount > operationCapacity) {
        failures.push(`${label} operation history exceeded its bound`)
    }
    if (!Number.isSafeInteger(evidenceBytes) || evidenceBytes < 0 ||
        !Number.isSafeInteger(evidenceCapacity) || evidenceCapacity <= 0 ||
        evidenceBytes > evidenceCapacity) {
        failures.push(`${label} diagnostic evidence exceeded its bound`)
    }

    const stageActivity = parseJson(facts.stageActivity, `${label} stage activity`, failures)
    for (const name of expectedStageOrder) {
        if (stageActivity?.[name] !== Number(facts.frames)) {
            failures.push(`${label} ${name} activity did not match submitted frames`)
        }
    }
    const provenance = parseJson(facts.provenance, `${label} provenance`, failures)
    if (!Array.isArray(provenance) || provenance.length !== requiredProvenanceNames.length) {
        failures.push(`${label} provenance did not contain three chains`)
        return
    }
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
    }
}

function validatePersistentCounts(before, after, failures) {

    const first = parseJson(before.persistentFacts, 'before persistent facts', failures)
    const second = parseJson(after.persistentFacts, 'after persistent facts', failures)
    for (const [ name, expected ] of [
        [ 'resources', 15 ],
        [ 'bindLayouts', 10 ],
        [ 'bindSets', 12 ],
        [ 'pipelines', 7 ],
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
    if (result.proof?.scenario !== result.scenario || result.proof?.reachedCount !== 1) {
        failures.push(`${prefix} did not reach its boundary exactly once`)
    }
    if (result.proof?.workerAcquiredCount !== 1) {
        failures.push(`${prefix} did not acquire exactly one worker`)
    }
    validateCleanEvents(prefix, result, failures, 1)

    if (result.scenario === 'after-worker-acquisition') {
        if (result.proof?.primaryFailure?.code !== 'FLOW_LAYER_INJECTED_FAILURE') {
            failures.push(`${prefix} lost the injected primary failure`)
        }
        if (result.proof?.runtimeEvidence !== undefined || result.proof?.captureReport !== undefined) {
            failures.push(`${prefix} fabricated runtime evidence before runtime acquisition`)
        }
        validateCleanup(result.proof, [ 'flow-worker-listeners', 'flow-worker' ], failures)
        return
    }

    const proof = result.proof
    if (proof?.diagnostic?.code !== 'SCRATCH_PIPELINE_CREATION_MULTIPLE_FAILURES') {
        failures.push(`${prefix} did not retain the pipeline multiple-failure envelope`)
    }
    const target = proof?.incident?.target
    if (target?.kind !== 'pipeline' || target?.pipelineKind !== 'compute' ||
        typeof target?.pipelineId !== 'string' || typeof target?.programId !== 'string') {
        failures.push(`${prefix} did not localize the compute pipeline and Program`)
    }
    const compilation = proof?.incident?.compilationReport
    if (compilation?.pipelineId !== target?.pipelineId ||
        compilation?.programId !== target?.programId ||
        compilation?.moduleCount !== 1 ||
        compilation?.retainedModuleCount !== 1 ||
        compilation?.errorCount < 1) {
        failures.push(`${prefix} did not retain one localized module compilation report`)
    }
    const incidentText = JSON.stringify(proof?.incident)
    if (!incidentText.includes('SCRATCH_PIPELINE_SHADER_COMPILATION_FAILED')) {
        failures.push(`${prefix} omitted the stable shader compilation outcome`)
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
    const evidenceText = JSON.stringify(proof?.runtimeEvidence)
    if (evidenceText.includes('flowInjectedFailure') || /"source"\s*:/.test(evidenceText)) {
        failures.push(`${prefix} retained WGSL source`)
    }
    validateCleanup(proof, [
        'flow-worker-listeners',
        'flow-worker',
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

function parseJson(value, label, failures) {

    try {
        return JSON.parse(value)
    } catch {
        failures.push(`${label} was not valid JSON`)
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
