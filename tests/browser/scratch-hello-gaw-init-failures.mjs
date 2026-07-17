import { spawn } from 'node:child_process'
import { createConnection, createServer } from 'node:net'
import process from 'node:process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const examplesRoot = resolve(repositoryRoot, 'examples')
const viteEntry = resolve(repositoryRoot, 'node_modules/vite/bin/vite.js')
const timeout = positiveInteger(process.env.HELLO_GAW_FAILURE_BROWSER_TIMEOUT_MS, 90_000)
const postProofQuietMs = 250
const expectedRuntimeEvidenceMaxBytes = 512 * 1024
const expectedRecorderBounds = Object.freeze({
    operationCapacity: 256,
    incidentCapacity: 32,
    evidenceByteCapacity: 256 * 1024,
})
const expectedCaptureBounds = Object.freeze({
    maxOperations: 1,
    maxDurationMs: 2_000,
    maxEvidenceBytes: 64 * 1024,
    includeStacks: true,
    includeDescriptors: true,
})
const expectedCompilationEvidenceMaxBytes = 64 * 1024
const port = process.env.HELLO_GAW_FAILURE_BROWSER_PORT === undefined
    ? await findAvailablePort()
    : positiveInteger(process.env.HELLO_GAW_FAILURE_BROWSER_PORT)
const baseUrl = `http://127.0.0.1:${port}`
const scenarios = Object.freeze([
    'after-runtime-created',
    'after-first-image-decoded',
    'invalid-bloom-pipeline-wgsl',
    'after-graph-created',
    'after-initial-submit-issued',
])
const expectedBitmapCounts = Object.freeze({
    'after-runtime-created': 0,
    'after-first-image-decoded': 1,
    'invalid-bloom-pipeline-wgsl': 8,
    'after-graph-created': 8,
    'after-initial-submit-issued': 8,
})

const vite = startVite(port)
let browser
let browserVersion
let adapter
let scenarioResults = []
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
    adapter = await readAdapterFacts(browser)
    scenarioResults = await verifyScenarios(browser)
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
    scenarioResults,
    fatalError,
    cleanupError,
    serverClosed,
})
const result = {
    schemaVersion: 1,
    browserVersion,
    headed: true,
    baseUrl,
    vite: {
        pid: vite.child.pid,
        exitCode: vite.child.exitCode,
        signalCode: vite.child.signalCode,
        serverClosed,
        stdout: failures.length === 0 ? undefined : vite.stdout,
        stderr: failures.length === 0 ? undefined : vite.stderr,
    },
    adapter,
    scenarios: scenarioResults.map(summarizeScenarioResult),
    fatalError,
    cleanupError,
    status: failures.length === 0 ? 'passed' : 'failed',
    failures,
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
if (failures.length > 0) process.exitCode = 1

async function verifyScenarios(activeBrowser) {

    const results = []
    for (const scenario of scenarios) {
        try {
            results.push(await verifyScenario(activeBrowser, scenario))
        } catch (error) {
            results.push({ scenario, fatalError: serializeError(error) })
        }
    }
    return results
}

async function verifyScenario(activeBrowser, scenario) {

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
    await page.addInitScript(() => {
        window.__HELLO_GAW_UNHANDLED_REJECTIONS__ = []
        window.addEventListener('unhandledrejection', (event) => {
            const reason = event.reason
            window.__HELLO_GAW_UNHANDLED_REJECTIONS__.push(
                reason instanceof Error ? reason.stack ?? reason.message : String(reason)
            )
        })
    })
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
        const url = `${baseUrl}/helloGAW/index.html?proof=1&fault=${encodeURIComponent(scenario)}`
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout })
        await page.waitForFunction(() => {
            const canvas = document.querySelector('#GPUFrame')
            return canvas?.dataset.status === 'error' &&
                window.__HELLO_GAW_INIT_FAILURE_PROOF__ !== undefined
        }, undefined, { timeout })
        await page.waitForTimeout(postProofQuietMs)

        const observed = await page.evaluate(() => {
            const proof = window.__HELLO_GAW_INIT_FAILURE_PROOF__
            const canvas = document.querySelector('#GPUFrame')
            const datasetProof = JSON.parse(canvas.dataset.initFailureProof)
            const visited = new WeakSet()
            const isDeepFrozen = value => {
                if (value === null || typeof value !== 'object' || visited.has(value)) return true
                visited.add(value)
                return Object.isFrozen(value) && Object.values(value).every(isDeepFrozen)
            }
            return {
                proof,
                datasetProof,
                deepFrozen: isDeepFrozen(proof),
                status: canvas.dataset.status,
                error: canvas.dataset.error,
                failureScenario: canvas.dataset.failureScenario,
                unhandledRejections: [ ...(window.__HELLO_GAW_UNHANDLED_REJECTIONS__ ?? []) ],
            }
        })

        return {
            scenario,
            ...observed,
            consoleFailures,
            consoleWarnings,
            pageErrors,
            requestFailures,
            httpFailures,
        }
    } finally {
        await context.close()
    }
}

