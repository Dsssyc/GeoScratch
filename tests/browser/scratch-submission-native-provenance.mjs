import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const baseUrl = process.env.SCRATCH_SUBMISSION_BROWSER_BASE_URL ?? 'http://127.0.0.1:4173'
const outputDirectory = resolve(
    process.env.SCRATCH_SUBMISSION_BROWSER_OUTPUT ??
        '/tmp/geoscratch-submission-native-provenance-browser'
)
const headless = process.env.SCRATCH_SUBMISSION_BROWSER_HEADLESS === '1'
const timeout = Number(process.env.SCRATCH_SUBMISSION_BROWSER_TIMEOUT_MS ?? 30_000)

await mkdir(outputDirectory, { recursive: true })
const regression = runRegressionMatrix()
const browser = await chromium.launch({
    channel: 'chrome',
    headless,
    args: [ '--enable-unsafe-webgpu' ],
})

try {
    const adapter = await inspectAdapter(browser)
    const probe = await verifySubmissionTransactions(browser)
    const failures = [
        ...(adapter.available && adapter.adapterAvailable
            ? []
            : [ 'adapter: WebGPU adapter is unavailable' ]),
        ...regression.failures.map(failure => `regression: ${failure}`),
        ...probe.failures.map(failure => `submission-probe: ${failure}`),
    ]
    const result = {
        schemaVersion: 1,
        browserVersion: await browser.version(),
        headless,
        baseUrl,
        outputDirectory,
        adapter,
        regression,
        probe,
        status: failures.length === 0 ? 'passed' : 'failed',
        failures,
    }

    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    if (failures.length > 0) process.exitCode = 1
} finally {
    await browser.close()
}

function runRegressionMatrix() {

    const childOutput = resolve(outputDirectory, 'regression')
    const child = spawnSync(
        process.execPath,
        [ 'tests/browser/scratch-readback-staging-mapping.mjs' ],
        {
            cwd: root,
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
            env: {
                ...process.env,
                SCRATCH_READBACK_BROWSER_BASE_URL: baseUrl,
                SCRATCH_READBACK_BROWSER_OUTPUT: childOutput,
                SCRATCH_READBACK_BROWSER_HEADLESS: headless ? '1' : '0',
                SCRATCH_READBACK_BROWSER_TIMEOUT_MS: String(timeout),
            },
        }
    )
    let report
    let parseFailure
    try {
        report = JSON.parse(child.stdout)
    } catch (error) {
        parseFailure = error instanceof Error ? error.message : String(error)
    }

    const failures = []
    if (child.error !== undefined) failures.push(`child process error: ${child.error.message}`)
    if (child.status !== 0) failures.push(`child process exited ${child.status}: ${child.stderr.trim()}`)
    if (parseFailure !== undefined) failures.push(`child JSON parse failed: ${parseFailure}`)
    if (report?.status !== 'passed') failures.push('existing readback/browser matrix did not pass')
    if (report?.examples?.length !== 11) {
        failures.push(`example count ${report?.examples?.length ?? 'missing'}, expected 11`)
    }
    if (report?.examples?.some(example => example.failures.length > 0)) {
        failures.push('one or more existing examples retained failures')
    }

    return {
        processStatus: child.status,
        outputDirectory: childOutput,
        browserVersion: report?.browserVersion,
        adapter: report?.adapter,
        readbackProbeStatus: report?.readbackProbe?.failures?.length === 0 ? 'passed' : 'failed',
        exampleCount: report?.examples?.length,
        exampleSummaries: report?.examples?.map(example => ({
            name: example.name,
            status: example.facts.status,
            text: example.facts.text,
            visual: example.visual,
            consoleFailureCount: example.consoleFailures.length,
            pageErrorCount: example.pageErrors.length,
            requestFailureCount: example.requestFailures.length,
            failures: example.failures,
        })),
        failures,
    }
}

async function inspectAdapter(browser) {

    const context = await browser.newContext()
    const page = await context.newPage()
    await page.goto(`${baseUrl}/scratch_helloTriangle/index.html`, {
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
                maxUniformBufferBindingSize: value.limits.maxUniformBufferBindingSize,
                minUniformBufferOffsetAlignment: value.limits.minUniformBufferOffsetAlignment,
            },
        }
    })
    await context.close()
    return adapter
}

