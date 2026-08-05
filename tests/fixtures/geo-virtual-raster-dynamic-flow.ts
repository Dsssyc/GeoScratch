import { ScratchRuntime } from 'geoscratch'
import type { BufferResource, SubmittedWork, UploadCommand } from 'geoscratch'
import {
    VirtualRasterResidency,
    cellLocalF32Codec,
    createVirtualRasterGpuState,
    ownedVirtualRasterPagePayload,
    surfaceDomain,
    virtualRasterAccessor,
    virtualRasterAddressSpace,
    virtualRasterPlane,
} from 'geoscratch/geo'
import type {
    VirtualRasterGpuState,
    VirtualRasterGpuUpdate,
    VirtualRasterPageIdentity,
    VirtualRasterSnapshot,
} from 'geoscratch/geo'

const PARTICLE_COUNT = 262_144
const WORKGROUP_SIZE = 256
const WORKGROUP_COUNT = PARTICLE_COUNT / WORKGROUP_SIZE
const FIELD_EXTENT = 256
const FIELD_PAGE_SIZE = 64
const FIELD_LEVEL_COUNT = 3
const MAX_PHYSICAL_PAGES = 5
const POSITION_CELL_COUNT = 4_096
const POSITION_CELL_EXTENT = 1 / POSITION_CELL_COUNT
const POSITION_BYTES = PARTICLE_COUNT * 16
const STAT_BYTES = 32
const STATE_BYTES = POSITION_BYTES + STAT_BYTES
const SIMULATION_LEVELS = Object.freeze([ 2, 2, 1, 1, 0, 0 ])
const bufferUsage = Object.freeze({
    COPY_SRC: 0x04,
    COPY_DST: 0x08,
    UNIFORM: 0x40,
    STORAGE: 0x80,
})

const domain = surfaceDomain({
    id: 'geoscratch.proof.dynamic-flow-domain',
    axes: [
        { name: 'east', unit: 'normalized-world' },
        { name: 'north', unit: 'normalized-world' },
    ],
    embeddingAxes: [
        { name: 'world-x', unit: 'normalized-world' },
        { name: 'world-y', unit: 'normalized-world' },
        { name: 'height', unit: 'normalized-world' },
    ],
    auxiliaryAxes: [
        { name: 'simulation-time', unit: 'step' },
        { name: 'field-lod', unit: 'level' },
    ],
})

const positionCodec = cellLocalF32Codec({
    domain,
    cellExtent: POSITION_CELL_EXTENT,
})

