import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

// Run sequentially against each checkout; do not overlap another GPU benchmark.
// COVER_AUDIT_REPO selects a checkout with its existing dependencies. No build runs.
const root = await realpath(process.env.COVER_AUDIT_REPO ??
    resolve(dirname(fileURLToPath(import.meta.url)), '../..'))
const configuration = Object.freeze({
    framesPerScenario: 112,
    warmupFrames: 14,
    timedFrames: 98,
    sampleEveryEncoders: 7,
    maximumTimestampedPassesPerEncoder: 64,
    scenarios: [
        { name: 'flat-z9', zoom: 9, pitch: 0, width: 1280, height: 800 },
        { name: 'pitch70-z10', zoom: 10, pitch: 70, width: 1280, height: 800 },
        { name: 'wide-flat-z13', zoom: 13, pitch: 0, width: 1800, height: 800 },
    ],
})
const failures = []
const browserEvents = []
const before = await sourceProvenance(root)
let vite, browserServer, browser, result, browserVersion, port, after
let browserShutdown = 'not-started'
let benchmarkTimeout
try {
    port = await availablePort()
    vite = startVite(port)
    await waitForVite(vite, port)
    browserServer = await chromium.launchServer({
        channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu'],
    })
    browser = await chromium.connect(browserServer.wsEndpoint())
    browserVersion = browser.version()
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
    page.on('pageerror', error => append(browserEvents, error.message))
    page.on('console', message => {
        if (message.type() === 'error' || message.type() === 'warning') append(browserEvents, message.text())
    })
    page.on('requestfailed', request => append(browserEvents, `${request.url()}: ${request.failure()?.errorText}`))
    await page.addInitScript(installTimestampAudit, configuration)
    await page.route('**/__cover_micro__', route => route.fulfill({ contentType: 'text/html', body:
        '<!doctype html><title>Public cover benchmark</title><link rel="icon" href="data:,">' }))
    await page.goto(`http://127.0.0.1:${port}/__cover_micro__`)
    result = await Promise.race([
        page.evaluate(runBenchmark, { root, configuration }),
        new Promise((_, reject) => {
            benchmarkTimeout = setTimeout(() => reject(new Error('Cover benchmark exceeded 120 seconds')), 120_000)
        }),
    ])
    failures.push(...browserEvents, ...result.auditErrors)
    if (!result.timestampSupport.length || result.timestampSupport.some(supported => !supported)) {
        failures.push('Timestamp queries were unavailable; GPU timings are not a valid measurement')
    }
    if (result.scenarios.some(scene => scene.gpuEncoderSpanMs === null)) failures.push('A scenario has no GPU timestamp samples')
} catch (error) {
    failures.push(error.stack ?? String(error))
} finally {
    clearTimeout(benchmarkTimeout)
    if (browserServer) {
        try {
            await withTimeout(browserServer.close(), 5_000, 'Chrome shutdown')
            browserShutdown = 'graceful'
        } catch (error) {
            failures.push(String(error))
            browserShutdown = 'forced'
            browserServer.process().kill('SIGKILL')
            await waitForExit(browserServer.process(), 5_000).catch(error => failures.push(String(error)))
        }
    }
    if (vite) await stopProcess(vite.child).catch(error => failures.push(String(error)))
    after = await sourceProvenance(root).catch(error => {
        failures.push(`Final source provenance: ${error}`)
        return undefined
    })
}
const cleanup = {
    browserClosed: browserServer === undefined || exited(browserServer.process()),
    browserShutdown,
    viteClosed: vite === undefined || exited(vite.child),
    portClosed: port === undefined || !await canConnect(port),
}
if (!cleanup.browserClosed || !cleanup.viteClosed || !cleanup.portClosed) failures.push('Owned processes or port did not close')
if (after?.sourceTreeSha256 !== before.sourceTreeSha256) failures.push('Runtime source changed during measurement')
process.stdout.write(`${JSON.stringify({
    schemaVersion: 1, status: failures.length ? 'failed' : 'measured',
    configuration, sourceRoot: root, provenance: { before, after }, browserVersion, headless: true,
    scope: {
        synthetic: true, surface: false, worker: false, backend: false,
        instrumentation: 'GPU timestamp query injection on every seventh timed encoder, including resolve/readback overhead',
        gpuEncoderSpan: 'First measured pass start to last measured pass end within one sampled encoder; not whole-frame time',
        hostTiming: 'performance.now wall time; writeView/encode/capture/submit exclude subsequent asynchronous observation',
        observations: 'Submission-to-observation includes GPU work, native observation and cover readback; not a GPU kernel timer',
        limitations: 'No performance threshold or improvement claim; fixed device/scenes and timestamp instrumentation can affect results',
    },
    result, cleanup, failures,
    ...(failures.length && vite ? { viteLog: vite.log } : {}),
}, null, 2)}\n`)
if (failures.length) process.exitCode = 1

