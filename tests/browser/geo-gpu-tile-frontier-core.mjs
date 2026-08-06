import { spawn } from 'node:child_process'
import { createConnection, createServer } from 'node:net'
import process from 'node:process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const examplesRoot = resolve(repositoryRoot, 'examples')
const viteEntry = resolve(repositoryRoot, 'node_modules/vite/bin/vite.js')
const timeout = positiveInteger(process.env.GEO_GPU_FRONTIER_TIMEOUT_MS, 60_000)
const port = await findAvailablePort()
const baseUrl = `http://127.0.0.1:${port}`
const scratchUrl = `${baseUrl}/@fs${resolve(
    repositoryRoot,
    'packages/geoscratch/dist/scratch/index.js'
)}`
const geoUrl = `${baseUrl}/@fs${resolve(
    repositoryRoot,
    'packages/geoscratch/dist/geo/index.js'
)}`
const vite = startVite(port)
let browser
let browserVersion
let proof
let fatalError
const cleanupFailures = []

try {
    await waitForVite(vite)
    browser = await chromium.launch({
        channel: 'chrome',
        headless: process.env.GEO_GPU_FRONTIER_HEADED !== '1',
        args: [ '--enable-unsafe-webgpu' ],
    })
    browserVersion = await browser.version()
    const context = await browser.newContext()
    const page = await context.newPage()
    const events = observePage(page)
    try {
        await page.goto(`${baseUrl}/helloTriangle/index.html`, {
            waitUntil: 'domcontentloaded',
            timeout,
        })
        proof = await page.evaluate(runProof, { scratchUrl, geoUrl })
        proof.events = events
    } finally {
        await context.close()
    }
} catch (error) {
    fatalError = serializeError(error)
} finally {
    try {
        if (browser !== undefined) await withTimeout(browser.close(), 15_000, 'Chrome shutdown')
    } catch (error) {
        cleanupFailures.push(`Chrome cleanup failed: ${serializeError(error)}`)
    }
    try {
        await stopVite(vite)
    } catch (error) {
        cleanupFailures.push(`Vite cleanup failed: ${serializeError(error)}`)
    }
}

const processFacts = {
    browserClosed: browser === undefined || !browser.isConnected(),
    viteClosed: !await canConnect(port),
}
const failures = validate({ proof, processFacts, fatalError, cleanupFailures })
const result = {
    schemaVersion: 1,
    status: failures.length === 0 ? 'passed' : 'failed',
    browserVersion,
    headless: process.env.GEO_GPU_FRONTIER_HEADED !== '1',
    baseUrl,
    proof,
    processFacts,
    fatalError,
    cleanupFailures,
    failures,
    processOutput: failures.length === 0 ? undefined : {
        pid: vite.child.pid,
        exitCode: vite.child.exitCode,
        signalCode: vite.child.signalCode,
        stdout: vite.stdout,
        stderr: vite.stderr,
    },
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
if (failures.length > 0) process.exitCode = 1

async function runProof({ scratchUrl: scratchModuleUrl, geoUrl: geoModuleUrl }) {

    const { GPURuntime } = await import(scratchModuleUrl)
    const {
        GpuTileFrontier,
        VirtualRasterResidency,
        WebMercatorQuad,
        createVirtualRasterGpuState,
        gpuTileFrontierPolicy,
        ownedVirtualRasterPagePayload,
        tileMatrixCoverage,
        virtualRasterPlane,
        virtualRasterTileAddressSpace,
        webMercatorQuadAddressCodec,
    } = await import(geoModuleUrl)
    const commandLabels = [
        'Reset GPU tile frontier',
        'Clear GPU tile frontier lookup',
        'Build GPU tile frontier lookup',
        'Evaluate GPU tile frontier',
        'Select GPU tile frontier budgets',
        'Resolve GPU tile frontier transitions',
        'Balance GPU tile frontier neighbors',
        'Scan GPU tile frontier blocks',
        'Scan GPU tile frontier block sums',
        'Add GPU tile frontier scan offsets',
        'Compact GPU tile frontier outputs',
        'Finalize GPU tile frontier arguments',
    ]
    const expectedKinds = [
        'direct', 'direct', 'indirect', 'indirect', 'direct', 'indirect',
        'indirect', 'direct', 'direct', 'direct', 'indirect', 'direct',
    ]
    let runtime
    let residency
    let gpuState
    let frontier
    let validationError
    const uncapturedErrors = []
    const result = {
        commandLabels,
        expectedKinds,
        failure: undefined,
        validationError: undefined,
        uncapturedErrors,
    }
    try {
        runtime = await GPURuntime.create({ label: 'GPU tile frontier browser smoke' })
        runtime.device.addEventListener('uncapturederror', event => {
            uncapturedErrors.push(serializeBrowserError(event.error))
        })
        runtime.device.pushErrorScope('validation')
        const coverage = tileMatrixCoverage({
            tileMatrixSet: WebMercatorQuad,
            limits: [ {
                matrixId: '0',
                minTileRow: 0,
                maxTileRow: 0,
                minTileCol: 0,
                maxTileCol: 0,
            } ],
        })
        const addressSpace = virtualRasterTileAddressSpace({
            id: 'browser-frontier-smoke',
            coverage,
        })
        const addressCodec = webMercatorQuadAddressCodec({ coverage })
        const plane = virtualRasterPlane({
            id: 'browser-frontier-height',
            addressSpace,
            kind: 'scalar',
            channels: 1,
            sampleType: 'unorm8',
            gpuFormat: 'r8unorm',
        })
        const [ width, height ] = addressSpace.pageSize
        residency = new VirtualRasterResidency({
            addressSpace,
            plane,
            maxPhysicalPages: 16,
            maxStagingBytes: width * height,
        })
        const root = addressSpace.rootPage()
        residency.stage(ownedVirtualRasterPagePayload({
            page: root,
            width,
            height,
            channels: 1,
            data: new Uint8Array(width * height),
            contentVersion: 'browser-frontier-root-v1',
        }), { generation: 1 })
        const publication = residency.publish()
        gpuState = await createVirtualRasterGpuState(runtime, {
            addressSpace,
            plane,
            maxPhysicalPages: 16,
        })
        const update = gpuState.stage(publication)
        const residencySubmission = runtime.createSubmission({ validation: 'throw' })
        for (const command of update.commands) residencySubmission.upload(command)
        const residencySubmitted = residencySubmission.submit()
        await gpuState.acknowledge(publication, residencySubmitted)

        frontier = await GpuTileFrontier.create(runtime, {
            gpuState,
            addressCodec,
            policy: gpuTileFrontierPolicy({
                refineErrorPixels: 2,
                coarsenErrorPixels: 1,
                minimumMatrixLevel: 0,
                maximumMatrixLevel: 0,
                maximumActiveTiles: 8,
                maximumDemands: 8,
                transitionReservePages: 8,
                invisibleGraceFrames: 2,
            }),
            levelMetrics: [ {
                matrixLevel: 0,
                minimumElevationMeters: 0,
                maximumElevationMeters: 100,
                geometricErrorMeters: 100,
            } ],
            roots: [ root ],
            drawTemplates: [ { id: 'terrain', vertexCount: 6 } ],
        })
        const seed = frontier.stageSeed(publication.snapshot)
        const outcomes = []
        const frames = []
        for (const frameEpoch of [ 0, 1 ]) {
            const upload = frontier.writeView({
                clipFromRelativeWorld: new Float32Array([
                    1 / 20_037_508.3427892, 0, 0, 0,
                    0, 1 / 20_037_508.3427892, 0, 0,
                    0, 0, 1 / 1_000_000, 0,
                    0, 0, 1, 1,
                ]),
                cameraHigh: [ 0, 0, 1_000_000 ],
                cameraLow: [ 0, 0, 0 ],
                viewport: [ 64, 64 ],
                verticalFovRadians: Math.PI / 2,
                cameraLatitudeRadians: 0,
                zoomHint: 0,
                frameEpoch,
                residencySnapshotEpoch: publication.snapshot.epoch,
            })
            const frame = frontier.frame(frameEpoch)
            frames.push(frame)
            const builder = runtime.createSubmission({ validation: 'throw' })
            if (frameEpoch === 0) {
                for (const command of seed.commands) {
                    if (command.commandKind === 'clear') builder.clear(command)
                    else builder.upload(command)
                }
            }
            const submitted = builder
                .upload(upload.command)
                .compute(frame.pass, frame.commands)
                .submit()
            outcomes.push(await submitted.nativeOutcome)
        }
        await runtime.device.queue.onSubmittedWorkDone()
        validationError = await runtime.device.popErrorScope()
        const facts = frontier.facts()
        const [ even, odd ] = frames
        const terrain = frontier.drawArgument(even, 'terrain')
        result.resourceCount = Object.keys(facts.resources).length
        result.bufferBytes = facts.bufferBytes
        result.templateCount = facts.parityTemplates.length
        result.labels = even.commands.map(command => command.label)
        result.kinds = even.commands.map(command =>
            'indirect' in command.count ? 'indirect' : 'direct'
        )
        result.parity = [
            { source: even.source, target: even.target },
            { source: odd.source, target: odd.target },
        ]
        result.drawArgument = {
            offset: terrain.offset,
            size: terrain.size,
            usage: terrain.resource.usage,
        }
        result.outcomes = outcomes.map(outcome => outcome.status)
        result.validationError = validationError === null
            ? undefined
            : serializeBrowserError(validationError)
        frontier.dispose()
        result.disposal = {
            ownedBuffersDisposed: Object.values(facts.resources).every(resource => resource.isDisposed),
            borrowedSlotTableAlive: !gpuState.slotTable.isDisposed,
            runtimeAlive: !runtime.isDisposed,
        }
    } catch (error) {
        result.failure = serializeBrowserError(error)
        if (runtime !== undefined && validationError === undefined) {
            try {
                validationError = await runtime.device.popErrorScope()
                result.validationError = validationError === null
                    ? undefined
                    : serializeBrowserError(validationError)
            } catch (scopeError) {
                result.validationError = serializeBrowserError(scopeError)
            }
        }
    } finally {
        frontier?.dispose()
        gpuState?.dispose()
        residency?.dispose()
        runtime?.dispose()
    }
    return result

    function serializeBrowserError(error) {
        return {
            name: error?.constructor?.name ?? error?.name ?? 'unknown',
            message: error?.message ?? String(error),
            diagnostic: error?.diagnostic,
        }
    }
}

function validate(value) {

    const failures = []
    if (value.fatalError !== undefined) failures.push(`browser proof failed: ${value.fatalError}`)
    failures.push(...value.cleanupFailures)
    if (!value.processFacts.browserClosed || !value.processFacts.viteClosed) {
        failures.push('managed Chrome or Vite remained reachable')
    }
    if (value.proof === undefined) {
        failures.push('GPU tile frontier browser proof was not produced')
        return failures
    }
    const proof = value.proof
    if (proof.failure !== undefined) failures.push(`frontier creation/submission failed: ${JSON.stringify(proof.failure)}`)
    if (proof.validationError !== undefined || proof.uncapturedErrors?.length !== 0) {
        failures.push('WebGPU validation or uncaptured errors were emitted')
    }
    if (proof.resourceCount !== 19 || proof.templateCount !== 2 ||
        JSON.stringify(proof.labels) !== JSON.stringify(proof.commandLabels) ||
        JSON.stringify(proof.kinds) !== JSON.stringify(proof.expectedKinds)) {
        failures.push('persistent resource or command graph facts drifted')
    }
    if (JSON.stringify(proof.parity) !== JSON.stringify([
        { source: 'A', target: 'B' },
        { source: 'B', target: 'A' },
    ]) || proof.drawArgument?.offset !== 0 || proof.drawArgument?.size !== 16 ||
        (proof.drawArgument?.usage & 0x180) !== 0x180) {
        failures.push('parity or indirect draw resource facts drifted')
    }
    if (proof.outcomes?.length !== 2 || proof.outcomes.some(status => status !== 'observed-succeeded')) {
        failures.push('one or more parity submissions did not complete successfully')
    }
    if (!proof.disposal?.ownedBuffersDisposed || !proof.disposal?.borrowedSlotTableAlive ||
        !proof.disposal?.runtimeAlive) {
        failures.push('owned or borrowed disposal boundaries drifted')
    }
    const events = proof.events
    if (events.consoleFailures.length !== 0 || events.consoleWarnings.length !== 0 ||
        events.pageErrors.length !== 0 || events.requestFailures.length !== 0 ||
        events.httpFailures.length !== 0) {
        failures.push('browser emitted an unexpected console, page, or network failure')
    }
    return failures
}

function observePage(page) {

    const events = {
        consoleFailures: [],
        consoleWarnings: [],
        pageErrors: [],
        requestFailures: [],
        httpFailures: [],
    }
    page.on('console', message => {
        if (message.type() === 'error') pushBounded(events.consoleFailures, message.text())
        if (message.type() === 'warning') pushBounded(events.consoleWarnings, message.text())
    })
    page.on('pageerror', error => pushBounded(events.pageErrors, serializeError(error)))
    page.on('requestfailed', request => pushBounded(
        events.requestFailures,
        `${request.method()} ${request.url()}: ${request.failure()?.errorText ?? 'unknown'}`
    ))
    page.on('response', response => {
        if (response.status() >= 400) pushBounded(events.httpFailures, `${response.status()} ${response.url()}`)
    })
    return events
}

function startVite(selectedPort) {

    const child = spawn(process.execPath, [
        viteEntry,
        '--host',
        '127.0.0.1',
        '--port',
        String(selectedPort),
        '--strictPort',
    ], {
        cwd: examplesRoot,
        env: { ...process.env, FORCE_COLOR: '0' },
        stdio: [ 'ignore', 'pipe', 'pipe' ],
    })
    const state = { child, stdout: '', stderr: '', spawnError: undefined }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { state.stdout = appendBounded(state.stdout, chunk) })
    child.stderr.on('data', chunk => { state.stderr = appendBounded(state.stderr, chunk) })
    child.on('error', error => { state.spawnError = error })
    return state
}