export async function runGeoVirtualRasterDynamicFlowProof() {

    const runtime = await ScratchRuntime.create({
        label: 'Geo virtual raster dynamic Flow proof',
        powerPreference: 'high-performance',
        diagnostics: {
            operationCapacity: 96,
            incidentCapacity: 16,
            evidenceByteCapacity: 128 * 1024,
            submissionScopes: 'summary',
            maxPendingNativeObservations: 4,
        },
    })
    let residency: VirtualRasterResidency | undefined
    let gpu: VirtualRasterGpuState | undefined
    let readback: ReturnType<ScratchRuntime['createReadback']> | undefined
    try {
        const addressSpace = virtualRasterAddressSpace({
            id: 'geoscratch.proof.dynamic-vector-field',
            dimensions: 2,
            extent: [ FIELD_EXTENT, FIELD_EXTENT ],
            pageSize: [ FIELD_PAGE_SIZE, FIELD_PAGE_SIZE ],
            levelCount: FIELD_LEVEL_COUNT,
        })
        const plane = virtualRasterPlane({
            id: 'geoscratch.proof.velocity',
            addressSpace,
            kind: 'vector',
            channels: 2,
            sampleType: 'float32',
            gpuFormat: 'rg32float',
            auxiliaryAxes: [ { name: 'field-lod', value: 'explicit-level' } ],
        })
        residency = new VirtualRasterResidency({
            addressSpace,
            plane,
            maxPhysicalPages: MAX_PHYSICAL_PAGES,
            maxStagingBytes: MAX_PHYSICAL_PAGES * FIELD_PAGE_SIZE * FIELD_PAGE_SIZE * 2 * 4,
            maxHistory: 48,
        })
        const rootPage = addressSpace.page({ level: 2, x: 0, y: 0 })
        const levelOnePage = addressSpace.page({ level: 1, x: 0, y: 0 })
        const levelZeroPage = addressSpace.page({ level: 0, x: 2, y: 2 })
        residency.pin(rootPage)
        gpu = await createVirtualRasterGpuState(runtime, {
            addressSpace,
            plane,
            maxPhysicalPages: MAX_PHYSICAL_PAGES,
        })

        const initialState = createInitialStateBytes()
        const stateBuffer = await runtime.createBuffer({
            label: 'Dynamic Flow canonical particle state and counters',
            size: STATE_BYTES,
            usage: bufferUsage.COPY_DST |
                bufferUsage.COPY_SRC |
                bufferUsage.STORAGE,
        })
        const parameterBytes = new Uint32Array(4)
        const parameterBuffer = await runtime.createBuffer({
            label: 'Dynamic Flow simulation parameters',
            size: parameterBytes.byteLength,
            usage: bufferUsage.COPY_DST | bufferUsage.UNIFORM,
        })
        const stateUpload = runtime.createUploadCommand({
            label: 'Initialize Dynamic Flow canonical positions',
            target: stateBuffer.region(),
            data: initialState,
        })
        const parameterUpload = runtime.createUploadCommand({
            label: 'Upload Dynamic Flow simulation parameters',
            target: parameterBuffer.region(),
            data: parameterBytes,
        })
        const simulationLayout = await runtime.createBindLayout({
            label: 'Dynamic Flow simulation state layout',
            group: 0,
            entries: [
                {
                    binding: 0,
                    name: 'positions',
                    type: 'storage',
                    visibility: [ 'compute' ],
                    minBindingSize: POSITION_BYTES,
                },
                {
                    binding: 1,
                    name: 'counters',
                    type: 'storage',
                    visibility: [ 'compute' ],
                    minBindingSize: STAT_BYTES,
                },
                {
                    binding: 2,
                    name: 'simulation',
                    type: 'uniform',
                    visibility: [ 'compute' ],
                    minBindingSize: parameterBytes.byteLength,
                },
            ],
        })
        const fieldLayout = await runtime.createBindLayout({
            label: 'Dynamic Flow virtual vector field layout',
            group: 1,
            entries: [
                {
                    binding: 0,
                    name: 'pageTable',
                    type: 'read-storage',
                    visibility: [ 'compute' ],
                },
                {
                    binding: 1,
                    name: 'atlas',
                    type: 'texture',
                    visibility: [ 'compute' ],
                    sampleType: 'unfilterable-float',
                    viewDimension: '2d',
                },
            ],
        })
        const simulationBindSet = await runtime.createBindSet(simulationLayout, {
            positions: stateBuffer.region({ offset: 0, size: POSITION_BYTES }),
            counters: stateBuffer.region({ offset: POSITION_BYTES, size: STAT_BYTES }),
            simulation: parameterBuffer.region(),
        }, { label: 'Dynamic Flow simulation state' })
        const fieldBindSet = await runtime.createBindSet(fieldLayout, {
            pageTable: gpu.pageTable.region(),
            atlas: gpu.atlasView,
        }, { label: 'Dynamic Flow virtual vector field' })
        const accessor = virtualRasterAccessor({ addressSpace, plane })
        const module = await runtime.createShaderModule({
            label: 'Dynamic Flow virtual raster compute shader',
            sourceParts: [
                { code: positionCodec.wgslModule({ namespace: 'FlowPosition' }) },
                { code: accessor.wgslModule({
                    namespace: 'FlowField',
                    group: 1,
                    pageTableBinding: 0,
                    atlasBinding: 1,
                }) },
                { code: simulationShader() },
            ],
        })
        const program = runtime.createProgram({
            label: 'Dynamic Flow virtual raster compute program',
            compute: { module, entryPoint: 'simulate' },
        })
        const pipeline = await runtime.createComputePipeline({
            label: 'Dynamic Flow virtual raster compute pipeline',
            program,
            layout: { mode: 'explicit', bindLayouts: [ simulationLayout, fieldLayout ] },
        })
        const pass = runtime.createComputePass({
            label: 'Dynamic Flow virtual raster simulation pass',
        })
        const dispatch = runtime.createDispatchCommand({
            label: 'Advance 262144 canonical Flow positions',
            pipeline,
            bindSets: [ { set: simulationBindSet }, { set: fieldBindSet } ],
            count: { workgroups: [ WORKGROUP_COUNT ] },
            resources: {
                read: [
                    { resource: stateBuffer, contentEpoch: 'current-at-step' },
                    { resource: parameterBuffer, contentEpoch: 'current-at-step' },
                    { resource: gpu.pageTable, contentEpoch: 'current-at-step' },
                    { resource: gpu.atlas, contentEpoch: 'current-at-step' },
                ],
                write: [ stateBuffer ],
            },
            whenMissing: 'throw',
        })
        const stableIds = Object.freeze([
            stateBuffer.id,
            parameterBuffer.id,
            gpu.pageTable.id,
            gpu.atlas.id,
            simulationLayout.id,
            fieldLayout.id,
            simulationBindSet.id,
            fieldBindSet.id,
            program.id,
            pipeline.id,
            pass.id,
            dispatch.id,
        ])

        let pageRequestCount = 0
        residency.reconcileGeneration(1, [ rootPage ])
        stageGeneratedPage(residency, rootPage, 1)
        pageRequestCount++
        const initialPublication = residency.publish()
        const initialUpdate = gpu.stage(initialPublication)
        const initialWork = submitUploads(runtime, [
            stateUpload,
            parameterUpload,
            ...initialUpdate.commands,
        ])
        await gpu.acknowledge(initialPublication, initialWork)
        await observe(initialWork)
        stateUpload.dispose()
        initialState.fill(0)

        const cameraRequestEpochProofs: Array<Readonly<{
            requestedLevel: number
            beforePositionEpoch: number
            afterPositionEpoch: number
            snapshotEpoch: number
        }>> = []
        const firstCameraUpdate = await publishCameraRequest(
            runtime,
            residency,
            gpu,
            levelOnePage,
            stateBuffer,
            2
        )
        pageRequestCount++
        cameraRequestEpochProofs.push(firstCameraUpdate)

        const snapshotEpochs: number[] = []
        const positionEpochs: number[] = []
        let currentSnapshot = residency.currentSnapshot
        let latestWork: SubmittedWork = initialWork
        for (let step = 0; step < SIMULATION_LEVELS.length; step++) {
            if (step === 4) {
                const secondCameraUpdate = await publishCameraRequest(
                    runtime,
                    residency,
                    gpu,
                    levelZeroPage,
                    stateBuffer,
                    3
                )
                pageRequestCount++
                cameraRequestEpochProofs.push(secondCameraUpdate)
                currentSnapshot = residency.currentSnapshot
            }
            const level = SIMULATION_LEVELS[step]!
            parameterBytes[0] = level
            parameterBytes[1] = step
            parameterBytes[2] = PARTICLE_COUNT
            parameterBytes[3] = currentSnapshot.epoch
            latestWork = runtime.createSubmission({ validation: 'throw' })
                .upload(parameterUpload)
                .compute(pass, [ dispatch ])
                .submit()
            snapshotEpochs.push(currentSnapshot.epoch)
            positionEpochs.push(stateBuffer.contentEpoch)
            await observe(latestWork)
        }

        readback = runtime.createReadback({
            label: 'Final bounded Dynamic Flow proof readback',
            source: stateBuffer.region(),
            after: latestWork,
        })
        const finalBytes = await readback.toBytes()
        const counters = readCounters(finalBytes)
        const sampledPositions = [ 0, 65_535, 131_071, 196_607, PARTICLE_COUNT - 1 ]
            .map(index => readPosition(finalBytes, index))
        readback.dispose()
        readback = undefined

        const resolvedLevels = residency.currentSnapshot.pageTable
            .filter(entry => entry.status === 'resident' || entry.status === 'fallback')
            .map(entry => entry.resolvedLevel!)
        const runtimeFacts = runtime.diagnostics.snapshot()
        const result = Object.freeze({
            particleCount: PARTICLE_COUNT,
            positionEncoding: positionCodec.facts.encoding,
            bytesPerPosition: positionCodec.facts.bytesPerPosition,
            particleStateBytes: POSITION_BYTES,
            logicalAddressBytesPersisted: 0,
            computeAddressMaterializationPassCount: 0,
            cpuParticleMirrorBytesPerStep: 0,
            finalReadbackCount: 1,
            simulationStepCount: SIMULATION_LEVELS.length,
            simulationLods: SIMULATION_LEVELS,
            requestedLodRange: Object.freeze([ 0, 2 ]),
            resolvedLodRange: Object.freeze([
                Math.min(...resolvedLevels),
                Math.max(...resolvedLevels),
            ]),
            snapshotEpochs: Object.freeze(snapshotEpochs),
            positionEpochs: Object.freeze(positionEpochs),
            cameraRequestEpochProofs: Object.freeze(cameraRequestEpochProofs),
            coordinateErrorBound: positionCodec.facts.quantizationError,
            maxLocalUlp: positionCodec.facts.maxLocalUlp,
            wrapPolicy: positionCodec.facts.wrapPolicy,
            supportedOperations: positionCodec.facts.supportedOperations,
            counters,
            sampledPositions: Object.freeze(sampledPositions),
            pageRequestCount,
            fallbackCount: residency.inspect().fallbackCount,
            evictionCount: residency.inspect().evictionCount,
            residency: residency.inspect(),
            gpu: gpu.facts(),
            stableIdentityCount: stableIds.length,
            stableIdentityPreserved: sameStrings(stableIds, [
                stateBuffer.id,
                parameterBuffer.id,
                gpu.pageTable.id,
                gpu.atlas.id,
                simulationLayout.id,
                fieldLayout.id,
                simulationBindSet.id,
                fieldBindSet.id,
                program.id,
                pipeline.id,
                pass.id,
                dispatch.id,
            ]),
            diagnostics: Object.freeze({
                retainedOperationCount: runtimeFacts.recorder.retainedOperationCount,
                operationCapacity: runtimeFacts.recorder.operationCapacity,
                retainedIncidentCount: runtimeFacts.recorder.retainedIncidentCount,
                currentPendingNativeObservations:
                    runtimeFacts.submissionNative.currentPendingNativeObservations,
                currentEffectfulSubmittedWork:
                    runtimeFacts.submissionNative.currentEffectfulSubmittedWork,
                activeReadbacks: runtimeFacts.readbacks.length,
                activeReadbackCommands: runtimeFacts.readbackCommands.length,
                uncapturedErrors: runtimeFacts.aggregates.uncapturedErrors,
                deviceLosses: runtimeFacts.aggregates.deviceLosses,
            }),
        })
        parameterUpload.dispose()
        return result
    } finally {
        readback?.dispose()
        residency?.dispose()
        gpu?.dispose()
        await runtime.dispose()
    }
}

