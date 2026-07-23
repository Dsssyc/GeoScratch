import process from 'node:process'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

const baseUrl = process.env.SCRATCH_BUFFER_MAPPING_BROWSER_BASE_URL ??
    'http://127.0.0.1:5173'
const outputDirectory = resolve(
    process.env.SCRATCH_BUFFER_MAPPING_BROWSER_OUTPUT ??
    '/tmp/geoscratch-buffer-mapping-browser'
)
const headless = process.env.SCRATCH_BUFFER_MAPPING_BROWSER_HEADLESS === '1'
const timeout = Number(process.env.SCRATCH_BUFFER_MAPPING_BROWSER_TIMEOUT_MS ?? 45_000)

await mkdir(outputDirectory, { recursive: true })
const browser = await chromium.launch({
    channel: 'chrome',
    headless,
    args: [ '--enable-unsafe-webgpu' ],
})

try {
    const adapter = await inspectAdapter(browser)
    let example
    let probe
    let browserError
    try {
        example = await verifyExample(browser)
        probe = await verifyMappingProbe(browser)
    } catch (error) {
        browserError = error instanceof Error ? error.stack ?? error.message : String(error)
    }
    const failures = validateResult(adapter, example, probe, browserError)
    const result = {
        schemaVersion: 1,
        browserVersion: await browser.version(),
        headless,
        baseUrl,
        outputDirectory,
        adapter,
        example,
        probe,
        browserError,
        status: failures.length === 0 ? 'passed' : 'failed',
        failures,
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    if (failures.length > 0) process.exitCode = 1
} finally {
    await browser.close()
}

async function inspectAdapter(browser) {

    const context = await browser.newContext()
    const page = await context.newPage()
    await page.goto(`${baseUrl}/bufferMapping/index.html`, {
        waitUntil: 'domcontentloaded',
        timeout,
    })
    const facts = await page.evaluate(async () => {
        if (!navigator.gpu) return { available: false, adapterAvailable: false }
        const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
        if (!adapter) return { available: true, adapterAvailable: false }
        const info = adapter.info ?? {}
        return {
            available: true,
            adapterAvailable: true,
            info: {
                vendor: info.vendor ?? '',
                architecture: info.architecture ?? '',
                device: info.device ?? '',
                description: info.description ?? '',
            },
            features: [ ...adapter.features ].sort(),
            limits: {
                maxBufferSize: adapter.limits.maxBufferSize,
            },
        }
    })
    await context.close()
    return facts
}

async function verifyExample(browser) {

    const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
    })
    const page = await context.newPage()
    const consoleFailures = []
    const pageErrors = []
    const requestFailures = []
    attachFailureListeners(page, consoleFailures, pageErrors, requestFailures)
    await page.goto(`${baseUrl}/bufferMapping/index.html`, {
        waitUntil: 'domcontentloaded',
        timeout,
    })
    await page.waitForFunction(
        () => document.body.dataset.status !== 'pending',
        undefined,
        { timeout }
    )
    const facts = await page.evaluate(() => ({
        status: document.body.dataset.status,
        result: document.body.dataset.result,
        writeViewDetached: document.body.dataset.writeViewDetached,
        readViewDetached: document.body.dataset.readViewDetached,
        sourceEpoch: document.body.dataset.sourceEpoch,
        targetEpoch: document.body.dataset.targetEpoch,
    }))
    await page.screenshot({
        path: resolve(outputDirectory, 'buffer-mapping-example.png'),
        fullPage: true,
    })
    await context.close()
    return { ...facts, consoleFailures, pageErrors, requestFailures }
}

