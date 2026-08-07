import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const examplesRoot = resolve(repositoryRoot, 'examples')
const tileServerRoot = resolve(examplesRoot, 'demLayer/tile-server')
const viteEntry = resolve(repositoryRoot, 'node_modules/vite/bin/vite.js')
const tileBuildEntry = resolve(tileServerRoot, '.venv/bin/dem-tile-build')
const tileServeEntry = resolve(tileServerRoot, '.venv/bin/dem-tile-serve')
const timeout = positiveInteger(process.env.DEM_CACHE_PANEL_TIMEOUT_MS, 90_000)
const headless = process.env.GEO_VIRTUAL_RASTER_DEM_HEADLESS === '1'
const outputDirectory = resolve(
    process.env.DEM_CACHE_PANEL_OUTPUT ?? '/tmp/geoscratch-dem-cache-panel'
)
const storageKey = 'geoscratch.examples.dem.cache-panel.v1'
const namespace = `geoscratch-dem-panel-proof-${Date.now()}`
const vitePort = await findAvailablePort()
let tilePort = await findAvailablePort()
while (tilePort === vitePort) tilePort = await findAvailablePort()
const baseUrl = `http://127.0.0.1:${vitePort}`
const tileBaseUrl = `http://127.0.0.1:${tilePort}`

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
    await waitForHttpProcess(vite, `${baseUrl}/demLayer/`, 'Vite')
    browser = await chromium.launch({
        channel: 'chrome',
        headless,
        args: [ '--enable-unsafe-webgpu' ],
    })
    browserVersion = await browser.version()
    proof = {
        desktop: await runDesktopProof(browser),
        mobile: await runMobileProof(browser),
        unavailableStorage: await runUnavailableStorageProof(browser),
    }
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
failures.push(...cleanupFailures)
const result = {
    schemaVersion: 1,
    status: failures.length === 0 ? 'passed' : 'failed',
    headed: !headless,
    browserVersion,
    baseUrl,
    tileBaseUrl,
    outputDirectory,
    sourceHash: parseBuildHash(build?.stdout),
    proof,
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

async function runDesktopProof(activeBrowser) {

    const context = await activeBrowser.newContext({
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
    })
    const page = await context.newPage()
    const events = observePage(page)
    try {
        await page.goto(demUrl(), { waitUntil: 'domcontentloaded', timeout })
        await waitForReady(page)
        const initial = await readState(page)
        const initialLayout = await inspectLayout(page)
        const initialCapture = await capture(page, 'desktop-default')

        await page.locator('[data-dem-cache-control="policy"] select')
            .selectOption({ label: 'Durable' })
        await page.locator('#DemCachePanel[data-cache-dirty="true"]').waitFor({ timeout })
        await page.locator('[data-dem-cache-control="advanced"] > button').click()
        await replaceInput(page, 'namespace', namespace)
        await replaceInput(page, 'max-mib', '256')
        await replaceInput(page, 'max-entries', '4096')
        await page.locator('[data-dem-cache-control="persistence"] select')
            .selectOption({ label: 'Request' })
        await page.locator('#DemCachePanel[data-cache-valid="true"][data-cache-dirty="true"]')
            .waitFor({ timeout })
        const draft = await readState(page)
        const expandedLayout = await inspectLayout(page)

        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout }),
            page.locator('[data-dem-cache-control="apply"] button').click(),
        ])
        await waitForReady(page)
        const applied = await readState(page)
        await page.locator('[data-dem-cache-control="advanced"] > button').click()
        const appliedCapture = await capture(page, 'desktop-applied')

        await page.goto(demUrl(), { waitUntil: 'domcontentloaded', timeout })
        await waitForReady(page)
        const restored = await readState(page)

        await page.goto(demUrl('cache=none'), { waitUntil: 'domcontentloaded', timeout })
        await waitForReady(page)
        const overridden = await readState(page)

        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout }),
            page.locator('[data-dem-cache-control="reset"] button').click(),
        ])
        await waitForReady(page)
        const reset = await readState(page)
        return {
            initial,
            draft,
            applied,
            restored,
            overridden,
            reset,
            layouts: { initial: initialLayout, expanded: expandedLayout },
            captures: { initial: initialCapture, applied: appliedCapture },
            events,
        }
    } finally {
        await context.close()
    }
}