async function publishCameraRequest(
    runtime: ScratchRuntime,
    residency: VirtualRasterResidency,
    gpu: VirtualRasterGpuState,
    page: VirtualRasterPageIdentity,
    positions: BufferResource,
    generation: number
) {

    const beforePositionEpoch = positions.contentEpoch
    residency.reconcileGeneration(generation, [ page ])
    const outcome = stageGeneratedPage(residency, page, generation)
    if (outcome.status !== 'staged' && outcome.status !== 'resident') {
        throw new Error(`Dynamic Flow virtual page ${page.key} failed: ${outcome.status}`)
    }
    const publication = residency.publish()
    const snapshot = publication.snapshot
    const update = gpu.stage(publication)
    const work = submitUploads(runtime, update.commands)
    await gpu.acknowledge(publication, work)
    await observe(work)
    return Object.freeze({
        requestedLevel: page.level,
        beforePositionEpoch,
        afterPositionEpoch: positions.contentEpoch,
        snapshotEpoch: snapshot.epoch,
    })
}

function stageGeneratedPage(
    residency: VirtualRasterResidency,
    page: VirtualRasterPageIdentity,
    generation: number
) {

    return residency.stage(ownedVirtualRasterPagePayload({
        page,
        width: FIELD_PAGE_SIZE,
        height: FIELD_PAGE_SIZE,
        channels: 2,
        data: createVectorPage(page),
        contentVersion: 'dynamic-vector-field-v1',
    }), { generation })
}

