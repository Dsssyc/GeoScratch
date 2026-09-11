import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'
import { DevProcesses } from '../../scripts/dev-processes.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
const processes = new DevProcesses()
const backendPort = await freePort()
let vitePort = await freePort()
while (vitePort === backendPort) vitePort = await freePort()
const base = `http://127.0.0.1:${vitePort}`
const backend = `http://127.0.0.1:${backendPort}`
const mode = process.env.EXAMPLES_PROOF_PREVIEW === '1' ? 'preview' : 'all'
const server = processes.start(process.execPath, [
    resolve(root, 'scripts/examples-dev.mjs'), mode,
    '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort',
], { cwd: root, env: { ...process.env, EXAMPLES_BACKEND_PORT: String(backendPort) } })
let browser
let serverStopped = false
const switched = []

try {
    await waitFor(async () => {
        const response = await fetch(`${base}/api/health`)
        return response.ok
    }, server)
    const initial = await json('/api/health')
    assert.equal(initial.status, 'ok', 'Both existing datasets must be prepared for this proof')
    assert.equal(initial.modules.dem.status, 'ready')
    assert.equal(initial.modules.flow.status, 'ready')
    const flow = await json('/api/flow/manifest.json')
    const pageRecord = flow.pages[0]
    const pageResponse = await fetch(`${base}/api/flow/${pageRecord.path}`)
    assert.equal(pageResponse.status, 200)
    const digest = createHash('sha256').update(Buffer.from(await pageResponse.arrayBuffer())).digest('hex')
    assert.equal(digest, pageRecord.sha256)
    assert.equal((await fetch(`${base}/api/flow/${pageRecord.path}`, {
        headers: { 'If-None-Match': pageResponse.headers.get('etag') },
    })).status, 304)

    browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu'] })
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    const errors = []
    const responses = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('response', response => {
        if (response.url().startsWith(`${base}/api/`)) {
            responses.push({ url: response.url(), status: response.status() })
        }
    })
    // Basemap imagery is unrelated to data routing. Keep normal map lifecycle
    // while making this network proof independent of the external tile host.
    const raster = await readFile(resolve(root, 'docs/assets/icons/icon_dark.png'))
    await page.route(/^https:\/\/[abcd]\.basemaps\.cartocdn\.com\//, route => route.fulfill({
        status: 200, contentType: 'image/png', body: raster,
        headers: { 'access-control-allow-origin': '*' },
    }))
    await page.goto(`${base}/?sample=underwaterTerrain`)
    for (const name of ['underwaterTerrain', 'flowField', 'underwaterTerrain']) {
        if (switched.length) await page.locator(`.example-link[data-id="${name}"]`).click()
        await waitFor(async () => Boolean(page.frames().find(frame => frame.url().includes(`/${name}/`))), server)
        const frame = page.frames().find(frame => frame.url().includes(`/${name}/`))
        await frame.waitForFunction(() => ['ready', 'error'].includes(document.body.dataset.status),
            undefined, { timeout: 120_000 })
        const state = await frame.evaluate(() => ({
            status: document.body.dataset.status,
            error: document.querySelector('canvas')?.dataset.error,
        }))
        assert.equal(state.status, 'ready', JSON.stringify(state))
        assert.equal((await json('/api/health')).pid, initial.pid, 'Switching must retain the backend process')
        switched.push(name)
    }
    for (const module of ['dem', 'flow']) {
        assert.ok(responses.some(response => response.url.includes(`/api/${module}/tiles/`)
            && response.status === 200), `Browser/Workers must receive ${module} tiles through Vite`)
    }
    assert.deepEqual(responses.filter(response => response.status >= 400), [])
    assert.deepEqual(errors, [])
    await browser.close()
    browser = undefined
    // Let the supervisor complete its own cleanup before the test scope reaps it.
    server.child.kill('SIGTERM')
    await waitFor(async () => server.child.exitCode !== null, undefined, 10_000)
    assert.equal((await server.exited).code, 0)
    serverStopped = true
    await assertClosed(base)
    await assertClosed(backend)
    console.log(JSON.stringify({ status: 'passed', mode, switched, backendPid: initial.pid,
        flowPageSha256: digest, apiResponses: responses.length, portsClosed: true }))
} finally {
    if (browser) await browser.close()
    if (!serverStopped) {
        server.child.kill('SIGTERM')
        await Promise.race([server.exited, delay(10_000)])
    }
    await processes.close()
}

async function json(path) {
    const response = await fetch(`${base}${path}`)
    assert.equal(response.status, 200, path)
    return response.json()
}

async function waitFor(check, child, timeout = 120_000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
        if (child?.child.exitCode !== null && child?.child.exitCode !== undefined) {
            throw new Error(`Development exited: ${JSON.stringify(await child.exited)}`)
        }
        try { if (await check()) return } catch {}
        await delay(100)
    }
    throw new Error('Timed out waiting for development proof')
}

async function assertClosed(url) {
    await assert.rejects(fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) }))
}

async function freePort() {
    const server = createServer()
    await new Promise(resolveReady => server.listen(0, '127.0.0.1', resolveReady))
    const port = server.address().port
    await new Promise(resolveClosed => server.close(resolveClosed))
    return port
}
