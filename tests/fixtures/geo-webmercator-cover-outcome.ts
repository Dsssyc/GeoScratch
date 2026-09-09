import { GPURuntime, type BufferResource } from 'geoscratch/scratch'
import {
    GeoDiagnosticError,
    GpuWebMercatorQuadCover,
    GpuWebMercatorQuadDemandProjection,
    GpuWebMercatorQuadPatchDraw,
    WebMercatorQuad,
    createGeoViewSnapshot,
    decodeGpuWebMercatorQuadDemandProjectionFeedback,
    gpuWebMercatorQuadCoverPolicy,
    tileMatrixCoverage,
    webMercatorPlanarTileSpatialProfile,
    webMercatorQuadAddressCodec,
} from 'geoscratch/geo'
import { gpuWebMercatorQuadCoverStateCodec } from
    '../../packages/geoscratch/src/geo/gpu-web-mercator-quad-cover-layout.js'

const BUFFER_COPY_SRC = 0x04
const BUFFER_COPY_DST = 0x08
const BUFFER_STORAGE = 0x80

const cases = [
    { name: 'normal', instances: 2, demands: 2, overflow: 0 },
    { name: 'normal-other-parity', instances: 2, demands: 2, overflow: 0 },
    { name: 'empty', instances: 0, demands: 0, overflow: 0 },
    { name: 'descriptor-overflow', instances: 0, demands: 0, overflow: 1 },
    { name: 'lookup-overflow', instances: 0, demands: 0, overflow: 1 },
    { name: 'adjacency-invalid', instances: 0, demands: 0, overflow: 1 },
    // The draw adapter borrows state only; epoch validation belongs to projection.
    { name: 'frame-mismatch', instances: 2, demands: 0, overflow: 1 },
    { name: 'normal-after-failure', instances: 2, demands: 2, overflow: 0 },
] as const

export async function runCoverOutcomeProof() {

    const runtime = await GPURuntime.create({ label: 'Cover outcome native proof' })
    const uncaptured: string[] = []
    runtime.device.addEventListener('uncapturederror', event => {
        uncaptured.push(event.error.message)
    })
    const rows: unknown[] = []
    const populatedParities = new Set<number>()
    const suppressedParities = new Set<number>()
    let cover: GpuWebMercatorQuadCover | undefined
    let projection: GpuWebMercatorQuadDemandProjection | undefined
    let patchDraw: GpuWebMercatorQuadPatchDraw | undefined
    try {
        const coverage = tileMatrixCoverage({
            tileMatrixSet: WebMercatorQuad,
            limits: [ 0, 1 ].map(level => ({
                matrixId: String(level), minTileRow: 0, maxTileRow: 2 ** level - 1,
                minTileCol: 0, maxTileCol: 2 ** level - 1,
            })),
        })
        cover = await GpuWebMercatorQuadCover.create(runtime, {
            spatialProfile: webMercatorPlanarTileSpatialProfile({
                addressCodec: webMercatorQuadAddressCodec({ coverage }),
            }),
            policy: gpuWebMercatorQuadCoverPolicy({
                minimumMatrixLevel: 0, maximumMatrixLevel: 1, maximumPatches: 8,
                cellsPerPatchEdge: 128, maximumCellSpanReferencePixels: 5,
                refinementTolerance: 0.005,
            }),
            verticalRangeMeters: [ 0, 0 ],
        })
        projection = await GpuWebMercatorQuadDemandProjection.create(runtime, {
            cover, sourceCoverage: coverage, maximumDemands: 8,
        })
        patchDraw = await GpuWebMercatorQuadPatchDraw.create(runtime, {
            cover, elementCount: 6,
        })
        const observers = await Promise.all(patchDraw.templates().map(template =>
            createDrawObserver(runtime, template.drawArgument.resource)))
        const initialization = runtime.submission()
        cover.initialize(initialization)
        projection.initialize(initialization)
        patchDraw.initialize(initialization)
        for (const observer of observers) initialization.clear(observer.clear)
        const initialized = initialization.submit()
        await initialized.done
        requireSuccess(await initialized.nativeOutcome, 'initialization')

        for (const [ index, scenario ] of cases.entries()) {
            // Seed both parities before failure cases to expose stale successful counts.
            const frameEpoch = 11 + index * 2
            const token = cover.writeView(createGeoViewSnapshot({
                id: `outcome-${scenario.name}`,
                clipFromRelativeWorld: new Float64Array([
                    1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
                ]),
                cameraHigh: [ 0, 0, 1000 ], cameraLow: [ 0, 0, 0 ],
                referenceViewport: [ 64, 64 ], verticalFovRadians: Math.PI / 3,
                cameraLatitudeRadians: 0, cameraPitchRadians: 0, zoomHint: 1,
                frameEpoch, residencySnapshotEpoch: 1,
            }))
            const coverFrame = cover.frame(token)
            const demandFrame = projection.frame(coverFrame)
            const drawFrame = patchDraw.frame(coverFrame)
            const observer = observers[coverFrame.parity]!
            const template = cover.templates()[coverFrame.parity]
            const empty = scenario.name === 'empty'
            const stateUpload = runtime.createUploadCommand({
                label: `Inject ${scenario.name} cover state`,
                target: template.state.region({ layout: gpuWebMercatorQuadCoverStateCodec.artifact }),
                data: gpuWebMercatorQuadCoverStateCodec.pack({
                    frameEpoch: frameEpoch - (scenario.name === 'frame-mismatch' ? 1 : 0),
                    candidateCount: 4, patchCount: empty ? 0 : 2,
                    descriptorOverflowCount: scenario.name === 'descriptor-overflow' ? 1 : 0,
                    lookupOverflowCount: scenario.name === 'lookup-overflow' ? 1 : 0,
                    minimumMatrixLevel: empty ? 0xffff_ffff : 1,
                    maximumMatrixLevel: empty ? 0 : 1,
                    maximumAdjacentLevelDelta: scenario.name === 'adjacency-invalid' ? 2 : 0,
                    finestMatrixLevel: 1,
                    minimumCellSpanQ8: empty ? 0xffff_ffff : 256,
                    maximumCellSpanQ8: empty ? 0 : 256,
                }),
            })
            const patchUpload = runtime.createUploadCommand({
                label: 'Inject two standard sibling patches',
                target: template.patches.region({ offset: 0, size: 24 }),
                data: new Uint32Array([ 1, 0, 0, 1, 0, 1 ]),
            })
            try {
                const builder = runtime.submission()
                cover.encode(builder, coverFrame)
                builder.upload(patchUpload).upload(stateUpload)
                projection.encode(builder, demandFrame)
                patchDraw.encode(builder, drawFrame)
                builder.compute(observer.pass, [ observer.command ]).readback(observer.readback)
                projection.capture(builder, demandFrame)
                cover.capture(builder, coverFrame)
                const submitted = builder.submit()
                const commands = projection.commandsFor(demandFrame)
                const [ argumentBytes, stateBytes, demandBytes ] = await Promise.all([
                    observer.readback.result({ after: submitted }).toBytes(),
                    commands.stateFeedback.result({ after: submitted }).toBytes(),
                    commands.demandFeedback.result({ after: submitted }).toBytes(),
                ])
                const arguments_ = Array.from(new Uint32Array(argumentBytes.buffer,
                    argumentBytes.byteOffset, 5))
                const projectionState = Array.from(new Uint32Array(stateBytes.buffer,
                    stateBytes.byteOffset, 4))
                let projectionRejected = false
                try {
                    decodeGpuWebMercatorQuadDemandProjectionFeedback(stateBytes, demandBytes, {
                        expectedFrameEpoch: frameEpoch, maximumDemands: 8, sourceLevelCeiling: 1,
                    })
                } catch (error) {
                    if (!(error instanceof GeoDiagnosticError)) throw error
                    projectionRejected = true
                }
                let coverRejected = false
                try {
                    const feedback = await cover.feedback(coverFrame, submitted)
                    if (empty && ('minimumMatrixLevel' in feedback ||
                        'minimumCellSpanReferencePixels' in feedback)) {
                        throw new Error('Empty cover exposed untouched range sentinels')
                    }
                } catch (error) {
                    if (!(error instanceof GeoDiagnosticError)) throw error
                    coverRejected = true
                }
                await submitted.done
                const nativeOutcome = await submitted.nativeOutcome
                requireSuccess(nativeOutcome, scenario.name)
                if (JSON.stringify(arguments_) !== JSON.stringify([ 6, scenario.instances, 0, 0, 0 ]) ||
                    projectionState[0] !== frameEpoch || projectionState[1] !== scenario.demands ||
                    projectionState[2] !== scenario.overflow || projectionState[3] !== 1 ||
                    projectionRejected !== (scenario.overflow !== 0) ||
                    coverRejected !== (scenario.overflow !== 0)) {
                    throw new Error(`Unexpected ${scenario.name} outcome: ${JSON.stringify({
                        arguments_, projectionState, projectionRejected, coverRejected,
                    })}`)
                }
                if (empty && !populatedParities.has(coverFrame.parity)) {
                    throw new Error('Empty case did not replace a populated parity')
                }
                if (scenario.name === 'normal-after-failure' && !suppressedParities.has(coverFrame.parity)) {
                    throw new Error('Recovery case did not reuse a suppressed parity')
                }
                if (scenario.instances === 2) populatedParities.add(coverFrame.parity)
                if (scenario.instances === 0 && scenario.overflow === 1) {
                    suppressedParities.add(coverFrame.parity)
                }
                rows.push({ name: scenario.name, parity: coverFrame.parity, arguments: arguments_, projectionState,
                    projectionRejected, coverRejected, nativeStatus: nativeOutcome.status })
            } finally {
                stateUpload.dispose()
                patchUpload.dispose()
                token.dispose()
            }
        }
    } finally {
        projection?.dispose()
        patchDraw?.dispose()
        cover?.dispose()
        runtime.dispose()
    }
    const diagnostics = runtime.diagnostics.snapshot()
    if (uncaptured.length > 0 || diagnostics.resources.length > 0 ||
        diagnostics.readbacks.length > 0 || diagnostics.readbackCommands.length > 0 ||
        diagnostics.pendingOperations.length > 0 || diagnostics.readbackMemory.currentStagingBytes !== 0 ||
        diagnostics.readbackMemory.activeMappings !== 0) {
        throw new Error(`Outcome proof left native errors or resource owners: ${JSON.stringify({
            uncaptured, diagnostics,
        })}`)
    }
    return { adapter: runtime.adapterInfo, rows, uncaptured,
        cleanup: { runtimeDisposed: runtime.isDisposed, resources: diagnostics.resources.length,
            readbacks: diagnostics.readbacks.length, readbackCommands: diagnostics.readbackCommands.length,
            pendingOperations: diagnostics.pendingOperations.length,
            stagingBytes: diagnostics.readbackMemory.currentStagingBytes,
            activeMappings: diagnostics.readbackMemory.activeMappings } }
}

