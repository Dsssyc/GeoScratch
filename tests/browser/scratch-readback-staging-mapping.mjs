import process from 'node:process'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

const baseUrl = process.env.SCRATCH_READBACK_BROWSER_BASE_URL ?? 'http://127.0.0.1:4173'
const outputDirectory = resolve(
    process.env.SCRATCH_READBACK_BROWSER_OUTPUT ?? '/tmp/geoscratch-readback-browser'
)
const headless = process.env.SCRATCH_READBACK_BROWSER_HEADLESS === '1'
const timeout = Number(process.env.SCRATCH_READBACK_BROWSER_TIMEOUT_MS ?? 30_000)
const examples = Object.freeze([
    { name: 'scratch_helloTriangle' },
    { name: 'scratch_helloVertexBuffer' },
    { name: 'scratch_uniformTriangle' },
    {
        name: 'scratch_computeReadback',
        textSelector: '#readback-result',
        expectedText: 'GPU result: 2, 4, 6, 8',
    },
    { name: 'scratch_textureSampling', statusSelector: '#GPUFrame', expectedStatus: 'ready' },
    { name: 'scratch_renderToTexture', statusSelector: '#GPUFrame', expectedStatus: 'ready' },
    { name: 'indirectExecution', statusSelector: '#GPUFrame', expectedStatus: 'ready' },
    { name: 'readinessPolicies', statusSelector: '#GPUFrame', expectedStatus: 'ready' },
    { name: 'submissionOrder', statusSelector: 'body', expectedStatus: 'passed' },
    { name: 'externalImageUpload', statusSelector: 'body', expectedStatus: 'passed' },
    { name: 'textureResize', statusSelector: 'body', expectedStatus: 'passed' },
])

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
        readbackProbe: await verifyReadbackTransactions(browser),
        examples: [],
    }
    const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
    })
    for (const example of examples) result.examples.push(await verifyExample(context, example))
    await context.close()

    const failures = [
        ...(result.adapter.available && result.adapter.adapterAvailable
            ? []
            : [ 'adapter: WebGPU adapter is unavailable' ]),
        ...result.readbackProbe.failures.map(failure => `readback-probe: ${failure}`),
        ...result.examples.flatMap(example => (
            example.failures.map(failure => `${example.name}: ${failure}`)
        )),
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
    await page.goto(`${baseUrl}/scratch_computeReadback/index.html`, {
        waitUntil: 'domcontentloaded',
        timeout,
    })
    const adapter = await page.evaluate(async () => {
        if (!navigator.gpu) return { available: false, adapterAvailable: false }
        const value = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
        if (!value) return { available: true, adapterAvailable: false }
        const info = value.info ?? {}
        return {
            available: true,
            adapterAvailable: true,
            info: {
                vendor: info.vendor ?? '',
                architecture: info.architecture ?? '',
                device: info.device ?? '',
                description: info.description ?? '',
            },
            features: [ ...value.features ].sort(),
            limits: {
                maxBufferSize: value.limits.maxBufferSize,
                maxStorageBufferBindingSize: value.limits.maxStorageBufferBindingSize,
            },
        }
    })
    await context.close()
    return adapter
}

