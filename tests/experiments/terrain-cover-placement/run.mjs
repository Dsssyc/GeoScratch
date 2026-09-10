import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { createServer as createPortServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import { transform } from './transforms.mjs'
import { scenarios } from './scenarios.mjs'
import { movingReveal } from './reveal.mjs'
import { prepareGate } from './gate-adapters.mjs'

const experimentDirectory = dirname(fileURLToPath(import.meta.url))
const root = resolve(experimentDirectory, '../../..')
const mode = process.argv[2] ?? 'gpu'
const suite = process.argv[3] ?? 'performance'
const coordinateBits = Number(process.env.TERRAIN_PLACEMENT_BITS ?? 40)
const delayMs = Number(process.env.TERRAIN_PLACEMENT_TILE_DELAY_MS ?? 0)
const feedbackDelayMs = Number(process.env.TERRAIN_PLACEMENT_FEEDBACK_DELAY_MS ?? 0)
if (!['gpu', 'gpu-eager', 'gpu-observed', 'shadow', 'cpu-cover', 'cpu-all'].includes(mode) ||
    !['performance', 'reveal', 'render', 'streaming'].includes(suite) ||
    ![40, 52].includes(coordinateBits) || !Number.isInteger(delayMs) || delayMs < 0 || delayMs > 2000 ||
    !Number.isInteger(feedbackDelayMs) || feedbackDelayMs < 0 || feedbackDelayMs > 2000) {
    throw new Error('Usage: node run.mjs [gpu|gpu-eager|gpu-observed|shadow|cpu-cover|cpu-all] [performance|reveal|render|streaming]; bits 40|52, delays 0..2000 ms')
}
const outputDirectory = process.env.TERRAIN_PLACEMENT_OUTPUT
    ? resolve(process.env.TERRAIN_PLACEMENT_OUTPUT)
    : await mkdtemp(resolve(tmpdir(), 'geoscratch-terrain-placement-'))
await mkdir(outputDirectory, { recursive: true })
const serverRoot = `${root}/examples/underwaterTerrain/tile-server`
const before = await provenance()
const port = await freePort()
let tile, vite, browser, result, error
const events = [], serviceLog = [], cleanupFailures = []
let delayedRequestCount = 0
try {
    // The experiment requires the existing COG and manifest, and never builds data.
    await readFile(`${serverRoot}/cache/manifest.json`)
    const mapLibre = {}
    for (const suffix of ['js', 'css']) {
        const url = `https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.${suffix}`
        const response = await fetch(url)
        if (!response.ok) throw new Error(`Pinned MapLibre asset failed: ${response.status} ${url}`)
        mapLibre[suffix] = Buffer.from(await response.arrayBuffer())
    }
    tile = spawn(`${serverRoot}/.venv/bin/dem-tile-serve`, ['--port', String(port)], {
        cwd: serverRoot, stdio: ['ignore', 'pipe', 'pipe'],
    })
    tile.stdout.on('data', bytes => { if (serviceLog.length < 64) serviceLog.push(String(bytes)) })
    tile.stderr.on('data', bytes => { if (serviceLog.length < 64) serviceLog.push(String(bytes)) })
    await waitForHttp(`http://127.0.0.1:${port}/health`)
    vite = await createServer({
        configFile: `${root}/examples/vite.config.ts`, logLevel: 'error',
        plugins: [{
            name: 'isolated-terrain-placement', enforce: 'pre',
            transform(code, id) {
                return transform(code, id.split('?')[0], mode,
                    { experimentDirectory, outputDirectory, coordinateBits, feedbackDelayMs })
            },
        }],
        server: { host: '127.0.0.1', port: 0, fs: { allow: [root, outputDirectory] } },
    })
    await vite.listen()
    const baseUrl = vite.resolvedUrls.local[0].replace(/\/$/, '')
    const tileBaseUrl = `http://127.0.0.1:${port}`
    browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu'] })
    const newContext = browser.newContext.bind(browser)
    browser.newContext = async options => {
        const context = await newContext(options)
        for (const suffix of ['js', 'css']) {
            await context.route(`https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.${suffix}`, route => route.fulfill({
                body: mapLibre[suffix], contentType: suffix === 'js' ? 'text/javascript' : 'text/css',
            }))
        }
        if (delayMs) await context.route(`${tileBaseUrl}/tiles/**`, async route => {
            delayedRequestCount++
            await delay(delayMs)
            await route.continue()
        })
        context.on('page', page => page.on('pageerror', failure => events.push(failure.message)))
        return context
    }
    if (suite === 'performance' || suite === 'reveal') {
        const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
        const page = await context.newPage()
        const benchmark = await readFile(`${root}/tests/benchmarks/webmercator-camera-cover.mjs`, 'utf8')
        const start = benchmark.indexOf('function installTimestampAudit(')
        const end = benchmark.indexOf('async function sourceProvenance(')
        if (start < 0 || end < start) throw new Error('Timestamp audit boundaries changed')
        const timestampAudit = benchmark.slice(start, end).replace(
            'sequence % configuration.sampleEveryEncoders !== 0',
            'audit.frameEpoch % configuration.sampleEveryEncoders !== 0')
        await page.addInitScript({ content: `${timestampAudit}\ninstallTimestampAudit({sampleEveryEncoders:7,maximumTimestampedPassesPerEncoder:64})` })
        await page.goto(`${baseUrl}/underwaterTerrain/?proof=1&cache=none&tileServer=${encodeURIComponent(tileBaseUrl)}`)
        await page.waitForFunction(() => ['ready', 'error'].includes(document.querySelector('#GPUFrame')?.dataset.status), {}, { timeout: 90_000 })
        result = await page.evaluate(suite === 'performance' ? scenarios : movingReveal, { delayMs })
        await page.screenshot({ path: `${outputDirectory}/terrain.png` })
        result.cleanup = await page.evaluate(async() => await window.__UNDERWATER_TERRAIN_PROOF__.dispose())
        if (suite === 'performance' && (!result.independent.sameAState || !result.independent.sameADemands ||
            result.timestamps.errors.length || result.timestamps.live || result.timestamps.pending)) {
            throw new Error('A-B-A or timestamp cleanup verification failed')
        }
    } else {
        const runGate = await prepareGate(root, outputDirectory, suite)
        result = await runGate(browser, {
            baseUrl, tileBaseUrl, outputDirectory, coordinateBits,
            selectionPath: ['gpu', 'gpu-eager', 'gpu-observed', 'shadow'].includes(mode)
                ? 'gpu-camera-inverse-webmercatorquad-cover' : 'experimental-cpu-camera-cover',
        })
        if (result.failures.length) throw new Error(`Terrain gate failed: ${result.failures.join('; ')}`)
    }
    await writeFile(`${outputDirectory}/maplibre-provenance.json`, JSON.stringify(Object.fromEntries(
        Object.entries(mapLibre).map(([suffix, bytes]) => [suffix, digest(bytes)])), null, 2))
} catch (failure) {
    error = failure.stack ?? String(failure)
} finally {
    for (const [label, action] of [
        ['browser', () => browser?.close()], ['Vite', () => vite?.close()],
        ['tile server', async() => {
            if (!tile || tile.exitCode !== null || tile.signalCode !== null) return
            tile.kill('SIGTERM')
            let timer
            try {
                await Promise.race([
                    new Promise(resolve => tile.once('exit', resolve)),
                    new Promise(resolve => { timer = setTimeout(resolve, 5000) }),
                ])
            } finally {
                clearTimeout(timer)
            }
            if (tile.exitCode === null && tile.signalCode === null) {
                tile.kill('SIGKILL')
                await new Promise(resolve => tile.once('exit', resolve))
            }
        }],
    ]) {
        try { await action() } catch (failure) { cleanupFailures.push(`${label}: ${failure}`) }
    }
}
const after = await provenance()
const cleanup = {
    browserClosed: !browser?.isConnected(), viteClosed: !vite?.httpServer?.listening,
    tileClosed: !tile || tile.exitCode !== null || tile.signalCode !== null,
}
const status = error || events.length || cleanupFailures.length || Object.values(cleanup).some(value => !value) ||
    before.sourceHash !== after.sourceHash || before.dataHash !== after.dataHash ||
    before.experimentHash !== after.experimentHash ? 'failed' : 'passed'
const record = { status, mode, suite, coordinateBits, delayMs, feedbackDelayMs, delayedRequestCount,
    browserVersion: browser?.version(), before, after, result, error, events, cleanup, cleanupFailures,
    ...(error ? { serviceLog } : {}), outputDirectory }
await writeFile(`${outputDirectory}/result.json`, JSON.stringify(record, null, 2) + '\n')
console.log(JSON.stringify({ status, mode, suite, outputDirectory, error, cleanup }, null, 2))
if (status !== 'passed') process.exitCode = 1

function digest(bytes) { return createHash('sha256').update(bytes).digest('hex') }
async function provenance() {
    const files = execFileSync('git', ['ls-files', '-z', 'packages/geoscratch/src', 'examples/underwaterTerrain', 'examples/flowLayer', 'package-lock.json'], { cwd: root }).toString().split('\0').filter(Boolean)
    const source = createHash('sha256')
    for (const file of files.sort()) source.update(file).update(await readFile(`${root}/${file}`))
    const data = createHash('sha256')
    for (const file of ['manifest.json', 'dem.cog.tif']) data.update(await readFile(`${serverRoot}/cache/${file}`))
    const experiment = createHash('sha256')
    for (const file of (await readdir(experimentDirectory)).sort()) experiment.update(file).update(await readFile(`${experimentDirectory}/${file}`))
    return { head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim(),
        sourceHash: source.digest('hex'), dataHash: data.digest('hex'), experimentHash: experiment.digest('hex') }
}
async function freePort() {
    const server = createPortServer()
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port
    await new Promise(resolve => server.close(resolve))
    return port
}
async function waitForHttp(url) {
    for (let attempt = 0; attempt < 200; attempt++) {
        try { if ((await fetch(url)).ok) return } catch {}
        await delay(50)
    }
    throw new Error(`Existing-data tile service did not start: ${url}`)
}
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }
