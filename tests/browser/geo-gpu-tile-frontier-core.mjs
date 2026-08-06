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
const moduleUrl = relativePath => `${baseUrl}/@fs${resolve(repositoryRoot, relativePath)}`
const moduleUrls = {
    scratchUrl: moduleUrl('packages/geoscratch/src/scratch/index.ts'),
    geoUrl: moduleUrl('packages/geoscratch/src/geo/index.ts'),
    referenceUrl: moduleUrl('packages/geoscratch/src/geo/gpu-tile-frontier-reference.ts'),
    layoutUrl: moduleUrl('packages/geoscratch/src/geo/gpu-tile-frontier-layout.ts'),
    testAccessUrl: moduleUrl('packages/geoscratch/src/geo/gpu-tile-frontier-test-access.ts'),
    matrixUrl: moduleUrl('node_modules/wgpu-matrix/dist/2.x/wgpu-matrix.module.js'),
}
const vite = startVite(port)
let browserServer
let browser
let browserVersion
let proof
let fatalError
const cleanupFailures = []

try {
    await waitForVite(vite)
    browserServer = await chromium.launchServer({
        channel: 'chrome',
        headless: process.env.GEO_GPU_FRONTIER_HEADED !== '1',
        args: [ '--enable-unsafe-webgpu' ],
    })
    browser = await chromium.connect(browserServer.wsEndpoint())
    browserVersion = await browser.version()
    const context = await browser.newContext()
    const page = await context.newPage()
    const events = observePage(page)
    try {
        await page.goto(`${baseUrl}/helloTriangle/index.html`, {
            waitUntil: 'domcontentloaded',
            timeout,
        })
        proof = await withTimeout(
            page.evaluate(runProof, moduleUrls),
            timeout,
            'GPU tile frontier semantic proof'
        )
        proof.events = events
    } finally {
        await withTimeout(context.close(), 10_000, 'Chrome context shutdown')
    }
} catch (error) {
    fatalError = serializeError(error)
} finally {
    try {
        await closeBrowser(browser, browserServer)
    } catch (error) {
        cleanupFailures.push(`Chrome cleanup failed: ${serializeError(error)}`)
    }
    try {
        await stopVite(vite)
    } catch (error) {
        cleanupFailures.push(`Vite cleanup failed: ${serializeError(error)}`)
    }
}

const browserProcess = browserServer?.process()
const processFacts = {
    browserClosed: browser === undefined || !browser.isConnected(),
    browserProcessClosed: browserProcess === undefined ||
        browserProcess.exitCode !== null || browserProcess.signalCode !== null,
    viteClosed: !await canConnect(port),
}
const failures = validate({ proof, processFacts, fatalError, cleanupFailures })
const result = {
    schemaVersion: 2,
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
        vitePid: vite.child.pid,
        viteExitCode: vite.child.exitCode,
        viteSignalCode: vite.child.signalCode,
        browserPid: browserProcess?.pid,
        browserExitCode: browserProcess?.exitCode,
        browserSignalCode: browserProcess?.signalCode,
        stdout: vite.stdout,
        stderr: vite.stderr,
    },
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
if (failures.length > 0) process.exitCode = 1