async function runBenchmark({ root, configuration }) {

    const { GPURuntime } = await import(`/@fs${root}/packages/geoscratch/src/scratch.ts`)
    const { WebMercatorQuad, tileMatrixCoverage, webMercatorQuadAddressCodec,
        webMercatorPlanarTileSpatialProfile, GpuWebMercatorQuadCover,
        gpuWebMercatorQuadCoverPolicy, createGeoViewSnapshot } =
        await import(`/@fs${root}/packages/geoscratch/src/geo/index.ts`)
    const audit = window.__coverTimestampAudit
    const runtime = await GPURuntime.create({
        label: 'Bounded public cover microbenchmark', powerPreference: 'high-performance',
        diagnostics: { operationCapacity: 128, incidentCapacity: 16, evidenceByteCapacity: 131072,
            submissionScopes: 'summary', maxPendingNativeObservations: 4 },
    })
    let cover
    const scenarios = []
    let frameEpoch = 0
    try {
        const coverage = tileMatrixCoverage({ tileMatrixSet: WebMercatorQuad,
            limits: Array.from({ length: 11 }, (_, level) => ({ matrixId: String(level),
                minTileRow: 0, maxTileRow: 2 ** level - 1, minTileCol: 0, maxTileCol: 2 ** level - 1 })) })
        cover = await GpuWebMercatorQuadCover.create(runtime, {
            spatialProfile: webMercatorPlanarTileSpatialProfile({ addressCodec: webMercatorQuadAddressCodec({ coverage }) }),
            policy: gpuWebMercatorQuadCoverPolicy({ minimumMatrixLevel: 0, maximumMatrixLevel: 14,
                maximumPatches: 512, cellsPerPatchEdge: 128, maximumCellSpanReferencePixels: 5,
                refinementTolerance: 0.005 }),
            verticalRangeMeters: [-120, 30],
        })
        for (const scene of configuration.scenarios) {
            const recordStart = audit.records.length
            const host = { snapshot: [], builder: [], writeView: [], frame: [], encode: [], capture: [],
                submit: [], construction: [], submissionToObservation: [] }
            let feedback
            for (let index = 0; index < configuration.framesPerScenario; index++) {
                audit.enabled = index >= configuration.warmupFrames
                audit.scenario = scene.name
                audit.frameEpoch = frameEpoch + 1
                const snapshotStart = performance.now()
                const altitude = 40075016.6855784 / 2 ** scene.zoom * 1.5
                const fov = Math.PI / 3, pitch = scene.pitch * Math.PI / 180
                const f = 1 / Math.tan(fov / 2), far = altitude * 16, c = Math.cos(pitch), s = Math.sin(pitch)
                const p = [f / (scene.width / scene.height), 0, 0, 0, 0, f, 0, 0,
                    0, 0, far / (1 - far), -1, 0, 0, far / (1 - far), 0]
                const r = [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]
                const matrix = new Float64Array(16)
                for (let col = 0; col < 4; col++) for (let row = 0; row < 4; row++) {
                    for (let k = 0; k < 4; k++) matrix[col * 4 + row] += p[k * 4 + row] * r[col * 4 + k]
                }
                const x = index * 0.5
                const view = createGeoViewSnapshot({ id: 'public-cover-benchmark', clipFromRelativeWorld: matrix,
                    cameraHigh: [Math.fround(x), 0, Math.fround(altitude)],
                    cameraLow: [x - Math.fround(x), 0, altitude - Math.fround(altitude)],
                    referenceViewport: [scene.width, scene.height], verticalFovRadians: fov,
                    cameraLatitudeRadians: 0, cameraPitchRadians: pitch, zoomHint: scene.zoom,
                    frameEpoch: ++frameEpoch, residencySnapshotEpoch: 1 })
                const start = performance.now()
                const builder = runtime.createSubmission({ validation: 'throw' })
                if (frameEpoch === 1) cover.initialize(builder)
                const builderEnd = performance.now()
                const token = cover.writeView(view)
                const writeEnd = performance.now()
                try {
                    const frame = cover.frame(token)
                    const frameEnd = performance.now()
                    cover.encode(builder, frame)
                    const encodeEnd = performance.now()
                    cover.capture(builder, frame)
                    const captureEnd = performance.now()
                    const submitted = builder.submit()
                    const submitEnd = performance.now()
                    const values = await Promise.all([cover.feedback(frame, submitted), submitted.done, submitted.nativeOutcome])
                    const observedEnd = performance.now()
                    feedback = values[0]
                    if (values[2].status !== 'observed-succeeded') throw new Error(JSON.stringify(values[2]))
                    if (index >= configuration.warmupFrames) {
                        host.snapshot.push(start - snapshotStart)
                        host.builder.push(builderEnd - start)
                        host.writeView.push(writeEnd - builderEnd)
                        host.frame.push(frameEnd - writeEnd)
                        host.encode.push(encodeEnd - frameEnd)
                        host.capture.push(captureEnd - encodeEnd)
                        host.submit.push(submitEnd - captureEnd)
                        host.construction.push(submitEnd - start)
                        host.submissionToObservation.push(observedEnd - submitEnd)
                    }
                } finally { token.dispose() }
            }
            audit.enabled = false
            await audit.drain()
            const records = audit.records.slice(recordStart)
            const passes = records.flatMap(record => record.passes)
            const labels = [...new Set(passes.map(pass => pass.label))]
            scenarios.push({ ...scene, feedback,
                hostMs: Object.fromEntries(Object.entries(host).map(([name, values]) => [name, stats(values)])),
                // Retain the old single-pass metric, but also report the complete measured encoder span.
                gpuPassMs: stats(passes.map(pass => pass.ms)),
                gpuEncoderPassSumMs: stats(records.map(record => record.passSumMs)),
                gpuEncoderSpanMs: stats(records.map(record => record.spanMs)),
                gpuPassMsByLabel: Object.fromEntries(labels.map(label => [label,
                    stats(passes.filter(pass => pass.label === label).map(pass => pass.ms))])),
                sampleRecords: records,
            })
        }
    } finally {
        audit.enabled = false
        await audit.drain()
        audit.dispose()
        cover?.dispose()
        runtime.dispose()
    }
    const terminal = runtime.diagnostics.snapshot()
    if (terminal.resources.length || terminal.readbacks.length || terminal.readbackCommands.length ||
        terminal.pendingOperations.length || terminal.readbackMemory.currentStagingBytes ||
        terminal.readbackMemory.activeMappings || audit.pendingCount() || audit.liveCount()) {
        throw new Error(`Benchmark cleanup retained resources: ${JSON.stringify(terminal)}`)
    }
    return { hardware: runtime.adapterInfo, scenarios, timestampSupport: audit.support, auditErrors: audit.errors,
        sampledEncoders: audit.sampledEncoders, timedEncoders: audit.timedEncoders,
        cleanup: { runtimeDisposed: runtime.isDisposed, resources: terminal.resources.length,
            readbacks: terminal.readbacks.length, stagingBytes: terminal.readbackMemory.currentStagingBytes,
            timestampAllocations: audit.liveCount(), pendingTimestampMappings: audit.pendingCount() } }

    function stats(values) {
        if (!values.length) return null
        const ordered = [...values].sort((a, b) => a - b)
        return { n: values.length, mean: values.reduce((sum, x) => sum + x, 0) / values.length,
            p50: ordered[Math.floor(ordered.length * 0.5)], p95: ordered[Math.floor(ordered.length * 0.95)] }
    }
}