async function verifyReadbackTransactions(browser) {

    const context = await browser.newContext()
    const page = await context.newPage()
    const consoleFailures = []
    const pageErrors = []
    const requestFailures = []
    attachFailureListeners(page, consoleFailures, pageErrors, requestFailures)
    await page.goto(`${baseUrl}/scratch_computeReadback/index.html`, {
        waitUntil: 'domcontentloaded',
        timeout,
    })

    const runtimeModuleUrl = `${baseUrl}/@fs${resolve(
        'packages/geoscratch/dist/scratch/runtime.js'
    )}`
    const diagnosticModuleUrl = `${baseUrl}/@fs${resolve(
        'packages/geoscratch/dist/scratch/diagnostics.js'
    )}`
    const diagnosticsModuleUrl = `${baseUrl}/@fs${resolve(
        'packages/geoscratch/dist/scratch/runtime-diagnostics.js'
    )}`
    const ownershipModuleUrl = `${baseUrl}/@fs${resolve(
        'packages/geoscratch/dist/scratch/readback-ownership.js'
    )}`
    const probe = await page.evaluate(async ({
        runtimeModuleUrl,
        diagnosticModuleUrl,
        diagnosticsModuleUrl,
        ownershipModuleUrl,
    }) => {
        const { ScratchRuntime } = await import(runtimeModuleUrl)
        const { ScratchDiagnosticError } = await import(diagnosticModuleUrl)
        const { diagnosticsControllerFor } = await import(diagnosticsModuleUrl)
        const {
            runtimeReadbackCommandCount,
            runtimeReadbackOperationCount,
        } = await import(ownershipModuleUrl)
        const runtime = await ScratchRuntime.create({
            label: 'browser readback provenance probe',
            readback: {
                maxPendingOperations: 16,
                maxStagingBytes: 1024 * 1024,
            },
        })
        const uncaptured = []
        runtime.device.addEventListener('uncapturederror', event => {
            uncaptured.push({
                name: event.error?.constructor?.name ?? 'unknown',
                message: event.error?.message ?? '',
            })
        })
        const source = await runtime.createBuffer({
            label: 'browser readback source',
            size: 16,
            usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
        })
        const upload = runtime.createUploadCommand({
            target: source,
            data: new Uint32Array([ 2, 4, 6, 8 ]),
        })
        const commandPromise = runtime.createReadbackCommand({
            label: 'browser ordered readback',
            source: { resource: source, contentEpoch: 1 },
            whenMissing: 'throw',
        })
        const factoryIsPromise = commandPromise instanceof Promise
        const commandFactsBeforeFactorySettlement = runtime.diagnostics.snapshot()
            .readbackCommands.length
        const command = await commandPromise
        const submitStartedAt = performance.now()
        const submitted = runtime.createSubmission().upload(upload).readback(command).submit()
        const submitReturnedAt = performance.now()
        const orderedOperation = command.result({ after: submitted })
        const orderedBytes = await orderedOperation.toBytes()
        await submitted.done
        const directOperation = runtime.createReadback({
            label: 'browser direct readback',
            source,
            after: submitted,
            retain: 'consume-on-read',
        })
        const directBytes = await directOperation.toBytes()
        const beforeCommandDispose = runtime.diagnostics.snapshot()
        const evidenceBeforeDispose = runtime.diagnostics.exportEvidence()
        const operationKinds = evidenceBeforeDispose.operations.map(operation => operation.kind)
        const mappingRecords = evidenceBeforeDispose.operations.filter(
            operation => operation.kind === 'readback-mapping'
        )
        const success = {
            factoryIsPromise,
            commandFactsBeforeFactorySettlement,
            submitReturnedSynchronously: typeof submitted?.then !== 'function',
            submitCallDurationMs: submitReturnedAt - submitStartedAt,
            submittedDoneIsPromise: typeof submitted.done?.then === 'function',
            orderedValues: Array.from(new Uint32Array(
                orderedBytes.buffer,
                orderedBytes.byteOffset,
                orderedBytes.byteLength / 4
            )),
            directValues: Array.from(new Uint32Array(
                directBytes.buffer,
                directBytes.byteOffset,
                directBytes.byteLength / 4
            )),
            orderedState: orderedOperation.state,
            directState: directOperation.state,
            readbackLinks: submitted.readbacks,
            linksFrozen: Object.isFrozen(submitted.readbacks) &&
                submitted.readbacks.every(Object.isFrozen),
            evidenceVersion: evidenceBeforeDispose.version,
            evidenceJsonRoundTrip: JSON.stringify(JSON.parse(JSON.stringify(evidenceBeforeDispose))) ===
                JSON.stringify(evidenceBeforeDispose),
            operationKinds,
            mappingStatuses: mappingRecords.map(operation => operation.status),
            incidentCount: evidenceBeforeDispose.incidents.length,
            beforeCommandDispose: summarizeSnapshot(beforeCommandDispose),
        }
        command.dispose()
        const afterCommandDispose = runtime.diagnostics.snapshot()
        success.afterCommandDispose = summarizeSnapshot(afterCommandDispose)
        success.runtimeReadbackOperationCount = runtimeReadbackOperationCount(runtime)
        success.runtimeReadbackCommandCount = runtimeReadbackCommandCount(runtime)
        success.lifecycleSubscriberCount = diagnosticsControllerFor(runtime).lifecycleSubscriberCount
        runtime.dispose()

        const budgetRuntime = await ScratchRuntime.create({
            label: 'browser readback budget probe',
            readback: { maxPendingOperations: 2, maxStagingBytes: 8 },
        })
        const budgetSource = await budgetRuntime.createBuffer({
            size: 16,
            usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
        })
        const budgetFailure = await captureFailure(
            budgetRuntime.createReadback({ source: budgetSource }).toBytes(),
            ScratchDiagnosticError
        )
        const budgetSnapshot = budgetRuntime.diagnostics.snapshot()
        budgetRuntime.dispose()

        return {
            success,
            budgetFailure,
            budgetTerminal: summarizeSnapshot(budgetSnapshot),
            uncaptured,
        }

        function summarizeSnapshot(snapshot) {
            return {
                pendingOperationCount: snapshot.pendingOperations.length,
                currentReadbackCount: snapshot.readbacks.length,
                currentCommandCount: snapshot.readbackCommands.length,
                currentStagingBytes: snapshot.readbackMemory.currentStagingBytes,
                currentRetainedHostBytes: snapshot.readbackMemory.currentRetainedHostBytes,
                activeMappings: snapshot.readbackMemory.activeMappings,
            }
        }

        async function captureFailure(promise, ErrorType) {
            try {
                await promise
                return { rejected: false }
            } catch (error) {
                return {
                    rejected: true,
                    scratchDiagnostic: error instanceof ErrorType,
                    diagnostic: error?.diagnostic,
                    incident: error?.incident,
                }
            }
        }
    }, {
        runtimeModuleUrl,
        diagnosticModuleUrl,
        diagnosticsModuleUrl,
        ownershipModuleUrl,
    })

    await page.close()
    await context.close()

    const failures = []
    const success = probe.success
    if (consoleFailures.length > 0) failures.push(`${consoleFailures.length} console warning/error messages`)
    if (pageErrors.length > 0) failures.push(`${pageErrors.length} page errors`)
    if (requestFailures.length > 0) failures.push(`${requestFailures.length} request failures`)
    if (!success.factoryIsPromise) failures.push('ordered factory did not return a Promise')
    if (success.commandFactsBeforeFactorySettlement !== 0) failures.push('ordered command was visible before acknowledgement')
    if (!success.submitReturnedSynchronously) failures.push('submit returned a thenable')
    if (!success.submittedDoneIsPromise) failures.push('SubmittedWork.done is not a Promise')
    if (!equalNumbers(success.orderedValues, [ 2, 4, 6, 8 ])) failures.push('ordered bytes drifted')
    if (!equalNumbers(success.directValues, [ 2, 4, 6, 8 ])) failures.push('direct bytes drifted')
    if (success.orderedState !== 'consumed') failures.push('ordered operation did not consume')
    if (success.directState !== 'consumed') failures.push('direct operation did not consume')
    if (success.readbackLinks.length !== 1) failures.push('submitted readback link count drifted')
    if (!success.linksFrozen) failures.push('submitted readback links are mutable')
    if (success.evidenceVersion !== 5) failures.push('readback evidence is not schema v5')
    if (!success.evidenceJsonRoundTrip) failures.push('readback evidence failed JSON round trip')
    for (const kind of [
        'readback-staging-allocation',
        'readback-mapping',
        'readback-staging-release',
    ]) {
        if (!success.operationKinds.includes(kind)) failures.push(`missing ${kind} operation`)
    }
    if (success.mappingStatuses.length !== 2 || success.mappingStatuses.some(status => status !== 'succeeded')) {
        failures.push('direct/ordered mapping statuses drifted')
    }
    if (success.incidentCount !== 0) failures.push(`${success.incidentCount} unexpected success incidents`)
    if (success.beforeCommandDispose.currentReadbackCount !== 0) failures.push('success retained readback operations')
    if (success.beforeCommandDispose.currentCommandCount !== 1) failures.push('ordered command fact disappeared early')
    if (success.beforeCommandDispose.currentStagingBytes !== 16) failures.push('ordered idle slot staging bytes drifted')
    if (!isTerminalSnapshot(success.afterCommandDispose)) failures.push('command disposal retained readback ownership')
    if (success.runtimeReadbackOperationCount !== 0) failures.push('runtime retained readback operations')
    if (success.runtimeReadbackCommandCount !== 0) failures.push('runtime retained readback commands')
    if (success.lifecycleSubscriberCount !== 0) failures.push('runtime retained lifecycle subscribers')
    if (!isStructuredBudgetFailure(probe.budgetFailure)) failures.push('budget failure was not structured')
    if (!isTerminalSnapshot(probe.budgetTerminal)) failures.push('budget failure retained readback ownership')
    if (probe.uncaptured.length > 0) failures.push(`${probe.uncaptured.length} uncaptured WebGPU errors`)

    return {
        ...probe,
        runtimeModuleUrl,
        diagnosticModuleUrl,
        diagnosticsModuleUrl,
        ownershipModuleUrl,
        consoleFailures,
        pageErrors,
        requestFailures,
        failures,
    }
}