async function verifySubmissionTransactions(browser) {

    const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 1,
    })
    const page = await context.newPage()
    const consoleFailures = []
    const pageErrors = []
    const requestFailures = []
    attachFailureListeners(page, consoleFailures, pageErrors, requestFailures)
    await page.goto(`${baseUrl}/scratch_helloTriangle/index.html`, {
        waitUntil: 'domcontentloaded',
        timeout,
    })

    const runtimeModuleUrl = `${baseUrl}/@fs${resolve(
        root,
        'packages/geoscratch/dist/scratch/runtime.js'
    )}`
    const diagnosticModuleUrl = `${baseUrl}/@fs${resolve(
        root,
        'packages/geoscratch/dist/scratch/diagnostics.js'
    )}`
    const diagnosticsModuleUrl = `${baseUrl}/@fs${resolve(
        root,
        'packages/geoscratch/dist/scratch/runtime-diagnostics.js'
    )}`

    const evaluated = await page.evaluate(async ({
        runtimeModuleUrl,
        diagnosticModuleUrl,
        diagnosticsModuleUrl,
    }) => {
        const { ScratchRuntime } = await import(runtimeModuleUrl)
        const { ScratchDiagnosticError } = await import(diagnosticModuleUrl)
        const { diagnosticsControllerFor } = await import(diagnosticsModuleUrl)

        const valid = await validSubmissionProbe()
        const delayedValidation = await delayedValidationProbe()
        return { valid, delayedValidation }

        async function validSubmissionProbe() {
            const runtime = await ScratchRuntime.create({
                label: 'browser valid submission provenance',
                diagnostics: {
                    submissionScopes: 'summary',
                    operationCapacity: 128,
                    incidentCapacity: 16,
                    evidenceByteCapacity: 256 * 1024,
                },
            })
            const uncaptured = []
            const onUncaptured = event => uncaptured.push(serializeGpuError(event.error))
            runtime.device.addEventListener('uncapturederror', onUncaptured)
            const source = await runtime.createBuffer({
                label: 'browser valid ordered source',
                size: 16,
                usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
            })
            const upload = runtime.createUploadCommand({
                target: source,
                data: new Uint32Array([ 2, 4, 6, 8 ]),
            })
            const readbackCommand = await runtime.createReadbackCommand({
                label: 'browser valid ordered readback',
                source: { resource: source, contentEpoch: 1 },
                whenMissing: 'throw',
            })

            const submitStartedAt = performance.now()
            const submitted = runtime.createSubmission()
                .upload(upload)
                .readback(readbackCommand)
                .submit()
            const submitReturnedAt = performance.now()
            const nativeOutcome = await submitted.nativeOutcome
            const orderedOperation = readbackCommand.result({ after: submitted })
            const orderedBytes = await orderedOperation.toBytes()
            await submitted.done
            const directOperation = runtime.createReadback({
                label: 'browser valid direct readback',
                source,
                after: submitted,
            })
            const directBytes = await directOperation.toBytes()
            await delay(50)

            const evidence = runtime.diagnostics.exportEvidence()
            const beforeCleanup = runtime.diagnostics.snapshot()
            const operationKinds = evidence.operations.map(operation => operation.kind)
            const facts = {
                submitReturnedSynchronously: typeof submitted?.then !== 'function',
                submitCallDurationMs: submitReturnedAt - submitStartedAt,
                doneIsPromise: typeof submitted.done?.then === 'function',
                nativeOutcome,
                nativeOutcomeDeeplyFrozen: deeplyFrozen(nativeOutcome),
                nativeOutcomeJsonRoundTrip:
                    JSON.stringify(JSON.parse(JSON.stringify(nativeOutcome))) ===
                    JSON.stringify(nativeOutcome),
                orderedValues: uint32Values(orderedBytes),
                directValues: uint32Values(directBytes),
                orderedState: orderedOperation.state,
                directState: directOperation.state,
                readbackLinks: submitted.readbacks,
                readbackLinksDeeplyFrozen: deeplyFrozen(submitted.readbacks),
                sourceState: source.state,
                sourceContentEpoch: source.contentEpoch,
                evidenceVersion: evidence.version,
                operationKinds,
                submissionOperationStatuses: evidence.operations
                    .filter(operation => operation.kind === 'submission-native-observation')
                    .map(operation => operation.status),
                incidentCount: evidence.incidents.length,
                beforeCleanup: summarizeSnapshot(beforeCleanup),
                uncaptured,
            }

            directOperation.dispose()
            readbackCommand.dispose()
            upload.dispose()
            source.dispose()
            const afterCleanup = runtime.diagnostics.snapshot()
            facts.afterCleanup = summarizeSnapshot(afterCleanup)
            facts.lifecycleSubscriberCount = diagnosticsControllerFor(runtime).lifecycleSubscriberCount
            runtime.device.removeEventListener('uncapturederror', onUncaptured)
            runtime.dispose()
            return facts
        }

        async function delayedValidationProbe() {
            const runtime = await ScratchRuntime.create({
                label: 'browser delayed submission validation',
                diagnostics: {
                    submissionScopes: 'summary',
                    operationCapacity: 128,
                    incidentCapacity: 16,
                    evidenceByteCapacity: 256 * 1024,
                },
            })
            const uncaptured = []
            const onUncaptured = event => uncaptured.push(serializeGpuError(event.error))
            runtime.device.addEventListener('uncapturederror', onUncaptured)
            const uniform = await runtime.createBuffer({
                label: 'browser undersized uniform',
                size: 4,
                usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.UNIFORM,
            })
            const target = await runtime.createTexture({
                label: 'browser delayed validation target',
                size: { width: 4, height: 4 },
                format: 'rgba8unorm',
                usage: GPUTextureUsage.RENDER_ATTACHMENT,
            })
            const bindLayout = await runtime.createBindLayout({
                label: 'browser undersized uniform layout',
                group: 0,
                entries: [ {
                    binding: 0,
                    name: 'uniforms',
                    type: 'uniform',
                    visibility: [ 'vertex' ],
                } ],
            })
            const bindSet = await runtime.createBindSet(bindLayout, {
                uniforms: uniform.region(),
            }, {
                label: 'browser undersized uniform set',
            })
            const source = `
                struct Uniforms {
                    value: vec4f,
                };

                @group(0) @binding(0)
                var<uniform> uniforms: Uniforms;

                @vertex
                fn vsMain(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
                    let positions = array(
                        vec2f(0.0, 0.5),
                        vec2f(-0.5, -0.5),
                        vec2f(0.5, -0.5)
                    );
                    return vec4f(positions[index] + uniforms.value.xy * 0.0, 0.0, 1.0);
                }

                @fragment
                fn fsMain() -> @location(0) vec4f {
                    return vec4f(0.2, 0.7, 0.5, 1.0);
                }
            `
            const program = runtime.createProgram({
                label: 'browser delayed validation program',
                modules: [ source ],
                entryPoints: { vertex: 'vsMain', fragment: 'fsMain' },
            })
            const pipeline = await runtime.createRenderPipeline({
                label: 'browser delayed validation pipeline',
                program,
                bindLayouts: [ bindLayout ],
                targets: [ { format: 'rgba8unorm' } ],
            })
            const pass = runtime.createRenderPass({
                label: 'browser delayed validation pass',
                color: [ {
                    target,
                    load: 'clear',
                    store: 'store',
                    clear: [ 0, 0, 0, 1 ],
                } ],
            })
            const upload = runtime.createUploadCommand({
                label: 'browser undersized uniform upload',
                target: uniform,
                data: new Uint32Array([ 1 ]),
            })
            const draw = runtime.createDrawCommand({
                label: 'browser delayed validation draw',
                pipeline,
                bindSets: [ bindSet ],
                count: { vertexCount: 3 },
                resources: {
                    read: [ { resource: uniform, contentEpoch: 1 } ],
                    write: [],
                },
                whenMissing: 'throw',
            })
            const capture = runtime.diagnostics.capture({
                maxOperations: 16,
                maxDurationMs: 5_000,
                maxEvidenceBytes: 256 * 1024,
                nativeSubmissionDetail: 'step',
            })

            let submitted
            let synchronousFailure
            const submitStartedAt = performance.now()
            try {
                submitted = runtime.createSubmission()
                    .upload(upload)
                    .render(pass, [ draw ])
                    .submit()
            } catch (error) {
                synchronousFailure = serializeFailure(error, ScratchDiagnosticError)
            }
            const submitReturnedAt = performance.now()
            const nativeOutcome = submitted === undefined
                ? undefined
                : await submitted.nativeOutcome
            const doneFailure = submitted === undefined
                ? undefined
                : await captureFailure(submitted.done, ScratchDiagnosticError)
            const captureReport = capture.stop()
            await delay(100)

            const evidence = runtime.diagnostics.exportEvidence()
            const evidenceJson = JSON.stringify(evidence)
            const beforeCleanup = runtime.diagnostics.snapshot()
            const facts = {
                submitReturnedSynchronously:
                    submitted !== undefined && typeof submitted?.then !== 'function',
                submitCallDurationMs: submitReturnedAt - submitStartedAt,
                synchronousFailure,
                nativeOutcome,
                doneFailure,
                observedFinishOutcome: nativeOutcome?.outcomes.find(outcome => (
                    outcome.stage === 'encoder-finish' &&
                    outcome.location.kind === 'encoder-segment'
                )),
                claimedCommandOutcome: nativeOutcome?.outcomes.find(outcome => (
                    outcome.stage === 'command-encode' &&
                    outcome.location.kind === 'pass-command'
                )),
                uniformState: uniform.state,
                uniformContentEpoch: uniform.contentEpoch,
                targetState: target.state,
                targetContentEpoch: target.contentEpoch,
                capture: {
                    stopReason: captureReport.stopReason,
                    operationCount: captureReport.operations.length,
                    retainedEvidenceBytes: captureReport.retainedEvidenceBytes,
                },
                incidentCount: evidence.incidents.length,
                sourceFree: !evidenceJson.includes(source),
                evidenceJsonRoundTrip:
                    JSON.stringify(JSON.parse(evidenceJson)) === evidenceJson,
                beforeCleanup: summarizeSnapshot(beforeCleanup),
                uncaptured,
            }

            draw.dispose()
            pass.dispose()
            bindSet.dispose()
            pipeline.dispose()
            program.dispose()
            bindLayout.dispose()
            upload.dispose()
            uniform.dispose()
            target.dispose()
            const afterCleanup = runtime.diagnostics.snapshot()
            facts.afterCleanup = summarizeSnapshot(afterCleanup)
            facts.lifecycleSubscriberCount = diagnosticsControllerFor(runtime).lifecycleSubscriberCount
            runtime.device.removeEventListener('uncapturederror', onUncaptured)
            runtime.dispose()
            return facts
        }

        async function captureFailure(promise, ErrorType) {
            try {
                await promise
                return { rejected: false }
            } catch (error) {
                return serializeFailure(error, ErrorType)
            }
        }

        function serializeFailure(error, ErrorType) {
            return {
                rejected: true,
                scratchDiagnostic: error instanceof ErrorType,
                name: error?.name ?? 'unknown',
                message: error?.message ?? String(error),
                diagnostic: error?.diagnostic,
                incident: error?.incident,
            }
        }

        function summarizeSnapshot(snapshot) {
            return {
                pendingOperationCount: snapshot.pendingOperations.length,
                liveResourceCount: snapshot.resources.length,
                currentReadbackCount: snapshot.readbacks.length,
                currentReadbackCommandCount: snapshot.readbackCommands.length,
                currentStagingBytes: snapshot.readbackMemory.currentStagingBytes,
                currentRetainedHostBytes: snapshot.readbackMemory.currentRetainedHostBytes,
                activeMappings: snapshot.readbackMemory.activeMappings,
                currentPendingNativeObservations:
                    snapshot.submissionNative.currentPendingNativeObservations,
                currentEffectfulSubmittedWork:
                    snapshot.submissionNative.currentEffectfulSubmittedWork,
                activeCaptureCount: snapshot.capture.activeCount,
                retainedIncidentCount: snapshot.recorder.retainedIncidentCount,
            }
        }

        function uint32Values(bytes) {
            return Array.from(new Uint32Array(
                bytes.buffer,
                bytes.byteOffset,
                bytes.byteLength / Uint32Array.BYTES_PER_ELEMENT
            ))
        }

        function deeplyFrozen(value, seen = new Set()) {
            if (value === null || typeof value !== 'object' || seen.has(value)) return true
            if (!Object.isFrozen(value)) return false
            seen.add(value)
            return Object.values(value).every(child => deeplyFrozen(child, seen))
        }

        function serializeGpuError(error) {
            return {
                name: error?.constructor?.name ?? 'unknown',
                message: error?.message ?? '',
            }
        }

        function delay(milliseconds) {
            return new Promise(resolve => setTimeout(resolve, milliseconds))
        }
    }, {
        runtimeModuleUrl,
        diagnosticModuleUrl,
        diagnosticsModuleUrl,
    })

    await page.screenshot({
        path: resolve(outputDirectory, 'submission-probe-page.png'),
        fullPage: true,
    })
    await page.close()
    await context.close()

    const failures = [
        ...validateValidProbe(evaluated.valid),
        ...validateDelayedValidationProbe(evaluated.delayedValidation),
    ]
    if (consoleFailures.length > 0) {
        failures.push(`${consoleFailures.length} console warning/error messages`)
    }
    if (pageErrors.length > 0) failures.push(`${pageErrors.length} page errors`)
    if (requestFailures.length > 0) failures.push(`${requestFailures.length} request failures`)

    return {
        ...evaluated,
        runtimeModuleUrl,
        diagnosticModuleUrl,
        diagnosticsModuleUrl,
        consoleFailures,
        pageErrors,
        requestFailures,
        screenshot: resolve(outputDirectory, 'submission-probe-page.png'),
        failures,
    }
}