async function runMobileProof(activeBrowser) {

    const context = await activeBrowser.newContext({
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 1,
    })
    const page = await context.newPage()
    const events = observePage(page)
    try {
        await page.goto(demUrl('cache=none'), { waitUntil: 'domcontentloaded', timeout })
        await waitForReady(page)
        return {
            state: await readState(page),
            layout: await inspectLayout(page),
            capture: await capture(page, 'mobile-collapsed'),
            events,
        }
    } finally {
        await context.close()
    }
}

async function runUnavailableStorageProof(activeBrowser) {

    const context = await activeBrowser.newContext({
        viewport: { width: 960, height: 720 },
        deviceScaleFactor: 1,
    })
    await context.addInitScript(() => {
        Object.defineProperty(window, 'localStorage', {
            configurable: true,
            get() {
                throw new DOMException('localStorage denied by proof', 'SecurityError')
            },
        })
    })
    const page = await context.newPage()
    const events = observePage(page)
    try {
        const cacheQuery = new URLSearchParams({
            cache: 'persistent',
            cacheLifecycle: 'session',
            cacheNamespace: `${namespace}-unavailable`,
            cacheMaxMiB: '64',
            cacheMaxEntries: '512',
            cachePersistence: 'best-effort',
        }).toString()
        await page.goto(demUrl(cacheQuery), { waitUntil: 'domcontentloaded', timeout })
        await waitForReady(page)
        return {
            state: await readState(page, { includeStorage: false }),
            events,
        }
    } finally {
        await context.close()
    }
}

function demUrl(cacheQuery = '') {

    const parameters = new URLSearchParams(cacheQuery)
    parameters.set('proof', '1')
    parameters.set('tileServer', tileBaseUrl)
    return `${baseUrl}/demLayer/?${parameters.toString()}`
}

async function waitForReady(page) {

    await page.locator('#DemCachePanel[data-cache-valid="true"]').waitFor({ timeout })
    await page.locator('#GPUFrame[data-status="ready"]').waitFor({ timeout })
    await page.waitForFunction(() => {
        const canvas = document.querySelector('#GPUFrame')
        return canvas?.dataset.uncapturedErrors === '0' && canvas.dataset.deviceLosses === '0'
    }, undefined, { timeout })
}

async function replaceInput(page, control, value) {

    const input = page.locator(`[data-dem-cache-control="${control}"] input`)
    await input.fill(value)
    await input.blur()
}

