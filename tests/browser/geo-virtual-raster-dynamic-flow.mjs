import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import process from 'node:process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const examplesRoot = resolve(repositoryRoot, 'examples')
const fixturePath = resolve(
    repositoryRoot,
    'tests/fixtures/geo-virtual-raster-dynamic-flow.ts'
)
const viteEntry = resolve(repositoryRoot, 'node_modules/vite/bin/vite.js')
const timeout = positiveInteger(process.env.GEO_VIRTUAL_RASTER_FLOW_TIMEOUT_MS, 120_000)
const port = await findAvailablePort()
const baseUrl = `http://127.0.0.1:${port}`
const fixtureUrl = `${baseUrl}/@fs${fixturePath}`
const source = await readFile(fixturePath, 'utf8')
const sourceFacts = inspectSource(source)
const vite = startVite(port)
let browser
let browserVersion
let proof
let fatalError
const cleanupFailures = []

try {
    await waitForVite(vite)
    browser = await chromium.launch({
        channel: 'chrome',
        headless: false,
        args: [ '--enable-unsafe-webgpu' ],
    })
    browserVersion = await browser.version()
    const context = await browser.newContext()
    const page = await context.newPage()
    const events = observePage(page)
    try {
        await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout })
        proof = await page.evaluate(async(url) => {
            const fixture = await import(url)
            return await fixture.runGeoVirtualRasterDynamicFlowProof()
        }, fixtureUrl)
        proof.events = events
    } finally {
        await context.close()
    }
} catch (error) {
    fatalError = serializeError(error)
} finally {
    try {
        if (browser !== undefined) await withTimeout(browser.close(), 5_000, 'Chrome shutdown')
    } catch (error) {
        cleanupFailures.push(`Chrome cleanup failed: ${serializeError(error)}`)
    }
    try {
        await stopVite(vite)
    } catch (error) {
        cleanupFailures.push(`Vite cleanup failed: ${serializeError(error)}`)
    }
}

