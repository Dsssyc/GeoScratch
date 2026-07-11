import process from 'node:process'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

const baseUrl = process.env.SCRATCH_BROWSER_BASE_URL ?? 'http://127.0.0.1:4173'
const outputDirectory = resolve(
    process.env.SCRATCH_BROWSER_OUTPUT ?? '/tmp/geoscratch-gpu-operation-provenance-browser'
)
const headless = process.env.SCRATCH_BROWSER_HEADLESS === '1'
const timeout = Number(process.env.SCRATCH_BROWSER_TIMEOUT_MS ?? 30_000)

const examples = [
    { name: 'textureResize', selector: 'body', status: 'passed' },
    { name: 'submissionOrder', selector: 'body', status: 'passed' },
    { name: 'externalImageUpload', selector: 'body', status: 'passed' },
    { name: 'readinessPolicies', selector: '#GPUFrame', status: 'ready' },
    { name: 'indirectExecution', selector: '#GPUFrame', status: 'ready' },
    { name: 'scratch_textureSampling', selector: '#GPUFrame', status: 'ready' },
    { name: 'scratch_renderToTexture', selector: '#GPUFrame', status: 'ready' },
]

await mkdir(outputDirectory, { recursive: true })
const browser = await chromium.launch({
    channel: 'chrome',
    headless,
    args: [ '--enable-unsafe-webgpu' ],
})

try {
    const result = {
        schemaVersion: 1,
        browserVersion: await browser.version(),
        headless,
        baseUrl,
        outputDirectory,
        adapter: await inspectAdapter(browser),
        allocationProbe: await measureAllocations(browser),
        desktop: [],
        mobile: undefined,
    }

    const desktopContext = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
    })
    for (const example of examples) {
        result.desktop.push(await verifyExample(desktopContext, example, 'desktop'))
    }
    await desktopContext.close()

    const mobileContext = await browser.newContext({
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 1,
        isMobile: true,
    })
    result.mobile = await verifyExample(
        mobileContext,
        examples.find(example => example.name === 'textureResize'),
        'mobile'
    )
    await mobileContext.close()

    const failures = [
        ...(result.adapter.available === true && result.adapter.adapterAvailable === true
            ? []
            : [ 'adapter: WebGPU adapter is unavailable' ]),
        ...result.allocationProbe.failures.map(failure => `allocation-probe: ${failure}`),
        ...[ ...result.desktop, result.mobile ]
            .flatMap(entry => entry.failures.map(failure => `${entry.name}/${entry.viewport}: ${failure}`)),
    ]
    result.status = failures.length === 0 ? 'passed' : 'failed'
    result.failures = failures

    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    if (failures.length > 0) process.exitCode = 1
} finally {
    await browser.close()
}

async function inspectAdapter(browser) {

    const context = await browser.newContext()
    const page = await context.newPage()
    await page.goto(`${baseUrl}/textureResize/index.html`, { waitUntil: 'domcontentloaded', timeout })
    const adapter = await page.evaluate(async () => {
        if (!navigator.gpu) return { available: false }
        const gpuAdapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
        if (!gpuAdapter) return { available: true, adapterAvailable: false }
        const info = gpuAdapter.info ?? {}
        return {
            available: true,
            adapterAvailable: true,
            info: {
                vendor: info.vendor ?? '',
                architecture: info.architecture ?? '',
                device: info.device ?? '',
                description: info.description ?? '',
            },
            features: [ ...gpuAdapter.features ].sort(),
            limits: {
                maxBufferSize: gpuAdapter.limits.maxBufferSize,
                maxTextureDimension2D: gpuAdapter.limits.maxTextureDimension2D,
                maxTextureArrayLayers: gpuAdapter.limits.maxTextureArrayLayers,
            },
        }
    })
    await context.close()
    return adapter
}

