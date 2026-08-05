import { spawn } from 'node:child_process'
import { createConnection, createServer } from 'node:net'
import process from 'node:process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const examplesRoot = resolve(repositoryRoot, 'examples')
const fixturePath = resolve(repositoryRoot, 'tests/fixtures/scratch-persistent-cache.ts')
const viteEntry = resolve(repositoryRoot, 'node_modules/vite/bin/vite.js')
const timeout = positiveInteger(process.env.SCRATCH_PERSISTENT_CACHE_TIMEOUT_MS, 60_000)
const port = await findAvailablePort()
const baseUrl = `http://127.0.0.1:${port}`
const fixtureUrl = `${baseUrl}/@fs${fixturePath}`
const namespace = `geoscratch-cache-browser-${port}-${Date.now()}`
const vite = startVite(port)
let browser
let browserVersion
let proof
let fatalError
const cleanupFailures = []

try {
    await waitForVite(vite)
    browser = await chromium.launch({ channel: 'chrome', headless: true })
    browserVersion = await browser.version()
    const context = await browser.newContext()
    const page = await context.newPage()
    const events = observePage(page)
    try {
        await page.goto(`${baseUrl}/helloTriangle/index.html`, {
            waitUntil: 'domcontentloaded',
            timeout,
        })
        const first = await page.evaluate(async({ url, cacheNamespace }) => {
            const fixture = await import(url)
            return await fixture.prepareScratchPersistentCacheProof(cacheNamespace)
        }, { url: fixtureUrl, cacheNamespace: namespace })
        await page.reload({ waitUntil: 'domcontentloaded', timeout })
        const second = await page.evaluate(async({ url, cacheNamespace }) => {
            const fixture = await import(url)
            return await fixture.finishScratchPersistentCacheProof(cacheNamespace)
        }, { url: fixtureUrl, cacheNamespace: namespace })
        proof = { first, second, events }
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
const failures = validate({ proof, processFacts, fatalError, cleanupFailures })
const result = {
    schemaVersion: 1,
    status: failures.length === 0 ? 'passed' : 'failed',
    browserVersion,
    baseUrl,
    fixtureUrl,
    namespace,
    proof,
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
        failures.push('Scratch persistent cache browser proof was not produced')
        return failures
    }
    const { first, second, events } = value.proof
    if (first.stored?.status !== 'stored' || first.immutable?.status !== 'already-present' ||
        first.metadataOnly?.status !== 'stored' || first.oversize?.status !== 'too-large') {
        failures.push('write outcomes did not preserve immutable entries or hard budgets')
    }
    if (first.immediate?.status !== 'hit' || first.immediate.byteLength !== 4 ||
        JSON.stringify(first.immediate.payload) !== JSON.stringify([ 1, 2, 3, 4 ])) {
        failures.push('put did not snapshot raw caller bytes before persistence')
    }
    if (first.beforeDispose?.entryCount !== 2 || first.beforeDispose.payloadBytes !== 4 ||
        first.beforeDispose.metadataOnlyEntryCount !== 1 ||
        first.beforeDispose.persistenceRequested !== true ||
        typeof first.beforeDispose.persisted !== 'boolean' ||
        first.beforeDispose.history?.length > 32 || first.disposeIdentity !== true ||
        first.afterDispose?.state !== 'disposed' || first.afterDispose.activeOperationCount !== 0) {
        failures.push('persistent facts or idempotent terminal lifecycle did not converge')
    }
    if (first.budget?.first?.status !== 'hit' || first.budget?.second?.status !== 'miss' ||
        first.budget?.third?.status !== 'hit' ||
        first.budget?.thirdWrite?.evictedCount !== 1 ||
        first.budget?.facts?.entryCount !== 2 || first.budget.facts.payloadBytes !== 8 ||
        first.budget.facts.evictionCount !== 1) {
        failures.push('byte and entry budgets did not apply deterministic LRU eviction')
    }
    if (second.rawReload?.status !== 'hit' || second.rawReload.byteLength !== 4 ||
        JSON.stringify(second.rawReload.payload) !== JSON.stringify([ 1, 2, 3, 4 ]) ||
        second.metadataReload?.status !== 'hit' || second.metadataReload.payload !== undefined ||
        second.revisionMiss?.status !== 'miss' || second.revisionMiss.reason !== 'absent') {
        failures.push('reload, metadata-only, or immutable revision reads were incorrect')
    }
    if (second.invalidated?.deletedCount !== 2 || second.invalidated.releasedBytes !== 8 ||
        second.garbage?.removedPayloadCount !== 1 ||
        second.garbage.removedPendingCount !== 0 ||
        second.garbage.cleanupFailureCount !== 0) {
        failures.push('prefix invalidation or explicit OPFS garbage collection was incorrect')
    }
    if (second.beforeClear?.entryCount !== 3 || second.beforeClear.payloadBytes !== 8 ||
        second.cleared?.deletedCount !== 3 || second.cleared.releasedBytes !== 8 ||
        second.afterClear?.entryCount !== 0 || second.afterClear.payloadBytes !== 0 ||
        second.disposedCode !== 'CACHE_DISPOSED') {
        failures.push('clear or post-dispose diagnostic behavior did not converge')
    }
    if (events.consoleFailures.length !== 0 || events.consoleWarnings.length !== 0 ||
        events.pageErrors.length !== 0 || events.requestFailures.length !== 0 ||
        events.httpFailures.length !== 0) {
        failures.push('browser emitted an unexpected console, page, or network failure')
    }
    return failures
}

function observePage(page) {

    const events = {
        consoleFailures: [],
        consoleWarnings: [],
        pageErrors: [],
        requestFailures: [],
        httpFailures: [],
    }
    page.on('console', message => {
        if (message.type() === 'error') pushBounded(events.consoleFailures, message.text())
        if (message.type() === 'warning') pushBounded(events.consoleWarnings, message.text())
    })
    page.on('pageerror', error => pushBounded(events.pageErrors, serializeError(error)))
    page.on('requestfailed', request => pushBounded(
        events.requestFailures,
        `${request.method()} ${request.url()}: ${request.failure()?.errorText ?? 'unknown'}`
    ))
    page.on('response', response => {
        if (response.status() >= 400) pushBounded(events.httpFailures, `${response.status()} ${response.url()}`)
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
            await response.body?.cancel()
            if (response.ok) return
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
            socket.destroy()
            resolvePromise(connected)
        }
        socket.setTimeout(500)
        socket.once('connect', () => settle(true))
        socket.once('timeout', () => settle(false))
        socket.once('error', () => settle(false))
    })
}

function withTimeout(promise, milliseconds, label) {

    return Promise.race([
        promise,
        new Promise((_, rejectPromise) => {
            setTimeout(() => rejectPromise(new Error(`${label} timed out`)), milliseconds)
        }),
    ])
}

function delay(milliseconds) {
    return new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds))
}

function positiveInteger(value, fallback) {

    const parsed = Number(value ?? fallback)
    if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new TypeError('Timeout must be positive.')
    return parsed
}

function pushBounded(target, value) {
    if (target.length < 16) target.push(value)
}

function appendBounded(current, value) {
    return `${current}${value}`.slice(-16_384)
}

function serializeError(error) {
    return error instanceof Error ? error.stack ?? error.message : String(error)
}
