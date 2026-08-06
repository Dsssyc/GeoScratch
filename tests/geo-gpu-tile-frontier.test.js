import { expect } from 'chai'
import { GPURuntime, ScratchDiagnosticError } from 'geoscratch/scratch'
import {
    GeoDiagnosticError,
    GpuTileFrontier,
    VirtualRasterSnapshot,
    VirtualRasterResidency,
    WebMercatorQuad,
    createVirtualRasterGpuState,
    gpuTileFrontierPolicy,
    ownedVirtualRasterPagePayload,
    tileMatrixCoverage,
    virtualRasterPlane,
    virtualRasterTileAddressSpace,
    webMercatorQuadAddressCodec,
} from 'geoscratch/geo'
import {
    evaluateGpuTileFrontierReference,
} from '../packages/geoscratch/dist/geo/gpu-tile-frontier-reference.js'
import {
    gpuTileFrontierMapMetaCodec,
    gpuTileFrontierLayouts,
} from '../packages/geoscratch/dist/geo/gpu-tile-frontier-layout.js'
import {
    physicalPagesForSnapshot,
} from '../packages/geoscratch/dist/geo/virtual-raster.js'
import {
    createGpuTileFrontierWgsl,
    gpuTileFrontierEntryPoints,
} from '../packages/geoscratch/dist/geo/gpu-tile-frontier-wgsl.js'
import {
    gpuTileFrontierTestFrameAccess,
} from '../packages/geoscratch/dist/geo/gpu-tile-frontier.js'
import {
    createFakeGpu,
    createTestProgram,
    triangleWgsl,
} from './scratch-test-utils.js'

const HALF_WORLD = 20_037_508.3427892
const SNAPSHOT_EPOCH = 7
const U32_LIMIT = 0x1_0000_0000
const GPU_BUFFER_USAGE_STORAGE = 0x80
const GPU_BUFFER_USAGE_INDIRECT = 0x100
const GPU_BUFFER_USAGE_COPY_SRC = 0x04
const GPU_BUFFER_USAGE_COPY_DST = 0x08