function submitUploads(
    runtime: ScratchRuntime,
    uploads: readonly (UploadCommand | VirtualRasterGpuUpdate['commands'][number])[]
) {

    const builder = runtime.createSubmission({ validation: 'throw' })
    for (const upload of uploads) builder.upload(upload)
    return builder.submit()
}

async function observe(submitted: SubmittedWork) {

    const [ nativeOutcome ] = await Promise.all([ submitted.nativeOutcome, submitted.done ])
    if (nativeOutcome.status !== 'observed-succeeded') {
        throw new Error(`Dynamic Flow submission ended as ${nativeOutcome.status}`)
    }
}

function createInitialStateBytes() {

    const bytes = new Uint8Array(STATE_BYTES)
    const view = new DataView(bytes.buffer)
    for (let index = 0; index < PARTICLE_COUNT; index++) {
        const offset = index * positionCodec.facts.bytesPerPosition
        const cells = initialCells(index)
        view.setInt32(offset, cells[0], true)
        view.setFloat32(offset + 4, (index % 13) / 13 * POSITION_CELL_EXTENT, true)
        view.setInt32(offset + 8, cells[1], true)
        view.setFloat32(offset + 12, (index % 17) / 17 * POSITION_CELL_EXTENT, true)
    }
    return bytes
}