function equalNumbers(actual, expected) {

    return actual.length === expected.length && actual.every((value, index) => value === expected[index])
}

function isTerminalSnapshot(snapshot) {

    return snapshot.pendingOperationCount === 0 &&
        snapshot.currentReadbackCount === 0 &&
        snapshot.currentCommandCount === 0 &&
        snapshot.currentStagingBytes === 0 &&
        snapshot.currentRetainedHostBytes === 0 &&
        snapshot.activeMappings === 0
}

function isStructuredBudgetFailure(value) {

    return value?.rejected === true &&
        value.scratchDiagnostic === true &&
        value.diagnostic?.code === 'SCRATCH_READBACK_STAGING_BUDGET_EXCEEDED' &&
        value.incident?.kind === 'readback-failure' &&
        value.incident?.failureStage === 'budget'
}

async function verifyExample(context, example) {

    const page = await context.newPage()
    const consoleFailures = []
    const pageErrors = []
    const requestFailures = []
    attachFailureListeners(page, consoleFailures, pageErrors, requestFailures)
    const url = `${baseUrl}/${example.name}/index.html`
    let navigationError
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout })
        if (example.statusSelector !== undefined) {
            await page.waitForFunction(
                ({ selector, status }) => document.querySelector(selector)?.dataset.status === status,
                { selector: example.statusSelector, status: example.expectedStatus },
                { timeout }
            )
        } else if (example.textSelector !== undefined) {
            await page.waitForFunction(
                ({ selector, text }) => document.querySelector(selector)?.textContent?.includes(text),
                { selector: example.textSelector, text: example.expectedText },
                { timeout }
            )
        } else {
            await page.waitForTimeout(1_000)
        }
        await page.waitForTimeout(250)
    } catch (error) {
        navigationError = error instanceof Error ? error.message : String(error)
    }

    const facts = await page.evaluate(({ statusSelector, textSelector }) => {
        const canvas = document.querySelector('#GPUFrame')
        const rectangle = canvas?.getBoundingClientRect()
        return {
            status: statusSelector === undefined
                ? undefined
                : document.querySelector(statusSelector)?.dataset.status,
            text: textSelector === undefined
                ? undefined
                : document.querySelector(textSelector)?.textContent,
            canvas: canvas instanceof HTMLCanvasElement && rectangle !== undefined
                ? {
                    width: canvas.width,
                    height: canvas.height,
                    clientWidth: rectangle.width,
                    clientHeight: rectangle.height,
                }
                : undefined,
            viewport: {
                innerWidth: window.innerWidth,
                scrollWidth: document.documentElement.scrollWidth,
            },
        }
    }, {
        statusSelector: example.statusSelector,
        textSelector: example.textSelector,
    })

    const screenshot = resolve(outputDirectory, `${example.name}.png`)
    const canvasScreenshot = resolve(outputDirectory, `${example.name}-canvas.png`)
    let visual
    let visualError
    if (facts.canvas !== undefined) {
        try {
            const png = await captureCanvasScreenshot(page, canvasScreenshot)
            visual = await analyzeScreenshotPixels(page, png.toString('base64'))
        } catch (error) {
            visualError = error instanceof Error ? error.message : String(error)
        }
    }
    await page.screenshot({ path: screenshot, fullPage: true })
    await page.close()

    const failures = []
    if (navigationError !== undefined) failures.push(navigationError)
    if (example.expectedStatus !== undefined && facts.status !== example.expectedStatus) {
        failures.push(`status ${facts.status ?? 'missing'}, expected ${example.expectedStatus}`)
    }
    if (example.expectedText !== undefined && !facts.text?.includes(example.expectedText)) {
        failures.push(`text ${facts.text ?? 'missing'}, expected ${example.expectedText}`)
    }
    if (facts.canvas === undefined || facts.canvas.width <= 0 || facts.canvas.height <= 0) {
        failures.push('canvas is missing or empty')
    }
    if (visualError !== undefined) failures.push(`canvas pixel inspection failed: ${visualError}`)
    if (visual !== undefined && (visual.quantizedColorCount < 2 || visual.luminanceRange < 4)) {
        failures.push(
            `canvas appears blank (${visual.quantizedColorCount} sampled colors, ` +
            `${visual.luminanceRange} luminance range)`
        )
    }
    if (facts.viewport.scrollWidth > facts.viewport.innerWidth) failures.push('horizontal viewport overflow')
    if (consoleFailures.length > 0) failures.push(`${consoleFailures.length} console warning/error messages`)
    if (pageErrors.length > 0) failures.push(`${pageErrors.length} page errors`)
    if (requestFailures.length > 0) failures.push(`${requestFailures.length} request failures`)

    return {
        name: example.name,
        url,
        expectedStatus: example.expectedStatus,
        expectedText: example.expectedText,
        facts,
        visual,
        consoleFailures,
        pageErrors,
        requestFailures,
        screenshot,
        canvasScreenshot,
        failures,
    }
}

async function captureCanvasScreenshot(page, path) {

    let lastError
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            return await page.locator('#GPUFrame').screenshot({ path })
        } catch (error) {
            lastError = error
            if (attempt === 0) await page.waitForTimeout(250)
        }
    }
    throw lastError
}

function attachFailureListeners(page, consoleFailures, pageErrors, requestFailures) {

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