async function createDrawObserver(runtime: GPURuntime, arguments_: BufferResource) {

    // Production indirect buffers deliberately lack COPY_SRC; observe via a separate GPU consumer.
    const output = await runtime.createBuffer({
        label: 'Cover outcome observed indirect words', size: 20,
        usage: BUFFER_STORAGE | BUFFER_COPY_SRC | BUFFER_COPY_DST,
    })
    const clear = runtime.createClearBufferCommand({ target: output.region() })
    const shader = await runtime.createShaderModule({ sourceParts: [ { code: `
        @group(0) @binding(0) var<storage, read> inputWords: array<u32>;
        @group(0) @binding(1) var<storage, read_write> outputWords: array<u32>;
        @compute @workgroup_size(1) fn observe() {
            for (var index = 0u; index < 5u; index += 1u) { outputWords[index] = inputWords[index]; }
        }
    ` } ] })
    const layout = await runtime.createBindLayout({ group: 0, entries: [
        { binding: 0, name: 'inputWords', type: 'read-storage', visibility: [ 'compute' ], minBindingSize: 20 },
        { binding: 1, name: 'outputWords', type: 'storage', visibility: [ 'compute' ], minBindingSize: 20 },
    ] })
    const bindings = await runtime.createBindSet(layout, {
        inputWords: arguments_.region(), outputWords: output.region(),
    })
    const program = runtime.createProgram({ compute: { module: shader, entryPoint: 'observe' } })
    const pipeline = await runtime.createComputePipeline({
        program, layout: { mode: 'explicit', bindLayouts: [ layout ] },
    })
    const command = runtime.createDispatchCommand({
        pipeline, bindSets: [ { set: bindings } ], count: { workgroups: [ 1, 1, 1 ] },
        resources: { read: [ arguments_, output ].map(resource => ({
            resource, contentEpoch: 'current-at-step' as const,
        })), write: [ output ] }, whenMissing: 'throw',
    })
    const pass = runtime.createComputePass({ label: 'Observe cover draw arguments' })
    const readback = await runtime.createReadbackCommand({
        source: { region: output.region(), contentEpoch: 'current-at-step' }, whenMissing: 'throw',
    })
    return { clear, pass, command, readback }
}

function requireSuccess(outcome: { status: string }, context: string): void {

    if (outcome.status !== 'observed-succeeded') {
        throw new Error(`${context} native submission failed: ${JSON.stringify(outcome)}`)
    }
}
