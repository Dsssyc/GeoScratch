import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createServer } from 'vite'

// Run after the package build. Requires Chrome, ffmpeg, and img2webp on PATH.
// Globe rendering uses the existing example; no production source is patched.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const still = process.argv.includes('--still')
const output = resolve(root, process.argv.slice(2).find(argument => argument !== '--still') ??
    (still ? join(tmpdir(), 'geoscratch-preview.png') : 'docs/assets/DayDream.webp'))
const temporary = await mkdtemp(join(tmpdir(), 'geoscratch-preview-'))
const frameRate = 20
const durationSeconds = 30
const cycleFrames = frameRate * durationSeconds
const seamFrames = frameRate * 2
const samples = still ? 1 : cycleFrames + seamFrames
const compositeDirectory = join(temporary, 'composite')
const failures = []
let server
let browser

function run(command, args) {
    return new Promise((resolvePromise, reject) => {
        const child = spawn(command, args, {
            stdio: ['ignore', 'inherit', 'inherit'],
        })
        child.once('error', reject)
        child.once('exit', code => code === 0 ? resolvePromise() : reject(new Error(`${command} exited ${code}`)))
    })
}

try {
    server = await createServer({
        root: join(root, 'examples'),
        server: { host: '127.0.0.1', port: 0, open: false },
    })
    await server.listen()
    const address = server.httpServer.address()
    browser = await chromium.launch({
        channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu'],
    })
    const brandPage = await browser.newPage({
        viewport: { width: 900, height: 480 }, deviceScaleFactor: 2,
    })
    const icon = await readFile(join(root, 'docs/assets/icons/icon_light.png'))
    const branding = await readFile(join(root, 'docs/assets/preview-branding.html'), 'utf8')
    await brandPage.setContent(branding.replace('./icons/icon_light.png', `data:image/png;base64,${icon.toString('base64')}`))
    await brandPage.locator('img').evaluate(image => image.decode())
    await brandPage.screenshot({ path: join(temporary, 'branding.png'), omitBackground: true })
    await brandPage.close()
    const page = await browser.newPage({
        viewport: { width: 2400, height: 2400 }, deviceScaleFactor: 1,
    })
    page.on('pageerror', error => failures.push(String(error)))
    page.on('console', message => {
        if (message.type() === 'error') failures.push(message.text())
    })
    page.on('requestfailed', request => failures.push(`${request.url()}: ${request.failure()?.errorText}`))
    page.on('response', response => {
        if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`)
    })
    // Admit each real example frame explicitly, retaining its fixed simulation step.
    await page.addInitScript(() => {
        let nextId = 0
        const callbacks = new Map()
        window.requestAnimationFrame = callback => {
            callbacks.set(++nextId, callback)
            return nextId
        }
        window.cancelAnimationFrame = id => callbacks.delete(id)
        window.previewFrame = async() => {
            const deadline = performance.now() + 30_000
            const wait = async() => {
                const canvas = document.querySelector('#GPUFrame')
                if (canvas?.dataset.status === 'error') throw new Error(canvas.dataset.error)
                if (performance.now() > deadline) throw new Error('Preview frame timed out')
                await new Promise(resolve => setTimeout(resolve, 1))
            }
            while (callbacks.size === 0) await wait()
            const entries = [...callbacks.values()]
            callbacks.clear()
            for (const callback of entries) await callback(performance.now())
            const canvas = document.querySelector('#GPUFrame')
            while (canvas.dataset.observedFrames !== canvas.dataset.frames) {
                await wait()
            }
        }
    })
    await page.goto(`http://127.0.0.1:${address.port}/helloGAW/index.html?proof=1`)
    const adapter = await page.evaluate(async() => {
        const adapter = await navigator.gpu?.requestAdapter()
        if (!adapter) throw new Error('A WebGPU adapter is required')
        return { ...adapter.info.toJSON?.(), description: adapter.info.description }
    })
    let rendered = 0
    // delta changes by -0.001 per frame: 1000 frames wrap land once and clouds twice.
    // Spread exactly one turn over 30 seconds, with 1–2 simulation steps per sample.
    // Extra samples blend only the non-periodic motion across the loop boundary.
    for (let sample = 0; sample < samples; sample++) {
        const target = 1 + Math.floor(sample * 1000 / cycleFrames)
        await page.evaluate(async steps => {
            for (let index = 0; index < steps; index++) await window.previewFrame()
        }, target - rendered)
        rendered = target
        if (failures.length) throw new Error(failures.join('\n'))
        // Bloom extends beyond the globe. Keep the complete viewport, with no
        // screenshot clip or rectangular edge mask on the rendering layer.
        await page.screenshot({
            path: join(temporary, `${String(sample).padStart(3, '0')}.png`),
            timeout: 30_000,
        })
        if (sample % frameRate === 0) console.log(`Captured ${sample + 1}/${samples} samples`)
    }
    const facts = await page.locator('#GPUFrame').evaluate(canvas => ({ ...canvas.dataset }))
    if (facts.status !== 'ready' || facts.diagnosticIncidents !== '0' ||
        facts.uncapturedErrors !== '0' || facts.deviceLosses !== '0' ||
        Number(facts.frames) !== rendered || Number(facts.observedFrames) !== rendered) {
        throw new Error(`Invalid render evidence: ${JSON.stringify(facts)}`)
    }
    await mkdir(dirname(output), { recursive: true })
    await mkdir(compositeDirectory)
    await run('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-framerate', String(frameRate), '-i', join(temporary, '%03d.png'),
        '-loop', '1', '-framerate', String(frameRate), '-i', join(temporary, 'branding.png'),
        '-filter_complex', [
            // Place the full scene first; crop only the outer banner bounds.
            '[0:v]scale=536:536:flags=area,gblur=sigma=0.3[resized]',
            ...(still ? ['[resized]null[cycle]'] : [
                '[resized]split=3[head][body][tail]',
                `[head]trim=end_frame=${seamFrames},setpts=PTS-STARTPTS[h]`,
                `[tail]trim=start_frame=${cycleFrames},setpts=PTS-STARTPTS[t]`,
                `[t][h]blend=all_expr='A*(1-N/${seamFrames})+B*(N/${seamFrames})'[seam]`,
                `[body]trim=start_frame=${seamFrames}:end_frame=${cycleFrames},setpts=PTS-STARTPTS[b]`,
                '[seam][b]concat=n=2:v=1:a=0[cycle]',
            ]),
            "[cycle]format=gbrp,lutrgb=r='255*pow(val/255,0.8)':g='255*pow(val/255,0.8)':b='255*pow(val/255,0.8)',pad=1000:600:382:32:black,crop=900:480:0:60[earth]",
            '[1:v]scale=900:480:flags=area[brand]',
            `[earth][brand]overlay=0:0:shortest=1,trim=end_frame=${still ? 1 : cycleFrames},format=rgb24[out]`,
        ].join(';'),
        '-map', '[out]', '-frames:v', String(still ? 1 : cycleFrames),
        '-start_number', '0', join(compositeDirectory, '%03d.png'),
    ])
    if (still) {
        await writeFile(output, await readFile(join(compositeDirectory, '000.png')))
    } else await run('img2webp', [
        '-min_size', '-loop', '0', '-lossy', '-q', '60', '-m', '4', '-d', String(1000 / frameRate),
        ...Array.from({ length: cycleFrames }, (_, index) =>
            join(compositeDirectory, `${String(index).padStart(3, '0')}.png`)),
        '-o', output,
    ])
    const evidence = {
        browser: await browser.version(), headless: true, adapter,
        renderedFrames: rendered, samples, animationFrames: still ? 1 : cycleFrames,
        width: 900, height: 480, durationSeconds: still ? 0 : durationSeconds, frameRate, earthTurns: still ? 0 : 1,
        bytes: (await stat(output)).size, failures, facts,
    }
    await writeFile(join(temporary, 'evidence.json'), JSON.stringify(evidence, null, 2))
    console.log(JSON.stringify({ output, temporary, ...evidence }, null, 2))
} finally {
    await browser?.close()
    await server?.close()
    // Keep captured frames only when explicitly requested for visual review.
    if (process.env.KEEP_PREVIEW_FRAMES !== '1') await rm(temporary, { recursive: true, force: true })
}