const FRONTIER_COMMAND_LABELS = [
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

const FRONTIER_COMMAND_COUNTS = [
    'direct',
    'direct',
    'indirect',
    'indirect',
    'direct',
    'indirect',
    'indirect',
    'direct',
    'direct',
    'direct',
    'indirect',
    'direct',
]

function createFixture(options = {}) {

    const minimumMatrixLevel = options.minimumMatrixLevel ?? 0
    const maximumMatrixLevel = options.maximumMatrixLevel ?? 3
    const coverageLevels = options.coverageMatrixLevels ?? Array.from(
        { length: maximumMatrixLevel - minimumMatrixLevel + 1 },
        (_, index) => minimumMatrixLevel + index
    )
    const coverage = tileMatrixCoverage({
        tileMatrixSet: WebMercatorQuad,
        limits: coverageLevels.map(matrixLevel => options.coverageLimits?.[matrixLevel] ?? ({
            matrixId: String(matrixLevel),
            minTileRow: 0,
            maxTileRow: 2 ** matrixLevel - 1,
            minTileCol: 0,
            maxTileCol: 2 ** matrixLevel - 1,
        })),
    })
    const addressSpace = virtualRasterTileAddressSpace({
        id: 'frontier-fixture',
        coverage,
    })
    const addressCodec = webMercatorQuadAddressCodec({ coverage })
    const policy = gpuTileFrontierPolicy({
        refineErrorPixels: 2,
        coarsenErrorPixels: 1,
        minimumMatrixLevel,
        maximumMatrixLevel,
        maximumActiveTiles: options.maximumActiveTiles ?? 16,
        maximumDemands: options.maximumDemands ?? 16,
        transitionReservePages: options.transitionReservePages ?? 16,
        invisibleGraceFrames: options.invisibleGraceFrames ?? 2,
    })
    const errorByLevel = options.errorByLevel ?? [ 100, 100, 100, 100 ]
    const levelMetrics = Array.from(
        { length: maximumMatrixLevel - minimumMatrixLevel + 1 },
        (_, index) => minimumMatrixLevel + index
    ).map(matrixLevel => ({
        matrixLevel,
        minimumElevationMeters: 0,
        maximumElevationMeters: 100,
        geometricErrorMeters: errorByLevel[matrixLevel] ?? 100,
    }))
    const minimumLimit = coverage.limit(String(minimumMatrixLevel))
    const roots = []
    for (let row = minimumLimit.minTileRow; row <= minimumLimit.maxTileRow; row++) {
        for (let col = minimumLimit.minTileCol; col <= minimumLimit.maxTileCol; col++) {
            roots.push(addressSpace.pageFromTile({
                matrixId: String(minimumMatrixLevel),
                tileRow: row,
                tileCol: col,
            }))
        }
    }
    const descriptor = {
        gpuState: { addressSpace, maxPhysicalPages: 128 },
        addressCodec,
        policy,
        levelMetrics,
        roots,
        drawTemplates: [ { id: 'terrain', vertexCount: 6 } ],
    }
    const view = {
        clipFromRelativeWorld: [
            1 / HALF_WORLD, 0, 0, 0,
            0, 1 / HALF_WORLD, 0, 0,
            0, 0, 1 / 1_000_000, 0,
            0, 0, 1, 1,
        ],
        cameraHigh: [ 0, 0, 1_000_000 ],
        cameraLow: [ 0, 0, 0 ],
        viewport: [ 1024, 1024 ],
        verticalFovRadians: Math.PI / 2,
        cameraLatitudeRadians: 0,
        zoomHint: 2,
        frameEpoch: 10,
        residencySnapshotEpoch: SNAPSHOT_EPOCH,
    }

    function page(matrixLevel, tileRow, tileCol) {

        return addressSpace.pageFromTile({
            matrixId: String(matrixLevel),
            tileRow,
            tileCol,
        })
    }

    function entry(matrixLevel, tileRow, tileCol, extra = {}) {

        const identity = page(matrixLevel, tileRow, tileCol)
        return {
            page: identity,
            compactIndex: coverage.index(identity.tile),
            physicalSlot: coverage.index(identity.tile),
            generation: 1,
            contentEpoch: 1,
            residencySnapshotEpoch: SNAPSHOT_EPOCH,
            previousLodState: 'retain',
            lastVisibleFrame: 9,
            lastDemandFrame: 0,
            childDemandMask: 0,
            ...extra,
        }
    }

    function resident(matrixLevel, tileRow, tileCol, extra = {}) {

        const frontierEntry = entry(matrixLevel, tileRow, tileCol, extra)
        return {
            page: frontierEntry.page,
            compactIndex: frontierEntry.compactIndex,
            physicalSlot: frontierEntry.physicalSlot,
            generation: frontierEntry.generation,
            contentEpoch: frontierEntry.contentEpoch,
            residencySnapshotEpoch: frontierEntry.residencySnapshotEpoch,
        }
    }

    function evaluate(currentFrontier, residentPages, viewOverride = {}) {

        return evaluateGpuTileFrontierReference({
            descriptor,
            view: { ...view, ...viewOverride },
            currentFrontier,
            residentPages,
        })
    }

    return { coverage, descriptor, view, page, entry, resident, evaluate }
}

function keys(entries) {

    return entries.map(entry => entry.page.key)
}

function expectFrontierInvalid(action) {

    try {
        action()
        expect.fail('invalid GPU tile frontier input should throw')
    } catch (error) {
        expect(error).to.be.instanceOf(GeoDiagnosticError)
        expect(error.diagnostic).to.deep.include({
            code: 'GEO_GPU_TILE_FRONTIER_INVALID',
            phase: 'selection',
        })
    }
}

async function createGpuResourceGraphFixture(options = {}) {

    const logical = createFixture({
        maximumMatrixLevel: options.maximumMatrixLevel ?? 0,
        coverageMatrixLevels: options.coverageMatrixLevels,
    })
    const fake = createFakeGpu()
    if (options.maxStorageBufferBindingSize !== undefined) {
        fake.device.limits.maxStorageBufferBindingSize = options.maxStorageBufferBindingSize
    }
    const runtime = await GPURuntime.create({ gpu: fake.gpu })
    const addressSpace = logical.descriptor.gpuState.addressSpace
    const plane = virtualRasterPlane({
        id: 'frontier-height',
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
        maxPhysicalPages: 32,
        maxStagingBytes: width * height,
    })
    const root = logical.descriptor.roots[0]
    residency.stage(ownedVirtualRasterPagePayload({
        page: root,
        width,
        height,
        channels: 1,
        data: new Uint8Array(width * height),
        contentVersion: 'frontier-root-v1',
    }), { generation: 3 })
    const publication = residency.publish()
    const gpuState = await createVirtualRasterGpuState(runtime, {
        addressSpace,
        plane,
        maxPhysicalPages: 32,
    })
    const update = gpuState.stage(publication)
    const builder = runtime.createSubmission({ validation: 'throw' })
    for (const command of update.commands) builder.upload(command)
    const submitted = builder.submit()
    await gpuState.acknowledge(publication, submitted)

    return {
        ...fake,
        runtime,
        residency,
        publication,
        gpuState,
        view: {
            ...logical.view,
            frameEpoch: 0,
            residencySnapshotEpoch: publication.snapshot.epoch,
        },
        descriptor: {
            ...logical.descriptor,
            gpuState,
        },
    }
}

async function acknowledgePage(fixture, page, contentVersion, generation = 1) {

    const [ width, height ] = fixture.gpuState.addressSpace.pageSize
    fixture.residency.stage(ownedVirtualRasterPagePayload({
        page,
        width,
        height,
        channels: 1,
        data: new Uint8Array(width * height),
        contentVersion,
    }), { generation })
    const publication = fixture.residency.publish()
    const update = fixture.gpuState.stage(publication)
    const builder = fixture.runtime.createSubmission({ validation: 'throw' })
    for (const command of update.commands) builder.upload(command)
    await fixture.gpuState.acknowledge(publication, builder.submit())
    return publication
}

function appendSeed(builder, seed) {

    for (const command of seed.commands) {
        if (command.commandKind === 'clear') builder.clear(command)
        else builder.upload(command)
    }
    return builder
}

async function createDrawConsumer(fixture, frontier, frame) {

    const program = await createTestProgram(fixture.runtime, {
        sourceParts: [ triangleWgsl ],
        vertex: 'vsMain',
        fragment: 'fsMain',
    })
    const pipeline = await fixture.runtime.createRenderPipeline({
        program,
        targets: [ { format: 'rgba8unorm' } ],
    })
    const target = await fixture.runtime.createTexture({
        label: 'frontier provenance target',
        size: { width: 4, height: 4 },
        format: 'rgba8unorm',
        usage: 0x10,
    })
    const pass = fixture.runtime.createRenderPass({
        label: 'frontier provenance draw pass',
        color: [ {
            target: target.view(),
            load: 'clear',
            store: 'store',
            clear: [ 0, 0, 0, 1 ],
        } ],
    })
    const argument = frontier.drawArgument(frame, 'terrain')
    const draw = fixture.runtime.createDrawCommand({
        label: 'Draw GPU tile frontier terrain',
        pipeline,
        count: { indirect: argument.region },
        resources: {
            read: [
                { resource: argument.resource, contentEpoch: 'current-at-step' },
                { resource: frame.visibleInstances, contentEpoch: 'current-at-step' },
            ],
            write: [],
        },
        whenMissing: 'throw',
    })
    return { program, pipeline, target, pass, argument, draw }
}

async function expectGpuFrontierDiagnostic(action, expectedCode) {

    let failure
    try {
        await action()
    } catch (error) {
        failure = error
    }
    expect(failure).to.be.instanceOf(GeoDiagnosticError)
    expect(failure.diagnostic).to.include({ code: expectedCode, phase: 'selection' })
    return failure.diagnostic
}

describe('Geo GPU tile frontier contracts and reference oracle', () => {

    it('locks the validated descriptor against own and prototype shadowing', async() => {

        const fixture = await createGpuResourceGraphFixture()
        const frontier = await GpuTileFrontier.create(fixture.runtime, fixture.descriptor)
        const descriptor = frontier.descriptor

        expect(Object.isExtensible(frontier)).to.equal(false)
        expect(Object.isFrozen(Object.getPrototypeOf(frontier))).to.equal(true)
        expect(() => { frontier.descriptor = { ...descriptor, roots: [] } }).to.throw(TypeError)
        expect(() => Object.defineProperty(frontier, 'descriptor', {
            value: { ...descriptor, roots: [] },
        })).to.throw(TypeError)
        expect(() => Object.defineProperty(Object.getPrototypeOf(frontier), 'descriptor', {
            get: () => ({ ...descriptor, roots: [] }),
        })).to.throw(TypeError)
        expect(frontier.descriptor).to.equal(descriptor)

        frontier.dispose()
        fixture.gpuState.dispose()
        fixture.residency.dispose()
        fixture.runtime.dispose()
    })

    it('encodes private view and compute work while exposing only render composition capabilities', async() => {

        const fixture = await createGpuResourceGraphFixture()
        const frontier = await GpuTileFrontier.create(fixture.runtime, fixture.descriptor)
        const seed = frontier.stageSeed(fixture.publication.snapshot)
        const view = frontier.writeView(fixture.view)
        const frame = frontier.frame(view)

        for (const property of [ 'resource', 'command', 'data' ]) {
            expect(view).not.to.have.property(property)
        }
        for (const property of [
            'pass',
            'commands',
            'currentFrontier',
            'nextFrontier',
            'currentDispatchArguments',
            'nextDispatchArguments',
            'drawArguments',
            'viewUpload',
        ]) {
            expect(frame).not.to.have.property(property)
        }
        expect(frame.visibleInstances).to.exist
        expect(frontier.drawArgument(frame, 'terrain').region).to.exist

        const builder = appendSeed(
            fixture.runtime.createSubmission({ validation: 'throw' }),
            seed
        )
        const firstEncodedStep = builder.steps.length
        expect(frontier.encode(builder, frame)).to.equal(builder)
        expect(builder.steps.slice(firstEncodedStep).map(step => step.kind))
            .to.deep.equal([ 'upload', 'compute' ])
        expect(builder.steps.at(-1).commands.map(command => command.label))
            .to.deep.equal(FRONTIER_COMMAND_LABELS)
        const submitted = builder.submit()
        expect(await submitted.nativeOutcome).to.deep.include({ status: 'observed-succeeded' })

        view.dispose()
        frontier.dispose()
        fixture.gpuState.dispose()
        fixture.residency.dispose()
        fixture.runtime.dispose()
    })

    it('fails a prebuilt frame at submit after view authority advances', async() => {

        const fixture = await createGpuResourceGraphFixture()
        const frontier = await GpuTileFrontier.create(fixture.runtime, fixture.descriptor)
        const seed = frontier.stageSeed(fixture.publication.snapshot)
        const view = frontier.writeView(fixture.view)
        const frame = frontier.frame(view)
        const builder = appendSeed(
            fixture.runtime.createSubmission({ validation: 'throw' }),
            seed
        )
        frontier.encode(builder, frame)
        const replacement = frontier.writeView({ ...fixture.view, frameEpoch: 1 })
        const encoderCount = fixture.calls.commandEncoders.length
        const queueWriteCount = fixture.calls.queueWrites.length

        expect(() => builder.submit()).to.throw(ScratchDiagnosticError)
            .with.nested.property('diagnostic.code', 'SCRATCH_SUBMISSION_AUTHORITY_STALE')
        expect(fixture.calls.commandEncoders).to.have.length(encoderCount)
        expect(fixture.calls.queueWrites).to.have.length(queueWriteCount)

        view.dispose()
        replacement.dispose()
        frontier.dispose()
        fixture.gpuState.dispose()
        fixture.residency.dispose()
        fixture.runtime.dispose()
    })

    it('fails a prebuilt frame at submit after residency authority advances', async() => {

        const fixture = await createGpuResourceGraphFixture({ maximumMatrixLevel: 1 })
        const frontier = await GpuTileFrontier.create(fixture.runtime, fixture.descriptor)
        const seed = frontier.stageSeed(fixture.publication.snapshot)
        const view = frontier.writeView(fixture.view)
        const frame = frontier.frame(view)
        const builder = appendSeed(
            fixture.runtime.createSubmission({ validation: 'throw' }),
            seed
        )
        frontier.encode(builder, frame)
        const child = fixture.gpuState.addressSpace.pageFromTile({
            matrixId: '1',
            tileRow: 0,
            tileCol: 0,
        })
        await acknowledgePage(fixture, child, 'frontier-submit-authority-child')
        const encoderCount = fixture.calls.commandEncoders.length
        const queueWriteCount = fixture.calls.queueWrites.length

        expect(() => builder.submit()).to.throw(ScratchDiagnosticError)
            .with.nested.property('diagnostic.code', 'SCRATCH_SUBMISSION_AUTHORITY_STALE')
        expect(fixture.calls.commandEncoders).to.have.length(encoderCount)
        expect(fixture.calls.queueWrites).to.have.length(queueWriteCount)

        view.dispose()
        frontier.dispose()
        fixture.gpuState.dispose()
        fixture.residency.dispose()
        fixture.runtime.dispose()
    })

    it('carries expected content epoch in the LayoutCodec frontier authority ABI', () => {

        expect(gpuTileFrontierLayouts.frontierEntry.fieldOffsets).to.deep.include({
            physicalSlot: 0,
            expectedGeneration: 4,
            expectedContentEpoch: 8,
            samplingLevel: 12,
            residencySnapshotEpoch: 48,
        })
        expect(gpuTileFrontierLayouts.frontierEntry.byteSize).to.equal(52)
    })

    it('reports one persistent packed COPY_SRC feedback layout without exposing its region', async() => {

        const fixture = await createGpuResourceGraphFixture()
        const frontier = await GpuTileFrontier.create(fixture.runtime, fixture.descriptor)
        const view = frontier.writeView(fixture.view)
        const frame = frontier.frame(view)
        const output = frame.feedbackOutput
        const sections = [
            output.layout.demands,
            output.layout.retirements,
            output.layout.counters,
            output.layout.diagnostics,
        ]
        const feedbackBuffer = fixture.calls.buffers.find(buffer =>
            buffer.descriptor.label.includes('GPU tile frontier feedbackOutput')
        )

        expect(output).not.to.have.property('region')
        expect(feedbackBuffer.descriptor.usage & GPU_BUFFER_USAGE_COPY_SRC).to.not.equal(0)
        expect(feedbackBuffer.descriptor.usage & GPU_BUFFER_USAGE_STORAGE).to.not.equal(0)
        expect(feedbackBuffer.descriptor.usage & GPU_BUFFER_USAGE_COPY_DST).to.not.equal(0)
        expect(sections.map(section => section.offset)).to.deep.equal(
            [ ...sections ].map(section => section.offset).sort((left, right) => left - right)
        )
        expect(sections.every(section =>
            section.offset % fixture.runtime.deviceLimits.minStorageBufferOffsetAlignment === 0
        )).to.equal(true)
        expect(new Set(sections.map(section => section.bufferId))).to.deep.equal(
            new Set([ output.bufferId ])
        )
        expect(fixture.calls.buffers.filter(buffer =>
            buffer.descriptor.label.includes('GPU tile frontier feedbackOutput')
        )).to.have.length(1)
        expect(frontier.facts()).not.to.have.property('resources')

        view.dispose()
        frontier.dispose()
        fixture.gpuState.dispose()
        fixture.residency.dispose()
        fixture.runtime.dispose()
    })

    it('rejects a self-consistent same-epoch snapshot that GPU state did not acknowledge', async() => {

        const fixture = await createGpuResourceGraphFixture()
        const frontier = await GpuTileFrontier.create(fixture.runtime, fixture.descriptor)
        const acknowledged = fixture.publication.snapshot
        const forged = new VirtualRasterSnapshot(
            acknowledged.addressSpace,
            acknowledged.epoch,
            acknowledged.pageTable,
            physicalPagesForSnapshot(acknowledged)
        )

        expect(forged).not.to.equal(acknowledged)
        expect(forged.resolve(fixture.descriptor.roots[0])).to.deep.equal(
            acknowledged.resolve(fixture.descriptor.roots[0])
        )
        expect(() => frontier.stageSeed(forged)).to.throw(GeoDiagnosticError)
        expect(frontier.stageSeed(acknowledged).snapshot).to.equal(acknowledged)

        frontier.dispose()
        fixture.gpuState.dispose()
        fixture.residency.dispose()
        fixture.runtime.dispose()
    })

    it('binds views to immutable upload tokens and current acknowledged snapshot authority', async() => {

        const fixture = await createGpuResourceGraphFixture({ maximumMatrixLevel: 1 })
        const frontier = await GpuTileFrontier.create(fixture.runtime, fixture.descriptor)
        const oldView = frontier.writeView(fixture.view)
        const oldFrame = frontier.frame(oldView)
        const oldCommand = gpuTileFrontierTestFrameAccess(frontier, oldFrame).viewCommand
        const oldBytes = new Uint8Array(
            oldCommand.data.buffer,
            oldCommand.data.byteOffset,
            oldCommand.data.byteLength
        ).slice()
        const child = fixture.gpuState.addressSpace.pageFromTile({
            matrixId: '1',
            tileRow: 0,
            tileCol: 0,
        })
        const publication = await acknowledgePage(
            fixture,
            child,
            'frontier-temporal-child-v1'
        )

        expect(() => frontier.frame(oldView)).to.throw(GeoDiagnosticError)
        const currentView = frontier.writeView({
            ...fixture.view,
            frameEpoch: 1,
            residencySnapshotEpoch: publication.snapshot.epoch,
        })
        const frame = frontier.frame(currentView)
        const currentCommand = gpuTileFrontierTestFrameAccess(frontier, frame).viewCommand
        expect(frame).to.deep.include({ frameEpoch: 1, parity: 0 })
        expect(currentCommand).not.to.equal(oldCommand)
        expect(Array.from(new Uint8Array(
            oldCommand.data.buffer,
            oldCommand.data.byteOffset,
            oldCommand.data.byteLength
        ))).to.deep.equal(Array.from(oldBytes))

        oldView.dispose()
        oldView.dispose()
        expect(oldView.isDisposed).to.equal(true)
        expect(oldCommand.isDisposed).to.equal(true)
        expect(() => frontier.frame(oldView)).to.throw(GeoDiagnosticError)

        currentView.dispose()
        frontier.dispose()
        fixture.gpuState.dispose()
        fixture.residency.dispose()
        fixture.runtime.dispose()
    })

    it('snapshots the complete descriptor before the first asynchronous allocation', async() => {

        const fixture = await createGpuResourceGraphFixture()
        const descriptor = {
            gpuState: fixture.gpuState,
            addressCodec: fixture.descriptor.addressCodec,
            policy: { ...fixture.descriptor.policy },
            levelMetrics: fixture.descriptor.levelMetrics.map(metric => ({ ...metric })),
            roots: [ ...fixture.descriptor.roots ],
            drawTemplates: fixture.descriptor.drawTemplates.map(template => ({ ...template })),
        }
        const expected = {
            refineErrorPixels: descriptor.policy.refineErrorPixels,
            geometricErrorMeters: descriptor.levelMetrics[0].geometricErrorMeters,
            root: descriptor.roots[0],
            drawTemplateId: descriptor.drawTemplates[0].id,
        }
        const creating = GpuTileFrontier.create(fixture.runtime, descriptor)
        descriptor.policy.refineErrorPixels = 999
        descriptor.levelMetrics[0].geometricErrorMeters = 999
        descriptor.roots.length = 0
        descriptor.drawTemplates[0].id = 'mutated-after-create'
        const frontier = await creating

        expect(frontier.descriptor.gpuState).to.equal(fixture.gpuState)
        expect(frontier.descriptor.addressCodec).to.equal(fixture.descriptor.addressCodec)
        expect(frontier.descriptor.policy.refineErrorPixels).to.equal(expected.refineErrorPixels)
        expect(frontier.descriptor.levelMetrics[0].geometricErrorMeters)
            .to.equal(expected.geometricErrorMeters)
        expect(frontier.descriptor.roots).to.deep.equal([ expected.root ])
        expect(frontier.descriptor.drawTemplates[0].id).to.equal(expected.drawTemplateId)
        expect([
            frontier.descriptor,
            frontier.descriptor.policy,
            frontier.descriptor.levelMetrics,
            frontier.descriptor.levelMetrics[0],
            frontier.descriptor.roots,
            frontier.descriptor.drawTemplates,
            frontier.descriptor.drawTemplates[0],
        ].every(Object.isFrozen)).to.equal(true)

        frontier.dispose()
        fixture.gpuState.dispose()
        fixture.residency.dispose()
        fixture.runtime.dispose()
    })

    it('rejects a borrowed slot table above maxStorageBufferBindingSize before allocation', async() => {

        const fixture = await createGpuResourceGraphFixture({
            maxStorageBufferBindingSize: 1024,
        })
        const bufferCount = fixture.calls.buffers.length
        await expectGpuFrontierDiagnostic(
            () => GpuTileFrontier.create(fixture.runtime, fixture.descriptor),
            'GEO_GPU_TILE_FRONTIER_CAPACITY_EXCEEDED'
        )
        expect(fixture.calls.buffers).to.have.length(bufferCount)

        fixture.gpuState.dispose()
        fixture.residency.dispose()
        fixture.runtime.dispose()
    })

    it('creates the persistent bounded GPU resource graph and two parity templates', async() => {

        const fixture = await createGpuResourceGraphFixture()
        const bufferStart = fixture.calls.buffers.length
        const frontier = await GpuTileFrontier.create(fixture.runtime, fixture.descriptor)
        const frontierNativeBuffers = fixture.calls.buffers.slice(bufferStart)
        const nativeCounts = {
            buffers: fixture.calls.buffers.length,
            bindLayouts: fixture.calls.bindGroupLayouts.length,
            bindSets: fixture.calls.bindGroups.length,
            pipelines: fixture.calls.computePipelines.length,
        }

        const seed = frontier.stageSeed(fixture.publication.snapshot)
        const evenView = frontier.writeView({ ...fixture.view, frameEpoch: 1 })
        const even = frontier.frame(evenView)
        const evenInternal = gpuTileFrontierTestFrameAccess(frontier, even)
        const evenSubmitted = frontier.encode(appendSeed(
            fixture.runtime.createSubmission({ validation: 'throw' }),
            seed
        ), even).submit()
        const oddView = frontier.writeView({ ...fixture.view, frameEpoch: 0 })
        const odd = frontier.frame(oddView)
        const oddInternal = gpuTileFrontierTestFrameAccess(frontier, odd)
        const oddSubmitted = frontier.encode(
            fixture.runtime.createSubmission({ validation: 'throw' }),
            odd
        ).submit()
        const evenAgainView = frontier.writeView({ ...fixture.view, frameEpoch: 99 })
        const evenAgain = frontier.frame(evenAgainView)
        const evenAgainInternal = gpuTileFrontierTestFrameAccess(frontier, evenAgain)
        const facts = frontier.facts()
        const terrain = frontier.drawArgument(even, 'terrain')

        expect(frontierNativeBuffers).to.have.length(16)
        expect(fixture.calls.computePipelines).to.have.length(12)
        expect(fixture.calls.bindGroupLayouts).to.have.length(12)
        expect(fixture.calls.bindGroups).to.have.length(24)
        for (const layout of fixture.calls.bindGroupLayouts) {
            const storageBindings = layout.descriptor.entries.filter(entry =>
                entry.buffer?.type === 'storage' || entry.buffer?.type === 'read-only-storage'
            )
            expect(storageBindings.length, layout.descriptor.label).to.be.at.most(8)
        }
        expect(evenInternal.commands.map(command => command.label)).to.deep.equal(FRONTIER_COMMAND_LABELS)
        expect(oddInternal.commands.map(command => command.label)).to.deep.equal(FRONTIER_COMMAND_LABELS)
        expect(evenInternal.commands.map(command => 'indirect' in command.count ? 'indirect' : 'direct'))
            .to.deep.equal(FRONTIER_COMMAND_COUNTS)
        expect(even).to.deep.include({ source: 'A', target: 'B', parity: 0 })
        expect(odd).to.deep.include({ source: 'B', target: 'A', parity: 1 })
        expect(evenAgain).to.deep.include({ source: 'A', target: 'B', parity: 0 })
        expect(evenInternal.currentFrontier).to.equal(oddInternal.nextFrontier)
        expect(evenInternal.nextFrontier).to.equal(oddInternal.currentFrontier)
        expect(evenAgainInternal.commands.map(command => command.id))
            .to.deep.equal(evenInternal.commands.map(command => command.id))
        expect(evenAgainInternal.currentFrontier).to.equal(evenInternal.currentFrontier)
        expect(evenAgainInternal.nextFrontier).to.equal(evenInternal.nextFrontier)
        for (const resource of [
            evenInternal.currentDispatchArguments,
            evenInternal.nextDispatchArguments,
            evenInternal.drawArguments,
            oddInternal.drawArguments,
            terrain.resource,
        ]) {
            expect(resource.usage & GPU_BUFFER_USAGE_STORAGE).to.not.equal(0)
            expect(resource.usage & GPU_BUFFER_USAGE_INDIRECT).to.not.equal(0)
        }
        expect(terrain).to.deep.include({ templateId: 'terrain', offset: 0, size: 16 })
        expect(terrain.resource).to.equal(evenInternal.drawArguments)
        expect(fixture.calls.maps).to.deep.equal([])
        expect({
            buffers: fixture.calls.buffers.length,
            bindLayouts: fixture.calls.bindGroupLayouts.length,
            bindSets: fixture.calls.bindGroups.length,
            pipelines: fixture.calls.computePipelines.length,
        }).to.deep.equal(nativeCounts)
        expect(await evenSubmitted.nativeOutcome).to.deep.include({ status: 'observed-succeeded' })
        expect(await oddSubmitted.nativeOutcome).to.deep.include({ status: 'observed-succeeded' })

        evenView.dispose()
        oddView.dispose()
        evenAgainView.dispose()
        frontier.dispose()
        frontier.dispose()
        expect(frontierNativeBuffers.every(buffer => buffer.destroyed)).to.equal(true)
        expect(fixture.gpuState.slotTable.isDisposed).to.equal(false)
        fixture.gpuState.dispose()
        fixture.residency.dispose()
        fixture.runtime.dispose()
    })

    it('keeps cancelled views on A and rejects a competing consumer after one submit', async() => {

        const fixture = await createGpuResourceGraphFixture()
        const frontier = await GpuTileFrontier.create(fixture.runtime, fixture.descriptor)
        const seed = frontier.stageSeed(fixture.publication.snapshot)
        const cancelled = frontier.writeView(fixture.view)
        expect(frontier.frame(cancelled)).to.deep.include({ source: 'A', target: 'B', parity: 0 })
        cancelled.dispose()

        const replacement = frontier.writeView({ ...fixture.view, frameEpoch: 1 })
        const frame = frontier.frame(replacement)
        expect(frame).to.deep.include({ source: 'A', target: 'B', parity: 0 })
        const firstBuilder = frontier.encode(appendSeed(
            fixture.runtime.createSubmission({ validation: 'throw' }),
            seed
        ), frame)
        const competingBuilder = frontier.encode(appendSeed(
            fixture.runtime.createSubmission({ validation: 'throw' }),
            seed
        ), frame)

        firstBuilder.submit()
        expect(() => competingBuilder.submit()).to.throw(ScratchDiagnosticError)
            .with.nested.property('diagnostic.code', 'SCRATCH_SUBMISSION_AUTHORITY_STALE')
        const next = frontier.writeView({ ...fixture.view, frameEpoch: 2 })
        expect(frontier.frame(next)).to.deep.include({ source: 'B', target: 'A', parity: 1 })

        replacement.dispose()
        next.dispose()
        frontier.dispose()
        fixture.gpuState.dispose()
        fixture.residency.dispose()
        fixture.runtime.dispose()
    })

    it('advances A/B after frontier issue even when a later composed queue action fails', async() => {

        const fixture = await createGpuResourceGraphFixture()
        const frontier = await GpuTileFrontier.create(fixture.runtime, fixture.descriptor)
        const seed = frontier.stageSeed(fixture.publication.snapshot)
        const firstView = frontier.writeView(fixture.view)
        const firstFrame = frontier.frame(firstView)
        const trailingBuffer = await fixture.runtime.createBuffer({ size: 4, usage: 0x08 })
        const trailingUpload = fixture.runtime.createUploadCommand({
            target: trailingBuffer.region(),
            data: new Uint32Array([ 0xdecafbad ]),
        })
        const writeBuffer = fixture.runtime.queue.writeBuffer.bind(fixture.runtime.queue)
        fixture.runtime.queue.writeBuffer = (buffer, ...args) => {
            if (buffer === trailingBuffer.gpuBuffer) {
                throw new Error('injected post-frontier upload failure')
            }
            return writeBuffer(buffer, ...args)
        }

        expect(() => frontier.encode(appendSeed(
            fixture.runtime.createSubmission({ validation: 'throw' }),
            seed
        ), firstFrame)
            .upload(trailingUpload)
            .submit()).to.throw('injected post-frontier upload failure')

        const nextView = frontier.writeView({ ...fixture.view, frameEpoch: 1 })
        expect(frontier.frame(nextView)).to.deep.include({
            source: 'B',
            target: 'A',
            parity: 1,
        })

        fixture.runtime.queue.writeBuffer = writeBuffer
        firstView.dispose()
        nextView.dispose()
        trailingUpload.dispose()
        trailingBuffer.dispose()
        frontier.dispose()
        fixture.gpuState.dispose()
        fixture.residency.dispose()
        fixture.runtime.dispose()
    })

    it('packs acknowledged roots once and keeps writeView as the sole per-frame host upload', async() => {

        const fixture = await createGpuResourceGraphFixture()
        const frontier = await GpuTileFrontier.create(fixture.runtime, fixture.descriptor)
        const queueWritesBeforeSeed = fixture.calls.queueWrites.length
        const seed = frontier.stageSeed(fixture.publication.snapshot)
        const sameSeed = frontier.stageSeed(fixture.publication.snapshot)
        const rootUpload = seed.uploads.find(command => command.label === 'Upload GPU tile frontier roots')
        const rootWords = new Uint32Array(
            rootUpload.data.buffer,
            rootUpload.data.byteOffset,
            rootUpload.data.byteLength / Uint32Array.BYTES_PER_ELEMENT
        )
        const resolvedRoot = fixture.publication.snapshot.resolve(fixture.descriptor.roots[0])

        expect(seed).to.equal(sameSeed)
        expect(seed.snapshotEpoch).to.equal(fixture.publication.snapshot.epoch)
        expect(fixture.calls.queueWrites).to.have.length(queueWritesBeforeSeed)
        expect(Array.from(rootWords.slice(0, 8))).to.deep.equal([
            resolvedRoot.physicalSlot,
            resolvedRoot.generation,
            resolvedRoot.contentEpoch,
            fixture.descriptor.roots[0].level,
            0,
            0,
            0,
            0,
        ])
        expect(rootWords[12]).to.equal(fixture.publication.snapshot.epoch)

        const firstView = frontier.writeView(fixture.view)
        const firstFrame = frontier.frame(firstView)
        const firstInternal = gpuTileFrontierTestFrameAccess(frontier, firstFrame)
        const firstBytes = new Uint8Array(
            firstInternal.viewCommand.data.buffer,
            firstInternal.viewCommand.data.byteOffset,
            firstInternal.viewCommand.data.byteLength
        ).slice()
        const firstDraw = await createDrawConsumer(fixture, frontier, firstFrame)
        const firstBuilder = appendSeed(
            fixture.runtime.createSubmission({ validation: 'throw' }),
            seed
        )
        const firstSubmitted = frontier.encode(firstBuilder, firstFrame)
            .render(firstDraw.pass, [ firstDraw.draw ])
            .submit()
        expect(await firstSubmitted.nativeOutcome).to.deep.include({ status: 'observed-succeeded' })

        const objectCounts = {
            buffers: fixture.calls.buffers.length,
            bindGroups: fixture.calls.bindGroups.length,
            pipelines: fixture.calls.computePipelines.length,
        }
        const queueWritesBeforeSecondFrame = fixture.calls.queueWrites.length
        const secondView = frontier.writeView({ ...fixture.view, frameEpoch: 1 })
        const secondFrame = frontier.frame(secondView)
        const secondInternal = gpuTileFrontierTestFrameAccess(frontier, secondFrame)
        const secondDraw = await createDrawConsumer(fixture, frontier, secondFrame)
        const secondSubmitted = frontier.encode(
            fixture.runtime.createSubmission({ validation: 'throw' }),
            secondFrame
        )
            .render(secondDraw.pass, [ secondDraw.draw ])
            .submit()

        expect(secondInternal.viewCommand).not.to.equal(firstInternal.viewCommand)
        expect(Array.from(new Uint8Array(
            firstInternal.viewCommand.data.buffer,
            firstInternal.viewCommand.data.byteOffset,
            firstInternal.viewCommand.data.byteLength
        ))).to.deep.equal(Array.from(firstBytes))
        expect(fixture.calls.queueWrites).to.have.length(queueWritesBeforeSecondFrame + 1)
        expect(fixture.calls.maps).to.deep.equal([])
        expect({
            buffers: fixture.calls.buffers.length,
            bindGroups: fixture.calls.bindGroups.length,
            pipelines: fixture.calls.computePipelines.length,
        }).to.deep.equal(objectCounts)
        expect(await secondSubmitted.nativeOutcome).to.deep.include({ status: 'observed-succeeded' })

        firstDraw.draw.dispose()
        firstDraw.pass.dispose()
        firstDraw.pipeline.dispose()
        firstDraw.program.dispose()
        firstDraw.target.dispose()
        secondDraw.draw.dispose()
        secondDraw.pass.dispose()
        secondDraw.pipeline.dispose()
        secondDraw.program.dispose()
        secondDraw.target.dispose()
        firstView.dispose()
        secondView.dispose()
        frontier.dispose()
        fixture.gpuState.dispose()
        fixture.residency.dispose()
        fixture.runtime.dispose()
    })

    it('packs camera x and y through the address codec wide-fixed ABI', async() => {

        const fixture = await createGpuResourceGraphFixture()
        const frontier = await GpuTileFrontier.create(fixture.runtime, fixture.descriptor)
        const view = {
            ...fixture.view,
            cameraHigh: [ HALF_WORLD, 100, 50 ],
            cameraLow: [ -1.3, 0.25, 0 ],
        }
        const token = frontier.writeView(view)
        const frame = frontier.frame(token)
        const access = gpuTileFrontierTestFrameAccess(frontier, frame)
        const packed = gpuTileFrontierMapMetaCodec.createReadbackView(new Uint8Array(
            access.viewCommand.data.buffer,
            access.viewCommand.data.byteOffset,
            access.viewCommand.data.byteLength
        )).toArray()[0]
        const fixed = fixture.descriptor.addressCodec.fromProjected([
            view.cameraHigh[0] + view.cameraLow[0],
            view.cameraHigh[1] + view.cameraLow[1],
        ]).fixed.limbs

        expect(packed).to.deep.include({
            cameraFixedLow: [ fixed[0].low, fixed[1].low ],
            cameraFixedHigh: [ fixed[0].high, fixed[1].high ],
        })
        expect(packed).not.to.have.property('cameraMercatorHigh')
        expect(packed).not.to.have.property('cameraMercatorLow')

        token.dispose()
        frontier.dispose()
        fixture.gpuState.dispose()
        fixture.residency.dispose()
        fixture.runtime.dispose()
    })

    it('records current-at-step producer and consumer epochs for dispatch and draw arguments', async() => {

        const fixture = await createGpuResourceGraphFixture()
        const frontier = await GpuTileFrontier.create(fixture.runtime, fixture.descriptor)
        const seed = frontier.stageSeed(fixture.publication.snapshot)
        const view = frontier.writeView(fixture.view)
        const frame = frontier.frame(view)
        const internal = gpuTileFrontierTestFrameAccess(frontier, frame)
        const drawFixture = await createDrawConsumer(fixture, frontier, frame)
        const builder = appendSeed(
            fixture.runtime.createSubmission({ validation: 'throw' }),
            seed
        )
        const submitted = frontier.encode(builder, frame)
            .render(drawFixture.pass, [ drawFixture.draw ])
            .submit()
        const reset = internal.commands[0]
        const finalize = internal.commands.at(-1)
        const dispatchWrites = submitted.resourceAccesses.filter(access =>
            access.commandId === reset.id &&
            access.resourceId === internal.currentDispatchArguments.id &&
            access.access === 'write'
        )
        const dispatchReads = submitted.resourceAccesses.filter(access =>
            internal.commands.slice(2, 11).includes(internal.commands.find(command => command.id === access.commandId)) &&
            access.resourceId === internal.currentDispatchArguments.id &&
            access.access === 'read'
        )
        const drawWrite = submitted.resourceAccesses.find(access =>
            access.commandId === finalize.id &&
            access.resourceId === drawFixture.argument.resource.id &&
            access.access === 'write'
        )
        const drawRead = submitted.resourceAccesses.find(access =>
            access.commandId === drawFixture.draw.id &&
            access.resourceId === drawFixture.argument.resource.id &&
            access.access === 'read'
        )

        expect(dispatchWrites).to.have.length(1)
        expect(dispatchReads).to.have.length(5)
        expect(dispatchReads.every(access =>
            access.declaredContentEpoch === 'current-at-step' &&
            access.contentEpochBefore === dispatchWrites[0].contentEpochAfter
        )).to.equal(true)
        expect(drawWrite).to.exist
        expect(drawRead).to.include({
            declaredContentEpoch: 'current-at-step',
            contentEpochBefore: drawWrite.contentEpochAfter,
        })
        expect(submitted.producerEpochs.some(epoch =>
            epoch.resourceId === internal.nextDispatchArguments.id
        )).to.equal(true)
        expect(fixture.calls.maps).to.deep.equal([])

        drawFixture.draw.dispose()
        drawFixture.pass.dispose()
        drawFixture.pipeline.dispose()
        drawFixture.program.dispose()
        drawFixture.target.dispose()
        view.dispose()
        frontier.dispose()
        fixture.gpuState.dispose()
        fixture.residency.dispose()
        fixture.runtime.dispose()
    })

    it('publishes bounded output producer epochs without mutable resource facts', async() => {

        const fixture = await createGpuResourceGraphFixture()
        const frontier = await GpuTileFrontier.create(fixture.runtime, fixture.descriptor)
        const seed = frontier.stageSeed(fixture.publication.snapshot)
        const view = frontier.writeView(fixture.view)
        const frame = frontier.frame(view)
        const internal = gpuTileFrontierTestFrameAccess(frontier, frame)
        const builder = appendSeed(
            fixture.runtime.createSubmission({ validation: 'throw' }),
            seed
        )
        const submitted = frontier.encode(builder, frame).submit()
        const finalizer = internal.commands.at(-1)
        const expectedProducerIds = [
            internal.nextDispatchArguments.id,
            internal.drawArguments.id,
            frame.visibleInstances.id,
            frame.feedbackOutput.bufferId,
        ]

        for (const resourceId of expectedProducerIds) {
            expect(submitted.producerEpochs.some(epoch =>
                epoch.resourceId === resourceId
            ), `producer ${resourceId}`).to.equal(true)
        }
        expect(submitted.resourceAccesses.some(access =>
            access.commandId === finalizer.id &&
            access.resourceId === internal.nextDispatchArguments.id &&
            access.access === 'write'
        )).to.equal(true)
        expect(frontier.facts()).not.to.have.property('resources')
        expect(fixture.calls.maps).to.deep.equal([])
        expect(await submitted.nativeOutcome).to.deep.include({ status: 'observed-succeeded' })

        view.dispose()
        frontier.dispose()
        fixture.gpuState.dispose()
        fixture.residency.dispose()
        fixture.runtime.dispose()
    })

    it('accepts newer acknowledged residency epochs without rebuilding or reseeding', async() => {

        const fixture = await createGpuResourceGraphFixture({ maximumMatrixLevel: 1 })
        const frontier = await GpuTileFrontier.create(fixture.runtime, fixture.descriptor)
        const seed = frontier.stageSeed(fixture.publication.snapshot)
        const rootUploadId = seed.uploads.find(command =>
            command.label === 'Upload GPU tile frontier roots'
        ).id
        const child = fixture.gpuState.addressSpace.pageFromTile({
            matrixId: '1',
            tileRow: 0,
            tileCol: 0,
        })
        const [ width, height ] = fixture.gpuState.addressSpace.pageSize
        fixture.residency.stage(ownedVirtualRasterPagePayload({
            page: child,
            width,
            height,
            channels: 1,
            data: new Uint8Array(width * height),
            contentVersion: 'frontier-child-v1',
        }), { generation: 1 })
        const publication = fixture.residency.publish()
        const update = fixture.gpuState.stage(publication)
        const builder = fixture.runtime.createSubmission({ validation: 'throw' })
        for (const command of update.commands) builder.upload(command)
        await fixture.gpuState.acknowledge(publication, builder.submit())

        const upload = frontier.writeView({
            ...fixture.view,
            frameEpoch: 1,
            residencySnapshotEpoch: publication.snapshot.epoch,
        })

        expect(upload.residencySnapshotEpoch).to.equal(publication.snapshot.epoch)
        expect(frontier.stageSeed(fixture.publication.snapshot)).to.equal(seed)
        expect(seed.uploads.find(command =>
            command.label === 'Upload GPU tile frontier roots'
        ).id).to.equal(rootUploadId)

        upload.dispose()
        frontier.dispose()
        fixture.gpuState.dispose()
        fixture.residency.dispose()
        fixture.runtime.dispose()
    })

    it('rejects wrong runtime, stale snapshot, forged frame, unknown template, and disposed use', async() => {

        const fixture = await createGpuResourceGraphFixture()
        const otherFake = createFakeGpu()
        const otherRuntime = await GPURuntime.create({ gpu: otherFake.gpu })
        const buffersBefore = otherFake.calls.buffers.length
        await expectGpuFrontierDiagnostic(
            () => GpuTileFrontier.create(otherRuntime, fixture.descriptor),
            'GEO_GPU_TILE_FRONTIER_INVALID'
        )
        expect(otherFake.calls.buffers).to.have.length(buffersBefore)

        const incomplete = await createGpuResourceGraphFixture({
            maximumMatrixLevel: 2,
            coverageMatrixLevels: [ 0, 2 ],
        })
        const incompleteBuffers = incomplete.calls.buffers.length
        await expectGpuFrontierDiagnostic(
            () => GpuTileFrontier.create(incomplete.runtime, incomplete.descriptor),
            'GEO_GPU_TILE_FRONTIER_INVALID'
        )
        expect(incomplete.calls.buffers).to.have.length(incompleteBuffers)

        const frontier = await GpuTileFrontier.create(fixture.runtime, fixture.descriptor)
        const view = frontier.writeView(fixture.view)
        const frame = frontier.frame(view)
        expect(() => frontier.drawArgument({ ...frame }, 'terrain')).to.throw(GeoDiagnosticError)
        expect(() => frontier.drawArgument(frame, 'missing')).to.throw(GeoDiagnosticError)

        fixture.residency.stage(ownedVirtualRasterPagePayload({
            page: fixture.descriptor.roots[0],
            width: fixture.gpuState.addressSpace.pageSize[0],
            height: fixture.gpuState.addressSpace.pageSize[1],
            channels: 1,
            data: new Uint8Array(
                fixture.gpuState.addressSpace.pageSize[0] *
                fixture.gpuState.addressSpace.pageSize[1]
            ),
            contentVersion: 'unacknowledged-root-v2',
        }), { generation: 4 })
        const unacknowledged = fixture.residency.publish().snapshot
        expect(() => frontier.stageSeed(unacknowledged)).to.throw(GeoDiagnosticError)

        frontier.dispose()
        expect(() => frontier.frame(view)).to.throw(GeoDiagnosticError)
        expect(() => frontier.writeView(fixture.view)).to.throw(GeoDiagnosticError)
        expect(() => frontier.drawArgument(frame, 'terrain')).to.throw(GeoDiagnosticError)
        view.dispose()
        otherRuntime.dispose()
        incomplete.gpuState.dispose()
        incomplete.residency.dispose()
        incomplete.runtime.dispose()
        fixture.gpuState.dispose()
        fixture.residency.dispose()
        fixture.runtime.dispose()
    })

    it('generates all real WGSL stages from the LayoutCodec ABI without placeholder kernels', async() => {

        const fixture = await createGpuResourceGraphFixture()
        const module = createGpuTileFrontierWgsl(fixture.descriptor, 32, 1)

        expect(module.entryPoints).to.deep.equal(gpuTileFrontierEntryPoints)
        for (const entryPoint of gpuTileFrontierEntryPoints) {
            expect(module.code).to.match(new RegExp(`fn ${entryPoint}\\(`))
            expect(module.code).to.not.match(new RegExp(`fn ${entryPoint}\\([^)]*\\)\\s*\\{\\s*\\}`))
        }
        expect(module.layoutDependencies).to.include.members(
            Object.values(gpuTileFrontierLayouts).map(layout => layout.codec.artifact)
        )
        expect(module.code).to.include('atomicCompareExchangeWeak')
        expect(module.code).to.include('2654435761u')
        expect(module.code).to.include('row3 - row2')
        expect(module.code).to.include('distanceToAabb')
        expect(module.code).to.include('coveredChildOrdinal')
        expect(module.code).to.include('coveredChildCount')
        expect(module.code).to.include('projectedArea')
        expect(module.code).to.include('sseScore')
        expect(module.code).to.include('costPenalty')
        expect(module.code).to.include('DECISION_CANDIDATE')
        expect(module.code).to.include('DECISION_BLOCKED')
        expect(module.code).to.include('DECISION_BASE_PRIORITY')
        expect(module.code).to.include('decisionOffset(index, DECISION_BASE_PRIORITY)')
        expect(module.code).to.include('entry.previousLodState')
        expect(module.code).to.include('entry.childDemandMask')
        expect(module.code).to.include('bucket = 255i')
        expect(module.code).to.include('countOneBits')
        expect(module.code).to.include('PREFIX_BLOCK_BASE')
        expect(module.code).to.include('nextDispatchArguments[0]')
        expect(module.code).to.include('drawArgumentsOutput[base + 1u] = visibleCount')
        expect(module.code).to.not.include('atomic<u32>(0u)')
        expect(module.code).to.not.include('let activeCost = select(3u, 0u')

        fixture.gpuState.dispose()
        fixture.residency.dispose()
        fixture.runtime.dispose()
    })

    it('reconstructs every camera-relative WebMercator edge independently', () => {

        const fixture = createFixture()
        const generated = createGpuTileFrontierWgsl(fixture.descriptor, 32, 1).code

        expect(generated).to.include('fn boundaryQuanta(')
        expect(generated).to.include('fn relativeQuantaMeters(')
        expect(generated).to.include('let west = boundaryQuanta(column, matrixLevel);')
        expect(generated).to.include('let east = boundaryQuanta(column + 1u, matrixLevel);')
        expect(generated).to.include('let north = boundaryQuanta(row, matrixLevel);')
        expect(generated).to.include('let south = boundaryQuanta(row + 1u, matrixLevel);')
        expect(generated).to.include('mapMeta.cameraFixedLow.x')
        expect(generated).to.include('mapMeta.cameraFixedHigh.x')
        expect(generated).to.include('mapMeta.cameraFixedLow.y')
        expect(generated).to.include('mapMeta.cameraFixedHigh.y')
        expect(generated).to.not.include('cameraMercatorHigh')
        expect(generated).to.not.include('cameraMercatorLow')
        expect(generated).to.not.include('normalizedWest')
        expect(generated).to.not.include('let tileExtent =')
        expect(generated).to.not.include('minimumX + tileExtent')
        expect(generated).to.not.include('maximumY - tileExtent')
    })

    it('rejects invalid policies with structured selection diagnostics', () => {

        const invalidPolicy = {
            refineErrorPixels: 2,
            coarsenErrorPixels: 2,
            minimumMatrixLevel: 0,
            maximumMatrixLevel: 3,
            maximumActiveTiles: 16,
            maximumDemands: 8,
            transitionReservePages: 5,
            invisibleGraceFrames: 2,
        }

        expect(() => gpuTileFrontierPolicy(invalidPolicy)).to.throw(GeoDiagnosticError)

        try {
            gpuTileFrontierPolicy(invalidPolicy)
            expect.fail('invalid frontier policy should throw')
        } catch (error) {
            expect(error).to.be.instanceOf(GeoDiagnosticError)
            expect(error.diagnostic.code).to.equal('GEO_GPU_TILE_FRONTIER_INVALID')
            expect(error.diagnostic.phase).to.equal('selection')
        }
        expect(() => gpuTileFrontierPolicy()).to.throw(GeoDiagnosticError)

        const invalidValues = [
            { refineErrorPixels: Number.NaN },
            { coarsenErrorPixels: -1 },
            { minimumMatrixLevel: 4 },
            { maximumActiveTiles: 0 },
            { maximumDemands: 65 },
            { transitionReservePages: 0 },
            { invisibleGraceFrames: 0.5 },
        ]
        for (const changed of invalidValues) {
            expect(() => gpuTileFrontierPolicy({
                ...invalidPolicy,
                coarsenErrorPixels: 1,
                ...changed,
            })).to.throw(GeoDiagnosticError)
        }
    })

    it('exposes one LayoutCodec-derived source of byte sizes and offsets', () => {

        expect(gpuTileFrontierLayouts.mapMeta).to.deep.include({
            byteSize: 144,
            fieldOffsets: {
                clipFromRelativeWorld: 0,
                cameraHigh: 64,
                cameraLow: 80,
                cameraFixedLow: 96,
                cameraFixedHigh: 104,
                viewport: 112,
                verticalFovRadians: 120,
                cameraLatitudeRadians: 124,
                zoomHint: 128,
                frameEpoch: 132,
                residencySnapshotEpoch: 136,
            },
        })
        expect(gpuTileFrontierLayouts.policy).to.deep.include({
            byteSize: 32,
            fieldOffsets: {
                refineErrorPixels: 0,
                coarsenErrorPixels: 4,
                minimumMatrixLevel: 8,
                maximumMatrixLevel: 12,
                maximumActiveTiles: 16,
                maximumDemands: 20,
                transitionReservePages: 24,
                invisibleGraceFrames: 28,
            },
        })
        expect(gpuTileFrontierLayouts.levelMetric.byteSize).to.equal(16)
        expect(gpuTileFrontierLayouts.frontierEntry.byteSize).to.equal(52)
        expect(gpuTileFrontierLayouts.visibleInstance.byteSize).to.equal(32)
        expect(gpuTileFrontierLayouts.demand.byteSize).to.equal(48)
        expect(gpuTileFrontierLayouts.diagnostics.byteSize).to.equal(80)
        for (const layout of Object.values(gpuTileFrontierLayouts)) {
            expect(layout.codec.artifact.byteLength).to.equal(layout.byteSize)
            expect(Object.fromEntries(layout.codec.artifact.fields.map(field => [
                field.name,
                field.offset,
            ]))).to.deep.equal(layout.fieldOffsets)
        }
    })

    it('rejects duplicate draw template ids through descriptor validation', () => {

        const fixture = createFixture()
        const duplicateDescriptor = {
            ...fixture.descriptor,
            drawTemplates: [
                { id: 'terrain', vertexCount: 6 },
                { id: 'terrain', vertexCount: 12 },
            ],
        }

        try {
            evaluateGpuTileFrontierReference({
                descriptor: duplicateDescriptor,
                view: fixture.view,
                currentFrontier: [],
                residentPages: [],
            })
            expect.fail('duplicate draw template ids should throw')
        } catch (error) {
            expect(error).to.be.instanceOf(GeoDiagnosticError)
            expect(error.diagnostic).to.deep.include({
                code: 'GEO_GPU_TILE_FRONTIER_INVALID',
                phase: 'selection',
            })
            expect(error.diagnostic.actual).to.deep.include({ drawTemplateId: 'terrain' })
        }
    })

    it('requires ordered metrics, a complete root set, and u32-packed values', () => {

        const fixture = createFixture()
        expectFrontierInvalid(() => evaluateGpuTileFrontierReference({
            descriptor: {
                ...fixture.descriptor,
                levelMetrics: [ ...fixture.descriptor.levelMetrics ].reverse(),
            },
            view: fixture.view,
            currentFrontier: [],
            residentPages: [],
        }))

        const multiRoot = createFixture({ minimumMatrixLevel: 1 })
        expect(multiRoot.descriptor.roots).to.have.length(4)
        expectFrontierInvalid(() => evaluateGpuTileFrontierReference({
            descriptor: {
                ...multiRoot.descriptor,
                roots: multiRoot.descriptor.roots.slice(0, 3),
            },
            view: multiRoot.view,
            currentFrontier: [],
            residentPages: [],
        }))

        const subcoverage = createFixture({
            minimumMatrixLevel: 2,
            maximumMatrixLevel: 2,
            coverageLimits: {
                2: {
                    matrixId: '2',
                    minTileRow: 0,
                    maxTileRow: 1,
                    minTileCol: 1,
                    maxTileCol: 2,
                },
            },
        })
        const reversedRoots = [ ...subcoverage.descriptor.roots ].reverse()
        const accepted = evaluateGpuTileFrontierReference({
            descriptor: {
                ...subcoverage.descriptor,
                roots: reversedRoots,
            },
            view: subcoverage.view,
            currentFrontier: reversedRoots.map((root, index) => subcoverage.entry(
                Number(root.tile.matrixId),
                root.tile.tileRow,
                root.tile.tileCol,
                { physicalSlot: index }
            )),
            residentPages: reversedRoots.map((root, index) => subcoverage.resident(
                Number(root.tile.matrixId),
                root.tile.tileRow,
                root.tile.tileCol,
                { physicalSlot: index }
            )),
        })
        expect(keys(accepted.nextFrontier)).to.deep.equal([
            subcoverage.page(2, 0, 1).key,
            subcoverage.page(2, 1, 1).key,
            subcoverage.page(2, 0, 2).key,
            subcoverage.page(2, 1, 2).key,
        ])

        expectFrontierInvalid(() => gpuTileFrontierPolicy({
            ...fixture.descriptor.policy,
            maximumActiveTiles: U32_LIMIT,
        }))
        expectFrontierInvalid(() => evaluateGpuTileFrontierReference({
            descriptor: {
                ...fixture.descriptor,
                drawTemplates: [ { id: 'terrain', vertexCount: U32_LIMIT } ],
            },
            view: fixture.view,
            currentFrontier: [],
            residentPages: [],
        }))
        expectFrontierInvalid(() => evaluateGpuTileFrontierReference({
            descriptor: {
                ...fixture.descriptor,
                gpuState: {
                    ...fixture.descriptor.gpuState,
                    maxPhysicalPages: U32_LIMIT,
                },
            },
            view: fixture.view,
            currentFrontier: [],
            residentPages: [],
        }))
        expectFrontierInvalid(() => evaluateGpuTileFrontierReference({
            descriptor: fixture.descriptor,
            view: { ...fixture.view, frameEpoch: U32_LIMIT },
            currentFrontier: [],
            residentPages: [],
        }))
        const oversizedEntry = fixture.entry(3, 0, 0, { physicalSlot: U32_LIMIT })
        const oversizedResident = {
            ...fixture.resident(3, 0, 0),
            physicalSlot: U32_LIMIT,
        }
        expectFrontierInvalid(() => fixture.evaluate(
            [ oversizedEntry ],
            [ oversizedResident ]
        ))
    })

    it('rejects a complete root cover larger than active-frontier capacity', () => {

        const fixture = createFixture({
            minimumMatrixLevel: 1,
            maximumActiveTiles: 1,
            maximumDemands: 4,
        })

        expect(fixture.descriptor.roots).to.have.length(4)
        expectFrontierInvalid(() => fixture.evaluate([], []))
    })

    it('rejects duplicate or over-capacity current-frontier inputs before selection', () => {

        const tight = createFixture({
            maximumActiveTiles: 5,
            errorByLevel: [ 100, 100_000, 100, 100 ],
        })
        const first = tight.entry(1, 0, 0)
        const second = tight.entry(1, 0, 1)
        const residents = [
            tight.resident(1, 0, 0),
            tight.resident(1, 0, 1),
        ]
        for (const currentFrontier of [
            [ second, first, first ],
            [ first, first, second ],
        ]) {
            expectFrontierInvalid(() => tight.evaluate(currentFrontier, residents))
        }

        const overCapacity = createFixture({
            maximumActiveTiles: 1,
            maximumDemands: 4,
        })
        expectFrontierInvalid(() => overCapacity.evaluate(
            [ overCapacity.entry(1, 0, 0), overCapacity.entry(1, 0, 1) ],
            [ overCapacity.resident(1, 0, 0), overCapacity.resident(1, 0, 1) ]
        ))
        expectFrontierInvalid(() => tight.evaluate([
            tight.entry(1, 0, 0, {
                physicalSlot: tight.descriptor.gpuState.maxPhysicalPages,
            }),
        ], []))
    })

    it('rejects forged current compact indexes independent of input order', () => {

        const fixture = createFixture()
        const first = fixture.entry(1, 0, 0)
        const second = fixture.entry(1, 0, 1, {
            compactIndex: first.compactIndex,
        })
        const residents = [
            fixture.resident(1, 0, 0),
            fixture.resident(1, 0, 1),
        ]

        expectFrontierInvalid(() => fixture.evaluate([ first, second ], residents))
        expectFrontierInvalid(() => fixture.evaluate([ second, first ], residents))
    })

    it('rejects a current frontier whose tile paths are not prefix-free', () => {

        const fixture = createFixture()
        const parent = fixture.entry(1, 0, 0)
        const descendant = fixture.entry(2, 0, 1)

        expectFrontierInvalid(() => fixture.evaluate(
            [ descendant, parent ],
            [ fixture.resident(1, 0, 0), fixture.resident(2, 0, 1) ]
        ))
    })

    it('rejects noncanonical resident indexes and physical-slot ownership', () => {

        const fixture = createFixture()
        const first = fixture.resident(1, 0, 0)
        const second = fixture.resident(1, 0, 1)
        const duplicateIndex = {
            ...second,
            compactIndex: first.compactIndex,
        }
        const duplicateSlot = {
            ...second,
            physicalSlot: first.physicalSlot,
        }
        const outOfRangeSlot = {
            ...second,
            physicalSlot: fixture.descriptor.gpuState.maxPhysicalPages,
        }

        expectFrontierInvalid(() => fixture.evaluate([], [ first, duplicateIndex ]))
        expectFrontierInvalid(() => fixture.evaluate([], [ duplicateIndex, first ]))
        expectFrontierInvalid(() => fixture.evaluate([], [ first, first ]))
        expectFrontierInvalid(() => fixture.evaluate([], [ first, duplicateSlot ]))
        expectFrontierInvalid(() => fixture.evaluate([], [ first, outOfRangeSlot ]))
    })

    it('does not draw an active entry with stale authoritative content', () => {

        const fixture = createFixture({ errorByLevel: [ 0.1, 0.1, 0.1, 0.1 ] })
        const entry = fixture.entry(3, 3, 3, { contentEpoch: 4 })
        const resident = fixture.resident(3, 3, 3, { contentEpoch: 5 })
        const result = fixture.evaluate([ entry ], [ resident ])

        expect(result.nextFrontier).to.deep.equal([])
        expect(result.visible).to.deep.equal([])
        expect(result.facts).to.deep.include({
            staleGenerationCount: 1,
            visibleInstanceCount: 0,
        })
    })

    it('keeps unchanged older entries while rejecting frontier authority from the future', () => {

        const fixture = createFixture({ errorByLevel: [ 0.1, 0.1, 0.1, 0.1 ] })
        const unchanged = fixture.entry(3, 3, 3, { residencySnapshotEpoch: 6 })
        const resident = fixture.resident(3, 3, 3, { residencySnapshotEpoch: 7 })
        const retained = fixture.evaluate([ unchanged ], [ resident ])
        const future = fixture.entry(3, 3, 3, { residencySnapshotEpoch: 8 })
        const rejected = fixture.evaluate([ future ], [ resident ])

        expect(keys(retained.nextFrontier)).to.deep.equal([ unchanged.page.key ])
        expect(retained.nextFrontier[0].residencySnapshotEpoch).to.equal(7)
        expect(retained.facts.staleGenerationCount).to.equal(0)
        expect(rejected.nextFrontier).to.deep.equal([])
        expect(rejected.facts.staleGenerationCount).to.equal(1)
    })

    it('does not draw an off-frustum leaf', () => {

        const fixture = createFixture({ errorByLevel: [ 0.1, 0.1, 0.1, 0.1 ] })
        const leaf = fixture.entry(3, 0, 7)
        const result = fixture.evaluate([ leaf ], [ fixture.resident(3, 0, 7) ], {
            clipFromRelativeWorld: [
                1 / HALF_WORLD, 0, 0, 0,
                0, 1 / HALF_WORLD, 0, 0,
                0, 0, 1 / 1_000_000, 0,
                2, 0, 1, 1,
            ],
        })

        expect(keys(result.nextFrontier)).to.deep.equal([ leaf.page.key ])
        expect(result.visible).to.deep.equal([])
        expect(result.facts.visibleInstanceCount).to.equal(0)
    })

    it('rejects terrain behind the WebGPU near clip plane', () => {

        const fixture = createFixture({ errorByLevel: [ 0.1, 0.1, 0.1, 0.1 ] })
        const leaf = fixture.entry(3, 3, 3)
        const result = fixture.evaluate([ leaf ], [ fixture.resident(3, 3, 3) ], {
            clipFromRelativeWorld: [
                1 / HALF_WORLD, 0, 0, 0,
                0, 1 / HALF_WORLD, 0, 0,
                0, 0, 1 / 1_000_000, 0,
                0, 0, 0, 1,
            ],
        })

        expect(keys(result.nextFrontier)).to.deep.equal([ leaf.page.key ])
        expect(result.visible).to.deep.equal([])
    })

    it('retains a complete intermediate sibling cover inside the hysteresis interval', () => {

        const fixture = createFixture({ errorByLevel: [ 100, 100, 3_000, 100 ] })
        const siblings = [
            fixture.entry(2, 0, 0),
            fixture.entry(2, 0, 1),
            fixture.entry(2, 1, 0),
            fixture.entry(2, 1, 1),
        ]
        const residents = [
            fixture.resident(1, 0, 0),
            ...siblings.map(entry => fixture.resident(
                2,
                entry.page.tile.tileRow,
                entry.page.tile.tileCol
            )),
        ]
        const result = fixture.evaluate(siblings, residents)

        expect(keys(result.nextFrontier)).to.deep.equal(keys(siblings))
        expect(keys(result.visible)).to.deep.equal(keys(siblings))
        expect(result.demands).to.deep.equal([])
        expect(result.facts).to.deep.include({
            refineCandidateCount: 0,
            coarsenCandidateCount: 0,
            convergenceState: 'converged',
        })
        expect(result.nextFrontier.every(entry => entry.lastVisibleFrame === 10)).to.equal(true)
    })

    it('protects invisible complete siblings through grace before coarsening', () => {

        const fixture = createFixture({ errorByLevel: [ 100, 100, 3_000, 100 ] })
        const siblings = [
            fixture.entry(2, 0, 0, { lastVisibleFrame: 0 }),
            fixture.entry(2, 0, 1, { lastVisibleFrame: 0 }),
            fixture.entry(2, 1, 0, { lastVisibleFrame: 0 }),
            fixture.entry(2, 1, 1, { lastVisibleFrame: 0 }),
        ]
        const residents = [
            fixture.resident(1, 0, 0),
            fixture.resident(2, 0, 0),
            fixture.resident(2, 0, 1),
            fixture.resident(2, 1, 0),
            fixture.resident(2, 1, 1),
        ]
        const visible = fixture.evaluate(siblings, residents)
        expect(visible.nextFrontier.every(entry => entry.lastVisibleFrame === 10)).to.equal(true)

        const offFrustum = {
            clipFromRelativeWorld: [
                1 / HALF_WORLD, 0, 0, 0,
                0, 1 / HALF_WORLD, 0, 0,
                0, 0, 1 / 1_000_000, 0,
                3, 0, 1, 1,
            ],
        }
        const protectedResult = fixture.evaluate(visible.nextFrontier, residents, {
            ...offFrustum,
            frameEpoch: 12,
        })
        expect(keys(protectedResult.nextFrontier)).to.deep.equal(keys(siblings))
        expect(protectedResult.visible).to.deep.equal([])
        expect(protectedResult.facts.coarsenCandidateCount).to.equal(0)

        const expiredResult = fixture.evaluate(protectedResult.nextFrontier, residents, {
            ...offFrustum,
            frameEpoch: 13,
        })
        expect(keys(expiredResult.nextFrontier)).to.deep.equal([
            fixture.page(1, 0, 0).key,
        ])
        expect(expiredResult.visible).to.deep.equal([])
        expect(expiredResult.facts.coarsenCandidateCount).to.equal(1)
    })

    it('propagates current visibility into a coarsened parent grace epoch', () => {

        const fixture = createFixture({ errorByLevel: [ 0.1, 0.1, 0.1, 0.1 ] })
        const siblings = [
            fixture.entry(2, 0, 0, { lastVisibleFrame: 1 }),
            fixture.entry(2, 0, 1, { lastVisibleFrame: 1 }),
            fixture.entry(2, 1, 0, { lastVisibleFrame: 1 }),
            fixture.entry(2, 1, 1, { lastVisibleFrame: 1 }),
        ]
        const residents = [
            fixture.resident(1, 0, 0),
            ...siblings.map(sibling => fixture.resident(
                2,
                sibling.page.tile.tileRow,
                sibling.page.tile.tileCol
            )),
        ]
        const result = fixture.evaluate(siblings, residents)

        expect(keys(result.nextFrontier)).to.deep.equal([ fixture.page(1, 0, 0).key ])
        expect(result.nextFrontier[0].lastVisibleFrame).to.equal(fixture.view.frameEpoch)
    })

    it('keeps a parent and emits canonical covered-child demands until all children exist', () => {

        const fixture = createFixture({ errorByLevel: [ 100, 100_000, 100, 100 ] })
        const parent = fixture.entry(1, 0, 0)
        const result = fixture.evaluate([ parent ], [ fixture.resident(1, 0, 0) ])
        const childKeys = [
            fixture.page(2, 0, 0).key,
            fixture.page(2, 0, 1).key,
            fixture.page(2, 1, 0).key,
            fixture.page(2, 1, 1).key,
        ]

        expect(keys(result.nextFrontier)).to.deep.equal([ parent.page.key ])
        expect(keys(result.visible)).to.deep.equal([ parent.page.key ])
        expect(result.demands.map(demand => demand.page.key)).to.deep.equal(childKeys)
        expect(result.demands.map(demand => demand.childMask)).to.deep.equal([ 1, 2, 4, 8 ])
        expect(result.facts).to.deep.include({
            refineCandidateCount: 1,
            demandCount: 4,
            fallbackCount: 1,
        })
    })

    it('replaces a parent only after all acknowledged children are resident', () => {

        const fixture = createFixture({ errorByLevel: [ 100, 100_000, 100, 100 ] })
        const parent = fixture.entry(1, 0, 0)
        const children = [
            fixture.resident(2, 0, 0),
            fixture.resident(2, 0, 1),
            fixture.resident(2, 1, 0),
            fixture.resident(2, 1, 1),
        ]
        const result = fixture.evaluate(
            [ parent ],
            [ fixture.resident(1, 0, 0), ...children ]
        )

        expect(keys(result.nextFrontier)).to.deep.equal(children.map(child => child.page.key))
        expect(keys(result.visible)).to.deep.equal(children.map(child => child.page.key))
        expect(result.demands).to.deep.equal([])
    })

    it('preserves hierarchical path-prefix order across mixed-level refinement', () => {

        const fixture = createFixture({ errorByLevel: [ 100, 100_000, 100, 100 ] })
        const parents = [ fixture.entry(1, 0, 0), fixture.entry(1, 0, 1) ]
        const residentChildren = [
            [ 2, 0, 0 ], [ 2, 0, 1 ], [ 2, 1, 0 ], [ 2, 1, 1 ],
            [ 2, 0, 2 ], [ 2, 0, 3 ], [ 2, 1, 2 ], [ 2, 1, 3 ],
        ]
        const result = fixture.evaluate(
            [ parents[1], parents[0] ],
            [
                ...parents.map(parent => fixture.resident(
                    1,
                    parent.page.tile.tileRow,
                    parent.page.tile.tileCol
                )),
                ...residentChildren.map(([ level, row, col ]) =>
                    fixture.resident(level, row, col)),
            ]
        )

        expect(keys(result.nextFrontier)).to.deep.equal(
            residentChildren.map(([ level, row, col ]) => fixture.page(level, row, col).key)
        )

        const mixed = fixture.evaluate(
            [ parents[1], parents[0] ],
            [
                fixture.resident(1, 0, 0),
                fixture.resident(1, 0, 1),
                ...residentChildren.slice(0, 4).map(([ level, row, col ]) =>
                    fixture.resident(level, row, col)),
            ]
        )
        expect(keys(mixed.nextFrontier)).to.deep.equal([
            ...residentChildren.slice(0, 4).map(([ level, row, col ]) =>
                fixture.page(level, row, col).key),
            parents[1].page.key,
        ])
    })

    it('compacts demands by canonical parent and child order after priority selection', () => {

        const fixture = createFixture({ errorByLevel: [ 100, 100_000, 100, 100 ] })
        const lowerPriorityFirst = fixture.entry(1, 0, 0, { lastDemandFrame: 9 })
        const higherPrioritySecond = fixture.entry(1, 0, 1, { lastDemandFrame: 0 })
        const result = fixture.evaluate(
            [ higherPrioritySecond, lowerPriorityFirst ],
            [
                fixture.resident(1, 0, 0),
                fixture.resident(1, 0, 1),
            ]
        )
        const expectedDemands = [
            [ 2, 0, 0 ], [ 2, 0, 1 ], [ 2, 1, 0 ], [ 2, 1, 1 ],
            [ 2, 0, 2 ], [ 2, 0, 3 ], [ 2, 1, 2 ], [ 2, 1, 3 ],
        ].map(([ level, row, col ]) => fixture.page(level, row, col).key)

        expect(result.demands.map(demand => demand.page.key)).to.deep.equal(expectedDemands)
    })

    it('refines only the balancing neighbor when its children are already resident', () => {

        const fixture = createFixture({ errorByLevel: [ 0.1, 0.1, 100_000, 100 ] })
        const coarseNeighbor = fixture.entry(1, 0, 0)
        const parent = fixture.entry(2, 0, 2)
        const parentChildren = [
            fixture.resident(3, 0, 4),
            fixture.resident(3, 0, 5),
            fixture.resident(3, 1, 4),
            fixture.resident(3, 1, 5),
        ]
        const balancingChildren = [
            fixture.resident(2, 0, 0),
            fixture.resident(2, 0, 1),
            fixture.resident(2, 1, 0),
            fixture.resident(2, 1, 1),
        ]
        const result = fixture.evaluate(
            [ coarseNeighbor, parent ],
            [
                fixture.resident(1, 0, 0),
                fixture.resident(2, 0, 2),
                ...balancingChildren,
                ...parentChildren,
            ]
        )

        expect(keys(result.nextFrontier)).to.deep.equal([
            ...balancingChildren.map(child => child.page.key),
            parent.page.key,
        ])
        expect(result.demands).to.deep.equal([])
        expect(result.facts).to.deep.include({
            fallbackCount: 1,
            budgetLimitedCount: 0,
            convergenceState: 'transitioning',
        })
    })

    it('keeps blocked pressure and unrelated refine and demand transactions independent', () => {

        const fixture = createFixture({ errorByLevel: [ 0.1, 0.1, 100_000, 100 ] })
        const coarseNeighbor = fixture.entry(1, 0, 0)
        const blocked = fixture.entry(2, 0, 2)
        const unrelatedDemand = fixture.entry(2, 3, 0)
        const unrelatedRefine = fixture.entry(2, 3, 3)
        const blockedChildren = [
            fixture.resident(3, 0, 4),
            fixture.resident(3, 0, 5),
            fixture.resident(3, 1, 4),
            fixture.resident(3, 1, 5),
        ]
        const unrelatedChildren = [
            fixture.resident(3, 6, 6),
            fixture.resident(3, 6, 7),
            fixture.resident(3, 7, 6),
            fixture.resident(3, 7, 7),
        ]
        const result = fixture.evaluate(
            [ unrelatedRefine, blocked, coarseNeighbor, unrelatedDemand ],
            [
                fixture.resident(1, 0, 0),
                fixture.resident(2, 0, 2),
                fixture.resident(2, 3, 0),
                fixture.resident(2, 3, 3),
                ...blockedChildren,
                ...unrelatedChildren,
            ]
        )
        const balancingDemandKeys = [
            fixture.page(2, 0, 0).key,
            fixture.page(2, 0, 1).key,
            fixture.page(2, 1, 0).key,
            fixture.page(2, 1, 1).key,
        ]
        const unrelatedDemandKeys = [
            fixture.page(3, 6, 0).key,
            fixture.page(3, 6, 1).key,
            fixture.page(3, 7, 0).key,
            fixture.page(3, 7, 1).key,
        ]

        expect(keys(result.nextFrontier)).to.deep.equal([
            coarseNeighbor.page.key,
            blocked.page.key,
            unrelatedDemand.page.key,
            ...unrelatedChildren.map(child => child.page.key),
        ])
        expect(result.demands.map(demand => demand.page.key)).to.deep.equal([
            ...balancingDemandKeys,
            ...unrelatedDemandKeys,
        ])
        expect(result.facts).to.deep.include({
            refineCandidateCount: 4,
            demandCount: 8,
            fallbackCount: 3,
            budgetLimitedCount: 0,
            convergenceState: 'transitioning',
        })
    })

    it('does not reinsert an already blocked candidate in a canonical three-level pressure chain', () => {

        const fixture = createFixture({
            maximumMatrixLevel: 4,
            maximumActiveTiles: 6,
            errorByLevel: [ 0.1, 100_000, 100_000, 100_000, 100_000 ],
        })
        const fine = fixture.entry(3, 0, 1)
        const middle = fixture.entry(2, 0, 1)
        const coarse = fixture.entry(1, 0, 1)
        const coarseChildren = [
            fixture.resident(2, 0, 2),
            fixture.resident(2, 0, 3),
            fixture.resident(2, 1, 2),
            fixture.resident(2, 1, 3),
        ]
        const result = fixture.evaluate(
            [ coarse, middle, fine ],
            [
                fixture.resident(3, 0, 1),
                fixture.resident(2, 0, 1),
                fixture.resident(1, 0, 1),
                ...coarseChildren,
            ]
        )

        expect(keys(result.nextFrontier)).to.deep.equal([
            fine.page.key,
            middle.page.key,
            ...coarseChildren.map(child => child.page.key),
        ])
        expect(result.facts).to.deep.include({
            refineCandidateCount: 3,
            budgetLimitedCount: 0,
            fallbackCount: 2,
        })
    })

    it('does not propagate promoted priority through a blocked pressure chain', () => {

        const fixture = createFixture({
            maximumMatrixLevel: 4,
            maximumActiveTiles: 7,
            errorByLevel: [ 0.1, 5_000, 5_000, 100_000, 5_000 ],
        })
        const fine = fixture.entry(3, 0, 1, { lastDemandFrame: 0 })
        const middle = fixture.entry(2, 0, 1, { lastDemandFrame: 63 })
        const coarse = fixture.entry(1, 0, 1, { lastDemandFrame: 63 })
        const competitor = fixture.entry(1, 1, 0, { lastDemandFrame: 0 })
        const competitorChildren = [
            fixture.resident(2, 2, 0),
            fixture.resident(2, 2, 1),
            fixture.resident(2, 3, 0),
            fixture.resident(2, 3, 1),
        ]
        const result = fixture.evaluate(
            [ competitor, coarse, middle, fine ],
            [
                fixture.resident(3, 0, 1),
                fixture.resident(2, 0, 1),
                fixture.resident(1, 0, 1),
                fixture.resident(1, 1, 0),
                ...competitorChildren,
            ],
            { frameEpoch: 63 }
        )

        expect(keys(result.nextFrontier)).to.deep.equal([
            fine.page.key,
            middle.page.key,
            coarse.page.key,
            ...competitorChildren.map(child => child.page.key),
        ])
        expect(result.facts).to.deep.include({
            refineCandidateCount: 4,
            budgetLimitedCount: 2,
            fallbackCount: 1,
            activeFrontierCount: 7,
        })
    })

    it('coarsens only a complete canonical sibling transaction', () => {

        const fixture = createFixture({ errorByLevel: [ 0.1, 0.1, 0.1, 0.1 ] })
        const siblings = [
            fixture.entry(2, 0, 0),
            fixture.entry(2, 0, 1),
            fixture.entry(2, 1, 0),
            fixture.entry(2, 1, 1),
        ]
        const residents = [
            fixture.resident(1, 0, 0),
            ...siblings.map(entry => fixture.resident(
                Number(entry.page.tile.matrixId),
                entry.page.tile.tileRow,
                entry.page.tile.tileCol
            )),
        ]

        const complete = fixture.evaluate(siblings, residents)
        expect(keys(complete.nextFrontier)).to.deep.equal([ fixture.page(1, 0, 0).key ])
        expect(complete.facts.coarsenCandidateCount).to.equal(1)

        const incomplete = fixture.evaluate(siblings.slice(0, 3), residents)
        expect(keys(incomplete.nextFrontier)).to.deep.equal(keys(siblings.slice(0, 3)))
        expect(incomplete.facts.coarsenCandidateCount).to.equal(0)
    })

    it('uses hierarchical path tie order and preserves complete cover under tight capacity', () => {

        const fixture = createFixture({
            maximumActiveTiles: 5,
            errorByLevel: [ 100, 100_000, 100, 100 ],
        })
        const first = fixture.entry(1, 0, 0)
        const second = fixture.entry(1, 0, 1)
        const firstChildren = [
            fixture.resident(2, 0, 0),
            fixture.resident(2, 0, 1),
            fixture.resident(2, 1, 0),
            fixture.resident(2, 1, 1),
        ]
        const secondChildren = [
            fixture.resident(2, 0, 2),
            fixture.resident(2, 0, 3),
            fixture.resident(2, 1, 2),
            fixture.resident(2, 1, 3),
        ]
        const result = fixture.evaluate(
            [ second, first ],
            [
                fixture.resident(1, 0, 0),
                fixture.resident(1, 0, 1),
                ...firstChildren,
                ...secondChildren,
            ]
        )

        expect(keys(result.nextFrontier)).to.deep.equal([
            ...firstChildren.map(child => child.page.key),
            second.page.key,
        ])
        expect(keys(result.visible)).to.deep.equal(keys(result.nextFrontier))
        expect(result.facts).to.deep.include({
            activeFrontierCount: 5,
            refineCandidateCount: 2,
            budgetLimitedCount: 1,
            convergenceState: 'budget-limited',
        })
    })
})