function installTimestampAudit(configuration) {

    const pending = new Set(), live = new Set(), commandRecords = new WeakMap()
    const audit = window.__coverTimestampAudit = { enabled: false, records: [], errors: [], support: [],
        timedEncoders: 0, sampledEncoders: 0, scenario: '', frameEpoch: 0,
        drain: async() => { await Promise.allSettled([...pending]) },
        pendingCount: () => pending.size, liveCount: () => live.size,
        dispose: () => { for (const record of [...live]) destroy(record) },
    }
    const requestDevice = GPUAdapter.prototype.requestDevice
    GPUAdapter.prototype.requestDevice = async function(descriptor = {}) {
        const requiredFeatures = [...(descriptor.requiredFeatures ?? [])]
        if (this.features.has('timestamp-query') && !requiredFeatures.includes('timestamp-query')) requiredFeatures.push('timestamp-query')
        const device = await requestDevice.call(this, { ...descriptor, requiredFeatures })
        audit.support.push(device.features.has('timestamp-query'))
        device.addEventListener('uncapturederror', event => audit.errors.push(event.error.message))
        if (!device.features.has('timestamp-query')) return device
        const createEncoder = device.createCommandEncoder.bind(device)
        device.createCommandEncoder = descriptor => {
            const encoder = createEncoder(descriptor)
            if (!audit.enabled) return encoder
            const sequence = audit.timedEncoders++
            if (sequence % configuration.sampleEveryEncoders !== 0) return encoder
            const count = configuration.maximumTimestampedPassesPerEncoder * 2
            const record = { scenario: audit.scenario, frameEpoch: audit.frameEpoch, encoderSequence: sequence,
                querySet: device.createQuerySet({ type: 'timestamp', count }),
                resolved: device.createBuffer({ size: count * 8, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }),
                read: device.createBuffer({ size: count * 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
                passes: [], destroyed: false }
            live.add(record)
            for (const method of ['beginComputePass', 'beginRenderPass']) {
                const begin = encoder[method].bind(encoder)
                encoder[method] = (descriptor = {}) => {
                    if (descriptor.timestampWrites || record.passes.length >= configuration.maximumTimestampedPassesPerEncoder) {
                        audit.errors.push('Timestamp instrumentation could not measure every pass in a sampled encoder')
                        return begin(descriptor)
                    }
                    const index = record.passes.length * 2
                    const pass = begin({ ...descriptor, timestampWrites: { querySet: record.querySet,
                        beginningOfPassWriteIndex: index, endOfPassWriteIndex: index + 1 } })
                    const facts = { label: descriptor.label ?? method, pipelines: [], commands: [] }
                    record.passes.push(facts)
                    const setPipeline = pass.setPipeline.bind(pass)
                    pass.setPipeline = pipeline => { facts.pipelines.push(pipeline.label); return setPipeline(pipeline) }
                    for (const operation of ['dispatchWorkgroups', 'dispatchWorkgroupsIndirect', 'draw', 'drawIndexed', 'drawIndirect', 'drawIndexedIndirect']) {
                        if (!pass[operation]) continue
                        const call = pass[operation].bind(pass)
                        pass[operation] = (...args) => {
                            facts.commands.push([operation, ...args.map(x => typeof x === 'number' ? x : 'buffer')])
                            return call(...args)
                        }
                    }
                    return pass
                }
            }
            const finish = encoder.finish.bind(encoder)
            encoder.finish = descriptor => {
                if (record.passes.length) {
                    encoder.resolveQuerySet(record.querySet, 0, record.passes.length * 2, record.resolved, 0)
                    encoder.copyBufferToBuffer(record.resolved, 0, record.read, 0, record.passes.length * 16)
                }
                const buffer = finish(descriptor)
                if (record.passes.length) commandRecords.set(buffer, record)
                else destroy(record)
                return buffer
            }
            return encoder
        }
        const submit = device.queue.submit.bind(device.queue)
        device.queue.submit = buffers => {
            const list = [...buffers]
            const returned = submit(list)
            for (const buffer of list) {
                const record = commandRecords.get(buffer)
                if (!record) continue
                commandRecords.delete(buffer)
                audit.sampledEncoders++
                const completion = record.read.mapAsync(GPUMapMode.READ).then(() => {
                    const values = new BigUint64Array(record.read.getMappedRange())
                    const passes = record.passes.map((facts, i) => ({ ...facts,
                        ms: Number(values[i * 2 + 1] - values[i * 2]) / 1e6 }))
                    audit.records.push({ scenario: record.scenario, frameEpoch: record.frameEpoch,
                        encoderSequence: record.encoderSequence, passes,
                        passSumMs: passes.reduce((sum, pass) => sum + pass.ms, 0),
                        spanMs: Number(values[record.passes.length * 2 - 1] - values[0]) / 1e6 })
                    record.read.unmap()
                }).catch(error => audit.errors.push(String(error))).finally(() => {
                    destroy(record)
                    pending.delete(completion)
                })
                pending.add(completion)
            }
            return returned
        }
        return device
    }
    function destroy(record) {
        if (record.destroyed) return
        record.destroyed = true
        record.read.destroy()
        record.resolved.destroy()
        record.querySet.destroy()
        live.delete(record)
    }
}

async function sourceProvenance(root) {
    const git = args => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    let head = null, worktreeStatus = null, worktreePatchSha256 = null, paths
    try {
        head = git(['rev-parse', 'HEAD']).trim()
        paths = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard', 'packages/geoscratch/src']).split('\0')
        worktreeStatus = git(['status', '--short'])
        worktreePatchSha256 = createHash('sha256').update(git(['diff', '--binary', 'HEAD'])).digest('hex')
    } catch {
        // An archived source snapshot may have no .git. Its content hash remains
        // authoritative; do not infer a commit from the directory's name.
        paths = execFileSync('rg', ['--files', '--hidden', 'packages/geoscratch/src'],
            { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split('\n')
    }
    paths = [...new Set(paths.filter(Boolean))].sort()
    const digest = createHash('sha256')
    for (const path of paths) {
        digest.update(path).update('\0')
        try { digest.update(await readFile(resolve(root, path))) }
        catch (error) {
            if (error.code !== 'ENOENT') throw error
            digest.update('<deleted>')
        }
        digest.update('\0')
    }
    return { head, sourceTreeSha256: digest.digest('hex'), sourceFileCount: paths.length,
        worktreePatchSha256, worktreeStatus,
        lockfileSha256: createHash('sha256').update(await readFile(resolve(root, 'package-lock.json'))).digest('hex'),
        benchmarkSha256: createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex') }
}

function startVite(port) {
    const child = spawn(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1',
        '--port', String(port), '--strictPort'], { cwd: resolve(root, 'examples'), stdio: ['ignore', 'pipe', 'pipe'] })
    const state = { child, log: '', error: undefined }
    const record = chunk => { state.log = (state.log + chunk).slice(-65536) }
    child.stdout.on('data', record)
    child.stderr.on('data', record)
    child.on('error', error => { state.error = error })
    return state
}
async function waitForVite(state, port) {
    for (let attempt = 0; attempt < 200; attempt++) {
        if (state.error) throw state.error
        if (exited(state.child)) throw new Error(`Vite exited before readiness: ${state.log}`)
        try {
            const response = await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(500) })
            await response.body?.cancel()
            if (response.ok) return
        } catch { /* The owned server is still starting. */ }
        await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error('Vite did not become ready')
}
async function availablePort() {
    const server = createServer()
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const port = server.address().port
    await new Promise(resolve => server.close(resolve))
    return port
}
function canConnect(port) {
    return new Promise(resolve => {
        const socket = createConnection({ host: '127.0.0.1', port })
        const finish = result => { socket.destroy(); resolve(result) }
        socket.once('connect', () => finish(true))
        socket.once('error', () => finish(false))
        socket.setTimeout(300, () => finish(false))
    })
}
async function stopProcess(child) {
    if (exited(child)) return
    child.kill('SIGTERM')
    try { await waitForExit(child, 5_000) }
    catch { child.kill('SIGKILL'); await waitForExit(child, 5_000) }
}
function exited(child) { return child.exitCode !== null || child.signalCode !== null }
async function waitForExit(child, milliseconds) {
    if (exited(child)) return
    await withTimeout(new Promise(resolve => child.once('exit', resolve)), milliseconds, 'Process shutdown')
}
async function withTimeout(promise, milliseconds, label) {
    let timer
    try { return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds)
    })]) }
    finally { clearTimeout(timer) }
}
function append(array, value) { if (array.length < 64) array.push(value) }