const processFacts = {
    browserClosed: browser === undefined || !browser.isConnected(),
    viteClosed: !await canConnect(port),
}
const failures = validate({ proof, sourceFacts, processFacts, fatalError, cleanupFailures })
const result = {
    schemaVersion: 1,
    status: failures.length === 0 ? 'passed' : 'failed',
    headed: true,
    browserVersion,
    baseUrl,
    fixtureUrl,
    proof,
    sourceFacts,
    processFacts,
    fatalError,
    cleanupFailures,
    failures,
    processOutput: failures.length === 0 ? undefined : {
        pid: vite.child.pid,
        exitCode: vite.child.exitCode,
        signalCode: vite.child.signalCode,
        stdout: vite.stdout,
        stderr: vite.stderr,
    },
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
if (failures.length > 0) process.exitCode = 1

function validate(value) {

    const failures = []
    if (value.fatalError !== undefined) failures.push(`browser proof failed: ${value.fatalError}`)
    failures.push(...value.cleanupFailures)
    if (!value.processFacts.browserClosed || !value.processFacts.viteClosed) {
        failures.push('managed Chrome or Vite remained reachable')
    }
    if (value.proof === undefined) {
        failures.push('dynamic Flow proof was not produced')
        return failures
    }
    const proof = value.proof
    if (proof.particleCount !== 262_144 || proof.positionEncoding !== 'cell-local-f32' ||
        proof.bytesPerPosition !== 16 || proof.particleStateBytes !== 4_194_304) {
        failures.push('canonical particle position contract drifted')
    }
    if (proof.logicalAddressBytesPersisted !== 0 ||
        proof.computeAddressMaterializationPassCount !== 0 ||
        proof.cpuParticleMirrorBytesPerStep !== 0 || proof.finalReadbackCount !== 1) {
        failures.push('proof retained a persistent address, CPU mirror, materialization pass, or extra readback')
    }
    if (JSON.stringify(proof.simulationLods) !== JSON.stringify([ 2, 2, 1, 1, 0, 0 ]) ||
        JSON.stringify(proof.requestedLodRange) !== JSON.stringify([ 0, 2 ]) ||
        proof.resolvedLodRange?.[0] !== 0 || proof.resolvedLodRange?.[1] !== 2) {
        failures.push('three-level simulation/request/residency LoD proof drifted')
    }
    if (JSON.stringify(proof.snapshotEpochs) !== JSON.stringify([ 2, 2, 2, 2, 3, 3 ])) {
        failures.push('simulation steps did not retain the expected frozen snapshot epochs')
    }
    if (!strictlyIncreasing(proof.positionEpochs) || proof.positionEpochs.length !== 6) {
        failures.push('canonical position content epochs did not advance exactly once per simulation step')
    }
    if (proof.cameraRequestEpochProofs?.length !== 2 ||
        proof.cameraRequestEpochProofs.some(entry => (
            entry.beforePositionEpoch !== entry.afterPositionEpoch
        ))) {
        failures.push('camera/request LoD updates changed canonical particle content')
    }
    const expectedSamples = proof.particleCount * proof.simulationStepCount
    if (proof.counters?.residentSamples <= 0 || proof.counters?.fallbackSamples <= 0 ||
        proof.counters.residentSamples + proof.counters.fallbackSamples !== expectedSamples ||
        proof.counters.cellTransitions <= 0 || proof.counters.pageTransitions <= 0) {
        failures.push('compute shader did not prove resident/fallback sampling and cell/page transitions')
    }
    if (proof.sampledPositions?.length !== 5 || proof.sampledPositions.some(position => (
        position.cells.some(cell => !Number.isSafeInteger(cell) || cell < 0 || cell >= 4_096) ||
        position.local.some(local => !Number.isFinite(local) || local < 0 || local >= 1 / 4_096)
    ))) {
        failures.push('final bounded readback contained an invalid canonical position')
    }
    if (!proof.stableIdentityPreserved || proof.stableIdentityCount !== 12) {
        failures.push('persistent compute graph identities changed')
    }
    if (proof.pageRequestCount !== 3 || proof.fallbackCount <= 0 ||
        proof.residency?.residentCount !== 3 || proof.residency?.pinnedCount !== 1 ||
        proof.residency?.stagedCount !== 0 ||
        proof.residency?.history?.length > 48 || proof.residency?.failedCount !== 0 ||
        proof.residency?.staleResponseCount !== 0 ||
        proof.residency?.stagingBytes !== 0 ||
        proof.residency?.stagingBytes > proof.residency?.maxStagingBytes) {
        failures.push('virtual vector field residency was not finite and clean')
    }
    if (proof.gpu?.snapshotEpoch !== 3 || proof.gpu?.maxPhysicalPages !== 5 ||
        proof.gpu?.pageTableEntryCount !== 21) {
        failures.push('GPU atlas/page-table facts drifted')
    }
    if (!(proof.coordinateErrorBound > 0) || proof.wrapPolicy !== 'none' ||
        !proof.supportedOperations?.includes('camera-relative-difference')) {
        failures.push('coordinate precision facts were incomplete')
    }
    if (proof.diagnostics?.retainedIncidentCount !== 0 ||
        proof.diagnostics?.uncapturedErrors !== 0 || proof.diagnostics?.deviceLosses !== 0 ||
        proof.diagnostics?.currentPendingNativeObservations !== 0 ||
        proof.diagnostics?.currentEffectfulSubmittedWork !== 0 ||
        proof.diagnostics?.activeReadbacks !== 0 ||
        proof.diagnostics?.activeReadbackCommands !== 0 ||
        proof.diagnostics?.retainedOperationCount > proof.diagnostics?.operationCapacity) {
        failures.push('Scratch diagnostics did not converge within finite bounds')
    }
    if (proof.events.consoleFailures.length !== 0 || proof.events.consoleWarnings.length !== 0 ||
        proof.events.pageErrors.length !== 0 || proof.events.requestFailures.length !== 0 ||
        proof.events.httpFailures.length !== 0) {
        failures.push('browser emitted an unexpected console, page, or network failure')
    }
    if (value.sourceFacts.readbackCreationCount !== 1 ||
        value.sourceFacts.computePipelineCount !== 1 ||
        value.sourceFacts.dispatchCommandCount !== 1 ||
        value.sourceFacts.rawDeviceAccessCount !== 0 ||
        value.sourceFacts.rawQueueAccessCount !== 0 ||
        value.sourceFacts.bufferCreationCount !== 2 ||
        value.sourceFacts.modifiesVisibleFlowLayer) {
        failures.push('fixture source violated the clean public-API execution boundary')
    }
    return failures
}

function inspectSource(value) {

    return Object.freeze({
        readbackCreationCount: occurrences(value, 'createReadback({'),
        computePipelineCount: occurrences(value, 'createComputePipeline({'),
        dispatchCommandCount: occurrences(value, 'createDispatchCommand({'),
        rawDeviceAccessCount: occurrences(value, 'runtime.device'),
        rawQueueAccessCount: occurrences(value, 'runtime.queue'),
        bufferCreationCount: occurrences(value, 'runtime.createBuffer({'),
        modifiesVisibleFlowLayer: value.includes('examples/flowLayer'),
    })
}

function observePage(page) {

    const events = {
        consoleFailures: [],
        consoleWarnings: [],
        pageErrors: [],
        requestFailures: [],
        httpFailures: [],
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
    return events
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

async function waitForVite(state) {

    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
        if (state.spawnError !== undefined) throw state.spawnError
        if (state.child.exitCode !== null) {
            throw new Error(`Vite exited before readiness with code ${state.child.exitCode}`)
        }
        try {
            const response = await fetch(baseUrl, { signal: AbortSignal.timeout(1_000) })
            const ready = response.ok
            await response.body?.cancel()
            if (ready) return
        } catch {
            // Managed Vite is still starting.
        }
        await delay(100)
    }
    throw new Error(`Timed out waiting for Vite at ${baseUrl}`)
}

async function stopVite(state) {

    if (state.child.exitCode !== null || state.child.signalCode !== null) return
    state.child.kill('SIGTERM')
    try {
        await waitForExit(state.child, 5_000)
    } catch {
        state.child.kill('SIGKILL')
        await waitForExit(state.child, 5_000)
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

async function canConnect(selectedPort) {

    return await new Promise(resolvePromise => {
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

function strictlyIncreasing(values) {

    return Array.isArray(values) && values.every((value, index) => (
        index === 0 || value === values[index - 1] + 1
    ))
}

function occurrences(value, token) {

    return value.split(token).length - 1
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