function validateValidProbe(valid) {

    const failures = []
    if (!valid.submitReturnedSynchronously) failures.push('valid submit returned a thenable')
    if (!valid.doneIsPromise) failures.push('valid SubmittedWork.done is not a Promise')
    if (!Number.isFinite(valid.submitCallDurationMs)) failures.push('valid submit timing is invalid')
    if (valid.nativeOutcome?.version !== 5) failures.push('valid native outcome is not schema v5')
    if (valid.nativeOutcome?.mode !== 'summary') failures.push('valid native outcome is not summary')
    if (valid.nativeOutcome?.status !== 'observed-succeeded') {
        failures.push(`valid native status ${valid.nativeOutcome?.status ?? 'missing'}`)
    }
    if (!valid.nativeOutcomeDeeplyFrozen) failures.push('valid native outcome is mutable')
    if (!valid.nativeOutcomeJsonRoundTrip) failures.push('valid native outcome is not JSON-safe')
    if (!equalNumbers(valid.orderedValues, [ 2, 4, 6, 8 ])) {
        failures.push(`ordered values drifted: ${valid.orderedValues}`)
    }
    if (!equalNumbers(valid.directValues, [ 2, 4, 6, 8 ])) {
        failures.push(`direct values drifted: ${valid.directValues}`)
    }
    if (valid.orderedState !== 'consumed') failures.push('ordered readback did not consume')
    if (valid.directState !== 'consumed') failures.push('direct readback did not consume')
    if (valid.readbackLinks.length !== 1 || !valid.readbackLinksDeeplyFrozen) {
        failures.push('valid readback link facts drifted')
    }
    if (valid.sourceState !== 'ready' || valid.sourceContentEpoch !== 1) {
        failures.push('valid ordered queue result did not preserve epoch 1 ready source')
    }
    if (valid.evidenceVersion !== 5) failures.push('valid evidence is not schema v5')
    for (const kind of [
        'submission-native-observation',
        'readback-native-observation',
        'readback-mapping',
    ]) {
        if (!valid.operationKinds.includes(kind)) failures.push(`valid evidence missing ${kind}`)
    }
    if (valid.submissionOperationStatuses.some(status => status !== 'succeeded')) {
        failures.push('valid submission operation did not succeed')
    }
    if (valid.incidentCount !== 0) failures.push(`${valid.incidentCount} valid incidents retained`)
    if (valid.uncaptured.length > 0) failures.push(`${valid.uncaptured.length} valid uncaptured errors`)
    if (!terminalSnapshot(valid.afterCleanup)) failures.push('valid probe retained terminal ownership')
    if (valid.lifecycleSubscriberCount !== 0) failures.push('valid probe retained subscribers')
    return failures
}