function initialCells(index: number): readonly [number, number] {

    return [
        128 + (index * 17) % 3_584,
        128 + (index * 31) % 3_584,
    ]
}

function createVectorPage(page: VirtualRasterPageIdentity) {

    const data = new Float32Array(FIELD_PAGE_SIZE * FIELD_PAGE_SIZE * 2)
    const levelScale = 2 ** page.level
    for (let y = 0; y < FIELD_PAGE_SIZE; y++) {
        for (let x = 0; x < FIELD_PAGE_SIZE; x++) {
            const levelX = page.coordinates[0]! * FIELD_PAGE_SIZE + x
            const levelY = page.coordinates[1]! * FIELD_PAGE_SIZE + y
            const finestX = (levelX + 0.5) * levelScale
            const finestY = (levelY + 0.5) * levelScale
            const offset = (y * FIELD_PAGE_SIZE + x) * 2
            data[offset] = Math.fround(
                0.00052 + 0.00008 * Math.sin(finestY / FIELD_EXTENT * Math.PI * 2)
            )
            data[offset + 1] = Math.fround(
                0.00034 + 0.00006 * Math.cos(finestX / FIELD_EXTENT * Math.PI * 2)
            )
        }
    }
    return data
}

function readCounters(bytes: Uint8Array) {

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return Object.freeze({
        residentSamples: view.getUint32(POSITION_BYTES, true),
        fallbackSamples: view.getUint32(POSITION_BYTES + 4, true),
        cellTransitions: view.getUint32(POSITION_BYTES + 8, true),
        pageTransitions: view.getUint32(POSITION_BYTES + 12, true),
    })
}