async function readState(page, options = {}) {

    return await page.evaluate(({ key, includeStorage }) => {
        const panel = document.querySelector('#DemCachePanel')
        const canvas = document.querySelector('#GPUFrame')
        const value = selector => document.querySelector(selector)?.value
        const disabled = selector => document.querySelector(selector)?.disabled
        return {
            url: window.location.href,
            storage: includeStorage ? window.localStorage.getItem(key) : undefined,
            panel: panel === null ? undefined : { ...panel.dataset },
            controls: {
                policy: value('[data-dem-cache-control="policy"] select'),
                state: value('[data-dem-cache-control="status"] input'),
                preference: value('[data-dem-cache-control="preference"] input'),
                namespace: value('[data-dem-cache-control="namespace"] input'),
                maxMiB: value('[data-dem-cache-control="max-mib"] input'),
                maxEntries: value('[data-dem-cache-control="max-entries"] input'),
                persistence: value('[data-dem-cache-control="persistence"] select'),
                advancedDisabled: [
                    disabled('[data-dem-cache-control="namespace"] input'),
                    disabled('[data-dem-cache-control="max-mib"] input'),
                    disabled('[data-dem-cache-control="max-entries"] input'),
                    disabled('[data-dem-cache-control="persistence"] select'),
                ],
                applyDisabled: disabled('[data-dem-cache-control="apply"] button'),
                applyTabIndex: document.querySelector(
                    '[data-dem-cache-control="apply"] button'
                )?.tabIndex,
                resetTabIndex: document.querySelector(
                    '[data-dem-cache-control="reset"] button'
                )?.tabIndex,
            },
            runtime: canvas === null ? undefined : {
                status: canvas.dataset.status,
                cacheMode: canvas.dataset.cacheMode,
                cacheLifecycle: canvas.dataset.cacheLifecycle,
                cacheNamespace: canvas.dataset.cacheNamespace,
                cacheMaxPayloadBytes: canvas.dataset.cacheMaxPayloadBytes,
                cacheMaxEntries: canvas.dataset.cacheMaxEntries,
                cachePersistenceRequested: canvas.dataset.cachePersistenceRequested,
                cachePanelSource: canvas.dataset.cachePanelSource,
                cachePanelStorageStatus: canvas.dataset.cachePanelStorageStatus,
                uncapturedErrors: canvas.dataset.uncapturedErrors,
                deviceLosses: canvas.dataset.deviceLosses,
                diagnosticIncidents: canvas.dataset.diagnosticIncidents,
            },
        }
    }, { key: storageKey, includeStorage: options.includeStorage ?? true })
}

async function inspectLayout(page) {

    return await page.evaluate(() => {
        const panel = document.querySelector('#DemCachePanel')
        if (panel === null) return undefined
        const bounds = panel.getBoundingClientRect()
        const visibleControls = [ ...panel.querySelectorAll('button, input, select') ]
            .filter(element => {
                const style = getComputedStyle(element)
                const rect = element.getBoundingClientRect()
                return style.display !== 'none' && style.visibility !== 'hidden' &&
                    rect.width > 0 && rect.height > 0
            })
        const overflowControls = visibleControls
            .filter(element => {
                const rect = element.getBoundingClientRect()
                const nativeValueScroller = element instanceof HTMLInputElement ||
                    element instanceof HTMLSelectElement
                return (!nativeValueScroller && element.scrollWidth > element.clientWidth + 1) ||
                    rect.left < -1 || rect.right > window.innerWidth + 1 ||
                    rect.top < -1 || rect.bottom > window.innerHeight + 1
            })
            .map(element => element.closest('[data-dem-cache-control]')?.dataset.demCacheControl ??
                element.tagName.toLowerCase())
        return {
            viewport: { width: window.innerWidth, height: window.innerHeight },
            panel: {
                left: bounds.left,
                top: bounds.top,
                right: bounds.right,
                bottom: bounds.bottom,
                width: bounds.width,
                height: bounds.height,
                areaRatio: bounds.width * bounds.height / (window.innerWidth * window.innerHeight),
            },
            bodyScrollWidth: document.documentElement.scrollWidth,
            visibleControlCount: visibleControls.length,
            overflowControls,
        }
    })
}

async function capture(page, name) {

    await page.waitForTimeout(250)
    const path = resolve(outputDirectory, `${name}.png`)
    const bytes = await page.screenshot({ path })
    return {
        path,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        byteLength: bytes.byteLength,
    }
}