async function verifyMappingProbe(browser) {

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
    const moduleUrl = `${baseUrl}/@fs${resolve('packages/geoscratch/dist/index.js')}`
    const facts = await page.evaluate(async ({ moduleUrl }) => {
        const {
            ScratchDiagnosticError,
            ScratchRuntime,
        } = await import(moduleUrl)
        const runtime = await ScratchRuntime.create({
            label: 'browser buffer mapping probe',
            diagnostics: {
                operationCapacity: 16,
                incidentCapacity: 8,
                evidenceByteCapacity: 64 * 1024,
            },
        })
        const uncaptured = []
        const onUncaptured = event => uncaptured.push({
            name: event.error?.constructor?.name ?? event.error?.name ?? 'unknown',
            message: event.error?.message ?? String(event.error),
        })
        runtime.device.addEventListener('uncapturederror', onUncaptured)

        try {
            const readBuffer = await runtime.createBuffer({
                label: 'browser mapped read buffer',
                size: 16,
                usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
            })
            const firstPromise = runtime.mapBuffer({
                region: readBuffer.region(),
                mode: 'read',
            })
            const conflict = await captureAsync(
                runtime.mapBuffer({ region: readBuffer.region(), mode: 'read' }),
                ScratchDiagnosticError
            )
            const firstLease = await firstPromise
            const firstView = firstLease.view
            const upload = runtime.createUploadCommand({
                label: 'mapped GPU-use conflict',
                target: readBuffer.region(),
                data: new Uint8Array(16),
            })
            const gpuUseConflict = captureSync(
                () => upload.execute(runtime.queue),
                ScratchDiagnosticError
            )
            const activeSnapshot = runtime.diagnostics.snapshot()
            firstLease.dispose()

            const writeBuffer = await runtime.createBuffer({
                label: 'browser mapped write buffer',
                size: 16,
                usage: GPUBufferUsage.MAP_WRITE | GPUBufferUsage.COPY_SRC,
            })
            const writeLease = await runtime.mapBuffer({
                region: writeBuffer.region(),
                mode: 'write',
            })
            const writeView = writeLease.view
            new Uint32Array(writeView)[0] = 21
            writeLease.dispose()
            writeLease.dispose()

            const abortBuffer = await runtime.createBuffer({
                label: 'browser abort buffer',
                size: 16,
                usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
            })
            const controller = new AbortController()
            const abortPromise = runtime.mapBuffer({
                region: abortBuffer.region(),
                mode: 'read',
                signal: controller.signal,
            })
            controller.abort()
            const aborted = await captureAsync(abortPromise, ScratchDiagnosticError)
            const terminalSnapshot = runtime.diagnostics.snapshot()
            const evidence = runtime.diagnostics.exportEvidence()

            return {
                conflict,
                gpuUseConflict,
                aborted,
                firstViewDetached: firstView.byteLength === 0,
                writeViewDetached: writeView.byteLength === 0,
                readEpoch: readBuffer.contentEpoch,
                writeEpoch: writeBuffer.contentEpoch,
                active: {
                    mappings: activeSnapshot.bufferMapping.currentMappings,
                    selectedBytes: activeSnapshot.bufferMapping.currentSelectedBytes,
                    readbackMappings: activeSnapshot.readbackMemory.activeMappings,
                },
                terminal: {
                    mappings: terminalSnapshot.bufferMapping.currentMappings,
                    selectedBytes: terminalSnapshot.bufferMapping.currentSelectedBytes,
                    pendingOperations: terminalSnapshot.pendingOperations.length,
                    readbackMappings: terminalSnapshot.readbackMemory.activeMappings,
                    retainedOperations: terminalSnapshot.recorder.retainedOperationCount,
                    retainedIncidents: terminalSnapshot.recorder.retainedIncidentCount,
                    retainedEvidenceBytes: terminalSnapshot.recorder.retainedEvidenceBytes,
                },
                evidenceVersion: evidence.version,
                evidenceJsonRoundTrip:
                    JSON.stringify(JSON.parse(JSON.stringify(evidence))) ===
                    JSON.stringify(evidence),
                uncaptured,
            }
        } finally {
            runtime.device.removeEventListener('uncapturederror', onUncaptured)
            runtime.dispose()
        }

        async function captureAsync(promise, ErrorType) {
            try {
                await promise
                return { rejected: false }
            } catch (error) {
                return {
                    rejected: true,
                    scratchDiagnostic: error instanceof ErrorType,
                    code: error?.diagnostic?.code,
                }
            }
        }

        function captureSync(callback, ErrorType) {
            try {
                callback()
                return { threw: false }
            } catch (error) {
                return {
                    threw: true,
                    scratchDiagnostic: error instanceof ErrorType,
                    code: error?.diagnostic?.code,
                }
            }
        }
    }, { moduleUrl })
    await context.close()
    return {
        ...facts,
        moduleUrl,
        consoleFailures,
        pageErrors,
        requestFailures,
    }
}