async function readAdapterFacts(activeBrowser) {

    const context = await activeBrowser.newContext()
    const page = await context.newPage()
    try {
        await page.goto(`${baseUrl}/index.html`, {
            waitUntil: 'domcontentloaded',
            timeout,
        })
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
            }
        })
    } finally {
        await context.close()
    }
}

function validateResult(result) {

    const failures = []
    if (result.fatalError !== undefined) failures.push(`browser probe failed: ${result.fatalError}`)
    if (result.cleanupError !== undefined) failures.push(`cleanup failed: ${result.cleanupError}`)
    if (!result.serverClosed) failures.push(`managed Vite port ${port} remained open after cleanup`)
    if (result.adapter?.available !== true) failures.push('navigator.gpu was unavailable')
    if (result.adapter?.adapterAvailable !== true) failures.push('WebGPU adapter was unavailable')
    if (result.scenarioResults.length !== scenarios.length) {
        failures.push(`expected ${scenarios.length} scenario results`)
    }
    for (const resultForScenario of result.scenarioResults) {
        validateScenario(resultForScenario, failures)
    }
    return failures
}

function validateScenario(result, failures) {

    const label = result.scenario
    const fail = message => failures.push(`${label}: ${message}`)
    if (result.fatalError !== undefined) {
        fail(`probe failed: ${result.fatalError}`)
        return
    }
    const proof = result.proof
    if (proof === undefined) {
        fail('proof was missing')
        return
    }
    if (result.status !== 'error') fail(`page status was ${result.status}`)
    if (result.failureScenario !== label) fail('dataset scenario did not match')
    if (!result.deepFrozen) fail('proof was not recursively frozen')
    if (JSON.stringify(result.datasetProof) !== JSON.stringify(proof)) {
        fail('dataset JSON differed from the frozen global proof')
    }
    if (proof.schemaVersion !== 1) fail(`schema version was ${proof.schemaVersion}`)
    if (proof.scenario !== label) fail(`proof scenario was ${proof.scenario}`)
    if (proof.reachedCount !== 1) fail(`fault reach count was ${proof.reachedCount}`)
    if (proof.evidenceFailure !== undefined) fail('runtime evidence collection failed')
    if (result.pageErrors.length > 0) fail('browser emitted page errors')
    if (result.requestFailures.length > 0) fail('browser emitted request failures')
    if (result.httpFailures.length > 0) fail('browser received HTTP 4xx/5xx responses')
    if (result.consoleFailures.length !== 1) {
        fail(`expected one primary console error, received ${result.consoleFailures.length}`)
    }
    if (result.consoleWarnings.length > 0) fail('browser emitted console warnings')
    if (result.unhandledRejections.length > 0) fail('browser emitted unhandled promise rejections')

    if (label === 'invalid-bloom-pipeline-wgsl') {
        validateInvalidPipelineProof(proof, fail)
    } else {
        if (proof.primaryFailure?.name !== 'HelloGawInjectedFailure') {
            fail(`primary failure was ${proof.primaryFailure?.name}`)
        }
        if (proof.primaryFailure?.code !== 'HELLO_GAW_INJECTED_FAILURE') {
            fail(`primary failure code was ${proof.primaryFailure?.code}`)
        }
        if (proof.primaryFailure?.scenario !== label) {
            fail(`primary failure scenario was ${proof.primaryFailure?.scenario}`)
        }
        if (proof.captureReport !== undefined) fail('unexpected deep capture report was retained')
        if ((proof.runtimeEvidence?.incidents?.length ?? -1) !== 0) {
            fail('injected application failure retained a Scratch incident')
        }
    }

    validateRuntimeEvidence(proof.runtimeEvidence, fail)
    const runtimeEvidenceByteLength = Buffer.byteLength(
        JSON.stringify(proof.runtimeEvidence),
        'utf8'
    )
    if (proof.runtimeEvidenceByteLength !== runtimeEvidenceByteLength) {
        fail('published runtime evidence byte length did not match the JSON payload')
    }
    if (proof.runtimeEvidenceMaxBytes !== expectedRuntimeEvidenceMaxBytes) {
        fail(`runtime evidence maximum was ${proof.runtimeEvidenceMaxBytes}`)
    } else if (runtimeEvidenceByteLength > expectedRuntimeEvidenceMaxBytes) {
        fail('runtime evidence JSON exceeded its published maximum byte bound')
    }
    validateCleanup(proof.cleanup, label, fail)
}