async function measureAllocations(browser) {

    const context = await browser.newContext()
    const page = await context.newPage()
    const consoleFailures = []
    const pageErrors = []
    const requestFailures = []
    page.on('console', message => {
        if (message.type() === 'error' || message.type() === 'warning') {
            consoleFailures.push({ type: message.type(), text: message.text() })
        }
    })
    page.on('pageerror', error => pageErrors.push(error.message))
    page.on('requestfailed', request => {
        requestFailures.push({
            url: request.url(),
            errorText: request.failure()?.errorText ?? 'unknown',
        })
    })
    await page.goto(`${baseUrl}/textureResize/index.html`, { waitUntil: 'domcontentloaded', timeout })

    const moduleUrl = `${baseUrl}/@fs${resolve('packages/geoscratch/dist/index.js')}`
    const diagnosticsModuleUrl = `${baseUrl}/@fs${resolve(
        'packages/geoscratch/dist/scratch/runtime-diagnostics.js'
    )}`
    const measurement = await page.evaluate(async ({ moduleUrl, diagnosticsModuleUrl }) => {
        const { ScratchRuntime } = await import(moduleUrl)
        const { diagnosticsControllerFor } = await import(diagnosticsModuleUrl)
        const runtime = await ScratchRuntime.create({ label: 'browser allocation measurement' })
        const warmup = 8
        const iterations = 64

        for (let index = 0; index < warmup; index++) {
            const buffer = await runtime.createBuffer({ size: 4, usage: GPUBufferUsage.COPY_DST })
            buffer.dispose()
        }

        const issue = []
        const settlement = []
        const total = []
        for (let index = 0; index < iterations; index++) {
            const startedAt = performance.now()
            const allocation = runtime.createBuffer({ size: 4, usage: GPUBufferUsage.COPY_DST })
            const issuedAt = performance.now()
            const buffer = await allocation
            const settledAt = performance.now()

            issue.push(issuedAt - startedAt)
            settlement.push(settledAt - issuedAt)
            total.push(settledAt - startedAt)
            buffer.dispose()
        }

        const evidence = runtime.diagnostics.exportEvidence()
        const summarize = values => {
            const sorted = [ ...values ].sort((left, right) => left - right)
            const middle = Math.floor(sorted.length / 2)
            const median = sorted.length % 2 === 0
                ? (sorted[middle - 1] + sorted[middle]) / 2
                : sorted[middle]
            return {
                median,
                min: sorted[0],
                max: sorted.at(-1),
            }
        }
        const result = {
            warmup,
            iterations,
            issueMs: summarize(issue),
            settlementMs: summarize(settlement),
            totalMs: summarize(total),
            diagnostics: {
                retainedOperationCount: evidence.operations.length,
                retainedIncidentCount: evidence.incidents.length,
                retainedEvidenceBytes: evidence.snapshot.recorder.retainedEvidenceBytes,
                pendingOperationCount: evidence.snapshot.pendingOperations.length,
                liveResourceCount: evidence.snapshot.resources.length,
                lifecycleSubscriberCount: diagnosticsControllerFor(runtime).lifecycleSubscriberCount,
                allocationAttempts: evidence.snapshot.aggregates.allocationAttempts,
                successfulAllocations: evidence.snapshot.aggregates.successfulAllocations,
                operationKinds: Object.fromEntries(
                    [ ...new Set(evidence.operations.map(operation => operation.kind)) ]
                        .sort()
                        .map(kind => [
                            kind,
                            evidence.operations.filter(operation => operation.kind === kind).length,
                        ])
                ),
                allOperationsSucceeded: evidence.operations.every(operation => (
                    operation.status === 'succeeded'
                )),
                defaultStacksOmitted: evidence.operations.every(operation => (
                    operation.stack === undefined
                )),
                defaultFullDescriptorsOmitted: evidence.operations.every(operation => (
                    operation.descriptor.full === undefined
                )),
            },
        }
        runtime.dispose()
        return result
    }, { moduleUrl, diagnosticsModuleUrl })

    await page.close()
    await context.close()
    const expectedOperations = (measurement.warmup + measurement.iterations) * 2
    const failures = []
    if (consoleFailures.length > 0) failures.push(`${consoleFailures.length} console warning/error messages`)
    if (pageErrors.length > 0) failures.push(`${pageErrors.length} page errors`)
    if (requestFailures.length > 0) failures.push(`${requestFailures.length} request failures`)
    if (measurement.diagnostics.retainedOperationCount !== expectedOperations) {
        failures.push(
            `retained ${measurement.diagnostics.retainedOperationCount} operations, expected ${expectedOperations}`
        )
    }
    if (measurement.diagnostics.retainedIncidentCount !== 0) failures.push('retained diagnostic incidents')
    if (measurement.diagnostics.pendingOperationCount !== 0) failures.push('retained pending operations')
    if (measurement.diagnostics.liveResourceCount !== 0) failures.push('retained live resources')
    if (measurement.diagnostics.lifecycleSubscriberCount !== 0) failures.push('retained lifecycle subscribers')
    if (measurement.diagnostics.allocationAttempts !== measurement.warmup + measurement.iterations) {
        failures.push('allocation-attempt aggregate does not match issued allocations')
    }
    if (measurement.diagnostics.successfulAllocations !== measurement.warmup + measurement.iterations) {
        failures.push('successful-allocation aggregate does not match resolved allocations')
    }
    if (measurement.diagnostics.operationKinds['buffer-allocation'] !== measurement.warmup + measurement.iterations) {
        failures.push('buffer-allocation operation count is incomplete')
    }
    if (measurement.diagnostics.operationKinds['resource-disposal'] !== measurement.warmup + measurement.iterations) {
        failures.push('resource-disposal operation count is incomplete')
    }
    if (!measurement.diagnostics.allOperationsSucceeded) failures.push('one or more operations did not succeed')
    if (!measurement.diagnostics.defaultStacksOmitted) failures.push('default records retained stacks')
    if (!measurement.diagnostics.defaultFullDescriptorsOmitted) {
        failures.push('default records retained full descriptors')
    }
    return {
        ...measurement,
        moduleUrl,
        consoleFailures,
        pageErrors,
        requestFailures,
        failures,
    }
}