async function runProof({ scratchUrl, geoUrl, referenceUrl, layoutUrl, testAccessUrl, matrixUrl }) {

    const { GPURuntime } = await import(scratchUrl)
    const {
        GpuTileFrontier,
        VirtualRasterGpuFeedbackRing,
        VirtualRasterResidency,
        WebMercatorQuad,
        createVirtualRasterGpuState,
        gpuTileFrontierPolicy,
        ownedVirtualRasterPagePayload,
        tileMatrixCoverage,
        virtualRasterPlane,
        virtualRasterTileAddressSpace,
        webMercatorQuadAddressCodec,
    } = await import(geoUrl)
    const { evaluateGpuTileFrontierReference } = await import(referenceUrl)
    const {
        gpuTileFrontierDemandCodec,
        gpuTileFrontierDiagnosticsCodec,
        gpuTileFrontierEntryCodec,
        gpuTileFrontierLayouts,
        gpuTileFrontierVisibleInstanceCodec,
    } = await import(layoutUrl)
    const { gpuTileFrontierTestFrameAccess } = await import(testAccessUrl)
    const { mat4 } = await import(matrixUrl)

    const HALF_WORLD = 20_037_508.3427892
    const BUFFER_COPY_DST = 0x08
    const BUFFER_COPY_SRC = 0x04
    const BUFFER_STORAGE = 0x80
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
    let validationScopeOpen = false
    const uncapturedErrors = []
    const result = {
        commandLabels,
        expectedKinds,
        failure: undefined,
        validationError: undefined,
        uncapturedErrors,
        scenarios: undefined,
    }
    try {
        runtime = await GPURuntime.create({ label: 'GPU tile frontier browser semantic parity' })
        runtime.device.addEventListener('uncapturederror', event => {
            uncapturedErrors.push(serializeBrowserError(event.error))
        })
        runtime.device.pushErrorScope('validation')
        validationScopeOpen = true

        const canonicalFirst = await canonicalScenario('canonical-a')
        const canonicalSecond = await canonicalScenario('canonical-b')
        assertEqual(
            canonicalFirst.finalBytes,
            canonicalSecond.finalBytes,
            'identical canonical executions must produce byte-identical captured output'
        )
        const sequenceAuthority = await sequenceAuthorityScenario()
        const staleContent = await staleContentScenario()
        const staleGeneration = await staleGenerationScenario()
        const demand = await demandScenario()
        const feedbackRing = await feedbackRingScenario()
        const eastEdgePrecision = await eastEdgePrecisionScenario()
        const eastEdgeCounterexample = await eastEdgeCounterexampleScenario()
        const balancePressure = await balancePressureScenario()
        const precision = await precisionScenario()
        const grace = await visibilityGraceScenario()
        const offAxis = await offAxisPitchScenario()
        await runtime.device.queue.onSubmittedWorkDone()
        const validationError = await runtime.device.popErrorScope()
        validationScopeOpen = false

        result.resourceCount = canonicalFirst.resourceCount
        result.bufferBytes = canonicalFirst.bufferBytes
        result.templateCount = canonicalFirst.templateCount
        result.labels = canonicalFirst.labels
        result.kinds = canonicalFirst.kinds
        result.parity = canonicalFirst.parity
        result.drawArgument = canonicalFirst.drawArgument
        result.outcomes = [
            ...canonicalFirst.outcomes,
            ...canonicalSecond.outcomes,
            ...sequenceAuthority.outcomes,
            ...staleContent.outcomes,
            ...staleGeneration.outcomes,
            ...demand.outcomes,
            ...feedbackRing.outcomes,
            ...eastEdgePrecision.outcomes,
            ...eastEdgeCounterexample.outcomes,
            ...balancePressure.outcomes,
            ...precision.outcomes,
            ...grace.outcomes,
            ...offAxis.outcomes,
        ]
        result.disposal = {
            frontierDisposed: [
                canonicalFirst,
                canonicalSecond,
                sequenceAuthority,
                staleContent,
                staleGeneration,
                demand,
                feedbackRing,
                eastEdgePrecision,
                eastEdgeCounterexample,
                balancePressure,
                precision,
                grace,
                offAxis,
            ].every(scenario => scenario.disposal.frontierDisposed),
            borrowedSlotTableAlive: [
                canonicalFirst,
                canonicalSecond,
                sequenceAuthority,
                staleContent,
                staleGeneration,
                demand,
                feedbackRing,
                eastEdgePrecision,
                eastEdgeCounterexample,
                balancePressure,
                precision,
                grace,
                offAxis,
            ].every(scenario => scenario.disposal.borrowedSlotTableAlive),
            feedbackRingDisposed: feedbackRing.disposal.feedbackRingDisposed,
            runtimeAlive: !runtime.isDisposed,
        }
        result.scenarios = {
            canonicalTie: {
                frame0: canonicalFirst.frame0,
                frame1: canonicalFirst.frame1,
                deterministicHash: canonicalFirst.finalHash,
                repeatedHash: canonicalSecond.finalHash,
                byteIdentical: true,
            },
            sequenceAuthority,
            staleContent,
            staleGeneration,
            demand,
            feedbackRing,
            eastEdgePrecision,
            eastEdgeCounterexample,
            balancePressure,
            precision,
            visibilityGrace: grace,
            offAxis,
        }
        result.validationError = validationError === null
            ? undefined
            : serializeBrowserError(validationError)
    } catch (error) {
        result.failure = serializeBrowserError(error)
        if (runtime !== undefined && validationScopeOpen) {
            try {
                const validationError = await runtime.device.popErrorScope()
                validationScopeOpen = false
                result.validationError = validationError === null
                    ? undefined
                    : serializeBrowserError(validationError)
            } catch (scopeError) {
                result.validationError = serializeBrowserError(scopeError)
            }
        }
    } finally {
        runtime?.dispose()
    }
    return result

    async function canonicalScenario(id) {

        const env = await createEnvironment({
            id,
            limits: [ fullLimit(1), fullLimit(2) ],
            maximumMatrixLevel: 2,
            maximumActiveTiles: 10,
            maximumDemands: 1,
            transitionReservePages: 16,
            refineErrorPixels: 2,
            coarsenErrorPixels: 0,
            levelMetrics: [ metric(1, 1_000_000), metric(2, 1_000_000) ],
            maxPhysicalPages: 32,
        })
        let frontier
        let capture
        try {
            const roots = rootPages(env)
            const root00Children = children(env, page(env, 1, 0, 0))
            const initialPublication = await publishPages(
                env,
                [ ...roots, ...root00Children ],
                `${id}-initial`
            )
            frontier = await createFrontier(env)
            capture = await createCapture(frontier, `${id}-capture`)
            const seed = frontier.stageSeed(initialPublication.snapshot)
            let current = seedEntries(frontier, initialPublication)
            let residents = [ ...roots, ...root00Children ]
            const frame0View = allWorldView(0, initialPublication.snapshot.epoch, 50)
            const frame0 = await executeFrame({
                env,
                frontier,
                capture,
                seed,
                view: frame0View,
                current,
                residentPages: residents,
            })
            const expectedFrame0Keys = [
                ...root00Children.map(child => child.key),
                page(env, 1, 0, 1).key,
                page(env, 1, 1, 0).key,
                page(env, 1, 1, 1).key,
            ]
            assertEqual(frame0.keys, expectedFrame0Keys, 'frame 0 hierarchical refinement order')
            current = frame0.nextCurrent

            const root01Children = children(env, page(env, 1, 0, 1))
            const root10Children = children(env, page(env, 1, 1, 0))
            const nextPublication = await publishPages(
                env,
                [ ...root01Children, ...root10Children ],
                `${id}-next`
            )
            residents = [ ...residents, ...root01Children, ...root10Children ]
            const frame1 = await executeFrame({
                env,
                frontier,
                capture,
                view: allWorldView(1, nextPublication.snapshot.epoch, 50),
                current,
                residentPages: residents,
            })
            const expectedFrame1Keys = [
                ...root00Children.map(child => child.key),
                ...root01Children.map(child => child.key),
                page(env, 1, 1, 0).key,
                page(env, 1, 1, 1).key,
            ]
            assertEqual(frame1.keys, expectedFrame1Keys, 'next-frame equal-priority path tie order')
            const compactIndexes = frame1.frontier.map(entry => entry.compactIndex)
            assert(
                compactIndexes.some((value, index) => index > 0 && value < compactIndexes[index - 1]),
                'hierarchical path order must be observably distinct from numeric compactIndex order'
            )
            const facts = frontier.facts()
            const drawArgument = frontier.drawArgument(frame0.frame, 'terrain')
            const frameAccess = gpuTileFrontierTestFrameAccess(frontier, frame0.frame)
            const disposal = disposeScenario(frontier, capture, env)
            frontier = undefined
            capture = undefined
            return {
                resourceCount: Object.keys(facts.bufferBytes).length,
                bufferBytes: facts.bufferBytes,
                templateCount: facts.parityTemplates.length,
                labels: frameAccess.commands.map(command => command.label),
                kinds: frameAccess.commands.map(command =>
                    'indirect' in command.count ? 'indirect' : 'direct'
                ),
                parity: [
                    { source: frame0.frame.source, target: frame0.frame.target },
                    { source: frame1.frame.source, target: frame1.frame.target },
                ],
                drawArgument: {
                    offset: drawArgument.offset,
                    size: drawArgument.size,
                    usage: drawArgument.resource.usage,
                },
                frame0: summarizeFrame(frame0),
                frame1: summarizeFrame(frame1),
                finalBytes: frame1.canonicalBytes,
                finalHash: frame1.hash,
                outcomes: [ frame0.outcome, frame1.outcome ],
                disposal,
            }
        } finally {
            capture?.dispose()
            frontier?.dispose()
            env.gpuState?.dispose()
            env.residency.dispose()
        }
    }

    async function sequenceAuthorityScenario() {

        const env = await createEnvironment({
            id: 'submission-sequence',
            limits: [ fullLimit(0) ],
            maximumMatrixLevel: 0,
            maximumActiveTiles: 1,
            maximumDemands: 1,
            transitionReservePages: 1,
            refineErrorPixels: 2,
            coarsenErrorPixels: 1,
            levelMetrics: [ metric(0, 1) ],
            maxPhysicalPages: 2,
        })
        let frontier
        try {
            const root = page(env, 0, 0, 0)
            const publication = await publishPages(env, [ root ], 'submission-sequence-root')
            frontier = await createFrontier(env)
            const seed = frontier.stageSeed(publication.snapshot)
            const cancelled = frontier.writeView(allWorldView(
                0,
                publication.snapshot.epoch,
                50
            ))
            const cancelledFrame = frontier.frame(cancelled)
            assertEqual(
                { source: cancelledFrame.source, target: cancelledFrame.target },
                { source: 'A', target: 'B' },
                'cancelled epoch 0 must still address seeded A'
            )
            cancelled.dispose()

            const replacement = frontier.writeView(allWorldView(
                1,
                publication.snapshot.epoch,
                50
            ))
            const replacementFrame = frontier.frame(replacement)
            assertEqual(
                {
                    frameEpoch: replacementFrame.frameEpoch,
                    source: replacementFrame.source,
                    target: replacementFrame.target,
                },
                { frameEpoch: 1, source: 'A', target: 'B' },
                'first submitted frameEpoch 1 must still read seeded A after cancellation'
            )
            const builder = runtime.createSubmission({ validation: 'throw' })
            appendSeed(builder, seed)
            const submitted = frontier.encode(builder, replacementFrame).submit()
            replacement.dispose()

            const next = frontier.writeView(allWorldView(
                2,
                publication.snapshot.epoch,
                50
            ))
            const nextFrame = frontier.frame(next)
            assertEqual(
                { source: nextFrame.source, target: nextFrame.target },
                { source: 'B', target: 'A' },
                'successful submit must consume the sequence and flip the next frame to B'
            )
            next.dispose()
            const outcome = await submitted.nativeOutcome
            assert(outcome.status === 'observed-succeeded', 'sequence submission failed')

            frontier.dispose()
            const disposal = {
                frontierDisposed: frontier.facts().disposed,
                borrowedSlotTableAlive: !env.gpuState.slotTable.isDisposed,
            }
            frontier = undefined
            env.gpuState.dispose()
            env.residency.dispose()
            return {
                cancelled: { frameEpoch: 0, source: 'A', target: 'B' },
                submitted: { frameEpoch: 1, source: 'A', target: 'B' },
                next: { frameEpoch: 2, source: 'B', target: 'A' },
                outcomes: [ outcome.status ],
                disposal,
            }
        } finally {
            frontier?.dispose()
            env.gpuState?.dispose()
            env.residency.dispose()
        }
    }

    async function staleContentScenario() {

        const env = await createEnvironment({
            id: 'stale-content',
            limits: [ fullLimit(0) ],
            maximumMatrixLevel: 0,
            maximumActiveTiles: 4,
            maximumDemands: 4,
            transitionReservePages: 4,
            refineErrorPixels: 2,
            coarsenErrorPixels: 1,
            levelMetrics: [ metric(0, 100) ],
            maxPhysicalPages: 8,
        })
        let frontier
        let capture
        try {
            const root = page(env, 0, 0, 0)
            const publication = await publishPages(env, [ root ], 'stale-content-root')
            frontier = await createFrontier(env)
            capture = await createCapture(frontier, 'stale-content-capture')
            const seed = frontier.stageSeed(publication.snapshot)
            const exact = seedEntries(frontier, publication)[0]
            const forged = Object.freeze({
                ...exact,
                contentEpoch: exact.contentEpoch - 1,
            })
            const frameResult = await executeFrame({
                env,
                frontier,
                capture,
                seed,
                view: allWorldView(0, publication.snapshot.epoch, 50),
                current: [ forged ],
                residentPages: [ root ],
                createExtraUploads(frame, access) {
                    void frame
                    return [ runtime.createUploadCommand({
                        label: 'Inject stale expected content epoch for browser proof',
                        target: access.currentFrontier.region({
                            size: gpuTileFrontierLayouts.frontierEntry.byteSize,
                            layout: gpuTileFrontierEntryCodec.artifact,
                        }),
                        data: gpuTileFrontierEntryCodec.uploadView(entryRecord(forged)),
                    }) ]
                },
            })
            assertEqual(frameResult.keys, [], 'stale content authority must remove the entry')
            assert(
                forged.generation === exact.generation &&
                forged.contentEpoch !== exact.contentEpoch &&
                forged.residencySnapshotEpoch === exact.residencySnapshotEpoch,
                'stale-content fixture must differ only in expected content epoch'
            )
            const disposal = disposeScenario(frontier, capture, env)
            frontier = undefined
            capture = undefined
            return {
                expectedGeneration: forged.generation,
                residentGeneration: exact.generation,
                expectedContentEpoch: forged.contentEpoch,
                residentContentEpoch: exact.contentEpoch,
                expectedSnapshotEpoch: forged.residencySnapshotEpoch,
                residentSnapshotEpoch: exact.residencySnapshotEpoch,
                activeCount: frameResult.frontier.length,
                visibleCount: frameResult.visible.length,
                demandCount: frameResult.demands.length,
                retirementCount: frameResult.retirements.length,
                facts: frameResult.facts,
                nextDispatchWords: frameResult.nextDispatchWords,
                hash: frameResult.hash,
                outcomes: [ frameResult.outcome ],
                disposal,
            }
        } finally {
            capture?.dispose()
            frontier?.dispose()
            env.gpuState?.dispose()
            env.residency.dispose()
        }
    }

    async function staleGenerationScenario() {

        const env = await createEnvironment({
            id: 'stale-generation',
            limits: [ fullLimit(0) ],
            maximumMatrixLevel: 0,
            maximumActiveTiles: 4,
            maximumDemands: 4,
            transitionReservePages: 4,
            refineErrorPixels: 2,
            coarsenErrorPixels: 1,
            levelMetrics: [ metric(0, 100) ],
            maxPhysicalPages: 8,
        })
        let frontier
        let capture
        try {
            const root = page(env, 0, 0, 0)
            const publication = await publishPages(env, [ root ], 'stale-generation-root')
            frontier = await createFrontier(env)
            capture = await createCapture(frontier, 'stale-generation-capture')
            const seed = frontier.stageSeed(publication.snapshot)
            const exact = seedEntries(frontier, publication)[0]
            const forged = Object.freeze({
                ...exact,
                generation: exact.generation + 1,
            })
            const frameResult = await executeFrame({
                env,
                frontier,
                capture,
                seed,
                view: allWorldView(0, publication.snapshot.epoch, 50),
                current: [ forged ],
                residentPages: [ root ],
                createExtraUploads(frame, access) {
                    void frame
                    return [ runtime.createUploadCommand({
                        label: 'Inject stale expected generation for browser proof',
                        target: access.currentFrontier.region({
                            size: gpuTileFrontierLayouts.frontierEntry.byteSize,
                            layout: gpuTileFrontierEntryCodec.artifact,
                        }),
                        data: gpuTileFrontierEntryCodec.uploadView(entryRecord(forged)),
                    }) ]
                },
            })
            assertEqual(frameResult.keys, [], 'stale generation authority must remove the entry')
            assert(
                forged.generation !== exact.generation &&
                forged.contentEpoch === exact.contentEpoch &&
                forged.residencySnapshotEpoch === exact.residencySnapshotEpoch,
                'stale-generation fixture must differ only in expected generation'
            )
            assert(
                frameResult.facts.staleGenerationCount === 1,
                'stale generation must increment the packed stale counter'
            )
            const disposal = disposeScenario(frontier, capture, env)
            frontier = undefined
            capture = undefined
            return {
                expectedGeneration: forged.generation,
                residentGeneration: exact.generation,
                expectedContentEpoch: forged.contentEpoch,
                residentContentEpoch: exact.contentEpoch,
                activeCount: frameResult.frontier.length,
                facts: frameResult.facts,
                nextDispatchWords: frameResult.nextDispatchWords,
                outcomes: [ frameResult.outcome ],
                disposal,
            }
        } finally {
            capture?.dispose()
            frontier?.dispose()
            env.gpuState?.dispose()
            env.residency.dispose()
        }
    }

    async function demandScenario() {

        const env = await createEnvironment({
            id: 'canonical-demand',
            limits: [
                {
                    matrixId: '1',
                    minTileRow: 0,
                    maxTileRow: 0,
                    minTileCol: 0,
                    maxTileCol: 0,
                },
                {
                    matrixId: '2',
                    minTileRow: 0,
                    maxTileRow: 1,
                    minTileCol: 0,
                    maxTileCol: 1,
                },
            ],
            minimumMatrixLevel: 1,
            maximumMatrixLevel: 2,
            maximumActiveTiles: 4,
            maximumDemands: 4,
            transitionReservePages: 4,
            refineErrorPixels: 2,
            coarsenErrorPixels: 1,
            levelMetrics: [ metric(1, 100_000), metric(2, 100) ],
            maxPhysicalPages: 8,
        })
        let frontier
        let capture
        try {
            const root = page(env, 1, 0, 0)
            const demandedChildren = children(env, root)
            const publication = await publishPages(env, [ root ], 'canonical-demand-root')
            frontier = await createFrontier(env)
            capture = await createCapture(frontier, 'canonical-demand-capture')
            const frameResult = await executeFrame({
                env,
                frontier,
                capture,
                seed: frontier.stageSeed(publication.snapshot),
                view: allWorldView(0, publication.snapshot.epoch, 50),
                current: seedEntries(frontier, publication),
                residentPages: [ root ],
            })
            const demandKeys = frameResult.demands.map(demand =>
                `${demand.matrixLevel}/${demand.tileRow}/${demand.tileCol}`
            )
            assertEqual(
                demandKeys,
                demandedChildren.map(child => child.key),
                'packed demand records must preserve canonical child order'
            )
            assert(
                frameResult.demands.length === 4 && frameResult.facts.demandCount === 4,
                'browser proof must decode a nonzero four-child packed demand transaction'
            )
            const disposal = disposeScenario(frontier, capture, env)
            frontier = undefined
            capture = undefined
            return {
                demandKeys,
                demandCount: frameResult.demands.length,
                packedByteLength: frameResult.demands.length *
                    gpuTileFrontierLayouts.demand.byteSize,
                facts: frameResult.facts,
                nextDispatchWords: frameResult.nextDispatchWords,
                outcomes: [ frameResult.outcome ],
                disposal,
            }
        } finally {
            capture?.dispose()
            frontier?.dispose()
            env.gpuState?.dispose()
            env.residency.dispose()
        }
    }

    async function feedbackRingScenario() {

        const env = await createEnvironment({
            id: 'bounded-feedback-ring',
            limits: [
                {
                    matrixId: '1',
                    minTileRow: 0,
                    maxTileRow: 0,
                    minTileCol: 0,
                    maxTileCol: 0,
                },
                {
                    matrixId: '2',
                    minTileRow: 0,
                    maxTileRow: 1,
                    minTileCol: 0,
                    maxTileCol: 1,
                },
            ],
            minimumMatrixLevel: 1,
            maximumMatrixLevel: 2,
            maximumActiveTiles: 4,
            maximumDemands: 4,
            transitionReservePages: 4,
            refineErrorPixels: 2,
            coarsenErrorPixels: 1,
            levelMetrics: [ metric(1, 100_000), metric(2, 100) ],
            maxPhysicalPages: 8,
        })
        let frontier
        let ring
        try {
            const root = page(env, 1, 0, 0)
            const demandedChildren = children(env, root)
            const publication = await publishPages(env, [ root ], 'bounded-feedback-root')
            frontier = await createFrontier(env)
            ring = await VirtualRasterGpuFeedbackRing.create(frontier)
            const seed = frontier.stageSeed(publication.snapshot)

            const issue = async(frameEpoch, initialSeed) => {
                const viewToken = frontier.writeView(
                    allWorldView(frameEpoch, publication.snapshot.epoch, 50)
                )
                try {
                    const frame = frontier.frame(viewToken)
                    const builder = runtime.createSubmission({ validation: 'throw' })
                    if (initialSeed !== undefined) appendSeed(builder, initialSeed)
                    const submitted = ring.encode(
                        frontier.encode(builder, frame),
                        frame
                    ).submit()
                    const outcome = await submitted.nativeOutcome
                    assert(
                        outcome.status === 'observed-succeeded',
                        `feedback ring frame ${frameEpoch} submission failed`
                    )
                    return { frame, submitted, outcome: outcome.status }
                } finally {
                    viewToken.dispose()
                }
            }

            const first = await issue(0, seed)
            let tooRecentCode
            try {
                await ring.feedback(first.frame, first.submitted)
            } catch (error) {
                tooRecentCode = error?.diagnostic?.code
            }
            assert(
                tooRecentCode === 'GEO_GPU_TILE_FEEDBACK_TOO_RECENT',
                'same-issue feedback must be rejected before consuming its slot'
            )
            const second = await issue(1)
            const feedback = await ring.feedback(first.frame, first.submitted)
            const demandKeys = feedback.demands.map(demand => demand.page.key)
            assertEqual(
                demandKeys,
                demandedChildren.map(child => child.key),
                'public feedback ring must decode canonical child demand order'
            )
            assert(
                feedback.demands.length === 4 && feedback.facts.demandCount === 4,
                'public feedback ring must decode a nonzero four-child GPU demand batch'
            )
            assert(
                !('bytes' in feedback),
                'public feedback batches must not expose mapped or copied bytes'
            )
            const ringFacts = ring.facts()
            assert(
                ringFacts.slotCount === 3 && ringFacts.issuedCount === 2,
                'public feedback ring must remain fixed at three slots and record two issues'
            )

            frontier.dispose()
            const disposal = {
                frontierDisposed: frontier.facts().disposed,
                feedbackRingDisposed: ring.facts().disposed,
                borrowedSlotTableAlive: !env.gpuState.slotTable.isDisposed,
            }
            frontier = undefined
            ring = undefined
            env.gpuState.dispose()
            env.residency.dispose()
            return {
                frameEpoch: feedback.frameEpoch,
                residencySnapshotEpoch: feedback.residencySnapshotEpoch,
                demandKeys,
                demandCount: feedback.demands.length,
                rawBytesExposed: 'bytes' in feedback,
                tooRecentCode,
                ringFacts,
                outcomes: [ first.outcome, second.outcome ],
                disposal,
            }
        } finally {
            ring?.dispose()
            frontier?.dispose()
            env.gpuState?.dispose()
            env.residency.dispose()
        }
    }

    async function precisionScenario() {

        const matrixLevel = 24
        const dimension = 2 ** matrixLevel
        const row = dimension / 2
        const firstColumn = dimension - 2
        const lastColumn = dimension - 1
        const env = await createEnvironment({
            id: 'z24-edge',
            limits: [ {
                matrixId: String(matrixLevel),
                minTileRow: row,
                maxTileRow: row,
                minTileCol: firstColumn,
                maxTileCol: lastColumn,
            } ],
            minimumMatrixLevel: matrixLevel,
            maximumMatrixLevel: matrixLevel,
            maximumActiveTiles: 2,
            maximumDemands: 2,
            transitionReservePages: 2,
            refineErrorPixels: 2,
            coarsenErrorPixels: 1,
            levelMetrics: [ metric(matrixLevel, 100) ],
            maxPhysicalPages: 4,
        })
        let frontier
        let capture
        try {
            const roots = rootPages(env)
            const publication = await publishPages(env, roots, 'z24-edge-roots')
            frontier = await createFrontier(env)
            capture = await createCapture(frontier, 'z24-edge-capture')
            const tileExtent = 2 * HALF_WORLD / dimension
            const cameraX = HALF_WORLD - tileExtent
            const cameraY = -tileExtent / 2
            const view = orthographicView({
                frameEpoch: 0,
                snapshotEpoch: publication.snapshot.epoch,
                camera: [ cameraX, cameraY, 50 ],
                xHalfExtent: tileExtent * 0.75,
                yHalfExtent: tileExtent * 0.75,
                zScale: 0.01,
                zTranslate: 0.5,
                zoomHint: matrixLevel,
            })
            const frameResult = await executeFrame({
                env,
                frontier,
                capture,
                seed: frontier.stageSeed(publication.snapshot),
                view,
                current: seedEntries(frontier, publication),
                residentPages: roots,
            })
            assertEqual(
                frameResult.keys,
                roots.map(root => root.key),
                'z24 edge tiles must retain stable visible extents'
            )
            assert(frameResult.visible.length === 2, 'both z24 edge tiles must be visible')
            const disposal = disposeScenario(frontier, capture, env)
            frontier = undefined
            capture = undefined
            return {
                matrixLevel,
                tileExtentMeters: tileExtent,
                cameraHigh: view.cameraHigh,
                cameraLow: view.cameraLow,
                keys: frameResult.keys,
                visibleCount: frameResult.visible.length,
                facts: frameResult.facts,
                nextDispatchWords: frameResult.nextDispatchWords,
                hash: frameResult.hash,
                outcomes: [ frameResult.outcome ],
                disposal,
            }
        } finally {
            capture?.dispose()
            frontier?.dispose()
            env.gpuState?.dispose()
            env.residency.dispose()
        }
    }

    async function balancePressureScenario() {

        const env = await createEnvironment({
            id: 'balance-pressure-chain',
            limits: [ fullLimit(1), fullLimit(2), fullLimit(3), fullLimit(4) ],
            minimumMatrixLevel: 1,
            maximumMatrixLevel: 4,
            maximumActiveTiles: 7,
            maximumDemands: 6,
            transitionReservePages: 6,
            refineErrorPixels: 2,
            coarsenErrorPixels: 1,
            levelMetrics: [
                metric(1, 5_000),
                metric(2, 5_000),
                metric(3, 100_000),
                metric(4, 5_000),
            ],
            maxPhysicalPages: 16,
        })
        let frontier
        let capture
        try {
            const fine = page(env, 3, 0, 1)
            const middle = page(env, 2, 0, 1)
            const coarse = page(env, 1, 0, 1)
            const competitor = page(env, 1, 1, 0)
            const competitorChildren = children(env, competitor)
            const residentPages = [ ...new Map([
                ...rootPages(env),
                fine,
                middle,
                ...competitorChildren,
            ].map(residentPage => [ residentPage.key, residentPage ])).values() ]
            const publication = await publishPages(
                env,
                residentPages,
                'balance-pressure-pages'
            )
            frontier = await createFrontier(env)
            capture = await createCapture(frontier, 'balance-pressure-capture')
            const current = [
                residentEntry(frontier.descriptor, publication, fine, 'retain', 0),
                Object.freeze({
                    ...residentEntry(frontier.descriptor, publication, middle, 'retain', 0),
                    lastDemandFrame: 63,
                }),
                Object.freeze({
                    ...residentEntry(frontier.descriptor, publication, coarse, 'retain', 0),
                    lastDemandFrame: 63,
                }),
                residentEntry(frontier.descriptor, publication, competitor, 'retain', 0),
            ]
            const frameResult = await executeFrame({
                env,
                frontier,
                capture,
                seed: frontier.stageSeed(publication.snapshot),
                view: allWorldView(63, publication.snapshot.epoch, 50),
                current,
                residentPages,
                createExtraUploads(frame, access) {
                    const counters = new Uint32Array(32)
                    counters[0] = current.length
                    const counterSection = frame.feedbackOutput.layout.counters
                    return [
                        runtime.createUploadCommand({
                            label: 'Inject balance pressure frontier',
                            target: access.currentFrontier.region({
                                size: current.length * gpuTileFrontierLayouts.frontierEntry.byteSize,
                                layout: gpuTileFrontierEntryCodec.artifact,
                            }),
                            data: gpuTileFrontierEntryCodec.uploadView(
                                current.map(entryRecord)
                            ),
                        }),
                        runtime.createUploadCommand({
                            label: 'Inject balance pressure dispatch arguments',
                            target: access.currentDispatchArguments.region(),
                            data: new Uint32Array([ 1, 1, 1 ]),
                        }),
                        runtime.createUploadCommand({
                            label: 'Inject balance pressure counters',
                            target: access.feedbackOutput.region({
                                offset: counterSection.offset,
                                size: counterSection.byteLength,
                            }),
                            data: counters,
                        }),
                    ]
                },
            })
            assertEqual(frameResult.keys, [
                fine.key,
                middle.key,
                coarse.key,
                ...competitorChildren.map(child => child.key),
            ], 'base-priority pressure chain competitor output')
            assertEqual({
                refineCandidateCount: frameResult.facts.refineCandidateCount,
                budgetLimitedCount: frameResult.facts.budgetLimitedCount,
                fallbackCount: frameResult.facts.fallbackCount,
            }, {
                refineCandidateCount: 4,
                budgetLimitedCount: 2,
                fallbackCount: 1,
            }, 'base-priority pressure chain facts')
            const disposal = disposeScenario(frontier, capture, env)
            frontier = undefined
            capture = undefined
            return {
                keys: frameResult.keys,
                facts: frameResult.facts,
                diagnostics: frameResult.diagnostics,
                nextDispatchWords: frameResult.nextDispatchWords,
                hash: frameResult.hash,
                outcomes: [ frameResult.outcome ],
                disposal,
            }
        } finally {
            capture?.dispose()
            frontier?.dispose()
            env.gpuState?.dispose()
            env.residency.dispose()
        }
    }

    async function eastEdgePrecisionScenario() {

        const env = await createEnvironment({
            id: 'z1-east-edge-sse',
            limits: [
                {
                    matrixId: '1',
                    minTileRow: 0,
                    maxTileRow: 0,
                    minTileCol: 0,
                    maxTileCol: 0,
                },
                {
                    matrixId: '2',
                    minTileRow: 0,
                    maxTileRow: 1,
                    minTileCol: 0,
                    maxTileCol: 1,
                },
            ],
            minimumMatrixLevel: 1,
            maximumMatrixLevel: 2,
            maximumActiveTiles: 4,
            maximumDemands: 4,
            transitionReservePages: 4,
            refineErrorPixels: 10_000,
            coarsenErrorPixels: 1,
            levelMetrics: [ metric(1, 1), metric(2, 1) ],
            maxPhysicalPages: 8,
        })
        let frontier
        let capture
        try {
            const root = page(env, 1, 0, 0)
            const childPages = children(env, root)
            const publication = await publishPages(
                env,
                [ root, ...childPages ],
                'z1-east-edge-pages'
            )
            frontier = await createFrontier(env)
            capture = await createCapture(frontier, 'z1-east-edge-capture')
            const cameraX = 0.1
            const view = orthographicView({
                frameEpoch: 0,
                snapshotEpoch: publication.snapshot.epoch,
                camera: [ cameraX, HALF_WORLD / 2, 50 ],
                xHalfExtent: HALF_WORLD,
                yHalfExtent: HALF_WORLD,
                zScale: 0.01,
                zTranslate: 0.5,
                zoomHint: 1,
            })
            const frameResult = await executeFrame({
                env,
                frontier,
                capture,
                seed: frontier.stageSeed(publication.snapshot),
                view,
                current: seedEntries(frontier, publication),
                residentPages: [ root, ...childPages ],
            })
            assertEqual(
                frameResult.keys,
                [ root.key ],
                'z1 east-edge SSE must use the independently reconstructed -0.1m edge'
            )
            const disposal = disposeScenario(frontier, capture, env)
            frontier = undefined
            capture = undefined
            return {
                cameraX,
                refineErrorPixels: env.refineErrorPixels,
                retainedKeys: frameResult.keys,
                facts: frameResult.facts,
                nextDispatchWords: frameResult.nextDispatchWords,
                hash: frameResult.hash,
                outcomes: [ frameResult.outcome ],
                disposal,
            }
        } finally {
            capture?.dispose()
            frontier?.dispose()
            env.gpuState?.dispose()
            env.residency.dispose()
        }
    }

    async function eastEdgeCounterexampleScenario() {

        const env = await createEnvironment({
            id: 'z1-east-edge-unequal-high',
            limits: [
                {
                    matrixId: '1',
                    minTileRow: 0,
                    maxTileRow: 0,
                    minTileCol: 0,
                    maxTileCol: 0,
                },
                {
                    matrixId: '2',
                    minTileRow: 0,
                    maxTileRow: 1,
                    minTileCol: 0,
                    maxTileCol: 1,
                },
            ],
            minimumMatrixLevel: 1,
            maximumMatrixLevel: 2,
            maximumActiveTiles: 4,
            maximumDemands: 4,
            transitionReservePages: 4,
            refineErrorPixels: 300,
            coarsenErrorPixels: 1,
            levelMetrics: [ metric(1, 1), metric(2, 1) ],
            maxPhysicalPages: 8,
        })
        let frontier
        let capture
        try {
            const root = page(env, 1, 0, 0)
            const childPages = children(env, root)
            const publication = await publishPages(
                env,
                [ root, ...childPages ],
                'z1-east-edge-unequal-high-pages'
            )
            frontier = await createFrontier(env)
            capture = await createCapture(frontier, 'z1-east-edge-unequal-high-capture')
            const cameraX = 1.3
            const view = orthographicView({
                frameEpoch: 0,
                snapshotEpoch: publication.snapshot.epoch,
                camera: [ cameraX, HALF_WORLD / 2, 50 ],
                xHalfExtent: HALF_WORLD,
                yHalfExtent: HALF_WORLD,
                zScale: 0.01,
                zTranslate: 0.5,
                zoomHint: 1,
            })
            const frameResult = await executeFrame({
                env,
                frontier,
                capture,
                seed: frontier.stageSeed(publication.snapshot),
                view,
                current: seedEntries(frontier, publication),
                residentPages: [ root, ...childPages ],
            })
            assertEqual(
                frameResult.keys,
                childPages.map(child => child.key),
                'z1 +1.3m east-edge threshold 300 must refine on CPU and GPU'
            )
            assert(
                frameResult.facts.maximumObservedSse > env.refineErrorPixels,
                'production GPU SSE must exceed the +1.3m counterexample threshold'
            )
            const disposal = disposeScenario(frontier, capture, env)
            frontier = undefined
            capture = undefined
            return {
                cameraX,
                refineErrorPixels: env.refineErrorPixels,
                refinedKeys: frameResult.keys,
                maximumObservedSse: frameResult.facts.maximumObservedSse,
                facts: frameResult.facts,
                nextDispatchWords: frameResult.nextDispatchWords,
                outcomes: [ frameResult.outcome ],
                disposal,
            }
        } finally {
            capture?.dispose()
            frontier?.dispose()
            env.gpuState?.dispose()
            env.residency.dispose()
        }
    }

    async function visibilityGraceScenario() {

        const env = await createEnvironment({
            id: 'visibility-grace',
            limits: [
                {
                    matrixId: '1',
                    minTileRow: 0,
                    maxTileRow: 0,
                    minTileCol: 0,
                    maxTileCol: 0,
                },
                {
                    matrixId: '2',
                    minTileRow: 0,
                    maxTileRow: 1,
                    minTileCol: 0,
                    maxTileCol: 1,
                },
            ],
            minimumMatrixLevel: 1,
            maximumMatrixLevel: 2,
            maximumActiveTiles: 4,
            maximumDemands: 4,
            transitionReservePages: 4,
            refineErrorPixels: 2,
            coarsenErrorPixels: 1,
            invisibleGraceFrames: 2,
            levelMetrics: [ metric(1, 1_000), metric(2, 1_000) ],
            maxPhysicalPages: 8,
        })
        let frontier
        let capture
        try {
            const root = page(env, 1, 0, 0)
            const childPages = children(env, root)
            const publication = await publishPages(
                env,
                [ root, ...childPages ],
                'visibility-grace-pages'
            )
            frontier = await createFrontier(env)
            capture = await createCapture(frontier, 'visibility-grace-capture')
            let current = seedEntries(frontier, publication)
            const refine = await executeFrame({
                env,
                frontier,
                capture,
                seed: frontier.stageSeed(publication.snapshot),
                view: allWorldView(0, publication.snapshot.epoch, 50),
                current,
                residentPages: [ root, ...childPages ],
            })
            assertEqual(refine.keys, childPages.map(child => child.key), 'grace setup refinement')
            current = refine.nextCurrent
            const coarsenView = orthographicView({
                frameEpoch: 1,
                snapshotEpoch: publication.snapshot.epoch,
                camera: [ 0, 0, 2_000_000 ],
                xHalfExtent: HALF_WORLD,
                yHalfExtent: HALF_WORLD,
                zScale: 1 / 4_000_000,
                zTranslate: 0.75,
                zoomHint: 1,
            })
            const coarsen = await executeFrame({
                env,
                frontier,
                capture,
                view: coarsenView,
                current,
                residentPages: [ root, ...childPages ],
            })
            assertEqual(coarsen.keys, [ root.key ], 'complete visible siblings must coarsen once')
            assert(
                coarsen.frontier[0].transitionState === 1,
                'coarsened parent must carry the current visible frame for grace'
            )
            const disposal = disposeScenario(frontier, capture, env)
            frontier = undefined
            capture = undefined
            return {
                refinedKeys: refine.keys,
                coarsenedKeys: coarsen.keys,
                parentLastVisibleFrame: coarsen.frontier[0].transitionState,
                decisionFrameEpoch: 1,
                facts: coarsen.facts,
                nextDispatchWords: coarsen.nextDispatchWords,
                hash: coarsen.hash,
                outcomes: [ refine.outcome, coarsen.outcome ],
                disposal,
            }
        } finally {
            capture?.dispose()
            frontier?.dispose()
            env.gpuState?.dispose()
            env.residency.dispose()
        }
    }

    async function offAxisPitchScenario() {

        const matrixLevel = 12
        const row = 2 ** (matrixLevel - 1)
        const outsideColumn = row - 8
        const nearColumn = row
        const farColumn = row + 2
        const env = await createEnvironment({
            id: 'off-axis-high-pitch',
            limits: [
                {
                    matrixId: String(matrixLevel),
                    minTileRow: row,
                    maxTileRow: row,
                    minTileCol: outsideColumn,
                    maxTileCol: farColumn,
                },
                {
                    matrixId: String(matrixLevel + 1),
                    minTileRow: row * 2,
                    maxTileRow: row * 2 + 1,
                    minTileCol: outsideColumn * 2,
                    maxTileCol: farColumn * 2 + 1,
                },
            ],
            minimumMatrixLevel: matrixLevel,
            maximumMatrixLevel: matrixLevel + 1,
            maximumActiveTiles: 16,
            maximumDemands: 8,
            transitionReservePages: 8,
            refineErrorPixels: 20,
            coarsenErrorPixels: 2,
            levelMetrics: [ metric(matrixLevel, 1_000), metric(matrixLevel + 1, 1) ],
            maxPhysicalPages: 32,
        })
        let frontier
        let capture
        try {
            const outside = page(env, matrixLevel, row, outsideColumn)
            const near = page(env, matrixLevel, row, nearColumn)
            const far = page(env, matrixLevel, row, farColumn)
            const nearChildren = children(env, near)
            const farChildren = children(env, far)
            const residentPages = [
                ...rootPages(env),
                ...nearChildren,
                ...farChildren,
            ]
            const publication = await publishPages(
                env,
                residentPages,
                'off-axis-high-pitch-pages'
            )
            frontier = await createFrontier(env)
            capture = await createCapture(frontier, 'off-axis-high-pitch-capture')
            const current = [
                residentEntry(frontier.descriptor, publication, outside, 'retain', 0),
                residentEntry(frontier.descriptor, publication, near, 'retain', 0),
                ...farChildren.map(child => residentEntry(
                    frontier.descriptor,
                    publication,
                    child,
                    'retain',
                    0
                )),
            ]
            const tileExtent = 2 * HALF_WORLD / 2 ** matrixLevel
            const camera = [ tileExtent / 2, -tileExtent / 2, 15_000 ]
            const direction = [ tileExtent * 2, 0, -15_000 ]
            const view = perspectiveView({
                frameEpoch: 10,
                snapshotEpoch: publication.snapshot.epoch,
                camera,
                direction,
                verticalFovRadians: 100 * Math.PI / 180,
                near: 10,
                far: 100_000,
                zoomHint: matrixLevel,
            })
            const frameResult = await executeFrame({
                env,
                frontier,
                capture,
                seed: frontier.stageSeed(publication.snapshot),
                view,
                current,
                residentPages,
                createExtraUploads(frame, access) {
                    const counters = new Uint32Array(32)
                    counters[0] = current.length
                    const counterSection = frame.feedbackOutput.layout.counters
                    return [
                        runtime.createUploadCommand({
                            label: 'Inject off-axis frontier',
                            target: access.currentFrontier.region({
                                size: current.length * gpuTileFrontierLayouts.frontierEntry.byteSize,
                                layout: gpuTileFrontierEntryCodec.artifact,
                            }),
                            data: gpuTileFrontierEntryCodec.uploadView(current.map(entryRecord)),
                        }),
                        runtime.createUploadCommand({
                            label: 'Inject off-axis dispatch arguments',
                            target: access.currentDispatchArguments.region(),
                            data: new Uint32Array([ 1, 1, 1 ]),
                        }),
                        runtime.createUploadCommand({
                            label: 'Inject off-axis counters',
                            target: access.feedbackOutput.region({
                                offset: counterSection.offset,
                                size: counterSection.byteLength,
                            }),
                            data: counters,
                        }),
                    ]
                },
            })
            assertEqual(frameResult.keys, [
                outside.key,
                ...nearChildren.map(child => child.key),
                far.key,
            ], 'off-axis view must refine near and coarsen far')
            const outsideCompactIndex = env.coverage.index(outside.tile)
            assert(
                !frameResult.visible.some(entry => entry.compactIndex === outsideCompactIndex),
                'off-axis tile behind the pitched camera must be absent from visible output'
            )
            assert(
                frameResult.facts.refineCandidateCount >= 1 &&
                frameResult.facts.coarsenCandidateCount >= 1,
                'off-axis production facts must observe both near refine and far coarsen'
            )
            const disposal = disposeScenario(frontier, capture, env)
            frontier = undefined
            capture = undefined
            return {
                matrixLevel,
                camera,
                direction,
                refinedNearKeys: nearChildren.map(child => child.key),
                coarsenedFarKey: far.key,
                outsideKey: outside.key,
                outsideVisible: false,
                visibleCompactIndexes: frameResult.visible.map(entry => entry.compactIndex),
                facts: frameResult.facts,
                outcomes: [ frameResult.outcome ],
                disposal,
            }
        } finally {
            capture?.dispose()
            frontier?.dispose()
            env.gpuState?.dispose()
            env.residency.dispose()
        }
    }

    async function createEnvironment(options) {

        const coverage = tileMatrixCoverage({
            tileMatrixSet: WebMercatorQuad,
            limits: options.limits,
        })
        const addressSpace = virtualRasterTileAddressSpace({
            id: `browser-frontier-${options.id}`,
            coverage,
        })
        const addressCodec = webMercatorQuadAddressCodec({ coverage })
        const plane = virtualRasterPlane({
            id: `browser-frontier-height-${options.id}`,
            addressSpace,
            kind: 'scalar',
            channels: 1,
            sampleType: 'unorm8',
            gpuFormat: 'r8unorm',
        })
        const [ width, height ] = addressSpace.pageSize
        const residency = new VirtualRasterResidency({
            addressSpace,
            plane,
            maxPhysicalPages: options.maxPhysicalPages,
            maxStagingBytes: width * height * options.maxPhysicalPages,
        })
        const gpuState = await createVirtualRasterGpuState(runtime, {
            addressSpace,
            plane,
            maxPhysicalPages: options.maxPhysicalPages,
        })
        const minimumMatrixLevel = options.minimumMatrixLevel ??
            Number(options.limits[0].matrixId)
        return {
            ...options,
            coverage,
            addressSpace,
            addressCodec,
            plane,
            residency,
            gpuState,
            width,
            height,
            minimumMatrixLevel,
            invisibleGraceFrames: options.invisibleGraceFrames ?? 2,
        }
    }

    async function createFrontier(env) {

        return await GpuTileFrontier.create(runtime, {
            gpuState: env.gpuState,
            addressCodec: env.addressCodec,
            policy: gpuTileFrontierPolicy({
                refineErrorPixels: env.refineErrorPixels,
                coarsenErrorPixels: env.coarsenErrorPixels,
                minimumMatrixLevel: env.minimumMatrixLevel,
                maximumMatrixLevel: env.maximumMatrixLevel,
                maximumActiveTiles: env.maximumActiveTiles,
                maximumDemands: env.maximumDemands,
                transitionReservePages: env.transitionReservePages,
                invisibleGraceFrames: env.invisibleGraceFrames,
            }),
            levelMetrics: env.levelMetrics,
            roots: rootPages(env).reverse(),
            drawTemplates: [ { id: 'terrain', vertexCount: 6 } ],
        })
    }

    async function publishPages(env, pages, versionPrefix) {

        pages.forEach((residentPage, index) => {
            const outcome = env.residency.stage(ownedVirtualRasterPagePayload({
                page: residentPage,
                width: env.width,
                height: env.height,
                channels: 1,
                data: new Uint8Array(env.width * env.height),
                contentVersion: `${versionPrefix}-${index}`,
            }), { generation: 1 })
            assert(
                outcome.status === 'staged' || outcome.status === 'resident',
                `page ${residentPage.key} failed to stage: ${outcome.status}`
            )
        })
        const publication = env.residency.publish()
        const update = env.gpuState.stage(publication)
        const builder = runtime.createSubmission({ validation: 'throw' })
        for (const command of update.commands) builder.upload(command)
        const submitted = builder.submit()
        await env.gpuState.acknowledge(publication, submitted)
        const outcome = await submitted.nativeOutcome
        assert(outcome.status === 'observed-succeeded', 'residency publication failed')
        return publication
    }

    async function executeFrame(input) {

        const viewToken = input.frontier.writeView(input.view)
        const frame = input.frontier.frame(viewToken)
        const frameAccess = gpuTileFrontierTestFrameAccess(input.frontier, frame)
        const extras = input.createExtraUploads?.(frame, frameAccess) ?? []
        const residentPages = residentRecords(input.env, input.residentPages)
        const oracle = evaluateGpuTileFrontierReference({
            descriptor: input.frontier.descriptor,
            view: input.view,
            currentFrontier: input.current,
            residentPages,
        })
        const captureCommand = await input.capture.commandFor(frame)
        const builder = runtime.createSubmission({ validation: 'throw' })
        if (input.seed !== undefined) appendSeed(builder, input.seed)
        input.capture.prepare(builder)
        for (const extra of extras) builder.upload(extra)
        const submitted = input.frontier.encode(builder, frame)
            .compute(input.capture.pass, [ captureCommand ])
            .readback(input.capture.readback)
            .submit()
        const bytes = (await input.capture.readback.result({ after: submitted }).toBytes()).slice()
        const nativeOutcome = await submitted.nativeOutcome
        assert(nativeOutcome.status === 'observed-succeeded', 'frontier submission failed')
        const decoded = decodeCapture(input.frontier, bytes, oracle)
        assertFacts(decoded.facts, oracle.facts, input.view.frameEpoch)
        assertEqual(
            decoded.frontier,
            oracle.nextFrontier.map(normalizeReferenceEntry),
            `GPU frontier bytes differ from oracle at frame ${input.view.frameEpoch}`
        )
        assertEqual(
            decoded.visible,
            oracle.visible.map(normalizeReferenceVisible),
            `GPU visible bytes differ from oracle at frame ${input.view.frameEpoch}`
        )
        assertEqual(
            decoded.demands,
            oracle.demands.map(demand => normalizeReferenceDemand(input.frontier, demand)),
            `GPU demands differ from oracle at frame ${input.view.frameEpoch}`
        )
        const retirements = expectedRetirements(input.current, oracle, residentPages)
        assertEqual(
            decoded.retirements,
            retirements.map(normalizeReferenceEntry),
            `GPU retirements differ from oracle at frame ${input.view.frameEpoch}`
        )
        assertCounters(decoded.counters, oracle.facts, retirements.length)
        assertEqual(
            decoded.nextDispatchWords,
            [ Math.ceil(oracle.nextFrontier.length / 64), 1, 1 ],
            'next indirect dispatch words'
        )
        assertEqual(decoded.drawWords, [ 6, oracle.visible.length, 0, 0 ], 'indirect draw words')
        extras.forEach(command => command.dispose())
        viewToken.dispose()
        return {
            frame,
            frontier: decoded.frontier,
            visible: decoded.visible,
            demands: decoded.demands,
            retirements: decoded.retirements,
            counters: decoded.counters,
            diagnostics: decoded.diagnostics,
            facts: decoded.facts,
            nextDispatchWords: decoded.nextDispatchWords,
            keys: oracle.nextFrontier.map(entry => entry.page.key),
            nextCurrent: oracle.nextFrontier,
            canonicalBytes: decoded.canonicalBytes,
            hash: byteHash(decoded.canonicalBytes),
            outcome: nativeOutcome.status,
        }
    }

    async function createCapture(frontier, label) {

        const capacity = frontier.descriptor.policy.maximumActiveTiles
        const feedbackLayout = frontier.facts().feedbackOutput.layout
        const frontierWords = capacity * gpuTileFrontierLayouts.frontierEntry.byteSize / 4
        const visibleWords = capacity * gpuTileFrontierLayouts.visibleInstance.byteSize / 4
        const feedbackWords = feedbackLayout.byteLength / 4
        const drawOffset = 0
        const dispatchOffset = drawOffset + 4
        const feedbackOffset = dispatchOffset + 3
        const frontierOffset = feedbackOffset + feedbackWords
        const visibleOffset = frontierOffset + frontierWords
        const captureWords = visibleOffset + visibleWords
        const buffer = await runtime.createBuffer({
            label,
            size: captureWords * 4,
            usage: BUFFER_COPY_SRC | BUFFER_COPY_DST | BUFFER_STORAGE,
        })
        const layout = await runtime.createBindLayout({
            label: `${label} layout`,
            group: 0,
            entries: [
                storageBinding(0, 'frontierSource', 'read-storage', capacity *
                    gpuTileFrontierLayouts.frontierEntry.byteSize),
                storageBinding(1, 'visibleSource', 'read-storage', capacity *
                    gpuTileFrontierLayouts.visibleInstance.byteSize),
                storageBinding(2, 'drawSource', 'read-storage', 16),
                storageBinding(3, 'dispatchSource', 'read-storage', 12),
                storageBinding(4, 'feedbackSource', 'read-storage', feedbackLayout.byteLength),
                storageBinding(5, 'captureOutput', 'storage', captureWords * 4),
            ],
        })
        const shader = await runtime.createShaderModule({
            label: `${label} shader`,
            sourceParts: [ {
                label: `${label} raw storage copier`,
                code: `
const FRONTIER_WORDS: u32 = ${frontierWords}u;
const VISIBLE_WORDS: u32 = ${visibleWords}u;
const FEEDBACK_WORDS: u32 = ${feedbackWords}u;
const CAPTURE_WORDS: u32 = ${captureWords}u;
@group(0) @binding(0) var<storage, read> frontierSource: array<u32>;
@group(0) @binding(1) var<storage, read> visibleSource: array<u32>;
@group(0) @binding(2) var<storage, read> drawSource: array<u32>;
@group(0) @binding(3) var<storage, read> dispatchSource: array<u32>;
@group(0) @binding(4) var<storage, read> feedbackSource: array<u32>;
@group(0) @binding(5) var<storage, read_write> captureOutput: array<u32>;
@compute @workgroup_size(64)
fn capture(@builtin(global_invocation_id) id: vec3u) {
    let index = id.x;
    if (index >= CAPTURE_WORDS) { return; }
    if (index < ${dispatchOffset}u) {
        captureOutput[index] = drawSource[index];
    } else if (index < ${feedbackOffset}u) {
        captureOutput[index] = dispatchSource[index - ${dispatchOffset}u];
    } else if (index < ${frontierOffset}u) {
        captureOutput[index] = feedbackSource[index - ${feedbackOffset}u];
    } else if (index < ${visibleOffset}u) {
        captureOutput[index] = frontierSource[index - ${frontierOffset}u];
    } else {
        captureOutput[index] = visibleSource[index - ${visibleOffset}u];
    }
}`,
            } ],
        })
        const program = runtime.createProgram({
            label: `${label} program`,
            compute: { module: shader, entryPoint: 'capture' },
        })
        const pipeline = await runtime.createComputePipeline({
            label: `${label} pipeline`,
            program,
            layout: { mode: 'explicit', bindLayouts: [ layout ] },
        })
        const pass = runtime.createComputePass({ label: `${label} pass` })
        const initialize = runtime.createClearBufferCommand({
            label: `${label} initialize`,
            target: buffer.region(),
        })
        const readback = await runtime.createReadbackCommand({
            label: `${label} readback`,
            source: { region: buffer.region(), contentEpoch: 'current-at-step' },
            whenMissing: 'throw',
        })
        const commands = new Map()
        let initialized = false
        return {
            pass,
            readback,
            prepare(builder) {
                if (initialized) return
                builder.clear(initialize)
                initialized = true
            },
            async commandFor(frame) {
                const existing = commands.get(frame.parity)
                if (existing !== undefined) return existing.command
                const access = gpuTileFrontierTestFrameAccess(frontier, frame)
                const draw = frontier.drawArgument(frame, 'terrain')
                const bindSet = await runtime.createBindSet(layout, {
                    frontierSource: access.nextFrontier.region(),
                    visibleSource: frame.visibleInstances.region(),
                    drawSource: draw.region,
                    dispatchSource: access.nextDispatchArguments.region(),
                    feedbackSource: access.feedbackOutput.region(),
                    captureOutput: buffer.region(),
                }, { label: `${label} parity ${frame.parity} set` })
                const command = runtime.createDispatchCommand({
                    label: `${label} parity ${frame.parity} dispatch`,
                    pipeline,
                    bindSets: [ { set: bindSet } ],
                    count: { workgroups: [ Math.ceil(captureWords / 64), 1, 1 ] },
                    resources: {
                        read: [
                            currentRead(access.nextFrontier),
                            currentRead(frame.visibleInstances),
                            currentRead(draw.resource),
                            currentRead(access.nextDispatchArguments),
                            currentRead(access.feedbackOutput),
                            currentRead(buffer),
                        ],
                        write: [ buffer ],
                    },
                    whenMissing: 'throw',
                })
                commands.set(frame.parity, { command, bindSet })
                return command
            },
            dispose() {
                for (const value of commands.values()) {
                    value.command.dispose()
                    value.bindSet.dispose()
                }
                initialize.dispose()
                readback.dispose()
                pass.dispose()
                pipeline.dispose()
                program.dispose()
                shader.dispose()
                layout.dispose()
                buffer.dispose()
            },
        }
    }

    function decodeCapture(frontier, bytes, oracle) {

        const capacity = frontier.descriptor.policy.maximumActiveTiles
        const feedbackLayout = frontier.facts().feedbackOutput.layout
        const frontierByteLength = capacity * gpuTileFrontierLayouts.frontierEntry.byteSize
        const visibleByteLength = capacity * gpuTileFrontierLayouts.visibleInstance.byteSize
        const drawStart = 0
        const dispatchStart = drawStart + 16
        const feedbackStart = dispatchStart + 12
        const frontierStart = feedbackStart + feedbackLayout.byteLength
        const visibleStart = frontierStart + frontierByteLength
        const drawBytes = bytes.subarray(0, 16)
        const drawWords = Array.from(new Uint32Array(
            drawBytes.buffer,
            drawBytes.byteOffset,
            4
        ))
        const dispatchBytes = bytes.subarray(dispatchStart, feedbackStart)
        const nextDispatchWords = Array.from(new Uint32Array(
            dispatchBytes.buffer,
            dispatchBytes.byteOffset,
            3
        ))
        const feedbackBytes = bytes.subarray(feedbackStart, frontierStart)
        const countersBytes = feedbackSectionBytes(feedbackBytes, feedbackLayout.counters)
        const counters = Array.from(new Uint32Array(
            countersBytes.buffer,
            countersBytes.byteOffset,
            countersBytes.byteLength / 4
        ))
        const diagnosticsBytes = feedbackSectionBytes(feedbackBytes, feedbackLayout.diagnostics)
        const diagnostics = gpuTileFrontierDiagnosticsCodec
            .createReadbackView(diagnosticsBytes).toArray()[0]
        const demandCount = counters[5]
        const retirementCount = counters[6]
        assert(demandCount <= feedbackLayout.demands.capacity, 'GPU demand count exceeds capacity')
        assert(retirementCount <= feedbackLayout.retirements.capacity,
            'GPU retirement count exceeds capacity')
        const demandBytes = feedbackSectionBytes(feedbackBytes, feedbackLayout.demands)
        const retirementBytes = feedbackSectionBytes(feedbackBytes, feedbackLayout.retirements)
        const demands = gpuTileFrontierDemandCodec.createReadbackView(demandBytes)
            .toArray().slice(0, demandCount)
        const retirements = gpuTileFrontierEntryCodec.createReadbackView(retirementBytes)
            .toArray().slice(0, retirementCount)
        const visibleCount = drawWords[1]
        assert(visibleCount <= capacity, 'GPU draw count exceeds capture capacity')
        assert(oracle.nextFrontier.length <= capacity, 'oracle active count exceeds capture capacity')
        const frontierBytes = bytes.subarray(frontierStart, visibleStart)
        const visibleBytes = bytes.subarray(visibleStart, visibleStart + visibleByteLength)
        const frontierEntries = gpuTileFrontierEntryCodec.createReadbackView(frontierBytes)
            .toArray().slice(0, oracle.nextFrontier.length)
        const visible = gpuTileFrontierVisibleInstanceCodec.createReadbackView(visibleBytes)
            .toArray().slice(0, visibleCount)
        const canonicalBytes = concatenateBytes([
            drawBytes,
            dispatchBytes,
            demandBytes.subarray(0, demandCount * gpuTileFrontierLayouts.demand.byteSize),
            retirementBytes.subarray(
                0,
                retirementCount * gpuTileFrontierLayouts.frontierEntry.byteSize
            ),
            countersBytes,
            diagnosticsBytes,
            frontierBytes.subarray(
                0,
                oracle.nextFrontier.length * gpuTileFrontierLayouts.frontierEntry.byteSize
            ),
            visibleBytes.subarray(0, visibleCount * gpuTileFrontierLayouts.visibleInstance.byteSize),
        ])
        return {
            drawWords,
            nextDispatchWords,
            frontier: frontierEntries,
            visible,
            demands,
            retirements,
            counters,
            diagnostics,
            facts: diagnosticsFacts(diagnostics),
            canonicalBytes: Array.from(canonicalBytes),
        }
    }

    function seedEntries(frontier, publication) {

        return frontier.descriptor.roots.map(root => residentEntry(
            frontier.descriptor,
            publication,
            root,
            'retain',
            0
        ))
    }

    function residentRecords(env, pages) {

        const snapshot = env.gpuState.facts().snapshotEpoch
        const unique = new Map(pages.map(residentPage => [ residentPage.key, residentPage ]))
        return [ ...unique.values() ].map(residentPage => {
            const resolved = env.residency.currentSnapshot.resolve(residentPage)
            assert(
                resolved.status === 'resident' && resolved.resolvedPage?.key === residentPage.key,
                `resident record ${residentPage.key} did not resolve exactly`
            )
            return Object.freeze({
                page: residentPage,
                compactIndex: env.coverage.index(residentPage.tile),
                physicalSlot: resolved.physicalSlot,
                generation: resolved.generation,
                contentEpoch: resolved.contentEpoch,
                residencySnapshotEpoch: snapshot,
            })
        })
    }

    function residentEntry(descriptor, publication, residentPage, state, frameEpoch) {

        const resolved = publication.snapshot.resolve(residentPage)
        assert(
            resolved.status === 'resident' && resolved.resolvedPage?.key === residentPage.key,
            `seed page ${residentPage.key} did not resolve exactly`
        )
        return Object.freeze({
            page: residentPage,
            compactIndex: descriptor.addressCodec.coverage.index(residentPage.tile),
            physicalSlot: resolved.physicalSlot,
            generation: resolved.generation,
            contentEpoch: resolved.contentEpoch,
            residencySnapshotEpoch: publication.snapshot.epoch,
            previousLodState: state,
            lastVisibleFrame: frameEpoch,
            lastDemandFrame: 0,
            childDemandMask: 0,
        })
    }

    function entryRecord(entry) {

        return {
            physicalSlot: entry.physicalSlot,
            expectedGeneration: entry.generation,
            expectedContentEpoch: entry.contentEpoch,
            samplingLevel: entry.page.level,
            matrixLevel: Number(entry.page.tile.matrixId),
            tileRow: entry.page.tile.tileRow,
            tileCol: entry.page.tile.tileCol,
            compactIndex: entry.compactIndex,
            previousLodState: lodState(entry.previousLodState),
            transitionState: entry.lastVisibleFrame,
            lastDemandEpoch: entry.lastDemandFrame,
            childDemandMask: entry.childDemandMask,
            residencySnapshotEpoch: entry.residencySnapshotEpoch,
        }
    }

    function normalizeReferenceEntry(entry) {

        return entryRecord(entry)
    }

    function normalizeReferenceVisible(entry) {

        return {
            physicalSlot: entry.physicalSlot,
            expectedGeneration: entry.generation,
            samplingLevel: entry.page.level,
            matrixLevel: Number(entry.page.tile.matrixId),
            tileRow: entry.page.tile.tileRow,
            tileCol: entry.page.tile.tileCol,
            compactIndex: entry.compactIndex,
            contentEpoch: entry.contentEpoch,
        }
    }

    function normalizeReferenceDemand(frontier, demand) {

        const tile = demand.page.tile
        return {
            samplingLevel: demand.page.level,
            matrixLevel: Number(tile.matrixId),
            tileRow: tile.tileRow,
            tileCol: tile.tileCol,
            compactIndex: frontier.descriptor.addressCodec.coverage.index(tile),
            parentCompactIndex: demand.parentCompactIndex,
            parentPhysicalSlot: demand.parentPhysicalSlot,
            parentGeneration: demand.parentGeneration,
            priority: demand.priority,
            decisionFrameEpoch: demand.decisionFrameEpoch,
            residencySnapshotEpoch: demand.residencySnapshotEpoch,
            childMask: demand.childMask,
        }
    }

    function expectedRetirements(current, oracle, residentPages) {

        const nextKeys = new Set(oracle.nextFrontier.map(entry => entry.page.key))
        const residents = new Map(residentPages.map(resident => [ resident.page.key, resident ]))
        return current.filter(entry => {
            if (nextKeys.has(entry.page.key)) return false
            const resident = residents.get(entry.page.key)
            return resident !== undefined &&
                resident.compactIndex === entry.compactIndex &&
                resident.physicalSlot === entry.physicalSlot &&
                resident.generation === entry.generation &&
                resident.contentEpoch === entry.contentEpoch &&
                resident.residencySnapshotEpoch === oracle.facts.residencySnapshotEpoch &&
                entry.residencySnapshotEpoch <= oracle.facts.residencySnapshotEpoch
        })
    }

    function diagnosticsFacts(diagnostics) {

        const convergenceStates = [ 'converged', 'transitioning', 'budget-limited' ]
        const facts = {
            frameEpoch: diagnostics.frameEpoch,
            residencySnapshotEpoch: diagnostics.residencySnapshotEpoch,
            activeFrontierCount: diagnostics.activeFrontierCount,
            visibleInstanceCount: diagnostics.visibleInstanceCount,
            refineCandidateCount: diagnostics.refineCandidateCount,
            coarsenCandidateCount: diagnostics.coarsenCandidateCount,
            demandCount: diagnostics.demandCount,
            fallbackCount: diagnostics.fallbackCount,
            staleGenerationCount: diagnostics.staleGenerationCount,
            budgetLimitedCount: diagnostics.budgetLimitedCount,
            maximumObservedSse: diagnostics.maximumObservedSse,
        }
        if (diagnostics.minimumSelectedMatrixLevel !== 0xffff_ffff) {
            facts.minimumSelectedMatrixLevel = diagnostics.minimumSelectedMatrixLevel
            facts.maximumSelectedMatrixLevel = diagnostics.maximumSelectedMatrixLevel
        }
        facts.frontierOverflow = diagnostics.frontierOverflow !== 0
        facts.demandOverflow = diagnostics.demandOverflow !== 0
        facts.visibleOverflow = diagnostics.visibleOverflow !== 0
        facts.convergenceState = convergenceStates[diagnostics.convergenceState]
        return facts
    }

    function assertFacts(actual, expected, frameEpoch) {

        const tolerance = Math.max(1e-4, Math.abs(expected.maximumObservedSse) * 1e-3)
        assert(
            Math.abs(actual.maximumObservedSse - expected.maximumObservedSse) <= tolerance,
            `GPU maximum SSE differs from oracle at frame ${frameEpoch}: ` +
                `${actual.maximumObservedSse} vs ${expected.maximumObservedSse}`
        )
        assertEqual(
            { ...actual, maximumObservedSse: 0 },
            { ...expected, maximumObservedSse: 0 },
            `GPU diagnostics facts differ from oracle at frame ${frameEpoch}`
        )
    }

    function assertCounters(counters, facts, retirementCount) {

        const minimumLevel = facts.minimumSelectedMatrixLevel ?? 0xffff_ffff
        const maximumLevel = facts.maximumSelectedMatrixLevel ?? 0
        assertEqual({
            currentCount: counters[0],
            nextCount: counters[1],
            visibleCount: counters[2],
            refineCount: counters[3],
            coarsenCount: counters[4],
            demandCount: counters[5],
            retirementCount: counters[6],
            staleCount: counters[7],
            budgetLimitedCount: counters[8],
            minimumLevel: counters[10],
            maximumLevel: counters[11],
            frontierOverflow: counters[12],
            demandOverflow: counters[13],
            visibleOverflow: counters[14],
            frameEpoch: counters[17],
            residencySnapshotEpoch: counters[18],
            fallbackCount: counters[19],
        }, {
            currentCount: facts.activeFrontierCount,
            nextCount: facts.activeFrontierCount,
            visibleCount: facts.visibleInstanceCount,
            refineCount: facts.refineCandidateCount,
            coarsenCount: facts.coarsenCandidateCount,
            demandCount: facts.demandCount,
            retirementCount,
            staleCount: facts.staleGenerationCount,
            budgetLimitedCount: facts.budgetLimitedCount,
            minimumLevel,
            maximumLevel,
            frontierOverflow: Number(facts.frontierOverflow),
            demandOverflow: Number(facts.demandOverflow),
            visibleOverflow: Number(facts.visibleOverflow),
            frameEpoch: facts.frameEpoch,
            residencySnapshotEpoch: facts.residencySnapshotEpoch,
            fallbackCount: facts.fallbackCount,
        }, 'GPU packed counters differ from oracle facts')
    }

    function feedbackSectionBytes(bytes, section) {

        return bytes.subarray(section.offset, section.offset + section.byteLength)
    }

    function concatenateBytes(parts) {

        const result = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0))
        let offset = 0
        for (const part of parts) {
            result.set(part, offset)
            offset += part.byteLength
        }
        return result
    }

    function rootPages(env) {

        const limit = env.coverage.limit(String(env.minimumMatrixLevel))
        const roots = []
        for (let row = limit.minTileRow; row <= limit.maxTileRow; row++) {
            for (let col = limit.minTileCol; col <= limit.maxTileCol; col++) {
                roots.push(page(env, env.minimumMatrixLevel, row, col))
            }
        }
        return roots
    }

    function children(env, parent) {

        const level = Number(parent.tile.matrixId) + 1
        return [
            page(env, level, parent.tile.tileRow * 2, parent.tile.tileCol * 2),
            page(env, level, parent.tile.tileRow * 2, parent.tile.tileCol * 2 + 1),
            page(env, level, parent.tile.tileRow * 2 + 1, parent.tile.tileCol * 2),
            page(env, level, parent.tile.tileRow * 2 + 1, parent.tile.tileCol * 2 + 1),
        ].filter(candidate => env.coverage.contains(candidate.tile))
    }

    function page(env, level, row, col) {

        return env.addressSpace.pageFromTile({
            matrixId: String(level),
            tileRow: row,
            tileCol: col,
        })
    }

    function allWorldView(frameEpoch, snapshotEpoch, cameraZ) {

        return orthographicView({
            frameEpoch,
            snapshotEpoch,
            camera: [ 0, 0, cameraZ ],
            xHalfExtent: HALF_WORLD,
            yHalfExtent: HALF_WORLD,
            zScale: 0.01,
            zTranslate: 0.5,
            zoomHint: 1,
        })
    }

    function orthographicView(options) {

        const [ cameraHigh, cameraLow ] = splitVector(options.camera)
        return {
            clipFromRelativeWorld: new Float32Array([
                1 / options.xHalfExtent, 0, 0, 0,
                0, 1 / options.yHalfExtent, 0, 0,
                0, 0, options.zScale, 0,
                0, 0, options.zTranslate, 1,
            ]),
            cameraHigh,
            cameraLow,
            viewport: [ 1024, 1024 ],
            verticalFovRadians: Math.PI / 2,
            cameraLatitudeRadians: 0,
            zoomHint: options.zoomHint,
            frameEpoch: options.frameEpoch,
            residencySnapshotEpoch: options.snapshotEpoch,
        }
    }

    function perspectiveView(options) {

        const cameraMatrix = mat4.lookAt(
            [ 0, 0, 0 ],
            options.direction,
            [ 0, 0, 1 ]
        )
        const viewMatrix = mat4.inverse(cameraMatrix)
        const projection = mat4.perspective(
            options.verticalFovRadians,
            1,
            options.near,
            options.far
        )
        const [ cameraHigh, cameraLow ] = splitVector(options.camera)
        return {
            clipFromRelativeWorld: mat4.multiply(projection, viewMatrix),
            cameraHigh,
            cameraLow,
            viewport: [ 1024, 1024 ],
            verticalFovRadians: options.verticalFovRadians,
            cameraLatitudeRadians: 0,
            zoomHint: options.zoomHint,
            frameEpoch: options.frameEpoch,
            residencySnapshotEpoch: options.snapshotEpoch,
        }
    }

    function splitVector(values) {

        const high = values.map(value => Math.fround(value))
        const low = values.map((value, index) => Math.fround(value - high[index]))
        return [ high, low ]
    }

    function fullLimit(level) {

        return {
            matrixId: String(level),
            minTileRow: 0,
            maxTileRow: 2 ** level - 1,
            minTileCol: 0,
            maxTileCol: 2 ** level - 1,
        }
    }

    function metric(matrixLevel, geometricErrorMeters) {

        return {
            matrixLevel,
            minimumElevationMeters: 0,
            maximumElevationMeters: 100,
            geometricErrorMeters,
        }
    }

    function storageBinding(binding, name, type, minBindingSize) {

        return {
            binding,
            name,
            type,
            visibility: [ 'compute' ],
            hasDynamicOffset: false,
            minBindingSize,
        }
    }

    function currentRead(resource) {

        return { resource, contentEpoch: 'current-at-step' }
    }

    function appendSeed(builder, seed) {

        for (const command of seed.commands) {
            if (command.commandKind === 'clear') builder.clear(command)
            else builder.upload(command)
        }
    }

    function disposeScenario(frontier, capture, env) {

        capture.dispose()
        frontier.dispose()
        const disposal = {
            frontierDisposed: frontier.facts().disposed,
            borrowedSlotTableAlive: !env.gpuState.slotTable.isDisposed,
        }
        env.gpuState.dispose()
        env.residency.dispose()
        return disposal
    }

    function summarizeFrame(frameResult) {

        return {
            keys: frameResult.keys,
            compactIndexes: frameResult.frontier.map(entry => entry.compactIndex),
            visibleCount: frameResult.visible.length,
            demandCount: frameResult.demands.length,
            retirementCount: frameResult.retirements.length,
            facts: frameResult.facts,
            nextDispatchWords: frameResult.nextDispatchWords,
            hash: frameResult.hash,
        }
    }

    function lodState(value) {

        return value === 'refine' ? 1 : value === 'coarsen' ? 2 : 0
    }

    function byteHash(bytes) {

        let hash = 0x811c9dc5
        for (const value of bytes) {
            hash ^= value
            hash = Math.imul(hash, 0x01000193) >>> 0
        }
        return hash.toString(16).padStart(8, '0')
    }

    function assert(condition, message) {

        if (!condition) throw new Error(message)
    }

    function assertEqual(actual, expected, message) {

        const actualJson = JSON.stringify(actual)
        const expectedJson = JSON.stringify(expected)
        if (actualJson !== expectedJson) {
            throw new Error(`${message}: expected ${expectedJson}, received ${actualJson}`)
        }
    }

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
    if (!value.processFacts.browserClosed || !value.processFacts.browserProcessClosed ||
        !value.processFacts.viteClosed) {
        failures.push('managed Chrome or Vite remained reachable')
    }
    if (value.proof === undefined) {
        failures.push('GPU tile frontier browser proof was not produced')
        return failures
    }
    const proof = value.proof
    if (proof.failure !== undefined) {
        failures.push(`frontier semantic proof failed: ${JSON.stringify(proof.failure)}`)
    }
    if (proof.validationError !== undefined || proof.uncapturedErrors?.length !== 0) {
        failures.push('WebGPU validation or uncaptured errors were emitted')
    }
    if (proof.resourceCount !== 16 || proof.templateCount !== 2 ||
        JSON.stringify(proof.labels) !== JSON.stringify(proof.commandLabels) ||
        JSON.stringify(proof.kinds) !== JSON.stringify(proof.expectedKinds)) {
        failures.push('persistent resource or 12-command graph facts drifted')
    }
    if (JSON.stringify(proof.parity) !== JSON.stringify([
        { source: 'A', target: 'B' },
        { source: 'B', target: 'A' },
    ]) || proof.drawArgument?.offset !== 0 || proof.drawArgument?.size !== 16 ||
        (proof.drawArgument?.usage & 0x180) !== 0x180) {
        failures.push('parity or indirect draw resource facts drifted')
    }
    if (proof.outcomes?.length !== 17 ||
        proof.outcomes.some(status => status !== 'observed-succeeded')) {
        failures.push('one or more semantic submissions did not complete successfully')
    }
    if (!proof.scenarios?.canonicalTie?.byteIdentical ||
        proof.scenarios.canonicalTie.deterministicHash !==
            proof.scenarios.canonicalTie.repeatedHash ||
        proof.scenarios.sequenceAuthority === undefined ||
        proof.scenarios.sequenceAuthority?.submitted?.frameEpoch !== 1 ||
        proof.scenarios.sequenceAuthority?.submitted?.source !== 'A' ||
        proof.scenarios.sequenceAuthority?.next?.source !== 'B' ||
        proof.scenarios.staleContent?.activeCount !== 0 ||
        proof.scenarios.staleGeneration?.activeCount !== 0 ||
        proof.scenarios.staleGeneration?.facts?.staleGenerationCount !== 1 ||
        proof.scenarios.demand?.demandCount !== 4 ||
        proof.scenarios.demand?.packedByteLength !== 192 ||
        proof.scenarios.feedbackRing?.frameEpoch !== 0 ||
        proof.scenarios.feedbackRing?.demandCount !== 4 ||
        proof.scenarios.feedbackRing?.rawBytesExposed !== false ||
        proof.scenarios.feedbackRing?.tooRecentCode !== 'GEO_GPU_TILE_FEEDBACK_TOO_RECENT' ||
        proof.scenarios.feedbackRing?.ringFacts?.slotCount !== 3 ||
        proof.scenarios.feedbackRing?.ringFacts?.issuedCount !== 2 ||
        proof.scenarios.eastEdgePrecision?.retainedKeys?.length !== 1 ||
        proof.scenarios.eastEdgeCounterexample?.refinedKeys?.length !== 4 ||
        !(proof.scenarios.eastEdgeCounterexample?.maximumObservedSse > 300) ||
        proof.scenarios.balancePressure?.facts?.fallbackCount !== 1 ||
        proof.scenarios.balancePressure?.facts?.budgetLimitedCount !== 2 ||
        proof.scenarios.precision?.visibleCount !== 2 ||
        proof.scenarios.visibilityGrace?.parentLastVisibleFrame !== 1 ||
        proof.scenarios.offAxis?.outsideVisible !== false ||
        !(proof.scenarios.offAxis?.facts?.refineCandidateCount >= 1) ||
        !(proof.scenarios.offAxis?.facts?.coarsenCandidateCount >= 1)) {
        failures.push('decoded GPU semantic evidence is incomplete')
    }
    if (!proof.disposal?.frontierDisposed || !proof.disposal?.feedbackRingDisposed ||
        !proof.disposal?.borrowedSlotTableAlive ||
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
        if (response.status() >= 400) {
            pushBounded(events.httpFailures, `${response.status()} ${response.url()}`)
        }
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

async function closeBrowser(activeBrowser, server) {

    if (activeBrowser === undefined && server === undefined) return
    try {
        if (activeBrowser !== undefined && activeBrowser.isConnected()) {
            await withTimeout(activeBrowser.close(), 15_000, 'Chrome shutdown')
        }
        const child = server?.process()
        if (server !== undefined && child !== undefined &&
            child.exitCode === null && child.signalCode === null) {
            await withTimeout(server.close(), 5_000, 'Chrome server shutdown')
        }
    } catch (closeError) {
        try {
            if (server !== undefined) {
                await withTimeout(server.kill(), 5_000, 'Chrome forced termination')
            }
        } catch (killError) {
            throw new Error(
                `${serializeError(closeError)}; forced termination failed: ${serializeError(killError)}`
            )
        }
        throw closeError
    }
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

    return new Promise((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => {
            rejectPromise(new Error(`${label} timed out`))
        }, milliseconds)
        Promise.resolve(promise).then(
            value => {
                clearTimeout(timer)
                resolvePromise(value)
            },
            error => {
                clearTimeout(timer)
                rejectPromise(error)
            }
        )
    })
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
