import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import ts from 'typescript'

const sourceRoot = new URL('../../examples/flowField/', import.meta.url)
const sources = new Map(await Promise.all([
    'control-panel.ts', 'control-panel.css', 'flow-presentation.ts',
].map(async name => {
    const source = await readFile(new URL(name, sourceRoot), 'utf8')
    return [ `/${name}`, name.endsWith('.ts')
        ? ts.transpileModule(source, { compilerOptions: {
            module: ts.ModuleKind.ESNext,
            target: ts.ScriptTarget.ES2022,
        } }).outputText : source ]
})))
const server = createServer((request, response) => {
    if (request.url === '/') {
        response.setHeader('content-type', 'text/html')
        response.end('<!doctype html><html><head><link rel="stylesheet" href="/control-panel.css"></head><body style="margin:0;background:#080b10"><main id="controls"><span id="existing">Existing content</span></main></body></html>')
        return
    }
    const source = sources.get(request.url)
    if (source === undefined) { response.writeHead(404).end(); return }
    response.setHeader('content-type', request.url.endsWith('.css') ? 'text/css' : 'text/javascript')
    response.end(source)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let browser
try {
    browser = await chromium.launch({ channel: 'chrome', headless: true })
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.evaluate(async () => {
        const { mountFlowFieldControls } = await import('/control-panel.ts')
        const { FLOW_FIELD_PRESENTATION } = await import('/flow-presentation.ts')
        const events = []
        const snapshot = {
            dataset: { id: 'flow-test', minimumTime: 0, maximumTime: 26, timeUnit: 'index', velocityUnit: 'm/s', sampleCount: 27, maximumMatrix: '10' },
            timeline: {
                modelTime: 2.5, playing: false, rate: 0.2, loop: 'loop',
                selection: { kind: 'interpolated', lower: { sampleKey: 't2' }, upper: { sampleKey: 't3' }, alpha: 0.5 },
            },
            presented: { presentedModelTime: 2.4 },
            state: 'ready', runtimeCount: 2, presentation: FLOW_FIELD_PRESENTATION,
        }
        const controls = mountFlowFieldControls({
            container: document.querySelector('#controls'),
            onPlay() { events.push([ 'play' ]); snapshot.timeline.playing = true; controls.update(snapshot) },
            onPause() { events.push([ 'pause' ]); snapshot.timeline.playing = false; controls.update(snapshot) },
            onSeek(time) { events.push([ 'seek', time ]); snapshot.timeline.modelTime = time; controls.update(snapshot) },
            onRate(rate) { events.push([ 'rate', rate ]); snapshot.timeline.rate = rate; controls.update(snapshot) },
            onLoop(loop) { events.push([ 'loop', loop ]); snapshot.timeline.loop = loop; controls.update(snapshot) },
            onPresentation(presentation) { events.push([ 'presentation', presentation ]); snapshot.presentation = presentation; controls.update(snapshot) },
        })
        window.fixture = { controls, snapshot, events }
    })
    const control = name => page.locator(`[data-flow-control="${name}"]`)
    assert.equal(await control('play-pause').isDisabled(), true, 'Initial loading disables transport')
    await page.evaluate(() => fixture.controls.update(fixture.snapshot))
    assert.equal(await control('play-pause').isDisabled(), false)
    assert.equal(await control('sample').isDisabled(), true, 'Particle view always samples interpolated velocity')
    assert.equal(await control('requested').textContent(), '2.5 index')
    assert.equal(await control('presented').textContent(), '2.4 index')
    assert.equal(await control('boundary').inputValue(), 'hard')
    assert.equal(await control('feather').isDisabled(), true)
    assert.equal(await control('feather').inputValue(), '0.25')
    assert.equal(await control('feather-value').textContent(), '0.25 texel')
    assert.equal(await control('feather').getAttribute('min'), '0.05')
    assert.equal(await control('feather').getAttribute('max'), '0.35')
    assert.equal(await control('feather').getAttribute('step'), '0.01')
    await control('boundary').selectOption('sdf')
    assert.equal(await page.evaluate(() => fixture.snapshot.presentation.boundary), 'sdf')
    assert.match(await control('legend').textContent(), /Inner-edge display only/)
    assert.equal(await control('feather').isDisabled(), false)
    const beforeInput = await page.evaluate(() => fixture.events.length)
    await page.evaluate(() => {
        const feather = document.querySelector('[data-flow-control="feather"]')
        feather.valueAsNumber = 0.05
        feather.dispatchEvent(new Event('input', {bubbles:true}))
    })
    assert.equal(await page.evaluate(() => fixture.events.length), beforeInput+1)
    assert.equal(await page.evaluate(() => fixture.snapshot.presentation.sdfFeatherTexels), 0.05)
    assert.equal(await control('feather').getAttribute('aria-valuetext'), '0.05 source texel')
    await control('feather').dispatchEvent('change')
    assert.equal(await page.evaluate(() => fixture.events.length), beforeInput+1, 'Range change must not duplicate input submission')
    await control('feather').focus()
    await page.keyboard.press('ArrowRight')
    assert.equal(await page.evaluate(() => fixture.snapshot.presentation.sdfFeatherTexels), 0.06)
    assert.equal(await page.evaluate(() => fixture.events.length), beforeInput+2, 'Keyboard range input submits once')
    await page.keyboard.press('End')
    assert.equal(await control('feather-value').textContent(), '0.35 texel')
    await control('boundary').selectOption('hard')
    assert.equal(await control('feather').isDisabled(), true)
    assert.equal(await control('feather').inputValue(), '0.35')
    await control('boundary').selectOption('sdf')
    assert.equal(await control('feather').isDisabled(), false)
    assert.equal(await control('feather').inputValue(), '0.35')

    await page.evaluate(() => {
        fixture.snapshot.presentation = {...fixture.snapshot.presentation,sdfFeatherTexels:0.123}
        fixture.controls.update(fixture.snapshot)
    })
    assert.equal(Number(await control('feather').inputValue()), 0.12,
        'The native range display may snap a valid non-step caller value')
    for (const [name,value] of [['boundary','hard'],['boundary','sdf'],['view','status'],['view','particles']]) {
        await control(name).selectOption(value)
        assert.equal(await page.evaluate(() => fixture.snapshot.presentation.sdfFeatherTexels), 0.123,
            'An unrelated display change must not adopt the range element rounding')
    }
    await control('feather').focus()
    await page.keyboard.press('End')
    assert.equal(await page.evaluate(() => fixture.snapshot.presentation.sdfFeatherTexels), 0.35,
        'An actual range input intentionally adopts its stepped value')

    await control('play-pause').click()
    assert.equal(await control('status').textContent(), 'Playing')
    await control('play-pause').click()
    assert.equal(await control('status').textContent(), 'Paused')
    await page.evaluate(() => {
        const time = document.querySelector('[data-flow-control="time"]')
        time.dispatchEvent(new PointerEvent('pointerdown'))
        time.value = '10.5'
        time.dispatchEvent(new Event('input', { bubbles: true }))
        fixture.snapshot.timeline.modelTime = 2.6
        fixture.controls.update(fixture.snapshot)
    })
    assert.equal(await control('time').inputValue(), '10.5', 'Incoming snapshots must not move a dragged thumb')
    assert.equal(await control('requested-label').textContent(), 'Seek preview')
    assert.equal(await page.evaluate(() => fixture.events.filter(event => event[0] === 'seek').length), 0, 'Preview must not create runtime requests')
    await control('time').dispatchEvent('change')
    assert.deepEqual(await page.evaluate(() => fixture.events.filter(event => event[0] === 'seek')), [ [ 'seek', 10.5 ] ])
    assert.equal(await control('requested-label').textContent(), 'Requested')

    await control('rate').selectOption('-1')
    await control('loop').selectOption('clamp')
    await control('view').selectOption('speed')
    assert.equal(await control('boundary').isDisabled(), true)
    assert.equal(await control('boundary').inputValue(), 'sdf')
    assert.equal(await control('feather').isDisabled(), true)
    assert.equal(await control('feather').inputValue(), '0.35')
    assert.equal(await control('sample').isDisabled(), false)
    assert.equal(await control('trails').isDisabled(), true)
    await control('sample').selectOption('delta')
    await control('contour').check()
    assert.deepEqual(await page.evaluate(() => fixture.snapshot.presentation), {
        view: 'speed', sample: 'delta', trails: true, contour: true, boundary: 'sdf', sdfFeatherTexels: 0.35,
    })
    await page.evaluate(() => { fixture.snapshot.state = 'loading'; fixture.controls.update(fixture.snapshot) })
    assert.equal(await control('time').isDisabled(), false, 'A loading seek must remain replaceable')
    assert.equal(await control('status').textContent(), 'Loading')
    await page.evaluate(() => { fixture.snapshot.state = 'gap'; fixture.controls.update(fixture.snapshot) })
    assert.equal(await control('status').textContent(), 'No data at this time')

    for (const width of [ 320, 768, 1024, 1440 ]) {
        await page.setViewportSize({ width, height: 720 })
        const layout = await page.evaluate(() => {
            const bounds = element => {
                const rect = element.getBoundingClientRect()
                return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
            }
            return {
                overflow: document.documentElement.scrollWidth > innerWidth,
                interactive: [ ...document.querySelectorAll('.flow-controls button, .flow-controls select, .flow-controls input') ].map(bounds),
                inspector: bounds(document.querySelector('.flow-inspector')),
                timeline: bounds(document.querySelector('.flow-timeline')),
                rate: bounds(document.querySelector('.flow-rate')),
                loop: bounds(document.querySelector('.flow-loop')),
            }
        })
        assert.equal(layout.overflow, false, `${width}px layout has no horizontal overflow`)
        assert.ok(layout.interactive.every(rect => rect.left >= 0 && rect.right <= width && rect.top >= 0 && rect.bottom <= 720), `${width}px controls remain inside viewport`)
        assert.ok(layout.inspector.bottom <= layout.timeline.top, `${width}px panels must not overlap`)
        assert.ok(layout.rate.right <= layout.loop.left || layout.rate.bottom <= layout.loop.top || layout.loop.bottom <= layout.rate.top, `${width}px transport controls must not overlap`)
    }
    await control('time').focus()
    await page.keyboard.press('ArrowRight')
    assert.equal(await page.evaluate(() => fixture.events.filter(event => event[0] === 'seek').length), 2, 'Keyboard seeking commits')
    await page.evaluate(() => fixture.controls.setStatus('failed', new Error('<b>Load failed</b>')))
    assert.equal(await control('error').textContent(), '<b>Load failed</b>')
    assert.equal(await control('error').locator('b').count(), 0, 'Errors are rendered as text')
    await page.evaluate(() => { fixture.snapshot.state = 'ready'; fixture.controls.update(fixture.snapshot) })
    assert.equal(await control('status').textContent(), 'Unable to render', 'Ordinary snapshots do not erase action failures')
    assert.equal(await control('play-pause').isDisabled(), true)
    await page.evaluate(() => fixture.controls.setStatus('ready'))
    assert.equal(await control('error').isHidden(), true)
    const disposal = await page.evaluate(() => {
        const button = document.querySelector('[data-flow-control="play-pause"]')
        const feather = document.querySelector('[data-flow-control="feather"]')
        const eventCount = fixture.events.length
        fixture.controls.dispose()
        fixture.controls.dispose()
        button.click()
        feather.dispatchEvent(new Event('input'))
        fixture.controls.update(fixture.snapshot)
        return { detachedEvents: fixture.events.length - eventCount, roots: document.querySelectorAll('.flow-controls').length, existing: document.querySelector('#existing') !== null }
    })
    assert.deepEqual(disposal, { detachedEvents: 0, roots: 0, existing: true })
    assert.deepEqual(errors, [])
    process.stdout.write(`${JSON.stringify({ status: 'passed', widths: [ 320, 768, 1024, 1440 ], source: fileURLToPath(sourceRoot), checks: [ 'loading', 'play-pause', 'seek-preview', 'single-seek', 'signed-rate', 'presentation', 'feather-input-once', 'feather-keyboard', 'feather-retained-disabled', 'feather-nonstep-preserved', 'gap', 'responsive', 'keyboard', 'error', 'dispose' ] }, null, 2)}\n`)
} finally {
    await browser?.close()
    await new Promise(resolve => server.close(resolve))
}