function readPosition(bytes: Uint8Array, index: number) {

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const offset = index * positionCodec.facts.bytesPerPosition
    const position = Object.freeze({
        index,
        cells: Object.freeze([
            view.getInt32(offset, true),
            view.getInt32(offset + 8, true),
        ]),
        local: Object.freeze([
            view.getFloat32(offset + 4, true),
            view.getFloat32(offset + 12, true),
        ]),
    })
    if (position.local.some(value => !Number.isFinite(value) ||
        value < 0 || value >= POSITION_CELL_EXTENT)) {
        throw new Error(`Dynamic Flow particle ${index} was not normalized`)
    }
    return position
}

function simulationShader() {

    return `
struct SimulationParameters {
    level: u32,
    step: u32,
    particle_count: u32,
    snapshot_epoch: u32,
};

@group(0) @binding(0) var<storage, read_write> positions: array<FlowPositionPosition>;
@group(0) @binding(1) var<storage, read_write> counters: array<atomic<u32>>;
@group(0) @binding(2) var<uniform> simulation: SimulationParameters;

var<workgroup> workgroup_counters: array<vec4u, ${WORKGROUP_SIZE}>;

fn finest_texel(position: FlowPositionPosition) -> vec2f {
    return vec2f(
        f32(position.axes[0].cell) * ${FIELD_EXTENT / POSITION_CELL_COUNT} +
            position.axes[0].local * ${FIELD_EXTENT},
        f32(position.axes[1].cell) * ${FIELD_EXTENT / POSITION_CELL_COUNT} +
            position.axes[1].local * ${FIELD_EXTENT}
    );
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn simulate(
    @builtin(global_invocation_id) global_id: vec3u,
    @builtin(local_invocation_id) local_id: vec3u
) {
    let index = global_id.x;
    let before = positions[index];
    let before_texel = finest_texel(before);
    let requested_texel = before_texel / f32(1u << simulation.level);
    let sample = FlowField_sample_compute(requested_texel, simulation.level);
    let available = sample.status == 1u || sample.status == 2u;
    let velocity = select(vec2f(0.0), sample.value.xy, available);
    let next = FlowPosition_advance(
        before,
        array<f32, 2>(velocity.x, velocity.y)
    );
    positions[index] = next;
    let after_texel = finest_texel(next);
    let before_page = vec2u(floor(before_texel)) / vec2u(${FIELD_PAGE_SIZE}u);
    let after_page = vec2u(floor(after_texel)) / vec2u(${FIELD_PAGE_SIZE}u);
    workgroup_counters[local_id.x] = vec4u(
        select(0u, 1u, sample.status == 1u),
        select(0u, 1u, sample.status == 2u),
        select(0u, 1u, before.axes[0].cell != next.axes[0].cell ||
            before.axes[1].cell != next.axes[1].cell),
        select(0u, 1u, any(before_page != after_page))
    );
    workgroupBarrier();
    var stride = ${WORKGROUP_SIZE / 2}u;
    loop {
        if (local_id.x < stride) {
            workgroup_counters[local_id.x] += workgroup_counters[local_id.x + stride];
        }
        workgroupBarrier();
        if (stride == 1u) { break; }
        stride /= 2u;
    }
    if (local_id.x == 0u) {
        atomicAdd(&counters[0], workgroup_counters[0].x);
        atomicAdd(&counters[1], workgroup_counters[0].y);
        atomicAdd(&counters[2], workgroup_counters[0].z);
        atomicAdd(&counters[3], workgroup_counters[0].w);
    }
}
`
}

function sameStrings(left: readonly string[], right: readonly string[]) {

    return left.length === right.length && left.every((value, index) => value === right[index])
}