async function waitForVite(state) {

    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
        if (state.spawnError !== undefined) throw state.spawnError
        if (state.child.exitCode !== null) {
            throw new Error(`Vite exited before readiness with code ${state.child.exitCode}`)
        }
        try {
            const response = await fetch(baseUrl, { signal: AbortSignal.timeout(1_000) })
            await response.body?.cancel()
            if (response.ok) return
        } catch {
            // Managed Vite is still starting.
        }
        await delay(100)
    }
    throw new Error(`Timed out waiting for Vite at ${baseUrl}`)
}

async function stopVite(state) {

    if (state.child.exitCode !== null || state.child.signalCode !== null) return
    state.child.kill('SIGTERM')
    try {
        await waitForExit(state.child, 5_000)
    } catch {
        state.child.kill('SIGKILL')
        await waitForExit(state.child, 5_000)
    }
}

async function waitForExit(child, milliseconds) {

    if (child.exitCode !== null || child.signalCode !== null) return
    await new Promise((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => {
            child.off('exit', onExit)
            rejectPromise(new Error(`Process ${child.pid} did not exit within ${milliseconds} ms`))
        }, milliseconds)
        const onExit = () => {
            clearTimeout(timer)
            resolvePromise()
        }
        child.once('exit', onExit)
    })
}