function validateRuntimeEvidence(evidence, fail) {

    if (evidence?.version !== 5) {
        fail(`runtime evidence version was ${evidence?.version}`)
        return
    }
    const recorder = evidence.snapshot?.recorder
    for (const name of [
        'operationCapacity',
        'incidentCapacity',
        'evidenceByteCapacity',
        'retainedOperationCount',
        'retainedIncidentCount',
        'retainedEvidenceBytes',
    ]) {
        if (!Number.isSafeInteger(recorder?.[name]) || recorder[name] < 0) {
            fail(`runtime evidence recorder ${name} was invalid`)
        }
    }
    if (recorder !== undefined && (
        recorder.retainedOperationCount > recorder.operationCapacity ||
        recorder.retainedIncidentCount > recorder.incidentCapacity ||
        recorder.retainedEvidenceBytes > recorder.evidenceByteCapacity
    )) {
        fail('runtime evidence exceeded a configured retention bound')
    }
    for (const [ name, expected ] of Object.entries(expectedRecorderBounds)) {
        if (recorder?.[name] !== expected) {
            fail(`runtime evidence recorder ${name} was ${recorder?.[name]}`)
        }
    }
    if (evidence.snapshot?.capture?.activeCount !== 0) {
        fail('diagnostic capture remained active at export')
    }
}

function validateCleanup(cleanup, scenario, fail) {

    if (cleanup?.runtime?.created !== true) fail('runtime ownership was not recorded')
    if (cleanup?.runtime?.disposeAttempts !== 1) {
        fail(`runtime dispose attempts were ${cleanup?.runtime?.disposeAttempts}`)
    }
    if (cleanup?.runtime?.disposed !== true) fail('runtime was not disposed')
    const expectedSurface = scenario !== 'after-runtime-created'
    if (cleanup?.surface?.created !== expectedSurface) {
        fail(`surface creation fact was ${cleanup?.surface?.created}`)
    }
    if (cleanup?.surface?.disposed !== expectedSurface) {
        fail(`surface disposal fact was ${cleanup?.surface?.disposed}`)
    }

    const expectedBitmaps = expectedBitmapCounts[scenario]
    if (cleanup?.bitmaps?.created !== expectedBitmaps) {
        fail(`created bitmap count was ${cleanup?.bitmaps?.created}`)
    }
    if (cleanup?.bitmaps?.closeAttempts !== expectedBitmaps) {
        fail(`bitmap close attempt count was ${cleanup?.bitmaps?.closeAttempts}`)
    }
    if (cleanup?.bitmaps?.closed !== expectedBitmaps) {
        fail(`closed bitmap count was ${cleanup?.bitmaps?.closed}`)
    }
    if (cleanup?.bitmaps?.duplicateCloseAttempts !== 0) {
        fail('a bitmap close was attempted more than once')
    }

    const expectedPending = scenario === 'after-initial-submit-issued' ? 1 : 0
    if (cleanup?.pendingObservations?.before !== expectedPending) {
        fail(`pending observations before cleanup were ${cleanup?.pendingObservations?.before}`)
    }
    if (cleanup?.pendingObservations?.after !== 0) {
        fail(`pending observations after cleanup were ${cleanup?.pendingObservations?.after}`)
    }
    for (const name of [ 'registered', 'removed', 'activeBefore', 'activeAfter' ]) {
        if (cleanup?.listeners?.[name] !== 0) fail(`listener ${name} count was not zero`)
    }
    for (const name of [ 'scheduled', 'completed', 'cancelled', 'activeBefore', 'activeAfter' ]) {
        if (cleanup?.frameWork?.[name] !== 0) fail(`frame work ${name} count was not zero`)
    }
    if (cleanup?.invocationCount !== 1) fail(`cleanup invocation count was ${cleanup?.invocationCount}`)
    if (cleanup?.actionCount !== expectedBitmaps + 1) {
        fail(`cleanup action count was ${cleanup?.actionCount}`)
    }
    if (cleanup?.retainedActionCount !== 0) fail('cleanup retained action references')
    if (!Array.isArray(cleanup?.failures) || cleanup.failures.length !== 0) {
        fail('cleanup retained one or more failures')
    }
}