function validateProof(value, processState) {

    const failures = []
    if (value === undefined) return [ 'DEM cache panel proof was not produced' ]
    const { desktop, mobile, unavailableStorage } = value

    expect(failures, desktop?.initial?.panel?.cachePolicy === 'disabled' &&
        desktop.initial.panel.cacheSource === 'default' &&
        desktop.initial.panel.cacheStorageStatus === 'missing' &&
        desktop.initial.panel.cacheDirty === 'false' &&
        desktop.initial.controls.policy === 'Disabled' &&
        desktop.initial.controls.advancedDisabled.every(Boolean) &&
        desktop.initial.runtime.cacheMode === 'none' &&
        desktop.initial.runtime.cacheLifecycle === 'none',
    'bare URL did not start from the disabled default')

    expect(failures, desktop?.draft?.panel?.cachePolicy === 'durable' &&
        desktop.draft.panel.cacheDirty === 'true' &&
        desktop.draft.panel.cacheValid === 'true' &&
        desktop.draft.controls.state === 'Unsaved changes' &&
        desktop.draft.controls.namespace === namespace &&
        desktop.draft.controls.maxMiB === '256' &&
        desktop.draft.controls.maxEntries === '4096' &&
        desktop.draft.controls.persistence === 'Request' &&
        desktop.draft.controls.advancedDisabled.every(value => value === false) &&
        desktop.draft.controls.applyDisabled === false &&
        desktop.draft.controls.applyTabIndex >= 0 &&
        desktop.draft.controls.resetTabIndex >= 0 &&
        desktop.draft.runtime.cacheMode === 'none' &&
        desktop.draft.runtime.cacheLifecycle === 'none',
    'editing the complete draft mutated runtime state or lost panel state')

    const appliedParameters = urlParameters(desktop?.applied?.url)
    const stored = parseJson(desktop?.applied?.storage)
    expect(failures, appliedParameters?.cache === 'persistent' &&
        appliedParameters.cacheLifecycle === 'durable-reuse' &&
        appliedParameters.cacheNamespace === namespace &&
        appliedParameters.cacheMaxMiB === '256' &&
        appliedParameters.cacheMaxEntries === '4096' &&
        appliedParameters.cachePersistence === 'request' &&
        appliedParameters.proof === '1' &&
        appliedParameters.tileServer === tileBaseUrl &&
        stored?.schemaVersion === 1 && stored.config?.policy === 'durable' &&
        stored.config?.namespace === namespace && stored.config?.maxMiB === 256 &&
        stored.config?.maxEntries === 4096 && stored.config?.persistence === 'request' &&
        desktop.applied.panel.cacheSource === 'url' &&
        desktop.applied.panel.cacheStorageStatus === 'valid' &&
        desktop.applied.panel.cacheDirty === 'false' &&
        desktop.applied.runtime.cacheMode === 'persistent' &&
        desktop.applied.runtime.cacheLifecycle === 'durable-reuse' &&
        desktop.applied.runtime.cacheNamespace === namespace &&
        desktop.applied.runtime.cacheMaxPayloadBytes === String(256 * 1024 * 1024) &&
        desktop.applied.runtime.cacheMaxEntries === '4096' &&
        desktop.applied.runtime.cachePersistenceRequested === 'true',
    'apply and reload did not converge URL, local preference, and runtime facts')

    expect(failures, !hasCacheParameters(desktop?.restored?.url) &&
        desktop.restored.panel.cacheSource === 'storage' &&
        desktop.restored.panel.cachePolicy === 'durable' &&
        desktop.restored.runtime.cacheMode === 'persistent' &&
        desktop.restored.runtime.cacheLifecycle === 'durable-reuse' &&
        desktop.restored.runtime.cacheNamespace === namespace,
    'bare URL did not restore the saved local preference')

    expect(failures, desktop?.overridden?.panel?.cacheSource === 'url' &&
        desktop.overridden.panel.cachePolicy === 'disabled' &&
        desktop.overridden.runtime.cacheMode === 'none' &&
        desktop.overridden.runtime.cacheLifecycle === 'none' &&
        parseJson(desktop.overridden.storage)?.config?.policy === 'durable',
    'explicit URL did not override the saved preference without deleting it')

    expect(failures, !hasCacheParameters(desktop?.reset?.url) &&
        desktop.reset.storage === null &&
        desktop.reset.panel.cacheSource === 'default' &&
        desktop.reset.panel.cachePolicy === 'disabled' &&
        desktop.reset.runtime.cacheMode === 'none' &&
        desktop.reset.runtime.cacheLifecycle === 'none',
    'restore defaults did not remove configuration state and return to no cache')

    for (const [ name, state ] of Object.entries({
        initial: desktop?.initial,
        draft: desktop?.draft,
        applied: desktop?.applied,
        restored: desktop?.restored,
        overridden: desktop?.overridden,
        reset: desktop?.reset,
        mobile: mobile?.state,
        unavailableStorage: unavailableStorage?.state,
    })) {
        expect(failures, cleanRuntime(state?.runtime), `${name} retained a WebGPU diagnostic failure`)
    }

    expect(failures, validLayout(desktop?.layouts?.initial) &&
        validLayout(desktop?.layouts?.expanded) &&
        desktop.layouts.expanded.visibleControlCount >= 10,
    'desktop panel escaped the viewport or overflowed a visible control')
    expect(failures, validLayout(mobile?.layout) &&
        mobile.layout.panel.areaRatio < 0.08 &&
        mobile.layout.panel.height < mobile.layout.viewport.height / 4,
    'collapsed mobile panel obscured the primary map viewport')

    expect(failures, mobile?.state?.panel?.cachePolicy === 'disabled' &&
        mobile.state.runtime.cacheMode === 'none',
    'mobile panel did not preserve default cache semantics')
    expect(failures, unavailableStorage?.state?.panel?.cacheStorageStatus === 'unavailable' &&
        unavailableStorage.state.controls.preference === 'Local preference unavailable' &&
        unavailableStorage.state.runtime.cacheMode === 'persistent' &&
        unavailableStorage.state.runtime.cacheLifecycle === 'session' &&
        unavailableStorage.state.runtime.cachePanelSource === 'url' &&
        unavailableStorage.state.runtime.cachePanelStorageStatus === 'unavailable',
    'unavailable localStorage prevented explicit URL operation or hid degradation')

    for (const [ name, events ] of Object.entries({
        desktop: desktop?.events,
        mobile: mobile?.events,
        unavailableStorage: unavailableStorage?.events,
    })) {
        expect(failures, unexpectedEvents(events).length === 0,
            `${name} emitted browser failures: ${JSON.stringify(unexpectedEvents(events))}`)
    }
    expect(failures, processState.browserClosed && processState.viteClosed &&
        processState.tileServerClosed,
    'managed Chrome, Vite, or tile server remained reachable')
    return failures
}