async function verifyExample(context, example, viewport) {

    const page = await context.newPage()
    const consoleFailures = []
    const pageErrors = []
    const requestFailures = []

    page.on('console', message => {
        if (message.type() === 'error' || message.type() === 'warning') {
            consoleFailures.push({ type: message.type(), text: message.text() })
        }
    })
    page.on('pageerror', error => pageErrors.push(error.message))
    page.on('requestfailed', request => {
        requestFailures.push({
            url: request.url(),
            errorText: request.failure()?.errorText ?? 'unknown',
        })
    })

    const url = `${baseUrl}/${example.name}/index.html`
    let navigationError
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout })
        await page.waitForFunction(
            ({ selector, status }) => document.querySelector(selector)?.dataset.status === status,
            { selector: example.selector, status: example.status },
            { timeout }
        )
        await page.waitForTimeout(250)
    } catch (error) {
        navigationError = error instanceof Error ? error.message : String(error)
    }

    const facts = await page.evaluate(({ selector }) => {
        const statusTarget = document.querySelector(selector)
        const canvas = document.querySelector('#GPUFrame')
        const rectangle = canvas?.getBoundingClientRect()
        return {
            status: statusTarget?.dataset.status ?? 'missing',
            bodyDataset: { ...document.body.dataset },
            canvasDataset: canvas instanceof HTMLElement ? { ...canvas.dataset } : {},
            canvas: canvas instanceof HTMLCanvasElement && rectangle !== undefined
                ? {
                    width: canvas.width,
                    height: canvas.height,
                    clientWidth: rectangle.width,
                    clientHeight: rectangle.height,
                }
                : undefined,
            layout: {
                innerWidth: window.innerWidth,
                innerHeight: window.innerHeight,
                scrollWidth: document.documentElement.scrollWidth,
                scrollHeight: document.documentElement.scrollHeight,
            },
        }
    }, { selector: example.selector })

    const screenshot = resolve(outputDirectory, `${example.name}-${viewport}.png`)
    const canvasScreenshot = resolve(outputDirectory, `${example.name}-${viewport}-canvas.png`)
    let visual
    let visualError
    if (facts.canvas !== undefined) {
        try {
            const canvasPng = await page.locator('#GPUFrame').screenshot({ path: canvasScreenshot })
            visual = await analyzeScreenshotPixels(page, canvasPng.toString('base64'))
        } catch (error) {
            visualError = error instanceof Error ? error.message : String(error)
        }
    }
    await page.screenshot({ path: screenshot, fullPage: true })
    await page.close()

    const failures = []
    if (navigationError !== undefined) failures.push(navigationError)
    if (facts.status !== example.status) failures.push(`status ${facts.status}, expected ${example.status}`)
    if (facts.canvas === undefined || facts.canvas.width <= 0 || facts.canvas.height <= 0) {
        failures.push('canvas is missing or empty')
    }
    if (visualError !== undefined) failures.push(`canvas pixel inspection failed: ${visualError}`)
    if (
        visual !== undefined &&
        (visual.quantizedColorCount < 2 || visual.luminanceRange < 4)
    ) {
        failures.push(
            `canvas appears blank (${visual.quantizedColorCount} sampled colors, ` +
            `${visual.luminanceRange} luminance range)`
        )
    }
    if (facts.layout.scrollWidth > facts.layout.innerWidth) failures.push('horizontal viewport overflow')
    if (consoleFailures.length > 0) failures.push(`${consoleFailures.length} console warning/error messages`)
    if (pageErrors.length > 0) failures.push(`${pageErrors.length} page errors`)
    if (requestFailures.length > 0) failures.push(`${requestFailures.length} request failures`)

    if (example.name === 'textureResize') {
        const booleanFacts = Object.entries(facts.bodyDataset)
            .filter(([ key, value ]) => value === 'true' || value === 'false')
        const failedFacts = booleanFacts.filter(([, value ]) => value !== 'true').map(([ key ]) => key)
        if (booleanFacts.length < 21) failures.push(`only ${booleanFacts.length} boolean proof facts`)
        if (failedFacts.length > 0) failures.push(`failed proof facts: ${failedFacts.join(', ')}`)
        if (facts.bodyDataset.textureAllocationOperationCount !== '2') {
            failures.push('texture allocation diagnostics did not retain exactly two operations')
        }
        if (facts.bodyDataset.diagnosticIncidentCount !== '0') {
            failures.push('successful proof retained a diagnostic incident')
        }
    }

    return {
        name: example.name,
        viewport,
        url,
        expectedStatus: example.status,
        facts,
        consoleFailures,
        pageErrors,
        requestFailures,
        screenshot,
        canvasScreenshot,
        visual,
        failures,
    }
}

