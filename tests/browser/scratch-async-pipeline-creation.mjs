import process from 'node:process'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

const baseUrl = process.env.SCRATCH_PIPELINE_BROWSER_BASE_URL ?? 'http://127.0.0.1:4173'
const outputDirectory = resolve(
    process.env.SCRATCH_PIPELINE_BROWSER_OUTPUT ?? '/tmp/geoscratch-async-pipeline-browser'
)
const headless = process.env.SCRATCH_PIPELINE_BROWSER_HEADLESS === '1'
const timeout = Number(process.env.SCRATCH_PIPELINE_BROWSER_TIMEOUT_MS ?? 30_000)
const examples = Object.freeze([
    { name: 'helloTriangle' },
    { name: 'helloVertexBuffer' },
    { name: 'uniformTriangle' },
    {
        name: 'computeReadback',
        textSelector: '#readback-result',
        expectedText: 'GPU result: 2, 4, 6, 8',
    },
    { name: 'textureSampling', statusSelector: '#GPUFrame', expectedStatus: 'ready' },
    { name: 'renderToTexture', statusSelector: '#GPUFrame', expectedStatus: 'ready' },
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
        pipelineProbe: await verifyPipelineTransactions(browser),
        examples: [],
    }
    const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
    })
    for (const example of examples) {
        result.examples.push(await verifyExample(context, example))
    }
    await context.close()

    const failures = [
        ...(result.adapter.available && result.adapter.adapterAvailable
            ? []
            : [ 'adapter: WebGPU adapter is unavailable' ]),
        ...result.pipelineProbe.failures.map(failure => `pipeline-probe: ${failure}`),
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
    await page.goto(`${baseUrl}/helloTriangle/index.html`, {
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
                maxBindGroups: value.limits.maxBindGroups,
                maxColorAttachments: value.limits.maxColorAttachments,
                maxComputeInvocationsPerWorkgroup: value.limits.maxComputeInvocationsPerWorkgroup,
            },
        }
    })
    await context.close()
    return adapter
}

