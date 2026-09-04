import {
    WebMercatorQuad,
    createVirtualRasterRuntime,
    webMercatorVirtualRasterField,
} from 'geoscratch/geo'
import type {
    VirtualRasterPageIdentity,
    VirtualRasterRuntime,
} from 'geoscratch/geo'
import type {
    GPURuntime,
    WorkerModuleResolver,
    WorkerSystem,
} from 'geoscratch/scratch'
import type { FlowFieldCachePolicy } from './cache-policy.ts'
import {
    createVelocityWorkerRequestExecutor,
} from './velocity-tile-executor.ts'
import type {
    FlowVelocityWorkerRequestExecutor,
} from './velocity-tile-executor.ts'
import type {
    FlowFieldDataset,
    FlowFieldRuntimePage,
    FlowFieldRuntimeRepresentation,
    FlowFieldRuntimeSample,
} from './flow-dataset.ts'

export type FlowVelocitySampleSource = Readonly<{
    sampleKey: string
    timeIndex: number
    sample: FlowFieldRuntimeSample
    sampleRegistration: 'pixel-center'
    representation: FlowFieldRuntimeRepresentation
    model: ReturnType<typeof webMercatorVirtualRasterField>
    resolvePage(page: VirtualRasterPageIdentity): FlowFieldRuntimePage
}>

type FlowVelocitySampleModel = ReturnType<typeof webMercatorVirtualRasterField>

export type FlowVelocitySampleRuntime = VirtualRasterRuntime<FlowVelocitySampleModel> & Readonly<{
    source: FlowVelocitySampleSource
    workerFacts(): ReturnType<FlowVelocityWorkerRequestExecutor['inspect']>
}>

export type FlowVelocitySampleRuntimeOptions = Readonly<{
    runtime: GPURuntime
    dataset: FlowFieldDataset
    sampleKey: string
    cachePolicy: FlowFieldCachePolicy
    workerSystem: WorkerSystem
    workerModules: WorkerModuleResolver
    workerCount?: number
    maxNetworkRequests?: number
    maxDecodeTasks?: number
    maxRequests?: number
    maxPhysicalPages?: number
    maxStagingBytes?: number
    maxHistory?: number
}>

const DEFAULT_MAX_REQUESTS = 24
const DEFAULT_MAX_PHYSICAL_PAGES = 18
const DEFAULT_MAX_HISTORY = 64
const PAGE_BYTE_LENGTH = 256 * 256 * 2 * Float32Array.BYTES_PER_ELEMENT

/** Creates one immutable velocity source from a normalized runtime sample identity. */
export function createVelocitySampleSource(
    dataset: FlowFieldDataset,
    sampleKey: string
): FlowVelocitySampleSource {

    if (dataset?.kind !== 'flow-field-dataset' || dataset.schemaVersion !== 2 ||
        dataset.artifactType !== 'flow-field-cog-runtime' ||
        !/^[0-9a-f]{64}$/.test(dataset.sourceHash) ||
        typeof dataset.contentVersion !== 'string' || dataset.contentVersion.length === 0 ||
        dataset.representation?.sampleRegistration !== 'pixel-center' ||
        dataset.tileMatrixSet?.coverage?.tileMatrixSet !== WebMercatorQuad ||
        typeof dataset.sample !== 'function' || typeof dataset.page !== 'function') {
        throw new TypeError('Flow Field velocity samples require a normalized runtime dataset')
    }
    const sample = dataset.sample(sampleKey)
    if (sample.sampleKey !== sampleKey) {
        throw new TypeError('Flow Field runtime dataset returned another sample identity')
    }
    const model = webMercatorVirtualRasterField({
        id: `flow-velocity.${dataset.datasetId}.${sample.sampleKey}`,
        addressSpaceId:
            `flow-velocity.wmq.${dataset.sourceHash.slice(0, 16)}.` +
            `${dataset.contentVersion}.${sample.sampleKey}`,
        sourceRevision: dataset.contentVersion,
        coverage: dataset.tileMatrixSet.coverage,
        geographicBounds: dataset.source.geographicBounds,
        fieldKind: 'vector',
        channels: 2,
        sampleType: 'float32',
        gpuFormat: 'rg32float',
        unit: dataset.unit,
        interpolation: 'linear',
        auxiliaryAxes: [
            { name: 'model-time', value: sample.modelTime },
            { name: 'vector-basis', value: dataset.basis },
        ],
    })

    function resolvePage(page: VirtualRasterPageIdentity): FlowFieldRuntimePage {

        const tile = page?.tile
        if (page?.addressSpaceId !== model.addressSpace.id || tile === undefined ||
            tile.tileMatrixSetId !== dataset.tileMatrixSet.id) {
            throw new TypeError('Flow Field velocity source requires its own WebMercatorQuad page')
        }
        const resolved = dataset.page(sample.sampleKey, tile)
        if (resolved.sampleKey !== sample.sampleKey ||
            resolved.timeIndex !== sample.timeIndex) {
            throw new TypeError('Flow Field runtime page belongs to another sample')
        }
        return resolved
    }

    return Object.freeze({
        sampleKey: sample.sampleKey,
        timeIndex: sample.timeIndex,
        sample,
        sampleRegistration: dataset.representation.sampleRegistration,
        representation: dataset.representation,
        model,
        resolvePage,
    })
}

/** Composes one sample-key velocity runtime with an owned executor and borrowed WorkerSystem. */
export async function createVelocitySampleRuntime({
    runtime,
    dataset,
    sampleKey,
    cachePolicy,
    workerSystem,
    workerModules,
    workerCount,
    maxNetworkRequests,
    maxDecodeTasks,
    maxRequests = DEFAULT_MAX_REQUESTS,
    maxPhysicalPages = DEFAULT_MAX_PHYSICAL_PAGES,
    maxStagingBytes = maxPhysicalPages * PAGE_BYTE_LENGTH,
    maxHistory = DEFAULT_MAX_HISTORY,
}: FlowVelocitySampleRuntimeOptions): Promise<FlowVelocitySampleRuntime> {

    const source = createVelocitySampleSource(dataset, sampleKey)
    const requestExecutor = await createVelocityWorkerRequestExecutor({
        sourceId: `flow-velocity.${dataset.sourceHash}`,
        sampleKey: source.sampleKey,
        contentVersion: dataset.contentVersion,
        cachePolicy,
        workerSystem,
        workerModules,
        ...(workerCount === undefined ? {} : { workerCount }),
        ...(maxNetworkRequests === undefined ? {} : { maxNetworkRequests }),
        ...(maxDecodeTasks === undefined ? {} : { maxDecodeTasks }),
        maxRequests,
        resolvePage: source.resolvePage,
    })
    const virtualRaster = await createVirtualRasterRuntime({
        runtime,
        model: source.model,
        executor: {
            ownership: 'owned',
            executor: requestExecutor,
        },
        maxRequests,
        maxPhysicalPages,
        maxStagingBytes,
        maxHistory,
        viewDemandProducerId: `flow-velocity-view-demand.${source.model.id}`,
    })
    return Object.freeze({
        ...virtualRaster,
        source,
        workerFacts: requestExecutor.inspect,
    })
}