function expect(failures, condition, message) {

    if (!condition) failures.push(message)
}

function cleanRuntime(runtime) {

    return runtime?.status === 'ready' && runtime.uncapturedErrors === '0' &&
        runtime.deviceLosses === '0' && runtime.diagnosticIncidents === '0'
}

function validLayout(layout) {

    return layout !== undefined && layout.panel.left >= 0 && layout.panel.top >= 0 &&
        layout.panel.right <= layout.viewport.width + 1 &&
        layout.panel.bottom <= layout.viewport.height + 1 &&
        layout.bodyScrollWidth <= layout.viewport.width && layout.overflowControls.length === 0
}

function hasCacheParameters(value) {

    if (value === undefined) return true
    const parameters = new URL(value).searchParams
    return [
        'cache',
        'cacheLifecycle',
        'cacheNamespace',
        'cacheMaxMiB',
        'cacheMaxEntries',
        'cachePersistence',
    ].some(name => parameters.has(name))
}

function urlParameters(value) {

    if (value === undefined) return undefined
    return Object.fromEntries(new URL(value).searchParams)
}

function parseJson(value) {

    try {
        return JSON.parse(value)
    } catch {
        return undefined
    }
}

function observePage(page) {

    const events = { consoleFailures: [], pageErrors: [], httpFailures: [] }
    page.on('console', message => {
        if (message.type() === 'error') pushBounded(events.consoleFailures, message.text())
    })
    page.on('pageerror', error => pushBounded(events.pageErrors, serializeError(error)))
    page.on('response', response => {
        if (response.status() >= 400) {
            pushBounded(events.httpFailures, `${response.status()} ${response.url()}`)
        }
    })
    return events
}

function unexpectedEvents(events) {

    if (events === undefined) return [ 'missing browser event ledger' ]
    return [ ...events.consoleFailures, ...events.pageErrors, ...events.httpFailures ]
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