async function verifyPipelineTransactions(browser) {

    const context = await browser.newContext()
    const page = await context.newPage()
    const consoleFailures = []
    const pageErrors = []
    const requestFailures = []
    attachFailureListeners(page, consoleFailures, pageErrors, requestFailures)
    await page.goto(`${baseUrl}/helloTriangle/index.html`, {
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
    const pipelineOwnershipModuleUrl = `${baseUrl}/@fs${resolve(
        'packages/geoscratch/dist/scratch/pipeline-ownership.js'
    )}`
    const probe = await page.evaluate(async ({
        runtimeModuleUrl,
        diagnosticModuleUrl,
        diagnosticsModuleUrl,
        pipelineOwnershipModuleUrl,
    }) => {
        const { ScratchRuntime } = await import(runtimeModuleUrl)
        const { ScratchDiagnosticError } = await import(diagnosticModuleUrl)
        const { diagnosticsControllerFor } = await import(diagnosticsModuleUrl)
        const { runtimePipelineCount } = await import(pipelineOwnershipModuleUrl)
        const runtime = await ScratchRuntime.create({ label: 'browser async pipeline probe' })
        const uncaptured = []
        runtime.device.addEventListener('uncapturederror', event => {
            uncaptured.push({
                name: event.error?.constructor?.name ?? 'unknown',
                message: event.error?.message ?? '',
            })
        })

        const renderSource = `
            @vertex
            fn vsMain(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
                let positions = array(
                    vec2f(0.0, 0.5),
                    vec2f(-0.5, -0.5),
                    vec2f(0.5, -0.5)
                );
                return vec4f(positions[index], 0.0, 1.0);
            }

            @fragment
            fn fsMain() -> @location(0) vec4f {
                return vec4f(0.2, 0.7, 0.5, 1.0);
            }
        `
        const computeSource = `
            @compute @workgroup_size(1)
            fn csMain() {}
        `
        const renderModule = await runtime.createShaderModule({
            label: 'browser render module',
            sourceParts: [ { code: renderSource } ],
        })
        const computeModule = await runtime.createShaderModule({
            label: 'browser compute module',
            sourceParts: [ { code: computeSource } ],
        })
        const renderProgram = runtime.createProgram({
            label: 'browser render program',
            vertex: { module: renderModule, entryPoint: 'vsMain' },
            fragment: { module: renderModule, entryPoint: 'fsMain' },
        })
        const computeProgram = runtime.createProgram({
            label: 'browser compute program',
            compute: { module: computeModule, entryPoint: 'csMain' },
        })

        const samples = []
        for (const sample of [
            { name: 'render-cold', kind: 'render', program: renderProgram, module: renderModule, cacheDependent: true },
            { name: 'render-warm', kind: 'render', program: renderProgram, module: renderModule, cacheDependent: true },
            { name: 'compute-cold', kind: 'compute', program: computeProgram, module: computeModule, cacheDependent: true },
            { name: 'compute-warm', kind: 'compute', program: computeProgram, module: computeModule, cacheDependent: true },
        ]) {
            const startedAt = performance.now()
            const pending = sample.kind === 'render'
                ? runtime.createRenderPipeline({
                    label: sample.name,
                    program: sample.program,
                    targets: [ { format: 'bgra8unorm' } ],
                })
                : runtime.createComputePipeline({
                    label: sample.name,
                    program: sample.program,
                })
            const issuedAt = performance.now()
            const pipeline = await pending
            const settledAt = performance.now()
            const compilationReport = sample.module.compilationReport
            samples.push({
                name: sample.name,
                pipelineKind: sample.kind,
                cacheDependent: sample.cacheDependent,
                cpuIssueMs: issuedAt - startedAt,
                asyncSettlementMs: settledAt - issuedAt,
                totalMs: settledAt - startedAt,
                compilation: {
                    nativeMessageCount: compilationReport.nativeMessageCount,
                    errorCount: compilationReport.errorCount,
                    warningCount: compilationReport.warningCount,
                    infoCount: compilationReport.infoCount,
                    retainedEvidenceBytes: compilationReport.retainedEvidenceBytes,
                    frozen: Object.isFrozen(compilationReport),
                },
                creation: {
                    stageCount: pipeline.creationReport.stages.length,
                    frozen: Object.isFrozen(pipeline.creationReport),
                },
            })
            pipeline.dispose()
        }

        const invalidSource = `
            // PIPELINE_BROWSER_SOURCE_SENTINEL
            @vertex
            fn invalidVertex(
        `
        const invalidWgsl = await captureFailure(
            runtime.createShaderModule({
                label: 'browser invalid WGSL module',
                sourceParts: [ { code: invalidSource } ],
            }),
            ScratchDiagnosticError
        )
        const invalidDescriptor = await captureFailure(
            runtime.createRenderPipeline({
                label: 'browser invalid descriptor pipeline',
                program: renderProgram,
                targets: [ { format: 'bgra8unorm' } ],
                multisample: { count: 3 },
            }),
            ScratchDiagnosticError
        )

        await new Promise(resolve => setTimeout(resolve, 100))
        const evidence = runtime.diagnostics.exportEvidence()
        const evidenceJson = JSON.stringify(evidence)
        const snapshot = runtime.diagnostics.snapshot()
        const result = {
            samples,
            invalidWgsl,
            invalidDescriptor,
            uncaptured,
            diagnostics: {
                retainedOperationCount: evidence.operations.length,
                retainedIncidentCount: evidence.incidents.length,
                pendingOperationCount: snapshot.pendingOperations.length,
                livePipelineCount: snapshot.pipelines.length,
                runtimePipelineCount: runtimePipelineCount(runtime),
                lifecycleSubscriberCount: diagnosticsControllerFor(runtime).lifecycleSubscriberCount,
                pipelineCreationAttempts: snapshot.aggregates.pipelineCreationAttempts,
                successfulPipelineCreations: snapshot.aggregates.successfulPipelineCreations,
                failedPipelineCreations: snapshot.aggregates.failedPipelineCreations,
                pipelineDisposals: snapshot.aggregates.pipelineDisposals,
                sourceFree: !evidenceJson.includes(invalidSource),
                jsonRoundTrip: JSON.stringify(JSON.parse(evidenceJson)) === evidenceJson,
            },
        }
        runtime.dispose()
        return result

        async function captureFailure(promise, ErrorType) {
            try {
                await promise
                return { rejected: false }
            } catch (error) {
                return {
                    rejected: true,
                    scratchDiagnostic: error instanceof ErrorType,
                    name: error?.name ?? 'unknown',
                    diagnostic: error?.diagnostic,
                    incident: error?.incident,
                }
            }
        }
    }, {
        runtimeModuleUrl,
        diagnosticModuleUrl,
        diagnosticsModuleUrl,
        pipelineOwnershipModuleUrl,
    })

    await page.close()
    await context.close()

    const failures = []
    if (consoleFailures.length > 0) failures.push(`${consoleFailures.length} console warning/error messages`)
    if (pageErrors.length > 0) failures.push(`${pageErrors.length} page errors`)
    if (requestFailures.length > 0) failures.push(`${requestFailures.length} request failures`)
    if (probe.samples.length !== 4) failures.push('valid render/compute cold/warm sample count drifted')
    if (probe.samples.some(sample => !sample.compilation.frozen)) failures.push('a valid ShaderModule compilation report is mutable')
    if (probe.samples.some(sample => !sample.creation.frozen)) failures.push('a valid pipeline creation report is mutable')
    if (probe.samples.some(sample => sample.compilation.errorCount !== 0)) failures.push('a valid pipeline retained compilation errors')
    if (probe.samples.some(sample => sample.cacheDependent !== true)) failures.push('cold/warm sample lacks cache-dependent label')
    if (!isStructuredFailure(probe.invalidWgsl, 'supporting-object-failure')) {
        failures.push('invalid WGSL was not a structured supporting-object failure')
    }
    if (!outcomeCodes(probe.invalidWgsl).includes('SCRATCH_SHADER_MODULE_COMPILATION_FAILED')) {
        failures.push('invalid WGSL lacks structured compilation failure')
    }
    if ((probe.invalidWgsl.incident?.shaderModuleCompilationReport?.errorCount ?? 0) < 1) {
        failures.push('invalid WGSL lacks a populated compilation report')
    }
    if (!isStructuredFailure(probe.invalidDescriptor, 'pipeline-failure')) {
        failures.push('invalid pipeline descriptor was not a structured pipeline failure')
    }
    if (!outcomeCodes(probe.invalidDescriptor).includes('SCRATCH_PIPELINE_CREATION_VALIDATION_FAILED')) {
        failures.push('invalid descriptor lacks structured pipeline validation failure')
    }
    if (probe.invalidDescriptor.incident?.pipelineErrorReason !== 'validation') {
        failures.push('invalid descriptor lacks GPUPipelineError validation reason')
    }
    if (probe.uncaptured.length > 0) failures.push(`${probe.uncaptured.length} uncaptured WebGPU errors`)
    if (probe.diagnostics.pendingOperationCount !== 0) failures.push('retained pending pipeline operations')
    if (probe.diagnostics.livePipelineCount !== 0) failures.push('retained current pipeline facts')
    if (probe.diagnostics.runtimePipelineCount !== 0) failures.push('retained runtime pipeline wrappers')
    if (probe.diagnostics.lifecycleSubscriberCount !== 0) failures.push('retained lifecycle subscribers')
    if (probe.diagnostics.pipelineCreationAttempts !== 5) failures.push('pipeline-attempt aggregate drifted')
    if (probe.diagnostics.successfulPipelineCreations !== 4) failures.push('successful-pipeline aggregate drifted')
    if (probe.diagnostics.failedPipelineCreations !== 1) failures.push('failed-pipeline aggregate drifted')
    if (probe.diagnostics.pipelineDisposals !== 4) failures.push('pipeline-disposal aggregate drifted')
    if (!probe.diagnostics.sourceFree) failures.push('exported evidence retained complete WGSL source')
    if (!probe.diagnostics.jsonRoundTrip) failures.push('exported evidence failed JSON round trip')

    return {
        ...probe,
        runtimeModuleUrl,
        diagnosticModuleUrl,
        diagnosticsModuleUrl,
        consoleFailures,
        pageErrors,
        requestFailures,
        failures,
    }
}

function isStructuredFailure(value, expectedIncidentKind) {

    return value?.rejected === true &&
        value.scratchDiagnostic === true &&
        value.diagnostic?.severity === 'error' &&
        value.incident?.kind === expectedIncidentKind
}

function outcomeCodes(value) {

    return (value?.incident?.outcomes ?? []).map(outcome => outcome.diagnosticCode)
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

export async function analyzeScreenshotPixels(page, base64Png) {

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
