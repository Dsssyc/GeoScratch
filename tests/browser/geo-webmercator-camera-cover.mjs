import { build } from 'esbuild'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const sourceRoot = resolve(process.env.GEO_CAMERA_COVER_SOURCE_ROOT ?? root)
const temporary = await mkdtemp(join(tmpdir(), 'geoscratch-camera-cover-browser-'))
const bundle = join(temporary, 'proof.js')
const failures = [], proofs = [], events = []
let browser, server, browserVersion, proofTimeout
try {
    await build({
        entryPoints: [resolve(root, 'tests/fixtures/geo-webmercator-camera-cover.ts')],
        outfile: bundle, bundle: true, format: 'esm', platform: 'browser',
        alias: { 'geoscratch/scratch': resolve(sourceRoot, 'packages/geoscratch/src/scratch.ts'),
            'geoscratch/geo': resolve(sourceRoot, 'packages/geoscratch/src/geo/index.ts') },
        logLevel: 'silent',
    })
    const javascript = await readFile(bundle)
    server = createServer((request, response) => {
        if (request.url === '/proof.js') response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(javascript)
        else if (request.url === '/') response.writeHead(200, { 'Content-Type': 'text/html' }).end(
            '<!doctype html><title>Camera cover proof</title><link rel="icon" href="data:,">')
        else response.writeHead(404).end()
    })
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu'] })
    browserVersion = browser.version()
    for (const dpr of [1, 2]) {
        const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: dpr })
        let page
        try {
            page = await context.newPage()
            page.on('pageerror', error => events.push(error.message))
            page.on('console', message => {
                if (message.type() === 'error' || message.type() === 'warning') events.push(message.text())
            })
            page.on('requestfailed', request => events.push(`${request.url()}: ${request.failure()?.errorText}`))
            page.on('response', response => { if (response.status() >= 400) events.push(`${response.status()} ${response.url()}`) })
            await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'domcontentloaded' })
            proofs.push(await Promise.race([
                page.evaluate(async() => (await import('/proof.js')).runCameraCoverProof()),
                new Promise((_, reject) => { proofTimeout = setTimeout(() => reject(new Error('Camera cover proof timed out')), 120_000) }),
            ]))
        } catch (error) {
            let progress
            try { progress = await page?.evaluate(() => ({ ...document.documentElement.dataset })) }
            catch { /* A crashed or closed renderer may no longer provide progress. */ }
            throw new Error(`${error.stack ?? error}\nLast camera-cover progress: ${JSON.stringify(progress)}`)
        } finally { clearTimeout(proofTimeout); await context.close() }
    }
    const first = proofs[0], second = proofs[1]
    if (first.dpr !== 1 || second.dpr !== 2 || first.rows.length !== second.rows.length) failures.push('DPR contexts differ from their requested values')
    for (let i = 0; i < first.rows.length; i++) {
        const a = first.rows[i], b = second.rows[i]
        if (a.name !== b.name || a.identitySha256 !== b.identitySha256 || a.orderedIdentitySha256 !== b.orderedIdentitySha256 || a.patchCount !== b.patchCount) {
            failures.push(`DPR changed cover identity in ${a.name}`)
        }
        if (a.presentationSize && (b.presentationSize.width !== a.presentationSize.width * 2 ||
            b.presentationSize.height !== a.presentationSize.height * 2)) failures.push(`Physical presentation size did not change in ${a.name}`)
    }
    failures.push(...events)
} catch (error) { failures.push(error.stack ?? String(error)) }
finally {
    clearTimeout(proofTimeout)
    try { await browser?.close() } catch (error) { failures.push(`Browser cleanup: ${error}`) }
    try { if (server?.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
    catch (error) { failures.push(`HTTP cleanup: ${error}`) }
    try { await rm(temporary, { recursive: true, force: true }) } catch (error) { failures.push(`Temporary cleanup: ${error}`) }
}
const cleanup = { browserClosed: browser === undefined || !browser.isConnected(), serverClosed: server === undefined || !server.listening }
if (!cleanup.browserClosed || !cleanup.serverClosed) failures.push('Owned browser or HTTP server remains live')
process.stdout.write(`${JSON.stringify({ schemaVersion: 1, status: failures.length ? 'failed' : 'passed', browserVersion,
    headless: true, sourceRoot, proofs, cleanup, failures }, null, 2)}\n`)
if (failures.length) process.exitCode = 1