async function analyzeScreenshotPixels(page, base64Png) {

    return page.evaluate(async encoded => {
        const image = new Image()
        image.src = `data:image/png;base64,${encoded}`
        await image.decode()

        const scale = Math.min(1, 256 / Math.max(image.naturalWidth, image.naturalHeight))
        const width = Math.max(1, Math.round(image.naturalWidth * scale))
        const height = Math.max(1, Math.round(image.naturalHeight * scale))
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const context = canvas.getContext('2d', { willReadFrequently: true })
        context.drawImage(image, 0, 0, width, height)
        const pixels = context.getImageData(0, 0, width, height).data
        const step = Math.max(1, Math.floor((width * height) / 8_192))
        const colors = new Set()
        let minLuminance = 255
        let maxLuminance = 0
        let sampledPixelCount = 0

        for (let pixel = 0; pixel < width * height; pixel += step) {
            const offset = pixel * 4
            const red = pixels[offset]
            const green = pixels[offset + 1]
            const blue = pixels[offset + 2]
            const alpha = pixels[offset + 3]
            if (alpha === 0) continue
            colors.add(`${red >> 4}:${green >> 4}:${blue >> 4}:${alpha >> 4}`)
            const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue
            minLuminance = Math.min(minLuminance, luminance)
            maxLuminance = Math.max(maxLuminance, luminance)
            sampledPixelCount++
        }

        return {
            width,
            height,
            sampledPixelCount,
            quantizedColorCount: colors.size,
            luminanceRange: sampledPixelCount === 0 ? 0 : maxLuminance - minLuminance,
        }
    }, base64Png)
}