function validateDelayedValidationProbe(probe) {

    const failures = []
    if (!probe.submitReturnedSynchronously) failures.push('invalid submit did not return synchronously')
    if (probe.synchronousFailure !== undefined) failures.push('invalid probe failed synchronously')
    if (!Number.isFinite(probe.submitCallDurationMs)) failures.push('invalid submit timing is invalid')
    if (probe.nativeOutcome?.mode !== 'detailed') failures.push('invalid probe did not use detailed mode')
    if (probe.nativeOutcome?.status !== 'observed-failed') {
        failures.push(`invalid native status ${probe.nativeOutcome?.status ?? 'missing'}`)
    }
    if (probe.observedFinishOutcome?.nativeErrorCategory !== 'validation') {
        failures.push('invalid probe lacks encoder-finish validation outcome')
    }
    if (probe.claimedCommandOutcome !== undefined) {
        failures.push('invalid probe over-attributed delayed validation to a pass command')
    }
    if (
        probe.doneFailure?.rejected !== true ||
        probe.doneFailure?.scratchDiagnostic !== true ||
        probe.doneFailure?.diagnostic?.code !== 'SCRATCH_SUBMISSION_NATIVE_VALIDATION_FAILED'
    ) {
        failures.push('invalid done failure is not the structured submission validation diagnostic')
    }
    if (probe.doneFailure?.incident?.kind !== 'submission-failure') {
        failures.push('invalid done failure lacks submission incident')
    }
    if (probe.doneFailure?.incident?.attribution !== 'exact-operation') {
        failures.push(`invalid incident attribution ${probe.doneFailure?.incident?.attribution ?? 'missing'}`)
    }
    if (probe.doneFailure?.incident?.failureStage !== 'encoder-finish') {
        failures.push(`invalid failure stage ${probe.doneFailure?.incident?.failureStage ?? 'missing'}`)
    }
    if (probe.uniformState !== 'indeterminate' || probe.uniformContentEpoch !== 1) {
        failures.push('invalid uniform content did not become epoch-1 indeterminate')
    }
    if (probe.targetState !== 'indeterminate' || probe.targetContentEpoch !== 1) {
        failures.push('invalid render target did not become epoch-1 indeterminate')
    }
    if (probe.capture.stopReason !== 'explicit' || probe.capture.operationCount < 1) {
        failures.push('invalid detailed capture did not retain and stop explicitly')
    }
    if (probe.incidentCount !== 1) failures.push(`invalid incident count ${probe.incidentCount}`)
    if (!probe.sourceFree) failures.push('invalid evidence retained complete WGSL source')
    if (!probe.evidenceJsonRoundTrip) failures.push('invalid evidence failed JSON round trip')
    if (probe.uncaptured.length > 0) failures.push(`${probe.uncaptured.length} invalid uncaptured errors`)
    if (!terminalSnapshot(probe.afterCleanup)) failures.push('invalid probe retained terminal ownership')
    if (probe.lifecycleSubscriberCount !== 0) failures.push('invalid probe retained subscribers')
    return failures
}

function terminalSnapshot(snapshot) {

    return snapshot.pendingOperationCount === 0 &&
        snapshot.liveResourceCount === 0 &&
        snapshot.currentReadbackCount === 0 &&
        snapshot.currentReadbackCommandCount === 0 &&
        snapshot.currentStagingBytes === 0 &&
        snapshot.currentRetainedHostBytes === 0 &&
        snapshot.activeMappings === 0 &&
        snapshot.currentPendingNativeObservations === 0 &&
        snapshot.currentEffectfulSubmittedWork === 0 &&
        snapshot.activeCaptureCount === 0
}

function equalNumbers(actual, expected) {

    return actual.length === expected.length &&
        actual.every((value, index) => value === expected[index])
}

function attachFailureListeners(page, consoleFailures, pageErrors, requestFailures) {

    page.on('console', message => {
        if (message.type() === 'warning' || message.type() === 'error') {
            consoleFailures.push({ type: message.type(), text: message.text() })
        }
    })
    page.on('pageerror', error => {
        pageErrors.push(error instanceof Error ? error.message : String(error))
    })
    page.on('requestfailed', request => {
        requestFailures.push({
            url: request.url(),
            method: request.method(),
            failure: request.failure()?.errorText ?? 'unknown',
        })
    })
}