function validateInvalidPipelineProof(proof, fail) {

    if (proof.primaryFailure?.name !== 'ScratchDiagnosticError') {
        fail(`primary failure was ${proof.primaryFailure?.name}`)
    }
    if (proof.incident?.kind !== 'pipeline-failure') fail('pipeline incident was missing')
    const compilationOutcome = proof.incident?.outcomes?.find(outcome => (
        outcome.diagnosticCode === 'SCRATCH_PIPELINE_SHADER_COMPILATION_FAILED' &&
        outcome.stage === 'shader-compilation'
    ))
    if (compilationOutcome === undefined) {
        fail('pipeline incident did not retain SCRATCH_PIPELINE_SHADER_COMPILATION_FAILED')
    }

    const capture = proof.captureReport
    if (JSON.stringify(proof.captureBounds) !== JSON.stringify(expectedCaptureBounds)) {
        fail('capture bounds differed from the fixed verifier contract')
    }
    if (capture?.version !== 5) fail(`capture version was ${capture?.version}`)
    if (capture?.stopReason !== 'operation-limit') {
        fail(`capture stop reason was ${capture?.stopReason}`)
    }
    if (capture?.operations?.length !== 1) {
        fail(`capture retained ${capture?.operations?.length} operations`)
        return
    }
    if (capture.omittedOperations !== 0) {
        fail(`capture omitted ${capture.omittedOperations} operations`)
    }
    if (!Number.isSafeInteger(capture.retainedEvidenceBytes) ||
        capture.retainedEvidenceBytes > expectedCaptureBounds.maxEvidenceBytes) {
        fail(`capture retained ${capture.retainedEvidenceBytes} evidence bytes`)
    }
    const captureDurationMs = capture.stoppedAtMs - capture.startedAtMs
    if (!Number.isFinite(captureDurationMs) || captureDurationMs < 0 ||
        captureDurationMs > expectedCaptureBounds.maxDurationMs) {
        fail(`capture duration was ${captureDurationMs} ms`)
    }

    const operation = capture.operations[0]
    const compilation = operation.compilationReport
    if (operation.kind !== 'compute-pipeline-creation') {
        fail(`captured operation kind was ${operation.kind}`)
    }
    if (operation.status !== 'failed') fail(`captured operation status was ${operation.status}`)
    if (typeof operation.target?.pipelineId !== 'string') fail('pipeline identity was missing')
    if (typeof operation.target?.programId !== 'string') fail('program identity was missing')
    if (operation.target?.pipelineKind !== 'compute') fail('pipeline kind was not compute')
    if (compilation?.pipelineId !== operation.target?.pipelineId) {
        fail('compilation report pipeline identity did not match')
    }
    if (compilation?.programId !== operation.target?.programId) {
        fail('compilation report program identity did not match')
    }
    if (!(compilation?.errorCount > 0)) fail('compilation report had no error')
    if (!Number.isSafeInteger(compilation?.retainedEvidenceBytes) ||
        compilation.retainedEvidenceBytes > expectedCompilationEvidenceMaxBytes) {
        fail(`compilation retained ${compilation?.retainedEvidenceBytes} evidence bytes`)
    }
    if (compilation?.omittedModuleCount !== 0 || compilation?.omittedMessageCount !== 0) {
        fail('compilation evidence omitted module or message facts')
    }
    if (compilation?.moduleCount !== 1 || compilation?.modules?.length !== 1) {
        fail('compilation report did not identify the failing module')
    }
    if (typeof compilation?.modules?.[0]?.hash !== 'string') fail('module hash was missing')
    if (!compilation?.messages?.some(message => message.moduleLocation?.moduleIndex === 0)) {
        fail('compilation message was not mapped to module zero')
    }
    if (proof.incident?.target?.pipelineId !== operation.target?.pipelineId) {
        fail('incident pipeline identity did not match the capture')
    }
    if (proof.incident?.target?.programId !== operation.target?.programId) {
        fail('incident program identity did not match the capture')
    }
    const evidenceJson = JSON.stringify({
        diagnostic: proof.diagnostic,
        incident: proof.incident,
        runtimeEvidence: proof.runtimeEvidence,
        captureReport: proof.captureReport,
    })
    if (evidenceJson.includes('helloGawInjectedFailure')) {
        fail('diagnostic evidence leaked injected WGSL source')
    }
}