async function findAvailablePort() {

    const server = createServer()
    await new Promise((resolvePromise, rejectPromise) => {
        server.once('error', rejectPromise)
        server.listen(0, '127.0.0.1', resolvePromise)
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Port selection failed')
    await new Promise((resolvePromise, rejectPromise) => {
        server.close(error => error === undefined ? resolvePromise() : rejectPromise(error))
    })
    return address.port
}

async function canConnect(selectedPort) {

    return await new Promise(resolvePromise => {
        const socket = createConnection({ host: '127.0.0.1', port: selectedPort })
        const settle = connected => {
            socket.destroy()
            resolvePromise(connected)
        }
        socket.setTimeout(500)
        socket.once('connect', () => settle(true))
        socket.once('timeout', () => settle(false))
        socket.once('error', () => settle(false))
    })
}

function withTimeout(promise, milliseconds, label) {

    return Promise.race([
        promise,
        new Promise((_, rejectPromise) => {
            setTimeout(() => rejectPromise(new Error(`${label} timed out`)), milliseconds)
        }),
    ])
}

function positiveInteger(value, fallback) {

    const parsed = Number(value ?? fallback)
    if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new TypeError('Expected positive integer')
    return parsed
}

function serializeError(error) {

    return error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error)
}

function pushBounded(target, value) {

    if (target.length < 32) target.push(value)
}

function appendBounded(current, chunk) {

    return `${current}${chunk}`.slice(-16_384)
}

function delay(milliseconds) {

    return new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds))
}