function validateResult(adapter, example, probe, browserError) {

    const failures = []
    if (!adapter.available || !adapter.adapterAvailable) failures.push('WebGPU adapter is unavailable')
    if (browserError !== undefined) failures.push(`browser proof threw: ${browserError}`)
    if (example === undefined || probe === undefined) return failures

    if (example.status !== 'passed') failures.push(`example status was ${example.status}`)
    if (example.result !== '3,5,8,13') failures.push(`example values were ${example.result}`)
    if (example.writeViewDetached !== 'true') failures.push('example WRITE view did not detach')
    if (example.readViewDetached !== 'true') failures.push('example READ view did not detach')
    if (example.sourceEpoch !== '1' || example.targetEpoch !== '1') {
        failures.push('example content epochs drifted')
    }
    appendPageFailures(failures, 'example', example)
    appendPageFailures(failures, 'probe', probe)
    if (probe.uncaptured.length > 0) failures.push(`${probe.uncaptured.length} uncaptured WebGPU errors`)
    if (
        !probe.conflict.rejected ||
        !probe.conflict.scratchDiagnostic ||
        probe.conflict.code !== 'SCRATCH_BUFFER_MAPPING_CONFLICT'
    ) failures.push('concurrent mapping conflict was not structured')
    if (
        !probe.gpuUseConflict.threw ||
        !probe.gpuUseConflict.scratchDiagnostic ||
        probe.gpuUseConflict.code !== 'SCRATCH_BUFFER_MAPPING_GPU_USE_CONFLICT'
    ) failures.push('mapped GPU use was not rejected locally')
    if (
        !probe.aborted.rejected ||
        !probe.aborted.scratchDiagnostic ||
        probe.aborted.code !== 'SCRATCH_BUFFER_MAPPING_ABORTED'
    ) failures.push('AbortSignal cancellation was not structured')
    if (!probe.firstViewDetached || !probe.writeViewDetached) {
        failures.push('probe mapped views did not detach')
    }
    if (probe.readEpoch !== 0 || probe.writeEpoch !== 1) {
        failures.push('probe READ/WRITE epoch semantics drifted')
    }
    if (
        probe.active.mappings !== 1 ||
        probe.active.selectedBytes !== 16 ||
        probe.active.readbackMappings !== 0
    ) failures.push('active mapping facts drifted')
    if (
        probe.terminal.mappings !== 0 ||
        probe.terminal.selectedBytes !== 0 ||
        probe.terminal.pendingOperations !== 0 ||
        probe.terminal.readbackMappings !== 0
    ) failures.push('terminal mapping facts leaked')
    if (probe.terminal.retainedOperations > 16) failures.push('operation history exceeded capacity')
    if (probe.terminal.retainedIncidents > 8) failures.push('incident history exceeded capacity')
    if (probe.terminal.retainedEvidenceBytes > 64 * 1024) {
        failures.push('serialized evidence exceeded byte capacity')
    }
    if (probe.evidenceVersion !== 5) failures.push('browser evidence is not schema v5')
    if (!probe.evidenceJsonRoundTrip) failures.push('browser evidence failed JSON round trip')
    return failures
}

function appendPageFailures(failures, label, facts) {

    if (facts.consoleFailures.length > 0) {
        failures.push(`${label}: ${facts.consoleFailures.length} console warning/error messages`)
    }
    if (facts.pageErrors.length > 0) {
        failures.push(`${label}: ${facts.pageErrors.length} page errors`)
    }
    if (facts.requestFailures.length > 0) {
        failures.push(`${label}: ${facts.requestFailures.length} request failures`)
    }
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