function summarizeScenarioResult(result) {

    if (result.fatalError !== undefined) return result
    const proof = result.proof
    const recorder = proof?.runtimeEvidence?.snapshot?.recorder
    return {
        scenario: result.scenario,
        status: result.status,
        deepFrozen: result.deepFrozen,
        primaryFailure: proof?.primaryFailure,
        diagnosticCode: proof?.diagnostic?.code,
        incident: proof?.incident === undefined ? undefined : {
            kind: proof.incident.kind,
            diagnosticCode: proof.incident.diagnosticCode,
            failureStage: proof.incident.failureStage,
            outcomes: proof.incident.outcomes?.map(outcome => ({
                stage: outcome.stage,
                diagnosticCode: outcome.diagnosticCode,
                nativeErrorCategory: outcome.nativeErrorCategory,
            })),
        },
        runtimeEvidence: {
            version: proof?.runtimeEvidence?.version,
            serializedBytes: proof?.runtimeEvidenceByteLength,
            maxSerializedBytes: proof?.runtimeEvidenceMaxBytes,
            operationCount: proof?.runtimeEvidence?.operations?.length,
            incidentCount: proof?.runtimeEvidence?.incidents?.length,
            recorder,
        },
        capture: proof?.captureReport === undefined ? undefined : {
            bounds: proof.captureBounds,
            version: proof.captureReport.version,
            stopReason: proof.captureReport.stopReason,
            durationMs: proof.captureReport.stoppedAtMs - proof.captureReport.startedAtMs,
            operationCount: proof.captureReport.operations.length,
            retainedEvidenceBytes: proof.captureReport.retainedEvidenceBytes,
            omittedOperations: proof.captureReport.omittedOperations,
            operations: proof.captureReport.operations.map(operation => ({
                kind: operation.kind,
                status: operation.status,
                target: operation.target,
                compilation: operation.compilationReport === undefined ? undefined : {
                    moduleCount: operation.compilationReport.moduleCount,
                    retainedModuleCount: operation.compilationReport.retainedModuleCount,
                    errorCount: operation.compilationReport.errorCount,
                    retainedMessageCount: operation.compilationReport.retainedMessageCount,
                    retainedEvidenceBytes: operation.compilationReport.retainedEvidenceBytes,
                },
            })),
        },
        cleanup: proof?.cleanup,
        browserEvents: {
            consoleErrors: result.consoleFailures.length,
            consoleWarnings: result.consoleWarnings.length,
            pageErrors: result.pageErrors.length,
            requestFailures: result.requestFailures.length,
            httpFailures: result.httpFailures.length,
            unhandledRejections: result.unhandledRejections.length,
        },
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

async function waitForVite(viteState, url) {

    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
        if (viteState.spawnError !== undefined) throw viteState.spawnError
        if (viteState.child.exitCode !== null) {
            throw new Error(`Vite exited before readiness with code ${viteState.child.exitCode}.`)
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

async function stopVite(viteState) {

    if (viteState.child.exitCode !== null || viteState.child.signalCode !== null) return
    viteState.child.kill('SIGTERM')
    try {
        await waitForExit(viteState.child, 5_000)
    } catch {
        viteState.child.kill('SIGKILL')
        await waitForExit(viteState.child, 5_000)
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
